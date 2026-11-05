// 模块内核：插件的功能都是模块，内置的在 src/modules/，自己写的放数据目录 modules/（升级不会动）。
//
// - 每个模块能单独开关；自己写的模块和内置的同名，就替换掉内置的
// - 模块之间用 api.use('模块id') 拿对方导出的东西，用的时候再拿（对方被关了、换了也不会拿到旧的）
// - 模块注册的工具、上下文、命令、定时任务、面板接口都记在模块名下，关掉 / 重新加载时一起撤掉
// - 一个模块出错只影响它自己：启动失败记下原因，其他照常跑
// - 自己写的模块保存就生效（按修改时间重新加载），不用重启 DSH
//
// 接口说明给写模块的人看：src/modules/API.md（每次启动复制到数据目录 modules/ 里）。

import { existsSync, readdirSync, statSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname, relative, resolve, sep } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dataDir } from './store.js'
import { registerSecretField } from './config.js'
import { defineTool } from '../tools/tools.js'

/** 扩展接口版本：只加不改。哪天不得不改已有的东西才升到 2，并在更新说明里写清楚怎么迁移。 */
export const API_VERSION = 1
export const MIN_API_VERSION = 1

const SRC = fileURLToPath(new URL('../', import.meta.url)) // 插件的 src/
const BUILTIN_DIR = join(SRC, 'modules')
const ID_RE = /^[a-z][a-z0-9-]{1,39}$/
const ENTRY = ['index.mjs', 'index.js']
const DOC = 'API.md'
const TYPES = 'aurabot.d.ts'

export const userDir = () => dataDir('modules')

/** 内部源码全部按「相对 src 的路径」开放出来：lib('features/memory.js') → 那个文件导出的全部东西。 */
const libCache = new Map()
export async function loadLib() {
  if (libCache.size) return libCache
  const files = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name)
      if (e.isDirectory()) { if (!['templates', 'separator', '_template'].includes(e.name)) walk(full) }
      else if (e.name.endsWith('.js')) files.push(full)
    }
  }
  walk(SRC)
  for (const f of files) {
    const key = relative(SRC, f).split(sep).join('/')
    try { libCache.set(key, await import(pathToFileURL(f).href)) } catch (error) {}
  }
  return libCache
}
export function lib(key) {
  const k = String(key || '').replace(/^\.?\/?(src\/)?/, '')
  const hit = libCache.get(k) || libCache.get(k + '.js')
  if (!hit) throw new Error(`没有 ${key} 这个内部文件（看 API.md 的「内部源码」一节）`)
  return hit
}
export const libKeys = () => [...libCache.keys()].sort()

// 加载自己写的模块时跳过的目录：依赖、加载快照、版本库
const SKIP_DIRS = new Set(['node_modules', '.aurabot-cache', '.git'])
const SNAP = '.aurabot-cache'

/** 模块文件夹里所有文件（含子目录，不含依赖和快照）。 */
function filesOf(dir, base = dir, out = []) {
  let list = []
  try { list = readdirSync(dir, { withFileTypes: true }) } catch (error) { return out }
  for (const e of list) {
    const full = join(dir, e.name)
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) filesOf(full, base, out) }
    else if (e.isFile()) out.push(relative(base, full))
  }
  return out
}

/** 模块的「版本戳」：任何文件改了、加了、删了都会变。 */
function stampOf(dir) {
  let t = 0
  const files = filesOf(dir)
  for (const f of files) { try { t = Math.max(t, statSync(join(dir, f)).mtimeMs) } catch (error) {} }
  return Math.round(t) + files.length / 1000
}
const entryOf = (dir) => ENTRY.map((n) => join(dir, n)).find((p) => existsSync(p)) || ''

/** 数据目录 modules/ 里有哪些模块（目录名以 _ 或 . 开头的跳过）：[{ id, dir, file }] */
export function scanUser() {
  const out = []
  let names = []
  try { names = readdirSync(userDir(), { withFileTypes: true }) } catch (error) { return out }
  for (const e of names) {
    if (!e.isDirectory() || /^[_.]/.test(e.name)) continue
    const dir = join(userDir(), e.name)
    const file = entryOf(dir)
    if (file) out.push({ id: e.name, dir, file })
  }
  return out
}

