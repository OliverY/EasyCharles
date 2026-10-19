# 加解密插件化设计（ADR-040）

> 目标：把「加解密实现」从内核里摘出来，做成可插拔模块。
> 公开仓库只含**接口 + 通用引擎**，业务相关的具体实现与密钥一律留在数据目录，不进 git、不进发布包。
> 管理员在控制台统一安装、启用、配置、自检。

**状态：P0、P1、P1.5（脚本来源）已落地（2026-10-19）** —— `crypto.ts` 已拆为 `crypto/` 目录，
内置引擎走 SPI，`settings.json` 与旧版逐字节一致；插件可从 `<dataDir>/plugins/` 扫描加载，
控制台有独立配置页；业务变形也可以用**单文件脚本**（`<dataDir>/crypto/scripts/*.mjs`，§5.6）表达。
selftest 597 → **676 条全绿**。P2（worker 隔离）未开始，§6.2 仍是它的设计依据。

---

## 1. 为什么要拆

拆分前 `server/src/crypto.ts` 有 830 行，四件事挤在一个文件里：

| 职责 | 典型代码 | 是否该公开 |
|---|---|---|
| **存储与策略** profile / route 的校验、匹配、落盘 | `normalizeProfile`、`match` | ✅ 公开 |
| **密文定位** 从 body / query 里找出那段密文 | `extractCipher`、`wrapCipher`、`pick` | ✅ 公开 |
| **编码转换** base64 / base64url / hex / utf8 | `cipherBuf`、`encodeCipher` | ✅ 公开 |
| **算法与布局** 怎么把这段字节解成明文 | `makeCipher`、`decipherAead`、`cipherAead` | ⚠️ 通用部分公开，业务变形私有 |

问题出在第四行。现在「业务变形」只能靠**配置**表达（`alg` + `aead` + `wrap` + `prefix`）。
配置表达不了的情况会越攒越多：

- IV 不在密文头部，而是 `sha256(固定盐 + 时间戳)` 现算出来的；
- 密文是两段拼接，第二段用另一把派生 key；
- 请求要先把 body 做一次 ROT13 / 自定义 Base64 字母表再解；
- 解密前要用 header 里的 nonce 参与校验。

这些一旦要做，只能往 `crypto.ts` 里加 `if (alg === 'xxx')`，内核逐步长成业务代码，
开源时就得整块删——删完别人也用不了。

**拆的目标不是「把代码藏起来」，而是让内核不再需要知道业务怎么加密。**

---

## 2. 三层结构

```
┌──────────────────────────────────────────────────────────┐
│  Core（公开，永不含业务知识）                              │
│                                                          │
│  store.ts      profile / route 存储、校验、匹配、落盘      │
│  profile.ts    归一化与打码视图（P0 现状，P1 交给 schema）  │
│  wrap.ts       密文定位：raw | json | form + prefix        │
│  encoding.ts   base64 / base64url / hex / utf8            │
│  transform.ts  门面：extractCipher → plugin.decrypt → 明文  │
│  registry.ts   插件注册、SPI 校验（P1 加目录扫描）          │
│  sandbox.ts    worker 宿主（P2，未落地）                   │
│  index.ts      对外唯一出口（导出签名与 ADR-039 一致）      │
└────────────────────────┬─────────────────────────────────┘
                         │ 只通过 SPI 交互：text + options → text
        ┌────────────────┴─────────────────┐
        │                                  │
┌───────▼─────────────┐        ┌───────────▼──────────────────┐
│ builtin 插件（公开） │        │ 私有插件（不进 git）          │
│ builtin.ts          │        │ <dataDir>/plugins/<name>/    │
│ AES / DES / SM4     │        │   manifest.json               │
│ + AEAD 布局         │        │   index.mjs                   │
│ 纯配置驱动          │        │ 由使用者自行实现与分发         │
└─────────────────────┘        └──────────────────────────────┘
```

关键取舍：**内置引擎也是一个插件**，走同一条 SPI。这样只有一条代码路径，
不会出现「内置能解、插件不能」的双标；同时它可以用配置关掉或从公开版剔除。

---

## 3. SPI 定义

放进 `server/src/crypto/plugin-types.ts`，公开。下面是**实际落地的版本**（P0），
与最初设计的差异写在 §3.2。

