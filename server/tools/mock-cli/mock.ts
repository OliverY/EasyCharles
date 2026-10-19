#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { CliError, EXIT, notImplemented } from './cli/errors.ts'
import { parseArgs, peekFlag } from './cli/args.ts'
import { ConfigStore, defaultConfigPath } from './cli/config.ts'
import { installPipeGuard, modeOf, reportError } from './cli/output.ts'
import type { Mode } from './cli/output.ts'
import { cmdLogin, cmdLogout, cmdWhoami } from './cli/commands/auth.ts'
import { cmdProject, cmdSet } from './cli/commands/context.ts'
import { cmdApi } from './cli/commands/api.ts'
import { cmdGroup } from './cli/commands/group.ts'
import { cmdDevice } from './cli/commands/device.ts'
import { cmdRequest } from './cli/commands/request.ts'

export const CLI_VERSION = '0.1.0'

type Status = 'ready' | 'partial' | 'stub'

interface Sub {
  name: string
  args: string
  status: Status
  /** status=stub 时的计划阶段 */
  phase?: string
  summary: string
  alternative?: string
}

interface Cmd {
  name: string
  args: string
  status: Status
  phase: string
  summary: string
  /** status=stub 时给出当前能做到的替代做法 */
  alternative?: string
  subs?: Sub[]
  /**
   * 单条命令的补充说明，`mock help <命令>` 里逐行打印。
   *
   * 存在的理由：一览那行的 args 列宽有限，参数一多就会把 summary 挤成一坨
   * （agent 读 help 时最容易看错的地方）。短 args 负责「一眼看懂形态」，
   * 细节写在这里，而不是硬塞进 args 字符串。
   */
  detail?: string[]
}

/**
 * 命令树。未实现的动作**注册但明确报错**（退出码 64），而不是让 agent
 * 以为命令不存在或悄悄成功——AGENTS.md §9「状态不要撒谎」。
 */
