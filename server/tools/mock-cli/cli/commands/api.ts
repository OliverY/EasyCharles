import { flagBool, flagList, flagStr, parseArgs, rejectExtraPositionals, requirePositional } from '../args.ts'
import type { FlagSpec, Parsed } from '../args.ts'
import { CliError, EXIT, notFoundError, scopeMismatchError, usageError, verifyError } from '../errors.ts'
import type { ConfigStore } from '../config.ts'
import type { ManagementClient } from '../client.ts'
import { expectList, n, obj, s } from '../guards.ts'
import type { ListRead } from '../guards.ts'
import { confirmOrDie, emit, info, modeOf, table } from '../output.ts'
import type { Mode } from '../output.ts'
import { hitLine, matchLine, ruleView, ruleViews } from '../rules-view.ts'
import type { RuleView } from '../rules-view.ts'
import { arraySummary, arraysFromArgs, buildResponses, diffAgainstServer, RESPONSE_FLAGS } from '../responses.ts'
import type { BuildResult } from '../responses.ts'
import { assertProjectWritable, defaultWritableProject, pickGroup, readGroupTable, readGroups } from './group.ts'
import type { GroupTable, GroupView } from './group.ts'
import { clientFor, projectOf } from './auth.ts'

/**
 * `api` = 服务端的一条 **Mock 规则**（`Rule`）。
 *
 * skill 里的「接口」在这里就是规则：`match.method/host/path/params` 决定命中谁，
 * `action.responses[]` 是那一组返回值。命令名沿用 skill 的叫法（`api`），
 * 那份 agent 文档才能逐字复用；语义差异写在本文件注释里。
 *
 * 本文件做单条规则的**读**与**写**。
 *
 * 写（`create` / `update` / `copy`，P2 / ADR-028）全部走**单条端点**：
 * `POST /__ec/api/rules` 与 `PUT /__ec/api/rules/:id`，绝不整表 PUT——
 * 否则 agent 的一次读改写会把别人同时改的规则整片覆盖掉（ADR-019 那次事故）。
 *
 * `update` 是**读改写**：先把服务端存的那份原样读回来（含 CLI 不认识的字段），
 * 只覆盖命令行显式给的字段，再整条 PUT 回去。这样控制台写的规则不会越改越瘦，
 * 每条返回值上的 `cond` 也不会被 CLI 抹掉。
 * ⚠️ 读与写之间有时间窗，另一方在此期间改过**同一条**规则就会互相覆盖
 * （服务端没有版本号，这层防线在 CLI 做不了；roadmap P6 的已知限制有登记）。
 *
 * **C14 / ADR-033 改掉了这里的三件事**（都是「静默失效」的形态，不是风格问题）：
 * 1. `GET /__ec/api/rules` 只回**我自己的私有规则**（别人的与共享的都不下发）。
 *    所以 `api list` 的条数不再等于全服条数，共享模板要用 `mock group rules <id>` 看；
 * 2. 新建的规则**必须挂在我的某个私有项目里**：没带 `--group-id` 时按「本地默认项目 →
 *    唯一私有项目」推，推不出唯一答案就报错，绝不写一条无归属的规则出去
 *    （无归属在 C14 = 永不命中，而 `rules.json` 里它看起来一切正常）；
 * 3. **不再支持「移出项目」**（`--group-id ""`）与**跨项目挪动**：前者等于批量制造死条目，
 *    后者在新模型里就是「把别人的私有规则搬走」。
 */

const LIST_FLAGS: FlagSpec = { method: 'string', host: 'string', path: 'string', q: 'string', enabled: 'string' }
const GET_FLAGS: FlagSpec = {}
const SWITCH_FLAGS: FlagSpec = { on: 'bool', off: 'bool' }
const DELETE_FLAGS: FlagSpec = {}
/** 写命令共用的「匹配条件 + 命中方式」参数（返回值数组参数见 RESPONSE_FLAGS） */
const MATCH_FLAGS: FlagSpec = {
  name: 'string',
  method: 'string',
  host: 'string',
  path: 'string',
  param: 'list',
  'clear-params': 'bool',
  'allow-match-all': 'bool',
  mode: 'string',
  'seq-mode': 'string',
  'pin-index': 'string',
  priority: 'string',
  'delay-ms': 'string',
  on: 'bool',
  off: 'bool',
}
const CREATE_FLAGS: FlagSpec = { ...MATCH_FLAGS, ...RESPONSE_FLAGS }
const UPDATE_FLAGS: FlagSpec = { ...MATCH_FLAGS, ...RESPONSE_FLAGS }
const COPY_FLAGS: FlagSpec = { name: 'string' }

/** 规则里返回值的存储形态（协议 §5.4：两种形态控制台都要读得懂） */
type RespForm = 'responses' | 'single' | 'none'

function existingResponses(action: Record<string, unknown> | null): { items: Record<string, unknown>[]; form: RespForm } {
  if (!action) return { items: [], form: 'none' }
  const raw = action.responses
  if (Array.isArray(raw)) {
    return {
      items: raw.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r)),
      form: 'responses',
    }
  }
  const one = obj(action, 'response')
  return one ? { items: [one], form: 'single' } : { items: [], form: 'none' }
}

/** 规则列表用的视图与逐字段解析在 `../rules-view.ts`（`group rules` 共用同一份口径） */

/**
 * 规则**实际**会不会命中，光看 `enabled` 不够（C14 / 协议 §5.4 的那条 AND）：
 * `规则 enabled` 且 `项目存在` 且 `项目是私有` 且 `项目 enabled`。
 * 项目开关不改写规则的 `enabled`，所以「on 列一片 ✓、实际整组都不 mock」是完全可能的状态。
 * `off-by-project` 就是把这件事写到字段里，不让 agent 自己推。
 */
type Effective = 'active' | 'off-by-rule' | 'off-by-project' | 'unknown'

interface GroupState {
  /** 所属项目自身的 enabled；项目行读不到 → null（= 未知，不是「关」） */
  groupEnabled: boolean | null
  /**
   * `groupId` 指向的项目**不在我能看到的清单里**——他人私有项目（服务端连存在都不下发）
   * 或项目已被删除。C14 之后这两种都意味着**永不命中**，
   * 不再是 C13 那句「按未分组处理、照常命中」（ADR-030 决策 3 已被 ADR-033 结论翻转）。
   */
  groupInvisible: boolean
  effective: Effective
}

type AnnotatedRule = RuleView & GroupState

