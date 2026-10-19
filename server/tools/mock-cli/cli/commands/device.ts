import { flagBool, flagStr, parseArgs } from '../args.ts'
import type { FlagSpec, Parsed } from '../args.ts'
import { CliError, EXIT, notImplemented, notFoundError, usageError, verifyError } from '../errors.ts'
import type { ConfigStore } from '../config.ts'
import type { ManagementClient } from '../client.ts'
import { b, expectList, fmtTime, n, s } from '../guards.ts'
import { confirmOrDie, emit, info, modeOf, table } from '../output.ts'
import type { Mode } from '../output.ts'
import { clientFor, projectOf } from './auth.ts'

/**
 * `device` = 服务端设备表里的一台客户端（`DeviceView`）。
 *
 * 可见范围由服务端决定（ADR-018）：普通用户看到**自己绑定的 + 谁都没绑的**，
 * 管理员看到全量。这个口径 CLI 不重做一遍，只在它之上加一条守卫，见 `bind`。
 */

const LIST_FLAGS: FlagSpec = { online: 'string' }
const BIND_FLAGS: FlagSpec = { force: 'bool' }
const CURRENT_FLAGS: FlagSpec = {}

interface DeviceView {
  deviceId: string
  name: string | null
  online: boolean | null
  owner: string | null
  os: string | null
  brand: string | null
  model: string | null
  appId: string | null
  appVersion: string | null
  env: string | null
  userId: string | null
  userName: string | null
  lastSeenAt: number | null
}

/** 设备名有好几个来源（SDK 上报的 deviceName、兼容层的 displayName、机型…），按可读性依次取 */
function deviceName(raw: Record<string, unknown>): string | null {
  for (const key of ['deviceName', 'displayName', 'marketName', 'model', 'brand']) {
    const v = s(raw, key)
    if (v) return v
  }
  return null
}

/** 设备条目可能是脏的（没有 deviceId 的条目在服务端也照样存在，如手改过的 store）→ 丢掉并计数 */
function deviceView(raw: Record<string, unknown>): DeviceView | null {
  const deviceId = s(raw, 'deviceId')
  if (!deviceId) return null
  return {
    deviceId,
    name: deviceName(raw),
    online: b(raw, 'online'),
    owner: s(raw, 'owner'),
    os: s(raw, 'os'),
    brand: s(raw, 'brand'),
    model: s(raw, 'model'),
    appId: s(raw, 'appId'),
    appVersion: s(raw, 'appVersion'),
    env: s(raw, 'env'),
    userId: s(raw, 'userId'),
    userName: s(raw, 'userName'),
    lastSeenAt: n(raw, 'lastSeenAt'),
  }
}

async function readDevices(client: ManagementClient): Promise<{ devices: DeviceView[]; dropped: number }> {
  const read = expectList(await client.call('GET', '/__ec/api/devices'), 'GET /__ec/api/devices')
  const devices: DeviceView[] = []
  let dropped = read.dropped
  for (const item of read.items) {
    const v = deviceView(item)
    if (v) devices.push(v)
    else dropped++
  }
  return { devices, dropped }
}

async function myPhone(client: ManagementClient): Promise<string> {
  const res = (await client.call('GET', '/__ec/api/me')) as Record<string, unknown>
  const user = res.user && typeof res.user === 'object' ? (res.user as Record<string, unknown>) : null
  const phone = user ? s(user, 'phone') : null
  if (!phone) {
    throw new CliError('EC_BAD_RESPONSE', '/__ec/api/me 没回 user.phone', '执行 mock login 重新登录', EXIT.SERVER)
  }
  return phone
}

/**
 * 目标设备定位：`--device-id` 与位置参数都接受（skill 里两种写法都出现），
 * 但**两者同时给且不一致**时报错——静默取其中一个，agent 无从发现。
 */
function targetId(p: Parsed, index: number, example: string): string {
  const positional = p.positional[index] ?? ''
  const flag = flagStr(p, 'device-id')
  if (flag !== null && positional && flag !== positional) {
    throw usageError(`设备 id 给了两个不同的值：位置 ${JSON.stringify(positional)} 与 --device-id ${JSON.stringify(flag)}`, '只保留一个')
  }
  const id = positional || flag || ''
  if (!id) throw usageError(`缺少设备 id`, `如 ${example}`)
  return id
}

function ownerMark(v: DeviceView, phone: string): string {
  if (!v.owner) return '未绑定'
  if (v.owner === phone) return '我的'
  return '他人'
}