export const COMMANDS: Cmd[] = [
  {
    name: 'login',
    args: '[--phone <p>] [--password | --password-stdin] | [--browser]',
    status: 'ready',
    phase: 'P0',
    summary: '登录管理面，缓存会话；--browser 由页面把会话经 127.0.0.1 交回',
    detail: [
      '口令通道（脚本 / agent / CI）：--password <pw> | --password-stdin | 环境变量 EC_MOCK_PASSWORD',
      '--browser（人在终端里用，CLI 全程不经手口令，ADR-029）：',
      '  1) CLI 在本机起一次性监听，把 <控制台地址>#cli-login?port=…&state=… 打出来并开浏览器',
      '  2) 你在页面里登录，页面弹「允许本地 CLI 使用你的会话」——**要点一次允许**，没有静默通道',
      '  3) 会话经 127.0.0.1 交回，CLI 先用 GET /__ec/api/me 核实身份，认了才写进配置文件',
      '  点「拒绝」会立刻结束这轮登录（EC_LOGIN_DENIED），不会让 CLI 干等到超时',
      '  --no-open 只打印地址（SSH / 无 GUI）；--timeout <5~900 秒>；--callback-port <1024~65535>',
      '  要求浏览器和 CLI 在**同一台机器**；跨机器 / agent 场景改用口令通道',
      '  --browser 与任何口令来源同时出现是用法错误（退出码 2），也不会「没口令就自动开浏览器」',
    ],
  },
  { name: 'logout', args: '', status: 'ready', phase: 'P0', summary: '销毁服务端会话并清除本地缓存' },
  { name: 'whoami', args: '', status: 'ready', phase: 'P0', summary: '当前 project / 手机号 / 角色 / 服务端信息' },
  { name: 'project', args: 'list|add <名字> --base-url <url>|use <id>|remove <id> --yes', status: 'ready', phase: 'P0', summary: '查看与管理目标服务实例（skill 里的 project），可加 --check 探活' },
  { name: 'set', args: '[project <id> | group <id>]', status: 'ready', phase: 'P0', summary: '设置默认 project / 默认项目（group 向服务端核对存在性，只认我的私有项目才有意义；只是本地默认值，命令不会自动按它过滤）' },
  { name: 'version', args: '', status: 'ready', phase: 'P0', summary: 'CLI 版本与本地上下文' },
  { name: 'help', args: '[<命令>]', status: 'ready', phase: 'P0', summary: '命令树与参数说明' },

  {
    name: 'api',
    args: '',
    status: 'ready',
    phase: 'P2',
    summary: 'Mock 规则（= skill 里的「接口」）：列表 / 读单条 / 建 / 改 / 复制 / 开关 / 删除',
    subs: [
      { name: 'list', args: '[--method GET] [--host <串>] [--path <串>] [--q <串>] [--enabled true|false] [--group-id <项目id>]', status: 'ready', summary: '列**我的私有项目**里的规则（他人/共享/无归属不下发；共享内容用 mock group rules <id> 看）。--group-id "" 只看无归属，恒为 0 条' },
      { name: 'get', args: '<id> [--group-id <项目id>]', status: 'ready', summary: '回读整条规则（rule 字段原样，供读改写）+ 实际命中状态；带 --group-id 时先验归属' },
      { name: 'switch', args: '<id> --on|--off [--group-id <项目id>]', status: 'ready', summary: '单条开/关，提交后读回校验；--group-id 是「确认它属于这个项目才动手」' },
      { name: 'delete', args: '<id> --yes [--group-id <项目id>]', status: 'ready', summary: '单条删除，提交后读回校验；删整个项目用 mock group delete（会连带删组内规则）' },
      {
        name: 'create',
        args: '--path <p> [--method GET] [--host <h>] [--name <备注名>] [--group-id <私有项目id>] --json-list <body>… [--response-group-names <名>…] [--response-group-queries <条件>…] [--response-group-contents <表达式>…] [--mode static|sequence|specific] [--seq-mode in-order|loop|once-then-passthrough|random] [--pin-index N] [--param k=v]… [--status <码>…] [--content-type <ct>…] [--priority N] [--delay-ms N] [--off]',
        status: 'ready',
        summary: '建规则（POST 单条端点，id 服务端生成）。**必须挂我的某个私有项目**：没带 --group-id 时按「本地默认 → 唯一私有项目」推，推不出唯一答案就报错，绝不写无归属规则',
      },
      {
        name: 'update',
        args: '<id> [同 create 的全部参数；给空串表示清除，如 --path "" --name ""]',
        status: 'ready',
        summary: '读改写：先回读整条，只覆盖显式给的字段，PUT 后读回比对。归属字段只读：--group-id 只能等于原项目，移出/挪项目都报 6',
      },
      { name: 'copy', args: '<id> [--name <新备注名>] [--group-id <私有项目id>]', status: 'ready', summary: '复制一条规则（深拷贝，新 id 服务端生成；不给 --group-id 就连源项目一起复制，不能复制成无归属）' },
    ],
  },
  {
    name: 'device',
    args: '',
    status: 'partial',
    phase: 'P1',
    summary: '设备：列表 / 当前 / 绑定 / 解绑（绑定守卫 + 读回校验）',
    subs: [
      { name: 'list', args: '[--online true|false]', status: 'ready', summary: '可见设备 = 自己绑定的 + 未绑定的（admin 看全量）' },
      { name: 'current', args: '', status: 'ready', summary: '当前空间绑定的那台设备' },
      { name: 'bind', args: '<deviceId> [--force]', status: 'ready', summary: '绑定设备；不在可见列表里的要 --force' },
      { name: 'unbind', args: '<deviceId>', status: 'ready', summary: '解绑（只能解自己空间的）' },
      { name: 'rename', args: '', status: 'stub', phase: 'P3', summary: '管理侧改设备名', alternative: 'deviceName 由 SDK 上报，改名要改 App 侧配置' },
    ],
  },
  {
    name: 'request',
    args: '',
    status: 'ready',
    phase: 'P1',
    summary: '抓包记录：列表摘要 / 读单条全量 / 清空（记录只在内存，重启即丢）',
    subs: [
      { name: 'list', args: '[--limit N] [--q <串>] [--device-id <id>] [--mocked true|false]', status: 'ready', summary: '摘要列表，不含 body' },
      { name: 'get', args: '<id>', status: 'ready', summary: '整条记录（含 request/response body）' },
      { name: 'clear', args: '[--device-id <id>] [--q <串>] --yes', status: 'ready', summary: '清空「当前空间 ∩ 当前筛选」，读回校验' },
    ],
  },
  {
    name: 'group',
    args: '',
    status: 'ready',
    phase: 'C14',
    summary: '项目（mock 规则的容器，私有/共享两档，ADR-033）：命中 = 规则 enabled 且 项目私有且未关',
    subs: [
      { name: 'list', args: '[--scope private|shared|all] [--enabled true|false] [--q <串>]', status: 'ready', summary: '列项目（含 ruleCount；--enabled 只对 private 有意义，共享项目的开关永远没人读）' },
      { name: 'get', args: '<id>', status: 'ready', summary: '单项目详情 + 组内规则的**实际命中状态**（off-shared / off-by-project / off-by-rule 分开标）' },
      { name: 'create', args: '--name <名字> [--on|--off]', status: 'ready', summary: '建私有项目（id 服务端生成；只允许 private，--off 建关着的）' },
      { name: 'update', args: '<id> --name <新名字> [--on|--off]', status: 'ready', summary: '改私有项目（PUT 整条替换，读回比对；shared 是只读，本地先拦并给出路）' },
      { name: 'switch', args: '<id> --on|--off', status: 'ready', summary: '整项目开关（仅 private）；回传 affected，**不改写**组内规则的 enabled' },
      { name: 'delete', args: '<id> --yes', status: 'ready', summary: 'private 删除**会连带删掉组内规则**；shared 只能删空项目，非空请 archive' },
      { name: 'rules', args: '<id>', status: 'ready', summary: '按项目读规则全文（shared 内容的唯一读入口；对这个路径的写方法一律 405）' },
      {
        name: 'copy',
        args: '<共享项目id> [--operation-id <串>]',
        status: 'ready',
        summary: 'shared → 我的私有副本（内容全由服务端拷，不接受上传；副本名 = 原名(副本)，带来源指针）',
      },
      {
        name: 'share',
        args: '<私有项目id> [--expected-version <版本id>] [--operation-id <串>]',
        status: 'ready',
        summary: '私有 → shared：首发新建共享项目，再分享 = **整项目覆盖**（差分进确认框；--expected-version 是乐观锁）',
      },
      { name: 'history', args: '<共享项目id>', status: 'ready', summary: '版本历史（只读追加）：每条的发布人 / 时间 / 规则数 / 是否 rollback' },
      {
        name: 'rollback',
        args: '<共享项目id> --version <版本id> [--operation-id <串>]',
        status: 'ready',
        summary: '回退 = **追加**一条 rollback 版本，旧版本一条不删（回退不是改写历史）',
      },
      { name: 'archive', args: '<共享项目id> [--off]', status: 'ready', summary: '归档/恢复共享项目（归档 ≠ 删除，快照与分享记录一条不动）' },
      {
        name: 'disable-all',
        args: '',
        status: 'stub',
        phase: '不做',
        summary: '一键禁用全部规则（ADR-030 明确不做：会造出第二份真相）',
        alternative: '整项目停 mock group switch <id> --off；逐条停 mock api switch <id> --off',
      },
    ],
  },
  { name: 'f2e', args: 'search|detail|generate-*', status: 'stub', phase: 'P4', summary: '按你的选择改为通用 OpenAPI 文档源（不再依赖内部平台）', alternative: '暂时手工准备接口 JSON 样例喂给 --json-list' },
  { name: 'apigroup', args: 'search|import|search-import|sync-f2e|update', status: 'stub', phase: 'P4', summary: '接口分组导入依赖文档源，排在 f2e 之后', alternative: '暂时逐条 mock api create' },
]

