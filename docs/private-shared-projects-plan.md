# 私有 / 共享 Mock 项目实施计划

> 状态：**阶段 A（契约与决策文件）与阶段 B（服务端）、阶段 C（控制台）均已完成**（2026-10-16）。
> 阶段 A：ADR-033 已写入 `docs/decisions.md`（并回写 ADR-018 / 019 / 030 的修订指针），
> 协议 C14、架构 §5.5 / §6.3 / §9、roadmap P7 已同步。
> 阶段 B：`server/src/types.ts` / `groups.ts` / `rules.ts` / `projects.ts` / `ec-error.ts` / `json-file.ts` /
> `data-plane.ts` / `index.ts` 已落地，`tools/selftest.ts` 515/0。
> 阶段 C：`server/web/index.html` 两栏项目与**作用域安全保存**已落地，`tools/console-mock-check.mjs` 153/0，
> 并完成本机浏览器端到端走查（像素级视觉与拖拽手势 📅 待人工）。
> **仍在阶段 D**：CLI（`tools/mock-cli/selftest.ts` 当前 344/109 红）、README 用法与升级提示、启动日志的历史占用那一行。
> 本文件下面描述的是目标态，未打勾的行不表示功能已经完成。
>
> 范围：EasyCharles 单个服务实例内的登录用户。这里的“全局共享”是本实例中所有已登录用户可见，不是跨服务器或匿名公开。
>
> 与契约的两处**已定偏差**（实施时按契约，不按本文件）：
> ① §3.2 的 `ProjectLineage` 独立表在协议 §5.5 里收进了 private 项目对象自身（`originSharedProjectId` /
> `copiedFromVersionId` / `lineage`），字段语义不变，只为避免映射与项目分两处写必然漂移；
> ② 本文件 §5 命中规则没有写到的那处冲突——C13 的「悬空 `groupId` 按未分组处理（照常命中）」兜底
> （ADR-030 决策 3）在 C14 下**结论翻转**为「无归属即不命中」；翻转不产生静默失效的两个前置硬约束
> 写在协议 **§5.4**，实现前必须重读那一条。

## 1. 用户已确认的行为

1. 项目分为用户私有和全局共享两类。**运行时只使用当前设备所有者的私有项目规则**；共享项目是只读模板，必须复制到自己的私有区后才会参与 mock。共享项目本身永不直接命中数据面。
2. 用户可以同时启用多个私有项目。一个请求匹配到多个私有规则时，按现有规则优先级 `priority` 从高到低选择。
3. 私有项目分享后保留私有原件。首次分享创建共享副本并建立来源关联；从共享项目复制得到的私有项目再次分享时，**用该私有项目的完整内容覆盖来源共享项目当前内容**（last write wins）。不做三方冲突合并。
4. 每次成功分享都保存一个不可变历史版本，并记录分享人和服务端时间。用户可以选择任意历史版本回退；回退是新增一次历史提交，不删除或改写原有历史。

## 2. 当前实现与需要改写的边界

- 现有 `Group` 是全局规则容器，`Rule.groupId` 关联项目，`action.response(s)` 保存返回值。继续复用，不增加 `Module` 实体。
- 现有 `rules.json` 中的规则对所有请求生效，规则管理 API 对所有持有会话的用户可写；这与本计划的私有隔离冲突。
- `RuleEngine.resolve()` 当前只检查规则开关、分组开关、匹配条件和 `priority`。数据面已有 `deviceId`，`Store.deviceOwner(deviceId)` 可提供私有规则的用户归属依据。
- ~~控制台目前通过 `PUT /__ec/api/rules` 全量替换规则~~ 按用户过滤后继续全局替换会删除其它用户不可见的规则，
  必须改成作用域安全的写入。**✅ 阶段 C 已改完**：编辑与保存走单条端点，全量 `PUT /rules` 只留在
  「原始 JSON」抽屉里且提交前先按私有项目 id 做本地预检（见架构 §5.3）。
- 现有 `mock-cli project` 表示目标 EasyCharles 服务地址，不得改作业务 Mock 项目。继续用 `group` 概念或在控制台显示“项目”。

本需求实质上修改了 ADR-018「全局规则所有登录用户可写」和 ADR-030「分组全局共享」的决策。不得只改 UI 或直接按当前 ADR 实现；先修订 ADR 并更新协议契约。

## 3. 目标模型

### 3.1 项目容器

