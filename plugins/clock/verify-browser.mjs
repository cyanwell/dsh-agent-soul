/**
 * dsh-agent-clock 真浏览器验收 —— 在真 Chrome/Edge 里量真 DOM。
 *
 * 覆盖的正是「弹层向下超出窗口」那条 issue 的形状：
 *   侧栏容器带 transform / backdrop-filter → 它会成为 position:fixed 的包含块，
 *   面板只要还挂在它内部，坐标就会整体错位（不是算错，是坐标系错了）。
 *
 * 三个场景：
 *   A. 本实现：面板挂 document.body + placeNear 实测定位   → 期望完整落在视口内
 *   B. 旧实现：挂在槽位内 + position:fixed + 估算高度     → 复现「跑偏」（根因证据）
 *   C. 本算法但挂错容器：验证 getBoundingClientRect 回读校准能自愈
 *
 * 依赖是可选的：没有 playwright-core 或本机浏览器时输出 SKIP 并以 0 退出，
 * 不阻塞不装浏览器的环境。要真跑，装一个 playwright-core 即可：
 *
 *   npm i -D playwright-core
 *   CHROME_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe" node verify-browser.mjs
 */

import { createRequire } from "node:module"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, "client.js")
const requireFromHere = createRequire(import.meta.url)

function loadPlaywright() {
  // 1) 普通安装  2) 环境变量指定的绝对路径（DSH profile / 全局 node_modules 之类）
  const tries = ["playwright-core", "playwright"]
  if (process.env.PLAYWRIGHT_CORE) tries.unshift(process.env.PLAYWRIGHT_CORE)
  for (const name of tries) {
    try { return requireFromHere(name) } catch (e) { /* 继续试下一个 */ }
  }
  return null
}

function findBrowser() {
  const cands = [
    process.env.CHROME_PATH,
    process.env.MSEDGE_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean)
  for (const c of cands) { try { if (existsSync(c)) return c } catch (e) { /* 下一个 */ } }
  return null
}

const pw = loadPlaywright()
const browserPath = findBrowser()
if (!pw || !pw.chromium || !browserPath) {
  console.log("SKIP verify-browser —— " + (!pw ? "没装 playwright-core" : "没找到 Chrome/Edge") +
    "（装 playwright-core 或设 CHROME_PATH 后可跑；位置算法另有 verify-position.mjs 覆盖）")
  process.exit(0)
}

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;height:100%;}
  /* 模拟真实侧栏：transform + backdrop-filter 都会创建包含块 */
  #sidebar{position:absolute;left:0;top:0;bottom:0;width:64px;background:#eef1f5;
    transform:translateZ(0);backdrop-filter:blur(6px);}
  #footerActions{position:absolute;left:0;bottom:0;width:64px;height:36px;
    display:flex;align-items:center;justify-content:center;
    /* ★ 槽位自身也带 transform —— 真实侧栏那种毛玻璃容器就是这个形状：
       它会让内部的 position:fixed 相对这个 64x36 的小格子定位 */
    transform:translateZ(0);backdrop-filter:blur(4px);}
</style></head><body>
  <div id="sidebar"><div id="footerActions"></div></div>
