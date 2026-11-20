#!/usr/bin/env node
// ECHO 第三轮性能原型自测：TEMP synthetic only；不访问真实会话、真实库、服务或网络。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { openMetaStore } from '../src/db/index.mjs';
import { runLiveSync } from './echo-live-sync.mjs';
import { createManifestFingerprintCache, assertTempTarget, measureNodeSpawnCost } from './echo-live-performance-prototype.mjs';

const TMP = fs.realpathSync(os.tmpdir());
const assertTarget = (p) => assertTempTarget(p);
const parent = assertTarget(TMP);
const ROOT = assertTarget(fs.mkdtempSync(path.join(parent, 'echo-live-perf-v3-')));
const SOURCE = assertTarget(path.join(ROOT, 'sessions'));
const DB = assertTarget(path.join(ROOT, 'meta.sqlite'));
const checks = [];
const ok = [];
const bad = [];
const counters = { readdir: 0, stat: 0, open: 0, read: 0, close: 0, sourceReadBytes: 0 };
const original = { readdirSync: fs.readdirSync, statSync: fs.statSync, openSync: fs.openSync, readSync: fs.readSync, closeSync: fs.closeSync };
const fdPaths = new Map();

function record(name, condition, detail = '') {
  const entry = { name, ok: Boolean(condition), detail };
  checks.push(entry);
  (entry.ok ? ok : bad).push(name + (detail ? ' -> ' + detail : ''));
  if (!entry.ok) throw new Error(name + ': ' + detail);
}
function mkdir(p) { assertTarget(p); fs.mkdirSync(p, { recursive: true }); }
function write(p, data, options) { assertTarget(p); fs.writeFileSync(p, data, options); }
function append(p, data) { assertTarget(p); fs.appendFileSync(p, data); }
function remove(p) { assertTarget(p); fs.rmSync(p, { recursive: true, force: true }); }
function sourceFile(p) { const a = path.resolve(p); return a === path.resolve(SOURCE) || a.startsWith(path.resolve(SOURCE) + path.sep); }
function resetCounters() { for (const k of Object.keys(counters)) counters[k] = 0; fdPaths.clear(); }
function snapshotCounters() { return { ...counters }; }
function instrument() {
  fs.readdirSync = function (...args) { counters.readdir += 1; return original.readdirSync.apply(this, args); };
  fs.statSync = function (...args) { counters.stat += 1; return original.statSync.apply(this, args); };
  fs.openSync = function (file, ...args) { counters.open += 1; const fd = original.openSync.call(this, file, ...args); fdPaths.set(fd, path.resolve(String(file))); return fd; };
  fs.readSync = function (fd, ...args) { counters.read += 1; const n = original.readSync.call(this, fd, ...args); const p = fdPaths.get(fd); if (p && sourceFile(p)) counters.sourceReadBytes += n; return n; };
  fs.closeSync = function (fd, ...args) { counters.close += 1; fdPaths.delete(fd); return original.closeSync.call(this, fd, ...args); };
}
function restoreInstrument() {
  fs.readdirSync = original.readdirSync; fs.statSync = original.statSync; fs.openSync = original.openSync; fs.readSync = original.readSync; fs.closeSync = original.closeSync;
}
function timed(label, fn) {
  resetCounters();
  const t0 = performance.now();
  let value; let error = null;
  try { value = fn(); } catch (e) { error = e; }
  const ms = performance.now() - t0;
  return { label, ms, counters: snapshotCounters(), value, error };
}
function frame(recordValue) { return zlib.zstdCompressSync(Buffer.from(JSON.stringify(recordValue) + '\n', 'utf8')); }
function sessionRecord(seq, type, text) {
  const base = { type, seq, time: Date.parse('2026-11-18T09:00:00.000Z') + seq * 1000 };
  if (type === 'user/message') return { ...base, data: { content: [{ type: 'text', text }] } };
  if (type === 'assistant/message') return { ...base, data: { message: { content: [{ type: 'text', text }] } } };
  return { ...base, cwd: 'D:/synthetic', agentPreset: 'test' };
}
function makeSession(sid, version, text) {
  const dir = assertTarget(path.join(SOURCE, sid)); mkdir(dir);
  const file = assertTarget(path.join(dir, 'session.v' + version + '.jsonl.zstd'));
  write(file, Buffer.concat([frame(sessionRecord(0, 'session', 'header')), frame(sessionRecord(1, 'user/message', text))]));
  return file;
}
function addFrame(file, seq, text) { append(file, frame(sessionRecord(seq, 'user/message', text))); }
function initDb() { const store = openMetaStore({ path: DB, mode: 'readwrite' }); try { store.migrate(); } finally { store.close(); } }
function dbState() {
  const store = openMetaStore({ path: DB, mode: 'readonly' });
  try {
    const stats = store.echoStats();
    const source = stats.sources[0] || null;
    const hit = store.echoSearch('性能原型', { surface: 'words', limit: 10 });
    return { generation: source ? source.generation : null, cursorSeq: source ? source.cursorSeq : null, aligned: source ? source.aligned : false, hitCount: hit.results.length, hitSource: hit.results[0] ? hit.results[0].echoSourceId : null, sourceId: source ? source.echoSourceId : null, state: source ? source.state : null };
  } finally { store.close(); }
}
function run(label) { return timed(label, () => runLiveSync({ db: DB, sourceRoot: SOURCE, namespace: 'log' })); }
function compactRun(result) {
  const r = result.value || {};
  return { label: result.label, wallMs: Number(result.ms.toFixed(3)), counters: result.counters, code: r.code || null, error: result.error ? String(result.error.message || result.error) : null, generation: r.generation ?? null, cursorSeq: r.tail && r.tail.cursor ? r.tail.cursor.seq : null, sourceBytes: result.counters.sourceReadBytes, tail: r.tail ? { bytesRead: r.tail.bytesRead, appended: r.tail.appended, skippedUnchanged: r.tail.skippedUnchanged, fullyRead: r.tail.fullyRead } : null };
}

