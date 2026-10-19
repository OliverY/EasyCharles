/**
 * 密文在报文里的**位置**（Core 职责，ADR-040 决策 1）。
 *
 * 边界：这一层只回答「这段密文在哪儿、有没有固定前缀」，不回答「这段字节怎么变明文」。
 * 前者是接口结构（`{"payload":"…"}` / `?payload=` / `ciphertext:` 前缀），
 * 通用且可枚举；后者是业务知识（IV 几字节、tag 在头还是尾），交给插件。
 *
 * 这个划分是整条设计的支点：如果让内核切 IV/tag，等于把最不想公开的东西写进公开仓库。
 */

import type { CryptoQueryWrap, CryptoWrap } from '../types.ts'
import { bad, invalid, type Fail, type Ok } from './errors.ts'
import { rawObject } from './coerce.ts'

/** 密文串固定前缀的长度上限：够覆盖 `ciphertext:` 这类写法，又不至于变成「塞一整段 JSON 当前缀」 */
const PREFIX_MAX = 32

/**
 * 前缀：`ciphertext:` 这类固定标记。
 *
 * 允许空值（等于没配）；**不允许含空白**——它会被原样拼进 mock 出去的数据，
 * 一个看不见的尾随空格就能让「加密成功」变成「App 解不开」。
 */
function parsePrefix(raw: unknown, strict: boolean): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  if (typeof raw !== 'string') {
    if (strict) throw invalid('prefix 必须是字符串')
    return undefined
  }
  if (/\s/.test(raw) || raw.length > PREFIX_MAX) {
    if (strict) throw invalid(`prefix 不能含空白且不超过 ${PREFIX_MAX} 字符：${JSON.stringify(raw)}`)
    return undefined
  }
  return raw
}

export function parseWrap(raw: unknown, fallback: CryptoWrap, strict: boolean): CryptoWrap {
  // 缺省不是错误：绝大多数接口就是「整个 body 一段密文」，不该逼用户写 wrap
  if (raw === undefined || raw === null) return fallback
  const o = rawObject(raw)
  if (!o) {
    if (strict) throw invalid('wrap must be an object')
    return fallback
  }
  const prefix = parsePrefix(o.prefix, strict)
  const type = o.type
  if (type === 'raw') return prefix ? { type: 'raw', prefix } : { type: 'raw' }
  if (type === 'json' || type === 'form') {
    const field = o.field
    if (typeof field !== 'string' || !field) {
      if (strict) throw invalid(`wrap(${type}) 需要非空 field`)
      return fallback
    }
    return prefix ? { type, field, prefix } : { type, field }
  }
  if (strict) throw invalid('wrap.type 只能是 raw / json / form')
  return fallback
}

/** query 密文参数：只有「字段名 + 可选前缀」两种信息，缺省 = 不处理 query */
export function parseQueryWrap(
  raw: unknown,
  fallback: CryptoQueryWrap | undefined,
  strict: boolean,
): CryptoQueryWrap | undefined {
  if (raw === undefined || raw === null) return fallback
  const o = rawObject(raw)
  if (!o) {
    if (strict) throw invalid('query 必须是对象')
    return fallback
  }
  const field = o.field
  if (typeof field !== 'string' || !field) {
    if (strict) throw invalid('query 需要非空 field')
    return fallback
  }
  const prefix = parsePrefix(o.prefix, strict)
  return prefix ? { field, prefix } : { field }
}

/** 点路径取值（`data.body`）；中间遇到非对象就返回 undefined，不抛错 */
function pick(obj: unknown, path: string): unknown {
  let cur: unknown = obj
  for (const seg of path.split('.')) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

/**
 * 剥掉密文自带的固定前缀（`ciphertext:`）。
 *
 * 配了前缀却对不上时**明确报错**、不退回「当前缀不存在」：那等于把「配置写错了」
 * 变成「密钥不对」，是这条链路上最容易把人带偏的一种静默降级。
 */
function stripPrefix(value: string, prefix: string | undefined): Ok<{ value: string }> | Fail {
  if (!prefix) return { ok: true, value }
  const s = value.trim()
  if (!s.startsWith(prefix)) return bad(`密文缺少前缀 ${prefix}（检查 profile 的 prefix 配置）`)
  const rest = s.slice(prefix.length).trim()
  return rest ? { ok: true, value: rest } : bad(`前缀 ${prefix} 后面没有密文`)
}

/**
 * 从 body 里取出密文串（已剥掉前缀）。
 *
 * 返回的是**字符串**而不是字节：这正是插件拿到的入参形态。
 */
export function extractCipher(text: string, wrap: CryptoWrap): Ok<{ value: string }> | Fail {
  if (wrap.type === 'raw') {
    const v = text.trim()
    return v ? stripPrefix(v, wrap.prefix) : bad('body 为空')
  }
  if (wrap.type === 'json') {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return bad('body 不是合法 JSON，取不到密文字段')
    }
    const v = pick(parsed, wrap.field)
    if (typeof v !== 'string' || !v) return bad(`JSON 里没有字符串字段 ${wrap.field}`)
    return stripPrefix(v, wrap.prefix)
  }
  try {
    const v = new URLSearchParams(text).get(wrap.field)
    if (!v) return bad(`表单里没有字段 ${wrap.field}`)
    return stripPrefix(v, wrap.prefix)
  } catch {
    return bad('body 不是合法表单')
  }
}

/** 把密文塞回 body 外壳（mock 加密回写用）；`prefix` 必须补回，否则 App 侧解不开 */
export function wrapCipher(cipher: string, wrap: CryptoWrap): string {
  const body = wrap.prefix ? wrap.prefix + cipher : cipher
  if (wrap.type === 'raw') return body
  if (wrap.type === 'form') return `${wrap.field}=${encodeURIComponent(body)}`
  // json：只还原这一个字段。外层还有 code/msg 的场景，用户应在 mock 里填完整明文，
  // 由响应方向解密时的 wrap 描述位置；加密回写只保证「App 能解开」这一件事。
  return JSON.stringify({ [wrap.field]: body })
}

