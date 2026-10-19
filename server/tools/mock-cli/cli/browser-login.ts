/**
 * 浏览器登录接力（ADR-029）。
 *
 * 要解决的问题：`mock login` 原本只有三条口令通道（--password / EC_MOCK_PASSWORD /
 * --password-stdin），人用的时候最自然的那条——「我已经在浏览器里登录了控制台」——
 * 反而用不上，还得再把口令敲一遍（而且按 D3 口令不落盘，每次会话过期都要重来）。
 *
 * 做法：CLI 在本机 127.0.0.1 起一个**一次性**监听，把带 nonce 的控制台地址开进浏览器；
 * 人在页面里登录（或复用已有会话），页面弹出「允许本地 CLI 使用你的会话」确认，
 * 点允许后页面把 session **POST 回 127.0.0.1**。
 *
 * 两条刻意的设计约束：
 * 1. **服务端一个端点都不加**（AGENTS.md §3）：管理面还是只有手机号 + 口令那条登录路径，
 *    不存在「拿着 nonce 就能换会话」的口子；会话只在浏览器 → 本机回环之间流动，
 *    不经过服务端，也不出现在 URL 里（URL 只有 nonce，且走 #hash 不进服务端访问记录）。
 * 2. **网页侧必须有人点一次「允许」**：否则任何一个本地进程诱导你打开
 *    `<控制台地址>#cli-login?port=<它的端口>` 就能静默拿走你的会话 token。
 *    确认框就是这个流程的 consent screen，不能省。
 *
 * 失败路径一律明确报错，不静默退化成别的登录方式；超时/被拒绝都给出下一步该怎么走。
 */
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse, Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { CliError, EXIT } from './errors.ts'

/** 回调 body 上限：真实 payload 几十字节，给足余量也只到 8 KiB（AGENTS.md §4「超长 body」） */
const MAX_BODY_BYTES = 8 * 1024
/** 允许对方试错几次就整轮失败：挡噪音，也挡拿这个口子穷举 nonce */
const MAX_ATTEMPTS = 8
/** 会话 token 的形状：服务端发的是随机 hex，卡形状比卡长度更有意义 */
const SESSION_RE = /^[0-9a-f]{16,128}$/i

export interface BrowserSession {
  session: string
  phone: string | null
  role: string | null
}

export interface RelayRequest {
  state: string
  port: number
  /** 直接喂给「在浏览器里打开」的完整地址 */
  url: string
  /** 浏览器里那个页面的 origin，用于报错时说明「两边地址不一致」 */
  origin: string
}

export interface WaitOptions {
  baseUrl: string
  timeoutMs: number
  /** 0 / null = 让内核挑临时端口；固定端口只在防火墙策略逼你时才用 */
  callbackPort?: number | null
}

/** 控制台地址 → 回调要校验的 Origin（严格全等，别名地址让用户改成同一个地址而不是放宽校验） */
function originOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin
  } catch {
    return ''
  }
}

/**
 * 登录请求放在 **hash** 里而不是 query 里：hash 不会被发到服务端，
 * 因此不进服务端访问日志，也不进远端控制台的路由分支。
 */
export function buildRelayRequest(baseUrl: string, port: number, state: string): RelayRequest {
  const origin = originOf(baseUrl)
  if (!origin) throw new CliError('EC_USAGE', `baseUrl 无法解析：${baseUrl}`, '如 --base-url http://127.0.0.1:8899', EXIT.USAGE)
  const url = `${origin}/#cli-login?port=${port}&state=${state}`
  return { state, port, url, origin }
}

export function newNonce(): string {
  return randomBytes(24).toString('hex')
}

function clampStr(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (!t || t.length > max) return null
  // 控制字符进来只会污染终端与配置文件，宁可当没有
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(t)) return null
  return t
}

/**
 * 把回调 body 解析成会话（脏输入全在这层挡掉，AGENTS.md §4）。
 * 返回 null 表示「这条不接受」，调用方保持监听继续等——一次坏请求不该毁掉整轮登录。
 *
 * 只有 `state` 与 `session` 是**承重**的：state 必须全等，session 必须是服务端那种 hex。
 * `phone` / `role` 只是页面上的自报信息，形状不对就丢弃（置 null）而不是整条拒掉——
 * 反正命令层最后拿服务端的 /me 覆盖，为了一个显示字段让登录失败只会更糟。
 */
export function parseRelayPayload(raw: unknown, expectedState: string): BrowserSession | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (typeof o.state !== 'string' || o.state !== expectedState) return null
  if (typeof o.session !== 'string' || !SESSION_RE.test(o.session)) return null
  return { session: o.session, phone: clampStr(o.phone, 64), role: clampStr(o.role, 32) }
}

/**
 * 页面点「拒绝」时发回来的那条。
 *
 * 为什么要专门接这一条：**人在页面上明确按了拒绝，CLI 却还要干等到 180 秒超时**，
 * 这既浪费人时间，也把「你拒绝了」和「没人理你」两种完全不同的结果混成同一个报错。
 * `denied` 必须是布尔 `true`——字符串 `"true"` / `1` / 嵌套对象都不算，
 * 免得任何带杂字段的消息就把登录流程结束掉。state 仍然要求全等，
 * 所以第三方拿这个形状也**替不了**你拒绝（nonce 不在这台监听上就是 400）。
 */
