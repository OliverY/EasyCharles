/**
 * 插件目录扫描与加载（ADR-040 §5）。
 *
 * 目录约定（`<dataDir>` 已被 `.gitignore` 与发布包白名单双重排除，插件天生不在仓库里）：
 *
 * ```
 * <dataDir>/plugins/
 *   my-plugin/
 *     manifest.json     # { name, version, spiVersion, title?, entry? }
 *     index.mjs         # export default { ...CryptoPlugin }
 *   my-rot13.mjs        # 单文件版：name 取自模块导出，但必须与文件名一致
 * ```
 *
 * 五条规则，每条都对应一个真实的坏情况：
 *
 * 1. **只扫一层**，不递归——防止深层目录里藏东西，也防止误扫 node_modules；
 * 2. **名字必须匹配 `^[a-z0-9][a-z0-9_-]{0,39}$`**，`..` / `/` / `.` 因此不可能出现。
 *    注意是先用**目录名**拦一次，再信 manifest 里的 name：目录名是文件系统事实，
 *    改不了；manifest 是内容，可能写错也可能被构造；
 * 3. **`lstat` 拒软链接**——`plugins/x -> /etc` 这种不该被当成插件；
 * 4. **同名冲突两条都不用**，提示删一个。随机选一条生效比直接报错难查得多；
 * 5. **加载失败不抛到启动路径**：服务照常起，该插件记 `error` 与可操作原因，
 *    用到它的 profile 解密失败但请求不受影响。
 *
 * 入口只收 `.mjs`：`.js` 在 `<dataDir>` 下没有 `package.json {"type":"module"}` 时
 * 会被 Node 当成 CommonJS，`export` 直接语法报错——那种错看起来像「插件写坏了」，
 * 实际是文件后缀问题。干脆只认 `.mjs`，把这条歧义消掉。
 */

import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertPluginShape } from './registry.ts'
import { PLUGIN_NAME_RE, SPI_VERSION, type CryptoPlugin } from './plugin-types.ts'

/** 插件目录里最多认这么多个条目：再多基本是误把别的目录当成了插件目录 */
const MAX_ENTRIES = 64
/** manifest 的体量上限：它只是元数据，超过这个数一定不是手写的 */
const MANIFEST_MAX_BYTES = 64 * 1024
const ENTRY_EXT = '.mjs'

interface Manifest {
  name: string
  version: string
  spiVersion: number
  title?: string
  entry?: string
}

export type PluginStatus = 'loaded' | 'error'

export interface PluginEntry {
  /** 目录名 / 文件名（去掉 .mjs）。**注册用的名字最终以模块导出为准**，两者不一致算错误 */
  dirName: string
  kind: 'dir' | 'file'
  /** 入口模块绝对路径 */
  entryFile: string
  /** 入口文件 mtime，用于破 ESM 模块缓存（`?v=`） */
  mtimeMs: number
  status: PluginStatus
  error?: string
  plugin?: CryptoPlugin
  manifest?: Manifest
}

