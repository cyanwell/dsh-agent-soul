// src/db/store.mjs —— 元数据库的门面。外部只跟这个对象打交道。
//
// 生命周期：openMetaStore({ path, mode }) → store.migrate() → store.ingest(...) → store.close()
// 只读模式（mode: 'readonly'）永远不迁移；库没迁移就抛 MIGRATION_REQUIRED；
// 库比代码新（v99）时读和写都抛 SCHEMA_TOO_NEW —— 不降级、也不引导人去迁移。

import { openDatabase, configureConnection, engineInfo, assertEngine } from './engine.mjs';
import { readSchemaState, migrate as runMigrations } from './migrate.mjs';
import { ingestRecord, hashFrame } from './ingest.mjs';
import { parsePtr, makePtr, DSH_NAMESPACE, V4_NAMESPACE } from './ptr.mjs';
import { resolveFramePath } from './locator.mjs';
import { SCHEMA_VERSION, MIGRATIONS, rebuildFrameFts, ECHO_PTR_NAMESPACES, ECHO_SUMMARY_PTR_PREFIX } from './schema.mjs';
import { searchFrames, buildQueryPlan, searchIndexInfoFor, SEARCH_MODES, containsNeedle } from './search.mjs';
// ECHO 完整性判据的唯一实现（Task-14）。store 侧只做「取数 + 组装回执」，
// 不再自己抄一份 problem 明细 —— 抄两份的结果是两边字段名各长各的（maxBuild vs maxBuildGeneration）。
import { analyzeEchoIntegrity, echoMissingTables, isEchoSourceAligned } from './echo-integrity.mjs';
import {
  registerArtifact as doRegisterArtifact,
  getArtifact as doGetArtifact,
  listArtifacts as doListArtifacts,
  verifyArtifact as doVerifyArtifact,
  updateArtifact as doUpdateArtifact,
  listArtifactEvents as doListArtifactEvents,
  countArtifacts as doCountArtifacts,
  ARTIFACT_STATUSES,
  ARTIFACT_ACTIONS,
} from './artifacts.mjs';
import { relocateSource as doRelocateSource, listSourceRelocations as doListRelocations } from './relocate.mjs';
import { verifyPtrSample as verifySample } from './accept.mjs';
import { isStreamFingerprint } from './validate.mjs';
import { fail, CODES, translateSqliteError } from './errors.mjs';
import { registerEchoVectorModel, putEchoSourceVectors, deleteEchoSourceVectors, searchEchoSourceVectors } from './echo-vectors.mjs';

function mapFrame(row) {
  // rawPath 在这里是「入库时的原始证据」；可回取的当前路径只在 resolvePtr 里算。
  return {
    sourceId: row.source_id,
    sessionId: row.session_id,
    seq: row.seq,
    rawPath: row.raw_path,
    rawRelPath: row.raw_rel_path === undefined ? null : row.raw_rel_path,
    frameOrdinal: row.frame_ordinal,
    authority: row.authority,
    ptr: row.ptr,
    snippet: row.snippet,
    snippetTruncated: row.snippet_truncated === 1 || row.snippet_truncated === true,
    contentHash: row.content_hash,
    type: row.type === undefined ? null : row.type,
    eventAt: row.event_at === undefined ? null : row.event_at,
    indexedAt: row.indexed_at,
  };
}

// fingerprintKind 是「读兼容」的显式标记（P1b 前置 2）：
//   'hex64'     本版本写进去的流身份（makeStreamFingerprint 的输出）
//   'legacy'    历史库里的自由字符串（'file-A' 之类）—— 只读兼容，新写不接受
//   'none'      NULL（从未记录过文件身份）
// 调用方拿它决定「这一行还要不要 reset 一次」，而不是自己去猜字符串形状。
function mapCursor(row) {
  const fp = row.file_fingerprint;
  return {
    sourceId: row.source_id,
    streamKey: row.stream_key,
    sessionId: row.session_id,
    nextSeq: row.next_seq,
    frameOrdinal: row.frame_ordinal,
    tailOffset: row.tail_offset,
    fileFingerprint: fp,
    fingerprintKind: fp === null || fp === undefined ? 'none' : (isStreamFingerprint(fp) ? 'hex64' : 'legacy'),
    tailState: row.tail_state,
    updatedAt: row.updated_at,
  };
}


// ═══════════════════════════════════════════════════════════════════════════
// ECHO 派生索引（v9）—— 只读实现。放在门面之外，是为了让 store.echoXxx() 只有三行：
// 「assertOpen → ensureReady → 这一份实现」。判据与表名只在这里出现一次。
//
// 与 tools/echo-index-import.mjs 的关系：那边是**导入器 + 原型**（CLI，一次性），
// 这边是**常驻面**（src/ 不许 import tools/）。两份实现必须同语义，
// 防漂闸 = tools/echo-mcp-selftest.mjs 的 parity 段（同一语料、逐条比对）。
// ═══════════════════════════════════════════════════════════════════════════

// 与导入器同一个批量。它只影响往返次数，**不影响是否命中**（见 search.mjs 文件头）。
const ECHO_SEARCH_BATCH = 200;
const ECHO_LIMIT_MAX = 500;
const ECHO_CMP_ID_RE = /^[A-Za-z0-9._~-]{1,128}$/;
const ECHO_COUNT_SQL = Object.freeze({
  words: 'SELECT echo_source_id AS sid, COUNT(*) AS n FROM echo_words GROUP BY echo_source_id',
  wordsFts: 'SELECT echo_source_id AS sid, COUNT(*) AS n FROM echo_words_fts GROUP BY echo_source_id',
  summaries: 'SELECT echo_source_id AS sid, COUNT(*) AS n FROM echo_summaries GROUP BY echo_source_id',
  summariesFts: 'SELECT echo_source_id AS sid, COUNT(*) AS n FROM echo_summaries_fts GROUP BY echo_source_id',
  declaredSeqRows: 'SELECT echo_source_id AS sid, COALESCE(SUM(src_seq_count), 0) AS n FROM echo_summaries GROUP BY echo_source_id',
  seqRows: 'SELECT echo_source_id AS sid, COUNT(*) AS n FROM echo_summary_src_seqs GROUP BY echo_source_id',
  builds: 'SELECT echo_source_id AS sid, COUNT(*) AS n FROM echo_source_builds GROUP BY echo_source_id',
  maxBuildGeneration: 'SELECT echo_source_id AS sid, MAX(generation) AS n FROM echo_source_builds GROUP BY echo_source_id',
});


// 七张表的清单与缺表探测都搬到 ./echo-integrity.mjs（ECHO_INTEGRITY_TABLES / echoMissingTables）。
// ★ 只留一处定义：缺表口径（echoStats 回 available:false、检索抛 ECHO_INDEX_MISSING）用的是同一张表。


// v9 的「对齐」定义，原文照搬（与 echoIndexInfoFor 同一条判据）：
//   words == words_fts && summaries == summaries_fts && declared srcSeq rows == actual rows
// ★ 审计列的漂移（generation vs builds）不在这一条里 —— 那是 echoStats 的 problems，
//   不影响检索的正确性（它在 verifyEchoIntegrity 里另算）。
const ECHO_SOURCE_SELECT = [
  'SELECT s.echo_source_id AS sid, s.source_path AS path, s.source_version AS version, s.namespace AS ns,',
  '  s.generation AS generation, s.state AS state, s.cursor_seq AS cursor_seq, s.cursor_json AS cursor_json,',
  '  s.words_count AS declared_words, s.summaries_count AS declared_summaries, s.src_seq_count AS declared_src_seqs,',
  '  s.source_sha256 AS sha, s.source_bytes AS bytes, s.built_at AS built_at, s.imported_at AS imported_at, s.importer AS importer,',
  '  (SELECT COUNT(*) FROM echo_words w WHERE w.echo_source_id = s.echo_source_id) AS words,',
  '  (SELECT COUNT(*) FROM echo_words_fts f WHERE f.echo_source_id = s.echo_source_id) AS words_fts,',
  '  (SELECT COUNT(*) FROM echo_summaries m WHERE m.echo_source_id = s.echo_source_id) AS summaries,',
  '  (SELECT COUNT(*) FROM echo_summaries_fts f WHERE f.echo_source_id = s.echo_source_id) AS summaries_fts,',
  '  (SELECT COALESCE(SUM(m.src_seq_count), 0) FROM echo_summaries m WHERE m.echo_source_id = s.echo_source_id) AS declared_seq_rows,',
  '  (SELECT COUNT(*) FROM echo_summary_src_seqs q WHERE q.echo_source_id = s.echo_source_id) AS seq_rows,',
  '  (SELECT COUNT(*) FROM echo_source_builds b WHERE b.echo_source_id = s.echo_source_id) AS builds,',
  '  (SELECT MAX(b.generation) FROM echo_source_builds b WHERE b.echo_source_id = s.echo_source_id) AS max_build_generation',
].join(' ');

