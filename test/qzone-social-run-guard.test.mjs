import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-qzone-social-guard-'))

const { createQzoneSocial } = await import('../src/aurabot/src/features/qzone-social.js')

function setup({ enabled = true, dryRun = false, like = true, onRun = () => {}, extraFeeds = [] } = {}) {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-qzone-social-case-'))
  const calls = []
  const config = { enabled, dryRun, botQQ: '20002', ownerQQ: '10001', ownerName: '主人', qzoneSocial: { enabled: false, replyOwn: false, commentFriends: true, like, maxPerDay: 5, intervalMin: 30, friendChance: 1, ownerChance: 1 } }
  const feed = { appid: 311, uin: 30003, key: 'feed-1', time: Math.floor(Date.now() / 1000), nickname: '好友', html: '一条分享' }; const feeds = [feed, ...extraFeeds.map((f) => ({ ...feed, ...f }))]
  const onebot = { call: async (action, params, opts) => { calls.push({ action, params, opts }); if (action === 'get_qzone_feeds') return { feeds }; if (action === 'get_qzone_msg_detail') return { content: '分享正文', comments: [] }; return { ok: true } } }
  const hub = { selfId: '20002', logChat() {}, runSystemTurn: async () => { onRun(config); return '不错的分享' } }
  const log = { info() {}, debug() {}, warn() {} }
  return { social: createQzoneSocial({ getConfig: () => config, onebot, hub, log }), calls, config, feed }
}

test('force cannot bypass global disabled switch', async () => {
  const { social, calls } = setup({ enabled: false })
  const result = await social.run({ force: true })
  assert.equal(result.ok, false)
  assert.deepEqual(calls, [])
})

test('forced dryRun browse may read feeds but makes no likes or comments', async () => {
  const { social, calls } = setup({ enabled: true, dryRun: true })
  const result = await social.run({ force: true })
  assert.equal(result.ok, true)
  assert(calls.some((call) => call.action === 'get_qzone_feeds'))
  assert(calls.some((call) => call.action === 'get_qzone_msg_detail'))
  assert.equal(calls.some((call) => ['like_qzone', 'comment_qzone'].includes(call.action)), false)
})

test('comment send rechecks global switch after model wait', async () => {
  const { social, calls } = setup({ onRun: (config) => { config.enabled = false } })
  const result = await social.run({ force: true })
  assert.equal(result.ok, false)
  assert.equal(calls.some((call) => call.action === 'comment_qzone'), false)
})

test('live like is sent once only for eligible other-user feeds with exact payload and timeout', async () => {
  const now = Math.floor(Date.now() / 1000)
  const extras = [
    { key: 'self-feed', uin: '20002' },
    { key: 'old-feed', time: now - 86401 },
    { key: 'ad-feed', appid: 999 },
  ]
  const { social, calls, feed } = setup({ like: true, extraFeeds: extras })
  const result = await social.run({ force: true })
  assert.equal(result.ok, true)
  assert.deepEqual(calls.filter((call) => call.action === 'like_qzone'), [{
    action: 'like_qzone',
    params: { tid: feed.key, target_uin: Number(feed.uin), abstime: Number(feed.time) || 0 },
    opts: { timeoutMs: 20000 },
  }])
})

test('like_qzone=false suppresses like while leaving other browse behavior intact', async () => {
  const { social, calls } = setup({ like: false })
  const result = await social.run({ force: true })
  assert.equal(result.ok, true)
  assert.equal(calls.some((call) => call.action === 'like_qzone'), false)
})
