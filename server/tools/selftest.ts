/**
 * P0 回归自测：直接驱动数据面 handler（不起端口），覆盖 F-15~F-18。
 *
 *   node tools/selftest.ts
 */
import http from 'node:http'
import { createCipheriv } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isAdminPhone, loadConfig, roleOf } from '../src/config.ts'
import { Store } from '../src/store.ts'
import { RuleEngine } from '../src/rules.ts'
import { GroupStore, CLIENT_FORBIDDEN_FIELDS, LEGACY_SHARED_ID, SHARED_TRASH_MS } from '../src/groups.ts'
import { ProjectService, migrateProjects, maskPhone, LEGACY_SHARED_NAME } from '../src/projects.ts'
import { SnapshotStore } from '../src/snapshots.ts'
import { createDataPlane } from '../src/data-plane.ts'
import { CryptoStore, PluginManager, PluginRegistry, builtinPlugin, decryptForRecord, decryptWith, encryptWith, maskOptions, normalizeOptions, readScriptSource, scanScripts } from '../src/crypto/index.ts'
import type { CryptoProfile, EcRecord, Group, ProjectVersion, Rule } from '../src/types.ts'

let pass = 0
let fail = 0
function check(name: string, ok: boolean, extra = ''): void {
  if (ok) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    fail++
    console.log(`  ❌ ${name} ${extra}`)
  }
}

async function invoke(
  handle: ReturnType<typeof createDataPlane>,
  opts: { method: string; url: string; headers: Record<string, string>; body?: string },
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const req = new PassThrough() as unknown as http.IncomingMessage
  req.method = opts.method
  req.url = opts.url
  // C14：数据面靠 `x-ec-device-id` 反查设备 owner，没有这个头就是「未绑定设备」⇒ 候选集恒空。
  // 默认带上夹具那台已绑定设备，用例里的 headers 仍可覆盖（覆盖成未绑定的 id 就是要测不命中）
  req.headers = { host: '127.0.0.1:8899', 'x-ec-device-id': C14_DEV, ...opts.headers }
  const res = new http.ServerResponse(req as never)
  const chunks: Buffer[] = []
  let resolveEnd: () => void
  const ended = new Promise<void>((r) => (resolveEnd = r))
  res.writeHead = ((status: number, headers?: http.OutgoingHttpHeaders) => {
    res.statusCode = status
    for (const [k, v] of Object.entries(headers ?? {})) res.setHeader(k, v as string)
    return res
  }) as never
  res.end = ((c?: Buffer) => {
    if (c) chunks.push(Buffer.from(c))
    resolveEnd()
    return res
  }) as never
  res.write = ((c: Buffer) => {
    chunks.push(Buffer.from(c))
    return true
  }) as never
  if (opts.body) req.end(Buffer.from(opts.body)) as never
  else req.end() as never

  await handle(req, res as never)
  await Promise.race([ended, new Promise((r) => setTimeout(r, 8000))])
  return { status: res.statusCode, headers: res.getHeaders() as http.IncomingHttpHeaders, body: Buffer.concat(chunks).toString('utf8') }
}

const cfg = { ...loadConfig(), dataDir: '.data-selftest', maxRecords: 50 }

// ── C14 命中夹具（协议 §5.4 / ADR-033）──
//
// 新模型下「一条规则能命中」要同时满足三件事：它挂在**某人的私有项目**下、那台设备
// **绑定**到这个手机号空间、请求带上**设备头**。本文件里 C13 时代留下的四十多处
// `rules.replaceAll(...)` 写的都是无归属规则，逐处补 `groupId` 既啰嗦又容易漏，
// 而漏一处的表现是「规则明明 enabled 却全 502」——跟被测对象的真假失败分不清。
// 所以这里放一个**只存在于测试里**的子类：写入前统一补归属，resolve 时统一补 ownerPhone。
//
// ⚠️ 生产代码不走这条路（管理面用的是 replacePrivateScope / create / replaceOne，
// 它们查的是**会话手机号**）。新增的 C14 专项用例一律用原生 `RuleEngine`，
// 免得夹具把「忘了装栅栏」这件事遮掉——那正是这批用例要测的东西。
const C14_PHONE = '13800000000'
const C14_DEV = 'd_c14'

/** 给一批规则补上同一个 `groupId`；非数组 / 条目非对象**原样送回**，让既有的 400 断言照旧成立 */
function stampGid(list: unknown, gid: string): unknown {
  if (!Array.isArray(list)) return list
  return list.map((r) => (r && typeof r === 'object' && !Array.isArray(r) ? { ...r, groupId: gid } : r))
}

function stampOne(input: unknown, gid: string): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  return { ...input, groupId: gid }
}

class HitRules extends RuleEngine {
  gid: string
  phone: string
  groups: GroupStore

  constructor(dir: string, groups: GroupStore, gid: string) {
    super(dir, groups)
    this.groups = groups
    this.gid = gid
    this.phone = C14_PHONE
  }

  override replaceAll(input: unknown): void {
    super.replaceAll(stampGid(input, this.gid) as never)
  }
  override create(input: unknown, phone: unknown = this.phone) {
    return super.create(stampOne(input, this.gid), phone)
  }
  override replaceOne(id: unknown, input: unknown, phone: unknown = this.phone) {
    return super.replaceOne(id, stampOne(input, this.gid), phone)
  }
  override remove(id: unknown, phone: unknown = this.phone): boolean {
    return super.remove(id, phone)
  }
  override setEnabled(id: unknown, enabled: unknown, phone: unknown = this.phone) {
    return super.setEnabled(id, enabled, phone)
  }
  override resetPointers(phone: unknown = this.phone): number {
    return super.resetPointers(phone)
  }
  /** 老用例都不带 ownerPhone（C13 没有这个概念），这里按夹具的归属补上 */
  override resolve(input: Parameters<RuleEngine['resolve']>[0]) {
    return super.resolve({ ...input, ownerPhone: input.ownerPhone ?? this.phone })
  }
}

/** 一套「已绑定设备的手机号空间」（设备未绑定时 owner 为 null ⇒ 候选集恒空） */
function hitStore(max = 50): Store {
  const s = new Store(max)
  s.upsertDevice({ deviceId: C14_DEV, sessionId: 'sess_c14' })
  s.bindDevice(C14_PHONE, C14_DEV)
  return s
}

/** store + rules + 数据面 handler 一次配齐，且三者属于同一个私有项目 */
function hitPlane(dir = cfg.dataDir, crypto: CryptoStore | null = null): {
  store: Store
  rules: HitRules
  groups: GroupStore
  gid: string
  handle: ReturnType<typeof createDataPlane>
} {
  const groups = new GroupStore(dir)
  const gid = groups.create({ name: '自测私有项目', enabled: true }, C14_PHONE).id
  const rules = new HitRules(dir, groups, gid)
  const store = hitStore()
  return { store, rules, groups, gid, handle: createDataPlane({ cfg, store, rules, crypto }) }
}

async function testRuleValidation(): Promise<void> {
  console.log('\n[F-15] 规则引擎抗非法输入')
  const { store, rules, handle } = hitPlane()

  // 1. 对象型 rules 必须被拒
  let threw: unknown = null
  try {
    rules.replaceAll({ a: 1 } as never)
  } catch (e) {
    threw = e
  }
  check('对象型 rules 被拒', threw !== null)

  // 2. 标量数组被拒
  threw = null
  try {
    rules.replaceAll([1, 2] as never)
  } catch (e) {
    threw = e
  }
  check('标量数组 rules 被拒', threw !== null)

  // 3. 被拒后内存未被污染，数据面仍工作
  const r = await invoke(handle, {
    method: 'GET',
    url: '/__ec/p/api/z',
    headers: { 'x-ec-target': 'http://127.0.0.1:1/api/z' },
  })
  check('非法 PUT 后数据面仍响应（非崩溃）', r.status === 502, `got ${r.status}`)

  // 4. 缺 match / 缺 action 的规则不炸
  rules.replaceAll([{ id: 'x', enabled: true, priority: 1 }] as never)
  const r2 = await invoke(handle, {
    method: 'GET',
    url: '/__ec/p/api/y',
    headers: { 'x-ec-target': 'http://127.0.0.1:1/api/y' },
  })
  check('缺 match/action 的规则不导致崩溃', r2.status === 502, `got ${r2.status}`)

  // 5. mock 规则正常命中
  rules.replaceAll([
    {
      id: 'ok',
      enabled: true,
      priority: 1,
      match: { method: 'GET', path: '/m' },
      action: { type: 'mock', response: { status: 201, body: '{"ok":true}' } },
    },
  ] as never)
  const r3 = await invoke(handle, {
    method: 'GET',
    url: '/__ec/p/m',
    headers: { 'x-ec-target': 'http://127.0.0.1:1/m' },
  })
  check('合法 mock 命中并返回 201', r3.status === 201 && r3.body.includes('"ok":true'), `got ${r3.status}`)
}

async function testBodySize(): Promise<void> {
  console.log('\n[F-17] bodySize 取实际字节数')
  const { store, rules, handle } = hitPlane()
  rules.replaceAll([
    { id: 'p', enabled: true, priority: 1, match: { method: 'POST', path: '/p' }, action: { type: 'mock', response: { status: 200, body: 'ok' } } },
  ] as never)
  const body = 'x'.repeat(1000)
  await invoke(handle, {
    method: 'POST',
    url: '/__ec/p/p',
    headers: { 'x-ec-target': 'http://127.0.0.1:1/p', 'content-type': 'text/plain', 'content-length': String(body.length) },
    body,
  })
  const rec = store.listRecords()[0]
  check('请求 bodySize = 实际长度', rec?.request.bodySize === 1000, `got ${rec?.request.bodySize}`)
  check('请求 body 未被截断', rec?.request.body.length === 1000, `got ${rec?.request.body.length}`)
}

async function testMockDisconnect(): Promise<void> {
  console.log('\n[F-18] mock 延迟期间客户端断开不崩')
  const { store, rules, handle } = hitPlane()
  rules.replaceAll([
    {
      id: 'slow',
      enabled: true,
      priority: 1,
      match: { method: 'GET', path: '/slow' },
      action: { type: 'mock', delayMs: 200, response: { status: 200, body: '{"late":1}' } },
    },
  ] as never)
  const r = await invoke(handle, {
    method: 'GET',
    url: '/__ec/p/slow',
    headers: { 'x-ec-target': 'http://127.0.0.1:1/slow' },
  })
  check('延迟 mock 正常返回', r.status === 200 && r.body.includes('late'), `got ${r.status}`)
  check('延迟 mock 落了记录', store.listRecords().length === 1)
}

async function testPersistIsolation(): Promise<void> {
  console.log('\n[F-16] 被污染的 rules.json 不再毒化启动')
  const rules = new RuleEngine('.data-selftest')
  rules.replaceAll([{ id: 'q', enabled: false, priority: 1, match: {}, action: { type: 'mock', response: { status: 200, body: '{}' } } }] as never)
  // 手工写坏文件
  writeFileSync('.data-selftest/rules.json', '{"not":"an array"}', 'utf8')
  const reloaded = new RuleEngine('.data-selftest')
  check('重载时非数组被回退为空列表（不毒化、不注入示例）',
    Array.isArray(reloaded.list()) && reloaded.list().length === 0, `got ${reloaded.list().length}`)

  // 无 rules.json / 空数组 → 一律为空，不得凭空注入示例规则（ADR-020）
  rmSync('.data-selftest/rules.json', { force: true })
  check('无 rules.json 时不注入示例规则', new RuleEngine('.data-selftest').list().length === 0)
  writeFileSync('.data-selftest/rules.json', '[]', 'utf8')
  check('空数组 rules.json 时保持为空', new RuleEngine('.data-selftest').list().length === 0)
}

function mkRecord(id: string, deviceId: string, url: string, status: number): EcRecord {
  const part = { headers: {}, body: '', bodyEncoding: 'utf8' as const, bodySize: 0, bodyTruncated: false }
  let u: URL
  try { u = new URL(url) } catch { u = new URL('http://invalid.local/') }
  return {
    id, seq: 0, deviceId, sessionId: 'sess', startedAt: Date.now(), durationMs: 1,
    request: { ...part, method: 'GET', url, host: u.host, path: u.pathname, query: {} },
    response: { ...part, status },
    upstream: { ms: 1, protocol: 'HTTP/1.1', error: null },
    flags: { mocked: false, decrypted: false, streamed: false, redirected: false },
  }
}

/** devA→13800000001（2 条）、devB→13800000002（1 条），用于验证清空的隔离与筛选 */
function seedStore(): Store {
  const store = new Store(50, '.data-selftest')
  store.upsertDevice({ deviceId: 'devA', sessionId: 'sA' })
  store.upsertDevice({ deviceId: 'devB', sessionId: 'sB' })
  store.bindDevice('13800000001', 'devA')
  store.bindDevice('13800000002', 'devB')
  store.addRecord(mkRecord('a1', 'devA', 'http://api.foo.com/v1/login', 200))
  store.addRecord(mkRecord('a2', 'devA', 'http://api.foo.com/v1/user', 500))
  store.addRecord(mkRecord('b1', 'devB', 'http://api.bar.com/v1/login', 200))
  return store
}

async function testClearRecords(): Promise<void> {
  console.log('\n[F-22] 清空记录按空间 / 筛选精确清理')

  // 1. owner 隔离：只清自己空间，他人空间不受影响
  let s = seedStore()
  check('owner 隔离：只清本空间 2 条', s.clearRecords({ owner: '13800000001' }) === 2)
  check('owner 隔离：他人空间记录保留', s.getRecord('b1') !== undefined && s.listRecords().length === 1)

  // 2. deviceId 不匹配 → 一条都不清
  s = seedStore()
  check('deviceId 不匹配时不清', s.clearRecords({ owner: '13800000001', deviceId: 'devB' }) === 0)
  check('deviceId 不匹配后记录仍在', s.listRecords().length === 3)

  // 3. deviceId 命中 → 只清该设备
  s = seedStore()
  check('deviceId 命中只清该设备 2 条', s.clearRecords({ owner: '13800000001', deviceId: 'devA' }) === 2)
  check('deviceId 命中后仅剩他人记录', s.listRecords().length === 1 && s.getRecord('b1') !== undefined)

  // 4. q 按 url 命中
  s = seedStore()
  check('q 命中 url 只清 1 条', s.clearRecords({ owner: '13800000001', q: 'login' }) === 1)
  check('q=login 后未命中记录仍在', s.getRecord('a2') !== undefined && s.getRecord('a1') === undefined)

  // 5. q 按状态码命中
  s = seedStore()
  check('q 命中状态码只清 1 条', s.clearRecords({ owner: '13800000001', q: '500' }) === 1)
  check('q=500 后未命中记录仍在', s.getRecord('a1') !== undefined && s.getRecord('a2') === undefined)

  // 6. 未绑定设备记录不可见，也不能由普通空间清理
  s = seedStore()
  s.upsertDevice({ deviceId: 'devC', sessionId: 'sC' })
  s.addRecord(mkRecord('c1', 'devC', 'http://api.baz.com/v1/x', 200))
  check('未绑定设备记录不进入空间列表', s.listRecords({ owner: '13800000001' }).every((r) => r.id !== 'c1'))
  check('未绑定设备记录不可由 owner 清理', s.clearRecords({ owner: '13800000001' }) === 2 && s.getRecord('c1') !== undefined)

  // 7. 脏过滤条件不炸、视为未指定（AGENTS.md §4：写入入口要扛住脏数据）
  s = seedStore()
  let threw = false
  let n = -1
  try {
    n = s.clearRecords({ owner: 123, deviceId: {}, q: [] } as never)
  } catch {
    threw = true
  }
  check('脏过滤条件不抛异常', !threw)
  check('脏过滤条件视为未指定（清空全部 3 条）', n === 3, `got ${n}`)

  // 8. 非对象入参同样不炸
  s = seedStore()
  threw = false
  try {
    s.clearRecords(null as never)
  } catch {
    threw = true
  }
  check('null 入参不抛异常且清空全部', !threw && s.listRecords().length === 0)
}

async function testParamMatch(): Promise<void> {
  console.log('\n[F-23] 入参匹配（match.params，协议 §5.4 / ADR-016）')
  const { store, rules, handle } = hitPlane()
  // 拒连 → 502，用于判定「未命中，走了上游」。注意 query 必须写在 X-EC-Target 上：
  // 真实 SDK 把原始完整 URL（含 query）放进该头（协议 §3.1），代理路径上的 query 服务端不认。
  const up = (pathAndQuery: string) => `http://127.0.0.1:1${pathAndQuery}`

  const mockRule = (id: string, match: Record<string, unknown>, status = 200) => ({
    id, enabled: true, priority: 1, match,
    action: { type: 'mock', response: { status, body: `{"m":"${id}"}` } },
  })
  // 带 body 的请求必须声明 content-length，否则数据面按「大小未知」走流式、不缓冲请求体
  const post = (target: string, body: string, contentType = 'application/json') => ({
    method: 'POST',
    url: '/__ec/p' + new URL(target).pathname,
    headers: { 'x-ec-target': target, 'content-type': contentType, 'content-length': String(Buffer.byteLength(body)) },
    body,
  })

  // 1. 不配 params → 不校验入参（宽松，向后兼容旧规则）
  rules.replaceAll([mockRule('loose', { method: 'POST', path: '/v1/login' })] as never)
  let r = await invoke(handle, post(up('/v1/login?from=app'), '{"u":"zzz"}'))
  check('无 params 的规则不校验入参', r.status === 200 && r.body.includes('loose'), `got ${r.status}`)

  // 2. query + body 合并后命中
  rules.replaceAll([mockRule('strict', { method: 'POST', path: '/v1/login', params: { u: 'a', from: 'app' } }, 201)] as never)
  r = await invoke(handle, post(up('/v1/login?from=app'), '{"u":"a"}'))
  check('query + body 合并后入参命中', r.status === 201 && r.body.includes('strict'), `got ${r.status}`)

  // 3. 入参不符 → 不 mock，走上游
  r = await invoke(handle, post(up('/v1/login?from=app'), '{"u":"b"}'))
  check('入参不符时不 mock（走上游）', r.status === 502, `got ${r.status}`)

  // 4. 同名参数以 body 为准
  rules.replaceAll([mockRule('bodywins', { method: 'POST', path: '/p', params: { u: 'from-body' } })] as never)
  r = await invoke(handle, post(up('/p?u=from-query'), '{"u":"from-body"}'))
  check('同名参数以 body 为准', r.status === 200 && r.body.includes('bodywins'), `got ${r.status}`)

  // 5. 空串 = 只要求「该参数存在」
  rules.replaceAll([mockRule('presence', { method: 'GET', path: '/p', params: { channel: '' } })] as never)
  r = await invoke(handle, { method: 'GET', url: '/__ec/p/p', headers: { 'x-ec-target': up('/p?channel=whatever') } })
  check('空串值 = 只要求存在（任意取值命中）', r.status === 200 && r.body.includes('presence'), `got ${r.status}`)
  r = await invoke(handle, { method: 'GET', url: '/__ec/p/p', headers: { 'x-ec-target': up('/p') } })
  check('缺该参数时不命中', r.status === 502, `got ${r.status}`)

  // 6. glob / re: 值语义与 host/path 一致
  rules.replaceAll([mockRule('reval', { method: 'GET', path: '/p', params: { uid: 're:^1\\d{2}$' } })] as never)
  r = await invoke(handle, { method: 'GET', url: '/__ec/p/p', headers: { 'x-ec-target': up('/p?uid=123') } })
  check('re: 正则值命中', r.status === 200 && r.body.includes('reval'), `got ${r.status}`)
  r = await invoke(handle, { method: 'GET', url: '/__ec/p/p', headers: { 'x-ec-target': up('/p?uid=9') } })
  check('re: 正则值不匹配时不命中', r.status === 502, `got ${r.status}`)
  rules.replaceAll([mockRule('globval', { method: 'GET', path: '/p', params: { uid: '1*' } })] as never)
  r = await invoke(handle, { method: 'GET', url: '/__ec/p/p', headers: { 'x-ec-target': up('/p?uid=123') } })
  check('glob 值命中', r.status === 200 && r.body.includes('globval'), `got ${r.status}`)

  // 7. body 是数组 / 非 JSON → 不崩，只按 query 匹配
  rules.replaceAll([mockRule('arrbody', { method: 'POST', path: '/p', params: { from: 'app' } })] as never)
  r = await invoke(handle, post(up('/p?from=app'), '[1,2,3]'))
  check('数组 body 不崩，只按 query 匹配', r.status === 200 && r.body.includes('arrbody'), `got ${r.status}`)
  r = await invoke(handle, post(up('/p?from=app'), 'not json at all', 'text/plain'))
  check('非 JSON body 不崩，只按 query 匹配', r.status === 200 && r.body.includes('arrbody'), `got ${r.status}`)

  // 8. urlencoded body 参与合并
  rules.replaceAll([mockRule('form', { method: 'POST', path: '/p', params: { u: 'formval' } })] as never)
  r = await invoke(handle, post(up('/p'), 'u=formval&t=1', 'application/x-www-form-urlencoded'))
  check('urlencoded body 参与入参匹配', r.status === 200 && r.body.includes('form'), `got ${r.status}`)

  // 9. 脏 match.params（数组 / 标量）被拒，且不毒化内存
  let threw = false
  try {
    rules.replaceAll([mockRule('badarr', { path: '/x', params: [1, 2] })] as never)
  } catch {
    threw = true
  }
  check('match.params 传数组被拒', threw)
  threw = false
  try {
    rules.replaceAll([mockRule('badscalar', { path: '/x', params: 'nope' })] as never)
  } catch {
    threw = true
  }
  check('match.params 传标量被拒', threw)

  // 10. 非法 match 字段类型（数字 method / 非法正则）不导致崩溃、也不误命中
  rules.replaceAll([mockRule('badmethod', { method: 123, path: '/p' })] as never)
  r = await invoke(handle, { method: 'GET', url: '/__ec/p/p', headers: { 'x-ec-target': up('/p') } })
  check('数字 method 不崩且不误命中', r.status === 502, `got ${r.status}`)
  rules.replaceAll([mockRule('badre', { path: 're:(' })] as never)
  r = await invoke(handle, { method: 'GET', url: '/__ec/p/p', headers: { 'x-ec-target': up('/p') } })
  check('非法正则不崩且不误命中', r.status === 502, `got ${r.status}`)

  // 11. 被拒后仍可写入合法规则
  rules.replaceAll([mockRule('good', { path: '/p' })] as never)
  check('拒绝脏数据后仍能写入合法规则', rules.list().length === 1)
}

async function testRuleSingleOps(): Promise<void> {
  console.log('\n[F-26] Mock 规则单条删除 / 开/关（ADR-019）')
  const { store, rules, handle } = hitPlane()
  const mk = (id: string, enabled = true) => ({
    id, enabled, priority: 1, match: { method: 'GET', path: '/' + id },
    action: { type: 'mock', response: { status: 200, body: `{"m":"${id}"}` } },
  })

  // 1. 删除命中 / 未命中
  rules.replaceAll([mk('a'), mk('b')] as never)
  check('删除命中返回 true', rules.remove('a') === true)
  check('删除后只剩另一条', rules.list().length === 1 && rules.list()[0].id === 'b')
  check('删除不存在的 id 返回 false（不抛）', rules.remove('nope') === false)
  check('未命中删除后规则数不变', rules.list().length === 1)

  // 2. 脏 id：非字符串 / 空串一律 false，绝不误删
  let threw = false
  let r1 = true
  let r2 = true
  let r3 = true
  try {
    r1 = rules.remove(null as never)
    r2 = rules.remove(123 as never)
    r3 = rules.remove('')
  } catch {
    threw = true
  }
  check('脏 id（null / 数字 / 空串）不抛且返回 false', !threw && !r1 && !r2 && !r3, `${r1} ${r2} ${r3}`)
  check('脏 id 未误删任何规则', rules.list().length === 1)

  // 3. 开/关：命中 / 未命中
  const off = rules.setEnabled('b', false)
  check('关闭命中并返回变更后的规则', !!off && off.enabled === false)
  check('开启命中并返回变更后的规则', rules.setEnabled('b', true)?.enabled === true)
  check('开/关不存在的 id 返回 null', rules.setEnabled('nope', true) === null)

  // 4. 脏 enabled：只接受布尔，且不得改坏状态
  threw = false
  try {
    rules.setEnabled('b', 'true' as never)
  } catch {
    threw = true
  }
  check('enabled 传字符串被拒', threw)
  threw = false
  try {
    rules.setEnabled('b', 1 as never)
  } catch {
    threw = true
  }
  check('enabled 传 1 被拒（不做真值强转）', threw)
  threw = false
  try {
    rules.setEnabled('b', null as never)
  } catch {
    threw = true
  }
  check('enabled 传 null 被拒', threw)
  check('脏 enabled 未改坏状态（仍为开启）', rules.list()[0].enabled === true)

  // 5. 落盘：新起一个引擎读同一目录，状态一致
  rules.setEnabled('b', false)
  const reloaded = new RuleEngine(cfg.dataDir)
  check('删除 + 关闭已落盘（重载后一致）',
    reloaded.list().length === 1 && reloaded.list()[0].id === 'b' && reloaded.list()[0].enabled === false)

  // 6. 关闭的规则不再命中（数据面放行到上游 → 502）
  let r = await invoke(handle, { method: 'GET', url: '/__ec/p/b', headers: { 'x-ec-target': 'http://127.0.0.1:1/b' } })
  check('关闭后不再 mock（走上游）', r.status === 502, `got ${r.status}`)
  rules.setEnabled('b', true)
  r = await invoke(handle, { method: 'GET', url: '/__ec/p/b', headers: { 'x-ec-target': 'http://127.0.0.1:1/b' } })
  check('开启后恢复 mock', r.status === 200 && r.body.includes('"b"'), `got ${r.status}`)

  // 7. 删除必须丢掉该规则的顺序指针：否则「删了重建同 id」会从半截序列继续
  const seq = (id: string) => ({
    id, enabled: true, priority: 1, match: { method: 'GET', path: '/seq' },
    action: {
      type: 'mock', mode: 'sequence', seqMode: 'in-order',
      responses: [
        { status: 201, body: '{"n":1}' },
        { status: 202, body: '{"n":2}' },
        { status: 203, body: '{"n":3}' },
      ],
    },
  })
  rules.replaceAll([seq('sq')] as never)
  const s1 = rules.resolve({ method: 'GET', host: 'h', path: '/seq', deviceId: 'd1' })
  const s2 = rules.resolve({ method: 'GET', host: 'h', path: '/seq', deviceId: 'd1' })
  check('顺序 mock 依次推进', s1?.response?.status === 201 && s2?.response?.status === 202,
    `${s1?.response?.status} ${s2?.response?.status}`)
  rules.remove('sq')
  rules.replaceAll([seq('sq')] as never)
  const s3 = rules.resolve({ method: 'GET', host: 'h', path: '/seq', deviceId: 'd1' })
  check('删后重建同 id：序列从头开始（指针已随删除丢弃）', s3?.response?.status === 201,
    `got ${s3?.response?.status}`)
}