```ts
/** SPI 版本。内核只接受自己认识的主版本，升级时靠它拒绝加载而不是运行时崩。 */
export const SPI_VERSION = 1

/**
 * 插件拿到的上下文。**故意只有两项**——见 §9 第 5 条。
 *
 * 没有 `direction: 'request' | 'response'`：插件不需要知道这份密文来自请求还是响应，
 * 它只做一次字节变换。知道得越多，越容易被写成「只在请求方向生效」这种内核看不见的分支。
 */
export interface PluginContext {
  /** 仅用于日志与打点，插件不应依赖它分支 */
  profileId: string
  /** 显式声明的 header 白名单（见 §6.3）；P0 恒为空对象 */
  headers: Readonly<Record<string, string>>
}

/** 插件收到的每一次调用。text 是**已剥离 prefix** 的密文串。 */
export interface PluginCall {
  text: string
  options: PluginOptions
  ctx: PluginContext
}

/** 值是 unknown：`builtin` 的 aead 是一组描述布局的结构，不该被压成标量 */
export type PluginOptions = Readonly<Record<string, unknown>>

export type PluginResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** 配置表单 + 写入校验用。JSON Schema 的子集，见 §8。 */
export interface PluginConfigSchema {
  type: 'object'
  required?: string[]
  properties: Record<string, {
    type: 'string' | 'integer' | 'number' | 'boolean'
    title?: string
    description?: string
    /** 前端渲染成密码框；GET 下发时打码；PUT 回写 `••••` 表示沿用 */
    secret?: boolean
    enum?: (string | number)[]
    default?: string | number | boolean
    minimum?: number
    maximum?: number
  }>
}

export interface CryptoPlugin {
  spiVersion: number   // P0 只认 1
  /** `[a-z0-9][a-z0-9_-]{0,39}`，全局唯一；`builtin` 是保留名 */
  name: string
  version: string
  title: string
  description?: string

  /** 能力声明：没声明 encrypt 的插件不能用于 mock 回写 */
  capability: { decrypt: boolean; encrypt: boolean }

  /** `in-process`（快）| `worker`（可中断、可限内存）。缺省 in-process。 */
  isolation?: 'in-process' | 'worker'

  /** 单次调用超时，缺省 500ms。解密是热路径，超了就该失败而不是拖住请求。 */
  timeoutMs?: number

  configSchema: PluginConfigSchema

  /** 每个 profile 调一次，可以在这里派生 key、预建 cipher。抛错 = 该 profile 不可用。 */
  setup?(options: PluginOptions, ctx: { profileId: string }): void

  decrypt(call: PluginCall): PluginResult<string> | Promise<PluginResult<string>>
  encrypt?(call: PluginCall): PluginResult<string> | Promise<PluginResult<string>>

  /** 「这套配置在这台机器上到底通不通」，供控制台测试按钮 */
  selftest?(options: PluginOptions, sample?: string): PluginResult<string> | Promise<PluginResult<string>>

  dispose?(): void
}
```

### 3.1 边界为什么划在「密文串」

插件收到的是 string，不是 Buffer。原因是**布局属于业务知识**：

- 「前 12 字节是 IV、末尾 16 字节是 tag」——只有业务方知道；
- 「这是 base64url 还是 hex」——也可能因接口而异。

内核不该猜这些。内核只负责「密文在哪」（wrap）和「解出来怎么记录」，
插件负责「这段字怎么变明文」。

### 3.2 插件不需要自带解码工具

Node 内置够用，文档给一段可复制的 20 行 helper，不引第三方包：

```js
const dec = (s, enc) => enc === 'hex' ? Buffer.from(s, 'hex')
  : Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
```

**坑**：`Buffer.from(x, 'base64')` 会**静默跳过** `-` `_`，把 32 字节密钥解成 30 字节，
报的却是 `Invalid key length`。base64url 必须先替换（ADR-039 补充里踩过一次）。

### 3.3 落地时改掉的三处（P0 复盘）

1. **去掉 `direction`**：原本想在上下文里区分请求/响应/query。实际写下来发现
   `decrypt` / `encrypt` 两个方法已经把方向说清了，「来自哪一侧」只是内核选哪个 wrap
   的问题，与插件无关。多给一个字段只会诱导插件长出业务分支。
2. **`PluginOptions` 放宽到 `unknown`**：`aead{ivBytes,tagBytes,tagAt}` 是描述密文布局的
   结构，硬压成标量就得写成 `aead_ivBytes` 这种更差的形态。代价是 P1 的 `configSchema`
   只管标量字段，嵌套结构由插件自己的 `setup` 兜住。
