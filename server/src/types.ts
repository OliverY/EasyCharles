export const PROTOCOL_VERSION = 2

export type RecordMode = 'full' | 'meta' | 'sample'
export type SeqMode = 'in-order' | 'loop' | 'once-then-passthrough' | 'random'

/** 设备身份：SDK 自动采集 + 业务注入。见 docs/protocol.md §5.1 */
export interface DeviceIdentity {
  deviceId: string
  sessionId: string
  os?: string
  osVersion?: string
  brand?: string
  manufacturer?: string
  model?: string
  marketName?: string
  deviceName?: string | null
  /** 客户端上报的可读设备名（第三方客户端兼容路径会用到） */
  displayName?: string | null
  appId?: string
  appVersion?: string
  appVersionCode?: number
  sdkVersion?: string
  processName?: string
  env?: string
  userId?: string | null
  userName?: string | null
  tags?: string[]
  createdAt?: number
  updatedAt?: number
}

export interface Headers {
  [name: string]: string
}

export interface MessagePart {
  method?: string
  url?: string
  host?: string
  path?: string
  query?: Record<string, string>
  /**
   * query 里的密文参数解出来的明文（协议 §5.6 / ADR-039 增补）。
   *
   * 为什么另开一个字段而不是直接覆盖 `query`：`query` 是**线上真正发出去的那份**，
   * 和 `rawBody` 一样要能复查；直接覆盖就再也看不出 App 到底发了什么。
   * 能解析成 `k=v&k=v` 时展开成多项，否则原样放在密文参数的键下。
   */
  queryPlain?: Record<string, string>
  status?: number
  headers: Headers
  body: string
  bodyEncoding: 'utf8' | 'base64'
  bodySize: number
  bodyTruncated: boolean
  rawBody?: string | null
}

/**
 * 单侧（请求 / 响应）的加解密元信息（协议 §5.6 / ADR-039）。
 *
 * 只描述「这次处理发生了什么」，**不含密钥、不含算法参数** —— 密钥永远不下发。
 * 解密失败时记录里保留的是**原始密文**，`decrypted=false` + `error` 让控制台能说清
 * 「为什么这一条看起来是乱码」，而不是让用户以为解密规则没配。
 */
export interface CryptoPartMeta {
  /** 命中的密钥档 id（`p_xxx`）；档被删除后仍保留在历史记录里，便于回溯 */
  profileId: string
  /** 是否成功解出明文并写进了 `body` */
  decrypted: boolean
  /** mock 回写是否成功加密（只有 mock 响应会有） */
  encrypted?: boolean
  /** 失败原因，中文短语，仅用于控制台展示；成功时不存在 */
  error?: string
  /**
   * 命中的是哪个参数（只有 query 方向会带）。
   * 控制台据此把「密文参数那一行」替换成解密后的各项，而不是两行并排让人以为发了两次。
   */
  field?: string
}

export interface CryptoMeta {
  /** 请求体（body）方向 */
  request?: CryptoPartMeta
  /** 响应体方向 */
  response?: CryptoPartMeta
  /** 请求 query 里的密文参数（与 `request` 分开：两者可能只成功一个） */
  query?: CryptoPartMeta
}

export interface EcRecord {
  id: string
  seq: number
  deviceId: string
  sessionId: string
  startedAt: number
  durationMs: number
  request: MessagePart
  response: MessagePart
  upstream: { ms: number; protocol: string; error: string | null }
  flags: { mocked: boolean; decrypted: boolean; streamed: boolean; redirected: boolean }
  /** 加解密元信息；没命中加解密规则时字段不存在（存量记录零迁移） */
  crypto?: CryptoMeta
}

/**
 * 密文在 body 里的位置（协议 §5.6）。
 *
 * 为什么需要这一层：真实业务的加密接口很少是「整个 body 就是一段密文」，
 * 更常见的是 `{"data":"<base64>"}` 或 `data=<base64>`。只支持 raw 会让绝大多数
 * 接口配不上，而让用户自己写脚本又违背 ADR-011「表单化优先」。
 *
 * `prefix` 描述密文串自带的固定前缀（如 `ciphertext:`）。**它与 wrap 正交**：
 * 前缀是「这段字符串长什么样」的一部分，`{"data":"ciphertext:..."}` 也真实存在。
 * 解密时剥掉、mock 加密回写时补回，两边都不知道前缀就不会出现「mock 出去的数据 App 解不开」。
 */
