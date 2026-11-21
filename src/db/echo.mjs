// src/db/echo.mjs —— v9「ECHO 派生索引」的**只读**面：检索 / 指针 / 统计。
// ============================================================================
// 这一层只做三件事，且只做读：
//   searchEcho(db, { terms, surface, limit, sources, since, until })
//   openEchoPtr(db, ptr)
//   echoStatsFor(db)
//
// ★ 为什么单独一个模块，而不是全塞进 store.mjs：
//   store.mjs 是门面（只做 ensureReady + 委派 + 错误翻译），实现按面拆——
//   artifacts / relocate / search 都是这个形状，ECHO 面照同一套。
//
// ★★ 语义**不在这里发明**：能复用的全部从 tools/echo-index-import.mjs 复用
//   （parseEchoPtr / resolveEchoPtr / echoIndexInfoFor / verifyEchoIntegrity /
//    listEchoSources / ECHO_SEARCH_BATCH / EchoImportRefusal）。理由只有一个：
//   指针语法、歧义判据、对齐判据各自只许有一个定义，抄一遍迟早分叉。
//
//   这里**新增**的只有三样，且都是「超集」而不是「另一套」：
//     1. 多词 AND（ECHO 的 terms 语义）：每个词都必须原串出现在 raw_text 里。
//     2. 来源过滤（sources）与时间过滤（since / until）—— 落在**扫描的 WHERE 里**，
//        不是取回之后再筛。取回后筛会让 limit / exhausted 变成假话。
//     3. 命中带门牌（ptr）：words → log|v4log:<session>#seq=<n>，summaries → idx:<cmpId>。
//
//   ★ 与 CLI 的关系说清楚（免得被当成两套实现）：CLI 的 searchEchoWords /
//     searchEchoSummaries 是**本模块没有过滤条件、只有一个词时的特例**。
//     tools/echo-mcp-selftest.mjs 拿同一份语料逐条断言两者回执相同（顺序、字段、计数）。
//     若将来 CLI 也要过滤，它应当改调本模块 —— 那一步不在本任务范围内（tools/ 未授权）。
//
// ★★ 对齐（aligned）的判据仍然只有一处：echoIndexInfoFor。本模块只做两件事——
//   检索前**闸**（不一致就抛 ECHO_INDEX_STALE，绝不回一份看着正常、实际缺行的结果）；
//   统计里**报**（ok:false + 差在哪）。
//   ★ 一个刻意的非对称：**open 不闸对齐**。它读的是 echo_words / echo_summaries 行，
//     一次 FTS 都不查；拿 FTS 的毛病去拒绝一条真实存在的行，等于把「索引旧了」
//     说成「原文不在了」—— 那是另一种谎。诊断路径在 stats。
//
// ★★ 命名空间铁律（v9 schema 头注释的原话，这里再落一遍）：
//   log: / v4log: 是**帧流**命名空间，idx: **只**指向 L4 摘要；
//   idx: 永远不会被当成 log: 解析，也永远不会去开一条帧。
//   ★ 旧语法 log:<sid>#seq=<n> 一个字节都不改；@stream16 之类扩展一律拒（见 parseEchoPtr）。
// ============================================================================

import {
  EchoImportRefusal,
  EXIT,
  ECHO_SEARCH_BATCH,
  resolveEchoPtr,
  echoIndexInfoFor,
  verifyEchoIntegrity,
  listEchoSources,
} from '../../tools/echo-index-import.mjs';
import { ECHO_PTR_NAMESPACES, ECHO_SUMMARY_PTR_PREFIX } from './schema.mjs';
import { buildQueryPlan, containsNeedle } from './search.mjs';
import { makePtr } from './ptr.mjs';
import { fail, CODES } from './errors.mjs';

export const ECHO_SURFACES = Object.freeze(['words', 'summaries', 'both']);
export const ECHO_SEARCH_LIMIT_MAX = 500;
export const ECHO_SEARCH_LIMIT_DEFAULT = 50;

// ── 输入归一（只做表示层，不改语义）────────────────────────────────────────

