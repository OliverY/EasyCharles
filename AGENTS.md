# AI 工作规范（EasyCharles）

给 AI 看的**约束清单**。人看的说明在 `README.md`，设计决策在 `docs/`。

---

## 0. 先读这三个文件

| 文件 | 什么时候读 |
|---|---|
| `README.md` | 了解项目能做什么、怎么用 |
| `docs/architecture.md` | 改分层、数据流之前 |
| `docs/decisions.md` | 遇到「为什么这么做」时，答案都在 ADR 里 |

---

## 1. 技术栈（不要引入别的）

| 层 | 选型 | 说明 |
|---|---|---|
| 服务端 | Node 22 + TypeScript | **零构建**：靠 Node 原生类型剥离直接跑 `.ts` |
| 语言 | TypeScript | import **必须写全 `.ts` 后缀**（如 `import { x } from './rules.ts'`） |
| 依赖 | 仅 `ws` 一个运行时依赖 | 不得新增；`typescript` / `@types/*` 只用于本地类型检查 |
| 前端 | 原生 HTML + JS，零框架 | 控制台在 `server/web/`，单页无构建 |
| 脚本 | Bash（`scripts/`） | 部署与打包；图标生成用 Python |
| Android | Kotlin + OkHttp 拦截器 | 对 OkHttp 用 `compileOnly` |

- 端口默认 `8899`，控制台页面在 `/`，关于页在 `/about`
- 改任何配置项：加 `config.ts` 里的参数解析，**不要引入配置文件格式**（`easy-charles.env`
  是发布包 `run.sh` 读的环境变量，最终仍翻译成启动参数，不是服务端读的配置文件）

---

## 2. 红线（违反就是 bug，不是风格问题）

- **不上传隐私到 git**：账号、内网 IP、公司域名、真实手机号、密钥、token、
  `easy-charles.env`、`scripts/deploy.conf`、`server/.data/` 一律不进库。需要举例时用
  `example.com` / `10.0.0.1` / `<内网IP>` / `13800000000` 这类明显的假值。
  钩子放行 `127.0.0.1` / `0.0.0.0` / `10.0.2.2` / `10.0.0.1` / `10.0.0.11`，
  以及含 `<内网` / `example` / `占位` / `你的` 等关键词的行；其它 `10.x`、`192.168.x`、
  `172.16-31.x` 会被拦下（`.md` 文档整体放行）。
  **有 pre-commit 拦着**（见下），别用 `--no-verify` 绕过。
- **业务标识也不进库**（§5.8）：真实接口路径、真实字段名、产品名不要写进文档、示例、自测。
  这些不含密钥，但公开后等于把内部 API 面貌与加密布局摊开，且不可逆（fork / 缓存）。
  占位口径统一用 `/api/example/...`、`myapp`、`payload`；判据是「换个团队还用不用得上」——
  通用的是示例，只对自己接口成立的属业务标识。确需临时豁免：`EC_ALLOW_REAL_IDENT=1`。
- **加解密密钥只放 `.data/crypto/settings.json`**（ADR-039）。规则里只能写 `profileId`，
  **绝不能把 key/iv 塞进 `rules.json`、示例配置、测试夹具或文档示例**——规则会被导出、
  分享到共享项目、截图发群，密钥混进去就等于「分享一套 mock = 泄露线上密钥」。
  模板 `server/crypto.example.json` 只允许 `<你的 16 字节密钥>` 这类占位符。
  pre-commit §5.5 会拦「换个目录存」的密钥档，发布包校验把 `crypto/*.json` 列为禁忌条目。
  §5.6 另外拦**硬编码密钥常量**：`const AES_KEY = "…"`、`val key = '…'`、`aes_key: …`（含 yaml）。
- **业务加解密只能做成插件，不能往内核加分支**（ADR-040）。`server/src/crypto/` 只放
  通用能力（定位密文 + 编码 + 存储 + SPI），业务变形（布局、派生、多段拼接）实现 SPI 后
  放 `<dataDir>/plugins/`。判据很简单：**「这段代码能不能给别人用」**——
  能给别人用的进 `builtin.ts`，只对自己的接口成立的进私有插件。
  私有插件实测会读 header 就显式声明那一两个，SPI 不给完整请求上下文。
- **不新增运行时依赖**。确需引入时先说明理由，等确认。
- **不重构无关代码**。改动范围限定在本次任务内。
- **不新增顶层目录**。iOS SDK、Web 端 SDK、GUI 都不在范围内。
- **不改 release 三重保险**：`debugImplementation` + `BuildConfig.DEBUG` +
  `FLAG_DEBUGGABLE` 运行时校验。
- **不重试上游失败**：502/504/503 是真实业务失败（可能是重复提交）。
- **SDK 必须 fail-open**：本地服务连不上就直连真实服务器。

---

## 3. 四个面必须分离

`server/src/index.ts` 里的路由分派严格分四类，改动时不要越界：

| 面 | 路径 | 鉴权 | 要求 |
|---|---|---|---|
| 数据面 | `/__ec/p*` | **不鉴权**（ADR-015 刻意取舍） | 无状态；不得引入鉴权/存储/规则逻辑 |
| 控制面 | `/__ec/ws` | SDK hello 免鉴权；控制台必填会话 | WebSocket，注册/心跳/推送 |
| 管理面 | `/__ec/api/*` | 除 login 外必填 `X-EC-Session` | 运行时校验输入 |
| 快照面 | `/s/:token`、`/__ec/s/:token` | **不鉴权**（能力 URL，token 即凭据） | **只有 GET、不转发任何请求**；不得在此面加写操作或代理能力（ADR-017） |

