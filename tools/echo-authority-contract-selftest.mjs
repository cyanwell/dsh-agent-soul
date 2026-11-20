#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { openMetaStore } from '../src/db/index.mjs';
import { runImport } from './echo-index-import.mjs';
import { searchEcho, echoStatsFor } from '../src/db/echo.mjs';
import { registerEchoVectorModel, putEchoSourceVectors, searchEchoSourceVectors } from '../src/db/echo-vectors.mjs';
import { clearVectorCacheAll } from '../src/db/echo-vector-cache.mjs';
import { searchWindowVectors } from '../src/db/echo-window-search.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'echo-index-import', 'corpus');
const TEMP = fs.realpathSync(os.tmpdir());
const LOCK = path.join(TEMP, 'echo-authority-contract-' + process.pid + '-' + Date.now() + '.lock');
const LOCK_FD = fs.openSync(LOCK, 'wx');
const ROOT = fs.mkdtempSync(path.join(TEMP, 'echo-authority-contract-'));
const DB = path.join(ROOT, 'meta.sqlite');
const SOURCE = path.join(ROOT, 'source');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const tests = [];
let passed = 0;
let failed = 0;
let store = null;
let assertionCount = 0;

function tempTarget(target, label) {
  const absolute = path.resolve(target);
  let probe = absolute;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) throw new Error(label + ' has no existing ancestor: ' + absolute);
    probe = parent;
  }
  const real = fs.realpathSync(probe);
  assert(real === TEMP || real.startsWith(TEMP + path.sep), label + ' escaped os.tmpdir: ' + absolute);
  return absolute;
}
function writeTemp(target, data, label) {
  tempTarget(target, label);
  fs.writeFileSync(target, data);
}
function pass(name, evidence) {
  assertionCount += 1;
  passed += 1;
  tests.push({ name, status: 'PASS', evidence });
}
function fail(name, error, evidence) {
  assertionCount += 1;
  failed += 1;
  tests.push({ name, status: 'FAIL', error: String(error && error.stack ? error.stack : error), evidence });
}
function check(name, fn) {
  try {
    const evidence = fn();
    pass(name, evidence);
    return evidence;
  } catch (error) {
    fail(name, error);
    return undefined;
  }
}
function expectedContract(name, fn) {
  try {
    const evidence = fn();
    pass(name, evidence);
    return evidence;
  } catch (error) {
    fail(name, error);
    return undefined;
  }
}
function capture(fn) {
  try { return { ok: true, value: fn() }; }
  catch (error) { return { ok: false, error: { code: error?.code, message: String(error?.message || error) } }; }
}
function manifest() {
  return JSON.parse(fs.readFileSync(path.join(SOURCE, 'manifest.json'), 'utf8'));
}
function importGeneration(generation) {
  const m = manifest();
  m.generation = generation;
  m.builtAt = '2026-11-18T23:00:0' + generation + '.000Z';
  const wordsPath = path.join(SOURCE, 'words.jsonl');
  const summariesPath = path.join(SOURCE, 'summaries.jsonl');
  let words = fs.readFileSync(wordsPath, 'utf8');
  let summaries = fs.readFileSync(summariesPath, 'utf8');
  if (generation === 2) {
    words = words.replace('解耦机制记在六层解码之后', '解耦机制记在六层验证之后');
    summaries = summaries.replace('压缩摘要：解耦机制的六层结构', '代二摘要：解耦机制的六层结构');
  }
  writeTemp(wordsPath, words, 'words fixture');
  writeTemp(summariesPath, summaries, 'summaries fixture');
  m.words.sha256 = sha256(Buffer.from(words));
  m.words.bytes = Buffer.byteLength(words);
  m.words.rows = words.trimEnd().split('\n').length;
  m.summaries.sha256 = sha256(Buffer.from(summaries));
  m.summaries.bytes = Buffer.byteLength(summaries);
  m.summaries.rows = summaries.trimEnd().split('\n').length;
  const manifestPath = path.join(SOURCE, 'manifest.json');
  writeTemp(manifestPath, JSON.stringify(m, null, 2) + '\n', 'manifest');
  const receipt = runImport(['--manifest', manifestPath, '--sha256', sha256(fs.readFileSync(manifestPath)), '--generation', String(generation), '--db', DB, '--json', '--now', '2026-11-18T23:00:00.000Z']);
  for (const item of [DB, receipt?.manifest?.path, receipt?.inputs?.words?.path, receipt?.inputs?.summaries?.path]) {
    if (item) tempTarget(item, 'import output');
  }
  return receipt;
}
function sourceRow(db, sourceId) {
  return db.prepare('SELECT echo_source_id,generation,state FROM echo_index_sources WHERE echo_source_id=?').get(sourceId);
}
function insertEmptyCommittedSource(db, sourceId, generation) {
  db.prepare('INSERT INTO echo_index_sources (echo_source_id,source_path,source_version,namespace,generation,state,cursor_seq,cursor_json,words_count,summaries_count,src_seq_count,source_sha256,source_bytes,built_at,imported_at,importer) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    sourceId, 'D:/synthetic/echo/mismatch-' + generation, 'echo-index/1', 'log', generation, 'committed', 0, '{}', 0, 0, 0, 'd'.repeat(64), 0, '2026-11-18T23:00:00.000Z', '2026-11-18T23:00:00.000Z', 'selftest',
  );
}
function lexical(db, surface, sourceId) {
  return searchEcho(db, { terms: ['解耦'], surface, limit: 100, sources: [sourceId] });
}
function surfaceState(result, surface) {
  const face = surface === 'both' ? result[surface] : result[surface];
  return face?.index?.sources?.[0] || null;
}
function digestResponse(result) {
  if (!result || typeof result !== 'object') return result;
  return {
    keys: Object.keys(result).sort(),
    code: result.code,
    generation: result.generation,
    state: result.state,
    authority: result.authority,
    stale: result.stale,
    sharedGeneration: result.sharedGeneration,
    inconsistent: result.inconsistent,
    resultCount: Array.isArray(result.results) ? result.results.length : undefined,
    faceKeys: { words: result.words && Object.keys(result.words).sort(), summaries: result.summaries && Object.keys(result.summaries).sort() },
  };
}

