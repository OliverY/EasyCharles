import { usageError } from './errors.ts'
import type { FlagSpec, Parsed } from './args.ts'
import { flagList } from './args.ts'
import { n, obj, s } from './guards.ts'

/**
 * 四条**并行数组**（`--json-list` / `--response-group-names` /
 * `--response-group-queries` / `--response-group-contents`）的对齐、构造与读回比对。
 *
 * 这套写法来自被复刻的那份 agent skill：第 i 个下标同时描述「第 i 组返回值」的
 * body / 备注名 / 命中条件。**下标一错就把返回值挂到了错误的条件上，而且服务端不会报错**
 * ——这是本 CLI 最大的一类事故（ADR-027 的坑点段），所以三道防线全部做在这里：
 *
 * 1. 提交前：四条数组长度必须一致（缺 `--json-list` 时要求与现有条数一致）；
 * 2. 提交前：识别「把整个 JSON 数组当成一个参数传了」这个典型误用
 *    （长度 1 且该项能解析成数组，而其他数组长度正好等于该数组长度）；
 * 3. 提交后：读回逐条比对四条数组的长度与内容，对不上就 `EC_VERIFY_FAILED`，
 *    **绝不因为服务端回了 200 就说成功**。
 *
 * 存下来的形态与控制台完全一致（`{status, headers, body, name?}`），
 * `cond` 是本 CLI 新增的可选字段（协议 §5.4 C12）：**只存不选路**，P4 才解释里面的条件文本。
 */

export const RESPONSE_FLAGS: FlagSpec = {
  'json-list': 'list',
  'response-group-names': 'list',
  'response-group-queries': 'list',
  'response-group-contents': 'list',
  'allow-empty-body': 'bool',
  // status / content-type 也是**可重复**的：`--status 200 --status 401` 按返回值下标对齐。
  // 只给一个值 = 全都用这个（最常见的 `--status 201`）。缺省沿用服务端存着的那条自己的 status。
  status: 'list',
  'content-type': 'list',
}

/**
 * 一条返回值的形态（与服务端 `MockResponse` 同构，字段名不许漂移）。
 *
 * 带索引签名是有意的：**读改写要无损**。改 body 时原条目上那些 CLI 不认识的字段
 * （未来的 `latencyMs`、控制台本地写的标记…）必须一起带走，否则 CLI 一次 update
 * 就把控制台存的别的东西抹掉了——这是 ADR-027 记过的同一类坑。
 */
export interface BuiltResponse {
  status: number
  headers: Record<string, string>
  body: string
  name?: string
  cond?: { query?: string; content?: string }
  [key: string]: unknown
}

export interface ArraySpec {
  jsonList: string[] | null
  names: string[] | null
  queries: string[] | null
  contents: string[] | null
}

export interface BuildResult {
  responses: BuiltResponse[]
  /**
   * 各数组实际参与构造的长度（读回校验与 JSON 输出都要用它做断言）。
   * `status` / `contentType` 记的是**给了几个值**：1 = 广播给每条，N = 按下标对应。
   */
  lengths: {
    jsonList: number | null
    names: number | null
    queries: number | null
    contents: number | null
    status: number | null
    contentType: number | null
  }
  /** 因为新数组变短而被去掉的原有返回值条数（调用方据此要求 --yes 确认） */
  removed: number
}

/** `flagList` 用的键名（不带 `--`，与 parseArgs 存进 flags 的形式一致） */
const FLAG_NAMES: Record<keyof ArraySpec, string> = {
  jsonList: 'json-list',
  names: 'response-group-names',
  queries: 'response-group-queries',
  contents: 'response-group-contents',
}

/** 报错文案里一律带 `--` 前缀，跟用户敲的形式一致 */
function labelOf(key: keyof ArraySpec): string {
  return `--${FLAG_NAMES[key]}`
}

/** 空列表 = 没传过这个 flag（`flagList` 对未出现的 flag 返回 `[]`，不能当成「传了一个空串」） */
export function arraysFromArgs(p: Parsed): ArraySpec {
  const take = (name: keyof ArraySpec): string[] | null => {
    const v = flagList(p, FLAG_NAMES[name])
    return v.length ? v : null
  }
  return { jsonList: take('jsonList'), names: take('names'), queries: take('queries'), contents: take('contents') }
}

