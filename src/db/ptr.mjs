// src/db/ptr.mjs —— 门牌（ptr）的编码与解码。
//
// 门牌形状：<namespace>:<sessionId>#seq=<n>
//   log:session-abc#seq=12      → DSH 原文（一手）
//   v4log:session-abc#seq=12    → V4 镜像（另一命名空间，与 log 不互通）
//
// 铁律：
//   1. namespace 唯一确定 source_id，所以 ptr 不会跨 source 歧义。
//   2. 同 session 在两个 source 里出现同一个 seq 是合法的两条记录，ptr 也必须是两条。
//   3. 跨 source 不做 seq 等价 —— 不要在解析时拿 namespace 之外的字段去"猜"归属。
//   4. ptr 只定位，不表意；读取位置由「当前 sources.raw_path + frame_index.raw_rel_path + frame_ordinal」给出。
//      frame_index.raw_path 只是入库时的原始证据（见 store.resolvePtr）。
//   5. seq 只认规范十进制形状：#seq=0、#seq=1…… 前导零（#seq=01）不是同一个门牌，一律拒绝。
//      写入侧（makePtr）与校验侧（assertSeq）共用 MAX_PTR_SEQ，不存在"能入库却拼不出 ptr"的区间。

import { fail, CODES } from './errors.mjs';

export const DSH_NAMESPACE = 'log';
export const V4_NAMESPACE = 'v4log';

// ptr 的 seq 段是 1..15 位十进制；上界与 PTR_RE 的 \d{1,15} 严丝合缝。
export const MAX_PTR_SEQ = 999999999999999;

const PTR_RE = /^([a-z][a-z0-9_-]{0,31}):([A-Za-z0-9._-]{1,128})#seq=(\d{1,15})$/;

function assertCanonicalSeqText(text, ptr) {
  if (!/^(0|[1-9][0-9]*)$/.test(text)) {
    fail(CODES.PTR_MALFORMED, 'ptr seq must be canonical decimal without leading zeros: ' + ptr, { ptr, seqText: text });
  }
}

export function makePtr(namespace, sessionId, seq) {
  if (typeof namespace !== 'string' || namespace.length === 0) {
    fail(CODES.PTR_MALFORMED, 'ptr requires a non-empty namespace', { namespace });
  }
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    fail(CODES.PTR_MALFORMED, 'ptr requires a non-empty sessionId', { sessionId });
  }
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) {
    fail(CODES.PTR_MALFORMED, 'ptr requires a non-negative safe integer seq', { seq });
  }
  if (seq > MAX_PTR_SEQ) {
    fail(CODES.PTR_MALFORMED, 'ptr seq exceeds the representable range ' + MAX_PTR_SEQ, { seq, max: MAX_PTR_SEQ });
  }
  const ptr = namespace + ':' + sessionId + '#seq=' + String(seq);
  if (!PTR_RE.test(ptr)) {
    fail(CODES.PTR_MALFORMED, 'ptr does not match canonical shape: ' + ptr, { ptr });
  }
  return ptr;
}

export function parsePtr(ptr) {
  if (typeof ptr !== 'string') {
    fail(CODES.PTR_MALFORMED, 'ptr must be a string', { ptr });
  }
  const m = PTR_RE.exec(ptr);
  if (!m) {
    fail(CODES.PTR_MALFORMED, 'ptr must look like <namespace>:<sessionId>#seq=<n>', { ptr });
  }
  assertCanonicalSeqText(m[3], ptr);
  const seq = Number(m[3]);
  if (!Number.isSafeInteger(seq) || seq > MAX_PTR_SEQ) {
    fail(CODES.PTR_MALFORMED, 'ptr seq out of representable range', { ptr, max: MAX_PTR_SEQ });
  }
  return { raw: ptr, namespace: m[1], sessionId: m[2], seq };
}

export function isPtr(value) {
  if (typeof value !== 'string') return false;
  const m = PTR_RE.exec(value);
  return m !== null && /^(0|[1-9][0-9]*)$/.test(m[3]);
}
