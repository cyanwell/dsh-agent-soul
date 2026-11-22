#!/usr/bin/env node
// TEMP-only regression for shadow-frame importer session ID validation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { zstdCompressSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IMPORTER = path.join(HERE, 'shadow-frame-index.mjs');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-frame-sid-selftest-'));
const NODE = process.execPath;
const recordsFor = (id) => [
  { type: 'session', id, cwd: 'D:/synthetic/shadow-frame-sid', version: 1, createdAt: '2026-11-23T00:00:00.000Z' },
  { type: 'user', seq: 10, time: '2026-11-23T00:00:01.000Z', data: { text: 'synthetic session marker alpha' } },
  { type: 'assistant', seq: 20, time: '2026-11-23T00:00:02.000Z', data: { text: 'synthetic 会话 marker beta' } },
];
const writeFixture = (label, id) => {
  const dir = path.join(ROOT, label);
  fs.mkdirSync(dir, { recursive: true });
  const source = path.join(dir, 'synthetic-session.zst');
  const db = path.join(dir, 'synthetic-meta.sqlite3');
  const relocate = path.join(dir, 'synthetic-relocated');
  const frames = recordsFor(id).map((record) => zstdCompressSync(Buffer.from(JSON.stringify(record) + '\n', 'utf8')));
  fs.writeFileSync(source, Buffer.concat(frames));
  return { source, db, relocate };
};
const runImporter = (fixture) => spawnSync(NODE, [
  IMPORTER,
  '--source-file', fixture.source,
  '--mode', 'noop',
  '--db', fixture.db,
  '--relocate-dir', fixture.relocate,
], { encoding: 'utf8' });

try {
  const validId = 'jinglan~003Amain';
  const valid = writeFixture('valid', validId);
  const built = runImporter(valid);
  const receipt = JSON.parse(built.stdout);

  const invalidIds = ['bad/session', 'bad session', 'x'.repeat(129)];
  for (let i = 0; i < invalidIds.length; i++) {
    const fixture = writeFixture('invalid-' + i, invalidIds[i]);
    const rejected = runImporter(fixture);
    assert.equal(rejected.status, 1, 'invalid session ID must be rejected by importer CLI');
    const rejection = JSON.parse(rejected.stdout);
    assert.equal(rejection.ok, false);
    assert.match(rejection.error.message, /session header id is not a valid session id/);
    assert.equal(fs.existsSync(fixture.db), false, 'invalid session ID must be rejected before TEMP DB creation');
  }

  assert.equal(built.status, 0, 'valid tilde session ID should pass full TEMP importer build: ' + built.stdout.slice(0, 500));
  assert.equal(receipt.ok, true);
  assert.equal(receipt.session.sessionId, validId);
  assert.equal(fs.existsSync(valid.db), false, 'selftest cleans the TEMP database');
  console.log('PASS valid tilde SID completes real TEMP MetaStore import; 3 invalid SIDs rejected before DB creation');
} finally {
  fs.rmSync(ROOT, { recursive: true, force: true });
}
