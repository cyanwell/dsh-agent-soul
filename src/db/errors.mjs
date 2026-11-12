// src/db/errors.mjs —— 元数据层的错误码。所有失败都带一个稳定的 code，测试与调用方按 code 分支，不靠字符串匹配。

export class MetaStoreError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'MetaStoreError';
    this.code = code;
    this.details = details === undefined ? null : details;
  }
}

export const CODES = Object.freeze({
  INVALID_INPUT: 'INVALID_INPUT',
  INDEX_CONFLICT: 'INDEX_CONFLICT',
  SOURCE_CONFLICT: 'SOURCE_CONFLICT',
  SOURCE_FINGERPRINT_CHANGED: 'SOURCE_FINGERPRINT_CHANGED',
  MIGRATION_REQUIRED: 'MIGRATION_REQUIRED',
  MIGRATION_CHECKSUM_MISMATCH: 'MIGRATION_CHECKSUM_MISMATCH',
  MIGRATION_FAILED: 'MIGRATION_FAILED',
  SCHEMA_TOO_NEW: 'SCHEMA_TOO_NEW',
  READONLY: 'READONLY',
  PTR_MALFORMED: 'PTR_MALFORMED',
  PTR_UNKNOWN_NAMESPACE: 'PTR_UNKNOWN_NAMESPACE',
  PTR_NOT_FOUND: 'PTR_NOT_FOUND',
  STORE_BUSY: 'STORE_BUSY',
  ENGINE_UNSUPPORTED: 'ENGINE_UNSUPPORTED',
  STORE_CLOSED: 'STORE_CLOSED',
  // D2：帧的 raw_path 不在 source.raw_path 根下（ingest 直接拒帧，不写任何表）。
  PATH_OUTSIDE_SOURCE_ROOT: 'PATH_OUTSIDE_SOURCE_ROOT',
  // O1：schema_migrations 的已应用版本不是连续的 1..current（缺行、空史但有表）。
  MIGRATION_HISTORY_BROKEN: 'MIGRATION_HISTORY_BROKEN',
  // O2：旧库里有违反当前库层不变量的行（log 命名空间/authority 配对、帧 authority 跨表一致）。
  LEGACY_CONSTRAINT_VIOLATION: 'LEGACY_CONSTRAINT_VIOLATION',
  // P1b：relocateSource 指定的 source 不存在（不猜、不改、不留审计行）。
  SOURCE_NOT_FOUND: 'SOURCE_NOT_FOUND',
  // P1b：expectedOldRoot 与库里当前根不一致 —— 说明有人已经搬过，调用方的前提失效，整笔拒绝。
  SOURCE_ROOT_MISMATCH: 'SOURCE_ROOT_MISMATCH',
  // P1b：调用方在推进游标，但流身份（makeStreamFingerprint 的 64 位小写 hex）还没建立。
  // 首帧不完整时这是唯一正确的答案：整笔拒收，不写帧、不推进游标。
  STREAM_IDENTITY_REQUIRED: 'STREAM_IDENTITY_REQUIRED',
  // P1c：检索索引与帧行不一致（frame_fts 与 frame_index 有缺行/孤儿行）。
  // search 必须显式报这个码，绝不静默返回一份「看起来正常、实际漏帧」的结果。
  SEARCH_INDEX_STALE: 'SEARCH_INDEX_STALE',
  // P1c：产物元数据（v5）。
  ARTIFACT_NOT_FOUND: 'ARTIFACT_NOT_FOUND',
  // 登记/校验时文件不在（或被删了）：这是「缺失」，不是「内容不符」。
  ARTIFACT_FILE_MISSING: 'ARTIFACT_FILE_MISSING',
  // 目标不是普通文件（目录、或根本就是 source 根自己）：内容权威必须是文件。
  ARTIFACT_NOT_A_FILE: 'ARTIFACT_NOT_A_FILE',
  // 路径经符号链接/junction 落到 source 根之外：解析出来的 realpath 不在根内。
  ARTIFACT_PATH_ESCAPE: 'ARTIFACT_PATH_ESCAPE',
  // 产物状态只能是 present / stale / missing。
  ARTIFACT_STATUS_INVALID: 'ARTIFACT_STATUS_INVALID',
});

export function fail(code, message, details) {
  throw new MetaStoreError(code, message, details);
}

export function isMetaStoreError(err) {
  return err instanceof MetaStoreError;
}

// 把底层 sqlite 的忙碌失败（busy_timeout 用尽后的 'database is locked'）翻译成稳定错误码，
// 免得调用方拿到一个无 code 的裸 Error、按 code 分支时漏掉。其它错误原样抛出。
export function translateSqliteError(err) {
  if (isMetaStoreError(err)) return err;
  const text = err && err.message ? String(err.message) : '';
  const busy = (err && (err.errcode === 5 || err.errcode === 6)) || text.indexOf('database is locked') !== -1 || text.indexOf('database table is locked') !== -1;
  if (busy) {
    return new MetaStoreError(CODES.STORE_BUSY, 'database is busy (busy_timeout exhausted): ' + text, { sqliteErrcode: err && err.errcode === undefined ? null : err.errcode });
  }
  return err;
}
