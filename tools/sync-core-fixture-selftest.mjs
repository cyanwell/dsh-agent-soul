import assert from 'node:assert/strict';
import path from 'node:path';
import { createSyncRuntime } from '../src/sync/core.mjs';
import { main } from './soul-sync.mjs';

const root = path.join('\\synthetic', 'sessions');
const dataRoot = path.join('\\synthetic', 'data');
const statePath = path.join(dataRoot, 'sync-state.json');
const nowBase = Date.parse('2026-11-19T12:00:00.000Z');
const makeFrames = (id, seqs, mtime = nowBase, bytes = 100, source = root) => ({
  id, p: path.join(source, id, 'session.v4.jsonl.zstd'), mtime, size: bytes,
  records: [{ type: 'session', cwd: '/fixture', agentPreset: 'fixture' }, ...seqs.map(seq => ({ type: 'user', seq, text: id + ':' + seq }))],
});
function fixtureFs(initial = []) {
  const files = new Map(initial.map(f => [path.normalize(f.p), f]));
  const state = new Map();
  const dirs = new Set([path.normalize(root), path.normalize(dataRoot)]);
  for (const f of initial) f.p = path.normalize(f.p);
  const addParents = p => { let d = path.dirname(p); while (d !== '.' && d !== '/' && d !== '\\') { dirs.add(d); const parent = path.dirname(d); if (parent === d) break; d = parent; } };
  for (const f of initial) addParents(f.p);
  const fs = {
    readFileSync(p) { if (!state.has(p)) throw new Error('ENOENT'); return state.get(p); },
    writeFileSync(p, value) { state.set(p, String(value)); },
    mkdirSync(p) { dirs.add(p); },
    readdirSync(p) {
      p = path.normalize(p);
      if (!dirs.has(p)) throw new Error('ENOENT');
      const names = new Map();
      for (const d of dirs) if (path.dirname(d) === p) names.set(path.basename(d), true);
      for (const f of files.values()) if (path.dirname(f.p) === p) names.set(path.basename(f.p), false);
      return [...names].map(([name, dir]) => ({ name, isDirectory: () => dir }));
    },
    statSync(p) { const f = files.get(p); if (!f) throw new Error('ENOENT'); return { mtimeMs: f.mtime, size: f.size }; },
    promises: {
      async readdir(p) { return fs.readdirSync(p); },
      async stat(p) {
        const f = files.get(p);
        if (f) return { mtimeMs: f.mtime, size: f.size };
        if (p.endsWith('frames.jsonl')) { const s = storeRows.get(path.basename(path.dirname(p))); if (s?.frames.length) return { size: 1 }; }
        throw new Error('ENOENT');
      },
    },
    _state: state,
    _files: files,
  };
  const storeRows = new Map();
  return { fs, state, storeRows };
}
function makeStore(rows = new Map()) {
  return {
    root: dataRoot,
    load(id) { return rows.get(id) || null; },
    create(cwd, preset, opts) { rows.set(opts.id, { frames: [{ type: 'session', meta: {} }] }); },
    append(id, type, payload) { const row = rows.get(id) || { frames: [] }; row.frames.push({ type, ...payload }); rows.set(id, row); },
  };
}
function makeReader(fs) {
  return {
    read(p) { const f = fs._files.get(p); if (!f) throw new Error('missing synthetic input'); return { records: f.records, endOffset: f.size }; },
    async readAsync(p) { const f = fs._files.get(p); if (!f) throw new Error('missing synthetic input'); return { records: f.records, endOffset: f.size, yields: 0, maxBlockMs: 0 }; },
    async readTail(p, { fromOffset }) { const f = fs._files.get(p); if (!f) throw new Error('missing synthetic input'); return { records: f.records.filter(r => r.type !== 'session' && r.seq >= fromOffset), endOffset: f.size, yields: 0, maxBlockMs: 0 }; },
    toFrames(records) { return { frames: records.filter(r => r.type !== 'session').map(r => ({ type: r.type, t: '2026-11-19T12:00:00.000Z', text: r.text, meta: { seq: r.seq } })) }; },
  };
}
function makeClock() {
  let n = nowBase + 1_000_000;
  return { now: () => n++, parse: v => Date.parse(v), create: v => new Date(v === undefined ? n++ : v) };
}
function runtime({ fs, store, reader, logger, ...opts }) {
  return createSyncRuntime({ fs, path, store, reader: reader || makeReader(fs), logger: logger || { log() {}, error() {} }, sourceRoot: root, statePath, clock: makeClock(), ...opts });
}
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('CLI --dry with synthetic --src reports paths but writes neither store nor state', async () => {
  const source = path.join('\\synthetic', 'cli-dry'); const f = makeFrames('dry-one', [1, 2], nowBase, 100, source);
  const fx = fixtureFs([f]); const logs = [];
  await main(['--src', source, '--dry'], { config: { dataDir: dataRoot }, store: makeStore(fx.storeRows), fs: fx.fs, reader: makeReader(fx.fs), clock: makeClock(), logger: { log: x => logs.push(x), error() {} } });
  assert.equal(fx.storeRows.size, 0); assert.equal(fx.state.has(statePath), false);
  assert(logs.some(x => x.includes('写了 2 帧')), JSON.stringify(logs)); assert(logs.some(x => x.includes('--dry：没有真的写')));
  assert(logs.some(x => x.includes(statePath)));
});

