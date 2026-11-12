// 统一事件 Envelope（v1）—— core 的**唯一事件记录形状**
// ============================================================================
// 迁入自原型 plugins/aurabot-ingress/src/envelope.mjs（2026-11-10），**不依赖 dsh / aurabot**：
// 只用 node:crypto。宿主半（DSH 插件）没有跟着搬 —— 事件的策略归 core，不归宿主。
//
// 两条 ingress 合流成同一种不可变记录：
//   onebot      —— OneBot 网关 WS 推来的消息事件（post_type === 'message'）
//   lead-relay  —— 分身上报写进 事件队列.jsonl 的记录（只读，不接管写入）
//
// ★ 三条纪律：
//   ① 去重优先 messageId；缺失时用 bootId + 内容 hash；**禁止拿 Date.now 单独当键**
//      （同一毫秒两条不同事件会被合并 —— lead-waker 的 't|title' 键就是这个毛病）。
//   ② payload 原样保留，**不裁剪来源字段**（lead-relay 的 t/title/facts/why/tier/chatId/kind
//      一个都不能丢；丢了以后想核对就只能靠回忆）。
//   ③ raw_ptr 必须能回去：lead-relay 指向原文件的行号+字节偏移，onebot 指向 boot+帧号。
//
// ★ 去重一共三层（代价写在每一层的实现处，别只记「有五层」这种说法）：
//     ① mid:  —— 有 messageId 就用它（最准）
//     ② fp:   —— 没有 messageId 时 bootId + 内容 hash（重启后 bootId 变，认不出补发）
//     ③ hash: —— 同来源 + 同 payload_hash **永久**判重（跨 boot 兜底；代价见 store.mjs 注释）
// ============================================================================

import { createHash } from 'node:crypto'

export const ENVELOPE_V = 1

/** 键排序后的稳定 JSON —— 不排序就会因为字段顺序不同算出两个 hash。 */
export function stableStringify (value) {
  const walk = (v) => {
    if (v === null || typeof v !== 'object') return v
    if (Array.isArray(v)) return v.map(walk)
    const out = {}
    for (const k of Object.keys(v).sort()) out[k] = walk(v[k])
    return out
  }
  return JSON.stringify(walk(value))
}

export function sha256hex (text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

/** 内容指纹：整条 payload 的 hash。**不包含接收时间、不包含 bootId** —— 这两个一变，重放就认不出来了。 */
export function payloadHashOf (payload) {
  return sha256hex(stableStringify(payload)).slice(0, 40)
}

/**
 * 去重键。
 *   有 messageId → mid:<source>:<chatId>:<messageId>（首选，最准）
 *   没有        → fp:<source>:<bootId>:<hash>（bootId + 内容 hash）
 * ★ 这里没有 Date.now()：时间只记在 created_at 里，绝不参与定键。
 */
export function dedupKeyOf ({ source, chatId, messageId, bootId, payload_hash }) {
  const mid = String(messageId || '').trim()
  if (mid) return 'mid:' + source + ':' + (chatId || '-') + ':' + mid
  return 'fp:' + source + ':' + String(bootId || 'noboot') + ':' + payload_hash
}

/**
 * 第三层键：同一来源里**逐字节相同**的 payload 永远算重复。
 *
 * ★ 为什么还要这一层：fp: 键里带 bootId，重启后 bootId 变了，网关补发的同一条
 *   内容就认不出来了。R3（message_id 重启后是否重用）至今**未验证**，所以这层不能省。
 * ★ 代价：它是**永久**判重 —— 同一个来源、同样的内容，第二次出现永远进不了账，
 *   哪怕那是真的第二次（例：群里两个人先后发了一模一样的「嗯」；或重启后
 *   网关补发了一条恰好与历史某条逐字节相同的消息）。这一层换的是
 *   「宁可丢一条重复的，也不要重放一屏」；代价记在 store.mjs 的落盘判定处。
 */
export function crossBootKeyOf ({ source, payload_hash }) {
  return 'hash:' + source + ':' + payload_hash
}

function toIso (value, fallbackMs) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e11 ? value * 1000 : value   // 秒 / 毫秒都收
    return new Date(ms).toISOString()
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const ms = Date.parse(value)
    if (Number.isFinite(ms)) return new Date(ms).toISOString()
  }
  return new Date(fallbackMs).toISOString()
}

/**
 * 造一条 Envelope。字段名与原型/父任务要求的一字不差：
 *   event_id / source / type / payload_hash / created_at / chatId / userId / messageId / bootId / raw_ptr
 */
export function buildEnvelope (input) {
  const {
    source, type, payload,
    chatId = '', userId = '', messageId = '',
    bootId = '', raw_ptr = '',
    createdAt = null, receivedAt = Date.now(),
    ingress = '', extra = {},
  } = input
  if (!source) throw new Error('buildEnvelope: source 必填')
  if (!type) throw new Error('buildEnvelope: type 必填')
  if (payload === undefined) throw new Error('buildEnvelope: payload 必填')

  const payload_hash = payloadHashOf(payload)
  const dedup_key = dedupKeyOf({ source, chatId, messageId, bootId, payload_hash })
  const event_id = 'ev_' + sha256hex(source + '|' + dedup_key + '|' + payload_hash).slice(0, 16)

  return {
    v: ENVELOPE_V,
    event_id,
    source,
    type,
    payload_hash,
    created_at: toIso(createdAt, receivedAt),
    chatId: String(chatId || ''),
    userId: String(userId || ''),
    messageId: String(messageId || ''),
    bootId: String(bootId || ''),
    raw_ptr: String(raw_ptr || ''),
    // —— 以下是自用字段（父任务字段集之外的补充，不替换上面任何一个）——
    ingress: String(ingress || source),
    received_at: new Date(receivedAt).toISOString(),
    dedup_key,
    payload: payload,
    ...extra,
  }
}

/** 从 Envelope 复算去重键（读旧账时用，防止旧版本写入的键算错）。 */
export function keyOfEnvelope (env) {
  return env.dedup_key || dedupKeyOf({
    source: env.source, chatId: env.chatId, messageId: env.messageId,
    bootId: env.bootId, payload_hash: env.payload_hash,
  })
}
