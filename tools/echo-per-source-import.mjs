#!/usr/bin/env node
// SUPERSEDED 2026-11-16: superseded by tools/echo-index-source-snapshot-import.mjs (and its selftest); kept only as history — do NOT extend.
// 每个来源一条 ECHO 派生索引的导入入口（合成 / TEMP 专用原型）。
//
// 四条硬约束，每条都对应一个拒绝码，不做「尽力而为」：
//   ① 来源身份 = f(显式原始日志规范路径, namespace)。快照摘要 / 行号 / rowId 都不进身份；
//      原始日志路径缺席就停（SOURCE_LOG_PATH_MISSING），绝不拿目录名、摘要或行号去猜一个。
//   ② 清单由 builder 一次写成，本模块**从不改写**它：身份与版本在构建时显式传入，
//      读回来只核对「字节哈希是否仍是 builder 声明的那个」。改写会让 builder 自己的
//      sourceIdentity 断言变成一句话，也会让「签了名的字节」和「实际落库的字节」分家。
//   ③ 落进 journal / receipt / 库里的 log 一律是**不透明身份**（<root>/<namespace>/<sha256(规范路径)>）；
//      原始路径与正文都不落盘。journal 只记码和计数，不记消息（消息里带路径）。
//   ④ 每个来源都走到**终态**：ok / refused / failed 三桶如实计数，CLI 用它决定退出码；
//      守恒用 importer 回执与库内实测计数比对，不用「加起来等于总数」的算式自证。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildFromEchoIndexFiles, ECHO_INDEX_VERSION } from './echo-source-build.mjs';
import { isCanonicalSourcePath, isReasoningRow, runImport } from './echo-index-import.mjs';
import { echoSourceIdFor } from '../src/db/schema.mjs';
import { openMetaStore } from '../src/db/index.mjs';
import { analyzeEchoIntegrity } from '../src/db/echo-integrity.mjs';

export const NAMESPACE_BY_SOURCE = Object.freeze({ v3: 'log', v4: 'v4log' });
// 源身份版本必须与 importer 落进 source_version 的那个一致（= manifest.echoIndexVersion）。
// 直接引用 builder 的常量，不另抄一份字面量 —— 抄一份就等着漂。
export const SOURCE_VERSION = ECHO_INDEX_VERSION;
export const SOURCE_PATH_ROOT = 'D:/synthetic/echo-source';
// 「导入成功」= 库里这份来源当前且完整。其余终态分两桶：refused 是可预期的不可导入，failed 是错。
export const OK_STATUSES = Object.freeze(['IMPORTED', 'ALREADY_CURRENT']);
export const REFUSED_STATUSES = Object.freeze(['CANONICAL_EMPTY_SOURCE', 'SUMMARY_ONLY_SOURCE']);
export const EXIT = Object.freeze({ ok: 0, failed: 1, usage: 2, refused: 3, integrity: 4 });

const COUNT_TABLES = Object.freeze({
  sources: 'echo_index_sources',
  words: 'echo_words',
  summaries: 'echo_summaries',
  srcSeqs: 'echo_summary_src_seqs',
  builds: 'echo_source_builds',
  frames: 'frame_index',
});

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const charLen = (text) => Array.from(String(text)).length;
const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
const sumOf = (list, pick) => list.reduce((total, item) => total + pick(item), 0);

function insideTemp(target) {
  const tempRoot = path.resolve(fs.realpathSync(os.tmpdir())).toLowerCase();
  const resolved = path.resolve(target).toLowerCase();
  return resolved === tempRoot || resolved.startsWith(tempRoot + path.sep);
}

export function namespaceFor(row) {
  if (!row || typeof row !== 'object') fail('SOURCE_ROW_INVALID', 'source row must be an object');
  if (!Object.prototype.hasOwnProperty.call(NAMESPACE_BY_SOURCE, row.kind)) {
    fail('SOURCE_NAMESPACE_UNMAPPED', 'source kind ' + JSON.stringify(row.kind) + ' has no explicit namespace mapping (known: ' + Object.keys(NAMESPACE_BY_SOURCE).join(', ') + ')');
  }
  return NAMESPACE_BY_SOURCE[row.kind];
}

