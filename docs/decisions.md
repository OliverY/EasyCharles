# EasyCharles 决策记录（ADR）

> 每条决策记录：背景 → 选项 → 决策 → 理由与坑点 → 影响。
> 状态说明：`✅ 已定`（P0 已按此实现，本次仅书面化）、`🆕 新定`（本次文档阶段新增/修订，尚未实现）、
> `⛔ 已被取代`（保留决策演进痕迹，实现以取代它的 ADR 为准）。
> 修订规则：任何推翻本文件决策的改动，必须先在这里追加一条新记录，不允许悄悄改代码。

---

## ADR-001 应用层显式引流，不做 TLS 透明劫持

- 状态：✅ 已定（项目立身之本）
- 背景：装根证书（信任链、证书绑定 pinning、合规）是 Charles 类工具的最大痛点。
- 选项：
  1. TLS 中间人（CONNECT 隧道 + 自签证书 + 绕过 pinning）
  2. 应用层显式引流（SDK 改写 URL 发往本地服务，本地服务再转发）
- 决策：**方案 2**。App 内拦截器把请求改写为 `本地服务/__ec/p<原 path>`，原始完整 URL 放 `X-EC-Target` 头。
- 理由与坑点：
  - 证书问题、pinning 问题、TLS 层抓不到解密后明文的固有限制全部消失；
  - 代价是**只能抓接入了 SDK 的 HTTP 流量**；非 HTTP 私有协议（IM 长连接信令）、未接 SDK 的三方组件流量覆盖不到——这是明示的能力边界，不是缺陷；
  - 走的是普通 HTTP 明文（仅 debug），不是隧道，因此 hop-by-hop 头、`Host`、`Accept-Encoding` 的剥离/改写成为服务端正确性的核心（见 ADR-008 与 architecture）。
- 影响：服务端转发正确性 = 头处理正确性；SDK 接入顺序决定抓到的明文（见 ADR-005 相关与协议 §8.1）。

## ADR-002 技术栈 Node + TS 零构建，而非 Go

- 状态：✅ 已定
- 背景：MVP 阶段要快迭代；解密脚本（V8 + crypto）与规则编辑器体验是短板项；未来可能推广分发。
- 选项：Go 单二进制（分发简单、性能好）；Node + TS（迭代快）。
- 决策：**Node 22+ 原生类型剥离直接跑 `node src/index.ts`，零构建，唯一运行时依赖 `ws`**。架构上把「转发核心」与「规则/脚本引擎」解耦，将来若需推广可单独用 Go 重写转发核心。
- 理由与坑点：
  - import 必须写全 `.ts` 后缀；`tsc --noEmit` 严格模式作为 CI 门禁；
  - **Node 的同步 CPU 密集操作会阻塞事件循环**：解密脚本必须放 `worker_threads`/子进程（ADR-011）；`node:sqlite` 的同步写也要评估量级（ADR-010）；
  - 环境要求：Node ≥ 22.6（类型剥离），README 明示。
- 影响：`server/package.json` 保持极简依赖；后续加依赖需先过 ADR。

## ADR-003 控制面与数据面分离

- 状态：✅ 已定（协议 §2 的关键约束）
- 背景：控制面（WS 注册/心跳/推送/指令）与数据面（无状态 HTTP 转发）的生命周期和可用性要求完全不同。
- 决策：
  - 数据面：无状态 HTTP，不依赖控制面是否建立；控制面断了数据面照常转发记录；
  - 控制面：SDK 启动先 HTTP 握手（`/__ec/hello`）拿配置与 `wsUrl`，再建 WS；心跳维持，断线重连；
  - 管理面：控制台 API 与静态页，同源 HTTP。
- 理由与坑点：
  - 抓包工具的可用性优先级：转发 > 记录 > 控制台推送。控制面故障不得拖累数据面；
  - 三个面的鉴权口径不同（见 ADR-015），分离后可以独立收紧；
  - 坑：控制台的 WS 是"服务端踢人"的重灾区——心跳判定必须同时覆盖 SDK 与控制台（见 ADR-013、roadmap P0.1-07）。
- 影响：`server/src` 三个文件对应三个面，路由在 `index.ts` 统一分派。

## ADR-004 顺序 mock 指针按 (deviceId, ruleId) 隔离

- 状态：✅ 已定
- 背景：多台设备同时调试同一规则时，序列指针互相踩。
- 决策：指针 key = `${deviceId}:${ruleId}`，服务端维护，控制台可一键重置；`seqMode` 支持 `in-order` / `loop` / `once-then-passthrough` / `random`。
- 理由与坑点：
  - 隔离粒度默认 (deviceId, ruleId)；如需按 userId 隔离（同一台设备两个账号），预留扩展位，P1 后按需做；
  - `once-then-passthrough` 走完后返回 `null` 放行上游，数据面据此直连——这条路径已经验证可用；
  - 坑：`host` 匹配的是带端口的 `u.host`（如 `api.foo.com:443`），规则里写 `host: "api.foo.com"` 匹配不上——协议与规则文档要写明这个细节，避免使用者踩（roadmap P0.1-10 顺手修）。
- 影响：`rules.ts` 的 `pointers` Map；规则 schema（协议 §5.4）。

## ADR-005 fail-open 语义与「绝不重试上游失败」红线

- 状态：🆕 新定（在 P0 实现基础上修订）
- 背景：P0 实现的 fail-open 判定把 `SocketTimeoutException` 也算作「代理不可达」，导致慢接口（超时）被重放一次——上游其实已经收到请求并可能已落库，等于重复提交，正好违反协议 §6.2 自己写的红线。另外连续 3 次超时还会误触熔断，让整个进程停止引流。
- 选项：
  1. 维持现状（超时可 fail-open）
  2. 收紧判定：只有「连接建立失败」类错误才算代理不可达；超时一律视为「请求可能已到达上游」，直接抛给业务层，与直连真实服务器的行为一致
- 决策：**方案 2**。
  - fail-open 触发集合 = 连接类错误（`ECONNREFUSED` / `ENOTFOUND` / `EAI_AGAIN` / `NoRouteToHostException` / `UnknownHostException` / `ConnectException`）+ 服务端明确拒绝码（`EC_TARGET_MISSING` / `EC_BAD_TARGET` / `EC_UNAUTHORIZED` / `EC_PROTOCOL_MISMATCH`）；
  - **排除所有超时（读/写/连接超时）**：超时意味着请求可能已到代理并已转发，重放有重复提交风险；
  - 熔断计数只统计连接类失败，不统计超时与业务错误；
  - 上游返回 502/504/503 是真实业务失败，绝不重试（P0 已正确，保留）。
- 理由与坑点：
  - 抓包代理引入的额外延迟**不应改变业务侧的超时行为**：本地代理只是转发路径，业务该超时还是超时；
  - 代价：本地服务挂了但恰好 TCP 能连上（比如服务端进程活着但卡死）时不会 fail-open——可接受的边界，后续可加「代理存活探测」兜底（roadmap P3）；
  - 与 ADR-013（SDK 超时策略）配套。
- 影响：`EasyCharlesInterceptor.isProxyUnreachable()`、`EasyCharles.notifyFailure()`；协议 §6.2。

## ADR-006 deviceId 自建 UUID；userName 默认不上报

- 状态：✅ 已定
- 背景：`ANDROID_ID` 会随签名/重装变化，IMEI 无权限且有合规风险。
- 决策：deviceId 用首次初始化生成的 UUID 存 `SharedPreferences`（Android）持久化；`userName` 属个人信息，`reportUserName=false` 时不上报，控制台只显示 userId。
- 理由与坑点：多进程场景由 `processName` 参与区分；多 App 由 `appId` 区分。iOS 用 `UserDefaults`/Keychain（P5 时落实）。
- 影响：协议 §5.3；`DeviceIdentity`。

## ADR-007 局域网 token 鉴权模型

- 状态：⛔ **已被 ADR-015（见文末）取代**（token 三面鉴权已废弃）
- ⚠️ 以下为当时的方案，**勿据以实现**；保留用于了解决策演进（为什么放弃了「一把钥匙」模型）。

- 背景：`--lan`/`--host 0.0.0.0` 时服务端等价于开放中转代理 + 全量抓包数据，必须鉴权。
- 决策：
  1. **数据面**：LAN 模式（`--lan` 或监听非回环）下，所有请求必须带 `X-EC-Token`，校验失败 → `401 EC_UNAUTHORIZED`（SDK 据此 fail-open 直连）；
  2. **控制面**：WS 首条 `hello`/`subscribe` 消息的 `payload.token` 必填校验，失败即断开；token 不进 URL（避免落日志）；
  3. **管理面**：`/__ec/api/*` 与 `/__ec/ws` 要求 token；控制台静态页 `/` 免鉴权返回空壳，页面 JS 收到 401 后引导输入 token（存 localStorage），后续请求带 `X-EC-Token`；
  4. **token 下发**：启动时 banner 打印 + 控制台首页展示；**`/__ec/hello` 响应不再返回 token**（P0 实现会返回，必须删）；二维码 `easy-charles://connect?host&port&token` 为 P1 增强；
  5. **非 LAN 模式**（仅回环）：管理面/控制面免鉴权（本机可信），数据面仍接受无 token 请求——`adb reverse` 场景零配置。
- 理由与坑点：
  - 回环免鉴权是设计，不是漏洞：本机攻击面 = 本机权限，没有增量收益；
  - **`--lan` 当前只置标志位、不绑定 0.0.0.0**（config.ts 只改 `lanMode`），导致局域网根本连不上——这是 P0 必修项，鉴权模型按「真正能连上局域网」来设计（roadmap P0.1-02）；
  - token 属于「能力钥匙」不是「用户身份」：泄露后拿到的是代理能力，不是账号，文档明确告知使用者风险边界；
  - SDK 侧 Config 增加 `token` 字段，LAN 接入时由使用者从启动输出/二维码填入。
- 影响：协议 §3.2/§4.1/§4.2/§6.1/§7；`server/src/config.ts`、`index.ts`、`control-plane.ts`、`data-plane.ts`；SDK `Config`/`ControlPlane`/`EasyCharlesInterceptor`；控制台 `web/index.html`。

## ADR-008 响应缓冲边界：bounded buffering（边转发边缓冲）

- 状态：🆕 新定（P0 只缓冲「content-length 已知且 ≤ 阈值」的响应，chunked 小响应永远只留 8KB 采样，`bodySize` 记 0，控制台看不到完整响应）
- 背景：记录完整性的核心矛盾——不知道 chunked 响应总长，就不能提前决定缓冲还是流式。
- 决策：
  - 请求侧（不变）：`content-length` 已知且 ≤ `maxBufferBytes`（默认 512KB）→ 缓冲；否则 pass-through；
  - 响应侧（修订）：无论有没有 `content-length`，一律**边转发边缓冲**：
    - 累积量 ≤ `maxBufferBytes` 且内容可解析（json/text/xml/form）→ 完整记录；
    - 累积量超阈值 → 丢弃缓冲、只保留前 `sampleBytes` 采样，标记 `streamed=true`、`bodyTruncated=true`；
    - 内容类型不可解析（二进制）或 SSE（`text/event-stream`）→ 不累积，只采样，标记 `streamed=true`；
    - **`bodySize` 一律记录实际传输字节数**（边转发边计数），不再依赖 `content-length`（P0 在 chunked 时记 0 是错的）；
  - 内存上界：`maxBufferBytes + sampleBytes`，与响应大小无关。
- 理由与坑点：
  - 边到边转发延迟不受影响（不等待整包），只是同时把块 append 进一个有限缓冲；
  - SSE 永远 pass-through：它天生流式，且 `text/event-stream` 记录全量没有意义（控制台展示用采样即可）；
  - 大响应（>512KB）仍然是采样，控制台详情里要明确标注「已采样，非完整」；
  - 该语义同时受 ADR-012（record-mode）约束：`meta` 模式下缓冲照做（保证转发），只是不落 body。
- 影响：协议 §3.5 重写；`data-plane.ts` 响应处理；控制台详情展示。

## ADR-009 重定向：SDK 手动跟随，每跳一条记录

- 状态：🆕 新定（P0 完全没处理：相对 `Location` 被 OkHttp 基于代理 URL resolve，请求逃出代理打到 `127.0.0.1:8899/login` 拿到假 404；绝对跳转则直接绕过代理不记录）
- 背景：OkHttp 的自动跟随发生在 application interceptor **之下**，跟随请求不会再经过 EasyCharlesInterceptor，不会带 `X-EC-Target`。
- 选项：
  1. 服务端改写 `Location` 为代理绝对地址——跟随请求仍缺 `X-EC-Target`，只解决一半；
  2. 用 NetworkInterceptor 做 URL 改写——能覆盖跟随请求，但记录「加密前/解密后明文」需要 ApplicationInterceptor 位置，两个拦截器职责割裂，fail-open 重放逻辑复杂化；
  3. **SDK 拦截器内手动跟随**：检测 3xx + `Location`，基于**原始 URL**（`X-EC-Target` 的值）resolve 出新目标，更新 `X-EC-Target` 重新 `chain.proceed()`，循环直到非 3xx，上限 10 跳。
- 决策：**方案 3**。
  - 每跳独立成一条记录，共享同一 `seq`（方便控制台归组成链），跳转类型记录在案；
  - 语义对齐 OkHttp：301/302/303 → 通常转 GET 并丢 body；307/308 → 保持 method 与 body；
  - 跳转跨 host 允许（本来就是显式引流），但循环检测必须有；
  - 服务端**原样透传** `Location`（相对地址就相对传），resolve 的职责完全在 SDK；
  - 控制台按 `seq` 折叠显示重定向链（P1 控制台增强）。
- 理由与坑点：
  - 对抓包工具这是加分项：Charles 也是逐跳显示的；
  - 手动跟随要用缓冲后的 `snapshot` 重建请求（body 只能写一次），重定向链每跳都要能重放；
  - `followRedirects(false)` 不能全局关（会影响未接 EC 的请求路径），实现上用「拦截器内部手动处理」而非改 client 配置。
- 影响：协议 §3.6 新增；`EasyCharlesInterceptor`；控制台记录展示。

## ADR-010 存储：Store 抽象 + SQLite 落盘

- 状态：🆕 新定（P0 为内存环形缓冲，默认 2000 条、重启丢记录、无分页检索）
- 背景：README「下一步」第一项。内存实现已显瓶颈：无字节上限（2000 × 512KB ≈ 1GB 最坏）、无持久化、无检索。
- 选项：
  1. `better-sqlite3`：成熟、同步 API、但原生模块需编译（分发麻烦，违背零构建洁癖）；
  2. `node:sqlite`（Node 22.5+ 内建）：零依赖、同步 API，但 Node 22 下是实验特性需 `--experimental-sqlite`，Node 24 默认可用；
  3. 先抽象 `Store` 接口，内存实现保留，SQLite 作为可切换后端。
- 决策：**方案 3**，SQLite 首选 `node:sqlite`。
  - 依赖版本策略：若最终目标环境固定在 Node 22，启动脚本加 `--experimental-sqlite` 或退回 `better-sqlite3`（选型在 P1 实施时用最小验证脚本确认，文档记录该决策点）；
  - Schema 与分页接口在协议 §5 与 architecture §6 先行定稿（表结构、索引、cursor 分页）；
  - 写入策略：单条 insert 同步写（本地工具 QPS 低，实测单条 512KB 写入耗时在可接受范围）；若实测阻塞明显再改「写队列 + 批量」，架构上留出 `store.addRecord` 这一个入口即可替换；
  - 规则仍存 JSON 文件（配置类数据，体积小，人工可读），不入库。
- 理由与坑点：`node:sqlite` 的同步 API 会阻塞事件循环，写 512KB 记录是毫秒级，可接受；但大流量的 SSE 采样记录频率高，需要压测验证（P1 验收项）。
- 影响：协议 §5.2（Record 持久化语义）；architecture §6；`server/src/store.ts` 重构。

## ADR-011 加解密插件：表单化配置优先，脚本模式 worker 隔离

- 状态：🆕 新定（P0 未实现；README 已把「固定密钥表单化优先」写进下一步）
- 背景：业务是固定密钥（AES 等），mock 明文必须**加密回写**才能被 App 解开；改 body 会导致 `sign/timestamp/nonce` 失效。
- 决策：
  1. **职责定位修正**（相对 README 原话）：SDK 拦截器在加解密拦截器外层，请求方向抓加密前明文、响应方向抓解密后明文——**代理侧解密只在「想给控制台展示 App 密文」时有意义**；插件真正不可替代的职责是 **`encrypt`（把 mock/改写的明文响应加密回写）**；
  2. 因此 `decrypt`/`encrypt` **必须成对配置**：decrypt 作用于 App→代理的请求体（密文→明文，记录展示用），encrypt 作用于代理→App 的响应体（明文→密文回写）；只配一半则拒绝保存（防「mock 返回明文导致 App 解不开」事故）；
  3. 形态一（P2 优先）：**表单化配置**——算法/模式/填充/Key/IV/编码（base64/hex/utf8），服务端 `node:crypto` 执行；
  4. 形态二（P2 后置）：**脚本模式**——用户提供 `decrypt(buf, ctx)` / `encrypt(buf, ctx)` / `sign(ctx)`，跑在 **worker_threads**（Node 同步 CPU 密集解密必须隔离，ADR-002 硬约束）；脚本可返回改写的 headers/query 用于重算签名；
  5. 密钥等敏感配置存 `.data/` 且 `.gitignore`（P0 已忽略 `server/.data/`）；
  6. 协议信号：命中插件的记录 `flags.decrypted=true`、响应头 `X-EC-Decrypted: 1`、`Record.rawBody` 保存处理前原始 body。
- 理由与坑点：三个必坑（memory 已记）：encrypt 必须与 decrypt 成对；sign 类字段会因改 body 失效，插件需能改 header/query；固定密钥不进代码库。
- 影响：协议 §5.4（规则 schema 扩展 `crypto` 字段）与 §3.4；architecture §7；`server/src` 新增插件目录；规则引擎联动（插件命中也要走 mock 回写链路）。

## ADR-012 record-mode 语义（full / meta / sample）

- 状态：🆕 新定（P0 的 `--record-mode` 是死配置：只被读取转发，从未影响记录）
- 背景：README 与协议都声明了记录模式，实现没做。
- 决策：
  - `full`（默认）：按 ADR-008 缓冲策略记录完整 body（超阈值自动采样）；
  - `meta`：**只记元数据**——headers/状态/耗时/大小，body 一律不落（`body=''`、`bodySize` 保留真实值、`bodyTruncated=true`）。注意：**转发不受影响**，缓冲照做，只是记录不存 body；
  - `sample`：body 只记前 `sampleBytes`（默认 8KB），`bodyTruncated=true`；
  - 生效优先级：`X-EC-Record-Mode` 请求头（per-request 覆盖）> 全局 `--record-mode` > 默认 `full`；
  - 服务端全局模式的切换同时支持运行时指令（控制面 `set_record_mode`，P1）。
- 理由与坑点：meta/sample 是内存与磁盘换便利的开关；per-request 覆盖用于「某个敏感接口不落 body」的合规场景（如登录接口）。
- 影响：协议 §3.2（X-EC-Record-Mode 语义落地）；`data-plane.ts` 记录组装；控制台展示「未记录 body」提示。

## ADR-013 SDK 超时策略

- 状态：🆕 新定（与 ADR-005 配套）
- 背景：P0 的 SDK 用宿主 OkHttpClient 默认超时（read 10s）请求代理，而服务端 `upstreamTimeoutMs` 默认 30s——业务请求 12s 才返回时，SDK 侧先超时，被误判为代理不可达并重放（ADR-005 已判为红线违规）。
- 决策：
  1. **代理请求的超时不得短于业务请求的预期耗时**：`Config.proxyTimeoutMs`（默认 0 = 跟随业务默认，不做额外限制）；若宿主显式设置了 `callTimeout`/`readTimeout`，代理请求至少继承同值；
  2. 超时（任何类型）**不触发 fail-open、不触发熔断计数**，异常原样抛给业务层（行为等同直连真实服务器）；
  3. 代理存活与否由「连接建立类失败」判定（ADR-005），超时类问题留给业务自己的重试/提示逻辑；
  4. 控制面握手（hello）的超时与数据面分开：hello 失败不阻塞任何请求（P0 已如此，控制面故障不影响数据面——ADR-003）。
- 理由与坑点：本地代理是透明转发路径，**引入的延迟上限应由业务超时决定，而不是反过来**；`proxyTimeoutMs` 给高级用户留一个「代理很慢但我愿意等」的旋钮。
- 影响：`EasyCharles.Config`；`EasyCharlesInterceptor`；协议 §6.2 的判定条件表。

## ADR-014 hello 的 wsUrl 按请求 Host 生成

- 状态：🆕 新定（小决策，顺手修）
- 背景：P0 用 `cfg.host` 拼 `wsUrl`，`--host 0.0.0.0` 时返回内网 IP——走 adb reverse 的设备会绕开隧道从 WiFi 连控制面。
- 决策：`/__ec/hello` 的响应 `wsUrl` **基于请求的 `Host` 头**生成（`ws://<请求Host>/__ec/ws`），不再依赖 `cfg.host`。adb reverse 场景 Host 是 `127.0.0.1:8899` → ws 走隧道；WiFi 场景 Host 是内网 IP → ws 走 WiFi。两种接入方式自动正确。
- 理由与坑点：零配置且与接入方式自洽；注意 Host 头可能被伪造，但控制台的会话鉴权（ADR-015）兜底了管理面与推送的真实性。
- 影响：`index.ts` hello 处理；协议 §4.1。

