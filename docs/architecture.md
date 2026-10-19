# EasyCharles 架构

> 本文件是系统的**总览与机制说明**，回答「系统怎么组织、每个机制为什么这么设计」。
> 契约层见 [protocol.md](<docs/protocol.md>)（v2，唯一真相），决策背景见 [decisions.md](<docs/decisions.md>)，
> 施工顺序见 [roadmap.md](<docs/roadmap.md>)。

---

## 1. 定位与能力边界

客户端接口联调工具，对标 Charles，核心差异化：**不装证书**（ADR-001）。
通过 App 内 SDK 把请求显式引流到本地服务中转，在中转过程中完成记录、mock、顺序返回、解密展示。

- ✅ 能抓：接入了 SDK 的 HTTP/HTTPS 流量（TLS 由 App 自己发起，我们只做应用层中转）
- ❌ 抓不到：非 HTTP 私有协议（IM 长连接信令）、未接 SDK 的三方组件流量
- 目标使用者：移动端开发者在自己的 debug 构建里调试自己的 App

## 2. 总览

```
┌─ App（debug 构建）──────────────────────────────────┐
│  业务拦截器链（加解密/鉴权/埋点……）                    │
│    EasyCharlesInterceptor   ← 最外层，抓加密前/解密后明文 │
│      ├─ 数据面：URL 改写 → /__ec/p<path> + X-EC-Target  │
│      │         手动跟随重定向（协议 §3.6）              │
│      │         fail-open（协议 §6.2）                  │
│      └─ 控制面：ControlPlane（HTTP 握手 → WS 心跳/指令）  │
└──────────────┬───────────────────────────────────────┘
               │ adb reverse / 模拟器 / 局域网 WiFi（数据面不鉴权，靠网络边界）
┌──────────────▼───────────────────────────────────────┐
│ 本地服务（Node + TS，零构建，唯一依赖 ws）               │
│  index.ts 路由分派（/__ec/hello · /__ec/api/* · /__ec/p · /__ec/s · / · /s · 兼容路由）│
│  ├─ data-plane.ts   转发 · 记录 · 规则命中 · bounded buffer│
│  ├─ control-plane.ts WS 注册/心跳/指令/推送（控制台按空间过滤）│
│  ├─ rules.ts        匹配 · 序列 · 指针（按 deviceId）    │
│  ├─ snapshots.ts    现场快照（冻结副本落盘 + TTL + 能力 token）│
│  └─ store.ts        记录/设备（内存）+ 用户/绑定（落盘 store.json）│
│  web/index.html     控制台单页（登录/用户空间/列表/详情/规则/设备）│
│  web/snapshot.html  快照查看页（免鉴权只读，/s/:token）  │
└───────────────────────────────────────────────────────┘
```

### 模块地图（现状 → 目标态）

| 模块 | 现状文件 | 目标态 | 关联 |
|---|---|---|---|
| 数据面 | `server/src/data-plane.ts` | 加 bounded buffering、record-mode、兼容层设备识别；✅ C14 命中候选按 `deviceOwner(deviceId)` 过滤（不是鉴权，§5.5） | ADR-008/012/015/032/033 |
| 控制面 | `server/src/control-plane.ts` | 角色判定 + 控制台会话校验、心跳双端覆盖、按空间推送、stats | ADR-003/015/032 |
| 规则引擎 | `server/src/rules.ts` | 扩展位 crypto/extract/set；✅ C14 私有归属过滤 + 按 owner 读写 + 私有范围替换（§5.5 / §6.3） | ADR-004/011/030/033 |
| 分组 / 项目 | `server/src/groups.ts` | C13 的 `GroupStore` → ✅ C14 加 scope / owner / 历史索引 / 归档语义 / 脏值读路径兜底 | ADR-030/033 |
| 项目版本 | （新增）`server/src/projects.ts` | ✅ C14 共享项目的版本服务：copy / share（首发与覆盖）/ rollback、不可变快照、`operationId` 幂等、原子提交与 pending journal、启动恢复、实际字节数用量（§6.3） | ADR-033 |
| 管理面错误 | （新增）`server/src/ec-error.ts` | ✅ C14 五个管理面码（§6.1）在一处定义、三处抛出，避免 `error` 字段分叉成三种写法 | ADR-033 |
| 落盘 | （新增）`server/src/json-file.ts` | ✅ C14 起 `.data/` 里所有 JSON 走「同目录临时文件 + rename」，一次失败的重写不留下半截 JSON | ADR-033 |
| 存储 | `server/src/store.ts` | 用户/绑定 SQLite 化 + 记录分页；✅ C14 设备归属反查（`deviceOwner`）供数据面候选集使用；版本快照与 journal **不在这里**，落 `projects.ts` + `.data/projects/`（§6.3） | ADR-010/015/033 |
| 快照 | `server/src/snapshots.ts` | 记录冻结副本落盘、TTL 过期、数量上限、能力 token | ADR-017 |
| 握手/路由 | `server/src/index.ts` | wsUrl 按 Host、login/logout/me、会话鉴权、admin 角色校验、兼容路由挂载；✅ C14 项目端点按会话手机号授权 + copy/share/rollback/archive，启动顺序 = recover → migrate → listen | ADR-014/015/018/033 |
| 配置 | `server/src/config.ts` | `--lan` 真正绑 0.0.0.0、`--password`、`--admin`、`--compat-*` 参数化 | ADR-012/015/018 |
| Android SDK | `android-sdk/easy-charles/` | 手动重定向、超时语义；`Config.token` 降级为预留 | ADR-005/009/013/015 |
| 控制台 | `server/web/index.html` | 登录页/用户空间/设备绑定、分页、重定向链折叠、未记录 body 提示、返回值 JSON 树查看器（放大查看 + 收起 + 缩略图 + 复制）、管理面板（admin）；📅 C14 「我的项目 / 共享项目」两栏 + 复制 / 分享 / 历史回退，且规则保存改作用域安全写入 | ADR-008/009/015/018/033 |
| 快照页 | `server/web/snapshot.html` | 免鉴权只读查看页（`/s/:token`，数据取自 `/__ec/s/:token`） | ADR-017 |
| 关于页 | `server/web/about.html` | 架构原理图 + 请求生命周期 + 客户端接入说明（静态，`/about` 免鉴权） | ADR-001/015 |
| 加解密 | `server/src/crypto/` | 密钥档 + 路由匹配 + 插件化加解密 + 打码视图 + schema 驱动表单；✅ 表单化 + 插件化 P0/P1（SPI + builtin + 私有插件目录 + `/crypto` 配置页），📅 worker 隔离 | ADR-011/039/040 |
| mock CLI | `server/tools/mock-cli/` | 给 AI agent / 脚本的命令行：只走管理面、可打远程实例、写操作读回校验（P0 外壳 + P1 读/开关/删除 + P2 `api create/update/copy` 与四条并行数组已可用；服务端 group 模型 P3）；📅 C14 `group copy/share/history/rollback` 与 private/shared 区分（CLI 的 `project` 仍是服务地址别名，不是业务项目） | ADR-027 / ADR-028 / ADR-033 |
| iOS SDK | （新增）`ios-sdk/` | P5 | ADR-001 |

