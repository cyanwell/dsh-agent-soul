#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { echoAuthorityView } from '../src/adapters/echo-authority-view.mjs';
import { openMetaStore } from '../src/db/index.mjs';

const TEMP = fs.realpathSync(os.tmpdir());
function tempTarget(target) {
  const absolute = path.resolve(target);
  let probe = absolute;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    assert.notEqual(parent, probe, 'target must have an existing ancestor');
    probe = parent;
  }
  const real = fs.realpathSync(probe);
  assert(real === TEMP || real.startsWith(TEMP + path.sep), 'write escaped os.tmpdir: ' + absolute);
  return absolute;
}

let assertions = 0;
function check(name, fn) {
  fn();
  assertions += 1;
  console.log('PASS ' + name);
}

const serverSource = fs.readFileSync(new URL('../src/web/server.mjs', import.meta.url), 'utf8');
check('route is GET-only and delegates to the adapter', () => {
  assert(serverSource.includes("p === '/api/echo/authority-view' && req.method === 'GET'"));
  assert(serverSource.includes('echoAuthorityView({ store, echoLive })'));
});

const fakeLive = {
  view() {
    return {
      enabled: true, running: false,
      dbPath: 'D:/private/meta.sqlite', sourceRoot: 'D:/private/sessions', receiptFile: 'D:/private/echo-live.json',
      last: {
        at: '2026-11-19T00:00:00.000Z', code: 'IMPORTED', ok: true,
        generation: 7, attemptId: 'attempt-7', commitId: 'commit-7',
        authority: { sourceId: 'source-7', generation: 7, state: 'committed' },
        error: 'D:/private/secret path',
      },
      stats: { rounds: 9, imported: 2, unchanged: 6, failed: 1, lastCode: 'IMPORTED', lastAt: '2026-11-19T00:00:00.000Z', lastMs: 12, lastWords: 40, lastGeneration: 7, consecutiveFailures: 0 },
    };
  },
};
const view = echoAuthorityView({ echoLive: fakeLive, now: Date.parse('2026-11-19T00:01:00.000Z') });
check('sync view preserves statuses and stats without paths', () => {
  assert.equal(view.sync.configured, true);
  assert.equal(view.sync.enabled, true);
  assert.equal(view.sync.running, false);
  assert.equal(view.sync.stats.rounds, 9);
  assert.equal(view.sync.last.authority.generation, 7);
  assert.equal(Object.hasOwn(view.sync.last, 'error'), false);
  assert.equal(Object.hasOwn(view.sync, 'dbPath'), false);
  assert.equal(Object.hasOwn(view.sync, 'sourceRoot'), false);
  assert.equal(Object.hasOwn(view.sync, 'receiptFile'), false);
  const serialized = JSON.stringify(view);
  assert.equal(serialized.includes('D:/private'), false);
  assert.equal(serialized.includes('meta.sqlite'), false);
  assert.equal(serialized.includes('receiptFile'), false);
});
check('unwired authority stays unknown, query is not-queried, and missing values stay null', () => {
  assert.deepEqual(view.sources, { available: null, aligned: null, rows: null });
  assert.deepEqual(view.query, { status: 'not-queried' });
  assert.equal(view.issue, 'database-not-wired');
  assert.equal(view.freshness.generatedAt, null);
  assert.equal(view.freshness.ageMs, null);
  assert.equal(view.freshness.checkedAt, '2026-11-19T00:01:00.000Z');
});
check('missing or failed echoLive reads remain unknown', () => {
  const missing = echoAuthorityView({ now: 0 });
  assert.equal(missing.sync.configured, null);
  assert.equal(missing.sync.enabled, null);
  assert.equal(missing.sync.running, null);
  assert.equal(missing.sync.last, null);
  assert.equal(missing.sync.stats, null);
  const broken = echoAuthorityView({ echoLive: { view() { throw new Error('D:/private'); } }, now: 0 });
  assert.equal(broken.sync.enabled, null);
  assert.equal(JSON.stringify(broken).includes('D:/private'), false);
});

const tempRoot = tempTarget(path.join(TEMP, 'echo-authority-view-selftest-' + process.pid + '-' + Date.now()));
fs.mkdirSync(tempTarget(tempRoot), { recursive: true });
try {
  const dbPath = tempTarget(path.join(tempRoot, 'meta.sqlite'));
  const store = openMetaStore({ path: dbPath, mode: 'readwrite' });
  try {
    store.migrate();
    const beforeMissingTable = store.echoSourceStatus();
    assert.equal(beforeMissingTable.available, true);
    assert.deepEqual(beforeMissingTable.rows, []);
    const unavailable = echoAuthorityView({ store, now: 0 });
    assert.equal(unavailable.sources.available, true);
    store.db.exec('DROP TABLE echo_words_fts');
    assert.deepEqual(store.echoSourceStatus(), { available: null, aligned: null, rows: null });
    store.db.exec("CREATE VIRTUAL TABLE echo_words_fts USING fts5(search_text, raw_text, echo_source_id UNINDEXED, word_ord UNINDEXED, session UNINDEXED, seq UNINDEXED, tokenize='unicode61 remove_diacritics 0')");
    const insertSource = store.db.prepare('INSERT INTO echo_index_sources (echo_source_id,source_path,source_version,namespace,generation,state,cursor_seq,cursor_json,words_count,summaries_count,src_seq_count,source_sha256,source_bytes,built_at,imported_at,importer) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    insertSource.run('fixture-id', '/private/source.jsonl', 'fixture/1', 'log', 3, 'committed', 12, 'SECRET_CURSOR_JSON', 0, 0, 0, 'a'.repeat(64), 0, 'built', 'imported', 'secret-importer');
    const bounded = store.echoSourceStatus();
    assert.deepEqual(bounded.rows[0], { sourceId: 'fixture-id', namespace: 'log', sourceVersion: 'fixture/1', generation: 3, state: 'committed', cursorSeq: 12, counts: { words: 0, wordsFts: 0, summaries: 0, summariesFts: 0, srcSeqs: 0, declaredSrcSeqs: 0 }, builtAt: 'built', importedAt: 'imported', aligned: true });
    assert.equal(bounded.aligned, true);
    const redacted = echoAuthorityView({ store, now: 0 });
    assert.equal(JSON.stringify(redacted.sources).includes('D:/private'), false);
    assert.equal(JSON.stringify(redacted.sources).includes('SECRET'), false);
    assert.equal(JSON.stringify(redacted.sources).includes('sourcePath'), false);
    assert.equal(JSON.stringify(redacted.sources).includes('dbPath'), false);
    for (let i = 0; i < 64; i++) insertSource.run('id-' + String(i).padStart(3, '0'), '/fixture/' + i, 'v1', 'log', 1, 'committed', 0, '{}', 0, 0, 0, 'b'.repeat(64), 0, 'built', 'imported', 'fixture');
    const capped = store.echoSourceStatus();
    assert.equal(capped.rows.length, 64);
    assert.equal(capped.truncated, true);
    assert.equal(capped.aligned, null);
    assertions += 1;
    console.log('PASS Store status is missing-safe, bounded, and redacted');
  } finally { store.close(); }
  const marker = tempTarget(path.join(tempRoot, 'result.json'));
  fs.writeFileSync(marker, JSON.stringify({ assertions }));
  assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).assertions, assertions);
  assertions += 1;
  console.log('PASS all selftest writes remain under os.tmpdir');
} finally {
  tempTarget(tempRoot);
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
console.log('Assertions: ' + assertions + ' passed, 0 failed');