## ADR-015 控制台多用户空间 + 数据面免鉴权（取代 ADR-007）

- 状态：✅ 已实现（取代 ADR-007 的 token 三面鉴权；协议 §4.4、§7 已按此修订）
- 背景：ADR-007 的「一把能力钥匙 + 三面校验」在真实联调中暴露两个问题：
  1. 钥匙泄漏（截图、日志、二维码转发）即等于数据面被打开，且无法区分是谁在用；
  2. 多人共用同一个长期口令，回答不了「这台设备/这些记录该给谁看」——而抓包数据天然需要按人隔离
     （同一个后端往往同时有多人在联调）。
  因此鉴权目标从「挡住陌生人」调整为「**数据可见性隔离**」，并接受数据面靠网络边界自保。
- 选项：
  1. 保留 token，再叠加用户体系（token 管入口、手机号管空间）——两套凭据并存，心智负担与实现成本都翻倍；
  2. **取消数据面鉴权，控制台改手机号空间 + 登录会话，设备绑定作为数据可见性边界**；
  3. 数据面也做用户级鉴权（SDK 带用户凭据）——SDK 侧要管凭据生命周期，且抓包 SDK 不该持有用户凭据。
- 决策：**方案 2**。
  1. **控制台 = 手机号空间 + 登录会话**：`POST /__ec/api/login`（手机号 + 全局口令 `--password`，
     默认 `123456`，首次登录即注册）→ 返回 `session`；管理面请求带 `X-EC-Session`，
     控制台 WS `subscribe` 带 `payload.session`（校验失败 `close(4001)`）。会话为服务端内存态，重启失效
     ——*这一条后由 **ADR-031** 修订：会话改为落盘 + TTL，重启不再需要重新登录*；
  2. **设备绑定 = 数据可见性边界**：`deviceId → phone` 归属关系由
     `POST /__ec/api/devices/:id/bind|unbind` 维护；记录查询（`owner=phone`）与 WS 推送均按归属过滤；
     **未绑定设备的记录不属于任何空间**；归属关系落 `.data/store.json`，跨重启保留；
  3. **数据面不鉴权**：`/__ec/p` 与兼容层路由均不校验；SDK 的 `Config.token` / `X-EC-Token`
     **降级为预留字段**（服务端不校验），留给 P1 的可选数据面鉴权；
  4. **兼容层参数化**：第三方客户端的改写路由与头名不在仓库固化，改用
     `--compat-route` / `--compat-target-header` / `--compat-device-header` /
     `--compat-user-id-header` / `--compat-user-name-header` / `--app-id` 注入，**默认关闭**。
- 理由与坑点：
  - **必须写进文档的安全边界**：数据面无鉴权 ⇒ 任何能访问该端口的人都能把它当开放中转代理用
    （可被滥用做 SSRF、流量中转）。因此默认只监听回环并推荐 `adb reverse`；`--lan` 只在可信网络
    **短时**开启。这是**有意接受的取舍**，不是遗漏（协议 §7）；
  - 全局口令≠每用户密码：它只决定「能否进入控制台」，用户间隔离靠手机号空间 + 设备绑定；
    默认口令只适合本机自用，监听局域网前必须改；
  - 数据面无鉴权 ⇒ 设备注册也不需要凭据，于是「非 SDK 客户端在数据面直接 upsert 设备」成为可能
    （无需控制面就能在控制台看到设备），这是兼容层顺带获得的能力；
  - 会话在内存：重启需重新登录（可接受）；若将来要持久会话，需引入签名 cookie/JWT，列入 P1 备选
    ——**已由 ADR-031 落地，但没有走签名 cookie/JWT**：单进程场景里无状态换不到收益，
    却会丢掉 `logout` 的着力点，最终选了「会话表落盘 + `--session-ttl`」；
  - 坑：`EC_UNAUTHORIZED` 语义变了——从「token 无效」变为「控制台未登录/会话失效」；
    SDK 的 fail-open 集合仍保留该码（数据面将来若启用鉴权可直接复用）。
- 影响：协议 §2/§3.2/§3.3/§4.3/**§4.4（新增）**/§5.1/§6.1/§7/§8.1/§9；
  `config.ts`（`--password`、`--compat-*`、`--app-id`）、`index.ts`（login/logout/me/bind/unbind + 会话鉴权）、
  `store.ts`（用户/会话/绑定 + 落盘）、`control-plane.ts`（subscribe 会话校验 + 按空间推送）、
  `data-plane.ts`（免鉴权 + 兼容层设备识别）、`web/index.html`（登录页/用户空间/设备绑定）；
  SDK 侧 `Config.token` 降级为预留。

## ADR-016 Mock 模式与入参匹配

- 状态：✅ 已实现（协议 §5.4 的 `match.query` 预留位改名为 `match.params` 并落地，见 C10）
- 背景：控制台需要一个「Mock 模式」——对选中的接口做 mock，编辑器带入当前返回值可改，
  被 mock 的接口命中后直接返回 mock 值、不再转发真实服务器。同时匹配要能区分「只匹配域名 + path」
  与「还要匹配入参」，且入参只认业务参数（公共参数每次在变，勾上必然匹配不上）。
- 关键判断：**底座已经有了，不要重造。** `rules.ts` 就是 mock 引擎（`match` + `action: mock`），
  `data-plane.ts` 命中后 `respondMock` 直接 return，天然满足「不转发」。
- 选项：
  1. 新做一套独立的 mock 机制（独立的存储、匹配、下发链路）；
  2. **复用规则引擎**：只补入参匹配，其余（静态 / 顺序 mock、延迟、优先级、指针隔离）沿用；
  3. 把「模式」做成服务端开关，mock 模式下所有规则强制生效。
- 决策：**方案 2**，并明确三条边界：
  1. **「浏览模式 / Mock 模式」是控制台的纯视图状态**（存 localStorage），**不进协议、不进服务端**。
     某条 mock 是否生效，仍然只由该规则的 `enabled` 决定——**不引入第二个真值来源**，
     否则「模式开着但规则没启用」这类不一致会变成静默失效（AGENTS.md §5 三方核对的精神）；
  2. **入参匹配统一为 `match.params`**（协议 §5.4，取代从未实现的 `match.query`）：
     匹配对象是 query + body 合并后的「请求入参」，同名以 body 为准；AND 语义；value 为空串 =
     只要求存在；非空则复用既有的 `glob` / `re:` 匹配；不配置 = 不校验入参（旧规则零迁移）。
     理由：控制台展示层（`requestParams()`）与用户心智里 query + body 本来就合成一个「入参」，
     拆成 `match.query` + `match.body` 会逼 UI 维护两张表、规则 JSON 也更啰嗦；
  3. **「业务参数 / 公共参数」的划分留在控制台**（`COMMON_PARAMS`），服务端不认识这个概念——
     服务端只按 `params` 里写了什么就匹配什么。保持「服务端只认协议、不认某个客户端的内网知识」
     这条既有边界（同 ADR-015 的兼容层参数化思路）。
- 理由与坑点：
  - **从记录生成规则**是「带入当前返回值」的实现方式：浏览模式详情页点「Mock 此接口」，
    用该记录的 method / host / path / query / body + 响应 status / headers / body 组装草稿规则，
    再进 Mock 模式编辑。这样 host 天然带端口（避开 ADR-004 记下的 F-09 坑）；
  - **公共参数必须默认不参与匹配**：`timestamp` / `noncestr` / `sign` 每次请求都在变，
    一旦被勾进取值匹配，规则永远命中不了。这是本特性最容易踩的坑，控制台默认折叠它们；
  - **优先级遮蔽**：命中多条只取 `priority` 最高的一条（协议 §5.4）。「按入参精确匹配」的规则
    必须比「只匹配路径」的规则 priority 更高，否则被宽松规则遮蔽。服务端**不做**自动加权
    （不做隐式魔法），由控制台提示；
  - 入参合并是**不可信输入的最短路径**（`body` 可能被写成数组 / 标量 / 非 JSON / base64），
    必须全程防御，`match.params` 传非对象（数组 / 标量）时 `replaceAll` 直接 400，防毒化
    （同 F-15 的教训，AGENTS.md §4）。
- 影响：协议 §5.4（`match.params` 语义）与 §0（C10）；
  `server/src/types.ts`（`Rule.match.params`）、`server/src/rules.ts`（`matchParams` / `resolve` / `replaceAll`）、
  `server/src/data-plane.ts`（`collectParams`）、`server/tools/selftest.ts`；
  控制台 `server/web/index.html`（模式切换 + Mock 编辑器）。

## ADR-017 现场快照：免鉴权只读能力 URL

- 状态：✅ 已实现（协议 §4.5 新增；安全约束见协议 §7 第 9 条）
- 背景：排查问题时，最常见的一步是「把这一条请求 + 响应发给同事看一眼」。现在只能截图或
  复制 body，信息丢失严重（Headers、耗时、上游错误全没了）；让对方自己连控制台又要登录、
  还要把设备绑到他名下。需要的是「把一条记录变成一条**直接打得开**的链接」。
- 选项：
  1. **存记录 id 的引用**，打开时回 `Store` 查 —— 记录在内存环形缓冲（默认 2000 条），
     被淘汰或服务重启后链接变死链，正好在最需要回看的时候失效；
  2. **存冻结副本**（创建那一刻整体拷贝，落盘）—— 链接寿命与记录寿命解耦；
  3. 导出 HAR / 文件给对方 —— 对方要先下载再找工具打开，不是「点开就看」。
- 决策：**方案 2**，并明确四条边界：
  1. **新增第 4 个面「快照面」**（`/__ec/s/:token` 数据 + `/s/:token` 页面），**只读、免鉴权**。
     它与数据面的关键差别是：**只有 GET、不转发任何请求**，因此**不能**被当开放中转代理滥用
     —— 新增这个面**不放大** ADR-015 那条「数据面不鉴权」的风险边界；
  2. **能力 token = 128 位随机**（32 hex，`randomUUID` 去横线）。持有 token 即视为有权读取
     （这是产品要求：「打开快照不需要权限」），所以 token 必须不可枚举；
  3. **创建走管理面且只能分享自己空间内的记录**：`POST /__ec/api/snapshots` 校验
     `deviceOwner(rec.deviceId) === 会话手机号`，否则 403。**能看见才能分享**，
     用户空间边界（ADR-015）不被绕过；
  4. **原样保留敏感头**：`authorization` / `cookie` 等**不**打码——排障常常就是要看原文。
     风险靠「创建是显式动作 + 页面显著警告 + 随时可失效」兜底，而不是靠打码（打码等于把
     排障信息删掉，且不可恢复）。
- 理由与坑点：
  - **落盘粒度：一条快照一个文件**（`server/.data/snapshots/<token>.json`）。快照 body 可达
    `maxBufferBytes`（默认 512KB），若用「单文件数组」每次创建都要全量重写整份文件；
    一文件一条则创建 = 写一个文件、失效 = 删一个文件，代价恒定；
  - **默认 7 天过期**（`--snapshot-ttl` 小时，`0` = 永不过期）+ **数量上限 200**
    （`--snapshot-max`，超出按最旧淘汰）。免鉴权数据不应无限期留在磁盘上；读取路径顺手清理
    过期项，另有 10 分钟兜底清扫（`timer.unref()`，不阻止进程退出）；
  - **快照页不回 `createdBy`**：手机号属个人信息，不进免鉴权页面；管理面列表也不回
    （控制台本来就知道自己是谁）。`createdBy` 只在服务端用于「归属校验」；
  - **失效/清空只能操作自己创建的**：他人 `DELETE` 返回 `ok:false`（而不是 403），
    不泄露「该 token 是否存在」；
  - **缓存与收录**：页面与 JSON 一律 `cache-control: no-store` + `x-robots-tag: noindex`
    + `referrer-policy: no-referrer`，避免链接被代理缓存或搜索引擎收录；
  - **脏数据防御**（AGENTS.md §4）：非字符串 token / 非对象记录一律不崩；落盘目录里的
    坏文件（手工改坏、写一半断电）在 `load()` 里跳过，**绝不让它毒化启动**（F-16 的教训）；
  - **LAN 可达性**：快照链接优先给内网 IP（同事才打得开），非 LAN 模式回退到请求 `Host`，
    并在生成后**直接提示**「链接是回环地址，局域网里打不开」——避免出现「分享出去但对方打不开」的静默失效；
  - **UI 是纯前端，且只保留「生成」一个动作**：详情页「分享快照」按钮，生成后把链接**内联**贴在详情卡片里
    （可再复制一次）。前台**不提供**快照列表 / 失效 / 清空的管理界面——收回交给服务端 TTL
    （`--snapshot-ttl`），需要批量管理时用管理面接口。没有引入第二个真值来源（快照的真实状态只在服务端）。
- 影响：协议 §2（新增快照面一行）/ **§4.5（新增）** / §7 第 9 条；
  `server/src/types.ts`（`Snapshot` / `SnapshotMeta` / `Config.snapshotTtlMs` / `Config.snapshotMax`）、
  **`server/src/snapshots.ts`（新增）**、`server/src/config.ts`（`--snapshot-ttl` / `--snapshot-max`）、
  `server/src/index.ts`（快照面 + 管理面 + 过期清扫）、`server/tools/selftest.ts`（`[F-24]`）、
  控制台 `server/web/index.html`（详情页分享按钮 + 内联结果）、**`server/web/snapshot.html`（新增查看页）**。

## ADR-018 控制台角色（管理员 / 普通使用者）与设备可见性

- 状态：✅ 已实现（协议 §4.4 新增角色与设备可见性口径、**§4.6（新增）**）
- 背景：ADR-015 只做到「用户空间隔离」——记录按 `owner` 过滤，但**服务端层面的全局信息仍然对
  所有登录用户开放**，实测有三处：
  1. `GET /__ec/api/info` 把**全局** `stats`（记录数 / 设备数 / 在线数）下发给任何人；
  2. `GET /__ec/api/devices` 直接返回 `store.listDevices()`，**没有 owner 过滤** ⇒ 任何人能看到
     全服设备，包括别人绑定的那台；控制面 WS 的 `device` 推送同样是**全量广播**；
  3. `PUT /__ec/api/rules` 操作的是**全局单文件** `rules.json` ⇒ 任何登录用户可改所有人的 mock 行为。
  对一个「多人共用一个本地服务联调」的工具来说，「谁能看全局、谁能改全局」需要明确下来。
- 选项：
  1. **只在前端隐藏**：控制台按角色少画几个入口，接口不变。改动最小，但 curl 一下就绕过
     ——按 AGENTS.md §4 的精神（前端能绕的一律不算数），这等于没做；
  2. **一维角色 + 服务端强制**：`role: 'admin' | 'user'` 两个角色，管理面接口在服务端校验，
     非 admin 返回 403；
  3. **RBAC（角色 × 作用域）**：为将来「按设备授权」预留多维度。当前没有这个需求，
     且会引入权限矩阵的维护成本 —— 过度设计。
- 决策：**方案 2**（一维角色），并明确四条边界：
  1. **角色来源 = 启动参数，不落盘、不兜底**：`--admin <手机号>[,<手机号>...]`（复用 `config.ts`
     已有的 `readList`）。角色**不写进 `store.json`** —— 唯一真值来源是启动参数，避免
     「配置改了但库里还留着旧角色」的第二真值来源（AGENTS.md §5 的同类问题）。
     **未配置 `--admin` 时没有任何管理员**，管理面板不会出现。刻意**不**做「首个注册用户即管理员」：
     在 LAN 模式下「谁先登录谁是管理员」是竞态，等于给一个抓包代理**意外的权限提升**。
     **管理员是可选增强，不是使用前提**：未配置时除 `/__ec/api/admin/*`（403）与管理入口外，
     其余能力（登录 / 记录 / 设备绑定 / 全局 Mock 规则 / 快照分享）**完全不受影响**。
     这条已用「不配 `--admin` 的实例跑完整普通用户链路」端到端验证过（22 项断言）；
  2. **强制点在服务端**：新增 `GET /__ec/api/admin/overview`（全局统计 + 用户空间列表），
     非 admin 一律 `403 EC_UNAUTHORIZED`。控制台隐藏「管理」入口只是 UX；
  3. **设备可见性 = 自己绑定的 + 未绑定的**：普通用户 `GET /__ec/api/devices` 返回
     `owner === 自己` **或** `owner == null` 的设备。**必须保留「未绑定」那一类**，否则
     「登录 → 看到新设备 → 绑定」这条主流程会被自己堵死（看不到就绑不了）。
     他人已绑定的设备**不下发**（现在控制台里那个「已绑定 138…」标签会因此消失，这是预期）。
     `admin` 返回全量。控制面 WS 的 `device` 推送按**同一口径逐连接过滤**（原来是全量广播）；
  4. **不动全局 Mock 规则**：`rules.json` 仍是全局单文件、仍对所有登录用户可写。
     这是 ADR-016 明确拍板过的（「规则全局生效」），改它属于另一件事，需要单独决策；
     本次**只**收敛「全局统计」与「设备可见性」，不夹带。
     **已与用户确认维持现状**（2026-10-09）：把规则划给管理员会让普通用户失去 Mock 能力
     （本工具的核心功能），而「按空间隔离的规则」与 ADR-016 直接冲突——两条路都比收益贵。
     **不要**在没有新需求时重新提起这件事；
     ——*这一条已被 **ADR-033**（见文末）部分推翻：新需求到了，规则改为按**项目归属**隔离。
     注意推翻它的方式恰好不是本条担心的那条——不是把规则划给管理员，而是每个用户有自己的私有项目，
     普通用户的 Mock 能力没有缩水；角色模型（`--admin`）本身不变*；
  5. **管理员的职责 = 统计查看 + 统一配置（只读）**：`overview` 除统计与用户空间列表外，
     还下发 `config`（当前生效的全局配置：监听 / 记录模式 / 缓冲与采样 / 超时与心跳 /
     快照 TTL 与上限 / 兼容层 / 管理员名单 / 数据目录），在控制台「统一配置」区块**只读展示**。
     **「管理员在控制台改配置」明确不做**（2026-10-09 已与用户确认「只读即可」，**不是待办**）：
     它要引入运行时可变配置 + 落盘 + 明确哪些改完必须重启，收益不明而风险实在。
     真要改配置，仍走启动参数（`--record-mode` / `--snapshot-ttl` …）——那是唯一真值来源。
- 理由与坑点：
  - **`info` 去掉全局计数**：`/__ec/api/info` 保留服务端信息（版本 / 端口 / LAN / 记录模式 /
    快照 TTL），**移除 `stats` 与 `snapshotCount`**（两者都是全局量，且控制台并未消费它们）；
    全局统计改由 admin 接口提供。避免「加了角色，却把统计从 info 继续漏出去」的自相矛盾；
  - **`role` 在 `login` / `me` 的 `user.role` 里返回**（`ConsoleUser = User & { role }`）。
    控制台据此决定是否画「管理」入口；`store.User` 本身**不加** `role` 字段，
    旧 `store.json` 无需迁移（缺字段也无所谓）；
  - **脏数据防御**（AGENTS.md §4）：`listDevicesFor(phone)` 的 `phone` 非字符串 → 返回空数组，
    绝不因为一个脏 session 值把全量设备漏出去；
  - **不引入新依赖、不新增顶层目录**：改动全部落在既有文件里。
- 影响：协议 **§4.4（补角色与设备可见性）** / **§4.6（新增 admin 接口）**；
  `server/src/types.ts`（`UserRole` / `ConsoleUser` / `DeviceView` / `Config.adminPhones`）、
  `server/src/config.ts`（`--admin` + `isAdminPhone`）、`server/src/store.ts`
  （`listDevicesFor` / `listSpaces`）、`server/src/index.ts`（role 下发 + 设备过滤 + admin 接口 + info 瘦身）、
  `server/src/control-plane.ts`（设备推送逐连接过滤）、`server/tools/selftest.ts`（`[F-25]`）、
  控制台 `server/web/index.html`（管理入口 + 管理面板）、`docs/architecture.md`（安全模型表）。

## ADR-019 Mock 规则的单条删除与开/关

- 状态：✅ 已实现（协议 **§4.7（新增）**）
- 背景：规则的写入口只有 `PUT /__ec/api/rules` **全量替换**一个。控制台要在 Mock 列表的
  每一条上直接「开/关」「删除」时，只能本地改完 `state.rules` 再整表 PUT 覆盖：
  - 多开一个控制台标签页（或两个人共用同一台服务联调）时，**后写的一方会把前者改的
    其他规则一起覆盖掉** —— 明明只点了一下开关，别人的规则却静默回滚了；
  - 「删除」同样要发整份规则数组，发送/校验的成本和只删一条不成比例。
- 选项：
  1. **继续用全量 PUT**（控制台本地改数组 → 覆盖写）；
  2. **新增单条接口**：`DELETE /__ec/api/rules/:id` + `POST /__ec/api/rules/:id/enabled`，
     编辑（可能改动任何字段）仍走 `PUT`；
  3. **把编辑也拆成 `PUT /__ec/api/rules/:id`**：写入口完全单条化。
