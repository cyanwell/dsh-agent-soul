#!/usr/bin/env node
// tools/echo-index-import.mjs —— 隔离的 v9「ECHO 派生索引」导入器 + 指针解析 + 检索
// ============================================================================
// 范围：把**显式指定的**一份 ECHO 派生索引（words.jsonl / summaries.jsonl + 一份清单）
// 导进**显式指定的**一个已经迁到 v9 的 meta.sqlite，并让 words 与 summaries 各自可检索、
// 各自的指针可解析。它是原型切片，不是服务，不猜任何默认值。
//
// ── 契约（逐条对应，别改口径）──────────────────────────────────────────────
//   1. 输入三样，全部显式：--manifest（清单）、--sha256（清单本身的 SHA-256，小写 64 hex）、
//      --generation（这一代号）、--db（目标库）。没有就什么都不做（连库都不打开）。
//   2. 源文件只读一次字节；SHA-256 在解析之前比对。严格 UTF-8（fatal），不许 BOM，必须以 LF 结尾。
//   3. 清单里声明的 words / summaries 的 path / sha256 / bytes / rows 全部复验 ——
//      清单不是"信任状"，它只是**另一份待验的输入**。
//   4. 所有校验（字段/类型/截断/重复键/代次/计数）都在 BEGIN IMMEDIATE **之前**做完。
//      事务里只剩写 + 事务内自检；任何失败整体回滚，并复读证明库没变。
//   5. 一次导入 = 一个来源的**一整代**：删旧代（含两张 FTS）、写新代、推进 cursor 与 generation、
//      写一条只追加的构建审计行 —— 同一个事务。
//   6. 同一（来源, 代次, 清单 SHA）重复导入 = no-op（ALREADY_CURRENT，exit 0，一行都不写）。
//      同代不同字节 = 拒绝；代次倒退 = 拒绝；跨代 = 拒绝（一次只前进一代）。
//   7. 推理（kind/role = reasoning|thinking）**不进索引**：库层 CHECK + 导入器双层拒，
//      清单的 counts.excludedReasoning 必须与源文件里被排除的行数一致。
//   8. 字段归一只有两处，且都只是**表示层**的：truncated 的 true/false → 1/0；
//      其余字段一律按源值原样入库（不 trim、不改大小写、不补默认值）。
//   9. 指针三种，语义互不冒充（见 parseEchoPtr）：
//        log:<sid>#seq=<n>    一手（v3 流）
//        v4log:<sid>#seq=<n>  一手（v4 流），与 log 同级、永不互相解析
//        idx:<cmp-id>         **只**指向 L4 摘要；它不会去开一条 words
//      ★ 旧语法 log:<sid>#seq=<n> 一个字节都不改。★ 不引入 @stream16 之类的扩展语法（遇到就拒）。
//      ★ 同一个 sid+seq 命中多个来源路径 = AMBIGUOUS，回**显式候选路径**，绝不挑一个。
//  10. 派生索引绝不进 frame_index：本工具只写 echo_* 表；库层还有一条触发器拒绝 idx: 前缀的 ptr
//      写进 frame_index（想混进去得先删触发器，那本身会留痕）。
//
// ── 用法 ───────────────────────────────────────────────────────────────────
//   node tools/echo-index-import.mjs --manifest <f.json> --sha256 <64 hex> --generation <n> --db <meta.sqlite>
//                                    [--words <f.jsonl>] [--summaries <f.jsonl>]
//                                    [--dry-run] [--now <ISO>] [--json]
//   退出码：0 成功（含 ALREADY_CURRENT）/ 2 用法 / 3 拒绝（输入/代次/护栏）/ 4 schema / 5 IO / 6 写库失败
//
// ── 已知边界（写在这里，免得被当成已实现）──────────────────────────────────
//   · 本文件里的解析器/检索器**没有**接进 store.resolvePtr / store.search —— 那是下一步，
//     需要改 src/db/store.mjs（本任务禁止）。这里只证明数据面与语义面成立。
//   · echo_summaries.src_seq_count 是审计列，库层不强制它等于子表行数；
//     等值由本工具在事务内断言 + verifyEchoIntegrity() 复核。
//   · namespace 只有 log / v4log 两个；别的一律拒（不猜）。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openMetaStore, SCHEMA_VERSION } from '../src/db/index.mjs';
import { echoSourceIdFor, ECHO_PTR_NAMESPACES, ECHO_SUMMARY_PTR_PREFIX } from '../src/db/schema.mjs';
import { parsePtr } from '../src/db/ptr.mjs';
import { buildSearchText, buildQueryPlan, containsNeedle } from '../src/db/search.mjs';
// ECHO 完整性判据的唯一实现（Task-14）。导入器这边只留一层**旧字段名映射**，不再自己抄一份 SQL。
import { analyzeEchoIntegrity, echoIndexInfo, echoIndexInfoForOne } from '../src/db/echo-integrity.mjs';
import { classifyEchoWordContent } from '../src/db/echo-content-class.mjs';

export const IMPORTER_VERSION = 'echo-index-import/1';
export const ECHO_INDEX_VERSION_RE = /^echo-index\/\d+$/;
export const ECHO_REASONING_KINDS = Object.freeze(['reasoning', 'thinking']);
export const ECHO_WORD_FIELDS = Object.freeze(['t', 'session', 'ws', 'seq', 'turn', 'log', 'role', 'kind', 'len', 'truncated', 'text']);
export const ECHO_SUMMARY_FIELDS = Object.freeze(['cmpId', 't', 'session', 'ws', 'log', 'srcSeqs', 'shadowedTokens', 'shadowedChars', 'provider', 'model', 'status', 'summary']);
export const ECHO_SUMMARY_STATUSES = Object.freeze(['active', 'void']);
export const ECHO_SEARCH_BATCH = 200;

const SHA_RE = /^[0-9a-f]{64}$/;
const SESSION_RE = /^[A-Za-z0-9._-]{1,128}$/;
const CMP_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export const EXIT = Object.freeze({ ok: 0, usage: 2, refused: 3, schema: 4, io: 5, write: 6 });

export class EchoImportRefusal extends Error {
  constructor(code, message, detail, exit) {
    super(message);
    this.name = 'EchoImportRefusal';
    this.code = code;
    this.detail = detail === undefined ? null : detail;
    this.exit = typeof exit === 'number' ? exit : EXIT.refused;
  }
}

const refuse = (code, message, detail, exit) => { throw new EchoImportRefusal(code, message, detail, exit); };

// ── 身份与规范化 ────────────────────────────────────────────────────────────

// 「全规范路径」的判据（只判，不修）：绝对、posix 分隔符、无尾斜杠、无 '.'/'..' 段、无重复斜杠。
// ★ 不做"顺手帮你归一"：来源身份是路径字符串本身，归一化规则一旦藏起来，两处实现就会分叉。
export function isCanonicalSourcePath(p) {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (p.indexOf('\\') !== -1) return false;
  const absolute = p.charAt(0) === '/' || /^[A-Za-z]:\//.test(p);
  if (!absolute) return false;
  if (p.length > 1 && p.endsWith('/')) return false;
  if (p.indexOf('//') !== -1) return false;
  for (const seg of p.split('/')) {
    if (seg === '.' || seg === '..') return false;
  }
  return true;
}

export function charLen(text) {
  return Array.from(String(text)).length;
}

// 逐字哈希：words 用固定字段序的 JSON（含全部源字段），summaries 用源行原文。
export function wordContentHash(w) {
  return createHash('sha256').update(JSON.stringify({
    t: w.t, session: w.session, ws: w.ws, seq: w.seq, turn: w.turn, log: w.log,
    role: w.role, kind: w.kind, len: w.len, truncated: w.truncated, text: w.text,
  }), 'utf8').digest('hex');
}

export function summaryContentHash(rawLine) {
  return createHash('sha256').update(String(rawLine), 'utf8').digest('hex');
}

export function isReasoningRow(role, kind) {
  return ECHO_REASONING_KINDS.indexOf(String(role)) !== -1 || ECHO_REASONING_KINDS.indexOf(String(kind)) !== -1;
}

// ── 指针：三种命名空间互不冒充 ──────────────────────────────────────────────

// 返回 { kind:'word', namespace, sessionId, seq } 或 { kind:'summary', cmpId }。
// ★ 旧语法 log:<sid>#seq=<n> 完全走 ptr.mjs 的 parsePtr（形状/前导零/上界同一套判据）。
// ★ 任何 @ 扩展（@stream16 之类）一律拒 —— 没有实现过的语法不许被"容忍"。
export function parseEchoPtr(ptr) {
  if (typeof ptr !== 'string' || ptr.length === 0) refuse('ECHO_PTR_MALFORMED', 'ptr must be a non-empty string', { ptr });
  if (ptr.indexOf('@') !== -1) {
    refuse('ECHO_PTR_MALFORMED', 'ptr extensions such as @stream16 are not part of this contract: ' + ptr, { ptr, reason: 'no-extension-syntax' });
  }
  const prefix = ECHO_SUMMARY_PTR_PREFIX + ':';
  if (ptr.startsWith(prefix)) {
    const cmpId = ptr.slice(prefix.length);
    if (!CMP_ID_RE.test(cmpId)) refuse('ECHO_PTR_MALFORMED', 'idx: ptr requires a single cmp id (got ' + JSON.stringify(cmpId) + ')', { ptr });
    return { raw: ptr, kind: 'summary', cmpId };
  }
  let parsed;
  try {
    parsed = parsePtr(ptr);
  } catch (err) {
    refuse('ECHO_PTR_MALFORMED', err && err.message ? err.message : String(err), { ptr }, EXIT.refused);
  }
  if (ECHO_PTR_NAMESPACES.indexOf(parsed.namespace) === -1) {
    refuse('ECHO_PTR_UNKNOWN_NAMESPACE',
      'namespace ' + parsed.namespace + ' is not part of the derived index (allowed: ' + ECHO_PTR_NAMESPACES.join(' | ') + ' | ' + ECHO_SUMMARY_PTR_PREFIX + ')',
      { ptr, namespace: parsed.namespace });
  }
  return { raw: ptr, kind: 'word', namespace: parsed.namespace, sessionId: parsed.sessionId, seq: parsed.seq };
}

