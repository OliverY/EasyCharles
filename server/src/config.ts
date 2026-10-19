import { resolve } from 'node:path'
import type { CompatConfig, Config, RecordMode, UserRole } from './types.ts'

function readArg(flag: string): string | null {
  const i = process.argv.indexOf(flag)
  if (i < 0) return null
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : null
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag)
}

/** 读取逗号分隔的列表参数，如 --compat-route /a,/b */
function readList(flag: string): string[] {
  const raw = readArg(flag)
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 第三方客户端兼容层：全部走参数注入，仓库内不内置任何具体客户端的协议常量（默认关闭） */
function loadCompat(): CompatConfig {
  return {
    routes: readList('--compat-route'),
    targetHeader: (readArg('--compat-target-header') ?? 'x-compat-original-url').toLowerCase(),
    deviceNameHeader: (readArg('--compat-device-header') ?? 'x-compat-device-name').toLowerCase(),
    deviceIdHeader: (readArg('--compat-device-id-header') ?? 'x-compat-device-id').toLowerCase(),
    userIdHeader: (readArg('--compat-user-id-header') ?? 'x-compat-user-id').toLowerCase(),
    userNameHeader: (readArg('--compat-user-name-header') ?? 'x-compat-user-name').toLowerCase(),
    appId: readArg('--app-id') ?? 'external-client',
  }
}

const recordModeArg = readArg('--record-mode') as RecordMode | null

/**
 * 非负整数参数解析（F-10 同款防御：脏输入回退默认值，不把 NaN 带进配置）。
 * `allowZero` 为 true 时 0 是合法值（如 `--snapshot-ttl 0` = 永不过期）。
 */
function readCount(flag: string, fallback: number, allowZero: boolean): number {
  const raw = readArg(flag)
  if (raw === null) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0)) return fallback
  return Math.floor(n)
}

/** 快照有效期：单位「小时」，默认 168（7 天），0 = 永不过期（ADR-017） */
const snapshotTtlHours = readCount('--snapshot-ttl', 168, true)

/**
 * 会话有效期：单位「小时」，默认 720（30 天），0 = 永不过期（ADR-031）。
 * 会话现在会落盘，这个值就是「服务重启后还能自动登录多久」。
 */
const sessionTtlHours = readCount('--session-ttl', 720, true)

export function loadConfig(): Config {
  const hostArg = readArg('--host')
  // F-02：--lan 必须真正监听 0.0.0.0（此前只置标志位，局域网实际连不上）；
  // 显式 --host 优先，非回环 host 一律视为 LAN 模式
  const lanMode = hasFlag('--lan') || (hostArg !== null && hostArg !== '127.0.0.1' && hostArg !== 'localhost')
  const host = hostArg ?? (lanMode ? '0.0.0.0' : '127.0.0.1')
  // 控制台登录口令：默认 123456，--password 可改
  const password = readArg('--password') ?? '123456'
  // 管理员白名单：--admin 13800138000,13900139000（不配置 = 没有管理员，ADR-018）
  const adminPhones = readList('--admin')

  return {
    port: Number(readArg('--port') ?? process.env.EC_PORT ?? 8899),
    host,
    lanMode,
    password,
    adminPhones,
    recordMode: recordModeArg ?? 'full',
    maxBufferBytes: Number(readArg('--max-buffer') ?? 512 * 1024),
    sampleBytes: Number(readArg('--sample') ?? 8 * 1024),
    heartbeatMs: 30_000,
    maxRecords: Number(readArg('--max-records') ?? 2000),
    upstreamTimeoutMs: Number(readArg('--upstream-timeout') ?? 30_000),
    snapshotTtlMs: snapshotTtlHours * 3600_000,
    snapshotMax: readCount('--snapshot-max', 200, false),
    sessionTtlMs: sessionTtlHours * 3600_000,
    dataDir: resolve(readArg('--data-dir') ?? '.data'),
    compat: loadCompat(),
    // 加解密插件（ADR-039）：默认开启，`--no-crypto` 完全停用（连 settings.json 都不读）
    cryptoEnabled: !hasFlag('--no-crypto'),
  }
}

/**
 * 角色判定（ADR-018）：**唯一真值来源是启动参数 `--admin`**，不落盘、不兜底。
 * 入参可能来自会话表 / 请求头，一律按不可信处理（AGENTS.md §4）：
 * 非字符串或空串 → `'user'`，绝不因为脏值把管理权限放出去。
 */
export function roleOf(cfg: Config, phone: unknown): UserRole {
  return typeof phone === 'string' && phone !== '' && cfg.adminPhones.includes(phone) ? 'admin' : 'user'
}

export function isAdminPhone(cfg: Config, phone: unknown): boolean {
  return roleOf(cfg, phone) === 'admin'
}

export function printBanner(cfg: Config, lanAddresses: string[]): void {
  const base = `http://${cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host}:${cfg.port}`
  console.log('')
  console.log('  EasyCharles 本地服务已启动')
  console.log('  ------------------------------------------')
  console.log(`  控制台        ${base}/`)
  console.log(`  数据面        ${base}/__ec/p/<原始 path>`)
  console.log(`  控制面        ws://.../__ec/ws`)
  console.log(`  记录模式      ${cfg.recordMode}`)
  console.log(`  快照有效期    ${cfg.snapshotTtlMs > 0 ? Math.round(cfg.snapshotTtlMs / 3600_000) + ' 小时' : '永不过期'}（--snapshot-ttl 小时，0 = 不过期）`)
  console.log(`  会话有效期    ${cfg.sessionTtlMs > 0 ? Math.round(cfg.sessionTtlMs / 3600_000) + ' 小时' : '永不过期'}（--session-ttl 小时，落盘保留，重启后仍自动登录）`)
  console.log(`  管理员        ${cfg.adminPhones.length ? cfg.adminPhones.join(', ') : '（未配置 --admin，无管理员）'}`)
  console.log(
    `  加解密        ${cfg.cryptoEnabled ? '已开启（密钥档在 .data/crypto/settings.json，不进 git / 发布包）' : '已关闭（--no-crypto）'}`,
  )
  if (cfg.compat.routes.length) {
    console.log(`  兼容路由      ${cfg.compat.routes.join(', ')}（目标头 ${cfg.compat.targetHeader}，appId ${cfg.compat.appId}）`)
    // 设备主键派生用的三个头，漏一个就会让设备行合并且展示名来回跳，打出来便于「手机连上了但只看得到一台」自查
    console.log(
      `  兼容身份      设备 ${cfg.compat.deviceIdHeader || '（未配）'} / 用户 ${cfg.compat.userIdHeader} + 展示名 ${cfg.compat.deviceNameHeader}`,
    )
  }
  console.log('')
  console.log('  Android 接入:')
  console.log('    模拟器     baseUrl = http://10.0.2.2:' + cfg.port)
  console.log('    真机 USB   adb reverse tcp:' + cfg.port + ' tcp:' + cfg.port)
  console.log('              baseUrl = http://127.0.0.1:' + cfg.port)
  if (cfg.lanMode) {
    console.log('')
    console.log('  ⚠ 局域网模式已开启，本机等价于一个开放中转代理（数据面无鉴权）')
    console.log(`  Web 登录口令  ${cfg.password}   （--password 可改）`)
    for (const a of lanAddresses) console.log(`  真机 WiFi    baseUrl = http://${a}:${cfg.port}`)
    console.log('  请仅在可信网络中使用，用完即关。')
  } else {
    console.log('')
    console.log('  仅监听回环地址。真机 WiFi 调试请加 --lan。')
  }
  console.log('')
}
