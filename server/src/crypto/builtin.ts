/**
 * 内置加解密引擎（`plugin: 'builtin'`）。
 *
 * 它是**一个插件**、走和私有插件完全相同的 SPI——不是特例。理由只有一条：
 * 只留一条代码路径，才不会出现「内置能解、插件不能」的双标，也不会出现
 * 「修一个 padding 的 bug 要改两遍」。见 ADR-040 决策 2。
 *
 * 公开仓库留它的依据：AES / 3DES / SM4 / GCM 都是公开标准算法，写清楚它们的调用方式
 * 不泄露任何业务信息。真正要保护的是**布局与密钥**——布局由 profile 的 `aead` /
 * `cipherEncoding` 描述（用户自己填），密钥只在 `.data/crypto/settings.json`。
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { CryptoAead, CryptoEncoding, CryptoKeyEncoding, CryptoProfile } from '../types.ts'
import { bad, invalid, type Fail, type Ok } from './errors.ts'
import { cipherBuf, encodeCipher, keyBuf, utf8Strict } from './encoding.ts'
import { bool, encOf, intIn, keyEncOf, rawObject, str } from './coerce.ts'
import { SPI_VERSION, type CryptoPlugin, type PluginCall, type PluginOptions, type PluginResult } from './plugin-types.ts'

export const BUILTIN_PLUGIN = 'builtin'

/**
 * 允许的**非 AEAD** 算法名。
 *
 * 不直接放行任意字符串：`createCipheriv` 接受一堆需要 authTag 的 AEAD（gcm/ccm/ocb/
 * chacha20-poly1305），它们解密前必须 `setAuthTag`，而它们**不能只靠算法名用起来**——
 * 还得知道 IV 多长、标签多长、标签在头还是在尾。所以 AEAD 走单独的一条白名单 +
 * 必填的 `aead` 布局（见下），不许「只写个 alg 就当配好了」。
 */
const ALG_RE = /^(aes-(128|192|256)-(cbc|ecb|ctr|cfb1|cfb8|cfb|ofb)|des-ede3-cbc|sm4-(cbc|ecb))$/
/** AEAD：必须同时给出 `aead{ ivBytes, tagBytes, tagAt }`，且不能配 `iv`（IV 在密文里） */
const AEAD_ALG_RE = /^(aes-(128|192|256)-gcm|chacha20-poly1305)$/

export function isAeadAlg(alg: string): boolean {
  return AEAD_ALG_RE.test(alg)
}

/**
 * 内置引擎的参数形态：与 `CryptoProfile` 的扁平字段一一对应（磁盘格式因此不用改）。
 *
 * 写成 `type` 而不是 `interface`：类型别名才带隐式索引签名，才能直接当
 * `PluginOptions`（`Record<string, unknown>`）用，省掉一层无意义的拷贝。
 */
export type BuiltinFields = {
  alg: string
  key: string
  keyEncoding: CryptoKeyEncoding
  iv?: string
  ivEncoding?: CryptoKeyEncoding
  aead?: CryptoAead
  cipherEncoding: CryptoEncoding
  autoPadding: boolean
}

/** profile 的扁平字段 → 插件参数。**零迁移的关键**：不落盘、每次现算 */
export function builtinFields(p: CryptoProfile): BuiltinFields {
  // `alg` / `key` 在类型上是可选的（私有插件的 profile 没有它们），但内置档一定由
  // `normalizeBuiltin` 填满。这里给空串兜底而不是 `!`：真出现漏填时插件会报
  // 「不支持的算法」「缺少 key」这种可读错误，而不是 undefined 引发的 TypeError。
  return {
    alg: p.alg ?? '',
    key: p.key ?? '',
    keyEncoding: p.keyEncoding ?? 'utf8',
    iv: p.iv,
    ivEncoding: p.ivEncoding,
    aead: p.aead,
    cipherEncoding: p.cipherEncoding ?? 'base64',
    autoPadding: p.autoPadding !== false,
  }
}

// ── 对称加密 ──────────────────────────────────────────────────

