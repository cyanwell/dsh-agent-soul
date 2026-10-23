// selftest.mjs —— 这个插件自己的自测。
//
// 为什么需要它：宿主半和浏览器半**都只在 DSH 启动时加载**，所以「装完还没重启」的那段
// 时间里，两条最容易错的路径完全没被走过：
//   A. HTTP 路由 /model-statusbar/api/*（宿主半）—— 靠 mock ctx 拿到 handler，
//      再真起一个 http 服务、真发请求打它。这基本上就是重启后浏览器会走的那条路。
//   B. 浏览器半能不能加载、exports.inject 有没有、组件渲染出什么 —— 靠 vm 造一个假的
//      window.__ModuleLoader__，喂 react，再渲染一次把文字抽出来。
//
// ★ B 段用哪个 react 会在输出里写明（真 react / 自建 stub）——
//   pnpm 的严格布局下 react 不一定能从 profile 根解析出来，那个失败**不是插件的问题**，
//   所以这里换 anchor 找；实在找不到就用一个只实现 useState/useEffect/createElement 的
//   stub，照样能把「组件渲染出哪些字」验掉。绝不因为环境找不到 react 就跳过这一段。
//
// 用法：
//   node .\selftest.mjs
// 退出码 0 = 全通；非 0 = 有断言没过。

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))

let fails = 0
function ok(name, cond, extra) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (extra !== undefined && extra !== '' ? '  → ' + extra : ''))
  if (!cond) fails++
}

// ── A. 宿主半：真起 HTTP 服务，真发请求 ────────────────────────
console.log('\n=== A. 宿主半 HTTP 路由（真起服务、真发请求）===')
const host = await import(pathToFileURL(join(HERE, 'index.js')).href)
let routeDef = null
const tools = []
host.apply({
  webServer: { register: (d) => { routeDef = d; return () => {} } },
  tools: { register: (d) => { tools.push(d) } },
  effect: () => {},
})
ok('apply() 注册了路由', !!routeDef, routeDef && routeDef.kind + ' ' + routeDef.path)
ok('apply() 注册了 1 个工具', tools.length === 1, tools.map((t) => t.name).join(', '))