---

## 3. 数据面（核心）

### 3.1 请求生命周期

```
SDK 拦截器（最外层）
 1. 缓冲 request body（body 只能写一次，后续所有回放基于快照）
 2. URL 改写 + 注入 X-EC-Target / Device-Id / Session-Id / App-Id / Seq（X-EC-Token 为预留字段）
 3. chain.proceed(改写后的请求)

服务端数据面
 4. 解析目标头：X-EC-Target，或兼容层配置的目标头（--compat-target-header，默认关闭）
 5. 无 X-EC-Device-Id 时按兼容层身份头派生设备标识（安装 ID 优先）并在数据面 upsert 设备（ADR-032）
 6. 解析目标 URL → 400 EC_BAD_TARGET
 7. 规则引擎命中？→ mock（含序列指针、delay）或 passthrough
 8. 剥离 X-EC-*、兼容层头与 hop-by-hop 头，重写 Host，强制 Accept-Encoding: identity
 9. 请求侧：content-length 已知且 ≤ 512KB → 缓冲；否则流式
10. 转发上游（http/https），上游错误 → 502/504，绝不重试
11. 响应侧：边转发边缓冲（ADR-008），记录实际字节数
12. 组装 Record → store → 按设备归属推送控制台（ADR-015）
```

> 数据面**不鉴权**（ADR-015）：可及性完全由监听地址决定，安全边界见 §9。

### 3.2 头处理（正确性核心，勿动）

- 剥离：全部 `X-EC-*`（**不得**转发给上游）、兼容层配置的目标头/身份头、hop-by-hop 头
- 重写：`Host` = 目标 URL 的 host；`Accept-Encoding: identity`（让上游返未压缩内容，记录明文；
  返回给 App 时同步去掉 `Content-Encoding`）
- 透传：其余头原样；`Location` 原样（resolve 归 SDK，协议 §3.6）
- 坑：Node 的 headers 对象按小写 key 处理，`out['host']` 赋值会覆盖原始 key，顺序无关

### 3.3 缓冲与背压

| 场景 | 请求侧 | 响应侧 |
|---|---|---|
| content-length 已知且 ≤ maxBufferBytes | 缓冲后转发 | 缓冲（完整记录） |
| chunked / 超阈值 / 二进制 / SSE | 流式转发 | 流式 + 采样 + 计数 |
| SSE / WebSocket 升级 | — | 永远流式，只采样 |

- 响应**边转发边缓冲**：每块同时 append，超阈值丢弃缓冲只留采样；内存上界
  `maxBufferBytes + sampleBytes`（ADR-008）
- 背压：`res.write()` 返回 false → `upRes.pause()`，等 `drain` 再 `resume()`（P0 已实现）
- 记录侧 `bodySize` = 实际传输字节数（边转发边计数），与 content-length 无关（C4）

### 3.4 错误处理（P0 必修）

- **上游半途断流会崩进程**（实测复现）：缓冲路径 `void readBody(...).then(...)` 无 `.catch()`，
  流式路径无 `upRes.on('error')`，ECONNRESET → unhandled rejection → 进程退出。
  修复：两个路径都挂 error 处理，断流按 `EC_UPSTREAM_UNREACHABLE` 收尾（roadmap P0.1-01）
- 客户端断连：`res.on('close')` 时销毁未完成的上游请求（P0 已做，仅覆盖未 settled 场景）

---

## 4. 控制面

```
SDK 启动
 └─ HTTP /__ec/hello（免鉴权）→ 拿 protocol/wsUrl/config
    └─ WS /__ec/ws → 首条消息 hello{identity} → welcome
       ├─ 每 30s heartbeat → heartbeat_ack
       ├─ 业务 setUser/setEnv/setTags → identity_update
       └─ 收 command（set_enabled/reset_mock/...）

控制台（浏览器）
 └─ POST /__ec/api/login { phone, password } → session（存 localStorage）
    └─ WS /__ec/ws → 首条消息 subscribe{session}（校验失败 close 4001）
       ├─ 记录推送只发当前空间已绑定设备；未绑定设备仅设备行可见（ADR-032）
       └─ command（reset_mock / set_enabled / ...）
```

- 角色判定：首条消息 `hello`（带 identity）→ SDK（免鉴权）；`subscribe` → 控制台
  （**必填 `payload.session`**，失败 `close(4001)`）
- 推送隔离：仅推送自己当前绑定设备的记录；未绑定设备的请求不推送（ADR-032）
- 心跳判定：协议层 ping/pong（每 15s ping，静默超 3×heartbeatMs 才踢），
  兼容不发应用层心跳的浏览器控制台；控制台重连后补拉记录（roadmap P0.1-07 已修）
- 控制面故障不影响数据面（ADR-003）：SDK 的 ControlPlane 与拦截器完全独立，
  控制面失败不得影响请求转发

---

## 5. 规则引擎

### 5.1 匹配与优先级

- 条件：method / host / path（glob `*` `?` 与 `re:` 正则）；不配置视为通配
- **只取最高优先级一条**；`passthrough` 会遮蔽低优先级 `mock`（协议 §5.4 明示，不设计成叠加）
- 坑：`host` 匹配对象是带端口的 `u.host`（`api.foo.com:443`），规则写 `host` 时需带端口
  （roadmap P0.1-10 决定是否在引擎层归一化）

### 5.2 多返回值与序列 mock（ADR-025）

- 返回值来源：`action.responses`（多条）非空即用它，为空才回落到旧形态 `action.response`（单条）
- `action.mode`：`static`（单条，缺省）/ `specific`（多条中指定 `pinIndex` 那条，越界 clamp）/
  `sequence`（按 `seqMode` 推进）