function makeCipher(p: BuiltinFields, decrypt: boolean): ReturnType<typeof createCipheriv> {
  const key = keyBuf(p.key, p.keyEncoding)
  // ECB 没有 IV：必须传 null（传 Buffer.alloc(0) 会报 Invalid IV length）
  const iv = p.iv ? keyBuf(p.iv, p.ivEncoding ?? p.keyEncoding) : null
  const c = decrypt ? createDecipheriv(p.alg, key, iv) : createCipheriv(p.alg, key, iv)
  c.setAutoPadding(p.autoPadding)
  return c
}

/**
 * `@types/node` 的 `Cipher` / `Decipher` 上没有 `setAuthTag` / `getAuthTag`（那是 `CipherGCM`
 * 之类专用接口才有的），chacha20-poly1305 更没有对应的重载。运行时这两个方法一直都在，
 * 所以这里按**实际用到的四个方法**声明最小接口，只影响类型、不改运行时行为。
 */
interface AeadCipher {
  update(data: Buffer): Buffer
  final(): Buffer
  setAAD(aad: Buffer): unknown
  getAuthTag(): Buffer
}
interface AeadDecipher {
  update(data: Buffer): Buffer
  final(): Buffer
  setAAD(aad: Buffer): unknown
  setAuthTag(tag: Buffer): unknown
}
type AeadCipherFactory = (algorithm: string, key: Buffer, iv: Buffer, options: { authTagLength: number }) => AeadCipher
type AeadDecipherFactory = (algorithm: string, key: Buffer, iv: Buffer, options: { authTagLength: number }) => AeadDecipher
const createAeadCipher = createCipheriv as unknown as AeadCipherFactory
const createAeadDecipher = createDecipheriv as unknown as AeadDecipherFactory

/**
 * AEAD 密文 → 明文。
 *
 * 布局按 `aead` 描述切：`iv | ct | tag`（`tagAt='end'`）或 `iv | tag | ct`（`tagAt='start'`）。
 * 切错方向不会解出乱码而是**必然认证失败**——这正是 AEAD 的价值：错就是错，不会静默给出垃圾。
 */
function decipherAead(p: BuiltinFields, aead: CryptoAead, buf: Buffer): Ok<{ out: Buffer }> | Fail {
  if (buf.length < aead.ivBytes + aead.tagBytes) {
    return bad(`密文只有 ${buf.length} 字节，不足 IV(${aead.ivBytes}) + 认证标签(${aead.tagBytes})`)
  }
  const iv = buf.subarray(0, aead.ivBytes)
  const rest = buf.subarray(aead.ivBytes)
  const tagAtEnd = aead.tagAt === 'end'
  const tag = tagAtEnd ? rest.subarray(rest.length - aead.tagBytes) : rest.subarray(0, aead.tagBytes)
  const ct = tagAtEnd ? rest.subarray(0, rest.length - aead.tagBytes) : rest.subarray(aead.tagBytes)
  try {
    const d = createAeadDecipher(p.alg, keyBuf(p.key, p.keyEncoding), iv, { authTagLength: aead.tagBytes })
    d.setAuthTag(tag)
    if (aead.aad) d.setAAD(Buffer.from(aead.aad, 'utf8'))
    return { ok: true, out: Buffer.concat([d.update(ct), d.final()]) }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // 认证失败只有三种原因：密钥不对、布局（iv/tag 长度或位置）不对、AAD 不一致。
    // 把这三条写进错误里，比抛一句 "unable to authenticate data" 有用得多。
    return bad(`解密失败（AEAD 认证不通过：密钥 / ivBytes+tagBytes+tagAt 布局 / aad 三者之一不匹配）：${msg}`)
  }
}