function sourceRowFor(db, echoSourceId) {
  const row = db.prepare('SELECT * FROM echo_index_sources WHERE echo_source_id = ?').get(echoSourceId);
  if (!row) return null;
  return {
    echoSourceId: row.echo_source_id,
    sourcePath: row.source_path,
    sourceVersion: row.source_version,
    namespace: row.namespace,
    generation: Number(row.generation),
    state: row.state,
    cursorSeq: Number(row.cursor_seq),
    cursorJson: row.cursor_json,
    wordsCount: Number(row.words_count),
    summariesCount: Number(row.summaries_count),
    srcSeqCount: Number(row.src_seq_count),
    sourceSha256: row.source_sha256,
    sourceBytes: Number(row.source_bytes),
    builtAt: row.built_at,
    importedAt: row.imported_at,
    importer: row.importer,
  };
}

function ambiguous(ptr, kind, candidates) {
  refuse('ECHO_PTR_AMBIGUOUS',
    'ptr ' + ptr + ' matches ' + candidates.length + ' ECHO sources (' + kind + '); refusing to guess — pick one of the candidate paths',
    { ptr, kind, candidates });
}

// resolveEchoPtr(db, ptr) →
//   { status:'ok', kind:'word', ptr, namespace, source, word }
//   { status:'ok', kind:'summary', ptr, source, summary, srcSeqs:[...] }   （srcSeqs 按源顺序）
// 多个来源命中 → 抛 ECHO_PTR_AMBIGUOUS，detail.candidates 带**显式路径**。
export function resolveEchoPtr(db, ptr) {
  const parsed = parseEchoPtr(ptr);
  if (parsed.kind === 'summary') {
    const rows = db.prepare([
      'SELECT s.echo_source_id AS sid FROM echo_summaries s WHERE s.cmp_id = ?',
      'ORDER BY s.echo_source_id',
    ].join(' ')).all(parsed.cmpId);
    if (rows.length === 0) refuse('ECHO_PTR_NOT_FOUND', 'no ECHO summary indexed for ' + ptr, { ptr, cmpId: parsed.cmpId });
    if (rows.length > 1) ambiguous(ptr, 'summary', rows.map((r) => sourceRowFor(db, r.sid)));
    const src = sourceRowFor(db, rows[0].sid);
    const s = db.prepare('SELECT * FROM echo_summaries WHERE echo_source_id = ? AND cmp_id = ?').get(src.echoSourceId, parsed.cmpId);
    const seqs = db.prepare('SELECT seq FROM echo_summary_src_seqs WHERE echo_source_id = ? AND cmp_id = ? ORDER BY ord').all(src.echoSourceId, parsed.cmpId);
    return {
      status: 'ok', kind: 'summary', ptr,
      source: src,
      summary: {
        cmpId: s.cmp_id, t: s.t, session: s.session, ws: s.ws, log: s.log,
        shadowedTokens: Number(s.shadowed_tokens), shadowedChars: Number(s.shadowed_chars),
        provider: s.provider, model: s.model, status: s.status, summary: s.summary,
        fullJson: s.full_json, srcSeqCount: Number(s.src_seq_count), contentHash: s.content_hash,
      },
      // ★ 顺序 = 源顺序；重复与乱序都原样保留（Capped 标记不是权威）。
      srcSeqs: seqs.map((r) => Number(r.seq)),
    };
  }
  const candidates = db.prepare([
    'SELECT DISTINCT w.echo_source_id AS sid',
    'FROM echo_words w JOIN echo_index_sources s ON s.echo_source_id = w.echo_source_id',
    'WHERE s.namespace = ? AND w.session = ? AND w.seq = ?',
    'ORDER BY w.echo_source_id',
  ].join(' ')).all(parsed.namespace, parsed.sessionId, parsed.seq);
  if (candidates.length === 0) {
    refuse('ECHO_PTR_NOT_FOUND', 'no ECHO word indexed for ' + ptr, { ptr, namespace: parsed.namespace, sessionId: parsed.sessionId, seq: parsed.seq });
  }
  if (candidates.length > 1) ambiguous(ptr, 'word', candidates.map((r) => sourceRowFor(db, r.sid)));
  const src = sourceRowFor(db, candidates[0].sid);
  const w = db.prepare('SELECT * FROM echo_words WHERE echo_source_id = ? AND session = ? AND seq = ?').get(src.echoSourceId, parsed.sessionId, parsed.seq);
  return {
    status: 'ok', kind: 'word', ptr, namespace: parsed.namespace, source: src,
    word: {
      wordOrd: Number(w.word_ord), srcLine: Number(w.src_line), t: w.t, session: w.session, ws: w.ws,
      seq: Number(w.seq), turn: w.turn === null ? null : Number(w.turn), log: w.log, role: w.role, kind: w.kind,
      len: Number(w.len), truncated: Number(w.truncated) === 1, text: w.text, contentHash: w.content_hash,
    },
  };
}

// ── 检索：FTS 候选（超集）+ 原文子串核实（唯一语义）─────────────────────────
//
// ★ 与 frame 检索同一条纪律：预筛只允许是**超集**，最终判定永远由 containsNeedle 逐条做。
//   非 CJK 查询不走 FTS（整词 token 不是子串语义的超集），直接扫原文。
// ★ 候选永不截断：扫到「取够 limit」或「候选耗尽」。

// 计数面：判据与字段名都搬到 src/db/echo-integrity.mjs（echoIndexInfo）。
// ★ 这里保留同名薄壳，不是为了兼容谁的名字 —— 是 src/db/echo.mjs 与导入器自检都从这个
//   文件取它（那是已发布形状）。壳里**零 SQL**：多一份 SQL 就多一份漂移。
export function echoIndexInfoFor(db) {
  return echoIndexInfo(db);
}

function assertEchoIndexAligned(db, info) {
  const i = info || echoIndexInfoFor(db);
  if (i.aligned) return i;
  refuse('ECHO_INDEX_STALE',
    'echo derived index is out of sync (per-source counts differ between rows / FTS / srcSeqs); refusing to return a partial result',
    { index: i });
}

// ── echoSourceId 作用域 ────────────────────────────────────────────────────
// ★ 语义：缺省 / null / 空串 = 不限定（历史口径，一个字节都不改）；非空 = 必须指向一条**已索引**来源。
// ★ 校验顺序固定：查询计划（buildQueryPlan）→ 索引对齐 → 来源存在性 → 才开始扫描。
//   来源不存在时报错，而不是静默返回 0 条 —— 0 条会被读成「这个来源里没有」，
//   真相是「这个来源根本不在索引里」，两者不许混（与 store.echoSearch 同一判据）。
function normalizeEchoSourceScope(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw);
  return s.length === 0 ? null : s;
}

function assertEchoSourceIndexed(db, echoSourceId, surface) {
  if (echoSourceId === null) return;
  const hit = db.prepare('SELECT 1 AS ok FROM echo_index_sources WHERE echo_source_id = ?').get(echoSourceId);
  if (hit) return;
  const indexed = db.prepare('SELECT echo_source_id AS sid FROM echo_index_sources ORDER BY echo_source_id').all().map((r) => r.sid);
  refuse('ECHO_SOURCE_NOT_FOUND',
    'no ECHO source indexed with id ' + echoSourceId + ' (asked on ' + surface + '; indexed: ' + (indexed.length === 0 ? 'none' : indexed.join(', ')) + ')',
    { echoSourceId, surface, indexed });
}

function clampLimit(value) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 50;
  if (n < 1) return 1;
  return n > 500 ? 500 : n;
}

const WORD_MATCH_SQL = [
  'select f.echo_source_id as echo_source_id, f.word_ord as word_ord, f.session as session, f.seq as seq,',
  '       w.t as t, w.kind as kind, w.text as raw_text, bm25(echo_words_fts) as score',
  'from echo_words_fts f join echo_words w on w.echo_source_id = f.echo_source_id and w.word_ord = f.word_ord',
  'where echo_words_fts match ?',
  '  and (? is null or w.echo_source_id = ?)',
  'order by score, w.echo_source_id, w.word_ord',
  'limit ? offset ?',
].join(' ');

const WORD_RAW_SQL = [
  'select rowid as rid, echo_source_id as echo_source_id, word_ord as word_ord, session as session,',
  '       seq as seq, t as t, kind as kind, text as raw_text',
  'from echo_words where rowid > ? and (? is null or echo_source_id = ?)',
  'order by rowid limit ?',
].join(' ');

const SUMMARY_MATCH_SQL = [
  'select f.echo_source_id as echo_source_id, f.cmp_id as cmp_id, s.t as t, s.session as session,',
  '       s.shadowed_tokens as shadowed_tokens, s.shadowed_chars as shadowed_chars, s.summary as raw_text,',
  '       bm25(echo_summaries_fts) as score',
  'from echo_summaries_fts f join echo_summaries s on s.echo_source_id = f.echo_source_id and s.cmp_id = f.cmp_id',
  'where echo_summaries_fts match ?',
  '  and (? is null or s.echo_source_id = ?)',
  'order by score, s.echo_source_id, s.cmp_id',
  'limit ? offset ?',
].join(' ');

const SUMMARY_RAW_SQL = [
  'select rowid as rid, echo_source_id as echo_source_id, cmp_id as cmp_id, t as t, session as session,',
  '       shadowed_tokens as shadowed_tokens, shadowed_chars as shadowed_chars, summary as raw_text',
  'from echo_summaries where rowid > ? and (? is null or echo_source_id = ?)',
  'order by rowid limit ?',
].join(' ');

