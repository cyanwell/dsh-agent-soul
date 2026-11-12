// adapters · 事件接入的 WS 传输（**唯一碰 WebSocket 的地方**）
// ============================================================================
// 为什么单独一层：core 的策略（src/events/）要能在没有 WS 的环境里被完整测试，
// 「连什么、怎么连」属于适配器。原型把 WebSocketImpl 直接塞进 ingress，
// 迁进来时改成注入 transport —— 这不是洁癖：它让「一帧都不许上行」这条断言
// 可以在假 transport 上验，也可以在真 node:WebSocket 上验。
//
// ★ 本文件只有 create()：建连。**没有 send、没有 call** —— 与 ingress 同一条纪律。
// ============================================================================

export function makeWsTransport (opts = {}) {
  const WebSocketImpl = opts.WebSocketImpl || (typeof globalThis.WebSocket === 'function' ? globalThis.WebSocket : null)
  const log = opts.log || (() => {})
  const stats = { created: 0, opened: 0, closed: 0, errors: 0, open: 0 }

  const available = typeof WebSocketImpl === 'function'

  function create (url) {
    if (!available) throw new Error('运行环境没有 WebSocket（node >= 22 才有内置实现）')
    stats.created++
    let sock
    try {
      sock = new WebSocketImpl(url)
    } catch (e) {
      stats.errors++
      throw e
    }
    stats.open++
    // 计数用 addEventListener，**不占用** ingress 要用的 onopen/onclose 属性
    try {
      if (typeof sock.addEventListener === 'function') {
        sock.addEventListener('open', () => { stats.opened++ })
        sock.addEventListener('close', () => { stats.open = Math.max(0, stats.open - 1); stats.closed++ })
        sock.addEventListener('error', () => { stats.errors++ })
      }
    } catch { /* 有的实现不支持 addEventListener —— 计数退化，不影响功能 */ }
    log('[events-ws] create ' + (stats.created))
    return sock
  }

  return {
    name: 'direct-ws',
    available,
    create,
    stats,
    get open () { return stats.open },
  }
}
