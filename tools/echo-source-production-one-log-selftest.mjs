#!/usr/bin/env node
// Bounded read-only production ECHO JSONL -> TEMP importer proof. Never reads session logs/shards/02-墨.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildFromEchoIndexFiles } from './echo-source-build.mjs';
import { openMetaStore, migrate } from '../src/db/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const INDEX = 'D:/AI/memory/hub/index';
const CURRENT_SESSION = 'session-8332345a-52d3-4a7d-afc5-5f4342a2ef0c';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const fail = (m) => { throw new Error(m); };
function canonicalLog(value) { return path.resolve(value).replace(/\\/g, '/').toLowerCase(); }
function selectedSourcePath(value) { return 'D:/synthetic/echo-one-log/' + sha(Buffer.from(canonicalLog(value), 'utf8')); }

function snapshot(file) { const st = fs.statSync(file); return { bytes: st.size, mtimeMs: st.mtimeMs, sha256: sha(fs.readFileSync(file)) }; }
function jsonl(file) { const text = fs.readFileSync(file, 'utf8'); const body = text.endsWith('\n') ? text.slice(0, -1) : text; return body.split('\n').filter(Boolean).map((line) => JSON.parse(line)); }
const filesPath = path.join(INDEX, 'files.jsonl');
const wordsPath = path.join(INDEX, 'words.jsonl');
const summariesPath = path.join(INDEX, 'summaries.jsonl');
const inputPaths = [filesPath, wordsPath, summariesPath];
const inputs = { filesPath, wordsPath, summariesPath };
const before = Object.fromEntries(inputPaths.map((f) => [f, snapshot(f)]));
const files = jsonl(filesPath);
const words = jsonl(wordsPath);
const summaries = jsonl(summariesPath);
const candidates = files.map((row, index) => {
  const logKey = canonicalLog(row.file);
  const eligibleWords = words.filter((w) => canonicalLog(w.log) === logKey && w.session === row.sid && (w.kind === 'human' || w.kind === '结论') && !w.truncated && String(w.text || '').trim()).length;
  const declaredSummaries = summaries.filter((x) => canonicalLog(x.log) === logKey && x.session === row.sid).length;
  return { row, index, eligibleWords, declaredSummaries };
}).filter((x) => x.row.sid !== CURRENT_SESSION && x.eligibleWords > 0 && x.declaredSummaries > 0)
  .sort((a, b) => a.row.nextByte - b.row.nextByte || a.index - b.index);
if (!candidates.length) fail('no non-current source has both eligible human/assistant words and same-log summary rows');
const candidate = candidates[0];
const chosen = candidate.row;
const selectedLogPath = chosen.file;
console.log('SOURCE_SELECTED ' + JSON.stringify({ sid: chosen.sid, nWord: candidate.eligibleWords, nSum: candidate.declaredSummaries }));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-source-production-one-log-'));
const outDir = path.join(root, 'feed');
let store = null;
try {
  // Negative control: external source is refused unless the explicit opt-in is passed.
  assert.throws(() => buildFromEchoIndexFiles({ filesPath, wordsPath, summariesPath, selectedLogPath,
    namespace: 'log', generation: 1, builtAt: new Date().toISOString(), outDir: path.join(root, 'negative') }), /must live under the OS temporary directory/);
  assert.equal(fs.existsSync(path.join(root, 'negative')), false);
  let refusal = '';
  let built = null;
  try {
    built = buildFromEchoIndexFiles({ filesPath, wordsPath, summariesPath, selectedLogPath, allowReadOnlyExternalInputs: true,
      sourcePath: 'D:/synthetic/echo-one-log/' + sha(Buffer.from(canonicalLog(selectedLogPath), 'utf8')), namespace: 'log', generation: 1, builtAt: new Date().toISOString(), outDir });
  } catch (error) { refusal = String(error && error.message || error); }
  if (refusal) {
    assert.ok(['SUMMARY_ID_CONFLICT', 'SRC_SEQ_DANGLING', 'no user/assistant rows', 'empty generation'].some((x) => refusal.toLowerCase().includes(x.toLowerCase())), 'selected source refusal must identify the importer blocker');
    assert.equal(fs.existsSync(outDir), false, 'refused selected source must create no feed output');
    console.log('REFUSED_SELECTED sid=' + chosen.sid + ' reason=' + refusal.slice(0, 1200));
  } else {
    assert.ok(built);
    assert.equal(built.manifest.sourcePath, selectedSourcePath(selectedLogPath));
    assert.equal(built.manifest.sourceInput.selectedLog.originalLogPath, selectedLogPath);
    assert.equal(built.manifest.counts.words, built.manifest.words.rows);
    assert.equal(built.manifest.counts.summaries, built.manifest.summaries.rows);
    assert.equal(built.manifest.counts.srcSeqs, built.manifest.summaryRefs.refs);
    for (const output of [built.wordsPath, built.summariesPath, built.manifestPath]) assert.ok(path.resolve(output).toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase()));
    const dbPath = path.join(root, 'imported.sqlite');
    const initStore = openMetaStore({ path: dbPath, mode: 'readwrite' });
    try { initStore.migrate(); } finally { initStore.close(); }
    const receipt = spawnSync(NODE, [path.join(HERE, 'echo-index-import.mjs'), '--manifest', built.manifestPath, '--sha256', sha(fs.readFileSync(built.manifestPath)), '--generation', '1', '--db', dbPath, '--json'], { encoding: 'utf8' });
    if (receipt.status !== 0) {
      let refusal = null;
      try { refusal = JSON.parse(receipt.stdout); } catch {}
      fail('TEMP public importer refused selected source: exit=' + receipt.status + ' code=' + (refusal?.code || 'UNKNOWN') + ' message=' + String(refusal?.message || receipt.stderr || '').slice(0, 500));
    }
    assert.equal(JSON.parse(receipt.stdout).code, 'IMPORTED');
    store = openMetaStore({ path: path.join(root, 'imported.sqlite'), mode: 'readonly' });
    assert.equal(store.echoStats().aligned, true);
    const source = store.db.prepare('SELECT echo_source_id, source_version, namespace FROM echo_index_sources WHERE source_path=?').get(built.manifest.sourcePath);
    assert.ok(source);
    assert.equal(source.namespace, built.manifest.namespace);
    assert.ok(source.source_version);
    const word = JSON.parse(fs.readFileSync(built.wordsPath, 'utf8').trimEnd().split('\n')[0]);
    const opened = store.echoOpen('log:' + word.session + '#seq=' + word.seq, { echoSourceId: source.echo_source_id });
    assert.equal(opened.word.log, word.log);
    console.log('IMPORTED_SELECTED sid=' + chosen.sid + ' counts=' + JSON.stringify(built.manifest.counts));
  }
} finally {
  if (store) store.close();
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(fs.existsSync(root), false, 'TEMP root must be removed');
  const after = Object.fromEntries(inputPaths.map((f) => [f, snapshot(f)]));
  assert.deepEqual(after, before, 'authorized production JSONLs must remain byte/stat unchanged');
  console.log('PASS authorized input hashes/sizes/mtimes unchanged; TEMP cleanup complete');
}