// 来源身份的唯一输入 = **原始来源日志的规范路径**。快照摘要、行号、rowId 都不进身份：
// 同一份日志后来的快照、重排的行、换掉的摘要，都必须落到同一个 id 上。
// 归一化判据与 builder / importer 对 sourcePath 的判据同一套（绝对、posix 分隔符、无尾斜杠、无 . / .. 段），
// win32 上再折叠大小写 —— 免得大小写不同的同一份日志铸出两个身份。
// ★ 这条路径只作为**数据**参与哈希：本模块从不打开、不读取、不落盘它，也绝不写进 journal。
export function canonicalSourceLogPath(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail('SOURCE_LOG_PATH_MISSING', 'source row must carry the original source log path (sourceLogPath) for identity; nothing else can stand in for it');
  }
  const posix = value.split('\\').join('/');
  if (!isCanonicalSourcePath(posix)) {
    fail('SOURCE_LOG_PATH_INVALID', 'sourceLogPath must be a full canonical path (absolute, posix separators, no trailing slash, no ./.. segments): ' + JSON.stringify(value));
  }
  return process.platform === 'win32' ? posix.toLowerCase() : posix;
}

// 稳定的不透明身份：<root>/<namespace>/<sha256(规范原始日志路径)>。
// namespace 单独占一段（v3 -> log、v4 -> v4log），同一份日志的两个变体天然分开；
// 路径的哈希里既没有快照摘要也没有行位置，因此跨快照、跨行序都不变。
export function sourceIdentityFor(row) {
  const namespace = namespaceFor(row);
  const hash = sha256(Buffer.from(canonicalSourceLogPath(row.sourceLogPath), 'utf8'));
  return { namespace, hash, sourcePath: SOURCE_PATH_ROOT + '/' + namespace + '/' + hash };
}

export function classifySource(row) {
  const namespace = namespaceFor(row);
  const words = row.words === undefined ? [] : row.words;
  const summaries = row.summaries === undefined ? [] : row.summaries;
  if (!Array.isArray(words) || !Array.isArray(summaries)) fail('SOURCE_PAYLOAD_INVALID', 'words and summaries must be arrays when provided');
  const declaredWords = Number(row.wordsCount), declaredSummaries = Number(row.summariesCount);
  if (!Number.isSafeInteger(declaredWords) || declaredWords < 0) fail('SOURCE_COUNTS_INVALID', 'wordsCount must be a non-negative safe integer');
  if (!Number.isSafeInteger(declaredSummaries) || declaredSummaries < 0) fail('SOURCE_COUNTS_INVALID', 'summariesCount must be a non-negative safe integer');
  // 声明的条数必须与真正带的行数一致：否则清单的 counts 与落库行数各说一套，守恒就没法量。
  if (declaredWords !== words.length) fail('SOURCE_COUNTS_MISMATCH', 'wordsCount says ' + declaredWords + ' but the row carries ' + words.length + ' word row(s)');
  if (declaredSummaries !== summaries.length) fail('SOURCE_COUNTS_MISMATCH', 'summariesCount says ' + declaredSummaries + ' but the row carries ' + summaries.length + ' summary row(s)');
  if (words.length === 0 && summaries.length === 0) return { status: 'CANONICAL_EMPTY_SOURCE', code: 'CANONICAL_EMPTY_SOURCE', namespace, words: 0, summaries: 0 };
  if (words.length === 0) return { status: 'SUMMARY_ONLY_SOURCE', code: 'SUMMARY_ONLY_SOURCE', namespace, words: 0, summaries: summaries.length };
  return { status: 'READY', namespace, words: words.length, summaries: summaries.length };
}

function generationFor(row) {
  const value = row && row.generation !== undefined ? row.generation : 1;
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation < 1) fail('GENERATION_INVALID', 'generation must be a positive safe integer (got ' + JSON.stringify(value) + ')');
  return generation;
}

// 确定性构建时刻：同输入必须得到同一份清单字节，否则每次重跑都铸出新 sha，ALREADY_CURRENT 永远拿不到。
// 不拿墙上时钟充当「什么时候建的」—— 那会把「重跑同一份快照」变成「另一份来源」。
function builtAtFor(row) {
  if (typeof row.builtAt === 'string' && Number.isFinite(Date.parse(row.builtAt))) return new Date(Date.parse(row.builtAt)).toISOString();
  const stamps = [];
  for (const word of row.words || []) if (word && typeof word.t === 'string' && Number.isFinite(Date.parse(word.t))) stamps.push(Date.parse(word.t));
  for (const entry of row.summaries || []) if (entry && typeof entry.t === 'string' && Number.isFinite(Date.parse(entry.t))) stamps.push(Date.parse(entry.t));
  if (stamps.length === 0) fail('BUILT_AT_UNDETERMINED', 'no builtAt and no parseable row timestamp: a wall-clock stamp would mint a new manifest sha on every rerun');
  return new Date(Math.max.apply(null, stamps)).toISOString();
}

