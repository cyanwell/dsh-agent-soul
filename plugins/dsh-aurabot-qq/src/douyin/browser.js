// 抖音专用浏览器：独立用户资料目录的 Edge / Chrome，经 CDP（Node 自带 WebSocket）控制。
// 只管「开 / 连 / 点 / 打字 / 截图 / 等接口返回」这些通用动作，抖音相关的都在 site.js。
// 不用无头模式：抖音会拦无头浏览器（页面一直「加载中」）。Linux 没桌面就配 Xvfb。

import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const CANDIDATES = [
  process.env.EDGE_PATH,
  process.env.CHROME_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/microsoft-edge-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean)

/** 找浏览器：面板填了就用填的，否则 Edge 优先，再找 Chrome / Chromium。 */
export function findBrowser(explicit = '', exists = existsSync) {
  if (explicit) return exists(explicit) ? explicit : ''
  return CANDIDATES.find((p) => exists(p)) || ''
}

/** 本机空闲端口。 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.unref()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
  })
}

/** 资料目录里记下的调试端口（我们启动时自己写的；DSH 重启后靠它接回已经开着的窗口）。 */
export function readPortFile(profileDir, read = readFileSync) {
  try {
    const n = Number(String(read(join(profileDir, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0].trim())
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : 0
  } catch (error) {
    return 0
  }
}

/** 从标签页列表里挑要用的那个：优先抖音页，没有就第一个普通页。其余抖音页一并返回，好关掉（多点几次面板不会越攒越多）。 */
export function pickPage(targets) {
  const pages = (targets || []).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  const douyin = pages.filter((t) => /^https:\/\/[^/]*douyin\.com/.test(t.url || ''))
  const page = douyin[0] || pages[0] || null
  return { page, extra: douyin.slice(1) }
}

async function getJson(url, ms = 5000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) })
  if (!r.ok) throw new Error(`${url} → ${r.status}`)
  return r.json()
}

/** 一条 CDP 连接：send 发命令，on 收事件。 */
export function connectCdp(wsUrl, { WS = globalThis.WebSocket } = {}) {
  if (!WS) throw new Error('当前 Node 没有 WebSocket（要 Node 22 以上）')
  const sock = new WS(wsUrl)
  let nextId = 1
  let closed = false
  const pending = new Map()
  const listeners = new Map()
  sock.addEventListener('message', (ev) => {
    let msg
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()) } catch (error) { return }
    if (msg.id != null && pending.has(msg.id)) {
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message || 'CDP 出错'))
      else p.resolve(msg.result || {})
    } else if (msg.method) {
      for (const fn of listeners.get(msg.method) || []) try { fn(msg.params || {}) } catch (error) {}
    }
  })
  sock.addEventListener('close', () => {
    closed = true
    for (const p of pending.values()) p.reject(new Error('浏览器连接断了'))
    pending.clear()
  })
  const ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('连不上浏览器调试端口')), 10000)
    sock.addEventListener('open', () => { clearTimeout(t); resolve() })
    sock.addEventListener('error', () => { clearTimeout(t); reject(new Error('连不上浏览器调试端口')) })
  })
  return {
    ready,
    get closed() { return closed },
    send(method, params = {}, ms = 30000) {
      if (closed) return Promise.reject(new Error('浏览器连接断了'))
      const id = nextId++
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { pending.delete(id); reject(new Error(`浏览器没响应（${method}）`)) }, ms)
        pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v) }, reject: (e) => { clearTimeout(t); reject(e) } })
        sock.send(JSON.stringify({ id, method, params }))
      })
    },
    on(method, fn) {
      if (!listeners.has(method)) listeners.set(method, new Set())
      listeners.get(method).add(fn)
      return () => listeners.get(method)?.delete(fn)
    },
    close() { try { sock.close() } catch (error) {} },
  }
}

/**
 * 专用浏览器。open() 才会真的启动 / 连接；只读状态的地方不要调它（打开面板不该弹窗口）。
 * @param {{profileDir:string, browserPath?:()=>string, log?:object}} o
 */