沿用现有 `Group` 存储概念，增加并由服务端管理下列字段：

```ts
type ProjectScope = 'private' | 'shared'

interface Group {
  id: string
  name: string
  enabled: boolean              // private 项目的运行开关；shared 项目不参与运行时
  scope: ProjectScope
  ownerPhone: string | null     // private 必须是创建人的手机号；shared 必须为 null
  createdBy: string | null      // 首次创建/发布人；旧数据允许 null
  createdAt: number
  updatedAt: number
  currentVersionId?: string    // shared 当前内容对应的历史版本
  originSharedProjectId?: string // private 副本的来源共享项目；首次分享后也建立该关联
}
```

服务端从已认证 session 得到 `phone`，不信任请求体中的 `ownerPhone`、`createdBy`、分享人或时间。手机号是现有稳定账号标识；控制台默认脱敏展示。

`Rule` 仍只通过 `groupId` 归属项目，响应数据形状与匹配语义不变。private 新规则必须归属当前用户的 private 项目；不允许新建无归属规则。

### 3.2 私有副本来源映射

shared → private 复制时，为本地规则生成不冲突的新 `Rule.id`，记录稳定映射：

```ts
interface ProjectLineage {
  privateProjectId: string
  sharedProjectId: string
  copiedFromVersionId: string
  ruleMap: Array<{ sharedRuleId: string; privateRuleId: string }>
}
```

映射用于覆盖时保留原共享规则 ID、序列指针身份和规则追踪；它**不用于三方冲突检测**。私有新建规则在分享时分配共享 ID；复制后删除的映射规则在下一次分享时从共享项目删除。项目副本不能通过 `/rules` 直接给其它项目的规则改组。

### 3.3 历史版本与分享记录

每次成功 publish、merge/share 或 rollback 创建不可变提交：

```ts
interface ProjectVersion {
  id: string
  projectId: string
  parentVersionId: string | null
  operation: 'publish' | 'share' | 'rollback'
  actorPhone: string
  createdAt: number             // 服务端时间
  rollbackOf?: string
  ruleCount: number
  snapshotFile: string          // 内部路径，不下发客户端
}
```

版本快照包含完整共享项目定义及其完整规则/返回值。`currentVersionId` 指向当前共享内容。历史事件顺序不可修改；回退只把选定快照恢复为当前内容，并新增一个 `rollback` 版本，记录 `rollbackOf`。

默认保留全部版本，不做静默清理，因为用户要求可回退任意历史分享。需在 UI/README 说明历史版本也会保留已移除的 response body，可能包含敏感数据并持续占用 `.data/` 空间。列表对登录用户可见，分享人手机号脱敏展示。

## 4. 权限矩阵

| 操作 | 自己的 private | 其它用户 private | shared |
|---|---:|---:|---:|
| 列表/详情 | 允许 | 隐藏，按不存在返回 | 所有登录用户可读 |
| 编辑接口/返回值 | 允许 | 拒绝 | 直接编辑拒绝 |
| 数据面命中 | 当前设备 owner 匹配时可用 | 不可用 | 永不直接命中 |
| 复制 | 不适用 | 不适用 | 所有登录用户可复制到自己的 private 区 |
| 分享到 shared | 发布/覆盖其来源 shared 项目 | 拒绝 | 不能直接提交 shared 内容 |
| 回退 | 不适用 | 拒绝 | 本计划默认所有登录用户可回退任意历史版本；操作追加 actor/time/version 记录 |

**权限推导**：任何登录用户都能复制 shared，然后按产品决定覆盖来源共享项目；因此任何登录用户实际拥有覆盖和回退权限。服务端仍必须鉴权，并将每次操作留痕。这不是管理员权限，不能靠前端隐藏来实现。

如果产品不接受所有登录用户覆盖/回退，则需增加共享项目维护者 ACL；这会改变用户已确认的“本地副本直接覆盖”和“自由回退”口径，暂不擅自加 ACL。

## 5. 命中规则

1. 从请求的 `deviceId` 查询 `ownerPhone = store.deviceOwner(deviceId)`。owner 为 `null` 的未绑定设备没有 private 项目可用。
2. 候选规则必须同时满足：`rule.enabled === true`、所属 private 项目 `enabled === true`、项目 `ownerPhone === ownerPhone`、METHOD/HOST/PATH/params 匹配。
3. shared 项目和 shared 规则永不加入数据面候选集；即使规则 ID 和匹配条件合法，也不能直接命中。
4. 多个 private 项目可以同时启用。多个规则命中时仍只取 `priority` 最高者，保持现有「按 priority 降序」语义；相同 priority 延续现有稳定排序，即保持规则数组中先出现者优先。不得新增“私有项目优先于私有项目”的层级。
5. 规则响应的 `static` / `specific` / `sequence`、指针按 deviceId 隔离等行为不变。

