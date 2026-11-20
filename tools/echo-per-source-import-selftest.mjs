#!/usr/bin/env node
// SUPERSEDED 2026-11-16: superseded by tools/echo-index-source-snapshot-import.mjs (and its selftest); kept only as history — do NOT extend.
// SUPERSEDED by echo-index-source-snapshot-import-selftest.mjs
// 合成、只在 TEMP 里跑的自检：每个阻塞点都有一条断言对着它。
// 只用 store.echoOpen（常驻 Store 门面）验证指针，不用 tools/ 里的原型 resolveEchoPtr。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openMetaStore } from '../src/db/index.mjs';
import { echoSourceIdFor } from '../src/db/schema.mjs';
import {
  EXIT,
  NAMESPACE_BY_SOURCE,
  SOURCE_PATH_ROOT,
  SOURCE_VERSION,
  auditTempDb,
  canonicalSourceLogPath,
  classifySource,
  importPerSource,
  preflightSourceRows,
  sourceIdentityFor,
} from './echo-per-source-import.mjs';

const toolPath = fileURLToPath(new URL('./echo-per-source-import.mjs', import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-per-source-selftest-'));
const sha = (value) => createHash('sha256').update(value).digest('hex');
const timestamp = '2026-11-16T00:00:00.000Z';
const sid = 'session-synthetic-shared';

// 原始来源日志路径：只作为**数据**参与铸身份，绝不该出现在 journal / receipt / 库的 log 列里。
const RAW = 'D:/secret/raw/session-alpha.v3.jsonl';
const LOG_V3_WIN = 'D:\\Synthetic\\Logs\\Session-Alpha.v3.jsonl';
const LOG_V3_POSIX = 'D:/Synthetic/Logs/Session-Alpha.v3.jsonl';
const LOG_V3 = process.platform === 'win32' ? 'd:/synthetic/logs/session-alpha.v3.jsonl' : LOG_V3_POSIX;
const LOG_V4 = 'D:/synthetic/logs/session-alpha.v4.jsonl';
const LOG_EMPTY = 'D:/synthetic/logs/session-empty.v3.jsonl';
const LOG_SUMMARY_ONLY = 'D:/synthetic/logs/session-summary.v4.jsonl';

// 泄漏哨兵：这些片段一个都不许出现在 journal / receipt / 库的 log 列里。
const LEAK_FRAGMENTS = ['secret/raw', 'session-alpha', 'v3 payload', 'v4 payload', 'second turn', 'row-001', 'row-002'];
function assertNoLeak(text, where) {
  const haystack = String(text).toLowerCase();
  for (const fragment of LEAK_FRAGMENTS) {
    assert.equal(haystack.indexOf(fragment.toLowerCase()), -1, where + ' leaks ' + JSON.stringify(fragment) + ': ' + text);
  }
}
// TEMP 路径哨兵 —— 这次修复的**直接**回归点。
// 旧实现把 <tmp>/raw-<opaqueId>.jsonl 写进 files.jsonl 的 file 与每一行的 log，TEMP 路径于是顺着
// words/summaries 落进库的 log 列和游标。原始路径片段拦不住它：TEMP 路径里一个片段都没有。
// ★ 归一化必须两边都做：JSON 里的反斜杠是转义过的（C:\Users\...），逐字符换成 '/' 会得到
//   C://Users//... —— 单斜杠的片段就再也匹配不上，哨兵会变成一句永远不响的空话（否定控制实测过）。
//   所以文本与片段都走同一条 normalize：反斜杠→斜杠，再折叠重复斜杠。
const normalizePath = (value) => String(value).replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase();
const TEMP_FRAGMENTS = Array.from(new Set([os.tmpdir(), path.resolve(os.tmpdir()), root].map(normalizePath)));
function assertNoTempPath(text, where) {
  const haystack = normalizePath(text);
  for (const fragment of TEMP_FRAGMENTS) {
    assert.equal(haystack.indexOf(fragment), -1, where + ' leaks a TEMP path (' + fragment + '): ' + text);
  }
}

function word(role, seq, text, extra) {
  return Object.assign({
    t: timestamp,
    session: sid,
    ws: 'synthetic',
    seq,
    turn: seq,
    log: RAW,
    role,
    kind: role + '/message',
    len: text.length,
    truncated: false,
    text,
  }, extra || {});
}
function summaryIn(session, id, text, srcSeqs, extra) {
  return Object.assign({
    id,
    t: timestamp,
    session,
    ws: 'synthetic',
    log: RAW,
    srcSeqs: srcSeqs || [],
    shadowedTokens: 1,
    chars: text.length,
    provider: null,
    model: null,
    status: 'active',
    summary: text,
    manifest: { fixture: true },
  }, extra || {});
}

const sources = [
  { kind: 'v3', rowId: 'row-001', session: sid, sourceLogPath: LOG_V3_WIN, wordsCount: 1, summariesCount: 1, words: [word('user', 1, 'v3 payload')], summaries: [summaryIn(sid, 'cmp-shared', 'v3 summary', [1])] },
  { kind: 'v4', rowId: 'row-002', session: sid, sourceLogPath: LOG_V4, wordsCount: 1, summariesCount: 1, words: [word('assistant', 1, 'v4 payload')], summaries: [summaryIn(sid, 'cmp-shared', 'v4 summary', [1])] },
  { kind: 'v3', rowId: 'row-empty', session: 'session-empty', sourceLogPath: LOG_EMPTY, wordsCount: 0, summariesCount: 0, words: [], summaries: [] },
  { kind: 'v4', rowId: 'row-summary-only', session: 'session-summary', sourceLogPath: LOG_SUMMARY_ONLY, wordsCount: 0, summariesCount: 1, words: [], summaries: [summaryIn('session-summary', 'cmp-solo', 'solo', [])] },
];

const openStore = (dbPath, mode) => openMetaStore({ path: dbPath, mode: mode || 'readwrite' });
function migrate(dbPath) { const store = openStore(dbPath); try { store.migrate(); } finally { store.close(); } }
const countOf = (store, table) => Number(store.db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n);
const countWhere = (store, table, where) => Number(store.db.prepare('SELECT COUNT(*) AS n FROM ' + table + ' WHERE ' + where).get().n);

try {
  // ── 1. namespace 映射与来源分类 ──────────────────────────────────────────
  assert.deepEqual({ v3: NAMESPACE_BY_SOURCE.v3, v4: NAMESPACE_BY_SOURCE.v4 }, { v3: 'log', v4: 'v4log' });
  assert.throws(() => classifySource({ kind: 'future', session: sid, wordsCount: 0, summariesCount: 0 }), (error) => error.code === 'SOURCE_NAMESPACE_UNMAPPED');
  assert.throws(() => classifySource({ session: sid, wordsCount: 0, summariesCount: 0 }), (error) => error.code === 'SOURCE_NAMESPACE_UNMAPPED');
  assert.equal(classifySource(sources[2]).status, 'CANONICAL_EMPTY_SOURCE');
  assert.equal(classifySource(sources[3]).status, 'SUMMARY_ONLY_SOURCE');
  // 声明的条数与实际行数不一致 → 建清单之前就停（不许 counts 与库各说一套）
  assert.throws(() => classifySource({ ...sources[0], wordsCount: 9 }), (error) => error.code === 'SOURCE_COUNTS_MISMATCH');
  assert.throws(() => classifySource({ ...sources[0], summariesCount: 9 }), (error) => error.code === 'SOURCE_COUNTS_MISMATCH');

  // ── 2. 身份：只由 (namespace, 规范原始日志路径) 决定 ────────────────────
  assert.equal(canonicalSourceLogPath(LOG_V3_WIN), LOG_V3, 'separators and case fold to one canonical form');
  const identity = sourceIdentityFor(sources[0]);
  const identityV4 = sourceIdentityFor(sources[1]);
  assert.equal(identity.sourcePath, SOURCE_PATH_ROOT + '/log/' + sha(LOG_V3));
  assert.equal(identity.hash, sha(LOG_V3));
  assert.equal(identity.namespace, 'log');
  assert.equal(identityV4.namespace, 'v4log');
  assert.equal(identityV4.sourcePath, SOURCE_PATH_ROOT + '/v4log/' + sha(canonicalSourceLogPath(LOG_V4)));
  // 换快照摘要 / 换 rowId / 换大小写写法 → 同一个身份、同一个 echoSourceId
  const laterSnapshot = { ...sources[0], rowId: 'row-999', digest: sha('a-later-snapshot'), sourceLogPath: LOG_V3 };
  assert.equal(sourceIdentityFor(laterSnapshot).sourcePath, identity.sourcePath, 'a snapshot digest must never enter the source identity');
  assert.equal(echoSourceIdFor(sourceIdentityFor(laterSnapshot).sourcePath, SOURCE_VERSION), echoSourceIdFor(identity.sourcePath, SOURCE_VERSION));
  // 行序无关
  assert.deepEqual(
    preflightSourceRows([laterSnapshot, sources[1]]).map((row) => row.sourcePath).sort(),
    preflightSourceRows([sources[1], sources[0]]).map((row) => row.sourcePath).sort(),
  );
  // 同一份日志、只换 namespace → 必须分成两个身份
  const otherVariant = sourceIdentityFor({ ...sources[0], kind: 'v4' });
  // 哈希只由规范路径决定（namespace 是路径里独立的一段），所以 hash 相同、sourcePath 不同 —— 身份仍然分开。
  assert.equal(otherVariant.hash, identity.hash, 'the path hash itself is namespace-free by design');
  assert.equal(otherVariant.namespace, 'v4log');
  assert.notEqual(otherVariant.sourcePath, identity.sourcePath);
  assert.notEqual(echoSourceIdFor(otherVariant.sourcePath, SOURCE_VERSION), echoSourceIdFor(identity.sourcePath, SOURCE_VERSION));
  // 身份串里既没有原始路径也没有会话 id
  assert.match(identity.sourcePath, /^D:\/synthetic\/echo-source\/(log|v4log)\/[0-9a-f]{64}$/);
  assertNoLeak(identity.sourcePath, 'sourcePath');
  assert.equal(identity.sourcePath.indexOf(sid), -1);
  // 原始日志路径是必需的**数据**：缺了、空串、相对路径、带 .. 段 → 一律拒绝
  assert.throws(() => sourceIdentityFor({ ...sources[0], sourceLogPath: undefined }), (error) => error.code === 'SOURCE_LOG_PATH_MISSING');
  assert.throws(() => sourceIdentityFor({ ...sources[0], sourceLogPath: '   ' }), (error) => error.code === 'SOURCE_LOG_PATH_MISSING');
  assert.throws(() => sourceIdentityFor({ ...sources[0], sourceLogPath: 'logs/relative.jsonl' }), (error) => error.code === 'SOURCE_LOG_PATH_INVALID');
  assert.throws(() => sourceIdentityFor({ ...sources[0], sourceLogPath: 'D:/a/../b.jsonl' }), (error) => error.code === 'SOURCE_LOG_PATH_INVALID');
  // 同一批里两条行落到同一个身份 → 一条会盖掉另一条，必须显式拦
  assert.throws(() => preflightSourceRows([sources[0], { ...sources[0], rowId: 'row-dup' }]), (error) => error.code === 'SOURCE_IDENTITY_DUPLICATE');
  assert.throws(() => preflightSourceRows([...sources, { ...sources[0], rowId: 'row-dup' }]), (error) => error.code === 'SOURCE_IDENTITY_DUPLICATE');

  // ── 3. 推理行与其它会被 builder 静默剔除的行：显式拒绝 ─────────────────
  assert.throws(() => preflightSourceRows([{ ...sources[0], words: [word('reasoning', 1, 'thinking out loud')] }]), (error) => error.code === 'REASONING_ROWS_REFUSED');
  assert.throws(() => preflightSourceRows([{ ...sources[0], words: [word('user', 1, 'x', { kind: 'thinking' })] }]), (error) => error.code === 'REASONING_ROWS_REFUSED');
  assert.throws(() => preflightSourceRows([{ ...sources[0], words: [word('system', 1, 'system line')] }]), (error) => error.code === 'ROLE_NOT_INDEXABLE');
  assert.throws(() => preflightSourceRows([{ ...sources[0], words: [word('user', 1, 'cut off', { truncated: true })] }]), (error) => error.code === 'TRUNCATED_ROWS_REFUSED');
  assert.throws(() => preflightSourceRows([{ ...sources[0], words: [word('user', 1, '   ')] }]), (error) => error.code === 'WORD_TEXT_BLANK');
  assert.throws(() => preflightSourceRows([{ ...sources[0], words: [word('user', 1, 'x', { session: 'other-session' })] }]), (error) => error.code === 'WORD_SESSION_MISMATCH');
  assert.throws(() => preflightSourceRows([{ ...sources[0], wordsCount: 2, words: [word('user', 1, 'a'), word('user', 1, 'b')] }]), (error) => error.code === 'WORD_SEQ_CONFLICT');
  assert.throws(() => preflightSourceRows([{ ...sources[0], summariesCount: 2, summaries: [summaryIn(sid, 'cmp-shared', 'a', [1]), summaryIn(sid, 'cmp-shared', 'b', [1])] }]), (error) => error.code === 'SUMMARY_ID_CONFLICT');

  // ── 4. 主流程：四个来源，两个落地、两个 refused ─────────────────────────
  const dbPath = path.join(root, 'main.sqlite');
  migrate(dbPath);
  const work = path.join(root, 'main-work');
  const applied = importPerSource({ root: work, dbPath, rows: sources });
  assert.deepEqual(applied.outcomes.map((outcome) => outcome.status), ['IMPORTED', 'IMPORTED', 'CANONICAL_EMPTY_SOURCE', 'SUMMARY_ONLY_SOURCE']);
  assert.deepEqual(applied.counts, { total: 4, ok: 2, refused: 2, failed: 0 });
  assert.equal(applied.conservation.ok, true, JSON.stringify(applied.conservation.problems));
  assert.equal(applied.integrity.available, true);
  assert.equal(applied.integrity.ok, true, JSON.stringify(applied.integrity.problems));
  assert.equal(applied.integrity.aligned, true);
  assert.equal(applied.integrity.sources.length, 2);
  assert.deepEqual(applied.outcomes.slice(0, 2).map((outcome) => outcome.sourceId), [
    echoSourceIdFor(identity.sourcePath, SOURCE_VERSION),
    echoSourceIdFor(identityV4.sourcePath, SOURCE_VERSION),
  ]);
  assert.deepEqual(applied.outcomes.slice(0, 2).map((outcome) => outcome.counts), [{ words: 1, summaries: 1, srcSeqs: 1 }, { words: 1, summaries: 1, srcSeqs: 1 }]);

  // ── 5. journal：终态、计数、不泄漏 ──────────────────────────────────────
  const journalLines = fs.readFileSync(applied.journal, 'utf8').split('\n').filter((line) => line !== '');
  const entries = journalLines.map((line) => JSON.parse(line));
  const sourceEntries = entries.filter((entry) => entry.kind === 'source');
  const runEntries = entries.filter((entry) => entry.kind === 'run');
  assert.equal(sourceEntries.length, 4);
  assert.deepEqual(sourceEntries.map((entry) => entry.status), ['IMPORTED', 'IMPORTED', 'CANONICAL_EMPTY_SOURCE', 'SUMMARY_ONLY_SOURCE']);
  assert.equal(runEntries.length, 1);
  assert.deepEqual([runEntries[0].total, runEntries[0].ok, runEntries[0].refused, runEntries[0].failed], [4, 2, 2, 0]);
  assert.equal(runEntries[0].conservation.ok, true);
  assert.equal(runEntries[0].integrity.ok, true);
  const allowedKeys = ['kind', 'ordinal', 'sourceId', 'opaqueId', 'namespace', 'generation', 'status', 'ok', 'refused', 'wrote', 'created', 'counts', 'manifestSha'];
  for (const entry of sourceEntries) {
    assert.ok(entry.status && entry.status !== 'PENDING', 'every source entry must carry a terminal state');
    assert.equal(typeof entry.ok, 'boolean');
    for (const key of Object.keys(entry)) assert.ok(allowedKeys.indexOf(key) !== -1, 'journal entry carries an unexpected field ' + key);
  }
  for (const line of journalLines) {
    assert.equal(line.indexOf(sid), -1, 'journal must not carry the session id: ' + line);
    assertNoLeak(line, 'journal');
    assertNoTempPath(line, 'journal');
  }
  assertNoLeak(JSON.stringify(applied.conservation.problems.length === 0 ? '' : applied.conservation.problems), 'conservation problems');

  // ── 6. 清单没有被事后改写：journal 记的哈希必须等于磁盘上的字节 ──────────
  const builtDirs = fs.readdirSync(work).filter((name) => name.indexOf('built-') === 0);
  assert.equal(builtDirs.length, 2, 'every READY source gets exactly one build directory');
  const manifestPaths = [];
  for (const dir of builtDirs) {
    const manifestPath = path.join(work, dir, 'manifest.json');
    const manifestBytes = fs.readFileSync(manifestPath);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    assert.ok(manifest.sourcePath.indexOf(SOURCE_PATH_ROOT + '/') === 0);
    assert.equal(manifest.echoIndexVersion, SOURCE_VERSION);
    // builder 在构建时就写出源身份版本（sourceVersion 显式传入）—— 不是建完再改写。
    assert.equal(manifest.version, SOURCE_VERSION, 'manifest.version 由 builder 在构建时写成源身份版本');
    assert.ok(manifest.feedFormat, 'builder 也把 feed 格式版本一并写在清单里（两者不再混为一谈）');
    assert.equal(manifest.generation, 1);
    assert.equal(manifest.counts.words, 1);
    assert.equal(manifest.counts.excludedReasoning, 0, '推理行在预检就被拒了，清单里不会出现被剔除的推理行');
    const opaqueId = manifest.sourcePath.slice(manifest.sourcePath.lastIndexOf('/') + 1);
    const entry = sourceEntries.find((item) => item.opaqueId === opaqueId);
    assert.ok(entry, 'journal must have an entry for ' + opaqueId);
    // 身份链钉死：**只用清单自己声明的 sourcePath + echoIndexVersion** 推出的 id，必须等于实际落库的那个。
    // 这条是原 SSLL 的核心 —— 身份来自 builder 校验过的输入，而不是建完再覆写的字段。
    assert.equal(echoSourceIdFor(manifest.sourcePath, manifest.echoIndexVersion), entry.sourceId, 'manifest 推出的 echoSourceId 必须等于落库身份');
    assert.equal(sha(manifestBytes), entry.manifestSha, 'journal 记下的清单哈希 = 磁盘上的字节（清单没有被事后改写）');
    manifestPaths.push(manifest.sourcePath);
  }
  // 清单里的 sourcePath 必须**逐字等于**请求的那个身份 —— 不是"看起来落在我们的 root 下"。
  assert.deepEqual(manifestPaths.slice().sort(), [identity.sourcePath, identityV4.sourcePath].sort(), 'manifest.sourcePath 必须逐字等于请求的身份');

  // ── 7. 指针：只用 store.echoOpen（常驻门面），测 log/v4log/歧义/选择器/不匹配 ──
  const v3Id = echoSourceIdFor(identity.sourcePath, SOURCE_VERSION);
  const v4Id = echoSourceIdFor(identityV4.sourcePath, SOURCE_VERSION);
  const store = openStore(dbPath, 'readonly');
  try {
    const openedV3 = store.echoOpen('log:' + sid + '#seq=1');
    assert.equal(openedV3.kind, 'word');
    assert.equal(openedV3.namespace, 'log');
    assert.equal(openedV3.source.echoSourceId, v3Id);
    assert.equal(openedV3.word.text, 'v3 payload');
    const openedV4 = store.echoOpen('v4log:' + sid + '#seq=1');
    assert.equal(openedV4.kind, 'word');
    assert.equal(openedV4.namespace, 'v4log');
    assert.equal(openedV4.source.echoSourceId, v4Id);
    assert.equal(openedV4.word.text, 'v4 payload');
    // 同一个 cmpId 落在两个来源上 → 歧义必须保留，并回显式候选
    let ambiguous = null;
    try { store.echoOpen('idx:cmp-shared'); } catch (error) { ambiguous = error; }
    assert.ok(ambiguous, 'a cmpId present in two sources must stay ambiguous');
    assert.equal(ambiguous.code, 'ECHO_PTR_AMBIGUOUS');
    assert.equal(ambiguous.details.candidates.length, 2);
    // 选择器：只在该指针自己的候选里挑
    const pickedV3 = store.echoOpen('idx:cmp-shared', { echoSourceId: v3Id });
    assert.equal(pickedV3.source.echoSourceId, v3Id);
    assert.equal(pickedV3.summary.summary, 'v3 summary');
    assert.equal(pickedV3.summary.srcSeqCount, 1);
    assert.equal(pickedV3.opensFrame, false, 'idx: never opens a frame');
    const pickedV4 = store.echoOpen('idx:cmp-shared', { echoSourceId: v4Id });
    assert.equal(pickedV4.source.echoSourceId, v4Id);
    assert.equal(pickedV4.summary.summary, 'v4 summary');
    // 选择器不是该指针的候选 → SOURCE_MISMATCH，绝不跨候选去找
    let mismatch = null;
    try { store.echoOpen('log:' + sid + '#seq=1', { echoSourceId: v4Id }); } catch (error) { mismatch = error; }
    assert.ok(mismatch, 'a selector outside the candidate set must be refused');
    assert.equal(mismatch.code, 'ECHO_PTR_SOURCE_MISMATCH');
    assert.deepEqual(mismatch.details.candidateIds, [v3Id]);
    // 库里的 log 列只可能是不透明身份（原始路径与正文都没落进去）
    const distinctLogs = store.db.prepare('SELECT DISTINCT log FROM echo_words ORDER BY log').all().map((row) => row.log);
    assert.equal(distinctLogs.length, 2);
    for (const log of distinctLogs) {
      assert.match(log, /^D:\/synthetic\/echo-source\/(log|v4log)\/[0-9a-f]{64}$/, 'stored log must be the opaque identity');
      assertNoLeak(log, 'echo_words.log');
      assertNoTempPath(log, 'echo_words.log');
    }
    const storedPaths = store.db.prepare('SELECT source_path FROM echo_index_sources ORDER BY source_path').all().map((row) => row.source_path);
    assert.deepEqual(storedPaths, [identity.sourcePath, identityV4.sourcePath].sort());
    for (const stored of storedPaths) {
      assertNoLeak(stored, 'echo_index_sources.source_path');
      assertNoTempPath(stored, 'echo_index_sources.source_path');
    }
    // echo_summaries.log 与 echo_words.log 同一条判据：摘要行也带 log 列，也只能是不透明身份。
    const summaryLogs = store.db.prepare('SELECT DISTINCT log FROM echo_summaries ORDER BY log').all().map((row) => row.log);
    assert.equal(summaryLogs.length, 2);
    for (const log of summaryLogs) {
      assert.match(log, /^D:\/synthetic\/echo-source\/(log|v4log)\/[0-9a-f]{64}$/, 'stored summary log must be the opaque identity');
      assertNoLeak(log, 'echo_summaries.log');
      assertNoTempPath(log, 'echo_summaries.log');
    }
    // 游标：feed 的 key 必须就是该来源自己的不透明身份，且整串 cursor_json 里不许出现
    // 原始路径 / payload 正文 / TEMP 路径（旧实现把 TEMP raw 路径写进了 feed key）。
    const cursorRows = store.db.prepare('SELECT source_path, cursor_json FROM echo_index_sources ORDER BY source_path').all();
    assert.equal(cursorRows.length, 2);
    for (const row of cursorRows) {
      assert.ok(row.cursor_json.indexOf(row.source_path) !== -1, 'cursor 必须用该来源自己的不透明身份做 feed key');
      assert.deepEqual(Object.keys(JSON.parse(row.cursor_json).feed.files || {}), [row.source_path], 'cursor.feed.files 的 key 必须逐字等于 source_path');
      assertNoLeak(row.cursor_json, 'echo_index_sources.cursor_json');
      assertNoTempPath(row.cursor_json, 'echo_index_sources.cursor_json');
    }
  } finally { store.close(); }

  // ── 8. 重跑同一批：ALREADY_CURRENT，库与清单都不动 ──────────────────────
  const rerun = importPerSource({ root: work, dbPath, rows: sources });
  assert.deepEqual(rerun.outcomes.map((outcome) => outcome.status), ['ALREADY_CURRENT', 'ALREADY_CURRENT', 'CANONICAL_EMPTY_SOURCE', 'SUMMARY_ONLY_SOURCE']);
  assert.deepEqual({ ok: rerun.counts.ok, refused: rerun.counts.refused, failed: rerun.counts.failed }, { ok: 2, refused: 2, failed: 0 });
  assert.equal(rerun.conservation.ok, true, JSON.stringify(rerun.conservation.problems));
  assert.deepEqual(rerun.conservation.delta, { sources: 0, words: 0, summaries: 0, srcSeqs: 0, builds: 0 }, 'a rerun writes nothing');
  assert.equal(rerun.integrity.ok, true);
  const rerunJournal = fs.readFileSync(rerun.journal, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line));
  assert.equal(rerunJournal.filter((entry) => entry.kind === 'source').length, 8, 'the journal is append-only: 4 + 4 source terminal states');
  assert.equal(rerunJournal.filter((entry) => entry.kind === 'run').length, 2);

  // ── 9. 同一身份、同一代次、内容变了 → GENERATION_CONFLICT，不许铸出第二个来源 ──
  const snapshotDb = path.join(root, 'snapshot.sqlite');
  migrate(snapshotDb);
  const snapshotWork = path.join(root, 'snapshot-work');
  importPerSource({ root: snapshotWork, dbPath: snapshotDb, rows: [sources[0]] });
  const changed = importPerSource({ root: snapshotWork, dbPath: snapshotDb, rows: [{ ...sources[0], rowId: 'row-777', words: [word('user', 1, 'v3 payload rewritten')] }] });
  assert.deepEqual(changed.outcomes.map((outcome) => outcome.status), ['GENERATION_CONFLICT']);
  assert.equal(changed.counts.failed, 1);
  assert.equal(changed.conservation.ok, true, JSON.stringify(changed.conservation.problems));
  const snapshotStore = openStore(snapshotDb, 'readonly');
  try {
    assert.equal(countOf(snapshotStore, 'echo_index_sources'), 1, 'a later snapshot must not mint a second source identity');
    assert.equal(snapshotStore.db.prepare('SELECT source_path FROM echo_index_sources').get().source_path, identity.sourcePath);
    assert.equal(snapshotStore.db.prepare('SELECT text FROM echo_words').get().text, 'v3 payload', 'the committed content must stay the committed content');
  } finally { snapshotStore.close(); }

  // ── 10. 一个来源失败：终态如实记录，整批不中断，库里不留残渣 ─────────────
  const failDb = path.join(root, 'fail.sqlite');
  migrate(failDb);
  const failWork = path.join(root, 'fail-work');
  const firstOnly = importPerSource({ root: failWork, dbPath: failDb, rows: [sources[0]] });
  assert.deepEqual(firstOnly.outcomes.map((outcome) => outcome.status), ['IMPORTED']);
  const triggerStore = openStore(failDb);
  try {
    // 只让**别的来源**的写入失败：已提交的那一份照旧过。
    triggerStore.db.exec("CREATE TRIGGER injected_refusal BEFORE INSERT ON echo_words WHEN NEW.echo_source_id <> '" + v3Id + "' BEGIN SELECT RAISE(ABORT, 'injected failure'); END;");
  } finally { triggerStore.close(); }
  const mixed = importPerSource({ root: failWork, dbPath: failDb, rows: [sources[0], sources[1], sources[3]] });
  assert.deepEqual(mixed.outcomes.map((outcome) => outcome.status), ['ALREADY_CURRENT', 'IMPORT_WRITE_FAILED', 'SUMMARY_ONLY_SOURCE']);
  assert.deepEqual({ ok: mixed.counts.ok, refused: mixed.counts.refused, failed: mixed.counts.failed }, { ok: 1, refused: 1, failed: 1 });
  assert.equal(mixed.conservation.ok, true, JSON.stringify(mixed.conservation.problems));
  assert.equal(mixed.integrity.ok, true, JSON.stringify(mixed.integrity.problems));
  const failStore = openStore(failDb, 'readonly');
  try {
    assert.equal(countOf(failStore, 'echo_index_sources'), 1, 'the failed source left no source row behind');
    assert.equal(countWhere(failStore, 'echo_words', "echo_source_id <> '" + v3Id + "'"), 0, 'the failed source left no word rows behind');
    assert.equal(countOf(failStore, 'frame_index'), 0, 'the derived index never writes frames');
  } finally { failStore.close(); }
  const failJournal = fs.readFileSync(mixed.journal, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line));
  assert.deepEqual(failJournal.filter((entry) => entry.kind === 'source').map((entry) => entry.status), ['IMPORTED', 'ALREADY_CURRENT', 'IMPORT_WRITE_FAILED', 'SUMMARY_ONLY_SOURCE']);
  for (const line of fs.readFileSync(mixed.journal, 'utf8').split('\n').filter((item) => item !== '')) assertNoLeak(line, 'journal after a failure');

  // ── 11. generation 2：从库里的已提交游标接续，整源替换，构建审计两代 ─────
  const gen2Row = {
    kind: 'v3',
    rowId: 'row-001-gen2',
    session: sid,
    sourceLogPath: LOG_V3,
    generation: 2,
    consumedBytes: 2,
    wordsCount: 2,
    summariesCount: 1,
    words: [word('user', 1, 'v3 payload'), word('assistant', 2, 'v3 second turn')],
    summaries: [summaryIn(sid, 'cmp-shared', 'v3 summary v2', [1, 2])],
  };
  const gen2 = importPerSource({ root: work, dbPath, rows: [gen2Row] });
  assert.deepEqual(gen2.outcomes.map((outcome) => outcome.status), ['IMPORTED']);
  assert.equal(gen2.outcomes[0].generation, 2);
  assert.equal(gen2.outcomes[0].created, false, 'generation 2 replaces an existing source, it does not create one');
  assert.deepEqual(gen2.outcomes[0].counts, { words: 2, summaries: 1, srcSeqs: 2 });
  assert.equal(gen2.conservation.ok, true, JSON.stringify(gen2.conservation.problems));
  assert.equal(gen2.integrity.ok, true, JSON.stringify(gen2.integrity.problems));
  const gen2Store = openStore(dbPath, 'readonly');
  try {
    const sourceRow = gen2Store.db.prepare('SELECT generation, source_path, source_version FROM echo_index_sources WHERE echo_source_id = ?').get(v3Id);
    assert.equal(sourceRow.generation, 2);
    assert.equal(sourceRow.source_path, identity.sourcePath);
    assert.equal(sourceRow.source_version, SOURCE_VERSION);
    assert.equal(countOf(gen2Store, 'echo_source_builds'), 3, 'one build row per committed generation (v3 gen1, v3 gen2, v4 gen1)');
    assert.equal(countWhere(gen2Store, 'echo_source_builds', "echo_source_id = '" + v3Id + "'"), 2);
    assert.equal(gen2Store.echoOpen('log:' + sid + '#seq=2').word.text, 'v3 second turn');
    assert.equal(gen2Store.echoOpen('log:' + sid + '#seq=1').word.text, 'v3 payload');
    assert.equal(gen2Store.echoOpen('idx:cmp-shared', { echoSourceId: v3Id }).summary.summary, 'v3 summary v2');
    assert.deepEqual(gen2Store.echoOpen('idx:cmp-shared', { echoSourceId: v3Id }).srcSeqs, [1, 2]);
    void 0;
  } finally { gen2Store.close(); }
  // 代次倒退：不抛，而是**记成终态**（库里的游标说了算，回执说 STALE_GENERATION）
  const staleRun = importPerSource({ root: work, dbPath, rows: [{ ...gen2Row, generation: 1 }] });
  assert.deepEqual(staleRun.outcomes.map((outcome) => outcome.status), ['STALE_GENERATION']);
  assert.equal(staleRun.counts.failed, 1);
  assert.equal(staleRun.conservation.ok, true, JSON.stringify(staleRun.conservation.problems));
  // 跳号：必须正好是库里那一代 + 1
  const gapRun = importPerSource({ root: work, dbPath, rows: [{ ...gen2Row, generation: 4, consumedBytes: 3 }] });
  assert.deepEqual(gapRun.outcomes.map((outcome) => outcome.status), ['GENERATION_GAP']);
  // 库里没有前一代却要 generation 2：本地就拒，不去猜游标
  const noPriorRow = { ...gen2Row, sourceLogPath: 'D:/synthetic/logs/session-noprior.v3.jsonl' };
  const noPrior = importPerSource({ root: path.join(root, 'no-prior-work'), dbPath, rows: [noPriorRow] });
  assert.deepEqual(noPrior.outcomes.map((outcome) => outcome.status), ['GENERATION_REQUIRES_PRIOR']);
  assert.equal(noPrior.conservation.ok, true, JSON.stringify(noPrior.conservation.problems));

  // ── 12. CLI：本工具已 superseded —— 作为脚本运行一律拒绝（stderr + exit 5）──
  // 旧版这一节断言四个退出码（0 / 3 / 1 / 2）——那是**旧逻辑**的契约。
  // 2026-11-16 batch 1 起，本文件的脚本入口只做一件事：打印 SUPERSEDED 并以 5 退出，
  // 一条业务代码都不跑。所以这一节改成对着**那个拒绝**断言：
  //   · 真实子进程跑一次，退出码必须是 5；
  //   · stderr 上必须出现**恰好一次** 'SUPERSEDED: use tools/echo-index-source-snapshot-import.mjs'，
  //     且它是最后一行（Node 的 ExperimentalWarning 可能先来，那不是本工具的输出）；
  //   · stdout 必须为空 —— 拒绝不该顺手打一份看起来正常的摘要；
  //   · 作为**模块**导入仍然可用（拒绝只发生在脚本入口）。
  // ★ node 路径写死（不再用 process.execPath）：这条断言要考的是「真的起得来一个子进程」，
  //   起不来是**失败**，不是跳过。
  const NODE_BIN = process.env.ECHO_NODE_BIN
    || 'C:/Users/pc/.workbuddy/binaries/node/versions/22.22.2-3/node.exe';
  assert.equal(fs.existsSync(NODE_BIN), true, 'no usable node binary at ' + NODE_BIN + ' — this is a FAILURE, not a skip');
  const SUPERSEDED_LINE = 'SUPERSEDED: use tools/echo-index-source-snapshot-import.mjs';
  const supersededRun = spawnSync(NODE_BIN, [toolPath], { encoding: 'utf8' });
  assert.equal(supersededRun.status, 5, 'the superseded tool must exit 5 when run as a script: ' + supersededRun.stderr);
  const stderrLines = String(supersededRun.stderr).split('\n').map((s) => s.trim()).filter(Boolean);
  assert.equal(stderrLines[stderrLines.length - 1], SUPERSEDED_LINE, 'stderr must end with the SUPERSEDED line');
  assert.equal(stderrLines.filter((l) => l === SUPERSEDED_LINE).length, 1, 'exactly one SUPERSEDED line');
  assert.equal(String(supersededRun.stdout), '', 'a refused script entry must not print a summary');
  // 作为模块导入仍然可用：绑定还在、形状还对（上面那些 import 走到这里就已经是证据，
  // 这里再对着它们断言一次，免得「导入成功」被读成「没被检查」）。
  assert.equal(typeof importPerSource, 'function');
  assert.equal(typeof preflightSourceRows, 'function');
  assert.equal(typeof classifySource, 'function');
  assert.equal(typeof EXIT, 'object');
  assert.equal(EXIT.ok, 0);
  assert.equal(typeof NAMESPACE_BY_SOURCE, 'object');
  assert.equal(typeof SOURCE_PATH_ROOT, 'string');

  // ── 13. 就绪自检：体检器对本库的结论 ────────────────────────────────────
  const finalAudit = auditTempDb(dbPath);
  assert.equal(finalAudit.available, true);
  assert.equal(finalAudit.ok, true, JSON.stringify(finalAudit.problems));
  assert.deepEqual(finalAudit.problems, []);
  assert.equal(finalAudit.sources.length, 2);
  const gen2AuditSource = finalAudit.sources.find((source) => source.echoSourceId === v3Id);
  assert.equal(gen2AuditSource.generation, 2);

  console.log(JSON.stringify({
    ok: true,
    identity: { v3: identity.sourcePath, v4: identityV4.sourcePath },
    statuses: { main: applied.outcomes.map((outcome) => outcome.status), rerun: rerun.outcomes.map((outcome) => outcome.status) },
    counts: { main: applied.counts, rerun: rerun.counts, mixed: mixed.counts },
    conservation: { main: applied.conservation.ok, rerun: rerun.conservation.ok, gen2: gen2.conservation.ok },
    integrity: { main: applied.integrity.ok, final: finalAudit.ok, sources: finalAudit.sources.length },
    cliSuperseded: { status: supersededRun.status, line: SUPERSEDED_LINE },
    journalEntries: journalLines.length,
    manifestShas: sourceEntries.slice(0, 2).map((entry) => entry.manifestSha && entry.manifestSha.slice(0, 12)),
  }, null, 2));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
