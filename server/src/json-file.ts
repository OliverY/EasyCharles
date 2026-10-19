import { renameSync, unlinkSync, writeFileSync } from 'node:fs'

/**
 * JSON 落盘的**唯一**写法：临时文件 + `rename`。
 *
 * 为什么阶段 B 才换成它：C14 的一次 share / rollback 要跨 `rules.json` / `groups.json` /
 * 快照三个落盘点（协议 §5.5、架构 §6.3）。`writeFileSync` 直写目标文件在中断时留下的是
 * **半截 JSON**，下次启动读到的就是坏文件——按既有读路径口径它会退化成「空列表」，
 * 于是「一次失败的重写 = 全服规则静默清空」，正是 F-15 那类事故的形态（AGENTS.md §4）。
 * 同目录下的临时文件 + rename 在同一文件系统上是原子的：观察者只会看到旧文件或新文件。
 *
 * 临时文件必须与目标**同目录**（跨分区的 rename 不是原子的，且可能直接失败）。
 */
export function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch (e) {
    // ENOSPC / EACCES 时临时文件会留在目录里。协议 §5.5 那句「错误不留下半写文件」
    // 要求把它清掉：半截 JSON 不会污染读路径（没 rename 就不是目标文件名），
    // 但一次失败的 share 留下一堆 tmp 就是磁盘泄漏，而磁盘写满正是这类失败的成因。
    try {
      unlinkSync(tmp)
    } catch {
      /* 文件本来就没写成（例如 rename 已完成）——忽略 */
    }
    throw e
  }
}
