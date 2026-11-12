// src/db/fingerprint.mjs —— 流身份指纹（cursor.file_fingerprint）的唯一算法。
//
// v4-P1a 二次验证 §3.4 的结论：指纹必须是「文件身份」，绝不能是 size / mtime。
// 同一次正常追加会让 size 和 mtime 每次都变，一旦把它们放进指纹，第二次追加就会被
// SOURCE_FINGERPRINT_CHANGED 整笔拒收 —— 表现是「索引静默停摆」，不是「数据坏了」。
//
// 唯一形状（逐字节固定，P1b 只许调用本函数，不许自己拼字符串）：
//   sha256( parserVersion + '\\0' + sessionId + '\\0' + firstCompleteFrame )
//
//   parserVersion       帧解析器的版本（解析规则变了才变，例如 'v4-frame-1'）
//   sessionId           会话 id（与 ptr 里的 sessionId 同一份）
//   firstCompleteFrame  该流里第一条完整帧的 canonical 文本（不是 snippet、不是截断后的）
//
// ★ 为什么用首帧：文件被轮转/重建 → 首帧变；文件正常增长 → 首帧不变，指纹不变。
// ★ 没有首帧时返回 null —— 这是「身份尚未建立」的显式值，cursor 层把 null 当作
//   「上一次没记录文件身份」而跳过比较。绝不允许调用方自己传 'unknown' / '' 之类的自由字符串
//   来假装有身份（那会让换文件检测静默失效）；空串与未知字段一律 INVALID_INPUT。

import { createHash } from 'node:crypto';
import { fail, CODES } from './errors.mjs';
import { assertSessionId, assertString } from './validate.mjs';

export const FINGERPRINT_SCHEME = "sha256(parserVersion + '\\0' + sessionId + '\\0' + firstCompleteFrame)";
export const FINGERPRINT_INPUT_KEYS = Object.freeze(['parserVersion', 'sessionId', 'firstCompleteFrame']);
export const FINGERPRINT_FORBIDDEN_KEYS = Object.freeze(['size', 'bytes', 'fileSize', 'mtime', 'mtimeMs', 'ctime', 'birthtime', 'stat']);

export function makeStreamFingerprint(input) {
  if (!input || typeof input !== 'object') {
    fail(CODES.INVALID_INPUT, 'makeStreamFingerprint expects { parserVersion, sessionId, firstCompleteFrame }', { input });
  }
  const keys = Object.keys(input);
  const forbidden = keys.filter(function (k) { return FINGERPRINT_FORBIDDEN_KEYS.indexOf(k) !== -1; });
  const unknown = keys.filter(function (k) { return FINGERPRINT_INPUT_KEYS.indexOf(k) === -1; });
  if (forbidden.length > 0 || unknown.length > 0) {
    fail(CODES.INVALID_INPUT, 'stream fingerprints are derived only from parserVersion/sessionId/firstCompleteFrame; size/mtime/other fields are forbidden because they change on every normal append', {
      forbidden,
      unknown,
      scheme: FINGERPRINT_SCHEME,
    });
  }

  const parserVersion = assertString(input.parserVersion, 'parserVersion', { min: 1, max: 64 });
  const sessionId = assertSessionId(input.sessionId, 'sessionId');

  if (input.firstCompleteFrame === undefined || input.firstCompleteFrame === null) {
    // 显式「没有首帧」：返回 null，由 cursor 层当作「身份尚未建立」处理。
    return null;
  }
  if (typeof input.firstCompleteFrame !== 'string') {
    fail(CODES.INVALID_INPUT, 'firstCompleteFrame must be the canonical text of the first complete frame', { type: typeof input.firstCompleteFrame });
  }
  if (input.firstCompleteFrame.length === 0) {
    fail(CODES.INVALID_INPUT, 'firstCompleteFrame must not be empty; pass null to mean "no identity yet"', { firstCompleteFrame: input.firstCompleteFrame });
  }

  return createHash('sha256')
    .update(parserVersion, 'utf8')
    .update('\u0000', 'utf8')
    .update(sessionId, 'utf8')
    .update('\u0000', 'utf8')
    .update(input.firstCompleteFrame, 'utf8')
    .digest('hex');
}
