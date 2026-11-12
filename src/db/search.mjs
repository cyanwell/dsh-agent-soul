// src/db/search.mjs —— P1b 的检索面：CJK bigram 生成、查询串同变换、候选预筛 + 原文子串核实。
//
// ★★ 唯一的对外语义（P1b 返修定案，2026-11-09）：
//   一条帧命中当且仅当 raw_text.toLowerCase().includes(query.trim().toLowerCase())。
//   没有任何模式可以少命中、也没有任何模式可以多命中 —— 预筛只允许是**超集**，
//   最终判定永远由 containsNeedle() 对着 raw_text 逐条做。
//
// 为什么不是「给 FTS5 一个中文分词器」：
//   默认 unicode61 / trigram 都不当中文通解。unicode61 把一整串汉字当成**一个** token
//   （「解耦机制」是一个 token，搜「解耦」永远不命中）；trigram 只适合 ≥3 字的模式，
//   二字词（解耦/哨兵）在默认配置下直接失效。所以中文走**重叠二字 bigram**。
//
// 为什么非 CJK 不再走 FTS 预筛（这是本轮返修的核心）：
//   unicode61 的 token 是**整词**。查询「8f3a」、正文「8f3a2c」时，整词 token 是
//   「8f3a2c」≠「8f3a」，FTS 交回 0 个候选，后面的 raw 核实**根本没机会跑** ——
//   于是 P1 查不到 v4-P1b-实现、couple 查不到 Decouple、makeStream 查不到
//   makeStreamFingerprint、7eff99 查不到 session-7eff99a7。这些不是边角，是这个库
//   最常用的查法（版本号前缀、hash 前六位、session id 中段、驼峰词根）。
//   整词 FTS 对子串语义**不是超集**，所以非 CJK / 纯 token / mixed 一律不走它：
//   直接按 rowid 分批扫 raw_text，逐条 containsNeedle。慢，但语义只有一个。
//
// 为什么 CJK 仍可以用 bigram 预筛：任意一个长度 ≥2 的 CJK 连续子串，它的每一对
//   相邻二字都必然出现在正文的 bigram 流里 —— bigram AND 是子串语义的**超集**。
//   超集只保证「候选里可能有真命中」，所以仍需逐条 raw 核实（跨位置假阳性：
//   正文「六层解码后缓冲解耦机制」的 bigrams 含 六层/层解/解耦，但「六层解耦」四字不连续）。
//
// ★ 候选永不截断（P1b 返修定案，P1c 保留）：
//   扫描一直进行到「取够 limit 条真命中」或「候选耗尽」为止。limit 只限制**返回条数**，
//   绝不限制**被检查的候选数** —— 只要有一批候选被跳过，就存在「真命中被静默丢掉」。
//   返回里的 candidatesTruncated 恒为 false，它是**历史兼容字段**：旧调用方可能读它，
//   但任何实现都不能再让它变成 true，也不许拿它当漏报的理由（见 T49–T51）。
//
// ★★ 索引闸（P1c）：searchFrames 在扫描之前先比对 frame_index 与 frame_fts 的行集合。
//   不一致（缺行 / 孤儿行）时**直接报 SEARCH_INDEX_STALE**，不返回一份「看着正常、
//   实际少帧」的结果 —— 两条扫描路径都 join frame_fts，缺一行就等于那一帧消失在结果里，
//   而调用方没有任何信号。修复面是 store.rebuildSearchIndex()。
//   代价说明：每次查询多做 4 个 count(*)（frames / ftsRows / 孤儿 / 缺失），
//   在这个库的体量下是常数开销；换来的是「漏召回不会静默」。
//
// ★ exhausted 是**保守**语义（P1b 定点验证 O1，P1c 写清）：
//   true  = 候选流已经扫到底（这一轮的真命中全部取到了）
//   false = **不知道**（取够 limit 提前停，或扫描还没到底）
//   也就是说 false 不等于「后面还有」，更不等于「已经漏了」；它只表示「没有证明完整」。
//   要证明完整：把 limit 放大到 ≥ 真命中数再查一次，此时 exhausted 必然为 true。

import { fail, CODES } from './errors.mjs';

// 索引列名与分词器口径集中在这里：迁移 SQL、ingest、查询三处必须一致，
// 任何一处单独改都会让「写得进去、查不出来」。
export const FTS_TABLE = 'frame_fts';
export const FTS_TOKENIZER = 'unicode61 remove_diacritics 0';
export const SEARCH_MODES = Object.freeze(['empty', 'substring', 'bigram', 'token', 'mixed']);
export const SEARCH_QUERY_MAX = 512;
export const SEARCH_LIMIT_MAX = 500;

