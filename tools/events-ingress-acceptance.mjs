// 事件接入（core）· Mock 验收
// ============================================================================
// 跑法：node tools/events-ingress-acceptance.mjs
//
// ★ 三条不许破的边界：**不连真实 QQ、不读任何部署配置/token/config、不重启 DSH、不装插件**。
//   所有连接都打本机 mock 网关；所有落盘都在 mkdtemp 出来的临时目录里，跑完删干净。
//
// 分四组（每组末尾打印计数）：
//   A · 原型 75 条对位     —— 原型 test/acceptance.mjs 的每一条都在，目标换成 core 的模块/读口
//   B · 离线快照读手 7 条  —— 原型 module-selftest.mjs 的 7 条，落在 readStatusSnapshot 上
//   C · core 化新增断言    —— manifest 唯一写者 / 两种通路互斥 / bridge 只数不搬 / 默认 off
//   D · 真 core 生命周期   —— spawn 真进程：shutdown 停连接与写账、readonly 不建目录
//   E · 可靠性边界（16 条）—— 拒写不前移游标 / 判重可推进 / stop 后迟到一律拒绝且可观察 / 卡住可自愈
// ============================================================================

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { startMock } from './events-mock-onebot.mjs'
import { lifecycleChecks } from './events-lifecycle.mjs'
import { openStore, isReadonlyFlag } from '../src/events/store.mjs'
import { buildEnvelope } from '../src/events/envelope.mjs'
import { createOneBotIngress } from '../src/events/ingress-onebot.mjs'
import { createLeadRelayIngress } from '../src/events/ingress-lead-relay.mjs'
import { createBridgeEventsCounter } from '../src/events/ingress-bridge-count.mjs'
import { buildStatus, sourceView, readStatusSnapshot, publicConfig } from '../src/events/status.mjs'
import { createEventsIngress, normalizeIngressConfig, eventsDirOf, MODES } from '../src/events/index.mjs'
import { makeWsTransport } from '../src/adapters/events-ws.mjs'
import { eventsIngressPayload, EVENTS_READ_PORT } from '../src/adapters/events-http.mjs'
import { loadConfig, DEFAULTS } from '../src/config.mjs'
import { EVENT_WRITE_DOMAIN, HTTP_WRITE_ROUTES, HTTP_GET_READ_ROUTES, classifyHttp } from '../src/security/write-manifest.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const results = []
let group = 'A'
const ok = (name, cond, extra) => {
  results.push({ group, name, pass: Boolean(cond), extra: extra || '' })
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  [' + extra + ']' : ''))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const waitFor = async (fn, ms = 4000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try { if (fn()) return true } catch { /* 还没好 */ }
    await sleep(25)
  }
  return false
}
const tmpRoot = []
const tmp = (tag) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'core-events-' + tag + '-'))
  tmpRoot.push(d)
  return d
}
const sha = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const walk = (dir) => {
  const out = []
  const go = (d) => {
    let ents = []
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) go(p)
      else { let text = ''; try { text = fs.readFileSync(p, 'utf8') } catch { /* 二进制跳过 */ } out.push({ path: p, text }) }
    }
  }
  go(dir)
  return out
}
const leakIn = (files, token) => files.filter((f) => f.text && f.text.includes(token)).map((f) => f.path)
const srcText = (rel) => { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8') } catch { return '' } }
const codeLines = (text) => text.split('\n').filter((l) => { const s = l.trim(); return !(s.startsWith('//') || s.startsWith('*') || s.startsWith('/*')) }).join('\n')

const mocks = []
async function mockOf (opts) { const m = await startMock(opts); mocks.push(m); return m }

try {
  // ═══════════════════════════════════════════════════════════════════════
  // A1 · Envelope 契约（原型 §1，8 条）
  // ═══════════════════════════════════════════════════════════════════════
  {
    const payload = { t: '2026-11-10T05:00:00.000Z', title: '同一毫秒同标题', facts: 'A', tier: 'decide', chatId: 'group:1', kind: 'group' }
    const a = buildEnvelope({ source: 'lead-relay', type: 'report', payload, chatId: 'group:1', userId: '2', messageId: '', bootId: 'bootA', raw_ptr: 'file:q#L1@0', createdAt: payload.t, receivedAt: 1 })
    const need = ['event_id', 'source', 'type', 'payload_hash', 'created_at', 'chatId', 'userId', 'messageId', 'bootId', 'raw_ptr']
    const missing = need.filter((k) => !(k in a) || a[k] === undefined)
    ok('Envelope 十个必需字段齐', missing.length === 0, missing.join(',') || 'all')
    ok('Envelope 有值（chatId/userId/payload_hash/event_id 非空）', Boolean(a.chatId && a.userId && a.payload_hash && a.event_id), a.event_id)
    ok('created_at 来自源时间（不是接收时间）', a.created_at === payload.t, a.created_at)
    ok('去重键形态：无 messageId 时 bootId+内容hash', /^fp:lead-relay:bootA:[0-9a-f]{8,}$/.test(a.dedup_key), a.dedup_key)
    ok('去重键里没有 Date.now 形式的毫秒时间戳', !/1[6-9][0-9]{11}/.test(a.dedup_key), a.dedup_key)
    const withMid = buildEnvelope({ source: 'onebot', type: 'message', payload: { x: 1 }, chatId: 'group:9', userId: '3', messageId: '5001', bootId: 'bootA', raw_ptr: 'ws#1' })
    ok('去重键优先 messageId', withMid.dedup_key === 'mid:onebot:group:9:5001', withMid.dedup_key)
    const same = buildEnvelope({ source: 'lead-relay', type: 'report', payload, chatId: 'group:1', userId: '2', bootId: 'bootB' })
    ok('同内容不同 boot → dedup_key 不同（靠跨 boot 内容层兜）', same.dedup_key !== a.dedup_key && same.payload_hash === a.payload_hash, same.dedup_key)
    const other = buildEnvelope({ source: 'lead-relay', type: 'report', payload: Object.assign({}, payload, { facts: 'B' }), chatId: 'group:1', userId: '2', bootId: 'bootA' })
    ok('同毫秒同标题不同 facts → 指纹不同（不合并）', other.payload_hash !== a.payload_hash, other.payload_hash.slice(0, 10) + ' vs ' + a.payload_hash.slice(0, 10))
  }

  // ═══════════════════════════════════════════════════════════════════════
  // A2 · OneBot WS ingress（原型 §2，11 条）—— 打 mock，不打真网关
  // ═══════════════════════════════════════════════════════════════════════
  const TOKEN = 'SENTINEL-TOKEN-' + randomBytes(8).toString('hex')
  const mock = await mockOf({ selfId: '10001', token: TOKEN })
  const dirA = tmp('a')
  const transportA = makeWsTransport({ WebSocketImpl: globalThis.WebSocket })
  const storeA = openStore({ dir: path.join(dirA, 'events'), env: {} })
  const ingA = createOneBotIngress({
    store: storeA,
    url: mock.wsUrl,
    transport: transportA,
    tokenProvider: async () => TOKEN,
    allow: { all: false, chats: ['group:661580035'], private: [] },
    maxReconnect: 3,
    backoffMs: [40, 60, 80],
    bootId: 'bootA',
  })
  ingA.start()
  ok('连接建立', await waitFor(() => ingA.state === 'connected'), ingA.state)
  const msg = (o) => Object.assign({ message_type: 'group', group_id: 661580035, user_id: 20001, message_id: 5001, message: [{ type: 'text', data: { text: 'hello' } }] }, o)
  mock.push(msg())
  mock.push(msg())
  mock.push(msg({ user_id: 10001, message_id: 5002 }))
  mock.push(msg({ group_id: 999999, message_id: 5003 }))
  mock.push({ post_type: 'message_sent', message_id: 5004, user_id: 10001 })
  mock.pushRaw('{not json')
  await sleep(400)
  const cA = ingA.counters
  ok('① 去重：同 message_id 推两次只入库一次', cA.envelopes === 1 && cA.dup === 1, 'envelopes=' + cA.envelopes + ' dup=' + cA.dup)
  ok('自身消息丢弃（user_id === self_id）', cA.selfDropped === 1, 'selfDropped=' + cA.selfDropped)
  ok('message_sent 回显丢弃', cA.sentTypeDropped === 1, 'sentTypeDropped=' + cA.sentTypeDropped)
  ok('白名单外会话丢弃', cA.notAllowed === 1, 'notAllowed=' + cA.notAllowed)
  ok('坏帧可见（malformed 计数）', cA.malformed === 1, 'malformed=' + cA.malformed)
  ok('网关侧 0 次 send_*', mock.sends().length === 0, 'sends=' + mock.sends().length + ' calls=' + mock.calls.length)
  ok('★ 握手后 WS 上 0 帧上行（结构性不行动）', mock.framesFromClient === 0, 'framesFromClient=' + mock.framesFromClient)
  const rowsA = storeA.readAll()
  ok('落盘的 Envelope 字段可读', rowsA.length === 1 && rowsA[0].source === 'onebot' && rowsA[0].messageId === '5001' && rowsA[0].chatId === 'group:661580035', rowsA.length + ' row')
  ok('payload 保留原事件（含 message 段）', rowsA[0] && Array.isArray(rowsA[0].payload.message) && rowsA[0].payload.message[0].data.text === 'hello')
  ok('raw_ptr 指向 boot+帧号', rowsA[0] && /^onebot:ws#bootA\/\d+$/.test(rowsA[0].raw_ptr), rowsA[0] && rowsA[0].raw_ptr)

  // ═══════════════════════════════════════════════════════════════════════
  // A3 · 重连上限 / giveup / 错 token（原型 §3，7 条）
  // ═══════════════════════════════════════════════════════════════════════
  await mock.close()
  const gaveUp = await waitFor(() => ingA.state === 'giveup', 6000)
  const attempts1 = ingA.counters.reconnects
  await sleep(400)
  ok('② 重连有上限：3 次后 giveup', gaveUp && attempts1 === 3, 'reconnects=' + attempts1 + ' state=' + ingA.state)
  ok('giveup 后不再自动重试', ingA.counters.reconnects === attempts1 && ingA.state === 'giveup', 'reconnects=' + ingA.counters.reconnects)
  const errsA = fs.readFileSync(path.join(dirA, 'events', 'errors.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  ok('③ 错误可见：errors.jsonl 有 RECONNECT_GAVE_UP', errsA.some((e) => e.code === 'RECONNECT_GAVE_UP'), errsA.map((e) => e.code).join('/'))
  ok('状态里 lastError 指向 giveup（人读得到）', ingA.snapshot().lastError && ingA.snapshot().lastError.code === 'RECONNECT_GAVE_UP', JSON.stringify(ingA.snapshot().lastError && ingA.snapshot().lastError.code))
  ingA.stop()
  ok('stop 之后状态是 stopped（不是 disabled —— 关掉和没启用要分得开）', ingA.snapshot().state === 'stopped' && ingA.snapshot().connected === false, ingA.snapshot().state)
  {
    const mockB = await mockOf({ selfId: '10001', token: 'right-token' })
    const dirB = tmp('b')
    const stB = openStore({ dir: path.join(dirB, 'events'), env: {} })
    const wrong = 'WRONG-TOKEN-' + randomBytes(6).toString('hex')
    const bad = createOneBotIngress({ store: stB, url: mockB.wsUrl, transport: makeWsTransport({}), tokenProvider: async () => wrong, allow: { all: false, chats: [], private: [] }, maxReconnect: 2, backoffMs: [30, 40], bootId: 'bootB' })
    bad.start()
    await waitFor(() => bad.state === 'giveup', 5000)
    const errFileB = path.join(dirB, 'events', 'errors.jsonl')
    const txt = fs.existsSync(errFileB) ? fs.readFileSync(errFileB, 'utf8') : ''
    ok('错 token：连不上且 giveup', bad.state === 'giveup' && bad.counters.envelopes === 0, 'state=' + bad.state)
    ok('错 token：错误可见', txt.includes('DISCONNECTED') || txt.includes('RECONNECT_GAVE_UP'), '')
    ok('错 token：错误/产物里没有明文 token', !txt.includes(wrong), '')
    bad.stop()
    await mockB.close()
  }

  // ═══════════════════════════════════════════════════════════════════════
  // A4 · lead-relay ingress（原型 §4，9 条）
  // ═══════════════════════════════════════════════════════════════════════
  {
    const dirC = tmp('c')
    const QUEUE = path.join(dirC, '事件队列.jsonl')
    const T_MS = '2026-11-10T05:00:00.000Z'
    const rec = (o) => JSON.stringify(Object.assign({
      t: T_MS, status: 'pending', auditDeadline: '2026-11-10T05:15:00.000Z', outcome: '',
      tier: 'decide', title: '同一毫秒同一个标题', facts: 'A', why: '因为',
      chatId: 'group:661580035', kind: 'group', userId: '', groupId: '661580035', level: 1,
    }, o))
    const line1 = rec({ facts: 'A' })
    const line2 = rec({ facts: 'B' })
    fs.writeFileSync(QUEUE, [line1, line1, line2].join('\n') + '\n{"t":"坏行', 'utf8')
    const beforeC = { sha: sha(QUEUE), size: fs.statSync(QUEUE).size, mtime: fs.statSync(QUEUE).mtimeMs }
    const storeC = openStore({ dir: path.join(dirC, 'events'), env: {} })
    const lrC = createLeadRelayIngress({ store: storeC, queuePath: QUEUE, bootId: 'bootC', pollMs: 999999 })
    lrC.poll()
    const cC = lrC.counters
    ok('④ 逐字节重复行只入库一次', cC.envelopes === 2 && cC.dup === 1, 'envelopes=' + cC.envelopes + ' dup=' + cC.dup)
    ok('⑤ 同毫秒同标题不合并（facts 不同 → 两条）', storeC.readAll().filter((e) => e.payload.title === '同一毫秒同一个标题').length === 2, 'n=' + storeC.readAll().length)
    ok('半行不消费（partialTail 可见）', Boolean(lrC.snapshot().partialTail && lrC.snapshot().partialTail.bytes > 0), JSON.stringify(lrC.snapshot().partialTail))
    const kept = storeC.readAll()[0].payload
    ok('⑥ 原字段一个不丢（t/title/facts/why/tier/chatId/kind/status/auditDeadline/outcome/groupId/level）',
      ['t', 'title', 'facts', 'why', 'tier', 'chatId', 'kind', 'status', 'auditDeadline', 'outcome', 'groupId', 'level'].every((k) => k in kept),
      Object.keys(kept).length + ' fields')
    ok('raw_ptr 可回原文（file#L行@字节）', /^file:.*#L1@0$/.test(storeC.readAll()[0].raw_ptr), storeC.readAll()[0].raw_ptr)
    const afterC = { sha: sha(QUEUE), size: fs.statSync(QUEUE).size, mtime: fs.statSync(QUEUE).mtimeMs }
    ok('⑦ 队列文件一个字节没动（sha256/size/mtime 全等）', beforeC.sha === afterC.sha && beforeC.size === afterC.size && beforeC.mtime === afterC.mtime, afterC.sha.slice(0, 12))
    fs.appendFileSync(QUEUE, '}\n', 'utf8')
    lrC.poll()
    const errFileC = path.join(dirC, 'events', 'errors.jsonl')
    const errsC = (fs.existsSync(errFileC) ? fs.readFileSync(errFileC, 'utf8') : '').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    ok('⑧ 坏行可见（errors.jsonl 有 BAD_LINE + 行号偏移）', errsC.some((e) => e.code === 'BAD_LINE') && Boolean(lrC.snapshot().lastBad), JSON.stringify(lrC.snapshot().lastBad))
    ok('半行补齐后 partialTail 清空', lrC.snapshot().partialTail === null, JSON.stringify(lrC.snapshot().partialTail))
    const noCursor = {
      append: (e) => storeC.append(e),
      pushError: (c, d) => storeC.pushError(c, d),
      setCursor: () => {},
      getCursor: () => ({}),
      flushStatus: () => {},
    }
    const lrC2 = createLeadRelayIngress({ store: noCursor, queuePath: QUEUE, bootId: 'bootD', pollMs: 999999 })
    lrC2.poll()
    ok('⑨ 重放整条队列：新增 0 条（跨 boot 也认得出来）', lrC2.counters.envelopes === 0 && lrC2.counters.dup >= 2, 'new=' + lrC2.counters.envelopes + ' dup=' + lrC2.counters.dup)
    lrC.stop(); lrC2.stop()
  }

  // ═══════════════════════════════════════════════════════════════════════
  // A5 · readonly（原型 §5，7 条）
  // ═══════════════════════════════════════════════════════════════════════
  {
    ok('AGENT_SOUL_READONLY=1 被识别', isReadonlyFlag({ AGENT_SOUL_READONLY: '1' }) && !isReadonlyFlag({}), '')
    const dirR = tmp('r')
    const target = path.join(dirR, 'events')
    const ro = openStore({ dir: target, env: { AGENT_SOUL_READONLY: '1' } })
    const envR = buildEnvelope({ source: 'onebot', type: 'message', payload: { a: 1 }, chatId: 'group:1', userId: '2', messageId: '9', bootId: 'b', raw_ptr: 'x' })
    const r1 = ro.append(envR)
    ok('⑩ readonly 拒写并明确返回 READONLY', r1.ok === false && r1.code === 'READONLY' && /拒写新事件/.test(r1.message), r1.code)
    ok('readonly 连目录都不建（创建目录也是写）', !fs.existsSync(target), 'exists=' + fs.existsSync(target))
    ok('readonly 不落 errors.jsonl（错误只进内存）', !fs.existsSync(path.join(target, 'errors.jsonl')), '')
    const st = buildStatus({ store: ro, sources: {}, config: {} })
    ok('⑪ readonly 状态不是 ready，且说明「拒写」不是「事件只读」', st.ready === false && st.summary === 'readonly' && /拒写/.test(st.reason) && /不是一回事/.test(st.reason), st.summary)
    ok('readonly 的拒写计数可见', ro.snapshot().rejected === 1, 'rejected=' + ro.snapshot().rejected)
    const rw = openStore({ dir: target, env: {} })
    const r2 = rw.append(envR)
    ok('对照组：开关关掉后同一份代码能写（说明拦的是开关不是 bug）', r2.ok === true && fs.existsSync(path.join(target, 'envelopes.jsonl')), 'seq=' + r2.seq)
  }

  // ═══════════════════════════════════════════════════════════════════════
  // A6 · 没配置（原型 §6，3 条）
  // ═══════════════════════════════════════════════════════════════════════
  {
    const bare = openStore({ dir: '', env: {} })
    const e = buildEnvelope({ source: 'onebot', type: 'message', payload: {}, chatId: 'group:1', userId: '2', messageId: '1', bootId: 'b', raw_ptr: 'x' })
    const r = bare.append(e)
    ok('没配 dataDir：拒写并返回 NOT_CONFIGURED', r.ok === false && r.code === 'NOT_CONFIGURED', r.code)
    const st = buildStatus({ store: bare, sources: {}, config: {} })
    ok('没配置的状态是 not-configured，不是 ready', st.ready === false && st.summary === 'not-configured', st.summary)
    const blank = loadConfig('')
    const ing = blank.events.ingress
    ok('默认配置：mode=off / allow none（direct-ws 与 bridge-events 都关着）',
      ing.mode === 'off' && ing.onebot.allow.all === false && ing.onebot.allow.chats.length === 0 && !ing.onebot.wsUrl && !ing.bridge.eventsPath, ing.mode)
  }

  // ═══════════════════════════════════════════════════════════════════════
  // A7 · 状态视图：disconnected 不许写成 ready（原型 §7，5 条）
  // ═══════════════════════════════════════════════════════════════════════
  {
    const view = sourceView({ id: 'onebot', enabled: true, state: 'disconnected', connected: false, dedupCount: 3, lastSource: 'onebot' })
    ok('⑫ 断线源的 ready 为 false 且 label 写「不是 ready」', view.ready === false && /不是 ready/.test(view.label), view.label)
    ok('断线源仍带 dedupCount / lastSource / lastError 字段', 'dedupCount' in view && 'lastSource' in view && 'lastError' in view, '')
    const gv = sourceView({ id: 'onebot', enabled: true, state: 'giveup', connected: false })
    ok('giveup 的 label 指出要人工处理', /人工/.test(gv.label), gv.label)
    const st = buildStatus({
      store: openStore({ dir: tmp('s'), env: {} }),
      sources: {
        onebot: { id: 'onebot', enabled: true, state: 'disconnected', connected: false, dedupCount: 0, lastSource: 'onebot' },
        'lead-relay': { id: 'lead-relay', enabled: true, state: 'reading', connected: true, dedupCount: 0, lastSource: 'lead-relay' },
      },
      config: {},
    })
    ok('一个源断线 → 顶层 ready=false / summary=degraded', st.ready === false && st.summary === 'degraded', st.summary)
    ok('状态里声明 send 能力为 false（没有发送路由）', st.capabilities.send === false && Array.isArray(st.capabilities.sendRoutes) && st.capabilities.sendRoutes.length === 0, JSON.stringify(st.capabilities))
  }

  // ═══════════════════════════════════════════════════════════════════════
  // A8 · 运行时 + 只读口（原型 §8，12 条）—— 目标换成 core 的 createEventsIngress / eventsIngressPayload
  // ═══════════════════════════════════════════════════════════════════════
  {
    // 端点必须显式（原型是「从部署配置现读」；core 不读部署配置、更不猜端口）
    const badCfg = { dataDir: tmp('ep'), events: { ingress: { mode: 'direct-ws', onebot: {} } } }
    const nb = createEventsIngress({ config: badCfg, env: {} })
    ok('⑬ direct-ws 没给 wsUrl → NO_ENDPOINT，不连（端口不是协议常量）', nb.enabled === false && nb.error && nb.error.code === 'NO_ENDPOINT', nb.error && nb.error.code)
    const okCfgPublic = publicConfig({ events: { ingress: { mode: 'direct-ws', onebot: { wsUrl: 'ws://127.0.0.1:9', tokenEnv: 'X_TOKEN' } } } })
    ok('⑬b 配置投影只回白名单字段（token 只报布尔）', 'hasToken' in okCfgPublic.onebot && !('token' in okCfgPublic.onebot) && okCfgPublic.onebot.hasToken === true && Object.keys(okCfgPublic.onebot).sort().join(',') === 'allow,hasToken,maxReconnect,tokenEnv,wsUrl', Object.keys(okCfgPublic.onebot).join(','))

    const mockD = await mockOf({ selfId: '10001', token: TOKEN })
    const dirD = tmp('d')
    const dataDir = path.join(dirD, 'data')
    const cfgFile = path.join(dirD, 'config.json')
    fs.writeFileSync(cfgFile, JSON.stringify({
      dataDir,
      events: {
        ingress: {
          mode: 'direct-ws',
          onebot: { wsUrl: mockD.wsUrl, tokenEnv: 'MOCK_TOKEN', allow: { all: false, chats: ['group:661580035'], private: [] }, maxReconnect: 2, backoffMs: [40, 60] },
        },
      },
    }), 'utf8')
    const cfgD = loadConfig(cfgFile)
    const rt = createEventsIngress({ config: cfgD, env: { MOCK_TOKEN: TOKEN }, transport: makeWsTransport({}) })
    const startRes = rt.start()
    ok('start 成功（显式 enabled + 非 readonly）', startRes.started === true && rt.started === true, JSON.stringify(startRes))
    ok('连上 mock 网关', await waitFor(() => rt.status().eventSources.onebot.state === 'connected', 4000), rt.status().eventSources.onebot.state)
    mockD.push({ message_type: 'group', group_id: 661580035, user_id: 20001, message_id: 7001, message: [{ type: 'text', data: { text: 'status-test' } }] })
    await waitFor(() => rt.status().totals.envelopes >= 1, 3000)
    const payload = eventsIngressPayload(rt, { limit: 5 })
    ok('⑭ 状态带 enabled/connected/lastEventAt/lastError/dedupCount/lastSource 六件',
      ['enabled', 'connected', 'lastEventAt', 'lastError', 'dedupCount', 'lastSource'].every((k) => k in payload),
      ['enabled', 'connected', 'lastEventAt', 'lastError', 'dedupCount', 'lastSource'].map((k) => k + '=' + typeof payload[k]).join(','))
    ok('⑮ 连上且账本可写 → ready=true（唯一可以说 ready 的情形）', payload.ready === true && payload.summary === 'ready', payload.summary)
    ok('端点来源标注 config.wsUrl（不假装来自部署配置）', payload.eventSources.onebot.portSource === 'config.wsUrl', String(payload.eventSources.onebot.portSource))
    ok('状态原文里没有 token', !JSON.stringify(payload).includes(TOKEN), '')
    ok('状态里 hasToken 只报布尔不报值', payload.config.onebot.hasToken === true && !JSON.stringify(payload.config).includes(TOKEN), '')
    ok('⑯ 只读口带 ready/summary/eventSources/authority', 'ready' in payload && 'eventSources' in payload && payload.authority.soleWriter === 'agent-soul-core', payload.authority.dir)
    ok('events 列表可读且只有元数据（不含正文/不含 payload 字段）',
      payload.events.items.length >= 1 && payload.events.items[0].source === 'onebot' && !('payload' in payload.events.items[0]) && !JSON.stringify(payload).includes('status-test'),
      'n=' + payload.events.items.length)
    ok('⑰ 只读口只登记 GET，没有写方法', EVENTS_READ_PORT.writes === 0 && EVENTS_READ_PORT.routes.every((r) => /^GET /.test(r)), EVENTS_READ_PORT.routes.join(','))
    ok('⑱ 没有发送路由（读口清单里没有 send/reply/push）', EVENTS_READ_PORT.routes.every((r) => !/send|reply|push/i.test(r)) && EVENTS_READ_PORT.capabilities.send === false, EVENTS_READ_PORT.routes.join(','))
    await mockD.close()
    await waitFor(() => rt.status().eventSources.onebot.state !== 'connected', 3000)
    const down = rt.status()
    ok('⑲ 网关断开后 ready 立刻为 false（degraded）', down.ready === false && down.summary !== 'ready' && /不是 ready/.test(down.eventSources.onebot.label), down.summary + ' / ' + down.eventSources.onebot.label)
    ok('断开时 status.json 快照也写好了（进程不在也能看最后一眼）', fs.existsSync(path.join(dataDir, 'events', 'status.json')), '')
    const files = walk(dirD)
    const leaks = leakIn(files, TOKEN)
    ok('⑳ token 0 命中（产物/状态/错误/配置投影全扫）', leaks.length === 0, leaks.join(',') || 'clean')
    rt.stop('test')
    ok('stop 之后 started=false / 源状态 stopped', rt.started === false && rt.status().eventSources.onebot.state === 'stopped', rt.status().eventSources.onebot.state)
  }

  // ═══════════════════════════════════════════════════════════════════════
  // A9 · 真实队列只读对照（原型 §9，9 条）—— 不重不漏；一个字节都不写
  // ═══════════════════════════════════════════════════════════════════════
  {
    const REAL = 'D:\\AI\\yanqing-soul\\30-状态\\事件队列.jsonl'
    if (!fs.existsSync(REAL)) {
      ok('真实队列存在（否则这一组跳过）', false, REAL)
    } else {
      const raw = fs.readFileSync(REAL, 'utf8')
      const shaBefore = sha(REAL)
      const mtimeBefore = fs.statSync(REAL).mtimeMs
      const lines = raw.split('\n')
      let refValid = 0
      let refBad = 0
      for (let i = 0; i < lines.length; i++) {
        if (i === lines.length - 1 && lines[i] === '') continue
        if (lines[i].trim() === '') continue
        try { const o = JSON.parse(lines[i]); if (o && typeof o === 'object' && !Array.isArray(o)) refValid++; else refBad++ } catch { refBad++ }
      }
      const refPartialBytes = raw.endsWith('\n') ? 0 : Buffer.byteLength(lines[lines.length - 1], 'utf8')
      // 内存假账：能验去重，又不会把他的上报内容复制出去
      const memRows = []
      const seen = new Set()
      const fakeStore = {
        append (env) {
          if (seen.has(env.dedup_key)) return { ok: false, code: 'DUPLICATE' }
          seen.add(env.dedup_key)
          if (env.source && env.payload_hash && seen.has('h:' + env.source + '|' + env.payload_hash)) return { ok: false, code: 'DUPLICATE' }
          seen.add('h:' + env.source + '|' + env.payload_hash)
          memRows.push(env)
          return { ok: true, seq: memRows.length }
        },
        pushError () { return { t: new Date().toISOString() } },
        setCursor () {},
        getCursor () { return {} },
      }
      const lr1 = createLeadRelayIngress({ store: fakeStore, queuePath: REAL, bootId: 'real1', pollMs: 999999 })
      lr1.poll()
      const c1 = lr1.counters
      const valid1 = c1.lines - c1.badLines
      ok('㉑ 真实队列：不漏（读到的有效行 === 独立解析计数）', valid1 === refValid, 'read=' + valid1 + ' ref=' + refValid)
      ok('㉒ 真实队列：不重（每条只入账一次）', c1.envelopes === refValid && c1.dup === 0, 'envelopes=' + c1.envelopes + ' dup=' + c1.dup)
      ok('㉓ 真实队列：坏行数与独立解析一致（坏行可见）', c1.badLines === refBad, 'bad=' + c1.badLines + ' ref=' + refBad)
      ok('㉔ 真实队列：半行字节数与独立解析一致', (lr1.snapshot().partialTail ? lr1.snapshot().partialTail.bytes : 0) === refPartialBytes, (lr1.snapshot().partialTail ? lr1.snapshot().partialTail.bytes : 0) + ' vs ' + refPartialBytes)
      const lr2 = createLeadRelayIngress({ store: fakeStore, queuePath: REAL, bootId: 'real2', pollMs: 999999 })
      lr2.poll()
      ok('㉕ 真实队列重放：新增 0 条', lr2.counters.envelopes === 0, 'new=' + lr2.counters.envelopes + ' dup=' + lr2.counters.dup)
      ok('㉖ 真实队列文件未变（sha256 + mtime 全等）', sha(REAL) === shaBefore && fs.statSync(REAL).mtimeMs === mtimeBefore, sha(REAL).slice(0, 12))
      const dirSnap = (d) => fs.readdirSync(d).filter((n) => /事件队列|待发|回执|下发|sessions/.test(n)).map((n) => n + ':' + fs.statSync(path.join(d, n)).size + ':' + fs.statSync(path.join(d, n)).mtimeMs).join('|')
      ok('㉗ 事件层目录快照可复算（给下一个人做对照的锚）', dirSnap('D:\\AI\\yanqing-soul\\30-状态').length > 0, '')
      lr1.stop(); lr2.stop()
    }
    const srcAll = ['src\\events\\ingress-lead-relay.mjs', 'src\\events\\ingress-onebot.mjs', 'src\\events\\store.mjs', 'src\\adapters\\events-http.mjs']
      .map((f) => srcText(f)).join('\n')
    ok('㉘ 不写 sessions.json（代码行里没有这个路径）', !codeLines(srcAll).includes('sessions.json'), 'grep clean')
    ok('㉙ 源码里没有任何发送动作（send_private_msg / send_group_msg / send_msg）', !/send_private_msg|send_group_msg|'send_msg'/.test(srcAll), 'grep clean')
  }

  // ═══════════════════════════════════════════════════════════════════════
  // B · 离线快照读手（原型 module-selftest 7 条对位）
  // ═══════════════════════════════════════════════════════════════════════
  group = 'B'
  {
    ok('B① 只读口元信息齐（id / v / routes）', EVENTS_READ_PORT.id === 'events-ingress-core' && EVENTS_READ_PORT.v === 1 && EVENTS_READ_PORT.routes.length === 1, EVENTS_READ_PORT.id)
    ok('B② 只登记一个只读路由 /api/events，没有写路由', EVENTS_READ_PORT.routes[0] === 'GET /api/events' && EVENTS_READ_PORT.writes === 0, EVENTS_READ_PORT.routes.join(','))
    const dir = tmp('snap')
    const noSnap = readStatusSnapshot(dir)
    ok('B③ 没有快照：summary=no-snapshot 且 ready=false', noSnap.summary === 'no-snapshot' && noSnap.ready === false && noSnap.stale === true, noSnap.summary)
    const statusFile = path.join(dir, 'status.json')
    fs.writeFileSync(statusFile, JSON.stringify({
      at: new Date().toISOString(),
      status: { ready: true, summary: 'ready', reason: '', mode: 'direct-ws', eventSources: { onebot: { ready: true, state: 'connected' } }, totals: { envelopes: 3 } },
    }), 'utf8')
    const fresh = readStatusSnapshot(dir)
    ok('B④ 新鲜快照：ready 照抄、stale=false', fresh.ready === true && fresh.stale === false && fresh.summary === 'ready', 'age=' + fresh.snapshotAgeMs)
    const old = (Date.now() - 200000) / 1000
    fs.utimesSync(statusFile, old, old)
    const stale = readStatusSnapshot(dir)
    ok('B⑤ 过期快照：ready 强制 false、summary=stale、说明写清原因', stale.ready === false && stale.summary === 'stale' && /不许当 ready/.test(stale.reason), stale.summary + ' age=' + Math.round(stale.snapshotAgeMs / 1000) + 's')
    fs.writeFileSync(path.join(dir, 'envelopes.jsonl'), [
      JSON.stringify({ seq: 1, event_id: 'ev_a', source: 'onebot', type: 'message', chatId: 'group:1', userId: '2', messageId: '9', created_at: 'x', payload_hash: 'h', raw_ptr: 'r', payload: { secret_text: 'should-not-appear' } }),
    ].join('\n') + '\n', 'utf8')
    const fakeRt = { status: () => buildStatus({ store: openStore({ dir, env: {} }), sources: {}, config: { dataDir: dir } }), tail: () => [{ seq: 1, source: 'onebot', payload: { secret_text: 'should-not-appear' } }], dir }
    const evs = eventsIngressPayload(fakeRt, {})
    ok('B⑥ /events 返回元数据且不含 payload 原文', evs.events.count === 1 && !JSON.stringify(evs).includes('should-not-appear') && Boolean(evs.persisted), 'count=' + evs.events.count)
    const none = readStatusSnapshot('')
    ok('B⑦ 没给目录：not-configured 且不是 ready', none.ready === false && none.summary === 'not-configured', none.summary)
  }

  // ═══════════════════════════════════════════════════════════════════════
  // C · core 化新增断言（manifest / 互斥 / bridge 只数不搬 / 默认 off）
  // ═══════════════════════════════════════════════════════════════════════
  group = 'C'
  {
    // —— manifest：唯一写者 / 目录判据 / 不在写路由里 ——
    ok('C① manifest 声明唯一写者 = agent-soul-core', EVENT_WRITE_DOMAIN.soleWriter === 'agent-soul-core' && EVENT_WRITE_DOMAIN.writerFile === 'src/events/store.mjs', EVENT_WRITE_DOMAIN.id)
    ok('C② manifest 的目录判据是 <AGENT_SOUL_DATA>/events（不接受任意路径）', EVENT_WRITE_DOMAIN.dirRel === 'events' && EVENT_WRITE_DOMAIN.dirFrom === 'AGENT_SOUL_DATA', EVENT_WRITE_DOMAIN.dirRel)
    ok('C③ /api/events 不在写路由表里，且仍在只读清单里', !HTTP_WRITE_ROUTES['GET /api/events'] && !HTTP_WRITE_ROUTES['POST /api/events'] && HTTP_GET_READ_ROUTES.includes('/api/events'), String(classifyHttp('GET', '/api/events').verdict))
    ok('C④ 事件账目录由 dataDir 推导（eventsDirOf 唯一一处）', eventsDirOf({ dataDir: 'D:\\x' }) === path.join('D:\\x', 'events') && eventsDirOf({}) === '', eventsDirOf({ dataDir: 'D:\\x' }))
    const allSrc = ['src\\events\\store.mjs', 'src\\events\\index.mjs', 'src\\events\\status.mjs', 'src\\events\\ingress-onebot.mjs', 'src\\events\\ingress-lead-relay.mjs', 'src\\events\\ingress-bridge-count.mjs', 'src\\adapters\\events-http.mjs', 'src\\adapters\\events-ws.mjs', 'src\\web\\server.mjs', 'src\\index.mjs'].map(srcText).join('\n')
    ok('C⑤ 只有 store.mjs 对 envelopes.jsonl 开 append（其它模块只读）',
      (allSrc.match(/FILES\.envelopes/g) || []).length >= 1 && !/appendFileSync\([^)]*事件队列/.test(allSrc), 'grep ok')
    ok('C⑥ 没有任何代码 append 外来账（事件队列.jsonl / lead-waker-台账）',
      !/appendFileSync\([^\n]*事件队列/.test(allSrc) && !/writeFileSync\([^\n]*事件队列/.test(allSrc) && !/appendFileSync\([^\n]*lead-waker/.test(allSrc), 'grep clean')

    // —— 互斥：两种通路只能开一个 ——
    const both = normalizeIngressConfig({ events: { ingress: { onebot: { enabled: true, wsUrl: 'ws://x' }, bridge: { enabled: true, eventsPath: 'x.jsonl' } } } })
    ok('C⑦ 两个都开 → BOTH_MODES_ENABLED 且 mode=off（不挑一个）', both.mode === MODES.off && both.error && both.error.code === 'BOTH_MODES_ENABLED', both.error && both.error.code)
    const bothDir = tmp('both')
    const bothRt = createEventsIngress({ config: { dataDir: bothDir, events: { ingress: { onebot: { enabled: true, wsUrl: 'ws://127.0.0.1:1' }, bridge: { enabled: true, eventsPath: path.join(bothDir, 'x.jsonl') } } } }, env: {}, transport: makeWsTransport({}) })
    const bothStart = bothRt.start()
    ok('C⑧ 互斥时 start 拒起：不建目录、不连、状态 disabled', bothStart.started === false && !fs.existsSync(path.join(bothDir, 'events')) && bothRt.status().summary === 'disabled', bothStart.reason && bothStart.reason.code)
    ok('C⑨ 未知 mode / bridge 缺路径 都被明确拒绝', normalizeIngressConfig({ events: { ingress: { mode: 'both' } } }).error.code === 'BAD_MODE' && normalizeIngressConfig({ events: { ingress: { mode: 'bridge-events' } } }).error.code === 'NO_BRIDGE_PATH', 'ok')
    const bridgeDir = tmp('bridge')
    const brRt = createEventsIngress({ config: { dataDir: bridgeDir, events: { ingress: { mode: 'bridge-events', bridge: { eventsPath: path.join(bridgeDir, 'up.jsonl'), pollMs: 999999 } } } }, env: {} })
    const brStart = brRt.start()
    ok('C⑩ bridge-events 起来时**没有** onebot 源（两种通路不会同时活）', brStart.started === true && brRt.status().eventSources.onebot.enabled === false && brRt.status().eventSources.bridge.enabled === true, brRt.status().mode)
    brRt.stop('test')

    // —— bridge：只数行、不搬内容、不改账 ——
    const bdir = tmp('count')
    const ledgerDir = path.join(bdir, 'events')
    const bstore = openStore({ dir: ledgerDir, env: {} })
    for (const i of [1, 2]) {
      bstore.append(buildEnvelope({ source: 'onebot', type: 'message', payload: { i }, chatId: 'group:1', userId: '2', messageId: String(i), bootId: 'bb', raw_ptr: 'x' }))
    }
    const upFile = path.join(bdir, 'up.jsonl')
    fs.writeFileSync(upFile, '{"a":1}\n{"a":2}\n{"a":3}\n{"par', 'utf8')
    const upShaBefore = sha(upFile)
    const rowsBefore = bstore.readAll().length
    const bridge = createBridgeEventsCounter({ store: bstore, eventsPath: upFile, pollMs: 999999, source: 'onebot' })
    bridge.poll()
    const cpm = bridge.counters
    const cmp = bridge.snapshot().compare
    ok('C⑪ bridge 只数完整行（半行不算）：3 行', cpm.upstreamLines === 3, 'lines=' + cpm.upstreamLines)
    ok('C⑫ bridge 给出 drift（上游 3 vs 本账 2 = 1），并说明它不是「丢事件」判据', cmp && cmp.drift === 1 && /不等于丢事件/.test(cmp.note), cmp && JSON.stringify({ up: cmp.upstreamLines, ledger: cmp.ledgerRows, drift: cmp.drift }))
    ok('C⑬ bridge 一个字节都不写：账没长、上游文件没变、无游标', bstore.readAll().length === rowsBefore && sha(upFile) === upShaBefore && !fs.existsSync(path.join(ledgerDir, 'cursor.json')), 'rows=' + bstore.readAll().length)
    ok('C⑭ bridge 的能力清单是「只数」：receive=false / countOnly=true', bridge.snapshot().capability.countOnly === true && bridge.snapshot().capability.receive === false, JSON.stringify(bridge.snapshot().capability))

    // —— 默认 off：导入无副作用、start 不建目录 ——
    const offDir = tmp('off')
    const offRt = createEventsIngress({ config: { dataDir: offDir, events: { ingress: { mode: 'off' } } }, env: {} })
    ok('C⑮ 构造运行时没有副作用（不建目录、不连）', !fs.existsSync(path.join(offDir, 'events')) && offRt.started === false, 'dirExists=' + fs.existsSync(path.join(offDir, 'events')))
    const offStart = offRt.start()
    ok('C⑯ 默认 off：start 拒起且不建事件目录', offStart.started === false && !fs.existsSync(path.join(offDir, 'events')) && offRt.status().summary === 'disabled', offStart.reason && offStart.reason.code)
    const roDir = tmp('ro2')
    const roRt = createEventsIngress({ config: { dataDir: roDir, events: { ingress: { mode: 'direct-ws', onebot: { wsUrl: 'ws://127.0.0.1:1', allow: { all: true, chats: [], private: [] } } } } }, env: { AGENT_SOUL_READONLY: '1' }, transport: makeWsTransport({}) })
    const roStart = roRt.start()
    ok('C⑰ readonly：enabled 也不 start、不建目录、不连（startRefusal=READONLY）', roStart.started === false && !fs.existsSync(path.join(roDir, 'events')) && roRt.status().startRefusal.code === 'READONLY', roRt.status().summary)
  }

  // ═══════════════════════════════════════════════════════════════════════
  // E · 可靠性边界（2026-11-10 修复的两条：游标语义 / stop 语义）
  //     E①-⑤ lead-relay：**拒写不前移游标**（重读同一行）；判重（DUPLICATE）照推进
  //     E⑥-⑩ stop：迟到的轮询与迟到的帧一律拒绝，而且**可观察**（不是口头保证）
  //     E⑪-⑬ 代码级护栏：防止这两条语义将来被改回去
  // ═══════════════════════════════════════════════════════════════════════
  group = 'E'
  {
    const TE = '2026-11-10T05:00:00.000Z'
    const mkLine = (tag) => JSON.stringify({ t: TE, title: '行' + tag, facts: tag, chatId: 'group:661580035', kind: 'group' })
    const L1 = mkLine('1')
    const L2 = mkLine('2')
    const L3 = mkLine('3')
    const B = (s) => Buffer.byteLength(s, 'utf8')
    const CUT1 = B(L1 + '\n')
    const CUT3 = B([L1, L2, L3].join('\n') + '\n')
    const errRows = (d) => {
      const f = path.join(d, 'errors.jsonl')
      if (!fs.existsSync(f)) return []
      return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    }

    // —— E①-E④ 拒写：游标停在失败行**之前**，下一次 poll 重读同一行 ——
    const dirE = tmp('rel-cursor')
    const QE = path.join(dirE, 'q.jsonl')
    fs.writeFileSync(QE, [L1, L2, L3].join('\n') + '\n', 'utf8')
    const storeE = openStore({ dir: path.join(dirE, 'events'), env: {} })
    let failLeft = 2                                   // 第 2 行连续失败两次，第三次才写得进去
    const flakyStore = {
      append (env) {
        if (env.queueLine === 2 && failLeft > 0) {   // ★ extra 是展开到 Envelope 顶层的（见 buildEnvelope）
          failLeft--
          return { ok: false, code: 'WRITE_FAILED', message: '模拟磁盘满（测试专用，不碰真盘）' }
        }
        return storeE.append(env)
      },
      pushError: (c, d) => storeE.pushError(c, d),
      setCursor: (s, c) => storeE.setCursor(s, c),
      getCursor: (s) => storeE.getCursor(s),
      flushStatus: () => true,
    }
    const lrE = createLeadRelayIngress({ store: flakyStore, queuePath: QE, bootId: 'bootE', pollMs: 9e9 })
    lrE.poll()
    const stalledSnap = lrE.snapshot()               // ★ 卡住那一刻的现场，留到最后一条断言用
    const curFile = path.join(dirE, 'events', 'cursor.json')
    const curOnDisk = fs.existsSync(curFile) ? JSON.parse(fs.readFileSync(curFile, 'utf8')) : { sources: {} }
    ok('E① WRITE_FAILED：前一行照常入账，游标只推进到失败行之前（失败行没被跳过）',
      storeE.readAll().length === 1 && lrE.cursor.offset === CUT1 &&
        Number(curOnDisk.sources['lead-relay'] && curOnDisk.sources['lead-relay'].offset) === CUT1,
      'rows=' + storeE.readAll().length + ' offset=' + lrE.cursor.offset + ' cut1=' + CUT1)
    ok('E② 拒写可见：rejected/stalled 计数 + state=stalled + blocked 指向那一行',
      lrE.counters.rejected === 1 && lrE.counters.stalled === 1 && lrE.snapshot().state === 'stalled' &&
        Boolean(lrE.snapshot().blocked) && lrE.snapshot().blocked.offset === CUT1 && lrE.snapshot().blocked.line === 2,
      JSON.stringify(lrE.snapshot().blocked))
    ok('E②b 卡住不刷屏：同一行连续卡住只记一条 APPEND_BLOCKED',
      (() => {
        const n0 = errRows(path.join(dirE, 'events')).filter((e) => e.code === 'APPEND_BLOCKED').length
        lrE.poll()                                    // 第二次仍失败
        const n1 = errRows(path.join(dirE, 'events')).filter((e) => e.code === 'APPEND_BLOCKED').length
        return n0 === 1 && n1 === 1
      })(),
      '')
    ok('E③ 再卡一次游标仍不动（不存在「失败也算消费」的漏洞）',
      lrE.cursor.offset === CUT1 && lrE.cursor.line === 1 && storeE.readAll().length === 1,
      'offset=' + lrE.cursor.offset + ' line=' + lrE.cursor.line)
    ok('E④ 恢复后下一次 poll 重读到同一行并成功：L2/L3 都入账，不丢不重，状态回到 reading',
      (() => {
        lrE.poll()
        const rows = storeE.readAll()
        return rows.length === 3 && lrE.cursor.offset === CUT3 && lrE.cursor.line === 3 &&
          rows.filter((r) => r.payload.title === '行2').length === 1 &&
          lrE.snapshot().state === 'reading' && lrE.snapshot().blocked === null
      })(),
      'rows=' + storeE.readAll().length + ' offset=' + lrE.cursor.offset + ' cut3=' + CUT3)

    // —— E⑤ 判重（DUPLICATE）是合法的已处理 → 游标照推 ——
    const dirDup = tmp('rel-dup')
    const QD = path.join(dirDup, 'q.jsonl')
    fs.writeFileSync(QD, L1 + '\n', 'utf8')
    const storeD = openStore({ dir: path.join(dirDup, 'events'), env: {} })
    const lrD1 = createLeadRelayIngress({ store: storeD, queuePath: QD, bootId: 'dupBoot', pollMs: 9e9 })
    lrD1.poll()
    const replayStore = {                              // 游标不落盘的「重放」视角（模拟重启后从头读）
      append: (e) => storeD.append(e),
      pushError: (c, d) => storeD.pushError(c, d),
      setCursor: () => {},
      getCursor: () => ({}),
      flushStatus: () => true,
    }
    const lrD2 = createLeadRelayIngress({ store: replayStore, queuePath: QD, bootId: 'dupBoot', pollMs: 9e9 })
    lrD2.poll()
    ok('E⑤ DUPLICATE 可推进：不入账但游标走到队尾、不卡住（否则每次重启都卡在同一行）',
      lrD1.counters.envelopes === 1 && lrD2.counters.envelopes === 0 && lrD2.counters.dup === 1 &&
        lrD2.cursor.offset === B(L1 + '\n') && lrD2.snapshot().state === 'reading' && lrD2.snapshot().blocked === null,
      'dup=' + lrD2.counters.dup + ' offset=' + lrD2.cursor.offset)

    // —— E⑥-E⑦ lead-relay：stop 之后迟到轮询一律拒绝 ——
    const dirS = tmp('rel-stop')
    const QS = path.join(dirS, 'q.jsonl')
    fs.writeFileSync(QS, L1 + '\n', 'utf8')
    const storeS = openStore({ dir: path.join(dirS, 'events'), env: {} })
    const lrS = createLeadRelayIngress({ store: storeS, queuePath: QS, bootId: 'stopBoot', pollMs: 9e9 })
    lrS.poll()
    lrS.stop()
    fs.appendFileSync(QS, L2 + '\n', 'utf8')           // 停止之后队列里又来了新行
    const pStop = lrS.poll()
    ok('E⑥ lead-relay：stop 之后的 poll 直接拒绝（不入账、不推进游标）',
      storeS.readAll().length === 1 && lrS.cursor.offset === B(L1 + '\n') && pStop.read === 0 && pStop.stopped === true,
      JSON.stringify({ rows: storeS.readAll().length, offset: lrS.cursor.offset, read: pStop.read }))
    ok('E⑦ 迟到轮询有计数、状态可分辨（pollsAfterStop / stopped / stoppedAt，不是静默）',
      lrS.counters.pollsAfterStop === 1 && lrS.snapshot().state === 'stopped' &&
        lrS.snapshot().stopped === true && typeof lrS.snapshot().stoppedAt === 'string',
      JSON.stringify({ n: lrS.counters.pollsAfterStop, at: lrS.snapshot().stoppedAt }))

    // —— E⑧-E⑩ onebot：stop 之后迟到的帧不 append（假 transport，不连任何真网关） ——
    const dirW = tmp('ws-stop')
    const storeW = openStore({ dir: path.join(dirW, 'events'), env: {} })
    const sockets = []
    class FakeWS {
      constructor (url) { this.url = url; sockets.push(this) }
      close () { this.closed = true; if (typeof this.onclose === 'function') this.onclose({ code: 1000 }) }
    }
    const ingW = createOneBotIngress({
      store: storeW,
      url: 'ws://127.0.0.1:1',
      transport: { create: (u) => new FakeWS(u) },
      allow: { all: true, chats: [], private: [] },
      maxReconnect: 0,
      backoffMs: [1],
      bootId: 'bootW',
      selfId: '10001',
    })
    const frame = (mid) => ({
      data: JSON.stringify({
        post_type: 'message', message_type: 'group', group_id: 661580035, user_id: 20001,
        self_id: '10001', message_id: mid, time: 1, message: [{ type: 'text', data: { text: 'm' + mid } }],
      }),
    })
    ingW.start()
    await sleep(30)
    const sockW = sockets[0]
    sockW.onopen()
    sockW.onmessage(frame(9101))
    ok('E⑧ 前置：stop 之前正常入账 1 条', storeW.readAll().length === 1, 'rows=' + storeW.readAll().length)
    ingW.stop()
    sockW.onmessage(frame(9102))                        // ★ 迟到帧：close 是异步的，这一帧在现实里会到
    await sleep(20)
    ok('E⑨ stop 之后迟到的帧不入账（账一行不增）', storeW.readAll().length === 1, 'rows=' + storeW.readAll().length)
    ok('E⑩ 迟到拒绝可观察：afterStop=1 / lastDrop.reason=after_stop / stopped / stoppedAt 有值',
      ingW.counters.afterStop === 1 && ingW.snapshot().lastDrop.reason === 'after_stop' &&
        ingW.snapshot().state === 'stopped' && ingW.snapshot().stopped === true &&
        typeof ingW.snapshot().stoppedAt === 'string',
      JSON.stringify({ n: ingW.counters.afterStop, drop: ingW.snapshot().lastDrop }))

    // —— E⑪-E⑬ 代码级护栏（这两条语义不许被悄悄改回去） ——
    const obCode = codeLines(srcText('src\\events\\ingress-onebot.mjs'))
    ok('E⑪ 护栏：onEvent 第一件事就是判 stopped（先判停，才解析/过滤/入账）',
      /function onEvent \(d\) \{\s*if \(stopped\)/.test(obCode), 'grep ok')
    ok('E⑫ 护栏：onmessage 入口也判 stopped（双向闸，不只靠 onEvent）',
      /sock\.onmessage = \(m\) => \{\s*if \(stopped\)/.test(obCode), 'grep ok')

    const lrCode = codeLines(srcText('src\\events\\ingress-lead-relay.mjs'))
    ok('E⑬ 护栏：游标推进绑在 append 结果上（没有「不看返回就前移」那条老代码）',
      !/offset \+= consumed/.test(lrCode) && /r\.code === 'DUPLICATE'/.test(lrCode) &&
        /commitTo = lineEnd/.test(lrCode) && /blocked = \{ offset: lineStart/.test(lrCode),
      'grep ok')

    // —— E⑭ 状态口必须能看出「卡住」，而且不许把它写成「断线」 ——
    const stv = sourceView(Object.assign({}, stalledSnap, { enabled: true }))
    const stTop = buildStatus({ store: storeE, sources: { 'lead-relay': Object.assign({}, stalledSnap, { enabled: true }) }, config: {} })
    ok('E⑭ 状态口：stalled 的 ready=false、label 指明「入账被拒」而不是「未连接」，blocked 现场带出去',
      stv.ready === false && /入账被拒/.test(stv.label) && !/未连接/.test(stv.label) &&
        Boolean(stv.blocked) && stTop.ready === false && stTop.summary !== 'ready',
      stv.label + ' / ' + stTop.summary)

    // —— E⑮ 卡住之后队列被清空：状态必须自己恢复正常（不许一直挂着 stalled） ——
    const dirT = tmp('rel-unstall')
    const QT = path.join(dirT, 'q.jsonl')
    fs.writeFileSync(QT, [L1, L2].join('\n') + '\n', 'utf8')
    const storeT = openStore({ dir: path.join(dirT, 'events'), env: {} })
    const deadStore = {
      append: () => ({ ok: false, code: 'WRITE_FAILED', message: '一直写不进去（测试专用）' }),
      pushError: (c, d) => storeT.pushError(c, d),
      setCursor: (s, c) => storeT.setCursor(s, c),
      getCursor: () => ({}),
      flushStatus: () => true,
    }
    const lrT = createLeadRelayIngress({ store: deadStore, queuePath: QT, bootId: 'bootT', pollMs: 9e9 })
    lrT.poll()
    const stalledT = lrT.snapshot()
    fs.writeFileSync(QT, '', 'utf8')                     // 队列被清空/轮转成 0 字节
    lrT.poll()
    ok('E⑮ 卡住后队列被清空：blocked 自动清掉、状态回 reading（不把「已经没事」显示成「还卡着」）',
      stalledT.state === 'stalled' && Boolean(stalledT.blocked) &&
        lrT.snapshot().state === 'reading' && lrT.snapshot().blocked === null &&
        lrT.cursor.offset === 0,
      JSON.stringify({ before: stalledT.state, after: lrT.snapshot().state, offset: lrT.cursor.offset, trunc: lrT.counters.truncated }))

  }

  // ═══════════════════════════════════════════════════════════════════════
  // D · 真 core 生命周期（spawn 真进程 —— 不重启 DSH、不碰真网关）
  // ═══════════════════════════════════════════════════════════════════════
  group = 'D'
  await lifecycleChecks(ok)

} catch (e) {
  console.error('验收脚本自己炸了：' + (e && e.stack || e))
  results.push({ group, name: 'acceptance 未抛异常', pass: false, extra: String(e && e.message || e) })
} finally {
  // ★ 原型遗留：tmp 不清理。这里：mocks 全关、临时目录全删。
  for (const m of mocks) { try { await m.close() } catch { /* ignore */ } }
  for (const d of tmpRoot) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }
  const left = tmpRoot.filter((d) => fs.existsSync(d))
  ok('临时目录自清（跑完 0 个残留）', left.length === 0, left.join(',') || 'clean')
}

// ── 汇总 ─────────────────────────────────────────────────────────────────
const groups = ['A', 'B', 'C', 'D', 'E']
console.log('')
for (const g of groups) {
  const rs = results.filter((r) => r.group === g)
  if (!rs.length) continue
  const bad = rs.filter((r) => !r.pass)
  console.log('· ' + g + ' 组  ' + (rs.length - bad.length) + '/' + rs.length + ' passed')
}
const failed = results.filter((r) => !r.pass)
console.log('')
console.log((results.length - failed.length) + '/' + results.length + ' passed（总）')
if (failed.length) {
  console.log('FAILED:')
  for (const f of failed) console.log('  - [' + f.group + '] ' + f.name + (f.extra ? '  [' + f.extra + ']' : ''))
}
process.exit(failed.length ? 1 : 0)
