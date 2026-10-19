import { readFileSync } from 'node:fs'
import { CliError, EXIT, usageError } from './errors.ts'

export type FlagKind = 'string' | 'bool' | 'list'
export type FlagSpec = Record<string, FlagKind>

export interface Parsed {
  flags: Record<string, string | boolean | string[]>
  positional: string[]
}

/** 所有子命令都接受的全局参数 */
export const GLOBAL_FLAGS: FlagSpec = {
  json: 'bool',
  quiet: 'bool',
  verbose: 'bool',
  yes: 'bool',
  'base-url': 'string',
  'project-id': 'string',
  'group-id': 'string',
  config: 'string',
}

/**
 * `@path` 读文件、`-` / `@-` 读 stdin，其余原样返回。
 *
 * 存在的理由：skill 明确要求「大体积 jsonList 使用脚本生成参数或临时文件辅助拼装，
 * 避免命令行转义/截断问题」。在入口就给出文件/stdin 通道，agent 就不必自己拼 shell 转义。
 */
export function materialize(value: string): string {
  if (value === '-' || value === '@-') return readStdinText()
  if (value.startsWith('@')) {
    const file = value.slice(1)
    if (!file) throw usageError('空的 @文件 引用', '写法如 --json-list @/tmp/body.json')
    try {
      return readFileSync(file, 'utf8')
    } catch (e) {
      throw usageError(`读取 @文件 失败：${file}`, String(e))
    }
  }
  return value
}

export function readStdinText(): string {
  if (process.stdin.isTTY) {
    throw usageError('需要 stdin 输入，但当前是交互式终端', '改用管道：printf ... | mock xxx -')
  }
  try {
    return readFileSync(0, 'utf8')
  } catch (e) {
    throw new CliError('EC_USAGE', `读取 stdin 失败: ${String(e)}`, null, EXIT.USAGE)
  }
}

/**
 * 解析 argv。
 *
 * `kind === 'list'` 的 flag **按出现顺序累积**，并且逐项过 `materialize`。
 * 这是并行数组（`--json-list` / `--response-group-names` …）的基础：
 * skill 反复强调「数组类参数必须逐项重复传 flag」，解析器必须原样支持。
 *
 * 未知 flag 一律退出码 2 并列出该命令可用 flag，而不是静默忽略——
 * 静默忽略会让 agent 以为参数生效了（写坏 mock 的典型路径）。
 */
export function parseArgs(argv: string[], spec: FlagSpec): Parsed {
  const all: FlagSpec = { ...GLOBAL_FLAGS, ...spec }
  const flags: Record<string, string | boolean | string[]> = {}
  const positional: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    if (tok === '--') {
      for (let j = i + 1; j < argv.length; j++) positional.push(argv[j])
      break
    }
    if (tok === '' || tok === '-') {
      positional.push(tok)
      continue
    }
    if (!tok.startsWith('--')) {
      positional.push(tok)
      continue
    }

    let name = tok.slice(2)
    let inline: string | null = null
    const eq = name.indexOf('=')
    if (eq >= 0) {
      inline = name.slice(eq + 1)
      name = name.slice(0, eq)
    }

    const kind = all[name]
    if (!kind) {
      const available = Object.keys(all)
        .map((k) => `--${k}`)
        .sort()
        .join(' ')
      throw usageError(`未知参数 --${name}`, `该命令可用参数：${available}；完整帮助见 mock help`)
    }

    if (kind === 'bool') {
      if (inline !== null) throw usageError(`--${name} 是开关，不接受取值`, `去掉 =${inline} 即可`)
      flags[name] = true
      continue
    }

    let value = inline
    if (value === null) {
      const next = argv[i + 1]
      if (next === undefined) throw usageError(`--${name} 缺少取值`, `如 --${name} <value>`)
      value = next
      i++
    }

    if (kind === 'string') {
      flags[name] = value
      continue
    }

    const acc = flags[name]
    if (Array.isArray(acc)) acc.push(materialize(value))
    else flags[name] = [materialize(value)]
  }

  return { flags, positional }
}

export function flagStr(p: Parsed, name: string): string | null {
  const v = p.flags[name]
  return typeof v === 'string' ? v : null
}

/**
 * 在**未解析**的 argv 上取某个 flag 的取值。
 *
 * 存在的理由：`--config` 决定配置文件位置，而配置文件的加载发生在子命令参数解析
 * 之前。之前用「默认路径」加载会让 `--config` 静默失效，测试时把数据写进了真实
 * `~/.mock-cli`（AGENTS.md §4：参数被吞掉不报错，是最难查的一类问题）。
 */
export function peekFlag(argv: string[], name: string): string | null {
  const i = argv.indexOf(`--${name}`)
  if (i >= 0) {
    const next = argv[i + 1]
    return next && !next.startsWith('--') ? next : null
  }
  const eq = argv.findIndex((a) => a.startsWith(`--${name}=`))
  return eq >= 0 ? argv[eq].slice(`--${name}=`.length) : null
}

export function flagBool(p: Parsed, name: string): boolean {
  return p.flags[name] === true
}

export function flagList(p: Parsed, name: string): string[] {
  const v = p.flags[name]
  return Array.isArray(v) ? v : []
}

export function requireStr(p: Parsed, name: string, example: string): string {
  const v = flagStr(p, name)
  if (v === null || v === '') throw usageError(`缺少必填参数 --${name}`, `如 ${example}`)
  return v
}

/** 位置参数缺失时的统一报错（id 类参数一律用位置形式，与 skill 的写法一致） */
export function requirePositional(p: Parsed, index: number, label: string, example: string): string {
  const v = p.positional[index]
  if (v === undefined || v === '') {
    throw usageError(`缺少 ${label}`, `如 ${example}`)
  }
  return v
}

/**
 * 拒绝**多余的位置参数**。
 *
 * 这条守卫专门堵一个静默坑：`--json-list A B C` 只把 A 当成 flag 的值，B / C 会掉进
 * positional 里。命令如果本来不收位置参数，那这两条返回值就**悄悄消失了**——
 * CLI 报成功、服务端也只存了一条，agent 以为写了三条。
 * 平行数组的正确写法是每项各自重复 flag（`--json-list A --json-list B`）。
 */
export function rejectExtraPositionals(p: Parsed, allowed: number, example: string): void {
  if (p.positional.length <= allowed) return
  const extra = p.positional.slice(allowed)
  throw usageError(
    `多了 ${extra.length} 个没有归属的参数：${extra.map((x) => JSON.stringify(x)).join(' ')}`,
    `数组类参数要**每项各自重复传 flag**，不能用空格连着写（如 ${example}）`,
  )
}
