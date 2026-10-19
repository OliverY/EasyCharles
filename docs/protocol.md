# EasyCharles 协议约定 v2

> 本文档是服务端、Android SDK、iOS SDK、控制台四端并行的**唯一契约基准**。
> **服务端只认本协议，不认端类型。** 任何 "Android 专属" 的概念都不得进入服务端逻辑，
> 这是 iOS 接入成本接近于零的前提（见 ADR-002 与 §8.2）。
>
> - 协议版本：`2`
> - 状态：目标态。实现状态逐项标注（✅ 已实现 / 🔧 P0 修复项 / 📅 后续里程碑），
>   偏差以本文档为准，实现按 roadmap 对齐。
> - 字段演进原则：新增字段必须可选且可缺省，服务端不得因缺少可选头拒绝请求（见 §9）。

---

## 0. v1 → v2 变更记录（破坏性，仅限本次）

| # | 变更 | 原因 | 状态 |
|---|---|---|---|
| C1 | **鉴权口径重定义**：取消 token 三面鉴权，改为**控制台手机号空间 + 登录会话**；数据面不鉴权 | LAN token 方案在真实联调中改为用户空间隔离模型（**ADR-015 取代 ADR-007**） | ✅ |
| C2 | `/__ec/hello` 响应**不含任何凭据**；`wsUrl` 改为按请求 `Host` 生成 | 凭据不得经握手下发；adb reverse 场景需回环 wsUrl（ADR-014） | ✅ |
| C3 | `X-EC-Record-Mode` 从声明变为生效语义（full/meta/sample），优先级 per-request > 全局 | P0 的 record-mode 是死配置（ADR-012） | ✅ |
| C4 | 响应缓冲策略改为 bounded buffering；`bodySize` 恒为实际传输字节数 | P0 只缓冲有 content-length 的响应，chunked 永远采样、bodySize 记 0（ADR-008） | ✅ |
| C5 | 新增 §3.6 重定向：SDK 手动跟随，每跳一条记录、共享 `seq` | P0 相对 Location 逃出代理（ADR-009） | ✅（SDK 侧待真机验收） |
| C6 | fail-open 判定收紧：**超时不算代理不可达**，不重放、不计熔断 | 超时重放 = 重复提交（ADR-005/013） | ✅（SDK 侧待真机验收） |
| C7 | 错误码表补齐：`EC_UNAUTHORIZED` / `EC_PROTOCOL_MISMATCH` / `EC_SERVER_BUSY` 定义生效 | P0 只实现 3 个 | ✅（401 已产生；426 服务端不发、SDK 已处理；503 预留） |
| C8 | Record 新增 `flags.redirected`；`rawBody` 语义明确为「加解密插件处理前原始 body」 | 重定向链展示 / 插件契约（ADR-009/011） | ✅（redirected）/ 📅（rawBody，P2） |
| C9 | Rules schema 扩展位：`action.crypto`（P2）、`action.extract`/`action.set`（P3） | 加解密插件与变量编排（ADR-011、roadmap P3） | 📅 |
| C10 | `match.query`（预留位）改为 **`match.params`** 并落地：按「请求入参」匹配（query + body 合并） | 控制台与用户心智里 query + body 就是一个「入参」，拆两个字段会逼 UI 维护两处（ADR-016） | ✅ |
| C11 | Rules 多返回值落地：`action.mode` 新增 **`specific`**（多条中指定一条）+ `action.pinIndex`；`responses[]` 新增 `name`（备注，仅展示） | 控制台要支持「多个返回值：指定某个 / 按顺序命中 / 拖动排序」（ADR-025） | ✅ |
| C12 | 管理面新增**单条写端点**（`POST /rules` 新建、`PUT /rules/:id` 整条替换）；`responses[]` 新增 **`cond`** 存位（`query` / `content`），**只存不选路** | mock CLI 的 `api create/update/copy` 要「读一条改一条写回」，只有全量 PUT 就会覆盖别人改的规则（ADR-019 的同类事故）；`cond` 先行占位保证往返不失真，选路随 P4（ADR-028） | ✅（端点与存位）/ 📅（按条件选路，P4） |
| C13 | 新增**分组模型**：`Group`（§5.5）+ 规则可选字段 **`groupId`** + 管理面 `/__ec/api/groups*`（§4.7）。分组开关**参与命中**：规则生效 = `rule.enabled` 且其所属分组（若有）`enabled` | 「分组 → 模块 → 一组 mock 列表」中的最上层容器；「模块」= 既有的 `Rule`，「一组 mock 列表」= 既有的 `action.responses[]`，都不重造（ADR-030） | ✅（服务端 + CLI）/ ✅（控制台 UI：C14 阶段 C 的「我的项目 / 共享项目」两栏就是这层容器的界面，私有项目即 C13 的 group） |
| C14 | **项目分私有 / 共享**：`Group` 增加 `scope` / `ownerPhone` / `createdBy` / `currentVersionId` / `originSharedProjectId`（§5.5）+ 数据面候选集收窄为「当前设备 owner 的、已启用的 private 项目里的规则」（§5.4）+ 管理面新增 copy / share / versions / rollback / archive（§4.7）+ `PUT /__ec/api/rules` 作用域从全表改为**只替换调用者的私有规则** | 多人共用实例时互不干扰，且能复用他人分享（ADR-033） | ✅（**服务端 + 控制台 + mock CLI 已实现**，roadmap P7 阶段 B / C / D：`tsc` ×2、`tools/selftest.ts` 515 项、`console-mock-check.mjs` 153 项、`tools/mock-cli/selftest.ts` 514 项全绿；控制台在真实页面上走过建项目 / 保存 / 分享 / 覆盖 / 复制 / 回退 / 归档 / 删项目 / 抽屉预检 / 换手机号隔离）/ 📅（真机 SDK 链路验收、控制台像素级视觉与拖拽手感；远端部署实例 + 双手机号 + 模拟设备头的多账号验收已于 2026-10-16 跑通 28/28） |

**实施顺序**：C1–C8 已随 P0.1/P0.2/ADR-015 落地（SDK 侧两项待真机验收），C9 在对应里程碑落地。
v2 定稿后不再做破坏性变更。C10 不构成破坏性变更——`match.query` 在 v2 中**从未被实现**，
改名不产生迁移成本。C11 同样非破坏性：只新增可选字段与一个 `mode` 取值，
`mode: 'static' + action.response` 的存量规则解析路径**一字未改**。
C12 也不破坏：两个新端点是**纯新增**（旧的 `PUT /rules` 一字未改），`cond` 是可选字段——
不认识它的旧客户端与旧规则照常工作（§9：扩展位未实现前必须被忽略），数据面选路逻辑不变。
C13 同样非破坏：`groupId` 是**可选字段**，存量规则不带它 = 未分组，行为逐位不变；
`/__ec/api/groups*` 是纯新增端点。唯一改变命中语义的是「带 `groupId` 且该组被关闭」这一种情形，
而那是本特性的目的本身，不是副作用（§5.4「分组参与命中」）。
⚠️ 但「C13 非破坏」成立的前提是「不带 `groupId` 照常命中」这一条，**C14 把它撤了**：
C13 时代写下的无 `groupId` 规则升到 C14 后不再命中，要靠启动迁移收进共享容器才有明确去处（见下）。

**C14 是本项目第一次真正的破坏性变更，但破坏面严格限定在「服务端本地能力」一侧**（§9 最后一条的同一划分）：

- **SDK 侧字节级不变**：`Rule` 的形状、`match` 语义、`X-EC-*` 头、mock 响应结构一字未改，
  Android / iOS SDK **零改动**，因此**协议主版本号仍是 `2`**（§9 的「不兼容变更」指的是 SDK↔服务端契约，
  把它抬到 3 会让所有旧 SDK 无谓地 fail-open 停引流）；
- **管理面与控制台是破坏性的**（✅ 服务端、控制台与 mock CLI 均已按新口径实现，见 §4.7 开头）：
  `PUT /__ec/api/rules` 的语义从「全表替换」变成「只替换调用者的私有规则」，
  规则与项目的可见范围按会话收窄。不认识 C14 的旧客户端**不会**再看到全部规则，
  也**不能**再全表覆盖——这是有意的（ADR-033 决策 7），不做兼容保留；
- **数据面命中语义变更 + 迁移是行为破坏**（✅ 服务端与启动迁移已生效；✅ README 升级提示已写）：
  升级后旧的全局规则与旧分组一律迁成 shared，**不再直接命中**，
  每个用户要复制到私有项目才恢复 mock。§4.7「迁移」小节与 README 的升级提示是这条的交付物，
  漏写就表现为「所有人的 mock 突然全失效」。启动横幅已经把迁了多少条打出来了，
  README 的升级提示（mock CLI 段落末尾：迁进 `g_legacy_shared` 后先 `copy` 再归档）也已到位。

---

## 1. 设计前提

EasyCharles 不做 TLS 中间人。App 内的 SDK 把请求**显式改写**发往本地服务，本地服务再转发到
真实服务器。因此：

- 客户端 → 本地服务：明文 HTTP（或可选 HTTPS + 自签证书，仅限 debug 构建信任）
- 本地服务 → 真实服务器：原始协议，原样转发
- **不使用 CONNECT 隧道**，不涉及证书信任链，不受服务端证书绑定（pinning）影响

能力边界：只能抓"接入了 SDK 的 HTTP 流量"。非 HTTP 私有协议（如 IM 长连接信令）、
未接入 SDK 的三方组件流量不在覆盖范围内（ADR-001）。

---

## 2. 传输通道

| 通道 | 用途 | 协议 | 路径 | 鉴权 |
|---|---|---|---|---|
| 数据面 | 请求转发与记录 | HTTP | `/*`（代理前缀 `/__ec/p`） | **不鉴权**（依赖监听地址边界，见 §7） |
| 控制面 | 设备注册、心跳、实时推送、下发指令 | WebSocket | `/__ec/ws` | SDK `hello` 免鉴权；控制台 `subscribe` 必填登录会话 `payload.session` |
| 管理面 | 控制台 API 与静态资源 | HTTP | `/__ec/api/*`、`/` | `/__ec/api/login` 免鉴权；其余 API 必填 `X-EC-Session`；`/__ec/api/admin/*` 另需 `role=admin`（见 §4.6）；`/` 返回空壳页（未登录渲染登录页） |
| 快照面 | 分享出去的现场快照（只读） | HTTP | `/s/:token`（页面）、`/__ec/s/:token`（数据） | **不鉴权**（能力 URL：持有 token 即可读；只有 GET、不转发任何请求，见 §4.5） |

**关键约束：控制面与数据面分离（ADR-003）。** 控制面断线只影响推送与指令，不得影响数据面转发；
数据面保持无状态，不依赖控制面已建立。各面的鉴权口径独立（ADR-015 / ADR-017）。

**可选兼容层**：服务端可用 `--compat-route` 额外挂载第三方抓包客户端的改写路由，并用
`--compat-*` 参数配置其目标头/身份头名。该能力**不属于本协议契约**（默认关闭，仓库内不内置任何
特定客户端的协议常量），见 README。

默认单端口 `8899`，这样 `adb reverse` 只需映射一个端口。

---

## 3. 数据面

### 3.1 请求改写规则

SDK 把原始请求：

```
POST https://api.foo.com/v1/login?from=app
Host: api.foo.com
Content-Type: application/json
...
{"u":"a"}
```

改写为：

```
POST http://127.0.0.1:8899/__ec/p/v1/login?from=app
Host: 127.0.0.1:8899
X-EC-Target: https://api.foo.com/v1/login?from=app
X-EC-Device-Id: 3f2a...
X-EC-Session-Id: 9c1d...
X-EC-App-Id: com.foo.app
X-EC-Seq: 42
Content-Type: application/json
...
{"u":"a"}
```

规则：

1. scheme / host / port 替换为本地服务地址，保留原始 `path` 与 `query`，并在前面加前缀 `/__ec/p`
2. 原始完整 URL 放入 `X-EC-Target`，服务端以它为准，**不得**依赖改写后的 Host 推断目标
3. 除 `X-EC-*` 头外，其余请求头原样透传
4. body 原样透传；改动只允许来自规则引擎、加解密插件或变量编排
5. HTTP method 保持不变；重定向链每跳重写时同样适用（§3.6）

### 3.2 请求头定义（SDK → 服务端）

| Header | 必填 | 说明 | 状态 |
|---|---|---|---|
| `X-EC-Target` | 是 | 原始完整 URL，含 scheme / host / path / query。必须可被 `new URL()` 解析 | ✅ |
| `X-EC-Device-Id` | 是 | 设备持久标识，安装级 UUID，跨会话稳定（§5.3） | ✅ |
| `X-EC-Session-Id` | 是 | 会话标识，SDK 每次初始化生成 | ✅ |
| `X-EC-App-Id` | 是 | `packageName`（Android）/ `bundleId`（iOS） | ✅ |
| `X-EC-Seq` | 否 | 单调递增序号，用于排序与去重；重定向链各跳**共享同一值**（C5） | ✅ |
| `X-EC-Token` | 否 | **预留字段，当前服务端不校验**；留给后续「可选数据面鉴权」（ADR-015，roadmap P1）。SDK 在 `Config.token` 非空时照常发送 | 📅 P1 |
| `X-EC-Record-Mode` | 否 | `full` \| `meta` \| `sample`，覆盖全局配置（C3，ADR-012） | 🔧 |
| `X-EC-Redirect` | 否 | `1` 表示重定向链的非首跳（SDK 手动跟随时附加，C5/F-12），服务端据此置 `flags.redirected` | 🔧 |
| `X-EC-Timeout-Ms` | 否 | 本次请求的上游超时，覆盖服务端默认值 | 📅 P1 |

### 3.3 服务端转发规则

1. 解析 `X-EC-Target`，失败返回 `400 EC_BAD_TARGET`（✅）
2. **剥离所有 `X-EC-*` 头**，不得转发给真实服务器（✅）
3. 剥离 hop-by-hop 头：`Connection`、`Keep-Alive`、`Proxy-Authenticate`、
   `Proxy-Authorization`、`TE`、`Trailer`、`Transfer-Encoding`、`Upgrade`、
   `Proxy-Connection`（✅）
4. 用目标 URL 的 host 重写 `Host` 头（✅）
5. 请求上游时**删除或改写 `Accept-Encoding` 为 `identity`**，让上游返回未压缩内容，
   便于记录明文。返回给 App 时不再压缩（App 侧无感知，因为响应头里的
   `Content-Encoding` 已是 `identity`）（✅）