// ECHO 的 terms 是数组且语义是 AND。这里只做三件表示层的事：
// 允许单个字符串（= 一个词）、trim、丢空词、去重（保留首次出现的顺序）。
// ★ 去重不改变结果集：同一个词判两次和判一次等价；写在回执里是为了可核对。
export function normalizeEchoTerms(terms) {
  const raw = terms === undefined || terms === null ? [] : (Array.isArray(terms) ? terms : [terms]);
  const out = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      fail(CODES.INVALID_INPUT, 'each search term must be a string', { got: item === null ? 'null' : typeof item });
    }
    const t = item.trim();
    if (t === '') continue;
    if (out.indexOf(t) === -1) out.push(t);
  }
  return out;
}

function clampLimit(value) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : ECHO_SEARCH_LIMIT_DEFAULT;
  if (n < 1) return 1;
  return n > ECHO_SEARCH_LIMIT_MAX ? ECHO_SEARCH_LIMIT_MAX : n;
}

function parseTimeBound(value, name) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') fail(CODES.INVALID_INPUT, name + ' must be an ISO-8601 string', { name, got: typeof value });
  const ms = Date.parse(value.trim());
  if (Number.isNaN(ms)) {
    fail(CODES.INVALID_INPUT, name + ' is not a parseable ISO-8601 timestamp: ' + JSON.stringify(value), { name, value });
  }
  // 归一到 UTC ISO：库里的 t 可能是 'Z'、可能是 '+08:00'、可能没有毫秒，
  // 所以比较交给 SQLite 的 julianday()（它认这几种写法），而不是拿字符串比大小。
  return new Date(ms).toISOString();
}

function parseFilters(filters) {
  const f = filters || {};
  let sources = null;
  if (f.sources !== undefined && f.sources !== null) {
    if (!Array.isArray(f.sources)) fail(CODES.INVALID_INPUT, 'sources must be an array of echo source ids', { got: typeof f.sources });
    if (f.sources.length === 0) {
      // ★ 显式空集 = 一个来源都不选 = 结果必然为空。这种「看起来像没给」的输入最容易
      //   被读成「不过滤」，于是调用方以为范围收窄了，实际查了全库。所以直接拒。
      fail(CODES.INVALID_INPUT, 'sources is an empty array: omit it to search every source (an explicit empty filter matches nothing)', { sources: [] });
    }
    sources = [];
    for (const s of f.sources) {
      if (typeof s !== 'string' || s.trim() === '') fail(CODES.INVALID_INPUT, 'each entry of sources must be a non-empty string', { got: s === null ? 'null' : typeof s });
      const v = s.trim();
      if (sources.indexOf(v) === -1) sources.push(v);
    }
  }
  const since = parseTimeBound(f.since, 'since');
  const until = parseTimeBound(f.until, 'until');
  const includeNonDialogue = f.includeNonDialogue === undefined ? false : f.includeNonDialogue;
  if (typeof includeNonDialogue !== 'boolean') fail(CODES.INVALID_INPUT, 'includeNonDialogue must be a boolean', { includeNonDialogue });
  if (since !== null && until !== null && Date.parse(until) < Date.parse(since)) {
    fail(CODES.INVALID_INPUT, 'until is before since', { since, until });
  }
  return { sources, since, until, includeNonDialogue };
}

function filterSql(alias, filters) {
  const parts = [];
  const params = [];
  if (filters.sources) {
    parts.push('and ' + alias + '.echo_source_id in (' + filters.sources.map(function () { return '?'; }).join(',') + ')');
    for (const s of filters.sources) params.push(s);
  }
  if (filters.since) { parts.push('and julianday(' + alias + '.t) >= julianday(?)'); params.push(filters.since); }
  if (filters.until) { parts.push('and julianday(' + alias + '.t) <= julianday(?)'); params.push(filters.until); }
  if (alias === 'w' && !filters.includeNonDialogue) parts.push("and w.content_class = 'dialogue'");
  return { sql: parts.join(' '), params };
}