test('CLI --src and --since select only matching synthetic mtime', async () => {
  const source = path.join('\\synthetic', 'cli-since'); const a = makeFrames('src-old', [1], nowBase - 100_000, 100, source); const b = makeFrames('src-new', [1], nowBase + 100_000, 100, source);
  const fx = fixtureFs([a, b]); const logs = [];
  await main(['--src', source, '--since', new Date(nowBase).toISOString()], { config: { dataDir: dataRoot }, store: makeStore(fx.storeRows), fs: fx.fs, reader: makeReader(fx.fs), clock: makeClock(), logger: { log: x => logs.push(x), error() {} } });
  assert.equal(fx.storeRows.get('src-new')?.frames.length, 2); assert.equal(fx.storeRows.has('src-old'), false);
  assert.equal(fx.storeRows.has('src-old'), false);
});

test('container seq dedupe bootstraps missing state watermark', () => {
  const f = makeFrames('dedupe', [1, 2, 3]); const fx = fixtureFs([f]);
  fx.storeRows.set('dedupe', { frames: [{ type: 'session' }, { type: 'user', meta: { seq: 2 } }] });
  const result = runtime({ fs: fx.fs, store: makeStore(fx.storeRows) }).round();
  assert.equal(result.wrote, 1); assert.deepEqual(fx.storeRows.get('dedupe').frames.map(x => x.meta?.seq).filter(Boolean), [2, 3]);
  assert.equal(JSON.parse(fx.state.get(statePath)).sessions.dedupe, 3);
});

test('async default batch is 40 and notes cap at 12', async () => {
  const files = Array.from({ length: 45 }, (_, i) => makeFrames('batch-' + String(i).padStart(2, '0'), [1], nowBase + i * 1000));
  const fx = fixtureFs(files); const logs = [];
  const result = await runtime({ fs: fx.fs, store: makeStore(fx.storeRows), logger: { log: x => logs.push(x) } }).roundAsync({ yieldMs: 1 });
  assert.equal(result.files, 40); assert.equal(result.wrote, 40); assert.equal(fx.storeRows.size, 40); assert(result.yields > 0);
  assert(logs[0].includes('还剩 5 个排队')); assert.equal(logs.filter(x => x.startsWith('  + ')).length, 12);
});

