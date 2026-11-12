// 真 core 的生命周期验收（**不重启 DSH、不连真实 QQ**）
// ============================================================================
// 为什么必须起真进程：原型被验收判 FAIL 的四条里，有两条只有真 lifecycle 能答 ——
//   · 「装它要重启 DSH」→ 现在它是 core 的一部分，只随着 core 起停；
//   · 「DSH 进程写账」→ 现在写账的是 core 进程自己，且 shutdown 会先停接入。
// 所以这里 spawn node src/index.mjs（隔离的 AGENT_SOUL_HOME + 临时 data），
// 用真 HTTP 读状态、用真 POST /api/shutdown 走优雅退出，再用 mock 网关看连接有没有真的断。
//
// 两个场景：
//   ① direct-ws 起 → 收到事件 → /api/shutdown → 退出后连接断了、账不再增长、shutdown.log graceful:true
//   ② AGENT_SOUL_READONLY=1 起 → 事件目录**一个都没创建**、不连、状态是 readonly
//
// ★ 所有临时目录在 finally 里删（原型遗留：acceptance 不清理 tmp）。
// ============================================================================

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { startMock } from './events-mock-onebot.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor (fn, ms = 8000, step = 50) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try { if (await fn()) return true } catch { /* 还没好 */ }
    await sleep(step)
  }
  return false
}
function pickPort () { return 18000 + Math.floor(Math.random() * 1500) }

async function readJson (url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(4000) })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: r.status, json, text }
}

function countLines (file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '').length } catch { return 0 }
}

async function runCore ({ tmp, port, env, config }) {
  fs.mkdirSync(tmp, { recursive: true })
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(config, null, 2), 'utf8')
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'index.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      AGENT_SOUL_HOME: tmp,
      AGENT_SOUL_PORT: String(port),
      AGENT_SOUL_DATA: path.join(tmp, 'data'),
      AGENT_SOUL_SYNC: 'off',
      AGENT_SOUL_CHAT: 'off',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const rec = { child, out: '', exited: null, code: null }
  child.stdout.on('data', (d) => { rec.out += d.toString('utf8') })
  child.stderr.on('data', (d) => { rec.out += d.toString('utf8') })
  const done = new Promise((resolve) => {
    child.on('exit', (code) => { rec.exited = true; rec.code = code; resolve(code) })
  })
  rec.done = done
  rec.alive = () => rec.exited !== true
  return rec
}

async function shutdownCore (port, rec, ms = 20000) {
  let code = 202
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/api/shutdown', { method: 'POST', signal: AbortSignal.timeout(4000) })
    code = r.status
    await r.text()
  } catch { code = -1 }
  const exited = await Promise.race([rec.done, sleep(ms).then(() => 'timeout')])
  if (exited === 'timeout') { try { rec.child.kill('SIGKILL') } catch { /* ignore */ } }
  return { httpCode: code, exited }
}

function lastShutdownLine (dataDir) {
  try {
    const raw = fs.readFileSync(path.join(dataDir, 'shutdown.log'), 'utf8').trim().split('\n')
    return JSON.parse(raw[raw.length - 1])
  } catch { return null }
}

/**
 * @param {(name:string, cond:boolean, extra?:string)=>void} ok
 */
