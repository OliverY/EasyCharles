# mock CLI（给 AI agent 和脚本用）

控制台是给人看的，**agent 需要的是能读回校验的命令行**。工具在 `server/tools/mock-cli/`，
零运行时依赖，走的是**管理面**（`/__ec/api/*`），所以它**可以打远程服务实例**。

README 只留一句「有这个能力」，完整约定都在这里。

```bash
cd server
node tools/mock-cli/mock.ts project add office --base-url http://<内网IP>:8899
node tools/mock-cli/mock.ts set project office
node tools/mock-cli/mock.ts login --browser            # 人在浏览器里登录，会话自己回到 CLI（CLI 不经手口令）
node tools/mock-cli/mock.ts login --phone 13800000000 --password-stdin   # 脚本 / agent：口令不入配置文件
node tools/mock-cli/mock.ts api list --json                              # 规则摘要（不含返回值 body）
node tools/mock-cli/mock.ts api create --path /api/login --method POST \
  --json-list '{"code":0,"token":"abc"}' --json-list '{"code":1001}' \
  --response-group-names 成功 --response-group-names 密码错误 \
  --status 200 --status 401 --mode seq --seq-mode loop --json               # 建一条顺序流转的规则
node tools/mock-cli/mock.ts api update r_login --json-list '{"code":0}'    # 读改写：没写的字段不动
node tools/mock-cli/mock.ts api switch r_login --off --json              # 单条开/关，提交后读回核对
node tools/mock-cli/mock.ts group create --name 登录模块 --on --json       # 项目 = 规则的容器（私有项目才参与命中，ADR-033）
node tools/mock-cli/mock.ts api create --path /api/user --json-list '{}' --group-id g_xxx   # 规则挂进私有项目
node tools/mock-cli/mock.ts group get g_xxx --json                        # 项目里哪些规则**实际在命中**
node tools/mock-cli/mock.ts group switch g_xxx --off                      # 整项目停用，不改写规则自己的开关
node tools/mock-cli/mock.ts group copy g_shared_xxx --json                # 共享模板复制成我的私有项目（共享永不直接命中）
node tools/mock-cli/mock.ts device list && node tools/mock-cli/mock.ts device bind <deviceId> --json
node tools/mock-cli/mock.ts request list --mocked true --json            # 抓包记录摘要
node tools/mock-cli/mock.ts help
```

## 接进 AI 工作流（Codex / Claude Code 这类能跑命令的 agent）

要点只有一句：**让 agent 用命令读写，别让它猜接口返回什么**。`--json` 给机器读、退出码是契约、
写操作读回核对——这三条决定了 agent 能不能自己判断「到底成没成」。

一条典型链路（agent 照这个顺序跑，不需要人去点控制台）：

```bash
# 1. 认身份：agent 从 stdin 传口令，不落配置文件
printf '%s' "$EC_MOCK_PASSWORD" | node tools/mock-cli/mock.ts login --phone 13800000000 --password-stdin

# 2. 找项目：共享模板不直接命中，先复制成私有项目
node tools/mock-cli/mock.ts group list --scope all --json
node tools/mock-cli/mock.ts group copy g_shared_xxx --json

# 3. 摸清现状：先看已有规则，避免重复建
node tools/mock-cli/mock.ts api list --json

# 4. 造数据：一次建一条，多条返回值按顺序流转
node tools/mock-cli/mock.ts api create --path /api/order/list --method POST \
  --json-list '{"code":0,"data":{"list":[]}}' --json-list '{"code":1001}' \
  --status 200 --status 401 --mode seq --seq-mode loop --group-id g_xxx --json

# 5. 核对命中：api list 只列我的私有规则，实际命中看 group get
node tools/mock-cli/mock.ts group get g_xxx --json
```

给 agent 的提示词可以直接这么写：

> 按 `docs/mock-cli.md` 的约定，用 `server/tools/mock-cli/mock.ts` 往项目 `<项目id>` 里补齐
> `<接口清单>` 的返回值：每个接口至少一条成功、一条业务错误；要顺序流转的用 `--mode seq`。
> 每次写操作后读回核对，失败按退出码定位（2 参数 / 3 鉴权 / 4 服务端 / 5 连不上 / 6 只读 / 7 冲突），
> 不要重试同一个失败请求。

### 例：一句话造翻页数据

> 帮我给 `/api/order/list` 造一组翻页数据，三页，每页 20 条，最后一页没有更多。

agent 该拆成**每页一条规则**，用 `--param` 把页码写进匹配条件：

```bash
node tools/mock-cli/mock.ts api create --path /api/order/list \
  --param page=1 --json-list '{"code":0,"data":{"list":[{"id":1}],"hasMore":true}}' --json
node tools/mock-cli/mock.ts api create --path /api/order/list \
  --param page=2 --json-list '{"code":0,"data":{"list":[{"id":21}],"hasMore":true}}' --json
node tools/mock-cli/mock.ts api create --path /api/order/list \
  --param page=3 --json-list '{"code":0,"data":{"list":[],"hasMore":false}}' --json
```

**为什么不是一条 `--mode seq` 规则**：顺序规则的指针按「命中次数」推进，跟请求里的页码无关——
用户往回翻一页，就会拿到下一页的数据，页码和内容对不上。`--param page=N` 各建一条才稳。

两个细节：`--param` 是 **AND 匹配**（写进去的键必须存在，值按 glob / `re:` 比对）；
页码放在 POST body 里也一样，匹配用的是 query + body 合并后的入参表。

几条必须守住的：

- **一次只写一条**（`POST /rules` / `PUT /rules/:id`），不要整表 PUT——agent 的一次读改写会把别人
  同时改的规则整片盖掉