6. 上游失败（连接/DNS）返回 `502 EC_UPSTREAM_UNREACHABLE`，超时返回 `504 EC_UPSTREAM_TIMEOUT`，
   **不做重试**（重复提交风险）（✅）
7. 响应头里的 `Location` **原样透传**（相对地址就相对传），resolve 职责完全在 SDK（C5，ADR-009）
8. 数据面**不做鉴权**（ADR-015）：可及性边界完全由监听地址决定，安全模型见 §7
9. 兼容层（`--compat-route`）命中的请求同样按上述规则处理，其目标头/身份头只服务本地服务，**不得转发上游**
10. ✅ **C14 的候选集过滤（服务端已实现）**：进入规则引擎前用 `X-EC-Device-Id` 反查 owner
    （`store.deviceOwner(deviceId)`），命中候选**只**包含该 owner 的、已启用的**私有项目**里的规则
    （完整 AND 见 §5.4）。三点边界，写实现时不要越界（AGENTS.md §3）：
    - **这不是鉴权**——它只决定「用谁的规则集」，不拒绝任何请求，未绑定设备照样被原样转发上游；
      数据面**仍然不鉴权**（ADR-015 的取舍不变），也不在这里新增第四种状态；
    - 反查复用记录可见性已在用的同一个函数（`recordVisible()` 内部就走 `deviceOwner()`，ADR-032），
      **不引入第二套归属真值来源**；两处各查各的必然漂移；
    - 共享项目在这一层就被排除，因此它的顺序指针天然不推进（§4.7）
    - ⚠️ **C14 把 ADR-015 这条既有取舍的后果升了一档，如实写在这里**：设备头原本只决定
      「你能看见谁的记录」，现在还决定「跑谁的私有规则集」。因此**知道（或猜到）一个已绑定设备的
      `X-EC-Device-Id`，就等于以那个手机号空间的规则集转发请求**——伪造一个**不存在/未绑定**的 id
      什么也命中不了（owner 为 `null` ⇒ 候选集为空 ⇒ 原样转发），但拿别人的真 id 是有效的。
      兜住它的仍是 ADR-015 那三条，不是新机制：id 为**安装级 UUID 不可枚举**（§5.3）、
      默认只监听回环（推荐 `adb reverse`）、`--lan` 只在可信网络短时开启。
      要把它变成真正的凭据校验 = 数据面鉴权 = roadmap P1 的 `X-EC-Token`，**不在 C14 范围内顺手做**

### 3.4 响应头定义（服务端 → SDK）

| Header | 说明 | 状态 |
|---|---|---|
| `X-EC-Id` | 本次请求的记录 ID，可用于控制台定位 | ✅ |
| `X-EC-Mock` | `1` 表示响应来自 mock 而非真实上游 | ✅ |
| `X-EC-Upstream-Ms` | 上游耗时（毫秒） | ✅ |
| `X-EC-Decrypted` | `1` 表示 body 已被加解密插件处理过（C8，ADR-011） | 📅 P2 |
| `X-EC-Error` | 错误码，见 §6.1。成功时不存在 | ✅ |

这些头会回传给 App。App 业务代码**不得依赖**它们；SDK 也不保证未来版本中保留。

### 3.5 缓冲与流式（bounded buffering，C4 / ADR-008）

- **请求侧**：`content-length` 已知且 ≤ `maxBufferBytes`（默认 512 KB）→ 缓冲；否则 pass-through 流式转发
- **响应侧**：一律**边转发边缓冲**：
  - 累积量 ≤ `maxBufferBytes` 且 `Content-Type` 属于可解析集合
    （`json` / `text` / `form` / `xml`）→ 完整记录；
  - 累积量超阈值 → 丢弃缓冲，只保留前 `sampleBytes`（默认 8 KB）采样，
    `flags.streamed = true`、`bodyTruncated = true`；
  - `Content-Type` 不可解析（二进制）或 SSE（`text/event-stream`）→ 不累积，只采样，
    `flags.streamed = true`；
  - **`bodySize` 恒为实际传输字节数**（边转发边计数），不依赖 `content-length`（C4 修正）。
- SSE / chunked / WebSocket 升级 / 大文件下载的**传输**必须走流式，禁止整包缓冲后再转发
  （但记录侧仍按上述规则累积采样，见 ADR-008 的内存上界说明）
- 服务端内存上界 = `maxBufferBytes + sampleBytes`，与响应体大小无关

### 3.6 重定向（C5 / ADR-009）

- SDK **手动跟随**重定向（不依赖 OkHttp 自动跟随——自动跟随发生在拦截器层之下、无法带 `X-EC-Target`）
- 判定：响应为 3xx 且带 `Location`：
  - 基于**原始 URL**（`X-EC-Target` 的值）resolve 新目标；
  - 用缓冲后的 body 重建请求，更新 `X-EC-Target` 为新目标，`X-EC-Seq` 保持不变，重新 `chain.proceed()`；
  - 循环直到非 3xx，上限 **10 跳**，超限返回最后一次响应并在记录中标记；
  - 语义对齐 OkHttp：`301/302/303` → 转 GET 并丢弃 body；`307/308` → 保持 method 与 body。
- 记录：**每跳一条记录**，共享同一 `seq`；非首跳记录 `flags.redirected = true`；
  控制台按 `(deviceId, seq)` 折叠显示重定向链（P1 控制台增强）
- 服务端**不**改写 `Location`（§3.3-7）

---

## 4. 控制面

### 4.1 握手

SDK 启动时先做一次 HTTP 握手，成功后建立 WebSocket（ADR-003）。

```
POST /__ec/hello
Content-Type: application/json

{ "identity": { ...DeviceIdentity } }
```

握手**不需要凭据**（数据面/控制面 SDK 侧均不鉴权，ADR-015）。

响应：

```json
{
  "protocol": 2,
  "serverId": "srv_ab12",
  "serverVersion": "0.1.0",
  "wsUrl": "ws://127.0.0.1:8899/__ec/ws",
  "config": {
    "recordMode": "full",
    "maxBufferBytes": 524288,
    "sampleBytes": 8192,
    "heartbeatMs": 30000
  }
}
```

- `wsUrl` **按请求 `Host` 头生成**（C2 / ADR-014）：adb reverse 场景 Host 为
  `127.0.0.1:8899` → ws 走隧道；WiFi 场景 Host 为内网 IP → ws 走 WiFi
- **响应不含任何凭据**（C2）：v2 已取消 token，「控制台登录」与会话只在管理面发生（§4.4）
- `protocol` 与 SDK 支持的版本不一致时，SDK 必须 fail-open（§6.2）并提示升级（✅）

### 4.2 WebSocket 消息

统一信封，所有消息都是 JSON 文本帧：

```json
{ "v": 2, "type": "...", "id": "...", "payload": {} }
```

`id` 用于请求-响应配对，可空。

#### SDK → 服务端

| type | payload | 说明 | 状态 |
|---|---|---|---|
| `hello` | `identity` | 建立控制面后第一条消息，**免鉴权**（ADR-015） | ✅ |
| `heartbeat` | `{ "t": 1696... }` | 按 `heartbeatMs` 周期发送 | ✅ |
| `identity_update` | `identity` 增量 | 业务登录/登出后更新 `userId` 等 | ✅ |
| `log` | `{ "level": "w", "msg": "..." }` | SDK 侧诊断日志 | ✅ |

#### 服务端 → SDK

| type | payload | 说明 | 状态 |
|---|---|---|---|
| `welcome` | `{ serverId, config }` | 确认控制面建立 | ✅ |
| `heartbeat_ack` | `{ "t": 1696... }` | 原值回传 | ✅ |
| `command` | 见下 | 控制台下发指令 | ✅ |

#### 服务端 → 控制台（浏览器）

| type | payload | 说明 | 状态 |
|---|---|---|---|
| `record` | `Record` | 新请求记录实时推送 | ✅ |
| `device` | `DeviceIdentity[]` | 设备上下线 | ✅ |
| `stats` | `{ qps, total, onlineDevices }` | 周期性统计 | 📅 P1 |

#### 指令（服务端 → SDK）

| action | params | 含义 | 状态 |
|---|---|---|---|
| `set_record_mode` | `{ mode }` | 切换记录模式 | 📅 P1 |
| `reset_mock` | `{ ruleId? }` | 重置顺序 mock 指针 | ✅（全局） |
| `set_enabled` | `{ enabled }` | 远程启停引流 | ✅ |
| `disconnect` | `{}` | 服务端要求 SDK 断开控制面 | 📅 P1 |

**指令是能力协商式的**：SDK 收到不支持的 `action` 应忽略并回 `log`，不得崩溃（✅）。

### 4.3 控制台连接

- 控制台 WS 首条消息 `subscribe`（`payload.session` 必填，值为 §4.4 的登录会话），之后收到
  `record` / `device` / `stats`
- 控制台与 SDK 共用同一个 `/__ec/ws`，服务端按首条消息类型区分角色；只有控制台侧校验会话，
  校验失败 `ws.close(4001)`，前端据此引导重新登录
- **推送按用户空间过滤**：只推送该会话所属手机号已绑定设备的记录（§4.4）
- **心跳要求**：控制台也需周期性发送心跳或依赖协议层 ping/pong，服务端不得在静默后误踢
  （关联 ADR-003，roadmap P0.1-07）

### 4.4 控制台登录与用户空间（ADR-015）

管理面会话模型（`/__ec/api/*`）：

| 接口 | 方法 | 鉴权 | 说明 |
|---|---|---|---|
| `/__ec/api/login` | POST | 免鉴权 | body `{ phone, password }`；**首次登录即注册**该手机号空间；成功返回 `{ session, user }`，`user.role` 见 §4.6 |
| `/__ec/api/logout` | POST | 会话 | 销毁当前会话 |
| `/__ec/api/me` | GET | 会话 | 返回当前用户（含 `role`） |
| `/__ec/api/info` | GET | 会话 | 服务端信息：`protocol` / `serverVersion` / `host` / `port` / `lanMode` / `recordMode` / `snapshotTtlMs` / `sessionTtlMs`。**不含全局统计**（全局量只在 §4.6 下发） |
| `/__ec/api/devices` | GET | 会话 | 返回**当前空间可见**的设备：自己绑定的 + 未被任何人绑定的（可认领）；`role=admin` 返回全量。见下「设备可见性」 |
| `/__ec/api/devices/:deviceId/bind` | POST | 会话 | 把设备绑定到当前空间（设备不存在 → `ok:false`）。**一个空间同时只绑一台**：绑定成功时自动解掉该用户名下的其它设备（含这次没连上来的），返回 `{ ok, unbound }`，`unbound` 是被自动解绑的 deviceId 列表（没有则 `[]`），见下「设备归属」 |
| `/__ec/api/devices/:deviceId/unbind` | POST | 会话 | 解绑（仅限自己绑定的设备） |
| `/__ec/api/records` | GET | 会话 | 按用户空间查询记录（`limit` / `deviceId` / `q`）；默认 `limit=300`、上限 1000。**只返回当前空间绑定设备的记录**；未绑定设备仅展示在设备列表中 |
| `/__ec/api/records` | DELETE | 会话 | 清空当前空间内命中筛选（`deviceId` / `q`）的记录，返回 `{ ok, cleared }` |

- **清空记录的口径**：`DELETE /__ec/api/records` 的 `owner` 恒为会话手机号，绝不跨空间；
  `deviceId` / `q` 可选且与列表查询同源（`q` 按 url / status 模糊），不传则清该空间全部。
  口径与查询一致：只有当前空间绑定设备的记录可见、可清；未绑定及他人已绑定设备的记录均保留。

- **设备可见性（ADR-018）**：`GET /__ec/api/devices` **不是**全量列表。普通用户看到的是
  `owner === 自己` **或** `owner == null`（未绑定）的设备；**他人已绑定的设备不下发**。
  保留「未绑定」这一类是必须的——否则「登录 → 看到新设备 → 绑定」这条主流程会被堵死
  （看不到就绑不了）。`role=admin` 时返回全量。控制面 WS 的 `device` 推送按**同一口径逐连接过滤**
  （每个 console 连接收到的是它自己该看的那份，不是广播）

- **认证凭据**：`X-EC-Session` 请求头 / WS `payload.session`；会话表**落盘** `.data/store.json`
  （`sessionId → { phone, expiresAt }`），受 `--session-ttl`（小时，默认 720 = 30 天，`0` = 永不过期）约束。
  **服务重启后同一个 token 继续有效**，浏览器无需重新登录（ADR-031）；
  过期、`logout`、换 dataDir 或手工改过 `store.json` 才失效
- **口令**：`--password`（默认 `123456`），全局单一口令，**不是**每用户密码；生产/共享网络下必须修改
- **用户空间**：手机号即空间。记录查询、详情读取与实时推送只允许 `deviceId → 当前手机号` 的记录。
  未绑定设备仍显示在设备列表中以供显式绑定，但其请求不进入浏览 / Mock 接口列表、不推送、不可清理或创建快照；
  绑定后该设备已有记录与后续记录才对当前空间可见。解绑或换绑后，旧设备记录保留但对该空间不可见。
- **设备归属**：`deviceId → phone`，随 `deviceId` 持久化（`.data/store.json`），跨重启保留；
  同一设备改绑后旧空间不再可见其记录；**一个空间同时只绑一台**（绑新自动解旧，旧设备回到「未绑定」，
  其记录保留但直到再次绑定前不对普通空间可见）
- 会话与口令都**不进 URL**（避免落日志）
- **CLI 的浏览器登录接力不新增任何端点（ADR-029）**：`mock login --browser` 让控制台页面把
  已有的会话 POST 回**本机** `http://127.0.0.1:<一次性端口>/ec-cli-callback`，
  服务端既看不到这次交接、也不参与换取会话（nonce 走 `#hash`，不进访问记录）。
  上表就是管理面的**全部**端点：不存在「拿 nonce 换 session」这类免凭据入口；
  CLI 拿到 token 后仍按 `X-EC-Session` 走 `/__ec/api/me` 核实身份。

### 4.5 现场快照分享（ADR-017）

排查问题时需要把「一条请求 + 响应」直接发给同事看。快照把**某一条记录在创建那一刻**冻结成
一份只读副本，并给出一条**打开即读、不需要登录**的链接（能力 URL）。

