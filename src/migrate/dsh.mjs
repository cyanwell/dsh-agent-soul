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