- 指针 key = `${deviceId}:${ruleId}`，`seqMode`：`in-order`（停最后）/ `loop`（回绕）/
  `once-then-passthrough`（走完放行上游）/ `random`
- `once-then-passthrough` 走完返回 `null` → 数据面直连上游（已验证）
- **指针是下标**：拖动排序（= 改 `responses` 数组顺序）不重置指针，需要对齐时全量重置
- 控制台可一键重置全部指针；指令 `reset_mock`（全局）
- 写入口（管理面 PUT）校验 `responses` 是对象数组、`pinIndex` 是有限数；读路径另有 clamp / 丢弃兜底
- 控制台把「指定 / 按顺序 / 随机」暴露成命中方式，返回值列表可拖动排序、可加备注名 `name`

### 5.3 分组（ADR-030）

- **只有两层实体**：`Group`（容器）→ `Rule`（一个接口）→ `action.responses[]`（一组返回值）。
  「模块」不是新实体，它就是 `Rule`——再加一层会与 `Rule` 形成同义双表，两张可写的表必然漂移
- **命中口径是一条 AND**：`rule.enabled` 且（无 `groupId` 或 所属分组存在且 `enabled`）。
  关组**不改写**组内任何规则的 `enabled`，重开即恢复原状；两个字段各回答一个问题
- **悬空 `groupId` 按「未分组」处理（照常命中）**：反过来（不命中）就是
  「控制台显示已启用、实际什么都不 mock」的静默失效。存在性校验做在 CLI 侧，
  服务端 `validateRuleShape` 仍只管结构——与它「不做取值范围与语义校验」的既有边界一致
- **删组不删规则**：清空组内规则的 `groupId` 并回 `ungrouped` 计数
- **关组不重置顺序指针**：指针是 `(deviceId, ruleId)` 的下标状态（ADR-004），
  组开关只决定参不参与匹配
- 落盘 `.data/groups.json`（独立文件，`rules.json` 的数组形状一字未改）；
  管理面五个端点见协议 §4.7；控制台 UI 不在本期（D4），带 `groupId` 的规则在控制台里
  仍然**保存无损**（P2 的草稿原样副本机制），只是看不出归属
- ✅ **本节整体是 C13 的口径，其中四条已被 C14 覆盖**（阶段 B 服务端已改，逐条以 §5.5 为准）：
  1. 「命中口径是一条 AND」里的**无 `groupId` 也命中** → 现在必须先属于调用者的私有项目；
  2. 「悬空 `groupId` 按未分组处理（照常命中）」→ **结论翻转**为永不命中（翻转的两个前提见 §5.5 坑点 1）；
  3. 「删组不删规则、清空 `groupId`」→ 新口径下**删私有项目必须级联删自己的规则**；
     共享项目**不再有物理删除**这一档：`DELETE` 只打「待删除」标记，7 天内可恢复（ADR-037，见 §6.3）；
     协议 §4.7 里 C13 的 `ungrouped` 计数已随之删除；
  4. 「带 `groupId` 的规则在控制台里仍然保存无损，只是看不出归属」→ **这句现在不成立了**：
     控制台的保存路径原本是 `GET /__ec/api/rules` + 全量 `PUT /__ec/api/rules`，而 C14 下这个 PUT
     只接受「调用者私有项目里的规则」。阶段 B 落地当时的表现是**升级后控制台规则列表恒空**（旧规则都在
     共享容器里，不再下发），而**新建的规则没有 `groupId` 可带 ⇒ 保存必 `400 EC_SCOPE_MISMATCH`**。
     ✅ **阶段 C（2026-10-16）已补齐，两条路径都改了**（只改其一等于留一个必然报错的入口）：
     编辑器改为按条写（`server/web/index.html` `saveDraft()` 走 `POST /rules` / `PUT /rules/:id`，
     列表读 `loadRules()` 后按项目切片 `rulesOfProject()`，项目栏 `renderProjectNav()`）；
     原先并存的「规则 JSON 直编」抽屉（整份 `PUT` + 本地写前预检）**已于 ADR-036 移除**——
     控制台不再有任何整份替换规则的入口，批量改规则走 `docs/mock-cli.md`。
     当时这是阶段 B 与阶段 C 之间的真实缺口，不是服务端 bug，也**没有**为了给控制台留口子放宽写入口校验
  - 其余（关组不改写 `enabled`、关组不重置指针、独立 `groups.json`、结构校验的边界）继续有效；
    「管理面五个端点」也已扩到含 archive / copy / share / versions / rollback，见协议 §4.7

### 5.4 扩展位（目标态）

- `action.crypto`（P2，ADR-011）：插件与 mock 回写联动
- `action.extract` / `action.set`（P3）：变量提取与模板替换
- 未实现前必须被忽略（协议 §9 演进原则）

### 5.5 私有 / 共享项目（C14 / ADR-033）✅ 服务端（阶段 B）+ 控制台（阶段 C）已实现，CLI 见 §2 表格与 roadmap P7

> 这一节描述**目标态**，服务端部分（`groups.ts` / `rules.ts` / `projects.ts` / `data-plane.ts` / `index.ts`）
> 已按它落地并用 `tools/selftest.ts` 锁住；控制台也已按它落地（阶段 C：`web/index.html` 的
> 「我的项目 / 共享项目」两栏、按条作用域安全保存、复制 / 分享 / 历史 / 回退 / 归档），
> 由 `tools/console-mock-check.mjs` 锁住其中的归属判定与预检纯逻辑。
> mock CLI 也已按它落地（阶段 D：`group copy/share/history/rollback/archive`、`api` 全线按私有项目归属读写），
> 由 `tools/mock-cli/selftest.ts` 锁住（514/0）。

- **候选集的一条完整 AND**（`rules.ts` 的 `resolve()`，协议 §5.4）：
  `rule.enabled` **且** `project.scope === 'private'` **且** `project.enabled` **且**
  `project.ownerPhone === deviceOwner(requestDeviceId)` **且** METHOD/HOST/PATH/params 匹配。
  归属这一项加在 C13 那条 AND **之前**，顺序不影响结果但影响可读性：先问「这套规则是不是你的」，
  再问「它自己开没开」
- **数据流**（唯一新增的一根线，落在既有调用上）：