export function anyArrayGiven(spec: ArraySpec): boolean {
  return spec.jsonList !== null || spec.names !== null || spec.queries !== null || spec.contents !== null
}

function providedKeys(spec: ArraySpec): (keyof ArraySpec)[] {
  return (Object.keys(FLAG_NAMES) as (keyof ArraySpec)[]).filter((k) => spec[k] !== null)
}

function lengthSummary(spec: ArraySpec): string {
  return providedKeys(spec)
    .map((k) => `${labelOf(k)}=${(spec[k] as string[]).length}`)
    .join(' ')
}

/**
 * 「整个数组塞进一个参数」的识别。
 *
 * 只在这一处判定，不做无条件拒绝：**返回值本身就是一个 JSON 数组**是完全合法的
 * （列表接口返回 `[{...}]`）。真正的特征是「只传了一项、这一项解析成 L 个元素的数组、
 * 而其他并行数组的长度正好是 L」——那是把 `--json-list '[a,b,c]'` 写成一次而非三次的形状。
 */
function looksLikeSplitMistake(spec: ArraySpec): string | null {
  const list = spec.jsonList
  if (!list || list.length !== 1) return null
  const others = providedKeys(spec).filter((k) => k !== 'jsonList')
  if (!others.length) return null
  const other = spec[others[0]] as string[]
  if (other.length === 1) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(list[0] as string)
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length !== other.length) return null
  return `--json-list 只传了 1 项，而这一项本身是 ${parsed.length} 个元素的 JSON 数组，` +
    `另一条数组长度正好是 ${parsed.length}（当前各数组长度：${lengthSummary(spec)}）`
}

/**
 * 按下标把四条数组拼成 `responses`。
 *
 * `existing` 是服务端当前那条规则的返回值条目（原样，含未知字段）：
 * 新条目以它打底，因此**改 body 不会顺手改掉 status / 响应头 / 备注名**，
 * 未知字段也原样带走（AGENTS.md §5 的「三方核对」在 CLI 侧的对应物）。
 */
/**
 * 把「可重复、但也可以只给一个」的 flag 摊平成按下标取值的函数。
 *
 * 长度 1 = 广播给每条返回值（`--status 201` 这种最常见的写法不该逼人重复三次）；
 * 长度 > 1 = 必须与返回值条数一一对应，对不上就是用法错——
 * 静默少一个状态码会让「成功 200 / 密码错误 401」变成两条都 200，服务端不报错、控制台也看不出来。
 */
export function perIndex<T>(label: string, values: T[] | null, len: number): (i: number) => T | null {
  if (values === null || values.length === 0) return () => null
  if (values.length === 1) return () => values[0]
  if (values.length !== len) {
    throw usageError(
      `${label} 给了 ${values.length} 个值，但要写的返回值是 ${len} 条`,
      `只给一个值即表示「每条都用它」（如 ${label} 201）；要逐条区分就按返回值条数给够 ${len} 个`,
    )
  }
  return (i: number) => values[i]
}