3. **P0 的调用链是同步的**：`decryptWith` 被数据面同步调用（只改内存里的记录），
   所以 SPI 返回 `PluginResult | Promise<PluginResult>`，但内核目前**拒绝 Promise**
   并写一条可读的 `crypto.error`——静默 `await` 会让 `[object Promise]` 被当成明文塞进记录。
   P2 接 worker 时把 `syncResult()` 换成 `await` 即可，**同步插件一行都不用改**。

---

## 4. profile 形态与零迁移

现在磁盘上（远端已在跑）：

```jsonc
{ "id": "p_myapp_prod", "alg": "aes-256-gcm", "key": "…", "cipherEncoding": "base64url",
  "aead": { "ivBytes": 12, "tagBytes": 16, "tagAt": "end" },
  "request": { "type": "json", "field": "payload" } }
```

**不改它。** 新增两个可选字段：

```jsonc
{
  "id": "p_x",
  "plugin": "mycompany-double",     // 缺省 = "builtin"
  "options": { "keyPart1": "…", "rounds": 2 },  // 缺省 = 由扁平字段推导
  "pluginContext": { "headers": ["x-nonce"] },  // 可选，见 §6.3
  "request": { "type": "raw" }, "response": { … }, "query": { … }
}
```

归一规则（`store.ts` 读入时做，**不回写磁盘**）：

| 磁盘上有 | 归一为 |
|---|---|
| 没有 `plugin` | `plugin: 'builtin'`，`options` = `{alg, key, keyEncoding, iv, ivEncoding, cipherEncoding, autoPadding, aead}` |
| 有 `plugin: 'builtin'` | 同上，扁平字段优先 |
| 有 `plugin: '<其它>'` | `options` 必须是对象（可为 `{}`）；**出现扁平算法字段 → 写入 400** |

最后一条是防「两套配置互相打架」：一个 profile 同时写着 `alg` 和 `plugin: xxx`，
出问题时没法判断到底哪套生效。宁可写入时报错。

`settings.json` 里 `PERSISTED_FORMAT = 1` 不变——老文件照读，新文件多两个键而已。

---

## 5. 插件发现与生命周期

### 5.1 目录

```
<dataDir>/plugins/
  myapp-gcm/
    manifest.json     # { name, version, spiVersion, title?, entry? }
    index.mjs         # 插件本体：export default { ...CryptoPlugin }
  my-rot13.mjs        # 也支持单文件：元数据全在模块导出里
```

**为什么 manifest 只有四个字段**（P1 落地时的修订）：它是 import 之前唯一的检查依据，
那里只需要判断「敢不敢执行这段代码」——name（认证身份）、version（对账）、
spiVersion（能不能调用）、entry（执行哪个文件）。`configSchema` / `capability` /
`isolation` 以模块导出为准，一份数据只有一个来源。

`<dataDir>` 在 macOS 上是 `~/Library/Application Support/EasyCharles/data`，
也就是 `server/.data/`、`.gitignore` 已经覆盖的位置。**插件天生不在仓库里。**

### 5.2 扫描规则

1. 只扫一层，**不递归**（防深层目录藏东西，也防误扫 node_modules）；
2. 目录名/文件名必须匹配 `^[a-z0-9][a-z0-9_-]{0,39}$`——`..`、`/`、`.` 全部不可能；
3. 用 `lstat` 判断，**软链接直接跳过**并记 warning（防 `plugins/x -> /etc`）；
4. 同名（目录版 + 单文件版）→ 报冲突，两条都不用，提示用户删一个；
5. 名字 `builtin` 保留，用户插件占用直接拒绝。

### 5.3 加载

```
读 manifest → 校验 spiVersion === 1（不符则**不 import**）→ 动态 import(url + '?v=' + mtime)
  → assertPluginShape（名字 / 能力 / schema / decrypt）→ name 与磁盘名一致 → 存入 registry
```

`?v=<mtime>` 是为了破 ESM 模块缓存。**坑**：不加这个 query，改完插件点「重载」
仍然是旧代码在跑，会让人怀疑人生。mtime 保留小数位——同一毫秒内改两次也该算「变了」。

加载失败**不抛到启动路径**：服务照常起，该插件状态记为 `error` 并带原因，
用到它的 profile 解密失败但请求不受影响（§10）。

### 5.4 实例缓存（P1 未做，且不再需要）

原设计想按 profile 缓存实例，为的是「`setup` 里派生 key 时不同 profile 不能串」。
P1 落地的做法更简单：**不缓存实例，`options` 每次调用都传**。

