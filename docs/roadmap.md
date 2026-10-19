# EasyCharles 路线图

> 施工原则（来自用户拍板）：**架构与文档先行，契约定稿后再编码**。
> 每项任务给出：目标 → 涉及文件 → 改动要点 → 验收方式。协议条款以 [protocol.md](<docs/protocol.md>) v2 为准，
> 决策依据见 [decisions.md](<docs/decisions.md>)，模块结构见 [architecture.md](<docs/architecture.md>)。

---

## P0.0 文档定稿（本次已完成）

- [x] `docs/decisions.md`：ADR-001~014
- [x] `docs/protocol.md`：v2 目标态契约（C1–C9 变更清单）
- [x] `docs/architecture.md`：分层与机制总览
- [x] `docs/roadmap.md`：本文件
- 后续编码只允许按本套文档施工；发现文档矛盾 → 先改文档再改代码

---

## P0.1 服务端稳定化（第一批编码）—— ✅ 已完成并实测通过

> 目标：协议 v2 的 C1–C8 中服务端部分全部落地，P0 三个「会炸/直接坏」问题清零。

### F-01 上游断流不崩进程（协议 §3.3/§3.5 / ADR-008）

- 问题：上游半途断流（ECONNRESET）→ 缓冲路径 `void readBody(...).then()` 无 `.catch()`、
  流式路径无 `upRes.on('error')` → unhandled rejection → 整个进程退出（已实测复现，含堆栈）
- 文件：`server/src/data-plane.ts`（缓冲路径 ~L263、流式路径 ~L301）
- 改动：
  - 缓冲路径：`.then(...).catch(...)`，错误按 `EC_UPSTREAM_UNREACHABLE` 收尾（复用 `respondError`）
  - 流式路径：`upRes.on('error', ...)`，客户端已断开则直接销毁，未断开则按 502 收尾
  - 顺带：`unreachable ? 502 : 502` 死三元（L350）清理
- 验收：`tools/` 下加一个「发一半就断」的假上游（脚本在仓库内），请求它 → 服务端存活、
  控制台出现 502 记录；连续触发 50 次进程不退出

### F-02 `--lan` 真正监听 0.0.0.0（协议 §2 / ADR-015）

- 问题：`--lan` 只置 `lanMode`，`host` 仍 127.0.0.1 → 局域网连不上，但 banner 打印了内网 IP（已实测）
- 文件：`server/src/config.ts`（L19-21）、`server/src/index.ts`（L156）
- 改动：`--lan` 时 `host = '0.0.0.0'`；banner 与 `/__ec/api/info` 里的可达地址仍显示内网 IP
- 验收：`npm run lan` 后 `lsof` 见 `*:8899`，`curl http://<内网IP>:8899/__ec/api/info` 通

### F-03 鉴权模型：控制台手机号空间 + 数据面免鉴权（协议 C1，**ADR-015 取代 ADR-007**）

- 问题：token 只生成不校验；`/__ec/hello` 还把 token 明文回给任何调用者（已实测）。
  进一步，**token 模型本身在联调中被判定不适用**：一把长期钥匙既无法做数据可见性隔离，
  泄漏后又直接等价于数据面被打开 → 鉴权目标改为「用户空间隔离」（ADR-015）
- 文件：`server/src/config.ts`、`server/src/index.ts`、`server/src/store.ts`、
  `server/src/data-plane.ts`、`server/src/control-plane.ts`、`server/web/index.html`
- 改动（最终实现）：
  1. `/__ec/hello` 响应**不含任何凭据**（C2）；握手免鉴权
  2. 控制台登录：`POST /__ec/api/login`（手机号 + `--password`，**首次登录即注册空间**）→ `session`
  3. 管理面会话鉴权：除 login 外都必须带 `X-EC-Session`，否则 `401 EC_UNAUTHORIZED`
  4. 控制面：SDK `hello` 免鉴权；控制台 `subscribe` 必填 `payload.session`，失败 `close(4001)`
  5. 用户空间：设备 `bind`/`unbind`；记录查询（`owner=phone`）与 WS 推送按归属过滤；
     **未绑定设备的记录不属于任何空间**
  6. 数据面**不鉴权**（ADR-015 的有意取舍，安全边界见协议 §7）；
     `Config.token` / `X-EC-Token` 降级为**预留字段**
  7. 用户与设备归属落盘 `.data/store.json`（跨重启保留）；会话内存态、重启失效
     ——「会话」这一条**已由 ADR-031 修订**：现在会话同样落盘，TTL 内跨重启自动登录
- 验收（已实测）：`tsc --noEmit` 通过；未登录访问 API → 401；登录后只见自己绑定设备的记录；
  未绑定设备的记录任何空间不可见；控制台 WS 无会话 → `4001`

> 后续行为更新（ADR-032，2026-10-16）：兼容层按安装 ID（或用户 ID + 设备名）区分手机；新账号默认不绑定，
> 设备列表显示当前空间可见设备，但未绑定设备请求不显示；每个空间最多绑定一台，换绑后旧设备回到未绑定且请求隐藏。
> `server/tools/selftest.ts` 302 项通过，`npx tsc --noEmit` 通过；双手机现场验证待做。

### F-04 record-mode 生效（协议 C3 / ADR-012）

- 问题：`--record-mode meta` 只被读取转发，从不影响记录（已实测 body 照常入库）
- 文件：`server/src/data-plane.ts`（记录组装）、`server/src/config.ts`、`server/src/types.ts`
- 改动：
  - `meta`：body 不落（`body=''`、`bodySize` 保留真实、`bodyTruncated=true`），转发照常
  - `sample`：body 只落前 `sampleBytes`
  - 请求头 `X-EC-Record-Mode` 覆盖全局（per-request > 全局 > 默认 full）
- 验收：`--record-mode meta` 发一条请求，控制台记录 body 为空但大小正确、转发完整

### F-05 bounded buffering + bodySize 修正（协议 C4 / ADR-008）

- 问题：无 content-length 的 chunked 响应永远只采样、`bodySize` 记 0（已实测：20KB 响应记录 8KB）
- 文件：`server/src/data-plane.ts`（响应处理 L260-335）
- 改动：
  - 响应侧一律边转发边缓冲：累积 ≤ maxBufferBytes 且可解析 → 完整记录；超阈值 → 只留采样
  - `bodySize` 边转发边计数，记录实际字节数（mock 与错误路径同步修正）
  - SSE / 二进制 / 大响应保持流式 + 采样
- 验收：chunked 20KB JSON → 记录完整、bodySize=20020；2MB 响应 → streamed=true、bodySize=2MB、
  body 为 8KB 采样；SSE → streamed=true、采样正常

### F-06 错误码补齐（协议 C7）

- 文件：`server/src/data-plane.ts`、`server/src/index.ts`
- 改动：`EC_PROTOCOL_MISMATCH`（426）与 `EC_UNAUTHORIZED`（401）在相应路径产生（F-03 已含 401）；
  `EC_SERVER_BUSY`（503）保留定义、当前不产生；协议表与实现对齐
- 验收：`tsc --noEmit` 通过；错误码与协议 §6.1 一一对应

### F-07 控制台 WS 心跳与补拉（协议 §4.3）

- 问题：服务端按应用层消息判活，浏览器控制台不发心跳 → 每 90s 被踢；重连后不补拉记录，
  期间记录永久丢失（已实测：94.6s 被踢）
- 文件：`server/src/control-plane.ts`（L117-128）、`server/web/index.html`（connectWs）
- 改动（二选一，推荐前者）：
  - 服务端改为协议层 ping/pong 判活（ws 库 `ping()` / 监听 `pong`），不再依赖应用层消息；
  - 或前端每 30s 发 `heartbeat` 消息
  - 重连后 `loadAll()` 补拉一次记录（两方案都需要）
- 验收：控制台开 3 分钟不重连；断连 2 秒内重连后记录完整

### F-08 hello wsUrl 按请求 Host 生成（协议 C2 / ADR-014）

- 文件：`server/src/index.ts`（L67）
- 改动：`wsUrl = ws://${req.headers.host}/__ec/ws`，不再用 `cfg.host`
- 验收：curl hello（Host: 127.0.0.1:8899）返回回环 wsUrl；Host 换成内网 IP 返回内网 wsUrl

### F-09 规则 host 端口归一化（协议 §5.4 说明）

- 问题：规则写 `host: "127.0.0.1"` 匹配不上 `127.0.0.1:9099`（已实测）
- 文件：`server/src/rules.ts`（matchOne/resolve）
- 改动：匹配前把 `u.host` 的默认端口归一化（http:80/https:443 去掉端口后匹配），
  或文档明示「必须带端口」并给控制台校验提示——**二选一，P0 先做文档提示，归一化排 P1**
- 验收：规则写带端口 host 生效；不带端口时行为在文档中明示

### F-10 杂项健壮性

- `readJson`（`index.ts`）加大小上限（如 1MB），防未鉴权路径被塞大 body
- `listRecords` 的 `limit` 参数做数值化校验（NaN 目前返回全部）
- `stats().online` 口径统一为「设备数」而非「会话数」（`store.ts`）
- 验收：`limit=abc` 返回默认值；online 与设备列表一致

### P0.1 验收记录（2025-xx 实测）

- ✅ `tsc --noEmit` 通过（零错误）
- ✅ F-01：上游半途断流 → 客户端收 502，服务端存活
- ✅ F-02：`--lan` 监听 `*:8899`（lsof 见 `TCP *:8899`），内网 IP 直连可达
- ✅ F-03（后按 **ADR-015** 修订）：`/__ec/hello` 响应不含凭据；控制台手机号登录 + 会话鉴权；
  未登录 API → 401；控制台 WS 无会话 → `4001`；记录与推送按用户空间过滤（已实测）
- ✅ F-04：`X-EC-Record-Mode: meta` → body 空、bodySize 保留真实（17）、truncated=true；
  `sample` → body 只留 8192 字符、bodySize=20020
- ✅ F-05：chunked 20KB JSON 完整入库（bodySize=20020、streamed=false）；
  2MB 响应 streamed=true、bodySize=2097152、body 为采样；SSE streamed=true；
  HEAD content-length 原样透传（不再改写成 0）
- ✅ F-06：协议版本号 1→2 全链对齐（`types.ts` / SDK）；401 由 F-03 产生；
  `EC_SERVER_BUSY` 保留定义
- ✅ F-07：控制台 WS 100s 不重连不踢（修复前 94.6s 必踢）；重连后 `loadAll()` 补拉
- ✅ F-08：hello `wsUrl = ws://${req.headers.host}/__ec/ws`（Host 回环/内网均正确）
- ✅ F-09：控制台保存规则时对不带端口的 host 给出提示（协议 §5.4 已明示必须带端口；归一化排 P1）
- ✅ F-10：`readJson` 1MB 上限（超限 413）；`limit=abc` 回退 300；`stats().online` 按设备去重
- ✅ C8/F-12 服务端配合：`X-EC-Redirect: 1` → `flags.redirected=true`；Location 原样透传；
  跳内共享 `X-EC-Seq`（新增可选头，协议 §3.2 已登记）

---

## P0.2 SDK 行为修复（第二批编码）—— ✅ 代码完成（需真机验收）

> 说明：本环境无 Android 构建链，Kotlin 改动仅静态审查 + 语法自查，未编译；
> 协议侧依赖（重定向标记）已在 P0.1 服务端落地；token 相关已按 ADR-015 降级为预留字段，
> 不再阻塞 SDK 联调，可直接用 `--lan` + 手机号登录联调。

### F-11 超时不算代理不可达（协议 C6 / ADR-005/013）

- 问题：`SocketTimeoutException` 被 `isProxyUnreachable` 命中 → fail-open 重放 = 重复提交；
  3 次慢接口误触熔断（代码审查确认）
- 文件：`android-sdk/.../EasyCharlesInterceptor.kt`（L127-140）、`EasyCharles.kt`（notifyFailure）
- 改动：
  - `isProxyUnreachable` 移除 `SocketTimeoutException`（及写超时/连接超时变体）
  - 超时异常原样抛出，不 fail-open、不计熔断
  - `Config.proxyTimeoutMs`（默认 0 = 跟随业务，不额外限制）
- 验收：SDK 单元测试：模拟代理连接超时 → 异常上抛、无第二次请求；模拟连接被拒 → fail-open 重放

### F-12 重定向手动跟随（协议 §3.6 / C5 / ADR-009）

- 问题：相对 Location 逃出代理（已实测服务端透传 + OkHttp 按代理 URL resolve → 假 404）
- 文件：`android-sdk/.../EasyCharlesInterceptor.kt`
- 改动：
  - 拦截器内循环处理 3xx+Location：基于 `X-EC-Target` 原始 URL resolve → 重建请求（snapshot 重放）
    → 更新 X-EC-Target / 保持 X-EC-Seq → 重新 proceed；上限 10 跳
  - 301/302/303 转 GET 丢 body；307/308 保持 method/body
  - 非首跳记录（服务端）`flags.redirected=true`（SDK 侧通过 X-EC-Seq 不变 + 服务端标记实现）
- 验收：接入真实跳转接口（如 `/api/login` 302 → `/home`），控制台出现 2 条共享 seq 的记录，
  App 拿到最终 200

### F-13 控制面握手失败重试（ADR-003 关联）

- 问题：先启动 App 后启动服务时，hello 失败即 return，永不重连，设备不出现（代码审查确认）
- 文件：`android-sdk/.../ControlPlane.kt`（L40-70）
- 改动：hello 失败/非 2xx → 退避重试（如 1s/2s/5s/10s 封顶 30s），直到成功或 App 停止；
  WS 失败沿用现有 5s 重连
- 验收：先起 App 后起服务，设备 30s 内出现在控制台

### F-14 SDK token 字段（协议 C1 → **ADR-015 后降级为预留**）

- 文件：`EasyCharles.Config`（`token` 字段）、`EasyCharlesInterceptor.kt`（`X-EC-Token` 头）、
  `ControlPlane.kt`（hello HTTP 头 + WS hello `payload.token`）
- 改动：保留「`Config.token` 非空才发送」的行为，但**服务端当前不校验**——
  该字段作为 P1「可选数据面鉴权」的预留接线，避免将来再动 SDK 接口
- 验收：`--lan` 接入时 `Config.token` 留空也能全链路可用（控制台另用手机号 + 口令登录）

### P0.2 改动记录

- ✅ F-11：`isProxyUnreachable` 移除 `SocketTimeoutException`（保留
  Connect/UnknownHost/NoRouteToHost）；`Config.proxyTimeoutMs`（0 = 跟随业务）；
  拦截器用 `chain.withXxxTimeout()` 应用代理超时，fail-open 重放仍走业务超时
- ✅ F-12：拦截器内 3xx 手动跟随循环（≤10 跳）；基于原始 URL resolve Location；
  301/302/303 → GET 丢 body，307/308 保持 method/body（snapshot 重放）；
  共享 `X-EC-Seq`、非首跳 `X-EC-Redirect: 1`；`buildProxyRequest`/`replay` 显式重设
  method+body，规避 one-shot body 二次消费
