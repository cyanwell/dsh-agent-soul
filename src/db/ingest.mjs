// src/db/ingest.mjs —— 一帧的入库事务。
//
// 同事务写四张表：sources / sessions / frame_index / sync_cursors。
// 幂等与冲突的判定只看 (source_id, session_id, seq) 上的 content_hash：
//   同 hash → no-op（整个事务回滚，一行都不动，连 indexed_at 都不改）
//   异 hash → INDEX_CONFLICT（不覆盖，回滚）
// 游标换文件（file_fingerprint 变了）却没带 reset → SOURCE_FINGERPRINT_CHANGED，整笔拒绝：
//   绝不留下"新指纹 + 旧偏移"这种看起来合法、实际会从错误位置续读的游标。
// 任何一步失败都整笔回滚 —— 不存在"帧写进去了但游标没动"的中间态。

import { createHash } from 'node:crypto';
import { fail, CODES } from './errors.mjs';
import { makePtr } from './ptr.mjs';
import { relToSource, resolveFramePath } from './locator.mjs';
import { ftsRowFor } from './search.mjs';
import {
  assertAuthority,
  assertHash,
  assertStreamFingerprint,
  assertInt,
  assertKind,
  assertNamespace,
  assertPath,
  assertPathKind,
  assertSeq,
  assertSessionId,
  assertSourceId,
  assertString,
  assertTailState,
  capSnippet,
} from './validate.mjs';

