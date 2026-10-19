import { flagBool, flagStr, parseArgs, rejectExtraPositionals, requirePositional } from '../args.ts'
import type { FlagSpec, Parsed } from '../args.ts'
import {
  CliError,
  EXIT,
  notImplemented,
  notFoundError,
  projectReadonlyError,
  scopeMismatchError,
  usageError,
  verifyError,
} from '../errors.ts'
import type { ConfigStore } from '../config.ts'
import type { ManagementClient } from '../client.ts'
import { b, expectList, fmtTime, n, obj, s } from '../guards.ts'
import type { ListRead } from '../guards.ts'
import { cell, confirmOrDie, emit, info, modeOf, table } from '../output.ts'
import type { Mode } from '../output.ts'
import { hitLine, matchLine, ruleViews } from '../rules-view.ts'
import type { RuleView } from '../rules-view.ts'
import { clientFor, projectOf } from './auth.ts'

/**
 * `group` = **Mock 项目**（协议的 `Group`），不是租户。
 *
 * C13 时它只是一个容器；C14 / ADR-033 给它加了**归属**，于是同一个实体分成两档：
 * - `private`：属于一个手机号空间，**只有这一档参与命中**；
 * - `shared`：本实例所有登录用户可读的**只读模板**，**永不直接命中**，要用必须先 `copy`。
 *
 * 命中口径是一条 AND（协议 §5.4）：
 * `规则 enabled` 且 `项目存在` 且 `项目是 private` 且 `项目 enabled` 且 `项目 owner == 设备归属手机号`。
 * 关项目**不改写**组内规则的 `enabled`，重开即恢复原状。
 *
 * 与 `api` 的分工：`api list` 只看得到我自己的私有规则（服务端按会话过滤），
 * 共享项目的内容要靠这里的 `group rules` / `group history` 读——**这不是偷懒，是权限矩阵**：
 * 把共享内容混进 `api list` 会让人以为「这些也在生效」。
 *
 * 写操作一律「提交 → 独立读回 → 逐字段比对」，与 `api.ts` 同一套纪律。
 * `copy / share / rollback` 三笔额外核对**服务端回传的版本号与时间**：
 * 分享时间必须由服务端产生，客户端自造就等于历史里多一条不存在的分享（ADR-033 决策 4）。
 */

const LIST_FLAGS: FlagSpec = { enabled: 'string', q: 'string', scope: 'string' }
const GET_FLAGS: FlagSpec = {}
const CREATE_FLAGS: FlagSpec = { name: 'string', on: 'bool', off: 'bool' }
const UPDATE_FLAGS: FlagSpec = { name: 'string', on: 'bool', off: 'bool' }
const SWITCH_FLAGS: FlagSpec = { on: 'bool', off: 'bool' }
const DELETE_FLAGS: FlagSpec = {}
const RULES_FLAGS: FlagSpec = {}
const COPY_FLAGS: FlagSpec = { 'operation-id': 'string' }
const SHARE_FLAGS: FlagSpec = { 'operation-id': 'string', 'expected-version': 'string' }
const HISTORY_FLAGS: FlagSpec = {}
const ROLLBACK_FLAGS: FlagSpec = { version: 'string', 'operation-id': 'string' }
const ARCHIVE_FLAGS: FlagSpec = { off: 'bool' }
// 恢复（撤销待删除）没有参数：它只有一种含义——把 purgeAt 清掉。别加 --force 之类的「绕过」
const RESTORE_FLAGS: FlagSpec = {}

/** 项目视图（`ruleCount` 由服务端在列表与详情里附带，协议 §4.7） */
export interface GroupView {
  id: string
  name: string
  enabled: boolean | null
  ruleCount: number | null
  createdAt: number | null
  updatedAt: number | null
  /**
   * 归属档位。**读路径按协议 §5.5 的口径折算**：字段缺失或不是这两个字符串之一 → `shared`。
   * 与后端同源：宁可让这一条不参与命中，也不要因为一个脏值把别人的私有内容放进候选集。
   */
  scope: 'private' | 'shared'
  /** private 的归属手机号；shared 与脏值为 null */
  ownerPhone: string | null
  /** 发布人（服务端已按「非本人即脱敏」处理）；迁移来的历史项目为 null */
  createdBy: string | null
  archived: boolean
  /** 仅 shared：当前内容对应的历史版本 */
  currentVersionId: string | null
  /** 仅 private：来源共享项目（copy 得到的副本、以及首次 share 之后的原件都有） */
  originSharedProjectId: string | null
  /** 仅 private：这份副本复制自共享项目的**哪一个版本**（服务端记的，客户端不可写） */
  copiedFromVersionId: string | null
  /** 仅 shared：软删除（待删除）的发起时间（ADR-037）；null = 不在待删除 */
  pendingDeleteAt: number | null
  /** 仅 shared：真正删除的时刻（pendingDeleteAt + 7 天）；null = 不在待删除 */
  purgeAt: number | null
}

export interface GroupTable {
  views: GroupView[]
  dropped: number
  /** 服务端没有项目端点（老版本）时的说明；null = 读成功 */
  error: string | null
}

function scopeOf(raw: Record<string, unknown>): 'private' | 'shared' {
  return raw.scope === 'private' ? 'private' : 'shared'
}

function groupView(raw: Record<string, unknown>): GroupView | null {
  const id = s(raw, 'id')
  if (!id) return null
  return {
    id,
    name: s(raw, 'name') ?? '',
    enabled: b(raw, 'enabled'),
    ruleCount: n(raw, 'ruleCount'),
    createdAt: n(raw, 'createdAt'),
    updatedAt: n(raw, 'updatedAt'),
    scope: scopeOf(raw),
    ownerPhone: s(raw, 'ownerPhone'),
    createdBy: s(raw, 'createdBy'),
    archived: b(raw, 'archived') === true,
    currentVersionId: s(raw, 'currentVersionId'),
    originSharedProjectId: s(raw, 'originSharedProjectId'),
    copiedFromVersionId: s(raw, 'copiedFromVersionId'),
    pendingDeleteAt: n(raw, 'pendingDeleteAt'),
    purgeAt: n(raw, 'purgeAt'),
  }
}

/**
 * 读项目表。
 *
 * `tolerateMissing` 只吞「这个端点不存在」一类错误（老服务端 404 / 返回 HTML），
 * **连不上与未登录必须照抛**——否则 `mock api list` 会在服务挂着的时候装作「没有项目」，
 * 把「连不上」伪装成「一切正常」（AGENTS.md §9 不许这样）。
 */
export async function readGroups(client: ManagementClient, opts: { tolerateMissing?: boolean } = {}): Promise<GroupTable> {
  let read: ListRead
  try {
    read = expectList(await client.call('GET', '/__ec/api/groups'), 'GET /__ec/api/groups')
  } catch (e) {
    const code = e instanceof CliError ? e.code : ''
    const missing = code === 'EC_NOT_FOUND' || code === 'EC_HTTP_404' || code === 'EC_HTTP_405' || code === 'EC_BAD_RESPONSE'
    if (opts.tolerateMissing && missing) {
      return { views: [], dropped: 0, error: `服务端没有项目端点（${code}）：项目归属无法核对` }
    }
    throw e
  }
  const views: GroupView[] = []
  let dropped = read.dropped
  for (const item of read.items) {
    const v = groupView(item)
    if (v) views.push(v)
    else dropped++
  }
  return { views, dropped, error: null }
}

/** 我写得动的项目 = `scope === 'private'`。shared 在这一层就被挡掉，不等服务端 409 */
export function isWritableProject(g: GroupView | null | undefined): boolean {
  return !!g && g.scope === 'private'
}

export function privateProjects(table: GroupTable): GroupView[] {
  return table.views.filter((g) => g.scope === 'private')
}

/** 只认 true / false，与 `api list --enabled` 同口径：`1` / `yes` 一律拒绝 */
function readEnabledFlag(p: Parsed): boolean | null {
  const raw = flagStr(p, 'enabled')
  if (raw === null) return null
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw usageError(`--enabled 只接受 true / false（收到 ${JSON.stringify(raw)}）`, '开关字段不做宽松强转：1 / yes / on 一律拒绝')
}