---

## 4. 所有写入入口要扛住脏数据

**这条最容易出事，且已出过事故。**

任何从 HTTP / 文件 / WebSocket 进来的数据，**都要假设它写错了**：

- 类型可能是对象而非数组、标量而非对象
- 字段可能缺失、多余、嵌套层级不对
- 数字可能为负、极大、NaN

原因：控制台手写 JSON 会打错字；上游服务器可能返回意外结构；
AI 重构拦截器时容易把逻辑写错。**任何一条都能让服务彻底瘫掉，
且落盘后重启也救不回来。**

> 已发生：`PUT /__ec/api/rules` 传对象型，毒化内存与 `rules.json`，
> 之后每条请求 500，重启不自愈。修复见 `rules.ts` 的 `replaceAll`。

**新增写入接口时，同步在 `server/tools/selftest.ts` 补一条非法输入用例。**

TypeScript 类型在运行时会被擦除，**编译通过 ≠ 运行时安全**。

---

## 5. 改字段必须三方核对

```
服务端发出的路径  ==  SDK 读取的路径  ==  docs/protocol.md 的定义
```

不一致是**静默失效**：不报错、日志正常、功能不工作，最难查。

> 已发生：服务端下发 `params: { enabled }`，SDK 读顶层 `enabled`。

改字段的顺序：**先改 protocol.md → 再改服务端 → 再改 SDK → 再改控制台**。

---

## 6. 验收不能只写正常情况

只测 happy path 的验收清单视为**未完成**。每项至少覆盖：

- 非法类型 / 类型混淆（数组当对象、标量当数组）
- 缺字段 / 多余字段 / 嵌套层级错误
- 空 body / 超长 body / 超大响应
- 延迟期间客户端断开 / 并发重复请求
- 涉及大小的地方，核对**实际字节数**而不是估算值

> 已发生：P0.1 的 10 项验收全是 happy path，直接漏掉了第 4 条那个洞。

---

## 7. 不要「顺手修好」看起来像 bug 的东西

有些代码写得别扭但是**刻意的**，动手前先查 `docs/decisions.md`：

- **数据面不鉴权** —— ADR-015 刻意取舍，为了 `adb reverse` 零暴露
- **控制面与数据面分离** —— ADR-003
- **buffering 的边界** —— ADR-008 有明确尺寸，不是随手写的
- **不重试上游** —— ADR-005，理由可能是业务不能重复提交
- **解密只改记录、不改转发** —— ADR-039。请求体/响应体必须原样透传给上游与 App；
  「顺手把解密后的明文发给上游」属于改写（`action.set`），不在加解密范围内；
  解密失败也只记 error，不阻断请求（与 SDK fail-open 同一条原则）

**没在 ADR 里找到理由的，才可能是真 bug。** 不确定就问，不要直接改。

---

## 8. 改之前 / 改之后

**改之前**
1. 搜索现有实现，读 `docs/architecture.md` 对应章节
2. 涉及协议 → 读 `docs/protocol.md`
3. 涉及架构取舍 → 翻 `docs/decisions.md` 找 ADR
4. 看 `server/tools/selftest.ts` 有没有现成用例可复用

**改之后**
```bash
cd server && npx tsc --noEmit        # 必须无错
cd server && node tools/selftest.ts  # 必须全绿
```

**要部署就用 `bash scripts/deploy.sh`**（目标机读 `scripts/deploy.conf`，不进 git）。  
它要求**工作区干净**才出包——先提交再部署，别用 `--allow-dirty` 绕过。  
只看现状用 `check` / `status`，回滚 `rollback`，看日志 `logs`；见 DEPLOY.md §3D。

文档改了就同步：`protocol.md`（协议）/ `architecture.md`（分层）/
`decisions.md`（新决策）/`roadmap.md`（任务状态）。

**别用 `git add -A`**：工作区可能有你不知道的东西。只 add 自己改的文件。

**pre-commit 隐私检查**：`.git/hooks/pre-commit` 是软链到
`scripts/pre-commit-privacy.sh`，扫暂存区里的私钥/证书文件、疑似 token、
明文口令赋值、内网 IP、被误提交的 `.data/`、加解密密钥档（§5.5）与
硬编码密钥常量（§5.6）。命中会打印具体行号并拦下提交。

§5.6 的判据是「标识符像密钥 + 32 位以上 base64/hex 字面量 + 值含数字或大写」，
所以 `'api/example/im/msg/detail'` 这类全小写路径、`0123456789abcdef…`
这种构造出来的测试值、以及含 `example` / `placeholder` 的行都不会被误拦。
写测试夹具时**优先用 `example` / `placeholder` 前缀**，别硬编码长得像真密钥的串——
否则每次提交都要 `--no-verify`，那这条防线就等于没有。

换机器或重装后执行 `bash scripts/install-hooks.sh` 恢复。
**确认是误报**可以 `git commit --no-verify`，但先想清楚——这个检查专门放行了
`127.0.0.1` / `0.0.0.0` / `10.0.2.2` 和 `.md` 文档，被拦下多半是真的。

---

## 9. 状态不要撒谎

- 未实现标 🔧 或 📅，不要标 ✅
- 未验收就说「代码完成，待真机验证」
- 有取舍就摆两个方案和代价，让用户选，不要替他做架构决策
- 发现文档与代码不一致，**先说出来**，别默默按代码实现