const srv = createServer((rq, rs) => {
  Promise.resolve(routeDef.handler(rq, rs)).catch((e) => {
    try { rs.writeHead(500); rs.end(String(e && e.message)) } catch { /* ignore */ }
  })
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${srv.address().port}/model-statusbar`

async function getJSON(path, init) {
  const r = await fetch(base + path, init)
  const t = await r.text()
  let j = null
  try { j = JSON.parse(t) } catch { /* 留着原文 */ }
  return { status: r.status, json: j, text: t }
}

const st = await getJSON('/api/state')
ok('GET /api/state 返回 200', st.status === 200, 'status=' + st.status)
ok('  · 有 phase 字段', !!st.json && typeof st.json.phase === 'string', st.json && st.json.phase)
ok('  · 有 comfyui.apiUp', !!st.json && st.json.comfyui && typeof st.json.comfyui.apiUp === 'boolean')
ok('  · checkpoints 是数组', !!st.json && Array.isArray(st.json.checkpoints), st.json && st.json.checkpoints.length + ' 个')
ok('  · bundles 是数组', !!st.json && Array.isArray(st.json.bundles), st.json && st.json.bundles.length + ' 个')
ok('  · ports 是数组', !!st.json && Array.isArray(st.json.ports), st.json && st.json.ports.length + ' 个')
ok('  · autoIdle 是对象，带 enabled / thresholdMinutes',
  !!st.json && !!st.json.autoIdle && typeof st.json.autoIdle === 'object' &&
  typeof st.json.autoIdle.enabled === 'boolean' && typeof st.json.autoIdle.thresholdMinutes === 'number',
  st.json && st.json.autoIdle && (st.json.autoIdle.enabled + ' / ' + st.json.autoIdle.thresholdMinutes + ' 分钟'))

const act = await getJSON('/api/action', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'status' }),
})
ok('POST /api/action {status} 返回 200', act.status === 200, 'status=' + act.status)
ok('  · ok=true', !!act.json && act.json.ok === true)
ok('  · 带 gpu（object，不是 null）', !!act.json && act.json.gpu && typeof act.json.gpu === 'object',
  act.json && act.json.gpu && act.json.gpu.name)

const bad = await getJSON('/api/action', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'nonsense' }),
})
ok('未知 action 返回 400', bad.status === 400, bad.status + ' ' + (bad.json && bad.json.message))

const nf = await getJSON('/api/nope')
ok('未知路由返回 404', nf.status === 404, nf.status)

// 工具 execute 也真调一次（走的是和 DSH 调用同样的入口）
const toolOut = await tools[0].execute({ action: 'status' }, { signal: new AbortController().signal })
ok('tool.execute({status}) 返回对象', !!toolOut && typeof toolOut === 'object', toolOut && toolOut.phase)
ok('  · tool 也带 bundles', !!toolOut && Array.isArray(toolOut.bundles), toolOut && toolOut.bundles && toolOut.bundles.length + ' 个')
ok('  · tool 也带 autoIdle（enabled + lastSkip）',
  !!toolOut && !!toolOut.autoIdle && typeof toolOut.autoIdle.enabled === 'boolean',
  toolOut && toolOut.autoIdle && toolOut.autoIdle.lastSkip)
const blocks = tools[0].output.render({}, toolOut)
ok('output.render 返回 ContentBlock[]', Array.isArray(blocks) && blocks[0] && blocks[0].type === 'text')

srv.close()

// ── B. 浏览器半：vm 加载 + 渲染 ───────────────────────────────
console.log('\n=== B. 浏览器半（vm 造 __ModuleLoader__ + 渲染）===')

// pnpm 的严格布局下，从 profile 根 require('react') 会 MODULE_NOT_FOUND。
// 换几个 anchor 找真 react；找不到就用自建 stub，不跳过这一段。
const ANCHORS = [
  '<你的工作区>/dsh/home/profiles/web/package.json',
  '<你的工作区>/dsh/home/profiles/web/node_modules/@linxin666/dsh-web-all/package.json',
  '<你的工作区>/dsh/node_modules/@deepseek-ai/dsh/package.json',
  '<你的工作区>/dsh/package.json',
]
let react = null
let rds = null
let reactFrom = ''
for (const a of ANCHORS) {
  try {
    const r = createRequire(a)
    const t = r('react')
    if (!t) continue
    react = t
    reactFrom = '真 react @ ' + a
    try { rds = r('react-dom/server') } catch { rds = null }
    break
  } catch { /* 换下一个 anchor */ }
}

// 自建 stub：只实现这个组件用到的三个 hook + createElement。
// 不是「假渲染」—— 它真的调用组件函数、真的走 useState 的初始值，只是没有真 React 的调度。
let stub = null
let preset = {}
if (!react) {
  let slots = []
  let cursor = 0
  react = {
    createElement(type, props, ...kids) {
      const children = kids.length === 0 ? undefined : (kids.length === 1 ? kids[0] : kids)
      const p = Object.assign({}, props || {})
      if (children !== undefined) p.children = children
      return { __stub: true, type, props: p }
    },
    useState(init) {
      const i = cursor++
      if (!(i in slots)) slots[i] = (i in preset) ? preset[i] : (typeof init === 'function' ? init() : init)
      return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v }]
    },
    useEffect() { cursor++ },
    useRef(init) { const i = cursor++; if (!(i in slots)) slots[i] = { current: init }; return slots[i] },
  }
  stub = {
    // preset：按 useState 的出现顺序预置初值，用来把组件渲染成「展开态」。
    // ★ 组件里的顺序是 0=data 1=error 2=working 3=opened 4=listOpen 5=msg 6=bundleOpen
    //   —— 改了要同步改这里。新 state 只能加在【末尾】：下面的 preset 是按索引给的，
    //   中间插一个会把后面全部错位。
    reset(p) { preset = p || {}; slots = []; cursor = 0 },
    text(node, out) {
      if (node === null || node === undefined || node === false || node === true) return
      if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return }
      if (Array.isArray(node)) { for (const c of node) this.text(c, out); return }
      if (typeof node.type === 'function') {
        const save = cursor
        cursor = 0
        this.text(node.type(node.props || {}), out)
        cursor = save
        return
      }
      this.text(node.props && node.props.children, out)
    },
  }
  reactFrom = '(自建 stub —— 环境里没解析到真 react，这不是插件的问题)'
}
console.log('  · react 来源：' + reactFrom + (rds ? '（有 react-dom/server）' : '（无 react-dom/server）'))

const src = readFileSync(join(HERE, 'client.js'), 'utf8')
let captured = null
const sandbox = { window: { __ModuleLoader__: { load: (d) => { captured = d } } }, console }
vm.createContext(sandbox)
vm.runInContext(src, sandbox, { filename: 'client.js' })
ok('window.__ModuleLoader__.load 被调用', !!captured, captured && captured.id)
ok('id 正确', !!captured && captured.id === 'dsh-agent-model-statusbar')

const unexpected = []
const mod = captured.factory((id) => {
  if (id === 'react') return react
  unexpected.push(id)
  throw new Error('unexpected require: ' + id)
})
ok('factory 只 require 了 react', unexpected.length === 0, unexpected.join(', '))
ok('exports.apply 是函数', typeof mod.apply === 'function')
// ★ 少这一条整包静默失效：Host 报 client running，浏览器一行不跑，控制台无错
ok('exports.inject 是数组', Array.isArray(mod.inject), JSON.stringify(mod.inject))
ok('exports.inject 含 "slots"', Array.isArray(mod.inject) && mod.inject.includes('slots'))

let registered = null
mod.apply({
  slots: {
    inject: (key, cb) => { cb() },
    register: (meta, comp) => { registered = { meta, comp }; return () => {} },
  },
})
// ★ 槽位是 shell.overlay 而不是 sidebar.footer.action —— 9-28 实测那个 footer 槽位
//   只有 256×36 px 且已塞了一个 103×36 的按钮，信息卡放不下（理由见 client.js 头部）。
ok('注册到 shell.overlay', !!registered && registered.meta.name === 'shell.overlay',
  registered && JSON.stringify(registered.meta))

function render(p) {
  const el = react.createElement(registered.comp)
  if (rds) return rds.renderToStaticMarkup(el)
  stub.reset(p)
  const out = []
  stub.text(el, out)
  return out.join(' | ')
}

// ── 折叠态（默认）：只有一行胶囊 ──────────────────────────────
let folded = ''
let foldedErr = ''
try { folded = render(null) } catch (e) { foldedErr = String((e && e.message) || e) }
ok('折叠态渲染成功', folded.length > 0, folded.length ? folded.length + ' chars' : foldedErr)
ok('折叠态含「本地模型」', folded.includes('本地模型'))
ok('折叠态含展开提示「▴」', folded.includes('▴'))
if (folded) console.log('\n折叠态（默认）:\n' + folded)

// ── 展开态：靠预置第 4 个 useState（opened = true）拿到 ────────
if (stub) {
  let expanded = ''
  let expandedErr = ''
  try { expanded = render({ 3: true }) } catch (e) { expandedErr = String((e && e.message) || e) }
  ok('展开态渲染成功', expanded.length > 0, expanded.length ? expanded.length + ' chars' : expandedErr)
  for (const kw of ['本地模型', 'ComfyUI', '显存', '拉起', '静息', '关闭', '刷新']) {
    ok('展开态含「' + kw + '」', expanded.includes(kw))
  }
  if (expanded) console.log('\n展开态:\n' + expanded)

  // ── 两个清单都展开：验「底模 / 组合」确实是分两组，且组合的三件套渲染得出来 ──
  const fakeData = {
    ok: true, phase: 'running',
    gpu: { usedMiB: 1086, totalMiB: 8192, utilPct: 12 },
    comfyui: { apiUp: true },
    checkpoints: [{ name: 'z-image-anime-aio-fp8.safetensors', gb: 9.63 }],
    bundles: [{
      name: 'Qwen-Image 2.1 Turbo', gb: 10.41,
      parts: [
        { part: 'unet', name: 'qwen_image_2.1_turbo_Q4_K_M.gguf', gb: 3.9 },
        { part: 'text_encoders', name: 'qwen3vl_8b_w4a8.safetensors', gb: 5.88 },
        { part: 'vae', name: 'qwen_image_2.1_vae_bf16.safetensors', gb: 0.63 },
      ],
    }],
    autoIdle: { enabled: true, thresholdMinutes: 10 },
  }
  let lists = ''
  let listsErr = ''
  try { lists = render({ 0: fakeData, 3: true, 4: true, 6: true }) } catch (e) { listsErr = String((e && e.message) || e) }
  ok('清单态渲染成功', lists.length > 0, lists.length ? lists.length + ' chars' : listsErr)
  for (const kw of ['底模 1', '组合 1', 'Qwen-Image 2.1 Turbo', '10.41 GB',
                    'unet 3.90 + text_encoders 5.88 + vae 0.63']) {
    ok('清单态含「' + kw + '」', lists.includes(kw))
  }
  // ★「分两组」的证明：只展开「底模」时，组合模型的名字不该出现
  const ckOnly = render({ 0: fakeData, 3: true, 4: true, 6: false })
  ok('「底模」那一组里不含组合模型的名字', !ckOnly.includes('Qwen-Image 2.1 Turbo'))
  if (lists) console.log('\n清单态（底模 + 组合，两组）:\n' + lists)
} else {
  console.log('  · 展开态：拿到的是真 react，无法从外部设 state —— 这一态留到浏览器里验')
}

// ── 汇总 ─────────────────────────────────────────────────────
console.log('\n' + (fails === 0
  ? '✓✓ 全通 —— 宿主半路由 + 浏览器半渲染都实测走过，可以重启装载'
  : '✗ 有 ' + fails + ' 条没过'))
process.exit(fails === 0 ? 0 : 1)