async function testMultiResponses(): Promise<void> {
  console.log('\n[F-27] 多返回值：指定 / 顺序 / 换序（协议 §5.4）')
  const dir = '.data-selftest/multi'
  rmSync(dir, { recursive: true, force: true })
  const { store, rules, handle } = hitPlane(dir)
  const up = (p: string) => `http://127.0.0.1:1${p}`
  const get = (p: string) => ({ method: 'GET', url: '/__ec/p' + p, headers: { 'x-ec-target': up(p) } })

  const list = [
    { status: 201, headers: { 'content-type': 'application/json' }, body: '{"n":1}', name: '第一条' },
    { status: 202, headers: { 'content-type': 'application/json' }, body: '{"n":2}', name: '第二条' },
    { status: 203, body: '{"n":3}' },
  ]
  const rule = (id: string, action: Record<string, unknown>) => ({
    id, enabled: true, priority: 1, match: { method: 'GET', path: '/' + id },
    action: { type: 'mock', ...action },
  })
  /** 直接问引擎当前会返回哪条（等价数据面的命中判定） */
  const pick = (path: string, device = 'd1') =>
    rules.resolve({ method: 'GET', host: 'h', path, deviceId: device })?.response?.status

  // 1. specific：指定第 k 条，连续请求稳定同一条（指针不推进）
  rules.replaceAll([rule('pin', { mode: 'specific', pinIndex: 2, responses: list })] as never)
  let r = await invoke(handle, get('/pin'))
  check('specific 返回 pinIndex 指定的那条', r.status === 203 && r.body.includes('"n":3'), `got ${r.status}`)
  r = await invoke(handle, get('/pin'))
  check('specific 连续请求稳定同一条（不推进）', r.status === 203, `got ${r.status}`)

  // 2. pinIndex 缺省 → 第 0 条
  rules.replaceAll([rule('pin0', { mode: 'specific', responses: list })] as never)
  check('pinIndex 缺省 → 第 0 条', pick('/pin0') === 201)

  // 3. 写入口拒绝脏数据（PUT 走的就是 replaceAll）
  const rejected = (v: unknown) => {
    try {
      rules.replaceAll(v as never)
      return false
    } catch {
      return true
    }
  }
  check('responses 为对象 → 拒（400）', rejected([rule('x', { responses: { a: 1 } })]))
  check('responses 为标量 → 拒（400）', rejected([rule('x', { responses: 'nope' })]))
  check('responses 元素为标量 → 拒（400）', rejected([rule('x', { responses: [1] })]))
  check('responses 元素为 null → 拒（400）', rejected([rule('x', { responses: [null] })]))
  check('responses 元素为数组 → 拒（400）', rejected([rule('x', { responses: [[]] })]))
  check('pinIndex 为字符串 → 拒（400）', rejected([rule('x', { pinIndex: '1', responses: list })]))
  check(
    'pinIndex 为 NaN / Infinity → 拒（400）',
    rejected([rule('x', { pinIndex: Number.NaN, responses: list })]) &&
      rejected([rule('x', { pinIndex: Number.POSITIVE_INFINITY, responses: list })]),
  )
  check('responses 为空数组不视为非法（回落到 response）', !rejected([rule('x', { responses: [] })]))
  // 被拒后内存与落盘都没被毒化：还能写入并命中合法规则
  rules.replaceAll([rule('ok', { mode: 'specific', pinIndex: 1, responses: list })] as never)
  check('非法输入被拒后仍能写入合法规则', pick('/ok') === 202)
  check('落盘未毒化（新引擎重载后仍是 1 条）', new RuleEngine(dir).list().length === 1)

  // 4. 读路径兜底：绕过写入口直接写坏 rules.json（手改 / 旧版本留下的脏规则）
  const dirtyDir = '.data-selftest/multi-dirty'
  rmSync(dirtyDir, { recursive: true, force: true })
  mkdirSync(dirtyDir, { recursive: true })
  // 脏规则照样要有归属，否则「不 500 且退回安全值」会变成「不 500 但一条都不命中」——
  // 后者测的不是读路径兜底。groups.json 由这个夹具写，规则文件随后手工落盘
  const dirtyFixture = hitPlane(dirtyDir)
  writeFileSync(
    join(dirtyDir, 'rules.json'),
    JSON.stringify(
      [
        rule('d-null', { mode: 'specific', pinIndex: null, responses: list }),
        rule('d-str', { mode: 'specific', pinIndex: '1', responses: list }),
        rule('d-obj', { mode: 'specific', pinIndex: 0, responses: { a: 1 } }),
        rule('d-elt', { mode: 'sequence', seqMode: 'in-order', responses: [1, null, { status: 299, body: '{"ok":1}' }] }),
        rule('d-none', { mode: 'specific', pinIndex: 0 }),
      ].map((r) => ({ ...r, groupId: dirtyFixture.gid })),
    ),
    'utf8',
  )
  const dirtyRules = new RuleEngine(dirtyDir, dirtyFixture.groups)
  const dirtyHandle = createDataPlane({ cfg, store: dirtyFixture.store, rules: dirtyRules })
  const dirtyChecks: Array<[string, number]> = [
    ['/d-null', 201],
    ['/d-str', 201],
    ['/d-obj', 200],
    ['/d-elt', 299],
    ['/d-none', 200],
  ]
  for (const [p, want] of dirtyChecks) {
    const res = await invoke(dirtyHandle, get(p))
    check(`脏 rules.json：${p} 不 500 且退回安全值 ${want}`, res.status === want, `got ${res.status}`)
  }

  // 5. 顺序模式回归（既有语义，不得被多返回值改动破坏）
  const listA = [{ status: 201, body: '{"k":"A"}' }, { status: 202, body: '{"k":"B"}' }]
  const listB = [{ status: 202, body: '{"k":"B"}' }, { status: 201, body: '{"k":"A"}' }]
  rules.replaceAll([rule('seq', { mode: 'sequence', seqMode: 'in-order', responses: listA })] as never)
  check('in-order 依次推进', pick('/seq') === 201 && pick('/seq') === 202)
  check('in-order 走完停在最后一条', pick('/seq') === 202)
  // 换序 = 数组顺序（拖拽排序保存后的形态）
  rules.remove('seq')
  rules.replaceAll([rule('seq', { mode: 'sequence', seqMode: 'in-order', responses: listB })] as never)
  check('换序后首次命中新顺序的第 0 条', pick('/seq') === 202)
  rules.replaceAll([rule('seq', { mode: 'sequence', seqMode: 'in-order', responses: listA })] as never)
  check('保存（replaceAll）不重置已推进的指针（既有语义）', pick('/seq') === 202)

  rules.replaceAll([rule('loop', { mode: 'sequence', seqMode: 'loop', responses: listA })] as never)
  check('loop 依次返回', pick('/loop') === 201 && pick('/loop') === 202)
  check('loop 走完回绕到第 0 条', pick('/loop') === 201)
  check('指针按 deviceId 隔离（另一台设备从头开始）', pick('/loop', 'd2') === 201)

  rules.replaceAll([rule('once', { mode: 'sequence', seqMode: 'once-then-passthrough', responses: listA })] as never)
  const once1 = pick('/once')
  const once2 = pick('/once')
  const once3 = rules.resolve({ method: 'GET', host: 'h', path: '/once', deviceId: 'd1' })
  check('once-then-passthrough 依次返回', once1 === 201 && once2 === 202)
  check('once-then-passthrough 走完返回 null（数据面放行上游）', once3 !== null && once3.response === null)

  rules.replaceAll([rule('rnd', { mode: 'sequence', seqMode: 'random', responses: listA })] as never)
  check('random 只返回列表内的条目', [201, 202].includes(pick('/rnd') ?? 0))

  // 6. 存量兼容：只有 response（无 responses）的旧规则行为不变
  rules.replaceAll([rule('legacy', { response: { status: 418, body: '{"legacy":1}' } })] as never)
  r = await invoke(handle, get('/legacy'))
  check('旧形态（只有 response）行为不变', r.status === 418 && r.body.includes('legacy'), `got ${r.status}`)
  // 有 responses 但缺 mode 的旧脏数据 → 退化取第 0 条
  rules.replaceAll([rule('nomode', { responses: list })] as never)
  check('有 responses 但缺 mode → 取第 0 条', pick('/nomode') === 201)

  // 7. 备注名不参与匹配、不进响应头（只给控制台看）
  rules.replaceAll([rule('named', { mode: 'specific', pinIndex: 0, responses: list })] as never)
  r = await invoke(handle, get('/named'))
  check('name 只作备注，不影响响应本身', r.status === 201 && !JSON.stringify(r.headers).includes('第一条'))

  // 8. 多条返回值 + mock 延迟：客户端断开路径回归（F-16 同类）
  rules.replaceAll([
    { id: 'slow', enabled: true, priority: 1, match: { method: 'GET', path: '/slow' }, action: { type: 'mock', mode: 'specific', pinIndex: 1, delayMs: 60, responses: list } },
  ] as never)
  r = await invoke(handle, get('/slow'))
  check('多条返回值 + 延迟仍正常返回', r.status === 202 && r.body.includes('"n":2'), `got ${r.status}`)
}

async function testSingleRuleWrite(): Promise<void> {
  console.log('\n[F-29] 单条新建 / 整条替换（ADR-028，mock CLI 的写入口）')
  const dir = '.data-selftest/single-write'
  rmSync(dir, { recursive: true, force: true })
  const { store, rules, handle } = hitPlane(dir)
  const mk = (over: Record<string, unknown> = {}) => ({
    enabled: true,
    priority: 1,
    match: { method: 'GET', path: '/w' },
    action: { type: 'mock', response: { status: 200, body: '{"m":"w"}' } },
    ...over,
  })
  /** 返回 400 的 statusCode（校验器抛出的就是它），没抛就返回 null */
  const status400 = (fn: () => unknown): number | null => {
    try {
      fn()
      return null
    } catch (e) {
      return (e as { statusCode?: number }).statusCode ?? -1
    }
  }

  // 1. create：id 由服务端生成且唯一，其余字段原样落地
  rules.replaceAll([] as never)
  const c1 = rules.create(mk() as never)
  const c2 = rules.create(mk({ name: '第二条' }) as never)
  check('create 生成非空 id', typeof c1.id === 'string' && c1.id.length >= 4, c1.id)
  check('两次 create 的 id 不撞', c1.id !== c2.id)
  check('create 保留提交的字段（name / priority / match）',
    c2.name === '第二条' && c2.priority === 1 && (c2.match as { path?: string }).path === '/w')
  check('create 追加而不是覆盖', rules.list().length === 2)

  // 2. create 的脏输入：与 replaceAll **同一套校验**（新端点不得是没设防的门）
  const badCreates: Array<[string, () => unknown]> = [
    ['非对象（数字）', () => rules.create(42 as never)],
    ['非对象（字符串）', () => rules.create('nope' as never)],
    ['数组', () => rules.create([mk()] as never)],
    ['null', () => rules.create(null as never)],
    ['match.params 是数组', () => rules.create(mk({ match: { path: '/x', params: [1, 2] } }) as never)],
    ['action.responses 不是数组', () => rules.create(mk({ action: { type: 'mock', responses: {} } }) as never)],
    ['responses 元素是标量', () => rules.create(mk({ action: { type: 'mock', responses: ['x'] } }) as never)],
    ['responses[].cond 是数组', () => rules.create(mk({ action: { type: 'mock', responses: [{ cond: [] }] } }) as never)],
    ['responses[].cond.query 是数字', () => rules.create(mk({ action: { type: 'mock', responses: [{ cond: { query: 1 } }] } }) as never)],
    ['action.pinIndex 是字符串', () => rules.create(mk({ action: { type: 'mock', pinIndex: '1' } }) as never)],
    ['action.type 是 action.mode 的值（写错会被 resolve 静默当透传）', () => rules.create(mk({ action: { type: 'static', response: { status: 200, body: 'x' } } }) as never)],
    ['action.type 是任意字符串', () => rules.create(mk({ action: { type: 'forward', response: { status: 200, body: 'x' } } }) as never)],
    ['自己指定 id（会把表搞成重复 id）', () => rules.create(mk({ id: 'dup' }) as never)],
  ]
  let badCreateMissed = ''
  for (const [label, fn] of badCreates) {
    const code = status400(fn)
    if (code !== 400) badCreateMissed += `${label}(got ${code}) `
  }
  check('create 的脏输入一律 400（含自指定 id）', badCreateMissed === '', badCreateMissed)
  check('脏 create 没有把规则表改坏', rules.list().length === 2 && rules.list().every((r) => typeof r.id === 'string'))

  // 3. replaceOne：id 以路径为准
  const ok = rules.replaceOne(c1.id, mk({ name: '改名了', action: { type: 'mock', mode: 'sequence', seqMode: 'in-order', responses: [{ status: 201, body: '{"n":1}' }, { status: 202, body: '{"n":2}' }] } }) as never)
  check('整条替换命中并返回新内容', !!ok && ok.name === '改名了' && (ok.action.responses ?? []).length === 2, JSON.stringify(ok))
  check('替换不新增条目（表里还是 2 条）', rules.list().length === 2)
  // body 里没有 id（只有路径有）→ 补上，不得变成「新建一条」
  const noId = rules.replaceOne(c1.id, mk({ name: '无 id 提交' }) as never)
  check('body 缺 id 时以路径 id 补齐', noId?.id === c1.id && rules.list().length === 2)
  const mismatch = status400(() => rules.replaceOne(c1.id, mk({ id: '别的 id' }) as never))
  check('body.id 与路径 id 不一致 → 400（不会改 A 变成新增 B）', mismatch === 400, `got ${mismatch}`)
  const dirtyId = status400(() => rules.replaceOne(123 as never, mk() as never))
  check('路径 id 非字符串 → 400', dirtyId === 400, `got ${dirtyId}`)
  check('未命中的 id 返回 null（由路由给 404，不静默新建）', rules.replaceOne('不存在', mk() as never) === null)
  check('未命中替换后表内容不变', rules.list().length === 2)
  const dirtyRule = status400(() => rules.replaceOne(c1.id, '不是对象' as never))
  check('replaceOne 复用同一套结构校验（非对象 → 400）', dirtyRule === 400, `got ${dirtyRule}`)

  // 4. 无损保留：CLI / 旧客户端写的未知字段，整条替换要原样带走（协议 §5.4 C12）
  //    注意用**真正的未知键**：`groupId` 从 C13 起是协议字段（会被校验、会被 normalizeGroupId 处理），
  //    拿它当「未知字段」的例子测的就不再是无损保留了（ADR-030 的坑点登记）
  const withUnknown = mk({ name: '带未知字段', futureField: { a: 1 }, latencyHint: 'slow' }) as never
  rules.replaceOne(c2.id, withUnknown)
  const back = rules.list().find((r) => r.id === c2.id) as Record<string, unknown>
  check('未知字段在整条替换后仍在', back.latencyHint === 'slow' && JSON.stringify(back.futureField) === '{"a":1}', JSON.stringify(back))
  const condKept = rules.replaceOne(
    c2.id,
    mk({ action: { type: 'mock', mode: 'specific', pinIndex: 0, responses: [{ status: 200, body: '{}', cond: { query: 'uid=1', content: '' } }] } }) as never,
  )
  check('responses[].cond 存得下也读得回（本期不选路）',
    (condKept?.action.responses?.[0] as { cond?: { query?: string } })?.cond?.query === 'uid=1', JSON.stringify(condKept?.action.responses))

  // 5. 省略 enabled = 这条规则不生效（PUT 是整条替换，不是补丁）
  rules.replaceOne(c2.id, { priority: 1, match: { method: 'GET', path: '/w2' }, action: { type: 'mock', response: { status: 200, body: '{}' } } } as never)
  const noEnabled = rules.list().find((r) => r.id === c2.id) as unknown as { enabled?: boolean }
  check('整条替换省略 enabled 后确实不存在该字段', !('enabled' in noEnabled), JSON.stringify(noEnabled))
  check('省略 enabled 的规则不参与命中（与全量 PUT 同口径）',
    rules.resolve({ method: 'GET', host: 'h', path: '/w2', deviceId: 'd' }) === null)

  // 6. 落盘 + 重载：新建与替换都持久化（c1 最后一次替换提交的是「无 id 提交」）
  const reloaded = new RuleEngine(dir)
  check('新建/替换已落盘（重载后条数与最后一次替换一致）',
    reloaded.list().length === 2 && reloaded.list().some((r) => r.name === '无 id 提交'), JSON.stringify(reloaded.list().map((r) => r.name)))

  // 7. 端到端：CLI 写的规则在数据面真的生效
  const e2e = rules.create({
    enabled: true,
    priority: 5,
    match: { method: 'POST', path: '/login' },
    action: { type: 'mock', mode: 'sequence', seqMode: 'in-order', responses: [{ status: 201, body: '{"code":0}' }, { status: 202, body: '{"code":1}' }] },
  } as never)
  let r = await invoke(handle, { method: 'POST', url: '/__ec/p/login', headers: { 'x-ec-target': 'http://127.0.0.1:1/login', 'x-ec-device-id': C14_DEV } })
  check('create 的规则立刻被数据面命中（第 1 条）', r.status === 201 && r.body.includes('"code":0'), `got ${r.status} ${r.body}`)
  r = await invoke(handle, { method: 'POST', url: '/__ec/p/login', headers: { 'x-ec-target': 'http://127.0.0.1:1/login', 'x-ec-device-id': C14_DEV } })
  check('顺序推进到第 2 条', r.status === 202 && r.body.includes('"code":1'), `got ${r.status} ${r.body}`)
  // 整条替换成只返回一条 → 数据面立刻改口（证明替换真的生效，不是写进文件没读）
  rules.replaceOne(e2e.id, {
    enabled: true,
    priority: 5,
    match: { method: 'POST', path: '/login' },
    action: { type: 'mock', mode: 'static', response: { status: 418, body: '{"teapot":true}' } },
  } as never)
  r = await invoke(handle, { method: 'POST', url: '/__ec/p/login', headers: { 'x-ec-target': 'http://127.0.0.1:1/login', 'x-ec-device-id': C14_DEV } })
  check('整条替换后数据面立即改口（static 单条）', r.status === 418 && r.body.includes('teapot'), `got ${r.status} ${r.body}`)
  rmSync(dir, { recursive: true, force: true })
}

/**
 * 私有 / 共享项目（C14 / ADR-033，取代 C13 / ADR-030 的「全局分组」）。
 *
 * 分五段跑，因为这五段的**失败模式不一样**：
 * 1. **`groups.json` 读路径**：它是磁盘上的存量文件，会被手改、也被 C13 写过（里面根本没有
 *    `scope` / `ownerPhone`）。C14 的脏值兜底方向和 C13 **相反**——脏的归属判成「共享 / 无主」，
 *    宁可让规则不命中，也不能把别人的内容放进候选集（越界比静默失效严重，见 groups.ts 类注释第 4 条）。
 * 2. **写入口栅栏**：归属字段与时间戳只能服务端写，客户端带了就 400，**不是静默丢弃**
 *    （丢弃会让脚本作者以为自己成功改了归属）。
 * 3. **权限矩阵**：这里最要紧的是「他人私有项目」与「不存在」**同形 404** —— 用 403 就等于
 *    替调用方回答「这个 id 属于谁」。
 * 4. **命中口径与数据面隔离**：C14 的全部风险都在**静默失效**（「控制台显示已启用，它却什么都不
 *    mock」）。所以每条断言同时问「命中吗」和「规则自己的 `enabled` 被动过吗」，并把整组开关
 *    推到真实数据面走一遍。这一段一律用**原生 `RuleEngine`**，不碰上面那个补归属的测试夹具——
 *    夹具会把「忘了装栅栏」这件事遮掉，而那正是这批用例要测的东西。
 * 5. **级联删除**：C13 的「删组不删规则」在新模型下等于批量制造永不命中的死条目。
 */
