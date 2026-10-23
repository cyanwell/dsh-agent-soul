// dsh-agent-model-statusbar —— 宿主半
//
// 干什么：把本机「本地模型」（目前是 ComfyUI，8188）的运行情况摆到 GUI 上，并给四个动作：
//   status 探测 / start 拉起 / idle 静息 / stop 关闭
//
// ── 为什么由宿主半来起进程，而不是从 pwsh 工具起 ──────────────────
// 宿主半跑在 DSH 进程里，而 DSH 是从桌面图标起的独立进程 —— 它 spawn 的子进程不在
// agent 的「作业运行器」里，所以能活过回合。实测依据：dsh-comfyui-panel 的
// startComfy() 就是这么干的，拉起后能一直活着（<comfyui 面板目录> 从 pwsh 工具起会死：run_in_background 的受管作业随回合结束被杀，Start-Process 的子进程
// 也随命令结束被杀，而且整条命令还会报 `Windows Job runner exited with exit code 4294967295`。
//
// 我在这基础上多两步：
//   1. detached:true + unref() —— ComfyUI 连 DSH 重启都不跟着死。
//      （静息/在跑是【用户的】决定，不该被一次 DSH 重启悄悄改掉）
//   2. stdout/stderr 落盘到 <ComfyUI 日志目录>\ —— 起不来时能看原因，不是抓瞎。
//      ★ 但仍然不 pipe：不读的管道写满之后会把子进程卡死（comfyui-panel 踩过，注释原话）。
//
// ── 探测不在这里重写 ──────────────────────────────────────────
// 复用已实测通过的 probe.ps1（包内自带一份，Copy-Item 保 BOM + MD5 一致）。
// ★ 本机 powershell.exe 是 Windows PowerShell 5.1，读 .ps1 默认按 GBK 解码 ——
//   UTF-8 无 BOM 的中文脚本会整片乱码、语法崩。probe.ps1 用「UTF-8 with BOM + 输出全英文」
//   两个办法绕开了，所以那份文件【不许】用 write/edit 重新生成（会丢 BOM）。

import { spawn, execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs'
import { join, dirname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-agent-model-statusbar'
export const inject = ['tools', 'webServer']

const HERE = dirname(fileURLToPath(import.meta.url))
const PROBE_PS1 = join(HERE, 'probe.ps1')

// ── 可配项（README 的「可配项」是契约，这里必须真的读它们）────────────────
// ★★ 2026-10-23 修：这一段原来是 5 个占位符（`<ComfyUI 目录>` 之类），且全文件零
//   `process.env` —— README 承诺的 STATUSBAR_STATE / COMFYUI_HOST / COMFYUI_DIR 一个都没兑现。
//   后果：换台机器「拉起」永远报找不到 python；改了端口仍探 8188，状态永远「未知」。
const ENV = (k) => String(process.env[k] || '').trim()
// 相对路径锚在插件自身目录（HERE），不锚 cwd —— 宿主进程的 cwd 是安装目录，
// 跟着它写文件会让同一份状态在「不同启动方式」下落进不同目录。
const resolveHere = (p) => (p ? (isAbsolute(p) ? p : join(HERE, p)) : '')

// 状态文件：① STATUSBAR_STATE（README 承诺项）→ ② 插件目录下的 statusbar-state.json。
// 候选理由：这是**插件自己的**运行状态（静息倒计时），不属于使用者的数据，默认就该待在插件目录。
const STATE_FILE = resolveHere(ENV('STATUSBAR_STATE')) || join(HERE, 'statusbar-state.json')

// 本地模型服务地址：① COMFYUI_HOST（README 承诺项）→ ② 127.0.0.1:8188。
// 候选理由：② 是 ComfyUI 自己的默认监听地址/端口，不是某台机器的值 —— 没改端口的人换机器仍然对。
// 接受三种写法：`host`、`host:port`、`http://host:port`（README 示例是 host:port 形态）。
function parseComfyHost(raw) {
  const s = String(raw || '').trim().replace(/\/+$/, '')
  if (!s) return { host: '127.0.0.1', port: 8188, base: 'http://127.0.0.1:8188', raw: '' }
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : 'http://' + s)
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 8188)) || 8188
    const host = u.hostname || '127.0.0.1'
    return { host, port, base: `${u.protocol}//${host}:${port}`, raw: s }
  } catch {
    // 解析不了就退回默认值，但把原值留在 raw/bad 里（调用方可以看出来「你配的没被采用」）
    return { host: '127.0.0.1', port: 8188, base: 'http://127.0.0.1:8188', raw: s, bad: true }
  }
}
const COMFY_EP = parseComfyHost(ENV('COMFYUI_HOST'))
const COMFY_HOST = COMFY_EP.host
const COMFY_PORT = COMFY_EP.port
const BASE = COMFY_EP.base

// ComfyUI 安装目录：① COMFYUI_DIR（README 承诺项）→ ② 空（不猜）。
// 候选理由：**没有第二个合理候选** —— 它可能装在任何一个盘的任何一层目录；
// 猜一个等于把某台机器又搬回来。没配时「拉起」会明确告诉你怎么配。
const COMFY_DIR = ENV('COMFYUI_DIR')

// ComfyUI 用的 python：① COMFYUI_PY（额外口子，便携版 / 虚拟环境用得上）
//   → ② 安装目录下的三种常见布局（官方便携包 python_embeded、venv、.venv）。
// 一个都找不到 → 空串，「拉起」明确返回「请设 COMFYUI_PY」，不去撞一个不存在的路径。
function firstExistingFile(cands) {
  for (const c of cands) { if (c && existsSync(c)) return c }
  return ''
}
const COMFY_PY = ENV('COMFYUI_PY') || firstExistingFile([
  COMFY_DIR ? join(COMFY_DIR, 'python_embeded', 'python.exe') : '',
  COMFY_DIR ? join(COMFY_DIR, '.venv', 'Scripts', 'python.exe') : '',
  COMFY_DIR ? join(COMFY_DIR, 'venv', 'Scripts', 'python.exe') : '',
])

// 日志目录：① COMFYUI_LOG_DIR → ② <COMFYUI_DIR>\logs → ③ <插件目录>\logs。
// 候选理由：日志是这个插件拉起的进程的产物，② 让日志和 ComfyUI 放在一起便于对照；
// ③ 是「没配安装目录」时唯一仍然合法、且一定可写的位置。
const LOG_DIR = ENV('COMFYUI_LOG_DIR')
  || (COMFY_DIR ? join(COMFY_DIR, 'logs') : join(HERE, 'logs'))

// 探测脚本：包内自带；要换自己那份就设 STATUSBAR_PROBE（不猜别的路径）。
const PROBE_FILE = ENV('STATUSBAR_PROBE') || PROBE_PS1
const ROUTE = '/model-statusbar'

// ── 空闲自动静息（0-11 加，判据与理由见下面 idleAutoTick）──────
// 阈值集中在这里，调一个数就够。
const IDLE_AUTO_ON = true                 // 总开关
const IDLE_AUTO_MS = 10 * 60 * 1000       // 空闲多久算「不用了」（默认 10 分钟）
const IDLE_AUTO_TICK_MS = 60 * 1000       // 多久查一次
// ★「显存涨了这么多 ⇒ 模型又被读回来了」的判据。
//   computePhase 与空闲判定共用同一个数 —— 两处各写一个 1500 迟早会漂，
//   而漂了出来的就是「状态栏说 idle、其实在跑」那种骗人的显示。
const VRAM_RELOAD_DELTA_MIB = 1500

// spawn 出来的句柄（DSH 重启后会丢 —— 所以 stop 还有一条「按端口找主人」的兜底）
let child = null

// ── probe.ps1 ────────────────────────────────────────────────
// 每次探测要跑一遍 PowerShell（里面还有 Test-NetConnection，慢），所以给个短缓存，
// 免得界面一刷新就把 powershell 堆起来。
let probeCache = { at: 0, data: null, error: null }

function runProbeRaw(timeoutMs = 30000) {
  return new Promise((resolve) => {
    const file = PROBE_FILE
    if (!existsSync(file)) {
      return resolve({
        ok: false,
        error: `找不到探测脚本：${file} —— 设 STATUSBAR_PROBE 指向你自己的 probe.ps1`
          + '（默认用包内那份）',
      })
    }
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, '-Json',
        '-ApiBase', BASE, '-ModelsDir', COMFY_DIR || ''],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const text = String(stdout || '')
        // 就算 exit code 非 0，只要标准输出里有 JSON 就用它（probe 内部某些探测失败不算致命）
        const a = text.indexOf('{')
        const b = text.lastIndexOf('}')
        if (a < 0 || b <= a) {
          return resolve({
            ok: false,
            error: (err && err.message ? err.message : 'probe 没有输出 JSON') +
              (stderr ? ' | stderr: ' + String(stderr).slice(0, 400) : '') +
              (text ? ' | stdout: ' + text.slice(0, 400) : ''),
          })
        }
        try {
          return resolve({ ok: true, raw: JSON.parse(text.slice(a, b + 1)) })
        } catch (e) {
          return resolve({ ok: false, error: 'probe 的 JSON 解析失败：' + String(e?.message || e) })
        }
      },
    )
  })
}

