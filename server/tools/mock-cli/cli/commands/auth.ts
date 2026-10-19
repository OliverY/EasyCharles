import { createInterface } from 'node:readline/promises'
import { flagBool, flagStr, parseArgs, readStdinText } from '../args.ts'
import type { FlagSpec, Parsed } from '../args.ts'
import { CliError, EXIT, authError, usageError, verifyError } from '../errors.ts'
import { sessionIdOrNull } from '../config.ts'
import type { ConfigStore, Project } from '../config.ts'
import { ManagementClient } from '../client.ts'
import { openInBrowser, startRelayWait } from '../browser-login.ts'
import { emit, info, modeOf, table, cell } from '../output.ts'
import type { Mode } from '../output.ts'

export interface Ctx {
  store: ConfigStore
  mode: Mode
  verbose: boolean
}

export const LOGIN_FLAGS: FlagSpec = {
  phone: 'string',
  password: 'string',
  'password-stdin': 'bool',
  browser: 'bool',
  'no-open': 'bool',
  'callback-port': 'string',
  timeout: 'string',
}

export const AUTH_FLAGS: FlagSpec = {}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question(question)).trim()
  } finally {
    rl.close()
  }
}

/** 口令来源优先级：--password > EC_MOCK_PASSWORD > --password-stdin > 交互提示 */
async function passwordFromFlags(p: Parsed): Promise<string | null> {
  const inline = flagStr(p, 'password')
  if (inline !== null) return inline
  const env = process.env.EC_MOCK_PASSWORD
  if (env) return env
  if (flagBool(p, 'password-stdin')) return readStdinText().replace(/\r?\n$/, '')
  return null
}

/** 交互式提示只在登录命令里用。口令**会回显**——不引第三方依赖做掩码输入，
 * 所以 help 里明确引导脚本改用 --password-stdin / EC_MOCK_PASSWORD，人也改用 --browser。 */
async function passwordForLogin(p: Parsed): Promise<string> {
  const got = await passwordFromFlags(p)
  if (got !== null) return got
  if (!process.stdin.isTTY) {
    throw usageError(
      '缺少登录口令',
      '脚本/agent：printf 口令 | mock login --password-stdin，或设 EC_MOCK_PASSWORD；' +
        '人在终端：mock login --browser（打开控制台登录，会话自己回到 CLI，CLI 不经手口令）',
    )
  }
  const answer = await prompt('登录口令: ')
  if (!answer) throw usageError('口令为空', '直接回车不算空口令，服务端要求非空手机号 + 匹配口令')
  return answer
}

async function phoneForLogin(p: Parsed, project: Project | null): Promise<string> {
  const flag = flagStr(p, 'phone')
  if (flag) return flag
  if (process.env.EC_MOCK_PHONE) return process.env.EC_MOCK_PHONE
  if (project?.phone) return project.phone
  if (!process.stdin.isTTY) {
    throw usageError('缺少手机号', '加 --phone <手机号>，或设置环境变量 EC_MOCK_PHONE')
  }
  const answer = await prompt('控制台手机号: ')
  if (!answer) throw usageError('手机号为空', '加 --phone <手机号>')
  return answer
}

export function projectOf(p: Parsed, store: ConfigStore): Project {
  return store.resolveProject({ baseUrl: flagStr(p, 'base-url'), projectId: flagStr(p, 'project-id') })
}

/**
 * 建管理面客户端，并把「401 自动重登」接上。
 *
 * 自动重登只认非交互来源（flag / 环境变量 / project 里已存的手机号），
 * 中途弹提示会让脚本卡住；拿不到就返回 null，由上层给出 `mock login` 提示。
 */
export async function clientFor(ctx: Ctx, p: Parsed, project: Project): Promise<ManagementClient> {
  const client = new ManagementClient({
    baseUrl: project.baseUrl,
    session: sessionIdOrNull(project),
    hooks: {
      log: (message) => {
        if (ctx.verbose) info(`[http] ${message}`)
      },
      onSession: (session) => {
        if (!project.phone) return
        project.session = session
        project.sessionAt = session ? Date.now() : null
        ctx.store.save()
      },
      relogin: async () => {
        const phone = flagStr(p, 'phone') ?? process.env.EC_MOCK_PHONE ?? project.phone
        if (!phone) return null
        const password = await passwordFromFlags(p)
        if (password === null) return null
        const anon = new ManagementClient({ baseUrl: project.baseUrl, session: null })
        try {
          const res = (await anon.call('POST', '/__ec/api/login', { body: { phone, password }, auth: false })) as {
            session?: unknown
          }
          return typeof res.session === 'string' ? res.session : null
        } catch (e) {
          if (ctx.verbose) info(`[http] 自动重登失败：${e instanceof Error ? e.message : String(e)}`)
          return null
        }
      },
    },
  })
  return client
}

