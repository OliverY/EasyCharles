# 接口文档对接模块（契约台账）实施计划

> 状态：**草案，待拍板**（§11 三个决策点未定之前不动代码）。
> 范围：EasyCharles 单个服务实例内的登录用户。文档条目属于**项目（`Group`）**，
> 因此自动继承 C14 / ADR-033 的私有 / 共享归属语义，**不新增归属维度**。
>
> 这份文档解决的是「没有历史接口文档之后，怎么把这件事继续做下去」。
> 它不引入新实体去替代 `Rule`（ADR-030 的结论继续有效），只是给 `Rule` 旁边
> 加一份**可追溯的契约档案**，并让记录、文档、规则三者能互相指认。

---

## 1. 要解决的四件事

| # | 场景 | 现在的障碍 | 本模块给出的能力 |
|---|---|---|---|
| 1 | 每条抓到的请求都能跳到它的接口文档 | 文档没了；就算有，记录与文档之间没有关联键 | 记录详情页「文档」按钮 + 本地契约页；未收录时一键反向生成 |
| 2 | 后端没做好的接口先造 mock | 不知道「哪些接口是文档里有、实际没通的」 | 覆盖率四象限 + 按 schema 生成响应骨架 |
| 3 | 老接口要改，能自主开发 | 改了不知道有没有偏离原契约 | 契约体检（文档 vs 实际字段差异） |
| 4 | 判断需求要加哪些字段，反哺后端 | 结论散在聊天记录里，没法交给后端 | 字段提案（结构化 → 导出 markdown / OpenAPI 片段） |

四件事共用同一个前提：**同一个接口的三份描述必须在同一个 key 上对齐**。
对齐之后它们只是同一份数据的不同视图，不需要四套逻辑。

---

## 2. 定位与边界（红线）

这个模块最容易出的事，是它悄悄变成「第二个真值来源」。所以先把不做的事写死：

1. **不进数据面**。文档不参与转发、不参与规则命中、不影响任何一条请求的去向。
   数据面（`/__ec/p*`）一行代码都不改。文档相关端点全部挂在管理面 `/__ec/api/docs/*`，
   跟随会话鉴权 + 项目归属校验。
2. **不做 mock 的第二真值来源**。从 schema 生成的是**草稿**，必须显式落成规则才生效，
   落库走既有的 `POST /__ec/api/rules`（与 ADR-035「Mock 此接口即落库」同一条路径）。
   文档里改了返回值**不会**影响任何正在跑的 mock——这是刻意的。
3. **不引入运行时依赖**。不引入 OpenAPI 解析库、不引入 JSON Schema 校验库、不引入 YAML 库。
   导入只接受 **JSON**；YAML 让用户自己转（或后置为可选，且必须先确认依赖）。
4. **导入的内容是脏数据**。`AGENTS.md §4` 在这里是最高优先级：一条坏 schema 不得毒化整个
   store，逐条校验、坏条目丢弃并计数返回，绝不「整体失败」也绝不「整体放行」。
5. **不做「AI 自动写文档」**。AI 可以提字段建议，但写进文档必须人确认（§7.4）。

---

## 3. 对齐键（最容易做错的一处）

### 3.1 键是什么

```
key = METHOD + path 模板
```

`/api/order/{orderId}/items` ⇄ `/api/order/8848/items`

匹配算法（`server/src/docs.ts` 的 `compilePath()` / `matchEndpoint()`）：

- 按 `/` 切段，**段数必须相等**
- 文档段形如 `{id}` / `:id` / `*` → 通配段，匹配任意非空段
- 其余段**字面相等**（大小写敏感，先严格；要宽松再说，不做隐式归一）
- 多候选排序：**字面段数降序 → 段数降序 → `pathTemplate` 字典序**（最后一项只为结果稳定）
- 编译结果按 `sourceId` 缓存，导入时重建缓存

### 3.2 host 为什么不进键

抓包时的 host 是环境相关的（`127.0.0.1:8899` / 内网 IP / 测试域名 / 预发域名），
而文档里的 host 是 `servers[0].url`。**把 host 放进键 = 换个环境全部对不上，功能等于没有。**

host 只作为 `DocSource.servers[]` 的展示信息，以及覆盖率统计里的一个可选筛选维度。
query 同样不进键：同一个 path 带不同 query 通常还是同一个接口。

### 3.3 唯一的例外：同名不同义的接口

