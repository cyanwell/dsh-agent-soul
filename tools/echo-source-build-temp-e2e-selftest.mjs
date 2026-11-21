#!/usr/bin/env node
// TEMP-only end-to-end test: one os.tmpdir root, existing builder -> existing TEMP reader -> new adapter.
// No live data/index/session/log/02-墨/production DB/config/MCP/service/model/network is touched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openMetaStore, SCHEMA_VERSION } from '../src/db/index.mjs';
import { openDatabase, configureConnection } from '../src/db/engine.mjs';
import { buildSource, buildFromMetaSqlite, syncFromSessionTail, buildFromEchoIndexFiles, SESSION_TAIL_WORD_KINDS, ECHO_INDEX_FEED_VERSION } from './echo-source-build.mjs';
import { readSyntheticEchoRoot } from './echo-source-temp-reader.mjs';
import { parseSyntheticEchoShards } from './echo-source-shard-parser.mjs';
import { parseSyntheticEchoImporterShards, IMPORTER_WORD_FIELDS, IMPORTER_SUMMARY_FIELDS } from './echo-source-shard-importer-adapter.mjs';
import { ECHO_WORD_FIELDS, ECHO_SUMMARY_FIELDS } from './echo-index-import.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-source-build-temp-e2e-'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const line = (x) => JSON.stringify(x) + '\n';
const SESSION = 'session-e2e-a1';
const SOURCE_PATH = 'D:/synthetic/echo-source-build-temp-e2e/index';
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log('PASS ' + name); }
  catch (e) { failed += 1; console.error('FAIL ' + name + ': ' + (e && e.stack || e)); }
}

const INPUT_ROWS = [
  { seq: 0, t: '2026-11-15T09:00:00.000Z', session: SESSION, ws: '--synthetic-workspace--', role: 'user', text: 'Synthetic query alpha' },
  { seq: 1, t: '2026-11-15T09:00:01.000Z', session: SESSION, ws: '--synthetic-workspace--', role: 'assistant', text: 'Synthetic response beta' }
];
// srcSeqs are deliberately ordered and repeated ([1,0,1]); they describe declarations, not coverage.
const SUMMARY_ROWS = [
  { cmpId: 'cmp-e2e-alpha', t: '2026-11-15T09:05:00.000Z', session: SESSION, ws: '--synthetic-workspace--', log: null, srcSeqs: [1, 0, 1], shadowedTokens: 12, shadowedChars: 34, provider: 'synthetic', model: 'synthetic-summary-1', status: 'active', summary: 'Synthetic summary of alpha and beta' },
  { cmpId: 'cmp-e2e-void', t: '2026-11-15T09:06:00.000Z', session: SESSION, ws: null, log: null, srcSeqs: [0], shadowedTokens: 0, shadowedChars: 0, provider: null, model: null, status: 'void', summary: 'Synthetic voided summary' }
];
const EXPECTED_WORDS = [{ session: SESSION, seq: 0 }, { session: SESSION, seq: 1 }];
const EXPECTED_SUMMARIES = [
  { cmpId: 'cmp-e2e-alpha', session: SESSION, srcSeqs: [1, 0, 1] },
  { cmpId: 'cmp-e2e-void', session: SESSION, srcSeqs: [0] }
];


// ════════════════════════════════════════════════════════════════════════════
// source-backed builder（--db / buildFromMetaSqlite）的 TEMP 夹具
//   · v4 源库用**本仓现有 schema + import 路径**造（openMetaStore + migrate + store.ingest）
//   · 源身份一律 D:/synthetic/…，不含任何真实身份
//   · 跑完连同 ROOT 一起删
// ════════════════════════════════════════════════════════════════════════════
const V4_SOURCE_ID = 'v4-synthetic-e2e';
const V4_RAW_ROOT = 'D:/synthetic/echo-source-build-temp-e2e/v4';
const V4_LOG = V4_RAW_ROOT + '/frames.jsonl';
const V4_S1 = 'session-v4-src-a1';
const V4_S2 = 'session-v4-src-b2';
const V4_SOURCE_PATH = 'D:/synthetic/echo-source-build-temp-e2e/v4-index';
const V4_BUILT_AT = '2026-11-15T10:10:00.000Z';
const posix = (p) => String(p).replace(/\\/g, '/');