/** 明文 → AEAD 密文；IV 每次随机（必须，随机 IV 是 GCM 的安全前提） */
function cipherAead(p: BuiltinFields, aead: CryptoAead, plain: string): Ok<{ out: Buffer }> | Fail {
  try {
    const iv = randomBytes(aead.ivBytes)
    const c = createAeadCipher(p.alg, keyBuf(p.key, p.keyEncoding), iv, { authTagLength: aead.tagBytes })
    if (aead.aad) c.setAAD(Buffer.from(aead.aad, 'utf8'))
    const ct = Buffer.concat([c.update(Buffer.from(plain, 'utf8')), c.final()])
    const tag = c.getAuthTag()
    const out = aead.tagAt === 'end' ? Buffer.concat([iv, ct, tag]) : Buffer.concat([iv, tag, ct])
    return { ok: true, out }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return bad(`加密失败（密钥 / 算法不匹配）：${msg}`)
  }
}

/**
 * 密文串 → 明文串。**插件契约的 decrypt 实现**。
 *
 * 入参是已经剥掉 `wrap.prefix` 的密文串；编码（base64/base64url/hex）由 `cipherEncoding`
 * 决定——它属于「这段密文在报文里长什么样」，与布局一起归插件。
 * 返回的明文一定是合法 UTF-8；二进制明文（protobuf 等）当前不支持，
 * 会明确报「不是文本」而不是让控制台显示一堆替换字符。
 */
function decryptText(p: BuiltinFields, text: string): PluginResult<string> {
  const buf = cipherBuf(text, p.cipherEncoding)
  if (!buf) return bad(`密文不是合法的 ${p.cipherEncoding} 编码`)
  let out: Buffer
  if (isAeadAlg(p.alg)) {
    if (!p.aead) return bad(`profile 是 ${p.alg} 但没配 aead 布局`)
    const r = decipherAead(p, p.aead, buf)
    if (!r.ok) return r
    out = r.out
  } else {
    try {
      const d = makeCipher(p, true)
      out = Buffer.concat([d.update(buf), d.final()])
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // bad decrypt / wrong final block 基本都是「key/iv/算法对不上」，直接把排查方向说明白
      return bad(`解密失败（密钥 / IV / 算法与这份密文不匹配）：${msg}`)
    }
  }
  const plain = utf8Strict(out)
  if (plain === null) return bad('解密结果不是合法 UTF-8 文本（可能是 key 不对，或明文是二进制）')
  return { ok: true, value: plain }
}

/** 明文串 → 密文串（mock 回写）。外壳由 Core 的 `wrapCipher` 负责，这里只出密文串 */
function encryptText(p: BuiltinFields, text: string): PluginResult<string> {
  let out: Buffer
  if (isAeadAlg(p.alg)) {
    if (!p.aead) return bad(`profile 是 ${p.alg} 但没配 aead 布局`)
    const r = cipherAead(p, p.aead, text)
    if (!r.ok) return r
    out = r.out
  } else {
    try {
      const c = makeCipher(p, false)
      out = Buffer.concat([c.update(Buffer.from(text, 'utf8')), c.final()])
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return bad(`加密失败（密钥 / 算法不匹配）：${msg}`)
    }
  }
  return { ok: true, value: encodeCipher(out, p.cipherEncoding) }
}

// ── 配置归一化（P0 专用；P1 交给 configSchema 驱动）─────────────
//
// 为什么归一化没有走 SPI：`CryptoProfile` 目前是**扁平字段**，而 schema 驱动的表单
// 要求参数是自由键值。P0 的验收线是「逐字段等价」，此时把扁平字段硬拆成 options
// 只会让磁盘格式和类型双双变味。所以这里按内置引擎的字段做校验，
// 等 P1 真正需要「任意插件任意参数」时再把这段换成 schema 校验。

/**
 * AEAD 布局：三个数字都要对，缺一个就不是「写得不好看」而是「一定解不开」。
 *
 * `strict=false`（读盘）时坏布局返回 undefined，由调用方按「AEAD 缺布局」丢弃整条；
 * `strict=true`（写入口）直接抛 400，一次把话说清。
 */