// ★ PowerShell 的 ConvertTo-Json 对【单元素数组会退化成对象】——
//   实测样例里 checkpoints 有 3 个、ports 有 3 个所以是数组，但只要目录里只剩一个底模，
//   它就会变成一个对象。不兜这一层，前端 `p.checkpoints.map` 直接炸。
function arr(x) {
  if (Array.isArray(x)) return x
  return x === null || x === undefined ? [] : [x]
}

function num(x, d = 0) {
  const n = Number(x)
  return Number.isFinite(n) ? n : d
}

function normalize(raw) {
  const c = raw?.comfyui || {}
  const g = raw?.gpu || null
  const gpu = g
    ? {
        name: String(g.name || ''),
        usedMiB: num(g.usedMiB),
        totalMiB: num(g.totalMiB),
        utilPct: num(g.utilPct),
      }
    : null
  return {
    at: new Date().toISOString(),
    comfyui: {
      running: !!c.running,
      apiUp: !!c.apiUp,
      pids: arr(c.pids).map((p) => num(p)).filter((p) => p > 0),
      memMB: num(c.memMB),
      endpoint: String(c.endpoint || BASE),
      port: COMFY_PORT,
    },
    gpu,
    checkpoints: arr(raw?.checkpoints).map((x) => ({ name: String(x?.name || ''), gb: num(x?.gb) })),
    // ★ 组合模型（三件套：unet + text_encoders + vae）—— 和单文件底模是两种东西，
    //   前端分两组显示，别混进 checkpoints 那一列。
    // ★ 两层都要过 arr()：外层 bundles、内层每个组合的 parts。
    //   PS 的 ConvertTo-Json 单元素退化成对象在这里有两处会发生 —— 只剩一个组合时 bundles 变对象，
    //   某个组合只配了一件时 parts 也变对象。（同一坑的解释见上面 arr() 那段。）
    bundles: arr(raw?.bundles).map((b) => ({
      name: String(b?.name || ''),
      gb: num(b?.gb),
      parts: arr(b?.parts).map((p) => ({ part: String(p?.part || ''), name: String(p?.name || ''), gb: num(p?.gb) })),
    })),
    ports: arr(raw?.ports).map((x) => ({ name: String(x?.name || ''), port: num(x?.port), up: !!x?.up })),
  }
}

// ── 静息/运行的状态记忆 ────────────────────────────────────────
// ComfyUI 自己的 API 没有「模型还在不在」这一问，所以自己记：最后一次动作是 idle 还是 start。
// ★ 落盘而不是只放内存：DSH 一重启内存标记就没了，而 ComfyUI 还活着（detached）。
function loadState() {
  try {
    if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  } catch { /* 文件坏了当没有，不让它把插件拖死 */ }
  return {}
}

function saveState(patch) {
  try {
    const next = { ...loadState(), ...patch, at: new Date().toISOString() }
    mkdirSync(dirname(STATE_FILE), { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), 'utf8')
  } catch { /* 记不住状态不该让动作失败 */ }
}

// phase: stopped（进程不在）/ idle（进程在、模型已卸）/ running（进程在、模型在）
function computePhase(st, saved) {
  if (!st.comfyui.apiUp) return 'stopped'
  if (saved && saved.phase === 'idle') {
    // ★ 静息之后如果又有人出图，ComfyUI 会重新把模型读回显存 ——
    //   显存明显涨起来就说明它其实又活了，别让状态栏骗人。
    const nowUsed = st.gpu ? st.gpu.usedMiB : 0
    const thenUsed = num(saved.vramUsedMiB)
    if (nowUsed > thenUsed + VRAM_RELOAD_DELTA_MIB) return 'running'
    return 'idle'
  }
  return 'running'
}