export async function lifecycleChecks (ok) {
  const dirs = []
  const mocks = []
  const procs = []
  try {
    // ── 场景 ①：direct-ws → 事件入账 → /api/shutdown ─────────────────────
    {
      const TOKEN = 'SENTINEL-TOKEN-' + randomBytes(8).toString('hex')
      const mock = await startMock({ selfId: '10001', token: TOKEN })
      mocks.push(mock)
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'core-events-life-'))
      dirs.push(tmp)
      const port = pickPort()
      const dataDir = path.join(tmp, 'data')
      const config = {
        port,
        host: '127.0.0.1',
        quiet: true,
        dataDir,
        statusDir: path.join(tmp, 'status'),
        sync: { enabled: false },
        chat: { enabled: false },
        autonomy: { enabled: false },
        events: {
          intervalMs: 600000,
          silenceMs: 3600000,
          ingress: {
            mode: 'direct-ws',
            onebot: {
              wsUrl: mock.wsUrl,
              tokenEnv: 'MOCK_OB_TOKEN',
              allow: { all: false, chats: ['group:661580035'], private: [] },
              maxReconnect: 2,
              backoffMs: [100, 200],
            },
          },
        },
      }
      const rec = await runCore({ tmp, port, env: { MOCK_OB_TOKEN: TOKEN }, config })
      procs.push(rec)
      const up = await waitFor(async () => (await readJson('http://127.0.0.1:' + port + '/api/health')).status === 200, 40000)
      ok('core 起来了（/api/health 200）', up, up ? '' : rec.out.slice(-400))
      ok('start 日志里写了事件接入与写者身份', /事件接入 direct-ws/.test(rec.out) && /唯一写者/.test(rec.out), (rec.out.match(/事件接入[^\n]*/) || [''])[0])

      const connected = await waitFor(() => mock.connections() === 1, 8000)
      ok('连接由 core 自己建立（mock 侧 1 条连接）', connected, 'connections=' + mock.connections())

      const st0 = await readJson('http://127.0.0.1:' + port + '/api/events')
      const ing0 = st0.json && st0.json.ingress
      ok('GET /api/events 带 ingress 段且 ready', st0.status === 200 && ing0 && ing0.summary === 'ready' && ing0.ready === true, ing0 && ing0.summary)
      ok('状态六件齐（enabled/connected/lastEventAt/lastError/dedupCount/lastSource）',
        ing0 && ['enabled', 'connected', 'lastEventAt', 'lastError', 'dedupCount', 'lastSource'].every((k) => k in ing0),
        ing0 ? Object.keys(ing0).slice(0, 16).join(',') : 'no-ingress')
      ok('authority.soleWriter = agent-soul-core，目录在 dataDir/events',
        ing0 && ing0.authority && ing0.authority.soleWriter === 'agent-soul-core' && ing0.authority.dir === path.join(dataDir, 'events'),
        ing0 && ing0.authority ? ing0.authority.dir : '')

      mock.push({ message_type: 'group', group_id: 661580035, user_id: 20001, message_id: 7001, message: [{ type: 'text', data: { text: 'lifecycle' } }] })
      const ledger = path.join(dataDir, 'events', 'envelopes.jsonl')
      const wrote = await waitFor(() => countLines(ledger) >= 1, 8000)
      ok('事件落进 <dataDir>/events/envelopes.jsonl', wrote, 'lines=' + countLines(ledger))
      const st1 = await readJson('http://127.0.0.1:' + port + '/api/events?limit=5')
      ok('读口能给最近元数据（不含 payload 原文）',
        st1.json && st1.json.ingress && st1.json.ingress.events && st1.json.ingress.events.items.length >= 1 &&
        !JSON.stringify(st1.json).includes('lifecycle'),
        st1.json && st1.json.ingress ? 'n=' + st1.json.ingress.events.items.length : '')
      ok('账里那份有 payload 原文（权威仍是文件）',
        fs.existsSync(ledger) && fs.readFileSync(ledger, 'utf8').includes('lifecycle'), '')

      const before = countLines(ledger)
      const sd = await shutdownCore(port, rec)
      ok('POST /api/shutdown 回 202 并真的退出', sd.httpCode === 202 && sd.exited === 0, 'http=' + sd.httpCode + ' exit=' + sd.exited)
      const sh = lastShutdownLine(dataDir)
      ok('shutdown.log 记 graceful:true', Boolean(sh && sh.graceful === true), sh ? JSON.stringify({ graceful: sh.graceful, reason: sh.reason, ms: sh.ms }) : 'no-log')
      ok('shutdown 之后连接真的断了（mock 侧 closedCount > 0 / 0 连接）',
        mock.closedCount > 0 && mock.connections() === 0, 'closed=' + mock.closedCount + ' conn=' + mock.connections())
      await sleep(600)
      ok('退出后账不再增长（先停接入，再 closeAll）', countLines(ledger) === before, before + ' → ' + countLines(ledger))
      const stFile = path.join(dataDir, 'events', 'status.json')
      let snap = null
      try { snap = JSON.parse(fs.readFileSync(stFile, 'utf8')).status } catch { /* ignore */ }
      ok('最后一口气写进了 status.json（离线读手能读）', Boolean(snap && snap.stopped && snap.stopped.reason === 'shutdown'), snap ? JSON.stringify(snap.stopped) : 'no-snapshot')
      ok('收事件全程 0 帧上行 / 0 次 send_*', mock.framesFromClient === 0 && mock.sends().length === 0, 'framesOut=' + mock.framesFromClient + ' sends=' + mock.sends().length)
    }

    // ── 场景 ②：readonly → 不建目录、不连、状态 readonly ──────────────────
    {
      const mock = await startMock({ selfId: '10001', token: 'readonly-token' })
      mocks.push(mock)
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'core-events-ro-'))
      dirs.push(tmp)
      const port = pickPort()
      const dataDir = path.join(tmp, 'data')
      const rec = await runCore({
        tmp,
        port,
        env: { AGENT_SOUL_READONLY: '1' },
        config: {
          port,
          host: '127.0.0.1',
          quiet: true,
          dataDir,
          statusDir: path.join(tmp, 'status'),
          sync: { enabled: false },
          chat: { enabled: false },
          autonomy: { enabled: false },
          events: { intervalMs: 600000, silenceMs: 3600000, ingress: { mode: 'direct-ws', onebot: { wsUrl: mock.wsUrl, allow: { all: true, chats: [], private: [] } } } },
        },
      })
      procs.push(rec)
      const up = await waitFor(async () => (await readJson('http://127.0.0.1:' + port + '/api/health')).status === 200, 40000)
      ok('readonly 下 core 仍然在线（只读不是离线）', up, up ? '' : rec.out.slice(-400))
      ok('★ readonly 不创建事件目录', !fs.existsSync(path.join(dataDir, 'events')), path.join(dataDir, 'events'))
      ok('readonly 不连网关（mock 侧 0 连接）', mock.connections() === 0, 'conn=' + mock.connections())
      const st = await readJson('http://127.0.0.1:' + port + '/api/events')
      const ing = st.json && st.json.ingress
      ok('readonly 状态：summary=readonly / ready=false / 说明理由',
        Boolean(ing && ing.summary === 'readonly' && ing.ready === false && /拒写/.test(ing.reason)),
        ing ? ing.summary : '')
      ok('readonly 的 startRefusal 明确是 READONLY', Boolean(ing && ing.startRefusal && ing.startRefusal.code === 'READONLY'), ing && ing.startRefusal ? ing.startRefusal.code : '')
      const sd = await shutdownCore(port, rec)
      ok('readonly 下也能优雅退出', sd.httpCode === 202 && sd.exited === 0, 'http=' + sd.httpCode + ' exit=' + sd.exited)
      ok('readonly 退出后事件目录仍然不存在（一个字节都没写）', !fs.existsSync(path.join(dataDir, 'events')), '')
    }
  } finally {
    // ★ 原型遗留：acceptance 不清理 tmp —— 这里一律收干净
    for (const rec of procs) { try { if (rec.alive && rec.alive()) rec.child.kill('SIGKILL') } catch { /* ignore */ } }
    for (const m of mocks) { try { await m.close() } catch { /* ignore */ } }
    for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }
  }
}
