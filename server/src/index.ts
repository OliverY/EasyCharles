import http from 'node:http'
import { networkInterfaces } from 'node:os'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, printBanner, roleOf } from './config.ts'
import { Store } from './store.ts'
import { RuleEngine } from './rules.ts'
import { GroupStore } from './groups.ts'
import { LEGACY_SHARED_NAME, ProjectService, migrateProjects, maskPhone } from './projects.ts'
import { ecBody, projectReadonly } from './ec-error.ts'
import { SnapshotStore } from './snapshots.ts'
import { createDataPlane } from './data-plane.ts'
import { createControlPlane } from './control-plane.ts'
import { CryptoStore, PluginManager } from './crypto/index.ts'
import { PROTOCOL_VERSION } from './types.ts'
import type { ConsoleUser, DeviceIdentity, Group, GroupView, Rule, User } from './types.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const cfg = loadConfig()
const store = new Store(cfg.maxRecords, cfg.dataDir, cfg.sessionTtlMs)
// 分组表必须先建：RuleEngine 要拿**同一个实例**去判「这条规则属于谁的私有项目」（C14 / ADR-033）。
// 各建一份的话，管理面改组只写进 GroupStore 那份内存，数据面看到的还是旧的——
// 且不报错（resolve 只读自己那份），正是最难查的那类静默失效。
const groups = new GroupStore(cfg.dataDir)
const rules = new RuleEngine(cfg.dataDir, groups)
// 版本服务（copy / share / rollback + pending journal）：它直接操作上面那两份内存状态，
// 所以必须在两者之后建、在对外服务之前跑一次 `recover()`
const projects = new ProjectService(cfg.dataDir, groups, rules)
const snapshots = new SnapshotStore(cfg.dataDir, cfg.snapshotTtlMs, cfg.snapshotMax)
// 加解密（ADR-039 / ADR-040）：密钥档在 `.data/crypto/settings.json`，
// 私有插件在 `.data/plugins/`——**两者都不进仓库、不进发布包**。
// 插件扫描必须在 CryptoStore 之前：profile 的 options 归一化要用插件自带的 configSchema，
// 顺序反过来会得到「插件还没加载 → 引用它的 profile 全被丢弃」。
const pluginManager = new PluginManager(cfg.dataDir)
await pluginManager.reload()
const crypto = new CryptoStore(cfg.dataDir, cfg.cryptoEnabled, pluginManager.plugins)
const handleDataPlane = createDataPlane({ cfg, store, rules, crypto })
for (const w of pluginManager.warningsList()) console.warn(`[crypto] 插件：${w}`)
for (const w of crypto.warningsList()) console.warn(`[crypto] ${w}`)

const SERVER_VERSION = '0.1.0'
const STARTED_AT = Date.now()

/**
 * 角色是**读取时**按启动参数算出来的，不落盘（ADR-018）。
 * 唯一真值来源是 `--admin`，所以不存在「库里存了旧角色」的第二真值来源。
 */
function withRole(user: User): ConsoleUser {
  return { ...user, role: roleOf(cfg, user.phone) }
}

function lanAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address)
    }
  }
  return out
}

/**
 * 快照链接候选（ADR-017）。第一个是**推荐分享**的那条：
 * LAN 模式下优先内网 IP（同事才打得开），否则回退到请求 Host。
 * 请求 Host 可能被伪造，但快照链接只是「可读能力 URL」，伪造它不产生权限提升。
 */
function snapshotUrls(token: string, req: http.IncomingMessage): string[] {
  const out: string[] = []
  if (cfg.lanMode) for (const ip of lanAddresses()) out.push(`http://${ip}:${cfg.port}/s/${token}`)
  const host = req.headers.host ?? `127.0.0.1:${cfg.port}`
  out.push(`http://${host}/s/${token}`)
  return out
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  const buf = Buffer.from(JSON.stringify(data), 'utf8')
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(buf.length) })
  res.end(buf)
}

/**
 * 单条规则「读不到也改不了」的响应（C14）。
 * id 不存在**与**它属于别人的私有项目走同一句 body：用 403 或不同文案回答，
 * 就等于替调用方确认「这个 id 确实存在、只是不是你的」（协议 §4.7 权限矩阵最后一条）。
 */
function ruleNotYours(res: http.ServerResponse, id: string): void {
  json(res, 404, { error: 'EC_PROJECT_NOT_FOUND', message: `rule not found or not in your private projects: ${id}` })
}

/**
 * 下发给客户端的项目视图：`ruleCount` + **别人的手机号一律脱敏**。
 *
 * `shared.createdBy` 是「第一个把这套规则分享出来的人」，属于**跨用户**数据；
 * 只要下发过全号，日志与前端总有漏出去的一天（计划 §10「分享人/创建人手机号默认脱敏」）。
 * 自己的私有项目回自己的号码——那是调用者本来就有的信息，不构成泄露。
 */
function toGroupView(group: Group, phone: string): GroupView {
  return {
    ...group,
    createdBy: group.createdBy && group.createdBy !== phone ? maskPhone(group.createdBy) : group.createdBy,
    ruleCount: rules.countByGroup(group.id),
  }
}

