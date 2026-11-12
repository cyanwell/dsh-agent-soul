// SnowLuma 管理：检测主人装好的副本、在后台（不弹窗）启停它、读它的 OneBot 配置、只给机器人号注入。
//
// ⚠ SnowLuma 的 EULA 第 5.4 条：把它「并入第三方安装包或通过自动化脚本部署」需要作者书面授权。
//   所以这里**不下载、不解压、不替主人同意协议**——只管理主人自己下载解压、并在 WebUI 里同意过协议的那一份。
// ⚠ 永远不开 hookAutoLoad；注入前按 /api/processes 返回的 account.uin 核对，只注入机器人号。

import { spawn, execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import net from 'node:net'
import { registerSecret } from '../core/redact.js'

export const DOWNLOAD_PAGE = 'https://github.com/SnowLuma/SnowLuma/releases/latest'

function readJsonSafe(file) {
  try {
    let t = readFileSync(file, 'utf8')
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1)
    return JSON.parse(t)
  } catch (error) {
    return null
  }
}

/** 主人装好的 SnowLuma 在不在、是什么版本。 */
export function detectInstall(dir) {
  const d = String(dir || '').trim()
  if (!d) return { installed: false, reason: '还没填 SnowLuma 目录' }
  if (/[^\x00-\x7f]/.test(d)) return { installed: false, reason: '目录里有中文，请换成纯英文路径（例如 C:\\Aurabot\\snowluma）' }
  const entry = join(d, 'index.mjs')
  if (!existsSync(entry)) return { installed: false, reason: `在 ${d} 里没找到 index.mjs，请确认解压位置` }
  const nodeExe = join(d, 'node.exe')
  const release = readJsonSafe(join(d, 'release.json')) || {}
  return {
    installed: true,
    dir: d,
    entry,
    nodeExe: existsSync(nodeExe) ? nodeExe : '',
    version: release.version || readJsonSafe(join(d, 'package.json'))?.version || '?',
  }
}

/**
 * 从 SnowLuma 的配置里读出机器人号的 OneBot HTTP / WS 地址和 token。
 * onebot_<uin>.json 是单号覆盖；mode=snapshot 时不叠全局。
 */
export function readOneBotEndpoint(dir, uin) {
  const cfgDir = join(dir, 'config')
  const global = readJsonSafe(join(cfgDir, 'onebot.json'))
  const per = readJsonSafe(join(cfgDir, `onebot_${uin}.json`))
  const sources = per?.mode === 'snapshot' ? [per] : [global, per].filter(Boolean)
  let http = null
  let ws = null
  for (const s of sources) {
    const nets = s?.networks || {}
    const h = (nets.httpServers || []).find((x) => x && x.enable !== false) || (nets.httpServers || [])[0]
    const w = (nets.wsServers || []).find((x) => x && x.enable !== false) || (nets.wsServers || [])[0]
    if (h) http = h
    if (w) ws = w
  }
  const host = (h) => (!h || h === '0.0.0.0' || h === '::' ? '127.0.0.1' : h)
  const out = {
    httpUrl: http ? `http://${host(http.host)}:${http.port}${http.path && http.path !== '/' ? http.path : ''}` : '',
    httpToken: http?.accessToken || '',
    wsUrl: ws ? `ws://${host(ws.host)}:${ws.port}${ws.path && ws.path !== '/' ? ws.path : ''}` : '',
    wsToken: ws?.accessToken || '',
    found: Boolean(http || ws),
  }
  registerSecret(out.httpToken)
  registerSecret(out.wsToken)
  return out
}

/** 从 httpUrl 里拆出 host / port（探端口用）。 */
export function endpointHostPort(url) {
  try {
    const u = new URL(String(url || ''))
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80))
    return u.hostname && port ? { host: u.hostname, port } : null
  } catch (error) {
    return null
  }
}