```
data-plane.handle()
  ├─ deviceId = X-EC-Device-Id            （既有）
  ├─ owner    = store.deviceOwner(deviceId)  ← 与 recordVisible() 同一个函数，不另起真值来源
  └─ rules.resolve({ ...既有入参, ownerPhone })
        └─ 过滤：private && enabled && ownerPhone 相同   ← 共享项目在这一层就进不来
```

  `owner === null`（未绑定设备）⇒ 候选集为空 ⇒ 全部原样转发上游。**这不是拒绝请求**，
  数据面仍然不鉴权（ADR-015），SDK 零改动
- **共享项目永不直接命中**：这是 C14 的立身之本，也是最容易被「顺手支持一下」破掉的一条。
  连带后果：**共享项目的顺序指针天然不推进**（不参与匹配就不会走到 `pickResponse()`），
  不需要额外代码，但**必须有用例锁住**——一旦哪天给共享加了"预览命中"，别人复制来的序列起点就偏移了
- **多私有项目同时启用**：命中仍只按规则级 `priority` 降序取一条，同优先级沿用「数组里先出现者优先」
  的稳定顺序。**不引入项目级优先级**（ADR-033 决策 2）：归属维度与排序维度一旦耦合，
  A 抬优先级就会遮蔽 B 的规则，等于把 C14 要解决的隔离问题换成一个更难查的遮蔽问题
- **既有语义原样保留**：`static` / `specific` / `sequence` 的判定顺序、指针按 `(deviceId, ruleId)` 隔离（ADR-004）、
  `once-then-passthrough` 走完放行、关组不改写规则（ADR-030 决策 2）——C14 **只**加归属过滤，
  不碰选择逻辑，也不改 `Rule` 的形状
- **两处最容易实现错的地方**（✅ 两条都已按此实现，并各有自测用例锁住）：
  1. **私有项目删除必须级联处置自己的规则**（✅ `index.ts` 的 DELETE 分支：先 `removeByGroup` 再 `groups.remove`，
     回 `{ ok, removedRules }`）。C13 的「删组不删规则、清空 `groupId`」在全局语境下是无损，
     在新语境下等于把规则变成无归属 ⇒ **永不命中而控制台仍显示已启用**。协议 §5.4 的「悬空 `groupId` 按未分组照常命中」
     这条兜底在 C14 下**结论翻转**，翻转不产生静默失效的两个前提（迁移不留无归属规则 ✅ + UI 显示归属 ✅ 阶段 C）见协议同节；
  2. **`PUT /__ec/api/rules` 必须收窄成私有范围替换**（✅ `rules.ts` 的 `replacePrivateScope()`，
     `replaceAll()` 降为内部整表路径：只给版本服务、journal 恢复与测试夹具用）。
     留着全表覆盖的语义 = 任何登录用户仍能一键删掉
     所有人看不见的规则（F-15 那类事故的放大版）。

---

## 6. 存储层

### 6.1 现状（P0）

- 内存环形缓冲：`records[]` 上限 `maxRecords`（默认 2000），`splice` 头裁
- 设备表：`Map<deviceId:sessionId, DeviceEntry>`，对外按 deviceId 聚合最新会话；每条 entry 带 `owner`（归属手机号）
- 用户空间：`users: Map<phone, User>`、`sessions: Map<sessionId, { phone, expiresAt }>`、`bindings: Map<deviceId, phone>`
- 落盘：`server/.data/store.json` 保存 **users + bindings + sessions**（三类都跨重启保留，ADR-031）；
  会话带 `expiresAt`（`--session-ttl` 小时，默认 720，`0` = 永不过期），恢复时**逐条校验形状**、
  过期即剪、上限 500 条；记录与设备在线状态仍在内存
- 规则：`rules.json` 文件（配置类，人工可读，不入库）
- 问题：记录无字节上限（2000 × 512KB ≈ 1GB 最坏）、重启丢记录、无检索、`getRecord` O(n)

### 6.2 目标（P1，ADR-010）

- `Store` 抽象保留唯一入口（`addRecord` / `listRecords` / `getRecord` / 设备表），SQLite 作为后端可切换
- 首选 `node:sqlite`（零依赖，符合项目洁癖）；Node 22 需 `--experimental-sqlite`，
  P1 实施前用最小验证脚本确认目标环境，不行则退回 `better-sqlite3`（决策点，见 decisions.md ADR-010）
- 表结构草案：

```sql
CREATE TABLE records (
  id            TEXT PRIMARY KEY,
  seq           INTEGER,
  device_id     TEXT, session_id TEXT,
  started_at    INTEGER, duration_ms INTEGER,
  method TEXT, url TEXT, host TEXT, path TEXT, query_json TEXT,
  req_headers_json TEXT, req_body TEXT, req_body_encoding TEXT,
  req_body_size INTEGER, req_body_truncated INTEGER,
  status INTEGER, res_headers_json TEXT, res_body TEXT,
  res_body_encoding TEXT, res_body_size INTEGER, res_body_truncated INTEGER,
  upstream_ms INTEGER, upstream_protocol TEXT, upstream_error TEXT,
  mocked INTEGER, decrypted INTEGER, streamed INTEGER, redirected INTEGER
);
CREATE INDEX idx_records_device_time ON records(device_id, started_at DESC);
CREATE INDEX idx_records_time ON records(started_at DESC);

-- 用户空间与设备归属（当前在 store.json，P1 一并入库）
CREATE TABLE users (
  phone TEXT PRIMARY KEY, created_at INTEGER, last_login_at INTEGER,
  last_bound_device_id TEXT
);
CREATE TABLE bindings (
  device_id TEXT PRIMARY KEY, phone TEXT, bound_at INTEGER
);
```

- 记录检索按归属过滤：`listRecords({ owner })` → `JOIN bindings ON bindings.device_id = records.device_id AND bindings.phone = ?`

- 分页：cursor 分页（`?cursor=<started_at,seq>` + `limit`），替代现在的 `slice(-limit).reverse()`
- 写入策略：同步单条 insert（本地工具 QPS 低，512KB 写入毫秒级可接受）；
  若实测阻塞明显 → 写队列批量落库（入口已抽象，替换成本低）
- 设备表 / 规则文件维持现状方案

### 6.3 项目、版本快照与 journal（C14 / ADR-033）✅ 服务端已实现（`server/src/projects.ts`）

