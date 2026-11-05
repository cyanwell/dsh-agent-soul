// SnowLuma 管理：自动生成控制台密码、读协议、记同意、重置密码。用一个假的 SnowLuma（index.mjs 起个小服务）来测。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { createSnowLumaManager, generatePassword } from '../src/snowluma/manager.js'

const FAKE = `
import http from 'node:http'
import fs from 'node:fs'
const port = Number(fs.readFileSync('port.txt', 'utf8'))
fs.mkdirSync('config', { recursive: true })
let pw = null
if (fs.existsSync('config/webui.json')) pw = JSON.parse(fs.readFileSync('config/webui.json', 'utf8')).pw
else { pw = process.env.SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD || 'random-' + Math.random(); fs.writeFileSync('config/webui.json', JSON.stringify({ pw })) }
let consented = false
const tokens = new Set()
http.createServer(async (req, res) => {
  let b = ''
  for await (const c of req) b += c
  const send = (code, j) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(j)) }
  if (req.url === '/api/status') return send(401, {})
  if (req.url === '/api/login') {
    if (JSON.parse(b).password !== pw) return send(401, { success: false, message: '密码错误' })
    const t = 'tok' + Math.random(); tokens.add(t); return send(200, { success: true, token: t, mustChangePassword: false })
  }
  if (!tokens.has(req.headers['x-snowluma-token'])) return send(401, { message: 'Unauthorized' })
  if (req.url === '/api/processes') return send(200, { list: [{ pid: 19224, name: 'QQ.exe', injected: fs.existsSync('injected'), connected: false, account: null }] })
  if (req.url === '/api/processes/19224/load') { fs.writeFileSync('injected', '1'); return send(200, { success: true }) }
  if (req.url === '/api/processes/19224/unload') { fs.rmSync('injected', { force: true }); return send(200, { success: true }) }
  if (req.url === '/api/agreements') return send(200, { version: 'v1', consentRequired: !consented, documents: [{ id: 'eula', title: '用户协议', declaredVersion: '1.1', effectiveDate: '2026-07-21', text: '# 协议正文' }] })
  if (req.url === '/api/agreements/record-consent') { const v = JSON.parse(b).version; if (v !== 'v1') return send(409, { success: false, message: '版本不对' }); consented = true; fs.writeFileSync('consented', '1'); return send(200, { success: true, version: v }) }
  send(404, {})
}).listen(port, '127.0.0.1')
`

let dir
let cfg
let mgr
const freePort = () => new Promise((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fake-snowluma-'))
  writeFileSync(join(dir, 'index.mjs'), FAKE)
  const port = await freePort()
  writeFileSync(join(dir, 'port.txt'), String(port))
  cfg = { botQQ: '20000002', snowluma: { dir, webuiPort: port, webuiPassword: '' } }
  mgr = createSnowLumaManager({
    getConfig: () => cfg,
    log: { info() {}, warn() {}, debug() {} },
    savePassword: (pw) => { cfg = { ...cfg, snowluma: { ...cfg.snowluma, webuiPassword: pw, passwordAuto: true } } },
  })
})

after(() => { mgr?.dispose() })

test('生成的密码满足 SnowLuma 规则', () => {
  for (let i = 0; i < 20; i++) {
    const p = generatePassword()
    assert.ok(p.length >= 10 && /[a-z]/.test(p) && /[A-Z]/.test(p) && /[^A-Za-z0-9\s]/.test(p) && !/\s/.test(p), p)
  }
})

test('第一次启动：插件自动生成控制台密码并能登录', async () => {
  const r = await mgr.start()
  assert.equal(r.ok, true, r.message)
  assert.ok(cfg.snowluma.webuiPassword, '密码被保存了')
  assert.equal(cfg.snowluma.passwordAuto, true)
  const l = await mgr.canLogin()
  assert.equal(l.ok, true, l.message)
})

test('在面板里读协议并同意', async () => {
  const a = await mgr.agreements()
  assert.equal(a.consentRequired, true)
  assert.equal(a.documents[0].title, '用户协议')
  const c = await mgr.consent(a.version)
  assert.equal(c.ok, true)
  assert.equal((await mgr.agreements()).consentRequired, false)
})

test('密码对不上时可以一键重置为自动密码', async () => {
  cfg = { ...cfg, snowluma: { ...cfg.snowluma, webuiPassword: 'wrong-Pass#1' } }
  assert.equal((await mgr.canLogin()).ok, false)
  const r = await mgr.resetPassword()
  assert.equal(r.ok, true, r.message)
  assert.notEqual(cfg.snowluma.webuiPassword, 'wrong-Pass#1')
  assert.equal((await mgr.canLogin()).ok, true)
  assert.equal(JSON.parse(readFileSync(join(dir, 'config', 'webui.json'), 'utf8')).pw, cfg.snowluma.webuiPassword)
  assert.ok(existsSync(join(dir, 'consented')))
})

test('认不出号时先注入，连上后核对：是机器人号就通过，不是就撤销并不再碰', async () => {
  const r = await mgr.attachBot()
  assert.equal(r.ok, true, r.message)
  assert.match(r.message, /核对/)
  assert.ok(existsSync(join(dir, 'injected')))
  // 连上的不是机器人号
  assert.equal(await mgr.confirmLogin('10000001'), false)
  assert.ok(!existsSync(join(dir, 'injected')), '应该撤销注入')
  assert.match(mgr.lastAttach.message, /不是机器人号/)
  // 被拒过的进程不再注入
  const again = await mgr.attachBot()
  assert.equal(again.ok, false)
  // 主人手动重试：清掉记录后再注入，这次核对通过
  mgr.clearRejected()
  assert.equal((await mgr.attachBot()).ok, true)
  assert.equal(await mgr.confirmLogin('20000002'), true)
  assert.match(mgr.lastAttach.message, /已核对/)
})