async function getState(force = false) {
  const now = Date.now()
  if (!force && probeCache.data && now - probeCache.at < 3000) {
    return probeCache.data
  }
  const r = await runProbeRaw()
  if (!r.ok) {
    const fallback = {
      at: new Date().toISOString(),
      probeError: r.error,
      comfyui: { running: false, apiUp: false, pids: [], memMB: 0, endpoint: BASE, port: COMFY_PORT },
      gpu: null,
      checkpoints: [],
      bundles: [],
      ports: [],
      phase: 'unknown',
    }
    probeCache = { at: now, data: fallback }
    return fallback
  }
  const st = normalize(r.raw)
  st.phase = computePhase(st, loadState())
  probeCache = { at: now, data: st }
  return st
}

// ── ComfyUI 直连小工具 ────────────────────────────────────────
async function comfyUp(timeoutMs = 2500) {
  try {
    const r = await fetch(`${BASE}/system_stats`, { signal: AbortSignal.timeout(timeoutMs) })
    return r.ok
  } catch {
    return false
  }
}

// 静息：卸载模型 + 释放显存，但【进程留着】—— 这正是需求里那条
// 「不用了让模型处于静息状态，降低系统资源占用，不是关闭它，减少冷启动」。
async function comfyFree() {
  const body = JSON.stringify({ unload_models: true, free_memory: true })
  const tries = ['/free', '/api/free']
  let last = { ok: false, message: '没连上 ComfyUI' }
  for (const p of tries) {
    try {
      const r = await fetch(BASE + p, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(15000),
      })
      if (r.ok) return { ok: true, endpoint: p }
      last = { ok: false, message: `${p} 返回 HTTP ${r.status}` }
    } catch (e) {
      last = { ok: false, message: String(e?.message || e) }
    }
  }
  return last
}

function killTree(pid) {
  return new Promise((resolve) => {
    // ★ Windows 上杀掉 python 主进程不会带走它拉起的子进程 —— 必须 /T 连树一起杀
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 20000, windowsHide: true }, (err, so, se) =>
      resolve({ pid, ok: !err, out: (String(so || '') + String(se || '')).trim().slice(0, 300) }),
    )
  })
}

function portOwnerPids(port) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-Command',
        `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess`],
      { timeout: 20000, windowsHide: true },
      (e, so) => {
        const pids = String(so || '')
          .split(/\s+/)
          .map((s) => parseInt(s, 10))
          .filter((n) => Number.isFinite(n) && n > 0)
        resolve([...new Set(pids)])
      },
    )
  })
}

// ── 四个动作 ─────────────────────────────────────────────────
async function doStart() {
  if (await comfyUp()) {
    saveState({ phase: 'running', note: 'already' })
    probeCache = { at: 0, data: null }
    return { ok: true, action: 'start', already: true, message: 'ComfyUI 已经在跑' }
  }
  if (!COMFY_DIR) {
    return { ok: false, action: 'start',
      message: '未配置 ComfyUI 安装目录：请设 COMFYUI_DIR=<含 main.py 的目录>，改完重启 DSH' }
  }
  if (!COMFY_PY) {
    return { ok: false, action: 'start',
      message: '未配置 python：请设 COMFYUI_PY=<python.exe 完整路径>'
        + '（官方便携版通常是 <COMFYUI_DIR>/python_embeded/python.exe），改完重启 DSH' }
  }
  if (!existsSync(COMFY_PY)) return { ok: false, action: 'start', message: `找不到 python：${COMFY_PY}（检查 COMFYUI_PY 是否指对）` }
  if (!existsSync(join(COMFY_DIR, 'main.py'))) {
    return { ok: false, action: 'start', message: `找不到 main.py：${COMFY_DIR}（检查 COMFYUI_DIR 是否指对）` }
  }

  mkdirSync(LOG_DIR, { recursive: true })
  const logPath = join(LOG_DIR, `statusbar-comfy-${new Date().toISOString().slice(0, 10)}.log`)
  const fd = openSync(logPath, 'a')
  const banner = `\n===== dsh-agent-model-statusbar spawn ${new Date().toISOString()} =====\n`
  try { writeFileSync(logPath, banner, { flag: 'a' }) } catch { /* 日志写不进去也照常启动 */ }

  let spawned
  try {
    spawned = spawn(
      COMFY_PY,
      ['main.py', '--listen', '127.0.0.1', '--port', String(COMFY_PORT), '--disable-auto-launch'],
      {
        cwd: COMFY_DIR,
        // ★ detached + unref：连 DSH 重启都不带走它
        detached: true,
        // ★ 不 pipe：不读的管道写满之后会把子进程卡死。落盘到日志文件，起不来时能看原因。
        stdio: ['ignore', fd, fd],
        windowsHide: true,
      },
    )
  } catch (e) {
    try { closeSync(fd) } catch { /* ignore */ }
    return { ok: false, action: 'start', message: 'spawn 失败：' + String(e?.message || e) }
  }
  try { closeSync(fd) } catch { /* 子进程已经 dup 过了，父进程这份可以关 */ }

  child = spawned
  const startedAt = Date.now()
  spawned.on('exit', () => { if (child === spawned) child = null })
  spawned.on('error', () => { if (child === spawned) child = null })
  spawned.unref()

  // 等到就绪（需求文档实测约 36 秒），最多等 120 秒
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    if (await comfyUp(1500)) {
      const seconds = Math.round((Date.now() - startedAt) / 1000)
      saveState({ phase: 'running', startedPid: spawned.pid })
      probeCache = { at: 0, data: null }
      return { ok: true, action: 'start', pid: spawned.pid, seconds, logPath, message: `已就绪（${seconds} 秒）` }
    }
  }
  probeCache = { at: 0, data: null }
  return {
    ok: false,
    action: 'start',
    pid: spawned.pid,
    logPath,
    message: '启动了但 120 秒内没就绪 —— 去看日志：' + logPath,
  }
}