- **文件布局不变的部分**：active rules 仍然只在 `rules.json`，项目元信息仍然只在 `groups.json`，
  两个文件的数组形状一字未改（ADR-028 的逐字节读回校验与 ADR-030 的独立成分文件都依赖这一点）。
  **不上 SQLite、不合并成一个文件、不引入配置文件格式**：这三条在 C14 的讨论里都提过，
  代价分别是「引入运行时依赖，违反 AGENTS.md §1」「读回校验与手改兜底全部重写」「新增第三种配置入口」
- **新增落盘点（全在 `.data/` 内，已 gitignore）**：

```
.data/groups.json                     项目元信息（含 scope / owner / 版本指针 / lineage）
.data/rules.json                      active 规则（形状不变）
.data/projects/<projectId>/<versionId>.json   不可变版本快照：完整项目定义 + 全部规则与返回值
.data/projects/index.json              历史索引：projectId → ProjectVersion[]（元数据，不含 body）
.data/projects/journal.json            { pending: <operationId + after{rules,groups} + 待写版本> | null,
                                         receipts: <最近 100 条已提交操作的回执> }
```

- **一笔 share / rollback 的固定顺序**（跨三个写入点，所以必须成笔。下面是 ✅ 实现里的真实顺序，
  `ProjectService.commit()`，与协议 §5.5 一一对应）：

```
1. 校验完整新状态       validateRuleSet 逐条结构 + 全表 ruleId 唯一 + 快照 payload 的实际 UTF-8 字节数
2. 写不可变快照         projects/<pid>/<vid>.json（临时文件 + rename，已存在即视为冲突，绝不覆写）
3. 写 journal           记 operationId、目标状态 after{rules,groups}、待生成的版本，状态 = pending
4. 提交 active 状态     rules.json → groups.json（各自临时文件 + rename）
5. 补历史索引 + 落回执   index.json 追加该版本（按 versionId 幂等）→ 清 pending、把结果写进 receipts
```

  任一步抛错就尽力把两份表回到提交前的状态、删掉本次写进去的快照与 pending，再把**原始错误**原样抛出
  （回滚本身再失败也不盖掉原始错误——那是诊断的唯一线索）。绝不「几条成功几条失败」（F-15）。
- **启动时先恢复再对外服务**（`index.ts` 的顺序是 recover → migrate → listen，两步都必须在 listen 之前）：
  journal 里有 pending 就按 `operationId` 判定，只有两种结论，**都做前滚、不做后滚**——
  快照与 journal 齐 ⇒ 重放第 4、5 步把提交做完；
  快照文件缺失（journal 说该有）⇒ **既不前滚也不后滚**：active 一字不动、抹掉 pending 并如实报告 `abandoned`。
  这里不伪造回滚目标：journal 只存 `after`，凭它写不出「旧状态」，猜一个就是把数据搞得更糟
  （✅ 实现即如此；本节此前写的「回滚到 journal 记录的旧状态」是与代码不符的口径，已按实现改正，
  协议 §5.5 同一条早已写成前滚/abandoned 两分支）。**这一步不是可选的健壮性**：跨文件半提交会让
  「历史说分享过、当前规则没变」这种对不上的状态落盘，重启不自愈，正是 F-15 那类事故的形态（AGENTS.md §4）
- **`operationId` 幂等**：同一 id 重发直接返回首次结果并标 `replayed: true`，不产生第二个版本、不写第二条审计。
  CLI 与 agent 的超时重发是常态，不是异常路径（✅ 回执存在 `journal.json` 的 `receipts[]`，
  由 `readJournal()` 统一读出并过滤脏条目，`recover()` 与 share / rollback 的幂等判定都走它。
  回执**只留最近 100 条**（`RECEIPT_MAX`）：它只为「超时重发不重复出版本」服务，不是历史，
  剪掉旧回执不删任何版本，代价是很久之前的重发不再被识别为同一笔）
- **历史无限保留**：默认不自动清理、不静默截断（用户要「任意历史都能回退」，过期会直接废掉这个承诺）。
  代价要在启动日志与管理面按**实际字节数**报告（不是条数估算，AGENTS.md §6），并且发布入口要提示
  「旧版本会保留后来删掉的 response body」。限额是另一个决策，不在这次顺手做
  - ✅ 管理面 overview 已给 `storage: { bytes, files, projects }`（`storageUsage()` 数的是真实字节）；
    ✅ 控制台发布 / 覆盖 / 回退前的自查提示已做（阶段 C）；✅ 启动日志同一份账已加（阶段 D）
  - ✅ 单份快照 payload 有 **64 MiB** 硬上限（超限 `507 EC_STORAGE_UNAVAILABLE`，整笔不提交、
    文案带真实字节数与上限）。**这个数是实现自己拍的，不是契约定的**，已登记为 roadmap P7 的待产品确认项
- **归档 ≠ 删除 ≠ 待删除**（ADR-037）：
  - **归档**（`archived: true`）：长期保留但标记停用，快照与分享记录不删，谁都能继续覆盖它；
  - **待删除**（`pendingDeleteAt` / `purgeAt`）：有倒计时的删除意图，**只对 shared 有这一档**。
    发起删除时只写两个时间戳，规则、历史版本、快照一条不动，7 天内任何人 `restore` 即恢复原状；
    到期仍无人恢复，启动清扫与每 30 分钟的定时清扫才真删（顺序：规则 → 项目 → 历史目录，
    中途崩了留下的是「空项目」而不是「无归属规则」，下一轮能自愈）。
    待删除期间 `share` / `rollback` 一律 `409`——往里写的内容会跟着项目一起消失，是最难查的静默丢失；
  - **立刻物理删除**：只给 private（级联删自己的规则 + 历史目录，`removedRules` 如实回报）。
    私有项目没有回收站，控制台的确认态必须写明「无法撤销」。
  - 为什么不给 shared 直接物理删：任何登录用户都能删，而它可能装着别人正在用的回退点
    （迁移容器「旧版共享规则」更是全服存量规则的唯一落点）。7 天宽限期是「删得掉」与
    「删错了还能救」之间的折中，成本只是多一个字段与一条清扫路径

---

## 7. 加解密插件（✅ ADR-011 / ADR-039 / ADR-040）

### 7.1 职责定位（重要修正）

SDK 拦截器在加解密拦截器**外层**，请求方向抓到加密前明文、响应方向抓到解密后明文——
所以**代理侧解密不是必需**，插件不可替代的职责是 **`encrypt`**：mock/改写的明文响应必须
加密回写，否则 App 的解密拦截器解不开。`decrypt` 的意义在于控制台想展示 App 侧的密文原文，
以及**在没有 SDK 的位置**（Converter 里做的加解密、兼容层接进来的第三方客户端）也能看到明文。