## 6. 操作流程

### 6.1 新建并首次分享

1. 创建 private 项目，owner 由 session 推导；项目只对 owner 可见，默认启用。
2. 用户编辑接口和返回值，规则归该 private 项目。
3. 点“分享到共享库”：服务端创建 shared 项目及第一份版本快照，创建首条 `publish` 记录；private 项目保持原样，并设置 `originSharedProjectId`，之后可继续编辑和重新分享。
4. 首次发布后 shared 项目可被全体登录用户看到/复制，但不生效。

### 6.2 从共享库复制

1. 用户在共享列表选择项目并执行“复制到我的项目”。
2. 服务端确认源为 shared，建立 owner 为当前用户的新 private 项目，复制全部规则、入参条件、headers、body、多个 responses、顺序配置及规则开关。
3. 复制后的 project 默认启用；每条 rule 保留原 `enabled`。如任一规则 disabled，复制后仍 disabled。
4. 为规则分配新的本地 ID，保存 `ProjectLineage` 映射和复制来源版本。
5. 复制事件可单独写入审计（非 share event）；不得改写源共享版本或源历史。

### 6.3 再次分享（整项目覆盖）

1. 只有 owner 能从 private 项目执行。来源必须仍为 shared 项目；无来源的 private 项目走首次发布。
2. 服务端以 private 项目完整当前定义替换来源 shared 项目的当前规则清单及可分享元数据；不执行三方合并，不把当前共享新增内容合并进来。**最后一次成功分享胜出**。
3. 依据 `ruleMap` 将已有规则恢复为原共享 ID；新增规则生成新共享 ID；本地已删除的映射规则不再出现在共享清单中。
4. 每次成功分享创建新的 immutable snapshot，更新 shared `currentVersionId`，追加 `share` 版本记录（actor/time/版本/来源项目）。前序版本保持不变。
5. 若目标 shared revision 在用户打开确认框后变化，服务端仍按用户确认执行覆盖；控制台必须显示“目标已有新版本，将以当前私有项目完整覆盖”，列出规则数变化并二次确认。不要静默做冲突合并。
6. 用 `operationId` 做幂等：同一请求因网络超时重发不能重复生成版本或重复审计。

### 6.4 回退

1. shared 项目历史页列出每次 publish/share/rollback 的时间、分享人、规则数和版本 ID。
2. 用户可选任意版本查看摘要并回退；允许从任一历史点回退，也允许再回退到更早的点。
3. 回退恢复该版本完整快照为当前 shared 内容，新增 `rollback` 版本，记录操作人、时间、目标版本及 `rollbackOf`；所有旧版本继续可用。
4. 回退失败不得改 active rules、`currentVersionId` 或 history。

## 7. 管理面 API 草案

继续走会话鉴权的管理面 `/__ec/api/*`，绝不在数据面新增项目接口。为兼容现有 `mock group` CLI，建议暂时保留 `/groups` 路由与内部 `Group` 类型，控制台显示“项目”；所有写操作从 session 推导 owner/audit。

- `GET /groups?scope=private|shared`：private 只回当前用户；shared 回所有共享项目。默认返回元数据和 ruleCount，不回所有 response body。
- `POST /groups`：只创建 private；请求体不得指定 `scope=shared`、owner、creator 或时间。
- `GET /groups/:id`、`GET /groups/:id/rules`：private 非 owner 返回 404；shared 返回详情/规则；列表可按项目分页或按需加载。
- `POST /groups/:sharedId/copy`：服务端完成复制并回 private project ID。
- `POST /groups/:privateId/share`：首次发布或覆盖已关联的 shared 项目；body 只含 `operationId` 与确认的目标 revision，不接收客户端提交的完整 Rule[]。
- `GET /groups/:sharedId/versions`：历史元数据，不带完整快照 body。
- `GET /groups/:sharedId/versions/:versionId`：回退预览所需摘要；完整快照不直接可写。
- `POST /groups/:sharedId/rollback`：body `{ versionId, operationId }`，恢复任意有效版本并追加 rollback commit。
- 现有 group CRUD：private 只允许 owner；shared 项目的直接编辑/删除一律拒绝，内容只能由 share/rollback 提交。
- `GET /rules` 默认只返回调用者自己的 private 规则；shared 规则通过 `/groups/:id/rules` 按项目读取。
- `PUT /rules` 保留现有控制台批量保存入口，但改成“调用者 private 规则范围替换”：输入中每条规则必须属于调用者的 private group，拒绝无 groupId / shared groupId / 他人 groupId / 重复 ID；提交时只替换该调用者 private 规则，并完整保留 shared 与其它用户规则。单条 POST/PUT/DELETE/enabled 同样验证 group owner。不得保留任何可由普通用户全局替换 `rules.json` 的路径。