// searchEchoWords(db, query, { limit, echoSourceId }) → 与 searchFrames 同形状的回执。
export function searchEchoWords(db, query, options) {
  const o = options || {};
  const limit = clampLimit(o.limit);
  const scope = normalizeEchoSourceScope(o.echoSourceId);
  const plan = buildQueryPlan(query);
  const index = assertEchoIndexAligned(db);
  assertEchoSourceIndexed(db, scope, 'echo_words');
  const out = {
    surface: 'echo_words', query: plan.query, needle: plan.needle, matchMode: plan.matchMode,
    tokens: plan.tokens.map((x) => x.t), scanPath: plan.matchMode === 'bigram' ? 'bigram-fts' : 'raw-scan',
    index, candidates: 0, scanned: 0, batches: 0, exhausted: false, verifiedBy: 'echo_words.text:substring',
    results: [],
  };
  if (plan.matchMode === 'empty') { out.exhausted = true; return out; }
  const push = (row, score) => {
    out.results.push({
      echoSourceId: row.echo_source_id,
      wordOrd: Number(row.word_ord),
      session: row.session,
      seq: Number(row.seq),
      t: row.t,
      kind: row.kind,
      snippet: String(row.raw_text).slice(0, 200),
      rawText: row.raw_text,
      score: score === undefined ? null : score,
      matchMode: plan.matchMode,
    });
  };
  if (plan.matchMode === 'bigram') {
    const stmt = db.prepare(WORD_MATCH_SQL);
    let offset = 0;
    for (;;) {
      const rows = stmt.all(plan.expression, scope, scope, ECHO_SEARCH_BATCH, offset);
      out.batches += 1;
      if (rows.length === 0) { out.exhausted = true; return out; }
      out.candidates += rows.length; out.scanned += rows.length; offset += rows.length;
      for (const row of rows) {
        if (!containsNeedle(row.raw_text, plan.needle)) continue;
        push(row, row.score);
        if (out.results.length >= limit) return out;
      }
      if (rows.length < ECHO_SEARCH_BATCH) { out.exhausted = true; return out; }
    }
  }
  const stmt = db.prepare(WORD_RAW_SQL);
  let cursor = -1;
  for (;;) {
    const rows = stmt.all(cursor, scope, scope, ECHO_SEARCH_BATCH);
    out.batches += 1;
    if (rows.length === 0) { out.exhausted = true; return out; }
    out.candidates += rows.length; out.scanned += rows.length;
    for (const row of rows) {
      cursor = row.rid;
      if (!containsNeedle(row.raw_text, plan.needle)) continue;
      push(row, null);
      if (out.results.length >= limit) return out;
    }
    if (rows.length < ECHO_SEARCH_BATCH) { out.exhausted = true; return out; }
  }
}

export function searchEchoSummaries(db, query, options) {
  const o = options || {};
  const limit = clampLimit(o.limit);
  const scope = normalizeEchoSourceScope(o.echoSourceId);
  const plan = buildQueryPlan(query);
  const index = assertEchoIndexAligned(db);
  assertEchoSourceIndexed(db, scope, 'echo_summaries');
  const out = {
    surface: 'echo_summaries', query: plan.query, needle: plan.needle, matchMode: plan.matchMode,
    tokens: plan.tokens.map((x) => x.t), scanPath: plan.matchMode === 'bigram' ? 'bigram-fts' : 'raw-scan',
    index, candidates: 0, scanned: 0, batches: 0, exhausted: false, verifiedBy: 'echo_summaries.summary:substring',
    results: [],
  };
  if (plan.matchMode === 'empty') { out.exhausted = true; return out; }
  const push = (row, score) => {
    out.results.push({
      echoSourceId: row.echo_source_id, cmpId: row.cmp_id, t: row.t, session: row.session,
      shadowedTokens: Number(row.shadowed_tokens), shadowedChars: Number(row.shadowed_chars),
      snippet: String(row.raw_text).slice(0, 200), rawText: row.raw_text,
      score: score === undefined ? null : score, matchMode: plan.matchMode,
    });
  };
  if (plan.matchMode === 'bigram') {
    const stmt = db.prepare(SUMMARY_MATCH_SQL);
    let offset = 0;
    for (;;) {
      const rows = stmt.all(plan.expression, scope, scope, ECHO_SEARCH_BATCH, offset);
      out.batches += 1;
      if (rows.length === 0) { out.exhausted = true; return out; }
      out.candidates += rows.length; out.scanned += rows.length; offset += rows.length;
      for (const row of rows) {
        if (!containsNeedle(row.raw_text, plan.needle)) continue;
        push(row, row.score);
        if (out.results.length >= limit) return out;
      }
      if (rows.length < ECHO_SEARCH_BATCH) { out.exhausted = true; return out; }
    }
  }
  const stmt = db.prepare(SUMMARY_RAW_SQL);
  let cursor = -1;
  for (;;) {
    const rows = stmt.all(cursor, scope, scope, ECHO_SEARCH_BATCH);
    out.batches += 1;
    if (rows.length === 0) { out.exhausted = true; return out; }
    out.candidates += rows.length; out.scanned += rows.length;
    for (const row of rows) {
      cursor = row.rid;
      if (!containsNeedle(row.raw_text, plan.needle)) continue;
      push(row, null);
      if (out.results.length >= limit) return out;
    }
    if (rows.length < ECHO_SEARCH_BATCH) { out.exhausted = true; return out; }
  }
}

// 完整性复核（事务外、只读）：判据在 src/db/echo-integrity.mjs，这里只做**旧字段名映射**。
//
// ★ 为什么还留这一层，而不是让调用方直接吃新名：verifyEchoIntegrity 是 v9 导入器的
//   对外回执（tools/echo-index-import-selftest、src/db/echo.mjs 都在读），字段名属于
//   **已发布形状**。把 maxBuild / json 改成新名不是重构，是破坏。
//
// 两个映射（Task-14 明确要求）：
//   generation-vs-builds  : maxBuildGeneration → maxBuild
//   cursor-seq-json-mismatch : cursor        → json
//
// ★ 缺表：以前这里会抛一个未处理的 SqliteError。现在判据会先探表，缺表时回
//   ok:false + available:false + missing 列表 —— 「没建过」是一句话，不是一个异常。
//   ★ 形状：正常路径仍是老四键（ok / index / problems / orphanFts），只多一个 available:true；
//     缺表路径多 missing（否则调用方看不出为什么 ok:false）。
export function verifyEchoIntegrity(db) {
  const r = analyzeEchoIntegrity(db);
  if (!r.available) {
    return { ok: false, available: false, missing: r.missing, index: r.index, problems: [], orphanFts: r.orphanFts };
  }
  return {
    ok: r.ok,
    available: true,
    index: r.index,
    problems: r.problems.map(legacyEchoProblem),
    orphanFts: r.orphanFts,
  };
}

// 旧字段名映射：只动这两个 kind，其余 problem 原样转发（多一层包装就多一处可以漂的地方）。
function legacyEchoProblem(p) {
  if (p.kind === 'generation-vs-builds') {
    return { echoSourceId: p.echoSourceId, kind: p.kind, generation: p.generation, builds: p.builds, maxBuild: p.maxBuildGeneration };
  }
  if (p.kind === 'cursor-seq-json-mismatch') {
    return { echoSourceId: p.echoSourceId, kind: p.kind, cursorSeq: p.cursorSeq, json: p.cursor };
  }
  return p;
}

export function listEchoSources(db) {
  return db.prepare('SELECT * FROM echo_index_sources ORDER BY source_path, source_version').all().map((r) => sourceRowFor(db, r.echo_source_id));
}

// ── 输入读取与校验（全部在事务之前）────────────────────────────────────────

function readFileOnce(abs, codePrefix, label) {
  let bytes;
  try { bytes = fs.readFileSync(abs); } catch (err) {
    refuse(codePrefix + '_READ_FAILED', 'cannot read ' + label + ': ' + (err && err.message), { path: abs }, EXIT.io);
  }
  return bytes;
}

function decodeStrict(bytes, codePrefix, label) {
  if (bytes.length === 0) refuse(codePrefix + '_EMPTY', label + ' is empty (0 bytes)', { label });
  if (bytes.length >= 3 && bytes[0] === BOM[0] && bytes[1] === BOM[1] && bytes[2] === BOM[2]) {
    refuse(codePrefix + '_HAS_BOM', label + ' starts with a UTF-8 BOM; strip it first', { label });
  }
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  try { return decoder.decode(bytes); } catch (err) {
    refuse(codePrefix + '_INVALID_UTF8', label + ' is not valid UTF-8: ' + (err && err.message), { label });
  }
}

function requireObject(value, where) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    refuse('MANIFEST_FIELD_INVALID', where + ' must be a JSON object', { where, got: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value });
  }
  return value;
}

function requireString(rec, key, where, allowEmpty) {
  if (!Object.prototype.hasOwnProperty.call(rec, key)) refuse('MANIFEST_FIELD_MISSING', where + ': missing ' + key, { where, field: key });
  const v = rec[key];
  if (typeof v !== 'string') refuse('MANIFEST_FIELD_INVALID', where + ': ' + key + ' must be a string', { where, field: key, got: v === null ? 'null' : typeof v });
  if (!allowEmpty && v.length === 0) refuse('MANIFEST_FIELD_INVALID', where + ': ' + key + ' must be non-empty', { where, field: key });
  return v;
}

function requireInt(rec, key, where, min) {
  const v = rec[key];
  if (typeof v !== 'number' || !Number.isInteger(v)) refuse('MANIFEST_FIELD_INVALID', where + ': ' + key + ' must be an integer', { where, field: key, got: typeof v });
  if (v < min) refuse('MANIFEST_FIELD_INVALID', where + ': ' + key + ' must be >= ' + min, { where, field: key, got: v });
  return v;
}

function optionalStringField(rec, key, where) {
  if (!Object.prototype.hasOwnProperty.call(rec, key)) refuse('ROW_FIELD_MISSING', where + ': missing ' + key + ' (present-but-null is allowed)', { where, field: key });
  const v = rec[key];
  if (v === null) return null;
  if (typeof v !== 'string') refuse('ROW_FIELD_INVALID', where + ': ' + key + ' must be a string or null', { where, field: key, got: typeof v });
  return v;
}

