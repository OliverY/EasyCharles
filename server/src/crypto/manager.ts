/**
 * 插件管理器：把「磁盘上有什么」变成「现在能用什么」。
 *
 * 它是 `<dataDir>/plugins/` 与 `PluginRegistry` 之间**唯一**的桥：
 * 扫描结果 → 新注册表 → 整体替换。替换而不是就地增删，是为了让「重载」有一个明确的
 * 语义：重载之后跑的就是磁盘上的那份代码，没有「删掉的插件还留在内存里」的中间态。
 *
 * 与 store 的关系：`CryptoStore` 持有一个注册表引用，重载后必须调用
 * `store.setPlugins(manager.registry)` 再 `store.reload()`。少做后一半，内存里仍是
 * 旧插件解析出来的 profile（比如旧参数派生出来的 key），控制台却显示新表单。
 */

import { join } from 'node:path'
import type { CryptoPlugin, PluginConfigSchema, PluginOptions, PluginResult } from './plugin-types.ts'
import { SPI_VERSION } from './plugin-types.ts'
import { builtinPlugin, BUILTIN_PLUGIN } from './builtin.ts'
import { bad, type Fail, type Ok } from './errors.ts'
import { scanPlugins, type PluginEntry } from './loader.ts'
import { PluginRegistry } from './registry.ts'
import { normalizeOptions } from './schema.ts'
import { readScriptSource, scanScripts, type ScriptEntry } from './script.ts'

/** 控制台「插件」页要显示的形态。**不含 options 的值**：参数属于密钥档，不属于插件 */
export interface PluginView {
  name: string
  title: string
  version: string
  description?: string
  spiVersion: number
  isolation: 'in-process' | 'worker'
  timeoutMs: number
  capability: { decrypt: boolean; encrypt: boolean }
  /** 脚本插件没有它：参数是一份自由 JSON，页面退化成 JSON 文本域 */
  configSchema?: PluginConfigSchema
  /** `builtin` 是内核自带的，其余来自 `<dataDir>/plugins/` 或 `<dataDir>/crypto/scripts/` */
  builtin: boolean
  status: 'loaded' | 'error'
  error?: string
  kind: 'builtin' | 'dir' | 'file' | 'script'
  /** 脚本文件的绝对路径（只读展示用），其余来源为空 */
  file?: string
  /** 脚本声明的打码字段 */
  secrets?: string[]
  /** 有多少个密钥档在用它。删除/停用前的影响面 */
  usedBy: number
}

export interface PluginReloadResult {
  warnings: string[]
  plugins: PluginView[]
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function isPromise(v: unknown): v is Promise<unknown> {
  return !!v && typeof (v as Promise<unknown>).then === 'function'
}

/** 缺省隔离级别：内置走进程内，第三方默认也进程内（worker 是 P2），控制台会标注「无隔离」 */
function isolationOf(p: { isolation?: 'in-process' | 'worker' }, builtin: boolean): 'in-process' | 'worker' {
  return builtin ? 'in-process' : (p.isolation ?? 'in-process')
}

export class PluginManager {
  private root: string
  /** 单文件脚本目录：`<dataDir>/crypto/scripts/`（与 plugins/ 分开，两种形态不混） */
  private scriptRoot: string
  private entries: PluginEntry[] = []
  private scripts: ScriptEntry[] = []
  private warnings: string[] = []
  private registry = new PluginRegistry()
  private exists = false
  private scriptExists = false
  /** 串行化重载：两次「重新扫描」并发执行时，后一次不能读到前一次的半成品 */
  private queue: Promise<void> = Promise.resolve()

  constructor(dataDir: string) {
    const base = typeof dataDir === 'string' ? dataDir : ''
    this.root = join(base, 'plugins')
    this.scriptRoot = join(base, 'crypto', 'scripts')
    this.registry.register(builtinPlugin, 'builtin')
  }

  /** 插件根目录（控制台要显示它，装插件就是往这里拷） */
  rootDir(): string {
    return this.root
  }

  /** 脚本目录（控制台显示「代码放在哪」，也是只读展示的来源） */
  scriptDir(): string {
    return this.scriptRoot
  }

  dirExists(): boolean {
    return this.exists
  }

  scriptDirExists(): boolean {
    return this.scriptExists
  }

  /** 读一个脚本的源码给控制台看。**没有写入口**：改代码只能在本机编辑文件 */
  scriptSource(name: string): { ok: true; source: string } | { ok: false; error: string } {
    return readScriptSource(this.scriptRoot, name)
  }

  get plugins(): PluginRegistry {
    return this.registry
  }

  /** 重扫目录并整体替换注册表。失败不抛：一个坏插件不能拦住服务启动 */
  reload(): Promise<void> {
    // 前一次失败也要能继续排队（否则一次异常会让后续所有重载静默不执行）
    this.queue = this.queue.then(
      () => this.doReload(),
      () => this.doReload(),
    )
    return this.queue
  }

  private async doReload(): Promise<void> {
    const r = await scanPlugins(this.root)
    const s = await scanScripts(this.scriptRoot)
    const reg = new PluginRegistry()
    reg.register(builtinPlugin, 'builtin')
    for (const e of r.entries) {
      if (e.status !== 'loaded' || !e.plugin) continue
      try {
        reg.register(e.plugin, 'plugin')
      } catch (err) {
        // 注册阶段才暴露的问题（重名、能力缺失）也要落到条目上，而不是只打一行日志
        e.status = 'error'
        e.error = errMsg(err)
      }
    }
    for (const e of s.entries) {
      if (e.status !== 'loaded' || !e.plugin) continue
      try {
        reg.register(e.plugin, 'script')
      } catch (err) {
        e.status = 'error'
        e.error = errMsg(err)
      }
    }
    this.entries = r.entries
    this.scripts = s.entries
    this.warnings = [...r.warnings, ...s.warnings]
    this.exists = r.exists
    this.scriptExists = s.exists
    this.registry = reg
  }