合并/回退由服务端按 project ID 从存储读取，不能要求客户端上传完整项目。当前 JSON 管理面 body 上限为 1 MiB；服务器内部复制仍需限制/检测实际落盘字节数，并给出可读错误，不能部分写入。

## 8. 存储、迁移和崩溃恢复

### 8.1 迁移规则

- 旧 `groups.json` 项目一律迁为 `scope: 'shared'`，保留 group ID、名称、开关和时间；创建人设为 `null`，UI 显示“历史项目 / 创建人未知”，禁止伪造创建人。
- 旧的未分组规则及 `groupId` 指向不存在 group 的悬空规则归入一个服务端生成的旧版共享容器（如“旧版共享规则”），保留 Rule ID 和 action，确保它们可被复制。旧 group 指向的规则仍留在对应迁移后的 shared 项目。
- 旧 shared 项目及未分组规则从运行时候选中移除；用户需复制到 private 后恢复 mock。这是明确的行为变更，升级提示/README 必须写明。
- private 项目不得被删除后“脱组”成为 shared/全局规则。private 删除要级联移除其 active rules，或先归档停用；选择硬删时必须有显式确认。
- shared 有历史版本时不做物理删除，只允许归档；归档不删除 snapshots 和分享记录。

### 8.2 数据文件和原子提交

- 项目元信息仍落现有 `groups.json`，active rules 仍落 `rules.json`；历史完整快照放 `.data/` 内的新版本存储（例如按 projectId/versionId 分文件）。不改任何配置文件格式，也不加运行时依赖。
- share/rollback 先校验完整新状态（Group、规则数组、所有 action/responses、body 实际字节等），再写 immutable snapshot，最后提交 active rules、`currentVersionId` 与历史索引。
- 因 active rules 与 project 元信息是两个文件，增加 pending journal：崩溃时启动恢复按 `operationId` 幂等完成或回滚整笔提交。不能“逐条 PUT 成功几条算几条”。
  - ✅ **实现口径已改正本条**：恢复**只做前滚**，快照与 journal 齐 ⇒ 重放提交第 4、5 步；
    快照文件缺失 ⇒ active 一字不动、清 pending 并报告 `abandoned`。理由：journal 只存 `after`，
    凭它写不出「旧状态」，伪造后滚等于把数据搞得更糟（协议 §5.5 / 架构 §6.3 已同步为这个口径）。
    本档 §8.2 这一句与架构原先那句都属同一处笔误，不是两种可选实现。
- 使用临时文件 + rename 更新 JSON；完整提交前不改变内存活动状态。恢复后重载状态与当前快照校验一致。
- 历史按用户要求默认无限保留；启动/管理面给出历史字节用量。不得因超限悄悄删历史。若后续要限额，需单独决策保留策略。

## 9. 实施阶段与文件清单

### 阶段 A：契约与决策文件（✅ 2026-10-16 完成）

- [x] `docs/decisions.md`：**ADR-033** 已新增，并在 ADR-018 边界 4 / ADR-019 边界 2 / ADR-030 状态、决策 4 与「明确不做」四处回写修订指针（原文保留）
- [x] `docs/protocol.md`：C14 变更记录、§3.3 数据面候选集、§4.7 端点与权限矩阵与迁移口径、§5.4 命中语义、§5.5 schema 与 journal、§6.1 五个新错误码、§7 第 8~11 条、§9 版本划分
- [x] `docs/architecture.md`：§2 模块地图、§5.3 适用边界、§5.5 候选过滤数据流、§6.3 快照与 journal、§9 安全模型、§11 差距、§12 目录
- [x] `docs/roadmap.md`：P7 里程碑（阶段 A ✅、B/C/D 全为 📅）与批内严格按序的依赖图

