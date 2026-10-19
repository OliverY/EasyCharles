import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
// 值导入（不是 `import type`）：`constructor(dataDir)` 不传分组时要自建一份 `GroupStore`，
// 否则 `tools/selftest.ts` 里那二十来处 `new RuleEngine(dir)` 全都要改。
// groups.ts 只依赖 types.ts / json-file.ts / ec-error.ts，不成环。
import { GroupStore } from './groups.ts'
import { writeJsonAtomic } from './json-file.ts'
import { scopeMismatch } from './ec-error.ts'
import type { MockResponse, Rule, SeqMode } from './types.ts'

const regexCache = new Map<string, RegExp>()

function globToRegex(pattern: string): RegExp {
  const cached = regexCache.get(pattern)
  if (cached) return cached
  let out = ''
  for (const ch of pattern) {
    if (ch === '*') out += '.*'
    else if (ch === '?') out += '.'
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  const re = new RegExp(`^${out}$`)
  regexCache.set(pattern, re)
  return re
}

function matchOne(pattern: unknown, value: string): boolean {
  // 未配置 → 通配
  if (pattern === undefined || pattern === null || pattern === '') return true
  // 脏数据（非字符串，如数字/对象）→ 视为「永不命中」，而不是通配：
  // 非法规则不得意外 mock 掉全部请求（AGENTS.md §4）
  if (typeof pattern !== 'string') return false
  if (pattern.startsWith('re:')) {
    // 非法正则（如 "re:("）不能让数据面每条请求都 500
    try {
      return new RegExp(pattern.slice(3)).test(value)
    } catch {
      return false
    }
  }
  return globToRegex(pattern).test(value)
}

/**
 * 入参匹配（协议 §5.4 / ADR-016）。
 *
 * - `pattern` 未配置或不是对象（含数组/标量脏数据）→ 视为不校验入参
 * - **AND 语义**：`pattern` 里出现的每个 key 都必须在 `actual` 中存在
 * - value 为空串 / null → 只要求「该参数存在」，不校验取值
 * - value 为标量 → 转字符串后按 `glob` / `re:` 匹配（与 host/path 同一套语法）
 * - value 为对象/数组（脏数据）→ 退化为「只要求存在」，不抛错
 *
 * 该函数只处理「已经合并好的入参表」，不认识「业务参数 / 公共参数」的划分
 * ——那是控制台本地知识（ADR-016 边界）。
 */
function matchParams(pattern: unknown, actual: Record<string, string>): boolean {
  if (!pattern || typeof pattern !== 'object' || Array.isArray(pattern)) return true
  for (const [k, v] of Object.entries(pattern as Record<string, unknown>)) {
    if (!Object.prototype.hasOwnProperty.call(actual, k)) return false
    if (v === null || v === undefined || typeof v === 'object') continue
    const s = String(v)
    if (s === '') continue
    if (!matchOne(s, actual[k])) return false
  }
  return true
}

/**
 * 取 `action.responses` 里的合法条目，脏数据一律当**空列表**处理。
 *
 * `responses` 非数组（对象 / 标量）、元素非普通对象（数字 / null / 数组）都不得抛错，
 * 也不得原样返回：rules.json 可能被手改坏，读路径必须扛住（AGENTS.md §4）。
 * 写入口 `replaceAll` 已把这类结构挡在 400，这里是最后一道兜底。
 */
function responseList(action: unknown): MockResponse[] {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return []
  const raw = (action as { responses?: unknown }).responses
  if (!Array.isArray(raw)) return []
  return raw.filter((r): r is MockResponse => !!r && typeof r === 'object' && !Array.isArray(r))
}

/**
 * 下标 clamp 到 `[0, len-1]`：非数字 / NaN / 负数 / 超界一律夹回来，绝不返回 undefined。
 * 一条越界的 `pinIndex` 不能让数据面 500，也不能静默 mock 到别的条目之外。
 */
function clampIndex(v: unknown, len: number): number {
  if (len <= 0) return 0
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0
  const i = Math.trunc(v)
  if (i <= 0) return 0
  return i >= len ? len - 1 : i
}

/**
 * 单条规则的结构校验（**三个写入口共用**：`replaceAll` / `create` / `replaceOne`）。
 *
 * 为什么必须共用：写入口在 LAN 下任何持有会话的客户端都能打（也包括 mock CLI 与脚本），
 * 非法结构会直接毒化内存与 `rules.json`，导致数据面每条请求 500 且重启无法自愈（F-15）。
 * 新加一个写入口却复用不了这套校验，就等于开了一个没设防的门——两处口径一旦分叉，
 * 「PUT 拒绝的规则 POST 收下」这种问题只有等它瘫了才会被发现。
 *
 * `where` 是报错前缀（全量替换传 `rules[3]`，单条传 `rule`），保持既有 400 文案不变。
 *
 * 校验范围只到**结构**（是对象 / 是数组 / 是有限数 / 是字符串），数字越界由读路径 clamp
 * （`clampIndex`），语义归控制台与协议 §5.4 负责。
 * **唯一的例外是 `action.type` 的枚举**：类型写错（比如把 action.mode 的 `'static'` 挪到 type 上）
 * 会被 `resolve()` 当透传静默放行——命中了规则却不返回 mock、不报错、日志也看不出，
 * 正是 F-15 那类「落盘后重启也救不回来」的静默失效，必须在写入口挡下。
 * 缺省（undefined / null）仍宽容：`validateRuleSet` 还要校验从磁盘读回的存量快照，
 * 老数据可能没有这个字段，读路径对缺 type 的既有语义（当透传）不变。
 */
function validateRuleShape(r: unknown, where: string): void {
  if (!r || typeof r !== 'object' || Array.isArray(r)) {
    throw Object.assign(new Error(`${where} must be an object`), { statusCode: 400 })
  }
  // groupId（C13 / ADR-030 → C14 / ADR-033）：这里**只校验结构**——存在时必须是字符串。
  // 「这条规则归谁」是**归属**校验，不在结构校验这一层：它需要分组表与会话手机号，
  // 所以做在 `requirePrivateGroup()`（三个客户端写入口都调它）。
  // 分成两层是有意的：结构校验对**任何**写入者都一样（含版本服务的内部写入，它写的共享内容
  // 本来就不属于任何人的私有区），归属校验只对客户端可达的入口生效。
  const gid = (r as { groupId?: unknown }).groupId
  if (gid !== undefined && gid !== null && typeof gid !== 'string') {
    throw Object.assign(new Error(`${where}.groupId must be a string`), { statusCode: 400 })
  }
  const m = (r as { match?: unknown }).match
  if (m !== undefined && m !== null && typeof m === 'object' && !Array.isArray(m)) {
    const p = (m as { params?: unknown }).params
    if (p !== undefined && p !== null && (typeof p !== 'object' || Array.isArray(p))) {
      throw Object.assign(new Error(`${where}.match.params must be an object`), { statusCode: 400 })
    }
  }
  // action 是标量/数组时不可达（读路径按「缺 action」处理，与既有行为一致），
  // 只校验可达的多返回值字段
  const a = (r as { action?: unknown }).action
  if (a !== undefined && a !== null && typeof a === 'object' && !Array.isArray(a)) {
    const type = (a as { type?: unknown }).type
    if (type !== undefined && type !== null && type !== 'mock' && type !== 'passthrough') {
      throw Object.assign(new Error(`${where}.action.type must be 'mock' or 'passthrough'`), { statusCode: 400 })
    }
    const responses = (a as { responses?: unknown }).responses
    if (responses !== undefined && responses !== null) {
      if (!Array.isArray(responses)) {
        throw Object.assign(new Error(`${where}.action.responses must be an array`), { statusCode: 400 })
      }
      for (const [j, item] of responses.entries()) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          throw Object.assign(new Error(`${where}.action.responses[${j}] must be an object`), {
            statusCode: 400,
          })
        }
        // cond（C12）：**只校验形状，不参与选路**。P4 才解释里面的条件文本，
        // 现在只做「存得下、读得回」，所以这里只挡会让 JSON 变形的结构
        const cond = (item as { cond?: unknown }).cond
        if (cond !== undefined && cond !== null) {
          if (typeof cond !== 'object' || Array.isArray(cond)) {
            throw Object.assign(new Error(`${where}.action.responses[${j}].cond must be an object`), { statusCode: 400 })
          }
          for (const key of ['query', 'content'] as const) {
            const v = (cond as Record<string, unknown>)[key]
            if (v !== undefined && v !== null && typeof v !== 'string') {
              throw Object.assign(new Error(`${where}.action.responses[${j}].cond.${key} must be a string`), {
                statusCode: 400,
              })
            }
          }
        }
      }
    }
    const pinIndex = (a as { pinIndex?: unknown }).pinIndex
    if (pinIndex !== undefined && pinIndex !== null && (typeof pinIndex !== 'number' || !Number.isFinite(pinIndex))) {
      throw Object.assign(new Error(`${where}.action.pinIndex must be a finite number`), { statusCode: 400 })
    }
  }
}

