/**
 * client.js 结构与语法检查（不启动 DSH、不开浏览器）。
 *
 * ① vm.Script 真解析（等价 node --check）
 * ② 假 window 截下模块工厂；假 react 带一个最小 hook 运行时
 * ③ 断言 exports.apply 是函数、exports.inject 仍是 ["slots"]
 * ④ 用假 fetch 喂两台服务器，把 Panel **真渲染到稳定**（含 setState 重渲染），
 *    再递归展开所有函数组件，统计按钮/输入，打印按钮文案 —— 证明每个按钮都挂上了
 *
 * 用法：node _check-client.mjs
 */
import { readFileSync } from 'node:fs'
import { Script, createContext, runInContext } from 'node:vm'

const src = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
const problems = []
const realSetTimeout = setTimeout

/* ① 语法 */
try {
  new Script(src, { filename: 'client.js' })
  console.log('① 语法解析 ok（vm.Script，等价 node --check）')
} catch (e) {
  console.error('✗ 语法错误：' + (e?.stack || e))
  process.exit(1)
}

/* ② 最小 hook 运行时 —— 只实现 useState/useEffect 够 Panel 跑起来 */
let hookStates = []
let hookSlots = []
let hookIdx = 0
let dirty = false
let queuedEffects = []

const fakeReact = {
  createElement(type, props, ...children) {
    if (type === undefined) throw new Error('createElement 收到了 undefined 的 type')
    return { type, props: { ...(props || {}), children } }
  },
  useState(initial) {
    const i = hookIdx++
    if (!(i in hookStates)) hookStates[i] = typeof initial === 'function' ? initial() : initial
    const set = (v) => {
      const next = typeof v === 'function' ? v(hookStates[i]) : v
      if (next !== hookStates[i]) {
        hookStates[i] = next
        dirty = true
      }
    }
    return [hookStates[i], set]
  },
  useEffect(fn, deps) {
    const i = hookIdx++
    const prev = hookSlots[i]
    const changed = !prev || !prev.deps || !deps || deps.some((d, j) => d !== prev.deps[j])
    if (changed) {
      hookSlots[i] = { deps }
      queuedEffects.push(fn)
    }
  },
}

const SERVER_A = {
  serverName: 'windows', transport: 'stdio', enabled: true, status: 'ready',
  toolCount: 21, tools: [], error: null, command: 'uv.exe', args: ['tool', 'run'],
}
const SERVER_B = {
  serverName: 'fakehttp', transport: 'streamable-http', enabled: true, status: 'idle',
  toolCount: 0, tools: [], error: null, url: 'http://127.0.0.1:9/mcp',
}
const TOOLS = [
  { name: 'mcp__windows__Snapshot', toolName: 'Snapshot', serverName: 'windows', transport: 'stdio', description: '截屏' },
  { name: 'mcp__fakehttp__echo', toolName: 'echo', serverName: 'fakehttp', transport: 'streamable-http', description: '回显' },
]

function fakeFetch(url) {
  let body
  if (String(url).indexOf('/tools') >= 0) body = { ok: true, tools: TOOLS, count: TOOLS.length }
  else body = { ok: true, file: 'D:\\tmp\\servers.json', servers: [SERVER_A, SERVER_B], stats: { servers: 2, connected: 1, tools: 21 } }
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
}

let captured = null
const styleTags = []
const sandbox = {
  window: { __ModuleLoader__: { load: (opts) => { captured = opts } } },
  document: {
    createElement: () => ({ textContent: '', style: {} }),
    head: { appendChild: (el) => styleTags.push(el) },
  },
  fetch: fakeFetch,
  setInterval: () => 0,
  setTimeout: (fn) => { queuedEffects.push(fn); return 0 },
  clearInterval: () => {},
  clearTimeout: () => {},
  console,
  Object, Symbol, Error, String, Array, Boolean,
}
runInContext(src, createContext(sandbox))
if (!captured || typeof captured.factory !== 'function') {
  console.error('✗ client.js 没有调用 window.__ModuleLoader__.load({ factory })')
  process.exit(1)
}
const mod = captured.factory((id) => {
  if (id === 'react') return fakeReact
  throw new Error('未预期的模块：' + id)
})
console.log(`② 模块工厂 ok：id=${captured.id} 导出=${Object.keys(mod).sort().join(',')}`)

/* ③ 契约 */
if (typeof mod.apply !== 'function') problems.push('exports.apply 不是函数')
if (!Array.isArray(mod.inject) || mod.inject.length !== 1 || mod.inject[0] !== 'slots') {
  problems.push(`exports.inject 必须仍是 ["slots"]，实际 ${JSON.stringify(mod.inject)}`)
}
if (styleTags.length !== 1) problems.push(`样式标签应注入 1 个，实际 ${styleTags.length}`)
console.log(`③ exports.inject = ${JSON.stringify(mod.inject)}；样式标签 ${styleTags.length} 个`)

/* ④ 真渲染 */
let slot = null
mod.apply({
  slots: {
    inject(name, fn) {
      if (name !== 'sidebar.panellist') problems.push(`slots.inject 用错了槽：${name}`)
      fn()
    },
    register(cfg, Comp) {
      slot = { cfg, Comp }
      return () => {}
    },
  },
})
if (!slot) {
  console.error('✗ 没有注册到 sidebar.panellist')
  process.exit(1)
}
console.log(`④ slot 注册 ok：${JSON.stringify(slot.cfg)}`)

