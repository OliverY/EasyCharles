import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GROUP_SERVER_FIELDS, type Group, type ProjectLineageEntry, type ProjectScope } from './types.ts'
import { writeJsonAtomic } from './json-file.ts'
import { ecError, projectNotFound, projectReadonly, scopeMismatch } from './ec-error.ts'

/**
 * 共享项目软删除的**宽限期**：7 天（ADR-037，2026-10-18 由 7 天改为 7 天）。
 *
 * 为什么是常量而不是启动参数：这是产品口径（「过 7 天无人恢复就真删」），不是部署差异；
 * 做成参数就得回答「改小之后已经在倒计时的项目按哪个算」，而 `purgeAt` 已经落盘，
 * 答案必然是「按落盘的那个」，参数就只剩「新发起的用哪个数」这点作用 —— 不值一个参数。
 * 真要改，改这里并写新 ADR（存量项目仍按各自的 `purgeAt` 执行，不会被追溯）。
 */
export const SHARED_TRASH_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 项目存储（协议 §5.5 / ADR-030 → **C14 / ADR-033**）。
 *
 * 定位变了：C13 时它是「规则的容器，不是租户」；C14 之后它是**带归属的项目**——
 * `private` 属于一个手机号空间且参与命中，`shared` 本实例所有登录用户可读但**永不直接命中**
 * （要用必须先 copy 到私有区，这是 C14 的全部要点）。仍然同一个 `Group` 实体、同一张
 * `groups.json`、同一批 `/__ec/api/groups*` 路由：改名会把 CLI 与存量数据劈成两半。
 *
 * 四条刻意的设计：
 * 1. **独立的 `groups.json`**：`rules.json` 的数组形状一字未改（ADR-028 的逐字节读回校验依赖它）。
 * 2. **`enabled` 必须显式给布尔**（新建与整条替换都是），缺失就 400——留一个隐式默认值，
 *    等于让「没给开关」有两种可能的结果，读回校验对不上。
 * 3. **归属字段只能由服务端写**：客户端请求体里出现 `GROUP_SERVER_FIELDS` 中任意一项
 *    （含 `createdAt` / `updatedAt`）= `400 EC_SCOPE_MISMATCH`，**不是静默丢弃**。
 *    丢弃会让「我提交了 ownerPhone，服务端按会话手机号覆盖」这件事在客户端完全不可见，
 *    而脚本作者会以为自己成功劫持了归属（协议 §5.5「请求体里带这些字段 = 400」）。
 * 4. **脏值的读路径兜底方向是「不参与命中」**：`scope` 坏 → 按 `shared`、`ownerPhone` 坏 → `null`。
 *    这与 C13 时「`enabled` 坏 → 按启用」的方向**相反**，且两个都对：
 *    C13 那个字段坏了判成 false 会让整组规则静默不 mock（界面却说已启用）；
 *    C14 这两个字段决定的是「这套规则是不是你的」，判成私有就是把别人的规则放进候选集——
 *    越界比失效更糟，所以宁可失效。**没有归属的规则永不命中**是 C14 的立身之本（ADR-033 决策 1）。
 */