function readJson(req: http.IncomingMessage, limit = 1024 * 1024): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let oversize = false
    req.on('data', (c: Buffer) => {
      total += c.length
      if (total <= limit) chunks.push(c)
      else oversize = true
    })
    req.on('end', () => {
      // F-10：控制面/管理面 body 设大小上限，防 LAN 下被灌大请求
      if (oversize) return reject(Object.assign(new Error('request body too large'), { statusCode: 413 }))
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>)
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

// 控制台 API 登录会话鉴权：除 /__ec/api/login 外都需要已登录会话
function sessionPhone(req: http.IncomingMessage): string | null {
  return store.sessionPhone(String(req.headers['x-ec-session'] ?? ''))
}

const server = http.createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const p = url.pathname

    try {
      // ── 握手 ──
      if (p === '/__ec/hello' && req.method === 'POST') {
        const body = await readJson(req)
        const identity = body.identity as DeviceIdentity | undefined
        if (!identity?.deviceId) return json(res, 400, { error: 'missing identity' })
        store.upsertDevice(identity)
        // F-08：wsUrl 按请求 Host 生成（adb reverse 走回环，WiFi 走内网 IP），不再用 cfg.host
        const host = req.headers.host ?? (cfg.host === '0.0.0.0' ? lanAddresses()[0] ?? '127.0.0.1' : cfg.host)
        return json(res, 200, {
          protocol: PROTOCOL_VERSION,
          serverId: 'srv_local',
          serverVersion: SERVER_VERSION,
          wsUrl: `ws://${host}/__ec/ws`,
          config: {
            recordMode: cfg.recordMode,
            maxBufferBytes: cfg.maxBufferBytes,
            sampleBytes: cfg.sampleBytes,
            heartbeatMs: cfg.heartbeatMs,
          },
        })
      }

      // ── 快照面（只读 · 免鉴权，ADR-017）──
      // 能力 URL：持有 token 即可读。本面**只有 GET**、不转发任何请求，因此不能当代理用，
      // 不放大 ADR-015「数据面不鉴权」那条风险边界。
      if (p.startsWith('/__ec/s/') && req.method === 'GET') {
        const snap = snapshots.get(p.slice('/__ec/s/'.length))
        if (!snap) return json(res, 404, { error: 'EC_SNAPSHOT_NOT_FOUND', message: 'snapshot not found or expired' })
        // 只回排障所需字段：不带 createdBy（手机号不进免鉴权页面）
        const buf = Buffer.from(
          JSON.stringify({
            token: snap.token,
            createdAt: snap.createdAt,
            expiresAt: snap.expiresAt,
            title: snap.title,
            record: snap.record,
          }),
          'utf8',
        )
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': String(buf.length),
          'cache-control': 'no-store',
          'x-robots-tag': 'noindex, nofollow',
          'referrer-policy': 'no-referrer',
        })
        res.end(buf)
        return
      }

      // ── 控制台 API ──
      if (p.startsWith('/__ec/api/')) {
        // 登录（首次登录自动注册手机号空间）；口令默认 123456，--password 可改
        if (p === '/__ec/api/login' && req.method === 'POST') {
          const body = await readJson(req)
          const phone = String(body.phone ?? '').trim()
          if (!phone) return json(res, 400, { error: 'missing phone' })
          if (String(body.password ?? '') !== cfg.password) {
            return json(res, 401, { error: 'EC_UNAUTHORIZED', message: 'invalid password' })
          }
          const session = store.createSession(phone)
          const user = store.userByPhone(phone)
          return json(res, 200, { session, user: user ? withRole(user) : null })
        }

        // 其余 API 需要登录会话
        const phone = sessionPhone(req)
        if (!phone) return json(res, 401, { error: 'EC_UNAUTHORIZED', message: 'need login' })

        // ── 管理面 /__ec/api/admin/*：除会话外**还需 role=admin**（ADR-018）──
        // 前端隐藏入口只是 UX；这里才是强制点，curl 带上会话同样进不来。
        if (p.startsWith('/__ec/api/admin/')) {
          if (roleOf(cfg, phone) !== 'admin') {
            return json(res, 403, { error: 'EC_UNAUTHORIZED', message: 'admin only' })
          }
          // 全局统计 + 统一配置 + 用户空间列表。全局量只在这里下发（info 已不再带 stats）。
          if (p === '/__ec/api/admin/overview' && req.method === 'GET') {
            return json(res, 200, {
              server: {
                version: SERVER_VERSION,
                protocol: PROTOCOL_VERSION,
                uptimeMs: Date.now() - STARTED_AT,
              },
              // 当前生效的全局配置（只读展示）。全部来自启动参数，进程内不可变；
              // 「管理员在控制台改配置」是另一件事（需要引入运行时可变配置 + 落盘），见 ADR-018。
              config: {
                host: cfg.host,
                port: cfg.port,
                lanMode: cfg.lanMode,
                lanAddresses: lanAddresses(),
                recordMode: cfg.recordMode,
                maxRecords: cfg.maxRecords,
                maxBufferBytes: cfg.maxBufferBytes,
                sampleBytes: cfg.sampleBytes,
                upstreamTimeoutMs: cfg.upstreamTimeoutMs,
                heartbeatMs: cfg.heartbeatMs,
                snapshotTtlMs: cfg.snapshotTtlMs,
                sessionTtlMs: cfg.sessionTtlMs,
                snapshotMax: cfg.snapshotMax,
                adminPhones: cfg.adminPhones,
                compatRoutes: cfg.compat.routes,
                compatAppId: cfg.compat.routes.length ? cfg.compat.appId : null,
                dataDir: cfg.dataDir,
              },
              stats: store.stats(),
              snapshots: { count: snapshots.count() },
              rules: { count: rules.list().length },
              // 项目盘账（C14）：私有/共享各多少、历史实际占了多少字节。
              // 历史默认**无限保留**（ADR-033），所以容量必须看得见——旧版本会长期
              // 留着后来删掉的 response body（可能是 token / cookie / 个人数据）
              projects: {
                private: groups.list().filter((g) => g.scope === 'private').length,
                shared: groups.list().filter((g) => g.scope === 'shared').length,
                ownerless: groups.list().filter((g) => g.scope === 'private' && !g.ownerPhone).length,
                storage: projects.storageUsage(),
              },
              spaces: store.listSpaces(),
            })
          }
          return json(res, 404, { error: 'unknown api' })
        }

        if (p === '/__ec/api/logout' && req.method === 'POST') {
          store.destroySession(String(req.headers['x-ec-session'] ?? ''))
          return json(res, 200, { ok: true })
        }
        if (p === '/__ec/api/me') {
          const user = store.userByPhone(phone)
          if (!user) return json(res, 401, { error: 'EC_UNAUTHORIZED', message: 'need login' })
          return json(res, 200, { user: withRole(user) })
        }
        if (p === '/__ec/api/info') {
          // 只回服务端信息；**全局统计与快照总数不在这里**（ADR-018，见 /admin/overview）
          return json(res, 200, {
            protocol: PROTOCOL_VERSION,
            serverVersion: SERVER_VERSION,
            host: cfg.host,
            port: cfg.port,
            lanMode: cfg.lanMode,
            lanAddresses: lanAddresses(),
            recordMode: cfg.recordMode,
            snapshotTtlMs: cfg.snapshotTtlMs,
            sessionTtlMs: cfg.sessionTtlMs,
          })
        }
        if (p === '/__ec/api/records') {
          if (req.method === 'DELETE') {
            // 清空「当前用户空间 ∩ 当前筛选」的记录：owner 恒为会话手机号，
            // deviceId / q 可选（与列表查询同源），避免误删他人空间或未展示的记录
            const cleared = store.clearRecords({
              owner: phone,
              deviceId: url.searchParams.get('deviceId') ?? undefined,
              q: url.searchParams.get('q') ?? undefined,
            })
            return json(res, 200, { ok: true, cleared })
          }
          // F-10：limit 数值化校验，非法值回退默认 300
          const limitRaw = Number(url.searchParams.get('limit') ?? 300)
          const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 1000) : 300
          // 用户空间：默认只返回该用户绑定设备的记录（owner=phone 服务端过滤）
          return json(
            res,
            200,
            store.listRecords({
              limit,
              deviceId: url.searchParams.get('deviceId') ?? undefined,
              q: url.searchParams.get('q') ?? undefined,
              owner: phone,
            }),
          )
        }
        if (p.startsWith('/__ec/api/records/')) {
          const id = p.slice('/__ec/api/records/'.length)
          const rec = store.getRecord(id)
          return rec && store.recordVisible(rec.deviceId, phone)
            ? json(res, 200, rec)
            : json(res, 404, { error: 'not found' })
        }
        // 设备可见性（ADR-018）：普通用户 = 自己绑定的 + 未绑定的（可认领）；admin = 全量
        if (p === '/__ec/api/devices') {
          return json(res, 200, roleOf(cfg, phone) === 'admin' ? store.listDevices() : store.listDevicesFor(phone))
        }
        if (p.startsWith('/__ec/api/devices/') && req.method === 'POST') {
          const rest = p.slice('/__ec/api/devices/'.length)
          let did: string | null = null
          let action: 'bind' | 'unbind' | null = null
          if (rest.endsWith('/bind')) {
            did = rest.slice(0, -'/bind'.length)
            action = 'bind'
          } else if (rest.endsWith('/unbind')) {
            did = rest.slice(0, -'/unbind'.length)
            action = 'unbind'
          }
          if (did && action) {
            try {
              const deviceId = decodeURIComponent(did)
              // bind 现在会带回「被自动解绑的其它设备」（一次只绑一台，ADR-032）
              const result =
                action === 'bind'
                  ? store.bindDevice(phone, deviceId)
                  : { ok: store.unbindDevice(phone, deviceId), unbound: [] as string[] }
              return json(res, 200, result)
            } catch {
              return json(res, 400, { error: 'bad device id' })
            }
          }
        }
        // ── 加解密（ADR-039 / ADR-040）──
        // 实例级配置：密钥档与路由对所有登录用户共享（与设备绑定同级）。
        // **GET 永远只下发打码后的 key/iv/secret 参数**——明文密钥没有任何出服务的路径，
        // 这也是「配了密钥不等于泄露了密钥」这条设计承诺的技术实现。
        //
        // 插件管理（ADR-040 §7.1）：三条端点都在这里，**不做上传安装**——
        // 装插件 = 把目录拷进 `<dataDir>/plugins/` 再点重扫。LAN 模式下管理面任何持
        // token 的客户端都能调，上传 zip 等于主动开一个远程代码执行入口。
        if (p === '/__ec/api/crypto/plugins' && req.method === 'GET') {
          return json(res, 200, {
            enabled: cfg.cryptoEnabled,
            dir: pluginManager.rootDir(),
            dirExists: pluginManager.dirExists(),
            scriptDir: pluginManager.scriptDir(),
            scriptDirExists: pluginManager.scriptDirExists(),
            plugins: pluginManager.list(crypto.pluginUsage()),
            warnings: pluginManager.warningsList(),
          })
        }
        // 脚本源码只读展示（ADR-040 §5.6）：**故意没有 PUT**。
        // 能在控制台里写 .mjs = 持管理 token 就能执行任意代码，LAN 模式下等于 RCE 入口。
        // 改代码只能在本机编辑 `<dataDir>/crypto/scripts/xxx.mjs`，再点「重新扫描插件」。
        if (p.startsWith('/__ec/api/crypto/scripts/') && req.method === 'GET') {
          const name = decodeURIComponent(p.slice('/__ec/api/crypto/scripts/'.length))
          const r = pluginManager.scriptSource(name)
          if (!r.ok) return json(res, 404, { ok: false, error: r.error })
          return json(res, 200, { ok: true, name, source: r.source })
        }
        if (p === '/__ec/api/crypto/plugins/reload' && req.method === 'POST') {
          // 顺序不能反：先换注册表，再按新 schema 重读 profile。反过来会在重读时
          // 仍用旧注册表，于是「刚装上的插件」被判定为未加载、profile 被整条丢弃
          await pluginManager.reload()
          crypto.setPlugins(pluginManager.plugins)
          crypto.reload()
          return json(res, 200, {
            ok: true,
            warnings: [...pluginManager.warningsList(), ...crypto.warningsList()],
            plugins: pluginManager.list(crypto.pluginUsage()),
            ...crypto.view(),
          })
        }
        if (p === '/__ec/api/crypto/plugins/test' && req.method === 'POST') {
          const body = await readJson(req)
          // 试跑**不落盘、不进缓存**：只验证「这套参数在这台机器上通不通」
          const r = await pluginManager.test(
            String(body.plugin ?? ''),
            body.options,
            String(body.text ?? ''),
            body.mode === 'encrypt' ? 'encrypt' : 'decrypt',
          )
          return json(res, r.ok ? 200 : 400, r.ok ? { ok: true, output: r.output } : { ok: false, error: r.error })
        }
        if (p === '/__ec/api/crypto') {
          if (req.method === 'GET') return json(res, 200, crypto.view())
          if (req.method === 'PUT') {
            if (!cfg.cryptoEnabled) {
              return json(res, 409, { error: 'EC_CRYPTO_DISABLED', message: '服务以 --no-crypto 启动，保存后也不会生效' })
            }
            const body = await readJson(req)
            return json(res, 200, crypto.replaceAll(body))
          }
          return json(res, 405, { error: 'method not allowed' })
        }
        // 「这段密文到底能不能解开」的自检：不落盘、不改内存，只回结果
        if (p === '/__ec/api/crypto/test' && req.method === 'POST') {
          const body = await readJson(req)
          const mode = body.mode === 'encrypt' ? 'encrypt' : 'decrypt'
          const r = crypto.test(String(body.profileId ?? ''), String(body.text ?? ''), mode)
          return json(res, r.ok ? 200 : 400, r.ok ? { ok: true, output: r.output } : { ok: false, error: r.error })
        }
        // 手改了 settings.json 后不必重启服务
        if (p === '/__ec/api/crypto/reload' && req.method === 'POST') {
          crypto.reload()
          return json(res, 200, { ok: true, warnings: crypto.warningsList(), ...crypto.view() })
        }
        // ── 规则（C14 / ADR-033 收窄）──
        // 这个面上的读写范围**只到调用者自己的私有项目**（协议 §4.7 权限矩阵）。
        // 共享规则一律经 `/groups/:id/rules` 按项目读，写只能经 copy → 编辑 → share 那条路，
        // 于是这里既不存在「一次拿到全服所有返回值」的入口，也不存在全表覆盖 `rules.json` 的入口。
        if (p === '/__ec/api/rules') {
          if (req.method === 'PUT') {
            const body = await readJson(req)
            // replacePrivateScope 逐条查归属并先校验结构：无 groupId / 指向他人或共享项目 /
            // 重复 id → 400 EC_SCOPE_MISMATCH 且**一条也不写**（F-15 那道防线，只是现在多了归属这一维）
            const done = rules.replacePrivateScope(body.rules, phone)
            return json(res, 200, { ok: true, ...done, count: rules.list().length })
          }
          // 单条新建（ADR-028）：id 由服务端生成，绕过「整表 PUT」的覆盖事故
          if (req.method === 'POST') {
            const body = await readJson(req)
            const rule = rules.create(body.rule, phone)
            return json(res, 200, { ok: true, rule })
          }
          return json(res, 200, rules.listForOwner(phone))
        }
        if (p === '/__ec/api/rules/reset-pointers' && req.method === 'POST') {
          // 只清调用者私有规则的指针（旧的「一键清全服」在隔离之后就是越权）；
          // 回传条数让控制台能区分「我本来就没规则」和「清了 N 条」
          return json(res, 200, { ok: true, clearedFor: rules.resetPointers(phone) })
        }
        // ── 单条规则：删除 / 开/关（ADR-019）、整条替换（ADR-028）──
        // 列表里点一下就动这一条，不再走「整表 PUT 覆盖」——后者在多开控制台时会把
        // 别人改的其他规则一起覆盖掉。⚠️ 本块必须排在 reset-pointers 之后，
        // 否则 `/rules/reset-pointers` 会被 `:id` 吃掉。
        // C14：四种方法的归属栅栏都一样——**不是我的私有规则就 404**，与「不存在」同形，
        // 不用 403 泄露「这个 id 是别人的」。
        if (p.startsWith('/__ec/api/rules/')) {
          const rest = p.slice('/__ec/api/rules/'.length)
          // 用**未解码**的原始路径判断是否带 /enabled 后缀：id 里若真的含 `/`（%2F），
          // 解码后才判会把 `/rules/a%2Fenabled` 误认成开关接口。
          const isToggle = rest.endsWith('/enabled')
          const rawId = isToggle ? rest.slice(0, -'/enabled'.length) : rest
          const methodOk = isToggle
            ? req.method === 'POST'
            : req.method === 'DELETE' || req.method === 'PUT'
          if (methodOk) {
            let id = ''
            try {
              id = decodeURIComponent(rawId)
            } catch {
              return json(res, 400, { error: 'bad rule id' })
            }
            if (!id) return json(res, 400, { error: 'missing rule id' })
            if (isToggle) {
              const body = await readJson(req)
              if (typeof body.enabled !== 'boolean') {
                return json(res, 400, { error: 'bad request', message: 'enabled must be a boolean' })
              }
              const rule = rules.setEnabled(id, body.enabled, phone)
              if (!rule) return ruleNotYours(res, id)
              return json(res, 200, { ok: true, rule })
            }
            if (req.method === 'PUT') {
              const body = await readJson(req)
              // replaceOne 对脏输入抛 400；id 不存在**或不属于调用者**返回 null → 404
              const rule = rules.replaceOne(id, body.rule, phone)
              if (!rule) return ruleNotYours(res, id)
              return json(res, 200, { ok: true, rule })
            }
            const ok = rules.remove(id, phone)
            if (!ok) return ruleNotYours(res, id)
            return json(res, 200, { ok: true, count: rules.list().length })
          }
        }
        // ── 项目：私有 / 共享（C13 / ADR-030 → C14 / ADR-033）──
        // 命中口径（`rule.enabled && 项目是私有 && 项目属于设备 owner && 项目未关`）在 RuleEngine 里，
        // 管理面只做**归属授权**与如实计数：shared 只读，private 只认 owner。
        if (p === '/__ec/api/groups') {
          if (req.method === 'POST') {
            const body = await readJson(req)
            // create 只产 private（协议 §4.7：新建不给 scope）；ownerPhone / createdBy 恒为会话手机号，
            // 请求体里带这些字段是 400 EC_SCOPE_MISMATCH，不是静默丢弃
            const group = groups.create(body.group, phone)
            return json(res, 200, { ok: true, group })
          }
          // 列表附带 ruleCount，且**不回各项目的完整 response body**（共享库变大后
          // 一次全量下发就是把所有人的返回值整片搬进每个登录用户的内存与日志）
          return json(
            res,
            200,
            groups.visible(phone, url.searchParams.get('scope')).map((g) => toGroupView(g, phone)),
          )
        }
        if (p.startsWith('/__ec/api/groups/')) {
          // 用**未解码**的原始路径拆段：id 里含 `%2F` 时不能被当成路径分隔符
          // （与 /rules/:id 那个坑同源），而 `rules` / `copy` 这些子动作要落在第二段
          const parts = p.slice('/__ec/api/groups/'.length).split('/')
          const rawId = parts[0] ?? ''
          const sub = parts[1] ?? ''
          const sub2 = parts[2] ?? ''
          let id = ''
          try {
            id = decodeURIComponent(rawId)
          } catch {
            return json(res, 400, { error: 'bad group id' })
          }
          if (!id) return json(res, 400, { error: 'missing group id' })
          const m = req.method ?? 'GET'
          // 只有 `versions/:versionId` 是三段路径，别的子动作多一段就是打错了 ——
          // 不挡的话 `/groups/x/rules/anything` 会安静地返回规则清单，让调用方以为命中了别的资源
          if (sub && sub !== 'versions' && sub2) return json(res, 404, { error: 'unknown api' })

          // 子动作之间的分派靠 switch 的穷尽性：新增一段路径而忘了写分支会在这里编译期就露出来，
          // 而不是掉到下面的 CRUD 里被当成「id 就是 `copy`」查一遍库
          switch (sub) {
            // ── 版本历史（只读）：写方法一律 409，快照是不可变的 ──
            case 'versions': {
              if (sub2) {
                if (m !== 'GET') {
                  throw projectReadonly(`version ${sub2} of ${id} is an immutable snapshot`)
                }
                return json(res, 200, projects.versionDetail(groups.requireReadable(id, phone).id, sub2))
              }
              if (m !== 'GET') throw projectReadonly('version history is append-only; use share / rollback')
              groups.requireReadable(id, phone)
              return json(res, 200, projects.versions(id))
            }
            // 按项目读规则（含完整 body）。shared 所有登录用户可读；private 非 owner → 404
            case 'rules': {
              if (m !== 'GET') return json(res, 405, { error: 'method not allowed' })
              const target = groups.requireReadable(id, phone)
              return json(res, 200, rules.listOfGroup(target.id))
            }
            // ── copy：shared → 调用者的 private（内容全部由服务端从存储读，不接收上传）──
            case 'copy': {
              if (m !== 'POST') return json(res, 405, { error: 'method not allowed' })
              const body = await readJson(req)
              const r = projects.copyShared(id, phone, body.operationId)
              return json(res, 200, {
                ok: true,
                replayed: r.replayed ?? false,
                group: r.privateProject,
                rules: r.rules,
                copiedFromVersionId: r.copiedFromVersionId,
              })
            }
            // ── share：private → shared（首发 = 新建 shared + publish；再分享 = 整项目覆盖）──
            case 'share': {
              if (m !== 'POST') return json(res, 405, { error: 'method not allowed' })
              const body = await readJson(req)
              const r = projects.sharePrivate(id, phone, body.operationId, body.expectedSharedVersionId)
              return json(res, 200, {
                ok: true,
                replayed: r.replayed ?? false,
                sharedProject: r.sharedProject,
                version: r.version,
                actor: r.actor,
                createdAt: r.createdAt,
                privateProject: r.privateProject,
              })
            }
            // ── rollback：任意历史点 → 追加一条 rollback 版本（旧版本一条不删）──
            case 'rollback': {
              if (m !== 'POST') return json(res, 405, { error: 'method not allowed' })
              const body = await readJson(req)
              const r = projects.rollbackShared(id, body.versionId, phone, body.operationId)
              return json(res, 200, {
                ok: true,
                replayed: r.replayed ?? false,
                sharedProject: r.sharedProject,
                version: r.version,
                actor: r.actor,
                createdAt: r.createdAt,
                rules: r.rules,
              })
            }
            // ── 归档（只针对 shared）：归档 ≠ 删除，快照与分享记录一条不动 ──
            case 'archive': {
              if (m !== 'POST') return json(res, 405, { error: 'method not allowed' })
              const body = await readJson(req)
              const archived = body.archived === undefined ? true : body.archived
              const group = groups.setArchived(id, archived, phone)
              return json(res, 200, { ok: true, group, ruleCount: rules.countByGroup(group.id) })
            }
            // ── 取消待删除（ADR-037）：待删除期间规则与历史一条没动，恢复即恢复原状 ──
            case 'restore': {
              if (m !== 'POST') return json(res, 405, { error: 'method not allowed' })
              const group = groups.cancelPendingDelete(id, phone)
              return json(res, 200, { ok: true, group, ruleCount: rules.countByGroup(group.id) })
            }
            // ── 整组开/关：只对 private 有意义，shared 在上面那层就 409 ──
            case 'enabled': {
              if (m !== 'POST') return json(res, 405, { error: 'method not allowed' })
              const body = await readJson(req)
              // 只接受布尔（同规则的开关接口）：写入口在 LAN 下任何持有会话的客户端都能打，
              // 宽松强转等于让调用方定义「什么算开」（AGENTS.md §4）
              const group = groups.setEnabled(id, body.enabled, phone)
              // affected = 这次开关实际影响到的规则数。调用方要靠它判断「这个组是空的」
              // 还是「组里 20 条都被挡掉了」，两者在 ok:true 里长得一模一样
              return json(res, 200, { ok: true, group, affected: rules.countByGroup(group.id) })
            }
            case '': {
              if (m === 'GET') {
                return json(res, 200, toGroupView(groups.requireReadable(id, phone), phone))
              }
              if (m === 'PUT') {
                const body = await readJson(req)
                return json(res, 200, { ok: true, group: groups.replaceOne(id, body.group, phone) })
              }
              if (m === 'DELETE') {
                // 先鉴权（他人 private 与不存在同形 404）
                const target = groups.requireReadable(id, phone)
                if (target.scope === 'shared') {
                  // 共享项目 → **软删除**（ADR-037）：只打 pendingDeleteAt / purgeAt，
                  // 规则、历史、快照一条不动；7 天内 restore 即恢复，到期由清扫真删。
                  // 注意这里**不再**用「有历史 / 有规则就 409」那套旧闸门：那套是为了防止
                  // 「物理删除留下无归属规则」，而软删除根本不删任何东西，闸门反而挡住了正常诉求。
                  const group = groups.markPendingDelete(target.id, phone)
                  return json(res, 200, {
                    ok: true,
                    pendingDelete: true,
                    group,
                    purgeAt: group.purgeAt ?? null,
                    ruleCount: rules.countByGroup(group.id),
                  })
                }
                // private：**级联删除自己的规则**（ADR-033 决策 6，取代 C13 的「脱组」）。
                // 顺序必须先删规则再删项目：反过来的话中间那一拍规则会变成无归属，
                // 而「无归属」在新模型里就是永不命中——正是控制台显示已启用却一条不 mock 的静默失效
                const removedRules = rules.removeByGroup(target.id)
                groups.remove(target.id)
                // 私有项目也可能有历史（复制来源、被分享过），历史目录一并清掉：
                // 项目都没了还留着历史，等于让 `.data/` 长期背着没人能访问的 body
                projects.purgeProject(target.id)
                return json(res, 200, { ok: true, pendingDelete: false, removedRules })
              }
              return json(res, 405, { error: 'method not allowed' })
            }
            default:
              return json(res, 404, { error: 'unknown api' })
          }
        }
        // ── 现场快照（ADR-017）──
        // 创建/管理走管理面（需登录）；读取走快照面（免鉴权，见上方 /__ec/s/）。
        if (p === '/__ec/api/snapshots') {
          if (req.method === 'POST') {
            const body = await readJson(req)
            const rec = store.getRecord(String(body.recordId ?? ''))
            if (!rec) return json(res, 404, { error: 'not found', message: 'record not found or evicted' })
            // 只能分享当前空间已绑定设备的记录；未绑定设备请求不可浏览或分享。
            if (!store.recordVisible(rec.deviceId, phone)) {
              return json(res, 403, { error: 'EC_UNAUTHORIZED', message: 'record not visible in your space' })
            }
            const snap = snapshots.create(rec, phone, typeof body.title === 'string' ? body.title : '')
            return json(res, 200, {
              token: snap.token,
              createdAt: snap.createdAt,
              expiresAt: snap.expiresAt,
              urls: snapshotUrls(snap.token, req),
            })
          }
          if (req.method === 'DELETE') {
            return json(res, 200, { ok: true, cleared: snapshots.clear(phone) })
          }
          // 列表只含摘要 + 候选链接；绝不含 createdBy（控制台本来就知道自己是谁）
          return json(res, 200, snapshots.list(phone).map((m) => ({ ...m, urls: snapshotUrls(m.token, req) })))
        }
        if (p.startsWith('/__ec/api/snapshots/') && req.method === 'DELETE') {
          const raw = p.slice('/__ec/api/snapshots/'.length)
          let token = ''
          try {
            token = decodeURIComponent(raw)
          } catch {
            return json(res, 400, { error: 'bad token' })
          }
          return json(res, 200, { ok: snapshots.revoke(phone, token) })
        }
        return json(res, 404, { error: 'unknown api' })
      }

      // ── 数据面 ──
      // /__ec/p 为 EasyCharles SDK 协议；--compat-route 可额外挂载第三方客户端的改写路由（默认关闭）
      if (p.startsWith('/__ec/p') || cfg.compat.routes.some((r) => p.startsWith(r))) {
        await handleDataPlane(req, res)
        return
      }

      // ── 快照查看页（静态壳 · 免鉴权）──
      // 页面自己按 URL 里的 token 去取 /__ec/s/<token>；壳不含任何数据，
      // 与 /about 同级免鉴权。响应头统一 no-store / noindex，避免链接被缓存或收录。
      if (p.startsWith('/s/') && p.length > 3 && req.method === 'GET') {
        const html = readFileSync(join(__dirname, '..', 'web', 'snapshot.html'), 'utf8')
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-robots-tag': 'noindex, nofollow',
          'referrer-policy': 'no-referrer',
        })
        res.end(html)
        return
      }

      // ── 关于页（架构原理 + 客户端接入）──
      // 纯静态文档，不含任何数据，与 `/` 同级免鉴权（ADR-015 管理面口径）
      if (p === '/about' || p === '/about.html') {
        const html = readFileSync(join(__dirname, '..', 'web', 'about.html'), 'utf8')
          .replaceAll('__EC_VERSION__', SERVER_VERSION)
          .replaceAll('__EC_PROTOCOL__', String(PROTOCOL_VERSION))
          .replaceAll('__EC_PORT__', String(cfg.port))
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(html)
        return
      }

      // ── 控制台静态页 ──
      if (p === '/' || p === '/index.html') {
        const html = readFileSync(join(__dirname, '..', 'web', 'index.html'), 'utf8')
        // no-store：控制台是随服务端一起演进的单页，禁止缓存，避免升级后仍看到旧 UI
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(html)
        return
      }

      // ── 管理控制台（独立页，与用户控制台完全分离；ADR-018 role 判定不变）──
      // 页面本身免鉴权（静态壳不含数据），数据全走 /__ec/api/admin/*（服务端校 role=admin）。
      if (p === '/admin' || p === '/admin.html') {
        const html = readFileSync(join(__dirname, '..', 'web', 'admin.html'), 'utf8')
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(html)
        return
      }

      // ── 加解密配置页（独立页；ADR-039 / ADR-040）──
      // 与 admin 页同样的口径：页面是静态壳、免鉴权，数据全走 /__ec/api/crypto*（需会话）。
      // 单独成页而不是塞进 226KB 的用户控制台：这份配置是「装一次就不动」的运维面，
      // 不该让每天的抓包流程为它背一份 DOM。
      if (p === '/crypto' || p === '/crypto.html') {
        const html = readFileSync(join(__dirname, '..', 'web', 'crypto.html'), 'utf8')
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(html)
        return
      }

      json(res, 404, { error: 'not found' })
    } catch (err) {
      // F-10：readJson 抛出的带 statusCode 错误（如 413 body 过大）按对应码返回；
      // C14 起 groups/rules/projects 抛的是带 `code` 的 EC 错误，这里统一折成
      // `{ error: 'EC_XXX', message }`（协议 §6.1），无 code 的老错误沿用既有文案不变
      const e = ecBody(err)
      return json(res, e.status, e.body)
    }
  })()
})