  warningsList(): string[] {
    return [...this.warnings]
  }

  /** `usage` = profile 名→该插件被引用的次数，由调用方（store 视图）统计 */
  list(usage?: Map<string, number>): PluginView[] {
    const out: PluginView[] = [
      {
        name: BUILTIN_PLUGIN,
        title: builtinPlugin.title,
        version: builtinPlugin.version,
        description: builtinPlugin.description,
        spiVersion: builtinPlugin.spiVersion,
        isolation: 'in-process',
        timeoutMs: builtinPlugin.timeoutMs ?? 500,
        capability: builtinPlugin.capability,
        configSchema: builtinPlugin.configSchema,
        builtin: true,
        status: 'loaded',
        kind: 'builtin',
        usedBy: usage?.get(BUILTIN_PLUGIN) ?? 0,
      },
    ]
    for (const e of this.entries) {
      const p = e.plugin
      if (!p) {
        // 加载失败：连名字都可能不可信（可能在 import 阶段就炸了），用目录名兜底
        out.push({
          name: e.dirName,
          title: e.dirName,
          version: e.manifest?.version ?? '—',
          spiVersion: e.manifest?.spiVersion ?? 0,
          isolation: 'in-process',
          timeoutMs: 500,
          capability: { decrypt: true, encrypt: false },
          configSchema: { type: 'object', properties: {} },
          builtin: false,
          status: 'error',
          error: e.error ?? '加载失败',
          kind: e.kind,
          usedBy: usage?.get(e.dirName) ?? 0,
        })
        continue
      }
      out.push({
        name: p.name,
        title: p.title,
        version: p.version,
        description: p.description,
        spiVersion: p.spiVersion,
        isolation: isolationOf(p, false),
        timeoutMs: p.timeoutMs ?? 500,
        capability: p.capability,
        configSchema: p.configSchema,
        builtin: false,
        status: e.status,
        ...(e.error ? { error: e.error } : {}),
        kind: e.kind,
        usedBy: usage?.get(p.name) ?? 0,
      })
    }
    // 脚本插件单列：它们没有 configSchema，控制台按「代码 + JSON 参数」渲染而不是表单
    for (const e of this.scripts) {
      const p = e.plugin
      out.push({
        name: e.pluginName,
        title: p?.title ?? `脚本 ${e.name}`,
        version: p?.version ?? '—',
        ...(p?.description ? { description: p.description } : {}),
        spiVersion: p?.spiVersion ?? SPI_VERSION,
        isolation: 'in-process',
        timeoutMs: 500,
        capability: p?.capability ?? { decrypt: true, encrypt: false },
        builtin: false,
        status: e.status,
        ...(e.error ? { error: e.error } : {}),
        kind: 'script',
        file: e.file,
        secrets: e.secrets,
        usedBy: usage?.get(e.pluginName) ?? 0,
      })
    }
    return out
  }

  /**
   * 试跑一段文本（`POST /crypto/plugins/test`）。
   *
   * 与数据面解密的差别只有一处：**不碰 wrap**。这里 `text` 就是密文串本身，
   * 免得「想验证一下 key 对不对」还得先构造一个看起来像接口的 body。
   */
  async test(
    name: string,
    rawOptions: unknown,
    text: string,
    mode: 'decrypt' | 'encrypt',
  ): Promise<Ok<{ output: string }> | Fail> {
    const p = this.registry.get(name)
    if (!p) return bad(`插件未加载：${name}（已加载：${this.registry.names().join(', ') || '无'}）`)
    if (mode === 'encrypt' && (!p.capability.encrypt || !p.encrypt)) {
      return bad(`插件 ${name} 没有声明 encrypt 能力`)
    }

    let options: PluginOptions
    try {
      // 表单没填的字段先补 schema 默认值，再走严格校验：试跑不该因为「没选编码」而报错。
      // 脚本插件没有 schema，`properties` 为空，等价于「原样使用这份 JSON」。
      const props = p.configSchema?.properties ?? {}
      const defaults: Record<string, unknown> = {}
      for (const [k, spec] of Object.entries(props)) {
        if (spec.default !== undefined) defaults[k] = spec.default
      }
      const raw = rawOptions && typeof rawOptions === 'object' && !Array.isArray(rawOptions) ? rawOptions : {}
      options = normalizeOptions(p.configSchema, { ...defaults, ...(raw as Record<string, unknown>) }, undefined, true, `插件 ${name} 参数`)
    } catch (e) {
      return bad(errMsg(e))
    }

    try {
      p.setup?.(options, { profileId: '__test__' })
    } catch (e) {
      return bad(`参数不合法：${errMsg(e)}`)
    }

    const call = { text, options, ctx: { profileId: '__test__', headers: {} } }
    let r: PluginResult<string> | Promise<PluginResult<string>>
    try {
      r = mode === 'encrypt' ? p.encrypt!(call) : p.decrypt(call)
    } catch (e) {
      return bad(`插件 ${name} 抛出异常：${errMsg(e)}`)
    }
    if (isPromise(r)) {
      void r.catch(() => {})
      return bad('插件返回了 Promise：异步插件需要 worker 宿主（P2），当前版本只支持同步插件')
    }
    return r.ok ? { ok: true, output: r.value } : bad(r.error)
  }
}

export type { CryptoPlugin }