// ── feed 行：log 字段在这里被重写 ──────────────────────────────────────────
// 入参 row.log 是**原始日志路径**（或任何别的东西），写进 words/summaries 之前一律换成不透明身份。
// 这是 row.log 的消毒点：库里 echo_words.log / echo_summaries.log 只可能是不透明身份或 null。
function wordFeedRow(word, sourcePath, rowSession, where) {
  if (!word || typeof word !== 'object' || Array.isArray(word)) fail('WORD_ROW_INVALID', where + ': word row must be an object');
  const role = typeof word.role === 'string' ? word.role : '';
  const kind = typeof word.kind === 'string' ? word.kind : '';
  const text = typeof word.text === 'string' ? word.text : fail('WORD_ROW_INVALID', where + ': text must be a string');
  // 推理行在这里**显式拒绝**，不交给 builder 静默剔除：剔除会让 manifest.counts.excludedReasoning
  // 与 words.jsonl 对不上，最后以 MANIFEST_COUNTS_MISMATCH 的名义含糊失败。这里点名说清。
  if (isReasoningRow(role, kind) || isReasoningRow(kind, role)) {
    fail('REASONING_ROWS_REFUSED', where + ': role/kind ' + JSON.stringify([role, kind]) + ' is a reasoning row; reasoning is not part of the derived index and is refused explicitly, never silently dropped');
  }
  if (word.truncated === true || word.truncated === 1) fail('TRUNCATED_ROWS_REFUSED', where + ': truncated rows are refused explicitly (the builder would drop them and the manifest counts would stop matching the feed)');
  if (role !== 'user' && role !== 'assistant') fail('ROLE_NOT_INDEXABLE', where + ': role must be user|assistant (got ' + JSON.stringify(role) + '); other roles are neither indexable nor silently droppable');
  if (text.trim() === '') fail('WORD_TEXT_BLANK', where + ': eligible row carries blank text; an empty word is not citable');
  if (typeof word.session !== 'string' || word.session !== rowSession) fail('WORD_SESSION_MISMATCH', where + ': session must equal the source row session (one files.jsonl record names one session)');
  const seq = Number(word.seq);
  if (!Number.isSafeInteger(seq) || seq < 0) fail('WORD_SEQ_INVALID', where + ': seq must be a non-negative safe integer');
  const ws = word.ws === undefined ? null : word.ws;
  if (ws !== null && typeof ws !== 'string') fail('WORD_WS_INVALID', where + ': ws must be a string or null');
  return {
    t: word.t,
    session: word.session,
    ws,
    seq,
    turn: word.turn === undefined ? null : word.turn,
    log: sourcePath,
    role,
    kind,
    len: charLen(text),
    truncated: false,
    text,
  };
}

function summaryFeedRow(entry, sourcePath, rowSession, where) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('SUMMARY_ROW_INVALID', where + ': summary row must be an object');
  if (typeof entry.session !== 'string' || entry.session !== rowSession) fail('SUMMARY_SESSION_MISMATCH', where + ': session must equal the source row session');
  if (typeof entry.id !== 'string' || entry.id === '') fail('SUMMARY_ROW_INVALID', where + ': id must be a non-empty string');
  if (typeof entry.summary !== 'string' || entry.summary === '') fail('SUMMARY_ROW_INVALID', where + ': summary must be a non-empty string');
  const ws = entry.ws === undefined ? null : entry.ws;
  if (ws !== null && typeof ws !== 'string') fail('SUMMARY_WS_INVALID', where + ': ws must be a string or null');
  return {
    id: entry.id,
    t: entry.t,
    session: entry.session,
    ws,
    log: sourcePath,
    srcSeqs: entry.srcSeqs,
    shadowedTokens: entry.shadowedTokens,
    chars: entry.chars,
    provider: entry.provider === undefined ? null : entry.provider,
    model: entry.model === undefined ? null : entry.model,
    status: entry.status,
    summary: entry.summary,
    manifest: entry.manifest === undefined ? {} : entry.manifest,
  };
}