- 决策：**方案 2**。理由：单条接口只动那一条，天然不覆盖别人；编辑本身会改到
  匹配条件 / 返回值 / 优先级等任意字段，`replaceAll` 已经有一套针对**整表**的毒化校验
  （F-15），拆成单条要重做一套等价的逐字段校验 —— 收益不足。等真出现「编辑也被覆盖」
  的诉求再谈方案 3。
- 边界（三条，改动时不要越界）：
  1. **不开「全局 mock 开关」**：开/关就是规则的 `enabled` 字段，没有第二个真值来源
     （ADR-016 边界 1）。控制台的「浏览 / Mock」模式切换仍是纯前端视图状态；
  2. **规则仍是全局、对所有登录用户可写**（原依 ADR-018 边界 4；**已由 ADR-033 定为待取代**，
     契约已改为按项目归属隔离，实现落地前本条仍然生效）。
     新增的两个接口沿用同一口径：只校验会话，**不区分角色**；
  3. **写入口一律扛脏数据**（AGENTS.md §4）：`enabled` **只接受布尔**，`0/1` / `"true"`
     一律 `400`（LAN 下任何持有会话的客户端都能打，宽松强转等于把「什么算开」交给调用方）；
     id 非字符串 / 空 / URL 解码失败 → `400`；id 不存在 → `404` 而非静默成功。
- 理由与坑点：
  - **路由顺序**：`/__ec/api/rules/:id` 会吃掉 `/__ec/api/rules/reset-pointers`。
    `reset-pointers` 的匹配**必须**排在 `:id` 块之前；
  - **`isToggle` 用未解码的路径判断**：id 里若真的含 `/`（写成 `%2F`），解码后再判断
    `/enabled` 后缀会把 `/rules/a%2Fenabled` 误认成开关接口；
  - **删除要顺带丢掉该规则的顺序指针**（`pointers` 的 key 是 `deviceId:ruleId`）：
    不丢的话「删掉再用同一个 id 重建」会从半截序列继续，表现为「新规则第一次请求
    就返回第 3 条响应」；
  - **控制台以服务端为准**：开关/删除成功后整份 `loadRules()` 拉回来重画，不在本地猜状态，
    避免两个标签页各显示一套。
- 影响：协议 **§4.7（新增，规则管理接口）**；
  `server/src/rules.ts`（`remove` / `setEnabled`）、`server/src/index.ts`（两个新路由 + 校验）、
  `server/tools/selftest.ts`（`[F-26]`）、控制台 `server/web/index.html`
  （列表项开/关 + 删除按钮，并复用 `removeRule` 替换编辑器里的本地 splice + PUT）。

## ADR-020 移除内置示例规则的自动注入

- 状态：✅ 已实现
- 背景：`RuleEngine.load()` 在 `rules.json` 缺失 / 解析失败 / 为空数组时，会注入一条内置示例
  `demo-sequence`（`GET /api/user/profile`，200→401→403 循环）。它是给「顺序 mock」做的教学样本，
  但落到真实使用里有两个问题：
  1. 它和用户自己抓的真实规则在控制台列表里**平级**，看起来像凭空多出来的不明规则，
     用户会疑惑「这条哪来的」；
  2. 触发条件是 `length === 0`，所以用户把规则删空后**重启又会被灌回来**，表现为「删不干净」。
- 选项：
  1. **保留注入**，只在展示上弱化（置灰 / 单独分组）——治标，用户仍要手动删；
  2. **移除注入**：`load()` 空即为空，首次启动就是空列表，规则完全由用户创建；
  3. **仅「文件不存在」时注入**（区分「从未初始化」与「用户清空」）——要多维护一个初始化隐式状态，
     只为「帮新用户预置一条样例」，收益不足。
- 决策：**方案 2**。规则是用户的运行数据，服务端不应凭空写入用户没建过的规则；
  教学样本的正确位置是文档（`README.md`「多个返回值与顺序 mock」一节已给出一份可粘贴的 JSON），不是运行时列表。
- 理由与坑点：
  - 样例仍保留在 `README.md`「多个返回值与顺序 mock」一节，需要时手动复制，不影响运行；
  - 空列表 ≠ 异常：`rules.json` 缺失 / 非数组 / 空数组一律回退为 `[]`，不再与任何注入耦合；
  - **不引入配置文件或额外状态文件**来区分「未初始化 / 已清空」（AGENTS.md §1）。
- 影响：`server/src/rules.ts`（删除 `defaultRules()` 及其调用、更新 `load()` 注释）；
  `server/tools/selftest.ts`（`[F-16]` 断言由「回退到默认规则」改为「回退为空列表」，
  并补「无 rules.json / 空数组 → 不注入示例」两条用例）。协议无变化。

## ADR-021 「忽略」的入参状态记在控制台本地

- 状态：✅ 已实现
- 背景：Mock 编辑器的入参区，每个参数有「匹配 / 忽略」两种状态（2874b99 引入）。
  `match.params` 只存**参与匹配**的参数（ADR-016），所以切到「忽略」的参数不写进规则；
  而保存后编辑器又从规则重建草稿（`ruleToDraft` 只回读 `match.params` 的 key），
  结果是**忽略的参数一保存就凭空消失**——尤其是自动折叠的公共参数（`timestamp` / `sign` 等），
  重开规则全没了，用户会以为「点忽略 = 把它们删了」。
- 选项：
  1. **记在浏览器本地**（`localStorage`，key = `ec_ignored_<ruleId>`，存 `[{k,v}]`）；
  2. **写进规则 JSON**（如 `match.paramsIgnored`）：随规则全局持久、跨浏览器一致；
  3. 不持久化，仅本次编辑会话内保留（刷新即丢）——解决不了「重开规则就没了」。
- 决策：**方案 1**。「忽略」是**控制台的编辑期状态**，不是匹配语义——与 ADR-016 边界 1
  （「浏览 / Mock 模式」纯视图状态存 localStorage）、边界 3（业务/公共参数划分是控制台本地知识、
  服务端不认识）一脉相承。把 UI 状态写进规则 JSON 会污染协议数据，并给 `match` 添一个无匹配语义的字段。
- 理由与坑点：
  - **规则 JSON / `protocol.md` / 服务端零改动**：`match.params` 语义不变，服务端仍「写了什么就匹配什么」；
  - 代价：只在当前浏览器记得，换浏览器 / 清缓存会丢——可接受，它本就是本机编辑便利、不是规则的一部分；
  - **重开时以规则为准**：本地忽略项若与 `match.params` 的 key 冲突（用户又切回了「匹配」），
    跳过本地那条，避免同 key 出现两次；
  - 删除规则时同步清掉本地键（`clearIgnored`），不留孤儿；
  - localStorage 读写全部 `try/catch`：隐私模式 / 配额满时静默降级（只少个便利，不影响保存）；
  - 存的 `[{k,v}]` 过滤空 key、`v` 强转字符串，脏数据不得进本地存储。
- 影响：控制台 `server/web/index.html`（`ignoredKey` / `loadIgnored` / `saveIgnored` / `clearIgnored`、
  `ruleToDraft` 合并忽略项、`saveDraft` 落盘、`removeRule` 清理）。协议与 `selftest.ts` 无变化。

## ADR-022 服务端发布包：白名单 tarball，不做 Docker / 不引入构建步骤

- 状态：🆕 新定（2026-10-11）
- 背景：需要把服务端部署到**内网服务器**给小组共用。此前唯一的"打包"是
  `scripts/build-app.sh`，产物是 macOS 双击启动器（`EasyCharles.app`），且入口会向上找
  `server/src/index.ts`，**必须和项目放在一起**，不能拿去别的机器。
- 选项：
  1. **白名单 tarball**（`scripts/build-server-bundle.sh` → `build/*.tar.gz`）：把
     `src/ web/ package*.json node_modules/ws` + 部署模板打进包，目标机只需 Node；
  2. **Docker 镜像**：新增 `Dockerfile` + `.dockerignore`，把 Node 版本钉死在基础镜像里；
  3. **不新增产物**：目标机 `git clone` + `npm ci --omit=dev` + 自写 systemd unit。
- 决策：**方案 1**。理由：
  - 服务端是**零构建**形态（`node src/index.ts` 直接跑 `.ts`），唯一运行时依赖 `ws` 只有
    196 KB 且纯 JS 无原生模块 ⇒ 把 `node_modules/ws` 随包带上即可**完全离线**部署，
    目标机不需要 npm、不需要外网。方案 2 的收益（钉 Node 版本）用一个版本探测就能拿到；
    方案 3 把环境依赖（git/npm/外网）压给了目标机，不符合"给别人的服务器"这个场景。
  - **收集用白名单**，不是 `git archive` 也不是 `cp -r` 再排除：发布包要交到别人机器上，
    隐私不能靠"记得排除"。`.data/`、`easy-charles.conf`、`.git`、`android-sdk/` 从源头上就
    不在收集范围，产物再核对一次禁忌路径与权限位。
  - **打包含门禁**：`tsc --noEmit` + `selftest` 全绿 + `web/` 三件套 + `ws` 与 lockfile 一致，
    红着的代码不许出门（对应 AGENTS.md §8 的改后检查）。
  - **权限位必须归一化**（文件 644 / 目录 755）：仓库里 `server/web/about.html` 的 mode 是
    600，`cp` 会原样带出；包由 root 解到 `/opt`、服务以普通用户运行时，该文件读不到 ——
    表现为 `/about` 页 500 而控制台首页正常，属于最难查的一类故障。
  - 模板放 `scripts/deploy/`（既有顶层目录的子目录），不新增顶层目录（AGENTS.md §2）。
- 理由与坑点：
  - 服务端**代码零改动**：`EC_*` 环境变量（`EC_PORT` / `EC_HOST` / `EC_LAN` / `EC_PASSWORD` /
    `EC_ADMIN` / `EC_DATA_DIR` / `EC_NODE_BIN`）只在包内 `run.sh` 里翻译成命令行参数，
    与 `easy-charles.conf` 属同一层（启动器约定，不是服务端配置格式）。这样 systemd unit
    里不必出现口令明文，配合 `EnvironmentFile=` 即可；
  - `--data-dir` 必须显式传绝对路径：`config.ts` 里默认 `resolve('.data')` 是相对
    **进程 cwd** 的，交给 systemd 就是随机位置；
  - `run.sh` 的 Node 探测**既看版本也真跑一次 .ts**（发行版裁剪/自编译可能例外），
    判定口径与 `scripts/easy-charles-lib.sh` 的 `ec_node_ts_flag` 一致，改一处要同步另一处；
  - **HTTPS 反代不在本决策范围内**：`wsUrl` 与快照链接分别恒为 `ws://`（ADR-014）、
    `http://`，TLS 终结在反代上时控制台会撞 mixed content。要支持得改代码 + 新 ADR，
    本次按"内网 `http://` 直连"交付，并在包内 DEPLOY.md 列为已知限制；
  - 健康检查只能用 `GET /`（`/__ec/api/*` 一律要会话，`/__ec/api/health` 未登录也是 401）。
- 影响：新增 `scripts/build-server-bundle.sh`、`scripts/deploy/{run.sh,easy-charles.service,
  easy-charles.env.example,DEPLOY.md}`；`README.md` 增「部署到内网服务器」小节与目录结构行；
  `build/` 为产物目录（已在 `.gitignore` 中）。**协议、服务端 `server/src/`、
  `selftest.ts`、Android SDK 均无改动**。

### ADR-022 补充（2026-10-11）：macOS 目标机用 launchd + 双击脚本

- 背景：目标机之一**就是另一台 Mac**，而 macOS 没有 systemd，`easy-charles.service` 用不了；
  "解包后在终端敲命令"对只想跑服务的机器太别扭。
- 决策：包内再给一套 macOS 形态 —— `local.easycharles.server.plist`（launchd **用户级** agent）
  加三个双击脚本（`启动EasyCharles.command` 前台跑看日志 / `安装后台服务.command` /
  `卸载后台服务.command`）。**服务端代码同样零改动**。
- 理由与坑点：
  - **launchd 的 `PATH` 只有 `/usr/bin:/bin:/usr/sbin:/sbin`**，Homebrew / nvm 装的 node 不在其中，
    `run.sh` 的 `command -v node` 会找不到。所以安装脚本必须把 node 解析成**绝对路径**写进
    plist 的 `EC_NODE_BIN`（`EC_NODE_BIN` 本就是为这种场景预留的）；
  - **`KeepAlive` 会一直拉起进程**：停止必须 `launchctl bootout`，`kill` 掉会被重新拉起 ——
    这正是"卸载"单独一个脚本的原因；
  - plist 里的值要先做 **XML 转义再做 sed 转义**：口令含 `&` / `<` / `>` 会直接把 plist 写坏；
  - macOS 数据目录改用 `~/Library/Application Support/EasyCharles/data`、日志用
    `~/Library/Logs/EasyCharles/`（符合 Mac 习惯，也避免和代码目录混在一起）；
  - **双击脚本命名与隐私钩子的已知冲突**：`scripts/pre-commit-privacy.sh` 原用
    `for f in $STAGED` 遍历 `git diff --cached --name-only` 的输出，两类路径会被**静默跳过**
    （`[ -f "$f" ]` 为假 → `continue`）：① 含空格的路径被拆散；
    ② **非 ASCII 路径**被 git 按 `core.quotePath` 默认转义成 `"...\345\220..."`。
    实测：同内容的 `.hooKtest-ascii.sh`（含假 AWS key）被拦下，`.hooKtest-中文名.sh` 没被拦。
    本次**保留中文文件名**（双击体验优先，这也是仓库既有约定）；
    钩子本身的缺陷当天已修，见 **ADR-023**（修完这 3 个 `.command` 也在检查范围内了）；
  - 目标机仍需**自己装 Node 22.6+**（包里不带 Node，这是 ADR-022 主条的取舍）。
- **补充修正（同日，见 ADR-024）**：这份安装脚本有个只在脚本化部署时才暴露的缺陷 ——
  `launchctl bootout` 是异步的，紧接着 `bootstrap` 同一个 label 会失败；旧实现吞掉错误、
  退回 `launchctl load -w`（还会装进别的域），于是"报已装载、`launchctl print` 查不到、
  node 根本没跑"。ADR-024 已修（等 job 真的消失 + 重试 10 次 + 校验 + 打 launchd 原始报错）。
  人工双击碰不到它，因为两次双击之间天然隔了几秒。
- 影响：新增 `scripts/deploy/{local.easycharles.server.plist,启动EasyCharles.command,
  安装后台服务.command,卸载后台服务.command}`；`build-server-bundle.sh` 收进这些模板、
  保住 `.command` 执行位（统一 644 之后要再挑回来）、产出 `.sha256` 校验文件；
  `.gitignore` 增 `easy-charles.env`（macOS 本地配置，含口令）；DEPLOY.md 增 §3B 与 macOS 排错表。

### ADR-022 补充 2（2026-10-11）：`EC_ARGS` 透传通道

- 背景：兼容层（`--compat-route` / `--compat-*` / `--app-id`）没有对应的 `EC_*` 变量，
  `run.sh` 又只翻译它认识的那几个变量 → 发布包里的常驻服务（systemd / launchd）**带不上兼容层参数**，
  而手工改 unit / plist 会被下次重装覆盖。第一次做多人联调部署时就会撞上（症状：接口全 404）。
- 决策：`run.sh` 新增 `EC_ARGS` 透传（按空格切分的参数串，语义照抄启动器既有的
  `easy-charles.conf` 的 `EC_ARGS`，同一台机器上两份配置同名同义）。Linux 放 `EnvironmentFile`，
  macOS 由安装脚本写进 plist 的 `EnvironmentVariables`。
- 理由与坑点：
  - **优先级实现取决于服务端语义**：`config.ts` 的 `readArg` 取 `indexOf` 的**第一个**匹配，
    所以优先级就是参数在 argv 里的先后。顺序定为 `命令行 → EC_* → EC_ARGS → 默认值`，
    `EC_ARGS` 只当兜底，抢不过任何显式设置；
  - **踩过一次的坑**：判断"运维是否显式传了 `--port`"的扫描列表里**不能**包含 `EC_ARGS`
    （否则 `EC_ARGS="--port 9000"` 会抑制 `EC_PORT` 的翻译，等于把 `EC_ARGS` 抬成最高优先级，
    与文档自相矛盾）。所以扫描拆成两个：`cli`（只看命令行，管 `want_*`）与
    `scan`（含 `EC_ARGS`，只用于判断"是否暴露到非回环"）；
  - **暴露判定必须含 `EC_ARGS`**：否则 `EC_ARGS="--lan"` 会绕过 ADR-015 的三条警告；
  - 服务端代码**零改动**（这条通道纯在启动器里）。
- 影响：`scripts/deploy/run.sh`（`EC_ARGS` 解析 + 双扫描列表）、
  `local.easycharles.server.plist`（新增 `EC_ARGS` 键）、`安装后台服务.command`（写入并回显）、
  `easy-charles.env.example`、`DEPLOY.md` §4；新增 `docs/lan-workflow.md`（多人联调工作流）、
  `README.md` 增指针。


## ADR-023 隐私钩子改用 NUL 分隔遍历暂存区路径

- 背景：`scripts/pre-commit-privacy.sh` 是隐私红线（AGENTS.md 第 2 节）的唯一自动化防线，
  但它用 `for f in $STAGED` 遍历 `git diff --cached --name-only` 的输出，**两类路径被静默跳过**：

  1. 含**空格**的路径被 shell 的空白分词拆散；
  2. **非 ASCII** 路径被 git 按 `core.quotePath` 默认转义成 `"...\345\220..."`（引号+八进制）。

  两者都会让循环体里第一句 `[ -f "$f" ]` 判为「文件不存在」而 `continue`——
  **不报错、不提示、结论是"检查通过"**，比崩溃危险得多。
- 发现过程：做 macOS 双击脚本时给文件起中文名，实测同内容的两份假密钥文件
  （内容是一行 `AWS_KEY=` 加一个写成 AWS 密钥样例形状的假值，故意让它能触发 TOKEN_PAT）
  ——ASCII 文件名被拦下、中文文件名**放行**。
- 决策：用 `git diff --cached --name-only -z` 写入临时文件，改用
  `while IFS= read -r -d '' f; do … done <"$STAGED_FILE"` 遍历（保留 `--diff-filter=ACMR`）。
  一次性覆盖空格、非 ASCII、以及文件名含换行的极端情况。
- 理由与坑点：
  - **不能用管道喂 `while`**：`git diff … | while read` 会让循环跑在子 shell 里，
    `FAIL=1` 出不来 → 钩子永远"通过"。这里用输入重定向（`done <"$STAGED_FILE"`），
    循环在主 shell，`FAIL` 正常生效；
  - 临时文件与 `TMP` / `TMP2` 一起进 `trap … EXIT`，提前 `exit 0` 也不泄漏；
  - `TMP` / `TMP2` 的创建被提到早退判断之前：否则 `set -u` 下 EXIT trap 引用未定义变量会报错；
  - 只改「怎么拿到并遍历路径」，**检测规则（各段正则、放行白名单）一律没动**，
    避免借机放宽或收紧判定。
- 验收（临时 index + 真实文件，未碰真实暂存区）：
  - ✅ 同内容 4 份假密钥全部拦下：ASCII 名、中文名、含空格、含换行（此前只有 ASCII 名被拦）
  - ✅ 无内容的中文名文件 → 放行（无误报）；无暂存内容 → 退出 0 且零输出
  - ✅ 用 `bash -x` 核对：`[ -f "$f" ]` 被追踪 30 次（3 个内容循环 × 10 文件），
    其中 **9 次为非 ASCII 路径**（3 个中文文件 × 3 循环）⇒ 中文名文件确实进入检查
    （注意 bash 3.2 的 `-x` 用 `$'…'` 转义打印非 ASCII，直接 grep 中文名会误判成"没扫到"）
  - ✅ 钩子无临时文件泄漏；软组织改动本身跑钩子退出 0
- 影响：只改 `scripts/pre-commit-privacy.sh`。`.git/hooks/pre-commit` 是指向它的软链，
  所以修复**立即生效**，无需重装。副作用：仓库里以前被跳过的非 ASCII / 带空格文件
  （如仓库根既有的 `启动 EasyCharles.command`）从此重新进入检查范围——
  它们下次被修改并提交时会真的被扫，这是预期行为。

## ADR-024 局域网部署：角色 1+2 留在开发机，角色 3 在目标机

- 背景（用户明确的目标）：**开发机 + 构建平台在当前 Mac，服务器角色在局域网另一台 Mac**。
  已有的 `build-server-bundle.sh`（ADR-022）解决了"产出什么"，缺的是"怎么送过去并上线"。
  上一版是人工 6 步：打包 → scp → 远端校验 → 解包 → 拷配置 → 双击卸载再双击安装 → 健康检查。
- 决策：新增两个脚本，按**执行位置**切分，而不是按功能切分：

  | 脚本 | 跑在哪 | 职责 |
  |---|---|---|
  | `scripts/deploy-to-lan.sh` | 开发机 | 预检 → 门禁+打包 → scp 产物与 `.sha256` → 经 stdin 把下者喂给远端 `bash` → 透传退出码 → 打印回滚命令 |
  | `scripts/deploy/remote-deploy.sh` | 目标机 | 校验 sha256 → 解到新版本目录 → 继承配置 → 配置自检 → 重装服务 → 健康检查 → 清理旧版本 → 打印 `version_dir` / `previous_dir` |

