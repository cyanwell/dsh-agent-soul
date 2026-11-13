// 扫「宿主的所有活跃会话」—— 只读日志，不碰活会话
// ============================================================================
// ★★ 爀曦 2026-11-13：「我说的**活跃会话**是**最近在活跃的**，而不是静息很久的会话，
//   **超过 3 天静息的会话就不纳入扫描的对象**，这样降低性能开销。」
//
//   ★ 为什么这条约束是必要的（实测数字）：
//     D:\AI\dsh\home\sessions\--D-AI-yanqing-soul-- 下有 **930 个会话**
//     最大的一个 294MB；全扫一遍要几十分钟，而其中绝大部分早就凉了。
//
// ★ 数据源 = DSH 的原始事件日志（**不是** v4 自己的 data/sessions 投影）：
//     sessions\<workspace>\<sessionId>\session.v4.jsonl.zstd
//   · 多帧 zstd（按 magic 28 B5 2F FD 切帧，逐帧解压）
//   · 记录类型 assistant/message，结构：
//       { type, seq, time:<毫秒>, data:{ turn, step, message:{ content:[{type,text}] } } }
//   · 只取 content 里的 reasoning 块（那是「思考链」）
// ============================================================================
import fs from 'node:fs'
import { listSessionsViaBridge, readAllSessionViaBridge } from './bridge-sessions.mjs'
import path from 'node:path'
import zlib from 'node:zlib'
import { declStats } from '../agent/process-guard.mjs'

const MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])

export const DEFAULTS = {
  // ★ 活跃窗口：mtime 在这么多天内的才算「活跃」
  activeDays: 3,
  // ★★★ 2026-11-13：分钟级活跃窗口（优先级高于 activeDays）。
  //   为什么加：心跳要「条件触发、省性能」—— 只扫最近 2 小时有写入的，
  //   而不是 3 天内的全部（实测 194 个会话扫 31 秒，心跳扛不住）。
  activeMinutes: 0,
  // 每个会话只读尾部这么多字节（污染总在最近，全读 294MB 太贵）
  tailBytes: 8 * 1024 * 1024,
  // 每个会话最多看多少条 assistant 推理
  maxTurns: 60,
  // 只看长度 ≥ 这个的推理（短的不进判据）
  minChars: 300,
}

/**
 * 列宿主当前「活跃」的会话（mtime 在 activeDays 内）。
 * @param {{root?:string, activeDays?:number}} o
 */
