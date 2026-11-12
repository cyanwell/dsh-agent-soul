// DSH 会话 → agent-soul 帧
//
// ★ 格式（2026-11-07 实测）：
//   `session.v4.jsonl.zstd` 是**多帧 zstd** —— 每个 zstd frame 里是一行或多行 JSON。
//   `zstdDecompressSync(整文件)` **只解第一帧**，会得到一条 header 就停 —— 这是最大的坑。
//   必须扫魔数 0x28B52FFD 逐个解。
//
// ★ 事件类型里只有四类要迁（其余是运行时状态，迁过去没意义）：
//   user/message  → user        data.content[] 里 type=text 的 text
//   assistant/message → assistant  data.message.content[] 里 text / reasoning
//   tool/call     → tool_call   data.name + data.arguments
//   tool/result   → tool_result data.message.content[] 的 text

import fs from 'node:fs';
import zlib from 'node:zlib';
import { FRAME } from '../session/frame.mjs';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 找出所有 zstd 帧的起点 */
export function frameOffsets(buf) {
  const pos = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) pos.push(i);
  }
  return pos;
}

/**
 * 读一个 DSH 会话文件，返回所有记录。
 * @returns { records: object[], badFrames: number }
 */
export function readDshSession(filePath) {
  const buf = fs.readFileSync(filePath);
  const pos = frameOffsets(buf);
  if (!pos.length) throw new Error('不是 zstd 文件（找不到帧魔数）: ' + filePath);

  const records = [];
  let badFrames = 0;

  for (let k = 0; k < pos.length; k++) {
    const start = pos[k];
    const end = k + 1 < pos.length ? pos[k + 1] : buf.length;
    let text;
    try { text = zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8'); }
    catch { badFrames++; continue; }
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { records.push(JSON.parse(t)); } catch { badFrames++; }
    }
  }

  return { records, badFrames, bytes: buf.length, frames: pos.length };
}

// ── 分片版（2026-11-10）────────────────────────────────────────────────
//
// ★ 为什么要有它：soul-sync 的 round() 同步跑 40 个会话，而**逐帧
//   zstdDecompressSync + JSON.parse 是那条链上最贵的一段**。实测 39.18MB 样本
//   （9245 个 zstd 帧）：读文件 28ms + 扫魔数 76ms + 逐帧 3304ms（p95 0.88ms/帧、
//   最慢单帧 22.6ms）。也就是说 3.4 秒里事件循环是死的 —— 用户恰好在这几秒里关窗，
//   POST /api/shutdown 就进不来（shutdown.log 里那行 graceful:false 就是这么来的）。
//   ★ 只在文件之间让出不够：**最大的那个文件自己就能占满整个窗口**。
//
// ★ 只让出、不改语义：帧边界判据、解压方式、坏帧计数与同步版逐条对应。
//   验收办法不是「看着一样」，是 A/B：同一份样本两边各跑一遍，
//   {files,wrote,touched,skipped} 与 sync-state.json 的 sha256 必须逐位相同。

function yieldToLoop() {
  return new Promise((resolve) => {
    if (typeof setImmediate === 'function') setImmediate(resolve);
    else setTimeout(resolve, 0);
  });
}

/**
 * 分片版扫魔数 —— 与 frameOffsets 逐字节等价，只是每 chunkBytes 让出一次。
 * ★ 判据是 `i < lim && i + 4 <= buf.length`（不是 `i + 4 <= lim`）：
 *   每个**起点**只归它所在的那一片 —— 跨片的那几个字节由它自己那片负责，
 *   既不会漏（不需要重叠窗口），也不会重复。
 */
async function frameOffsetsPaced(buf, pace, chunkBytes) {
  const len = buf.length;
  const pos = [];
  const chunk = chunkBytes > 0 ? chunkBytes : 2097152;
  for (let s = 0; s < len; s += chunk) {
    const lim = Math.min(len, s + chunk);
    for (let i = s; i < lim && i + 4 <= len; i++) {
      if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) pos.push(i);
    }
    if (!(await pace())) return { pos, aborted: true };
  }
  return { pos, aborted: false };
}

