import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { validateRuleSet, type RuleEngine } from './rules.ts'
import type { GroupStore } from './groups.ts'
import { writeJsonAtomic } from './json-file.ts'
import { conflict, projectNotFound, projectReadonly, scopeMismatch, storageUnavailable } from './ec-error.ts'
import type {
  Group,
  ProjectLineageEntry,
  ProjectVersion,
  ProjectVersionView,
  Rule,
} from './types.ts'

/**
 * 私有 / 共享项目的**版本服务**（C14 / ADR-033，协议 §5.5、架构 §6.3）。
 *
 * 它管三件事：copy（共享 → 私有）、share（私有 → 共享，首发或整体覆盖）、rollback（共享回到任一历史点）。
 * 三件事的共同点是**都要同时写 `rules.json` 与 `groups.json`**（share 还要写快照文件），
 * 所以它们必须成笔——「逐条 PUT 成功几条算几条」就是 F-15 那类事故的形态。
 *
 * 事务类型（`PendingOp` / `Receipt`）**故意不放进 `types.ts`**：那份文件是
 * 「服务端 ↔ 客户端 / SDK 的字段契约」（AGENTS.md §5 三方核对的对象），
 * journal 是纯服务端内部状态，下发不出去、SDK 不认识、控制台不渲染。
 * 放全局类型文件里只会让人误以为它是协议字段（阶段 B 的 types.ts 已登记这条偏差）。
 *
 * 落盘布局（全在 `.data/` 内，已 gitignore；不新增顶层目录、不引入配置文件格式、不加运行时依赖）：
 *
 * ```
 * .data/projects/index.json                    历史索引：projectId → ProjectVersion[]（元数据，不含 body）
 * .data/projects/journal.json                  pending 事务 + operationId 回执
 * .data/projects/<projectId>/<versionId>.json  不可变版本快照：完整项目定义 + 全部规则与返回值
 * ```
 */
const PROJECTS_DIR = 'projects'
const INDEX_FILE = 'index.json'
const JOURNAL_FILE = 'journal.json'

/** 回执条数上限。它只为「超时重发不重复生成版本」服务，**不是历史**——剪掉旧回执不会删任何版本 */
const RECEIPT_MAX = 100

/**
 * 单份版本快照的落盘字节上限（**实际 UTF-8 字节数**，不是条数估算，AGENTS.md §6）。
 *
 * 为什么管理面的 1 MiB body 上限不适用在这里：copy / share / rollback **不接收客户端上传完整项目**
 * （协议 §5.5），所以 1 MiB 卡不住大项目；但服务端内部拼装出来的快照仍要有一道磁盘护栏，
 * 否则一次超大的分享能把 `.data/` 写满并让下一次启动读不到任何文件。
 * 64 MiB 是**实现自己拍的数**（协议只说「超限给出可读错误且不留下半写文件」，没给数字），
 * 已在 roadmap P7 登记为待产品确认项；历史默认无限保留，这里只挡单笔，不静默清理旧版本。
 */
const SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024

/** 迁移生成的旧版共享容器名（协议 §4.7 迁移口径；UI 显示为共享项目，本就不参与命中） */
export const LEGACY_SHARED_NAME = '旧版共享规则'

// ── 事务类型（见文件头：不进 types.ts）──

type ProjectOpKind = 'copy' | 'share' | 'rollback'

/** 一笔事务要提交进去的完整目标状态（两个文件一起，所以叫 after） */
interface CommitState {
  rules: Rule[]
  groups: Group[]
}

interface PendingOp {
  operationId: string
  kind: ProjectOpKind
  actorPhone: string
  createdAt: number
  sharedProjectId: string | null
  privateProjectId: string | null
  /** share / rollback 有；copy 没有（复制不产生共享版本） */
  version: ProjectVersion | null
  after: CommitState
  /** 幂等重放时原样回给调用方的那个结果 */
  result: ProjectOperationResult
}

interface Receipt {
  operationId: string
  kind: ProjectOpKind
  createdAt: number
  /** 已脱敏的操作人：回执会被重放进响应体，这里存全手机号等于把脱敏做了一半 */
  actor: string
  sharedProjectId: string | null
  privateProjectId: string | null
  version: ProjectVersionView | null
}

interface JournalFile {
  pending: PendingOp | null
  receipts: Receipt[]
}

/** 版本快照文件的内容：回退要能**逐字段还原**，所以存完整项目定义 + 全部规则 */
interface ProjectSnapshot {
  version: ProjectVersion
  group: Group
  rules: Rule[]
}

/** 三种操作的统一返回（index.ts 再按端点形状拆成协议 §4.7 写的字段） */
export interface ProjectOperationResult {
  kind: ProjectOpKind
  operationId: string
  sharedProject: Group | null
  privateProject: Group | null
  version: ProjectVersionView | null
  rules: Rule[] | null
  /** 已脱敏的分享人（协议 §4.7：历史与分享回执都不出全手机号） */
  actor: string
  createdAt: number
  copiedFromVersionId: string | null
  replayed?: boolean
}