// ★ opts.auto 只有「空闲自动静息」会传，手动点按钮不传。
//   两条路径【共用这一个函数体】：同样是 comfyFree()（POST /free）+ saveState({phase:'idle'})，
//   自动那一次只是多记一笔「为什么放的」，好让事后查得到。
//   ★ 绝不能给自动路径另写一套 —— 那就成了「显存放了、phase 还写着 running」，
//     状态栏开始骗人（同一条道理见 computePhase 上面那条注释）。
async function doIdle(opts = {}) {
  if (!(await comfyUp())) {
    return { ok: false, action: 'idle', message: 'ComfyUI 没在跑，没东西可以静息' }
  }
  const before = await getState(true)
  const r = await comfyFree()
  await new Promise((x) => setTimeout(x, 2500)) // 等它真的把显存放掉再读一次
  probeCache = { at: 0, data: null }
  const after = await getState(true)
  if (!r.ok) {
    return { ok: false, action: 'idle', message: '静息请求失败：' + r.message, before: before.gpu, after: after.gpu }
  }
  const idleSeconds = Math.round(num(opts.idleMs) / 1000)
  saveState({
    phase: 'idle',
    vramUsedMiB: after.gpu ? after.gpu.usedMiB : 0,
    ...(opts.auto ? { autoIdleAt: new Date().toISOString(), autoIdleIdleSeconds: idleSeconds } : {}),
  })
  return {
    ok: true,
    action: 'idle',
    endpoint: r.endpoint,
    ...(opts.auto ? { auto: true, idleSeconds } : {}),
    message: opts.auto
      ? `空闲 ${Math.round(idleSeconds / 60)} 分钟，已自动静息：模型卸载、显存释放，进程留着`
      : '已静息：模型卸载、显存释放，进程留着（省掉约 36 秒冷启动）',
    vramBeforeMiB: before.gpu ? before.gpu.usedMiB : null,
    vramAfterMiB: after.gpu ? after.gpu.usedMiB : null,
  }
}

async function doStop() {
  const st = await getState(true)
  const pids = [...new Set([...(st.comfyui?.pids || []), ...(await portOwnerPids(COMFY_PORT))])]
  if (!pids.length) {
    saveState({ phase: 'stopped' })
    probeCache = { at: 0, data: null }
    return { ok: true, action: 'stop', message: '本来就没在跑', killed: [] }
  }
  const killed = []
  for (const p of pids) killed.push(await killTree(p))
  if (child && !child.killed) {
    try { await killTree(child.pid) } catch { /* 上面按 pid 杀过了，重复杀会失败，无所谓 */ }
    child = null
  }
  await new Promise((r) => setTimeout(r, 2000))
  probeCache = { at: 0, data: null }
  const stillUp = await comfyUp(2000)
  saveState({ phase: stillUp ? 'running' : 'stopped' })
  return {
    ok: !stillUp,
    action: 'stop',
    killed,
    message: stillUp ? '杀了但 8188 还有响应，可能又起来了' : '已关闭',
  }
}

