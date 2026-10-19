/**
 * 控制台 Mock 编辑器「纯逻辑」回归：直接把 index.html 里那段与 DOM 无关的函数切出来跑。
 *
 * 为什么要这么测：控制台是零构建单页，没有测试框架；但「草稿 ⇄ 规则」的往返、
 * 拖动换序后的 sel / pinIndex 归属这些恰好是纯函数，也是最容易静默出错的地方
 * （拖完编辑到另一条、单项规则保存后 JSON 变形、pinIndex 越界）。
 *
 *   node tools/console-mock-check.mjs
 *
 * 只覆盖纯逻辑；拖拽手势本身属于浏览器行为，仍需手工验收（见 roadmap）。
 */
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8')
const start = html.indexOf('function newRuleId()')
const end = html.indexOf('function renderMockList()')
if (start < 0 || end < 0 || end <= start) throw new Error('切不出控制台纯逻辑区段（源码结构变了？）')
// 顶部项目横滑栏的渲染：它碰 DOM（写 innerHTML），但「列哪些项目 / 条数从哪来 /
// 选中态怎么判」是纯逻辑，而且这三条最容易静默错——最典型的是条数取自当前视图
// 的 state.rules，切一个项目别的 chip 全变 0，看起来像「那些项目空了」。
const barStart = html.indexOf('function renderMockProjBar()')
const barEnd = end
if (barStart < 0 || barEnd <= barStart) throw new Error('切不出 renderMockProjBar')
// bodyPreview 定义在 renderMockList 之后（贴着自己的渲染函数），单独切出来
const extraStart = html.indexOf('function bodyPreview(')
const extraEnd = html.indexOf('function respRowHTML(')
if (extraStart < 0 || extraEnd < 0 || extraEnd <= extraStart) throw new Error('切不出 bodyPreview')
// daysLeft 是待删除倒计时的唯一算法（ADR-037），也在切片区段之外，单独切
// 注意用 `async function deleteProject(` 作结束边界：`function deleteProject(` 会匹配到
// `async function deleteProject(` 里面，切出来就剩一个孤零零的 `async`（实测报 async is not defined）
const dayStart = html.indexOf('function daysLeft(')
const dayEnd = html.indexOf('async function deleteProject(')
if (dayStart < 0 || dayEnd < 0 || dayEnd <= dayStart) throw new Error('切不出 daysLeft')
const slice = html.slice(start, end) + html.slice(extraStart, extraEnd) + html.slice(dayStart, dayEnd)
  + html.slice(barStart, barEnd)

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name} ${extra}`) }
}

// 区段里引用到、但定义在别处的东西：给最小实现（与 index.html 里的行为一致）
const prelude = `
  const localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  function isPlainObject(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }
  function clonePlain(o) {
    if (!isPlainObject(o)) return {};
    try { return JSON.parse(JSON.stringify(o)); } catch (e) { return {}; }
  }
  function parseJsonValue(text) {
    try { return { ok: true, value: JSON.parse(String(text)) }; } catch (e) { return { ok: false, value: null }; }
  }
  function requestParams() { return { biz: [], common: [] }; }
  // 与 index.html 顶部同值：控制台用这个哨兵表示「我的全部私有规则」视图
  const ALL_PROJECTS = '__all_private__';
  // 横滑栏要用的外部件：$ 只认那一个元素，esc 与 index.html 里的实现逐字一致
  const __bar = { innerHTML: '', textContent: '', scrollLeft: 0, clientWidth: 380, scrollWidth: 380,
                  onwheel: null, querySelector: () => null, querySelectorAll: () => [] };
  function $(id) { return id === 'mock-projbar' ? __bar : null; }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  // 横滑栏读这三样；测试里直接改它，等价于改 state
  const state = { projects: [], allRules: [], projectId: null };
`
const factory = new Function(`${prelude}${slice}
  return { emptyDraft, emptyResponse, respList, curResp, normalizePick, reorderResp,
           respItemFromMock, respItemToMock, ruleToDraft, draftToRule, respLabel, circleNum,
           bodyPreview, responseFromRecord, nextSeqPick, DEFAULT_SEQ_PICK,
           privateProjects, sharedProjects, projectById, isWritableProject, rulesOfProject,
           projectNameOf, newOperationId, reuseOperationId, shareDiff,
           daysLeft, ALL_PROJECTS, renderMockProjBar, state, __bar };