/** 这个端口现在能不能连上（能连 = 有人在监听）。 */
export function portOpen({ host, port }, { timeoutMs = 800 } = {}) {
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (done) return; done = true; try { sock.destroy() } catch (error) {} ; resolve(v) }
    const sock = net.connect({ host, port })
    sock.setTimeout(timeoutMs, () => finish(false))
    sock.once('connect', () => finish(true))
    sock.once('error', () => finish(false))
  })
}

/**
 * 网关现在是不是活着（不是"端口有人听"，而是真的能回 OneBot 请求）。
 * 用于判断「已有 SnowLuma 实例可以复用」。
 */
export async function gatewayHealthy(endpoint, { fetchImpl = fetch, timeoutMs = 1500 } = {}) {
  if (!endpoint || !endpoint.httpUrl) return false
  try {
    const headers = { 'content-type': 'application/json' }
    if (endpoint.httpToken) headers.authorization = `Bearer ${endpoint.httpToken}`
    const r = await fetchImpl(`${endpoint.httpUrl.replace(/\/+$/, '')}/get_login_info`, {
      method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(timeoutMs),
    })
    const j = await r.json().catch(() => null)
    return Boolean(j && (j.status === 'ok' || j.retcode === 0))
  } catch (error) {
    return false
  }
}

/** 等端口释放（上一个 SnowLuma 还在退出）。返回 true = 已释放。 */
export async function waitPortFree(hostPort, { timeoutMs = 20000, intervalMs = 500, isOpen = portOpen } = {}) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, intervalMs))
    if (!(await isOpen(hostPort))) return true
  }
  return !(await isOpen(hostPort))
}

// SnowLuma 认不出号时 uin 可能是 null、'' 或 '0'（注入后才会有真号），都当「认不出」
const uinOf = (p) => {
  const u = String(p?.account?.uin ?? p?.uin ?? '').trim()
  return u === '0' ? '' : u
}

/**
 * 只挑机器人号所在的那个 QQ 进程。识别不出来就返回 null（宁可不注入）。
 *
 * 有的机器上 SnowLuma 的进程列表认不出登录的号（account: null）。这时如果**只有一个**认不出号的 QQ 进程，
 * 就把它当候选返回，并标 `unverified: true`：注入后必须用 OneBot 的 get_login_info 核对是不是机器人号，
 * 不是就撤销、断开（见 host.js 的核对）。已经认出是别的号的进程永远不碰；核对失败过的进程（exclude）也不再试。
 */
export function pickBotProcess(list, botUin, { exclude = [] } = {}) {
  const bot = String(botUin)
  const all = list || []
  const mine = all.filter((p) => uinOf(p) === bot)
  if (mine.length > 1) return { proc: null, reason: '有多个进程声称是机器人号，为安全起见不注入' }
  if (mine.length === 1) return { proc: mine[0], reason: '' }
  const skip = new Set(exclude.map(Number))
  const unknown = all.filter((p) => !uinOf(p) && !skip.has(Number(p?.pid)))
  if (unknown.length === 1) return { proc: unknown[0], reason: '', unverified: true }
  if (unknown.length > 1) return { proc: null, reason: 'SnowLuma 认不出这几个 QQ 进程登录的是哪个号，为安全起见不注入。只开着机器人号那个 QQ 再点一次「接入机器人号」' }
  return { proc: null, reason: '没找到登录机器人号的 QQ 进程' }
}

/** SnowLuma 控制台密码的强度要求（和它自己的规则一致）。返回没满足的那几条，空数组 = 合格。 */
export function passwordProblems(pw) {
  const p = String(pw || '')
  return [
    [p.length >= 10, '至少 10 位'],
    [/[a-z]/.test(p), '要有小写字母'],
    [/[A-Z]/.test(p), '要有大写字母'],
    [/[^A-Za-z0-9\s]/.test(p), '要有符号（比如 ! @ #）'],
    [!/\s/.test(p), '不能有空格'],
  ].filter(([ok]) => !ok).map(([, why]) => why)
}