export function createBrowser({ profileDir, browserPath = () => '', log } = {}) {
  let cdp = null
  let opening = null

  const connected = () => Boolean(cdp && !cdp.closed)

  async function attach(port) {
    const { page, extra } = pickPage(await getJson(`http://127.0.0.1:${port}/json/list`))
    for (const t of extra) await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`).catch(() => {})
    let target = page
    if (!target) target = await getJson(`http://127.0.0.1:${port}/json/new?about:blank`).catch(() => null)
    if (!target?.webSocketDebuggerUrl) throw new Error('浏览器里没有能控制的标签页')
    const c = connectCdp(target.webSocketDebuggerUrl)
    await c.ready
    await c.send('Page.enable')
    await c.send('Runtime.enable')
    await c.send('Network.enable', { maxResourceBufferSize: 20e6, maxTotalBufferSize: 100e6 })
    await c.send('Page.setMuted', { muted: true }).catch(() => {}) // 老版本没有这个命令，静音再靠 --mute-audio
    cdp = c
  }

  async function launch() {
    const bin = findBrowser(browserPath())
    if (!bin) return { ok: false, message: browserPath() ? `浏览器路径不对：${browserPath()}` : '找不到 Edge / Chrome，先装一个，或在面板里填浏览器路径' }
    mkdirSync(profileDir, { recursive: true })
    const port = await freePort()
    const child = spawn(bin, [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
      '--no-first-run',
      '--no-default-browser-check',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      // 窗口在屏幕外也照常播放视频、跑页面脚本（不然会被当成后台窗口限速）
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=Translate,MediaRouter,CalculateNativeWinOcclusion',
      '--window-size=1280,860',
      '--window-position=-2400,-2400', // 放到屏幕外，不抢前台；要看的时候 show()
      'about:blank',
    ], { stdio: 'ignore', detached: true })
    child.on('error', (error) => log?.warn?.('浏览器启动失败：', error.message))
    child.unref()
    for (let i = 0; i < 60; i++) {
      await sleep(250)
      if (await getJson(`http://127.0.0.1:${port}/json/version`, 1500).catch(() => null)) {
        // Edge 经常不写这个文件，自己写一份，DSH 重启后才能接回这个窗口
        try { writeFileSync(join(profileDir, 'DevToolsActivePort'), `${port}\n/devtools/browser/aurabot\n`) } catch (error) {}
        await attach(port)
        return { ok: true }
      }
    }
    return { ok: false, message: '浏览器没起来。可能这个专用资料目录被另一个 Edge 窗口占着（不是插件开的那种），关掉它再试' }
  }

  /** 连上专用浏览器：已经开着就接回去，没开就启动一个（屏幕外）。 */
  async function open() {
    if (connected()) return { ok: true }
    if (opening) return opening
    opening = (async () => {
      const port = readPortFile(profileDir)
      if (port && await getJson(`http://127.0.0.1:${port}/json/version`, 1500).catch(() => null)) {
        try {
          await attach(port)
          return { ok: true }
        } catch (error) {
          log?.debug?.('接回已开的浏览器失败，重新启动：', error.message)
        }
      }
      return launch()
    })().catch((error) => ({ ok: false, message: error.message })).finally(() => { opening = null })
    return opening
  }

  function need() {
    if (!connected()) throw new Error('浏览器没连上')
    return cdp
  }

  /** 在页面里跑一段表达式，返回值（可以是 Promise）。 */
  async function evaluate(expression, ms = 30000) {
    const r = await need().send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, ms)
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] || r.exceptionDetails.text || '页面脚本出错')
    return r.result?.value
  }

  /** 打开网址，等页面加载完（最多 ms；抖音的 load 事件常常很晚，后面再按需 waitFor 具体元素）。 */
  async function goto(url, ms = 8000) {
    const c = need()
    const loaded = new Promise((resolve) => {
      const off = c.on('Page.loadEventFired', () => { off(); resolve() })
      setTimeout(() => { off(); resolve() }, ms)
    })
    await c.send('Page.navigate', { url })
    await loaded
  }

  /** 等某个选择器出现，返回它的中心点和属性；超时返回 null。 */
  async function waitFor(selector, ms = 10000) {
    const end = Date.now() + ms
    while (Date.now() < end) {
      const box = await evaluate(`(() => {
        const n = document.querySelector(${JSON.stringify(selector)})
        if (!n) return null
        n.scrollIntoView({ block: 'center', inline: 'center' })
        const r = n.getBoundingClientRect()
        if (r.width <= 0 || r.height <= 0) return null
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, left: r.x, top: r.y, state: n.getAttribute('data-e2e-state') || '', text: (n.innerText || '').slice(0, 200) }
      })()`).catch(() => null)
      if (box) return box
      await sleep(300)
    }
    return null
  }

  /** 真鼠标点一下（页面看到的是正常的点击事件，不是脚本 .click()）。 */
  async function click(x, y) {
    const c = need()
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
      await sleep(40 + Math.random() * 60)
    }
  }

  /**
   * 点一个元素。页面看得见时用真鼠标点在它中间；看不见时（锁屏、关屏、窗口被系统判成被遮挡）
   * 浏览器会吞掉模拟的鼠标输入，只能在页面里派发鼠标事件。找不到元素返回 false。
   */
  async function press(selector) {
    const r = await evaluate(`(() => {
      const n = document.querySelector(${JSON.stringify(selector)})
      if (!n) return null
      n.scrollIntoView({ block: 'center', inline: 'center' })
      if (document.visibilityState !== 'visible') {
        for (const t of ['mouseover', 'mousedown', 'mouseup', 'click']) n.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window, button: 0 }))
        return { dom: true }
      }
      const b = n.getBoundingClientRect()
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
    })()`)
    if (!r) return false
    if (!r.dom) await click(r.x, r.y)
    return true
  }

  /** 往当前焦点打字（和输入法上屏一样，富文本编辑器也认）。 */
  async function type(text) {
    await need().send('Input.insertText', { text })
  }

  /** 清空当前焦点输入框：真按 Ctrl+A、退格（抖音私信框的编辑器不认 execCommand）。 */
  async function clearFocused() {
    const c = need()
    const key = async (k, code, vk, modifiers = 0) => {
      await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers })
      await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers })
    }
    await key('a', 'KeyA', 65, process.platform === 'darwin' ? 4 : 2)
    await key('Backspace', 'Backspace', 8)
  }

  async function pressEnter() {
    const c = need()
    const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key, text: '\r' })
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
  }

  /**
   * 开始等一个接口的返回（先调它、再做动作、再 await），拿到 { status, headers, json }；超时 null。
   * 用来确认点赞 / 评论到底成功没有，而不是点完就当成功。
   */
  function waitResponse(urlRe, ms = 10000) {
    const c = need()
    return new Promise((resolve) => {
      const ids = new Map()
      const done = (v) => { offA(); offB(); clearTimeout(t); resolve(v) }
      const offA = c.on('Network.responseReceived', (p) => { if (urlRe.test(p.response?.url || '')) ids.set(p.requestId, { status: p.response.status, headers: p.response.headers || {} }) })
      const offB = c.on('Network.loadingFinished', async (p) => {
        if (!ids.has(p.requestId)) return
        const b = await c.send('Network.getResponseBody', { requestId: p.requestId }).catch(() => null)
        let json = null
        try { json = JSON.parse(b?.base64Encoded ? Buffer.from(b.body, 'base64').toString() : b?.body) } catch (error) {}
        done({ ...ids.get(p.requestId), json })
      })
      const t = setTimeout(() => done(null), ms)
    })
  }

  /** 截图（可截一块），返回 data:image/png。 */
  async function screenshot(clip) {
    const r = await need().send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) })
    return r.data ? 'data:image/png;base64,' + r.data : ''
  }

  /** 窗口挪到屏幕里给人看 / 挪回屏幕外。 */
  async function show(visible) {
    const c = need()
    const { windowId } = await c.send('Browser.getWindowForTarget')
    await c.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }).catch(() => {})
    await c.send('Browser.setWindowBounds', { windowId, bounds: visible ? { left: 80, top: 60, width: 1280, height: 860 } : { left: -2400, top: -2400, width: 1280, height: 860 } })
    if (visible) await c.send('Page.bringToFront').catch(() => {})
  }

  function close() {
    cdp?.close()
    cdp = null
  }

  return { open, connected, evaluate, goto, waitFor, click, press, type, clearFocused, pressEnter, waitResponse, screenshot, show, close }
}