const READY_HANDLERS: Record<string, (store: ConfigStore, argv: string[]) => Promise<number>> = {
  login: cmdLogin,
  logout: cmdLogout,
  whoami: cmdWhoami,
  project: cmdProject,
  set: cmdSet,
  api: cmdApi,
  group: cmdGroup,
  device: cmdDevice,
  request: cmdRequest,
}

/**
 * `--config` 必须在解析子命令参数**之前**就取到，否则配置文件会用错位置。
 * 见 args.ts 的 peekFlag 注释——这个坑已经踩过一次。
 */
function configPathOf(argv: string[]): string {
  return peekFlag(argv, 'config') || defaultConfigPath()
}

function cmdVersion(store: ConfigStore, mode: Mode): number {
  const def = store.projectById(store.data.defaults.project)
  const payload = {
    name: 'mock-cli',
    version: CLI_VERSION,
    node: process.version,
    configPath: store.path,
    projects: store.data.projects.length,
    defaultProject: store.data.defaults.project,
    defaultBaseUrl: def?.baseUrl ?? null,
    defaultGroup: store.data.defaults.group,
  }
  if (mode === 'json') process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  else if (mode === 'quiet') process.stdout.write(`${payload.version}\n`)
  else {
    process.stdout.write(`mock-cli ${payload.version} (node ${process.version})\n`)
    process.stdout.write(`配置文件: ${payload.configPath}\n`)
    process.stdout.write(`默认 project: ${payload.defaultProject ?? '(未设置)'} ${def ? `@ ${def.baseUrl}` : ''}\n`)
  }
  return EXIT.OK
}

