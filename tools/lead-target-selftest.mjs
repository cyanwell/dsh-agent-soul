#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLeadTargetResolver } from '../src/organs/lead-target.mjs';
import { openMetaStore } from '../src/db/index.mjs';

const tempRoot = path.resolve(os.tmpdir());
const root = fs.mkdtempSync(path.join(tempRoot, 'lead-target-'));
assert.ok(path.resolve(root).startsWith(tempRoot + path.sep), 'synthetic fixtures must stay under os.tmpdir');
const liveId = 'session-11111111-1111-1111-1111-111111111111';
const oldId = 'session-22222222-2222-2222-2222-222222222222';
const sessions = [{ id: liveId }, { id: oldId }];
const file = path.join(root, '02-墨.jsonl');
const logFile = path.join(root, 'degrade.jsonl');
const store = openMetaStore({ path: path.join(root, 'meta.sqlite'), mode: 'readwrite' });
store.migrate();
try {
  store.appendLedger({ type: 'lead', text: '第1代 · 接手于 2026-11-19 · 上一代做了：无（首代）', by: '11111111', ref: 'selftest' }, { sessionId: liveId });
  const batch = store.db.prepare('INSERT INTO mo_import_batches (source_path,source_sha256,source_bytes,physical_lines,blank_lines,rows_imported,imported_at,importer) VALUES (?,?,?,?,?,?,?,?)').run('fixture.jsonl', 'a'.repeat(64), 32, 1, 0, 1, new Date().toISOString(), 'selftest');
  store.db.prepare('INSERT INTO mo_ledger (t,type,text,by,actor_session,ref,feel,by_user,legacy_line,legacy_raw,import_batch_id) VALUES (?,?,?,?,NULL,NULL,NULL,1,1,?,?)')
    .run('2099-01-01T00:00:00.000Z', 'lead', 'historical imported lead', '22222222', JSON.stringify({ type: 'lead' }), Number(batch.lastInsertRowid));
  fs.writeFileSync(file, JSON.stringify({ type: 'lead', by: '22222222', t: '2099-01-01', text: 'jsonl fallback lead' }) + '\n');

  const sql = createLeadTargetResolver({ config: {}, metaStore: store, ledgerFile: file, sessionsProvider: () => sessions, fallbackLogFile: logFile, now: () => 1000 });
  const live = await sql.refresh();
  assert.equal(live.ok, true); assert.equal(live.sessionId, liveId); assert.equal(live.backend, 'sqlite'); assert.equal(live.degraded, false);
  assert.equal(live.leadSource, 'mo_ledger:live');

  const unavailable = createLeadTargetResolver({ config: {}, metaStore: { latestLead() { const e = new Error('missing table'); e.code = 'SQLITE_ERROR'; throw e; } }, ledgerFile: file, sessionsProvider: () => sessions, fallbackLogFile: logFile, now: () => 2000 });
  const fallback = await unavailable.refresh();
  assert.equal(fallback.ok, true); assert.equal(fallback.sessionId, oldId); assert.equal(fallback.backend, 'jsonl'); assert.equal(fallback.degraded, true);
  const receipt = JSON.parse(fs.readFileSync(logFile, 'utf8').trim().split('\n').at(-1));
  assert.equal(receipt.backend, 'jsonl'); assert.match(receipt.reason, /missing table/);

  const notInjected = createLeadTargetResolver({ config: {}, ledgerFile: file, sessionsProvider: () => sessions, fallbackLogFile: logFile, now: () => 3000 });
  const compat = await notInjected.refresh();
  assert.equal(compat.backend, 'jsonl'); assert.equal(compat.degraded, true); assert.equal(compat.sessionId, oldId);
  console.log('3 lead-target checks passed (SQL live, JSONL fallback with receipt, no-store compatibility).');
} finally {
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
}
