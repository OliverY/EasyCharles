import { CliError, EXIT, authError } from './errors.ts'

/** 与 server/src/index.ts 的 readJson 上限一致；超了会拿到意义不明的 413，不如在客户端先拦住 */
export const MGMT_BODY_LIMIT_BYTES = 1024 * 1024

export interface CallResult {
  status: number
  json: unknown
  text: string
}

export interface ClientHooks {
  /** 401 时尝试重新登录，返回新会话；拿不到凭据返回 null */
  relogin: () => Promise<string | null>
  /** 服务端换发新会话后回写本地缓存 */
  onSession: (session: string | null) => void
  log: (message: string) => void
}

function causeCode(e: unknown): string {
  const cause = (e as { cause?: { code?: string } } | null)?.cause
  return typeof cause?.code === 'string' ? cause.code : ''
}

/**
 * 管理面 HTTP 客户端（只打 `/__ec/api/*`）。
 *
 * 刻意不碰数据面 `/__ec/p*` 与快照面 `/s/:token`：那两面无鉴权、无状态，
 * 不是配置入口（AGENTS.md §3）。控制面 WebSocket 也不在这里——CLI 走请求-响应式
 * 管理面即可满足 skill 的全部命令。
 */
export class ManagementClient {
  baseUrl: string
  session: string | null
  timeoutMs: number
  hooks: ClientHooks

  constructor(opts: { baseUrl: string; session: string | null; hooks?: Partial<ClientHooks>; timeoutMs?: number }) {
    this.baseUrl = opts.baseUrl
    this.session = opts.session
    this.timeoutMs = opts.timeoutMs ?? 10_000
    this.hooks = {
      relogin: opts.hooks?.relogin ?? (async () => null),
      onSession: opts.hooks?.onSession ?? (() => {}),
      log: opts.hooks?.log ?? (() => {}),
    }
  }