/**
 * 一整表规则的结构校验（版本服务在**提交之前**用它，协议 §5.5 的原子提交第 1 步）。
 *
 * 为什么要单独导出：share / rollback 的新状态由服务端自己拼装，理论上「都是内部造的」，
 * 但它的原料是从磁盘读回来的存量规则与被手改过的快照，一样要过同一套结构校验——
 * 少这一道，一条被改坏的快照就能把 `rules.json` 毒化到重启不自愈（F-15 的形态）。
 */
export function validateRuleSet(rules: unknown, where = 'rules'): void {
  if (!Array.isArray(rules)) {
    throw Object.assign(new Error(`${where} must be an array`), { statusCode: 400 })
  }
  for (const [i, r] of rules.entries()) validateRuleShape(r, `${where}[${i}]`)
}

/**
 * 把 `groupId: ''` 归一为「无归属」= **删掉这个字段**（协议 §5.4）。
 *
 * 为什么要删而不是存空串：整表写入的语义是「给什么存什么」，若允许存空串，
 * `rules.json` 里就同时存在「没有这个字段」和「有这个字段但为空」两种无归属，
 * 读路径与 CLI 的读回比对都要多一个分支。
 *
 * ⚠️ C14 之后「无 `groupId`」**不再是「未分组、照常命中」，而是「无归属 ⇒ 永不命中」**
 * （协议 §5.4 那条结论翻转）。所以这个归一只留给**内部整表写入**（`replaceAll` / 版本服务）：
 * 客户端可达的入口一律先经 `requirePrivateGroup()` 挡掉空归属，不给它归一的机会。
 * 传进来的对象是本次请求 `JSON.parse` 出来的，原地删不影响任何调用方。
 */
