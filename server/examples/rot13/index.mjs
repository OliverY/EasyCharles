/**
 * 示例私有插件：ROT13（**不加密，只用来演示 SPI**）。
 *
 * 用法：
 *   1. cp -r server/examples/rot13 "<dataDir>/plugins/rot13"
 *   2. 控制台「加解密」页点「重新扫描插件」
 *   3. 密钥档里把插件切到 rot13，然后再点测试
 *
 * 为什么示例放在 examples/ 而不是 plugins/：`<dataDir>/plugins/` 是**运行时目录**，
 * 不在仓库里（.gitignore + 发布包白名单都排除了它）。把示例放进源码树的 plugins/
 * 会让人误以为「这里的插件会被加载」，也会让私有的东西顺手长在同一处。
 *
 * 三条约束（违反哪条都会让插件「看上去加载了、实际每次失败」）：
 *   - 默认导出就是插件对象本身（不做具名导出）；
 *   - `name` 必须与**目录名**一致（单文件版则是文件名去掉 .mjs）；
 *   - `spiVersion` 必须等于内核的 SPI 版本（当前 1），否则连 import 都不会发生。
 */

/** 配置表单：只描述标量字段，控制台据此渲染。secret: true 会变成密码框并被打码 */
const configSchema = {
  type: 'object',
  required: ['shift'],
  properties: {
    shift: {
      type: 'integer',
      title: '位移',
      description: 'ROT13 就是 13；这里做成可配只是为了演示 integer 字段',
      minimum: 1,
      maximum: 25,
      default: 13,
    },
    alphabet: {
      type: 'string',
      title: '字母表',
      enum: ['latin', 'digits'],
      default: 'latin',
    },
  },
}

const LATIN = 'abcdefghijklmnopqrstuvwxyz'
const DIGITS = '0123456789'

function rot(text, shift, alphabet) {
  const set = alphabet === 'digits' ? DIGITS : LATIN
  const n = set.length
  let out = ''
  for (const ch of text) {
    const lower = ch.toLowerCase()
    const i = set.indexOf(lower)
    if (i < 0) {
      out += ch
      continue
    }
    const mapped = set[(i + shift) % n]
    out += ch === lower ? mapped : mapped.toUpperCase()
  }
  return out
}

export default {
  spiVersion: 1,
  name: 'rot13',
  version: '1.0.0',
  title: 'ROT13（示例）',
  description: '演示 SPI 的最小实现：读参数 → 变换文本 → 返回结果。不含任何真实加密。',
  capability: { decrypt: true, encrypt: true },
  // in-process：够快，但拦不住同步死循环。第三方插件建议声明 worker（P2 落地）
  isolation: 'in-process',
  timeoutMs: 200,
  configSchema,

  setup(options, ctx) {
    // setup 抛错 = 这套参数不可用：写入口会翻成 400，读盘只丢这条
    if (!Number.isInteger(options.shift)) throw new Error('shift 必须是整数')
    if (ctx && !ctx.profileId) throw new Error('缺少 profileId')
  },

  decrypt(call) {
    return { ok: true, value: rot(call.text, call.options.shift, call.options.alphabet) }
  },

  // 往返对称，所以 encrypt 与 decrypt 实现相同。真实插件通常不对称（GCM 每次 IV 不同）
  encrypt(call) {
    return { ok: true, value: rot(call.text, call.options.shift, call.options.alphabet) }
  },
}
