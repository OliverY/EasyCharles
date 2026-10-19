/**
 * 单文件脚本插件的**最小示例**（ADR-040 §5.6）。
 *
 * 把这份文件拷到 `<dataDir>/crypto/scripts/` 下即可：
 *
 * ```
 * ~/Library/Application Support/EasyCharles/data/crypto/scripts/rot13.mjs
 * ```
 *
 * 然后在 `/crypto` 页面新建密钥档，插件选 `script:rot13`，参数填 `{"shift": 13}`。
 *
 * 契约只有三行：入参是密文串、出参是明文字符串、必须是同步函数。
 * 外壳（`{"data":"..."}` / `ciphertext:` 前缀 / query 参数名）由密钥档的 wrap 配置负责，
 * 这里只管「这段字怎么变明文」。
 */

export const meta = {
  title: 'ROT13（示例）',
  version: '1.0.0',
  description: '纯演示用：字母位移，不是加密。真实业务请按自己的布局与算法写。',
}

/** 打码字段。不声明的话整份参数都会在控制台上被打码 */
export const secrets = []

function shiftOne(text, n) {
  const A = 'abcdefghijklmnopqrstuvwxyz'
  return Array.from(String(text)).map((ch) => {
    const lower = ch.toLowerCase()
    const i = A.indexOf(lower)
    if (i < 0) return ch
    const moved = A[(i + ((n % 26) + 26)) % 26]
    return ch === lower ? moved : moved.toUpperCase()
  }).join('')
}

export function decrypt(text, options) {
  return shiftOne(text, optionShift(options))
}

export function encrypt(plain, options) {
  // 反向位移。没有这个函数也能用，只是 mock 的明文没法回写成密文
  return shiftOne(plain, -optionShift(options))
}

function optionShift(options) {
  const n = Number((options || {}).shift)
  return Number.isFinite(n) ? n : 13
}
