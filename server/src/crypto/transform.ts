/**
 * 数据面用的加解密门面：**内核只管「密文在哪」，变换交给插件**。
 *
 * 一次解密的完整链路：
 * ```
 * body 原文 ──extractCipher(wrap/prefix)──> 密文串 ──plugin.decrypt──> 明文串
 * ```
 * 这条链路是单向且不落盘的：结果只写进 `EcRecord` 给控制台看，发往上游/App 的字节
 * 完全不受影响（ADR-039 决策 1）。所以这里的任何失败都必须能降级成
 * 「转发正常 + 记录保留原文 + 写 crypto.error」。
 */

import type { CryptoProfile, CryptoWrap } from '../types.ts'
import { bad, type Fail, type Ok } from './errors.ts'
import type { PluginContext, PluginResult } from './plugin-types.ts'
import { profileOptions } from './profile.ts'
import { defaultRegistry, type PluginRegistry } from './registry.ts'
import { extractCipher, wrapCipher } from './wrap.ts'

/**
 * 把插件的返回值收窄成同步结果。
 *
 * P0 的调用链是同步的（只改内存里的记录，不碰 I/O），所以异步插件在这里被**明确拒绝**
 * 而不是被静默等待——静默等待会让 `decryptWith` 返回一个 Promise，被当成明文塞进记录，
 * 变成一串 `[object Promise]`。P2 接 worker 时这个函数整体变成 `await`，插件签名不用改。
 */
function syncResult(r: PluginResult<string> | Promise<PluginResult<string>>): PluginResult<string> {
  if (r && typeof (r as Promise<PluginResult<string>>).then === 'function') {
    // 吞掉这个 Promise 的 rejection：调用方已按失败处理，不能让它在进程里变成 unhandledRejection
    void (r as Promise<PluginResult<string>>).catch(() => {})
    return bad('插件返回了 Promise：异步插件需要 worker 宿主（P2），当前版本只支持同步插件')
  }
  return r as PluginResult<string>
}

/** 请求头（大小写不定，可能有多值）。插件拿到的永远是这个类型的**子集** */
export type RawHeaderMap = Record<string, string | string[] | undefined>

/** 单个 header 值的上限：插件要的是 nonce / 时间戳，不是一整个 cookie jar */
const MAX_HEADER_VALUE = 256

/**
 * 组装插件上下文。
 *
 * **只传 profile 里显式声明的那几个 header**（ADR-040 决策 6）。没配就是空对象——
 * 这是设计，不是遗漏：插件若能看到全部流量，就不再是「字节变换函数」，
 * 而是能外发数据、能按用户身份做手脚的后门。
 */
function ctxOf(p: CryptoProfile, headers?: RawHeaderMap): PluginContext {
  const allow = p.pluginContext?.headers
  if (!allow?.length || !headers) return { profileId: p.id, headers: {} }
  // 先整体小写化：白名单里存的是小写名，而调用方给的可能是原始大小写（HTTP 头不区分大小写）
  const lower: RawHeaderMap = {}
  for (const k of Object.keys(headers)) lower[k.toLowerCase()] = headers[k]
  const picked: Record<string, string> = {}
  for (const name of allow) {
    const v = lower[name]
    const one = Array.isArray(v) ? v[0] : v
    if (typeof one === 'string' && one !== '') picked[name] = one.slice(0, MAX_HEADER_VALUE)
  }
  return { profileId: p.id, headers: picked }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * 密文 → 明文（请求方向传 `p.request`，响应方向传 `p.response`，query 方向传 `p.query`）。
 *
 * 返回的 `plain` 一定是合法 UTF-8；二进制明文（protobuf 等）当前不支持，
 * 会明确报「不是文本」而不是让控制台显示一堆替换字符。
 */
export function decryptWith(
  p: CryptoProfile,
  text: string,
  wrap: CryptoWrap,
  plugins: PluginRegistry = defaultRegistry,
  headers?: RawHeaderMap,
): Ok<{ plain: string }> | Fail {
  const got = extractCipher(text, wrap)
  if (!got.ok) return got

  const plugin = plugins.get(p.plugin)
  if (!plugin) return bad(`密钥档 ${p.id} 引用的插件 ${p.plugin} 未加载`)

  let r: PluginResult<string>
  try {
    r = syncResult(plugin.decrypt({ text: got.value, options: profileOptions(p), ctx: ctxOf(p, headers) }))
  } catch (e) {
    // 插件抛异常不能把抓包服务带崩：按失败降级，原文照常展示
    return bad(`插件 ${p.plugin} 解密异常：${errMsg(e)}`)
  }
  return r.ok ? { ok: true, plain: r.value } : bad(r.error)
}

/** 明文 → 密文（mock 回写）。外壳（JSON / 表单 / 前缀）由 `wrapCipher` 补回 */
export function encryptWith(
  p: CryptoProfile,
  plain: string,
  wrap: CryptoWrap,
  plugins: PluginRegistry = defaultRegistry,
  headers?: RawHeaderMap,
): Ok<{ body: string }> | Fail {
  const plugin = plugins.get(p.plugin)
  if (!plugin) return bad(`密钥档 ${p.id} 引用的插件 ${p.plugin} 未加载`)
  // 没声明 encrypt 的插件不能用于回写：否则 mock 出去的明文会让 App 侧的拦截器直接报错
  if (!plugin.capability.encrypt || !plugin.encrypt) {
    return bad(`插件 ${p.plugin} 不支持加密，无法把 mock 明文回写成密文`)
  }

  let r: PluginResult<string>
  try {
    r = syncResult(plugin.encrypt({ text: plain, options: profileOptions(p), ctx: ctxOf(p, headers) }))
  } catch (e) {
    return bad(`插件 ${p.plugin} 加密异常：${errMsg(e)}`)
  }
  if (!r.ok) return r
  return { ok: true, body: wrapCipher(r.value, wrap) }
}

/**
 * query 里的密文参数 → 明文。
 *
 * 复用 `decryptWith`，只是把 wrap 换成「raw + query.prefix」：query 里不会有
 * `{"data":"..."}` 这种外壳，取出来本来就是一段密文串。前缀是**可选**的：
 * 有的端把 `ciphertext:` 也带进了 URL，有的不带。
 */
export function decryptQuery(
  p: CryptoProfile,
  value: string,
  plugins: PluginRegistry = defaultRegistry,
  headers?: RawHeaderMap,
): Ok<{ plain: string }> | Fail {
  if (!p.query) return bad('profile 没配 query')
  return decryptWith(p, value, { type: 'raw', prefix: p.query.prefix }, plugins, headers)
}

/**
 * 解密一段文本并产出记录侧要的两个值：
 * - `body`   → 明文（控制台主视图）
 * - `rawBody`→ 密文原文（「查看密文」视图）
 *
 * 失败时 `body` 保持原样，只给 error —— 绝不能因为解密失败就把记录清空。
 */
export function decryptForRecord(
  p: CryptoProfile,
  body: string,
  wrap: CryptoWrap,
  plugins: PluginRegistry = defaultRegistry,
  headers?: RawHeaderMap,
): { body: string; rawBody: string | null; error?: string } {
  const r = decryptWith(p, body, wrap, plugins, headers)
  if (!r.ok) return { body, rawBody: null, error: r.error }
  return { body: r.plain, rawBody: body }
}
