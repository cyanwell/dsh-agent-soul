#!/usr/bin/env node
// TEMP-only fault injection for LedgerBase retry and dual-write asymmetry.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LedgerBase } from '../src/organs/ledger.mjs';
import { openMetaStore } from '../src/db/index.mjs';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-retry-asymmetry-'));
const SESSION = '00000000-0000-4000-8000-000000000059';
const ok = [];
const bad = [];
const opened = new Set();
const check = (name, condition, detail = '') => {
  (condition ? ok : bad).push(name + (condition ? '' : ' <- ' + String(detail)));
};
const underTemp = (value) => {
  const rel = path.relative(os.tmpdir(), path.resolve(value));
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
};
function storeAt(file) {
  if (!underTemp(file) || !underTemp(ROOT)) throw new Error('refuse non-TEMP SQLite path');
  const store = openMetaStore({ path: file, mode: 'readwrite' });
  opened.add(store);
  store.migrate();
  return store;
}
function jsonlRows(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}
function main() {
  check('unique root and every fixture path are under os.tmpdir', underTemp(ROOT), ROOT);

  // Same ordinary request replayed twice: no operation key exists in this API.
  {
    const dir = path.join(ROOT, 'ordinary-retry');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'ledger.jsonl');
    const store = storeAt(path.join(dir, 'meta.sqlite'));
    const ledger = new LedgerBase(file, { store, sessionId: SESSION });
    const request = { type: 'fact', text: 'same request without idempotency key', by: SESSION.slice(0, 8) };
    const first = ledger.write(request);
    const retry = ledger.write(request);
    const fileRows = jsonlRows(file);
    const sqlRows = store.listLedgerAll({});
    check('ordinary same-request retry succeeds twice', first.ok && retry.ok, JSON.stringify([first, retry]));
    check('ordinary retry duplicates two JSONL rows', fileRows.length === 2 && fileRows.every((row) => row.text === request.text), JSON.stringify(fileRows));
    check('ordinary retry duplicates two SQL rows', sqlRows.length === 2 && sqlRows.every((row) => row.text === request.text), JSON.stringify(sqlRows));
    check('ordinary retry has no row identity/idempotency key to deduplicate', !('idempotencyKey' in first.row) && first.row.rowId !== retry.row.rowId, JSON.stringify([first.row.rowId, retry.row.rowId]));
  }

  // SQL-first lead: create an append failure only at the TEMP JSONL path.
  {
    const dir = path.join(ROOT, 'lead-jsonl-fails');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'ledger.jsonl');
    fs.mkdirSync(file); // appendFileSync(file, ...) throws EISDIR after SQL commit.
    const store = storeAt(path.join(dir, 'meta.sqlite'));
    const ledger = new LedgerBase(file, { store, sessionId: SESSION });
    const result = ledger.write({
      type: 'lead',
      text: '第1代 · 接手于 2026-11-19 · 上一代做了：无（首代）',
      by: SESSION.slice(0, 8),
      ref: 'TEMP fault-injection retry asymmetry test',
    });
    const sqlRows = store.listLedgerAll({});
    check('SQL-first lead append failure returns failure rather than success', result.ok === false && Boolean(result.code), JSON.stringify(result));
    check('SQL-first lead SQL row remains committed after JSONL append failure', sqlRows.length === 1 && sqlRows[0].type === 'lead', JSON.stringify(sqlRows));
    check('SQL-first lead JSONL path remains the injected directory', fs.statSync(file).isDirectory());
    check('lead append failure leaves TEMP degrade evidence', fs.existsSync(path.join(dir, 'ledger-degrade.jsonl')));
  }

  // JSONL-first fact: an append failure happens before SQL is attempted.
  {
    const dir = path.join(ROOT, 'fact-jsonl-fails');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'ledger.jsonl');
    fs.mkdirSync(file);
    const store = storeAt(path.join(dir, 'meta.sqlite'));
    const ledger = new LedgerBase(file, { store, sessionId: SESSION });
    let thrown = null;
    try {
      ledger.write({ type: 'fact', text: 'JSONL append must fail before SQL', by: SESSION.slice(0, 8) });
    } catch (error) { thrown = error; }
    const sqlRows = store.listLedgerAll({});
    check('JSONL-first fact append exception propagates to caller', Boolean(thrown), String(thrown));
    check('JSONL-first fact SQL append was never reached', sqlRows.length === 0, JSON.stringify(sqlRows));
    check('JSONL-first fact failure creates no degrade marker', !fs.existsSync(path.join(dir, 'ledger-degrade.jsonl')));
  }

  // Imported rows stay readable but do not define currentLead / brain gate.
  {
    const dir = path.join(ROOT, 'imported-store-fixture');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'ledger.jsonl');
    const importedLead = { t: '2026-11-18T00:00:00.000Z', type: 'lead', by: 'historic1', text: 'imported historical lead', importBatchId: 9, legacyLine: 1 };
    const liveLead = { t: '2026-11-19T00:00:00.000Z', type: 'lead', by: SESSION.slice(0, 8), text: 'live lead', importBatchId: null, legacyLine: null };
    const fixtureRows = [importedLead, liveLead];
    const fakeStore = {
      listLedger: () => [{ t: liveLead.t }],
      listLedgerAll: () => fixtureRows,
      appendLedger: () => { throw new Error('unexpected append: brain gate should reject'); },
    };
    const ledger = new LedgerBase(file, { store: fakeStore, sessionId: SESSION });
    const readable = ledger.all();
    check('imported lead remains readable in Store projection', readable.length === 2 && readable[0].importBatchId === 9 && readable[0].legacyLine === 1, JSON.stringify(readable));
    check('currentLead skips imported historical lead', ledger.currentLead() === liveLead.by, ledger.currentLead());
    check('brain gate recognizes only the live lead actor', ledger.isBrain(SESSION) && !ledger.isBrain('ffffffff-0000-4000-8000-000000000099'));
    const rejected = ledger.write({ type: 'promise', text: 'historical actor must not pass brain gate', by: 'historic1' });
    check('historical imported lead cannot pass promise brain gate', rejected.ok === false && rejected.code === 'NOT_BRAIN', JSON.stringify(rejected));
  }
}

try {
  if (!underTemp(ROOT)) throw new Error('TEMP root validation failed');
  main();
} catch (error) {
  bad.push('unexpected test exception <- ' + (error && error.stack || String(error)));
} finally {
  for (const store of opened) {
    try { store.close(); } catch (error) { bad.push('store close failed <- ' + String(error)); }
  }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); }
  catch (error) { bad.push('TEMP cleanup threw <- ' + String(error)); }
  check('unique TEMP root cleaned', !fs.existsSync(ROOT), ROOT);
}

for (const item of ok) console.log('PASS ' + item);
for (const item of bad) console.log('FAIL ' + item);
console.log(bad.length ? bad.length + ' failed / ' + (ok.length + bad.length) + ' total' : ok.length + ' passed / 0 failed');
process.exitCode = bad.length ? 1 : 0;