// 每次往返取多少行参与核实。它只影响往返次数，**不影响是否能命中** ——
// 扫不到底就再取一批，直到取够 limit 或候选耗尽。
export const SEARCH_BATCH_SIZE = 200;

// CJK 判定：汉字（含扩展 A / 兼容 / 扩展 B 以上）+ 假名 + 谚文。
// 只影响「怎么切 token」；不在这个集合里的字母走整词路径，不会被丢掉。
const CJK_RANGES = Object.freeze([
  [0x2e80, 0x2eff],
  [0x3005, 0x3007],
  [0x3040, 0x30ff],
  [0x31f0, 0x31ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xf900, 0xfaff],
  [0xac00, 0xd7af],
  [0x1100, 0x11ff],
  [0x20000, 0x2fa1f],
]);

const WORD_CHAR_RE = /[\p{L}\p{N}_]/u;
const BIGRAM = 'bigram';
const WORD = 'word';

export function isCjkCodePoint(cp) {
  for (const range of CJK_RANGES) {
    if (cp >= range[0] && cp <= range[1]) return true;
  }
  return false;
}

export function isCjkChar(ch) {
  const cp = ch.codePointAt(0);
  return cp === undefined ? false : isCjkCodePoint(cp);
}

function isWordChar(ch) {
  return WORD_CHAR_RE.test(ch);
}

// 文本 → { searchText, tokens }。tokens 是 [{ t, kind }]，kind = 'bigram' | 'word'。
// searchText 是空格分隔的 token 串（写进 frame_fts.search_text，参与 MATCH）。
export function buildSearchText(text) {
  const src = text === undefined || text === null ? '' : String(text);
  const tokens = [];
  let run = '';
  let runCjk = false;

  const flush = function () {
    if (run.length === 0) return;
    if (runCjk) {
      const chars = Array.from(run);
      // 单字不造 bigram：它进不了索引，只能靠 raw_text 子串兜底（见文件头）。
      for (let i = 0; i + 1 < chars.length; i += 1) {
        tokens.push({ t: chars[i] + chars[i + 1], kind: BIGRAM });
      }
    } else {
      tokens.push({ t: run.toLowerCase(), kind: WORD });
    }
    run = '';
  };

  for (const ch of src) {
    if (isWordChar(ch)) {
      const cjk = isCjkChar(ch);
      if (run.length > 0 && cjk !== runCjk) flush();
      runCjk = cjk;
      run += ch;
    } else {
      flush();
    }
  }
  flush();

  return { searchText: tokens.map(function (x) { return x.t; }).join(' '), tokens };
}