function normalizeGroupId(r: unknown): void {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return
  const o = r as { groupId?: unknown }
  if (o.groupId === '' || o.groupId === null) delete o.groupId
}

export class RuleEngine {
  private rules: Rule[] = []
  /** 顺序 mock 指针：key = `${deviceId}:${ruleId}` */
  private pointers = new Map<string, number>()
  private file: string
  /**
   * 分组表（ADR-030）。**不传就自建一个**（读同一 `dataDir` 下的 `groups.json`），
   * 这样 `tools/selftest.ts` 里那二十来处 `new RuleEngine(dir)` 一行都不用改。
   * 服务端入口（`index.ts`）传的是与管理面共用的那一份——必须是同一实例，
   * 否则「关一个组」只写进了另一份内存，数据面看到的还是旧的。
   */
  private groups: GroupStore

  constructor(dataDir: string, groups?: GroupStore) {
    mkdirSync(dataDir, { recursive: true })
    this.file = join(dataDir, 'rules.json')
    this.groups = groups ?? new GroupStore(dataDir)
    this.load()
  }

  /**
   * 从磁盘加载规则。文件不存在 / 解析失败 / 非数组 → 一律回退到**空列表**。
   *
   * 不再注入内置示例规则（ADR-020）：空就是空，控制台列表里不会凭空出现
   * 用户没建过的规则。首次启动即是空列表，规则由用户自行创建。
   */
  private load(): void {
    if (existsSync(this.file)) {
      let parsed: unknown
      try {
        parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      } catch {
        parsed = null
      }
      this.rules = Array.isArray(parsed) ? (parsed as Rule[]) : []
    }
  }

  /** 临时文件 + rename（协议 §5.5 / 架构 §6.3：journal 提交这一步必须是原子写） */
  private persist(): void {
    writeJsonAtomic(this.file, this.rules)
  }

  list(): Rule[] {
    return this.rules
  }

  /**
   * 某个会话**看得见**的规则 = 挂在他的私有项目下的那些（协议 §4.7：`GET /rules` 只回自己的私有规则）。
   *
   * 共享规则不在这里——它们要经 `/groups/:id/rules` 按项目读。这不是为了少发数据，
   * 而是「一次拿到全服所有返回值」这个入口本身就不该存在（共享库变大后，
   * 一次全量下发等于把所有人的返回值整片搬进每个登录用户的内存与日志）。
   * 脏会话（非字符串 / 空串）→ 空表。
   */
  listForOwner(phone: unknown): Rule[] {
    if (typeof phone !== 'string' || !phone) return []
    return this.rules.filter((r) => {
      if (!r || typeof r !== 'object') return false
      const g = this.groups.get(r.groupId)
      return !!g && g.scope === 'private' && g.ownerPhone === phone
    })
  }