export type CryptoWrap =
  | { type: 'raw'; prefix?: string }
  | { type: 'json'; field: string; prefix?: string }
  /** `template` 仅加密方向生效：用 `{{cipher}}` 占位还原外层。缺省为 `{"<field>":"{{cipher}}"}` */
  | { type: 'form'; field: string; prefix?: string }

/**
 * query 里那一个密文参数（`?payload=<base64>`）。
 *
 * 单独定义而不是复用 CryptoWrap：query 里只有「按字段名取一个串」这一种形态，
 * 让它去表态 `raw` / `json` 纯属噪音，且 `raw` 在 query 上根本没有对应物。
 */
export interface CryptoQueryWrap {
  field: string
  prefix?: string
}

/**
 * AEAD（GCM / Poly1305）的密文布局。
 *
 * 与 CBC 这类「IV 写在配置里」的算法根本不同：AEAD 的 IV 随每次加密随机生成、
 * 拼在密文里，认证标签（tag）也要在解密前 `setAuthTag`。所以它需要一条**布局描述**，
 * 而不是一个 `iv` 字段。三件事必须同时说清：IV 多长、标签多长、标签在头还是在尾。
 *
 * 只支持「IV 前缀 + 标签在尾/头」这一族布局（`iv|ct|tag` / `iv|tag|ct`），
 * 这覆盖了 Node `aes-*-gcm`、`chacha20-poly1305` 以及绝大多数 App 自研封装的写法。
 * 把 IV 单独放在别的字段里的场景属于 wrap 的职责，不在这里。
 */
export interface CryptoAead {
  /** 密文前缀里 IV 的字节数（GCM 通常 12） */
  ivBytes: number
  /** 认证标签字节数（GCM/Poly1305 通常 16） */
  tagBytes: number
  /**
   * 标签位置。`end` = `iv|ct|tag`（WebCrypto / Java `Cipher.doFinal` 的常见拼法），
   * `start` = `iv|tag|ct`（部分自研封装）。
   */
  tagAt: 'end' | 'start'
  /** 关联数据（AAD），utf8 字面量；加密与解密必须完全一致 */
  aad?: string
}

/** 密文编码。`base64url` 是 URL-safe 变体（`-` `_` 替代 `+` `/`），常见于 Web 端与部分 App */
export type CryptoEncoding = 'base64' | 'base64url' | 'hex'
/**
 * 密钥编码。`base64url` 单列出来的原因很实际：Java 的 `Base64.getUrlEncoder()` 与
 * `.getEncoder()` 产出不同字符集，而 Node 的 `Buffer.from(x,'base64')` 会**静默丢掉**
 * `-` `_`，于是 32 字节密钥变成 30 字节、报「Invalid key length」——一条与密钥本身无关的错。
 */
export type CryptoKeyEncoding = 'utf8' | 'base64' | 'base64url' | 'hex'

/**
 * 一个密钥档（协议 §5.6 / ADR-039）。
 *
 * **密钥只存在 `.data/crypto/settings.json`（已 gitignore），不进仓库、不进规则**。
 * 规则侧只引用 `profileId`，所以规则导出 / 分享 / 截图都不会带出密钥。
 */
