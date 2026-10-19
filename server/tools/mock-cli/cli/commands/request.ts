import { flagBool, flagStr, parseArgs, requirePositional } from '../args.ts'
import type { FlagSpec, Parsed } from '../args.ts'
import { CliError, EXIT, notFoundError, usageError, verifyError } from '../errors.ts'
import type { ConfigStore } from '../config.ts'
import type { ManagementClient } from '../client.ts'
import { b, expectList, fmtTime, n, obj, s, splitUrl } from '../guards.ts'
import { confirmOrDie, emit, info, modeOf, table } from '../output.ts'
import type { Mode } from '../output.ts'
import { clientFor, projectOf } from './auth.ts'

/**
 * `request` = 服务端内存环形缓冲里的抓包记录（`EcRecord`）。
 *
 * 两条必须让 agent 知道的边界：
 * - **记录是内存态**：服务重启即丢，超出 `--max-records`（默认 2000）后最旧的被淘汰；
 * - **只看得到自己空间**：服务端按会话手机号过滤设备归属（ADR-015/018），
 *   未绑定设备的记录不属于任何空间，因此也不在这里出现。
 */

const LIST_FLAGS: FlagSpec = { limit: 'string', q: 'string', 'device-id': 'string', mocked: 'string' }
const GET_FLAGS: FlagSpec = {}
const CLEAR_FLAGS: FlagSpec = { q: 'string', 'device-id': 'string' }

interface RecordView {
  id: string
  seq: number | null
  deviceId: string | null
  method: string | null
  url: string | null
  host: string
  path: string
  status: number | null
  durationMs: number | null
  mocked: boolean | null
  reqBytes: number | null
  respBytes: number | null
  startedAt: number | null
}

/** 列表只回摘要：body 可以很大（几十 KB JSON），全量吐给 agent 等于烧掉它的上下文 */
function recordView(raw: Record<string, unknown>): RecordView | null {
  const id = s(raw, 'id')
  if (!id) return null
  const request = obj(raw, 'request')
  const response = obj(raw, 'response')
  const flags = obj(raw, 'flags')
  const url = s(request, 'url')
  const parsed = splitUrl(url)
  return {
    id,
    seq: n(raw, 'seq'),
    deviceId: s(raw, 'deviceId'),
    method: s(request, 'method'),
    url,
    host: parsed.host,
    path: parsed.path,
    status: n(response, 'status'),
    durationMs: n(raw, 'durationMs'),
    mocked: b(flags, 'mocked'),
    reqBytes: n(request, 'bodySize'),
    respBytes: n(response, 'bodySize'),
    startedAt: n(raw, 'startedAt'),
  }
}

/** `limit` 不做宽松兜底：服务端对脏值是「静默退回 300」，CLI 要如实报错 */
function readLimit(p: Parsed): number | null {
  const raw = flagStr(p, 'limit')
  if (raw === null) return null
  const v = Number(raw)
  if (!Number.isInteger(v) || v <= 0 || v > 1000) {
    throw usageError(`--limit 要是 1..1000 的整数（收到 ${JSON.stringify(raw)}）`, '服务端上限是 1000；要更多请分批或直接读 .data 落盘产物')
  }
  return v
}

function readMockedFlag(p: Parsed): boolean | null {
  const raw = flagStr(p, 'mocked')
  if (raw === null) return null
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw usageError(`--mocked 只接受 true / false（收到 ${JSON.stringify(raw)}）`, '开关字段不做宽松强转')
}

async function fetchRecords(client: ManagementClient, q: { limit?: number; deviceId?: string; text?: string }): Promise<{ views: RecordView[]; dropped: number }> {
  const payload = await client.call('GET', '/__ec/api/records', {
    query: { limit: q.limit, deviceId: q.deviceId, q: q.text },
  })
  const read = expectList(payload, 'GET /__ec/api/records')
  const views: RecordView[] = []
  let dropped = read.dropped
  for (const item of read.items) {
    const v = recordView(item)
    if (v) views.push(v)
    else dropped++
  }
  return { views, dropped }
}

function renderList(views: RecordView[], dropped: number): void {
  if (!views.length) {
    process.stdout.write('没有记录\n')
    info('提示：记录只存在内存里、且只显示当前空间（设备要先绑定：mock device bind <deviceId>）')
  } else {
    process.stdout.write(
      table(
        ['id', '时间', '方法', '状态', '耗时', 'mock', '域名', '路径'],
        views.map((v) => [
          v.id.slice(0, 12),
          fmtTime(v.startedAt),
          v.method ?? '-',
          v.status === null ? '-' : String(v.status),
          v.durationMs === null ? '-' : `${v.durationMs}ms`,
          v.mocked === null ? '?' : v.mocked ? '✓' : '',
          v.host,
          v.path.length > 48 ? `${v.path.slice(0, 47)}…` : v.path,
        ]),
      ) + '\n',
    )
  }
  if (dropped) info(`注意：有 ${dropped} 条记录结构不合法（缺 id），已跳过。`)
}

