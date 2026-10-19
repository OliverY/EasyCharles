/**
 * 插件参数的 schema 校验与打码（ADR-040 §8）。
 *
 * 职责边界要说清：**configSchema 是表单描述，不是安全边界。** 真正的边界是
 * 「谁能把文件拷进 `<dataDir>/plugins/`」。这里做校验，是因为管理面的每一个写入
 * 入口都是不可信输入——不校验的话 `options` 会变成任意 JSON 的垃圾桶，
 * 而「垃圾桶里的东西」出问题时没有任何可读的线索。
 *
 * 三条口径与 ADR-039 保持一致：
 *
 * 1. **不做隐式类型转换**。`ivBytes: "12"` 直接 400，不偷偷 `Number()`。
 *    偷偷转换的后果是「控制台显示 12、插件里是 undefined」，属于最难查的那类。
 * 2. **打码值回写 = 沿用旧值**。`secret: true` 的字段在 GET 里被打码，PUT 回来时
 *    原样带回即表示不修改；没有旧值可沿用时 400，**绝不把 `••••` 存成密钥**。
 * 3. **未声明的字段放行**。插件升级新增字段时，旧配置不能因此保存失败；
 *    但单字段仍有长度上限，防止有人往配置里塞 Base64 大文件。
 */

import { invalid } from './errors.ts'
import type { PluginConfigSchema } from './plugin-types.ts'

/** 打码占位符。与 store 的 `CRYPTO_MASK` 必须一致 */
const MASK = '••••'
/** 单个字符串字段上限。密钥/证书再长也够，同时挡住「把文件塞进配置」 */
const MAX_STRING = 4096
/** options 整体字节上限（序列化后） */
const MAX_OPTIONS_BYTES = 64 * 1024
/** 自由 JSON（脚本插件）的嵌套深度上限：挡「把一棵大树塞进配置」 */
const MAX_DEPTH = 6

type PropSchema = PluginConfigSchema['properties'][string]

/**
 * 只有 JSON 标量 / 数组 / 普通对象，且深度受限。
 *
 * 脚本插件没有 schema，字段值原样进插件。这里不校验类型（业务自己懂），
 * 但要挡住「结构深到 JSON.stringify 会栈溢出」这类输入——它来自管理面，不可信。
 */
function jsonOk(v: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false
  if (v === null) return true
  if (Array.isArray(v)) return v.every((x) => jsonOk(x, depth + 1))
  if (typeof v === 'object') return Object.values(v as Record<string, unknown>).every((x) => jsonOk(x, depth + 1))
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
}

function isMasked(v: unknown): boolean {
  return typeof v === 'string' && v.includes('•')
}

/** 类型判定。整数字段必须真的是整数，`1.5` 与 `"1"` 都不算 */
function typeOk(spec: PropSchema, v: unknown): boolean {
  switch (spec.type) {
    case 'string':
      return typeof v === 'string'
    case 'boolean':
      return typeof v === 'boolean'
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v)
    case 'number':
      return typeof v === 'number' && Number.isFinite(v)
    default:
      return false
  }
}

function describe(spec: PropSchema): string {
  if (spec.enum && spec.enum.length) return spec.enum.map((x) => JSON.stringify(x)).join(' / ')
  if (spec.type === 'integer' || spec.type === 'number') {
    if (spec.minimum !== undefined && spec.maximum !== undefined) return `${spec.type} ${spec.minimum}~${spec.maximum}`
    if (spec.minimum !== undefined) return `${spec.type} ≥ ${spec.minimum}`
    if (spec.maximum !== undefined) return `${spec.type} ≤ ${spec.maximum}`
  }
  return spec.type
}

function checkOne(name: string, spec: PropSchema, v: unknown): string | null {
  if (!typeOk(spec, v)) return `${name} 需要 ${spec.type}，收到 ${JSON.stringify(v)}（不做隐式转换）`
  if (typeof v === 'string' && v.length > MAX_STRING) return `${name} 过长（>${MAX_STRING} 字符）`
  if (spec.enum && spec.enum.length && !spec.enum.includes(v as string | number)) {
    return `${name} 只能是 ${describe(spec)}，收到 ${JSON.stringify(v)}`
  }
  if ((spec.type === 'integer' || spec.type === 'number') && typeof v === 'number') {
    if (spec.minimum !== undefined && v < spec.minimum) return `${name} 不能小于 ${spec.minimum}`
    if (spec.maximum !== undefined && v > spec.maximum) return `${name} 不能大于 ${spec.maximum}`
  }
  return null
}

/**
 * 归一化一个 profile 的 `options`。
 *
 * `strict=true`（写入口）任何不合法都抛 400，整份配置不落盘；
 * `strict=false`（读盘）只丢弃出问题的字段，让插件自己的 `setup` 去判定「这套参数可用吗」——
 * 读盘路径的原则是「一条坏配置不能带走整份文件」。
 *
 * @param prev 同一 id 的旧 options，仅用于「打码值沿用」
 */