test('async incremental offset tail reads from checkpoint and advances offset', async () => {
  const f = makeFrames('offset', [1, 2, 3], nowBase, 300); const fx = fixtureFs([f]);
  fx.state.set(statePath, JSON.stringify({ sessions: { offset: 1 }, offsets: { offset: 100 }, at: null }));
  fx.storeRows.set('offset', { frames: [{ type: 'session' }, { type: 'user', meta: { seq: 1 } }] });
  const calls = []; const reader = makeReader(fx.fs); reader.readTail = async (p, o) => { calls.push(o.fromOffset); return { records: [{ type: 'user', seq: 2, text: 'offset:2' }, { type: 'user', seq: 3, text: 'offset:3' }], endOffset: 300, yields: 0 }; };
  const result = await runtime({ fs: fx.fs, store: makeStore(fx.storeRows), reader }).roundAsync({ yieldMs: 999999 });
  assert.deepEqual(calls, [100]); assert.equal(result.wrote, 2);
  const saved = JSON.parse(fx.state.get(statePath)); assert.equal(saved.sessions.offset, 3); assert.equal(saved.offsets.offset, 300);
});

test('abort checkpoints appended frame and preserves global at', async () => {
  const f = makeFrames('abort', [1, 2, 3]); const fx = fixtureFs([f]);
  fx.state.set(statePath, JSON.stringify({ sessions: {}, at: '2026-11-18T00:00:00.000Z' }));
  let stop = false; const store = makeStore(fx.storeRows); const append = store.append;
  store.append = (...args) => { append(...args); if (!fx.storeRows.get('abort').frames.some(x => x.type === 'session')) stop = true; };
  // create() materializes a session header; stop after the first content append instead.
  store.append = (...args) => { append(...args); if (++store.appendCount === 1) stop = true; }; store.appendCount = 0;
  const result = await runtime({ fs: fx.fs, store }).roundAsync({ yieldMs: 999999, shouldStop: () => stop });
  assert.equal(result.aborted, true); assert.equal(fx.storeRows.get('abort').frames.length, 2);
  const checkpoint = JSON.parse(fx.state.get(statePath)); assert.equal(checkpoint.sessions.abort, 1); assert.equal(checkpoint.at, '2026-11-18T00:00:00.000Z');
});

test('busy round rejects overlap; cancel and quiesce settle', async () => {
  const f = makeFrames('busy', [1]); const fx = fixtureFs([f]); let release;
  const gate = new Promise(resolve => { release = resolve; }); const reader = makeReader(fx.fs);
  reader.readAsync = async p => { await gate; return makeReader(fx.fs).readAsync(p); };
  const rt = runtime({ fs: fx.fs, store: makeStore(fx.storeRows), reader }); const first = rt.roundAsync({ yieldMs: 999999 });
  assert.equal((await rt.roundAsync()).busy, true); rt.cancelSync(); release();
  assert.equal((await first).aborted, true); assert.equal(await rt.syncQuiesce(50), true);
});

test('watch immediately runs, registers 5000ms timer, and stop clears it', async () => {
  const f = makeFrames('watch', [1]); const fx = fixtureFs([f]); const logs = []; let timerFn; let intervalMs; let cleared;
  const handle = await main(['--src', root, '--watch'], { config: { dataDir: dataRoot }, store: makeStore(fx.storeRows), fs: fx.fs, reader: makeReader(fx.fs), clock: makeClock(), logger: { log: x => logs.push(x), error() {} }, setInterval(fn, ms) { timerFn = fn; intervalMs = ms; return 73; }, clearInterval(id) { cleared = id; } });
  assert(fx.storeRows.has('watch')); assert(logs.some(x => x.includes('每 5 秒'))); assert(logs.some(x => x.includes(statePath)));
  assert.equal(intervalMs, 5000); assert.equal(handle.timer, 73); handle.stop(); assert.equal(cleared, 73);
  timerFn(); assert.equal(fx.storeRows.get('watch').frames.length, 2);
});