// 摘要帧正文故意用「奇怪空格」写法：源库里的那串字节必须原样落到 summaries.jsonl。
const SUMMARY_PAYLOAD = {
  cmpId: 'cmp-v4-alpha', t: '2026-11-15T10:04:00.000Z', session: V4_S1, ws: null, log: null,
  srcSeqs: [5, 1, 5], shadowedTokens: 7, shadowedChars: 19, provider: 'synthetic', model: 'synthetic-summary-1',
  status: 'active', summary: 'Synthetic v4 summary of gamma delta epsilon'
};
const SUMMARY_TEXT = JSON.stringify(SUMMARY_PAYLOAD).replace(/":/g, '": ').replace(/,"/g, ', "');

const V4_FRAMES = [
  { session: V4_S1, seq: 0, type: 'session', t: '2026-11-15T10:00:00.000Z', text: 'Synthetic v4 session header' },
  { session: V4_S1, seq: 1, type: 'user', t: '2026-11-15T10:00:01.000Z', text: 'Synthetic v4 query gamma' },
  { session: V4_S1, seq: 2, type: 'assistant', t: '2026-11-15T10:00:02.000Z', text: 'Synthetic v4 response delta' },
  { session: V4_S1, seq: 3, type: 'reasoning', t: '2026-11-15T10:00:03.000Z', text: 'Synthetic v4 chain of thought' },
  { session: V4_S1, seq: 4, type: 'tool_call', t: '2026-11-15T10:00:04.000Z', text: '[工具] synthetic-tool synthetic-args' },
  { session: V4_S1, seq: 5, type: 'assistant', t: '2026-11-15T10:00:05.000Z', text: 'Synthetic v4 response epsilon' },
  { session: V4_S1, seq: 6, type: 'system', t: '2026-11-15T10:00:06.000Z', text: 'Synthetic v4 system note' },
  { session: V4_S1, seq: 7, type: 'summary', t: '2026-11-15T10:00:07.000Z', text: SUMMARY_TEXT },
  { session: V4_S2, seq: 0, type: 'user', t: '2026-11-15T10:00:08.000Z', text: 'Synthetic v4 query zeta' }
];
const EXPECTED_V4_WORDS = [
  { session: V4_S1, seq: 1, role: 'user', text: 'Synthetic v4 query gamma' },
  { session: V4_S1, seq: 2, role: 'assistant', text: 'Synthetic v4 response delta' },
  { session: V4_S1, seq: 5, role: 'assistant', text: 'Synthetic v4 response epsilon' },
  { session: V4_S2, seq: 0, role: 'user', text: 'Synthetic v4 query zeta' }
];

function makeV9(dbFile) {
  const store = openMetaStore({ path: dbFile, mode: 'readwrite' });
  try { store.migrate(); } finally { store.close(); }
}
// 走**现有** import 路径（store.ingest）造 TEMP v4 源库 —— 不手写 SQL、不 migrate 任何新结构。
function makeV4Source(dbFile, frames, options) {
  const o = options || {};
  const sourceId = o.sourceId || V4_SOURCE_ID;
  const rawRoot = o.rawRoot || V4_RAW_ROOT;
  const logPath = rawRoot + '/frames.jsonl';
  const store = openMetaStore({ path: dbFile, mode: 'readwrite' });
  const ordinals = new Map();
  try {
    store.migrate();
    for (const f of frames) {
      const ordinal = ordinals.get(f.session) || 0;
      ordinals.set(f.session, ordinal + 1);
      store.ingest({
        source: { sourceId, kind: 'v4-mirror', namespace: 'v4log', authority: 'mirror', rawPath: rawRoot, pathKind: 'dir' },
        session: { sessionId: f.session },
        frame: { seq: f.seq, frameOrdinal: ordinal, rawPath: logPath, text: f.text, type: f.type, eventAt: f.t }
      });
    }
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally { store.close(); }
  // 关掉 WAL：只读打开一个纯 rollback-journal 库，源库旁边才不会留 -wal/-shm。
  const raw = openDatabase(dbFile, { readOnly: false });
  try { configureConnection(raw, { memory: true }); raw.exec('PRAGMA journal_mode = DELETE'); }
  finally { raw.close(); }
  return { sourceId, rawRoot, logPath };
}
function dbFingerprint(dbFile) {
  const st = fs.statSync(dbFile);
  return {
    sha256: sha(fs.readFileSync(dbFile)), bytes: st.size, mtimeMs: st.mtimeMs,
    dir: fs.readdirSync(path.dirname(dbFile)).slice().sort()
  };
}
function importBuilt(manifestPath, dbFile, generation) {
  const gen = generation === undefined ? '1' : String(generation);
  const result = spawnSync(NODE, [path.join(HERE, 'echo-index-import.mjs'), '--manifest', manifestPath, '--sha256', sha(fs.readFileSync(manifestPath)), '--generation', gen, '--db', dbFile, '--json'], { encoding: 'utf8' });
  let receipt;
  try { receipt = JSON.parse(result.stdout); } catch (e) { throw new Error('importer CLI returned invalid JSON (exit ' + result.status + '): ' + (result.stderr || '').slice(0, 300)); }
  if (result.status !== 0) { const error = new Error('importer CLI failed (' + result.status + '): ' + receipt.code + ' ' + (receipt.message || '')); error.receipt = receipt; throw error; }
  return receipt;
}
function cliBuilder(args) { 
  return spawnSync(NODE, [path.join(HERE, 'echo-source-build.mjs'), ...args], { encoding: 'utf8' });
}

try {
  const inputPath = path.join(ROOT, 'input.jsonl');
  const summaryInputPath = path.join(ROOT, 'summaries-input.jsonl');
  const inputBytes = Buffer.from(INPUT_ROWS.map(line).join(''), 'utf8');
  const summaryInputBytes = Buffer.from(SUMMARY_ROWS.map(line).join(''), 'utf8');
  fs.writeFileSync(inputPath, inputBytes);
  fs.writeFileSync(summaryInputPath, summaryInputBytes);

  const built = buildSource({
    input: inputPath,
    summariesPath: summaryInputPath,
    outDir: path.join(ROOT, 'build'),
    sourcePath: SOURCE_PATH,
    namespace: 'log',
    generation: 1,
    builtAt: '2026-11-15T09:10:00.000Z',
    cursorSeq: 1
  });
  // Source version is the builder's emitted version, not a hand-picked string.
  const source = { sourcePath: built.manifest.sourcePath, version: built.manifest.version, namespace: built.manifest.namespace };
  const wordsBytes = fs.readFileSync(built.wordsPath);
  const summariesBytes = fs.readFileSync(built.summariesPath);

  check('builder emits the importer field set; adapter field copy matches the importer exactly', () => {
    assert.deepEqual([...IMPORTER_WORD_FIELDS], [...ECHO_WORD_FIELDS]);
    assert.deepEqual([...IMPORTER_SUMMARY_FIELDS], [...ECHO_SUMMARY_FIELDS]);
    const rows = wordsBytes.toString('utf8').trimEnd().split('\n').map(JSON.parse);
    assert.equal(rows.length, 2);
    for (const row of rows) assert.deepEqual(Object.keys(row), [...ECHO_WORD_FIELDS]);
    assert.deepEqual(rows.map((r) => r.seq), [0, 1]);
    assert.equal(built.manifest.version, 'synthetic-source/1');
    assert.equal(source.sourcePath, SOURCE_PATH);
    assert.equal(built.manifest.words.bytes, wordsBytes.length);
    assert.equal(built.manifest.summaries.bytes, summariesBytes.length);
    assert.deepEqual(summariesBytes, summaryInputBytes);
  });

  // ── 1. default reader (no format field) stays legacy: the OLD row parser cannot take it ──
  const read = readSyntheticEchoRoot({
    root: ROOT,
    source,
    shards: [{
      shardId: 'build-words',
      wordPath: 'build/words.jsonl',
      summaryPath: 'build/summaries.jsonl',
      expectedWords: EXPECTED_WORDS,
      expectedSummaries: EXPECTED_SUMMARIES,
      expectedByteEnd: built.manifest.words.bytes,
      expectedCursorSeq: 1
    }]
  });

  check('default legacy mode still rejects the turn field as unsupported', () => {
    const receipt = read.parsedShards[0].receipt;
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.rows.length, 0);
    assert.equal(receipt.consumedBytes, 0);
    const failedShard = read.readerProblems.find((p) => p.type === 'failed-shard');
    assert.ok(failedShard, JSON.stringify(read.readerProblems));
    assert.match(failedShard.detail, /unsupported field turn/);
    assert.equal(read.sourceAudit.sourceReadCoverage, 'unknown');
    assert.equal(read.coverageAudit.ok, false);
    assert.ok(read.coverageAudit.problems.some((p) => p.type === 'missing-shard'));
  });

  // ── 1b. same reader, explicit format:'importer', over the very same generated files ──
  const importerRead = readSyntheticEchoRoot({
    root: ROOT,
    source,
    format: 'importer',
    shards: [{
      shardId: 'build-words',
      wordPath: 'build/words.jsonl',
      summaryPath: 'build/summaries.jsonl',
      expectedWords: EXPECTED_WORDS,
      expectedSummaries: EXPECTED_SUMMARIES,
      expectedByteEnd: built.manifest.words.bytes,
      expectedCursorSeq: 1
    }]
  });
  const importerReceipt = importerRead.parsedShards[0].receipt;

  check('format=importer reads the generated TEMP files with complete audits and exact refs', () => {
    assert.equal(importerReceipt.status, 'complete');
    assert.equal(importerReceipt.rows.length, 2);
    assert.deepEqual(importerReceipt.rows, EXPECTED_WORDS);
    assert.equal(importerReceipt.cursorSeq, 1);
    assert.equal(importerReceipt.byteLength, built.manifest.words.bytes);
    assert.equal(importerReceipt.consumedBytes, wordsBytes.length);
    assert.equal(importerReceipt.completeFrameBoundary, true);
    assert.equal(importerReceipt.malformedTail, false);
    assert.equal(importerRead.sourceAudit.sourceReadCoverage, 'complete');
    assert.deepEqual(importerRead.readerProblems, []);
    assert.equal(importerRead.coverageAudit.ok, true, JSON.stringify(importerRead.coverageAudit));
    assert.deepEqual(importerRead.coverageAudit.problems, []);
    assert.deepEqual(importerRead.sourceAudit.derivedSnapshot.shards[0].words, EXPECTED_WORDS);
    assert.deepEqual(importerRead.summaryRefAudit, { checked: 4, resolvedPresent: 4, resolvedDeclaredOnly: 0, missing: 0 });
    assert.equal(importerRead.parsedShards[0].path, path.join(fs.realpathSync(ROOT), 'build', 'words.jsonl').replace(/\\/g, '/'));
  });

  check('format=importer keeps the summary raw lines byte-exact on disk', () => {
    const rawLines = summariesBytes.toString('utf8').trimEnd().split('\n');
    assert.deepEqual(importerReceipt.summaries.map((s) => s.rawLine), rawLines);
    assert.deepEqual(importerReceipt.summaries.map((s) => s.srcSeqs), [[1, 0, 1], [0]]);
    assert.deepEqual(importerReceipt.summaries.map((s) => s.cmpId), ['cmp-e2e-alpha', 'cmp-e2e-void']);
    assert.equal(importerReceipt.summaries.map((s) => s.rawLine + '\n').join(''), summariesBytes.toString('utf8'));
    assert.equal(importerReceipt.summaryByteLength, built.manifest.summaries.bytes);
    assert.equal(importerReceipt.summaryLineCount, 2);
  });

  check('format is explicit: an unknown value is rejected instead of falling back', () => {
    assert.throws(() => readSyntheticEchoRoot({
      root: ROOT, source, format: 'auto',
      shards: [{ shardId: 'build-words', wordPath: 'build/words.jsonl', summaryPath: 'build/summaries.jsonl', expectedWords: EXPECTED_WORDS, expectedSummaries: EXPECTED_SUMMARIES }]
    }), /format must be 'legacy' or 'importer'/);
  });

  check('the failure is schema-only: the same records in the old 6-field row shape parse complete', () => {
    const oldRows = wordsBytes.toString('utf8').trimEnd().split('\n').map((l) => {
      const r = JSON.parse(l);
      return { seq: r.seq, t: r.t, session: r.session, ws: r.ws, role: r.role, text: r.text };
    });
    const oldBytes = Buffer.from(oldRows.map(line).join(''), 'utf8');
    const parsed = parseSyntheticEchoShards({
      source: { sourcePath: 'D:/synthetic/echo-source-build-temp-e2e/old-shape', version: source.version, namespace: 'log' },
      shards: [{
        shardId: 'old-shape', path: 'D:/synthetic/echo-source-build-temp-e2e/old-shape/words.jsonl', bytes: oldBytes,
        expectedWords: EXPECTED_WORDS, expectedSummaries: []
      }]
    });
    assert.equal(parsed.parsedShards[0].receipt.status, 'complete');
    assert.equal(parsed.sourceAudit.sourceReadCoverage, 'complete');
    assert.deepEqual(parsed.parsedShards[0].receipt.rows, EXPECTED_WORDS);
  });

  // ── 2. the new adapter over the very same builder bytes (memory only) ──
  const before = { words: Buffer.from(wordsBytes), summaries: Buffer.from(summariesBytes) };
  const adapted = parseSyntheticEchoImporterShards({
    source,
    shards: [{
      shardId: 'build-words',
      path: SOURCE_PATH + '/words.jsonl',
      bytes: wordsBytes,                       // Buffer is a Uint8Array; no path is ever opened by the adapter
      summaryBytes: summariesBytes,
      expectedWords: EXPECTED_WORDS,
      expectedSummaries: EXPECTED_SUMMARIES,
      expectedByteEnd: built.manifest.words.bytes,
      expectedCursorSeq: 1
    }]
  });
  const receipt = adapted.parsedShards[0].receipt;

  check('adapter reads the builder bytes as a complete source with exact word accounting', () => {
    assert.equal(receipt.status, 'complete');
    assert.equal(receipt.cursorSeq, 1);
    assert.deepEqual(receipt.rows, EXPECTED_WORDS);
    assert.equal(receipt.consumedBytes, built.manifest.words.bytes);
    assert.equal(receipt.consumedBytes, wordsBytes.length);
    assert.equal(receipt.byteLength, wordsBytes.length);
    assert.equal(receipt.lineCount, 2);
    assert.equal(receipt.completeFrameBoundary, true);
    assert.equal(receipt.malformedTail, false);
    const lines = adapted.parsedShards[0].wordLines;
    assert.equal(lines.reduce((n, l) => n + l.bytes, 0), wordsBytes.length);
    assert.equal(lines[0].byteStart, 0);
    assert.equal(lines[1].byteEnd, wordsBytes.length);
    assert.equal(lines[0].rawLine, wordsBytes.toString('utf8').split('\n')[0]);
  });

  check('adapter keeps summary raw lines byte-exact and their ordered srcSeqs intact', () => {
    assert.equal(receipt.summaryByteLength, built.manifest.summaries.bytes);
    assert.equal(receipt.summaryByteLength, summariesBytes.length);
    assert.equal(receipt.summaryLineCount, 2);
    const rawLines = summariesBytes.toString('utf8').trimEnd().split('\n');
    assert.deepEqual(receipt.summaries.map((s) => s.rawLine), rawLines);
    assert.deepEqual(receipt.summaries.map((s) => s.srcSeqs), [[1, 0, 1], [0]]);
    assert.deepEqual(receipt.summaries.map((s) => s.cmpId), ['cmp-e2e-alpha', 'cmp-e2e-void']);
    // Reassembling the parsed raw lines with their terminators reproduces the file, byte for byte.
    assert.equal(receipt.summaries.map((s) => s.rawLine + '\n').join(''), summariesBytes.toString('utf8'));
    const summaryLines = adapted.parsedShards[0].summaryLines;
    assert.equal(summaryLines.reduce((n, l) => n + l.bytes, 0), summariesBytes.length);
  });

  check('adapter audit is complete and summary refs resolve against present words only', () => {
    assert.equal(adapted.sourceAudit.sourceReadProblems.length, 0, JSON.stringify(adapted.sourceAudit.sourceReadProblems));
    assert.equal(adapted.sourceAudit.sourceReadCoverage, 'complete');
    assert.deepEqual(adapted.sourceAudit.derivedSnapshot.shards[0].words, EXPECTED_WORDS);
    assert.deepEqual(adapted.sourceAudit.derivedSnapshot.shards[0].summaries, EXPECTED_SUMMARIES);
    assert.equal(adapted.sourceAudit.derivedSnapshot.shards[0].cursorSeq, 1);
    assert.equal(adapted.coverageAudit.ok, true, JSON.stringify(adapted.coverageAudit));
    assert.deepEqual(adapted.coverageAudit.problems, []);
    assert.deepEqual(adapted.summaryRefAudit, { checked: 4, resolvedPresent: 4, resolvedDeclaredOnly: 0, missing: 0 });
    assert.equal(adapted.sourceAudit.sourceInventory[0].path, SOURCE_PATH + '/words.jsonl');
  });

  check('adapter is deterministic and leaves the caller bytes untouched', () => {
    const again = parseSyntheticEchoImporterShards({
      source,
      shards: [{
        shardId: 'build-words', path: SOURCE_PATH + '/words.jsonl', bytes: wordsBytes, summaryBytes: summariesBytes,
        expectedWords: EXPECTED_WORDS, expectedSummaries: EXPECTED_SUMMARIES,
        expectedByteEnd: built.manifest.words.bytes, expectedCursorSeq: 1
      }]
    });
    assert.deepEqual(again, adapted);
    assert.deepEqual(wordsBytes, before.words);
    assert.deepEqual(summariesBytes, before.summaries);
  });

  check('a summary ref that survives neither present nor declared words fails the synthetic path', () => {
    const dangling = SUMMARY_ROWS.map((r, i) => i === 0 ? { ...r, summary: 'Synthetic summary with a dangling ref' } : r);
    const rows = [SUMMARY_ROWS[0], SUMMARY_ROWS[1]];
    const badFirst = { ...rows[0], srcSeqs: [1, 0, 7] };
    const badBytes = Buffer.from([badFirst, rows[1]].map(line).join(''), 'utf8');
    const result = parseSyntheticEchoImporterShards({
      source,
      shards: [{
        shardId: 'build-words', path: SOURCE_PATH + '/words.jsonl', bytes: wordsBytes, summaryBytes: badBytes,
        expectedWords: EXPECTED_WORDS,
        expectedSummaries: [{ cmpId: rows[0].cmpId, session: SESSION, srcSeqs: [1, 0, 7] }, EXPECTED_SUMMARIES[1]],
        expectedByteEnd: built.manifest.words.bytes, expectedCursorSeq: 1
      }]
    });
    assert.equal(result.coverageAudit.ok, false);
    assert.ok(result.coverageAudit.problems.some((p) => p.type === 'summary-source-ref-missing' && p.seq === 7));
    assert.notEqual(result.sourceAudit.sourceReadCoverage, 'complete');
    assert.equal(result.summaryRefAudit.missing, 1);
    assert.equal(result.summaryRefAudit.resolvedPresent, 3);
    assert.equal(dangling[0].summary, 'Synthetic summary with a dangling ref');
  });

  check('adapter module stays memory-only: no fs / path import or call in its source', () => {
    const src = fs.readFileSync(path.join(HERE, 'echo-source-shard-importer-adapter.mjs'), 'utf8');
    assert.equal(/from 'node:fs'|from 'node:path'|require\('fs'\)|fs\.(read|open|stat)/.test(src), false);
    assert.equal(/readFileSync|readdirSync|openSync/.test(src), false);
  });

  check('builder output on disk is unchanged by the reader/adapter runs', () => {
    assert.deepEqual(fs.readFileSync(built.wordsPath), before.words);
    assert.deepEqual(fs.readFileSync(built.summariesPath), before.summaries);
    assert.equal(sha(fs.readFileSync(built.wordsPath)), built.manifest.words.sha256);
    assert.equal(sha(fs.readFileSync(built.summariesPath)), built.manifest.summaries.sha256);
  });
  // ══════════════════════════════════════════════════════════════════════════
  // 3. source-backed builder：TEMP v4 源库 → ECHO 三件套 → 第二个 TEMP v9 库
  // ══════════════════════════════════════════════════════════════════════════
  const v4Dir = path.join(ROOT, 'v4');
  fs.mkdirSync(v4Dir, { recursive: true });
  const v4Db = path.join(v4Dir, 'v4-source.sqlite');
  const v4Meta = makeV4Source(v4Db, V4_FRAMES);
  const v4Before = dbFingerprint(v4Db);
  const v4Out = path.join(ROOT, 'v4-build');
  const builtV4 = buildFromMetaSqlite({
    dbPath: v4Db, sourceId: V4_SOURCE_ID, sourcePath: V4_SOURCE_PATH,
    namespace: 'v4log', generation: 1, builtAt: V4_BUILT_AT, outDir: v4Out
  });
  const v4WordsBytes = fs.readFileSync(builtV4.wordsPath);
  const v4SummariesBytes = fs.readFileSync(builtV4.summariesPath);
  const v4WordRows = v4WordsBytes.toString('utf8').trimEnd().split('\n').map(JSON.parse);
  const v4Options = (over) => ({
    dbPath: v4Db, sourceId: V4_SOURCE_ID, sourcePath: V4_SOURCE_PATH, namespace: 'v4log',
    generation: 1, builtAt: V4_BUILT_AT, outDir: path.join(ROOT, 'v4-neg'), ...over
  });
  const assertsNoEligibleV4 = (db) => {
    const outDir = path.join(ROOT, 'v4-neg-no-eligible');
    assert.throws(() => buildFromMetaSqlite(v4Options({ dbPath: db, outDir })), /has no eligible non-truncated user\/assistant frames/);
    assert.equal(fs.existsSync(outDir), false);
  };
  const refusesV4 = (name, over, pattern) => {
    const outDir = path.join(ROOT, 'v4-neg-' + name);
    assert.throws(() => buildFromMetaSqlite(v4Options({ outDir, ...over })), pattern);
    assert.equal(fs.existsSync(outDir), false, name + ' must not create its output directory');
  };

  check('source build emits only eligible v4 frames in stable session/seq order', () => {
    assert.equal(v4WordRows.length, 4);
    assert.deepEqual(v4WordRows.map((r) => ({ session: r.session, seq: r.seq, role: r.role, text: r.text })), EXPECTED_V4_WORDS);
  });

  check('source build keeps the importer field set and invents no ws/turn/log values', () => {
    for (const row of v4WordRows) {
      assert.deepEqual(Object.keys(row), [...ECHO_WORD_FIELDS]);
      assert.equal(row.ws, null);
      assert.equal(row.turn, null);
      assert.equal(row.log, v4Meta.logPath);
      assert.equal(row.kind, row.role);
      assert.equal(row.len, Array.from(row.text).length);
      assert.equal(row.truncated, false);
    }
    assert.deepEqual(Object.keys(v4WordRows[0]), [...IMPORTER_WORD_FIELDS]);
  });

  check('summary-like frame is excluded and source mode emits canonical empty summaries', () => {
    assert.deepEqual(v4SummariesBytes, Buffer.from('\n', 'utf8'));
    assert.equal(builtV4.manifest.summaries.rows, 0);
    assert.equal(builtV4.manifest.summaries.source, 'none');
    assert.equal(builtV4.manifest.summaries.capability, 'unavailable');
    assert.equal(builtV4.manifest.counts.summaries, 0);
    assert.equal(builtV4.manifest.counts.srcSeqs, 0);
    assert.equal(builtV4.manifest.counts.excludedByType.summary, 1);
  });

  check('source manifest counts/cursor/version are the source truth', () => {
    const counts = builtV4.manifest.counts;
    assert.equal(counts.words, 4);
    assert.equal(counts.excludedReasoning, 0);
    assert.equal(counts.scanned, V4_FRAMES.length);
    assert.equal(counts.excluded, 5);
    assert.deepEqual(counts.excludedByType, { session: 1, reasoning: 1, tool_call: 1, system: 1, summary: 1 });
    assert.equal(builtV4.manifest.cursor.seq, 5);
    assert.equal(builtV4.manifest.cursor.inputSha256, v4Before.sha256);
    assert.equal(builtV4.manifest.cursor.inputBytes, v4Before.bytes);
    assert.equal(builtV4.manifest.version, 'v4-source/1');
    assert.equal(builtV4.manifest.sourcePath, V4_SOURCE_PATH);
    assert.equal(builtV4.manifest.namespace, 'v4log');
    assert.equal(builtV4.manifest.sourceInput.schemaVersion, SCHEMA_VERSION);
    assert.equal(builtV4.manifest.sourceInput.sourceId, V4_SOURCE_ID);
    assert.equal(builtV4.manifest.sourceInput.frameCount, V4_FRAMES.length);
  });

  check('source build hashes/bytes/rows match the emitted files', () => {
    assert.equal(builtV4.manifest.words.sha256, sha(v4WordsBytes));
    assert.equal(builtV4.manifest.words.bytes, v4WordsBytes.length);
    assert.equal(builtV4.manifest.words.rows, 4);
    assert.equal(builtV4.manifest.summaries.sha256, sha(v4SummariesBytes));
    assert.equal(builtV4.manifest.summaries.bytes, v4SummariesBytes.length);
    assert.equal(sha(fs.readFileSync(builtV4.manifestPath)), builtV4.manifestSha256);
    assert.equal(v4WordsBytes[v4WordsBytes.length - 1], 10);
    assert.equal(v4SummariesBytes[v4SummariesBytes.length - 1], 10);
  });

  check('source database is never written: hash, mtime and directory unchanged', () => {
    const after = dbFingerprint(v4Db);
    assert.equal(after.sha256, v4Before.sha256);
    assert.equal(after.bytes, v4Before.bytes);
    assert.equal(after.mtimeMs, v4Before.mtimeMs);
    assert.deepEqual(after.dir, ['v4-source.sqlite']);
  });

  const importedV4Db = path.join(ROOT, 'v4-imported.sqlite');
  makeV9(importedV4Db);
  const importedV4 = importBuilt(builtV4.manifestPath, importedV4Db);

  check('importer commits the source-backed words into a SECOND TEMP v9 DB with no summaries', () => {
    assert.equal(importedV4.code, 'IMPORTED');
    assert.equal(importedV4.counts.words, 4);
    assert.equal(importedV4.counts.summaries, 0);
    assert.equal(importedV4.counts.srcSeqs, 0);
    assert.equal(importedV4.counts.excludedReasoning, 0);
    assert.equal(importedV4.inputs.words.sha256, sha(v4WordsBytes));
    assert.equal(importedV4.inputs.summaries.sha256, sha(v4SummariesBytes));
    assert.deepEqual(v4SummariesBytes, Buffer.from('\n', 'utf8'));
    assert.equal(importedV4.source.namespace, 'v4log');
  });

  check('second TEMP DB: stats aligned, included words searchable/open, no idx summary created', () => {
    const store = openMetaStore({ path: importedV4Db, mode: 'readonly' });
    try {
      const stats = store.echoStats();
      assert.equal(stats.available, true);
      assert.equal(stats.aligned, true);
      assert.equal(stats.words, 4);
      assert.equal(stats.summaries, 0);
      const found = store.echoSearch('Synthetic', { surface: 'words', limit: 10 });
      assert.deepEqual(found.results.map((r) => r.ptr).sort(), [
        'v4log:' + V4_S1 + '#seq=1', 'v4log:' + V4_S1 + '#seq=2',
        'v4log:' + V4_S1 + '#seq=5', 'v4log:' + V4_S2 + '#seq=0'
      ]);
      const word = store.echoOpen('v4log:' + V4_S1 + '#seq=5');
      assert.equal(word.status, 'ok');
      assert.equal(word.namespace, 'v4log');
      assert.equal(word.word.text, 'Synthetic v4 response epsilon');
      assert.equal(word.word.contentHash.length, 64);
      assert.throws(() => store.echoOpen('idx:cmp-v4-alpha'), /no ECHO summary indexed/);
    } finally { store.close(); }
  });

  check('missing source row refuses with no outputs', () => {
    refusesV4('missing-source', { sourceId: 'v4-does-not-exist' }, /no v4 source row/);
  });

  check('source mode only reads databases under the OS temp directory', () => {
    refusesV4('outside-temp', { dbPath: path.join(HERE, 'fixtures', 'echo-source-build', 'input.jsonl') }, /under the OS temporary directory/);
    refusesV4('relative-db', { dbPath: 'v4/v4-source.sqlite' }, /dbPath must be an absolute path/);
    refusesV4('missing-db', { dbPath: path.join(v4Dir, 'nope.sqlite') }, /does not exist/);
    refusesV4('db-in-output', { outDir: v4Dir }, /inside the output directory/);
  });

  check('source identity must be stable, canonical and free of output collisions', () => {
    refusesV4('temp-identity', { sourcePath: posix(ROOT) }, /temporary identity/);
    const collided = path.join(ROOT, 'v4-collided-out');
    refusesV4('collision', { outDir: collided, sourcePath: posix(collided) }, /collides with the output directory/);
    refusesV4('bad-source-path', { sourcePath: 'D:/synthetic/../real/index' }, /canonical absolute posix/);
  });

  check('unsupported schema version and missing tables refuse before outputs', () => {
    const v3Db = path.join(v4Dir, 'v3.sqlite');
    fs.copyFileSync(v4Db, v3Db);
    const v3 = openDatabase(v3Db, { readOnly: false });
    try { configureConnection(v3, { memory: true }); v3.exec('DELETE FROM schema_migrations WHERE version >= 4'); }
    finally { v3.close(); }
    refusesV4('unsupported-schema', { dbPath: v3Db }, /unsupported source schema v3/);

    const bareDb = path.join(v4Dir, 'bare.sqlite');
    const bare = openDatabase(bareDb, { readOnly: false });
    try {
      configureConnection(bare, { memory: true });
      bare.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL, node_version TEXT NOT NULL, sqlite_version TEXT NOT NULL)');
      bare.exec("INSERT INTO schema_migrations VALUES (9,'v9','x','2026-11-15T00:00:00.000Z','v24','3.50')");
    } finally { bare.close(); }
    refusesV4('missing-table', { dbPath: bareDb }, /missing required table\(s\): sources/);
  });

  check('empty eligible sets refuse with no outputs (v4 summary frames never reach the builder)', () => {
    // ★ 2026-11-15：这一段原来断言「悬空 srcSeq 42 会被拒」。但 v4 source 模式的既定契约是
    //   **summary 帧按 type 排除、摘要一律发射规范空文件**（同文件 425-433 行就在断言这一点），
    //   所以这里根本到不了「解析 srcSeqs」那一步 —— 那条断言是早期设计的残留，且与本文件自身
    //   的另一组断言互相矛盾。现在按契约改成：summary 帧只计数、不解析、不发射。
    const summaryOnlyDb = path.join(v4Dir, 'summary-only.sqlite');
    makeV4Source(summaryOnlyDb, [
      { session: V4_S1, seq: 0, type: 'user', t: '2026-11-15T10:00:01.000Z', text: 'Synthetic v4 query before summary' },
      { session: V4_S1, seq: 1, type: 'summary', t: '2026-11-15T10:00:02.000Z', text: JSON.stringify({ ...SUMMARY_PAYLOAD, srcSeqs: [0, 42] }) }
    ], { rawRoot: 'D:/synthetic/echo-source-build-temp-e2e/v4-summary-only' });
    const summaryOnlyOut = path.join(ROOT, 'v4-summary-only-out');
    const built = buildFromMetaSqlite(v4Options({ dbPath: summaryOnlyDb, outDir: summaryOnlyOut }));
    assert.equal(built.manifest.counts.summaries, 0);
    assert.equal(built.manifest.counts.excludedByType.summary, 1);
    assert.deepEqual(fs.readFileSync(built.summariesPath), Buffer.from('\n', 'utf8'));

    const emptyDb = path.join(v4Dir, 'no-eligible.sqlite');
    makeV4Source(emptyDb, [
      { session: V4_S1, seq: 0, type: 'reasoning', t: '2026-11-15T10:00:00.000Z', text: 'only reasoning' },
      { session: V4_S1, seq: 1, type: 'tool_result', t: '2026-11-15T10:00:01.000Z', text: '[结果] synthetic tool result' }
    ], { rawRoot: 'D:/synthetic/echo-source-build-temp-e2e/v4-empty' });
    // ★ 2026-11-15：正则对回实现文案（实现是 "has no eligible non-truncated user/assistant frames"）。
    assertsNoEligibleV4(emptyDb);

    // 合格类型但字段坏掉（event_at 不可解析）→ 拒，不是静默丢掉这一帧。
    const badFieldsDb = path.join(v4Dir, 'bad-fields.sqlite');
    makeV4Source(badFieldsDb, [
      { session: V4_S1, seq: 0, type: 'user', t: 'not-a-time', text: 'Synthetic v4 query with a broken event_at' }
    ], { rawRoot: 'D:/synthetic/echo-source-build-temp-e2e/v4-bad-fields' });
    refusesV4('bad-fields', { dbPath: badFieldsDb }, /event_at must be a parseable timestamp/);
  });

  check('source namespace is never invented: a mismatch is a refusal', () => {
    refusesV4('namespace', { namespace: 'log', sourcePath: 'D:/synthetic/echo-source-build-temp-e2e/v4-ns' }, /declares namespace/);
  });

  check('existing outputs are preserved and a write failure rolls the triplet back', () => {
    assert.throws(() => buildFromMetaSqlite(v4Options({ outDir: v4Out })), /refusing to overwrite existing output/);
    assert.equal(sha(fs.readFileSync(path.join(v4Out, 'words.jsonl'))), builtV4.manifest.words.sha256);
    const outDir = path.join(ROOT, 'v4-rollback');
    const originalWrite = fs.writeFileSync;
    let writes = 0;
    fs.writeFileSync = function (file, ...args) {
      writes += 1;
      if (writes === 2) throw new Error('synthetic source second-write failure');
      return originalWrite.call(fs, file, ...args);
    };
    try {
      assert.throws(() => buildFromMetaSqlite(v4Options({ outDir })), /synthetic source second-write failure/);
    } finally { fs.writeFileSync = originalWrite; }
    assert.equal(writes, 2);
    for (const file of ['words.jsonl', 'summaries.jsonl', 'manifest.json']) {
      assert.equal(fs.existsSync(path.join(outDir, file)), false, 'rollback must remove ' + file);
    }
  });

  check('CLI source mode is explicit and refuses mixed/partial flags', () => {
    const cliOut = path.join(ROOT, 'v4-cli');
    const base = ['--db', v4Db, '--source-id', V4_SOURCE_ID, '--out-dir', cliOut, '--source-path', V4_SOURCE_PATH, '--namespace', 'v4log', '--generation', '1', '--built-at', V4_BUILT_AT];
    const ok = cliBuilder(base);
    assert.equal(ok.status, 0, ok.stderr);
    const payload = JSON.parse(ok.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.version, 'v4-source/1');
    assert.equal(payload.counts.words, 4);
    // ★ 2026-11-15：原来写 1 —— 与同一文件 425-433 行（source 模式发射规范空摘要）自相矛盾。
    assert.equal(payload.counts.summaries, 0);
    assert.deepEqual(fs.readFileSync(path.join(cliOut, 'summaries.jsonl')), v4SummariesBytes);

    const mixed = cliBuilder(['--input', path.join(ROOT, 'input.jsonl'), ...base]);
    assert.notEqual(mixed.status, 0);
    assert.match(mixed.stderr, /--input is not allowed with --db/);
    const withSummaries = cliBuilder(['--summaries', path.join(ROOT, 'summaries-input.jsonl'), ...base]);
    assert.notEqual(withSummaries.status, 0);
    assert.match(withSummaries.stderr, /--summaries is not allowed with --db/);
    const missingSourceId = cliBuilder(['--db', v4Db, '--out-dir', path.join(ROOT, 'v4-cli-missing'), '--source-path', V4_SOURCE_PATH, '--namespace', 'v4log', '--generation', '1', '--built-at', V4_BUILT_AT]);
    assert.notEqual(missingSourceId.status, 0);
    assert.match(missingSourceId.stderr, /required argument missing: --source-id/);
    const sourceIdWithoutDb = cliBuilder(['--input', path.join(ROOT, 'input.jsonl'), '--source-id', V4_SOURCE_ID, '--out-dir', path.join(ROOT, 'v4-cli-nodb'), '--source-path', V4_SOURCE_PATH, '--namespace', 'log', '--generation', '1', '--built-at', V4_BUILT_AT, '--cursor-seq', '1']);
    assert.notEqual(sourceIdWithoutDb.status, 0);
    assert.match(sourceIdWithoutDb.stderr, /--source-id requires --db/);
  });

  check('no source-backed run (success or refusal) wrote to the source database', () => {
    const after = dbFingerprint(v4Db);
    assert.equal(after.sha256, v4Before.sha256);
    assert.equal(after.mtimeMs, v4Before.mtimeMs);
    assert.equal(after.bytes, v4Before.bytes);
  });


  // ══════════════════════════════════════════════════════════════════════════
  // 4. TEMP-only incremental tail sync: read-only session logs → ECHO triplet
  //    全部源都在 os.tmpdir 之下；**任何生产路径都不许传进这个写入器**
  //    （构建器自己也会拒：源根不在临时目录且没显式 allowExternalSourceRoot 时直接失败）。
  // ══════════════════════════════════════════════════════════════════════════
  const TAIL = path.join(ROOT, 'tail');
  const TAIL_SESS = path.join(TAIL, 'sessions');
  const TAIL_WS = '--D-AI-synthetic--';
  const TAIL_S1 = 'session-tail-src-a1';
  const TAIL_S2 = 'session-tail-src-b2';
  const TAIL_MANIFEST = path.join(TAIL, 'files.jsonl');
  const tailDb = path.join(TAIL, 'tail-meta.sqlite');
  const tailRecord = (type, seq, time, data) => ({ type, seq, time, data });
  const tailFrames = (recs) => Buffer.concat(recs.map((r) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(r) + '\n', 'utf8'))));
  function tailLog(sid, recs) {
    const dir = path.join(TAIL_SESS, TAIL_WS, sid);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'session.v4.jsonl.zstd');
    fs.writeFileSync(file, tailFrames(recs));
    return file;
  }
  // 第一段会话：一句问、一段答（带 reasoning 块，必须被排除）。
  const TAIL_HEAD_A = [
    { type: 'session', createdAt: 1790100000000, id: TAIL_S1 },
    tailRecord('user/message', 0, 1790100001000, { content: [{ type: 'text', text: 'tail sync query alpha' }] }),
    tailRecord('assistant/message', 1, 1790100002000, { message: { content: [{ type: 'reasoning', text: 'hidden reasoning must never be indexed' }, { type: 'text', text: 'tail sync answer beta' }] } })
  ];
  // 第二段：一段超长回答，把 nextByte 顶到 4096 字节以上（这样 head 指纹真的覆盖到窗口）。
  const TAIL_LONG = 'L'.repeat(6000);
  const TAIL_HEAD_B = [
    { type: 'session', createdAt: 1790100000000, id: TAIL_S2 },
    tailRecord('assistant/message', 0, 1790100001000, { message: { content: [{ type: 'text', text: 'tail sync long answer ' + TAIL_LONG }] } })
  ];
  // 追加段：一条摘要（srcSeqs 里故意带一个悬空 7）+ 一句新提问。
  const TAIL_APPEND_A = [
    tailRecord('compaction/summary', 2, 1790100003000, {
      compactionId: 'cmp-tail-9001', summary: [{ type: 'text', text: 'tail sync summary gamma' }], rawOutput: [],
      shadowedRange: { start: 0, end: 1 }, shadowedSeqs: [1, 0, 7], shadowedTokenCount: 555,
      provider: 'synthetic', model: 'synthetic-flash', maxTokens: 9, usage: {}
    }),
    tailRecord('user/message', 3, 1790100004000, { content: [{ type: 'text', text: 'tail sync query delta' }] })
  ];
  const tailLogA = tailLog(TAIL_S1, TAIL_HEAD_A);
  const tailLogB = tailLog(TAIL_S2, TAIL_HEAD_B);
  function writeTailManifest() {
    const rows = [tailLogA, tailLogB].map((file) => {
      const st = fs.statSync(file);
      return { file, key: st.mtimeMs + ':' + st.size, nextByte: st.size, ws: TAIL_WS, sid: path.basename(path.dirname(file)), nSum: 0, nWord: 0 };
    });
    fs.writeFileSync(TAIL_MANIFEST, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return TAIL_MANIFEST;
  }
  writeTailManifest();
  makeV9(tailDb);
  const tailSync = (gen, extra) => syncFromSessionTail({
    sourceRoot: TAIL_SESS, manifestPath: TAIL_MANIFEST, outDir: path.join(TAIL, 'out', 'g' + gen),
    dbPath: tailDb, builtAt: '2026-11-15T12:00:00.000Z', ...(extra || {})
  });
  const tailStoreRead = (fn) => {
    const store = openMetaStore({ path: tailDb, mode: 'readonly' });
    try { return fn(store); } finally { store.close(); }
  };

  check('tail sync fixtures are TEMP-only and declare nothing outside os.tmpdir', () => {
    const tmp = path.resolve(os.tmpdir());
    for (const row of fs.readFileSync(TAIL_MANIFEST, 'utf8').trimEnd().split('\n').map(JSON.parse)) {
      assert.ok(path.resolve(row.file).startsWith(tmp), 'declared source must live under os.tmpdir: ' + row.file);
    }
    assert.equal(/dsh[\\/]home[\\/]sessions/i.test(fs.readFileSync(TAIL_MANIFEST, 'utf8')), false);
  });

  const tailBuild1 = tailSync(1);
  const tailImport1 = importBuilt(tailBuild1.manifestPath, tailDb, tailBuild1.generation);

  check('tail sync #1 reads each declared log once and imports exact user/assistant frames', () => {
    assert.equal(tailBuild1.generation, 1);
    assert.equal(tailBuild1.manifest.version, 'session-tail/1');
    assert.equal(tailBuild1.manifest.counts.words, 3);
    assert.equal(tailBuild1.manifest.counts.summaries, 0);
    assert.deepEqual(tailBuild1.tail.files.map((f) => f.mode), ['full', 'full']);
    assert.equal(tailBuild1.tail.bytesRead, fs.statSync(tailLogA).size + fs.statSync(tailLogB).size);
    assert.equal(tailBuild1.tail.skippedUnchanged, 0);
    assert.equal(tailImport1.code, 'IMPORTED');
    assert.equal(tailImport1.counts.words, 3);
    assert.equal(tailImport1.counts.excludedReasoning, 0);
  });

  check('tail sync word text is the session source text itself (not an index snippet)', () => {
    const sourceBytes = fs.readFileSync(tailLogA);
    const frames = [];
    const starts = [];
    for (let i = 0; i + 4 <= sourceBytes.length; i += 1) if (sourceBytes[i] === 0x28 && sourceBytes[i + 1] === 0xb5 && sourceBytes[i + 2] === 0x2f && sourceBytes[i + 3] === 0xfd) starts.push(i);
    for (let k = 0; k < starts.length; k += 1) {
      const end = k + 1 < starts.length ? starts[k + 1] : sourceBytes.length;
      for (const line of zlib.zstdDecompressSync(sourceBytes.subarray(starts[k], end)).toString('utf8').split('\n')) if (line.trim()) frames.push(JSON.parse(line));
    }
    const fromSource = frames.filter((r) => r.type === 'user/message')[0].data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    tailStoreRead((store) => {
      const opened = store.echoOpen('log:' + TAIL_S1 + '#seq=0');
      assert.equal(opened.status, 'ok');
      assert.equal(opened.word.text, fromSource, 'words.text 必须逐字等于会话日志里的原文');
      assert.equal(opened.word.len, Array.from(fromSource).length);
      assert.equal(opened.word.kind, SESSION_TAIL_WORD_KINDS.user);
      assert.equal(opened.word.contentHash.length, 64);
      const answer = store.echoOpen('log:' + TAIL_S1 + '#seq=1');
      assert.equal(answer.word.text, 'tail sync answer beta');
      assert.equal(answer.word.kind, SESSION_TAIL_WORD_KINDS.assistant);
      assert.equal(store.echoStats().aligned, true);
    });
  });

  const tailWords1 = fs.readFileSync(tailBuild1.wordsPath);
  const tailBuild2 = tailSync(2);
  const tailImport2 = importBuilt(tailBuild2.manifestPath, tailDb, tailBuild2.generation);

  check('tail sync #2 reads zero bytes of unchanged sources and re-emits the same cumulative rows', () => {
    assert.equal(tailBuild2.generation, 2);
    assert.equal(tailBuild2.tail.bytesRead, 0, '未变的源一个字节都不许读');
    assert.equal(tailBuild2.tail.skippedUnchanged, 2);
    assert.deepEqual(tailBuild2.tail.files.map((f) => f.mode), ['unchanged', 'unchanged']);
    assert.equal(tailBuild2.manifest.counts.words, 3);
    assert.deepEqual(fs.readFileSync(tailBuild2.wordsPath), tailWords1, '累计行必须与上一代逐字节一致');
    assert.equal(tailImport2.code, 'IMPORTED');
    assert.equal(tailImport2.counts.words, 3);
  });

  // 追加：只追加在 A 的尾部（模拟真实「只追加」写入），B 保持不变。
  const beforeAppendAMtime = fs.statSync(tailLogA).mtimeMs;
  fs.appendFileSync(tailLogA, tailFrames(TAIL_APPEND_A));
  writeTailManifest();
  const appendedBytes = fs.statSync(tailLogA).size;
  const tailBuild3 = tailSync(3);
  const tailImport3 = importBuilt(tailBuild3.manifestPath, tailDb, tailBuild3.generation);

  check('tail sync #3 reads only the appended tail and adds exactly the new frames', () => {
    assert.equal(tailBuild3.generation, 3);
    const modes = tailBuild3.tail.files.map((f) => f.mode);
    assert.deepEqual(modes.filter((m) => m === 'append').length, 1, 'A 必须被认成 append');
    assert.deepEqual(modes.filter((m) => m === 'unchanged').length, 1, 'B 必须被认成 unchanged');
    const row = tailBuild3.tail.files.find((f) => f.sid === TAIL_S1);
    assert.ok(row.bytesRead > 0 && row.bytesRead < appendedBytes, 'A 只许读追加段（' + row.bytesRead + ' of ' + appendedBytes + '）');
    assert.equal(row.from, row.nextByte - row.bytesRead);
    assert.equal(tailBuild3.manifest.counts.words, 4);
    assert.equal(tailBuild3.manifest.counts.summaries, 1);
    assert.equal(tailImport3.code, 'IMPORTED');
    assert.equal(tailImport3.counts.words, 4);
    assert.equal(tailImport3.counts.summaries, 1);
    assert.equal(tailImport3.counts.srcSeqs, 3);
  });

  check('tail sync keeps declared srcSeqs verbatim and reports the dangling ref instead of dropping it', () => {
    assert.deepEqual(tailBuild3.tail.dangling, [{ cmpId: 'cmp-tail-9001', session: TAIL_S1, seq: 7 }]);
    assert.equal(tailBuild3.manifest.counts.srcSeqResolved, 2);
    assert.equal(tailBuild3.manifest.counts.srcSeqDangling, 1);
    const summaryRows = fs.readFileSync(tailBuild3.summariesPath, 'utf8').trimEnd().split('\n').map(JSON.parse);
    assert.equal(summaryRows.length, 1);
    assert.deepEqual(summaryRows[0].srcSeqs, [1, 0, 7], '声明顺序与重复必须原样保留');
    tailStoreRead((store) => {
      const opened = store.echoOpen('idx:cmp-tail-9001');
      assert.equal(opened.status, 'ok');
      assert.equal(opened.summary.summary, 'tail sync summary gamma');
      assert.deepEqual(opened.srcSeqs, [1, 0, 7]);
      assert.equal(store.echoStats().summaries, 1);
      assert.equal(store.echoStats().aligned, true);
    });
  });

  check('a full tail sync run never writes to the source tree, the manifest or the source files', () => {
    const manifestBytes = fs.readFileSync(TAIL_MANIFEST);
    const before = new Map([[tailLogA, fs.readFileSync(tailLogA)], [tailLogB, fs.readFileSync(tailLogB)]]);
    const stats = new Map([[tailLogA, fs.statSync(tailLogA)], [tailLogB, fs.statSync(tailLogB)]]);
    tailSync(4);
    assert.deepEqual(fs.readFileSync(TAIL_MANIFEST), manifestBytes);
    for (const [file, bytes] of before) {
      assert.deepEqual(fs.readFileSync(file), bytes, '源文件内容必须逐字节不变: ' + file);
      const after = fs.statSync(file);
      assert.equal(after.mtimeMs, stats.get(file).mtimeMs, '源文件 mtime 必须不变: ' + file);
    }
    // 源树里不许出现任何派生文件
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    const names = walk(TAIL_SESS).map((f) => path.basename(f));
    assert.deepEqual(names.sort(), ['session.v4.jsonl.zstd', 'session.v4.jsonl.zstd']);
  });

  check('tail sync refuses truncation and in-place rotation unless fullRebuild is explicit', () => {
    const kept = fs.readFileSync(tailLogA);
    const keptStat = fs.statSync(tailLogA);
    // 截断：变短 = 截断，默认拒绝
    fs.writeFileSync(tailLogA, kept.subarray(0, kept.length - 5));
    assert.throws(() => tailSync(5), /truncation/);
    assert.equal(fs.existsSync(path.join(TAIL, 'out', 'g5')), false);
    // 轮转：同长但内容变了、mtime 也不同 → 拒绝
    const flipped = Buffer.from(kept);
    flipped[Math.floor(flipped.length / 2)] ^= 0xff;
    fs.writeFileSync(tailLogA, flipped);
    fs.utimesSync(tailLogA, keptStat.atime, new Date(keptStat.mtimeMs - 120000));
    assert.throws(() => tailSync(6), /rewritten in place|rotation suspected/);
    // 恢复原文后，显式 fullRebuild 允许从头重建
    fs.writeFileSync(tailLogA, kept);
    fs.utimesSync(tailLogA, keptStat.atime, new Date(keptStat.mtimeMs));
    const rebuilt = tailSync(7, { fullRebuild: true });
    assert.equal(rebuilt.generation, 4, '重建也是一步一代（上一代是 3）');
    const rebuiltImport = importBuilt(rebuilt.manifestPath, tailDb, rebuilt.generation);
    assert.equal(rebuiltImport.code, 'IMPORTED');
    assert.equal(rebuilt.manifest.counts.words, 4);
    assert.equal(rebuilt.manifest.counts.summaries, 1);
    assert.deepEqual(rebuilt.tail.files.map((f) => f.mode), ['full-rebuild', 'full-rebuild']);
    assert.equal(rebuilt.manifest.sourceInput.fullRebuild, true);
  });

  check('tail sync cursor is persisted only in the TEMP v9 target and advances one generation at a time', () => {
    const db = openDatabase(tailDb, { readOnly: false });
    try {
      configureConnection(db, { memory: true });
      const row = db.prepare('SELECT generation, state, cursor_json FROM echo_index_sources').get();
      assert.equal(row.state, 'committed');
      assert.equal(Number(row.generation), 4);
      const cursor = JSON.parse(row.cursor_json);
      assert.equal(cursor.tail.version, 'session-tail/1');
      const normalizePath = (value) => path.resolve(value).split(path.sep).join('/');
      assert.deepEqual(Object.keys(cursor.tail.files).map(normalizePath).sort(), [tailLogA, tailLogB].map(normalizePath).sort());
      for (const entry of Object.values(cursor.tail.files)) {
        assert.equal(typeof entry.key, 'string');
        assert.equal(Number.isSafeInteger(entry.nextByte), true);
        assert.equal(entry.head.length, 64);
      }
      assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM echo_source_builds').get().n), 4, '每代一条审计行（1..4）');
      assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM echo_words').get().n), 4);
      assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM echo_summary_src_seqs').get().n), 3);
    } finally { db.close(); }
    // 目标库之外没有 sidecar 状态文件
    const sidecars = fs.readdirSync(TAIL).filter((f) => /cursor|state|\.json$/i.test(f) && f !== 'files.jsonl');
    assert.deepEqual(sidecars, []);
  });


  check('tail E2E: open tail generation resumes after append and emits the completed frame exactly once', () => {
    const tailRoot = path.join(ROOT, 'open-tail', 'sessions');
    const ws = '--D-AI-open-tail--';
    const sid = 'session-open-tail-a1';
    const dir = path.join(tailRoot, ws, sid);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'session.v4.jsonl.zstd');
    const manifestPath = path.join(ROOT, 'open-tail', 'files.jsonl');
    const openRec = { type: 'user/message', seq: 0, time: 1792000000000, data: { content: [{ type: 'text', text: 'open tail first' }] } };
    const laterRec = { type: 'assistant/message', seq: 1, time: 1792000001000, data: { message: { content: [{ type: 'text', text: 'completed second frame' }] } } };
    const firstFrame = zlib.zstdCompressSync(Buffer.from(JSON.stringify(openRec) + '\n', 'utf8'));
    const secondFrame = zlib.zstdCompressSync(Buffer.from(JSON.stringify(laterRec) + '\n', 'utf8'));
    const partialSecond = secondFrame.subarray(0, secondFrame.length - 6);
    const partialBytes = Buffer.concat([firstFrame, partialSecond]);
    fs.writeFileSync(file, partialBytes);
    fs.writeFileSync(manifestPath, JSON.stringify({ file, sid, ws }) + '\n');
    const dbPath = path.join(ROOT, 'open-tail', 'target.sqlite');
    makeV9(dbPath);
    const build = (generation) => syncFromSessionTail({
      sourceRoot: tailRoot, manifestPath, dbPath,
      outDir: path.join(ROOT, 'open-tail', 'out-g' + generation),
      builtAt: '2026-11-15T12:00:00.000Z'
    });
    const first = build(1);
    assert.equal(first.tail.files[0].openTail, true);
    assert.equal(first.tail.files[0].nextByte, firstFrame.length);
    const cursorPath = Object.keys(first.manifest.cursor.tail.files).find((key) => path.resolve(key) === path.resolve(file));
    assert.ok(cursorPath, 'cursor stores the source path');
    assert.equal(first.manifest.cursor.tail.files[cursorPath].nextByte, firstFrame.length);
    const firstImport = importBuilt(first.manifestPath, dbPath, first.generation);
    assert.equal(firstImport.code, 'IMPORTED');
    assert.equal(firstImport.counts.words, 1);
    const firstStore = openMetaStore({ path: dbPath, mode: 'readonly' });
    try { assert.equal(firstStore.echoOpen('log:' + sid + '#seq=0').word.text, 'open tail first'); }
    finally { firstStore.close(); }

    fs.appendFileSync(file, secondFrame.subarray(partialSecond.length));
    const second = build(2);
    assert.equal(second.generation, 2);
    assert.equal(second.tail.files[0].mode, 'append');
    assert.equal(second.tail.files[0].openTail, false);
    assert.equal(second.tail.files[0].nextByte, fs.statSync(file).size);
    const secondCursorPath = Object.keys(second.manifest.cursor.tail.files).find((key) => path.resolve(key) === path.resolve(file));
    assert.ok(secondCursorPath, 'cursor stores the source path');
    assert.equal(second.manifest.cursor.tail.files[secondCursorPath].nextByte, fs.statSync(file).size);
    const secondImport = importBuilt(second.manifestPath, dbPath, second.generation);
    assert.equal(secondImport.code, 'IMPORTED');
    assert.equal(secondImport.counts.words, 2);
    const store = openMetaStore({ path: dbPath, mode: 'readonly' });
    try {
      const firstPointers = store.echoSearch('open tail first', { surface: 'words', limit: 10 }).results.map((x) => x.ptr);
      const secondPointers = store.echoSearch('completed second frame', { surface: 'words', limit: 10 }).results.map((x) => x.ptr);
      assert.deepEqual(firstPointers, ['log:' + sid + '#seq=0']);
      assert.deepEqual(secondPointers, ['log:' + sid + '#seq=1']);
      const pointers = [...firstPointers, ...secondPointers].sort();
      assert.deepEqual(pointers, ['log:' + sid + '#seq=0', 'log:' + sid + '#seq=1']);
      assert.equal(store.echoOpen('log:' + sid + '#seq=0').word.text, 'open tail first');
      assert.equal(store.echoOpen('log:' + sid + '#seq=1').word.text, 'completed second frame');
      assert.equal(Number(store.db.prepare('SELECT COUNT(*) AS n FROM echo_source_builds').get().n), 2);
    } finally { store.close(); }
  });

  check('tail E2E: pseudo magic in a length-delimited skippable payload does not hide following record', () => {
    const tailRoot = path.join(ROOT, 'pseudo-magic', 'sessions');
    const ws = '--D-AI-pseudo-magic--';
    const sid = 'session-pseudo-magic-a1';
    const dir = path.join(tailRoot, ws, sid);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'session.v4.jsonl.zstd');
    const payload = Buffer.concat([Buffer.from('opaque synthetic metadata ', 'utf8'), Buffer.from([0x28,0xb5,0x2f,0xfd]), Buffer.from(' must not be scanned', 'utf8')]);
    const skipHeader = Buffer.alloc(8);
    skipHeader.set([0x50,0x2a,0x4d,0x18]);
    skipHeader.writeUInt32LE(payload.length, 4);
    const record = { type: 'user/message', seq: 0, time: 1792000100000, data: { content: [{ type: 'text', text: 'one valid record after pseudo magic' }] } };
    const recordFrame = zlib.zstdCompressSync(Buffer.from(JSON.stringify(record) + '\n', 'utf8'));
    const bytes = Buffer.concat([skipHeader, payload, recordFrame]);
    fs.writeFileSync(file, bytes);
    const manifestPath = path.join(ROOT, 'pseudo-magic', 'files.jsonl');
    fs.writeFileSync(manifestPath, JSON.stringify({ file, sid, ws }) + '\n');
    const dbPath = path.join(ROOT, 'pseudo-magic', 'target.sqlite');
    makeV9(dbPath);
    const built = syncFromSessionTail({ sourceRoot: tailRoot, manifestPath, dbPath, outDir: path.join(ROOT, 'pseudo-magic', 'out'), builtAt: '2026-11-15T12:10:00.000Z' });
    assert.equal(built.tail.files[0].nextByte, bytes.length);
    assert.equal(built.tail.files[0].openTail, false);
    const imported = importBuilt(built.manifestPath, dbPath, built.generation);
    assert.equal(imported.code, 'IMPORTED');
    assert.equal(imported.counts.words, 1);
    const store = openMetaStore({ path: dbPath, mode: 'readonly' });
    try { assert.equal(store.echoOpen('log:' + sid + '#seq=0').word.text, record.data.content[0].text); }
    finally { store.close(); }
  });

  check('tail E2E: open tail resumes at the next generation and emits appended frame exactly once', () => {
    const root = path.join(ROOT, 'open-tail-append');
    const sourceRoot = path.join(root, 'sessions');
    const ws = '--D-AI-open-tail-append--';
    const sid = 'session-open-tail-append-a1';
    const dir = path.join(sourceRoot, ws, sid);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'session.v4.jsonl.zstd');
    const manifestPath = path.join(root, 'files.jsonl');
    const rec0 = { type: 'user/message', seq: 0, time: 1792100000000, data: { content: [{ type: 'text', text: 'append test first' }] } };
    const rec1 = { type: 'assistant/message', seq: 1, time: 1792100001000, data: { message: { content: [{ type: 'text', text: 'append test completed tail' }] } } };
    const frame0 = zlib.zstdCompressSync(Buffer.from(JSON.stringify(rec0) + '\n', 'utf8'));
    const frame1 = zlib.zstdCompressSync(Buffer.from(JSON.stringify(rec1) + '\n', 'utf8'));
    const incompleteFrame1 = frame1.subarray(0, frame1.length - 5);
    const firstBytes = Buffer.concat([frame0, incompleteFrame1]);
    fs.writeFileSync(file, firstBytes);
    fs.writeFileSync(manifestPath, JSON.stringify({ file, sid, ws }) + '\n');

    const dbPath = path.join(root, 'target.sqlite');
    makeV9(dbPath);
    const generationBuild = (generation) => syncFromSessionTail({
      sourceRoot, manifestPath, dbPath, outDir: path.join(root, 'out-g' + generation),
      builtAt: '2026-11-15T12:20:00.000Z'
    });
    const first = generationBuild(1);
    assert.equal(first.generation, 1);
    assert.equal(first.tail.files[0].openTail, true);
    assert.equal(first.tail.files[0].nextByte, frame0.length);
    const cursorPath = Object.keys(first.manifest.cursor.tail.files).find((key) => path.resolve(key) === path.resolve(file));
    assert.ok(cursorPath, 'cursor stores the source path');
    assert.equal(first.manifest.cursor.tail.files[cursorPath].nextByte, frame0.length);
    const firstImport = importBuilt(first.manifestPath, dbPath, first.generation);
    assert.equal(firstImport.counts.words, 1);

    fs.appendFileSync(file, frame1.subarray(incompleteFrame1.length));
    const second = generationBuild(2);
    assert.equal(second.generation, 2);
    assert.equal(second.tail.files[0].mode, 'append');
    assert.equal(second.tail.files[0].openTail, false);
    assert.equal(second.tail.files[0].from, frame0.length);
    assert.equal(second.tail.files[0].records, 1);
    assert.equal(second.tail.files[0].words, 1);
    assert.equal(second.tail.files[0].nextByte, fs.statSync(file).size);
    const secondImport = importBuilt(second.manifestPath, dbPath, second.generation);
    assert.equal(secondImport.code, 'IMPORTED');
    assert.equal(secondImport.counts.words, 2);
    assert.equal(secondImport.generation, 2);
    const store = openMetaStore({ path: dbPath, mode: 'readonly' });
    try {
      const pointers = [
        ...store.echoSearch('append test first', { surface: 'words', limit: 10 }).results.map((x) => x.ptr),
        ...store.echoSearch('append test completed tail', { surface: 'words', limit: 10 }).results.map((x) => x.ptr),
      ].sort();
      assert.deepEqual(pointers, ['log:' + sid + '#seq=0', 'log:' + sid + '#seq=1']);
      assert.equal(store.echoOpen('log:' + sid + '#seq=0').word.text, 'append test first');
      assert.equal(store.echoOpen('log:' + sid + '#seq=1').word.text, 'append test completed tail');
      assert.equal(Number(store.db.prepare('SELECT COUNT(*) AS n FROM echo_words WHERE echo_source_id = ?').get(second.echoSourceId).n), 2);
      assert.equal(Number(store.db.prepare('SELECT COUNT(*) AS n FROM echo_source_builds WHERE echo_source_id = ?').get(second.echoSourceId).n), 2);
    } finally { store.close(); }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 5. feed 模式：只读复制**权威 ECHO 索引 JSONL** → 第二个 TEMP v9 库
  //    全部夹具在 os.tmpdir() 之下；源身份是**不存在**的合成 session 路径
  //    （任何真去读会话日志的尝试都会立刻失败 —— 不读原始 zstd 是设计）。
  // ══════════════════════════════════════════════════════════════════════════
  const FEED_INDEX = path.join(ROOT, 'feed-index');
  fs.mkdirSync(FEED_INDEX, { recursive: true });
  const FEED_WS = '--D-AI-synthetic-feed-e2e--';
  const FEED_SID = 'session-feed-e2e-a1';
  const FEED_SID_B = 'session-feed-e2e-b2';
  const FEED_LOG = 'D:/synthetic/echo-index-feed-e2e/' + FEED_WS + '/' + FEED_SID + '/session.v4.jsonl.zstd';
  const FEED_LOG_B = 'D:/synthetic/echo-index-feed-e2e/' + FEED_WS + '/' + FEED_SID_B + '/session.v4.jsonl.zstd';
  const FEED_SOURCE_PATH = 'D:/synthetic/echo-index-feed-e2e/index';
  const selectedSourcePath = (logPath) => {
    const canonical = path.resolve(logPath).replace(/\\/g, '/').toLowerCase();
    return 'D:/synthetic/echo-one-log/' + sha(Buffer.from(canonical, 'utf8'));
  };
  const FEED_BUILT_AT = '2026-11-15T14:00:00.000Z';
  const feedDb = path.join(ROOT, 'feed-second.sqlite');
  const feedFileRow = (logPath, sid, nextByte, key) => ({
    file: path.resolve(logPath), key: key === undefined ? '1791000000000:' + nextByte : key,
    nextByte, ws: FEED_WS, sid, nSum: 0, nWord: 0,
    sumOut: 'D:/synthetic/echo-index-feed-e2e/shards/' + sid + '.sum.jsonl',
    wordOut: 'D:/synthetic/echo-index-feed-e2e/shards/' + sid + '.word.jsonl'
  });
  const feedWord = (o) => {
    const row = { t: o.t === undefined ? '2026-11-15T09:00:00' : o.t, session: FEED_SID, ws: FEED_WS, seq: o.seq, turn: null, log: FEED_LOG };
    if (o.role !== undefined) row.role = o.role;
    row.kind = o.kind === undefined ? 'human' : o.kind;
    row.len = o.len === undefined ? Array.from(o.text).length : o.len;
    row.truncated = false;
    row.text = o.text;
    return row;
  };
  const FEED_SUMMARY_ROW = {
    id: 'cmp-feed-e2e', t: '2026-11-15T09:05:00', session: FEED_SID, ws: FEED_WS, log: FEED_LOG,
    srcSeqs: [1, 0, 1], shadowedTokens: 12, chars: 55, provider: 'synthetic', model: 'synthetic-summary',
    status: 'active', summary: 'Synthetic feed summary of alpha and beta',
    manifest: { range: [0, 1], n: 3, marks: [] }
  };
  const feedEnc = (x) => (typeof x === 'string' ? x : JSON.stringify(x));
  function writeFeedIndex(dirName, spec) {
    const dir = path.join(FEED_INDEX, dirName);
    fs.mkdirSync(dir, { recursive: true });
    const write = (name, list) => {
      const file = path.join(dir, name);
      const body = list.map(feedEnc).join('\n');
      fs.writeFileSync(file, Buffer.from(list.length === 0 ? '\n' : body + '\n', 'utf8'));
      return file;
    };
    return {
      dir, filesPath: write('files.jsonl', spec.files), wordsPath: write('words.jsonl', spec.words),
      summariesPath: write('summaries.jsonl', spec.summaries)
    };
  }
  const feedOptions = (fixture, extra) => ({
    filesPath: fixture.filesPath, wordsPath: fixture.wordsPath, summariesPath: fixture.summariesPath,
    sourcePath: FEED_SOURCE_PATH, namespace: 'log', generation: 1, builtAt: FEED_BUILT_AT,
    outDir: path.join(fixture.dir, 'out', 'g1'), ...(extra || {})
  });

  const feedWords1 = [
    feedWord({ seq: 0, text: 'Synthetic feed query alpha' }),
    feedWord({ seq: 1, text: 'Synthetic feed answer beta', kind: '结论', role: 'assistant' })
  ];
  // 逐字节相同的摘要 replay：必须去重，不许变成两行
  const feedSummaryReplay = JSON.stringify(FEED_SUMMARY_ROW);
  const feedFixture1 = writeFeedIndex('g1', {
    files: [feedFileRow(FEED_LOG, FEED_SID, 4096, 'k1:4096')],
    words: feedWords1,
    summaries: [FEED_SUMMARY_ROW, feedSummaryReplay]
  });
  makeV9(feedDb);
  const feedBuild1 = buildFromEchoIndexFiles(feedOptions(feedFixture1));
  const feedImport1 = importBuilt(feedBuild1.manifestPath, feedDb, feedBuild1.generation);

  check('feed build #1 copies the authoritative index into a second TEMP v9 DB', () => {
    assert.equal(feedBuild1.manifest.version, ECHO_INDEX_FEED_VERSION);
    assert.equal(feedBuild1.manifest.echoIndexVersion, 'echo-index/1');
    assert.equal(feedBuild1.manifest.counts.words, 2);
    assert.equal(feedBuild1.manifest.counts.summaries, 1);
    assert.equal(feedBuild1.manifest.counts.exactDuplicateSummaries, 1);
    assert.equal(feedImport1.code, 'IMPORTED');
    assert.equal(feedImport1.counts.words, 2);
    assert.equal(feedImport1.counts.summaries, 1);
    assert.equal(feedImport1.counts.srcSeqs, 3);
  });

  check('feed: aligned search and open on the imported index (words + idx summary)', () => {
    const store = openMetaStore({ path: feedDb, mode: 'readonly' });
    try {
      const stats = store.echoStats();
      assert.equal(stats.available, true);
      assert.equal(stats.aligned, true);
      assert.equal(stats.words, 2);
      assert.equal(stats.summaries, 1);
      const found = store.echoSearch('Synthetic', { surface: 'words', limit: 10 });
      assert.deepEqual(found.results.map((r) => r.ptr).sort(), [
        'log:' + FEED_SID + '#seq=0', 'log:' + FEED_SID + '#seq=1'
      ]);
      const opener = store.echoOpen('log:' + FEED_SID + '#seq=0');
      assert.equal(opener.status, 'ok');
      assert.equal(opener.namespace, 'log');
      assert.equal(opener.word.text, 'Synthetic feed query alpha', 'text 必须逐字等于权威索引里的原文');
      assert.equal(opener.word.role, 'user');
      assert.equal(opener.word.kind, 'human');
      assert.equal(opener.word.contentHash.length, 64);
      const answer = store.echoOpen('log:' + FEED_SID + '#seq=1');
      assert.equal(answer.word.role, 'assistant');
      assert.equal(answer.word.kind, '结论');
      const summary = store.echoOpen('idx:cmp-feed-e2e');
      assert.equal(summary.status, 'ok');
      assert.equal(summary.summary.summary, 'Synthetic feed summary of alpha and beta');
      assert.deepEqual(summary.srcSeqs, [1, 0, 1], '稀疏与重复的 srcSeqs 必须原样入库');
      assert.equal(store.echoStats().aligned, true);
    } finally { store.close(); }
  });

  // 第二代：words 追加一行 + files.jsonl 的 nextByte 前进
  const feedFixture2 = writeFeedIndex('g2', {
    files: [feedFileRow(FEED_LOG, FEED_SID, 8192, 'k2:8192')],
    words: [...feedWords1, feedWord({ seq: 2, text: 'Synthetic feed query gamma' })],
    summaries: [FEED_SUMMARY_ROW, feedSummaryReplay]
  });
  const feedBuild2 = buildFromEchoIndexFiles({ ...feedOptions(feedFixture2, { generation: 2, outDir: path.join(feedFixture2.dir, 'out', 'g2') }), cursor: feedBuild1.cursor });
  const feedImport2 = importBuilt(feedBuild2.manifestPath, feedDb, feedBuild2.generation);

  check('feed build #2 appends the new word and advances the generation', () => {
    assert.equal(feedBuild2.generation, 2);
    assert.deepEqual(feedBuild2.sources.map((s) => s.mode), ['append']);
    assert.equal(feedBuild2.manifest.counts.appended, 1);
    assert.equal(feedBuild2.manifest.counts.words, 3);
    assert.equal(feedBuild2.manifest.counts.summaries, 1);
    assert.equal(feedImport2.code, 'IMPORTED');
    assert.equal(feedImport2.counts.words, 3);
    assert.equal(feedImport2.generation, 2);
    const store = openMetaStore({ path: feedDb, mode: 'readonly' });
    try {
      assert.equal(store.echoStats().aligned, true);
      const found = store.echoSearch('Synthetic', { surface: 'words', limit: 10 });
      assert.equal(found.results.length, 3);
      assert.equal(store.echoOpen('log:' + FEED_SID + '#seq=2').word.text, 'Synthetic feed query gamma');
    } finally { store.close(); }
  });

  // 第三代：输入没变 → unchanged，且行逐字节一致（幂等）
  const feedBuild3 = buildFromEchoIndexFiles({ ...feedOptions(feedFixture2, { generation: 3, outDir: path.join(feedFixture2.dir, 'out', 'g3') }), cursor: feedBuild2.cursor });
  const feedImport3 = importBuilt(feedBuild3.manifestPath, feedDb, feedBuild3.generation);

  check('feed build #3 is an idempotent repeat: unchanged source, identical rows, newer generation', () => {
    assert.deepEqual(feedBuild3.sources.map((s) => s.mode), ['unchanged']);
    assert.equal(feedBuild3.manifest.counts.skippedUnchanged, 1);
    assert.deepEqual(fs.readFileSync(feedBuild3.wordsPath), fs.readFileSync(feedBuild2.wordsPath), '同一份输入 → 逐字节一样的 words');
    assert.deepEqual(fs.readFileSync(feedBuild3.summariesPath), fs.readFileSync(feedBuild2.summariesPath));
    assert.equal(feedImport3.code, 'IMPORTED');
    assert.equal(feedImport3.generation, 3);
    assert.equal(feedImport3.counts.words, 3);
    const db = openDatabase(feedDb, { readOnly: false });
    try {
      configureConnection(db, { memory: true });
      const row = db.prepare('SELECT generation, state, cursor_json FROM echo_index_sources').get();
      assert.equal(row.state, 'committed');
      assert.equal(Number(row.generation), 3);
      const cursor = JSON.parse(row.cursor_json);
      assert.equal(cursor.feed.version, ECHO_INDEX_FEED_VERSION, '游标只落在 TEMP v9 目标里');
      assert.deepEqual(Object.keys(cursor.feed.files), [path.resolve(FEED_LOG).replace(/\\/g, '/')]);
    } finally { db.close(); }
  });

  check('feed: a conflicting summary replay is refused, not resolved by picking one', () => {
    const fixture = writeFeedIndex('conflict', {
      files: [feedFileRow(FEED_LOG, FEED_SID, 4096, 'kc:4096'), feedFileRow(FEED_LOG_B, FEED_SID_B, 512, 'kb:512')],
      words: [feedWords1[0], { ...feedWord({ seq: 0, text: 'Synthetic feed query from b' }), session: FEED_SID_B, log: FEED_LOG_B }],
      summaries: [
        FEED_SUMMARY_ROW,
        { ...FEED_SUMMARY_ROW, session: FEED_SID_B, log: FEED_LOG_B, summary: 'Synthetic feed summary, second session' }
      ]
    });
    assert.throws(() => buildFromEchoIndexFiles(feedOptions(fixture)), /SUMMARY_ID_CONFLICT/);
    assert.equal(fs.existsSync(path.join(fixture.dir, 'out', 'g1')), false);
  });

  check('feed: a dangling srcSeq is refused (never inferred, never dropped)', () => {
    const fixture = writeFeedIndex('dangling', {
      files: [feedFileRow(FEED_LOG, FEED_SID, 4096, 'kd:4096')],
      words: feedWords1,
      summaries: [{ ...FEED_SUMMARY_ROW, srcSeqs: [0, 1, 7] }]
    });
    assert.throws(() => buildFromEchoIndexFiles(feedOptions(fixture)), /SRC_SEQ_DANGLING/);
    assert.equal(fs.existsSync(path.join(fixture.dir, 'out', 'g1')), false);
  });

  check('feed: an unexpected kind is excluded fail-closed and never becomes a word', () => {
    const fixture = writeFeedIndex('kind', {
      files: [feedFileRow(FEED_LOG, FEED_SID, 4096, 'kk:4096')],
      words: [...feedWords1, feedWord({ seq: 2, text: 'Synthetic mystery payload', kind: 'mystery' })],
      summaries: [FEED_SUMMARY_ROW]
    });
    const built = buildFromEchoIndexFiles(feedOptions(fixture));
    assert.equal(built.manifest.counts.words, 2);
    assert.equal(built.manifest.counts.excludedByType['kind:mystery'], 1);
    const emitted = fs.readFileSync(built.wordsPath, 'utf8').trimEnd().split('\n').map(JSON.parse);
    assert.equal(emitted.some((w) => /mystery/i.test(w.text)), false);
  });

  check('feed: malformed UTF-8 and an unterminated partial tail are refusals', () => {
    const goodFiles = [feedFileRow(FEED_LOG, FEED_SID, 4096, 'ku:4096')];
    const bytes = (name) => path.join(FEED_INDEX, name);
    const dir1 = bytes('utf8');
    fs.mkdirSync(dir1, { recursive: true });
    const filesPath = path.join(dir1, 'files.jsonl');
    const wordsPath = path.join(dir1, 'words.jsonl');
    const summariesPath = path.join(dir1, 'summaries.jsonl');
    fs.writeFileSync(filesPath, Buffer.from(goodFiles.map(feedEnc).join('\n') + '\n', 'utf8'));
    fs.writeFileSync(wordsPath, Buffer.concat([Buffer.from(JSON.stringify(feedWords1[0]), 'utf8'), Buffer.from([0xff, 0xfe]), Buffer.from('\n', 'utf8')]));
    fs.writeFileSync(summariesPath, Buffer.from('\n', 'utf8'));
    assert.throws(() => buildFromEchoIndexFiles(feedOptions({ filesPath, wordsPath, summariesPath, dir: dir1 })), /not valid UTF-8/);

    const dir2 = bytes('tail');
    fs.mkdirSync(dir2, { recursive: true });
    const filesPath2 = path.join(dir2, 'files.jsonl');
    const wordsPath2 = path.join(dir2, 'words.jsonl');
    const summariesPath2 = path.join(dir2, 'summaries.jsonl');
    fs.writeFileSync(filesPath2, Buffer.from(goodFiles.map(feedEnc).join('\n') + '\n', 'utf8'));
    fs.writeFileSync(wordsPath2, Buffer.concat([Buffer.from(JSON.stringify(feedWords1[0]) + '\n', 'utf8'), Buffer.from('{"t":"2026-11-15T09:10:00","session":"' + FEED_SID + '","ws":null,"seq":1,"tur', 'utf8')]));
    fs.writeFileSync(summariesPath2, Buffer.from('\n', 'utf8'));
    assert.throws(() => buildFromEchoIndexFiles(feedOptions({ filesPath: filesPath2, wordsPath: wordsPath2, summariesPath: summariesPath2, dir: dir2 })), /truncated write/);
    for (const d of [dir1, dir2]) assert.equal(fs.existsSync(path.join(d, 'out', 'g1')), false);
  });

  check('feed: a cursor rollback is refused unless a full rebuild is explicit', () => {
    const fixture = writeFeedIndex('rollback', {
      files: [feedFileRow(FEED_LOG, FEED_SID, 2048, 'kz:2048')],
      words: feedWords1,
      summaries: [FEED_SUMMARY_ROW]
    });
    assert.throws(() => buildFromEchoIndexFiles({ ...feedOptions(fixture, { generation: 4, outDir: path.join(fixture.dir, 'out', 'g4') }), cursor: feedBuild3.cursor }), /rolled back/);
    assert.equal(fs.existsSync(path.join(fixture.dir, 'out', 'g4')), false);
    const rebuilt = buildFromEchoIndexFiles({ ...feedOptions(fixture, { generation: 4, outDir: path.join(fixture.dir, 'out', 'g4b') }), cursor: feedBuild3.cursor, fullRebuild: true });
    assert.deepEqual(rebuilt.sources.map((s) => s.mode), ['full-rebuild']);
    assert.equal(rebuilt.manifest.counts.words, 2);
  });

  check('feed selected-log preserves raw row.log, derives source identity, and reports dangling refs', () => {
    const fixture = writeFeedIndex('selected-log', {
      files: [feedFileRow(FEED_LOG, FEED_SID, 4096, 'ks:4096'), feedFileRow(FEED_LOG_B, FEED_SID_B, 512, 'ksb:512')],
      words: [feedWords1[0], feedWords1[1], { ...feedWords1[0], log: FEED_LOG_B, text: 'Synthetic selected second source' }],
      summaries: [{ ...FEED_SUMMARY_ROW, srcSeqs: [1, 0, 1, 7] }, { ...FEED_SUMMARY_ROW, session: FEED_SID_B, log: FEED_LOG_B, summary: 'Second source same id', srcSeqs: [0, 7] }]
    });
    const selected = buildFromEchoIndexFiles({ ...feedOptions(fixture), sourcePath: selectedSourcePath(FEED_LOG), selectedLogPath: FEED_LOG, allowDanglingSrcSeq: true, outDir: path.join(fixture.dir, 'out', 'selected') });
    const rows = fs.readFileSync(selected.wordsPath, 'utf8').trimEnd().split('\n').map(JSON.parse);
    const sums = fs.readFileSync(selected.summariesPath, 'utf8').trimEnd().split('\n').map(JSON.parse);
    assert.equal(selected.sourcePath, selected.manifest.sourcePath);
    const selectedRawLog = path.resolve(FEED_LOG);
    assert.equal(selected.manifest.sourceInput.selectedLog.originalLogPath, selectedRawLog);
    assert.deepEqual(rows.map((x) => x.log), [path.resolve(FEED_LOG).replace(/\\/g, '/'), path.resolve(FEED_LOG).replace(/\\/g, '/')]);
    assert.equal(sums.length, 1); assert.equal(sums[0].log, path.resolve(FEED_LOG).replace(/\\/g, '/'));
    assert.deepEqual(sums[0].srcSeqs, [1, 0, 1, 7]);
    assert.equal(selected.manifest.counts.srcSeqDangling, 1);
    assert.equal(selected.manifest.summaryRefs.dangling, 1);
  });

  check('one live index source copied to TEMP then imported and aligned', () => {
    const base='D:/AI/memory/hub/index';
    const fp=path.join(base,'files.jsonl');
    const rows=fs.readFileSync(fp,'utf8').trimEnd().split('\n').map((raw)=>({raw,row:JSON.parse(raw)}));
    const found=rows.filter((x)=>x.row.sid==='session-8332345a-52d3-4a7d-afc5-5f4342a2ef0c');
    assert.equal(found.length,1);
    const x=found[0], src=x.row, log=src.file;
    const prod=[fp,src.wordOut,src.sumOut];
    const before=prod.map((f)=>({hash:sha(fs.readFileSync(f)),stat:fs.statSync(f)}));
    const td=path.join(ROOT,'live-feed-one'); const sd=path.join(td,'shards'); fs.mkdirSync(sd,{recursive:true});
    const tempRow={...src,wordOut:path.join(sd,path.basename(src.wordOut)),sumOut:path.join(sd,path.basename(src.sumOut))};
    const tf=path.join(td,'files.jsonl'); fs.writeFileSync(tf,JSON.stringify(tempRow)+'\n');
    fs.copyFileSync(src.wordOut,tempRow.wordOut); fs.copyFileSync(src.sumOut,tempRow.sumOut);
    const copied=[tf,tempRow.wordOut,tempRow.sumOut].map((f)=>sha(fs.readFileSync(f)));
    const out=path.join(ROOT,'live-feed-out');
    const b=buildFromEchoIndexFiles({filesPath:tf,wordsPath:tempRow.wordOut,summariesPath:tempRow.sumOut,namespace:'log',generation:1,builtAt:'2026-11-16T08:50:00.000Z',outDir:out,selectedLogPath:log,allowDanglingSrcSeq:true});
    assert.ok(b.manifest.counts.srcSeqDangling > 0, "preserve and report the copied source's declared dangling refs; do not invent/drop/repoint them");
    const words=fs.readFileSync(b.wordsPath,'utf8').trimEnd().split('\n').map(JSON.parse);
    const sums=fs.readFileSync(b.summariesPath,'utf8').trimEnd().split('\n').map(JSON.parse);
    assert.ok(sums.length < src.nSum, 'filter rows with dangling refs; never fabricate source rows to retain the declared total');
    assert.ok(words.length<=src.nWord,'eligible emitted words must not exceed the files.jsonl declared word rows');
    assert.ok(sums.length <= src.nSum,'emitted summaries must be a subset of declared rows');
    const db=path.join(ROOT,'live-feed-second.sqlite'); makeV9(db);
    const imp=importBuilt(b.manifestPath,db,1); assert.equal(imp.code,'IMPORTED');
    assert.equal(words.length,imp.counts.words,'emitted words equal importer-accepted rows');
    assert.ok(imp.counts.words<=src.nWord,'imported eligible words do not exceed files.jsonl nWord');
    assert.equal(imp.counts.summaries,sums.length,'importer count matches emitted summaries');
    const st=openMetaStore({path:db,mode:'readonly'});
    try {
      const stats=st.echoStats(); assert.equal(stats.aligned,true);
      assert.equal(stats.words,imp.counts.words); assert.equal(stats.summaries,sums.length);
      const w=words.find((z)=>z.role==='user'&&Number.isSafeInteger(z.seq));
      if(w){const opened=st.echoOpen('log:'+w.session+'#seq='+w.seq,{echoSourceId:b.manifest.echoSourceId});assert.equal(opened.word.text,w.text);assert.equal(opened.word.log,w.log);}
    } finally {st.close();}
    for(let i=0;i<prod.length;i++){const q=fs.statSync(prod[i]);assert.equal(q.size,before[i].stat.size);assert.equal(q.mtimeMs,before[i].stat.mtimeMs);assert.equal(sha(fs.readFileSync(prod[i])),before[i].hash);}
    assert.deepEqual([tf,tempRow.wordOut,tempRow.sumOut].map((f)=>sha(fs.readFileSync(f))),copied);
    console.log('LIVE_INDEX_TEMP sid='+src.sid+' words='+words.length+' summaries='+sums.length+' imported='+imp.code+' originalsUnchanged='+prod.length);
  });
  check('feed selected-log partitions sources without rewriting row.log or srcSeqs', () => {
    const selectedDb = path.join(ROOT, 'selected-log-second.sqlite');
    makeV9(selectedDb);
    const fixture = writeFeedIndex('selected-log-pair', {
      files: [feedFileRow(FEED_LOG, FEED_SID, 4096, 'ks:4096'), feedFileRow(FEED_LOG_B, FEED_SID, 2048, 'ksb:2048')],
      words: [feedWords1[0], feedWords1[1], { ...feedWords1[0], log: FEED_LOG_B, text: 'Synthetic selected second source' }],
      summaries: [
        { ...FEED_SUMMARY_ROW, srcSeqs: [1, 0, 1, 7] },
        { ...FEED_SUMMARY_ROW, log: FEED_LOG_B, summary: 'Synthetic summary from second source', srcSeqs: [0, 7] }
      ]
    });
    const buildSelected = (logPath, generation, out) => buildFromEchoIndexFiles({
      ...feedOptions(fixture, { generation, outDir: out }),
      sourcePath: selectedSourcePath(logPath), selectedLogPath: logPath, allowDanglingSrcSeq: true
    });
    const first = buildSelected(FEED_LOG, 1, path.join(fixture.dir, 'out', 'selected-a'));
    const second = buildSelected(FEED_LOG_B, 1, path.join(fixture.dir, 'out', 'selected-b'));
    const importA = importBuilt(first.manifestPath, selectedDb, 1);
    const importB = importBuilt(second.manifestPath, selectedDb, 1);
    assert.equal(importA.code, 'IMPORTED'); assert.equal(importB.code, 'IMPORTED');
    assert.notEqual(first.manifest.sourcePath, second.manifest.sourcePath);
    assert.equal(first.manifest.counts.srcSeqDangling, 1);
    assert.equal(second.manifest.counts.srcSeqDangling, 1);
    assert.deepEqual(first.manifest.summaryRefs.sample, [{ cmpId: 'cmp-feed-e2e', session: FEED_SID, ord: 3, seq: 7 }]);
    assert.deepEqual(second.manifest.summaryRefs.sample, [{ cmpId: 'cmp-feed-e2e', session: FEED_SID, ord: 1, seq: 7 }]);
    const rawA = fs.readFileSync(first.wordsPath, 'utf8').trimEnd().split('\n').map(JSON.parse);
    const rawSummaryA = fs.readFileSync(first.summariesPath, 'utf8').trimEnd().split('\n').map(JSON.parse);
    assert.deepEqual(rawA.map((w) => w.log), [path.resolve(FEED_LOG).replace(/\\/g, '/'), path.resolve(FEED_LOG).replace(/\\/g, '/')]);
    assert.equal(rawSummaryA[0].log, path.resolve(FEED_LOG).replace(/\\/g, '/'));
    assert.equal(rawSummaryA[0].cmpId, FEED_SUMMARY_ROW.id);
    assert.deepEqual(rawSummaryA[0].srcSeqs, [1, 0, 1, 7]);
    const store = openMetaStore({ path: selectedDb, mode: 'readonly' });
    try {
      const sources = store.db.prepare('SELECT echo_source_id, source_path FROM echo_index_sources ORDER BY source_path').all();
      assert.equal(sources.length, 2);
      assert.deepEqual(sources.map((x) => x.source_path), [first.manifest.sourcePath, second.manifest.sourcePath].sort());
      const sourceA = sources.find((x) => x.source_path === first.manifest.sourcePath);
      const sourceB = sources.find((x) => x.source_path === second.manifest.sourcePath);
      assert.throws(() => store.echoOpen('idx:' + FEED_SUMMARY_ROW.id), (err) => err.code === 'ECHO_PTR_AMBIGUOUS');
      assert.throws(() => store.echoOpen('log:' + FEED_SID + '#seq=0'), (err) => err.code === 'ECHO_PTR_AMBIGUOUS');
      const openedA = store.echoOpen('idx:' + FEED_SUMMARY_ROW.id, { echoSourceId: sourceA.echo_source_id });
      const openedB = store.echoOpen('idx:' + FEED_SUMMARY_ROW.id, { echoSourceId: sourceB.echo_source_id });
      assert.equal(openedA.source.sourcePath, first.manifest.sourcePath);
      assert.equal(openedB.source.sourcePath, second.manifest.sourcePath);
      assert.equal(openedA.summary.log, FEED_LOG);
      assert.equal(openedB.summary.log, FEED_LOG_B);
      const wordA = store.echoOpen('log:' + FEED_SID + '#seq=0', { echoSourceId: sourceA.echo_source_id });
      const wordB = store.echoOpen('log:' + FEED_SID + '#seq=0', { echoSourceId: sourceB.echo_source_id });
      assert.equal(wordA.word.log, FEED_LOG); assert.equal(wordB.word.log, FEED_LOG_B);
      assert.equal(store.echoStats().aligned, true);
    } finally { store.close(); }
  });

  check('feed: every TEMP root declared by the feed fixture stays inside os.tmpdir', () => {
    const tmp = path.resolve(os.tmpdir());
    for (const file of [feedFixture1.filesPath, feedFixture1.wordsPath, feedFixture1.summariesPath, feedBuild1.wordsPath, feedBuild2.manifestPath, feedDb]) {
      assert.equal(path.resolve(file).startsWith(tmp), true, 'must live under os.tmpdir: ' + file);
    }
    assert.equal(fs.existsSync(FEED_LOG), false, '源身份是合成路径，不许真的存在（也就不会被读）');
  });

} catch (e) {
  failed += 1;
  console.error('FAIL fatal: ' + (e && e.stack || e));
} finally {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); }
  catch (e) { failed += 1; console.error('FAIL cleanup: ' + e.message); }
  if (fs.existsSync(ROOT)) { failed += 1; console.error('FAIL cleanup: TEMP root still exists ' + ROOT); }
}
console.log('RESULT ' + passed + ' passed / ' + failed + ' failed');
if (failed) process.exitCode = 1;
