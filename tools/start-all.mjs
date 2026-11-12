// start-all.mjs —— 一键起全链路（网关 → 等端口 → core）
// ============================================================================
// ★ 为什么不用 .cmd：
//   上一版 .cmd 里用 start "" /D "带空格的路径" program，实测**起不来**——
//   start 的 /d 参数对含空格路径不可靠，而我们的路径就是 deepseek harness/agent soul。
//   更糟的是它**先 taskkill 再 start**，start 失败时环境就全空了。
//
// ★ 改成 node：
//   spawn 的 cwd 参数是干净的（不是 shell 字符串），detached + unref 让它活过本进程。
//   而且失败时能打清楚哪一步没起来。
//
// ★ 顺序不能乱：网关先，等四个端口都通，再起 core（core 启动时就要连网关）。
// ============================================================================
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'

const SLROOT = 'D:/AI/SnowLuma'
const SOULROOT = 'C:/Users/pc/Desktop/deepseek harness/agent soul'
const PORTS = [3000, 3001, 3002, 3003]
const log = (m) => console.log(m)

function portOpen (port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = new net.Socket()
    let done = false
    const finish = (v) => { if (done) return; done = true; try { sock.destroy() } catch (e) {} resolve(v) }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
    sock.connect(port, '127.0.0.1')
  })
}

async function waitPorts (ms = 60000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const states = await Promise.all(PORTS.map((p) => portOpen(p)))
    if (states.every(Boolean)) return true
    await new Promise((r) => setTimeout(r, 2000))
  }
  return false
}

/** 起一个分离进程；失败返回 null（不抛）。 */
function launch (cmd, args, cwd, name, env) {
  try {
    const child = spawn(cmd, args, { cwd, detached: true, stdio: 'ignore', windowsHide: true, env: env || process.env })
    child.unref()
    log('  ✓ ' + name + ' 已拉起（pid ' + child.pid + '）')
    return child.pid
  } catch (e) {
    log('  ✗ ' + name + ' 起不来：' + String((e && e.message) || e))
    return null
  }
}

function killByName (name) {
  try { spawnSync('taskkill', ['/IM', name, '/F'], { stdio: 'ignore', windowsHide: true }) } catch (e) {}
}

// ---------- ① 网关 ----------
log('[1/3] 起网关 SnowLuma...')
try {
  spawnSync('powershell', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*SnowLuma*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
  ], { stdio: 'ignore', windowsHide: true })
} catch (e) {}
await new Promise((r) => setTimeout(r, 1500))
const gw = launch(path.join(SLROOT, 'node.exe'), ['./index.mjs'], SLROOT, 'SnowLuma')
if (!gw) { log('网关起不来，停。'); process.exit(1) }

// ---------- ② 等端口 ----------
log('[2/3] 等 ' + PORTS.join('/') + ' 四个端口（最多 60 秒）...')
const okPorts = await waitPorts(60000)
if (!okPorts) {
  const states = await Promise.all(PORTS.map((p) => portOpen(p)))
  log('  ✗ 端口没全起来：' + PORTS.map((p, i) => p + '=' + (states[i] ? '通' : '断')).join(' '))
  log('  → 去看 D:/AI/SnowLuma/snowluma-run-*.log，可能是登录失败')
  process.exit(1)
}
log('  ✓ 四个端口都在')

// ---------- ③ core ----------
log('[3/3] 起 AgentSoul core（听砚青号 3003）...')
let token = ''
try {
  const j = JSON.parse(fs.readFileSync(path.join(SLROOT, 'config/onebot_3937956599.json'), 'utf8'))
  token = String(j.networks.wsServers[0].accessToken || '')
} catch (e) {
  log('  ✗ 读不到 token：' + String((e && e.message) || e))
  process.exit(1)
}
if (!token) { log('  ✗ token 是空的'); process.exit(1) }
log('  token 已读（' + token.length + ' 字符，不打印）')

killByName('AgentSoul.exe')
await new Promise((r) => setTimeout(r, 2000))
// ★ 环境变量必须在 spawn 之前塞进 env —— core 启动时就要读它去连网关。
// ★★ 2026-11-12：AURABOT_NO_CONNECT —— **v4 侧的 aurabot 不许连 QQ。**
//
//   整个 aurabot 插件已经搬进 v4 了（src/aurabot/，87 文件一行没改），
//   而它的源码里 watchdog 每 30 秒会调一次 `onebot.start()`：
//     host.js:381  if (onebot.state === 'stopped') onebot.start()
//   两边读的是**同一份 config.json** —— 改配置拦不住，只能在代码里拦。
//   所以 host.js 那两行加了 `&& !process.env.AURABOT_NO_CONNECT`，这里负责设上。
//
//   ★ 为什么是环境变量而不是改默认值：**DSH 侧不受影响**（它不设这个变量）。
//     这样 QQ 连接仍然只有一处 —— 双发不会回来。
const childEnv = { ...process.env, SOUL_ONEBOT_WS_TOKEN: token }
const core = launch(path.join(SOULROOT, 'AgentSoul.exe'), [], SOULROOT, 'AgentSoul core', childEnv)
if (!core) { log('core 起不来，停。'); process.exit(1) }

log('')
log('起来了。等约 30 秒让它连上网关，然后验：')
log('  node tools/verify-after-restart.mjs')