/**
 * 手机号脱敏（协议 §4.7 的「actorPhone（脱敏）」）。
 *
 * 为什么脱在**服务端**而不是控制台：共享项目的历史与分享回执是**跨用户**的数据，
 * 只要下发过全手机号，前端就总有漏出去的一天（日志、抓包、别的客户端）。
 * 长度不足 8 位（非标准手机号、脏值）一律整串打码，不做「看起来像不像手机号」的猜测。
 */
export function maskPhone(phone: unknown): string {
  if (typeof phone !== 'string' || !phone) return ''
  if (phone.length <= 7) return '*'.repeat(phone.length)
  return phone.slice(0, 3) + '****' + phone.slice(-4)
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

function validOperationId(v: unknown, where: string): string {
  if (typeof v !== 'string' || !v.trim()) {
    throw Object.assign(new Error(`${where}.operationId must be a non-empty string`), { statusCode: 400 })
  }
  return v.trim()
}

/** 事务 id：`op_<base36 时间><6 位随机>`。与控制台 / 规则 / 分组同风格，便于在日志里认出是哪一层产的 */
function freshOperationId(): string {
  return 'op_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function freshVersionId(): string {
  return 'v_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

export class ProjectService {
  private dir: string
  private indexFile: string
  private journalFile: string
  private groups: GroupStore
  private rules: RuleEngine

  constructor(dataDir: string, groups: GroupStore, rules: RuleEngine) {
    this.dir = join(dataDir, PROJECTS_DIR)
    mkdirSync(this.dir, { recursive: true })
    this.indexFile = join(this.dir, INDEX_FILE)
    this.journalFile = join(this.dir, JOURNAL_FILE)
    this.groups = groups
    this.rules = rules
  }

  // ── 读路径（全部脏值兜底，绝不因为一个坏快照让启动崩掉，AGENTS.md §4）──

  private readJson(raw: string): unknown {
    try {
      return JSON.parse(readFileSync(raw, 'utf8')) as unknown
    } catch {
      return null
    }
  }

  /** 历史索引：`projectId → ProjectVersion[]`。坏 JSON / 非对象 → 空表；条目非法 → 丢弃该条 */
  private readIndex(): Record<string, ProjectVersion[]> {
    const parsed = this.readJson(this.indexFile)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, ProjectVersion[]> = {}
    for (const [pid, list] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue
      const good = list.filter((v): v is ProjectVersion => {
        if (!v || typeof v !== 'object' || Array.isArray(v)) return false
        const o = v as Record<string, unknown>
        return typeof o.id === 'string' && !!o.id && typeof o.projectId === 'string' && o.projectId === pid
      })
      if (good.length) out[pid] = good
    }
    return out
  }

  /** journal：坏 JSON / 形状非法 → 当作「没有 pending」（但**不**清空文件，留给诊断） */
  private readJournal(): JournalFile {
    const parsed = this.readJson(this.journalFile)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { pending: null, receipts: [] }
    const j = parsed as Record<string, unknown>
    const pending = j.pending
    const okPending =
      !!pending &&
      typeof pending === 'object' &&
      !Array.isArray(pending) &&
      typeof (pending as Record<string, unknown>).operationId === 'string' &&
      !!(pending as Record<string, unknown>).after &&
      typeof (pending as Record<string, unknown>).after === 'object'
    const receipts = Array.isArray(j.receipts)
      ? (j.receipts as unknown[]).filter((r): r is Receipt => {
          if (!r || typeof r !== 'object' || Array.isArray(r)) return false
          const o = r as Record<string, unknown>
          return typeof o.operationId === 'string' && !!o.operationId
        })
      : []
    return { pending: okPending ? (pending as unknown as PendingOp) : null, receipts }
  }

  private writeJournal(j: JournalFile): void {
    writeJsonAtomic(this.journalFile, { pending: j.pending, receipts: j.receipts.slice(-RECEIPT_MAX) })
  }

  private snapshotPath(projectId: string, versionId: string): string {
    // 两个 id 都来自服务端自己的生成器，但路径拼接前仍要挡掉 `..` / `/`——
    // 快照文件名一旦能被外部影响，就是「用管理面接口往磁盘任意位置写文件」
    const safe = (s: string): string => (/^[A-Za-z0-9_-]+$/.test(s) ? s : '')
    const pid = safe(projectId)
    const vid = safe(versionId)
    if (!pid || !vid) throw Object.assign(new Error('invalid project or version id'), { statusCode: 400 })
    return join(this.dir, pid, vid + '.json')
  }

  // ── 历史查询（只读，客户端可达）──

  /**
   * 某个项目的历史元数据（**不含完整快照 body**，协议 §4.7）。
   * actorPhone 在这里脱敏；`projectId` 非法 → 空数组。
   */
  versions(projectId: unknown): ProjectVersionView[] {
    const key = typeof projectId === 'string' ? projectId : ''
    if (!key) return []
    const index = this.readIndex()
    const list = index[key]
    if (!Array.isArray(list)) return []
    return list
      .filter((v) => typeof v.createdAt === 'number' && Number.isFinite(v.createdAt))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map((v) => this.toView(v))
  }

  hasHistory(projectId: unknown): boolean {
    return this.versions(projectId).length > 0
  }

  private toView(v: ProjectVersion): ProjectVersionView {
    const { snapshotFile, ...rest } = v
    return { ...rest, actorPhone: maskPhone(v.actorPhone) }
  }

  /**
   * 回退预览：某版本的项目元数据 + 规则清单（**只读**，任何写方法在 index.ts 挡成 409）。
   * 快照文件缺失 / 坏 JSON → `404 EC_PROJECT_NOT_FOUND`（历史索引里有、文件里没有，
   * 就是磁盘被手删过——按「不存在」如实回，不做「用当前内容顶上」这种自作聪明的兜底）。
   */
  versionDetail(projectId: unknown, versionId: unknown): { version: ProjectVersionView; group: Group; rules: Rule[] } {
    const pid = typeof projectId === 'string' ? projectId : ''
    const vid = typeof versionId === 'string' ? versionId : ''
    const known = this.versions(pid).find((v) => v.id === vid)
    const file = this.snapshotPath(pid, vid)
    if (!known || !existsSync(file)) throw projectNotFound(`${pid}/${vid}`)
    const snap = this.readJson(file) as ProjectSnapshot | null
    if (!snap || typeof snap !== 'object' || !Array.isArray(snap.rules) || !snap.group) {
      throw projectNotFound(`${pid}/${vid} (corrupt snapshot)`)
    }
    return { version: this.toView(snap.version), group: snap.group, rules: snap.rules }
  }

  // ── 三个写操作 ──

  /**
   * **copy**：共享项目 → 调用者的私有项目（协议 §6.2 流程）。
   *
   * - 内容**全部由服务端从存储里读**，客户端只给 `operationId`（协议 §5.5：不接收上传的完整项目）；
   * - 规则逐条换成本地新 id（不与共享或其它私有撞号），`lineage` 记下共享 id ⇄ 私有 id 的稳定映射；
   * - **源一字未改**：不碰源项目的规则、不推进它的历史、也不写 share 事件（复制不是分享）；
   * - `enabled` 每条原样保留（源里关着的规则复制过来仍是关着的），新项目默认启用。
   */
  copyShared(sharedId: unknown, phone: string, operationIdRaw: unknown): ProjectOperationResult {
    const operationId = validOperationId(operationIdRaw, 'body')
    const replay = this.replay(operationId)
    if (replay) return replay
    const src = this.groups.requireReadable(sharedId, phone)
    if (src.scope !== 'shared') throw scopeMismatch('copy source must be a shared project')
    const source = this.rules.listOfGroup(src.id)
    const now = Date.now()
    const privateId = this.groups.newId()
    const lineage: ProjectLineageEntry[] = []
    const copies: Rule[] = []
    for (const r of source) {
      const fresh = this.rules.newRuleId()
      copies.push({ ...clone(r), id: fresh, groupId: privateId })
      lineage.push({ sharedRuleId: String(r.id), privateRuleId: fresh })
    }
    const group: Group = {
      id: privateId,
      // 副本名带「(副本)」是刻意的：共享库与我的项目里会出现两个同名「登录」，
      // 用户在控制台点错的成本远高于多看五个字的成本（协议 §5.5「name 不要求唯一」）
      name: `${src.name}(副本)`,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      scope: 'private',
      ownerPhone: phone,
      createdBy: phone,
      archived: false,
      originSharedProjectId: src.id,
      copiedFromVersionId: typeof src.currentVersionId === 'string' ? src.currentVersionId : undefined,
      lineage,
    }
    const after: CommitState = {
      rules: [...this.rules.state(), ...copies],
      groups: [...this.groups.state(), group],
    }
    const result: ProjectOperationResult = {
      kind: 'copy',
      operationId,
      sharedProject: src,
      privateProject: group,
      version: null,
      rules: copies,
      actor: maskPhone(phone),
      createdAt: now,
      copiedFromVersionId: group.copiedFromVersionId ?? null,
    }
    const op: PendingOp = {
      operationId,
      kind: 'copy',
      actorPhone: phone,
      createdAt: now,
      sharedProjectId: src.id,
      privateProjectId: privateId,
      version: null,
      after,
      result,
    }
    this.commit(op)
    return result
  }

  /**
   * **share**：私有项目 → 共享库（首发 = 新建 shared + 第一个 `publish` 版本；
   * 再分享 = 整项目覆盖来源 shared，last write wins，**不做三方合并**）。
   *
   * 三条容易写错的点，都在这道题上：
   * 1. **不接收客户端上传的 `Rule[]`**：内容从存储里读，否则任何登录用户都能往共享库塞任意内容；
   * 2. **按 `lineage` 还原原共享 id**：复制来的规则要变回它原来的共享 id，
   *    否则「再分享」会把共享库里的规则整片换成新 id，历史与别人的引用全部对不上号；
   * 3. **私有新建的规则这时才分配共享 id**，复制后被删掉的映射规则自然从共享清单里消失
   *    （协议 §5.5：lineage 只用于还原身份，不用于冲突检测）。
   */
  sharePrivate(privateId: unknown, phone: string, operationIdRaw: unknown, expectedSharedVersionId?: unknown): ProjectOperationResult {
    const operationId = validOperationId(operationIdRaw, 'body')
    const replay = this.replay(operationId)
    if (replay) return replay
    const priv = this.groups.requireEditable(privateId, phone)
    if (priv.scope !== 'private') throw projectReadonly('cannot share a shared project directly')
    const source = this.rules.listOfGroup(priv.id)

    // 来源项目还在且确实是 shared → 覆盖它；来源已被删 → 按首发走一份新的共享项目（如实新建，不报错）
    let target = typeof priv.originSharedProjectId === 'string' ? this.groups.get(priv.originSharedProjectId) : undefined
    if (target && target.scope !== 'shared') {
      throw scopeMismatch(`origin project ${target.id} is no longer shared`)
    }
    if (target && expectedSharedVersionId !== undefined && target.currentVersionId !== String(expectedSharedVersionId)) {
      throw conflict(
        `shared project ${target.id} is now at ${String(target.currentVersionId)}; expected ${String(expectedSharedVersionId)}`,
      )
    }
    // 待删除（ADR-037）：覆盖进去的内容 7 天后会跟着项目一起消失，这是最难查的静默丢失
    if (target && this.groups.isPendingDelete(target)) {
      throw projectReadonly(`shared project ${target.id} is pending deletion; restore it before sharing into it`)
    }

    const now = Date.now()
    const isNew = !target
    const sharedId = isNew ? this.groups.newId() : target!.id
    const oldSharedRules = isNew ? [] : this.rules.listOfGroup(sharedId).map((r) => String(r.id))

    // 归属占号检查：映射里的共享 id 若已被**别的项目**的规则占着（删过又重建、或磁盘被手改过），
    // 就重新分配——宁可得一条新号，也不能让一次分享写出两条同 id 的规则（F-15 的形态）
    const ownerOfRuleId = new Map<string, string | undefined>()
    for (const r of this.rules.list()) {
      if (r && typeof r === 'object') ownerOfRuleId.set(String(r.id), typeof r.groupId === 'string' ? r.groupId : '')
    }
    const lineage = Array.isArray(priv.lineage) ? priv.lineage.slice() : []
    const byPrivateId = new Map(lineage.map((e) => [e.privateRuleId, e.sharedRuleId]))
    const shared: Rule[] = []
    const newLineage: ProjectLineageEntry[] = []
    for (const r of source) {
      const pid = String(r.id)
      let sid = byPrivateId.get(pid)
      if (sid && ownerOfRuleId.has(sid) && ownerOfRuleId.get(sid) !== sharedId && oldSharedRules.indexOf(sid) < 0) {
        sid = undefined
      }
      if (!sid) sid = this.rules.newRuleId()
      shared.push({ ...clone(r), id: sid, groupId: sharedId })
      newLineage.push({ sharedRuleId: sid, privateRuleId: pid })
    }

    const sharedGroup: Group = {
      id: sharedId,
      name: priv.name,
      // shared 的 enabled 在运行时**从不被读**（不参与命中，协议 §5.4）。这里恒置 true 而不是
      // 沿用私有项目的开关：把私有的「我暂时关掉」同步到共享库，会让复制者拿到一个语义不明的开关
      enabled: true,
      createdAt: target ? target.createdAt : now,
      updatedAt: now,
      scope: 'shared',
      ownerPhone: null,
      createdBy: target && typeof target.createdBy === 'string' ? target.createdBy : phone,
      archived: target ? target.archived : false,
    }
    const newVersionId = freshVersionId()
    const version: ProjectVersion = {
      id: newVersionId,
      projectId: sharedId,
      parentVersionId: target && typeof target.currentVersionId === 'string' ? target.currentVersionId : null,
      operation: isNew ? 'publish' : 'share',
      actorPhone: phone,
      createdAt: now,
      ruleCount: shared.length,
      snapshotFile: join(PROJECTS_DIR, sharedId, newVersionId + '.json'),
    }
    sharedGroup.currentVersionId = version.id

    const updatedPrivate: Group = { ...priv, originSharedProjectId: sharedId, lineage: newLineage, updatedAt: Date.now() }

    // 首发：新 shared 追加到表尾；覆盖：按 id 替换那一条。私有项目带着 originSharedProjectId 回填
    const privateApplied = this.groups.state().map((g) => (g.id === priv.id ? updatedPrivate : g))
    const groupsAfter = isNew ? [...privateApplied, sharedGroup] : privateApplied.map((g) => (g.id === sharedId ? sharedGroup : g))

    const after: CommitState = {
      rules: [
        // 共享项目之外的规则逐条原样保留（他人私有 + 其它共享 + 无归属脏条目）
        ...this.rules.state().filter((r) => !(r && typeof r === 'object' && oldSharedRules.indexOf(String(r.id)) >= 0)),
        ...shared,
      ],
      groups: groupsAfter,
    }
    const result: ProjectOperationResult = {
      kind: 'share',
      operationId,
      sharedProject: sharedGroup,
      privateProject: updatedPrivate,
      version: this.toView(version),
      rules: shared,
      actor: maskPhone(phone),
      createdAt: now,
      copiedFromVersionId: updatedPrivate.copiedFromVersionId ?? null,
    }
    const op: PendingOp = {
      operationId,
      kind: 'share',
      actorPhone: phone,
      createdAt: now,
      sharedProjectId: sharedId,
      privateProjectId: priv.id,
      version,
      after,
      result,
    }
    this.commit(op)
    return result
  }

  /**
   * **rollback**：把某个历史版本的快照恢复为共享项目的当前内容，并**追加**一条 `rollback` 版本。
   *
   * 语义要点（协议 §4.7 / §6.4）：
   * - 允许从任意历史点起跳，也允许「再回退到更早的点」；
   * - 旧版本一条都不删、不改（历史事件顺序不可修改），回退只是新增一个提交并记 `rollbackOf`；
   * - 失败时 active 规则、`currentVersionId`、历史**三者一字未改**——「几条成功几条失败」不允许出现。
   */
  rollbackShared(sharedId: unknown, versionIdRaw: unknown, phone: string, operationIdRaw: unknown): ProjectOperationResult {
    const operationId = validOperationId(operationIdRaw, 'body')
    const replay = this.replay(operationId)
    if (replay) return replay
    const vid = typeof versionIdRaw === 'string' ? versionIdRaw : ''
    if (!vid) throw Object.assign(new Error('body.versionId must be a non-empty string'), { statusCode: 400 })
    const target = this.groups.requireReadable(sharedId, phone)
    if (target.scope !== 'shared') throw projectReadonly('rollback only applies to a shared project')
    // 待删除期间不许回退：回退是「提交一份新内容」，写进一个 7 天后就消失的项目没有意义（ADR-037）
    if (this.groups.isPendingDelete(target)) {
      throw projectReadonly(`shared project ${target.id} is pending deletion; restore it before rolling back`)
    }
    const detail = this.versionDetail(target.id, vid)
    const snapRules = detail.rules
    validateRuleSet(snapRules, 'snapshot.rules')

    const now = Date.now()
    const oldSharedRuleIds = this.rules.listOfGroup(target.id).map((r) => String(r.id))
    const restored: Rule[] = snapRules.map((r) => ({ ...clone(r), groupId: target.id }))
    const newVersionId = freshVersionId()
    const version: ProjectVersion = {
      id: newVersionId,
      projectId: target.id,
      parentVersionId: typeof target.currentVersionId === 'string' ? target.currentVersionId : null,
      operation: 'rollback',
      actorPhone: phone,
      createdAt: now,
      rollbackOf: vid,
      ruleCount: restored.length,
      snapshotFile: join(PROJECTS_DIR, target.id, newVersionId + '.json'),
    }
    const sharedGroup: Group = {
      ...detail.group,
      id: target.id,
      scope: 'shared',
      ownerPhone: null,
      updatedAt: now,
      currentVersionId: version.id,
      archived: target.archived,
    }
    const after: CommitState = {
      rules: [
        ...this.rules.state().filter((r) => !(r && typeof r === 'object' && oldSharedRuleIds.indexOf(String(r.id)) >= 0)),
        ...restored,
      ],
      groups: this.groups.state().map((g) => (g.id === target.id ? sharedGroup : g)),
    }
    const result: ProjectOperationResult = {
      kind: 'rollback',
      operationId,
      sharedProject: sharedGroup,
      privateProject: null,
      version: this.toView(version),
      rules: restored,
      actor: maskPhone(phone),
      createdAt: now,
      copiedFromVersionId: null,
    }
    const op: PendingOp = {
      operationId,
      kind: 'rollback',
      actorPhone: phone,
      createdAt: now,
      sharedProjectId: target.id,
      privateProjectId: null,
      version,
      after,
      result,
    }
    this.commit(op)
    return result
  }

  /**
   * 待删除到期清理（ADR-037）：把 `purgeAt` 已过的共享项目**真的删掉**。
   *
   * 顺序是**规则 → 项目 → 历史快照**，不能反：先删项目会让组内规则短暂变成无归属，
   * 而 C14 下「无归属」= 永不命中；历史放最后是因为它是唯一删了没有第二份的东西
   * （前两步失败还能靠下一轮清扫重来，因为项目仍在表里）。
   *
   * 单个项目失败不影响其它项目、也不抛给调用方：这是后台动作，失败记进返回值、
   * 项目留在表里等下一轮重试（启动时跑一次 + 每 30 分钟一次，见 `index.ts`）。
   * `now` 可注入，selftest 用它把时间推到 7 天之后，不必真的等。
   */
  purgeExpired(now: number = Date.now()): {
    purged: { id: string; name: string; rules: number; files: number }[]
    failed: { id: string; error: string }[]
  } {
    const out: {
      purged: { id: string; name: string; rules: number; files: number }[]
      failed: { id: string; error: string }[]
    } = { purged: [], failed: [] }
    for (const g of this.groups.pendingExpired(now)) {
      try {
        const removed = this.rules.removeByGroup(g.id)
        this.groups.remove(g.id)
        const purged = this.purgeProject(g.id)
        out.purged.push({ id: g.id, name: g.name, rules: removed, files: purged.filesRemoved })
      } catch (e) {
        out.failed.push({ id: g.id, error: (e as Error).message })
      }
    }
    return out
  }

  /**
   * 软删除到期后的**真删**（ADR-037）：删掉该项目的版本快照目录与历史索引条目。
   *
   * 调用方负责先后顺序：**规则 → 项目 → 历史**。历史放最后是因为它是唯一「删了没有第二份」的东西：
   * 前面两步失败还能靠下一轮清扫重来（项目仍在表里），历史目录一旦删掉、索引却还留着，
   * 就成了「历史列表里有条目、点开 404」的假记录。
   *
   * 幂等：目录不在 / 索引里没有该键 → 静默通过（第二轮清扫、磁盘被手删过都能跑）。
   * 失败只吞掉不抛：清理是后台动作，没有调用方在等它；留下的孤儿文件不带索引条目，
   * 任何读路径都不会把它当成版本（同 `commit` 里对孤儿快照的口径）。
   */
  purgeProject(projectId: unknown): { indexRemoved: boolean; filesRemoved: number } {
    const key = typeof projectId === 'string' ? projectId : ''
    // 与 snapshotPath 同一道护栏：项目 id 来自服务端生成器，但路径拼接前一律复核
    if (!/^[A-Za-z0-9_-]+$/.test(key)) return { indexRemoved: false, filesRemoved: 0 }
    let filesRemoved = 0
    try {
      const dir = join(this.dir, key)
      if (existsSync(dir)) {
        filesRemoved = readdirSync(dir).length
        rmSync(dir, { recursive: true, force: true })
      }
    } catch {
      /* 文件删不掉不致命：索引条目随后会被去掉，剩下的只是占空间的孤儿 */
    }
    let indexRemoved = false
    try {
      const index = this.readIndex()
      if (index[key]) {
        delete index[key]
        writeJsonAtomic(this.indexFile, index)
        indexRemoved = true
      }
    } catch {
      /* 索引写不动 → 保留原样，下一轮清扫再试 */
    }
    return { indexRemoved, filesRemoved }
  }

  // ── 事务内核 ──

  /** 命中回执就原样返回首次那笔的结果并标 `replayed`（协议 §4.7：不得生成第二个版本、不写第二条审计） */
  private replay(operationId: string): ProjectOperationResult | null {
    const j = this.readJournal()
    const hit = j.receipts.find((r) => r.operationId === operationId)
    if (!hit) return null
    const privateProject = hit.privateProjectId ? this.groups.get(hit.privateProjectId) ?? null : null
    return {
      kind: hit.kind,
      operationId,
      sharedProject: hit.sharedProjectId ? this.groups.get(hit.sharedProjectId) ?? null : null,
      privateProject,
      version: hit.version,
      // copy 的规则不回存在回执里（一个项目的 body 可能很大），重放时按项目 id 现读——
      // 读得到就还是那次复制的产物，读不到说明后来被改过，两种情况都不该伪装成首次结果
      rules: hit.kind === 'copy' && hit.privateProjectId ? this.rules.listOfGroup(hit.privateProjectId) : null,
      actor: hit.actor || maskPhone(null),
      createdAt: hit.createdAt,
      copiedFromVersionId: privateProject?.copiedFromVersionId ?? null,
      replayed: true,
    }
  }

  /**
   * 一笔提交的固定顺序（协议 §5.5 / 架构 §6.3，**顺序本身就是契约**）：
   *
   * ```
   * 1. 校验完整新状态（规则数组 + 每条 action/responses + 快照实际字节数）
   * 2. 写不可变快照        临时文件 + rename；已存在即视为重放，绝不覆写
   * 3. 写 journal          pending = { operationId, after, version }
   * 4. 提交 active         rules.json → groups.json（各自临时文件 + rename）
   * 5. 追加历史索引 + 清 journal + 落回执
   * ```
   *
   * 第 4 步半途失败时，用**内存里留存的 before 状态**把两个文件都写回旧值并抹掉 pending——
   * 不抹的话下次启动会把这笔已回滚的事务前滚完成。`before` 不进 journal：
   * journal 的作用是让启动时「幂等地把这笔做完」，前滚只需要 `after` 就够，
   * 存 `before` 反而等于在磁盘上再养一份规则表。
   */
  private commit(op: PendingOp): void {
    validateRuleSet(op.after.rules)
    assertUniqueRuleIds(op.after.rules)
    const before: CommitState = { rules: this.rules.state(), groups: this.groups.state() }
    let snapshotWritten = false
    let journalWritten = false
    try {
      if (op.version) {
        const file = this.snapshotPath(op.version.projectId, op.version.id)
        if (!existsSync(file)) {
          const payload: ProjectSnapshot = {
            version: op.version,
            group: (op.after.groups.find((g) => g.id === op.version!.projectId) ?? this.groups.get(op.version!.projectId)) as Group,
            rules: op.after.rules.filter((r) => r && typeof r === 'object' && r.groupId === op.version!.projectId),
          }
          const bytes = Buffer.byteLength(JSON.stringify(payload, null, 2), 'utf8')
          if (bytes > SNAPSHOT_MAX_BYTES) {
            throw storageUnavailable(
              `snapshot is ${bytes} bytes, over the ${SNAPSHOT_MAX_BYTES} byte limit; nothing was committed`,
            )
          }
          mkdirSync(join(this.dir, op.version.projectId), { recursive: true })
          writeJsonAtomic(file, payload)
          snapshotWritten = true
        }
      }
      this.writeJournal({ pending: op, receipts: this.readJournal().receipts })
      journalWritten = true
      this.rules.restore(op.after.rules)
      this.groups.restore(op.after.groups)
      if (op.version) this.appendIndex(op.version)
      this.settle(op)
    } catch (e) {
      // 尽力回到提交前的状态；回滚本身再失败也不能盖掉原始错误（那是诊断的唯一线索）
      try {
        this.rules.restore(before.rules)
        this.groups.restore(before.groups)
      } catch {
        /* 保留原始异常 */
      }
      if (snapshotWritten && op.version) {
        try {
          rmSync(this.snapshotPath(op.version.projectId, op.version.id), { force: true })
        } catch {
          /* 孤儿快照不致命：历史索引里没有它，任何读路径都不会把它当版本 */
        }
      }
      if (journalWritten) {
        try {
          this.writeJournal({ pending: null, receipts: this.readJournal().receipts })
        } catch {
          /* 磁盘都写不动了，这里再抛只是噪音 */
        }
      }
      throw e
    }
  }

  private appendIndex(v: ProjectVersion): void {
    const index = this.readIndex()
    const list = index[v.projectId] ?? []
    // 幂等：同一 versionId 只出现一次（journal 重放时这一步会被再执行一遍）
    if (list.some((x) => x.id === v.id)) return
    index[v.projectId] = [...list, v]
    writeJsonAtomic(this.indexFile, index)
  }

  /** 清 pending + 写回执（第 5 步）。回执失败不影响已提交的事务，只是重放保护弱了一档 */
  private settle(op: PendingOp): void {
    const j = this.readJournal()
    const receipts: Receipt[] = [
      ...j.receipts.filter((r) => r.operationId !== op.operationId),
      {
        operationId: op.operationId,
        kind: op.kind,
        createdAt: op.createdAt,
        actor: op.result.actor,
        sharedProjectId: op.sharedProjectId,
        privateProjectId: op.privateProjectId,
        version: op.result.version,
      },
    ]
    this.writeJournal({ pending: null, receipts })
  }

  /**
   * **启动时先恢复再对外服务**（架构 §6.3：这一步不是可选的健壮性）。
   *
   * 判定只有两种，都按 `operationId` 幂等：
   * - 快照与 journal 齐 → **前滚**：重放第 4、5 步（active 写全 + 索引补齐 + 清 pending）；
   * - 快照文件没了（journal 说该有）→ **不能前滚也不能后滚**：active 一字不动，抹掉 pending 并如实报告。
   *   这里不伪造回滚目标：journal 只存 `after`，凭它写不出「旧状态」，猜一个就是把数据搞得更糟。
   */
  recover(): { completed: string[]; abandoned: string[] } {
    const j = this.readJournal()
    const out: { completed: string[]; abandoned: string[] } = { completed: [], abandoned: [] }
    const pending = j.pending
    if (!pending || !pending.after) return out
    const needSnapshot = pending.version
    const snapshotMissing =
      !!needSnapshot && !existsSync(this.snapshotPath(needSnapshot.projectId, needSnapshot.id))
    if (snapshotMissing) {
      out.abandoned.push(pending.operationId)
      this.writeJournal({ pending: null, receipts: j.receipts })
      return out
    }
    try {
      validateRuleSet(pending.after.rules)
      this.rules.restore(pending.after.rules)
      this.groups.restore(pending.after.groups)
      if (needSnapshot) this.appendIndex(needSnapshot)
      this.settle(pending)
      out.completed.push(pending.operationId)
    } catch {
      // 恢复不了也不能让服务起不来：留 pending 在原处，报告给调用方（启动横幅会打这行）
      out.abandoned.push(pending.operationId)
    }
    return out
  }

  /**
   * 历史占用（启动横幅与管理面用，**实际字节数**而不是条数估算，AGENTS.md §6）。
   *
   * 历史默认无限保留、不静默清理（ADR-033），所以容量必须**看得见**：
   * 旧版本会长期保留后来删掉的 response body（可能含 token / cookie / 个人数据）。
   */
  storageUsage(): { bytes: number; files: number; projects: number } {
    let bytes = 0
    let files = 0
    let projects = 0
    const sizeOf = (p: string): void => {
      try {
        const st = statSync(p)
        if (st.isDirectory()) {
          for (const name of readdirSync(p)) sizeOf(join(p, name))
          return
        }
        bytes += st.size
        files++
      } catch {
        /* 读不到就不计入，绝不因为一个坏文件让启动崩掉 */
      }
    }
    try {
      for (const name of readdirSync(this.dir)) {
        const p = join(this.dir, name)
        if (name === INDEX_FILE || name === JOURNAL_FILE) continue
        if (statSync(p).isDirectory()) {
          projects++
          for (const f of readdirSync(p)) sizeOf(join(p, f))
        } else sizeOf(p)
      }
    } catch {
      /* 目录还没建过 = 0 占用 */
    }
    try {
      bytes += statSync(this.indexFile).size
      files++
    } catch {
      /* 索引还没写过 */
    }
    return { bytes, files, projects }
  }
}

/** 同一张规则表里不能有两个同 id 条目（rollback / share 拼装出来的新状态也要过这一关，F-15） */
function assertUniqueRuleIds(rules: Rule[]): void {
  const seen = new Set<string>()
  for (const r of rules) {
    if (!r || typeof r !== 'object') continue
    const id = String(r.id)
    if (seen.has(id)) throw conflict(`duplicate rule id after commit: ${id}`)
    seen.add(id)
  }
}

/**
 * 迁移：保证**没有任何规则处于无归属状态**（协议 §5.4 的硬约束 ①）。
 *
 * 为什么必须做：C14 把 C13 的「无 `groupId` / 悬空 `groupId` 按未分组照常命中」翻转成
 * 「无归属 ⇒ 永不命中」。存量 `rules.json` 里既有未分组规则，也有指向早已删掉的组的悬空规则，
 * 不安置它们就等于「升级后所有人的 mock 悄悄全失效」——而且界面上一切正常，最难查的那种。
 *
 * 安置方式：收进一个服务端生成的**共享**容器（`LEGACY_SHARED_ID` / 「旧版共享规则」）。
 * 选共享而不是给每个人塞一份私有副本：
 * ① 副本该归谁根本无法从数据里推出来（旧规则没有创建人，**不伪造创建人**）；
 * ② 共享容器仍能被任何人 copy，用户复制到自己的私有区就恢复 mock；
 * ③ UI 里它显示为共享项目，「本就不参与命中」是明示的，不是静默的。
 *
 * 顺带处理一类脏值：`scope=private` 但 `ownerPhone` 为空（手改出来的）——它同样无归属，
 * 一并收进旧版容器，否则那些规则连「被复制」的机会都没有。
 *
 * 幂等：第二次启动时已经没有未分组规则，返回 `moved = 0` 且不写文件。
 */
export function migrateProjects(
  groups: GroupStore,
  rules: RuleEngine,
): { moved: number; containerId: string | null; sharedGroups: number } {
  const all = groups.list()
  const sharedConverted = all.filter((g) => g.scope === 'shared').length
  const live = rules.list().filter((r) => r && typeof r === 'object')
  const orphanOwnerless = live.filter((r) => {
    const gid = typeof r.groupId === 'string' ? r.groupId : ''
    if (!gid) return true
    const g = groups.get(gid)
    if (!g) return true
    return g.scope === 'private' && !g.ownerPhone
  })
  if (!orphanOwnerless.length) return { moved: 0, containerId: null, sharedGroups: sharedConverted }
  const container = groups.ensureLegacySharedContainer(LEGACY_SHARED_NAME)
  for (const r of orphanOwnerless) r.groupId = container.id
  // 走 `restore` 而不是 `replaceAll`：后者会逐条做结构校验并**抛 400**。
  // 存量 rules.json 里本来就可能躺着 `match.params` 是数组这种脏条目（读路径不校验就是为了
  // 不崩，F-16），迁移要是把它们送去过 400 那道门，升级当场就变成了「服务起不来」。
  rules.restore(live)
  return { moved: orphanOwnerless.length, containerId: container.id, sharedGroups: sharedConverted }
}