// ★ 两条 SQL 共用同一个 SELECT 前缀，**不靠字符串 replace 拼 WHERE** ——
//   那是一种静默失败：ORDER BY 那段字面量一旦改了，replace 不生效，get() 就返回「第一行」而不是「那一行」。
const ECHO_SOURCE_STATS_SQL = ECHO_SOURCE_SELECT + ' FROM echo_index_sources s ORDER BY s.source_path, s.source_version';
const ECHO_SOURCE_ONE_SQL = ECHO_SOURCE_SELECT + ' FROM echo_index_sources s WHERE s.echo_source_id = ?';

function echoSourceFromRow(row) {
  const words = Number(row.words);
  const wordsFts = Number(row.words_fts);
  const summaries = Number(row.summaries);
  const summariesFts = Number(row.summaries_fts);
  const declaredSeqRows = Number(row.declared_seq_rows);
  const seqRows = Number(row.seq_rows);
  const declared = {
    words: Number(row.declared_words),
    summaries: Number(row.declared_summaries),
    srcSeqs: Number(row.declared_src_seqs),
  };
  return {
    echoSourceId: row.sid,
    sourcePath: row.path,
    sourceVersion: row.version,
    namespace: row.ns,
    generation: Number(row.generation),
    state: row.state,
    cursorSeq: Number(row.cursor_seq),
    cursorJson: row.cursor_json,
    declared,
    sourceSha256: row.sha,
    sourceBytes: Number(row.bytes),
    builtAt: row.built_at,
    importedAt: row.imported_at,
    importer: row.importer,
    words,
    wordsFts,
    summaries,
    summariesFts,
    declaredSeqRows,
    seqRows,
    builds: Number(row.builds),
    maxBuildGeneration: row.max_build_generation === null ? null : Number(row.max_build_generation),
    // 判据来自 ./echo-integrity.mjs（与 problems 里的计数问题是**同一个**谓词）。
    // ★ 三条来源声明一起传：声明也参与对齐（C11 的行+FTS 同时丢失只有声明看得见）。
    aligned: isEchoSourceAligned({
      words, wordsFts, summaries, summariesFts, declaredSeqRows, seqRows,
      declaredWords: declared.words, declaredSummaries: declared.summaries, declaredSrcSeqs: declared.srcSeqs,
    }),
  };
}

function echoIndexInfo(db) {
  // FTS echo_source_id columns are UNINDEXED. Aggregate each table once instead
  // of doing one full virtual-table count scan for every source row.
  db.exec('SAVEPOINT echo_index_info_read');
  let sources;
  try {
    const baseRows = db.prepare([
      'SELECT s.echo_source_id AS sid, s.source_path AS path, s.source_version AS version, s.namespace AS ns,',
      '  s.generation AS generation, s.state AS state, s.cursor_seq AS cursor_seq, s.cursor_json AS cursor_json,',
      '  s.words_count AS declared_words, s.summaries_count AS declared_summaries, s.src_seq_count AS declared_src_seqs,',
      '  s.source_sha256 AS sha, s.source_bytes AS bytes, s.built_at AS built_at, s.imported_at AS imported_at, s.importer AS importer',
      'FROM echo_index_sources s ORDER BY s.source_path, s.source_version',
    ].join(' ')).all();
    const counts = {};
    for (const key of Object.keys(ECHO_COUNT_SQL)) {
      const map = new Map();
      for (const row of db.prepare(ECHO_COUNT_SQL[key]).all()) map.set(row.sid, row.n === null ? null : Number(row.n));
      counts[key] = map;
    }
    sources = baseRows.map((row) => echoSourceFromRow(Object.assign({}, row, {
      words: counts.words.get(row.sid) || 0,
      words_fts: counts.wordsFts.get(row.sid) || 0,
      summaries: counts.summaries.get(row.sid) || 0,
      summaries_fts: counts.summariesFts.get(row.sid) || 0,
      declared_seq_rows: counts.declaredSeqRows.get(row.sid) || 0,
      seq_rows: counts.seqRows.get(row.sid) || 0,
      builds: counts.builds.get(row.sid) || 0,
      max_build_generation: counts.maxBuildGeneration.has(row.sid) ? counts.maxBuildGeneration.get(row.sid) : null,
    })));
  } finally { db.exec('RELEASE echo_index_info_read'); }
  return {
    sources,
    words: sources.reduce(function (a, x) { return a + x.words; }, 0),
    summaries: sources.reduce(function (a, x) { return a + x.summaries; }, 0),
    aligned: sources.every(function (x) { return x.aligned; }),
  };
}

// 闸：缺表 = ECHO_INDEX_MISSING（不是空索引）；有表但计数不齐 = ECHO_INDEX_STALE。
// ★ 两件事必须分开：前者是「没建过」，后者是「建了但坏了」。混成一句，人会去重建而不是去查是谁写坏的。
function echoAssertIndex(db, echoSourceId) {
  const missing = echoMissingTables(db);
  if (missing.length > 0) {
    fail('ECHO_INDEX_MISSING',
      'this database has no ECHO derived index (missing: ' + missing.join(', ') + '); import one with tools/echo-index-import.mjs — the store never fabricates it',
      { missing });
  }
  const info = echoIndexInfo(db);
  if (!info.aligned) {
    fail('ECHO_INDEX_STALE',
      'ECHO derived index is out of sync (per-source rows / FTS / srcSeqs counts differ); refusing to return a partial result',
      { index: info });
  }
  return info;
}

function echoSourceRow(db, echoSourceId) {
  const row = db.prepare(ECHO_SOURCE_ONE_SQL).get(echoSourceId);
  return row ? echoSourceFromRow(row) : null;
}

function echoSourceMetadata(db, echoSourceId) {
  const row = db.prepare('SELECT echo_source_id AS sid, source_path AS path, source_version AS version, namespace AS ns, generation, state, source_sha256 AS sha, cursor_seq FROM echo_index_sources WHERE echo_source_id = ?').get(echoSourceId);
  if (!row) return null;
  return {
    echoSourceId: row.sid, sourcePath: row.path, sourceVersion: row.version,
    namespace: row.ns, generation: Number(row.generation), state: row.state,
    sourceSha256: row.sha, cursorSeq: Number(row.cursor_seq),
  };
}

// ── 指针：三种命名空间互不冒充（与 v9 parseEchoPtr 同一套判据、同一套码）────
function echoParsePtr(ptr) {
  if (typeof ptr !== 'string' || ptr.length === 0) {
    fail('ECHO_PTR_MALFORMED', 'ptr must be a non-empty string', { ptr });
  }
  if (ptr.indexOf('@') !== -1) {
    fail('ECHO_PTR_MALFORMED', 'ptr extensions such as @stream16 are not part of this contract: ' + ptr, { ptr, reason: 'no-extension-syntax' });
  }
  const prefix = ECHO_SUMMARY_PTR_PREFIX + ':';
  if (ptr.startsWith(prefix)) {
    const cmpId = ptr.slice(prefix.length);
    if (!ECHO_CMP_ID_RE.test(cmpId)) {
      fail('ECHO_PTR_MALFORMED', 'idx: ptr requires a single cmp id (got ' + JSON.stringify(cmpId) + ')', { ptr });
    }
    return { raw: ptr, kind: 'summary', cmpId };
  }
  let parsed;
  try {
    parsed = parsePtr(ptr);
  } catch (err) {
    // v9 把底层 PTR_MALFORMED 翻成 ECHO_PTR_MALFORMED —— 保持同一个对外码。
    fail('ECHO_PTR_MALFORMED', err && err.message ? err.message : String(err), { ptr, cause: (err && err.code) || null });
  }
  if (ECHO_PTR_NAMESPACES.indexOf(parsed.namespace) === -1) {
    fail('ECHO_PTR_UNKNOWN_NAMESPACE',
      'namespace ' + parsed.namespace + ' is not part of the derived index (allowed: ' + ECHO_PTR_NAMESPACES.join(' | ') + ' | ' + ECHO_SUMMARY_PTR_PREFIX + ')',
      { ptr, namespace: parsed.namespace });
  }
  return { raw: ptr, kind: 'word', namespace: parsed.namespace, sessionId: parsed.sessionId, seq: parsed.seq };
}

// ── 来源选择器（可选）────────────────────────────────────────────────────
// ★ 它解决的是「歧义之后怎么办」，不是「替他猜一个」：
//   指针命中多个来源时，调用方可以把候选里的 echoSourceId 原样传回来，打开**那一个**。
// ★ 给了 id 就不再回 AMBIGUOUS；但 id 必须是**这个指针自己的候选之一** ——
//   否则 ECHO_PTR_SOURCE_MISMATCH（绝不跨候选去找一条「大概是他要的」）。
// ★ 省略 / null / '' 一律当「没给」：单候选照常打开，多候选照旧 AMBIGUOUS。
// ★ 这不是模糊匹配：比较是字符串全等，不做前缀、不做大小写归一。
function echoSourceSelector(options) {
  const v = options && options.echoSourceId;
  if (v === undefined || v === null || v === '') return null;
  return String(v);
}