  /** 某个项目下的规则（`GET /groups/:id/rules` 用；**权限由调用方判**，这里只按 groupId 过滤） */
  listOfGroup(groupId: unknown): Rule[] {
    const key = typeof groupId === 'string' ? groupId : ''
    if (!key) return []
    return this.rules.filter((r) => r && typeof r === 'object' && r.groupId === key)
  }

  /**
   * 这条 `groupId` 指向的项目，**当且仅当它是 `phone` 的私有项目**；否则 `undefined`。
   *
   * 三个客户端写入口共用它——「写权限来自这条规则属于我的私有项目，不来自 role」
   * （ADR-033 决策 5/7）。共享项目在这里一律不算数：共享内容只能由 share / rollback 产生。
   */
  private privateGroupOf(groupId: unknown, phone: unknown) {
    const gid = typeof groupId === 'string' ? groupId : ''
    if (!gid || typeof phone !== 'string' || !phone) return undefined
    const g = this.groups.get(gid)
    if (!g || g.scope !== 'private' || g.ownerPhone !== phone) return undefined
    return g
  }

  /**
   * 写入口的归属栅栏：不过就 `400 EC_SCOPE_MISMATCH`（协议 §6.1）。
   *
   * 报错文案要**分开**写清三种情况（无 groupId / 指向共享 / 指向他人或不存在），
   * 但绝不能说出他人私有项目的存在性——「指向他人项目」与「不存在」走同一句文案。
   */
  private requirePrivateGroup(groupId: unknown, phone: unknown, where: string): string {
    const gid = typeof groupId === 'string' ? groupId : ''
    if (!gid) throw scopeMismatch(`${where}.groupId must be one of your private projects`)
    const g = this.groups.get(gid)
    if (!g) throw scopeMismatch(`${where}.groupId (${gid}) does not exist`)
    if (g.scope === 'shared') throw scopeMismatch(`${where}.groupId is a shared project; copy it to your own projects first`)
    if (typeof phone !== 'string' || !phone || g.ownerPhone !== phone) throw scopeMismatch(`${where}.groupId is not one of your private projects`)
    return gid
  }

  /** 新规则 id（版本服务建共享条目 / 复制副本时也要用同一条碰撞检查口径，不能各写一份） */
  newRuleId(): string {
    return this.freshId()
  }

  /**
   * ⚠️ **内部整表写入**，不作用于任何归属范围：只允许版本服务、journal 恢复与测试夹具调用。
   *
   * 管理面的 `PUT /__ec/api/rules` **不再走这里**，改走 `replacePrivateScope()`
   * （ADR-033 决策 7：不得保留任何可由普通用户全表覆盖 `rules.json` 的路径——
   * 按用户过滤后还留着全局替换，等于让任何登录用户一键删掉所有人看不见的规则）。
   *
   * 仅接受数组，且每条必须过 `validateRuleShape`（见该函数注释，F-15 的那道防线一字未改）。
   */
  replaceAll(input: unknown): void {
    if (!Array.isArray(input)) {
      throw Object.assign(new Error('rules must be an array'), { statusCode: 400 })
    }
    for (const [i, r] of input.entries()) validateRuleShape(r, `rules[${i}]`)
    for (const r of input) normalizeGroupId(r)
    this.rules = input as Rule[]
    this.persist()
  }

