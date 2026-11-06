// 一帧 = 一个索引单位。
// ★ 这是解耦后的核心约定：写入路径同时产出「可读内容」和「可检索索引」，
//   索引不再依赖任何压缩动作。

import crypto from 'node:crypto';

/** 帧类型 —— 与旧系统的概念对齐，但字段是我们自己的 */
export const FRAME = {
  SESSION: 'session',   // 第 0 帧：会话头
  USER: 'user',
  ASSISTANT: 'assistant',
  TOOL_CALL: 'tool_call',
  TOOL_RESULT: 'tool_result',
  SYSTEM: 'system',
  ERROR: 'error',
  EVENT: 'event',   // 事件层产生的事件，也进索引
};

export function nowMs() { return Date.now(); }

export function newSessionId() {
  return 's_' + crypto.randomBytes(8).toString('hex');
}

/** 第 0 帧：会话头。cwd 写在这里，所以会话目录不能物理搬移。 */
export function sessionHeader(id, cwd, persona) {
  return {
    seq: 0,
    t: nowMs(),
    type: FRAME.SESSION,
    v: 1,
    id,
    cwd,
    persona: persona || null,
  };
}

/** 造一帧（自动分配 seq / 时间） */
export function makeFrame(seq, type, payload) {
  return { seq, t: nowMs(), type, ...payload };
}

/**
 * 从一帧里抽出「可检索文本」。
 * ★ 索引就是这一步的产物 —— 与压缩无关。
 */
export function extractText(frame) {
  switch (frame.type) {
    case FRAME.USER: return frame.text || '';
    case FRAME.ASSISTANT: return frame.text || (frame.reasoning ? '' : '');
    case FRAME.SYSTEM: return frame.text || '';
    case FRAME.TOOL_CALL: return '[工具] ' + (frame.name || '') + ' ' + safeJson(frame.args);
    case FRAME.TOOL_RESULT: return '[结果] ' + truncate(String(frame.content ?? ''), 2000);
    case FRAME.ERROR: return '[错误] ' + (frame.message || '');
    case FRAME.EVENT: return frame.text || ('[事件] ' + (frame.eventType || ''));
    default: return '';
  }
}

function safeJson(o) {
  try { return truncate(JSON.stringify(o), 500); } catch { return ''; }
}
function truncate(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }
