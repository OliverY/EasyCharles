import type { IncomingMessage, ServerResponse } from 'node:http'
import http from 'node:http'
import https from 'node:https'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'
import type { CompatConfig, Config, CryptoMeta, EcRecord, Headers, MessagePart, MockResponse, RecordMode } from './types.ts'
import { newId, type Store } from './store.ts'
import type { RuleEngine } from './rules.ts'
import { decryptForRecord, decryptQuery, encryptWith, type CryptoStore } from './crypto/index.ts'

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const PARSEABLE = [/json/i, /^text\//i, /xml/i, /urlencoded/i, /javascript/i]

type RawHeaders = Record<string, string | string[]>

function isParseable(contentType: string): boolean {
  return PARSEABLE.some((re) => re.test(contentType))
}

/**
 * query 密文解出来的明文 → 参数表。
 *
 * 常见形态有两种：`noncestr=..&sign=..&timestamp=..`（本项目的真实情况）和
 * 直接一段 JSON / 单个值。能按表单展开就展开（控制台能一项项看），
 * 展不开就原样挂在密文参数名下 —— **绝不丢内容**，也绝不猜结构。
 */
function explodePlainQuery(field: string, plain: string): Record<string, string> {
  const text = plain.trim()
  if (!text) return {}
  // 只有「确实像 k=v&…」才展开；`abc=1` 这种单值也会被展开成一项，符合直觉
  if (/^[^=&\s]+=/.test(text) && !text.startsWith('{')) {
    try {
      const out: Record<string, string> = {}
      new URLSearchParams(text).forEach((v, k) => {
        out[k] = v
      })
      if (Object.keys(out).length) return out
    } catch {
      /* 落到下面的原样保留 */
    }
  }
  return { [field]: plain }
}

/** 兼容层客户端没有「一次会话」的概念，设备条目固定落在这一个 sessionId 上（ADR-032） */
const COMPAT_SESSION_ID = 'compat'

/** 身份头的字符/长度上限：控制字符会串进控制台表格，超长值会原样落进 store.json 的 key */
const IDENTITY_MAX = 64

/**
 * 兼容层身份头按不可信处理（AGENTS.md §4）：去控制字符、折空白、截断。
 * 截断放在派生主键之前，避免一个 16KB 的头把设备表键撑爆。
 */
function identityPart(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, IDENTITY_MAX)
}

/** 展示名允许 percent-encoded（中文机型名），解码失败就退回原文而不是丢掉整条 */
function decodeSafe(raw: string): string {
  if (!raw) return ''
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

// F-04：record-mode 裁剪（ADR-012）。bodySize 语义不变：始终保留真实大小。
// meta  → body 一律不落；sample → body 只留前 sampleBytes；full → 原样。
function applyRecordMode(
  mode: RecordMode,
  body: string,
  truncated: boolean,
  sampleBytes: number,
): { body: string; truncated: boolean } {
  if (mode === 'meta') return { body: '', truncated: true }
  if (mode === 'sample' && body.length > sampleBytes) return { body: body.slice(0, sampleBytes), truncated: true }
  return { body, truncated }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function readBody(req: IncomingMessage, limit: number): Promise<{ buf: Buffer; truncated: boolean; total: number }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let len = 0
    let truncated = false
    req.on('data', (c: Buffer) => {
      total += c.length
      if (truncated) return
      const space = limit - len
      if (c.length <= space) {
        chunks.push(c)
        len += c.length
      } else {
        chunks.push(c.subarray(0, space))
        len += space
        truncated = true
      }
    })
    req.on('end', () => resolve({ buf: Buffer.concat(chunks), truncated, total }))
    req.on('error', reject)
  })
}

function drain(req: IncomingMessage): Promise<void> {
  return new Promise((resolve) => {
    if (req.readableEnded) return resolve()
    req.on('end', () => resolve())
    req.on('error', () => resolve())
    req.resume()
  })
}

function decode(buf: Buffer, encoding: string): Buffer {
  try {
    if (encoding === 'gzip') return gunzipSync(buf)
    if (encoding === 'deflate') return inflateSync(buf)
    if (encoding === 'br') return brotliDecompressSync(buf)
  } catch {
    /* 解压失败就保留原始字节 */
  }
  return buf
}