`GET /api/order/{id}` 与 `GET /api/order/{orderNo}` 在字符串层面无法区分。
真实文档里极少见；出现了就让导入时**保留两条**，匹配时按排序取第一条，
并在契约页上提示「此 path 有多个文档条目」。不做合并猜测。

---

## 4. 数据模型

贴在 `server/src/types.ts` 里，与既有风格一致（服务端字段显式列出，读路径全部兜脏值）。

```ts
/** 文档来源：一次导入 = 一个 source。同一个项目可以有多个 source（不同后端服务 / 不同版本） */
interface DocSource {
  id: string                  // src_<base36 时间><4 位随机>
  projectId: string           // 挂 Group；归属与可读性完全由 GroupStore 判
  kind: 'openapi' | 'inferred' | 'manual'
  title: string               // 展示名，如「订单服务 v2.3」
  importedAt: number
  importedBy: string          // 会话手机号，下发前按现有规则脱敏
  endpointCount: number
  /** 导入内容的 sha256，用于提示「这份文档你已经导过了」 */
  fingerprint: string
  /** 可选：原文档系统的单接口 URL 模板，含 {path} 占位；没有就不显示「去原文档」 */
  externalUrlTemplate?: string
  /** 可选：文档里声明的 servers，仅展示 */
  servers?: string[]
}

/** 一条接口契约。id 必须跨重新导入稳定，见 §5.2 */
interface DocEndpoint {
  id: string                  // ep_ + sha1(sourceId + method + pathTemplate) 前 12 位
  sourceId: string
  projectId: string           // 冗余一份，省一次 join
  origin: 'imported' | 'inferred' | 'manual'
  method: string              // 大写
  pathTemplate: string
  summary?: string
  deprecated?: boolean
  request?: DocNode
  /** 按状态码分组；status 200 是主路径，其余（4xx/5xx）也收，用于「成功 → 过期 → 风控」链路 */
  responses?: { status: number; node?: DocNode; example?: unknown }[]
  /** 反向生成时的样本数；imported 为 null */
  sampleCount?: number | null
}

/** 字段树节点。这是「字段树」不是「JSON Schema 校验器」，见 §4.1 */
interface DocNode {
  type?: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null' | 'unknown'
  /** 仅 object */
  properties?: Record<string, DocNode>
  /** 仅 array */
  items?: DocNode
  required?: string[]
  enum?: unknown[]
  description?: string
  example?: unknown
  /** 展开 $ref 时超过深度上限，或 oneOf 只取了第一支 —— 都要如实标记，不假装完整 */
  truncated?: boolean
}

/** 字段变更提案：人写的意图，重新导入文档不能冲掉它，所以单独存（§5.3） */
interface DocProposal {
  id: string                  // pr_xxx
  projectId: string
  /** 按对齐键关联，不用 endpointId —— 重新导入后 id 会变，提案不能跟着断 */
  endpointKey: { method: string; pathTemplate: string }
  author: string
  createdAt: number
  changes: DocFieldChange[]
}

interface DocFieldChange {
  target: 'request' | 'response'
  action: 'add' | 'modify' | 'remove'
  /** 点路径，如 data.list[].couponId */
  path: string
  type?: string
  required?: boolean
  description?: string
  /** 为什么要加它 —— 这段文字是提案的全部价值所在 */
  reason: string
}
```

### 4.1 schema 展开的取舍（必须写清，否则会被当成 bug）

OpenAPI 的 `$ref` / `allOf` / `oneOf` / `anyOf` / `nullable` / `format` 完整支持是无底洞。
本模块的定位是「字段树」，口径固定为：

| 构造 | 处理 | 代价 |
|---|---|---|
| `$ref` | 展开，**深度上限 6**，超限标 `truncated: true` | 递归 schema 会截断，UI 要显示「已截断」 |
| `allOf` | 合并 `properties` 与 `required`（最常见的写法） | 同名字段后者覆盖前者，冲突时保留第一个并标记 |
| `oneOf` / `anyOf` | **取第一支**，标 `truncated: true` | 多态响应只能看到一种形态 |
| `enum` / `description` / `example` | 保留 | — |
| `format` / `pattern` / `min` / `max` | 丢弃 | 不做取值校验，只做字段对齐 |

**明确不做**：JSON Schema 校验、请求体合法性校验、`additionalProperties` 语义。
一旦做了校验，这个模块就从「台账」变成了「校验器」，而校验器一旦误判就会挡住正常联调。

---

## 5. 存储布局

### 5.1 文件

```
.data/docs/index.json                  source 元数据（不含 endpoint body）
.data/docs/<sourceId>/endpoints.json   endpoint 全量（导入即整体替换该文件）
.data/docs/proposals.json              字段提案（跨 source，不随导入变化）
```