/** 有 subs 的命令，args 由子命令生成：手工维护两份必然漂移（AGENTS.md §5 同一精神） */
function argsOf(c: Cmd): string {
  if (!c.subs) return c.args
  const ready = c.subs.filter((s) => s.status !== 'stub').map((s) => s.name)
  const stub = c.subs.filter((s) => s.status === 'stub')
  return [...ready, ...stub.map((s) => `${s.name}[📅${s.phase ?? '?'}]`)].join('|')
}

export function helpText(): string {
  // args 列宽自适应：写死 60 时，某条命令的参数说明一超过 60 字符，
  // summary 就紧贴着 args 挤成一坨（对齐是次要的，**不能粘连**才是这条的目的）
  const col = Math.max(60, ...COMMANDS.map((c) => argsOf(c).length))
  const line = (c: Cmd): string => {
    const tag = c.status === 'ready' ? '' : c.status === 'partial' ? `[部分 📅 ${c.phase}] ` : `[📅 ${c.phase}] `
    return `  ${c.name.padEnd(10)}${argsOf(c).padEnd(col)}${tag}${c.summary}`
  }
  const ready = COMMANDS.filter((c) => c.status === 'ready')
  const rest = COMMANDS.filter((c) => c.status !== 'ready')
  return `mock-cli ${CLI_VERSION} — EasyCharles 的 mock 命令行（面向 AI agent 调用）

用法: mock <命令> [<子命令>] [参数]

已实现
${ready.map(line).join('\n')}

部分实现 / 待实现（未实现的部分会明确报错 64，不假装成功）
${rest.map(line).join('\n')}

单条命令的每个子命令与参数：mock help <命令>（如 mock help api）

全局参数
  --json                 结构化输出到 stdout（agent 首选）
  --quiet                只输出关键字段/ID
  --verbose              把每个 HTTP 调用打到 stderr
  --yes                  跳过删除/清理类动作的确认（非交互环境必需）
  --base-url <url>       直接指定服务实例，优先于 --project-id
  --project-id <id>      指定 project（本地登记的服务实例）
  --group-id <id>        项目（C14 / ADR-033，规则的容器）：api list 按项目筛选、create/copy 指定
                         落到哪个私有项目、get/switch/delete 作归属校验；update/copy 的空串一律拒绝
                         （C14 起不存在「无归属规则」这个合法形态）
  --config <path>        换一份配置文件（自测/多账号隔离用）

环境变量
  EC_MOCK_HOME           配置目录，默认 ~/.mock-cli
  EC_MOCK_PASSWORD       登录口令（脚本首选，避免 --password 进 shell 历史）
  EC_MOCK_PHONE          登录手机号
  EC_PORT                决定「本机」project 的默认端口，默认 8899

退出码
  0 成功 · 2 用法/参数错误 · 3 未登录或口令错 · 4 服务端拒绝(4xx/5xx) · 5 连不上服务 ·
  6 项目只读/归属不匹配（共享只读、移出或挪项目、无归属；补救是 copy → 改 → share，不是换参数重试） ·
  7 冲突（--expected-version 对不上，先 mock group history 看最新版本） · 64 命令未实现

错误码（--json / --quiet 下 stderr 那行 JSON 的 error 字段）
  EC_USAGE · EC_UNAUTHORIZED · EC_NOT_FOUND(404) · EC_PROJECT_READONLY(6) · EC_SCOPE_MISMATCH(6) ·
  EC_CONFLICT(7) · EC_VERIFY_FAILED(写后读回不一致) · EC_BAD_RESPONSE · EC_BODY_TOO_LARGE ·
  EC_UNREACHABLE · EC_NOT_IMPLEMENTED ·
  EC_LOGIN_TIMEOUT(没人点「允许」/ 页面版本太旧) · EC_LOGIN_DENIED(页面里点了「拒绝」) ·
  EC_ORIGIN_MISMATCH(浏览器地址≠baseUrl) ·
  EC_STALE_REQUEST · EC_FORBIDDEN · EC_BAD_BODY；其余沿用服务端返回的 error 值

约定
  · 写操作（create / update / copy / switch / delete / bind / clear）都会**读回校验**，
    对不上就报 EC_VERIFY_FAILED，不会返回 ok:true —— 这是 skill「提交后必须读回确认」那条原则的落地
  · 项目与归属（C14 / ADR-033）：规则必须挂在**我自己的私有项目**里，一条规则会不会命中 =
    **它自己的 enabled** 且 **项目存在且是我的私有** 且 **项目没被关**。项目开关不改写规则自己的
    enabled（重开即恢复原状，抓包序列指针也不重置）；删私有项目**会连带删掉组内规则**；
    共享项目**永不直接命中**，要用得先 mock group copy 成私有副本
  · 共享库的用法（C14）：mock group copy <共享项目id> → 改副本 → mock group share <私有项目id>。
    再分享是**整项目覆盖**（确认框里有新增/删除/保留差分），不是逐条合并；
    mock group rollback = 追加一条回退版本，历史一条不删；幂等靠 --operation-id，
    同 id 重放服务端回的是**首次那笔**的结果
  · --group-id 的核对做在 CLI 侧：写路径先核对「存在且是我的私有项目」（他人私有项目按
    404 同形，不泄露存在性），按项目筛选先核对项目存在——查无此项目报 EC_NOT_FOUND，
    不会把悬空 id 存进规则（C14 起悬空/他人/无归属 = 永不命中，不再按「未分组照常命中」放行）
  · 升级提示：旧版「全局规则」（没有 groupId）在 C14 起**不再命中**，服务端也不再把它们
    下发给 api list。要保留就在控制台把它们搬进私有项目，或逐条 mock api copy 重建
  · 四条并行数组（--json-list / --response-group-names / --response-group-queries /
    --response-group-contents）按下标一一对应：**每项各自重复传一个 flag**，长度必须相同；
    只给其中几条时按现有返回值条数补齐，对不上直接退出码 2（下标错位会把返回值挂到错误的条件上，
    而且服务端不会报错）。内容很大时用 --json-list @文件 或 @-（stdin）
  · --status / --content-type 也可以重复传，与 --json-list 按下标对应：
    --json-list '{"code":0}' --json-list '{"code":1001}' --status 200 --status 401
    只给一个值即「每条都用它」（--status 201），不给就沿用服务端存着的那条自己的值
  · 返回值内容**原样存储**（CLI 不做 JSON 重排/美化），所以读回比对是逐字符的
  · 每条返回值的命中条件（--response-group-queries / -contents）**本期只存下来**，
    服务端还不会按它选路（P4）；选路语义见 docs/protocol.md §5.4
  · --base-url 指向未登记的服务时会自动登记一条 project（名字取 host），便于下次用 --project-id 引用
  · 错误在 --json/--quiet 下是一行 JSON：{"error","message","hint"}，写在 stderr
  · 会话不存口令，只存 token。两条来源：**脚本/agent** 用 --password / EC_MOCK_PASSWORD / --password-stdin；
    **人在终端** 用 mock login --browser——控制台页面把会话经本机 127.0.0.1 交回，CLI 不经手口令，
    服务端也没有为此新增任何端点（ADR-029）。--browser 不与口令来源混用，也不会自动降级
`
}