/**
 * 读一个 DSH 会话文件（分片版）：逐帧循环按**时间预算**让出事件循环。
 *
 * ★ 与 readDshSession 的差别只有三处，语义一处没动：
 *   ① 文件读走 fs.promises.readFile —— 同步读 39MB 是 28ms，线性外推 294MB 约
 *      210ms，那已经超过「单次阻塞 ≤50ms」的目标；异步读把它挪出事件循环。
 *   ② 扫魔数分片（39MB 实测 76ms，294MB 外推约 570ms）。
 *   ③ 逐帧解压之间按 yieldMs 攒时间让出。
 *
 * ★ 返回结构比同步版多三个字段：aborted / yields / maxBlockMs。
 *   aborted=true 表示「中途被取消（关闭中）或档期用尽」，此时 records 是**半截的**，
 *   调用方必须丢弃它、不许据此推进水位。
 *
 * @param {string} filePath
 * @param {object} [opts]
 * @param {number} [opts.yieldMs=8] 攒够多少毫秒的活就让出一次
 * @param {number} [opts.chunkBytes=2097152] 扫魔数每片多少字节
 * @param {function} [opts.shouldStop] 让出回来问一次：true = 立刻收手
 * @returns {Promise<{records:object[],badFrames:number,bytes:number,frames:number,
 *   aborted:boolean,yields:number,maxBlockMs:number}>}
 */
export async function readDshSessionAsync(filePath, opts) {
  const o = opts || {};
  const yieldMs = Number(o.yieldMs) > 0 ? Number(o.yieldMs) : 8;
  const chunkBytes = Number(o.chunkBytes) > 0 ? Number(o.chunkBytes) : 2097152;
  const shouldStop = typeof o.shouldStop === 'function' ? o.shouldStop : null;

  const stats = { yields: 0, maxBlockMs: 0 };
  let last = Date.now();
  // 让出一次；返回 false 表示该收手了。maxBlockMs 记的是「两次让出之间」——
  // 那正是事件循环被占住的最长间隔，不是平均值。
  const pace = async () => {
    const gap = Date.now() - last;
    if (gap > stats.maxBlockMs) stats.maxBlockMs = gap;
    if (gap < yieldMs) return true;
    await yieldToLoop();
    stats.yields++;
    last = Date.now();
    if (shouldStop && shouldStop()) return false;
    return true;
  };

  const buf = await fs.promises.readFile(filePath);
  // ★ 异步读不占事件循环，但它的**等待时长**会被算进「两次让出之间」的间隔 ——
  //   那会把读文件的时间记到阻塞账上（实测会把 99ms 的读等待记成一次阻塞）。
  //   读完重新起算：maxBlockMs 只该量「我们自己在跑」的那几段。
  last = Date.now();
  const scanned = await frameOffsetsPaced(buf, pace, chunkBytes);
  const pos = scanned.pos;
  if (!pos.length) throw new Error('不是 zstd 文件（找不到帧魔数）: ' + filePath);

  const records = [];
  let badFrames = 0;
  const base = { bytes: buf.length, frames: pos.length, get yields() { return stats.yields; }, get maxBlockMs() { return stats.maxBlockMs; } };

  if (scanned.aborted) return { records, badFrames, aborted: true, ...base };

  for (let k = 0; k < pos.length; k++) {
    const start = pos[k];
    const end = k + 1 < pos.length ? pos[k + 1] : buf.length;
    let text;
    try { text = zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8'); }
    catch { badFrames++; }
    if (text) {
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try { records.push(JSON.parse(t)); } catch { badFrames++; }
      }
    }
    if (!(await pace())) return { records, badFrames, aborted: true, ...base };
  }

  return { records, badFrames, aborted: false, ...base };
}