export function buildResponses(
  spec: ArraySpec,
  existing: Record<string, unknown>[],
  opts: { status: number[] | null; contentType: string[] | null; allowEmptyBody: boolean },
): BuildResult | null {
  const keys = providedKeys(spec)
  let len = 0

  if (keys.length === 0) {
    // 一条数组都没给：只有 `--status` / `--content-type` 时才继续——那是「把现有每条返回值
    // 的状态码统一改掉」，条数不变。否则返回 null 让调用方给针对性报错。
    if (opts.status === null && opts.contentType === null) return null
    if (!existing.length) return null
    len = existing.length
  } else {
    const lengths = new Set(keys.map((k) => (spec[k] as string[]).length))

    const mistake = looksLikeSplitMistake(spec)
    if (mistake) {
      throw usageError(
        `疑似把整个 JSON 数组当成一个参数传了：${mistake}`,
        '数组类参数要**逐项重复传 flag**：--json-list A --json-list B --json-list C（不是 --json-list "[A,B,C]"）；' +
          '内容很大时用 --json-list @/tmp/one.json',
      )
    }

    if (lengths.size > 1) {
      throw usageError(
        `并行数组长度不一致：${lengthSummary(spec)}`,
        `四条数组按下标一一对应，长度必须相同（只传其中几条时，其余按现有返回值条数补齐）。` +
          `当前服务端这条规则有 ${existing.length} 条返回值；要么四条都给齐且等长，要么只给 --json-list 并把条数定成你想要的`,
      )
    }
    len = [...lengths][0] ?? 0

    if (spec.jsonList === null) {
      // 没给 body：body 沿用现有条目，因此新数组长度必须等于现有条数，
      // 否则「给 3 个名字配 5 条返回值」这种意图只能靠猜——猜错就是把条件挂到别的返回值上
      if (existing.length !== len) {
        throw usageError(
          `没传 --json-list，但其他数组长度是 ${len}，服务端现有返回值是 ${existing.length} 条`,
          `改备注名/命中条件时要保持条数不变：要么凑够 --json-list，要么把数组长度改成 ${existing.length}`,
        )
      }
    }
  }
  if (len === 0) {
    throw usageError('没有任何返回值可写', '至少给一条 --json-list；确实想删掉整条规则用 mock api delete')
  }

  // 摊平成「按下标取值」的函数：只给一个值即广播，给多条就必须与条数对齐
  const statusAt = perIndex('--status', opts.status, len)
  const ctAt = perIndex('--content-type', opts.contentType, len)

  const out: BuiltResponse[] = []
  for (let i = 0; i < len; i++) {
    const base = existing[i] ?? null

    let body: string
    if (spec.jsonList !== null) {
      body = spec.jsonList[i] ?? ''
      if (body === '' && !opts.allowEmptyBody) {
        throw usageError(
          `--json-list 第 ${i + 1} 项是空串`,
          '空串通常是 shell 转义丢了或 @文件 读空。确实要空 body 就加 --allow-empty-body；' +
            '要「空对象」请写 {}',
        )
      }
    } else {
      body = base === null ? '' : s(base, 'body') ?? ''
    }

    // 以原条目为**底**（含 CLI 不认识的字段），再逐项覆盖命令行管的那些键：
    // 读改写无损（ADR-027）。新建时 base 为 null，走缺省值。
    const resp = { status: 200, headers: {}, body: '', ...(base ?? {}) } as unknown as BuiltResponse
    resp.body = body
    const wantStatus = statusAt(i)
    resp.status = wantStatus !== null ? wantStatus : n(base, 'status') ?? 200

    // headers 重新建一个对象：直接改 resp.headers 会把读回来的那份原对象也改掉
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(obj(base, 'headers') ?? {})) {
      if (typeof v === 'string') headers[k] = v
    }
    const wantCt = ctAt(i)
    if (wantCt !== null) {
      if (wantCt === '') delete headers['content-type']
      else headers['content-type'] = wantCt
    } else if (typeof headers['content-type'] !== 'string') {
      headers['content-type'] = 'application/json'
    }
    resp.headers = headers

    const name = spec.names !== null ? spec.names[i] ?? '' : s(base ?? {}, 'name') ?? ''
    if (name) resp.name = name
    else delete resp.name

    // cond：只有显式给了 queries / contents 才动它。两条都给到空串 = 清除条件（不写 cond 字段）
    if (spec.queries !== null || spec.contents !== null) {
      const baseCond = obj(base, 'cond') ?? {}
      const q = spec.queries !== null ? spec.queries[i] ?? '' : s(baseCond, 'query') ?? ''
      const c = spec.contents !== null ? spec.contents[i] ?? '' : s(baseCond, 'content') ?? ''
      if (q || c) resp.cond = { ...baseCond, query: q, content: c }
      else delete resp.cond
    }

    out.push(resp)
  }

  return {
    responses: out,
    lengths: {
      jsonList: spec.jsonList?.length ?? null,
      names: spec.names?.length ?? null,
      queries: spec.queries?.length ?? null,
      contents: spec.contents?.length ?? null,
      // 状态码 / content-type 给几个也一并回传：agent 不必自己数，也看得见「只给一个 = 广播」
      status: opts.status?.length ?? null,
      contentType: opts.contentType?.length ?? null,
    },
    removed: Math.max(0, existing.length - len),
  }
}

