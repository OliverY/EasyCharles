/**
 * 加解密链路的结果类型与错误工厂（协议 §5.6 / ADR-039）。
 *
 * 为什么全链路用 `{ ok, error }` 而不是抛异常：解密是**热路径且必须 fail-open**，
 * 失败要能写进记录（`crypto.request.error`）继续转发，而不是冒泡成 500。
 * 只有「写入口」的结构错误才抛异常——由管理面翻成 400，见 `invalid()`。
 */

export type Fail = { ok: false; error: string }
export type Ok<T> = { ok: true } & T

export function bad(error: string): Fail {
  return { ok: false, error }
}

/** 写入口的结构错误统一 400：与 rules.ts 同形，`code` 让客户端能按码分支而不是猜文案 */
export function invalid(msg: string): Error {
  return Object.assign(new Error(msg), { statusCode: 400, code: 'EC_CRYPTO_INVALID' })
}