### 7.2 形态与落点

```
server/.data/crypto/settings.json        ← 密钥档 + 路由，gitignore，不进发布包
server/.data/plugins/<name>/             ← 私有插件目录（只扫一层，不进库、不进发布包）
server/.data/crypto/scripts/<name>.mjs   ← 单文件脚本：一段代码，入密文出明文（没有 schema）
server/crypto.example.json               ← 只有占位值的模板（可进库）
server/src/crypto/index.ts               ← 门面（对外签名不变）
server/src/crypto/store.ts               ← CryptoStore：加载 / 校验 / 匹配 / 打码视图 / 插件引用计数
server/src/crypto/profile.ts             ← 密钥档归一化（两种配置形态互斥）+ header 白名单
server/src/crypto/transform.ts           ← 解密：extractCipher → plugin.decrypt → 明文
server/src/crypto/plugin-types.ts        ← 插件 SPI（text + options → text）+ 上下文类型
server/src/crypto/registry.ts            ← 内置插件注册表 + 插件结构校验
server/src/crypto/builtin.ts             ← 内置引擎（AES / DES / SM4 / AEAD），也是一个插件
server/src/crypto/loader.ts              ← 私有插件目录扫描 / manifest 校验 / 带版本号 import
server/src/crypto/script.ts              ← 单文件脚本：一个文件两个函数，包成标准 CryptoPlugin
server/src/crypto/manager.ts             ← PluginManager：重扫、列表视图、试跑
server/src/crypto/schema.ts              ← configSchema 驱动的 options 归一化 + secret 打码
server/examples/rot13/                   ← SPI 最小可跑示例（演示插件长什么样）

数据面（data-plane.ts）
 ├─ 请求体：decrypt(profile.request, headers)  → record.request.body（明文）+ rawBody（密文）
 ├─ 响应体：decrypt(profile.response, headers) → record.response.body（明文）+ rawBody（密文）
 └─ mock：  encrypt(profile.encrypt, headers)  → 发给 App 的字节加密，记录里 body 仍是明文

管理面（index.ts）
 ├─ /__ec/api/crypto{,/test,/reload}         → GET 只回打码后的 key/iv/options
 ├─ /__ec/api/crypto/plugins{,/reload,/test} → 插件列表 / 重扫 / 不落库试跑
 └─ /crypto                                  → 加解密配置页（插件表 + 密钥档表单 + 路由表）
```

- **规则与密钥分离**：`Rule.action.crypto` 只存 `{ profileId }`，`settings.json` 里才有 key。
  规则会被导出 / 分享 / 截图，密钥是全局资产（ADR-039 决策 1）。
- **两层可插拔（ADR-040）**：内核只认 SPI，内置引擎也走同一条路径（`plugin: 'builtin'`）。
  业务变形（非常规布局 / 自定义编码 / 私有算法）放 `<dataDir>/plugins/<name>/`，
  公开仓库里没有任何具体实现。SPI 边界划在**密文串**：内核管「密文在哪」，插件管「这段字怎么变明文」。
- 表单化配置（算法/模式/Key/IV/编码/wrap）走 `node:crypto`，不引入依赖；脚本模式（worker）
  仍未实现——它要先有「用户脚本的权限边界」这个前提，当前用表单 + 私有插件能覆盖固定密钥业务。
- 两种配置形态**互斥**：`plugin: 'builtin'` 用扁平字段（`alg`/`key`/`aead`…），私有插件只能用 `options`
  （由插件自己的 `configSchema` 描述、校验、打码）。并存直接 400，不猜优先级。
- `wrap` 解决「密文不是整个 body」的普遍情况：`raw` / `json.field` / `form.field`。

### 7.3 协议信号

- 命中路由的记录：`flags.decrypted=true`、`crypto.request/response`（含 `profileId`、
  `decrypted`、`encrypted`、失败原因）、`rawBody` = 线上原始 body（协议 §5.6）
- **解密只改记录、不改转发**：请求体与响应体原样透传，解密失败也不阻断请求
- 密钥存 `.data/crypto/` 且 `.gitignore`；发布包白名单不含 `.data/`；
  pre-commit 额外拦「换了个目录存」的密钥档（`scripts/pre-commit-privacy.sh` §5.5）、
  硬编码密钥常量（§5.6）、私有插件混进源码树（§5.7）

---

## 8. 变量与接口编排（P3 目标态草案）

- 场景：上一条响应 JSONPath 取值 → 下一条请求的 header/query/body 模板
- 机制（服务端为主，不依赖 SDK 版本）：

```
规则 action.extract: 响应 JSONPath → 会话变量池（按 deviceId 隔离）
规则 action.set:     请求模板 {{$.data.token}} → 替换 header/query/body 后再转发
```

- 存储：变量池在 Store（内存，随设备会话生命周期）
- 协议位：`action.extract` / `action.set`（协议 §5.4 已留扩展位）
- 控制台：场景编排视图（P3 一并做）

---

## 9. 安全模型（ADR-015，取代 ADR-007）

| 面 | 鉴权 | 说明 |
|---|---|---|
| 数据面 | **不鉴权** | 可及性完全由监听地址决定；默认仅回环（`adb reverse`/模拟器），`--lan` 时局域网可达 |
| 控制面 | SDK `hello` 免鉴权；控制台 `subscribe` 必填登录会话 | 会话校验失败 `close(4001)` |
| 管理面 | `/__ec/api/login` 免鉴权；其余必填 `X-EC-Session`；`/__ec/api/admin/*` 另需 `role=admin` | `/` 与控制台 API；`/about` 为纯静态文档页（不含数据），与 `/` 同级免鉴权。✅ C14：规则与项目接口**另需归属校验**（会话手机号 = 项目 owner），共享内容对普通写接口只读；copy / share / rollback / archive / versions 走同一套会话鉴权 |
| 快照面 | **不鉴权**（能力 URL，token 即凭据） | `/s/:token` 页面 + `/__ec/s/:token` 数据；**只有 GET、不转发请求**，不可当代理用（ADR-017） |

- **控制台登录**：手机号 + 全局口令（`--password`，默认 `123456`，**共享网络下必须改**）；
  首次登录即注册该手机号空间；会话落盘，`--session-ttl`（默认 30 天）内**跨重启自动登录**（ADR-031）