// 整批预检：任何一条不合格都在**建清单之前**停下，绝不让半批身份先落进库。
export function preflightSourceRows(rows) {
  if (!Array.isArray(rows)) fail('INPUT_INVALID', 'rows must be an array');
  const seenIdentity = new Map();
  const seenWords = new Map();
  const seenSummaries = new Map();
  const accounting = [];
  rows.forEach((row, ordinal) => {
    const identity = sourceIdentityFor(row);
    // 同一批里两条行落到同一个身份 = 一条会静默盖掉另一条；身份不含行位置，所以这条必须显式拦。
    if (seenIdentity.has(identity.sourcePath)) {
      fail('SOURCE_IDENTITY_DUPLICATE', 'row ' + ordinal + ' and row ' + seenIdentity.get(identity.sourcePath) + ' resolve to the same source identity ' + identity.sourcePath + ' (same namespace + canonical source log path); one would silently overwrite the other');
    }
    seenIdentity.set(identity.sourcePath, ordinal);
    const classified = classifySource(row);
    accounting.push({
      ordinal,
      rowId: typeof row.rowId === 'string' ? row.rowId : null,
      sourcePath: identity.sourcePath,
      opaqueId: identity.hash,
      namespace: identity.namespace,
      status: classified.status,
      words: classified.words,
      summaries: classified.summaries,
    });
    if (classified.status !== 'READY') return;
    const wsSeen = new Set();
    (row.words || []).forEach((word, index) => {
      const where = 'rows[' + ordinal + '].words[' + index + ']';
      const normalized = wordFeedRow(word, identity.sourcePath, row.session, where);
      wsSeen.add(normalized.ws);
      if (wsSeen.size > 1) fail('WORD_WS_MISMATCH', where + ': words of one source must agree on ws (files.jsonl names one ws per source)');
      const key = classified.namespace + '\u0000' + normalized.session + '\u0000' + normalized.seq;
      const payload = JSON.stringify(normalized);
      if (seenWords.has(key) && seenWords.get(key).payload !== payload) {
        fail('WORD_SEQ_CONFLICT', 'rows[' + ordinal + '] and ' + seenWords.get(key).where + ' share namespace/session/seq with different payloads');
      }
      seenWords.set(key, { payload, where });
    });
    (row.summaries || []).forEach((entry, index) => {
      const where = 'rows[' + ordinal + '].summaries[' + index + ']';
      const normalized = summaryFeedRow(entry, identity.sourcePath, row.session, where);
      const key = classified.namespace + '\u0000' + normalized.id;
      const payload = JSON.stringify(normalized);
      if (seenSummaries.has(key) && seenSummaries.get(key).payload !== payload) {
        fail('SUMMARY_ID_CONFLICT', 'rows[' + ordinal + '] and ' + seenSummaries.get(key).where + ' share namespace/cmpId with different payloads');
      }
      seenSummaries.set(key, { payload, where });
    });
  });
  return accounting;
}

// ── 库内实测计数（守恒的唯一依据）─────────────────────────────────────────
function measureDb(dbPath) {
  const store = openMetaStore({ path: dbPath, mode: 'readwrite' });
  try {
    store.ensureReady();
    const out = {};
    for (const [label, table] of Object.entries(COUNT_TABLES)) out[label] = Number(store.db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n);
    return out;
  } finally { store.close(); }
}

function sourceCounts(store, echoSourceId) {
  const one = (sql) => Number(store.db.prepare(sql).get(echoSourceId).n);
  return {
    words: one('SELECT COUNT(*) AS n FROM echo_words WHERE echo_source_id = ?'),
    summaries: one('SELECT COUNT(*) AS n FROM echo_summaries WHERE echo_source_id = ?'),
    srcSeqs: one('SELECT COUNT(*) AS n FROM echo_summary_src_seqs WHERE echo_source_id = ?'),
    builds: one('SELECT COUNT(*) AS n FROM echo_source_builds WHERE echo_source_id = ?'),
  };
}

function measureSourceCounts(dbPath, echoSourceId) {
  const store = openMetaStore({ path: dbPath, mode: 'readwrite' });
  try {
    store.ensureReady();
    return sourceCounts(store, echoSourceId);
  } finally { store.close(); }
}

function committedFeedCursor(dbPath, echoSourceId) {
  const store = openMetaStore({ path: dbPath, mode: 'readwrite' });
  try {
    store.ensureReady();
    const row = store.db.prepare('SELECT cursor_json FROM echo_index_sources WHERE echo_source_id = ?').get(echoSourceId);
    if (!row) return null;
    let cursor = null;
    try { cursor = JSON.parse(row.cursor_json); } catch (error) { return null; }
    if (!cursor || typeof cursor !== 'object' || !cursor.feed) return null;
    return cursor.feed;
  } finally { store.close(); }
}