async function doStatus() {
  const st = await getState(true)
  return {
    ok: !st.probeError,
    action: 'status',
    phase: st.phase,
    running: st.comfyui.running,
    apiUp: st.comfyui.apiUp,
    pids: st.comfyui.pids,
    memMB: st.comfyui.memMB,
    endpoint: st.comfyui.endpoint,
    gpu: st.gpu ?? {},
    checkpoints: st.checkpoints,
    bundles: st.bundles,
    ports: st.ports,
    // ★ 空闲自动静息的现状（阈值 / 上次活动 / 上次为什么没触发）。
    //   放进 status 是因为它平时只在后台悄悄发生 —— 得有一条路能查「它到底有没有在工作」。
    autoIdle: idleAutoPublic(),
    ...(st.probeError ? { probeError: st.probeError } : {}),
  }
}

// ── 空闲自动静息 ─────────────────────────────────────────────
// 需求（需求）：「十分钟没有任何出图动作就自动放掉显存，
// 你下次出图时它自己读回来（多花三十几秒）」。
//
// ★★「空闲」必须有依据，不能靠计时器拍脑袋。三条证据，缺一不可：
//   1. GET /queue   → queue_running + queue_pending 都为 0 —— 现在没活干、也没排队
//   2. GET /history → 所有 execution_* 的 timestamp 取最大值 —— 最后一次「出图动作」发生在何时
//   3. 状态文件的 phase（+ 显存有没有涨回来）—— 已经卸过了就别再卸一次
//   ★ 实测口径：/history 的时间戳是【毫秒】；它的 key 顺序不保证（不按时间排），
//     所以取 max，不取第一条。显存用 /system_stats 的 vram_total - vram_free，不跑 nvidia-smi。
//
// ★★ 四种情况【不许触发】，一条一条挡在前面：
//   a. ComfyUI 没在跑（/system_stats 不通）—— 没东西可以放
//   b. 已经是 idle —— 重复 /free 没意义，还会把「上次静息时的显存」基线冲掉
//   c. 队列里有 running 或 pending —— 正在出图，静息会把这一次拖慢甚至弄坏
//   d. 距上次活动不足 IDLE_AUTO_MS —— 阈值没到，不许抢跑
//
// ★ 这里【故意不调 getState()】：那会每分钟跑一次 probe.ps1（里面还有 Test-NetConnection），
//   太贵。空闲判定全走 ComfyUI 自己的 HTTP 接口，轻。
let idleAuto = {
  busy: false,          // 防重入（tick 里要 await 好几个 HTTP）
  lastActivityAt: 0,    // 毫秒时间戳；0 = 还没有基准
  lastCheckAt: '',
  lastAutoIdleAt: 0,
  lastSkip: '还没查过',
}

// 队列空不空 —— 「正在出图」最直接的证据
async function comfyQueueState(timeoutMs = 3000) {
  try {
    const r = await fetch(`${BASE}/queue`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!r.ok) return { ok: false, message: `HTTP ${r.status}` }
    const j = await r.json()
    return { ok: true, running: arr(j?.queue_running).length, pending: arr(j?.queue_pending).length }
  } catch (e) {
    return { ok: false, message: String(e?.message || e) }
  }
}

// 最后一次「出图动作」发生在什么时候（毫秒）。0 = 拿不到 / 一条历史都没有。
async function comfyLastActivityAt(timeoutMs = 5000) {
  try {
    const r = await fetch(`${BASE}/history?max_items=20`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!r.ok) return 0
    const j = await r.json()
    let last = 0
    for (const id of Object.keys(j || {})) {
      for (const m of arr(j[id]?.status?.messages)) {
        const t = num(m?.[1]?.timestamp)
        if (t > last) last = t
      }
    }
    return last
  } catch {
    return 0
  }
}

// ComfyUI 自己报的显存占用（MiB）—— 不跑 nvidia-smi。返回 -1 = 拿不到。
async function comfyVramUsedMiB(timeoutMs = 3000) {
  try {
    const r = await fetch(`${BASE}/system_stats`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!r.ok) return -1
    const j = await r.json()
    const d = arr(j?.devices)[0]
    const total = num(d?.vram_total)
    if (!total) return -1
    return Math.round((total - num(d?.vram_free)) / (1024 * 1024))
  } catch {
    return -1
  }
}

// 状态文件说 idle、显存也没涨回来 ⇒ 现在确实是 idle。
// ★ 和 computePhase() 用同一个判据、同一个 VRAM_RELOAD_DELTA_MIB。
function isStillIdle(saved, usedMiB) {
  if (!saved || saved.phase !== 'idle') return false
  if (usedMiB < 0) return true // 拿不到显存就信状态文件
  return !(usedMiB > num(saved.vramUsedMiB) + VRAM_RELOAD_DELTA_MIB)
}

