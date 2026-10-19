/**
 * 插件注册表（ADR-040 决策 5 的落点：**只认内存里注册过的插件**）。
 *
 * P0 只注册内置引擎——没有目录扫描、没有热加载，所以这一层目前是「一张表 + 三道校验」。
 * 它存在的意义是把「插件从哪来」和「插件怎么被调用」隔开：P1 加扫描时，
 * 只有 `loadPlugins()` 会变，调用方一行都不用改。
 *
 * 校验三条都是**加载时拒绝**而不是运行时崩：SPI 版本、名字格式、重名。
 * 一个插件写得再好，版本对不上就必须当场拒掉——否则它会以「每次解密都失败」的形态
 * 出现在记录里，排查时没人会想到是加载阶段的问题。
 */

import { BUILTIN_PLUGIN, builtinPlugin } from './builtin.ts'
import { invalid } from './errors.ts'
import { PLUGIN_NAME_RE, SCRIPT_PREFIX, SPI_VERSION, type CryptoPlugin } from './plugin-types.ts'

/**
 * 插件对象的形状校验。**加载插件的第一步**，与「注册」分开：
 * 目录扫描时一个坏插件只该记一条 error，不能让整个扫描抛出去。
 *
 * 校验的是「内核敢不敢调用它」的最小集合：名字、SPI 版本、能力声明、表单描述、
 * 一个可调用的 `decrypt`。算法实现对不对，这里验不出来——那要靠 `setup` 与自检。
 */
export function assertPluginShape(raw: unknown): CryptoPlugin {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('插件必须以对象形式导出')
  const p = raw as CryptoPlugin
  if (typeof p.name !== 'string' || !PLUGIN_NAME_RE.test(p.name)) {
    throw invalid(`插件名不合法：${JSON.stringify(p.name)}（只允许小写字母数字与 _-，最长 40）`)
  }
  if (p.name === BUILTIN_PLUGIN) throw invalid(`插件名 ${BUILTIN_PLUGIN} 是保留名，不能由外部提供`)
  if (p.spiVersion !== SPI_VERSION) {
    throw invalid(`SPI 版本 ${String(p.spiVersion)} 与内核 ${SPI_VERSION} 不匹配，请升级 EasyCharles 或换插件版本`)
  }
  if (typeof p.version !== 'string' || !p.version) throw invalid('缺少 version')
  if (typeof p.title !== 'string' || !p.title) throw invalid('缺少 title')
  if (!p.capability || typeof p.capability.decrypt !== 'boolean') throw invalid('缺少 capability.decrypt 声明')
  if (!p.capability.decrypt) throw invalid('没有声明 decrypt 能力')
  if (typeof p.decrypt !== 'function') throw invalid('缺少 decrypt 方法')
  if (p.encrypt !== undefined && typeof p.encrypt !== 'function') throw invalid('encrypt 必须是函数')
  if (p.setup !== undefined && typeof p.setup !== 'function') throw invalid('setup 必须是函数')
  // configSchema 现在是可选的：脚本插件没有表单（参数是一份自由 JSON）。
  // 但**给了就必须合法**，否则控制台会渲染出半截表单，比没有更糟。
  const sch = p.configSchema
  if (sch !== undefined) {
    if (!sch || typeof sch !== 'object' || sch.type !== 'object') throw invalid('configSchema 必须是 { type: "object" }')
    if (!sch.properties || typeof sch.properties !== 'object' || Array.isArray(sch.properties)) {
      throw invalid('configSchema.properties 必须是对象')
    }
    if (sch.required !== undefined && !Array.isArray(sch.required)) throw invalid('configSchema.required 必须是数组')
  }
  if (p.secretFields !== undefined) {
    if (!Array.isArray(p.secretFields) || p.secretFields.some((x) => typeof x !== 'string')) {
      throw invalid('secretFields 必须是字符串数组')
    }
  }
  return p
}

export class PluginRegistry {
  private plugins = new Map<string, CryptoPlugin>()

  /**
   * 注册一个插件。
   *
   * `source='plugin'`（缺省）时**禁止占用 `builtin`**：那是保留名，被第三方顶替后
   * 所有旧配置的语义会静默改变（同一份 settings.json，换台机器解读出另一套算法）。
   *
   * `script:` 前缀与来源绑定：脚本必须带、非脚本必须不带。这样控制台看一眼名字就知道
   * 这段配置的代码是从 `plugins/` 还是 `crypto/scripts/` 来的，也避免两个来源撞名。
   */
  register(p: CryptoPlugin, source: 'builtin' | 'plugin' | 'script' = 'plugin'): void {
    if (source === 'plugin' && p.name === BUILTIN_PLUGIN) {
      throw invalid(`插件名 ${BUILTIN_PLUGIN} 是保留名，不能由外部提供`)
    }
    const isScript = p.name.startsWith(SCRIPT_PREFIX)
    if (source === 'script' && !isScript) throw invalid(`脚本插件名必须以 ${SCRIPT_PREFIX} 开头：${p.name}`)
    if (source !== 'script' && isScript) {
      throw invalid(`插件名不能以 ${SCRIPT_PREFIX} 开头：那是脚本插件的保留命名空间`)
    }
    if (!PLUGIN_NAME_RE.test(p.name)) {
      throw invalid(`插件名不合法：${JSON.stringify(p.name)}（只允许小写字母数字与 _-，最长 40）`)
    }
    if (p.spiVersion !== SPI_VERSION) {
      throw invalid(`插件 ${p.name} 的 SPI 版本是 ${p.spiVersion}，内核只支持 ${SPI_VERSION}`)
    }
    if (!p.capability?.decrypt) throw invalid(`插件 ${p.name} 没有声明 decrypt 能力`)
    if (this.plugins.has(p.name)) throw invalid(`插件名重复：${p.name}`)
    this.plugins.set(p.name, p)
  }

  get(name: string): CryptoPlugin | undefined {
    return this.plugins.get(name)
  }

  has(name: string): boolean {
    return this.plugins.has(name)
  }

  list(): CryptoPlugin[] {
    return [...this.plugins.values()]
  }

  names(): string[] {
    return [...this.plugins.keys()]
  }
}

/**
 * 全局缺省注册表：数据面（free function）与 CryptoStore 都指向它，
 * 所以「store 里能解的」和「记录里真去解的」一定是同一套插件。
 * 注入自定义注册表只用于测试；此时调用方必须自己把同一个实例传给 `decryptWith` 等。
 */
export const defaultRegistry = new PluginRegistry()
defaultRegistry.register(builtinPlugin, 'builtin')
