/**
 * mock CLI 自测。
 *
 * 与 `tools/selftest.ts` 的分工：那个在进程内驱动数据面 handler；这个**真起一个服务端子进程、
 * 真跑 mock 命令行**，断言「退出码 + stdout + stderr」——这三样就是 CLI 对 agent 的契约。
 *
 * 覆盖按 AGENTS.md §6：每条正常路径旁边放一条脏输入 / 边界路径。
 * 用法：`cd server && node tools/mock-cli/selftest.ts`
 */
import { spawn, spawnSync } from 'node:child_process'
import { request } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { materialize, parseArgs, peekFlag } from './cli/args.ts'
import { CliError } from './cli/errors.ts'
import { ConfigStore, SESSION_TTL_MS, normalizeBaseUrl, sessionIdOrNull } from './cli/config.ts'
import { ManagementClient } from './cli/client.ts'
import { expectList, fmtTime, splitUrl } from './cli/guards.ts'
import { buildRelayRequest, isRelayDenial, newNonce, parseRelayPayload, startRelayWait } from './cli/browser-login.ts'
import { pickGroup, readGroupTable, readGroups } from './cli/commands/group.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER_DIR = resolve(HERE, '..', '..')
const MOCK_BIN = join(HERE, 'mock.ts')

const PORT = 18931
const BASE_URL = `http://127.0.0.1:${PORT}`
// 自测起服务端与登录用的**假口令**（AGENTS.md §2：不是任何真实凭据）。
// 下面这些行故意带上「假口令」三个字：pre-commit 的「疑似明文口令赋值」是**按行**放行的
//（含「口令 / 假值 / 占位 / example / xxx」即跳过）。那个检查本身是对的，别为它闭嘴去改正则。
const PASSWORD = 'selftest-pw' // 自测假口令，不是任何真实凭据
// 明显的假号（AGENTS.md §2）：三个空间用来测归属边界
const PHONE = '13800000000'
const PHONE_B = '13900000000'
const PHONE_ADMIN = '13700000000'

let passed = 0
let failed = 0

function check(name: string, ok: boolean, extra = ''): void {
  if (ok) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${extra ? `  → ${extra}` : ''}`)
  }
}

function section(title: string): void {
  console.log(`\n${title}`)
}

interface Run {
  code: number
  out: string
  err: string
  timedOut: boolean
}

/**
 * 跑一次 CLI。stdio 一律走管道 → 子进程的 stdin 必然不是 TTY，
 * 正好复现「AI agent / 脚本调用」的场景（也是最容易卡死的一种）。
 *
 * `config` 为空串以外时自动注入 `--config <path>`（若参数里没写），
 * 保证任何用例都不会误写进真实 `~/.mock-cli`——这个坑已经踩过一次。
 *
 * `closeStdoutEarly`：spawn 后**立刻**关掉读端，模拟 `mock … | head -1` 这类
 * 下游提前退出的管道。放在 spawn 之后、子进程还在启动的路上就关，
 * 因此子进程的第一次写入必然撞上已关闭的管道——比 `| head` 稳定（那条会 Races）。
 */
function cli(
  args: string[],
  opts: { config?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number; closeStdoutEarly?: boolean } = {},
): Promise<Run> {
  const timeoutMs = opts.timeoutMs ?? 12_000
  const finalArgs =
    opts.config && !args.includes('--config') ? [...args, '--config', opts.config] : args
  return new Promise((fulfill) => {
    const child = spawn(process.execPath, [MOCK_BIN, ...finalArgs], {
      cwd: SERVER_DIR,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    let timedOut = false
    if (opts.closeStdoutEarly) child.stdout?.destroy()
    else child.stdout.on('data', (c: Buffer) => (out += c.toString()))
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已退出 */
      }
      fulfill({ code: -1, out, err: `${err}\n[挂起超过 ${timeoutMs}ms]`, timedOut })
    }, timeoutMs)
    child.stderr.on('data', (c: Buffer) => (err += c.toString()))
    child.on('error', (e) => {
      clearTimeout(timer)
      fulfill({ code: -1, out, err: String(e), timedOut: false })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      fulfill({ code: code ?? -1, out, err, timedOut })
    })
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin)
    else child.stdin.end()
  })
}

function okJson(run: Run): Record<string, unknown> | null {
  try {
    return JSON.parse(run.out.trim()) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * 扮演控制台页面往本机回环投递一次（ADR-029 的那一步「点允许」）。
 *
 * 用 `node:http` 而不是 `fetch`：undici 把 `Origin` 列为 forbidden header 会静默丢掉，
 * 而 Origin 正是这段逻辑的判据之一——用会被吞掉头的客户端去测「按头校验」是假绿。
 */
function pagePost(
  port: number,
  body: string,
  opts: { path?: string; method?: string; origin?: string | null } = {},
): Promise<number> {
  return new Promise((fulfill) => {
    const headers: Record<string, string> = { 'content-type': 'text/plain;charset=UTF-8' }
    if (opts.origin !== null) headers.origin = opts.origin ?? BASE_URL
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: opts.path ?? '/ec-cli-callback',
        method: opts.method ?? 'POST',
        headers,
        timeout: 6000,
      },
      (res) => {
        res.resume()
        res.on('end', () => fulfill(res.statusCode ?? 0))
      },
    )
    req.on('error', () => fulfill(-1))
    req.on('timeout', () => {
      req.destroy()
      fulfill(-1)
    })
    req.end(body)
  })
}

interface RelayRun extends Run {
  url: string
  port: number
  state: string
  /** 页面那几次投递拿到的 HTTP 状态码（连接被拒 = -1） */
  codes: number[]
}

/**
 * 跑 `login --browser` 并**扮演控制台页面**：CLI 把 relay 地址打到 stderr，
 * 一出现就按 play 的脚本往那个回环端口投递。
 *
 * play 不给 = 什么都不投（用来验超时）。
 */
function cliRelay(
  args: string[],
  opts: {
    config: string
    env?: Record<string, string>
    timeoutMs?: number
    play?: (h: { port: number; state: string; post: (body: string, o?: { path?: string; method?: string; origin?: string | null }) => Promise<number> }) => Promise<void>
  },
): Promise<RelayRun> {
  const timeoutMs = opts.timeoutMs ?? 30_000
  return new Promise((fulfill) => {
    const child = spawn(process.execPath, [MOCK_BIN, ...args, '--config', opts.config], {
      cwd: SERVER_DIR,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    const codes: number[] = []
    let fired = false
    let url = ''
    let port = 0
    let state = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已退出 */
      }
      fulfill({ code: -1, out, err: `${err}\n[挂起超过 ${timeoutMs}ms]`, timedOut, url, port, state, codes })
    }, timeoutMs)
    child.stdout.on('data', (c: Buffer) => (out += c.toString()))
    child.stderr.on('data', (c: Buffer) => {
      err += c.toString()
      if (fired) return
      const m = /#cli-login\?port=(\d+)&state=([0-9a-f]{16,64})/.exec(err)
      if (!m) return
      fired = true
      port = Number(m[1])
      state = m[2]
      url = `${BASE_URL}/#cli-login?port=${port}&state=${state}`
      const post = (body: string, o?: { path?: string; method?: string; origin?: string | null }) =>
        pagePost(port, body, o).then((c) => {
          codes.push(c)
          return c
        })
      if (opts.play) void opts.play({ port, state, post })
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      fulfill({ code: -1, out, err: String(e), timedOut: false, url, port, state, codes })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      fulfill({ code: code ?? -1, out, err, timedOut: false, url, port, state, codes })
    })
    child.stdin.end()
  })
}

/** 错误契约：--json/--quiet 下 stdout 必须干净，错误是一行带 code 的 JSON，写在 stderr */
function errJson(run: Run): Record<string, unknown> | null {
  const line = run.err.split('\n').find((l) => l.startsWith('{'))
  if (!line) return null
  try {
    return JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }
}

function startServer(dataDir: string): { kill: () => void } {
  // --admin：只有管理员能看见「别人空间的设备」。CLI 侧那条「看得见但不是你的」
  // 守卫分支（bind/unbind 的 EC_CONFLICT）在普通用户视角下不可达，必须有管理员空间才测得到。
  const child = spawn(
    process.execPath,
    [join(SERVER_DIR, 'src', 'index.ts'), '--port', String(PORT), '--data-dir', dataDir, '--password', PASSWORD, '--admin', PHONE_ADMIN],
    { cwd: SERVER_DIR, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let log = ''
  child.stdout?.on('data', (c: Buffer) => (log += c.toString()))
  child.stderr?.on('data', (c: Buffer) => (log += c.toString()))
  child.on('error', (e) => (log += String(e)))
  return {
    kill: () => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已退出 */
      }
    },
  }
}