### 阶段 B：服务端数据隔离（✅ 2026-10-16 完成，本机全绿；远端与多账号验收 📅）

- [x] `server/src/types.ts`：✅ 2026-10-16 完成（`ProjectScope` / `Group` 的 C14 可选字段 / `ProjectLineageEntry` /
  `ProjectVersion` / `ProjectVersionView` / `ProjectHistoryIndex` / `GroupClientInput` / `GROUP_SERVER_FIELDS`）。
  两处**与本文档不同的实现决定**：① `ProjectLineage` 独立表收进 private 项目对象（见文件头偏差 ①）；
  ② journal 的事务类型**不进全局类型文件**，由版本服务模块自己定
- [x] `server/src/groups.ts`：`visible(phone, scope?)` / `isPrivateOf` / `requireReadable` / `requireEditable`
  做列表过滤与归属校验；shared 只读（内容改动只经 `ProjectService`，管理面只有 `setArchived` 能动它）；
  `currentVersionId` 与 `archived` 落在这里；`ensureLegacySharedContainer(name)` 供迁移用；
  脏值读路径按协议 §5.5 收敛到「不进任何人的候选集」（`scope` 脏 → shared、`ownerPhone` 脏 → null、
  版本指针脏 → 当作没有），**不因一条脏数据让启动崩溃**
- [x] `server/src/rules.ts`：`listForOwner` / `replacePrivateScope` / `create` / `replaceOne` / `remove` /
  `setEnabled` / `resetPointers`（另有 `listOfGroup` / `removeByGroup` / `countByGroup`）按 owner 收口；
  `resolve()` 只取当前 owner 的 enabled private projects；多项目仍按全局 `priority` 稳定排序。
  `replaceAll()` 降为**内部整表写入**（版本服务 / journal 恢复 / 测试夹具），管理面不再经过它。
  写入口的归属栅栏 `requirePrivateGroup()` 把「无 groupId / 指向 shared / 指向他人或不存在」
  三种情况分开报错，但**「他人」与「不存在」用同一句文案**，不泄露存在性
- [x] `server/src/data-plane.ts`：把 `store.deviceOwner(deviceId)` 传进 resolver（与 `recordVisible()`
  同一个函数，不另起归属真值来源）；未绑定 owner 不命中任何 private rule；shared rule 在这一层就被排除，
  因此共享序列指针天然不推进。**数据面仍然不鉴权**，未绑定设备照样原样转发上游
- [x] `server/src/index.ts`：管理面所有规则/项目端点由 `sessionPhone(req)` 授权；shared 内容只读；
  copy / share / rollback / archive / 单项目详情 / 按项目读规则 / versions / versionDetail 落地；
  `PUT /rules` 收窄为私有范围替换（`{ok,replaced,preserved,count}`），不再能覆盖其它作用域；
  他人的私有项目与规则一律 `404`（与不存在同形）；启动顺序 **recover → migrate → listen**，
  横幅如实打印迁移条数与 journal 的 `abandoned`
- [x] 原子版本服务：**新增 `server/src/projects.ts`**（未新增顶层目录）。`.data/projects/<pid>/<vid>.json`
  不可变快照 + `index.json` 历史索引 + `journal.json`（`pending` + 最近 100 条 `receipts`）；
  提交五步序见协议 §5.5 / 架构 §6.3；`recover()` **只做前滚**，快照缺失时报 `abandoned` 并清 pending
  （**修正了本文档 §8.2 与架构 §6.3 原先写的「回滚到 journal 旧状态」**：journal 只存 `after`，写不出旧状态）
- [x] 新增 `server/src/ec-error.ts`（五个管理面码一处定义、`ecBody()` 统一折算，老错误沿用既有 `error` 字符串，
  不打断按字符串分支的存量客户端）与 `server/src/json-file.ts`（`.data/` 内 JSON 唯一写法：同目录临时文件 + rename）
- [x] 私有项目删除**级联删自己的规则**（`{ok,removedRules}`）；shared 非空或有历史**不给删**（`409`，只能归档）；
  迁移**不留无归属规则**（未分组 / 悬空 groupId / private 但 owner 为空 都收进「旧版共享规则」容器，
  只在真动过时才建容器，重复启动幂等）
