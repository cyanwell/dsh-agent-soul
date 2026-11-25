// aurabot/adapter/core-ingress.mjs
// In-memory fanout from the Core-owned OneBot receiver into the embedded Aurabot host.
// This module creates no transport and records no payloads.
export function createCoreIngressReceiver ({ getSelfId, onEvent, maxSeen = 5000 } = {}) {
  const seen = new Set()
  const expected = typeof getSelfId === 'function' ? getSelfId : () => ''
  const emit = typeof onEvent === 'function' ? onEvent : () => {}
  const cap = Number.isInteger(maxSeen) && maxSeen > 0 ? maxSeen : 5000
  return function receive (event, meta = {}) {
    if (!event || typeof event !== 'object') return false
    const selfId = String(expected() || '')
    if (!selfId || String(event.self_id || '') !== selfId) return false
    if (event.post_type === 'message' && String(event.user_id || '') === selfId) return false
    const id = String(meta.eventId || (event.message_id != null ? event.post_type + ':' + event.message_id : ''))
    if (id && seen.has(id)) return false
    if (id) {
      seen.add(id)
      if (seen.size > cap) {
        const oldest = seen.values().next().value
        if (oldest) seen.delete(oldest)
      }
    }
    emit(event, { eventId: id })
    return true
  }
}