async function main() {
  mkdir(SOURCE);
  makeSession('perf-v4-a1', 4, '性能原型 baseline');
  makeSession('perf-v3-b2', 3, '性能原型 v3');
  initDb();
  instrument();
  const initial = run('A-initial');
  record('A initial real runLiveSync imported', initial.value && initial.value.code === 'IMPORTED', initial.value && initial.value.code);
  const initialState = dbState();
  record('initial generation is 1 and aligned', initialState.generation === 1 && initialState.aligned === true, JSON.stringify(initialState));
  const repeat = run('A-repeat-empty');
  record('A repeat is unchanged', repeat.value && repeat.value.code === 'UNCHANGED', repeat.value && repeat.value.code);
  record('A repeat reads no source bytes', repeat.counters.sourceReadBytes === 0, String(repeat.counters.sourceReadBytes));
  const repeatState = dbState();
  record('A repeat generation/cursor stable', repeatState.generation === initialState.generation && repeatState.cursorSeq === initialState.cursorSeq, JSON.stringify({ initialState, repeatState }));

  resetCounters();
  const cache = createManifestFingerprintCache(SOURCE);
  const cacheInitReads = snapshotCounters();
  resetCounters();
  const idle1 = cache.idleRound('repeat-1');
  const idle2 = cache.idleRound('repeat-2');
  const idleReads = snapshotCounters();
  record('B idle reuses complete manifest', idle1.state === 'candidate' && idle1.authoritative === false && idle2.invalidation === 'none', JSON.stringify({ idle1, idle2 }));
  record('B idle does not re-list or stat', idleReads.readdir === 0 && idleReads.stat === 0, JSON.stringify(idleReads));

  const aFile = assertTarget(path.join(SOURCE, 'perf-v4-a1', 'session.v4.jsonl.zstd'));
  const bFile = assertTarget(path.join(SOURCE, 'perf-v3-b2', 'session.v3.jsonl.zstd'));
  const oldB = fs.readFileSync(bFile);
  const oldBStat = fs.statSync(bFile);
  write(bFile, Buffer.from(oldB).subarray(0, oldB.length - 1));
  cache.invalidate(bFile, 'changed', 'mtime-size-change');
  const mtimeChanged = cache.reconcile();
  record('mtime-size change invalidates cache', mtimeChanged.invalidation === 'rebuild-required' && mtimeChanged.changes.some((x) => x.file === bFile.replace(/\\/g, '/')), JSON.stringify(mtimeChanged));
  const mtimeReject = run('mtime-size-change-rejected');
  record('mtime-size change is refused by real chain', mtimeReject.error || (mtimeReject.value && mtimeReject.value.code !== 'IMPORTED'), compactRun(mtimeReject));
  const afterMtime = dbState();
  record('mtime rejection does not advance generation', afterMtime.generation === initialState.generation, JSON.stringify(afterMtime));
  write(bFile, oldB);
  fs.utimesSync(bFile, oldBStat.atime, oldBStat.mtime);

  addFrame(aFile, 2, '性能原型追加成功');
  const appendHint = cache.invalidate(aFile, 'changed', 'append');
  const appendRecon = cache.reconcile();
  record('append invalidation produces rebuild candidate', appendHint.invalidation === 'pending' && appendRecon.invalidation === 'rebuild-required' && appendRecon.changes.some((x) => x.file === aFile.replace(/\\/g, '/')), JSON.stringify(appendRecon));
  const appendRun = run('append-success');
  record('append succeeds in real parser/import chain', appendRun.value && appendRun.value.code === 'IMPORTED' && appendRun.value.tail.appended === 1, compactRun(appendRun));
  const appendState = dbState();
  record('append generation advances and retrieval stays same-generation', appendState.generation === 2 && appendState.aligned === true && appendState.hitCount > 0, JSON.stringify(appendState));

  const newFile = makeSession('perf-v4-new', 4, '性能原型新会话');
  cache.invalidate(newFile, 'new', 'new-session');
  const newRecon = cache.reconcile();
  record('new session is discovered', newRecon.changes.some((x) => x.type === 'new' && x.file === newFile.replace(/\\/g, '/')), JSON.stringify(newRecon));
  const newRun = run('new-session');
  record('new session import succeeds', newRun.value && newRun.value.code === 'IMPORTED', compactRun(newRun));
  const newState = dbState();
  record('new session generation advances', newState.generation === 3 && newState.aligned === true, JSON.stringify(newState));

  const originalA = fs.readFileSync(aFile);
  const originalAStat = fs.statSync(aFile);
  fs.truncateSync(aFile, Math.max(0, originalA.length - 8));
  cache.invalidate(aFile, 'changed', 'truncation');
  const truncRecon = cache.reconcile();
  record('truncation invalidates cache', truncRecon.changes.some((x) => x.file === aFile.replace(/\\/g, '/')), JSON.stringify(truncRecon));
  const truncRun = run('truncated-rejected');
  record('truncation is refused without generation advance', truncRun.error || (truncRun.value && truncRun.value.code !== 'IMPORTED'), compactRun(truncRun));
  const truncState = dbState();
  record('truncation preserves committed state', truncState.generation === newState.generation && truncState.cursorSeq === newState.cursorSeq, JSON.stringify(truncState));
  write(aFile, originalA);
  fs.utimesSync(aFile, originalAStat.atime, originalAStat.mtime);

  const deleted = assertTarget(path.join(SOURCE, 'perf-v3-b2', 'session.v3.jsonl.zstd'));
  remove(deleted);
  cache.invalidate(deleted, 'deleted', 'deleted-session');
  const delRecon = cache.reconcile();
  record('deleted session is discovered', delRecon.changes.some((x) => x.type === 'deleted' && x.file === deleted.replace(/\\/g, '/')), JSON.stringify(delRecon));
  const delRun = run('deleted-session-candidate');
  record('deleted session does not silently claim import', delRun.error || (delRun.value && delRun.value.code !== 'IMPORTED'), compactRun(delRun));
  const delState = dbState();
  record('deleted-session candidate leaves committed generation intact', delState.generation === newState.generation, JSON.stringify(delState));

  resetCounters();
  const cacheRepeat = cache.idleRound('repeat-after-reconcile');
  const cacheRepeatReads = snapshotCounters();
  record('B repeated idle returns candidate-only status', cacheRepeat.state === 'candidate' && cacheRepeat.authoritative === false && cacheRepeatReads.readdir === 0 && cacheRepeatReads.stat === 0, JSON.stringify({ cacheRepeat, cacheRepeatReads }));
  const spawn = measureNodeSpawnCost(5);
  const report = {
    node: process.version,
    fixture: { root: ROOT, source: SOURCE, db: DB, sessionsInitial: 2, versions: ['v3', 'v4'], tempOnly: true },
    runs: [compactRun(initial), compactRun(repeat), compactRun(mtimeReject), compactRun(appendRun), compactRun(newRun), compactRun(truncRun), compactRun(delRun)],
    cache: { initialReads: cacheInitReads, idleReads: idleReads, repeatedIdle: cacheRepeatReads, initialRows: cache.initial.rows, idleState: idle1.state, authoritative: false },
    generations: { initial: initialState, repeat: repeatState, afterMtime: afterMtime, append: appendState, newSession: newState, truncation: truncState, deletion: delState },
    retrieval: { initial: initialState.hitCount, append: appendState.hitCount, newSession: newState.hitCount, sameGenerationRule: 'echoStats source generation == successful run receipt generation; retrieval returns pointer/source only' },
    processCostModel: spawn,
    limitations: ['B idle is candidate/invalidation state only; it is not synchronization and never writes ECHO.', 'Cache correctness depends on watcher/periodic reconciliation; missed events require overflow/full scan.', 'mtime:size cannot prove same-key rewrite if an event is missed.', 'Node spawn measurement is not a resident worker implementation.', 'Synthetic scale and Windows filesystem timings do not establish production P95/P99, throughput, crash recovery, or real-time guarantees.'],
    checks: { passed: ok.length, failed: bad.length },
  };
  restoreInstrument();
  remove(ROOT);
  console.log(JSON.stringify({ ok: bad.length === 0, report, checks }, null, 2));
  process.exitCode = bad.length ? 1 : 0;
}
main().catch((err) => { try { restoreInstrument(); remove(ROOT); } catch {} console.error(JSON.stringify({ ok: false, error: String(err && err.stack || err), checks }, null, 2)); process.exitCode = 1; });
