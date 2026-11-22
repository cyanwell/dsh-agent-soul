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
check('route is GET-only, requests a snapshot, reports store failures, and closes it', () => {
  assert(serverSource.includes("p === '/api/echo/authority-view' && req.method === 'GET'"));
  assert(serverSource.includes('snapshot.close()'));
  assert(serverSource.includes('ECHO_STORE_UNAVAILABLE'));
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
    const insertWord = store.db.prepare('INSERT INTO echo_words (echo_source_id,word_ord,src_line,t,session,ws,seq,turn,log,role,kind,len,truncated,text,content_hash,content_class) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const insertFts = store.db.prepare('INSERT INTO echo_words_fts (search_text,raw_text,echo_source_id,word_ord,session,seq) VALUES (?,?,?,?,?,?)');
    const insertSummary = store.db.prepare('INSERT INTO echo_summaries (echo_source_id,cmp_id,ord,src_line,t,session,ws,log,shadowed_tokens,shadowed_chars,provider,model,status,summary,full_json,src_seq_count,content_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    insertSource.run('fixture-with-rows', '/private/source-2.jsonl', 'fixture/1', 'v4log', 4, 'committed', 13, 'SECRET_CURSOR_JSON_2', 1, 1, 1, 'b'.repeat(64), 0, 'built', 'imported', 'secret-importer');
    insertWord.run('fixture-with-rows',0,1,'2026-11-19T00:00:00Z','session-tilde~x',null,1,null,null,'user','chat',6,0,'unique needle','c'.repeat(64),'dialogue');
    insertFts.run('unique needle','unique needle','fixture-with-rows',0,'session-tilde~x',1);
    insertSummary.run('fixture-with-rows','cmp-1',0,1,'2026-11-19T00:00:00Z','session-tilde~x',null,null,1,6,null,null,'active','summary','{}',1,'d'.repeat(64));
    store.db.prepare('INSERT INTO echo_summaries_fts (search_text,raw_text,echo_source_id,cmp_id) VALUES (?,?,?,?)').run('summary','summary','fixture-with-rows','cmp-1');
    store.db.prepare('INSERT INTO echo_summary_src_seqs (echo_source_id,cmp_id,ord,seq) VALUES (?,?,?,?)').run('fixture-with-rows','cmp-1',0,1);
    const bounded = store.echoSourceStatus();
    const withRows = bounded.rows.find(x => x.sourceId === 'fixture-with-rows');
    assert.deepEqual(withRows.counts, { words:1,wordsFts:1,summaries:1,summariesFts:1,srcSeqs:1,declaredSrcSeqs:1 });
    assert.equal(withRows.aligned,true);
    const cacheReader = openMetaStore({ path: dbPath, mode: 'readonly' });
    try {
      assert.equal(cacheReader.echoSearch('unique needle', { surface:'words', echoSourceId:'fixture-with-rows' }).surfaces.words.results.length,1);
      const writer = openMetaStore({ path: dbPath, mode: 'readwrite' });
      try {
        writer.db.prepare('DELETE FROM echo_words_fts WHERE echo_source_id=?').run('fixture-with-rows');
        assert.throws(() => cacheReader.echoSearch('unique needle', { surface:'words', echoSourceId:'fixture-with-rows' }), e => e.code === 'ECHO_INDEX_STALE');
        insertFts.run('unique needle','unique needle','fixture-with-rows',0,'session-tilde~x',1);
        assert.equal(cacheReader.echoSearch('unique needle', { surface:'words', echoSourceId:'fixture-with-rows' }).surfaces.words.results.length,1);
      } finally { writer.close(); }
      assertions += 1;
      console.log('PASS readonly proof cache invalidates on external commits');
    } finally { cacheReader.close(); }
    insertSource.run('fixture-damaged-hit', '/private/source-3.jsonl', 'fixture/1', 'log', 5, 'committed', 20, 'SECRET_CURSOR_JSON_3', 1, 0, 0, 'e'.repeat(64), 0, 'built', 'imported', 'secret-importer');
    insertWord.run('fixture-damaged-hit',0,1,'2026-11-19T00:00:00Z','session-damaged~x',null,20,null,null,'user','chat',11,0,'unique needle','f'.repeat(64),'dialogue');
    insertFts.run('unique needle','unique needle','fixture-damaged-hit',0,'session-damaged~x',20);
    insertFts.run('extra orphan','extra orphan','fixture-damaged-hit',1,'session-damaged~x',21);
    assert.throws(() => store.echoSearch('unique needle', { surface:'words' }), e => e.code === 'ECHO_INDEX_STALE');
    const openDespiteFtsDrift = store.echoOpen('log:session-damaged~x#seq=20', { echoSourceId:'fixture-damaged-hit' });
    assert.equal(openDespiteFtsDrift.kind,'word');
    assert.equal(openDespiteFtsDrift.word.text,'unique needle');
    assert.equal(openDespiteFtsDrift.source.echoSourceId,'fixture-damaged-hit');
    assertions += 1;
    console.log('PASS global search fails closed; pointer open still reads present base row');
    const withoutRows = bounded.rows.find(x => x.sourceId === 'fixture-id');
    assert.equal(withoutRows.aligned,true);
    assert.equal(bounded.aligned,true);
    assert.equal(bounded.rows.length,2);
    const damagedStatus = store.echoSourceStatus();
    assert.equal(damagedStatus.rows.find(x => x.sourceId === 'fixture-damaged-hit').aligned,false);
    assert.equal(damagedStatus.rows.find(x => x.sourceId === 'fixture-id').aligned,true);
    assert.equal(damagedStatus.rows.find(x => x.sourceId === 'fixture-with-rows').aligned,true);
    assert.equal(damagedStatus.aligned,false);
    store.db.exec('BEGIN IMMEDIATE');
    try {
      const nestedSnapshot = store.echoSourceStatus();
      assert.equal(nestedSnapshot.aligned,false);
      assert.equal(nestedSnapshot.rows.find(x => x.sourceId === 'fixture-damaged-hit').aligned,false);
      assert.equal(nestedSnapshot.rows.length,3);
    } finally { store.db.exec('ROLLBACK'); }
    assertions += 1;
    console.log('PASS status SAVEPOINT nests safely inside an importer transaction');
    assertions += 1;
    console.log('PASS grouped FTS counts preserve per-source counts and alignment');
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