- [x] `server/tools/selftest.ts` 补 C14 用例（515 通过 / 0 失败），含**每个新写入口的非法输入用例**；
  `tools/console-mock-check.mjs` 98 / 0；`tsc --noEmit` ×2 无错
- [x] 文档状态回写：协议 §0/§3.3/§4.7/§5.4/§5.5/§6.1/§7、架构 §2/§5.3/§5.5/§6.3/§9/§12、
  ADR-030 与 ADR-033、roadmap P7（含两个「实现自己拍的数」登记为待产品确认：快照 64 MiB 上限、副本名 `(副本)`）
- [x] ~~📅 **本阶段留下两个必须靠阶段 C / D 补的缺口**~~（不是 bug，别在服务端放宽兜底）：
  ① ✅ **阶段 C 已补**：控制台的整页保存不再走全局 `PUT /rules`，新建规则不再必 `400`；
  ② 🔧 **仍在阶段 D**：`tools/mock-cli/selftest.ts` **344 通过 / 109 失败**，CLI 仍按 C13 口径写无归属规则

### 阶段 C：控制台 ✅（2026-10-16 本机完成，视觉与拖拽手势 📅 待人工）

- [x] `server/web/index.html`：增加“我的项目 / 共享项目”导航；mock 编辑器仅操作 private 项目。
- [x] 我的项目列表展示启用状态、接口数；支持创建、启停、复制来源、编辑接口/多个返回值、首次发布、再次覆盖分享。
- [x] 共享项目列表只读展示，支持查看 creator、分享历史、复制到我的项目、版本预览与回退。
- [x] overwrite 前展示完整替换警告与接口数增删（含「名称也会跟着变」这一项，因为服务端整项目覆盖含 name）；
  成功后由服务端回传最终版本/时间，前端不得生成分享时间。
- [x] 旧控制台全量规则保存改为作用域安全写入；保存冲突或 4xx 时保留草稿、不显示成功提示。
- [x] 分享人/创建人手机号默认脱敏；共享历史中不能返回私有项目规则或私有项目 ID（服务端下发前已脱敏，
  `snapshotFile` 内部路径永不下发）。
- [ ] 📅 像素级视觉复核与拖拽换序手感：本机浏览器自动化拿不到真实视口
  （`click` / `take_screenshot` 报 `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`，改由页面自身的 `onclick` 处理器驱动），
  逻辑与文案已核过，外观与手势需要人工看一眼。

### 阶段 D：mock CLI 与文档 ✅（2026-10-16 本机完成）

- [x] `server/tools/mock-cli/cli/commands/group.ts`：区分 private/shared；CLI project 仍是服务地址别名。
- [x] `api list/get/create/update/switch/delete/copy`：默认归属唯一私有项目 / 本地默认项目（推不出唯一答案报错不猜）；
  明确拒绝写 shared 规则；`--group-id` 在每类子命令上有明确语义（筛选 / 归属校验 / 拒绝挪动）。
- [x] 增加 group `copy`、`share`、`history`、`rollback`、`archive` 命令；share/rollback 写后读回
  版本 ID、actor、时间验证；`--expected-version` 乐观锁、`--operation-id` 幂等回执都落到 CLI。
- [x] 更新 README 与 CLI help：shared 不直接 mock，必须 copy；再 share 是整项目覆盖；
  rollback 会产生新版本且不清历史；README 末尾补了 `g_legacy_shared` 迁移的升级提示。
- [x] 启动日志补「项目历史占用」行（实际字节数 + 文件数 + 项目数，协议 §5.5/§7 第 10 条）。
- [x] `tools/mock-cli/selftest.ts` 按 C14 重做（夹具补归属、C12 重写、新增 C13 专项）：**514/0**。

## 10. 必须覆盖的验收清单

> ✅ = **阶段 B 由 `server/tools/selftest.ts` 覆盖**（515 项，本机进程内用例）、
> **阶段 C 由 `tools/console-mock-check.mjs`（153 项）+ 本机浏览器端到端走查覆盖**；
> 📅 = 只有真机 / 远端多账号 / 人工视觉才能证明，**本机用例证不了**，不要当成已通过。

### 权限与命中