// ── 守恒：回执 vs 库内实测 ────────────────────────────────────────────────
// 逐来源：importer 回执说的 counts 必须等于库里数得出来的行数（ALREADY_CURRENT 亦然）。
// 非 ok 终态：库里这份来源必须一行都没有（失败不留残渣，refused 也不许留半截）。
// 全局：after - before 的**实测增量**必须等于「真写了库的那些回执」之和 —— 增量来自库，不来自加法。
export function verifyConservation({ dbPath, outcomes, before }) {
  if (!dbPath || !Array.isArray(outcomes) || !before) fail('INPUT_INVALID', 'dbPath, outcomes and before counts are required');
  const after = measureDb(dbPath);
  const problems = [];
  const perSource = [];
  const store = openMetaStore({ path: dbPath, mode: 'readwrite' });
  try {
    store.ensureReady();
    for (const outcome of outcomes) {
      const measured = sourceCounts(store, outcome.sourceId);
      const beforeSource = outcome.before || { words: 0, summaries: 0, srcSeqs: 0, builds: 0 };
      perSource.push({ ordinal: outcome.ordinal, status: outcome.status, sourceId: outcome.sourceId, declared: outcome.counts, before: beforeSource, measured });
      if (outcome.ok) {
        // ok：回执说的条数必须等于库里数得出来的条数（ALREADY_CURRENT 亦然 —— 它说的是「现在就是这样」）。
        if (!outcome.counts) { problems.push({ kind: 'receipt-counts-missing', ordinal: outcome.ordinal }); continue; }
        for (const field of ['words', 'summaries', 'srcSeqs']) {
          if (measured[field] !== outcome.counts[field]) problems.push({ kind: 'receipt-db-mismatch', ordinal: outcome.ordinal, status: outcome.status, field, receipt: outcome.counts[field], db: measured[field] });
        }
      } else {
        // 非 ok：这份来源在库里必须**跟导入前一模一样**（失败连半截都不许留，替换型失败也不许把旧的删掉）。
        for (const field of ['words', 'summaries', 'srcSeqs', 'builds']) {
          if (measured[field] !== beforeSource[field]) problems.push({ kind: 'failed-source-changed-db', ordinal: outcome.ordinal, status: outcome.status, field, before: beforeSource[field], db: measured[field] });
        }
      }
    }
  } finally { store.close(); }
  // 全局对账：after 必须等于「before + 本次触到的每个来源自己的实测变化之和」。
  // ★ 为什么不是「回执相加」：generation > 1 是**整源替换**，回执的 counts 是替换后的总数、不是增量；
  //   拿回执相加去等于 delta 会在第二代误报。这里每一格都来自库内实测（含每个来源导入前的底数）。
  const expected = {
    sources: Number(before.sources),
    words: Number(before.words),
    summaries: Number(before.summaries),
    srcSeqs: Number(before.srcSeqs),
    builds: Number(before.builds),
  };
  for (const entry of perSource) {
    for (const field of ['words', 'summaries', 'srcSeqs', 'builds']) expected[field] += Number(entry.measured[field]) - Number(entry.before[field]);
    if (entry.status && OK_STATUSES.indexOf(entry.status) !== -1) expected.sources += entry.before.words === 0 && entry.before.summaries === 0 && entry.before.builds === 0 && entry.measured.builds > 0 ? 1 : 0;
  }
  const delta = {};
  for (const field of Object.keys(expected)) delta[field] = Number(after[field]) - Number(before[field]);
  for (const field of Object.keys(expected)) {
    if (Number(after[field]) !== expected[field]) problems.push({ kind: 'conservation-mismatch', field, expected: expected[field], measured: Number(after[field]) });
  }
  // 派生索引绝不碰帧表：全局最后一次核对（importer 在事务内也核，这里防的是事务外的手脚）。
  if (Number(after.frames) !== Number(before.frames)) problems.push({ kind: 'frame-table-touched', before: Number(before.frames), after: Number(after.frames) });
  return { ok: problems.length === 0, problems, perSource, before, after, delta };
}

export function auditTempDb(dbPath) {
  if (!dbPath || !insideTemp(dbPath)) fail('TEMP_ONLY', 'database must be under os.tmpdir');
  const store = openMetaStore({ path: dbPath, mode: 'readonly' });
  try {
    store.ensureReady();
    const audit = analyzeEchoIntegrity(store.db);
    // ★ generation / namespace 不在 analyzeEchoIntegrity 的返回里（它只给计数与对齐），
    //   所以这两格**从库里量**，不从返回值里猜 —— 猜出来的 undefined 会被当成「没有这一代」。
    const rows = store.db.prepare('SELECT echo_source_id, namespace, generation FROM echo_index_sources').all();
    const byId = new Map(rows.map((row) => [row.echo_source_id, row]));
    return {
      available: audit.available !== false,
      ok: audit.ok === true,
      aligned: audit.aligned === true,
      problems: audit.problems || [],
      sources: (audit.index && audit.index.sources ? audit.index.sources : []).map((source) => {
        const stored = byId.get(source.echoSourceId) || {};
        return {
          echoSourceId: source.echoSourceId,
          sourcePath: source.sourcePath,
          sourceVersion: source.sourceVersion,
          namespace: stored.namespace === undefined ? null : stored.namespace,
          generation: stored.generation === undefined ? null : Number(stored.generation),
          words: source.words,
          summaries: source.summaries,
          aligned: source.aligned,
        };
      }),
    };
  } finally { store.close(); }
}