try {
  check('all planned writes are guarded by os.tmpdir', () => {
    for (const target of [ROOT, DB, SOURCE, path.join(ROOT, 'source', 'manifest.json')]) tempTarget(target, 'planned write');
    assert.throws(() => tempTarget('D:/AI/agent-soul/data/meta.sqlite', 'outside write'));
    return { temp: TEMP, root: ROOT, db: DB };
  });
  tempTarget(SOURCE, 'fixture destination');
  fs.cpSync(FIXTURE, SOURCE, { recursive: true });

  tempTarget(DB, 'database');
  store = openMetaStore({ path: DB, mode: 'readwrite' });
  store.migrate();
  store.close();
  store = null;

  const receipt1 = importGeneration(1);
  const sid = receipt1.source.echoSourceId;
  check('synthetic import commits generation 1', () => {
    assert.equal(receipt1.code, 'IMPORTED');
    assert.equal(receipt1.generation, 1);
    return { code: receipt1.code, generation: receipt1.generation, sourceId: sid };
  });

  store = openMetaStore({ path: DB, mode: 'readwrite' });
  store.ensureReady();
  const db = store.db;

  const noOpReceipt = importGeneration(1);
  check('ALREADY_CURRENT reports existing authority without a new commit', () => {
    assert.equal(noOpReceipt.code, 'ALREADY_CURRENT');
    assert.equal(noOpReceipt.wrote, false);
    assert.match(noOpReceipt.attemptId, /^echo-attempt-/);
    assert.notEqual(noOpReceipt.attemptId, receipt1.attemptId);
    assert.equal(noOpReceipt.commitId, null);
    assert.equal(noOpReceipt.commit, null);
    assert.deepEqual(noOpReceipt.authority, { sourceId: sid, generation: 1, state: 'committed' });
    return { attemptId: noOpReceipt.attemptId, authority: noOpReceipt.authority };
  });

  check('importer attempt/commit receipt matches committed authority', () => {
    const row = sourceRow(db, sid);
    assert.equal(row.state, 'committed');
    assert.equal(Number(row.generation), Number(receipt1.generation));
    assert.match(receipt1.attemptId, /^echo-attempt-/);
    assert.equal(receipt1.attempt.id, receipt1.attemptId);
    assert.equal(receipt1.attempt.generation, 1);
    assert.equal(receipt1.attempt.sourceId, sid);
    assert.match(receipt1.commitId, /^echo-commit-/);
    assert.equal(receipt1.commit.id, receipt1.commitId);
    assert.equal(receipt1.commit.generation, 1);
    assert.equal(receipt1.commit.sourceId, sid);
    assert.equal(receipt1.commit.state, 'committed');
    assert.deepEqual(receipt1.authority, { sourceId: sid, generation: 1, state: 'committed' });
    assert.notEqual(receipt1.attemptId, receipt1.commitId);
    return { attempt: receipt1.attempt, commit: receipt1.commit, authority: receipt1.authority };
  });

  const rollbackFixture = path.join(ROOT, 'rollback');
  tempTarget(rollbackFixture, 'rollback fixture');
  fs.cpSync(FIXTURE, rollbackFixture, { recursive: true });
  const rollbackManifest = JSON.parse(fs.readFileSync(path.join(rollbackFixture, 'manifest.json'), 'utf8'));
  rollbackManifest.generation = 2;
  rollbackManifest.builtAt = '2026-11-18T23:00:02.000Z';
  const rollbackManifestPath = path.join(rollbackFixture, 'manifest.json');
  writeTemp(rollbackManifestPath, JSON.stringify(rollbackManifest, null, 2) + '\n', 'rollback manifest');
  db.exec("CREATE TRIGGER selftest_abort_echo_import BEFORE INSERT ON echo_words BEGIN SELECT RAISE(ABORT, 'SELFTEST_ROLLBACK'); END");
  let rollbackError = null;
  try {
    runImport(['--manifest', rollbackManifestPath, '--sha256', sha256(fs.readFileSync(rollbackManifestPath)), '--generation', '2', '--db', DB, '--json']);
  } catch (error) { rollbackError = error; }
  db.exec('DROP TRIGGER selftest_abort_echo_import');
  check('rollback failure has a unique attempt and no commit authority', () => {
    assert.equal(rollbackError?.code, 'IMPORT_WRITE_FAILED');
    assert.match(rollbackError?.attemptId || '', /^echo-attempt-/);
    assert.equal(rollbackError?.commitId, undefined);
    assert.equal(rollbackError?.authority, undefined);
    const rollbackReceipt = { ok: false, attemptId: rollbackError?.attemptId || null, commitId: null, commit: null, authority: null };
    assert.equal(rollbackReceipt.ok, false);
    assert.equal(rollbackReceipt.commitId, null);
    assert.equal(rollbackReceipt.commit, null);
    assert.equal(rollbackReceipt.authority, null);
    const row = sourceRow(db, sid);
    assert.equal(Number(row.generation), 1);
    assert.equal(row.state, 'committed');
    return { code: rollbackError.code, attemptId: rollbackError.attemptId, commitId: null, row };
  });

  for (const state of ['committed', 'pending', 'failed']) {
    db.prepare('UPDATE echo_index_sources SET state=? WHERE echo_source_id=?').run(state, sid);
    const words = capture(() => lexical(db, 'words', sid));
    const summaries = capture(() => lexical(db, 'summaries', sid));
    expectedContract('only committed source is accepted by words: ' + state, () => {
      if (state === 'committed') {
        assert.equal(words.ok, true, JSON.stringify(words));
        assert.equal(words.value.words.results.length > 0, true, JSON.stringify(digestResponse(words.value)));
      } else {
        assert.equal(words.ok, false, JSON.stringify({ observedState: state, response: digestResponse(words.value) }));
      }
      return { state, response: words.ok ? digestResponse(words.value) : words.error };
    });
    expectedContract('only committed source is accepted by summaries: ' + state, () => {
      if (state === 'committed') {
        assert.equal(summaries.ok, true, JSON.stringify(summaries));
        assert.equal(summaries.value.summaries.results.length > 0, true, JSON.stringify(digestResponse(summaries.value)));
      } else {
        assert.equal(summaries.ok, false, JSON.stringify({ observedState: state, response: digestResponse(summaries.value) }));
      }
      return { state, response: summaries.ok ? digestResponse(summaries.value) : summaries.error };
    });
  }
  db.prepare("UPDATE echo_index_sources SET state='committed' WHERE echo_source_id=?").run(sid);

  const both = lexical(db, 'both', sid);
  expectedContract('every lexical face receipt carries direct committed authority', () => {
    for (const face of [both.words, both.summaries]) {
      assert.equal(typeof face.authority?.sourceId, 'string');
      assert.equal(typeof face.authority?.generation, 'number');
      assert.equal(face.authority?.state, 'committed');
      assert.equal(typeof face.authority?.snapshotId, 'string');
      assert.equal(face.authorities?.length, 1);
      assert.deepEqual(face.authorities[0], face.authority);
    }

    return { words: both.words.authority, summaries: both.summaries.authority };
  });
  expectedContract('surface=both carries sharedGeneration or explicit inconsistent', () => {
    assert.equal(typeof both.sharedGeneration, 'number');
    assert.equal(both.words.authority.snapshotId, both.summaries.authority.snapshotId);
    return digestResponse(both);
  });

  const mismatchSid = 'echo-authority-mismatch';
  insertEmptyCommittedSource(db, mismatchSid, 2);
  const mismatch = searchEcho(db, { terms: ['解耦'], surface: 'both', limit: 100, sources: [sid, mismatchSid] });
  expectedContract('surface=both rejects mixed generations without delivering mixed hits', () => {
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.inconsistent, true);
    assert.equal(mismatch.reason, 'generation-mismatch');
    assert.equal(mismatch.words.results.length, 0);
    assert.equal(mismatch.summaries.results.length, 0);
    assert.deepEqual(mismatch.words.authorities.map((a) => a.generation).sort(), [1, 2]);
    return digestResponse(mismatch);
  });
  db.prepare('DELETE FROM echo_index_sources WHERE echo_source_id=?').run(mismatchSid);

  const vectorSpec = {
    modelId: 'synthetic-authority-contract', revision: '1', modelSha256: 'b'.repeat(64),
    tokenizerSpec: 'synthetic-tokenizer', preprocessSpec: 'synthetic-preprocess', poolingSpec: 'mean',
    normalize: true, dimension: 2, maxSeqLength: 32,
  };
  const model = registerEchoVectorModel(db, vectorSpec);
  const words = db.prepare('SELECT word_ord,content_hash FROM echo_words WHERE echo_source_id=? ORDER BY word_ord').all(sid);
  putEchoSourceVectors(db, sid, vectorSpec, words.map((row) => ({ wordOrd: Number(row.word_ord), contentHash: row.content_hash, vector: [1, 0] })));
  const firstVector = capture(() => searchEchoSourceVectors(db, [1, 0], { modelKey: model.modelKey, echoSourceId: sid, limit: 1 }));
  const firstWord = words[0];
  const blob = Buffer.from(new Float32Array([1, 0]).buffer);
  db.prepare('INSERT INTO echo_word_windows (echo_source_id,word_ord,window_ord,model_key,char_start,char_end,window_text_sha256,source_content_hash,vector_dimension,vector_blob,vector_sha256,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(sid, Number(firstWord.word_ord), 0, model.modelKey, 0, 2, 'c'.repeat(64), firstWord.content_hash, 2, blob, sha256(blob), '2026-11-18T23:00:00.000Z');
  clearVectorCacheAll();
  const firstWindow = capture(() => searchWindowVectors(db, [1, 0], { modelKey: model.modelKey, echoSourceId: sid, limit: 1 }));
  check('vector/window committed authority receipts', () => {
    assert.equal(firstVector.ok, true); assert.equal(firstVector.value.authority.state, 'committed'); assert.equal(firstVector.value.authority.generation, 1); assert.equal(typeof firstVector.value.authority.snapshotId, 'string');
    assert.equal(firstWindow.ok, true); assert.equal(firstWindow.value.authority.state, 'committed'); assert.equal(firstWindow.value.authority.generation, 1); assert.equal(typeof firstWindow.value.authority.snapshotId, 'string');
    return { vector: firstVector.value.authority, window: firstWindow.value.authority };
  });
  for (const state of ['pending', 'failed']) {
    db.prepare('UPDATE echo_index_sources SET state=? WHERE echo_source_id=?').run(state, sid);
    const vector = capture(() => searchEchoSourceVectors(db, [1, 0], { modelKey: model.modelKey, echoSourceId: sid, limit: 1 }));
    const window = capture(() => searchWindowVectors(db, [1, 0], { modelKey: model.modelKey, echoSourceId: sid, limit: 1 }));
    check('vector/window reject non-committed source: ' + state, () => { assert.equal(vector.ok, false); assert.equal(window.ok, false); return { state, vector: vector.error, window: window.error }; });
  }
  db.prepare("UPDATE echo_index_sources SET state='committed' WHERE echo_source_id=?").run(sid);
  clearVectorCacheAll();
  const warmedVector = capture(() => searchEchoSourceVectors(db, [1, 0], { modelKey: model.modelKey, echoSourceId: sid, limit: 1 }));
  const warmedWindow = capture(() => searchWindowVectors(db, [1, 0], { modelKey: model.modelKey, echoSourceId: sid, limit: 1 }));
  db.prepare('UPDATE echo_index_sources SET generation=2 WHERE echo_source_id=?').run(sid);
  const afterVector = capture(() => searchEchoSourceVectors(db, [1, 0], { modelKey: model.modelKey, echoSourceId: sid, limit: 1 }));
  const afterWindow = capture(() => searchWindowVectors(db, [1, 0], { modelKey: model.modelKey, echoSourceId: sid, limit: 1 }));
  check('generation change makes cached vector/window stale', () => { assert.equal(afterVector.ok, false); assert.equal(afterWindow.ok, false); assert.ok(['ECHO_VECTOR_STALE', 'ECHO_VECTOR_GENERATION_STALE'].includes(afterVector.error.code)); assert.ok(['ECHO_WINDOW_STALE', 'ECHO_WINDOW_GENERATION_STALE'].includes(afterWindow.error.code)); return { before: { vector: digestResponse(warmedVector.value), window: digestResponse(warmedWindow.value) }, after: { vector: afterVector.error, window: afterWindow.error } }; });
  db.prepare('UPDATE echo_index_sources SET generation=1 WHERE echo_source_id=?').run(sid);

  const stats = echoStatsFor(db);
  check('authority evidence records the final synthetic DB generation/state', () => {
    const row = sourceRow(db, sid);
    assert.equal(Number(row.generation), 1);
    assert.equal(row.state, 'committed');
    assert.equal(stats.sources.find((item) => item.echoSourceId === sid).generation, 1);
    return { row, statsSource: stats.sources.find((item) => item.echoSourceId === sid) };
  });
} catch (error) {
  failed += 1;
  tests.push({ name: 'selftest harness crash', status: 'FAIL', error: String(error?.stack || error) });
} finally {
  if (store) { try { store.close(); } catch {} }
  tempTarget(ROOT, 'cleanup root');
  try { fs.closeSync(LOCK_FD); fs.rmSync(LOCK, { force: true }); } catch (error) { failed += 1; tests.push({ name: 'TEMP lock cleanup', status: 'FAIL', error: String(error?.stack || error) }); }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (error) { failed += 1; tests.push({ name: 'TEMP cleanup', status: 'FAIL', error: String(error?.stack || error) }); }
}
const output = {
  node: process.version,
  temp: TEMP,
  root: ROOT,
  db: DB,
  passed,
  failed,
  assertionCount,
  exitCode: failed ? 1 : 0,
  tests,
  unverified: [
    '真实 provider、真实生产库、真实 fs.watch、worker 崩溃、commit 后父进程退出、事务中途故障未验证。',
    '本自测只证明当前 API 的可观测合同，不实现生产修复。',
  ],
};
console.log(JSON.stringify(output, null, 2));
process.exitCode = output.exitCode;
