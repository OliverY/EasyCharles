/**
 * 密钥档与路由的唯一真值来源（ADR-039 / ADR-040）。
 *
 * 落盘位置：`<dataDir>/crypto/settings.json`。**整个目录在 `.gitignore` 的
 * `server/.data/` 之下**，发布包也按白名单收集、不含 `.data/`（见 build-server-bundle.sh）。
 * 换句话说：只要按默认路径用，密钥没有进入仓库或发布包的途径。
 *
 * 与插件的关系：store 持有注册表，`test()` 与 `match()` 都把**同一个注册表**交出去，
 * 保证「能匹配上」和「能解开」用的是同一套插件实现。
 */

import { existsSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CryptoProfile, CryptoProfileView, CryptoRoute, CryptoView, CryptoWrap } from '../types.ts'
import { writeJsonAtomic } from '../json-file.ts'
import { bad, invalid, type Fail, type Ok } from './errors.ts'
import { BUILTIN_PLUGIN } from './builtin.ts'
import {
  MAX_PROFILES,
  MAX_ROUTES,
  matchOne,
  normalizeProfile,
  normalizeRoute,
} from './profile.ts'
import { defaultRegistry, type PluginRegistry } from './registry.ts'
import { maskOptions } from './schema.ts'
import { decryptWith, encryptWith } from './transform.ts'

/** 打码占位符。提交回写时 `key` 里含它即表示「沿用旧值」，不是要把这段字符存成密钥 */
export const CRYPTO_MASK = '••••'
/** 单个 settings.json 的体量上限：读入口也要防「有人塞了个 2GB 的 json」 */
const SETTINGS_MAX_BYTES = 1024 * 1024

/**
 * 磁盘上的 profile 形态。
 *
 * 与 `CryptoProfile` 的唯一差别是 `plugin` 可省略：内置引擎的 profile **不写这个字段**，
 * 于是 settings.json 与 ADR-039 时期的文件逐字节一致（零迁移），
 * 回滚到旧版本时旧代码也读得懂。
 */
interface PersistedProfile extends Omit<CryptoProfile, 'plugin'> {
  plugin?: string
}

interface PersistedCrypto {
  profiles: PersistedProfile[]
  routes: CryptoRoute[]
}

function toPersisted(p: CryptoProfile): PersistedProfile {
  const out: PersistedProfile = { ...p }
  if (p.plugin === BUILTIN_PLUGIN) {
    // 内置档：不写 plugin / options / pluginContext，settings.json 因此与 ADR-039 时期
    // 逐字节一致（旧版本读得懂、可回滚）
    delete out.plugin
    delete out.options
    delete out.pluginContext
  } else {
    // 私有插件的档：不把内置引擎的空字段留在磁盘上，否则「这档到底用哪套参数」
    // 下次读盘时又要靠一遍推断
    delete out.alg
    delete out.key
    delete out.keyEncoding
    delete out.iv
    delete out.ivEncoding
    delete out.aead
    delete out.cipherEncoding
    delete out.autoPadding
  }
  return out
}

/** `match()` 的返回：profile + 命中的路由 + 该用哪个注册表解密 */
export interface CryptoMatch {
  profile: CryptoProfile
  route: CryptoRoute
  /**
   * 解密时**必须**把这个注册表传给 `decryptForRecord` 等函数。
   * 少传就会退回全局缺省注册表——P1 加载私有插件后，那等于「匹配用的是 A、解密用的是 B」。
   */
  plugins: PluginRegistry
}

export class CryptoStore {
  private dataDir: string
  private enabled: boolean
  private profiles = new Map<string, CryptoProfile>()
  private routes: CryptoRoute[] = []
  /** 读盘时的告警（坏条目 / 悬空引用），启动时打一次，供「规则明明配了却不生效」自查 */
  private warnings: string[] = []
  private registry: PluginRegistry

  constructor(dataDir: string, enabled = true, plugins: PluginRegistry = defaultRegistry) {
    this.dataDir = typeof dataDir === 'string' ? dataDir : ''
    this.enabled = enabled !== false
    this.registry = plugins
    this.load()
  }

  file(): string {
    return join(this.dataDir, 'crypto', 'settings.json')
  }

  isEnabled(): boolean {
    return this.enabled
  }

  /** 关开关后一律不命中：排查「记录是不是被解密改坏的」时用 */
  setEnabled(v: boolean): void {
    this.enabled = v !== false
  }

  /** 本 store 使用的插件注册表（数据面解密时要用同一个） */
  get plugins(): PluginRegistry {
    return this.registry
  }

  /**
   * 换一套注册表（插件重载后调用）。
   *
   * 调用方**必须**紧接着 `reload()`：profile 的 `options` 归一化依赖对应插件的 schema，
   * 只换注册表不重读，内存里留着的仍是旧插件解析出来的参数。
   */
  setPlugins(plugins: PluginRegistry): void {
    this.registry = plugins
  }