| 接口 | 方法 | 鉴权 | 说明 |
|---|---|---|---|
| `/__ec/api/snapshots` | POST | 会话 | body `{ recordId, title? }`；把该记录冻结为快照。**记录必须来自当前空间绑定设备**，否则 `403 EC_UNAUTHORIZED`；记录不存在 / 已被淘汰 → `404`。返回 `{ token, createdAt, expiresAt, urls }` |
| `/__ec/api/snapshots` | GET | 会话 | 列出**自己创建**的快照摘要（含候选 `urls`）；**不含 body，也不含 `createdBy`**。控制台不展示列表，此接口供脚本 / 管理使用 |
| `/__ec/api/snapshots` | DELETE | 会话 | 清空自己创建的全部快照，返回 `{ ok, cleared }` |
| `/__ec/api/snapshots/:token` | DELETE | 会话 | 失效单条；**仅创建者本人**可失效，他人调用返回 `{ ok:false }` |
| `/__ec/s/:token` | GET | **免鉴权** | 读取快照 JSON（`{ token, createdAt, expiresAt, title, record }`）；不存在 / 已过期 → `404 EC_SNAPSHOT_NOT_FOUND` |
| `/s/:token` | GET | **免鉴权** | 只读查看页（静态壳，页面自己再取 `/__ec/s/:token`） |

- **快照面只有 GET、不转发任何请求**，因此**不能**被当作开放中转代理滥用——这是它与数据面
  （§3，无鉴权但可转发）的本质差别，新增此面不放大 §7 的风险边界
- **token 即凭据**：128 位随机（32 位十六进制，`randomUUID` 去横线），不可枚举。
  链接打开即读，请只在可信范围内转发；失效走管理面 `DELETE`（控制台不提供管理入口，只负责生成）
- **`createdBy` 不下发**：创建者手机号只用于服务端归属校验，**不出现**在免鉴权的快照页，
  管理面列表也不回（控制台不展示列表，也不需要知道）
- **冻结副本**：与内存环形缓冲解耦——源记录被淘汰、服务重启后链接依然打得开
- **有效期与上限**：`--snapshot-ttl`（单位小时，默认 `168` = 7 天，`0` = 永不过期）、
  `--snapshot-max`（默认 `200`，超出按最旧淘汰）。过期项在读取时顺手清理，另有 10 分钟兜底清扫
- **响应头**：页面与 JSON 一律 `cache-control: no-store`、`x-robots-tag: noindex, nofollow`、
  `referrer-policy: no-referrer`
- **敏感头原样保留**：`authorization` / `cookie` 等**不**打码（排障需要原文），
  风险由「创建是显式动作 + 页面显著警告 + 随时可失效」承担
- 与 §4.4 同级：这是**服务端本地能力**（控制台 ↔ 服务端），**不在 SDK ↔ 服务端契约内**，
  SDK 无需实现任何东西

### 4.6 控制台角色与管理员接口（ADR-018）

控制台有**两个角色**：`admin`（管理员）与 `user`（普通使用者，默认）。

| 接口 | 方法 | 鉴权 | 说明 |
|---|---|---|---|
| `/__ec/api/admin/overview` | GET | 会话 + **admin** | 全局统计 + 用户空间列表；非 admin → `403 EC_UNAUTHORIZED` |

- **角色来源 = 启动参数，不落盘、不兜底**：`--admin <手机号>[,<手机号>...]`。
  角色**不写进 `store.json`**，唯一真值来源是启动参数；**未配置 `--admin` 时没有任何管理员**，
  管理入口不会出现。刻意**不**做「首个注册用户即管理员」——LAN 下「谁先登录谁是」是竞态，
  等于给抓包代理一个意外的权限提升
- **管理员是可选的**：未配置 `--admin` 时，除 `/__ec/api/admin/*`（一律 403）与管理面板入口外，
  其余能力**完全不受影响**——登录、记录、设备绑定、全局 Mock 规则、快照分享都照常。
  管理员是增强，不是使用前提
- **`role` 的下发位置**：`POST /__ec/api/login` 与 `GET /__ec/api/me` 的 `user.role`
  （`'admin' | 'user'`，缺失视为 `'user'`）。`store.User` 本身不含该字段
- **强制点在服务端**：`/__ec/api/admin/*` 由服务端校验角色，非 admin 返回 403。
  控制台隐藏入口只是 UX，**不是权限**（`curl` 带上会话即可验证）
- **`overview` 响应**：

```jsonc
{
  "server":  { "version": "0.1.0", "protocol": 2, "uptimeMs": 123456 },
  "config":  {                     // 当前生效的全局配置（**只读展示**）
    "host": "0.0.0.0", "port": 8899, "lanMode": true, "lanAddresses": ["10.0.0.1"],
    "recordMode": "full", "maxRecords": 2000, "maxBufferBytes": 524288, "sampleBytes": 8192,
    "upstreamTimeoutMs": 30000, "heartbeatMs": 30000,
    "snapshotTtlMs": 604800000, "snapshotMax": 200,
    "adminPhones": ["13800000000"], "compatRoutes": ["/mock-proxy"], "compatAppId": "external-client",
    "dataDir": "/abs/path/.data"
  },
  "stats":   { "records": 42, "devices": 3, "online": 1 },   // 全局量（不再随 /__ec/api/info 下发）
  "snapshots": { "count": 2 },
  "rules":   { "count": 5 },
  "spaces":  [ { "phone": "13800000001", "createdAt": 1, "lastLoginAt": 2,
                 "devices": 2, "online": 1, "records": 30 } ]
}
```

- **`config` 是只读展示**：字段全部来自启动参数，进程内不可变。「管理员在控制台改全局配置」
  需要引入**运行时可变配置 + 落盘 + 生效范围**（哪些改完要重启），属于另一件事，见 ADR-018

- **设备可见性随角色不同**（见 §4.4「设备可见性」）：普通用户只看「自己绑定的 + 未绑定的」，
  `admin` 看全量
- 与 §4.4/§4.5 同级：**服务端本地能力**，不在 SDK 契约内

### 4.7 Mock 规则管理（ADR-019 → C14 / ADR-033）

规则 schema 与匹配语义见 §5.4。这里只列**管理面**的读写接口。

> **两代口径并存，逐行标注**：
> - ✅ **现状（ADR-019）**：规则是**全局的**，对所有设备、所有登录用户可见可写，不按用户空间隔离。
> - ✅ **C14 / ADR-033（服务端 + CLI + 控制台）**：规则的可见与可写范围收窄到**调用者自己的私有项目**；命中口径见 §5.4，权限矩阵见下。
>   **阶段 B（2026-10-16）已把服务端做到目标态，阶段 D（2026-10-16）把 mock CLI 也改完了**：
>   下面标「✅ C14」的行是服务端当前真实行为，控制台（阶段 C）与 CLI（阶段 D）均已按新模型实现。

| 接口 | 方法 | 鉴权 | 说明 |
|---|---|---|---|
| `/__ec/api/rules` | GET | 会话 | ✅ C14：**只返回调用者自己的私有规则**（`Rule[]`，§5.4）；共享规则改由 `/__ec/api/groups/:id/rules` 按项目读取，不再有「一次拿到全服所有返回值」的入口 |
| `/__ec/api/rules` | PUT | 会话 | body `{ rules: Rule[] }`，✅ C14 **调用者私有规则范围替换**（取代 C13 的全量替换）：输入里每条规则必须属于调用者的私有项目，出现「无 `groupId` / `groupId` 指向共享项目 / 指向他人项目 / 重复 id」任一项 → `400 EC_SCOPE_MISMATCH` 且**一条也不写**；提交时**只替换该调用者的私有规则**，共享项目、他人规则与迁移前遗留的无归属脏条目逐条原样保留。成功回 `{ ok:true, replaced, preserved, count }`——`replaced` = 本次提交条数、`preserved` = 原样留下的**别人/共享/无归属**条数（控制台要靠这两个数解释「为什么列表里还有我看不见的条目」）。⚠️ 替换是「私有范围内给什么存什么」，**不是按 id 合并**：没出现在提交清单里的自己的旧规则就是被删掉了。校验口径不变：非数组 / 条目非对象 / `match.params` 非对象 / `action.responses` 非数组或元素非对象 / `action.pinIndex` 非有限数 / `action.responses[].cond` 非对象 → `400`（防毒化内存与 `rules.json`，F-15）。**实现这条之后不再存在任何能让普通用户全表覆盖 `rules.json` 的路径**（ADR-033 决策 7）|
| `/__ec/api/rules` | POST | 会话 | body `{ rule: Rule }`，**新建单条**（C12）。id 由**服务端**生成（格式与控制台一致 `r_<base36>`，且保证不与现有 id 相撞）并回 `{ ok:true, rule }`；`rule` 非对象 / 结构非法 → `400`（与 PUT 同一套校验）。**`rule.id` 非空 → `400`**：新建不接受调用方指定 id——撞 id 会让「删除 / 开关」只命中第一条，比报错更难查。复制一条请用 POST 并去掉 id。✅ C14：`rule.groupId` 必须指向**调用者的私有项目**，缺失或指向他人 / 共享项目 → `400 EC_SCOPE_MISMATCH`（共享内容只能经 share 提交）|
| `/__ec/api/rules/:id` | PUT | 会话 | body `{ rule: Rule }`，**整条替换**（C12）：给什么存什么，未提供的字段就是没有。**省略 `enabled` 等于这条规则不生效**（`resolve()` 只认真值，与全量 PUT 同一口径）。**id 以路径为准**：`rule.id` 缺失 → 用路径 id 补上；`rule.id` 与路径不一致 → `400`（否则「改 A」会变成「新增 B + A 原封不动」这种更难查的结果）；id 不存在 → `404`；结构非法 → `400`。成功回 `{ ok:true, rule }`。✅ C14：该规则不属于调用者私有项目 → `404`（与「不存在」同一响应，不泄露他人规则的存在性）；**`groupId` 不得改成别的项目**——跨项目挪规则等于把别人的私有规则搬走；**body 不带 `groupId` 时按原项目补齐**（故意偏离「给什么存什么」：新模型里无归属 = 永不命中，让「忘记带这个字段」能把一条在用的规则悄悄改成不生效，正是 §5 定义的静默失效）|
| `/__ec/api/rules/:id` | DELETE | 会话 | 删除单条 → `{ ok:true, count }`；id 不存在 → `404`。同时丢弃该规则残留的顺序指针。✅ C14：非调用者私有规则 → `404`（与不存在同形）|
| `/__ec/api/rules/:id/enabled` | POST | 会话 | body `{ enabled: boolean }`，单条开/关 → `{ ok:true, rule }`；`enabled` 非布尔 → `400`；id 不存在 → `404`。✅ C14：非调用者私有规则 → `404` |
| `/__ec/api/rules/reset-pointers` | POST | 会话 | 重置顺序 mock 指针。✅ C14：收窄为**只重置调用者私有规则**的指针，回 `{ ok:true, clearedFor }`（= 清掉的**条数**，让控制台能区分「我本来就没规则」和「清了 N 条」）；共享项目永不推进指针（§5.4），他人私有指针不受影响 |


#### 项目：私有 / 共享（C13 → C14 / ADR-030 → ADR-033）

C13 里这个容器叫「分组」，C14 之后文档与控制台叫它**项目**——**同一个 `Group` 实体、同一张 `groups.json`、
同一批 `/__ec/api/groups*` 路由，不改名也不新增实体**（改了就把 CLI 的 `mock group` 与存量数据劈成两半）。
项目分两档：`private` 属于一个手机号空间、参与命中；`shared` 本实例所有登录用户可读、**永不直接命中**。

| 接口 | 方法 | 鉴权 | 说明 |
|---|---|---|---|
| `/__ec/api/groups` | GET | 会话 | ✅ C14 返回**调用者看得见**的 `Group[]`（§5.5）+ 每条附带 `ruleCount`；`?scope=private\|shared` 过滤，`private` 只回调用者自己的，`shared` 回全部共享项目（含归档，归档由 `archived` 字段体现，不是隐藏）。他人私有项目**连存在都不下发**。`createdBy` 不是本人时**在服务端脱敏**成 `138****0000`。列表**只回元数据与 `ruleCount`，不回各项目的完整 response body**（共享库变大后一次全量下发就是把所有人的返回值整片搬进内存与日志）|
| `/__ec/api/groups` | POST | 会话 | body `{ group: Group }`，**新建**；id 由服务端生成（`g_<base36><4 位随机>`，同规则的分配口径，保证不撞）。`group` 非对象 / `name` 非字符串或全空白 / **`enabled` 不是布尔（含缺失）→ `400`**。新建**不给 `enabled` 隐式默认值**：分组表是新表，没有 `rules.json` 里「存量条目不带 enabled」那个历史包袱，留一个隐式默认就等于让「没给开关」有两种结果，读回校验对不上。**`group.id` 非空 → `400`**（与规则同一条理由）。✅ C14：**只允许创建 private**；body 出现 `scope` / `ownerPhone` / `createdBy` / `currentVersionId` / `lineage` / `originSharedProjectId` / `copiedFromVersionId` / `archived` / `createdAt` / `updatedAt` 任一项 → `400 EC_SCOPE_MISMATCH`（**不是静默丢弃**：丢弃会让「我提交了 ownerPhone，服务端按会话手机号覆盖」这件事在客户端完全不可见，而脚本作者会以为自己成功劫持了归属），`ownerPhone` / `createdBy` 恒为会话手机号，时间戳恒为服务器时钟 |
| `/__ec/api/groups/:id` | PUT | 会话 | body `{ group: Group }`，**整条替换**（改名 / 改开关，校验与 POST 同口径）。id 以路径为准：body 里 id 缺失则补齐、不一致则 `400`、不存在 `404`、结构非法 `400`。时间戳是服务端管的：`createdAt` 恒保留原值、`updatedAt` **一律覆盖为 now**（让调用方写就能被伪造成任意时间）。✅ C14：private 仅 owner 可改；**shared → `409 EC_PROJECT_READONLY`**，共享内容只能由 share / rollback 提交；非 owner 的 private → `404`（与不存在同形）。这条接口**改不了 `scope`**（黑名单字段照旧 400）|
| `/__ec/api/groups/:id/enabled` | POST | 会话 | body `{ enabled: boolean }`，**整组开/关** → `{ ok:true, group, affected }`（`affected` = 该组当前规则数）。`enabled` 非布尔 → `400`；id 不存在 → `404`。✅ C14：只对 private 有意义；**shared → `409 EC_PROJECT_READONLY`**（它不参与命中，给它一个开关就是造一个永远不会被读的字段）；非 owner → `404` |
| `/__ec/api/groups/:id/archive` | POST | 会话 | ✅ C14 **新增**：body `{ archived?: boolean }`（**缺省视为 `true`**，取消归档要显式给 `false`），只对 shared 有意义 → `{ ok:true, group, ruleCount }`。`archived` 非布尔 → `400`；**private → `409 EC_PROJECT_READONLY`**（私有区没有归档语义，要处置就删）；未登录会话 → `401`。**归档 ≠ 删除**：快照、历史与分享记录一条都不动，之后仍可查历史、仍可回退 |
| `/__ec/api/groups/:id` | DELETE | 会话 | ✅ C14 按 scope 分两条完全不同的路，**C13 的 `ungrouped`（清空 `groupId`、规则保留）已删除**——新命中口径下「脱组」= 规则失去归属，于是**永远命中不了而控制台仍显示已启用**（ADR-033 决策 6）：<br>· **private** → **立刻物理删除**：先删项目内的规则（级联），再删项目，回 `{ ok:true, pendingDelete:false, removedRules }`；顺序不能反（反过来的中间一拍是悬空 `groupId`）；非 owner → `404`。<br>· **shared** → **软删除（待删除）**（ADR-037）：只给项目打上 `pendingDeleteAt` / `purgeAt`（= now + 7 天），**规则、历史版本、快照一条都不动**，回 `{ ok:true, pendingDelete:true, group, purgeAt, ruleCount }`。7 天内任何人可 `POST /:id/restore` 恢复；到期仍无人恢复，服务端才真正删除（项目 + 其规则 + 历史快照）。<br>· 重复 DELETE 同一 shared 项目**幂等**：不改写已定的 `purgeAt`（否则反复点删除 = 永远不过期）；`g_legacy_shared`（迁移容器）→ `409 EC_PROJECT_READONLY`（它装着全服的存量规则，不是任何人建的） |
| `/__ec/api/groups/:id/restore` | POST | 会话 | ✅ ADR-037 **新增**：取消 shared 项目的待删除状态，清掉 `pendingDeleteAt` / `purgeAt` → `{ ok:true, group, ruleCount }`。未登录 → `401`；项目不存在 → `404`；private → `409 EC_PROJECT_READONLY`（私有项目是立刻物理删除，没有「待删除」这一档）；本来就不在待删除 → `ok:true` 原样返回（幂等，不报错）。规则与历史从未被改动，恢复即恢复原状 |

