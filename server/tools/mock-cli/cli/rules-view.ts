import { arrLen, b, n, obj, s } from './guards.ts'

/**
 * 规则的**列表视图**：只取展示与筛选要的字段，**绝不含 body**。
 *
 * 放在 `api` 与 `group` 之外的独立文件里，是因为 C14 之后两个命令都要渲染规则：
 * `api list` 只看得到我自己的私有规则，而共享项目的规则要走 `GET /groups/:id/rules`
 * （`group rules` / `group history` 的统计都要用它）。两处各写一份「怎么把一条 Rule 读成一行」
 * 就是两份真相，下标与字段口径迟早漂移（AGENTS.md §5）。
 */
export interface RuleView {
  id: string
  name: string | null
  enabled: boolean | null
  priority: number | null
  method: string | null
  host: string | null
  path: string | null
  params: number
  type: string | null
  mode: string | null
  seqMode: string | null
  /** `responses` 条数；旧形态（只有 `action.response`）记为 1 */
  responses: number
  pinIndex: number | null
  delayMs: number | null
  /** 所属**项目** id（C14：容器就是 `Group`，文档与控制台称「项目」）；无归属为 null */
  groupId: string | null
}

/** 规则条目本身可能是脏的（`rules.json` 手改过：数字 / null / 数组）→ 没有字符串 id 就当不存在 */
export function ruleView(raw: Record<string, unknown>): RuleView | null {
  const id = s(raw, 'id')
  if (!id) return null
  const match = obj(raw, 'match')
  const action = obj(raw, 'action')
  const count = arrLen(action?.responses)
  const legacy = !!action && action.response !== undefined && action.response !== null
  return {
    id,
    name: s(raw, 'name'),
    enabled: b(raw, 'enabled'),
    priority: n(raw, 'priority'),
    method: s(match, 'method'),
    host: s(match, 'host'),
    path: s(match, 'path'),
    params: Object.keys(obj(match, 'params') ?? {}).length,
    type: s(action, 'type'),
    mode: s(action, 'mode'),
    seqMode: s(action, 'seqMode'),
    responses: count || (legacy ? 1 : 0),
    pinIndex: n(action, 'pinIndex'),
    delayMs: n(action, 'delayMs'),
    groupId: s(raw, 'groupId'),
  }
}

export function matchLine(v: RuleView): string {
  const parts = [v.method ?? 'ANY', v.host ?? '任意域名', v.path ?? '任意路径']
  if (v.params) parts.push(`${v.params} 个入参`)
  return parts.join(' · ')
}

export function hitLine(v: RuleView): string {
  if (v.mode === 'sequence') return `顺序(${v.seqMode ?? 'in-order'})`
  if (v.mode === 'specific') return `指定第 ${v.pinIndex ?? 0} 条`
  return '固定'
}

/** 规则清单 → 视图 + 如实计数（结构不合法的条目丢掉但计数，不静默少几条） */
export function ruleViews(items: Record<string, unknown>[]): { views: RuleView[]; dropped: number } {
  const views: RuleView[] = []
  let dropped = 0
  for (const item of items) {
    const v = ruleView(item)
    if (v) views.push(v)
    else dropped++
  }
  return { views, dropped }
}