// FTS5 的 MATCH 表达式只由我们自己生成的 token 拼，用户输入永远不直接进语法。
// 每个 token 都用双引号包住：ASCII 的 AND/OR/NOT/NEAR/*/( ) 于是都只是普通词。
function quoteToken(token) {
  return '"' + token.replace(/"/g, '""') + '"';
}

export function buildMatchExpression(tokens) {
  return tokens.map(function (x) { return quoteToken(x.t); }).join(' ');
}

// 查询串 → 检索计划。这是查询侧唯一的变换入口，和 buildSearchText 是同一份实现。
// matchMode 只用于解释/断言「这条查询走了哪条预筛路径」，**不改变最终语义**：
// 只有 matchMode === 'bigram' 才允许用 FTS 当超集预筛，其余一律走 raw 扫描。
export function buildQueryPlan(query) {
  if (typeof query !== 'string') {
    fail(CODES.INVALID_INPUT, 'search query must be a string', { type: typeof query });
  }
  const needle = query.trim();
  if (needle.length === 0) {
    return { query, needle, matchMode: 'empty', tokens: [], expression: null };
  }
  if (needle.length > SEARCH_QUERY_MAX) {
    fail(CODES.INVALID_INPUT, 'search query is too long (max ' + SEARCH_QUERY_MAX + ' chars)', { length: needle.length, max: SEARCH_QUERY_MAX });
  }

  const built = buildSearchText(needle);
  const hasBigram = built.tokens.some(function (x) { return x.kind === BIGRAM; });
  const hasWord = built.tokens.some(function (x) { return x.kind === WORD; });
  let matchMode;
  if (!hasBigram && !hasWord) {
    // 纯标点/纯符号：造不出任何 token（例如「」或 ---），退化为子串。
    matchMode = 'substring';
  } else if (hasBigram && hasWord) {
    matchMode = 'mixed';
  } else if (hasBigram) {
    matchMode = 'bigram';
  } else {
    matchMode = 'token';
  }

  return {
    query,
    needle,
    matchMode,
    tokens: built.tokens,
    expression: built.tokens.length === 0 ? null : buildMatchExpression(built.tokens),
  };
}

// 最终判定：整串子串（大小写不敏感）。所有模式共用这一条，语义只有一个。
export function containsNeedle(rawText, needle) {
  return String(rawText === undefined || rawText === null ? '' : rawText)
    .toLowerCase()
    .indexOf(String(needle).toLowerCase()) !== -1;
}

// CJK 预筛（只对 bigram 模式启用）：bigram AND 是子串语义的超集，按 bm25 排序分批取，
// 每批都逐条 raw 核实。offset 分页保证「候选耗尽」一定看得见，不会被取回上限截断。
const MATCH_BATCH_SQL = [
  'select f.ptr as ptr, f.source_id as source_id, f.session_id as session_id, f.seq as seq,',
  '       f.snippet as snippet, frame_fts.raw_text as raw_text, bm25(frame_fts) as score',
  'from frame_fts join frame_index f on f.rowid = frame_fts.rowid',
  'where frame_fts match ?',
  '  and (? is null or f.source_id = ?)',
  '  and (? is null or f.session_id = ?)',
  'order by score, f.source_id, f.session_id, f.seq',
  'limit ? offset ?',
].join(' ');

// 非 CJK / mixed / 纯标点：直接读 raw_text（keyset 分页，按 rowid 稳定推进）。
// 按 rowid 而不是 offset 分页：offset 分页在并发写入时可能跳行，keyset 不会。
const RAW_BATCH_SQL = [
  'select f.rowid as rid, f.ptr as ptr, f.source_id as source_id, f.session_id as session_id,',
  '       f.seq as seq, f.snippet as snippet, frame_fts.raw_text as raw_text',
  'from frame_fts join frame_index f on f.rowid = frame_fts.rowid',
  'where f.rowid > ?',
  '  and (? is null or f.source_id = ?)',
  '  and (? is null or f.session_id = ?)',
  'order by f.rowid',
  'limit ?',
].join(' ');

function clampLimit(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 50;
  const n = Math.floor(value);
  if (n < 1) return 1;
  return n > SEARCH_LIMIT_MAX ? SEARCH_LIMIT_MAX : n;
}

function parseFilters(filters) {
  const f = filters || {};
  const sourceId = f.sourceId === undefined || f.sourceId === null ? null : String(f.sourceId);
  const sessionId = f.sessionId === undefined || f.sessionId === null ? null : String(f.sessionId);
  return { sourceId, sessionId };
}

function pushResult(out, row, plan, score) {
  out.results.push({
    ptr: row.ptr,
    sourceId: row.source_id,
    sessionId: row.session_id,
    seq: row.seq,
    snippet: row.snippet,
    rawText: row.raw_text,
    score: score === undefined ? null : score,
    matchMode: plan.matchMode,
  });
}

// 索引一致性探针：唯一的实现。store.searchIndexInfo() 与 searchFrames 的闸都调它，
// 所以「什么算对齐」只有一条定义（frames / ftsRows / 孤儿行 / 缺失行）。
export function searchIndexInfoFor(db) {
  const frames = db.prepare('select count(*) as n from frame_index').get().n;
  const ftsRows = db.prepare('select count(*) as n from frame_fts').get().n;
  const orphanFtsRows = db.prepare('select count(*) as n from frame_fts where rowid not in (select rowid from frame_index)').get().n;
  const framesWithoutFts = db.prepare('select count(*) as n from frame_index where rowid not in (select rowid from frame_fts)').get().n;
  return { frames, ftsRows, orphanFtsRows, framesWithoutFts, aligned: orphanFtsRows === 0 && framesWithoutFts === 0 };
}

// 闸：不一致就直接抛，绝不返回一份不完整的结果。
export function assertSearchIndexAligned(db, info) {
  const i = info || searchIndexInfoFor(db);
  if (i.aligned) return i;
  fail(CODES.SEARCH_INDEX_STALE,
    'search index is out of sync with frame_index (orphanFtsRows=' + i.orphanFtsRows + ', framesWithoutFts=' + i.framesWithoutFts
    + '); every scan path joins frame_fts, so missing rows would silently disappear from results. Run store.rebuildSearchIndex() and retry.',
    { index: i, hint: 'store.rebuildSearchIndex() re-inserts one FTS row per frame_index row; a second call is a no-op' });
  return i;
}

// searchFrames(db, query, { limit, sourceId, sessionId })
//
// 前置：frame_fts 与 frame_index 必须对齐，否则抛 SEARCH_INDEX_STALE（见文件头「索引闸」）。
//
// 返回：
//   matchMode            'empty' | 'substring' | 'bigram' | 'token' | 'mixed'（解释用，语义唯一）
//   needle               实际用于核实的串（trim 后）
//   tokens               查询串切出来的 token（可解释、可断言）
//   scanPath             'bigram-fts'（CJK 超集预筛）| 'raw-scan'（非 CJK 直接扫 raw）
//   index                查询前的索引计数（frames/ftsRows/孤儿/缺失，aligned 恒为 true）
//   candidates           预筛/扫描**检查过**的候选行数（未核实；假阳性死在这之后）
//   candidatesTruncated  恒为 false（历史兼容字段：候选永不截断，见文件头）
//   scanned              实际读过的行数（= candidates，保留更直白的名字）
//   batches              批次往返次数（证明「按批扫、不是只扫一批」）
//   exhausted            true = 候选流已扫到底（完整）；false = **未证明完整**（提前停，不是「还有」）
//   verifiedBy           恒为 'raw_text:substring' —— 最终判定只有这一条
//   results              [{ ptr, sourceId, sessionId, seq, snippet, rawText, score, matchMode }]
export function searchFrames(db, query, options) {
  const o = options || {};
  const limit = clampLimit(o.limit);
  const filters = parseFilters(o);
  // 先校验查询串（非法输入优先报 INVALID_INPUT），再验索引，最后才扫描。
  const plan = buildQueryPlan(query);
  const index = assertSearchIndexAligned(db);

  const out = {
    query: plan.query,
    needle: plan.needle,
    matchMode: plan.matchMode,
    tokens: plan.tokens.map(function (x) { return x.t; }),
    tokenKinds: plan.tokens.map(function (x) { return x.kind; }),
    scanPath: plan.matchMode === 'bigram' ? 'bigram-fts' : 'raw-scan',
    index,
    candidates: 0,
    candidatesTruncated: false,
    scanned: 0,
    batches: 0,
    exhausted: false,
    verifiedBy: 'raw_text:substring',
    results: [],
  };

  if (plan.matchMode === 'empty') {
    out.exhausted = true;
    return out;
  }

  if (plan.matchMode === 'bigram') scanBigramCandidates(db, plan, filters, limit, out);
  else scanRawCandidates(db, plan, filters, limit, out);
  return out;
}

// CJK：bigram 预筛是超集 ⇒ 可以只核实候选，但必须核到「取够 limit」或「候选耗尽」。
function scanBigramCandidates(db, plan, filters, limit, out) {
  const stmt = db.prepare(MATCH_BATCH_SQL);
  let offset = 0;
  for (;;) {
    const rows = stmt.all(
      plan.expression,
      filters.sourceId, filters.sourceId,
      filters.sessionId, filters.sessionId,
      SEARCH_BATCH_SIZE, offset,
    );
    out.batches += 1;
    if (rows.length === 0) {
      out.exhausted = true;
      return;
    }
    out.candidates += rows.length;
    out.scanned += rows.length;
    offset += rows.length;
    for (const row of rows) {
      if (!containsNeedle(row.raw_text, plan.needle)) continue;
      pushResult(out, row, plan, row.score === undefined ? null : row.score);
      if (out.results.length >= limit) return;
    }
    if (rows.length < SEARCH_BATCH_SIZE) {
      out.exhausted = true;
      return;
    }
  }
}

// 非 CJK / mixed / 纯标点：整词 token 不是子串语义的超集，所以不做预筛，直接扫 raw_text。
// 语义与「raw_text.toLowerCase().includes(needle)」逐字等价；代价是 O(行数)，见报告性能一节。
function scanRawCandidates(db, plan, filters, limit, out) {
  const stmt = db.prepare(RAW_BATCH_SQL);
  let cursor = -1;
  for (;;) {
    const rows = stmt.all(
      cursor,
      filters.sourceId, filters.sourceId,
      filters.sessionId, filters.sessionId,
      SEARCH_BATCH_SIZE,
    );
    out.batches += 1;
    if (rows.length === 0) {
      out.exhausted = true;
      return;
    }
    out.candidates += rows.length;
    out.scanned += rows.length;
    for (const row of rows) {
      cursor = row.rid;
      if (!containsNeedle(row.raw_text, plan.needle)) continue;
      pushResult(out, row, plan, null);
      if (out.results.length >= limit) return;
    }
    if (rows.length < SEARCH_BATCH_SIZE) {
      out.exhausted = true;
      return;
    }
  }
}

// 写入侧唯一入口：ingest 与 v4 回填都调它，避免两处各写一套变换。
export function ftsRowFor(frameRow) {
  const built = buildSearchText(frameRow.snippet);
  return {
    rowid: frameRow.rowid,
    searchText: built.searchText,
    rawText: frameRow.snippet,
    ptr: frameRow.ptr,
    sourceId: frameRow.source_id,
    sessionId: frameRow.session_id,
    seq: frameRow.seq,
    tokenCount: built.tokens.length,
  };
}