export interface CryptoProfile {
  /** `p_<base36 时间><4 位随机>`，服务端生成 */
  id: string
  name: string
  /**
   * 用哪个插件做加解密（ADR-040）。缺省 `builtin`，且**不写回磁盘**——
   * 于是 settings.json 与 ADR-039 时期逐字节一致，旧配置零迁移。
   *
   * `builtin` 是保留名：内置引擎也是一个走同一 SPI 的普通插件，
   * 业务自己的变形（布局、派生、多段拼接）注册成别的名字，代码不进这个仓库。
   */
  plugin: string
  /**
   * 私有插件的参数（`plugin !== 'builtin'` 时使用）。
   *
   * 为什么内置引擎不用它：内置引擎的字段是**扁平**的（`alg` / `key` / `aead`…），
   * 直接写进 profile 才能让 settings.json 与 ADR-039 时期逐字节一致（零迁移）。
   * 私有插件没有历史包袱，统一走 `options`，键名与校验规则由插件的 `configSchema` 定义。
   *
   * **出现 `options` 就不允许再出现扁平算法字段**，反之亦然——两套配置并存时
   * 出问题无法判断哪套生效（ADR-040 决策 3）。
   */
  options?: Record<string, unknown>
  /**
   * 允许插件读取的 header 白名单（形状与 SPI 的 `PluginContext` 一致）。
   *
   * 默认不配 = 插件拿不到任何 header。**不给完整上下文是设计**：能看全部流量的插件
   * 就不再是「字节变换函数」，而是数据外泄与按身份做手脚的后门（ADR-040 决策 6）。
   */
  pluginContext?: CryptoPluginContext
  /** ── 以下扁平字段只属于内置引擎（`plugin: 'builtin'`）── */
  /** Node `crypto.createCipheriv` 的算法名，如 `aes-128-cbc` / `aes-256-ecb` */
  alg?: string
  /** 密钥原文，按 `keyEncoding` 解码后使用 */
  key?: string
  keyEncoding?: CryptoKeyEncoding
  /** ECB 模式必须不填；CBC/CTR 等必填；AEAD 模式由密文自带 IV，同样不填 */
  iv?: string
  ivEncoding?: CryptoKeyEncoding
  /** AEAD 算法的密文布局；非 AEAD 算法填了也会被忽略（写入时按 alg 校验） */
  aead?: CryptoAead
  /** 密文的字符编码 */
  cipherEncoding?: CryptoEncoding
  /** `false` = 不做 PKCS#7 padding（密文长度已对齐时使用） */
  autoPadding?: boolean
  /** 请求体的密文位置，缺省 `{type:'raw'}` */
  request: CryptoWrap
  /** 响应体的密文位置，缺省 `{type:'raw'}` */
  response: CryptoWrap
  /** mock 明文回写时套的壳，缺省与 `response` 相同 */
  encrypt: CryptoWrap
  /** 请求 query 里的密文参数（`?payload=...`），缺省不处理 query */
  query?: CryptoQueryWrap
}

/** 插件上下文（协议 §5.6.4）：只有显式声明的 header 才拿得到 */
export interface CryptoPluginContext {
  /** 名字不区分大小写，最多 8 个；值截断到 256 字符 */
  headers: string[]
}

/** 一条「哪些接口要加解密」的匹配规则，与 mock 规则完全解耦（只看不 mock 也要能解密） */
export interface CryptoRoute {
  id: string
  name?: string
  enabled: boolean
  /** 引用 `CryptoProfile.id`；指向不存在的档 = 该条永不生效（加载时告警） */
  profileId: string
  /** 与规则引擎同一套通配语法；host 同时按「带端口」和「不带端口」各试一次 */
  match: { method?: string; host?: string; path?: string }
  /** 解密方向开关，缺省都为 true */
  request: boolean
  response: boolean
}

/** `GET /__ec/api/crypto` 下发视图：profile 里的 key / iv 一律打码 */
export interface CryptoProfileView extends Omit<CryptoProfile, 'key' | 'iv'> {
  /** 打码后的 key；提交回写时原样带回表示「不修改」 */
  key: string
  iv?: string
  /** 该档当前被多少条路由引用，删除前提示用 */
  routeCount: number
}
export interface CryptoView {
  enabled: boolean
  profiles: CryptoProfileView[]
  routes: CryptoRoute[]
}

export interface MockResponse {
  status: number
  headers?: Headers
  body: string
  /** 备注名，仅供控制台区分多条返回值（服务端不参与匹配、不下发给 SDK） */
  name?: string
  /**
   * 这一条返回值的命中条件（C12）。**本期只存不用**：服务端原样读写、不参与选路，
   * 真实按条件选路随 roadmap P6 的 P4 落地。
   *
   * 为什么要先占位：mock CLI 的四条并行数组要把条件写进规则，若服务端不存，
   * 「提交后读回核对」核对的就是一个已被抹平的东西（协议 §5.4 / ADR-028）。
   */
  cond?: { query?: string; content?: string }
}

