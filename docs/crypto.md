# 加解密：让加密接口在控制台显示明文

> 设计取舍见 [ADR-039](decisions.md#adr-039-加解密密钥与规则分离只改记录不改转发)，
> 字段定义见 [protocol.md §5.6](protocol.md#56-加解密adr-039)。
> 表单表达不了的变形（自定义布局、派生 key、多段拼接）走
> [插件化方案](crypto-plugin.md)（ADR-040）——本文讲的是内置引擎的使用方式。

## 1. 它解决什么

请求体、响应体都被加密的接口（例如 `POST /api/example/im/msg/detail`），
抓到的是一串 base64。配好之后：

- 控制台里**默认显示解密后的明文**，点「查看密文」能切回原始密文；
- 请求侧先看明文 Body，密文原文收在折叠区；
- mock 这个接口时，你填明文，服务端**自动加密回写**，App 照常解密；
- 线上传输的字节**一个都没改**，App 不会感知到 EasyCharles 的存在。

## 2. 三步配好

> 本文所有示例统一用占位口径：路径 `/api/example/...`、字段名 `payload`、业务名 `myapp`。
> 真实接口路径与字段名只写在你自己的 `settings.json` 里（不进库，pre-commit §5.8 会拦），
> 配置时按实际情况替换即可。

### 2.1 复制模板

```bash
# 在项目根目录
mkdir -p server/.data/crypto
cp server/crypto.example.json server/.data/crypto/settings.json
```

`server/.data/` 已被 `.gitignore` 忽略，`build-server-bundle.sh` 也不会把它打进发布包。

### 2.2 填密钥档

```jsonc
{
  "profiles": [{
    "id": "p_im",
    "name": "im 消息详情",
    "alg": "aes-128-cbc",
    "key": "你的 16 字节密钥",       // 支持 utf8 / base64 / base64url / hex
    "keyEncoding": "utf8",
    "iv": "你的 16 字节 IV",
    "ivEncoding": "utf8",
    "cipherEncoding": "base64",     // base64 | base64url | hex
    "request":  { "type": "json", "field": "data" },
    "response": { "type": "json", "field": "data" }
  }],
  "routes": [{
    "id": "c_im",
    "enabled": true,
    "profileId": "p_im",
    "match": { "method": "POST", "path": "*api/example/im/msg/detail*" },
    "request": true,
    "response": true
  }]
}
```

#### AEAD（GCM / ChaCha20-Poly1305）

IV 随每次加密随机生成、认证标签（tag）藏在密文里，所以**不配 `iv`，改成配一条布局**：

```jsonc
{
  "id": "p_im_gcm",
  "alg": "aes-256-gcm",
  "key": "<32 字节密钥，base64url>",
  "keyEncoding": "base64url",
  "cipherEncoding": "base64url",
  "aead": { "ivBytes": 12, "tagBytes": 16, "tagAt": "end" },  // iv | ciphertext | tag
  "request":  { "type": "json", "field": "payload" },
  "response": { "type": "raw", "prefix": "ciphertext:" },
  "query":    { "field": "payload" }
}
```

| 字段 | 含义 | 常见值 |
|---|---|---|
| `plugin` | 用哪个插件做加解密，**缺省 `builtin` 且不必写**（不写回磁盘） | `builtin` |
| `aead.ivBytes` | 密文前缀里 IV 的字节数 | GCM 12 |
| `aead.tagBytes` | 认证标签字节数 | GCM / Poly1305 16 |
| `aead.tagAt` | 标签在尾（`iv\|ct\|tag`）还是头（`iv\|tag\|ct`） | `end` 最常见 |
| `aead.aad` | 关联数据，utf8 字面量；加密与解密必须完全一致 | 一般不填 |
| `wrap.prefix` | 密文串自带的固定前缀，解密时剥掉、mock 回写时补回 | `ciphertext:` |

> `plugin` 是 ADR-040 的插件入口：内置引擎（AES/3DES/SM4/GCM）就是名为 `builtin` 的插件，
> 填别的名字会被拒绝（当前版本只有内置引擎）。业务自己的变形做成私有插件、
> 放 `<dataDir>/plugins/`，不进仓库也不进发布包——见 [crypto-plugin.md](crypto-plugin.md)。
| `query.field` | URL 里的密文参数名 | `payload` |

AEAD 的特点值得记住：**布局或密钥错了会认证失败，而不是解出一段乱码**。
所以「明明 key 对却报认证不通过」，八成是 `ivBytes` / `tagBytes` / `tagAt` 三件里错了一件。

#### query 里的密文参数

`GET` 请求没有 body，业务参数全在 URL 里（`?payload=...`）。配了 `query.field` 之后：

- 控制台「业务参数」里直接列出解密后的各项（`sign`、`timestamp`…），带 `已解密` 小标；
- 解密后的参数参与 mock 规则的 `match.params` 匹配；
- 记录里的 `url` 与 `query` **仍是线上原样**（密文），给排查留证据。

`wrap` 三选一，看密文在 body 里的位置：

| 形态 | 配置 | 例子 |
|---|---|---|
| 整个 body 就是密文 | `{ "type": "raw" }`（缺省） | `"k3Jd9..."` |
| JSON 里的某个字段 | `{ "type": "json", "field": "data" }` | `{"code":0,"data":"k3Jd9..."}` |
| 表单里的某个字段 | `{ "type": "form", "field": "data" }` | `data=k3Jd9...&sign=...` |

嵌套字段支持点路径：`{"field": "body.data"}`。密文串带固定前缀时加 `"prefix": "ciphertext:"`。

`host` / `path` 用与 mock 规则同一套通配语法（`*`、`?`、`re:` 前缀）。
**至少配 `host` 或 `path` 之一**：只按 `method` 匹配会把所有接口都当密文解，写入时会被拒绝。

### 2.3 验证密钥对不对

不用先抓包，直接拿一段已知密文试：

```bash
# 先登录拿会话
S=$(curl -s -X POST http://127.0.0.1:8899/__ec/api/login \
  -H 'content-type: application/json' \
  -d '{"phone":"13800000000","password":"123456"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["session"])')

# 试解密
curl -s -X POST http://127.0.0.1:8899/__ec/api/crypto/test \
  -H "X-EC-Session: $S" -H 'content-type: application/json' \
  -d '{"profileId":"p_im","text":"{\"data\":\"k3Jd9...\"}","mode":"decrypt"}'
# → {"ok":true,"output":"{\"userId\":10086,...}"}
# 失败会回可读原因：密钥不对 / 不是合法 base64 / 解出来不是 UTF-8 文本
```

也可以反向验证：`"mode":"encrypt"` 把明文加回去，再用 App 的解密逻辑解一遍。

改完配置不必重启：`POST /__ec/api/crypto/reload`（或重启服务）。

## 3. 控制台长什么样

- 列表里命中的记录带绿色 `解密` 标签；
- 详情页「返回值」默认是明文，右上角「查看密文 / 查看明文」切换；
- 请求卡片里「请求 Body（解密后）」默认展开，下面跟着「密文原文」折叠区；
- query 里有密文参数时，「业务参数」直接列解密后的各项，带 `已解密` 小标（URL 那行仍是密文，便于复查）；
- 解密失败时黄色提示写明原因，并显示接口原始返回（不会空白）；
- 快照分享页同样能看明文，`复制为 cURL` 用的是**密文**（否则重放必然失败）。

## 3.1 配置页 `/crypto`

从 `/admin` 顶栏点「加解密」进入（与用户控制台共用同一会话）。三块内容，一次「保存全部」整体提交：

1. **插件**：名称 / 说明 / 版本 / 隔离级别 / 状态 / 被几个档引用 / 测试。
   加载失败的插件在这里直接显示可操作原因（例如「SPI 版本 2 与内核 1 不匹配」）。
   `in-process` 的插件标「无隔离」不是装饰：它拦不住 `while(true){}`，会把整个抓包服务卡死。
2. **密钥档**：内置引擎的字段是固定的；私有插件的字段**按插件自带的 `configSchema` 渲染**
   （`secret` → 密码框、`enum` → 下拉、`integer` → 数字且带 min/max）。
   打码值原样提交表示「不修改」；空字符串同理。
3. **解密路由**：密钥档 + 方法 / host / path + 解请求 / 解响应 / 启用。

两个测试入口，用途不同：

- **密钥档卡片上的「测试」** → `POST /__ec/api/crypto/test`：用**已保存**的整套参数
  （含 AEAD 布局、wrap、query 前缀）解你粘进去的那段密文。「这段到底能不能解开」问这个。
- **插件页的「测试」** → `POST /__ec/api/crypto/plugins/test`：只用 schema 里的标量字段试跑，
  不落盘。内置引擎的 `aead` 是嵌套结构，schema 表达不了，所以带 AEAD 的档请用上面那个。

## 3.2 装一个私有插件

插件放在 `<dataDir>/plugins/`（macOS 默认 `~/Library/Application Support/EasyCharles/data/plugins`），
**不在仓库里、不在发布包里**。控制台不提供上传——装插件就是拷目录，再点「重新扫描插件」。

```
<dataDir>/plugins/
  rot13/
    manifest.json     # { name, version, spiVersion, title?, entry? }
    index.mjs         # export default { ...CryptoPlugin }
```

仓库里有一个可直接用的模板：`server/examples/rot13/`。

```bash
cp -r server/examples/rot13 "$HOME/Library/Application Support/EasyCharles/data/plugins/rot13"
```

然后在 `/crypto` 点「重新扫描插件」→ 插件表里出现 `rot13`（状态「已加载」）→
在密钥档里把「插件」切到它、填上它要求的参数 → 保存 → 测试。

写插件时只有四条硬约束：

| 约束 | 违反的后果 |
|---|---|
| `export default { ... }`，不是具名导出 | 「模块没有默认导出」 |
| `name` 必须与目录名（单文件版是文件名）一致 | 拒绝加载，避免两个名字指同一份代码 |
| `spiVersion` 必须等于内核的（当前 1） | 在 import 之前就拒绝，连代码都不会执行 |
| 入口只收 `.mjs` | `.js` 在数据目录下会被当成 CommonJS，`export` 直接语法报错 |

`setup(options)` 抛错 = 这套参数不可用：写入口会翻成 400，读盘时只丢这一条。
运行期 `decrypt` 抛错 / 返回 `{ok:false}` / 返回 Promise，一律降级成「转发正常 + 记录保留原文 + error」，
插件坏了不能让人抓不了包。

需要 nonce 之类的 header 时，在密钥档里写 `pluginContext.headers: ["x-nonce"]`（最多 8 个）。
**不配就一个 header 都不给**——插件能看到全部流量就不再是「字节变换函数」，而是数据外泄的后门。

### 3.3 更省事：直接写一段代码

上面那套（目录 + manifest + configSchema）适合「想做成可复用组件」。如果你只是想让某个
接口的密文变成明文，**一个文件两个函数就够了**，不用写 schema、不用写表单：

```bash
# 放到这里（文件名就是插件名）
~/Library/Application\ Support/EasyCharles/data/crypto/scripts/myapp.mjs
```

```js
import { createDecipheriv } from 'node:crypto'

// 入参：密文串（已经按 wrap 抠出来的那段字）
// 出参：明文字符串。中间随便写。
export function decrypt(text, options) {
  const raw = Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  const iv  = raw.subarray(0, 12)
  const tag = raw.subarray(raw.length - 16)
  const ct  = raw.subarray(12, raw.length - 16)
  const d = createDecipheriv('aes-256-gcm', Buffer.from(options.key, 'utf8'), iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8')
}

// 可选，但 mock 明文要回写成密文时必须有
export function encrypt(plain, options) { /* … */ }

// 可选：哪几个参数要在控制台打码。不写 = 整份参数都打码
export const secrets = ['key']
```

然后在 `/crypto` 页面新建密钥档：插件选 `script:myapp`，参数填 `{"key": "..."}`。
配置页对脚本档显示的是**左边代码（只读）+ 右边参数 JSON**，不再是表单。

四条约束，违反了会当场报错而不是静默：

| 约束 | 说明 |
|---|---|
| 必须同步 | 返回 Promise 会被拒（`请写成同步函数`）——`await` 需要 worker 宿主，还没做 |
| 必须返回字符串 | 返回数字 / undefined 会明确报「必须返回字符串」 |
| 抛异常 = 解密失败 | 记录保留原文、请求照常转发，错误写进 `crypto.*.error` |
| 页面不能改代码 | 只有 `GET .../scripts/:name` 只读接口。能写 `.mjs` 就等于远程代码执行，只能本机改文件 |

改完脚本点「重新扫描插件」即可，不用重启（靠文件 mtime 破 ESM 缓存）。
示例文件在仓库 `server/examples/scripts/rot13.mjs`，拷到上面那个目录就能跑。

## 4. mock 加密接口

在 Mock 编辑器里，body 填**明文**：

```json
{"code":0,"msg":"ok","data":{"unread":3}}
```

然后在规则里加一句（控制台暂未提供可视化开关，走 API 或直接改 `rules.json`）：

```jsonc
"action": {
  "type": "mock",
  "crypto": { "profileId": "p_im" },   // ← 只引用密钥档，不写 key
  "response": { "status": 200, "body": "{\"code\":0,...}" }
}
```

服务端会按 `profile.encrypt`（缺省跟随 `response`）加密后再发给 App。
加密失败时**按明文返回并在记录里记 error**——宁可 mock 失效，也不要让 App 收到一包
解不开的数据却查不出原因。

## 5. 安全边界（重要）

### 密钥放在哪

| 位置 | 进 git | 进发布包 |
|---|---|---|
| `server/.data/crypto/settings.json` | ❌ | ❌ |
| `server/crypto.example.json`（模板） | ✅（只有占位值） | ❌ |

三层防护：

1. **路径**：`.gitignore` 忽略 `server/.data/`、`server/crypto/`、`*crypto-settings.json`；
2. **提交**：`scripts/pre-commit-privacy.sh` 两道检查——
   §5.5 拦「换了个目录存」的密钥档，以及同时出现 `"alg": "aes-…"` 与 `"key": "…"` 的配置文件；
   §5.6 拦**硬编码密钥常量**（`const AES_KEY = "…"`、`val key = '…'`、`aes_key: …`）——
   这类写法没有 `alg` 字段，§5.5 拦不住，而它恰恰是最常见的形式；
3. **发布**：打包白名单不含 `.data/`，产物校验把 `crypto/*.json` 列为禁忌条目。

### 为什么规则里不写 key

规则会被**导出、分享到共享项目、截图发群里**。密钥写进规则，这些日常动作就都变成了泄露路径。
所以规则只存 `profileId`，密钥档留在本机——这是结构性防护，不依赖「记得别提交」。

### 已经泄露了怎么办

1. **轮换密钥**（唯一真正有效的补救），服务端与 App 同步换；
2. 固定密钥泄露 = 任何人可解密历史流量、伪造请求，按高危处理，不要当「低危信息」；
3. 清理 git 历史只能防止「继续被看到」，不能撤回已被 clone / fork / release 的部分；
4. 顺带检查 CI 日志、release 附件、issue / PR 里的粘贴。

## 6. 已知限制

| 限制 | 原因 | 影响 |
|---|---|---|
| 只支持对称加密（AES / 3DES / SM4） | 表单化模型没有非对称与密钥协商的位置 | RSA 信封式加密需要私有插件 |
| AEAD 只支持 `iv\|ct\|tag` / `iv\|tag\|ct` 两种布局 | IV 与标签必须能在密文串里按固定长度切出来 | IV 放在 header / 独立字段的场景需扩展布局模型 |
| AEAD 的 tag 不能单独放在别的字段里 | wrap 只描述「一段串」，不描述多字段拼装 | 会把 tag 单独返回的接口暂不支持 |
| 明文必须是 UTF-8 文本 | 控制台只能展示文本 | protobuf / 二进制明文会明确报错 |
| 流式响应（SSE、超大响应）不解密 | 边转发边写，没有完整密文可解 | 记录显示原样，`bodyTruncated=true` |
| 不支持签名重算 | 本条不改 body，`sign` 不会失效 | mock 改写 body 时才需要，属后续工作 |
| 插件只有 `in-process` 隔离（worker 未做） | worker 宿主是 P2 | 插件里写同步死循环会卡死服务；第三方插件要自己确认可信 |
| 插件必须是同步的 | 调用链是同步的（只改内存记录） | 返回 Promise 会被明确拒绝并记 error；P2 接 worker 后同一签名直接支持异步 |
| 插件只能在启动时 / 手动重扫时加载 | 没有文件监听 | 改完插件点「重新扫描插件」，不要指望自动生效 |

## 7. 排查

**规则配了但不生效？**

```bash
# 看启动日志里有没有加载到
# [crypto] 已加载 1 个密钥档 / 1 条解密路由（.../.data/crypto/settings.json）

# 看读盘告警（坏条目 / 悬空 profileId）
curl -s http://127.0.0.1:8899/__ec/api/crypto -H "X-EC-Session: $S" | python3 -m json.tool
```

**记录里显示的还是密文？**

看 `crypto.request.error` / `crypto.response.error`：

| 错误 | 多半是 |
|---|---|
| 密钥 / IV / 算法与这份密文不匹配 | key 填错，或 wrap 取错了字段 |
| AEAD 认证不通过（… 密钥 / ivBytes+tagBytes+tagAt 布局 / aad 三者之一不匹配） | key 或布局三件里错了一件；tag 位置写反最常见 |
| 密文缺少前缀 `ciphertext:` | 实际没有前缀，或前缀配错（大小写、冒号） |
| 密文不是合法的 base64 编码 | `cipherEncoding` 选错（常见：实际是 base64url） |
| 解密结果不是合法 UTF-8 文本 | key 不对，或明文是二进制 |
| JSON 里没有字符串字段 data | `wrap.field` 写错 |
| body 不是合法 JSON | 实际是表单或 raw，改 `wrap.type` |
| query 里的密文参数解密未成功 | `query.field` 写错，或该接口 URL 里没有这个参数 |

**插件装上了但列表里没有？**

```bash
curl -s http://127.0.0.1:8899/__ec/api/crypto/plugins -H "X-EC-Session: $S" | python3 -m json.tool
```

| 现象 | 多半是 |
|---|---|
| 表格里没有这个名字 | 目录不在 `<dataDir>/plugins/` 下，或名字带了空格/大写（只允许小写字母数字与 `_` `-`） |
| 状态「加载失败」 | 看 `error` 字段；最常见是 `name` 与目录名不一致、`spiVersion` 不是 1、模块没有默认导出 |
| 软链接被跳过 | 有意为之：插件必须是真实目录或文件 |
| 插件在、密钥档却被丢弃 | 启动日志里会有「引用了未加载的插件」；先修插件，再保存一次 |

**`--no-crypto` 关掉后为什么 API 还能看到配置？**

读可以，写会返回 `409 EC_CRYPTO_DISABLED`——避免「保存成功但不生效」的假象。
