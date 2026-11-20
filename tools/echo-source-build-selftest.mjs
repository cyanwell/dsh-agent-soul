#!/usr/bin/env node
// TEMP-only integration test for explicit ECHO source builder -> v4 importer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openMetaStore, SCHEMA_VERSION } from '../src/db/index.mjs';
import { openDatabase, configureConnection } from '../src/db/engine.mjs';
import { echoSourceIdFor } from '../src/db/schema.mjs';
import { ECHO_WORD_FIELDS, ECHO_SUMMARY_FIELDS, ECHO_INDEX_VERSION_RE } from './echo-index-import.mjs';
import {
  buildSource, buildFromMetaSqlite,
  readSessionTailIndex, decodeSessionTailFrames, syncFromSessionTail,
  buildFromEchoIndexFiles, inspectEchoIndexFeed, readEchoIndexJsonl, echoOneLogSourcePath,
  SESSION_TAIL_VERSION, ECHO_INDEX_VERSION, V4_SOURCE_VERSION, SESSION_TAIL_WORD_KINDS,
  ECHO_INDEX_FEED_VERSION, ECHO_INDEX_WORD_FIELDS, ECHO_INDEX_WORD_FIELDS_WITH_ROLE,
  ECHO_INDEX_SUMMARY_FIELDS, ECHO_INDEX_FEED_SUMMARY_FIELDS, ECHO_INDEX_FILE_FIELDS,
  ECHO_INDEX_KIND_ROLE
} from './echo-source-build.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-source-build-'));
const FIXTURE = path.join(HERE, 'fixtures', 'echo-source-build', 'input.jsonl');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
let passed = 0;
let failed = 0;
const ownedStores = new Set();
function ownStore(store) { ownedStores.add(store); return store; }
function closeStore(store) { if (store && !store.closed) store.close(); ownedStores.delete(store); }
function check(name, fn) {
  try { fn(); passed += 1; console.log('✓ ' + name); }
  catch (e) { failed += 1; console.error('✗ ' + name + ': ' + (e && e.stack || e)); }
}
function cli(args) {
  return spawnSync(NODE, [path.join(HERE, 'echo-source-build.mjs'), ...args], { encoding: 'utf8' });
}
function makeV9(dbPath) {
  const store = openMetaStore({ path: dbPath, mode: 'readwrite' });
  try { store.migrate(); } finally { store.close(); }
}
function importBuilt(manifestPath, dbPath, generation = 1) {
  const result = spawnSync(NODE, [path.join(HERE, 'echo-index-import.mjs'), '--manifest', manifestPath, '--sha256', sha(fs.readFileSync(manifestPath)), '--generation', String(generation), '--db', dbPath, '--json'], { encoding: 'utf8' });
  let receipt;
  try { receipt = JSON.parse(result.stdout); } catch (e) { throw new Error('importer CLI returned invalid JSON (exit ' + result.status + '): ' + (result.stderr || '').slice(0, 300)); }
  if (result.status !== 0) { const error = new Error('importer CLI failed (' + result.status + '): ' + JSON.stringify(receipt)); error.code = receipt.code; error.receipt = receipt; throw error; }
  return receipt;
}


// ── source 模式（--db / buildFromMetaSqlite）的 TEMP 夹具 ───────────────────
const V4_RAW_ROOT = 'D:/synthetic/echo-source-build/v4';
const V4_LOG = V4_RAW_ROOT + '/frames.jsonl';
const V4_SESSION = 'session-v4-b1';
const V4_SOURCE_ID = 'v4-synthetic-b1';
const V4_SOURCE_PATH = 'D:/synthetic/echo-source-build/v4-index';
const V4_BUILT_AT = '2026-11-15T09:20:00.000Z';
const V4_FRAMES = [
  { session: V4_SESSION, seq: 0, type: 'user', t: '2026-11-15T09:20:01.000Z', text: 'Synthetic v4 query eta' },
  { session: V4_SESSION, seq: 1, type: 'tool_call', t: '2026-11-15T09:20:02.000Z', text: '[工具] synthetic-tool args' },
  { session: V4_SESSION, seq: 2, type: 'assistant', t: '2026-11-15T09:20:03.000Z', text: 'Synthetic v4 response theta' }
];
// 用现有 schema + import 路径造 TEMP v4 源库（store.ingest）。
function makeV4Source(dbFile, frames, options) {
  const o = options || {};
  const sourceId = o.sourceId || V4_SOURCE_ID;
  const rawRoot = o.rawRoot || V4_RAW_ROOT;
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
        frame: { seq: f.seq, frameOrdinal: ordinal, rawPath: rawRoot + '/frames.jsonl', text: f.text, type: f.type, eventAt: f.t }
      });
    }
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally { store.close(); }
  const raw = openDatabase(dbFile, { readOnly: false });
  try { configureConnection(raw, { memory: true }); raw.exec('PRAGMA journal_mode = DELETE'); }
  finally { raw.close(); }
  return { sourceId, logPath: rawRoot + '/frames.jsonl' };
}

