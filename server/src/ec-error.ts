/**
 * 管理面错误（协议 §6.1）。
 *
 * 为什么单独一个文件：C14 引入的五个码（`EC_PROJECT_NOT_FOUND` / `EC_PROJECT_READONLY` /
 * `EC_SCOPE_MISMATCH` / `EC_CONFLICT` / `EC_STORAGE_UNAVAILABLE`）要在
 * `groups.ts` / `rules.ts` / `projects.ts` 三处抛、由 `index.ts` 一处转成 JSON。
 * 若各处自己 `Object.assign(new Error(), {statusCode})`，`error` 字段就会分叉成
 * `'bad request'` / `'not found'` / EC 码三种写法——客户端只能靠 HTTP 状态码猜，
 * 而同一状态码（404）在下面这张表里对应的是**两个**不同语义。
 *
 * 这些码**只出现在管理面**，不进 §6.2 的 fail-open 判定列表（SDK 不需要为它们写分支）。
 */
export type EcCode =
  | 'EC_PROJECT_NOT_FOUND'
  | 'EC_PROJECT_READONLY'
  | 'EC_SCOPE_MISMATCH'
  | 'EC_CONFLICT'
  | 'EC_STORAGE_UNAVAILABLE'
  | 'EC_UNAUTHORIZED'
  | 'EC_CRYPTO_INVALID'
  | 'EC_CRYPTO_DISABLED'

export interface EcError extends Error {
  statusCode: number
  code: EcCode
}

export function ecError(statusCode: number, code: EcCode, message: string): EcError {
  return Object.assign(new Error(message), { statusCode, code }) as EcError
}

/** 项目 / 版本不存在，**或存在但对当前会话不可见**——两者同形，不用 403 泄露归属 */
export function projectNotFound(idHint = ''): EcError {
  return ecError(404, 'EC_PROJECT_NOT_FOUND', idHint ? `project or version not found: ${idHint}` : 'project or version not found')
}

/** 共享内容只能由 share / rollback 产生，直接编辑与删除一律挡在这里 */
export function projectReadonly(what: string): EcError {
  return ecError(409, 'EC_PROJECT_READONLY', `shared project is read-only: ${what}`)
}

/** 写入越界：规则无归属 / 指向他人或共享项目 / 请求体里带了服务端字段 / 批量里重复 id */
export function scopeMismatch(message: string): EcError {
  return ecError(400, 'EC_SCOPE_MISMATCH', message)
}

/** `share` 带了 `expectedSharedVersionId` 而服务端当前版本已变（脚本用的乐观锁） */
export function conflict(message: string): EcError {
  return ecError(409, 'EC_CONFLICT', message)
}

/** 快照 / journal 落盘失败：整笔作废，active 规则、`currentVersionId`、历史一字未改 */
export function storageUnavailable(message: string): EcError {
  return ecError(507, 'EC_STORAGE_UNAVAILABLE', message)
}

/**
 * 把任意异常折算成管理面 JSON body。
 *
 * `code` 缺失时**沿用既有口径**（`bad request` / `internal`），不改 400/500 的老文案——
 * 存量 CLI 与控制台按 `error` 字符串分支，换字串等于把它们一起改崩（AGENTS.md §5 三方核对）。
 */
export function ecBody(err: unknown): { status: number; body: { error: string; message: string } } {
  const e = err as { statusCode?: number; code?: string; message?: string } | null
  const status = typeof e?.statusCode === 'number' ? e.statusCode : 500
  const message = String(e?.message ?? err)
  const fallback = status >= 500 ? 'internal' : status === 404 ? 'not found' : 'bad request'
  return { status, body: { error: e?.code ?? fallback, message } }
}