- **用户空间与设备绑定（ADR-032）**：新账号默认不绑定设备，控制台登录显示当前空间可见的设备，但请求列表只显示已绑定设备的记录；
  绑定/解绑后保留当前浏览筛选，不自动跳到上次绑定设备；
  用户显式绑定后，每个手机号空间最多保留一台绑定设备，换绑会释放旧设备。未绑定设备仍显示在设备列表中，
  但其请求不进入浏览列表；绑定后才可见，解绑后隐藏。归属落 `.data/store.json` 跨重启保留
- **控制台角色（ADR-018）**：`--admin <手机号>` 指定管理员，**不落盘、不兜底**（未配置则没有管理员）。
  普通用户的设备列表 = 自己绑定的 + 未绑定的（可认领），他人已绑定的不下发；`admin` 看全量。
  全局统计只在 `GET /__ec/api/admin/overview` 下发（非 admin → 403）。前端隐藏入口只是 UX，
  权限一律由服务端强制。✅ 权限模型现状：**角色仍只有 admin / 普通用户两种**，admin 不影响规则归属；
  C14 / ADR-033 加的是**归属这一维**（阶段 B 服务端已实现，见 §5.5、协议 §4.7 权限矩阵），角色模型本身不动
- **Mock 规则管理（ADR-019 / ADR-028 → C14 / ADR-033）**：ADR-019 的原口径是规则**全局生效、全局可写**，
  ✅ C14 已把它收窄为「规则属于谁的私有项目」（见 §5.5）。写入口分三条路径：
  `PUT /__ec/api/rules` 原本是**全量替换**（控制台的整页编辑用它），C14 起改为**只替换调用者的私有规则**；
  `POST /__ec/api/rules` **新建单条**（id 由服务端生成，调用方给非空 id 直接 400）、
  `PUT /__ec/api/rules/:id` **整条替换**（路径 id 权威，查无此条 404）；
  `DELETE /__ec/api/rules/:id` 与 `POST /__ec/api/rules/:id/enabled` 是**单条**删除 / 开/关。
  单条入口是为了避免多开控制台 / 多个 agent 并发时「后写的一方把别人改的其他规则一起覆盖」，
  mock CLI 的 `create/update/copy` 一律走单条，**绝不做整表 PUT**（阶段 D 会把 CLI 改成按项目读写）。
  **这些写入口共用同一个 `validateRuleShape`**——新开一门却忘了装栅栏，等于给脏数据留后门（§4）。
  开/关就是规则的 `enabled`，**没有全局 mock 开关**（不引入第二真值来源）；
  注意 `enabled` 缺省即「不生效」，整条替换时**必须显式写**它。
  ✅ **C14 改的是作用域，不是校验**（阶段 B 已实现）：同一套 `validateRuleShape` 之上再加一层归属栅栏
  （`rules.ts` 的 `requirePrivateGroup()`），`PUT /__ec/api/rules` 收窄为「只替换调用者的私有规则」
  （`replacePrivateScope()`），单条端点先查规则所属项目是不是我的（不是就 `404`，与不存在同形）。
  **新增的每个写入口（copy / share / rollback）都过同一套结构校验 + 归属校验**，
  少装一个门就是 F-15 的翻版（AGENTS.md §4）——✅ `commit()` 第 1 步就是 `validateRuleSet` + 全表 id 唯一，
  快照与 active 两份状态一起验，不给「只验客户端传来的那几条」留后门
- ✅ **项目归属隔离（C14 / ADR-033，服务端已实现）**：私有项目与私有规则只对 `ownerPhone` 那个空间可见可写，
  他人一律按 `404` 响应（不用 403，避免泄露「这个 id 属于别人」）；归属**只从已认证会话**（`sessionPhone()`）
  推导，请求体里的 `ownerPhone` / `createdBy` / 分享人 / 时间一律不采信（带这些字段 = `400 EC_SCOPE_MISMATCH`）。
  共享项目对全体登录用户可读、可复制、**永不参与命中**
- ✅ **共享库的覆盖权限是产品口径的直接推论，不是疏漏**：任何登录用户 copy 之后 share，
  就能整体覆盖共享项目并回退任意历史版本（last write wins + 全历史留痕）。
  **没有维护者 ACL**——加它就等于推翻已确认的「自由覆盖 / 自由回退」规则，二者只能选一个（ADR-033 决策 5）。
  兜法：服务端逐端点强制、每次操作记 actor/time/version、历史可回退；
  **前端隐藏按钮不算权限**（AGENTS.md §4）
- ✅ **共享 = 交出 body**：共享项目与其全部历史版本对本实例登录用户可见，历史还会保留后来删掉的返回值
  （可能含 token / cookie / 个人数据）。✅ 服务端已做脱敏与隔离（非本人的 `createdBy` / `actorPhone` 下发前打码，
  快照内部路径 `snapshotFile` 与私有项目 id 一律不下发）；✅ **控制台在发布 / 覆盖 / 回退的二次确认里给自查提示**
  （阶段 C，协议 §7 第 10/11 条：文案点名「不要带 token / cookie / 个人数据」与「历史会长期保留删掉的 body」）
- **明确的边界（有意取舍）**：数据面无鉴权 ⇒ 能访问该端口者即可把它当中转代理用（SSRF/滥用风险）。
  因此：默认只监听回环、推荐 `adb reverse`；`--lan` 只在可信网络短时开启、用完即关
- **待办**：可选的数据面鉴权（复用预留的 `X-EC-Token`）见 roadmap P1
- **快照面（ADR-017）**：把一条记录冻结成只读副本，用 128 位随机 token 组成「打开即读」的链接。
  它免鉴权，但**只能读、不能转发**，所以不是第二个开放代理；风险边界靠
  「创建是显式动作 + 只能分享自己空间内的记录 + 默认 7 天过期 + 随时可失效 + `createdBy` 不下发」控制
- 坑：`EC_UNAUTHORIZED` 现在指「控制台未登录/会话失效」，不再是 token 校验失败

---

## 10. 多端接入

- **Android（现状）**：OkHttp 应用拦截器最外层；`compileOnly` 依赖宿主 OkHttp；
  三重保险防 release 泄入（debugImplementation + BuildConfig.DEBUG + FLAG_DEBUGGABLE）
- **iOS（P5 预留）**：URLProtocol 挂 protocolClasses + `NSAllowsLocalNetworking`；
  服务端只认协议不认端类型，接入成本 ≈ 实现协议
