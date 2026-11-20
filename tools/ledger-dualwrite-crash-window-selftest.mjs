#!/usr/bin/env node
// TEMP-only probe of the ordinary JSONL -> SQLite crash window.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LedgerBase } from '../src/organs/ledger.mjs';
import { openMetaStore } from '../src/db/index.mjs';

const CHILD = '--crash-after-jsonl';
const SESSION = '00000000-0000-4000-8000-000000000058';
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-crash-window-'));
const script = fileURLToPath(import.meta.url);
const ok = [];
const bad = [];
const check = (name, condition, detail = '') => {
  (condition ? ok : bad).push(name + (condition ? '' : ' <- ' + String(detail)));
};
const tempOnly = (value) => {
  const rel = path.relative(os.tmpdir(), path.resolve(value));
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
};
function openStore(file) {
  const store = openMetaStore({ path: file, mode: 'readwrite' });
  store.migrate();
  return store;
}

try {
  if (process.argv[2] === CHILD) {
    const dir = process.argv[3];
    const file = path.join(dir, 'ledger.jsonl');
    const dbFile = path.join(dir, 'meta.sqlite');
    if (![dir, file, dbFile].every(tempOnly)) throw new Error('child path outside os.tmpdir');
    const store = openStore(dbFile);
    // Clone the real store surface, but terminate after LedgerBase has appended JSONL.
    const crashStore = Object.create(store);
    crashStore.appendLedger = () => process.exit(73);
    const ledger = new LedgerBase(file, { store: crashStore, sessionId: SESSION });
    ledger.write({ type: 'fact', text: 'JSONL_ONLY_BEFORE_SQL_CRASH', by: SESSION.slice(0, 8) });
    process.exit(74); // unexpected: append did not invoke crash seam
  }

  const dir = path.join(ROOT, 'abrupt');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'ledger.jsonl');
  const dbFile = path.join(dir, 'meta.sqlite');
  // Initialize schema in TEMP, before starting the writer child.
  const initial = openStore(dbFile);
  initial.close();
  check('all paths are under unique os.tmpdir root', tempOnly(ROOT) && tempOnly(file) && tempOnly(dbFile), ROOT);

  const child = spawnSync(process.execPath, [script, CHILD, dir], { encoding: 'utf8' });
  check('child ended via explicit abrupt exit 73', child.status === 73, JSON.stringify({status: child.status, signal: child.signal, stderr: child.stderr}));
  const fileRows = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const degradeFile = path.join(dir, 'ledger-degrade.jsonl');
  check('abrupt child left JSONL-only row', fileRows.some((row) => row.text === 'JSONL_ONLY_BEFORE_SQL_CRASH'), JSON.stringify(fileRows));
  check('abrupt child left no degrade marker', !fs.existsSync(degradeFile), fs.existsSync(degradeFile));

  const reopened = openStore(dbFile);
  const restarted = new LedgerBase(file, { store: reopened, sessionId: SESSION });
  const all = restarted.all();
  check('restart selects SQLite when marker is absent', restarted.lastReadBackend === 'sqlite', restarted.lastReadBackend);
  check('restart SQL view hides JSONL-only row', !all.some((row) => row.text === 'JSONL_ONLY_BEFORE_SQL_CRASH'), JSON.stringify(all));
  check('restart SQL store remains readable and empty', reopened.listLedgerAll({}).length === 0, reopened.listLedgerAll({}).length);
  reopened.close();

  // Caught SQL failure is intentionally different: it reaches LedgerBase.catch and writes marker.
  const fallbackDir = path.join(ROOT, 'caught-failure');
  fs.mkdirSync(fallbackDir, { recursive: true });
  const fallbackFile = path.join(fallbackDir, 'ledger.jsonl');
  const fallbackDb = path.join(fallbackDir, 'meta.sqlite');
  const baseStore = openStore(fallbackDb);
  const failingStore = Object.create(baseStore);
  const sentinel = new Error('synthetic caught failure');
  sentinel.code = 'SYNTHETIC_SQL_FAILURE';
  failingStore.appendLedger = () => { throw sentinel; };
  const writer = new LedgerBase(fallbackFile, { store: failingStore, sessionId: SESSION });
  const receipt = writer.write({ type: 'fact', text: 'JSONL_SURVIVES_CAUGHT_SQL_FAILURE', by: SESSION.slice(0, 8) });
  const marker = path.join(fallbackDir, 'ledger-degrade.jsonl');
  check('caught SQL error returns JSONL success with error', receipt.ok === true && receipt.backend === 'jsonl' && String(receipt.storeError).includes('SYNTHETIC_SQL_FAILURE'), JSON.stringify(receipt));
  check('caught SQL error writes exactly one degrade marker', fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim().split('\n').length === 1, fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : 'missing');
  baseStore.close();
  const fallbackStore = openStore(fallbackDb);
  const fallbackReader = new LedgerBase(fallbackFile, { store: fallbackStore, sessionId: SESSION });
  const fallbackRows = fallbackReader.all();
  check('restart with degrade marker selects JSONL fallback', fallbackReader.lastReadBackend === 'jsonl-fallback', fallbackReader.lastReadBackend);
  check('fallback exposes JSONL-only caught-failure row', fallbackRows.some((row) => row.text === 'JSONL_SURVIVES_CAUGHT_SQL_FAILURE'), JSON.stringify(fallbackRows));
  check('fallback does not fabricate a SQL row', fallbackStore.listLedgerAll({}).length === 0, fallbackStore.listLedgerAll({}).length);
  fallbackStore.close();
} catch (err) {
  bad.push('uncaught test error <- ' + (err && err.stack || String(err)));
} finally {
  fs.rmSync(ROOT, { recursive: true, force: true });
  check('unique TEMP root cleaned', !fs.existsSync(ROOT), ROOT);
}

for (const item of ok) console.log('PASS ' + item);
for (const item of bad) console.log('FAIL ' + item);
console.log(bad.length ? bad.length + ' failed / ' + (ok.length + bad.length) + ' total' : ok.length + ' passed / 0 failed');
process.exitCode = bad.length ? 1 : 0;