function echoPickCandidate(db, ptr, kind, rows, selector) {
  const candidateIds = rows.map((r) => r.sid);
  if (selector !== null) {
    if (candidateIds.filter((id) => id === selector).length !== 1) {
      const candidates = rows.map((r) => echoSourceRow(db, r.sid));
      fail('ECHO_PTR_SOURCE_MISMATCH',
        'echoSourceId ' + selector + ' is not one of the ' + rows.length + ' ECHO sources behind ' + ptr + ' (' + kind + '); refusing to look outside this pointer\'s candidates',
        { ptr, kind, echoSourceId: selector, candidateIds, candidates });
    }
    return echoSourceMetadata(db, selector);
  }
  if (rows.length > 1) {
    const candidates = rows.map((r) => echoSourceRow(db, r.sid));
    fail('ECHO_PTR_AMBIGUOUS',
      'ptr ' + ptr + ' matches ' + rows.length + ' ECHO sources (' + kind + '); refusing to guess — pick one of the candidate paths',
      { ptr, kind, candidates });
  }
  return echoSourceMetadata(db, candidateIds[0]);
}

function echoOpenIn(db, ptr, options) {
  const missing = echoMissingTables(db);
  if (missing.length > 0) {
    fail('ECHO_INDEX_MISSING',
      'this database has no ECHO derived index (missing: ' + missing.join(', ') + '); import one with tools/echo-index-import.mjs — the store never fabricates it',
      { missing });
  }
  const parsed = echoParsePtr(ptr);
  // ★ 只在候选选定这一步起作用：指针文本本身原样保留（不做 @stream16 之类的改写）。
  const selector = echoSourceSelector(options);

  if (parsed.kind === 'summary') {
    const rows = db.prepare('SELECT s.echo_source_id AS sid FROM echo_summaries s WHERE s.cmp_id = ? ORDER BY s.echo_source_id').all(parsed.cmpId);
    if (rows.length === 0) fail('ECHO_PTR_NOT_FOUND', 'no ECHO summary indexed for ' + ptr, { ptr, cmpId: parsed.cmpId });
    const source = echoPickCandidate(db, ptr, 'summary', rows, selector);
    const s = db.prepare('SELECT * FROM echo_summaries WHERE echo_source_id = ? AND cmp_id = ?').get(source.echoSourceId, parsed.cmpId);
    const seqs = db.prepare('SELECT seq FROM echo_summary_src_seqs WHERE echo_source_id = ? AND cmp_id = ? ORDER BY ord').all(source.echoSourceId, parsed.cmpId);
    return {
      status: 'ok',
      kind: 'summary',
      ptr,
      source,
      summary: {
        cmpId: s.cmp_id, t: s.t, session: s.session, ws: s.ws, log: s.log,
        shadowedTokens: Number(s.shadowed_tokens), shadowedChars: Number(s.shadowed_chars),
        provider: s.provider, model: s.model, status: s.status, summary: s.summary,
        fullJson: s.full_json, srcSeqCount: Number(s.src_seq_count), contentHash: s.content_hash,
      },
      // ★ 顺序 = 源顺序；重复与乱序都原样保留（Capped 标记不是权威）。
      srcSeqs: seqs.map(function (r) { return Number(r.seq); }),
      // ★ 这一格是给读的人看的：idx 打不开帧，别拿摘要当正文用。
      opensFrame: false,
    };
  }

  const candidates = db.prepare([
    'SELECT DISTINCT w.echo_source_id AS sid',
    'FROM echo_words w JOIN echo_index_sources s ON s.echo_source_id = w.echo_source_id',
    'WHERE s.namespace = ? AND w.session = ? AND w.seq = ?',
    'ORDER BY w.echo_source_id',
  ].join(' ')).all(parsed.namespace, parsed.sessionId, parsed.seq);
  if (candidates.length === 0) {
    fail('ECHO_PTR_NOT_FOUND', 'no ECHO word indexed for ' + ptr, { ptr, namespace: parsed.namespace, sessionId: parsed.sessionId, seq: parsed.seq });
  }
  // ★ namespace 已在候选 SQL 里钉死（log / v4log 互不冒充）；选择器只在这批候选里挑，不会把 v4log 的门牌打开成 log 的帧。
  const source = echoPickCandidate(db, ptr, 'word', candidates, selector);
  const w = db.prepare('SELECT * FROM echo_words WHERE echo_source_id = ? AND session = ? AND seq = ?').get(source.echoSourceId, parsed.sessionId, parsed.seq);
  return {
    status: 'ok',
    kind: 'word',
    ptr,
    namespace: parsed.namespace,
    source,
    word: {
      wordOrd: Number(w.word_ord), srcLine: Number(w.src_line), t: w.t, session: w.session, ws: w.ws,
      seq: Number(w.seq), turn: w.turn === null ? null : Number(w.turn), log: w.log, role: w.role, kind: w.kind,
      len: Number(w.len), truncated: Number(w.truncated) === 1, text: w.text, contentHash: w.content_hash,
    },
  };
}

// ── 检索：FTS 候选（超集）+ 原文子串核实（唯一语义）──────────────────────
// ★ since/until 都先归一成 UTC，再用 SQLite julianday 对输入时间戳作瞬间比较；
//   支持 Z 与显式 offset 的等价时刻，不依赖源 JSONL 的文本时区写法。

const ECHO_WORD_MATCH_SQL = [
  'select f.echo_source_id as echo_source_id, f.word_ord as word_ord, f.session as session, f.seq as seq,',
  '       w.t as t, w.kind as kind, w.role as role, w.turn as turn, w.log as log,',
  '       w.len as len, w.truncated as truncated, w.text as raw_text, s.namespace as namespace,',
  '       bm25(echo_words_fts) as score',
  'from echo_words_fts f',
  'join echo_words w on w.echo_source_id = f.echo_source_id and w.word_ord = f.word_ord',
  'join echo_index_sources s on s.echo_source_id = w.echo_source_id',
  'where echo_words_fts match ?',
  '  and (? is null or w.echo_source_id = ?)',
  '  and (? is null or julianday(w.t) >= julianday(?))',
  '  and (? is null or julianday(w.t) <= julianday(?))',
  "  and (? = 1 or w.content_class = 'dialogue')",
  'order by score, w.echo_source_id, w.word_ord',
  'limit ? offset ?',
].join(' ');

const ECHO_WORD_RAW_SQL = [
  'select w.rowid as rid, w.echo_source_id as echo_source_id, w.word_ord as word_ord, w.session as session,',
  '       w.seq as seq, w.t as t, w.kind as kind, w.role as role, w.turn as turn, w.log as log,',
  '       w.len as len, w.truncated as truncated, w.text as raw_text, s.namespace as namespace',
  'from echo_words w join echo_index_sources s on s.echo_source_id = w.echo_source_id',
  'where w.rowid > ?',
  '  and (? is null or w.echo_source_id = ?)',
  '  and (? is null or julianday(w.t) >= julianday(?))',
  '  and (? is null or julianday(w.t) <= julianday(?))',
  "  and (? = 1 or w.content_class = 'dialogue')",
  'order by w.rowid limit ?',
].join(' ');

const ECHO_SUMMARY_MATCH_SQL = [
  'select f.echo_source_id as echo_source_id, f.cmp_id as cmp_id, m.t as t, m.session as session,',
  '       m.shadowed_tokens as shadowed_tokens, m.shadowed_chars as shadowed_chars, m.status as status,',
  '       m.summary as raw_text, s.namespace as namespace,',
  '       bm25(echo_summaries_fts) as score',
  'from echo_summaries_fts f',
  'join echo_summaries m on m.echo_source_id = f.echo_source_id and m.cmp_id = f.cmp_id',
  'join echo_index_sources s on s.echo_source_id = m.echo_source_id',
  'where echo_summaries_fts match ?',
  '  and (? is null or m.echo_source_id = ?)',
  '  and (? is null or julianday(m.t) >= julianday(?))',
  '  and (? is null or julianday(m.t) <= julianday(?))',
  'order by score, m.echo_source_id, m.cmp_id',
  'limit ? offset ?',
].join(' ');

const ECHO_SUMMARY_RAW_SQL = [
  'select m.rowid as rid, m.echo_source_id as echo_source_id, m.cmp_id as cmp_id, m.t as t, m.session as session,',
  '       m.shadowed_tokens as shadowed_tokens, m.shadowed_chars as shadowed_chars, m.status as status,',
  '       m.summary as raw_text, s.namespace as namespace',
  'from echo_summaries m join echo_index_sources s on s.echo_source_id = m.echo_source_id',
  'where m.rowid > ?',
  '  and (? is null or m.echo_source_id = ?)',
  '  and (? is null or julianday(m.t) >= julianday(?))',
  '  and (? is null or julianday(m.t) <= julianday(?))',
  'order by m.rowid limit ?',
].join(' ');

function echoClampLimit(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 50;
  const n = Math.floor(value);
  if (n < 1) return 1;
  return n > ECHO_LIMIT_MAX ? ECHO_LIMIT_MAX : n;
}

