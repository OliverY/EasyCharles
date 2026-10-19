import { flagBool, flagStr, parseArgs } from '../args.ts'
import type { FlagSpec } from '../args.ts'
import { CliError, EXIT, usageError } from '../errors.ts'
import type { ConfigStore, Project } from '../config.ts'
import { ManagementClient } from '../client.ts'
import { cell, emit, info, modeOf, table, confirmOrDie } from '../output.ts'
import { clientFor, projectOf } from './auth.ts'
import { pickGroup, readGroupTable } from './group.ts'

const PROJECT_FLAGS: FlagSpec = { check: 'bool', name: 'string' }
const SET_FLAGS: FlagSpec = {}

function iso(ts: number | null): string {
  if (ts === null) return '-'
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function projectView(p: Project, isDefault: boolean): Record<string, unknown> {
  return {
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    phone: p.phone,
    hasSession: !!p.session,
    isDefault,
    lastUsedAt: p.lastUsedAt,
  }
}

/**
 * 在线探测。用 `/__ec/api/info` 而不是 `GET /`：
 * 前者给 JSON、后者给 HTML，且**未登录的 401 同样证明服务活着**——
 * 所以把 EC_UNAUTHORIZED 归成 reachable:true / authed:false，而不是失败。
 */
async function probe(project: Project): Promise<Record<string, unknown>> {
  const client = new ManagementClient({ baseUrl: project.baseUrl, session: project.session, timeoutMs: 4000 })
  try {
    const res = (await client.call('GET', '/__ec/api/info')) as Record<string, unknown>
    return { reachable: true, authed: true, serverVersion: res.serverVersion ?? null, protocol: res.protocol ?? null }
  } catch (e) {
    if (e instanceof CliError && (e.code === 'EC_UNAUTHORIZED' || e.code === 'EC_HTTP_401')) {
      return { reachable: true, authed: false, serverVersion: null, protocol: null }
    }
    if (e instanceof CliError && e.code === 'EC_UNREACHABLE') {
      return { reachable: false, authed: false, error: e.message }
    }
    return { reachable: true, authed: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function cmdProject(store: ConfigStore, argv: string[]): Promise<number> {
  const p = parseArgs(argv, PROJECT_FLAGS)
  const mode = modeOf(p)
  const sub = (p.positional[0] ?? 'list').toLowerCase()

  if (sub === 'add') {
    const nameArg = p.positional[1] ?? ''
    const baseUrl = flagStr(p, 'base-url') ?? (/^https?:\/\//.test(nameArg) ? nameArg : '')
    const name = /^https?:\/\//.test(nameArg) ? '' : nameArg
    if (!baseUrl) {
      throw usageError('project add 缺少 --base-url', '如 mock project add 本机 --base-url http://127.0.0.1:8899')
    }
    const created = store.addProject(name, baseUrl)
    const payload = { ok: true, project: projectView(created, store.data.defaults.project === created.id) }
    emit(payload, mode, () => info(`已添加 project ${created.id} ${created.name} → ${created.baseUrl}`))
    return EXIT.OK
  }

  if (sub === 'remove' || sub === 'rm') {
    const id = p.positional[1] ?? ''
    if (!id) throw usageError('project remove 缺少 project_id', '如 mock project remove local --yes')
    const victim = store.findProject(id)
    if (!victim) {
      throw usageError(`project 不存在：${id}`, `可用：${store.data.projects.map((x) => x.id).join(', ') || '（空）'}`)
    }
    await confirmOrDie(p, `删除 project ${victim.id}（${victim.name} @ ${victim.baseUrl}）`)
    store.removeProject(victim.id)
    emit({ ok: true, removed: victim.id }, mode, () => info(`已删除 project ${victim.id}`))
    return EXIT.OK
  }

  if (sub === 'use') {
    const id = p.positional[1] ?? ''
    if (!id) throw usageError('project use 缺少 project_id', '如 mock project use local')
    const found = store.findProject(id)
    if (!found) {
      throw usageError(`project 不存在：${id}`, `可用：${store.data.projects.map((x) => x.id).join(', ') || '（空）'}`)
    }
    store.setDefaultProject(found.id)
    emit({ ok: true, defaultProject: found.id, baseUrl: found.baseUrl }, mode, () => info(`默认 project = ${found.id} (${found.name})`))
    return EXIT.OK
  }

  if (sub !== 'list' && sub !== 'ls' && sub !== 'all') {
    throw usageError(`未知的 project 子命令：${sub}`, '可用：list / add / use / remove')
  }

  if (!store.data.projects.length) store.ensureLocalProject()
  const check = flagBool(p, 'check')
  const rows: string[][] = []
  const out: unknown[] = []
  for (const project of store.data.projects) {
    const isDefault = store.data.defaults.project === project.id
    const extra = check ? await probe(project) : {}
    const view = { ...projectView(project, isDefault), ...extra }
    out.push(view)
    rows.push(
      check
        ? [
            isDefault ? '*' : '',
            project.id,
            project.name,
            project.baseUrl,
            cell(view.reachable),
            cell(view.authed),
            cell(view.serverVersion ?? view.error ?? ''),
          ]
        : [
            isDefault ? '*' : '',
            project.id,
            project.name,
            project.baseUrl,
            cell(project.phone),
            project.session ? '有' : '无',
            iso(project.lastUsedAt),
          ],
    )
  }
  // 列表顺带提示「这次会打到哪台」。这里**故意不做完整解析**（多台且无默认时会报错），
  // 因为 `mock project` 正是用户在修复「缺少默认 project」时执行的命令，不能自己也报这错。
  const current =
    store.data.defaults.project ?? (store.data.projects.length === 1 ? store.data.projects[0].id : null)
  emit({ projects: out, defaultProject: store.data.defaults.project, currentProjectId: current }, mode, () => {
      process.stdout.write(
        table(
          check
            ? ['', 'id', 'name', 'baseUrl', 'online', 'authed', 'version']
            : ['', 'id', 'name', 'baseUrl', 'phone', 'session', 'lastUsed'],
          rows,
        ) + '\n',
      )
      if (!check) info('* = 默认 project；加 --check 探测每台服务是否在线')
    },
  )
  return EXIT.OK
}

export async function cmdSet(store: ConfigStore, argv: string[]): Promise<number> {
  const p = parseArgs(argv, SET_FLAGS)
  const mode = modeOf(p)
  const what = (p.positional[0] ?? '').toLowerCase()
  const value = p.positional[1] ?? ''

  const show = () => {
    const def = store.projectById(store.data.defaults.project)
    const payload = {
      defaultProject: store.data.defaults.project,
      defaultProjectName: def?.name ?? null,
      defaultBaseUrl: def?.baseUrl ?? null,
      defaultGroup: store.data.defaults.group,
    }
    emit(payload, mode, () =>
      process.stdout.write(
        table(
          ['默认项', '值'],
          [
            ['project', `${cell(payload.defaultProject)}${def ? ` (${def.name} @ ${def.baseUrl})` : ''}`],
            ['group', cell(payload.defaultGroup)],
          ],
        ) + '\n',
      ),
    )
  }

  if (!what || !value) {
    show()
    return EXIT.OK
  }

  if (what === 'project') {
    const found = store.findProject(value)
    if (!found) {
      throw usageError(
        `project 不存在：${value}`,
        `mock project 查看列表；可选：${store.data.projects.map((x) => x.id).join(', ') || '（空，先 mock project add）'}`,
      )
    }
    store.setDefaultProject(found.id)
    emit({ ok: true, defaultProject: found.id, baseUrl: found.baseUrl }, mode, () =>
      info(`默认 project = ${found.id} (${found.name} @ ${found.baseUrl})`),
    )
    return EXIT.OK
  }

  if (what === 'group') {
    // 存在性校验（C13）：把服务端没有的分组 id 存成本地默认值，后面每条命令都会拿它去撞墙。
    // 但**只有「确实查无此组」才失败**——没登录 / 连不上 / 服务端太旧都只是「暂时核对不了」，
    // 这是一条纯本地写入，把核对不了变成命令失败反而更难查（退出码会是 3/5，用户以为 set 坏了）。
    let verified = false
    let verifyNote: string | null = null
    try {
      const project = projectOf(p, store)
      const client = await clientFor({ store, mode, verbose: flagBool(p, 'verbose') }, p, project)
      const groups = await readGroupTable(client, '设置默认分组')
      pickGroup(groups, value, '设置默认分组')
      verified = true
    } catch (e) {
      if (e instanceof CliError && e.code === 'EC_NOT_FOUND') throw e
      if (e instanceof CliError && e.code === 'EC_NOT_IMPLEMENTED') throw e
      verifyNote = e instanceof Error ? e.message : String(e)
    }
    store.setDefaultGroup(value)
    emit({ ok: true, defaultGroup: value, verified, verifyNote }, mode, () => {
      info(`默认 group = ${value}${verified ? '（服务端已确认存在）' : ''}`)
      if (verifyNote) info(`注意：没能核对这个分组是否存在（${verifyNote}）；值已按原样存下`)
      info('提示：这是**本地默认值**，命令不会自动按它过滤或挂载，要显式写 --group-id')
      info('提示：C14 起只有**私有项目**能被 api create 用作默认归属；默认值指向共享项目时会被忽略（共享只读，先 copy）')
    })
    return EXIT.OK
  }

  throw usageError(`未知的 set 目标：${what}`, '可用：project / group')
}