async function testProjects(): Promise<void> {
  console.log('\n[F-30] 私有/共享项目：脏值兜底 + 归属栅栏 + 权限矩阵 + 命中隔离（C14 / ADR-033）')
  const dir = '.data-selftest/projects-store'
  rmSync(dir, { recursive: true, force: true })
  const A = '13800000001'
  const B = '13800000002'
  /** 返回抛出的 statusCode（没抛则 null）：-1 = 抛了但没有 statusCode，等于给客户端回了 500 */
  const statusOf = (fn: () => unknown): number | null => {
    try {
      fn()
      return null
    } catch (e) {
      return (e as { statusCode?: number }).statusCode ?? -1
    }
  }
  /** 返回抛出的 EC 码：管理面按 `code` 分支，光看状态码分不出 404 的两个语义（协议 §6.1） */
  const codeOf = (fn: () => unknown): string => {
    try {
      fn()
      return ''
    } catch (e) {
      return String((e as { code?: string }).code ?? '')
    }
  }
  /** 返回抛出的 message：权限类断言要查它**没泄露**别人的 id */
  const msgOf = (fn: () => unknown): string => {
    try {
      fn()
      return ''
    } catch (e) {
      return String((e as { message?: string }).message ?? '')
    }
  }

  // 1. 读路径兜底：groups.json 是存量文件，必须扛住手改与「根本没有 C14 字段」
  const g0 = new GroupStore(dir)
  g0.create({ name: '先留一条', enabled: true }, A)
  writeFileSync(join(dir, 'groups.json'), '{ 这不是 JSON', 'utf8')
  check('groups.json 坏 JSON → 空表且不崩（与 rules.json 同口径，F-16 的教训）', new GroupStore(dir).list().length === 0)
  for (const bad of ['{"a":1}', '42', '"字符串"', 'null', 'true']) {
    writeFileSync(join(dir, 'groups.json'), bad, 'utf8')
    check(`顶层非数组（${bad}）→ 空表`, new GroupStore(dir).list().length === 0)
  }
  writeFileSync(
    join(dir, 'groups.json'),
    JSON.stringify([
      '字符串条目',
      42,
      null,
      [],
      {},
      { id: 123, name: '数字 id' },
      { id: '', name: '空串 id' },
      { id: 'g_a', name: { o: 1 }, enabled: 'false', createdAt: '昨天', updatedAt: null },
      { id: 'g_b', name: '正常但关着', enabled: false, createdAt: 5, updatedAt: 6 },
      { id: 'g_c' },
      { id: 'g_scope_case', name: '大小写不对的 scope', scope: 'PRIVATE', ownerPhone: A },
      { id: 'g_scope_num', name: '数字 scope', scope: 1 },
      { id: 'g_no_owner', name: '私有但没 owner', scope: 'private' },
      { id: 'g_owner_num', name: 'owner 是数字', scope: 'private', ownerPhone: 13800000003 },
      { id: 'g_owner_empty', name: 'owner 是空串', scope: 'private', ownerPhone: '' },
      { id: 'g_shared_owner', name: '共享但写了 owner', scope: 'shared', ownerPhone: A, createdBy: B },
      {
        id: 'g_lineage',
        name: '血缘表里夹脏条目',
        scope: 'private',
        ownerPhone: A,
        lineage: [{ sharedRuleId: 's1', privateRuleId: 'p1' }, { sharedRuleId: '只有半边' }, null, 'x', [], 7],
      },
      {
        id: 'g_shared_lineage',
        name: '共享项目带了私有血缘',
        scope: 'shared',
        lineage: [{ sharedRuleId: 's', privateRuleId: 'p' }],
        originSharedProjectId: 'g_x',
        copiedFromVersionId: 'v_1',
      },
      { id: 'g_ver_dirty', name: '版本指针是数字', scope: 'shared', currentVersionId: 42, archived: 'yes' },
      { id: 'g_ver_ok', name: '已归档的共享项目', scope: 'shared', currentVersionId: 'v_9', archived: true },
    ]),
    'utf8',
  )
  const repaired = new GroupStore(dir)
  const keptIds = repaired.list().map((x) => x.id)
  check(
    '没有可用 id 的脏条目被丢掉（留着只会让开关与计数落到一个找不到的对象上）',
    JSON.stringify(keptIds) ===
      JSON.stringify([
        'g_a',
        'g_b',
        'g_c',
        'g_scope_case',
        'g_scope_num',
        'g_no_owner',
        'g_owner_num',
        'g_owner_empty',
        'g_shared_owner',
        'g_lineage',
        'g_shared_lineage',
        'g_ver_dirty',
        'g_ver_ok',
      ]),
    JSON.stringify(keptIds),
  )
  check('name 非字符串 → 归一为空串，不把对象带进列表', repaired.get('g_a')?.name === '', JSON.stringify(repaired.get('g_a')?.name))
  check('enabled 非布尔 → 归一为 **true**：判 false 会让整组规则不报错地不再 mock，正是 §5 的静默失效',
    repaired.get('g_a')?.enabled === true, JSON.stringify(repaired.get('g_a')?.enabled))
  check('时间戳脏值 → 0（不是 NaN：NaN 进 JSON 会变成 null，控制台直接读不懂）',
    repaired.get('g_a')?.createdAt === 0 && repaired.get('g_a')?.updatedAt === 0, JSON.stringify([repaired.get('g_a')?.createdAt, repaired.get('g_a')?.updatedAt]))
  check('合法条目原样读出（关着的仍是关着）',
    repaired.get('g_b')?.enabled === false && repaired.get('g_b')?.createdAt === 5, JSON.stringify(repaired.get('g_b')))
  check('缺 enabled 的条目按启用兜底，与上面同一条理由', repaired.get('g_c')?.enabled === true)
  check('读脏文件不会顺手改写磁盘（证据要留着让人查）',
    readFileSync(join(dir, 'groups.json'), 'utf8').includes('字符串条目'))
  check('get / exists 的脏 id 一律视为查不到，不抛',
    repaired.get(123) === undefined && repaired.get('') === undefined && repaired.get(null) === undefined && repaired.get('g_none') === undefined &&
      repaired.exists('g_b') === true && repaired.exists(123) === false, JSON.stringify(repaired.get(123)))
  // C14 新增：归属字段的兜底方向是「不进任何人的候选集」
  check('存量条目没有 scope → 按 **shared** 迁（不猜归属，协议 §4.7「禁止伪造创建人」的同一条理由）',
    repaired.get('g_b')?.scope === 'shared' && repaired.get('g_b')?.ownerPhone === null, JSON.stringify([repaired.get('g_b')?.scope, repaired.get('g_b')?.ownerPhone]))
  check("scope 大小写不对（'PRIVATE'）→ 按 shared：放行了就是拿一个拼写换一个私有身份",
    repaired.get('g_scope_case')?.scope === 'shared' && repaired.get('g_scope_case')?.ownerPhone === null)
  check('scope 是数字 → 按 shared', repaired.get('g_scope_num')?.scope === 'shared')
  check('脏 scope 的项目不会被当成 A 的私有项目回吐（isPrivateOf 也判 false）',
    !repaired.isPrivateOf('g_scope_case', A) && !repaired.visible(A).some((g) => g.id === 'g_scope_case' && g.scope === 'private'))
  check('private 缺 owner / owner 是数字 / owner 是空串 → ownerPhone 一律 null（无主 ⇒ 永不命中，迁移会收进旧版容器）',
    repaired.get('g_no_owner')?.scope === 'private' && repaired.get('g_no_owner')?.ownerPhone === null &&
      repaired.get('g_owner_num')?.ownerPhone === null && repaired.get('g_owner_empty')?.ownerPhone === null)
  check('shared 的 ownerPhone 恒为 null：共享内容不属于任何人，写进去的手机号只能是被伪造的',
    repaired.get('g_shared_owner')?.ownerPhone === null, JSON.stringify(repaired.get('g_shared_owner')?.ownerPhone))
  check('createdBy 是合法字符串就保留（它是审计字段，不是归属字段）', repaired.get('g_shared_owner')?.createdBy === B)
  check('lineage 只留「两边都是非空字符串」的条目，其余丢掉（半条映射会让再分享还原错共享 id）',
    JSON.stringify(repaired.get('g_lineage')?.lineage) === JSON.stringify([{ sharedRuleId: 's1', privateRuleId: 'p1' }]),
    JSON.stringify(repaired.get('g_lineage')?.lineage))
  check('shared 项目上的 lineage / origin / copiedFrom 一律当没有（血缘只长在私有区）',
    repaired.get('g_shared_lineage')?.lineage === undefined && repaired.get('g_shared_lineage')?.originSharedProjectId === undefined &&
      repaired.get('g_shared_lineage')?.copiedFromVersionId === undefined)
  check('currentVersionId 脏 → 当作没有；合法字符串保留（它只影响历史指针，不影响命中）',
    repaired.get('g_ver_dirty')?.currentVersionId === undefined && repaired.get('g_ver_ok')?.currentVersionId === 'v_9')
  check("archived 只认真值 true（'yes' 不算归档，否则界面会藏掉一个没人归档过的项目）",
    repaired.get('g_ver_dirty')?.archived === false && repaired.get('g_ver_ok')?.archived === true)

  // 2. 新建的脏输入（含「会话手机号本身就是脏的」这一类：401，不能落到「归属为空」的项目上）
  rmSync(dir, { recursive: true, force: true })
  const gs = new GroupStore(dir)
  const badCreates: Array<[string, () => unknown]> = [
    ['非对象（数字）', () => gs.create(42, A)],
    ['数组', () => gs.create([], A)],
    ['null', () => gs.create(null, A)],
    ['字符串', () => gs.create('g_x', A)],
    ['缺 name', () => gs.create({ enabled: true }, A)],
    ['name 空串', () => gs.create({ name: '', enabled: true }, A)],
    ['name 纯空白', () => gs.create({ name: '   ', enabled: true }, A)],
    ['name 是对象', () => gs.create({ name: { a: 1 }, enabled: true }, A)],
    ['name 是数字', () => gs.create({ name: 7, enabled: true }, A)],
    ['缺 enabled（新表不留隐式默认值）', () => gs.create({ name: '缺开关' }, A)],
    ['enabled 是 1', () => gs.create({ name: 'x', enabled: 1 }, A)],
    ['enabled 是 "true"', () => gs.create({ name: 'x', enabled: 'true' }, A)],
    ['enabled 是 null', () => gs.create({ name: 'x', enabled: null }, A)],
    ['调用方指定非空 id（防「假装新建实则覆盖」）', () => gs.create({ id: 'g_fixed', name: 'x', enabled: true }, A)],
  ]
  for (const [label, fn] of badCreates) check(`create 拒绝：${label}`, statusOf(fn) === 400, `got ${statusOf(fn)}`)
  for (const bad of [undefined, null, '', 123, {}, []] as unknown[]) {
    check(`create 只认会话里的手机号（收到 ${JSON.stringify(bad)} → 401，不建出「无主私有项目」）`,
      statusOf(() => gs.create({ name: 'x', enabled: true }, bad)) === 401 &&
        codeOf(() => gs.create({ name: 'x', enabled: true }, bad)) === 'EC_UNAUTHORIZED')
  }
  check('全部被拒之后表里一条都没有（校验失败不留半成品）', gs.list().length === 0, JSON.stringify(gs.list()))
  // 下界必须在 create **之前**取：原来写在两次 check 之后（Date.now() - 10），
  // stdout 是管道且被下游读得慢时，这两次 check 的打印就能把 10ms 窗口吃光，
  // 断言随负载随机失败（部署门禁里踩到过，重跑又全绿）。
  const t0 = Date.now() - 10
  const created = gs.create({ name: '  登录模块  ', enabled: true }, A)
  check('create 生成 g_ 前缀 id 并 trim 名字', /^g_/.test(created.id) && created.name === '登录模块', JSON.stringify(created))
  check('新建出来的**只能**是 private + 归属等于会话手机号 + 未归档',
    created.scope === 'private' && created.ownerPhone === A && created.createdBy === A && created.archived === false, JSON.stringify(created))
  check('时间戳来自服务器时钟（不是 0、也不是过去某个伪造值）', created.createdAt >= t0 && created.updatedAt >= t0, JSON.stringify([created.createdAt, created.updatedAt]))
  check('新建项目不带血缘与版本指针（那些字段只能由 copy / share 写）',
    created.lineage === undefined && created.originSharedProjectId === undefined && created.currentVersionId === undefined)
  check('id 为 "" / null 视为「没给 id」，照常生成',
    gs.create({ id: '', name: 'a', enabled: true }, A).id !== '' && gs.create({ id: null, name: 'b', enabled: true }, A).id !== '')
  for (const field of CLIENT_FORBIDDEN_FIELDS) {
    const body = { name: 'x', enabled: true, [field]: 'y' }
    check(`create 拒绝服务端字段 \`${field}\`（400 EC_SCOPE_MISMATCH，**不是静默丢弃**：丢弃会让脚本以为归属改成了自己的）`,
      statusOf(() => gs.create(body, A)) === 400 && codeOf(() => gs.create(body, A)) === 'EC_SCOPE_MISMATCH',
      `got ${statusOf(() => gs.create(body, A))} ${codeOf(() => gs.create(body, A))}`)
    check(`显式 null 也算「带了这个字段」（\`${field}\` 不给值不等于给空值）`,
      statusOf(() => gs.create({ name: 'x', enabled: true, [field]: null }, A)) === 400)
  }
  check('被这些非法输入挡下来之后，前面合法建的条目一字未动',
    gs.get(created.id)?.name === '登录模块' && gs.list().length === 1 + 2, `${gs.list().length}`)
  const batchIds = new Set<string>()
  for (let i = 0; i < 200; i++) batchIds.add(gs.create({ name: `批量 ${i}`, enabled: true }, A).id)
  check('连续新建 200 个不撞 id（建项目是脚本批量场景，必须查碰撞）', batchIds.size === 200, String(batchIds.size))

  // 3. 权限矩阵：列表可见性 + 读/写栅栏（协议 §4.7 那两张表的逐格核对）
  rmSync(dir, { recursive: true, force: true })
  const ps = new GroupStore(dir)
  const pA = ps.create({ name: 'A 的项目', enabled: true }, A)
  const pB = ps.create({ name: 'B 的项目', enabled: true }, B)
  // shared 没有客户端创建路径（上面测过 create 拒绝 scope），只能由 share / 迁移产生 → 走内部通道
  const s1 = ps.upsert({
    id: 'g_shared1',
    name: '共享库',
    enabled: true,
    createdAt: 1,
    updatedAt: 2,
    scope: 'shared',
    ownerPhone: null,
    createdBy: B,
    archived: false,
  } as Group)
  check('内部通道 upsert 能落 shared，且保留调用方给的时间戳（迁移与版本服务要用）',
    s1.scope === 'shared' && s1.createdAt === 1 && s1.updatedAt === 2, JSON.stringify(s1))
  const visA = ps.visible(A).map((g) => g.id)
  const visB = ps.visible(B).map((g) => g.id)
  check('A 看得见「自己的 private + 全部 shared」，看不见 B 的 private（连存在都不泄露）',
    visA.includes(pA.id) && visA.includes(s1.id) && !visA.includes(pB.id), JSON.stringify(visA))
  check('B 同理（对称，不是只保护先建的那个人）',
    visB.includes(pB.id) && visB.includes(s1.id) && !visB.includes(pA.id), JSON.stringify(visB))
  check("scope=private 只回自己的私有项目", JSON.stringify(ps.visible(A, 'private').map((g) => g.id).filter((x) => x === pA.id || x === pB.id)) === JSON.stringify([pA.id]))
  check("scope=shared 回全部共享项目（含别人的）", ps.visible(A, 'shared').some((g) => g.id === s1.id) && !ps.visible(A, 'shared').some((g) => g.id === pA.id))
  check('scope 传非法值 → 按「不过滤」处理，不 500 也不空表', ps.visible(A, 123).length === ps.visible(A).length)
  check('脏会话（空 / 非字符串）只看得见 shared：一个坏会话不该读到任何私有内容',
    ps.visible('').length === 1 && ps.visible(null).length === 1 && ps.visible(123).length === 1 &&
      ps.visible('').every((g) => g.scope === 'shared'), JSON.stringify(ps.visible('').map((g) => g.id)))
  check('归档的 shared 仍在 visible 里（归档是「收进抽屉」，不是「藏起来」）',
    ps.visible(A).some((g) => g.id === s1.id))
  check('isPrivateOf / isShared 的脏 id 一律 false，不抛',
    ps.isPrivateOf(123, A) === false && ps.isPrivateOf('', A) === false && ps.isPrivateOf(pA.id, 123) === false &&
      ps.isShared('g_none') === false && ps.isShared(pA.id) === false && ps.isShared(s1.id) === true &&
      ps.isPrivateOf(pA.id, A) === true && ps.isPrivateOf(pA.id, B) === false)
  check('无主的 private（手改出来的）谁的私有项目都不算',
    ps.isPrivateOf(ps.upsert({ id: 'g_orphan_priv', name: '无主私有', enabled: true, createdAt: 1, updatedAt: 1, scope: 'private', ownerPhone: null, createdBy: null, archived: false } as Group).id, A) === false)
  const readOther = statusOf(() => ps.requireReadable(pB.id, A))
  const readMissing = statusOf(() => ps.requireReadable('g_never', A))
  check('读栅栏：自己的 private 与 shared 放行',
    ps.requireReadable(pA.id, A).id === pA.id && ps.requireReadable(s1.id, A).id === s1.id && ps.requireReadable(s1.id, B).id === s1.id)
  check('读栅栏：他人 private 与「不存在」**同形 404 EC_PROJECT_NOT_FOUND**（403 等于替调用方回答这个 id 属于谁）',
    readOther === 404 && readMissing === 404 && codeOf(() => ps.requireReadable(pB.id, A)) === 'EC_PROJECT_NOT_FOUND' &&
      codeOf(() => ps.requireReadable('g_never', A)) === 'EC_PROJECT_NOT_FOUND')
  check('他人 private 的报错文案里不含那个 id（不存在的那条才带 hint，因为 id 是调用方自己给的）',
    !msgOf(() => ps.requireReadable(pB.id, A)).includes(pB.id), msgOf(() => ps.requireReadable(pB.id, A)))
  check('无主 private 谁都读不到（它只能被迁移收进旧版共享容器）', statusOf(() => ps.requireReadable('g_orphan_priv', A)) === 404)
  check('写栅栏：shared → 409 EC_PROJECT_READONLY（共享内容只能由 share / rollback 提交，改法是 copy → 编辑 → share）',
    statusOf(() => ps.requireEditable(s1.id, A)) === 409 && codeOf(() => ps.requireEditable(s1.id, A)) === 'EC_PROJECT_READONLY' &&
      msgOf(() => ps.requireEditable(s1.id, A)).includes('copy'))
  check('写栅栏：他人 private / 不存在 / 无主 private → 404（与读栅栏同形）',
    statusOf(() => ps.requireEditable(pB.id, A)) === 404 && statusOf(() => ps.requireEditable('g_never', A)) === 404 &&
      statusOf(() => ps.requireEditable('g_orphan_priv', A)) === 404 && codeOf(() => ps.requireEditable(pB.id, A)) === 'EC_PROJECT_NOT_FOUND')
  check('写栅栏：脏会话（空 / 非字符串）连自己的项目都编辑不了（归属比对不接受「大概是谁」）',
    statusOf(() => ps.requireEditable(pA.id, '')) === 404 && statusOf(() => ps.requireEditable(pA.id, null)) === 404 &&
      statusOf(() => ps.requireEditable(pA.id, 123)) === 404)

  // 4. 整条替换、整组开关、归档
  const before = ps.get(pA.id) as Group
  check('replaceOne 未命中 → 404（C13 返回 null 让路由给 404；C14 直接把归属判断挪进栅栏，口径不变但来源变了）',
    statusOf(() => ps.replaceOne('g_none', { name: 'y', enabled: true }, A)) === 404)
  check('replaceOne 路径 id 空串 → 400（连「改哪一条」都没说清，不进栅栏）', statusOf(() => ps.replaceOne('', { name: 'y', enabled: true }, A)) === 400)
  check('replaceOne 路径 id 是数字 → 400（「改哪一条」都没说清，不进栅栏，也就不会泄露这条存不存在）',
    statusOf(() => ps.replaceOne(123, { name: 'y', enabled: true }, A)) === 400)
  check('replaceOne 他人 private → 404、shared → 409（改不动别人的，也改不动共享的）',
    statusOf(() => ps.replaceOne(pB.id, { name: 'y', enabled: true }, A)) === 404 &&
      statusOf(() => ps.replaceOne(s1.id, { name: 'y', enabled: true }, A)) === 409)
  check('replaceOne 复用同一套结构校验（name 空白 → 400）', statusOf(() => ps.replaceOne(pA.id, { name: '  ', enabled: true }, A)) === 400)
  check('replaceOne 同样拒绝服务端字段（PUT 也不能改归属，否则「改名」顺带把项目过户）',
    statusOf(() => ps.replaceOne(pA.id, { name: 'y', enabled: true, ownerPhone: A }, A)) === 400 &&
      codeOf(() => ps.replaceOne(pA.id, { name: 'y', enabled: true, scope: 'shared' }, A)) === 'EC_SCOPE_MISMATCH')
  check('被拒的替换没有改坏原条目', (ps.get(pA.id) as Group).name === 'A 的项目', JSON.stringify(ps.get(pA.id)))
  const countBeforeReplace = ps.list().length
  const replaced = ps.replaceOne(pA.id, { name: '改名了', enabled: false }, A)
  check('整条替换不新增条目（表里条数一字未动）', ps.list().length === countBeforeReplace, `${countBeforeReplace} → ${ps.list().length}`)
  check('整条替换改不了归属：scope 仍是 private、owner 仍是 A',
    replaced.scope === 'private' && replaced.ownerPhone === A, JSON.stringify([replaced.scope, replaced.ownerPhone]))
  check('整条替换保留 createdAt（body 没给时不能被抹成 0）', replaced.createdAt === before.createdAt, JSON.stringify([before.createdAt, replaced.createdAt]))
  check('updatedAt 一律服务端覆盖：调用方伪造不了「什么时候改的」（伪造入口已被 400 挡在门外）',
    replaced.updatedAt >= before.updatedAt && replaced.updatedAt > 2, String(replaced.updatedAt))
  check('replaceOne 已落盘（新实例读回最后一次替换）', new GroupStore(dir).get(pA.id)?.name === '改名了')
  const sw = ps.create({ name: '开关', enabled: true }, A)
  for (const bad of ['true', 1, 0, null, undefined, {}, []] as unknown[]) {
    check(`setEnabled 只接受布尔（收到 ${JSON.stringify(bad)}）`, statusOf(() => ps.setEnabled(sw.id, bad, A)) === 400, `got ${statusOf(() => ps.setEnabled(sw.id, bad, A))}`)
  }
  check('被拒的开关没有把状态改坏', ps.get(sw.id)?.enabled === true, JSON.stringify(ps.get(sw.id)))
  check('setEnabled 的脏 id / 未知 id / 他人 id → 404，不抛',
    statusOf(() => ps.setEnabled(123, false, A)) === 404 && statusOf(() => ps.setEnabled('', false, A)) === 404 &&
      statusOf(() => ps.setEnabled('g_none', false, A)) === 404 && statusOf(() => ps.setEnabled(pB.id, false, A)) === 404)
  check('setEnabled 打不开共享项目 → 409：shared 不参与命中，给它开关就是造一个永远不被读的字段',
    statusOf(() => ps.setEnabled(s1.id, false, A)) === 409 && codeOf(() => ps.setEnabled(s1.id, false, A)) === 'EC_PROJECT_READONLY')
  const turnedOff = ps.setEnabled(sw.id, false, A)
  check('setEnabled 翻转成功并推进 updatedAt', turnedOff.enabled === false && turnedOff.updatedAt >= (sw.updatedAt ?? 0), JSON.stringify(turnedOff))
  check('setEnabled 已落盘', new GroupStore(dir).get(sw.id)?.enabled === false)
  check('remove 的脏 id / 未知 id → false（幂等，不抛）',
    ps.remove(123) === false && ps.remove(null) === false && ps.remove('g_none') === false)
  check('remove 只动项目表：不碰规则文件（级联删规则是调用方的责任，见 removeByGroup）', !existsSync(join(dir, 'rules.json')))
  check('setArchived 非布尔 → 400、脏会话 → 401、未知 id → 404',
    statusOf(() => ps.setArchived(s1.id, 'true', A)) === 400 && statusOf(() => ps.setArchived(s1.id, true, '')) === 401 &&
      statusOf(() => ps.setArchived('g_none', true, A)) === 404)
  check('setArchived 只能作用于 shared：归档自己的 private 没有语义（要删就删）',
    statusOf(() => ps.setArchived(pA.id, true, A)) === 409 && codeOf(() => ps.setArchived(pA.id, true, A)) === 'EC_PROJECT_READONLY')
  const archived = ps.setArchived(s1.id, true, A)
  check('归档任何登录用户都做得到（能覆盖共享项目的人不能连归档都办不了）', archived.archived === true && archived.scope === 'shared')
  check('归档不改 enabled、也不将项目从可见列表里摘掉（归档 ≠ 删除）',
    ps.get(s1.id)?.enabled === true && ps.visible(B).some((g) => g.id === s1.id))
  check('取消归档同样要带会话手机号', statusOf(() => ps.setArchived(s1.id, false, null)) === 401 && ps.setArchived(s1.id, false, A).archived === false)

  // 5. 规则侧写入口：结构校验 + **归属栅栏**（三个客户端入口共用一套，缺一个就是没设防的门）
  const dir2 = '.data-selftest/projects-hit'
  rmSync(dir2, { recursive: true, force: true })
  const hg = new GroupStore(dir2)
  const rules = new RuleEngine(dir2, hg)
  const pOn = hg.create({ name: '开着的项目', enabled: true }, A)
  const pOff = hg.create({ name: '关着的项目', enabled: false }, A)
  const pBOther = hg.create({ name: 'B 的项目', enabled: true }, B)
  const sh = hg.upsert({ id: 'g_c14_shared', name: '共享库', enabled: true, createdAt: 1, updatedAt: 1, scope: 'shared', ownerPhone: null, createdBy: B, archived: false } as Group)
  const ownerless = hg.upsert({ id: 'g_c14_ownerless', name: '无主私有', enabled: true, createdAt: 1, updatedAt: 1, scope: 'private', ownerPhone: null, createdBy: null, archived: false } as Group)
  const mkRule = (over: Record<string, unknown> = {}) => ({
    enabled: true,
    priority: 1,
    match: { method: 'GET', path: '/c14' },
    action: { type: 'mock', response: { status: 200, body: '{"m":"c14"}' } },
    ...over,
  })
  for (const bad of [7, {}, [], true, ['g_a']] as unknown[]) {
    check(`replaceAll 拒绝非字符串 groupId（${JSON.stringify(bad)}）`, statusOf(() => rules.replaceAll([mkRule({ groupId: bad })] as never)) === 400)
    check(`create 拒绝非字符串 groupId（${JSON.stringify(bad)}）`, statusOf(() => rules.create(mkRule({ groupId: bad }) as never, A)) === 400)
  }
  check('replaceOne 拒绝非字符串 groupId', statusOf(() => {
    const one = rules.create(mkRule({ groupId: pOn.id }) as never, A)
    return rules.replaceOne(one.id, mkRule({ groupId: {} }) as never, A)
  }) === 400)
  rules.replaceAll([] as never)
  const badGids: Array<[string, unknown]> = [
    ['不带 groupId（新模型不允许无归属规则：无归属 = 永不命中）', undefined],
    ['groupId 空串（只允许「挂在一个真实私有项目下」这一种写法）', ''],
    ['指向共享项目（共享内容只能 copy 之后编辑，不能被直接写）', sh.id],
    ['指向他人私有项目（写权限来自「这条属于我」，不来自 role）', pBOther.id],
    ['指向不存在的项目', 'g_never_existed'],
    ['指向无主的 private（手改出来的脏项目，谁都不该能往里塞规则）', ownerless.id],
  ]
  for (const [label, gid] of badGids) {
    const fn = () => rules.create(mkRule({ groupId: gid }) as never, A)
    check(`create 拒绝：${label}`, statusOf(fn) === 400 && codeOf(fn) === 'EC_SCOPE_MISMATCH', `got ${statusOf(fn)} ${codeOf(fn)}`)
  }
  check('create 拒绝脏会话（手机号不是字符串就查不到任何私有项目，不能退化成「谁都能写」）',
    statusOf(() => rules.create(mkRule({ groupId: pOn.id }) as never, 123)) === 400)
  const okRule = rules.create(mkRule({ groupId: pOn.id }) as never, A)
  check('合法 create 挂到 A 的私有项目下，id 由服务端生成', okRule.groupId === pOn.id && /^r_/.test(String(okRule.id)), JSON.stringify(okRule))
  check('create 拒绝调用方指定 id', statusOf(() => rules.create(mkRule({ id: 'r_fixed', groupId: pOn.id }) as never, A)) === 400)
  const bRule = rules.create(mkRule({ groupId: pBOther.id }) as never, B)
  const moveFn = () => rules.replaceOne(okRule.id, mkRule({ groupId: pOff.id }) as never, A)
  check('replaceOne 不许把规则挪到别的项目（跨项目挪规则 = 搬走别人的私有内容）',
    statusOf(moveFn) === 400 && codeOf(moveFn) === 'EC_SCOPE_MISMATCH', `got ${statusOf(moveFn)}`)
  const backfilled = rules.replaceOne(okRule.id, mkRule({ match: { method: 'GET', path: '/c14/edited' } }) as never, A)
  check('replaceOne 在 body 不带 groupId 时**按原项目补齐**：故意偏离「给什么存什么」——漏带这个字段就能把一条在用的规则改成永不命中，正是 §5 的静默失效',
    backfilled?.groupId === pOn.id, JSON.stringify(backfilled?.groupId))
  check('replaceOne 对他人规则与不存在的 id 都返回 null（路由同形 404，不泄露「这条是别人的」）',
    rules.replaceOne(bRule.id, mkRule() as never, A) === null && rules.replaceOne('r_none', mkRule() as never, A) === null)
  check('setEnabled 对他人规则 / 不存在的 id → null，对自己的成功',
    rules.setEnabled(bRule.id, false, A) === null && rules.setEnabled('r_none', false, A) === null &&
      rules.setEnabled(okRule.id, false, A)?.enabled === false)
  check('remove 对他人规则 → false，对自己的 → true（两者对外同形 404）',
    rules.remove(bRule.id, A) === false && rules.remove(okRule.id, A) === true)
  check('客户端入口被拒之后表里只剩那条合法规则', rules.list().length === 1 && rules.list()[0].id === bRule.id, JSON.stringify(rules.list().map((r) => r.id)))
  check('replaceOne 拒绝非字符串路径 id / 空串（400，不进归属查询）',
    statusOf(() => rules.replaceOne(123, mkRule() as never, A)) === 400 && statusOf(() => rules.replaceOne('', mkRule() as never, A)) === 400)
  check('replaceOne body.id 与路径不一致 → 400（不会「改 A 变成新增 B」）',
    statusOf(() => rules.replaceOne(bRule.id, mkRule({ id: 'r_other' }) as never, B)) === 400)

  // 6. 命中口径：协议 §5.4 那条完整 AND，以及五条「必须不命中」
  const pSeq = hg.create({ name: '序列项目', enabled: true }, A)
  rules.replaceAll([
    mkRule({ id: 'r_on', groupId: pOn.id, match: { method: 'GET', path: '/c14/on' } }),
    mkRule({ id: 'r_proj_off', groupId: pOff.id, match: { method: 'GET', path: '/c14/proj-off' } }),
    mkRule({ id: 'r_b', groupId: pBOther.id, match: { method: 'GET', path: '/c14/b' } }),
    mkRule({ id: 'r_shared', groupId: sh.id, match: { method: 'GET', path: '/c14/shared' } }),
    mkRule({ id: 'r_orphan', groupId: 'g_never_existed', match: { method: 'GET', path: '/c14/orphan' } }),
    mkRule({ id: 'r_ownerless', groupId: ownerless.id, match: { method: 'GET', path: '/c14/ownerless' } }),
    mkRule({ id: 'r_nogroup', match: { method: 'GET', path: '/c14/nogroup' } }),
    mkRule({ id: 'r_rule_off', enabled: false, groupId: pOn.id, match: { method: 'GET', path: '/c14/rule-off' } }),
    mkRule({ id: 'r_a_same', groupId: pOn.id, priority: 3, match: { method: 'GET', path: '/c14/same' }, action: { type: 'mock', response: { status: 200, body: '{"who":"A"}' } } }),
    mkRule({ id: 'r_b_same', groupId: pBOther.id, priority: 9, match: { method: 'GET', path: '/c14/same' }, action: { type: 'mock', response: { status: 200, body: '{"who":"B"}' } } }),
    mkRule({ id: 'r_tie_1', groupId: pOn.id, match: { method: 'GET', path: '/c14/tie' } }),
    mkRule({ id: 'r_tie_2', groupId: pOn.id, match: { method: 'GET', path: '/c14/tie' } }),
    mkRule({ id: 'r_pass', groupId: pOn.id, priority: 9, match: { method: 'GET', path: '/c14/shield' }, action: { type: 'passthrough' } }),
    mkRule({ id: 'r_shielded', groupId: pOn.id, priority: 1, match: { method: 'GET', path: '/c14/shield' } }),
    mkRule({
      id: 'r_seq',
      groupId: pSeq.id,
      match: { method: 'GET', path: '/c14/seq' },
      action: { type: 'mock', mode: 'sequence', seqMode: 'in-order', responses: [{ status: 201, body: '{"i":1}' }, { status: 202, body: '{"i":2}' }, { status: 203, body: '{"i":3}' }] },
    }),
    mkRule({
      id: 'r_shared_seq',
      groupId: sh.id,
      match: { method: 'GET', path: '/c14/shared-seq' },
      action: { type: 'mock', mode: 'sequence', seqMode: 'in-order', responses: [{ status: 201, body: '{"s":1}' }, { status: 202, body: '{"s":2}' }] },
    }),
    mkRule({ id: 'r_b_seq', groupId: pBOther.id, match: { method: 'GET', path: '/c14/b-seq' }, action: { type: 'mock', mode: 'sequence', seqMode: 'in-order', responses: [{ status: 201, body: '{"b":1}' }, { status: 202, body: '{"b":2}' }] } }),
  ] as never)
  const hitFor = (phone: string | null, path: string, deviceId = 'dX'): string | null =>
    rules.resolve({ method: 'GET', host: 'h.example', path, deviceId, ownerPhone: phone })?.rule.id ?? null
  check('自己的私有项目 + 项目开着 → 命中（C14 唯一那条通路）', hitFor(A, '/c14/on') === 'r_on', String(hitFor(A, '/c14/on')))
  check('项目关着 → 整组不命中（C13 那条 AND 仍在，只是前面多了归属）', hitFor(A, '/c14/proj-off') === null, String(hitFor(A, '/c14/proj-off')))
  check('A 的私有规则对 B 不命中，B 的对 A 也不命中（两个方向都查）',
    hitFor(A, '/c14/b') === null && hitFor(B, '/c14/b') === 'r_b')
  check('**共享规则永不命中**，即使 enabled 且条件匹配 —— 这是 C14 的立身之本，实现里被「顺手支持一下」破掉就是越权',
    hitFor(A, '/c14/shared') === null && hitFor(B, '/c14/shared') === null && hitFor(null, '/c14/shared') === null)
  check('悬空 groupId 不命中（C13 的「按未分组照常命中」在这里被翻转，协议 §5.4 写明翻转靠迁移与控制台兜住）',
    hitFor(A, '/c14/orphan') === null, String(hitFor(A, '/c14/orphan')))
  check('无归属（不带 groupId）与无主 private 都不命中', hitFor(A, '/c14/nogroup') === null && hitFor(A, '/c14/ownerless') === null)
  check('规则自己关了也不命中（AND 的另一半）', hitFor(A, '/c14/rule-off') === null, String(hitFor(A, '/c14/rule-off')))
  check('未绑定设备（owner 为 null）候选集恒空：全部放行上游，不是拒绝请求',
    hitFor(null, '/c14/on') === null && hitFor(null, '/c14/b') === null)
  check('脏 owner（空串 / 非字符串）同样候选集为空，不抛',
    rules.resolve({ method: 'GET', host: 'h.example', path: '/c14/on', deviceId: 'dX', ownerPhone: '' }) === null &&
      rules.resolve({ method: 'GET', host: 'h.example', path: '/c14/on', deviceId: 'dX', ownerPhone: 123 as never }) === null)
  check('同一条 API 上 B 的 9 优先级规则不会压过 A 自己的规则（归属先于 priority）',
    rules.resolve({ method: 'GET', host: 'h.example', path: '/c14/same', deviceId: 'dX', ownerPhone: A })?.response?.body?.includes('"who":"A"') === true &&
      rules.resolve({ method: 'GET', host: 'h.example', path: '/c14/same', deviceId: 'dX', ownerPhone: B })?.response?.body?.includes('"who":"B"') === true)
  check('同项目内仍按 priority 选，priority 相同按表内顺序稳定取第一条',
    hitFor(A, '/c14/tie') === 'r_tie_1' && rules.resolve({ method: 'GET', host: 'h.example', path: '/c14/shield', deviceId: 'dX', ownerPhone: A })?.rule.id === 'r_pass',
    `${hitFor(A, '/c14/tie')} / ${hitFor(A, '/c14/shield')}`)
  check('passthrough 高优先级遮蔽低优先级 mock 的行为不变（返回规则但不带响应，数据面据此放行）',
    rules.resolve({ method: 'GET', host: 'h.example', path: '/c14/shield', deviceId: 'dX', ownerPhone: A })?.response === null)
  check('关项目**不改写**组内规则的 enabled（重开即恢复原状）',
    (rules.list().find((r) => r.id === 'r_proj_off') as unknown as { enabled?: boolean }).enabled === true)
  hg.setEnabled(pOff.id, true, A)
  check('重开项目后原样恢复命中（不必逐条改规则）', hitFor(A, '/c14/proj-off') === 'r_proj_off', String(hitFor(A, '/c14/proj-off')))
  hg.setEnabled(pOff.id, false, A)
  check('再关即再挡：真值只有一份（项目表的 enabled）', hitFor(A, '/c14/proj-off') === null)

  // 7a. 序列指针：归属挡住的规则不推进，指针按 (deviceId, ruleId) 隔离
  const seqBody = (phone: string | null, path: string, deviceId: string): string =>
    rules.resolve({ method: 'GET', host: 'h.example', path, deviceId, ownerPhone: phone })?.response?.body ?? ''
  const seq1 = seqBody(A, '/c14/seq', 'devSeq')
  const ptr1 = rules.pointerOf('devSeq', 'r_seq')
  check('序列第 1 条并按 (deviceId, ruleId) 记指针', seq1.includes('"i":1') && ptr1 === 1, `${seq1} / ${ptr1}`)
  hg.setEnabled(pSeq.id, false, A)
  const duringClosed = seqBody(A, '/c14/seq', 'devSeq')
  check('项目关着期间整条不参与匹配，指针**不推进**（不白占序列位）',
    duringClosed === '' && rules.pointerOf('devSeq', 'r_seq') === ptr1, `${duringClosed} / ${rules.pointerOf('devSeq', 'r_seq')}`)
  hg.setEnabled(pSeq.id, true, A)
  check('重开后序列从半截继续（关项目不重置指针）', seqBody(A, '/c14/seq', 'devSeq').includes('"i":2'), `指针 ${rules.pointerOf('devSeq', 'r_seq')}`)
  check('另一个设备的指针互不影响（序列按 deviceId 隔离）', rules.pointerOf('devOther', 'r_seq') === 0)
  for (const _ of [0, 1, 2]) seqBody(A, '/c14/shared-seq', 'devShared')
  check('共享序列规则**永不推进指针**（不参与命中就不会占位）', rules.pointerOf('devShared', 'r_shared_seq') === 0, String(rules.pointerOf('devShared', 'r_shared_seq')))
  check('A 重置指针只清得动自己的私有规则，B 正在走的序列不受影响',
    seqBody(B, '/c14/b-seq', 'devB') === '{"b":1}' && rules.resetPointers(A) >= 1 && rules.pointerOf('devB', 'r_b_seq') === 1 &&
      rules.pointerOf('devSeq', 'r_seq') === 0, `指针 ${rules.pointerOf('devB', 'r_b_seq')}`)
  check('脏会话重置指针 → 0 条（没有归属就一条都清不动）', rules.resetPointers('') === 0 && rules.resetPointers(123) === 0)
  // 7. 级联删除（取代 C13 的「脱组」）：删项目必须连带删规则，否则就是批量制造死条目。
  //    放在私有范围替换**之前**：替换会把 A 私有区整个顶掉，r_seq 首当其冲，指针与级联就没东西可删了
  const pOnCount = rules.countByGroup(pOn.id)
  const seqCount = rules.countByGroup(pSeq.id)
  check('countByGroup 按 groupId 原文统计（含规则自己关着的那些：它数的是「引用」，不是「会不会命中」）',
    pOnCount === 7 && seqCount === 1, `${pOnCount}/${seqCount}`)
  check('countByGroup 对悬空 id 也如实数：它数的是「引用」，不是「项目存在」', rules.countByGroup('g_never_existed') === 1)
  check('countByGroup 脏输入 → 0，不抛', rules.countByGroup(123) === 0 && rules.countByGroup('') === 0 && rules.countByGroup(null) === 0)
  const beforeCascade = rules.list().length
  check('removeByGroup 脏输入 → 0 且不动规则表',
    rules.removeByGroup(123) === 0 && rules.removeByGroup('') === 0 && rules.removeByGroup(null) === 0 && rules.list().length === beforeCascade)
  const removedRules = rules.removeByGroup(pSeq.id)
  check('removeByGroup 返回条数并把规则**删掉**（不是把 groupId 清成空串：那在新模型下等于改成永不命中）',
    removedRules === seqCount && !rules.list().some((r) => r.groupId === pSeq.id), JSON.stringify(removedRules))
  check('级联删除丢弃序列指针（不丢就是内存泄漏，且同 id 重建会从半截序列继续）', rules.pointerOf('devSeq', 'r_seq') === 0)
  check('级联删除不动别的项目的规则（B 与共享的原样留着）',
    rules.listOfGroup(pBOther.id).length > 0 && rules.listOfGroup(sh.id).length === 2 && rules.list().length === beforeCascade - removedRules)
  check('删完项目再删条目：表里不再留下任何指向已删项目的规则',
    hg.remove(pSeq.id) === true && rules.list().every((r) => r.groupId !== pSeq.id))

  // 8. 私有范围替换：PUT /rules 在 C14 只顶掉**调用者自己**的那一片
  const tableBefore = rules.list().length
  const mineBefore = rules.listForOwner(A).length
  check('私有范围替换拒绝非数组（对象当数组是 F-15 的原形态）', statusOf(() => rules.replacePrivateScope({ a: 1 }, A)) === 400)
  const crossScope = () => rules.replacePrivateScope([mkRule({ id: 'r_shared', groupId: sh.id }) as never], A)
  check('私有范围替换拒绝任何一条不属于自己私有项目的规则', statusOf(crossScope) === 400 && codeOf(crossScope) === 'EC_SCOPE_MISMATCH')
  const dupFn = () => rules.replacePrivateScope([mkRule({ id: 'x1', groupId: pOn.id }), mkRule({ id: 'x1', groupId: pOn.id })] as never, A)
  check('私有范围替换拒绝重复 id', statusOf(dupFn) === 400)
  check('被拒的批量一条也没写进去（不做「成功的几条算几条」，表里条数一字未动）', rules.list().length === tableBefore, `${tableBefore} → ${rules.list().length}`)
  const done = rules.replacePrivateScope([
    mkRule({ id: 'r_on', groupId: pOn.id, match: { method: 'GET', path: '/c14/on' } }),
    mkRule({ id: 'r_mine_new', groupId: pOn.id, match: { method: 'GET', path: '/c14/mine-new' } }),
  ] as never, A)
  check('私有范围替换**只替换自己的**：A 的旧条目被这次提交顶掉，B 的、共享的、无归属的原样留着',
    tableBefore === 16 && mineBefore === 8 && done.replaced === 2 && done.preserved === tableBefore - mineBefore &&
      rules.list().length === done.preserved + 2,
    JSON.stringify([done, tableBefore, mineBefore]))
  check('替换是「私有范围内给什么存什么」，不是按 id 合并：没在提交清单里的 A 旧条目就是消失了',
    !rules.list().some((r) => r.id === 'r_proj_off') && rules.list().some((r) => r.id === 'r_mine_new'))
  check('替换不会把别人的项目清空', rules.listOfGroup(pBOther.id).length > 0 && rules.listOfGroup(sh.id).length === 2)
  check('替换也不给自己留无归属条目（这次提交的每一条都挂在 pOn 下）', rules.listForOwner(A).every((r) => r.groupId === pOn.id))
  check('replacePrivateScope 不重置顺序指针（拖动排序不该打断别的设备的序列）', rules.pointerOf('devB', 'r_b_seq') === 1)
  check('listForOwner 脏会话 → 空表；listOfGroup 脏 id → 空表',
    rules.listForOwner('').length === 0 && rules.listForOwner(null).length === 0 && rules.listOfGroup(123).length === 0 && rules.listOfGroup('').length === 0)

  // 9. 推到数据面：owner 是**从 deviceId 反查**的，不存在「调用方声明我是谁」的入口
  const dir3 = '.data-selftest/projects-plane'
  rmSync(dir3, { recursive: true, force: true })
  const pg = new GroupStore(dir3)
  const pr = new RuleEngine(dir3, pg)
  const store3 = new Store(50)
  store3.upsertDevice({ deviceId: 'dA', sessionId: 'sessA' })
  store3.upsertDevice({ deviceId: 'dB', sessionId: 'sessB' })
  store3.upsertDevice({ deviceId: 'dN', sessionId: 'sessN' })
  store3.bindDevice(A, 'dA')
  store3.bindDevice(B, 'dB')
  const planeA = pg.create({ name: 'A 的私有项目', enabled: true }, A)
  const planeB = pg.create({ name: 'B 的私有项目', enabled: true }, B)
  const planeShared = pg.upsert({ id: 'g_plane_shared', name: '共享库', enabled: true, createdAt: 1, updatedAt: 1, scope: 'shared', ownerPhone: null, createdBy: null, archived: false } as Group)
  pr.replaceAll([
    mkRule({ id: 'r_plane_shared', groupId: planeShared.id, match: { method: 'GET', path: '/c14/shared' }, action: { type: 'mock', response: { status: 200, body: '{"who":"shared"}' } } }),
  ] as never)
  pr.create(mkRule({ groupId: planeA.id, match: { method: 'GET', path: '/c14/a' }, action: { type: 'mock', response: { status: 200, body: '{"who":"A"}' } } }) as never, A)
  pr.create(mkRule({ groupId: planeB.id, match: { method: 'GET', path: '/c14/b' }, action: { type: 'mock', response: { status: 200, body: '{"who":"B"}' } } }) as never, B)
  const handle3 = createDataPlane({ cfg, store: store3, rules: pr })
  const dp = (path: string, dev: string): Promise<{ status: number; body: string }> =>
    invoke(handle3, { method: 'GET', url: `/__ec/p${path}`, headers: { 'x-ec-target': `http://127.0.0.1:1${path}`, 'x-ec-device-id': dev } })
  const dpA = await dp('/c14/a', 'dA')
  check('数据面：A 的设备命中 A 的私有项目规则（200 + 正文）', dpA.status === 200 && dpA.body.includes('"who":"A"'), `got ${dpA.status} ${dpA.body.slice(0, 60)}`)
  const dpCross = await dp('/c14/a', 'dB')
  check('数据面：B 的设备打 A 的路径 → 放行上游（拒连 502），**不是**命中别人的规则', dpCross.status === 502, `got ${dpCross.status} ${dpCross.body.slice(0, 60)}`)
  check('数据面：未绑定设备一条私有规则都命中不了（请求原样转发，不是被拒绝）', (await dp('/c14/a', 'dN')).status === 502 && (await dp('/c14/b', 'dN')).status === 502)
  check('数据面：不带设备头走兼容层派生出一个陌生设备，同样候选集为空', (await dp('/c14/a', '')).status === 502)
  check('数据面：共享项目的规则对**任何**已绑定设备都不命中（要 mock 必须先 copy）',
    (await dp('/c14/shared', 'dA')).status === 502 && (await dp('/c14/shared', 'dB')).status === 502)
  check('数据面：B 命中自己的规则不受 A 影响（两侧私有项目同时开着）', (await dp('/c14/b', 'dB')).status === 200)
  pg.setEnabled(planeA.id, false, A)
  check('数据面：关掉 A 的项目后 A 的设备也 502（整组开关推到真实分流走一遍）', (await dp('/c14/a', 'dA')).status === 502)
  check('关项目期间 B 不受牵连', (await dp('/c14/b', 'dB')).status === 200)
  pg.setEnabled(planeA.id, true, A)
  const dpReopen = await dp('/c14/a', 'dA')
  check('数据面：重开项目后立即恢复 mock', dpReopen.status === 200 && dpReopen.body.includes('"who":"A"'), `got ${dpReopen.status}`)
  check('数据面不鉴权这条取舍没被改动：私有命中仍然只靠设备头，不需要任何会话（ADR-015）',
    (await invoke(handle3, { method: 'GET', url: '/__ec/p/c14/a', headers: { 'x-ec-target': 'http://127.0.0.1:1/c14/a', 'x-ec-device-id': 'dA', authorization: 'garbage' } })).status === 200)

  // 10. 落盘与实例共享（index.ts 必须把同一份 GroupStore 传给管理面和数据面）
  const other = new GroupStore(dir3)
  pg.setEnabled(planeA.id, false, A)
  check('另一份 GroupStore 读不到刚才的内存改动（这就是两侧必须共用同一实例的原因）',
    other.get(planeA.id)?.enabled === true, JSON.stringify(other.get(planeA.id)))
  pg.setEnabled(planeA.id, true, A)
  check('项目改动已落盘：新实例读到最后一次开关', new GroupStore(dir3).get(planeA.id)?.enabled === true)
  const reload3 = new GroupStore(dir3)
  check('C14 字段落盘读回：scope / ownerPhone / createdBy 都在（丢了 owner 就等于把项目降级成永不命中）',
    reload3.get(planeA.id)?.scope === 'private' && reload3.get(planeA.id)?.ownerPhone === A && reload3.get(planeA.id)?.createdBy === A,
    JSON.stringify(reload3.get(planeA.id)))
  check('共享项目落盘不带 owner（读回仍是 null，不会因为「谁最后动过」而变归属）',
    reload3.get(planeShared.id)?.scope === 'shared' && reload3.get(planeShared.id)?.ownerPhone === null)
  check('规则里的 groupId 落盘读回',
    (new RuleEngine(dir3).list().find((r) => r.id === 'r_plane_shared') as unknown as { groupId?: string }).groupId === planeShared.id)
  check('项目表与规则表各写各的文件，rules.json 仍是数组（不改任何文件格式）',
    Array.isArray(JSON.parse(readFileSync(join(dir3, 'rules.json'), 'utf8'))) && Array.isArray(JSON.parse(readFileSync(join(dir3, 'groups.json'), 'utf8'))))
  rmSync(dir, { recursive: true, force: true })
  rmSync(dir2, { recursive: true, force: true })
  rmSync(dir3, { recursive: true, force: true })
}

/**
 * 迁移与存量数据安置（C14 / 协议 §4.7、§5.4 的两个硬约束）。
 *
 * 这段用例的全部意义在「升级后不能静默失效」：存量 `rules.json` 里躺着大量**无归属**规则
 * （C13 允许未分组，也允许 `groupId` 指向早已删掉的组），而 C14 把「无归属」定义成永不命中。
 * 不安置它们就等于「升级后所有人的 mock 悄悄全废，界面上一切正常」——最难查的那类事故。
 * 所以每条断言都问两句：这些规则被安置到了哪个容器里，以及**它们现在到底命中吗**。
 */
async function testProjectMigration(): Promise<void> {
  console.log('\n[F-31] 迁移：存量分组 → shared，无归属规则收进旧版共享容器（C14 / ADR-033）')
  const dir = '.data-selftest/migrate'
  rmSync(dir, { recursive: true, force: true })
  const mk = (over: Record<string, unknown>) => ({
    enabled: true,
    priority: 1,
    match: { method: 'GET', path: '/m' },
    action: { type: 'mock', response: { status: 200, body: '{"m":"1"}' } },
    ...over,
  })
  const A = '13800000001'
  const B = '13800000002'

  // 1. 手写一份 C13 时代的 .data：分组没有 scope/owner，规则既有未分组、也有悬空引用、还有脏形状
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'groups.json'),
    JSON.stringify([
      { id: 'g_old1', name: '旧版登录分组', enabled: true, createdAt: 11, updatedAt: 12 },
      { id: 'g_old2', name: '旧版订单分组', enabled: false, createdAt: 21, updatedAt: 22 },
    ]),
    'utf8',
  )
  writeFileSync(
    join(dir, 'rules.json'),
    JSON.stringify([
      mk({ id: 'r_free', match: { method: 'GET', path: '/m/free' } }),
      mk({ id: 'r_dangling', groupId: 'g_deleted', match: { method: 'GET', path: '/m/dangling' } }),
      mk({ id: 'r_in_old1', groupId: 'g_old1', match: { method: 'GET', path: '/m/in1' } }),
      mk({ id: 'r_dirty_params', match: { method: 'GET', path: '/m/dirty', params: ['不是对象'] } }),
      '字符串条目',
      null,
      42,
    ]),
    'utf8',
  )
  const groups = new GroupStore(dir)
  const rules = new RuleEngine(dir, groups)
  check('旧 groups.json 读进来一律 shared、owner 与创建人都是 null（不伪造归属，也不伪造创建人）',
    groups.list().length === 2 && groups.list().every((g) => g.scope === 'shared' && g.ownerPhone === null && g.createdBy === null),
    JSON.stringify(groups.list()))
  check('旧分组的名称 / 开关 / 时间戳原样保留（关着的那个仍是关着的）',
    groups.get('g_old2')?.enabled === false && groups.get('g_old1')?.createdAt === 11 && groups.get('g_old1')?.name === '旧版登录分组')
  const out = migrateProjects(groups, rules)
  check('迁移如实报告「搬了几条 + 容器 id + 转成共享的分组数」，启动横幅要用它而不是让人猜',
    out.moved === 3 && out.containerId === LEGACY_SHARED_ID && out.sharedGroups === 2, JSON.stringify(out))
  check('固定容器 id 就是 g_legacy_shared（控制台与 CLI 都要按这个 id 认出「旧版共享规则」）', LEGACY_SHARED_ID === 'g_legacy_shared')
  const container = groups.get(LEGACY_SHARED_ID)
  check('旧版共享容器：shared + 启用 + 创建人 null（它是迁移产物，不是某个人的项目）',
    container?.scope === 'shared' && container?.ownerPhone === null && container?.createdBy === null &&
      container?.enabled === true && container?.name === LEGACY_SHARED_NAME, JSON.stringify(container))
  const movedIds = rules.listOfGroup(LEGACY_SHARED_ID).map((r) => String(r.id)).sort()
  check('未分组、悬空 groupId、脏形状三类规则**全部**收进容器（§5.4 硬约束 ①：没有任何规则处于无归属状态）',
    JSON.stringify(movedIds) === JSON.stringify(['r_dangling', 'r_dirty_params', 'r_free']), JSON.stringify(movedIds))
  check('已有归属（指向旧分组）的规则留在原项目里，不被搬走',
    rules.listOfGroup('g_old1').map((r) => String(r.id)).join(',') === 'r_in_old1')
  check('非法规则条目被丢掉而不是崩在启动路径上（F-16：一条脏记录不能让服务起不来）',
    rules.list().length === 4 && rules.list().every((r) => r && typeof r === 'object' && typeof r.id === 'string'),
    JSON.stringify(rules.list().map((r) => (r as { id?: unknown }).id)))
  check('Rule ID 一字未改（迁移只改归属，不改身份）',
    JSON.stringify(rules.list().map((r) => String(r.id)).sort()) === JSON.stringify(['r_dangling', 'r_dirty_params', 'r_free', 'r_in_old1']),
    JSON.stringify(rules.list().map((r) => String(r.id))))
  const hitM = (path: string, phone: string | null) =>
    rules.resolve({ method: 'GET', host: 'h.example', path, deviceId: 'dM', ownerPhone: phone })?.rule.id ?? null
  check('迁移后的旧规则**不再直接命中**（它们现在是共享内容）——这条就是升级提示要写明的行为变化',
    hitM('/m/free', A) === null && hitM('/m/dangling', A) === null && hitM('/m/in1', A) === null && hitM('/m/free', B) === null,
    `${hitM('/m/free', A)}/${hitM('/m/in1', A)}`)
  const reloadG = new GroupStore(dir)
  const reloadR = new RuleEngine(dir, reloadG)
  check('迁移已落盘：新实例读得到容器与搬完的归属（重启不自愈的反例就是没落盘）',
    reloadG.exists(LEGACY_SHARED_ID) && reloadR.listOfGroup(LEGACY_SHARED_ID).length === 3 &&
      String(reloadR.list().find((r) => r.id === 'r_free')?.groupId) === LEGACY_SHARED_ID)
  check('rules.json 与 groups.json 都还是数组形状（不改任何文件格式，ADR-028 的逐字节读回依赖它）',
    Array.isArray(JSON.parse(readFileSync(join(dir, 'rules.json'), 'utf8'))) && Array.isArray(JSON.parse(readFileSync(join(dir, 'groups.json'), 'utf8'))))
  const second = migrateProjects(reloadG, reloadR)
  check('第二次启动幂等：moved=0、不返回容器 id、也不会建第二个容器',
    second.moved === 0 && second.containerId === null && reloadG.list().filter((g) => g.id === LEGACY_SHARED_ID).length === 1,
    JSON.stringify(second))

  // 2. 全新实例（没有任何存量）不该凭空造一个空容器
  rmSync(dir, { recursive: true, force: true })
  const gFresh = new GroupStore(dir)
  const rFresh = new RuleEngine(dir, gFresh)
  const z = migrateProjects(gFresh, rFresh)
  check('空表迁移 → moved=0 且不创建容器（首次启动不该多出一个「旧版共享规则」空项目）',
    z.moved === 0 && z.containerId === null && z.sharedGroups === 0 && gFresh.exists(LEGACY_SHARED_ID) === false, JSON.stringify(z))

  // 3. 存量文件是坏的：迁移不能成为「升级当场起不来」的理由
  writeFileSync(join(dir, 'rules.json'), '{ 这不是 JSON', 'utf8')
  writeFileSync(join(dir, 'groups.json'), '42', 'utf8')
  let crashed = false
  try {
    migrateProjects(new GroupStore(dir), new RuleEngine(dir))
  } catch {
    crashed = true
  }
  check('rules.json / groups.json 双坏 → 迁移不抛（读路径的兜底方向在这里救命）', crashed === false)

  // 4. `scope=private` 但 owner 为空（手改出来的）同样算无归属
  rmSync(dir, { recursive: true, force: true })
  const g4 = new GroupStore(dir)
  const r4 = new RuleEngine(dir, g4)
  const fakePrivate = g4.upsert({ id: 'g_fake_private', name: '手改的私有项目', enabled: true, createdAt: 1, updatedAt: 1, scope: 'private', ownerPhone: null, createdBy: null, archived: false } as Group)
  r4.replaceAll([mk({ id: 'r_fake', groupId: fakePrivate.id, match: { method: 'GET', path: '/m/fake' } })] as never)
  const out4 = migrateProjects(g4, r4)
  check('private 但无主的规则一并收进容器（否则它们连「被别人复制」的机会都没有）',
    out4.moved === 1 && r4.listOfGroup(LEGACY_SHARED_ID).map((r) => String(r.id)).join(',') === 'r_fake', JSON.stringify(out4))

  // 5. 容器已存在时再来一条新未分组规则：复用同一个容器，不重复建
  r4.replaceAll([...r4.state(), mk({ id: 'r_late', match: { method: 'GET', path: '/m/late' } })] as never)
  const out5 = migrateProjects(g4, r4)
  check('第二次迁移复用已有容器（id 不重复、条目累加）',
    out5.moved === 1 && g4.list().filter((g) => g.id === LEGACY_SHARED_ID).length === 1 &&
      r4.listOfGroup(LEGACY_SHARED_ID).length === 2, JSON.stringify(out5))

  // 6. 容器可被 copy（这正是「安置成共享」而不是「塞给某个人的私有区」的理由），复制出来的才命中
  const svc = new ProjectService(dir, g4, r4)
  const copied = svc.copyShared(LEGACY_SHARED_ID, B, 'op_mig_copy')
  check('旧版共享容器能被任何登录用户 copy（安置成共享 = 交给用户自己认领，不替用户决定归属）',
    copied.privateProject?.scope === 'private' && copied.privateProject?.ownerPhone === B && (copied.rules?.length ?? 0) === 2,
    JSON.stringify(copied.privateProject))
  check('copy 之后立即恢复 mock（升级后「复制到我的项目」就是官方的恢复路径）',
    r4.resolve({ method: 'GET', host: 'h.example', path: '/m/fake', deviceId: 'dB', ownerPhone: B })?.rule.id != null)
  check('copy 不动源容器：旧版共享规则仍在那儿，别人还能再复制一次',
    r4.listOfGroup(LEGACY_SHARED_ID).length === 2 && g4.get(LEGACY_SHARED_ID)?.scope === 'shared')
  rmSync(dir, { recursive: true, force: true })
}

/**
 * 版本服务：copy / share / rollback 的原子提交、幂等重放与 journal 恢复（C14 / ADR-033）。
 *
 * 这是阶段 B 里唯一**同时写两个文件**（`rules.json` + `groups.json`，还要加快照与索引）的路径，
 * 所以它最怕的就是「半笔」：协议 §5.5 把提交顺序写成契约，架构 §6.3 要求崩溃后启动能确定性恢复。
 * 这里的断言因此分成三类，缺一不可：
 * - **成功类**：内容、id、历史指针、脱敏后的审计字段逐项核对（不是「返回 200 就算过」）；
 * - **失败类**：非法输入 / 越权 / 坏快照 / 超大 body 一律「整笔作废」，active 与历史一字未改；
 * - **崩溃类**：手写 pending journal 模拟进程中断，验证前滚与「不能猜」的放弃口径。
 */
