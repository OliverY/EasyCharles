/**
 * 单文件脚本插件（ADR-040 §5.6「脚本来源」）。
 *
 * 目录插件要写 `manifest.json` + `configSchema` + 完整 `CryptoPlugin`，适合「想做成
 * 可复用组件」的场合。但绝大多数业务只想知道一件事：**这段密文怎么变成明文**。
 * 所以这里提供更轻的形态——一个文件，两个函数：
 *
 * ```js
 * // <dataDir>/crypto/scripts/myapp.mjs
 * export function decrypt(text, options) { return '明文' }   // 入参密文串，出参明文字符串
 * export function encrypt(plain, options) { return '密文' }  // 可选，但 mock 回写要用
 * export const secrets = ['key']                             // 可选，不写则整份 options 打码
 * export const meta = { title: '业务包', version: '1.0.0' }   // 可选
 * ```
 *
 * 三条与目录插件**完全一致**的边界，不要在这里开口子：
 *
 * 1. `text` 是已经按 wrap 抠出来的**密文串**，不是整个 body。外壳（JSON 字段、`ciphertext:`
 *    前缀、query 参数名）属于 profile 配置，不属于脚本——否则每个脚本都要重写一遍剥壳。
 * 2. 必须**同步**。返回 Promise 会被明确拒绝（P1 的调用链是同步的，见 transform.ts）。
 * 3. 抛异常 = 解密失败，记录保留原文、请求照常转发。**不要**用它来传递业务错误。
 *
 * 安全边界与目录插件相同：能往 `<dataDir>` 写文件的人本来就能改服务本身。控制台**不提供**
 * 上传/编辑入口（LAN 管理面写代码 = 远程代码执行），改代码只能在本机用编辑器改文件。
 */

import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { bad } from './errors.ts'
import {
  SCRIPT_FILE_RE,
  SCRIPT_PREFIX,
  SPI_VERSION,
  type CryptoPlugin,
  type PluginOptions,
  type PluginResult,
} from './plugin-types.ts'

const SCRIPT_EXT = '.mjs'
/** 单个脚本上限：这就是一段业务变换，不该是打包产物 */
const MAX_SCRIPT_BYTES = 256 * 1024
const MAX_SCRIPTS = 64

export interface ScriptEntry {
  /** 文件名（不含 `.mjs`），也是注册名的后缀 */
  name: string
  /** 注册到 registry 的名字：`script:<name>` */
  pluginName: string
  file: string
  bytes: number
  mtimeMs: number
  status: 'loaded' | 'error'
  error?: string
  plugin?: CryptoPlugin
  /** 脚本声明的打码字段；空数组 = 整份 options 打码 */
  secrets: string[]
}