test('sync mtime grace includes exactly 2min and excludes older files', () => {
  const cutoff = nowBase - 120_000;
  const included = makeFrames('grace-edge', [1], cutoff);
  const excluded = makeFrames('grace-old', [1], cutoff - 1);
  const fx = fixtureFs([included, excluded]);
  fx.state.set(statePath, JSON.stringify({ sessions: {}, at: new Date(nowBase).toISOString() }));
  const result = runtime({ fs: fx.fs, store: makeStore(fx.storeRows) }).round();
  assert.equal(result.files, 1);
  assert.equal(fx.storeRows.has('grace-edge'), true);
  assert.equal(fx.storeRows.has('grace-old'), false);
});

test('corrupt state JSON falls back to empty sessions and null at', () => {
  const f = makeFrames('bad-state', [1], nowBase - 86_400_000); const fx = fixtureFs([f]);
  fx.state.set(statePath, '{not-json');
  const result = runtime({ fs: fx.fs, store: makeStore(fx.storeRows) }).round();
  assert.equal(result.wrote, 1);
  assert.equal(JSON.parse(fx.state.get(statePath)).sessions['bad-state'], 1);
});

test('wrapper ignores unknown args and preserves missing/duplicate value semantics', async () => {
  const source = path.join('\\synthetic', 'args');
  const fallback = makeFrames('arg-default-src', [1], nowBase, 100, 'D:/AI/dsh/home/sessions');
  const selected = makeFrames('arg-first-src', [1], nowBase, 100, source);
  const ignored = makeFrames('arg-second-src', [1], nowBase, 100, path.join('\\synthetic', 'second'));
  const fx = fixtureFs([fallback, selected, ignored]);
  const logger = { log() {}, error() {} };
  await main(['--unknown', '--src', '', '--since'], { config: { dataDir: dataRoot }, store: makeStore(fx.storeRows), fs: fx.fs, reader: makeReader(fx.fs), clock: makeClock(), logger });
  assert.equal(fx.storeRows.has('arg-default-src'), true, '--src missing value uses default; --since missing value uses null');
  assert.equal(fx.storeRows.has('arg-first-src'), false);
  const fx2 = fixtureFs([fallback, selected, ignored]);
  await main(['--src', source, '--src', path.join('\\synthetic', 'second'), '--unknown'], { config: { dataDir: dataRoot }, store: makeStore(fx2.storeRows), fs: fx2.fs, reader: makeReader(fx2.fs), clock: makeClock(), logger });
  assert.equal(fx2.storeRows.has('arg-first-src'), true, 'duplicate --src uses first occurrence');
  assert.equal(fx2.storeRows.has('arg-second-src'), false);
});

test('misaligned tail falls back to injected full reader', async () => {
  const f = makeFrames('misaligned', [1, 2], nowBase, 300); const fx = fixtureFs([f]);
  fx.state.set(statePath, JSON.stringify({ sessions: { misaligned: 0 }, offsets: { misaligned: 100 }, at: null }));
  fx.storeRows.set('misaligned', { frames: [{ type: 'session' }] });
  const reader = makeReader(fx.fs); let tailCalls = 0; let fullCalls = 0;
  reader.readTail = async () => { tailCalls++; return { records: [], endOffset: 300, misaligned: true, yields: 0 }; };
  reader.readAsync = async p => { fullCalls++; return makeReader(fx.fs).readAsync(p); };
  const result = await runtime({ fs: fx.fs, store: makeStore(fx.storeRows), reader }).roundAsync({ yieldMs: 999999 });
  assert.equal(tailCalls, 1); assert.equal(fullCalls, 1);
  assert.equal(result.wrote, 2);
  assert.equal(fx.storeRows.get('misaligned').frames.map(x => x.meta?.seq).filter(Boolean).join(','), '1,2');
});

let failures = 0;
for (const [name, fn] of tests) {
  if (process.env.SYNC_FIXTURE_ONLY && !name.includes(process.env.SYNC_FIXTURE_ONLY)) continue;
  console.log('RUN ' + name);
  try { await fn(); console.log('PASS ' + name); }
  catch (error) { failures++; console.error('FAIL ' + name + '\n' + (error?.stack || error)); }
}
console.log('RESULT ' + (tests.length - failures) + '/' + tests.length + ' passed');
if (failures) process.exitCode = 1;