createControlPlane(server, cfg, store, rules)

/**
 * 待删除到期清理（ADR-037）：把 `purgeAt` 已过的共享项目真的删掉（规则 → 项目 → 历史快照）。
 * 编排与顺序在 `ProjectService.purgeExpired`（那里才同时拿得到两张表与历史目录），
 * 这里只负责「什么时候跑」和「如实打日志」。
 */
function purgeExpiredProjects(now: number = Date.now()): string[] {
  const r = projects.purgeExpired(now)
  for (const p of r.purged) {
    console.log(`[ec] 待删除项目到期，已真删：${p.id}（${p.name}）· 规则 ${p.rules} 条 · 历史 ${p.files} 个文件`)
  }
  for (const f of r.failed) {
    console.log(`[ec] ⚠️ 待删除项目清理失败（下一轮重试）：${f.id} — ${f.error}`)
  }
  return r.purged.map((p) => p.id)
}

// ── 启动顺序：先恢复事务，再做归属迁移，最后才对外服务（架构 §6.3）──
// 这两步都**必须**在 listen 之前：
// · recover 是把上一条进程崩在中间的 copy/share/rollback 按 operationId 幂等地做完，
//   晚一步做，期间进来的请求看到的就是「规则已改、历史没有这条」的半提交状态；
// · migrate 是给存量未分组 / 悬空 groupId 的规则找归属，而 C14 下无归属就是永不命中，
//   晚一步做，升级后的第一批请求会全部原样转发上游（界面上一切正常，最难查的那种）。
const recovered = projects.recover()
const migrated = migrateProjects(groups, rules)
// 软删除到期的共享项目：排在 recover / migrate 之后，免得跟事务前滚抢同一批文件
const purgedAtBoot = purgeExpiredProjects()

