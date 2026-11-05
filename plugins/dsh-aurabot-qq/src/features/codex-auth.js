// ChatGPT（Codex 订阅）的 OAuth：浏览器登录 → 存令牌 → 过期自动刷新。
//
// 走 Codex CLI 那条流程（client_id 是公开的 app_EMoamEEZ73f0CkXaXp7hrann）：
//   授权 https://auth.openai.com/oauth/authorize
//   换票 https://auth.openai.com/oauth/token
// 此接法复用本地实现，图片端点不属于公开 API；不能据此保证订阅或工作区可用。
//
// 令牌只存在本机 data/codex-auth.json，不写日志、不回传给面板。

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, unlinkSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { dataDir, readJson } from '../core/store.js'

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const SCOPE = 'openid profile email offline_access'
const CALLBACK_HOST = '127.0.0.1'
const CALLBACK_PORT = 1455
const CALLBACK_PATH = '/auth/callback'
// 这条流程的 redirect_uri 必须是注册过的固定地址（Codex CLI 用的就是它），不能随机端口
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`
const JWT_CLAIM_PATH = 'https://api.openai.com/auth'
const REFRESH_SKEW_MS = 2 * 60_000

/** PKCE：verifier 随机串，challenge 是它的 sha256(b64url)。 */
export function createPkce () {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/** 拼授权地址（参数同 Codex CLI）。 */
export function buildAuthUrl ({ challenge, state, originator = 'pi' }) {
  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', CLIENT_ID)
  url.searchParams.set('redirect_uri', REDIRECT_URI)
  url.searchParams.set('scope', SCOPE)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  url.searchParams.set('id_token_add_organizations', 'true')
  url.searchParams.set('codex_cli_simplified_flow', 'true')
  url.searchParams.set('originator', originator)
  return url.toString()
}

/** 从 JWT 里读 payload（不验签，只用来取 accountId / email）。 */
export function decodeJwt (token) {
  try {
    const parts = String(token || '').split('.')
    if (parts.length !== 3) return null
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch (error) {
    return null
  }
}

/** access token 里的 chatgpt_account_id（生图必需）。 */
export function accountIdOf (accessToken, idToken) {
  for (const t of [accessToken, idToken]) {
    const p = decodeJwt(t)
    const id = p && p[JWT_CLAIM_PATH] && p[JWT_CLAIM_PATH].chatgpt_account_id
    if (typeof id === 'string' && id) return id
  }
  return ''
}

/** id_token 里的邮箱。 */
export function emailOf (idToken) {
  const p = decodeJwt(idToken)
  return (p && (p.email || (p[JWT_CLAIM_PATH] && p[JWT_CLAIM_PATH].email))) || ''
}

/** 从用户粘贴的整条回调地址 / code 里取出授权码。 */
export function parseAuthInput (input) {
  const v = String(input || '').trim()
  if (!v) return {}
  let url = null
  try { url = new URL(v) } catch (error) {}
  if (url) {
    // 1455 打不开时浏览器地址栏里仍是一条 localhost 回调地址，这里不强校验主机名
    return {
      code: url.searchParams.get('code') || '',
      state: url.searchParams.get('state') || '',
      error: url.searchParams.get('error') || '',
    }
  }
  if (v.includes('code=')) {
    const q = new URLSearchParams(v.replace(/^[^?]*\?/, ''))
    return { code: q.get('code') || '', state: q.get('state') || '', error: q.get('error') || '' }
  }
  return { code: v, state: '', error: '' }
}

/**
 * 用系统默认浏览器打开链接。
 * ⚠ Windows 上**不能**用 `cmd /c start "" <url>`：链接里的 `&` 会被 cmd 当成命令分隔符，
 *   浏览器只拿到第一个 `&` 之前的部分（授权链接就是这么被截断、登不进去的）。
 *   rundll32 直接收 argv，不经过 shell，`&`、`?`、`=` 都原样带过去。
 */
export function openInBrowser (url, { run = spawn, platform = process.platform } = {}) {
  try {
    const opts = { detached: true, stdio: 'ignore', windowsHide: true }
    const child = platform === 'win32' ? run('rundll32', ['url.dll,FileProtocolHandler', url], opts)
      : platform === 'darwin' ? run('open', [url], opts) : run('xdg-open', [url], opts)
    child.on?.('error', () => {}) // 打不开时仍可在面板手动打开授权链接。
    child.unref()
    return true
  } catch (error) {
    return false
  }
}

/**
 * @param {object} deps
 * @param {object} [deps.log]
 * @param {Function} [deps.fetchImpl] 测试可注入
 * @param {Function} [deps.openUrl] 测试可注入
 */
export function createCodexAuth ({ log, fetchImpl, openUrl, createServerImpl = createServer } = {}) {
  const doFetch = fetchImpl || ((...a) => globalThis.fetch(...a))
  const file = () => dataDir('codex-auth.json')
  const defaultOpenUrl = (url) => openInBrowser(url)
  let pending = null // { state, verifier, server, status, error, email, needPaste }
  let disposed = false, epoch = 0, refreshJob = null

  function assertCurrent(revision = epoch) {
    if (disposed || revision !== epoch) throw new Error('登录状态已改变或模块已卸载，请重新操作')
  }

  function read () {
    if (disposed) return null
    const v = readJson(file(), () => null)
    // 旧格式（没有 accountId，比如之前那版动态客户端流程存下的）一律当没登录：生图必须要账号 ID
    return v && v.access && v.refresh && v.accountId && Number.isFinite(v.expires) && v.expires > 0 ? v : null
  }

  function save (cred) {
    assertCurrent()
    const target = file(), tmp = target + '.tmp-' + randomBytes(8).toString('hex')
    mkdirSync(dirname(target), { recursive: true })
    try {
      writeFileSync(tmp, JSON.stringify(cred), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      renameSync(tmp, target)
    } finally { try { if (existsSync(tmp)) unlinkSync(tmp) } catch (error) {} }
  }

  function clear () {
    try { if (existsSync(file())) unlinkSync(file()) } catch (error) {}
  }

  function status () {
    const c = read()
    if (!c) return { loggedIn: false }
    return {
      loggedIn: true,
      email: c.email || '',
      accountId: c.accountId || '',
      expires: Number(c.expires) || 0,
      expired: Number(c.expires) > 0 && Number(c.expires) < Date.now(),
    }
  }

  function toCredential (json, prev = {}) {
    if (!json || !json.access_token || !json.refresh_token) {
      throw new Error('登录返回缺字段（access_token / refresh_token）')
    }
    if (typeof json.expires_in !== 'number' || !Number.isFinite(json.expires_in) || json.expires_in <= 0) {
      throw new Error('登录返回的 expires_in 不正常')
    }
    const access = json.access_token
    const idToken = json.id_token || ''
    const accountId = accountIdOf(access, idToken) || prev.accountId || ''
    if (!accountId) {
      throw new Error('登录返回的信息没有 chatgpt_account_id，无法使用此订阅接法')
    }
    return {
      type: 'oauth',
      access,
      refresh: json.refresh_token,
      expires: Date.now() + json.expires_in * 1000,
      accountId,
      email: emailOf(idToken) || prev.email || '',
    }
  }

  async function postToken (form) {
    const r = await doFetch(TOKEN_URL, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(30000),
    })
    const text = await r.text().catch(() => '')
    if (!r.ok) throw new Error(`换取令牌失败（HTTP ${r.status}），请重新登录`)
    try { return JSON.parse(text) } catch (error) { throw new Error('换取令牌返回的不是 JSON') }
  }

  async function exchange (code, p) {
    assertCurrent(p.epoch)
    if (pending !== p || p.status !== 'waiting') throw new Error('登录会话已失效，请重新登录')
    p.status = 'exchanging'
    const json = await postToken({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      code_verifier: p.verifier,
      redirect_uri: REDIRECT_URI,
    })
    const cred = toCredential(json)
    assertCurrent(p.epoch)
    if (pending !== p) throw new Error('登录会话已失效，请重新登录')
    save(cred)
    p.status = 'done'
    p.email = cred.email || ''
    p.verifier = ''
    clearTimeout(p.timer)
    try { p.server?.close() } catch (error) {}
    log?.info?.('ChatGPT 订阅登录成功')
    return cred
  }

  /** 本地回调服务（固定 1455）；端口被占返回 server=null，面板改用手动粘贴。 */
  function startCallbackServer (state) {
    return new Promise((resolve) => {
      let settle = () => {}
      const result = new Promise((res) => { settle = res })
      const server = createServerImpl((req, res) => {
        const html = (code, body) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'" }); res.end(`<meta charset="utf-8">${body}`) }
        try {
          const url = new URL(req.url || '', `http://${CALLBACK_HOST}:${CALLBACK_PORT}`)
          if (req.method !== 'GET') return html(405, '只接受 GET 回调')
          if (url.pathname !== CALLBACK_PATH) return html(404, '回调路径不对')
          const gotState = url.searchParams.get('state') || ''
          if (gotState !== state) return html(400, 'state 不匹配')
          const err = url.searchParams.get('error')
          if (err) { html(400, '登录没有完成，请回面板重新登录'); settle({ error: '授权未完成' }); return }
          const code = url.searchParams.get('code') || ''
          if (!code) return html(400, '没有 code')
          html(200, '<h2>已收到授权结果</h2><p>回到 Aurabot 面板查看登录结果。</p>')
          try { server.close() } catch (error) {}
          settle({ code })
        } catch (error) {
          html(500, '处理回调出错')
        }
      })
      server.once('error', () => resolve({ server: null, result: null }))
      server.listen(CALLBACK_PORT, CALLBACK_HOST, () => resolve({ server, result }))
    })
  }

  /** 开始登录：返回授权地址；1455 能起就在后台等回调，否则让用户手动粘贴。 */
  async function startLogin ({ agentName = 'pi', openBrowser = true } = {}) {
    assertCurrent()
    cancelLogin('重新发起登录')
    const { verifier, challenge } = createPkce()
    const state = randomBytes(16).toString('hex')
    const url = buildAuthUrl({ challenge, state, originator: agentName })
    const p = { state, verifier, epoch, status: 'waiting', error: '', email: '', needPaste: false }
    pending = p
    const cb = await startCallbackServer(state)
    if (disposed || pending !== p || p.epoch !== epoch) {
      try { cb.server?.close() } catch (error) {}
      throw new Error('登录会话已取消或模块已卸载')
    }
    p.timer = setTimeout(() => { if (pending === p && ['waiting', 'exchanging'].includes(p.status)) cancelLogin('登录已超时，请重新登录') }, 10 * 60_000)
    p.timer.unref?.()
    if (cb.server) {
      p.server = cb.server
      cb.result.then(async (r) => {
        try {
          if (r.error) throw new Error('授权失败：' + r.error)
          await exchange(r.code, p)
        } catch (error) {
          if (pending === p && p.epoch === epoch && !disposed) { p.status = 'error'; p.error = error.message; clearTimeout(p.timer); try { p.server?.close() } catch (error) {} }
        }
      }).catch(() => {})
    } else {
      p.needPaste = true
      log?.info?.('本地 1455 端口被占用，改用手动粘贴回调地址')
    }
    cb.server?.unref?.()
    if (openBrowser) (openUrl || defaultOpenUrl)(url)
    return { url, needPaste: p.needPaste }
  }

  /** 手动粘贴整条回调地址（或只有 code）。 */
  async function completeLogin (input) {
    assertCurrent()
    const p = pending
    if (!p?.verifier || p.status !== 'waiting') throw new Error('登录会话已失效，请重新点「登录 ChatGPT」')
    const parsed = parseAuthInput(input)
    if (parsed.error) throw new Error('授权未完成，请重新登录')
    if (!parsed.code) throw new Error('没找到授权码')
    if ((String(input).includes('code=') || parsed.state) && parsed.state !== p.state) throw new Error('state 不匹配，请重新登录')
    try { return await exchange(parsed.code, p) }
    catch (error) {
      if (pending === p && p.epoch === epoch && !disposed) { p.status = 'error'; p.error = error.message; clearTimeout(p.timer); try { p.server?.close() } catch (error) {} }
      throw error
    }
  }

  function loginStatus () {
    if (disposed) return { state: 'idle' }
    if (!pending) return { state: read() ? 'done' : 'idle' }
    return { state: pending.status, error: pending.error || '', email: pending.email || '', needPaste: !!pending.needPaste }
  }

  function cancelLogin (why) {
    epoch++
    refreshJob = null
    clearTimeout(pending?.timer)
    try { pending?.server?.close?.() } catch (error) {}
    if (pending && ['waiting', 'exchanging'].includes(pending.status)) { pending.status = 'error'; pending.error = why || '已取消'; pending.verifier = '' }
    return { ok: true }
  }

  /** 拿可用的 access token（过期就刷新）。 */
  async function ensureAccess ({ force = false } = {}) {
    assertCurrent()
    let c = read()
    if (!c) throw new Error('还没登录 ChatGPT 订阅（生图页点「登录 ChatGPT」）')
    if (force || (Number(c.expires) && Number(c.expires) < Date.now() + REFRESH_SKEW_MS)) {
      const revision = epoch
      if (!refreshJob) refreshJob = (async () => {
        const json = await postToken({ grant_type: 'refresh_token', refresh_token: c.refresh, client_id: CLIENT_ID })
        const next = toCredential({ refresh_token: c.refresh, ...json }, c)
        assertCurrent(revision)
        save(next)
        log?.debug?.('ChatGPT 订阅令牌已刷新')
        return next
      })()
      const job = refreshJob
      try { c = await job; assertCurrent(revision) }
      finally { if (refreshJob === job) refreshJob = null }
    }
    return { access: c.access, accountId: c.accountId }
  }

  function logout () {
    assertCurrent()
    cancelLogin('已退出登录')
    pending = null
    clear()
    return { ok: true }
  }

  function dispose() {
    cancelLogin('模块已卸载')
    disposed = true
    pending = null
  }

  return { status, startLogin, completeLogin, loginStatus, cancelLogin, ensureAccess, logout, dispose, revision: () => epoch, assertCurrent }
}