- 关键设计（每条都有理由）：

  1. **服务器侧那半用 stdin 投喂**（`ssh <远端> bash -s -- <参数> < remote-deploy.sh`）：
     不必先往远端拷脚本；参数用 `printf %q` 逐个转义，路径里的空格/中文都顶得住。
     副作用是子命令必须 `</dev/null`（否则会去读 stdin，把还没执行的脚本正文吃掉）。
  2. **版本目录 + 原子 mv**（先解到 `.staging-$$` 再改名）：产物不可变，
     **回滚 = 把服务切回旧目录**（`--use <目录名>`），不需要 `git reset`、不需要重装依赖。
     同一秒内连跑两次会撞名，撞了加 pid 后缀（脚本化压测才会遇到，实测遇到过一次）。
  3. **配置继承**：`easy-charles.env` 在解包目录里、不在产物里（`.gitignore` 也排除）。
     不继承的话每次部署都丢口令与 `EC_ARGS`，后者的症状是"手机连上了但接口全 404"。
     来源优先级：`--init` 给定 > plist 指出的当前版本目录 > **`$BASE/easy-charles.env`（基础目录里那份）**
     > 最近修改过的历史版本目录。第 3 条是首次真机部署时补的：手工准备配置的人很自然地会把
     `easy-charles.env` 放在 `~/apps/` 下而不是某个版本目录里，原来只认版本目录，
     结果直接报"没有 easy-charles.env"（配置明明就在那儿）。只在"没有在跑的版本目录"时采用它，
     避免两份配置并存时"改哪个才算数"的歧义。**真机第一次部署后就踩了这个坑的反面**：
     人改口令时第一反应是改顶层那份，改完部署也"成功"，但口令纹丝不动（继承的是版本目录那份）。
     所以脚本现在会比对两份的 `EC_PASSWORD`，不一致就明确警告"本次实际继承哪个文件、
     你改的那份不生效"。这类"配置改了但没生效"的坑，必须在工具里喊出来，不能只写在文档里。
     **同一类坑的第二个实例**：手写配置只写 `EC_PORT`/`EC_PASSWORD`、丢掉 `EC_ARGS`，
     会让兼容协议客户端整片 404（`/mock-proxy` 没被挂载），手机侧表现为"连得上、但控制台
     一条记录都没有" —— 排查会一路怀疑手机配置、Wi-Fi、SDK（全是绿的），问题却在服务端启动参数上。
     已加空 `EC_ARGS` 主动警告 + 一条自查命令。结论：**"缺一项就整片静默失效"的配置，
     必须有工具层的体检，不能靠文档提醒。**
  4. **配置自检放在解包之前**：缺口令、端口与 `--port` 不一致都在**动文件系统之前**失败，
     不留孤儿版本目录。缺口令这条是**安全项**：安装脚本在非交互环境下会
     `read` 失败 → 静默退回默认口令 `123456`（共享内网下等于没有）。
  5. **健康检查是唯一门禁**：安装脚本自己只"等一下然后打印警告"，就绪与否不进退出码。
  6. **失败不谎报**：远端失败 → 本地退出码非 0 且不打印"上线成功"；
     成功时不因为"没有可回滚目录"而返回 1（首次部署就是这个情况）。

- 为什么**不**用服务器侧 `git pull` 或 CI（评测过，代价摆出来）：

  | 做法 | 服务器需要 | 不选的理由 |
  |---|---|---|
  | 产物直传（本 ADR） | 只要 Node | —— |
  | 服务器 `git pull` + `npm ci` | Node + npm + git 凭据 | 远端仓库是**私有**的（要 SSH key/token）；`node_modules` 不入库，clone 完跑不起来；门禁要 devDependencies |
  | 裸仓库 + `post-receive` 自动部署 | 同上 | 服务器从"哑终端"变成"半台开发机"，且部署入口从"人在键盘前"变成"一把能 SSH 的密钥"（安全面扩大） |
  | CI runner（Gitea/GitLab） | 一台常开 runner + 内网 npm 镜像 | 2~5 人、单个 130 KB 产物，维护成本大于收益；等人多了或目标机变多再上，届时**构建定义不用改**（同一份 `build-server-bundle.sh`） |

- 顺带修掉的真 bug（**已发布的安装脚本**里的）：`launchctl bootout` 是异步的，
  紧接着 `bootstrap` 同一个 label 会失败（launchd 还没摘干净），而旧实现把 bootstrap 的
  错误 `2>/dev/null` 吞掉、退回 `launchctl load -w`，`load` 又常把 job 装进别的域 ——
  结果是**脚本报"已装载"、`launchctl print` 查不到、node 根本没跑**。
  人工双击两次之间隔几秒所以从没暴露；脚本化（毫秒级连续）**必然**踩中，实测表现为
  「成功一次、失败一次」交替。修法：bootout 后轮询等 job 真的消失（≤5 s）→ bootstrap
  失败重试 10 次 → 仍失败则校验 `launchctl print` 并把 launchd 原始报错打出来。
  健康检查等待也从 20 s 放宽到 60 s（launchd 对刚失败的 job 有 `ThrottleInterval=10` 退避）。
- 2026-10-15 再部署一次（开发机 → 局域网里另一台 Mac，**这次是真 SSH 真远端**，不是垫片仿真），
  当场踩出四处，都已修：
  - **产物门禁依赖终端 locale**：`build-server-bundle.sh` 用 `tar -tzf` 的文本清单去 `grep -qxF`
    必需条目，而 bsdtar 在**非 UTF-8 locale**（`LC_CTYPE=C`，agent / CI / 没设 LANG 的终端都是这个）
    下会把中文条目名转义成 `\345\256\211…`，于是「启动EasyCharles.command」永远匹配不上——
    **包是对的，门禁报「缺必需条目」**。同一处逻辑的执行位检查（`tar -tvzf | grep -F 中文名`）
    也一样会误报。改法：校验改成**真的解一份到临时目录再按文件系统核对**（`[ -f ]` / `[ -x ]`、
    `find` 出来的名字不转义），顺带还多证明了「这个包确实解得开」。四条负向验证跑过：
    必需条目在清单里能命中、抽掉一个仍报缺、`chmod -x` 仍报缺执行位、塞进 `.data/` 与
    `easy-charles.conf` 仍被禁忌正则拦住 —— **改法没有把门禁改成摆设**。
  - **`EC_ARGS` 体检恒误报**：`remote-deploy.sh` 判的是 `${EC_ARGS:-}`，也就是**它自己进程的环境变量**，
    而它从没 source 过那份配置（取口令/端口用的是子 shell）→ 条件永远为真，每次部署都打一整段
    「EC_ARGS 为空，去把参数带过来」，而实际服务正带着 `--compat-route` 跑着。改读**本次继承的那份
    配置**里的 `EC_ARGS`。这是本 ADR 决策 3 那条结论的反面教材：**体检自己乱喊，真出事时警告就没人看了。**
  - **默认口令只有首次部署会拦**：`--init` 拒绝 `123456`，但继承已有配置时只检查"有没有 `EC_PASSWORD`"，
    于是局域网服务可以带着默认口令一次次"部署成功"（真机现状就是这份）。补了一条**响亮的警告**
    （指出该改哪一份文件），刻意不做硬拦：拦下来会让正在协作的一整组人突然部署失败，
    那是替用户做决定；要不要升级成 `die` 留给用户定。
  - **跨机访问会被开发机自己的代理/VPN 掐断**：服务端在同机 `curl 127.0.0.1` 是 1.3 ms、
    监听 `*:8899`、防火墙关闭，但开发机对 `<内网IP>:8899` 与 `<主机名>.local:8899` 都是 **SYN 无应答超时**，
    而 SSH（22）一直是通的，`ping` 还能通但 RTT 90 ms 量级——典型的 TUN 网卡按端口截走局域网流量。
    结论两条：① 部署链路走 SSH，所以**部署不受影响**；② 日常访问要有绕过本机代理的办法，
    已把 `NO_PROXY=<服务器地址>` 与 `ssh -L 18899:127.0.0.1:<端口> <服务器>` 两条兜底写进
    CLI 的 `EC_UNREACHABLE` 提示（并在 mock CLI 自测里断言提示包含这两条），`README.md` 同步。
- 验收（临时 HOME + 真实 launchd，未影响用户正在跑的 8899）：
  - 首次部署（`--init`，伪终端交互）：生成配置 600、新口令登录 200、**默认口令 123456 登录 401**
  - 连续三次部署（含同一秒内连跑）：全部成功，配置继承、`deploy.log`、incoming 清理、旧版本清理均正常
  - 回滚 `--use`：plist 切回目标目录，健康检查 200
  - 失败路径：坏 sha / 缺口令 / 端口不一致 / 回滚目录不存在 / 远端连不上 / `--init` 无终端 —— 全部非 0 退出、不动在跑的服务、不留孤儿目录
  - 开发机侧脚本用 `ssh`/`scp` 垫片做了全链路仿真（本机没开远程登录，无法用真 SSH）：`~` 展开、`%q` 转义、stdin 投喂、退出码传递、回滚命令生成全部验证
- 影响：新增 `scripts/deploy-to-lan.sh`、`scripts/deploy/remote-deploy.sh`（并入发布包白名单）；
  修 `scripts/deploy/安装后台服务.command`（bootout/bootstrap 竞态）；`DEPLOY.md` 新增 §3C 并补升级坑；
  `README.md` 增一条命令部署；`build-server-bundle.sh` 白名单与产物清单加 `remote-deploy.sh`。
  2026-10-15 那次再部署的四处修正在：`scripts/build-server-bundle.sh`（产物校验改为解包核对）、
  `scripts/deploy/remote-deploy.sh`（`EC_ARGS` 读配置文件、默认口令警告）、
  `server/tools/mock-cli/cli/client.ts`（`EC_UNREACHABLE` 提示补代理/隧道两条兜底）+
  `server/tools/mock-cli/selftest.ts`（断言该提示）、`README.md`（远程工作台访问方式与排查）。

## ADR-025 多返回值：指定某一条 / 按顺序命中 / 拖动排序

- 状态：✅ 已实现（协议 §5.4 与 §0 的 C11；控制台在 Mock 编辑器「返回值」区）
- 背景：Mock 一条接口常常需要**多个返回值**：登录成功 / 密码错误、首页第一屏 / 第二屏、
  列表空态 / 有数据。控制台此前只能编辑**一条** `action.response`，多条返回值只能去
  「规则（JSON）」抽屉里手写 `responses`，且**没有任何 UI 表达**「指定某一条」「按顺序命中」
  ——服务端的 `seqMode`（in-order / loop / once-then-passthrough / random）与指针隔离
  （ADR-004）早就实现了，但控制台一个入口都没有，等于死配置。
- 关键判断：**底座已经有了，只补一个「指定」语义 + 重做返回值区块。**
  不新做一套序列机制，不改数据面的命中路径（`data-plane.ts` 的 `respondMock` 一行未动）。
- 选项（「指定某一条」怎么建模）：
  1. **`action.mode` 新增 `'specific'` + `action.pinIndex`**；
  2. 复用 `seqMode`，新增 `'pinned'` + `pinnedIndex`，把「命中策略」收敛到一个维度；
  3. 不加字段：指定时把选中的那条写进 `action.response`，`responses` 仍保留全量。
- 决策：**方案 1**，理由：
  - **方案 3 直接排除**：`response` 与 `responses` 互为第二真值来源，编辑顺序 / 内容时两边必然
    不同步，是典型的静默失效（ADR-016 边界 1 的同一精神）；
  - 方案 2 语义更统一，但要重写存量 `mode: 'static'` 的解析路径、给旧规则做语义映射，
    收益（少一个维度）不值得这个兼容风险；
  - 方案 1 只增可选字段与一个 `mode` 取值：`responses` 为空时的旧路径**一字未改**，
    存量规则行为逐位不变（F-15/F-16 那类「落盘后救不回来」的风险面没有扩大）。
- 判定顺序（服务端固定，见协议 §5.4）：只看两个开关——`responses` 是否非空、`mode` 是否等于
  `sequence`。非空 + `sequence` 走指针；非空 + 其它（`specific` / `static` / 缺失 / 非法）按
  `pinIndex` 取（缺失或非法 → 第 0 条）；`responses` 为空 → 旧形态 `response`。
- 理由与坑点：
  - **单项仍写旧形态**：只有一条且为「指定」时，控制台写 `mode: 'static' + response`，不写
    `responses`。绝大多数存量规则都是单条，这样保存后 `rules.json` 一字不变，diff 干净，
    与「规则（JSON）」抽屉对照也不会困惑；
  - **拖动排序 = 改数组顺序，没有排序字段**。好处是零新状态；代价是**指针是下标**：
    改序不重置已推进的位置（刻意——重置会打断其他设备正在走的序列），
    需要对齐时用管理面全量重置指针，控制台把这条限制写在界面上；
  - **`pinIndex` 越界一律 clamp**，`responses` 的脏元素读路径丢弃、写路径 400：
    新增的写入口表面必须按 AGENTS.md §4 挡住类型混淆（对象当数组、标量当条目、`"1"` 当数字），
    否则又是一次「毒化 `rules.json`、重启不自愈」；
  - **控制台读到什么就显示什么**：`ruleToDraft` 的 `pinIndex` 只认真正的数字（与服务端
    `clampIndex` 同口径）。这里宽松会导致「界面显示第 ② 条、服务端实际返回第 ① 条」的静默不一致；
  - **`name` 只是备注**：不参与匹配、不下发；控制台不写空 `name`，避免规则里多出噪音字段；
  - **拖动用手写 HTML5 DnD，零依赖**（不引 sortable 库，符合「前端零框架」）；
    dragover 期间**不重绘列表**（重绘会让被拖节点消失、DnD 直接取消），只在 drop 时换序；
    另给 `↑`/`↓` 按钮兜底键盘与触屏；
  - **换序 / 增删后 `sel` 与 `pinIndex` 跟着条目走**（按旧→新下标重映射），否则会出现
    「拖完在编辑另一条」这种极难察觉的错位。这条已被 `tools/console-mock-check.mjs` 覆盖。
- 补充决策（2026-10-11，用户反馈后定）：**命中方式的改动立即落库**，不需要再点「保存并生效」，
  并且「按顺序」的默认子模式改为**循环返回**。理由与两个必须守住的坑：
  - 命中方式是**开关式**操作（改完就想看效果），与列表里的「开 / 关」同类；而正文 / 状态码这类
    **内容编辑**仍然只在显式保存时落库——两者性质不同，不统一成「全都自动保存」；
  - **只对已落库的规则自动保存**：新草稿连 `match` 都还没填，自动保存必然被闸门拦下；
    而且用户可能只是随手点一下控件看看。那一步仍走显式保存，不会凭空建规则；
    （ADR-035 之后：点「Mock 此接口」的新规则**当场就落库**了，未保存草稿只在自动保存失败时出现，
    所以这条限制现在几乎不会触发；命中方式的自动落库逻辑本身不变）
  - **不复用 `saveDraft()`**：它在保存后会用 `ruleToDraft(落库结果)` **重建整个草稿**，
    连点几次时会把后一次点击的改动冲掉（先发的那次先返回、把草稿写回旧值）。自动落库只把
    `pick` / `pinIndex` 写回该条规则；多次 PUT 串行成链，保证**后发的那次最后落地**——
    服务端是全量替换，乱序到达就会被旧的那次覆盖；
  - **UI 重绘与落库分开**：`renderMockEditor()` 留在**同步**路径（子模式下拉、圆点选中态立刻跟上），
    落库走异步。把重绘一起挪进异步会让下拉晚一拍出现（实测 `md-seqmode` 取不到，直接 TypeError）；
  - **默认值只作用于「用户新选」那一下**：`ruleToDraft()` 读存量规则时，`mode: 'sequence'` 却缺
    `seqMode` **必须仍按服务端的 `in-order` 显示**。若让 UI 默认值（循环）渗进读路径，就会出现
    「界面显示循环、服务端实际停在最后一条」——与本 ADR 上面那条 `pinIndex` 同类的静默不一致。
    实现上把这条默认值抽成纯函数 `nextSeqPick()` / 常量 `DEFAULT_SEQ_PICK`，由 `[F-28]` 直接断言；
  - 顺带修掉一个既有小毛病：保存后 `sel` 停在原来编辑的那条（此前每次保存都跳回第 1 条）。
- 影响：协议 §0（C11）、§4.7（PUT 校验）、§5.4（schema 与选择语义）；
  `server/src/types.ts`（`MockResponse.name` / `mode: 'specific'` / `pinIndex`）、
  `server/src/rules.ts`（`responseList` / `clampIndex` / `pickResponse` / `replaceAll` 校验）、
  `server/tools/selftest.ts`（`[F-27]` + 调起 `[F-28]`）；
  控制台 `server/web/index.html`（草稿模型改成 `responses[] + pick + pinIndex + sel`、
  返回值列表与拖动排序、命中方式、备注名、追加真实响应、放大编辑适配选中条目）；
  新增 `server/tools/console-mock-check.mjs`（把 index.html 里的纯逻辑切出来跑，补齐零构建单页的回归）。
- 明确不做：单规则重置指针接口（用现有的全局重置）、每条独立的 `delayMs`
  （会让「响应延迟」与「响应内容」耦合）、按设备 / 按账号的独立序列（ADR-004 的扩展位，按需再做）。

## ADR-026 Mock 编辑器的匹配条件只读（METHOD / HOST / PATH）

- 状态：✅ 已实现（纯控制台 UI 约束，协议与服务端零改动）
- 背景：Mock 编辑器里 METHOD / HOST / PATH 三项是可编辑文本框（外加 glob / `re:` 支持）。
  实际使用中它们几乎总是「从记录带过来的那三个值」，但手改一次就会出两类静默问题：
  - **规则和记录不再对应**：改了 path / 掉了一个端口（`api.foo.com` 忘了 `:443`），
    规则看着像在 mock 这条接口，实际永远命中不了，最有代表性的坑就是 ADR-016 记下的
    「host 必须带端口」；
  - **「Mock 此接口」的去重失效**：浏览页按 method + host + path 找已有规则
    （`findRuleForRecord()`）来决定按钮是否置灰，改过 path 的规则查不出来，
    于是同一接口可以 mock 出好几条互相遮蔽（priority 决定谁赢）的规则，且全程不报错。
- 选项：
  1. **保持可编辑**，靠提示语提醒「host 要带端口」；
  2. **编辑器里三项只读**，草稿只从记录（`draftFromRecord()`）/ 存量规则（`ruleToDraft()`）取值；
  3. **不加锁，改成保存时校验**：host 与记录不一致 / path 与记录不一致就拒绝保存。
- 决策：**方案 2**，理由：
  - 方案 1 已经把提示写在了 placeholder 上，仍然出问题——提示挡不住手快，属于已验证无效；
  - 方案 3 要引入「记录 ⇄ 规则」的比对状态，而规则本来就可以合法地跟记录不一样
    （glob / 正则通配、手写规则、记录已被环形缓冲淘汰），校验必然误伤，还得定义一堆例外；
  - 方案 2 不新增任何状态：草稿的匹配条件本来就只有这两个来源，锁上只删掉一条写入路径
    （`bindMockEditor()` 里 `md-method` / `md-host` / `md-path` 三个 input 分支），
    是「减少真值来源」而不是「新增校验」。
- 理由与坑点：
  - **高级匹配仍然可用**：glob / `re:` 通配、只匹配路径不匹配域名等写法一律走右上角
    「规则（JSON）」抽屉——那里是刻意的唯一手写入口（同 ADR-016 的既有边界），
    所以这次锁的是「编辑器拖拽式编辑」，不是「规则能力」；
  - **用 `readonly` 而不是 `disabled`**：readonly 保留选中 / 复制（排查时要把 host 贴给别人），
    也不会被浏览器灰到看不清；`disabled` 还会让值在表单语义上消失，这里没有必要；
  - **不做条件性解锁**（例如「草稿来自记录才锁」）：存量规则（`d.source` 为空）同样不该手改匹配条件，
    两套行为只会让人以为「有的能改有的不能改」；
  - **空值仍要能表达**：存量规则可以不带 `method`（通配），此时输入框显示 placeholder「任意方法」，
    `draftToRule()` 依旧「为空就不写该字段」，协议语义不变；
  - **不影响已落库规则**：`ruleToDraft()` / `draftToRule()` 的往返一字未动，
    保存仍然写全量 `match`（含从记录带过来的 method / host / path）。
  - **只读的展示形态后来又压成一行**（2026-10-11，同一决策下的 UI 收敛）：原先三个 `readonly`
    输入框在编辑器里占掉三行，又一直长得像「可以填」，实际没人去填。改成一行只读摘要
    `matchLine()`（`GET · api.foo.com:443 · /api/user`，空值显示「任意方法 / 任意域名 / 任意路径」）。
    「不可编辑」「值可选中复制」「host 显式可见（带端口那个坑照旧看得见）」三点都没变；
    `lockMatchInput()` 与 `input.match-lock` 样式随之删除 —— 没有可编辑控件，就不需要「锁」的样子了。
- 影响：控制台 `server/web/index.html`（匹配条件改为一行的只读摘要 `matchLine()` +
  `bindMockEditor()` 去掉三个 input 分支）、`README.md`（Mock 模式一节写明只读与手写入口）、
  `docs/roadmap.md`（P1 控制台增强记录一条）。协议 / 服务端 / SDK **零改动**：
  规则 JSON 的形态与命中语义完全不变。

## ADR-027 mock CLI：只走管理面、口令不落盘、未实现如实报错