function cmdHelp(argv: string[], mode: Mode): number {
  // 必须走 parseArgs 取主题：手挑「第一个不以 - 开头的 token」会把
  // `help api --config /path` 里的 /path 当成命令名
  const parsed = parseArgs(argv, {})
  const topic = parsed.positional[0]
  if (!topic) {
    process.stdout.write(helpText())
    return EXIT.OK
  }
  const found = COMMANDS.find((c) => c.name === topic)
  if (!found) {
    process.stdout.write(`没有这个命令：${topic}\n\n${helpText()}`)
    return EXIT.USAGE
  }
  if (mode === 'json') {
    process.stdout.write(`${JSON.stringify(found, null, 2)}\n`)
    return EXIT.OK
  }
  const statusText = (st: Status, phase?: string): string =>
    st === 'ready' ? '已实现' : st === 'partial' ? '部分实现' : `未实现 📅${phase ?? found.phase}`
  process.stdout.write(`mock ${found.name} ${argsOf(found)}\n  ${found.summary}\n  状态: ${statusText(found.status, found.phase)}\n`)
  if (found.subs) {
    process.stdout.write('  子命令:\n')
    for (const sub of found.subs) {
      process.stdout.write(`    ${`${sub.name} ${sub.args}`.padEnd(58)}${statusText(sub.status, sub.phase)}  ${sub.summary}\n`)
      if (sub.status === 'stub' && sub.alternative) process.stdout.write(`      替代做法: ${sub.alternative}\n`)
    }
  }
  if (found.status === 'stub' && found.alternative) process.stdout.write(`  替代方案: ${found.alternative}\n`)
  for (const d of found.detail ?? []) process.stdout.write(`${d}\n`)
  if (found.status !== 'stub') process.stdout.write('  写操作会读回校验；对不上报 EC_VERIFY_FAILED 而不是 ok:true\n')
  return EXIT.OK
}