function idleAutoPublic() {
  const now = Date.now()
  return {
    enabled: IDLE_AUTO_ON,
    thresholdMinutes: Math.round(IDLE_AUTO_MS / 60000),
    tickSeconds: Math.round(IDLE_AUTO_TICK_MS / 1000),
    lastActivityAt: idleAuto.lastActivityAt ? new Date(idleAuto.lastActivityAt).toISOString() : '',
    idleSeconds: idleAuto.lastActivityAt ? Math.round((now - idleAuto.lastActivityAt) / 1000) : -1,
    lastCheckAt: idleAuto.lastCheckAt || '',
    lastAutoIdleAt: idleAuto.lastAutoIdleAt ? new Date(idleAuto.lastAutoIdleAt).toISOString() : '',
    lastSkip: idleAuto.lastSkip || '',
  }
}

async function idleAutoTick() {
  if (!IDLE_AUTO_ON || idleAuto.busy) return
  idleAuto.busy = true
  try {
    idleAuto.lastCheckAt = new Date().toISOString()

    // a. 没在跑 —— 没东西可以放。基准清零，等它起来重新计。
    if (!(await comfyUp(2500))) {
      idleAuto.lastActivityAt = 0
      idleAuto.lastSkip = 'a：ComfyUI 没在跑'
      return
    }

    // c. 队列里有活 —— 那本身就是「出图动作」，把基准推到此刻。
    const q = await comfyQueueState()
    if (q.ok && (q.running > 0 || q.pending > 0)) {
      idleAuto.lastActivityAt = Date.now()
      idleAuto.lastSkip = `c：队列里还有活（running ${q.running} / pending ${q.pending}）`
      return
    }

    // b. 已经是 idle —— 不用再静息一次。
    const used = await comfyVramUsedMiB()
    if (isStillIdle(loadState(), used)) {
      idleAuto.lastSkip = `b：已经是 idle（显存 ${used} MiB）`
      return
    }

    // 基准 = /history 里最后一次执行的 timestamp。★ 这是「出图动作」的直接证据。
    const lastAct = await comfyLastActivityAt()
    if (lastAct > idleAuto.lastActivityAt) idleAuto.lastActivityAt = lastAct
    if (!idleAuto.lastActivityAt) {
      // /history 一条都没有（进程起来后还没出过图）—— 以「第一次看见它」为基准。
      // 这是我们能拿到的最早证据，比凭空给个 now - 10min 诚实。
      idleAuto.lastActivityAt = Date.now()
      idleAuto.lastSkip = '还没有出图记录，以此刻为基准'
      return
    }

    // d. 阈值
    const idleMs = Date.now() - idleAuto.lastActivityAt
    if (idleMs < IDLE_AUTO_MS) {
      idleAuto.lastSkip = `d：距上次活动 ${Math.round(idleMs / 1000)} 秒 < ${Math.round(IDLE_AUTO_MS / 1000)} 秒`
      return
    }

    // ★ 四条全过 —— 走【和手动 idle 同一条路径】
    const r = await doIdle({ auto: true, idleMs })
    if (r.ok) {
      idleAuto.lastAutoIdleAt = Date.now()
      // 静息本身也算一次动作：从这儿重新计，免得紧接着又触发一轮
      idleAuto.lastActivityAt = Date.now()
      idleAuto.lastSkip = ''
    } else {
      idleAuto.lastSkip = '自动静息失败：' + (r.message || '')
    }
  } catch (e) {
    idleAuto.lastSkip = '查空闲时出错：' + String(e?.message || e)
  } finally {
    idleAuto.busy = false
  }
}

function startIdleAuto() {
  if (!IDLE_AUTO_ON) return null
  const t = setInterval(() => { idleAutoTick() }, IDLE_AUTO_TICK_MS)
  // ★ unref：这个定时器不该拖住进程退出（selftest 里尤其明显）
  if (typeof t.unref === 'function') t.unref()
  return t
}

async function act(action) {
  if (action === 'start') return doStart()
  if (action === 'idle') return doIdle()
  if (action === 'stop') return doStop()
  return doStatus()
}

// ── HTTP 小工具 ──────────────────────────────────────────────
function json(res, code, body) {
  const s = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(s)
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0
    const chunks = []
    req.on('data', (c) => {
      n += c.length
      if (n > limit) { reject(new Error('body 太大')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8')
      if (!s) return resolve({})
      try { resolve(JSON.parse(s)) } catch { reject(new Error('body 不是合法 JSON')) }
    })
    req.on('error', reject)
  })
}