与 `.data/projects/` 同风格：一个逻辑单元一个文件，全部走 `json-file.ts` 的
「临时文件 + rename」，不手写 `writeFileSync`（ADR-033 的既有约束）。

### 5.2 为什么 endpointId 要用 hash 而不是递增

重新导入同一份文档（后端加了个字段）是最常见的操作。如果 `endpointId` 每次重新生成：

- 提案按 id 关联 → 全部失联
- 控制台上「这条规则是从哪个文档条目生成的」→ 全部断掉
- 覆盖率统计会把同一个接口算成两个

所以 `id = 'ep_' + sha1(sourceId + method + pathTemplate).slice(0, 12)`。
**path 模板改了就是新条目**，这是对的——那本来就是一个不同的接口。

### 5.3 为什么提案单独存

导入的语义是「这份文档现在长这样」，是**整体替换**；提案是「我想要它长成这样」，是**追加**。
两者混在一个文件里，重新导入就会把提案冲掉，而提案恰恰是唯一无法重建的东西
（它是人的判断，不是可再生的数据）。所以物理分开。

---

## 6. 管理面端点

全部在 `/__ec/api/docs/*`，会话鉴权 + 项目归属校验（复用 `groups.requireReadable()`，
写操作要求 `scope === 'private' && ownerPhone === 会话手机号`）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/__ec/api/docs/sources?projectId=` | 列来源（含 `endpointCount` / `fingerprint`） |
| POST | `/__ec/api/docs/import` | `{ projectId, title, format, content, externalUrlTemplate? }`，整体替换该 source |
| DELETE | `/__ec/api/docs/sources/:id` | 删来源，连带删 `<sourceId>/` 目录 |
| GET | `/__ec/api/docs/endpoints?projectId=&q=&origin=` | 列条目（不含 `responses[].example` 的大 body？含，文档本身不大） |
| GET | `/__ec/api/docs/endpoint/:id` | 单条详情 + 最近 N 条实际样本的摘要 |
| POST | `/__ec/api/docs/infer` | `{ projectId, recordIds[] }` 从记录反向生成 source（`kind: 'inferred'`） |
| POST | `/__ec/api/docs/endpoint/:id/draft` | 生成 mock 草稿，**不落库**，返回 `MockResponse` |
| GET | `/__ec/api/docs/coverage?projectId=` | 四象限统计 + 每格条目清单 |
| GET | `/__ec/api/docs/drift?projectId=` | 漂移报告（逐 endpoint 的字段差异） |
| POST | `/__ec/api/docs/proposal` | 新建提案 |
| GET | `/__ec/api/docs/proposals?projectId=` | 列提案 |
| GET | `/__ec/api/docs/proposal/:id/export?format=md\|openapi` | 导出文本（不落盘，直接返回字符串） |

**内部函数**（不暴露端点）：`matchEndpoint(projectId, method, path)` 供记录详情页调用。
记录页要显示「文档」按钮，就必须知道这条记录对上了哪个条目——这个判定放在服务端，
不放到前端（前端只拿到 `endpointId | null`，不拿全量文档做匹配）。

导入的 body 上限要单独设（默认 1 MiB 不够，OpenAPI 常见 2–5 MiB）：
`readJson(req, 16 * 1024 * 1024)`，超限 `413`。这是本次唯一放宽的上限，理由写进注释。

---

## 7. 四个能力的落地口径

### 7.1 跳转（每条记录一个按钮）

记录详情页工具栏：`[文档] [Mock 此接口] [分享快照] [复制 cURL]`。

三种状态，文案要区分开（否则用户不知道「为什么这个按钮没反应」）：

| 状态 | 按钮 | 点击后 |
|---|---|---|
| 已收录 | `文档` | 打开契约页 `/doc/:projectId/:endpointId` |
| 未收录 | `未收录 · 生成文档` | 以这条记录为样本反向生成一个条目，然后打开契约页 |
| 项目没有 source | `未接入文档` | 打开导入引导（贴 JSON / 选文件） |

契约页本身是**管理面页面**（需要会话），不是 `/s/:token` 那种免鉴权面。
文档内容可能含内网域名、字段含义，不该做成能力 URL（ADR-017 的边界只在「一条记录」）。

如果 `DocSource.externalUrlTemplate` 存在，契约页顶部额外给一个「去原文档」的外链，
用 `pathTemplate` 替换占位符。**这只是个链接，不做任何请求转发。**

### 7.2 生成 Mock（后端没做的接口）

输入：`DocEndpoint.responses` 里 status 200 的 `node`（没有就取第一个 2xx）。

生成规则：

- `object` → 递归；默认**只生成 `required` 里的字段**，可选字段最多带 1 个（避免 body 过大）
- `array` → 一个元素（`items` 递归）
- `string` → 有 `example` 用 `example`，否则 `"string"`
- `number` → 有 `example` 用 `example`，否则 `0`
- `boolean` → `false`
- `enum` → 第一个值
- `unknown` / `truncated` → `null` 并在草稿上标 `incomplete: true`

产出是 `MockResponse`（`status` + `content-type: application/json` + body），
在 Mock 编辑器里以**草稿态**呈现，用户改完点「保存为规则」才走 `POST /rules`。

> 为什么一定要人点一下：`"string"` 这种占位值在真实 App 里大概率会解析失败或显示错乱。
> 自动落库会让用户以为「mock 好了」，实际是「造了一堆看起来像数据的垃圾」。
> 这与 ADR-035 不冲突——ADR-035 说的是「Mock 此接口」这个显式动作不要二次确认，
> 而这里是「生成」不是「落库」，生成完还得看一眼。

### 7.3 契约体检（文档 vs 实际）

比较对象：`DocEndpoint.responses[200].node` 的字段树 vs 最近 N 条（默认 20）实际响应 body 的字段树。

字段树 = `点路径 → 类型集合`，如 `data.list[].id → {string}`。

四类结论：

| 结论 | 判定 | 常见原因 |
|---|---|---|
| `missingInActual` | 文档有、N 条样本里一次都没出现 | 后端没实现 / 字段名改了 / 该字段是可选且这次为空 |
| `extraInActual` | 实际有、文档没写 | 文档漏了（反哺后端） |
| `typeMismatch` | 同名但类型集合不相交（`{number}` vs `{string}`） | 后端改了类型 / 文档写错 |
| `statusDrift` | 文档主状态 200，实际 4xx/5xx 占比 > 30% | 接口本身有问题 |

**必须防的三个误报**（这三条不做，功能第一次用就会被判定为「全是噪音」）：

1. **可选字段这次没返回** ≠ 缺失。所以 `missingInActual` 一律标「疑似」，且要求样本数 ≥ 3
   才计入报告；样本不足时只显示「样本不足，无法判断」。
2. **空数组推不出元素类型**。`data.list: []` 时元素类型是**未知**，不能算 `typeMismatch`。
3. **`null` 不算类型**。`{id: null}` 记为 `null`，与 `{id: "x"}` 合并后类型集合是 `{string, null}`，
   只有在文档写死 `string` 且实际**从未**出现过 string 时才报 `typeMismatch`。

另外：**mock 命中的记录不参与体检**（`flags.mocked === true` 跳过）。
拿自己造的假数据去指责后端没实现，是这个功能最容易闹的笑话。

### 7.4 字段提案（反哺后端）

两种入口：

1. **手动**：契约页上「申请加字段」，填 `path / type / required / 说明 / 为什么`。
2. **从漂移生成**：`extraInActual` 的字段可以一键「补进提案」（文档漏了的那种）。
3. **AI 辅助（P3，可后置）**：给一段需求文本 + 现有文档，让模型提「需要加哪些字段」。
   **产出只能是提案草稿，必须人逐条确认。** 模型不认识你们的业务，它提的字段名十有八九要改，
   直接写进文档等于用幻觉污染契约。

导出格式（`GET /proposal/:id/export?format=md`）：

```markdown
## POST /api/order/create