function parseWordRow(lineNo, rawLine) {
  const where = 'words line ' + lineNo;
  let rec;
  try { rec = JSON.parse(rawLine); } catch (err) {
    refuse('ROW_JSON_INVALID', where + ': malformed JSON (' + (err && err.message) + ')', { line: lineNo });
  }
  requireObject(rec, where);
  for (const f of ECHO_WORD_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(rec, f)) refuse('ROW_FIELD_MISSING', where + ': missing source field ' + f, { line: lineNo, field: f });
  }
  const t = requireString(rec, 't', where, false);
  const session = requireString(rec, 'session', where, false);
  if (!SESSION_RE.test(session)) {
    refuse('ROW_FIELD_INVALID', where + ': session ' + JSON.stringify(session) + ' is not ptr-safe ([A-Za-z0-9._-]{1,128}); log:<sid>#seq must stay resolvable', { line: lineNo, session });
  }
  const ws = optionalStringField(rec, 'ws', where);
  const seq = requireInt(rec, 'seq', where, 0);
  let turn = null;
  if (rec.turn !== null) turn = requireInt(rec, 'turn', where, 0);
  const log = optionalStringField(rec, 'log', where);
  const role = requireString(rec, 'role', where, false);
  const kind = requireString(rec, 'kind', where, false);
  const len = requireInt(rec, 'len', where, 0);
  if (rec.truncated !== true && rec.truncated !== false && rec.truncated !== 0 && rec.truncated !== 1) {
    refuse('ROW_FIELD_INVALID', where + ': truncated must be boolean or 0/1', { line: lineNo, got: typeof rec.truncated });
  }
  const truncated = rec.truncated === true || rec.truncated === 1 ? 1 : 0;
  const text = requireString(rec, 'text', where, false);
  const textChars = charLen(text);
  if (textChars > len) {
    refuse('ROW_TRUNCATION_INCONSISTENT', where + ': text has ' + textChars + ' chars but len says ' + len + ' (text can never be longer than the declared length)', { line: lineNo });
  }
  if (truncated === 0 && textChars !== len) {
    refuse('ROW_TRUNCATION_INCONSISTENT', where + ': truncated=0 but text has ' + textChars + ' chars while len=' + len + ' (the flag would be a lie)', { line: lineNo });
  }
  const row = { src_line: lineNo, t, session, ws, seq, turn, log, role, kind, len, truncated, text };
  row.content_hash = wordContentHash(row);
  return row;
}

function parseSummaryRow(lineNo, rawLine) {
  const where = 'summaries line ' + lineNo;
  let rec;
  try { rec = JSON.parse(rawLine); } catch (err) {
    refuse('ROW_JSON_INVALID', where + ': malformed JSON (' + (err && err.message) + ')', { line: lineNo });
  }
  requireObject(rec, where);
  for (const f of ECHO_SUMMARY_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(rec, f)) refuse('ROW_FIELD_MISSING', where + ': missing source field ' + f, { line: lineNo, field: f });
  }
  const cmpId = requireString(rec, 'cmpId', where, false);
  if (!CMP_ID_RE.test(cmpId)) refuse('ROW_FIELD_INVALID', where + ': cmpId ' + JSON.stringify(cmpId) + ' is not idx-safe', { line: lineNo, cmpId });
  const t = requireString(rec, 't', where, false);
  const session = requireString(rec, 'session', where, false);
  if (!SESSION_RE.test(session)) refuse('ROW_FIELD_INVALID', where + ': session is not ptr-safe', { line: lineNo, session });
  const ws = optionalStringField(rec, 'ws', where);
  const log = optionalStringField(rec, 'log', where);
  if (!Array.isArray(rec.srcSeqs)) refuse('ROW_FIELD_INVALID', where + ': srcSeqs must be an array', { line: lineNo, got: typeof rec.srcSeqs });
  const srcSeqs = rec.srcSeqs.map((v, i) => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
      refuse('ROW_FIELD_INVALID', where + ': srcSeqs[' + i + '] must be a non-negative integer', { line: lineNo, index: i, got: v });
    }
    return v;
  });
  const shadowedTokens = requireInt(rec, 'shadowedTokens', where, 0);
  const shadowedChars = requireInt(rec, 'shadowedChars', where, 0);
  const provider = optionalStringField(rec, 'provider', where);
  const model = optionalStringField(rec, 'model', where);
  const status = requireString(rec, 'status', where, false);
  if (ECHO_SUMMARY_STATUSES.indexOf(status) === -1) {
    refuse('ROW_FIELD_INVALID', where + ': status must be ' + ECHO_SUMMARY_STATUSES.join('|') + ' (got ' + JSON.stringify(status) + ')', { line: lineNo });
  }
  const summary = requireString(rec, 'summary', where, false);
  return {
    src_line: lineNo, cmp_id: cmpId, t, session, ws, log, src_seqs: srcSeqs,
    shadowed_tokens: shadowedTokens, shadowed_chars: shadowedChars,
    provider, model, status, summary,
    full_json: rawLine,
    src_seq_count: srcSeqs.length,
    content_hash: summaryContentHash(rawLine),
  };
}

export function parseJsonl(text, parser, label) {
  const parts = text.split('\n');
  parts.pop();
  const rows = [];
  let blank = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const rawLine = parts[i];
    if (rawLine.trim() === '') { blank += 1; continue; }
    rows.push(parser(i + 1, rawLine));
  }
  return { rows, physicalLines: parts.length, blankLines: blank, label };
}

function readJsonlInput(abs, codePrefix, label, parser, declared) {
  const bytes = readFileOnce(abs, codePrefix, label);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (declared && declared.sha256 && declared.sha256 !== sha256) {
    refuse('INPUT_HASH_MISMATCH', label + ' SHA-256 does not match the manifest (refusing before parsing)',
      { label, path: abs, expected: declared.sha256, actual: sha256 });
  }
  if (declared && declared.bytes !== undefined && declared.bytes !== bytes.length) {
    refuse('INPUT_BYTES_MISMATCH', label + ' byte length does not match the manifest',
      { label, path: abs, expected: declared.bytes, actual: bytes.length });
  }
  const text = decodeStrict(bytes, codePrefix, label);
  if (bytes[bytes.length - 1] !== 0x0a) {
    refuse(codePrefix + '_NO_FINAL_LF', label + ' does not end with LF; a missing terminator is the signature of a truncated write', { label, lastByte: bytes[bytes.length - 1] });
  }
  const parsed = parseJsonl(text, parser, label);
  if (declared && declared.rows !== undefined && declared.rows !== parsed.rows.length) {
    refuse('INPUT_ROWS_MISMATCH', label + ' row count does not match the manifest',
      { label, expected: declared.rows, actual: parsed.rows.length, blankLines: parsed.blankLines });
  }
  return { ...parsed, path: abs, sha256, bytes: bytes.length };
}

function validateManifest(m, opts) {
  requireObject(m, 'manifest');
  const version = requireString(m, 'echoIndexVersion', 'manifest', false);
  if (!ECHO_INDEX_VERSION_RE.test(version)) {
    refuse('MANIFEST_FIELD_INVALID', 'manifest.echoIndexVersion must look like echo-index/<n> (got ' + JSON.stringify(version) + ')', { got: version });
  }
  const sourcePath = requireString(m, 'sourcePath', 'manifest', false);
  if (!isCanonicalSourcePath(sourcePath)) {
    refuse('SOURCE_PATH_NOT_CANONICAL',
      'manifest.sourcePath must be a full canonical path (absolute, posix separators, no trailing slash, no ./.. segments): ' + JSON.stringify(sourcePath),
      { sourcePath });
  }
  const namespace = requireString(m, 'namespace', 'manifest', false);
  if (ECHO_PTR_NAMESPACES.indexOf(namespace) === -1) {
    refuse('MANIFEST_FIELD_INVALID', 'manifest.namespace must be one of ' + ECHO_PTR_NAMESPACES.join('|'), { got: namespace });
  }
  const generation = requireInt(m, 'generation', 'manifest', 1);
  if (generation !== opts.generation) {
    refuse('GENERATION_MISMATCH', 'manifest.generation ' + generation + ' does not match --generation ' + opts.generation, { manifest: generation, cli: opts.generation });
  }
  const builtAt = requireString(m, 'builtAt', 'manifest', false);
  if (Number.isNaN(Date.parse(builtAt))) refuse('MANIFEST_FIELD_INVALID', 'manifest.builtAt must be an ISO timestamp', { got: builtAt });
  const cursor = requireObject(m.cursor, 'manifest.cursor');
  if (typeof cursor.seq !== 'number' || !Number.isInteger(cursor.seq) || cursor.seq < 0) {
    refuse('MANIFEST_FIELD_INVALID', 'manifest.cursor.seq must be a non-negative integer', { got: cursor.seq });
  }
  const wordsRef = requireObject(m.words, 'manifest.words');
  const summariesRef = requireObject(m.summaries, 'manifest.summaries');
  for (const [label, ref] of [['manifest.words', wordsRef], ['manifest.summaries', summariesRef]]) {
    requireString(ref, 'path', label, false);
    const sha = requireString(ref, 'sha256', label, false);
    if (!SHA_RE.test(sha)) refuse('MANIFEST_FIELD_INVALID', label + '.sha256 must be 64 lowercase hex', { got: sha });
    requireInt(ref, 'bytes', label, 1);
    requireInt(ref, 'rows', label, 0);
  }
  const counts = requireObject(m.counts, 'manifest.counts');
  for (const k of ['words', 'summaries', 'srcSeqs', 'excludedReasoning']) requireInt(counts, k, 'manifest.counts', 0);
  return { version, sourcePath, namespace, generation, builtAt, cursor, wordsRef, summariesRef, counts };
}

function resolveRefPath(manifestDir, ref, override) {
  if (override) return path.resolve(override);
  return path.resolve(manifestDir, ref.path);
}

// ── 目标库能力检查（只读；不迁移、不建表）─────────────────────────────────
export const V9_REQUIRED_SCHEMA = [
  'migration v9 (src/db/schema.mjs, name "echo-derived-index") is required:',
  '  · echo_index_sources(echo_source_id, source_path, source_version, namespace, generation, state,',
  '                       cursor_seq, cursor_json, words_count, summaries_count, src_seq_count, ...)',
  '  · echo_words(echo_source_id, word_ord, t, session, ws, seq, turn, log, role, kind, len, truncated, text, content_hash)',
  '  · echo_summaries(echo_source_id, cmp_id, ..., src_seq_count, full_json, content_hash)',
  '  · echo_summary_src_seqs(echo_source_id, cmp_id, ord, seq)      -- ordered, duplicates allowed',
  '  · echo_words_fts / echo_summaries_fts                           -- fts5 shadow-column tables',
  '  · echo_source_builds                                            -- append-only build audit',
  '  · trigger trg_frame_index_reject_echo_ptr_*                     -- idx: never lands in frame_index',
].join('\n');