/** 未登记/未解析的命令一律先宽松取个名，报错信息才有用 */
function looseCommand(argv: string[]): string {
  const first = argv[0]
  if (!first || first.startsWith('--')) return ''
  const second = argv[1] && !argv[1].startsWith('--') ? ` ${argv[1]}` : ''
  return `${first}${second}`
}

export async function run(argv: string[]): Promise<number> {
  // 先宽松探测输出模式：子命令 parse 之前就要知道是不是 --json，
  // 否则「参数错误 / 未登录」这类失败会退化成人类文本，agent 解析不到 code。
  const mode: Mode = argv.includes('--json') ? 'json' : argv.includes('--quiet') ? 'quiet' : 'human'
  try {
    const cmd = argv[0] ?? ''

    if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
      return cmdHelp(argv.slice(1), mode)
    }
    if (!cmd) {
      process.stdout.write(helpText())
      return EXIT.USAGE
    }
    // 把 flag 写在命令前（`mock --config x.json whoami`）不是本 CLI 的语法。
    // 与其报「未知命令：--config」让人摸不着头脑，直接把用法说清楚。
    if (cmd.startsWith('-')) {
      if (mode === 'human') {
        process.stdout.write(helpText())
        process.stderr.write('提示：命令要写在最前面，如 mock <命令> [参数] --config <path>\n')
        return EXIT.USAGE
      }
      throw new CliError('EC_USAGE', `缺少命令（收到 ${cmd}）`, '用法：mock <命令> [<子命令>] [参数]；完整帮助 mock help', EXIT.USAGE)
    }

    if (cmd === 'version') {
      const p = parseArgs(argv.slice(1), {})
      return cmdVersion(ConfigStore.load(configPathOf(argv)), modeOf(p))
    }

    const definition = COMMANDS.find((c) => c.name === cmd)
    const handler = READY_HANDLERS[cmd]
    if (!handler) {
      const label = looseCommand(argv)
      if (definition && definition.status === 'stub') {
        throw notImplemented(`mock ${label || cmd}`, definition.phase, definition.alternative ?? '见 mock help')
      }
      throw new CliError(
        'EC_USAGE',
        `未知命令：${label || cmd}`,
        `可用命令：${COMMANDS.map((c) => c.name).join(', ')}；完整帮助 mock help`,
        EXIT.USAGE,
      )
    }

    const store = ConfigStore.load(configPathOf(argv))
    const code = await handler(store, argv.slice(1))
    if (store.warnings.length) for (const w of store.warnings) process.stderr.write(`警告: ${w}\n`)
    return code
  } catch (err) {
    return reportError(err, mode)
  }
}

/**
 * `file://` + 路径的裸拼接在含空格 / 非 ASCII 的目录里会失配
 * （本仓库就有 `启动 EasyCharles.command` 这类路径），所以走 pathToFileURL。
 */
const isMain = process.argv[1] ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href : false
if (isMain) {
  // 先装管道守卫：`mock request list --json | head -5` 崩 EPIPE 比输出截断严重得多
  installPipeGuard()
  void run(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