</body></html>`

const browser = await pw.chromium.launch({
  executablePath: browserPath,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
})

const failures = []
let checks = 0
const MARGIN = 8

function check(name, ok, detail) {
  checks++
  if (!ok) failures.push(name + (detail ? "  →  " + detail : ""))
  return ok
}

for (const [vw, vh] of [[1440, 900], [1024, 768], [800, 600]]) {
  const page = await browser.newPage()
  await page.setViewportSize({ width: vw, height: vh })
  await page.addInitScript(() => {
    window.__ModuleLoader__ = { load(spec) { window.__CLOCK_SPEC__ = spec } }
  })
  await page.goto("about:blank")
  await page.setContent(HTML)
  await page.addScriptTag({ path: CLIENT })

  const out = await page.evaluate(() => {
    const spec = window.__CLOCK_SPEC__
    if (!spec) return { error: "client.js 没有注册到 __ModuleLoader__" }

    const stub = {
      createElement: () => ({}),
      useState: (v) => [typeof v === "function" ? v() : v, () => {}],
      useRef: (v) => ({ current: v }),
      useEffect: () => {},
      Fragment: Symbol("Fragment"),
    }
    const mod = spec.factory((n) => {
      if (n === "react") return stub
      throw new Error("unexpected require: " + n)
    })
    mod.apply({ slots: { inject: (n, cb) => cb(), register: () => {} } })   // 注入真实 CSS

    const T = mod.__test
    if (!T || typeof T.placeNear !== "function") return { error: "exports.__test.placeNear 缺失" }

    const footer = document.getElementById("footerActions")
    const btn = document.createElement("button")
    btn.className = "dsh-agent-clock-trigger"
    btn.id = "dsh-agent-clock-btn"
    footer.appendChild(btn)

    function mkPanel(host) {
      const p = T.buildPanel()
      p.el.style.visibility = "hidden"
      host.appendChild(p.el)
      return p
    }
    function snap(el, btnEl) {
      const r = el.getBoundingClientRect()
      const b = btnEl.getBoundingClientRect()
      return {
        left: +r.left.toFixed(1), top: +r.top.toFixed(1),
        right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1),
        width: +r.width.toFixed(1), height: +r.height.toFixed(1),
        btnLeft: +b.left.toFixed(1), btnTop: +b.top.toFixed(1),
        btnRight: +b.right.toFixed(1), btnBottom: +b.bottom.toFixed(1),
        scrollH: el.scrollHeight, clientH: el.clientHeight,
        parent: el.parentElement === document.body ? "body" : (el.parentElement && el.parentElement.id) || "?",
      }
    }

    const de = document.documentElement
    const vw = de.clientWidth, vh = de.clientHeight

    /* A. 本实现 */
    const a = mkPanel(document.body)
    T.placeNear(btn, a.el)
    const A = snap(a.el, btn)
    a.el.remove()

    /* B. 旧实现：挂在带 transform 的槽位内 + 估算高度 140 + position:fixed */
    const b = mkPanel(footer)
    const rb = btn.getBoundingClientRect()
    let bl = Math.min(Math.max(8, rb.left), Math.max(8, vw - 232 - 8))
    let bt = rb.top - 8 - 140
    if (bt < 12) bt = Math.min(rb.bottom + 8, vh - 140 - 12)
    b.el.style.left = Math.round(bl) + "px"
    b.el.style.top = Math.round(Math.max(12, bt)) + "px"
    const B = snap(b.el, btn)
    b.el.remove()

    /* C. 本算法 + 挂错容器（回读校准能救场吗） */
    const c = mkPanel(footer)
    T.placeNear(btn, c.el)
    const C = snap(c.el, btn)
    c.el.remove()

    return { vw, vh, A, B, C }
  })

  if (out.error) { check("[" + vw + "] " + out.error, false); await page.close(); continue }

  const inView = (r, label) => {
    const okL = r.left >= MARGIN - 0.5
    const okT = r.top >= MARGIN - 0.5
    const okR = r.right <= out.vw - MARGIN + 0.5
    const okB = r.bottom <= out.vh - MARGIN + 0.5
    check(`[${vw}x${vh}] ${label} 四边都在视口内`, okL && okT && okR && okB,
      `rect=(${r.left},${r.top},${r.right},${r.bottom}) viewport=${out.vw}x${out.vh}`)
  }

  inView(out.A, "A 本实现(挂 body)")
  const overlap = (r) => !(r.right <= r.btnLeft || r.left >= r.btnRight || r.bottom <= r.btnTop || r.top >= r.btnBottom)
  check(`[${vw}x${vh}] A 面板不压住按钮`, !overlap(out.A), JSON.stringify(out.A))
  check(`[${vw}x${vh}] A 面板完整显示(无内部滚动)`, out.A.scrollH <= out.A.clientH + 1,
    `scrollH=${out.A.scrollH} clientH=${out.A.clientH}`)
  check(`[${vw}x${vh}] A 面板挂在 body 下`, out.A.parent === "body", out.A.parent)
  check(`[${vw}x${vh}] A 面板在按钮右侧`, out.A.left >= out.A.btnRight - 0.5,
    JSON.stringify({ panelLeft: out.A.left, btnRight: out.A.btnRight }))
  check(`[${vw}x${vh}] A 面板底边落在按钮那一行（不浮在按钮上方）`,
    out.A.bottom >= out.A.btnTop - 0.5 && out.A.bottom <= out.A.btnBottom + 0.5,
    JSON.stringify({ panelBottom: out.A.bottom, btnTop: out.A.btnTop, btnBottom: out.A.btnBottom }))

  const bInside =
    out.B.left >= MARGIN - 0.5 && out.B.top >= MARGIN - 0.5 &&
    out.B.right <= out.vw - MARGIN + 0.5 && out.B.bottom <= out.vh - MARGIN + 0.5
  check(`[${vw}x${vh}] B 旧实现(挂槽位内)确实跑偏 —— 根因证据`, !bInside,
    `rect=(${out.B.left},${out.B.top},${out.B.right},${out.B.bottom}) viewport=${out.vw}x${out.vh}`)

  inView(out.C, "C 本算法挂错容器(回读校准救场)")

  console.log(
    `  [${vw}x${vh}] A=(${out.A.left},${out.A.top},${out.A.right},${out.A.bottom}) ` +
    `B_旧=(${out.B.left},${out.B.top},${out.B.right},${out.B.bottom}) ` +
    `C_挂错=(${out.C.left},${out.C.top},${out.C.right},${out.C.bottom})`
  )

  await page.close()
}

await browser.close()

console.log("")
console.log("=== 真浏览器验收（headless Chrome/Edge，真 DOM/真 CSS）===")
console.log(`断言 ${checks} 条，失败 ${failures.length} 条`)
if (failures.length) {
  console.log("")
  for (const f of failures) console.log("  ✗ " + f)
  process.exit(1)
}
console.log("RESULT: PASS —— 面板在真浏览器里完整落在视口内，且不压按钮")
