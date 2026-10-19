/**
 * 加解密模块的对外门面（协议 §5.6 / ADR-039 / ADR-040）。
 *
 * 目录结构与边界：
 * ```
 * crypto/
 *   index.ts         ← 本文件：只做再导出，没有逻辑
 *   plugin-types.ts  SPI 契约（公开）
 *   builtin.ts       内置引擎：一个走同一条 SPI 的普通插件（公开）
 *   registry.ts      插件注册表（形状校验 + 保留名 + SPI 版本）
 *   loader.ts        `<dataDir>/plugins/` 扫描与加载（P1）
 *   manager.ts       扫描结果 ↔ 注册表，含试跑（P1）
 *   schema.ts        插件参数的 schema 校验与打码（P1）
 *   wrap.ts          密文在哪：raw/json/form + prefix + query（Core）
 *   encoding.ts      base64 / base64url / hex / utf8（Core）
 *   profile.ts       密钥档与路由的归一化、匹配语法（Core）
 *   transform.ts     门面：extractCipher → plugin.decrypt → 明文
 *   store.ts         唯一真值来源（含打码视图与 PUT 写入口）
 * ```
 *
 * 两件必须分开看的事：
 *
 * 1. **解密只影响记录，不影响转发。** App→上游的请求体、上游→App 的响应体都原样透传，
 *    解密结果只写进 `EcRecord` 供控制台展示。所以解密失败绝不能阻断请求，
 *    也不该让 SDK 看到任何差异（fail-open 的另一面）。
 * 2. **密钥与规则分开存。** 规则里只写 `profileId`，key/iv 只在
 *    `.data/crypto/settings.json`（已 gitignore）。规则会被导出、分享、截图，
 *    密钥是全局资产——混在一起就等于「分享一套 mock 规则 = 泄露线上密钥」。
 *
 * 「怎么解密」是第三件事：它归插件，公开仓库只留内置引擎，业务变形放
 * `<dataDir>/plugins/`（ADR-040）。
 */

export { bad, invalid, type Fail, type Ok } from './errors.ts'
export { CRYPTO_MASK, CryptoStore, type CryptoMatch } from './store.ts'
export { decryptForRecord, decryptQuery, decryptWith, encryptWith, type RawHeaderMap } from './transform.ts'
export { extractCipher } from './wrap.ts'
export { BUILTIN_PLUGIN, builtinPlugin, type BuiltinFields } from './builtin.ts'
export { defaultRegistry, PluginRegistry } from './registry.ts'
export { PluginManager, type PluginView, type PluginReloadResult } from './manager.ts'
export { scanPlugins, type PluginEntry, type ScanResult } from './loader.ts'
export { scanScripts, readScriptSource, type ScriptEntry, type ScriptScanResult } from './script.ts'
export { normalizeOptions, maskOptions } from './schema.ts'
export {
  SPI_VERSION,
  SCRIPT_PREFIX,
  PLUGIN_NAME_RE,
  type CryptoPlugin,
  type PluginCall,
  type PluginContext,
  type PluginResult,
} from './plugin-types.ts'