function effectiveOf(ruleEnabled: boolean | null, groupEnabled: boolean | null, groupInvisible: boolean): Effective {
  if (groupInvisible || groupEnabled === false) return 'off-by-project'
  if (ruleEnabled === false) return 'off-by-rule'
  if (ruleEnabled === null) return 'unknown'
  return 'active'
}

interface RuleRead {
  views: RuleView[]
  raw: Record<string, unknown>[]
  /** 结构不合法、被跳过的条目数（如实回传，不静默少几条） */
  dropped: number
}

async function readRules(client: ManagementClient): Promise<RuleRead> {
  const read: ListRead = expectList(await client.call('GET', '/__ec/api/rules'), 'GET /__ec/api/rules')
  const { views, dropped } = ruleViews(read.items)
  return { views, raw: read.items, dropped: read.dropped + dropped }
}

function contains(hay: string | null, needle: string): boolean {
  return hay !== null && hay.toLowerCase().includes(needle)
}

/**
 * 「这条规则眼下没有可命中的私有项目」的三种形态：无 `groupId`、指向已删的项目、指向
 * 别人的项目或共享项目。C14 之后三者都是**永不命中**，不再是 C13 那句
 * 「悬空按未分组处理、照常命中」（ADR-030 决策 3 已被 ADR-033 结论翻转）。
 * 服务端本不会下发这样的规则，这里出现即说明 `rules.json` 是升级前留下的脏数据。
 */
const NO_PROJECT: GroupState = { groupEnabled: null, groupInvisible: true, effective: 'off-by-project' }

/**
 * 给每条规则补上「它现在到底会不会命中」。
 *
 * 只在**确实有规则挂了项目**时才多读一次项目表：无归属那一条的答案不依赖项目表，
 * 为一列常量多打一个请求不值。
 *
 * 服务端太旧（没有 `/__ec/api/groups`）时**降级而不报错**，并把原因如实带在 `note` 里：
 * 项目状态未知 ≠ 项目已关，绝不能因此让 `api list` 装作「都没命中」。
 */
async function annotate(
  client: ManagementClient,
  views: RuleView[],
  pre?: GroupTable,
): Promise<{ rows: AnnotatedRule[]; note: string | null }> {
  const needsGroup = pre !== undefined || views.some((v) => v.groupId !== null)
  if (!needsGroup) {
    return { rows: views.map((v) => ({ ...v, ...NO_PROJECT })), note: null }
  }
  const groups = pre ?? (await readGroups(client, { tolerateMissing: true }))
  const byId = new Map<string, GroupView>(groups.views.map((g) => [g.id, g]))
  const rows = views.map((v) => {
    if (!v.groupId) return { ...v, ...NO_PROJECT }
    const g = byId.get(v.groupId)
    const groupEnabled = g ? g.enabled : null
    // 「查不到」只有在项目表确实读到了才成立；读不到时是未知，不是不可见
    const groupInvisible = groups.error === null && (!g || g.scope !== 'private')
    return { ...v, groupEnabled, groupInvisible, effective: effectiveOf(v.enabled, groupEnabled, groupInvisible) }
  })
  return { rows, note: groups.error }
}

/**
 * 筛选在**客户端**做：管理面 `GET /rules` 只有全量列表这一个形态。
 *
 * 四条语义必须讲清楚，否则筛选结果会被误读：
 * - `--method` 下，**规则没写 method（通配）也算命中**——没写 method 的规则确实会命中该请求（协议 §5.4）；
 * - `--host` / `--path` 匹配的是规则里声明的**模式串原文**（含 glob / `re:`），
 *   不是「这条规则实际命中过哪些请求」——那是运行时语义，管理面没有这个数据；
 * - `--group-id` 比的是**项目 id 原文**（协议 §5.5）；
 * - `--group-id ""`（只看无归属）在 C14 下**恒为 0 条**：服务端只下发我私有项目里的规则，
 *   无归属 / 他人 / 共享的规则根本不在这个列表里。这里如实回传 0 条并带 `note`，
 *   不把它伪装成「项目里一条规则都没有」。
 */
