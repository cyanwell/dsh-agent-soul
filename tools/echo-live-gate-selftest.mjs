import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decideEchoLiveStart } from '../src/organs/echo-live-gate.mjs';

const temp = fs.realpathSync(os.tmpdir());
const root = fs.mkdtempSync(path.join(temp, 'echo-live-gate-'));
const source = path.join(root, 'source');
const data = path.join(root, 'data');
const db = path.join(data, 'meta.sqlite');
let passed = 0;
try {
  fs.mkdirSync(source); fs.mkdirSync(data); fs.writeFileSync(db, 'synthetic-db-placeholder');
  const cases = [
    ['off by default', { enabled: false, readOnly: false, sourceRoot: source, dbPath: db, dataDir: data }, 'disabled'],
    ['read-only refuses writer', { enabled: true, readOnly: true, sourceRoot: source, dbPath: db, dataDir: data }, 'read-only'],
    ['missing source config', { enabled: true, readOnly: false, sourceRoot: '', dbPath: db, dataDir: data }, 'source-unconfigured'],
    ['missing source path', { enabled: true, readOnly: false, sourceRoot: path.join(root, 'missing'), dbPath: db, dataDir: data }, 'source-missing'],
    ['missing DB path', { enabled: true, readOnly: false, sourceRoot: source, dbPath: path.join(data, 'missing.sqlite'), dataDir: data }, 'database-missing'],
    ['missing fallback DB', { enabled: true, readOnly: false, sourceRoot: source, dataDir: path.join(root, 'empty-data') }, 'database-missing'],
  ];
  for (const [name, input, reason] of cases) { const got = decideEchoLiveStart(input); assert.equal(got.start, false, name); assert.equal(got.reason, reason, name); passed++; }
  const enabled = decideEchoLiveStart({ enabled: true, readOnly: false, sourceRoot: source, dbPath: db, dataDir: data });
  assert.deepEqual(enabled, { start: true, sourceRoot: source, dbPath: db }); passed++;
  console.log(`echo-live-gate-selftest: ${passed}/7 PASS`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
assert.equal(fs.existsSync(root), false, 'TEMP root removed');