export interface ScanResult {
  /** 目录是否存在。不存在不是错误——大多数安装根本用不到私有插件 */
  exists: boolean
  entries: PluginEntry[]
  warnings: string[]
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function readManifest(file: string): Manifest {
  const raw = readFileSync(file)
  if (raw.byteLength > MANIFEST_MAX_BYTES) throw new Error(`manifest.json 超过 ${MANIFEST_MAX_BYTES} 字节`)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch (e) {
    throw new Error(`manifest.json 不是合法 JSON：${errMsg(e)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('manifest.json 顶层必须是对象')
  const o = parsed as Record<string, unknown>
  if (typeof o.name !== 'string' || !o.name) throw new Error('manifest.json 缺少 name')
  if (typeof o.version !== 'string' || !o.version) throw new Error('manifest.json 缺少 version')
  if (typeof o.spiVersion !== 'number') throw new Error('manifest.json 缺少 spiVersion（数字）')
  if (o.entry !== undefined && (typeof o.entry !== 'string' || !o.entry)) {
    throw new Error('manifest.json 的 entry 必须是非空字符串')
  }
  return {
    name: o.name,
    version: o.version,
    spiVersion: o.spiVersion,
    title: typeof o.title === 'string' ? o.title : undefined,
    entry: typeof o.entry === 'string' ? o.entry : undefined,
  }
}

/**
 * 入口文件名只能是一个**纯文件名**。
 *
 * `entry: "../../etc/passwd"` 这种必须当场拒掉：路径穿越在这一层挡掉，比指望
 * 「拼出来的路径刚好不存在」可靠。
 */
function safeEntryName(name: string): string {
  if (name !== basename(name) || name.includes('\\') || name === '..' || name === '.') {
    throw new Error(`入口文件名不合法：${JSON.stringify(name)}（只能是插件目录下的文件）`)
  }
  return name
}

/** 候选（尚未 import）。同名目录版 + 单文件版在这里就被判成冲突 */
interface Candidate {
  dirName: string
  kind: 'dir' | 'file'
  entryFile: string
  /** 入口文件 mtime（加载时按真实值再取一次） */
  mtimeMs: number
}

/**
 * 扫目录，返回每个插件的最终状态。**永不抛异常**——扫描失败是运维问题，
 * 不该把抓包服务拖下水。
 */
export async function scanPlugins(root: string): Promise<ScanResult> {
  const warnings: string[] = []
  const entries: PluginEntry[] = []

  let dirents: string[]
  try {
    dirents = readdirSync(root)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    // ENOENT = 没装过私有插件，属于正常状态，不打 warning
    if (code !== 'ENOENT') warnings.push(`插件目录无法读取（${root}）：${errMsg(e)}`)
    return { exists: false, entries, warnings }
  }

  const byName = new Map<string, Candidate[]>()
  let seen = 0
  for (const name of dirents.sort()) {
    if (name.startsWith('.')) continue // 隐藏文件：.DS_Store 之类
    if (++seen > MAX_ENTRIES) {
      warnings.push(`插件目录条目超过 ${MAX_ENTRIES} 个，其余已忽略（${root}）`)
      break
    }

    const full = join(root, name)
    let st
    try {
      // lstat 而不是 stat：软链接在这里必须被识别出来，而不是跟到目标上去
      st = lstatSync(full)
    } catch (e) {
      warnings.push(`跳过 ${name}：无法读取（${errMsg(e)}）`)
      continue
    }
    if (st.isSymbolicLink()) {
      warnings.push(`跳过软链接 ${name}：插件必须是真实目录或文件（防 plugins/x -> /etc 这类指向）`)
      continue
    }

    let cand: Candidate | null = null
    if (st.isDirectory()) {
      const base = name
      if (!PLUGIN_NAME_RE.test(base)) {
        warnings.push(`跳过目录 ${name}：名字只允许小写字母数字与 _-，最长 40`)
        continue
      }
      let manifest: Manifest
      try {
        const mf = join(full, 'manifest.json')
        if (!lstatSync(mf).isFile()) throw new Error('manifest.json 不是普通文件')
        manifest = readManifest(mf)
      } catch (e) {
        entries.push({
          dirName: base,
          kind: 'dir',
          entryFile: '',
          mtimeMs: 0,
          status: 'error',
          error: `读不到 manifest.json：${errMsg(e)}`,
        })
        continue
      }
      // manifest.name 必须与目录名一致：否则 registry 里的名字与磁盘上的目录对不上，
      // 「删掉某个目录」与「停用某个插件」会变成两件需要推理的事
      if (manifest.name !== base) {
        entries.push({
          dirName: base,
          kind: 'dir',
          entryFile: '',
          mtimeMs: 0,
          status: 'error',
          error: `manifest.name（${manifest.name}）必须与目录名（${base}）一致`,
        })
        continue
      }
      if (manifest.spiVersion !== SPI_VERSION) {
        // 在 import 之前就拒：SPI 对不上时连执行它的代码都不该发生
        entries.push({
          dirName: base,
          kind: 'dir',
          entryFile: '',
          mtimeMs: 0,
          status: 'error',
          error: `SPI 版本 ${manifest.spiVersion} 与内核 ${SPI_VERSION} 不匹配，请升级 EasyCharles 或换插件版本`,
          manifest,
        })
        continue
      }
      let entry: string
      try {
        entry = safeEntryName(manifest.entry ?? `index${ENTRY_EXT}`)
      } catch (e) {
        entries.push({
          dirName: base,
          kind: 'dir',
          entryFile: '',
          mtimeMs: 0,
          status: 'error',
          error: errMsg(e),
          manifest,
        })
        continue
      }
      if (extname(entry) !== ENTRY_EXT) {
        entries.push({
          dirName: base,
          kind: 'dir',
          entryFile: '',
          mtimeMs: 0,
          status: 'error',
          error: `入口必须是 ${ENTRY_EXT} 文件（收到 ${entry}）：.js 在数据目录下会被当成 CommonJS`,
          manifest,
        })
        continue
      }
      cand = { dirName: base, kind: 'dir', entryFile: join(full, entry), mtimeMs: st.mtimeMs }
    } else if (st.isFile()) {
      if (extname(name) !== ENTRY_EXT) {
        // 不是插件的东西（README、.zip）安静跳过；但 manifest.json 落在根上要提示
        if (name === 'manifest.json') warnings.push(`插件根目录下的 manifest.json 无效：单文件插件请把元数据写在模块导出里`)
        continue
      }
      const base = basename(name, ENTRY_EXT)
      if (!PLUGIN_NAME_RE.test(base)) {
        warnings.push(`跳过文件 ${name}：名字只允许小写字母数字与 _-，最长 40`)
        continue
      }
      let st2
      try {
        st2 = lstatSync(join(full))
      } catch (e) {
        warnings.push(`跳过 ${name}：${errMsg(e)}`)
        continue
      }
      cand = { dirName: base, kind: 'file', entryFile: join(full), mtimeMs: st2.mtimeMs }
    } else {
      continue
    }

    if (!cand) continue
    const list = byName.get(cand.dirName) ?? []
    list.push(cand)
    byName.set(cand.dirName, list)
  }

  for (const [name, list] of byName) {
    if (list.length > 1) {
      entries.push({
        dirName: name,
        kind: list[0].kind,
        entryFile: '',
        mtimeMs: 0,
        status: 'error',
        error: `同名插件出现两种形态（目录 ${name}/ 与文件 ${name}${ENTRY_EXT}），两条都不会加载；请删掉其中一个`,
      })
      continue
    }
    entries.push(await loadOne(list[0]))
  }

  entries.sort((a, b) => a.dirName.localeCompare(b.dirName))
  return { exists: true, entries, warnings }
}

/**
 * 真正 import 一个插件。
 *
 * `?v=<mtime>` 是必须的：ESM 模块缓存按 URL 走，不加这个 query 时「改完插件点重载」
 * 仍然跑旧代码——而这会被误判成「重载没生效」甚至「插件写错了」。
 */
async function loadOne(cand: Candidate): Promise<PluginEntry> {
  const base: PluginEntry = {
    dirName: cand.dirName,
    kind: cand.kind,
    entryFile: cand.entryFile,
    mtimeMs: cand.mtimeMs,
    status: 'error',
  }
  let manifest: Manifest | undefined
  try {
    const st = lstatSync(cand.entryFile)
    if (!st.isFile()) throw new Error('入口不是普通文件')
    base.mtimeMs = st.mtimeMs
    if (cand.kind === 'dir') {
      manifest = readManifest(join(dirname(cand.entryFile), 'manifest.json'))
      base.manifest = manifest
    }

    // mtimeMs 保留小数位：同一毫秒内改两次也该被视为「变了」，
    // 否则「改完点重载还是旧行为」会再次出现
    const mod = (await import(`${pathToFileURL(cand.entryFile).href}?v=${st.mtimeMs}`)) as {
      default?: unknown
    }
    if (!mod.default) throw new Error(`模块没有默认导出（应为 export default { ... }）`)
    const plugin = assertPluginShape(mod.default)

    // 名字必须与磁盘上的名字一致：单文件版没有 manifest，这条是唯一的一致性锚点
    if (plugin.name !== cand.dirName) {
      throw new Error(`导出的 name（${plugin.name}）必须与${cand.kind === 'dir' ? '目录' : '文件'}名（${cand.dirName}）一致`)
    }
    if (manifest) {
      if (plugin.spiVersion !== manifest.spiVersion) {
        throw new Error(`模块的 spiVersion（${plugin.spiVersion}）与 manifest（${manifest.spiVersion}）不一致`)
      }
      if (manifest.version !== plugin.version) {
        throw new Error(`模块的 version（${plugin.version}）与 manifest（${manifest.version}）不一致`)
      }
    }
    base.plugin = plugin
    base.status = 'loaded'
    return base
  } catch (e) {
    // import 阶段的语法错误 / 顶层抛错都在这里被收住：一个坏插件不能拦住服务启动
    base.error = errMsg(e)
    return base
  }
}