function echoTimeBound(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value);
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) {
    fail(CODES.INVALID_INPUT, field + ' is not a parseable ISO-8601 time: ' + JSON.stringify(value), { field, value });
  }
  return new Date(ms).toISOString();
}

function echoSurfaceReceipt(name) {
  return { surface: name, skipped: false, candidates: 0, scanned: 0, batches: 0, exhausted: false, results: [] };
}

function echoScanWordsIn(db, plan, filters, limit, out) {
  if (plan.matchMode === 'bigram') {
    const stmt = db.prepare(ECHO_WORD_MATCH_SQL);
    let offset = 0;
    for (;;) {
      const rows = stmt.all(plan.expression, filters.echoSourceId, filters.echoSourceId, filters.since, filters.since,
        filters.until, filters.until, filters.includeNonDialogue ? 1 : 0, ECHO_SEARCH_BATCH, offset);
      out.batches += 1;
      if (rows.length === 0) { out.exhausted = true; return out; }
      out.candidates += rows.length;
      out.scanned += rows.length;
      offset += rows.length;
      for (const row of rows) {
        if (!containsNeedle(row.raw_text, plan.needle)) continue;
        out.results.push({
          surface: 'words',
          ptr: makePtr(row.namespace, row.session, Number(row.seq)),
          echoSourceId: row.echo_source_id,
          namespace: row.namespace,
          session: row.session,
          seq: Number(row.seq),
          wordOrd: Number(row.word_ord),
          t: row.t,
          kind: row.kind,
          role: row.role,
          turn: row.turn === null || row.turn === undefined ? null : Number(row.turn),
          log: row.log === undefined ? null : row.log,
          len: Number(row.len),
          truncated: Number(row.truncated) === 1,
          snippet: String(row.raw_text).slice(0, 200),
          rawText: row.raw_text,
          score: row.score === undefined ? null : row.score,
          matchMode: plan.matchMode,
        });
        if (out.results.length >= limit) return out;
      }
      if (rows.length < ECHO_SEARCH_BATCH) { out.exhausted = true; return out; }
    }
  }
  const stmt = db.prepare(ECHO_WORD_RAW_SQL);
  let cursor = -1;
  for (;;) {
    const rows = stmt.all(cursor, filters.echoSourceId, filters.echoSourceId, filters.since, filters.since,
      filters.until, filters.until, filters.includeNonDialogue ? 1 : 0, ECHO_SEARCH_BATCH);
    out.batches += 1;
    if (rows.length === 0) { out.exhausted = true; return out; }
    out.candidates += rows.length;
    out.scanned += rows.length;
    for (const row of rows) {
      cursor = row.rid;
      if (!containsNeedle(row.raw_text, plan.needle)) continue;
      out.results.push({
        surface: 'words',
        ptr: makePtr(row.namespace, row.session, Number(row.seq)),
        echoSourceId: row.echo_source_id,
        namespace: row.namespace,
        session: row.session,
        seq: Number(row.seq),
        wordOrd: Number(row.word_ord),
        t: row.t,
        kind: row.kind,
        role: row.role,
        turn: row.turn === null || row.turn === undefined ? null : Number(row.turn),
        log: row.log === undefined ? null : row.log,
        len: Number(row.len),
        truncated: Number(row.truncated) === 1,
        snippet: String(row.raw_text).slice(0, 200),
        rawText: row.raw_text,
        score: null,
        matchMode: plan.matchMode,
      });
      if (out.results.length >= limit) return out;
    }
    if (rows.length < ECHO_SEARCH_BATCH) { out.exhausted = true; return out; }
  }
}

function echoScanSummariesIn(db, plan, filters, limit, out) {
  const push = function (row, score) {
    out.results.push({
      surface: 'summaries',
      ptr: ECHO_SUMMARY_PTR_PREFIX + ':' + row.cmp_id,
      echoSourceId: row.echo_source_id,
      namespace: row.namespace,
      cmpId: row.cmp_id,
      session: row.session,
      t: row.t,
      status: row.status,
      shadowedTokens: Number(row.shadowed_tokens),
      shadowedChars: Number(row.shadowed_chars),
      snippet: String(row.raw_text).slice(0, 200),
      rawText: row.raw_text,
      score: score === undefined ? null : score,
      matchMode: plan.matchMode,
    });
  };
  if (plan.matchMode === 'bigram') {
    const stmt = db.prepare(ECHO_SUMMARY_MATCH_SQL);
    let offset = 0;
    for (;;) {
      const rows = stmt.all(plan.expression, filters.echoSourceId, filters.echoSourceId, filters.since, filters.since,
        filters.until, filters.until, ECHO_SEARCH_BATCH, offset);
      out.batches += 1;
      if (rows.length === 0) { out.exhausted = true; return out; }
      out.candidates += rows.length;
      out.scanned += rows.length;
      offset += rows.length;
      for (const row of rows) {
        if (!containsNeedle(row.raw_text, plan.needle)) continue;
        push(row, row.score);
        if (out.results.length >= limit) return out;
      }
      if (rows.length < ECHO_SEARCH_BATCH) { out.exhausted = true; return out; }
    }
  }
  const stmt = db.prepare(ECHO_SUMMARY_RAW_SQL);
  let cursor = -1;
  for (;;) {
    const rows = stmt.all(cursor, filters.echoSourceId, filters.echoSourceId, filters.since, filters.since,
      filters.until, filters.until, ECHO_SEARCH_BATCH);
    out.batches += 1;
    if (rows.length === 0) { out.exhausted = true; return out; }
    out.candidates += rows.length;
    out.scanned += rows.length;
    for (const row of rows) {
      cursor = row.rid;
      if (!containsNeedle(row.raw_text, plan.needle)) continue;
      push(row, null);
      if (out.results.length >= limit) return out;
    }
    if (rows.length < ECHO_SEARCH_BATCH) { out.exhausted = true; return out; }
  }
}

function echoSearchIn(db, query, options, validatedIndex) {
  const o = options || {};
  const surface = o.surface === undefined || o.surface === null ? 'all' : String(o.surface);
  if (['all', 'words', 'summaries'].indexOf(surface) === -1) {
    fail(CODES.INVALID_INPUT, "surface must be 'all' | 'words' | 'summaries'", { surface });
  }
  const limit = echoClampLimit(o.limit);
  const includeNonDialogue = o.includeNonDialogue === undefined ? false : o.includeNonDialogue;
  if (typeof includeNonDialogue !== 'boolean') fail(CODES.INVALID_INPUT, 'includeNonDialogue must be a boolean', { includeNonDialogue });
  const since = echoTimeBound(o.since, 'since');
  const until = echoTimeBound(o.until, 'until');
  if (since !== null && until !== null && since > until) {
    fail(CODES.INVALID_INPUT, 'since is later than until (the range would be empty)', { since, until });
  }
  const echoSourceId = o.echoSourceId === undefined || o.echoSourceId === null || o.echoSourceId === ''
    ? null : String(o.echoSourceId);
  // 先校验查询串（非法输入优先报 INVALID_INPUT），再验索引，最后才扫描 —— 与 searchFrames 同序。
  const plan = buildQueryPlan(query);
  const index = validatedIndex || echoAssertIndex(db, echoSourceId);
  if (echoSourceId !== null && !index.sources.some(function (s) { return s.echoSourceId === echoSourceId; })) {
    fail('ECHO_SOURCE_NOT_FOUND', 'no ECHO source indexed with id ' + echoSourceId, {
      echoSourceId, sources: index.sources.map(function (s) { return s.echoSourceId; }),
    });
  }

  const out = {
    query: plan.query,
    needle: plan.needle,
    matchMode: plan.matchMode,
    tokens: plan.tokens.map(function (x) { return x.t; }),
    tokenKinds: plan.tokens.map(function (x) { return x.kind; }),
    scanPath: plan.matchMode === 'bigram' ? 'bigram-fts' : 'raw-scan',
    index,
    filters: {
      surface, limitPerSurface: limit, since, until, echoSourceId, includeNonDialogue,
      timeComparedAs: 'julianday-instant',
      note: 'limit 是**每个面**的上限；exhausted 是每个面各自算的，顶层是「所有跑过的面都扫到底」。',
    },
    surfaces: {},
    candidates: 0,
    scanned: 0,
    batches: 0,
    exhausted: false,
    verifiedBy: 'echo_words.text|echo_summaries.summary:substring',
    results: [],
  };

  const wantWords = surface !== 'summaries';
  const wantSummaries = surface !== 'words';
  const filters = { echoSourceId, since, until, includeNonDialogue };

  if (plan.matchMode === 'empty') {
    // 空查询：两个面都「扫了、没有」。exhausted=true 是诚实的（确实没有更多候选）。
    for (const name of ['words', 'summaries']) {
      const r = echoSurfaceReceipt(name);
      r.skipped = (name === 'words' && !wantWords) || (name === 'summaries' && !wantSummaries);
      r.exhausted = true;
      out.surfaces[name] = r;
    }
    out.exhausted = true;
    return out;
  }

  if (wantWords) {
    const r = echoSurfaceReceipt('words');
    echoScanWordsIn(db, plan, filters, limit, r);
    out.surfaces.words = r;
  } else {
    const r = echoSurfaceReceipt('words');
    r.skipped = true; r.exhausted = true;
    out.surfaces.words = r;
  }
  if (wantSummaries) {
    const r = echoSurfaceReceipt('summaries');
    echoScanSummariesIn(db, plan, filters, limit, r);
    out.surfaces.summaries = r;
  } else {
    const r = echoSurfaceReceipt('summaries');
    r.skipped = true; r.exhausted = true;
    out.surfaces.summaries = r;
  }

  for (const name of ['words', 'summaries']) {
    const r = out.surfaces[name];
    out.candidates += r.candidates;
    out.scanned += r.scanned;
    out.batches += r.batches;
    out.results = out.results.concat(r.results);
  }
  out.exhausted = ['words', 'summaries'].every(function (n) { return out.surfaces[n].exhausted; });
  return out;
}

