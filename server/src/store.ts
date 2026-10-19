import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DeviceIdentity, DeviceView, EcRecord, SpaceSummary, User } from './types.ts'

/** 设备表条目 = 对外视图（类型在 types.ts，供管理面 / 控制面共用） */
type DeviceEntry = DeviceView

/**
 * 会话条目（ADR-031）。
 * `expiresAt` 为 `null` = 永不过期（`--session-ttl 0`），与快照的口径一致。
 */
interface SessionEntry {
  phone: string
  expiresAt: number | null
}

interface PersistedState {
  users: User[]
  /** deviceId -> phone，跨重启保留设备绑定关系 */
  bindings: Record<string, string>
  /**
   * sessionId -> 会话，跨重启保留登录态（ADR-031）。
   * **可选**：旧版本落盘的文件没有这一段，恢复时按「无会话」处理，不是错误。
   */
  sessions?: Record<string, SessionEntry>
}

/**
 * 会话 id 的形状：服务端发的是 `randomUUID().replace(/-/g, '')` = 32 位小写 hex。
 * 恢复落盘时卡形状，是为了让手改过的 `store.json` 塞不进 `""`、`"__proto__"` 这类怪 key；
 * **它不承担鉴权**（和 mock CLI 的形状检查同一个道理）。
 */
const SESSION_ID_RE = /^[0-9a-f]{16,128}$/
/**
 * 落盘会话条数上限。会话只在登录时新增、只在 logout / 过期时减少，
 * 一个长期跑的实例会把文件写成几千条 —— 超限按「最早过期的先淘汰」。
 */
const MAX_SESSIONS = 500
/** 未显式传 TTL 时的默认值，与 `--session-ttl` 的默认一致（30 天） */
const DEFAULT_SESSION_TTL_MS = 720 * 3600_000

/**
 * 会话 TTL 入参防御（命令行那一层已由 `readCount` 挡过，这里挡的是直接构造 Store 的调用方）：
 * 脏值 / 负数 / 未传（`undefined`）一律回落默认。
 * `0` 是**合法值**（= 永不过期），所以不能写成 `??`，也不能让 `undefined` 掉进 0。
 */
function normalizeTtlMs(raw: unknown, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return fallback
  return Math.floor(raw)
}

/**
 * 校验并剪枝落盘会话（AGENTS.md §4：落盘 JSON 是写入口，要假设它写错了）。
 * 逐条独立判断：`sessions` 整体是数组 / 字符串 / null，或某条形状不对、已过期，
 * 都只是**丢掉那一条**，绝不能连累 `users` 与 `bindings`。
 */
function normalizeSessions(raw: unknown, now: number): Array<[string, SessionEntry]> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return []
  const out: Array<[string, SessionEntry]> = []
  for (const [sid, e] of Object.entries(raw as Record<string, unknown>)) {
    if (!SESSION_ID_RE.test(sid)) continue
    if (typeof e !== 'object' || e === null) continue
    const phone = (e as { phone?: unknown }).phone
    const expiresAt = (e as { expiresAt?: unknown }).expiresAt
    if (typeof phone !== 'string' || phone === '') continue
    // expiresAt 只接受「null（永不过期）」或「正整数时间戳」；NaN / 字符串 / 负数一律丢弃
    let at: number | null
    if (expiresAt === null) at = null
    else if (typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt > 0) at = Math.floor(expiresAt)
    else continue
    if (at !== null && at <= now) continue
    out.push([sid, { phone, expiresAt: at }])
  }
  return out
}

/** 按 expiresAt 升序淘汰到 max 以内；`null`（永不过期）排在最后，因此优先保留 */
function capSessions(entries: Array<[string, SessionEntry]>, max: number): Array<[string, SessionEntry]> {
  if (entries.length <= max) return entries
  const sorted = [...entries].sort(
    (a, b) => (a[1].expiresAt ?? Infinity) - (b[1].expiresAt ?? Infinity),
  )
  return sorted.slice(sorted.length - max)
}

/**
 * 内存存储（记录/在线状态）+ 落盘持久化（控制台用户、设备绑定关系、登录会话）。
 * 设备按 `${deviceId}:${sessionId}` 建索引，对外按 deviceId 聚合。
 * 重启后：记录丢失（可接受）；用户空间、设备绑定、**登录会话**保留（`.data/store.json`），
 * 会话受 `--session-ttl` 约束（ADR-031）。
 */