- **别信 `ok:true`**：CLI 已经读回逐字段比对，报 `EC_VERIFY_FAILED` 就是真没落上
- **破坏性操作要 `--yes`**：非交互环境没给就直接退出，不会把 agent 挂在交互提示上
- **并行数组按下标对齐**：`--json-list` / `--status` 各自重复传一个 flag，长度不一致直接退出码 2

## 约定

- **`--json` 给机器读**：成功是结构化 JSON 走 stdout，失败是 `{"error","message","hint"}` 走 stderr，
  stdout 永远干净；`--quiet` 压成一行
- **退出码是契约**：`0` 成功 / `2` 参数错 / `3` 鉴权 / `4` 服务端报错（含查无此条） / `5` 连不上 /
  `6` 项目只读或归属不符（共享项目不可写、把规则挪出/挪进别人的项目） / `7` 乐观锁冲突（`--expected-version` 落空） / `64` 该命令还没实现
- **口令不落盘**：配置文件（`~/.mock-cli/config.json`，0600）只存 session token，
  口令每次从 `--password` / `EC_MOCK_PASSWORD` / `--password-stdin` 来；token 失效时
  带得上口令就自动重新登录，带不上就报 `EC_UNAUTHORIZED` 提示先 `mock login`
- **两条登录路径，各按场景**（ADR-029）：
  - **人**：`mock login --browser` —— CLI 打开控制台地址，你在页面里照常登录，页面弹一次
    「允许本地 CLI 使用你的会话」，点允许后会话经**本机 127.0.0.1** 交回 CLI；
    CLI 全程不接触口令，服务端也**没有**为这条路加任何端点（nonce 走 `#hash`，不进访问记录）。
    拿到 token 后 CLI 先向服务端 `/__ec/api/me` 核实，认了才落盘，身份以服务端为准；
    点「拒绝」则 CLI 立刻收到 `EC_LOGIN_DENIED`，不会干等到超时。
    远端实例同样适用（浏览器和 CLI 在**同一台机器**上才行；`--no-open` 只打印地址，
    `--timeout` / `--callback-port` 可调；细节见 `mock help login`）
  - **agent / CI**：`--password-stdin` 或 `EC_MOCK_PASSWORD` —— 没有 GUI 也不会挂在弹窗上；
    未实现「没给口令就自动开浏览器」这种静默降级，`--browser` 必须显式给
- **破坏性操作要 `--yes`**：非交互环境没给 `--yes` 直接报错退出，不会挂在交互提示上把 agent 卡死
- **写操作一律读回校验**：`create` / `update` / `copy` / `switch` / `delete` / `bind` / `unbind` / `clear`
  提交后再查一次，逐字段比对，不一致就报 `EC_VERIFY_FAILED`，不会拿服务端一句 `ok:true` 当成功
- **改一条只写一条**：新建与修改走单条端点（`POST /rules`、`PUT /rules/:id`），不做整表 PUT，
  所以 agent 的一次读改写不会把别人同时改的规则覆盖掉
- **读改写无损**：`api update` 只覆盖你显式给的字段，CLI 不认识的东西（控制台写的扩展字段、
  每条返回值的命中条件、自定义响应头）原样带走。控制台那边同样改成了保存无损，
  两个写者不会互相抹掉对方的配置
- **并行数组按下标一一对应**：`--json-list` / `--response-group-names` /
  `--response-group-queries` / `--response-group-contents`，**每项各自重复传一个 flag**
  （`--json-list A B C` 这种空格连写会当场报错，因为 B、C 会静默丢掉）；
  长度对不上直接退出码 2，下标错位会把返回值挂到错误的命中条件上而且服务端不报错。
  `--status` / `--content-type` 也能重复传并与返回值对齐（`--status 200 --status 401`），
  **只给一个值就是「每条都用它」**（`--status 201`）
- **默认拒绝「命中所有请求」**：`--host` 与 `--path` 都不给时拒绝，要显式
  `--allow-match-all --yes` 才放行

## 项目分私有 / 共享，只有私有参与命中（ADR-033 / C14）

规则必须挂在**我的私有项目**里才会被 mock（命中 = `规则 enabled` 且 项目私有且属于当前设备的归属人 且 `项目 enabled`）；
共享项目是全实例可读的**只读模板**，永不直接命中，要用先 `mock group copy <共享项目id>`
复制成私有副本。关项目**不改写**组内规则的开关、也不重置序列指针，重开即原样恢复；
**删私有项目会级联删掉组内规则**（脱组 = 永不命中，所以不再保留）。

⚠️ `api list` 只列我私有项目里的规则；`on=✓` 但所属项目关着时仍然不命中——实际命中请用 `group get`。

**升级提示（C13 及以前 → C14）**：旧的分组与未分组的存量规则会自动迁进共享容器
`g_legacy_shared`，**一律不再直接命中**。要继续用：`mock group copy g_legacy_shared`
复制成私有项目（或挑需要的逐条重建），确认命中正常后把旧容器 `mock group archive g_legacy_shared` 归档。

未实现的命令**如实返回 64 并给出替代做法**（`mock group disable-all` 刻意不做 → 整项目停用请用
`mock group switch <id> --off`；`mock f2e search` 排在 P4），不会假装成功。

## 还没做的

OpenAPI 文档源（`f2e` / `apigroup`）与返回值的逐条条件选路排在 P4，
见 [roadmap.md](roadmap.md) 的 P6 段与 [decisions.md](decisions.md) 的 ADR-027 / ADR-028 /
ADR-029 / ADR-030 / ADR-033。