✅ **C14 新增端点**（阶段 B 服务端已实现；全部走 §4.4 同一套会话鉴权，**绝不在数据面新增项目接口**，AGENTS.md §3）：

| 接口 | 方法 | 鉴权 | 说明 |
|---|---|---|---|
| `/__ec/api/groups/:id` | GET | 会话 | ✅ C14 **新增单项目详情**：回项目元数据 + `ruleCount` +（shared）`currentVersionId`，`createdBy` 按他人脱敏。private 非 owner → `404 EC_PROJECT_NOT_FOUND`；不返回完整 body（要 body 用 `/:id/rules`）|
| `/__ec/api/groups/:id/rules` | GET | 会话 | ✅ C14 按项目读规则（含完整 `response` / `responses`）。shared 所有登录用户可读；private 非 owner → `404 EC_PROJECT_NOT_FOUND`；写方法 → `405` |
| `/__ec/api/groups/:sharedId/copy` | POST | 会话 | body `{ operationId }`，**不接收客户端上传的项目内容**：服务端从存储读该 shared 项目的当前内容，新建 `ownerPhone = 会话手机号` 的 private 项目（名 `${源}(副本)`：共享库与我的项目里会出现两个同名「登录」，点错的成本远高于多看五个字的成本），复制全部规则 / 入参条件 / headers / body / `responses[]` / 顺序配置 / 每条规则的 `enabled`，为规则分配**新的本地 id** 并保存 `lineage`（§5.5）。回 `{ ok:true, replayed, group, rules, copiedFromVersionId }`。源不是 shared（拿自己的 private 当源）→ `400 EC_SCOPE_MISMATCH`；源是他人 private → `404`；`operationId` 缺失 / 空白 / 非字符串 → `400`。复制事件**不是 share 事件**：不写版本、不改源项目与其历史、不推进任何指针 |
| `/__ec/api/groups/:privateId/share` | POST | 会话 | body `{ operationId, expectedSharedVersionId? }`，同样**不接收客户端提交的完整 `Rule[]`**（否则任何登录用户都能往共享库塞任意内容）。无来源的 private = **首次发布**（创建 shared 项目 + 第一个 `publish` 版本，并回填 private 的 `originSharedProjectId` / `lineage`）；有来源 = **整项目覆盖**（last write wins，不做三方合并）。依 `lineage` 把已有规则**还原成原共享 id**、新规则分配新共享 id、本地已删的映射规则从共享清单里消失；映射里的共享 id 若已被**别的项目**的规则占着则重新分配（宁可得多一条新号，也不能一次分享写出两个同 id 规则）。回 `{ ok:true, replayed, sharedProject, version, actor, createdAt, privateProject }`——**分享时间与版本 id 由服务端产生，前端不得自造**，`actor` 是脱敏后的操作人。带 `expectedSharedVersionId` 且服务端当前版本已变 → `409 EC_CONFLICT`（给脚本的乐观锁）且**零副作用**；不带则**按用户确认执行覆盖**，控制台必须先展示「目标已有新版本，将以当前私有项目完整覆盖」+ 接口数增删再二次确认（§6.3 of 计划）。private 非 owner → `404`；直接 share 一个 shared 项目 → `409 EC_PROJECT_READONLY` |
| `/__ec/api/groups/:sharedId/versions` | GET | 会话 | ✅ 历史元数据数组（`id` / `projectId` / `operation` / `parentVersionId` / `actorPhone`（**服务端脱敏**）/ `createdAt` / `ruleCount` /（回退产生的版本）`rollbackOf`），按 `createdAt` 升序，**不含完整快照 body**（`snapshotFile` 是服务端内部布局，从视图里剔掉才下发）；写方法 → `409 EC_PROJECT_READONLY`（历史是 append-only）|
| `/__ec/api/groups/:sharedId/versions/:versionId` | GET | 会话 | 回退预览：`{ version, group, rules }`，**只读**；任何写方法 → `409 EC_PROJECT_READONLY`。历史索引里有、快照文件被删或被改坏 → `404 EC_PROJECT_NOT_FOUND`（文案标 `corrupt snapshot`，**不做「用当前内容顶上」这种兜底**）|
| `/__ec/api/groups/:sharedId/rollback` | POST | 会话 | body `{ versionId, operationId }`：把该版本快照恢复为当前 shared 内容，**追加一条 `operation: 'rollback'` 版本**并记 `rollbackOf`，旧版本全部保留、之后仍可再回退（含回退到更早的点）。允许从任意历史点起跳。回 `{ ok:true, replayed, sharedProject, version, actor, createdAt, rules }`。版本不属于该项目 → `404`（历史查询始终限定在 `projectId` 之下）；目标是 private → `409`；校验失败或落盘失败 → `500` / `507 EC_STORAGE_UNAVAILABLE`，且 active rules、`currentVersionId`、history **三者一字未改**（不许「几条成功几条失败」）|

- **关组不改写规则**：`group.enabled` 与 `rule.enabled` 是**两个字段、一条 AND**（§5.4）。
  关组时服务端**不**把组内规则的 `enabled` 写成 `false`，重开即恢复原状。若写成联动，
  「组开着但某条规则本来就该关」这种状态就无法表达，且重开组会把用户本来关掉的规则打开——
  那是比单一真值来源更糟的破坏。C14 之后仍然成立，只是这条 AND 前面还多了一项「项目是私有且属于我」
- **`affected` / `removedRules` / `replaced`+`preserved` / `copiedFromVersionId` / `version` 必须回**：CLI 与控制台要靠它判断
  "这次动了几条、现在到底是哪一版"，不能只信 `ok:true`（同 ADR-028 的读回校验精神）。
  C13 的 `ungrouped` 已随「脱组」一起删除，别再按它写代码
- **顺序 mock 指针不因关组而重置**：指针是 `(deviceId, ruleId)` 的下标状态（ADR-004），
  组开关只影响是否参与匹配，不该打断别的设备正在走的序列。✅ C14 追加：**shared 项目的指针永不推进**——
  它不参与命中，任何"预览时顺手推进共享序列"的实现都会让后来复制者拿到的起点偏移；
  `reset-pointers` 也只清调用者私有规则的指针（旧的「一键清全服」在隔离之后就是越权：
  A 重置会把 B 正在走的序列归零，而 B 的控制台上什么都看不出来）
- **`operationId` 幂等是硬要求**（✅ 服务端已实现：`projects/journal.json` 的回执表）：CLI 与 agent 会超时重发。
  同一 `operationId` 重复提交必须返回**首次那笔的结果**并标 `replayed: true`，**不得生成第二个版本、不得写第二条审计**。
  落盘跨 `rules.json` / `groups.json` / 快照三个写入点，中断时用 pending journal 恢复（§5.5）
- **他人私有项目按「不存在」响应**：`404`，与真的不存在同形，避免用 `403` 泄露「这个 id 属于别人」
- 落盘：**独立的 `groups.json`**，`rules.json` 的数组形状一字未改——否则 ADR-028 建立的
  「写进去再读回来逐字节比对」的口径会因文件结构变化而失真。✅ C14 另加共享库的**版本快照目录**与
  **pending journal**（同在 `.data/` 内，不新增顶层目录、不引入配置文件格式，见 §5.5）
- ✅ **C14 权限矩阵**（服务端强制，前端隐藏只是 UX，AGENTS.md §4）：

| 操作 | 自己的 private | 其它用户 private | shared |
|---|---|---|---|
| 列表 / 详情 / 规则 | 允许 | 不可见（`404`） | 所有登录用户可读 |
| 编辑接口与返回值 | 允许 | 拒绝 | 直接编辑 `409 EC_PROJECT_READONLY` |
| 数据面命中 | 当前设备 owner 匹配时可用 | 不可用 | **永不直接命中** |
| copy | 不适用 | 不适用 | 所有登录用户可复制到自己的 private 区 |
| share | 发布 / 覆盖其来源 shared | 拒绝 | 不能直接提交 shared 内容 |
| rollback | 不适用 | 拒绝 | 所有登录用户可回退任意历史版本，逐次留痕 |
| 删除 | 允许（**立刻**级联处置自己的规则，回 `removedRules`） | `404` | 所有登录用户可发起**软删除**（待删除 7 天，`POST /:id/restore` 可恢复）；到期无人恢复才真删（项目 + 规则 + 历史快照）。迁移容器 `g_legacy_shared` 除外 → `409` |
| 恢复（待删除） | 不适用（没有这一档） | 拒绝 | 所有登录用户可恢复，直到 `purgeAt` 到期 |

  **矩阵的推论要如实写在这里**：任何登录用户都能 copy，而覆盖走「本地副本整体提交」，
  所以**任何登录用户事实上都拥有覆盖与回退共享项目的权限**。这不是管理员权限，也没有维护者 ACL
  （加了就推翻已确认的「自由覆盖 / 自由回退」口径）；共享项目因此**不是受保护的主分支**，
  安全性靠「服务端逐端点鉴权 + 每次操作留 actor/time/version + 历史可回退」兜住（ADR-033 决策 5）
- ✅ **C14 迁移口径**（服务端已在 `listen()` 之前执行，并在启动横幅如实报动过几条；
  控制台的升级提示 ✅ 阶段 C 已做（Mock 侧栏首屏，点「知道了」后不再打扰），README 的升级段 ✅ 阶段 D 已写（mock CLI 段落末尾）
  ——否则表现为「所有人的 mock 突然全失效」）：
  旧 `groups.json` 条目一律迁为 `scope: 'shared'`，保留 id / name / enabled / 时间，
  `ownerPhone` 与 `createdBy` 置 `null`（**不伪造创建人**，UI 显示「历史项目 / 创建人未知」）；
  未分组规则、`groupId` 悬空的规则，以及 `scope: 'private'` 但 `ownerPhone` 缺失的脏条目，
  归入服务端生成的**「旧版共享规则」容器**（固定 id `g_legacy_shared`，同为 shared，保留 `Rule.id` 与 `action`
  以便被复制）；旧 group 指向的规则留在迁移后的那个共享项目里。**迁移后这些规则一律不再直接命中**，
  各自复制到 private 后恢复。迁移**幂等**（第二次跑不再改动任何条目），且只在真的动过时才建容器——
  全新实例不会凭空多出一个空的「旧版共享规则」

- **为什么要有单条接口**：`PUT /__ec/api/rules` 是全量替换，多开一个控制台标签页时，
  后写的一方会把前者改的**其他**规则一起覆盖掉。列表里的「开/关」「删除」走单条接口，只动这一条
- **为什么新建 / 整条替换也走单条**（C12）：命令行与 agent 要「读一条 → 改一条 → 写回」，
  只有全量 PUT 时它必须先取全表、在本地改一条、再整表写回——期间别人改的其他规则会被它**覆盖回去**，
  而且它拿不到「服务端实际存了什么」（服务端会保留未知字段，客户端本地那份不会）。
  单条端点让「改这一条」只碰这一条，返回值里就是服务端存的那份，可直接用于读回校验
- **开/关就是规则的 `enabled`**，**没有**「全局 mock 开关」——不引入第二个真值来源
  （ADR-016 边界 1）；控制台的「浏览 / Mock」模式切换是纯前端视图状态，不进协议
- **写入口一律校验**：`enabled` 只接受布尔（`0/1` / `"true"` → `400`），
  `:id` 需 URL 编码；id 里真的含 `/`（`%2F`）不会被当成路径分隔符
- 鉴权：与 §4.4 同一套会话（`X-EC-Session`）。✅ 现状：规则对所有人可写，**不区分角色**
  （出自 **ADR-018 边界 4**；§4.7 早期版本把它写成「ADR-016 边界 5」，ADR-016 实际只有三条边界，
  该交叉引用已在 ADR-033 里登记改正）。✅ C14：仍然**不区分角色**，但**区分归属**——
  写权限来自「这条规则属于我的私有项目」，不是来自 `role`（ADR-033 决策 5/7）。
  归属栅栏已在服务端生效（`rules.ts` / `groups.ts` 的写入口）；控制台（阶段 C）与 mock CLI（阶段 D）
  都已按新口径实现——CLI 侧把归属不符一律折算成退出码 6（`EC_SCOPE_MISMATCH` / `EC_PROJECT_READONLY`）。