### 请求新增字段

| 字段 | 类型 | 必填 | 说明 | 提出人 |
|---|---|---|---|---|
| couponId | string | 否 | 优惠券 ID，不传表示不使用优惠券 | 138****0000 |
```

`format=openapi` 时导出只含变更部分的片段（`paths` + `components` 里相关的 schema），
方便后端直接合进自己的文档工程。

**不自动写回任何外部文档系统。** 没有写权限、也不该有——写错了是别人的生产事故。

---

## 8. 控制台落点（不加顶级导航项）

现在 `index.html` 是三个顶级模式（浏览 / Mock / 模板，`.ms-btn`），模板模式里已有两个 tab
（私有项目 / 共享项目，`.tpl-tab`）。**不新增第四个顶级模式**——文档永远属于某个项目，
加顶级模式就得再放一个项目选择器，多一处状态要同步。

| 落点 | 位置 | 频率 | 做什么 |
|---|---|---|---|
| A | 记录详情页工具栏 | 高 | `文档` / `未收录 · 生成文档` / `未接入文档` |
| B | Mock 编辑器每条规则旁 | 中 | `文档` 链接 + `按文档生成返回值` |
| C | 模板模式 → 项目详情 → 第三个 tab「文档」 | 低 | 导入 / 列条目 / 覆盖率四象限 / 漂移报告 / 提案 |
| D | 独立契约页 `/doc/:projectId/:endpointId` | 中 | 三栏：参数表 ｜ 响应树 ｜ 实际样本 + 差异 |

C 的 tab 顺序建议 `规则 · 文档 · 历史`——文档和规则是同一个项目的两种描述，放一起才对得上。

D 做成独立页面而不是抽屉，理由是它要能贴给别人看（局域网内同事直接打开链接），
而抽屉必须先进控制台登录。这与 ADR-034「管理界面独立成页」同一条思路。

---

## 9. 分期

| 阶段 | 内容 | 依赖 | 验收要点 |
|---|---|---|---|
| **P0** | `types.ts` 类型 + `docs.ts`（store + path 编译 + OpenAPI 导入）+ 6 个端点 + 记录页按钮 + 契约页骨架 | 无 | 导入一份真实 OpenAPI，记录能对上条目；坏 schema 不崩；脏 path 不误匹配 |
| **P1** | 反向生成（`infer`）+ 覆盖率四象限 | P0 | 从 20 条记录生成条目，出现率统计正确；`/api/order/list` 不被误合并成 `{p1}` |
| **P2** | schema → mock 草稿 → 保存为规则 | P0 | 生成 body 能被 App 正常解析（不是 `""` 空串）；不自动落库 |
| **P3** | 漂移检测 + 提案导出 | P1 | 三条防误报都锁住；mock 记录被排除 |
| **P4** | AI 辅助提字段（可选） | P3 | 产出只能是草稿，逐条人工确认 |

P0 大约一天，P1/P2 各半天到一天，P3 一天。**P0 不做完不要碰 P2**——
没有对齐键，生成出来的 mock 挂不到任何记录上，等于白做。

---

## 10. 已知坑（实现前先看）

1. **`readJson` 默认 1 MiB**，OpenAPI 常常超。导入端点必须单独传 limit，否则大文档直接 413
   而用户看到的是「导入失败」，会以为格式错了。
2. **`$ref` 指向 `#/components/schemas/Xxx` 之外的形式**（外部文件、URL）一律丢弃并标记，
   不要试图去 fetch——那是 SSRF，而且数据面已经有 SSRF 争议了，别再开一个。