function applyFilters(
  rows: AnnotatedRule[],
  f: { method: string | null; host: string | null; path: string | null; q: string | null; enabled: boolean | null; groupId: string | null },
): AnnotatedRule[] {
  const method = f.method ? f.method.toUpperCase() : null
  const host = f.host ? f.host.toLowerCase() : null
  const path = f.path ? f.path.toLowerCase() : null
  const q = f.q ? f.q.toLowerCase() : null
  return rows.filter((v) => {
    if (method && v.method !== null && v.method.toUpperCase() !== method) return false
    if (host && !contains(v.host, host)) return false
    if (path && !contains(v.path, path)) return false
    if (f.enabled !== null && v.enabled !== f.enabled) return false
    if (f.groupId !== null && (v.groupId ?? '') !== f.groupId) return false
    if (q) {
      const hay = [v.id, v.name, v.host, v.path, v.method, v.groupId].filter((x): x is string => typeof x === 'string').join(' ').toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
}

/** 只认 `true` / `false`：`--enabled 1` / `yes` 一律拒绝（AGENTS.md §4 不做宽松强转） */
function readEnabledFlag(p: Parsed): boolean | null {
  const raw = flagStr(p, 'enabled')
  if (raw === null) return null
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw usageError(`--enabled 只接受 true / false（收到 ${JSON.stringify(raw)}）`, '开关字段不做宽松强转：1 / yes / on 一律拒绝')
}

/** 匹配条件与命中方式的一行摘要在 `../rules-view.ts`，与 `group get` 用同一份文案 */

function effectiveText(v: AnnotatedRule): string {
  if (v.effective === 'off-by-project') {
    if (v.groupId === null) return '不命中（无归属：规则必须挂在私有项目里）'
    if (v.groupInvisible) return `不命中（项目 ${v.groupId} 不是我的私有项目：已删除或归属别人）`
    return `不命中（所属项目 ${v.groupId} 已关）`
  }
  if (v.effective === 'off-by-rule') return '不命中（规则自身已关）'
  if (v.effective === 'unknown') return '未知（enabled 不是布尔）'
  return '命中'
}

/** 人类模式里项目那一列的写法：要能一眼看出「这条虽然在 ✓，但被项目挡掉了」 */
function groupCell(v: AnnotatedRule): string {
  if (v.groupId === null) return '无归属'
  if (v.groupInvisible) return `${v.groupId}(非我的私有)`
  if (v.groupEnabled === false) return `${v.groupId}(项目关)`
  if (v.groupEnabled === null) return `${v.groupId}(未知)`
  return v.groupId
}

function renderViews(views: AnnotatedRule[], total: number, dropped: number, filtered: boolean, groupNote: string | null): void {
  if (!views.length) {
    const scope = filtered ? `（筛选后 0 条，我的私有项目里共 ${total} 条）` : `（我的私有项目里共 ${total} 条）`
    process.stdout.write(`没有匹配的规则${scope}；共享项目里的规则要用 mock group rules <共享项目id> 看\n`)
    info('提示：mock api list --q <关键字> 换个关键词再看；不带参数即列全部')
  } else {
    process.stdout.write(
      table(
        ['id', 'on', '项目', '返回值', '命中方式', '匹配'],
        views.map((v) => [
          v.id,
          v.enabled === null ? '?' : v.enabled ? '✓' : '✗',
          groupCell(v),
          String(v.responses),
          hitLine(v),
          matchLine(v),
        ]),
      ) + '\n',
    )
    const blocked = views.filter((v) => v.effective === 'off-by-project')
    if (blocked.length) {
      const sample = blocked.find((v) => v.groupId)?.groupId ?? null
      info(
        `注意：${blocked.length} 条规则的 on=✓ 但**当前不命中**——所属私有项目不存在或整项目是关的（项目开关不改写规则自己的 enabled）。` +
          (sample ? `重开：mock group switch ${sample} --on` : `先建/复制一个私有项目：mock group create / mock group copy <共享项目id>`),
      )
    }
  }
  if (dropped) info(`注意：有 ${dropped} 条条目结构不合法（缺 id / 非对象 / 非数组元素），已跳过。`)
  if (groupNote) info(`注意：${groupNote}`)
}

/**
 * `--group-id` 在单条命令（get / switch / delete）上是**归属校验**：
 * 「只在我确认它属于这个项目的时候才动它」。写成静默忽略会让 agent 拿着别的
 * 项目里的规则 id 就改下去；这里直接报错，比改错了再回滚便宜。
 */
function guardMembership(v: RuleView, groupId: string, sub: string): void {
  const actual = v.groupId ?? ''
  if (actual === groupId) return
  const where = actual === '' ? '无归属（升级前留下的死条目）' : `项目 ${actual}`
  const want = groupId === '' ? '无归属' : `项目 ${groupId}`
  throw notFoundError(
    `规则 ${v.id} 属于${where}，不是${want}`,
    `api ${sub} 的 --group-id 是归属校验：先 mock api get ${v.id} --json 看 groupId，或去掉这个参数`,
  )
}

export async function cmdApi(store: ConfigStore, argv: string[]): Promise<number> {
  const sub = (argv[0] ?? 'list').toLowerCase()
  if (!['list', 'get', 'switch', 'delete', 'create', 'update', 'copy'].includes(sub)) {
    throw usageError(`未知的 api 子命令：${sub}`, '可用：list / get / switch / delete / create / update / copy')
  }

  const spec =
    sub === 'list'
      ? LIST_FLAGS
      : sub === 'switch'
        ? SWITCH_FLAGS
        : sub === 'delete'
          ? DELETE_FLAGS
          : sub === 'create'
            ? CREATE_FLAGS
            : sub === 'update'
              ? UPDATE_FLAGS
              : sub === 'copy'
                ? COPY_FLAGS
                : GET_FLAGS
  // 只切掉子命令本身：id 留在 positional 里由 requirePositional 取。
  // flag 可以插在 id 的前后任意位置，所以一律交给 parseArgs——
  // 手写「第一个非 - 开头的 token」会把 --config 的值当成 id（P0 踩过这个坑）
  const p = parseArgs(argv.slice(1), spec)
  const mode = modeOf(p)

  // 数组类参数写错形态（`--json-list A B C`）时，B / C 会掉进 positional 被静默丢掉，
  // CLI 照样报成功、服务端只存 1 条——所以每条 api 子命令都要明确自己收几个位置参数。
  // create / list 一个都不收；其余收 1 个（规则 id）。
  rejectExtraPositionals(p, sub === 'create' || sub === 'list' ? 0 : 1, 'mock api create --path /api/x --json-list \'{"a":1}\' --json-list \'{"b":2}\'')

  // `--group-id`（C13 / ADR-030 → C14 / ADR-033 的「项目」）在每类子命令上都有明确语义，
  // **绝不静默忽略**：
  // · list → 按项目筛选（空串 = 只看无归属；C14 下恒为 0 条，如实回传并带 note）
  // · create / copy → 副本挂到哪个私有项目（写之前先核对它是**我的私有项目**）
  // · update → 只允许「原项目不变」；移出项目与跨项目挪动都在 CLI 侧就先拒绝
  // · get / switch / delete → 归属校验（「确认它属于这个项目才动手」）
  // 静默忽略过滤条件 = 把「某个项目下的接口」返回成「全部接口」，agent 拿这个结果去改项目比直接报错更糟。
  const groupId = flagStr(p, 'group-id')

  const project = projectOf(p, store)
  const ctx = { store, mode, verbose: flagBool(p, 'verbose') }
  const client = await clientFor(ctx, p, project)

  if (sub === 'list') return apiList(client, p, mode, groupId)
  if (sub === 'get') return apiGet(client, p, mode, groupId)
  if (sub === 'switch') return apiSwitch(client, p, mode, groupId)
  if (sub === 'create') return apiCreate(client, store, p, mode, groupId)
  if (sub === 'update') return apiUpdate(client, p, mode, groupId)
  if (sub === 'copy') return apiCopy(client, p, mode, groupId)
  return apiDelete(client, p, mode, groupId)
}

async function apiList(client: ManagementClient, p: Parsed, mode: Mode, groupId: string | null): Promise<number> {
  const { views, dropped } = await readRules(client)
  // 写了 --group-id 就必须核对这个项目存在且可写：按不存在的项目筛选静默返回空列表，
  // 会被读成「这个项目里一条规则都没有」——而真相是「你写错了 id 或项目已被删」
  const groupTable = groupId !== null ? await readGroupTable(client, '按项目筛选') : null
  // 空串是「只看无归属」这个**条件**，不是一个要去核对存在的 id
  if (groupId) pickGroup(groupTable as GroupTable, groupId, '按项目筛选')
  const { rows, note: groupNote } = await annotate(client, views, groupTable ?? undefined)
  const enabled = readEnabledFlag(p)
  const filtered = applyFilters(rows, {
    method: flagStr(p, 'method'),
    host: flagStr(p, 'host'),
    path: flagStr(p, 'path'),
    q: flagStr(p, 'q'),
    enabled,
    groupId,
  })
  const anyFilter =
    flagStr(p, 'method') !== null ||
    flagStr(p, 'host') !== null ||
    flagStr(p, 'path') !== null ||
    flagStr(p, 'q') !== null ||
    enabled !== null ||
    groupId !== null
  // `--group-id ""` 在 C14 下**必然**是 0 条，且原因不在筛选逻辑里，而在服务端不下发无归属规则。
  // 不把这件事说出来，这个空列表就会被读成「我没有游离规则」——它其实是「这个入口看不到游离规则」。
  const blankNote =
    groupId === ''
      ? '--group-id "" 只看无归属规则；C14 起服务端只下发我的私有项目内的规则，无归属/他人/共享的规则根本不在这个列表里（要按项目看用 mock group rules <id>）'
      : null
  const payload = {
    ok: true,
    count: filtered.length,
    // total 是「我看得见的条数」（= 我的私有项目里的规则数），不是全服条数（协议 §4.7）
    total: views.length,
    scope: 'my-private-projects',
    dropped,
    filtered: anyFilter,
    // 过滤发生在 CLI 侧（管理面没有按条件查询规则的端点），如实标出来
    filteredBy: anyFilter
      ? {
          method: flagStr(p, 'method'),
          host: flagStr(p, 'host'),
          path: flagStr(p, 'path'),
          q: flagStr(p, 'q'),
          enabled,
          groupId,
        }
      : null,
    // 项目表读不到时的原因（服务端太旧）。非 null 时每条规则的 groupEnabled 都是「未知」，不是「关」
    groupsError: groupNote,
    note: blankNote,
    rules: filtered,
  }
  emit(payload, mode, () => {
    renderViews(filtered, views.length, dropped, anyFilter, groupNote)
    if (blankNote) info(`注意：${blankNote}`)
  })
  return EXIT.OK
}

async function apiGet(client: ManagementClient, p: Parsed, mode: Mode, groupId: string | null): Promise<number> {
  const id = requirePositional(p, 0, '规则 id', 'mock api get r_login --json')
  const { views, raw, dropped } = await readRules(client)
  const index = raw.findIndex((r) => s(r, 'id') === id)
  if (index < 0) {
    throw notFoundError(
      `没有这条规则：${id}`,
      `我的私有项目里共 ${views.length} 条可用；先跑 mock api list 拿 id。共享项目里的规则用 mock group rules <共享项目id> 看${dropped ? `（另有 ${dropped} 条脏条目已跳过）` : ''}`,
    )
  }
  const view = views.find((v) => v.id === id) ?? null
  if (view && groupId !== null) guardMembership(view, groupId, 'get')
  // 只有挂了项目的规则才值得多读一次项目表；无归属那一眼就能判定不命中
  const { rows, note: groupNote } = await annotate(client, view ? [view] : [])
  const status = rows[0] ?? null
  // `rule` 是服务端存什么就**原样**给什么：P2 的读改写全靠它。
  // 这里若只挑「认识」的字段输出，就会把服务端无损保留的未知字段抹掉（ADR-027 记的坑）。
  emit({ ok: true, id, rule: raw[index], summary: view, status, groupsError: groupNote, dropped }, mode, () => {
    if (view) {
      process.stdout.write(
        table(
          ['字段', '值'],
          [
            ['id', view.id],
            ['name', view.name ?? '-'],
            ['enabled', view.enabled === null ? '?' : view.enabled ? '开' : '关'],
            ['项目(groupId)', view.groupId ?? '无归属'],
            ['实际是否命中', status ? effectiveText(status) : '?'],
            ['priority', String(view.priority ?? 0)],
            ['匹配', matchLine(view)],
            ['命中方式', hitLine(view)],
            ['返回值条数', String(view.responses)],
            ['延迟', view.delayMs ? `${view.delayMs}ms` : '-'],
          ],
        ) + '\n',
      )
      if (view.groupId === null) {
        info(`注意：这条规则没有归属项目（升级前留下的死条目）。C14 起它**永不命中**，且 api update 不能把它挪进项目（服务端 400）——要复用就 mock api copy 到私有项目里再删掉这条`)
      } else if (status?.groupInvisible) {
        info(`注意：项目 ${view.groupId} 不在我的私有项目清单里（已被删除或属于别人）。按 C14 它**永不命中**；服务端本来也不下发这样的规则，出现即说明 rules.json 里有升级前的脏数据`)
      } else if (status?.groupEnabled === false) {
        info(`注意：所属项目 ${view.groupId} 是关的，这条规则**当前不命中**（重开：mock group switch ${view.groupId} --on）`)
      } else if (status?.effective === 'unknown') {
        info('注意：enabled 不是布尔（脏数据），命中状态未知')
      }
    } else {
      info('这条规则的匹配条件无法解析（原样在 rule 字段里）')
    }
  })
  return EXIT.OK
}

async function apiSwitch(client: ManagementClient, p: Parsed, mode: Mode, groupId: string | null): Promise<number> {
  const id = requirePositional(p, 0, '规则 id', 'mock api switch r_login --off --json')
  const on = flagBool(p, 'on')
  const off = flagBool(p, 'off')
  if (on === off) {
    throw usageError(
      'api switch 要且只要一个开关',
      '开：--on；关：--off。刻意不给默认值——猜错方向就是把别人的接口 mock 掉（或反过来放出去打真实服务器）。',
    )
  }
  const enabled = on

  const before = await readRules(client)
  const target = before.views.find((v) => v.id === id)
  if (!target) throw notFoundError(`没有这条规则：${id}`, `我的私有项目里共 ${before.views.length} 条；先跑 mock api list`)
  if (groupId !== null) guardMembership(target, groupId, 'switch')

  await client.call('POST', `/__ec/api/rules/${encodeURIComponent(id)}/enabled`, { body: { enabled } })

  // 读回校验：skill 的硬要求，「提交后必须读回确认」
  const after = await readRules(client)
  const now = after.views.find((v) => v.id === id)
  if (!now || now.enabled !== enabled) {
    throw verifyError(
      `开关提交后读回不一致：期望 enabled=${enabled}，读到 ${JSON.stringify(now?.enabled)}`,
      '可能刚被另一台控制台的整表 PUT 覆盖（ADR-019）；确认后再试',
    )
  }
  emit(
    {
      ok: true,
      id,
      enabled,
      previous: target.enabled,
      // 规则自己开了也不等于会命中：所属私有项目关着（或项目不存在）时它仍然不命中（协议 §5.5 的那条 AND）
      groupId: now.groupId,
      verified: true,
    },
    mode,
    () => {
      info(`规则 ${id} 已${enabled ? '开' : '关'}（原来是 ${target.enabled === null ? '未知' : target.enabled ? '开' : '关'}），已读回确认`)
      if (enabled && !now.groupId) info(`提示：这条规则没有归属项目，C14 下它**永不命中**（开关不改变这一点）；要它生效得 mock api copy 进私有项目`)
      else if (enabled && now.groupId) info(`提示：这条规则挂在项目 ${now.groupId} 下；项目整个关掉时它仍然不命中，整项目开关见 mock group switch`)
    },
  )
  return EXIT.OK
}

async function apiDelete(client: ManagementClient, p: Parsed, mode: Mode, groupId: string | null): Promise<number> {
  const id = requirePositional(p, 0, '规则 id', 'mock api delete r_login --yes --json')
  const before = await readRules(client)
  const target = before.views.find((v) => v.id === id)
  if (!target) throw notFoundError(`没有这条规则：${id}`, `我的私有项目里共 ${before.views.length} 条；先跑 mock api list`)
  if (groupId !== null) guardMembership(target, groupId, 'delete')

  await confirmOrDie(p, `删除规则 ${id}${target.name ? `（${target.name}）` : ''}，匹配 ${matchLine(target)}，${target.responses} 条返回值`)

  await client.call('DELETE', `/__ec/api/rules/${encodeURIComponent(id)}`)

  const after = await readRules(client)
  if (after.views.some((v) => v.id === id)) {
    throw verifyError(`删除后仍能读到规则 ${id}`, '服务端可能刚被另一台控制台整表覆盖（PUT）；确认后再删')
  }
  emit({ ok: true, id, removed: true, remaining: after.views.length }, mode, () =>
    info(`已删除规则 ${id}，剩余 ${after.views.length} 条（已读回确认）`),
  )
  return EXIT.OK
}

// ───────────────────────── 写：create / update / copy（P2 / ADR-028）─────────────────────────

type Mode3 = 'static' | 'sequence' | 'specific'
const SEQ_MODES = ['in-order', 'loop', 'once-then-passthrough', 'random'] as const

/** 严格整数参数：`--priority abc` / `--pin-index 1.5` 一律退出码 2，不静默变成 NaN */
function readIntFlag(p: Parsed, name: string, opts: { min?: number; max?: number } = {}): number | null {
  const raw = flagStr(p, name)
  if (raw === null) return null
  const v = Number(raw)
  if (!Number.isFinite(v) || !Number.isInteger(v)) {
    throw usageError(`--${name} 要整数（收到 ${JSON.stringify(raw)}）`, null)
  }
  if (opts.min !== undefined && v < opts.min) throw usageError(`--${name} 不能小于 ${opts.min}（收到 ${v}）`, null)
  if (opts.max !== undefined && v > opts.max) throw usageError(`--${name} 不能大于 ${opts.max}（收到 ${v}）`, null)
  return v
}

/**
 * 可重复的整数参数（`--status 200 --status 401`）。
 *
 * 每个值单独校验：第 2 个写错了不能让第 1 个 silently 生效，
 * 也不能让整批变成 `NaN` 存进规则（服务端会把 NaN 当成「没有状态码」）。
 */
function readIntListFlag(p: Parsed, name: string, opts: { min?: number; max?: number } = {}): number[] | null {
  const raw = flagList(p, name)
  if (!raw.length) return null
  return raw.map((item) => {
    const v = Number(item)
    if (!Number.isFinite(v) || !Number.isInteger(v)) {
      throw usageError(`--${name} 要整数（收到 ${JSON.stringify(item)}）`, `如 --${name} 201 --${name} 401（按返回值下标一一对应）`)
    }
    if (opts.min !== undefined && v < opts.min) throw usageError(`--${name} 不能小于 ${opts.min}（收到 ${v}）`, null)
    if (opts.max !== undefined && v > opts.max) throw usageError(`--${name} 不能大于 ${opts.max}（收到 ${v}）`, null)
    return v
  })
}

/**
 * `--mode` 三种命中方式（协议 §5.4）。`fixed` / `seq` 是友好别名，
 * 但落到服务端一律写协议值（`static` / `sequence` / `specific`），
 * 否则控制台读不懂 CLI 写的规则——AGENTS.md §5 的三方核对。
 */
function readModeFlag(p: Parsed): Mode3 | null {
  const raw = flagStr(p, 'mode')
  if (raw === null) return null
  const v = raw.toLowerCase()
  const map: Record<string, Mode3> = {
    static: 'static',
    fixed: 'static',
    sequence: 'sequence',
    seq: 'sequence',
    specific: 'specific',
  }
  const got = map[v]
  if (!got) {
    throw usageError(`--mode 不认识 ${JSON.stringify(raw)}`, '可用：static（固定返回，仅 1 条）/ sequence（按序列推进）/ specific（多条中指定第 pinIndex 条）')
  }
  return got
}

function readSeqModeFlag(p: Parsed): string | null {
  const raw = flagStr(p, 'seq-mode')
  if (raw === null) return null
  if (!(SEQ_MODES as readonly string[]).includes(raw)) {
    throw usageError(`--seq-mode 不认识 ${JSON.stringify(raw)}`, `可用：${SEQ_MODES.join(' / ')}`)
  }
  return raw
}

function parseParams(raw: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const item of raw) {
    const eq = item.indexOf('=')
    if (eq <= 0) {
      throw usageError(
        `--param 要写成 k=v（收到 ${JSON.stringify(item)}）`,
        '值可以留空：--param uid= 表示「只要求存在这个参数」，不校验取值（协议 §5.4）',
      )
    }
    out[item.slice(0, eq)] = item.slice(eq + 1)
  }
  return out
}

/**
 * 匹配条件的读改写：没给的键**原样保留**，给空串表示清除（`--path ""`）。
 * 未认识的键（未来的 `groupId` 等）一并带走。
 */
function overlayMatch(base: Record<string, unknown>, p: Parsed): Record<string, unknown> {
  const m: Record<string, unknown> = { ...base }
  for (const key of ['method', 'host', 'path'] as const) {
    const v = flagStr(p, key)
    if (v === null) continue
    if (v === '') delete m[key]
    else m[key] = key === 'method' ? v.toUpperCase() : v
  }
  if (flagBool(p, 'clear-params')) delete m.params
  else {
    const params = flagList(p, 'param')
    if (params.length) m.params = parseParams(params)
  }
  return m
}

/**
 * 域名 + 路径都不写 = 这条规则命中**所有**请求（服务端把未配置的条件当通配，协议 §5.4）。
 * 对 agent 来说这是最贵的一种误用：一次 `api create` 就能把整个域名下的真实请求全 mock 掉。
 * 所以默认拒绝，要显式 `--allow-match-all` + `--yes`。
 */
async function guardMatchAll(match: Record<string, unknown>, p: Parsed, verb: string): Promise<void> {
  const host = match.host
  const path = match.path
  const located = (typeof host === 'string' && host !== '') || (typeof path === 'string' && path !== '')
  if (located) return
  if (!flagBool(p, 'allow-match-all')) {
    throw usageError(
      `${verb}规则既没有 --host 也没有 --path，会命中所有请求`,
      '给出 --path /api/xxx（或 --host example.com）；确实要做全量兜底就加 --allow-match-all --yes',
    )
  }
  await confirmOrDie(p, `${verb}规则「不限域名与路径」（会命中所有请求）`)
}

function enabledFromFlags(p: Parsed, current: unknown): boolean {
  const on = flagBool(p, 'on')
  const off = flagBool(p, 'off')
  if (on && off) throw usageError('--on 与 --off 不能同时给', null)
  if (on) return true
  if (off) return false
  // 缺省必须显式补上：PUT 是整条替换，`enabled` 不写就等于「这条规则不生效」（协议 §5.4 C12）
  return current === true
}

interface ActionPlan {
  action: Record<string, unknown>
  form: RespForm
  /** 实际生效的命中方式（写进 JSON 输出，agent 不必自己推） */
  mode: string | null
  note: string | null
}

/**
 * 把构造好的返回值数组按**控制台的存储形态**落进 action（ADR-025 的两态）：
 * - 1 条 + 固定 → `{mode:'static', response:{…}}`，并且**删掉 responses**（留着的旧数组会盖住新值）
 * - 多条 + 指定 → `{mode:'specific', responses:[…], pinIndex}`
 * - 多条 + 序列 → `{mode:'sequence', seqMode, responses:[…]}`
 *
 * `build === null` 表示这次不动返回值，只改 mode/seqMode/pinIndex/delayMs 这些命中方式参数。
 */
function planAction(
  base: Record<string, unknown>,
  build: BuildResult | null,
  p: Parsed,
): ActionPlan {
  const action: Record<string, unknown> = { ...base }
  let note: string | null = null

  const delay = readIntFlag(p, 'delay-ms', { min: 0 })
  if (delay !== null) action.delayMs = delay

  const modeFlag = readModeFlag(p)
  const seqFlag = readSeqModeFlag(p)
  const pinFlag = readIntFlag(p, 'pin-index', { min: 0 })

  if (build === null) {
    if (modeFlag !== null) action.mode = modeFlag
    if (seqFlag !== null) action.seqMode = seqFlag
    if (pinFlag !== null) action.pinIndex = pinFlag
    const read = existingResponses(action)
    return { action, form: read.form, mode: s(action, 'mode'), note }
  }

  const count = build.responses.length
  let mode: Mode3 = modeFlag ?? (count === 1 ? 'static' : 'sequence')
  if (mode === 'static' && count !== 1) {
    throw usageError(
      `--mode static 只能配 1 条返回值，现在给了 ${count} 条`,
      '多条时：--mode sequence（按序列推进）或 --mode specific（固定返回第 pinIndex 条）',
    )
  }
  // 与控制台一致：1 条 + 指定 = 旧形态单条，不写 responses 数组
  if (mode === 'specific' && count === 1) {
    mode = 'static'
    note = '只有 1 条返回值，按控制台的形态存成 mode=static + action.response'
  }

  const responses = build.responses
  if (mode === 'static') {
    action.mode = 'static'
    action.response = responses[0]
    delete action.responses
    delete action.pinIndex
    delete action.seqMode
    return { action, form: 'single', mode: 'static', note }
  }
  delete action.response
  action.responses = responses
  if (mode === 'specific') {
    delete action.seqMode
    const basePin = n(action, 'pinIndex')
    const pin = pinFlag ?? basePin ?? 0
    action.mode = 'specific'
    action.pinIndex = pin
    if (pin >= count) {
      note = `pinIndex=${pin} 超出返回值条数 ${count}，服务端会夹到最后一条（读回就是这个值）`
    }
  } else {
    delete action.pinIndex
    const baseSeq = s(action, 'seqMode')
    action.mode = 'sequence'
    action.seqMode = seqFlag ?? baseSeq ?? 'in-order'
  }
  return { action, form: 'responses', mode, note }
}

/** 读回的那条规则（原样，含未知字段）；查无此条返回 null */
async function readOne(client: ManagementClient, id: string): Promise<Record<string, unknown> | null> {
  const { raw } = await readRules(client)
  return raw.find((r) => s(r, 'id') === id) ?? null
}

/** 只比对「我提交过的键」：服务端会补 id，别多改一个键就误报 */
function diffSubmitted(want: unknown, got: unknown, path: string, skip: string[], out: string[]): void {
  if (skip.includes(path)) return
  if (want && typeof want === 'object' && !Array.isArray(want)) {
    if (!got || typeof got !== 'object' || Array.isArray(got)) {
      out.push(`${path}：期望对象，读到 ${got === null ? 'null' : Array.isArray(got) ? '数组' : typeof got}`)
      return
    }
    const a = want as Record<string, unknown>
    const b = got as Record<string, unknown>
    for (const k of Object.keys(a)) diffSubmitted(a[k], b[k], `${path}.${k}`, skip, out)
    return
  }
  if (Array.isArray(want)) {
    if (!Array.isArray(got)) {
      out.push(`${path}：期望数组（${want.length} 项），读到 ${got === null ? 'null' : Array.isArray(got) ? '数组' : typeof got}`)
      return
    }
    if (got.length !== want.length) {
      out.push(`${path}：期望 ${want.length} 项，读到 ${got.length} 项`)
      return
    }
    for (let i = 0; i < want.length; i++) diffSubmitted(want[i], got[i], `${path}[${i}]`, skip, out)
    return
  }
  if (JSON.stringify(want) !== JSON.stringify(got)) {
    out.push(`${path}：期望 ${JSON.stringify(want)}，读到 ${JSON.stringify(got)}`)
  }
}

/**
 * 提交后独立读回，逐字段比对。返回值数组交给 responses.ts 的专用比对（报错文案要能对上
 * 四条数组的下标），其余字段（含 `action.mode` / `seqMode` / `pinIndex` / `delayMs`）走通用比对——
 * **命中方式漏核会静默变成「指定第 0 条」**，这是最容易骗过人的地方。
 *
 * 这是 skill「写完必须读回核对」那条原则的落地，也是本 CLI 不撒谎的机制：
 * 服务端 200 只代表「收下了」，不代表「按你给的存下来了」。
 */
async function verifyWrite(
  client: ManagementClient,
  id: string,
  submitted: Record<string, unknown>,
  build: BuildResult | null,
  form: RespForm,
): Promise<Record<string, unknown>> {
  const got = await readOne(client, id)
  const skip = ['action.responses', 'action.response']
  const diffs: string[] = []
  if (!got) {
    diffs.push('读回时这条规则已经不在了（可能刚被另一台控制台整表覆盖，ADR-019）')
  } else {
    diffSubmitted(submitted, got, 'rule', skip, diffs)
    if (build && (form === 'responses' || form === 'single')) diffs.push(...diffAgainstServer(build, got, form))
  }
  if (diffs.length || !got) {
    throw verifyError(
      `提交后读回不一致（规则 ${id}）：${diffs.slice(0, 6).join('；')}${diffs.length > 6 ? `；另有 ${diffs.length - 6} 处` : ''}`,
      '可能原因：这条规则在读写之间被另一台控制台改过（PUT 是整条替换）；先 mock api get 看服务端现在存的是什么',
    )
  }
  return got
}

function buildFromFlags(p: Parsed, existing: Record<string, unknown>[]): BuildResult | null {
  const statuses = readIntListFlag(p, 'status', { min: 100, max: 599 })
  const contentTypes = flagList(p, 'content-type')
  return buildResponses(arraysFromArgs(p), existing, {
    status: statuses,
    contentType: contentTypes.length ? contentTypes : null,
    allowEmptyBody: flagBool(p, 'allow-empty-body'),
  })
}

/** `POST /__ec/api/rules` 的返回：`{ok, rule}`，rule 是服务端存下来那份（含生成的 id） */
function createdId(payload: unknown): string {
  const rule = obj(payload as Record<string, unknown>, 'rule')
  return rule ? s(rule, 'id') ?? '' : ''
}

/**
 * 新建规则的**归属**（C14 / 协议 §4.7 POST 行）：`rule.groupId` 必须指向调用者的某个私有项目。
 *
 * 为什么这件事要在 CLI 侧也拦一遍：服务端会 400，但 agent 拿到 400 之后常见的补救动作是
 * 「换个参数再试」，而这里的正解是「先有一个私有项目」。把缺项目 / 多个项目 / 指向共享
 * 三种情况分开报错，每条都带下一步命令。
 */
async function resolveCreateProject(
  client: ManagementClient,
  store: ConfigStore,
  groupId: string | null,
): Promise<GroupView> {
  if (groupId === '') {
    throw usageError(
      'api create 的 --group-id 不能是空串',
      'C14 起规则必须挂在私有项目里（无归属 = 永不命中，服务端也会 400）。要给项目：--group-id <私有项目id>；还没有就先 mock group create --name <名字> --on',
    )
  }
  // 显式给了 id → 核对「存在且是我的私有项目」；没给 → 只在有唯一答案时才推
  return groupId ? assertProjectWritable(client, groupId, '新建规则') : defaultWritableProject(client, store, '新建规则')
}

async function apiCreate(client: ManagementClient, store: ConfigStore, p: Parsed, mode: Mode, groupId: string | null): Promise<number> {
  const build = buildFromFlags(p, [])
  if (!build) {
    throw usageError('api create 至少要给一条返回值', `如 mock api create --path /api/login --json-list '{"code":0}' --json`)
  }
  const match = overlayMatch({}, p)
  await guardMatchAll(match, p, '新建的')
  const { action, form, mode: hitMode, note } = planAction({ type: 'mock' }, build, p)

  const rule: Record<string, unknown> = {
    enabled: enabledFromFlags(p, true),
    priority: readIntFlag(p, 'priority') ?? 0,
    match,
    action,
  }
  const name = flagStr(p, 'name')
  if (name !== null && name !== '') rule.name = name

  const target = await resolveCreateProject(client, store, groupId)
  rule.groupId = target.id

  const id = createdId(await client.call('POST', '/__ec/api/rules', { body: { rule } }))
  if (!id) {
    throw verifyError('新建后服务端没返回规则 id', '跑 mock api list --json 看服务端实际存成什么样')
  }

  const got = await verifyWrite(client, id, rule, build, form)
  const summary = ruleView(got)
  emit(
    {
      ok: true,
      id,
      mode: hitMode,
      groupId: s(got, 'groupId'),
      scope: target.scope,
      rule: got,
      arrays: arraySummary(build, summary?.responses ?? 0),
      note,
    },
    mode,
    () => {
      info(
        `已新建规则 ${id}（${summary ? matchLine(summary) : '匹配条件见 --json'}，${summary?.responses ?? 0} 条返回值，命中方式 ${hitMode ?? '-'}` +
          `，项目 ${target.id}），已读回确认`,
      )
      if (note) info(`注意：${note}`)
      if (target.enabled === false) info(`注意：项目 ${target.id} 当前是**关**的，这条规则虽然 enabled=✓ 但眼下不命中（mock group switch ${target.id} --on）`)
    },
  )
  return EXIT.OK
}

async function apiUpdate(client: ManagementClient, p: Parsed, mode: Mode, groupId: string | null): Promise<number> {
  const id = requirePositional(p, 0, '规则 id', 'mock api update r_login --json-list \'{"code":0}\' --json')
  const before = await readRules(client)
  const index = before.raw.findIndex((r) => s(r, 'id') === id)
  if (index < 0) {
    throw notFoundError(`没有这条规则：${id}`, `我的私有项目里共 ${before.views.length} 条；先跑 mock api list 拿 id`)
  }
  const current = before.raw[index] as Record<string, unknown>
  const currentAction = obj(current, 'action')
  const existing = existingResponses(currentAction).items

  const build = buildFromFlags(p, existing)
  // status / content-type 现在是可重复的 list flag，判「有没有给」要用 flagList——
  // 沿用 flagStr 会永远读成 null，这条守卫就成了装饰
  const gaveStatus = flagList(p, 'status').length > 0
  const gaveContentType = flagList(p, 'content-type').length > 0
  if (!build && (gaveStatus || gaveContentType)) {
    // 只带 --status / --content-type 而没有返回值可改：这条命令的意图无法完成，
    // 不能默默当成「什么都没改」返回成功
    throw usageError(
      '给了 --status / --content-type，但这条规则没有任何返回值可改，也没传 --json-list',
      '先给它写返回值：--json-list \'{"code":0}\'；只想改匹配条件就别带这两个参数',
    )
  }

  // 删返回值是真删除：条数变少要先确认（skill 的约定：不许静默把第 0 条之外的组丢掉）
  if (build && build.removed > 0) {
    await confirmOrDie(p, `把返回值从 ${existing.length} 条改成 ${build.responses.length} 条（会丢掉后 ${build.removed} 条）`)
  }

  // 先算出要写什么，再动笔：`--mode` 之类的非法组合要在「一次写入都没有」的时候就失败，
  // 否则前面已经把这条规则改成半成品、后面才报错（读改写最容易出半态）
  const { action, form, mode: hitMode, note } = planAction(currentAction ?? { type: 'mock' }, build, p)
  const match = overlayMatch(obj(current, 'match') ?? {}, p)
  await guardMatchAll(match, p, '更新后的')

  // 读改写：以服务端那份为底，只覆盖命令行显式给的键（未知字段原样带走）
  const rule: Record<string, unknown> = { ...current }
  rule.enabled = enabledFromFlags(p, current.enabled)
  rule.priority = readIntFlag(p, 'priority') ?? n(current, 'priority') ?? 0
  const name = flagStr(p, 'name')
  if (name !== null) {
    if (name === '') delete rule.name
    else rule.name = name
  }
  rule.match = match
  rule.action = action

  // **归属字段在 C14 是只读的**：不给 `--group-id` = 原项目不动（读改写的默认，也是唯一合法形态）。
  // 空串（移出项目）与「改成别的项目」都在这里先拒绝，不留给服务端 400：
  // 前者等于批量制造永不命中的死条目，后者在新模型里就是「把别人项目里的规则搬走」。
  const currentGroupId = s(current, 'groupId') ?? ''
  if (groupId !== null) {
    if (groupId === '') {
      throw scopeMismatchError(
        `api update 不再支持把规则移出项目（--group-id ""）：规则 ${id} 眼下属于 ${currentGroupId || '（无归属）'}`,
        'C14 起无归属 = 永不命中，服务端也会 400 EC_SCOPE_MISMATCH。要清掉这条就 mock api delete ' + id +
          '；要整个项目连带规则一起清就 mock group delete <项目id> --yes',
      )
    }
    if (currentGroupId && groupId !== currentGroupId) {
      throw scopeMismatchError(
        `api update 不能把规则在项目之间挪动（${currentGroupId} → ${groupId}）`,
        '挪项目 = 把私有内容搬进另一个容器，新模型下这条路不通。要在新项目里用同一条规则：mock api copy ' + id + ' --group-id ' + groupId + '，再 mock api delete ' + id,
      )
    }
    rule.groupId = (await assertProjectWritable(client, groupId, '更新规则')).id
  }

  await client.call('PUT', `/__ec/api/rules/${encodeURIComponent(id)}`, { body: { rule } })

  const got = await verifyWrite(client, id, rule, build, form)
  const summary = ruleView(got)
  emit(
    {
      ok: true,
      id,
      mode: hitMode,
      enabled: rule.enabled,
      groupId: s(got, 'groupId'),
      rule: got,
      arrays: build ? arraySummary(build, summary?.responses ?? 0) : null,
      note,
    },
    mode,
    () => {
      info(
        `已更新规则 ${id}（${summary ? matchLine(summary) : ''}，${summary?.responses ?? 0} 条返回值，命中方式 ${hitMode ?? '-'}，` +
          `enabled=${rule.enabled ? '开' : '关'}，项目 ${s(got, 'groupId') ?? '无归属'}），已读回确认`,
      )
      if (note) info(`注意：${note}`)
    },
  )
  return EXIT.OK
}

async function apiCopy(client: ManagementClient, p: Parsed, mode: Mode, groupId: string | null): Promise<number> {
  const id = requirePositional(p, 0, '规则 id', 'mock api copy r_login --json')
  const before = await readRules(client)
  const source = before.raw.find((r) => s(r, 'id') === id)
  if (!source) {
    throw notFoundError(`没有这条规则：${id}`, `我的私有项目里共 ${before.views.length} 条；先跑 mock api list 拿 id`)
  }

  // 深拷贝：副本与原件此后各改各的，共享引用会让「改副本」动到原件
  let clone: Record<string, unknown>
  try {
    clone = JSON.parse(JSON.stringify(source)) as Record<string, unknown>
  } catch {
    throw new CliError('EC_BAD_RESPONSE', `规则 ${id} 无法复制（序列化失败，可能有循环引用）`, 'mock api get 看下这条规则', EXIT.SERVER)
  }
  delete clone.id
  const name = flagStr(p, 'name')
  clone.name = name !== null && name !== '' ? name : `${s(source, 'name') ?? id} 副本`

  // 归属（C14）：不给参数 = 连源项目一起复制（副本与源同项目，这是最常见形态）；
  // 给非空 = 挂到**我的另一个私有项目**里（新建一条规则到别的项目，不是把源那条搬走，所以合法）；
  // 空串 = 造一条无归属的死条目 → 拒绝。
  if (groupId === '') {
    throw scopeMismatchError(
      `api copy 的 --group-id 不能是空串：副本必须挂在私有项目里（无归属 = 永不命中）`,
      '不给这个参数就是「连源项目一起复制」；要挂到别的项目就写项目 id：mock api copy ' + id + ' --group-id <私有项目id>',
    )
  }
  if (groupId) clone.groupId = (await assertProjectWritable(client, groupId, '复制规则')).id

  const newId = createdId(await client.call('POST', '/__ec/api/rules', { body: { rule: clone } }))
  if (!newId) throw verifyError('复制后服务端没返回新规则 id', '跑 mock api list --json 确认这条规则到底有没有建成')

  const got = await readOne(client, newId)
  const diffs: string[] = []
  if (!got) diffs.push('复制后读不到新规则')
  // 逐字段比对提交出去的那份（clone 里没有 id，服务端补的 id 因此不参与比对）：
  // 读回与提交有任何一处不同，就不算复制成功
  else diffSubmitted(clone, got, 'rule', [], diffs)
  const stillThere = await readOne(client, id)
  if (!stillThere) diffs.push(`原件 ${id} 在复制过程中消失了`)
  if (diffs.length) {
    throw verifyError(`复制后读回不一致：${diffs.slice(0, 6).join('；')}`, '先 mock api get 两条规则对比 --json 输出')
  }

  const summary = ruleView(got as Record<string, unknown>)
  emit(
    {
      ok: true,
      id: newId,
      from: id,
      name: clone.name,
      groupId: s(got as Record<string, unknown>, 'groupId'),
      rule: got,
      responses: summary?.responses ?? 0,
    },
    mode,
    () =>
      info(
        `已复制规则 ${id} → ${newId}（${clone.name}，${summary?.responses ?? 0} 条返回值，` +
          `项目 ${summary?.groupId ?? '无归属'}），已读回确认`,
      ),
  )
  return EXIT.OK
}