- 状态：🆕 已定（P0 外壳 + P1 读/开关/删除 + P2 写路径 + P3 分组模型已实现并自测通过；OpenAPI 源在 P4）
- 背景：项目要一个给 **AI agent** 调用的命令行（`mock …`）来操作 Mock。需求方给了一份
  现成 mock 工具的命令面约定（六组命令 + 并行数组更新），本次按这套约定在 EasyCharles 上
  实现等价能力——**只对齐命令形态，不搬它的协议常量、不依赖它运行**。两个约束直接决定形态：
  - agent 调用的目标**可能是远程服务实例**（同事机器 / 内网服务器上跑的 EasyCharles），
    不是只有本机；
  - AGENTS.md §2 禁止新增顶层目录、禁止新增运行时依赖。
- skill 词汇 ⇄ EasyCharles 实体的映射（这份映射就是 CLI 的对外契约）：

  | skill 里的概念 | 落到本项目 | 状态 |
  |---|---|---|
  | project | **一个服务实例**（`baseUrl` + 会话），不是租户下的项目 | ✅ P0 |
  | group | 服务端分组模型（`Rule.groupId` + `Group` + 整组开关） | ✅ P3（服务端 + CLI 已实现、本机自测全绿，**远端待验**；控制台 UI 不在本期，见 ADR-030） |
  | api | `Rule`（`match` method/host/path/params + `action`） | ✅ 读/开关/删除（P1）· ✅ 写（P2，见 ADR-028） |
  | 四条并行数组（`--json-list` / `--response-group-*`） | `action.responses[]` 的批量写法 | ✅ P2 |
  | f2e 接口文档 | **通用 OpenAPI 文档源**（不再依赖任何内部平台） | 📅 P4 |
  | device / request | `/__ec/api/devices` / `/__ec/api/records` | ✅ P1 |
- 选项与决策：
  1. **打哪个面**：①复用数据面做一层 CLI 网关 ②**只走管理面 `/__ec/api/*`**。
     选 **②**。数据面按 ADR-015 是刻意不鉴权的转发通道，无状态、也不该长业务逻辑（AGENTS.md §3）；
     CLI 要的是「读回校验 + 改名 + 整组开关」这类有状态操作，天然属于管理面。
     代价是 CLI  inherits 管理面的 1 MiB body 上限（`index.ts` 的 `readJson`）——
     大 jsonList 必须走「脚本生成参数 / 临时文件」，与 skill 文档的告诫一致；
  2. **group 放哪**：①CLI 端把规则打散模拟 ②**服务端加分组模型**，`group.enabled` 由
     `RuleEngine.resolve()` 过滤。选 **②**。①会让「整组关掉」出现第二个真值来源
     （CLI 记忆 vs 规则上的 enabled），多端并发必然漂移；真值只能有一份，落在服务端；
  3. **凭据怎么存**：①口令也写进配置文件 ②**只存 session token，口令每次从
     `--password` / `EC_MOCK_PASSWORD` / `--password-stdin` 来**。选 **②**。
     把口令长期留在 `~/.mock-cli/config.json` 等于在本机复制一份可横向使用的凭据，
     而 CLI 的默认使用方是 agent（它的 shell 历史 / 日志不受本项目控制）；
     token 8 小时过期，失效时带得上凭据就自动重新登录，带不上报 `EC_UNAUTHORIZED` 并提示；
  4. **未实现的命令怎么办**：①先不注册 ②**注册并如实返回 `EC_NOT_IMPLEMENTED`（退出码 64）
     + 计划阶段 + 当前可用的替代做法**。选 **②**。agent 读到「命令不存在」会自行猜测编造做法，
     读到明确的「未实现 + 替代方案」才会停下来——这正是 AGENTS.md §9「状态不要撒谎」在 CLI 上的形态；
  5. **f2e 那一族命令**：本项目**不依赖任何内部平台**，改为通用 **OpenAPI 文档源**（P4），
     仓库里不出现任何具体客户端的内网协议常量（与兼容层 ADR-015 参数化同一精神）。
- 理由与坑点：
  - **并行数组是这套 CLI 最大的坑**，四条数组按下标一一对应，长度错一位就把返回值挂到错误的命中条件上，
    而且服务端不会报错。因此 P2 的两条硬约束已经定死：**每个数组各自重复传参**（绝不把整个 JSON 数组
    当一个参数传，否则平台存下的是一个字符串元素）、**写完必须读回核对四条长度**；
  - **`--config` 曾被静默忽略**：P0 实现里所有验证都写进了真实的 `~/.mock-cli/config.json`。
    这类「参数没生效但不报错」的坑，靠自测里**强制注入隔离 config 路径**来兜住，
    并在 `version` 输出里把当前 `configPath` 打出来，让调用方看得见；
  - **CLI 代码在默认 tsconfig 的 `include` 之外**，等于零类型检查。补了
    `server/tsconfig.cli.json`（与主配置同选项，只是 include 换成 `tools/mock-cli/**`），
    两个配置都要跑；
  - **非交互不得挂起**：agent 的 stdin 不是 TTY，任何交互式选择 / 确认都会把整个任务卡死。
    破坏性操作缺 `--yes` 直接 `EC_USAGE` 退出；上下文一律用 `--project-id` / `--group-id` 显式给；
  - **控制台的 `draftToRule()` 会重建规则对象**，服务端无损保留的未知字段（未来的 `groupId`、
    每条返回值的命中条件 `cond`）会被它在下次保存时**默默抹掉**。这一处已在 P2 修掉
    （草稿携带读进来的原样副本，保存时只覆盖编辑器管的键），否则 P3 的 `groupId`
    会被控制台的一次保存清空；配套断言在 `tools/console-mock-check.mjs`；
  - **`--password` 会出现在进程列表与 shell 历史里**，交互式提示也做不到掩码输入
    （零依赖，不引第三方库）。`help` 里明确引导脚本改用 `--password-stdin` / 环境变量，
    并把这条限制如实写在文档里；
  - **读路径也要当脏数据处理**（P1 补的 `cli/guards.ts`）：管理面下发的东西同样可能是坏的——
    `rules.json` 可被手改成「条目不是对象 / id 是数字」，记录里有 `request.url` 缺失的条目。
    口径统一为**结构错就 `EC_BAD_RESPONSE`，条目脏就丢掉并计数**，计数如实回传（`dropped` 字段 +
    人类模式一行提示）。静默少几条会让 agent 拿着残缺列表去改配置，比报错更糟；
  - **服务端 `bindDevice` 不校验设备当前归属**（`store.ts` 直接写 bindings 表）：普通用户看不见
    他人设备所以撞不到，**管理员可以把别人空间的设备静默绑走**。P1 的防线做在 CLI 侧
    （可见性守卫 + `--force` + `--yes` + 绑定后读回核对 owner）；
    服务端侧要不要补一道校验是独立议题，**动之前先问**，不在 CLI 任务里顺手改；
  - **人类模式的表格宽度按码点算会排歪**：设备名 / 规则名 / 域名常是中文，`padEnd` 数码点而
    终端按列渲染，于是整列错位。同时 `mock … | head -1` 这类下游提前关闭会让进程甩 EPIPE 栈
    并以非 0 退出——对 agent 来说「成功但输出被截断」长得像「命令崩了」。两处都在 `output.ts`
    收口（`displayWidth` 补齐 + `installPipeGuard` 把 EPIPE 当正常退出）；
- 影响：新增 `server/tools/mock-cli/`（入口 `mock.ts` + `cli/{args,config,client,errors,output,guards}.ts` +
  `cli/commands/{auth,context,api,device,request}.ts` + `cli/responses.ts`）、
  `server/tools/mock-cli/selftest.ts`（**266 条断言**，含脏数据与端到端）、`server/tsconfig.cli.json`；
  `docs/roadmap.md` 新增 P6 段；`README.md` 增加 mock CLI 一节。
  P0/P1 对服务端与协议**零改动**（只用既有管理面接口）；P2 带来的服务端与协议改动见 **ADR-028**。
- 明确不做：CLI 侧模拟分组（见决策 2）、把任何内部平台的协议常量搬进仓库、
  Swift / ArkTS 代码生成（属于 P4 之后的独立议题，且不在 Android/Harmony 抓包链路上）、
  多租户 scope（EasyCharles 的用户空间由手机号 + 设备绑定决定，不引入第二个隔离维度）。

---

## ADR-028 单条规则写端点 + 三方「保存无损」约定（mock CLI 的 P2）

- 状态：🆕 已定（服务端 / CLI / 控制台三面已实现并自测通过）
- 背景：ADR-027 定了 CLI 只走管理面。P1 做完读、开关、删除之后，`api create/update/copy`
  撞上两个硬问题：
  - 管理面只有 `PUT /__ec/api/rules`（**整表替换**）这一个写入口。agent 的「读改写」
    要先把全部规则读进上下文、改一条、再把整表写回去——一次误操作就把别人同时改的规则
    整片覆盖掉，这正是 ADR-019 登记过的那类事故，而且规则越多越贵（body 直接烧上下文）；
  - 服务端虽然无损保留未知字段，**控制台却不无损**：`draftToRule()` 每次保存都在重建规则对象，
    CLI 写进去的 `responses[].cond`（以及 P3 要加的 `groupId`）会被控制台一次「只想改正文」
    的保存静默清空。两个写者互相抹掉对方的配置，双方都看不出发生过。
- 选项与决策：
  1. **写入口**：①CLI 继续整表 PUT，靠「先读后写 + 写后核对全部」兜底 ②服务端加
     `POST /__ec/api/rules`（新建，id 服务端生成）与 `PUT /__ec/api/rules/:id`（整条替换）。
     选 **②**。①的正确性依赖「读与写之间没有别人动过」这个前提，而这个前提在多端并发下
     根本不成立；把爆炸半径从「整表」缩到「一条」是唯一稳的做法。
  2. **id 归谁**：**服务端**。`create` 收到带非空 id 的请求直接 400，`PUT /:id` 以路径里的 id
     为权威（body 缺 id 就补齐，id 不一致就 400）。否则「新建」可以伪装成「覆盖别人」。
  3. **新端点的校验强度**：**与整表 PUT 共用同一个 `validateRuleShape`**，并直接在
     `tools/selftest.ts` 里补脏输入用例（AGENTS.md §4）。新开一个写入口最容易犯的错，
     就是只给老门装栅栏。
  4. **返回值命中条件（`responses[].cond`）本期存不存**：**存，但不选路**。协议的
     `match.params` 是**规则级**的，且 query + body 合并（同名 body 优先），服务端现在
     没有「按每条返回值的条件选一条」的能力。先原样存下保证往返不失真，真正的逐条选路留给 P4；
     `protocol.md` §5.4 与本 ADR 都写明「本期只存不用」，避免读代码的人以为它已经生效。
  5. **存储形态**：CLI **完全对齐控制台**已有的两态（1 条 + 指定 = `{mode:'static', response}`，
     多条 = `{mode:'specific'|'sequence', responses, …}`），而不是统一都用 `responses` 数组。
     理由：形态不一致就是双向的静默失效——服务端 `pickResponse` 优先读 `responses`，
     残留的旧数组会盖住刚写进去的 `response`。换形态时**必须删掉另一形态的字段**，
     三面都按这条写。
- 理由与坑点：
  - **无损必须三面同时成立**，少一面就是静默丢配置：CLI 规则级 `{...current}` 打底、
    CLI 条目级以服务端那份打底、控制台草稿携带 `_raw/_rawMatch/_rawAction`。
    断言分别落在 `tools/mock-cli/selftest.ts`（现场塞 `groupId` / `latencyHint` / `cond` 后改 body）
    与 `tools/console-mock-check.mjs`（同一条规则往返后逐字段比对）；
  - **`--json-list A B C` 这种「空格连写」会静默丢数据**：解析器只把 A 当成 flag 的值，
    B / C 落进 positional，而 `api create` 不收位置参数 → CLI 报成功、服务端只存 1 条。
    新增 `rejectExtraPositionals`：每条 `api` 子命令明确自己收几个位置参数，多出来就退出码 2，
    并在 hint 里给可照抄的「每项各自重复 flag」写法。**flag 名与展示 label 也要分开存**——
    上一轮就是把带 `--` 的 label 当成了 flag 名去查，四条数组全读成「没给」；
  - **PUT 是整条替换，所以 `enabled` 必须显式写**：协议里缺省（falsy）就是「不生效」，
    读改写时若沿用「没给就不动」的直觉，会把一条开着的规则改成关掉；
  - **读改写之间有时间窗**，服务端没有版本号 / `If-Match`，这一拍里另一方改过同一条仍会互相覆盖。
    本期接受这个限制并在 roadmap 登记；根治要服务端加乐观锁，那是独立议题；
  - **写命令的校验必须全部前置**：`update` 原先边改边校验，非法 `--mode` 会让前面已改的字段
    落成半态。现在是「先把整条算完 → 再一次 PUT → 再独立读回逐字段比对」，
    失败时服务端一个字节都没变，这条由自测用例断言（不是断言「大概率没写」）。
- 影响：服务端 `src/rules.ts`（`validateRuleShape` / `freshId` / `create` / `replaceOne`）、
  `src/index.ts`（`POST /__ec/api/rules`、`PUT /__ec/api/rules/:id`）、
  `src/types.ts`（`MockResponse.name?` / `.cond?`）；
  `docs/protocol.md` C12 两行 + §5.4 的 `cond` 存储位；
  CLI 新增 `cli/responses.ts` 与 `api create/update/copy`、`cli/args.ts` 加 `rejectExtraPositionals`；
  控制台 `web/index.html` 的 `clonePlain` / `respItemFromMock` / `respItemToMock` / `ruleToDraft` / `draftToRule`；
  自测 `tools/selftest.ts` 新增 F-29（22 条）、`tools/console-mock-check.mjs` 新增无损往返（22 条）、
  `tools/mock-cli/selftest.ts` 新增 C-11（写路径端到端）。
  控制台分组 UI 仍不在本期（D4：P3 只要求「保存不丢未知字段」，这条已完成）。
- 明确不做：服务端按 `cond` 逐条选路（P4）、`--json-list` 的 JSON 重排版（原样存储才谈得上逐字节比对）、
  CLI 侧的整表备份/回滚（有了单条端点就不再需要，且会把风险引回整表）、
  控制台的分组界面（P3 另议）。

---

## ADR-029 浏览器登录接力：会话只走 127.0.0.1，服务端一个端点都不加

- 状态：✅ 已定并已验收（CLI / 控制台 / 自测三面实现；真实浏览器里登录 → 点「允许」→ CLI 拿到会话
  → `api create` 写成功这条已跑通，「拒绝」→ CLI 立刻 `EC_LOGIN_DENIED` 也跑通。
  剩下的「远端实例上由使用者本人点一次允许」还没有真人验过，见 roadmap 的登记）
- 背景：ADR-027 的 D3 定了「口令不落盘，只存 8 小时 token」。它的代价随之暴露：
  会话一过期，人就得再把口令敲一遍；而人用 CLI 时最自然的登录方式其实是
  「**我已经在浏览器里登录了控制台**」——这条反而没有通道，`mock login` 只认
  `--password` / `EC_MOCK_PASSWORD` / `--password-stdin` 三条口令来源。
  目标是把「浏览器里已有的会话」交给 CLI，且**不能**为此把管理面变成一个能凭空造出登录态的地方。
- 选项与决策：
  1. **会话怎么到 CLI**：①服务端加一个「nonce 换会话」的端点，CLI 轮询 ②CLI 在本机
     `127.0.0.1` 起一次性监听，页面把会话 POST 回来。选 **②**。
     ①看着省事，实际是在管理面新开一个**无需凭据就能换到等价登录态**的入口——
     nonce 会出现在 URL、Referer、服务端访问记录和沿途代理日志里，
     等于把一个「拿到就能用」的接口挂在所有人看得见的位置，这正是 AGENTS.md §3 要防的形态。
     ②里会话只在「浏览器 → 本机回环」之间流动，不经过服务端，也不落到任何日志。
  2. **nonce 放 URL 的哪一段**：**`#hash`**（`<控制台地址>#cli-login?port=<n>&state=<48 位 hex>`）。
     hash 不会随请求发到服务端，也就不进访问记录；顺带用 `history.replaceState` 把它从地址栏清掉。
  3. **要不要人点一次「允许」**：**要，这是硬要求**。没有这一步，任何一个本地进程
     只要诱导你打开 `<控制台地址>#cli-login?port=<它的端口>`，就能静默拿走你的会话 token。
     确认框就是这个流程的 consent screen，把「服务地址 / 会话属于谁 / 角色 / 回传地址」摊开给人看，
     不能省、也不能默认同意。
  4. **拿到会话后直接信吗**：**不**。先 `GET /__ec/api/me` 向服务端核实，认了才落盘；
     手机号与角色**一律取服务端的**，页面自报的 `phone` / `role` 只是显示用，形状不对就丢弃。
     这样「页面撒谎说自己是 admin」在结果里没有着力点。
  5. **点「拒绝」要不要通知 CLI**：**要**。第一版只隐藏确认框，让 CLI 干等到超时——
     那既浪费人时间，又把「你明确拒绝了」和「没人理你」混成同一个 `EC_LOGIN_TIMEOUT`。
     现在拒绝也回一条 `{ state, denied: true }`（**只有这两个字段**，由 console-mock-check 机械守住
     「拒绝载荷里不许出现会话」），CLI 立刻以 `EC_LOGIN_DENIED` 结束。
     `denied` 必须是布尔 `true`、`state` 必须全等，所以第三方拿这个形状也**替不了你拒绝**
     （nonce 不匹配就是 400，登录照常继续）。
  6. **要不要做成默认登录方式**：**不做默认**，只认显式 `--browser`。
     「没给口令就自动开浏览器」在 AI agent / CI 里没有终端也没有 GUI，等于让命令永远挂在那儿；
     同理 `--browser` 与任何口令来源同时出现是**用法错误**（退出码 2），而不是静默优先其一。
- 理由与坑点：
  - **口令全程不经 CLI 的手**：这条路的产物只有 token，与 D3 一致；配置文件仍然只有会话，
    自测里直接读落盘文本断言「没有口令」。
  - **一次性监听**：成功即 `close()` 并 `closeAllConnections()`——不强制断开的话，
    浏览器留下的 keep-alive 连接会让 CLI 拿到会话之后继续挂着几十秒不退出。
    成功后同一端口再投递拿到 410（`EC_STALE_REQUEST`），会话不是「一次登录、长期可取」。
  - **Origin 逐字符比对**：不一致立刻失败（`EC_ORIGIN_MISMATCH`，退出码 3），报错里同时打印两个地址。
    别名 / 端口不同造成的「登录成功但连的是另一个实例」是最难自查的一类，
    **绝不静默换端口或放宽比对**。
  - **入口要扛脏数据**（AGENTS.md §4）：body 上限 8 KiB、尝试次数上限 8 次（超过整轮取消）、
    缺 `Origin` 直接 403、非回调路径 404 且**不烧尝试次数**（favicon 之类的噪音不能让登录失败）、
    非 JSON / 数组 / 嵌套错乱一律 400 并继续等下一条，监听内的任何异常都不外溢成栈。
  - **形状检查不承担鉴权**：`/^[0-9a-f]{16,128}$/` 能放过 31 位 hex 的伪造 token，
    拦住它的是服务端 `/me` 那一次核实（自测专门断言这一点，免得后人以为正则就是安全边界）。
  - **浏览器侧的跨源细节**：页面 POST 用 `content-type: text/plain;charset=UTF-8`（CORS「简单类型」，
    不发预检）；页面挂在 https 反代下时 Chrome 的私有网络访问会先发 `OPTIONS` 预检，
    监听器按需回 `access-control-allow-private-network: true`。
  - **有明确的不适用场景**：浏览器和 CLI 不在同一台机器时回环送不到，
    超时提示里直接给出替代做法（`printf 口令 | mock login --password-stdin`），不静默退化。
  - **页面必须随部署走**：远端还是旧版本时页面里没有这段接力，症状是「等 180 秒超时」，
    所以超时提示的第 ③ 条就写「服务端是旧版本、重新部署一次」。
- 影响：CLI 新增 `cli/browser-login.ts`（监听 / nonce / 载荷校验 / 开浏览器），
  `cli/commands/auth.ts` 加 `--browser` / `--no-open` / `--callback-port` / `--timeout` 与口令互斥守卫、
  `login` 成功后走 `/me` 核实，`mock.ts` 的 login 用法与错误码；
  控制台 `web/index.html` 的 `parseCliLogin` / `cliCallbackEndpoint` / `cliLoginPayload` /
  `cliDenyPayload` / `cliConsentRows` + 确认框 DOM（**未新增任何服务端端点**）；
  `docs/protocol.md` 管理面补一句「本能力不引入端点」；
  自测 `tools/mock-cli/selftest.ts` C-07（40 条，含伪造 token / 脏投递 / 端口占用 / 冒名拒绝 /
  8 组用法错误）、`tools/console-mock-check.mjs` 新增接力纯逻辑（含「回传字段集恰好 4 个」
  「拒绝载荷只有 state + denied」两条机械守卫）。
- 明确不做：服务端加 nonce / token 交换端点；会话经 URL query 或服务端中转；
  无人确认的静默接力；把 `--browser` 做成默认或失败后自动降级；
  为接力引入任何运行时依赖（监听、nonce、开浏览器全用 Node 与系统命令）。