export interface Rule {
  id: string
  name?: string
  enabled: boolean
  priority: number
  /**
   * 所属项目（协议 §5.5 / ADR-030）。**可选，缺失 = 未分组**，存量规则零迁移。
   * 生效条件是一条 AND：`rule.enabled` 且（没有 `groupId`，或该分组存在且 `enabled`）。
   * 关组**不改写**组内规则的 `enabled`，重开即恢复原状。
   *
   * ⚠ **C14（ADR-033）会翻转下面这句**：悬空 id / 无 `groupId` 现在按「未分组照常命中」，
   * 但数据面候选集收窄到「owner 的私有项目」之后，**无归属就等于永不命中**（协议 §5.4）。
   * 翻转的两个前置硬约束 —— 迁移不得留下无归属规则、控制台必须显示归属项目 —— 缺一条
   * 就变成「控制台显示已启用、实际什么都不 mock」的静默失效。改 `rules.ts` 之前先读那一节。
   */
  groupId?: string
  /**
   * 匹配条件：全部满足才算命中，未配置的条件视为通配。
   * `params` 按「请求入参」匹配（query + body 合并，同名以 body 为准），
   * 语义见 docs/protocol.md §5.4 与 ADR-016。
   */
  match: { method?: string; host?: string; path?: string; params?: Record<string, string> }
  action: {
    type: 'mock' | 'passthrough'
    /**
     * 命中后 mock 的明文是否需要**加密回写**（协议 §5.6 / ADR-011）。
     *
     * 只存 `profileId`，**绝不存 key**：规则会被导出、分享、截图，而密钥是全局资产。
     * 引用不存在的档时按「不加密」处理（宁可 mock 失效也不要把明文直接吐给 App）。
     */
    crypto?: { profileId: string }
    /**
     * 命中方式（协议 §5.4）：
     * - `static`（缺省）→ 固定返回 `action.response`（单条，旧形态）
     * - `sequence` → 按 `seqMode` 在 `responses` 里推进（指针按 deviceId 隔离，ADR-004）
     * - `specific` → 固定返回 `responses[pinIndex]`（多条中指定一条）
     */
    mode?: 'static' | 'sequence' | 'specific'
    seqMode?: SeqMode
    /** 仅 `mode === 'specific'` 生效：指定返回 `responses` 中第几条（下标；越界由服务端 clamp） */
    pinIndex?: number
    response?: MockResponse
    responses?: MockResponse[]
    delayMs?: number
  }
}

/**
 * 分组 / 项目（协议 §5.5）：规则的容器，**不是租户**。
 *
 * C13（ADR-030）时它是全局分组：所有人看到同一批组、组内规则全局生效。
 * C14（ADR-033）把同一容器分成两档 —— `private` 属于一个手机号空间并参与命中，
 * `shared` 是本实例全体登录用户的**只读模板**，**永不直接命中**（要用必须先 copy）。
 *
 * **没有新增实体**：项目就是 `Group`，同一张 `groups.json`、同一批 `/__ec/api/groups*` 路由。
 * C14 新增的字段**全部是服务端字段**（见 `GROUP_SERVER_FIELDS`），客户端提交即 400；
 * 它们都是**可选**的，因为存量 `groups.json` 里没有这些字段，读路径必须能兜住（协议 §5.5）。
 */
export interface Group {
  /** 服务端生成：`g_<base36 时间><4 位随机>`，与控制台的 `r_` 同风格 */
  id: string
  /** 展示名，非空且不要求唯一（「登录」这种名字撞车是常态，定位只按 id） */
  name: string
  /** 整组开关；`false` = 本组规则一律不参与命中（协议 §5.4 的那条 AND） */
  enabled: boolean
  createdAt: number
  updatedAt: number