  /**
   * **私有范围替换**（`PUT /__ec/api/rules` 的 C14 语义，协议 §4.7）。
   *
   * 与旧的整表覆盖差在哪：旧口径「给什么存什么」在按用户过滤之后会删掉调用者**看不见**的规则
   * （别人的私有项目、共享内容）——那不是替换，那是越权清空。这里只替换调用者自己私有项目下的
   * 规则，其余逐条原样保留。
   *
   * 入参里每条都必须属于调用者的私有项目，且 id 不得重复，任一项违例 → `400 EC_SCOPE_MISMATCH`
   * 且**一条也不写**（不做「成功的几条算几条」，那是 F-15 的形态）。
   *
   * 顺序指针**不重置**（协议 §5.4「拖动排序不重置指针」），也不动别人的指针。
   */
  replacePrivateScope(input: unknown, phone: unknown): { replaced: number; preserved: number } {
    if (!Array.isArray(input)) {
      throw Object.assign(new Error('rules must be an array'), { statusCode: 400 })
    }
    for (const [i, r] of input.entries()) validateRuleShape(r, `rules[${i}]`)
    const mine = typeof phone === 'string' ? phone : ''
    const seen = new Set<string>()
    for (const [i, raw] of input.entries()) {
      const r = raw as { id?: unknown; groupId?: unknown }
      if (seen.has(String(r.id))) throw scopeMismatch(`rules[${i}].id (${r.id}) is duplicated`)
      seen.add(String(r.id))
      this.requirePrivateGroup(r.groupId, mine, `rules[${i}]`)
    }
    // 「不属于我的私有项目」的全部原样留着：共享内容、他人私有规则、
    // 以及迁移前就存在的无归属脏条目（它们永不命中，但也不是本次调用者可以删掉的东西）
    const preserved = this.rules.filter((r) => {
      if (!r || typeof r !== 'object') return true
      return !this.privateGroupOf(r.groupId, mine)
    })
    this.rules = [...preserved, ...(input as Rule[])]
    this.persist()
    return { replaced: input.length, preserved: preserved.length }
  }

  /** 当前全表快照（深拷贝），pending journal 的 `after` 就存这个 */
  state(): Rule[] {
    return JSON.parse(JSON.stringify(this.rules)) as Rule[]
  }

  /**
   * 整表恢复（journal 重放 / 回滚的唯一入口，也是 `replaceAll` 之外第二条内部写路径）。
   * 逐条过结构校验，非法条目丢弃而不是抛错——**恢复路径崩掉 = 服务起不来**，
   * 比丢一条脏规则严重得多（AGENTS.md §4，F-16 的教训）。
   */
  restore(rules: unknown): void {
    if (!Array.isArray(rules)) throw Object.assign(new Error('rules state must be an array'), { statusCode: 500 })
    const next: Rule[] = []
    for (const r of rules) {
      if (!r || typeof r !== 'object' || Array.isArray(r)) continue
      if (typeof (r as { id?: unknown }).id !== 'string' || !(r as { id: string }).id) continue
      next.push(r as Rule)
    }
    this.rules = next
    this.persist()
  }

  /**
   * 生成一个不与现有规则相撞的 id。
   *
   * 格式与控制台 `newRuleId()` 一致（`r_<base36 时间><4 位随机>`），这是**刻意的**：
   * 两处格式不同会让「哪个客户端建的」在 rules.json 里看得出来，而控制台的
   * 「同名接口推荐 / 序列指针」等只认 `r_` 前缀的显示逻辑就会出现偏差。
   * 控制台那边不做碰撞检查（人手点按钮撞不上），服务端建条目是**批量 + 脚本**场景，必须查。
   */
  private freshId(): string {
    const taken = new Set(
      this.rules.map((r) => (r && typeof r === 'object' ? (r as Rule).id : undefined)).filter((x): x is string => typeof x === 'string'),
    )
    for (let i = 0; i < 500; i++) {
      const id = 'r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
      if (!taken.has(id)) return id
    }
    throw Object.assign(new Error('cannot allocate rule id'), { statusCode: 500 })
  }

  /**
   * 新建单条（C12 / **C14 收窄到私有项目**）。id 由服务端生成，**调用方给了非空 id 直接 400**。
   *
   * 为什么不接受调用方指定 id：撞 id 时 `remove` / `setEnabled` 的 `findIndex`
   * 只命中第一条，「删了 A 结果 B 还在」这类现象比一句 400 难查得多；
   * 而「复制一条规则」的正常做法就是 POST 一份去掉 id 的规则（协议 §7）。
   *
   * C14 新增的这道栅栏（协议 §4.7 POST 行）：`rule.groupId` **必须**指向调用者的私有项目。
   * 不带 groupId、指向共享项目、指向他人项目都是 `400 EC_SCOPE_MISMATCH`，**不是静默丢弃**——
   * 「不允许新建无归属规则」是新模型的硬约束，静默收下就会造出一条永不命中的规则。
   */
  create(input: unknown, phone: unknown): Rule {
    validateRuleShape(input, 'rule')
    const raw = input as Record<string, unknown>
    const bodyId = raw.id
    if (bodyId !== undefined && bodyId !== null && bodyId !== '') {
      throw Object.assign(new Error('rule.id must be omitted on create; use PUT /__ec/api/rules/:id to set the id'), {
        statusCode: 400,
      })
    }
    const groupId = this.requirePrivateGroup(raw.groupId, phone, 'rule')
    const stored = { ...raw, id: this.freshId(), groupId } as Rule
    this.rules.push(stored)
    this.persist()
    return stored
  }