// ── 状态：缺表不抛（这是「看状态」的入口），真故障写成 problems ────────────
// ★ 判据（对齐 / 审计列 / 游标 / 代次 / 孤儿 FTS）**全部**来自 ./echo-integrity.mjs。
//   本函数只剩两件事：判缺表、把「富来源行」和 integrity 的结果组装成回执。
//   ★ 为什么不自己再算一遍 problems：算两遍就是两份字段名，迟早一份叫 maxBuild、
//     一份叫 maxBuildGeneration（这就是 Task-14 要收拾的那个坑）。
// ★ 两个词分开（与 integrity 模块同一口径）：
//     aligned    = 计数对齐 → 决定 searchable / 检索闸
//     ok         = aligned 且 problems 为空 → 诊断结论
//   游标坏掉属于「元数据脏了」，**不**闸检索；FTS 缺行属于「会静默少命中」，闸。
function echoStatsIn(db) {
  const integrity = analyzeEchoIntegrity(db);
  if (!integrity.available) {
    return {
      available: false,
      code: 'ECHO_INDEX_MISSING',
      missing: integrity.missing,
      why: '这个库还没有 v9 的 ECHO 派生索引表（不是「索引是空的」，是「没建过」）。',
      howToFix: 'node tools/echo-index-import.mjs --manifest <f.json> --sha256 <64hex> --generation 1 --db <meta.sqlite>',
    };
  }
  // 富来源行（含 sha / 时间戳 / declared 三列）只能在 Store 这边拼 —— integrity 只认判据用得上的字段。
  const info = echoIndexInfo(db);
  const contentClasses = Object.fromEntries(db.prepare('SELECT content_class, COUNT(*) AS n FROM echo_words GROUP BY content_class').all().map(row => [row.content_class, Number(row.n)]));
  const wordContentClasses = { dialogue: contentClasses.dialogue || 0, injection: contentClasses.injection || 0, other: contentClasses.other || 0 };
  return {
    available: true,
    sources: info.sources,
    words: info.words,
    summaries: info.summaries,
    wordContentClasses,
    aligned: integrity.aligned,
    orphanFts: integrity.orphanFts,
    problems: integrity.problems,
    ok: integrity.ok,
    searchable: integrity.aligned,
    note: integrity.aligned
      ? '检索可用：每来源的 words/summaries 与两张 FTS、有序 srcSeqs 逐行对齐。'
      : '检索被闸住（ECHO_INDEX_STALE）：计数不对齐时返回结果会在无信号的情况下少命中，所以宁可拒绝。',
  };
}

function tooNewMessage(current) {
  return 'database schema v' + current + ' is newer than code v' + SCHEMA_VERSION + '; refusing to read or write (no silent downgrade)';
}