- ✅ F-13：hello 失败/非 2xx → 退避重试（1s→30s 封顶），成功重置；401 不重试（配置问题）；
  协议不匹配仍直接 disable
- ✅ F-14：`Config.token` 与 `X-EC-Token` 接线保留（LAN 非空才发），**服务端不校验**（ADR-015 预留）
- ⚠ 待真机验收项：`--lan` 下 SDK 全链路（hello → 控制面 → 数据面记录）；慢接口超时不上抛重复请求；
  真实 302 跳转控制台出现共享 seq 两条记录
- ✅ 控制台侧（原属 F-03）：登录页 + 用户空间 + 设备绑定已实现，浏览器实测 401 → 登录 → 可见记录

---

## P0.3 代码审查修复（2026-10-02）—— ✅ 已完成

> 来源：一次全量 code review + 实测复现。P0.1/P0.2 的验收是「按清单打勾」，
> 本轮发现的问题都是**清单没覆盖到的路径**（尤其是「输入校验」与「客户端断开」两类）。

### F-15 规则引擎抗非法输入（实测可导致数据面全量 500 + 重启不自愈）

- 问题：`PUT /__ec/api/rules` 直接 `replaceAll(body.rules as Rule[])`，无任何校验。
  传 `{"rules":{"a":1}}` → 内存里 `this.rules` 变成对象 → 数据面每条请求都 500
  （`this.rules.filter is not a function`），且 `rules.json` 已被写坏，**重启也无法自愈**。
  控制台任一登录用户都能触发（数据面本身不鉴权，规则是不可信输入的最短路径）。
- 文件：`server/src/rules.ts`（`load` / `replaceAll` / `resolve` / `pickResponse`）、`server/src/index.ts`
- 改动：
  - `replaceAll` 校验「必须是数组」+「每项必须是对象」，否则抛带 `statusCode: 400` 的错误
  - `resolve` / `pickResponse` 全部加空值防御（`r.match`、`r.action`、`priority` 均可缺失）
  - `load` 读到非数组时回退默认规则，不再把脏数据带进内存
- 验收：`node tools/selftest.ts` —— 对象型/标量数组均 400；被拒后数据面仍正常；
  缺 `match`/`action` 的规则不崩；合法 mock 仍命中

### F-16 mock 延迟期间客户端断开（实测）

- 问题：`respondMock` 的 `sleep(delay).then(finish)` 在客户端已断开时仍 `res.writeHead`，
  抛 `ERR_STREAM_WRITE_AFTER_END`（F-01 同类问题，只修了上游路径，漏了 mock 路径）
- 改动：`finish` 先判 `res.destroyed / res.writableEnded`，断开则只落记录不写响应；
  mock 响应头过滤 hop-by-hop；`status` 做 100–599 范围校验；抽出 `buildMockRecord` 复用
- 验收：selftest `[F-18]`

### F-17 请求 bodySize 取实际字节数

- 问题：`bodySize` 记的是客户端声明的 `content-length`。若客户端撒谎（声明小、实际大），
  记录里的 body 被截断但 `bodySize` 显示完整值，对不上；`stringify()` 还被重复调用两次
- 文件：`server/src/data-plane.ts`
- 改动：缓冲路径改用 `readBody` 返回的 `total`（实际读取字节数），流式路径仍用声明值；
  合并重复的 `stringify` 调用
- 验收：selftest `[F-17]`

### F-18 SDK 熔断无恢复路径（真机风险，代码审查确认）

- 问题：`circuitOpen = true` 后 `shouldIntercept()` 恒 false → **再也不会走代理** →
  `notifySuccess()` 永远不会被调用 → 熔断永久保持，只能重启 App。用户重启本地服务
  （最常见的恢复手段）无效，这是很差的调试体验
- 文件：`android-sdk/.../EasyCharles.kt`
- 改动：
  - 新增 `Config.circuitCooldownMs`（默认 30s）：熔断冷却到期后放一个请求**半开探测**，
    成功则 `notifySuccess` 清零，失败则重新计时
  - 协议不匹配这类不可恢复原因从 `circuitOpen` 拆到独立的 `disabled` 标志（需 `init` 复位）
- 验收：待真机 —— 停服务 → 连发 3 次触发熔断 → 启服务 → 30s 内自动恢复引流

### F-19 控制面 set_enabled 字段与协议不一致

- 问题：服务端下发 `{ action:'set_enabled', params:{ enabled } }`，SDK 读 `payload.enabled`
  （`payload` 就是整个对象），`params` 层没人解 → **远程启停功能实际从未生效**
- 文件：`server/src/control-plane.ts`（协议 §4.2 规定 params 直接是 `{ enabled }`）
- 改动：去掉多余的一层 `params`
- 验收：控制台下发 set_enabled → SDK 日志出现 `remote enabled=false` → 请求不再进代理

### F-20 控制台 XSS 转义不完整

- 问题：`esc()` 只转义 `& < >`，但 `data-did` / `data-id` 走的是**属性上下文**，
  设备 ID 来自 SDK 上报（`<img onerror=...>` 可逃逸出属性）
- 文件：`server/web/index.html`
- 改动：`esc()` 补 `"` / `'` 转义；两处 `data-*` 属性加 `esc()`
- 验收：设备名填 `<img src=x onerror=alert(1)>` 不执行

### F-21 重复 init 泄漏控制面线程

- 问题：`EasyCharles.init` 可被多次调用（多进程宿主 / 业务重复初始化），
  每次 new 一个 `ControlPlane` 但旧的 scheduler 与 OkHttpClient 永不关闭 → 线程与 WS 泄漏
- 文件：`android-sdk/.../EasyCharles.kt`、`ControlPlane.kt`
- 改动：`init` 加 `@Synchronized` 并先 `controlPlane?.shutdown()`；新增 `ControlPlane.shutdown()`
  关闭 WS + `scheduler.shutdownNow()` + dispatcher 关闭；所有重试点位检查 `stopped`
- 验收：待真机 —— 连续 init 5 次，线程数不增长

### P0.3 改动记录

- ✅ F-15 ~ F-21 全部落地；`tsc --noEmit` 零错误
- ✅ 新增 `server/tools/selftest.ts`（不依赖监听端口，直接驱动 handler）：
  `node tools/selftest.ts` → 10 项全绿
- ⚠ F-18 / F-21 需真机验证

---

## P1 存储与控制台增强

- **SQLite 落盘 + 分页检索**（ADR-010）：`store.ts` 抽象 + `node:sqlite`（先跑最小验证脚本确认
  目标 Node 版本，Node 22 需 `--experimental-sqlite`，不行退 `better-sqlite3`）；
  表结构与 cursor 分页见 architecture §6.2；控制台「加载更多」替代 300 条硬限；
  记录搜索下沉 SQL（LIKE url/status）
- **指令 `set_record_mode` / `disconnect` + 服务端 `stats` 推送**（协议 §4.2 表格补齐）
- **规则匹配增强**：`match.headers`（协议 §5.4 预留位）；host 端口归一化（F-09）
  - ✅ 入参匹配（2026-10-09）：`match.params` 落地（协议 §5.4 / **ADR-016**，取代原 `match.query` 预留位）。
    query + body 合并（同名以 body 为准）、AND 语义、空串 = 只要求存在、值复用 glob / `re:`；
    非对象 `params` 在 `replaceAll` 直接 400（防毒化）；selftest `[F-23]` 17 条断言覆盖
- ✅ **控制台 Mock 模式**（2026-10-09，ADR-016）：顶部「浏览 / Mock」模式切换（纯前端视图状态）；
  浏览模式详情页「Mock 此接口」把记录的方法 / 域名 / 路径 / 入参 + 返回值带进编辑器；
  Mock 模式左侧 mock 接口列表 + 右侧编辑器（入参表格、业务/公共参数分组、返回值编辑）；
  被 mock 的请求命中后直接返回、不再转发（复用既有规则引擎，未新增第二套 mock 机制）
  - ✅ **去掉「匹配范围」二选一**（2026-10-09）：原设计有「仅域名 + 路径」/「域名 + 路径 + 入参」
    两个 chip，用户反馈默认就该是后者。删除 `draft.scope` 字段与 `.chip` / `.dim` 样式；
    `draftToRule()` 改为**无条件**按 `p.on` 写 `match.params`（一个都没勾 → 不写该字段，
    协议层本就等价于只匹配域名 + 路径，ADR-016 语义不变）；列表第二行标签从
    「域名+路径(+入参)」改成**如实显示**「入参匹配 N 项」/「不校验入参」——
    原来那个标签描述的是「选了哪个范围」，现在范围固定了，标签该说的是「实际存了什么」。
    ⚠️ **不要**因为删了开关就去服务端加「是否校验入参」的字段：没有第二真值来源，
    「不校验」= 不写 `match.params`，仅此一种表达
  - 已 mock 的接口（存在 method + host + path 匹配的规则）在浏览模式详情页「Mock 此接口」**置灰**
    （2026-10-09）：不再重复 mock，改现有规则请去 Mock 模式；判定复用 `findRuleForRecord()`，
    与 `mockFromRecord()` 同一口径（大小写不敏感的 method + host + path）
  - ✅ **Mock 接口层面直接删除 / 开/关**（2026-10-09，ADR-019）：列表每条右侧直接给出
    `开/关` 与 `×`（不必先点进编辑器）；新增 `DELETE /__ec/api/rules/:id` 与
    `POST /__ec/api/rules/:id/enabled`（单条操作，不再整表 PUT 覆盖 ⇒ 多开控制台不会互相覆盖）；
    `enabled` 只接受布尔，删除顺带丢弃该规则的顺序指针；编辑器「删除」复用同一条路径。
    **没有全局 mock 开关**（开/关 = 规则的 `enabled`，不引入第二真值来源）。
    selftest `[F-26]` 覆盖命中 / 未命中 / 脏 enabled / 脏 id / 落盘 / 指针清理
  - ✅ **多返回值：指定某一条 / 按顺序命中 / 拖动排序**（2026-10-11，**ADR-025**，协议 C11）：
    服务端早已有 `responses` + `seqMode` + 指针隔离（ADR-004），但控制台没有入口，等于死配置。
    本次补齐：`action.mode` 新增 `specific` + `action.pinIndex`（多条中指定一条，越界 clamp）、
    `responses[].name`（备注，仅展示）；控制台「返回值」区改成**可拖动排序的列表**（原生 HTML5 DnD +
    `↑`/`↓` 兜底，零依赖）+ 每行「指定」圆点 + 命中方式（指定 / 按顺序[依次·循环·走完放行] / 随机）+
    每条的 状态码 / Content-Type / 本条备注 / 正文（选中哪条就编辑哪条，放大编辑同步适配）+
    「追加真实响应」（把当前记录的真实响应补成一条，做「成功 + 失败」不用手敲）。
    **单条 + 指定仍写旧形态** `mode: 'static' + response`（存量规则保存后 JSON 一字不变）；
    换序 / 增删后 `sel` 与 `pinIndex` 跟着**条目**走（不按旧下标跑偏）；
    写入口拒绝 `responses` 非数组 / 元素非对象 / `pinIndex` 非有限数（400），读路径另有 clamp / 丢弃兜底；
    顺带修掉一个既有缺陷：控制台保存返回值时**丢掉除 content-type 以外的响应头**，现在整体保留。
    selftest `[F-27]`（指定 / 顺序 / 换序 / 脏数据 / 脏 rules.json）+
    `[F-28]`（`tools/console-mock-check.mjs`：从 index.html 切出纯逻辑跑草稿⇄规则往返与换序下标重映射）。
    ⚠️ 已知限制：拖动排序 = 改数组顺序，而**顺序指针是下标**——改序不重置已推进位置，
    需要归零只能用**全局**重置（ADR-036 之后入口在 Mock 视图工具栏的「重置指针」；
    本次刻意不做单规则重置接口，见 ADR-025）
  - ✅ **命中方式的改动立即生效**（2026-10-11，用户反馈，ADR-025 补）：切
    「指定 / 按顺序+子模式 / 随机」以及点列表左侧圆点，都不再要求回去点「保存并生效」——
    它们和列表里的「开 / 关」同属开关式操作，改完就想看效果。
    三个要点（都有用例锁着）：
    ① **只对已落库的规则自动保存**，新草稿（还没点过保存）仍然走显式保存，不会凭空建规则；
    ② **不复用 `saveDraft()`**：它保存后会按落库结果重建整个草稿，连点几次时会把后一次点击
    的改动冲掉；自动落库只把 pick/pinIndex 写回该条规则，草稿其它部分（选中条目、正在输入的
    内容）原样保留。多次 PUT 串成一条链，保证后发的那次最后落地（服务端是全量替换）；
    ③ 重绘仍留在**同步**路径上（`renderMockEditor()` 先跑，再异步落库）——把重绘挪进异步里
    会让子模式下拉晚一拍出现（`md-seqmode` 取不到），实测踩过
  - ✅ **「按顺序」默认子模式改为「循环返回」**（2026-10-11，用户反馈）：多条返回值最常见的
    用法就是循环返回，「走完停在最后一条」几乎总要人再点一次下拉。⚠️ 只对**用户新选**按顺序
    的那一刻生效；`ruleToDraft()` 读存量规则时 `mode: 'sequence'` 却缺 `seqMode` **仍如实显示
    「依次」**（服务端按协议 §5.4 就是 in-order），否则会出现「界面显示循环、服务端停在最后一条」
    的静默不一致。纯逻辑用例锁在 `[F-28]`（`nextSeqPick` / `DEFAULT_SEQ_PICK`）
  - ✅ 顺手：保存后**停在原来编辑的那条**（此前每保存一次就跳回第 1 条，多条返回值时很烦）
  - ✅ **匹配条件 METHOD / HOST / PATH 只读**（2026-10-11，**ADR-026**）：这三项由记录带过来，
    在编辑器里不再可改（`readonly`，仍可选中复制；空值显示「任意方法 / 任意域名 / 任意路径」）。
    原因是手改一次就会出两类静默问题——**规则和它 mock 的记录不再对应**（典型：host 掉了 `:443`，
    规则永远命中不了，ADR-016 记过这个坑）、**「Mock 此接口」的去重失效**（`findRuleForRecord()`
    按 method + host + path 查，改了路径就查不到，同一接口可以 mock 出好几条互相遮蔽的规则）。
    需要 glob / `re:` 通配等高级匹配，走 `docs/mock-cli.md` 的命令行
    （ADR-036 后控制台已无手写规则 JSON 的入口）。
    协议 / 服务端 / SDK **零改动**；`bindMockEditor()` 里的三个 input 分支一并删除（不留第二条写入路径）
  - ✅ **匹配条件压成一行只读摘要**（2026-10-11，用户反馈，仍在 ADR-026 之下）：三个 `readonly`
     输入框占掉三行、又一直长得像「可以填」，实际没人去填。改成 `matchLine()` 输出的一行
     `GET · api.foo.com:443 · /api/user`（空值显示「任意方法 / 任意域名 / 任意路径」），
     `lockMatchInput()` 与 `input.match-lock` 样式删除。**只读约束不变**：草稿的匹配条件仍然只由
     `draftFromRecord()` / `ruleToDraft()` 赋值，`bindMockEditor()` 里依旧没有对应分支；
     host 仍显式可见（ADR-016「host 必须带端口」的坑照旧看得见）、值仍可选中复制
  - ✅ **Mock 顶部项目栏改成卡片 + 整组开关**（2026-10-18，用户反馈）：横滑栏的 chip 换成
    圆角矩形卡片（≈112×53，两行），上行「项目名 + 条数」点了切视图，选中卡浅绿底 + 双层描边；
    下行是**整组开关**，一键停用/启用整个项目（走 `/groups/:id/enabled`，**不改写**组内规则的
    `enabled`，ADR-030 的「重开即恢复」不变）。开关与切项目分成两个热区并 `stopPropagation`，
    避免「想关整组却顺手切走了视图」；「全部」是聚合视图不放开关（第二行显示项目数）；
    列表头部在整组停用时写明「整组停用，不命中」（规则自己还开着，不写这句会以为在生效）。
    纯前端，协议 / 服务端 / SDK 零改动；`console-mock-check` 补开关与选中态断言（162 通过），
    另用无头 Chrome 真 DOM 点过：切项目 / 关组 / 重开 / 停用项目空状态
  - ✅ **项目动作补齐：开启/停用 + 删除，统一二次确认弹框**（2026-10-18，用户反馈）：
    Mock 项目卡下行加「删」；模板模式的私有卡加「停用/启用」「删除」，共享卡加「删除」。
    开启/停用、删除全部走同一个居中弹框（`uiConfirm`），不再各写一套「卡片切成确认态」：
    保留取消/确认、防连点、Esc / 点遮罩关闭，文案里写明**连带删几条规则**与**私有项目没有回收站**。
    私有项目 → 立刻删除、无恢复入口；共享项目 → 软删除，待删除倒计时内可「恢复」，到期才真删。
    **宽限期由 15 天改为 7 天**（`SHARED_TRASH_MS`，ADR-037 当天修订；存量 `purgeAt` 不追溯）；
    控制台文案不再写死天数，删完的 toast 与「剩 N 天」都从服务端 `purgeAt` 算。
    `console-mock-check` 164 通过；无头 Chrome 真 DOM 26 条（开关弹框取消/确认、删除取消/Esc/确认、
    共享软删除 + 恢复、模板卡动作）全过
  - ✅ **Mock 顶部栏只列「最近选过的」+ 停用即消失**（2026-10-19，用户反馈）：项目一多，横滑两屏
    才找到刚在用的那个，「一眼看全」变成了「每次都在找」。改成：栏 =「全部」+ 最近点过的项目
    （`ec_mock_recents` 存 localStorage，最多 8 个，最近在前）+「更多 N」（没选过的收起来，点开
    就地展开、照常可选，不会变成死角）+「新建」。**停用的项目立刻从栏里消失**（渲染时过滤，
    不再留灰卡）：整组停用本来一条都不命中，留卡只会让人以为还在生效；id 仍留在最近列表，
    重新启用自动回来。当前项目被停用时 `fallbackSelectableProject()` 挪到最近列表里第一个在效
    项目（没有就回「全部」），避免「列表停在某项目、栏里却没有一张卡选中」。删除项目顺手
    `forgetProject()`；换账号（`showLogin`）清空整份最近列表（同 `ec_project`，属于上一个空间）。
    纯前端，协议 / 服务端 / SDK 零改动；`console-mock-check` 184 通过（新增最近列表载入/落盘/
    截断/脏数据、停用过滤、fallback、更多展开）；无头 Chrome 真 DOM 11 条全过（首屏只列最近的、
    展开后选未选过的、刷新后不丢、停用立刻消失 + 视图不悬空）
