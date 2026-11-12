// 只读事件账 + 游标（append-only）—— **core 拥有、而且是唯一写者**
// ============================================================================
// 迁入自原型 plugins/aurabot-ingress/src/store.mjs（2026-11-10）。
//
// 磁盘布局（`dir` 由 src/events/index.mjs 一处决定 = <AGENT_SOUL_DATA>/events，
// **不接受任意路径配置** —— 这样就没有「有人把它指到 DSH_HOME 下」这条歧路）：
//   <dir>/envelopes.jsonl   帧账（只追加；一行一条 Envelope）
//   <dir>/events.jsonl      事件账（只追加；一行一个**已关闭**窗口，由 coalesce 推导）
//                           ★ 带 kind:"event" 标记、键名也不同于帧（id vs event_id），
//                             两本账混读时一眼分得开；进程重启后按 id 去重。
//   <dir>/cursor.json       游标快照（派生，可丢；丢了从账重建）
//   <dir>/status.json       状态快照（派生，给状态接口/不跑 core 的进程看最后一眼）
//   <dir>/errors.jsonl      错误账（只追加；断连/鉴权/坏行/giveup 都在这里）
//
// ★★ 两个「只读」不是一回事，代码里必须分开写：
//   ① ingress 是**接收侧只读**：它从不发消息、不调 send_* 接口（结构性保证，见 ingress-*.mjs）。
//   ② 账本可能是**进程级只读模式**（AGENT_SOUL_READONLY=1）：这时拒写新事件，
//      并且**明确返回拒绝**，不许静默丢、也不许假装写成功。
//   把 ② 说成「事件是只读的」＝把拒写包装成正常，那是假的。
//
// ★ 写域：本文件是**唯一**对这些文件做 append/write 的模块（manifest 里登记为 soleWriter）。
//   别处的「事件队列.jsonl」「lead-waker-台账.json」都**只读**，不在这里写、也不写第三份。
// ============================================================================

import fs from 'node:fs'
import { join, dirname } from 'node:path'

export const FILES = {
  envelopes: 'envelopes.jsonl',
  // ★ 第二本账（2026-11-11）：帧 → 事件推导出来的**事件账**。
  //   为什么单独一个文件、而不是塞进 envelopes.jsonl：帧是事实（不可解释、不能改）、
  //   事件是解释（可以从帧重算）。混在一本里，一旦发现推导规则错了就没法「重算」——
  //   只能对着一份分不清是事实还是解释的行猜。分开之后，删掉 events.jsonl 重跑即可。
  events: 'events.jsonl',
  cursor: 'cursor.json',
  status: 'status.json',
  errors: 'errors.jsonl',
}