// ── 单来源构建：清单由 builder 一次写成，本模块不改写 ────────────────────
function buildSourceFeed(row, options) {
  const root = options.root;
  const dbPath = options.dbPath;
  const identity = options.identity;
  const generation = options.generation;
  const sourcePath = identity.sourcePath;
  const wordRows = (row.words || []).map((word, index) => wordFeedRow(word, sourcePath, row.session, 'words[' + index + ']'));
  const summaryRows = (row.summaries || []).map((entry, index) => summaryFeedRow(entry, sourcePath, row.session, 'summaries[' + index + ']'));
  const wordsBytes = Buffer.from(wordRows.map((item) => JSON.stringify(item)).join('\n') + '\n', 'utf8');
  const summariesBytes = Buffer.from(summaryRows.length === 0 ? '\n' : summaryRows.map((item) => JSON.stringify(item)).join('\n') + '\n', 'utf8');
  // cursor 的 key 是本次消费内容的哈希：同一份内容得到同一个 key，内容变了 key 就变（rotation 判据靠它）。
  // 它不是来源身份的一部分 —— 身份只由规范路径 + namespace 决定。
  const feedKey = sha256(Buffer.concat([wordsBytes, summariesBytes]));
  const consumedBytes = row.consumedBytes === undefined ? 0 : Number(row.consumedBytes);
  if (!Number.isSafeInteger(consumedBytes) || consumedBytes < 0) fail('CONSUMED_BYTES_INVALID', 'consumedBytes must be a non-negative safe integer when provided');
  const ws = wordRows.length > 0 ? wordRows[0].ws : (row.ws === undefined ? null : row.ws);
  const filesBytes = Buffer.from(JSON.stringify({
    file: sourcePath,
    key: feedKey,
    nextByte: consumedBytes,
    ws,
    sid: row.session,
    nSum: summaryRows.length,
    nWord: wordRows.length,
    sumOut: 'summaries',
    wordOut: 'words',
  }) + '\n', 'utf8');
  const sourceDir = path.join(root, 'source-' + identity.hash);
  fs.mkdirSync(sourceDir, { recursive: true });
  const filesPath = path.join(sourceDir, 'files.jsonl');
  const wordsPath = path.join(sourceDir, 'words.jsonl');
  const summariesPath = path.join(sourceDir, 'summaries.jsonl');
  fs.writeFileSync(filesPath, filesBytes);
  fs.writeFileSync(wordsPath, wordsBytes);
  fs.writeFileSync(summariesPath, summariesBytes);
  // 每次构建一个**空目录**（builder 要求 outDir 为空）；名字里不带身份 —— 路径不参与身份，也不落进清单。
  const outDir = fs.mkdtempSync(path.join(root, 'built-'));
  const sourceId = echoSourceIdFor(sourcePath, SOURCE_VERSION);
  const buildOptions = {
    filesPath,
    wordsPath,
    summariesPath,
    sourcePath,
    namespace: identity.namespace,
    generation,
    // 源身份版本在**构建时**显式传入：builder 默认把 manifest.version 写成 feed 格式版本
    // （echo-index-feed/1），而过期草稿是建完再改写它 —— 那正是「清单被事后改写」。
    sourceVersion: SOURCE_VERSION,
    builtAt: builtAtFor(row),
    outDir,
  };
  if (generation > 1) {
    // 代次从**库里的已提交游标**接续，不从调用方的记账里接续：库里没有前一代就没有下一代。
    const prior = committedFeedCursor(dbPath, sourceId);
    if (!prior) fail('GENERATION_REQUIRES_PRIOR', 'generation ' + generation + ' requires a committed prior generation for this source identity; the database has none');
    if (Number(prior.generation) + 1 !== generation) fail('GENERATION_GAP', 'generation ' + generation + ' must be exactly the committed generation ' + prior.generation + ' + 1 (one step at a time)');
    buildOptions.cursor = prior;
  }
  const built = buildFromEchoIndexFiles(buildOptions);
  // 不写、不改、不重算清单：只核对「读回来的字节是否仍是 builder 声明的那一份」。
  const manifestBytes = fs.readFileSync(built.manifestPath);
  const manifestSha = sha256(manifestBytes);
  if (manifestSha !== built.manifestSha256) fail('MANIFEST_CHANGED_AFTER_BUILD', 'manifest bytes no longer hash to what the builder declared (' + built.manifestSha256 + '); refusing to import a manifest that was touched after signing');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.sourcePath !== sourcePath) fail('MANIFEST_SOURCE_PATH_MISMATCH', 'builder wrote sourcePath ' + JSON.stringify(manifest.sourcePath) + ' but the explicit identity is ' + JSON.stringify(sourcePath));
  if (manifest.namespace !== identity.namespace) fail('MANIFEST_NAMESPACE_MISMATCH', 'builder wrote namespace ' + JSON.stringify(manifest.namespace) + ' but the identity says ' + JSON.stringify(identity.namespace));
  if (manifest.generation !== generation) fail('MANIFEST_GENERATION_MISMATCH', 'builder wrote generation ' + JSON.stringify(manifest.generation) + ' but ' + generation + ' was requested');
  if (manifest.echoIndexVersion !== SOURCE_VERSION) fail('MANIFEST_VERSION_DRIFT', 'manifest.echoIndexVersion ' + JSON.stringify(manifest.echoIndexVersion) + ' is not the source version the importer records (' + JSON.stringify(SOURCE_VERSION) + ')');
  return { manifestPath: built.manifestPath, manifestSha, sourceId, counts: built.counts };
}

