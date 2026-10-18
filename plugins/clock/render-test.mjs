/**
 * dsh-agent-clock 渲染桩测 —— 验证「装了的那一份」，不是源目录那一份。
 *
 * 技能文档要求：验证一律打装了的那一份（`node ... <node_modules 里的插件目录>`）。
 * 本插件没有注册 agent 工具，所以 `tool-exec-test.mjs` 不适用；
 * 这里做一个更对症的桩：给它一个假的 `window.__ModuleLoader__` + 假 react + 假 document，
 * 让已安装的 client.js **真跑一遍 apply()**，再把注册进去的组件**真渲染一棵树**出来看。
 *
 * 查的是这样几件事：
 *   ① client.js 语法能过（真 import，不是肉眼读）
 *   ② exports.inject 里有 'slots'  —— ★ 少了它整包静默失效，本 skill 最值钱的一条
 *   ③ exports.apply 是函数
 *   ④ apply 真的往 sidebar.footer.action 注册了东西（id/order/label 对不对）
 *   ⑤ 组件渲染出的树里：按钮 id、面板、时分秒格式、日期、星期、时区标签
 *   ⑥ 点开前**不该**有面板（初态是收起的）
 *   ⑦ index.js 能 import，name/inject 形状对
 */
import { pathToFileURL } from "node:url"
import { join } from "node:path"
import { existsSync } from "node:fs"

const DIR = process.argv[2]
if (!DIR) { console.error("usage: node render-test.mjs <plugin dir>"); process.exit(2) }
const CLIENT = join(DIR, "client.js")
const HOST = join(DIR, "index.js")

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail: detail === undefined ? "" : String(detail) })
}
const fail = (msg) => { console.error("FAIL " + msg); process.exit(1) }

if (!existsSync(CLIENT)) fail("client.js not found at " + CLIENT)
if (!existsSync(HOST)) fail("index.js not found at " + HOST)

/* ── 假的浏览器环境 ─────────────────────────────────────── */

let injectedCss = null
const el = (tag) => ({
  tagName: String(tag).toUpperCase(),
  id: "", textContent: "", className: "", style: {}, children: [],
  appendChild(c) { this.children.push(c); return c },
  setAttribute() {}, addEventListener() {}, removeEventListener() {},
  getBoundingClientRect() { return { left: 292, top: 700, right: 328, bottom: 736, width: 36, height: 36 } },
  closest() { return null },
})

globalThis.window = {
  __ModuleLoader__: { load(spec) { globalThis.__spec = spec } },
  innerWidth: 1440, innerHeight: 900,
  addEventListener() {}, removeEventListener() {},
}
globalThis.document = {
  getElementById(id) { globalThis.__getByIdCalls.push(id); return null },
  querySelector() { return null },
  createElement(tag) { globalThis.__created.push(String(tag)); return el(tag) },
  head: { appendChild(node) { globalThis.__appended.push(node && node.tagName); if (node && node.tagName === "STYLE") injectedCss = node.textContent } },
  addEventListener() {}, removeEventListener() {},
}
globalThis.__getByIdCalls = []
globalThis.__created = []
globalThis.__appended = []

/* ── 假 react：够跑出完整元素树 ───────────────────────────── */

const RENDERED = new Set(["div", "span", "button", "svg", "circle", "path"])
const reactStub = {
  createElement(type, props, ...children) {
    const kids = []
    const push = (c) => {
      if (c === null || c === undefined || c === false || c === true) return
      if (Array.isArray(c)) return c.forEach(push)
      kids.push(c)
    }
    children.forEach(push)
    return { __el: true, type, props: props || {}, children: kids }
  },
  useState(init) {
    const v = typeof init === "function" ? init() : init
    return [v, () => {}]
  },
  useEffect() {},
  useRef(v) { return { current: v } },
  Fragment: Symbol("Fragment"),
}

/* ── ① 真 import client.js，让它自己往 __ModuleLoader__ 注册 ── */

await import(pathToFileURL(CLIENT).href).catch((e) => fail("import client.js threw: " + e.message))

const spec = globalThis.__spec
check("client.js 语法/顶层可执行", !!spec, spec ? "id=" + spec.id : "没走到 __ModuleLoader__.load")
if (!spec) { report(); process.exit(1) }
check("模块 id 正确", spec.id === "dsh-agent-clock", spec.id)

const mod = spec.factory((name) => {
  if (name === "react") return reactStub
  throw new Error("unexpected require: " + name)
})

/* ── ②③ exports 契约 ─────────────────────────────────────── */

const inject = mod.inject
check("exports.inject 存在", Array.isArray(inject), JSON.stringify(inject))
check("★ exports.inject 含 'slots'（少了整包静默失效）", Array.isArray(inject) && inject.includes("slots"))
check("exports.apply 是函数", typeof mod.apply === "function", typeof mod.apply)
// ★ 样式断言的时机：`ensureStyle()` 是在 `apply(ctx)` 里调的，
//   原来这条写在 apply 之前 → 必然采不到（0 B）。这是检查时机的错，不是插件的错。
//   实测（probe-style.mjs，已安装副本）：getElementById → createElement(style) → head.appendChild(STYLE)
//   三跳都走，注入 1068 B。

/* ── ④ apply 真的往 sidebar.footer.action 注册 ───────────── */

const registrations = []
const ctx = {
  slots: {
    inject(name, cb) { registrations.push({ kind: "inject", name }); cb() },
    register(meta, Comp) { registrations.push({ kind: "register", meta, Comp }) },
  },
}

