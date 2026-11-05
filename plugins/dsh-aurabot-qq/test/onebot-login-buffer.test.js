// 登录核对期间收到的事件不能丢：核对通过后要补处理
// （真实场景：刚连上 QQ 那几百毫秒里，主人发一句话，以前会被直接丢掉）
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockOneBot } from './helpers/mock-onebot.js'
import { createFakeDsh } from './helpers/fake-dsh.js'

const OWNER = '10000001'
const BOT = '20000002'
const LOGIN_DELAY = 800 // 核对要慢一点，好让我们插进这个窗口
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 10000) => {
  const t = Date.now()
  while (Date.now() - t < ms) { if (await fn()) return true; await sleep(20) }
  return false
}

let mock
let fake
let dataDir
// before() 里抓现场，test 里断言（避免测试里做时序操作）
const seen = {}

const priv = (text) => ({
  post_type: 'message', message_type: 'private', sub_type: 'friend',
  self_id: Number(BOT), user_id: Number(OWNER), time: Math.floor(Date.now() / 1000),
  message_id: Math.floor(Math.random() * 1e6),
  message: [{ type: 'text', data: { text } }],
  sender: { user_id: Number(OWNER), nickname: '主人' },
})
const sends = () => mock.calls.filter((c) => c.action === 'send_private_msg' && String(c.params.user_id) === String(OWNER))

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'aurabot-login-buffer-'))
  process.env.AURABOT_DATA_DIR = dataDir
  process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
  mock = await startMockOneBot({ selfId: BOT, loginDelayMs: LOGIN_DELAY })
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    enabled: true,
    dryRun: false,
    setupDone: true,
    botQQ: BOT,
    ownerQQ: OWNER,
    allow: { private: [OWNER], groups: [] },
    // 连的是 mock，不是真的 SnowLuma
    snowluma: { autoStart: false, autoAttach: false, httpUrl: mock.httpUrl, wsUrl: mock.wsUrl, httpToken: mock.token, wsToken: mock.token, dir: join(dataDir, 'no-snowluma') },
    voice: { enabled: false },
    stickers: { autoChance: 0, collect: false },
    merge: { enabled: false },
  }))
  fake = createFakeDsh({ brain: async () => '收到啦' })
  const host = await import('../src/host.js')
  host.apply(fake.ctx)

  // 全新启动：第一轮连接就在核对。注意 reconnect 要等核对通过才返回，所以先不 await
  const reconnect = fake.call('/onebot/reconnect').catch(() => null)
  const started = await until(() => mock.calls.some((c) => c.action === 'get_login_info'))
  assert.ok(started, '连接后应该发起登录核对')
  seen.loginCall = mock.calls.filter((c) => c.action === 'get_login_info').at(-1)

  // 核对还没通过（get_login_info 要 800ms 才回），这时候塞一条消息进去
  mock.push(priv('刚连上的这句话别丢'))

  await reconnect
  const replied = await until(() => sends().length > 0)
  seen.replied = replied
  seen.sent = sends().at(-1)
})

after(async () => {
  fake?.dispose()
  await mock?.close()
  setTimeout(() => process.exit(0), 200).unref()
})

test('核对期间收到的消息，核对通过后补处理（不丢）', () => {
  assert.ok(seen.replied, '核对期间那条消息应该被补处理，并收到回复')
  assert.match(String(seen.sent.params.message?.[0]?.data?.text || ''), /收到/)
  // 确实是被"补处理"的：回复发生在核对完成之后，而不是当场就处理了
  const gap = seen.sent.t - seen.loginCall.t
  assert.ok(gap >= LOGIN_DELAY - 200, `回复应晚于核对完成（实际 ${gap}ms）`)
})