- **控制台增强**：重定向链按 seq 折叠；meta/sample 记录显示「未记录 body」；
  设备绑定管理页（批量解绑/改绑）；登录页记住上次手机号；二维码 `easy-charles://connect?host=<ip>&port=<port>`
  （**只带接入地址，不带任何凭据**；Android debug sourceSet 注册 scheme，扫码自动填 baseUrl）
  - ✅ 清空当前列表（2026-10-09）：面板筛选行加「清空」按钮，只清「当前空间 ∩ 当前筛选」的记录；
    服务端 `clearRecords` 按 owner + deviceId/q 过滤（协议 §4.4），selftest `[F-22]` 覆盖隔离与脏输入
  - ✅ **现场快照分享**（2026-10-09，ADR-017）：浏览模式详情页「分享快照」把一条记录**冻结**成只读副本，
    生成一条**免登录可直接打开**的链接（`/s/:token`），链接内联显示在详情卡片里可再复制。
    前台只保留「生成」这一个动作——不提供快照列表 / 失效 / 清空的管理界面（收回靠 TTL，管理走管理面接口）。
    新增第 4 个面「快照面」（只读、只有 GET、不转发 ⇒ 不放大数据面风险边界，协议 §2/§4.5/§7）；
    落盘 `.data/snapshots/`（一条一个文件），默认 7 天过期（`--snapshot-ttl` 小时，0 = 不过期）、
    上限 200（`--snapshot-max`）；创建仅限「自己空间内的记录」，`createdBy` 不下发；
    selftest `[F-24]` 22 条断言覆盖冻结解耦 / 归属隔离 / 过期 / 上限 / 落盘重载 / 脏输入
  - ✅ **控制台角色与设备可见性**（2026-10-09，ADR-018）：`--admin <手机号>` 指定管理员
    （**不落盘、不兜底**，未配置则没有管理员）；`role` 随 `login`/`me` 的 `user.role` 下发；
    新增 `GET /__ec/api/admin/overview`（全局统计 + 用户空间列表，非 admin → 403）；
    普通用户 `GET /__ec/api/devices` 只返回「自己绑定的 + 未绑定的」（保留认领流程），
    `admin` 看全量，控制面 WS 设备推送逐连接过滤；`/__ec/api/info` 移除全局 `stats`/`snapshotCount`；
    控制台顶栏「管理」入口仅 admin 可见 + 管理面板（统计卡片 / 运行状态 / **统一配置只读展示** /
    用户空间表）。selftest `[F-25]` 覆盖角色判定 / 设备隔离 / 脏输入
  - ✅ **浏览页信息密度重排**（2026-10-09）：左侧列表每行只留 `METHOD / 状态 / path / 标签 / 耗时`
    ——path 用 `shortPath()` 去掉 query，**列表不显示任何参数**，完整 URL 挂在行的 `title` 上；
    右侧顶部新增**精简摘要卡**（`接口` = `ifaceLabel()` 的域名 + path、`传参` = `bizParamLine()` 的
    `k=v · k=v`，**通用参数不显示**、超 8 项折 `+N 项`、单值超 40 字符截断）；
    **返回值不进摘要**（下方「返回值」卡片紧接着就是全文，避免冗余）；
    下方再放**完整版**：`返回值`（全文）/ `请求`（完整 URL + 全部业务参数表 + `通用参数`、`原始 Body` 折叠）/
    `Headers 与链路`。上下重复是**有意**的。新增 `shortPath()` / `ifaceLabel()` / `bizParamLine()`
  - ✅ **返回值放大查看**（2026-10-09）：「返回值」小节加「放大查看」按钮 → 弹框（`#resp-modal`，
    最大 1100×760）里用 **JSON 树**看完整返回值。收起粒度两档：点 ▾/▸ 收**单个**节点、
    **⌥(Alt) + 点 ▾/▸** 收该节点所在的**整个层级**（再点展开）；
    顶部只留**一个总开关** `#rt-toggle`：还有收起着的显示「展开全部」，否则显示「收起全部」。
    非 JSON / 被截断 / base64 / 节点 > 20000 时自动降级为原文 `pre` 并说明原因（此时总开关隐藏）。
    新增 `buildTreeNodes()` / `treeRowsHTML()` / `toggleTreeNode()` / `toggleTreeLevel()` / `toggleAllTree()`；
    收起状态用**先序下标**做键而不是 path —— path 由 key 拼成，key 里带 `/` 会重名。
    ⚠️ 占位 caret 的修饰类**不能**叫 `.empty`：会撞全局 `.empty { padding: 40px }`（空状态占位），
    实测把行高从 18px 顶成 80px；已改用 `.leaf`
    ⚠️ 曾经做过的 `层级N · 个数` chip 已于同日**移除**（用户反馈「层级」一词难懂、按钮太多）；
    按层收起的能力保留在 Alt+点击 上，`toggleTreeLevel()` 因此**不能删**
  - ✅ **渲染成标准 JSON + 复制**（2026-10-09）：用户反馈「放大查看里不是 json 格式」。
    之前只画了缩进和括号，逗号 / 闭合括号 / 键的引号全没写。现在**展开态逐字等于
    `JSON.stringify(v, null, 2)`**（已验证可 `JSON.parse` 回原值）：键带引号、非末项带逗号、
    容器闭合括号各占一行、空容器内联 `{}` / `[]`、数组元素**不渲染下标**（JSON 里数组本来没有 key）、
    字符串按 JSON 规则转义（`jsonEscape()`）。收起态用 `{ … N 项 }` —— 这是**唯一**不是严格 JSON 的地方
    （同 Chrome DevTools 约定）。
    顶部新增 `复制` 按钮：永远复制**完整展开**的 JSON（`respTree.copyAll`，与当前收起状态无关；
    不是 JSON 就复制原文）。
    ⚠️ **两个必须记住的渲染细节**：
    ① `.trow` 必须 `display:block` 不能 `flex` —— flex 会把每个 span 变块级盒，浏览器复制时
      在每个 span 之间插换行（`"code"\n: \n0`），能 parse 但粘贴出来是烂的；
    ② caret 的 ▾/▸ 用 CSS `::before` 生成（**伪元素不进选区/剪贴板**），span 里不放任何字符。
    缩进是**真实空格** + `white-space:pre`，所以「选中一段复制」拿到的是干净 JSON
    （无头 Chrome 实测：全选 == `JSON.stringify(v,null,2)` 逐字一致）。
    ⚠️ 已知限制：从**行首**开始拖选一个带 key 的容器会带上 `"key": ` 前缀 → 不是合法 JSON；
    要从 `{` / `[` 本身开始拖。选相邻多个元素（不含外层 `[ ]`）同理。
  - ✅ **缩略图**（2026-10-09）：`.jtree` 外面套一层 `.jtree-wrap`（flex 行），右侧加
    `.jminimap`（16px 宽竖条 + `<canvas>` + `.jm-view` 亮框），**内容不到视口 1.5 倍就隐藏**
    （`RESP_MM_MIN_RATIO`）。整棵树按「每一像素行取该行覆盖到的最深深度」压成刻度，
    越深横条越长 —— 一眼看出哪一段嵌套深。亮框 = 当前可见范围，等比换算；
    **点或按住拖动**缩略图跳到对应位置（目标点落在视口正中）。
    ⚠️ 两个坑：① `renderRespModal()` 原来在 rawMode 分支**提前 return**，导致降级为原文时
    缩略图不被隐藏、留着上一条的旧刻度 —— 现在 `drawMinimap()` 移到两个分支之外统一调用；
    ② 可见行逻辑抽成 `visibleNodes()`，`treeRowsHTML()` 和缩略图**共用**，避免两处跑偏
    （DOM 桩测试靠它断言「折叠后刻度数变化」）
  - ✅ **Mock 编辑器聚焦返回值编辑**（2026-10-09）：默认返回值区域改为可直接编辑的 360px textarea（可继续拖高），
    只保留返回值 body 与「重置为真实值 / 格式化 JSON / 放大编辑」操作，不展示状态码、Content-Type 等响应元信息。
    ⚠️ **2026-10-11 部分推翻**（ADR-025）：多条返回值各有各的状态码与 Content-Type（「200 成功 / 401 密码错误」
    只靠 body 表达不了），所以返回值区改为**每条一行**并恢复 状态码 / Content-Type / 本条备注 输入；
    「放大编辑 = 只有原文」也早已被树形/文本双视图取代（见上一条）。不做的是**规则级**响应元信息（那仍是规则的事）
  - ✅ **多返回值**（2026-10-11，ADR-025）：见上「多返回值：指定某一条 / 按顺序命中 / 拖动排序」
  - ✅ 放大编辑弹框在编辑态会标明**在改第几条**（`返回第 k 条 / 共 n 条`）；此前标题是写死的「编辑返回值」，
    改的是当前选中条目，多条返回值时容易改错——`renderRespModal()` 统一算标题，别在 `openRespModal()` 里另设一份
    （两份会被后渲染的那份覆盖，2026-10-11 已踩过）
    放大编辑弹框只显示返回值原文、格式化按钮与关闭；不展示接口 method/path、树形预览、复制/收起控件。
    输入实时写入草稿；Mock 模式按 `⌘S`（兼容 `Ctrl+S`）保存整条规则并生效，成功 toast；
    在放大编辑弹框内按同一快捷键则保存成功后关闭弹框。无匹配范围或保存失败时提示原因、不关闭弹框。
    格式化使用严格 JSON 解析，支持对象、数组、`null`、字符串、数字等所有 JSON 值。
  - ✅ **已决策不做**（2026-10-09，见 ADR-018 边界 4/5）：① 「管理员在控制台改全局配置」——
    用户确认「只读即可」，配置仍只走启动参数（**不是待办，别再列为 TODO**）；
    ② 全局 Mock 规则划归管理员——维持现状（`rules.json` 对所有人可写，ADR-016）。
- **可选数据面鉴权（ADR-015 遗留项）**：把已预留的 `X-EC-Token` 接线启用——
  新增 `--data-plane-token`（不配置则不校验，保持零配置接入），SDK 侧无需改动
- **持久会话**：✅ 已做（2026-10-16，**ADR-031**）——会话表落 `.data/store.json` + `--session-ttl`（默认 720 小时），
  没走「签名 cookie/JWT」那条路；无状态 token 在本项目的单进程/回环场景里换不到收益，却会把吊销与 WS 校验搅复杂
- **验收**：重启服务记录不丢；千条记录分页流畅；重启后用户与设备绑定保留（记录本身仍会丢）；
  **重启后已登录的浏览器仍自动进入控制台**（同一 token、TTL 内、没 logout）；
  可选数据面鉴权开启后无 token 请求数据面 → 401；
  快照链接免登录可读、重启后仍可读、默认 7 天过期；失效走管理面 `DELETE`（前台无管理入口）

## P2 加解密插件（ADR-011 → ADR-039）—— ✅ 表单化已实现 / 📅 脚本模式未做

- ✅ 表单化：`server/.data/crypto/settings.json` 的 `profiles`（算法/Key/IV/编码/wrap）+
  `routes`（按 method/host/path 匹配），`node:crypto` 执行；
  **规则只引用 `profileId`，密钥不进规则、不进 git、不进发布包**
- ✅ 请求/响应双侧解密：`body` 写明文、`rawBody` 写线上原始密文、`flags.decrypted` 置位；
  解密失败不阻断请求，只记 `crypto.*.error`
