// 事件接入状态视图 —— 状态只读口的数据形状（core）
// ============================================================================
// 迁入自原型 src/status.mjs（2026-11-10），加三样 core 才有的东西：
//   · mode（off / direct-ws / bridge-events）—— 两种模式互斥，状态里必须能看出来是哪种
//   · authority —— 这份账是谁的、唯一写者是谁（来自 security/write-manifest.mjs）
//   · readStatusSnapshot() —— 给「core 没在跑」的时候读最后一眼（7 条离线读手断言就是它）
//
// ★ 一条硬规矩：**disconnected 不许写成 ready**。
//   每个源都有 state（机器读）与 label（人读）；label 在断线时明确写「不是 ready」。
//   顶层 ready 只有「账本可写 且 每个被启用的源都 connected」才为 true。
//   没有任何源被启用 = disabled（默认态），不是 ready。
// ★ 这个口**没有写路径、没有发送路由**；capabilities 把这件事写成字段，便于断言。
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import { FILES } from './store.mjs'
import { EVENT_WRITE_DOMAIN } from '../security/write-manifest.mjs'

const READY_STATES = new Set(['connected', 'reading'])

export function sourceView (snap) {
  const s = snap || {}
  const st = String(s.state || 'unknown')
  const ready = s.enabled === true && READY_STATES.has(st) && s.connected === true
  const label = !s.enabled
    ? '未启用（默认 disabled / allow none）—— 不是 ready'
    : st === 'giveup'
      ? '已放弃重连（giveup）—— 不是 ready，需要人工处理'
      : (st === 'connected' || st === 'reading')
        ? '在线'
        : st === 'reconnecting'
          ? '重连中 —— 不是 ready'
          : st === 'error'
            ? '读取出错 —— 不是 ready'
            : st === 'stopped'
              ? '已停止 —— 不是 ready'
              // ★ 2026-11-10 加：stalled 是「连上了、但入账被拒、游标停住等重试」。
              //   它**不是**断线（connected 仍为 true）—— 写成「未连接」会让人去查网络，查错方向。
              : st === 'stalled'
                ? '已连上，但入账被拒（游标停在该行等重试）—— 不是 ready'
                : '未连接（' + st + '）—— 不是 ready'
  const out = {
    enabled: Boolean(s.enabled),
    state: st,
    connected: Boolean(s.connected),
    ready,
    label,
    lastEventAt: s.lastEventAt || null,
    lastError: s.lastError || null,
    dedupCount: Number(s.dedupCount) || 0,
    lastSource: s.lastSource || s.id || '',
    lastDrop: s.lastDrop || null,
    partialTail: s.partialTail || null,
    lastBad: s.lastBad || null,
    counters: s.counters || {},
    capability: s.capability || { receive: true, send: false },
  }
  if (s.queuePath) out.queuePath = s.queuePath
  if (s.endpoint) out.endpoint = s.endpoint
  if (s.portSource) out.portSource = s.portSource
  if (s.cursor) out.cursor = s.cursor
  // ★ 卡住/停止的现场原样带出去（给人看的，不是给日志看的）
  if (s.blocked) out.blocked = s.blocked
  if (s.stoppedAt) out.stoppedAt = s.stoppedAt
  return out
}

/**
 * 拼状态。
 * sources: { onebot: snapshot|null, 'lead-relay': snapshot|null, bridge: snapshot|null }
 * mode:    'off' | 'direct-ws' | 'bridge-events'（互斥；off 就是 disabled）
 */