---

## 5. 数据 Schema

### 5.1 DeviceIdentity

```jsonc
{
  // ── SDK 自动采集 ──
  "deviceId": "3f2a-...",          // 持久 UUID，安装级，见 §5.3
  "sessionId": "9c1d-...",         // 每次 SDK 初始化生成
  "os": "Android",                 // Android | iOS | HarmonyOS | Web | Unknown
  "osVersion": "14",
  "brand": "Xiaomi",               // Android: Build.BRAND
  "manufacturer": "Xiaomi",        // Android: Build.MANUFACTURER
  "model": "23127PN0CG",           // Android: Build.MODEL
  "marketName": "Xiaomi 14",       // 可选，尽力而为
  "deviceName": null,              // iOS 用户设置的设备名
  "displayName": null,             // 客户端上报的可读设备名（非 SDK 客户端走兼容层时填充）
  "appId": "com.foo.app",
  "appVersion": "7.2.1",
  "appVersionCode": 70201,
  "sdkVersion": "0.2.0",
  "processName": "com.foo.app",    // Android 多进程隔离用

  // ── 业务注入（App 显式调用） ──
  "env": "test",                   // test | gray | prod
  "userId": "10086",               // 可空
  "userName": "张三",               // 可空，默认不上报，见 §7
  "tags": ["IM", "支付"],

  "createdAt": 1696000000000,
  "updatedAt": 1696000000000
}
```

`identity_update` 只发送变更字段 + `deviceId` + `sessionId`。

非 SDK 客户端（§2 兼容层）不带 `X-EC-Device-Id`，服务端按其配置的身份头派生设备标识，
并直接在数据面 upsert 设备表（无需控制面也能在控制台看到设备）。派生优先级（ADR-032）：

1. **安装级 ID 头**（`--compat-device-id-header`，客户端自己持久化的每安装唯一值）→ `client:<installId>`；
2. 退化：**用户 ID + 展示名**（`--compat-user-id-header` + `--compat-device-header`）→ `client:<userId>@<displayName>`；
3. 再退化：**展示名** → `client:<displayName>`。

> **为什么不能用裸用户 ID 当设备主键**：一个账号同时在两台手机上登录是常态，
> 而设备表按 `deviceId` 聚合对外展示（一台设备一行，只留最近一次会话）。
> 用 `client:<userId>` 会把两台物理手机合成一行，展示名随「谁刚发过请求」来回变，
> 看起来就像一台上线把另一台踢掉。无头客户端应优先上报安装级 ID；仅有用户 ID + 展示名时，
> 两台设备若这两个值都相同仍会合并，改名也会生成新的设备条目。

控制台登录后默认不选中单台设备，设备选择器显示当前空间可见的设备；请求列表只显示已绑定设备的记录。
绑定是显式操作。换绑会自动解绑旧设备，旧设备仍留在设备列表，但其请求不再显示。普通用户仍看不到他人已绑定的设备。

### 5.2 Record

```jsonc
{
  "id": "rec_01HF...",
  "seq": 42,                       // 重定向链各跳共享（C5）
  "deviceId": "3f2a-...",
  "sessionId": "9c1d-...",
  "startedAt": 1696000000000,
  "durationMs": 123,

  "request": {
    "method": "POST",
    "url": "https://api.foo.com/v1/login?from=app",
    "host": "api.foo.com",
    "path": "/v1/login",
    "query": { "from": "app" },
    "headers": { "content-type": "application/json" },
    "body": "{\"u\":\"a\"}",
    "bodyEncoding": "utf8",        // utf8 | base64
    "bodySize": 9,                 // 恒为实际字节数（C4）
    "bodyTruncated": false,
    "rawBody": null                // 线上真正传输的那份 body（ADR-039）；未命中加解密路由为 null
  },

  "response": {
    "status": 200,
    "headers": { "content-type": "application/json" },
    "body": "{\"code\":0}",
    "bodyEncoding": "utf8",
    "bodySize": 10,                // 恒为实际字节数（C4）
    "bodyTruncated": false,
    "rawBody": null                // 同上；mock 加密回写时是「实际发给 App 的密文」
  },

  "upstream": {
    "ms": 118,
    "protocol": "HTTP/1.1",        // mock 时为 "mock"
    "error": null
  },

  "flags": {
    "mocked": false,
    "decrypted": false,            // 至少有一侧成功解出明文（ADR-039）
    "streamed": false,
    "redirected": false            // C8：重定向链非首跳为 true（C5）
  },

  // 仅命中加解密路由时出现；未命中时**整个字段不存在**（存量记录零迁移）
  "crypto": {
    "request":  { "profileId": "p_ab12", "decrypted": true },
    "response": { "profileId": "p_ab12", "decrypted": true, "encrypted": true }
  }
}
```

记录模式（C3 / ADR-012）对 Record 的影响：

| 模式 | request/response.body | rawBody | bodySize | bodyTruncated |
|---|---|---|---|---|
| `full` | 完整（受 §3.5 约束） | 完整原始 body | 真实 | 按实际 |
| `meta` | `""` | `null`（**密文同样不落**） | 保留真实值 | `true` |
| `sample` | 前 `sampleBytes` | 前 `sampleBytes` | 真实 | `true` |

### 5.3 deviceId 生成规则

- 使用**自建 UUID**，持久化存储（Android: `SharedPreferences`；iOS: `UserDefaults` / Keychain）
- **禁止**使用 `ANDROID_ID`（Android 8+ 按签名变化、重装会变、多用户不同）
- **禁止**使用 IMEI / MEID / 序列号（权限已不可用，且有合规风险）
- 多 App 场景由 `appId` 参与区分，多进程场景由 `processName` 参与区分
- 非 SDK 客户端（兼容层）同理：设备主键必须是**每安装唯一**的值。只上报账号 ID 时，服务端
  会把展示名并进主键（见 §5.1），因为同一账号在两台手机上同时在线是常态

### 5.4 Rules（规则 schema）

```jsonc
{
  "id": "r1",                        // 唯一
  "name": "登录态顺序流转",           // 可选，仅展示
  "enabled": true,
  "priority": 10,                    // 越大越先匹配；仅取最高优先级一条（见下方说明）
  "groupId": "g_login",              // 可选（C13）：所属项目 id。✅ C14：缺失 / 悬空 = **无归属，永不命中**（见下方数据面候选集）；未分组规则不再是一个可用的「自由态」
  "match": {
    "method": "GET",                 // 可选；glob / "re:" 正则
    "host": "api.foo.com:443",       // 可选；注意含端口（如 api.foo.com:443），写 host 时带端口
    "path": "/api/user/profile",     // 可选；glob / "re:" 正则
    "params": { "u": "a" },          // 可选；按「请求入参」匹配（query + body 合并），语义见下
    "headers": {}                    // 📅 P1：额外按 header 匹配
  },
  "action": {
    "type": "mock" | "passthrough",
    "mode": "static" | "sequence" | "specific",
    "seqMode": "in-order" | "loop" | "once-then-passthrough" | "random",
    "pinIndex": 0,                     // 仅 mode === 'specific'：指定返回 responses 中第几条（0 基）
    "delayMs": 0,                      // mock 响应延迟
    "response": { "status": 200, "headers": {}, "body": "{}" },   // 单条（旧形态，语义不变）
    "responses": [                     // 多条返回值（ADR-025）
      { "status": 200, "headers": {}, "body": "{}", "name": "登录成功" },
      { "status": 401, "headers": {}, "body": "{}", "name": "未登录",
        "cond": { "query": "uid=10086", "content": "body.type=='vip'" } }   // 📅 C12 存位，暂不参与选路
    ],

    // ── v2 扩展位（未实现前必须被忽略，见 §9） ──
    "crypto": { "decrypt": {...}, "encrypt": {...}, "sign": {...} },   // 📅 P2，ADR-011
    "extract": [ { "name": "...", "from": "response", "jsonPath": "..." } ],  // 📅 P3
    "set": { "headers": {}, "query": {}, "body": "{{...}}" }           // 📅 P3
  }
}
```

多返回值的选择语义（C11 / ADR-025）：

- **单一真值来源**：`action.responses` 非空时它就是返回值列表，由 `mode` 决定取哪一条；
  为空时才回落到旧形态的 `action.response`。不允许「`response` 写选中的那条、`responses` 保留全量」
  这种两处并存的做法——那是第二个真值来源，早晚静默失效（ADR-016 边界 1 的精神）
- 判定顺序（服务端固定，缺一不可）：
  1. `responses` 非空 且 `mode === 'sequence'` → 按 `seqMode` 推进指针
  2. `responses` 非空 且 `mode !== 'sequence'`（`specific` / `static` / 缺失 / 非法值）→
     `responses[pinIndex]`；`pinIndex` 缺失或非法 → 第 0 条
  3. `responses` 为空 → `action.response`，缺失则 `{ "status": 200, "body": "{}" }` 兜底
  > 第 2 条把 `static` / 缺失 / 非法值一并归入「按 `pinIndex` 取」，是为了让判定只依赖
  > `responses` 是否非空 + `mode` 是否等于 `sequence` 这一个开关，不出现第三态分支
- **`pinIndex` 越界一律 clamp 到 `[0, len-1]`**（非数字 / NaN / 负数 → 0，超界 → 最后一条）；
  一条脏 `pinIndex` 不得让数据面 500，也不得 mock 到列表之外
- `name` **只是控制台备注**：服务端不参与匹配、不下发给 SDK、不进响应头；控制台不写空 `name`
- **`responses[].cond`（C12）：本期只存不用**。它是「这一条返回值在什么条件下才返回」的载体
  （`query` = 入参命中条件、`content` = body 表达式命中条件，**两者都是条件文本字符串**），
  服务端**原样读写、不参与选路**——
  数据面的选择逻辑仍然只看 `mode` / `seqMode` / `pinIndex`（上面那三条判定顺序一字未改）。
  为什么要先占这个位置：命令行的四条并行数组要把命中条件写进规则，若服务端丢掉它，
  「读回校验」就变成了校验一个已经被抹平的东西（自欺）。真实按条件选路随 **P4** 落地，
  届时才补判定顺序与用例（roadmap P6）
  - 写入口只校验**结构**：`cond` 存在时必须是普通对象（非数组 / 非标量），
    `cond.query` 与 `cond.content` 存在时必须是字符串（不给数字 / 布尔做宽松强转）；非法 → `400`
  - 读路径：`cond` 不是对象时按「没有」处理，不得因为它而让规则失效或数据面报错
- **拖动排序 = 直接改 `responses` 数组顺序**，没有单独的「排序字段」。改序**不重置**顺序指针
  （指针是下标，见下条），需要归零时用管理面 `POST /__ec/api/rules/reset-pointers`
- 单条返回值时控制台仍写 `mode: 'static' + response`（不写 `responses`），
  这样存量规则保存后 JSON 不变
- **写入口校验**（管理面 PUT / POST，AGENTS.md §4）：`action.responses` 必须是数组且元素都是对象，
  `action.pinIndex` 必须是有限数，`action.responses[].cond` 存在时必须是普通对象，
  否则 `400`——防止毒化内存与 `rules.json`（F-15 的教训）；
  读路径（`rules.json` 被手改坏）另行兜底：非数组当空、元素非法丢弃、`pinIndex` clamp

匹配与优先级语义：

- 匹配条件全部满足（method / host / path / params）才算命中；不配置的条件视为通配
- **分组参与命中（C13 / ADR-030）**：一条规则能被选中，条件是
  **`rule.enabled === true`** 且（**它没有 `groupId`**，或 **`groupId` 指向的分组存在且 `enabled === true`**）。
  这是**一条 AND，不是第二个真值来源**：`rule.enabled` 只回答「这条规则要不要用」，
  `group.enabled` 只回答「这一组要不要用」，两者各写各的、互不改写
  - ⚠️ 其中「**没有 `groupId` 也能命中**」这半句**已被下一条 C14 推翻**，现状（✅）是「必须先属于调用者的私有项目」。
    C13 那句里真正留下来的只有后半句：项目（原「分组」）的 `enabled` 仍然参与命中，且仍然是一条 AND、仍然不是第二个真值来源
- ✅ **数据面候选集收窄（C14 / ADR-033，服务端已实现）**：在 C13 那条 AND 之前再加一项**归属**——
  能被选中的规则必须满足
  **`rule.enabled === true`** 且 **所属项目 `scope === 'private'`** 且 **项目 `enabled === true`**
  且 **项目 `ownerPhone === store.deviceOwner(deviceId)`**。逐条要点：
  - **shared 项目与 shared 规则永不加入候选集**，即使 `enabled` 且匹配条件完全合法。
    共享是模板，要用必须先 copy 到私有区——这条是 C14 的全部要点，实现时最容易「顺手」破的就是它；
  - **owner 只从 `deviceId` 反查**（`store.deviceOwner()`，§4.4 的设备归属），数据面**不鉴权**（ADR-015 不变），
    所以这里不存在「调用方声明我是谁」的入口；**未绑定设备（owner 为 `null`）不命中任何私有规则**；
  - **不带 `groupId` 的规则一律不命中**：C14 之后没有「无归属的全局规则」这个概念。
    存量这种规则在迁移时被收进「旧版共享规则」容器（§4.7 迁移口径），不留在裸奔状态；
  - **多个私有项目可同时启用**，命中仍是「只取 `priority` 最高的一条」（下面那条既有语义一字不改），
    **不引入项目级优先级**，也不引入「私有项目之间再分层」；
  - 实现落点（✅）：`data-plane.ts` 用 `store.deviceOwner(deviceId)` 反查出 owner 再传进 `resolve()`，
    `rules.ts` 的候选过滤按上面那条 AND 走