export async function cmdDevice(store: ConfigStore, argv: string[]): Promise<number> {
  const sub = (argv[0] ?? 'list').toLowerCase()
  if (sub === 'rename') {
    throw notImplemented(
      'mock device rename',
      'P3',
      '服务端没有「管理侧覆盖设备名」的字段：deviceName 由 SDK 上报（EasyCharlesConfig.deviceName），改名要改 App 侧配置；控制台设备面板同样只显示上报值',
    )
  }
  if (sub !== 'list' && sub !== 'current' && sub !== 'bind' && sub !== 'unbind') {
    throw usageError(`未知的 device 子命令：${sub}`, '可用：list / current / bind / unbind；rename 属 P3')
  }

  const spec: FlagSpec = sub === 'bind' || sub === 'unbind' ? BIND_FLAGS : sub === 'list' ? LIST_FLAGS : CURRENT_FLAGS
  const p = parseArgs(argv.slice(1), { ...spec, 'device-id': 'string' })
  const mode = modeOf(p)
  const project = projectOf(p, store)
  const client = await clientFor({ store, mode, verbose: flagBool(p, 'verbose') }, p, project)

  if (sub === 'list') return deviceList(client, p, mode)
  if (sub === 'current') return deviceCurrent(client, p, mode)
  if (sub === 'bind') return deviceBind(client, p, mode)
  return deviceUnbind(client, p, mode)
}

function readOnlineFlag(p: Parsed): boolean | null {
  const raw = flagStr(p, 'online')
  if (raw === null) return null
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw usageError(`--online 只接受 true / false（收到 ${JSON.stringify(raw)}）`, '开关字段不做宽松强转')
}

async function deviceList(client: ManagementClient, p: Parsed, mode: Mode): Promise<number> {
  const phone = await myPhone(client)
  const { devices, dropped } = await readDevices(client)
  const online = readOnlineFlag(p)
  const rows = online === null ? devices : devices.filter((d) => d.online === online)
  emit({ ok: true, count: rows.length, total: devices.length, dropped, viewer: phone, devices: rows }, mode, () => {
    if (!rows.length) {
      process.stdout.write(`没有可见的设备（服务端共 ${devices.length} 台）\n`)
      info('提示：设备要先用 SDK 连上服务（hello），或跑 mock project list --check 确认打的是哪台服务')
    } else {
      process.stdout.write(
        table(
          ['deviceId', '名字', '在线', '归属', '系统', '机型', '最近出现'],
          rows.map((d) => [
            d.deviceId,
            d.name ?? '-',
            d.online === null ? '?' : d.online ? '✓' : '✗',
            ownerMark(d, phone),
            d.os ?? '-',
            d.model ?? d.brand ?? '-',
            fmtTime(d.lastSeenAt),
          ]),
        ) + '\n',
      )
    }
    if (dropped) info(`注意：有 ${dropped} 条设备条目结构不合法（缺 deviceId），已跳过。`)
  })
  return EXIT.OK
}

async function deviceCurrent(client: ManagementClient, p: Parsed, mode: Mode): Promise<number> {
  const me = (await client.call('GET', '/__ec/api/me')) as Record<string, unknown>
  const user = me.user && typeof me.user === 'object' ? (me.user as Record<string, unknown>) : null
  const phone = user ? s(user, 'phone') : null
  if (!phone) throw new CliError('EC_BAD_RESPONSE', '/__ec/api/me 没回 user.phone', '执行 mock login 重新登录', EXIT.SERVER)
  const lastBound = user ? s(user, 'lastBoundDeviceId') : null
  const { devices } = await readDevices(client)
  const found = lastBound ? devices.find((d) => d.deviceId === lastBound) ?? null : null
  // staleBinding：账号里记着上次绑的那台，但这次可见列表里没有它。
  // 说清楚，否则 agent 会以为「current 为空 = 没绑过」而重复去 bind。
  const staleBinding = !!lastBound && !found
  emit({ ok: true, current: found, deviceId: found?.deviceId ?? null, boundTo: phone, lastBoundDeviceId: lastBound, staleBinding }, mode, () => {
    if (found) {
      process.stdout.write(
        table(
          ['字段', '值'],
          [
            ['deviceId', found.deviceId],
            ['名字', found.name ?? '-'],
            ['在线', found.online === null ? '?' : found.online ? '是' : '否'],
            ['归属', ownerMark(found, phone)],
            ['系统/机型', [found.os, found.model].filter(Boolean).join(' ') || '-'],
            ['最近出现', fmtTime(found.lastSeenAt)],
          ],
        ) + '\n',
      )
    } else {
      process.stdout.write(`当前空间（${phone}）没有绑定的设备\n`)
      info(lastBound ? `账号里记着上次绑过 ${lastBound}，但这次看不见它（设备未出现或已被解绑）` : '先跑 mock device list 看有哪些设备，再 mock device bind <deviceId>')
    }
  })
  return EXIT.OK
}