export function parseAead(raw: unknown, id: string, strict: boolean): CryptoAead | undefined {
  if (raw === undefined || raw === null) return undefined
  const o = rawObject(raw)
  if (!o) {
    if (strict) throw invalid(`profile(${id}) 的 aead 必须是对象`)
    return undefined
  }
  const ivBytes = intIn(o.ivBytes, 1, 64)
  const tagBytes = intIn(o.tagBytes, 4, 32)
  if (ivBytes === null || tagBytes === null) {
    if (strict) throw invalid(`profile(${id}) 的 aead 需要 ivBytes(1-64) 与 tagBytes(4-32) 两个整数`)
    return undefined
  }
  const tagAtRaw = o.tagAt
  const tagAt = tagAtRaw === 'start' || tagAtRaw === 'end' ? tagAtRaw : tagAtRaw === undefined ? 'end' : null
  if (tagAt === null) {
    if (strict) throw invalid(`profile(${id}) 的 aead.tagAt 只能是 end / start`)
    return undefined
  }
  const aad = o.aad
  if (aad !== undefined && typeof aad !== 'string') {
    if (strict) throw invalid(`profile(${id}) 的 aead.aad 必须是字符串`)
    return undefined
  }
  if (typeof aad === 'string' && aad.length > 1024) {
    if (strict) throw invalid(`profile(${id}) 的 aead.aad 过长（>1024）`)
    return undefined
  }
  return typeof aad === 'string' && aad ? { ivBytes, tagBytes, tagAt, aad } : { ivBytes, tagBytes, tagAt }
}

/**
 * 内置引擎的字段归一化。
 *
 * 校验策略只有一条：**结构性问题一律抛**，由调用方决定怎么处理——
 * - 写入口（`strict=true`）把异常翻成 400，整份配置都不落盘；
 * - 读盘（`strict=false`）在 `load()` 里逐条 catch，只丢坏的那条。
 *
 * `strict` 只影响「能修则修」的几处（ECB 上多余的 iv 丢弃），
 * 不改变「什么算合法」——两套校验口径分叉，就会出现「写进去能存、重启就消失」。
 */
export function normalizeBuiltin(
  o: Record<string, unknown>,
  prev: CryptoProfile | undefined,
  strict: boolean,
  id: string,
): BuiltinFields {
  const alg = str(o.alg)
  const aeadAlg = !!alg && isAeadAlg(alg)
  if (!alg || (!ALG_RE.test(alg) && !aeadAlg)) {
    throw invalid(
      `profile.alg 不支持：${String(o.alg)}（可用 aes-128/192/256-cbc|ecb|ctr|cfb|ofb、aes-128/192/256-gcm、` +
        `chacha20-poly1305、des-ede3-cbc、sm4-cbc|ecb）`,
    )
  }

  let key: string | null = str(o.key)
  // 打码值回写 = 「这次不改密钥」。没有旧值可沿用时按缺失处理，绝不把打码串当密钥存下去
  if (key && key.includes('•')) key = null
  if (!key && prev?.key) key = prev.key
  if (!key) throw invalid(`profile(${id}) 缺少 key`)

  const keyEncoding = keyEncOf(o.keyEncoding, prev?.keyEncoding ?? 'utf8')
  const cipherEncoding = encOf(o.cipherEncoding, prev?.cipherEncoding ?? 'base64')
  const autoPadding = bool(o.autoPadding, true)

  // AEAD 的布局：算法是 AEAD 就必须有，不是 AEAD 就不该有（配了也不会生效，等于骗自己）
  const aead = parseAead(o.aead, id, strict)
  if (aeadAlg && !aead) {
    throw invalid(`profile(${id}) 是 ${alg}，必须配 aead{ ivBytes, tagBytes, tagAt }（IV/标签都随密文走，猜不出来）`)
  }
  if (!aeadAlg && o.aead !== undefined) {
    if (strict) throw invalid(`profile(${id}) 是 ${alg}，不是 AEAD 算法，不该配 aead`)
  }

  let iv: string | undefined = str(o.iv) ?? undefined
  if (iv && iv.includes('•')) iv = undefined
  if (!iv && prev?.iv) iv = prev.iv
  // ECB 带 IV 是配置错误：Node 会直接抛 Invalid IV length，这里给出可读的结论
  // AEAD 同理：IV 每次加密随机生成、拼在密文里，配置里写死一个 IV 只会让人以为「用上了」
  if ((/ecb$/.test(alg) || aeadAlg) && iv) {
    if (strict) throw invalid(`profile(${id}) 是 ${alg}，不能配置 iv（IV ${aeadAlg ? '随密文生成' : '在 ECB 下不存在'}）`)
    iv = undefined
  }

  return {
    alg,
    key,
    keyEncoding,
    iv,
    ivEncoding: iv ? keyEncOf(o.ivEncoding, 'utf8') : undefined,
    aead,
    cipherEncoding,
    autoPadding,
  }
}