/** `--scope` 只接受这两个值：写错值时**不能**当成「不过滤」，那会把全部项目当成筛选结果 */
function readScopeFlag(p: Parsed): string | null {
  const raw = flagStr(p, 'scope')
  if (raw === null) return null
  if (raw === 'private' || raw === 'shared' || raw === 'all') return raw
  throw usageError(`--scope 只接受 private / shared / all（收到 ${JSON.stringify(raw)}）`, '归属档位是这两个字符串之一，不做大小写与别名的宽松匹配')
}

/**
 * `--on` / `--off` 转成**必须显式的布尔**。
 *
 * 新建时缺省给 `true`：服务端要求 body 里必须有布尔（ADR-030），所以 CLI 必须写一个；
 * 选「开」而不是「关」是因为「建了项目却一条都不命中」是新项目最不该有的默认表现。
 * 两个都给仍然报错——猜错方向比报错贵得多。
 */
function enabledForWrite(p: Parsed, fallback: boolean, verb: string): boolean {
  const on = flagBool(p, 'on')
  const off = flagBool(p, 'off')
  if (on && off) throw usageError(`${verb}：--on 与 --off 不能同时给`, null)
  if (on) return true
  if (off) return false
  return fallback
}

function groupLabel(g: GroupView): string {
  return g.name ? `${g.id}（${g.name}）` : g.id
}

/** 名字要 trim 后再提交：服务端会 trim，比对时「期望 ' 登录 '、读到 '登录'」是假阳性 */
function nameFromFlags(p: Parsed, verb: string): string | null {
  const raw = flagStr(p, 'name')
  if (raw === null) return null
  const trimmed = raw.trim()
  if (!trimmed) {
    throw usageError(`${verb}：--name 不能是空串或纯空白`, '项目名服务端要求非空；换名字前先 mock group list 看现有的')
  }
  return trimmed
}

/**
 * `operationId`：一笔**有副作用**的动作一个 id，超时重发要复用同一个（服务端靠它做幂等回执，
 * 协议 §4.7「幂等是硬要求」）。不给就现生成一个——生成新的**不会**重复生成版本，
 * 只有「同一笔重发」需要人工带上 `--operation-id` 才谈得上幂等。
 */
