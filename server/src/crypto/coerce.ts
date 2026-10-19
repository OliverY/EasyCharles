/**
 * 逐字段取值时的宽松转换。
 *
 * 口径只有一条：**缺省值不报错，写错类型该报错的地方由调用方显式判断**。
 * 这样读盘（strict=false）能靠默认值把「多写了个字段」这种噪声忽略掉，
 * 而写入口（strict=true）需要拦的字段又不会被这里的宽松悄悄放过。
 */

import type { CryptoEncoding, CryptoKeyEncoding } from '../types.ts'
import { CIPHER_ENCODINGS, ENCODINGS } from './encoding.ts'

export function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

export function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

export function encOf(v: unknown, fallback: CryptoEncoding): CryptoEncoding {
  return typeof v === 'string' && CIPHER_ENCODINGS.has(v) ? (v as CryptoEncoding) : fallback
}

export function keyEncOf(v: unknown, fallback: CryptoKeyEncoding): CryptoKeyEncoding {
  return typeof v === 'string' && ENCODINGS.has(v) ? (v as CryptoKeyEncoding) : fallback
}

/** 闭区间整数；非整数 / 越界一律 null（AEAD 布局用） */
export function intIn(v: unknown, lo: number, hi: number): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : null
}

export function rawObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}