  warningsList(): string[] {
    return [...this.warnings]
  }

  /**
   * 重新读盘（手改了 `settings.json` 后不用重启服务）。
   *
   * 与 `load()` 的区别：先清空内存再读。清空是必须的——否则「文件里删掉的 profile」
   * 会继续留在内存里生效，而用户在磁盘上看到的和实际跑的是两套东西。
   */
  reload(): void {
    this.profiles.clear()
    this.routes = []
    this.warnings = []
    this.load()
  }

  listProfiles(): CryptoProfile[] {
    return [...this.profiles.values()]
  }

  listRoutes(): CryptoRoute[] {
    return [...this.routes]
  }

  profileById(id: string): CryptoProfile | undefined {
    return this.profiles.get(id)
  }

  /** 每个插件被多少个 profile 引用。控制台的插件页据此提示「停用前先改档」 */
  pluginUsage(): Map<string, number> {
    const m = new Map<string, number>()
    for (const p of this.profiles.values()) m.set(p.plugin, (m.get(p.plugin) ?? 0) + 1)
    return m
  }

  private load(): void {
    if (!this.enabled || this.dataDir === '') return
    const file = this.file()
    if (!existsSync(file)) return
    let parsed: unknown
    try {
      const raw = readFileSync(file, 'utf8')
      if (raw.length > SETTINGS_MAX_BYTES) {
        this.warnings.push(`crypto/settings.json 超过 ${SETTINGS_MAX_BYTES} 字节，已忽略`)
        return
      }
      parsed = JSON.parse(raw)
    } catch (e) {
      this.warnings.push(`crypto/settings.json 不是合法 JSON，已忽略：${e instanceof Error ? e.message : String(e)}`)
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.warnings.push('crypto/settings.json 顶层不是对象，已忽略')
      return
    }
    const o = parsed as Record<string, unknown>
    // 逐条独立：坏的那条只丢它自己，不能让整份配置失效（否则一个手滑的逗号就让全部解密停摆）
    for (const item of Array.isArray(o.profiles) ? o.profiles.slice(0, MAX_PROFILES) : []) {
      try {
        const p = normalizeProfile(item, this.profiles, false, this.registry)
        this.profiles.set(p.id, p)
      } catch (e) {
        this.warnings.push(`忽略非法 profile：${e instanceof Error ? e.message : String(e)}`)
      }
    }
    const ids = new Set(this.profiles.keys())
    for (const item of Array.isArray(o.routes) ? o.routes.slice(0, MAX_ROUTES) : []) {
      try {
        const r = normalizeRoute(item, ids, false)
        if (!ids.has(r.profileId)) this.warnings.push(`route(${r.id}) 引用了不存在的 profile ${r.profileId}，不会生效`)
        this.routes.push(r)
      } catch (e) {
        this.warnings.push(`忽略非法 route：${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  /** 打码视图：key / iv / secret 类插件参数永远不下发。`routeCount` 供控制台在删除前提示影响面 */
  view(): CryptoView {
    const count = new Map<string, number>()
    for (const r of this.routes) count.set(r.profileId, (count.get(r.profileId) ?? 0) + 1)
    const mask = (v: string | undefined): string | undefined =>
      // 只露出首尾各 2 个字符：足够确认「是不是这一把」，又不足以还原任何一段有用信息
      v === undefined || v === '' ? undefined : v.length <= 4 ? CRYPTO_MASK : `${v.slice(0, 2)}${CRYPTO_MASK}${v.slice(-2)}`
    const profiles: CryptoProfileView[] = this.listProfiles().map((p) => {
      const plugin = this.registry.get(p.plugin)
      const options = maskOptions(plugin?.configSchema, p.options, plugin?.secretFields)
      return {
        ...p,
        key: mask(p.key) ?? '',
        iv: mask(p.iv),
        ...(options ? { options } : {}),
        routeCount: count.get(p.id) ?? 0,
      }
    })
    return { enabled: this.enabled, profiles, routes: this.listRoutes() }
  }

  /**
   * 整体替换（管理面 `PUT /__ec/api/crypto` 的唯一写入口）。
   *
   * **先全量校验，再落盘**：一条不合法就整体 400，内存与磁盘都不动。
   * 部分接受会造成「控制台以为保存成功、实际只生效了一半」，比直接报错难查得多。
   */
  replaceAll(raw: unknown): CryptoView {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw invalid('body must be an object')
    }
    const o = raw as Record<string, unknown>
    const pRaw = o.profiles === undefined ? [] : o.profiles
    const rRaw = o.routes === undefined ? [] : o.routes
    if (!Array.isArray(pRaw)) throw invalid('profiles must be an array')
    if (!Array.isArray(rRaw)) throw invalid('routes must be an array')
    if (pRaw.length > MAX_PROFILES) throw invalid(`profiles 最多 ${MAX_PROFILES} 条`)
    if (rRaw.length > MAX_ROUTES) throw invalid(`routes 最多 ${MAX_ROUTES} 条`)

    // 用旧表兜「打码值回写」：id 相同且 key 是打码串时沿用旧 key
    const nextProfiles = new Map<string, CryptoProfile>()
    for (const item of pRaw) {
      const p = normalizeProfile(item, this.profiles, true, this.registry)
      if (nextProfiles.has(p.id)) {
        throw invalid(`profile.id 重复：${p.id}`)
      }
      nextProfiles.set(p.id, p)
    }
    const ids = new Set(nextProfiles.keys())
    const nextRoutes: CryptoRoute[] = []
    const seen = new Set<string>()
    for (const item of rRaw) {
      const r = normalizeRoute(item, ids, true)
      if (seen.has(r.id)) throw invalid(`route.id 重复：${r.id}`)
      seen.add(r.id)
      nextRoutes.push(r)
    }

    this.profiles = nextProfiles
    this.routes = nextRoutes
    this.warnings = []
    if (this.dataDir !== '') {
      const file = this.file()
      mkdirSync(dirname(file), { recursive: true })
      // 整体覆盖前留一份上一版：`PUT` 是「全量替换」，而插件没加载时对应 profile
      // 会从内存里消失——此时控制台拿着不完整的视图保存，等于把密钥抹掉。
      // 一份 .bak 就把「不可逆」变成「可恢复」，代价是几十 KB。
      if (existsSync(file)) {
        try {
          copyFileSync(file, `${file}.bak`)
        } catch {
          // 备份失败不该拦住保存本身（只读目录之类），最坏情况与旧行为一致
        }
      }
      const data: PersistedCrypto = { profiles: [...nextProfiles.values()].map(toPersisted), routes: nextRoutes }
      writeJsonAtomic(file, data)
    }
    return this.view()
  }

  /** 单条试加/试解，供「这把 key 到底对不对」的自检用；不落盘、不改内存 */
  test(profileId: string, text: string, mode: 'decrypt' | 'encrypt'): Ok<{ output: string }> | Fail {
    const p = this.profiles.get(profileId)
    if (!p) return bad(`没有这个 profile：${profileId}`)
    if (mode === 'encrypt') {
      const r = encryptWith(p, text, p.encrypt, this.registry)
      return r.ok ? { ok: true, output: r.body } : r
    }
    // 解密测试不预设方向：先按 response 的壳试，不中再按 request / query / raw 试——
    // 用户手里那段密文可能来自 body 也可能来自 URL，让他还要选「哪一侧」纯属添堵。
    const tries: CryptoWrap[] = [p.response, p.request, { type: 'raw' }]
    if (p.query) tries.push({ type: 'raw', prefix: p.query.prefix })
    let last: Fail = bad('解密失败')
    // 「找到了密文但解不开」比「这段文本里根本没有密文字段」更值得回报：
    // 前者说明配置的 key / 布局和密文不匹配（用户要修的正是这个），
    // 后者只是「这一侧没有密文」。全部试完仍失败时优先给前者。
    let cryptoErr: Fail | null = null
    for (const w of tries) {
      const r = decryptWith(p, text, w, this.registry)
      if (r.ok) return { ok: true, output: r.plain }
      if (!cryptoErr && r.error.startsWith('解密失败')) cryptoErr = r
      last = r
    }
    return cryptoErr ?? last
  }

  /**
   * 命中哪条路由。数组顺序即优先级（先配先赢），与 mock 规则的 priority 不同：
   * 一个接口不该同时套两套密钥，所以这里不需要谁压谁，只需要一条确定的规则。
   */
  match(input: { method: string; host: string; path: string }): CryptoMatch | null {
    if (!this.enabled) return null
    const method = String(input.method ?? '').toUpperCase()
    const host = String(input.host ?? '')
    const bareHost = host.replace(/:\d+$/, '')
    const path = String(input.path ?? '')
    for (const r of this.routes) {
      if (!r.enabled) continue
      if (r.match.method && r.match.method.toUpperCase() !== method) continue
      // host 两次都试：规则里写 `example.com` 不该因为请求 host 带端口就匹配不上
      if (r.match.host && !matchOne(r.match.host, host) && !matchOne(r.match.host, bareHost)) continue
      if (r.match.path && !matchOne(r.match.path, path)) continue
      const profile = this.profiles.get(r.profileId)
      if (!profile) continue
      return { profile, route: r, plugins: this.registry }
    }
    return null
  }
}