`)
const M = factory()
const clone = (v) => JSON.parse(JSON.stringify(v))

console.log('\n[控制台] 草稿 ⇄ 规则 往返（node tools/console-mock-check.mjs）')

// 1. 存量单项规则：保存后 JSON 一字不变（旧形态不被改写成 responses）
const legacy = {
  id: 'r1', name: 'GET /api/user', enabled: true, priority: 10,
  match: { method: 'GET', host: 'api.foo.com:443', path: '/api/user', params: { u: 'a' } },
  action: { type: 'mock', mode: 'static', delayMs: 0, response: { status: 200, headers: { 'content-type': 'application/json', 'x-extra': '1' }, body: '{"a":1}' } },
}
let d = M.ruleToDraft(legacy)
check('旧形态读入：单条 + 指定', d.responses.length === 1 && d.pick === 'specific' && d.pinIndex === 0)
check('旧形态读入：自定义响应头保留（不再静默丢）', d.responses[0].headers['x-extra'] === '1')
const back = M.draftToRule(d)
check('单项规则保存后仍是旧的 response 形态（不写 responses）',
  !('responses' in back.action) && back.action.mode === 'static' && back.action.response.status === 200)
check('单项规则往返：body 语义不变、自定义响应头不丢',
  JSON.stringify(JSON.parse(back.action.response.body)) === '{"a":1}' && back.action.response.headers['x-extra'] === '1',
  JSON.stringify(back.action.response))
check('单项规则往返：match / priority / name 不变',
  JSON.stringify(back.match) === JSON.stringify(legacy.match) && back.priority === 10 && back.name === 'GET /api/user')

// 2. sequence 规则读入 → 原样写回（含四种 seqMode）
for (const sm of ['in-order', 'loop', 'once-then-passthrough', 'random']) {
  const r = {
    id: 'seq', enabled: true, priority: 1, match: { method: 'GET', path: '/s' },
    action: { type: 'mock', mode: 'sequence', seqMode: sm, responses: [{ status: 201, body: '{"n":1}' }, { status: 202, body: '{"n":2}' }] },
  }
  const dd = M.ruleToDraft(r)
  const rr = M.draftToRule(dd)
  check(`sequence/${sm} 往返：mode 与 seqMode 不变，responses 保持 2 条`,
    rr.action.mode === 'sequence' && rr.action.seqMode === sm && rr.action.responses.length === 2, JSON.stringify(rr.action))
}

// 2.5 「按顺序」的默认子模式 = 循环返回（用户新选的那一下）
check('默认子模式是循环返回（不是协议缺省的 in-order）', M.DEFAULT_SEQ_PICK === 'loop')
check('从「指定 / 随机」切到「按顺序」→ 用默认的循环返回',
  M.nextSeqPick('specific') === 'loop' && M.nextSeqPick('random') === 'loop' && M.nextSeqPick(undefined) === 'loop')
check('已经是顺序子模式 → 保留用户上次选的（不强行改回循环）',
  M.nextSeqPick('in-order') === 'in-order' && M.nextSeqPick('once-then-passthrough') === 'once-then-passthrough' &&
  M.nextSeqPick('loop') === 'loop')
// 但要如实显示存量规则：mode=sequence 却缺 seqMode 时，服务端按 in-order 走
// （协议 §5.4）。这里若跟着 UI 默认显示成「循环」就是静默不一致。
const noSeq = { id: 'n', enabled: true, priority: 1, match: { method: 'GET', path: '/n' },
  action: { type: 'mock', mode: 'sequence', responses: [{ status: 201, body: '{}' }, { status: 202, body: '{}' }] } }
const dn = M.ruleToDraft(noSeq)
check('存量 sequence 缺 seqMode → 仍如实显示「依次」，不被新默认值带偏', dn.pick === 'in-order', dn.pick)
check('存量 sequence 缺 seqMode → 往返不变（仍是 in-order）', M.draftToRule(dn).action.seqMode === 'in-order')
// 新选「按顺序」后落库的形态：mode=sequence + seqMode=loop + 多条 responses
const dNew = M.emptyDraft()
dNew.responses.push(M.emptyResponse({ status: 401 }))
dNew.pick = M.nextSeqPick('specific')
const rNew = M.draftToRule(dNew)
check('新选「按顺序」→ 落库 mode=sequence + seqMode=loop + 两条 responses',
  rNew.action.mode === 'sequence' && rNew.action.seqMode === 'loop' && rNew.action.responses.length === 2, JSON.stringify(rNew.action))

// 3. specific 多条：pinIndex 往返（含越界夹回）
const specific = {
  id: 'sp', enabled: true, priority: 1, match: { method: 'GET', path: '/p' },
  action: { type: 'mock', mode: 'specific', pinIndex: 2, responses: [{ status: 201, body: '{"n":1}' }, { status: 202, body: '{"n":2}' }, { status: 203, body: '{"n":3}' }] },
}
d = M.ruleToDraft(specific)
check('specific 读入：pick/pinIndex 一致', d.pick === 'specific' && d.pinIndex === 2)
check('specific 往返：pinIndex 保持 2', M.draftToRule(d).action.pinIndex === 2)
d = M.ruleToDraft({ ...specific, action: { ...specific.action, pinIndex: 99 } })
check('specific 读入：pinIndex 越界夹回最后一条', d.pinIndex === 2)
d = M.ruleToDraft({ ...specific, action: { ...specific.action, pinIndex: -3 } })
check('specific 读入：pinIndex 负数夹回第 0 条', d.pinIndex === 0)
d = M.ruleToDraft({ ...specific, action: { ...specific.action, pinIndex: '1' } })
check('specific 读入：脏 pinIndex（字符串）夹回第 0 条', d.pinIndex === 0)
// 有 responses 但缺 mode 的旧脏数据 → 指定第 0 条，不炸
d = M.ruleToDraft({ ...specific, action: { responses: specific.action.responses } })
check('有 responses 缺 mode 的脏数据：按指定第 0 条处理', d.pick === 'specific' && d.pinIndex === 0)
// responses 里的脏元素被丢掉
d = M.ruleToDraft({ ...specific, action: { mode: 'specific', responses: [1, null, { status: 299, body: '{"ok":1}' }] } })
check('responses 里的脏元素被丢掉（只剩合法条目）', d.responses.length === 1 && d.responses[0].status === 299)

// 4. 「本条备注」往返
d = M.ruleToDraft(specific)
d.responses[1].name = '密码错误'
check('备注 name 写进规则', M.draftToRule(d).action.responses[1].name === '密码错误')
d.responses[1].name = '   '
check('空白备注不写进规则（不留空字段）', !('name' in M.draftToRule(d).action.responses[1]))

// 5. 命中方式切换
d = M.ruleToDraft(specific)
d.pick = 'loop'
check('pick=loop → mode sequence + seqMode loop', (() => { const a = M.draftToRule(d).action; return a.mode === 'sequence' && a.seqMode === 'loop' && a.responses.length === 3 })())
d.pick = 'random'
check('pick=random → seqMode random', M.draftToRule(d).action.seqMode === 'random')
d.pick = 'specific'
check('切回指定 → mode specific + pinIndex', (() => { const a = M.draftToRule(d).action; return a.mode === 'specific' && a.pinIndex === 2 })())

// 6. 拖拽换序：sel / pinIndex 跟着条目走，不跟下标跑偏
d = M.ruleToDraft(specific)          // 3 条，pin=2
d.sel = 0                            // 当前在编辑第 0 条
const tag = (x) => x.body
const before0 = tag(M.curResp(d))
M.reorderResp(d, 0, 2)               // 把第 0 条拖到最后
check('换序后仍选中原来那条（sel 跟着走）', M.curResp(d) === d.responses[2] && tag(M.curResp(d)) === before0)
check('换序后 pinIndex 仍指向原来那条（2 → 1）', d.pinIndex === 1 && d.responses[1].status === 203)
d = M.ruleToDraft(specific)
d.sel = 1; d.pinIndex = 1
M.reorderResp(d, 2, 0)               // 把最后一条拖到最前
check('向前拖动：选中项与指定同步位移', d.sel === 2 && d.pinIndex === 2)
d = M.ruleToDraft(specific)
M.reorderResp(d, 1, 1)
check('原地拖动是无操作（数组与选中项不变）',
  d.responses.map((x) => x.status).join(',') === '201,202,203' && d.sel === 0 && d.pinIndex === 2)
d = M.ruleToDraft(specific)
M.reorderResp(d, 0, 99)
check('越界拖动不丢条目（夹到最后）', d.responses.length === 3)
d = M.ruleToDraft(specific)
M.reorderResp(d, 5, 0)
check('非法 from 不改变数组', d.responses.length === 3)

// 7. 增删后的下标数学（与 bindMockEditor 里的逻辑同口径）
d = M.ruleToDraft(specific)          // pin=2, sel=0
let rs = M.respList(d)
rs.splice(1, 1)                      // 删掉中间那条
if (Number(d.pinIndex) > 1) d.pinIndex = Number(d.pinIndex) - 1
else if (Number(d.pinIndex) === 1) d.pinIndex = Math.min(1, rs.length - 1)
if (d.sel > 1) d.sel -= 1; else if (d.sel === 1) d.sel = Math.min(1, rs.length - 1)
M.normalizePick(d)
check('删中间那条：pinIndex 3→2 条的范围内前移', d.pinIndex === 1 && rs.length === 2)
rs = M.respList(d)
rs.splice(0, 0, M.emptyResponse({ status: 500, name: '新' }))
M.normalizePick(d)
check('插入新条目不影响已有下标', rs.length === 3 && d.pinIndex === 1)

// 8. 列表第二行的返回值摘要
const three = [{ status: 1 }, { status: 2 }, { status: 3 }]
check('多条规则显示条数与命中方式', M.respLabel({ action: { mode: 'sequence', seqMode: 'in-order', responses: three } }) === ' · 3 条返回值（依次）')
check('指定模式显示指定第几条', M.respLabel({ action: { mode: 'specific', pinIndex: 1, responses: [{ status: 1 }, { status: 2 }] } }) === ' · 2 条返回值（指定第 ② 条）')
check('单项规则不显示摘要（避免噪音）', M.respLabel({ action: { mode: 'static', response: {} } }) === '')
check('圈码：0→①、9→⑩、20→#21', M.circleNum(0) === '①' && M.circleNum(9) === '⑩' && M.circleNum(20) === '#21')
check('正文预览压成单行并截断', M.bodyPreview('{\n  "a": 1\n}') === '{ "a": 1 }' && M.bodyPreview('x'.repeat(200)).length === 121)

// 9. 旧形态 + 「追加一条」= 多条（真实使用路径：先 Mock 此接口，再追加真实响应）
d = M.ruleToDraft(legacy)
M.respList(d).push(M.responseFromRecord({ response: { status: 401, headers: { 'content-type': 'application/json' }, body: '{"code":1001}' } }, '真实响应 2'))
d.pinIndex = 1
check('单条 + 追加真实响应 → 变成 2 条 specific',
  (() => { const a = M.draftToRule(d).action; return a.mode === 'specific' && a.responses.length === 2 && a.pinIndex === 1 && a.responses[1].name === '真实响应 2' })())
check('追加后仍保留原有的 x-extra 响应头', M.draftToRule(d).action.responses[0].headers['x-extra'] === '1')
d.pick = 'once-then-passthrough'
check('两条 + 依次后放行 → mode sequence + responses', (() => { const a = M.draftToRule(clone(d)).action; return a.mode === 'sequence' && a.seqMode === 'once-then-passthrough' && a.responses.length === 2 })())

// 10. 保存无损（ADR-027）：控制台不认识的字段不能被静默抹掉
//     场景是「CLI 写了 groupId / 别人写了 cond，用户只想在控制台改个 body」——
//     改一次就把别人的配置清空，两边都看不出发生过，属于最难查的那类静默失效。
//     C13 之后 groupId 已是协议字段，但**控制台本期没有分组 UI**（ADR-030 决策：只做服务端 + CLI）。
//     所以这里故意保留 groupId 在这个用例里：它测的正是「界面不渲染这个字段，也不能把它抹掉」。
const rich = {
  id: 'rich', name: '带扩展字段的规则', enabled: true, priority: 7, groupId: 'g_pay', latencyHint: 120,
  match: { method: 'POST', host: 'api.foo.com:443', path: '/pay', params: { order: 'A1' }, source: 'openapi' },
  action: {
    type: 'mock', mode: 'specific', pinIndex: 1, delayMs: 800,
    responses: [
      { status: 200, headers: { 'content-type': 'application/json', 'x-amt': '1' }, body: '{"ok":1}', name: '成功', cond: { query: 'a=1', content: 'ok' } },
      { status: 500, headers: { 'content-type': 'text/plain' }, body: 'boom', cond: { content: 'fail' }, tag: '自定义' },
    ],
  },
  ext: { nested: { keep: true } },
}
d = M.ruleToDraft(rich)
check('扩展字段读入：草稿保留原始副本', d._raw.groupId === 'g_pay' && d._rawMatch.source === 'openapi')
let out = M.draftToRule(d)
check('规则级未知字段原样写回（groupId / latencyHint / ext）',
  out.groupId === 'g_pay' && out.latencyHint === 120 && JSON.stringify(out.ext) === '{"nested":{"keep":true}}',
  JSON.stringify(out))
check('match 级未知字段原样写回（source）', out.match.source === 'openapi')
check('action 级 delayMs 保留（控制台没有延迟输入框）', out.action.delayMs === 800)
check('条目级 cond 原样保留', out.action.responses[0].cond.query === 'a=1' && out.action.responses[1].cond.content === 'fail')
check('条目级任意未知字段保留（tag）', out.action.responses[1].tag === '自定义')
check('条目级自定义响应头保留（x-amt）', out.action.responses[0].headers['x-amt'] === '1')
check('草稿内部字段不漏进规则 JSON（_raw / _rawMatch / _rawAction）',
  !('_raw' in out) && !('_rawMatch' in out) && !('_rawAction' in out) &&
  !out.action.responses.some((x) => '_raw' in x))

// 只改 body：除 body 外一个字都不能动
// （body 会被编辑器 normalizeDraftBody 格式化——JSON 会重排版，这是编辑器的既定行为，
//   所以 body 按解析后的语义比，其余字段按字节比）
function bodySemanticEqual(a, b) {
  const j = (t) => { try { return { ok: true, value: JSON.parse(String(t)) } } catch (e) { return { ok: false, value: null } } }
  const pa = j(a), pb = j(b)
  if (pa.ok && pb.ok) return JSON.stringify(pa.value) === JSON.stringify(pb.value)
  return String(a) === String(b)
}
function unchangedExceptBody(a, b) {
  const ka = Object.keys(a).filter((k) => k !== 'body').sort()
  const kb = Object.keys(b).filter((k) => k !== 'body').sort()
  if (ka.join() !== kb.join()) return false
  return ka.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k])) && bodySemanticEqual(a.body, b.body)
}
d = M.ruleToDraft(rich)
d.responses[1].body = 'boom 2'
out = M.draftToRule(d)
check('只改正文 → 其余条目除 JSON 重排版外字节级不变', unchangedExceptBody(out.action.responses[0], rich.action.responses[0]),
  JSON.stringify(out.action.responses[0]))
check('改的那条只变 body，cond / tag / headers 都还在',
  out.action.responses[1].body === 'boom 2' && out.action.responses[1].cond.content === 'fail' &&
    out.action.responses[1].tag === '自定义' && out.action.responses[1].headers['content-type'] === 'text/plain' &&
    unchangedExceptBody(out.action.responses[1], { ...rich.action.responses[1], body: 'boom 2' }),
  JSON.stringify(out.action.responses[1]))
check('无损往返：规则级 / match 级扩展字段一个不少',
  out.groupId === 'g_pay' && out.latencyHint === 120 && out.ext.nested.keep === true &&
    out.match.source === 'openapi' && out.action.delayMs === 800)

// 形态切换必须删掉另一形态的字段（服务端优先读 responses，留着旧数组会静默失效）
d = M.ruleToDraft(rich)                       // 2 条 specific
d.responses.splice(1, 1)                       // 删到只剩 1 条
d.pick = 'specific'
out = M.draftToRule(d)
check('多条改成 1 条 → 落库旧形态 static，且不留 responses 残留',
  out.action.mode === 'static' && !('responses' in out.action) && !('pinIndex' in out.action),
  JSON.stringify(out.action))
check('改成单条后 cond 仍跟着那条走', out.action.response.cond.query === 'a=1')
const singleCond = {
  id: 'sc', enabled: true, priority: 0, groupId: 'g1',
  match: { method: 'GET', path: '/c' },
  action: { type: 'mock', mode: 'static', delayMs: 0, response: { status: 200, headers: {}, body: '{}', cond: { query: 'k=1' } } },
}
d = M.ruleToDraft(singleCond)
M.respList(d).push(M.emptyResponse({ status: 201 }))
out = M.draftToRule(d)
check('单条追加成多条 → 落库 responses 形态，且不留 response 残留',
  out.action.mode === 'specific' && Array.isArray(out.action.responses) && !('response' in out.action),
  JSON.stringify(out.action))
check('旧形态的 cond 不会因为换成数组而丢', out.action.responses[0].cond.query === 'k=1')
check('单条切多条时清掉旧的 seqMode（若有）', !('seqMode' in out.action))
// 顺序 → 指定：seqMode 是 sequence 专属，留着会让下次读入时状态自相矛盾
const seqRich = {
  id: 'sq', enabled: true, priority: 0, match: { method: 'GET', path: '/s' },
  action: { type: 'mock', mode: 'sequence', seqMode: 'loop', delayMs: 50,
    responses: [{ status: 201, body: '{}' }, { status: 202, body: '{}' }] },
}
d = M.ruleToDraft(seqRich)
check('顺序规则读入：pick 用 seqMode', d.pick === 'loop')
d.pick = 'specific'
out = M.draftToRule(d)
check('顺序改指定 → 删掉 seqMode，写入 pinIndex', out.action.seqMode === undefined && out.action.pinIndex === 0)
check('顺序改指定：cond / delayMs 无损',
  out.action.responses[1].body === '{}' && out.action.delayMs === 50 &&
    out.action.responses.every((x, i) => x.status === seqRich.action.responses[i].status))
d = M.ruleToDraft(seqRich)
d.pick = 'random'
out = M.draftToRule(d)
check('顺序内部切换（loop → random）不改动 responses',
  out.action.seqMode === 'random' && out.action.mode === 'sequence')
// 没有 delayMs 的规则不该被凭空写一个 0？——写了，但协议里 0 就是缺省，语义等价
check('无 delayMs 的规则保存后为 0（等价缺省）',
  M.draftToRule(M.ruleToDraft(specific)).action.delayMs === 0)
// 名字清空 → 不留下空字符串字段
d = M.ruleToDraft(rich)
d.name = '  '
check('清空名称后不写空的 name 字段', !('name' in M.draftToRule(d)))

console.log('\n[控制台] 项目归属（C14 / ADR-033）的纯逻辑')
{
  // 这一区段是 C14 最容易「静默失效」的地方：归属判错 → 规则写进虚空、或界面显示「开」
  // 但服务端永不命中。全部按 AGENTS.md §4/§6 的口径测：正常 + 类型混淆 + 缺字段 + 空 + 越界。
  const priv = { id: 'p1', scope: 'private', name: '登录联调', enabled: true, ruleCount: 2 }
  const privOff = { id: 'p2', scope: 'private', name: '已停用的项目', enabled: false }
  const sh = { id: 's1', scope: 'shared', name: '旧版共享规则', ruleCount: 7 }
  const dirty = { id: 'd1', name: '缺 scope' }
  const PS = [priv, privOff, sh, dirty, null, 'not-an-object']

  check('私有 / 共享分栏只认 scope 字段（缺 scope 的脏条目两边都不进）',
    M.privateProjects(PS).map((p) => p.id).join() === 'p1,p2' &&
      M.sharedProjects(PS).map((p) => p.id).join() === 's1')
  for (const bad of [null, undefined, 'x', 42, {}]) {
    check(`分栏函数扛住非数组入参（${JSON.stringify(bad)}）`,
      M.privateProjects(bad).length === 0 && M.sharedProjects(bad).length === 0)
  }
  check('可写档位只有 private：shared / 缺 scope / null 一律 false',
    M.isWritableProject(priv) && M.isWritableProject(privOff) &&
      !M.isWritableProject(sh) && !M.isWritableProject(dirty) && !M.isWritableProject(null) &&
      !M.isWritableProject({ scope: 'PRIVATE' }))
  check('projectById：空 id / 查不到都返回 null，不被数组里的脏条目炸掉',
    M.projectById(PS, null) === null && M.projectById(PS, '') === null &&
      M.projectById(PS, 'nope') === null && M.projectById(PS, 'p1') === priv &&
      M.projectById(null, 'p1') === null)

  const rules = [
    { id: 'a', groupId: 'p1' }, { id: 'b', groupId: 'p2' }, { id: 'c', groupId: 's1' },
    { id: 'd' }, null, 'x',
  ]
  check('「全部私有规则」视图 = 原样全量（哨兵与空 id 同义）',
    M.rulesOfProject(rules, M.ALL_PROJECTS) === rules && M.rulesOfProject(rules, null).length === rules.length)
  check('单项目视图只取本项目那几条（脏条目被滤掉）',
    M.rulesOfProject(rules, 'p1').map((r) => r.id).join() === 'a' &&
      M.rulesOfProject(rules, 'p2').map((r) => r.id).join() === 'b')
  check('按项目 id 过滤不认档位：shared id 也只是一次普通过滤（判档别的函数负责）',
    M.rulesOfProject(rules, 's1').map((r) => r.id).join() === 'c')
  check('查不存在的项目 → 空列表而不是全量（视图不能退化成「所有规则」）',
    M.rulesOfProject(rules, 'ghost').length === 0)
  for (const bad of [null, undefined, {}, 'x']) {
    check(`规则切片扛住非数组（${JSON.stringify(bad)}）`, M.rulesOfProject(bad, 'p1').length === 0)
  }

  check('归属文案把「共享不命中」写在名字后面（界面不能让人误读）',
    M.projectNameOf(PS, 's1') === '旧版共享规则（共享 · 不命中）')
  check('归属文案：自己的私有项目只显示名字', M.projectNameOf(PS, 'p1') === '登录联调')
  check('归属文案：脏 id / 空 id 明确写出「不命中」，不留空白',
    M.projectNameOf(PS, 'ghost').includes('不可见或已删除') &&
      M.projectNameOf(PS, '') === '未归属（不命中）' &&
      M.projectNameOf(null, 'ghost').includes('不可见或已删除'))

  // operationId：一次用户动作一个，失败重发必须复用（服务端靠它幂等）
  const cache = {}
  const k = 'share:p1'
  const id1 = M.reuseOperationId(cache, k, 'share')
  check('operationId 带动作前缀且够长（能看出来是哪类操作）',
    id1.startsWith('c_share_') && id1.length > 12)
  check('同一动作重复调用拿到同一个 id（失败后点第二次不会变成两次提交）',
    M.reuseOperationId(cache, k, 'share') === id1)
  check('不同动作各拿各的 id', M.reuseOperationId(cache, 'copy:s1', 'copy') !== id1)
  check('缓存里被写了脏值（非字符串）→ 换新 id 并覆盖，不返回对象',
    (() => { const c = { x: {} }; const n = M.reuseOperationId(c, 'x', 'share'); return typeof n === 'string' && n && c.x === n })())
  check('空 key / 非对象缓存不炸：直接给一个新 id 而不是 undefined',
    typeof M.reuseOperationId(cache, '', 'share') === 'string' &&
      typeof M.reuseOperationId(null, 'k', 'share') === 'string' &&
      M.reuseOperationId(cache, 'k', 'share') !== undefined)
  check('newOperationId 连续两次不相等（不是固定串）', M.newOperationId('a') !== M.newOperationId('a'))

  // shareDiff：确认框里「新增 / 删除 / 保留」三个数的来源
  const pRules = [{ id: 'pa' }, { id: 'pb' }, { id: 'pc' }]
  const lineage = [{ sharedRuleId: 'sa', privateRuleId: 'pa' }, { sharedRuleId: 'sb', privateRuleId: 'pb' }, { sharedRuleId: 'sc', privateRuleId: 'pc' }]
  const oldShared = [{ id: 'sa' }, { id: 'sb' }, { id: 'sc' }]
  check('复制后没动过 → 0 新增 0 删除 3 保留（覆盖不产生新 id）',
    JSON.stringify(M.shareDiff(pRules, lineage, oldShared)) ===
      JSON.stringify({ added: 0, removed: 0, kept: 3, willTotal: 3, hadTotal: 3 }))
  check('在私有副本里新增一条 → 分享时它是 added',
    (() => { const x = M.shareDiff([...pRules, { id: 'pd' }], lineage, oldShared); return x.added === 1 && x.kept === 3 && x.removed === 0 && x.willTotal === 4 })())
  check('在私有副本里删掉一条 → 分享时共享项目会少那条（removed 要说出来）',
    (() => { const x = M.shareDiff([{ id: 'pa' }, { id: 'pb' }], lineage, oldShared); return x.removed === 1 && x.kept === 2 && x.added === 0 })())
  check('首发（共享侧还没有规则）→ 全部算新增',
    (() => { const x = M.shareDiff(pRules, [], []); return x.added === 3 && x.removed === 0 && x.kept === 0 && x.hadTotal === 0 })())
  // lineage 里的共享 id 已被别的项目占过 / 已被删掉 → 服务端会重新分配 id，预览要按「新增」算
  check('lineage 指向的规则已不在共享项目里 → 算新增（不能谎报「保留」）',
    (() => { const x = M.shareDiff([{ id: 'pa' }], [{ sharedRuleId: 'gone', privateRuleId: 'pa' }], oldShared); return x.added === 1 && x.kept === 0 })())
  check('lineage 缺字段 / 脏元素被忽略（不抛异常）',
    (() => { const x = M.shareDiff(pRules, [null, 1, {}, { sharedRuleId: 'sa' }, { privateRuleId: 'pa' }], oldShared); return x.kept === 0 && x.added === 3 })())
  check('旧共享规则给成 id 字符串数组也能算（服务端两种形状都出现过）',
    (() => { const x = M.shareDiff(pRules, lineage, ['sa', 'sb', 'sc']); return x.kept === 3 && x.added === 0 })())
  for (const bad of [null, undefined, {}, 'x']) {
    check(`shareDiff 扛住非数组入参（${JSON.stringify(bad)}）`, (() => {
      const x = M.shareDiff(bad, bad, bad)
      return x && x.added === 0 && x.removed === 0 && x.kept === 0 && x.willTotal === 0
    })())
  }

  // 草稿 ⇄ 规则的归属往返（保存路径唯一写 groupId 的地方）
  const withGroup = { id: 'g', enabled: true, priority: 0, groupId: 'p1', match: { method: 'GET', path: '/g' },
    action: { type: 'mock', mode: 'static', response: { status: 200, headers: {}, body: '{}' } } }
  check('规则读入草稿：groupId → projectId', M.ruleToDraft(withGroup).projectId === 'p1')
  check('规则没有 groupId → 草稿 projectId 是 null（不是空串）', M.ruleToDraft({ ...withGroup, groupId: undefined }).projectId === null)
  check('脏 groupId（对象 / 空串）→ 草稿 projectId 归 null',
    M.ruleToDraft({ ...withGroup, groupId: { a: 1 } }).projectId === null &&
      M.ruleToDraft({ ...withGroup, groupId: '' }).projectId === null)
  const moved = M.ruleToDraft(withGroup); moved.projectId = 'p2'
  check('换归属后写回 groupId 是新项目', M.draftToRule(moved).groupId === 'p2')
  const cleared = M.ruleToDraft(withGroup); cleared.projectId = null
  check('草稿归属被清空 → 沿用规则原 groupId（不留空串，服务端空串是 400）',
    M.draftToRule(cleared).groupId === 'p1' && M.draftToRule(cleared).groupId !== '')
  const fresh = M.emptyDraft()
  check('新建草稿默认没有归属（必须先有私有项目）', fresh.projectId === null)
  check('新建草稿未指定归属时不写 groupId 字段', !('groupId' in M.draftToRule(fresh)))
  fresh.projectId = 'p1'
  check('指定归属后落库带 groupId', M.draftToRule(fresh).groupId === 'p1')
}

console.log('\n[控制台] CLI 登录接力的纯逻辑（#cli-login 那条地址 = 交出会话的授权）')
{
  // 这段逻辑决定「把会话 token 发给谁」，切出来逐条钉死（ADR-029）。
  // 出错方向只有一个：本该拒绝的地址被接受了 → 会话泄露给别的进程。
  const s = html.indexOf('function parseCliLogin(rawHash)')
  const e = html.indexOf('// ── CLI 登录接力：纯逻辑结束 ──')
  if (s < 0 || e < 0 || e <= s) throw new Error('切不出 CLI 登录接力区段（源码结构变了？）')
  const R = new Function(`${html.slice(s, e)}
    return { parseCliLogin, cliCallbackEndpoint, cliLoginPayload, cliConsentRows, cliDenyPayload };`)()

  const good = '#cli-login?port=54321&state=' + 'a'.repeat(48)
  const p = R.parseCliLogin(good)
  check('合法地址解析出端口与 nonce', p && p.port === 54321 && p.state === 'a'.repeat(48), JSON.stringify(p))
  check('大写 hex 的 nonce 也认', R.parseCliLogin('#cli-login?port=1025&state=' + 'A'.repeat(16)))
  const bad = {
    '空 hash': '',
    '没有 hash': null,
    '别的 hash 路由': '#other?port=54321&state=' + 'a'.repeat(48),
    'cli-login 出现在中间': '?x=#cli-login?port=54321&state=' + 'a'.repeat(48),
    '缺 state': '#cli-login?port=54321',
    '缺 port': '#cli-login?state=' + 'a'.repeat(48),
    '多一个参数': '#cli-login?port=54321&state=' + 'a'.repeat(48) + '&url=evil',
    '端口太低（1024 以下）': '#cli-login?port=80&state=' + 'a'.repeat(48),
    '端口越界': '#cli-login?port=65536&state=' + 'a'.repeat(48),
    '端口不是数字': '#cli-login?port=1&state=' + 'a'.repeat(48),
    '端口是小数': '#cli-login?port=54321.5&state=' + 'a'.repeat(48),
    '端口是 host:port': '#cli-login?port=127.0.0.1:54321&state=' + 'a'.repeat(48),
    'nonce 太短': '#cli-login?port=54321&state=abc',
    'nonce 太长': '#cli-login?port=54321&state=' + 'a'.repeat(65),
    'nonce 含非 hex': '#cli-login?port=54321&state=' + 'g'.repeat(48),
    'nonce 是空': '#cli-login?port=54321&state=',
    'port 重复出现': '#cli-login?port=54321&port=54322&state=' + 'a'.repeat(48),
  }
  for (const [name, hash] of Object.entries(bad)) {
    check(`拒绝：${name}`, R.parseCliLogin(hash) === null, String(R.parseCliLogin(hash)))
  }
  // 回传目标只有可能是本机回环：主机名是代码里写死的，不受 URL 内容影响
  check('回调地址固定写死 127.0.0.1',
    R.cliCallbackEndpoint({ port: 54321, state: 'x' }) === 'http://127.0.0.1:54321/ec-cli-callback')
  check('state 里塞 URL 也改不了回传目标',
    !R.cliCallbackEndpoint({ port: 54321, state: 'http://evil.com/' }).includes('evil.com'))

  const user = { phone: '13800000000', role: 'admin' }
  const pl = R.cliLoginPayload({ port: 54321, state: 'aa' }, 'sess1234567890', user)
  check('有会话时回传 state/session/phone/role',
    pl && pl.state === 'aa' && pl.session === 'sess1234567890' && pl.phone === '13800000000' && pl.role === 'admin')
  // 这条是「不会顺手把口令传出去」的唯一机械保证：字段集一旦变化就得说出来
  check('回传字段集恰好 4 个（不多传口令一类的东西）',
    Object.keys(pl).sort().join(',') === 'phone,role,session,state', Object.keys(pl).sort().join(','))
  check('没有会话 → 什么都不回传', R.cliLoginPayload({ state: 'aa' }, null, user) === null)
  check('空会话字符串不回传', R.cliLoginPayload({ state: 'aa' }, '', user) === null)
  check('会话类型混淆（对象）不回传', R.cliLoginPayload({ state: 'aa' }, { s: 1 }, user) === null)
  check('user 类型混淆（字符串）时 phone/role 为 null 而不是崩',
    R.cliLoginPayload({ state: 'aa' }, 'sess', 'not-an-object').phone === null)
  check('user 缺字段时 phone/role 为 null',
    R.cliLoginPayload({ state: 'aa' }, 'sess', {}).phone === null &&
      R.cliLoginPayload({ state: 'aa' }, 'sess', {}).role === null)
  check('req 为 null 时不回传', R.cliLoginPayload(null, 'sess', user) === null)

  const rows = R.cliConsentRows({ port: 54321, state: 'aa' }, user, 'http://10.0.0.1:8899')
  check('确认框把「服务地址 / 会话属于谁 / 回传地址」都摊开给人看',
    rows.length === 4 && rows[0][1] === 'http://10.0.0.1:8899' && rows[1][1] === '13800000000' &&
      rows[3][1] === 'http://127.0.0.1:54321/ec-cli-callback',
    JSON.stringify(rows))
  check('未登录状态下明确写出「未知」而不是留空',
    R.cliConsentRows({ port: 1, state: 'a' }, null, 'http://x')[1][1].includes('未知'))

  // 「拒绝」那条通知同样要能被机械验证：它带 state 就够，**绝不能带会话**
  const deny = R.cliDenyPayload({ port: 54321, state: 'aa' })
  check('拒绝载荷只有 state + denied 两个字段（不含 session / phone / role / 口令）',
    deny && Object.keys(deny).sort().join(',') === 'denied,state' && deny.denied === true,
    JSON.stringify(deny))
  check('没有登录请求时不生成拒绝载荷', R.cliDenyPayload(null) === null)
}

// ── 待删除倒计时（ADR-037）：UI 上「剩 N 天」全靠这一个函数 ──
console.log('\n[控制台] 共享项目待删除的倒计时')
{
  const DAY = 86400000
  const now = Date.now()
  check('正好 15 天 → 15 天', M.daysLeft(now + 15 * DAY) === 15)
  check('向上取整：剩半天算 1 天（不能显示 0 天却还没删）', M.daysLeft(now + DAY / 2) === 1)
  check('已经过期 → 0（不出现负数天数）', M.daysLeft(now - 5 * DAY) === 0)
  check('脏值一律 0：null / undefined / 字符串 / NaN / 对象都不抛',
    M.daysLeft(null) === 0 && M.daysLeft(undefined) === 0 && M.daysLeft('abc') === 0 &&
      M.daysLeft(NaN) === 0 && M.daysLeft({}) === 0)
  check('字符串数字也认（服务端 JSON 里万一是字符串）', M.daysLeft(String(now + 3 * DAY)) === 3)
}

// ── Mock 模式顶部项目横滑栏：列哪些项目、条数从哪来、选中态怎么判 ──
console.log('\n[控制台] Mock 模式顶部项目横滑栏')
{
  const mkP = (o) => Object.assign({ id: 'g_1', name: 'p', scope: 'private', enabled: true, createdAt: 0 }, o)
  const mkR = (id, groupId) => ({ id, groupId, enabled: true, match: { method: 'GET', path: '/' + id } })
  const bar = () => M.__bar.innerHTML

  M.state.projects = [
    mkP({ id: 'g_a', name: '登录联调' }),
    mkP({ id: 'g_b', name: '订单' }),
    mkP({ id: 'g_off', name: '停用的', enabled: false }),
    { id: 'g_s', name: '共享模板', scope: 'shared', enabled: true },
  ]
  M.state.allRules = [mkR('r1', 'g_a'), mkR('r2', 'g_a'), mkR('r3', 'g_b')]
  M.state.projectId = 'g_a'
  M.renderMockProjBar()

  check('列了「全部」+ 每个私有项目 + 末尾的「+」',
    (bar().match(/data-mp="/g) || []).length === 5, bar().slice(0, 160))
  check('共享项目不进这条栏（共享是只读模板，规则挂不上去）',
    !bar().includes('g_s') && !bar().includes('共享模板'))
  check('每个 chip 带自己的条数（全部 3 / 登录联调 2 / 订单 1 / 停用 0）',
    bar().includes('全部</span><span class="n">3') && bar().includes('登录联调</span><span class="n">2') &&
      bar().includes('订单</span><span class="n">1') && bar().includes('停用的</span><span class="n">0'))

  // 条数必须来自 allRules：取当前视图的 rules 会让切项目后别的 chip 全变 0
  M.state.rules = [mkR('r1', 'g_a')]
  M.renderMockProjBar()
  check('切到某项目后其它 chip 的条数不跟着变 0（计数取全量 allRules）',
    bar().includes('订单</span><span class="n">1'))

  check('当前项目的 chip 是 on', /class="mproj-chip on"[^>]*data-mp="g_a"/.test(bar()))
  check('选了具体项目时「全部」不是 on', /class="mproj-chip"[^>]*data-mp="__all_private__"/.test(bar()))

  M.state.projectId = M.ALL_PROJECTS
  M.renderMockProjBar()
  check('选「全部」时「全部」是 on', /class="mproj-chip on"[^>]*data-mp="__all_private__"/.test(bar()))

  M.state.projectId = null
  M.renderMockProjBar()
  check('projectId 为 null 也把「全部」标 on（不出现「一个都没选中」）',
    /class="mproj-chip on"[^>]*data-mp="__all_private__"/.test(bar()))

  check('停用的项目卡带 off 类，开关 aria-checked=false 且文案「已停用」',
    /class="mproj-chip[^"]* off"/.test(bar()) &&
      /data-mpsw="g_off"[^>]*aria-checked="false"/.test(bar()) &&
      /class="swl">已停用</.test(bar()))

  // 每个私有项目一张卡一个开关；「全部」是聚合视图，不该有假开关
  check('开关数 == 私有项目数（「全部」不带整组开关）',
    (bar().match(/data-mpsw="/g) || []).length === 3 &&
      /data-mpsw="g_a"[^>]*aria-checked="true"/.test(bar()) &&
      bar().includes('3 个项目'))

  check('关组按钮的 title 讲清「只关命中、不改规则自己的开关」',
    /规则各自的开关不改/.test(bar()))

  // 删除入口就在卡上：不必先点进项目再找编辑器
  check('每张私有项目卡都有一个删除按钮',
    (bar().match(/data-mpdel="/g) || []).length === 3 &&
      /data-mpdel="g_a"/.test(bar()))
  check('删除按钮的 title 写明「连带删除规则 / 没有回收站」',
    /连带删除项目内 2 条规则/.test(bar()) && /没有回收站/.test(bar()))

  // 选中态落在「上行选项目」那个热区上：切视图与关整组是两个独立动作
  M.state.projectId = 'g_a'
  M.renderMockProjBar()
  check('当前项目卡的 pick 是 aria-pressed=true，且只有一张',
    (bar().match(/aria-pressed="true"/g) || []).length === 1 &&
      /class="mproj-chip on"[^>]*data-mp="g_a"/.test(bar()))

  M.state.projects = [mkP({ id: 'g_x', name: '<img src=x onerror=alert(1)>' })]
  M.state.allRules = []
  M.renderMockProjBar()
  check('项目名进 chip 要转义（防 XSS）',
    !bar().includes('<img src=x') && bar().includes('&lt;img src=x'))

  M.state.projects = []
  M.state.projectId = M.ALL_PROJECTS
  M.renderMockProjBar()
  check('一个私有项目都没有时，栏里仍有「全部」和「+」，且没有删除按钮',
    bar().includes('data-mp="__all_private__"') && bar().includes('data-mp="__new__"') &&
      !/data-mpdel=/.test(bar()))

  let threw = null
  try {
    M.state.projects = null
    M.state.allRules = null
    M.renderMockProjBar()
  } catch (e) { threw = e }
  check('projects / allRules 被写成 null 也不抛（脏数据兜底）', threw === null, String(threw && threw.message))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