- [x] ✅ userA 的 private project / rules 对 userB 的列表、详情和写接口不可见（统一 404，与「不存在」同形），伪造 `ownerPhone` / `createdBy` 一律 `400 EC_SCOPE_MISMATCH`（黑名单字段在 `types.ts` 的 `GROUP_SERVER_FIELDS`，写入口逐条拒）。
- [x] ✅ shared project 规则即使 enabled 且匹配，也不会在数据面直接命中；copy 后 private 规则命中。
- [x] ✅ userA private 规则只命中 A 绑定设备；userB 设备、未绑定设备、**伪造一个不存在/未绑定的** deviceId 都不命中（候选集为空 ⇒ 原样转发上游，不是拒绝）。
  - ⚠️ **本条有一处不能算通过**：拿**别人已绑定的真 deviceId** 是**会**命中那个工作空间的私有规则的——
    数据面不鉴权（ADR-015），C14 之后设备头从「决定你能看谁的记录」升级成「决定跑谁的规则集」。
    兜它的是既有的 UUID 不可枚举 + 默认只监听回环，不是新机制；要收成凭据级别 = roadmap P1 的数据面鉴权。
    已在协议 §3.3 第 10 条如实写明，别在本清单里把它勾成 ✅。
- [x] ✅ A/B 私有项目同时开启；同 API 多规则按 priority 选择；priority 相同按表内顺序稳定取第一条；passthrough 高优先级遮蔽低优先级 mock 行为保持一致（归属先于 priority：B 的 9 优先级压不到 A 的规则）。
- [x] ✅ 不同 private projects 的 responses/sequence 仍按 `(deviceId, ruleId)` 隔离；shared sequence 永不推进；关项目期间不占序列位、重开从半截继续；A 重置指针清不动 B 的。

### 复制、覆盖、历史和回退

- [x] ✅ 复制保留 method/host/path/params、headers、status/body、`responses[]`/name/cond、mode/seqMode/pinIndex/delayMs、enabled 和 priority；新 Rule ID 由服务端分配，不与 shared 或其它 private 撞号；关着的规则复制过来仍是关着的；副本是深拷贝（改副本 body 不串改源）。
- [x] ✅ 两次复制同一个 shared project 产生互相隔离的私有项目与 lineage 映射；C 看不见 B 的副本。
- [x] ✅ 再分享完整覆盖原 shared 项目：新增、修改、删除都如实反映；同一 `operationId` 重发只生成一次版本（回执，不按内容哈希）。
- [x] ✅ 两个不同用户先后 share：后一次完整覆盖前一次，历史保留两次快照并按时间升序、actor 已脱敏、时间来自服务器时钟。
  - 📅 **真并发**（两个请求同时在途）没测：本机用例是顺序调用，只证明了 last-write-wins 的结果形态，没证明竞态窗口。
- [x] ✅ 回退到任意旧版本后，shared 当前内容与其快照逐字段一致；回退本身新增一条 `rollback` 版本并记 `rollbackOf`；可从任一历史点起跳、也可回退更早的点；回退后的共享内容依然永不命中。
- [x] ✅ 非法规则 / 对象代替数组 / 标量 response / 缺字段 / 超大 body（65 MiB 撞 64 MiB）/ 坏快照 / 脏 journal / 脏历史索引 / 提交途中进程中断：都不留半提交，active + 两份表 + 历史三者一致，重启后 `recover()` 结果确定（前滚或 `abandoned`）。
  - 📅 **真的把磁盘写满**（ENOSPC）没测：用例用「快照文件被删 / 内容被改坏」等价构造失败点。
- [x] ✅ shared 归档不删快照与历史、之后仍可查可回退；private 删除级联删自己的规则并丢弃序列指针；有历史的 shared 禁止物理删除；历史快照不会被普通删除接口抹掉。

### 兼容、大小和并发

- [x] ✅ 旧坏 JSON、顶层非数组、坏 owner/scope/version/history 字段不导致启动崩溃（读路径与恢复路径各有兜底，脏条目只丢不抛）；每个新 HTTP 写入口都补了非法输入用例。
- [x] ✅ 并发编辑不同 private 项目互不覆盖（`replacePrivateScope` 只动调用者范围内那几条，别人的与共享的原样留着）；同一 shared 的先后覆盖形态正确（见上，真并发窗口 📅）。
- [x] ✅ 复制/分享全在服务端内部完成（客户端不上传完整项目）；大小按**实际 UTF-8 字节数**判定，`storageUsage()` 逐文件 `statSync` 核对且不含 journal.json；失败不留半写文件（`json-file.ts` 同目录临时文件 + rename，异常时清临时文件）。
- [x] ✅ `server/tools/selftest.ts` 覆盖数据面隔离、迁移（含幂等与「空表不建容器」）、脏数据、journal 恢复、版本一致性；`tools/console-mock-check.mjs` **153/0** 覆盖控制台纯逻辑（阶段 C 把项目归属、覆盖差分、`operationId` 复用、私有范围预检四类切出来钉死）。
- [x] ✅ `tools/mock-cli/selftest.ts` 按 C14 口径重做（阶段 D，2026-10-16）：**514/0**——夹具规则全部挂进私有项目、
  C12 改按「命中 = 规则 enabled 且项目私有且归属设备 owner 且项目 enabled」、新增 C13 专项
  （缺省归属推断、share 首发/覆盖/乐观锁、copy 独立命中、归档、rollback、幂等回执、共享只读、
  删私有项目级联、脏输入零写入）。此前 344/109 红是因为 CLI 还是 C13 口径，未用放宽服务端校验或 skip 掩盖。