- **Web（不做）**：已有 MSW / DevTools Overrides / CDP / Vite proxy；同机无跨设备需求
- **CLI / AI agent（`mock` 命令，ADR-027）**：只调管理面 REST，**与 App 接入无关**，
  因此可以打**远程服务实例**；零运行时依赖、不落盘口令，未实现的命令如实返回退出码 64

---

## 11. 现状与目标差距

全部差距与修复批次见 [roadmap.md](<docs/roadmap.md>)，摘要：

- **P0 稳定性**：上游断流崩进程（§3.4）；`--lan` 不绑 0.0.0.0；hello 泄露凭据 —— **均已修复并实测（roadmap P0.1 验收记录）**
- **P0 正确性**：record-mode 死配置；chunked 响应只采样；重定向逃出代理；超时误 fail-open；SDK 握手失败不重连 —— **均已修复（SDK 侧待真机验收）**
- **鉴权模型**：token 三面鉴权 → **控制台手机号空间 + 数据面免鉴权**（ADR-015，已实现；协议/架构/路线图已同步）
- **Mock 归属模型**：全局规则、全局分组 → **私有项目参与命中 + 共享项目作只读模板**（ADR-033 / 协议 C14）。
  ✅ **阶段 B（2026-10-16）服务端已落地**（`groups.ts` / `rules.ts` / `projects.ts` / `data-plane.ts` / `index.ts`，
  含启动迁移与 journal 恢复，`tools/selftest.ts` 锁住）；✅ **阶段 C（2026-10-16）控制台已按新模型改完**
  （「我的项目 / 共享项目」两栏 + 作用域安全保存，见 §5.3 / §5.5，`tools/console-mock-check.mjs` 锁住纯逻辑）；
  ✅ **阶段 D（2026-10-16）mock CLI 已按新模型改完**（`tools/mock-cli/selftest.ts` 514/0）；
  📅 远端实例与多账号真实验收、控制台像素级视觉与拖拽手感仍未做（roadmap P7）。
  **当前运行行为已经不再是「全局规则」**：升级后旧全局规则被迁成共享项目、不再命中；控制台在阶段 B 与 C 之间
  保存规则会拿到 `400`（§5.3 第 4 条，**阶段 C 已补齐**）。
  行为变更与迁移提示已**同批交付**（README 升级提示 + 启动日志的历史占用行 = 阶段 D；控制台首屏 = 阶段 C），
  否则表现为「所有人的 mock 突然全失效」
- **遗留**：可选数据面鉴权（P1）；文档与实现的其余偏差以 roadmap 为准
- **P1+**：SQLite 存储与分页；控制台增强（分页/重定向链/未记录提示）；变量编排；iOS SDK
- **✅ 已完成**：加解密插件（表单化 ADR-039；插件化 P0/P1 ADR-040，含 `/crypto` 配置页）

---

## 12. 目录结构（目标态）

```
docs/
  protocol.md        契约（v2，唯一真相）
  architecture.md    本文件
  decisions.md       决策记录（ADR）
  roadmap.md         路线图与修复清单
server/
  src/index.ts       路由分派 / 握手
  src/data-plane.ts  转发 · 记录 · 规则命中
  src/control-plane.ts WS · 心跳 · 指令 · 推送
  src/rules.ts       匹配 · 多返回值选择（指定/顺序） · 指针 · 分组过滤 · ✅ C14 私有归属过滤、按 owner 读写、私有范围替换
  src/groups.ts      分组（GroupStore：groups.json 落盘 + 结构防御 + 整组开关）· ✅ C14 scope/owner/历史索引/归档
  src/projects.ts    ✅ C14 共享项目版本服务：copy / share / rollback、不可变快照、operationId 幂等、原子提交 + pending journal + 启动恢复
  src/ec-error.ts    ✅ C14 管理面错误码（五个 EC_* 码在一处定义、三处抛出）
  src/json-file.ts   ✅ C14 起 `.data/` 内 JSON 的唯一写法：同目录临时文件 + rename
  src/snapshots.ts   现场快照（冻结副本落盘 + TTL + 上限 + 能力 token）
  src/crypto/        ✅ ADR-039/040 加解密：密钥档 + 路由匹配 + 解密展示 + mock 加密回写；
                     插件 SPI + 内置引擎 + 私有插件目录扫描 + schema 表单（P0/P1 完成，P2 worker 未做）
  examples/rot13/    ✅ ADR-040 SPI 最小可跑示例（私有插件长什么样，不含任何真实业务实现）
  crypto.example.json ✅ ADR-039 密钥档模板（只有占位值；真实配置在 .data/crypto/settings.json）
  web/crypto.html    加解密配置页（插件表 / 密钥档 schema 表单 / 解密路由表，`/crypto`）
  src/store.ts       Store 抽象（内存记录/设备 + 落盘用户/绑定 → SQLite）
  src/config.ts      配置（--lan / --password / --admin / --record-mode / --snapshot-ttl / --compat-*）
  web/index.html     控制台单页（登录 / 用户空间 / 列表 / 详情 / 规则 / 管理面板[admin]）· ✅ C14 两栏项目与作用域安全保存（阶段 C）
  web/about.html     关于页（架构原理图 / 请求生命周期 / 客户端接入，`/about`）
  web/snapshot.html  快照查看页（免鉴权只读，`/s/:token`）
  tools/mock-upstream.ts   自测假上游
  tools/broken-upstream.ts 断流/大响应/SSE/跳转假上游（P0.1 验收用）
  tools/console-mock-check.mjs 控制台纯逻辑回归（从 index.html 切出草稿⇄规则 / 换序 / C14 项目归属与覆盖差分来跑）
  tools/mock-cli/      mock CLI（给 AI agent 的命令行，只走管理面；P0 外壳 + P1 读/开关/删除 + P2 写路径，见 ADR-027 / ADR-028）
  tsconfig.cli.json    mock CLI 的类型检查配置（主 tsconfig 的 include 只有 src/**）
  .data/store.json   用户与设备绑定落盘（运行时产物，已 gitignore）
  .data/snapshots/   现场快照落盘，一条一个文件（已 gitignore）
  .data/projects/    ✅ C14 共享项目的版本快照、历史索引与 pending journal（见 §6.3，同目录、已 gitignore）
android-sdk/easy-charles/  Android SDK
ios-sdk/                     iOS SDK（P5，预留目录）
```