  /**
   * 归属档位（C14）。**读路径：缺失或不是这两个字符串之一 → 按 `shared` 处理**，
   * 宁可让这条不参与命中，也不要因为一个脏值把别人的私有规则放进候选集（协议 §5.5）。
   * 写路径由服务端**显式落盘**，不依赖缺省值 —— 只有迁移来的旧数据才是「不带 scope」。
   */
  scope?: ProjectScope
  /**
   * private 恒为创建人手机号（**从会话推导，绝不取请求体**）；shared 恒为 `null`。
   * 读路径：非字符串或空串 → `null` ⇒ 无 owner ⇒ 该项目不参与命中。
   */
  ownerPhone?: string | null
  /** 首次创建 / 发布人；迁移来的历史项目为 `null`，UI 显示「历史项目 / 创建人未知」，**不伪造** */
  createdBy?: string | null
  /** 仅 shared：当前内容对应的那个历史版本（`ProjectVersion.id`）；非法值不影响命中 */
  currentVersionId?: string
  /**
   * 仅 private：来源共享项目。两种情况会建立它 —— 从共享库 copy 出来的副本，
   * 以及首次 share 之后（私有原件保留，靠这根指针做「整项目覆盖」而不是新建一份共享）
   */
  originSharedProjectId?: string
  /**
   * 仅 copy 得到的 private：共享规则 id ⇄ 本地规则 id 的稳定映射。
   * 只用于「覆盖时还原原共享 id」与规则追踪，**不用于三方冲突检测**（C14 明确不做合并）。
   * 非数组按空映射处理。落在这里而不是独立表，是因为映射与项目分两处写必然漂移（协议 §5.5）
   */
  lineage?: ProjectLineageEntry[]
  /** 仅 copy 得到的 private：复制时源的共享项目版本，用于展示「你复制的是哪一版」 */
  copiedFromVersionId?: string
  /**
   * 归档标记。shared 有历史版本时**不做物理删除**，只归档，且归档不删快照与分享记录；
   * 归档后仍不参与命中（它本来就不参与）
   */
  archived?: boolean
  /**
   * 仅 shared：**软删除（待删除）**的发起时间，服务器时钟（ADR-037）。
   *
   * 为什么要这一档：共享项目一旦有历史版本，物理删除就等于把别人的回退点也抹掉，
   * 而「归档」又只是打个标记、谁都能继续覆盖它。折中做法是「删除先挂 7 天」——
   * 这 7 天里项目、规则、历史全都原样在，任何人 `restore` 就恢复原状；
   * 到期仍无人恢复才真删。**规则与快照在待删除期间一条都不动**，否则「恢复」就是假的。
   *
   * 与 `archived` 的区别：归档 = 长期保留但标记停用；待删除 = 有倒计时的删除意图。
   * 两者可以同时存在，到期时以 `purgeAt` 为准。
   */
  pendingDeleteAt?: number
  /**
   * 仅 shared：真正删除的时刻 = `pendingDeleteAt` + 7 天（`SHARED_TRASH_MS`）。
   *
   * 为什么要落盘而不是每次现算：① 控制台要显示「还剩 N 天」而不必知道 TTL；
   * ② 万一以后 TTL 改成别的数，**已发起的删除仍按当时承诺的时刻执行**，不会因为改了配置
   * 而让某些项目的倒计时突然变长或变短（倒计时不能被人为延长，否则反复点删除就永不删除）。
   */
  purgeAt?: number
}

/** 项目归属档位（协议 §5.5 / ADR-033） */
export type ProjectScope = 'private' | 'shared'

/**
 * 一条共享规则与它在本私有副本里对应规则 id 的配对（协议 §5.5 的 `lineage` 元素）。
 * 交接计划 §3.2 把它写成独立表 `ProjectLineage`；契约收进了项目对象自身，字段语义不变。
 */
export interface ProjectLineageEntry {
  sharedRuleId: string
  privateRuleId: string
}

/** 一次共享项目内容提交的类型（协议 §5.5），事件顺序不可修改 */
export type ProjectVersionOperation = 'publish' | 'share' | 'rollback'

/**
 * 共享项目的不可变历史版本（协议 §5.5 / ADR-033 决策 4）。
 * 每次成功 publish / share / rollback 追加一条，**默认全部保留、不静默清理** ——
 * 用户要的是「任意历史都能回退」，自动过期会直接废掉这个承诺（磁盘代价与报告口径见架构 §6.3）。
 */