// ── 对齐闸（判据在 echoIndexInfoFor，一处）──────────────────────────────────
export function assertEchoAligned(db) {
  const info = echoIndexInfoFor(db);
  if (info.aligned) return info;
  // ★ 码与语义照 CLI 的 assertEchoIndexAligned（同一句话、同一个码），
  //   但它没有被导出，所以这里重建 —— 定义仍然只有 echoIndexInfoFor 一处。
  throw new EchoImportRefusal(
    'ECHO_INDEX_STALE',
    'echo derived index is out of sync (per-source counts differ between rows / FTS / srcSeqs); refusing to return a partial result',
    { index: info },
    EXIT.refused,
  );
}

// ── 检索计划：每个词一份 plan，全部 bigram 才能用 FTS 当超集预筛 ─────────────
// ★ 判据与 buildQueryPlan 的同一条：只有**全是 bigram** 时 FTS 才是子串语义的超集。
//   任何一个词落在 token / mixed / substring，就整体走 raw 扫描 —— 宁可慢，不许漏。
// ★ AND 的超集性：若每个词都作为子串出现，则每个词的 bigram 都出现在索引里，
//   于是 'expr1 expr2 ...'（FTS 的隐式 AND）必然命中。方向是对的（超集）。
function planTerms(terms) {
  const plans = terms.map(function (t) {
    const p = buildQueryPlan(t);
    return { term: t, needle: p.needle, matchMode: p.matchMode, expression: p.expression };
  });
  const fts = plans.length > 0 && plans.every(function (p) { return p.matchMode === 'bigram' && p.expression; });
  return {
    plans,
    fts,
    expression: fts ? plans.map(function (p) { return p.expression; }).join(' ') : null,
  };
}

// ── 扫描器（两种分页形状，照 CLI 同一套）───────────────────────────────────
// bigram：FTS 按 bm25 排序、offset 分页；raw：按 rowid keyset 分页（并发写入时不跳行）。
// ★ 候选永不截断：扫到「取够 limit」或「候选耗尽」。exhausted=false 的含义是
//   **未证明完整**，不是「还有」。
const SURFACE_SPECS = Object.freeze({
  words: {
    surface: 'words',
    alias: 'w',
    ftsSql: [
      'select f.echo_source_id as echo_source_id, f.word_ord as word_ord, f.session as session, f.seq as seq,',
      '       w.t as t, w.kind as kind, w.text as raw_text, bm25(echo_words_fts) as score',
      'from echo_words_fts f join echo_words w on w.echo_source_id = f.echo_source_id and w.word_ord = f.word_ord',
      'join echo_index_sources src on src.echo_source_id = w.echo_source_id',
       'where src.state=\'committed\' and echo_words_fts match ?',
    ].join(' '),
    ftsOrder: 'score, w.echo_source_id, w.word_ord',
    rawSql: [
      'select w.rowid as rid, w.echo_source_id as echo_source_id, w.word_ord as word_ord, w.session as session,',
      '       w.seq as seq, w.t as t, w.kind as kind, w.text as raw_text',
      'from echo_words w join echo_index_sources src on src.echo_source_id = w.echo_source_id and src.state=\'committed\' where w.rowid > ?',
    ].join(' '),
    rawOrder: 'w.rowid',
  },
  summaries: {
    surface: 'summaries',
    alias: 's',
    ftsSql: [
      'select f.echo_source_id as echo_source_id, f.cmp_id as cmp_id, s.t as t, s.session as session,',
      '       s.status as status, s.shadowed_tokens as shadowed_tokens, s.shadowed_chars as shadowed_chars,',
      '       s.summary as raw_text, bm25(echo_summaries_fts) as score',
      'from echo_summaries_fts f join echo_summaries s on s.echo_source_id = f.echo_source_id and s.cmp_id = f.cmp_id',
      'join echo_index_sources src on src.echo_source_id = s.echo_source_id',
       "where src.state='committed' and echo_summaries_fts match ?",
    ].join(' '),
    ftsOrder: 'score, s.echo_source_id, s.cmp_id',
    rawSql: [
      'select s.rowid as rid, s.echo_source_id as echo_source_id, s.cmp_id as cmp_id, s.t as t, s.session as session,',
      '       s.status as status, s.shadowed_tokens as shadowed_tokens, s.shadowed_chars as shadowed_chars,',
      '       s.summary as raw_text',
      'from echo_summaries s join echo_index_sources src on src.echo_source_id = s.echo_source_id and src.state=\'committed\' where s.rowid > ?',
    ].join(' '),
    rawOrder: 's.rowid',
  },
});