代价是一条必须写进 SPI 的约束：**插件不得在 `this` 上保存 per-profile 状态**。
一个插件对象会被所有引用它的 profile 共用，在 `this` 上存「当前 key」必然被后一个 profile 覆盖，
而症状是「只有最后一个档能解开」——极难查。`setup` 因此在 P1 里只做**校验**（抛错 = 这份参数不可用）。

`dispose` 同理留到 P2：现在没有 worker、也没有需要释放的资源；
真要接 worker 时，实例本来就变成了每个 profile 一个 worker，语义自然成立。

### 5.5 生命周期状态

`discovered → loaded → ready | error`

控制台展示后三态。`error` 必须带可操作的原因（不是 `Error: xx` 而是
「SPI 版本 2 与内核 1 不匹配，请升级 EasyCharles 或换插件版本」）。

### 5.6 脚本来源：`<dataDir>/crypto/scripts/`（P1.5）

目录插件的问题不是难写，而是**重**：manifest + `configSchema` + 完整 `CryptoPlugin` 对象，
为了表达一行 `return aesDecrypt(text, key)`。而 schema 一旦落到业务变形上就不够用——
自定义布局、二次编码、签名混进密文、随机盐，表单永远差一个字段。

所以 P1.5 加一条更轻的来源：**一个 `.mjs`，两个函数，没有 schema**。

```js
// <dataDir>/crypto/scripts/myapp.mjs  →  注册名 script:myapp
export function decrypt(text, options) { return '明文' }
export function encrypt(plain, options) { return '密文' }   // 可选
export const secrets = ['key']                             // 可选
export const meta = { title: 'myapp', version: '1.0.0' }    // 可选
```

设计上刻意**不新增 SPI**：`script.ts` 在 import 之后把这两个函数包成标准 `CryptoPlugin`
（`decrypt({text,options})` → 调用用户函数 → 包成 `PluginResult`），注册进同一个
`PluginRegistry`。wrap、query、mock 回写、fail-open、`?v=mtime` 破缓存全部复用，
数据面一行没改。

四个决定，每个都有代价，写下来免得以后回头改：

1. **`script:` 前缀是保留命名空间**。名字带前缀，控制台一眼能看出「这段配置依赖哪个来源的代码」；
   目录插件也不能占用（`register()` 按 `source` 双向校验）。代价是 `PLUGIN_NAME_RE` 要放宽一位。
2. **没有 schema 就没有表单**。页面变成「左边代码（只读）+ 右边参数 JSON」。
   参数只做结构校验（合法 JSON、嵌套 ≤6 层、单值 ≤4096 字符、整体 ≤64KB），不管类型——
   类型是脚本自己的事，`options.key` 该是 base64 还是 utf8 只有业务知道。
3. **打码退化成 `secrets` 声明**，不声明就整份打码。绝对不做「键名像 key 就抹掉」的启发式：
   猜错一次，密钥就明文出现在页面上。整份打码的代价只是改参数时要重填一遍。
4. **控制台只读，没有写接口**。这条与「不做上传安装」是同一条理由：能往数据目录写 `.mjs`，
   就等于持管理 token 能执行任意代码。只读接口 `GET /__ec/api/crypto/scripts/:name`
   让页面能显示源码和报错行号，改代码必须回到本机编辑器。

失败语义与目录插件完全一致（`script.ts` 的 `callUser` 收口）：抛异常 → `脚本 X 的 decrypt 抛异常：…`；
返回非字符串 → `必须返回字符串，收到 number`；返回 Promise → `请写成同步函数`。
三种都是「记录保留原文 + 转发正常」。

**仍然没有解决的问题**：`in-process` 执行，脚本里 `while(true)` 会卡住整个服务。
这一条只能靠 P2 的 worker `terminate` 真中断，控制台照旧标「无隔离」。

---

## 6. 两种隔离模式

### 6.1 in-process

```
registry.call() → await Promise.race([plugin.decrypt(call), timeout])
```

优点：零拷贝、延迟最低、插件可以用 `dispose` 管理资源。

**必须说清的局限**：`Promise.race` 只能让**不返回的异步**不再拖住请求，
**拦不住同步死循环**（`while(true){}` 会卡死整个事件循环，抓包服务直接假死）。
所以：

- 自己写的、可信的插件用 in-process；
- 第三方 / 不放心的一律 `isolation: "worker"`；
- 控制台的插件列表上，in-process 的插件要显式标「无隔离」。

### 6.2 worker