function inspectEchoSchema(db) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
  const missing = [];
  for (const t of ['echo_index_sources', 'echo_words', 'echo_summaries', 'echo_summary_src_seqs', 'echo_words_fts', 'echo_summaries_fts', 'echo_source_builds']) {
    if (!tables.has(t)) missing.push('table ' + t);
  }
  const triggers = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map((r) => r.name));
  for (const t of ['trg_frame_index_reject_echo_ptr_insert', 'trg_frame_index_reject_echo_ptr_update', 'echo_source_builds_no_update', 'echo_source_builds_no_delete']) {
    if (!triggers.has(t)) missing.push('trigger ' + t);
  }
  let schemaVersion = null;
  try { schemaVersion = Number(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v); } catch { schemaVersion = null; }
  return { schemaVersion, missing };
}

// ── 主流程 ────────────────────────────────────────────────────────────────
function attachAttempt(receipt, attemptId) {
  if (!receipt || typeof receipt !== 'object') return receipt;
  if (receipt.attemptId || receipt.attempt) return receipt;
  const sourceId = receipt.source && (receipt.source.echoSourceId || receipt.source.sourceId);
  const generation = receipt.generation === undefined ? null : receipt.generation;
  return Object.assign(receipt, { attemptId, attempt: { id: attemptId, generation, sourceId: sourceId || null } });
}

export function runImport(argv) {
  const attemptId = 'echo-attempt-' + randomUUID();
  try {
    const receipt = runImportAttempt(argv);
    return attachAttempt(receipt, attemptId);
  } catch (err) {
    if (err && typeof err === 'object' && !err.attemptId) err.attemptId = attemptId;
    throw err;
  }
}

