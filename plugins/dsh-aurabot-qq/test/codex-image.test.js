// ChatGPT 订阅生图：OAuth（Codex CLI 流程）+ 令牌刷新 + 生图请求形状
// 全部用假 fetch，不联网。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'aurabot-codex-'))
process.env.AURABOT_DATA_DIR = dataDir
mkdirSync(dataDir, { recursive: true })

const { createCodexAuth, createPkce, buildAuthUrl, parseAuthInput, accountIdOf, emailOf, decodeJwt, openInBrowser } = await import('../src/features/codex-auth.js')
const { createImageGen } = await import('../src/features/imagegen.js')
const { normalize } = await import('../src/core/config.js')

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)])
const b64 = PNG.toString('base64')
const silent = { info () {}, warn () {}, debug () {}, error () {} }
const CALLBACK = 'http://localhost:1455/auth/callback'

/** 造一个带 chatgpt_account_id / email 的 JWT（不验签，只需要 payload） */
function fakeJwt (payload) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${enc({ alg: 'none' })}.${enc(payload)}.sig`
}
const accessWith = (accountId) => fakeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })

/** 令牌响应（Codex 流程：带 id_token，JWT 里有 chatgpt_account_id） */
function tokenJson (overrides = {}) {
  return {
    access_token: accessWith('acc-1'),
    refresh_token: 'rt-1',
    id_token: fakeJwt({ email: 'me@example.com' }),
    expires_in: 3600,
    ...overrides,
  }
}

test('PKCE：challenge 是 verifier 的 sha256(base64url)', () => {
  const { verifier, challenge } = createPkce()
  assert.ok(verifier.length >= 43)
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'))
})

test('授权地址走 Codex CLI 流程（app_EMoa… + 固定 1455 回调）', () => {
  const url = new URL(buildAuthUrl({ challenge: 'CH', state: 'ST' }))
  assert.equal(url.origin + url.pathname, 'https://auth.openai.com/oauth/authorize')
  const p = url.searchParams
  assert.equal(p.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann')
  assert.equal(p.get('response_type'), 'code')
  assert.equal(p.get('redirect_uri'), CALLBACK)
  assert.equal(p.get('scope'), 'openid profile email offline_access')
  assert.equal(p.get('code_challenge'), 'CH')
  assert.equal(p.get('code_challenge_method'), 'S256')
  assert.equal(p.get('state'), 'ST')
  assert.equal(p.get('id_token_add_organizations'), 'true')
  assert.equal(p.get('codex_cli_simplified_flow'), 'true')
  assert.equal(p.get('originator'), 'pi')
  assert.equal(p.get('resource'), null, '这条流程不带 resource')
})

test('粘贴回调地址或裸 code 都能取出授权码', () => {
  assert.equal(parseAuthInput(`${CALLBACK}?code=abc&state=xyz`).code, 'abc')
  assert.equal(parseAuthInput(`${CALLBACK}?code=abc&state=xyz`).state, 'xyz')
  assert.equal(parseAuthInput('abc123').code, 'abc123')
  assert.equal(parseAuthInput('code=abc&state=1').code, 'abc')
})

test('JWT 里取 accountId / email', () => {
  assert.equal(accountIdOf(accessWith('acc-1'), ''), 'acc-1')
  assert.equal(emailOf(fakeJwt({ email: 'me@example.com' })), 'me@example.com')
  assert.equal(decodeJwt('garbage'), null)
})

test('令牌过期会刷新：带 client_id，账号 id 从新 token 里取', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: String(init.body) })
    return new Response(JSON.stringify(tokenJson({
      access_token: accessWith('acc-2'),
      id_token: fakeJwt({ email: 'new@example.com' }),
      refresh_token: 'rt-2',
    })), { status: 200 })
  }
  const auth = createCodexAuth({ log: silent, fetchImpl })
  writeFileSync(join(dataDir, 'codex-auth.json'), JSON.stringify({
    type: 'oauth', access: 'old', refresh: 'rt-1', expires: Date.now() - 1000, accountId: 'acc-1', email: 'old@example.com',
  }))
  const got = await auth.ensureAccess()
  assert.equal(got.accountId, 'acc-2')
  const body = calls[0].body
  assert.match(body, /grant_type=refresh_token/)
  assert.match(body, /refresh_token=rt-1/)
  assert.match(body, /client_id=app_EMoamEEZ73f0CkXaXp7hrann/)
  const st = auth.status()
  assert.equal(st.loggedIn, true)
  assert.equal(st.email, 'new@example.com')
  auth.logout()
  assert.equal(auth.status().loggedIn, false)
})

test('没登录时 ensureAccess 给出明确提示', async () => {
  const auth = createCodexAuth({ log: silent, fetchImpl: async () => new Response('{}') })
  auth.logout()
  await assert.rejects(() => auth.ensureAccess(), /还没登录 ChatGPT 订阅/)
})

test('刷新回来的 token 没带账号信息时，沿用上次的 accountId', async () => {
  const auth = createCodexAuth({
    log: silent,
    fetchImpl: async () => new Response(JSON.stringify(tokenJson({ access_token: fakeJwt({ sub: 'x' }), id_token: '' })), { status: 200 }),
  })
  writeFileSync(join(dataDir, 'codex-auth.json'), JSON.stringify({ type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() - 1, accountId: 'acc-old' }))
  const got = await auth.ensureAccess()
  assert.equal(got.accountId, 'acc-old', '账号 ID 不该因为刷新而丢掉')
  auth.logout()
})

test('首次拿到没有账号信息的 token 要报错（生图必须用）', async () => {
  const auth = createCodexAuth({
    log: silent,
    fetchImpl: async () => new Response(JSON.stringify(tokenJson({ access_token: fakeJwt({ sub: 'x' }), id_token: '' })), { status: 200 }),
  })
  writeFileSync(join(dataDir, 'codex-auth.json'), JSON.stringify({ type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() - 1 }))
  // 没有 accountId 的旧凭据会被当成未登录
  await assert.rejects(() => auth.ensureAccess(), /还没登录 ChatGPT 订阅/)
  auth.logout()
})

test('旧格式凭据（没有 accountId）当未登录处理', async () => {
  const auth = createCodexAuth({ log: silent, fetchImpl: async () => new Response('{}') })
  writeFileSync(join(dataDir, 'codex-auth.json'), JSON.stringify({ type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 3600_000, clientId: 'x' }))
  assert.deepEqual(auth.status(), { loggedIn: false })
  auth.logout()
})

test('生图请求：地址/头/请求体都对，b64 解成图片', async () => {
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push({ url, init })
    return new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const cfg = normalize({
    imageGen: { enabled: true, provider: 'codex', size: '1024x768', stylePrompt: '日系二次元', codex: { model: 'gpt-image-2', quality: 'high', background: 'opaque' } },
  })
  const gen = createImageGen({
    getConfig: () => cfg,
    log: silent,
    fetchImpl,
    codexAuth: { status: () => ({ loggedIn: true }), ensureAccess: async () => ({ access: 'TOKEN', accountId: 'ACC' }) },
  })
  assert.equal(gen.enabled(), true)
  const buf = await gen.generate('一只橘猫')
  assert.ok(Buffer.isBuffer(buf) && buf.length > 8)
  assert.equal(buf[0], 0x89)

  const { url, init } = seen[0]
  assert.equal(url, 'https://chatgpt.com/backend-api/codex/images/generations')
  assert.equal(init.method, 'POST')
  assert.equal(init.headers.authorization, 'Bearer TOKEN')
  assert.equal(init.headers['chatgpt-account-id'], 'ACC')
  assert.equal(init.headers.originator, 'pi')
  assert.ok(init.headers['x-codex-image-turn-id'])
  const body = JSON.parse(init.body)
  assert.equal(body.prompt, '日系二次元，一只橘猫')
  assert.equal(body.model, 'gpt-image-2')
  assert.equal(body.quality, 'high')
  assert.equal(body.size, 'auto', '这条端点不认尺寸，必须发 auto')
  assert.equal(body.background, 'opaque')
})

test('令牌过期（401）会刷新一次再重试', async () => {
  let n = 0
  let refreshed = 0
  const fetchImpl = async () => {
    n++
    if (n === 1) return new Response(JSON.stringify({ error: { message: 'token expired' } }), { status: 401 })
    return new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), { status: 200 })
  }
  const gen = createImageGen({
    getConfig: () => normalize({ imageGen: { enabled: true, provider: 'codex' } }),
    log: silent,
    fetchImpl,
    codexAuth: {
      status: () => ({ loggedIn: true }),
      ensureAccess: async (opts) => { if (opts && opts.force) refreshed++; return { access: 'T', accountId: 'A' } },
    },
  })
  const buf = await gen.generate('猫')
  assert.ok(buf.length > 8)
  assert.equal(refreshed, 1)
  assert.equal(n, 2)
})

test('403 / 429 给人话', async () => {
  const mk = (status) => createImageGen({
    getConfig: () => normalize({ imageGen: { enabled: true, provider: 'codex' } }),
    log: silent,
    fetchImpl: async () => new Response('{}', { status }),
    codexAuth: { status: () => ({ loggedIn: true }), ensureAccess: async () => ({ access: 'T', accountId: 'A' }) },
  })
  await assert.rejects(() => mk(403).generate('猫'), /不能用生图/)
  await assert.rejects(() => mk(429).generate('猫'), /额度|频繁/)
})

test('配置：codex 型号/质量越界会回落', () => {
  const c = normalize({ imageGen: { provider: 'codex', codex: { model: '乱写', quality: 'ultra', background: 'rainbow' } } }).imageGen
  assert.equal(c.codex.model, 'gpt-image-2')
  assert.equal(c.codex.quality, 'auto')
  assert.equal(c.codex.background, 'auto')
  assert.equal(c.provider, 'codex')
})

test('干净环境：没有令牌文件时 status 是未登录', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-codex-clean-'))
  process.env.AURABOT_DATA_DIR = dir
  const auth = createCodexAuth({ log: silent, fetchImpl: async () => new Response('{}') })
  assert.deepEqual(auth.status(), { loggedIn: false })
  assert.ok(!existsSync(join(dir, 'codex-auth.json')))
  process.env.AURABOT_DATA_DIR = dataDir
})

test('Windows 打开浏览器不能走 cmd（URL 里的 & 会被截断）', () => {
  const calls = []
  const run = (bin, args) => ({ unref () { calls.push({ bin, args }) } })
  const url = 'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_x&scope=a+b'
  assert.equal(openInBrowser(url, { run, platform: 'win32' }), true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].bin, 'rundll32')
  assert.equal(calls[0].args[1], url, '整条链接要原样交给浏览器')
  assert.ok(!/cmd/i.test(calls[0].bin), '不能走 cmd：& 会被当成命令分隔符')
  openInBrowser(url, { run, platform: 'darwin' })
  assert.equal(calls[1].bin, 'open')
  openInBrowser(url, { run, platform: 'linux' })
  assert.equal(calls[2].bin, 'xdg-open')
})

test('整合 #81：订阅接法保留构图优先级，通过提示词引导，尺寸仍由服务端选择', async () => {
  const seen = [], cfg = normalize({ imageGen: { enabled: true, provider: 'codex', shape: 'wide' } })
  const gen = createImageGen({ getConfig: () => cfg, log: silent,
    fetchImpl: async (_url, init) => { seen.push(JSON.parse(init.body)); return new Response(JSON.stringify({ data: [{ b64_json: b64 }] })) },
    codexAuth: { status: () => ({ loggedIn: true }), ensureAccess: async () => ({ access: 'test-access', accountId: 'test-account' }) },
  })
  await gen.generate('猫', { shape: 'portrait' })
  assert.match(seen[0].prompt, /2:3/)
  await gen.generate('猫')
  assert.match(seen[1].prompt, /16:9/)
  cfg.imageGen.shape = 'her'
  await gen.generate('猫')
  assert.equal(seen[2].prompt, '猫')
  assert.ok(seen.every((body) => body.size === 'auto'))
})