// 快照过期清理：读路径（get）也会顺手清，这里只是兜底，避免长期无人访问的过期快照留在磁盘
const sweepTimer = setInterval(() => snapshots.sweep(), 10 * 60_000)
sweepTimer.unref()
// 待删除项目清理：`purgeAt` 是落盘的时刻，30 分钟一次足够精确（倒计时单位是天）
const trashTimer = setInterval(() => purgeExpiredProjects(), 30 * 60_000)
trashTimer.unref()

server.listen(cfg.port, cfg.host, () => {
  printBanner(cfg, lanAddresses())
  // 加解密：如实报告「配了几条」，否则「我明明配了却不生效」只能靠翻文件排查
  if (cfg.cryptoEnabled) {
    const cv = crypto.view()
    if (cv.profiles.length) {
      console.log(`[crypto] 已加载 ${cv.profiles.length} 个密钥档 / ${cv.routes.length} 条解密路由（${crypto.file()}）`)
    } else {
      console.log(`[crypto] 未配置密钥档；需要看加密接口的明文时，把配置写到 ${crypto.file()}`)
    }
    // 插件也如实报告：装了个插件却没被认出来，是「配置了不生效」的常见来源
    const pv = pluginManager.list()
    const extra = pv.filter((x) => !x.builtin)
    if (extra.length) {
      const bad = extra.filter((x) => x.status === 'error')
      console.log(
        `[crypto] 插件 ${pv.length} 个（私有 ${extra.length}${bad.length ? `，其中 ${bad.length} 个加载失败` : ''}）：` +
          `${pv.filter((x) => x.status === 'loaded').map((x) => x.name).join(', ')}（${pluginManager.rootDir()}）`,
      )
      for (const x of bad) console.warn(`[crypto] 插件 ${x.name} 加载失败：${x.error ?? '未知原因'}`)
    }
  }
  // 如实报告启动期动过什么（计划 §11「上线提示」）：静默升级就等于静默失效
  if (migrated.moved > 0) {
    console.log(
      `[ec] 升级迁移：${migrated.moved} 条规则原本没有归属（未分组 / groupId 悬空），` +
        `已收进共享项目「${LEGACY_SHARED_NAME}」（id ${migrated.containerId}）。` +
        `共享项目不参与 mock——要恢复拦截，请在控制台把它复制到你自己的项目。`,
    )
  }
  if (recovered.completed.length) console.log(`[ec] journal 前滚完成: ${recovered.completed.join(', ')}`)
  if (recovered.abandoned.length) {
    console.log(
      `[ec] ⚠️ journal 里有 ${recovered.abandoned.length} 笔事务无法恢复（快照文件缺失）: ` +
        `${recovered.abandoned.join(', ')}；active 规则与历史一字未改，pending 已清除`,
    )
  }
  if (purgedAtBoot.length) {
    console.log(`[ec] 启动清理：${purgedAtBoot.length} 个待删除的共享项目已到期并真删（明细见上）`)
  }
  // 历史「默认全部保留、不静默清理」（ADR-033），容量必须启动时就看得见——
  // 旧版本会长期保留后来删掉的 response body（可能含 token / cookie / 个人数据）。
  // 管理面 overview 报同一份账（实际字节数，不是估算，AGENTS.md §6）
  const hist = projects.storageUsage()
  const mb = hist.bytes / (1024 * 1024)
  console.log(
    `[ec] 项目历史占用 ${hist.bytes} 字节（${mb >= 1 ? mb.toFixed(1) + ' MB' : (hist.bytes / 1024).toFixed(1) + ' KB'}），` +
      `${hist.files} 个文件 / ${hist.projects} 个项目；历史默认全部保留，不静默清理（ADR-033）`,
  )
})