export class GroupStore {
  private groups: Group[] = []
  private file: string

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
    this.file = join(dataDir, 'groups.json')
    this.load()
  }

  /**
   * 从磁盘加载并**归一化**。文件不存在 / 坏 JSON / 非数组 → 空列表
   * （与 `RuleEngine.load()` 同口径，F-16 的教训：一条脏记录不能让启动崩掉）。
   *
   * 条目级兜底：非对象或 `id` 非字符串 → 丢弃（没有 id 的项目无法被引用）；
   * `name` 非字符串 → 空串；`enabled` 非布尔 → `true`（C13 既有口径，理由见类注释第 4 条）；
   * C14 新增字段见 `normalize()`。
   *
   * **存量文件里没有 scope/ownerPhone**：一律迁成 `shared`、owner 与 creator 置 `null`
   * （协议 §4.7 迁移口径）。不伪造创建人。
   */
  private load(): void {
    if (!existsSync(this.file)) return
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      parsed = null
    }
    if (!Array.isArray(parsed)) return
    for (const raw of parsed) {
      const g = this.normalize(raw)
      if (g) this.groups.push(g)
    }
  }

  /** 脏值归一（返回 `null` = 这条必须丢弃）。读路径与 `restore()` 共用同一套口径 */
  private normalize(raw: unknown): Group | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const g = raw as Record<string, unknown>
    if (typeof g.id !== 'string' || !g.id) return null
    const scope: ProjectScope = g.scope === 'private' || g.scope === 'shared' ? g.scope : 'shared'
    const phone = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
    const versionId = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
    const out: Group = {
      id: g.id,
      name: typeof g.name === 'string' ? g.name : '',
      enabled: typeof g.enabled === 'boolean' ? g.enabled : true,
      createdAt: typeof g.createdAt === 'number' && Number.isFinite(g.createdAt) ? g.createdAt : 0,
      updatedAt: typeof g.updatedAt === 'number' && Number.isFinite(g.updatedAt) ? g.updatedAt : 0,
      scope,
      ownerPhone: scope === 'private' ? phone(g.ownerPhone) : null,
      createdBy: phone(g.createdBy),
      archived: g.archived === true,
    }
    // lineage 只长在 private 上；shared 带 lineage 是脏数据，直接当没有（不是报错的理由）
    if (scope === 'private') {
      const lineage = Array.isArray(g.lineage)
        ? (g.lineage as unknown[])
            .map((e) => {
              if (!e || typeof e !== 'object' || Array.isArray(e)) return null
              const o = e as Record<string, unknown>
              return typeof o.sharedRuleId === 'string' && typeof o.privateRuleId === 'string'
                ? ({ sharedRuleId: o.sharedRuleId, privateRuleId: o.privateRuleId } as ProjectLineageEntry)
                : null
            })
            .filter((e): e is ProjectLineageEntry => e !== null)
        : []
      if (lineage.length) out.lineage = lineage
      const origin = versionId(g.originSharedProjectId)
      if (origin) out.originSharedProjectId = origin
      const copied = versionId(g.copiedFromVersionId)
      if (copied) out.copiedFromVersionId = copied
    }
    const cv = versionId(g.currentVersionId)
    // currentVersionId 非法只影响历史指针，不影响命中判定（协议 §5.5）
    if (cv) out.currentVersionId = cv
    // 软删除的两个时间戳只长在 shared 上（ADR-037）。**脏值的方向是「当没有」**：
    // 删错不可逆，宁可让这条留在待删除之外等人再点一次，也不要因为一个坏数字把它清掉。
    if (scope === 'shared') {
      const ts = (v: unknown): number | undefined =>
        typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined
      const at = ts(g.pendingDeleteAt)
      const until = ts(g.purgeAt)
      if (at !== undefined && until !== undefined) {
        out.pendingDeleteAt = at
        out.purgeAt = until
      } else if (at !== undefined) {
        out.pendingDeleteAt = at
        out.purgeAt = at + SHARED_TRASH_MS
      } else if (until !== undefined) {
        out.purgeAt = until
        out.pendingDeleteAt = until - SHARED_TRASH_MS
      }
    }
    return out
  }

  private persist(): void {
    writeJsonAtomic(this.file, this.groups)
  }

  /** 客户端字段白名单只有 `name` / `enabled`；服务端字段出现即 400（见类注释第 3 条） */
  private validate(input: unknown, where: string): void {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw ecError(400, 'EC_SCOPE_MISMATCH', `${where} must be an object`)
    }
    const g = input as Record<string, unknown>
    for (const key of CLIENT_FORBIDDEN_FIELDS) {
      if (g[key] !== undefined) {
        throw scopeMismatch(`${where}.${key} is a server-managed field and must be omitted`)
      }
    }
    if (typeof g.name !== 'string' || !g.name.trim()) {
      throw Object.assign(new Error(`${where}.name must be a non-empty string`), { statusCode: 400 })
    }
    if (typeof g.enabled !== 'boolean') {
      throw Object.assign(new Error(`${where}.enabled must be a boolean`), { statusCode: 400 })
    }
  }

  /** 与控制台 / 规则的 `r_` 同风格的 id（协议 §5.5），并且必须查碰撞——建项目是批量脚本场景 */
  private freshId(): string {
    const taken = new Set(this.groups.map((g) => g.id))
    for (let i = 0; i < 500; i++) {
      const id = 'g_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
      if (!taken.has(id)) return id
    }
    throw Object.assign(new Error('cannot allocate group id'), { statusCode: 500 })
  }

  // ── 只读视图 ──

  /** 全量（含他人私有项目）。**只给服务端内部用**：命中判定与迁移要看全表，管理面一律走 `visible()` */
  list(): Group[] {
    return this.groups
  }

  /** 按 id 取；非字符串 / 空串 / 查无此条 → `undefined`（不抛） */
  get(id: unknown): Group | undefined {
    const key = typeof id === 'string' ? id : ''
    if (!key) return undefined
    return this.groups.find((g) => g.id === key)
  }

  exists(id: unknown): boolean {
    return this.get(id) !== undefined
  }

  /**
   * 某个会话**看得见**的项目（权限矩阵第一行，协议 §4.7）：
   * `private` 只回自己的，`shared` 回全部共享项目（含归档，归档由字段体现，不是隐藏）。
   * 他人私有项目不下发——连「存在」都不泄露。
   *
   * `phone` 来自会话，按不可信处理（AGENTS.md §4）：非字符串 / 空串 → 只回 shared
   * （一个脏会话不该看见任何私有内容，但共享库本来就是给所有登录用户读的）。
   */
  visible(phone: unknown, scope?: unknown): Group[] {
    const own = typeof phone === 'string' && phone ? phone : null
    const want = scope === 'private' || scope === 'shared' ? scope : undefined
    return this.groups.filter((g) => {
      if (want && g.scope !== want) return false
      if (g.scope === 'shared') return true
      return own !== null && g.ownerPhone === own
    })
  }

  isPrivateOf(id: unknown, phone: unknown): boolean {
    const g = this.get(id)
    return !!g && g.scope === 'private' && !!phone && g.ownerPhone === phone
  }

  isShared(id: unknown): boolean {
    const g = this.get(id)
    return !!g && g.scope === 'shared'
  }

  /**
   * 读权限：shared 全放行，private 只放行 owner，其余一律 `404 EC_PROJECT_NOT_FOUND`。
   * **不用 403**：403 等于告诉调用方「这个 id 属于别人」，协议 §6.1 明确要把两者同形。
   */
  requireReadable(id: unknown, phone: unknown): Group {
    const g = this.get(id)
    if (!g) throw projectNotFound(String(typeof id === 'string' ? id : ''))
    if (g.scope === 'shared') return g
    if (g.ownerPhone && typeof phone === 'string' && phone === g.ownerPhone) return g
    throw projectNotFound()
  }

  /**
   * 写权限（权限矩阵第二行）：只有自己的 private 可编辑。
   * shared → `409 EC_PROJECT_READONLY`（共享内容只能由 share / rollback 提交）；
   * 他人 private → 404。
   */
  requireEditable(id: unknown, phone: unknown): Group {
    const g = this.get(id)
    if (!g) throw projectNotFound(String(typeof id === 'string' ? id : ''))
    if (g.scope === 'shared') throw projectReadonly(`${g.id} is shared; change it by copy → edit → share`)
    if (!g.ownerPhone || typeof phone !== 'string' || phone !== g.ownerPhone) throw projectNotFound()
    return g
  }

  // ── 写入口（客户端可达）──

  /**
   * 新建**私有**项目（协议 §4.7：只允许创建 private）。
   * id 由服务端生成，**调用方给了非空 id 直接 400**（撞 id 时 `replaceOne` / `setEnabled`
   * 只命中第一条，「改了 A 结果变的是 B」比一句 400 难查得多）。
   * `ownerPhone` / `createdBy` 恒为会话手机号——**不接受请求体里的值**（已由 `validate` 挡住）。
   */
  create(input: unknown, phone: unknown): Group {
    if (typeof phone !== 'string' || !phone) throw ecError(401, 'EC_UNAUTHORIZED', 'session phone required')
    this.validate(input, 'group')
    const raw = input as Record<string, unknown>
    const bodyId = raw.id
    if (bodyId !== undefined && bodyId !== null && bodyId !== '') {
      throw Object.assign(new Error('group.id must be omitted on create; use PUT /__ec/api/groups/:id to set the id'), {
        statusCode: 400,
      })
    }
    const now = Date.now()
    const group: Group = {
      id: this.freshId(),
      name: (raw.name as string).trim(),
      enabled: raw.enabled as boolean,
      createdAt: now,
      updatedAt: now,
      scope: 'private',
      ownerPhone: phone,
      createdBy: phone,
      archived: false,
    }
    this.groups.push(group)
    this.persist()
    return group
  }

  /**
   * 整条替换（改名 / 改开关）。**只对自己的 private 有意义**，shared 由 `requireEditable` 挡成 409。
   *
   * `createdAt` 恒保留原值、`updatedAt` **一律服务端覆盖为 now**——
   * 它是「这条记录什么时候变的」，让调用方写就等于可以被伪造成任意时间（协议 §4.7）。
   * 归属字段原样保留：这条接口改不了 scope，也改不了 owner。
   */
  replaceOne(id: unknown, input: unknown, phone: unknown): Group {
    const key = typeof id === 'string' ? id : ''
    if (!key) throw Object.assign(new Error('missing group id'), { statusCode: 400 })
    const prev = this.requireEditable(key, phone)
    this.validate(input, 'group')
    const raw = input as Record<string, unknown>
    const bodyId = raw.id
    if (bodyId !== undefined && bodyId !== null && bodyId !== '') {
      if (typeof bodyId !== 'string') {
        throw Object.assign(new Error('group.id must be a string'), { statusCode: 400 })
      }
      if (bodyId !== key) {
        throw Object.assign(new Error(`group.id (${bodyId}) does not match path id (${key})`), { statusCode: 400 })
      }
    }
    const i = this.groups.findIndex((g) => g.id === key)
    const group: Group = {
      ...prev,
      id: key,
      name: (raw.name as string).trim(),
      enabled: raw.enabled as boolean,
      createdAt: prev.createdAt,
      updatedAt: Date.now(),
    }
    this.groups[i] = group
    this.persist()
    return group
  }

  /**
   * 整组开/关。**只对 private 有意义**：shared 不参与命中，给它一个开关就是造一个
   * 永远不会被读的字段（协议 §4.7 那行 409 的全部理由）。id 不存在或非 owner → 404。
   */
  setEnabled(id: unknown, enabled: unknown, phone: unknown): Group {
    if (typeof enabled !== 'boolean') {
      throw Object.assign(new Error('enabled must be a boolean'), { statusCode: 400 })
    }
    const group = this.requireEditable(id, phone)
    group.enabled = enabled
    group.updatedAt = Date.now()
    this.persist()
    return group
  }

  /**
   * 归档 / 取消归档（只针对 shared，协议 §4.7 的「有历史版本时不做物理删除，只允许归档」）。
   *
   * **归档 ≠ 删除**：快照与分享记录一条都不动，之后仍可回退（架构 §6.3）。
   * 权限按 C14 矩阵的推论走：共享项目不是受保护的主分支，任何登录用户都能覆盖它，
   * 归档同理（能覆盖的人不能归档才是 bug）。private 没有归档语义 → 409 走删除路径。
   */
  setArchived(id: unknown, archived: unknown, phone: unknown): Group {
    if (typeof archived !== 'boolean') {
      throw Object.assign(new Error('archived must be a boolean'), { statusCode: 400 })
    }
    if (typeof phone !== 'string' || !phone) throw ecError(401, 'EC_UNAUTHORIZED', 'session phone required')
    const group = this.get(id)
    if (!group) throw projectNotFound(String(typeof id === 'string' ? id : ''))
    if (group.scope !== 'shared') throw projectReadonly('only shared projects can be archived; delete your own private project instead')
    group.archived = archived
    group.updatedAt = Date.now()
    this.persist()
    return group
  }

  /**
   * 发起共享项目的**软删除**（ADR-037）：只打两个时间戳，规则 / 历史版本 / 快照一条不动。
   * 7 天内 `restore` 即原样恢复；到期由启动清扫与定时清扫真删（`index.ts` 的 `purgeExpiredProjects`）。
   *
   * 三条刻意的约束：
   * 1. **幂等且不延长**：已经在待删除的项目再删一次，原样返回 —— 否则「反复点删除」就变成
   *    「永远不删」，倒计时失去意义（协议 §4.7 那一行写的就是这条）。
   * 2. **private 不走这条路**：私有项目是级联物理删除（调用方先删规则再删项目），
   *    给它一档「待删除」只会多出「删了怎么还在列表里」这个要解释的问题。
   * 3. **迁移容器 `g_legacy_shared` 拒绝删除**：它不是任何人建的项目，装着全服升级前的存量规则，
   *    删掉它 = 7 天后抹掉所有人的旧 mock（ADR-033 迁移口径的唯一落点）。
   */
  markPendingDelete(id: unknown, phone: unknown): Group {
    if (typeof phone !== 'string' || !phone) throw ecError(401, 'EC_UNAUTHORIZED', 'session phone required')
    const group = this.get(id)
    if (!group) throw projectNotFound(String(typeof id === 'string' ? id : ''))
    if (group.scope !== 'shared') {
      throw projectReadonly('only shared projects use pending deletion; delete your own private project directly')
    }
    if (group.id === LEGACY_SHARED_ID) {
      throw projectReadonly(`${LEGACY_SHARED_ID} is the migration container for legacy rules and cannot be deleted`)
    }
    if (typeof group.purgeAt === 'number') return group
    const now = Date.now()
    group.pendingDeleteAt = now
    group.purgeAt = now + SHARED_TRASH_MS
    group.updatedAt = now
    this.persist()
    return group
  }

  /**
   * 取消待删除（协议 §4.7 的 `POST /groups/:id/restore`，ADR-037）。
   *
   * 方法名不叫 `restore` 是因为这个类已经有一个 `restore(groups)`（journal 整表重放），
   * 同名会让「恢复一个项目」和「恢复整张表」在调用处看起来是同一件事。
   *
   * 幂等：本来就不在待删除 → 原样返回，不报错也不改 `updatedAt`。
   * private → 409：它是立刻物理删除，没有「恢复」这一档，返回 ok 反而会让调用方以为撤销了。
   */
  cancelPendingDelete(id: unknown, phone: unknown): Group {
    if (typeof phone !== 'string' || !phone) throw ecError(401, 'EC_UNAUTHORIZED', 'session phone required')
    const group = this.get(id)
    if (!group) throw projectNotFound(String(typeof id === 'string' ? id : ''))
    if (group.scope !== 'shared') {
      throw projectReadonly('private projects are deleted immediately; there is nothing to restore')
    }
    if (typeof group.purgeAt !== 'number' && typeof group.pendingDeleteAt !== 'number') return group
    delete group.pendingDeleteAt
    delete group.purgeAt
    group.updatedAt = Date.now()
    this.persist()
    return group
  }

  /**
   * 已到期、该真删的共享项目（`purgeAt <= now`）。**纯读，不写盘**——
   * 真删要同时动规则与历史文件，编排放在 `index.ts`（那里才拿得到 RuleEngine 与 ProjectService）。
   */
  pendingExpired(now: unknown): Group[] {
    const t = typeof now === 'number' && Number.isFinite(now) ? now : Date.now()
    return this.groups.filter((g) => g.scope === 'shared' && typeof g.purgeAt === 'number' && g.purgeAt <= t)
  }

  /** 这个项目是否在待删除期（share / rollback 的写入口要挡，见 projects.ts） */
  isPendingDelete(group: Group | undefined): boolean {
    return !!group && group.scope === 'shared' && typeof group.purgeAt === 'number'
  }

  /**
   * 从项目表里移除这一条。**不动规则**——调用方必须先按 C14 口径处置组内规则：
   * private 是**级联删除**（`RuleEngine.removeByGroup`），shared 的物理删除只发生在
   * 软删除到期后的清扫里（ADR-037，同样是先删规则再删项目）。
   * 「删组只清 groupId」在 C14 下等于把规则变成无归属 ⇒ 永不命中而控制台仍显示已启用
   * （ADR-033 决策 6，架构 §5.5 坑点 1）。
   */
  remove(id: unknown): boolean {
    const group = this.get(id)
    if (!group) return false
    this.groups = this.groups.filter((g) => g.id !== group.id)
    this.persist()
    return true
  }

  // ── 服务端内部写入（copy / share / rollback 的落盘通道，客户端不可直达）──

  /** 写入一条**已由服务端构造好**的项目（新建 shared、copy 出来的 private、share 时的元数据变更） */
  upsert(group: Group): Group {
    const norm = this.normalize(group)
    if (!norm) throw Object.assign(new Error('invalid group'), { statusCode: 500 })
    const i = this.groups.findIndex((g) => g.id === norm.id)
    if (i >= 0) this.groups[i] = norm
    else this.groups.push(norm)
    this.persist()
    return norm
  }

  /** 新 id 分配（版本服务建 shared / private 副本时要用同一条碰撞检查口径） */
  newId(): string {
    return this.freshId()
  }

  /** 当前全表快照（深拷贝），pending journal 的 `after` 就存这个 */
  state(): Group[] {
    return JSON.parse(JSON.stringify(this.groups)) as Group[]
  }

  /**
   * 整表恢复（journal 重放 / 回滚的唯一入口）。
   * 逐条 `normalize`，非法条目丢弃而不是抛错——**恢复路径崩掉 = 服务起不来**，
   * 比丢一条脏项目严重得多（AGENTS.md §4）。
   */
  restore(groups: unknown): void {
    if (!Array.isArray(groups)) throw Object.assign(new Error('groups state must be an array'), { statusCode: 500 })
    const next: Group[] = []
    for (const raw of groups) {
      const g = this.normalize(raw)
      if (g) next.push(g)
    }
    this.groups = next
    this.persist()
  }

  /** 迁移用：确保存在一个「旧版共享规则」容器，返回其 id（协议 §5.4 硬约束 ①） */
  ensureLegacySharedContainer(name: string): Group {
    const existing = this.groups.find((g) => g.id === LEGACY_SHARED_ID && g.scope === 'shared')
    if (existing) return existing
    const now = Date.now()
    const group: Group = {
      id: LEGACY_SHARED_ID,
      name,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      scope: 'shared',
      ownerPhone: null,
      createdBy: null,
      archived: false,
    }
    this.groups.push(group)
    this.persist()
    return group
  }
}

/**
 * 「旧版共享规则」容器的固定 id（协议 §4.7 迁移口径）。
 * 未分组规则与悬空 `groupId` 规则在迁移时收进这里，保证**没有任何规则处于无归属状态**
 * ——C14 下无归属就等于永不命中，留裸奔就是静默失效。
 */
export const LEGACY_SHARED_ID = 'g_legacy_shared'

/**
 * 客户端请求体里**不允许出现**的字段 = 服务端字段黑名单 + 两个时间戳。
 *
 * 时间戳为什么也进这份清单：`createdAt` / `updatedAt` 与归属字段同性质（服务器时钟才作数），
 * 而 C13 时代它们允许客户端传有限数——那是「分组全局、谁建的不重要」语境下的旧口子。
 * C14 之后 `createdAt` 会被控制台显示成「创建时间」、历史页要按它排序，
 * 让调用方能写就等于让脚本能伪造时间线（协议 §5.5「时间与版本全部来自会话与服务器时钟」）。
 */
export const CLIENT_FORBIDDEN_FIELDS: readonly string[] = [...GROUP_SERVER_FIELDS, 'createdAt', 'updatedAt']
