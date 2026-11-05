// OAuth 全部使用模拟回调服务和令牌响应，不访问真实账号或固定回调端口。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCodexAuth } from '../src/features/codex-auth.js'
import { createImageGen } from '../src/features/imagegen.js'
import imagegenModule from '../src/modules/imagegen/index.js'
import { normalize } from '../src/core/config.js'

const log = { info() {}, debug() {}, warn() {} }
const jwt = (body) => 'e30.' + Buffer.from(JSON.stringify(body)).toString('base64url') + '.signature'
const token = () => ({ access_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account-test' } }), refresh_token: 'refresh-secret-test', expires_in: 3600 })
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }
const response = () => new Response(JSON.stringify(token()))
const flush = () => new Promise(setImmediate)
function setup({ fetchImpl = async () => response(), blocked = false, delayed = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-codex-flow-'))
  process.env.AURABOT_DATA_DIR = dir
  const state = { servers: [], requests: [] }
  const createServerImpl = (handler) => {
    const server = { handler, closed: 0, once(_kind, fn) { this.error = fn },
      listen(_port, _host, ready) { this.ready = () => blocked ? this.error(new Error('busy')) : ready(); if (!delayed) queueMicrotask(this.ready) },
      close() { this.closed++ }, unref() {},
    }
    state.servers.push(server)
    return server
  }
  const auth = createCodexAuth({ log, fetchImpl: async (...args) => { state.requests.push(args); return fetchImpl(...args) }, createServerImpl, openUrl() {} })
  const begin = async () => {
    const result = await auth.startLogin({ openBrowser: false })
    const expected = new URL(result.url).searchParams.get('state')
    return { ...result, input: `http://localhost:1455/auth/callback?code=code-test&state=${expected}`, expected }
  }
  const reply = (query, method = 'GET') => {
    const result = { code: 0, headers: {}, body: '' }
    state.servers.at(-1).handler({ method, url: '/auth/callback?' + query }, { writeHead: (code, headers) => Object.assign(result, { code, headers }), end: (body) => { result.body = body } })
    return result
  }
  const file = join(dir, 'codex-auth.json')
  const seed = () => writeFileSync(file, JSON.stringify({ access: 'old-access', refresh: 'old-refresh', accountId: 'old-account', expires: Date.now() - 1 }))
  return { auth, begin, reply, state, file, seed }
}

test('自动回调必须包含匹配的 state，非法回调不换令牌；成功后关闭监听', async () => {
  const s = setup(), login = await s.begin()
  for (const query of ['code=bad', 'code=bad&state=wrong']) assert.equal(s.reply(query).code, 400)
  assert.equal(s.state.requests.length, 0)
  assert.equal(s.reply(`code=code-test&state=${login.expected}`, 'POST').code, 405)
  assert.equal(s.reply(`code=code-test&state=${login.expected}`).code, 200)
  await flush()
  assert.equal(s.auth.loginStatus().state, 'done')
  assert.ok(s.state.servers[0].closed)
  assert.equal(s.auth.status().loggedIn, true)
  const form = new URLSearchParams(s.state.requests[0][1].body)
  assert.ok(form.get('code_verifier').length >= 43)
  assert.equal(form.get('redirect_uri'), 'http://localhost:1455/auth/callback')
  assert.equal(JSON.stringify(s.auth.status()).includes('refresh-secret-test'), false)
  s.auth.dispose()
})

test('手动回调要求匹配 state，端口被占仍能完成登录，成功的 code 不能重复使用', async () => {
  const s = setup({ blocked: true }), login = await s.begin()
  assert.equal(login.needPaste, true)
  await assert.rejects(s.auth.completeLogin('http://localhost:1455/auth/callback?code=bad'), /state/)
  await assert.rejects(s.auth.completeLogin('http://localhost:1455/auth/callback?code=bad&state=wrong'), /state/)
  assert.equal(s.state.requests.length, 0)
  await s.auth.completeLogin(login.input)
  assert.equal(s.auth.status().loggedIn, true)
  await assert.rejects(s.auth.completeLogin(login.input), /失效/)
  s.auth.dispose()
})

test('取消、退出或卸载后，迟到的换票结果不能重新保存登录信息', async (t) => {
  for (const action of ['cancelLogin', 'logout', 'dispose']) await t.test(action, async () => {
    const gate = deferred(), s = setup({ fetchImpl: () => gate.promise }), login = await s.begin()
    const work = s.auth.completeLogin(login.input)
    const checked = assert.rejects(work, /登录状态已改变|卸载/)
    s.auth[action]()
    gate.resolve(response())
    await checked
    assert.equal(existsSync(s.file), false)
    await assert.rejects(s.auth.completeLogin(login.input))
    s.auth.dispose()
  })
})

test('启动监听尚未完成时卸载，迟到监听会关闭且不打开浏览器', async () => {
  const s = setup({ delayed: true })
  const work = s.begin(), checked = assert.rejects(work, /取消|卸载/)
  s.auth.dispose()
  s.state.servers[0].ready()
  await checked
  assert.ok(s.state.servers[0].closed)
  assert.equal(existsSync(s.file), false)
})

test('登录十分钟超时会关闭监听，之后不能用旧 code 完成', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const s = setup(), login = await s.begin()
  t.mock.timers.tick(10 * 60_000)
  assert.match(s.auth.loginStatus().error, /超时/)
  assert.ok(s.state.servers[0].closed)
  await assert.rejects(s.auth.completeLogin(login.input), /失效/)
  s.auth.dispose()
})

test('同时请求过期令牌时只刷新一次', async () => {
  const gate = deferred(), s = setup({ fetchImpl: () => gate.promise })
  s.seed()
  const jobs = [s.auth.ensureAccess(), s.auth.ensureAccess()]
  assert.equal(s.state.requests.length, 1)
  gate.resolve(response())
  const [a, b] = await Promise.all(jobs)
  assert.deepEqual(a, b)
  assert.equal(a.accountId, 'account-test')
  assert.equal(JSON.parse(readFileSync(s.file, 'utf8')).refresh, 'refresh-secret-test')
  s.auth.dispose()
})

test('退出后迟到的刷新结果不能复活凭据；卸载保留原已存凭据', async () => {
  const gate = deferred(), s = setup({ fetchImpl: () => gate.promise })
  s.seed()
  const work = s.auth.ensureAccess(), checked = assert.rejects(work, /登录状态已改变/)
  s.auth.logout()
  gate.resolve(response())
  await checked
  assert.equal(existsSync(s.file), false)
  s.seed()
  const disk = readFileSync(s.file, 'utf8')
  s.auth.dispose()
  assert.deepEqual(s.auth.status(), { loggedIn: false })
  await assert.rejects(s.auth.ensureAccess(), /卸载/)
  assert.equal(readFileSync(s.file, 'utf8'), disk)
})

test('OAuth 错误和过期状态不返回服务端的令牌内容', async () => {
  const s = setup({ fetchImpl: async () => new Response('access-secret refresh-secret-test', { status: 400 }) }), login = await s.begin()
  await assert.rejects(s.auth.completeLogin(login.input), (error) => /HTTP 400/.test(error.message) && !/secret/.test(error.message))
  assert.doesNotMatch(JSON.stringify(s.auth.loginStatus()), /secret/)
  assert.ok(s.state.servers[0].closed)
  assert.equal(existsSync(s.file), false)
  s.auth.dispose()
})

test('开始新登录时也使旧刷新失效，旧账号结果不能覆盖新登录', async () => {
  const gate = deferred()
  let calls = 0
  const s = setup({ fetchImpl: () => ++calls === 1 ? gate.promise : Promise.resolve(response()) })
  s.seed()
  const work = s.auth.ensureAccess(), checked = assert.rejects(work, /登录状态已改变/)
  const login = await s.begin()
  gate.resolve(response())
  await checked
  assert.equal(JSON.parse(readFileSync(s.file, 'utf8')).accountId, 'old-account')
  await s.auth.completeLogin(login.input)
  assert.equal(JSON.parse(readFileSync(s.file, 'utf8')).accountId, 'account-test')
  s.auth.dispose()
})

test('生图响应在退出后才到达，不继续返回可发送的图片', async () => {
  const gate = deferred(), s = setup()
  writeFileSync(s.file, JSON.stringify({ access: 'access-test', refresh: 'refresh-test', accountId: 'account-test', expires: Date.now() + 3600_000 }))
  const cfg = normalize({ imageGen: { enabled: true, provider: 'codex' } })
  const gen = createImageGen({ getConfig: () => cfg, log, codexAuth: s.auth, fetchImpl: () => gate.promise })
  const work = gen.generate('猫'), checked = assert.rejects(work, /登录状态已改变/)
  await flush()
  s.auth.logout()
  gate.resolve(new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] })))
  await checked
  s.auth.dispose()
})

