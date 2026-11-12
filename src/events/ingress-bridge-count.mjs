// bridge-events：**只数行、不搬内容**的计数对照（core 的第二条通路，互斥于 direct-ws）
// ============================================================================
// 为什么有它：R1 还没验过，所以不许连真实网关。可我们又需要一个「上游到底有多少事件」
// 的读数来对照 core 自己的事件账。于是这条通路只做一件事：
//   数清楚 bridge 写的那份事件文件**有多少行**，和 core 账里同来源的条数比一比。
//
// ★★ 结构上不可能成为「第三份权威」：
//   · 它**不解析 JSON**（连 payload 都看不见），只按 0x0a 数完整行；
//   · 它**不 append**、不写游标、不写状态（状态由 events/index.mjs 写自己的 status.json）；
//   · 它只把 { upstreamLines, ledgerRows, drift } 交给状态口。
//   换句话说：即使这份文件里有天大的秘密，这条通路也只会知道「它有 N 行」。
//
// ★ 只数完整行（与 lead-relay 同一条口径）：末尾没有换行的半行不算，
//   否则「上游写了一半」会被读成「多了一条」。
// ============================================================================

import fs from 'node:fs'

export function countCompleteLines (text) {
  if (!text) return 0
  let n = 0
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

export function createBridgeEventsCounter (opts = {}) {
  const {
    store,
    eventsPath,
    pollMs = 2000,
    source = 'onebot',
    log = () => {},
    now = () => Date.now(),
    maxBytes = 64 * 1024 * 1024,
  } = opts

  const counters = {
    polls: 0,
    upstreamLines: 0,
    ledgerRows: 0,
    drift: 0,
    driftPolls: 0,
    bytesRead: 0,
    truncated: 0,
    errors: 0,
  }
  const state = {
    id: 'bridge',
    enabled: Boolean(eventsPath),
    state: eventsPath ? 'idle' : 'disabled',
    connected: false,
    lastEventAt: null,
    lastError: null,
    lastSource: 'bridge',
    compare: null,
  }

  let timer = null
  let stopped = false
  let cache = { size: -1, mtimeMs: -1, lines: 0, bytes: 0 }

  function readCompleteLines () {
    const st = fs.statSync(eventsPath)
    if (cache.size === st.size && cache.mtimeMs === st.mtimeMs) return cache
    const len = Math.min(st.size, maxBytes)
    const buf = Buffer.alloc(len)
    const fd = fs.openSync(eventsPath, 'r')     // ★ 只读打开
    try { fs.readSync(fd, buf, 0, len, 0) } finally { try { fs.closeSync(fd) } catch { /* ignore */ } }
    // 只数到最后一个换行（半行不算）
    const lastNl = buf.lastIndexOf(0x0a)
    const complete = lastNl < 0 ? Buffer.alloc(0) : buf.subarray(0, lastNl + 1)
    const lines = countCompleteLines(complete.toString('latin1'))
    cache = { size: st.size, mtimeMs: st.mtimeMs, lines, bytes: complete.length }
    counters.bytesRead += complete.length
    if (st.size > maxBytes) counters.truncated++
    return cache
  }

  function ledgerRowsOf (src) {
    const snap = store && store.snapshot ? store.snapshot() : null
    const by = (snap && snap.writtenBySource) || {}
    return Number(by[src] || 0)
  }

  function poll () {
    if (stopped) return { ok: false }
    counters.polls++
    if (!eventsPath) { state.state = 'disabled'; return { ok: false } }
    let lines
    try {
      lines = readCompleteLines()
    } catch (e) {
      counters.errors++
      state.state = 'error'
      state.connected = false
      state.lastError = { code: 'BRIDGE_UNREADABLE', detail: String((e && e.message) || e), at: new Date(now()).toISOString() }
      log('[bridge] 读不到 ' + eventsPath + '：' + state.lastError.detail)
      return { ok: false }
    }
    const ledgerRows = ledgerRowsOf(source)
    const drift = lines.lines - ledgerRows
    counters.upstreamLines = lines.lines
    counters.ledgerRows = ledgerRows
    counters.drift = drift
    if (drift !== 0) counters.driftPolls++
    state.state = 'reading'
    state.connected = true
    state.lastError = null
    state.compare = {
      source,
      upstreamLines: lines.lines,
      ledgerRows,
      drift,
      at: new Date(now()).toISOString(),
      // ★ 读的人要知道这不是「入账了没有」的判据，只是计数对照
      note: '计数对照：上游完整行数 vs 本账同来源条数。差值不等于丢事件（去重、白名单、自身消息都会让上游多）',
    }
    return { ok: true, compare: state.compare }
  }

  function loop () {
    if (stopped) return
    try { poll() } catch (e) { log('[bridge] poll 失败：' + String((e && e.message) || e)) }
    timer = setTimeout(loop, Math.max(200, Number(pollMs) || 2000))
    if (timer.unref) timer.unref()
  }

  function snapshot () {
    return {
      id: 'bridge',
      enabled: state.enabled,
      state: state.state,
      connected: state.connected,
      lastEventAt: null,
      lastError: state.lastError,
      dedupCount: 0,
      lastSource: 'bridge',
      eventsPath: eventsPath ? String(eventsPath) : '',
      compare: state.compare,
      counters: Object.assign({}, counters),
      // ★ 只数不搬：没有 receive、没有 send，也没有 append
      capability: { receive: false, countOnly: true, send: false },
    }
  }

  return {
    id: 'bridge',
    start () { stopped = false; loop() },
    stop () { stopped = true; clearTimeout(timer); state.state = 'stopped'; state.connected = false },
    poll,
    snapshot,
    get counters () { return Object.assign({}, counters) },
  }
}