export interface ScriptScanResult {
  exists: boolean
  entries: ScriptEntry[]
  warnings: string[]
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function isPromise(v: unknown): v is Promise<unknown> {
  return !!v && typeof (v as Promise<unknown>).then === 'function'
}

/**
 * 把用户函数包成 SPI 要求的 `PluginResult`。
 *
 * 三处兜底都在这里，而不是让异常冒到 `transform.ts`：
 * 回调抛错、返回 Promise、返回非字符串。后两种如果放过去，会变成
 * 「记录里显示 `[object Promise]`」或「明文变成 `undefined`」——比直接报错难查得多。
 */
function callUser(
  fn: (text: string, options: PluginOptions) => unknown,
  text: string,
  options: PluginOptions,
  label: string,
  dir: 'decrypt' | 'encrypt',
): PluginResult<string> {
  let out: unknown
  try {
    out = fn(text, options)
  } catch (e) {
    return bad(`脚本 ${label} 的 ${dir} 抛异常：${errMsg(e)}`)
  }
  if (isPromise(out)) {
    void out.catch(() => {})
    return bad(`脚本 ${label} 的 ${dir} 返回了 Promise：请写成同步函数（异步要等 worker 宿主）`)
  }
  if (typeof out !== 'string') {
    return bad(`脚本 ${label} 的 ${dir} 必须返回字符串，收到 ${out === null ? 'null' : typeof out}`)
  }
  return { ok: true, value: out }
}

/** 从模块导出里找出那两个函数。命名导出优先，`export default` 兜底，减少写法歧义 */
function pickFns(mod: Record<string, unknown>): {
  decrypt?: (text: string, options: PluginOptions) => unknown
  encrypt?: (text: string, options: PluginOptions) => unknown
} {
  const d = mod.default
  const asFn = (v: unknown) => (typeof v === 'function' ? (v as (t: string, o: PluginOptions) => unknown) : undefined)
  const decrypt =
    asFn(mod.decrypt) ??
    asFn(d) ??
    (d && typeof d === 'object' ? asFn((d as Record<string, unknown>).decrypt) : undefined)
  const encrypt =
    asFn(mod.encrypt) ?? (d && typeof d === 'object' ? asFn((d as Record<string, unknown>).encrypt) : undefined)
  return { decrypt, encrypt }
}

async function loadOne(dir: string, name: string): Promise<ScriptEntry> {
  const file = join(dir, `${name}${SCRIPT_EXT}`)
  const entry: ScriptEntry = {
    name,
    pluginName: SCRIPT_PREFIX + name,
    file,
    bytes: 0,
    mtimeMs: 0,
    status: 'error',
    secrets: [],
  }
  try {
    const st = lstatSync(file)
    if (!st.isFile()) throw new Error('不是普通文件')
    entry.bytes = st.size
    entry.mtimeMs = st.mtimeMs
    if (st.size > MAX_SCRIPT_BYTES) throw new Error(`脚本超过 ${MAX_SCRIPT_BYTES} 字节`)

    // mtimeMs 保留小数位：同一毫秒内改两次也该被视为「变了」，否则重扫跑的还是旧代码
    const mod = (await import(`${pathToFileURL(file).href}?v=${st.mtimeMs}`)) as Record<string, unknown>
    const { decrypt, encrypt } = pickFns(mod)
    if (!decrypt) {
      throw new Error('没有找到 decrypt：请 export function decrypt(text, options)，或 export default 一个函数')
    }

    const rawSecrets = mod.secrets
    const secrets =
      Array.isArray(rawSecrets) && rawSecrets.every((x) => typeof x === 'string') ? (rawSecrets as string[]) : []
    const meta = (mod.meta && typeof mod.meta === 'object' ? mod.meta : {}) as Record<string, unknown>

    const plugin: CryptoPlugin = {
      spiVersion: SPI_VERSION,
      name: entry.pluginName,
      version: typeof meta.version === 'string' && meta.version ? meta.version : '0.0.0',
      title: typeof meta.title === 'string' && meta.title ? meta.title : `脚本 ${name}`,
      ...(typeof meta.description === 'string' ? { description: meta.description } : {}),
      capability: { decrypt: true, encrypt: !!encrypt },
      isolation: 'in-process',
      timeoutMs: 500,
      // 没有 configSchema：参数是自由 JSON。打码规则退化成 secretFields，由脚本自己声明
      secretFields: secrets,
      decrypt: ({ text, options }) => callUser(decrypt, text, options, name, 'decrypt'),
      ...(encrypt
        ? { encrypt: ({ text, options }: { text: string; options: PluginOptions }) => callUser(encrypt, text, options, name, 'encrypt') }
        : {}),
    }
    entry.plugin = plugin
    entry.secrets = secrets
    entry.status = 'loaded'
    return entry
  } catch (e) {
    // 语法错误 / 顶层抛错都在这里收住：一个坏脚本不能拦住服务启动
    entry.error = errMsg(e)
    return entry
  }
}

/**
 * 扫脚本目录。**永不抛异常**——与 `scanPlugins` 同一原则。
 *
 * 只扫一层、`lstat` 拒软链接、只收 `.mjs`：三条理由见 loader.ts 的注释，完全同构。
 */
export async function scanScripts(root: string): Promise<ScriptScanResult> {
  const warnings: string[] = []
  const entries: ScriptEntry[] = []
  let dirents: string[]
  try {
    dirents = readdirSync(root)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') warnings.push(`脚本目录无法读取（${root}）：${errMsg(e)}`)
    return { exists: false, entries, warnings }
  }

  let seen = 0
  for (const name of dirents.sort()) {
    if (name.startsWith('.')) continue
    if (++seen > MAX_SCRIPTS) {
      warnings.push(`脚本目录条目超过 ${MAX_SCRIPTS} 个，其余已忽略（${root}）`)
      break
    }
    const full = join(root, name)
    let st
    try {
      st = lstatSync(full)
    } catch (e) {
      warnings.push(`跳过 ${name}：无法读取（${errMsg(e)}）`)
      continue
    }
    if (st.isSymbolicLink()) {
      warnings.push(`跳过软链接 ${name}：脚本必须是真实文件`)
      continue
    }
    if (!st.isFile()) continue
    if (extname(name) !== SCRIPT_EXT) {
      if (name.endsWith('.js')) warnings.push(`跳过 ${name}：只收 ${SCRIPT_EXT}（.js 在数据目录下会被当成 CommonJS）`)
      continue
    }
    const base = basename(name, SCRIPT_EXT)
    if (!SCRIPT_FILE_RE.test(base)) {
      warnings.push(`跳过 ${name}：名字只允许小写字母数字与 _-，最长 40`)
      continue
    }
    entries.push(await loadOne(root, base))
  }
  return { exists: true, entries, warnings }
}

/** 读脚本源码，供控制台只读展示（**没有写入口**）。名字已校验，不可能越界 */
export function readScriptSource(root: string, name: string): { ok: true; source: string } | { ok: false; error: string } {
  if (!SCRIPT_FILE_RE.test(name)) return { ok: false, error: `脚本名不合法：${JSON.stringify(name)}` }
  const file = join(root, `${name}${SCRIPT_EXT}`)
  try {
    if (!lstatSync(file).isFile()) return { ok: false, error: `${name}${SCRIPT_EXT} 不是普通文件` }
    if (lstatSync(file).size > MAX_SCRIPT_BYTES) return { ok: false, error: '脚本过大，不展示' }
    return { ok: true, source: readFileSync(file, 'utf8') }
  } catch (e) {
    return { ok: false, error: errMsg(e) }
  }
}