---

## ADR-030 分组模型：只补最上面一层，「模块」就是 Rule

- 状态：✅ 已实现（服务端 + CLI，本机门禁全绿：`tools/selftest.ts` F-30 / `tools/mock-cli/selftest.ts` C-12；
  **远端实例待验**，控制台分组 UI 按 D4 不在本期）。
  **归属维度另见 ADR-033**：本条把分组定为「全局共享、无用户归属」，该定性已被修订为
  `private` / `shared` 两档。✅ **修订已在阶段 B（2026-10-16）落到服务端**，
  所以本条描述的「全局分组」现在只适用于**共享项目**这一档（全体可见、永不命中）；
  私有项目参与命中且他人不可见，本条的「无用户归属」不再成立。
  本条其余结论（三层结构、不新增 `Module`、组开关只 AND 进命中、指针不因关组而重置）**继续有效**
- 背景：使用者要的是三层结构——**分组 → 模块 → 每个模块一组 mock 列表**。盘完现状发现
  只有最上面一层是缺的：「模块」对应既有的 `Rule`（`match` 定位一个接口），
  「一组 mock 列表」对应既有的 `action.responses[]`（`name` / `cond` / 多条状态码 / 顺序命中，ADR-025）。
  ADR-027 的 D2 早就定了「group 放服务端，不在 CLI 端模拟」，roadmap 把它排为 P6-P3，
  且 ADR-028 特意把「三面保存无损」做完（自测里现场塞 `groupId` 断言它不被控制台一次保存抹掉），
  **当时的目的就是给这一天用**。所以现在做这件事不需要动数据面、不需要动 SDK、不需要迁存量规则。
- 关键判断：**不要为「模块」再造一个实体。**
- 选项与决策：
  1. **「模块」要不要成为独立实体**：①新增 `Module`，`Group → Module → Rule` 三层；
     ②**「模块」= `Rule`，只新增 `Group`**。选 **②**。`Rule` 已经在承担「一个接口 + 它的一组返回值」，
     再加一层 `Module` 就是同义双表：同一个接口能在 Module 里、也能挂在 Group 下，
     「谁才是真值」立刻变成第二个 ADR-016 边界 1 那类问题（而且是**必然漂移**的那类，
     因为两张表都可写）。代价：如果将来真要做「一个模块跨多个接口」，那是新语义、要新 ADR，
     但那时的正确形态大概也还是 `Group`（收纳）+ `Rule`（接口），中间层用命名约定或标签表达。
  2. **整组开关要不要联动改写组内规则的 `enabled`**：**不联动**，`resolve()` 里做
     `rule.enabled && (无 groupId || 组存在且 enabled)` 这一条 AND。联动的做法（关组时把每条规则
     写成 `false`）会毁掉「这条规则本来就是手动关掉的」这个信息，重开组时把它们全部打开——
     那是破坏用户状态，不是提供便利。两个字段各回答一个问题，就是单一真值来源，不是双真值。
  3. **`groupId` 的存在性校验放哪**：①服务端写入口也校验（指向不存在的组 → 400）
     ②**服务端只校验类型，存在性校验做在 CLI**。选 **②**，两个理由：
     - `rules.ts` 的 `validateRuleShape` 有一条写明的既有边界——「校验范围只到**结构**，
       不做取值范围与语义校验」（数字越界由读路径 clamp、语义归控制台与协议负责）。
       引用完整性是语义，开这个口子等于让三个写入口各自再长出一张依赖表；
     - 更要紧的是**悬空引用的读路径口径**。若服务端拒绝，悬空 `groupId` 就只可能来自手改文件；
       此时若数据面按「不命中」处理，就会出现「控制台明明显示这条规则已启用，它却什么都不 mock」
       ——AGENTS.md §5 定义的最难查的那类静默失效。所以定成**按未分组处理（照常命中）**，
       并在 CLI 侧先读分组表核对存在性。**代价如实登记**：绕过 CLI 直接打管理面仍写得进悬空 id
       （与 `bindDevice` 归属校验只在 CLI 侧同一类已知限制，roadmap 记 🚩）。
  4. **删除分组时组内规则怎么办**：**保留、自动脱组**（清空 `groupId`），并回 `ungrouped` 计数。
     级联删除的语义最直觉，但误删一个组 = 不可逆地清掉几十条 mock，而这件事在 CLI 里
     只需要一个 `--yes`；「非空则拒绝删除」最保守，却把 agent 批量清场卡死。
     ——*本条的适用范围后由 **ADR-033** 决策 6 收窄：只适用于 shared / 全局项目。
     私有项目删除**必须级联处置**其规则——那时「脱组」等于规则失去 owner，
     在新数据面口径下永远命中不了，是本 ADR 反对过的那类静默失效*。
  5. **要不要 `group disable-all`**（skill 原命令面里的这条）：**不做**。它与 `group.enabled`
     是同一件事的两个真值来源（逐条写 `rule.enabled=false` vs 改一个组字段），
     两者并存必然漂移。`mock group` 里保留注册但如实报 64 并指向 `group switch --off`（D4 的纪律）。
- 理由与坑点：
  - **`groupId` 从「未知字段」升格为「有语义字段」是本次最容易出事的地方**：ADR-028 之前它靠
    「未知字段无损保留」活着，三套自测都拿它当**扩展字段的示例**（`tools/selftest.ts`、
    `tools/mock-cli/selftest.ts` 里的 `groupId: 'g_pay'`）。一旦服务端开始按它过滤命中，
    这些夹具就从「验证无损」变成「验证一条不存在的分组能让规则失效」。
    处理：夹具改用真正未知的字段（`latencyHint` 等）继续测无损，`groupId` 的用例改走真实分组。
    **这类"占位字段变成真字段"的迁移必须逐个核对，不能只加不查**；
  - **`groups.json` 独立成文件**，不改 `rules.json` 的数组形状：ADR-028 的读回校验是**逐字节比对**，
    文件结构一变，那套断言就得整片重写，而且手改坏 `rules.json` 的既有兜底路径会失配；
  - **关组不重置顺序指针**：指针是 `(deviceId, ruleId)` 的下标状态（ADR-004）。
    关组再开，那条正在走序列的设备会从它原本的位置继续——打断它才是意外行为；
  - **`enabled` 只接受布尔**，与规则同口径（`0/1` / `"true"` → 400）：写入口在 LAN 下任何持有会话的
    客户端都能打，宽松强转等于让调用方定义「什么算开」（AGENTS.md §4）；
  - **id 由服务端生成、调用方给非空 id 直接 400**，与 `RuleEngine.create` 完全同一条规则，
    连 `freshId` 的碰撞检查理由都一样（批量 + 脚本场景必须查，人手点按钮撞不上）；
  - **`name` 不要求唯一**：撞名在真实项目里是常态（每个组都想叫「登录」），
    一切定位只按 id；CLI 的 `--json` 输出里 id 与 name 都给，人类模式表格靠 id 消歧；
  - **控制台不做 UI ≠ 控制台可以不管**：它现在读到带 `groupId` 的规则会**原样保存回去**
    （P2 的无损已保证），但列表里看不出这条属于哪个组、也看不出它被整组关掉了。
    这是可接受的中间态，前提是**如实告诉用户**「分组只在 CLI 生效」——AGENTS.md §9。
    ⚠️ **这句的前提已被 ADR-033 打破**：C14 之后控制台的整页保存仍走全量 PUT，而新写入口要求
    每条规则都必须属于调用者的私有项目。于是**列表只剩自己的私有规则**（升级后为空，旧规则都在共享容器里），
    而**新建的规则没有 `groupId` 可带 → 保存必 `400 EC_SCOPE_MISMATCH`**。
    只有「读进来再原样存回去」的那部分靠 P2 的无损副本机制（`draftToRule()` 以 `_raw` 打底，
    不认识 `groupId` 也会保留）还能工作。
    「控制台先不动也行」这个中间态不再成立，阶段 C 是必须的，不是可选的增强。
    ✅ **阶段 C（2026-10-16）已补齐**：控制台的编辑与保存改成单条写端点 + 私有项目归属，
    整页全量 `PUT /__ec/api/rules` 只剩「原始 JSON」抽屉里的作用域内替换（见架构 §5.3）。
- 影响：`docs/protocol.md` §0（C13）、§4.7（分组五个端点）、§5.4（`groupId` 与命中口径）、
  §5.5（`Group` schema 与读路径防御）；`server/src/types.ts`（`Group` + `Rule.groupId?`）、
  `server/src/groups.ts`（新增 `GroupStore`）、`server/src/rules.ts`（`groupId` 结构校验 +
  `resolve()` 过滤 + 删组时 `ungroup`）、`server/src/index.ts`（管理面端点）；
  CLI 新增 `cli/commands/group.ts`，`api` 的 `--group-id` 从 64 改为真实行为，
  `mock set group` 补存在性校验；数据面 `data-plane.ts` **零改动**，SDK **零改动**。
  ⚠️ 其中「`data-plane.ts` 零改动」与「删组时 `ungroup`」两项已由 **ADR-033 覆盖**：
  数据面现在要把 `deviceOwner(deviceId)` 传进 `resolve()` 做归属过滤，删私有项目改为**级联删自己的规则**。
  SDK 侧仍然零改动（C14 的破坏面严格限定在服务端本地能力一侧，协议 §0）。
- 明确不做：`Module` 实体、模板实例化与变量编排（属 roadmap 的 P3 变量编排，且要先解决
  「改模板后派生规则跟不跟着变」的引用语义）、分组级 `priority` / 匹配条件、
  分组的用户空间归属（ADR-027 已定不引入第二个隔离维度）、控制台分组 UI（D4）。
  ——**其中「分组的用户空间归属」这一项已由 ADR-033 作废并落地**（✅ 阶段 B 服务端：项目级 `scope` /
  `ownerPhone` 参与命中与读写，见协议 §5.4 / §5.5）；
  其余四项**继续有效**，尤其 `Module` 实体与分组级 `priority`——ADR-033 要的「多个私有项目同时启用、
  命中仍按全局 priority」恰好依赖分组不参与排序这一点。

---

## ADR-031 登录会话落盘：不引入签名 token，用「落盘 + TTL」换重启后自动登录

- 状态：✅ 已定并已验收（服务端 + 31 条自测 + 真机 kill/重启实测）；**修订 ADR-015 的「会话为服务端内存态，重启失效」这一条**
- 背景：一次关于登录的追问把现状盘清楚了——口令是**全局一把**（`--password`，默认 `123456`），
  手机号只是空间标识；自动登录靠浏览器 `localStorage['ec_session']` 里那串 token；
  换浏览器/换访问地址要重登（localStorage 按源隔离）。真正刺痛的是最后一类：
  **服务重启 = 所有人重登**，而重启在本项目里是高频动作（改代码就重启、ADR-024 一键部署也会重启）。
  ADR-015 当时写的是「重启需重新登录（可接受）」，并把持久化的路指给「签名 cookie/JWT」，列为 P1 备选。
  本 ADR 就是那一天的到来：把「可接受」改成「不需要人接受」，同时决定**走不走**当初指的那条路。
- 选项与决策：
  1. **会话怎么跨重启**：①会话表落盘 ②无状态签名 token（HMAC）③前端存口令静默重登
     ④不动服务端，靠部署脚本预热。选 **①**。
     ②看着是「既定路线」，实际在这里换不到东西：本服务单进程、不做水平扩展，
     「任意实例都能认」这个唯一收益用不上；代价却是**吊销没了**——`logout` 无从删起，
     要再引入 per-user 版本号并落盘，等于把①的落盘又请回来，还多养一套密钥。
     更硬的一条：**签名密钥总要落在某个地方**。从 `--password` 派生 = 让口令变成可离线验证的密钥
     （知道口令就能自造任意合法 token，比现在更糟）；随机生成就得存盘 —— 存盘之后与①的安全水位齐平，代码却多一圈。
     ③被否：它要求口令进 `localStorage`，与 ADR-027 D3「口令不落盘」正面冲突，
     等于把一把全局口令发给每一个访问过控制台的浏览器。
     ④保留为部署侧便利（`EC_PASSWORD` / `--password-stdin`），但它改变不了「新进程不认识旧 token」。
  2. **TTL 默认 720 小时（30 天）**，`--session-ttl` 改，`0` = 永不过期。
     单位口径**跟快照一致用「小时」**，不发明第二种时长写法（§1：参数是唯一配置入口）。
     30 天是「日常开发碰不到过期」的位置；`0` 明确可用，但后果要写出来（见下）。
  3. **继续写 `store.json`，不拆 `sessions.json`**：同一次 `save()` 已经把 users + bindings 写全，
     会话和「谁登录过、登在哪个空间」本来就是同一份状态。拆成两个文件等于引入两份写时序，
     正是 F-15 那类「A 落盘了 B 没落盘，重启后自相矛盾」的源头。
  4. **恢复时逐条校验，且三段各自独立**：`normalizeSessions` 只接受
     id 是 `[0-9a-f]{16,128}`、`phone` 是非空字符串、`expiresAt` 是 `null` 或正整数且未过期的条目；
     `sessions` 整体是数组/数字/字符串/null 时只丢这一段。
     原先 `load()` 是**一个大 try/catch**——任何一段脏了整个文件当没读；现在脏 `sessions`
     不会连带抹掉 users / bindings（AGENTS.md §4 要求新写入口扛脏数据，顺带把老入口的连坐也解掉）。
  5. **上限 500 条**：会话只在登录时增长，长期跑的实例会把文件写成几千条；
     超限淘汰「最早插入/最早过期」的一批，保留最新。
- 理由与坑点：
  - **token 就是凭据，而现在它躺在磁盘上**——这是本 ADR 唯一真正的代价，必须说清：
    能读 `.data/store.json` 的进程/人，等价拿到控制台登录态（原先这份凭据只活在内存里，重启即蒸发）。
    `.data/` 已在 `.gitignore`，pre-commit 也专门拦它；`--session-ttl 0` 会让这份凭据**永不自然失效**，
    只适合本机自用。
  - **`destroySession` 必须落盘**，否则「登出」会被下次重启悄悄撤销。
    这类「当场看是对的、重启后反过来」正是最难查的一类，自测里专门断言了「登出 + 重启 → 不认」。
  - **过期只在 `sessionPhone()` 一处判**：管理面（`X-EC-Session`）与控制面 WS `subscribe` 都走它，
    语义天然一致；不要在端点里各判一遍（两处判法不同 = 静默失效的经典入口，§5）。
  - **换口令仍然不踢会话**（ADR-015 的既有行为，本 ADR 未改）：`--password` 只挡新登录，
    已落盘的 token 照常有效。要真正断开，只能清掉 `store.json` 的 `sessions` 或逐个 logout —— 已写进 DEPLOY.md。
  - **旧 `.data` 目录必须能直接起**：`sessions` 是可选字段，缺失 = 无会话，不是错误。
  - **对 mock CLI 的影响**：CLI 那 8 小时 TTL 从「第一道，服务端重启兜第二道」变成**唯一一道**。
    它的 401 自动重登依然有价值（口令轮换、TTL 到期、换了 dataDir），**行为不用改**，
    只是 `cli/config.ts` 里那句「服务端会话是内存态」的注释已经过期，本次一并更正。
- 影响：`server/src/store.ts`（`SessionEntry`、`PersistedState.sessions?`、`normalizeSessions` /
  `capSessions` / `pruneSessions`、`createSession` / `sessionPhone` / `destroySession` / `sessionCount`、
  `load()` 三段独立恢复、空 `dataDir` = 显式不落盘）、`types.ts`（`Config.sessionTtlMs`）、
  `config.ts`（`--session-ttl` + banner 一行）、`index.ts`（构造传参 + `/__ec/api/info` 与 admin
  overview 下发 `sessionTtlMs`）；`tools/selftest.ts` 新增 `[ADR-031]` 段 31 条（总数 259 → 290）；
  `docs/protocol.md` §4.4 与 §7、`docs/architecture.md`、`docs/roadmap.md` P1、`scripts/deploy/DEPLOY.md` 同步。
  **数据面、SDK、控制台前端零改动**——token 的形状与发放方式没变，前端继续用 localStorage 里那一串。
  `tools/mock-cli/selftest.ts` 的 **C-04** 也被迫改了：它原先拿「重启后旧 token 必然 401」当会话失效的
  来源来验自动重登，这个前提随本 ADR 消失，现在用「服务端不认识的 token」驱动同一条能力，
  并新增「同 dataDir 重启后旧会话仍被承认、且不被悄悄换发」两条断言；
  `cli/config.ts` 的 `SESSION_TTL_MS` 注释与 `login --browser` 的失败提示文案同步更正
  （CLI 的 8 小时 TTL 从此是**唯一**一道主动过期）。
- 明确不做：签名 token / JWT；口令进浏览器存储；会话进 URL；per-user 版本号做吊销；
  会话拆独立文件；给会话绑 IP / UA 这类看着像安全其实不管用的风控。
- 实测记录：登录 → `/me` 200 → `kill` 进程 → 重启 → 同一 token `/me` **仍 200**、
  伪造 token 401、规则列表 200、logout 后重启 401（`--data-dir` 指到临时目录跑的，不碰真 `.data`）。

## ADR-032 设备识别与可选单设备绑定

- 状态：🔧 代码完成，自测通过，待双手机现场验证
- 背景：浏览模式下，同一业务账号在两台手机上运行时，兼容层曾直接用账号 ID 作为设备主键。
  设备列表按主键聚合最近会话，后一台手机请求会覆盖前一台的展示，像是把另一台设备顶掉。
  此外，设备行与请求记录的可见性需要分开：未绑定设备应能出现在设备列表供用户选择，但它的请求不应进入普通空间的接口列表。
- 决策：
  1. 兼容层优先使用每安装唯一 ID（`--compat-device-id-header`）作为设备主键；缺少时用
     用户 ID + 展示名，再缺少时回退展示名。兼容层设备会话 ID 固定，避免每个请求生成一个新会话条目。
     如果两台设备上报的用户 ID 与展示名都相同，仍需客户端补充安装级 ID 才能区分。
  2. 新账号默认不绑定设备，控制台登录默认显示当前空间可见设备；请求记录只显示当前绑定设备的流量，
     因此未绑定时请求列表为空，用户需要时再显式绑定；
     绑定必须由用户显式触发。一个手机号空间最多绑定一台，绑定新设备时自动解绑旧设备；
     读取旧版落盘数据时保留 `lastBoundDeviceId` 指向的设备，若无有效指向则保留最后一条归属。
  3. 未绑定设备仅在设备列表中对可认领用户可见；未绑定设备的请求不进入普通空间的记录查询、详情、清空、
     快照创建或实时推送。绑定后其已有记录和新记录对绑定空间可见；解绑后再次隐藏，但设备与记录不删除。
     他人已绑定设备及其记录仍不可见。
- 理由与边界：
  - 设备 ID 表示物理安装实例，不能使用业务账号 ID 单独作为主键；优先使用客户端持久化的随机 ID，
    避免展示名相同或变更造成设备合并 / 分裂。
  - 设备发现与请求访问是不同能力：允许看到未绑定设备才能完成认领流程，但不因此公开它的请求内容；
    记录访问仍以显式绑定为边界，并继续隔离他人已绑定项。
  - 单设备绑定是空间级约束，不限制服务端同时接入多台手机；换绑只更新归属，不影响设备数据。
- 影响：`server/src/data-plane.ts`（兼容层身份派生与固定 session）、`server/src/store.ts`
  （仅绑定记录可见、单设备绑定）、`server/src/control-plane.ts`（实时推送同口径）、
  `server/src/index.ts`（绑定返回解绑设备列表）、`server/web/index.html`（默认全部设备）、
  `docs/protocol.md`、`docs/architecture.md`、`README.md` 与 `server/tools/selftest.ts`。

- 修正（2026-10-16）：首次实现把“未绑定设备可见”扩展成“未绑定设备请求可见”，导致请求进入浏览 / Mock 接口列表；
  现明确分离设备发现和请求访问：设备仍可列出，只有显式绑定的那一台设备的请求对普通空间可见。

---

## ADR-033 私有 / 共享 Mock 项目：运行时只认私有，共享是「必须复制」的模板

- 状态：✅ **决策已定，服务端 + 控制台 + mock CLI 均已实现**（阶段 B / C / D，均 2026-10-16；契约与实现进度见 roadmap P7、协议 §0 C14 状态列）。
  已落地：`types.ts` / `groups.ts` / `rules.ts` / `projects.ts`（版本 + journal，新增）/ `ec-error.ts`（新增）/
  `json-file.ts`（新增）/ `data-plane.ts` / `index.ts`，本机 `tools/selftest.ts` 515 项全绿；
  控制台 `server/web/index.html`（两栏项目 + 只读共享面板 + copy/share/history/rollback + 作用域安全保存），
  纯逻辑由 `tools/console-mock-check.mjs` 锁住（153 项全绿），并完成本机浏览器端到端走查；
  mock CLI 按 C14 归属重写（group copy/share/history/rollback/archive、api 全线按私有项目读写），
  `tools/mock-cli/selftest.ts` 514 项全绿；README 升级提示与启动日志的历史占用行（阶段 D）也已交付。
  📅 仍未做：**真机 SDK 链路验收**（2026-10-16 已在远端部署实例上用两个手机号 + 模拟设备头完成
  多账号验收 28/28 全绿，见 roadmap；设备仍是模拟头，不是真机）、控制台像素级视觉与拖拽手势复核。
  ⚠️ 「当前运行行为仍是全局规则」这句**已过期**：数据面现在只认私有项目，旧全局规则被启动迁移收进
  名为「旧版共享规则」的共享容器且不再命中。升级提示三处都在（README / 启动日志 / 控制台首屏）。