/** 读回的那条返回值与期望值比对，返回「哪里不一样」的空串数组（空数组 = 一致） */
function diffOne(index: number, want: BuiltResponse, got: Record<string, unknown>): string[] {
  const at = `第 ${index + 1} 条`
  const out: string[] = []
  const gotBody = s(got, 'body')
  if (gotBody === null) out.push(`${at}：body 不是字符串（收到 ${JSON.stringify(got.body) ?? 'null'}）`)
  else if (gotBody !== want.body) out.push(`${at}：body 不一致（期望 ${want.body.length} 字，读到 ${gotBody.length} 字）`)

  const gotStatus = n(got, 'status')
  if (gotStatus !== want.status) out.push(`${at}：status 期望 ${want.status}，读到 ${JSON.stringify(got.status)}`)

  const gotHeaders = obj(got, 'headers') ?? {}
  for (const [k, v] of Object.entries(want.headers)) {
    if (gotHeaders[k] !== v) out.push(`${at}：响应头 ${k} 期望 ${JSON.stringify(v)}，读到 ${JSON.stringify(gotHeaders[k])}`)
  }
  for (const [k, v] of Object.entries(gotHeaders)) {
    if (!(k in want.headers)) out.push(`${at}：多出了没提交过的响应头 ${k}=${JSON.stringify(v)}`)
  }

  const gotName = s(got, 'name') ?? ''
  if (gotName !== (want.name ?? '')) out.push(`${at}：备注名期望 ${JSON.stringify(want.name ?? '')}，读到 ${JSON.stringify(gotName)}`)

  const gotCond = obj(got, 'cond')
  const wantQuery = want.cond?.query ?? ''
  const wantContent = want.cond?.content ?? ''
  const gotQuery = s(gotCond ?? {}, 'query') ?? ''
  const gotContent = s(gotCond ?? {}, 'content') ?? ''
  if (gotQuery !== wantQuery) out.push(`${at}：命中条件 query 期望 ${JSON.stringify(wantQuery)}，读到 ${JSON.stringify(gotQuery)}`)
  if (gotContent !== wantContent) {
    out.push(`${at}：命中条件 content 期望 ${JSON.stringify(wantContent)}，读到 ${JSON.stringify(gotContent)}`)
  }
  return out
}

/**
 * 提交后读回，把四条数组重新核对一遍（skill 的硬要求：「写完必须读回核对四条长度」）。
 *
 * `form` 区分两种存储形态：`responses` 数组，或旧形态单条 `response`
 * （控制台在「1 条返回值 + 指定返回」时写后者，CLI 跟着它，否则两个端写出来的规则控制台读不懂）。
 */
export function diffAgainstServer(
  want: BuildResult,
  got: Record<string, unknown> | null,
  form: 'responses' | 'single',
): string[] {
  if (!got) return ['读回时这条规则已经不在了（可能被另一台控制台整表覆盖，ADR-019）']
  const action = obj(got, 'action')
  if (!action) return ['读回的规则没有 action 字段（服务端存的东西不认识）']

  let items: Record<string, unknown>[]
  if (form === 'single') {
    const one = obj(action, 'response')
    if (!one) return ['期望旧形态单条 action.response，但读回来没有（服务端存的是别的形态）']
    items = [one]
  } else {
    const raw = action.responses
    if (!Array.isArray(raw)) {
      return [`读回的 action.responses 不是数组（收到 ${raw === null ? 'null' : Array.isArray(raw) ? '数组' : typeof raw}）`]
    }
    items = raw.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r))
  }

  const expectCount = want.responses.length
  if (items.length !== expectCount) {
    return [`返回值条数期望 ${expectCount}，读到 ${items.length}（各数组长度：${JSON.stringify(want.lengths)}）`]
  }
  const diffs: string[] = []
  for (let i = 0; i < expectCount; i++) {
    diffs.push(...diffOne(i, want.responses[i] as BuiltResponse, items[i] as Record<string, unknown>))
  }
  return diffs
}

/** 供 --json 输出：把四条数组的期望长度与实际读回长度一并给出，agent 不用自己再数 */
export function arraySummary(want: BuildResult, gotCount: number): Record<string, unknown> {
  return {
    requested: want.lengths,
    responsesWritten: want.responses.length,
    readBack: gotCount,
    removedExisting: want.removed,
  }
}
