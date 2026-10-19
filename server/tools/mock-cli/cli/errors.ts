/**
 * 统一错误类型与退出码。
 *
 * 退出码是 CLI 对 AI agent 的契约，agent 靠它判断「该补参数」还是「该登录」，
 * 所以一旦定下不再随意改语义。
 */
export const EXIT = {
  OK: 0,
  GENERIC: 1,
  USAGE: 2,
  AUTH: 3,
  SERVER: 4,
  UNREACHABLE: 5,
  /**
   * C14：请求本身没错，错在「动了不该动的归属」——共享项目只读、
   * 规则要属于我的私有项目。单列一个码是因为 agent 的补救动作是
   * 「先 copy 一份再改」，而不是「换个参数重试」，两者不该混在 4 里。
   */
  PROJECT_READONLY: 6,
  /** C14：`expectedSharedVersionId` 对不上（目标已有新版本）。补救 = 先读历史再决定要不要覆盖 */
  CONFLICT: 7,
  NOT_IMPLEMENTED: 64,
} as const

export class CliError extends Error {
  code: string
  hint: string | null
  exit: number

  constructor(code: string, message: string, hint: string | null = null, exit: number = EXIT.GENERIC) {
    super(message)
    this.name = 'CliError'
    this.code = code
    this.hint = hint
    this.exit = exit
  }
}

export function usageError(message: string, hint: string | null = null): CliError {
  return new CliError('EC_USAGE', message, hint, EXIT.USAGE)
}

export function authError(message: string, hint: string | null = null): CliError {
  return new CliError('EC_UNAUTHORIZED', message, hint, EXIT.AUTH)
}

/**
 * 「这个 id 没有」。CLI 自己查无此条和服务端返回 404 **必须是同一个 code**，
 * 否则 agent 对同一种失败要写两套判断。
 */
export function notFoundError(message: string, hint: string | null = null): CliError {
  return new CliError('EC_NOT_FOUND', message, hint, EXIT.SERVER)
}

/** 写下去但读回对不上（技能要求「提交后读回校验」）。宁可报错，也不返回 ok:true */
export function verifyError(message: string, hint: string | null = null): CliError {
  return new CliError('EC_VERIFY_FAILED', message, hint, EXIT.SERVER)
}

/**
 * C14 的三种归属错误在 **CLI 侧本地判定**也要用同一批码，
 * 这样 agent 面对「服务端 409」和「CLI 提前拦下」时只需要写一套分支。
 */
export function projectReadonlyError(message: string, hint: string | null = null): CliError {
  return new CliError('EC_PROJECT_READONLY', message, hint, EXIT.PROJECT_READONLY)
}

/** 归属不匹配：要动的东西不在「我自己的私有项目」里 */
export function scopeMismatchError(message: string, hint: string | null = null): CliError {
  return new CliError('EC_SCOPE_MISMATCH', message, hint, EXIT.PROJECT_READONLY)
}

/** 乐观锁对不上（`expectedSharedVersionId` 已过期） */
export function conflictError(message: string, hint: string | null = null): CliError {
  return new CliError('EC_CONFLICT', message, hint, EXIT.CONFLICT)
}

export function notImplemented(what: string, phase: string, alternative: string): CliError {
  return new CliError(
    'EC_NOT_IMPLEMENTED',
    `${what} 尚未实现（计划阶段 ${phase}）`,
    `当前可用的替代做法：${alternative}`,
    EXIT.NOT_IMPLEMENTED,
  )
}