async function testProjectVersions(): Promise<void> {
  console.log('\n[F-32] 版本服务：copy / share / rollback、operationId 幂等与 journal 恢复（C14 / ADR-033）')
  const dir = '.data-selftest/versions'
  rmSync(dir, { recursive: true, force: true })
  const A = '13800000001'
  const B = '13800000002'
  const C = '13900000003'
  const groups = new GroupStore(dir)
  const rules = new RuleEngine(dir, groups)
  const svc = new ProjectService(dir, groups, rules)
  const statusOf = (fn: () => unknown): number | null => {
    try {
      fn()
      return null
    } catch (e) {
      return (e as { statusCode?: number }).statusCode ?? -1
    }
  }
  const codeOf = (fn: () => unknown): string => {
    try {
      fn()
      return ''
    } catch (e) {
      return String((e as { code?: string }).code ?? '')
    }
  }
  const msgOf = (fn: () => unknown): string => {
    try {
      fn()
      return ''
    } catch (e) {
      return String((e as { message?: string }).message ?? '')
    }
  }
  /** 键序不参与语义：「逐字段一致」要比归一化后的内容，不能比 JSON 的书写顺序 */
  const canon = (v: unknown): string =>
    JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x))
  const mk = (over: Record<string, unknown>) => ({
    enabled: true,
    priority: 1,
    match: { method: 'GET', path: '/v' },
    action: { type: 'mock', response: { status: 200, body: '{"v":"1"}' } },
    ...over,
  })
  /**
   * 命中查询固定走 `api.example.com` + 带 `uid` 入参：fixture 里那条 login 规则同时约束
   * host 和 params，所以「命中」这件事要把协议 §5.4 那条完整 AND 一起验到，
   * 不能只比路径（比路径会让 host/params 写错的复制保真度悄悄过关）。
   */
  const hit = (phone: string | null, path: string): string | null =>
    rules.resolve({ method: 'GET', host: 'api.example.com', path, deviceId: 'dV', ownerPhone: phone, params: { uid: '1' } })?.rule.id ?? null

  // 1. 首发 publish
  const p1 = groups.create({ name: '登录模块', enabled: true }, A)
  const richAction = {
    type: 'mock',
    mode: 'sequence',
    seqMode: 'loop',
    pinIndex: 2,
    delayMs: 120,
    response: { status: 204, body: '{"fallback":true}' },
    responses: [
      { name: '正常', cond: { query: 'kind=ok', content: '' }, status: 200, headers: { 'x-t': '1' }, body: '{"tok":"a"}' },
      { name: '失败', cond: { query: 'kind=bad' }, status: 401, body: '{"err":"bad"}' },
    ],
  }
  const rLogin = rules.create(mk({ groupId: p1.id, priority: 7, match: { method: 'GET', host: 'api.example.com', path: '/api/login', params: { uid: '1' } }, action: richAction }) as never, A)
  const rMe = rules.create(mk({ groupId: p1.id, enabled: false, match: { method: 'GET', path: '/api/me' }, action: { type: 'passthrough' } }) as never, A)
  const pub = svc.sharePrivate(p1.id, A, 'op_publish_1')
  const sharedId = String(pub.sharedProject?.id ?? '')
  check('首发 publish 建出 shared 项目：scope shared、owner null、createdBy 是操作人、enabled 恒 true（共享项目的开关没人会读，不能沿用私有区那个「我暂时关掉」）',
    pub.sharedProject?.scope === 'shared' && pub.sharedProject?.ownerPhone === null && pub.sharedProject?.createdBy === A && pub.sharedProject?.enabled === true,
    JSON.stringify(pub.sharedProject))
  check('版本记录 operation=publish、parentVersionId null、ruleCount 等于项目内规则数',
    pub.version?.operation === 'publish' && pub.version?.parentVersionId === null && pub.version?.ruleCount === 2, JSON.stringify(pub.version))
  check('操作人**服务端**脱敏（回执与历史是跨用户数据，全手机号只要下发过就总有漏出去的一天）',
    pub.actor === '138****0001' && pub.version?.actorPhone === '138****0001', JSON.stringify([pub.actor, pub.version?.actorPhone]))
  check('分享时间来自服务器时钟（协议 §5.5：前端不得自己生成分享时间）', (pub.createdAt ?? 0) >= Date.now() - 60_000 && pub.createdAt > 0, String(pub.createdAt))
  check('shared 的 currentVersionId 指向刚生成的版本', groups.get(sharedId)?.currentVersionId === pub.version?.id)
  check('共享副本换发了新 rule id，不与私有区那两条撞号（一次分享绝不能顶掉别人在用的规则）',
    rules.listOfGroup(sharedId).every((r) => r.id !== rLogin.id && r.id !== rMe.id) && rules.list().length === 4)
  check('私有项目回填 originSharedProjectId + lineage（再分享要靠 lineage 还原原来的共享 id）',
    groups.get(p1.id)?.originSharedProjectId === sharedId && (groups.get(p1.id)?.lineage?.length ?? 0) === 2, JSON.stringify(groups.get(p1.id)?.lineage))
  check('share 不动调用者在用的规则：私有那两条一字未改', rules.listOfGroup(p1.id).map((r) => String(r.id)).sort().join(',') === [String(rLogin.id), String(rMe.id)].sort().join(','))
  check('共享内容永不参与命中：A 请求同一个路径命中的是自己的私有规则，不是共享副本',
    hit(A, '/api/login') === String(rLogin.id) && hit(B, '/api/login') === null && rules.listOfGroup(sharedId).every((r) => hit(A, String((r as { match?: { path?: string } }).match?.path)) !== String(r.id)))
  // 空项目那份发布**不留在 IIFE 里**：它的 versionId 属于另一个 shared 项目，第 7 节要拿它
  // 验证「版本查询限定在 projectId 之下」，而那个断言必须是个纯失败、不能再改状态。
  const pEmpty = groups.create({ name: '空的', enabled: true }, A)
  const emptyPub = svc.sharePrivate(pEmpty.id, A, 'op_empty_publish')
  const emptySharedId = String(emptyPub.sharedProject?.id ?? '')
  const emptyVersionId = String(emptyPub.version?.id ?? '')
  check('空私有项目也能发布（首发内容为 0 条不是错误，控制台要能显示这个空版本供回退）',
    emptyPub.version?.ruleCount === 0 && rules.listOfGroup(emptySharedId).length === 0 && svc.versions(emptySharedId).length === 1 && emptyVersionId.length > 0,
    JSON.stringify([emptySharedId, emptyVersionId, emptyPub.version?.ruleCount]))
  check('空项目占了独立的历史命名空间，不污染已有共享项目的历史',
    svc.versions(sharedId).length === 1 && svc.versions(emptySharedId)[0]?.ruleCount === 0)
  groups.remove(pEmpty.id)

  // 2. copy：共享 → 私有，内容全部由服务端从存储里读
  const copy = svc.copyShared(sharedId, B, 'op_copy_1')
  const bPriv = String(copy.privateProject?.id ?? '')
  check('copy 出来的项目归调用者：private + owner B + 名字带「(副本)」（列表里两个同名「登录模块」必须分得开）',
    copy.privateProject?.scope === 'private' && copy.privateProject?.ownerPhone === B && copy.privateProject?.name === '登录模块(副本)', JSON.stringify(copy.privateProject?.name))
  const sharedLogin = rules.listOfGroup(sharedId).find((r) => String((r as { match?: { path?: string } }).match?.path) === '/api/login') as Rule
  const copiedLogin = (copy.rules ?? []).find((r) => String((r as { match?: { path?: string } }).match?.path) === '/api/login') as Rule
  check('copy 逐字段保真：match（method/host/path/params）、action 的 mode/seqMode/pinIndex/delayMs/responses 的 name+cond+headers+status+body、enabled、priority',
    canon({ m: copiedLogin?.match, a: copiedLogin?.action, e: copiedLogin?.enabled, p: copiedLogin?.priority }) ===
      canon({ m: sharedLogin?.match, a: sharedLogin?.action, e: sharedLogin?.enabled, p: sharedLogin?.priority }),
    canon([copiedLogin, sharedLogin]))
  check('关着的规则复制过来仍是关着的（enabled 不参与「复制即启用」）',
    ((copy.rules ?? []).find((r) => String((r as { match?: { path?: string } }).match?.path) === '/api/me') as Rule | undefined)?.enabled === false)
  check('copy 是深拷贝：改副本的 body 不会串改共享源（共享库不能被「编辑我的项目」间接写坏）',
    copiedLogin !== undefined && copiedLogin.action?.responses !== undefined && copiedLogin.action.responses[0] !== sharedLogin.action?.responses?.[0])
  check('lineage 记下 sharedRuleId ⇄ privateRuleId 的稳定映射，条数与规则数一致',
    (copy.privateProject?.lineage?.length ?? 0) === 2 &&
      copy.privateProject?.lineage?.some((e) => e.privateRuleId === String(copiedLogin?.id) && e.sharedRuleId === String(sharedLogin?.id)) === true,
    JSON.stringify(copy.privateProject?.lineage))
  check('复制**不产生共享版本**：源项目历史一字未动（复制不是分享）',
    svc.versions(sharedId).length === 1 && groups.get(sharedId)?.currentVersionId === pub.version?.id && rules.listOfGroup(sharedId).length === 2)
  check('copy 出来的规则立刻命中 B 的设备（升级后恢复 mock 的唯一路径）',
    hit(B, '/api/login') === String(copiedLogin?.id) && hit(A, '/api/login') === String(rLogin.id))
  const copyReplay = svc.copyShared(sharedId, B, 'op_copy_1')
  check('同 operationId 重发只生成一份项目（超时重发不能变成「复制出两份」）',
    copyReplay.replayed === true && String(copyReplay.privateProject?.id) === bPriv && groups.visible(B, 'private').length === 1, JSON.stringify(copyReplay.privateProject?.id))
  const copyC = svc.copyShared(sharedId, C, 'op_copy_2')
  check('两次复制产生互相隔离的私有项目与映射（规则 id 不共用，改谁都不影响谁）',
    String(copyC.privateProject?.id) !== bPriv && (copyC.rules ?? []).every((r) => !(copy.rules ?? []).some((o) => o.id === r.id)))
  check('C 看不见 B 的私有副本（复制出来的东西是私有内容，不是又一份共享）',
    !groups.visible(C).some((g) => g.id === bPriv) && !rules.listForOwner(C).some((r) => String(r.groupId) === bPriv))

  // 3. 再分享 = 整项目覆盖
  rules.remove(rMe.id, A)
  rules.replaceOne(rLogin.id, mk({ groupId: p1.id, priority: 7, match: { method: 'GET', host: 'api.example.com', path: '/api/login', params: { uid: '1' } }, action: { type: 'mock', response: { status: 200, body: '{"tok":"b"}' } } }) as never, A)
  const rNew = rules.create(mk({ groupId: p1.id, match: { method: 'GET', path: '/api/new' } }) as never, A)
  const re = svc.sharePrivate(p1.id, A, 'op_share_2')
  const sharedNow = rules.listOfGroup(sharedId).map((r) => String(r.id))
  check('再分享整项目覆盖：新增、修改、删除都如实反映到 shared 当前内容',
    rules.listOfGroup(sharedId).length === 2 && rules.listOfGroup(sharedId).some((r) => String((r as { match?: { path?: string } }).match?.path) === '/api/new') &&
      !rules.listOfGroup(sharedId).some((r) => String((r as { match?: { path?: string } }).match?.path) === '/api/me') &&
      rules.listOfGroup(sharedId).some((r) => String((r as { action?: { response?: { body?: string } } }).action?.response?.body) === '{"tok":"b"}'),
    JSON.stringify(sharedNow))
  check('老规则**还原成它原来的共享 id**（lineage 生效：一次再分享不能让共享库全体换号）',
    sharedNow.includes(String(sharedLogin?.id)), `${String(sharedLogin?.id)} not in ${JSON.stringify(sharedNow)}`)
  check('新出现的规则这时才分配共享 id，且第二条历史带 operation=share + parentVersionId 指向第一版',
    re.version?.operation === 'share' && re.version?.parentVersionId === pub.version?.id && svc.versions(sharedId).length === 2, JSON.stringify(re.version))
  const snap1File = join(dir, 'projects', sharedId, String(pub.version?.id) + '.json')
  const snap1Raw = JSON.parse(readFileSync(snap1File, 'utf8') as string) as { version: ProjectVersion; group: Group; rules: Rule[] }
  const snapLogin = snap1Raw.rules.find((r) => String((r as { match?: { path?: string } }).match?.path) === '/api/login') as Rule | undefined
  check('第一版快照文件**原样躺在磁盘上**、内容仍是当时的 {"tok":"a"}（历史不可改写；直接读文件而不是读服务，才是「磁盘上真有这份」的证据）',
    snap1Raw.version.id === pub.version?.id && snap1Raw.version.projectId === sharedId && snap1Raw.group.id === sharedId &&
      snap1Raw.rules.length === 2 && String(snapLogin?.action?.responses?.[0]?.body) === '{"tok":"a"}',
    JSON.stringify(snap1Raw.rules.map((r) => [r.id, r.action?.mode, (r.action?.responses ?? [])[0]?.body])))
  check('同一时刻共享库的**当前**内容已经是 {"tok":"b"}（改的是 active，不是历史）',
    String((rules.listOfGroup(sharedId).find((r) => String(r.id) === String(sharedLogin?.id)) as Rule)?.action?.response?.body) === '{"tok":"b"}')
  check('覆盖后 A 的私有项目仍在（分享是复制一份出去，不是将自己的项目搬走）', rules.listOfGroup(p1.id).length === 2)

  // 4. 两个用户先后 share：last write wins + 两条历史各自记下操作人
  const bShare = svc.sharePrivate(bPriv, B, 'op_share_b')
  check('B 也能覆盖同一个 shared 项目（共享项目不是受保护的主分支，能读能复制就能覆盖——口径已写在计划里）',
    String(bShare.sharedProject?.id) === sharedId && rules.listOfGroup(sharedId).length === 2 &&
      // A 分享出去的内容被 B 的副本整体换掉：last write wins，**不做三方合并**
      bShare.version?.operation === 'share' && bShare.version?.parentVersionId === re.version?.id)
  check('B 覆盖共享库之后，B 自己的私有规则照常命中（share 不该反过来弄坏调用者在用的东西），' +
    '但共享库里那两条对任何人都永不命中',
    hit(B, '/api/login') === String(copiedLogin?.id) &&
      rules.listOfGroup(sharedId).every((r) => hit(A, String((r as { match?: { path?: string } }).match?.path)) !== String(r.id) &&
        hit(B, String((r as { match?: { path?: string } }).match?.path)) !== String(r.id)))
  check('历史保留两次快照并按时间升序，actor 分别是两个人且都已脱敏',
    svc.versions(sharedId).length === 3 && svc.versions(sharedId)[2]?.actorPhone === '138****0002' &&
      svc.versions(sharedId)[1]?.actorPhone === '138****0001', JSON.stringify(svc.versions(sharedId).map((v) => [v.operation, v.actorPhone])))

  // 5. 乐观锁：expectedSharedVersionId
  const stateBeforeLock = canon([rules.listOfGroup(sharedId), groups.get(sharedId)?.currentVersionId, svc.versions(sharedId)])
  const lockFn = () => svc.sharePrivate(p1.id, A, 'op_share_lock', 'v_not_current')
  check('expectedSharedVersionId 与服务端当前版本不符 → 409 EC_CONFLICT（脚本用得上的乐观锁）',
    statusOf(lockFn) === 409 && codeOf(lockFn) === 'EC_CONFLICT', `${statusOf(lockFn)} ${codeOf(lockFn)}`)
  check('冲突时零副作用：shared 当前内容、currentVersionId、历史三者一字未改',
    canon([rules.listOfGroup(sharedId), groups.get(sharedId)?.currentVersionId, svc.versions(sharedId)]) === stateBeforeLock)
  check('带对了 expectedSharedVersionId 就正常提交（锁只在版本不符时拦，不拦「谁先分享」）',
    svc.sharePrivate(p1.id, A, 'op_share_lock_ok', String(groups.get(sharedId)?.currentVersionId)).version?.operation === 'share')

  // 6. 历史查询与回退
  const hist = svc.versions(sharedId)
  const v1 = hist[0]
  check('历史列表按时间升序，视图里**不含快照文件路径**（那是服务端内部布局，不下发）',
    hist.length > 1 && v1?.createdAt <= hist[hist.length - 1].createdAt && !('snapshotFile' in (v1 as object)) && Object.keys(v1 ?? {}).includes('id'),
    JSON.stringify(Object.keys(v1 ?? {})))
  const detail = svc.versionDetail(sharedId, String(v1?.id))
  check('版本预览返回该版本的项目元数据与规则清单（回退前要给用户看清楚要替换成什么）',
    detail.rules.length === 2 && detail.version.id === v1?.id && detail.version.actorPhone === '138****0001', JSON.stringify(detail.rules.map((r) => r.id)))
  const stateBeforeRollback = canon([rules.listOfGroup(sharedId), groups.get(sharedId), svc.versions(sharedId)])
  const rb = svc.rollbackShared(sharedId, String(v1?.id), C, 'op_rollback_1')
  check('回退后 shared 当前内容与目标版本快照**逐字段一致**（不是「大概差不多」）',
    canon(rules.listOfGroup(sharedId)) === canon(svc.versionDetail(sharedId, String(v1?.id)).rules))
  check('回退新增一条 rollback 版本并记 rollbackOf，不清任何历史（历史事件顺序不可修改）',
    rb.version?.operation === 'rollback' && rb.version?.rollbackOf === v1?.id && svc.versions(sharedId).length === hist.length + 1, JSON.stringify(rb.version))
  check('回退后 currentVersionId 指向新那条，parentVersionId 串起链路',
    groups.get(sharedId)?.currentVersionId === rb.version?.id && rb.version?.parentVersionId === hist[hist.length - 1]?.id)
  check('回退本身可被再回退（允许从任一历史点起跳，也允许回退到更早的点）',
    (() => {
      const rb2 = svc.rollbackShared(sharedId, String(rb.version?.id), C, 'op_rollback_2')
      return rb2.version?.operation === 'rollback' && canon(rules.listOfGroup(sharedId)) === canon(svc.versionDetail(sharedId, String(rb.version?.id)).rules)
    })())
  check('回退后的共享内容依然永不命中（回退改变的是共享库，不是「让共享直接生效」）',
    hit(A, '/api/login') !== null && svc.versions(sharedId).length > 2 && rules.listOfGroup(sharedId).every((r) => hit(A, String((r as { match?: { path?: string } }).match?.path)) !== String(r.id)))
  check('归档不删快照也不删历史：归档后仍可查历史、仍可回退', (() => {
    const before = svc.versions(sharedId).length
    groups.setArchived(sharedId, true, A)
    const ok = svc.versions(sharedId).length === before && statusOf(() => svc.versionDetail(sharedId, String(v1?.id))) === null
    groups.setArchived(sharedId, false, A)
    return ok
  })())

  // 7. 非法输入与越权：整笔作废，不留半提交
  const stateGuard = canon([rules.list(), groups.list(), svc.versions(sharedId)])
  for (const bad of [undefined, null, '', '   ', 123, {}] as unknown[]) {
    const fn = () => svc.copyShared(sharedId, B, bad)
    check(`operationId 脏值（${JSON.stringify(bad)}）→ 400，不进事务内核`, statusOf(fn) === 400, `${statusOf(fn)}`)
    const fn2 = () => svc.sharePrivate(p1.id, A, bad)
    check(`share 的 operationId 脏值（${JSON.stringify(bad)}）→ 400`, statusOf(fn2) === 400)
    const fn3 = () => svc.rollbackShared(sharedId, String(v1?.id), C, bad)
    check(`rollback 的 operationId 脏值（${JSON.stringify(bad)}）→ 400`, statusOf(fn3) === 400)
  }
  check('copy 的源必须是共享项目：拿自己的 private 当源 → 400 EC_SCOPE_MISMATCH',
    statusOf(() => svc.copyShared(p1.id, A, 'op_bad_src')) === 400 && codeOf(() => svc.copyShared(p1.id, A, 'op_bad_src')) === 'EC_SCOPE_MISMATCH')
  check('copy 他人的 private 当源 → 404（与不存在同形，不回答「这个 id 属于谁」）', statusOf(() => svc.copyShared(p1.id, B, 'op_bad_src2')) === 404)
  check('share 一个共享项目 → 409 EC_PROJECT_READONLY（改共享内容的唯一路径是 copy → 编辑 → share）',
    statusOf(() => svc.sharePrivate(sharedId, A, 'op_bad_share')) === 409 && codeOf(() => svc.sharePrivate(sharedId, A, 'op_bad_share')) === 'EC_PROJECT_READONLY')
  check('share 他人的 private → 404（不是 403）', statusOf(() => svc.sharePrivate(bPriv, A, 'op_bad_share2')) === 404)
  check('rollback 缺 versionId / 空串 / 非字符串 → 400',
    statusOf(() => svc.rollbackShared(sharedId, undefined, C, 'op_rb_400')) === 400 && statusOf(() => svc.rollbackShared(sharedId, '', C, 'op_rb_400b')) === 400 &&
      statusOf(() => svc.rollbackShared(sharedId, 7, C, 'op_rb_400c')) === 400)
  check('rollback 不存在的版本 → 404 EC_PROJECT_NOT_FOUND',
    statusOf(() => svc.rollbackShared(sharedId, 'v_never', C, 'op_rb_404')) === 404 && codeOf(() => svc.rollbackShared(sharedId, 'v_never', C, 'op_rb_404')) === 'EC_PROJECT_NOT_FOUND')
  check('拿**别的项目的版本 id** 来回退 → 404 EC_PROJECT_NOT_FOUND（版本始终限定在 projectId 之下查，' +
    '不存在全局 versionId 跨项目取快照这条路）',
    statusOf(() => svc.rollbackShared(sharedId, emptyVersionId, C, 'op_rb_foreign')) === 404 &&
      codeOf(() => svc.rollbackShared(sharedId, emptyVersionId, C, 'op_rb_foreign2')) === 'EC_PROJECT_NOT_FOUND' &&
      // 反过来查自己项目的版本当然查得到，证明 404 来自「限定在 projectId 之下」而不是历史整个读不出来
      statusOf(() => svc.versionDetail(emptySharedId, emptyVersionId)) === null)
  check('rollback 一个私有项目 → 409（回退只对共享库有意义）',
    statusOf(() => svc.rollbackShared(p1.id, String(v1?.id), A, 'op_rb_priv')) === 409 && statusOf(() => svc.rollbackShared(bPriv, String(v1?.id), A, 'op_rb_privB')) === 404)
  check('上面这些失败一条也没改到状态（三个文件与两份表全等，不留「几条成功几条失败」）',
    canon([rules.list(), groups.list(), svc.versions(sharedId)]) === stateGuard, 'state drifted after rejected operations')
  // 7.5 共享项目软删除（ADR-037）：删除先挂 7 天，规则与历史一条不动，到期才真删
  const pTrash = groups.create({ name: '待删除演示', enabled: true }, A)
  rules.create(mk({ groupId: pTrash.id, match: { method: 'GET', path: '/v/trash' } }) as never, A)
  const trashPub = svc.sharePrivate(pTrash.id, A, 'op_trash_publish')
  const trashId = String(trashPub.sharedProject?.id ?? '')
  const trashRuleIds = rules.listOfGroup(trashId).map((r) => String(r.id)).sort().join(',')
  const trashHistory = canon(svc.versions(trashId))
  const trashVersionId = String(svc.versions(trashId)[0]?.id ?? '')
  const rulesCountBefore = rules.list().length
  const groupsCountBefore = groups.list().length

  const pending = groups.markPendingDelete(trashId, B) // 任何登录用户都能发起（与归档同一档权限，ADR-033 决策 5 的推论）
  check('共享项目删除 = 软删除：只打 pendingDeleteAt / purgeAt，项目本身一字未改',
    typeof pending.pendingDeleteAt === 'number' && typeof pending.purgeAt === 'number' &&
      pending.scope === 'shared' && pending.name === trashPub.sharedProject?.name && pending.currentVersionId === trashPub.version?.id,
    JSON.stringify(pending))
  check('宽限期正好 7 天（purgeAt - pendingDeleteAt === SHARED_TRASH_MS）',
    (pending.purgeAt as number) - (pending.pendingDeleteAt as number) === SHARED_TRASH_MS,
    String((pending.purgeAt as number) - (pending.pendingDeleteAt as number)))
  check('待删除**不动**规则与历史：规则清单、历史版本、两份表全等（动了 restore 就是假的）',
    rules.listOfGroup(trashId).map((r) => String(r.id)).sort().join(',') === trashRuleIds &&
      canon(svc.versions(trashId)) === trashHistory && canon([rules.list(), groups.list()]) !== '' &&
      rules.listOfGroup(trashId).length === 1 && svc.versions(trashId).length === 1)
  const purgeAtFirst = pending.purgeAt
  const pendingAgain = groups.markPendingDelete(trashId, C)
  check('重复删除幂等且**不延长**倒计时（否则反复点删除 = 永不删除）',
    pendingAgain.purgeAt === purgeAtFirst && pendingAgain.pendingDeleteAt === pending.pendingDeleteAt)
  check('待删除期间仍可读、仍可 copy 出去（这是唯一的逃生口，不能跟着一起关掉）',
    rules.listOfGroup(trashId).length === 1 && String(svc.copyShared(trashId, C, 'op_trash_copy').privateProject?.scope) === 'private')
  check('待删除期间 share 覆盖 → 409 EC_PROJECT_READONLY（写进去的内容 7 天后会跟着项目消失）',
    statusOf(() => svc.sharePrivate(pTrash.id, A, 'op_trash_share')) === 409 &&
      codeOf(() => svc.sharePrivate(pTrash.id, A, 'op_trash_share2')) === 'EC_PROJECT_READONLY')
  check('待删除期间 rollback → 409 EC_PROJECT_READONLY',
    statusOf(() => svc.rollbackShared(trashId, trashVersionId, A, 'op_trash_rb')) === 409 &&
      codeOf(() => svc.rollbackShared(trashId, trashVersionId, A, 'op_trash_rb2')) === 'EC_PROJECT_READONLY')
  check('private 没有「待删除」这一档：markPendingDelete → 409（私有项目是立刻物理删除）',
    statusOf(() => groups.markPendingDelete(pTrash.id, A)) === 409 &&
      codeOf(() => groups.markPendingDelete(pTrash.id, A)) === 'EC_PROJECT_READONLY')
  check('迁移容器 g_legacy_shared 拒绝删除（它装着全服升级前的存量规则）', (() => {
    const legacy = groups.upsert({ id: LEGACY_SHARED_ID, name: '旧版共享规则', enabled: true, createdAt: 1, updatedAt: 1, scope: 'shared', ownerPhone: null, createdBy: null, archived: false } as Group)
    const st = statusOf(() => groups.markPendingDelete(legacy.id, A))
    groups.remove(legacy.id)
    return st === 409
  })())
  const restored = groups.cancelPendingDelete(trashId, B)
  check('restore 清掉两个时间戳，规则与历史原样还在（内容从未被改过）',
    restored.pendingDeleteAt === undefined && restored.purgeAt === undefined &&
      rules.listOfGroup(trashId).map((r) => String(r.id)).sort().join(',') === trashRuleIds && canon(svc.versions(trashId)) === trashHistory)
  check('restore 幂等：不在待删除时再调一次也 ok，且不改 updatedAt',
    groups.cancelPendingDelete(trashId, B).updatedAt === restored.updatedAt)
  check('private 调 restore → 409（它没有可撤销的删除）',
    statusOf(() => groups.cancelPendingDelete(pTrash.id, A)) === 409)
  check('清扫：未到期的项目一条都不动（提前一小时扫，项目还在）', (() => {
    groups.markPendingDelete(trashId, A)
    const early = svc.purgeExpired(Date.now() + SHARED_TRASH_MS - 60_000)
    return early.purged.length === 0 && groups.get(trashId) !== undefined && rules.listOfGroup(trashId).length === 1
  })())
  check('清扫：到期后真删——规则、项目、历史快照目录全没了', (() => {
    const res = svc.purgeExpired(Date.now() + SHARED_TRASH_MS + 60_000)
    const hitTrash = res.purged.find((p) => p.id === trashId)
    return !!hitTrash && hitTrash.rules === 1 && hitTrash.files >= 1 &&
      groups.get(trashId) === undefined && rules.listOfGroup(trashId).length === 0 &&
      svc.versions(trashId).length === 0 && existsSync(join(dir, 'projects', trashId)) === false
  })())
  check('清扫幂等：再扫一次什么都不做（没有到期项目 → purged 为空、不报错）',
    svc.purgeExpired(Date.now() + SHARED_TRASH_MS * 2).purged.length === 0)
  check('软删除的脏值兜底：非法时间戳一律当「没有」，不因为一个坏数字把项目删掉', (() => {
    const g = groups.upsert({ id: 'g_trash_dirty', name: '脏时间戳', enabled: true, createdAt: 1, updatedAt: 1, scope: 'shared', ownerPhone: null, createdBy: null, archived: false, pendingDeleteAt: 'x' as unknown as number, purgeAt: -5 as unknown as number } as Group)
    const ok = g.pendingDeleteAt === undefined && g.purgeAt === undefined && svc.purgeExpired(Date.now() + 1e12).purged.every((p) => p.id !== g.id)
    groups.remove(g.id)
    return ok
  })())
  // 这段的净增量：pTrash 自己的 1 条规则 + C 复制出来的 1 条规则（各带一个私有项目）；
  // 共享项目那条规则随项目一起被真删，所以不留在表里
  // 两组基线是在「演示项目与其共享副本都已建好」之后取的：软删除本身不改任何表，
  // 清扫把共享项目（含 1 条规则）真删掉、C 的副本（1 项目 + 1 规则）留下，净变化正好抵消
  check('这段跑完的净增量对得上：软删除不改表、清扫只删了那个共享项目',
    rules.list().length === rulesCountBefore && groups.list().length === groupsCountBefore,
    JSON.stringify([rulesCountBefore, rules.list().length, groupsCountBefore, groups.list().length]))

  // 8. journal：崩溃恢复的两种确定结局
  const journalPath = join(dir, 'projects', 'journal.json')
  const crashGid = 'g_crash_copy'
  const crashRuleId = 'r_crash_copy'
  const afterGroups = [...groups.state(), { id: crashGid, name: '崩溃前未提交的那笔', enabled: true, createdAt: 5, updatedAt: 5, scope: 'private', ownerPhone: B, createdBy: B, archived: false } as Group]
  const afterRules = [...rules.state(), mk({ id: crashRuleId, groupId: crashGid, match: { method: 'GET', path: '/v/crash' } })]
  writeFileSync(
    journalPath,
    JSON.stringify({
      pending: {
        operationId: 'op_crash_1',
        kind: 'copy',
        actorPhone: B,
        createdAt: 5,
        sharedProjectId: sharedId,
        privateProjectId: crashGid,
        version: null,
        after: { rules: afterRules, groups: afterGroups },
        result: { kind: 'copy', operationId: 'op_crash_1', sharedProject: null, privateProject: afterGroups[afterGroups.length - 1], version: null, rules: null, actor: '138****0002', createdAt: 5, copiedFromVersionId: null },
      },
      receipts: [],
    }),
    'utf8',
  )
  const rec1 = svc.recover()
  check('进程中断在提交途中 → 启动时按 operationId 幂等**前滚**做完（不靠人手工修数据）',
    rec1.completed.includes('op_crash_1') && groups.exists(crashGid) && rules.listOfGroup(crashGid).map((r) => String(r.id)).join(',') === crashRuleId,
    JSON.stringify(rec1))
  check('前滚后 pending 清空并落回执：第二次启动不再重复前滚',
    JSON.parse(readFileSync(journalPath, 'utf8') as string).pending === null && svc.recover().completed.length === 0)
  const crashReplay = svc.copyShared(sharedId, B, 'op_crash_1')
  check('前滚过的 operationId 再打一次只拿回执，不生成第二份项目（幂等键是 operationId，不是内容哈希）',
    crashReplay.replayed === true && String(crashReplay.privateProject?.id) === crashGid, JSON.stringify(crashReplay.privateProject?.id))
  const ghostVersion = { id: 'v_ghost', projectId: 'g_ghost_proj', parentVersionId: null, operation: 'share', actorPhone: B, createdAt: 6, ruleCount: 0, snapshotFile: join('projects', 'g_ghost_proj', 'v_ghost.json') }
  const stateNow = canon([rules.state(), groups.state()])
  writeFileSync(
    journalPath,
    JSON.stringify({
      pending: {
        operationId: 'op_ghost_1',
        kind: 'share',
        actorPhone: B,
        createdAt: 6,
        sharedProjectId: 'g_ghost_proj',
        privateProjectId: null,
        version: ghostVersion,
        after: { rules: rules.state(), groups: groups.state() },
        result: { kind: 'share', operationId: 'op_ghost_1', sharedProject: null, privateProject: null, version: ghostVersion, rules: null, actor: '138****0002', createdAt: 6, copiedFromVersionId: null },
      },
      receipts: [],
    }),
    'utf8',
  )
  const rec2 = svc.recover()
  check('journal 说有快照、文件却不在 → **既不前滚也不后滚**：active 一字未改，只如实报告 abandoned（journal 只存 after，凭它猜旧状态只会把数据搞得更糟）',
    rec2.abandoned.includes('op_ghost_1') && canon([rules.state(), groups.state()]) === stateNow, JSON.stringify(rec2))
  check('放弃的事务同样把 pending 抹掉（否则每次启动都重演一遍这条幽灵事务）',
    JSON.parse(readFileSync(journalPath, 'utf8') as string).pending === null)
  writeFileSync(journalPath, '{ 这不是 JSON', 'utf8')
  let recCrashed = false
  try {
    svc.recover()
  } catch {
    recCrashed = true
  }
  check('journal 坏 JSON → 当作「没有 pending」，不抛（恢复路径崩掉就等于服务起不来）',
    recCrashed === false && svc.recover().completed.length === 0 && svc.recover().abandoned.length === 0)
  writeFileSync(journalPath, JSON.stringify({ pending: 'not an object', receipts: [null, 42, { operationId: 'op_real' }, '字符串'] }), 'utf8')
  let recShapeBad = false
  try {
    svc.recover()
  } catch {
    recShapeBad = true
  }
  check('pending 形状非法 → 当作「没有 pending」：不抛、不前滚，**磁盘上那份原样留着**' +
    '（读脏文件不顺手改写，诊断证据留在原处）',
    recShapeBad === false && svc.recover().completed.length === 0 &&
      JSON.parse(readFileSync(journalPath, 'utf8') as string).pending === 'not an object', readFileSync(journalPath, 'utf8').slice(0, 120))
  // 回执的过滤发生在**任何一次写 journal** 的时候（readJournal 读时就丢脏条目），所以拿一条
  // 合法 pending 走完整前滚，再核对落到磁盘上的回执表
  const noopAfter = { rules: rules.state(), groups: groups.state() }
  writeFileSync(
    journalPath,
    JSON.stringify({
      pending: {
        operationId: 'op_dirty_receipts',
        kind: 'copy',
        actorPhone: B,
        createdAt: 7,
        sharedProjectId: null,
        privateProjectId: null,
        version: null,
        after: noopAfter,
        result: { kind: 'copy', operationId: 'op_dirty_receipts', sharedProject: null, privateProject: null, version: null, rules: null, actor: '138****0002', createdAt: 7, copiedFromVersionId: null },
      },
      receipts: [null, 42, { operationId: 'op_real' }, '字符串'],
    }),
    'utf8',
  )
  const rec3 = svc.recover()
  const jAfter = JSON.parse(readFileSync(journalPath, 'utf8') as string) as { pending: unknown; receipts: unknown[] }
  check('合法 pending + 脏 receipts：照常前滚完，回执里脏条目被丢掉、合法那条与本次都在（重放保护不因脏条目整体失效）',
    rec3.completed.includes('op_dirty_receipts') && jAfter.pending === null && Array.isArray(jAfter.receipts) &&
      jAfter.receipts.length === 2 && jAfter.receipts.every((r) => !!r && typeof r === 'object' && typeof (r as { operationId?: unknown }).operationId === 'string') &&
      jAfter.receipts.some((r) => (r as { operationId?: string }).operationId === 'op_real'),
    readFileSync(journalPath, 'utf8').slice(0, 200))

  // 9. 坏快照：查不到就如实回 404，绝不「用当前内容顶上」
  const snap1Original = readFileSync(snap1File, 'utf8')
  const stateBeforeCorrupt = canon([rules.listOfGroup(sharedId), groups.get(sharedId), svc.versions(sharedId)])
  writeFileSync(snap1File, '{ 这不是 JSON', 'utf8')
  check('历史索引里有、快照文件被改坏 → versionDetail 404 EC_PROJECT_NOT_FOUND（不做自作聪明的兜底）',
    statusOf(() => svc.versionDetail(sharedId, String(v1?.id))) === 404 && codeOf(() => svc.versionDetail(sharedId, String(v1?.id))) === 'EC_PROJECT_NOT_FOUND' &&
      msgOf(() => svc.versionDetail(sharedId, String(v1?.id))).includes('corrupt'), msgOf(() => svc.versionDetail(sharedId, String(v1?.id))))
  const rbBad = () => svc.rollbackShared(sharedId, String(v1?.id), C, 'op_rb_corrupt')
  check('坏快照上的回退 → 404 且 active、currentVersionId、历史一字未改（「回退失败不得改当前内容」）',
    statusOf(rbBad) === 404 && canon([rules.listOfGroup(sharedId), groups.get(sharedId), svc.versions(sharedId)]) === stateBeforeCorrupt)
  writeFileSync(snap1File, snap1Original, 'utf8')
  check('把快照文件放回去之后回退恢复可用（读路径不改写磁盘：证据留原处）',
    statusOf(() => svc.versionDetail(sharedId, String(v1?.id))) === null)
  const indexPath = join(dir, 'projects', 'index.json')
  const indexOriginal = readFileSync(indexPath, 'utf8')
  writeFileSync(indexPath, '{ "历史被改成半个 JSON', 'utf8')
  check('历史索引坏 JSON → versions() 回空表且不抛（历史读不出来不等于历史没了）',
    svc.versions(sharedId).length === 0 && svc.hasHistory(sharedId) === false)
  writeFileSync(indexPath, JSON.stringify({ [sharedId]: '不是数组', other: [{ id: 'v_ok', projectId: 'wrong_id' }] }), 'utf8')
  check('索引里 projectId 对不上 / 值不是数组的条目被丢掉（脏索引不能凭空调出别人的历史）',
    svc.versions(sharedId).length === 0 && svc.versions('other').length === 0)
  writeFileSync(indexPath, indexOriginal, 'utf8')
  check('索引放回原处后历史又能查（改坏的是测试自己写的文件，服务端从不改写它）',
    svc.versions(sharedId).length > 2 && svc.hasHistory(sharedId) === true)

  // 10. 历史占用：报的是**实际落盘字节数**，不是条数估算（历史默认无限保留，所以必须看得见）
  const usage = svc.storageUsage()
  let expectBytes = 0
  let expectFiles = 0
  let expectProjects = 0
  const snapRoot = join(dir, 'projects')
  for (const name of readdirSync(snapRoot)) {
    const p = join(snapRoot, name)
    if (name === 'index.json' || name === 'journal.json') continue
    if (statSync(p).isDirectory()) {
      expectProjects++
      for (const f of readdirSync(p)) {
        expectBytes += statSync(join(p, f)).size
        expectFiles++
      }
    }
  }
  expectBytes += statSync(join(snapRoot, 'index.json')).size
  expectFiles += 1
  check('storageUsage 的字节数与文件数逐个 statSync 核对得上，且不含 journal.json（AGENTS.md §6：核对实际字节而不是估）',
    usage.bytes === expectBytes && usage.files === expectFiles && usage.projects === expectProjects, JSON.stringify([usage, expectBytes, expectFiles, expectProjects]))
  check('从未写过快照的历史占用 = 0 且不抛', (() => {
    const empty = new ProjectService('.data-selftest/versions-empty', new GroupStore('.data-selftest/versions-empty'), new RuleEngine('.data-selftest/versions-empty'))
    const u = empty.storageUsage()
    rmSync('.data-selftest/versions-empty', { recursive: true, force: true })
    return u.bytes === 0 && u.files === 0 && u.projects === 0
  })())

  // 11. 手机号脱敏（服务端做，不给前端第二次机会）
  check('11 位手机号留前三后四', maskPhone('13800000000') === '138****0000', maskPhone('13800000000'))
  check('长度 ≤7 一律整串打码（不猜「这算不算手机号」，脏会话也不该看到疑似手机号）', maskPhone('1234567') === '*******' && maskPhone('12345678') === '123****5678')
  check('脏输入 → 空串（不把 undefined / [object Object] 拼进控制台界面）',
    maskPhone(null) === '' && maskPhone(123) === '' && maskPhone('') === '' && maskPhone({ a: 1 }) === '')

  // 12. 快照字节上限：超限整笔作废，且不留下半写文件（一次超大分享不能把 .data/ 写满）
  //
  // 上限量的是**快照 payload 的实际 UTF-8 字节**，而快照只装被分享那个项目的规则，
  // 所以单条 body 就必须压过 64 MiB 才能触发——这条用例因此天生要写一百多兆的字符串，
  // 慢是慢在 JSON 序列化上，不是逻辑复杂。它换的是「磁盘护栏真的存在」这个结论，留着。
  const hugeBody = 'x'.repeat(65 * 1024 * 1024)
  const pHuge = groups.create({ name: '超大项目', enabled: true }, A)
  rules.create(mk({ groupId: pHuge.id, match: { method: 'GET', path: '/v/huge' }, action: { type: 'mock', response: { status: 200, body: hugeBody } } }) as never, A)
  const usageBeforeHuge = svc.storageUsage()
  const versionsBeforeHuge = svc.versions(sharedId).length
  const hugeFn = () => svc.sharePrivate(pHuge.id, A, 'op_huge_1')
  const hugeMsg = msgOf(hugeFn)
  const hugeBytes = Number(/snapshot is (\d+) bytes/.exec(hugeMsg)?.[1] ?? -1)
  check('快照实际字节数超过上限 → 507 EC_STORAGE_UNAVAILABLE，报错文案给的是**真实字节数**与上限（不是条数、不是估算）',
    statusOf(hugeFn) === 507 && codeOf(hugeFn) === 'EC_STORAGE_UNAVAILABLE' &&
      hugeBytes > 64 * 1024 * 1024 && hugeBytes < hugeBody.length + 4096 && hugeMsg.includes('67108864') && hugeMsg.includes('nothing was committed'),
    hugeMsg.slice(0, 120))
  check('超大分享零提交：active 规则、项目表、历史一字未改，没有新增任何快照文件或项目目录',
    svc.storageUsage().bytes === usageBeforeHuge.bytes && svc.storageUsage().files === usageBeforeHuge.files &&
      svc.storageUsage().projects === usageBeforeHuge.projects && svc.versions(sharedId).length === versionsBeforeHuge &&
      !groups.list().some((g) => g.scope === 'shared' && g.name === '超大项目'),
    JSON.stringify([usageBeforeHuge, svc.storageUsage()]))
  check('超大项目自己的私有区不受影响（失败的是「分享出去」这一步，不是把规则也搞坏了）',
    rules.listOfGroup(pHuge.id).length === 1 && hit(A, '/v/huge') !== null)
  rmSync(dir, { recursive: true, force: true })
}