  /**
   * 整条替换（C12）。**给什么存什么**：未提供的字段就是没有，
   * 尤其 `enabled` 缺失 = 这条规则不生效（`resolve()` 只认真值，与私有范围替换同口径）。
   *
   * id 以路径为准：body 里 `id` 缺失就用路径补上，与路径不一致就 400——
   * 否则「改 A」会变成「新增一条 B，A 原封不动」，调用方看返回 200 还以为改成功了。
   * 顺序指针**不重置**，与「拖动排序不重置指针」同一条既定语义（协议 §5.4）：
   * 重置会打断别的设备正在走的序列。需要归零用 `reset-pointers`。
   *
   * 返回 `null` 有两种，**对外同形（404）**：id 不存在、以及这条规则不属于调用者的私有项目
   * （协议 §4.7：不用 403 泄露「这个 id 是别人的」）。
   *
   * C14 的两条收窄：
   * - **`groupId` 不得改成别的项目**：跨项目挪规则等于把别人的私有规则搬走；
   * - **body 不带 `groupId` 时按原项目补齐**，而不是归一为「无归属」。这一条**故意偏离**
   *   「给什么存什么」：新模型里无归属 = 永不命中，让「忘记带这个字段」能把一条在用的规则
   *   悄悄改成不生效，正是协议 §5 定义的静默失效（架构 §5.5 坑点 1）。
   */
  replaceOne(id: unknown, input: unknown, phone: unknown): Rule | null {
    const key = typeof id === 'string' ? id : ''
    if (!key) throw Object.assign(new Error('missing rule id'), { statusCode: 400 })
    validateRuleShape(input, 'rule')
    const raw = input as Record<string, unknown>
    const bodyId = raw.id
    if (bodyId !== undefined && bodyId !== null && bodyId !== '') {
      if (typeof bodyId !== 'string') {
        throw Object.assign(new Error('rule.id must be a string'), { statusCode: 400 })
      }
      if (bodyId !== key) {
        throw Object.assign(new Error(`rule.id (${bodyId}) does not match path id (${key})`), { statusCode: 400 })
      }
    }
    const i = this.rules.findIndex((r) => r && typeof r === 'object' && (r as Rule).id === key)
    if (i < 0) return null
    const prev = this.rules[i]
    if (!this.privateGroupOf(prev.groupId, phone)) return null
    const groupId = typeof prev.groupId === 'string' ? prev.groupId : ''
    if (raw.groupId !== undefined && raw.groupId !== null && raw.groupId !== groupId) {
      throw scopeMismatch(`rule.groupId cannot be moved between projects (${groupId} → ${String(raw.groupId)})`)
    }
    const stored = { ...raw, id: key, groupId } as Rule
    this.rules[i] = stored
    this.persist()
    return stored
  }

  /**
   * 单条删除。返回是否命中（`false` = id 不存在，**或这条不属于调用者的私有项目**——
   * 两者对外同形 404，不用 403 泄露归属）。
   *
   * 存在的理由：控制台只走 `PUT`（整表替换）时，多开一个标签页就会出现
   * 「后写的一方把前者的改动整片覆盖」——删一条也会连带覆盖别人改的另一条。
   * 单条接口只动这一条（ADR-019）。
   *
   * 顺带丢弃该规则残留的**顺序指针**：不丢的话，「删掉再用同一个 id 重建」
   * 会从半截序列继续，表现为「新规则第一次请求就返回第 3 条」。
   * 指针 key 形如 `${deviceId}:${ruleId}`，这里按后缀匹配；规则 id 由控制台生成
   * （`r_xxx`，不含 `:`），不存在后缀歧义。
   */
  remove(id: unknown, phone: unknown): boolean {
    const key = typeof id === 'string' ? id : ''
    if (!key) return false
    const i = this.rules.findIndex((r) => r && typeof r === 'object' && (r as Rule).id === key)
    if (i < 0) return false
    if (!this.privateGroupOf(this.rules[i].groupId, phone)) return false
    this.rules.splice(i, 1)
    this.dropPointersOf(key)
    this.persist()
    return true
  }

  /** 丢掉某条规则的全部设备指针（key 后缀匹配，见 `remove` 的注释） */
  private dropPointersOf(ruleId: string): void {
    const suffix = ':' + ruleId
    for (const k of [...this.pointers.keys()]) {
      if (k.endsWith(suffix)) this.pointers.delete(k)
    }
  }