export function normalizeOptions(
  schema: PluginConfigSchema | undefined,
  raw: unknown,
  prev: Record<string, unknown> | undefined,
  strict: boolean,
  label: string,
): Record<string, unknown> {
  if (raw === undefined || raw === null) {
    const merged: Record<string, unknown> = { ...(prev ?? {}) }
    // 缺省值只在读盘时补齐；写入口保持「用户填了什么就是什么」，避免保存后悄悄多出字段
    if (!strict && schema) {
      for (const [k, spec] of Object.entries(schema.properties)) {
        if (merged[k] === undefined && spec.default !== undefined) merged[k] = spec.default
      }
    }
    const missing = requiredMissing(schema, merged)
    if (missing) {
      if (strict) throw invalid(`${label} 缺少必填参数：${missing}`)
      return prev ?? {}
    }
    return merged
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    if (strict) throw invalid(`${label} 的 options 必须是对象`)
    return prev ?? {}
  }

  const src = raw as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(src)) {
    const spec = schema?.properties[k]
    // 打码值：沿用旧值。没有旧值就是配置错误——把 '••••' 当密钥存下去，
    // 症状是「保存成功、解密全失败」（ADR-039 已经踩过一次）
    if (isMasked(v)) {
      const old = prev?.[k]
      if (old === undefined) {
        if (strict) throw invalid(`${label}.${k} 是打码值，但没有可沿用的旧值，请重新填写`)
        continue
      }
      out[k] = old
      continue
    }
    if (spec) {
      const why = checkOne(k, spec, v)
      if (why) {
        if (strict) throw invalid(`${label}: ${why}`)
        continue
      }
    } else if (!jsonOk(v)) {
      // 脚本插件的自由参数走这里：类型不管，但结构必须是一棵正常的 JSON 树
      if (strict) throw invalid(`${label}.${k} 必须是合法 JSON（标量 / 数组 / 对象，嵌套 ≤ ${MAX_DEPTH} 层）`)
      continue
    } else if (typeof v === 'string' && v.length > MAX_STRING) {
      if (strict) throw invalid(`${label}.${k} 过长（>${MAX_STRING} 字符）`)
      continue
    }
    out[k] = v
  }

  if (strict && schema) {
    const missing = requiredMissing(schema, out)
    if (missing) throw invalid(`${label} 缺少必填参数：${missing}`)
  }
  if (JSON.stringify(out).length > MAX_OPTIONS_BYTES) {
    if (strict) throw invalid(`${label}.options 过大（>${MAX_OPTIONS_BYTES} 字节）`)
    return prev ?? {}
  }
  return out
}

function requiredMissing(schema: PluginConfigSchema | undefined, opts: Record<string, unknown>): string | null {
  if (!schema?.required?.length) return null
  const missing = schema.required.filter((k) => opts[k] === undefined)
  return missing.length ? missing.join(', ') : null
}

/**
 * 下发视图用的打码 `options`。
 *
 * 三档口径，**从显式到保守**：
 * 1. 有 `configSchema` → 只打 `secret: true` 的字段（内置引擎与目录插件）；
 * 2. 没有 schema 但脚本声明了 `secrets` → 只打这几个（脚本插件）；
 * 3. 都没有 → **整份打码**。宁可让用户重新填一遍，也不能让密钥明文出现在页面上。
 *
 * 打码只露首尾各 2 个字符——足够确认「是不是这一把」，又不足以还原任何一段有用信息。
 * 回写时的判据是「值里含 `•`」，所以三档共用一个占位符。
 */
export function maskOptions(
  schema: PluginConfigSchema | undefined,
  options: Record<string, unknown> | undefined,
  secretFields?: string[],
): Record<string, unknown> | undefined {
  if (!options) return undefined
  // 没有 schema 也没有 secrets 声明时，整份都算敏感（第 3 档）
  const maskEverything = !schema && !secretFields?.length
  /** 这个字段要不要打码。三档口径见上面的注释 */
  const needsMask = (key: string): boolean => {
    if (schema) return !!schema.properties[key]?.secret
    if (maskEverything) return true
    return !!secretFields?.includes(key)
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(options)) {
    if (needsMask(k) && typeof v === 'string' && v !== '') {
      out[k] = v.length <= 4 ? MASK : `${v.slice(0, 2)}${MASK}${v.slice(-2)}`
    } else {
      out[k] = v
    }
  }
  return out
}

/**
 * 判断插件参数里是否出现了**内置引擎的扁平字段**。
 *
 * 用途见 ADR-040 决策 3：一个 profile 同时写着 `alg` 和 `plugin: xxx` 时，
 * 出问题无法判断哪套生效。写入口直接 400，读盘时丢弃这些字段。
 */
export const FLAT_FIELDS = [
  'alg',
  'key',
  'keyEncoding',
  'iv',
  'ivEncoding',
  'aead',
  'cipherEncoding',
  'autoPadding',
] as const

export function flatFieldsPresent(o: Record<string, unknown>): string[] {
  return FLAT_FIELDS.filter((k) => o[k] !== undefined)
}