// ── 批量导入：每个来源一个终态，失败不掩盖、继续往下走 ────────────────────
function appendJournal(journal, entry) {
  // before 是「导入前这份来源有几行」的实测底数，只在内存里参与守恒，不落盘。
  const { before, ...row } = entry;
  void before;
  fs.appendFileSync(journal, JSON.stringify(row) + '\n', 'utf8');
}

function safeReceiptCounts(receipt) {
  const counts = receipt && receipt.counts ? receipt.counts : null;
  if (!counts) return null;
  return { words: Number(counts.words), summaries: Number(counts.summaries), srcSeqs: Number(counts.srcSeqs) };
}

export function importPerSource(options) {
  const root = options && options.root;
  const dbPath = options && options.dbPath;
  const rows = options && options.rows;
  if (!root || !dbPath || !Array.isArray(rows)) fail('INPUT_INVALID', 'root, dbPath and rows are required');
  if (!insideTemp(root) || !insideTemp(dbPath)) fail('TEMP_ONLY', 'every input, output and database path must live under os.tmpdir');
  if (!fs.existsSync(dbPath)) fail('DB_NOT_FOUND', 'destination database does not exist (this tool never creates or migrates one)');
  fs.mkdirSync(root, { recursive: true });
  if (!insideTemp(fs.realpathSync(root))) fail('TEMP_ONLY', 'resolved work directory must be under os.tmpdir');
  const accounting = preflightSourceRows(rows);
  const before = measureDb(dbPath);
  const journal = path.join(root, 'source-import-journal.jsonl');
  const outcomes = [];
  rows.forEach((row, ordinal) => {
    const identity = sourceIdentityFor(row);
    const classified = classifySource(row);
    const generation = generationFor(row);
    const sourceId = echoSourceIdFor(identity.sourcePath, SOURCE_VERSION);
    const entry = {
      kind: 'source',
      ordinal,
      sourceId,
      opaqueId: identity.hash,
      namespace: identity.namespace,
      generation,
      status: null,
      ok: false,
      refused: false,
      wrote: false,
      created: false,
      counts: null,
      manifestSha: null,
      before: { words: 0, summaries: 0, srcSeqs: 0, builds: 0 },
    };
    if (classified.status !== 'READY') {
      // 可预期的不可导入：仍然是**终态**，如实记下，绝不写成 PENDING 蒙过去。
      entry.status = classified.status;
      entry.refused = true;
      appendJournal(journal, entry);
      outcomes.push(entry);
      return;
    }
    try {
      // 导入前先量一次这份来源自己的行数：守恒的「变化」由它算，不由调用方的记账算。
      entry.before = measureSourceCounts(dbPath, sourceId);
      const built = buildSourceFeed(row, { root, dbPath, identity, generation });
      const receipt = runImport(['--manifest', built.manifestPath, '--sha256', built.manifestSha, '--generation', String(generation), '--db', dbPath]);
      if (!receipt || receipt.ok !== true) fail((receipt && receipt.code) || 'IMPORT_FAILED', 'importer did not acknowledge the source');
      entry.status = receipt.code || 'IMPORTED';
      entry.ok = OK_STATUSES.indexOf(entry.status) !== -1;
      if (!entry.ok) fail(entry.status, 'importer returned a non-ok receipt for a committed source');
      entry.wrote = receipt.wrote === true;
      entry.created = !!(receipt.previous && receipt.previous.generation === null);
      entry.counts = safeReceiptCounts(receipt);
      entry.manifestSha = built.manifestSha;
    } catch (error) {
      // 码是终态，消息不是：消息里带路径，所以永不落进 journal。
      entry.status = (error && error.code) || 'IMPORT_FAILED';
      entry.ok = false;
      entry.refused = false;
      entry.wrote = false;
      entry.created = false;
      entry.counts = null;
    }
    appendJournal(journal, entry);
    outcomes.push(entry);
  });
  const counts = {
    total: outcomes.length,
    ok: outcomes.filter((outcome) => outcome.ok).length,
    refused: outcomes.filter((outcome) => outcome.refused).length,
    failed: outcomes.filter((outcome) => !outcome.ok && !outcome.refused).length,
  };
  // 守恒与体检都在**导入之后**各跑一次：前者对账回执与库，后者独立复核索引自身。
  const conservation = verifyConservation({ dbPath, outcomes, before });
  const integrity = auditTempDb(dbPath);
  appendJournal(journal, {
    kind: 'run',
    total: counts.total,
    ok: counts.ok,
    refused: counts.refused,
    failed: counts.failed,
    conservation: { ok: conservation.ok, problems: conservation.problems.length },
    integrity: { available: integrity.available, ok: integrity.ok, aligned: integrity.aligned, problems: integrity.problems.length },
  });
  return { outcomes, accounting, journal, counts, conservation, integrity };
}