/** 从 content 数组里抽正文 */
function textOf(content) {
  if (!Array.isArray(content)) return { text: '', reasoning: '' };
  const texts = [];
  const reasons = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'text' && c.text) texts.push(String(c.text));
    else if (c.type === 'reasoning' && c.text) reasons.push(String(c.text));
  }
  return { text: texts.join('\n'), reasoning: reasons.join('\n') };
}

/**
 * 把 DSH 记录转成 agent-soul 的帧数组（不含帧 0）。
 * ★ 只保留有信息量的四类；其余（permission/sandbox/turn/step/request…）跳过 ——
 *   它们是运行时状态，不是内容。迁过来只会把索引搅浑。
 */
export function toFrames(records) {
  const out = [];
  const skipped = {};

  for (const r of records) {
    if (!r || !r.type) continue;
    const t = r.time || r.createdAt || Date.now();

    if (r.type === 'user/message') {
      const { text } = textOf(r.data && r.data.content);
      if (!text) { skipped['user/message(空)'] = (skipped['user/message(空)'] || 0) + 1; continue; }
      out.push({ type: FRAME.USER, t, text, meta: { src: 'dsh', seq: r.seq } });
      continue;
    }

    if (r.type === 'assistant/message') {
      const m = (r.data && r.data.message) || {};
      const { text, reasoning } = textOf(m.content);
      if (!text && !reasoning) { skipped['assistant/message(空)'] = (skipped['assistant/message(空)'] || 0) + 1; continue; }
      const payload = { t, text, meta: { src: 'dsh', seq: r.seq } };
      if (reasoning) payload.reasoning = reasoning;
      out.push({ type: FRAME.ASSISTANT, ...payload });
      continue;
    }

    if (r.type === 'tool/call') {
      const d = r.data || {};
      let argText = '';
      try { argText = typeof d.arguments === 'string' ? d.arguments : JSON.stringify(d.arguments); } catch { argText = ''; }
      out.push({ type: FRAME.TOOL_CALL, t, name: d.name || '?', args: d.arguments, callId: d.callId, text: '[调用] ' + (d.name || '?') + ' ' + String(argText).slice(0, 500), meta: { src: 'dsh', seq: r.seq } });
      continue;
    }

    if (r.type === 'tool/result') {
      const m = (r.data && r.data.message) || {};
      const { text } = textOf(m.content);
      out.push({ type: FRAME.TOOL_RESULT, t, content: text, callId: (r.data && r.data.toolCallId) || m.toolCallId, text: '[结果] ' + String(text).slice(0, 500), meta: { src: 'dsh', seq: r.seq } });
      continue;
    }

    skipped[r.type] = (skipped[r.type] || 0) + 1;
  }

  return { frames: out, skipped };
}

/**
 * 把一个 DSH 会话迁进 store。
 * ★ 用 DSH 的会话 id 做容器 id —— 这样「同一场对话」在新旧两边能对上号。
 */
export function migrateOne(store, filePath, opts) {
  const o = opts || {};
  const { records, badFrames, bytes, frames: zframes } = readDshSession(filePath);
  const header = records.find(r => r.type === 'session');
  if (!header) throw new Error('没有 session 头: ' + filePath);

  const id = o.id || header.id;
  if (o.dryRun) {
    const mapped = toFrames(records);
    return { id, bytes, zframes, records: records.length, frames: mapped.frames.length, badFrames, skipped: mapped.skipped, dryRun: true };
  }

  const s = store.load(id);
  if (!s) store.create(header.cwd || null, header.agentPreset || null, { id });

  const { frames, skipped } = toFrames(records);
  let written = 0;
  for (const f of frames) {
    const payload = {};
    for (const [k, v] of Object.entries(f)) {
      if (k === 'type' || k === 't' || v === undefined) continue;
      payload[k] = v;
    }
    if (f.t) payload.__t = f.t;   // 原时间戳留着（append 会用 nowMs，这里留给事后校正）
    store.append(id, f.type, payload);
    written++;
  }

  return { id, bytes, zframes, records: records.length, frames: written, badFrames, skipped, cwd: header.cwd, preset: header.agentPreset };
}