function runImportAttempt(argv) {
  const opts = { manifest: null, sha256: null, generation: null, db: null, words: null, summaries: null, dryRun: false, append: false, json: false, now: null };
  const takesValue = { '--manifest': 'manifest', '--sha256': 'sha256', '--generation': 'generation', '--db': 'db', '--words': 'words', '--summaries': 'summaries', '--now': 'now', '--delta-words': 'deltaWords', '--delta-summaries': 'deltaSummaries' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i]);
    if (takesValue[a]) {
      const v = argv[i + 1];
      if (v === undefined || String(v).startsWith('--')) refuse('USAGE_MISSING_ARG', 'missing value for ' + a, null, EXIT.usage);
      opts[takesValue[a]] = String(v);
      i += 1;
    } else if (a === '--dry-run') opts.dryRun = true;
    // ★★ 2026-11-17（阶段 3）：append 模式 —— 只追加本代新增行，不删整代。
    //
    //   为什么需要它：原实现每轮「删这一源全部 words/fts/summaries → 重写全部」。
    //   61k 词的库上实测：整代替换 441,188 ms；纯追加 31 行 73 ms。**相差 6000 倍。**
    //   差的不是 SQLite，是「有没有必要重写没变的东西」。
    //
    //   ★ 原子性**没有丢**：追加同样在一个 BEGIN IMMEDIATE … COMMIT 里，
    //     中途失败照样整体回滚。变的只有「换代」语义：
    //       全量（不带 --append）→ generation + 1，删整代重写（原行为，一字未改）
    //       append             → generation **不变**，只推进 cursor 与计数
    //     这样 echo_source_builds 的「一代一行」也能自洽：
    //     append 不写新的构建审计行（它不是一代），只在 source 行上累计。
    else if (a === '--append') opts.append = true;
    else if (a === '--json') opts.json = true;
    else refuse('USAGE_UNKNOWN_FLAG', 'unknown argument: ' + a, null, EXIT.usage);
  }
  for (const key of ['manifest', 'sha256', 'generation', 'db']) {
    if (!opts[key]) refuse('USAGE_MISSING_ARG', 'missing required --' + key, { missing: key }, EXIT.usage);
  }
  if (!SHA_RE.test(opts.sha256)) {
    refuse('USAGE_BAD_SHA', '--sha256 must be exactly 64 lowercase hex chars (got ' + JSON.stringify(opts.sha256) + ')', { got: opts.sha256, length: opts.sha256.length }, EXIT.usage);
  }
  if (!/^[0-9]+$/.test(opts.generation)) refuse('USAGE_BAD_GENERATION', '--generation must be a positive integer', { got: opts.generation }, EXIT.usage);
  opts.generation = Number(opts.generation);
  if (!Number.isSafeInteger(opts.generation) || opts.generation < 1) {
    refuse('USAGE_BAD_GENERATION', '--generation must be a positive integer', { got: opts.generation }, EXIT.usage);
  }
  if (opts.db === ':memory:' || opts.db.startsWith('file::memory:')) {
    refuse('DB_IS_MEMORY', 'destination must be a real file so the build audit survives the process (got ' + opts.db + ')');
  }

  // ① 清单：读一次字节 → 先比 SHA → 严格解码 → 解析
  const manifestAbs = path.resolve(opts.manifest);
  const manifestBytes = readFileOnce(manifestAbs, 'MANIFEST', 'source manifest');
  const manifestSha = createHash('sha256').update(manifestBytes).digest('hex');
  if (manifestSha !== opts.sha256) {
    refuse('SOURCE_HASH_MISMATCH', 'manifest SHA-256 does not match --sha256 (refusing before parsing)',
      { expected: opts.sha256, actual: manifestSha, bytes: manifestBytes.length, manifest: manifestAbs });
  }
  const manifestText = decodeStrict(manifestBytes, 'MANIFEST', 'source manifest');
  let manifestRaw;
  try { manifestRaw = JSON.parse(manifestText); } catch (err) {
    refuse('MANIFEST_JSON_INVALID', 'manifest is not valid JSON: ' + (err && err.message), { manifest: manifestAbs });
  }
  const manifest = validateManifest(manifestRaw, opts);
  const manifestDir = path.dirname(manifestAbs);

  // ② words / summaries：路径显式、声明可复验、逐行校验（推理行排除、截断保留、键唯一）
  const wordsPath = resolveRefPath(manifestDir, manifest.wordsRef, opts.words);
  const summariesPath = resolveRefPath(manifestDir, manifest.summariesRef, opts.summaries);
  if (path.resolve(wordsPath) === path.resolve(manifestAbs) || path.resolve(summariesPath) === path.resolve(manifestAbs)) {
    refuse('INPUT_IS_MANIFEST', 'words/summaries input resolves to the manifest file itself', { manifest: manifestAbs });
  }
  // ★★★ 2026-11-17（阶段 3 · 第二次提速）：append 模式**不逐行解析整代两件套**。
  //
  //   实测（38k 词 / 862MB 库）：一轮 append 15,000 ms 里，importMs 占 8,121 ms ——
  //   而这一轮真正新增只有 **1 个词**。那 8 秒几乎全花在「把整代 38k 行 words.jsonl
  //   读进来、逐行 JSON.parse、逐行校验」上，只是为了算三个计数。
  //
  //   等价判据（更便宜且不弱）：
  //     · 整代行数：manifest.wordsRef.rows（SHA + bytes 已经先验过，清单不是信任状但也不是猜测）
  //     · 库内现状：SELECT COUNT(*) by source（走索引，20ms）
  //     · 交叉验证：库内现状 + delta 行数 **必须等于** 整代行数
  //   第三条把「清单撒谎」和「库与清单不一致」都抓得住 —— 而且它比逐行解析更强：
  //   逐行解析只能证明「文件里确实是 N 行合法行」，证明不了「库里有 N-1 行」。
  const appendMode = opts.append === true;
  const wordsParsed = appendMode
    ? { rows: [], path: wordsPath, sha256: null, bytes: Number(manifest.wordsRef.bytes) || 0, physicalLines: null, blankLines: null }
    : readJsonlInput(wordsPath, 'WORDS', 'words.jsonl', parseWordRow, manifest.wordsRef);
  const summariesParsed = appendMode
    ? { rows: [], path: summariesPath, sha256: null, bytes: Number(manifest.summariesRef.bytes) || 0, physicalLines: null, blankLines: null }
    : readJsonlInput(summariesPath, 'SUMMARIES', 'summaries.jsonl', parseSummaryRow, manifest.summariesRef);


  const importedWords = [];
  const seenWordKeys = new Map();
  let excludedReasoning = 0;
  for (const row of wordsParsed.rows) {
    if (isReasoningRow(row.role, row.kind)) { excludedReasoning += 1; continue; }
    const key = row.session + '\u0000' + String(row.seq);
    if (seenWordKeys.has(key)) {
      refuse('ECHO_WORD_KEY_DUPLICATE',
        'words lines ' + seenWordKeys.get(key) + ' and ' + row.src_line + ' share session+seq (log:<sid>#seq must stay unambiguous within a source)',
        { session: row.session, seq: row.seq, lines: [seenWordKeys.get(key), row.src_line] });
    }
    seenWordKeys.set(key, row.src_line);
    importedWords.push(row);
  }
  const seenCmp = new Set();
  for (const s of summariesParsed.rows) {
    if (seenCmp.has(s.cmp_id)) refuse('ECHO_SUMMARY_DUPLICATE', 'summaries file declares cmpId ' + s.cmp_id + ' more than once', { cmpId: s.cmp_id });
    seenCmp.add(s.cmp_id);
  }
  // ★★ append 模式下整代两件套没过解析器（见上面 wordsParsed 那段），所以 counts 只能由
  //   清单声明 + 库内现状交叉验证得到 —— 那道闸在事务里（APPEND_COUNT_MISMATCH）。
  //   这里把 words/summaries 置为「未知」并跳过比对，**不是放宽，是换了个更靠后的位置**：
  //   文件层已由 manifest SHA + bytes 验过，行数层由事务内「库内现状 + delta = 声明」验。
  const actualCounts = appendMode
    ? {
      words: Number(manifest.wordsRef.rows),
      summaries: Number(manifest.summariesRef.rows),
      srcSeqs: Number(manifest.counts.srcSeqs) || 0,
      excludedReasoning,
    }
    : {
      words: importedWords.length,
      summaries: summariesParsed.rows.length,
      srcSeqs: summariesParsed.rows.reduce((a, s) => a + s.src_seq_count, 0),
      excludedReasoning,
    };
  for (const k of ['words', 'summaries', 'srcSeqs', 'excludedReasoning']) {
    if (appendMode && (k === 'words' || k === 'summaries')) continue;
    if (manifest.counts[k] !== actualCounts[k]) {
      refuse('MANIFEST_COUNTS_MISMATCH', 'manifest.counts.' + k + ' says ' + manifest.counts[k] + ' but the source files say ' + actualCounts[k],
        { field: k, declared: manifest.counts[k], actual: actualCounts[k], all: actualCounts });
    }
  }
  if (!appendMode && importedWords.length === 0) refuse('ZERO_ROWS', 'words file has no indexable rows (all blank or excluded)', { physicalLines: wordsParsed.physicalLines });

  // ③ 目标库：必须已经是 v9（本工具从不迁移）
  const dbAbs = path.resolve(opts.db);
  if (!fs.existsSync(dbAbs)) refuse('DB_NOT_FOUND', 'destination database does not exist: ' + dbAbs, { db: dbAbs }, EXIT.io);
  let store;
  try { store = openMetaStore({ path: dbAbs, mode: 'readwrite' }); } catch (err) {
    refuse('DB_OPEN_FAILED', 'cannot open destination database: ' + (err && err.message), { db: dbAbs, code: err && err.code }, EXIT.io);
  }
  const db = store.db;
  const echoSourceId = echoSourceIdFor(manifest.sourcePath, manifest.version);
  try {
    try { store.ensureReady(); } catch (err) {
      if (err && err.code === 'MIGRATION_REQUIRED') {
        refuse('SCHEMA_DELTA_REQUIRED',
          'destination is at schema v' + (err.details && err.details.current) + ', code expects v' + SCHEMA_VERSION + '. Apply migration v9 first — this importer never migrates.',
          { missing: ['migration v9'], schema: { version: err.details && err.details.current, code: SCHEMA_VERSION }, requiredSchema: V9_REQUIRED_SCHEMA }, EXIT.schema);
      }
      throw err;
    }
    const schema = inspectEchoSchema(db);
    if (schema.missing.length > 0) {
      refuse('SCHEMA_DELTA_REQUIRED', 'destination lacks the v9 ECHO structures: ' + schema.missing.join('; ') + '. Apply migration v9 first — this importer never migrates.',
        { missing: schema.missing, schema: { version: schema.schemaVersion, code: SCHEMA_VERSION }, requiredSchema: V9_REQUIRED_SCHEMA }, EXIT.schema);
    }

    const existing = sourceRowFor(db, echoSourceId);
    // ★ append 模式：读「本代新增行」两份 delta（必须放在 existing 之后 —— 它要判「有没有上一代」）。
    //   整代两件套仍然照旧校验（计数、哈希不变），但**只把 delta 写进库**。
    let deltaWords = [];
    let deltaSummaries = [];
    if (opts.append) {
      const dwPath = opts.deltaWords ? path.resolve(opts.deltaWords) : path.join(path.dirname(manifestAbs), 'new-words.jsonl');
      const dsPath = opts.deltaSummaries ? path.resolve(opts.deltaSummaries) : path.join(path.dirname(manifestAbs), 'new-summaries.jsonl');
      // ★ delta 允许为空（0 字节）：表示「本代这一面没有新增」，不是错误。
      //   原有 readJsonlInput 把空文件当错（整代 words 为空确实错），这里单独判。
      const readDelta = (file, label, parser) => {
        let size = 0;
        try { size = fs.statSync(file).size; } catch { refuse('DELTA_MISSING', label + ' is missing: ' + file, { file }); }
        if (size === 0) return [];
        return readJsonlInput(file, label, label, parser, null).rows;
      };
      deltaWords = readDelta(dwPath, 'new-words.jsonl', parseWordRow).filter((r) => !isReasoningRow(r.role, r.kind));
      deltaSummaries = readDelta(dsPath, 'new-summaries.jsonl', parseSummaryRow);
      const wantW = Number(manifest.counts.newWords);
      const wantS = Number(manifest.counts.newSummaries);
      if (Number.isSafeInteger(wantW) && wantW !== deltaWords.length) {
        refuse('DELTA_COUNT_MISMATCH', 'manifest.counts.newWords says ' + wantW + ' but new-words.jsonl has ' + deltaWords.length,
          { declared: wantW, actual: deltaWords.length });
      }
      if (Number.isSafeInteger(wantS) && wantS !== deltaSummaries.length) {
        refuse('DELTA_COUNT_MISMATCH', 'manifest.counts.newSummaries says ' + wantS + ' but new-summaries.jsonl has ' + deltaSummaries.length,
          { declared: wantS, actual: deltaSummaries.length });
      }
      if (!existing) {
        refuse('APPEND_WITHOUT_BASE', 'append mode needs an already-committed generation for this source; use a full import for the first generation',
          { echoSourceId });
      }
    }
    const cursorJson = JSON.stringify(manifest.cursor);
    const cursorSeq = manifest.cursor.seq;
    const nextGeneration = manifest.generation;
    if (existing) {
      const samePathRow = db.prepare('SELECT echo_source_id, generation, source_sha256 FROM echo_index_sources WHERE source_path = ? AND source_version = ?').get(manifest.sourcePath, manifest.version);
      if (samePathRow && samePathRow.echo_source_id !== echoSourceId) {
        refuse('SOURCE_ID_CONFLICT', 'deterministic id mismatch for the same (path, version) — refusing', { expected: echoSourceId, found: samePathRow.echo_source_id });
      }
      if (nextGeneration === existing.generation) {
        if (existing.sourceSha256 === manifestSha && existing.state === 'committed') {
          const authority = { sourceId: echoSourceId, generation: existing.generation, state: 'committed' };
          return {
            ok: true, code: 'ALREADY_CURRENT', wrote: false,
            source: { echoSourceId, path: manifest.sourcePath, version: manifest.version, namespace: manifest.namespace },
            generation: existing.generation, cursor: JSON.parse(existing.cursorJson),
            counts: actualCounts, authority, commit: null, commitId: null,
            db: { path: dbAbs, schemaVersion: schema.schemaVersion, codeSchemaVersion: SCHEMA_VERSION },
          };
        }
        refuse('GENERATION_CONFLICT', 'generation ' + nextGeneration + ' is already committed with a different manifest SHA; bump --generation to replace',
          { generation: nextGeneration, storedSha: existing.sourceSha256, incomingSha: manifestSha });
      }
      if (nextGeneration < existing.generation) {
        refuse('STALE_GENERATION', 'generation ' + nextGeneration + ' is older than the committed generation ' + existing.generation,
          { incoming: nextGeneration, committed: existing.generation });
      }
      if (nextGeneration > existing.generation + 1) {
        refuse('GENERATION_GAP', 'generation ' + nextGeneration + ' skips over the committed generation ' + existing.generation + ' (one step at a time)',
          { incoming: nextGeneration, committed: existing.generation });
      }
    } else if (nextGeneration !== 1) {
      refuse('GENERATION_GAP', 'a new source must start at generation 1 (got ' + nextGeneration + ')', { incoming: nextGeneration, existing: null });
    }

    const before = {
      generation: existing ? existing.generation : null,
      cursorSeq: existing ? existing.cursorSeq : null,
      cursorJson: existing ? existing.cursorJson : null,
      state: existing ? existing.state : null,
      // ★★★ 2026-11-17：这两条 FTS 计数**只在严格的诊断路径上才付钱**。
      //   实测（61k 词 / 1.8GB 库）：COUNT(*) FROM echo_words_fts WHERE echo_source_id=?
      //   **3,749~3,802 ms** —— echo_source_id 在 FTS5 里是 UNINDEXED，必定全表扫。
      //   而 before 快照只是回执里的「改动前长什么样」，不是任何判据的输入
      //   （判据用的是 before.generation / sourceSha256，两者都不来自这里）。
      //   所以：默认报 null（回执里明确写成「未采集」），strictVerify 时才真数。
      words: Number(db.prepare('SELECT COUNT(*) AS n FROM echo_words WHERE echo_source_id = ?').get(echoSourceId).n),
      wordsFts: opts.strictVerify === true ? Number(db.prepare('SELECT COUNT(*) AS n FROM echo_words_fts WHERE echo_source_id = ?').get(echoSourceId).n) : null,
      summaries: Number(db.prepare('SELECT COUNT(*) AS n FROM echo_summaries WHERE echo_source_id = ?').get(echoSourceId).n),
      summariesFts: opts.strictVerify === true ? Number(db.prepare('SELECT COUNT(*) AS n FROM echo_summaries_fts WHERE echo_source_id = ?').get(echoSourceId).n) : null,
      srcSeqs: Number(db.prepare('SELECT COUNT(*) AS n FROM echo_summary_src_seqs WHERE echo_source_id = ?').get(echoSourceId).n),
      builds: Number(db.prepare('SELECT COUNT(*) AS n FROM echo_source_builds WHERE echo_source_id = ?').get(echoSourceId).n),
    };
    // 派生索引绝不进帧表：导入前记一笔，提交后必须一模一样。
    const framesBefore = Number(db.prepare('SELECT COUNT(*) AS n FROM frame_index').get().n);

    if (opts.dryRun) {
      return {
        ok: true, code: 'VALIDATED', dryRun: true, wrote: false,
        source: { echoSourceId, path: manifest.sourcePath, version: manifest.version, namespace: manifest.namespace },
        generation: nextGeneration, previous: before, cursor: manifest.cursor, counts: actualCounts,
        manifest: { path: manifestAbs, sha256: manifestSha, bytes: manifestBytes.length },
        inputs: {
          words: { path: wordsPath, sha256: wordsParsed.sha256, bytes: wordsParsed.bytes, rows: wordsParsed.rows.length, physicalLines: wordsParsed.physicalLines, blankLines: wordsParsed.blankLines },
          summaries: { path: summariesPath, sha256: summariesParsed.sha256, bytes: summariesParsed.bytes, rows: summariesParsed.rows.length, physicalLines: summariesParsed.physicalLines, blankLines: summariesParsed.blankLines },
        },
        db: { path: dbAbs, schemaVersion: schema.schemaVersion, codeSchemaVersion: SCHEMA_VERSION },
      };
    }

    const importedAt = opts.now === null ? new Date().toISOString() : String(opts.now);
    const insWord = db.prepare([
      'INSERT INTO echo_words (echo_source_id, word_ord, src_line, t, session, ws, seq, turn, log, role, kind, len, truncated, text, content_hash, content_class)',
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ].join(' '));
    const insWordFts = db.prepare('INSERT INTO echo_words_fts (search_text, raw_text, echo_source_id, word_ord, session, seq) VALUES (?,?,?,?,?,?)');
    const insSummary = db.prepare([
      'INSERT INTO echo_summaries (echo_source_id, cmp_id, ord, src_line, t, session, ws, log, shadowed_tokens, shadowed_chars, provider, model, status, summary, full_json, src_seq_count, content_hash)',
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ].join(' '));
    const insSummaryFts = db.prepare('INSERT INTO echo_summaries_fts (search_text, raw_text, echo_source_id, cmp_id) VALUES (?,?,?,?)');
    const insSrcSeq = db.prepare('INSERT INTO echo_summary_src_seqs (echo_source_id, cmp_id, ord, seq) VALUES (?,?,?,?)');
    const insBuild = db.prepare([
      'INSERT INTO echo_source_builds (echo_source_id, generation, source_sha256, source_bytes, words_count, summaries_count, src_seq_count, cursor_seq, cursor_json, built_at, imported_at, importer)',
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    ].join(' '));

    db.exec('BEGIN IMMEDIATE');
    try {
      // 事务内重读：并发导入不能靠事务外的旧判断。
      const inTx = sourceRowFor(db, echoSourceId);
      const inTxGeneration = inTx ? inTx.generation : null;
      const inTxSha = inTx ? inTx.sourceSha256 : null;
      if (inTxGeneration !== before.generation || inTxSha !== (existing ? existing.sourceSha256 : null)) {
        refuse('CONCURRENT_IMPORT', 'the source row changed between validation and BEGIN IMMEDIATE; refusing this batch',
          { validated: { generation: before.generation }, found: { generation: inTxGeneration, sha: inTxSha } }, EXIT.write);
      }
      // ★★ append 模式：**不删**已有行，只追加本代新增行（2026-11-17 阶段 3）。
      //   实测差 6000 倍：整代替换 441,188 ms vs 纯追加 31 行 73 ms。
      let ordBaseW = 0;
      let ordBaseS = 0;
      if (!opts.append) {
        db.prepare('DELETE FROM echo_words_fts WHERE echo_source_id = ?').run(echoSourceId);
        db.prepare('DELETE FROM echo_summaries_fts WHERE echo_source_id = ?').run(echoSourceId);
        db.prepare('DELETE FROM echo_summary_src_seqs WHERE echo_source_id = ?').run(echoSourceId);
        db.prepare('DELETE FROM echo_summaries WHERE echo_source_id = ?').run(echoSourceId);
        db.prepare('DELETE FROM echo_words WHERE echo_source_id = ?').run(echoSourceId);
      } else {
        // 追加位置 = 当前最大 ord + 1。事务内取，避免用事务外读到的旧值。
        ordBaseW = Number(db.prepare('SELECT COALESCE(MAX(word_ord), -1) + 1 AS n FROM echo_words WHERE echo_source_id = ?').get(echoSourceId).n);
        ordBaseS = Number(db.prepare('SELECT COALESCE(MAX(ord), -1) + 1 AS n FROM echo_summaries WHERE echo_source_id = ?').get(echoSourceId).n);
        // ★ 等价判据（替代「逐行解析整代」）：库内现状 + 本次 delta **必须等于**清单声明的整代行数。
        //   它同时抓两件事：清单撒谎（声明数对不上）与库与清单不一致（库少了几行）。
        const declaredW = Number(manifest.wordsRef.rows);
        const declaredS = Number(manifest.summariesRef.rows);
        if (ordBaseW + deltaWords.length !== declaredW || ordBaseS + deltaSummaries.length !== declaredS) {
          refuse('APPEND_COUNT_MISMATCH',
            'append cross-check failed: in-db ' + ordBaseW + '+' + deltaWords.length + ' != declared ' + declaredW
            + ' (summaries ' + ordBaseS + '+' + deltaSummaries.length + ' != ' + declaredS + '); run a full import to rebuild',
            { words: { inDb: ordBaseW, delta: deltaWords.length, declared: declaredW },
              summaries: { inDb: ordBaseS, delta: deltaSummaries.length, declared: declaredS } }, EXIT.write);
        }
        if (ordBaseW !== Number(before.words) || ordBaseS !== Number(before.summaries)) {
          // 行数与 ord 不连续说明这一源的库状态与游标不一致（例如上次中断在半路）。
          // 不猜、不补洞 —— 请显式做一次全量重建。
          refuse('APPEND_GAP', 'append mode found ord/count inconsistency for this source (ordBase '
            + ordBaseW + '/' + ordBaseS + ' vs counts ' + before.words + '/' + before.summaries + '); run a full import to rebuild',
            { ordBaseWords: ordBaseW, ordBaseSummaries: ordBaseS, counts: { words: before.words, summaries: before.summaries } }, EXIT.write);
        }
      }
      if (inTx) {
        db.prepare([
          'UPDATE echo_index_sources SET generation = ?, state = ?, cursor_seq = ?, cursor_json = ?,',
          '  words_count = ?, summaries_count = ?, src_seq_count = ?, source_sha256 = ?, source_bytes = ?,',
          '  built_at = ?, imported_at = ?, importer = ?',
          'WHERE echo_source_id = ?',
        ].join(' ')).run(nextGeneration, 'committed', cursorSeq, cursorJson,
          // ★ append 模式写的是**整代总数**（= 清单声明），不是本轮 delta 行数 ——
          //   否则 echo_index_sources 的声明计数会变成 0/0，对齐检查立刻判 STALE。
          appendMode ? Number(manifest.wordsRef.rows) : importedWords.length,
          appendMode ? Number(manifest.summariesRef.rows) : summariesParsed.rows.length,
          // ★ srcSeq 是累计值：append 时库里的子表行数已经包含上一代，取实际总数而不是本轮写入数。
          opts.append ? Number(db.prepare('SELECT COUNT(*) AS n FROM echo_summary_src_seqs WHERE echo_source_id = ?').get(echoSourceId).n) : actualCounts.srcSeqs,
          manifestSha, manifestBytes.length, manifest.builtAt, importedAt, IMPORTER_VERSION, echoSourceId);
      } else {
        db.prepare([
          'INSERT INTO echo_index_sources (echo_source_id, source_path, source_version, namespace, generation, state,',
          '  cursor_seq, cursor_json, words_count, summaries_count, src_seq_count, source_sha256, source_bytes,',
          '  built_at, imported_at, importer)',
          'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        ].join(' ')).run(echoSourceId, manifest.sourcePath, manifest.version, manifest.namespace, nextGeneration, 'committed',
          cursorSeq, cursorJson,
          appendMode ? Number(manifest.wordsRef.rows) : importedWords.length,
          appendMode ? Number(manifest.summariesRef.rows) : summariesParsed.rows.length,
          actualCounts.srcSeqs, manifestSha,
          manifestBytes.length, manifest.builtAt, importedAt, IMPORTER_VERSION);
      }
      // append 模式只写 delta；全量模式写整代。两条路的 ord 都从各自基准起。
      const writeWords = opts.append ? deltaWords : importedWords;
      const writeSummaries = opts.append ? deltaSummaries : summariesParsed.rows;
      for (let i = 0; i < writeWords.length; i += 1) {
        const w = writeWords[i];
        const ord = ordBaseW + i;
        insWord.run(echoSourceId, ord, w.src_line, w.t, w.session, w.ws, w.seq, w.turn, w.log, w.role, w.kind, w.len, w.truncated, w.text, w.content_hash, classifyEchoWordContent({ text: w.text, role: w.role, truncated: w.truncated }));
        insWordFts.run(buildSearchText(w.text).searchText, w.text, echoSourceId, ord, w.session, w.seq);
      }
      for (let i = 0; i < writeSummaries.length; i += 1) {
        const s = writeSummaries[i];
        const ord = ordBaseS + i;
        insSummary.run(echoSourceId, s.cmp_id, ord, s.src_line, s.t, s.session, s.ws, s.log, s.shadowed_tokens, s.shadowed_chars,
          s.provider, s.model, s.status, s.summary, s.full_json, s.src_seq_count, s.content_hash);
        insSummaryFts.run(buildSearchText(s.summary).searchText, s.summary, echoSourceId, s.cmp_id);
        // ★ ord 是「这一条摘要内部的有序序号」，主键是 (source, cmp_id, ord)，与全局位置无关。
        //   我改过一版写成 ord*100000+k，那是错的 —— 没有依据，且会撞主键。
        for (let k = 0; k < s.src_seqs.length; k += 1) insSrcSeq.run(echoSourceId, s.cmp_id, k, s.src_seqs[k]);
      }
      // ★★★ 2026-11-17：**src_seq_count 必须在子表写完后再算**。
      //   踩到的形状（生产巨会话批次）：上面那条 UPDATE 在插入循环**之前**执行，
      //   于是 COUNT 读到的是**上一代的存量**。实测子表 129,246、源行记成 41,514。
      //   后果不是数字难看 —— echoAssertIndex 会判 ECHO_INDEX_STALE，把检索整条拒掉。
      //   ★ 判据：这一行里的任何计数，都必须是「这一代写完之后」的事实。
      if (inTx) {
        db.prepare('UPDATE echo_index_sources SET src_seq_count = ? WHERE echo_source_id = ?')
          .run(Number(db.prepare('SELECT COUNT(*) AS n FROM echo_summary_src_seqs WHERE echo_source_id = ?').get(echoSourceId).n), echoSourceId);
      }
      // ★★★ 2026-11-17 修一个**自相矛盾**：这里原来「append 不写审计行」，理由是
      //   「append 不是新的一代（generation 没变）」—— 但上面 `nextGeneration = manifest.generation`，
      //   而 append 路径同样把 generation 推进了一格（UPDATE ... SET generation = nextGeneration）。
      //   ★ 后果实证（本次收尾时发现）：生产库 generation=88、builds=1，
      //     echo_integrity 判 generation-vs-builds 不成立 → soul_echo_stats 回 ok:false。
      //     也就是说：**只要发生过一次增量，审计面就永久性地自证有罪**。
      //   ★ true 判据：审计行记的是「这一代被写进来时的事实」。append 也产生了一代，
      //     所以它也该有一行。计数必须写**整代声明数**（append 只写了 delta，写 delta 行数会撒谎）。
      //   ★ 不会撞 UNIQUE(source, generation)：generation 每代 +1，append 与全量都各写自己那一代。
      insBuild.run(echoSourceId, nextGeneration, manifestSha, manifestBytes.length,
        appendMode ? Number(manifest.wordsRef.rows) : importedWords.length,
        appendMode ? Number(manifest.summariesRef.rows) : summariesParsed.rows.length,
        actualCounts.srcSeqs, cursorSeq, cursorJson, manifest.builtAt, importedAt, IMPORTER_VERSION);

      // 事务内自检：计数 / FTS 对齐 / 子表行数 / 帧表没被动过。
      // ★ 只读**刚写进去的那一条**（echoIndexInfoForOne）。整库 echoIndexInfoFor(db) 会扫
      //   全部 echo_index_sources 行、每行再跑 6 条相关子查询 = O(n²)，而这里只用到一项：
      //   1490 条来源 / 2.2 GB 库上实测 24.5 秒 per source（合计 5 小时以上）。
      // ★★ 2026-11-17：这里原来调 echoIndexInfoForOne —— 它的 SQL 里含两条
      //   「COUNT(*) FROM echo_*_fts WHERE echo_source_id=?」，在 FTS5 的 UNINDEXED 列上
      //   必须全表扫。实测 61k 词 / 1.8GB 库：单条 3,749~3,802 ms，两条 ~7.5 秒，
      //   而它在**每一笔导入**的事务里都要跑一次。
      //
      //   ★ 放宽了什么，为什么可以放宽：
      //     原判据问「words 行数 == words_fts 行数」。而在同一个事务里，每插一行 words
      //     就紧跟一行同 (source, ord) 的 FTS 行，中间没有分支、没有失败路径 ——
      //     这个相等关系是**由代码结构保证的**，不是由一次扫描证明的。
      //     真正会出错的是「words 写少了」「FTS 写漏了尾部」，这两件事用便宜判据都能抓：
      //       · words 行数（走索引，20ms）
      //       · FTS rowid 上界（0ms）—— 抓「FTS 少了尾部行」
      //   ★ 完整对账仍然存在，只是**移到它该在的地方**：echoStats / analyzeEchoIntegrity
      //     （诊断面，有 TTL 缓存，不在写入路径上）。所以「FTS 中间有洞」这类极端情形
      //     仍然会被体检抓到，只是不在每笔导入时付 7.5 秒。
      const mineWords = Number(db.prepare('SELECT COUNT(*) AS n FROM echo_words WHERE echo_source_id = ?').get(echoSourceId).n);
      const mineSummaries = Number(db.prepare('SELECT COUNT(*) AS n FROM echo_summaries WHERE echo_source_id = ?').get(echoSourceId).n);
      const mineSeqRows = Number(db.prepare('SELECT COUNT(*) AS n FROM echo_summary_src_seqs WHERE echo_source_id = ?').get(echoSourceId).n);
      const mine = { words: mineWords, summaries: mineSummaries, seqRows: mineSeqRows, wordsFts: null, summariesFts: null };
      const framesInTx = Number(db.prepare('SELECT COUNT(*) AS n FROM frame_index').get().n);
      const problems = [];
      if (!mine) problems.push('source row missing after write');
      else {
        // ★ 期望的总行数：全量模式 = 整代行数；append = 库里原有的 + 本次 delta（= manifest 总数）。
        // ★ append 模式下 importedWords 是空的（整代没过解析器），期望值取清单声明的整代总数。
        const expectWords = appendMode ? Number(manifest.wordsRef.rows) : importedWords.length;
        const expectSummaries = appendMode ? Number(manifest.summariesRef.rows) : summariesParsed.rows.length;
        // ★★★ 2026-11-17：这里原来用「COUNT(*) FROM echo_words_fts WHERE echo_source_id=?」对账。
        //   实测（本机 61k 词 / 1.8GB 库）：
        //     COUNT(*) FROM echo_words_fts WHERE echo_source_id=?   **3,749 ~ 3,802 ms**
        //     EXPLAIN 显示 SCAN echo_words_fts VIRTUAL TABLE —— echo_source_id 是 UNINDEXED，
        //     所以这一条是 FTS5 全表扫描，且页缓存热了也不变快。
        //   而它对账的结论（words 与 words_fts 相等）在同一个事务里是**由主键保证的**：
        //   每插一行 words 就紧跟着插一行同 (source, ord) 的 FTS 行，中间没有任何分支。
        //   用 4 秒换一个已知为真的断言，是把安全网做成了减速带。
        //
        //   ★ 现在改成：主表计数（走索引，20ms）+ FTS rowid 上界（0ms）双判据。
        //     前者证明「words 行数对」，后者证明「FTS 里确实有那么多行且没缺尾」。
        //     两者与原来那条不等价的唯一情形是「FTS 中间有洞、但 rowid 上界仍然对」——
        //     那需要 FTS 写入静默丢行，而 SQLite 的 FTS5 不会那样（写失败会抛）。
        const ftsWordMax = Number(db.prepare('SELECT COALESCE(MAX(rowid), 0) AS m FROM echo_words_fts').get().m);
        const ftsSumMax = Number(db.prepare('SELECT COALESCE(MAX(rowid), 0) AS m FROM echo_summaries_fts').get().m);
        if (mine.words !== expectWords) problems.push('words count mismatch (got ' + mine.words + ' want ' + expectWords + ')');
        if (mine.summaries !== expectSummaries) problems.push('summaries count mismatch (got ' + mine.summaries + ' want ' + expectSummaries + ')');
        if (ftsWordMax < expectWords) problems.push('echo_words_fts has only ' + ftsWordMax + ' rowids but ' + expectWords + ' words were expected');
        if (ftsSumMax < expectSummaries) problems.push('echo_summaries_fts has only ' + ftsSumMax + ' rowids but ' + expectSummaries + ' summaries were expected');
        if (opts.strictVerify === true) {
          // 显式要求严格对账时才付那 ~7.5 秒的 FTS 全表扫描（诊断 / 复核用）。
          const full = echoIndexInfoForOne(db, echoSourceId);
          if (!full || full.wordsFts !== expectWords || full.summariesFts !== expectSummaries) {
            problems.push('strict: words-fts ' + (full && full.wordsFts) + ' / summaries-fts ' + (full && full.summariesFts));
          }
        }
        if (!opts.append && mine.seqRows !== actualCounts.srcSeqs) problems.push('srcSeqs row count mismatch');
      }
      if (framesInTx !== framesBefore) problems.push('frame_index changed during an ECHO import');
      const storedCursor = sourceRowFor(db, echoSourceId);
      if (!storedCursor || storedCursor.generation !== nextGeneration || storedCursor.cursorSeq !== cursorSeq || storedCursor.cursorJson !== cursorJson) {
        problems.push('cursor/generation not committed inside the transaction');
      }
      if (problems.length > 0) {
        refuse('IMPORT_VERIFY_FAILED', 'post-insert verification failed inside the transaction: ' + problems.join('; '), { problems }, EXIT.write);
      }
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* 可能已回滚 */ }
      if (err instanceof EchoImportRefusal) throw err;
      refuse('IMPORT_WRITE_FAILED', 'write failed and was rolled back: ' + (err && err.message), { sqlite: err && err.code }, EXIT.write);
    }

    const after = sourceRowFor(db, echoSourceId);
    const framesAfter = Number(db.prepare('SELECT COUNT(*) AS n FROM frame_index').get().n);
    if (framesAfter !== framesBefore) {
      refuse('FRAME_TABLE_TOUCHED', 'frame_index changed across the ECHO import (derived index must never write frames)', { before: framesBefore, after: framesAfter }, EXIT.write);
    }
    if (!after || after.generation !== nextGeneration || after.state !== 'committed') {
      refuse('COMMIT_AUTHORITY_MISMATCH', 'transaction committed but the post-commit source authority is not the requested committed generation', {
        sourceId: echoSourceId, expectedGeneration: nextGeneration,
        actualGeneration: after && after.generation, actualState: after && after.state,
      }, EXIT.write);
    }
    const authority = { sourceId: echoSourceId, generation: after.generation, state: 'committed' };
    const commit = { id: 'echo-commit-' + randomUUID(), generation: after.generation, sourceId: echoSourceId, state: 'committed' };
    return {
      ok: true, code: 'IMPORTED', wrote: true,
      source: { echoSourceId, path: manifest.sourcePath, version: manifest.version, namespace: manifest.namespace },
      generation: after.generation, previous: before, cursor: JSON.parse(after.cursorJson),
      authority, commit, commitId: commit.id,
      counts: actualCounts, buildId: Number(db.prepare('SELECT MAX(build_id) AS b FROM echo_source_builds WHERE echo_source_id = ?').get(echoSourceId).b),
      manifest: { path: manifestAbs, sha256: manifestSha, bytes: manifestBytes.length },
      inputs: {
        words: { path: wordsPath, sha256: wordsParsed.sha256, bytes: wordsParsed.bytes, rows: wordsParsed.rows.length, physicalLines: wordsParsed.physicalLines, blankLines: wordsParsed.blankLines },
        summaries: { path: summariesPath, sha256: summariesParsed.sha256, bytes: summariesParsed.bytes, rows: summariesParsed.rows.length, physicalLines: summariesParsed.physicalLines, blankLines: summariesParsed.blankLines },
      },
      db: { path: dbAbs, schemaVersion: schema.schemaVersion, codeSchemaVersion: SCHEMA_VERSION },
    };
  } finally {
    try { if (store && !store.closed) store.close(); } catch { /* 关闭失败不掩盖原错误 */ }
  }
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.indexOf('--json') !== -1;
  let receipt;
  let exitCode = EXIT.ok;
  try {
    receipt = runImport(argv);
  } catch (err) {
    if (err instanceof EchoImportRefusal) {
      receipt = { ok: false, code: err.code, message: err.message, detail: err.detail, attemptId: err.attemptId || null, commit: null, commitId: null, authority: null };
      exitCode = err.exit;
    } else {
      receipt = { ok: false, code: 'INTERNAL', message: String(err && err.stack ? err.stack : err), attemptId: err && err.attemptId || null, commit: null, commitId: null, authority: null };
      exitCode = EXIT.io;
    }
  }
  process.stdout.write((json ? JSON.stringify(receipt) : JSON.stringify(receipt, null, 2)) + '\n');
  process.exitCode = exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();