/** 供 selftest 与命令层复用：解析参数 + 建 ctx + 建客户端 */
export async function withClient(
  store: ConfigStore,
  argv: string[],
  spec: FlagSpec,
): Promise<{ p: Parsed; ctx: Ctx; client: ManagementClient; project: Project }> {
  const p = parseArgs(argv, spec)
  const mode = modeOf(p)
  const ctx: Ctx = { store, mode, verbose: flagBool(p, 'verbose') }
  const project = projectOf(p, store)
  const client = await clientFor(ctx, p, project)
  return { p, ctx, client, project }
}

/** 浏览器接力的默认等待时长：够慢吞吞地登录完，又不至于让命令挂着不放 */
const DEFAULT_BROWSER_TIMEOUT_S = 180

function browserTimeoutMs(p: Parsed): number {
  const raw = flagStr(p, 'timeout')
  if (raw === null) return DEFAULT_BROWSER_TIMEOUT_S * 1000
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 5 || n > 900) {
    throw usageError(`--timeout 要的是 5~900 之间的整数秒：${raw}`, '如 mock login --browser --timeout 60')
  }
  return n * 1000
}

function callbackPortFlag(p: Parsed): number | null {
  const raw = flagStr(p, 'callback-port')
  if (raw === null) return null
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1024 || n > 65535) {
    throw usageError(`--callback-port 要的是 1024~65535 的整数：${raw}`, '一般不用给；让 CLI 自己挑临时端口')
  }
  return n
}

/**
 * `mock login --browser`：口令全程不经手 CLI。
 *
 * 顺序刻意是「打印地址 → 开浏览器 → 等回传 → **向服务端核实** → 才落盘」：
 * 页面送回来的 token 属于本机以外的输入（AGENTS.md §4），拿到就先认它等于把
 * 「浏览器里是谁的会话」当成事实。/me 通不过就报 EC_VERIFY_FAILED，配置里不留半个会话。
 */
async function loginViaBrowser(ctx: Ctx, p: Parsed, project: Project): Promise<number> {
  if (flagStr(p, 'password') !== null || flagBool(p, 'password-stdin') || process.env.EC_MOCK_PASSWORD) {
    throw usageError(
      '--browser 不接受任何口令来源（--password / --password-stdin / EC_MOCK_PASSWORD）',
      '二选一：浏览器接力只写 --browser；用口令登录就去掉 --browser',
    )
  }

  const waiter = await startRelayWait({
    baseUrl: project.baseUrl,
    timeoutMs: browserTimeoutMs(p),
    callbackPort: callbackPortFlag(p),
  })

  // 地址先打出来：开不了浏览器（无 GUI / SSH 会话 / --no-open）时这一行就是入口
  info(`请在浏览器里登录控制台，然后在页面里点「允许」：\n  ${waiter.url}`)
  if (flagBool(p, 'no-open')) info('（--no-open：没有自动打开浏览器，手动粘贴上面这个地址）')
  else {
    const opened = openInBrowser(waiter.url)
    if (!opened.ok) info(`自动打开浏览器失败（${opened.detail}），请手动粘贴上面的地址`)
  }

  const { session } = await waiter.result
  if (ctx.verbose) info('[http] 浏览器已回传会话（内容不打印）')

  const probe = new ManagementClient({
    baseUrl: project.baseUrl,
    session: session.session,
    hooks: { log: (m) => (ctx.verbose ? info(`[http] ${m}`) : null) },
  })
  let me: { user?: Record<string, unknown> | null }
  try {
    me = (await probe.call('GET', '/__ec/api/me')) as { user?: Record<string, unknown> | null }
  } catch (e) {
    if (e instanceof CliError && e.code === 'EC_UNAUTHORIZED') {
      throw verifyError(
        '浏览器回传的会话在服务端不被承认（可能刚被登出、服务端换过数据目录，或会话已过期）',
        '在页面里重新登录一次再点「允许」；或直接用口令：printf 口令 | mock login --password-stdin',
      )
    }
    throw e
  }
  const user = me.user ?? null
  const serverPhone = user && typeof user.phone === 'string' ? user.phone : null
  if (!serverPhone) {
    throw verifyError(
      '服务端 /me 没有回 user.phone，无法确定这个会话属于谁',
      '确认 baseUrl 指向的是 EasyCharles 服务端（而不是别的服务）；或改用 --password-stdin 登录',
    )
  }

  const requestedPhone = flagStr(p, 'phone') ?? process.env.EC_MOCK_PHONE ?? null
  const role = user && typeof user.role === 'string' ? user.role : 'user'
  ctx.store.setCredentials(project, serverPhone, session.session)
  ctx.store.markUsed(project)

  const payload = {
    ok: true,
    via: 'browser',
    project: { id: project.id, name: project.name, baseUrl: project.baseUrl },
    phone: serverPhone,
    role,
    sessionCached: true,
    callbackPort: waiter.port,
    loginUrl: waiter.url,
    phoneMismatch: requestedPhone !== null && requestedPhone !== serverPhone ? true : undefined,
  }
  emit(payload, ctx.mode, () => {
    info(`已登录 ${serverPhone}（角色 ${role}）→ ${project.baseUrl}`)
    info('  会话由控制台页面经本机回环交回，CLI 全程没有接触口令')
    if (payload.phoneMismatch) info(`提示：--phone 给的是 ${requestedPhone}，但那个会话属于 ${serverPhone}，已按会话实际归属记录`)
    if (role !== 'admin') info('提示：管理面 /__ec/api/admin/* 需要服务端 --admin 白名单里的手机号')
  })
  return EXIT.OK
}