// ── CLI ───────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const options = { rows: null, root: null, db: null };
  const takesValue = { '--rows': 'rows', '--root': 'root', '--db': 'db' };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = String(argv[index]);
    if (!takesValue[flag]) fail('USAGE', 'unknown argument: ' + flag + ' (known: --rows --root --db)');
    const value = argv[index + 1];
    if (value === undefined || String(value).startsWith('--')) fail('USAGE', 'missing value for ' + flag);
    options[takesValue[flag]] = String(value);
    index += 1;
  }
  for (const key of ['rows', 'root', 'db']) if (!options[key]) fail('USAGE', 'missing required --' + key);
  return options;
}

export function main(argv) {
  let exitCode = EXIT.ok;
  let summary;
  try {
    const options = parseArgs(argv || []);
    const raw = JSON.parse(fs.readFileSync(options.rows, 'utf8'));
    const rows = Array.isArray(raw) ? raw : raw && raw.rows;
    if (!Array.isArray(rows)) fail('INPUT_INVALID', '--rows file must hold an array of source rows, or an object with a rows array');
    const result = importPerSource({ root: options.root, dbPath: options.db, rows });
    summary = {
      ok: false,
      counts: result.counts,
      statuses: result.outcomes.map((outcome) => ({ ordinal: outcome.ordinal, status: outcome.status, ok: outcome.ok, refused: outcome.refused })),
      conservation: { ok: result.conservation.ok, problems: result.conservation.problems },
      integrity: { available: result.integrity.available, ok: result.integrity.ok, aligned: result.integrity.aligned, problems: result.integrity.problems.length },
      journal: result.journal,
    };
    // 退出码只说一件事：这一批有没有真的落地。顺序 = 严重程度。
    if (result.counts.failed > 0) exitCode = EXIT.failed;
    else if (!result.conservation.ok) exitCode = EXIT.failed;
    else if (!result.integrity.ok) exitCode = EXIT.integrity;
    else if (result.counts.refused > 0) exitCode = EXIT.refused;
    summary.ok = exitCode === EXIT.ok;
  } catch (error) {
    exitCode = error && error.code === 'USAGE' ? EXIT.usage : EXIT.failed;
    // 只回码，不回消息：消息里有路径，而 CLI 的输出经常被重定向进日志。
    summary = { ok: false, code: (error && error.code) || 'INTERNAL' };
  }
  process.stdout.write(JSON.stringify({ ...summary, exitCode }, null, 2) + '\n');
  return exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  // 唯一出口（2026-11-16 batch 1）：本文件已被 tools/echo-index-source-snapshot-import.mjs 取代。
  // 作为脚本运行一律拒绝，且拒绝得能被看见（stderr + 非零退出），而不是静默跑旧逻辑。
  console.error('SUPERSEDED: use tools/echo-index-source-snapshot-import.mjs');
  process.exit(5);
}
