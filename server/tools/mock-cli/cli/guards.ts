import { CliError, EXIT } from './errors.ts'

/**
 * 读路径防御。
 *
 * 存在的理由（AGENTS.md §4）：**管理面下发的东西也可能是坏的**。
 * `rules.json` 可以被手改坏（`RuleEngine.load()` 只要求「是数组」，条目是不是对象不管），
 * 记录里有 `request.url` 缺失的条目，设备表里可能没有 `deviceId`。
 * CLI 一旦在这些地方 `.map` / `.trim`，agent 拿到的就是一坨栈而不是可解析的错误。
 *
 * 统一口径：**结构错了就报错（EC_BAD_RESPONSE），条目脏就丢掉并计数**，
 * 计数如实回传给调用方——不静默少几条，那会让「列表里有 8 条」变成「看起来 8 条」。
 */
export interface ListRead {
  items: Record<string, unknown>[]
  dropped: number
}

export function expectList(payload: unknown, what: string): ListRead {
  if (!Array.isArray(payload)) {
    throw new CliError(
      'EC_BAD_RESPONSE',
      `${what} 返回的不是数组（收到 ${payload === null ? 'null' : Array.isArray(payload) ? '数组' : typeof payload}）`,
      '确认 baseUrl 指向 EasyCharles 服务，且服务端版本包含该接口',
      EXIT.SERVER,
    )
  }
  const items: Record<string, unknown>[] = []
  let dropped = 0
  for (const raw of payload) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) items.push(raw as Record<string, unknown>)
    else dropped++
  }
  return { items, dropped }
}

export function s(o: Record<string, unknown> | null | undefined, key: string): string | null {
  const v = o?.[key]
  return typeof v === 'string' ? v : null
}

export function n(o: Record<string, unknown> | null | undefined, key: string): number | null {
  const v = o?.[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** 只有真布尔才算布尔：`enabled: 1` / `"true"` 一律 null，不参与筛选 */
export function b(o: Record<string, unknown> | null | undefined, key: string): boolean | null {
  const v = o?.[key]
  return typeof v === 'boolean' ? v : null
}

export function obj(o: Record<string, unknown> | null | undefined, key: string): Record<string, unknown> | null {
  const v = o?.[key]
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

export function arrLen(v: unknown): number {
  return Array.isArray(v) ? v.length : 0
}

/** 时间戳脏值（字符串 / NaN / 负数）一律当「没有」，不显示 1970 */
export function fmtTime(ts: unknown): string {
  const v = typeof ts === 'number' && Number.isFinite(ts) && ts > 0 ? ts : null
  if (v === null) return '-'
  const d = new Date(v)
  const p = (x: number): string => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** `http(s)://host:port/path?a=b` → `{host, path}`；解析失败退回原文，不抛错 */
export function splitUrl(url: string | null): { host: string; path: string } {
  if (!url) return { host: '-', path: '-' }
  try {
    const u = new URL(url)
    return { host: u.host, path: `${u.pathname}${u.search}` }
  } catch {
    return { host: '-', path: url }
  }
}