export function buildStatus ({ store, sources = {}, config = null, mode = 'off', authority = null, extra = {} } = {}) {
  const st = (store && store.snapshot) ? store.snapshot() : {
    configured: false, writable: false, mode: 'not-configured', envelopes: 0, dedup: 0,
  }
  const src = {}
  for (const id of ['onebot', 'lead-relay', 'bridge']) {
    const raw = sources[id]
    if (!raw) {
      src[id] = sourceView({ id, enabled: false, state: 'disabled', connected: false })
      src[id].note = '本次进程没有这个源（未启用或未加载）'
      continue
    }
    src[id] = sourceView(raw)
  }

  const enabled = Object.keys(src).filter((k) => src[k].enabled)
  const allReady = enabled.length > 0 && enabled.every((k) => src[k].ready)
  const anyError = Object.keys(src).some((k) => src[k].lastError || src[k].state === 'giveup' || src[k].state === 'error')

  // ★ 判据顺序是有讲究的（这条被验收抓过三次）：更具体的状态先说话，
  //   「mode=off」只在**真的没有账本**时才代表 disabled。
  //   否则 readonly 的账、没配目录的账、有两个源但断了一个的账都会被误写成 disabled ——
  //   而那三种各有各的处置办法，压成一个词就等于把处置也丢了。
  let summary
  if (st.mode === 'readonly') summary = 'readonly'
  else if (!store) summary = (mode === 'off') ? 'disabled' : 'not-configured'
  else if (!st.configured) summary = 'not-configured'
  else if (enabled.length === 0) summary = 'disabled'
  else if (allReady && st.writable) summary = 'ready'
  else if (anyError) summary = 'error'
  else summary = 'degraded'

  let reason = ''
  if (summary === 'readonly') reason = '账本处于只读模式（' + ((st.readonly && st.readonly.why) || '?') + '）：拒写新事件；这与「事件是只读的」不是一回事'
  else if (summary === 'not-configured') reason = '没有显式配置事件账目录'
  else if (summary === 'disabled') reason = (mode === 'off') ? '事件接入未启用（默认 disabled / mode=off）：不连、不收、不建事件目录' : '没有任何事件源被启用（默认 disabled / allow none）'
  else if (summary === 'error') reason = '有事件源报错或放弃重连'
  else if (summary === 'degraded') reason = '有事件源未连接'

  // ★ 顶层六个字段（需求点名的那六个）—— 从各源汇总，未启用时就明确 false/null。
  const lastOf = enabled.map((k) => src[k].lastEventAt).filter(Boolean).sort()
  const six = {
    enabled: enabled.length > 0,
    connected: enabled.length > 0 && enabled.every((k) => src[k].connected),
    lastEventAt: lastOf.length ? lastOf[lastOf.length - 1] : null,
    lastError: (enabled.map((k) => src[k].lastError).filter(Boolean).slice(-1)[0]) || st.lastError || null,
    dedupCount: enabled.reduce((n, k) => n + (src[k].dedupCount || 0), 0),
    lastSource: (enabled.map((k) => src[k].lastSource).filter(Boolean).slice(-1)[0]) || st.lastSource || '',
  }

  return {
    v: 1,
    at: new Date(extra.now || Date.now()).toISOString(),
    /** 模式：off / direct-ws / bridge-events。两种模式不会同时出现（见 events/index.mjs 的判定）。 */
    mode,
    ...six,
    /** 顶层判据：只有「账本可写 + 每个启用的源都连上」才 true。断线永远是 false。 */
    ready: summary === 'ready',
    summary,
    reason,
    /** ★ 明确写出：这个接入层只有收的能力。 */
    capabilities: { receive: true, send: false, sendRoutes: [], apiCalls: [] },
    /** ★ 账是谁的：目录 + 唯一写者 + manifest id。读的人不必再猜「哪一份是真的」。 */
    authority: authority || {
      dir: st.dir || '',
      dirRel: EVENT_WRITE_DOMAIN.dirRel,
      soleWriter: EVENT_WRITE_DOMAIN.soleWriter,
      manifest: EVENT_WRITE_DOMAIN.id,
    },
    write: {
      configured: st.configured,
      mode: st.mode,
      writable: st.writable,
      readonly: st.readonly || null,
      rejected: st.rejected || 0,
      lastReject: st.lastReject || null,
      dir: st.dir || '',
    },
    eventSources: src,
    totals: {
      envelopes: st.envelopes || 0,
      dedup: st.dedup || 0,
      dedupBySource: st.dedupBySource || {},
      writtenBySource: st.writtenBySource || {},
      lastEventAt: st.lastEventAt || null,
      lastSource: st.lastSource || '',
      lastError: st.lastError || null,
    },
    config: publicConfig(config || {}),
    ...extra,
  }
}