export interface ProjectVersion {
  id: string
  /** 所属**共享**项目 id */
  projectId: string
  /** 事件链的前一条；首版为 `null`。链用来排序，不用于合并 */
  parentVersionId: string | null
  operation: ProjectVersionOperation
  /** 操作人手机号，服务端从会话取；下发前脱敏（协议 §7 第 11 条） */
  actorPhone: string
  /** 服务端时间，客户端不得自造分享时间 */
  createdAt: number
  /** 仅 `operation === 'rollback'`：本次回退选中的那个版本 */
  rollbackOf?: string
  /** 该版本的规则数，历史列表用（不必为了显示条数去读完整快照） */
  ruleCount: number
  /**
   * 完整快照的**内部相对路径**（相对 `dataDir`，见架构 §6.3）。
   * 快照内容 = 该次分享时完整的共享项目定义 + 全部规则与返回值，回退要能逐字段还原。
   * **永不下发客户端**
   */
  snapshotFile: string
}

/** 管理面下发的版本条目：去掉内部路径（协议 §4.7 `versions` 只回元数据） */
export type ProjectVersionView = Omit<ProjectVersion, 'snapshotFile'>

/** `.data/projects/index.json` 的形状：projectId → 该项目全部版本（按发生顺序追加，不改写） */
export type ProjectHistoryIndex = Record<string, ProjectVersion[]>

/**
 * 客户端**允许**提交的项目字段（协议 §4.7）。
 * 新建 / 改名 / 开关只需要这两项；其余全部由服务端从会话与服务器时钟推导。
 */
export type GroupClientInput = Pick<Group, 'name' | 'enabled'>

/**
 * 服务端管理的项目字段名单（协议 §5.5「归属字段只能由服务端写」）。
 *
 * **只用在项目的写入口**（`POST /groups`、`PUT /groups/:id`、`/groups/:id/enabled`）：
 * 提交里出现这些字段一律 `400 EC_SCOPE_MISMATCH`，**不是静默忽略** —— 忽略了客户端会以为
 * 改动生效了，而「谁拥有这个项目」恰恰是最不能由调用方定义的一项（ADR-033 决策 5）。
 * `id` 与时间戳不在此列，它们已有各自的 400 / 服务端覆盖口径（协议 §4.7）。
 *
 * 规则的写入是**另一道栅栏**，别混为一谈：规则提交时要查的是「`groupId` 指向的是不是我的
 * 私有项目」（§4.7 的 `EC_SCOPE_MISMATCH` 那条），不是「规则里能不能带这些字段」。
 * 两道栅栏都得装在**每一个**写入口上 —— 新开一门却忘了装栅栏，就是 F-15 那类事故的入口（AGENTS.md §4）。
 */
export const GROUP_SERVER_FIELDS = [
  'scope',
  'ownerPhone',
  'createdBy',
  'currentVersionId',
  'originSharedProjectId',
  'lineage',
  'copiedFromVersionId',
  'archived',
  // 软删除的两个时间戳（ADR-037）：让客户端能写 `purgeAt` 就等于让任何人**跳过 7 天**
  // 直接把别人的共享项目删掉，或者反过来把它续到无限远。恢复只能走 /groups/:id/restore
  'pendingDeleteAt',
  'purgeAt',
] as const

export type GroupServerField = (typeof GROUP_SERVER_FIELDS)[number]

/** `GET /__ec/api/groups` 的视图：分组 + 当前挂在它下面的规则数 */
export interface GroupView extends Group {
  ruleCount: number
}

export interface WsEnvelope {
  v: number
  type: string
  id?: string
  payload?: unknown
}

/** 控制台用户（手机号注册即空间），与业务登录态无关 */
export interface User {
  phone: string
  createdAt: number
  lastLoginAt: number
  /** 上次显式绑定的设备 id，供 CLI 的 current 查询 */
  lastBoundDeviceId: string | null
}

/**
 * 控制台角色（ADR-018）：`admin` 管理员 / `user` 普通使用者（默认）。
 * **由启动参数 `--admin` 决定，不落盘、不兜底**——未配置时没有任何管理员。
 */
export type UserRole = 'admin' | 'user'

/**
 * 下发给控制台的用户对象 = `User` + 角色。
 * 角色是**读取时**按 `Config.adminPhones` 算出来的，不是 `User` 的持久字段
 * （避免出现「配置改了、库里还留着旧角色」的第二真值来源）。
 */
export interface ConsoleUser extends User {
  role: UserRole
}

/** 设备视图：`DeviceIdentity` + 服务端运行时字段（在线状态与归属） */
export interface DeviceView extends DeviceIdentity {
  key: string
  lastSeenAt: number
  online: boolean
  /** 绑定的控制台用户（手机号），null = 未绑定（任何人可认领） */
  owner: string | null
}