try { mod.apply(ctx) } catch (e) { fail("apply(ctx) threw: " + e.message) }

check("样式已注入 document.head", typeof injectedCss === "string" && injectedCss.includes(".dsh-agent-clock-panel"), (injectedCss || "").length + " B")
check("样式走的是 createElement(style) + appendChild", globalThis.__created.includes("style") && globalThis.__appended.includes("STYLE"), JSON.stringify(globalThis.__created) + " / " + JSON.stringify(globalThis.__appended))

const reg = registrations.find((r) => r.kind === "register")
check("apply 里调过 slots.inject", registrations.some((r) => r.kind === "inject"), JSON.stringify(registrations.filter((r) => r.kind === "inject").map((r) => r.name)))
check("注册进 sidebar.footer.action", reg && reg.meta.name === "sidebar.footer.action", reg ? reg.meta.name : "没有 register 调用")
if (reg) {
  check("注册 id = clock", reg.meta.id === "clock", reg.meta.id)
  check("注册 label 存在", typeof reg.meta.label === "string" && reg.meta.label.length > 0, reg.meta.label)
  check("order 是数字（与已有按钮的 order 并列不冲突）", typeof reg.meta.order === "number", reg.meta.order)
}

/* ── ⑤⑥ 渲染树：收起态不该有面板；展开态要有时间 ─────────── */

// ★ 桩要自己走进组件函数 —— React 会替你调，这里得手动调。
//   连着踩了两次：① 原版只 walk 元素树，第一个 "button" 采到的是 `ClockEntry` 的**函数体**；
//   ② 修完仍不对，因为 `react.createElement(ClockEntry)` 的 `type` 是**函数**，得先判函数再走。
function walk(node, out, depth) {
  if (depth > 50 || node === null || node === undefined || typeof node === "boolean") return out
  if (typeof node === "string" || typeof node === "number") { out.text.push(String(node)); return out }
  if (typeof node === "function") return walk(node({}), out, depth + 1)
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out, depth + 1)); return out }
  if (typeof node !== "object") return out
  if (node.__el) {
    if (typeof node.type === "function") return walk(node.type(node.props || {}), out, depth + 1)
    out.nodes.push({ tag: node.type, props: node.props || {} })
    walk(node.children, out, depth + 1)
  }
  return out
}

const tree = reg ? reg.Comp({}) : null
const { nodes, text } = walk(tree, { nodes: [], text: [] }, 0)
const strings = text.filter((s) => typeof s === "string" && s.trim().length > 0)
const btn = nodes.find((n) => n.tag === "button")

check("渲染出 button（真走进组件函数）", !!btn, nodes.map((n) => typeof n.tag === "string" ? n.tag : String(n.tag)).join(","))
if (btn) {
  check("button id = dsh-agent-clock-btn（面板定位靠它兜底）", btn.props.id === "dsh-agent-clock-btn", btn.props.id)
  check("button 有 aria-label / title", btn.props["aria-label"] === "当前时间" && btn.props.title === "当前时间")
  check("初态 data-open = 0（收起）", btn.props["data-open"] === "0", btn.props["data-open"])
  check("button 挂了 onClick（点了要能开）", typeof btn.props.onClick === "function")
  try { btn.props.onClick(); check("onClick() 不抛", true) } catch (e) { check("onClick() 不抛", false, e.message) }
}
check("★ 收起态不渲染面板（点开前看不见）", !nodes.some((n) => n.props.className === "dsh-agent-clock-panel"))
check("★ 收起态也没有时间文字（不偷跑）", !strings.some((s) => /^\d{2}:\d{2}:\d{2}$/.test(s)), JSON.stringify(strings))
check("时钟图标 SVG 在（circle + path）", nodes.some((n) => n.tag === "circle") && nodes.some((n) => n.tag === "path"))

const now = new Date()
const pad = (n) => (n < 10 ? "0" + n : String(n))
const expectClock = pad(now.getHours()) + ":" + pad(now.getMinutes()) + ":" + pad(now.getSeconds())
check("时分秒格式判据（HH:MM:SS）", /^\d{2}:\d{2}:\d{2}$/.test(expectClock), expectClock)
check("样式含 monospace + tabular-nums（秒跳不抖）", injectedCss.includes("ui-monospace") && injectedCss.includes("tabular-nums"))
check("样式含 position:fixed（不被 256×36 的窄槽位裁掉）", injectedCss.includes("position:fixed"))
check("样式含 z-index（盖在侧栏之上）", /z-index:\s*300/.test(injectedCss))

/* ── ⑦ 宿主半 ────────────────────────────────────────────── */

const host = await import(pathToFileURL(HOST).href).catch((e) => fail("import index.js threw: " + e.message))
check("宿主半 name = dsh-agent-clock", host.name === "dsh-agent-clock", host.name)
check("宿主半 inject 是数组", Array.isArray(host.inject), JSON.stringify(host.inject))
check("宿主半 apply 是函数", typeof host.apply === "function")
try { host.apply({}); check("宿主半 apply({}) 不抛", true) } catch (e) { check("宿主半 apply({}) 不抛", false, e.message) }

report()

function report() {
  console.log("")
  console.log("verified: " + DIR)
  let bad = 0
  for (const r of results) {
    if (!r.ok) bad++
    console.log((r.ok ? "  ok   " : "  FAIL ") + r.name + (r.detail ? "   [" + r.detail + "]" : ""))
  }
  console.log("")
  console.log((results.length - bad) + "/" + results.length + " passed")
  process.exit(bad === 0 ? 0 : 1)
}