/**
 * 配置的脱敏投影：只报 hasToken 布尔，不报值、不报长度、不报前缀。
 * ★ token 只可能来自环境变量（tokenEnv），配置文件里根本不存它。
 */
export function publicConfig (cfg) {
  const ing = (cfg && cfg.events && cfg.events.ingress) || {}
  const ob = ing.onebot || {}
  const br = ing.bridge || {}
  return {
    mode: ing.mode || 'off',
    onebot: {
      wsUrl: ob.wsUrl ? String(ob.wsUrl) : '',
      tokenEnv: ob.tokenEnv ? String(ob.tokenEnv) : '',
      hasToken: Boolean(ob.tokenEnv),
      allow: ob.allow ? { all: Boolean(ob.allow.all), chats: (ob.allow.chats || []).slice(), private: (ob.allow.private || []).slice() } : { all: false, chats: [], private: [] },
      maxReconnect: Number(ob.maxReconnect) || 3,
    },
    bridge: {
      eventsPath: br.eventsPath ? String(br.eventsPath) : '',
      pollMs: Number(br.pollMs) || 2000,
      source: br.source ? String(br.source) : 'onebot',
    },
  }
}

/**
 * 离线读手：core 没在跑的时候，读 <events>/status.json 的最后一口气。
 *
 * ★ 语义与原型 module/index.mjs 的快照读手**逐条对齐**（那 7 条自测就是它）：
 *   · 没给目录        → not-configured（不是 ready）
 *   · 目录给了但没快照 → no-snapshot（不是 ready，说明「这不是一切正常」）
 *   · 快照新鲜        → 照抄 ready/summary
 *   · 快照过期        → ready 强制 false + summary=stale + 说清原因
 *   过期判据是 mtime：一个「两分钟没更新」的快照，不许再说 connected。
 */
export const SNAPSHOT_STALE_MS = 120_000

export function readStatusSnapshot (dir, opts = {}) {
  const staleMs = Number(opts.staleMs) || SNAPSHOT_STALE_MS
  const now = opts.now || (() => Date.now())
  const d = String(dir || '').trim()
  if (!d) {
    return {
      ok: true, source: 'file', configured: false, stale: true,
      ready: false, summary: 'not-configured',
      reason: '没有事件账目录 —— 不知道去哪读状态快照（core 的 events 目录由 dataDir 推导）',
      eventSources: {},
    }
  }
  const file = path.join(d, FILES.status)
  let doc = null
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { doc = null }
  if (!doc || !doc.status) {
    return {
      ok: true, source: 'file', configured: true, stale: true,
      ready: false, summary: 'no-snapshot',
      reason: '还没有状态快照（core 里的接入从没起过，或者从没写过）。这不是「一切正常」',
      path: file,
      eventSources: {},
    }
  }
  let ageMs = null
  try { ageMs = now() - fs.statSync(file).mtimeMs } catch { /* ignore */ }
  const st = doc.status
  const stale = ageMs === null || ageMs > staleMs
  return {
    ok: true,
    source: 'file',
    path: file,
    snapshotAgeMs: ageMs,
    stale,
    // ★ 快照旧了就不许说 ready —— 那一半只有运行中的进程自己知道
    ready: stale ? false : Boolean(st.ready),
    summary: stale ? 'stale' : st.summary,
    reason: stale
      ? '状态快照超过 ' + Math.round(staleMs / 1000) + 's 没更新（快照 ' + Math.round((ageMs || 0) / 1000) + 's 前）—— 接入可能没在跑，不许当 ready'
      : st.reason,
    eventSources: st.eventSources || {},
    totals: st.totals || {},
    write: st.write || {},
    mode: st.mode || '',
    authority: st.authority || null,
    capabilities: st.capabilities || { receive: true, send: false },
  }
}