/** 管理员接口里的单个用户空间摘要（ADR-018） */
export interface SpaceSummary {
  phone: string
  createdAt: number
  lastLoginAt: number
  /** 该空间绑定的设备数 */
  devices: number
  /** 其中在线数 */
  online: number
  /** 该空间可见的记录数 */
  records: number
}

/**
 * 现场快照（ADR-017）：把一条记录冻结成**免鉴权可分享**的只读副本。
 *
 * 与记录的关系是「拷贝」而非「引用」：源记录被内存环形缓冲淘汰、或服务重启后，
 * 分享出去的链接依然打得开——这正是「排查问题」场景要的语义。
 */
export interface Snapshot {
  /** 能力 token：128 位随机（32 hex），同时作为主键与落盘文件名；不可枚举 */
  token: string
  /** 创建者手机号；**仅管理面可见**，不出现在免鉴权的快照页（避免把手机号带出去） */
  createdBy: string
  createdAt: number
  /** 过期时间戳；`null` = 永不过期（`--snapshot-ttl 0`） */
  expiresAt: number | null
  /** 展示用标题，默认取 `METHOD path` */
  title: string
  /** 冻结的记录副本 */
  record: EcRecord
}

/** 管理面列表用的摘要（不含 body，避免列表响应被大 body 撑爆） */
export interface SnapshotMeta {
  token: string
  createdAt: number
  expiresAt: number | null
  title: string
  method: string
  url: string
  status: number
}

/**
 * 第三方客户端兼容层（**默认关闭**，不属于 EasyCharles 协议契约）。
 *
 * 有些抓包/代理客户端会把请求改写到本地服务，并把真实目标放在自定义请求头里，
 * 这套约定与 EasyCharles SDK 协议不同。为避免把任何具体客户端的内网协议常量
 * 固化进仓库，路由前缀与头名全部由命令行参数注入；不配置就完全不存在该能力。
 */
export interface CompatConfig {
  /** 额外挂载为数据面的路由前缀（如 /proxy）；为空数组 = 关闭兼容层 */
  routes: string[]
  /** 承载真实目标 URL 的请求头名（小写） */
  targetHeader: string
  /** 客户端上报设备展示名的请求头名（小写） */
  deviceNameHeader: string
  /**
   * 客户端上报**每安装唯一 ID** 的请求头名（小写）。
   * 有它就能把「同一账号的两台手机」分成两行；缺失时服务端退回 `userId@展示名`（ADR-032）。
   */
  deviceIdHeader: string
  /** 客户端上报稳定用户 ID 的请求头名（小写），用于设备去重 */
  userIdHeader: string
  /** 客户端上报用户名的请求头名（小写） */
  userNameHeader: string
  /** 非 SDK 客户端在控制台显示的 appId */
  appId: string
}

export interface Config {
  port: number
  host: string
  lanMode: boolean
  /** 控制台登录口令（默认 123456，--password 可改） */
  password: string
  /**
   * 管理员手机号白名单（`--admin a,b`）。**空数组 = 没有管理员**，
   * 管理面 `/__ec/api/admin/*` 一律 403（ADR-018）。
   */
  adminPhones: string[]
  recordMode: RecordMode
  maxBufferBytes: number
  sampleBytes: number
  heartbeatMs: number
  maxRecords: number
  upstreamTimeoutMs: number
  /** 快照有效期（毫秒）；`0` = 永不过期（`--snapshot-ttl 0`） */
  snapshotTtlMs: number
  /** 快照数量上限，超出按最旧淘汰（`--snapshot-max`） */
  snapshotMax: number
  /**
   * 控制台登录会话有效期（毫秒）；`0` = 永不过期（`--session-ttl 0`）。
   * 会话会落盘，所以这个值同时决定「服务重启后还能自动登录多久」（ADR-031）。
   */
  sessionTtlMs: number
  dataDir: string
  compat: CompatConfig
  /**
   * 加解密插件总开关（`--no-crypto` 关闭，缺省开启）。
   * 关闭时连 `settings.json` 都不读——排查「到底是不是解密把记录改坏了」时用得上。
   */
  cryptoEnabled: boolean
}