- **（C13 口径，已被下面 C14 推翻）`groupId` 指向不存在的分组时按「未分组」处理（照常命中）**，这一条当时是刻意的：
  若按「不命中」处理，那么手改 `groups.json`、或用别的手段删掉一个分组之后，
  组里那些**在控制台里明明显示着「已启用」**的规则会**不报错、日志正常、功能不生效**——
  正是 §5 定义的最难查的静默失效。存在性校验做在**命令行侧**（`mock api create --group-id` 会先读分组表核对），
  服务端写入口只校验**结构**（与 §5.4 末尾「校验范围只到结构」的既有边界一致）；
  代价如实登记在 roadmap：绕过 CLI 直接打管理面仍可能写出悬空 `groupId`（同 `bindDevice` 归属校验的同类已知限制）
  - ✅ **C14 把这一条的结论翻转，且这是本契约里唯一一处「旧兜底被新模型推翻」**：新口径下
    「没有归属」不再等于「全局生效」，而是等于「不属于任何人的私有项目 ⇒ 永不命中」。
    之所以翻转不再造成上面那种静默失效，靠的是两个硬约束，**两个都必须做到**：
    ① ✅ **迁移不得留下任何「既不属 shared 也不属 private」的规则**——未分组与悬空 `groupId` 的规则
    一律收进服务端生成的「旧版共享规则」容器，它在 UI 里显示为**共享项目**（本就不参与命中，界面有明示）；
    启动横幅会打印迁了多少条，静默升级就等于静默失效；
    ② ✅ **控制台的规则行必须显示归属项目**（阶段 C 已做）：每条规则第二行是 `· 项目：<名字>`，
    与「已启用 / 已停用」并列呈现；项目停用时写 `⊘ 项目：X（项目已停用 → 不命中）`，
    归属查不到时写 `项目 X（不可见或已删除）`，没有 `groupId` 写 `未归属（不命中）`——
    看不到归属的「已启用」才是静默失效的温床。① 与 ② 现在**都已上线**，
    「旧全局规则不再命中」在界面上有原因可看（还有首屏那条升级提示）；
    读路径仍按「结构校验通过即可加载」处理，**不得因为一条脏归属数据让启动崩溃**（AGENTS.md §4）
- **写入口对 `groupId` 的校验（✅ C14 起收紧）**：存在时必须是**字符串**（数字 / 对象 / 布尔 → `400`，
  不给宽松强转）；C13 时代「空串归一为未分组、照常命中」在 C14 下不再是可写的状态——
  管理面写入口要求 `groupId` **必须指向调用者自己的私有项目**，缺失 / 空串 / 指向共享 / 指向他人一律
  `400 EC_SCOPE_MISMATCH`（§4.7）。空串归一（落盘不写该字段）只保留在**内部整表路径与读路径**上，
  用于加载迁移前的存量数据
- **`match.params` 的语义**（C10，ADR-016）：
  - 匹配对象是**请求入参**：`query` 与 `body` 合并后的键值表。body 为 JSON 对象或
    `application/x-www-form-urlencoded` 时参与合并；**同名以 body 为准**；body 非对象
    （数组 / 标量 / 二进制 / 非 JSON）时只按 `query` 匹配，不得因此报错
  - **AND 语义**：`params` 里出现的每个 key 都必须满足才算命中
  - value **为空串** = 只要求「该参数存在」，不校验取值
  - value 非空 = 按与 method / path 相同的 `glob` / `re:` 前缀正则匹配
  - **不配置 `params`（或空对象）= 不校验入参**，与旧规则向后兼容
  - 控制台默认只勾选**业务参数**、折叠公共参数（`timestamp` / `noncestr` / `sign` / `sid` 等），
    因为公共参数每次都在变、勾上必然匹配不上。**该「业务 / 公共」划分属于控制台本地知识
    （见 §9 契约边界），服务端不认识这个概念**——服务端只按 `params` 里写了什么就匹配什么
- 命中多条时**只取 `priority` 最高的一条**（P0 现状，保留）；同一优先级内顺序不稳定
  → **注意**：高优先级 `passthrough` 会遮蔽低优先级 `mock`，规则设计时不要依赖「多规则叠加」。
  同理，「按入参精确匹配」的规则必须比「只匹配路径」的规则 priority 更高，否则会被宽松规则遮蔽
- 顺序 mock 指针按 `(deviceId, ruleId)` 隔离（ADR-004），控制台可一键重置全部指针。
  **指针是下标**：拖动排序改了 `responses` 顺序后不会重置指针，已推进到第 k 位的设备会按**新**
  数组的第 k 位继续——这是刻意的（重置会把别人正在走的序列打断），需要对齐时用
  `POST /__ec/api/rules/reset-pointers`
- `once-then-passthrough` 序列走完后返回 `null`，数据面放行到真实服务器

### 5.5 Group / 项目（分组 schema，C13 → C14）

```jsonc
{
  "id": "g_login",                  // 唯一，服务端生成：g_<base36 时间><4 位随机>
  "name": "登录模块",                // 必填（非空、非全空白），仅展示用
  "enabled": true,                  // 整组开关；false = 本组规则一律不参与命中（§5.4）
  "createdAt": 1696000000000,
  "updatedAt": 1696000000000,

  // ── C14 新增（✅ 服务端已实现；除 name/enabled 外**全部是服务端字段**，客户端提交即 `400 EC_SCOPE_MISMATCH`）──
  "scope": "private",               // 'private' | 'shared'；从会话推导，shared 永不参与命中
  "ownerPhone": "13800000000",      // private = 创建人手机号（恒等于会话手机号）；shared 恒为 null
  "createdBy": "13800000000",       // 首次创建 / 发布人；旧数据与迁移来的历史项目为 null（**不伪造**）
  "currentVersionId": "v_...",      // 仅 shared：当前内容对应的那个历史版本
  "originSharedProjectId": "g_...", // 仅 private：来源共享项目；首次分享后也建立该关联
  "lineage": [                      // 仅 copy 得到的 private：共享规则 id ⇄ 本地规则 id 的稳定映射
    { "sharedRuleId": "r_a", "privateRuleId": "r_b" }
  ],
  "copiedFromVersionId": "v_...",   // 仅 copy 得到的 private：复制时源的版本
  "archived": false,                // 仅 shared：归档标记（不删快照与分享记录）
  "pendingDeleteAt": 1696000000000, // 仅 shared：软删除（待删除）发起时间，服务器时钟（ADR-037）
  "purgeAt": 1697296000000          // 仅 shared：真正删除的时刻 = pendingDeleteAt + 7 天
}
```

- **只有这一层，没有「模块」实体**：用户场景里的「分组 → 模块 → 一组 mock 列表」对应
  `Group → Rule → action.responses[]`。后两层早就存在（§5.4 / ADR-025），本次只补最上面的容器；
  再造一个 `Module` 类型会与 `Rule` 形成同义双表（ADR-030 决策 1）。C14 沿用同一个结论：**项目就是 `Group`**
- **项目没有优先级、没有匹配条件、没有变量**：它只是收纳与开关。
  规则间的先后仍由 `priority` 决定（§5.4）；「组内规则互相遮蔽」不是分组要解决的问题。
  **C14 之后这条更加吃紧**：多个私有项目可同时启用，命中顺序**只**由规则级 `priority` 决定，
  绝不引入项目级优先级——那会让「A 抬优先级只影响 A」变成「A 抬优先级遮蔽 B」，
  归属维度与排序维度耦在一起，是 C14 想解决的问题的反面（ADR-033 决策 2）
- **归属字段只能由服务端写**：`scope` / `ownerPhone` / `createdBy` / `currentVersionId` / `originSharedProjectId` /
  `archived` / `pendingDeleteAt` / `purgeAt` / 时间与版本全部来自会话与服务器时钟。请求体里带这些字段 = `400 EC_SCOPE_MISMATCH`。
  **手机号是现有稳定账号标识**（`store.User` 主键），不新造用户 id
- **软删除（待删除）只有 shared 一档**（ADR-037）：
  - 发起：`DELETE /groups/:id`（shared）→ 写 `pendingDeleteAt = now`、`purgeAt = now + 7 天`。
    **规则、历史版本、快照全部原样保留**，项目照常出现在列表与详情里（带这两个字段），也照常可读、可 copy。
  - 恢复：`POST /groups/:id/restore` → 清掉两个字段，内容从未被改过，恢复即恢复原状。
  - 真删：`purgeAt` 到期且无人恢复，服务端**启动时**与**每 30 分钟**各扫一次（`groups.json` 里过期的 shared 项目），
    逐个删规则 → 删项目 → 删历史目录（`.data/projects/<projectId>/` 与 `index.json` 里的条目）。
    顺序刻意是「先规则、后项目」：中途崩了留下的是「空项目」而不是「无归属规则」，下一轮清扫能自愈。
  - **待删除期间不能再往里写**：`share`（覆盖到待删除的 shared）与 `rollback` → `409 EC_PROJECT_READONLY`
    （文案要求先 restore）。否则「分享成功」会变成「7 天后整份内容跟着项目一起消失」的静默丢失。
  - 迁移容器 `g_legacy_shared` 不接受删除（`409`）：它不是任何人建的项目，装着全服的存量规则。
  - 7 天是**服务端常量**（`SHARED_TRASH_MS`），不是客户端可传的字段；`purgeAt` 一旦写下就不因重复删除而延长。
- **`lineage` 只用于覆盖时还原原共享 id、序列指针身份与规则追踪，不用于三方冲突检测**——
  C14 明确不做合并（ADR-033 决策 3）。私有项目里新建的规则在分享时才分配共享 id；
  复制后被删掉的映射规则在下一次分享时从共享项目消失
  - **与交接计划的表示形式差一处，是有意的**：计划 §3.2 把它写成独立的 `ProjectLineage` 表
    （`privateProjectId` / `sharedProjectId` / `copiedFromVersionId` / `ruleMap`）。契约这里把同样的内容
    **收进 private 项目对象自身**（`originSharedProjectId` ≈ `sharedProjectId`、`copiedFromVersionId` 同名、
    `lineage` ≈ `ruleMap`；`privateProjectId` 就是这个 group 的 `id`，不必再存一遍）。
    理由：映射与它所属的项目分开存，就要在 copy / share / 删项目三处同步两张表，
    漏一处就是第二个真值来源（ADR-030 反对 `Module` 同一条精神）。字段语义不变，只是落点合并
- **`ProjectVersion`（✅ C14，服务端已实现；每次 publish / share / rollback 一条，不可变）**：

```jsonc
{
  "id": "v_lz4k1a2b3c",
  "projectId": "g_login",
  "parentVersionId": "v_prev",       // 事件顺序，链式但不做合并
  "operation": "publish" | "share" | "rollback",
  "actorPhone": "13800000000",       // 服务端从会话取，不接受客户端提交
  "createdAt": 1696000000000,        // 服务端时间
  "rollbackOf": "v_older",           // 仅 operation === 'rollback'：回退的目标版本
  "ruleCount": 12,
  "snapshotFile": "projects/g_login/v_lz4k1a2b3c.json"   // 内部相对路径，**永不下发客户端**
}
```

  快照内容 = 该次分享时**完整**的共享项目定义 + 全部规则与返回值（回退要能逐字段还原）。
  `currentVersionId` 指向当前共享内容。**历史事件顺序不可修改**；回退 = 新增一条 `rollback` 版本，
  被回退到的旧版本之后仍然可用（含「再回退到更早的点」）。
  **默认全部保留、不静默清理**——用户要的是任意历史都能回退；代价如实登记：
  历史会长期保留后来删掉的 response body（可能含 token / cookie / 个人数据）并持续占 `.data/` 空间，
  发布入口必须提示自查，启动与管理面给出**实际字节数**（不是估算值，AGENTS.md §6）。限额保留要另立 ADR
  - 现状：✅ 管理面 overview 已按实际字节数报告（`storage: { bytes, files, projects }`），
    ✅ 控制台发布 / 覆盖 / 回退前的自查提示也已做（阶段 C，确认文案点名「历史会长期保留后来删掉的 body」）；
    ✅ 启动日志也已打同一份账（阶段 D：`[ec] 项目历史占用 <实际字节> …`）
- **原子提交与 pending journal（✅ C14，服务端已实现）**：一次 share / rollback 要同时写
  `rules.json`（active 规则）、`groups.json`（项目元数据与 `currentVersionId`）与快照文件三个落盘点。
  实现里的固定顺序（`ProjectService.commit`，与这里的规定一一对应）：
  **先校验完整新状态**（`validateRuleSet` 逐条结构校验 + 全表 `ruleId` 唯一性 + 快照 payload 的**实际 UTF-8 字节数**）
  → 写不可变快照 → 写 journal（记 `operationId` 与目标状态 `after`）→ 提交 active 状态（先 `rules.json` 后 `groups.json`）
  → 补历史索引 → 清 pending 并落 `operationId` 回执。
  全程临时文件 + `rename`，完整提交前不改动内存活动状态；任一步抛错就尽力回到提交前的两份状态、
  删掉本次写进去的快照与 pending，再把原始错误原样抛出（回滚本身再失败也不盖掉原始错误，那是诊断的唯一线索）；
  **启动时先按 journal 幂等前滚**再对外服务，快照文件已不存在的那笔**既不前滚也不后滚**——
  journal 只存 `after`，凭它写不出「旧状态」，猜一个就是把数据搞得更糟，于是如实报告 `abandoned` 并清掉 pending。
  绝不能「逐条 PUT 成功几条算几条」（F-15 的教训：落盘一半 = 重启也救不回来）。
  落盘位置在 `.data/` 内按 `projectId` / `versionId` 分文件，**不新增顶层目录、不引入配置文件格式、不加运行时依赖**
- **`name` 不要求唯一**：允许同名分组（不同项目里「登录」这种名字撞车很正常），
  一切定位只按 id；控制台与 CLI 展示同名分组时靠 id 区分。**不同用户可以有同名私有项目**，
  更要用 id 定位（C14 之后「登录」这个名字在列表里会重复出现，不是 bug）
- **body 上限**：管理面 JSON body 上限仍是 1 MiB。C14 的 copy / share / rollback **不接收客户端上传完整项目**
  （服务端按 project id 从存储内部读），所以这个上限不会卡住大项目；但**服务端内部复制要检测实际落盘字节数**，
  超限或写失败给出可读错误且**不留半写文件**。✅ 服务端落地的护栏：单份快照 payload 超过 **64 MiB** →
  `507 EC_STORAGE_UNAVAILABLE`，文案带**真实字节数与上限**并明说「nothing was committed」。
  ⚠️ 64 MiB 这个数是**实现自己拍的**（协议只要求「超限给可读错误、不留半写文件」，没给数字），
  已登记在 roadmap P7 的待产品确认项里；它只挡单笔快照，不代表历史开始被清理（历史仍默认无限保留）
