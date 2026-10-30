/**
 * dsh-agent-clock 定位算法验收 —— 纯数学穷举，不需要浏览器。
 *
 * 为什么要有这个文件：上一轮「修好了」是肉眼判断的，重启后又回去了。
 * 这里把 placeNear() 从真 client.js 里取出来（exports.__test），
 * 用假 DOM 穷举视口 × 按钮位置 × 面板高度，断言每一个组合都满足：
 *
 *   面板完整落在视口内：left >= 8, top >= 8, right <= vw-8, bottom <= vh-8
 *
 * 假 DOM 刻意模拟了两条真实 CSS 约束（max-width / max-height + overflow），
 * 所以「面板比视口还高」这种极端情况也在覆盖范围内。
 *
 * 用法：node verify-position.mjs
 */

import { pathToFileURL } from "node:url"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, "client.js")

const MARGIN = 8

/* ── 假 DOM：面板的 rect 由 style.left/top + 有效宽高算出来 ── */

let VIEW = { w: 1440, h: 900 }

const clampNum = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

function makeBox(el, naturalW, naturalH) {
  el.naturalW = naturalW
  el.naturalH = naturalH
  Object.defineProperty(el, "offsetWidth", {
    get() { return clampNum(el.naturalW, 0, Math.max(0, VIEW.w - 16)) },
  })
  Object.defineProperty(el, "offsetHeight", {
    get() { return clampNum(el.naturalH, 0, Math.max(0, VIEW.h - 16)) },
  })
  el.getBoundingClientRect = function () {
    const w = el.offsetWidth
    const h = el.offsetHeight
    const left = parseFloat(el.style.left) || 0
    const top = parseFloat(el.style.top) || 0
    return { left, top, right: left + w, bottom: top + h, width: w, height: h }
  }
  return el
}

function makeEl(tag, w, h) {
  const el = makeBox({
    tagName: String(tag).toUpperCase(),
    id: "", className: "", textContent: "", style: {}, children: [],
    appendChild(c) { this.children.push(c); return c },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c },
    setAttribute() {}, addEventListener() {}, removeEventListener() {},
    closest() { return null },
    contains() { return false },
  }, w === undefined ? 0 : w, h === undefined ? 0 : h)
  return el
}

const bodyEl = makeEl("body")
const headEl = makeEl("head")

globalThis.document = {
  documentElement: { clientWidth: 1440, clientHeight: 900 },
  body: bodyEl,
  head: headEl,
  getElementById() { return null },
  querySelector() { return null },
  createElement(tag) { return makeEl(tag) },
  addEventListener() {}, removeEventListener() {},
}
globalThis.window = {
  innerWidth: 1440,
  innerHeight: 900,
  requestAnimationFrame(fn) { return setTimeout(fn, 0) },
  cancelAnimationFrame(id) { clearTimeout(id) },
  addEventListener() {}, removeEventListener() {},
  __ModuleLoader__: { load(spec) { globalThis.__spec = spec } },
}

/* ── 真 import client.js，拿它自己注册的 factory ───────────── */

await import(pathToFileURL(CLIENT).href)
const spec = globalThis.__spec
if (!spec) { console.error("FAIL: client.js 没走到 __ModuleLoader__.load"); process.exit(1) }

const reactStub = {
  createElement() { return { __el: true } },
  useState(v) { return [typeof v === "function" ? v() : v, () => {}] },
  useRef(v) { return { current: v } },
  useEffect() {},
  Fragment: Symbol("Fragment"),
}
const mod = spec.factory((name) => {
  if (name === "react") return reactStub
  throw new Error("unexpected require: " + name)
})

const T = mod.__test
if (!T || typeof T.placeNear !== "function") {
  console.error("FAIL: exports.__test.placeNear 不存在 —— 定位算法被改动/去掉了")
  process.exit(1)
}

/* ── 穷举 ─────────────────────────────────────────────── */

const viewports = [[1440, 900], [1920, 1080], [1024, 768], [800, 600], [420, 320], [3840, 2160]]
const panels = [[232, 110], [232, 400], [232, 900]]
const BTN = 36

let total = 0, failed = 0
const failures = []

function setView(w, h) {
  VIEW = { w, h }
  globalThis.document.documentElement.clientWidth = w
  globalThis.document.documentElement.clientHeight = h
  globalThis.window.innerWidth = w
  globalThis.window.innerHeight = h
}