/** 检查模块定义，返回出错原因（没问题返回空串）。 */
export function checkDef(def, id) {
  if (!def || typeof def !== 'object') return '入口文件要 export default 一个对象（看 API.md）'
  if (typeof def.setup !== 'function') return '模块里没有 setup(api) 函数'
  if (!ID_RE.test(String(def.id || ''))) return `模块 id「${def.id ?? ''}」不对：小写字母开头，只能有小写字母、数字和 -，2~40 个字`
  if (id && def.id !== id) return `模块 id「${def.id}」要和文件夹名「${id}」一样`
  const want = Number(def.api ?? 1)
  if (want > API_VERSION) return `这个模块要扩展接口 v${want}，现在的插件只有 v${API_VERSION}，先更新插件`
  if (want < MIN_API_VERSION) return `这个模块是按扩展接口 v${want} 写的，现在最低支持 v${MIN_API_VERSION}，按更新说明改一下`
  return ''
}

/** 把一份源码里指向插件内部的相对 import 改成走 lib()，这样复制出去也能跑。 */
export function rewriteImports(code, fromKey, keep = new Set()) {
  const base = fromKey.split('/').slice(0, -1)
  const target = (spec) => {
    if (!/^\.\.?\//.test(spec)) return null
    const parts = [...base]
    for (const seg of spec.split('/')) {
      if (seg === '..') parts.pop()
      else if (seg !== '.') parts.push(seg)
    }
    const key = parts.join('/')
    return keep.has(key) ? null : key
  }
  const names = (list) => list.split(',').map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/\s+as\s+/, ': ')).join(', ')
  let out = code.replace(/import\s+(\w+\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?/g, (m, def, list, spec) => {
    const key = target(spec)
    if (!key) return m
    const d = def ? `const ${def.replace(/[\s,]/g, '')} = __lib('${key}').default\n` : ''
    return `${d}const { ${names(list)} } = __lib('${key}')`
  })
  out = out.replace(/import\s+\*\s+as\s+(\w+)\s+from\s*['"]([^'"]+)['"];?/g, (m, name, spec) => {
    const key = target(spec)
    return key ? `const ${name} = __lib('${key}')` : m
  })
  out = out.replace(/import\s+(\w+)\s+from\s*['"]([^'"]+)['"];?/g, (m, name, spec) => {
    const key = target(spec)
    return key ? `const ${name} = __lib('${key}').default` : m
  })
  out = out.replace(/import\(\s*['"]([^'"]+)['"]\s*\)/g, (m, spec) => {
    const key = target(spec)
    return key ? `Promise.resolve(__lib('${key}'))` : m
  })
  // 插件里带的数据文件（new URL('./x.py', import.meta.url)）：指回插件目录
  out = out.replace(/new URL\(\s*['"](\.\.?\/[^'"]*)['"]\s*,\s*import\.meta\.url\s*\)/g, (m, spec) => {
    const key = target(spec)
    return key ? `new URL('${key}', globalThis.aurabot.src)` : m
  })
  if (out !== code) out = "const __lib = globalThis.aurabot.lib // 插件内部源码（复制出来后靠它找到插件里的文件）\n" + out
  return out
}

/**
 * @param {object} o
 * @param {object} o.ctx        DSH 给插件的 ctx
 * @param {object} o.core       核心对象（hub、onebot、snowluma、local……），模块通过 api.core 拿到
 * @param {Function} o.getConfig
 * @param {Function} o.setConfig
 * @param {object} o.logger
 * @param {string} o.version     插件版本
 * @param {object[]} o.builtins  内置模块定义（按启动顺序）
 */