async function waitServer(tries = 80): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${BASE_URL}/about`, { signal: AbortSignal.timeout(500) })
      if (res.status === 200) return true
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
}

/** `PORT` 上到底是谁：没人 / 上一轮泄漏的本自测服务端 / 别人的服务（或认不出来） */
type PortOwner = { kind: 'free' } | { kind: 'ours'; pid: string; dataDir: string; dataDirAlive: boolean } | { kind: 'other'; pid: string }

/**
 * 起服务端之前先证明「这个端口是我们的」。
 *
 * 这个坑是**真踩到的**：`node tools/mock-cli/selftest.ts | head -40` 会提前关掉管道，
 * 自测进程被 SIGPIPE 打断在 `finally` 之前，于是它 spawn 的那台服务端**留在了 18931 上**
 * （`child.kill()` 根本没执行）。下一次运行 `waitServer()` 照样等到 200 —— 但它探测到的是
 * **上一轮那台带着旧数据的服务器**，于是 C-08 / C-09 里「设备表只有两台」「记录只有两条」
 * 这类计数断言全部对着旧现场变红，看起来像代码坏了，其实是环境脏了。
 *
 * 判据不敢靠服务端自报（`/about` 是静态页，里面本来就有 `--password` 这段说明文字），
 * 所以走进程表：命令行里同时带 `src/index.ts`、`--port <我们的端口>`、`--password <我们的假口令>`
 * 才算「我们的」。`--password selftest-pw` 是本自测独有的签名（文件头注释说明它是假口令），
 * 开发中的 8899 或任何别的实例都对不上，因此不会被误杀。
 *
 * 认出来之后**默认不动它**——杀进程是破坏性动作，而且它也可能是**另一次正在跑的自测**
 * （看 `dataDirAlive`：数据目录还在就说明那边可能还活着）。要清理请显式给
 * `EC_SELFTEST_KILL_STALE=1`。「应答了但不是我们的」一律拒绝：在别人身上跑一堆写操作，
 * 结果既不是被测代码的结论，也不是可复现的结论。
 */
async function portOwner(): Promise<PortOwner> {
  let answering = false
  try {
    answering = (await fetch(`${BASE_URL}/about`, { signal: AbortSignal.timeout(800) })).status === 200
  } catch {
    /* 连不上 = 没人听，正常 */
  }
  if (!answering) return { kind: 'free' }
  const ps = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  const portRe = new RegExp(`--port\\s+${PORT}(\\s|$)`)
  for (const line of (ps.stdout ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    const cmd = m[2] ?? ''
    if (cmd.includes('src/index.ts') && portRe.test(cmd) && cmd.includes(`--password ${PASSWORD}`)) {
      const dir = (/--data-dir\s+(\S+)/.exec(cmd) ?? [, ''])[1] ?? ''
      return { kind: 'ours', pid: m[1] ?? '', dataDir: dir, dataDirAlive: !!dir && existsSync(dir) }
    }
  }
  return { kind: 'other', pid: '' }
}

/** 返回 `true` 表示可以继续（端口是空的，或脏端口已按显式 opt-in 清干净） */
async function assertPortOwnership(): Promise<boolean> {
  let owner = await portOwner()
  if (owner.kind === 'free') return true
  if (owner.kind === 'other') {
    console.log(`  ${BASE_URL} 上有一个**不是本自测起的**服务在应答，拒绝在它身上跑写操作。`)
    console.log('  换端口跑，或把占用 18931 的进程停掉：lsof -nP -iTCP:18931 -sTCP:LISTEN')
    return false
  }
  if (process.env.EC_SELFTEST_KILL_STALE !== '1') {
    console.log(`  ${BASE_URL} 上是**上一轮泄漏的本自测服务端**（pid ${owner.pid}，数据目录 ${owner.dataDir || '未知'}）。`)
    console.log(`  它带着上一轮的设备表与抓包记录，计数类断言会全部假红。人工清理：kill ${owner.pid}`)
    console.log('  或确认那不是正在跑的另一轮自测后用 EC_SELFTEST_KILL_STALE=1 重跑（本脚本会替你 SIGKILL 它）。')
    if (owner.dataDirAlive) console.log('  注意：它的数据目录还在，有可能**另一轮自测正在跑**，别直接杀。')
    return false
  }
  console.log(`  EC_SELFTEST_KILL_STALE=1：停掉泄漏的本自测服务端 pid ${owner.pid}`)
  try {
    process.kill(Number(owner.pid), 'SIGKILL')
  } catch {
    /* 已经退出了 */
  }
  for (let i = 0; i < 40; i++) {
    owner = await portOwner()
    if (owner.kind === 'free') return true
    if (owner.kind === 'other') return false
    await new Promise((r) => setTimeout(r, 100))
  }
  console.log(`  杀完仍在应答（pid ${owner.kind === 'ours' ? owner.pid : '?'}），放弃本轮。`)
  return false
}

function touchProject(id: string, baseUrl: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, name: id, baseUrl, phone: null, session: null, sessionAt: null, lastUsedAt: null, ...extra }
}

/**
 * 绕过 CLI 直接打管理面，用来**布置现场**（建规则、注册设备、造记录）。
 * 故意不走 CLI 的写命令：`api create` 属 P2，用还没实现的功能去测已实现的功能是假绿。
 */
async function rawLogin(phone: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/__ec/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone, password: PASSWORD }), // 假口令，见文件头 PASSWORD 的注释
  })
  const json = (await res.json()) as { session?: string }
  return json.session ?? ''
}

async function rawCall(method: string, path: string, session: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: session ? { 'content-type': 'application/json', 'x-ec-session': session } : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = text
  }
  return { status: res.status, json }
}

/** SDK 握手：让设备出现在服务端设备表里 */
async function hello(deviceId: string, sessionId: string, deviceName: string): Promise<void> {
  await rawCall('POST', '/__ec/hello', '', { identity: { deviceId, sessionId, os: 'android', model: 'Pixel 7', deviceName } })
}

/** 走数据面打一条真实请求（命中 mock 时不碰上游），用来产生抓包记录 */
async function dataGet(target: string, deviceId: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`${BASE_URL}/__ec/p${new URL(target).pathname}`, {
    headers: { 'x-ec-target': target, 'x-ec-device-id': deviceId },
  })
  return { status: res.status, body: await res.text() }
}

/** 反复用：CLI 调用统一带上 BASE_URL，避免默认 project 指到 8899 */
function at(...args: (string | number)[]): string[] {
  return [...args.map(String), '--base-url', BASE_URL]
}

/**
 * 自测侧独立实现的「终端列宽」。
 *
 * 它不参与渲染，只**量 CLI 已经打印出来的那一行**：断言的是「同一列在各行占同样的
 * 视觉列」这个结果，所以即便列宽规则与 CLI 里那份一致，也不是拿实现自证——
 * 表格没调用补齐、列顺序变了、漏了 trimEnd 都会让它红。
 */
function visibleWidth(str: string): number {
  let w = 0
  for (const ch of str) {
    const cp = ch.codePointAt(0) ?? 0
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xe000 && cp <= 0xf8ff) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
    w += wide ? 2 : 1
  }
  return w
}

/** 「在线」列（✓）在本行的起始位置，分别按字符数和终端列数量一遍 */
function onlineColOffset(line: string): { chars: number; visible: number } {
  const i = line.indexOf('✓')
  return { chars: [...line.slice(0, i)].length, visible: visibleWidth(line.slice(0, i)) }
}

/**
 * 把配置里当前 project 的会话换成一个**形状合法但服务端不认识**的 token，
 * 并把 `sessionAt` 刷新（不让 CLI 侧 TTL 抢先把会话判死）。
 *
 * 为什么需要它：ADR-031 之后「重启服务端」不再是会话失效的来源（同 dataDir 重启会照旧承认），
 * 而 CLI 的「401 → 自动重登」这条能力还得继续验。用「清过盘 / 换了实例 / 服务端侧过期」
 * 的等价形态来驱动，比依赖服务端内存态稳。
 */
function writeStaleSession(cfgPath: string, token: string): void {
  const raw = JSON.parse(readFileSync(cfgPath, 'utf8')) as {
    defaults?: { project?: string }
    projects?: { baseUrl?: string; session?: string | null; sessionAt?: number | null }[]
  }
  const list = raw.projects ?? []
  const target =
    list.find((p) => p && (raw.defaults?.project ? (p as { id?: string }).id === raw.defaults?.project : false)) ??
    list.find((p) => p?.baseUrl === BASE_URL) ??
    list[0]
  if (!target) throw new Error('配置里没有可用 project，造不出失效会话')
  target.session = token
  target.sessionAt = Date.now()
  writeFileSync(cfgPath, JSON.stringify(raw, null, 2), 'utf8')
}

async function main(): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), 'ec-cli-selftest-'))
  const cfg = join(work, 'config.json')
  const dataDir = join(work, 'srvdata')
  let server: { kill: () => void } | null = null

  // 被**打断**时也要带走自己 spawn 的服务端：`node tools/mock-cli/selftest.ts | head -40`
  // 会提前关管道，写 stdout 抛 EPIPE，`finally` 里的 `server?.kill()` 跟着一起没跑到——
  // 于是 18931 上留着一台带旧数据的服务端，下一轮全绿变假红。`exit` 事件里只能跑同步代码，
  // `child.kill()` 正好是同步的。端口守卫（`assertPortOwnership`）是这道防线之外的兜底。
  process.on('exit', () => {
    try {
      server?.kill()
    } catch {
      /* 子进程已退出 */
    }
  })

  try {
    // ────────────────────────────────────────────────
    section('[C-01] 参数解析：重复 flag、@文件、未知 flag')

    const rep = parseArgs(['--json-list', 'a', '--json-list', 'b', '--json-list', 'c'], { 'json-list': 'list' })
    check('重复 flag 按出现顺序累积成数组', JSON.stringify(rep.flags['json-list']) === JSON.stringify(['a', 'b', 'c']), JSON.stringify(rep.flags))

    let unknownFlagThrew = ''
    try {
      parseArgs(['--nope'], {})
    } catch (e) {
      unknownFlagThrew = e instanceof CliError ? e.code : 'not-CliError'
    }
    check('未知 flag 报 EC_USAGE（不静默忽略）', unknownFlagThrew === 'EC_USAGE', unknownFlagThrew)

    const eq = parseArgs(['--phone=13800000000', '--json'], { phone: 'string' })
    check('--flag=value 形式可用', eq.flags.phone === '13800000000' && eq.flags.json === true, JSON.stringify(eq.flags))

    const boolWithEq = (() => {
      try {
        parseArgs(['--json=yes'], {})
        return ''
      } catch (e) {
        return e instanceof CliError ? e.code : 'x'
      }
    })()
    check('开关型 flag 带取值时报错', boolWithEq === 'EC_USAGE', boolWithEq)

    const bodyFile = join(work, 'body.json')
    writeFileSync(bodyFile, '{"hello":"世界"}', 'utf8')
    check('@文件 读入内容', materialize(`@${bodyFile}`) === '{"hello":"世界"}')
    const matErr = (() => {
      try {
        materialize('@/definitely/not/here.json')
        return ''
      } catch (e) {
        return e instanceof CliError ? e.code : 'x'
      }
    })()
    check('@不存在的文件 报 EC_USAGE 而不是崩栈', matErr === 'EC_USAGE', matErr)
    check('普通值原样返回（不带 @ 时不碰文件系统）', materialize('{"a":1}') === '{"a":1}')

    const listFromFile = parseArgs(['--json-list', `@${bodyFile}`, '--json-list', 'inline'], { 'json-list': 'list' })
    check('list 里逐项 materialize，混用 @文件 与字面量', JSON.stringify(listFromFile.flags['json-list']) === JSON.stringify(['{"hello":"世界"}', 'inline']))

    check('peekFlag 取 --config <path>', peekFlag(['whoami', '--config', '/tmp/x.json'], 'config') === '/tmp/x.json')
    check('peekFlag 取 --config=<path>', peekFlag(['--config=/tmp/y.json'], 'config') === '/tmp/y.json')
    check('peekFlag 末位缺值返回 null', peekFlag(['whoami', '--config'], 'config') === null)

    // ────────────────────────────────────────────────
    section('[C-02] 配置文件：脏数据、降级、解析优先级')

    const dirty = join(work, 'dirty.json')
    writeFileSync(dirty, '{ this is not json', 'utf8')
    const recovered = ConfigStore.load(dirty)
    check('坏 JSON 不致命：给出 warning 并用空配置继续', recovered.warnings.length === 1 && recovered.data.projects.length === 0, JSON.stringify(recovered.warnings))
    check('坏 JSON 已改名备份，证据不丢', readdirSync(work).some((f) => f.startsWith('dirty.json.broken-')), readdirSync(work).join(','))
    check('原坏文件不再占着路径（下次 save 能正常落盘）', !existsSync(dirty))

    const mixed = join(work, 'mixed.json')
    writeFileSync(
      mixed,
      JSON.stringify({
        version: 1,
        defaults: { project: 'ghost', group: 'g1' },
        projects: [
          42,
          null,
          [],
          { id: 'ok1', baseUrl: BASE_URL, phone: '13800000000', session: 'fresh', sessionAt: Date.now() },
          { id: 'nourl', baseUrl: '', name: '没有 url' },
          { id: 'badurl', baseUrl: 'ht!tp://x', name: '坏 url' },
          { baseUrl: 'http://a.b:1', name: '没有 id' },
          { id: 'ok1', baseUrl: 'http://dup.example:1', name: '重复 id' },
          { id: 'stale', baseUrl: 'http://c.d:2', session: 'old', sessionAt: Date.now() - SESSION_TTL_MS - 1000 },
          { id: 'badts', baseUrl: 'http://e.f:3', session: 's', sessionAt: '昨天' },
        ],
      }),
      'utf8',
    )
    const m = ConfigStore.load(mixed)
    const ids = m.data.projects.map((p) => p.id)
    check('只保留合法条目，脏条目被丢掉', JSON.stringify(ids) === JSON.stringify(['ok1', 'stale', 'badts']), JSON.stringify(ids))
    check('重复 id 只留第一个', m.data.projects.filter((p) => p.id === 'ok1').length === 1)
    check('defaults 指向不存在的 project 时被清空（不拿幽灵 id 去请求）', m.data.defaults.project === null)
    check('defaults.group 正常字符串保留', m.data.defaults.group === 'g1')
    check('超龄会话按「无会话」处理，避免拿旧 token 反复撞 401', sessionIdOrNull(m.projectById('stale')) === null)
    check('sessionAt 是脏字符串时不因脏值放行，也不崩', sessionIdOrNull(m.projectById('badts')) === m.projectById('badts')?.session)
    check('正常会话可用', sessionIdOrNull(m.projectById('ok1')) === 'fresh')
    check('list 里存在被忽略条目时给出 warning', m.warnings.some((w) => w.includes('忽略')), JSON.stringify(m.warnings))

    let urlErr = ''
    for (const bad of ['', '   ', 'ftp://127.0.0.1:8899', 'not a url', 'http://', '127.0.0.1:8899']) {
      try {
        normalizeBaseUrl(bad)
        urlErr += `漏过:${bad} `
      } catch (e) {
        if (!(e instanceof CliError && e.code === 'EC_USAGE')) urlErr += `错码:${bad} `
      }
    }
    check('非法 baseUrl 一律 EC_USAGE', urlErr === '', urlErr)
    check('尾斜杠/hash 归一，避免同机重复 project', normalizeBaseUrl(`${BASE_URL}/#/rule/1`) === BASE_URL)

    const multi = join(work, 'multi.json')
    writeFileSync(
      multi,
      JSON.stringify({
        version: 1,
        defaults: { project: null, group: null },
        projects: [touchProject('a', 'http://127.0.0.1:1001'), touchProject('b', 'http://127.0.0.1:1002')],
      }),
      'utf8',
    )
    const ms = ConfigStore.load(multi)
    const prioErr = (() => {
      try {
        ms.resolveProject({ baseUrl: null, projectId: null })
        return ''
      } catch (e) {
        return e instanceof CliError ? `${e.code}|${e.hint}` : 'x'
      }
    })()
    check('多台且无默认 → 报错并提示 mock set project（而不是随机挑一台）', prioErr.startsWith('EC_USAGE|') && prioErr.includes('mock set project'), prioErr)
    check('--project-id 优先于默认', ms.resolveProject({ baseUrl: null, projectId: 'b' }).id === 'b')
    check('--base-url 命中已登记项', ms.resolveProject({ baseUrl: 'http://127.0.0.1:1002', projectId: null }).id === 'b')
    ms.setDefaultProject('a')
    const resolvedDefault = ms.resolveProject({ baseUrl: null, projectId: null }).id
    check('显式参数 > 默认值', ms.resolveProject({ baseUrl: null, projectId: 'b' }).id === 'b' && resolvedDefault === 'a')
    check('按名字也能命中 project（findProject 支持 name）', ms.resolveProject({ baseUrl: null, projectId: 'b' }).name === 'b')
    const unknownProj = (() => {
      try {
        ms.resolveProject({ baseUrl: null, projectId: 'ghost' })
        return ''
      } catch (e) {
        return e instanceof CliError ? e.message : 'x'
      }
    })()
    check('引用不存在的 project 时报错并列出可用', unknownProj.includes('ghost') && unknownProj.includes('project'), unknownProj)

    // ────────────────────────────────────────────────
    section('[C-03] 端到端：真起服务端 + 真跑命令')

    // 先证明端口是自己的，再 spawn（见 assertPortOwnership 的注释：脏端口会让计数断言假红）
    if (!(await assertPortOwnership())) {
      console.log('  端口归属没确认，**跳过全部端到端用例**（本轮结论不作数）')
      // 「跳过」不能报成绿灯：这一轮里 C-03 之后的用例一条都没跑
      process.exitCode = 1
      return
    }

    server = startServer(dataDir)
    const up = await waitServer()
    check(`${BASE_URL} 已就绪`, up)
    if (!up) {
      console.log('  服务端没起来，跳过端到端用例（本轮结论不作数）')
      process.exitCode = 1
      return
    }

    const login = await cli(['login', '--config', cfg, '--base-url', BASE_URL, '--phone', PHONE, '--password', PASSWORD, '--json'], { config: cfg })
    check('login 退出码 0', login.code === 0, `${login.code} ${login.err}`)
    check('login --json 结果可解析且 sessionCached', okJson(login)?.sessionCached === true, login.out + login.err)
    check('会话写进 --config 指定路径', existsSync(cfg), cfg)
    check('落盘权限 0600（里面是管理面会话 token）', (statSync(cfg).mode & 0o777) === 0o600, (statSync(cfg).mode & 0o777).toString(8))

    const homeProbe = join(work, 'fakehome')
    const isolated = await cli(['version', '--json'], { config: '', env: { EC_MOCK_HOME: homeProbe } })
    check('EC_MOCK_HOME 决定默认配置目录（不硬写 ~/.mock-cli）', okJson(isolated)?.configPath === join(homeProbe, 'config.json'), JSON.stringify(okJson(isolated)))

    const who = await cli(['whoami', '--config', cfg, '--json'], { config: cfg })
    const whoJson = okJson(who)
    check('whoami 复用缓存会话（不再要口令）', who.code === 0 && whoJson?.role === 'user', `${who.code} ${who.err}`)
    const srv = whoJson?.server as Record<string, unknown> | undefined
    check('whoami 回显服务端 port/protocol', srv?.port === PORT && srv?.protocol === 2, JSON.stringify(srv))

    const badpw = await cli(['login', '--config', cfg, '--base-url', BASE_URL, '--phone', PHONE, '--password', 'wrong', '--json'], { config: cfg })
    check('口令错 → 退出码 3', badpw.code === 3, String(badpw.code))
    check('口令错 → stdout 干净、错误 JSON 在 stderr', badpw.out === '' && errJson(badpw)?.error === 'EC_UNAUTHORIZED', `${badpw.out}|${badpw.err}`)
    check('错误里带可执行的 hint', String(errJson(badpw)?.hint).includes('123456'), String(errJson(badpw)?.hint))
    const stillOk = await cli(['whoami', '--config', cfg, '--json'], { config: cfg })
    check('失败的 login 不污染已有会话', stillOk.code === 0 && okJson(stillOk)?.role === 'user', `${stillOk.code} ${stillOk.err}`)

    // group 在 C13 已实现，「未实现」样本改用仍未落地的 f2e（P4）
    const stub = await cli(['f2e', 'search', '--config', cfg, '--json'], { config: cfg })
    check('未实现命令 → 退出码 64', stub.code === 64, `${stub.code} ${stub.err}`)
    const stubCreate = await cli(['api', 'create', '--config', cfg, '--json'], { config: cfg })
    check('api create 已实现：缺返回值是 EC_USAGE（2）而不是「功能未实现」（64）',
      stubCreate.code === 2 && errJson(stubCreate)?.error === 'EC_USAGE', `${stubCreate.code} ${stubCreate.err}`)
    check('未实现命令给替代方案而不是空报错', String(errJson(stub)?.hint).length > 4, String(errJson(stub)?.hint))
    const stubPhase = await cli(['f2e', 'search', '--config', cfg, '--json'], { config: cfg })
    check('stub 报错里标注计划阶段（P4）', stubPhase.code === 64 && String(errJson(stubPhase)?.message).includes('P4'), `${stubPhase.code} ${stubPhase.err}`)
    // group disable-all 是**刻意不做**（ADR-030）：注册着但明确 64，不能掉进「未知子命令」的 2
    const disableAll = await cli(['group', 'disable-all', '--config', cfg, '--json'], { config: cfg })
    check('group disable-all 明确报 64 并给出「整组停」的替代做法',
      disableAll.code === 64 && errJson(disableAll)?.error === 'EC_NOT_IMPLEMENTED' && String(errJson(disableAll)?.hint).includes('group switch'),
      `${disableAll.code} ${disableAll.err}`)

    const unknownCmd = await cli(['frobnicate', '--config', cfg, '--json'], { config: cfg })
    check('未知命令 → 退出码 2 并列出可用命令', unknownCmd.code === 2 && String(errJson(unknownCmd)?.message).includes('frobnicate'), `${unknownCmd.code} ${unknownCmd.err}`)
    const unknownArg = await cli(['whoami', '--config', cfg, '--nope', '--json'], { config: cfg })
    check('未知参数 → 退出码 2', unknownArg.code === 2 && errJson(unknownArg)?.error === 'EC_USAGE', `${unknownArg.code} ${unknownArg.err}`)

    const noArgs = await cli([], { config: cfg })
    check('空命令 → 打印帮助并退出码 2', noArgs.code === 2 && noArgs.out.includes('用法'), String(noArgs.code))
    const pureEmpty = await cli([], { config: '' })
    check('真·无参数也是帮助 + 退出码 2（且不写任何配置文件）', pureEmpty.code === 2 && pureEmpty.out.includes('用法'), String(pureEmpty.code))
    const flagFirst = await cli(['--config', cfg, 'frobnicate'], { config: '' })
    check('flag 写在命令前 → 提示用法而不是「未知命令：--config」', flagFirst.code === 2 && flagFirst.out.includes('用法') && flagFirst.err.includes('命令要写在最前面'), `${flagFirst.code}|${flagFirst.err}`)
    const flagFirstJson = await cli(['--config', cfg, '--json'], { config: '' })
    check('flag 写在命令前 + --json → 给 EC_USAGE 而不是灌一整屏帮助', flagFirstJson.code === 2 && errJson(flagFirstJson)?.error === 'EC_USAGE' && String(errJson(flagFirstJson)?.hint).includes('mock help'), `${flagFirstJson.code}|${flagFirstJson.out.slice(0, 60)}`)
    const helpCmd = await cli(['help', '--config', cfg], { config: cfg })
    check('help 里写明退出码契约', helpCmd.code === 0 && helpCmd.out.includes('退出码'), String(helpCmd.code))
    check('help 如实标出未实现命令（不假装可用）', helpCmd.out.includes('📅'), helpCmd.out.slice(0, 120))
    const helpTopic = await cli(['help', 'api', '--config', cfg, '--json'], { config: cfg })
    check('help <命令> 可查单条命令状态', helpTopic.code === 0 && okJson(helpTopic)?.status === 'ready', `${helpTopic.code} ${helpTopic.out}`)
    const helpStub = await cli(['help', 'f2e', '--config', cfg, '--json'], { config: cfg })
    check('help 对仍未实现的 f2e 如实标 stub（不假装可用）', helpStub.code === 0 && okJson(helpStub)?.status === 'stub', `${helpStub.code} ${JSON.stringify(okJson(helpStub))?.slice(0, 120)}`)
    check('help <命令> 列出每个子命令的实现状态', Array.isArray((okJson(helpTopic)?.subs as unknown[]) ?? null) && String(helpTopic.out).length > 0)
    const helpGroup = await cli(['help', 'group', '--config', cfg, '--json'], { config: cfg })
    const helpGroupSubs = ((okJson(helpGroup)?.subs as Record<string, unknown>[] | undefined) ?? []).map((x) => String(x.name))
    check('help group 已实现（status=ready）且逐条列出 C14 的 12 个子命令 + disable-all（stub）',
      helpGroup.code === 0 && okJson(helpGroup)?.status === 'ready' && helpGroupSubs.length === 13 &&
        ['copy', 'share', 'history', 'rollback', 'archive'].every((x) => helpGroupSubs.includes(x)),
      JSON.stringify(helpGroupSubs))
    const helpGroupHuman = await cli(['help', 'group', '--config', cfg], { config: cfg })
    const disableAllRow = String(JSON.stringify(((okJson(helpGroup)?.subs as Record<string, unknown>[] | undefined) ?? []).find((s) => s.name === 'disable-all') ?? {}))
    check('help group 的 disable-all 子条目如实标 stub / 阶段「不做」并给出替代做法（状态不撒谎）',
      disableAllRow.includes('"stub"') && disableAllRow.includes('不做') && disableAllRow.includes('group switch'), disableAllRow.slice(0, 200))
    check('人类模式的 help group 用 📅 把没做的那条标出来（不混在已实现里）',
      helpGroupHuman.code === 0 && helpGroupHuman.out.includes('📅') && helpGroupHuman.out.includes('disable-all'), helpGroupHuman.out.slice(0, 240))
    const helpHuman = await cli(['help', 'device', '--config', cfg], { config: cfg })
    check('help <命令> 人类模式逐条列出子命令与替代做法', helpHuman.code === 0 && helpHuman.out.includes('rename') && helpHuman.out.includes('📅P3'), helpHuman.out.slice(0, 200))
    const helpMissing = await cli(['help', 'nonexistent', '--config', cfg], { config: cfg })
    check('help 不存在的命令 → 退出码 2', helpMissing.code === 2, String(helpMissing.code))

    const projList = await cli(['project', 'list', '--check', '--config', cfg, '--json'], { config: cfg })
    const projects = (okJson(projList)?.projects ?? []) as Record<string, unknown>[]
    check('project list --check 探到在线', projList.code === 0 && projects.some((x) => x.reachable === true), JSON.stringify(okJson(projList))?.slice(0, 200))
    check('project list 标出默认项', projects.some((x) => x.isDefault === true))

    const setProj = await cli(['set', 'project', (projects[0]?.id as string) ?? 'a', '--config', cfg, '--json'], { config: cfg })
    check('set project 写入默认值', setProj.code === 0 && !!okJson(setProj)?.defaultProject, `${setProj.code} ${setProj.err}`)
    const setGhost = await cli(['set', 'project', 'ghost', '--config', cfg, '--json'], { config: cfg })
    check('set project 到不存在的 id → 退出码 2 并列出可选', setGhost.code === 2 && String(errJson(setGhost)?.hint).includes('mock project'), `${setGhost.code} ${setGhost.err}`)
    const setGroup = await cli(['set', 'group', 'g_demo', '--config', cfg, '--json'], { config: cfg })
    check('set group 到服务端没有的分组 → 退出码 4（C13 起真做存在性核对，不再恒 verified:false）',
      setGroup.code === 4 && errJson(setGroup)?.error === 'EC_NOT_FOUND', `${setGroup.code} ${setGroup.err}`)
    const setGroupCfg = ConfigStore.load(cfg)
    check('核对失败的默认分组**没有**被写进配置文件', setGroupCfg.data.defaults.group !== 'g_demo', String(setGroupCfg.data.defaults.group))
    const setBad = await cli(['set', 'nonsense', 'x', '--config', cfg, '--json'], { config: cfg })
    check('set 未知目标 → 退出码 2', setBad.code === 2, String(setBad.code))

    const rmGhost = await cli(['project', 'remove', 'p_ghost', '--config', cfg, '--json'], { config: cfg })
    check('remove 不存在的 project → 退出码 2', rmGhost.code === 2, `${rmGhost.code} ${rmGhost.err}`)
    const rmNoYes = await cli(['project', 'remove', (projects[0]?.id as string) ?? 'a', '--config', cfg, '--json'], {
      config: cfg,
      timeoutMs: 6000,
    })
    check('非交互删除缺 --yes → 退出码 2 且不挂起', rmNoYes.code === 2 && !rmNoYes.timedOut && String(errJson(rmNoYes)?.hint).includes('--yes'), `${rmNoYes.code} timedOut=${rmNoYes.timedOut} ${rmNoYes.err}`)
    const afterRefused = await cli(['project', 'list', '--config', cfg, '--json'], { config: cfg })
    const still = (okJson(afterRefused)?.projects ?? []) as unknown[]
    check('被拒绝的删除没有真的删掉', still.length === projects.length, `${still.length} vs ${projects.length}`)
    const quietOut = await cli(['project', 'list', '--config', cfg, '--quiet'], { config: cfg })
    check('--quiet 是单行 JSON（可被管道消费）', quietOut.code === 0 && quietOut.out.trim().split('\n').length === 1, quietOut.out)

    // ────────────────────────────────────────────────
    section('[C-04] 会话失效与自动重登（服务端会话已落盘，ADR-031）')

    const before = JSON.parse(readFileSync(cfg, 'utf8')) as { projects: { session: string | null }[] }
    server.kill()
    await new Promise((r) => setTimeout(r, 300))
    server = startServer(dataDir)
    check('重启后服务重新就绪', await waitServer())

    // ADR-031 改了这里的预期：**同一个 dataDir 重启，旧 token 依然被服务端承认**，
    // CLI 不该再被迫重登（此前的「重启必然 401」正是这条改动要消掉的行为）。
    const afterRestart = await cli(['whoami', '--config', cfg, '--json'], { config: cfg })
    check('同数据目录重启 → 旧会话仍有效，无口令也能直接 whoami（ADR-031）',
      afterRestart.code === 0, `${afterRestart.code} ${afterRestart.err}`)
    const sameSession = (JSON.parse(readFileSync(cfg, 'utf8')) as { projects: { session: string | null }[] })
      .projects[0]?.session
    check('复用会话而不是悄悄换发一条', sameSession === before.projects[0]?.session, `${before.projects[0]?.session} → ${sameSession}`)

    // 失效来源换成「服务端没有这条会话」（清过盘 / 换了实例 / 服务端侧过期）：
    // 自动重登这条能力仍要覆盖，且不能依赖「重启」这个已经被改掉的前提
    writeStaleSession(cfg, 'f'.repeat(32))
    const staleNoPw = await cli(['whoami', '--config', cfg, '--json'], { config: cfg })
    check('服务端不认识的会话 + 无口令来源 → 退出码 3 并提示 mock login',
      staleNoPw.code === 3 && String(errJson(staleNoPw)?.hint).includes('mock login'), `${staleNoPw.code} ${staleNoPw.err}`)

    const staleWithPw = await cli(['whoami', '--config', cfg, '--json'], { config: cfg, env: { EC_MOCK_PASSWORD: PASSWORD } }) // 喂假口令，验自动重登
    check('失效会话 + EC_MOCK_PASSWORD → 自动重登并成功', staleWithPw.code === 0, `${staleWithPw.code} ${staleWithPw.err}`)
    const after = JSON.parse(readFileSync(cfg, 'utf8')) as { projects: { session: string | null }[] }
    check('自动重登换发的新会话已回写本地', !!after.projects[0]?.session && after.projects[0].session !== sameSession, `${sameSession} → ${after.projects[0]?.session}`)

    const stdinLogin = await cli(['login', '--config', cfg, '--base-url', BASE_URL, '--phone', PHONE, '--password-stdin', '--json'], {
      config: cfg,
      stdin: `${PASSWORD}\n`,
    })
    check('--password-stdin 从管道取口令可登录（脚本首选）', stdinLogin.code === 0 && okJson(stdinLogin)?.sessionCached === true, `${stdinLogin.code} ${stdinLogin.err}`)

    const emptyStdin = await cli(['login', '--config', cfg, '--base-url', BASE_URL, '--phone', PHONE, '--password-stdin', '--json'], {
      config: cfg,
      stdin: '\n',
    })
    check('空口令走 stdin 时报 401 而不是挂住', emptyStdin.code === 3 && !emptyStdin.timedOut, `${emptyStdin.code} timedOut=${emptyStdin.timedOut}`)

    // 用全新配置文件：cfg 里已经存了手机号，那样测不出「缺手机号」这条路
    const noPhone = await cli(['login', '--base-url', BASE_URL, '--json'], {
      config: join(work, 'nophone.json'),
      env: { EC_MOCK_PHONE: '', EC_MOCK_PASSWORD: '' },
    })
    check('非交互缺手机号 → 退出码 2 并提示 --phone', noPhone.code === 2 && String(errJson(noPhone)?.message).includes('手机号'), `${noPhone.code} ${noPhone.err}`)

    const logout = await cli(['logout', '--config', cfg, '--json'], { config: cfg })
    check('logout 退出码 0 并销毁服务端会话', logout.code === 0 && okJson(logout)?.revoked === true, `${logout.code} ${logout.err}`)
    const afterLogout = await cli(['whoami', '--config', cfg, '--json'], { config: cfg, env: { EC_MOCK_PASSWORD: '' } })
    check('logout 后本地会话确实清空（再请求要重新登录）', afterLogout.code === 3, `${afterLogout.code} ${afterLogout.err}`)
    await cli(['login', '--config', cfg, '--base-url', BASE_URL, '--phone', PHONE, '--password', PASSWORD, '--json'], { config: cfg })

    // ────────────────────────────────────────────────
    section('[C-05] 客户端防御')

    const big = 'x'.repeat(1024 * 1024 + 10)
    const bigErr = await callExpectError(new ManagementClient({ baseUrl: BASE_URL, session: null }), big)
    check('超过管理面 1 MiB 上限在客户端先拦住', bigErr === 'EC_BODY_TOO_LARGE', bigErr)

    // 中文 body：字符数 < 1 MiB 但字节数 > 1 MiB。按字符估算会漏判（AGENTS.md §6 要求核对实际字节数）
    const cjk = '汉'.repeat(350_000)
    const cjkErr = await callExpectError(new ManagementClient({ baseUrl: BASE_URL, session: null }), cjk)
    check('中文 body 按字节判定超限（字符数会漏判）', cjkErr === 'EC_BODY_TOO_LARGE', cjkErr)

    const small = await callExpectError(new ManagementClient({ baseUrl: BASE_URL, session: null }), 'y'.repeat(2048))
    check('小 body 正常发出（拿到服务端的 401 而不是本地拦截）', small === 'EC_UNAUTHORIZED', small)

    const dead = await cli(['whoami', '--config', join(work, 'dead.json'), '--base-url', 'http://127.0.0.1:1', '--json'], { config: join(work, 'dead.json') })
    check('连不上服务 → 退出码 5', dead.code === 5, `${dead.code} ${dead.err}`)
    check('连不上的报错里带 baseUrl 与原因', String(errJson(dead)?.message).includes('127.0.0.1:1'), String(errJson(dead)?.message))
    // 真机部署踩过：服务端在同机 curl 秒回，CLI 却超时——原因是开发机的代理/VPN 把局域网地址截走了。
    // 只写「检查服务是否启动」会把人引去翻服务端，所以提示里必须带两条替代路径。
    const deadHint = String(errJson(dead)?.hint ?? '')
    check('连不上的提示给出 NO_PROXY 绕过本机代理', deadHint.includes('NO_PROXY'), deadHint)
    check('连不上的提示给出 ssh -L 隧道兜底', deadHint.includes('ssh -L'), deadHint)

    const badBase = await cli(['whoami', '--config', cfg, '--base-url', 'ht tp://x', '--json'], { config: cfg })
    check('非法 baseUrl → 退出码 2 而不是崩栈', badBase.code === 2 && !badBase.out.includes('at Object'), `${badBase.code} ${badBase.err}`)

    const versionRun = await cli(['version', '--config', cfg, '--json'], { config: cfg })
    const vj = okJson(versionRun)
    check('version 报告 configPath 与 project 数量', versionRun.code === 0 && vj?.configPath === cfg && typeof vj?.projects === 'number', JSON.stringify(vj))

    const verboseRun = await cli(['whoami', '--config', cfg, '--verbose', '--quiet'], { config: cfg })
    check('--verbose 把 HTTP 调用打到 stderr（stdout 保持干净）', verboseRun.code === 0 && verboseRun.err.includes('[http] GET'), `${verboseRun.code} ${verboseRun.err}`)

    // ────────────────────────────────────────────────
    section('[C-06] 读路径防御：管理面回的东西也可能是坏的')

    let listBad = ''
    for (const payload of [{ rules: [] }, null, '[]', 42, { length: 2 }]) {
      try {
        expectList(payload, 'GET /__ec/api/rules')
        listBad += `漏过:${JSON.stringify(payload)} `
      } catch (e) {
        if (!(e instanceof CliError) || e.code !== 'EC_BAD_RESPONSE') listBad += `错码:${JSON.stringify(payload)} `
      }
    }
    check('下发对象 / null / 标量 / 字符串 → EC_BAD_RESPONSE（不是崩栈）', listBad === '', listBad)

    const dirtyRead = expectList([42, null, [], 'x', { id: 'a' }, { id: 'b', enabled: true }], 'GET /__ec/api/rules')
    check('数组里的脏条目被丢掉并计数，合法条目留下', dirtyRead.items.length === 2 && dirtyRead.dropped === 4, JSON.stringify(dirtyRead))
    const emptyList = expectList([], 'GET /__ec/api/rules')
    check('空数组是合法结果，不算 dropped', emptyList.items.length === 0 && emptyList.dropped === 0, JSON.stringify(emptyList))

    // 规则条目本身可以「是对象但没有字符串 id」——rules.json 被手改坏就是这种样子。
    // expectList 只判**结构**（是不是对象），id 合不合法归上层判，见 C-07 的端到端版本
    const noId = expectList([{ id: 42 }, { name: '没 id' }, {}, null], 'GET /__ec/api/rules')
    check('是对象就留下（哪怕 id 是数字），非对象条目才算脏并计数', noId.items.length === 3 && noId.dropped === 1, JSON.stringify(noId))

    const guardTime = fmtTime('昨天')
    check('时间戳脏值显示为 - 而不是 1970', guardTime === '-', guardTime)
    check('负数 / NaN 时间戳同样当「没有」', fmtTime(-1) === '-' && fmtTime(Number.NaN) === '-')
    const guardUrl = splitUrl('not a url')
    check('url 脏值不抛错，退回原文', guardUrl.host === '-' && guardUrl.path === 'not a url', JSON.stringify(guardUrl))
    const goodUrl = splitUrl('https://api.example.com:8443/a/b?x=1')
    check('正常 url 拆成 host(含端口) 与 path(含 query)', goodUrl.host === 'api.example.com:8443' && goodUrl.path === '/a/b?x=1', JSON.stringify(goodUrl))
    check('url 为 null 时给占位而不是崩', JSON.stringify(splitUrl(null)) === '{"host":"-","path":"-"}')

    // ────────────────────────────────────────────────
    section('[C-07] api：规则列表 / 读单条 / 开关 / 删除')

    const sessionA = await rawLogin(PHONE)
    check('自测用的管理面登录可用（布置现场）', !!sessionA, sessionA)

    // C14 起 PUT /rules 的每一条都必须挂在**我自己的私有项目**里（replacePrivateScope 全有全无），
    // 所以 fixture 先建一个私有项目，给全部种子规则盖上它的 groupId
    const mkProject = await rawCall('POST', '/__ec/api/groups', sessionA, { group: { name: 'C07 自测私有', enabled: true } })
    const gidA = String(((mkProject.json as Record<string, unknown>)?.group as Record<string, unknown> | undefined)?.id ?? '')
    check('现场：给 sessionA 建了私有项目（种子规则的归属）', mkProject.status === 200 && /^g_/.test(gidA), JSON.stringify(mkProject.json)?.slice(0, 120))

    const seeded = [
      {
        id: 'r_demo',
        name: '演示 顺序流转',
        enabled: true,
        priority: 0,
        match: { method: 'GET', host: 'api.example.com', path: '/api/demo' },
        action: {
          type: 'mock',
          mode: 'sequence',
          seqMode: 'loop',
          responses: [
            { status: 200, body: '{"ok":1}', name: '成功' },
            { status: 401, body: '{"ok":0}', name: '未登录' },
          ],
        },
      },
      { id: 'r_del', enabled: true, priority: 0, match: { path: '/api/gone' }, action: { type: 'mock', response: { status: 200, body: '{}' } } },
      { id: 'r_off', enabled: false, priority: 5, match: { host: 'other.example', path: '/api/off' }, action: { type: 'passthrough' } },
      { id: 'r_any', enabled: true, priority: 0, match: { path: '/api/any' }, action: { type: 'mock', response: { status: 200, body: '{}' } } },
      // 服务端无损保留未知字段（P2 读改写与 P3 groupId 的前提）：CLI 必须原样回读
      { id: 'r_future', enabled: true, priority: 0, match: { path: '/api/future' }, action: { type: 'mock', response: { status: 200, body: '{}' } }, xFuture: { note: '服务端不认识也要留着' } },
    ]
    const putRes = await rawCall('PUT', '/__ec/api/rules', sessionA, { rules: seeded.map((r) => ({ ...r, groupId: gidA })) })
    check('现场规则已写入服务端（全部挂在 gidA 名下）', putRes.status === 200, JSON.stringify(putRes.json))

    const listAll = await cli(at('api', 'list', '--json'), { config: cfg })
    const listJson = okJson(listAll)
    check('api list 退出码 0 且列出全部规则', listAll.code === 0 && listJson?.total === 5, `${listAll.code} ${listAll.err} ${JSON.stringify(listJson)?.slice(0, 120)}`)
    check('api list 没有把脏条目算进来', listJson?.dropped === 0, JSON.stringify(listJson?.dropped))
    const listed = (listJson?.rules ?? []) as Record<string, unknown>[]
    check('列表项带命中方式与返回值条数（顺序 2 条）', listed.some((r) => r.id === 'r_demo' && r.mode === 'sequence' && r.seqMode === 'loop' && r.responses === 2), JSON.stringify(listed.slice(0, 2)))
    check('旧形态单条返回值也算 1 条（不显示 0）', listed.some((r) => r.id === 'r_del' && r.responses === 1), JSON.stringify(listed.map((r) => [r.id, r.responses])))
    check('列表不含 body（不撑爆 agent 上下文）', listed.every((r) => !('body' in r) && !('responses_raw' in r)), Object.keys(listed[0] ?? {}).join(','))

    const humanList = await cli(at('api', 'list'), { config: cfg })
    check('api list 人类模式排出表头', humanList.code === 0 && humanList.out.includes('返回值') && humanList.out.includes('r_demo'), humanList.out.slice(0, 160))

    const postFilter = await cli(at('api', 'list', '--method', 'POST', '--json'), { config: cfg })
    const postRules = (okJson(postFilter)?.rules ?? []) as Record<string, unknown>[]
    check('--method POST 排除显式声明 GET 的规则', postFilter.code === 0 && !postRules.some((r) => r.id === 'r_demo') && postRules.length === 4, JSON.stringify(postRules.map((r) => r.id)))
    check('--method 把「没写 method 的通配规则」算进命中（与协议 §5.4 一致）', postRules.some((r) => r.id === 'r_any'), JSON.stringify(postRules.map((r) => r.id)))
    check('筛选是 CLI 侧做的，如实标 filteredBy', JSON.stringify(okJson(postFilter)?.filteredBy)?.includes('POST') === true, JSON.stringify(okJson(postFilter)?.filteredBy))

    const offOnly = await cli(at('api', 'list', '--enabled', 'false', '--json'), { config: cfg })
    const offRules = (okJson(offOnly)?.rules ?? []) as Record<string, unknown>[]
    check('--enabled false 只回关着的那条', offOnly.code === 0 && offRules.length === 1 && offRules[0].id === 'r_off', JSON.stringify(offRules))
    const badEnabled = await cli(at('api', 'list', '--enabled', 'yes', '--json'), { config: cfg })
    check('--enabled 拒绝 1/yes 这类宽松真值', badEnabled.code === 2 && errJson(badEnabled)?.error === 'EC_USAGE', `${badEnabled.code} ${badEnabled.err}`)

    const pathFilter = await cli(at('api', 'list', '--path', '/api/demo', '--json'), { config: cfg })
    check('--path 按模式串子串匹配', pathFilter.code === 0 && (okJson(pathFilter)?.count ?? 0) === 1, `${pathFilter.code} ${JSON.stringify(okJson(pathFilter))?.slice(0, 100)}`)
    const qFilter = await cli(at('api', 'list', '--q', '演示', '--json'), { config: cfg })
    check('--q 能搜中文名', qFilter.code === 0 && (okJson(qFilter)?.count ?? 0) === 1, `${qFilter.code} ${qFilter.err}`)
    const noneFilter = await cli(at('api', 'list', '--path', '/api/不存在', '--json'), { config: cfg })
    check('筛选后为 0 条时如实区分「筛空了」和「服务端本来空」', noneFilter.code === 0 && okJson(noneFilter)?.count === 0 && okJson(noneFilter)?.total === 5, JSON.stringify(okJson(noneFilter))?.slice(0, 120))

    const getRule = await cli(at('api', 'get', 'r_future', '--json'), { config: cfg })
    const gotRule = (okJson(getRule)?.rule ?? null) as Record<string, unknown> | null
    check('api get 原样回读未知字段（读改写不失真）', getRule.code === 0 && JSON.stringify((gotRule?.xFuture as Record<string, unknown>)?.note) === '"服务端不认识也要留着"', JSON.stringify(gotRule))
    check('api get 同时给出摘要与原始 rule', okJson(getRule)?.summary !== undefined && (okJson(getRule)?.summary as Record<string, unknown>)?.responses === 1, JSON.stringify(okJson(getRule)?.summary))
    const getGhost = await cli(at('api', 'get', 'r_ghost', '--json'), { config: cfg })
    check('api get 查无此条 → EC_NOT_FOUND + 退出码 4', getGhost.code === 4 && errJson(getGhost)?.error === 'EC_NOT_FOUND', `${getGhost.code} ${getGhost.err}`)
    check('查无此条的 hint 指向 mock api list', String(errJson(getGhost)?.hint).includes('api list'), String(errJson(getGhost)?.hint))
    const getNoId = await cli(at('api', 'get', '--json'), { config: cfg })
    check('api get 缺 id → 退出码 2（不把 --json 当成 id）', getNoId.code === 2 && String(errJson(getNoId)?.message).includes('规则 id'), `${getNoId.code} ${getNoId.err}`)

    const switchBoth = await cli(at('api', 'switch', 'r_demo', '--on', '--off', '--json'), { config: cfg })
    check('同时给 --on 和 --off → 退出码 2', switchBoth.code === 2, `${switchBoth.code} ${switchBoth.err}`)
    const switchNone = await cli(at('api', 'switch', 'r_demo', '--json'), { config: cfg })
    check('不给开关 → 退出码 2（刻意没有默认方向）', switchNone.code === 2 && String(errJson(switchNone)?.hint).includes('--on'), `${switchNone.code} ${switchNone.err}`)

    const switchOff = await cli(at('api', 'switch', 'r_off', '--on', '--json'), { config: cfg })
    check('api switch 开一条关着的规则并读回校验', switchOff.code === 0 && okJson(switchOff)?.verified === true && okJson(switchOff)?.enabled === true && okJson(switchOff)?.previous === false, `${switchOff.code} ${switchOff.err}`)
    const afterSwitch = await rawCall('GET', '/__ec/api/rules', sessionA)
    const switched = ((afterSwitch.json as Record<string, unknown>[]) ?? []).find((r) => r.id === 'r_off')
    check('开关真的落进服务端（自测独立读回，不靠 CLI 自己说）', switched?.enabled === true, JSON.stringify(switched))
    const switchGhost = await cli(at('api', 'switch', 'r_ghost', '--off', '--json'), { config: cfg })
    check('api switch 查无此条 → 退出码 4', switchGhost.code === 4 && errJson(switchGhost)?.error === 'EC_NOT_FOUND', `${switchGhost.code} ${switchGhost.err}`)

    const delNoYes = await cli(at('api', 'delete', 'r_any', '--json'), { config: cfg, timeoutMs: 6000 })
    check('api delete 非交互缺 --yes → 退出码 2 且不挂起', delNoYes.code === 2 && !delNoYes.timedOut, `${delNoYes.code} timedOut=${delNoYes.timedOut}`)
    const stillThere = await rawCall('GET', '/__ec/api/rules', sessionA)
    check('被拒绝的删除没有真的删掉', ((stillThere.json as Record<string, unknown>[]) ?? []).some((r) => r.id === 'r_any'), 'r_any 不见了')
    const delGhost = await cli(at('api', 'delete', 'r_ghost', '--yes', '--json'), { config: cfg })
    check('api delete 查无此条 → 退出码 4（不是「静默成功」）', delGhost.code === 4 && errJson(delGhost)?.error === 'EC_NOT_FOUND', `${delGhost.code} ${delGhost.err}`)
    const del = await cli(at('api', 'delete', 'r_del', '--yes', '--json'), { config: cfg })
    check('api delete --yes 删除并读回校验', del.code === 0 && okJson(del)?.removed === true && okJson(del)?.remaining === 4, `${del.code} ${del.err}`)
    const delTwice = await cli(at('api', 'delete', 'r_del', '--yes', '--json'), { config: cfg })
    check('重复删除第二次如实报查无此条', delTwice.code === 4, String(delTwice.code))

    // C14 之后 --group-id 是**真语义**（筛选 / 写入 / 归属校验），不再报 64。
    // 但「按一个服务端不存在的项目筛选/挂载」必须报错而不是返回空列表——
    // 空列表会被读成「这个项目是空的」，而真相是「你写错了 id 或项目已被删」。完整正例在 C-12。
    const groupFilter = await cli(at('api', 'list', '--group-id', 'g1', '--json'), { config: cfg })
    check('--group-id 指向不存在的项目 → 退出码 4 EC_NOT_FOUND，绝不静默返回空列表',
      groupFilter.code === 4 && errJson(groupFilter)?.error === 'EC_NOT_FOUND', `${groupFilter.code} ${groupFilter.err}`)
    const groupCreate = await cli(at('api', 'create', '--path', '/api/x', '--json-list', '{}', '--group-id', 'g1', '--json'), { config: cfg })
    check('api create --group-id 同样先核对项目（查无此项目 → 4，且不会留下悬空 id 的规则）',
      groupCreate.code === 4 && String(errJson(groupCreate)?.message).includes('项目'), `${groupCreate.code} ${groupCreate.err}`)
    const afterGhostGroup = await cli(at('api', 'list', '--json'), { config: cfg })
    check('失败的 create 一条规则都没写进去（不是先建后报错）',
      afterGhostGroup.code === 0 && (okJson(afterGhostGroup)?.total as number) === 4, JSON.stringify(okJson(afterGhostGroup))?.slice(0, 120))
    const badSub = await cli(at('api', 'frobnicate', '--json'), { config: cfg })
    check('未知 api 子命令 → 退出码 2 并列出可用', badSub.code === 2 && String(errJson(badSub)?.hint).includes('list'), `${badSub.code} ${badSub.err}`)
    const badSub2 = await cli(at('api', 'frobnicate', '--json'), { config: cfg })
    check('未知子命令的提示把 P2 新命令也列出来', String(errJson(badSub2)?.hint).includes('create'), String(errJson(badSub2)?.hint))

    // 服务端 replacePrivateScope 只要求「条目是对象 + 挂我的私有项目」，**不要求 id 是字符串**：
    // rules.json 被手改坏、或旧版本写进来的数字 id，就是这种状态。CLI 必须数出来，
    // 而不是让 agent 以为「服务端有 2 条，怎么 list 只给我 1 条」。
    const dirtySeeded = [
      { ...seeded[0], groupId: gidA },
      { id: 42, name: '数字 id', enabled: true, groupId: gidA, match: { path: '/api/42' }, action: { type: 'passthrough' } },
    ]
    const putDirty = await rawCall('PUT', '/__ec/api/rules', sessionA, { rules: dirtySeeded })
    check('现场：写入一条 id 不是字符串的规则', putDirty.status === 200, JSON.stringify(putDirty.json))
    const dirtyList = await cli(at('api', 'list', '--json'), { config: cfg })
    check('结构合法但 id 不合法 → 如实计入 dropped，不静默少一条', dirtyList.code === 0 && okJson(dirtyList)?.dropped === 1 && okJson(dirtyList)?.total === 1, `${dirtyList.code} ${JSON.stringify(okJson(dirtyList))?.slice(0, 140)}`)
    const dirtyHuman = await cli(at('api', 'list'), { config: cfg })
    check('人类模式也说明「有 1 条被跳过」（stderr），不是凭空少一条', dirtyHuman.code === 0 && dirtyHuman.err.includes('跳过'), `${dirtyHuman.code} ${dirtyHuman.err}`)
    const dirtyGet = await cli(at('api', 'get', '42', '--json'), { config: cfg })
    check('拿数字 id 去 get → 查无此条（不做 String(id) 的宽松匹配）', dirtyGet.code === 4, `${dirtyGet.code} ${dirtyGet.err}`)

    // AGENTS.md §4：PUT /rules 的两个新 400 分支（结构合法但归属非法），失败必须零写入
    const putNoGroup = await rawCall('PUT', '/__ec/api/rules', sessionA, { rules: [seeded[0]] })
    check('PUT 的条目缺 groupId → 400 EC_SCOPE_MISMATCH（C14：不挂私有项目就写不进）',
      putNoGroup.status === 400 && (putNoGroup.json as Record<string, unknown>)?.error === 'EC_SCOPE_MISMATCH', JSON.stringify(putNoGroup.json)?.slice(0, 140))
    const putGhostGroup = await rawCall('PUT', '/__ec/api/rules', sessionA, { rules: [{ ...seeded[0], groupId: 'g_ghost' }] })
    check('PUT 的条目挂不存在的项目 → 400（不会留下悬空归属）', putGhostGroup.status === 400, JSON.stringify(putGhostGroup.json)?.slice(0, 140))
    const restore = await rawCall('PUT', '/__ec/api/rules', sessionA, { rules: seeded.map((r) => ({ ...r, groupId: gidA })) })
    check('现场恢复：后面的用例还要靠 r_demo 命中 mock（被拒的 400 一条没写下去）',
      restore.status === 200 && (restore.json as Record<string, unknown>)?.count === 5, JSON.stringify(restore.json))

    // ────────────────────────────────────────────────
    section('[C-08] device：可见性、绑定守卫与读回校验')

    await hello('cli-dev-1', 's1', 'CLI 测试机')
    await hello('cli-dev-2', 's2', '另一台')

    const devList = await cli(at('device', 'list', '--json'), { config: cfg })
    const devs = (okJson(devList)?.devices ?? []) as Record<string, unknown>[]
    check('device list 看到两台未绑定设备', devList.code === 0 && devs.length === 2 && devs.every((d) => d.owner === null), JSON.stringify(devs.map((d) => [d.deviceId, d.owner])))
    check('设备名取 deviceName（人类可读优先）', devs.some((d) => d.name === 'CLI 测试机'), JSON.stringify(devs.map((d) => d.name)))
    const devHuman = await cli(at('device', 'list'), { config: cfg })
    check('device list 人类模式含归属列', devHuman.code === 0 && devHuman.out.includes('未绑定'), devHuman.out.slice(0, 160))
    const badOnline = await cli(at('device', 'list', '--online', '1', '--json'), { config: cfg })
    check('--online 拒绝 1 这类宽松真值', badOnline.code === 2, String(badOnline.code))

    const cur0 = await cli(at('device', 'current', '--json'), { config: cfg })
    check('未绑定任何设备时 current 为 null 而不是报错', cur0.code === 0 && okJson(cur0)?.current === null && okJson(cur0)?.staleBinding === false, `${cur0.code} ${cur0.err}`)

    const bind = await cli(at('device', 'bind', 'cli-dev-1', '--json'), { config: cfg })
    check('device bind 绑定成功并读回 owner', bind.code === 0 && okJson(bind)?.verified === true && (okJson(bind)?.device as Record<string, unknown>)?.owner === PHONE, `${bind.code} ${bind.err}`)
    const bindAgain = await cli(at('device', 'bind', 'cli-dev-1', '--json'), { config: cfg })
    check('重复绑定同一台报 already，不做多余的写', bindAgain.code === 0 && okJson(bindAgain)?.already === true, `${bindAgain.code} ${bindAgain.err}`)
    const cur1 = await cli(at('device', 'current', '--json'), { config: cfg })
    check('device current 回显刚绑的那台', cur1.code === 0 && okJson(cur1)?.deviceId === 'cli-dev-1', JSON.stringify(okJson(cur1))?.slice(0, 120))

    const bindGhost = await cli(at('device', 'bind', 'cli-dev-ghost', '--json'), { config: cfg })
    check('绑定不存在的设备 → 退出码 4 并提示 --force 的含义', bindGhost.code === 4 && String(errJson(bindGhost)?.hint).includes('--force'), `${bindGhost.code} ${bindGhost.err}`)

    // 另一个手机号的空间：他人已绑定的设备不在其可见列表里
    const cfgB = join(work, 'configB.json')
    const loginB = await cli(['login', '--config', cfgB, '--base-url', BASE_URL, '--phone', PHONE_B, '--password', PASSWORD, '--json'], { config: cfgB })
    check('第二个空间登录成功（测归属边界）', loginB.code === 0, `${loginB.code} ${loginB.err}`)
    const bList = await cli(['device', 'list', '--json'], { config: cfgB, env: {} })
    const bDevs = (okJson(bList)?.devices ?? []) as Record<string, unknown>[]
    check('他人绑定的设备不出现在我的列表里', bList.code === 0 && bDevs.every((d) => d.deviceId !== 'cli-dev-1') && bDevs.some((d) => d.deviceId === 'cli-dev-2'), JSON.stringify(bDevs.map((d) => d.deviceId)))
    const bBind = await cli(['device', 'bind', 'cli-dev-1', '--json'], { config: cfgB })
    check('没有 --force 时不能把他人设备绑走（静默成功才是事故）', bBind.code === 4 && errJson(bBind)?.error === 'EC_NOT_FOUND', `${bBind.code} ${bBind.err}`)
    const aAfterRefused = await rawCall('GET', '/__ec/api/devices', sessionA)
    check('被拒绝的绑定没有改动服务端归属', ((aAfterRefused.json as Record<string, unknown>[]) ?? []).find((d) => d.deviceId === 'cli-dev-1')?.owner === PHONE, JSON.stringify(aAfterRefused.json)?.slice(0, 200))

    const forceNoYes = await cli(['device', 'bind', 'cli-dev-1', '--force', '--json'], { config: cfgB, timeoutMs: 6000 })
    check('--force 仍要显式确认（非交互缺 --yes → 2 且不挂起）', forceNoYes.code === 2 && !forceNoYes.timedOut, `${forceNoYes.code} timedOut=${forceNoYes.timedOut}`)
    const forceYes = await cli(['device', 'bind', 'cli-dev-1', '--force', '--yes', '--json'], { config: cfgB })
    check('--force --yes 才真的改归属，并读回确认', forceYes.code === 0 && okJson(forceYes)?.forced === true && (okJson(forceYes)?.device as Record<string, unknown>)?.owner === PHONE_B, `${forceYes.code} ${forceYes.err}`)
    const aUnbind = await cli(at('device', 'unbind', 'cli-dev-1', '--json'), { config: cfg })
    check('普通用户解绑他人空间的设备 → 退出码 4（它根本不在他的可见列表里，ADR-018 的可见性口径）', aUnbind.code === 4 && errJson(aUnbind)?.error === 'EC_NOT_FOUND', `${aUnbind.code} ${aUnbind.err}`)

    // 管理员看得见全量，所以「设备在列表里、但归属不是你」这条守卫分支只有管理员空间走得到。
    // 这条分支很重要：服务端 bindDevice/unbindDevice 本身不校验当前归属，
    // CLI 侧的 EC_CONFLICT 守卫是唯一防线（见 ADR-027 的坑点）。
    const cfgAdmin = join(work, 'configAdmin.json')
    const loginAdmin = await cli(['login', '--config', cfgAdmin, '--base-url', BASE_URL, '--phone', PHONE_ADMIN, '--password', PASSWORD, '--json'], { config: cfgAdmin })
    check('管理员空间登录（只为走「看得见但不是你的」这条分支）', loginAdmin.code === 0, `${loginAdmin.code} ${loginAdmin.err}`)
    const adminList = await cli(['device', 'list', '--json'], { config: cfgAdmin })
    const adminDevs = (okJson(adminList)?.devices ?? []) as Record<string, unknown>[]
    check('管理员看得到全量，含他人空间已绑定的设备', adminList.code === 0 && adminDevs.some((d) => d.deviceId === 'cli-dev-1' && d.owner === PHONE_B), JSON.stringify(adminDevs.map((d) => [d.deviceId, d.owner])))
    const adminUnbindOther = await cli(['device', 'unbind', 'cli-dev-1', '--json'], { config: cfgAdmin })
    check('管理员解绑别人空间的设备 → 退出码 3 EC_CONFLICT（可见 ≠ 能动）', adminUnbindOther.code === 3 && errJson(adminUnbindOther)?.error === 'EC_CONFLICT', `${adminUnbindOther.code} ${adminUnbindOther.err}`)
    const adminBindOwned = await cli(['device', 'bind', 'cli-dev-1', '--json'], { config: cfgAdmin })
    check('绑他人已绑的设备、不带 --force → 退出码 2 EC_CONFLICT 并点名 --force', adminBindOwned.code === 2 && errJson(adminBindOwned)?.error === 'EC_CONFLICT' && String(errJson(adminBindOwned)?.hint).includes('--force'), `${adminBindOwned.code} ${adminBindOwned.err}`)
    const adminBindForce = await cli(['device', 'bind', 'cli-dev-1', '--force', '--yes', '--json'], { config: cfgAdmin })
    check('管理员 --force --yes 改绑进自己空间并读回', adminBindForce.code === 0 && (okJson(adminBindForce)?.device as Record<string, unknown>)?.owner === PHONE_ADMIN, `${adminBindForce.code} ${adminBindForce.err}`)
    const adminUnbindOwn = await cli(['device', 'unbind', 'cli-dev-1', '--json'], { config: cfgAdmin })
    check('自己空间内解绑成功（顺带放回未绑定，供 C-09 复用）', adminUnbindOwn.code === 0 && okJson(adminUnbindOwn)?.unbound === true, `${adminUnbindOwn.code} ${adminUnbindOwn.err}`)
    const bUnbindStolen = await cli(['device', 'unbind', 'cli-dev-1', '--json'], { config: cfgB })
    check('归属已经不是自己了 → 退出码 3，绝不报「解绑成功」', bUnbindStolen.code === 3 && errJson(bUnbindStolen)?.error === 'EC_CONFLICT', `${bUnbindStolen.code} ${bUnbindStolen.err}`)

    const rename = await cli(at('device', 'rename', 'cli-dev-2', '新名字', '--json'), { config: cfg })
    check('device rename 明确未实现并指出改 SDK 侧', rename.code === 64 && String(errJson(rename)?.hint).includes('SDK'), `${rename.code} ${rename.err}`)
    const devBadSub = await cli(at('device', 'frobnicate', '--json'), { config: cfg })
    check('未知 device 子命令 → 退出码 2', devBadSub.code === 2, String(devBadSub.code))
    const devNoId = await cli(at('device', 'bind', '--json'), { config: cfg })
    check('device bind 缺 id → 退出码 2（不把 --json 当 id）', devNoId.code === 2 && String(errJson(devNoId)?.message).includes('设备 id'), `${devNoId.code} ${devNoId.err}`)
    const devTwoIds = await cli(at('device', 'bind', 'cli-dev-2', '--device-id', 'cli-dev-1', '--json'), { config: cfg })
    check('位置 id 与 --device-id 冲突时报错而不是随机挑一个', devTwoIds.code === 2 && String(errJson(devTwoIds)?.message).includes('两个'), `${devTwoIds.code} ${devTwoIds.err}`)
    const devFlagId = await cli(at('device', 'bind', '--device-id', 'cli-dev-2', '--json'), { config: cfg })
    check('--device-id 单独可用', devFlagId.code === 0 && okJson(devFlagId)?.deviceId === 'cli-dev-2', `${devFlagId.code} ${devFlagId.err}`)

    // ────────────────────────────────────────────────
    section('[C-09] request：抓包记录的列表 / 详情 / 清空')

    await cli(at('device', 'bind', 'cli-dev-1', '--json'), { config: cfg })
    const hit1 = await dataGet('https://api.example.com/api/demo', 'cli-dev-1')
    const hit2 = await dataGet('https://api.example.com/api/demo', 'cli-dev-1')
    check('数据面命中 mock（顺序返回 200 然后 401）', hit1.status === 200 && hit2.status === 401, `${hit1.status}/${hit2.status}`)

    const reqList = await cli(at('request', 'list', '--json'), { config: cfg })
    const records = (okJson(reqList)?.records ?? []) as Record<string, unknown>[]
    check('request list 看到刚产生的两条记录', reqList.code === 0 && records.length === 2, `${reqList.code} ${reqList.err} ${JSON.stringify(reqList.out).slice(0, 120)}`)
    check('列表是摘要，不含 body', records.every((r) => !('body' in r)), Object.keys(records[0] ?? {}).join(','))
    check('列表标出 mocked 命中', records.every((r) => r.mocked === true), JSON.stringify(records.map((r) => r.mocked)))
    check('列表带方法/路径/状态，够 agent 定位', records.every((r) => r.method === 'GET' && r.path === '/api/demo' && (r.status === 200 || r.status === 401)), JSON.stringify(records.map((r) => [r.method, r.status])))

    const onlyMocked = await cli(at('request', 'list', '--mocked', 'true', '--json'), { config: cfg })
    check('--mocked true 过滤后仍是这两条', onlyMocked.code === 0 && (okJson(onlyMocked)?.count ?? 0) === 2, `${onlyMocked.code} ${onlyMocked.err}`)
    const noReal = await cli(at('request', 'list', '--mocked', 'false', '--json'), { config: cfg })
    check('--mocked false 一条没有（这两条都是 mock 命中）', noReal.code === 0 && (okJson(noReal)?.count ?? 0) === 0, JSON.stringify(okJson(noReal))?.slice(0, 120))
    const badMocked = await cli(at('request', 'list', '--mocked', 'maybe', '--json'), { config: cfg })
    check('--mocked 拒绝非 true/false', badMocked.code === 2, String(badMocked.code))
    const otherDevice = await cli(at('request', 'list', '--device-id', 'cli-none', '--json'), { config: cfg })
    check('--device-id 交给服务端过滤（查不到就是 0 条）', otherDevice.code === 0 && (okJson(otherDevice)?.count ?? 0) === 0, JSON.stringify(okJson(otherDevice))?.slice(0, 100))

    for (const bad of ['0', '-3', 'abc', '99999', '1.5']) {
      const r = await cli(at('request', 'list', '--limit', bad, '--json'), { config: cfg })
      check(`--limit ${bad} → 退出码 2（服务端会静默退回 300，CLI 不跟着骗人）`, r.code === 2, `${r.code} ${r.err}`)
    }

    const realId = String(records[0]?.id ?? '')
    const reqGet = await cli(at('request', 'get', realId, '--json'), { config: cfg })
    const got = (okJson(reqGet)?.record ?? null) as Record<string, unknown> | null
    const respBody = String(((got?.response ?? {}) as Record<string, unknown>).body)
    check('request get 取到整条记录（含 response body，列表里刻意没有）', reqGet.code === 0 && respBody.includes('ok'), `${reqGet.code} ${respBody}`)
    check('记录原样带着 request.url（不拆字段，agent 要能自己判）', String(((got?.request ?? {}) as Record<string, unknown>).url).includes('api.example.com'), JSON.stringify(got?.request))
    const shortId = await cli(at('request', 'get', realId.slice(0, 12), '--json'), { config: cfg })
    check('用截断显示的 id → 退出码 4 并指向 --json 取完整 id', shortId.code === 4 && String(errJson(shortId)?.hint).includes('--json'), `${shortId.code} ${shortId.err}`)
    const reqGetGhost = await cli(at('request', 'get', 'rec_不存在', '--json'), { config: cfg })
    check('request get 查无此条 → 退出码 4（服务端的 404 也归一成 EC_NOT_FOUND）', reqGetGhost.code === 4 && errJson(reqGetGhost)?.error === 'EC_NOT_FOUND', `${reqGetGhost.code} ${reqGetGhost.err}`)

    const clearNoYes = await cli(at('request', 'clear', '--json'), { config: cfg, timeoutMs: 6000 })
    check('request clear 非交互缺 --yes → 退出码 2 且不挂起', clearNoYes.code === 2 && !clearNoYes.timedOut, `${clearNoYes.code} timedOut=${clearNoYes.timedOut}`)
    const afterRefuse = await cli(at('request', 'list', '--json'), { config: cfg })
    check('被拒绝的清空没有真的清掉', (okJson(afterRefuse)?.count ?? 0) === 2, JSON.stringify(okJson(afterRefuse)?.count))
    const clearScoped = await cli(at('request', 'clear', '--device-id', 'cli-none', '--yes', '--json'), { config: cfg })
    check('按筛选清空 0 条也是成功（不误删别的设备）', clearScoped.code === 0 && okJson(clearScoped)?.cleared === 0, `${clearScoped.code} ${clearScoped.err}`)
    const clear = await cli(at('request', 'clear', '--yes', '--json'), { config: cfg })
    check('request clear --yes 清空并读回校验', clear.code === 0 && Number(okJson(clear)?.cleared ?? 0) >= 2 && okJson(clear)?.verified === true, `${clear.code} ${clear.err}`)
    const afterClear = await cli(at('request', 'list', '--json'), { config: cfg })
    check('清空后列表为空（独立读回，不靠命令自己说）', (okJson(afterClear)?.count ?? 1) === 0, JSON.stringify(okJson(afterClear))?.slice(0, 100))
    const reqBadSub = await cli(at('request', 'frobnicate', '--json'), { config: cfg })
    check('未知 request 子命令 → 退出码 2', reqBadSub.code === 2, String(reqBadSub.code))

    // ────────────────────────────────────────────────
    section('[C-10] 输出纪律：管道截断与中文列宽')

    const pipeCut = await cli(at('api', 'list', '--json'), { config: cfg, closeStdoutEarly: true })
    check('stdout 被下游提前关闭 → 安静退出 0，不甩 EPIPE 栈', pipeCut.code === 0 && !pipeCut.err.includes('EPIPE') && !pipeCut.err.includes('at Object'), `${pipeCut.code} ${pipeCut.err.slice(0, 200)}`)

    // 两行设备名：**码点数相同（4）、终端列宽不同（4 列 vs 8 列）**。
    // 按码点补齐的写法会把后一列整体推歪——这组数据正好把它逼出来：
    // 真按列宽补齐时，视觉列相同而码点列相差 4；反之码点列相同而视觉列差 4。
    await hello('cli-wide-1', 's3', 'ABCD')
    await hello('cli-wide-2', 's4', '中文名称')
    const wideTable = await cli(at('device', 'list'), { config: cfg })
    const wideLines = wideTable.out.split('\n').filter((l) => l.includes('cli-wide-') && l.includes('✓'))
    check('宽窄两行都进了表', wideLines.length === 2, wideTable.out.slice(0, 200))
    const offs = wideLines.map(onlineColOffset)
    check('同一列在各行占同样的视觉列（表格没被中文挤歪）', offs.every((o) => o.visible === offs[0].visible), JSON.stringify(offs))
    check('补齐用的是列宽而不是码点数（两条的字符下标必然不同）', offs.length === 2 && Math.abs(offs[0].chars - offs[1].chars) === 4, JSON.stringify(offs))

    // ────────────────────────────────────────────────
    section('[C-11] api create / update / copy：写路径 + 读回校验（ADR-028）')

    // 现场清场：本段自己建自己删，不依赖 C-07 剩下的规则
    await rawCall('PUT', '/__ec/api/rules', sessionA, { rules: [] })

    const mkPath = '/api/p2/create'
    const created = await cli(at('api', 'create', '--path', mkPath, '--json-list', '{"code":0,"n":1}', '--name', 'P2 新建', '--json'), { config: cfg })
    const createdJson = okJson(created)
    const newId = String(createdJson?.id ?? '')
    check('api create 单条返回值 → 退出码 0 并给出服务端生成的 id', created.code === 0 && /^r_/.test(newId), `${created.code} ${created.err} ${JSON.stringify(createdJson)?.slice(0, 160)}`)
    check('api create 缺省命中方式 = 单条固定（static）', createdJson?.mode === 'static', JSON.stringify(createdJson?.mode))
    check('api create 读回校验通过（verified 隐含：不一致就是 EC_VERIFY_FAILED + 退出 5）', created.code === 0, `${created.code} ${created.err}`)
    const createdRule = (createdJson?.rule ?? {}) as Record<string, unknown>
    const createdAction = (createdRule.action ?? {}) as Record<string, unknown>
    check('单条 + 固定按控制台的旧形态落库（mode=static + action.response）',
      createdAction.mode === 'static' && createdAction.response !== undefined && !('responses' in createdAction),
      JSON.stringify(createdAction))
    check('新建的规则默认就是启用的（PUT 省略 enabled 会被当关闭）', createdRule.enabled === true, JSON.stringify(createdRule.enabled))
    check('body 逐字存下来（不做 JSON 重排版）',
      ((createdAction.response as Record<string, unknown>)?.body ?? '') === '{"code":0,"n":1}',
      JSON.stringify(createdAction.response))
    const createdResp = (createdAction.response ?? {}) as Record<string, unknown>
    check('缺 content-type 时补 application/json（与数据面按 JSON 返回一致）',
      (createdResp.headers as Record<string, unknown> | undefined)?.['content-type'] === 'application/json',
      JSON.stringify(createdResp.headers))

    const selfId = await cli(at('api', 'create', '--path', '/api/p2/id', '--id', 'hacked', '--json-list', '{}', '--json'), { config: cfg })
    check('CLI 不接受 --id（id 由服务端生成，防「假装新建实则覆盖」）', selfId.code === 64 || selfId.code === 2, `${selfId.code} ${selfId.err.slice(0, 120)}`)

    const dupCreate = await cli(at('api', 'create', '--path', mkPath, '--json-list', '{"code":0}', '--json'), { config: cfg })
    check('同 path 再建一条不报错（服务端允许重复规则，归属由 priority 决定）', dupCreate.code === 0, `${dupCreate.code} ${dupCreate.err}`)

    // 四条并行数组：下标对齐是这个设计里最容易静默错位的地方
    // 正确写法 = 每项各自重复 flag（空格连写会被新加的守卫当场拦下，见下面那条用例）
    const multiCreate = await cli(
      at('api', 'create', '--path', '/api/p2/multi',
        '--json-list', '{"code":0}', '--json-list', '{"code":401}', '--json-list', '{"code":500}',
        '--response-group-names', '成功', '--response-group-names', '密码错误', '--response-group-names', '系统繁忙',
        '--response-group-queries', 'a=1', '--response-group-queries', 'a=2', '--response-group-queries', '',
        '--response-group-contents', '', '--response-group-contents', '', '--response-group-contents', 'fail',
        '--mode', 'seq', '--seq-mode', 'loop', '--json'),
      { config: cfg },
    )
    const multiJson = okJson(multiCreate)
    const multiRule = (multiJson?.rule ?? {}) as Record<string, unknown>
    const multiAction = (multiRule.action ?? {}) as Record<string, unknown>
    const multiResp = (multiAction.responses ?? []) as Record<string, unknown>[]
    check('三条 --json-list + 三条 name → 退出码 0 且存了 3 条', multiCreate.code === 0 && multiResp.length === 3, `${multiCreate.code} ${multiCreate.err} ${JSON.stringify(multiJson)?.slice(0, 200)}`)
    check('多条 + 顺序 → mode=sequence + seqMode=loop', multiAction.mode === 'sequence' && multiAction.seqMode === 'loop', JSON.stringify(multiAction))
    check('下标对齐：第 2 条拿到「密码错误」+ a=2', multiResp[1]?.name === '密码错误' && ((multiResp[1]?.cond as Record<string, unknown>)?.query ?? '') === 'a=2', JSON.stringify(multiResp[1]))
    check('下标对齐：第 3 条拿到 content 条件 fail', ((multiResp[2]?.cond as Record<string, unknown>)?.content ?? '') === 'fail', JSON.stringify(multiResp[2]?.cond))
    check('空串那格不写成空条件（cond 里不含空 query）', ((multiResp[0]?.cond as Record<string, unknown>)?.content ?? '') === '', JSON.stringify(multiResp[0]?.cond))
    check('数组摘要回给 agent（arrays.count=3）', JSON.stringify(multiJson?.arrays)?.includes('3'), JSON.stringify(multiJson?.arrays))

    const shortArrays = await cli(
      at('api', 'create', '--path', '/api/p2/bad', '--json-list', '{"a":1}', '--json-list', '{"a":2}', '--response-group-names', '只有1个', '--json'),
      { config: cfg },
    )
    check('四条数组长度不齐 → 退出码 2，不猜用户想怎么补齐', shortArrays.code === 2 && errJson(shortArrays)?.error === 'EC_USAGE', `${shortArrays.code} ${shortArrays.err}`)
    check('长度不齐的报错点名是哪个数组、各多长', /json-list|response-group-names/.test(String(errJson(shortArrays)?.message)) && String(errJson(shortArrays)?.message).includes('2'), String(errJson(shortArrays)?.message))
    const afterBad = await rawCall('GET', '/__ec/api/rules', sessionA)
    check('被拒绝的 create 一条都没写进去（没有半成品留在服务端）',
      ((afterBad.json as Record<string, unknown>[]) ?? []).every((r) => !String((r.match as Record<string, unknown>)?.path ?? '').includes('/api/p2/bad')),
      JSON.stringify((afterBad.json as Record<string, unknown>[])?.map((r) => (r.match as Record<string, unknown>)?.path)))

    // 空格连写多条数组值：B / C 会掉进 positional，命令不收位置参数时就是「静默少写两条」
    const glued = await cli(at('api', 'create', '--path', '/api/p2/glued', '--json-list', '{"a":1}', '{"a":2}', '{"a":3}', '--json'), { config: cfg })
    check('把数组写成「--json-list A B C」→ 退出码 2 并点名多了哪几个参数',
      glued.code === 2 && String(errJson(glued)?.message).includes('没有归属'), `${glued.code} ${glued.err.slice(0, 160)}`)
    check('报错的 hint 给的是可照抄的正确示例', String(errJson(glued)?.hint).includes('--json-list'), String(errJson(glued)?.hint))
    const gluedLeft = (await rawCall('GET', '/__ec/api/rules', sessionA)).json as Record<string, unknown>[]
    check('被拦下的连写没有在服务端留下半条规则', gluedLeft.every((r) => !String((r.match as Record<string, unknown>)?.path ?? '').includes('/api/p2/glued')),
      JSON.stringify(gluedLeft.map((r) => (r.match as Record<string, unknown>)?.path)))
    const gluedGet = await cli(at('api', 'get', 'r_demo', '多余', '--json'), { config: cfg })
    check('收 1 个 id 的命令多给一个位置参数也当场报错（不拿第一个算了事）', gluedGet.code === 2, `${gluedGet.code} ${gluedGet.err.slice(0, 140)}`)

    const splitMistake = await cli(
      at('api', 'create', '--path', '/api/p2/split', '--json-list', '["{\\"a\\":1}","{\\"b\\":2}"]', '--response-group-names', 'x', '--response-group-names', 'y', '--json'),
      { config: cfg },
    )
    check('把数组误当成一个 JSON 传给 --json-list → 报「疑似 shell 把数组传成一个参数」',
      splitMistake.code === 2 && String(errJson(splitMistake)?.message).includes('一个'), `${splitMistake.code} ${splitMistake.err}`)

    const emptyBody = await cli(at('api', 'create', '--path', '/api/p2/empty', '--json-list', '', '--json'), { config: cfg })
    check('--json-list 给空串 → 退出码 2（空串多为转义丢了，不是「就要空 body」）', emptyBody.code === 2, `${emptyBody.code} ${emptyBody.err}`)
    const emptyOk = await cli(at('api', 'create', '--path', '/api/p2/empty', '--json-list', '', '--allow-empty-body', '--json'), { config: cfg })
    check('--allow-empty-body 才真写空 body', emptyOk.code === 0, `${emptyOk.code} ${emptyOk.err}`)
    const emptyBodyRule = (okJson(emptyOk)?.rule ?? {}) as Record<string, unknown>
    const emptyBodyResp = ((emptyBodyRule.action ?? {}) as Record<string, unknown>).response as Record<string, unknown> | undefined
    check('空 body 的规则存的是真空串（不是 "{}"，也没被当成缺省丢掉）',
      emptyBodyResp !== undefined && emptyBodyResp.body === '', JSON.stringify(emptyBodyResp))

    // 匹配面守卫：全量 mock 是最贵的一种误用
    const matchAll = await cli(at('api', 'create', '--json-list', '{}', '--json'), { config: cfg })
    check('不给 --host/--path → 退出码 2（会命中所有请求，默认拒绝）', matchAll.code === 2 && String(errJson(matchAll)?.message).includes('所有请求'), `${matchAll.code} ${matchAll.err}`)
    const matchAllYes = await cli(at('api', 'create', '--json-list', '{}', '--allow-match-all', '--json'), { config: cfg, timeoutMs: 6000 })
    check('--allow-match-all 但非交互缺 --yes → 退出码 2 且不挂起', matchAllYes.code === 2 && !matchAllYes.timedOut, `${matchAllYes.code} timedOut=${matchAllYes.timedOut}`)
    const matchAll2 = await cli(at('api', 'create', '--json-list', '{}', '--allow-match-all', '--yes', '--path', '/api/p2/all', '--json'), { config: cfg })
    check('显式确认 + 给出 path 后能建', matchAll2.code === 0, `${matchAll2.code} ${matchAll2.err}`)

    const staticMulti = await cli(at('api', 'create', '--path', '/api/p2/x', '--json-list', '{}', '--json-list', '{}', '--mode', 'static', '--json'), { config: cfg })
    check('--mode static 配 2 条 → 退出码 2，hint 给出该用 sequence / specific', staticMulti.code === 2 && String(errJson(staticMulti)?.hint).includes('specific'), `${staticMulti.code} ${staticMulti.err}`)
    check('--mode static 配 2 条的报错说明实际给了几条', String(errJson(staticMulti)?.message).includes('2 条'), String(errJson(staticMulti)?.message))

    const pinOut = await cli(
      at('api', 'create', '--path', '/api/p2/pin', '--json-list', '{}', '--json-list', '{}', '--mode', 'specific', '--pin-index', '9', '--json'),
      { config: cfg },
    )
    check('pinIndex 越界不报错但给 note（服务端会夹到最后一条）', pinOut.code === 0 && String(okJson(pinOut)?.note).includes('夹到'), `${pinOut.code} ${JSON.stringify(okJson(pinOut)?.note)}`)

    // --status / --content-type 也能按下标对齐（「成功 200 / 密码错误 401」是最常见的写法，
    // 只能广播一个状态码的话，README 那条示例就会存成两条都 200）
    const statusPerIndex = await cli(
      at('api', 'create', '--path', '/api/p2/status', '--json-list', '{"code":0}', '--json-list', '{"code":1001}',
        '--status', '200', '--status', '401', '--response-group-names', '成功', '--response-group-names', '密码错误', '--json'),
      { config: cfg },
    )
    const statusResp = (((okJson(statusPerIndex)?.rule ?? {}) as Record<string, unknown>).action as Record<string, unknown>)?.responses as Record<string, unknown>[] | undefined
    check('--status 重复传 → 按返回值下标一一对应（200 / 401）',
      statusPerIndex.code === 0 && statusResp?.length === 2 && Number(statusResp[0]?.status) === 200 && Number(statusResp[1]?.status) === 401,
      `${statusPerIndex.code} ${JSON.stringify(statusResp?.map((x) => x.status))}`)
    check('arrays.requested 里如实记了 status 给了几个值',
      JSON.stringify((okJson(statusPerIndex)?.arrays as Record<string, unknown>)?.requested)?.includes('"status":2') === true,
      JSON.stringify((okJson(statusPerIndex)?.arrays ?? {}) as Record<string, unknown>))

    const statusBroadcast = await cli(
      at('api', 'create', '--path', '/api/p2/bcast', '--json-list', '{"a":1}', '--json-list', '{"a":2}', '--status', '201', '--json'),
      { config: cfg },
    )
    const bcastResp = (((okJson(statusBroadcast)?.rule ?? {}) as Record<string, unknown>).action as Record<string, unknown>)?.responses as Record<string, unknown>[] | undefined
    check('--status 只给一个值 = 广播给每条（不必逼人重复两次）',
      statusBroadcast.code === 0 && bcastResp?.every((x) => Number(x.status) === 201) === true,
      `${statusBroadcast.code} ${JSON.stringify(bcastResp?.map((x) => x.status))}`)

    const statusShort = await cli(
      at('api', 'create', '--path', '/api/p2/status3', '--json-list', '{"a":1}', '--json-list', '{"a":2}', '--json-list', '{"a":3}', '--status', '200', '--status', '401', '--json'),
      { config: cfg },
    )
    check('--status 给了 2 个值但要写 3 条 → 退出码 2 并说清该怎么给',
      statusShort.code === 2 && String(errJson(statusShort)?.message).includes('3 条') && String(errJson(statusShort)?.hint).includes('只给一个值'),
      `${statusShort.code} ${statusShort.err}`)
    const statusDirty = await cli(at('api', 'create', '--path', '/api/p2/stdirty', '--json-list', '{}', '--status', 'abc', '--json'), { config: cfg })
    check('--status 脏值 → 退出码 2（不让 NaN 进规则）', statusDirty.code === 2, `${statusDirty.code} ${statusDirty.err}`)
    const statusRange = await cli(at('api', 'create', '--path', '/api/p2/strange', '--json-list', '{}', '--status', '999', '--json'), { config: cfg })
    check('--status 超出 100–599 → 退出码 2', statusRange.code === 2 && String(errJson(statusRange)?.message).includes('599'), `${statusRange.code} ${statusRange.err}`)

    const ctPerIndex = await cli(
      at('api', 'create', '--path', '/api/p2/ct', '--json-list', '{"a":1}', '--json-list', 'plain',
        '--content-type', 'application/json', '--content-type', 'text/plain', '--json'),
      { config: cfg },
    )
    const ctResp = (((okJson(ctPerIndex)?.rule ?? {}) as Record<string, unknown>).action as Record<string, unknown>)?.responses as Record<string, unknown>[] | undefined
    check('--content-type 也按下标对齐（第 2 条是 text/plain）',
      ctPerIndex.code === 0 && (ctResp?.[1]?.headers as Record<string, unknown>)?.['content-type'] === 'text/plain' &&
        (ctResp?.[0]?.headers as Record<string, unknown>)?.['content-type'] === 'application/json',
      `${ctPerIndex.code} ${JSON.stringify(ctResp?.map((x) => x.headers))}`)

    // update 同理：改第 2 条的状态码不能顺手把第 1 条也改掉
    const updStatus = await cli(at('api', 'update', String(okJson(statusPerIndex)?.id ?? ''), '--status', '200', '--status', '418', '--json'), { config: cfg })
    const updStatusResp = (((okJson(updStatus)?.rule ?? {}) as Record<string, unknown>).action as Record<string, unknown>)?.responses as Record<string, unknown>[] | undefined
    check('update 只给 --status×2 → 逐条改状态码且不动 body',
      updStatus.code === 0 && Number(updStatusResp?.[1]?.status) === 418 && String(updStatusResp?.[0]?.body ?? '') === '{"code":0}',
      `${updStatus.code} ${JSON.stringify(updStatusResp)}`)
    check('update 逐条改状态码后备注名还在', updStatusResp?.[0]?.name === '成功', JSON.stringify(updStatusResp?.[0]))

    // ── update：读改写必须无损 ──
    const updBody = await cli(at('api', 'update', newId, '--json-list', '{"code":0,"n":2}', '--json'), { config: cfg })
    check('api update 改 body 成功并读回', updBody.code === 0 && String(okJson(updBody)?.id) === newId, `${updBody.code} ${updBody.err}`)
    const updAction = ((okJson(updBody)?.rule as Record<string, unknown>)?.action ?? {}) as Record<string, unknown>
    check('update 后 body 是新值', ((updAction.response as Record<string, unknown>)?.body ?? '') === '{"code":0,"n":2}', JSON.stringify(updAction.response))
    check('update 没动 name（没给 --name 就保留原值）',
      (okJson(updBody)?.rule as Record<string, unknown>)?.name === 'P2 新建', JSON.stringify((okJson(updBody)?.rule as Record<string, unknown>)?.name))

    const updGhost = await cli(at('api', 'update', 'r_ghost', '--json-list', '{}', '--json'), { config: cfg })
    check('update 查无此条 → 退出码 4', updGhost.code === 4 && errJson(updGhost)?.error === 'EC_NOT_FOUND', `${updGhost.code} ${updGhost.err}`)

    // 无损读改写：CLI 不认识的字段（规则级 + 条目级）必须原样回来。
    // 规则级这里**不能**用 groupId——它从 C13 起是协议字段（见 C-12），未知字段要用真正的未知键
    const richId = String((okJson(multiCreate)?.id ?? ''))
    const richBefore = ((okJson(multiCreate)?.rule ?? {}) as Record<string, unknown>)
    const patched = await rawCall('PUT', `/__ec/api/rules/${richId}`, sessionA, {
      rule: {
        ...richBefore,
        legacyTag: 't_pay',
        action: { ...(richBefore.action as Record<string, unknown>), latencyHint: 99 },
      },
    })
    check('现场：给这条规则塞进 CLI 不认识的 legacyTag / latencyHint', patched.status === 200, JSON.stringify(patched.json))
    const updRich = await cli(at('api', 'update', richId, '--json-list', '{"code":0}', '--json-list', '{"code":401}', '--json-list', '{"code":500}', '--json'), { config: cfg })
    const richRule = (okJson(updRich)?.rule ?? {}) as Record<string, unknown>
    check('update 只改 body：规则级未知字段 legacyTag 原样保留', updRich.code === 0 && richRule.legacyTag === 't_pay', JSON.stringify(richRule)?.slice(0, 160))
    check('update 只改 body：action 级未知字段 latencyHint 原样保留',
      (richRule.action as Record<string, unknown>)?.latencyHint === 99, JSON.stringify(richRule.action)?.slice(0, 200))
    const richResp = ((richRule.action as Record<string, unknown>)?.responses ?? []) as Record<string, unknown>[]
    check('update 保留每条自己的 cond（改 body 不该把别人的路由条件清空）',
      JSON.stringify(richResp.map((x) => x.cond)) === JSON.stringify(multiResp.map((x) => x.cond)),
      `${JSON.stringify(richResp.map((x) => x.cond))} vs ${JSON.stringify(multiResp.map((x) => x.cond))}`)
    check('update 保留每条 name', richResp[1]?.name === '密码错误', JSON.stringify(richResp[1]))

    const shrinkNoYes = await cli(at('api', 'update', richId, '--json-list', '{"only":1}', '--json'), { config: cfg })
    check('3 条改成 1 条缺 --yes → 退出码 2 且不挂起', shrinkNoYes.code === 2 && !shrinkNoYes.timedOut, `${shrinkNoYes.code} timedOut=${shrinkNoYes.timedOut}`)
    const shrinkStill3 = await rawCall('GET', '/__ec/api/rules', sessionA)
    const richNow = (((shrinkStill3.json as Record<string, unknown>[]) ?? []).find((r) => r.id === richId) ?? {}) as Record<string, unknown>
    const richRespNow = (((richNow.action as Record<string, unknown> | undefined)?.responses ?? []) as Record<string, unknown>[])
    check('被拒绝的收缩没真的删掉返回值', richRespNow.length === 3, String(richRespNow.length))
    const shrinkYes = await cli(at('api', 'update', richId, '--json-list', '{"only":1}', '--yes', '--mode', 'specific', '--json'), { config: cfg })
    const shrinkAction = ((okJson(shrinkYes)?.rule as Record<string, unknown>)?.action ?? {}) as Record<string, unknown>
    check('收缩到 1 条 + specific → 落回旧形态 static 且不留 responses 数组',
      shrinkYes.code === 0 && shrinkAction.mode === 'static' && !('responses' in shrinkAction), JSON.stringify(shrinkAction))
    check('收缩后 legacyTag 还在（形态切换不影响规则级扩展字段）', shrinkAction !== undefined && (okJson(shrinkYes)?.rule as Record<string, unknown>)?.legacyTag === 't_pay', JSON.stringify(okJson(shrinkYes)?.rule)?.slice(0, 120))

    // 只重排命中方式，不碰返回值内容
    const remix = await cli(at('api', 'update', newId, '--mode', 'seq', '--seq-mode', 'random', '--json'), { config: cfg })
    check('不给 --json-list 也能只改命中方式（restyle 而不重写 body）', remix.code === 0 && ((okJson(remix)?.rule as Record<string, unknown>)?.action as Record<string, unknown>)?.seqMode === 'random', `${remix.code} ${remix.err}`)
    const remixAction = ((okJson(remix)?.rule as Record<string, unknown>)?.action ?? {}) as Record<string, unknown>
    check('单条 + sequence 仍保留那一条 response（不凭空造数组）',
      remixAction.mode === 'sequence' && remixAction.response !== undefined, JSON.stringify(remixAction))

    const offFlag = await cli(at('api', 'update', newId, '--off', '--json'), { config: cfg })
    check('update --off 关规则并回读 enabled=false', offFlag.code === 0 && okJson(offFlag)?.enabled === false, `${offFlag.code} ${JSON.stringify(okJson(offFlag))?.slice(0, 120)}`)
    const offBack = await rawCall('GET', '/__ec/api/rules', sessionA)
    const offed = ((offBack.json as Record<string, unknown>[]) ?? []).find((r) => r.id === newId)
    check('关闭真的落进服务端', offed?.enabled === false, JSON.stringify(offed?.enabled))

    const bothFlags = await cli(at('api', 'update', newId, '--on', '--off', '--json'), { config: cfg })
    check('--on 与 --off 同时给 → 退出码 2', bothFlags.code === 2, `${bothFlags.code} ${bothFlags.err}`)
    const badPriority = await cli(at('api', 'update', newId, '--priority', 'abc', '--json'), { config: cfg })
    check('--priority 非数字 → 退出码 2（不 clamp 成 0）', badPriority.code === 2, `${badPriority.code} ${badPriority.err}`)
    // --priority 是合法的、--mode static + 2 条是非法的：两个一起给时**一个字节都不能落库**，
    // 否则失败现场变成「priority 改了、返回值没改」的半态，比整体失败难查得多
    const halfWrite = await cli(at('api', 'update', newId, '--priority', '9', '--mode', 'static', '--json-list', '{}', '--json-list', '{}', '--json'), { config: cfg })
    check('非法组合在校验阶段就失败：priority 没有被写成一半', halfWrite.code === 2, `${halfWrite.code} ${halfWrite.err}`)
    const afterHalf = await rawCall('GET', '/__ec/api/rules', sessionA)
    const halfRule = ((afterHalf.json as Record<string, unknown>[]) ?? []).find((r) => r.id === newId)
    check('服务端仍是失败前的样子（priority 没被偷偷改掉）', (halfRule?.priority ?? 0) !== 9, JSON.stringify(halfRule?.priority))

    // 只给 --status（不给 --json-list）= 整体重刷既有返回值的 status，条数与 body 都不变
    const restyle = await cli(at('api', 'update', newId, '--status', '418', '--json'), { config: cfg })
    const restyleResp = (((okJson(restyle)?.rule ?? {}) as Record<string, unknown>).action as Record<string, unknown>)?.response as Record<string, unknown> | undefined
    check('只给 --status 也能改（不给 --json-list 时按条数重刷既有返回值）', restyle.code === 0, `${restyle.code} ${restyle.err}`)
    check('--status 真的落到那一条返回值上', Number(restyleResp?.status) === 418, JSON.stringify(restyleResp))
    check('--status 重刷不改 body（只换状态码）', String(restyleResp?.body ?? '').includes('"code":0'), JSON.stringify(restyleResp))
    const restyleCt = await cli(at('api', 'update', newId, '--content-type', 'text/csv', '--json'), { config: cfg })
    const restyleCtResp = restyleCt.code === 0
      ? ((((okJson(restyleCt)?.rule ?? {}) as Record<string, unknown>).action as Record<string, unknown>)?.response as Record<string, unknown> | undefined)
      : undefined
    check('只给 --content-type 也能改（整条重刷既有的那一条返回值）', restyleCt.code === 0, `${restyleCt.code} ${restyleCt.err}`)
    check('--content-type 覆盖 content-type 而不丢别的响应头',
      (restyleCtResp?.headers as Record<string, unknown> | undefined)?.['content-type'] === 'text/csv', JSON.stringify(restyleCtResp?.headers))

    // ── copy ──
    // 比对基准必须在复制**那一刻**现读：richNow 是几轮改动之前的快照，拿它当基准会比出一堆假差异
    const origBeforeCopy = (((await rawCall('GET', '/__ec/api/rules', sessionA)).json as Record<string, unknown>[]) ?? [])
      .find((r) => r.id === richId) as Record<string, unknown> | undefined
    const copied = await cli(at('api', 'copy', richId, '--json'), { config: cfg })
    const copyJson = okJson(copied)
    const copyId = String(copyJson?.id ?? '')
    check('api copy 退出码 0 且拿到新 id', copied.code === 0 && copyId !== '' && copyId !== richId, `${copied.code} ${copied.err}`)
    check('副本缺省命名 = 原名 + 副本', String(copyJson?.name).endsWith('副本'), String(copyJson?.name))
    const copyRule = (copyJson?.rule ?? {}) as Record<string, unknown>
    const stripIdName = (r: Record<string, unknown>): string => {
      const { id: _i, name: _n, ...rest } = r
      return JSON.stringify(rest)
    }
    check('副本除 id / name 外与原件逐字段一致（不只是条数一致）',
      origBeforeCopy !== undefined && stripIdName(copyRule) === stripIdName(origBeforeCopy),
      `${stripIdName(copyRule)?.slice(0, 150)} vs ${stripIdName(origBeforeCopy ?? {})?.slice(0, 150)}`)
    check('副本的 legacyTag 这类规则级扩展字段也一起复制过去了',
      copyRule.legacyTag === 't_pay', JSON.stringify(copyRule.legacyTag))
    const origStill = await rawCall('GET', '/__ec/api/rules', sessionA)
    const origCount = ((origStill.json as Record<string, unknown>[]) ?? []).filter((r) => r.id === richId).length
    check('复制不会把原件弄丢', origCount === 1, String(origCount))
    const named = await cli(at('api', 'copy', richId, '--name', 'P2 副本命名', '--json'), { config: cfg })
    check('copy --name 用给定名字', named.code === 0 && named.out.includes('P2 副本命名'), `${named.code} ${named.err}`)
    const namedRule = (okJson(named)?.rule ?? {}) as Record<string, unknown>
    check('副本拿到新 id，不是覆盖原件', String(namedRule.id ?? '') !== richId, JSON.stringify(namedRule.id))
    const copyGhost = await cli(at('api', 'copy', 'r_ghost', '--json'), { config: cfg })
    check('copy 查无此条 → 退出码 4', copyGhost.code === 4 && errJson(copyGhost)?.error === 'EC_NOT_FOUND', `${copyGhost.code} ${copyGhost.err}`)
    const copyBadFlag = await cli(at('api', 'copy', richId, '--mode', 'seq', '--json'), { config: cfg })
    check('copy 不接受 update 的 flag（未知 flag 报错，不静默忽略）', copyBadFlag.code !== 0, `${copyBadFlag.code} ${copyBadFlag.err.slice(0, 120)}`)

    // ── 写进去的东西真的能被数据面命中（不只「存下来了」）──
    const live = await cli(at('api', 'create', '--path', '/api/p2/live', '--json-list', '{"from":"cli"}', '--status', '201', '--name', 'P2 命中', '--json'), { config: cfg })
    const liveId = String(okJson(live)?.id ?? '')
    const liveResp = (((okJson(live)?.rule ?? {}) as Record<string, unknown>).action as Record<string, unknown>)?.response as Record<string, unknown> | undefined
    check('api create --status 201 建好并读回 201', live.code === 0 && Number(liveResp?.status) === 201, `${live.code} ${JSON.stringify(liveResp)}`)
    const hit = await dataGet('http://api.example.com/api/p2/live', 'cli-dev-1')
    check('CLI 建的规则真的被数据面命中（201 + 正文）', hit.status === 201 && hit.body.includes('"from":"cli"'), `${hit.status} ${hit.body.slice(0, 80)}`)

    const offAgain = await cli(at('api', 'switch', liveId, '--off', '--json'), { config: cfg })
    const miss = await dataGet('http://api.example.com/api/p2/live', 'cli-dev-1')
    check('关掉后不再命中（走上游，拿不到 201）', offAgain.code === 0 && miss.status !== 201, `${offAgain.code} ${miss.status}`)

    // ── 契约细节：--json 模式 stdout 干净、错误走 stderr ──
    const cleanCreate = await cli(at('api', 'create', '--path', '/api/p2/clean', '--json-list', '{}', '--json', '--quiet'), { config: cfg })
    check('--json --quiet 下 stdout 只有这一条 JSON（无进度文案）',
      cleanCreate.code === 0 && cleanCreate.out.trimStart().startsWith('{') && cleanCreate.out.trim().endsWith('}') && !cleanCreate.out.includes('已新建'),
      cleanCreate.out.slice(0, 120))
    check('--quiet 下 stderr 也没有人类提示', !cleanCreate.err.includes('已新建'), cleanCreate.err.slice(0, 120))

    const humanCreate = await cli(at('api', 'create', '--path', '/api/p2/human', '--json-list', '{}', '--name', '人类模式'), { config: cfg })
    // 人类模式的进度走 stderr（info()），stdout 留给结果本体——所以这里读 err 不是 out
    check('人类模式给出「已新建规则 <id>…已读回确认」', humanCreate.code === 0 && humanCreate.err.includes('已新建') && /r_/.test(humanCreate.err), `${humanCreate.code} ${humanCreate.err}`)

    // 清理：本段建的规则全部删掉，别把脏现场留给后面的用例
    const allBefore = (await rawCall('GET', '/__ec/api/rules', sessionA)).json as Record<string, unknown>[]
    const p2Ids = allBefore.filter((r) => String((r.match as Record<string, unknown>)?.path ?? '').startsWith('/api/p2/')).map((r) => String(r.id))
    let delAllOk = p2Ids.length > 0
    for (const id of p2Ids) {
      const one = await cli(at('api', 'delete', id, '--yes', '--json'), { config: cfg })
      if (one.code !== 0) delAllOk = false
    }
    const leftAfter = (await rawCall('GET', '/__ec/api/rules', sessionA)).json as Record<string, unknown>[]
    check(`清理本段建的 ${p2Ids.length} 条规则（都删干净，不污染后续用例）`,
      delAllOk && leftAfter.every((r) => !String((r.match as Record<string, unknown>)?.path ?? '').startsWith('/api/p2/')),
      JSON.stringify(leftAfter.map((r) => (r.match as Record<string, unknown>)?.path)))
    // ────────────────────────────────────────────────
    section('[C-12] group：项目增删改查 + 整项目开关 + --group-id 三种语义（C14 / ADR-033）')

    // 本段规则统一用 /api/grp/ 前缀，方便与历史用例隔离并计数（不依赖「服务端现在是空的」这种假设）
    const allRules = async (): Promise<Record<string, unknown>[]> =>
      (((await rawCall('GET', '/__ec/api/rules', sessionA)).json as Record<string, unknown>[]) ?? [])
    const grpRules = async (): Promise<Record<string, unknown>[]> =>
      (await allRules()).filter((r) => String((r.match as Record<string, unknown>)?.path ?? '').startsWith('/api/grp/'))
    const ruleById = async (id: string): Promise<Record<string, unknown> | undefined> =>
      (await allRules()).find((r) => r.id === id)
    const grpPath = (p: string): string => `http://api.example.com${p}`
    /** 容错分支只能在进程内测：真服务端一定有项目端点，「老服务端」必须靠假客户端复现 */
    async function probeGroupRead(
      code: string,
      opts: { tolerateMissing?: boolean },
      fn: (client: ManagementClient, o: { tolerateMissing?: boolean }) => Promise<unknown>,
    ): Promise<{ view: unknown; err: string }> {
      const fake = { call: async () => { throw new CliError(code, `假 ${code}`, null) } } as unknown as ManagementClient
      try {
        return { view: await fn(fake, opts), err: '' }
      } catch (e) {
        return { view: null, err: e instanceof CliError ? e.code : `not-CliError:${String(e).slice(0, 40)}` }
      }
    }

    // C14 的命中口径要求「设备 owner == 项目 owner」，所以数据面用例先绑一台设备到本空间
    await hello('grp-dev', 'sGrp', '项目段测试机')
    const bindGrp = await cli(at('device', 'bind', 'grp-dev', '--json'), { config: cfg })
    check('现场：grp-dev 绑到本空间（命中要求设备 owner == 项目 owner）',
      bindGrp.code === 0 && (okJson(bindGrp)?.device as Record<string, unknown> | undefined)?.owner === PHONE, `${bindGrp.code} ${bindGrp.err}`)

    // ── 建项目 ──
    const gA = await cli(at('group', 'create', '--name', '  登录模块  ', '--on', '--json'), { config: cfg })
    const gAJson = okJson(gA)
    const gid = String(gAJson?.id ?? '')
    const gAView = (gAJson?.group ?? {}) as Record<string, unknown>
    check('group create 退出码 0，拿到服务端生成的 g_ 前缀 id', gA.code === 0 && /^g_/.test(gid), `${gA.code} ${gA.err}`)
    check('group create 读回校验通过（verified:true，不是「服务端 200 就算成」）', gAJson?.verified === true, JSON.stringify(gAJson)?.slice(0, 160))
    check('组名两端空白在建之前就 trim（否则读回比对必是假阳性）', gAView.name === '登录模块', JSON.stringify(gAView.name))
    check('--on 落成 enabled:true', gAView.enabled === true, JSON.stringify(gAView.enabled))
    check('新建的就是私有项目：scope=private、owner=会话手机号（命中归属的来源）',
      gAView.scope === 'private' && gAView.ownerPhone === PHONE, JSON.stringify([gAView.scope, gAView.ownerPhone]))
    check('新建分组带回 createdAt / updatedAt（详情页要显示时间线）',
      typeof gAView.createdAt === 'number' && typeof gAView.updatedAt === 'number', JSON.stringify([gAView.createdAt, gAView.updatedAt]))

    const gB = await cli(at('group', 'create', '--name', '默认开关', '--json'), { config: cfg })
    const gidB = String(okJson(gB)?.id ?? '')
    check('group create 不给开关时默认「开」（建了组却一条都不命中是最坏的初见）',
      gB.code === 0 && (okJson(gB)?.group as Record<string, unknown> | undefined)?.enabled === true, `${gB.code} ${gB.err}`)
    const gC = await cli(at('group', 'create', '--name', '天生关着的组', '--off', '--json'), { config: cfg })
    const gidC = String(okJson(gC)?.id ?? '')
    check('group create --off 建出一个默认关着的组',
      gC.code === 0 && (okJson(gC)?.group as Record<string, unknown> | undefined)?.enabled === false, `${gC.code} ${gC.err}`)

    const gNoName = await cli(at('group', 'create', '--json'), { config: cfg })
    check('group create 缺 --name → 退出码 2（EC_USAGE；功能已实现，不该报 64）',
      gNoName.code === 2 && errJson(gNoName)?.error === 'EC_USAGE', `${gNoName.code} ${gNoName.err}`)
    const gBlank = await cli(at('group', 'create', '--name', '   ', '--json'), { config: cfg })
    check('group create --name 纯空白 → 退出码 2，不建出空名组', gBlank.code === 2 && !gBlank.timedOut, `${gBlank.code} ${gBlank.err}`)
    const gBoth = await cli(at('group', 'create', '--name', '开关都给', '--on', '--off', '--json'), { config: cfg })
    check('group create --on 与 --off 同时给 → 退出码 2（不替你猜方向）', gBoth.code === 2, `${gBoth.code} ${gBoth.err.slice(0, 120)}`)
    const gExtra = await cli(at('group', 'create', '--name', '多一个裸参数', 'g_sneaky', '--json'), { config: cfg })
    check('group create 后面多裸 token → 退出码 2（不会被静默丢掉）', gExtra.code === 2, `${gExtra.code} ${gExtra.err.slice(0, 120)}`)
    const gQuiet = await cli(at('group', 'create', '--name', '管道友好', '--json', '--quiet'), { config: cfg })
    const gQuietId = String(okJson(gQuiet)?.id ?? '')
    check('--json --quiet 下 group create 的 stdout 只有这一份 JSON（无进度文案混进去）',
      gQuiet.code === 0 && okJson(gQuiet) !== null && gQuiet.out.trimStart().startsWith('{') && gQuiet.out.trim().endsWith('}') && !gQuiet.err.includes('已新建'),
      `${gQuiet.code}|${gQuiet.out.slice(0, 80)}|${gQuiet.err.slice(0, 80)}`)

    // ── 列表 / 筛选 ──
    const gList = await cli(at('group', 'list', '--json'), { config: cfg })
    const gRows = (okJson(gList)?.groups ?? []) as Record<string, unknown>[]
    const gTotal = Number(okJson(gList)?.total ?? 0)
    check('group list 列出刚建的项目', gList.code === 0 && [gid, gidB, gidC, gQuietId].every((x) => gRows.some((g) => g.id === x)), JSON.stringify(gRows.map((g) => g.id)))
    check('每个项目都带 ruleCount（协议 §4.7 由服务端附带，CLI 不必再拉规则表去数）',
      gRows.length > 0 && gRows.every((g) => 'ruleCount' in g), JSON.stringify(gRows[0]))
    check('列表如实分开两档计数（此刻全是私有：sharedCount=0）',
      Number(okJson(gList)?.privateCount) === gTotal && okJson(gList)?.sharedCount === 0, JSON.stringify([okJson(gList)?.privateCount, okJson(gList)?.sharedCount]))
    check('没有筛选时 filteredBy 明确为 null（不谎称做过筛选）', okJson(gList)?.filteredBy === null && okJson(gList)?.filtered === false, JSON.stringify(okJson(gList)?.filteredBy))
    const gListHuman = await cli(at('group', 'list'), { config: cfg })
    check('group list 人类模式列出「归属 / 开关 / 规则数」列',
      gListHuman.code === 0 && gListHuman.out.includes('归属') && gListHuman.out.includes('规则数'), gListHuman.out.slice(0, 200))
    check('人类模式解释 * 是本地默认项目、命令不会自动按它过滤',
      gListHuman.err.includes('本地默认项目'), gListHuman.err.slice(0, 200))
    const gOffOnly = await cli(at('group', 'list', '--enabled', 'false', '--json'), { config: cfg })
    const offRows = (okJson(gOffOnly)?.groups ?? []) as Record<string, unknown>[]
    check('group list --enabled false 只出关着的项目',
      gOffOnly.code === 0 && offRows.length === 1 && offRows[0].id === gidC, JSON.stringify(offRows.map((g) => g.id)))
    check('筛选在 CLI 侧做并如实回显 filteredBy', JSON.stringify(okJson(gOffOnly)?.filteredBy) === JSON.stringify({ enabled: false, q: null, scope: null }), JSON.stringify(okJson(gOffOnly)?.filteredBy))
    const gByName = await cli(at('group', 'list', '--q', '登录', '--json'), { config: cfg })
    check('group list --q 按名字筛选', (okJson(gByName)?.groups as Record<string, unknown>[] | undefined)?.length === 1 && String(((okJson(gByName)?.groups as Record<string, unknown>[]) ?? [])[0]?.name) === '登录模块', gByName.out.slice(0, 160))
    const gScope = await cli(at('group', 'list', '--scope', 'private', '--json'), { config: cfg })
    check('--scope private 过滤掉共享档（此刻全是私有，filtered 如实标记）',
      gScope.code === 0 && Number(okJson(gScope)?.count) === gTotal && (okJson(gScope)?.filteredBy as Record<string, unknown> | undefined)?.scope === 'private', JSON.stringify(okJson(gScope)?.filteredBy))
    const gBadEnabled = await cli(at('group', 'list', '--enabled', '1', '--json'), { config: cfg })
    check('--enabled 只认真布尔：收到 1 报错而不是当成 true', gBadEnabled.code === 2 && errJson(gBadEnabled)?.error === 'EC_USAGE', `${gBadEnabled.code} ${gBadEnabled.err.slice(0, 120)}`)
    const gBadScope = await cli(at('group', 'list', '--scope', 'mine', '--json'), { config: cfg })
    check('--scope 只认 private/shared/all：写错值报 2 而不是当「不过滤」', gBadScope.code === 2, `${gBadScope.code} ${gBadScope.err.slice(0, 120)}`)
    const gNoHit = await cli(at('group', 'list', '--q', '不存在的关键字', '--json'), { config: cfg })
    check('筛选后 0 个时如实给「count 0 / total N」', gNoHit.code === 0 && okJson(gNoHit)?.count === 0 && Number(okJson(gNoHit)?.total) === gTotal, `${okJson(gNoHit)?.count} vs ${gTotal}`)

    // ── 单个项目 ──
    const gGetEmpty = await cli(at('group', 'get', gid, '--json'), { config: cfg })
    check('group get 空项目：memberCount 0 且带项目本体',
      gGetEmpty.code === 0 && okJson(gGetEmpty)?.memberCount === 0 && (okJson(gGetEmpty)?.group as Record<string, unknown> | undefined)?.id === gid, `${gGetEmpty.code} ${gGetEmpty.err}`)
    check('group get 如实回答「参与命中」（私有 + 开 → true）', okJson(gGetEmpty)?.participatesInHit === true, JSON.stringify(okJson(gGetEmpty)?.participatesInHit))
    const gGetEmptyHuman = await cli(at('group', 'get', gid), { config: cfg })
    check('group get 空项目时人类模式明说「项目内没有规则」（不是漏显示）',
      gGetEmptyHuman.code === 0 && gGetEmptyHuman.err.includes('项目内没有规则'), gGetEmptyHuman.err.slice(0, 200))
    const gGetGhost = await cli(at('group', 'get', 'g_ghost_不存在', '--json'), { config: cfg })
    check('group get 查无此项目 → 退出码 4 并列出可用的 id',
      gGetGhost.code === 4 && errJson(gGetGhost)?.error === 'EC_NOT_FOUND' && String(errJson(gGetGhost)?.hint).includes(gid), `${gGetGhost.code} ${String(errJson(gGetGhost)?.hint).slice(0, 120)}`)

    // ── 规则挂项目：写入 + 数据面真的命中 ──
    const rIn = await cli(at('api', 'create', '--path', '/api/grp/login', '--json-list', '{"who":"in-group"}', '--status', '201', '--name', '组内规则', '--group-id', gid, '--json'), { config: cfg })
    const rInJson = okJson(rIn)
    const rid = String(rInJson?.id ?? '')
    check('api create --group-id 建好规则并读回 groupId', rIn.code === 0 && rInJson?.groupId === gid, `${rIn.code} ${rIn.err}`)
    // 这条挂 gidC 而不是 gid：下面「项目里到底几条」的断言都按 gid = login + seq 两条来算，
    // 多塞一条进去，affected / ruleCount / off-by-project 测的就不再是它们声称的东西了
    const noteRun = await cli(at('api', 'create', '--path', '/api/grp/note', '--json-list', '{}', '--group-id', gidC), { config: cfg })
    check('人类模式把项目写进「已新建规则 …」进度文案', noteRun.code === 0 && noteRun.err.includes(`项目 ${gidC}`), `${noteRun.code} ${noteRun.err.slice(0, 200)}`)
    const hitOpen = await dataGet(grpPath('/api/grp/login'), 'grp-dev')
    check('挂在**开着**的项目里的规则被数据面命中（201 + 正文）', hitOpen.status === 201 && hitOpen.body.includes('in-group'), `${hitOpen.status} ${hitOpen.body.slice(0, 60)}`)
    // 守卫用例的基准条数：失败必须「零写入」，所以基准要在两次失败尝试**之前**取
    const cntBeforeGuards = (await grpRules()).length

    const rGhost = await cli(at('api', 'create', '--path', '/api/grp/ghost', '--json-list', '{}', '--group-id', 'g_ghost_不存在', '--json'), { config: cfg })
    check('api create --group-id 指向不存在的项目 → 退出码 4', rGhost.code === 4 && errJson(rGhost)?.error === 'EC_NOT_FOUND', `${rGhost.code} ${rGhost.err.slice(0, 120)}`)
    check('核对失败时一条规则都没写下去（不会留下悬空 id）', (await grpRules()).length === cntBeforeGuards, `${cntBeforeGuards} → ${(await grpRules()).length}`)
    const rEmptyCreate = await cli(at('api', 'create', '--path', '/api/grp/empty', '--json-list', '{}', '--group-id', '', '--json'), { config: cfg })
    check('api create --group-id "" → 退出码 2（C14 没有「不挂组」这个选项：无归属 = 永不命中）', rEmptyCreate.code === 2 && errJson(rEmptyCreate)?.error === 'EC_USAGE', `${rEmptyCreate.code} ${rEmptyCreate.err.slice(0, 120)}`)
    check('空串创建的失败同样没写出规则', (await grpRules()).length === cntBeforeGuards, `${cntBeforeGuards} → ${(await grpRules()).length}`)

    // ── --group-id 作为筛选条件 ──
    const byGroup = await cli(at('api', 'list', '--group-id', gid, '--json'), { config: cfg })
    const byGroupRows = (okJson(byGroup)?.rules ?? []) as Record<string, unknown>[]
    check('api list --group-id 只返回该项目的规则', byGroup.code === 0 && byGroupRows.every((r) => r.groupId === gid) && byGroupRows.some((r) => r.id === rid), JSON.stringify(byGroupRows.map((r) => r.id)))
    check('项目开着 → effective=active、groupEnabled=true',
      byGroupRows.every((r) => r.effective === 'active' && r.groupEnabled === true), JSON.stringify(byGroupRows.map((r) => [r.effective, r.groupEnabled])))
    check('--group-id 回显在 filteredBy 里（结果不是「全部规则」）',
      okJson(byGroup)?.filtered === true && (okJson(byGroup)?.filteredBy as Record<string, unknown> | undefined)?.groupId === gid, JSON.stringify(okJson(byGroup)?.filteredBy))
    const onlyUngrouped = await cli(at('api', 'list', '--group-id', '', '--json'), { config: cfg })
    const ungroupedIds = (((okJson(onlyUngrouped)?.rules ?? []) as Record<string, unknown>[]).map((r) => String(r.id)))
    check('api list --group-id "" 只看无归属：C14 下服务端根本不下发这类规则，如实回 0 条并带 note',
      onlyUngrouped.code === 0 && ungroupedIds.length === 0 && String(okJson(onlyUngrouped)?.note ?? '').includes('无归属') && (okJson(onlyUngrouped)?.filteredBy as Record<string, unknown> | undefined)?.groupId === '', JSON.stringify(onlyUngrouped.out)?.slice(0, 120))
    const ghostFilter = await cli(at('api', 'list', '--group-id', 'g_ghost_不存在', '--json'), { config: cfg })
    check('按不存在的项目筛选 → 退出码 4，而不是静默返回空列表（「空项目」与「写错 id」必须可区分）',
      ghostFilter.code === 4 && errJson(ghostFilter)?.error === 'EC_NOT_FOUND', `${ghostFilter.code} ${ghostFilter.err.slice(0, 120)}`)

    // ── --group-id 作为归属校验 ──
    const wrongSwitch = await cli(at('api', 'switch', rid, '--off', '--group-id', gidC, '--json'), { config: cfg })
    check('api switch --group-id 归属不匹配 → 退出码 4（不静默动别的项目的规则）',
      wrongSwitch.code === 4 && String(errJson(wrongSwitch)?.message).includes('不是项目'), `${wrongSwitch.code} ${String(errJson(wrongSwitch)?.message).slice(0, 120)}`)
    const afterWrongSwitch = await cli(at('api', 'get', rid, '--json'), { config: cfg })
    check('被拒绝的 switch 没有真的改到规则（enabled 仍是 true）',
      (okJson(afterWrongSwitch)?.summary as Record<string, unknown> | undefined)?.enabled === true, JSON.stringify(okJson(afterWrongSwitch)?.summary))
    const wrongGet = await cli(at('api', 'get', rid, '--group-id', '', '--json'), { config: cfg })
    check('api get --group-id "" 对已挂项目的规则报 4（它不是无归属）', wrongGet.code === 4, String(wrongGet.code))
    const wrongDelete = await cli(at('api', 'delete', rid, '--group-id', gidC, '--yes', '--json'), { config: cfg })
    check('api delete 的 --group-id 同样是归属校验：不匹配就 4，且规则还在',
      wrongDelete.code === 4 && (await ruleById(rid)) !== undefined, `${wrongDelete.code} ${String(wrongDelete.code)}`)
    const rightSwitch = await cli(at('api', 'switch', rid, '--off', '--group-id', gid, '--json'), { config: cfg })
    check('归属正确时才放行（同一命令加对 --group-id 就成功，并回显 enabled/groupId）',
      rightSwitch.code === 0 && okJson(rightSwitch)?.enabled === false && okJson(rightSwitch)?.groupId === gid && okJson(rightSwitch)?.verified === true,
      `${rightSwitch.code} ${JSON.stringify(okJson(rightSwitch))?.slice(0, 140)}`)
    const hitRuleOff = await dataGet(grpPath('/api/grp/login'), 'grp-dev')
    check('规则自身关掉后不再命中（项目开着也没用：命中是一条 AND）', hitRuleOff.status !== 201, String(hitRuleOff.status))
    const backOn = await cli(at('api', 'switch', rid, '--on', '--json'), { config: cfg })
    check('恢复规则开关（后续用例从「规则开、项目开」出发）', backOn.code === 0 && (await dataGet(grpPath('/api/grp/login'), 'grp-dev')).status === 201, String(backOn.code))

    // ── 序列指针：关项目不能把正在走的序列卷回第 1 条 ──
    const rSeq = await cli(at('api', 'create', '--path', '/api/grp/seq', '--json-list', '{"i":1}', '--json-list', '{"i":2}', '--mode', 'sequence', '--name', '组内序列', '--group-id', gid, '--json'), { config: cfg })
    const seqId = String(okJson(rSeq)?.id ?? '')
    check('项目里再放一条序列规则（两次 --json-list = 两个返回值）', rSeq.code === 0 && seqId !== '' && ((okJson(rSeq)?.rule ?? {}) as Record<string, unknown>) !== undefined, `${rSeq.code} ${rSeq.err}`)
    const seq1 = await dataGet(grpPath('/api/grp/seq'), 'grp-dev')
    const seq2 = await dataGet(grpPath('/api/grp/seq'), 'grp-dev')
    check('序列规则按顺序走：第 1 次 {"i":1}、第 2 次 {"i":2}', seq1.body.includes('"i":1') && seq2.body.includes('"i":2'), `${seq1.body.slice(0, 40)} | ${seq2.body.slice(0, 40)}`)

    const swNoFlag = await cli(at('group', 'switch', gid, '--json'), { config: cfg })
    check('group switch 不给 --on/--off → 退出码 2（不给默认值：猜错方向就是整组接口打真实服务器）', swNoFlag.code === 2, `${swNoFlag.code} ${swNoFlag.err.slice(0, 120)}`)
    const swBoth = await cli(at('group', 'switch', gid, '--on', '--off', '--json'), { config: cfg })
    check('group switch 同时给 --on 和 --off → 退出码 2', swBoth.code === 2, String(swBoth.code))
    const swGhost = await cli(at('group', 'switch', 'g_ghost_不存在', '--off', '--json'), { config: cfg })
    check('group switch 查无此项目 → 退出码 4', swGhost.code === 4 && errJson(swGhost)?.error === 'EC_NOT_FOUND', String(swGhost.code))

    const gidRules = (await grpRules()).filter((r) => r.groupId === gid)
    const closeGroup = await cli(at('group', 'switch', gid, '--off', '--json'), { config: cfg })
    const cg = okJson(closeGroup)
    check('group switch --off 读回 enabled:false 并回传 affected（组里几条被挡掉）',
      closeGroup.code === 0 && cg?.enabled === false && Number(cg?.affected) === gidRules.length && gidRules.length === 2,
      `${closeGroup.code} affected=${JSON.stringify(cg)?.slice(0, 160)}`)
    check('开关 payload 带上 previous 与 verified（「原来是开还是关」要能复查）', cg?.previous === true && cg?.verified === true, JSON.stringify([cg?.previous, cg?.verified]))
    const hitClosed = await dataGet(grpPath('/api/grp/login'), 'grp-dev')
    check('关项目后数据面不再命中（整组走上游）', hitClosed.status !== 201 && !hitClosed.body.includes('in-group'), `${hitClosed.status} ${hitClosed.body.slice(0, 50)}`)
    const seqHitClosed = await dataGet(grpPath('/api/grp/seq'), 'grp-dev')
    check('关项目期间序列既不命中也不推进', !seqHitClosed.body.includes('"i":1') && !seqHitClosed.body.includes('"i":2'), seqHitClosed.body.slice(0, 50))
    const rulesWhileClosed = (await grpRules()).filter((r) => r.groupId === gid)
    check('关项目**没有**改写组内规则自己的 enabled（ADR-030：重开即恢复原状）',
      rulesWhileClosed.length === gidRules.length && rulesWhileClosed.every((r) => r.enabled === true), JSON.stringify(rulesWhileClosed.map((r) => r.enabled)))

    const blocked = await cli(at('api', 'list', '--group-id', gid, '--json'), { config: cfg })
    const blockedRows = (okJson(blocked)?.rules ?? []) as Record<string, unknown>[]
    check('关项目期间 effective 如实标 off-by-project，而 on 列仍是 ✓',
      blockedRows.length === gidRules.length && blockedRows.every((r) => r.effective === 'off-by-project' && r.enabled === true), JSON.stringify(blockedRows.map((r) => [r.id, r.effective])))
    check('groupEnabled:false 一并带出，agent 不必二次确认', blockedRows.every((r) => r.groupEnabled === false), JSON.stringify(blockedRows.map((r) => r.groupEnabled)))
    const blockedHuman = await cli(at('api', 'list'), { config: cfg })
    check('人类模式点名「N 条规则的 on=✓ 但当前不命中」', blockedHuman.err.includes('当前不命中'), blockedHuman.err.slice(0, 200))
    check('人类模式项目列写成 <id>(项目关)', blockedHuman.out.includes(`${gid}(项目关)`), blockedHuman.out.slice(0, 240))
    const blockedGet = await cli(at('api', 'get', rid, '--json'), { config: cfg })
    check('api get 也回答「实际是否命中」（status=off-by-project，而不是只看 enabled）',
      blockedGet.code === 0 && (okJson(blockedGet)?.status as Record<string, unknown> | undefined)?.effective === 'off-by-project', JSON.stringify(okJson(blockedGet)?.status))
    const blockedGetHuman = await cli(at('api', 'get', rid), { config: cfg })
    check('api get 人类模式把「当前不命中（所属项目已关）」打进输出', blockedGetHuman.out.includes('不命中'), blockedGetHuman.out.slice(0, 240))

    const gGetBlocked = await cli(at('group', 'get', gid, '--json'), { config: cfg })
    const gbm = (okJson(gGetBlocked)?.members ?? []) as Record<string, unknown>[]
    check('group get 逐条标出成员被项目挡掉（这是唯一能看出「项目挡了几条」的地方）',
      gGetBlocked.code === 0 && gbm.length === gidRules.length && gbm.every((m) => m.effective === 'off-by-project'), JSON.stringify(gbm.map((m) => m.effective)))
    check('group get 的成员数与服务端 ruleCount 一致',
      (okJson(gGetBlocked)?.group as Record<string, unknown> | undefined)?.ruleCount === gidRules.length, JSON.stringify(okJson(gGetBlocked)?.group))
    const gGetBlockedHuman = await cli(at('group', 'get', gid), { config: cfg })
    check('group get 人类模式点明「项目是关的，上面这些规则当前都不命中」',
      gGetBlockedHuman.err.includes('当前都不命中'), gGetBlockedHuman.err.slice(0, 220))

    const reopen = await cli(at('group', 'switch', gid, '--on', '--json'), { config: cfg })
    const hitAgain = await dataGet(grpPath('/api/grp/login'), 'grp-dev')
    check('重开项目即恢复命中，且规则一行没被改', reopen.code === 0 && hitAgain.status === 201 && hitAgain.body.includes('in-group'), `${reopen.code} ${hitAgain.status}`)
    const seqAfterReopen = await dataGet(grpPath('/api/grp/seq'), 'grp-dev')
    check('关项目不重置抓包序列指针（重开继续往下走，不回卷到 {"i":1}）',
      seqAfterReopen.body.includes('"i":2') && !seqAfterReopen.body.includes('"i":1'), seqAfterReopen.body.slice(0, 60))

    // ── 改名 / 改开关（PUT 是整条替换） ──
    const upd = await cli(at('group', 'update', gid, '--name', '  登录模块 v2  ', '--json'), { config: cfg })
    const updJson = okJson(upd)
    const updView = (updJson?.group ?? {}) as Record<string, unknown>
    check('group update 改名并读回（trim 后比对，不做假阳性）',
      upd.code === 0 && updView.name === '登录模块 v2' && updJson?.renamed === true, `${upd.code} ${upd.err}`)
    check('group update 保留 createdAt（整条替换不能把时间线抹掉）',
      updView.createdAt === gAView.createdAt, JSON.stringify([gAView.createdAt, updView.createdAt]))
    check('改名不动组内规则（换的是容器元数据，不是内容）', Number(updView.ruleCount) === gidRules.length, JSON.stringify(updView.ruleCount))
    const updNothing = await cli(at('group', 'update', gid, '--json'), { config: cfg })
    check('group update 什么都没给 → 退出码 2（不发「零写入还报成功」的假动作）', updNothing.code === 2, `${updNothing.code} ${updNothing.err.slice(0, 120)}`)
    const gUpdGhost = await cli(at('group', 'update', 'g_ghost_不存在', '--name', 'x', '--json'), { config: cfg })
    check('group update 查无此组 → 退出码 4（不会当成新建）', gUpdGhost.code === 4 && errJson(gUpdGhost)?.error === 'EC_NOT_FOUND', String(gUpdGhost.code))
    const updBoth = await cli(at('group', 'update', gid, '--on', '--off', '--json'), { config: cfg })
    check('group update --on 与 --off 同时给 → 退出码 2', updBoth.code === 2, String(updBoth.code))
    const updOff = await cli(at('group', 'update', gid, '--off', '--json'), { config: cfg })
    check('group update 也能改开关（enabledChanged:true 且读回为关）',
      updOff.code === 0 && okJson(updOff)?.enabledChanged === true && (okJson(updOff)?.group as Record<string, unknown> | undefined)?.enabled === false, `${updOff.code} ${updOff.err}`)
    const restoreOn = await cli(at('group', 'update', gid, '--on', '--json'), { config: cfg })
    check('group update --on 恢复为开（后续用例从组开着出发）', restoreOn.code === 0, `${restoreOn.code} ${restoreOn.err}`)

    // ── 本地默认分组 ──
    const setG = await cli(at('set', 'group', gid, '--json'), { config: cfg })
    check('set group 到真实存在的分组 → 退出码 0 且 verified:true', setG.code === 0 && okJson(setG)?.verified === true, `${setG.code} ${setG.err}`)
    check('默认分组写进了配置文件', ConfigStore.load(cfg).data.defaults.group === gid, String(ConfigStore.load(cfg).data.defaults.group))
    const setGHuman = await cli(at('set', 'group', gid), { config: cfg })
    check('人类模式说明「这是本地默认值，命令不会自动按它过滤或挂载」', setGHuman.err.includes('本地默认值'), setGHuman.err.slice(0, 200))
    const listWithDefault = await cli(at('group', 'list'), { config: cfg })
    check('set group 之后 group list 用 * 标出默认分组', listWithDefault.out.includes('*') && listWithDefault.out.includes(gid), listWithDefault.out.slice(0, 200))

    // ── copy / update 上的 --group-id（C14：只认私有项目；空串与跨项目都在 CLI 侧拒）──
    const cntBeforeCopy = (await grpRules()).length
    const copyIn = await cli(at('api', 'copy', rid, '--group-id', gidC, '--json'), { config: cfg })
    check('api copy --group-id 把副本挂到指定项目', copyIn.code === 0 && okJson(copyIn)?.groupId === gidC, `${copyIn.code} ${copyIn.err}`)
    check('往**关着的项目**里写规则时，stderr 点名这个项目当前是关的',
      copyIn.err.includes('项目') && copyIn.err.includes('关'), copyIn.err.slice(0, 220))
    const copyEmpty = await cli(at('api', 'copy', rid, '--group-id', '', '--json'), { config: cfg })
    check('api copy --group-id "" → 退出码 6（副本必须挂私有项目，无归属 = 永不命中）',
      copyEmpty.code === 6 && errJson(copyEmpty)?.error === 'EC_SCOPE_MISMATCH', `${copyEmpty.code} ${copyEmpty.err.slice(0, 140)}`)
    const copySame = await cli(at('api', 'copy', rid, '--json'), { config: cfg })
    const copyOutId = String(okJson(copySame)?.id ?? '')
    check('api copy 不带 --group-id = 连源项目一起复制（最常见形态）',
      copySame.code === 0 && okJson(copySame)?.groupId === gid, `${copySame.code} ${copySame.err}`)
    const moveTo = await cli(at('api', 'update', copyOutId, '--group-id', gid, '--json'), { config: cfg })
    check('api update --group-id 给**原项目** id → 放行（同值不算挪动）', moveTo.code === 0 && okJson(moveTo)?.groupId === gid, `${moveTo.code} ${moveTo.err}`)
    const moveEmpty = await cli(at('api', 'update', copyOutId, '--group-id', '', '--json'), { config: cfg })
    check('api update --group-id "" → 退出码 6（不再支持移出项目），hint 给出删除的替代路径',
      moveEmpty.code === 6 && errJson(moveEmpty)?.error === 'EC_SCOPE_MISMATCH' && String(errJson(moveEmpty)?.hint).includes('delete'), `${moveEmpty.code} ${moveEmpty.err.slice(0, 160)}`)
    const moveAway = await cli(at('api', 'update', copyOutId, '--group-id', gidC, '--json'), { config: cfg })
    check('api update 跨项目挪动 → 退出码 6，hint 指向 copy → delete 的替代路径',
      moveAway.code === 6 && errJson(moveAway)?.error === 'EC_SCOPE_MISMATCH' && String(errJson(moveAway)?.hint).includes('copy'), `${moveAway.code} ${moveAway.err.slice(0, 160)}`)
    const moveGhost = await cli(at('api', 'update', copyOutId, '--group-id', 'g_ghost_不存在', '--json'), { config: cfg })
    check('api update 到不存在的项目同样按「挪动」拒绝 → 退出码 6 且规则的 groupId 保持不动',
      moveGhost.code === 6 && ((await ruleById(copyOutId)) ?? {}).groupId === gid, `${moveGhost.code} ${moveGhost.err.slice(0, 140)}`)
    check('上面四次被拒的 update 一次都没改到规则（读回还是原值）',
      ((await ruleById(copyOutId)) ?? {}).enabled === true, JSON.stringify(await ruleById(copyOutId)))

    // ── 悬空归属在 C14 写不进去了（翻转：不再是「按未分组照常命中」）──
    const dangBase = await ruleById(rid)
    const dput = await rawCall('PUT', `/__ec/api/rules/${encodeURIComponent(rid)}`, sessionA, { rule: { ...(dangBase as Record<string, unknown>), groupId: 'g_gone' } })
    check('把规则的归属改成别的项目 → 400 EC_SCOPE_MISMATCH（挪动 = 服务端也拒）',
      dput.status === 400 && (dput.json as Record<string, unknown>)?.error === 'EC_SCOPE_MISMATCH', JSON.stringify(dput.json)?.slice(0, 140))
    check('被拒绝的 PUT 没有动到规则（groupId 原样）', ((await ruleById(rid)) ?? {}).groupId === gid, JSON.stringify((await ruleById(rid))?.groupId))
    const dPost = await rawCall('POST', '/__ec/api/rules', sessionA, {
      rule: { enabled: true, match: { path: '/api/grp/orphan' }, action: { type: 'mock', response: { status: 200, body: '{}' } } },
    })
    check('POST 不带 groupId → 400（服务端不再收无归属规则）',
      dPost.status === 400 && (dPost.json as Record<string, unknown>)?.error === 'EC_SCOPE_MISMATCH', JSON.stringify(dPost.json)?.slice(0, 140))
    check('被拒的 POST 也没写下去（零写入）', (await grpRules()).length === cntBeforeCopy + 2, `${cntBeforeCopy + 2} → ${(await grpRules()).length}`)

    const gCopyGhost = await cli(at('api', 'copy', rid, '--group-id', 'g_ghost_不存在', '--json'), { config: cfg })
    check('copy 到不存在的项目 → 退出码 4 且一条副本都没写',
      gCopyGhost.code === 4 && (await grpRules()).length === cntBeforeCopy + 2, `${gCopyGhost.code} 现有 ${(await grpRules()).length} / 期望 ${cntBeforeCopy + 2}`)

    // ── 删项目：组内规则**一起删掉**（C14 级联，取代 C13 的「脱组」）──
    const gDelNoYes = await cli(at('group', 'delete', gid, '--json'), { config: cfg, timeoutMs: 6000 })
    check('group delete 缺 --yes → 退出码 2 且**不挂起**（非交互 stdin 已关闭）',
      gDelNoYes.code === 2 && !gDelNoYes.timedOut && String(errJson(gDelNoYes)?.hint).includes('--yes'), `code=${gDelNoYes.code} timedOut=${gDelNoYes.timedOut}`)
    check('删除确认里把后果说清楚：组内规则会一起删掉（级联）', gDelNoYes.err.includes('会一起删掉'), gDelNoYes.err.slice(0, 240))
    check('被拒绝的删除没有真的删掉项目', (await cli(at('group', 'get', gid, '--json'), { config: cfg })).code === 0, String(gDelNoYes.code))
    const inGidBeforeDelete = (await grpRules()).filter((r) => r.groupId === gid).length
    const totalBeforeDelete = (await grpRules()).length
    const gDel = await cli(at('group', 'delete', gid, '--yes', '--json'), { config: cfg })
    const gDelJson = okJson(gDel)
    check('group delete --yes 成功并回传 removedRules 级联计数',
      gDel.code === 0 && gDelJson?.removed === true && Number(gDelJson?.removedRules) === inGidBeforeDelete && inGidBeforeDelete > 0, `${gDel.code} ${JSON.stringify(gDelJson)?.slice(0, 180)}`)
    check('rulesStillReferencing 核对为 0（项目没了、也没有规则继续引用它）', Number(gDelJson?.rulesStillReferencing) === 0, JSON.stringify(gDelJson?.rulesStillReferencing))
    check('删项目后项目表读不回来（不是只改了 enabled）', (await cli(at('group', 'get', gid, '--json'), { config: cfg })).code === 4, String(gid))
    const afterDelete = await grpRules()
    check('删项目**连规则一起删**：条数恰好少 inGidBeforeDelete 条，且没有规则继续挂着它',
      afterDelete.length === totalBeforeDelete - inGidBeforeDelete && afterDelete.filter((r) => r.groupId === gid).length === 0, `${totalBeforeDelete} → ${afterDelete.length}`)
    const hitAfterDel = await dataGet(grpPath('/api/grp/login'), 'grp-dev')
    check('级联删除后不再命中（无归属 = 永不命中的另一面：规则根本不存在了）', hitAfterDel.status !== 201, String(hitAfterDel.status))
    const gDelGhost = await cli(at('group', 'delete', 'g_ghost_不存在', '--yes', '--json'), { config: cfg })
    check('group delete 查无此项目 → 退出码 4', gDelGhost.code === 4 && errJson(gDelGhost)?.error === 'EC_NOT_FOUND', String(gDelGhost.code))

    // ── 读路径容错：连不上 ≠ 没有项目端点 ──
    const tolerate = await probeGroupRead('EC_NOT_FOUND', { tolerateMissing: true }, (c, o) => readGroups(c, o))
    check('服务端太旧（没有项目端点）时降级为空表并带上原因',
      tolerate.err === '' && (tolerate.view as { views: unknown[] }).views.length === 0 && String((tolerate.view as { error: string | null }).error).includes('项目端点'), JSON.stringify(tolerate))
    const strictRead = await probeGroupRead('EC_NOT_FOUND', {}, (c, o) => readGroups(c, o))
    check('不带 tolerateMissing 时原样抛（api list 默认要知道分组状态读不到）', strictRead.err === 'EC_NOT_FOUND', JSON.stringify(strictRead))
    const deadRead = await probeGroupRead('EC_UNREACHABLE', { tolerateMissing: true }, (c, o) => readGroups(c, o))
    check('连不上时**绝不**吞错：否则 api list 会在服务挂着的时候装作「没有分组」', deadRead.err === 'EC_UNREACHABLE', JSON.stringify(deadRead))
    const authRead = await probeGroupRead('EC_UNAUTHORIZED', { tolerateMissing: true }, (c, o) => readGroups(c, o))
    check('未登录也不吞错（退出码语义不能被降级成「空列表」）', authRead.err === 'EC_UNAUTHORIZED', JSON.stringify(authRead))
    const oldServerTable = await probeGroupRead('EC_NOT_FOUND', { tolerateMissing: true }, (c) => readGroupTable(c, '设置默认分组'))
    check('在太旧的服务端上用 --group-id 明确报 64，而不是把悬空 id 存下去', oldServerTable.err === 'EC_NOT_IMPLEMENTED', JSON.stringify(oldServerTable))
    const pickMissing = (() => {
      try {
        pickGroup({ views: [], dropped: 0, error: null }, 'g_no', '按分组筛选')
        return ''
      } catch (e) {
        return e instanceof CliError ? e.code : 'x'
      }
    })()
    check('pickGroup 查无此组 → EC_NOT_FOUND', pickMissing === 'EC_NOT_FOUND', pickMissing)

    const deadCfg = join(work, 'grp-dead.json')
    const grpDead = await cli(['group', 'list', '--base-url', 'http://127.0.0.1:1', '--config', deadCfg, '--json'], { config: deadCfg })
    check('group list 连不上服务 → 退出码 5（不是「没有分组」）', grpDead.code === 5 && errJson(grpDead)?.error === 'EC_UNREACHABLE', `${grpDead.code} ${grpDead.err.slice(0, 120)}`)

    // ── 默认分组指向已被删掉的组：本地值不做级联清理，但也不能因此把命令弄崩 ──
    const staleDefault = ConfigStore.load(cfg)
    check('删掉「本地默认分组」指向的组后，本地默认值仍在（它是本地值，服务端删组不该反向改写本地配置）',
      staleDefault.data.defaults.group === gid, String(staleDefault.data.defaults.group))
    const staleList = await cli(at('group', 'list', '--json'), { config: cfg })
    check('陈旧的本地默认分组不会让 group list 出错', staleList.code === 0 && okJson(staleList)?.defaultGroup === gid, `${staleList.code} ${staleList.err}`)

    // ── 清理：本段的规则与分组全部删掉，别把脏现场留给后面的用例 ──
    for (const r of await grpRules()) {
      await cli(at('api', 'delete', String(r.id), '--yes', '--json'), { config: cfg })
    }
    const leftGroups = ((okJson(await cli(at('group', 'list', '--json'), { config: cfg }))?.groups ?? []) as Record<string, unknown>[])
    for (const g of leftGroups) {
      await cli(at('group', 'delete', String(g.id), '--yes', '--json'), { config: cfg })
    }
    const afterCleanGroups = okJson(await cli(at('group', 'list', '--json'), { config: cfg }))
    check('清理本段的 /api/grp/ 规则与全部分组（不留残留现场）',
      (await grpRules()).length === 0 && ((afterCleanGroups?.groups as Record<string, unknown>[] | undefined) ?? []).length === 0,
      `规则 ${(await grpRules()).length} 条 / 分组 ${JSON.stringify((afterCleanGroups?.groups as Record<string, unknown>[] | undefined)?.map((g) => g.id))}`)
    const resetCfg = ConfigStore.load(cfg)
    resetCfg.setDefaultGroup(null)
    resetCfg.save()

    // ────────────────────────────────────────────────
    section('[C-13] C14 专项：私有/共享两档、copy → share → rollback、幂等与冲突（ADR-033）')

    // 起点：C-12 清理后本空间没有项目也没有规则（读回核实，不靠「应该是」）
    const startRules = (await rawCall('GET', '/__ec/api/rules', sessionA)).json
    const startGroups = okJson(await cli(at('group', 'list', '--json'), { config: cfg }))
    check('C-13 起点：我的私有规则 0 条、项目表 0 个（上段清理干净了）',
      Array.isArray(startRules) && (startRules as unknown[]).length === 0 && Number(startGroups?.total) === 0,
      `${JSON.stringify(startRules)?.slice(0, 80)} / ${JSON.stringify(startGroups?.total)}`)

    // ── 缺省归属的推断（defaultWritableProject：唯一答案才动笔）──
    const noProject = await cli(at('api', 'create', '--path', '/api/c14/first', '--json-list', '{}', '--json'), { config: cfg })
    check('0 个私有项目时 api create 不带 --group-id → 退出码 6，hint 给出「先建一个」的路',
      noProject.code === 6 && errJson(noProject)?.error === 'EC_SCOPE_MISMATCH' && String(errJson(noProject)?.hint).includes('group create'), `${noProject.code} ${noProject.err.slice(0, 160)}`)
    const uA = await cli(at('group', 'create', '--name', '唯一项目', '--json'), { config: cfg })
    const gidU = String(okJson(uA)?.id ?? '')
    const auto1 = await cli(at('api', 'create', '--path', '/api/c14/auto', '--json-list', '{"auto":1}', '--json'), { config: cfg })
    check('恰好一个私有项目时缺省归属推唯一的那个（升级后最常见的形态）',
      auto1.code === 0 && okJson(auto1)?.groupId === gidU && okJson(auto1)?.scope === 'private', `${auto1.code} ${auto1.err}`)
    const uB = await cli(at('group', 'create', '--name', '第二项目', '--json'), { config: cfg })
    const gidU2 = String(okJson(uB)?.id ?? '')
    const auto2 = await cli(at('api', 'create', '--path', '/api/c14/amb', '--json-list', '{}', '--json'), { config: cfg })
    check('两个私有项目且没给 --group-id → 退出码 2，绝不猜（报错说清有几个候选）',
      auto2.code === 2 && String(errJson(auto2)?.message).includes('2 个私有项目'), `${auto2.code} ${auto2.err.slice(0, 160)}`)
    const setDef = await cli(at('set', 'group', gidU, '--json'), { config: cfg })
    check('现场：把本地默认项目设为 gidU', setDef.code === 0 && okJson(setDef)?.verified === true, `${setDef.code} ${setDef.err}`)
    const auto3 = await cli(at('api', 'create', '--path', '/api/c14/pinned', '--json-list', '{}', '--json'), { config: cfg })
    check('多个候选时本地默认项目锁定归属（set group 的缺省语义）', auto3.code === 0 && okJson(auto3)?.groupId === gidU, `${auto3.code} ${auto3.err}`)

    // ── 首次发布：private → shared ──
    const sh1 = await cli(at('group', 'share', gidU, '--yes', '--json'), { config: cfg })
    const sh1j = okJson(sh1)
    const sharedId = String(sh1j?.sharedProjectId ?? '')
    const v1 = String(sh1j?.versionId ?? '')
    check('group share 首次发布 → 服务端生成的共享项目 id + 版本 id', sh1.code === 0 && /^g_/.test(sharedId) && v1 !== '' && sh1j?.firstPublish === true, `${sh1.code} ${JSON.stringify(sh1j)?.slice(0, 160)}`)
    check('share 回执带操作人与服务端时间（actor 是脱敏后的操作人，协议 §4.7）',
      typeof sh1j?.createdAt === 'number' && sh1j?.actor === `${PHONE.slice(0, 3)}****${PHONE.slice(7)}`, JSON.stringify([sh1j?.actor, sh1j?.createdAt]))
    const privAfterShareRun = await cli(at('group', 'get', gidU, '--json'), { config: cfg })
    const privAfterShare = okJson(privAfterShareRun)
    check('分享后私有原件还在，且 originSharedProjectId 指回共享项目',
      privAfterShare !== null && (privAfterShare?.group as Record<string, unknown> | undefined)?.originSharedProjectId === sharedId,
      `code=${privAfterShareRun.code} err=${privAfterShareRun.err.slice(0, 120)} json=${JSON.stringify(privAfterShare)?.slice(0, 160)}`)

    // ── 再分享：整项目覆盖 + 乐观锁 ──
    const sh2 = await cli(at('group', 'share', gidU, '--yes', '--json'), { config: cfg })
    const v2 = String(okJson(sh2)?.versionId ?? '')
    check('第二次 share = 整项目覆盖，追加新版本而不是新建共享项目',
      sh2.code === 0 && okJson(sh2)?.firstPublish === false && okJson(sh2)?.sharedProjectId === sharedId && v2 !== v1, `${sh2.code} ${JSON.stringify(okJson(sh2))?.slice(0, 140)}`)
    const hist2 = await cli(at('group', 'history', sharedId, '--json'), { config: cfg })
    check('历史追加到 2 条，旧版本一条不删', hist2.code === 0 && Number(okJson(hist2)?.count) === 2, JSON.stringify(okJson(hist2)?.count))
    const staleShare = await cli(at('group', 'share', gidU, '--yes', '--expected-version', v1, '--json'), { config: cfg })
    check('--expected-version 给旧版本 → 退出码 7 EC_CONFLICT（乐观锁，绝不静默覆盖）',
      staleShare.code === 7 && errJson(staleShare)?.error === 'EC_CONFLICT', `${staleShare.code} ${staleShare.err.slice(0, 140)}`)
    check('被拒的 share 没有追加版本（还是 2 条历史）', Number(okJson(await cli(at('group', 'history', sharedId, '--json'), { config: cfg }))?.count) === 2, '')
    const goodShare = await cli(at('group', 'share', gidU, '--yes', '--expected-version', v2, '--json'), { config: cfg })
    check('--expected-version 对上当前版本 → 放行并生成版本 3',
      goodShare.code === 0 && String(okJson(goodShare)?.versionId ?? '') !== v2, `${goodShare.code} ${goodShare.err.slice(0, 140)}`)

    // ── 共享只读：switch / update / archive / rollback 全被挡在 6 ──
    const swShared = await cli(at('group', 'switch', sharedId, '--off', '--json'), { config: cfg })
    check('共享项目没有开关可切 → 退出码 6（它不参与命中，开关就是死字段）',
      swShared.code === 6 && errJson(swShared)?.error === 'EC_PROJECT_READONLY', `${swShared.code} ${swShared.err.slice(0, 140)}`)
    const updShared = await cli(at('group', 'update', sharedId, '--name', '越权改名', '--json'), { config: cfg })
    check('共享项目不能改名 → 退出码 6，hint 指向 copy → 改 → share', updShared.code === 6 && String(errJson(updShared)?.hint).includes('copy'), `${updShared.code} ${updShared.err.slice(0, 140)}`)
    const rbPriv = await cli(at('group', 'rollback', gidU, '--version', v1, '--yes', '--json'), { config: cfg })
    check('私有项目没有共享历史可回退 → 退出码 6', rbPriv.code === 6, `${rbPriv.code} ${rbPriv.err.slice(0, 140)}`)
    const archPriv = await cli(at('group', 'archive', gidU, '--json'), { config: cfg })
    check('私有项目没有归档语义 → 退出码 6（提示走删除）', archPriv.code === 6, `${archPriv.code} ${archPriv.err.slice(0, 140)}`)

    // ── 共享内容的读与命中 ──
    const shRules = await cli(at('group', 'rules', sharedId, '--json'), { config: cfg })
    const sharedRuleIds = new Set((((okJson(shRules)?.rules ?? []) as Record<string, unknown>[]).map((r) => String(r.id))))
    check('group rules 读共享模板：规则清单可见、hits=false（永不直接命中）',
      shRules.code === 0 && okJson(shRules)?.scope === 'shared' && okJson(shRules)?.hits === false && sharedRuleIds.size >= 1, `${shRules.code} ${shRules.err}`)
    const shRulesHuman = await cli(at('group', 'rules', sharedId), { config: cfg })
    check('人类模式点名「共享模板不命中，要用先 copy」', shRulesHuman.err.includes('copy'), shRulesHuman.err.slice(0, 200))
    const apiListNow = await cli(at('api', 'list', '--json'), { config: cfg })
    check('共享模板里的规则不混进 api list（那里只列我私有项目里的命中集）',
      apiListNow.code === 0 && Number(okJson(apiListNow)?.count) === 2, `${apiListNow.code} count=${JSON.stringify(okJson(apiListNow)?.count)}`)

    // ── copy：shared → 我的私有 ──
    const cp = await cli(at('group', 'copy', sharedId, '--yes', '--json'), { config: cfg })
    const cpj = okJson(cp)
    const copyProjId = String(cpj?.id ?? '')
    const cpRules = (cpj?.rules ?? []) as Record<string, unknown>[]
    check('group copy → 新私有项目（名字带(副本)、scope=private）',
      cp.code === 0 && /^g_/.test(copyProjId) && copyProjId !== gidU && String(cpj?.name).endsWith('(副本)'), `${cp.code} ${JSON.stringify(cpj)?.slice(0, 160)}`)
    check('副本记录 copiedFromVersionId 与 originSharedProjectId（知道自己是哪一版的拷贝）',
      cpj?.copiedFromVersionId !== null && cpj?.copiedFromVersionId !== undefined && (cpj?.project as Record<string, unknown> | undefined)?.originSharedProjectId === sharedId, JSON.stringify(cpj?.copiedFromVersionId))
    check('副本规则齐了且换了本地 id（与共享源不撞号，否则 share 会把两条规则映射到同一 id）',
      cpRules.length === sharedRuleIds.size && cpRules.every((r) => !sharedRuleIds.has(String(r.id))), JSON.stringify(cpRules.map((r) => r.id)))
    const cpPriv = await cli(at('group', 'copy', gidU, '--yes', '--json'), { config: cfg })
    check('copy 只接受共享项目：私有项目 → 退出码 6', cpPriv.code === 6 && errJson(cpPriv)?.error === 'EC_SCOPE_MISMATCH', `${cpPriv.code} ${cpPriv.err.slice(0, 140)}`)
    const cpGhost = await cli(at('group', 'copy', 'g_ghost_不存在', '--yes', '--json'), { config: cfg })
    check('copy 查无此项目 → 退出码 4', cpGhost.code === 4, String(cpGhost.code))

    // 副本是**独立的私有项目**：关掉原件项目，副本照样命中
    const offU = await cli(at('group', 'switch', gidU, '--off', '--json'), { config: cfg })
    const hitCopy = await dataGet('http://api.example.com/api/c14/auto', 'grp-dev')
    check('关掉原件所在项目后，副本照样命中（copy ≠ 引用）',
      offU.code === 0 && hitCopy.status === 200 && hitCopy.body.includes('auto'), `${offU.code} ${hitCopy.status} ${hitCopy.body.slice(0, 40)}`)
    const backU = await cli(at('group', 'switch', gidU, '--on', '--json'), { config: cfg })
    check('恢复原件项目（后续用例从项目开着出发）', backU.code === 0, String(backU.code))

    // ── 归档：只对 shared，归档 ≠ 删除 ──
    const archShared = await cli(at('group', 'archive', sharedId, '--json'), { config: cfg })
    check('group archive 归档共享项目并读回 archived:true', archShared.code === 0 && (okJson(archShared)?.group as Record<string, unknown> | undefined)?.archived === true, `${archShared.code} ${archShared.err}`)
    const archBack = await cli(at('group', 'archive', sharedId, '--off', '--json'), { config: cfg })
    check('--off 取消归档（快照与历史一条没动）',
      archBack.code === 0 && (okJson(archBack)?.group as Record<string, unknown> | undefined)?.archived === false, `${archBack.code} ${archBack.err}`)

    // ── rollback：追加版本，不删历史 ──
    const histBeforeRb = Number(okJson(await cli(at('group', 'history', sharedId, '--json'), { config: cfg }))?.count)
    const vList = ((okJson(await cli(at('group', 'history', sharedId, '--json'), { config: cfg }))?.versions ?? []) as Record<string, unknown>[])
    const earliest = String(vList[0]?.id ?? '')
    const rb = await cli(at('group', 'rollback', sharedId, '--version', earliest, '--yes', '--json'), { config: cfg })
    const rbj = okJson(rb)
    check('rollback 回执指向所选版本并生成新版本 id（回执不携带完整 version 快照）',
      rb.code === 0 && rbj?.rollbackTo === earliest && String(rbj?.versionId ?? '') !== earliest, `${rb.code} ${JSON.stringify(rbj)?.slice(0, 160)}`)
    const histAfterRb = ((okJson(await cli(at('group', 'history', sharedId, '--json'), { config: cfg }))?.versions ?? []) as Record<string, unknown>[])
    const appended = histAfterRb.find((v) => v.id === rbj?.versionId)
    check('回退后当前指针指向新版本，历史共 +1 条，追加版本的 rollbackOf 指回所选版本',
      histAfterRb.length === histBeforeRb + 1 && appended?.operation === 'rollback' && appended?.rollbackOf === earliest &&
        ((okJson(await cli(at('group', 'get', sharedId, '--json'), { config: cfg }))?.group as Record<string, unknown> | undefined)?.currentVersionId === rbj?.versionId),
      JSON.stringify(appended))
    const rbGhost = await cli(at('group', 'rollback', sharedId, '--version', 'v_不存在', '--yes', '--json'), { config: cfg })
    check('rollback 到不存在的版本 → 退出码 4', rbGhost.code === 4, `${rbGhost.code} ${rbGhost.err.slice(0, 120)}`)
    const rbNoVer = await cli(at('group', 'rollback', sharedId, '--yes', '--json'), { config: cfg })
    check('rollback 缺 --version → 退出码 2', rbNoVer.code === 2, String(rbNoVer.code))

    // ── 私有项目的历史端点如实回空（历史只属于共享库）──
    const histPriv = await cli(at('group', 'history', gidU2, '--json'), { config: cfg })
    check('私有项目的历史 → 200 且 0 条，note 说明为什么',
      histPriv.code === 0 && Number(okJson(histPriv)?.count) === 0 && okJson(histPriv)?.note !== null, `${histPriv.code} ${JSON.stringify(okJson(histPriv)?.note)}`)

    // ── 幂等（协议 §4.7「幂等是硬要求」）：同一笔 operation-id 重发不产生第二份副作用 ──
    const opEmpty = await cli(at('group', 'copy', sharedId, '--yes', '--operation-id', '   ', '--json'), { config: cfg })
    check('--operation-id 空白 → 退出码 2（幂等键不能是空）', opEmpty.code === 2, String(opEmpty.code))
    const projCountBefore = Number(okJson(await cli(at('group', 'list', '--json'), { config: cfg }))?.total)
    const opCopy = 'cli_copy_selftest_001'
    const cp2 = await cli(at('group', 'copy', sharedId, '--yes', '--operation-id', opCopy, '--json'), { config: cfg })
    const cp2Id = String(okJson(cp2)?.id ?? '')
    check('带 --operation-id 的 copy 正常执行', cp2.code === 0 && cp2Id !== copyProjId, `${cp2.code} ${cp2.err}`)
    const cp2Replay = await cli(at('group', 'copy', sharedId, '--yes', '--operation-id', opCopy, '--json'), { config: cfg })
    check('同一笔 operation-id 重发 copy → replayed:true 且回的是首次那笔，没有第三份',
      cp2Replay.code === 0 && okJson(cp2Replay)?.replayed === true && okJson(cp2Replay)?.id === cp2Id, `${cp2Replay.code} ${JSON.stringify(okJson(cp2Replay))?.slice(0, 140)}`)
    check('重发没有多建项目', Number(okJson(await cli(at('group', 'list', '--json'), { config: cfg }))?.total) === projCountBefore + 1, '')
    const histBeforeOp = Number(okJson(await cli(at('group', 'history', sharedId, '--json'), { config: cfg }))?.count)
    const opShare = 'cli_share_selftest_001'
    const shOp = await cli(at('group', 'share', gidU, '--yes', '--operation-id', opShare, '--json'), { config: cfg })
    const shOpV = String(okJson(shOp)?.versionId ?? '')
    const shOpReplay = await cli(at('group', 'share', gidU, '--yes', '--operation-id', opShare, '--json'), { config: cfg })
    check('同一笔 operation-id 重发 share → replayed:true 且回首次版本、不追加第二条',
      shOpReplay.code === 0 && okJson(shOpReplay)?.replayed === true && okJson(shOpReplay)?.versionId === shOpV, `${shOpReplay.code} ${JSON.stringify(okJson(shOpReplay))?.slice(0, 140)}`)
    check('重发 share 没有多生成版本', Number(okJson(await cli(at('group', 'history', sharedId, '--json'), { config: cfg }))?.count) === histBeforeOp + 1, '')
    const opRb = 'cli_rollback_selftest_001'
    const rb2 = await cli(at('group', 'rollback', sharedId, '--version', earliest, '--yes', '--operation-id', opRb, '--json'), { config: cfg })
    const rb2Replay = await cli(at('group', 'rollback', sharedId, '--version', earliest, '--yes', '--operation-id', opRb, '--json'), { config: cfg })
    check('rollback 同样幂等：重发回首次那笔，历史不再 +1',
      rb2Replay.code === 0 && okJson(rb2Replay)?.replayed === true && okJson(rb2Replay)?.versionId === okJson(rb2)?.versionId, `${rb2Replay.code} ${JSON.stringify(okJson(rb2Replay))?.slice(0, 140)}`)

    // 共享项目的删除改成了软删除（ADR-037），断言挪到下面「400 一条都没写下去」之后再跑，
    // 因为它会改项目状态，跑在前面会让后面那批 400 断言的基线失真。

    // ── AGENTS.md §4：新写入口的非法输入（服务端侧）──
    const badGroup1 = await rawCall('POST', '/__ec/api/groups', sessionA, { group: { name: '   ', enabled: true } })
    check('POST /groups 纯空白 name → 400（不建出空名项目）', badGroup1.status === 400, JSON.stringify(badGroup1.json)?.slice(0, 120))
    const badGroup2 = await rawCall('POST', '/__ec/api/groups', sessionA, { group: { name: '缺开关' } })
    check('POST /groups 缺 enabled → 400（布尔必须显式，没有隐式默认）', badGroup2.status === 400, JSON.stringify(badGroup2.json)?.slice(0, 120))
    const badGroup3 = await rawCall('POST', '/__ec/api/groups', sessionA, { group: { name: '越权', enabled: true, ownerPhone: PHONE_B } })
    check('POST /groups 带 ownerPhone → 400 EC_SCOPE_MISMATCH（归属字段只由服务端写）',
      badGroup3.status === 400 && (badGroup3.json as Record<string, unknown>)?.error === 'EC_SCOPE_MISMATCH', JSON.stringify(badGroup3.json)?.slice(0, 140))
    const badRb = await rawCall('POST', `/__ec/api/groups/${encodeURIComponent(sharedId)}/rollback`, sessionA, {})
    check('rollback 缺 body.versionId → 400', badRb.status === 400, JSON.stringify(badRb.json)?.slice(0, 120))
    check('上面的 400 一条都没写下去（项目数不变）', Number(okJson(await cli(at('group', 'list', '--json'), { config: cfg }))?.total) === projCountBefore + 1, '')

    // ── 共享项目删除 = 软删除（ADR-037）：先挂 7 天，期间可恢复，到期才真删 ──
    const histAtDel = Number(okJson(await cli(at('group', 'history', sharedId, '--json'), { config: cfg }))?.count)
    const rulesAtDel = Number(okJson(await cli(at('group', 'get', sharedId, '--json'), { config: cfg }))?.group?.ruleCount)
    const delShared = await cli(at('group', 'delete', sharedId, '--yes', '--json'), { config: cfg })
    const delJ = okJson(delShared)
    check('共享项目带历史版本时删除 → 退出码 0（软删除；不再是 EC_PROJECT_READONLY）',
      delShared.code === 0, `${delShared.code} ${delShared.err.slice(0, 140)}`)
    check('软删除回 pendingDelete:true、removed:false，并给出 purgeAt 与剩余 7 天',
      delJ?.pendingDelete === true && delJ?.removed === false && typeof delJ?.purgeAt === 'number' &&
        Number(delJ?.daysLeft) >= 6 && Number(delJ?.daysLeft) <= 7,
      JSON.stringify(delJ)?.slice(0, 200))
    const getAfterDel = okJson(await cli(at('group', 'get', sharedId, '--json'), { config: cfg }))
    check('软删除没有物理删项目：仍可读、purgeAt 已落盘、规则与历史一条没少',
      getAfterDel?.group?.purgeAt === delJ?.purgeAt &&
        Number(getAfterDel?.group?.ruleCount) === rulesAtDel &&
        Number(okJson(await cli(at('group', 'history', sharedId, '--json'), { config: cfg }))?.count) === histAtDel,
      JSON.stringify(getAfterDel?.group)?.slice(0, 200))
    const delAgain = await cli(at('group', 'delete', sharedId, '--yes', '--json'), { config: cfg })
    check('重复软删除幂等：purgeAt 不变（不会把 7 天重新续上）',
      delAgain.code === 0 && okJson(delAgain)?.purgeAt === delJ?.purgeAt,
      `${delAgain.code} ${JSON.stringify(okJson(delAgain))?.slice(0, 160)}`)
    const rbPending = await cli(at('group', 'rollback', sharedId, '--version', earliest, '--yes', '--json'), { config: cfg })
    check('待删除期间写操作被挡：rollback → 退出码 6 EC_PROJECT_READONLY',
      rbPending.code === 6 && errJson(rbPending)?.error === 'EC_PROJECT_READONLY', `${rbPending.code} ${rbPending.err.slice(0, 140)}`)
    const restoreShared = await cli(at('group', 'restore', sharedId, '--json'), { config: cfg })
    check('group restore 撤销软删除：restored:true、purgeAt 回 null',
      restoreShared.code === 0 && okJson(restoreShared)?.restored === true && okJson(restoreShared)?.group?.purgeAt === null,
      `${restoreShared.code} ${JSON.stringify(okJson(restoreShared))?.slice(0, 200)}`)
    const restoreAgain = await cli(at('group', 'restore', sharedId, '--json'), { config: cfg })
    check('对不在待删除的项目 restore → 退出码 0、restored:false、alreadyActive:true（幂等，不当成错误）',
      restoreAgain.code === 0 && okJson(restoreAgain)?.restored === false && okJson(restoreAgain)?.alreadyActive === true,
      `${restoreAgain.code} ${JSON.stringify(okJson(restoreAgain))?.slice(0, 160)}`)
    check('恢复后规则与历史原样还在（恢复不是回滚版本）',
      Number(okJson(await cli(at('group', 'get', sharedId, '--json'), { config: cfg }))?.group?.ruleCount) === rulesAtDel &&
        Number(okJson(await cli(at('group', 'history', sharedId, '--json'), { config: cfg }))?.count) === histAtDel,
      '')
    const restorePriv = await cli(at('group', 'restore', gidU2, '--json'), { config: cfg })
    check('对私有项目 restore → 退出码 6（私有没有回收站，删了只能重建）',
      restorePriv.code === 6 && errJson(restorePriv)?.error === 'EC_PROJECT_READONLY', `${restorePriv.code} ${restorePriv.err.slice(0, 140)}`)
    const restoreGhost = await cli(at('group', 'restore', 'g_没有这个项目', '--json'), { config: cfg })
    check('restore 不存在的项目 → 退出码 4', restoreGhost.code === 4, String(restoreGhost.code))

    // ── 清理：私有项目级联删规则；共享项目已在上面 restore 回来，留在归档侧（ADR-037）──
    for (const pid of [gidU, gidU2, copyProjId, cp2Id]) {
      const d = await cli(at('group', 'delete', pid, '--yes', '--json'), { config: cfg })
      check(`清理：私有项目 ${pid} 删除成功（规则级联）`, d.code === 0, `${d.code} ${d.err.slice(0, 100)}`)
    }
    const leftMine = (await rawCall('GET', '/__ec/api/rules', sessionA)).json
    check('C-13 清理后我的私有规则回到 0 条', Array.isArray(leftMine) && (leftMine as unknown[]).length === 0, JSON.stringify(leftMine)?.slice(0, 100))
    const resetCfg13 = ConfigStore.load(cfg)
    resetCfg13.setDefaultGroup(null)
    resetCfg13.save()
    // ────────────────────────────────────────────────
    section('[C-07] login --browser：会话从浏览器经本机回环交回，CLI 全程不经手口令（ADR-029）')
    const rcfg = join(work, 'relay.json')
    const relaySession = await rawLogin(PHONE)
    // 会话形状是 CLI 白名单的依据，先钉住服务端真实发出来的样子
    check('服务端发出的会话是 32 位 hex（CLI 的 session 形状白名单按这个判）', /^[0-9a-f]{32}$/.test(relaySession), `len=${relaySession.length}`)
    const goodBody = (state: string) => JSON.stringify({ state, session: relaySession, phone: PHONE, role: 'user' })

    const ok = await cliRelay(at('login', '--browser', '--no-open', '--json'), {
      config: rcfg,
      play: async ({ post, state }) => {
        await post(goodBody(state))
      },
    })
    const okj = okJson(ok)
    check('接力成功：退出码 0，payload 标着 via=browser',
      ok.code === 0 && okj?.via === 'browser' && okj?.phone === PHONE && okj?.ok === true,
      `${ok.code} ${ok.out.slice(0, 160)}`)
    check('relay 地址打进了 stderr（--no-open 时这是唯一入口），且走 #hash 不进服务端',
      ok.err.includes('#cli-login?port=') && ok.err.includes(`state=${ok.state}`) && ok.port > 1023 && ok.port !== PORT,
      ok.err.slice(0, 200))
    check('nonce 是 48 位 hex（一次一换，不固定）', /^[0-9a-f]{48}$/.test(ok.state), String(ok.state.length))
    check('页面那一次投递被接受（HTTP 200）', ok.codes.join(',') === '200', ok.codes.join(','))
    check('--json 的 stdout 里不回显会话 token', !ok.out.includes(relaySession), ok.out.slice(0, 120))

    const whoAfter = await cli(at('whoami', '--json'), { config: rcfg })
    const whoj = okJson(whoAfter)
    check('接力拿到的会话真的能用：whoami 从服务端读到手机号与角色',
      whoAfter.code === 0 && (whoj?.phone as string) === PHONE && typeof whoj?.role === 'string',
      `${whoAfter.code} ${whoAfter.out.slice(0, 160)}`)
    const relayCfgText = readFileSync(rcfg, 'utf8')
    check('落盘的只有会话，配置文件里没有口令（D3：口令不落盘）',
      relayCfgText.includes(relaySession) && !relayCfgText.includes(PASSWORD),
      relayCfgText.slice(0, 80))
    check('配置文件权限 0600（里面是等价登录态的 token）',
      (statSync(rcfg).mode & 0o777) === 0o600, (statSync(rcfg).mode & 0o777).toString(8))

    const secondPost = await cliRelay(at('login', '--browser', '--no-open', '--json'), {
      config: join(work, 'relay2.json'),
      play: async ({ post, state }) => {
        await post(goodBody(state))
        // 成功之后监听已经关掉：再来一条不该被接受（会话不是「一次登录、长期可取」）
        await post(goodBody(state))
      },
    })
    check('一次性：成功之后同一个端口不再接受第二份会话',
      secondPost.codes.length === 2 && secondPost.codes[0] === 200 && secondPost.codes[1] !== 200,
      secondPost.codes.join(','))

    const dirtyThenGood = await cliRelay(at('login', '--browser', '--no-open', '--json'), {
      config: join(work, 'relay-dirty.json'),
      play: async ({ post, state }) => {
        // 7 条脏投递（都在 MAX_ATTEMPTS 以内，不该毁掉整轮登录）
        await post(goodBody('deadbeef'.repeat(6)))
        await post('这不是 JSON {{{')
        await post(JSON.stringify({ state, session: { nested: true } }))
        await post(JSON.stringify([state, relaySession]))
        await post('"just-a-string"')
        await post(JSON.stringify({ state, session: 'a'.repeat(15) }))
        await post('x'.repeat(9000))
        // favicon 之类的噪音走的是 404 分支：不该占用尝试次数
        await post('', { path: '/favicon.ico' })
        // 最后一条：state / session 都对，但**页面自报了一个假手机号和 admin 角色**。
        // 它放在最后，是因为 phone/role 形状再乱也不影响受理（只有 state + session 承重），
        // 这条本质上是「合法的接力」——身份最终由命令层拿服务端 /me 覆盖。
        await post(JSON.stringify({ state, session: relaySession, phone: { a: 1 }, role: ['admin'] }))
      },
    })
    check('7 条脏投递 + 1 条噪音全部被拒后，最后那条合法接力仍然成功（一次坏请求不毁掉整轮）',
      dirtyThenGood.code === 0 && dirtyThenGood.codes.slice(0, 8).every((c) => c !== 200) &&
        dirtyThenGood.codes[8] === 200 && dirtyThenGood.codes.length === 9,
      `${dirtyThenGood.code} ${dirtyThenGood.codes.join(',')}`)
    check('页面自报的手机号/角色一律不采信：结果里的身份来自服务端 /me',
      (okJson(dirtyThenGood)?.phone as string) === PHONE && (okJson(dirtyThenGood)?.role as string) !== 'admin',
      JSON.stringify(okJson(dirtyThenGood)))

    const badOrigin = await cliRelay(at('login', '--browser', '--no-open', '--json'), {
      config: join(work, 'relay-origin.json'),
      play: async ({ post, state }) => {
        await post(goodBody(state), { origin: 'http://example.com:9999' })
      },
    })
    check('浏览器用的地址与 baseUrl 不一致 → 立刻失败并说明两个地址（不静默换端口重试）',
      badOrigin.code === 3 && String(errJson(badOrigin)?.error) === 'EC_ORIGIN_MISMATCH' &&
        String(errJson(badOrigin)?.message).includes('example.com'),
      `${badOrigin.code} ${badOrigin.err.slice(0, 200)}`)
    check('地址不一致时不写会话（宁可什么都没存）',
      !readFileSync(join(work, 'relay-origin.json'), 'utf8').includes(relaySession))

    const forged = await cliRelay(at('login', '--browser', '--no-open', '--json'), {
      config: join(work, 'relay-forged.json'),
      play: async ({ post, state }) => {
        await post(JSON.stringify({ state, session: 'f'.repeat(32), phone: PHONE, role: 'admin' }))
      },
    })
    check('形状合法但服务端不认的 token → EC_VERIFY_FAILED（不是「拿到就算登录」）',
      forged.code === 4 && String(errJson(forged)?.error) === 'EC_VERIFY_FAILED',
      `${forged.code} ${forged.err.slice(0, 200)}`)
    check('伪造会话没有被落盘', !readFileSync(join(work, 'relay-forged.json'), 'utf8').includes('f'.repeat(32)))

    const timeout = await cliRelay(at('login', '--browser', '--no-open', '--timeout', '5', '--json'), {
      config: join(work, 'relay-timeout.json'),
      timeoutMs: 25_000,
    })
    check('没人点「允许」→ 5 秒后退出码 3，并给出口令通道的替代做法',
      timeout.code === 3 && String(errJson(timeout)?.error) === 'EC_LOGIN_TIMEOUT' &&
        String(errJson(timeout)?.hint).includes('--password-stdin'),
      `${timeout.code} ${timeout.err.slice(0, 200)}`)

    // 页面点「拒绝」：CLI 要**立刻**知道，而不是干等到超时
    const denied = await cliRelay(at('login', '--browser', '--no-open', '--json'), {
      config: join(work, 'relay-denied.json'),
      play: async ({ post, state }) => {
        await post(JSON.stringify({ state, denied: true }))
      },
    })
    check('页面点「拒绝」→ 立刻退出码 3 EC_LOGIN_DENIED（不是等满超时，也不是含糊的失败）',
      denied.code === 3 && String(errJson(denied)?.error) === 'EC_LOGIN_DENIED',
      `${denied.code} ${denied.codes.join(',')} ${denied.err.slice(0, 160)}`)
    check('被拒时不写会话，也不把「拒绝」当成一次成功投递',
      !readFileSync(join(work, 'relay-denied.json'), 'utf8').includes(relaySession) &&
        denied.codes[0] === 200,
      denied.codes.join(','))
    check('拒绝之后同一端口不再接受第二份会话（这一轮已经结束了）',
      (await pagePost(denied.port, goodBody(denied.state))) !== 200)

    // state 不对的「拒绝」不算你的拒绝：不能被第三方用来把别人的登录搅黄
    const fakeDeny = await cliRelay(at('login', '--browser', '--no-open', '--json'), {
      config: join(work, 'relay-fake-deny.json'),
      play: async ({ post, state }) => {
        await post(JSON.stringify({ state: '0'.repeat(48), denied: true }))
        await post(JSON.stringify({ state, denied: 'true' }))
        await post(JSON.stringify({ state, denied: 1 }))
        await post(goodBody(state))
      },
    })
    check('state 不匹配的「拒绝」被拒（第三方替不了你拒绝），denied 形状不对也不生效，合法接力照常成功',
      fakeDeny.code === 0 && fakeDeny.codes.join(',') === '400,400,400,200',
      `${fakeDeny.code} ${fakeDeny.codes.join(',')}`)

    const capped = await cliRelay(at('login', '--browser', '--no-open', '--json'), {
      config: join(work, 'relay-cap.json'),
      play: async ({ post }) => {
        for (let i = 0; i < 12; i++) await post('nope')
      },
    })
    check('垃圾投递达到上限后整轮取消（不当免检入口用）',
      capped.code === 3 && String(errJson(capped)?.error) === 'EC_CONFLICT',
      `${capped.code} ${capped.codes.join(',')} ${capped.err.slice(0, 120)}`)

    const clash = await cliRelay(at('login', '--browser', '--no-open', '--callback-port', String(PORT), '--json'), {
      config: join(work, 'relay-clash.json'),
    })
    check('回调端口被占 → 退出码 5 并教怎么去掉固定端口',
      clash.code === 5 && String(errJson(clash)?.message).includes('起不了本机回调监听') &&
        String(errJson(clash)?.hint).includes('--callback-port'),
      `${clash.code} ${clash.err.slice(0, 200)}`)

    for (const bad of [
      { args: ['login', '--browser', '--password', PASSWORD, '--json'], why: '与 --password 同时给（不静默忽略任何一个）' }, // 假口令，见文件头 PASSWORD 的注释
      { args: ['login', '--browser', '--password-stdin', '--json'], why: '与 --password-stdin 同时给' },
      { args: ['login', '--browser', '--timeout', 'abc', '--json'], why: '--timeout 不是整数' },
      { args: ['login', '--browser', '--timeout', '9999', '--json'], why: '--timeout 超出 5~900' },
      { args: ['login', '--browser', '--timeout', '0', '--json'], why: '--timeout 为 0' },
      { args: ['login', '--browser', '--callback-port', '80', '--json'], why: '--callback-port 是特权端口' },
      { args: ['login', '--browser', '--callback-port', '1e5', '--json'], why: '--callback-port 写成科学计数法' },
      { args: ['login', '--browser', '--callback-port', '', '--json'], why: '--callback-port 是空串' },
    ]) {
      const r = await cli(at(...bad.args), { config: join(work, 'relay-usage.json') })
      check(`用法守卫：${bad.why} → 退出码 2`, r.code === 2 && String(errJson(r)?.error) === 'EC_USAGE', `${r.code} ${r.err.slice(0, 140)}`)
      check(`用法守卫：${bad.why} 时不开监听、不写会话`, !r.err.includes('#cli-login'))
    }
    const envPw = await cli(at('login', '--browser', '--json'), {
      config: join(work, 'relay-envpw.json'),
      env: { EC_MOCK_PASSWORD: PASSWORD }, // 假口令，见文件头 PASSWORD 的注释
    })
    check('用法守卫：只有环境变量 EC_MOCK_PASSWORD 时也拒绝（不静默丢掉一个来源）',
      envPw.code === 2 && String(errJson(envPw)?.message).includes('EC_MOCK_PASSWORD'),
      `${envPw.code} ${envPw.err.slice(0, 160)}`)

    // 关键的安全边界：浏览器是**人**用的，agent 不能被迫开窗口；口令路径也不能被动升级成浏览器
    const noBrowserNoPw = await cli(at('login', '--phone', PHONE, '--json'), {
      config: join(work, 'relay-none.json'),
      env: { EC_MOCK_PASSWORD: '' },
    })
    check('不带 --browser 时绝不出现 relay 地址（agent 场景不会被弹窗卡住）',
      noBrowserNoPw.code === 2 && !noBrowserNoPw.err.includes('#cli-login'),
      `${noBrowserNoPw.code} ${noBrowserNoPw.err.slice(0, 160)}`)
    check('缺口令的提示里给出 --browser 这条人用的路',
      String(errJson(noBrowserNoPw)?.hint).includes('--browser'), String(errJson(noBrowserNoPw)?.hint))

    const parsed = (o: unknown): string => (parseRelayPayload(o, 'aa') ? 'ok' : 'reject')
    check('parseRelayPayload：state 不全等 / 会话形状不对 / 顶层类型混淆一律拒绝',
      parsed({ state: 'aa', session: relaySession }) === 'ok' &&
        parsed({ state: 'ab', session: relaySession }) === 'reject' &&
        parsed({ state: 42, session: relaySession }) === 'reject' &&
        parsed({ session: relaySession }) === 'reject' &&
        parsed({ state: 'aa', session: 'a'.repeat(15) }) === 'reject' &&
        parsed({ state: 'aa', session: 'g'.repeat(32) }) === 'reject' &&
        parsed({ state: 'aa', session: { s: relaySession } }) === 'reject' &&
        parsed({ state: 'aa' }) === 'reject' &&
        parsed(null) === 'reject' && parsed([]) === 'reject' && parsed('s') === 'reject')
    // 形状只是粗筛（16~128 位 hex），"看起来对但服务不认"的 token 由 /me 那一步拦下——
    // 这条刻意钉住分工，免得以后有人以为放宽/收紧 hex 长度就能挡住伪造
    check('形状检查不承担鉴权：31 位 hex 能过形状，但过不了服务端 /me',
      parsed({ state: 'aa', session: relaySession.slice(0, 31) }) === 'ok' && forged.code === 4,
      `${forged.code}`)
    check('自报的 phone/role 形状不对时丢弃（置 null）而不是让登录失败',
      parsed({ state: 'aa', session: relaySession, phone: 'x'.repeat(200) }) === 'ok' &&
        parseRelayPayload({ state: 'aa', session: relaySession, phone: 'x'.repeat(200) }, 'aa')?.phone === null &&
        parseRelayPayload({ state: 'aa', session: relaySession, phone: '138\t0000000' }, 'aa')?.phone === null &&
        parseRelayPayload({ state: 'aa', session: relaySession, role: ['admin'] }, 'aa')?.role === null)
    check('会话带空白时按形状判掉（不当作有效会话）',
      parsed({ state: 'aa', session: ` ${relaySession} ` }) === 'reject')
    // 「拒绝」这条通道只该被**本人那一次点击**触发：state 必须全等、denied 必须是布尔 true
    check('isRelayDenial 只认 state 全等 + denied===true（假 state / 字符串 / 1 / 缺字段都不算）',
      isRelayDenial({ state: 'aa', denied: true }, 'aa') === true &&
        isRelayDenial({ state: 'bb', denied: true }, 'aa') === false &&
        isRelayDenial({ state: 'aa', denied: 'true' }, 'aa') === false &&
        isRelayDenial({ state: 'aa', denied: 1 }, 'aa') === false &&
        isRelayDenial({ denied: true }, 'aa') === false &&
        isRelayDenial({ state: 'aa' }, 'aa') === false &&
        isRelayDenial(null, 'aa') === false && isRelayDenial([], 'aa') === false)
    check('拒绝载荷里没有会话，有效会话载荷也不会被误判成拒绝',
      isRelayDenial({ state: 'aa', session: relaySession, denied: false }, 'aa') === false &&
        parseRelayPayload({ state: 'aa', denied: true }, 'aa') === null)
    const relayUrl = buildRelayRequest(BASE_URL, 54321, 'ab').url
    check('buildRelayRequest 把参数放在 #hash 里（nonce 不进服务端访问记录）',
      relayUrl === `${BASE_URL}/#cli-login?port=54321&state=ab` &&
        relayUrl.split('#')[0] === `${BASE_URL}/` &&
        relayUrl.split('#')[1].includes('port=54321'),
      relayUrl)
    let relayBadBase = ''
    try {
      buildRelayRequest('ht tp://x', 1, 'a')
    } catch (e) {
      relayBadBase = e instanceof CliError ? e.code : 'other'
    }
    check('baseUrl 不合法时报 EC_USAGE 而不是崩栈', relayBadBase === 'EC_USAGE', relayBadBase)
    check('nonce 每次不同（48 位 hex）', newNonce() !== newNonce() && /^[0-9a-f]{48}$/.test(newNonce()))

    // 直接打监听器（不经 CLI）：一次性、关得掉、两出互不干扰
    const w1 = await startRelayWait({ baseUrl: BASE_URL, timeoutMs: 8000 })
    const w2 = await startRelayWait({ baseUrl: BASE_URL, timeoutMs: 8000 })
    check('两轮并发的 nonce / 端口 / 地址都不同（不复用 state）',
      w1.state !== w2.state && w1.port !== w2.port && w1.url !== w2.url)
    check('没有 Origin 头的投递被拒（不接受非浏览器来源）',
      (await pagePost(w1.port, '', { origin: null })) === 403)
    await pagePost(w1.port, JSON.stringify({ state: w1.state, session: relaySession, phone: PHONE }))
    const got1 = await w1.result
    check('监听器把回环收到的会话原样交回上层',
      got1.session.session === relaySession && got1.session.phone === PHONE && got1.observedOrigin === BASE_URL)
    check('成功之后监听立刻关闭：同一端口不再接受第二份会话',
      (await pagePost(w1.port, JSON.stringify({ state: w1.state, session: relaySession }))) === -1)
    check('非回调路径 → 404 且不烧掉尝试次数（favicon 之类的噪音不能让登录失败）',
      (await pagePost(w2.port, '', { path: '/favicon.ico' })) === 404 &&
        (await pagePost(w2.port, 'not json')) === 400 &&
        (await pagePost(w2.port, JSON.stringify({ state: w2.state, session: relaySession }))) === 200)
    const got2 = await w2.result
    check('第二会话照样有效（两出接力互不干扰）', got2.session.session === relaySession)

    // 收尾核对：relay 写的是哪条 project、写了什么
    const rc = JSON.parse(readFileSync(rcfg, 'utf8')) as { projects: Array<Record<string, unknown>> }
    check('relay 登录写的是当前 baseUrl 那条 project，并带会话时间戳',
      rc.projects.length === 1 && rc.projects[0].baseUrl === BASE_URL &&
        typeof rc.projects[0].sessionAt === 'number' && Date.now() - (rc.projects[0].sessionAt as number) < 60_000,
      JSON.stringify(rc.projects.map((p) => [p.id, p.baseUrl, p.phone])))
  } finally {
    server?.kill()
    rmSync(work, { recursive: true, force: true })
  }

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
  if (failed > 0) process.exitCode = 1
}

/** 期望客户端在发请求前/后给出的错误码 */
async function callExpectError(client: ManagementClient, value: string): Promise<string> {
  try {
    await client.call('PUT', '/__ec/api/rules', { body: { rules: value }, auth: false })
    return ''
  } catch (e) {
    return e instanceof CliError ? e.code : `not-CliError:${String(e)}`
  }
}

void main().catch((e) => {
  // 用例自身写错（而不是命令行为错）时也给出可行动的信息，而不是一坨栈
  console.error(`\n自测自身异常：${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`)
  console.error('堆栈已在上方；这属于自测代码的问题，不是 mock CLI 的结论。')
  process.exitCode = 1
})