for (const [vw, vh] of viewports) {
  setView(vw, vh)

  // 按钮可能出现的所有关键位置：四角 + 四边中点 + 正中
  const xs = [8, Math.round((vw - BTN) / 2), vw - BTN - 8]
  const ys = [8, Math.round((vh - BTN) / 2), vh - BTN - 8]

  for (const bx of xs) {
    for (const by of ys) {
      for (const [pw, ph] of panels) {
        total++

        const trigger = makeEl("button")
        trigger.getBoundingClientRect = () => ({
          left: bx, top: by, right: bx + BTN, bottom: by + BTN,
          width: BTN, height: BTN,
        })

        const panel = makeEl("div", pw, ph)
        panel.style.left = "0px"
        panel.style.top = "0px"

        const out = T.placeNear(trigger, panel)
        const label = `vp=${vw}x${vh} btn=(${bx},${by}) panel=${pw}x${ph}`

        if (!out) { failed++; failures.push(`${label} → placeNear 返回 null`); continue }

        const r = panel.getBoundingClientRect()
        const okLeft = r.left >= MARGIN - 0.5
        const okTop = r.top >= MARGIN - 0.5
        const okRight = r.right <= vw - MARGIN + 0.5
        const okBottom = r.bottom <= vh - MARGIN + 0.5

        if (!(okLeft && okTop && okRight && okBottom)) {
          failed++
          failures.push(
            `${label} → rect=(${r.left.toFixed(1)},${r.top.toFixed(1)},${r.right.toFixed(1)},${r.bottom.toFixed(1)})` +
            ` 越界: ${[!okLeft && "left", !okTop && "top", !okRight && "right", !okBottom && "bottom"].filter(Boolean).join(",")}`
          )
        }
      }
    }
  }
}

/* ── 契约断言：面板绝不能挂在 React 槽位子树里 ───────────── */

import { readFileSync } from "node:fs"
const src = readFileSync(CLIENT, "utf8")
const contract = []

function assert(name, ok, detail) {
  contract.push({ name, ok: !!ok, detail: detail === undefined ? "" : String(detail) })
}

assert("exports.inject 含 'slots'（少了整包静默失效）",
  Array.isArray(mod.inject) && mod.inject.includes("slots"), JSON.stringify(mod.inject))
assert("面板挂到 document.body（脱离侧栏祖先的定位上下文）",
  /host\.appendChild\(el\)/.test(src) && /document\.body \|\| document\.documentElement/.test(src))
assert("不再用估算高度常量 PANEL_H",
  !/PANEL_H\s*=/.test(src))
assert("读真实尺寸 offsetWidth/offsetHeight",
  /panelEl\.offsetWidth/.test(src) && /panelEl\.offsetHeight/.test(src))
assert("四边夹紧（MARGIN 四次比较都在）",
  /got\.left < MARGIN/.test(src) && /got\.top < MARGIN/.test(src) &&
  /got\.right > vp\.w - MARGIN/.test(src) && /got\.bottom > vp\.h - MARGIN/.test(src))
assert("CSS 兜底 max-width/max-height + overflow:auto",
  /max-width:calc\(100vw - 16px\)/.test(src) && /max-height:calc\(100vh - 16px\)/.test(src) && /overflow:auto/.test(src))
assert("带版本戳 data-clock-rev", /data-clock-rev/.test(src) && /REV = \d+/.test(src))

/* ── 报告 ─────────────────────────────────────────────── */

console.log("")
console.log("=== dsh-agent-clock 定位验收 ===")
console.log(`穷举组合：${total} 个（视口 × 按钮位置 × 面板尺寸）`)
console.log(`越界/失败：${failed} 个`)
if (failures.length) {
  console.log("")
  for (const f of failures.slice(0, 12)) console.log("  ✗ " + f)
  if (failures.length > 12) console.log(`  … 还有 ${failures.length - 12} 条`)
}
console.log("")
console.log("=== 契约断言 ===")
let cok = 0
for (const c of contract) {
  console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? "  [" + c.detail + "]" : ""}`)
  if (c.ok) cok++
}
console.log("")

const pass = failed === 0 && cok === contract.length
console.log(pass ? "RESULT: PASS —— 所有组合下面板都完整落在视口内" : "RESULT: FAIL")
process.exit(pass ? 0 : 1)