export function createModules({ ctx, core, getConfig, setConfig, logger, version, builtins }) {
  const log = logger.child('modules')
  const builtinDefs = new Map(builtins.map((d) => [d.id, d]))
  const live = new Map() // id → 运行中的模块（见 start）
  const errors = new Map() // id → { message, at }  启动失败 / 加载失败
  const routes = new Map() // 完整路径 → { id, handler }
  const listeners = new Map() // 事件名 → [{ id, fn }]
  // 模块每次（重）启动都递增一次「代际」：hub 用它判断会话里挂的工具是不是旧模块实例的闭包。
  let generation = 0
  let userSeen = new Map() // id → { dir, file, stamp }
  let watching = null

  const modCfg = (id) => getConfig().modules?.[id] || {}
  const isEnabled = (id) => modCfg(id).enabled !== false
  const isUserOn = () => !getConfig().safeMode

  // ---------- 给模块的 api ----------
  function makeApi(id, source, rec) {
    const mlog = logger.child(id)
    const guard = (label, fn) => (...args) => {
      try {
        const r = fn(...args)
        if (r && typeof r.then === 'function') return r.catch((error) => { note(id, label, error); throw error })
        return r
      } catch (error) {
        note(id, label, error)
        throw error
      }
    }
    const track = (off) => { if (typeof off === 'function') rec.offs.push(off); return off }
    // 内置模块和替换它的版本用原来的路径（内置的面板页照常能用）；新模块放在 /ext/模块id/ 下
    const prefix = builtinDefs.has(id) ? '' : `/ext/${id}`
    const def = rec.def
    const api = {
      id,
      source,
      // 模块自己的文件夹（读自己带的数据文件用这个；import.meta.url 指向的是加载快照）
      dir: rec.dir || join(BUILTIN_DIR, id),
      apiVersion: API_VERSION,
      version,
      log: mlog,
      // ---- 配置 ----
      config: () => getConfig(),
      setConfig: (patch) => setConfig(typeof patch === 'function' ? patch(getConfig()) : deepMerge(getConfig(), patch)),
      settings: () => ({ ...(def.defaults || {}), ...(getConfig().ext?.[id] || {}) }),
      saveSettings: (patch) => {
        const cfg = getConfig()
        setConfig({ ...cfg, ext: { ...cfg.ext, [id]: { ...(cfg.ext?.[id] || {}), ...patch } } })
        return api.settings()
      },
      dataDir: (...parts) => { const d = dataDir('modules-data', id); mkdirSync(d, { recursive: true }); return join(d, ...parts) },
      // ---- 别的模块和插件内部 ----
      use: (other) => exportsOf(other),
      lazy: (other) => lazyProxy(() => exportsOf(other)),
      has: (other) => live.has(other),
      core,
      dsh: ctx,
      lib,
      // ---- 往插件里加东西 ----
      tool: (builder) => { rec.tools.push(builder); return () => remove(rec.tools, builder) },
      defineTool,
      context: (fn) => { rec.contexts.push(fn); return () => remove(rec.contexts, fn) },
      rule: (fn) => { rec.rules.push(fn); return () => remove(rec.rules, fn) },
      command: (c) => {
        if (!c || !c.name || typeof c.run !== 'function') throw new Error('command 要有 name 和 run')
        const item = { ...c, module: id }
        rec.commands.push(item)
        return () => remove(rec.commands, item)
      },
      on: (event, fn) => {
        const item = { id, fn: guard(`事件 ${event}`, fn) }
        const list = listeners.get(event) || []
        list.push(item)
        listeners.set(event, list)
        const off = () => listeners.set(event, (listeners.get(event) || []).filter((x) => x !== item))
        track(off)
        return off
      },
      emit: (event, ...args) => emit(event, ...args),
      every: (ms, fn, label = '定时任务') => {
        const t = setInterval(() => { Promise.resolve().then(fn).catch((error) => note(id, label, error)) }, Math.max(1000, Number(ms) || 60_000))
        t.unref?.()
        return track(() => clearInterval(t))
      },
      later: (ms, fn) => {
        const t = setTimeout(() => { Promise.resolve().then(fn).catch((error) => note(id, '延时任务', error)) }, Math.max(0, Number(ms) || 0))
        t.unref?.()
        return track(() => clearTimeout(t))
      },
      route: (path, handler) => {
        const full = '/aurabot/api' + prefix + (String(path).startsWith('/') ? path : '/' + path)
        const cur = routes.get(full)
        if (cur && cur.id !== id && live.has(cur.id)) throw new Error(`接口 ${full} 已经被模块「${cur.id}」占了`)
        routes.set(full, { id, handler: guard(`接口 ${path}`, handler) })
        return track(() => { if (routes.get(full)?.id === id) routes.delete(full) })
      },
      onDispose: (fn) => track(fn),
      // ---- 常用操作的捷径（都是 core 里的东西包了一层）----
      send: (chatId, text) => core.hub.deliver(String(chatId), String(text ?? '')),
      sendText: (chatId, text) => core.hub.sendText(String(chatId), String(text ?? '')),
      // 回某一条消息：群里以「引用回复」发出，私聊直接发
      reply: (msg, text) => core.hub.sendText(String(msg.chatId), String(text ?? ''), msg.kind === 'group' ? msg.messageId : undefined),
      isOwner: (userId) => String(userId) === String(getConfig().ownerQQ),
      sendImage: (chatId, src) => core.hub.sendImage(String(chatId), src),
      sendSegments: (chatId, segs, note) => core.hub.sendSegments(String(chatId), segs, note || `[${id}]`),
      // 发任意文件（文档 / 压缩包 / 音频 / 视频……）：本机绝对路径，或网关能取到的网址 / base64://
      sendFile: (chatId, file, name) => core.hub.sendFile(String(chatId), file, name),
      // 把一个音频文件当语音条发出去（不走念文字）
      sendVoiceFile: (chatId, file, note) => core.hub.sendVoiceFile(String(chatId), file, note || `[${id}] 语音`),
      ask: (opts) => core.ask(typeof opts === 'string' ? { text: opts } : opts),
      think: (prompt, opts = {}) => core.hub.runSystemTurn(`ext-${id}`, opts.title || def.name || id, String(prompt), opts),
      onebot: (action, params, opts) => core.onebot.call(action, params, opts),
      dshTool: (tool) => { rec.dshTools.push(tool); core.bridge?.refresh(); return () => { remove(rec.dshTools, tool); core.bridge?.refresh() } },
    }
    return api
  }

  function remove(list, item) {
    const i = list.indexOf(item)
    if (i >= 0) list.splice(i, 1)
  }

  function note(id, label, error) {
    const message = String(error && error.message ? error.message : error).slice(0, 500)
    const rec = live.get(id)
    if (rec) {
      rec.errors.unshift({ at: Date.now(), label, message })
      rec.errors.length = Math.min(rec.errors.length, 8)
    }
    log.warn(`模块「${id}」${label}出错：`, message)
  }

  function exportsOf(id) {
    const rec = live.get(id)
    return rec ? rec.exports : null
  }

  // ---------- 启动 / 停止 ----------
  async function start(def, source, extra = {}) {
    const id = def.id
    const rec = { id, def, source, exports: null, offs: [], tools: [], contexts: [], rules: [], commands: [], dshTools: [], errors: [], startedAt: Date.now(), ...extra }
    // 设置里的密码字段不回传给面板
    for (const f of def.settings || []) if (f && f.type === 'password' && f.key) registerSecretField(['ext', id, f.key])
    // 设置的默认值补进配置（面板表单直接有值可改；已经填过的不动）
    if (def.defaults && typeof def.defaults === 'object') {
      const cur = getConfig().ext?.[id] || {}
      const missing = Object.keys(def.defaults).filter((k) => !(k in cur))
      if (missing.length) setConfig({ ...getConfig(), ext: { ...getConfig().ext, [id]: { ...Object.fromEntries(missing.map((k) => [k, def.defaults[k]])), ...cur } } })
    }
    live.set(id, rec)
    errors.delete(id)
    generation++ // 新实例：会话里的工具要在下一轮重挂（issue #73）
    try {
      const api = makeApi(id, source, rec)
      const r = def.setup(api)
      rec.exports = (r && typeof r.then === 'function' ? await r : r) ?? {}
      log.info(`模块「${def.name || id}」${source === 'user' ? '（自己写的）' : ''}已启动`)
      emit('module/start', id)
    } catch (error) {
      stop(id, { quiet: true })
      errors.set(id, { message: String(error && error.message ? error.message : error).slice(0, 800), at: Date.now(), source })
      log.warn(`模块「${def.name || id}」启动失败：`, error.message)
    }
    return live.get(id)
  }

  /** 同步启动（内置模块的 setup 都是同步的，插件一加载就要能用）。 */
  function startSync(def) {
    const id = def.id
    const rec = { id, def, source: 'builtin', exports: null, offs: [], tools: [], contexts: [], rules: [], commands: [], dshTools: [], errors: [], startedAt: Date.now() }
    live.set(id, rec)
    generation++ // 内置模块（重）启动也换代际：会话里的工具要在下一轮重挂
    if (errors.get(id)?.source !== 'user') errors.delete(id) // 替换版的报错留着给面板看
    try {
      const r = def.setup(makeApi(id, 'builtin', rec))
      if (r && typeof r.then === 'function') throw new Error('内置模块的 setup 要同步返回')
      rec.exports = r ?? {}
    } catch (error) {
      stop(id, { quiet: true })
      errors.set(id, { message: String(error.message || error).slice(0, 800), at: Date.now(), source: 'builtin' })
      log.error(`内置模块「${def.name || id}」启动失败：`, error.message)
    }
  }

  function stop(id, { quiet = false } = {}) {
    const rec = live.get(id)
    if (!rec) return false
    live.delete(id)
    generation++ // 模块被停掉/替换：工具清单或实例变了，下一轮重挂
    for (const off of rec.offs.reverse()) { try { off() } catch (error) {} }
    try { rec.exports?.dispose?.() } catch (error) {}
    for (const [path, r] of routes) if (r.id === id) routes.delete(path)
    for (const [ev, list] of listeners) listeners.set(ev, list.filter((x) => x.id !== id))
    if (rec.dshTools.length) core.bridge?.refresh()
    if (!quiet) { log.info(`模块「${rec.def.name || id}」已停下`); emit('module/stop', id) }
    return true
  }

  /** 加载一个自己写的模块（按修改时间重新 import，改了就是新的）。 */
  /**
   * 加载自己写的模块：先把整个文件夹拍一份快照（modules/<id>/.aurabot-cache/<版本戳>/）再加载快照。
   * Node 会缓存加载过的文件，快照路径每次不同，所以改了模块里任何一个文件都会重新加载；
   * 快照在模块文件夹里面，模块自己 npm install 的依赖（modules/<id>/node_modules）照样找得到。
   */
  async function importUser(u) {
    const stamp = stampOf(u.dir)
    const root = join(u.dir, SNAP)
    const snap = join(root, String(stamp).replace('.', '-'))
    if (!existsSync(snap)) {
      for (const f of filesOf(u.dir)) {
        mkdirSync(dirname(join(snap, f)), { recursive: true })
        copyFileSync(join(u.dir, f), join(snap, f))
      }
    }
    // 旧快照删掉（加载过的代码已经在内存里，删文件不影响）
    try { for (const n of readdirSync(root)) if (join(root, n) !== snap) rmSync(join(root, n), { recursive: true, force: true }) } catch (error) {}
    const mod = await import(pathToFileURL(join(snap, relative(u.dir, u.file))).href)
    return { def: mod.default, stamp }
  }

  async function startUser(u) {
    let def
    let stamp = 0
    try {
      ({ def, stamp } = await importUser(u))
      const why = checkDef(def, u.id)
      if (why) throw new Error(why)
    } catch (error) {
      errors.set(u.id, { message: String(error.message || error).slice(0, 800), at: Date.now(), source: 'user', fallback: builtinDefs.has(u.id) })
      log.warn(`模块「${u.id}」加载失败：`, error.message)
      userSeen.set(u.id, { ...u, stamp: stampOf(u.dir) })
      return null
    }
    userSeen.set(u.id, { ...u, stamp })
    // 替换内置模块：记下替换时内置模块的版本，以后内置的更新了提醒一声
    const b = builtinDefs.get(u.id)
    const extra = { dir: u.dir }
    if (b) {
      extra.replaces = b.version
      const m = modCfg(u.id)
      if (!m.forkedFrom) setConfig({ ...getConfig(), modules: { ...getConfig().modules, [u.id]: { ...m, forkedFrom: b.version || version } } })
    }
    return start(def, 'user', extra)
  }

  /** 这个 id 现在该跑哪个版本：'user' | 'builtin' | null（关着）。 */
  function wanted(id, users) {
    if (!isEnabled(id)) return null
    const hasUser = isUserOn() && users.some((u) => u.id === id)
    if (hasUser && !(builtinDefs.has(id) && modCfg(id).useBuiltin)) return 'user'
    return builtinDefs.has(id) ? 'builtin' : null
  }

  /** 插件加载时：内置模块同步启动（被替换 / 关掉的跳过），自己写的随后异步加载。 */
  function boot() {
    const users = isUserOn() ? scanUser() : []
    for (const def of builtins) if (wanted(def.id, users) === 'builtin') startSync(def)
    return (async () => {
      await loadLib()
      globalThis.aurabot = { lib, src: pathToFileURL(SRC).href, version, apiVersion: API_VERSION, modules: publicHandle }
      installDocs()
      await sync()
      watching = setInterval(() => { sync().catch((error) => log.warn('检查模块变化出错：', error.message)) }, 3000)
      watching.unref?.()
    })().catch((error) => log.error('加载自己写的模块出错：', error.message))
  }

  /** 按配置和文件夹的现状，把该开的开、该关的关、改过的重新加载。 */
  let syncing = null
  function sync() {
    if (syncing) return syncing
    syncing = (async () => {
      const users = isUserOn() ? scanUser() : []
      const ids = new Set([...builtinDefs.keys(), ...users.map((u) => u.id), ...live.keys()])
      for (const id of ids) {
        const want = wanted(id, users)
        const rec = live.get(id)
        const u = users.find((x) => x.id === id)
        if (!want) { if (rec) stop(id); continue }
        if (want === 'builtin') {
          if (rec && rec.source === 'builtin') continue
          if (rec) stop(id)
          if (errors.get(id)?.source === 'builtin' && !rec) continue // 内置的启动失败过，别每 3 秒重试
          startSync(builtinDefs.get(id))
          continue
        }
        // 自己写的：没跑、换了文件、改过 → (重新)加载
        const seen = userSeen.get(id)
        const changed = !seen || seen.file !== u.file || seen.stamp !== stampOf(u.dir)
        if (rec && rec.source === 'user' && !changed) continue
        if (!changed && (!rec || rec.fallback)) continue // 上次加载失败、文件也没改：等改了再试
        if (rec) stop(id, { quiet: true })
        if (seen && changed) log.info(`模块「${id}」文件改了，重新加载`)
        const ok = await startUser(u)
        // 替换版加载失败：先用回内置的，免得这项功能直接没了
        if (!ok && builtinDefs.has(id)) {
          startSync(builtinDefs.get(id))
          const back = live.get(id)
          if (back) { back.fallback = true; log.warn(`模块「${id}」：你的版本没加载成功，先用内置的`) }
        }
      }
      for (const id of [...userSeen.keys()]) if (!users.some((u) => u.id === id)) { userSeen.delete(id); if (errors.get(id)?.source === 'user') errors.delete(id) }
    })().finally(() => { syncing = null })
    return syncing
  }

  /** 强制重新加载一个模块（面板「重新加载」）。 */
  async function reload(id) {
    if (live.has(id)) stop(id, { quiet: true })
    errors.delete(id)
    userSeen.delete(id)
    await sync()
    return status().find((m) => m.id === id) || null
  }

  function dispose() {
    clearInterval(watching)
    for (const id of [...live.keys()].reverse()) stop(id, { quiet: true })
  }

  // ---------- 事件 ----------
  function emit(event, ...args) {
    for (const { fn } of listeners.get(event) || []) {
      try { const r = fn(...args); if (r && typeof r.catch === 'function') r.catch(() => {}) } catch (error) {}
    }
  }
  /** 依次问每个模块，第一个返回真值的接管（收到消息时用）。 */
  async function claim(event, ...args) {
    for (const { fn } of listeners.get(event) || []) {
      try { if (await fn(...args)) return true } catch (error) {}
    }
    return false
  }
  /** 依次让每个模块改写一个值（发回复前用）：返回 undefined 不改，null 拦下。 */
  async function filter(event, value, ...args) {
    let v = value
    for (const { fn } of listeners.get(event) || []) {
      try {
        const r = await fn(v, ...args)
        if (r === null) return null
        if (r !== undefined) v = r
      } catch (error) {}
    }
    return v
  }
  /** 同步版（人格、规则、模型选择这些地方不能等）：监听函数返回 Promise 的不算。 */
  function filterSync(event, value, ...args) {
    let v = value
    for (const { fn } of listeners.get(event) || []) {
      try {
        const r = fn(v, ...args)
        if (r && typeof r.then === 'function') continue
        if (r === null) return null
        if (r !== undefined) v = r
      } catch (error) {}
    }
    return v
  }

  // ---------- 汇总给插件其他部分用 ----------
  function buildTools(where) {
    const out = []
    const names = new Set()
    for (const rec of live.values()) {
      for (const b of rec.tools) {
        let r
        try { r = typeof b === 'function' ? b(where) : b } catch (error) { note(rec.id, '生成工具', error); continue }
        for (const t of [].concat(r || [])) {
          if (!t || !t.name) continue
          if (names.has(t.name)) { log.debug(`工具 ${t.name} 重名，模块「${rec.id}」的没挂`); continue }
          names.add(t.name)
          out.push(t)
        }
      }
    }
    return out
  }
  function contextFor(args) {
    const parts = []
    for (const rec of live.values()) {
      for (const fn of rec.contexts) {
        try { const t = fn(args); if (t) parts.push(String(t)) } catch (error) {}
      }
    }
    return parts.join('\n\n')
  }
  function rules(kind) {
    const out = []
    for (const rec of live.values()) {
      for (const fn of rec.rules) {
        try { const t = typeof fn === 'function' ? fn(kind, getConfig()) : fn; for (const line of [].concat(t || [])) if (line) out.push(String(line)) } catch (error) {}
      }
    }
    return out
  }
  const commands = () => [...live.values()].flatMap((r) => r.commands)
  const dshTools = () => [...live.values()].flatMap((r) => r.dshTools.map((t) => ({ ...t, module: r.id })))
  /** 内置模块里没在跑的（关掉的、被替换的）。 */
  const builtinOff = () => new Set([...builtinDefs.keys()].filter((id) => live.get(id)?.source !== 'builtin'))

  async function handle(path, req, res) {
    const r = routes.get(path)
    if (!r || !live.has(r.id)) return { ok: false, message: '这个功能所在的模块没开（面板「扩展」里看看）', moduleOff: true }
    return r.handler(req, res)
  }

  // ---------- 面板 ----------
  function status() {
    const users = isUserOn() ? scanUser() : scanUser().map((u) => ({ ...u, safe: true }))
    // 文件夹刚删掉、还没来得及停的模块也列出来（下一轮检查就停）
    const ids = [...builtinDefs.keys(), ...[...new Set([...users.map((u) => u.id), ...live.keys()])].filter((id) => !builtinDefs.has(id)).sort()]
    return ids.map((id) => {
      const b = builtinDefs.get(id)
      const u = users.find((x) => x.id === id)
      const rec = live.get(id)
      const def = rec?.def || b || {}
      const m = modCfg(id)
      const err = errors.get(id)
      return {
        id,
        name: def.name || id,
        description: def.description || '',
        version: def.version || '',
        builtin: Boolean(b),
        builtinVersion: b?.version || '',
        hasUser: Boolean(u),
        userDir: u?.dir || '',
        safeSkipped: Boolean(u?.safe),
        running: rec ? rec.source : null, // 'builtin' | 'user' | null
        fallback: Boolean(rec?.fallback),
        enabled: m.enabled !== false,
        useBuiltin: Boolean(m.useBuiltin),
        forkedFrom: m.forkedFrom || '',
        outdated: Boolean(b && rec?.source === 'user' && m.forkedFrom && m.forkedFrom !== b.version),
        error: err ? err.message : '',
        errors: rec ? rec.errors : [],
        tools: rec ? toolNames(rec) : [],
        commands: rec ? rec.commands.map((c) => c.name) : [],
        routes: [...routes].filter(([, r]) => r.id === id).map(([p]) => p.replace('/aurabot/api', '')),
        settings: rec?.source === 'user' || (!rec && u) ? (def.settings || []) : [],
        defaults: def.defaults || {},
        panel: Boolean(rec?.source === 'user' && def.panel),
        tab: def.tab || '',
        keepPanel: Boolean(def.keepPanel),
        startedAt: rec?.startedAt || 0,
      }
    })
  }
  function toolNames(rec) {
    const names = []
    for (const b of rec.tools) {
      try {
        const r = typeof b === 'function' ? b({ chat: { chatId: 'private:0', kind: 'private', userId: '0' }, level: 'full', sessionId: '' }) : b
        for (const t of [].concat(r || [])) if (t?.name) names.push(t.name)
      } catch (error) {}
    }
    return names
  }

  /** 自己写的模块的面板代码（panel.js），面板拿去执行。 */
  function panelSource(id) {
    const rec = live.get(id)
    if (!rec || rec.source !== 'user' || !rec.def.panel) return null
    const u = userSeen.get(id)
    const file = typeof rec.def.panel === 'string' ? resolve(u.dir, rec.def.panel) : join(u.dir, 'panel.js')
    if (!file.startsWith(u.dir) || !existsSync(file)) return null
    return readFileSync(file, 'utf8')
  }

  /** 新建一个自己写的模块（从模板）。 */
  function create(id, name) {
    if (!ID_RE.test(id)) return { ok: false, message: 'id 要小写字母开头，只能有小写字母、数字和 -，比如 weather' }
    const dir = join(userDir(), id)
    if (existsSync(dir)) return { ok: false, message: `modules/${id} 已经有了` }
    mkdirSync(dir, { recursive: true })
    const tpl = readFileSync(join(BUILTIN_DIR, '_template', 'index.mjs'), 'utf8')
    writeFileSync(join(dir, 'index.mjs'), tpl.replaceAll('__TOOL__', id.replace(/-/g, '_')).replaceAll('__ID__', id).replaceAll('__NAME__', String(name || id).replace(/['\\\n]/g, '')), 'utf8')
    installDocs()
    return { ok: true, dir, file: join(dir, 'index.mjs'), message: `建好了：${join(dir, 'index.mjs')}` }
  }

  /** 把内置模块复制一份到 modules/ 里，改了就替换内置的。files 里列的实现文件一起复制。 */
  function fork(id) {
    const b = builtinDefs.get(id)
    if (!b) return { ok: false, message: '没有这个内置模块' }
    const dir = join(userDir(), id)
    if (existsSync(dir)) return { ok: false, message: `modules/${id} 已经有了，先挪走它` }
    const own = new Map() // 源码 key → 复制后的文件名
    own.set(`modules/${id}/index.js`, 'index.mjs')
    for (const f of b.files || []) own.set(f, f.split('/').pop())
    mkdirSync(dir, { recursive: true })
    for (const [key, name] of own) {
      // 指向插件其他文件的改成走 lib()；一起复制过来的文件之间互相引用的，改成同目录
      let code = rewriteImports(readFileSync(join(SRC, ...key.split('/')), 'utf8'), key, new Set(own.keys()))
      for (const [k2, n2] of own) {
        const relFrom = relative(dirname(join(SRC, ...key.split('/'))), join(SRC, ...k2.split('/'))).split(sep).join('/')
        const spec = relFrom.startsWith('.') ? relFrom : './' + relFrom
        code = code.split(`'${spec}'`).join(`'./${n2}'`)
      }
      writeFileSync(join(dir, name), `// 从 Aurabot v${version} 的内置模块「${b.name}」复制出来的，改了就替换内置的。\n// 原文件：src/${key}\n` + code, 'utf8')
    }
    setConfig({ ...getConfig(), modules: { ...getConfig().modules, [id]: { ...modCfg(id), useBuiltin: false, forkedFrom: b.version || version } } })
    installDocs()
    return { ok: true, dir, message: `复制好了：${dir}。改完保存，几秒内就会换成你的版本` }
  }

  /** 接口说明和类型提示放进 modules/（插件的东西，每次启动都覆盖成当前版本）。 */
  function installDocs() {
    try {
      mkdirSync(userDir(), { recursive: true })
      const doc = readFileSync(join(BUILTIN_DIR, DOC), 'utf8').replaceAll('{{VERSION}}', version).replaceAll('{{API}}', String(API_VERSION)).replace('{{LIB}}', libKeys().map((k) => '- `' + k + '`').join('\n'))
      const dest = join(userDir(), DOC)
      if (!existsSync(dest) || readFileSync(dest, 'utf8') !== doc) writeFileSync(dest, doc, 'utf8')
      // 类型提示：模块开头写 /** @type {import('../aurabot').AurabotModule} */，编辑器就有补全
      const types = readFileSync(join(BUILTIN_DIR, TYPES), 'utf8')
      const tdest = join(userDir(), TYPES)
      if (!existsSync(tdest) || readFileSync(tdest, 'utf8') !== types) writeFileSync(tdest, types, 'utf8')
    } catch (error) {}
  }

  function promptFor(id) {
    const dir = id ? join(userDir(), id) : userDir()
    return `帮我修改 Aurabot（大肥鱼 QQ 插件）的扩展模块：${dir}\n`
      + `先完整读一遍「${join(userDir(), DOC)}」了解模块怎么写、能用哪些接口，再按我的要求改：\n`
      + '【这里写你想让她多会什么、改成什么样】\n'
      + `只改 ${userDir()} 里的文件，不要动插件本身的代码；改完保存会自动重新加载，到面板「扩展」页看有没有报错，再告诉我怎么试。`
  }

  const publicHandle = { use: exportsOf, has: (id) => live.has(id), list: () => status().map(({ id, name, running }) => ({ id, name, running })), emit }

  return {
    boot, sync, reload, stop, dispose, status, create, fork, promptFor, panelSource,
    use: exportsOf, has: (id) => live.has(id), running: (id) => live.get(id)?.source || null, generation: () => generation,
    emit, claim, filter, filterSync, buildTools,
    // 插件核心自己听事件（不属于任何模块，不会被撤掉）
    listen: (event, fn) => { const item = { id: '@core', fn }; listeners.set(event, [...(listeners.get(event) || []), item]); return () => listeners.set(event, (listeners.get(event) || []).filter((x) => x !== item)) }, contextFor, rules, commands, dshTools, builtinOff, handle,
    hasRoute: (path) => routes.has(path),
    dir: userDir,
  }
}

/**
 * 一个「用的时候才去找」的模块代理：memory.add(...) 每次都调当时在跑的那个 memory 模块；
 * 模块没在跑时，属性都是 undefined（所以调用方写 memory.add?.(...) 就不会出错）。
 */
export function lazyProxy(get) {
  return new Proxy({}, {
    get(_, k) {
      const t = get()
      if (!t) return undefined
      const v = t[k]
      return typeof v === 'function' ? v.bind(t) : v
    },
    has: (_, k) => Boolean(get() && k in get()),
  })
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)
function deepMerge(base, over) {
  if (!isObj(over)) return over === undefined ? base : over
  const out = { ...(isObj(base) ? base : {}) }
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v
  return out
}