3. **path 大小写**：`/api/User` 与 `/api/user` 在后端可能是两个接口，也可能是一个。
   先严格匹配，报「未收录」时 UI 上给一句「大小写可能不一致」的提示，不做自动回退。
4. **同一 path 多个 method**：`GET` 与 `POST` 是两个条目，键里 method 必须参与。
5. **重新导入的提示**：`fingerprint` 相同就别导了，直接提示「这份已经导过」；
   不同则提示「将替换 N 个条目，M 个提案会保留但可能失联」。
6. **`.data/docs/` 要确认已在 gitignore 覆盖范围内**（`.data/` 整体已忽略，新目录不用改）。
7. **归属校验不能只在前端**：契约页是独立页面，直接敲 URL 也要挡。复用 `groups.requireReadable()`，
   非 owner 的私有项目一律 404（与 `ruleNotYours` 同形，不泄露存在性）。

---

## 11. 待拍板（这三个定了才好开工）

1. **文档挂项目，还是挂「服务」这个新维度？**
   本方案挂项目（复用 `Group`，零新增归属维度）。代价：同一个后端服务被拆成两个项目时，
   文档要导两份。若坚持「文档属于服务」，就得新增一层 `Service` 实体，与 `Group` 形成两个可写容器
   ——那正是 ADR-030 反对的形态。
2. **导入只收 JSON，还是必须支持 YAML？**
   只收 JSON 符合「不新增依赖」。YAML 需要引入解析器（违反 AGENTS.md §1），或者让用户自己转。
   如果你们现在的文档系统导出只有 YAML，这条要重新算。
3. **要不要做「从外部文档系统定时拉取」？**
   本方案不做（P0–P3 都是导入式）。做的话需要每家一套适配器 + 存 token，而且文档系统一挂工具就废。
   建议先导入式跑一段，确认真的痛了再说。