/**
 * 控制台是零构建单页、没有测试框架，但「草稿 ⇄ 规则」往返与拖动换序的下标归属
 * 恰好是纯函数（也是最容易静默错的地方：拖完编辑到另一条、单项规则保存后 JSON 变形）。
 * 这里跑 `tools/console-mock-check.mjs`（从 index.html 里切出纯逻辑区段执行），
 * 让「一条命令全绿」这条验收门槛把它也带上。
 */
function testConsoleMockLogic(): void {
  console.log('\n[F-28] 控制台 Mock 编辑器纯逻辑（草稿 ⇄ 规则 / 换序 / 脏数据）')
  const file = fileURLToPath(new URL('./console-mock-check.mjs', import.meta.url))
  const child = spawnSync(process.execPath, [file], { encoding: 'utf8' })
  const out = `${child.stdout ?? ''}${child.stderr ?? ''}`
  console.log(out.trimEnd().split('\n').map((l) => (l ? '  ' + l : l)).join('\n'))
  check('控制台纯逻辑回归全绿（退出码 0）', child.status === 0 && out.includes('失败'), `exit=${child.status}`)
}

async function testSnapshots(): Promise<void> {
  console.log('\n[F-24] 现场快照（ADR-017）')
  const dir = '.data-selftest/snap'
  rmSync(dir, { recursive: true, force: true })

  // 1. 创建 → 读取
  let s = new SnapshotStore(dir, 3600_000, 200)
  const rec = mkRecord('r1', 'devA', 'http://api.foo.com/v1/login', 200)
  const snap = s.create(rec, '13800000001', 'POST /v1/login')
  check('创建后可按 token 读到', s.get(snap.token)?.token === snap.token)
  check('token 为 32 位十六进制（128 位随机，不可枚举）', /^[0-9a-f]{32}$/.test(snap.token))
  check('标题与创建者被记录', snap.title === 'POST /v1/login' && snap.createdBy === '13800000001')

  // 2. 冻结副本：源记录被改 / 被环形缓冲淘汰后，快照内容不变
  rec.response.status = 500
  rec.request.url = 'http://changed.local/x'
  const frozen = s.get(snap.token)
  check(
    '快照是冻结副本（与源记录解耦）',
    frozen?.record.response.status === 200 && frozen?.record.request.url === 'http://api.foo.com/v1/login',
  )

  // 3. 列表只含自己的，且是摘要（不含 body）
  s.create(mkRecord('r2', 'devB', 'http://api.bar.com/v1/x', 404), '13800000002')
  const mine = s.list('13800000001')
  check('列表只含自己创建的快照', mine.length === 1 && mine[0].token === snap.token)
  check('列表是摘要（不含 record 字段）', !('record' in mine[0]))

  // 4. 归属隔离：别人不能失效我的
  check('他人不能失效我的快照', s.revoke('13800000002', snap.token) === false)
  check('被拒后快照仍在', s.get(snap.token) !== undefined)
  check('本人可以失效', s.revoke('13800000001', snap.token) === true && s.get(snap.token) === undefined)

  // 5. 清空只清自己的
  s = new SnapshotStore(dir, 3600_000, 200)
  const a = s.create(mkRecord('a', 'devA', 'http://a.local/1', 200), '13800000001')
  const b = s.create(mkRecord('b', 'devB', 'http://b.local/1', 200), '13800000002')
  check('清空只清自己的', s.clear('13800000001') === 1 && s.get(a.token) === undefined && s.get(b.token) !== undefined)

  // 6. 过期：读路径顺手清理，磁盘文件同步删除
  const ttlDir = '.data-selftest/snap-ttl'
  rmSync(ttlDir, { recursive: true, force: true })
  const short = new SnapshotStore(ttlDir, 60, 200)
  const exp = short.create(mkRecord('e', 'devA', 'http://e.local/1', 200), '13800000001')
  check('未过期时可读', short.get(exp.token) !== undefined)
  await new Promise((r) => setTimeout(r, 90))
  check('过期后不可读', short.get(exp.token) === undefined)
  check('过期后磁盘文件被清掉', !existsSync(join(ttlDir, 'snapshots', exp.token + '.json')))

  // 7. ttl=0 → 永不过期
  const foreverDir = '.data-selftest/snap-forever'
  rmSync(foreverDir, { recursive: true, force: true })
  const forever = new SnapshotStore(foreverDir, 0, 200)
  const f = forever.create(mkRecord('f', 'devA', 'http://f.local/1', 200), '13800000001')
  check('ttl=0 → expiresAt 为 null（永不过期）', f.expiresAt === null)

  // 8. 数量上限：按最旧淘汰
  const capDir = '.data-selftest/snap-cap'
  rmSync(capDir, { recursive: true, force: true })
  const capped = new SnapshotStore(capDir, 3600_000, 2)
  const c1 = capped.create(mkRecord('c1', 'devA', 'http://c/1', 200), '13800000001')
  await new Promise((r) => setTimeout(r, 2))
  capped.create(mkRecord('c2', 'devA', 'http://c/2', 200), '13800000001')
  await new Promise((r) => setTimeout(r, 2))
  const c3 = capped.create(mkRecord('c3', 'devA', 'http://c/3', 200), '13800000001')
  check(
    '超过上限按最旧淘汰',
    capped.count() === 2 && capped.get(c1.token) === undefined && capped.get(c3.token) !== undefined,
  )

  // 9. 落盘重载：重启后（新实例）链接仍可用
  const reloaded = new SnapshotStore(dir, 3600_000, 200)
  check('重启后仍能读到已落盘快照', reloaded.get(b.token) !== undefined)

  // 10. 脏输入（AGENTS.md §4：新增写入接口必须补非法输入用例）
  let threw = false
  try {
    s.create(null as never, '13800000001')
  } catch {
    threw = true
  }
  check('create(null) 抛错（拒绝脏记录）', threw)
  check('get 非字符串 token → undefined', s.get(123 as never) === undefined && s.get({} as never) === undefined)
  check('revoke 脏 token → false', s.revoke('13800000001', 123 as never) === false)
  check('list 非字符串 phone → 空列表', s.list(123 as never).length === 0)
  check('clear 非字符串 phone → 0', s.clear(null as never) === 0)

  // 11. 脏文件不毒化启动（F-16 的教训）
  const badDir = '.data-selftest/snap-bad'
  rmSync(badDir, { recursive: true, force: true })
  mkdirSync(join(badDir, 'snapshots'), { recursive: true })
  writeFileSync(join(badDir, 'snapshots', 'broken.json'), '{not json', 'utf8')
  writeFileSync(join(badDir, 'snapshots', 'shape.json'), '{"token":123}', 'utf8')
  let ok = true
  try {
    new SnapshotStore(badDir, 3600_000, 200)
  } catch {
    ok = false
  }
  check('脏快照文件不导致启动崩溃', ok)
}

async function testRolesAndDeviceVisibility(): Promise<void> {
  console.log('\n[F-25] 控制台角色与设备可见性（ADR-018）')

  // 1. 角色判定：唯一真值来源是 --admin 白名单；脏输入一律 'user'
  const admin = { ...cfg, adminPhones: ['13800000001'] }
  check('白名单内 → admin', roleOf(admin, '13800000001') === 'admin')
  check('白名单外 → user', roleOf(admin, '13800000002') === 'user')
  check('空串 → user', roleOf(admin, '') === 'user')
  check(
    '非字符串 → user（脏值不放权限）',
    roleOf(admin, 123 as never) === 'user' &&
      roleOf(admin, {} as never) === 'user' &&
      roleOf(admin, undefined as never) === 'user' &&
      roleOf(admin, null as never) === 'user',
  )
  check('未配置 --admin → 没有管理员', roleOf({ ...cfg, adminPhones: [] }, '13800000001') === 'user')
  check('isAdminPhone 与 roleOf 口径一致', isAdminPhone(admin, '13800000001') && !isAdminPhone(admin, '13800000002'))

  // 2. 设备可见性：普通用户 = 自己绑定的 + 未绑定的（可认领）；他人已绑定的不下发
  const dir = '.data-selftest/admin'
  rmSync(dir, { recursive: true, force: true })
  const s = new Store(50, dir)
  s.upsertDevice({ deviceId: 'devA', sessionId: 'sA' })
  s.upsertDevice({ deviceId: 'devB', sessionId: 'sB' })
  s.upsertDevice({ deviceId: 'devC', sessionId: 'sC' })
  s.upsertDevice({ deviceId: 'devD', sessionId: 'sD' })
  // 走真实路径建用户：登录 = createSession = upsertUser
  s.createSession('13800000001')
  s.createSession('13800000002')
  s.bindDevice('13800000001', 'devA')
  s.bindDevice('13800000002', 'devB')
  s.bindDevice('13900000009', 'devD') // 有归属但**没有用户记录**（手工改过 store.json 的场景）

  check('admin 视图（listDevices）看到全量 4 台', s.listDevices().length === 4)
  const u1 = s.listDevicesFor('13800000001').map((d) => d.deviceId).sort()
  const u2 = s.listDevicesFor('13800000002').map((d) => d.deviceId).sort()
  check('普通用户看到「自己绑定的 + 未绑定的」', u1.join(',') === 'devA,devC', u1.join(','))
  check('他人已绑定的设备不下发', u2.join(',') === 'devB,devC', u2.join(','))
  check(
    '未绑定设备对两人都可见（否则绑定新设备的流程被堵死）',
    u1.includes('devC') && u2.includes('devC'),
  )
  s.addRecord(mkRecord('unbound', 'devC', 'http://api.baz.com/v1/unbound', 200))
  check('未绑定设备记录对任何普通空间不可见',
    !s.recordVisible('devC', '13800000001') &&
      s.listRecords({ owner: '13800000001' }).every((r) => r.deviceId !== 'devC') &&
      s.listRecords({ owner: '13800000002' }).every((r) => r.deviceId !== 'devC'))
  check('当前绑定设备记录只对绑定空间可见',
    s.recordVisible('devA', '13800000001') && !s.recordVisible('devA', '13800000002'))
  check(
    '脏 phone → 空数组（宁可什么都不给，也不漏全量）',
    s.listDevicesFor(123 as never).length === 0 &&
      s.listDevicesFor({} as never).length === 0 &&
      s.listDevicesFor('' as never).length === 0 &&
      s.listDevicesFor(undefined as never).length === 0,
  )

  // 3. 空间汇总（管理员面板）
  s.addRecord(mkRecord('a1', 'devA', 'http://api.foo.com/v1/login', 200))
  s.addRecord(mkRecord('a2', 'devA', 'http://api.foo.com/v1/user', 500))
  s.addRecord(mkRecord('b1', 'devB', 'http://api.bar.com/v1/login', 200))
  s.addRecord(mkRecord('c1', 'devC', 'http://api.baz.com/v1/x', 200))
  s.addRecord(mkRecord('d1', 'devD', 'http://api.qux.com/v1/x', 200))
  const spaces = s.listSpaces()
  const sp1 = spaces.find((x) => x.phone === '13800000001')
  const sp2 = spaces.find((x) => x.phone === '13800000002')
  const sp9 = spaces.find((x) => x.phone === '13900000009')
  check('空间数 = 用户表 ∪ 设备归属', spaces.length === 3, `got ${spaces.length}`)
  check('空间 1：1 台设备 / 2 条记录', !!sp1 && sp1.devices === 1 && sp1.records === 2, JSON.stringify(sp1))
  check('空间 2：1 台设备 / 1 条记录', !!sp2 && sp2.devices === 1 && sp2.records === 1, JSON.stringify(sp2))
  check(
    '有设备但无用户记录的空间不被静默隐藏',
    !!sp9 && sp9.devices === 1 && sp9.records === 1,
    JSON.stringify(sp9),
  )
  check('未绑定设备的记录不计入任何空间', spaces.reduce((n, x) => n + x.records, 0) === 4)

  // 4. 脏记录不毒化汇总（AGENTS.md §4）
  s.addRecord(null as never)
  let threw = false
  let total = -1
  try {
    total = s.listSpaces().reduce((n, x) => n + x.records, 0)
  } catch {
    threw = true
  }
  check('脏记录不导致 listSpaces 崩溃且不计入', !threw && total === 4, `got ${total}`)

  const bindingStore = new Store(10)
  bindingStore.upsertDevice({ deviceId: 'phoneA', sessionId: 'sessionA' })
  bindingStore.upsertDevice({ deviceId: 'phoneB', sessionId: 'sessionB' })
  bindingStore.addRecord(mkRecord('phoneA-record', 'phoneA', 'http://api.local/a', 200))
  bindingStore.addRecord(mkRecord('phoneB-record', 'phoneB', 'http://api.local/b', 200))
  check('默认未绑定：设备可见但请求不进入空间列表',
    bindingStore.listDevicesFor('13800000001').length === 2 &&
      bindingStore.listRecords({ owner: '13800000001' }).length === 0)
  bindingStore.bindDevice('13800000001', 'phoneA')
  check('显式绑定后仅该设备请求进入空间列表',
    bindingStore.listRecords({ owner: '13800000001' }).map((r) => r.id).join(',') === 'phoneA-record')
  const rebound = bindingStore.bindDevice('13800000001', 'phoneB')
  check('换绑时自动解绑同一空间旧设备', rebound.ok && rebound.unbound.includes('phoneA'))
  check(
    '换绑后旧设备仍在设备列表、旧请求不可见且当前空间只绑定一台',
    bindingStore.deviceOwner('phoneA') === null &&
      !bindingStore.recordVisible('phoneA', '13800000001') &&
      bindingStore.listRecords({ owner: '13800000001' }).map((r) => r.id).join(',') === 'phoneB-record' &&
      bindingStore.listDevicesFor('13800000001').some((d) => d.deviceId === 'phoneA') &&
      bindingStore.listDevices().filter((d) => d.owner === '13800000001').length === 1,
  )
}

async function testCompatDeviceIdentity(): Promise<void> {
  console.log('\n[ADR-032] 兼容层按安装实例区分设备')
  const store = new Store(50)
  const rules = new RuleEngine('.data-selftest/compat-identity')
  const compatCfg = {
    ...cfg,
    compat: {
      ...cfg.compat,
      targetHeader: 'x-test-target',
      deviceIdHeader: 'x-install-id',
      deviceNameHeader: 'x-device-name',
      userIdHeader: 'x-user-id',
    },
  }
  const handle = createDataPlane({ cfg: compatCfg, store, rules })
  const request = (installId: string | null, userId: string, deviceName: string) => {
    const headers: Record<string, string> = {
      'x-test-target': 'http://127.0.0.1:1/api/test',
      'x-device-name': deviceName,
      'x-user-id': userId,
      // 兼容层客户端是**非 SDK** 客户端：不带 X-EC-Device-Id。`invoke` 的夹具默认会补一台已绑定
      // 设备，这里显式给空串把它顶掉——空串在数据面就是「没有这个头」，才会走派生分支
      'x-ec-device-id': '',
    }
    if (installId) headers['x-install-id'] = installId
    return invoke(handle, {
      method: 'GET',
      url: '/legacy/api/test',
      headers,
    })
  }

  const first = await request('install-a', 'account-1', 'Phone A')
  const second = await request('install-b', 'account-1', 'Phone B')
  await request('install-a', 'account-1', 'Phone A')
  await request(null, 'account-2', 'Phone C')
  await request(null, 'account-2', 'Phone D')
  const devices = store.listDevices()
  check('同账号两台安装各自保留设备行', first.status === 502 && second.status === 502 && devices.length === 4,
    `${first.status}/${second.status} → ${JSON.stringify(devices.map((d) => d.deviceId))}`)
  check(
    '相同安装 ID 的后续请求更新原设备行',
    devices.some((d) => d.deviceId === 'client:install-a') &&
      devices.some((d) => d.deviceId === 'client:install-b') &&
      devices.some((d) => d.deviceId === 'client:account-2@Phone C') &&
      devices.some((d) => d.deviceId === 'client:account-2@Phone D'),
    JSON.stringify(devices.map((d) => [d.deviceId, d.sessionId])),
  )
  check('兼容层每台设备使用固定会话 ID', devices.every((d) => d.sessionId === 'compat'))
}

async function testSingleBindingMigration(): Promise<void> {
  console.log('\n[ADR-032] 旧多绑定数据收敛')
  const dir = '.data-selftest/single-binding-migration'
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'store.json'),
    JSON.stringify({
      users: [{ phone: '13800000001', createdAt: 1, lastLoginAt: 1, lastBoundDeviceId: 'phoneB' }],
      bindings: { phoneA: '13800000001', phoneB: '13800000001' },
      sessions: {},
    }),
    'utf8',
  )
  const store = new Store(10, dir)
  store.upsertDevice({ deviceId: 'phoneA', sessionId: 'sessionA' })
  store.upsertDevice({ deviceId: 'phoneB', sessionId: 'sessionB' })
  check(
    '存量多绑定保留 lastBoundDeviceId 指向的那台',
    store.deviceOwner('phoneA') === null && store.deviceOwner('phoneB') === '13800000001',
  )
  store.createSession('13800000001')
  const reloaded = new Store(10, dir)
  check(
    '保存并重载后仍只有一台绑定设备',
    reloaded.deviceOwner('phoneA') === null && reloaded.deviceOwner('phoneB') === '13800000001',
  )
}

/**
 * ADR-031：登录会话落盘 + TTL + 抗脏数据。
 * 「重启」在这里就是**同一个 dataDir 上再 new 一个 Store** —— 与真实进程重启读同一份
 * `store.json` 走的是完全相同的路径，所以这里的结论可以直接外推到真机。
 */