- 背景：ADR-018 边界 4 写下过「**不要在没有新需求时重新提起这件事**」。现在新需求来了，而且是用户明确拍板的四条行为：
  1. 多人共用一个实例时，各自的 mock 会互相踩到——`rules.json` 是全局单文件、`PUT /__ec/api/rules` 全量替换，
     ADR-019 的起因就是这件事，但当时的解法（单条端点）只解决「误覆盖」，没解决「不该看到的规则在影响我的运行时」；
  2. 使用者想把一份调好的接口集合分享给别人复用，但**不希望别人的分享立刻改变我自己的返回**；
  3. 分享出去的东西要被改的时候能整体覆盖，不要每次做三方合并；
  4. 每次分享都要留痕，且历史里任何一版都能回退。
  现有 `Group`（ADR-030）正好是「项目」这个心智的容器：`Group → Rule → action.responses[]`，
  **不新增 `Module` 实体**，只在这个容器上加归属与版本。
- 选项：
  1. **规则级 owner**：每条 `Rule` 挂手机号，命中时按设备 owner 过滤。改动最小（不用碰 group），
     但「项目」这个用户心智落到数据里就是散的：分享要逐条搬运、回退没有可提交的单位、
     历史版本无归属；且 `priority` 变成「跨用户全局可比」，A 为了压过自己的宽松规则抬到 100，
     会把 B 刚复制过去的精确规则一起压掉。**否决**。
  2. **项目级 scope（`private` / `shared`），shared 是只读模板，必须复制才生效**。选中：
     归属与版本都落在「项目」这一层，正好对齐用户的操作单位（「我这套登录 mock 分享出去」）。
  3. 在 2 之上再让 **shared 直接参与命中**（private + shared 双池）。**否决**：
     那等于把「覆盖共享」变成「实时改变别人的运行时」，共享项目就从模板退化成一条没人负责的主干；
     而且 ADR-030 决策 3 那条「悬空 `groupId` 照常命中」的兜底会和「shared 永不命中」直接打架。
- 决策（七条，第 6/7 条最容易实现错）：
  1. **运行时只使用当前设备 owner 的、`enabled` 的 private 项目里的规则**；
     shared 项目与 shared 规则**永不进入数据面候选集**，即使 `enabled` 且匹配条件合法。
     owner 取自 `store.deviceOwner(deviceId)`；未绑定设备（owner 为 `null`）**不命中任何 private 规则**。
  2. **多个 private 项目可同时启用，命中仍只按全局 `priority` 降序取一条**，同优先级沿用「数组里先出现者优先」。
     **不引入「项目级优先级」这个层级**——那是第二个排序真值来源，且会让遮蔽关系随归属变化，
     ADR-016 记过的「精确匹配必须比宽松规则 priority 更高」这条心智要能原样保留。
  3. **分享 = 整项目覆盖，last write wins**：首次分享创建 shared 项目并建立 `originSharedProjectId` 关联；
     再次分享用 private 项目的完整当前内容替换来源 shared 项目的规则清单。
     **不做三方合并**、不把当前共享里别人新增的内容并进我的副本（合并算法一旦出错就是静默丢数据，
     而覆盖丢的数据能在历史里找回）。
  4. **每次 publish / share / rollback 追加一条不可变版本**，记 actor 手机号与服务端时间；
     回退 = 恢复某版快照为当前内容 + **新增一条 `rollback` 版本**，绝不删改既有历史。
     默认**全部保留、不静默清理**（用户要的是「任意历史都能回退」，自动过期会直接废掉这个承诺）。
  5. **权限口径及其后果，如实写下来**：任何登录用户都能 copy shared，而覆盖走的是「本地副本整体提交」，
     所以**任何登录用户事实上都能覆盖和回退 shared 项目**。这不是管理员权限，也没有维护者 ACL
     （加 ACL 会推翻第 3/4 条已确认的口径，本计划不擅自加）。
     代价换法：服务端**必须**逐个端点鉴权与留痕，**绝不靠前端隐藏**（AGENTS.md §4 同一条精神）。
  6. **private 项目删除必须级联处置它自己的规则**（硬删要显式确认，或先归档停用）。
     这一条**在 private 侧反转 ADR-030 决策 4**：全局语境下「删组不删规则、清空 `groupId`」是对的
     （脱组的规则仍然全局命中，不丢功能）；private 语境下脱组 = 规则失去 owner，
     在第 1 条口径下**永远命中不了**，控制台里还显示着「已启用」——正是 §5 定义的最难查的静默失效。
     **同一个「保留并脱组」的动作，在新模型里从"无损"变成"悄悄废掉"，实现时不能照搬旧代码**。
  7. **不存在任何让普通用户全局替换 `rules.json` 的路径**：`PUT /__ec/api/rules` 改为
     「只替换调用者自己 private 项目的规则」，输入里每条必须属于调用者的 private group，
     拒绝无 `groupId` / shared `groupId` / 他人 group / 重复 id；单条写入口同样校验 group owner。
     保留全量 PUT 的形状是因为控制台的整页编辑依赖它，**但作用域必须收窄**。
- 迁移与行为变更（**上线必须提示，否则表现为"所有人的 mock 突然全失效"**）：✅ 四条已在 `migrateProjects()`
  与启动横幅里落地（`listen()` 之前执行，动过几条就打印几条），📅 README 升级提示要到阶段 D：
  - 旧 `groups.json` 一律迁为 `scope: 'shared'`，`ownerPhone` / `createdBy` 置 `null`（**不伪造创建人**，UI 显示「历史项目 / 创建人未知」）；
  - 未分组规则与悬空 `groupId` 规则归入服务端生成的「旧版共享规则」容器（仍是 shared），保留 `Rule.id` 与 `action`，让它们**可被复制**；
    ✅ 只在**真的动过时**才建这个容器，不给干净实例留一个空项目；迁移按 id 幂等，重复启动不再改；
  - 迁移后这些旧规则**不再直接命中**，各自复制到 private 后才恢复 mock——这是本决策刻意的行为变更；
  - shared 有历史版本时不做物理删除，只允许归档，且归档**不删**快照与分享记录。
    ✅ 连带收紧：shared 项目**非空也不给直接删**（`409`），否则「删掉共享项目」等于把别人复制来源的
    历史一并抹了；私有项目则相反，**必须级联删自己的规则**（决策 6）。
- 理由与坑点：
  - **手机号是 owner 的唯一来源 = 已认证会话**（`sessionPhone(req)`），请求体里的 `ownerPhone` / `createdBy` /
    分享人 / 时间**一律不信任**、一律服务端覆盖。手机号是现有稳定账号标识（`store.User` 主键），
    控制台默认脱敏展示（同 §4.5「`createdBy` 不下发免鉴权页」的处理）；
  - **两个文件 + 快照的半提交问题**：active rules 在 `rules.json`、项目在 `groups.json`、快照另存。
    share/rollback 跨这三个写入，进程中断或校验失败会留下「版本历史说分享过、当前规则没变」这种对不上的状态，
    重启也救不回来（F-15 的同类事故，AGENTS.md §4）。所以必须先校验完整新状态 → 写不可变快照 →
    带 `operationId` 的 pending journal → 提交 active 状态，启动时按 journal 幂等处理整笔。
    ✅ 实现里的判定只有两种（**都做前滚，不伪造后滚**）：快照与 journal 齐 ⇒ 重放提交；
    快照文件缺失 ⇒ active 一字不动、清 pending 并如实报告 `abandoned`。
    journal 只存 `after`，凭它写不出「旧状态」，猜一个就是把数据搞得更糟（架构 §6.3 原先写的
    「回滚到 journal 记录的旧状态」与实现不符，已按实现改正）
    **不改单文件、不上 SQLite**：`rules.json` 的数组形状是 ADR-028 逐字节读回校验和 ADR-030 的前提，
    人工可读也是既有取舍；加依赖违反 AGENTS.md §1；
  - **历史快照会长期保留后来删掉的 response body**（含 token / cookie / 个人数据的可能性），
    且无限保留持续占 `.data/` 空间。首版不自动清理、不静默截断，但**发布入口必须提示用户自查**，
    管理面与启动日志给出实际字节数。限额保留要另立 ADR；
    ✅ 现状：管理面 overview 已按真实字节数报告（`storageUsage()`），单份快照 payload 有 **64 MiB** 硬上限
    （超限 `507`、整笔不提交）；✅ **阶段 C 控制台已在「分享」二次确认里给出发布自查提示**（ body 可能含
    token / cookie / 个人数据，发布即对本实例所有登录用户可见，且历史会长期保留后来删掉的那些 body）；
    📅 启动日志那一行仍未加（阶段 D）。
    ⚠️ **64 MiB 这个数是实现自己拍的，不是本 ADR 定的**，已登记为 roadmap P7 的待产品确认项
  - **`operationId` 幂等不是可选项**：CLI 与 agent 会超时重发，同一笔 share 生成两个版本 = 历史里多一条不存在的分享，
    读回校验和审计都会对不上（ADR-028 的读回精神）；
  - **shared 的 sequence 指针永不推进**：shared 不参与命中（第 1 条），若某个实现"顺手"让管理面预览推进了共享序列，
    别人复制过来的指针起点就变了。序列状态只属于 `(deviceId, privateRuleId)`（ADR-004）；
  - **复制必须服务端内部完成**：服务端按 project id 从存储读、生成新 rule id、记 `ProjectLineage` 映射。
    让客户端上传完整项目会撞上管理面 1 MiB body 上限，且「客户端那份」和服务端存的那份又会变成两处真值；
  - **不新增顶层目录、不新增运行时依赖、不引入配置文件格式**（AGENTS.md §1/§2）；
  - **文档交叉引用的既有偏差**（顺手登记，不悄悄改）：ADR-019 与协议 §4.7 把「规则全局、对所有登录用户可写」
    归给「ADR-016 边界 5」，但 ADR-016 的决策只列了 3 条边界，这句话实际出自 **ADR-018 边界 4**。
    本 ADR 按实际出处（ADR-018 边界 4 + ADR-030）修订，引用它的那两处一并改正。
- 取代与修订：
  - **部分推翻 ADR-018 边界 4**：其中「`rules.json` 仍是全局单文件、仍对所有登录用户可写」被决策 7 取代；
    「把规则划给管理员会让普通用户失去 Mock 能力」这个两难在本模型下不成立（规则按**归属**隔离，不按**角色**收权），
    普通用户的 Mock 能力靠自己的 private 项目保留；角色模型（`--admin`）本身不动。
  - **修订 ADR-030**：「分组的用户空间归属（不引入第二个隔离维度）」这条明确不做**作废**——本决策引入的
    是**项目归属**这一维度，且它落在容器上而不是每条规则，ADR-030 反对的「`Module` 同义双表」仍然不做；
    ADR-030 决策 4 的「删组不删规则」按本决策 6 **整条改写**（不是「shared 侧不变」）：
    ✅ private 侧改为**级联删自己的规则**；shared 侧改为**非空或有历史就不给删**（`409`，只能归档）——
    两边都不再存在「保留规则但清空 `groupId`」这个动作，因为新模型里它等于批量制造永不命中的死条目。
    协议 §4.7 里 C13 的 `ungrouped` 计数已随之删除。
    ADR-030 的其余判断（只有两层实体、关组不改写规则、关组不重置指针）**继续有效**；
    唯独「悬空 `groupId` 兜底 = 照常命中」这一条被**结论翻转**为永不命中（协议 §5.4 同节记了两个翻转前提）。
  - ADR-016 边界 1（「浏览/Mock 模式」是控制台视图状态，不引入第二个开关真值来源）**不变**：
    项目 `enabled` 与规则 `enabled` 仍然是一条 AND，与 ADR-030 决策 2 同构。
- 影响：`docs/protocol.md` §0（C14）、§3.3（数据面候选集第 10 条，含「这不是鉴权」的边界）、
  §4.7（项目端点与权限矩阵）、§5.4（数据面命中口径改写）、
  §5.5（`Group` 扩展字段 + `ProjectLineage` + `ProjectVersion`）、§6.1（错误码）、§7（安全约束）；
  `docs/architecture.md` §5.3（C13 那四条被覆盖的口径）与 §5.5、§6.3、§9；`docs/roadmap.md` P7；
  实现 ✅ 服务端（阶段 B）：`server/src/types.ts`、`groups.ts`、`rules.ts`、`projects.ts`（新增，版本 + journal）、
  `ec-error.ts`（新增）、`json-file.ts`（新增）、`data-plane.ts`、`index.ts` + `server/tools/selftest.ts`；
  实现 ✅ 控制台（阶段 C）：`server/web/index.html`（两栏项目、只读共享面板、copy/share/history/rollback、
  作用域安全保存）+ `tools/console-mock-check.mjs` 的归属与覆盖差分用例；
  📅 待改 CLI（阶段 D）：`server/tools/mock-cli/cli/commands/group.ts` 与 `api.ts`、`tools/mock-cli/selftest.ts`、
  以及 `README.md` 的「私有 / 共享项目」用法与升级提示。
  数据面**仍不鉴权**（ADR-015 不变），SDK **零改动**（`Rule` 的形状与匹配语义一字未动，变的只是候选集过滤）。
- 明确不做：维护者 ACL / 审批流、三方合并与冲突检测、跨实例同步（「共享」= 本实例登录用户可见）、
  shared 直接参与命中、项目级 priority、历史自动过期或截断、把共享做成「谁都能改的公共规则池」。
- 交接计划：字段、端点草案、分阶段文件清单与验收 checklist 见 [private-shared-projects-plan.md](private-shared-projects-plan.md)。


## ADR-034 管理界面独立成页：`/admin` 与 `/` 完全分离

- 日期：2026-10-17
- 背景：ADR-018 时代管理面板是 `/` 单页里的一个抽屉（`btn-admin` 对 admin 显示）。
  用下来有两处别扭：①「管理员界面」和「普通用户界面」在同一个页面里互相纠缠，
  想改任何一边都得在几千行单页里小心避开另一边；②admin 账号日常抓包时顶栏永远挂着
  一个「管理」按钮，「我是管理员」这个身份在普通用户界面里暴露着。
- 决策：
  1. 管理面板从 `/` 拆出为独立页 `/admin`（`server/web/admin.html`，自包含、零框架，与
     `index.html` 互不引用对方的代码）。`/` 上不再有任何管理相关元素（按钮、抽屉、样式、JS），
     admin 账号在 `/` 看到的界面与普通用户**完全一致**。
  2. **角色判定不变**（ADR-018）：仍由启动参数 `--admin` 决定 `user.role`，不落盘、不运行时授予。
     `/admin` 登录后 `role !== 'admin'` 直接显示「无管理员权限」，与 `403` 同一口径。
  3. `/admin` 页面本身免鉴权（与 `/`、`/about` 同级的静态壳，不含任何数据）；权限强制点始终在
     `/__ec/api/admin/*`（会话 + `role=admin`）。页面人人可拉不是放宽——壳里没有数据，唯一的数据
     入口仍是服务端把关的 API。
  4. 会话共用（同 origin 的 `X-EC-Session` 与 `ec_session` 存储键）：admin 在两页间切换无需二次登录，
     但身份展示各归各页——`/` 不显示「· 管理员」角标，`/admin` 不提供任何普通用户功能。
- 被取代的做法：`index.html` 内的管理抽屉与 `btn-admin` / `isAdmin()` 删除；
  `fmtDur / fmtBytes / fmtMs / renderAdmin` 迁入 `admin.html`，`fmtTime` 两边各自保留（详情页也在用）。
- 影响：`server/web/index.html`（移除管理代码）、`server/web/admin.html`（新增）、
  `server/src/index.ts`（静态分发加 `/admin`、`/admin.html` 两条 GET 路由）；
  `README.md`「管理员与普通使用者」一节改写。协议零改动（`/__ec/api/admin/*` 未动，页面不在协议内）。
- 明确不做：独立端口隔离（跨端口部署成本高、cookie 语义易错）、运行时授予管理员（ADR-018 结论不变）、
  把 `/admin` 做成 SSR 鉴权页（服务端模板会引入渲染职责，静态壳 + API 403 已够）。

## ADR-035 「Mock 此接口」即落库：创建不再要二次确认

- 日期：2026-10-18
- 背景：原来点「Mock 此接口」只生成**内存草稿**，要切到 Mock 模式再点一次「保存并生效」才写服务端。
  用下来两个问题：①点完按钮界面已经切到 Mock 模式、左侧列表里也有这条（标「未保存」），
  很容易以为**已经生效**，实际请求还在透传——静默失效，最难查（AGENTS.md §5 同类）；
  ②那次确认点击不携带任何新信息，只是把用户刚做的动作再问一遍。
- 决策：
  1. **新建时点「Mock 此接口」= 立即落库**：`POST /__ec/api/rules`，默认 `enabled: true`、
     返回值 = 当前真实响应、归属当前可写私有项目（一个都没有时自动建「默认项目」，沿用 saveDraft 的归属闸）。
     之后照旧进入 Mock 模式，编辑区停在刚建好的这条规则上。
  2. **已有同接口规则只载入、不写盘**（`findRuleForRecord` 命中时没有任何改动可保存）。
  3. **落库失败退回旧行为**：无可写项目 / 服务端 400 / 网络异常时草稿原样留在编辑器，
     用户改完手动点「保存并生效」；失败原因由 `saveDraft()` 如实提示，不吞错。
     于是「未保存」草稿标记从此**只在失败路径出现**（正常路径下点完就是已落库规则）。
  4. **防连点**：`mockFromRecordBusy` 在第一个 `await` 之前置位。否则第一条规则还在路上时
     `state.allRules` 里还没有它，第二次点击的去重判断会落空，建出两条同接口规则
     （同时启用时命中只按 priority 取一条，另一条是纯噪音）。
  5. **编辑后的保存语义不变**：改返回值 / 备注 / 优先级仍要点「保存并生效」（或弹框里 ⌘S）；
     命中方式的改动仍是改完立即落库（ADR-016 补充决策）。自动保存只覆盖「创建」这一步。
- 影响：`server/web/index.html`（`mockFromRecord` 改 async + 详情页提示文案 + 草稿列表注释）、
  `README.md`「Mock 模式」一节。服务端零改动（复用的就是 `POST /__ec/api/rules`，ADR-028）。
- 明确不做：**编辑即自动保存**（每次击键都 PUT，会把改到一半的非法 JSON 写进规则，
  多窗口下还会互相覆盖）、**弹窗二次确认**（那正是这次要省掉的一步）、
  在详情页直接内联编辑返回值（详情页是只读视图，编辑集中在 Mock 模式，ADR-026 的单一写入路径不变）。

---

## ADR-036 移除控制台「规则（JSON）」抽屉：规则只经可视化编辑器改

- 日期：2026-10-18
- 背景：控制台右上角原来有个「规则」按钮，点开是手写 JSON 的抽屉（整份 `GET` / `PUT /__ec/api/rules`），
  里面还挂着「重置序列指针」。用下来判断是：**前台不会去改规则 JSON**，这个入口只有风险没有收益。
  理由站得住——抽屉唯一独有的能力是「批量改 JSON」，而它恰好是最容易出事的一条路：
  整份 PUT 的语义是「替换我的全部私有规则」，**少写一条就是删一条**；`groupId` 漏写 / 指向共享或他人项目
  会被 `400 EC_SCOPE_MISMATCH` 整笔挡下；`responses` / `pinIndex` 写坏会毒化 `rules.json`，
  落盘后重启不自愈（F-15 那一类）。这些保护代码本身没错，但**为没人用的入口继续养一份维护面**
  （预检函数 + 自测断言 + 文档行号引用）不划算。
- 决策：
  1. **删掉顶栏「规则」按钮、`#drawer` 抽屉与 `.drawer*` 样式**，以及只服务它的
     `putPrivateScopeRules()` / `validatePrivateScope()`，连同 `tools/console-mock-check.mjs` 里
     对应的 11 条断言。控制台此后**没有任何「整份 PUT 规则」的入口**。
  2. **「重置序列指针」搬到 Mock 视图工具栏**（`#mock-main .filters` 里的「重置指针」）。
     它是抽屉里唯一不能丢的能力：顺序 mock 的指针是**下标**，拖动排序不重置指针，
     少了这个入口界面上就再也归不了零。服务端 `POST /__ec/api/rules/reset-pointers` 一字未改。
  3. **协议与 mock CLI 不受影响**：`PUT /__ec/api/rules`（私有作用域替换）仍是契约的一部分，
     只是控制台不再调用它；批量改规则走 `docs/mock-cli.md` 的命令行。
  4. **服务端校验一条都不放宽**：结构校验、归属栅栏、读路径兜底全部保留——
     少一个 UI 入口不等于可以把写入口的防线撤掉（AGENTS.md §4）。
  5. **textarea 的基础样式保留**：抽屉删了，但返回值弹窗（`.modal-editor`）与 Mock 编辑器
     （`.mock-body-editor`）复用同一条 `textarea` 规则，跟着删会让两处编辑框掉样式。
