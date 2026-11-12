// src/db/validate.mjs —— 入库前的一切输入校验都在这里，且都是纯函数（不碰库）。
// 规矩：非法输入在事务开始之前就被拒掉，绝不留下半条记录。
//
// ★ snippet 不是「非法输入」：它是可重建的检索材料，超长只会被截断（并显式标 snippet_truncated），
//   绝不因此否决一整帧入库。真正不可重建的是帧行（seq/定位/ordinal/content_hash）。

import { fail, CODES } from './errors.mjs';
import { MAX_PTR_SEQ } from './ptr.mjs';

const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const NAMESPACE_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const KIND_RE = /^[a-z][a-z0-9-]{0,31}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

export const AUTHORITIES = Object.freeze(['primary', 'mirror']);
export const PATH_KINDS = Object.freeze(['file', 'dir']);
export const TAIL_STATES = Object.freeze(['closed', 'open']);
export const KINDS = Object.freeze(['dsh-log', 'v4-mirror']);

// snippet 只有一个上限：4096。显式给的、从 text 派生的，都走这一条路。
export const SNIPPET_MAX = 4096;

function bad(field, message, value) {
  fail(CODES.INVALID_INPUT, 'invalid ' + field + ': ' + message, { field, value });
}

export function assertString(value, field, opts) {
  const o = opts || {};
  if (typeof value !== 'string') bad(field, 'must be a string', typeof value);
  if (o.trim !== false && value.trim() !== value) bad(field, 'must not have leading/trailing whitespace', value);
  if (typeof o.min === 'number' && value.length < o.min) bad(field, 'too short (min ' + o.min + ')', value.length);
  if (typeof o.max === 'number' && value.length > o.max) bad(field, 'too long (max ' + o.max + ')', value.length);
  if (o.nonEmpty && value.length === 0) bad(field, 'must not be empty', value);
  return value;
}

export function assertId(value, field) {
  assertString(value, field, { min: 1, max: 128 });
  if (!ID_RE.test(value)) bad(field, 'only letters, digits, dot, dash, underscore allowed', value);
  return value;
}

export function assertSourceId(value, field) {
  return assertId(value, field || 'sourceId');
}

export function assertSessionId(value, field) {
  return assertId(value, field || 'sessionId');
}

export function assertNamespace(value, field) {
  assertString(value, field || 'namespace', { min: 1, max: 32 });
  if (!NAMESPACE_RE.test(value)) bad(field || 'namespace', 'must match ' + NAMESPACE_RE, value);
  return value;
}

export function assertKind(value, field) {
  assertString(value, field || 'kind', { min: 1, max: 32 });
  if (KINDS.indexOf(value) === -1) bad(field || 'kind', 'must be one of ' + KINDS.join('|'), value);
  return value;
}

export function assertAuthority(value, field) {
  assertString(value, field || 'authority', { min: 1 });
  if (AUTHORITIES.indexOf(value) === -1) bad(field || 'authority', 'must be one of ' + AUTHORITIES.join('|'), value);
  return value;
}

export function assertPathKind(value, field) {
  assertString(value, field || 'pathKind', { min: 1 });
  if (PATH_KINDS.indexOf(value) === -1) bad(field || 'pathKind', 'must be one of ' + PATH_KINDS.join('|'), value);
  return value;
}

export function assertTailState(value, field) {
  assertString(value, field || 'tailState', { min: 1 });
  if (TAIL_STATES.indexOf(value) === -1) bad(field || 'tailState', 'must be one of ' + TAIL_STATES.join('|'), value);
  return value;
}

export function assertInt(value, field, opts) {
  const o = opts || {};
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) bad(field, 'must be a safe integer', value);
  if (typeof o.min === 'number' && value < o.min) bad(field, 'must be >= ' + o.min, value);
  if (typeof o.max === 'number' && value > o.max) bad(field, 'must be <= ' + o.max, value);
  return value;
}

// seq 的上界必须与 ptr 能表示的区间一致：否则会出现"能入库却拼不出门牌"的帧。
export function assertSeq(value, field) {
  return assertInt(value, field || 'seq', { min: 0, max: MAX_PTR_SEQ });
}

export function assertHash(value, field) {
  assertString(value, field || 'contentHash', { min: 64, max: 64, trim: false });
  if (!HASH_RE.test(value)) bad(field || 'contentHash', 'must be 64 lowercase hex chars (sha256)', value);
  return value;
}

// P1b：流身份指纹只接受 makeStreamFingerprint() 的产物形状 —— 64 位小写 hex。
// 为什么不能放自由字符串：'file-A' / 'unknown' / '' 这类值永远不会变，于是换文件检测静默失效
// （P1a 定点验证 CHANGES 2 说的就是这个口子）。历史库里已有的自由字符串只读兼容，新写一律拒。
const STREAM_FP_RE = /^[0-9a-f]{64}$/;

export const STREAM_FINGERPRINT_SCHEME = 'sha256-hex64-lowercase';

export function isStreamFingerprint(value) {
  return typeof value === 'string' && STREAM_FP_RE.test(value);
}

export function assertStreamFingerprint(value, field) {
  if (typeof value !== 'string') {
    bad(field || 'fileFingerprint', 'must be a 64-char lowercase hex string produced by makeStreamFingerprint()', typeof value);
  }
  if (!STREAM_FP_RE.test(value)) {
    fail(CODES.INVALID_INPUT, 'invalid ' + (field || 'fileFingerprint') + ': stream fingerprints are exactly 64 lowercase hex chars (makeStreamFingerprint output); free strings such as "unknown" are rejected because they never change and would silently disable file-rotation detection', {
      field: field || 'fileFingerprint',
      value,
      scheme: STREAM_FINGERPRINT_SCHEME,
      hint: 'call makeStreamFingerprint({ parserVersion, sessionId, firstCompleteFrame })',
    });
  }
  return value;
}

export function assertPath(value, field) {
  assertString(value, field || 'rawPath', { min: 1, max: 4096, trim: false });
  return value;
}

// 把任意长度的检索文本压到 SNIPPET_MAX，并显式汇报是否截断。
export function capSnippet(text) {
  const raw = text === undefined || text === null ? '' : String(text);
  if (raw.length > SNIPPET_MAX) {
    return { snippet: raw.slice(0, SNIPPET_MAX), truncated: true, originalLength: raw.length };
  }
  return { snippet: raw, truncated: false, originalLength: raw.length };
}
