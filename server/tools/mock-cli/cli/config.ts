import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { usageError } from './errors.ts'

export const CONFIG_VERSION = 1
/**
 * 会话缓存有效期。服务端会话现在会落盘（ADR-031，默认 30 天），**重启不再是它的失效来源**，
 * 所以这道 TTL 是 CLI 侧唯一的主动过期；「401 → 自动重登」继续覆盖口令轮换、
 * 服务端清过盘 / 换了 dataDir、以及服务端侧那条会话已过期或被 logout。
 */
export const SESSION_TTL_MS = 8 * 3600_000

export interface Project {
  id: string
  name: string
  baseUrl: string
  phone: string | null
  session: string | null
  sessionAt: number | null
  lastUsedAt: number | null
}

export interface MockConfig {
  version: number
  defaults: { project: string | null; group: string | null }
  projects: Project[]
}

function emptyConfig(): MockConfig {
  return { version: CONFIG_VERSION, defaults: { project: null, group: null }, projects: [] }
}

export function defaultConfigPath(): string {
  const home = process.env.EC_MOCK_HOME || join(homedir(), '.mock-cli')
  return join(home, 'config.json')
}

/** 与 server/src/config.ts 同源：端口可用 --/EC_PORT 改，默认 8899 */
export function localBaseUrl(): string {
  const raw = process.env.EC_PORT
  const port = raw !== undefined && /^\d+$/.test(raw) ? raw : '8899'
  return `http://127.0.0.1:${port}`
}

/**
 * 校验并归一 baseUrl。只接受 http/https 且不带 path 之外的东西。
 * 尾部斜杠统一去掉，避免 `http://a:8899/` 与 `http://a:8899` 变成两个 project。
 */
export function normalizeBaseUrl(input: string): string {
  const raw = (input ?? '').trim()
  if (!raw) throw usageError('baseUrl 为空', '如 --base-url http://127.0.0.1:8899')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw usageError(`baseUrl 不是合法 URL：${raw}`, '如 --base-url http://10.0.0.1:8899（服务器地址）或 http://127.0.0.1:8899')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw usageError(`baseUrl 协议必须是 http/https：${raw}`, '如 --base-url http://127.0.0.1:8899')
  }
  if (!url.hostname) throw usageError(`baseUrl 缺少主机名：${raw}`, '如 --base-url http://127.0.0.1:8899')
  url.hash = ''
  url.search = ''
  let out = url.toString()
  while (out.endsWith('/')) out = out.slice(0, -1)
  return out
}

function hostLabel(baseUrl: string): string {
  try {
    const u = new URL(baseUrl)
    return u.port ? `${u.hostname}:${u.port}` : u.hostname
  } catch {
    return baseUrl
  }
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

/**
 * 宽松读取磁盘上的单个 project 条目：**坏条目直接丢弃**，不让整份配置失效。
 *
 * 配置文件是用户可手改的外部输入（AGENTS.md §4 的口径同样适用于 CLI 自己的落盘文件）：
 * 一个手打错的 project 条目不该让 `mock` 全部命令崩掉。
 */
function coerceProject(raw: unknown): Project | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const id = asString(r.id)
  const baseUrl = asString(r.baseUrl)
  if (!id || !baseUrl) return null
  let normalized: string
  try {
    normalized = normalizeBaseUrl(baseUrl)
  } catch {
    return null
  }
  const sessionAt = typeof r.sessionAt === 'number' && Number.isFinite(r.sessionAt) ? r.sessionAt : null
  const session = asString(r.session)
  return {
    id,
    name: asString(r.name) ?? hostLabel(normalized),
    baseUrl: normalized,
    phone: asString(r.phone),
    // sessionAt 缺失或超过 TTL 视为无会话，避免拿旧 token 反复撞 401
    session: session && (sessionAt === null || Date.now() - sessionAt < SESSION_TTL_MS) ? session : null,
    sessionAt,
    lastUsedAt: typeof r.lastUsedAt === 'number' && Number.isFinite(r.lastUsedAt) ? r.lastUsedAt : null,
  }
}

function coerceConfig(raw: unknown): MockConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyConfig()
  const r = raw as Record<string, unknown>
  const rawProjects = Array.isArray(r.projects) ? r.projects : []
  const projects: Project[] = []
  const seen = new Set<string>()
  for (const item of rawProjects) {
    const p = coerceProject(item)
    if (!p || seen.has(p.id)) continue
    seen.add(p.id)
    projects.push(p)
  }
  const defaults = (r.defaults && typeof r.defaults === 'object' && !Array.isArray(r.defaults) ? r.defaults : {}) as Record<string, unknown>
  const pick = (v: unknown): string | null => {
    const s = asString(v)
    return s && seen.has(s) ? s : null
  }
  return {
    version: CONFIG_VERSION,
    defaults: { project: pick(defaults.project), group: asString(defaults.group) },
    projects,
  }
}

export class ConfigStore {
  path: string
  data: MockConfig
  /** 加载时遇到的问题（坏 JSON / 坏条目），只在人类模式提示，不影响命令执行 */
  warnings: string[]

  private constructor(path: string, data: MockConfig, warnings: string[]) {
    this.path = path
    this.data = data
    this.warnings = warnings
  }

  static load(path: string | null): ConfigStore {
    const target = path ?? defaultConfigPath()
    const warnings: string[] = []
    if (!existsSync(target)) return new ConfigStore(target, emptyConfig(), warnings)

    let parsed: unknown = null
    try {
      parsed = JSON.parse(readFileSync(target, 'utf8'))
    } catch (e) {
      // 坏文件改名保留证据，然后用空配置继续——落盘损坏不该让 CLI 变成砖
      const backup = `${target}.broken-${Date.now()}`
      try {
        renameSync(target, backup)
        warnings.push(`配置文件无法解析，已备份到 ${backup} 并重建（原因：${String(e)}）`)
      } catch {
        warnings.push(`配置文件无法解析且备份失败，本次使用空配置（原因：${String(e)}）`)
      }
      return new ConfigStore(target, emptyConfig(), warnings)
    }

    const data = coerceConfig(parsed)
    if (Array.isArray((parsed as Record<string, unknown>)?.projects) && (parsed as { projects: unknown[] }).projects.length > data.projects.length) {
      warnings.push('部分 project 条目格式不合法，本次已忽略')
    }
    return new ConfigStore(target, data, warnings)
  }

  save(): void {
    const dir = dirname(this.path)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = `${this.path}.${process.pid}.tmp`
    // 0600：文件里含管理面会话 token（等价于控制台登录态），不给其他用户读
    writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.path)
  }

  projectById(id: string | null): Project | null {
    if (!id) return null
    return this.data.projects.find((p) => p.id === id) ?? null
  }

  projectByUrl(baseUrl: string): Project | null {
    return this.data.projects.find((p) => p.baseUrl === baseUrl) ?? null
  }

  findProject(idOrName: string): Project | null {
    return (
      this.data.projects.find((p) => p.id === idOrName) ??
      this.data.projects.find((p) => p.name === idOrName) ??
      null
    )
  }

  addProject(name: string, baseUrl: string, id?: string): Project {
    const url = normalizeBaseUrl(baseUrl)
    const existing = this.projectByUrl(url)
    if (existing) {
      if (name) existing.name = name
      this.save()
      return existing
    }
    const project: Project = {
      id: id ?? `p_${randomUUID().replace(/-/g, '').slice(0, 8)}`,
      name: name || hostLabel(url),
      baseUrl: url,
      phone: null,
      session: null,
      sessionAt: null,
      lastUsedAt: null,
    }
    this.data.projects.push(project)
    if (!this.data.defaults.project) this.data.defaults.project = project.id
    this.save()
    return project
  }

  ensureLocalProject(): Project {
    const existing = this.findProject('local') ?? this.projectByUrl(localBaseUrl())
    if (existing) return existing
    return this.addProject('本机', localBaseUrl(), 'local')
  }

  removeProject(id: string): boolean {
    const i = this.data.projects.findIndex((p) => p.id === id)
    if (i < 0) return false
    this.data.projects.splice(i, 1)
    if (this.data.defaults.project === id) {
      this.data.defaults.project = this.data.projects[0]?.id ?? null
    }
    this.save()
    return true
  }

  setDefaultProject(id: string | null): void {
    if (id !== null && !this.projectById(id)) {
      throw usageError(`project 不存在：${id}`, '先用 mock project 查看可用项目，或 mock project add')
    }
    this.data.defaults.project = id
    this.save()
  }

  setDefaultGroup(id: string | null): void {
    this.data.defaults.group = id
    this.save()
  }

  setCredentials(project: Project, phone: string, session: string | null): void {
    project.phone = phone
    project.session = session
    project.sessionAt = session ? Date.now() : null
    this.save()
  }

  clearSession(project: Project): void {
    project.session = null
    project.sessionAt = null
    this.save()
  }

  markUsed(project: Project): void {
    project.lastUsedAt = Date.now()
    this.save()
  }

  /**
   * 解析本次命令要用的 project，优先级与 skill 一致：
   * 显式 `--base-url` > 显式 `--project-id` > 默认 project > 唯一 project > 本机种子。
   * 多个 project 且没默认值时报错并提示 `mock set project`（skill §1 的规则）。
   */
  resolveProject(opts: { baseUrl: string | null; projectId: string | null }): Project {
    if (opts.baseUrl) {
      const url = normalizeBaseUrl(opts.baseUrl)
      const found = this.projectByUrl(url)
      if (found) return found
      // 未登记的 baseUrl：自动登记一条，名字取 host，便于下次 --project-id 引用
      return this.addProject(hostLabel(url), url)
    }
    if (opts.projectId) {
      const byId = this.findProject(opts.projectId)
      if (!byId) {
        throw usageError(
          `project 不存在：${opts.projectId}`,
          this.data.projects.length
            ? `可用：${this.data.projects.map((p) => `${p.id}(${p.name})`).join(', ')}`
            : '当前没有任何 project，先 mock project add --base-url <url> 或 mock login --base-url <url>',
        )
      }
      return byId
    }
    if (this.data.defaults.project) {
      const def = this.projectById(this.data.defaults.project)
      if (def) return def
      this.data.defaults.project = null
    }
    if (this.data.projects.length === 1) return this.data.projects[0]
    if (this.data.projects.length === 0) return this.ensureLocalProject()
    throw usageError(
      '缺少默认 project',
      `先执行 mock set project <project_id>；可选：${this.data.projects.map((p) => `${p.id}(${p.name})`).join(', ')}`,
    )
  }
}

export function sessionIdOrNull(project: Project | null): string | null {
  if (!project?.session) return null
  if (project.sessionAt !== null && Date.now() - project.sessionAt >= SESSION_TTL_MS) return null
  return project.session
}