- [x] ✅ 控制台侧验收（阶段 C，2026-10-16 本机浏览器）：两栏可见范围（13900000000 只见共享与自己的副本）、
  作用域安全保存（提交他项目/无归属规则被本地预检拦下，**零次写请求**；`[]` 只清自己的私有范围）、
  4xx 与本地非法 JSON 都保留草稿且不报成功、二次确认显示的是服务端回传的 versionId / `createdAt` / actor
  （回退后历史 3 → 4 条且当前内容逐字段一致）、手机号脱敏与「发布人未知 / 发布人：你 / 他人空间」三种文案。
  - 📅 同一批还需要**真浏览器里的人工复核**：像素级外观与拖拽换序手感（自动化的视口拿不到，见 §9 阶段 C 最后一条）。
- [x] ✅ 远端实例 + 两个手机号的多账号实测（2026-10-16，部署机真实 `--data-dir`，28/28 全绿；
  权限 404/400、命中归属、copy ≠ 引用、覆盖/历史/回退/幂等、清理路径全过）。
  ⚠️ 设备是 `/__ec/hello` + bind 造的模拟设备头，**不是真机 SDK**——「两台真机走完整 SDK 链路」仍 📅。
- [x] ✅ 门禁执行记录（2026-10-16 本机，阶段 B 与服务端）：`npx tsc --noEmit` 0 错、`tsc -p tsconfig.cli.json` 0 错、
  `node tools/selftest.ts` **515/0**、`node tools/console-mock-check.mjs` **98/0**（当时）；
  `node tools/mock-cli/selftest.ts` **344/109 红**，未用放宽服务端校验或 skip 用例来掩盖。
- [x] ✅ 门禁执行记录（2026-10-16 本机，阶段 C 控制台）：`npx tsc --noEmit` 0 错、`tsc -p tsconfig.cli.json` 0 错、
  `node tools/selftest.ts` **515/0**（未改动服务端，回归不变）、`node tools/console-mock-check.mjs` **153/0**；
  CLI 仍 **344/109 红**，等阶段 D。
- [x] ✅ 门禁执行记录（2026-10-16 本机，阶段 D CLI/文档）：`npx tsc --noEmit` 0 错、`tsc -p tsconfig.cli.json` 0 错、
  `node tools/selftest.ts` **515/0**、`node tools/console-mock-check.mjs` **153/0**、
  `node tools/mock-cli/selftest.ts` **514/0**；启动横幅冒烟跑过（历史占用行如实打出）。

## 11. 实施注意事项与待产品确认

- **明确行为变化**：迁移后旧全局规则不再直接运行，必须由各用户复制到 private。上线提示要让用户知道，否则会表现为原 mock 全失效。
- **覆盖权限**：在本计划口径下，任何能登录的用户都可 copy 并覆盖 shared；这与“自由覆盖/回退”一致，但意味着共享项目不是受保护的主分支。每次操作都必须记录 actor 和时间，且版本可恢复。
- **敏感数据**：共享项目和所有历史版本对本实例登录用户可见；旧版本会保留后来删除的返回 body。发布 UI 应提示用户检查 token、cookie、个人数据。
- **历史容量**：无限期保存全量快照会持续占用磁盘。首版不自动清理；显示实际字节数并提供 admin 级磁盘诊断。任何保留上限都要另行拍板。
- **执行顺序不可颠倒**：协议与 ADR 定稿 → 服务端归属/数据面过滤 → 管理 API 与安全批量写 → 版本/恢复 → 控制台 → CLI/文档 → 全量异常验收。