// ── 插件主体 ─────────────────────────────────────────────────
export function apply(ctx) {
  const route = ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: async (req, res) => {
      // 这里只是解析本插件的请求路径，和 ComfyUI 地址无关 —— 别拿 COMFY_PORT 当 URL 基
      const url = new URL(req.url, 'http://127.0.0.1')
      const p = url.pathname.replace(/^\/model-statusbar/, '') || '/'
      try {
        // 状态栏开局只要这一个请求
        if (p === '/api/state' || p === '/') {
          const st = await getState(false)
          // autoIdle 不跟着 probe 缓存走 —— 它每次都要是新的（要能看出自动静息在不在工作）
          return json(res, 200, { ok: !st.probeError, ...st, autoIdle: idleAutoPublic() })
        }
        if (p === '/api/action' && req.method === 'POST') {
          const body = await readBody(req)
          const action = String(body?.action || 'status')
          if (!['status', 'start', 'idle', 'stop'].includes(action)) {
            return json(res, 400, { ok: false, message: '不认识的 action：' + action })
          }
          return json(res, 200, await act(action))
        }
        // 诊断入口：原始 probe 输出，不归一化
        if (p === '/api/probe-raw') {
          const r = await runProbeRaw()
          return json(res, 200, r)
        }
        return json(res, 404, { ok: false, message: '没有这个路由：' + p })
      } catch (err) {
        return json(res, 500, { ok: false, message: String(err?.message || err) })
      }
    },
  })
  ctx.effect(() => route, 'dsh-agent-model-statusbar: routes')

  // 空闲自动静息：挂一个常驻定时器（判据与四种「不许触发」见 idleAutoTick 上面的长注释）
  ctx.effect(() => {
    const t = startIdleAuto()
    return () => { if (t) clearInterval(t) }
  }, 'dsh-agent-model-statusbar: idle-auto')

  // Agent 也能按回合调用 —— 需求里那条「可以按照回合调用」落在这里
  ctx.tools.register({
    name: 'local_model_control',
    description:
      '控制本机「本地模型」（ComfyUI @8188）的电源状态。' +
      'action: status 看状态 / start 拉起（等就绪，约 36 秒）/ idle 静息（卸载模型释放显存但保留进程，省掉冷启动）/ stop 真关闭。' +
      '规则：用完就 idle，不要留 running 白占显存；只有确实不再需要时才 stop。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'start', 'idle', 'stop'], description: '要做什么' },
      },
      required: ['action'],
    },
    // ★ dsh-tools 强制每个 tool 声明 output{schema,render}。漏了会在加载期抛
    //   `tool "x" must declare output {...}` → plugin tree 加载失败 → DSH 整体退出（3080 无监听）。
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          phase: { type: 'string' },
          running: { type: 'boolean' },
          apiUp: { type: 'boolean' },
          already: { type: 'boolean' },
          pids: { type: 'array', items: { type: 'number' } },
          memMB: { type: 'number' },
          endpoint: { type: 'string' },
          message: { type: 'string' },
          probeError: { type: 'string' },
          seconds: { type: 'number' },
          logPath: { type: 'string' },
          vramBeforeMiB: { type: 'number' },
          vramAfterMiB: { type: 'number' },
          // ★ 声明成 object 的字段，返回值给 null 会被 DSH 拒：
          //   `"value.gpu" must be an object`（注册期和 execute 跑通都查不出，只有被调用时才炸）。
          //   所以 doStatus() 里用 `st.gpu ?? {}` 兜住。
          gpu: { type: 'object', additionalProperties: true },
          checkpoints: { type: 'array', items: { type: 'object', additionalProperties: true } },
          // 组合模型（三件套）—— 和 checkpoints 是两组东西，前端分开显示
          bundles: { type: 'array', items: { type: 'object', additionalProperties: true } },
          ports: { type: 'array', items: { type: 'object', additionalProperties: true } },
          // ★ 空闲自动静息的现状。声明成 object 就【绝不能给 null】（同上面 gpu 那条坑）——
          //   idleAutoPublic() 永远返回对象，字段全是 string / number / boolean，没有 null。
          autoIdle: { type: 'object', additionalProperties: true },
        },
      },
      // ★ render 必须返回 ContentBlock[]，不是 string
      render: (_args, value) => [
        { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
      ],
    },
    // ★ 方法名是 execute，不是 handler（写 handler 能注册成功但永远调不动）
    execute: async ({ action }) => await act(action),
  })
}