function authorityFromSourceRow(row, snapshotId) {
  return { sourceId: row.echo_source_id, generation: Number(row.generation), state: row.state, snapshotId };
}

function readCommittedAuthority(db, sourceId, snapshotId) {
  const row = db.prepare('select echo_source_id, generation, state, source_sha256, cursor_seq from echo_index_sources where echo_source_id=?').get(sourceId);
  if (!row) fail('ECHO_SOURCE_NOT_FOUND', 'ECHO source is not indexed', { sourceId, observedState: 'missing', generation: null });
  if (row.state !== 'committed') fail('ECHO_SOURCE_NOT_COMMITTED', 'ECHO source is not committed; refusing query', { sourceId, observedState: row.state, generation: Number(row.generation) });
  return Object.assign(authorityFromSourceRow(row, snapshotId), { sourceSha256: row.source_sha256, cursorSeq: Number(row.cursor_seq) });
}

function sourceIndex(db, snapshotId) {
  const rows = db.prepare(
    "select echo_source_id, namespace, source_path, source_version, generation, state from echo_index_sources where state='committed'"
  ).all();
  const byId = new Map();
  for (const r of rows) byId.set(r.echo_source_id, { namespace: r.namespace, sourcePath: r.source_path, sourceVersion: r.source_version, generation: Number(r.generation), state: r.state, authority: authorityFromSourceRow(r, snapshotId) });
  return byId;
}

function selectedAuthorities(db, sourceIds, snapshotId, sources) {
  if (sourceIds && sourceIds.length) return sourceIds.map((id) => readCommittedAuthority(db, id, snapshotId));
  return Array.from(sources.values()).filter((s) => s.state === 'committed').map((s) => s.authority);
}

function mapHit(spec, row, ctx, score) {
  const src = ctx.sources.get(row.echo_source_id) || { namespace: null, sourcePath: null, sourceVersion: null, generation: null, state: null, authority: null };
  const base = {
    surface: spec.surface,
    echoSourceId: row.echo_source_id,
    sourcePath: src.sourcePath,
    sourceVersion: src.sourceVersion,
    t: row.t,
    session: row.session,
    snippet: String(row.raw_text).slice(0, 200),
    rawText: row.raw_text,
    score: score === undefined ? null : score,
    matchMode: ctx.matchMode,
  };
  if (spec.surface === 'words') {
    // ★ 门牌用**来源自己的命名空间**拼：同一 sid+seq 在 log 与 v4log 两份流里
    //   是两个命名空间里的两条门牌，绝不互相冒充。
    return Object.assign(base, {
      ptr: makePtr(src.namespace, row.session, Number(row.seq)),
      namespace: src.namespace,
      wordOrd: Number(row.word_ord),
      seq: Number(row.seq),
      kind: row.kind,
    });
  }
  return Object.assign(base, {
    ptr: ECHO_SUMMARY_PTR_PREFIX + ':' + row.cmp_id,
    cmpId: row.cmp_id,
    status: row.status,
    shadowedTokens: Number(row.shadowed_tokens),
    shadowedChars: Number(row.shadowed_chars),
  });
}

function allTermsMatch(rawText, needles) {
  for (const n of needles) {
    if (!containsNeedle(rawText, n)) return false;
  }
  return true;
}