export function hashFrame(text) {
  if (typeof text !== 'string') {
    fail(CODES.INVALID_INPUT, 'hashFrame expects a string', { type: typeof text });
  }
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function normalizeSource(src) {
  if (!src || typeof src !== 'object') fail(CODES.INVALID_INPUT, 'record.source is required', { source: src });
  const sourceId = assertSourceId(src.sourceId, 'source.sourceId');
  const kind = assertKind(src.kind, 'source.kind');
  const namespace = assertNamespace(src.namespace, 'source.namespace');
  const authority = assertAuthority(src.authority, 'source.authority');
  const rawPath = assertPath(src.rawPath, 'source.rawPath');
  const pathKind = src.pathKind === undefined ? 'file' : assertPathKind(src.pathKind, 'source.pathKind');

  // log: 只指 DSH 原文；V4 镜像必须用自己的命名空间。JS 这里是早的一道，
  // 库层还有 v2 触发器（任何绕过本函数的直插都会被 SQL 拒绝）。
  if (namespace === 'log') {
    if (kind !== 'dsh-log') fail(CODES.INVALID_INPUT, 'namespace log is reserved for kind dsh-log', { kind });
    if (authority !== 'primary') fail(CODES.INVALID_INPUT, 'namespace log is reserved for authority primary', { authority });
  } else if (authority === 'primary') {
    fail(CODES.INVALID_INPUT, 'authority primary is reserved for namespace log', { namespace, authority });
  }
  return { sourceId, kind, namespace, authority, rawPath, pathKind };
}

function normalizeSession(sess, sourceId) {
  if (!sess || typeof sess !== 'object') fail(CODES.INVALID_INPUT, 'record.session is required', { session: sess });
  const sessionId = assertSessionId(sess.sessionId, 'session.sessionId');
  const containerId = sess.containerId === undefined || sess.containerId === null
    ? null
    : assertString(sess.containerId, 'session.containerId', { min: 1, max: 128 });
  return { sourceId, sessionId, containerId };
}

function normalizeFrame(frame, source) {
  if (!frame || typeof frame !== 'object') fail(CODES.INVALID_INPUT, 'record.frame is required', { frame });
  const seq = assertSeq(frame.seq, 'frame.seq');
  const frameOrdinal = assertInt(frame.frameOrdinal, 'frame.frameOrdinal', { min: 0 });
  const rawPath = frame.rawPath === undefined ? source.rawPath : assertPath(frame.rawPath, 'frame.rawPath');
  const relPath = relToSource(source.rawPath, rawPath);
  // D2：根外帧没有可搬迁的定位。允许入库等于制造一条「看起来成功、实际钉死」的帧，
  // 所以在这里、在事务开始之前拒收；四张表一行都不写。相对路径按 source 根解释，
  // '..' 逃出根的同样算根外（见 locator.relToSource）。
  if (relPath === null) {
    fail(CODES.PATH_OUTSIDE_SOURCE_ROOT, 'frame.rawPath is outside source.rawPath; refusing to index a frame the source root cannot relocate', {
      frameRawPath: rawPath,
      sourceRawPath: source.rawPath,
      hint: 'P1b must only ingest frames that live under the source root; relative paths are resolved against it',
    });
  }
  const authority = frame.authority === undefined ? source.authority : assertAuthority(frame.authority, 'frame.authority');
  if (authority !== source.authority) {
    fail(CODES.INVALID_INPUT, 'frame.authority must equal source.authority', { frameAuthority: authority, sourceAuthority: source.authority });
  }
  let contentHash = null;
  if (frame.contentHash !== undefined && frame.contentHash !== null) {
    contentHash = assertHash(frame.contentHash, 'frame.contentHash');
  }
  // snippet 是检索材料，不是原文：只有上限 4096 + 显式截断标记，绝不因为它超长而拒帧。
  const snippetSource = frame.snippet === undefined || frame.snippet === null
    ? (typeof frame.text === 'string' ? frame.text : '')
    : assertString(frame.snippet, 'frame.snippet', { trim: false });
  const capped = capSnippet(snippetSource);
  if (contentHash === null) {
    if (typeof frame.text !== 'string') {
      fail(CODES.INVALID_INPUT, 'frame requires contentHash or text', { seq });
    }
    // ★ hash 永远针对调用方给的原始 canonical 内容（full text），不是截断后的 snippet。
    contentHash = hashFrame(frame.text);
  }
  const type = frame.type === undefined || frame.type === null
    ? null
    : assertString(frame.type, 'frame.type', { min: 1, max: 64 });
  const eventAt = frame.eventAt === undefined || frame.eventAt === null
    ? null
    : assertString(frame.eventAt, 'frame.eventAt', { min: 1, max: 64 });
  return {
    seq, frameOrdinal, rawPath, relPath, authority, contentHash,
    snippet: capped.snippet, snippetTruncated: capped.truncated, type, eventAt,
  };
}

function normalizeCursor(cursor, session, frame) {
  if (!cursor || typeof cursor !== 'object') fail(CODES.INVALID_INPUT, 'record.cursor must be an object when provided', { cursor });
  const streamKey = cursor.streamKey === undefined
    ? 'session:' + session.sessionId
    : assertString(cursor.streamKey, 'cursor.streamKey', { min: 1, max: 256 });
  const nextSeq = cursor.nextSeq === undefined ? frame.seq + 1 : assertInt(cursor.nextSeq, 'cursor.nextSeq', { min: 0 });
  const frameOrdinal = cursor.frameOrdinal === undefined ? frame.frameOrdinal : assertInt(cursor.frameOrdinal, 'cursor.frameOrdinal', { min: 0 });
  const tailOffset = cursor.tailOffset === undefined ? 0 : assertInt(cursor.tailOffset, 'cursor.tailOffset', { min: 0 });
  const tailState = cursor.tailState === undefined ? 'closed' : assertTailState(cursor.tailState, 'cursor.tailState');

  // ★ P1b：新写游标只接受 makeStreamFingerprint() 的产物（64 位小写 hex）。
  //   首帧身份还没建立（首帧不完整 → 指纹算不出来）时，唯一正确的答案是整笔拒收：
  //   既不写帧也不推进游标 —— 否则「帧进了、游标没动」就是 P1a T7 明令禁止的中间态，
  //   调用方会永远重读同一帧。想先收帧、后建身份，就不传 cursor（那是允许的）。
  //   历史库里的自由字符串（'file-A' 之类）只读兼容：getCursor 照样能读出来，
  //   但任何新写都必须换成真指纹；与旧值不同会被 SOURCE_FINGERPRINT_CHANGED 要求 reset。
  if (cursor.fileFingerprint === undefined || cursor.fileFingerprint === null) {
    fail(CODES.STREAM_IDENTITY_REQUIRED, 'cursor is being advanced but the stream identity is not established: fileFingerprint must be the 64-hex output of makeStreamFingerprint() (it returns null when the first complete frame is unavailable)', {
      streamKey,
      hint: 'call makeStreamFingerprint({ parserVersion, sessionId, firstCompleteFrame }) and pass the result; omit cursor entirely to index a frame without advancing it',
      reason: cursor.fileFingerprint === null ? 'fileFingerprint was explicitly null' : 'fileFingerprint was omitted',
    });
  }
  const fileFingerprint = assertStreamFingerprint(cursor.fileFingerprint, 'cursor.fileFingerprint');
  const reset = cursor.reset === true;
  return { streamKey, nextSeq, frameOrdinal, tailOffset, tailState, fileFingerprint, reset };
}

const UPSERT_SOURCE_SQL = [
  'INSERT INTO sources (source_id, kind, namespace, authority, raw_path, path_kind, created_at, updated_at)',
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  'ON CONFLICT(source_id) DO UPDATE SET',
  '  raw_path = excluded.raw_path,',
  '  path_kind = excluded.path_kind,',
  '  updated_at = excluded.updated_at',
].join(' ');

const UPSERT_SESSION_SQL = [
  'INSERT INTO sessions (source_id, session_id, container_id, first_seen_at, last_seen_at)',
  'VALUES (?, ?, ?, ?, ?)',
  'ON CONFLICT(source_id, session_id) DO UPDATE SET',
  '  container_id = COALESCE(excluded.container_id, sessions.container_id),',
  '  last_seen_at = excluded.last_seen_at',
].join(' ');

const UPSERT_CURSOR_SQL = [
  'INSERT INTO sync_cursors (source_id, stream_key, session_id, next_seq, frame_ordinal, tail_offset, file_fingerprint, tail_state, updated_at)',
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  'ON CONFLICT(source_id, stream_key) DO UPDATE SET',
  '  session_id = excluded.session_id,',
  '  next_seq = CASE WHEN ? THEN excluded.next_seq ELSE max(sync_cursors.next_seq, excluded.next_seq) END,',
  '  frame_ordinal = CASE WHEN ? THEN excluded.frame_ordinal ELSE max(COALESCE(sync_cursors.frame_ordinal, 0), COALESCE(excluded.frame_ordinal, 0)) END,',
  '  tail_offset = CASE WHEN ? THEN excluded.tail_offset ELSE max(sync_cursors.tail_offset, excluded.tail_offset) END,',
  '  file_fingerprint = COALESCE(excluded.file_fingerprint, sync_cursors.file_fingerprint),',
  '  tail_state = excluded.tail_state,',
  '  updated_at = excluded.updated_at',
].join(' ');

function touchSourceMeta(db, source) {
  const row = db.prepare('select kind, namespace, authority from sources where source_id = ?').get(source.sourceId);
  if (row && (row.kind !== source.kind || row.namespace !== source.namespace || row.authority !== source.authority)) {
    fail(CODES.SOURCE_CONFLICT, 'source_id ' + source.sourceId + ' already exists with different kind/namespace/authority', {
      sourceId: source.sourceId,
      existing: { kind: row.kind, namespace: row.namespace, authority: row.authority },
      incoming: { kind: source.kind, namespace: source.namespace, authority: source.authority },
    });
  }
}

// 游标换文件护栏：指纹变了却没显式 reset → 整笔拒绝（C3）。
// 两条都非空才判定；NULL 表示"上一次没记录文件身份"，不存在旧偏移属于哪个文件的问题。
function assertFingerprintCompatible(db, source, cursor) {
  if (!cursor || cursor.reset) return;
  const prev = db.prepare('select file_fingerprint, tail_offset, frame_ordinal from sync_cursors where source_id = ? and stream_key = ?')
    .get(source.sourceId, cursor.streamKey);
  if (!prev || !prev.file_fingerprint || !cursor.fileFingerprint) return;
  if (prev.file_fingerprint === cursor.fileFingerprint) return;
  fail(CODES.SOURCE_FINGERPRINT_CHANGED, 'file_fingerprint changed for ' + cursor.streamKey + ' (' + prev.file_fingerprint + ' -> ' + cursor.fileFingerprint + ') without reset:true; refusing to mix a new file with the old offsets', {
    streamKey: cursor.streamKey,
    previousFingerprint: prev.file_fingerprint,
    incomingFingerprint: cursor.fileFingerprint,
    previousTailOffset: prev.tail_offset,
    previousFrameOrdinal: prev.frame_ordinal,
    hint: 'pass cursor.reset:true to rebuild the cursor for the new file',
  });
}

export function ingestRecord(db, record, options) {
  const o = options || {};
  const now = o.now || new Date().toISOString();

  // 全部校验在事务之外完成：非法输入不会留下任何痕迹。
  const source = normalizeSource(record && record.source);
  const session = normalizeSession(record && record.session, source.sourceId);
  const frame = normalizeFrame(record && record.frame, source);
  const cursor = record && record.cursor !== undefined && record.cursor !== null
    ? normalizeCursor(record.cursor, session, frame)
    : null;

  const ptr = makePtr(source.namespace, session.sessionId, frame.seq);

  db.exec('BEGIN IMMEDIATE');
  try {
    // 先判指纹，再动任何表 —— 换文件却没 reset 的整笔请求不该留下 source/session 的 touch。
    assertFingerprintCompatible(db, source, cursor);

    touchSourceMeta(db, source);
    try {
      db.prepare(UPSERT_SOURCE_SQL).run(
        source.sourceId, source.kind, source.namespace, source.authority,
        source.rawPath, source.pathKind, now, now,
      );
    } catch (err) {
      if (String(err.message).indexOf('UNIQUE') !== -1) {
        fail(CODES.SOURCE_CONFLICT, 'namespace ' + source.namespace + ' is already owned by another source_id: ' + err.message, { namespace: source.namespace });
      }
      throw err;
    }

    db.prepare(UPSERT_SESSION_SQL).run(source.sourceId, session.sessionId, session.containerId, now, now);

    const existing = db.prepare(
      'select content_hash, raw_path, raw_rel_path, frame_ordinal, ptr from frame_index where source_id = ? and session_id = ? and seq = ?',
    ).get(source.sourceId, session.sessionId, frame.seq);

    if (existing) {
      if (existing.content_hash === frame.contentHash) {
        // 严格 no-op：连 source/session 的 touch 一起回滚，库里没有任何一行被改。
        db.exec('ROLLBACK');
        const resolved = resolveFramePath(source.rawPath, existing.raw_rel_path, existing.raw_path);
        return {
          status: 'noop',
          ptr: existing.ptr,
          sourceId: source.sourceId,
          sessionId: session.sessionId,
          seq: frame.seq,
          frameOrdinal: existing.frame_ordinal,
          contentHash: frame.contentHash,
          rawPath: resolved.rawPath,
          rawPathAtIngest: existing.raw_path,
          rawPathDrift: resolved.rawPathDrift,
          relocatable: resolved.relocatable,
          relocation: resolved.relocation,
          frameOrdinalDrift: existing.frame_ordinal !== frame.frameOrdinal,
        };
      }
      fail(CODES.INDEX_CONFLICT, 'frame ' + ptr + ' already indexed with a different content_hash', {
        ptr,
        existingHash: existing.content_hash,
        incomingHash: frame.contentHash,
        existingRawPath: existing.raw_path,
        incomingRawPath: frame.rawPath,
      });
    }

    db.prepare([
      'INSERT INTO frame_index (source_id, session_id, seq, raw_path, raw_rel_path, frame_ordinal, authority, ptr, snippet, snippet_truncated, content_hash, type, event_at, indexed_at)',
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ].join(' ')).run(
      source.sourceId, session.sessionId, frame.seq, frame.rawPath, frame.relPath,
      frame.frameOrdinal, frame.authority, ptr, frame.snippet, frame.snippetTruncated ? 1 : 0,
      frame.contentHash, frame.type, frame.eventAt, now,
    );

    // ★ P1b：FTS 与帧在同一笔事务里写，rowid 一一对应。
    //   last_insert_rowid() 必须紧跟帧插入取（游标写入之后就不再有意义）。
    //   先删后插是幂等保护：万一同一 rowid 残留了旧 FTS 行（重建过索引、或历史库补建），
    //   直接 INSERT 会撞 rowid 约束、把整笔 ingest 打回 —— 删除再插才是「这一行现在的内容」。
    const frameRowId = db.prepare('select last_insert_rowid() as rid').get().rid;
    const fts = ftsRowFor({
      rowid: frameRowId,
      ptr,
      source_id: source.sourceId,
      session_id: session.sessionId,
      seq: frame.seq,
      snippet: frame.snippet,
    });
    db.prepare('delete from frame_fts where rowid = ?').run(fts.rowid);
    db.prepare([
      'INSERT INTO frame_fts (rowid, search_text, raw_text, ptr, source_id, session_id, seq)',
      'VALUES (?, ?, ?, ?, ?, ?, ?)',
    ].join(' ')).run(fts.rowid, fts.searchText, fts.rawText, fts.ptr, fts.sourceId, fts.sessionId, fts.seq);

    // 游标放在最后写：它的任何校验失败都会把上面那帧一起回滚（见自测 T6）。
    if (cursor) {
      db.prepare(UPSERT_CURSOR_SQL).run(
        source.sourceId, cursor.streamKey, session.sessionId, cursor.nextSeq,
        cursor.frameOrdinal, cursor.tailOffset, cursor.fileFingerprint, cursor.tailState, now,
        cursor.reset ? 1 : 0, cursor.reset ? 1 : 0, cursor.reset ? 1 : 0,
      );
    }

    db.exec('COMMIT');
    const resolved = resolveFramePath(source.rawPath, frame.relPath, frame.rawPath);
    return {
      status: 'inserted',
      ptr,
      sourceId: source.sourceId,
      sessionId: session.sessionId,
      seq: frame.seq,
      frameOrdinal: frame.frameOrdinal,
      contentHash: frame.contentHash,
      rawPath: resolved.rawPath,
      rawPathAtIngest: frame.rawPath,
      rawPathDrift: resolved.rawPathDrift,
      relocatable: resolved.relocatable,
      relocation: resolved.relocation,
      snippetTruncated: frame.snippetTruncated,
      ftsRowid: frameRowId,
      ftsTokens: fts.tokenCount,
    };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 可能已回滚 */ }
    throw err;
  }
}