export function listActiveHostSessions (o) {
  const cfg = { ...DEFAULTS, ...(o || {}) }
  const root = o && o.root ? o.root : 'D:/AI/dsh/home/sessions'
  // ★ 分钟级优先（心跳用）；否则按天（全量巡视用）
  const cutoff = cfg.activeMinutes > 0
    ? Date.now() - cfg.activeMinutes * 60 * 1000
    : Date.now() - cfg.activeDays * 24 * 3600 * 1000
  const out = []
  if (!fs.existsSync(root)) return { root, sessions: [], why: 'sessions 根不存在' }

  let wsDirs = []
  try { wsDirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()) } catch (e) {
    return { root, sessions: [], why: '读 sessions 根失败：' + String((e && e.message) || e) }
  }

  for (const ws of wsDirs) {
    const wsPath = path.join(root, ws.name)
    let subs = []
    try { subs = fs.readdirSync(wsPath, { withFileTypes: true }).filter((d) => d.isDirectory()) } catch { continue }
    for (const s of subs) {
      const dir = path.join(wsPath, s.name)
      let files = []
      try { files = fs.readdirSync(dir) } catch { continue }
      const f = files.find((x) => x.startsWith('session.') && x.endsWith('.zstd'))
      if (!f) continue
      const p = path.join(dir, f)
      let st
      try { st = fs.statSync(p) } catch { continue }
      if (st.mtimeMs < cutoff) continue   // ★ 静息超过 activeDays 天 → 不扫
      out.push({
        sessionId: s.name,
        workspace: ws.name,
        path: p,
        bytes: st.size,
        mtimeMs: st.mtimeMs,
        idleHours: Math.round((Date.now() - st.mtimeMs) / 3600000),
      })
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return { root, sessions: out, why: null, activeDays: cfg.activeDays, activeMinutes: cfg.activeMinutes }
}

/** 解压一个会话（只读尾部 tailBytes，最多 maxTurns 条推理） */
export function readHostSession (p, cfgIn) {
  const cfg = { ...DEFAULTS, ...(cfgIn || {}) }
  let fd, size
  try { fd = fs.openSync(p, 'r'); size = fs.fstatSync(fd).size } catch (e) {
    return { ok: false, why: '打不开：' + String((e && e.message) || e), turns: [] }
  }
  const start = Math.max(0, size - cfg.tailBytes)
  const buf = Buffer.alloc(size - start)
  try { fs.readSync(fd, buf, 0, buf.length, start) } catch (e) {
    try { fs.closeSync(fd) } catch {}
    return { ok: false, why: '读失败：' + String((e && e.message) || e), turns: [] }
  }
  try { fs.closeSync(fd) } catch {}

  // 切帧 → 逐帧解压 → 逐行解析
  const frames = []
  let i = buf.indexOf(MAGIC, 0)
  while (i !== -1) {
    let j = buf.indexOf(MAGIC, i + 4)
    if (j === -1) j = buf.length
    frames.push(buf.subarray(i, j))
    i = buf.indexOf(MAGIC, j)
  }
  const turns = []
  for (const f of frames) {
    let text = ''
    try { text = zlib.zstdDecompressSync(f).toString('utf8') } catch { continue }
    for (const line of text.split('\n')) {
      const s = line.trim()
      if (!s || s[0] !== '{') continue
      let r
      try { r = JSON.parse(s) } catch { continue }
      if (r.type !== 'assistant/message' || !r.data || !r.data.message) continue
      const c = r.data.message.content
      if (!Array.isArray(c)) continue
      let reasoning = '', reply = '', tools = 0
      for (const b of c) {
        if (!b) continue
        if (b.type === 'reasoning') reasoning += (b.text || '')
        else if (b.type === 'text') reply += (b.text || '')
        else if (b.type === 'toolCall' || b.type === 'tool_call') tools++
      }
      if (!reasoning) continue
      turns.push({ seq: r.seq, time: r.time, reasoning, reply: reply.length, tools })
    }
  }
  const use = turns.slice(-cfg.maxTurns)
  return { ok: true, why: null, turns: use, total: turns.length, truncated: start > 0 }
}

/**
 * 扫一批活跃会话，给每个算当前多样性（用和判据同一套 declStats）。
 * ★ 只读，不改任何东西。
 */
export function scanActiveHostSessions (o) {
  const cfg = { ...DEFAULTS, ...(o || {}) }
  // ★ 2026-11-13 修：原来只传了 activeDays，**activeMinutes 被吞掉了** ——
  //   结果是「心跳想只扫最近 2 小时」也照样扫全部 194 个（28 秒）。
  const list = listActiveHostSessions({
    root: o && o.root,
    activeDays: cfg.activeDays,
    activeMinutes: cfg.activeMinutes,
  })
  const results = []
  for (const s of list.sessions) {
    const got = readHostSession(s.path, cfg)
    const long = (got.turns || []).filter((t) => t.reasoning.length >= cfg.minChars)
    if (!long.length) {
      results.push({ ...s, ok: got.ok, why: got.why, longTurns: 0, median: null, level: 'unknown' })
      continue
    }
    const uniq = long.map((t) => declStats(t.reasoning).uniqRatio)
    const win = uniq.slice(-3)
    const srt = win.slice().sort((a, b) => a - b)
    const median = srt[Math.floor(srt.length / 2)]
    const level = median <= 0.10 ? 'intervene' : median <= 0.15 ? 'warn' : median <= 0.25 ? 'watch' : 'none'
    results.push({
      ...s, ok: got.ok, why: got.why,
      longTurns: long.length, totalTurns: got.total || long.length,
      median: Math.round(median * 1000) / 1000,
      window: win.map((x) => Math.round(x * 1000) / 1000),
      level,
    })
  }
  results.sort((a, b) => (a.median === null ? 9 : a.median) - (b.median === null ? 9 : b.median))
  return {
    activeDays: cfg.activeDays,
    scanned: results.length,
    byLevel: results.reduce((acc, r) => { acc[r.level] = (acc[r.level] || 0) + 1; return acc }, {}),
    sessions: results,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ★★★ 2026-11-13（爀曦定，架构收敛）：**bridge 版扫描** —— v4 不再开 DSH 的目录
//
//   和上面那套文件直读**同构**（同一套 declStats / 同一套 level 判据），
//   区别只在「数据从哪来」：这边走 bridge 的 sessions/list + sessions/read。
//
//   ★ 失败必须外显：bridge 不在 / 没有 sessions 能力 → **抛错**，
//     不返回 { sessions: [] } 冒充「没有活跃会话」。
//     空数组和「读不到」在调用方眼里一模一样 —— 那正是今天所有坑的共同形状。
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 从 v4 认得的帧数组里抽「带 reasoning 的 assistant 轮」。
 * ★ 与 readHostSession 里的抽取逻辑**同口径**（type / data.message.content[].type）。
 */
export function turnsFromBridgeFrames (frames, cfgIn) {
  const cfg = { ...DEFAULTS, ...(cfgIn || {}) };
  const turns = [];
  for (const r of Array.isArray(frames) ? frames : []) {
    if (!r || r.type !== 'assistant/message' || !r.data || !r.data.message) continue;
    const c = r.data.message.content;
    if (!Array.isArray(c)) continue;
    let reasoning = '', reply = '', tools = 0;
    for (const b of c) {
      if (!b) continue;
      if (b.type === 'reasoning') reasoning += (b.text || '');
      else if (b.type === 'text') reply += (b.text || '');
      else if (b.type === 'toolCall' || b.type === 'tool_call') tools += 1;
    }
    if (!reasoning) continue;
    turns.push({ seq: r.seq, time: r.time, reasoning, reply: reply.length, tools });
  }
  const use = turns.slice(-cfg.maxTurns);
  return { turns: use, total: turns.length };
}

/**
 * bridge 版 scanActiveHostSessions —— 返回结构与文件版**逐字一致**。
 *
 * @param {object} control   ControlHub
 * @param {object} [o]       { activeDays, activeMinutes, ...DEFAULTS }
 * @returns {Promise<object>} { activeDays, activeMinutes, scanned, byLevel, sessions }
 */
export async function scanActiveHostSessionsViaBridge (control, o) {
  const cfg = { ...DEFAULTS, ...(o || {}) };
  const cutoff = cfg.activeMinutes > 0
    ? Date.now() - cfg.activeMinutes * 60 * 1000
    : Date.now() - cfg.activeDays * 24 * 3600 * 1000;

  // ① 列（bridge 按 mtime 倒序返回）
  const tList = Date.now();
  const listed = await listSessionsViaBridge(control, {});
  const msList = Date.now() - tList;
  const all = Array.isArray(listed.items) ? listed.items : [];
  const active = all.filter((x) => Number.isFinite(x.mtimeMs) && x.mtimeMs >= cutoff);

  const results = [];
  const timings = { list: msList, reads: [], stats: 0 };
  for (const s of active) {
    const sessionId = s.id;
    let got = null;
    let readError = null;
    const tRead = Date.now()
    try {
      // ★ 2026-11-13：只取最后 N 条（默认 1200）—— 换气只看最近几轮，不必解压整个会话。
      got = await readAllSessionViaBridge(control, sessionId, { tailFrames: cfg.bridgeTailFrames || 1200 });
    } catch (e) {
      readError = String((e && e.message) || e);
    }
    if (readError) {
      results.push({
        sessionId,
        workspace: s.workspace,
        bytes: s.sizeBytes,
        mtimeMs: s.mtimeMs,
        idleHours: Math.round((Date.now() - (s.mtimeMs || Date.now())) / 3600000),
        ok: false,
        why: 'bridge 读失败：' + readError,
        longTurns: 0,
        median: null,
        level: 'unknown',
      });
      continue;
    }
    const msRead = Date.now() - tRead;
    const tStats = Date.now();
    const { turns } = turnsFromBridgeFrames(got.frames, cfg);
    const msStats = Date.now() - tStats;
    timings.reads.push({ sessionId, ms: msRead, frames: got.frames.length, msStats });
    timings.stats += msStats;
    const long = turns.filter((t) => t.reasoning.length >= cfg.minChars);
    if (!long.length) {
      results.push({
        sessionId, workspace: s.workspace, bytes: s.sizeBytes, mtimeMs: s.mtimeMs,
        idleHours: Math.round((Date.now() - (s.mtimeMs || Date.now())) / 3600000),
        ok: true, why: null, longTurns: 0, median: null, level: 'unknown',
      });
      continue;
    }
    const uniq = long.map((t) => declStats(t.reasoning).uniqRatio);
    const win = uniq.slice(-3);
    const srt = win.slice().sort((a, b) => a - b);
    const median = srt[Math.floor(srt.length / 2)];
    const level = median <= 0.10 ? 'intervene' : median <= 0.15 ? 'warn' : median <= 0.25 ? 'watch' : 'none';
    results.push({
      sessionId, workspace: s.workspace, bytes: s.sizeBytes, mtimeMs: s.mtimeMs,
      idleHours: Math.round((Date.now() - (s.mtimeMs || Date.now())) / 3600000),
      ok: true, why: null,
      longTurns: long.length, totalTurns: turns.length,
      median: Math.round(median * 1000) / 1000,
      window: win.map((x) => Math.round(x * 1000) / 1000),
      level,
    });
  }

  results.sort((a, b) => (a.median === null ? 9 : a.median) - (b.median === null ? 9 : b.median));
  return {
    activeDays: cfg.activeDays,
    activeMinutes: cfg.activeMinutes,
    scanned: results.length,
    byLevel: results.reduce((acc, r) => { acc[r.level] = (acc[r.level] || 0) + 1; return acc }, {}),
    sessions: results,
    viaBridge: true,
    // ★ 2026-11-13：分段耗时 —— 「慢」必须能拆开，否则只能猜。
    timings,
  };
}