- ✅ mock 明文响应自动加密回写（规则 `action.crypto.profileId`）；加密失败按明文返回并记 error
- ✅ 控制台：明文为主 + 「查看密文」切换；请求侧「解密后 Body」+「密文原文」折叠；快照页同步
- ✅ 管理面：`GET/PUT /__ec/api/crypto`、`POST /__ec/api/crypto/test`、`POST .../reload`；
  GET 只回打码后的 key/iv
- ✅ AEAD（2026-10-19，**ADR-039 补充**）：`aead{ivBytes,tagBytes,tagAt,aad}` 布局，支持
  `aes-128/192/256-gcm`、`chacha20-poly1305`；`wrap.prefix`（`ciphertext:`）；`keyEncoding` 增加 `base64url`
- ✅ query 密文参数：`profile.query` + `MessagePart.queryPlain`，明文参与 `match.params`，
  `url`/`query` 保持线上原样
- ✅ 验收：selftest 30 条用例（含解密失败、脏配置、meta 不泄露、mock 加密、base64url、
  GCM 布局写反/密钥不对、prefix 回写、query 解密）
- ✅ **插件化 P0（ADR-040，2026-10-19）**：`crypto.ts` 拆成 `crypto/` 目录，内核只认 SPI，
  内置引擎包成 `builtin` 插件走同一条路径；`settings.json` 逐字节不变（内置档不写 `plugin`）；
  selftest 597 → 609 条（新增 12 条结构用例：零迁移、未知插件 400、保留名、SPI 版本、
  插件抛异常/返回 Promise/不声明 encrypt 的降级、match 带出注册表）
- ✅ **插件化 P1（ADR-040，2026-10-19）**：`<dataDir>/plugins/` 只扫一层（`lstat` 拒软链接、
  目录名正则 `^[a-z0-9][a-z0-9_-]{0,39}$`、入口只收 `.mjs`、`?v=mtimeMs` 破 ESM 缓存）；
  `manifest.json` 四字段精简版，`spiVersion` 不符**在 import 之前**拒绝（连代码都不执行）；
  `configSchema` 驱动的 options 归一化与表单（`string/integer/number/boolean` + `enum/min/max/secret/default/required`，
  不做隐式类型转换，`secret` 字段 GET 打码、PUT 回写 `••••` 表示沿用）；
  `pluginContext.headers` 白名单（≤8 个，值截断 256）把 header 送进插件；
  新增 `/crypto` 配置页（插件表 + 密钥档 schema 表单 + 解密路由表）与三个 API
  （`GET .../plugins`、`POST .../plugins/reload`、`POST .../plugins/test`）；
  `server/examples/rot13/` 作为 SPI 最小可跑示例；pre-commit 加 §5.7 拦私有插件混进源码树；
  selftest 609 → 650 条（schema 9 + 目录扫描 11 + 插件档链路 12 + header 白名单 4 + 破缓存 1 + 试跑 3）
  - **不做上传安装**：LAN 管理面收 `.mjs` 等于把管理 token 升级成 RCE，装插件只能手工放目录
- ✅ **脚本来源（2026-10-19，P1.5）**：业务变形不用再写 manifest + `configSchema`，
  `<dataDir>/crypto/scripts/<name>.mjs` 一个文件两个函数（`decrypt(text, options)` / 可选 `encrypt`），
  注册名 `script:<name>`（保留命名空间）；没有 schema → 参数退化成自由 JSON（只校验结构，
  嵌套 ≤6 层 / 单值 ≤4096 / 整体 ≤64KB），打码靠脚本声明的 `secrets`，不声明则**整份打码**；
  `/crypto` 对脚本档显示「只读代码 + 参数 JSON」而不是表单；`GET /__ec/api/crypto/scripts/:name`
  **只读**（能写 `.mjs` = 管理 token 升级成 RCE）；`server/examples/scripts/rot13.mjs` 为示例；
  selftest 650 → 676
- 📅 插件化 P2：worker 宿主（超时 `terminate` 真中断、`resourceLimits` 限内存）；
  当前只有 `in-process`，拦不住同步死循环，控制台已如实标「无隔离」
  - 详细设计见 [crypto-plugin.md](crypto-plugin.md)
- 📅 脚本化签名：`sign(ctx)` 用于改 body 后的签名重算（属 P3 改写的前置，与插件体系分开做）
- ✅ 控制台的密钥档配置表单（2026-10-19 随 P1 落地：`/crypto`）
- 未做：tag / IV 单独放在别的字段或 header 里的 AEAD 布局、非对称加密、二进制明文

## P3 变量与接口编排（ADR/协议 §5.4 扩展位）

- `action.extract`：响应 JSONPath → 按 deviceId 隔离的变量池
- `action.set`：请求 header/query/body 模板 `{{$.data.token}}` 替换后再转发
- 控制台「场景编排」视图；可选：WebView H5 轻量 JS SDK（patch fetch/XHR）
- 验收：登录接口提取 token → 下一接口 header 带 `{{token}}` 生效

## P4 导入导出

- HAR 导出（记录 → .har，含 request/response/耗时）；HAR/cURL 导入生成规则
- 控制台导出入口 + 大记录裁剪策略（meta 模式导出骨架）

## P5 iOS SDK

- URLProtocol 挂 protocolClasses + `NSAllowsLocalNetworking`；协议 v2 全量对齐
  （重定向 / fail-open / 超时语义；`Config.token` 为预留字段，数据面默认不鉴权）
- 与控制台无耦合：iOS SDK 只走数据面 + 控制面握手，用户空间/登录是服务端本地能力（ADR-015）
- 与 Android 共用同一套协议，服务端零改动（ADR-001/002 的架构红利）

---

## 部署与发布（2026-10-11）—— ✅ 已完成

> 需求：把服务端打包，提供给内网其他服务器部署（小组共用）；目标机之一是**另一台 Mac**。
> 与 P1–P5 正交，不阻塞也不依赖。

- **目标**：一条命令产出可交付的发布包，目标机零依赖、零构建、零外网即可运行；
  Linux 与 macOS 两种目标机各有顺手的启动方式。
- **涉及文件**：
  - 新增 `scripts/build-server-bundle.sh`（发布包构建 + 门禁 + 产物校验 + `.sha256`）
  - 新增 `scripts/deploy/run.sh`（Node 能力探测 + `EC_*` 环境变量 → 命令行参数）
  - 新增 `scripts/deploy/easy-charles.service`（Linux systemd unit 模板）
  - 新增 `scripts/deploy/local.easycharles.server.plist`（macOS launchd 用户级 agent 模板）
  - 新增 `scripts/deploy/启动EasyCharles.command` / `安装后台服务.command` / `卸载后台服务.command`
    （macOS 双击脚本；文件名故意不带空格，见 ADR-022 补充）
  - 新增 `scripts/deploy/easy-charles.env.example`（Linux 走 `EnvironmentFile=`；macOS 放解包目录）
  - 新增 `scripts/deploy/DEPLOY.md`（随包分发：步骤 / 参数表 / 安全须知 / 升级回滚 / 排错）
  - 新增 `docs/lan-workflow.md`（多人联调工作流：拓扑选择 / 落地清单 / 协作流 / 禁忌）
  - `run.sh` 增 `EC_ARGS` 透传通道（兼容层等 `EC_*` 覆盖不到的 flag）
  - `scripts/pre-commit-privacy.sh` 修静默漏检（ADR-023，遍历改用 NUL 分隔）
  - `README.md` 增「部署到内网服务器」小节 + 目录结构行 + 工作流指针；`docs/decisions.md` 增 ADR-022
    （含两处补充：macOS 形态、`EC_ARGS`）；`.gitignore` 增 `easy-charles.env`
- **决策要点**（详见 ADR-022）：白名单收集而非排除法；`node_modules/ws` 随包带上实现离线部署；
  打包含门禁（`tsc` + `selftest` + 源码引用的 `web/` 页面 + `ws` 版本一致）；**权限位归一化为
  644/755 并把 `.command` 的执行位挑回来**（仓库里 `web/about.html` 是 600，会致 `/about` 500）；
  模板放 `scripts/deploy/` 不新增顶层目录；macOS 用 launchd（`PATH` 窄，必须写 node 绝对路径）。
- **实测验收（2026-10-11，本机）**：
  - ✅ 打包门禁：`tsc --noEmit` 通过、`selftest` 100 通过 / 0 失败、产物 136 KB / 48 条目
  - ✅ 解包真跑：`GET /` 200、`GET /about` 200（权限位修复的关键验证）、数据面转发走通（假目标回 502）
  - ✅ `EC_PASSWORD` 生效：用该口令登录成功，用默认 `123456` 登录 **401**
  - ✅ `EC_DATA_DIR` 生效：数据落在指定绝对路径，包内**没有**被写入 `data/`
  - ✅ `EC_LAN=1` 生效：翻译成 `--lan`，监听 `*:8899`，横幅正确给出 WiFi 地址
  - ✅ 安全提醒路径：`--host 10.0.0.1` 且未设 `EC_PASSWORD` → 打出三条 ADR-015 警告后启动失败
  - ✅ 拆包容错：删掉 `server/web/about.html` → `✖ 发布包不完整` 直接拒绝启动
  - ✅ `.sha256` 校验文件：`shasum -a 256 -c` 通过
  - ✅ 隐私反向扫描：本机 `.data` 里的真实手机号在包内 **0 命中**；无本机绝对路径 / 用户名、
    无 `.data/` 条目、无 `easy-charles.conf`、无本机 conf 的 appId；产物权限全为 644/755
  - ✅ 包内只带源码真正读取的 3 个页面（`style-demo*.html` 已剔除，曾带出示例昵称）
  - ✅ macOS 形态（真机实测，隔离端口 + 独立数据目录，不碰开发中的 8899）：
    `launchctl` agent 真实装载 → `GET /` 与 `/about` 均 200、`EC_PASSWORD` 登录 200、默认口令 401；
    `plutil -lint` 通过，plist 里写入了 node 绝对路径与 `--lan`；
    **`kill -9` 后 ~10 秒被 KeepAlive 自动拉起**（ThrottleInterval 生效）；卸载后 agent/plist 消失、
    端口释放、数据目录保留；`启动EasyCharles.command` 前台跑通
  - ⚠ 测试中发现并修掉一个真 bug：`启动EasyCharles.command` 里 `source easy-charles.env`
    未自动导出（缺 `set -a`），导致端口/数据目录/口令全部回落到默认值 —— 已修 + 复测
  - ✅ `EC_ARGS` 透传（实测 5 例）：兼容层参数写进 `EC_ARGS` 后服务端横幅显示
    `兼容路由 /mock-proxy（目标头 …, appId …）`；优先级实测 **命令行 > EC_* > EC_ARGS** 三档都对；
    `EC_ARGS="--lan"` 仍触发 3 条 ADR-015 警告并拒绝启动
  - ⚠ `EC_ARGS` 第一版实现踩坑：把它并进了"是否显式传参"的扫描，导致它**压掉了 `EC_*`**
    （`EC_PORT=8914` + `EC_ARGS="--port 8915"` → 起在 8915）—— 已拆成 `cli` / `scan` 两个列表 + 复测
  - ✅ macOS 装 launchd 时 `EC_ARGS` 正确写入 plist（`plutil -lint` 通过），
    常驻服务横幅显示 `记录模式 sample` + 兼容路由，`GET /` 200
    - ✅ **局域网一条命令部署**（ADR-024；角色 ①开发+②构建分发在开发机、③服务器在目标机）：
      新增 `scripts/deploy-to-lan.sh`（开发机侧）+ `scripts/deploy/remote-deploy.sh`（服务器侧，经 stdin 投喂）。
      实测全链路：预检 → 门禁+打包 → scp → 远端 sha256 校验 → 新版本目录 + 配置继承 → 重装 launchd 服务
      → 健康检查 → 清理旧版本 → 打印回滚命令。连续三次部署（含**同一秒内连跑**）全绿；
      `--use` 回滚把 plist 切回旧目录且健康检查 200；`--init` 走伪终端交互生成配置（权限 600），
      **新口令登录 200 / 默认口令 123456 登录 401**
    - ✅ 失败路径全部实测：坏 sha / 缺口令（安全项，防安装脚本静默退回默认口令）/ 端口与 `--port` 不一致 /
      回滚目录不存在 / 远端连不上 / `--init` 无终端 → 均非 0 退出、**不动正在跑的服务**、不留孤儿版本目录；
      成功时不再因"没有可回滚目录"而误返回 1（首次部署就是这个情况）
    - ⚠ **发现并修掉一个已发布安装脚本里的真 bug**：`launchctl bootout` 是异步的 → 紧接着 `bootstrap`
      同一 label 失败，旧实现把错误吞掉后退回 `launchctl load -w`（还装进别的域），于是
      **"脚本报已装载、`launchctl print` 查不到、node 根本没跑"**。人工双击之间天然隔几秒所以从未暴露，
      脚本化部署（毫秒级连续）**必然**踩中 —— 实测表现为"成功一次 / 失败一次"交替。
      修法：bootout 后轮询等 job 真的消失（≤5 s）+ `bootstrap` 失败重试 10 次 + `launchctl print` 校验
      + 打 launchd 原始报错；健康检查等待 20 s → 60 s（覆盖 `ThrottleInterval=10` 退避）
    - ⚠ 开发机侧脚本用 `ssh`/`scp` 垫片做了全链路仿真（本机未开远程登录，**真 SSH 网络链路未验证**）；
      垫片自身先出过一个 bug（把目标文件名当目录建）—— 修好后 `--init` 才真正跑通
    - ✅ **真机两步全通（2026-10-11）**：`scripts/deploy-to-lan.sh user@<内网IP>` 首次部署成功
      （配置来自基础目录 `~/apps/easy-charles.env`）、升级部署成功（从上一版目录继承配置，
      四次部署配置哈希一致 = 口令没被重新生成）；发布包内 49 个条目、产物与源码逐字节一致；
      开发机走局域网验证 `GET /` 200 / `/about` 200 / 未登录管理面 401 / 默认口令 401；
      服务由 launchd 拉起（`state=running`，node 绝对路径写进 plist 的 `EC_NODE_BIN`，
      launchd 的窄 PATH 不影响启动）
    - ✅ **兼容协议在服务器上打通（2026-10-11，真机踩坑后修）**：真机部署时手写配置只写了
      `EC_PORT`/`EC_PASSWORD`，**丢掉 `EC_ARGS`** → 手机侧 `/mock-proxy/*` 整片 404
      `{"error":"not found"}`、控制台一条记录都没有（手机 mock 地址、开关、Wi-Fi、SDK 全对）。
      修法：把开发机 `easy-charles.conf` 的 `EC_ARGS` 搬进服务器配置并重新部署，
      实测 `/mock-proxy/xxx` 由 `not found` 变为 `EC_TARGET_MISSING`（路由已挂）、
      带 `X-Mock-Original-URL` 时正确转发（502 = 上游不可达，路由本身通）、
      设备按 `app-v-user`/`mock-display-name` 自动登记、`GET /devices` 能列出未绑定设备；
      另加"`EC_ARGS` 为空"主动警告 + 自查命令（ADR-024）
    - ✅ 顺带确认：`listRecords` 的 owner 是**查询时按当前绑定动态解析**的（`store.ts:84`），
      所以设备**绑定后，之前已经收到的记录也会出现**，不必重新触发
    - 📅 **待你在两台真机之间跑第一次**：`scripts/deploy-to-lan.sh <你的 Mac B>`（首次加 `--init`）
- **未做 / 已知限制（诚实登记）**：
  - 📅 **Docker 形态未做**（ADR-022 明确不做，目标机需自带 Node 22.6+）
  - 📅 **HTTPS 反代不支持**：`wsUrl` 恒 `ws://`（ADR-014）、快照链接恒 `http://`，
    TLS 终结在反代上会撞 mixed content。要支持须改代码（从 `X-Forwarded-Proto` 推导）+ 新 ADR
  - 📅 服务端**无优雅停机**（未处理 `SIGTERM`），停止即终止；`rules.json`/`store.json` 写时落盘不受影响
  - 📅 未做发布包签名 / 分发通道（只给 `.sha256` 供人工核对）
  - ✅ 隐私钩子静默漏检已修（ADR-023）：改用 `git diff --cached -z` + `read -r -d ''` 遍历。
    实测同内容 4 份假密钥（ASCII 名 / 中文名 / 含空格 / 含换行）**全部拦下**（此前只有 ASCII 名被拦）；
    无内容的中文名文件仍放行；`bash -x` 核对中文名确实进入检查（`[ -f ]` 追踪 30 次，其中 9 次为非 ASCII）

---

## P6 mock CLI（给 AI agent 用的命令行）—— 🔧 P0/P1/P2 ✅（含远端真机验收）· P3 服务端 + CLI 代码完成、门禁全绿（远端待验，控制台 UI ✅ 由 P7 阶段 C 补上）· P4 📅

> 需求：把「让 AI agent 直接操作 mock」的命令面做成真能跑的工具。命令分组（`project / group /
> api / device / request / f2e`）与「并行数组按下标一一对应」的约定，沿用团队既有的使用习惯；
> 实现落在 EasyCharles 自己的管理面上，协议与代码均为本项目自有。后端就是本仓库的 server，
> **也包括远程部署的实例**（baseUrl 可指向内网服务器），不限于本机。
> 只走管理面 REST，不碰数据面 / 控制面 / 快照面（AGENTS.md §3）。
> 决策理由与坑点见 **ADR-027**。

- **落点**：`server/tools/mock-cli/`（不新增顶层目录，AGENTS.md §2）；零运行时依赖（只用 node 内置）。
  新增 `server/tsconfig.cli.json` 把它纳入类型检查——原 `tsconfig.json` 的 `include` 只有 `src/**`，
  CLI 放进去等于**根本没被检查**。
- **概念对照**（逆向的关键；字段名沿用 skill 的叫法，便于 agent 直接复用那份文档）：

  | skill 概念 | EasyCharles 实体 | 状态 |
  |---|---|---|
  | project | 一个服务实例：baseUrl + 手机号会话（本地 profile） | ✅ P0 |
  | api | `Rule`（`match.method/host/path/params`） | ✅ P1（list/get/switch/delete）· ✅ 写 P2（create/update/copy） |
  | 第 i 组 / `jsonList[i]` / `responseGroupNames[i]` | `action.responses[i]` 的 `body` / `name` | ✅ P1 只读条数 · ✅ 写 P2 |
  | `responseGroupQueries[i]` / `Contents[i]` | `responses[i].cond.query` / `.content`（新增可选字段） | ✅ P2 存 · 🚩 P4 选路 |
  | group / 项目 | 服务端新增 `Group` + `Rule.groupId` | ✅ P3 服务端 + CLI（自测全绿，**远端待验**）· ✅ P7 阶段 B 服务端加 private/shared 归属与 copy/share/versions/rollback/archive · ✅ P7 阶段 C 控制台项目两栏与归属显示（**顺带补 P3 就欠的 UI**）· ✅ P7 阶段 D CLI 的 `copy/share/history/rollback/archive` 按 C14 归属重写（mock-cli selftest 514/0） |
  | device / request | `DeviceView` / `EcRecord` | ✅ P1 |
  | f2e | **改为通用 OpenAPI 文档源**（不依赖任何内部平台；命令名保留 `f2e`，避免打断已有脚本） | 📅 P4 |

- **P0 交付内容**：`login` / `logout` / `whoami` / `project` / `set` / `version` / `help`
  + 参数层 / 配置层 / HTTP 层三块地基。
  - 参数层：重复 flag **累积成有序数组**（并行数组的基础）、`@文件` 与 `-`(stdin) 取值、
    未知 flag 直接退出码 2（静默忽略等于让 agent 以为参数生效了）
  - 配置层：`~/.mock-cli/config.json`（`0600`，`EC_MOCK_HOME`/`--config` 可隔离）；
    坏 JSON → 改名备份 + 空配置继续；脏条目逐条丢弃；**不存口令，只存会话 token**
  - HTTP 层：`X-EC-Session`；401 → 用非交互口令源自动重登一次并重放原请求；
    请求体按**字节**预检管理面 1 MiB 上限（中文 body 用字符数会漏判）
  - 契约：`--json` 结果走 stdout、错误走 stderr 一行 `{"error","message","hint"}`；
    退出码 `0/2/3/4/5/64`；**非交互环境缺 `--yes` 立即退出码 2，绝不阻塞等输入**
    （正是 skill「脚本调用时命令卡在交互选择」那节的反面）
  - 未实现的命令**注册但明确报错**（64 + 计划阶段 + 替代做法），不假装成功（AGENTS.md §9）
- **P1 交付内容**：`api list/get/switch/delete` + `device list/current/bind/unbind`
  + `request list/get/clear`，全部只打**既有**管理面接口（服务端零改动）。
  - `api`：列表只回摘要字段（**不含 body**，否则一条大 JSON 返回值就烧掉 agent 上下文）；
    `get` 把服务端存的那份**原样**回读（未知字段也在，P2 的读改写全靠它）；
    `switch`/`delete` 走 ADR-019 的单条接口，不做整表 PUT
  - `device`：绑定守卫（不在可见列表 → 4；归属是别人 → 2/3 + `--force` + `--yes`），
    绑定后读回核对 `owner`；`current` 用 `/me` 的 `lastBoundDeviceId`，并对「账号里记着但这次看不见」
    如实标 `staleBinding`
  - `request`：列表是摘要、详情才带 body；`--limit` 严格校验（服务端对脏值是**静默退回 300**，
    CLI 不跟着骗人）；`clear` 先数命中条数再确认、清后按同条件读回，非空即 `EC_VERIFY_FAILED`
  - **读路径防御 `cli/guards.ts`**（AGENTS.md §4 补上的另一半：以前只管写入入口）：
    管理面下发的结构不合法 → `EC_BAD_RESPONSE`；条目脏 → 丢掉并**如实计数 `dropped`**，
    人类模式额外给一行「有 N 条被跳过」
  - 写操作一律「提交 → 独立读回 → 不一致就大声报错」，绝不信服务端一句 `ok:true`
- **P0 实测验收（2026-10-14，隔离端口 18931 + 独立数据目录，不碰开发中的 8899）**：
  `node tools/mock-cli/selftest.ts` → **82 通过 / 0 失败**；`tools/selftest.ts` 仍 133 全绿；
  `tsc -p tsconfig.cli.json` 与 `tsc --noEmit` 均无错。
  覆盖正常路径（登录 / 复用会话 / 自动重登 / stdin 口令 / 探活 / `--quiet` 单行）
  + 脏输入（配置坏 JSON、条目类型混淆、重复 id、`sessionAt` 脏值、幽灵 project 引用、非法 baseUrl）
  + 边界（口令错 401、未实现 64、未知命令与未知参数 2、非交互删除不挂起、连不上 5、
  超限 body、服务端重启后旧 token 失效）。
  - ⚠ 测试中发现并修掉两个真问题：**① `--config` 被完全忽略**——配置文件在解析子命令参数
    **之前**就按默认路径加载了，于是所有测试实际写进了真实 `~/.mock-cli`。修法：新增 `peekFlag`
    从原始 argv 先取 `--config`，并让自测**强制注入**隔离路径（用例作者忘记传参不该污染 home）。
    **② `help <主题>` 用「第一个非 `-` 开头的 token」挑主题**，把 `--config` 的值当成了命令名。
- **P1 实测验收（2026-10-14，同一套隔离端口 / 数据目录 / 独立 config）**：
  `node tools/mock-cli/selftest.ts` → **189 通过 / 0 失败**（P0 的 82 条仍在内）；
  `tools/selftest.ts` 仍 133 全绿；两个 tsconfig 均无错。
  端到端现场是**绕过 CLI 直接打管理面布置的**（用还没实现的 `api create` 测 `api list` 是假绿）：
  `PUT /rules` 播 5 条规则 → `hello` 注册 2 台设备 → 数据面真打 `/__ec/p` 命中顺序 mock 造记录。
  按 AGENTS.md §6，每组正常路径旁边都配了脏输入 / 边界：
  - `api`：数字 id 的条目、无 id 条目、旧形态单条 `response`、`--enabled yes`、`--method POST`
    对通配规则的命中语义、同时给 `--on --off`、非交互删除不挂起且没真删、重复删除报 4、
    `--group-id` 明确 64（不静默忽略过滤条件）
  - `device`：**三个空间**（普通 A / 普通 B / 管理员）交叉验证可见性与归属；
    他人设备不在 A 的列表（4）、`--force` 缺 `--yes`（2 且不挂起）、被拒的绑定没改动归属、
    管理员「看得见但不是自己的」→ bind 2 / unbind 3、`--device-id` 与位置参数冲突时报错
  - `request`：`--limit 0/-3/abc/99999/1.5` 全拒、截断 id → 4 且 hint 指向 `--json`、
    被拒的清空没有真的清掉、按筛选清空 0 条也算成功、清空后独立读回为 0
  - 输出纪律：stdout 被下游提前关闭 → 退出码 0 且不甩 EPIPE 栈（**验证过去掉守卫会红**，
    不是自证）；两行「码点数相同、终端列宽不同」的设备名，断言同一列视觉对齐
    且字符下标差 4（按码点补齐的老写法必然露馅）
  - ⚠ 这一轮发现并修掉两个真问题：**① 管道被下游提前关闭**（`… | head`）时进程甩
    `Unhandled 'error' event … write EPIPE` 的栈并非 0 退出；**② 中文列宽把表格排歪**
    （`padEnd` 数码点、终端按列）。都在 `output.ts` 收口。
  - ⚠ 顺带确认一个**服务端既有行为**（不是 CLI 缺陷）：`store.bindDevice()` 不校验设备当前归属，
    所以管理员可以把别人空间的设备直接绑走。P1 的防线做在 CLI 侧，服务端侧要不要补校验**另议**
    （见 ADR-027 坑点，动之前先问）。
- **P2 交付内容**：`api create/update/copy` + 服务端两个**单条写端点**（ADR-028）
  + `responses[].cond` 存储位 + 控制台保存无损。
  - 服务端：`POST /__ec/api/rules`（id 由服务端生成，调用方给了非空 id 直接 400）、
    `PUT /__ec/api/rules/:id`（路径 id 权威，body 里 id 缺失则补齐、不一致则 400、查无此条 404）。
    三个写入口（整表 PUT / 新建 / 整条替换）**共用同一个 `validateRuleShape`**——
    新开一门却不复用校验，等于给脏数据开了个没栅栏的后门（AGENTS.md §4）
  - CLI 一律走单条端点，**绝不整表 PUT**：agent 的一次读改写会把别人同时改的规则整片盖掉
  - `update` 是**读改写**：先原样回读整条（含 CLI 不认识的字段），只覆盖命令行显式给的键，
    再整条 PUT 回去；每条返回值同样以服务端那份打底，`cond` / 自定义响应头 / 未来字段跟着走
  - 四条并行数组（`--json-list` / `-names` / `-queries` / `-contents`）**按下标一一对应**，
    提交前查长度对齐、提交后逐条读回核对；收缩条数必须 `--yes`（真删除）
  - `--status` / `--content-type` 同样可重复传并与返回值按下标对齐（`--status 200 --status 401`），
    **只给一个值 = 广播给每条**（`--status 201`），不给就沿用服务端存着的那条自己的值。
    这条是文档示例逼出来的：状态码只能广播时，「成功 200 / 密码错误 401」这对最普通的返回值
    会被存成两条都 200，而服务端与控制台都不觉得哪里不对
  - 存储形态与控制台**逐字节对齐**（协议 §5.4）：1 条 + 指定 = `{mode:'static', response}`，
    多条 + 指定 = `{mode:'specific', responses, pinIndex}`，顺序 = `{mode:'sequence', seqMode, responses}`；
    换形态时**删掉另一形态的字段**（残留的旧 `responses` 会盖住刚写的 `response`，服务端优先读它）
  - 匹配面守卫：`--host`/`--path` 全空 = 命中**所有请求**，默认拒绝（`--allow-match-all --yes` 才放行）；
    `--param` 必须是 `k=v`；`enabled` 一律显式写（PUT 省略它 = 这条规则不生效）
  - 控制台配合改动（P3 的前置）：草稿里带上读进来那份**原样副本**，保存时只覆盖编辑器管的键，
    改一次 body 不再把 `groupId` / `cond` / 别人的响应头清空
- **P2 实测验收（2026-10-15，同一套隔离端口 18931 / 独立数据目录 / 独立 config）**：
  `node tools/mock-cli/selftest.ts` → **275 通过 / 0 失败**（P0 的 82、P1 的 189 仍在内）；
  `node tools/selftest.ts` → **155 通过 / 0 失败**（新增 F-29 单条写入口 22 条）；
  `node tools/console-mock-check.mjs` → **65 通过 / 0 失败**（新增无损往返 22 条）；两个 tsconfig 均无错。
  - 写入口的脏输入按 AGENTS.md §6 配平：非法 body / 类型混淆 / 缺字段 / 负与超大 priority /
    `responses` 不是数组 / 元素是标量 / 省略 `enabled`（**必须判为不生效而不是默认启用**）/
    调用方自带 id / 路径与 body 的 id 不一致 / 改不存在的 id
  - 下标对齐是重点：长度不齐（2）、`--mode static` 配 2 条（2）、`pinIndex` 越界（成功但给 note，
    因为服务端会夹到最后一条）、空 body 元素要 `--allow-empty-body`
  - **无损**是重点：现场给规则塞进 CLI 不认识的 `groupId` / `latencyHint` / 每条 `cond`，
    改完 body 后逐个断言它们还在；`copy` 的副本除 id 与 name 外与原件逐字段一致
  - 写进去的东西**真的被数据面命中**：`api create --status 201` 后打 `/__ec/p` 拿到 201 + 正文，
    `api switch --off` 后不再命中（不只看管理面说「存下来了」）
  - 半态写入：`--priority 9 --mode static --json-list A --json-list B` 这种「一半合法一半非法」的组合
    必须整条命令失败，服务端那份仍是失败前的样子
  - ⚠ 这一轮发现并修掉四个真问题：**① 四条数组的 flag 名被写成带 `--` 的 label**，
    于是 `flagList` 永远读不到 → `api create` 报「至少要给一条返回值」，而用户明明给了三个
    `--json-list`（正是 ADR-027 警告的那类静默失效）；**② `--json-list A B C` 空格连写时
    B / C 掉进 positional 被静默丢掉**，CLI 报成功、服务端只存 1 条 → 新增
    `rejectExtraPositionals`，多余位置参数当场退出码 2 并教正确的重复 flag 写法；
    **③ 控制台 `name` 只写空白字符时会留下 `name: '  '`**，列表显示成空行 → 改为 trim 后不写字段；
    **④ `--status` 当时只能广播**：照 README 写「成功 / 密码错误」两条返回值，落库变成两条都 200，
    服务端与控制台都不觉得哪里不对 → `--status` / `--content-type` 改成可重复、按返回值下标对齐，
    只给一个值仍是广播。这一条是**把文档示例真跑一遍**才暴露的，光看代码看不出来。
  - ⚠ 顺带修掉一个**只在读改写里成立**的隐患：`update` 原先先改对象再校验，
    非法 `--mode` 会让前面已经改过的字段落成半态 → 改成「先全部算完，再一次写入」。
