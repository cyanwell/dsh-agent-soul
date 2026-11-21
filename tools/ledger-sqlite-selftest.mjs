#!/usr/bin/env node
// v9 ledger selftest (TEMP DB only).
//
// Contract under test:
//   * a v5 database migrates through v9; applied checksums for v1-v5 stay unchanged and
//     the v1-v8 migration digests stay stable (v9 only adds surfaces);
//   * Store.appendLedger refuses every type='lead' write with LEDGER_LEAD_AUTH_REQUIRED
//     (no Host-issued authorization binding exists yet), and SQL still enforces the
//     lead ref / generation guards on ordinary (non-imported) INSERT;
//   * v7/v8 promise gates compare the FULL actor_session UUID for ordinary writes;
//     prefix stored in "by" — a colliding prefix must fail MO_NOT_CURRENT_LEAD;
//   * v8 import provenance: 8 mo_ledger triggers, imported rows carry a batch + physical
//     line + raw line and never an actor_session, and an imported lead never becomes the
//     Store's latestLead / live authority;
//   * v9 (echo-derived-index) is additive: the ECHO tables / two FTS virtual tables / six
//     named indexes land with it, the build audit is append-only (2 triggers), and the
//     idx: pointer namespace is reserved on frame_index (2 triggers, not 1).
//
// The raw-SQL rows below are explicitly seeded fixtures inside this throwaway temp
// database. The database does NOT authenticate raw SQL authors; nothing below is evidence
// that it does. No tokens, production paths, JSONL or production data.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMetaStore, migrate, MIGRATIONS, migrationDigest, SCHEMA_VERSION } from '../src/db/index.mjs';

const LEAD_SESSION = 'session-12345678-aaaa-bbbb-cccc-dddddddddddd';
const LEAD_ACTOR = '12345678-aaaa-bbbb-cccc-dddddddddddd';
// 「另一个人」：用来验证 lead 换届只认当前主导。
const OTHER_SESSION = 'session-99999999-1111-2222-3333-444444444444';
const COLLIDING_SESSION = 'session-12345678-bbbb-cccc-dddddddddddd';
const COLLIDING_ACTOR = '12345678-bbbb-cccc-dddddddddddd';
const UNRELATED_SESSION = 'session-9f8e7d6c-1111-2222-3333-444444444444';
const NON_LEAD_TYPES = ['promise', 'fact', 'shelved', 'gain', 'loss', 'persona', 'container'];
// 普通（本机写入）行：import_batch_id 显式给 NULL —— 「传了就是 NULL」这件事由 SQL 写清楚，
// 而不是靠「没列它所以是默认值」。v8 的普通行口径全靠这一列。
const INSERT_LEDGER_SQL = 'INSERT INTO mo_ledger (t,type,text,by,actor_session,ref,feel,by_user,import_batch_id) VALUES (?,?,?,?,?,?,?,?,?)';
// 导入行：actor_session 恒 NULL（契约），必须带批次 + 物理行号 + 该行原文。
const INSERT_IMPORTED_SQL = 'INSERT INTO mo_ledger (t,type,text,by,actor_session,ref,feel,by_user,legacy_line,legacy_raw,import_batch_id) VALUES (?,?,?,?,NULL,?,?,?,?,?,?)';
// 「半个溯源行」探针：有 legacy_line 却没有批次。
const INSERT_HALF_PROVENANCE_SQL = 'INSERT INTO mo_ledger (t,type,text,by,actor_session,ref,feel,by_user,legacy_line,import_batch_id) VALUES (?,?,?,?,?,?,?,?,?,?)';
// 完整溯源行 + 一个 actor_session：专门孤立 MO_IMPORT_ACTOR_FORBIDDEN（否则先撞 _ROW_INCOMPLETE）。
const INSERT_IMPORTED_WITH_ACTOR_SQL = 'INSERT INTO mo_ledger (t,type,text,by,actor_session,ref,feel,by_user,legacy_line,legacy_raw,import_batch_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)';
const appliedChecksums = (db) => db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all();