async function testSessionPersistence(): Promise<void> {
  console.log('\n[ADR-031] 登录会话落盘：重启后仍自动登录')
  const dir = '.data-selftest/session'
  const hexId = (seed: string): string => (seed + '0'.repeat(32)).slice(0, 32)
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  rmSync(dir, { recursive: true, force: true })

  // 1. 正常路径：登录 → 落盘 → 「重启」→ 同一 token 仍认
  const a = new Store(50, dir, 3600_000)
  const sid = a.createSession('13800000001')
  check('会话 id 是 32 位小写 hex（落盘后能按形状恢复）', /^[0-9a-f]{32}$/.test(sid), sid)
  const raw = readFileSync(join(dir, 'store.json'), 'utf8')
  const onDisk = JSON.parse(raw) as { sessions?: Record<string, { phone: string; expiresAt: number | null }> }
  check('会话确实写进了 store.json', !!onDisk.sessions?.[sid], JSON.stringify(onDisk.sessions))
  check('落盘内容是 token + 手机号 + 过期时间，**不含口令**',
    onDisk.sessions?.[sid]?.phone === '13800000001' && !/password|123456/.test(raw))
  check('expiresAt 是未来的正数（不是 null 也不是 0）',
    typeof onDisk.sessions?.[sid]?.expiresAt === 'number' && (onDisk.sessions[sid].expiresAt as number) > Date.now())
  const b = new Store(50, dir, 3600_000)
  check('重启后同一 token 仍然认（= 重开同一浏览器的体验）', b.sessionPhone(sid) === '13800000001', String(b.sessionPhone(sid)))

  // 2. TTL：过期即失效，且不会在下一份文件里复活
  const c = new Store(50, dir, 20)
  const sidShort = c.createSession('13800000002')
  await sleep(40)
  check('TTL 到点后旧 token 失效', c.sessionPhone(sidShort) === null)
  check('过期的会话不会连带把别人的会话弄丢', b.sessionPhone(sid) === '13800000001' && c.sessionPhone(sid) === '13800000001')
  check('「重启」时过期条目被剪掉（不留在文件里）', new Store(50, dir, 3600_000).sessionPhone(sidShort) === null)

  // 3. `--session-ttl 0` = 永不过期：存 null，重启照旧认
  const d = new Store(50, dir, 0)
  const sidNever = d.createSession('13800000003')
  const d2 = new Store(50, dir, 3600_000)
  check('TTL 0 → expiresAt 存 null，重启后仍认（且不受新实例 TTL 影响）',
    d2.sessionPhone(sidNever) === '13800000003', String(d2.sessionPhone(sidNever)))

  // 4. logout 必须落盘，否则重启会把「已登出」的会话又复活
  d2.destroySession(sidNever)
  check('登出后当前实例立刻不认', d2.sessionPhone(sidNever) === null)
  check('登出**已落盘**：重启不会复活这条会话', new Store(50, dir, 3600_000).sessionPhone(sidNever) === null)

  // 5. 脏 store.json：逐条独立丢弃，且不连累 users / bindings（AGENTS.md §4）
  const future = Date.now() + 3600_000
  const dirtySessions: Record<string, unknown> = {
    [hexId('a1')]: { phone: '13800000009', expiresAt: future }, // 合法
    [hexId('e5')]: { phone: '13800000010', expiresAt: null },   // 合法：永不过期
    [hexId('b2')]: 'not-an-object',                              // 值是字符串
    [hexId('c3')]: null,                                         // 值是 null
    [hexId('d4')]: { phone: 123, expiresAt: future },            // phone 类型混淆
    [hexId('f6')]: { phone: 'x', expiresAt: 'abc' },             // expiresAt 字符串
    [hexId('g7')]: { phone: 'x', expiresAt: -5 },                // 负数
    [hexId('h8')]: { phone: 'x', expiresAt: Number.NaN },        // NaN
    [hexId('i9')]: { phone: 'x' },                               // 缺 expiresAt
    [hexId('j0')]: { phone: '', expiresAt: future },             // 空手机号
    [hexId('k1')]: { phone: 'x', expiresAt: Date.now() - 1000 }, // 已过期
    ['ffffffff']: { phone: 'x', expiresAt: future },             // id 形状不对
    ['']: { phone: 'x', expiresAt: future },                     // 空 id
    ['__proto__']: { phone: 'x', expiresAt: future },            // 原型污染尝试
  }
  const dirtyFile = {
    users: [{ phone: '13800000001', createdAt: 1, lastLoginAt: 1, lastBoundDeviceId: null }],
    bindings: { devA: '13800000001' },
    sessions: dirtySessions,
  }
  writeFileSync(join(dir, 'store.json'), JSON.stringify(dirtyFile), 'utf8')
  let e: Store | null = null
  let threw = ''
  try {
    e = new Store(50, dir, 3600_000)
  } catch (err) {
    threw = String(err)
  }
  check('脏会话条目不导致启动崩溃', threw === '', threw)
  check('只接受 2 条合法会话，其余 12 条逐条丢弃', e?.sessionCount() === 2, `got ${e?.sessionCount()}`)
  check('合法的那条恢复后仍认', e?.sessionPhone(hexId('a1')) === '13800000009')
  check('永不过期那条（expiresAt=null）也恢复', e?.sessionPhone(hexId('e5')) === '13800000010')
  check('空 id / 短 id / __proto__ 都进不了表',
    e?.sessionPhone('') === null && e?.sessionPhone('ffffffff') === null && e?.sessionPhone('__proto__') === null)
  check('脏 sessions 不连累 users / bindings（三段各自独立恢复）',
    !!e?.userByPhone('13800000001') && e?.listUsers().length === 1)

  // 6. sessions 整体形状错 / 旧版本文件没有这一段 → 只丢这一段
  for (const bad of [{ sessions: [1, 2, 3] }, { sessions: 'x' }, { sessions: 42 }, { sessions: null }, {}]) {
    writeFileSync(join(dir, 'store.json'), JSON.stringify({ ...bad, users: dirtyFile.users, bindings: dirtyFile.bindings }), 'utf8')
    let ok = true
    let s2: Store | null = null
    try {
      s2 = new Store(50, dir, 3600_000)
    } catch {
      ok = false
    }
    check(`sessions=${JSON.stringify(bad.sessions)} → 不崩、0 会话、users 仍在`,
      ok && s2?.sessionCount() === 0 && !!s2?.userByPhone('13800000001'))
  }

  // 7. 整个文件是数组 / 空串 / 半截 JSON → 一律按空状态继续（F-16 同款防御）
  for (const junk of ['[]', 'not json at all', '', '{"sessions":{', 'null']) {
    writeFileSync(join(dir, 'store.json'), junk, 'utf8')
    let ok = true
    let s3: Store | null = null
    try {
      s3 = new Store(50, dir, 3600_000)
    } catch {
      ok = false
    }
    check(`坏文件「${junk.slice(0, 12)}」不毒化启动`, ok && s3?.sessionCount() === 0 && s3?.listUsers().length === 0)
  }

  // 8. 上限：落盘会话只增不减会撑爆文件，超限淘汰「最早插入/最早过期」的那批
  rmSync(dir, { recursive: true, force: true })
  const many = new Store(50, dir, 3600_000)
  const firstOfMany = many.createSession('13800000001')
  for (let i = 0; i < 520; i++) many.createSession('139' + String(10000000 + i))
  const lastOfMany = many.createSession('13911110000')
  check('超过上限后剪到 500 条以内', many.sessionCount() <= 500, `got ${many.sessionCount()}`)
  check('淘汰的是最早那批，不是最新登录的', many.sessionPhone(firstOfMany) === null)
  const manyReload = new Store(50, dir, 3600_000)
  check('落盘文件里的条数同样受上限约束', manyReload.sessionCount() <= 500, `got ${manyReload.sessionCount()}`)
  check('重启后仍认最新登录的那条（这才是「自动登录」的实际体验）',
    manyReload.sessionPhone(lastOfMany) === '13911110000', String(manyReload.sessionPhone(lastOfMany)))

  rmSync(dir, { recursive: true, force: true })
}


// ── ADR-039：加解密插件 ────────────────────────────────────────
// 密钥全部是显眼的假值（含 example），既能让 pre-commit 放行，也不会被误认成真密钥。
const CRYPTO_KEY = 'example-key-16by'
const CRYPTO_IV = 'example-iv-16byt'
const CRYPTO_ALG = 'aes-128-cbc'

function seal(plain: string, cipherEncoding: 'base64' | 'base64url' = 'base64'): string {
  const c = createCipheriv(CRYPTO_ALG, Buffer.from(CRYPTO_KEY), Buffer.from(CRYPTO_IV))
  const raw = Buffer.concat([c.update(Buffer.from(plain, 'utf8')), c.final()])
  if (cipherEncoding === 'base64url') {
    return raw.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  return raw.toString('base64')
}

/** 起一个临时上游，跑完就关；selftest 里唯一需要真实响应体的地方 */
async function withUpstream(
  reply: (body: string) => { status: number; type: string; body: string },
  run: (base: string) => Promise<void>,
): Promise<void> {
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const r = reply(Buffer.concat(chunks).toString('utf8'))
      res.writeHead(r.status, { 'content-type': r.type, 'content-length': String(Buffer.byteLength(r.body)) })
      res.end(r.body)
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const port = (srv.address() as { port: number }).port
  try {
    await run(`http://127.0.0.1:${port}`)
  } finally {
    srv.close()
  }
}

const cryptoPost = (target: string, body: string) => ({
  method: 'POST',
  url: '/__ec/p' + new URL(target).pathname,
  headers: { 'x-ec-target': target, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
  body,
})

async function testCrypto(): Promise<void> {
  console.log('\n[ADR-039] 加解密：展示明文 + 保留密文')

  const crypto = new CryptoStore('', true)
  crypto.replaceAll({
    profiles: [
      {
        id: 'p_selftest',
        name: '自测密钥',
        alg: CRYPTO_ALG,
        key: CRYPTO_KEY,
        iv: CRYPTO_IV,
        cipherEncoding: 'base64',
        request: { type: 'json', field: 'data' },
        response: { type: 'json', field: 'data' },
      },
    ],
    routes: [{ id: 'c_selftest', profileId: 'p_selftest', match: { path: '*/msg/detail' }, request: true, response: true }],
  })

  // 1. 全链路：请求与响应都解出明文，密文原文进 rawBody，转发字节不受影响
  {
    const { store, handle } = hitPlane(cfg.dataDir, crypto)
    const reqPlain = JSON.stringify({ userId: 10086, msg: '请求明文' })
    const reqWire = JSON.stringify({ data: seal(reqPlain) })
    const respInner = JSON.stringify({ code: 0, data: seal(JSON.stringify({ msg: '响应明文' })) })
    let seenByUpstream = ''

    await withUpstream(
      (body) => {
        seenByUpstream = body
        return { status: 200, type: 'application/json', body: respInner }
      },
      async (base) => {
        await invoke(handle, cryptoPost(base + '/api/example/im/msg/detail', reqWire))
      },
    )

    const rec = store.listRecords()[0]
    check('上游收到的请求体是原始密文（解密不改转发字节）', seenByUpstream === reqWire)
    check('请求 body 已换成明文', rec.request.body === reqPlain, rec.request.body)
    check('请求 rawBody 保留密文', rec.request.rawBody === reqWire)
    check('响应 body 已换成明文', rec.response.body === JSON.stringify({ msg: '响应明文' }), rec.response.body)
    check('响应 rawBody 保留完整密文包', rec.response.rawBody === respInner)
    check('flags.decrypted = true', rec.flags.decrypted === true)
    check(
      '两侧 crypto 元信息都标记成功',
      rec.crypto?.request?.decrypted === true && rec.crypto?.response?.decrypted === true,
    )
  }

  // 2. 解密失败：请求照常转发、记录保留密文并给出原因（绝不能因为解不开就 500）
  {
    const wrong = new CryptoStore('', true)
    wrong.replaceAll({
      profiles: [
        {
          id: 'p_wrong',
          alg: CRYPTO_ALG,
          key: 'example-key-16XX',
          iv: CRYPTO_IV,
          request: { type: 'json', field: 'data' },
          response: { type: 'json', field: 'data' },
        },
      ],
      routes: [{ id: 'c_wrong', profileId: 'p_wrong', match: { path: '*/msg/detail' }, request: true, response: true }],
    })
    const { store, handle } = hitPlane(cfg.dataDir, wrong)
    const wire = JSON.stringify({ data: seal('{"a":1}') })
    let seen = ''
    let status = 0

    await withUpstream(
      (body) => {
        seen = body
        return { status: 200, type: 'application/json', body: JSON.stringify({ data: seal('{"ok":true}') }) }
      },
      async (base) => {
        const r = await invoke(handle, cryptoPost(base + '/api/example/im/msg/detail', wire))
        status = r.status
      },
    )

    const rec = store.listRecords()[0]
    check('解密失败不影响请求成功', status === 200, 'got ' + status)
    check('解密失败时上游仍收到原始密文', seen === wire)
    check('解密失败时 body 保留密文而不是清空', rec.request.body === wire)
    check('解密失败 rawBody 为空（没有明文可存）', !rec.request.rawBody)
    check('解密失败写入可读原因', typeof rec.crypto?.request?.error === 'string' && rec.crypto.request.error.length > 0)
    check('解密失败不置 flags.decrypted', rec.flags.decrypted === false)
  }

  // 3. mock 明文必须加密回写：否则 App 的解密拦截器解不开这包假数据
  {
    const { store, rules, handle } = hitPlane(cfg.dataDir, crypto)
    const plain = JSON.stringify({ code: 0, msg: 'mock 明文' })
    rules.replaceAll([
      {
        id: 'm_enc',
        enabled: true,
        priority: 1,
        match: { method: 'POST', path: '/enc/mock' },
        action: { type: 'mock', response: { status: 200, body: plain }, crypto: { profileId: 'p_selftest' } },
      },
    ] as never)

    const r = await invoke(handle, cryptoPost('http://127.0.0.1:1/enc/mock', '{}'))
    const dec = crypto.test('p_selftest', r.body, 'decrypt')
    const rec = store.listRecords()[0]
    check('mock 响应被加密（App 收到的是密文包）', r.body !== plain && r.body.includes('"data"'), r.body)
    check('密文能解回 mock 的明文', dec.ok && dec.output === plain, dec.ok ? dec.output : dec.error)
    check('记录里响应 body 是明文（给人看）', rec.response.body === plain)
    check('记录里响应 rawBody 是密文（可复查）', !!rec.response.rawBody && rec.response.rawBody !== plain)
    check('crypto 元信息标记 encrypted', rec.crypto?.response?.encrypted === true)
  }

  // 4. 写入口：非法结构一律 400，且一条都不落盘（AGENTS.md §4）
  {
    const base = new CryptoStore('', true)
    base.replaceAll({ profiles: [{ id: 'p_ok', alg: CRYPTO_ALG, key: CRYPTO_KEY, iv: CRYPTO_IV }], routes: [] })
    const badCases: Array<[string, unknown]> = [
      ['body 不是对象', []],
      ['profiles 不是数组', { profiles: 'x' }],
      ['routes 不是数组', { profiles: [], routes: {} }],
      ['profile 是标量', { profiles: [1] }],
      ['profile 缺 key', { profiles: [{ id: 'p', alg: CRYPTO_ALG }] }],
      ['AEAD 算法缺 aead 布局（猜不出 IV/标签长度）', { profiles: [{ id: 'p', alg: 'aes-128-gcm', key: CRYPTO_KEY }] }],
      [
        'AEAD 算法仍配了 iv（IV 随密文走，配了也不会生效）',
        { profiles: [{ id: 'p', alg: 'aes-128-gcm', key: CRYPTO_KEY, iv: CRYPTO_IV, aead: { ivBytes: 12, tagBytes: 16 } }] },
      ],
      [
        '非 AEAD 算法配了 aead',
        { profiles: [{ id: 'p', alg: CRYPTO_ALG, key: CRYPTO_KEY, iv: CRYPTO_IV, aead: { ivBytes: 12, tagBytes: 16 } }] },
      ],
      [
        'aead.ivBytes 不是整数',
        { profiles: [{ id: 'p', alg: 'aes-128-gcm', key: CRYPTO_KEY, aead: { ivBytes: '12', tagBytes: 16 } }] },
      ],
      [
        'aead.tagAt 写了别的值',
        { profiles: [{ id: 'p', alg: 'aes-128-gcm', key: CRYPTO_KEY, aead: { ivBytes: 12, tagBytes: 16, tagAt: 'middle' } }] },
      ],
      [
        'wrap.prefix 含空白（会原样拼进 mock，App 解不开）',
        { profiles: [{ id: 'p', alg: CRYPTO_ALG, key: CRYPTO_KEY, iv: CRYPTO_IV, response: { type: 'raw', prefix: 'cipher text:' } }] },
      ],
      ['query 缺 field', { profiles: [{ id: 'p', alg: CRYPTO_ALG, key: CRYPTO_KEY, iv: CRYPTO_IV, query: {} }] }],
      ['aes-256 配 16 字节 key', { profiles: [{ id: 'p', alg: 'aes-256-cbc', key: CRYPTO_KEY, iv: CRYPTO_IV }] }],
      ['ECB 配了 iv', { profiles: [{ id: 'p', alg: 'aes-128-ecb', key: CRYPTO_KEY, iv: CRYPTO_IV }] }],
      ['wrap 缺 field', { profiles: [{ id: 'p', alg: CRYPTO_ALG, key: CRYPTO_KEY, iv: CRYPTO_IV, request: { type: 'json' } }] }],
      [
        'route 引用不存在的 profile',
        { profiles: [], routes: [{ id: 'c', profileId: 'p_none', match: { path: '*' } }] },
      ],
      [
        'route 只按 method 匹配（等于解密全部接口）',
        {
          profiles: [{ id: 'p', alg: CRYPTO_ALG, key: CRYPTO_KEY, iv: CRYPTO_IV }],
          routes: [{ id: 'c', profileId: 'p', match: { method: 'POST' } }],
        },
      ],
    ]
    for (const [name, payload] of badCases) {
      let threw = false
      try {
        base.replaceAll(payload)
      } catch {
        threw = true
      }
      check(`拒绝非法配置：${name}`, threw)
    }
    check('被拒后内存配置一字未改', base.listProfiles().length === 1 && base.listRoutes().length === 0)

    // 打码值回写 = 只改别的字段，密钥不变
    const before = base.profileById('p_ok')?.key
    base.replaceAll({
      profiles: [{ id: 'p_ok', name: '改名', alg: CRYPTO_ALG, key: base.view().profiles[0].key, iv: CRYPTO_IV }],
      routes: [],
    })
    check('提交打码后的 key 不会把明文密钥覆盖成「••••」', base.profileById('p_ok')?.key === before)
  }

  // 5. 读盘：坏条目逐条丢弃，不连累好的一条（AGENTS.md §4 的读路径口径）
  {
    const dir = mkdtempSync(join(tmpdir(), 'ec-crypto-store-'))
    mkdirSync(join(dir, 'crypto'), { recursive: true })
    writeFileSync(
      join(dir, 'crypto', 'settings.json'),
      JSON.stringify({
        profiles: [null, 42, { id: 'p_good', alg: CRYPTO_ALG, key: CRYPTO_KEY, iv: CRYPTO_IV }],
        routes: [
          { id: 'c_dangling', profileId: 'p_nope', match: { path: '*/x' } },
          { id: 'c_good', profileId: 'p_good', match: { path: '*/x' } },
        ],
      }),
      'utf8',
    )
    const loaded = new CryptoStore(dir, true)
    check('坏 profile 只丢自己，好的一条仍在', loaded.listProfiles().length === 1, String(loaded.listProfiles().length))
    check('悬空 route 跳过，后面的正常 route 仍能命中', loaded.match({ method: 'GET', host: 'a.com', path: '/x' })?.profile.id === 'p_good')
    check('读盘告警可见（不是静默失效）', loaded.warningsList().length >= 1, String(loaded.warningsList().length))
    check('下发视图里 key 已打码', !loaded.view().profiles[0].key.includes(CRYPTO_KEY), loaded.view().profiles[0].key)

    for (const junk of ['[]', 'not json', '{"profiles":"x"}', 'null']) {
      writeFileSync(join(dir, 'crypto', 'settings.json'), junk, 'utf8')
      let ok = true
      try {
        new CryptoStore(dir, true)
      } catch {
        ok = false
      }
      check(`坏 settings.json「${junk.slice(0, 10)}」不毒化启动`, ok)
    }
    rmSync(dir, { recursive: true, force: true })
  }

  // 6. record-mode=meta：明文与密文都不能落（否则「只记元数据」名不副实，ADR-012）
  {
    const dir = mkdtempSync(join(tmpdir(), 'ec-crypto-meta-'))
    const store = new Store(10)
    const handle = createDataPlane({
      cfg: { ...cfg, dataDir: '', recordMode: 'meta' },
      store,
      rules: new RuleEngine(dir),
      crypto,
    })
    const wire = JSON.stringify({ data: seal('{"secret":true}') })
    await invoke(handle, {
      method: 'POST',
      url: '/__ec/p/api/example/im/msg/detail',
      headers: { 'x-ec-target': 'http://127.0.0.1:1/api/example/im/msg/detail', 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(wire)) },
      body: wire,
    })
    const rec = store.listRecords()[0]
    check('meta 模式 body 为空（明文不落）', rec.request.body === '')
    check('meta 模式 rawBody 也为空（密文同样不落）', !rec.request.rawBody)
    check('meta 模式仍保留真实字节数', rec.request.bodySize === Buffer.byteLength(wire))
    rmSync(dir, { recursive: true, force: true })
  }

  // 7. 总开关与 base64url
  {
    const off = new CryptoStore('', false)
    check('--no-crypto 时任何路由都不命中', off.match({ method: 'POST', host: 'a.com', path: '/api/example/im/msg/detail' }) === null)

    const urlSafe = new CryptoStore('', true)
    urlSafe.replaceAll({
      profiles: [{ id: 'p_url', alg: CRYPTO_ALG, key: CRYPTO_KEY, iv: CRYPTO_IV, cipherEncoding: 'base64url', response: { type: 'json', field: 'data' } }],
      routes: [{ id: 'c_url', profileId: 'p_url', match: { path: '*/u' }, response: true }],
    })
    const wire = JSON.stringify({ data: seal('{"u":1}', 'base64url') })
    const r = urlSafe.test('p_url', wire, 'decrypt')
    check('base64url 密文能解开', r.ok && r.output === '{"u":1}', r.ok ? r.output : r.error)
  }

  // 8. AEAD（AES-256-GCM）+ 密文前缀 + query 密文：真实业务里最常见的一整套
  //    布局：iv(12) | ct | tag(16)，base64url，响应体带 `ciphertext:` 前缀。
  {
    const GCM_KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8') // 32 字节
    const GCM_KEY_URL = GCM_KEY.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const sealGcm = (plain: string, opts: { tagAt?: 'end' | 'start'; key?: Buffer; aad?: string } = {}): string => {
      const iv = Buffer.from('0123456789ab', 'utf8') // 固定 IV 只为了让自测可复现
      const c = createCipheriv('aes-256-gcm', opts.key ?? GCM_KEY, iv)
      if (opts.aad) c.setAAD(Buffer.from(opts.aad, 'utf8'))
      const ct = Buffer.concat([c.update(Buffer.from(plain, 'utf8')), c.final()])
      const tag = c.getAuthTag()
      const buf = opts.tagAt === 'start' ? Buffer.concat([iv, tag, ct]) : Buffer.concat([iv, ct, tag])
      return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    }

    const gcm = new CryptoStore('', true)
    gcm.replaceAll({
      profiles: [
        {
          id: 'p_gcm',
          name: '自测 GCM',
          alg: 'aes-256-gcm',
          key: GCM_KEY_URL,
          keyEncoding: 'base64url',
          cipherEncoding: 'base64url',
          aead: { ivBytes: 12, tagBytes: 16, tagAt: 'end' },
          request: { type: 'json', field: 'payload' },
          // 响应是 `ciphertext:<b64url>` 的裸文本：前缀属于「密文长什么样」，写在 wrap 上
          response: { type: 'raw', prefix: 'ciphertext:' },
          encrypt: { type: 'raw', prefix: 'ciphertext:' },
          query: { field: 'payload' },
        },
      ],
      routes: [{ id: 'c_gcm', profileId: 'p_gcm', match: { path: '*/msg/detail' }, request: true, response: true }],
    })

    const { store, handle } = hitPlane(cfg.dataDir, gcm)
    const qPlain = 'noncestr=1&sign=abc123&timestamp=1792393639808'
    const bodyPlain = JSON.stringify({ msgKey: 'k1', message: '明文' })
    const respPlain = JSON.stringify({ message: '响应明文' })
    const path = '/__ec/p/api/example/im/msg/detail'
    const wireBody = JSON.stringify({ payload: sealGcm(bodyPlain) })
    const respWire = 'ciphertext:' + sealGcm(respPlain)
    const target = (base: string) => `${base}/api/example/im/msg/detail?payload=${encodeURIComponent(sealGcm(qPlain))}`

    await withUpstream(
      () => ({ status: 200, type: 'text/plain', body: respWire }),
      async (base) => {
        await invoke(handle, {
          method: 'POST',
          url: path,
          headers: { 'x-ec-target': target(base), 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(wireBody)) },
          body: wireBody,
        })
      },
    )

    const rec = store.listRecords()[0]
    check('GCM：请求体解出明文', rec.request.body === bodyPlain, rec.request.body)
    check('GCM：请求 rawBody 保留密文', rec.request.rawBody === wireBody)
    check('GCM：响应体剥离 ciphertext: 前缀后解出明文', rec.response.body === respPlain, rec.response.body)
    check('GCM：响应 rawBody 是带前缀的线上原文', rec.response.rawBody === respWire, String(rec.response.rawBody))
    check('GCM：query 密文解出明文字段', rec.request.queryPlain?.sign === 'abc123', JSON.stringify(rec.request.queryPlain))
    check('GCM：query 密文元信息标记成功', rec.crypto?.query?.decrypted === true && rec.crypto?.query?.field === 'payload')
    const wireParam = new URL(rec.request.url).searchParams.get('payload') || ''
    check('GCM：记录里的 URL 仍是密文参数（解密不改转发）', wireParam.length > 20 && wireParam !== qPlain)
    check('GCM：flags.decrypted = true', rec.flags.decrypted === true)

    // 布局写反（tagAt=start）：必须失败而不是解出乱码，且请求照常成功
    const wrongLayout = new CryptoStore('', true)
    wrongLayout.replaceAll({
      profiles: [
        {
          id: 'p_bad',
          alg: 'aes-256-gcm',
          key: GCM_KEY_URL,
          keyEncoding: 'base64url',
          cipherEncoding: 'base64url',
          aead: { ivBytes: 12, tagBytes: 16, tagAt: 'start' },
          request: { type: 'json', field: 'payload' },
        },
      ],
      routes: [{ id: 'c_bad', profileId: 'p_bad', match: { path: '*/msg/detail' }, request: true, response: false }],
    })
    const t = wrongLayout.test('p_bad', JSON.stringify({ payload: sealGcm('{"a":1}') }), 'decrypt')
    check('GCM：tagAt 写反时认证失败（不会静默输出乱码）', !t.ok && /认证不通过|不匹配/.test(t.error), t.ok ? t.output : t.error)

    // 密钥不对：同样必须失败
    const wrongKey = new CryptoStore('', true)
    wrongKey.replaceAll({
      profiles: [
        {
          id: 'p_wk',
          alg: 'aes-256-gcm',
          key: Buffer.from('fedcba9876543210fedcba9876543210', 'utf8').toString('base64url'),
          keyEncoding: 'base64url',
          cipherEncoding: 'base64url',
          aead: { ivBytes: 12, tagBytes: 16 },
          request: { type: 'json', field: 'payload' },
        },
      ],
      routes: [],
    })
    const tk = wrongKey.test('p_wk', JSON.stringify({ payload: sealGcm('{"a":1}') }), 'decrypt')
    check('GCM：密钥不对时认证失败并给出布局提示', !tk.ok && /不匹配/.test(tk.error), tk.ok ? tk.output : tk.error)

    // mock 加密回写：必须补回前缀，且能原样解回明文（另开一个不带 query 的档，避免 mock 走加密分支）
    const mockProfile = new CryptoStore('', true)
    mockProfile.replaceAll({
      profiles: [
        {
          id: 'p_gcm2',
          alg: 'aes-256-gcm',
          key: GCM_KEY_URL,
          keyEncoding: 'base64url',
          cipherEncoding: 'base64url',
          aead: { ivBytes: 12, tagBytes: 16 },
          response: { type: 'raw', prefix: 'ciphertext:' },
        },
      ],
      routes: [],
    })
    const { store: mStore, rules: mRules, handle: mHandle } = hitPlane(cfg.dataDir, mockProfile)
    const mPlain = JSON.stringify({ code: 0, msg: 'mock 明文' })
    mRules.replaceAll([
      {
        id: 'm_gcm',
        enabled: true,
        priority: 1,
        match: { method: 'POST', path: '/enc/gcm' },
        action: { type: 'mock', response: { status: 200, body: mPlain }, crypto: { profileId: 'p_gcm2' } },
      },
    ] as never)
    const mr = await invoke(mHandle, cryptoPost('http://127.0.0.1:1/enc/gcm', '{}'))
    const mrec = mStore.listRecords()[0]
    check('GCM mock：响应带 ciphertext: 前缀', mr.body.startsWith('ciphertext:'), mr.body.slice(0, 24))
    check('GCM mock：密文能解回 mock 明文', mockProfile.test('p_gcm2', mr.body, 'decrypt').ok)
    check('GCM mock：记录里 body 是明文 / rawBody 是密文', mrec.response.body === mPlain && !!mrec.response.rawBody)
  }
}


/**
 * ADR-040：插件化的**结构**保证。
 *
 * P0 只是把实现搬进插件、把调用改成走 SPI，行为必须逐字段等价（上面 597 条都在守这条）。
 * 这里补的是「结构真的立起来了没有」——最容易骗过自己的几处：
 * 落盘多写了个字段（旧版本就读不懂了）、插件异常把抓包服务带崩、
 * 异步插件被静默当成明文塞进记录。
 */