  /**
   * 单条开/关。命中返回变更后的规则；id 不存在**或不属于调用者**返回 `null`（对外 404）。
   *
   * `enabled` **只接受布尔**（`0/1` / `"true"` 一律 400）：写入口在 LAN 下任何
   * 持有会话的客户端都能打，宽松强转等于把「什么算开」交给调用方定义
   * （AGENTS.md §4）。这里与 `replacePrivateScope` 一样抛带 `statusCode` 的错误。
   */
  setEnabled(id: unknown, enabled: unknown, phone: unknown): Rule | null {
    if (typeof enabled !== 'boolean') {
      throw Object.assign(new Error('enabled must be a boolean'), { statusCode: 400 })
    }
    const key = typeof id === 'string' ? id : ''
    const rule = key
      ? this.rules.find((r) => r && typeof r === 'object' && (r as Rule).id === key)
      : undefined
    if (!rule) return null
    if (!this.privateGroupOf(rule.groupId, phone)) return null
    rule.enabled = enabled
    this.persist()
    return rule
  }

  /**
   * 重置顺序指针（C14 收窄）：**只清调用者私有规则**的指针。
   *
   * 旧的「一键清全服指针」在按用户隔离之后是越权：A 重置会把 B 正在走的序列归零，
   * 而 B 的控制台上什么都看不出来。共享项目的指针天然不存在（不参与命中就不会推进），
   * 这里不为其做特例——那条事实由用例锁住，不靠注释（架构 §5.5）。
   */
  resetPointers(phone: unknown): number {
    const mine = this.listForOwner(phone).map((r) => String(r.id))
    for (const id of mine) this.dropPointersOf(id)
    return mine.length
  }

  /**
   * 项目删除时的**级联处置**：删掉挂在该项目下的所有规则并丢弃其指针，返回条数。
   *
   * 取代 C13 的 `ungroup()`（清空 `groupId`、规则保留）。为什么必须换：新命中口径下
   * 「无归属」= **永不命中**，「删组不删规则」等于把一批规则变成控制台仍显示「已启用」、
   * 数据面却再也不走的死条目（ADR-033 决策 6，架构 §5.5 坑点 1）。
   * 指针按 `(deviceId, ruleId)` 存，规则删了不丢指针就是内存泄漏。
   */
  removeByGroup(groupId: unknown): number {
    const key = typeof groupId === 'string' ? groupId : ''
    if (!key) return 0
    const doomed = this.rules.filter((r) => r && typeof r === 'object' && r.groupId === key)
    if (!doomed.length) return 0
    this.rules = this.rules.filter((r) => !(r && typeof r === 'object' && r.groupId === key))
    for (const r of doomed) this.dropPointersOf(String(r.id))
    this.persist()
    return doomed.length
  }

  /**
   * 某个分组当前挂了多少条规则（`GET /__ec/api/groups` 的 `ruleCount`）。
   * 非字符串 / 空串 → 0，不抛。
   */
  countByGroup(groupId: unknown): number {
    const key = typeof groupId === 'string' ? groupId : ''
    if (!key) return 0
    return this.rules.filter((r) => r && typeof r === 'object' && r.groupId === key).length
  }

  /**
   * 这条规则能不能进**当前设备所有者**的候选集（协议 §5.4 的 C14 那条完整 AND）。
   *
   * 全部满足才算数，缺一项就是**不命中**：
   * 1. `groupId` 存在且指向一个真实项目（**C13 的「悬空 id 按未分组照常命中」在这里被翻转**，
   *    协议 §5.4 写明翻转的两个前置硬约束由迁移与控制台提供）；
   * 2. 该项目 `scope === 'private'` —— **共享项目与共享规则永不进候选集**，
   *    这是 C14 的立身之本，也是实现时最容易被「顺手支持一下」破掉的一条；
   * 3. 该项目 `ownerPhone === 当前设备 owner` —— owner 为 `null`（设备未绑定）时**候选集恒空**；
   * 4. 该项目 `enabled === true`（整组开关，C13 那条 AND 的原文仍在，只是前面多了归属这一项）。
   *
   * 这**不是鉴权**：数据面仍然不鉴权（ADR-015），owner 只从 `deviceId` 反查
   * （`store.deviceOwner()`），不存在「调用方声明我是谁」的入口（架构 §5.5）。
   */
  private hitEligible(rule: Rule, ownerPhone: unknown): boolean {
    if (typeof ownerPhone !== 'string' || !ownerPhone) return false
    const gid = typeof rule.groupId === 'string' ? rule.groupId : ''
    if (!gid) return false
    const g = this.groups.get(gid)
    if (!g || g.scope !== 'private' || g.ownerPhone !== ownerPhone) return false
    return g.enabled === true
  }