/** 生成满足 SnowLuma 规则的强密码：≥10 位、有大小写和符号、无空格。 */
export function generatePassword() {
  const b = randomBytes(18).toString('base64url').replace(/[-_]/g, '')
  return `Ab${b.slice(0, 16)}#9!`
}

export function createSnowLumaManager({ getConfig, log, savePassword }) {
  let child = null
  let childPid = 0
  let token = ''
  let tokenAt = 0
  let tokenPw = ''
  let lastAttach = { at: 0, ok: false, message: '' }
  let lowIntegrity = false
  // 认不出号、靠事后核对才注入的进程：{ pid, at }；核对发现不是机器人号的进程 pid 记进 rejected，以后不再碰
  let pendingVerify = null
  const rejected = new Set()

  const cfg = () => getConfig().snowluma
  const base = () => `http://127.0.0.1:${cfg().webuiPort}`

  async function api(path, { method = 'GET', body, auth = true } = {}) {
    const headers = { 'content-type': 'application/json' }
    if (auth) {
      const t = await login()
      headers['x-snowluma-token'] = t
    }
    const r = await fetch(base() + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) })
    const j = await r.json().catch(() => ({}))
    if (r.status === 401 && auth) token = ''
    if (!r.ok) {
      const e = new Error(j.message || `HTTP ${r.status}`)
      e.status = r.status
      e.body = j
      throw e
    }
    return j
  }

  async function login() {
    const pw = cfg().webuiPassword
    // 密码换了（比如刚重置）就作废旧令牌重新登录
    if (token && tokenPw === pw && Date.now() - tokenAt < 30 * 60_000) return token
    if (!pw) throw Object.assign(new Error('还没在面板里填 SnowLuma 控制台密码'), { status: 0, code: 'no-password' })
    registerSecret(pw)
    const r = await fetch(base() + '/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: pw }), signal: AbortSignal.timeout(15000),
    })
    const j = await r.json().catch(() => ({}))
    if (!j.success || !j.token) throw Object.assign(new Error(j.message || '登录 SnowLuma 控制台失败'), { status: r.status })
    if (j.mustChangePassword) throw Object.assign(new Error('SnowLuma 要求先在它的控制台里改一次密码'), { status: 403 })
    registerSecret(j.token)
    token = j.token
    tokenPw = pw
    tokenAt = Date.now()
    return token
  }

  async function running() {
    try {
      const r = await fetch(base() + '/api/status', { signal: AbortSignal.timeout(3000) })
      return r.status > 0
    } catch (error) {
      return false
    }
  }

  async function start() {
    const inst = detectInstall(cfg().dir)
    if (!inst.installed) return { ok: false, message: inst.reason }
    if (await running()) return { ok: true, message: 'SnowLuma 已经在运行' }
    // 上一轮 DSH 退出时 SnowLuma 可能还没退干净：先看网关/端口，别在端口没释放时硬启
    // （硬启会 bind 失败，变成"WebUI 起来了但 OneBot 没监听"，之后所有消息都发不出去）
    // ⚠ botQQ 在配置顶层（snowluma 段里没有），这里要和 endpoint() 用同一个来源
    const ep = readOneBotEndpoint(cfg().dir, getConfig().botQQ)
    if (await gatewayHealthy(ep)) {
      log.info('检测到还活着的 SnowLuma 网关，直接复用（不再启动第二个实例）')
      return { ok: true, message: 'SnowLuma 已经在跑（直接复用）' }
    }
    const hp = endpointHostPort(ep.httpUrl)
    if (!hp) {
      log.debug('启动前探测：读不到 OneBot 地址，直接启动')
    } else if (await portOpen(hp)) {
      log.info(`OneBot 端口 ${hp.port} 还被占用（上一个 SnowLuma 还没退干净），等它释放…`)
      const freed = await waitPortFree(hp, { timeoutMs: 20000 })
      if (await gatewayHealthy(ep)) {
        log.info('端口释放后网关已经有响应，直接复用')
        return { ok: true, message: 'SnowLuma 已经在跑（直接复用）' }
      }
      if (freed) log.info(`OneBot 端口 ${hp.port} 已释放，开始启动`)
      else log.warn(`OneBot 端口 ${hp.port} 等了 20 秒还被占用（可能是别的程序），仍然尝试启动`)
    } else {
      log.debug(`启动前探测：${hp.port} 端口空闲、网关没响应，正常启动`)
    }
    const exe = inst.nodeExe || process.execPath
    const env = { ...process.env, SNOWLUMA_HOOK_AUTOLOAD: '0', SNOWLUMA_UPDATE_CHECK: '0' }
    delete env.SNOWLUMA_HOOK_AUTOLOAD_ALL
    delete env.ELECTRON_RUN_AS_NODE
    delete env.NODE_OPTIONS
    delete env.SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD
    if (!inst.nodeExe) env.ELECTRON_RUN_AS_NODE = '1'
    // 控制台密码全自动：还没有凭据文件（第一次启动 / 刚重置）时，由插件生成强密码交给 SnowLuma 作为初始密码，并自己记住
    if (!existsSync(join(inst.dir, 'config', 'webui.json'))) {
      let pw = cfg().webuiPassword
      if (!pw) {
        pw = generatePassword()
        savePassword?.(pw)
        log.info('已为 SnowLuma 控制台自动生成密码（存在本机配置里，不显示）')
      }
      registerSecret(pw)
      env.SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD = pw
      token = ''
    }
    try {
      child = spawn(exe, ['./index.mjs'], { cwd: inst.dir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: false })
    } catch (error) {
      return { ok: false, message: `启动失败：${error.message}` }
    }
    childPid = child.pid || 0
    const relay = (buf) => {
      // 首次启动 SnowLuma 会在控制台打印初始密码：凭据相关的行一律不进日志
      for (const line of String(buf).split(/\r?\n/)) {
        if (!line.trim() || /密码|password|credential|凭据|token/i.test(line)) continue
        // 解压在带低完整性标签的目录里时 SnowLuma 是 Low 完整性，看不到 QQ 进程
        if (/integrity:.*process=Low/i.test(line)) lowIntegrity = true
        else if (/integrity:/i.test(line)) lowIntegrity = false
        if (line.includes('[Event]') || line.includes('[Bridge.Action]')) continue // 别人的聊天内容和接口调用明细不进日志
        log.debug(line.slice(0, 400))
      }
    }
    child.stdout?.on('data', relay)
    child.stderr?.on('data', relay)
    const me = child
    me.on('exit', (code) => {
      log.warn(`SnowLuma 退出了（code ${code}）`)
      // 重置密码时旧进程晚一步退出：别把刚启动的新进程也当成退出了
      if (child !== me) return
      child = null
      childPid = 0
    })
    log.info(`已在后台启动 SnowLuma（pid ${childPid}，不弹窗口）`)
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      if (await running()) return { ok: true, message: '已启动' }
      if (!child) return { ok: false, message: 'SnowLuma 启动后马上退出了（看日志里的 SnowLuma 段）' }
    }
    return { ok: false, message: '等了 30 秒控制台还没起来' }
  }

  function stop() {
    if (!child) return { ok: false, message: '不是插件启动的 SnowLuma（或已经停了），请在它自己的窗口里关' }
    try {
      child.kill()
    } catch (error) {}
    return { ok: true, message: '已停止' }
  }

  async function processes() {
    const j = await api('/api/processes')
    return (j.list || []).map((p) => ({
      pid: p.pid,
      name: p.name,
      injected: Boolean(p.injected),
      connected: Boolean(p.connected),
      loggedIn: Boolean(p.loggedIn),
      status: p.status,
      error: p.error || '',
      uin: String(p.account?.uin ?? p.uin ?? ''),
      nickname: p.account?.nickname || '',
      isBot: String(p.account?.uin ?? p.uin ?? '') === String(getConfig().botQQ),
    }))
  }

  /** 只给机器人号注入；别的号（主人的主号）碰都不碰。 */
  async function attachBot() {
    const bot = getConfig().botQQ
    let list
    try {
      const j = await api('/api/processes')
      list = j.list || []
    } catch (error) {
      lastAttach = { at: Date.now(), ok: false, message: error.message }
      return lastAttach
    }
    const { proc, reason, unverified } = pickBotProcess(list, bot, { exclude: [...rejected] })
    if (!proc) {
      lastAttach = { at: Date.now(), ok: false, message: reason }
      return lastAttach
    }
    if (unverified) pendingVerify = { pid: proc.pid, at: Date.now() }
    const note = unverified ? '（SnowLuma 没报账号，连上后会核对是不是机器人号，不是就立刻断开）' : ''
    if (proc.injected && proc.connected) {
      lastAttach = { at: Date.now(), ok: true, message: `机器人号（pid ${proc.pid}）已接入${note}` }
      return lastAttach
    }
    try {
      const r = await api(`/api/processes/${proc.pid}/load`, { method: 'POST' })
      const ok = Boolean(r.success)
      lastAttach = { at: Date.now(), ok, message: ok ? `已给 QQ 进程（pid ${proc.pid}）注入${note}` : r.message || '注入失败' }
      log.info(lastAttach.message)
    } catch (error) {
      lastAttach = { at: Date.now(), ok: false, message: `注入失败：${error.message}` }
    }
    return lastAttach
  }

  /**
   * OneBot 连上后核对登录的号。uin 是机器人号：核对通过。不是：撤销那次注入（SnowLuma 支持的话），
   * 记住这个进程以后不再碰。返回 true 表示可以用。
   */
  async function confirmLogin(uin) {
    const bot = String(getConfig().botQQ)
    const pend = pendingVerify
    if (String(uin) === bot) {
      if (pend) {
        pendingVerify = null
        lastAttach = { at: Date.now(), ok: true, message: `已核对：pid ${pend.pid} 登录的就是机器人号 ${bot}` }
        log.info(lastAttach.message)
      }
      return true
    }
    pendingVerify = null
    let undone = false
    if (pend) {
      rejected.add(Number(pend.pid))
      try {
        const r = await api(`/api/processes/${pend.pid}/unload`, { method: 'POST' })
        undone = Boolean(r.success)
      } catch (error) {}
    }
    lastAttach = {
      at: Date.now(),
      ok: false,
      message: `连上的是 ${uin || '未知号'}，不是机器人号 ${bot}，已断开不用${pend ? (undone ? '，并撤销了注入' : `；pid ${pend.pid} 的注入撤不掉，重启那个 QQ 就没了`) : ''}`,
    }
    log.warn(lastAttach.message)
    return false
  }

  /** SnowLuma 的用户协议和隐私说明（全文 + 版本 + 是否还需要同意）。 */
  async function agreements() {
    const j = await api('/api/agreements')
    return {
      version: j.version,
      consentRequired: Boolean(j.consentRequired),
      documents: (j.documents || []).map((d) => ({ id: d.id, title: d.title, version: d.declaredVersion, date: d.effectiveDate, text: d.text })),
    }
  }

  /** 用户在面板里读完协议、点了「我同意」：把同意记到 SnowLuma。 */
  async function consent(version) {
    const r = await api('/api/agreements/record-consent', { method: 'POST', body: { version: String(version || '') } })
    if (r.success) log.info('主人已在面板里同意 SnowLuma 的用户协议和隐私说明')
    return { ok: Boolean(r.success), message: r.success ? '已同意' : r.message || '没记上' }
  }

  /** 找出占着控制台端口、且确实是配置目录里那份 SnowLuma 的进程。 */
  async function findRunningPid() {
    const inst = detectInstall(cfg().dir)
    if (!inst.installed) return 0
    const out = await new Promise((res) => execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true }, (e, so) => res(String(so || ''))))
    const line = out.split(/\r?\n/).find((l) => new RegExp(`127\\.0\\.0\\.1:${cfg().webuiPort}\\s+\\S+\\s+LISTENING`).test(l))
    const pid = Number(line ? line.trim().split(/\s+/).pop() : 0)
    if (!pid) return 0
    const path = await new Promise((res) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).Path`], { windowsHide: true }, (e, so) => res(String(so || '').trim())))
    return path.toLowerCase().startsWith(inst.dir.toLowerCase()) ? pid : 0
  }

  /**
   * 重置密码：停掉 SnowLuma → 删掉旧凭据 → 用新密码重新启动。用于之前手动设过密码、插件不知道的情况。
   * pw 不给就生成一个（自动管理）；给了就用它（主人自己定的）。
   */
  async function resetPassword(pw = '') {
    const inst = detectInstall(cfg().dir)
    if (!inst.installed) return { ok: false, message: inst.reason }
    if (child) {
      try { child.kill() } catch (error) {}
    } else if (await running()) {
      const pid = await findRunningPid()
      if (!pid) return { ok: false, message: '有一个 SnowLuma 在运行，但不是配置目录里那份，没法替你重置' }
      try { process.kill(pid) } catch (error) { return { ok: false, message: '停不掉正在运行的 SnowLuma：' + error.message } }
    }
    for (let i = 0; i < 20 && (await running()); i++) await new Promise((r) => setTimeout(r, 500))
    try { unlinkSync(join(inst.dir, 'config', 'webui.json')) } catch (error) {}
    savePassword?.(pw || generatePassword(), !pw)
    token = ''
    const r = await start()
    return r.ok ? { ok: true, message: pw ? '控制台密码改好了，SnowLuma 已重新启动' : '控制台密码已改成自动管理，SnowLuma 已重新启动' } : r
  }

  /**
   * 主人自己设控制台密码。SnowLuma 在跑、插件知道旧密码：直接调它的改密码接口，不用重启；
   * 否则（旧密码对不上、还没装好）走重置：删掉旧凭据，用这个密码重新启动。
   */
  async function setPassword(pw) {
    const bad = passwordProblems(pw)
    if (bad.length) return { ok: false, message: '密码不合格：' + bad.join('、') }
    const old = cfg().webuiPassword
    if (old === pw) return { ok: true, message: '密码没变' }
    if (old && (await running())) {
      try {
        await api('/api/auth/change-password', { method: 'POST', body: { oldPassword: old, newPassword: pw } })
        savePassword?.(pw, false)
        token = ''
        log.info('SnowLuma 控制台密码改好了（主人自己设的）')
        return { ok: true, message: '控制台密码改好了' }
      } catch (error) {
        log.warn('直接改密码没成功，改用重置：', error.message)
      }
    }
    return resetPassword(pw)
  }

  /** 插件能不能登录控制台（密码对不对）。 */
  async function canLogin() {
    try {
      await login()
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error.message, code: error.code || '' }
    }
  }

  return {
    detect: () => detectInstall(cfg().dir),
    endpoint: () => readOneBotEndpoint(cfg().dir, getConfig().botQQ),
    running,
    start,
    stop,
    processes,
    attachBot,
    confirmLogin,
    /** 手动点「接入机器人号」时清掉之前核对失败的记录，让主人能重试 */
    clearRejected: () => rejected.clear(),
    agreements,
    consent,
    resetPassword,
    setPassword,
    /** 现在存的控制台密码（面板「显示密码」用，只在本机面板里看得到） */
    password: () => cfg().webuiPassword || '',
    canLogin,
    get ownsProcess() {
      return Boolean(child)
    },
    get lowIntegrity() {
      return lowIntegrity
    },
    get lastAttach() {
      return lastAttach
    },
    webuiUrl: () => base() + '/',
    dispose() {
      // DSH 退出时连带停掉自己启动的 SnowLuma
      try { child?.kill() } catch (error) {}
    },
  }
}