内核自带一个通用宿主 `sandbox/sandbox-host.mjs`，**插件作者不用写任何 worker 代码**：

```js
// sandbox-host.mjs 核心逻辑（内核文件，插件不感知）
const { pluginFile, options } = workerData
const mod = await import(pathToFileURL(pluginFile).href)
await mod.default.setup?.(options, { profileId: workerData.profileId })
parentPort.on('message', async ({ id, op, text, ctx }) => {
  try {
    const r = await (op === 'encrypt' ? mod.default.encrypt : mod.default.decrypt)({ text, options, ctx })
    parentPort.postMessage({ id, ...r })
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: String(e?.message ?? e) })
  }
})
```

宿主侧：

```ts
new Worker(hostUrl, {
  workerData: { pluginFile, options, profileId },
  resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
})
```

- **每个 profile 一个常驻 worker**，不是每次请求新建（import 冷启 10~50ms，热路径扛不住）；
- 单 worker 内**串行**处理：解密是 CPU 密集，并发没有收益还会争抢；
- 超时到点直接 `worker.terminate()`——这是**真中断**，死循环也能杀；
- worker 崩溃（OOM / 未捕获异常）→ 该 profile 标记退避重建，下一次请求重试一次。

**坑**：`postMessage` 走结构化克隆，1MB 的 body 会复制一次。
所以 worker 模式的 profile 在控制台提示「大 body 有额外内存开销」，
并沿用现有的 `sampleBytes` 截断思路——超过阈值不做解密，直接标 `bodyTooLarge`。

### 6.3 插件要不要看 header

默认**不给**。理由：插件能看到全部流量，就不再是「一个字节变换函数」，
而是一个可以外发数据、可以按用户身份做手脚的后门。

但确实有业务把 nonce / IV 放 header。所以留一个**显式白名单**：

```jsonc
"pluginContext": { "headers": ["x-nonce", "x-ts"] }
```

- 最多 8 个；名字不区分大小写；值截断到 256 字符；
- 只传**字符串值**，不传数组（`set-cookie` 这类多值头不参与）；
- 没配就是空对象，插件拿不到任何 header。

---

## 7. 管理员统一配置

### 7.1 API

沿用现有前缀与鉴权（`X-EC-Session`），全部在 `/__ec/api/crypto` 下：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/crypto/plugins` | 插件清单：name / version / title / spi 兼容 / isolation / 状态 / error / configSchema |
| POST | `/crypto/plugins/reload` | 重扫目录 + 重建实例（返回 warnings） |
| POST | `/crypto/plugins/test` | `{ plugin, options, text, mode }` 试跑，**不落盘、不进缓存** |
| GET/PUT | `/crypto` | 现有密钥档；profile 增 `plugin` / `options` / `pluginContext` |

视图差异：
- `GET /crypto` 里，`options` 中 `secret: true` 的字段打码（复用 `CRYPTO_MASK`）；
- `PUT` 收到含 `••••` 的值 → 按 `profileId + 字段名` 沿用旧值，与现有 `key` 语义一致。

### 7.2 控制台

密钥档编辑表单**按插件 schema 动态渲染**，不再为每个插件写死 UI：

```
[密钥档] p_myapp_prod
  插件  [builtin (内置通用引擎) ▾]        ← 只列已加载的插件
  算法  [aes-256-gcm ▾]  配置编码 [base64url ▾]
  密钥  [••••••••]  (密码框，占位提示「留空沿用」)
  IV 长度 [12]   Tag 长度 [16]   布局 [iv|ct|tag ▾]
  [测试这段密文]  [保存]
```

字段顺序 = schema `properties` 的声明顺序；`secret` → `type=password`；
`enum` → `select`；`boolean` → 开关；`integer` → `number` + `min/max`。

插件页（独立 tab）：

```
已安装插件
  builtin            1.0.0   in-process   内置     [✓ 启用]
  myapp-gcm          1.2.0   worker       已加载   [✓ 启用]  [测试]
  old-thing          0.9.0   worker       错误: SPI 版本 2 与内核 1 不匹配   [禁用]
                                    [重新扫描插件目录]