function stringify(buf: Buffer, contentType: string): { body: string; encoding: 'utf8' | 'base64' } {
  if (isParseable(contentType)) return { body: buf.toString('utf8'), encoding: 'utf8' }
  return { body: buf.toString('base64'), encoding: 'base64' }
}

function flatten(h: RawHeaders): Headers {
  const out: Headers = {}
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue
    out[k] = Array.isArray(v) ? v.join('; ') : String(v)
  }
  return out
}

/**
 * 合并「请求入参」：query + body，同名以 body 为准。
 * 供规则引擎的 `match.params` 使用（协议 §5.4 / ADR-016）。
 *
 * **传进来的是解密后的 body**（ADR-039）：加密接口的业务参数都在密文里，
 * 用密文去匹配 `params` 等于「永远匹配不上」，控制台配好规则也会静默失效。
 *
 * body 是不可信输入：数组 / 标量 / 非 JSON / 二进制一律不参与合并，**不得抛错**
 * （AGENTS.md §4：写入入口要扛住脏数据；这里的「入口」是请求体）。
 */
function collectParams(u: URL, bodyText: string, contentType: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of u.searchParams.entries()) out[k] = v

  const text = bodyText.trim()
  if (!text) return out

  if (/json/i.test(contentType) || text.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (v === null || v === undefined) continue
          // 与控制台 requestParams() 同口径：嵌套值序列化后比对
          out[k] = typeof v === 'object' ? JSON.stringify(v) : String(v)
        }
      }
    } catch {
      /* 非法 JSON：忽略 body 参数，不报错 */
    }
    return out
  }

  if (/urlencoded/i.test(contentType)) {
    try {
      new URLSearchParams(text).forEach((v, k) => {
        out[k] = v
      })
    } catch {
      /* 忽略 */
    }
  }
  return out
}

function upstreamHeaders(src: RawHeaders, target: URL, compat: CompatConfig): RawHeaders {
  // 兼容层用到的代理头/身份头只服务于本地服务，绝不转发给上游
  const compatHeads = new Set([
    compat.targetHeader,
    compat.deviceIdHeader,
    compat.deviceNameHeader,
    compat.userIdHeader,
    compat.userNameHeader,
  ])
  const out: RawHeaders = {}
  for (const [k, v] of Object.entries(src)) {
    const lk = k.toLowerCase()
    if (lk.startsWith('x-ec-')) continue
    if (compatHeads.has(lk)) continue
    if (HOP_BY_HOP.has(lk)) continue
    if (v === undefined) continue
    out[k] = v
  }
  out['host'] = target.host
  // 让上游返回未压缩内容，便于记录明文；返回给 App 时同步去掉 Content-Encoding
  out['accept-encoding'] = 'identity'
  return out
}

function fail(res: ServerResponse, status: number, code: string, msg: string): void {
  const body = Buffer.from(JSON.stringify({ error: code, message: msg }), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'x-ec-error': code,
  })
  res.end(body)
}

export interface DataPlaneContext {
  cfg: Config
  store: Store
  rules: RuleEngine
  /**
   * 加解密插件（ADR-039）。**可以为 null**：自测与 `--no-crypto` 时不需要它。
   * 用可选参数而不是必填，是为了让「没有插件」成为一条明确路径，
   * 而不是一个悄悄失效的空对象。
   */
  crypto?: CryptoStore | null
}