export function isRelayDenial(raw: unknown, expectedState: string): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const o = raw as Record<string, unknown>
  return typeof o.state === 'string' && o.state === expectedState && o.denied === true
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  // 响应里没有敏感信息，所以 * 可以让页面读到结果并把状态显示给用户
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  })
  res.end(json)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((fulfill, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body 超过 8 KiB'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => fulfill(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export interface RelayOutcome {
  session: BrowserSession
  /** 浏览器里的地址与 CLI 的 baseUrl 不一致（已在错误里说明，这里只是留给日志） */
  observedOrigin: string
}

function timeoutError(timeoutMs: number): CliError {
  return new CliError(
    'EC_LOGIN_TIMEOUT',
    `${Math.round(timeoutMs / 1000)} 秒内没收到浏览器回传的会话`,
    '常见原因：① 页面没点「允许」（确认框可能被忽略）；② 浏览器打开的是另一个地址（别名 / 端口不同）；' +
      '③ 服务端是旧版本、页面里还没有这段登录接力（重新部署一次）；' +
      '④ 浏览器和这台机器不是同一台——那就改用 printf 口令 | mock login --password-stdin',
    EXIT.AUTH,
  )
}

/** 页面上点了「拒绝」：这是**人的明确决定**，不该和「没人理你」共用一个超时报错 */
function denialError(): CliError {
  return new CliError(
    'EC_LOGIN_DENIED',
    '你在控制台页面里点了「拒绝」，CLI 没有拿到会话',
    '这轮登录已经结束了。确认那个页面确实是你要连的服务之后，重跑 mock login --browser 会换一个新的 nonce 和端口',
    EXIT.AUTH,
  )
}

export interface RelayWaiter {
  /** 要在浏览器里打开的控制台地址（含 nonce 与本机端口） */
  url: string
  port: number
  state: string
  /** 一次有效回调的结果；bind 失败时这个 promise 带着同一个错误 */
  result: Promise<RelayOutcome>
}

/**
 * 起一次性回调监听。
 *
 * 拆成「先 await 拿到地址，再 await 结果」两步，是因为命令层必须**先把地址打出来**：
 * 在没有 GUI 的机器（SSH 会话 / CI）上自动开浏览器会失败，那条地址就是用户唯一的入口。
 *
 * 监听在结果 settle（成功 / 超时 / 校验失败）后必然关闭，并强制断开 keep-alive 连接——
 * 否则浏览器留着的那根连接会让 CLI 拿到会话后继续挂着几十秒。
 */
export async function startRelayWait(opts: WaitOptions): Promise<RelayWaiter> {
  const expectedOrigin = originOf(opts.baseUrl)
  const state = newNonce()
  const wantPort = opts.callbackPort && opts.callbackPort > 0 ? opts.callbackPort : 0
  const timeoutMs = Math.max(1000, Math.min(900_000, Math.floor(opts.timeoutMs)))

  let attempts = 0
  let settled = false
  // 监听句柄在 Promise 执行体里赋值：读取处一律显式收回类型，别让控制流分析判成 null
  let server: Server | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const cleanup = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    const s = server as Server | null
    s?.closeAllConnections?.()
    s?.close()
  }

  let bind!: { resolve: (w: RelayWaiter) => void; reject: (e: CliError) => void }
  const bound = new Promise<RelayWaiter>((resolve, reject) => {
    bind = { resolve, reject }
  })

  const result = new Promise<RelayOutcome>((resolveP, rejectP) => {
    const fail = (err: CliError): void => {
      if (settled) return
      settled = true
      cleanup()
      rejectP(err)
      // bind 都没成功（端口被占 / 权限不足）时，让 startRelayWait 本身也报错，
      // 不然调用方还在那里等一条打印出来的地址
      bind.reject(err)
    }

    server = createServer(async (req, res) => {
      try {
        if (settled) {
          // 已经成功/超时/失败：再来一条只能是噪音或第二次点「允许」。
          // 明确告诉页面「本次登录已结束」，别让它显示成莫名其妙的失败。
          reply(res, 410, { ok: false, error: 'EC_STALE_REQUEST', message: '本次登录已经结束（成功或超时）；刷新页面即可正常使用控制台' })
          return
        }
        if (req.method === 'OPTIONS') {
          // 页面挂在 https 反代下时，Chrome 的私有网络访问（PNA）会先发预检
          const pna = String(req.headers['access-control-request-private-network'] ?? '') === 'true'
          res.writeHead(204, {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'POST, OPTIONS',
            'access-control-allow-headers': 'content-type',
            'access-control-max-age': '0',
            ...(pna ? { 'access-control-allow-private-network': 'true' } : {}),
          })
          res.end()
          return
        }
        const path = String(req.url ?? '').split('?')[0]
        if (req.method !== 'POST' || path !== '/ec-cli-callback') {
          reply(res, 404, { ok: false, error: 'EC_NOT_FOUND' })
          return
        }
        if (attempts >= MAX_ATTEMPTS) {
          reply(res, 403, { ok: false, error: 'EC_CONFLICT', message: '本次登录尝试次数已达上限' })
          fail(
            new CliError(
              'EC_CONFLICT',
              `回调被拒 ${MAX_ATTEMPTS} 次，本次登录取消`,
              '通常是别的页面/进程也在往这个端口投递；重跑 mock login --browser 会换一个 nonce 和端口',
              EXIT.AUTH,
            ),
          )
          return
        }
        attempts++

        const origin = String(req.headers.origin ?? '')
        if (!origin) {
          reply(res, 403, { ok: false, error: 'EC_FORBIDDEN', message: '缺少 Origin 头：回调只接受从控制台页面发起的请求' })
          return
        }
        if (origin !== expectedOrigin) {
          reply(res, 403, {
            ok: false,
            error: 'EC_ORIGIN_MISMATCH',
            message: `浏览器里的控制台地址是 ${origin}，CLI 连的是 ${expectedOrigin}`,
          })
          fail(
            new CliError(
              'EC_ORIGIN_MISMATCH',
              `浏览器用的地址（${origin}）和 CLI 的 baseUrl（${expectedOrigin}）不是同一个`,
              '用 CLI 打印出来的那个地址打开控制台；或让两边一致：mock login --browser --base-url ' + origin,
              EXIT.AUTH,
            ),
          )
          return
        }

        let payload: unknown
        try {
          payload = JSON.parse(await readBody(req))
        } catch (e) {
          reply(res, 400, { ok: false, error: 'EC_BAD_BODY', message: `body 不是合法 JSON 或过大：${(e as Error).message}` })
          return
        }
        const denial = isRelayDenial(payload, state)
        if (denial) {
          // 先给页面回 200（它知道 CLI 收到了），再结束这一轮
          reply(res, 200, { ok: true, denied: true })
          fail(denialError())
          return
        }
        const session = parseRelayPayload(payload, state)
        if (!session) {
          reply(res, 400, { ok: false, error: 'EC_BAD_BODY', message: 'state 不匹配或 session 形状不对' })
          return
        }
        settled = true
        reply(res, 200, { ok: true })
        cleanup()
        resolveP({ session, observedOrigin: origin })
      } catch (e) {
        // 监听里的任何异常都不能变成「进程崩了」的栈：这是网络入口
        if (!res.headersSent) reply(res, 500, { ok: false, error: 'EC_INTERNAL', message: String((e as Error)?.message ?? e) })
        else res.destroy()
      }
    })

    server.on('error', (e: NodeJS.ErrnoException) => {
      const code = e?.code ?? ''
      const detail = code === 'EADDRINUSE' ? `端口 ${wantPort} 已被占用` : e?.message ?? String(e)
      fail(
        new CliError(
          'EC_UNREACHABLE',
          `起不了本机回调监听（127.0.0.1）：${detail}`,
          wantPort > 0
            ? '去掉 --callback-port 让 CLI 自己挑临时端口'
            : '本机防火墙/安全软件可能拦了 node 监听；也可以改用 printf 口令 | mock login --password-stdin',
          EXIT.UNREACHABLE,
        ),
      )
    })

    server.listen(wantPort, '127.0.0.1', () => {
      const addr = (server as Server | null)?.address()
      const port = typeof addr === 'object' && addr ? addr.port : wantPort
      // 超时从「监听成功」起算：bind 之前挂表会让慢机器白白失败
      timer = setTimeout(() => fail(timeoutError(timeoutMs)), timeoutMs)
      bind.resolve({ url: buildRelayRequest(opts.baseUrl, port, state).url, port, state, result })
    })
  })

  // 拿到 waiter 之前 result 就可能已经失败（bind 失败）。挂一个 noop catch 只是为了
  // 避免 unhandled rejection 把进程弄崩；await result 的一方照样拿得到原错误。
  result.catch(() => {})

  return await bound
}

/**
 * 用系统默认浏览器打开地址。
 *
 * **不 await 子进程退出**（浏览器是长命进程），也**不把它当失败**：
 * 在无 GUI 的机器（SSH 会话 / CI）上 spawn 会失败，这时命令只是打印地址让人自己粘贴。
 */
export function openInBrowser(url: string): { ok: boolean; detail: string } {
  const platform = process.platform
  try {
    const child =
      platform === 'darwin'
        ? spawn('open', [url], { stdio: 'ignore', detached: true })
        : platform === 'win32'
          ? spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true, windowsVerbatimArguments: true })
          : spawn('xdg-open', [url], { stdio: 'ignore', detached: true })
    child.on('error', () => {
      // spawn 的异步失败（如 xdg-open 不存在）不影响主流程：地址已经在终端里打出来了
    })
    child.unref()
    return { ok: true, detail: platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open' }
  } catch (e) {
    return { ok: false, detail: String((e as Error)?.message ?? e) }
  }
}
