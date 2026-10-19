import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { EcRecord, Snapshot, SnapshotMeta } from './types.ts'

/**
 * 现场快照存储（ADR-017）。
 *
 * 设计要点：
 * - **一条快照一个文件**：`.data/snapshots/<token>.json`。创建 = 写一个文件，失效 = 删一个文件；
 *   避免「单文件数组」在快照体积大（body 可达 maxBufferBytes）时每次创建都全量重写。
 * - **冻结副本**：存的是记录在创建那一刻的完整拷贝，与内存环形缓冲解耦——源记录被淘汰、
 *   服务重启后，已分享出去的链接依然打得开。
 * - **能力 token**：128 位随机（32 hex），不可枚举；持有 token 即视为有权读取（免鉴权是
 *   产品要求，安全边界见 ADR-017）。
 * - 入参一律按不可信处理（AGENTS.md §4）：非字符串 token、非对象记录都不抛崩、不毒化内存。
 */
export class SnapshotStore {
  private dir: string
  private ttlMs: number
  private max: number
  private cache = new Map<string, Snapshot>()

  constructor(dataDir: string, ttlMs: number, max: number) {
    this.dir = join(dataDir, 'snapshots')
    this.ttlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? Math.floor(ttlMs) : 0
    this.max = Number.isFinite(max) && max > 0 ? Math.floor(max) : 200
    mkdirSync(this.dir, { recursive: true })
    this.load()
  }

  // ── 持久化 ──

  private fileOf(token: string): string {
    return join(this.dir, `${token}.json`)
  }

  private load(): void {
    let names: string[] = []
    try {
      names = readdirSync(this.dir)
    } catch {
      return
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(readFileSync(join(this.dir, name), 'utf8'))
      } catch {
        // 脏文件（手工改坏 / 写一半断电）→ 跳过，绝不让它毒化启动（F-16 的教训）
        continue
      }
      const snap = parsed as Snapshot
      if (!snap || typeof snap !== 'object' || typeof snap.token !== 'string' || !snap.token) continue
      if (!snap.record || typeof snap.record !== 'object' || Array.isArray(snap.record)) continue
      if (this.isExpired(snap)) {
        this.unlink(snap.token)
        continue
      }
      this.cache.set(snap.token, snap)
    }
    this.enforceMax()
  }

  private persist(snap: Snapshot): void {
    try {
      mkdirSync(this.dir, { recursive: true })
      // 紧凑序列化：快照是机器读的，且 body 可能很大，不做缩进
      writeFileSync(this.fileOf(snap.token), JSON.stringify(snap), 'utf8')
    } catch (e) {
      console.error('[snapshots] 落盘失败:', e)
    }
  }

  private unlink(token: string): void {
    try {
      rmSync(this.fileOf(token), { force: true })
    } catch {
      /* 删不掉就算了，内存里已经移除，不影响读 */
    }
  }

  private isExpired(snap: Snapshot): boolean {
    const exp = typeof snap.expiresAt === 'number' ? snap.expiresAt : null
    return exp !== null && exp <= Date.now()
  }

  // ── 读写 ──

  /**
   * 冻结一条记录。`rec` 必须是对象（来自 Store 的记录），否则抛 400——
   * 调用方（管理面）已经校验过记录归属，这里只做最后一道结构防御。
   */
  create(rec: EcRecord, createdBy: string, title?: string): Snapshot {
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
      throw Object.assign(new Error('record must be an object'), { statusCode: 400 })
    }
    const now = Date.now()
    const token = randomUUID().replace(/-/g, '')
    const snap: Snapshot = {
      token,
      createdBy: typeof createdBy === 'string' ? createdBy : '',
      createdAt: now,
      expiresAt: this.ttlMs > 0 ? now + this.ttlMs : null,
      title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 200) : defaultTitle(rec),
      // 深拷贝：与源记录彻底解耦（记录是纯 JSON 数据，无 Buffer/Date）
      record: JSON.parse(JSON.stringify(rec)) as EcRecord,
    }
    this.cache.set(token, snap)
    this.persist(snap)
    this.enforceMax()
    return snap
  }

  /** 按 token 读快照；不存在 / 已过期 → undefined（顺手清理过期项） */
  get(token: unknown): Snapshot | undefined {
    if (typeof token !== 'string' || !token) return undefined
    const snap = this.cache.get(token)
    if (!snap) return undefined
    if (this.isExpired(snap)) {
      this.cache.delete(token)
      this.unlink(token)
      return undefined
    }
    return snap
  }

  /** 当前用户创建的快照摘要，按创建时间倒序；`phone` 非字符串 → 空列表 */
  list(phone: unknown): SnapshotMeta[] {
    const owner = typeof phone === 'string' ? phone : ''
    if (!owner) return []
    this.sweep()
    const out: SnapshotMeta[] = []
    for (const snap of this.cache.values()) {
      if (snap.createdBy !== owner) continue
      out.push(toMeta(snap))
    }
    return out.sort((a, b) => b.createdAt - a.createdAt)
  }

  /** 失效单条快照；只有创建者本人能失效（返回是否真的删掉了） */
  revoke(phone: unknown, token: unknown): boolean {
    const owner = typeof phone === 'string' ? phone : ''
    if (!owner || typeof token !== 'string' || !token) return false
    const snap = this.cache.get(token)
    if (!snap || snap.createdBy !== owner) return false
    this.cache.delete(token)
    this.unlink(token)
    return true
  }

  /** 清空当前用户的全部快照，返回条数 */
  clear(phone: unknown): number {
    const owner = typeof phone === 'string' ? phone : ''
    if (!owner) return 0
    let n = 0
    for (const [token, snap] of [...this.cache]) {
      if (snap.createdBy !== owner) continue
      this.cache.delete(token)
      this.unlink(token)
      n++
    }
    return n
  }

  /** 清理全部过期快照，返回条数（定时器与读路径都会调用） */
  sweep(): number {
    let n = 0
    for (const [token, snap] of [...this.cache]) {
      if (!this.isExpired(snap)) continue
      this.cache.delete(token)
      this.unlink(token)
      n++
    }
    return n
  }

  /** 当前快照总数（不分用户，仅供 info 展示） */
  count(): number {
    return this.cache.size
  }

  /** 超出上限时按最旧淘汰（避免磁盘被无限占用） */
  private enforceMax(): number {
    if (this.cache.size <= this.max) return 0
    const oldest = [...this.cache.values()].sort((a, b) => a.createdAt - b.createdAt)
    const drop = this.cache.size - this.max
    for (let i = 0; i < drop; i++) {
      const s = oldest[i]
      if (!s) continue
      this.cache.delete(s.token)
      this.unlink(s.token)
    }
    return drop
  }
}

function defaultTitle(rec: EcRecord): string {
  const req = rec?.request
  const method = typeof req?.method === 'string' ? req.method : ''
  const path = typeof req?.path === 'string' ? req.path : typeof req?.url === 'string' ? req.url : ''
  return `${method} ${path}`.trim() || '未命名快照'
}

function toMeta(snap: Snapshot): SnapshotMeta {
  const req = snap.record?.request
  const res = snap.record?.response
  return {
    token: snap.token,
    createdAt: typeof snap.createdAt === 'number' ? snap.createdAt : 0,
    expiresAt: typeof snap.expiresAt === 'number' ? snap.expiresAt : null,
    title: typeof snap.title === 'string' ? snap.title : '',
    method: typeof req?.method === 'string' ? req.method : '',
    url: typeof req?.url === 'string' ? req.url : '',
    status: typeof res?.status === 'number' ? res.status : 0,
  }
}