  private buildUrl(path: string, query?: Record<string, string | number | undefined | null>): string {
    const url = new URL(`${this.baseUrl}${path}`)
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null || v === '') continue
        url.searchParams.set(k, String(v))
      }
    }
    return url.toString()
  }

  private async raw(method: string, url: string, body: string | null): Promise<CallResult> {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (this.session) headers['x-ec-session'] = this.session
    if (body !== null) headers['content-type'] = 'application/json; charset=utf-8'

    let res: Response
    try {
      res = await fetch(url, {
        method,
        headers,
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (e) {
      const code = causeCode(e)
      const detail = e instanceof Error ? e.message : String(e)
      throw new CliError(
        'EC_UNREACHABLE',
        `连不上 ${this.baseUrl}（${code || detail}）`,
        // 真机踩过：开发机挂着代理 / VPN 时，局域网地址会被 TUN 网卡整段吞掉，
        // 服务端明明活着（同机 curl 秒回），CLI 却只能等到超时。
        // 只报「检查服务是否启动」会把人引去翻服务端，所以把这两条替代路径写进提示。
        '确认服务已启动、baseUrl 正确，跨机使用需服务端带 --lan 启动；' +
          '若开发机开着代理/VPN（HTTP_PROXY 或 TUN 网卡），局域网地址可能被它截走——' +
          '给命令加上 NO_PROXY=<服务器地址> 再试，或先建隧道 ' +
          'ssh -L 18899:127.0.0.1:8899 <服务器> 再把 baseUrl 指到 http://127.0.0.1:18899',
        EXIT.UNREACHABLE,
      )
    }

    const text = await res.text()
    let json: unknown = null
    if (text) {
      try {
        json = JSON.parse(text)
      } catch {
        json = null
      }
    }
    return { status: res.status, json, text }
  }

  /**
   * 发一次管理面请求。`auth: false` 用于 login（免会话）。
   *
   * 401 只在**第一次**触发自动重登：重登后仍 401 就直接报错，避免出现
   * 「登录 → 401 → 再登录」的循环把服务端会话表刷爆。
   */
  async call(
    method: string,
    path: string,
    opts: { query?: Record<string, string | number | undefined | null>; body?: unknown; auth?: boolean } = {},
  ): Promise<unknown> {
    const wantAuth = opts.auth !== false
    const payload = opts.body === undefined ? null : JSON.stringify(opts.body ?? null)
    // 按**字节**算而不是字符数：中文 mock 返回值里 1 个字符可能是 3 字节，
    // 用 length 估算会在服务端侧变成 413（AGENTS.md §6）
    const payloadBytes = payload === null ? 0 : Buffer.byteLength(payload, 'utf8')
    if (payloadBytes > MGMT_BODY_LIMIT_BYTES) {
      throw new CliError(
        'EC_BODY_TOO_LARGE',
        `请求体 ${(payloadBytes / 1024 / 1024).toFixed(2)} MiB，超过管理面单次上限 1 MiB`,
        '拆小 mock 返回值，或改用 @文件 传入后按条提交',
        EXIT.USAGE,
      )
    }
    const url = this.buildUrl(path, opts.query)
    this.hooks.log(`${method} ${url}`)

    let result = await this.raw(method, url, payload)

    if (result.status === 401 && wantAuth) {
      this.session = null
      this.hooks.onSession(null)
      const fresh = await this.hooks.relogin()
      if (!fresh) {
        throw authError(
          '未登录或会话已失效',
          '先执行 mock login（口令未改时服务默认 123456）',
        )
      }
      this.session = fresh
      this.hooks.onSession(fresh)
      this.hooks.log('会话已刷新，重试原请求')
      result = await this.raw(method, url, payload)
    }

    if (result.status >= 400 || (result.status >= 300 && result.status !== 304)) {
      const body = result.json as Record<string, unknown> | null
      // C14 的五个码在这里一次性折算成 CLI 的码 + 退出码（协议 §6.1）。
      // 不做折算的话，agent 面对「共享项目只读」和「服务端 5xx」要分辩退出码 4 的两种含义。
      // `EC_PROJECT_NOT_FOUND` 并进 `EC_NOT_FOUND`：与「真的不存在」同形是协议刻意选的
      // （不泄露「这个 id 属于别人」），CLI 侧也不该把它拆成两种码。
      const codeMap: Record<string, { code: string; exit: number }> = {
        EC_PROJECT_NOT_FOUND: { code: 'EC_NOT_FOUND', exit: EXIT.SERVER },
        EC_PROJECT_READONLY: { code: 'EC_PROJECT_READONLY', exit: EXIT.PROJECT_READONLY },
        EC_SCOPE_MISMATCH: { code: 'EC_SCOPE_MISMATCH', exit: EXIT.PROJECT_READONLY },
        EC_CONFLICT: { code: 'EC_CONFLICT', exit: EXIT.CONFLICT },
        EC_STORAGE_UNAVAILABLE: { code: 'EC_STORAGE_UNAVAILABLE', exit: EXIT.SERVER },
        EC_UNAUTHORIZED: { code: 'EC_UNAUTHORIZED', exit: EXIT.AUTH },
      }
      const rawCode = body && typeof body.error === 'string' ? body.error : ''
      const mapped = codeMap[rawCode]
      // 404 统一成 EC_NOT_FOUND：服务端这里回的是 `error: 'not found'`（带空格、不可枚举），
      // agent 拿它当错误码匹配很脆；而 CLI 自己「查无此条」也用同一个码（见 errors.ts）
      const serverError =
        mapped?.code ?? (result.status === 404 ? 'EC_NOT_FOUND' : rawCode || `EC_HTTP_${result.status}`)
      const serverMessage = body && typeof body.message === 'string' ? body.message : result.text.slice(0, 300) || `HTTP ${result.status}`
      const exit = mapped?.exit ?? (result.status === 401 || result.status === 403 ? EXIT.AUTH : EXIT.SERVER)
      throw new CliError(
        serverError,
        `服务端返回 ${result.status}：${serverMessage}`,
        exit === EXIT.AUTH ? '执行 mock login 重新登录' : null,
        exit,
      )
    }

    if (result.json === null && result.text) {
      throw new CliError(
        'EC_BAD_RESPONSE',
        `服务端返回的不是 JSON：${result.text.slice(0, 200)}`,
        '确认 baseUrl 指向 EasyCharles 服务而非别的服务',
        EXIT.SERVER,
      )
    }
    return result.json
  }
}