function operationIdFor(p: Parsed, kind: string): string {
  const raw = flagStr(p, 'operation-id')
  if (raw === null) return `cli_${kind}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  const trimmed = raw.trim()
  if (!trimmed) {
    throw usageError('--operation-id 不能是空串或纯空白', '它是幂等键：重发同一笔动作时复用同一个值；要新开一笔就别带这个参数')
  }
  return trimmed
}

/** 人类模式的一行归属说明：把「这一档会不会命中」写在第一眼能看到的地方 */
function scopeCell(g: GroupView): string {
  if (g.scope === 'shared') return g.archived ? '共享·归档' : '共享'
  return '私有'
}

function enabledCell(g: GroupView): string {
  // 共享项目不参与命中，它的 enabled 是个不被读取的字段（协议 §4.7：给它开关就是造死字段）
  if (g.scope === 'shared') return '不命中(共享)'
  return g.enabled === null ? '?' : g.enabled ? '开' : '关'
}

function ownerCell(g: GroupView): string {
  if (g.scope === 'private') return g.ownerPhone ?? '-'
  return g.createdBy ?? '未知(历史项目)'
}

function renderGroups(views: GroupView[], defaultGroupId: string | null, dropped: number, filtered: boolean, total: number): void {
  if (!views.length) {
    const scope = filtered ? `（筛选后 0 个，服务端共 ${total} 个）` : `（服务端还没有项目）`
    process.stdout.write(`没有项目${scope}；用 mock group create --name <名字> --on 建第一个私有项目\n`)
    info('提示：只有**私有**项目参与命中；共享项目先 mock group copy <共享项目id> 复制到私有区（协议 §5.4）')
  } else {
    process.stdout.write(
      table(
        ['', 'id', '名字', '归属', '开关', '规则数', '归属人/发布人'],
        views.map((v) => [
          v.id === defaultGroupId ? '*' : '',
          v.id,
          v.name || '-',
          scopeCell(v),
          enabledCell(v),
          v.ruleCount === null ? '-' : String(v.ruleCount),
          ownerCell(v),
        ]),
      ) + '\n',
    )
    const sharedCount = views.filter((v) => v.scope === 'shared').length
    if (sharedCount) info(`提示：${sharedCount} 个共享项目**永不直接命中**，要用先 mock group copy <id>（复制到我的私有区）`)
  }
  if (dropped) info(`注意：有 ${dropped} 个项目条目结构不合法（缺 id / 非对象），已跳过。`)
  info('* = mock set group 记下的本地默认项目。命令**不会**自动按它过滤，写入时会用它作缺省归属')
}

async function groupList(client: ManagementClient, p: Parsed, mode: Mode, store: ConfigStore): Promise<number> {
  const table0 = await readGroups(client)
  const enabled = readEnabledFlag(p)
  const scope = readScopeFlag(p)
  const q = flagStr(p, 'q')
  const needle = q ? q.toLowerCase() : null
  const filtered = table0.views.filter((v) => {
    if (scope && scope !== 'all' && v.scope !== scope) return false
    // 共享项目没有「参与命中的开关」，按 --enabled 筛它等于筛一个不被读取的字段
    if (enabled !== null && (v.scope !== 'private' || v.enabled !== enabled)) return false
    if (needle && !`${v.id} ${v.name}`.toLowerCase().includes(needle)) return false
    return true
  })
  const anyFilter = enabled !== null || needle !== null || scope !== null
  emit(
    {
      ok: true,
      count: filtered.length,
      total: table0.views.length,
      dropped: table0.dropped,
      filtered: anyFilter,
      // 过滤在 CLI 侧做（管理面列表本来就只回我看得见的那些），如实标出来
      filteredBy: anyFilter ? { enabled, q, scope } : null,
      privateCount: table0.views.filter((v) => v.scope === 'private').length,
      sharedCount: table0.views.filter((v) => v.scope === 'shared').length,
      defaultGroup: store.data.defaults.group,
      note: table0.error,
      groups: filtered,
    },
    mode,
    () => renderGroups(filtered, store.data.defaults.group, table0.dropped, anyFilter, table0.views.length),
  )
  return EXIT.OK
}

async function groupCreate(client: ManagementClient, p: Parsed, mode: Mode): Promise<number> {
  const name = nameFromFlags(p, 'group create')
  if (name === null) {
    throw usageError('group create 缺少 --name', '如 mock group create --name 登录模块 --on --json')
  }
  const enabled = enabledForWrite(p, true, 'group create')
  // body 只带 name / enabled：scope / ownerPhone / createdBy / archived / 时间戳都是服务端管的，
  // 带上会被服务端 400 EC_SCOPE_MISMATCH（不是静默丢弃），CLI 从一开始就不写这些字段
  const body = { group: { name, enabled } }

  const res = await client.call('POST', '/__ec/api/groups', { body })
  const created = groupView(obj(res as Record<string, unknown>, 'group') ?? {})
  const id = created?.id ?? ''
  if (!id) throw verifyError('新建后服务端没返回项目 id', '跑 mock group list --json 看服务端实际建了什么')

  const after = await readGroups(client)
  const got = after.views.find((g) => g.id === id) ?? null
  if (!got) throw verifyError(`新建项目后读不回来：${id}`, '项目可能被另一台控制台删了；先 mock group list 确认')
  const diffs: string[] = []
  if (got.name !== name) diffs.push(`name：期望 ${JSON.stringify(name)}，读到 ${JSON.stringify(got.name)}`)
  if (got.enabled !== enabled) diffs.push(`enabled：期望 ${enabled}，读到 ${JSON.stringify(got.enabled)}`)
  if (got.scope !== 'private') diffs.push(`scope：新建只可能是 private，读到 ${JSON.stringify(got.scope)}`)
  if (diffs.length) throw verifyError(`提交后读回不一致（项目 ${id}）：${diffs.join('；')}`, '先 mock group list --json 看服务端存的是什么')

  emit({ ok: true, id, group: got, verified: true }, mode, () =>
    info(`已新建私有项目 ${id}（${name}，${enabled ? '开' : '关'}），已读回确认；挂规则用 mock api create --group-id ${id}`),
  )
  return EXIT.OK
}

async function groupUpdate(client: ManagementClient, p: Parsed, mode: Mode): Promise<number> {
  const id = requirePositional(p, 0, '项目 id', 'mock group update g_login --name 登录模块 --json')
  const before = await readGroups(client)
  const current = before.views.find((g) => g.id === id)
  if (!current) {
    throw notFoundError(`没有这个项目：${id}`, `服务端共 ${before.views.length} 个；可用：${before.views.map((g) => g.id).join(', ') || '（空）'}`)
  }
  // 共享项目改不了（改名 / 改开关都是 409）：本地先拦，比等服务端报错再解释「只能 copy→改→share」省事
  if (current.scope === 'shared') {
    throw projectReadonlyError(
      `${id} 是共享项目，不能直接改（改名与开关都走不通）`,
      `共享内容只能整项目覆盖：mock group copy ${id} 复制到私有区 → 改 → mock group share <私有项目id>`,
    )
  }
  const name = nameFromFlags(p, 'group update')
  const changesEnabled = flagBool(p, 'on') || flagBool(p, 'off')
  if (name === null && !changesEnabled) {
    // 「一次写入都没有」却返回成功，是最难复查的假动作
    throw usageError('group update 没有要改的东西', '改名 --name <新名>；整组开关用 mock group switch（要显式 --on / --off）')
  }
  const enabled = enabledForWrite(p, current.enabled === true, 'group update')

  // PUT 是整条替换，但时间戳是服务端管的（协议 §4.7）：createdAt 服务端恒保留原值，
  // updatedAt 由服务端覆盖——客户端写上去就是 400（黑名单字段），所以 body 里根本不带
  const next: Record<string, unknown> = { id, name: name ?? current.name, enabled }

  await client.call('PUT', `/__ec/api/groups/${encodeURIComponent(id)}`, { body: { group: next } })

  const after = await readGroups(client)
  const got = after.views.find((g) => g.id === id) ?? null
  if (!got) throw verifyError(`更新后项目消失了：${id}`, '可能刚被另一台控制台删除；先 mock group list 确认')
  const diffs: string[] = []
  if (got.name !== next.name) diffs.push(`name：期望 ${JSON.stringify(next.name)}，读到 ${JSON.stringify(got.name)}`)
  if (got.enabled !== enabled) diffs.push(`enabled：期望 ${enabled}，读到 ${JSON.stringify(got.enabled)}`)
  if (got.scope !== 'private') diffs.push(`scope：PUT 改不了归属，读到 ${JSON.stringify(got.scope)}`)
  if (current.createdAt !== null && got.createdAt !== current.createdAt) {
    diffs.push(`createdAt：期望保留 ${current.createdAt}，读到 ${JSON.stringify(got.createdAt)}`)
  }
  if (diffs.length) throw verifyError(`提交后读回不一致（项目 ${id}）：${diffs.join('；')}`, '先 mock group list --json 看服务端存的是什么')

  emit({ ok: true, id, group: got, renamed: name !== null, enabledChanged: changesEnabled, verified: true }, mode, () => {
    info(`已更新私有项目 ${id}（${got.name}，${got.enabled === null ? '?' : got.enabled ? '开' : '关'}），已读回确认`)
    if (got.ruleCount) info(`提示：组内 ${got.ruleCount} 条规则的 enabled 未被改写，改的只是项目开关`)
  })
  return EXIT.OK
}

async function groupSwitch(client: ManagementClient, p: Parsed, mode: Mode): Promise<number> {
  const id = requirePositional(p, 0, '项目 id', 'mock group switch g_login --off --json')
  const on = flagBool(p, 'on')
  const off = flagBool(p, 'off')
  if (on === off) {
    throw usageError(
      'group switch 要且只要一个开关',
      '开：--on；关：--off。刻意不给默认值——猜错方向就是整组接口该 mock 时打真实服务器（或反过来）。',
    )
  }
  const enabled = on

  const before = await readGroups(client)
  const target = before.views.find((g) => g.id === id)
  if (!target) {
    throw notFoundError(`没有这个项目：${id}`, `服务端共 ${before.views.length} 个；可用：${before.views.map((g) => g.id).join(', ') || '（空）'}`)
  }
  if (target.scope === 'shared') {
    throw projectReadonlyError(
      `${id} 是共享项目，没有开关可切（它不参与命中，给它开关就是造一个永远不被读取的字段）`,
      '要停用共享内容：mock group archive ' + id + ' 归档；要改内容：copy 到私有区改完再 share',
    )
  }

  const res = (await client.call('POST', `/__ec/api/groups/${encodeURIComponent(id)}/enabled`, { body: { enabled } })) as Record<
    string,
    unknown
  > | null
  // affected 必须回：空项目和「组里 20 条都被挡掉」在 ok:true 里长得一模一样
  const affected = n(res, 'affected')

  const after = await readGroups(client)
  const now = after.views.find((g) => g.id === id)
  if (!now || now.enabled !== enabled) {
    throw verifyError(
      `开关提交后读回不一致：期望 enabled=${enabled}，读到 ${JSON.stringify(now?.enabled)}`,
      now ? '项目表可能刚被另一台控制台覆盖；确认后再试' : '项目在开关过程中消失了',
    )
  }
  emit(
    {
      ok: true,
      id,
      enabled,
      previous: target.enabled,
      affected,
      ruleCount: now.ruleCount,
      group: now,
      verified: true,
    },
    mode,
    () => {
      const count = now.ruleCount ?? affected ?? 0
      info(
        `私有项目 ${id}（${now.name}）已${enabled ? '开' : '关'}（原来是 ${target.enabled === null ? '未知' : target.enabled ? '开' : '关'}），` +
          `组内 ${count} 条规则，已读回确认`,
      )
      if (!enabled && count) info('提示：关项目**没有**改写这些规则自己的 enabled，重开即恢复；抓包序列指针也不重置')
    },
  )
  return EXIT.OK
}

/**
 * 数一下服务端还有多少条我的规则挂着这个项目 id。
 *
 * 删私有项目的真正不变式是「项目没了、我这边也没有规则继续引用它」。
 * 规则端点读不到时返回 null（不谎报成 0）。
 */
async function countMyRulesInProject(client: ManagementClient, id: string): Promise<number | null> {
  try {
    const read = expectList(await client.call('GET', '/__ec/api/rules'), 'GET /__ec/api/rules')
    return read.items.filter((r) => s(r, 'groupId') === id).length
  } catch {
    return null
  }
}

async function groupDelete(client: ManagementClient, p: Parsed, mode: Mode): Promise<number> {
  const id = requirePositional(p, 0, '项目 id', 'mock group delete g_login --yes --json')
  const before = await readGroups(client)
  const target = before.views.find((g) => g.id === id)
  if (!target) {
    throw notFoundError(`没有这个项目：${id}`, `服务端共 ${before.views.length} 个；可用：${before.views.map((g) => g.id).join(', ') || '（空）'}`)
  }
  const inGroup = target.ruleCount ?? null
  const countText = inGroup === null ? '若干' : inGroup
  if (target.scope === 'shared') {
    await confirmOrDie(
      p,
      `删除共享项目 ${groupLabel(target)}：服务端**不会立刻删**（ADR-037）——先进入 7 天待删除状态，` +
        `组内 ${countText} 条规则与全部历史版本原样保留，期间任何人可 mock group restore ${id} 恢复；` +
        `到期无人恢复才真正删掉`,
    )
  } else {
    await confirmOrDie(
      p,
      `删除私有项目 ${groupLabel(target)}；组内 ${countText} 条规则**会一起删掉**` +
        `（C14 的级联：脱组等于让规则失去归属 = 永不命中，所以不再保留）`,
    )
  }

  const res = (await client.call('DELETE', `/__ec/api/groups/${encodeURIComponent(id)}`)) as Record<string, unknown> | null
  const removedRules = n(res, 'removedRules')
  const pendingDelete = res ? res.pendingDelete === true : false
  const purgeAt = n(res, 'purgeAt')

  const after = await readGroups(client)
  const afterTarget = after.views.find((g) => g.id === id) ?? null
  if (target.scope === 'private') {
    if (afterTarget) {
      throw verifyError(`删除后仍能读到项目 ${id}`, '服务端可能刚被另一台控制台重建；确认后再删')
    }
  } else {
    // 软删除（ADR-037）：项目**必须还在**，而且带 purgeAt。立刻消失说明有东西在物理删项目
    if (!afterTarget) {
      throw verifyError(
        `共享项目 ${id} 删除后立刻读不到了`,
        '按 ADR-037 这里应当只打待删除标记（7 天内可 restore）；立刻消失说明服务端在物理删项目，先查服务端版本',
      )
    }
    if (afterTarget.purgeAt === null) {
      throw verifyError(`共享项目 ${id} 读回了，但没有 purgeAt（待删除标记没落盘）`, '先 mock group get ' + id + ' --json 看服务端存的是什么')
    }
  }
  const still = target.scope === 'private' ? await countMyRulesInProject(client, id) : null
  if (still !== null && still > 0) {
    throw verifyError(
      `项目 ${id} 已删，但我这边仍有 ${still} 条规则的 groupId 指向它`,
      '无归属 / 悬空归属的规则**永不命中**（C14 翻转，不再按未分组放行）；先 mock api list 看这些条目，逐条删除或改挂到别的项目',
    )
  }
  const note =
    target.scope === 'private' && inGroup !== null && removedRules !== null && inGroup !== removedRules
      ? `级联删除 ${removedRules} 条与删除前统计的 ${inGroup} 条不一致：这期间有别的客户端改过规则表`
      : null
  const daysLeft = purgeAt === null ? null : Math.max(0, Math.ceil((purgeAt - Date.now()) / 86400000))
  emit(
    {
      ok: true, id, scope: target.scope,
      removed: target.scope === 'private',
      pendingDelete,
      purgeAt,
      daysLeft,
      removedRules,
      rulesStillReferencing: still,
      remainingGroups: after.views.length,
      note,
    },
    mode,
    () => {
      if (target.scope === 'private') {
        info(`已删除私有项目 ${id}，${removedRules ?? '?'} 条规则一并删除（级联），已读回确认`)
      } else {
        info(
          `共享项目 ${id} 已进入待删除：还剩 ${daysLeft ?? '?'} 天（${purgeAt === null ? '到期时间未知' : new Date(purgeAt).toLocaleString()}），` +
            `组内 ${countText} 条规则与历史版本都还在，已读回确认`,
        )
        info(`要撤销：mock group restore ${id}；到期无人恢复，服务端会自己真删（项目 + 规则 + 历史快照）`)
      }
      if (note) info(`注意：${note}`)
      if (still === null && target.scope === 'private') info('注意：规则表读不到，没能核对「没有规则继续引用它」这一条')
    },
  )
  return EXIT.OK
}

// ────────────────────────────────────────────────
// 按项目读规则（shared 的唯一读入口）
// ────────────────────────────────────────────────

async function readProjectRules(client: ManagementClient, id: string): Promise<{ views: RuleView[]; dropped: number }> {
  const read = expectList(await client.call('GET', `/__ec/api/groups/${encodeURIComponent(id)}/rules`), `GET /groups/${id}/rules`)
  return ruleViews(read.items)
}

function renderProjectRules(views: RuleView[], dropped: number, group: GroupView): void {
  if (!views.length) {
    process.stdout.write(`项目 ${group.id}（${group.name}）里没有规则\n`)
    if (group.scope === 'shared') info('提示：共享项目本来就不命中；要用先 mock group copy ' + group.id)
  } else {
    process.stdout.write(
      table(
        ['规则 id', 'on', '返回值', '命中方式', '匹配'],
        views.map((v) => [v.id, v.enabled === null ? '?' : v.enabled ? '✓' : '✗', String(v.responses), hitLine(v), matchLine(v)]),
      ) + '\n',
    )
    if (group.scope === 'shared') {
      info('注意：上面这些是**共享模板**里的规则，永不直接命中；要用请 mock group copy ' + group.id + ' 复制到私有区')
    } else if (group.enabled === false) {
      info(`注意：这个私有项目是关的，上面 ${views.length} 条规则**当前都不命中**（重开：mock group switch ${group.id} --on）`)
    }
  }
  if (dropped) info(`注意：有 ${dropped} 条条目结构不合法（缺 id / 非对象），已跳过。`)
}

async function groupRules(client: ManagementClient, p: Parsed, mode: Mode): Promise<number> {
  const id = requirePositional(p, 0, '项目 id', 'mock group rules g_login --json')
  const groups = await readGroups(client)
  const group = groups.views.find((g) => g.id === id)
  if (!group) {
    throw notFoundError(`没有这个项目：${id}`, `服务端共 ${groups.views.length} 个；可用：${groups.views.map((g) => g.id).join(', ') || '（空）'}`)
  }
  const { views, dropped } = await readProjectRules(client, id)
  emit(
    {
      ok: true,
      id,
      scope: group.scope,
      project: group,
      count: views.length,
      dropped,
      // shared 走的是只读模板；private 走的是我自己空间里真正参与命中的那批
      hits: group.scope === 'private' && group.enabled !== false,
      rules: views,
    },
    mode,
    () => renderProjectRules(views, dropped, group),
  )
  return EXIT.OK
}

// ────────────────────────────────────────────────
// copy / share / history / rollback / archive
// ────────────────────────────────────────────────

/**
 * 覆盖差分：把「我这份私有项目 share 上去之后，共享库会怎么变」摊开给人看。
 *
 * 依据是私有项目身上的 `lineage`（共享规则 id ⇄ 本地规则 id 的稳定映射，协议 §5.5）。
 * 这个数**只用于确认框**，不做冲突检测——C14 明确不做三方合并。
 */
export function shareDiff(
  privateRules: RuleView[],
  lineage: { sharedRuleId: string; privateRuleId: string }[],
  oldSharedRuleIds: string[],
): { added: number; removed: number; kept: number; willTotal: number; hadTotal: number } {
  const oldIds = new Set(oldSharedRuleIds)
  const mine = new Set(privateRules.map((r) => r.id))
  const keptSharedIds = new Set<string>()
  for (const entry of lineage) {
    if (!entry || typeof entry.sharedRuleId !== 'string' || typeof entry.privateRuleId !== 'string') continue
    if (mine.has(entry.privateRuleId) && oldIds.has(entry.sharedRuleId)) keptSharedIds.add(entry.sharedRuleId)
  }
  return {
    added: privateRules.length - keptSharedIds.size,
    removed: oldIds.size - keptSharedIds.size,
    kept: keptSharedIds.size,
    willTotal: privateRules.length,
    hadTotal: oldIds.size,
  }
}

async function groupCopy(client: ManagementClient, p: Parsed, mode: Mode): Promise<number> {
  const id = requirePositional(p, 0, '共享项目 id', 'mock group copy g_shared_login --json')
  const groups = await readGroups(client)
  const source = groups.views.find((g) => g.id === id)
  if (!source) {
    throw notFoundError(`没有这个共享项目：${id}`, `服务端共 ${groups.views.length} 个（含共享与我的私有）；先 mock group list --scope shared`)
  }
  if (source.scope !== 'shared') {
    throw scopeMismatchError(
      `${id} 是我自己的私有项目，不是共享项目，copy 只接受共享项目`,
      '私有项目之间要复制单条规则用 mock api copy <规则id> --group-id <目标私有项目id>',
    )
  }
  const operationId = operationIdFor(p, 'copy')
  const before = await readProjectRules(client, id).catch(() => null)
  await confirmOrDie(p, `把共享项目 ${groupLabel(source)} 的 ${source.ruleCount ?? '?'} 条规则复制成我的私有项目（副本名 ${source.name}(副本)）`)

  const res = (await client.call('POST', `/__ec/api/groups/${encodeURIComponent(id)}/copy`, { body: { operationId } })) as Record<string, unknown> | null
  const created = groupView(obj(res as Record<string, unknown>, 'group') ?? {})
  const newId = created?.id ?? ''
  if (!newId) throw verifyError('复制后服务端没返回新私有项目 id', '跑 mock group list --json 看服务端实际建了什么')
  const replayed = b(res, 'replayed') === true
  const sourceVersionId = s(res, 'copiedFromVersionId')

  // 独立读回：列表里要有这个私有项目，归属对得上，规则条数与回执一致
  const after = await readGroups(client)
  const got = after.views.find((g) => g.id === newId) ?? null
  if (!got) throw verifyError(`复制后读不到新的私有项目 ${newId}`, '可能刚被删除；先 mock group list 确认')
  const rules = await readProjectRules(client, newId)
  const sharedRuleIds = new Set((before?.views ?? []).map((r) => r.id))
  const diffs: string[] = []
  if (got.scope !== 'private') diffs.push(`scope：副本应是 private，读到 ${JSON.stringify(got.scope)}`)
  if (got.name !== `${source.name}(副本)`) diffs.push(`name：期望 ${JSON.stringify(`${source.name}(副本)`)}，读到 ${JSON.stringify(got.name)}`)
  if (got.originSharedProjectId !== id) diffs.push(`originSharedProjectId：期望 ${id}，读到 ${JSON.stringify(got.originSharedProjectId)}`)
  if (got.ruleCount !== null && rules.views.length !== got.ruleCount) diffs.push(`规则数：详情 ${got.ruleCount}，实际 ${rules.views.length}`)
  if (sourceVersionId !== null && got.copiedFromVersionId !== sourceVersionId) {
    diffs.push(`copiedFromVersionId：回执 ${sourceVersionId}，项目里 ${JSON.stringify(got.copiedFromVersionId)}`)
  }
  // 副本必须换了一套本地 id：与共享 id 撞号的话，之后 share 会把两条不同规则映射到同一个共享 id
  const collided = rules.views.filter((r) => sharedRuleIds.has(r.id)).map((r) => r.id)
  if (collided.length) diffs.push(`副本规则 id 与共享源撞号：${collided.slice(0, 3).join(', ')}`)
  if (diffs.length) throw verifyError(`复制后读回不一致（副本 ${newId}）：${diffs.join('；')}`, '先 mock group rules ' + newId + ' --json 看服务端存的是什么')

  emit(
    {
      ok: true,
      id: newId,
      from: id,
      replayed,
      operationId,
      name: got.name,
      ruleCount: rules.views.length,
      copiedFromVersionId: sourceVersionId,
      project: got,
      rules: rules.views,
      verified: true,
    },
    mode,
    () => {
      info(
        `已复制共享项目 ${id} → 私有项目 ${newId}（${got.name}，${rules.views.length} 条规则，` +
          `源版本 ${sourceVersionId ?? '（该共享项目还没发布过版本）'}），已读回确认`,
      )
      if (replayed) info('注意：这笔 operationId 之前已经执行过，服务端回的是**首次那笔**的结果（幂等回执），没有复制第二份')
      info(`提示：副本在自己的私有区里改不会影响共享库；要参与命中还得确认项目是开的（mock group switch ${newId} --on）`)
    },
  )
  return EXIT.OK
}

async function groupShare(client: ManagementClient, p: Parsed, mode: Mode): Promise<number> {
  const id = requirePositional(p, 0, '私有项目 id', 'mock group share g_login --json')
  const groups = await readGroups(client)
  const source = groups.views.find((g) => g.id === id)
  if (!source) {
    throw notFoundError(`没有这个私有项目：${id}`, `服务端共 ${groups.views.length} 个；先 mock group list --scope private`)
  }
  if (source.scope !== 'private') {
    throw projectReadonlyError(
      `${id} 是共享项目，share 只接受我自己的私有项目`,
      '共享内容不能直接提交：mock group copy ' + id + ' 复制成私有 → 改 → 再 share',
    )
  }
  const operationId = operationIdFor(p, 'share')
  const expectedSharedVersionId = flagStr(p, 'expected-version')

  const mine = await readProjectRules(client, id)
  const originId = source.originSharedProjectId
  let diff: ReturnType<typeof shareDiff> | null = null
  let origin: GroupView | null = null
  if (originId) {
    origin = groups.views.find((g) => g.id === originId) ?? null
    const oldShared = await readProjectRules(client, originId).catch(() => null)
    const lineage = (await lineageOf(client, id)) ?? []
    diff = shareDiff(mine.views, lineage, (oldShared?.views ?? []).map((r) => r.id))
  }

  const head = origin
    ? `把私有项目 ${groupLabel(source)} 的 ${mine.views.length} 条规则**整项目覆盖**到共享项目 ${groupLabel(origin)}`
    : `把私有项目 ${groupLabel(source)} 首次发布成共享项目`
  const lines = diff
    ? [
        `接口数：新增 ${diff.added} / 删除 ${diff.removed} / 保留 ${diff.kept}（覆盖前 ${diff.hadTotal} 条 → 覆盖后 ${diff.willTotal} 条）`,
        origin?.currentVersionId ? `目标当前版本 ${origin.currentVersionId}${expectedSharedVersionId ? '' : '（未带 --expected-version：按你确认的内容直接覆盖）'}` : '目标还没有发布过版本',
      ]
    : []
  await confirmOrDie(p, [head, ...lines].join('；'))

  const body: Record<string, unknown> = { operationId }
  if (expectedSharedVersionId) body.expectedSharedVersionId = expectedSharedVersionId
  const res = (await client.call('POST', `/__ec/api/groups/${encodeURIComponent(id)}/share`, { body })) as Record<string, unknown> | null
  if (!res) throw verifyError('share 没有返回内容', '先 mock group list --json 看服务端存成了什么')
  const shared = groupView(obj(res, 'sharedProject') ?? {})
  const version = obj(res, 'version')
  const versionId = s(version, 'id') ?? ''
  const operation = s(version, 'operation')
  const serverCreatedAt = n(res, 'createdAt')
  const actor = s(res, 'actor')
  const replayed = b(res, 'replayed') === true
  const sharedId = shared?.id ?? ''
  if (!sharedId || !versionId) {
    throw verifyError('share 回执里缺共享项目 id 或版本 id', `服务端返回：${JSON.stringify(res).slice(0, 200)}`)
  }

  // 写后读回：**版本号、时间、操作人都以服务端回的那份为准**，CLI 不自造分享时间（ADR-033 决策 4）
  const afterGroups = await readGroups(client)
  const gotShared = afterGroups.views.find((g) => g.id === sharedId) ?? null
  const history = await readVersions(client, sharedId)
  const listed = history.find((v) => v.id === versionId) ?? null
  const privateAfter = afterGroups.views.find((g) => g.id === id) ?? null
  const rulesAfter = await readProjectRules(client, sharedId)
  const diffs: string[] = []
  if (!gotShared) diffs.push(`读不回共享项目 ${sharedId}`)
  else if (gotShared.scope !== 'shared') diffs.push(`scope：期望 shared，读到 ${JSON.stringify(gotShared.scope)}`)
  if (!listed) diffs.push(`历史里读不到回执版本 ${versionId}`)
  else {
    if (listed.ruleCount !== null && rulesAfter.views.length !== listed.ruleCount) {
      diffs.push(`规则数：历史记 ${listed.ruleCount}，共享项目里 ${rulesAfter.views.length}`)
    }
    // 时间必须与回执一致：两处不一致意味着历史与响应有一边是客户端自造的（ADR-033 决策 4）
    if (serverCreatedAt !== null && listed.createdAt !== serverCreatedAt) {
      diffs.push(`时间：回执 ${serverCreatedAt}，历史 ${listed.createdAt}`)
    }
  }
  if (gotShared && gotShared.currentVersionId !== versionId) {
    diffs.push(`currentVersionId：期望 ${versionId}，读到 ${JSON.stringify(gotShared.currentVersionId)}`)
  }
  if (!privateAfter) diffs.push(`私有原件 ${id} 分享后读不回来了（C14 要保留原件）`)
  else if (privateAfter.originSharedProjectId !== sharedId) {
    diffs.push(`私有原件的来源指针：期望 ${sharedId}，读到 ${JSON.stringify(privateAfter.originSharedProjectId)}`)
  }
  if (diffs.length) throw verifyError(`share 后读回不一致：${diffs.join('；')}`, `先 mock group history ${sharedId} --json 看服务端的历史`)

  emit(
    {
      ok: true,
      id,
      sharedProjectId: sharedId,
      versionId,
      operation,
      actor,
      createdAt: serverCreatedAt,
      replayed,
      operationId,
      firstPublish: origin === null,
      diff,
      sharedProject: gotShared,
      verified: true,
    },
    mode,
    () => {
      info(
        `已${origin ? '整项目覆盖' : '首次发布'}共享项目 ${sharedId}（${gotShared?.name ?? shared?.name ?? '-'}），` +
          `版本 ${versionId}${operation ? `（${operation}）` : ''}，` +
          `${actor ? `操作人 ${actor}，` : ''}服务端时间 ${fmtTime(serverCreatedAt)}，组内 ${rulesAfter.views.length} 条规则，已读回确认`,
      )
      if (replayed) info('注意：这笔 operationId 之前已经执行过，服务端回的是**首次那笔**的版本，没有生成第二个版本')
      if (diff) info(`提示：本次新增 ${diff.added} / 删除 ${diff.removed} / 保留 ${diff.kept}；共享内容对本实例所有登录用户可见`)
      info('注意：共享项目**永不直接命中**，别人要用得先 mock group copy ' + sharedId)
    },
  )
  return EXIT.OK
}

/** 私有项目的 lineage（共享 id ⇄ 本地 id）：详情端点回的是整个 group 对象，直接取 */
async function lineageOf(client: ManagementClient, privateId: string): Promise<{ sharedRuleId: string; privateRuleId: string }[] | null> {
  let detail: Record<string, unknown> | null = null
  try {
    detail = (await client.call('GET', `/__ec/api/groups/${encodeURIComponent(privateId)}`)) as Record<string, unknown>
  } catch {
    return null
  }
  const raw = detail?.lineage
  if (!Array.isArray(raw)) return []
  const out: { sharedRuleId: string; privateRuleId: string }[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const sharedRuleId = s(item as Record<string, unknown>, 'sharedRuleId')
    const privateRuleId = s(item as Record<string, unknown>, 'privateRuleId')
    if (sharedRuleId && privateRuleId) out.push({ sharedRuleId, privateRuleId })
  }
  return out
}

export interface VersionView {
  id: string
  projectId: string
  operation: string | null
  parentVersionId: string | null
  actorPhone: string | null
  createdAt: number | null
  ruleCount: number | null
  rollbackOf: string | null
}

function versionView(raw: Record<string, unknown>): VersionView | null {
  const id = s(raw, 'id')
  if (!id) return null
  return {
    id,
    projectId: s(raw, 'projectId') ?? '',
    operation: s(raw, 'operation'),
    parentVersionId: s(raw, 'parentVersionId'),
    actorPhone: s(raw, 'actorPhone'),
    createdAt: n(raw, 'createdAt'),
    ruleCount: n(raw, 'ruleCount'),
    rollbackOf: s(raw, 'rollbackOf'),
  }
}

/**
 * 历史列表。**只回元数据**：完整快照 body 不在这一层下发（协议 §4.7），
 * `snapshotFile` 是服务端内部路径，服务端已剔除，读到时也一律忽略（防御脏数据）。
 */
export async function readVersions(client: ManagementClient, sharedId: string): Promise<VersionView[]> {
  const read = expectList(
    await client.call('GET', `/__ec/api/groups/${encodeURIComponent(sharedId)}/versions`),
    `GET /groups/${sharedId}/versions`,
  )
  const out: VersionView[] = []
  for (const item of read.items) {
    const v = versionView(item)
    if (v) out.push(v)
  }
  return out
}

async function groupHistory(client: ManagementClient, p: Parsed, mode: Mode): Promise<number> {
  const id = requirePositional(p, 0, '共享项目 id', 'mock group history g_shared_login --json')
  const groups = await readGroups(client)
  const group = groups.views.find((g) => g.id === id)
  if (!group) {
    throw notFoundError(`没有这个项目：${id}`, `先 mock group list --scope shared 拿 id`)
  }
  const versions = await readVersions(client, id)
  emit(
    {
      ok: true,
      id,
      scope: group.scope,
      project: group,
      currentVersionId: group.currentVersionId,
      count: versions.length,
      versions,
      // 私有区的项目也有来源，但历史只属于共享库；这里如实说明为什么是空的
      note: group.scope === 'private' && !versions.length ? '私有项目不产生共享历史；这份清单来自该项目的历史端点' : null,
    },
    mode,
    () => {
      if (!versions.length) {
        process.stdout.write(`项目 ${id}（${group.name}）还没有历史版本（还没发布过，或是我自己的私有项目）\n`)
      } else {
        process.stdout.write(
          table(
            ['当前', '版本 id', '动作', '规则数', '操作人', '服务端时间', '回退自'],
            versions.map((v) => [
              v.id === group.currentVersionId ? '*' : '',
              v.id,
              v.operation ?? '-',
              v.ruleCount === null ? '-' : String(v.ruleCount),
              v.actorPhone ?? '-',
              fmtTime(v.createdAt),
              v.rollbackOf ?? '-',
            ]),
          ) + '\n',
        )
      }
      if (group.currentVersionId) info(`当前版本：${group.currentVersionId}`)
      info('提示：回退到任意一版 = mock group rollback ' + id + ' --version <版本id>；回退本身**追加一条新版本**，旧的一条不删')
    },
  )
  return EXIT.OK
}

async function groupRollback(client: ManagementClient, p: Parsed, mode: Mode): Promise<number> {
  const id = requirePositional(p, 0, '共享项目 id', 'mock group rollback g_shared_login --version v_1a2b --yes --json')
  const versionId = flagStr(p, 'version')
  if (versionId === null || versionId.trim() === '') {
    throw usageError('group rollback 缺少 --version <版本id>', '先 mock group history ' + id + ' 看有哪些版本')
  }
  const target = versionId.trim()
  const groups = await readGroups(client)
  const group = groups.views.find((g) => g.id === id)
  if (!group) throw notFoundError(`没有这个项目：${id}`, '先 mock group list --scope shared')
  if (group.scope !== 'shared') {
    throw projectReadonlyError(
      `${id} 是私有项目，没有共享历史可回退`,
      '要撤销自己的改动：逐条 mock api delete / 重新 share 覆盖',
    )
  }
  const operationId = operationIdFor(p, 'rollback')

  // 确认框要说清「回退成什么」：先读那一版的快照元数据，读不到就明确报损坏，不拿当前内容顶上
  const detail = (await client.call(
    'GET',
    `/__ec/api/groups/${encodeURIComponent(id)}/versions/${encodeURIComponent(target)}`,
  )) as Record<string, unknown> | null
  const detailVersion = obj(detail, 'version')
  const detailRules = Array.isArray(detail?.rules) ? (detail?.rules as Record<string, unknown>[]).length : null
  await confirmOrDie(
    p,
    `把共享项目 ${groupLabel(group)} 回退到版本 ${target}（` +
      `${fmtTime(n(detailVersion, 'createdAt'))}，${detailRules ?? '?'} 条规则）——` +
      `当前版本 ${group.currentVersionId ?? '（未发布过）'} 的内容会被该快照整体替换，且**追加一条 rollback 版本**`,
  )

  const res = (await client.call('POST', `/__ec/api/groups/${encodeURIComponent(id)}/rollback`, {
    body: { versionId: target, operationId },
  })) as Record<string, unknown> | null
  const version = obj(res, 'version')
  const newVersionId = s(version, 'id') ?? ''
  const replayed = b(res, 'replayed') === true
  const serverCreatedAt = n(res, 'createdAt')
  const actor = s(res, 'actor')
  if (!newVersionId) throw verifyError('回退回执里缺版本 id', `服务端返回：${JSON.stringify(res).slice(0, 200)}`)

  // 写后读回：当前指针指到新版本、历史里能查到这条 rollback 且 rollbackOf 指向选中的那一版、
  // 共享内容逐条等于该快照；旧版本**一条都不能少**（回退不是改写历史）
  const afterGroups = await readGroups(client)
  const got = afterGroups.views.find((g) => g.id === id) ?? null
  const history = await readVersions(client, id)
  const before = history.filter((v) => v.id !== newVersionId).length
  const listed = history.find((v) => v.id === newVersionId) ?? null
  const rulesAfter = await readProjectRules(client, id)
  const diffs: string[] = []
  if (!got) diffs.push(`读不回共享项目 ${id}`)
  else if (got.currentVersionId !== newVersionId) diffs.push(`currentVersionId：期望 ${newVersionId}，读到 ${JSON.stringify(got.currentVersionId)}`)
  if (!listed) diffs.push(`历史里读不到新的 rollback 版本 ${newVersionId}`)
  else {
    if (listed.operation !== 'rollback') diffs.push(`新版本动作：期望 rollback，读到 ${JSON.stringify(listed.operation)}`)
    if (listed.rollbackOf !== target) diffs.push(`rollbackOf：期望 ${target}，读到 ${JSON.stringify(listed.rollbackOf)}`)
    if (listed.ruleCount !== null && rulesAfter.views.length !== listed.ruleCount) {
      diffs.push(`规则数：历史记 ${listed.ruleCount}，共享项目里 ${rulesAfter.views.length}`)
    }
  }
  if (detailRules !== null && rulesAfter.views.length !== detailRules) {
    diffs.push(`回退后规则数 ${rulesAfter.views.length} 与所选快照的 ${detailRules} 条不一致`)
  }
  if (before < 1 && !replayed) diffs.push('历史里除了新版本一条都没有：回退不该清空历史')
  if (diffs.length) throw verifyError(`回退后读回不一致：${diffs.join('；')}`, `先 mock group history ${id} --json 看服务端的历史`)

  emit(
    {
      ok: true,
      id,
      rollbackTo: target,
      versionId: newVersionId,
      actor,
      createdAt: serverCreatedAt,
      replayed,
      operationId,
      ruleCount: rulesAfter.views.length,
      historyCount: history.length,
      project: got,
      verified: true,
    },
    mode,
    () => {
      info(
        `已把共享项目 ${id} 回退到版本 ${target}，追加新版本 ${newVersionId}，` +
          `${actor ? `操作人 ${actor}，` : ''}服务端时间 ${fmtTime(serverCreatedAt)}，当前 ${rulesAfter.views.length} 条规则，` +
          `历史共 ${history.length} 条，已读回确认`,
      )
      if (replayed) info('注意：这笔 operationId 之前已经执行过，服务端回的是首次那笔的结果，没有追加第二条 rollback 版本')
      info('注意：回退后的共享内容依然**不直接命中**；别人的私有副本不受影响，要重新同步请各自 copy')
    },
  )
  return EXIT.OK
}

async function groupArchive(client: ManagementClient, p: Parsed, mode: Mode): Promise<number> {
  const id = requirePositional(p, 0, '共享项目 id', 'mock group archive g_shared_login --json')
  const groups = await readGroups(client)
  const target = groups.views.find((g) => g.id === id)
  if (!target) throw notFoundError(`没有这个项目：${id}`, '先 mock group list')
  if (target.scope !== 'shared') {
    throw projectReadonlyError(
      `${id} 是私有项目，归档只对共享项目有意义`,
      '自己的项目要处置就删：mock group delete ' + id + ' --yes（组内规则一起删）',
    )
  }
  // 缺省视为 true（协议 §4.7）；取消归档要显式 --off，别让「忘了给参数」把东西下架
  const archived = flagBool(p, 'off') ? false : true
  await client.call('POST', `/__ec/api/groups/${encodeURIComponent(id)}/archive`, { body: { archived } })
  const after = await readGroups(client)
  const got = after.views.find((g) => g.id === id) ?? null
  if (!got) throw verifyError(`归档后读不回项目 ${id}`, '先 mock group list 确认')
  if (got.archived !== archived) {
    throw verifyError(`归档提交后读回不一致：期望 archived=${archived}，读到 ${JSON.stringify(got.archived)}`, '先 mock group list --json 看服务端存的是什么')
  }
  emit({ ok: true, id, archived, group: got, ruleCount: got.ruleCount, verified: true }, mode, () => {
    info(`共享项目 ${id}（${got.name}）已${archived ? '归档' : '取消归档'}，已读回确认`)
    info(
      archived
        ? '提示：归档 ≠ 删除——快照、历史与分享记录一条都不动，之后仍可 group history 查看、仍可 rollback'
        : '提示：取消归档只是让它重新出现在共享列表的未归档一侧；它本来就不参与命中',
    )
  })
  return EXIT.OK
}

/**
 * 恢复（撤销待删除）—— ADR-037 的 `POST /groups/:id/restore`。
 *
 * 幂等：本来就不在待删除 → 如实回 `restored:false`，不当错误（脚本里可以先 restore 再断言状态）。
 * 恢复之后**必须读回确认 `purgeAt` 已被清掉**：标记没清掉的话，7 天后服务端照样真删，
 * 而调用方会以为自己救回来了——这是最容易骗过人的一种「成功」。
 */
async function groupRestore(client: ManagementClient, p: Parsed, mode: Mode): Promise<number> {
  const id = requirePositional(p, 0, '共享项目 id', 'mock group restore g_shared_login --json')
  const groups = await readGroups(client)
  const target = groups.views.find((g) => g.id === id)
  if (!target) throw notFoundError(`没有这个项目：${id}`, '先 mock group list')
  if (target.scope !== 'shared') {
    throw projectReadonlyError(
      `${id} 是私有项目：删除是立刻生效的，没有「待删除」可恢复`,
      '私有项目删了就没了（规则一起删），只能重建：mock group create --name <名字> --on',
    )
  }
  if (target.purgeAt === null) {
    emit({ ok: true, id, restored: false, alreadyActive: true, group: target, ruleCount: target.ruleCount }, mode, () => {
      info(`共享项目 ${id}（${target.name}）本来就不在待删除状态，未做改动`)
    })
    return EXIT.OK
  }
  await client.call('POST', `/__ec/api/groups/${encodeURIComponent(id)}/restore`)
  const after = await readGroups(client)
  const got = after.views.find((g) => g.id === id) ?? null
  if (!got) throw verifyError(`恢复后读不回项目 ${id}`, '先 mock group list 确认')
  if (got.purgeAt !== null) {
    throw verifyError(
      `恢复后 purgeAt 仍在（${got.purgeAt}）：待删除标记没清掉，7 天后仍会被真删`,
      '先 mock group get ' + id + ' --json 看服务端存的是什么；不要当成恢复成功',
    )
  }
  emit({ ok: true, id, restored: true, group: got, ruleCount: got.ruleCount, verified: true }, mode, () => {
    info(`共享项目 ${id}（${got.name}）已恢复，${got.ruleCount ?? '?'} 条规则与历史版本原样还在`)
    info('提示：恢复只撤销删除意图，共享项目依然**不直接命中**；要用请 mock group copy ' + id)
  })
  return EXIT.OK
}

// ────────────────────────────────────────────────
// 供 api.ts 复用的项目守卫
// ────────────────────────────────────────────────
/**
 * 读项目表并**要求服务端支持它**。
 *
 * 存在的理由：写路径（`api create --group-id`）和按项目筛选都必须能核对项目存在。
 * 服务端太旧（没有 `/__ec/api/groups`）时报 64 而不是把悬空 id 写下去——
 * C14 之后**无归属 = 永不命中**，写进去就是一条控制台显示已启用却永远不生效的死条目。
 */
export async function readGroupTable(client: ManagementClient, verb: string): Promise<GroupTable> {
  const groups = await readGroups(client, { tolerateMissing: true })
  if (groups.error) {
    throw notImplemented(`${verb}需要读项目表（服务端没有项目端点）`, 'C14 / ADR-033', `${groups.error}；升级服务端`)
  }
  return groups
}

/** 项目必须存在（他人私有项目按「不存在」同形，协议 §4.7） */
export function pickGroup(table: GroupTable, groupId: string, verb: string): GroupView {
  const found = table.views.find((g) => g.id === groupId)
  if (!found) {
    throw notFoundError(
      `${verb}：没有这个项目 ${JSON.stringify(groupId)}`,
      `我能看到的共 ${table.views.length} 个：${table.views.map((g) => g.id).join(', ') || '（还没有项目，先 mock group create --name <名字> --on 或 mock group copy <共享项目id>）'}`,
    )
  }
  if (found.scope === 'private' && found.enabled === false) {
    info(`注意：项目 ${found.id} 当前是**关**的，组内规则一律不命中（mock group switch ${found.id} --on 整组重开）`)
  }
  return found
}

/**
 * 写路径的项目守卫（C14）：**存在 + 是私有**，两条都在本地先判。
 *
 * 共享项目在这一层就拒，不等服务端的 `409 EC_PROJECT_READONLY`——
 * 早拒的好处是提示能写清楚出路（先 copy 再改再 share），而 409 的文案只能告诉你「不行」。
 */
export async function assertProjectWritable(client: ManagementClient, groupId: string, verb: string): Promise<GroupView> {
  const found = pickGroup(await readGroupTable(client, verb), groupId, verb)
  if (found.scope !== 'private') {
    throw projectReadonlyError(
      `${verb}：${groupId} 是共享项目，规则不能直接挂进共享内容`,
      `共享是只读模板：先 mock group copy ${groupId} 复制到私有区，改完 mock group share <私有项目id> 覆盖回去`,
    )
  }
  return found
}

/**
 * 写入时没带 `--group-id` 时的缺省归属。
 *
 * C14 之后**不允许写无归属规则**（服务端 400，且无归属 = 永不命中），所以这里必须有唯一答案：
 * · 本地默认项目还在且仍是我自己的私有项目 → 用它；
 * · 恰好一个私有项目 → 用它（升级后最常见的形态：copy 出来的那一份）；
 * · 0 个 → 明确报错并给出路；>1 个 → 列出候选，**绝不猜**。
 * 猜错方向的代价是把规则挂进另一个项目，而那边可能正被整体停用。
 */
export async function defaultWritableProject(client: ManagementClient, store: ConfigStore, verb: string): Promise<GroupView> {
  const table0 = await readGroupTable(client, verb)
  const mine = privateProjects(table0)
  const localDefault = store.data.defaults.group
  if (localDefault) {
    const pinned = mine.find((g) => g.id === localDefault)
    if (pinned) return pinned
  }
  if (mine.length === 1) return mine[0]
  if (!mine.length) {
    throw scopeMismatchError(
      `${verb}：我还没有任何私有项目，规则必须挂在私有项目里才会命中`,
      '先建一个：mock group create --name <名字> --on；或从共享库复制：mock group copy <共享项目id>',
    )
  }
  throw usageError(
    `${verb}：我有 ${mine.length} 个私有项目，没带 --group-id 时不知道挂哪个`,
    '显式指定：--group-id <私有项目id>；想省掉这个参数可以设本地默认：mock set group <私有项目id>',
  )
}

// ────────────────────────────────────────────────
// 入口
// ────────────────────────────────────────────────

const SUBS = ['list', 'get', 'create', 'update', 'switch', 'delete', 'rules', 'copy', 'share', 'history', 'rollback', 'archive', 'restore']

export async function cmdGroup(store: ConfigStore, argv: string[]): Promise<number> {
  const sub = (argv[0] ?? 'list').toLowerCase()
  // disable-all 是**刻意不做**的（ADR-030 决策 5）：全量禁用会变成第二份真相，
  // 与控制台里每条规则自己的 enabled 互相打脸。它仍在这里明确报 64，而不是掉进「未知子命令」。
  if (sub === 'disable-all') {
    throw new CliError(
      'EC_NOT_IMPLEMENTED',
      'group disable-all（一键禁用全部规则）刻意不做',
      '整组停用 mock group switch <项目id> --off：重开即恢复原状，且不改写规则自己的 enabled；' +
        '逐条停用 mock api switch <规则id> --off。全量禁用会造出第二份真相（ADR-030）',
      EXIT.NOT_IMPLEMENTED,
    )
  }
  // 「共享项目直接 mock」也是刻意不做的：它不是漏了一个命令，而是 C14 的产品口径（ADR-033 决策 1）。
  // 给个明确报错比让 agent 摸索「为什么 api list 里没有它」省事。
  if (sub === 'mock' || sub === 'enable-shared') {
    throw new CliError(
      'EC_NOT_IMPLEMENTED',
      '共享项目直接参与 mock 刻意不做（C14：shared 是只读模板）',
      '要用共享内容：mock group copy <共享项目id> 复制到私有区，那一份才参与命中（ADR-033）',
      EXIT.NOT_IMPLEMENTED,
    )
  }
  if (!SUBS.includes(sub)) {
    throw usageError(
      `未知的 group 子命令：${sub}`,
      '可用：list / get / create / update / switch / delete / rules / copy / share / history / rollback / archive / restore；整组开关用 group switch',
    )
  }

  const spec =
    sub === 'list'
      ? LIST_FLAGS
      : sub === 'get'
        ? GET_FLAGS
        : sub === 'create'
          ? CREATE_FLAGS
          : sub === 'update'
            ? UPDATE_FLAGS
            : sub === 'switch'
              ? SWITCH_FLAGS
              : sub === 'delete'
                ? DELETE_FLAGS
                : sub === 'rules'
                  ? RULES_FLAGS
                  : sub === 'copy'
                    ? COPY_FLAGS
                    : sub === 'share'
                      ? SHARE_FLAGS
                      : sub === 'history'
                        ? HISTORY_FLAGS
                        : sub === 'rollback'
                          ? ROLLBACK_FLAGS
                          : sub === 'restore'
                            ? RESTORE_FLAGS
                            : ARCHIVE_FLAGS
  const p = parseArgs(argv.slice(1), spec)
  const mode = modeOf(p)
  // 与 api 同一套守卫：flag 值后面多出来的裸 token 会被静默丢掉，这里一律拒绝。
  // list / create 不收位置参数，其余都收 1 个（项目 id）。
  rejectExtraPositionals(p, sub === 'list' || sub === 'create' ? 0 : 1, 'mock group create --name 登录模块 --on')

  const project = projectOf(p, store)
  const ctx = { store, mode, verbose: flagBool(p, 'verbose') }
  const client = await clientFor(ctx, p, project)

  if (sub === 'list') return groupList(client, p, mode, store)
  if (sub === 'get') return groupGet(client, p, mode, store)
  if (sub === 'create') return groupCreate(client, p, mode)
  if (sub === 'update') return groupUpdate(client, p, mode)
  if (sub === 'switch') return groupSwitch(client, p, mode)
  if (sub === 'delete') return groupDelete(client, p, mode)
  if (sub === 'rules') return groupRules(client, p, mode)
  if (sub === 'copy') return groupCopy(client, p, mode)
  if (sub === 'share') return groupShare(client, p, mode)
  if (sub === 'history') return groupHistory(client, p, mode)
  if (sub === 'rollback') return groupRollback(client, p, mode)
  if (sub === 'restore') return groupRestore(client, p, mode)
  return groupArchive(client, p, mode)
}

/**
 * 单个项目的详情，**顺带回答「组里现在有哪些规则在生效」**。
 *
 * 存在的理由：关项目之后 `mock api list` 的 `on` 列仍然一片 ✓，只有这里能看出
 * 「项目挡掉了 N 条」。不查这一层的 agent 会以为整组都在工作。
 * 规则清单走 `GET /groups/:id/rules`（不是 `GET /rules`）：共享项目的内容在后者里根本看不到。
 */
async function groupGet(client: ManagementClient, p: Parsed, mode: Mode, store: ConfigStore): Promise<number> {
  const id = requirePositional(p, 0, '项目 id', 'mock group get g_login --json')
  const groups = await readGroups(client)
  const group = groups.views.find((g) => g.id === id)
  if (!group) {
    throw notFoundError(`没有这个项目：${id}`, `服务端共 ${groups.views.length} 个；可用：${groups.views.map((g) => g.id).join(', ') || '（空）'}`)
  }
  let rules: RuleView[] = []
  let dropped = 0
  let rulesError: string | null = null
  try {
    const read = await readProjectRules(client, id)
    rules = read.views
    dropped = read.dropped
  } catch (e) {
    rulesError = e instanceof Error ? e.message : String(e)
  }
  const hit = group.scope === 'private' && group.enabled !== false
  const members = rules.map((r) => ({
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    effective: rulesError ? 'unknown' : !hit ? (group.scope === 'shared' ? 'off-shared' : 'off-by-project') : r.enabled === false ? 'off-by-rule' : 'active',
  }))
  emit(
    {
      ok: true,
      id,
      group,
      defaultGroup: store.data.defaults.group,
      participatesInHit: hit,
      members,
      memberCount: members.length,
      dropped,
      rulesError,
      note: groups.error,
    },
    mode,
    () => {
      process.stdout.write(
        table(
          ['字段', '值'],
          [
            ['id', group.id],
            ['name', group.name || '-'],
            ['归属', scopeCell(group)],
            ['开关', enabledCell(group)],
            ['规则数（服务端统计）', cell(group.ruleCount)],
            ['归属人/发布人', ownerCell(group)],
            ['参与命中', hit ? '是' : '否'],
            ['当前版本', group.currentVersionId ?? '-'],
            ['来源共享项目', group.originSharedProjectId ?? '-'],
            ['创建', group.createdAt === null ? '-' : fmtTime(group.createdAt)],
            ['更新', group.updatedAt === null ? '-' : fmtTime(group.updatedAt)],
          ],
        ) + '\n',
      )
      if (rulesError) info(`注意：规则清单读不到（${rulesError}），成员列表为空不代表项目是空的`)
      else if (!members.length) info('项目内没有规则')
      else {
        process.stdout.write(
          table(
            ['规则 id', '备注名', '规则开关', '实际是否命中'],
            members.map((m) => [m.id, m.name ?? '-', m.enabled === null ? '?' : m.enabled ? '开' : '关', m.effective]),
          ) + '\n',
        )
        if (group.scope === 'shared') info('注意：这是**共享模板**，整组永不命中（C14）；要用先 mock group copy ' + group.id)
        else if (group.enabled === false) info(`注意：项目是关的，上面这些规则**当前都不命中**（规则的 enabled 没被改写，重开即恢复）`)
      }
    },
  )
  return EXIT.OK
}