function scanSurface(db, spec, plans, needles, filters, limit, out, ctx) {
  const flt = filterSql(spec.alias, filters);
  const tail = flt.sql === '' ? '' : ' ' + flt.sql;
  if (plans.fts) {
    const stmt = db.prepare(spec.ftsSql + tail + ' order by ' + spec.ftsOrder + ' limit ? offset ?');
    let offset = 0;
    for (;;) {
      const rows = stmt.all.apply(stmt, [plans.expression].concat(flt.params, [ECHO_SEARCH_BATCH, offset]));
      out.batches += 1;
      if (rows.length === 0) { out.exhausted = true; return out; }
      out.candidates += rows.length;
      out.scanned += rows.length;
      offset += rows.length;
      for (const row of rows) {
        if (!allTermsMatch(row.raw_text, needles)) continue;
        out.results.push(mapHit(spec, row, ctx, row.score));
        if (out.results.length >= limit) return out;
      }
      if (rows.length < ECHO_SEARCH_BATCH) { out.exhausted = true; return out; }
    }
  }
  const stmt = db.prepare(spec.rawSql + tail + ' order by ' + spec.rawOrder + ' limit ?');
  let cursor = -1;
  for (;;) {
    const rows = stmt.all.apply(stmt, [cursor].concat(flt.params, [ECHO_SEARCH_BATCH]));
    out.batches += 1;
    if (rows.length === 0) { out.exhausted = true; return out; }
    out.candidates += rows.length;
    out.scanned += rows.length;
    for (const row of rows) {
      cursor = row.rid;
      if (!allTermsMatch(row.raw_text, needles)) continue;
      out.results.push(mapHit(spec, row, ctx, null));
      if (out.results.length >= limit) return out;
    }
    if (rows.length < ECHO_SEARCH_BATCH) { out.exhausted = true; return out; }
  }
}

// 单面检索。返回的回执形状与 CLI 的 searchEchoWords / searchEchoSummaries 同族，
// 多了 terms / filters / limit / surface 与每条命中的 ptr。
export function searchEchoSurface(db, surface, terms, options) {
  const spec = SURFACE_SPECS[surface];
  if (!spec) fail(CODES.INVALID_INPUT, 'unknown search surface ' + JSON.stringify(surface) + ' (expected words | summaries)', { surface });
  const o = options || {};
  const limit = clampLimit(o.limit);
  const norm = normalizeEchoTerms(terms);
  const filters = parseFilters(o);
  const index = assertEchoAligned(db);
  const snapshotId = o.snapshotId || 'echo-query:' + Date.now().toString(36);
  const sources = sourceIndex(db, snapshotId);
  const authorities = o.authorities || selectedAuthorities(db, filters.sources, snapshotId, sources);
  // 保留旧 index 字段，同时把同一 committed 快照的代次与状态补到旧来源条目。
  index.sources = index.sources.map((item) => {
    const source = sources.get(item.echoSourceId);
    return Object.assign({}, item, {
      generation: source ? source.generation : undefined,
      state: source ? source.state : undefined,
    });
  });
  const plans = planTerms(norm);
  const needles = plans.plans.map(function (p) { return p.needle; });
  const ctx = { sources, authorities, matchMode: norm.length === 1 ? plans.plans[0].matchMode : 'and' };
  const out = {
    surface: spec.surface,
    authority: ctx.authorities.length === 1 ? ctx.authorities[0] : null,
    authorities: ctx.authorities,
    generation: ctx.authorities.length === 1 ? ctx.authorities[0].generation : null,
    state: ctx.authorities.length === 1 ? ctx.authorities[0].state : null,
    terms: norm,
    query: norm.join(' + '),
    limit,
    filters: { sources: filters.sources, since: filters.since, until: filters.until, includeNonDialogue: filters.includeNonDialogue },
    matchMode: ctx.matchMode,
    termPlans: plans.plans.map(function (p) { return { term: p.term, matchMode: p.matchMode }; }),
    scanPath: plans.fts ? 'bigram-fts' : 'raw-scan',
    index,
    candidates: 0,
    scanned: 0,
    batches: 0,
    exhausted: false,
    verifiedBy: spec.surface + '.text:substring(all terms, AND)',
    results: [],
  };
  if (norm.length === 0) { out.exhausted = true; return out; }
  return scanSurface(db, spec, plans, needles, filters, limit, out, ctx);
}