- **P2 远程实例真机验收（2026-10-15，用 `deploy-to-lan.sh` 部署到局域网另一台 Mac 后打真机）**：
  - 部署链路：本机门禁全绿出包 → scp → 远端 sha256 校验 → 新版本目录 + 继承配置 →
    重装 launchd → 健康检查 `GET /` **200**；规则 / 绑定 / 快照原样保留（数据目录没动）
  - CLI 打的是**远程服务实例**（ADR-027 的核心约束，此前只在自测起的临时服务端上验过）：
    `project add` / `login --password-stdin` / `api list` / `api create`（两条返回值 +
    `--status 200 --status 401` 按下标对齐，读回 `readBack: 2`）/ `api update --status 201`
    （广播到两条，读回两条都是 201）/ `api switch --off`（读回 `enabled:false`）/
    `api delete --yes`（`remaining` 如实回传）/ `device list` / `request list`
  - 数据面也在远程验到了**命中与不命中**：`x-ec-mock: 1` 先 200 后 401（sequence 换条），
    `--off` 之后同一地址 `x-ec-mock: 0` 并拿到上游真实 404 —— 不是"管理面说存下来了"而已
  - 临时规则当场删除，删后清单回到部署前那 1 条真实规则；账号用占位手机号 `13800000000`
  - ⚠ **网络侧踩到**：开发机挂着代理 / VPN 时 `<服务器>:8899` 的 SYN 无应答（服务端同机 `curl`
    1.3 ms 正常、SSH 22 一直通），于是把 `NO_PROXY=<服务器地址>` 与 `ssh -L` 隧道两条兜底写进
    `EC_UNREACHABLE` 的 hint（并在自测里断言 hint 含 `NO_PROXY` / `ssh -L`），`DEPLOY.md` §3C
    与 `README.md` 同步。隧道那条实测可用：单独 `project add` + `login` 后 create/switch/delete 全过
  - ⚠ 顺带修掉部署侧三个**只有真跑一次才暴露**的问题（产物校验依赖终端 locale 的中文名转义、
    `EC_ARGS` 体检恒误报、继承配置里的默认口令没人提醒），详见 **ADR-024** 的 2026-10-15 补记
- **登录方式补充：`mock login --browser`（2026-10-15，决策见 **ADR-029**）**：
  - 做法：CLI 在本机 `127.0.0.1` 起**一次性**监听，把带 nonce 的控制台地址（nonce 走 `#hash`）
    开进浏览器；人在页面里登录并点一次「允许本地 CLI 使用你的会话」，页面把会话 POST 回那个端口；
    CLI 拿 `GET /__ec/api/me` **向服务端核实**后才落盘，身份以服务端为准
  - **服务端零改动**：管理面端点一个都没加（AGENTS.md §3）。被否掉的方案是「服务端加 nonce→session
    轮询端点」——那等于挂一个无需凭据就能换到等价登录态的口子，且 nonce 会进访问记录与 Referer
  - 口令通道保留：`--password` / `EC_MOCK_PASSWORD` / `--password-stdin` 仍是 agent 与 CI 的走法，
    `--browser` **只认显式给出**，绝不因「没给口令」自动开浏览器（无 GUI 无终端时命令会永远挂住）
  - 「拒绝」也是一条通知：页面点拒绝后回 `{state, denied:true}`（**只有这两个字段**），
    CLI 立刻 `EC_LOGIN_DENIED` 结束，不再让人干等到超时；`state` 不全等 / `denied` 不是布尔 `true`
    都不算拒绝，所以第三方冒名拒绝不了别人的登录
  - 门禁：`tools/mock-cli/selftest.ts` C-07 端到端 **335 通过 / 0 失败**（伪造 32 位 hex token →
    `EC_VERIFY_FAILED`；Origin 不一致 → 双地址报错且不落盘；超时 → 退码 3 并给口令兜底；
    12 条垃圾投递 → `EC_CONFLICT`；与口令来源混用等 8 组用法错误 → 退码 2 且不开监听；
    一次性：成功后同端口不再接受第二份会话；配置文件 0600 且**不含口令**）+
    `tools/console-mock-check.mjs` 页面侧纯逻辑 **98 通过 / 0 失败**（17 个「不该受理」的 hash 形状、
    允许载荷恰好 4 个字段、拒绝载荷恰好 2 个字段、`state` 里塞 URL 也改不了回传目标）
  - ✅ **真实浏览器端到端已跑通**（2026-10-15，本机临时服务端 18999 + 受控 Chrome，口令用默认 123456，
    账号用占位 `13800000000`）：`login --browser` 打印地址 → 页面登录 → 确认框四行（服务地址 /
    会话属于谁 / 角色 / 回传地址）如实显示 → 点「允许」→ CLI 退码 0、`via=browser`、
    身份来自服务端 `/me` → 紧接着 `api create` 真实写入并读回、`api delete` 清场；
    另一轮点「拒绝」→ CLI **立刻** `EC_LOGIN_DENIED`（不等超时）、监听端口当场关闭、不写会话；
    成功后地址栏 hash 被清掉，配置文件 0600 且不含口令
  - ⚠ 远端实例的页面已经带上这段接力（部署产物里 `cli-login` 出现 5 处），但**还没有使用者
    在自己的浏览器里点过一次「允许」**——远端口令不是默认值，这一步要由本人验
- **登录会话落盘（2026-10-16，决策见 **ADR-031**，修订 ADR-015 的「会话内存态、重启失效」）**：
  - 诉求原话是「服务重启后，浏览器能像重开同一浏览器一样自动登录」。做到即可，**没有**走
    ADR-015 当初指给的「签名 cookie/JWT」：单进程场景无状态换不到收益，却会失去 `logout` 的着力点，
    而签名密钥无论派生自口令还是随机落盘，安全水位都不比现在高
  - 做法：会话表进 `.data/store.json`（`sessionId → { phone, expiresAt }`）+ `--session-ttl`
    （小时，默认 720 = 30 天，`0` = 永不过期，单位与 `--snapshot-ttl` 一致）；
    `logout` 也落盘（否则重启会把已登出的会话又复活）；恢复时**逐条**校验形状、过期即剪、上限 500 条；
    `load()` 从「一个大 try/catch」改成三段各自独立恢复，脏 `sessions` 不再连累 users / bindings
  - **代价（如实记录）**：token 从「只在内存」变成「躺在磁盘」，能读 `.data/store.json` 就等价拿到登录态；
    且 `--password` 换口令后**重启也踢不掉**旧会话，要清 `sessions` 段——`DEPLOY.md` §6 已改写这条
  - 三面核对：数据面 / SDK / 控制台前端**零改动**（token 形状与发放方式没变）；
    `/__ec/api/info` 与 admin overview 多下发 `sessionTtlMs`（协议 §4.4 已补）
  - 验收：`tsc --noEmit` 干净；`tools/selftest.ts` **290 通过 / 0 失败**（新增 `[ADR-031]` 31 条：
    正常路径 + TTL 过期 + `0` 不过期 + 登出落盘 + 14 种脏条目 + 5 种坏文件 + 上限淘汰）；
    真机实测 `登录 → /me 200 → kill → 重启 → 同一 token 仍 200`、伪造 token 401、登出后重启 401；
    `tools/mock-cli/selftest.ts` **453 通过 / 0 失败**（C-04 原先拿「重启后必然 401」当失效来源，
    这次改成「服务端不认识的 token」驱动自动重登，并新增「同 dataDir 重启后旧会话仍有效」两条断言）；
    `tools/console-mock-check.mjs` 98 通过 / 0 失败
  - ⚠ 未验：真实浏览器里「重启服务 → 直接进控制台」这条体验只有 curl 层证据（同一 token 200），
    人打开页面点一遍更稳
- **P3 交付内容：`group`（规则的容器）+ `--group-id`（协议 §0 C13 / §4.7 / §5.5 / ADR-030）**：
  - 模型：`Group{id, name, enabled, createdAt, updatedAt}` 落**独立 `groups.json`**，
    `Rule.groupId` 可选。「模块」= 挂在同一分组下的一组规则，**不新增第三层实体**（ADR-030 决策 1）；
    真正的「一组 mock 列表」已经是 `action.responses[]`
  - 命中口径是一条 AND：`rule.enabled &&（无 groupId || 组存在且 enabled）`。
    **关组不改写**组内规则的 `enabled`、**不重置抓包序列指针**，重开即原样恢复；
    **删组不删规则**，组内自动脱组（先 `rules.ungroup(id)` 再删分组，回传 `ungrouped` 计数）
  - **悬空 `groupId` 按「未分组」处理**（照常命中）：判成「不命中」就是协议 §5 定义的最难查的
    静默失效——控制台显示「已启用」却什么都不 mock。存在性核对因此做在 **CLI 侧**（写之前读分组表，
    查无此组退码 4），服务端只管结构
  - `disable-all`（一键禁用全部规则）**刻意不做**：与每条规则自己的 `enabled` 造出第二份真相；
    整组停用走 `group switch --off`，命令仍注册但明确报 64 并给替代做法
  - 服务端管理面（AGENTS.md §3 只在管理面加）：`GET/POST /__ec/api/groups`（列表附
    `ruleCount`）、`GET/PUT/DELETE /__ec/api/groups/:id`、`POST /__ec/api/groups/:id/enabled`
    （回传 `affected`）；三个写入口与规则侧 `validateRuleShape` 同一套结构校验纪律
  - CLI 新增 `mock group list/get/create/update/switch/delete`，`api create/update/copy` 支持
    `--group-id`，`api list --group-id` 是**真过滤**（此前明确报 64，不静默忽略），`set group` 记本地默认
  - 输出上把「看不出来的那层」摊开：`api list` 的 `on` 列只讲规则自己的开关，所以
    挂了组的行会多一列实际状态，关着的组给 `(组关)` / `off-by-group` 脚注，
    悬空 id 给 `(未登记)` 并说明「按未分组照常命中」
- **P3 实测验收（2026-10-16，隔离端口 18931 + 独立数据目录 + 独立 config；本机临时服务端，**远端实例未验**）**：
  - `node tools/selftest.ts` → **259 通过 / 0 失败**（新增 **F-30** 分组 104 条）；
    `node tools/mock-cli/selftest.ts` → **451 通过 / 0 失败**（新增 **C-12** 分组端到端 113 条）；
    `node tools/console-mock-check.mjs` → 98 通过 / 0 失败；两个 tsconfig 均无错
  - F-30 按 AGENTS.md §4/§6 配平脏输入：`groups.json` 坏 JSON / 顶层非数组 / 条目类型混淆 → 空表不崩，
    `enabled` 脏值**归一为 true**（判 false 会让整组静默不 mock）、脏时间戳 → 0、读脏文件不顺手改写磁盘；
    `create` 18 种脏 body 全 400 且「一条都没落」，`replaceOne` 的 body.id 与路径不一致 → 400、
    `updatedAt` 一律服务端覆盖（伪造不了「什么时候改的」），`setEnabled` 只认布尔，
    `remove` 幂等且**不碰规则文件**；规则侧 `groupId` 非字符串（`7` / `{}` / `[]` / `true`）三个写入口全 400
  - 命中口径与指针是重点，且**打到数据面**而不是只看管理面：组开 → 200+正文，组关 → 放行上游（拒连 502），
    悬空 id → 仍 200，未分组规则不受别人关组影响；关组期间序列**不白占位**、重开后**从半截继续**
  - C-12 覆盖 CLI 契约三样（退出码 / stdout / stderr）：`--group-id` 三种语义（挂载 / `""` 清空 /
    ghost → 4 且**零写入**）、归属校验（规则不在 `--group-id` 指的组里 → 4 且规则没被改）、
    `group switch` 的 `affected` 与 `(组关)` 脚注、`group delete` 缺 `--yes` 不挂起且如实说明「规则不会被删」、
    删后核对「没有规则继续引用它」，以及**连上但没分组端点 ≠ 连不上**（`EC_UNREACHABLE` /
    `EC_UNAUTHORIZED` 绝不吞成「没有分组」）
  - ⚠ 这一轮发现并修掉一个**门禁自身**的真问题：`selftest.ts | head -N` 提前关管道 → 自测进程被
    EPIPE 打断在 `finally` 之前 → 它 spawn 的服务端**留在 18931 上**；下一次运行 `waitServer()`
    照样等到 200，其实探到的是上一轮那台带旧数据的服务器，于是 C-08 / C-09 的计数断言**全红**
    （实测 439/12 → 修后连续两轮 451/0）。修法是两处：`process.on('exit')` 里同步 `kill` 自己 spawn 的
    服务端（`exit` 只允许同步代码，`child.kill()` 正好是），以及起服务前先确认端口归属
    （`assertPortOwnership`：用进程表里 `--port 18931 --password <自测假口令>` 的签名认出「上一轮泄漏的」，
    默认**不动它**并拒绝跑，要清需显式 `EC_SELFTEST_KILL_STALE=1`；应答了但认不出来源的一律拒绝——
    在别人身上跑一堆写操作，结论不属于被测代码）。「跳过端到端」也不再报成绿灯：那轮用例根本没跑，`exitCode=1`