  /** 返回命中的规则；mock 规则附带本次应返回的响应 */
  resolve(input: {
    method: string
    host: string
    path: string
    deviceId: string
    /**
     * 当前设备归属的用户（手机号），由数据面用 `store.deviceOwner(deviceId)` 反查后传入。
     * `null` / 非字符串 = 未绑定设备 ⇒ 候选集为空 ⇒ 全部原样转发上游（这不是拒绝请求）。
     */
    ownerPhone: string | null
    /** 请求入参（query + body 合并），用于 match.params；缺省视为空表 */
    params?: Record<string, string>
  }): { rule: Rule; response: MockResponse | null } | null {
    const candidates = this.rules
      .filter((r) => r && typeof r === 'object' && r.enabled)
      // 归属 + 项目开关（C14 / 协议 §5.4）：先问「这套规则是不是你的」，再问匹配条件。
      // 放在 match 之前，语义是一条 AND，且**不改写** rule.enabled（重开项目即恢复原状，ADR-030 决策 2）
      .filter((r) => this.hitEligible(r, input.ownerPhone))
      .filter((r) => {
        const m = r.match
        if (!m || typeof m !== 'object' || Array.isArray(m)) return false
        // method 走 toUpperCase 比对；非字符串的脏数据交给 matchOne 判为不命中
        const method = typeof m.method === 'string' ? m.method.toUpperCase() : m.method
        return (
          matchOne(method, input.method.toUpperCase()) &&
          matchOne(m.host, input.host) &&
          matchOne(m.path, input.path) &&
          matchParams(m.params, input.params ?? {})
        )
      })
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))

    const rule = candidates[0]
    if (!rule) return null
    if (rule.action?.type !== 'mock') return { rule, response: null }
    return { rule, response: this.pickResponse(rule, input.deviceId) }
  }

  /**
   * 选出本次应返回的响应（协议 §5.4）。判定顺序固定，避免出现第二个真值来源：
   *
   * 1. `responses` 非空（多条返回值）：
   *    - `mode === 'sequence'` → 按 `seqMode` 推进指针（指针按 `(deviceId, ruleId)` 隔离，ADR-004）
   *    - 否则（`specific` / 缺省 / 脏 mode）→ `responses[pinIndex]`，越界由 `clampIndex` 夹回
   * 2. `responses` 为空 → 旧形态 `action.response`（存量规则的路径，语义不变）
   * 3. 都没有 → 兜底 `{}` 200
   *
   * `once-then-passthrough` 序列走完返回 `null`，数据面据此放行到真实服务器。
   */
  private pickResponse(rule: Rule, deviceId: string): MockResponse | null {
    const fallback: MockResponse = { status: 200, headers: { 'content-type': 'application/json' }, body: '{}' }
    const action = rule.action
    if (!action) return fallback
    const list = responseList(action)
    if (list.length) {
      if (action.mode !== 'sequence') {
        return list[clampIndex(action.pinIndex, list.length)] ?? fallback
      }
      const seqMode: SeqMode = action.seqMode ?? 'in-order'
      const key = `${deviceId}:${rule.id}`
      if (seqMode === 'random') {
        return list[Math.floor(Math.random() * list.length)] ?? fallback
      }
      const idx = this.pointers.get(key) ?? 0
      if (idx >= list.length) {
        if (seqMode === 'loop') {
          // 回绕到第一条
          this.pointers.set(key, 1)
          return list[0] ?? fallback
        }
        // once-then-passthrough：序列走完后放行到真实服务器
        if (seqMode === 'once-then-passthrough') return null
        // in-order：停在最后一条
        return list[list.length - 1] ?? fallback
      }
      this.pointers.set(key, idx + 1)
      return list[idx] ?? fallback
    }
    return action.response ?? fallback
  }

  /** 供控制台展示指针位置 */
  pointerOf(deviceId: string, ruleId: string): number {
    return this.pointers.get(`${deviceId}:${ruleId}`) ?? 0
  }
}

// 注：原先这里有一个 defaultRules()，会在 rules.json 缺失/为空时注入一条
// 「示例：登录态顺序流转」（GET /api/user/profile）。已于 ADR-020 移除，
// 规则列表空即为空。