// 公共入口：surface = words | summaries | both。
// ★ both 不做"统一排序"——两个面的行长得不一样（word 有 seq，summary 有 cmpId），
//   硬拼一个排名就是发明一种排序。所以各面回各面的回执，各带自己的 exhausted。
export function searchEcho(db, options) {
  const o = options || {};
  const surface = o.surface === undefined || o.surface === null ? 'both' : String(o.surface);
  const opts = { limit: o.limit, sources: o.sources, since: o.since, until: o.until, includeNonDialogue: o.includeNonDialogue };
  if (surface === 'both') {
    const snapshotId = 'echo-both:' + Date.now().toString(36) + ':' + Math.random().toString(36).slice(2);
    db.exec('SAVEPOINT echo_search_both');
    try {
      const sources = sourceIndex(db, snapshotId);
      const authorities = selectedAuthorities(db, opts.sources || null, snapshotId, sources);
      const generations = Array.from(new Set(authorities.map((a) => a.generation)));
      const faceOpts = Object.assign({}, opts, { snapshotId, authorities });
      const words = searchEchoSurface(db, 'words', o.terms, faceOpts);
      const summaries = searchEchoSurface(db, 'summaries', o.terms, faceOpts);
      if (generations.length !== 1) {
        words.results = [];
        summaries.results = [];
        return { ok: false, surface: 'both', inconsistent: true, reason: 'generation-mismatch', words, summaries };
      }
      return { ok: true, surface: 'both', sharedGeneration: generations[0], words, summaries };
    } finally {
      try { db.exec('ROLLBACK TO echo_search_both'); } catch {}
      try { db.exec('RELEASE echo_search_both'); } catch {}
    }
  }
  if (surface !== 'words' && surface !== 'summaries') {
    fail(CODES.INVALID_INPUT, 'surface must be words | summaries | both', { surface });
  }
  return { ok: true, surface, [surface]: searchEchoSurface(db, surface, o.terms, opts) };
}

// ── 指针 ────────────────────────────────────────────────────────────────────
// 语义**全部**照 resolveEchoPtr：零行 = NOT_FOUND；一行 = 那一行；多行 = AMBIGUOUS
// （带显式候选路径），绝不按 mtime 挑一个；idx: 只开摘要，srcSeqs 按源顺序（不排序、不去重）。
export function openEchoPtr(db, ptr) {
  const resolved = resolveEchoPtr(db, ptr);
  return Object.assign({ ok: true }, resolved, {
    // ★ 这句话是给调用方看的边界：idx: 不是帧门牌，永远不会被当成 log: 打开。
    note: resolved.kind === 'summary'
      ? 'idx: 指向 L4 摘要本身；srcSeqs 是它覆盖的帧序号（按源顺序，可能有重复），要开原文请用 log:/v4log: 门牌'
      : 'log: / v4log: 指向帧流的一条词行；两个命名空间永不互相解析',
  });
}

// ── 统计（诊断面：**不闸**，把问题报出来）──────────────────────────────────
export function echoStatsFor(db) {
  const index = echoIndexInfoFor(db);
  const integrity = verifyEchoIntegrity(db);
  const sources = listEchoSources(db).map(function (s) {
    const info = index.sources.filter(function (x) { return x.echoSourceId === s.echoSourceId; })[0] || null;
    return {
      echoSourceId: s.echoSourceId,
      sourcePath: s.sourcePath,
      sourceVersion: s.sourceVersion,
      namespace: s.namespace,
      generation: s.generation,
      state: s.state,
      cursorSeq: s.cursorSeq,
      words: s.wordsCount,
      summaries: s.summariesCount,
      srcSeqCount: s.srcSeqCount,
      builtAt: s.builtAt,
      importedAt: s.importedAt,
      aligned: info ? info.aligned : false,
    };
  });
  const frames = Number(db.prepare('select count(*) as n from frame_index').get().n);
  const idxInFrames = Number(db.prepare("select count(*) as n from frame_index where ptr like 'idx:%'").get().n);
  return {
    ok: index.aligned === true && integrity.ok === true,
    index: { words: index.words, summaries: index.summaries, aligned: index.aligned, sources: index.sources },
    integrity: { ok: integrity.ok, problems: integrity.problems, orphanFts: integrity.orphanFts },
    sources,
    frames: {
      count: frames,
      idxInFrames,
      note: 'v4 帧是另一个命名空间（v4log:）；ECHO 索引绝不进 frame_index，idx: 也进不去（库层触发器）',
    },
    ptrNamespaces: ECHO_PTR_NAMESPACES.concat([ECHO_SUMMARY_PTR_PREFIX]),
  };
}

export { EchoImportRefusal, ECHO_PTR_NAMESPACES, ECHO_SUMMARY_PTR_PREFIX };