```

装插件 = 把目录拷进 `<dataDir>/plugins/`，再点「重新扫描」。
控制台**不提供上传**，理由见 §9 第 2 条。

### 7.3 现有「密钥档」如何过渡

远端那份 `p_myapp_prod` / `p_myapp_test` 不需要动：
读入时自动归一为 `plugin: 'builtin'`，表单里显示为「内置引擎」。
想切到私有插件，只需把 profile 的 `plugin` 改掉、`options` 填上。

---

## 8. schema 约定与写入校验

`configSchema` 是**表单描述**，不是安全边界；但写入时必须按它做一次结构校验，
否则 `options` 会变成任意 JSON 的垃圾桶（现有约定：管理面所有写入都是不可信输入）。

校验项：

| 检查 | 失败处理 |
|---|---|
| `required` 字段缺失 | 400，指出缺哪个 |
| 类型不符（`integer` 收到 `"12"`） | 400；**不做隐式转换**，否则「配了却不生效」 |
| `enum` 不在集合内 | 400，列出允许值 |
| `minimum` / `maximum` | 400 |
| 未声明的字段 | 允许（插件升级加字段时旧配置不能炸），但整体受 `SETTINGS_MAX_BYTES` 限制 |
| 单字段字符串 > 4096 字节 | 400（防塞 Base64 大文件进配置） |
| `secret` 字段回写 `••••` | 沿用旧值；旧值不存在则 400（不能把打码串当密钥存） |

最后一条是 ADR-039 已经踩过的坑，别在新路径上重犯。

---

## 9. 安全边界

1. **路径穿越**：插件名正则 + 只拼固定根目录 + `lstat` 拒软链接。三层，任一层失效还有下一层。
2. **不做上传安装**：控制台在 LAN 模式下任何持 token 的客户端都能调，
   上传 zip = 提供远程代码执行入口。安装动作必须走「有本机/SSH 权限」的文件拷贝。
   这与项目既有约定一致：管理面写入入口一律按不可信输入对待，能不开口子就不开。
3. **不给插件完整上下文**：只传密文串 + 自己的 options + 显式白名单 header（§6.3）。
4. **worker 资源限制**：`maxOldGenerationSizeMb: 64`，超时 terminate。
5. **插件代码不进 git**：插件目录在 `<dataDir>` 下（已被 `.gitignore` 覆盖、
   已被打包白名单排除）。**额外**再加一条 pre-commit 规则：
   `server/**/plugins/*/index.mjs` 或 `server/**/plugins/*.mjs` 出现在暂存区就拦——
   防止有人（包括我）图省事把私有插件放进源码树。
6. **`builtin` 保留名**：不允许用户插件占用，避免「以为在用内置、实际跑的是别人的代码」。
7. **审计**：启用/禁用/改 options 都写一条 warning 级日志（含插件名与 profileId，
   **不记 options 的值**——里面可能有密钥）。

---

## 10. 失败降级矩阵

沿用 ADR-039 的核心承诺：**解密失败绝不阻断转发**。

| 场景 | 请求转发 | 记录 | `crypto.*.error` |
|---|---|---|---|
| 插件未安装 / 名字非法 | 正常 | 原文 | `插件 xxx 未安装` |
| SPI 版本不匹配 | 正常 | 原文 | `插件 xxx 需要 SPI 2，当前内核 1` |
| `setup` 抛错 | 正常 | 原文 | `插件初始化失败：…` |
| `decrypt` 返回 `{ok:false}` | 正常 | 原文 | 插件给的 error 原文 |
| `decrypt` 抛异常 | 正常 | 原文 | `插件异常：…`（**不把 stack 写进记录**，避免泄露路径） |
| 超时 | 正常 | 原文 | `插件超时（500ms）` |
| 返回非字符串 / 空串 | 正常 | 原文 | `插件返回了非字符串结果` |
| worker 崩溃 | 正常 | 原文 | `插件进程退出，已重建` |
| mock 加密失败 | 正常（明文） | — | `mock 加密失败，已按明文返回` |

「原文」= 线上实际传输的那份（`body` 保持密文、`rawBody` 为 null），
与现在解密失败时的行为完全一致——控制台不会因为插件坏了而显示空白。

---

## 11. 公开 / 私有边界

| 内容 | 位置 | 公开仓库 | 发布包 |
|---|---|---|---|
| 内核（store / profile / wrap / encoding / transform / registry） | `server/src/crypto/` | ✅ | ✅ |
| 内置通用引擎 | `server/src/crypto/builtin.ts` | ✅ | ✅ |
| SPI 类型与文档 | `server/src/crypto/plugin-types.ts`、`docs/crypto-plugin.md` | ✅ | ✅ |
| 示例插件（passthrough / rot13） | `plugins-example/` | ✅ | ❌（示例，不需要随包） |
| **业务插件** | `<dataDir>/plugins/<name>/` | ❌ | ❌ |
| **密钥 / options** | `<dataDir>/crypto/settings.json` | ❌ | ❌ |

发布物只包含 **git 跟踪的文件**（导出用 `git archive HEAD`），
所以只要业务插件与密钥都落在 `<dataDir>`，公开版天然干净——不需要额外过滤逻辑。

---

## 12. 实施步骤

### P0：纯重构，行为零变化（✅ 已完成，验收线：selftest 597 条全绿）

实际落地（2026-10-19）：

1. `crypto.ts` 拆成 `crypto/{errors,coerce,encoding,wrap,profile,transform,store,index}.ts`，
   **导出签名保持不变**（`data-plane.ts` 只多传了第三个参数「用哪个注册表」）；
2. `plugin-types.ts`（§3，含 §3.2 三处修订）；
3. 内置引擎包成 `builtin` 插件（`configSchema` 的键名与现有扁平字段一致）：
   `alg / key / keyEncoding / iv / ivEncoding / cipherEncoding / autoPadding / aead`；
   参数由 profile 的扁平字段**现算**（`builtinFields`），不落盘；
4. `store.ts` 走同一套归一逻辑（§4），磁盘格式不变——**内置档不写 `plugin` 字段**，
   settings.json 与 ADR-039 时期逐字节一致，回滚旧版本也读得懂；
5. `registry.ts` 只实现 in-process，`builtin` 为保留名，SPI 版本不符在**加载时**拒绝；
6. selftest 新增 12 条结构用例（§13 的 P0 部分），合计 **609 条全绿**；
   另跑了一次真实 HTTP 链路冒烟（数据面 → 上游 → 记录 → 控制台 API），
   GCM 请求体 / 带前缀的响应体 / query 三处都解出明文，转发字节未变。

> 这一步的意义：把「插件化」变成**可回滚的重构**，而不是一次性重写。
> 如果 P0 后 selftest 有任何一条变红，说明边界划错了，此时停手比继续叠功能划算。

### P1：插件体系可用（✅ 已完成）

实际落地（2026-10-19）：

7. `loader.ts`：只扫一层、名字正则、`lstat` 拒软链接、目录版 `manifest.json` + 入口、
   单文件版、`?v=mtime` 破 ESM 缓存；SPI 版本在 **import 之前**就拒；
   同名目录+文件冲突、入口 `../`、占用 `builtin` 一律拒；失败只记状态，不抛到启动路径。
8. `manager.ts`：扫描结果 → 新注册表整体替换（串行化，避免并发重载读到半成品），
   并承载试跑。重载后必须 `store.setPlugins()` + `store.reload()`，少做后一半会留下
   「用旧插件解析出来的 profile」。
9. `schema.ts`：`configSchema` 驱动的 options 归一化与打码。写入口严格（400），
   读盘宽松（坏字段只丢自己）；`secret` 打码值回写沿用旧值，没有旧值则 400。
10. API：`GET /crypto/plugins`、`POST /crypto/plugins/reload`、`POST /crypto/plugins/test`；
    `GET /crypto` 的 `options` 按 schema 打码。
11. 控制台：独立页 `/crypto`（插件表 + 按 schema 渲染的密钥档表单 + 解密路由），
    从 `/admin` 顶栏进入。插件页对 `in-process` 显式标注「无隔离」。
12. 示例插件 `server/examples/rot13/`（可直接拷进 `<dataDir>/plugins/`），
    加 pre-commit §5.7 拦「私有插件混进源码树」。

### P1 落地时对设计的两处修订

1. **单文件插件也必须 `.mjs`**，不收 `.js`。数据目录下没有 `package.json {"type":"module"}`，
   `.js` 会被当成 CommonJS，`export` 直接语法报错——那个错看起来像「插件写坏了」，
   实际是后缀问题。与其在文档里解释，不如让后缀只有一种正确写法。
2. **`manifest.json` 只放「加载前必须先看」的元数据**（name / version / spiVersion / entry），
   `configSchema`、`capability`、`isolation` 等以**模块导出为准**。理由：manifest 是 import
   之前唯一的检查依据，那里只需要判断「敢不敢执行这段代码」；其余字段让一份数据只有一个来源，
   少一处能对不上的地方。两者不一致（name / version / spiVersion）会拒绝加载。

### P2：隔离

11. `sandbox-host.mjs` + worker 宿主 + 超时 terminate + 崩溃重建；
12. 控制台标注每个插件的隔离级别与大 body 提示。

### P3：可选增强

13. 插件签名/校验和（防篡改，但仍是「本机可写的人能换」——收益有限）；
14. 按 host 自动探测 profile（用一次试探解密猜哪套配置对，减少手工配路由）。

---

## 13. 验收清单（含异常输入矩阵）

正常路径：

- [x] 现有 `settings.json` 不做任何修改，解密结果与重构前完全一致（逐字段 diff 记录）
      —— P0 已验：597 条行为用例全绿 + 落盘不含 `plugin` 字段
- [x] 私有插件装进 `<dataDir>/plugins/` 后，控制台「重新扫描」能看到并启用
- [x] profile 切到私有插件后，同一段真实密文解出明文（selftest + 真实数据面冒烟）
- [x] mock 回写走插件的 `encrypt`（P0 已验；插件档沿用同一条链路）

异常与对抗（P1 已在 selftest 覆盖的部分打勾）：

- [x] `spiVersion: 2` → 拒绝加载，**且在 import 之前**拒绝（模块里的 throw 不会被执行）
- [x] 插件名不合法（`Bad Name`）→ 目录名先拦一次并告警
- [x] `manifest.name` 与目录名不一致 → 拒绝（防止两个名字指同一份代码）
- [x] `plugins/x` 是软链接 → 跳过 + warning
- [x] 目录版与单文件版同名 → 两条都不用，提示冲突
- [x] 用户插件叫 `builtin` → 拒绝
- [x] 入口写 `../evil.mjs` → 拒绝（路径穿越不靠「刚好不存在」）
- [x] 模块在 import 阶段抛错 → 记 error，不抛到启动路径
- [x] `setup` 抛错 → 写入口 400，不落盘（读路径只丢这一条）
- [x] `decrypt` 抛异常 → 「记录原文 + error」，转发正常（P0：`decryptForRecord` 兜住）
- [x] `decrypt` 返回 Promise → 明确拒绝并记 error，**不会把 `[object Promise]` 当明文**
- [x] `decrypt` 返回 `{ok:false}` → 记录里写它给的 error（P0 已验）
- [x] `options` 类型错（`"12"` 给 integer）→ 400，不落盘
- [x] `options` 单字段 >4096 字符 → 400
- [x] `secret` 字段 GET 打码；PUT 带 `••••` → 沿用旧值；旧值不存在 → 400
- [x] profile 同时有 `plugin: 'x'` 和 `alg` → 400；`plugin: builtin` 带 `options` → 400
- [x] 插件目录被删掉后点重载 → 该 profile 被跳过并留告警，服务不崩
- [x] 重载后修改插件代码 → 生效（`?v=mtime` 破缓存已验证）
- [ ] `decrypt` 里 `while(true){}`（worker 模式）→ 超时 terminate —— **P2**
- [x] `decrypt` 里 `while(true){}`（in-process 模式）→ 已知无法中断，控制台已标「无隔离」
- [ ] 控制台表单提交后整页刷新仍正确（视觉回归，未做自动化）

---

## 14. 风险与权衡

| 风险 | 说明 | 缓解 |
|---|---|---|
| 抽象过度 | 只有一套业务实现时，SPI 可能是「为想象中的第二套设计」 | P0 严格等价重构，抽象由真实需求（myapp）驱动；不预留没有用例的字段 |
| in-process 无法真隔离 | 同步死循环会卡死服务 | 默认标注；不信任的插件用 worker；文档明确写这条限制 |
| worker 内存翻倍 | 大 body 结构化克隆 | 超阈值不解密 + 提示；后续可换 `SharedArrayBuffer` |
| 插件生态碎片 | 每个人按自己的理解写插件 | `plugins-example/` 提供两个可跑的最小实现 + SPI 版本号硬约束 |
| 控制台表单追不上 schema | 复杂插件需要自定义 UI | schema 只覆盖「标量字段」；真需要复杂 UI 的，允许插件带一段 `ui.html` 片段（P3，沙箱渲染） |

---

## 15. 与既有决策的关系

- 承接 **ADR-039**：「脚本模式留给真正需要自定义逻辑的场景（要 worker 隔离 + 权限边界）」——
  本条就是那个模式，只是把「脚本」具体化为「插件 + SPI」。
- 强化 **ADR-039 的密钥分离**：以前只分离 `key/iv`，现在连「实现」也分离。
  规则文件、示例配置、文档里连业务加密方式都不出现。
- 遵守 **ADR-011** 表单化优先：schema 驱动的表单仍是默认路径，
  插件只是在表单表达不了时才启用。