// ── 插件实例 ──────────────────────────────────────────────────

/** 已归一化过，运行期不再重复校验结构；只把 unknown 收窄成内置引擎认识的形状 */
function asFields(o: PluginOptions): BuiltinFields {
  return o as unknown as BuiltinFields
}

export const builtinPlugin: CryptoPlugin = {
  spiVersion: SPI_VERSION,
  name: BUILTIN_PLUGIN,
  version: '1.0.0',
  title: '内置引擎（AES / 3DES / SM4 / AEAD）',
  description:
    '配置驱动的通用对称加解密：算法 + 密钥 + 密文位置 + AEAD 布局。不含任何业务变形，可直接用于公开版。',
  capability: { decrypt: true, encrypt: true },
  isolation: 'in-process',
  timeoutMs: 500,

  // 键名与 CryptoProfile 的扁平字段一致：P1 的表单可以直接按这份 schema 渲染
  configSchema: {
    type: 'object',
    required: ['alg', 'key', 'cipherEncoding'],
    properties: {
      alg: {
        type: 'string',
        title: '算法',
        description: 'aes-128/192/256-cbc|ecb|ctr|cfb|ofb、aes-*-gcm、chacha20-poly1305、des-ede3-cbc、sm4-cbc|ecb',
      },
      key: { type: 'string', title: '密钥', secret: true },
      keyEncoding: {
        type: 'string',
        title: '密钥编码',
        enum: ['utf8', 'base64', 'base64url', 'hex'],
        default: 'utf8',
      },
      iv: { type: 'string', title: 'IV（ECB / AEAD 不填）', secret: true },
      ivEncoding: { type: 'string', title: 'IV 编码', enum: ['utf8', 'base64', 'base64url', 'hex'], default: 'utf8' },
      cipherEncoding: { type: 'string', title: '密文编码', enum: ['base64', 'base64url', 'hex'], default: 'base64' },
      autoPadding: { type: 'boolean', title: '自动 PKCS#7 padding', default: true },
    },
  },

  /**
   * 用真实构造一次来验参数：aes-256 配 16 字节 key、AEAD 标签长度非法这类错误
   * 只有这里能提前发现，而不是等到第一万条请求才发现「全都解不开」。
   */
  setup(options) {
    const f = asFields(options)
    if (isAeadAlg(f.alg)) {
      if (!f.aead) throw new Error(`profile 是 ${f.alg} 但没配 aead 布局`)
      const r = cipherAead(f, f.aead, '')
      if (!r.ok) throw new Error(r.error)
      return
    }
    makeCipher(f, false)
  },

  decrypt(call: PluginCall) {
    return decryptText(asFields(call.options), call.text)
  },

  encrypt(call: PluginCall) {
    return encryptText(asFields(call.options), call.text)
  },

  /** 往返自检：加密再解回来，比单看构造成功更能发现「布局写反」这类问题 */
  selftest(options, sample) {
    const f = asFields(options)
    const plain = sample ?? '{"ec":"selftest"}'
    const enc = encryptText(f, plain)
    if (!enc.ok) return enc
    const dec = decryptText(f, enc.value)
    if (!dec.ok) return dec
    return dec.value === plain ? { ok: true, value: dec.value } : { ok: false, error: '往返结果与原文不一致' }
  },
}

/** 只给自测与调试用：直接驱动内置引擎，不经过注册表 */
export { decryptText as builtinDecrypt, encryptText as builtinEncrypt }