export function openMetaStore(options) {
  const o = options || {};
  const filePath = o.path;
  if (typeof filePath !== 'string' || filePath.length === 0) {
    fail(CODES.INVALID_INPUT, 'openMetaStore requires { path }', { path: filePath });
  }
  const mode = o.mode === undefined ? 'readwrite' : o.mode;
  if (mode !== 'readwrite' && mode !== 'readonly') {
    fail(CODES.INVALID_INPUT, "mode must be 'readwrite' or 'readonly'", { mode });
  }
  const readOnly = mode === 'readonly';
  const timeoutMs = typeof o.timeoutMs === 'number' ? o.timeoutMs : 5000;
  const isMemory = filePath === ':memory:';
  const migrations = o.migrations || MIGRATIONS;

  const db = openDatabase(filePath, { readOnly });
  const pragmas = configureConnection(db, { readOnly, timeoutMs, memory: isMemory });
  const engine = engineInfo();

  let state = readSchemaState(db);

  if (!readOnly && o.migrateOnOpen === true && !state.ready && !state.tooNew) {
    try {
      runMigrations(db, { migrations, targetVersion: SCHEMA_VERSION });
    } catch (err) {
      throw translateSqliteError(err);
    }
    state = readSchemaState(db);
  }

  let closed = false;
  let echoProofCache = null;

  // ── v8：导入行是溯源，不是「现在」 ──────────────────────────────────────
  // 当前主导只认**本机写入**的 lead（import_batch_id IS NULL）。历史导入的 lead 行
  // 永远不参与判定 —— 否则一次导入就把「谁是主导」交给了某份旧账本。
  // ★ 这一列在 v7 结构里不存在：那时台账里所有 lead 都是本机写的，退回全表口径
  //   （这正是「旧结构兼容」的显式位置；迁移到 v8 会补上列，之后每一行都按列判）。
  //   缓存只在 migrate()/refreshState() 之后失效，别让结构变化被旧缓存盖住。
  let ledgerColumns = null;
  function ledgerHasImportBatch() {
    if (ledgerColumns === null) {
      let has = false;
      try {
        has = db.prepare('PRAGMA table_info(mo_ledger)').all().some(function (c) { return c.name === 'import_batch_id'; });
      } catch (_) { has = false; }
      ledgerColumns = { importBatch: has };
    }
    return ledgerColumns.importBatch;
  }
  function liveLeadClause() {
    return ledgerHasImportBatch() ? 'import_batch_id IS NULL' : '1 = 1';
  }

  // info() 是排障入口，不该因为「还没迁移」而整体炸掉：算不出来就给 null（明确表示「不知道」）。
  function safeIndexInfo() {
    try {
      if (!state.ready) return null;
      return searchIndexInfoFor(db);
    } catch (_) {
      return null;
    }
  }

  const store = {
    path: filePath,
    mode,
    readOnly,
    db,
    pragmas,
    engine,
    migrations,
    get state() { return state; },
    get closed() { return closed; },

    refreshState() {
      state = readSchemaState(db);
      ledgerColumns = null;
      echoProofCache = null;
      return state;
    },

    assertOpen() {
      if (closed) fail(CODES.STORE_CLOSED, 'store is closed', { path: filePath });
    },

    ensureReady() {
      store.assertOpen();
      if (state.ready) return;
      if (state.tooNew) {
        fail(CODES.SCHEMA_TOO_NEW, tooNewMessage(state.current), { current: state.current, expected: SCHEMA_VERSION, mode, tooNew: true });
      }
      if (state.historyBroken) {
        // O1：迁移史缺行时，库不是「ready」；读和写都必须报同一个明确错误。
        fail(CODES.MIGRATION_HISTORY_BROKEN, 'schema_migrations history is broken (applied: [' + state.applied.map(function (r) { return r.version; }).join(', ') + '], expected contiguous 1..' + SCHEMA_VERSION + '); refusing to read or write', {
          current: state.current,
          expected: SCHEMA_VERSION,
          applied: state.applied.map(function (r) { return r.version; }),
          missing: state.history ? state.history.missing : null,
          mode,
        });
      }
      fail(
        CODES.MIGRATION_REQUIRED,
        readOnly
          ? 'readonly store is not migrated (schema v' + state.current + ', expected v' + SCHEMA_VERSION + '); readonly connections never migrate'
          : 'store is not migrated (schema v' + state.current + ', expected v' + SCHEMA_VERSION + '); call store.migrate() explicitly',
        { current: state.current, expected: SCHEMA_VERSION, mode, tooNew: false },
      );
    },

    migrate(migrateOptions) {
      store.assertOpen();
      if (readOnly) fail(CODES.READONLY, 'readonly store cannot migrate', { path: filePath });
      let result;
      try {
        result = runMigrations(db, Object.assign({ migrations, targetVersion: SCHEMA_VERSION }, migrateOptions || {}));
      } catch (err) {
        throw translateSqliteError(err);
      }
      state = readSchemaState(db);
      ledgerColumns = null;
      return result;
    },

    appendLedger(entry, trusted) {
      store.assertOpen();
      if (readOnly) fail(CODES.READONLY, 'readonly store cannot append ledger', { path: filePath });
      store.ensureReady();
      const e = entry && typeof entry === 'object' ? entry : {};
      const type = String(e.type == null ? '' : e.type);
      const sessionId = trusted && typeof trusted.sessionId === 'string' ? trusted.sessionId.trim() : '';
      if (!sessionId) fail(CODES.LEDGER_IDENTITY_REQUIRED, 'trusted writer sessionId is required');
      const uuidPattern = /^(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidPattern.test(sessionId)) fail(CODES.INVALID_INPUT, 'trusted writer sessionId must be a canonical UUID');
      const actorSession = (sessionId.startsWith('session-') ? sessionId.slice(8) : sessionId).toLowerCase();
      const by = actorSession.slice(0, 8);
      // ★ import_batch_id 是**导入器**在它自己的批次事务里写的溯源列，不是调用方能填的字段。
      //   让它可从外面传 = 一行普通写入就能冒充「历史行」，反而是给闸门开后门。
      //   所以这里显式拒收（不只是「INSERT 里没列它」这种靠实现的保证）。
      if (Object.prototype.hasOwnProperty.call(e, 'import_batch_id') || Object.prototype.hasOwnProperty.call(e, 'importBatchId')) {
        fail(CODES.INVALID_INPUT, 'import_batch_id is import provenance, not a caller field: only tools/mo-ledger-import.mjs sets it, inside its own batch transaction');
      }
      // ═══════════════════════════════════════════════════════════════════
      // ★★ 2026-11-21（爀曦定）：**「必须是当前 lead」这条代码闸门去掉了。**
      //
      //   原来这里要求「写入者 == 当前 live lead」。它制造了一个**死锁**：
      //     换届恰恰是**新容器**写的，而新容器**必然不是**当前 lead
      //     → 被 LEDGER_LEAD_AUTH_REQUIRED 拒 → **交接永远做不成**。
      //   2026-11-21 他发现这件事，原话：
      //     「写 lead 的闸门应该交给我，而不是依靠代码硬拦，哪个会话都可以写 lead 交接，
      //       但是应该由我决定，因为你暂时没有办法自己转移到下一个会话容器，这件事交给我就行」
      //
      //   ★ 判据：**代码能拦的是"格式不合格"，拦不住"谁有权授权"** ——
      //     后者只有他能判。硬拦的结果不是安全，是**把唯一能授权的路一起堵死**。
      //
      //   ★ 保留的三条闸门（它们是**自证**，不是**授权**，所以仍归代码管）：
      //     · `ref` 必填 —— 由 schema 触发器 mo_ledger_lead_requires_ref 拦；
      //     · 世代自述「第 N 代」—— 由 mo_ledger_lead_generation 拦；
      //     · 必须带完整 sessionId —— 上面 bySession 那段拦。
      //   ★ 交接要**人拍板**这件事，落在 AGENTS.md 的规则里，不落在代码里。
      // ═══════════════════════════════════════════════════════════════════
      // （不再校验「写入者是不是当前 live lead」。）
      const body = String(e.text == null ? '' : e.text).trim();
      if (!body) fail(CODES.INVALID_INPUT, 'ledger text is required');
      const byUser = Boolean(e.byUser === true || e.by !== undefined);
      const t = String(e.t || new Date().toISOString());
      try {
        const result = db.prepare('INSERT INTO mo_ledger (t,type,text,by,actor_session,ref,feel,by_user) VALUES (?,?,?,?,?,?,?,?)').run(
          t, type, body, by, actorSession, e.ref == null ? null : String(e.ref), e.feel == null ? null : String(e.feel), byUser ? 1 : 0,
        );
        return { rowId: Number(result.lastInsertRowid), t, type, text: body, by, actorSession, ref: e.ref == null ? null : String(e.ref), feel: e.feel == null ? null : String(e.feel), byUser };
      } catch (err) { throw translateSqliteError(err); }
    },

    /**
     * 全量账本行（按 row_id 升序）。给 LedgerBase.all() 用。
     *
     * ★ 为什么不复用 listLedger：它把 limit 钳在 500（那是对的 —— 面向界面的一页），
     *   而「墨有 787 行」这种读法需要全量。2026-11-17 实测：默认调只回 50 行，
     *   于是 stats() 数成 50、currentLead() 把当前主导判成了第 10 代。
     *   **读不全不能装作读全了** —— 所以这里显式分批，直到拿干净。
     */
    listLedgerAll(options) {
      store.assertOpen(); store.ensureReady();
      const o = options || {};
      const chunk = Math.max(1, Math.min(5000, Number(o.chunk) || 2000));
      const provenance = ledgerHasImportBatch() ? ',import_batch_id' : '';
      const where = []; const params = [];
      if (o.type) { where.push('type = ?'); params.push(String(o.type)); }
      if (o.since) { where.push('t >= ?'); params.push(String(o.since)); }
      const base = 'SELECT row_id,t,type,text,by,actor_session,ref,feel,by_user,legacy_line' + provenance + ' FROM mo_ledger';
      // ★ 只用游标 + LIMIT，不要 OFFSET：每批都从上一批最后的 row_id 往后取，
      //   少一个绑定参数就少一处错位（2026-11-17：多写一个 OFFSET 直接报 datatype mismatch）。
      const tail = ' ORDER BY row_id ASC LIMIT ?';
      const cond = (where.length ? ' WHERE ' + where.join(' AND ') : '') + (where.length ? ' AND row_id > ?' : ' WHERE row_id > ?');
      const out = [];
      let cursor = 0;
      for (;;) {
        const rows = db.prepare(base + cond + tail).all(...params, cursor, chunk);
        if (!rows.length) break;
        for (const r of rows) {
          out.push({
            rowId: Number(r.row_id), t: r.t, type: r.type, text: r.text, by: r.by, actorSession: r.actor_session,
            ref: r.ref, feel: r.feel, byUser: Boolean(r.by_user),
            legacyLine: r.legacy_line == null ? null : Number(r.legacy_line),
            importBatchId: r.import_batch_id == null ? null : Number(r.import_batch_id),
          });
        }
        cursor = Number(rows[rows.length - 1].row_id);
        if (rows.length < chunk) break;
      }
      return out;
    },

    listLedger(options) {
      store.assertOpen(); store.ensureReady();
      const o = options || {};
      const limit = Math.max(1, Math.min(500, Number.isFinite(Number(o.limit)) ? Math.trunc(Number(o.limit)) : 50));
      const where = []; const params = [];
      if (o.type) { where.push('type = ?'); params.push(String(o.type)); }
      if (o.since) { where.push('t >= ?'); params.push(String(o.since)); }
      const provenance = ledgerHasImportBatch() ? ',import_batch_id' : '';
      const rows = db.prepare('SELECT row_id,t,type,text,by,actor_session,ref,feel,by_user,legacy_line' + provenance + ' FROM mo_ledger' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY row_id DESC LIMIT ?').all(...params, limit);
      return rows.map((r) => ({
        rowId: Number(r.row_id), t: r.t, type: r.type, text: r.text, by: r.by, actorSession: r.actor_session,
        ref: r.ref, feel: r.feel, byUser: Boolean(r.by_user),
        legacyLine: r.legacy_line == null ? null : Number(r.legacy_line),
        // 溯源：null = 本机写入（可以参与「现在」），非 null = 导入行（只是历史）。
        importBatchId: r.import_batch_id == null ? null : Number(r.import_batch_id),
      }));
    },

    ledgerTypes() { store.assertOpen(); store.ensureReady(); return ['lead','promise','fact','shelved','gain','loss','persona','container']; },

    ledgerStats() {
      store.assertOpen(); store.ensureReady();
      const rows = db.prepare('SELECT type,COUNT(*) AS n FROM mo_ledger GROUP BY type ORDER BY type').all();
      const total = db.prepare('SELECT COUNT(*) AS n FROM mo_ledger').get().n;
      // ★ 只认本机写入的 lead：导入进来的历史 lead 不是当前权威。
      const latest = db.prepare("SELECT by FROM mo_ledger WHERE type='lead' AND " + liveLeadClause() + ' ORDER BY row_id DESC LIMIT 1').get();
      return { total: Number(total), byType: Object.fromEntries(rows.map((r) => [r.type, Number(r.n)])), latestLead: latest ? latest.by : null };
    },

    latestLead() {
      store.assertOpen(); store.ensureReady();
      // ★ 同一个口径：历史导入的 lead 行永远不返回（否则一次导入就换了主导）。
      const row = db.prepare("SELECT row_id,t,text,by,ref FROM mo_ledger WHERE type='lead' AND " + liveLeadClause() + ' ORDER BY row_id DESC LIMIT 1').get();
      return row ? { rowId: Number(row.row_id), t: row.t, text: row.text, by: row.by, ref: row.ref } : null;
    },

    ingest(record) {
      store.assertOpen();
      if (readOnly) fail(CODES.READONLY, 'readonly store cannot ingest', { path: filePath });
      store.ensureReady();
      try {
        return ingestRecord(db, record, { now: new Date().toISOString() });
      } catch (err) {
        throw translateSqliteError(err);
      }
    },

    // Internal-purpose write path for the isolated shadow importer: SID grammar
    // admits host-escaped '~', while sourceId and ordinary frame ingest stay strict.
    ingestEchoShadow(record) {
      store.assertOpen();
      if (readOnly) fail(CODES.READONLY, 'readonly store cannot ingest ECHO shadow frames', { path: filePath });
      store.ensureReady();
      try {
        return ingestRecord(db, record, { now: new Date().toISOString(), allowEchoSessionId: true });
      } catch (err) {
        throw translateSqliteError(err);
      }
    },

    resolvePtr(ptr) {
      store.assertOpen();
      store.ensureReady();
      const parsed = parsePtr(ptr);
      const source = db.prepare('select * from sources where namespace = ?').get(parsed.namespace);
      if (!source) {
        fail(CODES.PTR_UNKNOWN_NAMESPACE, 'no source owns namespace ' + parsed.namespace, { ptr, namespace: parsed.namespace });
      }
      const row = db.prepare(
        'select * from frame_index where source_id = ? and session_id = ? and seq = ?',
      ).get(source.source_id, parsed.sessionId, parsed.seq);
      if (!row) {
        fail(CODES.PTR_NOT_FOUND, 'no frame indexed for ' + ptr, { ptr, sourceId: source.source_id });
      }
      // ★ 定位认「现在」：当前 sources.raw_path + 相对路径 + frame_ordinal。
      //   raw_path（帧级）只作为原始证据回传，改名/搬目录后不会再把门牌钉在旧路径上。
      const resolved = resolveFramePath(source.raw_path, row.raw_rel_path, row.raw_path);
      return Object.assign({}, mapFrame(row), {
        namespace: parsed.namespace,
        sourceKind: source.kind,
        sourceRawPath: source.raw_path,
        rawPath: resolved.rawPath,
        rawPathAtIngest: row.raw_path,
        rawPathDrift: resolved.rawPathDrift,
        relocatable: resolved.relocatable,
        relocation: resolved.relocation,
      });
    },

    getCursor(sourceId, streamKey) {
      store.assertOpen();
      store.ensureReady();
      const row = db.prepare('select * from sync_cursors where source_id = ? and stream_key = ?').get(sourceId, streamKey);
      return row ? mapCursor(row) : null;
    },

    // ── P1b：检索 ────────────────────────────────────────────────────────
    // 语义：最终判定永远是「raw_text 的整串子串」，FTS 只是候选预筛。
    // 返回里带 candidates（预筛命中数）与 results（核实后的），两者之差就是被假阳性拦掉的量。
    search(query, options) {
      store.assertOpen();
      store.ensureReady();
      try {
        return searchFrames(db, query, options);
      } catch (err) {
        throw translateSqliteError(err);
      }
    },

    explainSearch(query) {
      store.assertOpen();
      return buildQueryPlan(query);
    },

    // FTS 行数与帧行数：两表必须逐行对齐，否则「写得进去 / 查不出来」。
    // ★ P1c：这个探针的实现搬进了 search.mjs（searchIndexInfoFor），因为 search 的闸也用它 ——
    //   「什么算对齐」只能有一条定义，两处各写一套迟早对不上。
    // ★ 它同时是查询前置：search() 在对齐失败时报 SEARCH_INDEX_STALE，不返回不完整结果。
    searchIndexInfo() {
      store.assertOpen();
      store.ensureReady();
      return searchIndexInfoFor(db);
    },

    // 修复面：把 FTS 表按 frame_index 重建一遍（重复执行不叠行）。
    rebuildSearchIndex() {
      store.assertOpen();
      if (readOnly) fail(CODES.READONLY, 'readonly store cannot rebuild the search index', { path: filePath });
      store.ensureReady();
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = rebuildFrameFts(db);
        db.exec('COMMIT');
        return result;
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch (_) { /* 可能已回滚 */ }
        throw translateSqliteError(err);
      }
    },

    // ── P1b：来源搬迁（独立动作，不依赖新帧） ─────────────────────────────
    relocateSource(sourceId, newRoot, expectedOldRoot) {
      store.assertOpen();
      if (readOnly) fail(CODES.READONLY, 'readonly store cannot relocate a source', { path: filePath });
      store.ensureReady();
      try {
        return doRelocateSource(db, { sourceId, newRoot, expectedOldRoot });
      } catch (err) {
        throw translateSqliteError(err);
      }
    },

    listSourceRelocations(sourceId, options) {
      store.assertOpen();
      store.ensureReady();
      return doListRelocations(db, sourceId, options);
    },

    // ── P1b：P6 验收抽样（只读） ─────────────────────────────────────────
    verifyPtrSample(sample) {
      store.assertOpen();
      store.ensureReady();
      return verifySample(store, sample);
    },

    // ── v9：ECHO 派生索引（只读，2026-11-14）────────────────────────────
    //
    // 语义面与 tools/echo-index-import.mjs 的 searchEchoWords / searchEchoSummaries /
    // resolveEchoPtr 逐字对应（那边是导入器 + 原型，这边是常驻 Store 门面）。
    // 为什么允许「两处实现」：src/ 不能依赖 tools/（原型是 CLI，随发布包走的是 src/）。
    // **防漂的闸在自检里** —— tools/echo-mcp-selftest.mjs 在同一份合成语料上逐条比对
    // 两边（结果集合、顺序、错误码），任何一处改了语义都会在那里红。
    //
    // ★ 本段只读：全部是 SELECT / count(*)；mode:'readonly' 的 Store 照常可用。
    // ★ 本段只碰 echo_* 七张表 + sqlite_master，**绝不读 frame_index**：
    //   idx:<cmp-id> 只开摘要与有序 srcSeqs，不可能打开一条帧。
    // ★ v9 的三条硬口径（不许在这里改）：
    //   ① 最终判定永远是 containsNeedle（原文整串子串，大小写不敏感）；FTS 只是超集预筛。
    //   ② 候选永不截断：扫到「取够 limit」或「候选耗尽」；exhausted=false 只表示**没有证明完整**。
    //   ③ 同一 sid+seq 命中多个来源 = AMBIGUOUS，回显式候选路径，绝不挑一个。
    //
    // ★ 本切片唯一新增的字段面：**时间过滤**（since / until）。原型只按来源过滤；
    //   时间过滤的比较口径写死在返回里（filters.timeComparedAs），不做「看起来差不多」的模糊匹配。

    echoSearch(query, options) {
      store.assertOpen();
      store.ensureReady();
      if (!readOnly) return echoSearchIn(db, query, options);
      // One readonly Store may serve many MCP calls. Cache only the exact global
      // alignment proof, keyed to SQLite data_version, and pin validation + search
      // inside the same read snapshot. Any external commit invalidates the proof.
      db.exec('SAVEPOINT echo_search_read');
      try {
        // Pin the SQLite read snapshot with an actual table read before sampling
        // data_version; SAVEPOINT/PRAGMA alone do not establish the read view.
        db.prepare('SELECT echo_source_id FROM echo_index_sources ORDER BY echo_source_id LIMIT 1').get();
        const version = Number(db.prepare('PRAGMA data_version').get().data_version);
        let index = echoProofCache && echoProofCache.version === version ? echoProofCache.index : null;
        if (!index) {
          index = echoAssertIndex(db, null);
          echoProofCache = { version, index };
        }
        return echoSearchIn(db, query, options, index);
      } finally {
        try { db.exec('ROLLBACK TO echo_search_read'); } catch {}
        try { db.exec('RELEASE echo_search_read'); } catch {}
      }
    },

    // 打开一个 ECHO 指针。返回 { status:'ok', kind:'word'|'summary', ... }。
    // 失败一律是**带稳定 code 的 MetaStoreError**（码与 v9 原型同名）：
    //   ECHO_PTR_MALFORMED / ECHO_PTR_UNKNOWN_NAMESPACE / ECHO_PTR_NOT_FOUND / ECHO_PTR_AMBIGUOUS
    //   ECHO_PTR_SOURCE_MISMATCH / ECHO_INDEX_MISSING / ECHO_INDEX_STALE
    // ★ AMBIGUOUS 的 details.candidates 是**显式来源路径**，不是「第一个」。
    // ★ options.echoSourceId（可选）**只**在指针命中多个来源时用来指定打开哪一个：
    //   必须是该指针的候选之一，否则 SOURCE_MISMATCH（含 candidateIds），绝不跨候选找。
    //   省略它时行为与从前逐字相同（多候选 → AMBIGUOUS）。
    echoOpen(ptr, options) {
      store.assertOpen();
      store.ensureReady();
      return echoOpenIn(db, ptr, options);
    },

    // 索引状态：来源 / 计数 / 对齐 / 构建审计。**缺表不抛** —— 它是「看状态」的入口，
    // 「索引没建」必须能读成 available:false，而不是一个 MIGRATION_REQUIRED 的堆栈。
    echoStats() {
      store.assertOpen();
      store.ensureReady();
      return echoStatsIn(db);
    },

    // Bounded, read-only authority rows for status surfaces. No source paths, text, or integrity scan.
    echoSourceStatus() {
      store.assertOpen();
      store.ensureReady();
      const required = ['echo_index_sources', 'echo_words', 'echo_words_fts', 'echo_summaries', 'echo_summaries_fts', 'echo_summary_src_seqs', 'echo_source_builds'];
      const present = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map((row) => row.name));
      if (!required.every((name) => present.has(name))) return { available: null, aligned: null, rows: null };
      // Keep the multi-query status snapshot consistent if an importer commits concurrently.
      db.exec('SAVEPOINT echo_source_status_read');
      let rows;
      try {
        const baseRows = db.prepare([
          'SELECT s.echo_source_id AS source_id, s.namespace AS namespace, s.source_version AS source_version,',
          's.generation AS generation, s.state AS state, s.cursor_seq AS cursor_seq,',
          's.words_count AS declared_words, s.summaries_count AS declared_summaries, s.src_seq_count AS declared_src_seqs,',
          '(SELECT COUNT(*) FROM echo_words w WHERE w.echo_source_id=s.echo_source_id) AS words,',
          '(SELECT COUNT(*) FROM echo_summaries m WHERE m.echo_source_id=s.echo_source_id) AS summaries,',
          '(SELECT COALESCE(SUM(m.src_seq_count),0) FROM echo_summaries m WHERE m.echo_source_id=s.echo_source_id) AS declared_seq_rows,',
          '(SELECT COUNT(*) FROM echo_summary_src_seqs q WHERE q.echo_source_id=s.echo_source_id) AS seq_rows,',
          's.built_at AS built_at, s.imported_at AS imported_at',
          'FROM echo_index_sources s ORDER BY s.echo_source_id LIMIT 65'
        ].join(' ')).all();
        const countBySource = (table) => new Map(db.prepare('SELECT echo_source_id AS sid, COUNT(*) AS n FROM ' + table + ' GROUP BY echo_source_id').all().map(r => [r.sid, Number(r.n)]));
        const wordsFts = countBySource('echo_words_fts');
        const summariesFts = countBySource('echo_summaries_fts');
        rows = baseRows.map(row => Object.assign({}, row, {
          words_fts: wordsFts.get(row.source_id) || 0,
          summaries_fts: summariesFts.get(row.source_id) || 0,
        }));
      } finally { db.exec('RELEASE echo_source_status_read'); }
      const truncated = rows.length > 64;
      const sources = rows.slice(0, 64).map((row) => {
        const counts = { words: Number(row.words), wordsFts: Number(row.words_fts), summaries: Number(row.summaries), summariesFts: Number(row.summaries_fts), srcSeqs: Number(row.seq_rows), declaredSrcSeqs: Number(row.declared_src_seqs) };
        const aligned = isEchoSourceAligned({ words: counts.words, wordsFts: counts.wordsFts, summaries: counts.summaries, summariesFts: counts.summariesFts, declaredSeqRows: Number(row.declared_seq_rows), seqRows: counts.srcSeqs, declaredWords: Number(row.declared_words), declaredSummaries: Number(row.declared_summaries), declaredSrcSeqs: counts.declaredSrcSeqs });
        return { sourceId: row.source_id, namespace: row.namespace, sourceVersion: row.source_version, generation: Number(row.generation), state: row.state, cursorSeq: Number(row.cursor_seq), counts, builtAt: row.built_at, importedAt: row.imported_at, aligned };
      });
      return { available: true, aligned: truncated ? null : sources.every((row) => row.aligned), truncated, rows: sources };
    },

    // Derived BGE vectors are persisted beside ECHO word identities; search returns pointers only.
    echoVectorRegister(modelSpec) {
      store.assertOpen();
      if (readOnly) fail(CODES.READONLY, 'readonly store cannot register ECHO vector models', { path: filePath });
      store.ensureReady();
      try { return registerEchoVectorModel(db, modelSpec); }
      catch (err) { throw translateSqliteError(err); }
    },

    echoVectorPut(echoSourceId, modelSpec, rows, options) {
      store.assertOpen();
      if (readOnly) fail(CODES.READONLY, 'readonly store cannot write ECHO vectors', { path: filePath });
      store.ensureReady();
      try { return putEchoSourceVectors(db, echoSourceId, modelSpec, rows, options); }
      catch (err) { throw translateSqliteError(err); }
    },

    echoVectorDelete(echoSourceId, modelKey) {
      store.assertOpen();
      if (readOnly) fail(CODES.READONLY, 'readonly store cannot delete ECHO vectors', { path: filePath });
      store.ensureReady();
      try { return deleteEchoSourceVectors(db, echoSourceId, modelKey); }
      catch (err) { throw translateSqliteError(err); }
    },

    echoVectorSearch(queryVector, options) {
      store.assertOpen();
      store.ensureReady();
      return searchEchoSourceVectors(db, queryVector, options);
    },

    // ── P1c：产物元数据（v5） ─────────────────────────────────────────────
    // 读 = get/list/verify/events；写 = register/update。
    // verify 是纯只读（不写库、不碰文件）：它报磁盘的真话，状态要不要跟着走由调用方决定。

    registerArtifact(record, artifactOptions) {
      store.assertOpen();
      if (readOnly) fail(CODES.READONLY, 'readonly store cannot register artifacts', { path: filePath });
      store.ensureReady();
      try {
        return doRegisterArtifact(db, record, artifactOptions || {});
      } catch (err) {
        throw translateSqliteError(err);
      }
    },

    updateArtifact(ref, patch, artifactOptions) {
      store.assertOpen();
      if (readOnly) fail(CODES.READONLY, 'readonly store cannot update artifacts', { path: filePath });
      store.ensureReady();
      try {
        return doUpdateArtifact(db, ref, patch, artifactOptions || {});
      } catch (err) {
        throw translateSqliteError(err);
      }
    },

    getArtifact(ref) {
      store.assertOpen();
      store.ensureReady();
      return doGetArtifact(db, ref);
    },

    listArtifacts(filter) {
      store.assertOpen();
      store.ensureReady();
      try {
        return doListArtifacts(db, filter);
      } catch (err) {
        throw translateSqliteError(err);
      }
    },

    verifyArtifact(ref) {
      store.assertOpen();
      store.ensureReady();
      return doVerifyArtifact(db, ref);
    },

    listArtifactEvents(ref, eventOptions) {
      store.assertOpen();
      store.ensureReady();
      return doListArtifactEvents(db, ref, eventOptions || {});
    },

    countArtifacts() {
      store.assertOpen();
      store.ensureReady();
      return doCountArtifacts(db);
    },

    listFrames(filter) {
      store.assertOpen();
      store.ensureReady();
      const f = filter || {};
      const limit = typeof f.limit === 'number' ? Math.max(1, Math.min(1000, Math.floor(f.limit))) : 50;
      const rows = db.prepare([
        'select * from frame_index',
        'where (? is null or source_id = ?) and (? is null or session_id = ?)',
        'order by seq asc limit ?',
      ].join(' ')).all(
        f.sourceId === undefined ? null : f.sourceId, f.sourceId === undefined ? null : f.sourceId,
        f.sessionId === undefined ? null : f.sessionId, f.sessionId === undefined ? null : f.sessionId,
        limit,
      );
      return rows.map(mapFrame);
    },

    countFrames(filter) {
      store.assertOpen();
      store.ensureReady();
      const f = filter || {};
      const row = db.prepare([
        'select count(*) as n from frame_index',
        'where (? is null or source_id = ?) and (? is null or session_id = ?)',
      ].join(' ')).get(
        f.sourceId === undefined ? null : f.sourceId, f.sourceId === undefined ? null : f.sourceId,
        f.sessionId === undefined ? null : f.sessionId, f.sessionId === undefined ? null : f.sessionId,
      );
      return row.n;
    },

    getSession(sourceId, sessionId) {
      store.assertOpen();
      store.ensureReady();
      const row = db.prepare('select * from sessions where source_id = ? and session_id = ?').get(sourceId, sessionId);
      if (!row) return null;
      return {
        sourceId: row.source_id,
        sessionId: row.session_id,
        containerId: row.container_id,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
      };
    },

    info() {
      store.assertOpen();
      return {
        path: filePath,
        mode,
        pragmas,
        engine,
        schema: { current: state.current, expected: SCHEMA_VERSION, ready: state.ready, tooNew: state.tooNew, historyBroken: state.historyBroken, applied: state.applied },
        search: { table: 'frame_fts', modes: SEARCH_MODES, indexedFrom: 'frame_index.snippet', aligned: safeIndexInfo() },
        artifacts: { table: 'artifacts', events: 'artifact_events', statuses: ARTIFACT_STATUSES, actions: ARTIFACT_ACTIONS },
        assertEngine: assertEngine(),
      };
    },

    close() {
      if (closed) return false;
      echoProofCache = null;
      closed = true;
      db.close();
      return true;
    },
  };

  return store;
}

export { parsePtr, makePtr, hashFrame, DSH_NAMESPACE, V4_NAMESPACE, SCHEMA_VERSION, searchFrames };
