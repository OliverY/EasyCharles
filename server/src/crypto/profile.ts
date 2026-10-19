/**
 * 密钥档 / 路由的归一化与匹配（Core 职责）。
 *
 * 这一层不碰任何加密算法：它只决定「这条配置合法吗」「哪个 profile 管哪个接口」。
 * 算法参数怎么解释，取决于 profile 上声明的 `plugin`——`normalizeProfile` 只负责
 * 把配置交给对应插件做校验（P0 只有 builtin 一种形状）。
 */

import { randomUUID } from 'node:crypto'
import type { CryptoPluginContext, CryptoProfile, CryptoRoute } from '../types.ts'
import { rawObject, bool, str } from './coerce.ts'
import { invalid } from './errors.ts'
import { BUILTIN_PLUGIN, builtinFields, normalizeBuiltin } from './builtin.ts'
import type { PluginOptions } from './plugin-types.ts'
import type { PluginRegistry } from './registry.ts'
import { flatFieldsPresent, normalizeOptions } from './schema.ts'
import { parseQueryWrap, parseWrap } from './wrap.ts'

export const MAX_PROFILES = 200
export const MAX_ROUTES = 500
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/

function newProfileId(): string {
  return `p_${Date.now().toString(36)}${randomUUID().replace(/-/g, '').slice(0, 4)}`
}

function newRouteId(): string {
  return `c_${Date.now().toString(36)}${randomUUID().replace(/-/g, '').slice(0, 4)}`
}

/**
 * 一个 profile 该喂给插件什么参数。
 *
 * 内置引擎由扁平字段**现算**（磁盘格式因此保持原样）；私有插件用它自己的 `options`。
 * 这里不合并两者：合并等于允许「两套配置并存」，出问题时无从判断哪套生效。
 */
export function profileOptions(p: CryptoProfile): PluginOptions {
  return p.plugin === BUILTIN_PLUGIN ? builtinFields(p) : (p.options ?? {})
}

/** header 白名单上限（ADR-040 §6.3）：多到需要 9 个头，说明这个插件该自己拿数据了 */
const MAX_CTX_HEADERS = 8
const MAX_HEADER_NAME = 64

/**
 * 解析 `pluginContext`。
 *
 * 为什么要有白名单这一步：插件默认**拿不到任何 header**。确实有业务把 nonce 放在
 * header 里，那就显式写出来——看得见的一两个头，比「插件能读全部流量」好审查得多。
 */
function parsePluginContext(
  raw: unknown,
  prev: CryptoPluginContext | undefined,
  strict: boolean,
  id: string,
): CryptoPluginContext | undefined {
  if (raw === undefined || raw === null) return prev
  const o = rawObject(raw)
  if (!o) {
    if (strict) throw invalid(`profile(${id}) 的 pluginContext 必须是对象`)
    return prev
  }
  if (o.headers === undefined) return undefined
  if (!Array.isArray(o.headers)) {
    if (strict) throw invalid(`profile(${id}) 的 pluginContext.headers 必须是数组`)
    return prev
  }
  const out: string[] = []
  for (const h of o.headers) {
    if (typeof h !== 'string' || h === '' || h.length > MAX_HEADER_NAME) {
      if (strict) throw invalid(`profile(${id}) 的 pluginContext.headers 里有非法名字：${JSON.stringify(h)}`)
      continue
    }
    // 小写化并去重：HTTP 头名本来就不区分大小写，留着大小写只会让匹配出现「差一个字母就不生效」
    const low = h.toLowerCase()
    if (!out.includes(low)) out.push(low)
  }
  if (out.length > MAX_CTX_HEADERS) {
    if (strict) throw invalid(`profile(${id}) 的 pluginContext.headers 最多 ${MAX_CTX_HEADERS} 个`)
    return { headers: out.slice(0, MAX_CTX_HEADERS) }
  }
  return out.length ? { headers: out } : undefined
}

/**
 * 单个密钥档归一化。
 *
 * 顺序有意为之：先定 id（后续所有报错都要带它），再解析插件，最后交给插件校验参数。
 */