export async function cmdRequest(store: ConfigStore, argv: string[]): Promise<number> {
  const sub = (argv[0] ?? 'list').toLowerCase()
  if (sub !== 'list' && sub !== 'get' && sub !== 'clear') {
    throw usageError(`未知的 request 子命令：${sub}`, '可用：list / get / clear')
  }
  const spec: FlagSpec = sub === 'list' ? LIST_FLAGS : sub === 'clear' ? CLEAR_FLAGS : GET_FLAGS
  const p = parseArgs(argv.slice(1), spec)
  const mode = modeOf(p)
  const project = projectOf(p, store)
  const client = await clientFor({ store, mode, verbose: flagBool(p, 'verbose') }, p, project)

  if (sub === 'list') return requestList(client, p, mode)
  if (sub === 'get') return requestGet(client, p, mode)
  return requestClear(client, p, mode)
}

async function requestList(client: ManagementClient, p: Parsed, mode: Mode): Promise<number> {
  const limit = readLimit(p)
  const deviceId = flagStr(p, 'device-id')
  const text = flagStr(p, 'q')
  const mocked = readMockedFlag(p)
  const { views, dropped } = await fetchRecords(client, { limit: limit ?? 50, deviceId: deviceId ?? undefined, text: text ?? undefined })
  // `--mocked` 服务端没有对应查询参数，只能在 CLI 侧过滤，如实标注
  const rows = mocked === null ? views : views.filter((v) => v.mocked === mocked)
  emit(
    {
      ok: true,
      count: rows.length,
      dropped,
      limit: limit ?? 50,
      filteredBy: { deviceId, q: text, mocked, mockedFilteredClientSide: mocked !== null },
      records: rows,
    },
    mode,
    () => renderList(rows, dropped),
  )
  return EXIT.OK
}

async function requestGet(client: ManagementClient, p: Parsed, mode: Mode): Promise<number> {
  const id = requirePositional(p, 0, '记录 id', 'mock request get rec_1a2b --json')
  // 摘要里那串截断的 id 不能直接粘进来用：`request list` 显示 12 位前缀，
  // 完整 id 在 --json 的 records[].id 里。这里给一条可执行的提示。
  const res = await client.call('GET', `/__ec/api/records/${encodeURIComponent(id)}`).catch((e: unknown) => {
    if (e instanceof CliError && e.code === 'EC_NOT_FOUND') {
      throw notFoundError(
        `没有这条记录：${id}`,
        '人类模式列表里的 id 是截断显示；用 mock request list --json 取完整 id。记录只在内存里，服务重启或超出条数上限会丢',
      )
    }
    throw e
  })
  const record = res && typeof res === 'object' && !Array.isArray(res) ? (res as Record<string, unknown>) : null
  if (!record) {
    throw new CliError('EC_BAD_RESPONSE', `GET /__ec/api/records/${id} 返回的不是对象`, '确认服务端版本包含该接口', EXIT.SERVER)
  }
  emit({ ok: true, id, record }, mode, () => {
    const request = obj(record, 'request')
    const response = obj(record, 'response')
    process.stdout.write(
      table(
        ['字段', '值'],
        [
          ['方法/URL', `${s(request, 'method') ?? '-'} ${s(request, 'url') ?? '-'}`],
          ['状态', String(n(response, 'status') ?? '-')],
          ['耗时', `${n(record, 'durationMs') ?? '-'}ms`],
          ['请求大小', `${n(request, 'bodySize') ?? 0} 字节`],
          ['响应大小', `${n(response, 'bodySize') ?? 0} 字节`],
          ['设备', s(record, 'deviceId') ?? '-'],
          ['时间', fmtTime(n(record, 'startedAt'))],
        ],
      ) + '\n',
    )
    info('body 在 record.request.body / record.response.body（--json 可整份取走）')
  })
  return EXIT.OK
}

async function requestClear(client: ManagementClient, p: Parsed, mode: Mode): Promise<number> {
  const deviceId = flagStr(p, 'device-id')
  const text = flagStr(p, 'q')
  const scope = deviceId || text ? `当前筛选（deviceId=${deviceId ?? '-'} q=${text ?? '-'}）` : '当前空间的全部记录'

  const before = await fetchRecords(client, { limit: 1000, deviceId: deviceId ?? undefined, text: text ?? undefined })
  // 服务端单次最多回 1000 条，所以「命中 N 条」在记录更多时是**下限**，
  // 不能让人以为「只有这么多会被清掉」（AGENTS.md §9：状态不要撒谎）
  const capped = before.views.length >= 1000
  await confirmOrDie(p, `清空${scope}，命中 ${capped ? `≥${before.views.length}` : before.views.length} 条记录（清掉就找不回来了）`)

  const res = (await client.call('DELETE', '/__ec/api/records', {
    query: { deviceId: deviceId ?? undefined, q: text ?? undefined },
  })) as Record<string, unknown>
  const cleared = n(res, 'cleared')

  // 读回校验：同条件再查一次，应该一条不剩
  const after = await fetchRecords(client, { limit: 1000, deviceId: deviceId ?? undefined, text: text ?? undefined })
  if (after.views.length) {
    throw verifyError(
      `清空后仍读到 ${after.views.length} 条记录（服务端报 cleared=${cleared}）`,
      '期间可能有新请求进来；确认设备已停后再清，或用 --q 缩小范围',
    )
  }
  emit({ ok: true, cleared, before: before.views.length, verified: true, scope: deviceId || text ? 'filtered' : 'space' }, mode, () =>
    info(`已清空 ${cleared ?? 0} 条记录（${scope}），已读回确认`),
  )
  return EXIT.OK
}