test('生图最多刷新重试一次；缺账号、不合规图片、未知返回结构都明确失败', async () => {
  const cfg = normalize({ imageGen: { enabled: true, provider: 'codex' } })
  const make = (fetchImpl, accountId = 'account-test') => createImageGen({ getConfig: () => cfg, log, fetchImpl, codexAuth: { status: () => ({ loggedIn: true }), ensureAccess: async () => ({ access: 'token-test', accountId }) } })
  let calls = 0
  await assert.rejects(make(async () => { calls++; return new Response('{}', { status: 401 }) }).generate('猫'), /失效/)
  assert.equal(calls, 2)
  await assert.rejects(make(async () => { throw new Error('不能发请求') }, '').generate('猫'), /账号 ID/)
  await assert.rejects(make(async () => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('not an image').toString('base64') }] }))).generate('猫'), /不是图片/)
  await assert.rejects(make(async () => new Response('{}')).generate('猫'), /没有返回图片/)
  await assert.rejects(make(async () => new Response(JSON.stringify({ data: [{ url: 'file:///private.png' }] }))).generate('猫'))
})

test('模块路由只返回登录摘要，卸载关闭登录实例', async () => {
  const s = setup(), cfg = normalize({ imageGen: { provider: 'codex', enabled: true } }), routes = new Map(), off = []
  s.seed()
  const gen = imagegenModule.setup({ config: () => cfg, log, dsh: {}, lazy: () => ({}), tool() {},
    route: (path, fn) => routes.set(path, fn), onDispose: (fn) => off.push(fn), core: { hub: {}, local: null, http: { body: async () => ({ input: 'mock-code' }) } },
  })
  const status = await routes.get('/image/codex/status')()
  assert.equal(status.loggedIn, true)
  assert.doesNotMatch(JSON.stringify(status), /old-access|old-refresh/)
  for (const action of ['login', 'complete', 'cancel', 'logout']) {
    assert.equal((await routes.get('/image/codex/' + action)({ method: 'GET', headers: {} })).ok, false)
    assert.equal((await routes.get('/image/codex/' + action)({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).ok, false)
  }
  assert.equal(existsSync(s.file), true, '非法请求不能删除凭据')
  gen.codexAuth.completeLogin = async () => ({ access: 'secret-access', refresh: 'secret-refresh', accountId: 'account-test', email: 'test@example.com' })
  const completed = await routes.get('/image/codex/complete')({ method: 'POST', headers: { 'content-type': 'application/json' } })
  assert.doesNotMatch(JSON.stringify(completed), /secret-access|secret-refresh/)
  off.forEach((fn) => fn())
  assert.deepEqual(gen.codexAuth.status(), { loggedIn: false })
  await assert.rejects(gen.codexAuth.startLogin({ openBrowser: false }), /卸载/)
  s.auth.dispose()
})