export function normalizeProfile(
  raw: unknown,
  existing: Map<string, CryptoProfile>,
  strict: boolean,
  plugins: PluginRegistry,
): CryptoProfile {
  const o = rawObject(raw)
  if (!o) throw invalid('profile 必须是对象')

  const idRaw = str(o.id)
  let id = newProfileId()
  if (idRaw) {
    if (ID_RE.test(idRaw)) id = idRaw
    else if (strict) throw invalid('profile.id 只允许字母数字下划线短横线')
  }
  const prev = existing.get(id)

  const pluginName = str(o.plugin) ?? prev?.plugin ?? BUILTIN_PLUGIN
  const plugin = plugins.get(pluginName)
  if (!plugin) {
    throw invalid(`profile(${id}) 引用了未加载的插件：${pluginName}（已加载：${plugins.names().join(', ') || '无'}）`)
  }

  // 换插件时不能沿用另一套形态的旧值：builtin↔私有插件 的字段是两套东西
  const prevSamePlugin = prev?.plugin === pluginName ? prev : undefined
  const flat = flatFieldsPresent(o)

  if (pluginName === BUILTIN_PLUGIN) {
    // 内置引擎的参数写在扁平字段上。同时给 options 会让「谁生效」变得不可判定
    if (strict && o.options !== undefined) {
      throw invalid(`profile(${id}) 用内置引擎，参数写在扁平字段（alg/key/...）上，不要再用 options`)
    }
  } else if (flat.length) {
    // 反过来同理：私有插件的参数只在 options 里
    const msg = `profile(${id}) 用插件 ${pluginName}，不能再带内置引擎的字段：${flat.join(', ')}`
    if (strict) throw invalid(msg)
  }

  const fields =
    pluginName === BUILTIN_PLUGIN
      ? normalizeBuiltin(o, prevSamePlugin, strict, id)
      : {} // 私有插件不用扁平字段
  const options =
    pluginName === BUILTIN_PLUGIN
      ? undefined
      : normalizeOptions(plugin.configSchema, o.options, prevSamePlugin?.options, strict, `profile(${id}).options`)

  const pluginContext = parsePluginContext(o.pluginContext, prevSamePlugin?.pluginContext, strict, id)

  // 加密回写的壳默认跟随响应方向：`{"data":"..."}` 这种接口，mock 也必须包回同一个壳，
  // 否则 App 取不到 data 字段。**不能默认 raw**——那会把外层结构一起吞掉。
  const responseWrap = parseWrap(o.response, prevSamePlugin?.response ?? { type: 'raw' }, strict)
  const profile: CryptoProfile = {
    id,
    name: str(o.name) ?? prev?.name ?? id,
    plugin: pluginName,
    ...(options ? { options } : {}),
    ...(pluginContext ? { pluginContext } : {}),
    ...fields,
    request: parseWrap(o.request, prevSamePlugin?.request ?? { type: 'raw' }, strict),
    response: responseWrap,
    encrypt: parseWrap(o.encrypt, prevSamePlugin?.encrypt ?? responseWrap, strict),
    query: parseQueryWrap(o.query, prevSamePlugin?.query, strict),
  }

  // 让插件用真实参数构造一次：aes-256 配 16 字节 key、AEAD 标签长度非法这类错误
  // 只有这里能提前发现，而不是等到第一万条请求才发现「全都解不开」。
  try {
    plugin.setup?.(profileOptions(profile), { profileId: id })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw invalid(`profile(${id}) 参数不合法：${msg}`)
  }
  return profile
}

export function normalizeRoute(raw: unknown, profileIds: Set<string>, strict: boolean): CryptoRoute {
  const o = rawObject(raw)
  if (!o) throw invalid('route 必须是对象')

  const idRaw = str(o.id)
  let id = newRouteId()
  if (idRaw) {
    if (ID_RE.test(idRaw)) id = idRaw
    else if (strict) throw invalid('route.id 只允许字母数字下划线短横线')
  }

  const profileId = str(o.profileId)
  if (!profileId) throw invalid(`route(${id}) 缺少 profileId`)
  // 写入口：指向不存在的档直接拒绝。读路径允许悬空（档可能被删了），match 时自然不会命中
  if (strict && !profileIds.has(profileId)) throw invalid(`route(${id}) 引用了不存在的 profileId: ${profileId}`)

  const m = rawObject(o.match) ?? {}
  const match: CryptoRoute['match'] = {}
  for (const k of ['method', 'host', 'path'] as const) {
    const v = str(m[k])
    if (v) match[k] = v
  }
  // 只按 method 匹配 = 把所有接口都解密，配错了会让整台设备的记录都变成乱码，必须拦
  if (!match.path && !match.host) throw invalid(`route(${id}) 至少要配 host 或 path（只按 method 匹配会把所有接口都解密）`)

  return {
    id,
    name: str(o.name) ?? undefined,
    enabled: bool(o.enabled, true),
    profileId,
    match,
    request: bool(o.request, true),
    response: bool(o.response, true),
  }
}

/** 与规则引擎同一套通配语法（`*` / `?` / `re:` 前缀）。非法正则 = 永不命中，不抛错。 */
export function matchOne(pattern: string | undefined, value: string): boolean {
  if (!pattern) return true
  if (pattern.startsWith('re:')) {
    try {
      return new RegExp(pattern.slice(3)).test(value)
    } catch {
      return false
    }
  }
  let out = ''
  for (const ch of pattern) {
    if (ch === '*') out += '.*'
    else if (ch === '?') out += '.'
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`).test(value)
}