- **未做 / 已知限制（诚实登记）**：
  - 🚩 **读改写之间有时间窗**：`api update` 先 GET 再 PUT 同一条，服务端**没有版本号 / If-Match**，
    所以这一拍里另一方（控制台或另一个 agent）改过**同一条**规则就会互相覆盖。
    单条端点已经把爆炸半径从「整表」缩到「一条」，剩下这一条要靠服务端加乐观锁才能根治（未排期）
  - 📅 **P2 只做了「存得下、读得回」，没做按 `cond` 选路**：`responses[i].cond` 原样进出，
    服务端仍是按 `mode` 选第 i 条，真实的逐条条件命中属 P4
  - ✅ **控制台分组 UI 已补上**（2026-10-16 由 **P7 阶段 C** 顺带结掉这一步的欠账）：「我的项目 / 共享项目」两栏
    列出容器与开关、规则行显示归属项目，P2 的「保存不丢未知字段」正是它的前置。当时（P3 期）确实没做
  - 📅 **P3 没在远端实例上验过**：上面那批数字来自本机临时服务端。分组要真在意的是「CLI 打内网
    部署的那台」，下一步按 P2 的做法用 `deploy-to-lan.sh` 出一台再跑 `group` / `--group-id` 全链路
  - 🚩 **悬空 `groupId` 只有 CLI 挡得住**：存在性核对做在 CLI 侧（ADR-030 决策 3），服务端只管结构，
    所以**绕过 CLI 直接打管理面仍能写出悬空 id**。它在服务端按「未分组」照常命中（刻意，避免静默失效），
    `mock api get` / `mock group get` 会如实标 `groupDangling` 并给出清理命令
  - 🚩 **分组表同样没有版本号 / If-Match**：`group switch` / `api update --group-id` 也是读改写，
    上面第一条时间窗对分组一样成立
  - 🚩 **分组是「规则的容器」，不是租户**：所有客户端看到同一批分组，没有 `owner` / 角色校验
    （隔离维度仍是手机号空间 + 设备绑定，ADR-015/018）。`group --scope all|shared|personal` 因此不做
  - 🚩 **`api list` / `request list --mocked` 的筛选做在 CLI 侧**：管理面没有按条件查询规则的端点，
    `records` 也没有 `mocked` 参数。结果 JSON 里如实标 `filteredBy` / `mockedFilteredClientSide`，
    且 `--host`/`--path` 匹配的是规则里**声明的模式串原文**（含 glob / `re:`），
    不是「这条规则实际命中过哪些请求」——那是运行时语义，管理面没有这个数据
  - 🚩 **`request` 记录是内存态**：服务重启即丢，超出 `--max-records` 后最旧的被淘汰；
    未绑定设备只在设备列表中可见，其请求不进入普通空间 `request` 列表；绑定后才可浏览与清理（ADR-032）
  - 🚩 **`device bind` 的归属守卫只在 CLI 侧**：服务端 `bindDevice` 不校验当前归属，
    管理员绕过 CLI 直接打管理面仍能把别人空间的设备绑走（要不要在服务端补，另议）
  - 🚩 **每组命中条件的真实选路**：服务端 `match.params` 是**规则级**的，且 query + body 合并
    （同名 body 优先），没有「按 response 逐条条件命中」的能力 → P2 先把 `cond` 原样存下保证
    往返不失真，P4 才做真实选路
  - 🚩 `responseGroupContents` 的 **JS 表达式**求值：零依赖做不了安全 sandbox，与 P3 变量编排同源
  - 🚩 `device rename`：服务端没有「管理侧覆盖设备名」的字段（`deviceName` 由 SDK 上报）
  - 🚩 Swift / ArkTS 代码生成：独立工程，本期只出中间结构
  - ⚠ 交互式口令**会在终端回显**（不引依赖做掩码输入）；脚本 / agent 一律用 `--password-stdin`
    或 `EC_MOCK_PASSWORD`
  - ⚠ `--browser` 只在**浏览器与 CLI 同一台机器**时成立（会话经 `127.0.0.1` 回环交回，
    不跨机器、不代理）；远端服务页面的**版本要够新**，旧页面没有这段接力，症状是等满超时
    （超时 hint 里已写明）。SSH 远端 / CI 里就用口令通道

---

## P7 私有 / 共享 Mock 项目 —— 阶段 A 契约 ✅ · **阶段 B 服务端 ✅（2026-10-16，本机全绿）** · **阶段 C 控制台 ✅（2026-10-16，本机浏览器验收）** · **阶段 D CLI/文档 ✅（2026-10-16，本机全绿）** · 远端/多账号全量验收 📅

> 需求（用户拍板的四条行为）：① 多人共用一个实例时各自的 mock 互不干扰；② 共享项目是**只读模板**，
> 必须复制进私有区才参与 mock；③ 再次分享 = 整项目覆盖（last write wins，不做三方合并）；
> ④ 每次分享与回退都留不可变版本，任意历史都能回退。
> **决策与理由在 ADR-033**（部分推翻 ADR-018 边界 4、修订 ADR-030 的归属维度与「删组不删规则」）；
> 契约见协议 **§0 C14 / §3.3 第 10 条 / §4.7 / §5.4 / §5.5 / §6.1 / §7 第 8~11 条**，
> 数据流与落盘见架构 **§5.5 / §6.3 / §9**；逐文件的实施拆分与验收 checklist 在
> [private-shared-projects-plan.md](private-shared-projects-plan.md)。
> **状态口径**：阶段 A 只交付文档；**阶段 B 服务端**、**阶段 C 控制台**与**阶段 D CLI/文档**都已落地并本机验证（下表逐条打勾）。
> 阶段 B 的证据（2026-10-16 本机）：`npx tsc --noEmit` 与 `tsc -p tsconfig.cli.json` 均 exit 0、
> `node tools/selftest.ts` **515 通过 / 0 失败**。
> 阶段 C 的证据（2026-10-16 本机）：`node tools/console-mock-check.mjs` **153 通过 / 0 失败**（原 98 项 +
> 项目归属纯逻辑），控制台的建项目 / 保存 / 停用 / 分享 / 覆盖 / 复制 / 历史预览 / 回退 / 归档 / 删项目 /
> 抽屉预检 / 换手机号隔离，都在真实页面上用真实事件处理器与 `fetch` 跑过并核对过数据面实际响应
> （详见下节「阶段 C」最后两条与其中的 📅 项）。
> 阶段 D 的证据（2026-10-16 本机）：`node tools/mock-cli/selftest.ts` **514 通过 / 0 失败**
> （344/109 → 全绿：夹具补归属 + C12 按 C14 重写 + 新增 C13 专项 90 余条），README 升级提示与
> 启动日志的历史占用行也已落地（冒烟跑过启动横幅）；五道门禁全绿。
> 仍欠的验收：**远端实例 + 多账号实测**（本机两手机号是同进程临时 `--data-dir`，不等于部署机）、
> 控制台像素级视觉与拖拽手感。

### 阶段 A：契约与决策 ✅（2026-10-16）

- ✅ `docs/decisions.md`：**ADR-033** 新增；ADR-018 边界 4、ADR-019 边界 2、ADR-030 状态 / 决策 4 / 明确不做
  四处回写修订指针（保留决策演进痕迹，不删原文）
- ✅ `docs/protocol.md`：C14 变更记录与破坏性范围界定、§3.3 数据面候选集、§4.7 规则端点作用域收窄 +
  项目端点（copy / share / versions / rollback）+ 权限矩阵 + 迁移口径、§5.4 命中语义（含**悬空 `groupId`
  结论翻转**及其两个前置硬约束）、§5.5 `Group` 扩展字段 + `ProjectVersion` + journal、§6.1 五个新错误码、
  §7 第 8~11 条、§9 主版本号不抬到 3 的理由
- ✅ `docs/architecture.md`：§2 模块地图（补 groups.ts 一行）、§5.3 适用边界、§5.5 新增、§6.3 新增、
  §9 安全模型、§11 差距摘要、§12 目录结构
- ✅ `docs/roadmap.md`：本节
- [x] ✅ README 用法与升级提示已补（阶段 D，2026-10-16）：mock CLI 段落写明私有/共享两档、
  `g_legacy_shared` 迁移后先 copy 再归档；`api list` 只列我私有项目里的规则、退出码补 6/7
- 🚩 顺手登记一处文档偏差（本次已改正，无需再查）：ADR-019 与协议 §4.7 曾把「规则全局可写」引为
  「ADR-016 边界 5」，实际出处是 **ADR-018 边界 4**（ADR-016 只有三条边界）

### 阶段 B：服务端数据隔离 ✅（2026-10-16 本机完成，远端 / 多账号验收 📅）

- [x] ✅ `types.ts`：`ProjectScope` / `ProjectLineageEntry` / `ProjectVersion` / `ProjectVersionView` /
  `ProjectHistoryIndex` / `GroupClientInput` / `GROUP_SERVER_FIELDS`；`Group` 的 C14 字段**全部可选**
  （存量 `groups.json` 不带它们，读路径按协议 §5.5 兜底：`scope` 脏 → `shared`、`ownerPhone` 脏 → `null`），
  **服务端字段与客户端字段已在类型层分家**。`Rule.groupId` 的注释同步标注了 C14 的结论翻转
- [x] ✅ `groups.ts`：旧 group 迁为 shared；按 scope/owner 过滤（`visible(phone, scope?)` /
  `isPrivateOf` / `isShared` / `requireReadable` / `requireEditable`）；
  shared 只读保护（改内容 / 改 `enabled` 一律 `409`：管理面上只有 `setArchived` 能动它，
  内容变更只能经 share / rollback 由 `ProjectService` 提交）；
  历史索引指针 `currentVersionId` 与归档；`ensureLegacySharedContainer` 供迁移用；
  脏值读路径兜底一律朝「不进任何人的候选集」的方向收敛
- [x] ✅ `rules.ts`：`resolve()` 加归属 AND；`listForOwner` / `replacePrivateScope` / `create` /
  `replaceOne` / `remove` / `setEnabled` / `resetPointers` 按 owner 收口（另有 `listOfGroup` /
  `removeByGroup` / `countByGroup` 供项目侧用）；
  多私有项目仍按全局 `priority`（不引入项目级优先级）。`replaceAll` 降为**内部整表写入**
  （只给版本服务、journal 恢复与测试夹具），管理面不再经过它
- [x] ✅ `data-plane.ts`：把 `store.deviceOwner(deviceId)` 传进 resolver；未绑定与共享一律不命中，
  **数据面仍然不鉴权**（ADR-015 不变），未绑定设备照样原样转发上游
- [x] ✅ `index.ts`：管理面按会话手机号授权（`sessionPhone()` 是 owner 的唯一来源）；
  `PUT /rules` 作用域收窄为私有范围替换（回 `{ok,replaced,preserved,count}`）；
  copy / share / rollback / archive / 单项目详情 / 按项目读规则 / versions / versionDetail 全部落地；
  他人的私有项目与他人的规则一律 `404`（与「不存在」同形，不泄露归属）
- [x] ✅ **新增 `projects.ts`**（版本服务 + pending journal，落在 `server/src/` 内，未新增顶层目录）：
  `copyShared` / `sharePrivate` / `rollbackShared` / `versions` / `versionDetail` / `hasHistory` /
  `assertDeletable` / `recover` / `storageUsage`。不可变快照、`operationId` 幂等回执（最近 100 条）、
  原子提交五步序、`recover()` 启动前滚、`storageUsage()` 实际字节数、`migrateProjects()` 迁移
  —— **journal 的事务类型（`PendingOp` / `Receipt`）没放进 `types.ts`**：它只有版本服务一个使用者，
  形状（stage 怎么切、回滚点存什么）由这个模块自己定，提前铺到全局类型文件里就是替别人设计
- [x] ✅ **新增 `ec-error.ts`**（五个管理面码一处定义、三处抛出，`ecBody()` 统一折算 JSON，
  无 code 的老错误沿用既有 `error` 字符串——存量 CLI / 控制台按字符串分支不会被打断）
- [x] ✅ **新增 `json-file.ts`**：`.data/` 内所有 JSON 改走「同目录临时文件 + rename」，
  ENOSPC/EACCES 时清掉临时文件；一次失败的重写不再可能留下半截 JSON
- [x] ✅ 启动顺序 **recover → migrate → listen**（两步都必须在 listen 之前），横幅如实打印
  「迁了几条 / 收进哪个容器」与 journal 的 `abandoned` 列表
- [x] ✅ **最容易被漏掉的两件事**：私有项目删除**级联删自己的规则**（`{ok,removedRules}`，
  没有照搬 C13 的「清空 groupId 保留」，协议里那个 `ungrouped` 计数已删）；
  迁移后**不留任何无归属规则**（未分组 / 悬空 / private 但 owner 为空 三种都收进「旧版共享规则」容器，
  且只在真动过时才建容器，重复启动幂等）
- [x] ✅ `tools/selftest.ts` 补 C14 用例：权限与命中、复制无损、覆盖增删、`operationId` 重发、
  两人先后 share、回退逐字段一致、脏 journal / 脏索引 / 坏快照、超大 body 整笔不提交、
  每个新写入口的非法输入用例（515 项全绿）
- [x] ✅ 文档状态回写：协议 §0 C14 状态列 / §3.3 / §4.7 / §5.4 / §5.5 / §6.1 / §7，
  架构 §2 / §5.3 / §5.5 / §6.3 / §9 / §12，ADR-030 与 ADR-033 的状态与修订指针，本节
  - 顺手改掉两处**文档与代码不一致**（AGENTS.md §9）：架构 §6.3 原写「active 半提交 ⇒ 回滚到 journal 旧状态」，
    实现只做前滚、快照缺失时报 `abandoned`；协议 §6.1 原写「六个新码」，实际五个（`EC_UNAUTHORIZED` 是复用）
- [ ] 📅 **远端实例与多账号实测**（本机 selftest 用的是进程内 `createDataPlane` + 假设备头，
  不等于两台真机各自绑定手机号空间的真实表现）

### 阶段 C：控制台 ✅（2026-10-16 本机完成，视觉与拖拽手势 📅 待人工）

- [x] ✅ 「我的项目 / 共享项目」两栏（`renderProjectNav`）：私有栏带条数与**项目级开关**，
  共享栏整行只读并打 `只读` / `已归档` 标记；顶部「全部私有规则」是一个视图哨兵，不是真项目。
  首屏还有一条一次性升级提示（`c14HintHTML`，点「知道了」后落 `localStorage` 不再打扰）
- [x] ✅ **规则行显示归属项目**（协议 §5.4 结论翻转的第一个前提）：`· 项目：X`，
  项目停用时报 `⊘ 项目：X（项目已停用 → 不命中）`；归属查不到时如实写
  `项目 X（不可见或已删除）`，无 `groupId` 写 `未归属（不命中）`
- [x] ✅ 共享项目只读面板：元数据（发布人按服务端脱敏值显示，自己的号才显示明文）、
  当前内容表、历史版本、版本预览、「复制到我的项目」/「归档 / 取消归档」
- [x] ✅ 覆盖前二次确认展示**服务端口径的增删**（`shareDiff` 用 `lineage` ⇄ 原共享 id 算，不是按名字猜）：
  新增 / 删除 / 保留 + 条数前后对比；共享项目名会被一起覆盖时确认文案点名「名称：A → B」。
  发布与回退都带发布前自查提示（token / cookie / 个人数据 + 历史长期保留）
- [x] ✅ 成功后一律用服务端回传的 `version.id` / `createdAt` / `actor`（客户端不自造分享时间），
  重放时追加「（重放：之前那次超时已经成功过）」