export function isReadonlyFlag (env = process.env) {
  const v = String((env && env.AGENT_SOUL_READONLY) || '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

/**
 * 开账本。
 * opts.dir       —— 目录（空 = 没配 → NOT_CONFIGURED，不写、不建目录）
 * opts.readonly  —— 强制只读（除了 AGENT_SOUL_READONLY 之外的显式开关）
 * ★ 只读时**连目录都不创建**：创建目录本身就是写。
 */
export function openStore (opts = {}) {
  const dir = String(opts.dir || '').trim()
  const env = opts.env || process.env
  const now = opts.now || (() => Date.now())
  const log = opts.log || (() => {})

  const flagReadonly = isReadonlyFlag(env)
  let readonly = Boolean(opts.readonly) || flagReadonly
  let readonlyWhy = flagReadonly ? 'AGENT_SOUL_READONLY=1' : (opts.readonly ? 'config.readonly=true' : '')

  const stats = {
    configured: dir !== '',
    dir,
    mode: 'readwrite',
    writable: false,
    reused: 0,                 // 从既有账里重建的去重键数量
    envelopes: 0,
    dedup: 0,                  // 被去重拦下的条数（总计）
    dedupBySource: {},
    writtenBySource: {},
    rejected: 0,               // 只读/未配置时被拒的写入次数（必须可见）
    lastEventAt: null,
    lastSource: '',
    lastError: null,
    lastReject: null,
    // —— 事件账（第二本账）的读数 ——
    events: 0,                 // events.jsonl 的行数（启动时读入 + 本进程写入）
    eventsBadLines: 0,         // 读不动的行（一行坏了不牵连别人）
    eventsDup: 0,              // 同一 event.id 重复推导被拦下的次数
    eventsConflict: 0,         // 想覆盖已入账事件的帧（迟到帧改了旧事件边界）→ 拒绝且可见
    eventsRejected: 0,
    lastEventWriteAt: null,
  }

  if (!dir) {
    stats.mode = 'not-configured'
    log('[store] 未配置 dataDir —— 不写任何文件（显式配置才落盘）')
  } else if (readonly) {
    stats.mode = 'readonly'
    log('[store] 只读模式（' + readonlyWhy + '）：拒写新事件，只允许读')
  } else {
    try {
      fs.mkdirSync(dir, { recursive: true })
      stats.writable = true
      stats.mode = 'readwrite'
    } catch (e) {
      stats.mode = 'error'
      stats.lastError = { code: 'DIR_NOT_WRITABLE', detail: String(e && e.message || e) }
      readonly = true
      readonlyWhy = 'DIR_NOT_WRITABLE'
    }
  }

  const seenKeys = new Set()
  const seenHashes = new Set()
  const seq0 = { value: 0 }
  const cursors = {}
  let lastCursorFlush = 0

  // —— 从既有账重建去重索引（账本 append-only，所以重建是精确的；不另建去重文件，少一个会漂的真相）——
  if (stats.configured && fs.existsSync(join(dir, FILES.envelopes))) {
    try {
      const raw = fs.readFileSync(join(dir, FILES.envelopes), 'utf8')
      for (const line of raw.split('\n')) {
        if (line.trim() === '') continue
        let env2
        try { env2 = JSON.parse(line) } catch { continue }   // 坏行跳过：一行坏了不牵连别人
        if (env2.dedup_key) seenKeys.add(env2.dedup_key)
        if (env2.source && env2.payload_hash) seenHashes.add(env2.source + '|' + env2.payload_hash)
        if (Number.isFinite(env2.seq)) seq0.value = Math.max(seq0.value, env2.seq)
        stats.envelopes++
        stats.writtenBySource[env2.source] = (stats.writtenBySource[env2.source] || 0) + 1
        if (env2.received_at) {
          if (!stats.lastEventAt || env2.received_at > stats.lastEventAt) {
            stats.lastEventAt = env2.received_at
            stats.lastSource = env2.source || ''
          }
        }
        stats.reused = seenKeys.size
      }
    } catch (e) { stats.lastError = { code: 'LEDGER_UNREADABLE', detail: String(e && e.message || e) } }
  }

  // 游标快照（派生）：坏了就当没有 —— 去重索引会拦住重放，宁可多读一遍也不猜
  if (stats.configured && fs.existsSync(join(dir, FILES.cursor))) {
    try {
      const c = JSON.parse(fs.readFileSync(join(dir, FILES.cursor), 'utf8'))
      if (c && typeof c === 'object' && c.sources) Object.assign(cursors, c.sources)
      if (Number.isFinite(c && c.seq)) seq0.value = Math.max(seq0.value, c.seq)
    } catch { /* 损坏就用空游标 + 去重索引兜着 */ }
  }

  // —— 事件账的去重索引（启动时读一遍，之后只增不查盘）——
  // ★ 为什么放进内存：每落一帧就会重跑一次推导，同一条已关闭事件会被反复算出来。
  //   用 Set 拦在写之前是 O(1)；改成「每次写前扫一遍文件」等于把每条消息的成本从 O(n)
  //   抬到 O(n²)。账是 append-only，所以启动时读一遍就永远够用。
  // ★ coveredFrames 是第二道闸：帧 id 全局唯一（envelope 的 event_id），两个事件不可能
  //   合法地共享同一帧。所以「新事件覆盖了旧事件的帧」只说明一件事 —— 有迟到的帧
  //   改变了旧事件的时间边界。append-only 改不了旧行，于是这里**拒绝并留痕**，
  //   而不是静默写一条和旧事件重叠的「第二条」。
  const seenEventIds = new Set()
  const coveredFrames = new Map()      // frameId → 已入账的 eventId
  if (stats.configured && fs.existsSync(join(dir, FILES.events))) {
    try {
      const raw = fs.readFileSync(join(dir, FILES.events), 'utf8')
      for (const line of raw.split('\n')) {
        if (line.trim() === '') continue
        let ev
        try { ev = JSON.parse(line) } catch { stats.eventsBadLines++; continue }
        if (!ev || typeof ev !== 'object' || typeof ev.id !== 'string' || ev.id === '') { stats.eventsBadLines++; continue }
        if (seenEventIds.has(ev.id)) continue        // 同 id 的重复行只算一次（历史里若真有）
        seenEventIds.add(ev.id)
        stats.events++
        for (const fid of (Array.isArray(ev.frameIds) ? ev.frameIds : [])) coveredFrames.set(String(fid), ev.id)
      }
    } catch (e) { stats.lastError = { code: 'EVENTS_LEDGER_UNREADABLE', detail: String(e && e.message || e) } }
  }

  function atomicWrite (file, text) {
    if (!stats.writable) return false
    const tmp = file + '.tmp-' + process.pid
    try {
      fs.writeFileSync(tmp, text, 'utf8')
      fs.renameSync(tmp, file)
      return true
    } catch (e) {
      stats.lastError = { code: 'WRITE_FAILED', detail: String(e && e.message || e) }
      try { fs.unlinkSync(tmp) } catch { /* ignore */ }
      return false
    }
  }

  function pushError (code, detail) {
    const row = { t: new Date(now()).toISOString(), code: String(code), detail: String(detail || '') }
    stats.lastError = row
    // ★ 只读模式不落盘：错误只进内存 + 由状态接口原样返回（写 errors.jsonl 也是写）
    if (stats.writable) {
      try { fs.appendFileSync(join(dir, FILES.errors), JSON.stringify(row) + '\n', 'utf8') } catch { /* ignore */ }
    }
    return row
  }

  function writeCursor (force = false) {
    if (!stats.writable) return
    const t = now()
    if (!force && t - lastCursorFlush < 100) return
    lastCursorFlush = t
    atomicWrite(join(dir, FILES.cursor), JSON.stringify({
      seq: seq0.value,
      sources: cursors,
      updatedAt: new Date(t).toISOString(),
    }, null, 2) + '\n')
  }

  /**
   * 追加一条 Envelope。
   * 返回 { ok:true, seq } 或 { ok:false, code:'DUPLICATE'|'READONLY'|'NOT_CONFIGURED'|'WRITE_FAILED' }
   * ★ 拒写一律带一句人话，不许只返回 false。
   */
  function append (env) {
    if (!stats.configured) {
      stats.rejected++
      stats.lastReject = { code: 'NOT_CONFIGURED', at: new Date(now()).toISOString(), event_id: env && env.event_id }
      return { ok: false, code: 'NOT_CONFIGURED', message: '没有配置事件账目录（显式配置才落盘）：这条事件没有写入' }
    }
    if (readonly || !stats.writable) {
      stats.rejected++
      stats.lastReject = { code: 'READONLY', at: new Date(now()).toISOString(), event_id: env && env.event_id, why: readonlyWhy }
      return {
        ok: false,
        code: 'READONLY',
        message: '只读模式（' + readonlyWhy + '）：拒写新事件。注意这不是「事件是只读的」——' +
          '接收侧本来就不发送；这里是账本被锁了，所以这条事件没有落盘。',
      }
    }
    const dedupKey = env.dedup_key
    const crossKey = env.source + '|' + env.payload_hash
    if (seenKeys.has(dedupKey)) {
      stats.dedup++
      stats.dedupBySource[env.source] = (stats.dedupBySource[env.source] || 0) + 1
      return { ok: false, code: 'DUPLICATE', message: '同一去重键已经入账', key: dedupKey, layer: 'dedup_key' }
    }
    // ★★ 第三层：内容指纹**永久**判重。代价写在这里，别让下一个人以为是 bug：
    //   · 同一个 source + 逐字节相同 payload，**永远**只入账一次（跨进程重启、跨 boot）。
    //   · 于是「真的第二次出现同样内容」也会被吃掉：群里两个人先后发同一句「嗯」、
    //     或网关重连后补发一条与历史某条完全相同的事件 —— 后者正是我们要拦的，
    //     前者是这一层的代价。取舍：宁可少一条重复内容，也不要让重放把账撑大。
    //   · 这是本账本里**唯一**不去看时间/序号的判据，所以它也是最保守的一层。
    //   · 想改它之前先问：R3（message_id 重启后是否重用）验过了吗？没有就别动。
    if (seenHashes.has(crossKey)) {
      stats.dedup++
      stats.dedupBySource[env.source] = (stats.dedupBySource[env.source] || 0) + 1
      return { ok: false, code: 'DUPLICATE', message: '同来源同内容已经入账（跨 boot 兜底层；永久判重，代价见本函数注释）', key: crossKey, layer: 'content' }
    }
    const row = { ...env, seq: ++seq0.value }
    try {
      const fd = fs.openSync(join(dir, FILES.envelopes), 'a')
      try {
        fs.writeSync(fd, JSON.stringify(row) + '\n')
        try { fs.fsyncSync(fd) } catch { /* 有些文件系统不支持，忽略 */ }
      } finally { fs.closeSync(fd) }
    } catch (e) {
      stats.rejected++
      const err = pushError('WRITE_FAILED', String(e && e.message || e))
      stats.lastReject = { code: 'WRITE_FAILED', at: err.t, event_id: env.event_id }
      return { ok: false, code: 'WRITE_FAILED', message: '事件账写不进去：' + err.detail }
    }
    seenKeys.add(dedupKey)
    seenHashes.add(crossKey)
    stats.envelopes++
    stats.writtenBySource[env.source] = (stats.writtenBySource[env.source] || 0) + 1
    stats.lastEventAt = row.received_at
    stats.lastSource = env.source
    return { ok: true, seq: row.seq }
  }

  function setCursor (source, cur) {
    if (!source) return
    cursors[source] = { ...(cursors[source] || {}), ...cur, at: new Date(now()).toISOString() }
    writeCursor()
  }
  const getCursor = (source) => ({ ...(cursors[source] || {}) })

  function flushStatus (extra = {}) {
    if (!stats.writable) return false
    return atomicWrite(join(dir, FILES.status), JSON.stringify({
      at: new Date(now()).toISOString(),
      store: snapshot(),
      ...extra,
    }, null, 2) + '\n')
  }

  function snapshot () {
    return {
      configured: stats.configured,
      dir: stats.dir,
      mode: stats.mode,
      writable: stats.writable,
      readonly: readonly ? { why: readonlyWhy } : null,
      envelopes: stats.envelopes,
      dedup: stats.dedup,
      dedupBySource: { ...stats.dedupBySource },
      writtenBySource: { ...stats.writtenBySource },
      rejected: stats.rejected,
      lastEventAt: stats.lastEventAt,
      lastSource: stats.lastSource,
      lastError: stats.lastError,
      lastReject: stats.lastReject,
      seq: seq0.value,
      // ★ 事件账单独一格：帧账（envelopes）与事件账的读数不该混在一起报 ——
      //   「收了多少帧」和「解释出多少事件」是两个问题，混报会让人以为丢了一半。
      eventsLedger: {
        rows: stats.events,
        dup: stats.eventsDup,
        conflict: stats.eventsConflict,
        rejected: stats.eventsRejected,
        badLines: stats.eventsBadLines,
        lastWriteAt: stats.lastEventWriteAt,
      },
    }
  }

  /** 读回最近 n 条（状态接口用；只读）。 */
  function tail (limit = 20) {
    const n = Math.max(1, Math.min(500, Number(limit) || 20))
    if (!stats.configured) return []
    try {
      const raw = fs.readFileSync(join(dir, FILES.envelopes), 'utf8')
      const out = []
      for (const line of raw.split('\n')) {
        if (line.trim() === '') continue
        try { out.push(JSON.parse(line)) } catch { /* 坏行跳过 */ }
      }
      return out.slice(-n)
    } catch { return [] }
  }

  function readAll () {
    if (!stats.configured) return []
    try {
      return fs.readFileSync(join(dir, FILES.envelopes), 'utf8')
        .split('\n').filter((l) => l.trim() !== '')
        .map((l) => { try { return JSON.parse(l) } catch { return null } })
        .filter(Boolean)
    } catch { return [] }
  }

  /**
   * 追加**事件**（推导出来的已关闭窗口）—— 事件账的唯一写入口。
   * 返回 { ok, written, duplicate, conflict, rejected, code, message }
   *   written   —— 真的写了行的 event.id
   *   duplicate —— 已经在账里（同一 event.id）：**不写第二行**，但算成功（幂等）
   *   conflict  —— 覆盖了已入账事件的帧 → 拒绝（见下方长注释）
   *   rejected  —— 形状不对（没有 id / frameIds）→ 拒绝
   * ★ 幂等写在这里，不靠调用方记得：启动时把已有 id 读进 Set，之后同一个 id
   *   再来一万次也只有第一次落盘。这是「每落一帧都重跑一次推导」能成立的前提。
   * ★ 为什么不覆盖旧事件：这本账是 append-only。「修正」只能是**再推导一遍**，
   *   而不是原地改一行 —— 改一行之后，两份「事实」就分不出谁先谁后了。
   *   真有迟到帧改了边界 → conflict + errors.jsonl，看得见，但账不动。
   */
  function appendEvents (events) {
    const out = { ok: true, written: [], duplicate: [], conflict: [], rejected: [], code: null, message: '' }
    const fail = (code, message) => { out.ok = false; out.code = code; out.message = message; return out }
    if (!Array.isArray(events)) return fail('BAD_INPUT', 'appendEvents 需要事件数组')
    if (!stats.configured) {
      stats.eventsRejected += events.length
      return fail('NOT_CONFIGURED', '没有配置事件账目录（显式配置才落盘）：这 ' + events.length + ' 条事件没有写入')
    }
    if (readonly || !stats.writable) {
      stats.eventsRejected += events.length
      return fail('READONLY', '只读模式（' + readonlyWhy + '）：拒写事件账，' + events.length + ' 条没有落盘')
    }
    const pending = []          // [{ id, frameIds, line }]
    for (const ev of events) {
      if (!ev || typeof ev !== 'object' || typeof ev.id !== 'string' || ev.id === '' ||
          !Array.isArray(ev.frameIds) || ev.frameIds.length === 0) {
        out.rejected.push({ id: (ev && ev.id) || '', code: 'BAD_EVENT' })
        stats.eventsRejected++
        continue
      }
      if (seenEventIds.has(ev.id)) { out.duplicate.push(ev.id); stats.eventsDup++; continue }
      let clash = null
      for (const fid of ev.frameIds) {
        const other = coveredFrames.get(String(fid))
        if (other && other !== ev.id) { clash = { frameId: String(fid), eventId: other }; break }
      }
      if (clash) { out.conflict.push({ id: ev.id, frameId: clash.frameId, eventId: clash.eventId }); stats.eventsConflict++; continue }
      // ★ kind 放在展开**之后**：将来 coalesce 若多出一个 kind 字段，标记也不会被它覆盖。
      pending.push({ id: ev.id, frameIds: ev.frameIds.map(String), line: JSON.stringify({ ...ev, kind: 'event' }) })
    }
    if (pending.length) {
      try {
        const fd = fs.openSync(join(dir, FILES.events), 'a')
        try {
          fs.writeSync(fd, pending.map((p) => p.line).join('\n') + '\n')
          try { fs.fsyncSync(fd) } catch { /* 有些文件系统不支持，忽略 */ }
        } finally { fs.closeSync(fd) }
      } catch (e) {
        const err = pushError('EVENTS_WRITE_FAILED', String(e && e.message || e))
        stats.eventsRejected += pending.length
        return fail('WRITE_FAILED', '事件账写不进去：' + err.detail)
      }
      for (const p of pending) {
        seenEventIds.add(p.id)
        for (const fid of p.frameIds) coveredFrames.set(fid, p.id)
        out.written.push(p.id)
        stats.events++
      }
      stats.lastEventWriteAt = new Date(now()).toISOString()
    }
    // duplicate 不算失败（幂等命中），conflict / rejected 才算
    out.ok = out.conflict.length === 0 && out.rejected.length === 0
    return out
  }

  /**
   * 读事件账（只读，供 /api 用）。
   * opts.since —— 毫秒时间戳或 ISO 字符串；**按 openedAt 过滤**（事件的开始时刻）。
   *   ★ 为什么不按 closedAt：未关闭事件的 closedAt 是 null，「从 T 以后」会漏掉它们；
   *     而 openedAt 恒有，且「某时刻起发生了什么」本来也是从开始算的。
   *   ★ 给了 since 却解析不出来 → **抛 TypeError**。猜一个时间比报错更坏：
   *     调用方会拿着一个看起来正常、其实过滤错的结果回去。
   */
  function readEvents (opts = {}) {
    if (!stats.configured) return []
    let since = -Infinity
    const raw = opts && opts.since
    if (raw !== undefined && raw !== null && raw !== '') {
      const ms = typeof raw === 'number' ? raw : Date.parse(String(raw))
      if (!Number.isFinite(ms)) throw new TypeError('readEvents: since 要毫秒时间戳或 ISO 字符串（收到 ' + JSON.stringify(raw) + '）')
      since = ms
    }
    try {
      return fs.readFileSync(join(dir, FILES.events), 'utf8')
        .split('\n').filter((l) => l.trim() !== '')
        .map((l) => { try { return JSON.parse(l) } catch { return null } })
        .filter((e) => e && typeof e === 'object')
        .filter((e) => { const t = Number(e.openedAt); return !Number.isFinite(t) || t >= since })
    } catch { return [] }
  }

  return {
    dir,
    append,
    appendEvents,
    readEvents,
    pushError,
    setCursor,
    getCursor,
    snapshot,
    flushStatus,
    writeCursor,
    tail,
    readAll,
    get writable () { return stats.writable },
    get mode () { return stats.mode },
    get readonly () { return readonly },
    get readonlyWhy () { return readonlyWhy },
    paths: {
      envelopes: dir ? join(dir, FILES.envelopes) : '',
      events: dir ? join(dir, FILES.events) : '',
      cursor: dir ? join(dir, FILES.cursor) : '',
      status: dir ? join(dir, FILES.status) : '',
      errors: dir ? join(dir, FILES.errors) : '',
    },
  }
}

export function ensureParent (p) {
  try { fs.mkdirSync(dirname(p), { recursive: true }) } catch { /* ignore */ }
}
