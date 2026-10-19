import { createInterface } from 'node:readline/promises'
import { CliError, EXIT, usageError } from './errors.ts'
import type { Parsed } from './args.ts'
import { flagBool } from './args.ts'

export type Mode = 'json' | 'quiet' | 'human'

export function modeOf(p: Parsed): Mode {
  if (flagBool(p, 'json')) return 'json'
  if (flagBool(p, 'quiet')) return 'quiet'
  return 'human'
}

export function isVerbose(p: Parsed): boolean {
  return flagBool(p, 'verbose')
}

export function verbose(p: Parsed, message: string): void {
  if (isVerbose(p)) process.stderr.write(`[mock] ${message}\n`)
}

/**
 * 管道被下游提前关闭时不要崩。
 *
 * `mock request list --json | head -5` 是最常见的 agent / shell 用法：`head` 读完就退出，
 * stdout 变成已关闭的管道，后续写入抛 EPIPE。没有这个守卫时进程会甩一坨
 * `Unhandled 'error' event ... write EPIPE` 的栈并以非 0 退出——
 * 对 agent 来说，一个「成功但输出被截断」的操作长得像「命令崩了」。
 */
export function installPipeGuard(): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (e: unknown) => {
      const code = (e as { code?: string } | null)?.code
      if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') {
        // 输出被截断不是失败：保持已设定的退出码（此刻还没设就是 0）安静退出
        process.exit(process.exitCode ?? 0)
      }
      process.stderr.write(`错误 EC_STREAM: stdout/stderr 写入失败：${String((e as Error | null)?.message ?? e)}\n`)
      process.exitCode = EXIT.GENERIC
    })
  }
}

/**
 * 正常输出走 stdout；人类可读的进度/警告走 stderr。
 * 这样 `mock api get x --json | jq` 拿到的永远是干净 JSON。
 */
export function emit(data: unknown, mode: Mode, human: () => void): void {
  if (mode === 'json') process.stdout.write(`${JSON.stringify(data, null, 2)}\n`)
  else if (mode === 'quiet') process.stdout.write(`${JSON.stringify(data)}\n`)
  else human()
}

export function info(message: string): void {
  process.stderr.write(`${message}\n`)
}

/**
 * 东亚字符占两列宽。
 *
 * `padEnd` 数的是**码点**，不是终端列数：`CLI 测试机` 长度 6 但实际占 10 列，
 * 于是人类模式的表格会一路排歪（中文域名 / 设备名 / 规则名都是常见内容）。
 * 只在人类可读输出里用；`--json` 不受影响。
 */
function displayWidth(str: string): number {
  let w = 0
  for (const ch of str) {
    const cp = ch.codePointAt(0) ?? 0
    // 常见 CJK / 全角 / 常用标点区间；不追求完整 wcwidth
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xe000 && cp <= 0xf8ff) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
    w += wide ? 2 : 1
  }
  return w
}

function padTo(str: string, width: number): string {
  const gap = width - displayWidth(str)
  return gap > 0 ? str + ' '.repeat(gap) : str
}

function padRows(rows: string[][]): string {
  if (!rows.length) return ''
  const widths: number[] = []
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      const len = displayWidth(row[i] ?? '')
      widths[i] = Math.max(widths[i] ?? 0, len)
    }
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) => (i === row.length - 1 ? cell : padTo(cell ?? '', widths[i] ?? 0)))
        .join('  ')
        .trimEnd(),
    )
    .join('\n')
}

export function table(header: string[], rows: string[][]): string {
  return padRows([header, ...rows])
}

export function cell(v: unknown): string {
  if (v === null || v === undefined) return '-'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}
/**
 * 错误输出：json/quiet 模式下是**一行可解析的 JSON**（含 code/hint），
 * 人类模式是 message + hint。始终写 stderr，退出码由 error.exit 决定。
 */
export function reportError(err: unknown, mode: Mode): number {
  const e = err instanceof CliError ? err : new CliError('EC_INTERNAL', String(err && err instanceof Error ? err.message : err), null, EXIT.GENERIC)
  if (mode === 'json' || mode === 'quiet') {
    process.stderr.write(`${JSON.stringify({ error: e.code, message: e.message, hint: e.hint })}\n`)
  } else {
    process.stderr.write(`错误 ${e.code}: ${e.message}\n`)
    if (e.hint) process.stderr.write(`提示: ${e.hint}\n`)
  }
  return e.exit
}

/**
 * 破坏性动作确认。
 *
 * 非 TTY 且没有 `--yes` 时**立即退出码 2**，绝不阻塞等待输入——
 * skill 的「常见问题」里明确写了「脚本调用时命令卡在交互选择」是要避免的行为，
 * 卡住的进程对 agent 来说等于超时黑洞。
 */
export async function confirmOrDie(p: Parsed, action: string): Promise<void> {
  if (flagBool(p, 'yes')) return
  if (!process.stdin.isTTY) {
    throw usageError(`${action} 需要显式确认`, '非交互环境请加 --yes（跳过确认，直接执行）')
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(`${action}？输入 y 确认 [y/N] `)
    if (answer.trim().toLowerCase() !== 'y') {
      throw new CliError('EC_ABORTED', '用户取消', null, EXIT.OK)
    }
  } finally {
    rl.close()
  }
}
