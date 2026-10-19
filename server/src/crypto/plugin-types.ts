/**
 * 加解密插件 SPI（ADR-040）。
 *
 * 公开仓库里只留这份**契约**和一个通用引擎（`builtin`）。业务侧自己的变形
 * （布局、派生、多段拼接）实现同一个接口，有两种来源：
 *
 * - **目录插件** `<dataDir>/plugins/<name>/`：`manifest.json` + `index.mjs`，
 *   自带 `configSchema`，控制台渲染成表单；
 * - **单文件脚本** `<dataDir>/crypto/scripts/<name>.mjs`：只写 `decrypt`/`encrypt`，
 *   没有 schema，参数是一份自由 JSON。业务变形用第二种最省事——见 `script.ts`。
 *
 * 两者都不进 git、也不进发布包。
 *
 * 三条边界，改之前先读：
 *
 * 1. **入参与出参都是 string。** 内核负责「密文在哪」（wrap / prefix），插件负责
 *    「这段字怎么变明文」（布局 + 编码 + 算法）。布局属于业务知识，内核不猜。
 * 2. **插件拿不到请求上下文。** 只有 `profileId` 与显式声明的 header 白名单。
 *    能看全部流量的插件不再是「字节变换函数」，而是数据外泄与按身份做手脚的后门。
 * 3. **失败一律返回 `{ ok:false }`，不要 throw 业务错误。** 抛出只允许发生在 `setup`，
 *    表示「这套配置不可用」（写入时变 400）。运行期抛出会被内核兜住并降级为原文。
 *
 * 关于异步：P0 的调用链是同步的（内存里改记录，不碰 I/O），所以插件也按同步写。
 * 返回 Promise 会在 P0 被执行层拒绝并记 `crypto.error`；P2 接 worker 时同一个签名
 * 直接支持异步，**同步插件一行都不用改**。
 */

/** SPI 版本。内核只接受自己认识的主版本，升级时靠它拒绝加载而不是运行时崩 */
export const SPI_VERSION = 1

/**
 * 插件参数。**故意是 unknown 值**：`builtin` 的 `aead{ivBytes,tagBytes,tagAt}`
 * 是一组描述密文布局的结构，硬压成标量反而要拆成 `aead_ivBytes` 这种更差的写法。
 * P1 的 `configSchema` 只覆盖标量字段，嵌套结构由插件自己的 `setup` 兜住。
 */
export type PluginOptions = Readonly<Record<string, unknown>>

/**
 * 每次调用带上的上下文。**只有两项**，理由见文件头第 2 条。
 *
 * 注意这里**没有** `direction: 'request' | 'response'`：插件不需要知道这份密文来自
 * 请求还是响应——它只做一次字节变换。知道得越多，越容易被写成「只在请求方向生效」
 * 这种内核看不见的业务分支。
 */
export interface PluginContext {
  /** 仅用于日志与打点，插件不应依赖它分支 */
  profileId: string
  /** 显式声明的 header 白名单（P1 由 profile 声明，≤8 个、值截断 256 字符）；P0 恒为空 */
  headers: Readonly<Record<string, string>>
}

/** 插件收到的一次调用。`text` 是**已剥离 prefix** 的密文串（加密方向是明文串） */
export interface PluginCall {
  text: string
  options: PluginOptions
  ctx: PluginContext
}

export type PluginResult<T> = { ok: true; value: T } | { ok: false; error: string }

/**
 * 配置表单描述（JSON Schema 的标量子集）。
 *
 * 用途只有两个：控制台据此渲染表单、写入时据此做结构校验。
 * **它不是安全边界**——真正的边界是「谁能把文件拷进 dataDir」。
 */
export interface PluginConfigSchema {
  type: 'object'
  required?: string[]
  properties: Record<
    string,
    {
      type: 'string' | 'integer' | 'number' | 'boolean'
      title?: string
      description?: string
      /** 前端渲染成密码框；GET 下发时打码；PUT 回写 `••••` 表示沿用 */
      secret?: boolean
      enum?: (string | number)[]
      default?: string | number | boolean
      minimum?: number
      maximum?: number
    }
  >
}

export interface CryptoPlugin {
  /** 内核只认识 SPI_VERSION；对不上就拒绝加载，而不是让它跑起来再崩 */
  spiVersion: number
  /** `[a-z0-9][a-z0-9_-]{0,39}`，全局唯一；`builtin` 是保留名 */
  name: string
  version: string
  /** 控制台显示名 */
  title: string
  description?: string

  /** 能力声明：没声明 encrypt 的插件不能用于 mock 回写 */
  capability: { decrypt: boolean; encrypt: boolean }

  /** `in-process`（快，但拦不住同步死循环）| `worker`（可中断、可限内存）。缺省 in-process */
  isolation?: 'in-process' | 'worker'

  /** 单次调用超时，缺省 500ms。解密是热路径，超了就该失败而不是拖住请求 */
  timeoutMs?: number

  /**
   * 配置表单描述。**脚本插件（`script:`）没有它**——参数由脚本自己解释，
   * 控制台退化成一块 JSON 文本域。有 schema 的插件才渲染表单。
   */
  configSchema?: PluginConfigSchema

  /**
   * 无 `configSchema` 时，靠它决定 `options` 里哪些字段要打码。
   *
   * 为什么不能「猜」：键名叫 `k` 的也可能是密钥。猜错一次就是密钥明文出现在页面上。
   * 不声明则**整份 options 都打码**（保守优先）。
   */
  secretFields?: string[]

  /**
   * 每个 profile 调一次，**只做校验**：抛错 = 该 profile 的参数不可用
   * （写入口翻成 400，读盘时只丢这一条）。
   *
   * 注意：P1 **不按 profile 缓存实例**，一个模块对象被所有引用它的 profile 共用，
   * 参数每次调用都通过 `PluginCall.options` 传入。所以**不要在 `this` 上保存
   * per-profile 的状态**（比如「当前 key」）——后一个 profile 会把它覆盖掉，
   * 症状是「只有最后一个档能解开」，极难查。要缓存就按 options 做键。
   */
  setup?(options: PluginOptions, ctx: { profileId: string }): void

  decrypt(call: PluginCall): PluginResult<string> | Promise<PluginResult<string>>
  encrypt?(call: PluginCall): PluginResult<string> | Promise<PluginResult<string>>

  /** 「这套配置在这台机器上到底通不通」，供控制台的测试按钮（P1 接） */
  selftest?(options: PluginOptions, sample?: string): PluginResult<string> | Promise<PluginResult<string>>

  dispose?(): void
}

/**
 * 插件名格式。`builtin` 能通过格式校验，但**不允许外部注册**（见 registry）。
 *
 * `script:` 是脚本插件的保留命名空间：`<dataDir>/crypto/scripts/myapp.mjs` 注册成
 * `script:myapp`。带前缀是为了让「这段配置依赖哪个来源的代码」在控制台上直接可读——
 * 目录插件与脚本撞名时也不会互相顶替。
 */
export const PLUGIN_NAME_RE = /^(?:script:)?[a-z0-9][a-z0-9_-]{0,39}$/

/** 脚本插件的名字前缀（保留） */
export const SCRIPT_PREFIX = 'script:'

/** 脚本文件名本身（不含 `script:` 前缀），用于文件系统操作 */
export const SCRIPT_FILE_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/