try {
  const fixtureBytes = fs.readFileSync(FIXTURE);
  check('仓库 synthetic fixture 本身是严格 UTF-8 且以 LF 结束', () => {
    assert.equal(fixtureBytes[fixtureBytes.length - 1], 10);
    assert.deepEqual(Buffer.from(fixtureBytes.toString('utf8'), 'utf8'), fixtureBytes);
  });
  const inputCopy = path.join(ROOT, 'input.jsonl');
  fs.writeFileSync(inputCopy, fixtureBytes);
  const outDir = path.join(ROOT, 'built');
  const dbPath = path.join(ROOT, 'meta.sqlite');
  makeV9(dbPath);
  const built = buildSource({
    input: inputCopy,
    outDir,
    sourcePath: 'D:/synthetic/echo-source-build/index',
    namespace: 'log',
    generation: 1,
    builtAt: '2026-11-15T09:00:00.000Z',
    cursorSeq: 1
  });

  check('生成物严格 UTF-8 且都以 LF 结尾', () => {
    for (const file of [built.wordsPath, built.summariesPath, built.manifestPath]) {
      const b = fs.readFileSync(file);
      assert.ok(b.length > 0);
      assert.equal(b[b.length - 1], 10);
      assert.deepEqual(Buffer.from(b.toString('utf8'), 'utf8'), b);
    }
  });
  check('manifest hashes / byte sizes / counts 与文件逐字节一致', () => {
    const words = fs.readFileSync(built.wordsPath);
    const summaries = fs.readFileSync(built.summariesPath);
    assert.equal(built.manifest.words.sha256, sha(words));
    assert.equal(built.manifest.words.bytes, words.length);
    assert.equal(built.manifest.words.rows, 2);
    assert.equal(built.manifest.summaries.sha256, sha(summaries));
    assert.equal(built.manifest.summaries.bytes, summaries.length);
    assert.equal(built.manifest.summaries.rows, 0);
    assert.deepEqual(built.manifest.counts, { words: 2, summaries: 0, srcSeqs: 0, excludedReasoning: 0 });
    assert.equal(built.manifest.cursor.seq, 1);
  });
  check('no-summaries build keeps the canonical one-LF summaries file', () => {
    const summaries = fs.readFileSync(built.summariesPath);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0], 10);
    assert.equal(built.manifest.summaries.bytes, 1);
    assert.equal(built.manifest.summaries.rows, 0);
    assert.deepEqual(built.manifest.counts, { words: 2, summaries: 0, srcSeqs: 0, excludedReasoning: 0 });
  });
  check('words JSONL matches importer fields and source pointers', () => {
    const rows = fs.readFileSync(built.wordsPath, 'utf8').trimEnd().split('\n').map(JSON.parse);
    assert.equal(rows.length, 2);
    assert.deepEqual(Object.keys(rows[0]), ['t','session','ws','seq','turn','log','role','kind','len','truncated','text']);
    assert.equal(rows[0].seq, 0);
    assert.equal(rows[1].seq, 1);
    assert.equal(rows.every((x) => x.session === 'session-synthetic-a1' && x.truncated === false), true);
  });

  const imported = importBuilt(built.manifestPath, dbPath);
  check('existing importer commits generated source into TEMP v9 DB', () => {
    assert.equal(imported.code, 'IMPORTED');
    assert.equal(imported.counts.words, 2);
    assert.equal(imported.counts.summaries, 0);
    assert.equal(imported.counts.excludedReasoning, 0);
  });
  const store = ownStore(openMetaStore({ path: dbPath, mode: 'readonly' }));
  try {
    check('TEMP v9 stats aligned and counts match', () => {
      const stats = store.echoStats();
      assert.equal(stats.available, true);
      assert.equal(stats.aligned, true);
      assert.equal(stats.searchable, true);
      assert.equal(stats.words, 2);
      assert.equal(stats.summaries, 0);
    });
    check('synthetic query returns exact builder pointer and text', () => {
      const result = store.echoSearch('alpha', { surface: 'words', limit: 5 });
      assert.deepEqual(result.results.map((x) => x.ptr), ['log:session-synthetic-a1#seq=0']);
      assert.equal(result.results[0].rawText, 'Synthetic query alpha');
      assert.equal(result.exhausted, true);
    });
    check('canonical pointer opens the source record', () => {
      const opened = store.echoOpen('log:session-synthetic-a1#seq=1');
      assert.equal(opened.status, 'ok');
      assert.equal(opened.word.text, 'Synthetic response beta');
      assert.equal(opened.word.contentHash.length, 64);
      assert.equal(opened.namespace, 'log');
    });
  } finally { closeStore(store); }

  check('same generation and manifest is idempotent', () => {
    const again = importBuilt(built.manifestPath, dbPath);
    assert.equal(again.code, 'ALREADY_CURRENT');
    const checkStore = ownStore(openMetaStore({ path: dbPath, mode: 'readonly' }));
    try {
      const stats = checkStore.echoStats();
      assert.equal(stats.words, 2);
      assert.equal(stats.summaries, 0);
      assert.equal(checkStore.db.prepare('SELECT COUNT(*) AS n FROM echo_source_builds').get().n, 1);
    } finally { closeStore(checkStore); }
  });

  // ── 可选 synthetic summary JSONL：原字节落盘、清单一致、全链路可回取 ──────
  // srcSeqs 故意写成 [1,0,1]：引用的是本次 synthetic words（seq 0/1），乱序 + 重复，
  // 不代表任何真实覆盖。
  const SUMMARY_ROWS = [
    { cmpId: 'cmp-synthetic-alpha', t: '2026-11-15T09:05:00.000Z', session: 'session-synthetic-a1', ws: '--synthetic-workspace--', log: null, srcSeqs: [1, 0, 1], shadowedTokens: 12, shadowedChars: 34, provider: 'synthetic', model: 'synthetic-summary-1', status: 'active', summary: 'Synthetic summary of alpha and beta' },
    { cmpId: 'cmp-synthetic-void', t: '2026-11-15T09:06:00.000Z', session: 'session-synthetic-a1', ws: null, log: null, srcSeqs: [0], shadowedTokens: 0, shadowedChars: 0, provider: null, model: null, status: 'void', summary: 'Synthetic voided summary' }
  ];
  const summaryLines = SUMMARY_ROWS.map((row) => JSON.stringify(row));
  const summaryInputBytes = Buffer.from(summaryLines.join('\n') + '\n', 'utf8');
  const summaryInput = path.join(ROOT, 'summaries-input.jsonl');
  fs.writeFileSync(summaryInput, summaryInputBytes);
  const summaryOutDir = path.join(ROOT, 'built-summaries');
  const summaryDbPath = path.join(ROOT, 'meta-summaries.sqlite');
  const summaryBuilt = buildSource({
    input: inputCopy,
    summariesPath: summaryInput,
    outDir: summaryOutDir,
    sourcePath: 'D:/synthetic/echo-source-build/summaries',
    namespace: 'log',
    generation: 1,
    builtAt: '2026-11-15T09:10:00.000Z',
    cursorSeq: 1
  });

  check('summaries bytes are written exactly as supplied (raw lines, no reserialization)', () => {
    const written = fs.readFileSync(summaryBuilt.summariesPath);
    assert.deepEqual(written, summaryInputBytes);
    assert.equal(written.toString('utf8'), summaryLines.join('\n') + '\n');
    assert.equal(written[written.length - 1], 10);
  });
  check('manifest summaries bytes/hash/rows and counts.summaries/srcSeqs match the raw rows', () => {
    const written = fs.readFileSync(summaryBuilt.summariesPath);
    assert.equal(summaryBuilt.manifest.summaries.path, 'summaries.jsonl');
    assert.equal(summaryBuilt.manifest.summaries.sha256, sha(written));
    assert.equal(summaryBuilt.manifest.summaries.bytes, written.length);
    assert.equal(summaryBuilt.manifest.summaries.rows, 2);
    assert.deepEqual(summaryBuilt.manifest.counts, { words: 2, summaries: 2, srcSeqs: 4, excludedReasoning: 0 });
    assert.deepEqual(fs.readFileSync(summaryBuilt.wordsPath), fs.readFileSync(built.wordsPath));
    assert.equal(summaryBuilt.manifest.sourcePath, 'D:/synthetic/echo-source-build/summaries');
    assert.equal(summaryBuilt.manifest.sourcePath.startsWith('D:/synthetic/'), true);
    assert.equal(summaryBuilt.manifest.sourcePath.includes('\\'), false);
  });
  check('summary srcSeqs deliberately point at the synthetic words in this build', () => {
    const wordSeqs = fs.readFileSync(summaryBuilt.wordsPath, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line).seq);
    assert.deepEqual(wordSeqs, [0, 1]);
    assert.deepEqual(SUMMARY_ROWS[0].srcSeqs, [1, 0, 1]);
    for (const seq of SUMMARY_ROWS[0].srcSeqs) assert.equal(wordSeqs.includes(seq), true);
  });

  makeV9(summaryDbPath);
  const summaryImported = importBuilt(summaryBuilt.manifestPath, summaryDbPath);
  check('importer commits the summary source into TEMP v9 (IMPORTED, exact counts)', () => {
    assert.equal(summaryImported.code, 'IMPORTED');
    assert.equal(summaryImported.counts.words, 2);
    assert.equal(summaryImported.counts.summaries, 2);
    assert.equal(summaryImported.counts.srcSeqs, 4);
    assert.equal(summaryImported.counts.excludedReasoning, 0);
    assert.equal(summaryImported.inputs.summaries.sha256, sha(summaryInputBytes));
    assert.equal(summaryImported.inputs.summaries.bytes, summaryInputBytes.length);
    assert.equal(summaryImported.inputs.summaries.rows, 2);
  });
  const summaryStore = ownStore(openMetaStore({ path: summaryDbPath, mode: 'readonly' }));
  try {
    check('summary build is aligned in Store stats (words/summaries/srcSeqs)', () => {
      const stats = summaryStore.echoStats();
      assert.equal(stats.available, true);
      assert.equal(stats.aligned, true);
      assert.equal(stats.searchable, true);
      assert.equal(stats.words, 2);
      assert.equal(stats.summaries, 2);
      assert.equal(stats.problems.length, 0);
      const source = stats.sources.find((s) => s.sourcePath === 'D:/synthetic/echo-source-build/summaries');
      assert.ok(source, 'summary source row must be present');
      assert.equal(source.summaries, 2);
      assert.equal(source.declaredSeqRows, 4);
      assert.equal(source.seqRows, 4);
      assert.equal(source.aligned, true);
    });
    check('echoOpen(idx:<cmpId>) returns kind summary, raw line, hash, ordered srcSeqs, opensFrame false', () => {
      const opened = summaryStore.echoOpen('idx:cmp-synthetic-alpha');
      assert.equal(opened.status, 'ok');
      assert.equal(opened.kind, 'summary');
      assert.equal(opened.opensFrame, false);
      assert.equal(opened.word, undefined);
      assert.equal(opened.summary.cmpId, 'cmp-synthetic-alpha');
      assert.equal(opened.summary.summary, 'Synthetic summary of alpha and beta');
      assert.equal(opened.summary.status, 'active');
      assert.deepEqual(opened.srcSeqs, [1, 0, 1]);
      assert.equal(opened.summary.srcSeqCount, 3);
      assert.equal(opened.summary.fullJson, summaryLines[0]);
      assert.equal(opened.summary.contentHash, sha(Buffer.from(summaryLines[0], 'utf8')));
      assert.equal(opened.summary.contentHash, sha(Buffer.from(opened.summary.fullJson, 'utf8')));
    });
    check('void summary status survives import and missing cmpId stays a refusal', () => {
      assert.equal(summaryStore.echoOpen('idx:cmp-synthetic-void').summary.status, 'void');
      assert.throws(() => summaryStore.echoOpen('idx:cmp-missing'), /no ECHO summary indexed/);
    });
  } finally { closeStore(summaryStore); }

  const summaryBytesFor = (rows) => Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  function rejectSummary(name, bytes, pattern) {
    const input = path.join(ROOT, 'summaries-reject-' + name + '.jsonl');
    fs.writeFileSync(input, bytes);
    const output = path.join(ROOT, 'summaries-reject-' + name + '-out');
    assert.throws(() => buildSource({
      input: inputCopy, summariesPath: input, outDir: output,
      sourcePath: 'D:/synthetic/summaries-reject-' + name,
      namespace: 'log', generation: 1, builtAt: '2026-11-15T09:10:00.000Z', cursorSeq: 1
    }), pattern);
    assert.equal(fs.existsSync(output), false, name + ' must not create its output directory');
    assert.equal(fs.existsSync(path.join(output, 'manifest.json')), false);
  }

  check('malformed summary JSON / missing LF / empty / BOM / invalid UTF-8 reject before outputs', () => {
    const good = SUMMARY_ROWS[0];
    rejectSummary('bad-json', Buffer.from('{"cmpId":\n'), /invalid JSON/);
    rejectSummary('no-final-lf', Buffer.from(JSON.stringify(good)), /end with LF/);
    rejectSummary('empty', Buffer.alloc(0), /non-empty/);
    rejectSummary('bom', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), summaryInputBytes]), /UTF-8 BOM/);
    rejectSummary('bad-utf8', Buffer.from([0x7b, 0xc3, 0x28, 0x7d, 0x0a]), /not valid UTF-8/);
  });
  check('missing / extra summary fields reject before outputs', () => {
    const good = SUMMARY_ROWS[0];
    const withoutModel = (({ model, ...rest }) => rest)(good);
    rejectSummary('missing-field', summaryBytesFor([withoutModel]), /missing field model/);
    rejectSummary('extra-field', summaryBytesFor([{ ...good, payload: 'tool' }]), /unsupported field payload/);
  });
  check('bad status and invalid/negative srcSeq values reject before outputs', () => {
    const good = SUMMARY_ROWS[0];
    rejectSummary('bad-status', summaryBytesFor([{ ...good, status: 'draft' }]), /status must be active\|void/);
    rejectSummary('negative-srcseq', summaryBytesFor([{ ...good, srcSeqs: [1, -1] }]), /srcSeqs must be non-negative safe integers/);
    rejectSummary('fractional-srcseq', summaryBytesFor([{ ...good, srcSeqs: [1.5] }]), /srcSeqs must be non-negative safe integers/);
    rejectSummary('string-srcseq', summaryBytesFor([{ ...good, srcSeqs: ['1'] }]), /srcSeqs must be non-negative safe integers/);
  });
  check('invalid cmpId/session/time/types reject before outputs', () => {
    const good = SUMMARY_ROWS[0];
    rejectSummary('bad-cmpid', summaryBytesFor([{ ...good, cmpId: 'cmp 1' }]), /cmpId must be idx-safe/);
    rejectSummary('bad-session', summaryBytesFor([{ ...good, session: 'bad session' }]), /session must be ptr-safe/);
    rejectSummary('bad-time', summaryBytesFor([{ ...good, t: 'not-a-time' }]), /parseable timestamp/);
    rejectSummary('bad-ws', summaryBytesFor([{ ...good, ws: 7 }]), /ws must be a string or null/);
    rejectSummary('bad-shadowed', summaryBytesFor([{ ...good, shadowedTokens: -1 }]), /shadowedTokens must be a non-negative safe integer/);
    rejectSummary('empty-summary', summaryBytesFor([{ ...good, summary: '' }]), /summary must be a non-empty string/);
  });
  check('duplicate cmpId and blank summary rows reject before outputs', () => {
    const good = SUMMARY_ROWS[0];
    rejectSummary('duplicate-cmpid', summaryBytesFor([good, good]), /duplicate cmpId/);
    rejectSummary('blank-row', Buffer.from(summaryLines[0] + '\n\n' + summaryLines[1] + '\n'), /non-blank JSONL row/);
  });
  check('summaries input equal to or inside the output directory rejects before mkdir/writes', () => {
    const collisionDir = path.join(ROOT, 'summary-collision');
    fs.mkdirSync(collisionDir, { recursive: true });
    const inside = path.join(collisionDir, 'summaries-input.jsonl');
    fs.writeFileSync(inside, summaryInputBytes);
    const target = path.join(collisionDir, 'summaries.jsonl');
    const options = (summariesPath) => ({
      input: inputCopy, summariesPath, outDir: collisionDir,
      sourcePath: 'D:/synthetic/summary-collision',
      namespace: 'log', generation: 1, builtAt: '2026-11-15T09:10:00.000Z', cursorSeq: 1
    });
    const before = fs.readdirSync(collisionDir).sort();
    for (const candidate of [inside, target, collisionDir]) {
      assert.throws(() => buildSource(options(candidate)), /equal to or inside the output directory/);
    }
    if (process.platform === 'win32') {
      const caseVariant = path.join(ROOT, 'SUMMARY-COLLISION', 'summaries-input.jsonl');
      assert.throws(() => buildSource(options(caseVariant)), /equal to or inside the output directory/);
    }
    assert.deepEqual(fs.readdirSync(collisionDir).sort(), before);
    for (const file of ['words.jsonl', 'summaries.jsonl', 'manifest.json']) {
      assert.equal(fs.existsSync(path.join(collisionDir, file)), false);
    }
    // Not a prefix trap: .../summary-collision-extra is a sibling, not a child.
    const siblingDir = path.join(ROOT, 'summary-collision-extra');
    fs.mkdirSync(siblingDir, { recursive: true });
    const sibling = path.join(siblingDir, 'summaries-input.jsonl');
    fs.writeFileSync(sibling, summaryInputBytes);
    const siblingBuilt = buildSource({
      input: inputCopy, summariesPath: sibling, outDir: path.join(ROOT, 'summary-collision-out'),
      sourcePath: 'D:/synthetic/summary-collision-extra',
      namespace: 'log', generation: 1, builtAt: '2026-11-15T09:10:00.000Z', cursorSeq: 1
    });
    assert.deepEqual(fs.readFileSync(siblingBuilt.summariesPath), summaryInputBytes);
  });

  check('explicit but empty/non-string summariesPath is a refusal, not "no summaries"', () => {
    const base = { input: inputCopy, outDir: path.join(ROOT, 'empty-summaries-path-out'), sourcePath: 'D:/synthetic/empty-summaries', namespace: 'log', generation: 1, builtAt: '2026-11-15T09:10:00.000Z', cursorSeq: 1 };
    assert.throws(() => buildSource({ ...base, summariesPath: '' }), /summariesPath must be a non-empty path/);
    assert.throws(() => buildSource({ ...base, summariesPath: 42 }), /summariesPath must be a non-empty path/);
    assert.equal(fs.existsSync(base.outDir), false);
  });
  check('CLI --summaries duplicate/missing values fail; valid run writes caller bytes unchanged', () => {
    const out = path.join(ROOT, 'cli-summaries-out');
    const base = ['--input', inputCopy, '--out-dir', out, '--source-path', 'D:/synthetic/cli-summaries', '--namespace', 'log', '--generation', '1', '--built-at', '2026-11-15T09:10:00.000Z', '--cursor-seq', '1'];
    const duplicate = cli([...base, '--summaries', summaryInput, '--summaries', summaryInput]);
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.stderr, /duplicate argument: --summaries/);
    const missing = cli([...base, '--summaries']);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /missing value for --summaries/);
    const missingBeforeFlag = cli(['--summaries', '--input', inputCopy, ...base.slice(2)]);
    assert.notEqual(missingBeforeFlag.status, 0);
    assert.match(missingBeforeFlag.stderr, /missing value for --summaries/);
    assert.equal(fs.existsSync(out), false);
    const ok = cli([...base, '--summaries', summaryInput]);
    assert.equal(ok.status, 0, ok.stderr);
    const payload = JSON.parse(ok.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.counts.summaries, 2);
    assert.equal(payload.counts.srcSeqs, 4);
    assert.deepEqual(fs.readFileSync(path.join(out, 'summaries.jsonl')), summaryInputBytes);
    assert.equal(JSON.parse(fs.readFileSync(payload.manifest, 'utf8')).summaries.rows, 2);
  });
  check('CLI rejects an invalid summaries file without creating output', () => {
    const bad = path.join(ROOT, 'summaries-cli-bad.jsonl');
    fs.writeFileSync(bad, Buffer.from('{"cmpId":\n'));
    const out = path.join(ROOT, 'cli-summaries-bad-out');
    const result = cli(['--input', inputCopy, '--summaries', bad, '--out-dir', out, '--source-path', 'D:/synthetic/cli-summaries-bad', '--namespace', 'log', '--generation', '1', '--built-at', '2026-11-15T09:10:00.000Z', '--cursor-seq', '1']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid JSON/);
    assert.equal(fs.existsSync(out), false);
  });

  check('missing args fail via CLI', () => {
    assert.notEqual(cli([]).status, 0);
  });
  check('invalid UTF-8 and missing final LF reject in helper and CLI before outputs exist', () => {
    const invalidUtf8 = path.join(ROOT, 'invalid-utf8.jsonl');
    const noFinalLf = path.join(ROOT, 'no-final-lf.jsonl');
    fs.writeFileSync(invalidUtf8, Buffer.from([0xc3, 0x28, 0x0a]));
    fs.writeFileSync(noFinalLf, Buffer.from(fs.readFileSync(inputCopy).subarray(0, -1)));
    for (const [name, input, pattern] of [['utf8', invalidUtf8, /UTF-8/], ['lf', noFinalLf, /end with LF/]]) {
      const output = path.join(ROOT, 'reject-' + name);
      const options={input,outDir:output,sourcePath:'D:/synthetic/reject-' + name,namespace:'log',generation:1,builtAt:'2026-11-15T09:00:00.000Z',cursorSeq:1};
      assert.throws(() => buildSource(options), pattern);
      const args=['--input',input,'--out-dir',output,'--source-path',options.sourcePath,'--namespace','log','--generation','1','--built-at',options.builtAt,'--cursor-seq','1'];
      const result=cli(args);
      assert.notEqual(result.status,0);
      assert.match(result.stderr,pattern);
      assert.equal(fs.existsSync(output), false);
    }
  });
  check('invalid row fields and unsupported role reject without output', () => {
    const rawRows = fs.readFileSync(inputCopy, 'utf8').trimEnd().split('\n').map(JSON.parse);
    const cases = [
      ['unknown-field', { ...rawRows[0], payload:'tool' }, /unsupported field/],
      ['bad-role', { ...rawRows[0], role:'tool' }, /role must be user\|assistant/],
      ['bad-session', { ...rawRows[0], session:'bad session' }, /ptr-safe/],
      ['bad-time', { ...rawRows[0], t:'not-a-time' }, /parseable timestamp/]
    ];
    for (const [name,row,pattern] of cases) {
      const input=path.join(ROOT,name+'.jsonl');
      fs.writeFileSync(input, JSON.stringify(row)+'\n','utf8');
      const output=path.join(ROOT,'reject-'+name);
      assert.throws(() => buildSource({ input,outDir:output,sourcePath:'D:/synthetic/'+name,namespace:'log',generation:1,builtAt:'2026-11-15T09:00:00.000Z',cursorSeq:1 }),pattern);
      assert.equal(fs.existsSync(output),false);
    }
  });
  check('duplicate seq and cursor regression reject without output', () => {
    const dup = path.join(ROOT, 'dup.jsonl');
    const raw = fs.readFileSync(inputCopy, 'utf8');
    fs.writeFileSync(dup, raw + raw.split('\n')[0] + '\n', 'utf8');
    assert.throws(() => buildSource({ input: dup, outDir: path.join(ROOT,'dup-out'), sourcePath: 'D:/synthetic/dup', namespace:'log', generation:1, builtAt:'2026-11-15T09:00:00.000Z', cursorSeq:1 }), /duplicate seq/);
    assert.throws(() => buildSource({ input: inputCopy, outDir: path.join(ROOT,'cursor-out'), sourcePath: 'D:/synthetic/cursor', namespace:'log', generation:1, builtAt:'2026-11-15T09:00:00.000Z', cursorSeq:0 }), /cursorSeq must be >= max/);
    assert.equal(fs.existsSync(path.join(ROOT,'dup-out')),false);
    assert.equal(fs.existsSync(path.join(ROOT,'cursor-out')),false);
  });
  check('bad namespace, generation, and builtAt reject before output creation', () => {
    const base={input:inputCopy,sourcePath:'D:/synthetic/options',namespace:'log',generation:1,builtAt:'2026-11-15T09:00:00.000Z',cursorSeq:1};
    const cases=[
      ['namespace',{...base,namespace:'idx'},/namespace must be log\|v4log/],
      ['generation',{...base,generation:0},/generation must be safe integer/],
      ['builtAt',{...base,builtAt:'not-a-time'},/builtAt must be parseable/]
    ];
    for(const [name,options,pattern] of cases){const output=path.join(ROOT,'reject-option-'+name);assert.throws(()=>buildSource({...options,outDir:output}),pattern);assert.equal(fs.existsSync(output),false);}
  });
  check('existing output is preserved and partial output triplet rolls back', () => {
    assert.throws(() => buildSource({ input: inputCopy, outDir, sourcePath: 'D:/synthetic/echo-source-build/index', namespace:'log', generation:1, builtAt:'2026-11-15T09:00:00.000Z', cursorSeq:1 }), /overwrite/);
    const partial=path.join(ROOT,'partial-out'); fs.mkdirSync(partial);
    const originalWrite=fs.writeFileSync; let writes=0; let firstPath=null;
    fs.writeFileSync=function(file,...args){
      writes++;
      if (writes===1) firstPath=String(file);
      if (writes===2) {
        assert.equal(firstPath,path.join(partial,'words.jsonl'));
        assert.equal(fs.existsSync(firstPath),true);
        throw new Error('synthetic second-write failure');
      }
      return originalWrite.call(fs,file,...args);
    };
    try {
      assert.throws(() => buildSource({ input:inputCopy,outDir:partial,sourcePath:'D:/synthetic/partial',namespace:'log',generation:1,builtAt:'2026-11-15T09:00:00.000Z',cursorSeq:1 }),/synthetic second-write failure/);
    } finally { fs.writeFileSync=originalWrite; }
    assert.equal(writes,2);
    assert.equal(firstPath,path.join(partial,'words.jsonl'));
    assert.equal(fs.existsSync(path.join(partial,'words.jsonl')),false);
    assert.equal(fs.existsSync(path.join(partial,'summaries.jsonl')),false);
    assert.equal(fs.existsSync(path.join(partial,'manifest.json')),false);
    assert.equal(fs.readFileSync(built.manifestPath,'utf8').includes('D:/synthetic/echo-source-build/index'),true);
  });
  check('summary-path build rolls back and keeps the caller summaries input', () => {
    const partialSummaryDir = path.join(ROOT, 'partial-summaries-out');
    const originalWrite = fs.writeFileSync; let writes = 0;
    fs.writeFileSync = function (file, ...args) {
      writes++;
      if (writes === 2) throw new Error('synthetic summary second-write failure');
      return originalWrite.call(fs, file, ...args);
    };
    try {
      assert.throws(() => buildSource({ input: inputCopy, summariesPath: summaryInput, outDir: partialSummaryDir, sourcePath: 'D:/synthetic/partial-summaries', namespace: 'log', generation: 1, builtAt: '2026-11-15T09:10:00.000Z', cursorSeq: 1 }), /synthetic summary second-write failure/);
    } finally { fs.writeFileSync = originalWrite; }
    assert.equal(writes, 2);
    for (const file of ['words.jsonl', 'summaries.jsonl', 'manifest.json']) assert.equal(fs.existsSync(path.join(partialSummaryDir, file)), false);
    assert.deepEqual(fs.readFileSync(summaryInput), summaryInputBytes);
  });
  // ── source 模式：v4 SQLite → ECHO（同一套 importer 形状、同一套护栏）────────
  const v4Dir = path.join(ROOT, 'v4');
  fs.mkdirSync(v4Dir, { recursive: true });
  const v4Db = path.join(v4Dir, 'v4-source.sqlite');
  makeV4Source(v4Db, V4_FRAMES);
  const v4BeforeStat = fs.statSync(v4Db);
  const v4BeforeSha = sha(fs.readFileSync(v4Db));
  const v4Options = (over) => ({
    dbPath: v4Db, sourceId: V4_SOURCE_ID, sourcePath: V4_SOURCE_PATH, namespace: 'v4log',
    generation: 1, builtAt: V4_BUILT_AT, outDir: path.join(ROOT, 'v4-out'), ...over
  });

  check('source 模式 CLI 显式：--db/--source-id 必填，不许和 synthetic 参数混用', () => {
    const base = ['--db', v4Db, '--source-id', V4_SOURCE_ID, '--out-dir', path.join(ROOT, 'v4-cli'), '--source-path', V4_SOURCE_PATH, '--namespace', 'v4log', '--generation', '1', '--built-at', V4_BUILT_AT];
    const mixed = cli([...base, '--input', inputCopy]);
    assert.notEqual(mixed.status, 0);
    assert.match(mixed.stderr, /--input is not allowed with --db/);
    const noSourceId = cli(base.filter((a, i) => !(a === '--source-id' || a === V4_SOURCE_ID)));
    assert.notEqual(noSourceId.status, 0);
    assert.match(noSourceId.stderr, /required argument missing: --source-id/);
    const withSummaries = cli([...base, '--summaries', summaryInput]);
    assert.notEqual(withSummaries.status, 0);
    assert.match(withSummaries.stderr, /--summaries is not allowed with --db/);
    for (const dir of ['v4-cli']) assert.equal(fs.existsSync(path.join(ROOT, dir)), false);
  });

  check('source 模式 API：缺 sourceId / 库不在临时目录 / 源身份撞车 一律拒绝且不留输出', () => {
    const out = path.join(ROOT, 'v4-neg');
    assert.throws(() => buildFromMetaSqlite({ ...v4Options({}), sourceId: undefined, outDir: out }), /missing explicit option sourceId/);
    assert.throws(() => buildFromMetaSqlite(v4Options({ outDir: out, dbPath: FIXTURE })), /under the OS temporary directory/);
    assert.throws(() => buildFromMetaSqlite(v4Options({ outDir: out, sourcePath: 'D:/synthetic/../real/index' })), /canonical absolute posix/);
    assert.throws(() => buildFromMetaSqlite(v4Options({ outDir: out, sourceId: 'v4-nope' })), /no v4 source row/);
    assert.equal(fs.existsSync(out), false);
  });

  check('source 模式只收 user/assistant：words 字段集与 synthetic 一致，摘要保持单 LF', () => {
    const builtV4 = buildFromMetaSqlite(v4Options({}));
    const rows = fs.readFileSync(builtV4.wordsPath, 'utf8').trimEnd().split('\n').map(JSON.parse);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.seq), [0, 2]);
    assert.deepEqual(Object.keys(rows[0]), ['t','session','ws','seq','turn','log','role','kind','len','truncated','text']);
    assert.equal(rows.every((r) => r.session === V4_SESSION && r.ws === null && r.turn === null && r.log === V4_LOG), true);
    assert.deepEqual(rows.map((r) => r.role), ['user','assistant']);
    const summaries = fs.readFileSync(builtV4.summariesPath);
    assert.deepEqual(summaries, Buffer.from('\n', 'utf8'));
    assert.equal(builtV4.manifest.version, 'v4-source/1');
    // ★ 旧模式的 version 语义原样保留（2026-11-16 加 sourceVersion 出口时复核）：
    //   其它三种构建器的 version 记的是**它们自己的源形状**，本次改动一个字节都没碰它们，
    //   也绝不会因为新选项而给它们的清单塞进 feedFormat。
    assert.equal(builtV4.manifest.version, V4_SOURCE_VERSION);
    assert.equal(Object.prototype.hasOwnProperty.call(builtV4.manifest, 'feedFormat'), false, 'v4 源构建器不长 feedFormat');
    assert.equal(builtV4.manifest.echoIndexVersion, ECHO_INDEX_VERSION);
    assert.equal(builtV4.manifest.namespace, 'v4log');
    assert.equal(builtV4.manifest.cursor.seq, 2);
    assert.deepEqual(builtV4.manifest.counts, {
      words: 2, summaries: 0, srcSeqs: 0, excludedReasoning: 0,
      scanned: 3, excluded: 1, excludedByType: { tool_call: 1 }
    });
    assert.equal(builtV4.manifest.sourceInput.schemaVersion, SCHEMA_VERSION);
  });

  check('source 模式构建前后源库 SHA-256 与 mtime 逐字节不变', () => {
    const afterStat = fs.statSync(v4Db);
    assert.equal(sha(fs.readFileSync(v4Db)), v4BeforeSha);
    assert.equal(afterStat.mtimeMs, v4BeforeStat.mtimeMs);
    assert.equal(afterStat.size, v4BeforeStat.size);
    assert.deepEqual(fs.readdirSync(v4Dir).sort(), ['v4-source.sqlite']);
  });

  check('source 模式：无合格帧 / 退化 cursor 都拒绝，且不创建输出目录', () => {
    const emptyDb = path.join(v4Dir, 'no-eligible.sqlite');
    makeV4Source(emptyDb, [
      { session: V4_SESSION, seq: 0, type: 'tool_result', t: '2026-11-15T09:20:01.000Z', text: '[结果] synthetic' }
    ], { rawRoot: 'D:/synthetic/echo-source-build/v4-empty' });
    const emptyOut = path.join(ROOT, 'v4-empty-out');
    // ★ 2026-11-15：原正则 /no eligible user\/assistant frames/ 与实现文案对不上（实现是
    //   "has no eligible non-truncated user/assistant frames"）。这不是放宽标准，是把断言对回实现；
    //   之前它一直「绿」，是因为子进程跑的是 Electron 可执行体（根本没过 node），见报告「验收假绿」。
    assert.throws(() => buildFromMetaSqlite(v4Options({ dbPath: emptyDb, outDir: emptyOut })), /has no eligible non-truncated user\/assistant frames/);
    assert.equal(fs.existsSync(emptyOut), false);
    const cursorOut = path.join(ROOT, 'v4-cursor-out');
    // ★ 2026-11-15：原正则写的是 "max source frame seq"，实现判的是 "max emitted word seq" ——
    //   同一处契约漂移（见上面那条注释）。断言对回实现，判据不变：退化 cursor 必须被拒。
    assert.throws(() => buildFromMetaSqlite(v4Options({ outDir: cursorOut, cursorSeq: 1 })), /cursorSeq must be >= max emitted word seq/);
    assert.equal(fs.existsSync(cursorOut), false);
  });


  // ══════════════════════════════════════════════════════════════════════════
  // tail 模式：只读追加读取会话日志（不迁移、不搬家、不写源树）
  // ══════════════════════════════════════════════════════════════════════════
  const TAIL_SESS = path.join(ROOT, 'tail', 'sessions');
  const TAIL_WS = '--D-AI-synthetic--';
  const tailRec = (type, seq, time, data) => ({ type, seq, time, data });
  const tailFrames = (recs) => Buffer.concat(recs.map((r) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(r) + '\n', 'utf8'))));
  function zstdRawFrame(payload) {
    const data = Buffer.from(payload);
    assert.ok(data.length <= 0x1ffff, 'raw Zstd test frame must fit one block');
    // Standard frame: magic, single-segment + four-byte FCS, then a last raw block.
    const header = Buffer.from([0x28,0xb5,0x2f,0xfd,0xa0,data.length & 0xff,(data.length >>> 8) & 0xff,(data.length >>> 16) & 0xff,(data.length >>> 24) & 0xff]);
    const blockHeader = (data.length << 3) | 1;
    return Buffer.concat([header,Buffer.from([blockHeader & 0xff,(blockHeader >>> 8) & 0xff,(blockHeader >>> 16) & 0xff]),data]);
  }
  function zstdSkippable(payload) {
    const data = Buffer.from(payload);
    const header = Buffer.alloc(8);
    header.set([0x50,0x2a,0x4d,0x18], 0);
    header.writeUInt32LE(data.length, 4);
    return Buffer.concat([header, data]);
  }
  function tailSession(sid, recs, fileName) {
    const dir = path.join(TAIL_SESS, TAIL_WS, sid);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, fileName || 'session.v4.jsonl.zstd');
    fs.writeFileSync(file, tailFrames(recs));
    return file;
  }
  function tailManifest(name, rows) {
    const file = path.join(ROOT, 'tail', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
    return file;
  }
  const TAIL_RECORDS = [
    { type: 'session', createdAt: 1790000000000 },
    tailRec('user/message', 0, 1790000001000, { content: [{ type: 'text', text: 'tail query alpha' }] }),
    tailRec('assistant/message', 1, 1790000002000, { message: { content: [{ type: 'reasoning', text: 'private thought' }, { type: 'text', text: 'tail answer beta' }] } }),
    tailRec('tool/call', 2, 1790000003000, { name: 'synthetic-tool', arguments: {} }),
    tailRec('compaction/summary', 3, 1790000004000, {
      compactionId: 'cmp-0000-1111', summary: [{ type: 'text', text: 'tail summary gamma' }], rawOutput: [],
      shadowedRange: { start: 0, end: 1 }, shadowedSeqs: [1, 0, 1, 99], shadowedTokenCount: 77,
      provider: 'synthetic', model: 'synthetic-summary-1', maxTokens: 8, usage: {}
    })
  ];

  check('tail 切帧：skippable payload 中的 pseudo magic 被长度字段跳过，后续 record 正常解析', () => {
    const fakePayload = Buffer.concat([Buffer.from('opaque-prefix-', 'utf8'), Buffer.from([0x28,0xb5,0x2f,0xfd]), Buffer.from('-opaque-suffix', 'utf8')]);
    const rec = tailRec('user/message', 8, 1790000008000, { content: [{ type: 'text', text: 'valid payload record' }] });
    const recordFrame = zlib.zstdCompressSync(Buffer.from(JSON.stringify(rec) + '\n', 'utf8'));
    const bytes = Buffer.concat([zstdSkippable(fakePayload), recordFrame]);
    const decoded = decodeSessionTailFrames(bytes);
    assert.equal(decoded.frames, 2, 'one skippable frame boundary plus one data frame');
    assert.equal(decoded.completeBytes, bytes.length);
    assert.equal(decoded.openTail, false);
    assert.equal(decoded.records.length, 1);
    assert.equal(decoded.records[0].seq, 8);
    assert.equal(decoded.records[0].data.content[0].text, 'valid payload record');
  });

  check('tail 切帧：多帧 zstd 全解，completeBytes 落到文件末尾', () => {
    const bytes = tailFrames(TAIL_RECORDS);
    const decoded = decodeSessionTailFrames(bytes);
    assert.equal(decoded.frames, TAIL_RECORDS.length);
    assert.equal(decoded.records.length, TAIL_RECORDS.length);
    assert.equal(decoded.completeBytes, bytes.length);
    assert.equal(decoded.openTail, false);
    assert.equal(decoded.badFrames, 0);
    assert.deepEqual(decoded.records.map((r) => r.type), TAIL_RECORDS.map((r) => r.type));
  });

  check('tail 切帧：尾部半帧只算开尾，既不吞掉也不推进游标', () => {
    const bytes = tailFrames(TAIL_RECORDS);
    const file = tailSession('session-tail-open', TAIL_RECORDS);
    const whole = fs.readFileSync(file);
    const hostTruncated = whole.subarray(0, whole.length - 7);
    const decoded = decodeSessionTailFrames(hostTruncated);
    assert.equal(decoded.openTail, true, '截断的最后一帧必须被识别为开尾');
    assert.ok(decoded.completeBytes < hostTruncated.length, '开尾不得推进到文件末尾');
    assert.equal(decoded.records.length, TAIL_RECORDS.length - 1, '未完成那一帧里的记录一条都不许进索引');
    assert.equal(decoded.records[decoded.records.length - 1].type, 'tool/call');
    assert.ok(bytes.length > hostTruncated.length);
  });

  check('tail 切帧：尾部只剩帧魔数前缀（1-3 字节）也必须算开尾，不许被上一帧吞掉', () => {
    const whole = tailFrames(TAIL_RECORDS);
    for (const extraBytes of [Buffer.from([0x28]), Buffer.from([0x28, 0xb5]), Buffer.from([0x28, 0xb5, 0x2f])]) {
      const decoded = decodeSessionTailFrames(Buffer.concat([whole, extraBytes]));
      assert.equal(decoded.openTail, true, '尾部魔数前缀必须算开尾');
      assert.equal(decoded.records.length, TAIL_RECORDS.length, '完整帧的记录一条不许少');
      assert.equal(decoded.completeBytes, whole.length, '游标必须停在完整帧的末尾，不许吞掉前缀字节');
    }
  });

  check('tail 切帧：非 zstd / 非帧边界一律拒绝', () => {
    assert.throws(() => decodeSessionTailFrames(Buffer.from('not a zstd stream at all')), /no frame magic/);
    const bytes = tailFrames(TAIL_RECORDS);
    assert.throws(() => decodeSessionTailFrames(bytes.subarray(5)), /no frame magic at byte 0/);
  });

  check('索引清单：sid 必须等于会话目录名；同一会话被两个文件声明 = 歧义，拒绝', () => {
    const f1 = tailSession('session-manifest-a', TAIL_RECORDS);
    assert.throws(() => readSessionTailIndex({
      sourceRoot: TAIL_SESS,
      manifestPath: tailManifest('m-sid.jsonl', [{ file: f1, sid: 'session-not-the-dir' }])
    }), /does not match its session directory/);

    // 真实形状：同一目录里同时留着 session.v3 与 session.v4 —— 生产清单里确实出现过两条。
    const dir = path.dirname(f1);
    fs.writeFileSync(path.join(dir, 'session.v3.jsonl.zstd'), tailFrames([TAIL_RECORDS[1]]));
    assert.throws(() => readSessionTailIndex({
      sourceRoot: TAIL_SESS,
      manifestPath: tailManifest('m-dup.jsonl', [
        { file: path.join(dir, 'session.v3.jsonl.zstd'), sid: 'session-manifest-a' },
        { file: f1, sid: 'session-manifest-a' }
      ])
    }), /ambiguous source->session mapping/);
  });

  check('索引清单：源根之外的文件 / 空清单 / 坏 JSON / 重复文件全拒绝', () => {
    const f1 = tailSession('session-manifest-b', TAIL_RECORDS);
    assert.throws(() => readSessionTailIndex({
      sourceRoot: TAIL_SESS,
      manifestPath: tailManifest('m-outside.jsonl', [{ file: path.join(ROOT, 'outside.jsonl'), sid: 'outside' }])
    }), /outside sourceRoot/);
    assert.throws(() => readSessionTailIndex({ sourceRoot: TAIL_SESS, manifestPath: tailManifest('m-empty.jsonl', []) }), /index manifest is empty|declares no files/);
    const badJson = path.join(ROOT, 'tail', 'm-bad.jsonl');
    fs.writeFileSync(badJson, '{not json}\n');
    assert.throws(() => readSessionTailIndex({ sourceRoot: TAIL_SESS, manifestPath: badJson }), /invalid JSON/);
    assert.throws(() => readSessionTailIndex({
      sourceRoot: TAIL_SESS,
      manifestPath: tailManifest('m-dupfile.jsonl', [{ file: f1, sid: 'session-manifest-b' }, { file: f1, sid: 'session-manifest-b' }])
    }), /declares the same file twice/);
  });

  check('tail 构建：源读取期间 append 拒绝整代且不写输出', () => {
    const first = tailRec('user/message', 0, 1790000001000, { content: [{ type: 'text', text: 'race first record' }] });
    const second = tailRec('assistant/message', 1, 1790000002000, { message: { content: [{ type: 'text', text: 'race appended record' }] } });
    const file = tailSession('session-tail-race', [first]);
    const manifestPath = tailManifest('m-race.jsonl', [{ file, sid: 'session-tail-race', ws: TAIL_WS }]);
    const dbPath = path.join(ROOT, 'tail-race.sqlite');
    makeV9(dbPath);
    const outDir = path.join(ROOT, 'tail-race-out');
    const before = fs.readFileSync(file);
    let injected = false;
    assert.throws(() => syncFromSessionTail({
      sourceRoot: TAIL_SESS, manifestPath, outDir, dbPath, builtAt: '2026-11-15T11:00:00.000Z',
      afterSourceSnapshot({ file: snapFile }) {
        assert.equal(snapFile, file);
        if (!injected) { fs.appendFileSync(file, tailFrames([second])); injected = true; }
      }
    }), /source changed while being read/);
    assert.equal(injected, true);
    assert.equal(fs.statSync(file).size, before.length + tailFrames([second]).length);
    assert.equal(fs.existsSync(outDir), false, 'racing read must refuse before output creation');
    const checkStore = ownStore(openMetaStore({ path: dbPath, mode: 'readonly' }));
    try { assert.equal(checkStore.echoStats().sources.length, 0, 'refused build must not advance TEMP cursor'); }
    finally { closeStore(checkStore); }
  });

  check('tail 构建：words 取 user/assistant 正文，摘要 srcSeqs 原样原序，悬空只计数不伪造', () => {
    const file = tailSession('session-tail-happy', TAIL_RECORDS);
    const manifestPath = tailManifest('m-happy.jsonl', [{ file, sid: 'session-tail-happy', ws: TAIL_WS }]);
    const dbPath = path.join(ROOT, 'tail-happy.sqlite');
    makeV9(dbPath);
    const before = { bytes: fs.readFileSync(file), stat: fs.statSync(file) };
    const built = syncFromSessionTail({
      sourceRoot: TAIL_SESS, manifestPath, outDir: path.join(ROOT, 'tail-out-happy'),
      dbPath, builtAt: '2026-11-15T11:00:00.000Z'
    });
    assert.equal(built.generation, 1);
    assert.equal(built.manifest.version, SESSION_TAIL_VERSION);
    assert.equal(built.manifest.echoIndexVersion, ECHO_INDEX_VERSION);
    assert.equal(Object.prototype.hasOwnProperty.call(built.manifest, 'feedFormat'), false, 'tail 源构建器不长 feedFormat');
    assert.equal(built.echoSourceId, echoSourceIdFor(built.manifest.sourcePath, ECHO_INDEX_VERSION), 'tail 的源身份仍走 echoIndexVersion 那把钥匙');
    assert.equal(built.manifest.sourcePath, path.resolve(TAIL_SESS).replace(/\\/g, '/'));
    const rows = fs.readFileSync(built.wordsPath, 'utf8').trimEnd().split('\n').map(JSON.parse);
    assert.equal(rows.length, 2);
    for (const row of rows) assert.deepEqual(Object.keys(row), [...ECHO_WORD_FIELDS]);
    assert.deepEqual(rows.map((r) => r.role), ['user', 'assistant']);
    assert.deepEqual(rows.map((r) => r.kind), [SESSION_TAIL_WORD_KINDS.user, SESSION_TAIL_WORD_KINDS.assistant]);
    assert.deepEqual(rows.map((r) => r.text), ['tail query alpha', 'tail answer beta']);
    assert.deepEqual(rows.map((r) => r.seq), [0, 1]);
    assert.equal(rows.every((r) => r.ws === TAIL_WS && r.turn === null && r.log === file && r.truncated === false), true);
    assert.equal(rows.every((r) => r.len === Array.from(r.text).length), true);
    const summaries = fs.readFileSync(built.summariesPath, 'utf8').trimEnd().split('\n').map(JSON.parse);
    assert.equal(summaries.length, 1);
    assert.deepEqual(Object.keys(summaries[0]), [...ECHO_SUMMARY_FIELDS]);
    assert.equal(summaries[0].cmpId, 'cmp-0000-1111');
    assert.deepEqual(summaries[0].srcSeqs, [1, 0, 1, 99], 'srcSeqs 必须原样原序（重复保留）');
    assert.equal(summaries[0].shadowedChars, 0, '源帧没声明被遮蔽字符数 → 记 0，不拿 summary 长度冒充');
    assert.equal(summaries[0].shadowedTokens, 77);
    assert.equal(summaries[0].status, 'active');
    assert.deepEqual(built.tail.dangling, [{ cmpId: 'cmp-0000-1111', session: 'session-tail-happy', seq: 99 }]);
    assert.equal(built.manifest.counts.srcSeqDangling, 1);
    assert.equal(built.manifest.counts.srcSeqResolved, 3);
    assert.equal(built.manifest.counts.excludedReasoning, 0, 'importer 的 excludedReasoning 指 reasoning 行，我们一条都不发射');
    assert.equal(built.manifest.counts.excludedReasoningFrames, 1, '被排除的 reasoning 块单独计数，不冒充 importer 那个字段');
    assert.equal(built.manifest.cursor.seq, 1, 'cursor 只认已发射的 words 的最大 seq（摘要帧的 seq 不是 word）');
    assert.equal(built.manifest.counts.excludedByType['tool/call'], 1);
    assert.equal(built.manifest.counts.excludedByType['session'], 1);
    // 源树与源文件一个字节都不许动
    assert.deepEqual(fs.readFileSync(file), before.bytes);
    assert.equal(fs.statSync(file).mtimeMs, before.stat.mtimeMs);
  });

  check('tail 构建：临时目录之外的源根 / 缺 v9 结构 / 无合格行 → 全拒绝且不建输出', () => {
    const file = tailSession('session-tail-guard', TAIL_RECORDS);
    const dbPath = path.join(ROOT, 'tail-guard.sqlite');
    makeV9(dbPath);
    const outsideOut = path.join(HERE, 'tail-outside-out');
    assert.throws(() => syncFromSessionTail({
      sourceRoot: TAIL_SESS, manifestPath: tailManifest('m-guard.jsonl', [{ file, sid: 'session-tail-guard' }]),
      outDir: outsideOut, dbPath, builtAt: '2026-11-15T11:00:00.000Z'
    }), /outDir must live under the OS temporary directory/);
    assert.equal(fs.existsSync(outsideOut), false);

    // 生产形状的源根（仓库本身）：没有显式 allowExternalSourceRoot 就拒绝 —— 而且在读任何源文件之前。
    const repoRoot = path.resolve(HERE, '..');
    assert.throws(() => syncFromSessionTail({
      sourceRoot: repoRoot,
      manifestPath: tailManifest('m-repo.jsonl', [{ file: path.join(HERE, 'echo-source-build.mjs'), sid: path.basename(HERE) }]),
      outDir: path.join(ROOT, 'tail-out-repo'), dbPath, builtAt: '2026-11-15T11:00:00.000Z'
    }), /allowExternalSourceRoot/);
    assert.equal(fs.existsSync(path.join(ROOT, 'tail-out-repo')), false);

    const bare = path.join(ROOT, 'tail-bare.sqlite');
    const bareDb = openDatabase(bare, { readOnly: false });
    try { configureConnection(bareDb, { memory: true }); bareDb.exec('CREATE TABLE placeholder (x INTEGER)'); } finally { bareDb.close(); }
    assert.throws(() => syncFromSessionTail({
      sourceRoot: TAIL_SESS, manifestPath: tailManifest('m-guard2.jsonl', [{ file, sid: 'session-tail-guard' }]),
      outDir: path.join(ROOT, 'tail-out-bare'), dbPath: bare, builtAt: '2026-11-15T11:00:00.000Z'
    }), /lacks the v9 ECHO structure/);

    const onlyTools = tailSession('session-tail-empty', [tailRec('tool/call', 0, 1790000001000, { name: 'x', arguments: {} })]);
    assert.throws(() => syncFromSessionTail({
      sourceRoot: TAIL_SESS, manifestPath: tailManifest('m-guard3.jsonl', [{ file: onlyTools, sid: 'session-tail-empty' }]),
      outDir: path.join(ROOT, 'tail-out-empty'), dbPath, builtAt: '2026-11-15T11:00:00.000Z'
    }), /produced no user\/assistant rows at all/);
    assert.equal(fs.existsSync(path.join(ROOT, 'tail-out-empty')), false);
  });

  check('tail 构建：上一代的游标版本或状态对不上 → 拒绝，不猜着往前走', () => {
    const file = tailSession('session-tail-state', TAIL_RECORDS);
    const manifestPath = tailManifest('m-state.jsonl', [{ file, sid: 'session-tail-state' }]);
    const dbPath = path.join(ROOT, 'tail-state.sqlite');
    makeV9(dbPath);
    const sourcePath = path.resolve(TAIL_SESS).replace(/\\/g, '/');
    const insert = (state, cursorJson) => {
      const db = openDatabase(dbPath, { readOnly: false });
      try {
        configureConnection(db, { memory: true });
        db.prepare('INSERT OR REPLACE INTO echo_index_sources (echo_source_id, source_path, source_version, namespace, generation, state, cursor_seq, cursor_json, words_count, summaries_count, src_seq_count, source_sha256, source_bytes, built_at, imported_at, importer) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(echoSourceIdFor(sourcePath, ECHO_INDEX_VERSION), sourcePath, ECHO_INDEX_VERSION, 'log', 3, state, 0, cursorJson, 0, 0, 0, 'f'.repeat(64), 0, '2026-11-15T11:00:00.000Z', '2026-11-15T11:00:00.000Z', 'synthetic-selftest');
      } finally { db.close(); }
    };
    // 状态没提交：上一代是个不可用的底座
    insert('failed', JSON.stringify({ seq: 0, tail: { version: SESSION_TAIL_VERSION, files: {} } }));
    assert.throws(() => syncFromSessionTail({
      sourceRoot: TAIL_SESS, manifestPath, outDir: path.join(ROOT, 'tail-out-state1'), dbPath, builtAt: '2026-11-15T11:00:00.000Z'
    }), /is not committed|refusing to build the next generation/);
    // 游标版本对不上：这份 cursor 不是本 builder 写的
    insert('committed', JSON.stringify({ seq: 0, tail: { version: 'session-tail/0', files: {} } }));
    assert.throws(() => syncFromSessionTail({
      sourceRoot: TAIL_SESS, manifestPath, outDir: path.join(ROOT, 'tail-out-state2'), dbPath, builtAt: '2026-11-15T11:00:00.000Z'
    }), /tail cursor version/);
    assert.equal(fs.existsSync(path.join(ROOT, 'tail-out-state1')), false);
    assert.equal(fs.existsSync(path.join(ROOT, 'tail-out-state2')), false);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // feed 模式：只读复制**权威 ECHO 索引 JSONL** → importer 形状
  //   全部夹具在 os.tmpdir() 之下；源身份一律是**不存在**的合成 session 路径 ——
  //   这条路径上任何一次真去读会话日志的尝试都会立刻失败（不读原始 zstd 是设计）。
  // ══════════════════════════════════════════════════════════════════════════
  const FEED = path.join(ROOT, 'feed');
  fs.mkdirSync(FEED, { recursive: true });
  const FEED_WS = '--D-AI-synthetic-feed--';
  const FEED_SID = 'session-feed-a1';
  const FEED_SID_B = 'session-feed-b2';
  const feedLog = (sid) => 'D:/synthetic/echo-index-feed/sessions/' + FEED_WS + '/' + sid + '/session.v4.jsonl.zstd';
  const FEED_LOG = feedLog(FEED_SID);
  const FEED_LOG_B = feedLog(FEED_SID_B);
  const feedFileRow = (logPath, sid, nextByte, key) => ({
    file: path.resolve(logPath), key: key === undefined ? '1790000000000:' + nextByte : key,
    nextByte, ws: FEED_WS, sid, nSum: 0, nWord: 0,
    sumOut: 'D:/synthetic/echo-index-feed/shards/' + sid + '.sum.jsonl',
    wordOut: 'D:/synthetic/echo-index-feed/shards/' + sid + '.word.jsonl'
  });
  const feedWord = (o) => {
    const row = { t: o.t === undefined ? '2026-11-15T09:00:00' : o.t, session: o.session === undefined ? FEED_SID : o.session, ws: o.ws === undefined ? FEED_WS : o.ws, seq: o.seq, turn: null, log: o.log === undefined ? FEED_LOG : o.log };
    if (o.role !== undefined) row.role = o.role;
    row.kind = o.kind === undefined ? 'human' : o.kind;
    row.len = o.len === undefined ? Array.from(o.text).length : o.len;
    row.truncated = o.truncated === true;
    row.text = o.text;
    return row;
  };
  const feedSummary = (o) => ({
    id: o.id, t: o.t === undefined ? '2026-11-15T09:05:00' : o.t,
    session: o.session === undefined ? FEED_SID : o.session, ws: o.ws === undefined ? FEED_WS : o.ws,
    log: o.log === undefined ? FEED_LOG : o.log, srcSeqs: o.srcSeqs,
    shadowedTokens: o.shadowedTokens === undefined ? 5 : o.shadowedTokens,
    chars: o.chars === undefined ? 7 : o.chars,
    provider: o.provider === undefined ? 'synthetic' : o.provider,
    model: o.model === undefined ? 'synthetic-summary' : o.model,
    status: o.status === undefined ? 'active' : o.status,
    summary: o.summary, manifest: o.manifest === undefined ? { range: [0, 0], n: o.srcSeqs.length, marks: [] } : o.manifest
  });
  const enc = (x) => (typeof x === 'string' ? x : JSON.stringify(x));
  function writeFeed(dirName, spec) {
    const dir = path.join(FEED, dirName);
    fs.mkdirSync(dir, { recursive: true });
    const write = (name, list) => {
      const file = path.join(dir, name);
      const body = list.map(enc).join('\n');
      const finalLf = spec.finalLf !== false;
      if (list.length === 0) fs.writeFileSync(file, Buffer.from(finalLf ? '\n' : '', 'utf8'));
      else fs.writeFileSync(file, Buffer.from(body + (finalLf ? '\n' : ''), 'utf8'));
      return file;
    };
    return {
      dir, filesPath: write('files.jsonl', spec.files || []), wordsPath: write('words.jsonl', spec.words || []),
      summariesPath: write('summaries.jsonl', spec.summaries || [])
    };
  }
  const feedOptions = (fixture, extra) => ({
    filesPath: fixture.filesPath, wordsPath: fixture.wordsPath, summariesPath: fixture.summariesPath,
    sourcePath: 'D:/synthetic/echo-index-feed/index', namespace: 'log', generation: 1,
    builtAt: '2026-11-15T13:00:00.000Z', outDir: path.join(fixture.dir, 'out', 'g1'),
    ...(extra || {})
  });
  const readFeedRows = (file) => fs.readFileSync(file, 'utf8').trimEnd().split('\n').filter((l) => l).map(JSON.parse);
  const feedGenOptions = (fixture, gen) => feedOptions(fixture, { generation: gen, outDir: path.join(fixture.dir, 'out', 'g' + gen) });
  const FEED_RAW = () => {
    const base = {
      files: [feedFileRow(FEED_LOG, FEED_SID, 4096)],
      words: [feedWord({ seq: 0, text: 'feed query alpha' }), feedWord({ seq: 1, text: 'feed answer beta', kind: '结论', role: 'assistant' })],
      summaries: [feedSummary({ id: 'cmp-feed-alpha', srcSeqs: [1, 0, 1], summary: 'summary of alpha and beta' })]
    };
    return base;
  };
  function rawFeed(dirName, bytesOf) {
    const dir = path.join(FEED, dirName);
    fs.mkdirSync(dir, { recursive: true });
    const out = { dir };
    for (const [name, key] of [['files.jsonl', 'filesPath'], ['words.jsonl', 'wordsPath'], ['summaries.jsonl', 'summariesPath']]) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, bytesOf[name]);
      out[key] = file;
    }
    return out;
  }
  const feedLines = (list) => Buffer.from(list.map(enc).join('\n') + '\n', 'utf8');

  check('feed: the authoritative ECHO index is copied verbatim into an importer-shaped triplet', () => {
    const fixture = writeFeed('happy', { ...FEED_RAW(), finalLf: false });
    const built = buildFromEchoIndexFiles(feedOptions(fixture));
    assert.equal(built.manifest.version, ECHO_INDEX_FEED_VERSION);
    assert.equal(built.manifest.echoIndexVersion, 'echo-index/1');
    // ★ 默认 API 行为**显式钉死**（2026-11-16）：不传 sourceVersion 时
    //   ① manifest.version 仍是清单格式版本（旧行为逐字节不变）；
    //   ② 不发 feedFormat 键 —— 清单里没有第三个版本字段可被误读；
    //   ③ 源身份仍然是 importer 实际用的那把钥匙，与 version 字段无关。
    assert.equal(Object.prototype.hasOwnProperty.call(built.manifest, 'feedFormat'), false, '默认路径不许凭空长出新键');
    // 完整键序 = 改动前那份清单的键序（逐条对上）：多一个键、少一个键、挪一个位置都在这里失败。
    assert.deepEqual(Object.keys(built.manifest), [
      'echoIndexVersion', 'sourcePath', 'version', 'namespace', 'generation', 'builtAt',
      'cursor', 'words', 'summaries', 'counts', 'summaryRefs', 'pointerLimitations', 'sourceInput'
    ], '默认路径不许长出新键、也不许改键序（既有调用方的清单字节比对靠它）');
    assert.equal(built.sourceIdentity.sourceVersion, ECHO_INDEX_VERSION);
    assert.equal(built.sourceIdentity.manifestVersionField, ECHO_INDEX_FEED_VERSION);
    assert.equal(built.sourceIdentity.echoSourceId, echoSourceIdFor('D:/synthetic/echo-index-feed/index', ECHO_INDEX_VERSION));
    assert.equal(built.manifest.namespace, 'log');
    assert.equal(built.manifest.generation, 1);
    assert.equal(built.manifest.counts.words, 2);
    assert.equal(built.manifest.counts.summaries, 1);
    assert.equal(built.manifest.counts.srcSeqs, 3);
    assert.equal(built.manifest.sourceInput.words.finalLf, false, '权威索引不以 LF 结尾是事实：收下并记进清单');
    assert.equal(built.manifest.counts.lenRebased, 0);
    const words = readFeedRows(built.wordsPath);
    assert.deepEqual(Object.keys(words[0]), [...ECHO_WORD_FIELDS], '发射行严格是 importer 的字段序（含 role）');
    assert.deepEqual(words.map((w) => w.role), ['user', 'assistant'], 'kind human/结论 → role user/assistant');
    assert.deepEqual(words.map((w) => w.kind), ['human', '结论'], 'kind 原样保留');
    assert.deepEqual(words.map((w) => w.text), ['feed query alpha', 'feed answer beta'], 'text 逐字复制');
    assert.deepEqual(words.map((w) => w.len), [16, 16]);
    assert.equal(words.every((w) => w.log === FEED_LOG), true, 'log 原样（正斜杠）——加入 files.jsonl 时是按路径身份归一的');
    assert.equal(words.every((w) => w.t === '2026-11-15T09:00:00'), true, 't 原样保留，不重排时区');
    assert.equal(words.every((w) => w.turn === null && w.truncated === false), true);
    const summaries = readFeedRows(built.summariesPath);
    assert.deepEqual(Object.keys(summaries[0]), [...ECHO_INDEX_FEED_SUMMARY_FIELDS], '摘要行 = importer 12 字段 + 原样 manifest');
    assert.equal(summaries[0].cmpId, 'cmp-feed-alpha', 'id → cmpId');
    assert.deepEqual(summaries[0].srcSeqs, [1, 0, 1], '稀疏与重复原样保留');
    assert.equal(summaries[0].shadowedChars, 7, 'chars → shadowedChars');
    assert.deepEqual(summaries[0].manifest, { range: [0, 0], n: 3, marks: [] }, 'manifest 原样保留');
    assert.equal(built.manifest.counts.srcSeqResolved, 3);
    assert.equal(built.manifest.counts.srcSeqDangling, 0);
    const again = buildFromEchoIndexFiles(feedOptions(fixture, { outDir: path.join(fixture.dir, 'out', 'g1-again') }));
    assert.deepEqual(fs.readFileSync(again.wordsPath), fs.readFileSync(built.wordsPath), '同一份输入 → 同一份 words 字节');
    assert.deepEqual(fs.readFileSync(again.summariesPath), fs.readFileSync(built.summariesPath), '同一份输入 → 同一份 summaries 字节');
  });


  // ── 清单里的两个版本：显式 sourceVersion 出口 ────────────────────────────────
  //   实测背景（2026-11-16，读 echo-index-import.mjs）：
  //     importer 校验并用于派生 echo_source_id 的是 manifest.echoIndexVersion，
  //     **从不读** manifest.version。所以「清单说要导成什么源身份」这件事
  //     历史上只能靠下游把清单读出来、改 version、再写回去 —— 那就是手改清单。
  //   这条用例走的是新出口：构建时就声明 sourceVersion，产出的清单**原样**喂给
  //   importer CLI（不读回、不改、不重算 SHA），IMPORTED 之后再跑一次 ALREADY_CURRENT。
  check('feed: an explicit sourceVersion carries the source identity without patching the manifest afterwards', () => {
    const fixture = writeFeed('explicit-version', { ...FEED_RAW(), finalLf: true });
    const built = buildFromEchoIndexFiles(feedOptions(fixture, {
      sourceVersion: ECHO_INDEX_VERSION,
      outDir: path.join(fixture.dir, 'out', 'v1')
    }));
    // ① 清单形状：源身份版本在 version，清单格式单独记在 feedFormat
    assert.equal(built.manifest.version, ECHO_INDEX_VERSION, 'manifest.version 现在承载源身份版本');
    assert.equal(built.manifest.feedFormat, ECHO_INDEX_FEED_VERSION, '清单格式版本单独一个字段，不再冒充源身份');
    assert.equal(built.manifest.echoIndexVersion, ECHO_INDEX_VERSION, 'echoIndexVersion 不变：它才是 importer 读的那个');
    assert.equal(ECHO_INDEX_VERSION_RE.test(built.manifest.version), true, '清单里的 version 必须过 importer 的正则');
    assert.equal(ECHO_INDEX_VERSION_RE.test(built.manifest.feedFormat), false, '清单格式版本**不该**长得像源身份版本（防误用）');
    // 显式模式与默认模式**只差 version 的取值和 feedFormat 这一个键**，别的键位一个都不许动。
    assert.deepEqual(Object.keys(built.manifest), [
      'echoIndexVersion', 'sourcePath', 'version', 'feedFormat', 'namespace', 'generation', 'builtAt',
      'cursor', 'words', 'summaries', 'counts', 'summaryRefs', 'pointerLimitations', 'sourceInput'
    ], '显式模式只是在 version 后面多一个 feedFormat');
    // ② 盘上的字节就是构建器算的那一份：没有任何人在事后改过它
    assert.equal(sha(fs.readFileSync(built.manifestPath)), built.manifestSha256);
    // 在**序列化面**上比（内存里的 cursor.feed.files 是 null 原型对象，JSON 解析回来是普通对象 ——
    // 比原型链没意义；要比的是「盘上那份字节就是构建器返回的那份」）。
    assert.equal(fs.readFileSync(built.manifestPath, 'utf8'), JSON.stringify(built.manifest, null, 2) + '\n', '盘上的清单就是返回的那一份（没人改过）');
    // ③ 原样喂 importer CLI：IMPORTED
    const versionDbPath = path.join(ROOT, 'feed-explicit-version.sqlite');
    makeV9(versionDbPath);
    const first = importBuilt(built.manifestPath, versionDbPath);
    assert.equal(first.code, 'IMPORTED');
    assert.equal(first.wrote, true);
    assert.equal(first.manifest.sha256, built.manifestSha256, 'importer 收到的就是构建器写的那份字节（没有补丁流程）');
    assert.equal(first.source.path, built.manifest.sourcePath);
    assert.equal(first.source.version, ECHO_INDEX_VERSION, '库里记下的源版本 = echoIndexVersion，不是 manifest.version 的旧值');
    assert.equal(first.source.echoSourceId, built.sourceIdentity.echoSourceId, '源 id 与构建器声明的同一个（echoSourceIdFor(path, ECHO_INDEX_VERSION)）');
    assert.equal(first.source.echoSourceId, echoSourceIdFor(built.manifest.sourcePath, ECHO_INDEX_VERSION));
    assert.equal(first.generation, 1);
    // ④ Import uses the current source-tree schema version; do not pin this regression to a historical migration.
    assert.equal(first.db.schemaVersion, SCHEMA_VERSION);
    assert.equal(first.db.codeSchemaVersion, SCHEMA_VERSION);
    const versionStore = ownStore(openMetaStore({ path: versionDbPath, mode: 'readonly' }));
    try {
      const rows = versionStore.db.prepare('SELECT echo_source_id, source_path, source_version, generation, state, source_sha256, words_count, summaries_count FROM echo_index_sources').all();
      assert.equal(rows.length, 1, '一个源一行');
      assert.equal(rows[0].echo_source_id, built.sourceIdentity.echoSourceId);
      assert.equal(rows[0].source_path, built.manifest.sourcePath);
      assert.equal(rows[0].source_version, ECHO_INDEX_VERSION);
      assert.equal(rows[0].generation, 1);
      assert.equal(rows[0].state, 'committed');
      // ★ 库里记的 source_sha256 就是**构建器自己算的那个**。这条断言是「不许手改清单」的判据本身：
      //   一旦有人构建后把清单读出来改字段再写回，字节变了、SHA 就不等于这里存的值，
      //   同一代再导入同一份构建产物就会撞 GENERATION_CONFLICT —— 幂等性被一次「无害的改名」弄没。
      assert.equal(rows[0].source_sha256, built.manifestSha256);
      assert.equal(rows[0].words_count, built.manifest.counts.words);
      assert.equal(rows[0].summaries_count, built.manifest.counts.summaries);
      assert.equal(versionStore.echoStats().aligned, true);
    } finally { closeStore(versionStore); }
    // ④ 同一代、同一份字节 → ALREADY_CURRENT（幂等；身份没变，所以找得到那一行）
    const second = importBuilt(built.manifestPath, versionDbPath);
    assert.equal(second.code, 'ALREADY_CURRENT');
    assert.equal(second.wrote, false);
    assert.equal(second.source.echoSourceId, first.source.echoSourceId, '两次的源身份必须同一个 —— 否则「续代」会退化成「新源」');
    assert.equal(second.generation, 1);
    const againStore = ownStore(openMetaStore({ path: versionDbPath, mode: 'readonly' }));
    try {
      assert.equal(againStore.db.prepare('SELECT COUNT(*) AS n FROM echo_index_sources').get().n, 1, 'ALREADY_CURRENT 不许多写一行源');
      assert.equal(againStore.db.prepare('SELECT COUNT(*) AS n FROM echo_source_builds').get().n, 1, 'ALREADY_CURRENT 不许追加构建审计');
      assert.equal(againStore.echoStats().words, built.manifest.counts.words);
      assert.equal(againStore.db.prepare('SELECT COUNT(*) AS n FROM echo_words').get().n, built.manifest.counts.words);
    } finally { closeStore(againStore); }
  });

  check('feed: the explicit sourceVersion is validated against the importer contract and never silently defaults', () => {
    const fixture = writeFeed('explicit-version-bad', { ...FEED_RAW(), finalLf: true });
    const badCases = [
      // 清单格式版本被当成源身份：正是历史 bug 的形状 —— 拒，而不是「差不多就收下」。
      [ECHO_INDEX_FEED_VERSION, /sourceVersion must match the importer source-version shape/],
      ['echo-index-feed/2', /sourceVersion must match the importer source-version shape/],
      ['echo-index-1', /sourceVersion must match the importer source-version shape/],
      ['', /sourceVersion must be a non-empty string/],
      [null, /sourceVersion must be a non-empty string/],
      // 外形对但值不同：清单会声称一个 import 路径永远不会记录的源身份 —— 拒（不制造静默的身份分叉）。
      ['echo-index/2', /sourceVersion must equal "echo-index\/1"/],
    ];
    const usedOutDirs = [];
    for (const [value, pattern] of badCases) {
      const outDir = path.join(fixture.dir, 'out', 'bad-' + (value === null ? 'null' : String(value).replace(/[\/]/g, '_')));
      usedOutDirs.push(outDir);
      assert.throws(() => buildFromEchoIndexFiles(feedOptions(fixture, { sourceVersion: value, outDir })), pattern);
    }
    // 显式 undefined 等于「不传」：保持旧行为（不是「悄悄换成默认值」）。
    const implicit = buildFromEchoIndexFiles(feedOptions(fixture, { sourceVersion: undefined, outDir: path.join(fixture.dir, 'out', 'implicit') }));
    const explicitDefault = buildFromEchoIndexFiles(feedOptions(fixture, { sourceVersion: ECHO_INDEX_VERSION, outDir: path.join(fixture.dir, 'out', 'explicit-default') }));
    assert.equal(implicit.manifest.version, ECHO_INDEX_FEED_VERSION, 'undefined = 旧行为');
    assert.equal(Object.prototype.hasOwnProperty.call(implicit.manifest, 'feedFormat'), false);
    assert.equal(explicitDefault.manifest.version, ECHO_INDEX_VERSION);
    assert.notEqual(implicit.manifest.version, explicitDefault.manifest.version, '两种模式的清单**本来就不同**：它的差异是显式的，不是被默认值抹平的');
    // words / summaries 字节与环境无关：差异只在清单里那两行
    assert.deepEqual(fs.readFileSync(implicit.wordsPath), fs.readFileSync(explicitDefault.wordsPath));
    assert.deepEqual(fs.readFileSync(implicit.summariesPath), fs.readFileSync(explicitDefault.summariesPath));
    // 被拒的构建一个目录都不许留下
    for (const dir of usedOutDirs) {
      assert.equal(fs.existsSync(dir), false, '拒绝时不许留下输出：' + dir);
    }
  });

  check('feed: len is re-measured from the text (the producer counts UTF-16 units) and counted', () => {
    const emoji = 'feed answer with an emoji \u{1F600}';
    const fixture = writeFeed('len', {
      files: [feedFileRow(FEED_LOG, FEED_SID, 10)],
      words: [
        feedWord({ seq: 0, text: 'feed query' }),
        feedWord({ seq: 1, text: emoji, kind: '结论', role: 'assistant', len: emoji.length })
      ],
      summaries: []
    });
    const built = buildFromEchoIndexFiles(feedOptions(fixture));
    const words = readFeedRows(built.wordsPath);
    assert.equal(words[1].text, emoji, 'text 一个字符都不许改');
    assert.equal(words[1].len, Array.from(emoji).length, 'len 按码点重测（importer 的尺子）');
    assert.notEqual(words[1].len, emoji.length, '生产者的 len 是 UTF-16 长度');
    assert.equal(built.manifest.counts.lenRebased, 1, '重测过的行必须计数，不许静默改');
    assert.deepEqual(fs.readFileSync(built.summariesPath), Buffer.from('\n', 'utf8'), '零摘要 = canonical 空工件');
    assert.equal(built.manifest.summaries.rows, 0);
  });

  check('feed: exact replay rows are deduped, conflicting same-id / same-seq rows are refused', () => {
    const replayWord = feedWord({ seq: 1, text: 'feed answer beta', kind: '结论', role: 'assistant' });
    const replaySummary = feedSummary({ id: 'cmp-feed-replay', srcSeqs: [0, 1], summary: 'replayed summary' });
    const fixture = writeFeed('replay', {
      files: [feedFileRow(FEED_LOG, FEED_SID, 20)],
      words: [feedWord({ seq: 0, text: 'feed query alpha' }), replayWord, JSON.stringify(replayWord)],
      summaries: [replaySummary, JSON.stringify(replaySummary)]
    });
    const built = buildFromEchoIndexFiles(feedOptions(fixture));
    assert.equal(built.manifest.counts.words, 2, '逐字节相同的 words 重放只发一次');
    assert.equal(built.manifest.counts.exactDuplicateWords, 1);
    assert.equal(built.manifest.counts.summaries, 1);
    assert.equal(built.manifest.counts.exactDuplicateSummaries, 1);

    const conflict = writeFeed('conflict', {
      files: [feedFileRow(FEED_LOG, FEED_SID, 20), feedFileRow(FEED_LOG_B, FEED_SID_B, 30)],
      words: [feedWord({ seq: 0, text: 'feed query alpha' }), feedWord({ seq: 0, text: 'other session query', session: FEED_SID_B, log: FEED_LOG_B })],
      summaries: [
        feedSummary({ id: 'cmp-feed-dup', srcSeqs: [0], summary: 'first copy' }),
        feedSummary({ id: 'cmp-feed-dup', session: FEED_SID_B, log: FEED_LOG_B, srcSeqs: [0], summary: 'second copy' })
      ]
    });
    assert.throws(() => buildFromEchoIndexFiles(feedOptions(conflict)), /SUMMARY_ID_CONFLICT/);
    assert.equal(fs.existsSync(path.join(conflict.dir, 'out', 'g1')), false, '拒绝时不许留下任何输出');

    const wordConflict = writeFeed('word-conflict', {
      files: [feedFileRow(FEED_LOG, FEED_SID, 20)],
      words: [feedWord({ seq: 0, text: 'one' }), feedWord({ seq: 0, text: 'two' })],
      summaries: []
    });
    assert.throws(() => buildFromEchoIndexFiles(feedOptions(wordConflict)), /WORD_SEQ_CONFLICT/);
    assert.equal(fs.existsSync(path.join(wordConflict.dir, 'out', 'g1')), false);
  });

  check('feed: unsupported kinds and truncated rows are excluded fail-closed and counted', () => {
    const fixture = writeFeed('kinds', {
      files: [feedFileRow(FEED_LOG, FEED_SID, 40)],
      words: [
        feedWord({ seq: 0, text: 'feed query alpha' }),
        feedWord({ seq: 1, text: 'feed answer beta', kind: '结论', role: 'assistant' }),
        feedWord({ seq: 2, text: 'task prompt text', kind: 'task' }),
        feedWord({ seq: 3, text: 'hidden reasoning text', kind: 'reasoning', role: 'reasoning' }),
        feedWord({ seq: 4, text: 'cut off half', kind: '结论', role: 'assistant', truncated: true })
      ],
      summaries: []
    });
    const built = buildFromEchoIndexFiles(feedOptions(fixture));
    assert.equal(built.manifest.counts.words, 2);
    assert.equal(built.manifest.counts.excludedReasoning, 1);
    assert.equal(built.manifest.counts.truncatedExcluded, 1);
    assert.equal(built.manifest.counts.excludedByType['kind:task'], 1);
    assert.equal(built.manifest.counts.excludedByType['truncated:结论'], 1);
    const texts = readFeedRows(built.wordsPath).map((w) => w.text);
    assert.deepEqual(texts, ['feed query alpha', 'feed answer beta']);
    // role 与 kind 互相矛盾 → 拒（不许挑一个）
    const contradiction = writeFeed('role-contradiction', {
      files: [feedFileRow(FEED_LOG, FEED_SID, 40)],
      words: [feedWord({ seq: 0, text: 'feed query alpha', kind: 'human', role: 'assistant' })],
      summaries: []
    });
    assert.throws(() => buildFromEchoIndexFiles(feedOptions(contradiction)), /contradicts kind/);
  });

  check('feed: a srcSeq that does not resolve to an emitted word in the same session is refused by default', () => {
    const dangling = writeFeed('dangling', {
      files: [feedFileRow(FEED_LOG, FEED_SID, 20)],
      words: [feedWord({ seq: 0, text: 'feed query alpha' })],
      summaries: [feedSummary({ id: 'cmp-feed-dangle', srcSeqs: [0, 9], summary: 'summary with a hole' })]
    });
    assert.throws(() => buildFromEchoIndexFiles(feedOptions(dangling)), /SRC_SEQ_DANGLING/);
    assert.equal(fs.existsSync(path.join(dangling.dir, 'out', 'g1')), false);

    const crossSession = writeFeed('dangling-cross', {
      files: [feedFileRow(FEED_LOG, FEED_SID, 20), feedFileRow(FEED_LOG_B, FEED_SID_B, 30)],
      words: [feedWord({ seq: 0, text: 'feed query alpha' })],
      summaries: [feedSummary({ id: 'cmp-feed-cross', session: FEED_SID_B, log: FEED_LOG_B, srcSeqs: [0], summary: 'borrowed seq' })]
    });
    assert.throws(() => buildFromEchoIndexFiles(feedOptions(crossSession)), /SRC_SEQ_DANGLING/, 'srcSeq 只认同会话的已发射 word');

    const preserved = writeFeed('dangling-opt-in', {
      files: [feedFileRow(FEED_LOG, FEED_SID, 20), feedFileRow(FEED_LOG_B, FEED_SID_B, 30)],
      words: [feedWord({ seq: 0, text: 'feed query alpha', log: FEED_LOG })],
      summaries: [
        feedSummary({ id: 'cmp-feed-opt-in', log: FEED_LOG, srcSeqs: [0, 9, 0], summary: 'ordered refs' }),
        feedSummary({ id: 'cmp-feed-cross-opt-in', session: FEED_SID_B, log: FEED_LOG_B, srcSeqs: [0], summary: 'other session same seq' })
      ]
    });
    const strictOptions = { ...feedOptions(preserved), outDir: path.join(preserved.dir, 'out', 'strict-g1') };
    let strictError = null;
    try { buildFromEchoIndexFiles(strictOptions); } catch (e) { strictError = e; }
    assert.ok(strictError && /SRC_SEQ_DANGLING/.test(strictError.message), 'default remains strict: ' + (strictError && strictError.message));
    const built = buildFromEchoIndexFiles({ ...feedOptions(preserved), outDir: path.join(preserved.dir, 'out', 'opt-in-g1'), allowDanglingSrcSeq: true });
    const rows = readFeedRows(built.summariesPath);
    assert.deepEqual(rows.map((r) => r.srcSeqs), [[0, 9, 0], [0]], 'all refs retain exact order and duplicates');
    assert.equal(built.manifest.counts.srcSeqs, 4);
    assert.equal(built.manifest.counts.srcSeqResolved, 2);
    assert.equal(built.manifest.counts.srcSeqDangling, 2);
    assert.equal(built.manifest.counts.words, 1, 'opt-in must not synthesize words for dangling refs');
    const dbPath = path.join(ROOT, 'dangling-opt-in.sqlite');
    makeV9(dbPath);
    const imported = importBuilt(built.manifestPath, dbPath, built.manifest.generation);
    assert.equal(imported.code, 'IMPORTED');
    assert.equal(imported.counts.summaries, 2);
    assert.equal(imported.counts.srcSeqs, 4);
    const store = ownStore(openMetaStore({ path: dbPath, mode: 'readonly' }));
    try {
      assert.equal(store.echoStats().aligned, true);
      const opened = store.echoOpen('idx:cmp-feed-opt-in');
      assert.equal(opened.opensFrame, false, 'idx returns summary/reference data, not a frame-open promise');
      assert.deepEqual(opened.srcSeqs, [0, 9, 0]);
      assert.deepEqual(store.echoOpen('idx:cmp-feed-cross-opt-in').srcSeqs, [0]);
      assert.throws(() => store.echoOpen('log:' + FEED_SID_B + '#seq=0'), /no ECHO word indexed/, 'same numeric seq in another session is not re-pointed');
      assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM echo_words').get().n, 1, 'opt-in must not create words for dangling refs');
      assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM echo_summaries').get().n, 2);
    } finally { closeStore(store); }
  });

  check('feed: input JSONL shape is validated strictly (UTF-8 / final LF / exact field set)', () => {
    const base = FEED_RAW();
    const good = {
      'files.jsonl': feedLines(base.files),
      'words.jsonl': feedLines(base.words),
      'summaries.jsonl': feedLines(base.summaries)
    };
    const badUtf8 = rawFeed('bad-utf8', { ...good, 'words.jsonl': Buffer.concat([Buffer.from('{"t":"x"', 'utf8'), Buffer.from([0xff, 0xfe]), Buffer.from('\n', 'utf8')]) });
    assert.throws(() => buildFromEchoIndexFiles(feedOptions(badUtf8)), /not valid UTF-8/);

    const truncatedTail = rawFeed('bad-tail', {
      ...good,
      'words.jsonl': Buffer.concat([feedLines(base.words), Buffer.from('{"t":"2026-11-15T09:10:00","session":"session-feed-a1","ws":null,"seq":2,"turn":null,"log":"D:/x","kind":"human","len":5,"truncated":false,"te', 'utf8')])
    });
    assert.throws(() => buildFromEchoIndexFiles(feedOptions(truncatedTail)), /truncated write|does not end with LF/);

    const bom = rawFeed('bad-bom', { ...good, 'files.jsonl': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), good['files.jsonl']]) });
    assert.throws(() => buildFromEchoIndexFiles(feedOptions(bom)), /BOM/);

    const extra = rawFeed('bad-fields', {
      ...good,
      'words.jsonl': feedLines([{ ...base.words[0], extra: 'not part of the contract' }])
    });
    assert.throws(() => buildFromEchoIndexFiles(feedOptions(extra)), /field set/);

    const blank = rawFeed('bad-blank', { ...good, 'files.jsonl': Buffer.from(JSON.stringify(base.files[0]) + '\n\n', 'utf8') });
    assert.throws(() => buildFromEchoIndexFiles(feedOptions(blank)), /non-blank JSONL row/);

    const unmapped = writeFeed('unmapped', {
      files: [feedFileRow(FEED_LOG, FEED_SID, 20)],
      words: [feedWord({ seq: 0, text: 'feed query alpha', log: 'D:/synthetic/echo-index-feed/sessions/--D-AI-synthetic-feed--/session-nowhere/session.v4.jsonl.zstd' })],
      summaries: []
    });
    assert.throws(() => buildFromEchoIndexFiles(feedOptions(unmapped)), /no files\.jsonl record/);
    for (const name of ['bad-utf8', 'bad-tail', 'bad-bom', 'bad-fields', 'bad-blank', 'unmapped']) {
      assert.equal(fs.existsSync(path.join(FEED, name, 'out', 'g1')), false, '任何一条拒绝都不许留下输出: ' + name);
    }
  });

  check('feed: a 0-byte summaries artifact is a canonical zero-row file (same output as a single LF)', () => {
    const base = FEED_RAW();
    const good = {
      'files.jsonl': feedLines(base.files),
      'words.jsonl': feedLines(base.words),
      'summaries.jsonl': feedLines(base.summaries)
    };
    const ZERO = Buffer.alloc(0);
    const ONE_LF = Buffer.from('\n', 'utf8');

    // 读者层：允许空只对 summaries 成立，且两种形态同义（零行），finalLf 如实记录。
    const zeroReader = rawFeed('empty-sum-reader-zero', { ...good, 'summaries.jsonl': ZERO });
    const parsedZero = readEchoIndexJsonl(zeroReader.summariesPath, 'summaries.jsonl', [ECHO_INDEX_SUMMARY_FIELDS], { allowEmpty: true });
    assert.equal(parsedZero.rows.length, 0, '0 字节 = 零行，不是「跳过这个工件」');
    assert.equal(parsedZero.bytes, 0);
    assert.equal(parsedZero.finalLf, false, '0 字节确实没有 LF：如实记录，不假装有终止符');
    // 开关本身必须可证：同一份 0 字节字节，没开 allowEmpty 就是「空」。
    assert.throws(() => readEchoIndexJsonl(zeroReader.summariesPath, 'summaries.jsonl', [ECHO_INDEX_SUMMARY_FIELDS], { allowEmpty: false }), /summaries\.jsonl is empty/, '0 字节不是「隐形零行」：允许它必须显式开 allowEmpty');
    assert.throws(() => readEchoIndexJsonl(zeroReader.summariesPath, 'summaries.jsonl', [ECHO_INDEX_SUMMARY_FIELDS]), /summaries\.jsonl is empty/, '缺省 = 严格');
    const lfReader = rawFeed('empty-sum-reader-lf', { ...good, 'summaries.jsonl': ONE_LF });
    const parsedLf = readEchoIndexJsonl(lfReader.summariesPath, 'summaries.jsonl', [ECHO_INDEX_SUMMARY_FIELDS], { allowEmpty: true });
    assert.equal(parsedLf.rows.length, 0);
    assert.equal(parsedLf.bytes, 1);
    assert.equal(parsedLf.finalLf, true);

    // 构建层：零字节摘要 + 非空 words 成功，输出是 canonical 单 LF、计数 0。
    const zeroBuild = rawFeed('empty-sum-zero', { ...good, 'summaries.jsonl': ZERO });
    const builtZero = buildFromEchoIndexFiles(feedOptions(zeroBuild));
    assert.deepEqual(fs.readFileSync(builtZero.summariesPath), ONE_LF, '输出仍是 canonical 空工件（单个 LF）');
    assert.equal(fs.statSync(builtZero.summariesPath).size, 1);
    assert.equal(builtZero.manifest.counts.summaries, 0);
    assert.equal(builtZero.manifest.counts.summaryRows, 0, '输入零行就是零行');
    assert.equal(builtZero.manifest.summaries.rows, 0);
    assert.equal(builtZero.manifest.summaries.bytes, 1);
    assert.equal(builtZero.manifest.summaries.sha256, sha(ONE_LF));
    assert.equal(builtZero.manifest.counts.words, 2, '空摘要绝不代表整个源被跳过');
    assert.equal(builtZero.manifest.counts.files, 1);
    assert.equal(builtZero.manifest.counts.srcSeqs, 0);
    assert.equal(builtZero.manifest.sourceInput.summaries.bytes, 0, '输入指纹如实记 0 字节');
    assert.equal(builtZero.manifest.sourceInput.summaries.rows, 0);
    assert.equal(builtZero.manifest.sourceInput.summaries.finalLf, false);
    assert.deepEqual(readFeedRows(builtZero.wordsPath).map((w) => w.text), ['feed query alpha', 'feed answer beta']);

    // canonical 单 LF 摘要仍然成功，且与零字节**输出逐字节相同**（同一份工件）。
    const lfBuild = rawFeed('empty-sum-lf', { ...good, 'summaries.jsonl': ONE_LF });
    const builtLf = buildFromEchoIndexFiles(feedOptions(lfBuild));
    assert.equal(builtLf.manifest.counts.summaries, 0);
    assert.equal(builtLf.manifest.counts.summaryRows, 0);
    assert.deepEqual(fs.readFileSync(builtLf.summariesPath), fs.readFileSync(builtZero.summariesPath), '两种空输入产出同一份 summaries 字节');
    assert.equal(builtLf.manifest.summaries.sha256, builtZero.manifest.summaries.sha256);
    assert.deepEqual(fs.readFileSync(builtLf.wordsPath), fs.readFileSync(builtZero.wordsPath));
    assert.notEqual(builtLf.manifest.sourceInput.summaries.sha256, builtZero.manifest.sourceInput.summaries.sha256,
      '输入指纹必须如实区分「0 字节」与「1 字节 LF」');
  });

  check('feed: the empty-summaries allowance never leaks into words/files and never relaxes strict checks', () => {
    const base = FEED_RAW();
    const good = {
      'files.jsonl': feedLines(base.files),
      'words.jsonl': feedLines(base.words),
      'summaries.jsonl': feedLines(base.summaries)
    };
    const ZERO = Buffer.alloc(0);

    // 零字节 words / files 照旧拒绝：allowEmpty 是**逐个读者显式打开**的开关，缺省就是严格。
    const zeroWords = rawFeed('empty-guard-words', { ...good, 'words.jsonl': ZERO });
    assert.throws(() => readEchoIndexJsonl(zeroWords.wordsPath, 'words.jsonl', [ECHO_INDEX_WORD_FIELDS]), /words\.jsonl is empty/, 'words 读者缺省严格：零字节照旧是「空」');
    assert.throws(() => buildFromEchoIndexFiles(feedOptions(zeroWords)), /words\.jsonl is empty/);
    assert.equal(fs.existsSync(path.join(zeroWords.dir, 'out', 'g1')), false, '拒绝不许留下输出');
    const zeroFiles = rawFeed('empty-guard-files', { ...good, 'files.jsonl': ZERO });
    assert.throws(() => readEchoIndexJsonl(zeroFiles.filesPath, 'files.jsonl', [ECHO_INDEX_FILE_FIELDS]), /files\.jsonl is empty/, 'files 读者缺省严格：零字节照旧是「空」');
    assert.throws(() => buildFromEchoIndexFiles(feedOptions(zeroFiles)), /files\.jsonl is empty/);
    assert.equal(fs.existsSync(path.join(zeroFiles.dir, 'out', 'g1')), false);

    // 空摘要**不许**成为绕过「没有合格 words 就不许发一代」的缺口：非空 words 但零条合格，照旧拒。
    const ineligible = rawFeed('empty-guard-ineligible', {
      'files.jsonl': feedLines(base.files),
      'words.jsonl': feedLines([feedWord({ seq: 0, text: 'task prompt text', kind: 'task' })]),
      'summaries.jsonl': ZERO
    });
    assert.throws(() => buildFromEchoIndexFiles(feedOptions(ineligible)), /produced no user\/assistant rows for the selected sources; refusing to emit an empty generation/, '零字节摘要 + 零合格 words 仍然是「空的一代」');
    assert.equal(fs.existsSync(path.join(ineligible.dir, 'out', 'g1')), false, '拒绝不许留下输出');

    // 非空摘要文件的每一条严格校验都不放松（BOM / invalid UTF-8 / 空行 / 缺 LF 且末行残缺）。
    const strictSummaryRejects = [
      ['empty-guard-bom', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), good['summaries.jsonl']]), /BOM/],
      ['empty-guard-utf8', Buffer.concat([Buffer.from('{"id":"cmp-x"', 'utf8'), Buffer.from([0xff, 0xfe]), Buffer.from('\n', 'utf8')]), /not valid UTF-8/],
      ['empty-guard-blank', Buffer.concat([good['summaries.jsonl'], Buffer.from('\n', 'utf8')]), /non-blank JSONL row/],
      ['empty-guard-blank-only', Buffer.from('\n\n', 'utf8'), /non-blank JSONL row/],
      ['empty-guard-truncated', good['summaries.jsonl'].slice(0, good['summaries.jsonl'].length - 32), /does not end with LF|truncated write/]
    ];
    for (const [name, bytes, pattern] of strictSummaryRejects) {
      // 读者层：allowEmpty 开着也要拒 —— 拒绝只能来自内容本身，不能来自「没开 allowEmpty」。
      const reader = rawFeed(name + '-reader', { ...good, 'summaries.jsonl': bytes });
      assert.throws(() => readEchoIndexJsonl(reader.summariesPath, 'summaries.jsonl', [ECHO_INDEX_SUMMARY_FIELDS], { allowEmpty: true }), pattern, name + ' (reader)');
      // 构建层：同一份字节走完整路径，且不留任何输出。
      const fixture = rawFeed(name, { ...good, 'summaries.jsonl': bytes });
      assert.throws(() => buildFromEchoIndexFiles(feedOptions(fixture)), pattern, name + ' (build)');
      assert.equal(fs.existsSync(path.join(fixture.dir, 'out', 'g1')), false, '任何一条拒绝都不许留下输出: ' + name);
    }
  });

  check('feed: the writer refuses paths outside os.tmpdir and never touches its inputs', () => {
    const fixture = writeFeed('tmpguard', FEED_RAW());
    const inputs = [fixture.filesPath, fixture.wordsPath, fixture.summariesPath];
    const before = new Map(inputs.map((f) => [f, { bytes: fs.readFileSync(f), mtimeMs: fs.statSync(f).mtimeMs }]));
    const repoFile = path.join(HERE, 'echo-source-build.mjs');
    assert.throws(() => buildFromEchoIndexFiles({ ...feedOptions(fixture), wordsPath: repoFile }), /must live under the OS temporary directory/);
    const outside = path.join(HERE, 'feed-out-outside');
    assert.throws(() => buildFromEchoIndexFiles({ ...feedOptions(fixture), outDir: outside }), /must live under the OS temporary directory/);
    assert.equal(fs.existsSync(outside), false, '拒绝时不许在仓库里建目录');
    assert.throws(() => buildFromEchoIndexFiles({ ...feedOptions(fixture), outDir: undefined }), /missing explicit option outDir/);
    assert.throws(() => buildFromEchoIndexFiles(feedOptions(fixture, { sourcePath: 'D:\\synthetic\\feed' })), /sourcePath must be canonical/);
    assert.throws(() => buildFromEchoIndexFiles(feedOptions(fixture, { namespace: 'idx' })), /namespace must be log\|v4log/);
    buildFromEchoIndexFiles(feedOptions(fixture));
    for (const [file, snap] of before) {
      assert.deepEqual(fs.readFileSync(file), snap.bytes, '输入一个字节都不许动: ' + file);
      assert.equal(fs.statSync(file).mtimeMs, snap.mtimeMs, '输入 mtime 不许动: ' + file);
    }
  });

  check('feed: the cursor appends, skips unchanged sources, and refuses rollback / rotation / path change', () => {
    const spec1 = () => ({
      files: [feedFileRow(FEED_LOG, FEED_SID, 100, 'k1:100')],
      words: [feedWord({ seq: 0, text: 'feed query alpha' }), feedWord({ seq: 1, text: 'feed answer beta', kind: '结论', role: 'assistant' })],
      summaries: []
    });
    const f1 = writeFeed('cursor', spec1());
    const b1 = buildFromEchoIndexFiles(feedGenOptions(f1, 1));
    assert.deepEqual(b1.sources.map((s) => s.mode), ['full']);
    assert.equal(b1.manifest.counts.words, 2);

    const f2 = writeFeed('cursor', {
      files: [feedFileRow(FEED_LOG, FEED_SID, 200, 'k2:200')],
      words: [...spec1().words, feedWord({ seq: 2, text: 'feed query gamma' })],
      summaries: []
    });
    const b2 = buildFromEchoIndexFiles({ ...feedGenOptions(f2, 2), cursor: b1.cursor });
    assert.deepEqual(b2.sources.map((s) => s.mode), ['append'], 'nextByte 前进 = append');
    assert.equal(b2.manifest.counts.appended, 1);
    assert.equal(b2.manifest.counts.words, 3);

    const b3 = buildFromEchoIndexFiles({ ...feedGenOptions(f2, 3), cursor: b2.cursor });
    assert.deepEqual(b3.sources.map((s) => s.mode), ['unchanged'], 'key 与 nextByte 都没变 = unchanged');
    assert.equal(b3.manifest.counts.skippedUnchanged, 1);
    assert.deepEqual(fs.readFileSync(b3.wordsPath), fs.readFileSync(b2.wordsPath), '幂等：同一份输入 → 逐字节一样的行');

    // 回退：**自己的夹具目录**，但 files.jsonl 里必须**显式**声明上一代消费过的同一个源路径。
    //   游标是按 path 身份查的：路径一换就先撞「no longer declared（路径变了）」，回退分支根本走不到 ——
    //   那会变成「测试通过了，但测的是另一支」。下面那条断言就是钉住夹具别悄悄失去映射。
    const priorPaths = Object.keys(b3.cursor.files);
    const rollback = writeFeed('cursor-rollback', { files: [feedFileRow(FEED_LOG, FEED_SID, 150, 'k3:150')], words: spec1().words, summaries: [] });
    assert.deepEqual(readFeedRows(rollback.filesPath).map((r) => r.file.replace(/\\/g, '/')), priorPaths, '回退夹具必须显式声明上一代的同一源路径（否则测的是「路径变了」而不是「offset 回退」）');
    assert.throws(() => buildFromEchoIndexFiles({ ...feedGenOptions(rollback, 4), cursor: b3.cursor }), /rolled back/);
    // 轮转：同一个消费点、不同文件身份（同样显式声明同一路径）
    const rotated = writeFeed('cursor-rotated', { files: [feedFileRow(FEED_LOG, FEED_SID, 200, 'k4:200')], words: spec1().words, summaries: [] });
    assert.throws(() => buildFromEchoIndexFiles({ ...feedGenOptions(rotated, 4), cursor: b3.cursor }), /rotated/);
    // 声明没变、行却动了
    const movedRows = writeFeed('cursor-rows', {
      files: [feedFileRow(FEED_LOG, FEED_SID, 200, 'k2:200')],
      words: [...spec1().words, feedWord({ seq: 2, text: 'feed query gamma' }), feedWord({ seq: 3, text: 'unannounced row' })],
      summaries: []
    });
    assert.throws(() => buildFromEchoIndexFiles({ ...feedGenOptions(movedRows, 4), cursor: b3.cursor }), /derived rows moved/);
    // 路径变了：上一代消费过的源不再被声明（显式只声明另一条路径）
    const removed = writeFeed('cursor-removed', {
      files: [feedFileRow(FEED_LOG_B, FEED_SID_B, 50, 'kb:50')],
      words: [feedWord({ seq: 0, text: 'other session query', session: FEED_SID_B, log: FEED_LOG_B })],
      summaries: []
    });
    assert.equal(readFeedRows(removed.filesPath).some((r) => priorPaths.includes(r.file.replace(/\\/g, '/'))), false, '移除夹具必须不再声明上一代的源路径（否则「路径变了」这一支测不到）');
    assert.throws(() => buildFromEchoIndexFiles({ ...feedGenOptions(removed, 4), cursor: b3.cursor }), /no longer declared/);
    // 代际必须一次一步
    const step = writeFeed('cursor-step', { files: [feedFileRow(FEED_LOG, FEED_SID, 200, 'k2:200')], words: spec1().words, summaries: [] });
    assert.throws(() => buildFromEchoIndexFiles({ ...feedGenOptions(step, 9), cursor: b3.cursor }), /advance one step/);
    // 显式 fullRebuild 才允许越过连续性检查
    const rebuilt = buildFromEchoIndexFiles({ ...feedGenOptions(f2, 4), cursor: b3.cursor, fullRebuild: true });
    assert.deepEqual(rebuilt.sources.map((s) => s.mode), ['full-rebuild']);
    assert.equal(rebuilt.manifest.sourceInput.fullRebuild, true);
  });

  check('feed: inspectEchoIndexFeed reports metadata read-only and writes nothing', () => {
    const fixture = writeFeed('inspect', { ...FEED_RAW(), finalLf: false });
    const dirBefore = fs.readdirSync(fixture.dir).sort();
    const bytesBefore = [fixture.filesPath, fixture.wordsPath, fixture.summariesPath].map((f) => sha(fs.readFileSync(f)));
    const report = inspectEchoIndexFeed({ filesPath: fixture.filesPath, wordsPath: fixture.wordsPath, summariesPath: fixture.summariesPath });
    assert.equal(report.ok, true);
    assert.equal(report.readOnly, true);
    assert.equal(report.files.rows, 1);
    assert.equal(report.words.rows, 2);
    assert.equal(report.words.emitted, 2);
    assert.equal(report.summaries.rows, 1);
    assert.equal(report.summaries.srcSeqRefs, 3);
    assert.equal(report.summaries.srcSeqDangling, 0);
    assert.equal(report.wouldBuild.allowed, true);
    assert.deepEqual(report.wouldBuild.refusals, []);
    assert.deepEqual(fs.readdirSync(fixture.dir).sort(), dirBefore, '不许新建任何东西');
    assert.deepEqual([fixture.filesPath, fixture.wordsPath, fixture.summariesPath].map((f) => sha(fs.readFileSync(f))), bytesBefore);
    // 有洞 / 有冲突时不抛，只报告
    const broken = writeFeed('inspect-broken', {
      files: [feedFileRow(FEED_LOG, FEED_SID, 20)],
      words: [feedWord({ seq: 0, text: 'feed query alpha' })],
      summaries: [
        feedSummary({ id: 'cmp-feed-dangle', srcSeqs: [0, 9], summary: 'hole' }),
        feedSummary({ id: 'cmp-feed-dangle', t: '2026-11-15T09:06:00', srcSeqs: [0], summary: 'same id, other content' })
      ]
    });
    const brokenReport = inspectEchoIndexFeed({ filesPath: broken.filesPath, wordsPath: broken.wordsPath, summariesPath: broken.summariesPath });
    assert.equal(brokenReport.wouldBuild.allowed, false);
    const codes = brokenReport.wouldBuild.refusals.map((r) => r.code);
    assert.equal(codes.includes('SUMMARY_ID_CONFLICT'), true);
    assert.equal(codes.includes('SRC_SEQ_DANGLING'), true);
    assert.equal(fs.existsSync(path.join(broken.dir, 'out')), false, '只读体检不建任何目录');
  });

  check('feed: the contract constants are the importer constants (no second copy)', () => {
    assert.deepEqual([...ECHO_INDEX_WORD_FIELDS], [...ECHO_WORD_FIELDS].filter((f) => f !== 'role'));
    assert.deepEqual([...ECHO_INDEX_WORD_FIELDS_WITH_ROLE], [...ECHO_WORD_FIELDS]);
    assert.deepEqual([...ECHO_INDEX_FEED_SUMMARY_FIELDS], [...ECHO_SUMMARY_FIELDS, 'manifest']);
    assert.deepEqual({ ...ECHO_INDEX_KIND_ROLE }, { human: 'user', '结论': 'assistant' });
    assert.equal(ECHO_INDEX_FILE_FIELDS.length, 9);
  });

} catch (e) {
  failed += 1;
  console.error('✗ fatal: ' + (e && e.stack || e));
} finally {
  for (const store of [...ownedStores]) {
    try { closeStore(store); } catch (e) { failed += 1; console.error('✗ close store: ' + e.message); }
  }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); 
} catch (e) { failed += 1; console.error('✗ cleanup: ' + e.message); }
}
console.log('\n' + passed + ' 通过 / ' + failed + ' 失败');
process.exitCode = failed ? 1 : 0;
