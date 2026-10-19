/**
 * 文本 ↔ 字节的三种编码（协议 §5.6）。
 *
 * 这一层归 **Core** 而不是插件：`cipherEncoding` 描述的是「密文在报文里以什么字符形态出现」，
 * 属于接口结构；插件只拿到解码后的字符串再自己决定怎么切 IV/tag。
 *
 * 共同的坑：Node 的 `Buffer.from(x, 'base64')` 对非法字符是**静默跳过**而不是报错。
 * 所以凡是「用户可能粘错」的地方都先卡格式再解码——否则半个字符的差异会变成
 * 一段随机字节，最后报 padding 错误，把排查方向引到密钥上。
 */

import type { CryptoEncoding, CryptoKeyEncoding } from '../types.ts'

/** `keyEncoding` 允许 utf8（业务常见「十六进制字符串形式的明文密钥」） */
export const ENCODINGS: ReadonlySet<string> = new Set(['base64', 'base64url', 'hex', 'utf8'])
/** `cipherEncoding` 不含 utf8：密文一定是 base64/hex 这类字节编码 */
export const CIPHER_ENCODINGS: ReadonlySet<string> = new Set(['base64', 'base64url', 'hex'])

export function keyBuf(text: string, enc: CryptoKeyEncoding): Buffer {
  if (enc === 'hex') return Buffer.from(text, 'hex')
  // base64url 必须先换字符集：`Buffer.from(x,'base64')` 遇到 `-` `_` 是**跳过**而不是报错，
  // 32 字节密钥会静默变成 30 字节，最后报「Invalid key length」，排查方向被引到密钥本身。
  if (enc === 'base64url') return Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  if (enc === 'base64') return Buffer.from(text, 'base64')
  return Buffer.from(text, 'utf8')
}

/** 密文字符串 → 字节。**先卡格式再解码**，理由见文件头 */
export function cipherBuf(text: string, enc: CryptoEncoding): Buffer | null {
  const s = text.replace(/\s+/g, '')
  if (!s) return null
  if (enc === 'hex') {
    if (!/^[0-9a-fA-F]+$/.test(s) || s.length % 2 !== 0) return null
    return Buffer.from(s, 'hex')
  }
  if (enc === 'base64url') {
    if (!/^[A-Za-z0-9_-]+={0,2}$/.test(s)) return null
    return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null
  return Buffer.from(s, 'base64')
}

export function encodeCipher(buf: Buffer, enc: CryptoEncoding): string {
  if (enc === 'hex') return buf.toString('hex')
  if (enc === 'base64url') return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return buf.toString('base64')
}

/** UTF-8 严格解码：解出半个汉字 / 随机字节时明确报错，而不是变成一串 U+FFFD 让用户以为接口返回乱码 */
export function utf8Strict(buf: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    return null
  }
}