async function deviceBind(client: ManagementClient, p: Parsed, mode: Mode): Promise<number> {
  const phone = await myPhone(client)
  const id = targetId(p, 0, 'mock device bind <deviceId> --json')
  const force = flagBool(p, 'force')
  const { devices } = await readDevices(client)
  const found = devices.find((d) => d.deviceId === id) ?? null
  let forced = false

  if (!found) {
    // 不在可见列表有两种可能：设备从没连上来过；或它已属于别人的空间
    // （普通用户的列表里没有他人设备，管理员能看到全部）。
    // 服务端本身不校验归属，所以这一步守卫是 CLI 侧的**唯一**防线。
    if (!force) {
      throw notFoundError(
        `设备不在你的可见列表：${id}`,
        `两种可能：① App 还没连上过这台服务（先 mock device list 确认，或用 mock project list --check 看打的是哪台服务）；② 它已被别的手机号绑定，只有管理员看得见。确需强行绑定（会把设备从对方空间拿走）加 --force`,
      )
    }
    await confirmOrDie(p, `强制绑定不在你可见列表里的设备 ${id}（可能把设备从别人的空间夺走）`)
    forced = true
  } else if (found.owner === phone) {
    emit({ ok: true, deviceId: id, bound: true, already: true, verified: true }, mode, () => info(`设备 ${id} 本来就绑在你的空间，无需重复绑定`))
    return EXIT.OK
  } else if (found.owner) {
    if (!force) {
      throw new CliError(
        'EC_CONFLICT',
        `设备 ${id} 已绑定到其他手机号（管理员可见全量，绑定会把它夺过来）`,
        '确认这是你要的操作再加 --force；否则请让对方先 mock device unbind',
        EXIT.USAGE,
      )
    }
    await confirmOrDie(p, `把设备 ${id} 从当前归属改绑到 ${phone}`)
    forced = true
  }

  const res = (await client.call('POST', `/__ec/api/devices/${encodeURIComponent(id)}/bind`, { body: {} })) as Record<string, unknown>
  const { devices: after } = await readDevices(client)
  const now = after.find((d) => d.deviceId === id) ?? null
  if (!now || now.owner !== phone) {
    throw verifyError(
      `绑定后读回不一致：期望归属 ${phone}，读到 ${JSON.stringify(now?.owner)}（服务端返回 ok=${JSON.stringify(res.ok)}）`,
      '设备此刻可能没在服务端设备表里：让 App 先连上来（hello），再重试 mock device bind',
    )
  }
  emit({ ok: true, deviceId: id, bound: true, forced, verified: true, device: now }, mode, () =>
    info(`已绑定设备 ${id} 到 ${phone}${forced ? '（--force）' : ''}，已读回确认`),
  )
  return EXIT.OK
}

async function deviceUnbind(client: ManagementClient, p: Parsed, mode: Mode): Promise<number> {
  const phone = await myPhone(client)
  const id = targetId(p, 0, 'mock device unbind <deviceId> --json')
  const { devices } = await readDevices(client)
  const found = devices.find((d) => d.deviceId === id) ?? null
  if (!found) throw notFoundError(`没有这台可见设备：${id}`, '先跑 mock device list 拿 deviceId')
  if (found.owner !== phone) {
    throw new CliError(
      'EC_CONFLICT',
      `设备 ${id} 当前归属不是你自己（读到 ${JSON.stringify(found.owner)}），服务端只允许解绑自己空间的设备`,
      '如果是误绑，请用绑定的那个手机号执行 mock device unbind',
      EXIT.AUTH,
    )
  }

  const res = (await client.call('POST', `/__ec/api/devices/${encodeURIComponent(id)}/unbind`, { body: {} })) as Record<string, unknown>
  const { devices: after } = await readDevices(client)
  const now = after.find((d) => d.deviceId === id) ?? null
  if (now && now.owner === phone) {
    throw verifyError(
      `解绑后读回仍显示属于你（服务端返回 ok=${JSON.stringify(res.ok)}）`,
      '设备可能正被另一台控制台重复绑定，确认后再试',
    )
  }
  emit({ ok: true, deviceId: id, unbound: true, verified: true, device: now }, mode, () =>
    info(`已解绑设备 ${id}${now ? `（现在归属 ${now.owner ?? '未绑定'}）` : '（已从可见列表消失）'}`),
  )
  return EXIT.OK
}