export function createDataPlane(ctx: DataPlaneContext) {
  const { cfg, store, rules } = ctx
  const crypt = ctx.crypto ?? null

  return async function handleDataPlane(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startedAt = Date.now()
    const recordId = newId('rec')
    const h = req.headers as RawHeaders

    // 数据面无鉴权（局域网全开放，用户空间由 Web 控制台管理）

    // ── 目标解析 ──
    // 默认协议：EasyCharles SDK 的 X-EC-Target（走 /__ec/p 前缀）
    // 可选兼容层：第三方客户端把真实目标放在自定义头里（头名 / 路由由 --compat-* 参数注入，默认关闭）
    const target = h['x-ec-target'] ?? h[cfg.compat.targetHeader]
    if (!target) {
      const hint = cfg.compat.routes.length ? ` (X-EC-Target / ${cfg.compat.targetHeader})` : ' (X-EC-Target)'
      return fail(res, 400, 'EC_TARGET_MISSING', `missing target header${hint}`)
    }

    // ── 设备识别 ──
    // SDK 客户端带 X-EC-Device-Id；非 SDK 客户端不带，则由兼容层配置的头派生设备标识，
    // 顺势在数据面 upsert 设备表（无需控制面也能在控制台看到设备）
    let deviceId = String(h['x-ec-device-id'] ?? '')
    let sessionId = String(h['x-ec-session-id'] ?? '')
    if (!deviceId) {
      const displayName = identityPart(decodeSafe(String(h[cfg.compat.deviceNameHeader] ?? ''))) || 'unknown'
      // 主键优先级（ADR-032 / 协议 §5.1）：每安装唯一 ID > 用户 ID + 展示名 > 展示名。
      // **不能只用用户 ID**：同一账号在两台手机上同时登录是常态，而设备表按 deviceId 聚合成一行，
      // 只用 `client:<userId>` 会把两台物理手机合成一台，展示名随「谁刚发过请求」来回变。
      const installId = identityPart(String(h[cfg.compat.deviceIdHeader] ?? ''))
      const userId = identityPart(String(h[cfg.compat.userIdHeader] ?? ''))
      deviceId = installId
        ? `client:${installId}`
        : userId
          ? `client:${userId}@${displayName}`
          : `client:${displayName}`
      // 兼容层客户端没有会话概念：用固定值，同一台设备始终落在同一条目上。
      // 原来每条请求造一个 `sess-<时间戳>`，设备表按请求数无界增长，且归属跟着最近一条走。
      sessionId = COMPAT_SESSION_ID
      store.upsertDevice({
        deviceId,
        sessionId,
        appId: cfg.compat.appId,
        displayName,
        deviceName: displayName,
        userName: String(h[cfg.compat.userNameHeader] ?? '') || null,
        userId: userId || null,
        env: String(h['x-ec-env'] ?? 'test') || 'test',
      })
    }
    if (!sessionId) sessionId = 'unknown'
    const seq = Number(h['x-ec-seq'] ?? store.nextSeq())
    const method = (req.method ?? 'GET').toUpperCase()
    // C8/F-12：重定向链非首跳由 SDK 用 X-EC-Redirect: 1 标记（可选头，缺省视为首跳）
    const redirected = String(h['x-ec-redirect'] ?? '') === '1'

    // F-04：per-request X-EC-Record-Mode > 全局 --record-mode > 默认 full（ADR-012）
    const cfgMode: RecordMode = cfg.recordMode === 'full' || cfg.recordMode === 'meta' || cfg.recordMode === 'sample' ? cfg.recordMode : 'full'
    const modeArg = String(h['x-ec-record-mode'] ?? '').toLowerCase()
    const recMode: RecordMode = modeArg === 'full' || modeArg === 'meta' || modeArg === 'sample' ? modeArg : cfgMode

    let u: URL
    try {
      u = new URL(String(target))
    } catch {
      return fail(res, 400, 'EC_BAD_TARGET', `unparsable X-EC-Target: ${target}`)
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return fail(res, 400, 'EC_BAD_TARGET', `unsupported scheme: ${u.protocol}`)
    }

    const reqCt = String(h['content-type'] ?? '')
    const reqCl = Number(h['content-length'] ?? 0)

    // 请求体：只有大小已知且在阈值内才缓冲，否则流式 pass-through
    let reqBuf: Buffer | null = null
    let reqTruncated = false
    let reqTotal = 0
    if (reqCl > 0 && reqCl <= cfg.maxBufferBytes) {
      const r = await readBody(req, cfg.maxBufferBytes)
      reqBuf = r.buf
      reqTruncated = r.truncated
      reqTotal = r.total
    }

    const reqBodyStr = reqBuf ? stringify(reqBuf, reqCt) : { body: '', encoding: 'utf8' as const }

    // ── 请求方向解密（ADR-039）──
    // 只改「记录里长什么样」，**不改发往上游的字节**（下面 upReq.end(reqBuf) 仍是原始密文）。
    // 解密失败不阻断请求：App 该怎么工作还怎么工作，只是这条记录显示密文 + 失败原因。
    const cryptoHit = crypt?.match({ method, host: u.host, path: u.pathname }) ?? null
    const cryptoMeta: CryptoMeta = {}

    // ── query 方向解密（ADR-039 增补）──
    // 为什么必须做：GET 请求**没有 body**，业务参数全在 `?payload=` 里；
    // 只解 body 等于「GET 类加密接口在控制台永远是密文」。
    // 与 body 一样只影响记录：真正发给上游的 URL 一字不改（upReq 用的是上面的 u）。
    let queryPlain: Record<string, string> | undefined
    if (cryptoHit && cryptoHit.route.request && cryptoHit.profile.query) {
      const field = cryptoHit.profile.query.field
      const wire = u.searchParams.get(field)
      if (wire) {
        // 第三个参数是注册表：必须与 match() 用的是同一个，否则「匹配上了却解不开」
        // 第四个是原始请求头：插件只能看到 profile 里显式声明的那几个（ADR-040 §6.3）
        const q = decryptQuery(cryptoHit.profile, wire, cryptoHit.plugins, h)
        if (q.ok) {
          queryPlain = explodePlainQuery(field, q.plain)
          cryptoMeta.query = { profileId: cryptoHit.profile.id, decrypted: true, field }
        } else {
          cryptoMeta.query = { profileId: cryptoHit.profile.id, decrypted: false, error: q.error, field }
        }
      }
    }

    let reqBodyText = reqBodyStr.body
    let reqRawBody: string | null = null
    if (
      cryptoHit &&
      cryptoHit.route.request &&
      reqBuf &&
      !reqTruncated &&
      reqBodyStr.encoding === 'utf8' &&
      reqBodyText !== ''
    ) {
      const d = decryptForRecord(cryptoHit.profile, reqBodyText, cryptoHit.profile.request, cryptoHit.plugins, h)
      if (d.rawBody === null) {
        cryptoMeta.request = { profileId: cryptoHit.profile.id, decrypted: false, error: d.error }
      } else {
        reqBodyText = d.body
        reqRawBody = d.rawBody
        cryptoMeta.request = { profileId: cryptoHit.profile.id, decrypted: true }
      }
    }

    // 记录裁剪对「明文」和「密文原文」各做一次：meta 模式下两者都必须为空，
    // 否则「只记元数据」就成了一句空话（ADR-012）。
    const reqBodyMode = applyRecordMode(recMode, reqBodyText, reqTruncated || reqBuf === null, cfg.sampleBytes)
    const reqRawMode = reqRawBody === null ? null : applyRecordMode(recMode, reqRawBody, false, cfg.sampleBytes)
    const reqPart: MessagePart = {
      method,
      url: u.toString(),
      host: u.host,
      path: u.pathname,
      query: Object.fromEntries(u.searchParams.entries()),
      // meta 模式连参数都不落：解密后的 query 同样是业务内容（ADR-012 的口径一致）
      queryPlain: recMode === 'meta' ? undefined : queryPlain,
      headers: flatten(h as RawHeaders),
      body: reqBodyMode.body,
      bodyEncoding: reqBodyStr.encoding,
      // 缓冲路径用实际读到的字节数（防止客户端 content-length 撒谎）；流式路径只能信声明值
      bodySize: reqBuf === null ? reqCl : reqTotal,
      bodyTruncated: reqBodyMode.truncated,
      rawBody: reqRawMode ? reqRawMode.body : null,
    }

    /** 把这一条记录里发生过的加解密写进去（只在真发生时才带 crypto 字段，存量记录零迁移） */
    const markCrypto = (rec: EcRecord): EcRecord => {
      if (cryptoMeta.request || cryptoMeta.response || cryptoMeta.query) rec.crypto = { ...cryptoMeta }
      if (cryptoMeta.request?.decrypted || cryptoMeta.response?.decrypted || cryptoMeta.query?.decrypted) {
        rec.flags.decrypted = true
      }
      return rec
    }

    const respondMock = (mock: MockResponse, ruleId: string) => {
      if (reqBuf === null) void drain(req)
      const rule = rules.list().find((r) => r.id === ruleId)
      const delay = rule?.action?.delayMs ?? 0
      const finish = () => {
        // mock 的 body 是**明文**（用户在控制台里填的就是解密后看到的样子）。
        // 规则声明了 crypto 就加密回写，否则 App 的解密拦截器解不开这包数据。
        const plain = mock.body ?? ''
        let body = plain
        let mockRaw: string | null = null
        let wrap: 'raw' | 'json' | 'form' | null = null
        const pid = rule?.action?.crypto?.profileId
        if (pid) {
          const p = crypt?.profileById(pid)
          if (!crypt || !p) {
            // 宁可让 mock 失效也不要悄悄吐明文：App 那边只会看到「解密失败」，比这更难查
            cryptoMeta.response = { profileId: pid, decrypted: false, error: `密钥档 ${pid} 不存在，已按明文返回` }
          } else {
            const e = encryptWith(p, body, p.encrypt, crypt.plugins, h)
            if (e.ok) {
              mockRaw = body
              body = e.body
              wrap = p.encrypt.type
              cryptoMeta.response = { profileId: pid, decrypted: true, encrypted: true }
            } else {
              cryptoMeta.response = { profileId: pid, decrypted: false, error: `mock 加密失败，已按明文返回：${e.error}` }
            }
          }
        }
        const buf = Buffer.from(body, 'utf8')
        // 加密后的形态决定 content-type：raw 是 base64 文本，json 才是 JSON。
        // 用户显式配了 headers 就完全尊重，不再替他改。
        const fallbackCt = mockRaw !== null && wrap !== null && wrap !== 'json'
          ? 'text/plain; charset=utf-8'
          : 'application/json'
        const out: RawHeaders = {}
        for (const [k, v] of Object.entries(mock.headers ?? { 'content-type': fallbackCt })) {
          if (HOP_BY_HOP.has(k.toLowerCase())) continue
          out[k] = v
        }
        out['content-length'] = String(buf.length)
        out['x-ec-id'] = recordId
        out['x-ec-mock'] = '1'
        out['x-ec-upstream-ms'] = '0'
        const status = Number.isInteger(mock.status) && mock.status >= 100 && mock.status <= 599 ? mock.status : 200

        // 客户端可能在 delay 期间断开（mock 延迟是常见场景）；断开后只落记录，不写响应
        if (res.destroyed || res.writableEnded) {
          store.addRecord(buildMockRecord(status, out, buf, plain, mockRaw !== null))
          return
        }
        res.writeHead(status, out)
        res.end(buf)
        store.addRecord(buildMockRecord(status, out, buf, plain, mockRaw !== null))
      }
      if (delay > 0) void sleep(delay).then(finish)
      else finish()
    }

    /**
     * `wire`  = 真正发给 App 的字节（可能是密文），`bodySize` 用它的长度
     * `plain` = 记录里展示的明文
     *
     * `rawBody` 的口径与真实响应完全一致：**线上真正传输的那份**（mock 时是加密后的密文），
     * 不是「加密前的明文」。否则同一个字段在 mock 记录与真实记录里含义相反，
     * 控制台的「查看密文」按钮就会在两处显示不同的东西。
     */
    const buildMockRecord = (status: number, out: RawHeaders, wire: Buffer, plain: string, encrypted: boolean): EcRecord => {
      const respMode = applyRecordMode(recMode, plain, false, cfg.sampleBytes)
      const wireText = wire.toString('utf8')
      const rawMode = encrypted ? applyRecordMode(recMode, wireText, false, cfg.sampleBytes) : null
      return markCrypto({
        id: recordId,
        seq,
        deviceId,
        sessionId,
        startedAt,
        durationMs: Date.now() - startedAt,
        request: reqPart,
        response: {
          status,
          headers: flatten(out),
          body: respMode.body,
          bodyEncoding: 'utf8',
          bodySize: wire.length,
          bodyTruncated: respMode.truncated,
          rawBody: rawMode ? rawMode.body : null,
        },
        upstream: { ms: 0, protocol: 'mock', error: null },
        flags: { mocked: true, decrypted: false, streamed: false, redirected },
      })
    }

    // 请求入参 = query + body 合并（同名以 body 为准），供 match.params 匹配。
    // 用**解密后的明文**：加密接口的参数在密文里，拿密文匹配等于永不命中（ADR-039）。
    // 解密失败时 reqBodyText 仍是原文，退回旧行为而不是让参数凭空消失。
    const params = collectParams(u, reqBodyText, reqCt)
    // 解密后的 query 参数一并参与匹配：`sign` / `timestamp` 这些原本藏在 payload 里，
    // 不合并的话「按 query 参数写 mock 条件」在加密接口上等于永远不命中。
    if (queryPlain) for (const [k, v] of Object.entries(queryPlain)) params[k] = v
    // 归属（C14 / 架构 §5.5）：owner 只从 deviceId 反查，与 `recordVisible()` 用同一个函数——
    // 另起一个真值来源就会出现「列表里看得见这条记录，mock 却不按这个人生效」的对不上。
    // **这不是鉴权**：数据面仍然不鉴权（ADR-015）。未绑定设备（owner 为 null）得到空候选集，
    // 于是请求原样转发上游——是「不命中」，不是「拒绝」，SDK 零改动、也不会因此 fail-open。
    const ownerPhone = store.deviceOwner(deviceId)
    const hit = rules.resolve({ method, host: u.host, path: u.pathname, deviceId, ownerPhone, params })
    if (hit?.response) {
      respondMock(hit.response, hit.rule.id)
      return
    }

    const upHeaders = upstreamHeaders(h, u, cfg.compat)
    const mod = u.protocol === 'https:' ? https : http
    let settled = false

    const respondError = (status: number, code: string, msg: string) => {
      if (settled || res.headersSent || res.destroyed) return
      settled = true
      const rec: EcRecord = markCrypto({
        id: recordId,
        seq,
        deviceId,
        sessionId,
        startedAt,
        durationMs: Date.now() - startedAt,
        request: reqPart,
        response: {
          status,
          headers: {},
          body: '',
          bodyEncoding: 'utf8',
          bodySize: 0,
          bodyTruncated: false,
        },
        upstream: { ms: Date.now() - startedAt, protocol: '--', error: code },
        flags: { mocked: false, decrypted: false, streamed: false, redirected },
      })
      store.addRecord(rec)
      fail(res, status, code, msg)
    }

    const upReq = mod.request(
      u,
      { method, headers: upHeaders as http.OutgoingHttpHeaders, timeout: cfg.upstreamTimeoutMs },
      (upRes) => {
        const resCl = Number(upRes.headers['content-length'] ?? 0)
        const resCt = String(upRes.headers['content-type'] ?? '')
        const resEnc = String(upRes.headers['content-encoding'] ?? '')
        const status = upRes.statusCode ?? 502

        const out: RawHeaders = {}
        for (const [k, v] of Object.entries(upRes.headers)) {
          if (HOP_BY_HOP.has(k.toLowerCase())) continue
          if (v !== undefined) out[k] = v as string | string[]
        }
        out['x-ec-id'] = recordId
        out['x-ec-mock'] = '0'
        out['x-ec-upstream-ms'] = String(Date.now() - startedAt)

        const noBodyStatus = method === 'HEAD' || status === 204 || status === 304

        // 统一收尾：只落一次记录（F-01 保证错误路径不崩进程、不重复落）
        const finishRecord = (
          body: string,
          bodyEncoding: 'utf8' | 'base64',
          bodySize: number,
          bodyTruncated: boolean,
          upstreamError: string | null,
          streamed: boolean,
        ) => {
          if (settled) return
          settled = true
          // 响应方向解密：`body` 换成明文给控制台，密文原文进 `rawBody`。
          // 发给 App 的字节在这之前就已经写出去了，这里改什么都没关系（这正是「只影响展示」）。
          let shown = body
          let rawBody: string | null = null
          if (
            cryptoHit &&
            cryptoHit.route.response &&
            bodyEncoding === 'utf8' &&
            body !== '' &&
            !bodyTruncated
          ) {
            const d = decryptForRecord(cryptoHit.profile, body, cryptoHit.profile.response, cryptoHit.plugins, out)
            if (d.rawBody === null) {
              cryptoMeta.response = { profileId: cryptoHit.profile.id, decrypted: false, error: d.error }
            } else {
              shown = d.body
              rawBody = d.rawBody
              cryptoMeta.response = { profileId: cryptoHit.profile.id, decrypted: true }
            }
          }
          const m = applyRecordMode(recMode, shown, bodyTruncated, cfg.sampleBytes)
          const rm = rawBody === null ? null : applyRecordMode(recMode, rawBody, false, cfg.sampleBytes)
          store.addRecord(markCrypto({
            id: recordId,
            seq,
            deviceId,
            sessionId,
            startedAt,
            durationMs: Date.now() - startedAt,
            request: reqPart,
            response: {
              status,
              headers: flatten(out),
              body: m.body,
              bodyEncoding,
              bodySize,
              bodyTruncated: m.truncated,
              rawBody: rm ? rm.body : null,
            },
            upstream: { ms: Date.now() - startedAt, protocol: upRes.httpVersion, error: upstreamError },
            flags: { mocked: false, decrypted: false, streamed, redirected },
          }))
        }

        // ── 路径 A：声明大小已知且 ≤ 阈值（排除 HEAD/204/304）→ 收满再回，可整体解码去编码 ──
        if (!noBodyStatus && resCl > 0 && resCl <= cfg.maxBufferBytes) {
          void readBody(upRes, cfg.maxBufferBytes)
            .then(({ buf, truncated }) => {
              if (settled || res.destroyed) return
              const decoded = decode(buf, resEnc)
              if (decoded !== buf) delete out['content-encoding']
              out['content-length'] = String(decoded.length)
              res.writeHead(status, out)
              res.end(decoded)
              const s = stringify(decoded, resCt)
              finishRecord(s.body, s.encoding, decoded.length, truncated, null, false)
            })
            .catch(() => {
              // 上游收 body 途中断流：不崩进程；客户端已断开就不落错误记录
              if (res.destroyed) return
              respondError(502, 'EC_UPSTREAM_UNREACHABLE', 'upstream aborted mid-body')
            })
          return
        }

        // ── 路径 B：流式转发（bounded buffering，ADR-008）──
        // 可解析且未压缩的未知大小响应 → 边转发边缓冲，收满整包则完整记录；
        // 其余（二进制/SSE/压缩/大响应）→ 只采样前 sampleBytes。bodySize 恒为实际传输字节数。
        if (res.destroyed) return
        res.writeHead(status, out)
        const parseable = isParseable(resCt) && !resEnc && !/text\/event-stream/i.test(resCt)
        const bufChunks: Buffer[] = []
        const sampleChunks: Buffer[] = []
        let buffered = 0
        let sampled = 0
        let total = 0
        let overflow = false

        upRes.on('data', (c: Buffer) => {
          total += c.length
          if (parseable && !overflow) {
            if (buffered + c.length <= cfg.maxBufferBytes) {
              bufChunks.push(c)
              buffered += c.length
            } else {
              overflow = true
            }
          }
          if (overflow || !parseable) {
            if (sampled < cfg.sampleBytes) {
              const need = Math.min(c.length, cfg.sampleBytes - sampled)
              sampleChunks.push(c.subarray(0, need))
              sampled += need
            }
          }
          if (!res.write(c)) {
            upRes.pause()
            res.once('drain', () => upRes.resume())
          }
        })
        upRes.on('end', () => {
          if (res.writableEnded || res.destroyed) return
          res.end()
          if (parseable && !overflow) {
            const s = stringify(Buffer.concat(bufChunks), resCt)
            finishRecord(s.body, s.encoding, total, false, null, false)
          } else {
            const s = stringify(Buffer.concat(sampleChunks), resCt)
            finishRecord(s.body, s.encoding, total, true, null, true)
          }
        })
        upRes.on('error', () => {
          // 流式途中上游断流：不崩进程；客户端侧按截断收尾，记录错误
          if (res.headersSent && !res.writableEnded) res.destroy()
          finishRecord('', 'utf8', total, true, 'EC_UPSTREAM_UNREACHABLE', true)
        })
      },
    )

    upReq.on('timeout', () => {
      upReq.destroy()
      respondError(504, 'EC_UPSTREAM_TIMEOUT', `upstream timeout after ${cfg.upstreamTimeoutMs}ms`)
    })
    upReq.on('error', (err: NodeJS.ErrnoException) => {
      // 连接层失败（拒连/DNS/超时/断流）统一 502 EC_UPSTREAM_UNREACHABLE，绝不重试
      respondError(502, 'EC_UPSTREAM_UNREACHABLE', `${u.host} -> ${err.message}`)
    })
    res.on('close', () => {
      if (!settled) upReq.destroy()
    })

    if (reqBuf !== null) upReq.end(reqBuf)
    else req.pipe(upReq)
  }
}