- 落盘 `.data/groups.json`（数组，一条一个对象）。读路径的防御与 `rules.json` 同口径：
  文件坏 JSON / 非数组 → 空列表，条目非对象或 `id` 非字符串 → **丢弃该条**，
  绝不因为一条脏分组而让启动崩溃（AGENTS.md §4，同 F-16 的教训）。✅ C14 新增字段的读路径兜底（方向一律是「不进任何人的候选集」）：
  `scope` 缺失或不是 `'private'`/`'shared'` 字符串 → 按 `'shared'` 处理（**宁可让这条不参与命中，
  也不要因为一个脏值把别人的私有规则放进候选集**）；`ownerPhone` 非字符串或空串 → 按 `null` 处理 ⇒ 无 owner ⇒ 不命中；
  `lineage` 非数组 → 当空映射，`currentVersionId` 非法 → 保留历史但不影响命中判定。
  `pendingDeleteAt` / `purgeAt` 非有限正数 → 当**没有**（不因为一个脏时间戳把项目删掉：
  删错不可逆，宁可留着让人再点一次；只有 `purgeAt` 一个有效时按 `purgeAt - 7 天` 反推发起时间）

### 5.6 加解密（ADR-039）

**目标**：让控制台看到明文，但不改变线上传输的字节，也**不把密钥带出本机**。

#### 存储与隔离

| 文件 | 内容 | 进 git？ | 进发布包？ |
|---|---|---|---|
| `server/.data/crypto/settings.json` | 密钥档 + 路由 | ❌（`.gitignore` 的 `server/.data/`） | ❌（打包白名单不含 `.data/`） |
| `server/crypto.example.json` | 只有占位值的模板 | ✅（被 pre-commit 识别为 example） | ❌ |

**规则里只存 `profileId`，不存 key/iv**。规则会被导出、分享、截图；密钥是全局资产，
混在一起就等于「分享一套 mock 规则 = 泄露线上密钥」。

#### settings.json

```jsonc
{
  "profiles": [{
    "id": "p_ab12",
    "name": "im 消息详情",
    "plugin": "builtin",           // ADR-040；缺省即 builtin，且服务端不写回磁盘
    "alg": "aes-128-cbc",          // Node createCipheriv 的算法名（白名单见下）
    "key": "…",                    // 16/24/32 字节，按 keyEncoding 解码
    "keyEncoding": "utf8",         // utf8 | base64 | base64url | hex
    "iv": "…",                     // ECB / AEAD 不填；CBC/CTR/CFB/OFB 必填
    "ivEncoding": "utf8",
    "aead": {                      // §5.6.1；AEAD 算法必填，非 AEAD 不许填
      "ivBytes": 12, "tagBytes": 16, "tagAt": "end", "aad": "…"   // aad 可省
    },
    "cipherEncoding": "base64",    // base64 | base64url | hex
    "autoPadding": true,           // false = 不做 PKCS#7（AEAD 下无意义）
    "request":  { "type": "json", "field": "data" },   // 密文在 body 里的位置
    "response": { "type": "raw", "prefix": "ciphertext:" },
    "encrypt":  { "type": "json", "field": "data" },   // mock 明文回写时套的壳，缺省同 response
    "query":    { "field": "payload" }                 // §5.6.2；可省 = 不处理 URL 里的密文
  }],
  "routes": [{
    "id": "c_ab12",
    "enabled": true,
    "profileId": "p_ab12",
    "match": { "method": "POST", "host": "api.example.com", "path": "*api/example/im/msg/detail*" },
    "request": true,               // 解密请求体 + query
    "response": true               // 解密响应体
  }]
}
```

- `plugin`（ADR-040）：用哪个插件做加解密，**缺省 `builtin`**。`builtin` 是保留名；
  写了未加载的插件名会 400（不会存下一份没人能解的配置）。
  内置引擎也是一个插件、走同一条 SPI——所以「公开仓库只留通用实现、业务变形走私有插件」
  不需要两套代码路径。`alg` / `key` / `aead` 这些扁平字段**只属于内置引擎**（§5.6.3）。
- 算法白名单（非 AEAD）：`aes-128/192/256-cbc|ecb|ctr|cfb|cfb1|cfb8|ofb`、`des-ede3-cbc`、`sm4-cbc|ecb`
- 算法白名单（AEAD）：`aes-128/192/256-gcm`、`chacha20-poly1305`，**必须同时配 `aead`**。
  只写 `alg` 会被 400：「IV/标签长度猜不出来」。
- `wrap.type`：`raw`（整个 body 就是一段密文，缺省）/ `json`（取 `field`，支持点路径如 `data.body`）/ `form`（表单字段）。
- `wrap.prefix`（可选）：密文串自带的固定前缀（`ciphertext:`）。**解密时剥掉、mock 加密回写时补回**；
  含空白或超过 32 字符会被拒绝（会原样拼进 mock，一个尾随空格就能让 App 解不开）。
- 匹配语法与规则引擎一致（`*` / `?` / `re:` 前缀）。`host` 会**同时按带端口和不带端口**各试一次。
- 至少要有 `host` 或 `path`：只按 `method` 匹配 = 把所有接口都解密，写入时直接 400。
- 数组顺序即优先级：一个接口只该套一套密钥，第一条命中的生效。

#### 5.6.1 AEAD 布局

AEAD 的 IV 随每次加密随机生成并拼在密文里，标签要在解密前 `setAuthTag`，
所以它需要**一条布局**而不是一个 `iv` 值：

| 字段 | 含义 | 约束 |
|---|---|---|
| `ivBytes` | 密文前缀里 IV 的长度 | 整数 1–64（GCM 常见 12） |
| `tagBytes` | 认证标签长度 | 整数 4–32（GCM/Poly1305 为 16） |
| `tagAt` | `end` = `iv\|ct\|tag`；`start` = `iv\|tag\|ct` | 缺省 `end` |
| `aad` | 关联数据（utf8 字面量） | ≤1024 字符，可省 |

- AEAD 配 `iv` 会被 400；不是 AEAD 却配 `aead` 也会被 400（避免「配了却永远不生效」）。
- mock 加密时 IV 每次随机（随机 IV 是 GCM 的安全前提），**不会**复用同一条密文。
- 布局或密钥错了表现为**认证失败**，不会解出乱码；错误文案同时列出三个可能原因。

#### 5.6.2 query 密文参数

`GET` 请求没有 body，参数全在 URL 里（`?payload=…`）；有的 POST 也会在 query 里带一份。

- `profile.query = { field, prefix? }`，只描述「哪个参数是密文」。
- 解密结果写进 `MessagePart.queryPlain`（`Record<string,string>`）：能按 `k=v&k=v` 展开就展开成多项，
  否则原样挂在 `field` 名下；**绝不丢内容、不猜结构**。
- `request.query` / `url` 保持线上原样（密文），与 `rawBody` 同一条原则：记录要能复查。
- 解密后的 query 参数**参与 `match.params` 匹配**（同 §5.4 的「用明文匹配」口径）。
- 元信息写在 `crypto.query = { profileId, decrypted, error?, field }`，与 `crypto.request` 分开——
  两者可能只成功一个。
- `record-mode=meta` 时 `queryPlain` 同样不落（业务参数属于记录内容）。

#### 处理语义（三条硬约束）

1. **解密只影响记录，不影响转发。** 请求体/响应体/URL 原样透传，`body` 换成明文、`rawBody` 存原始密文、
   `queryPlain` 存 query 解出的明文、`query` 存原始 query。解密失败不阻断请求，只记 `crypto.*.error`。
2. **mock 明文必须加密回写。** 命中规则若带 `action.crypto.profileId`，返回前按 `profile.encrypt`
   加密；失败就**按明文返回并记 error**，而不是让 App 收到一包解不开的数据却查不出原因。
   加密后的 `content-type` 在用户未显式配置时按 wrap 推断（`json` → JSON，其余 → `text/plain`）。
3. **参数匹配用解密后的 body 与 query。** 加密接口的业务参数都在密文里，用密文去匹配 `match.params`
   等于永不命中；解密失败时退回原文，保持旧行为。

#### 管理面

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/__ec/api/crypto` | 返回 `{ enabled, profiles[], routes[] }`；**key/iv 只回打码值**（`12••••ef`） |
| `PUT` | `/__ec/api/crypto` | 整体替换 `{ profiles, routes }`；**先全量校验再落盘**，一条不合法整份 400，内存不动 |
| `POST` | `/__ec/api/crypto/test` | `{ profileId, text, mode }` → `{ ok, output }`；不落盘、不改内存 |
| `POST` | `/__ec/api/crypto/reload` | 手改 `settings.json` 后重读，不必重启服务 |

- 允许的 `profile.id` / `route.id`：`^[A-Za-z0-9_-]{1,64}$`；缺省由服务端生成。
- `key` 里含 `••••` = 「沿用旧值」。这是控制台编辑时**不回传明文密钥**的实现方式，
  而不是把打码串存成密钥。
- 错误码：`EC_CRYPTO_INVALID`（400，结构/参数不合法）、`EC_CRYPTO_DISABLED`（409，`--no-crypto` 时保存）。
- 总开关：`--no-crypto`。关闭后连 `settings.json` 都不读，`match()` 恒为 `null`。

---

#### 5.6.3 私有插件（ADR-040 P1）

插件从 `<dataDir>/plugins/` 加载，**不在仓库里、不在发布包里**。两种形态：
```
<dataDir>/plugins/
  my-plugin/
    manifest.json   # { name, version, spiVersion, title?, entry? }
    index.mjs       # export default { ...CryptoPlugin }
  single.mjs        # 单文件版：元数据全在模块导出里，name 必须等于文件名
```

- **只扫一层**，不递归；名字必须匹配 `^[a-z0-9][a-z0-9_-]{0,39}$`；
- `lstat` 判类型，**软链接直接跳过**并告警；
- 目录名 / 文件名必须与 `name` 一致（目录版还要求与 `manifest.name` 一致）——
  否则「删掉某个目录」与「停用某个插件」会变成两件需要推理的事；
- 入口只收 `.mjs`。`.js` 在数据目录下没有 `package.json {"type":"module"}` 时会被当成
  CommonJS，`export` 直接语法报错——那种错看起来像「插件写坏了」，实际是后缀问题；
- `manifest.spiVersion` 与内核不符时**在 import 之前就拒绝**（连执行它的代码都不该发生）；
- 同名「目录版 + 单文件版」→ 两条都不用，提示删一个；
- 加载失败只记 `error` + 可操作原因，**不影响服务启动**，也不影响其它插件。

profile 侧的对应字段：

```jsonc
{
  "id": "p_acme",
  "plugin": "acme-double",                 // 非 builtin
  "options": { "keyPart1": "…", "rounds": 2 },  // 键名与校验由插件的 configSchema 定义
  "pluginContext": { "headers": ["x-nonce"] },  // 可选：允许插件读取的 header（≤8 个）
  "request": { "type": "raw" }, "response": { "type": "json", "field": "data" }
}
```

- `options` 与扁平字段（`alg`/`key`/`iv`/`aead`/…）**不能并存**：写了 `plugin: xxx`
  又带 `alg` → 400。反过来 `plugin: builtin` 带 `options` 也 400。
- `options` 按插件 `configSchema` 校验：`required` / 类型（**不做隐式转换**，`"12"` ≠ `12`）/
  `enum` / `minimum`·`maximum` / 单字段 ≤4096 字符。未声明的键放行（插件升级时旧配置不能炸）。
- `secret: true` 的字段在 `GET /crypto` 里打码，`PUT` 回写打码值表示沿用；没有旧值可沿用 → 400。
- `pluginContext.headers` 名字不区分大小写，写进来会被小写化并去重；**不配就一个 header 都不给**。

管理面端点（均需会话）：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/__ec/api/crypto/plugins` | 插件清单：name / version / spi 兼容 / isolation / status / error / configSchema / usedBy |
| POST | `/__ec/api/crypto/plugins/reload` | 重扫目录 + 重建注册表 + 重读 profile，返回 warnings |
| POST | `/__ec/api/crypto/plugins/test` | `{ plugin, options, text, mode }` 试跑，不落盘、不进缓存 |

**不做上传安装**：装插件 = 把目录拷进 `<dataDir>/plugins/` 再点重扫。管理面在 LAN 模式下
任何持 token 的客户端都能调，上传 zip 等于主动开一个远程代码执行入口（ADR-040 决策 5）。

##### 5.6.3.1 单文件脚本来源（`script:`）

目录插件要写 manifest + `configSchema` + 完整对象，适合「做成可复用组件」。只想表达
「这段密文怎么变明文」时用脚本，一个文件两个函数，**没有 `configSchema`**：

```
<dataDir>/crypto/scripts/myapp.mjs
```

```js
export function decrypt(text, options) { return '明文' }   // 入参密文串，出参明文字符串
export function encrypt(plain, options) { return '密文' }  // 可选；没有它就不能用于 mock 回写
export const secrets = ['key']                            // 可选；不声明则整份 options 打码
export const meta = { title: 'myapp', version: '1.0.0' }   // 可选
```

- 注册名是 `script:<文件名>`：`plugin: "script:myapp"`。`script:` 是**保留命名空间**，
  非脚本插件不能占用；脚本也必须带，否则 400。
- 参数仍然在 profile 的 `options` 里，但**是一份自由 JSON**：不做标量类型约束，
  只要求是合法 JSON 且嵌套 ≤6 层、单值 ≤4096 字符、整体 ≤64KB。
- 打码规则退化成 `secrets`：声明了就只打这几个字段，没声明就**整份打码**
  （不做「按键名猜密钥」的启发式——猜错一次就是密钥明文出现在页面上）。
- 与目录插件同一套扫描规则：只扫一层、`lstat` 拒软链接、只收 `.mjs`、名字正则、
  `?v=mtimeMs` 破缓存。语法错/顶层抛错只让这一个脚本 `status=error`。
- 运行期约束与插件一致：**必须同步**（返回 Promise 会被拒绝）、必须返回字符串、
  抛异常 = 解密失败。`in-process` 执行，死循环会卡住服务（控制台标「无隔离」）。
- 源码只读：`GET /__ec/api/crypto/scripts/:name` 返回 `{ ok, name, source }`。
  **没有 PUT**——控制台能写 `.mjs` 等于把管理 token 升级成 RCE，改代码只能在本机改文件。


## 6. 错误码与降级

### 6.1 错误码