const root = mkdtempSync(join(tmpdir(), 'agent-soul-ledger-v9-'));
const dbPath = join(root, 'meta.sqlite');
const at = () => new Date().toISOString();
let store;
try {
  // ── v1-v8 SQL is frozen while we start from a v5 database ───────────────
  const digestsV1to8 = MIGRATIONS.slice(0, 8).map(migrationDigest);
  // ★ 2026-11-17：这里原来写死 9，v10/v11 一加就红。
  //   改成跟着 SCHEMA_VERSION 走，同时**把「连续递增」这条真正的约束写成断言** ——
  //   否则改成动态值就等于什么都不查了。
  assert.equal(SCHEMA_VERSION, MIGRATIONS[MIGRATIONS.length - 1].version);
  assert.deepEqual(MIGRATIONS.map((m) => m.version), Array.from({ length: MIGRATIONS.length }, (_, i) => i + 1));
  assert.equal(MIGRATIONS[5].name, 'mo-append-only-ledger');
  assert.equal(MIGRATIONS[6].name, 'mo-promise-full-actor-session');
  assert.equal(MIGRATIONS[7].name, 'mo-import-provenance');
  assert.equal(MIGRATIONS[8].name, 'echo-derived-index');

  store = openMetaStore({ path: dbPath, mode: 'readwrite' });

  // ── v5 fixture DB, upgraded in place through v9 ─────────────────────────
  migrate(store.db, { migrations: MIGRATIONS.slice(0, 5), targetVersion: 5 });
  store.refreshState();
  assert.equal(store.state.current, 5);
  assert.equal(store.state.ready, false);
  assert.equal(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mo_ledger'").get(), undefined);
  const atV5 = appliedChecksums(store.db);
  assert.deepEqual(atV5.map((r) => r.checksum), digestsV1to8.slice(0, 5));

  store.migrate();
  store.refreshState();
  assert.equal(store.state.current, SCHEMA_VERSION);
  assert.equal(store.state.ready, true);
  const atV9 = appliedChecksums(store.db);
  assert.deepEqual(atV9.map((r) => r.version), Array.from({ length: SCHEMA_VERSION }, (_, i) => i + 1));
  assert.deepEqual(atV9.map((r) => r.checksum), MIGRATIONS.map(migrationDigest));
  // 迁移只追加：v1-v5 已入库的 checksum 逐位未变；v6-v8 落库值等于冻结前算出的摘要；
  // 重算 v1-v8 仍是同一串（不是「重算了但看着差不多」）。
  assert.deepEqual(atV9.slice(0, 5).map((r) => r.checksum), atV5.map((r) => r.checksum));
  assert.deepEqual(atV9.slice(0, 8).map((r) => r.checksum), digestsV1to8);
  assert.deepEqual(MIGRATIONS.slice(0, 8).map(migrationDigest), digestsV1to8);
  assert.equal(store.ledgerTypes().length, 8);
  assert.equal(store.latestLead(), null);
  assert.equal(store.ledgerStats().total, 0);

  // ── v8 trigger surface: the old five plus three import guards ───────────
  const triggers = store.db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name='mo_ledger' ORDER BY name").all();
  const triggerNames = triggers.map((t) => t.name);
  assert.deepEqual(triggerNames, [
    'mo_ledger_import_batch_required',
    'mo_ledger_import_no_actor',
    'mo_ledger_import_rows_complete',
    'mo_ledger_lead_generation',
    'mo_ledger_lead_requires_ref',
    'mo_ledger_no_delete',
    'mo_ledger_no_update',
    'mo_ledger_promise_gate',
  ]);
  assert.equal(new Set(triggerNames).size, 8);
  assert.equal(triggers.filter((t) => /MO_LEAD_AUTH_REQUIRED/.test(t.sql)).length, 0);

  const triggerSql = (name) => triggers.find((t) => t.name === name).sql;
  const promiseGate = triggerSql('mo_ledger_promise_gate');
  // 闸门只对**本机写入**的 promise 生效（导入行没有 actor_session，也不产生承诺）。
  assert.match(promiseGate, /WHEN NEW\.type='promise' AND NEW\.import_batch_id IS NULL/);
  // 比较对象只认**本机写入**的 lead —— 导入进来的历史 lead 永远不是「当前主导」。
  assert.match(promiseGate, /NEW\.actor_session <> \(SELECT actor_session FROM mo_ledger WHERE type='lead' AND import_batch_id IS NULL ORDER BY row_id DESC LIMIT 1\)/);
  assert.doesNotMatch(promiseGate, /FROM mo_ledger WHERE type='lead' ORDER BY row_id DESC/);
  assert.match(promiseGate, /MO_ACTOR_REQUIRED/);
  assert.match(promiseGate, /MO_PROMISE_DELEGATED/);
  // by 只有 8 字符，永远不参与比较。
  assert.doesNotMatch(promiseGate, /NEW\.by\b/);
  // lead 的 ref / 代次约束同样只约束本机写入的行（导入行是溯源，不是「现在」）。
  assert.match(triggerSql('mo_ledger_lead_requires_ref'), /WHEN NEW\.type='lead' AND NEW\.import_batch_id IS NULL/);
  assert.match(triggerSql('mo_ledger_lead_generation'), /WHEN NEW\.type='lead' AND NEW\.import_batch_id IS NULL/);
  // 三条导入护栏的判据原文（名字对上 + 条件对上，否则「有触发器」不说明它挡什么）。
  assert.match(triggerSql('mo_ledger_import_no_actor'), /NEW\.import_batch_id IS NOT NULL AND NEW\.actor_session IS NOT NULL/);
  assert.match(triggerSql('mo_ledger_import_no_actor'), /MO_IMPORT_ACTOR_FORBIDDEN/);
  assert.match(triggerSql('mo_ledger_import_rows_complete'), /NEW\.import_batch_id IS NOT NULL AND \(NEW\.legacy_line IS NULL OR NEW\.legacy_raw IS NULL\)/);
  assert.match(triggerSql('mo_ledger_import_rows_complete'), /MO_IMPORT_ROW_INCOMPLETE/);
  assert.match(triggerSql('mo_ledger_import_batch_required'), /NEW\.import_batch_id IS NULL AND NEW\.legacy_line IS NOT NULL/);
  assert.match(triggerSql('mo_ledger_import_batch_required'), /MO_IMPORT_BATCH_REQUIRED/);

  // ── v9 surface: the ECHO derived index is additive on top of v8 ─────────
  const objectsOf = (type) => store.db.prepare('SELECT name, sql FROM sqlite_master WHERE type=? ORDER BY name').all(type);
  const namesOf = (type) => objectsOf(type).map((o) => o.name);
  const tablesNow = namesOf('table');
  for (const t of ['echo_index_sources', 'echo_words', 'echo_summaries', 'echo_summary_src_seqs', 'echo_source_builds']) {
    assert.ok(tablesNow.includes(t), 'v9 table ' + t + ' (have: ' + tablesNow.join(',') + ')');
  }
  // 两张 FTS 是 fts5 虚拟表；连接靠显式列（echo_source_id + word_ord / cmp_id），不靠 rowid。
  const echoFts = objectsOf('table').filter((o) => o.name === 'echo_words_fts' || o.name === 'echo_summaries_fts');
  assert.deepEqual(echoFts.map((o) => o.name), ['echo_summaries_fts', 'echo_words_fts']);
  for (const o of echoFts) {
    assert.match(o.sql, /CREATE VIRTUAL TABLE/);
    assert.match(o.sql, /USING fts5/);
    assert.match(o.sql, /remove_diacritics 0/);
  }
  const indexesNow = namesOf('index');
  for (const i of ['idx_echo_sources_ns', 'idx_echo_words_session', 'idx_echo_words_kind', 'idx_echo_summaries_session', 'idx_echo_summaries_status', 'idx_echo_src_seqs_seq']) {
    assert.ok(indexesNow.includes(i), 'v9 index ' + i + ' (have: ' + indexesNow.join(',') + ')');
  }
  // 触发器：构建审计挂在 echo_source_builds（2 条），idx: 保留命名空间挂在 frame_index（2 条）。
  const allTriggers = store.db.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all();
  assert.equal(allTriggers.length, 21);
  const buildTriggers = allTriggers.filter((t) => t.tbl_name === 'echo_source_builds');
  assert.deepEqual(buildTriggers.map((t) => t.name), ['echo_source_builds_no_delete', 'echo_source_builds_no_update']);
  for (const t of buildTriggers) assert.match(t.sql, /ECHO_BUILD_APPEND_ONLY/);
  const frameTriggers = allTriggers.filter((t) => t.tbl_name === 'frame_index');
  assert.deepEqual(frameTriggers.map((t) => t.name), [
    'trg_frame_authority_insert',
    'trg_frame_authority_update',
    'trg_frame_index_reject_echo_ptr_insert',
    'trg_frame_index_reject_echo_ptr_update',
  ]);
  for (const name of ['trg_frame_index_reject_echo_ptr_insert', 'trg_frame_index_reject_echo_ptr_update']) {
    const sql = frameTriggers.find((t) => t.name === name).sql;
    assert.match(sql, /NEW\.ptr LIKE 'idx:%'/);
    assert.match(sql, /META_ECHO_PTR_RESERVED/);
  }

  // ── trusted identity is required on every non-lead type ─────────────────
  for (const type of NON_LEAD_TYPES) {
    assert.throws(() => store.appendLedger({ type, text: 'no signer ' + type }, {}),
      (err) => err.code === 'LEDGER_IDENTITY_REQUIRED');
    assert.throws(() => store.appendLedger({ type, text: 'bad signer ' + type }, { sessionId: 'session-12345678' }),
      (err) => err.code === 'INVALID_INPUT');
  }

  // ── every non-lead type appends; promise waits for a lead ───────────────
  const appended = {};
  for (const type of ['fact', 'shelved', 'gain', 'loss', 'persona', 'container']) {
    appended[type] = store.appendLedger({ type, text: 'fixture ' + type }, { sessionId: LEAD_SESSION });
    assert.equal(appended[type].type, type);
    assert.equal(appended[type].by, '12345678');
    assert.equal(appended[type].actorSession, LEAD_ACTOR);
    assert.equal(appended[type].byUser, false);
  }
  assert.throws(() => store.appendLedger({ type: 'promise', text: 'no lead yet' }, { sessionId: LEAD_SESSION }),
    (err) => err.code === 'LEDGER_PROMISE_DENIED' && /MO_NO_LEAD/.test(err.message));
  assert.equal(store.ledgerStats().total, 6);
  assert.equal(store.ledgerStats().latestLead, null);
  const fact = store.listLedger({ type: 'fact' })[0];
  assert.equal(fact.by, '12345678');
  assert.equal(fact.actorSession, LEAD_ACTOR);

  // ── lead 的授权绑定（2026-11-17 改）：不再无条件拒绝，而是「库内自证」 ──
  //    旧口径是「没有宿主授权绑定，一律拒绝」。墨的权威搬进 SQLite 之后那条走不通了：
  //    换届本身就是墨的核心功能，一刀切拒绝等于把它封死。
  //    新口径（三条都要成立）：
  //      ① 库里还没有 live lead → 允许第一条（否则任何新库都无法起步，是死锁）；
  //      ② 已有 live lead → 只有**它本人**能再写（换届）；
  //      ③ 导入的历史 lead（import_batch_id 非空）永远不参与判定。
  // lead 的三条新口径在文件末尾单独测（插在这里会打乱下面的行序断言）。

  // ── import_batch_id is import provenance, never a caller field ──────────
  // 让普通写入能自己填批次号 = 一行普通写入就能冒充「历史行」，闸门等于白装。
  const beforeProvenanceProbe = store.ledgerStats().total;
  for (const field of [{ import_batch_id: 1 }, { importBatchId: 1 }, { import_batch_id: null }]) {
    assert.throws(() => store.appendLedger(Object.assign({ type: 'fact', text: 'caller provenance' }, field), { sessionId: LEAD_SESSION }),
      (err) => err.code === 'INVALID_INPUT' && /import_batch_id/.test(err.message));
  }
  assert.equal(store.ledgerStats().total, beforeProvenanceProbe);

  // ── SQL lead guards, probed one at a time; then the trusted fixture row ─
  const insLedger = store.db.prepare(INSERT_LEDGER_SQL);
  assert.throws(() => insLedger.run(at(), 'lead', '第 1 代 · fixture', '12345678', LEAD_ACTOR, null, null, 0, null), /MO_LEAD_REF_REQUIRED/);
  assert.throws(() => insLedger.run(at(), 'lead', 'malformed text without generation', '12345678', LEAD_ACTOR, 'fixture:owner', null, 0, null), /MO_LEAD_GENERATION_REQUIRED/);
  insLedger.run(at(), 'lead', '第 1 代 · fixture', '12345678', LEAD_ACTOR, 'fixture:owner', null, 0, null);
  const leadRow = store.db.prepare("SELECT row_id, by, actor_session, ref, text, import_batch_id FROM mo_ledger WHERE type='lead'").get();
  assert.equal(leadRow.by, '12345678');
  assert.equal(leadRow.actor_session, LEAD_ACTOR);
  assert.equal(leadRow.ref, 'fixture:owner');
  assert.match(leadRow.text, /第 1 代/);
  assert.equal(leadRow.import_batch_id, null);
  const liveLeadRowId = Number(leadRow.row_id);
  assert.equal(store.latestLead().by, '12345678');
  assert.equal(store.latestLead().rowId, liveLeadRowId);
  assert.equal(store.ledgerStats().latestLead, '12345678');

  // ── promise gate: full UUID, not the colliding 8-char prefix ────────────
  assert.notEqual(COLLIDING_ACTOR, LEAD_ACTOR);
  assert.equal(COLLIDING_ACTOR.slice(0, 8), LEAD_ACTOR.slice(0, 8));
  // The literal colliding id has only four UUID groups, so Store refuses it at the
  // canonical-UUID check BEFORE the promise gate. Same string via raw SQL reaches the
  // gate and must fail: the trigger compares the whole value, not the 8-char prefix.
  assert.throws(() => store.appendLedger({ type: 'promise', text: 'prefix collision' }, { sessionId: COLLIDING_SESSION }),
    (err) => err.code === 'INVALID_INPUT' && /canonical UUID/.test(err.message));
  assert.throws(() => insLedger.run(at(), 'promise', 'prefix collision', '12345678', COLLIDING_ACTOR, null, null, 0, null), /MO_NOT_CURRENT_LEAD/);
  // A canonical colliding session proves the same denial through Store.
  const CANONICAL_COLLISION = 'session-12345678-cccc-dddd-eeee-ffffffffffff';
  assert.equal(CANONICAL_COLLISION.slice(8, 16), LEAD_ACTOR.slice(0, 8));
  assert.throws(() => store.appendLedger({ type: 'promise', text: 'canonical collision' }, { sessionId: CANONICAL_COLLISION }),
    (err) => err.code === 'LEDGER_PROMISE_DENIED' && /MO_NOT_CURRENT_LEAD/.test(err.message));
  assert.throws(() => store.appendLedger({ type: 'promise', text: 'unrelated session' }, { sessionId: UNRELATED_SESSION }),
    (err) => err.code === 'LEDGER_PROMISE_DENIED' && /MO_NOT_CURRENT_LEAD/.test(err.message));
  // Prefix-only actor_session is not the full UUID either.
  assert.throws(() => insLedger.run(at(), 'promise', 'prefix only', '12345678', '12345678', null, null, 0, null), /MO_NOT_CURRENT_LEAD/);
  // 没有 actor_session 的普通 promise 也进不了闸门（不是「找不到就不比较」）。
  assert.throws(() => insLedger.run(at(), 'promise', 'no actor', '12345678', null, null, null, 0, null), /MO_ACTOR_REQUIRED/);
  assert.throws(() => insLedger.run(at(), 'promise', 'delegated', '12345678', LEAD_ACTOR, null, null, 1, null), /MO_PROMISE_DELEGATED/);

  // ── full matching UUID succeeds ─────────────────────────────────────────
  const promise = store.appendLedger({ type: 'promise', text: 'current lead promise', feel: '' }, { sessionId: LEAD_SESSION });
  assert.equal(promise.by, '12345678');
  assert.equal(promise.actorSession, LEAD_ACTOR);
  assert.equal(promise.feel, '');
  assert.equal(store.listLedger({ type: 'promise', limit: 5 })[0].text, 'current lead promise');
  assert.equal(store.ledgerStats().total, 8);
  assert.equal(store.ledgerStats().byType.promise, 1);
  assert.equal(store.ledgerStats().byType.lead, 1);

  // ── v8 import provenance: a batch row + imported rows (raw SQL fixture) ─
  // 这里手工写批次行与导入行，模拟 tools/mo-ledger-import.mjs 的事务内写法；
  // 它证明的是**库层与 Store 的口径**，不是「导入器跑通了」。
  const batch = store.db.prepare([
    'INSERT INTO mo_import_batches',
    '(source_path, source_sha256, source_bytes, physical_lines, blank_lines, rows_imported, imported_at, importer)',
    'VALUES (?,?,?,?,?,?,?,?)',
  ].join(' ')).run('fixture/legacy-ledger.jsonl', 'a'.repeat(64), 128, 2, 0, 2, at(), 'selftest-fixture');
  const batchId = Number(batch.lastInsertRowid);
  assert.ok(batchId > 0);
  const insImported = store.db.prepare(INSERT_IMPORTED_SQL);
  // 导入的 lead：无 ref、无代次文本、无 actor —— 三条「本机写入才要」的约束都不适用。
  const importedLead = insImported.run(at(), 'lead', 'imported legacy lead row', 'deadbeef', null, null, 0, 1, '{"type":"lead","by":"deadbeef"}', batchId);
  // 导入的 promise：同样没有 actor_session，也不进闸门。
  const importedPromise = insImported.run(at(), 'promise', 'imported legacy promise row', 'deadbeef', null, null, 0, 2, '{"type":"promise","by":"deadbeef"}', batchId);
  assert.equal(Number(importedLead.changes), 1);
  assert.equal(Number(importedPromise.changes), 1);
  assert.equal(store.ledgerStats().total, 10);

  // 逐行自证：批次 + 物理行号 + 原文，actor_session 恒 NULL。
  const importedRows = store.listLedger({ limit: 50 }).filter((r) => r.importBatchId !== null);
  assert.equal(importedRows.length, 2);
  assert.deepEqual(importedRows.map((r) => r.legacyLine).sort(), [1, 2]);
  assert.deepEqual(importedRows.map((r) => r.actorSession), [null, null]);
  assert.deepEqual(importedRows.map((r) => r.importBatchId), [batchId, batchId]);

  // 三条导入护栏各自拦一类「半个溯源行」。
  assert.throws(() => store.db.prepare(INSERT_IMPORTED_WITH_ACTOR_SQL).run(at(), 'fact', 'imported row with actor', 'deadbeef', LEAD_ACTOR, null, null, 0, 3, '{"type":"fact"}', batchId), /MO_IMPORT_ACTOR_FORBIDDEN/);
  assert.throws(() => insImported.run(at(), 'fact', 'imported row without raw', 'deadbeef', null, null, 0, 3, null, batchId), /MO_IMPORT_ROW_INCOMPLETE/);
  assert.throws(() => insImported.run(at(), 'fact', 'imported row without line', 'deadbeef', null, null, 0, null, '{"type":"fact"}', batchId), /MO_IMPORT_ROW_INCOMPLETE/);
  assert.throws(() => store.db.prepare(INSERT_HALF_PROVENANCE_SQL).run(at(), 'fact', 'half provenance', '12345678', LEAD_ACTOR, null, null, 0, 4, null), /MO_IMPORT_BATCH_REQUIRED/);
  // 批次凭据本身也只追加。
  assert.throws(() => store.db.prepare('UPDATE mo_import_batches SET rows_imported=99 WHERE batch_id=?').run(batchId), /MO_IMPORT_BATCH_APPEND_ONLY/);
  assert.throws(() => store.db.prepare('DELETE FROM mo_import_batches WHERE batch_id=?').run(batchId), /MO_IMPORT_BATCH_APPEND_ONLY/);

  // 导入的 lead **不**成为当前权威：Store 的三条读路径都只认本机写入的行。
  assert.equal(store.latestLead().rowId, liveLeadRowId);
  assert.equal(store.latestLead().by, '12345678');
  assert.equal(store.latestLead().text, '第 1 代 · fixture');
  assert.equal(store.ledgerStats().latestLead, '12345678');
  const leadList = store.listLedger({ type: 'lead' });
  assert.equal(leadList.length, 2);
  assert.equal(leadList[0].importBatchId, batchId);
  assert.equal(leadList[0].actorSession, null);
  assert.equal(leadList[1].rowId, liveLeadRowId);
  assert.equal(leadList[1].actorSession, LEAD_ACTOR);

  // 行为证据（不只是读 SQL 文本）：导入行插在 live lead **之后**，如果闸门取「最后一条 lead」
  // 就会拿 NULL 比较而报 MO_NOT_CURRENT_LEAD；能通过说明它真的只认 import_batch_id IS NULL。
  const promiseAfterImport = store.appendLedger({ type: 'promise', text: 'promise after imported lead' }, { sessionId: LEAD_SESSION });
  assert.equal(promiseAfterImport.actorSession, LEAD_ACTOR);
  assert.equal(store.latestLead().rowId, liveLeadRowId);
  assert.equal(store.ledgerStats().total, 11);
  assert.equal(store.ledgerStats().byType.lead, 2);
  assert.equal(store.ledgerStats().byType.promise, 3);

  // ── append-only, rollback, close/reopen ─────────────────────────────────
  assert.throws(() => store.db.prepare('UPDATE mo_ledger SET text=? WHERE row_id=?').run('mutated', fact.rowId), /MO_APPEND_ONLY/);
  assert.throws(() => store.db.prepare('DELETE FROM mo_ledger WHERE row_id=?').run(fact.rowId), /MO_APPEND_ONLY/);
  const beforeRollback = store.ledgerStats().total;
  store.db.exec('BEGIN');
  store.appendLedger({ type: 'gain', text: 'rolled back' }, { sessionId: LEAD_SESSION });
  store.db.exec('ROLLBACK');
  assert.equal(store.ledgerStats().total, beforeRollback);

  store.close();
  store = openMetaStore({ path: dbPath, mode: 'readwrite' });
  assert.equal(store.state.current, SCHEMA_VERSION);
  assert.equal(store.state.ready, true);
  assert.equal(store.latestLead().rowId, liveLeadRowId);
  assert.equal(store.latestLead().by, '12345678');
  // listLedger 按 row_id 倒序：导入行与后写的 live promise 排在前面，所以按批次列逐位对。
  const reopenedLeads = store.listLedger({ type: 'lead' });
  assert.equal(reopenedLeads.length, 2);
  assert.deepEqual(reopenedLeads.map((r) => r.importBatchId), [batchId, null]);
  assert.equal(reopenedLeads[0].actorSession, null);
  assert.equal(reopenedLeads[1].actorSession, LEAD_ACTOR);
  const reopenedPromises = store.listLedger({ type: 'promise' });
  assert.equal(reopenedPromises.length, 3);
  assert.deepEqual(reopenedPromises.map((r) => r.importBatchId), [null, batchId, null]);
  assert.equal(reopenedPromises[1].actorSession, null);
  assert.equal(reopenedPromises[0].actorSession, LEAD_ACTOR);
  assert.equal(reopenedPromises[2].actorSession, LEAD_ACTOR);
  assert.equal(store.listLedger({ type: 'fact' })[0].text, 'fixture fact');
  assert.equal(store.ledgerStats().total, 11);

  // ── lead 换届口径（2026-11-17 新增）：插在这里是因为上面的行序断言已走完 ──
  //    三条判据：当前主导可交班 / 陌生人被拒 / 不带 ref 被宪章闸门拒 / 历史 lead 不参与。
  const h1 = store.appendLedger({ type: 'lead', text: '第 2 代 · 自己交班', ref: 'fixture:handover' }, { sessionId: LEAD_SESSION });
  assert.equal(h1.type, 'lead');
  assert.equal(store.latestLead().by, '12345678');
  const totalAfterHandover = store.ledgerStats().total;
  assert.throws(() => store.appendLedger({ type: 'lead', text: '第 3 代 · 陌生人来抢', ref: 'fixture:stranger' }, { sessionId: OTHER_SESSION }),
    (err) => err.code === 'LEDGER_LEAD_AUTH_REQUIRED' && /current live lead/.test(err.message));
  assert.equal(store.ledgerStats().total, totalAfterHandover, '被拒的那次不许留下行');
  assert.throws(() => store.appendLedger({ type: 'lead', text: '第 3 代 · 没写出处' }, { sessionId: LEAD_SESSION }),
    (err) => /MO_LEAD_REF_REQUIRED/.test(err.message));
  console.log('PASS lead handover: current live lead writes, stranger refused, missing ref refused, rejected write leaves no row');
  console.log('PASS v5 -> v9 upgrade; applied v1-v5 checksums unchanged, v1-v8 digests stable; reopen at schema 9');
  console.log('PASS v8 trigger surface: 8 mo_ledger triggers (old five + 3 import guards), no MO_LEAD_AUTH_REQUIRED SQL');
  console.log('PASS v9 surface: 5 echo tables + 2 fts5 virtual tables + 6 named indexes; 21 triggers (builds 2, frame_index 4 incl. idx: guards)');
  console.log('PASS promise gate: only ordinary inserts, only import_batch_id IS NULL leads, full actor_session UUID');
  console.log('PASS missing/invalid trusted identity refused on all 7 non-lead types; 6 append; promise -> MO_NO_LEAD');
  console.log('PASS lead handover gate: current live lead may write, a stranger is refused with LEDGER_LEAD_AUTH_REQUIRED; caller-provided import_batch_id refused');
  console.log('PASS raw-SQL lead fixture guards: MO_LEAD_REF_REQUIRED, MO_LEAD_GENERATION_REQUIRED, valid row accepted');
  console.log('PASS import guards: MO_IMPORT_ACTOR_FORBIDDEN / _ROW_INCOMPLETE / _BATCH_REQUIRED; batch append-only');
  console.log('PASS imported lead stays out of latestLead/live authority (before and after reopen)');
  console.log('PASS append-only update/delete, rollback, close/reopen; 11 rows; temp DB only (seeds are explicit fixtures, not authenticated)');
} finally {
  if (store && !store.closed) store.close();
  rmSync(root, { recursive: true, force: true });
}
