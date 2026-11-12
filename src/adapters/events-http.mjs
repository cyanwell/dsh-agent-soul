// adapters · 事件接入的 HTTP 只读口（并入 core 现有的 GET /api/events）
// ============================================================================
// ★ 只有读：没有 POST/PUT，没有 /send，没有 /call。`writes` 字段是 0，写死在这里可被断言。
// ★ 事件列表只给**元数据**（不含 payload 原文）：
//   要看原文请按 raw_ptr 回事件账里取（onebot:ws#boot/帧号  或  file:<队列>#L行@字节）。
//   这样做有两个理由：① 这个口可能被页面/手机读到，不该顺手把聊天正文摊开；
//   ② 账本才是权威，投影不该比权威更方便。
// ★ persisted：core 没在跑时（或刚从上次运行起来）读 <events>/status.json 的最后一眼，
//   带 stale 判定 —— 快照旧了就不许说 ready。离线读手就是给这里用的。
// ============================================================================

import { readStatusSnapshot } from '../events/status.mjs'

export const EVENTS_READ_PORT = Object.freeze({
  id: 'events-ingress-core',
  v: 1,
  routes: ['GET /api/events'],
  writes: 0,
  capabilities: { receive: true, send: false, sendRoutes: [], apiCalls: [] },
})

function metaOf (e) {
  return {
    seq: e.seq,
    event_id: e.event_id,
    source: e.source,
    type: e.type,
    chatId: e.chatId,
    userId: e.userId,
    messageId: e.messageId,
    created_at: e.created_at,
    received_at: e.received_at,
    payload_hash: e.payload_hash,
    raw_ptr: e.raw_ptr,
  }
}

/**
 * 拼 GET /api/events 里的 ingress 那一段。
 * runtime 为 null / undefined 时也给一份 disabled 状态（页面拿到的形状要稳定）。
 */
export function eventsIngressPayload (runtime, opts = {}) {
  const now = opts.now || (() => Date.now())
  const rawLimit = Number(opts.limit)
  const limit = Math.max(1, Math.min(50, Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 20))

  if (!runtime) {
    return {
      port: EVENTS_READ_PORT.id,
      v: EVENTS_READ_PORT.v,
      mode: 'off',
      summary: 'disabled',
      ready: false,
      enabled: false,
      connected: false,
      lastEventAt: null,
      lastError: null,
      dedupCount: 0,
      lastSource: '',
      reason: '事件接入没有挂载（core 未创建它）—— 不是 ready',
      capabilities: EVENTS_READ_PORT.capabilities,
      events: { count: 0, total: 0, items: [], note: '只给元数据，正文按 raw_ptr 回事件账取' },
    }
  }

  const status = runtime.status()
  const items = runtime.tail(limit).map(metaOf)
  let persisted = null
  if (runtime.dir) {
    try { persisted = readStatusSnapshot(runtime.dir, { now }) } catch { persisted = null }
  }
  return {
    port: EVENTS_READ_PORT.id,
    v: EVENTS_READ_PORT.v,
    ...status,
    events: {
      count: items.length,
      total: status && status.totals ? status.totals.envelopes : 0,
      items,
      note: '只给元数据，正文按 raw_ptr 回事件账取',
    },
    persisted,
  }
}