- 影响：`server/web/index.html`（HTML / CSS / JS 三处删除 + Mock 工具栏加按钮）、
  `server/tools/console-mock-check.mjs`（导出列表与 11 条断言，153 → 142 项）；
  `docs/architecture.md` §5.3、`docs/roadmap.md` 里指向该抽屉的两处指引改为现状。
  **服务端、SDK、协议零改动。**
- 明确不做：**不删 `PUT /__ec/api/rules`**（mock CLI 与脚本在用）、
  **不给抽屉加权限或折叠开关**（留着就是留着，折叠只是多一个要维护的状态）、
  **不改 ADR-019 / ADR-025 / ADR-026 的历史正文**（它们记录的当时取舍仍然成立，
  只是入口没了；取代关系以本条为准）。


---

## ADR-037 共享项目删除先挂 7 天：软删除 / 恢复 / 到期真删；私有项目仍是立刻删

> **修订（2026-10-18，当天）**：宽限期由 15 天改为 **7 天**（用户口径）。只改
> `SHARED_TRASH_MS` 这一个常量，软删除 / `restore` / 到期清扫 / 私有项目立刻删**全部不变**；
> 已经落盘的 `purgeAt` 不追溯（存量待删除项目仍按各自的 `purgeAt` 执行）。
> 控制台不再在文案里写死天数：删完的 toast 与列表「剩 N 天」都从服务端 `purgeAt` 算。

- 日期：2026-10-18
- 背景：用户提了两条——① 共享项目要能删，删前给确认按钮；确认删除不是真删，而是进入待删除状态，
  7 天无人恢复才真删；② 个人项目直接删，也要确认按钮。
  当时的现状是：私有项目能删（`confirm()` + 级联删规则），共享项目**基本删不掉**——
  有历史 `409`、项目里还有规则也 `409`，只能归档。而「归档」只是个标记，谁都能继续覆盖它，
  对「这个模板我不要了」这个诉求等于没给出口。
- 决策：
  1. **shared 走软删除**：`DELETE /groups/:id` 只写 `pendingDeleteAt = now`、`purgeAt = now + 7 天`
     （`SHARED_TRASH_MS`），**规则、历史版本、快照一条都不动**。项目继续出现在列表与详情里，
     带「待删除 · 剩 N 天」标记，仍可读、仍可 copy 出去（这是唯一的逃生口）。
  2. **`POST /groups/:id/restore` 撤销**：清掉两个时间戳，内容从未被改过，恢复即恢复原状。
     幂等；private 调它 → `409`（私有项目没有回收站，返回 ok 会让人以为撤销了）。
  3. **到期真删**：启动时扫一次 + 每 30 分钟一次（`ProjectService.purgeExpired`），
     顺序**规则 → 项目 → 历史目录**。反过来会在中间那一拍留下「无归属规则」——C14 下即永不命中，
     正是 ADR-033 决策 6 要防的静默失效；而「先规则后项目」中途崩了留下的是空项目，下一轮清扫能自愈。
  4. **private 保持立刻物理删除**，只把控制台的 `confirm()` 换成卡片内的两段式确认按钮
     （`state.confirmDel`）。私有项目删除不可撤销，确认文案必须写明「无法撤销」。
  5. **待删除期间禁止写入**：`share` 覆盖到待删除的 shared、`rollback` 待删除的 shared → `409`。
     否则「分享成功」会变成「7 天后整份内容跟着项目一起消失」，且没有任何日志提示。
  6. **重复删除不延长倒计时**：已经在待删除的项目再 DELETE 一次，`purgeAt` 原样返回。
     否则反复点删除 = 永远不删，宽限期变成「永远」。
  7. **迁移容器 `g_legacy_shared` 拒绝删除**（`409`）：它不是任何人建的项目，装着全服升级前的存量规则，
     删掉它 = 7 天后抹掉所有人的旧 mock。
  8. **两个时间戳是服务端字段**：进 `GROUP_SERVER_FIELDS`，客户端提交即 `400 EC_SCOPE_MISMATCH`。
     让客户端能写 `purgeAt` 就等于让人**跳过 7 天**直接把共享项目删掉。
- 影响：`server/src/types.ts`（两个字段 + 黑名单）、`groups.ts`（`SHARED_TRASH_MS` / `markPendingDelete` /
  `cancelPendingDelete` / `pendingExpired` / `isPendingDelete` / 读路径兜底）、
  `projects.ts`（`purgeExpired` / `purgeProject` / share·rollback 的 409 闸门，删掉不再使用的 `assertDeletable`）、
  `index.ts`（DELETE 分叉 + `restore` 端点 + 启动/定时清扫）、`web/index.html`（两段式确认、待删除标记、恢复入口）、
  `tools/selftest.ts`（新增 15 条：软删除不改表 / 幂等不延长 / 写入被挡 / 恢复 / 到期真删 / 脏时间戳 / 迁移容器）；
  协议 §4.7 与 §5.5、架构 §6.3 同步。**SDK 零改动**（它只碰数据面）。
- 明确不做：**不做回收站列表页**（待删除项目就在共享列表里，多一个页面只是多一处要同步的状态）、
  **不做「立即永久删除」按钮**（要等就等满 7 天，绕过宽限期等于把这个决策做废）、
  **不给 private 也来一档待删除**（私有项目是自己的工作台，删错了重建成本低，
  而共享项目里可能装着别人的回退点）、**不加 `--trash-days` 参数**（口径是 7 天，
  且 `purgeAt` 已落盘，改参数只影响新发起的删除，收益不足以多一个部署差异）。

## ADR-038 去品牌化：视觉与文案不继承原公司

- 日期：2026-10-19
- 背景：控制台的配色（墨绿 `#0f6e56` + 绿调浅底）与部分文案，沿用了作者在原公司做的一套
  内部 mock 工具的视觉与命名。项目准备对外发布：这些痕迹既容易被认成同一个产品，也不适合
  把原公司的设计语言带出去。功能与信息架构本身是通用的，问题只在「看起来像谁」。
- 决策：
  1. **换主色，不改结构**：主色墨绿 `#0f6e56` → 中性蓝 `#2b6cb0`；配套 `#cfe0f3`（描边）、
     `#e8f1fb`（浅底）、`#f7fafe`（带色浅底）、`#1f5286`（深一档）。**唯一真值仍是
     `index.html` 的 `:root`**（`--accent` / `--accent-soft`）；`about` / `snapshot` / `admin` /
     `style-demo*` 与 `docs/images/*.svg` 里的硬编码同步替换（本轮共 142 处）。
  2. **语义色一律不动**：`--ok` 绿、`--warn` 琥珀、`--err` 红各代表「成功 / 警告 / 错误」，
     把它们也换成品牌色会让状态失去稳定含义。只换「主色 / 主色浅底 / 主色描边」这一族。
  3. **图标保留**：`scripts/assets/EasyCharles-1024.png` 由 `scripts/make-icon.py` 生成
     （深藏青底 + 一进一回两个箭头），是自绘资产、不含原公司元素，换主色不牵动它。
  4. **文案只去掉「来源指向」**：`roadmap` P6 与 ADR-027 里「内网 f2e mock 平台」「逆向复刻」
     改成中性表述（命令分组与并行数组约定沿用既有使用习惯，实现自有）。
     **不删「参考过一套内部工具」这个事实**——去品牌化不等于改写来源。
  5. **命令名 `f2e` 保留**：它是未实现的 stub（P4，退码 64）。改名会打断已有脚本与 selftest 的
     stub 断言，收益只是措辞；真要彻底去品牌，应作为独立的 CLI 契约变更单独做。
- 影响：`server/web/{index,about,snapshot,admin,style-demo,style-demo-v2}.html`、
  `docs/images/*.svg`（9 张）、`docs/roadmap.md`、`docs/decisions.md`（ADR-027 措辞）、
  `server/tools/mock-cli/mock.ts`（`f2e` 的 help 摘要）。**协议、服务端逻辑、SDK 零改动。**
- 明确不做：**不改信息架构与交互**（去品牌化不是重设计）；**不换图标**（自有资产）；
  **不动语义色**；**不改 `f2e` 命令名**（见决策 5）。

---

## ADR-039 加解密：密钥与规则分离，只改记录不改转发

- 状态：✅ 已实现（表单化配置 + 请求/响应解密 + mock 加密回写）；📅 worker 脚本模式未做
- 取代：ADR-011 的形态部分（职责定位仍然有效）。ADR-011 里「`action.crypto` 直接带
  Key/IV」的写法被本条改掉。
- 背景：业务接口（如 `api/example/im/msg/detail`）请求体与响应体都加密，
  控制台里只能看到 base64。要让控制台看到明文，直觉做法是「把加解密规则内置进
  EasyCharles」。但这个项目要开源，**内置规则 = 把密钥写进 git 历史**，一旦推上去，
  删文件、改历史、force push 都救不回来（fork / CI 缓存 / release 附件都会留副本）。

### 决策

1. **密钥与规则分离（本 ADR 的核心）**
   - `Rule.action.crypto` 只存 `{ profileId }`，不存 key/iv；
   - key/iv 只在 `server/.data/crypto/settings.json`（`.gitignore` 的 `server/.data/` 之下）；
   - 好处不止「不进库」：规则会被导出、分享到共享项目、截图发群里，**分离之后这些动作
     都不会带出密钥**。这是「结构性防护」，不是「记得别提交」。
2. **三层防护，缺一不可**
   - 路径：`.gitignore` 忽略 `server/.data/`、`server/crypto/`、`*crypto-settings.json`；
   - 提交：pre-commit §5.5 拦「换了个目录存」的密钥档，以及任何同时出现
     `"alg": "aes-…"` 与 `"key": "…"` 的配置文件（`.example` / `.md` 放行）；
   - 发布：`build-server-bundle.sh` 白名单收集，`.data/` 与 `crypto/*.json` 都在禁忌条目里。
3. **解密只影响记录，不影响转发**：请求体/响应体原样透传，`body` 写明文、`rawBody`
   写原始密文。解密失败只记 `crypto.*.error`，**绝不阻断请求**（与 SDK fail-open 同一条原则）。
4. **表单化优先，不收 AEAD**：算法白名单只放 CBC/ECB/CTR/CFB/OFB 与 3DES/SM4；
   GCM/CCM/ChaCha20-Poly1305 需要 `setAuthTag`，表单模型没有这个字段，收进来就是
   「配了也解不开」。脚本模式留给真正需要自定义逻辑的场景（要 worker 隔离 + 权限边界）。
   > ⚠ 本条已被 [ADR-039 补充](#adr-039-补充2026-10-19支持-aead-与-query-密文) 改写：
   > AEAD 支持的障碍不是「没有 authTag 字段」，而是「没有布局描述」。补上 `aead{}` 后照旧表单化。
5. **mock 明文必须加密回写**：规则带 `action.crypto.profileId` 时，返回前按
   `profile.encrypt` 加密。失败时按明文返回并记 error——宁可让 mock 失效，
   也不要让 App 收到一包解不开的数据而控制台看不出来。
6. **`match.params` 用解密后的 body**：加密接口的业务参数在密文里，用密文匹配等于永不命中。
   这条顺带修掉了一个隐蔽的坑：以前给加密接口配 `params` 匹配，规则「启用了但不生效」。
7. **`rawBody` 的口径统一为「线上真正传输的那份」**：真实请求/响应是收到的密文，
   mock 是发出去的密文。同一个字段在两处含义相反，控制台的「查看密文」就会自相矛盾。
8. **密钥永不下发**：`GET /__ec/api/crypto` 只回 `12••••ef` 这种打码值。提交回写时
   含 `••••` 即表示「沿用旧值」，服务端不会把打码串存成密钥。

### 为什么不能「内置进代码，但用环境变量」

可以用 `--crypto-key` / 环境变量注入，但那只是把泄露面从 git 挪到「启动脚本 / 部署文档 /
ps 输出」；本项目已经允许密钥落 `.data/`（本机文件，权限 644、不进库、不进包），
两相比较前者并没有更安全，反而让「换一把密钥要改启动参数」变成运维负担。
真要更严格，正解是**不落盘的密钥托管**（Keychain / KMS），那是另一个量级的需求。

### 如果密钥已经泄露了

1. **轮换密钥**（唯一真正有效的补救）：服务端与 App 同步换，旧密文自然失效；
2. 评估影响面：固定密钥泄露 = 任何人可解密历史流量、伪造请求。这不是「低危信息泄露」；
3. 清理 git 历史只是避免「继续被看到」，不能撤回已被 clone / fork 的部分；
4. 检查 CI 日志、release 附件、issue / PR 里的粘贴。

### 影响

`server/src/crypto.ts`（新增）、`types.ts`（`CryptoProfile` / `CryptoRoute` / `CryptoMeta`）、
`data-plane.ts`（请求/响应解密、mock 加密回写、`params` 用明文）、`index.ts`（四个管理面端点）、
`config.ts`（`--no-crypto`）、`web/index.html` + `web/snapshot.html`（明文为主 + 密文切换）、
`tools/selftest.ts`（24 条用例，含异常输入矩阵）、`scripts/pre-commit-privacy.sh` §5.5、
`.gitignore`、`scripts/build-server-bundle.sh`、`docs/protocol.md` §5.6、`docs/crypto.md`。

### 明确不做

- **不把任何真实密钥写进仓库**（包括 example 模板：只放 `<你的 16 字节密钥>` 这类占位符）；
- **不改 `X-EC-*` 头的语义**：加解密不新增请求头，SDK 零改动；
- **不让解密影响转发**：任何「解密后改写请求体再发上游」的需求都属于改写（`action.set`），
  不在本条范围内；
- **不做签名重算**（`sign` / `timestamp` / `nonce`）：改 body 才会让签名失效，而本条不改 body。
  将来做 mock 改写时才需要 ADR-011 里的 `sign(ctx)`。

### ADR-039 补充（2026-10-19）：支持 AEAD 与 query 密文

- 状态：✅ 已实现（`aead{}` 布局 + `wrap.prefix` + `query` 参数解密）
- 触发：真实业务（`POST /api/example/im/msg/detail`）用的是
  **AES-256-GCM + base64url**，密文布局 `iv(12) | ciphertext | tag(16)`，响应体带
  `ciphertext:` 前缀，请求参数还额外在 URL 的 `?payload=` 里带一份。
  按原 ADR 的白名单，这类接口**一条都配不上**，加解密插件对最需要它的场景等于不可用。

**为什么原来的判断不成立**：原第 4 条把「AEAD 需要 `setAuthTag`」当成「表单模型装不下」，
其实缺的不是一个 tag 字段，而是**一条布局描述**——IV 多长、标签多长、标签在头还是尾。
这三个都是有限的、可枚举的参数，正好是表单能表达的东西。补上之后：

1. `aead = { ivBytes, tagBytes, tagAt, aad? }`；AEAD 算法必填、非 AEAD 不许填、且都不能配 `iv`
   （随机 IV 才是 GCM 的正确用法，配死一个 IV 只会让人以为「用上了」）。
2. **`wrap.prefix`**：密文串自带的固定前缀（`ciphertext:`）。它属于「密文长什么样」，
   所以挂在 wrap 上而不是 profile 上——同一个密钥档可能一个方向带前缀、另一个不带。
   mock 加密回写时**必须补回**，否则 App 收到的数据解不开。
3. **`profile.query = { field, prefix? }`**：`GET` 没有 body，业务参数全在 URL 里。
   不解这一层，GET 类加密接口在控制台永远是密文。
   解密结果写进 `MessagePart.queryPlain`，`query` / `url` 保持线上原样（同 `rawBody` 的复查原则），
   并参与 `match.params` 匹配。
4. **`keyEncoding` 增加 `base64url`**：Java 的 `Base64.getUrlEncoder()` 产出 `-` `_`，
   而 Node 的 `Buffer.from(x,'base64')` 是**静默跳过**这些字符，32 字节密钥变 30 字节，
   最后报「Invalid key length」——一条与密钥本身无关的错。

**不变的部分**：密钥仍只在 `.data/crypto/settings.json`；解密仍只改记录不改转发；
失败仍不阻断请求；打码回写规则不变。

**仍然明确不做**：tag 单独放在另一个字段 / header 里的布局、IV 在 header 里的布局
（需要扩展「多段拼装」模型，超出表单范围）；非对称与密钥协商。

---

## ADR-040 加解密插件化：内核只认 SPI，实现对使用者可插拔

- 状态：🚧 P0 + P1 + 脚本来源已落地（2026-10-19）：内核拆分、`plugins/` 目录扫描、schema 表单、
  `<dataDir>/crypto/scripts/*.mjs` 单文件脚本（无 schema，入密文出明文）、`/crypto` 配置页；
  P2（worker 隔离）未开始，`in-process` 仍拦不住同步死循环
- 承接：ADR-039 结尾留的那句「脚本模式留给真正需要自定义逻辑的场景（要 worker 隔离 + 权限边界）」
- 背景：ADR-039 把**密钥**从规则里摘出去了，但**实现**仍写死在 `crypto.ts`（830 行）。
  项目要开源，而「业务怎么加密」本身也是不想公开的东西——
  不只是 key，还包括布局、派生方式、多段拼接规则。
  更要紧的是可持续性：每来一种新变形就得往内核加 `if (alg === 'xxx')`，
  内核会逐步长成一坨业务代码，开源时只能整块删，删完别人也用不了。

### 决策

1. **三层结构，边界划在「密文串」**
   - Core（公开）：profile/route 存储、wrap 定位、编码转换、插件注册表、失败降级；
   - builtin 插件（公开）：AES/DES/SM4 + AEAD，纯配置驱动，键名与现有扁平字段一致；
   - 私有插件（不进 git）：放 `<dataDir>/plugins/<name>/`，实现业务变形。
   - SPI 输入输出都是 **string**：内核负责「密文在哪」，插件负责「这段字怎么变明文」。
     布局（IV 几字节、tag 在头还是尾）属于业务知识，内核不猜。

2. **内置引擎也是一个插件**，走同一条 SPI。只有一条代码路径，不存在「内置能解、插件不能」；
   同时它可以被配置绕开、也能从公开版剔除——但按本条决策，保留它（用户填配置即可用）。

3. **零迁移**：`settings.json` 格式不变。没有 `plugin` 字段的 profile 归一为
   `plugin: 'builtin'`，`options` 由扁平字段推导，**不回写磁盘**。
   反过来，写了 `plugin: '<非 builtin>'` 又同时留着 `alg` → 写入 400，
   不让两套配置同时存在（出问题时无法判断哪套生效）。

4. **两种隔离按插件声明**（用户选择：都支持）
   - `in-process`：零拷贝、最低延迟，但**拦不住同步死循环**——`Promise.race` 只能让
     不返回的异步不再拖住请求，CPU 死循环会卡死事件循环。控制台必须显式标注「无隔离」；
   - `worker`：内核自带通用宿主，插件作者不用写 worker 代码；每个 profile 常驻一个 worker，
     `resourceLimits` 限内存，超时 `terminate()` 是**真中断**。
   默认 in-process，第三方插件建议 worker。

5. **安装只走文件拷贝，控制台不做上传**
   管理面在 LAN 模式下任何持 token 的客户端都能调，上传 zip 等于开一个远程代码执行入口。
   「拷贝到 `<dataDir>/plugins/` + 点重新扫描」要求操作者有本机或 SSH 权限，
   与「管理面所有写入都是不可信输入」的既有约定一致。

6. **插件拿不到完整请求上下文**
   SPI 只给 `{ direction, profileId, headers }`，其中 `headers` 是 profile 里
   **显式声明的白名单**（≤8 个、值截断 256 字符）。不给 URL / cookie / 全部 header：
   插件若能看到全部流量，就不再是「字节变换函数」，而是数据外泄与按身份做手脚的后门。
   确实需要 nonce 的接口，就配那一两个 header 进去。

7. **schema 驱动的管理面**
   插件自带 `configSchema`（JSON Schema 标量子集），控制台据此渲染表单，
   不为每个插件写死 UI。`secret: true` 的字段走密码框 + GET 打码 + PUT `••••` 沿用
   （复用 ADR-039 已踩验证的语义）。写入时按 schema 校验，**不做隐式类型转换**。

8. **失败降级完全沿用 ADR-039**：插件缺失 / 版本不匹配 / setup 抛错 / decrypt 异常 /
   超时 / worker 崩溃，一律「转发正常 + 记录保留原文 + 写 crypto.error」。
   插件坏了不能让人抓不了包。

### 明确不做

- **控制台上传 / 在线编辑插件代码**（理由见决策 5）；
- **插件签名校验**（本机可写的人照样能换，收益有限，P3 再议）；
- **跨语言插件进程**（HTTP/gRPC 回调用独立服务跑）：会引入网络依赖与超时治理，
  当前「worker + SPI」已覆盖隔离需求；
- **让插件读写记录或规则**：SPI 只有 `text + options` 进出。

### 影响

- `server/src/crypto.ts` 拆为 `crypto/{errors,coerce,encoding,wrap,profile,transform,store,index}.ts`
  + `plugin-types.ts` / `builtin.ts` / `registry.ts`，对外签名（`CryptoStore` 的 6 个方法）不变
  —— P0 已过线：selftest 597 → **609 条全绿**，`settings.json` 逐字节不变；
- `types.ts` 增 `plugin` / `options` / `pluginContext`；
- 管理面增 3 个端点，`GET/PUT /crypto` 扩展；
- 控制台密钥档表单改为 schema 渲染 + 新增插件页；
- pre-commit 增一条：`server/**/plugins/*` 出现即拦，防止私有插件顺手放进源码树。