const flush = () => new Promise((r) => realSetTimeout(r, 0))

const PanelEl = slot.Comp()          // 插槽里那个返回 <Panel/> 的组件
const Panel = PanelEl.type

/** 渲染到"没有新的 setState"为止（最多 6 轮）。 */
async function settle() {
  let tree = null
  for (let round = 0; round < 6; round++) {
    hookIdx = 0
    queuedEffects = []
    dirty = false
    tree = Panel()
    const fx = queuedEffects
    queuedEffects = []
    for (const fn of fx) fn()
    // effect 里 setTimeout(防抖) 的回调也在这里跑掉（生产里由浏览器定时器触发）
    while (queuedEffects.length) queuedEffects.shift()()
    await flush()
    await flush()
    if (!dirty) break
  }
  return tree
}

/** 在元素树里找第一个满足条件的 button，返回它的 props。 */
function findButton(node, test) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const n of node) { const hit = findButton(n, test); if (hit) return hit }
    return null
  }
  if (typeof node.type === 'function') return findButton(node.type(node.props || {}), test)
  if (node.type === 'button') {
    const label = (node.props.children || []).filter((c) => typeof c === 'string').join('')
    if (test(label)) return node.props
  }
  for (const c of node.props.children || []) {
    const hit = findButton(c, test)
    if (hit) return hit
  }
  return null
}

let tree = await settle()

// 点一下「+ 添加服务器」，让表单真展开（同时验证这个按钮的 onClick 是活的）
const addBtn = findButton(tree, (label) => label.indexOf('添加服务器') >= 0)
if (!addBtn || typeof addBtn.onClick !== 'function') {
  problems.push('找不到「+ 添加服务器」按钮或它没有 onClick')
} else {
  addBtn.onClick()
  tree = await settle()
}

const counts = { elements: 0, components: 0, buttons: 0, inputs: 0, selects: 0, textareas: 0 }
const buttonLabels = []
const textBits = []
const seenTypes = new Set()

function walk(node) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach(walk); return }
  if (!node.type) { problems.push('元素缺少 type：' + JSON.stringify(node)); return }
  if (typeof node.type !== 'string' && typeof node.type !== 'function') {
    problems.push('type 既不是标签名也不是组件：' + String(node.type)); return
  }
  counts.elements++
  if (typeof node.type === 'function') {
    counts.components++
    seenTypes.add(node.type.name || '(匿名组件)')
    walk(node.type(node.props || {}))       // 展开函数组件（它们都不用 hook）
    return
  }
  if (node.type === 'button') {
    counts.buttons++
    buttonLabels.push((node.props.children || []).filter((c) => typeof c === 'string').join(''))
  }
  if (node.type === 'input') counts.inputs++
  if (node.type === 'textarea') counts.textareas++
  if (node.type === 'select') counts.selects++
  for (const c of node.props.children || []) if (typeof c === 'string' && c.trim()) textBits.push(c.trim())
  ;(node.props.children || []).forEach(walk)
}

walk(tree)
const allText = textBits.join(' | ')
console.log(`⑤ 渲染稳定后：${counts.elements} 个元素（含 ${counts.components} 个组件调用）/ ${counts.buttons} 个按钮 / ${counts.inputs + counts.textareas} 个输入 / ${counts.selects} 个下拉`)
console.log(`   组件：${[...seenTypes].join(', ')}`)
console.log(`   按钮：${buttonLabels.join(' | ')}`)
console.log(`   文案：${[...new Set(textBits)].slice(0, 16).join(' / ')}`)

for (const need of ['连接', '断开', '停用', '删除', '保存并连接', '取消']) {
  if (!buttonLabels.some((l) => l.indexOf(need) >= 0)) problems.push(`缺少按钮：${need}`)
}
if (!addBtn) problems.push('缺少按钮：+ 添加服务器（展开表单前）')
if (counts.buttons < 8) problems.push(`按钮只有 ${counts.buttons} 个（两台服务器 6 个行内 + 保存 + 取消）`)
if (counts.inputs < 3) problems.push(`输入框只有 ${counts.inputs} 个（搜索 + serverName + command/url）`)
if (counts.textareas < 2) problems.push(`textarea 只有 ${counts.textareas} 个（args + env/headers）`)
if (counts.selects < 1) problems.push('没有 transport 下拉')
for (const need of ['MCP Hub', '服务器', '工具搜索', '添加服务器', 'serverName', 'transport', 'command']) {
  if (allText.indexOf(need) < 0) problems.push(`界面缺少区块/字段：${need}`)
}
if (allText.indexOf('2 srv / 21 tools') < 0) problems.push('顶栏统计没渲染出来（假数据 2 srv / 21 tools）')
if (allText.indexOf('mcp__windows__Snapshot') < 0) problems.push('工具搜索结果没渲染出来')
if (allText.indexOf('已连') < 0) problems.push('状态文案没渲染')

console.log('')
if (!problems.length) {
  console.log('✓ client.js 语法 + 结构检查全部通过（语法、契约、组件树、按钮挂载）')
  process.exit(0)
}
console.log(`✗ ${problems.length} 个问题：`)
for (const p of problems) console.log('  · ' + p)
process.exit(1)