- [x] ✅ 旧的整页全量保存改成**作用域安全写入**：编辑器走 `POST /rules` / `PUT /rules/:id` /
  `DELETE /rules/:id` / `POST /rules/:id/enabled`，项目动作走 `POST /groups/:id/*`；
  4xx 时保留草稿、如实 toast 错误码并从服务端重拉列表（不显示成功）。
  原始 JSON 抽屉仍是整份 `PUT /rules`（语义与它显示的数据一致），但加了本地写前预检
  `validatePrivateScope`（缺 / 脏 / 指向共享或他人的 `groupId`、id 重复、条目不是对象都点名到 `rules[i]`
  且**零写入**），条数变少必须再确认一次
- [x] ✅ 一次用户动作一个 `operationId`，失败重发复用同一个（`reuseOperationId`），成功后清掉；
  项目级写操作有 `busy` 闸门防连点
- [x] ✅ 管理面板补 C14 盘账：私有 / 共享项目数、**无归属私有项目**（>0 就是异常，标出来）、
  历史快照实际字节数（`storage.bytes` 实测，不估算）与「全部保留、不自动清理」口径
- [x] ✅ 本机浏览器验收（`127.0.0.1:18899` + 临时 `--data-dir`，两台设备经 WS 注册）：
  新建项目 → 记录的「Mock 此接口」→ 保存（服务端分配 id、`groupId` 落对、另一项目未被波及）→
  数据面实测命中（`HTTP 245 {"mocked":1}`）；项目停用后同一条规则改为透传，两个闸各自生效；
  分享 → 复制 → 改副本 → 覆盖 → 回退（当前内容逐字段还原 + 追加 `rollback`，历史 3→4 条不删）→
  归档 / 取消归档；抽屉四类脏 JSON 全部本地拦下且 `fetch` 计数为 0；
  删除项目按条数确认并连带删除（共享与历史不受影响）；
  **换手机号（139****0000）登录后**只看到共享项目、看不到他人私有规则，复制出的副本
  只对自己绑定的设备命中（另一台设备照样走自己空间的规则）
- [ ] 📅 **像素级视觉与拖拽手势**：本轮用页面真实事件处理器 + `fetch` 层驱动验收，
  界面截图与拖动排序手感需在可见浏览器里再走一遍（`console-mock-check.mjs` 只锁纯逻辑）
- [ ] 📅 纯逻辑门禁：`node tools/console-mock-check.mjs` **153 / 0**（新增项目归属 / operationId /
  `shareDiff` / `validatePrivateScope` 约 55 条，含类型混淆、缺字段、空数组、400 条批量报错）

### 阶段 D：mock CLI 与文档 ✅（2026-10-16 本机完成）

- [x] ✅ `group` 命令区分 private/shared（**CLI 的 `project` 仍是服务地址别名，不得挪作业务项目**）；
  `api` 各写命令默认归属唯一私有项目 / 本地默认项目（推不出唯一答案就报错，绝不猜）、
  明确拒绝写共享（`copy` 只收 shared；`update` 不能挪出/挪进项目，退出码 6）
- [x] ✅ 新增 `group copy / share / history / rollback / archive`；share 与 rollback **写后读回**
  versionId / actor / createdAt，`--expected-version` 乐观锁落空 → 退出码 7，同一 `--operation-id`
  重发幂等回执
- [x] ✅ README + CLI help（`mock.ts` 帮助树与约定段）：共享不直接 mock、必须 copy；
  再 share 是整项目覆盖；rollback 产生新版本且不清历史；`--group-id ""` 恒为 0 条并如实说明
- [x] ✅ **升级提示**：README（mock CLI 段落末尾：迁进 `g_legacy_shared` 先 copy 再归档）+
  启动日志（`migrateProjects` 迁移计数那行阶段 B 已有）+ 控制台首屏（阶段 C 已做）——三处都到位
- [x] ✅ 启动日志补**历史占用行**（协议 §5.5/§7 第 10 条：管理面之外的第二份账，
  实际字节数 + 文件数 + 项目数，冒烟验证过启动横幅）

### 验收门槛（不接受只测 happy path，AGENTS.md §6）

- [x] ✅ 权限与命中（服务端，`tools/selftest.ts`）：他人私有项目按 404、伪造 `ownerPhone` 被拒、
  共享项目 enabled 也不命中、未绑定设备不命中、多私有项目按 priority 遮蔽语义不变、共享序列指针永不推进
- [x] ✅ 复制 / 覆盖 / 历史（服务端）：字段逐项无损、两次复制互不干扰、覆盖准确反映增删改、
  同一 `operationId` 重发只生成一个版本、两人先后 share 各自留痕、回退逐字段一致且追加新记录
- [x] ✅ 崩溃与脏数据：非法类型 / 缺字段 / 超大 body（65 MiB 撞 64 MiB 上限）/ 落盘失败 /
  脏 journal / 坏快照 / 脏历史索引都不留半提交，重启后 `recover()` 结果确定（前滚或 `abandoned`），
  旧的坏 JSON 与脏 scope/owner/version 字段不让启动崩溃
- [x] ✅ 每个新 HTTP 写入口都在 `server/tools/selftest.ts` 补了**非法输入用例**（AGENTS.md §4 硬要求）
- [x] ✅ 本机门禁：`npx tsc --noEmit`、`tsc -p tsconfig.cli.json`、`node tools/selftest.ts` 515/0、
  `node tools/console-mock-check.mjs` 153/0、`node tools/mock-cli/selftest.ts` 514/0（阶段 D 转绿）
- [x] ✅ 控制台侧验收（本机真实页面 + 真实 `fetch`，2026-10-16）：两栏可见范围（换手机号后只看得到
  自己的私有项目与全部共享项目）、保存作用域正确（`groupId` 由服务端落、另一项目零改动）、
  4xx 留草稿不报成功、抽屉脏 JSON 本地拦下且零写入、覆盖与回退的二次确认显示服务端回传的版本与时间、
  数据面用真实 curl 核对命中/透传。**仍欠**：像素级视觉、拖拽排序手感、远端实例
- [x] ✅ **远端实例 + 两个手机号**的多账号实测（2026-10-16，部署机 mac-mini.local 上的真实
  `--data-dir` + 真实登录会话）：28/28 全绿 —— 双账号登录、私有项目归属（B 对 A 的项目/规则统一 404、
  伪造归属 400 `EC_SCOPE_MISMATCH`）、数据面命中归属（A 机命中 A 的私有规则、B 机同路径透传）、
  share → copy → 关源项目副本照样命中（copy ≠ 引用）、整项目覆盖与历史追加、rollback + 同
  `operationId` 重发幂等回执、清理路径（私有删级联、有历史的共享只能归档）。
  > ⚠️ 这段记录的是 2026-10-16 当时的口径。**共享项目的删除已由 ADR-037（2026-10-18）改成软删除**：
  > 不再有「有历史就只能归档」，`DELETE` 只打 15 天待删除标记、`POST /:id/restore` 可恢复、
  > 到期由启动/定时清扫真删。下面那句「按设计不可物理删除」同理，仅指当时的行为。
  ⚠️ **设备是模拟的**（`/__ec/hello` + 管理面 bind 造的设备头，不是真机 SDK），「真机 + 真实
  EasyCharles SDK 走完整链路」仍是 📅；脚本运行在部署机本机（本机 LAN 代理劫持直连，非服务端问题）。
  验收残留：部署机上留下两个已归档的「远端验收A」共享项目（有历史按设计不可物理删除）、
  三台已解绑的测试设备（acc-dev-a / acc-dev-b / dbg-dev）与两个假手机号空间（规则已清零）。

### 待产品确认（不擅自拍板，ADR-033 决策 5）

- 🚩 **任何登录用户都能覆盖和回退共享项目**（copy → share → 覆盖是同一链路，前端隐藏挡不住）。
  已按用户确认的「自由覆盖 / 自由回退」口径写进契约；若不接受，需要加共享项目维护者 ACL，
  但那会同时改掉「本地副本直接覆盖」与「自由回退」两条已确认规则——**先问再改代码**。
- 🚩 历史版本无限保留：会长期占 `.data/` 空间，并保留后来删掉的 response body（可能是 token / cookie）。
  首版不清理，只报实际字节数 + 发布前提示自查。要限额需另立 ADR。
- 🚩 **单份版本快照 64 MiB 上限**（`projects.ts` 的 `SNAPSHOT_MAX_BYTES`）：**这个数是阶段 B 实现自己拍的，
  契约里没定**。拍的依据是「管理面单请求 body 上限 1 MiB，而一次 share 提交的是整项目」，
  即它挡的是「项目规模」而不是「单次请求规模」。超限表现：`507 EC_STORAGE_UNAVAILABLE`、
  整笔不提交、文案带真实字节数与上限。**不改成静默截断、也不改成按条数估算**（AGENTS.md §6）。
  要调数或改成可配置（`--snapshot-max-bytes`）都请先确认，不要顺手改。
- 🚩 **复制出来的私有项目名固定加 `(副本)`**（`projects.ts` 的 `copyShared`）：共享库里两个同名「登录」、
  我的项目里又出现第三个「登录」时，靠名字无法区分来源。**这也是实现拍的**，
  契约只规定了「允许同名、一切定位按 id」（协议 §5.5）。要改成选择器里带来源项目名或别的后缀，
  先确认再改——它已经是用户看得见的数据了，改了不会报错，只会让历史副本名不统一。

---

## P8 接口资产版本化（V1.0 / V1.1 / V1.2）—— 📅 未实现（2026-10-19 立）

> 需求：把「某次功能迭代时的接口列表 + 每条接口的返回值」整体存成一版（V1.0、V1.1、V1.2…），
> 功能重构时直接拿存档对照或回退，造过的数据不必再造一遍。

**已有（P7 阶段 B）**：共享项目的 `publish / share / rollback` 会追加不可变版本快照，
内容 = 项目定义 + 全部规则与返回值，可预览、可回退（回退是**追加**，旧版本一条不删）。
落盘 `.data/projects/<projectId>/<versionId>.json`，索引 `index.json`，实现见 `server/src/projects.ts`。
另外「Mock 此接口」（ADR-035）能把真实响应一键存成规则，等于把线上数据沉淀进项目。

**缺口（本批要做）**：

- [ ] **人类可读的版本号**：`V1.0 / V1.1 / V1.2`（或自定义标签）。现在只有服务端 id（`v_xxx`），
      用户没法「对着版本说话」，也没法在群里说「按 V1.2 那版回」
- [ ] **私有项目也能存档**：版本服务目前只服务共享项目（`ProjectVersion.projectId` 限定 shared），
      而「重构前存一份」是个人动作，不该被迫先分享给全实例
- [ ] **版本间对比**：两个版本的接口列表 diff（新增 / 删除 / 返回值变化）——「对照存档」真正省事的地方
- [ ] **版本导出**：把某一版导出成可直接导入的 JSON（或 mock CLI 可消费的格式），
      让 agent 能读某一版存档去补另一版的数据

**明确不做**：自动按 App 版本号打标（EasyCharles 不知道业务版本，猜出来的版本号比没有更糟，
版本号必须由人显式给）；版本自动过期（P7 已定「任意历史都能回退」，自动清理会废掉这个承诺）。

**验收**：同一项目连存三版并分别命名；改坏后按版本号回退且逐字段一致；版本 diff 能列出
「接口增删 + 返回值变化」；私有项目存档不经过 share；`tsc --noEmit` + `selftest` 全绿。

**依赖**：P7 版本服务（✅ 已可用）。

---

## 交互微调（2026-10-18）—— ✅ 本机完成，远端部署 📅

- **「Mock 此接口」点一下就落库**（ADR-035）：不再生成待确认草稿，直接 `POST /__ec/api/rules`
  （`enabled: true`、返回值 = 当前真实响应、归属当前可写私有项目；没有项目就自动建「默认项目」）。
  已有同接口规则只载入不写盘；落库失败才留草稿并退回手动「保存并生效」。
- 两个边界有桩测试覆盖（17 项断言全绿）：**连点两次只建一条**（`mockFromRecordBusy` 在首个
  `await` 前占位）、**400 失败时草稿不被清掉**、**无私有项目时自动建项目后仍完成落库**。
- 影响：`server/web/index.html`（`mockFromRecord` 改 async + 详情页/草稿列表文案）、`README.md`、
  `docs/decisions.md`（ADR-035）。**服务端零改动**（复用 ADR-028 的单条写端点）。
- 门禁：`tsc --noEmit` 通过 · `selftest` 515 通过 / 0 失败 · 无头 Chrome 渲染正常。
- 远端实例尚未部署这一版（`bash scripts/deploy.sh`）。

---

## 依赖关系

```
P0.0 文档 ✅ → P0.1 服务端稳定化 ✅（F-01~F-10）
            → P0.2 SDK 行为（F-11~F-14，代码完成，待真机验收）
            → P0.3 代码审查修复 ✅（F-15~F-21）
            → 鉴权模型迁移 ✅（ADR-015：控制台多用户空间 + 数据面免鉴权 + 兼容层参数化）
            → 下一步：P1
P1 存储/控制台（依赖 P0.1 稳定；分页依赖 SQLite；含可选数据面鉴权遗留项）
P2 加解密（依赖 P1 存储与规则引擎稳定）
P3 变量编排（依赖 P2 的规则扩展位机制验证）
P4 导入导出（依赖 P1 存储）
P5 iOS（依赖协议 v2 全量稳定，可在 P2/P3 并行）
P6 mock CLI（P0 外壳零依赖，可独立推进；P1 ✅ 只走现有管理面；P2 ✅ 单条写端点已落地；
        P3 ✅ 服务端 group 模型 + CLI 已落地（自测全绿，远端待验；控制台分组 UI ✅ 由 P7 阶段 C 补上）；P4 📅）
P7 私有/共享项目（**批内严格按序，不可颠倒**）：
        阶段 A 契约 ✅ → 阶段 B 服务端归属与数据面过滤 ✅ → B 管理 API 与安全批量写 ✅ → B 版本/journal 恢复 ✅
        → 阶段 C 控制台 ✅（2026-10-16 本机验收）→ 阶段 D CLI/文档+升级提示 ✅（2026-10-16 本机全绿）→ 全量异常验收 📅
        依赖：ADR-033 已修订 ADR-018/030（归属维度落在容器上，不改 `Rule` 形状，SDK 零改动）；
        阶段 D 的 CLI 命令依赖阶段 B 的 copy/share/rollback 端点（✅ 已可用，CLI 门禁已随阶段 D 转绿）；
        ✅ 阶段 B 造成的控制台整页保存缺口已由阶段 C 补齐（不是增强，是补齐）
P8 接口资产版本化 📅（V1.0/V1.1 命名 + 私有项目存档 + 版本 diff；依赖 P7 版本服务 ✅，
        可与 P2 并行——两者不改同一批文件）
```

**每批次验收门槛**：`tsc --noEmit` 通过 + `tools/mock-upstream.ts` 自测链路跑通 +
对应批次的验收清单逐项打勾。批内任务可并行，批间严格按序。