export class Store extends EventEmitter {
  private records: EcRecord[] = []
  private devices = new Map<string, DeviceEntry>()
  private users = new Map<string, User>()
  /** sessionId -> 会话条目（phone + 过期时间），跨重启保留 */
  private sessions = new Map<string, SessionEntry>()
  private bindings = new Map<string, string>() // deviceId -> phone（持久化）
  private seqCounter = 0
  private maxRecords: number
  private dataDir: string
  /** 会话有效期（毫秒）；`0` = 永不过期 */
  private sessionTtlMs: number

  constructor(maxRecords: number, dataDir: string = '', sessionTtlMs?: number) {
    super()
    this.maxRecords = maxRecords
    // 空 dataDir = 只跑内存态（自测里大量用例不需要落盘）；生产由 index.ts 传 cfg.dataDir
    this.dataDir = typeof dataDir === 'string' ? dataDir : ''
    this.sessionTtlMs = normalizeTtlMs(sessionTtlMs, DEFAULT_SESSION_TTL_MS)
    this.load()
  }

  // ── 持久化 ──

  private persistPath(): string {
    return join(this.dataDir, 'store.json')
  }

  /** `dataDir` 为空串时禁用文件读写，替代原先「靠 join 抛异常」的隐式行为 */
  private persistEnabled(): boolean {
    return this.dataDir !== ''
  }

  private load(): void {
    if (!this.persistEnabled()) return
    let st: Partial<PersistedState> = {}
    try {
      st = JSON.parse(readFileSync(this.persistPath(), 'utf-8')) as Partial<PersistedState>
    } catch {
      // 首次启动无文件 / 文件不是合法 JSON：按空状态继续
      return
    }
    if (typeof st !== 'object' || st === null) return
    // 三段各自独立恢复：任何一段形状坏了只丢那一段，不连累另外两段
    for (const u of Array.isArray(st.users) ? st.users : []) {
      if (u && typeof u.phone === 'string' && u.phone) this.users.set(u.phone, u)
    }
    const bindingsByPhone = new Map<string, string[]>()
    if (st.bindings && typeof st.bindings === 'object' && !Array.isArray(st.bindings)) {
      for (const [did, phone] of Object.entries(st.bindings)) {
        if (typeof did !== 'string' || typeof phone !== 'string' || !phone) continue
        const deviceIds = bindingsByPhone.get(phone) ?? []
        deviceIds.push(did)
        bindingsByPhone.set(phone, deviceIds)
      }
    }
    for (const [phone, deviceIds] of bindingsByPhone) {
      const user = this.users.get(phone)
      const preferred = typeof user?.lastBoundDeviceId === 'string' && deviceIds.includes(user.lastBoundDeviceId)
        ? user.lastBoundDeviceId
        : deviceIds[deviceIds.length - 1]
      this.bindings.set(preferred, phone)
      if (user) user.lastBoundDeviceId = preferred
    }
    for (const user of this.users.values()) {
      if (!bindingsByPhone.has(user.phone)) user.lastBoundDeviceId = null
    }
    for (const [sid, e] of capSessions(normalizeSessions(st.sessions, Date.now()), MAX_SESSIONS)) {
      this.sessions.set(sid, e)
    }
  }

  private save(): void {
    if (!this.persistEnabled()) return
    try {
      mkdirSync(this.dataDir, { recursive: true })
      const st: PersistedState = {
        users: [...this.users.values()],
        bindings: Object.fromEntries(this.bindings),
        sessions: Object.fromEntries(this.sessions),
      }
      writeFileSync(this.persistPath(), JSON.stringify(st, null, 2))
    } catch (e) {
      console.error('[store] 持久化失败:', e)
    }
  }

  nextSeq(): number {
    return ++this.seqCounter
  }