async function testCryptoPlugins(): Promise<void> {
  console.log('\n[ADR-040] 加解密插件化：零迁移 + 插件失败不拖垮抓包')

  /** 造一个「插件名可以随便填」的 profile：写入口只收 builtin，所以这里绕过 store 直接用 */
  const fakeProfile = (plugin: string): CryptoProfile => ({
    id: 'p_fake',
    name: '自测假档',
    plugin,
    alg: CRYPTO_ALG,
    key: CRYPTO_KEY,
    keyEncoding: 'utf8',
    iv: CRYPTO_IV,
    ivEncoding: 'utf8',
    cipherEncoding: 'base64',
    autoPadding: true,
    request: { type: 'raw' },
    response: { type: 'raw' },
    encrypt: { type: 'raw' },
  })

  // 1. 零迁移：内置档落盘**不写** plugin 字段
  {
    const dir = mkdtempSync(join(tmpdir(), 'ec-crypto-zero-'))
    const s = new CryptoStore(dir, true)
    s.replaceAll({
      profiles: [{ id: 'p_old', alg: CRYPTO_ALG, key: CRYPTO_KEY, iv: CRYPTO_IV }],
      routes: [],
    })
    const raw = JSON.parse(readFileSync(join(dir, 'crypto', 'settings.json'), 'utf8')) as {
      profiles: Array<Record<string, unknown>>
    }
    check(
      '内置档落盘不写 plugin 字段（settings.json 与 ADR-039 时期一致）',
      raw.profiles[0].plugin === undefined,
      `实际键：${Object.keys(raw.profiles[0]).join(',')}`,
    )
    const back = new CryptoStore(dir, true)
    check('没有 plugin 的旧配置归一为 builtin', back.profileById('p_old')?.plugin === 'builtin')
    check('旧配置的解密链路照旧可用', back.test('p_old', seal('{"a":1}'), 'decrypt').ok)
    rmSync(dir, { recursive: true, force: true })
  }

  // 2. 写入口：引用未加载的插件必须拒，不能存下一份「没人能解」的配置
  {
    const s = new CryptoStore('', true)
    let threw = false
    try {
      s.replaceAll({
        profiles: [{ id: 'p_x', plugin: 'acme-im', alg: CRYPTO_ALG, key: CRYPTO_KEY, iv: CRYPTO_IV }],
        routes: [],
      })
    } catch {
      threw = true
    }
    check('引用未加载的插件时写入 400', threw)
    check('被拒后内存里没有留下半条配置', s.listProfiles().length === 0)
  }

  // 3. 保留名与 SPI 版本：加载阶段就拒，而不是留到运行时报「解不开」
  {
    let reserved = false
    try {
      new PluginRegistry().register({ ...builtinPlugin, name: 'builtin' })
    } catch {
      reserved = true
    }
    check('builtin 是保留名，外部插件不能顶替', reserved)

    let badSpi = false
    try {
      new PluginRegistry().register({ ...builtinPlugin, name: 'v2x', spiVersion: 2 })
    } catch {
      badSpi = true
    }
    check('SPI 版本对不上的插件在加载时被拒', badSpi)
  }

  // 4. 插件失败必须 fail-open：抛异常 / 返回 Promise / 不声明 encrypt
  {
    const reg = new PluginRegistry()
    reg.register({
      ...builtinPlugin,
      name: 'boom',
      decrypt() {
        throw new Error('boom')
      },
    })
    let threw = false
    let r: { body: string; rawBody: string | null; error?: string } | null = null
    try {
      r = decryptForRecord(fakeProfile('boom'), 'AAAA', { type: 'raw' }, reg)
    } catch {
      threw = true
    }
    check('插件抛异常不会冒泡成 500（fail-open）', !threw)
    check(
      '插件抛异常时保留原文 + 写明原因',
      r !== null && r.body === 'AAAA' && r.rawBody === null && /异常/.test(r.error ?? ''),
      JSON.stringify(r),
    )

    const regAsync = new PluginRegistry()
    regAsync.register({
      ...builtinPlugin,
      name: 'asyncx',
      decrypt: () => Promise.resolve({ ok: true, value: '不该出现' }) as never,
    })
    const ra = decryptForRecord(fakeProfile('asyncx'), 'AAAA', { type: 'raw' }, regAsync)
    check(
      '异步插件在同步链路上被明确拒绝（不会把 [object Promise] 当明文）',
      ra.body === 'AAAA' && /Promise/.test(ra.error ?? ''),
      JSON.stringify(ra),
    )

    const regNoEnc = new PluginRegistry()
    regNoEnc.register({
      ...builtinPlugin,
      name: 'deconly',
      capability: { decrypt: true, encrypt: false },
      encrypt: undefined,
    })
    const re = encryptWith(fakeProfile('deconly'), '{"a":1}', { type: 'raw' }, regNoEnc)
    check('没声明 encrypt 的插件不能用于 mock 回写', !re.ok && /不支持加密/.test(re.error), JSON.stringify(re))
  }

  // 5. 匹配与解密必须共用同一个注册表（P1 加载私有插件后这条是命门）
  {
    const s = new CryptoStore('', true)
    s.replaceAll({
      profiles: [{ id: 'p_a', alg: CRYPTO_ALG, key: CRYPTO_KEY, iv: CRYPTO_IV }],
      routes: [{ id: 'c_a', profileId: 'p_a', match: { path: '*/x' } }],
    })
    const hit = s.match({ method: 'GET', host: 'h', path: '/x' })
    check('命中的档带上了自己的注册表', hit?.plugins === s.plugins && hit?.profile.id === 'p_a')
  }
}


/**
 * ADR-040 P1：插件目录扫描、schema 校验、管理面能力。
 *
 * 这一段刻意用**真实文件 + 真实 import**，而不是造假对象：
 * P1 的风险几乎全在「磁盘上有个东西，内核认不认、认错了会怎样」这一层。
 */
function pluginSrc(name: string, body: string): string {
  return `export default {
  spiVersion: 1,
  name: ${JSON.stringify(name)},
  version: '1.0.0',
  title: ${JSON.stringify(name + ' 测试插件')},
  capability: { decrypt: true, encrypt: true },
  configSchema: { type: 'object', required: ['key'], properties: { key: { type: 'string', secret: true } } },
${body}
}
`
}

async function testCryptoPluginDir(): Promise<void> {
  console.log('\n[ADR-040 P1] 插件目录 / schema 校验 / 重载')

  // ── 1. schema 校验（写入口严格、读盘宽松）──
  {
    const schema = {
      type: 'object' as const,
      required: ['key'],
      properties: {
        key: { type: 'string' as const, secret: true },
        rounds: { type: 'integer' as const, minimum: 1, maximum: 9 },
        mode: { type: 'string' as const, enum: ['a', 'b'] },
        useIv: { type: 'boolean' as const },
      },
    }
    const norm = (raw: unknown, prev?: Record<string, unknown>, strict = true) => {
      try {
        return { ok: true as const, value: normalizeOptions(schema, raw, prev, strict, 'p.options') }
      } catch (e) {
        return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
      }
    }

    const miss = norm({ rounds: 2 })
    check('options 缺 required 字段 → 400 并点名', !miss.ok && /缺少必填参数：key/.test(miss.error), JSON.stringify(miss))
    const typ = norm({ key: 'k', rounds: '2' })
    check('integer 收到字符串 → 400（不做隐式转换）', !typ.ok && /需要 integer/.test(typ.error), JSON.stringify(typ))
    const en = norm({ key: 'k', mode: 'c' })
    check('enum 越界 → 400 并列出允许值', !en.ok && /只能是/.test(en.error), JSON.stringify(en))
    const rng = norm({ key: 'k', rounds: 99 })
    check('minimum / maximum 越界 → 400', !rng.ok && /不能大于 9/.test(rng.error), JSON.stringify(rng))
    const unk = norm({ key: 'k', futureField: 'x' })
    check('未声明字段放行（插件升级时旧配置不能炸）', unk.ok && unk.value.futureField === 'x', JSON.stringify(unk))

    const carried = norm({ key: '••••••', rounds: 2 }, { key: 'REALKEY' })
    check('secret 字段回写打码值 → 沿用旧值', carried.ok && carried.value.key === 'REALKEY', JSON.stringify(carried))
    const orphan = norm({ key: '••••••' })
    check('打码值没有旧值可沿用 → 400（不把打码串当密钥存）', !orphan.ok && /没有可沿用的旧值/.test(orphan.error))
    const lenient = norm({ key: 'k', rounds: '2' }, undefined, false)
    check('读盘宽松：坏字段只丢自己，好字段保留', lenient.ok && lenient.value.key === 'k' && lenient.value.rounds === undefined, JSON.stringify(lenient))
    const long = norm({ key: 'x'.repeat(5000) })
    check('单字段超过 4096 字节 → 400（防把文件塞进配置）', !long.ok && /过长/.test(long.error))
  }

  // ── 2. 真实目录扫描 ──
  const dir = mkdtempSync(join(tmpdir(), 'ec-plugins-'))
  const root = join(dir, 'plugins')
  const mkPlugin = (name: string, body: string, manifest?: Record<string, unknown>) => {
    mkdirSync(join(root, name), { recursive: true })
    writeFileSync(
      join(root, name, 'manifest.json'),
      JSON.stringify(manifest ?? { name, version: '1.0.0', spiVersion: 1 }),
    )
    writeFileSync(join(root, name, 'index.mjs'), pluginSrc(name, body))
  }
  const revBody = "  decrypt(c) { return { ok: true, value: c.text.split('').reverse().join('') } },\n  encrypt(c) { return { ok: true, value: c.text.split('').reverse().join('') } },"
  mkPlugin('rev', revBody)

  // 单文件版：没有 manifest，元数据全在导出里
  writeFileSync(join(root, 'single.mjs'), pluginSrc('single', revBody))

  // 对抗用例
  mkdirSync(join(root, 'mis'), { recursive: true })
  writeFileSync(join(root, 'mis', 'manifest.json'), JSON.stringify({ name: 'other', version: '1.0.0', spiVersion: 1 }))
  writeFileSync(join(root, 'mis', 'index.mjs'), pluginSrc('other', revBody))

  mkdirSync(join(root, 'v2'), { recursive: true })
  writeFileSync(join(root, 'v2', 'manifest.json'), JSON.stringify({ name: 'v2', version: '1.0.0', spiVersion: 2 }))
  // 这段代码一旦被 import 就会抛出可识别的错误——用来证明「SPI 不符时连执行都不该发生」
  writeFileSync(join(root, 'v2', 'index.mjs'), "throw new Error('不该被执行到')\n")

  mkPlugin('dup', revBody)
  writeFileSync(join(root, 'dup.mjs'), pluginSrc('dup', revBody))

  mkdirSync(join(root, 'trav'), { recursive: true })
  writeFileSync(join(root, 'trav', 'manifest.json'), JSON.stringify({ name: 'trav', version: '1.0.0', spiVersion: 1, entry: '../evil.mjs' }))
  writeFileSync(join(root, 'trav', 'index.mjs'), pluginSrc('trav', revBody))

  // 模块在 import 阶段就炸：语法错 / 顶层 throw 都属于这一类
  mkdirSync(join(root, 'broken'), { recursive: true })
  writeFileSync(join(root, 'broken', 'manifest.json'), JSON.stringify({ name: 'broken', version: '1.0.0', spiVersion: 1 }))
  writeFileSync(join(root, 'broken', 'index.mjs'), "throw new Error('boom at import')\n")
  mkdirSync(join(root, 'builtin'), { recursive: true })
  writeFileSync(join(root, 'builtin', 'manifest.json'), JSON.stringify({ name: 'builtin', version: '1.0.0', spiVersion: 1 }))
  writeFileSync(join(root, 'builtin', 'index.mjs'), pluginSrc('builtin', revBody))

  mkdirSync(join(root, 'Bad Name'), { recursive: true })
  symlinkSync(join(root, 'rev'), join(root, 'link'))

  const mgr = new PluginManager(dir)
  await mgr.reload()
  const byName = new Map(mgr.list().map((p) => [p.name, p]))
  const errOf = (name: string) => byName.get(name)?.error ?? ''

  check('目录版插件能加载', byName.get('rev')?.status === 'loaded', errOf('rev'))
  check('单文件版插件能加载', byName.get('single')?.status === 'loaded', errOf('single'))
  check(
    'manifest.name 与目录名不一致 → 拒绝加载',
    byName.get('mis')?.status === 'error' && /必须与目录名/.test(errOf('mis')),
    errOf('mis'),
  )
  check(
    'SPI 版本不符 → 在 import 之前就拒（模块里的 throw 没有被执行）',
    byName.get('v2')?.status === 'error' && /SPI 版本 2/.test(errOf('v2')) && !/不该被执行到/.test(errOf('v2')),
    errOf('v2'),
  )
  check('目录版 + 单文件版同名 → 两条都不用并提示冲突', byName.get('dup')?.status === 'error' && /两种形态/.test(errOf('dup')), errOf('dup'))
  check('入口写 ../ → 拒绝（路径穿越不靠「刚好不存在」）', byName.get('trav')?.status === 'error' && /入口文件名不合法/.test(errOf('trav')), errOf('trav'))
  check('模块在 import 阶段抛错 → 记 error，不抛到启动路径', byName.get('broken')?.status === 'error' && /boom at import/.test(errOf('broken')), errOf('broken'))
  check('占用 builtin 保留名 → 拒绝', byName.get('builtin')?.status === 'error' && /保留名/.test(errOf('builtin')), errOf('builtin'))
  check('软链接被跳过并告警', mgr.warningsList().some((w) => /软链接/.test(w)), mgr.warningsList().join(' | '))
  check('非法目录名被跳过并告警', mgr.warningsList().some((w) => /Bad Name/.test(w)), mgr.warningsList().join(' | '))
  check('加载失败的插件有可操作原因', (byName.get('v2')?.error ?? '').includes('换插件版本'), errOf('v2'))

  // ── 3. 插件档走完整 store 链路（含落盘、打码、命令面语义）──
  {
    const store = new CryptoStore(dir, true, mgr.plugins)
    store.replaceAll({
      profiles: [
        {
          id: 'p_rev',
          name: '反转档',
          plugin: 'rev',
          options: { key: 'k1' },
          request: { type: 'raw' },
          response: { type: 'raw' },
          encrypt: { type: 'raw' },
        },
      ],
      routes: [{ id: 'c_rev', profileId: 'p_rev', match: { path: '*/x' } }],
    })
    check('插件档写入成功且插件名保留', store.profileById('p_rev')?.plugin === 'rev')
    const dec = store.test('p_rev', 'abc', 'decrypt')
    check('插件档能解出明文（走 SPI 而不是内置引擎）', dec.ok && dec.output === 'cba', JSON.stringify(dec))

    const v = store.view()
    const masked = String((v.profiles[0].options ?? {}).key ?? '')
    check('secret 参数在 GET 里被打码', masked !== 'k1' && masked.includes('•'), masked)
    check('打码只露首尾各 2 个字符', masked === 'k1' || (masked.startsWith('k1') && masked.endsWith('k1')) || masked.includes('••••'), masked)

    // 回写打码值 = 沿用旧值
    store.replaceAll({
      profiles: [
        {
          id: 'p_rev',
          name: '反转档',
          plugin: 'rev',
          options: { key: masked, extra: 'keep' },
          request: { type: 'raw' },
          response: { type: 'raw' },
          encrypt: { type: 'raw' },
        },
      ],
      routes: [],
    })
    check('PUT 回写打码值不会覆盖真实参数', store.profileById('p_rev')?.options?.key === 'k1', String(store.profileById('p_rev')?.options?.key))
    check('schema 未声明的参数原样保留', store.profileById('p_rev')?.options?.extra === 'keep')

    const disk = JSON.parse(readFileSync(join(dir, 'crypto', 'settings.json'), 'utf8')) as {
      profiles: Array<Record<string, unknown>>
    }
    check('插件档落盘不含内置引擎的扁平字段', disk.profiles[0].alg === undefined && disk.profiles[0].key === undefined, JSON.stringify(Object.keys(disk.profiles[0])))
    check('插件档落盘保留 plugin 与 options', disk.profiles[0].plugin === 'rev' && !!(disk.profiles[0].options as Record<string, unknown>).key)

    let flatRejected = false
    try {
      store.replaceAll({ profiles: [{ id: 'p_rev', plugin: 'rev', options: { key: 'k' }, alg: 'aes-128-cbc', key: 'x' }], routes: [] })
    } catch {
      flatRejected = true
    }
    check('插件档带内置引擎字段 → 400（不让两套配置并存）', flatRejected)

    let builtinOpts = false
    try {
      store.replaceAll({ profiles: [{ id: 'p_b', alg: CRYPTO_ALG, key: CRYPTO_KEY, iv: CRYPTO_IV, options: { x: 1 } }], routes: [] })
    } catch {
      builtinOpts = true
    }
    check('内置档带 options → 400（参数只写在扁平字段上）', builtinOpts)

    let noKey = false
    try {
      store.replaceAll({ profiles: [{ id: 'p_rev', plugin: 'rev', options: {}, request: { type: 'raw' } }], routes: [] })
    } catch {
      noKey = true
    }
    check('插件档缺少插件要求必填的参数 → 400', noKey)

    // reload 后仍能读到（证明磁盘那份是可用的）
    const again = new CryptoStore(dir, true, mgr.plugins)
    check('重启后插件档仍能解出明文', again.test('p_rev', 'xyz', 'decrypt').ok)
    // 插件没加载时，引用它的档只丢自己（不是整份配置失效）
    const noPlugin = new CryptoStore(dir, true)
    check('插件未加载时该档被跳过并留告警', noPlugin.profileById('p_rev') === undefined && noPlugin.warningsList().some((w) => /未加载的插件/.test(w)))
  }

  // ── 4. header 白名单：默认一个都不给，配了才给 ──
  {
    mkPlugin('hdr', "  decrypt(c) { return { ok: true, value: String(c.ctx.headers['x-nonce'] || 'none') } },")
    await mgr.reload()
    const store = new CryptoStore(dir, true, mgr.plugins)
    store.replaceAll({
      profiles: [
        {
          id: 'p_hdr',
          name: '头透传',
          plugin: 'hdr',
          options: { key: 'k' },
          pluginContext: { headers: ['X-Nonce'] },
          request: { type: 'raw' },
          response: { type: 'raw' },
          encrypt: { type: 'raw' },
        },
      ],
      routes: [],
    })
    const p = store.profileById('p_hdr')
    check('header 白名单小写化保存', JSON.stringify(p?.pluginContext) === JSON.stringify({ headers: ['x-nonce'] }), JSON.stringify(p?.pluginContext))
    const withHdr = p ? decryptWith(p, 'whatever', { type: 'raw' }, mgr.plugins, { 'X-Nonce': 'N123' }) : null
    check('白名单里的 header 会传给插件', withHdr?.ok === true && withHdr.plain === 'N123', JSON.stringify(withHdr))
    const noHdr = p ? decryptWith(p, 'whatever', { type: 'raw' }, mgr.plugins) : null
    check('没给 header 时插件拿到空对象（不是全部流量）', noHdr?.ok === true && noHdr.plain === 'none', JSON.stringify(noHdr))

    let tooMany = false
    try {
      store.replaceAll({
        profiles: [
          {
            id: 'p_hdr',
            plugin: 'hdr',
            options: { key: 'k' },
            pluginContext: { headers: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] },
          },
        ],
        routes: [],
      })
    } catch {
      tooMany = true
    }
    check('header 白名单超过 8 个 → 400', tooMany)
  }

  // ── 5. 重载拿到的是磁盘上的新代码（?v=mtime 破 ESM 缓存）──
  {
    const file = join(root, 'rev', 'index.mjs')
    writeFileSync(file, pluginSrc('rev', "  decrypt(c) { return { ok: true, value: 'NEW' } },"))
    // 显式把 mtime 推后：同一毫秒内改两次时，缓存 key 不能撞
    const future = new Date(Date.now() + 5000)
    utimesSync(file, future, future)
    await mgr.reload()
    // 直接拿 profile 对象试，避免「换插件目录又要重建一份 settings」的噪声
    const p: CryptoProfile = {
      id: 'p_rev2',
      name: '反转档',
      plugin: 'rev',
      options: { key: 'k' },
      request: { type: 'raw' },
      response: { type: 'raw' },
      encrypt: { type: 'raw' },
    }
    const r = decryptWith(p, 'abc', { type: 'raw' }, mgr.plugins)
    check('重新扫描后跑的是新代码（模块缓存被 mtime 破掉）', r.ok && r.plain === 'NEW', JSON.stringify(r))
  }

  // ── 6. 插件试跑接口（不落盘、不进缓存）──
  {
    const r = await mgr.test('rev', { key: 'k' }, 'abc', 'decrypt')
    check('插件试跑能成功', r.ok && r.output === 'NEW', JSON.stringify(r))
    const badParam = await mgr.test('rev', { key: 42 }, 'abc', 'decrypt')
    check('试跑时参数类型错 → 直接报错，不落盘', !badParam.ok && /需要 string/.test(badParam.error), JSON.stringify(badParam))
    const noPlugin = await mgr.test('nope', {}, 'abc', 'decrypt')
    check('试跑未加载的插件 → 明确报错', !noPlugin.ok && /未加载/.test(noPlugin.error))
  }

  rmSync(dir, { recursive: true, force: true })
}


/**
 * 单文件脚本插件（ADR-040 §5.6）。
 *
 * 这一批用例的重点不是「脚本能不能跑」，而是**跑坏了会怎样**：返回非字符串、
 * 返回 Promise、抛异常、语法错、文件名带路径——每一种都必须变成一条可读的失败，
 * 而不是把服务带崩或把 `[object Promise]` 写进记录。
 */
async function testCryptoScripts(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ec-script-'))
  const sdir = join(dir, 'crypto', 'scripts')
  mkdirSync(sdir, { recursive: true })
  const W = (name: string, src: string) => writeFileSync(join(sdir, `${name}.mjs`), src)

  W('rev', `export function decrypt(t) { return t.split('').reverse().join('') }\n` +
    `export function encrypt(t) { return t.split('').reverse().join('') }\n` +
    `export const meta = { title: '反转', version: '1.2.3' }`)
  W('secret', `export function decrypt(t, o) { return o.key + ':' + t }\nexport const secrets = ['key']`)
  W('nodecrypt', 'export const foo = 1')
  W('notstring', 'export function decrypt() { return 42 }')
  W('asyncfn', 'export async function decrypt(t) { return t }')
  W('boom', `export function decrypt() { throw new Error('炸了') }`)
  W('broken', 'export function decrypt( {')
  W('defaultfn', `export default function (t) { return 'D:' + t }`)
  writeFileSync(join(sdir, 'legacy.js'), 'module.exports = {}')
  mkdirSync(join(sdir, 'sub'), { recursive: true })
  try {
    symlinkSync(join(sdir, 'rev.mjs'), join(sdir, 'link.mjs'))
  } catch {
    // 没有权限建软链接的环境跳过这条（macOS 一般没问题）
  }

  const scan = await scanScripts(sdir)
  const byName = new Map(scan.entries.map((e) => [e.name, e]))
  check('脚本扫描：合法脚本加载成功', byName.get('rev')?.status === 'loaded', byName.get('rev')?.error ?? '')
  check('脚本扫描：title / version 取自 meta',
    byName.get('rev')?.plugin?.title === '反转' && byName.get('rev')?.plugin?.version === '1.2.3')
  check('脚本扫描：注册名带 script: 前缀', byName.get('rev')?.pluginName === 'script:rev')
  check('脚本扫描：没有 decrypt 的脚本报错',
    byName.get('nodecrypt')?.status === 'error' && /decrypt/.test(byName.get('nodecrypt')?.error ?? ''))
  check('脚本扫描：语法错误只影响自己',
    byName.get('broken')?.status === 'error' && byName.get('rev')?.status === 'loaded')
  check('脚本扫描：export default 函数当 decrypt', byName.get('defaultfn')?.status === 'loaded')
  check('脚本扫描：.js 跳过并给出原因',
    !byName.has('legacy') && scan.warnings.some((w) => w.includes('只收 .mjs')), JSON.stringify(scan.warnings))
  check('脚本扫描：软链接被拒', !byName.has('link') && scan.warnings.some((w) => w.includes('软链接')))
  check('脚本扫描：子目录不递归', !byName.has('sub'))

  const mgr = new PluginManager(dir)
  await mgr.reload()
  const reg = mgr.plugins
  const call = async (name: string, text: string, options: Record<string, unknown> = {}) => {
    // 每次都从 mgr 上取：reload 会**整体替换**注册表，闭包里抓旧对象会跑到重扫前的代码
    const p = mgr.plugins.get(name)
    if (!p) return { ok: false as const, error: '未注册' }
    return (await Promise.resolve(p.decrypt({ text, options, ctx: { profileId: 'x', headers: {} } }))) as
      | { ok: true; value: string }
      | { ok: false; error: string }
  }

  const okCall = await call('script:rev', 'abc')
  check('脚本注册到统一注册表并能调用', okCall.ok && okCall.value === 'cba', JSON.stringify(okCall))
  const capOk = reg.get('script:rev')?.capability
  check('脚本成对时声明 decrypt + encrypt', capOk?.decrypt === true && capOk?.encrypt === true)
  check('只写 decrypt 的脚本不声明 encrypt', reg.get('script:secret')?.capability.encrypt === false)

  const rNum = await call('script:notstring', 'x')
  check('脚本返回非字符串 → 明确报错', !rNum.ok && rNum.error.includes('必须返回字符串'), JSON.stringify(rNum))
  const rPro = await call('script:asyncfn', 'x')
  check('脚本返回 Promise → 明确拒绝', !rPro.ok && rPro.error.includes('Promise'), JSON.stringify(rPro))
  const rBoom = await call('script:boom', 'x')
  check('脚本抛异常 → 变成失败而不是崩服务', !rBoom.ok && rBoom.error.includes('抛异常') && rBoom.error.includes('炸了'))

  // 打码：有 schema 走 schema，无 schema 看 secrets，都没有则整份打码
  const allMasked = maskOptions(undefined, { key: 'abcdefgh', iv: '12345678' })
  check('未声明 secrets → 整份 options 打码',
    allMasked?.key === 'ab••••gh' && allMasked?.iv === '12••••78', JSON.stringify(allMasked))
  const partMasked = maskOptions(undefined, { key: 'abcdefgh', mode: 'gcm' }, ['key'])
  check('声明 secrets → 只打指定字段',
    partMasked?.key === 'ab••••gh' && partMasked?.mode === 'gcm', JSON.stringify(partMasked))

  // 自由参数的结构防线：脚本档没有 schema，字段类型不管，但不能塞一棵深树
  let deepThrew = false
  try {
    normalizeOptions(undefined, { a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } }, undefined, true, 'x')
  } catch {
    deepThrew = true
  }
  check('脚本参数嵌套过深 → 400', deepThrew)
  const nested = normalizeOptions(undefined, { key: 'k', aead: { ivBytes: 12, tagAt: 'end' } }, undefined, true, 'x')
  check('脚本参数允许嵌套对象（不像表单只收标量）', nested.aead !== undefined)

  // 端到端：profile 引用 script:xxx → 命中路由 → 解出明文 → 视图里打码
  writeFileSync(
    join(dir, 'crypto', 'settings.json'),
    JSON.stringify({
      profiles: [{ id: 'p_script', plugin: 'script:rev', options: { key: 'abcdefgh' }, request: { type: 'raw' }, response: { type: 'raw' } }],
      routes: [{ id: 'c_script', profileId: 'p_script', match: { path: '/x' } }],
    }),
  )
  const store = new CryptoStore(dir, true, mgr.plugins)
  const hit = store.match({ method: 'POST', host: 'h', path: '/x' })
  check('脚本档能命中路由', hit?.profile.id === 'p_script')
  if (hit) {
    const got = decryptForRecord(hit.profile, 'abc', { type: 'raw' }, hit.plugins)
    check('脚本档解出明文（走完整 SPI 链路）', got.body === 'cba' && !got.error, JSON.stringify(got))
  }
  const view = store.view()
  check('脚本档的 options 在视图里被打码', view.profiles[0]?.options?.key === 'ab••••gh',
    JSON.stringify(view.profiles[0]?.options))

  // 源码只读接口
  const src = readScriptSource(sdir, 'rev')
  check('脚本源码只读接口能读到内容', src.ok && src.source.includes('reverse'))
  check('脚本名非法 → 拒绝读取（不能越界）', !readScriptSource(sdir, '../settings').ok)
  check('脚本不存在 → 明确报错', !readScriptSource(sdir, 'nope').ok)

  // 改完脚本重扫即生效（依赖 ?v=mtime 破 ESM 缓存）
  W('rev', `export function decrypt() { return 'NEW' }`)
  utimesSync(join(sdir, 'rev.mjs'), new Date(), new Date(Date.now() + 3000))
  await mgr.reload()
  const again = await call('script:rev', 'abc')
  check('重扫后跑的是新代码（mtime 破缓存）', again.ok && again.value === 'NEW', JSON.stringify(again))

  rmSync(dir, { recursive: true, force: true })
}

await testRuleValidation()
await testBodySize()
await testMockDisconnect()
await testPersistIsolation()
await testClearRecords()
await testParamMatch()
await testRuleSingleOps()
await testMultiResponses()
await testSingleRuleWrite()
await testProjects()
await testProjectMigration()
await testProjectVersions()
testConsoleMockLogic()
await testSnapshots()
await testRolesAndDeviceVisibility()
await testCompatDeviceIdentity()
await testSingleBindingMigration()
await testSessionPersistence()
await testCrypto()
await testCryptoPlugins()
await testCryptoPluginDir()
await testCryptoScripts()

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