export async function cmdLogin(store: ConfigStore, argv: string[]): Promise<number> {
  const p = parseArgs(argv, LOGIN_FLAGS)
  const mode = modeOf(p)
  const ctx: Ctx = { store, mode, verbose: flagBool(p, 'verbose') }
  const project = projectOf(p, store)

  // 只认显式的 --browser：绝不因为「没给口令」就自动去开浏览器——
  // AI agent / CI 里没有终端也没有 GUI，自动开浏览器等于让命令永远挂在那儿。
  if (flagBool(p, 'browser')) return loginViaBrowser(ctx, p, project)

  const phone = await phoneForLogin(p, project)
  const password = await passwordForLogin(p)

  const anon = new ManagementClient({
    baseUrl: project.baseUrl,
    session: null,
    hooks: { log: (m) => (ctx.verbose ? info(`[http] ${m}`) : null) },
  })

  let res: unknown
  try {
    res = await anon.call('POST', '/__ec/api/login', { body: { phone, password }, auth: false })
  } catch (e) {
    if (e instanceof CliError && e.code === 'EC_UNAUTHORIZED') {
      throw authError(`${e.message}`, '口令不匹配；服务未改口令时默认是 123456（服务端 --password 可改）')
    }
    throw e
  }

  const data = (res ?? {}) as { session?: unknown; user?: unknown }
  const session = typeof data.session === 'string' ? data.session : null
  if (!session) {
    throw new CliError('EC_BAD_RESPONSE', '登录响应里没有 session 字段', '确认 baseUrl 指向 EasyCharles 服务', EXIT.SERVER)
  }
  ctx.store.setCredentials(project, phone, session)
  ctx.store.markUsed(project)

  const user = data.user as Record<string, unknown> | null
  const role = user && typeof user.role === 'string' ? user.role : 'user'
  const payload = {
    ok: true,
    via: 'password',
    project: { id: project.id, name: project.name, baseUrl: project.baseUrl },
    phone,
    role,
    sessionCached: true,
  }
  emit(payload, mode, () => {
    info(`已登录 ${phone}（角色 ${role}）→ ${project.baseUrl}`)
    if (role !== 'admin') info('提示：管理面 /__ec/api/admin/* 需要服务端 --admin 白名单里的手机号')
  })
  return EXIT.OK
}

export async function cmdLogout(store: ConfigStore, argv: string[]): Promise<number> {
  const { ctx, client, project } = await withClient(store, argv, AUTH_FLAGS)
  let revoked = false
  if (client.session) {
    try {
      await client.call('POST', '/__ec/api/logout', { body: {} })
      revoked = true
    } finally {
      ctx.store.clearSession(project)
    }
  } else {
    ctx.store.clearSession(project)
  }
  const payload = { ok: true, project: { id: project.id, baseUrl: project.baseUrl }, revoked }
  emit(payload, ctx.mode, () => info(revoked ? '已登出，服务端会话已销毁' : '本地会话已清除（本来就没有会话）'))
  return EXIT.OK
}

export async function cmdWhoami(store: ConfigStore, argv: string[]): Promise<number> {
  const { ctx, client, project } = await withClient(store, argv, AUTH_FLAGS)
  const me = (await client.call('GET', '/__ec/api/me')) as { user?: Record<string, unknown> | null }
  const infoRes = (await client.call('GET', '/__ec/api/info')) as Record<string, unknown>
  const user = me.user ?? null
  const payload = {
    project: { id: project.id, name: project.name, baseUrl: project.baseUrl, lastUsedAt: project.lastUsedAt },
    phone: user && typeof user.phone === 'string' ? user.phone : project.phone,
    role: user && typeof user.role === 'string' ? user.role : 'unknown',
    user,
    server: infoRes,
  }
  ctx.store.markUsed(project)
  emit(payload, ctx.mode, () => {
    process.stdout.write(
      table(
        ['字段', '值'],
        [
          ['project', `${project.id} ${project.name}`],
          ['baseUrl', project.baseUrl],
          ['phone', cell(payload.phone)],
          ['role', cell(payload.role)],
          ['serverVersion', cell(infoRes.serverVersion)],
          ['protocol', cell(infoRes.protocol)],
          ['lanMode', cell(infoRes.lanMode)],
        ],
      ) + '\n',
    )
  })
  return EXIT.OK
}