| code | HTTP | 含义 | SDK 行为 | 状态 |
|---|---|---|---|---|
| `EC_TARGET_MISSING` | 400 | 缺少 `X-EC-Target` | fail-open | ✅ |
| `EC_BAD_TARGET` | 400 | 目标 URL 非法 | fail-open | ✅ |
| `EC_PROTOCOL_MISMATCH` | 426 | 协议版本不兼容 | fail-open + 提示升级 | 🔧（服务端未发，SDK 已处理） |
| `EC_UNAUTHORIZED` | 401 | 控制台会话缺失/失效（管理面）；预留的数据面鉴权失败 | 管理面：引导重新登录；数据面：fail-open + 告警 | ✅（管理面） |
| `EC_UPSTREAM_UNREACHABLE` | 502 | 连不上真实服务器 | 原样回传（真实业务失败） | ✅ |
| `EC_UPSTREAM_TIMEOUT` | 504 | 上游超时 | 原样回传 | ✅ |
| `EC_SERVER_BUSY` | 503 | 服务端过载 | 原样回传 | 🔧（预留，当前不产生） |
| `EC_PROJECT_NOT_FOUND` | 404 | 项目 / 版本不存在，**或存在但对当前会话不可见**（他人的私有项目、他人的规则走同一响应，不用 403 泄露归属） | 与 SDK 无关（管理面） | ✅ C14（服务端 + 控制台 + CLI 均已按码分支；CLI 折算成退出码 4） |
| `EC_PROJECT_READONLY` | 409 | 试图直接编辑 / 删除 / 提交共享项目内容，或改共享项目的 `enabled`（共享内容只能由 share / rollback 产生） | 与 SDK 无关（管理面） | ✅ C14（服务端 + 控制台 + CLI 均已按码分支；CLI 折算成退出码 6） |
| `EC_SCOPE_MISMATCH` | 400 | 写入越界：规则无 `groupId` / 指向他人或共享项目 / 提交里带了服务端字段（`scope`、`ownerPhone`、`createdBy`、时间、版本）/ 批量替换里出现重复 id | 与 SDK 无关（管理面） | ✅ C14（服务端 + 控制台 + CLI 均已按码分支；CLI 折算成退出码 6） |
| `EC_CONFLICT` | 409 | `share` 带了 `expectedSharedVersionId` 而服务端当前版本已变（脚本用的乐观锁；控制台不带它，改为展示增删后二次确认） | 与 SDK 无关（管理面） | ✅ C14（服务端 + CLI 乐观锁入口 `--expected-version`；CLI 折算成退出码 7） |
| `EC_STORAGE_UNAVAILABLE` | 507 | 快照 / journal 落盘失败；**本次 share / rollback 整笔回滚**，active 规则、`currentVersionId`、历史一字未改 | 与 SDK 无关（管理面） | ✅ C14（服务端） |
| `EC_CRYPTO_INVALID` | 400 | 加解密配置不合法（结构 / 算法白名单 / key 长度 / 悬空 profileId / 只按 method 匹配 …）；**整份配置都不落盘** | 与 SDK 无关（管理面） | ✅ ADR-039（服务端 + selftest） |
| `EC_CRYPTO_DISABLED` | 409 | 服务以 `--no-crypto` 启动，保存配置也不会生效 | 与 SDK 无关（管理面） | ✅ ADR-039（服务端） |

✅ C14 的**五个**新码（`server/src/ec-error.ts` 的 `EcCode` 联合就是这五个，`EC_UNAUTHORIZED` 是复用既有码、
不算新增）**只出现在管理面**，SDK 不需要为它们写任何分支；它们也**不进入** §6.2 的 fail-open 判定列表
（那四类都是「连不上本地服务」的语义，管理面报错与转发链路无关）。
状态里不再有 📅：服务端会发这些码，控制台已按码分支（阶段 C：把 `EC_*` 连同
`message` 一起显示在 toast 里，`4xx` 保留草稿不报成功），mock CLI 也已按码分支（阶段 D：
`EC_PROJECT_NOT_FOUND` → 退出码 4，`EC_PROJECT_READONLY` / `EC_SCOPE_MISMATCH` → 6，`EC_CONFLICT` → 7）。

### 6.2 fail-open（C6 / ADR-005，强制）

**只有一种情况允许 fail-open：SDK 无法与本地服务完成一次有效交互。**

判定条件（任一，且**均为连接建立类**）：

1. TCP 连接被拒 / DNS 失败 / 无路由（`ECONNREFUSED`、`ENOTFOUND`、`EAI_AGAIN`、
   `NoRouteToHostException`、`UnknownHostException`、`ConnectException` 等）
2. 收到带 `X-EC-Error` 且属于 `EC_TARGET_MISSING` / `EC_BAD_TARGET` /
   `EC_PROTOCOL_MISMATCH` / `EC_UNAUTHORIZED` 的响应

**任何超时（连接/读/写）都不得触发 fail-open**：超时意味着请求可能已到达代理并已转发，
重放会造成重复提交。超时异常原样抛给业务层，行为等同直连真实服务器（ADR-005/013）。

fail-open 时 SDK 必须**用重建的等价请求直连真实服务器**，且：

- 请求 body 必须可被重放（见 §8.1）
- 剥离所有 `X-EC-*` 头
- 整个 SDK 内部异常不得向外抛出，业务层无感知
- 连续 N 次（默认 3）**连接类**失败后进入静默期，不再尝试本地服务，直到 App 重启或手动恢复

**禁止**在上游返回 `502` / `504` / `503` 时 fail-open 重试——那是真实的业务失败，
重试会造成重复提交。

### 6.3 协议版本不匹配

- SDK 在 `hello` 响应中读到 `protocol != 本 SDK 支持版本` → 停止引流（`shouldIntercept` 恒 false，
  即全部直连），并打印升级提示。这是 fail-open 的极端形式（永久静默，直到 App 重启）

---

## 7. 安全约束（ADR-015 取代 ADR-007）

1. 服务端默认只监听 `127.0.0.1`。监听 `0.0.0.0`（`--lan` / 非回环 `--host`）必须显式传参，并打印醒目告警
2. **数据面不鉴权**：任何能访问该端口的人都能把它当作开放中转代理使用。因此
   - 首选 `adb reverse` / 模拟器（仅回环，零暴露）；`--lan` 只在可信网络**短时**开启，用完即关
   - 不得在公共 WiFi、办公大内网长期开启——这是当前取舍的**已知风险边界**，已记入 ADR-015
   - 可选的数据面鉴权（复用预留的 `X-EC-Token`）列为 roadmap P1
3. **控制台鉴权** = 手机号 + 全局口令（`--password`，默认 `123456`）。默认口令只适合本机自用，
   监听局域网前必须修改；会话落盘且默认 30 天有效（`--session-ttl`），**重启不失效**——
   所以 `.data/store.json` 里的 token 等价于登录态，该目录已在 `.gitignore` 内（ADR-031）
4. **用户空间隔离**：请求记录、详情、快照创建与实时推送都按 `deviceId → phone` 过滤，只允许当前空间绑定设备。
   未绑定设备可以出现在普通用户设备列表中供认领，但其请求对普通空间不可见；绑定后才开始展示该设备请求，
   解绑后再次隐藏。管理员仍通过管理面汇总查看全局统计，不改变普通空间的记录边界。
5. `userName` 属于个人信息，**默认不上报**；需要时由 App 显式开启，且默认只在本机控制台渲染
6. 固定密钥等敏感配置存本地文件，必须加入 `.gitignore`（`server/.data/` 已忽略）
7. 记录数据只落本地，不得上传任何外部服务
8. ✅ **Mock 项目的归属隔离（C14 / ADR-033，服务端已实现）**：私有项目只对 `ownerPhone` 那个手机号空间可见可写，
   他人一律按 `404` 响应；**归属只从已认证会话推导**，请求体里的 `ownerPhone` / `createdBy` / 分享人 / 时间
   一律不采信（`sessionPhone(req)` 是唯一来源）。数据面按 `deviceId → owner` 反查决定候选集，
   **数据面本身仍不鉴权**（ADR-015 不变，SDK 零改动）。权限矩阵见 §4.7
9. ✅ **「共享库谁都能覆盖」是本口径的直接推论，不是漏洞**：任何登录用户都能 copy 共享项目，
   而覆盖走「本地副本整体提交」，所以任何登录用户事实上都能覆盖与回退共享项目。
   这里**没有**维护者 ACL，共享项目也**不是**受保护的主分支；兜住它的是
   「服务端逐端点强制鉴权 + 每次操作记 actor/time/version + 全历史可回退」，
   **绝不靠前端隐藏按钮当权限**（AGENTS.md §4）。接受这个口径是 ADR-033 决策 5 的一部分，
   不接受就要回头改「自由覆盖 / 自由回退」的产品规则，二者只能选一个
10. 📅/✅ **共享内容与历史版本对本实例所有登录用户可见**（可见性本身是服务端口径，✅ 已实现）：
    发布等于把返回值 body（可能含 token / cookie /
    个人数据）交出去，且**历史会长期保留后来删掉的那些 body**。
    ✅ **控制台发布 / 覆盖前的自查提示**（阶段 C 已做）：分享与覆盖的二次确认里点名
    「返回值里不要带 token / cookie / 个人数据」+「本实例所有登录用户都能读到这些内容和**全部历史版本**」，
    共享面板与历史列表也重复一次；磁盘占用 ✅ 管理面已按**实际字节数**报告（`storage: { bytes, files, projects }`），
    ✅ 启动日志同账已加（阶段 D，两处都有，不是只有一处）
11. ✅ 手机号在共享列表与历史列表里**默认脱敏展示**（✅ 服务端：`createdBy` 非本人时打码、
    `actorPhone` 下发前脱敏、`snapshotFile` 是内部路径**永不下发**、共享项目及其历史**不返回任何私有项目的规则、
    私有项目 id 或快照路径**）；✅ 控制台侧只显示服务端给的那一份（阶段 C：他人项目显示
    `发布人 138****0000（他人空间 · 你只能复制，改不到它）`，自己的号才显示明文，
    迁移来的显示「发布人未知」；历史行显示脱敏 actor + 服务端时间）
12. 口令是「控制台入口」而非业务身份：它保护的是抓包数据，不是账号；设备绑定才是数据可见性边界
13. **快照链接即凭据**：`/s/:token` 与 `/__ec/s/:token` 免鉴权，任何拿到 token 的人都能读到
   该条记录的完整请求头与 body（含 token / cookie）。因此
   - token 为 128 位随机、不可枚举；链接默认 7 天过期（`--snapshot-ttl`），并可在控制台随时失效
   - **创建是显式动作**且只能分享**自己空间内**的记录（§4.5）；分享前控制台明确提示「链接即权限」
   - 该面**只有 GET、不转发请求**，不可当开放代理用；因此它**不改变**第 2 条对数据面的取舍口径
   - `createdBy` 不下发到免鉴权页面，避免把手机号随链接扩散

---

## 8. 各端接入要点

### 8.1 Android

- 捕获拦截器必须 **先于** 业务加密拦截器 `addInterceptor`（更外层），
  这样请求方向抓到加密前明文，响应方向抓到解密后明文（ADR-001）
- `RequestBody` / `ResponseBody` 一次性读取，必须先缓冲：
  读取 → 记录 → 用缓冲内容**重建**一个等价对象再 `proceed`
- **重定向**：拦截器内手动跟随（§3.6），`followRedirects(false)` 不得全局关闭（ADR-009）
- **超时**：代理请求的超时不得短于业务超时；超时不算可达性失败（§6.2，ADR-013）
- **token**：`Config.token` 为**预留字段**（当前服务端不校验，见 §3.2）；LAN 模式接入只需配置
  `baseUrl`，控制台侧另用手机号 + 口令登录（§4.4）
- Android 9+ 默认禁明文：在 `src/debug/res/xml/network_security_config.xml` 放行，
  且只放到 debug sourceSet
- release 隔离三重保险：`debugImplementation` + `BuildConfig.DEBUG` +
  运行时校验 `ApplicationInfo.FLAG_DEBUGGABLE`，非 debuggable 直接 no-op

### 8.2 iOS（📅 P5，接入位已预留）

- 用 `URLProtocol` 子类接管，挂到 `URLSessionConfiguration.protocolClasses`
- ATS 明文：用 `NSAppTransportSecurity → NSAllowsLocalNetworking`（iOS 10+），
  上架无需像 `NSAllowsArbitraryLoads` 那样提供理由
- `NSURLProtocol` 对 `URLSession` 的 body 丢失问题：需要走 `HTTPBodyStream` 恢复，
  或改用 `URLSession` 的 `URLSessionTaskDelegate` 侧方案
- 重定向与超时语义与 Android 一致（§3.6、§6.2）：URLProtocol 可截获 `willSendRequest` 处理跟随

### 8.3 Web

**不提供 SDK。** 前端已有更合适的方案：MSW（Mock Service Worker）、
Chrome DevTools Local Overrides、CDP 的 `Fetch.enable` / `Network.setRequestInterception`、
Vite / webpack dev server 的 proxy middleware。且 Web 请求发生在同一台机器上，
不需要跨设备引流——这正是本协议存在的前提。

唯一例外：App WebView 内 H5 的流量，可作为 P3 的轻量 JS SDK（patch `fetch` /
`XMLHttpRequest`）按需实现。

---

## 9. 版本演进

- 主版本号变化表示不兼容变更。v2 定稿后不再做破坏性变更；新增能力走「可选字段只增不改」
- **C14 不把主版本号抬到 3**，理由是 §0 C14 那条划分：SDK↔服务端契约（`Rule` 形状、`X-EC-*` 头、mock 响应结构）
  字节级不变，破坏性全部落在「服务端本地能力」一侧（管理面语义 + 数据面候选集）。
  把版本抬到 3 只会让所有旧 SDK 无谓地停引流（§6.3），换不来任何兼容性收益
- 新增字段必须可选且可缺省，旧端忽略未知字段（如 §5.4 的 `crypto` / `extract` 扩展位）
- 新增 `X-EC-*` 头必须可缺省，服务端不得因缺少可选头拒绝请求
- 服务端通过 `hello` 返回的 `protocol` 告知版本，SDK 不匹配时 fail-open（§6.3）
- 实现与本文档的偏差以本文档为准，由 roadmap 排期对齐
- **契约边界**：§2 的兼容层（第三方客户端路由/头名）与 §4.4 的控制台登录不在 SDK↔服务端契约内，
  属服务端本地能力；其参数由 CLI 注入，变更不需要协议版本号