  addRecord(rec: EcRecord): void {
    this.records.push(rec)
    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords)
    }
    this.emit('record', rec)
  }

  listRecords(opts: { limit?: number; deviceId?: string; q?: string; owner?: string } = {}): EcRecord[] {
    const { limit = 300, deviceId, q, owner } = opts
    let out = this.records
    if (deviceId) out = out.filter((r) => r.deviceId === deviceId)
    // 用户空间只包含自己绑定设备的记录；未绑定设备仍可见于设备列表，但其请求不可浏览。
    if (owner) out = out.filter((r) => this.recordVisible(r.deviceId, owner))
    if (q) {
      const needle = q.toLowerCase()
      out = out.filter(
        (r) =>
          r.request.url?.toLowerCase().includes(needle) ||
          String(r.response.status).includes(needle),
      )
    }
    return out.slice(-limit).reverse()
  }

  getRecord(id: string): EcRecord | undefined {
    return this.records.find((r) => r.id === id)
  }

  /**
   * 清空记录，返回被清掉的条数。
   *
   * 不传过滤条件 = 清空全部；传入时只清命中项。过滤语义与 `listRecords` 保持一致
   * （owner=设备归属、deviceId、q=url/status 模糊），供控制台「清空当前列表」按
   * 「当前用户空间 ∩ 当前筛选」精确清理，避免误删他人空间或未展示的记录。
   *
   * 入参来自 HTTP query，一律按不可信处理（非对象 / 非字符串 / 空串视为未指定），
   * 见 AGENTS.md §4。
   */
  clearRecords(opts?: { owner?: string; deviceId?: string; q?: string }): number {
    const o = (opts && typeof opts === 'object' ? opts : {}) as {
      owner?: unknown
      deviceId?: unknown
      q?: unknown
    }
    const owner = typeof o.owner === 'string' && o.owner ? o.owner : undefined
    const deviceId = typeof o.deviceId === 'string' && o.deviceId ? o.deviceId : undefined
    const q = typeof o.q === 'string' && o.q ? o.q.toLowerCase() : undefined

    const before = this.records.length
    this.records = this.records.filter((r) => {
      if (!r || typeof r !== 'object') return false // 脏条目顺手剔除，不留在内存里
      // 与 listRecords 同口径：只有自己绑定设备的记录可见、可清；未绑定及他人设备记录不动。
      if (owner && !this.recordVisible(r.deviceId, owner)) return true
      if (deviceId && r.deviceId !== deviceId) return true
      if (q) {
        const url = String(r.request?.url ?? '').toLowerCase()
        const status = String(r.response?.status ?? '')
        if (!url.includes(q) && !status.includes(q)) return true
      }
      return false
    })
    return before - this.records.length
  }

  upsertDevice(identity: DeviceIdentity): DeviceEntry {
    const key = `${identity.deviceId}:${identity.sessionId}`
    const prev = this.devices.get(key)
    const entry: DeviceEntry = {
      ...(prev ?? {}),
      ...identity,
      key,
      lastSeenAt: Date.now(),
      online: true,
      // 设备重新出现时恢复持久化的绑定关系（跨重启）
      owner: prev?.owner ?? this.bindings.get(identity.deviceId) ?? null,
      createdAt: prev?.createdAt ?? identity.createdAt ?? Date.now(),
    }
    this.devices.set(key, entry)
    this.emit('devices', this.listDevices())
    return entry
  }

  markOffline(deviceId: string, sessionId: string): void {
    const key = `${deviceId}:${sessionId}`
    const d = this.devices.get(key)
    if (d) {
      d.online = false
      this.emit('devices', this.listDevices())
    }
  }

  /** 按 deviceId 聚合，只保留每个设备最近一次会话 */
  listDevices(): DeviceView[] {
    const byDevice = new Map<string, DeviceEntry>()
    for (const d of this.devices.values()) {
      const prev = byDevice.get(d.deviceId)
      if (!prev || d.lastSeenAt > prev.lastSeenAt) byDevice.set(d.deviceId, d)
    }
    return [...byDevice.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt)
  }

  /**
   * 按空间可见的设备（ADR-018）：自己绑定的 + **尚未被任何人绑定的**。
   *
   * 必须保留「未绑定」那一类——控制台「看到新设备 → 绑定」的主流程依赖它：
   * 只回自己绑定的，新设备永远看不见，也就永远绑不上。他人已绑定的设备不下发。
   *
   * `phone` 来自会话，按不可信处理（AGENTS.md §4）：非字符串 / 空串 → 空数组
   * （宁可什么都不给，也不能因为一个脏值把全量设备漏出去）。
   */
  listDevicesFor(phone: unknown): DeviceView[] {
    if (typeof phone !== 'string' || !phone) return []
    return this.listDevices().filter((d) => d.owner === phone || d.owner === null)
  }

  /**
   * 各用户空间的汇总，供管理员面板使用（ADR-018）。
   * `records` 按**设备归属**统计：未绑定设备的记录不计入任何空间。
   * `listRecords({ owner })` 同样只返回当前绑定设备的记录；未绑定记录不归属任何空间。
   *
   * 范围 = **用户表 ∪ 设备归属里出现过的手机号**：正常流程下两者一致
   * （设备只能由已登录用户绑定），但万一 `store.json` 被手工改过、只剩归属没有用户记录，
   * 也不能让这个空间在管理面板里**静默消失**——面板的意义就是「看得见」。
   */
  listSpaces(): SpaceSummary[] {
    const byOwner = new Map<string, { devices: number; online: number }>()
    for (const d of this.listDevices()) {
      if (!d.owner) continue
      const cur = byOwner.get(d.owner) ?? { devices: 0, online: 0 }
      cur.devices++
      if (d.online) cur.online++
      byOwner.set(d.owner, cur)
    }
    const recordsByOwner = new Map<string, number>()
    for (const r of this.records) {
      if (!r || typeof r !== 'object') continue // 脏条目不计入，与 clearRecords 一致
      const owner = this.deviceOwner(r.deviceId)
      if (!owner) continue
      recordsByOwner.set(owner, (recordsByOwner.get(owner) ?? 0) + 1)
    }
    const phones = new Set<string>([...this.users.keys(), ...byOwner.keys()])
    return [...phones]
      .map((phone) => {
        const user = this.users.get(phone)
        const dev = byOwner.get(phone) ?? { devices: 0, online: 0 }
        return {
          phone,
          createdAt: user?.createdAt ?? 0,
          lastLoginAt: user?.lastLoginAt ?? 0,
          devices: dev.devices,
          online: dev.online,
          records: recordsByOwner.get(phone) ?? 0,
        }
      })
      .sort((a, b) => b.lastLoginAt - a.lastLoginAt)
  }

  /** 某 deviceId 最近一次会话的 entry */
  private latestDevice(deviceId: string): DeviceEntry | undefined {
    let best: DeviceEntry | undefined
    for (const d of this.devices.values()) {
      if (d.deviceId !== deviceId) continue
      if (!best || d.lastSeenAt > best.lastSeenAt) best = d
    }
    return best
  }

  /** 设备当前归属的用户（手机号），未绑定返回 null */
  deviceOwner(deviceId: string): string | null {
    return this.latestDevice(deviceId)?.owner ?? this.bindings.get(deviceId) ?? null
  }

  /**
   * 某条记录对该空间是否可见：只显示空间当前绑定设备的记录。
   * 未绑定设备仍出现在设备列表中供用户选择绑定，但其请求不能进入浏览 / Mock 接口列表。
   *
   * `phone` 来自会话，按不可信处理（AGENTS.md §4）：非字符串 / 空串 → 一律不可见。
   */
  recordVisible(deviceId: string, phone: unknown): boolean {
    if (typeof phone !== 'string' || !phone) return false
    const owner = this.deviceOwner(deviceId)
    return owner === phone
  }

  // ── 控制台用户（手机号注册空间） ──

  upsertUser(phone: string): User {
    const prev = this.users.get(phone)
    const user: User = {
      phone,
      createdAt: prev?.createdAt ?? Date.now(),
      lastLoginAt: Date.now(),
      lastBoundDeviceId: prev?.lastBoundDeviceId ?? null,
    }
    this.users.set(phone, user)
    this.save()
    return user
  }

  listUsers(): User[] {
    return [...this.users.values()].sort((a, b) => b.lastLoginAt - a.lastLoginAt)
  }

  userByPhone(phone: string): User | undefined {
    return this.users.get(phone)
  }

  /**
   * 登录 = 发一个会话。会话带过期时间并**落盘**，所以服务重启后浏览器仍自动登录（ADR-031）。
   * 口令从不进这张表，落盘的只有那串 token 与归属手机号。
   */
  createSession(phone: string): string {
    const sessionId = randomUUID().replace(/-/g, '')
    const expiresAt = this.sessionTtlMs > 0 ? Date.now() + this.sessionTtlMs : null
    this.sessions.set(sessionId, { phone, expiresAt })
    this.pruneSessions()
    // upsertUser 里会 save()：会话与空间在同一次落盘里写出去
    this.upsertUser(phone)
    return sessionId
  }

  /** 会话归属；不存在 / 已过期 → null（过期时顺手从内存删掉） */
  sessionPhone(sessionId: string): string | null {
    if (typeof sessionId !== 'string' || sessionId === '') return null
    const entry = this.sessions.get(sessionId)
    if (!entry) return null
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.sessions.delete(sessionId)
      return null
    }
    return entry.phone
  }

  destroySession(sessionId: string): void {
    if (!this.sessions.delete(sessionId)) return
    // 必须落盘：否则下次重启会把这条「已登出」的会话又复活
    this.save()
  }

  /** 当前会话条数（自测与管理员面板用） */
  sessionCount(): number {
    return this.sessions.size
  }

  /** 剪掉过期会话并按上限淘汰，避免落盘文件只增不减 */
  private pruneSessions(): void {
    const now = Date.now()
    for (const [sid, e] of this.sessions) {
      if (e.expiresAt !== null && e.expiresAt <= now) this.sessions.delete(sid)
    }
    if (this.sessions.size <= MAX_SESSIONS) return
    const keep = capSessions([...this.sessions.entries()], MAX_SESSIONS)
    this.sessions = new Map(keep)
  }

  // ── 设备绑定 ──

  /**
   * 改一台设备的归属。一次改完该 deviceId 的**所有**会话条目并同步落盘表：
   * 聚合视图按最近会话取，残留的旧条目若带着旧归属，会在最近那条被替换时「复活」旧空间。
   */
  private applyOwner(deviceId: string, owner: string | null): void {
    for (const d of this.devices.values()) {
      if (d.deviceId === deviceId) d.owner = owner
    }
    if (owner) this.bindings.set(deviceId, owner)
    else this.bindings.delete(deviceId)
  }

  /**
   * 绑定设备到当前空间；设备不存在 → `ok:false`。
   *
   * **一个空间同时只绑一台**（ADR-032）：绑定成功时自动解掉该用户名下的其它设备，
   * 包含只在落盘 `bindings` 里、这次没连上来的那些（否则它下次连上来就是「第二台」）。
   * 被解绑的设备只是回到「未绑定」，它的记录保留在内存中但不再对普通空间可见。
   */
  bindDevice(phone: string, deviceId: string): { ok: boolean; unbound: string[] } {
    const dev = this.latestDevice(deviceId)
    if (!dev) return { ok: false, unbound: [] }
    const others = new Set<string>()
    for (const d of this.devices.values()) {
      if (d.deviceId !== deviceId && d.owner === phone) others.add(d.deviceId)
    }
    for (const [did, owner] of this.bindings) {
      if (did !== deviceId && owner === phone) others.add(did)
    }
    const unbound = [...others]
    for (const did of unbound) this.applyOwner(did, null)
    this.applyOwner(deviceId, phone)
    const user = this.users.get(phone)
    if (user) user.lastBoundDeviceId = deviceId
    this.save()
    this.emit('devices', this.listDevices())
    return { ok: true, unbound }
  }

  /** 解绑设备；仅该用户自己的绑定可解 */
  unbindDevice(phone: string, deviceId: string): boolean {
    const dev = this.latestDevice(deviceId)
    if (!dev || dev.owner !== phone) return false
    this.applyOwner(deviceId, null)
    const user = this.users.get(phone)
    if (user && user.lastBoundDeviceId === deviceId) user.lastBoundDeviceId = null
    this.save()
    this.emit('devices', this.listDevices())
    return true
  }

  stats(): { records: number; devices: number; online: number } {
    return {
      records: this.records.length,
      devices: this.listDevices().length,
      // F-10：online 按设备去重（同一设备多个会话只算一台），与 listDevices 口径一致
      online: new Set([...this.devices.values()].filter((d) => d.online).map((d) => d.deviceId)).size,
    }
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`
}
