#!/usr/bin/env node
// tools/meta-store-selftest.mjs —— P1a/v3 + P1b/v4 元数据垂直切片的自测（实现者自测）。
//
// 覆盖：P1a 的 34 条（C1–C8 + D1/D2 + O1/O2/O3 + 指纹 helper）**一条不删**，
// 其中「迁移条数 / schema 版本」这类断言改成了按 MIGRATIONS / SCHEMA_VERSION 计算 ——
// 不变量是「迁移史连续且每条都记账」，不是「恰好 3 条」；P1b 的 v4 是同一族的第 4 条。
// 新增 P1b：bigram 检索（T35–T41）、来源搬迁与 P6 验收（T42–T43）、流身份硬约束（T44–T45）。
// 新增 P1b 返修（2026-11-09，T48–T53）：非 CJK 走 raw 子串语义（P1/8f3a/7eff99/makeStream/couple
// 五形状）、600 诱饵 + 第 601 条真命中、limit 只限返回不限扫描、批次边界无漏、CJK 硬样例、
// expectFile 验收后门不存在。
//
// 铁律：只在 os.tmpdir() 里新建库，任何一次都不读、不写真实的记忆文件
// （data/、sessions/、02-墨.jsonl、config 里的凭据一概不碰）。断言的每一条路径
// 都必须以本次 tempRoot 开头。
//
// 跑法（必须用 DSH 自带的 Node 24，见 servers.json 里 agent-soul 那条 node）：
//   & "C:\Users\pc\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" tools/meta-store-selftest.mjs

import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, statSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

import {
  openMetaStore,
  migrate,
  MIGRATIONS as MIGRATION_LIST,
  buildSearchText,
  buildQueryPlan,
  containsNeedle,
  searchFrames,
  verifyPtrSample,
  isStreamFingerprint,
  SEARCH_MODES,
  hashFrame,
  parsePtr,
  makePtr,
  engineInfo,
  isMetaStoreError,
  CODES,
  SCHEMA_VERSION,
  MIGRATIONS,
  MAX_PTR_SEQ,
  SNIPPET_MAX,
  capSnippet,
  checksum,
  migrationDigest,
  makeStreamFingerprint,
  relToSource,
  rebuildFrameFts,
} from '../src/db/index.mjs';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SRC_ROOT = join(HERE, '..', 'src');
const SRC_DB = join(SRC_ROOT, 'db');
const tempRoot = mkdtempSync(join(tmpdir(), 'meta-store-selftest-'));

// 所有 store 都从这里开：收尾时统一关闭。Windows 上还有句柄时 rmSync 必然 EPERM ——
// 03:30–03:32 那三个遗留目录就是这么来的（失败用例提前返回，连接没关）。
const openStores = [];
function openStore(options) {
  const store = openMetaStore(options);
  openStores.push(store);
  return store;
}

const results = [];

function assert(cond, message, extra) {
  if (!cond) {
    const err = new Error(message);
    err.detail = extra === undefined ? null : extra;
    throw err;
  }
}

function assertCode(fn, code, label) {
  try {
    fn();
  } catch (err) {
    assert(isMetaStoreError(err), label + ': expected MetaStoreError, got ' + (err && err.name) + ' / ' + (err && err.message));
    assert(err.code === code, label + ': expected code ' + code + ', got ' + err.code + ' (' + err.message + ')');
    return err;
  }
  throw new Error(label + ': expected to throw ' + code + ', but nothing was thrown');
}

function test(name, fn) {
  const started = Date.now();
  try {
    fn();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log('PASS  ' + name);
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - started, error: err });
    console.log('FAIL  ' + name);
    console.log('      ' + (err && err.message));
    if (err && err.detail) console.log('      detail: ' + JSON.stringify(err.detail));
    if (err && err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
  }
}

function dbPath(name) {
  const p = join(tempRoot, name + '.sqlite');
  assert(p.startsWith(tempRoot), 'refusing to open a db outside tempRoot: ' + p);
  return p;
}

const DSH_ROOT = 'D:/AI/dsh/home/sessions';
const V4_ROOT = 'D:/AI/dsh/home/storages/v4-mirror';

function dshSource(overrides) {
  return Object.assign({
    sourceId: 'dsh-home',
    kind: 'dsh-log',
    namespace: 'log',
    authority: 'primary',
    rawPath: DSH_ROOT,
    pathKind: 'dir',
  }, overrides || {});
}

function v4Source(overrides) {
  return Object.assign({
    sourceId: 'v4-mirror',
    kind: 'v4-mirror',
    namespace: 'v4log',
    authority: 'mirror',
    rawPath: V4_ROOT,
    pathKind: 'dir',
  }, overrides || {});
}

function frameRecord(opts) {
  const o = opts || {};
  const source = o.source || dshSource();
  return {
    source,
    session: { sessionId: o.sessionId || 'session-aaa' },
    frame: {
      seq: o.seq === undefined ? 1 : o.seq,
      frameOrdinal: o.frameOrdinal === undefined ? 0 : o.frameOrdinal,
      rawPath: o.rawPath || (source.rawPath + '/session-aaa/frames.jsonl'),
      text: o.text === undefined ? 'frame body ' + (o.seq === undefined ? 1 : o.seq) : o.text,
      type: o.type,
      eventAt: o.eventAt,
      snippet: o.snippet,
      contentHash: o.contentHash,
    },
    cursor: o.cursor === undefined ? undefined : o.cursor,
  };
}

// P1b 前置 2：游标只接受 makeStreamFingerprint 的产物。测试也要用真指纹，
// 否则测的就不是今天这条契约（P1a 时代的 'file-A' 已经写不进去了）。
const PARSER_VERSION = 'v4-frame-1';
function streamFp(firstFrameText, sessionId) {
  return makeStreamFingerprint({
    parserVersion: PARSER_VERSION,
    sessionId: sessionId || 'session-aaa',
    firstCompleteFrame: firstFrameText,
  });
}
const FP_A = streamFp('{"seq":0,"text":"file A first frame"}');
const FP_B = streamFp('{"seq":0,"text":"file B first frame"}');

function freshStore(name) {
  const store = openStore({ path: dbPath(name), mode: 'readwrite' });
  store.migrate();
  return store;
}

function walkMjs(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMjs(p));
    else if (entry.name.endsWith('.mjs') || entry.name.endsWith('.cjs') || entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// ── T1 引擎版本 ────────────────────────────────────────────────────────────
test('T1 engine: node 24 + node:sqlite version recorded', () => {
  const info = engineInfo();
  assert(info.engine === 'node:sqlite', 'engine name');
  assert(info.nodeVersion === process.version, 'nodeVersion should equal process.version');
  assert(/^v\d+\.\d+\.\d+$/.test(process.version), 'process.version shape: ' + process.version);
  assert(/^3\.\d+\.\d+$/.test(info.sqliteVersion), 'sqlite_version shape: ' + info.sqliteVersion);
  const major = Number(info.sqliteVersion.split('.')[1]);
  assert(major >= 35, 'sqlite minor should be >= 35, got ' + info.sqliteVersion);
  const nodeMajor = Number(process.version.replace(/^v/, '').split('.')[0]);
  assert(nodeMajor >= 22, 'node major >= 22, got ' + process.version);
  console.log('      node=' + info.nodeVersion + ' sqlite=' + info.sqliteVersion);
});

// ── T2 架构：扫描范围 = src/**（不是全仓） ────────────────────────────────
test('T2 architecture: node:sqlite is imported only by src/db/engine.mjs (scan scope: src/**)', () => {
  const files = walkMjs(SRC_ROOT);
  assert(files.length > 10, 'src/** scan should see the real tree, got ' + files.length + ' files');
  assert(files.indexOf(join(SRC_DB, 'engine.mjs')) !== -1, 'engine.mjs should exist');
  const importRe = /(?:require\(\s*['"]node:sqlite['"]\s*\)|from\s+['"]node:sqlite['"]|import\(\s*['"]node:sqlite['"]\s*\))/;
  const offenders = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    if (importRe.test(text) && f !== join(SRC_DB, 'engine.mjs')) offenders.push(f);
  }
  assert(offenders.length === 0, 'only src/db/engine.mjs may import node:sqlite inside src/**, offenders: ' + offenders.join(', '));
  console.log('      scanned ' + files.length + ' files under src/** (tools/meta-store-selftest.mjs is a test, not counted)');
});

// ── T3 迁移 + checksum + 版本记录 ─────────────────────────────────────────
test('T3 migrate: v1+v2 applied, checksum + node/sqlite version recorded per migration', () => {
  const path = dbPath('t3');
  const store = openStore({ path, mode: 'readwrite' });
  assert(store.state.ready === false, 'fresh db must not be ready before migrate');
  assertCode(function () { store.ingest(frameRecord()); }, CODES.MIGRATION_REQUIRED, 'ingest before migrate');

  const res = store.migrate();
  assert(res.applied.length === MIGRATION_LIST.length, 'all migrations applied, got ' + res.applied.length);
  assert(res.current === SCHEMA_VERSION, 'current == SCHEMA_VERSION, got ' + res.current);
  assert(SCHEMA_VERSION === 5, 'P1c bumps the schema to v5 (artifacts), got ' + SCHEMA_VERSION);
  assert(store.state.ready === true, 'ready after migrate');
  assert(store.state.applied.length === MIGRATION_LIST.length, 'one schema_migrations row per migration');
  for (let i = 0; i < MIGRATION_LIST.length; i += 1) {
    assert(store.state.applied[i].checksum === res.applied[i].checksum, 'v' + (i + 1) + ' checksum persisted');
  }

  const tables = store.db.prepare("select name from sqlite_master where type='table' order by name").all().map(function (r) { return r.name; });
  ['frame_index', 'schema_migrations', 'sessions', 'sources', 'sync_cursors', 'frame_fts', 'source_relocations', 'artifacts', 'artifact_events'].forEach(function (t) {
    assert(tables.indexOf(t) !== -1, 'missing table ' + t + ' (have: ' + tables.join(',') + ')');
  });
  const rows = store.db.prepare('select version, node_version, sqlite_version from schema_migrations order by version').all();
  assert(rows.length === MIGRATION_LIST.length, 'one migration row per migration');
  for (const row of rows) {
    assert(row.node_version === process.version, 'node_version recorded on v' + row.version + ', got ' + row.node_version);
    assert(row.sqlite_version === engineInfo().sqliteVersion, 'sqlite_version recorded on v' + row.version + ', got ' + row.sqlite_version);
  }
  const info = store.info();
  assert(info.schema.current === SCHEMA_VERSION && info.schema.tooNew === false && info.schema.historyBroken === false, 'info schema current/tooNew/historyBroken');
  assert(info.search && info.search.table === 'frame_fts' && info.search.modes.length === 5, 'info exposes the P1b search surface');
  assert(info.search.aligned && info.search.aligned.aligned === true, 'info carries the live index alignment (P1c 查询前置)');
  assert(info.artifacts && info.artifacts.table === 'artifacts' && info.artifacts.events === 'artifact_events'
    && info.artifacts.statuses.length === 3 && info.artifacts.actions.length === 4, 'info exposes the P1c artifact surface');
  assert(info.pragmas.foreignKeys === 1, 'foreign_keys should be ON');
  assert(info.pragmas.journalMode === 'wal', 'journal_mode should be wal, got ' + info.pragmas.journalMode);
  assert(info.pragmas.busyTimeout === 5000, 'busy_timeout should be 5000, got ' + info.pragmas.busyTimeout);
  assert(store.migrate().applied.length === 0, 'second migrate is a no-op');
  store.close();
});

// ── T4 同 session 跨 source 同 seq 并存 ───────────────────────────────────
test('T4 same session, two sources, same seq coexist without seq equivalence', () => {
  const store = freshStore('t4');
  const dshFramePath = DSH_ROOT + '/session-aaa/frames.jsonl';
  const v4FramePath = V4_ROOT + '/session-aaa/frames.jsonl';
  const a = store.ingest(frameRecord({ source: dshSource(), seq: 5, rawPath: dshFramePath, text: 'from dsh' }));
  const b = store.ingest(frameRecord({ source: v4Source(), seq: 5, rawPath: v4FramePath, text: 'from v4 mirror' }));
  assert(a.status === 'inserted' && b.status === 'inserted', 'both inserts land');
  assert(a.ptr === 'log:session-aaa#seq=5', 'dsh ptr, got ' + a.ptr);
  assert(b.ptr === 'v4log:session-aaa#seq=5', 'v4 ptr, got ' + b.ptr);
  assert(a.ptr !== b.ptr, 'ptrs must differ');
  assert(store.countFrames() === 2, 'two frame rows');
  const ra = store.resolvePtr(a.ptr);
  const rb = store.resolvePtr(b.ptr);
  assert(ra.rawPath === dshFramePath, 'log ptr resolves to dsh path, got ' + ra.rawPath);
  assert(rb.rawPath === v4FramePath, 'v4log ptr resolves to mirror path, got ' + rb.rawPath);
  assert(ra.authority === 'primary' && rb.authority === 'mirror', 'authority kept per source');
  assert(ra.rawPathDrift === false && rb.rawPathDrift === false, 'no drift when source did not move');
  assert(store.listFrames({ sessionId: 'session-aaa' }).length === 2, 'both visible under one session id');
  store.close();
});

// ── T5 同 source 幂等 ────────────────────────────────────────────────────
test('T5 same source + same seq + same hash is a strict no-op', () => {
  const store = freshStore('t5');
  const first = store.ingest(frameRecord({ seq: 3, text: 'same body' }));
  const before = store.listFrames()[0];
  const second = store.ingest(frameRecord({ seq: 3, text: 'same body', cursor: { tailOffset: 999, fileFingerprint: FP_A } }));
  assert(first.status === 'inserted', 'first insert');
  assert(second.status === 'noop', 'second is noop, got ' + second.status);
  assert(second.rawPathDrift === false, 'no path drift');
  assert(second.frameOrdinalDrift === false, 'no ordinal drift');
  assert(store.countFrames() === 1, 'still one row');
  const after = store.listFrames()[0];
  assert(after.indexedAt === before.indexedAt, 'indexed_at untouched on noop');
  assert(store.getCursor('dsh-home', 'session:session-aaa') === null, 'noop must not write the cursor (whole tx rolled back)');
  store.close();
});

// ── T6 异 hash 冲突 ──────────────────────────────────────────────────────
test('T6 same ptr with different hash raises INDEX_CONFLICT and never overwrites', () => {
  const store = freshStore('t6');
  store.ingest(frameRecord({ seq: 7, text: 'original' }));
  const err = assertCode(function () {
    store.ingest(frameRecord({ seq: 7, text: 'mutated' }));
  }, CODES.INDEX_CONFLICT, 'conflicting replay');
  assert(err.details.existingHash === hashFrame('original'), 'conflict reports existing hash');
  assert(err.details.incomingHash === hashFrame('mutated'), 'conflict reports incoming hash');
  const row = store.resolvePtr('log:session-aaa#seq=7');
  assert(row.contentHash === hashFrame('original'), 'stored hash unchanged');
  assert(row.snippet === 'original', 'snippet unchanged, got ' + row.snippet);
  assert(store.countFrames() === 1, 'no extra row');
  store.close();
});

// ── T7 事务回滚 ──────────────────────────────────────────────────────────
test('T7 failure after the frame insert rolls the whole ingest back', () => {
  const store = freshStore('t7');
  store.db.exec("CREATE TRIGGER boom BEFORE INSERT ON sync_cursors BEGIN SELECT RAISE(ABORT, 'injected cursor failure'); END");
  let caught = null;
  try {
    store.ingest(frameRecord({ seq: 2, text: 'should not survive', cursor: { tailOffset: 10, fileFingerprint: FP_A } }));
  } catch (err) {
    caught = err;
  }
  assert(caught !== null, 'ingest must throw when the cursor write fails');
  assert(String(caught.message).indexOf('injected cursor failure') !== -1, 'the original sqlite error must surface, got: ' + caught.message);
  assert(store.countFrames() === 0, 'the frame inserted before the failure must be rolled back, got ' + store.countFrames());
  assert(store.db.prepare('select count(*) as n from sessions').get().n === 0, 'the session insert must be rolled back too');
  assert(store.db.prepare('select count(*) as n from sources').get().n === 0, 'the source insert must be rolled back too');
  assert(store.db.prepare('select count(*) as n from sync_cursors').get().n === 0, 'no cursor row');
  assert(store.db.prepare('select count(*) as n from frame_index').get().n === 0, 'frame_index empty');
  store.close();
});

// ── T8 cursor 尾偏移 / 指纹 / reset ──────────────────────────────────────
test('T8 cursor keeps frame_ordinal/tail_offset/fingerprint; reset allows rebuild', () => {
  const store = freshStore('t8');
  store.ingest(frameRecord({
    seq: 0, frameOrdinal: 0, text: 'f0',
    cursor: { tailOffset: 128, fileFingerprint: FP_A, tailState: 'open' },
  }));
  const c1 = store.getCursor('dsh-home', 'session:session-aaa');
  assert(c1.tailOffset === 128, 'tailOffset stored, got ' + c1.tailOffset);
  assert(c1.tailState === 'open', 'open tail means a half frame is pending');
  assert(c1.fileFingerprint === FP_A, 'fingerprint stored');
  assert(c1.fingerprintKind === 'hex64', 'a v4-written fingerprint is reported as hex64');
  assert(c1.frameOrdinal === 0, 'frameOrdinal stored');
  assert(c1.nextSeq === 1, 'nextSeq defaults to seq + 1');

  store.ingest(frameRecord({
    seq: 1, frameOrdinal: 1, text: 'f1',
    cursor: { tailOffset: 256, fileFingerprint: FP_A, tailState: 'closed' },
  }));
  const c2 = store.getCursor('dsh-home', 'session:session-aaa');
  assert(c2.tailOffset === 256, 'tailOffset advances on the same file');
  assert(c2.frameOrdinal === 1, 'frameOrdinal advances');
  assert(c2.tailState === 'closed', 'tail closes when the file ends on a frame boundary');

  // 换文件 + 显式 reset：允许按新来源位置重建（C3）。
  store.ingest(frameRecord({
    seq: 2, frameOrdinal: 2, text: 'f2',
    cursor: { tailOffset: 64, fileFingerprint: FP_B, reset: true, tailState: 'open' },
  }));
  const c3 = store.getCursor('dsh-home', 'session:session-aaa');
  assert(c3.tailOffset === 64, 'reset allows a backward tail_offset, got ' + c3.tailOffset);
  assert(c3.fileFingerprint === FP_B, 'reset adopts the new fingerprint');
  assert(c3.nextSeq === 3, 'nextSeq still advances');
  store.close();
});

// ── T9 ptr 解析（当前 source 根 + 相对路径 + ordinal） ───────────────────
test('T9 ptr resolves through current source root + relative path + frame_ordinal', () => {
  const store = freshStore('t9');
  const framePath = DSH_ROOT + '/session-aaa/frames.jsonl';
  store.ingest(frameRecord({ seq: 12, frameOrdinal: 4, rawPath: framePath }));
  const row = store.resolvePtr('log:session-aaa#seq=12');
  assert(row.namespace === 'log', 'namespace');
  assert(row.sessionId === 'session-aaa', 'sessionId');
  assert(row.seq === 12, 'seq');
  assert(row.rawPath === framePath, 'resolved path = current source root + rel path, got ' + row.rawPath);
  assert(row.rawPathAtIngest === framePath, 'ingest-time evidence kept verbatim');
  assert(row.rawRelPath === 'session-aaa/frames.jsonl', 'relative path recorded, got ' + row.rawRelPath);
  assert(row.frameOrdinal === 4, 'frame_ordinal is the read position inside the file');
  assert(row.ptr === 'log:session-aaa#seq=12', 'ptr echoed');
  const parsed = parsePtr('v4log:session-bbb#seq=0');
  assert(parsed.namespace === 'v4log' && parsed.sessionId === 'session-bbb' && parsed.seq === 0, 'parsePtr fields');
  assert(makePtr('log', 'session-bbb', 0) === 'log:session-bbb#seq=0', 'makePtr round-trip');
  assertCode(function () { store.resolvePtr('log:session-aaa#seq=999'); }, CODES.PTR_NOT_FOUND, 'unknown seq');
  assertCode(function () { store.resolvePtr('nope:session-aaa#seq=1'); }, CODES.PTR_UNKNOWN_NAMESPACE, 'unknown namespace');
  assertCode(function () { store.resolvePtr('garbage'); }, CODES.PTR_MALFORMED, 'malformed ptr');
  store.close();
});

// ── T10 重开 ─────────────────────────────────────────────────────────────
test('T10 data survives close + reopen (WAL, no re-migrate needed)', () => {
  const path = dbPath('t10');
  const s1 = openStore({ path, mode: 'readwrite' });
  s1.migrate();
  s1.ingest(frameRecord({ seq: 1, text: 'persisted' }));
  s1.close();

  const s2 = openStore({ path, mode: 'readwrite' });
  assert(s2.state.ready === true, 'schema still ready after reopen');
  assert(s2.countFrames() === 1, 'frame row survived');
  const row = s2.resolvePtr('log:session-aaa#seq=1');
  assert(row.snippet === 'persisted', 'content survived');
  assert(s2.getCursor('dsh-home', 'session:session-aaa') === null, 'no cursor was written (none supplied)');
  s2.close();
});

// ── T11 非法输入 ─────────────────────────────────────────────────────────
test('T11 invalid input is rejected before touching the db', () => {
  const store = freshStore('t11');
  const cases = [
    ['negative seq', function () { store.ingest(frameRecord({ seq: -1 })); }],
    ['non-integer seq', function () { store.ingest(frameRecord({ seq: 1.5 })); }],
    ['seq beyond ptr range', function () { store.ingest(frameRecord({ seq: MAX_PTR_SEQ + 1 })); }],
    ['empty sessionId', function () { store.ingest({ source: dshSource(), session: { sessionId: '' }, frame: { seq: 0, frameOrdinal: 0, text: 'x' } }); }],
    ['sessionId with #', function () { store.ingest(frameRecord({ sessionId: 'a#b' })); }],
    ['bad authority', function () { store.ingest({ source: dshSource({ authority: 'root' }), session: { sessionId: 's' }, frame: { seq: 0, frameOrdinal: 0, text: 'x' } }); }],
    ['log namespace with mirror authority', function () { store.ingest({ source: dshSource({ authority: 'mirror' }), session: { sessionId: 's' }, frame: { seq: 0, frameOrdinal: 0, text: 'x' } }); }],
    ['primary authority outside log', function () { store.ingest({ source: v4Source({ authority: 'primary' }), session: { sessionId: 's' }, frame: { seq: 0, frameOrdinal: 0, text: 'x' } }); }],
    ['unknown kind', function () { store.ingest({ source: dshSource({ kind: 'random' }), session: { sessionId: 's' }, frame: { seq: 0, frameOrdinal: 0, text: 'x' } }); }],
    ['log namespace with v4-mirror kind', function () { store.ingest({ source: dshSource({ kind: 'v4-mirror' }), session: { sessionId: 's' }, frame: { seq: 0, frameOrdinal: 0, text: 'x' } }); }],
    ['short hash', function () { store.ingest({ source: dshSource(), session: { sessionId: 's' }, frame: { seq: 0, frameOrdinal: 0, contentHash: 'abc' } }); }],
    ['non-hex hash', function () { store.ingest({ source: dshSource(), session: { sessionId: 's' }, frame: { seq: 0, frameOrdinal: 0, contentHash: 'z'.repeat(64) } }); }],
    ['frame without hash or text', function () { store.ingest({ source: dshSource(), session: { sessionId: 's' }, frame: { seq: 0, frameOrdinal: 0 } }); }],
    ['missing frame', function () { store.ingest({ source: dshSource(), session: { sessionId: 's' } }); }],
    ['bad tailState', function () { store.ingest(frameRecord({ cursor: { tailState: 'half' } })); }],
    ['negative tailOffset', function () { store.ingest(frameRecord({ cursor: { tailOffset: -5 } })); }],
    ['bad eventAt type', function () { store.ingest({ source: dshSource(), session: { sessionId: 's' }, frame: { seq: 0, frameOrdinal: 0, text: 'x', eventAt: 42 } }); }],
  ];
  for (const c of cases) {
    assertCode(c[1], CODES.INVALID_INPUT, c[0]);
  }
  assert(store.countFrames() === 0, 'no row created by invalid input, got ' + store.countFrames());
  assert(store.db.prepare('select count(*) as n from sources').get().n === 0, 'no source row created either');
  store.close();
});

// ── T12 只读模式不自动迁移 ───────────────────────────────────────────────
test('T12 readonly store never migrates', () => {
  const path = dbPath('t12');
  writeFileSync(path, '', 'utf8');
  const sizeBefore = statSync(path).size;
  const ro = openStore({ path, mode: 'readonly' });
  assert(ro.state.ready === false, 'readonly fresh db is not ready');
  assertCode(function () { ro.resolvePtr('log:session-aaa#seq=0'); }, CODES.MIGRATION_REQUIRED, 'read on unmigrated readonly');
  assertCode(function () { ro.migrate(); }, CODES.READONLY, 'migrate on readonly');
  assert(statSync(path).size === sizeBefore, 'readonly open did not grow the file');
  const tables = ro.db.prepare("select name from sqlite_master where type='table'").all();
  assert(tables.length === 0, 'no table created by readonly open, got ' + tables.map(function (t) { return t.name; }).join(','));
  ro.close();
});

// ── T13 checksum 篡改 ────────────────────────────────────────────────────
test('T13 tampered migration sql is caught by checksum', () => {
  const path = dbPath('t13');
  const store = openStore({ path, mode: 'readwrite' });
  store.migrate();
  store.close();

  const tamper = function (version) {
    return MIGRATIONS.map(function (m) {
      return m.version === version
        ? { version: m.version, name: m.name, sql: m.sql + '\n-- tampered' }
        : { version: m.version, name: m.name, sql: m.sql };
    });
  };
  for (const version of MIGRATION_LIST.map(function (m) { return m.version; })) {
    const db = new DatabaseSync(path);
    try {
      assertCode(function () { migrate(db, { migrations: tamper(version) }); }, CODES.MIGRATION_CHECKSUM_MISMATCH, 'tampered v' + version + ' sql');
    } finally {
      db.close();
    }
  }
});

// ── T14 库比代码新（写路径） ─────────────────────────────────────────────
test('T14 database newer than code is refused on the write path (no silent downgrade)', () => {
  const path = dbPath('t14');
  const store = openStore({ path, mode: 'readwrite' });
  store.migrate();
  store.db.exec('UPDATE schema_migrations SET version = 99 WHERE version = 2');
  store.close();

  const db = new DatabaseSync(path);
  try {
    assertCode(function () { migrate(db); }, CODES.SCHEMA_TOO_NEW, 'too new');
  } finally {
    db.close();
  }
});

// ── T15 C1：source 改名后旧 ptr 仍可回取（当前路径） ─────────────────────
test('T15 C1: old ptr follows source rename; frame raw_path stays as evidence with drift flag', () => {
  const store = freshStore('t15');
  const oldPath = DSH_ROOT + '/session-aaa/frames.jsonl';
  store.ingest(frameRecord({ seq: 0, frameOrdinal: 3, rawPath: oldPath, text: 'before move' }));

  const before = store.resolvePtr('log:session-aaa#seq=0');
  assert(before.rawPath === oldPath, 'before rename: old path, got ' + before.rawPath);
  assert(before.rawPathDrift === false, 'no drift before rename');

  // 改名/搬目录：同一 source_id，新 raw_path；新帧带新路径。
  const newRoot = 'D:/AI/new-mirror/sessions';
  const newPath = newRoot + '/session-aaa/frames.jsonl';
  store.ingest(frameRecord({ source: dshSource({ rawPath: newRoot }), seq: 1, rawPath: newPath, text: 'after move' }));

  const oldPtr = store.resolvePtr('log:session-aaa#seq=0');
  assert(oldPtr.rawPath === newPath, 'C1: renamed source + old ptr must resolve to the NEW path, got ' + oldPtr.rawPath);
  assert(oldPtr.rawPathAtIngest === oldPath, 'C1: ingest-time evidence preserved, got ' + oldPtr.rawPathAtIngest);
  assert(oldPtr.rawPathDrift === true, 'C1: drift is visible');
  assert(oldPtr.relocatable === true, 'C1: frame is relocatable');
  assert(oldPtr.frameOrdinal === 3, 'C1: ordinal is the read position inside the file');

  const rawRow = store.db.prepare('select raw_path, raw_rel_path from frame_index where seq = 0').get();
  assert(rawRow.raw_path === oldPath, 'C1: frame_index.raw_path is NOT rewritten (evidence only)');
  assert(rawRow.raw_rel_path === 'session-aaa/frames.jsonl', 'C1: stored rel path');

  // no-op 重放同一帧时，漂移要显式可见，且 ordinal 漂移不再静默。
  const replay = store.ingest(frameRecord({ source: dshSource({ rawPath: newRoot }), seq: 0, frameOrdinal: 9, rawPath: newPath, text: 'before move' }));
  assert(replay.status === 'noop', 'C1: replay is noop');
  assert(replay.rawPathDrift === true, 'C1: noop reports path drift after rename');
  assert(replay.frameOrdinalDrift === true, 'C1: noop reports ordinal drift (0 vs 9) instead of hiding it');
  store.close();
});

// ── T16 C2：库层约束（直插必须失败，合法行必须通过） ────────────────────
test('T16 C2: SQL layer rejects log + v4-mirror + mirror; legal log = dsh-log + primary passes', () => {
  const store = freshStore('t16');
  const now = '2026-11-09T00:00:00.000Z';
  const insertSource = store.db.prepare(
    'INSERT INTO sources (source_id, kind, namespace, authority, raw_path, path_kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );

  // 直插：namespace=log + kind=v4-mirror + authority=mirror —— 必须在 SQL 层失败。
  let caught = null;
  try {
    insertSource.run('rogue', 'v4-mirror', 'log', 'mirror', 'D:/rogue', 'dir', now, now);
  } catch (err) {
    caught = err;
  }
  assert(caught !== null, 'C2: direct insert of log/v4-mirror/mirror must fail at the SQL layer');
  assert(String(caught.message).indexOf('META_LOG_NAMESPACE_RESERVED') !== -1, 'C2: trigger message, got ' + (caught && caught.message));

  // 直插：namespace 非 log 但 authority=primary —— 也必须在 SQL 层失败。
  let caught2 = null;
  try {
    insertSource.run('rogue2', 'v4-mirror', 'v4log2', 'primary', 'D:/rogue2', 'dir', now, now);
  } catch (err) {
    caught2 = err;
  }
  assert(caught2 !== null, 'C2: primary outside log must fail at the SQL layer');

  // 合法行：log + dsh-log + primary 通过。
  insertSource.run('legal', 'dsh-log', 'log', 'primary', DSH_ROOT, 'dir', now, now);
  assert(store.db.prepare("select count(*) as n from sources where namespace = 'log'").get().n === 1, 'C2: legal log source landed');

  // 帧的 authority 必须与 source 一致（跨列约束，CHECK 表达不了）。
  store.db.prepare(
    'INSERT INTO sessions (source_id, session_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)',
  ).run('legal', 's1', now, now);
  let caught3 = null;
  try {
    store.db.prepare(
      'INSERT INTO frame_index (source_id, session_id, seq, raw_path, raw_rel_path, frame_ordinal, authority, ptr, snippet, snippet_truncated, content_hash, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('legal', 's1', 0, DSH_ROOT + '/s1/frames.jsonl', 's1/frames.jsonl', 0, 'mirror', 'log:s1#seq=0', '', 0, 'a'.repeat(64), now);
  } catch (err) {
    caught3 = err;
  }
  assert(caught3 !== null, 'C2: frame authority mismatch must fail at the SQL layer');
  assert(String(caught3.message).indexOf('META_FRAME_AUTHORITY_MISMATCH') !== -1, 'C2: frame trigger message, got ' + (caught3 && caught3.message));

  // UPDATE 通道同样被封：把合法 log source 改成 mirror 必须失败。
  let caught4 = null;
  try {
    store.db.prepare("UPDATE sources SET authority = 'mirror' WHERE source_id = 'legal'").run();
  } catch (err) {
    caught4 = err;
  }
  assert(caught4 !== null, 'C2: UPDATE that would break the log invariants must fail');
  store.close();
});

// ── T17 C3：指纹变化必须整笔拒绝，不得混合新旧 ─────────────────────────
test('T17 C3: fingerprint change without reset is rejected whole; reset rebuilds', () => {
  const store = freshStore('t17');
  store.ingest(frameRecord({
    seq: 0, frameOrdinal: 0, text: 'file A frame',
    cursor: { tailOffset: 999, frameOrdinal: 0, fileFingerprint: FP_A, tailState: 'closed' },
  }));

  // 换文件（指纹变）却没 reset → SOURCE_FINGERPRINT_CHANGED，且整笔不落。
  const err = assertCode(function () {
    store.ingest(frameRecord({
      seq: 1, frameOrdinal: 1, text: 'file B frame',
      cursor: { tailOffset: 10, frameOrdinal: 1, fileFingerprint: FP_B, tailState: 'closed' },
    }));
  }, CODES.SOURCE_FINGERPRINT_CHANGED, 'fingerprint change without reset');
  assert(err.details.previousFingerprint === FP_A && err.details.incomingFingerprint === FP_B, 'C3: both fingerprints reported');
  assert(store.countFrames() === 1, 'C3: the frame must NOT be inserted, got ' + store.countFrames());
  const cursor = store.getCursor('dsh-home', 'session:session-aaa');
  assert(cursor.fileFingerprint === FP_A, 'C3: fingerprint stayed on file A, got ' + cursor.fileFingerprint);
  assert(cursor.tailOffset === 999, 'C3: tail_offset stayed with file-A, got ' + cursor.tailOffset);
  assert(cursor.nextSeq === 1, 'C3: next_seq did not advance');
  assert(store.db.prepare('select count(*) as n from frame_index where seq = 1').get().n === 0, 'C3: no partial row');
  assert(store.db.prepare('select count(*) as n from sessions').get().n === 1, 'C3: session touch rolled back with the rest');

  // 显式 reset 才允许按新来源位置重建。
  store.ingest(frameRecord({
    seq: 1, frameOrdinal: 0, text: 'file B frame',
    cursor: { tailOffset: 10, frameOrdinal: 0, fileFingerprint: FP_B, reset: true, tailState: 'closed' },
  }));
  const rebuilt = store.getCursor('dsh-home', 'session:session-aaa');
  assert(rebuilt.fileFingerprint === FP_B, 'C3: reset adopts file B identity');
  assert(rebuilt.tailOffset === 10, 'C3: reset adopts the new offset, got ' + rebuilt.tailOffset);
  assert(store.countFrames() === 2, 'C3: after reset the frame lands');
  store.close();
});

// ── T18 C4：snippet 统一 4096 上限 + 显式截断标记 ───────────────────────
test('T18 C4: snippet is capped at 4096 with snippet_truncated; oversized snippet never rejects the frame', () => {
  assert(SNIPPET_MAX === 4096, 'SNIPPET_MAX is 4096');
  const store = freshStore('t18');
  const longSnippet = 'x'.repeat(4097);
  const res = store.ingest(frameRecord({
    seq: 0, text: 'the canonical body', snippet: longSnippet,
  }));
  assert(res.status === 'inserted', 'C4: 4097-char snippet must not reject the frame');
  assert(res.snippetTruncated === true, 'C4: truncation is reported in the ingest result');
  const row = store.resolvePtr('log:session-aaa#seq=0');
  assert(row.snippet.length === 4096, 'C4: stored snippet length 4096, got ' + row.snippet.length);
  assert(row.snippet === 'x'.repeat(4096), 'C4: stored snippet is the first 4096 chars');
  assert(row.snippetTruncated === true, 'C4: snippet_truncated persisted');
  assert(row.contentHash === hashFrame('the canonical body'), 'C4: content_hash is over the original canonical body, not the truncated snippet');
  assert(row.contentHash !== hashFrame(row.snippet), 'C4: hash of snippet differs — truncated text must never stand in for the full hash');

  // 默认路径（从 text 派生）与显式路径同一条上限，不再有 280 / 4096 两种相反行为。
  const body = 'y'.repeat(5000);
  const res2 = store.ingest(frameRecord({ seq: 1, text: body }));
  const row2 = store.resolvePtr('log:session-aaa#seq=1');
  assert(row2.snippet.length === 4096, 'C4: default snippet also capped at 4096, got ' + row2.snippet.length);
  assert(row2.snippetTruncated === true, 'C4: default path marks truncation too');
  assert(row2.contentHash === hashFrame(body), 'C4: default path hashes the full body');

  const short = store.ingest(frameRecord({ seq: 2, text: 'short body' }));
  assert(short.snippetTruncated === false, 'C4: short text is not marked truncated');
  const row3 = store.resolvePtr('log:session-aaa#seq=2');
  assert(row3.snippet === 'short body' && row3.snippetTruncated === false, 'C4: short snippet intact');
  assert(capSnippet('z'.repeat(10)).truncated === false, 'C4: capSnippet helper agrees');
  store.close();
});

// ── T19 C5：type / event_at 字段 ─────────────────────────────────────────
test('T19 C5: frame_index carries type and event_at alongside the original fields', () => {
  const store = freshStore('t19');
  const res = store.ingest(frameRecord({ seq: 0, text: 'typed frame', type: 'user', eventAt: '2026-11-09T01:02:03.000Z' }));
  assert(res.status === 'inserted', 'insert with type/event_at');
  const row = store.resolvePtr('log:session-aaa#seq=0');
  assert(row.type === 'user', 'type stored, got ' + row.type);
  assert(row.eventAt === '2026-11-09T01:02:03.000Z', 'event_at stored, got ' + row.eventAt);
  const plain = store.ingest(frameRecord({ seq: 1, text: 'untyped frame' }));
  assert(plain.status === 'inserted', 'insert without type/event_at still works');
  const row2 = store.resolvePtr('log:session-aaa#seq=1');
  assert(row2.type === null && row2.eventAt === null, 'type/event_at default to null');

  const cols = store.db.prepare('PRAGMA table_info(frame_index)').all().map(function (c) { return c.name; });
  ['source_id', 'session_id', 'seq', 'raw_path', 'frame_ordinal', 'authority', 'ptr', 'snippet', 'content_hash', 'indexed_at', 'raw_rel_path', 'type', 'event_at', 'snippet_truncated'].forEach(function (c) {
    assert(cols.indexOf(c) !== -1, 'C5: missing frame_index column ' + c + ' (have ' + cols.join(',') + ')');
  });
  store.close();
});

// ── T20 C6：ptr 规范形状与 seq 范围一致 ─────────────────────────────────
test('T20 C6: non-canonical seq (leading zeros) is rejected; seq range matches ptr range', () => {
  const store = freshStore('t20');
  store.ingest(frameRecord({ seq: 1, text: 'canonical one' }));

  assertCode(function () { parsePtr('log:session-aaa#seq=0000000000001'); }, CODES.PTR_MALFORMED, 'leading zeros');
  assertCode(function () { parsePtr('log:session-aaa#seq=01'); }, CODES.PTR_MALFORMED, 'leading zero (short)');
  assertCode(function () { store.resolvePtr('log:session-aaa#seq=01'); }, CODES.PTR_MALFORMED, 'resolvePtr with leading zero');
  assertCode(function () { makePtr('log', 'session-aaa', MAX_PTR_SEQ + 1); }, CODES.PTR_MALFORMED, 'makePtr beyond range');
  assertCode(function () { parsePtr('log:session-aaa#seq=1000000000000000'); }, CODES.PTR_MALFORMED, '16-digit seq');
  assert(parsePtr('log:session-aaa#seq=0').seq === 0, 'seq 0 parses');
  assert(parsePtr('log:session-aaa#seq=' + MAX_PTR_SEQ).seq === MAX_PTR_SEQ, 'max seq parses');
  assert(makePtr('log', 'session-aaa', MAX_PTR_SEQ) === 'log:session-aaa#seq=' + MAX_PTR_SEQ, 'makePtr at max');
  assert(parsePtr('log:session-aaa#seq=1').seq === 1 && makePtr('log', 'session-aaa', 1) === 'log:session-aaa#seq=1', 'canonical round-trip');
  store.close();
});

// ── T21 C8：库比代码新 —— 读路径也必须是 SCHEMA_TOO_NEW ──────────────────
test('T21 C8: too-new database reports SCHEMA_TOO_NEW on read paths too (no misleading MIGRATION_REQUIRED)', () => {
  const path = dbPath('t21');
  const writer = openStore({ path, mode: 'readwrite' });
  writer.migrate();
  writer.ingest(frameRecord({ seq: 0, text: 'v2 data' }));
  writer.db.exec('UPDATE schema_migrations SET version = 99 WHERE version = 2');
  writer.close();

  const rw = openStore({ path, mode: 'readwrite' });
  assert(rw.state.tooNew === true && rw.state.ready === false, 'state reports tooNew');
  assertCode(function () { rw.resolvePtr('log:session-aaa#seq=0'); }, CODES.SCHEMA_TOO_NEW, 'read on too-new db');
  assertCode(function () { rw.getCursor('dsh-home', 'session:session-aaa'); }, CODES.SCHEMA_TOO_NEW, 'getCursor on too-new db');
  assertCode(function () { rw.ingest(frameRecord({ seq: 1, text: 'x' })); }, CODES.SCHEMA_TOO_NEW, 'write on too-new db');
  assertCode(function () { rw.migrate(); }, CODES.SCHEMA_TOO_NEW, 'migrate on too-new db');
  rw.close();

  const ro = openStore({ path, mode: 'readonly' });
  assertCode(function () { ro.resolvePtr('log:session-aaa#seq=0'); }, CODES.SCHEMA_TOO_NEW, 'readonly read on too-new db');
  ro.close();
});

// ── T22 v1 库 → v2 迁移：老数据不丢、checksum/版本记录齐 ─────────────────
test('T22 v1 database migrates to v2: old rows survive, backfill works, records complete', () => {
  const path = dbPath('t22');
  const OLD_ROOT = 'D:/old/sessions';

  // 造一个真正的 v1 库（只应用 v1 迁移），用 v1 的列写入老数据。
  const v1db = new DatabaseSync(path);
  v1db.exec('PRAGMA journal_mode = WAL');
  try {
    const r = migrate(v1db, { migrations: [MIGRATIONS[0]], targetVersion: 1 });
    assert(r.applied.length === 1 && r.applied[0].version === 1, 'v1 applied only');
    const now = '2026-11-08T00:00:00.000Z';
    v1db.prepare('INSERT INTO sources (source_id, kind, namespace, authority, raw_path, path_kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('dsh-home', 'dsh-log', 'log', 'primary', OLD_ROOT, 'dir', now, now);
    v1db.prepare('INSERT INTO sessions (source_id, session_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)')
      .run('dsh-home', 'session-old', now, now);
    v1db.prepare('INSERT INTO frame_index (source_id, session_id, seq, raw_path, frame_ordinal, authority, ptr, snippet, content_hash, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('dsh-home', 'session-old', 0, OLD_ROOT + '/session-old/frames.jsonl', 2, 'primary', 'log:session-old#seq=0', 'old snippet', hashFrame('old body'), now);
    v1db.prepare('INSERT INTO sync_cursors (source_id, stream_key, session_id, next_seq, frame_ordinal, tail_offset, file_fingerprint, tail_state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('dsh-home', 'session:session-old', 'session-old', 1, 2, 512, 'file-old', 'closed', now);
  } finally {
    v1db.close();
  }

  const store = openStore({ path, mode: 'readwrite' });
  assert(store.state.current === 1 && store.state.ready === false, 'starts as a v1 db');
  assert(store.state.tooNew === false, 'v1 is not too new');
  const res = store.migrate();
  assert(res.applied.map(function (m) { return m.version; }).join(',') === '2,3,4,5', 'v2 -> v3 -> v4 -> v5 are applied, got ' + JSON.stringify(res.applied));
  assert(store.state.current === SCHEMA_VERSION && store.state.ready === true, 'now at SCHEMA_VERSION and ready');

  const rows = store.db.prepare('select version, name, checksum, node_version, sqlite_version from schema_migrations order by version').all();
  assert(rows.length === MIGRATION_LIST.length, 'one migration record per migration');
  for (const row of rows) {
    assert(/^[0-9a-f]{64}$/.test(row.checksum), 'v' + row.version + ' checksum recorded');
    assert(row.node_version === process.version, 'v' + row.version + ' node version recorded');
    assert(row.sqlite_version === engineInfo().sqliteVersion, 'v' + row.version + ' sqlite version recorded');
  }
  assert(rows[1].checksum === res.applied[0].checksum, 'v2 checksum matches what code computes');
  assert(rows[2].checksum === res.applied[1].checksum, 'v3 checksum matches what code computes');
  assert(rows[3].checksum === res.applied[2].checksum, 'v4 checksum matches what code computes');

  // 老数据不丢：帧、snippet、hash、ordinal、游标都在。
  // P1b：v4 回填把老帧也建了 FTS 行（rowid 与 frame_index.rowid 对齐）。
  const info = store.searchIndexInfo();
  assert(info.aligned === true && info.ftsRows === 1, 'P1b: v4 backfilled the legacy frame into frame_fts: ' + JSON.stringify(info));
  assert(store.search('old snippet').results.length === 1, 'P1b: a legacy frame is findable right after the migration');
  const old = store.resolvePtr('log:session-old#seq=0');
  assert(old.snippet === 'old snippet', 'old snippet survived, got ' + old.snippet);
  assert(old.contentHash === hashFrame('old body'), 'old content_hash survived');
  assert(old.frameOrdinal === 2, 'old frame_ordinal survived');
  assert(old.rawPath === OLD_ROOT + '/session-old/frames.jsonl', 'before rename resolves to old root, got ' + old.rawPath);
  assert(old.rawPathAtIngest === OLD_ROOT + '/session-old/frames.jsonl', 'evidence kept');
  assert(old.rawRelPath === 'session-old/frames.jsonl', 'v3 backfill produced the runtime rel path, got ' + old.rawRelPath);
  const cursor = store.getCursor('dsh-home', 'session:session-old');
  assert(cursor.tailOffset === 512 && cursor.fileFingerprint === 'file-old', 'old cursor survived');

  // 迁移回填的相对路径真的可用：改名后旧 ptr 走新根。
  const NEW_ROOT = 'D:/new/sessions';
  store.ingest(frameRecord({
    source: dshSource({ rawPath: NEW_ROOT }), sessionId: 'session-old', seq: 1,
    rawPath: NEW_ROOT + '/session-old/frames.jsonl', text: 'new frame after move',
  }));
  const moved = store.resolvePtr('log:session-old#seq=0');
  assert(moved.rawPath === NEW_ROOT + '/session-old/frames.jsonl', 'C1: migrated old row follows the rename, got ' + moved.rawPath);
  assert(moved.rawPathDrift === true, 'C1: migrated row reports drift');
  store.close();
});

// ── T23 新 v2 库与迁移库行为一致 ─────────────────────────────────────────
test('T23 fresh v2 db and migrated v1 db behave identically', () => {
  const fresh = freshStore('t23-fresh');
  const migratedPath = dbPath('t23-migrated');
  const v1db = new DatabaseSync(migratedPath);
  v1db.exec('PRAGMA journal_mode = WAL');
  try {
    migrate(v1db, { migrations: [MIGRATIONS[0]], targetVersion: 1 });
  } finally {
    v1db.close();
  }
  const migrated = openStore({ path: migratedPath, mode: 'readwrite' });
  migrated.migrate();

  const schemaOf = function (store) {
    return {
      frameCols: store.db.prepare('PRAGMA table_info(frame_index)').all().map(function (c) { return c.name + ':' + c.type + ':' + c.notnull + ':' + c.dflt_value; }),
      triggers: store.db.prepare("select name, sql from sqlite_master where type = 'trigger' order by name").all(),
      indexes: store.db.prepare("select name from sqlite_master where type = 'index' and sql is not null order by name").all(),
      tables: store.db.prepare("select name from sqlite_master where type = 'table' order by name").all(),
      ftsCols: store.db.prepare('PRAGMA table_info(frame_fts)').all().map(function (c) { return c.name; }),
    };
  };
  const a = schemaOf(fresh);
  const b = schemaOf(migrated);
  assert(JSON.stringify(a.frameCols) === JSON.stringify(b.frameCols), 'same frame_index columns');
  // P1c：5 条既有护栏 + 2 条「产物事件只追加」= 7。数字写在这里是有意的：
  // 迁移再向前走时，这一行必须被显式改成新数字，而不是悄悄跟着变。
  assert(a.triggers.length === b.triggers.length && a.triggers.length === 7, 'same seven triggers (v2 guards + v4 relocation audit + 2 append-only guards), got ' + a.triggers.length);
  assert(JSON.stringify(a.triggers) === JSON.stringify(b.triggers), 'same trigger definitions');
  assert(JSON.stringify(a.indexes) === JSON.stringify(b.indexes), 'same indexes');
  assert(JSON.stringify(a.tables) === JSON.stringify(b.tables), 'same tables (incl. frame_fts + its shadow tables)');
  assert(JSON.stringify(a.ftsCols) === JSON.stringify(b.ftsCols), 'same frame_fts columns: ' + JSON.stringify(a.ftsCols));

  const run = function (store) {
    store.ingest(frameRecord({ seq: 0, text: 'same body', type: 'assistant', eventAt: '2026-11-09T00:00:00.000Z', cursor: { tailOffset: 32, fileFingerprint: FP_A } }));
    store.ingest(frameRecord({ seq: 1, text: 'z'.repeat(5000) }));
    const r = store.resolvePtr('log:session-aaa#seq=0');
    return {
      rawPath: r.rawPath, relPath: r.rawRelPath, type: r.type, eventAt: r.eventAt,
      snippetLen: store.resolvePtr('log:session-aaa#seq=1').snippet.length,
      truncated: store.resolvePtr('log:session-aaa#seq=1').snippetTruncated,
      cursor: store.getCursor('dsh-home', 'session:session-aaa'),
      count: store.countFrames(),
    };
  };
  const ra = run(fresh);
  const rb = run(migrated);
  const scrub = function (v) { const c = Object.assign({}, v.cursor); delete c.updatedAt; return Object.assign({}, v, { cursor: c }); };
  assert(JSON.stringify(scrub(ra)) === JSON.stringify(scrub(rb)), 'same behavior\nfresh: ' + JSON.stringify(scrub(ra)) + '\nmigrated: ' + JSON.stringify(scrub(rb)));
  fresh.close();
  migrated.close();
});

// ── T24 并发写：busy 映射成稳定错误码 ────────────────────────────────────
test('T24 concurrent write surfaces STORE_BUSY (not a bare sqlite Error)', () => {
  const path = dbPath('t24');
  const a = openStore({ path, mode: 'readwrite' });
  a.migrate();
  const b = openStore({ path, mode: 'readwrite', timeoutMs: 150 });
  a.db.exec('BEGIN IMMEDIATE');
  try {
    const err = assertCode(function () {
      b.ingest(frameRecord({ seq: 0, text: 'blocked writer' }));
    }, CODES.STORE_BUSY, 'second writer while the first holds the write lock');
    assert(err.details && err.details.sqliteErrcode === 5, 'C8: sqlite busy errcode kept, got ' + JSON.stringify(err.details));
  } finally {
    a.db.exec('ROLLBACK');
    b.close();
    a.close();
  }
});

// ── T25 临时目录边界（本次所有库都在 tempRoot 下，收尾时删除） ───────────
test('T25 all test databases stay under the single temp root', () => {
  const files = readdirSync(tempRoot);
  assert(files.length > 0, 'temp dbs exist while running');
  for (const f of files) {
    const p = join(tempRoot, f);
    assert(p.startsWith(tempRoot), 'path outside tempRoot: ' + p);
  }
  assert(tempRoot.indexOf(tmpdir()) === 0, 'tempRoot is under os.tmpdir()');
  console.log('      ' + files.length + ' files under ' + tempRoot);
});

// ── T26 指纹 helper（O3/D2 之外的契约件；阻塞 P1b） ───────────────────────
test('T26 fingerprint: append-stable, first-frame-sensitive, size/mtime forbidden, null when no first frame', () => {
  const parserVersion = 'v4-frame-1';
  const sessionId = 'session-aaa';
  const first = '{"seq":0,"text":"hello"}';
  const fp1 = makeStreamFingerprint({ parserVersion, sessionId, firstCompleteFrame: first });
  const fp2 = makeStreamFingerprint({ parserVersion, sessionId, firstCompleteFrame: first });
  assert(fp1 === fp2, 'a normal append (same first frame) must not change the fingerprint');
  assert(/^[0-9a-f]{64}$/.test(fp1), 'fingerprint is 64 lowercase hex, got ' + fp1);
  const manual = createHash('sha256')
    .update(parserVersion, 'utf8').update('\u0000', 'utf8')
    .update(sessionId, 'utf8').update('\u0000', 'utf8')
    .update(first, 'utf8').digest('hex');
  assert(fp1 === manual, 'formula is sha256(parserVersion NUL sessionId NUL firstCompleteFrame)');
  const rotated = makeStreamFingerprint({ parserVersion, sessionId, firstCompleteFrame: '{"seq":0,"text":"rotated"}' });
  assert(rotated !== fp1, 'a different first frame means a different stream identity');
  assert(makeStreamFingerprint({ parserVersion: 'v4-frame-2', sessionId, firstCompleteFrame: first }) !== fp1, 'parserVersion participates');
  assert(makeStreamFingerprint({ parserVersion, sessionId, firstCompleteFrame: null }) === null, 'no first frame => null (identity not established), never a free string');
  assert(makeStreamFingerprint({ parserVersion, sessionId, firstCompleteFrame: undefined }) === null, 'undefined first frame => null');
  assertCode(function () { makeStreamFingerprint({ parserVersion, sessionId, firstCompleteFrame: '' }); }, CODES.INVALID_INPUT, 'empty first frame is not an identity');
  assertCode(function () { makeStreamFingerprint({ parserVersion, sessionId, firstCompleteFrame: first, size: 1234 }); }, CODES.INVALID_INPUT, 'size is forbidden');
  assertCode(function () { makeStreamFingerprint({ parserVersion, sessionId, firstCompleteFrame: first, mtime: '2026-11-09T00:00:00Z' }); }, CODES.INVALID_INPUT, 'mtime is forbidden');
  assertCode(function () { makeStreamFingerprint({ parserVersion, sessionId, firstCompleteFrame: first, bytes: 99 }); }, CODES.INVALID_INPUT, 'bytes is forbidden');

  // 串到 cursor 上：首帧不变时正常追加推进；轮转才被拒。
  const store = freshStore('t26');
  const fa = makeStreamFingerprint({ parserVersion, sessionId, firstCompleteFrame: first });
  store.ingest(frameRecord({ seq: 0, frameOrdinal: 0, text: 'hello', cursor: { tailOffset: 10, fileFingerprint: fa } }));
  const fb = makeStreamFingerprint({ parserVersion, sessionId, firstCompleteFrame: first });
  assert(fa === fb, 'second append still sees the same identity');
  store.ingest(frameRecord({ seq: 1, frameOrdinal: 1, text: 'world', cursor: { tailOffset: 30, fileFingerprint: fb } }));
  assert(store.getCursor('dsh-home', 'session:session-aaa').tailOffset === 30, 'append with the same fingerprint advances the cursor (no false SOURCE_FINGERPRINT_CHANGED)');
  const rotatedFp = makeStreamFingerprint({ parserVersion, sessionId, firstCompleteFrame: 'rotated' });
  assertCode(function () {
    store.ingest(frameRecord({ seq: 2, text: 'x', cursor: { fileFingerprint: rotatedFp } }));
  }, CODES.SOURCE_FINGERPRINT_CHANGED, 'a rotated file is still detected');
  store.close();
});

// ── T27 D1：v1 → v2 → v3，Windows 反斜杠路径必须回填成功 ──────────────────
test('T27 D1: v1 db with Windows backslash paths is repaired by v3 and follows a rename', () => {
  const path = dbPath('t27');
  const OLD_ROOT = 'D:\\AI\\old\\sessions';
  const FRAME = 'D:\\AI\\old\\sessions\\session-w\\frames.jsonl';
  const NEW_ROOT = 'E:\\mirror\\sessions';
  const NEW_FRAME = 'E:\\mirror\\sessions\\session-w\\frames.jsonl';
  const v1db = new DatabaseSync(path);
  v1db.exec('PRAGMA journal_mode = WAL');
  try {
    migrate(v1db, { migrations: [MIGRATIONS[0]], targetVersion: 1 });
    const now = '2026-11-08T00:00:00.000Z';
    v1db.prepare('INSERT INTO sources (source_id, kind, namespace, authority, raw_path, path_kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('dsh-home', 'dsh-log', 'log', 'primary', OLD_ROOT, 'dir', now, now);
    v1db.prepare('INSERT INTO sessions (source_id, session_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)')
      .run('dsh-home', 'session-w', now, now);
    v1db.prepare('INSERT INTO frame_index (source_id, session_id, seq, raw_path, frame_ordinal, authority, ptr, snippet, content_hash, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('dsh-home', 'session-w', 0, FRAME, 1, 'primary', 'log:session-w#seq=0', 'legacy backslash', hashFrame('legacy backslash'), now);
  } finally {
    v1db.close();
  }

  const store = openStore({ path, mode: 'readwrite' });
  assert(store.state.current === 1 && store.state.ready === false, 'starts as v1');
  const res = store.migrate();
  assert(res.applied.map(function (m) { return m.version; }).join(',') === '2,3,4,5', 'v1 -> v2 -> v3 -> v4 -> v5, got ' + JSON.stringify(res.applied));
  assert(store.state.current === SCHEMA_VERSION && store.state.ready === true, 'now at SCHEMA_VERSION and ready');
  const step = res.postSteps.filter(function (s) { return s.version === 3; })[0];
  assert(step && step.result.scanned === 1 && step.result.normalized === 1, 'v3 post-step recomputed the backslash row: ' + JSON.stringify(step && step.result));
  const ftsStep = res.postSteps.filter(function (s) { return s.version === 4; })[0];
  assert(ftsStep && ftsStep.result.scanned === 1 && ftsStep.result.inserted === 1, 'v4 post-step indexed the legacy row: ' + JSON.stringify(ftsStep && ftsStep.result));

  const raw = store.db.prepare('select raw_rel_path from frame_index where seq = 0').get();
  assert(raw.raw_rel_path === 'session-w/frames.jsonl', 'backslash path becomes a posix rel path, got ' + JSON.stringify(raw.raw_rel_path));

  const beforeMove = store.resolvePtr('log:session-w#seq=0');
  assert(beforeMove.rawPath === FRAME, 'before rename resolves through root + rel, got ' + beforeMove.rawPath);
  assert(beforeMove.relocatable === true && beforeMove.rawPathDrift === false, 'no drift before the rename');

  store.ingest(frameRecord({
    source: dshSource({ rawPath: NEW_ROOT }), sessionId: 'session-w', seq: 1,
    rawPath: NEW_FRAME, text: 'after move',
  }));
  const moved = store.resolvePtr('log:session-w#seq=0');
  assert(moved.rawPath === NEW_FRAME, 'migrated backslash row follows the rename, got ' + moved.rawPath);
  assert(moved.relocatable === true && moved.rawPathDrift === true, 'relocatable + drift after the rename');
  assert(moved.rawPathAtIngest === FRAME, 'ingest-time evidence preserved verbatim');
  assert(moved.contentHash === hashFrame('legacy backslash'), 'content hash unchanged');
  store.close();
});

// ── T28 D1：v2 → v3 单独修复（v2 的纯 SQL 回填是错的） ────────────────────
test('T28 D1: a v2 db (SQL-only backfill) is repaired by v3, including backslashes in relative paths', () => {
  const path = dbPath('t28');
  const OLD_ROOT = 'D:\\AI\\old2\\sessions';
  const ABS = 'D:\\AI\\old2\\sessions\\session-w\\frames.jsonl';
  const REL_BACKSLASH = 'session-x\\frames.jsonl';
  const v2db = new DatabaseSync(path);
  v2db.exec('PRAGMA journal_mode = WAL');
  try {
    migrate(v2db, { migrations: [MIGRATIONS[0], MIGRATIONS[1]], targetVersion: 2 });
    const now = '2026-11-08T00:00:00.000Z';
    v2db.prepare('INSERT INTO sources (source_id, kind, namespace, authority, raw_path, path_kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('dsh-home', 'dsh-log', 'log', 'primary', OLD_ROOT, 'dir', now, now);
    v2db.prepare('INSERT INTO sessions (source_id, session_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)')
      .run('dsh-home', 'session-w', now, now);
    v2db.prepare('INSERT INTO sessions (source_id, session_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)')
      .run('dsh-home', 'session-x', now, now);
    // 这两行是 v2 纯 SQL 回填会留下的形状：绝对反斜杠 → NULL；相对反斜杠 → 原样保留反斜杠。
    v2db.prepare('INSERT INTO frame_index (source_id, session_id, seq, raw_path, raw_rel_path, frame_ordinal, authority, ptr, snippet, snippet_truncated, content_hash, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('dsh-home', 'session-w', 0, ABS, null, 0, 'primary', 'log:session-w#seq=0', 'v2 null', 0, hashFrame('v2 null'), now);
    v2db.prepare('INSERT INTO frame_index (source_id, session_id, seq, raw_path, raw_rel_path, frame_ordinal, authority, ptr, snippet, snippet_truncated, content_hash, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('dsh-home', 'session-x', 1, REL_BACKSLASH, REL_BACKSLASH, 0, 'primary', 'log:session-x#seq=1', 'v2 backslash rel', 0, hashFrame('v2 backslash rel'), now);
  } finally {
    v2db.close();
  }

  const store = openStore({ path, mode: 'readwrite' });
  assert(store.state.current === 2 && store.state.ready === false, 'starts as v2');
  const before = store.db.prepare('select seq, raw_rel_path from frame_index order by seq').all();
  assert(before[0].raw_rel_path === null && before[1].raw_rel_path === REL_BACKSLASH, 'v2 state reproduces the D1 defect: ' + JSON.stringify(before));
  const res = store.migrate();
  assert(res.applied.map(function (m) { return m.version; }).join(',') === '3,4,5', 'v3 -> v4 -> v5 apply');
  const fixed = store.db.prepare('select seq, raw_rel_path from frame_index order by seq').all();
  assert(fixed[0].raw_rel_path === 'session-w/frames.jsonl', 'absolute backslash row repaired, got ' + JSON.stringify(fixed[0].raw_rel_path));
  assert(fixed[1].raw_rel_path === 'session-x/frames.jsonl', 'relative backslash row normalized to posix, got ' + JSON.stringify(fixed[1].raw_rel_path));
  assert(store.resolvePtr('log:session-w#seq=0').relocatable === true, 'absolute row is now relocatable');
  assert(store.resolvePtr('log:session-x#seq=1').relocatable === true, 'relative row is now relocatable');
  assert(store.searchIndexInfo().aligned === true && store.searchIndexInfo().ftsRows === 2, 'P1b: both repaired rows are searchable');
  store.close();
});

// ── T29 D2：根外帧 ingest 必须拒收，且不写任何表 ─────────────────────────
test('T29 D2: ingest refuses a frame outside source.rawPath and writes no table rows', () => {
  const store = freshStore('t29');
  const err = assertCode(function () {
    store.ingest(frameRecord({ rawPath: 'E:/elsewhere/frames.jsonl', text: 'outside' }));
  }, CODES.PATH_OUTSIDE_SOURCE_ROOT, 'absolute path outside the root');
  assert(err.details.frameRawPath === 'E:/elsewhere/frames.jsonl', 'frame path reported');
  assert(err.details.sourceRawPath === DSH_ROOT, 'source root reported');
  assertCode(function () {
    store.ingest(frameRecord({ rawPath: '../escape/frames.jsonl', text: 'escape' }));
  }, CODES.PATH_OUTSIDE_SOURCE_ROOT, 'relative path escaping the root with ..');
  ['sources', 'sessions', 'frame_index', 'sync_cursors'].forEach(function (t) {
    assert(store.db.prepare('select count(*) as n from ' + t).get().n === 0, 'D2: no rows in ' + t);
  });
  // 反斜杠根下的合法帧不受影响：判定看的是相对关系，不是分隔符。
  const ok = store.ingest(frameRecord({
    source: dshSource({ rawPath: 'D:\\AI\\dsh\\home\\sessions' }),
    rawPath: 'D:\\AI\\dsh\\home\\sessions\\session-aaa\\frames.jsonl',
    text: 'inside',
  }));
  assert(ok.status === 'inserted', 'frame under a backslash root is accepted');
  assert(ok.relocatable === true && ok.rawPathDrift === false, 'accepted frame is relocatable without false drift');
  assert(store.db.prepare('select raw_rel_path from frame_index where seq = 1').get().raw_rel_path === 'session-aaa/frames.jsonl', 'stored rel path is posix');
  store.close();
});

// ── T30 D2：历史根外帧改名后必须是 stale，不能假通过；P6 口径 ──────────────
test('T30 D2: a legacy out-of-root frame reports relocatable:false + drift:true after rename; P6 samples must be relocatable', () => {
  const store = freshStore('t30');
  store.ingest(frameRecord({ seq: 0, rawPath: DSH_ROOT + '/session-aaa/frames.jsonl', text: 'in-root body' }));
  // 历史遗留：v1/v2 允许库里存在根外帧（今天的 ingest 已拒收），用直插模拟。
  store.db.prepare('INSERT INTO frame_index (source_id, session_id, seq, raw_path, raw_rel_path, frame_ordinal, authority, ptr, snippet, snippet_truncated, content_hash, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('dsh-home', 'session-aaa', 1, 'E:/elsewhere/frames.jsonl', null, 0, 'primary', 'log:session-aaa#seq=1', 'legacy out of root', 0, hashFrame('legacy out of root'), '2026-11-08T00:00:00.000Z');
  const beforeRow = store.db.prepare('select raw_rel_path from frame_index where seq = 1').get();
  assert(beforeRow.raw_rel_path === null, 'legacy row has no rel path (not relocatable)');

  store.db.prepare('UPDATE sources SET raw_path = ? WHERE source_id = ?').run('D:\\AI\\moved\\sessions', 'dsh-home');

  const stale = store.resolvePtr('log:session-aaa#seq=1');
  assert(stale.relocatable === false, 'out-of-root frame is not relocatable');
  assert(stale.rawPathDrift === true, 'D2: a frame that cannot be relocated must not report "no drift"');
  assert(stale.relocation === 'none', 'relocation mode is explicit');
  assert(stale.rawPath === 'E:/elsewhere/frames.jsonl', 'evidence path returned but flagged as stale');

  const good = store.resolvePtr('log:session-aaa#seq=0');
  assert(good.relocatable === true && good.rawPathDrift === true, 'P6 acceptance: sample must be relocatable');
  assert(good.rawPath === 'D:\\AI\\moved\\sessions\\session-aaa\\frames.jsonl', 'relocated path, got ' + good.rawPath);
  assert(good.contentHash === hashFrame('in-root body'), 'P6 acceptance: hash is unchanged after the rename');
  store.close();
});

// ── T31 O1：迁移史缺行 = 不 ready，读写都报 MIGRATION_HISTORY_BROKEN ────────
test('T31 O1: deleting a migration row breaks readiness instead of silently reporting current=2 ready=true', () => {
  const path = dbPath('t31');
  const writer = openStore({ path, mode: 'readwrite' });
  writer.migrate();
  writer.ingest(frameRecord({ seq: 0, text: 'v3 data' }));
  writer.db.exec('DELETE FROM schema_migrations WHERE version = 1');
  writer.close();

  const store = openStore({ path, mode: 'readwrite' });
  assert(store.state.current === SCHEMA_VERSION, 'last row is still the newest version, got ' + store.state.current);
  assert(store.state.ready === false, 'O1: ready must be false when the applied history is not contiguous');
  assert(store.state.historyBroken === true, 'O1: historyBroken flag');
  assert(store.state.history.missing.indexOf(1) !== -1, 'O1: missing version reported: ' + JSON.stringify(store.state.history));
  assertCode(function () { store.resolvePtr('log:session-aaa#seq=0'); }, CODES.MIGRATION_HISTORY_BROKEN, 'read path');
  assertCode(function () { store.ingest(frameRecord({ seq: 1, text: 'y' })); }, CODES.MIGRATION_HISTORY_BROKEN, 'write path');
  assertCode(function () { store.migrate(); }, CODES.MIGRATION_HISTORY_BROKEN, 'migrate path');
  store.close();

  const ro = openStore({ path, mode: 'readonly' });
  assert(ro.state.ready === false && ro.state.historyBroken === true, 'readonly state also broken');
  assertCode(function () { ro.resolvePtr('log:session-aaa#seq=0'); }, CODES.MIGRATION_HISTORY_BROKEN, 'readonly read path');
  ro.close();
});

// ── T32 O2：旧库非法行迁移前必须先验后拒，不得原样带入 ─────────────────────
test('T32 O2: a v1 db with illegal legacy rows is refused with LEGACY_CONSTRAINT_VIOLATION and stays at v1', () => {
  const path = dbPath('t32');
  const OLD_ROOT = 'D:/poisoned/sessions';
  const v1db = new DatabaseSync(path);
  v1db.exec('PRAGMA journal_mode = WAL');
  try {
    migrate(v1db, { migrations: [MIGRATIONS[0]], targetVersion: 1 });
    const now = '2026-11-08T00:00:00.000Z';
    // v1 没有触发器：log + v4-mirror + mirror 在 v1 是合法的（O2 的原始形状）。
    v1db.prepare('INSERT INTO sources (source_id, kind, namespace, authority, raw_path, path_kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('poisoned', 'v4-mirror', 'log', 'mirror', OLD_ROOT, 'dir', now, now);
    v1db.prepare('INSERT INTO sessions (source_id, session_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)')
      .run('poisoned', 'session-p', now, now);
    v1db.prepare('INSERT INTO frame_index (source_id, session_id, seq, raw_path, frame_ordinal, authority, ptr, snippet, content_hash, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('poisoned', 'session-p', 0, OLD_ROOT + '/session-p/frames.jsonl', 0, 'mirror', 'log:session-p#seq=0', 'poisoned', hashFrame('poisoned'), now);
  } finally {
    v1db.close();
  }

  const store = openStore({ path, mode: 'readwrite' });
  assert(store.state.current === 1 && store.state.ready === false, 'starts as v1');
  const err = assertCode(function () { store.migrate(); }, CODES.LEGACY_CONSTRAINT_VIOLATION, 'migrate an illegal legacy source');
  assert(err.details.violations.length === 1 && err.details.violations[0].source_id === 'poisoned', 'violation reported with the offending row');
  assert(store.state.current === 1 && store.state.ready === false, 'O2: migration did not advance — nothing carried into the new schema');
  assert(store.db.prepare('select count(*) as n from schema_migrations').get().n === 1, 'v2/v3 rows were not written');
  const kept = store.db.prepare("select kind, namespace, authority from sources where source_id = 'poisoned'").get();
  assert(kept.namespace === 'log' && kept.kind === 'v4-mirror', 'the row is untouched: we refuse to migrate, we do not rewrite evidence');
  store.close();

  // 第二形状：source 合法，但帧的 authority 与 source 不一致（跨表约束只在 v2 之后成立）。
  const path2 = dbPath('t32b');
  const v1db2 = new DatabaseSync(path2);
  v1db2.exec('PRAGMA journal_mode = WAL');
  try {
    migrate(v1db2, { migrations: [MIGRATIONS[0]], targetVersion: 1 });
    const now = '2026-11-08T00:00:00.000Z';
    v1db2.prepare('INSERT INTO sources (source_id, kind, namespace, authority, raw_path, path_kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('v4-mirror', 'v4-mirror', 'v4log', 'mirror', 'D:/v4/mirror', 'dir', now, now);
    v1db2.prepare('INSERT INTO sessions (source_id, session_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)')
      .run('v4-mirror', 'session-q', now, now);
    v1db2.prepare('INSERT INTO frame_index (source_id, session_id, seq, raw_path, frame_ordinal, authority, ptr, snippet, content_hash, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('v4-mirror', 'session-q', 0, 'D:/v4/mirror/session-q/frames.jsonl', 0, 'primary', 'v4log:session-q#seq=0', 'mismatch', hashFrame('mismatch'), now);
  } finally {
    v1db2.close();
  }
  const store2 = openStore({ path: path2, mode: 'readwrite' });
  const err2 = assertCode(function () { store2.migrate(); }, CODES.LEGACY_CONSTRAINT_VIOLATION, 'migrate a frame whose authority disagrees with its source');
  assert(err2.details.violations.length === 1 && err2.details.violations[0].authority === 'primary', 'frame violation reported');
  store2.close();
});

// ── T33 O3：checksum(sql) 与 migrationDigest 是两个口径 ────────────────
test('T33 O3: checksum(sql) and migrationDigest are different functions; schema_migrations stores the digest', () => {
  const store = freshStore('t33');
  const v1 = MIGRATIONS[0];
  const sqlOnly = checksum(v1.sql);
  const digest = migrationDigest(v1);
  assert(/^[0-9a-f]{64}$/.test(sqlOnly) && /^[0-9a-f]{64}$/.test(digest), 'both values are 64 lowercase hex');
  assert(sqlOnly !== digest, 'the two checksum definitions must not be conflated');
  const row = store.db.prepare('select checksum from schema_migrations where version = 1').get();
  assert(row.checksum === digest, 'schema_migrations stores migrationDigest(version + name + sql)');
  assert(row.checksum !== sqlOnly, 'it does not store checksum(sql)');
  store.close();
});

// ── T34 v3 幂等：再迁移是 no-op，回填结果不被改写 ─────────────────────────
test('T34 v3 is idempotent: a second migrate is a no-op and leaves normalized rel paths untouched', () => {
  const path = dbPath('t34');
  const OLD_ROOT = 'D:\\AI\\idem\\sessions';
  const FRAME = 'D:\\AI\\idem\\sessions\\session-w\\frames.jsonl';
  const v1db = new DatabaseSync(path);
  v1db.exec('PRAGMA journal_mode = WAL');
  try {
    migrate(v1db, { migrations: [MIGRATIONS[0]], targetVersion: 1 });
    const now = '2026-11-08T00:00:00.000Z';
    v1db.prepare('INSERT INTO sources (source_id, kind, namespace, authority, raw_path, path_kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('dsh-home', 'dsh-log', 'log', 'primary', OLD_ROOT, 'dir', now, now);
    v1db.prepare('INSERT INTO sessions (source_id, session_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)')
      .run('dsh-home', 'session-w', now, now);
    v1db.prepare('INSERT INTO frame_index (source_id, session_id, seq, raw_path, frame_ordinal, authority, ptr, snippet, content_hash, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('dsh-home', 'session-w', 0, FRAME, 0, 'primary', 'log:session-w#seq=0', 'idem', hashFrame('idem'), now);
  } finally {
    v1db.close();
  }
  const store = openStore({ path, mode: 'readwrite' });
  const first = store.migrate();
  // v5 没有回填步骤，所以「两条 post-step」仍然成立，只是 applied 多了一条 v5。
  assert(first.applied.length === 4 && first.postSteps.length === 2, 'v2/v3/v4/v5 with two post-steps (rel-path normalize + fts backfill; v5 adds none)');
  const snapshot = JSON.stringify(store.db.prepare('select source_id, session_id, seq, raw_path, raw_rel_path from frame_index order by seq').all());
  const second = store.migrate();
  assert(second.applied.length === 0 && second.postSteps.length === 0, 'second migrate is a no-op');
  assert(JSON.stringify(store.db.prepare('select source_id, session_id, seq, raw_path, raw_rel_path from frame_index order by seq').all()) === snapshot, 'no row was rewritten by the no-op');
  store.close();
});


// ═══ P1b ═════════════════════════════════════════════════════════════════
// ── T35 v4：frame_fts 表结构、分词器口径、rowid 对齐 ─────────────────────
test('T35 P1b/v4: frame_fts exists with bigram-shaped search_text, raw shadow column and rowid aligned to frame_index', () => {
  const store = freshStore('t35');
  const sql = store.db.prepare("select sql from sqlite_master where type = 'table' and name = 'frame_fts'").get();
  assert(sql && typeof sql.sql === 'string', 'frame_fts is a virtual table in sqlite_master');
  assert(sql.sql.indexOf('fts5') !== -1, 'frame_fts uses fts5');
  assert(sql.sql.indexOf('unicode61') !== -1, 'tokenizer is unicode61 (no CJK tokenizer pretends to be a general solution)');
  assert(sql.sql.indexOf('remove_diacritics 0') !== -1, 'diacritics are not stripped — tokens must round-trip exactly');
  const cols = store.db.prepare('PRAGMA table_info(frame_fts)').all().map(function (c) { return c.name; });
  ['search_text', 'raw_text', 'ptr', 'source_id', 'session_id', 'seq'].forEach(function (c) {
    assert(cols.indexOf(c) !== -1, 'frame_fts column ' + c + ' (have ' + cols.join(',') + ')');
  });

  // 变换只有一个实现：写入侧（ingest/回填）与查询侧都走 buildSearchText。
  const built = buildSearchText('六层解耦机制');
  assert(built.searchText === '六层 层解 解耦 耦机 机制', 'CJK overlapping bigrams, got ' + built.searchText);
  assert(buildSearchText('解耦').searchText === '解耦', 'two-char CJK yields exactly one bigram');
  assert(buildSearchText('墨').searchText === '', 'a single CJK char yields no bigram (degrades to substring, by design)');
  assert(buildSearchText('Decouple V4').searchText === 'decouple v4', 'ASCII words are lowercased whole words');

  const r = store.ingest(frameRecord({ seq: 0, text: '六层解耦机制' }));
  assert(r.status === 'inserted' && r.ftsTokens === 5, 'ingest reports the FTS row it wrote, got ' + r.ftsTokens);
  const info = store.searchIndexInfo();
  assert(info.frames === 1 && info.ftsRows === 1 && info.aligned === true, 'FTS row count follows frame_index: ' + JSON.stringify(info));
  const ftsRow = store.db.prepare('select rowid as rid, search_text from frame_fts').get();
  const frameRow = store.db.prepare("select rowid as rid from frame_index where ptr = 'log:session-aaa#seq=0'").get();
  assert(ftsRow.rid === frameRow.rid, 'frame_fts.rowid equals frame_index.rowid, got ' + ftsRow.rid + ' vs ' + frameRow.rid);
  store.close();
});

// ── T36 同一事务：帧 + FTS + 游标；noop 不叠行；冲突不写 ─────────────────
test('T36 P1b: frame + FTS + cursor land in one transaction; replay is noop and never duplicates FTS rows', () => {
  const store = freshStore('t36');
  store.ingest(frameRecord({
    seq: 0, frameOrdinal: 0, text: '第一帧：解耦哨兵', cursor: { tailOffset: 40, fileFingerprint: FP_A },
  }));
  store.ingest(frameRecord({
    seq: 1, frameOrdinal: 1, text: '第二帧：墨迹未干', cursor: { tailOffset: 80, fileFingerprint: FP_A },
  }));
  assert(store.searchIndexInfo().aligned === true, 'both frames have FTS rows');
  assert(store.getCursor('dsh-home', 'session:session-aaa').tailOffset === 80, 'cursor advanced in the same transactions');

  // 重放同一帧：no-op 整笔回滚 —— FTS 行数不能变、游标不能动。
  const replay = store.ingest(frameRecord({
    seq: 1, frameOrdinal: 1, text: '第二帧：墨迹未干', cursor: { tailOffset: 999, fileFingerprint: FP_A },
  }));
  assert(replay.status === 'noop', 'replay is noop');
  assert(store.searchIndexInfo().ftsRows === 2, 'noop did not duplicate the FTS row, got ' + store.searchIndexInfo().ftsRows);
  assert(store.db.prepare('select count(*) as n from frame_fts').get().n === 2, 'raw FTS row count stays 2');
  assert(store.getCursor('dsh-home', 'session:session-aaa').tailOffset === 80, 'noop did not advance the cursor');

  // 异 hash 冲突：同样不写 FTS。
  assertCode(function () { store.ingest(frameRecord({ seq: 1, text: '改了内容' })); }, CODES.INDEX_CONFLICT, 'conflicting replay');
  assert(store.db.prepare('select count(*) as n from frame_fts').get().n === 2, 'conflict wrote no FTS row');

  // 命中：解耦/哨兵/墨 都能从刚写的两帧里找回来。
  assert(store.search('解耦').results[0].ptr === 'log:session-aaa#seq=0', 'first frame found by 解耦');
  assert(store.search('哨兵').results[0].ptr === 'log:session-aaa#seq=0', 'first frame found by 哨兵');
  assert(store.search('墨').results[0].ptr === 'log:session-aaa#seq=1', 'single char 墨 found by substring fallback');
  store.close();
});

// ── T37 回滚：帧插入之后失败，FTS 行也必须一起回滚 ────────────────────────
test('T37 P1b: a failure after the frame insert rolls back the FTS row too (no orphan index entries)', () => {
  const store = freshStore('t37');
  store.db.exec("CREATE TRIGGER boom_fts BEFORE INSERT ON sync_cursors BEGIN SELECT RAISE(ABORT, 'injected cursor failure'); END");
  let caught = null;
  try {
    store.ingest(frameRecord({ seq: 2, text: '不该留下', cursor: { tailOffset: 10, fileFingerprint: FP_A } }));
  } catch (err) {
    caught = err;
  }
  assert(caught !== null, 'ingest must throw');
  assert(store.db.prepare('select count(*) as n from frame_index').get().n === 0, 'frame rolled back');
  assert(store.db.prepare('select count(*) as n from frame_fts').get().n === 0, 'FTS row rolled back with the frame');
  assert(store.db.prepare('select count(*) as n from sources').get().n === 0, 'source rolled back');
  const info = store.searchIndexInfo();
  assert(info.aligned === true && info.ftsRows === 0, 'index and table are both empty and aligned');
  assert(store.search('不该留下').results.length === 0, 'nothing is searchable after a rollback');
  store.close();
});

// ── T38 中文硬样例：解耦 / 哨兵 / 墨 / 六层解耦 ──────────────────────────
test('T38 P1b: 解耦 / 哨兵 / 墨 / 六层解耦 all hit the known frame with the right match_mode', () => {
  const store = freshStore('t38');
  store.ingest(frameRecord({ seq: 0, text: '这一夜我们把六层解耦做完，哨兵机制上线，墨迹未干。' }));
  store.ingest(frameRecord({ seq: 1, text: '无关的一帧：缓冲区扩容。' }));
  store.ingest(frameRecord({ seq: 2, text: '另一帧：只有解耦两个字。' }));

  const two = store.search('解耦');
  assert(two.matchMode === 'bigram', 'two-char CJK uses bigram matching, got ' + two.matchMode);
  assert(two.results.length === 2, '解耦 hits frames 0 and 2, got ' + two.results.length);
  // 顺序（bm25）不是不变量，命中集合才是 —— 短文档打分更高，两帧谁在前不该被测死。
  assert(two.results.map(function (r) { return r.ptr; }).sort().join(',') === 'log:session-aaa#seq=0,log:session-aaa#seq=2',
    'both frames found, got ' + JSON.stringify(two.results.map(function (r) { return r.ptr; })));

  const sentinel = store.search('哨兵');
  assert(sentinel.matchMode === 'bigram' && sentinel.results.length === 1, '哨兵 hits exactly one frame');
  assert(sentinel.results[0].ptr === 'log:session-aaa#seq=0', '哨兵 hits frame 0');

  const one = store.search('墨');
  assert(one.matchMode === 'substring', 'single char degrades to substring, got ' + one.matchMode);
  assert(one.results.length === 1 && one.results[0].ptr === 'log:session-aaa#seq=0', '墨 found by raw_text substring');
  assert(one.tokens.length === 0, 'a single CJK char produces no bigram token');
  assert(one.results[0].score === null, 'substring hits carry no bm25 score — they must not be mixed into bigram ranking');

  const four = store.search('六层解耦');
  assert(four.matchMode === 'bigram' && four.tokens.length === 3, 'four chars -> three bigrams, got ' + JSON.stringify(four.tokens));
  assert(four.results.length === 1 && four.results[0].ptr === 'log:session-aaa#seq=0', '六层解耦 hits frame 0');

  assert(store.search('六层解耦机制').results.length === 0, 'a query that spans a non-existent phrase hits nothing');
  assert(store.search('解耦哨兵').results.length === 0, 'bigrams present but not adjacent -> no hit');
  store.close();
});

// ── T39 跨位置假阳性：FTS 候选里有、核实必须杀掉 ─────────────────────────
test('T39 P1b: bigram AND prescreen returns a cross-position candidate; raw substring verification kills it', () => {
  const store = freshStore('t39');
  // 「六层解码后缓冲解耦机制」的 bigram 集：六层 层解 解码 码后 后缓 缓冲 冲解 解耦 耦机 机制
  // 查询「六层解耦」= 六层 ∧ 层解 ∧ 解耦 —— 三片全在，但「六层解耦」这四个字并不连续。
  store.ingest(frameRecord({ seq: 0, text: '六层解码后缓冲解耦机制' }));
  const res = store.search('六层解耦');
  assert(res.candidates >= 1, 'the FTS prescreen DOES return the scattered candidate (this is the trap being tested), got ' + res.candidates);
  assert(res.results.length === 0, 'verification must reject it: got ' + JSON.stringify(res.results.map(function (r) { return r.ptr; })));
  assert(res.verifiedBy === 'raw_text:substring', 'the final authority is announced: ' + res.verifiedBy);

  // 对照：真连续的短语必须命中（否则上面那条就成了「永不命中」）。
  store.ingest(frameRecord({ seq: 1, text: '这里才是真的六层解耦。' }));
  const good = store.search('六层解耦');
  assert(good.results.length === 1 && good.results[0].ptr === 'log:session-aaa#seq=1', 'the contiguous phrase hits only the real one');

  // 再对照：只查 六层 时，两帧都该命中（分片本身是存在的）。
  assert(store.search('六层').results.length === 2, 'the shared bigram alone matches both frames');
  store.close();
});

// ── T40 ASCII / 大小写 / 混合 ─────────────────────────────────────────────
test('T40 P1b: ASCII words, case folding and mixed CJK+ASCII queries have explicit behaviour', () => {
  const store = freshStore('t40');
  store.ingest(frameRecord({ seq: 0, text: 'Decouple v4 哨兵机制 ready' }));
  store.ingest(frameRecord({ seq: 1, text: 'another frame without the word' }));

  const plain = store.search('decouple');
  assert(plain.matchMode === 'token', 'a pure ASCII word uses token matching, got ' + plain.matchMode);
  assert(plain.results.length === 1 && plain.results[0].ptr === 'log:session-aaa#seq=0', 'lowercase query hits mixed-case text');

  const upper = store.search('DECOUPLE');
  assert(upper.results.length === 1, 'uppercase query hits too (case-insensitive on both sides)');

  const v4 = store.search('v4');
  assert(v4.results.length === 1, 'digit-bearing token v4 hits');

  const mixed = store.search('v4 哨兵');
  assert(mixed.matchMode === 'mixed', 'CJK + ASCII is an explicit mode, got ' + mixed.matchMode);
  assert(mixed.results.length === 1, 'mixed query hits when the exact phrase exists: ' + mixed.results.length);
  assert(mixed.tokens.indexOf('v4') !== -1 && mixed.tokens.indexOf('哨兵') !== -1, 'mixed tokens: ' + JSON.stringify(mixed.tokens));

  // 分片都在、但顺序不对 -> 不命中：最终判定是整串子串，不是「所有 token 都出现」。
  const notAdjacent = store.search('哨兵 v4');
  assert(notAdjacent.matchMode === 'mixed' && notAdjacent.results.length === 0, 'mixed query keeps substring semantics (order matters), got ' + notAdjacent.results.length);
  // Decouple v4 之间隔着一个词：整串子串同样不成立。
  assert(store.search('Decouple 哨兵').results.length === 0, 'a query with an absent space-separated phrase hits nothing');

  assert(store.search('missingword').results.length === 0, 'unknown ASCII word hits nothing');
  assert(store.search('装').results.length === 0, 'unknown single CJK char hits nothing');
  store.close();
});

// ── T41 空查询 / 非法查询 / FTS 语法字符 ─────────────────────────────────
test('T41 P1b: empty, illegal and FTS-syntax-bearing queries all have defined behaviour', () => {
  const store = freshStore('t41');
  store.ingest(frameRecord({ seq: 0, text: 'nothing special here' }));

  const empty = store.search('');
  assert(empty.matchMode === 'empty' && empty.results.length === 0 && empty.candidates === 0, 'empty query returns an explicit empty mode');
  assert(store.search('   ').matchMode === 'empty', 'whitespace-only query is empty, not an error');
  assertCode(function () { store.search(42); }, CODES.INVALID_INPUT, 'non-string query');
  assertCode(function () { store.search(null); }, CODES.INVALID_INPUT, 'null query');
  assertCode(function () { store.search(undefined); }, CODES.INVALID_INPUT, 'undefined query');
  assertCode(function () { store.search('x'.repeat(600)); }, CODES.INVALID_INPUT, 'over-long query');

  // FTS5 的语法字符：查询串永远不直接进 MATCH，所以这些输入不会抛 SQL 错误。
  const hostile = ['"', '*', '(', ')', 'AND', 'OR', 'NOT', 'NEAR', 'a AND b', 'x*', '-', ':', '^', '{}', 'a"b'];
  for (const q of hostile) {
    const res = store.search(q);
    assert(Array.isArray(res.results), 'query ' + JSON.stringify(q) + ' returned a result list instead of throwing');
  }
  // FTS5 的关键字（AND / OR / NOT / NEAR）在这里只是普通词：进 MATCH 前已加引号，
  // 所以既不会变成布尔语法，也不会因为「没有左操作数」而报语法错。
  const andOnly = store.search('AND');
  assert(andOnly.matchMode === 'token', 'a lone keyword is treated as a plain word, got ' + andOnly.matchMode);
  assert(andOnly.tokens.join(',') === 'and', 'and it is lowercased like any other word: ' + JSON.stringify(andOnly.tokens));
  assert(andOnly.results.length === 0, 'the keyword hits nothing in a document that does not contain it');

  // LIKE 通配符必须转义：% 和 _ 是普通字符，不是「匹配一切」。
  assert(store.search('%').results.length === 0, '% must not act as a LIKE wildcard (it would match every row)');
  assert(store.search('_').results.length === 0, '_ must not act as a single-char wildcard');
  store.ingest(frameRecord({ seq: 1, text: '进度 50% 完成了' }));
  assert(store.search('50%').results.length === 1, 'a literal % inside a query still matches when the text really contains it');
  store.close();
});

// ── T42 来源搬迁：独立于新帧、旧 ptr 走新根、可审计 ───────────────────────
test('T42 P1b: relocateSource moves the source root without any new frame, old ptrs follow, and every move is audited', () => {
  const store = freshStore('t42');
  const OLD = 'D:/AI/p1b/old-sessions';
  const NEW = 'D:/AI/p1b/new-sessions';
  store.ingest(frameRecord({ source: dshSource({ rawPath: OLD }), seq: 0, rawPath: OLD + '/session-aaa/frames.jsonl', text: '搬迁前的一帧' }));
  assert(store.resolvePtr('log:session-aaa#seq=0').rawPath === OLD + '/session-aaa/frames.jsonl', 'resolves under the old root first');

  // 没有任何新帧，直接搬。
  const moved = store.relocateSource('dsh-home', NEW, OLD);
  assert(moved.status === 'relocated', 'status relocated, got ' + moved.status);
  assert(moved.previousRoot === OLD && moved.newRoot === NEW, 'before/after are both reported');
  assert(moved.expectedMatched === true, 'the caller premise was verified');
  assert(typeof moved.auditId === 'number', 'an audit row id is returned');
  assert(moved.framesTotal === 1 && moved.framesRelocatable === 1 && moved.framesUnresolved === 0, 'counts: ' + JSON.stringify(moved));

  const after = store.resolvePtr('log:session-aaa#seq=0');
  assert(after.rawPath === NEW + '/session-aaa/frames.jsonl', 'old ptr resolves through the NEW root, got ' + after.rawPath);
  assert(after.rawPathAtIngest === OLD + '/session-aaa/frames.jsonl', 'ingest-time evidence is untouched');
  assert(after.rawPathDrift === true && after.relocatable === true, 'drift is visible and the frame is relocatable');
  assert(store.countFrames() === 1, 'relocation wrote no frame');

  // 审计：库层触发器在，且可读。
  const audits = store.listSourceRelocations('dsh-home');
  assert(audits.length === 1, 'exactly one relocation audit row, got ' + audits.length);
  assert(audits[0].oldRoot === OLD && audits[0].newRoot === NEW, 'audit row records both roots');
  assert(audits[0].framesTotal === 1 && audits[0].at && /^\d{4}-\d{2}-\d{2}T/.test(audits[0].at), 'audit row records counts and an ISO timestamp: ' + JSON.stringify(audits[0]));

  // 前提失效：expectedOldRoot 与当前根不符 → 整笔拒绝，根不动、不留审计行。
  const err = assertCode(function () { store.relocateSource('dsh-home', 'D:/AI/p1b/third', OLD); }, CODES.SOURCE_ROOT_MISMATCH, 'stale premise');
  assert(err.details.currentRoot === NEW && err.details.expectedOldRoot === OLD, 'mismatch reports both roots');
  assert(store.listSourceRelocations('dsh-home').length === 1, 'a refused relocation writes no audit row');
  assert(store.resolvePtr('log:session-aaa#seq=0').rawPath === NEW + '/session-aaa/frames.jsonl', 'the refused relocation changed nothing');

  // 幂等：搬到同一个根 → unchanged，不写审计、不改 updated_at。
  const before = store.db.prepare("select updated_at from sources where source_id = 'dsh-home'").get().updated_at;
  const same = store.relocateSource('dsh-home', NEW);
  assert(same.status === 'unchanged' && same.auditId === null, 'same root is a no-op, got ' + same.status);
  assert(store.listSourceRelocations('dsh-home').length === 1, 'unchanged wrote no audit row');
  assert(store.db.prepare("select updated_at from sources where source_id = 'dsh-home'").get().updated_at === before, 'updated_at untouched by a no-op');

  // 未知 source。
  assertCode(function () { store.relocateSource('nope', NEW); }, CODES.SOURCE_NOT_FOUND, 'unknown source');

  // 绕过 API 的手工 UPDATE 也必须留痕（库层触发器，不是 JS 约定）。
  store.db.prepare('UPDATE sources SET raw_path = ? WHERE source_id = ?').run('D:/AI/p1b/manual', 'dsh-home');
  const audits2 = store.listSourceRelocations('dsh-home');
  assert(audits2.length === 2 && audits2[0].newRoot === 'D:/AI/p1b/manual', 'a manual UPDATE is audited by the DB trigger too');
  store.close();
});

// ── T43 P6 验收 helper：可搬迁 + hash 一致 + 文件真的在 ───────────────────
test('T43 P1b: the P6 acceptance helper requires relocatable + canonical hash + an existing resolved rawPath', () => {
  const store = freshStore('t43');
  const root = join(tempRoot, 'p6-src');
  const movedRoot = join(tempRoot, 'p6-moved');
  const relFile = join('session-p6', 'frames.jsonl');
  mkdirSync(join(root, 'session-p6'), { recursive: true });
  writeFileSync(join(root, relFile), '{"seq":0,"text":"六层解耦"}\n', 'utf8');
  mkdirSync(join(movedRoot, 'session-p6'), { recursive: true });
  writeFileSync(join(movedRoot, relFile), '{"seq":0,"text":"六层解耦"}\n', 'utf8');

  const canonical = '{"seq":0,"text":"六层解耦"}';
  store.ingest(frameRecord({
    source: dshSource({ rawPath: root }), seq: 0, rawPath: join(root, relFile), text: canonical,
  }));
  const okBefore = store.verifyPtrSample({ ptr: 'log:session-aaa#seq=0', canonicalText: canonical });
  assert(okBefore.ok === true, 'a freshly indexed, existing, relocatable frame passes: ' + JSON.stringify(okBefore.checks));
  assert(okBefore.relocatable === true && okBefore.checks.hashMatch === true && okBefore.checks.fileExists === true, 'all three criteria true');

  // 搬家（真文件跟着搬）→ 解析到新路径，三条仍然成立。
  store.relocateSource('dsh-home', movedRoot, root);
  const okAfter = store.verifyPtrSample({ ptr: 'log:session-aaa#seq=0', contentHash: okBefore.contentHash });
  assert(okAfter.ok === true, 'after the move the sample still passes');
  assert(okAfter.rawPath === join(movedRoot, relFile), 'resolved through the new root, got ' + okAfter.rawPath);
  assert(okAfter.rawPathDrift === true, 'drift is reported while the sample still passes');

  // 文件不在：即便库层全绿，验收也必须 FAIL。
  rmSync(join(movedRoot, relFile), { force: true });
  const missing = store.verifyPtrSample({ ptr: 'log:session-aaa#seq=0', canonicalText: canonical });
  assert(missing.ok === false, 'a missing file must fail the sample');
  assert(missing.checks.fileExists === false && missing.fileExists === false, 'fileExists is the failing criterion');
  assert(String(missing.reason).indexOf('does not exist') !== -1, 'the reason names the missing path: ' + missing.reason);

  // hash 不一致：也必须 FAIL。
  const wrongHash = store.verifyPtrSample({ ptr: 'log:session-aaa#seq=0', canonicalText: 'another body entirely' });
  assert(wrongHash.ok === false && wrongHash.checks.hashMatch === false, 'a hash mismatch fails even when the file exists');

  // 不可搬迁的帧：FAIL，且理由说的是不可搬迁。
  store.db.prepare('INSERT INTO frame_index (source_id, session_id, seq, raw_path, raw_rel_path, frame_ordinal, authority, ptr, snippet, snippet_truncated, content_hash, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('dsh-home', 'session-aaa', 9, 'E:/elsewhere/frames.jsonl', null, 0, 'primary', 'log:session-aaa#seq=9', 'legacy', 0, hashFrame('legacy'), '2026-11-09T00:00:00.000Z');
  const notReloc = store.verifyPtrSample({ ptr: 'log:session-aaa#seq=9', canonicalText: 'legacy' });
  assert(notReloc.ok === false && notReloc.checks.relocatable === false, 'a non-relocatable frame fails the helper');
  assert(String(notReloc.reason).indexOf('not relocatable') !== -1, 'reason names the criterion: ' + notReloc.reason);

  // 不给期望值 → 直接拒（「拿哈希去跟空气比」不算验收）。
  assertCode(function () { store.verifyPtrSample({ ptr: 'log:session-aaa#seq=0' }); }, CODES.INVALID_INPUT, 'sample without a hash or canonical text');
  store.close();
});

// ── T44 流身份：STREAM_IDENTITY_REQUIRED / 自由字符串 / 只读兼容 ─────────
test('T44 P1b: advancing a cursor requires a 64-hex stream fingerprint; missing identity and free strings are refused while legacy rows stay readable', () => {
  const store = freshStore('t44');
  assert(isStreamFingerprint(FP_A) === true && FP_A.length === 64, 'makeStreamFingerprint output is 64 hex');

  // 首帧身份未建立：整笔拒收，帧不写、游标不动。
  const missing = assertCode(function () {
    store.ingest(frameRecord({ seq: 0, text: '首帧不完整时不该推进游标', cursor: { tailOffset: 64 } }));
  }, CODES.STREAM_IDENTITY_REQUIRED, 'cursor without a fingerprint');
  assert(String(missing.details.hint).indexOf('makeStreamFingerprint') !== -1, 'the error tells the caller how to compute it');
  assert(store.countFrames() === 0, 'no frame written');
  assert(store.getCursor('dsh-home', 'session:session-aaa') === null, 'no cursor written');
  assertCode(function () {
    store.ingest(frameRecord({ seq: 0, text: 'x', cursor: { fileFingerprint: null } }));
  }, CODES.STREAM_IDENTITY_REQUIRED, 'explicit null fingerprint');

  // 自由字符串：拒绝（'unknown' / 'file-A' / 空串 / 大写 hex / 63 位）。
  ['unknown', 'file-A', '', FP_A.toUpperCase(), FP_A.slice(0, 63)].forEach(function (bad) {
    assertCode(function () {
      store.ingest(frameRecord({ seq: 0, text: 'x', cursor: { fileFingerprint: bad } }));
    }, CODES.INVALID_INPUT, 'fingerprint ' + JSON.stringify(bad) + ' must be rejected');
  });
  assert(store.countFrames() === 0, 'none of the rejected writes left a frame');

  // 不传 cursor 是允许的：先收帧、后建身份。
  const noCursor = store.ingest(frameRecord({ seq: 0, text: '先收帧' }));
  assert(noCursor.status === 'inserted', 'a frame without a cursor is accepted');
  assert(store.getCursor('dsh-home', 'session:session-aaa') === null, 'and it writes no cursor');

  // 正常追加：同一流身份推进游标，不需要 reset（游标三要素都跟着走）。
  store.ingest(frameRecord({
    seq: 1, frameOrdinal: 5, text: '正常追加', cursor: { tailOffset: 200, frameOrdinal: 5, fileFingerprint: FP_A, tailState: 'closed' },
  }));
  const c1 = store.getCursor('dsh-home', 'session:session-aaa');
  assert(c1.fileFingerprint === FP_A && c1.fingerprintKind === 'hex64', 'fingerprint stored verbatim as hex64');
  assert(c1.tailOffset === 200 && c1.frameOrdinal === 5, 'tail_offset and frame_ordinal advance together');

  // 首帧变了（文件轮转）：不 reset 就整笔拒，reset 才重建。
  assertCode(function () {
    store.ingest(frameRecord({ seq: 2, text: '轮转后的帧', cursor: { tailOffset: 10, fileFingerprint: FP_B } }));
  }, CODES.SOURCE_FINGERPRINT_CHANGED, 'a rotated first frame without reset');
  const c2 = store.getCursor('dsh-home', 'session:session-aaa');
  assert(c2.fileFingerprint === FP_A && c2.tailOffset === 200, 'the refused rotation changed nothing');
  store.ingest(frameRecord({ seq: 2, text: '轮转后的帧', cursor: { tailOffset: 10, fileFingerprint: FP_B, reset: true } }));
  const c3 = store.getCursor('dsh-home', 'session:session-aaa');
  assert(c3.fileFingerprint === FP_B && c3.tailOffset === 10, 'reset adopts the new identity and the new offset');

  // 历史自由字符串：只读兼容 —— 读得出来、标成 legacy、但新写不接受。
  store.db.prepare('INSERT INTO sync_cursors (source_id, stream_key, session_id, next_seq, frame_ordinal, tail_offset, file_fingerprint, tail_state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('dsh-home', 'session:legacy-stream', 'session-aaa', 7, 3, 512, 'file-old', 'closed', '2026-11-08T00:00:00.000Z');
  const legacy = store.getCursor('dsh-home', 'session:legacy-stream');
  assert(legacy.fileFingerprint === 'file-old', 'the legacy value is still readable');
  assert(legacy.fingerprintKind === 'legacy', 'and it is labelled as legacy, not silently trusted');
  assertCode(function () {
    store.ingest(frameRecord({ seq: 3, text: 'x', cursor: { streamKey: 'session:legacy-stream', fileFingerprint: 'file-old' } }));
  }, CODES.INVALID_INPUT, 'writing the legacy free string back is refused');
  // 换成真指纹 + reset，才允许从旧行过渡到新契约。
  store.ingest(frameRecord({ seq: 3, text: 'x', cursor: { streamKey: 'session:legacy-stream', fileFingerprint: FP_A, reset: true } }));
  assert(store.getCursor('dsh-home', 'session:legacy-stream').fingerprintKind === 'hex64', 'reset upgrades the row to the new contract');
  store.close();
});

// ── T45 检索面修复：rebuildSearchIndex 对齐且幂等 ────────────────────────
test('T45 P1b: the search index can be rebuilt (and rebuilt again) without duplicating rows', () => {
  const store = freshStore('t45');
  store.ingest(frameRecord({ seq: 0, text: '重建索引之前的墨迹' }));
  store.ingest(frameRecord({ seq: 1, text: '解耦相关的一帧' }));
  const before = store.searchIndexInfo();
  assert(before.aligned === true && before.ftsRows === 2, 'index starts aligned: ' + JSON.stringify(before));

  store.db.exec('DELETE FROM frame_fts WHERE rowid = 1');
  const broken = store.searchIndexInfo();
  assert(broken.aligned === false && broken.framesWithoutFts === 1, 'a deleted FTS row is visible as misalignment: ' + JSON.stringify(broken));
  // ★ P1c（P1b 定点验证 O3）：删行之后 search 不再「少一条、但返回成功」——
  //   两条扫描路径都 join frame_fts，静默漏帧的旧行为已被 SEARCH_INDEX_STALE 取代。
  const staleErr = assertCode(function () { store.search('墨迹'); }, CODES.SEARCH_INDEX_STALE, 'search with a missing FTS row');
  assert(staleErr.details && staleErr.details.index && staleErr.details.index.framesWithoutFts === 1,
    'the error carries the counts a caller needs to act: ' + JSON.stringify(staleErr.details));

  const r1 = store.rebuildSearchIndex();
  assert(r1.scanned === 2 && r1.inserted === 2, 'rebuild rewrites every frame: ' + JSON.stringify(r1));
  assert(store.searchIndexInfo().aligned === true, 'aligned again');
  assert(store.search('墨迹').results.length === 1, 'and the frame is searchable again');

  const r2 = store.rebuildSearchIndex();
  assert(r2.inserted === 2, 'rebuild is idempotent in effect');
  assert(store.searchIndexInfo().ftsRows === 2, 'no duplicated FTS rows after two rebuilds, got ' + store.searchIndexInfo().ftsRows);
  store.close();
});


// ── T46 v3→v4 回填与新 v4 库行为一致 ─────────────────────────────────────
test('T46 P1b: a v3 database migrated to v4 searches identically to a fresh v4 database with the same frames', () => {
  const path = dbPath('t46-migrated');
  const ROOT = 'D:/AI/p1b/same-root';
  const frames = [
    { seq: 0, text: '这一夜我们把六层解耦做完，哨兵机制上线，墨迹未干。' },
    { seq: 1, text: 'Decouple v4 哨兵机制 ready' },
    { seq: 2, text: '缓冲区扩容，和前面无关。' },
  ];
  const now = '2026-11-08T00:00:00.000Z';

  // 造一个真正的 v3 库（v1+v2+v3），用 v3 的形状直接写帧。
  const v3db = new DatabaseSync(path);
  v3db.exec('PRAGMA journal_mode = WAL');
  try {
    migrate(v3db, { migrations: [MIGRATION_LIST[0], MIGRATION_LIST[1], MIGRATION_LIST[2]], targetVersion: 3 });
    v3db.prepare('INSERT INTO sources (source_id, kind, namespace, authority, raw_path, path_kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('dsh-home', 'dsh-log', 'log', 'primary', ROOT, 'dir', now, now);
    v3db.prepare('INSERT INTO sessions (source_id, session_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)')
      .run('dsh-home', 'session-aaa', now, now);
    const ins = v3db.prepare('INSERT INTO frame_index (source_id, session_id, seq, raw_path, raw_rel_path, frame_ordinal, authority, ptr, snippet, snippet_truncated, content_hash, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const fr of frames) {
      ins.run('dsh-home', 'session-aaa', fr.seq, ROOT + '/session-aaa/frames.jsonl', 'session-aaa/frames.jsonl', fr.seq, 'primary',
        'log:session-aaa#seq=' + fr.seq, fr.text, 0, hashFrame(fr.text), now);
    }
  } finally {
    v3db.close();
  }

  // 迁到 v4。
  const migrated = openStore({ path, mode: 'readwrite' });
  assert(migrated.state.current === 3 && migrated.state.ready === false, 'starts as v3, not ready for v4');
  const res = migrated.migrate();
  assert(JSON.stringify(res.applied.map(function (a) { return a.version; })) === JSON.stringify([4, 5]), 'v4 then v5 apply (and nothing else): ' + JSON.stringify(res.applied.map(function (a) { return a.version; })));
  const step = res.postSteps.filter(function (s) { return s.version === 4; })[0];
  assert(step && step.result.scanned === 3 && step.result.inserted === 3, 'v4 backfilled every legacy frame: ' + JSON.stringify(step && step.result));
  assert(migrated.searchIndexInfo().aligned === true, 'migrated index is aligned');

  // 新 v4 库：同样的帧走 ingest 进去。
  const fresh = freshStore('t46-fresh');
  for (const fr of frames) {
    fresh.ingest(frameRecord({ source: dshSource({ rawPath: ROOT }), seq: fr.seq, frameOrdinal: fr.seq, rawPath: ROOT + '/session-aaa/frames.jsonl', text: fr.text }));
  }

  // 1) FTS 行逐字一致（search_text / raw_text / ptr / rowid 全对）。
  const ftsOf = function (store) {
    return store.db.prepare('select rowid as rid, search_text, raw_text, ptr, seq from frame_fts order by rowid').all();
  };
  assert(JSON.stringify(ftsOf(migrated)) === JSON.stringify(ftsOf(fresh)),
    'v4 backfill and v4 ingest produce byte-identical FTS rows\nmigrated: ' + JSON.stringify(ftsOf(migrated)) + '\nfresh: ' + JSON.stringify(ftsOf(fresh)));

  // 2) 查询结果逐条一致（含 matchMode / tokens / 命中 ptr 集合）。
  const queries = ['解耦', '哨兵', '墨', '六层解耦', 'decouple', 'DECOUPLE', 'v4 哨兵', '不存在'];
  for (const q of queries) {
    const a = migrated.search(q);
    const b = fresh.search(q);
    const shape = function (r) {
      return { mode: r.matchMode, tokens: r.tokens, hits: r.results.map(function (x) { return x.ptr; }).sort() };
    };
    assert(JSON.stringify(shape(a)) === JSON.stringify(shape(b)), 'query ' + JSON.stringify(q) + ' agrees:\n' + JSON.stringify(shape(a)) + '\n' + JSON.stringify(shape(b)));
  }
  migrated.close();
  fresh.close();
});

// ── T47 子串语义对拍：检索结果 == 全表简单子串 ───────────────────────────
test('T47 P1b: search results equal a brute-force case-insensitive substring scan (no semantic drift)', () => {
  const store = freshStore('t47');
  const texts = [
    '解耦与哨兵：六层解耦的第一层就是哨兵机制，墨迹未干。',
    'Decouple v4 哨兵 ready',
    '缓冲区扩容，和前面无关。',
    '墨',
    '只有 50% 的把握，还有 50% 要验。',
    '解 耦 分 开 写 的 三 个 字',
  ];
  texts.forEach(function (t, i) { store.ingest(frameRecord({ seq: i, text: t })); });
  const all = store.listFrames({ limit: 100 });
  const brute = function (q) {
    const needle = q.trim().toLowerCase();
    return all
      .filter(function (f) { return f.snippet.toLowerCase().indexOf(needle) !== -1; })
      .map(function (f) { return f.ptr; })
      .sort();
  };
  const queries = ['解耦', '哨兵', '墨', '六层解耦', 'decouple', 'DECOUPLE', 'v4', 'v4 哨兵', '50%', '%', '解 耦', '，', '不存在', '解耦哨兵', '六层解耦机制'];
  for (const q of queries) {
    const got = store.search(q, { limit: 100 }).results.map(function (r) { return r.ptr; }).sort();
    const want = brute(q);
    assert(JSON.stringify(got) === JSON.stringify(want), 'query ' + JSON.stringify(q) + ': search must equal the substring scan, got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
  }
  store.close();
});

// ═══ P1b 返修回归（2026-11-09）═════════════════════════════════════════════
// 这一组专打两处漏召回（非 CJK 整词预筛、候选取回截断）与一处验收后门（expectFile）。
// 语义口径只有一条：search(q) 的命中集合 == raw_text.toLowerCase().includes(q.trim().toLowerCase())。

function ptrList(res) {
  return res.results.map(function (r) { return r.ptr; }).sort();
}

function assertPtrs(res, ptrs, label) {
  assert(JSON.stringify(ptrList(res)) === JSON.stringify(ptrs.slice().sort()),
    label + ': got ' + JSON.stringify(ptrList(res)) + ' want ' + JSON.stringify(ptrs.slice().sort()));
}

// ── T48 五个真实形状：P1 / 8f3a / 7eff99 / makeStream(驼峰) / couple ────────
test('T48 rev: token fragments (P1, 8f3a, 7eff99, makeStream, couple) hit by raw substring, and the full sweep equals brute force', () => {
  const store = freshStore('t48');
  const texts = [
    'v4-P1b-实现-20261109 报告已写完',   // 0: 版本号前缀 P1
    'orderId=8f3a2c 的订单',            // 1: hash 前六位
    'session-7eff99a7 的 lead',         // 2: session id 中段
    '调用 makeStreamFingerprint 生成指纹', // 3: 驼峰词根
    'Decouple v4 哨兵 ready',           // 4: 单词中段
    '这一夜我们把六层解耦做完，哨兵机制上线，墨迹未干。', // 5
    '缓冲区扩容，和前面无关。',           // 6
    'a_b 下划线 token',                 // 7
    'ÉCOLE écriture naïve',             // 8
  ];
  texts.forEach(function (t, i) { store.ingest(frameRecord({ seq: i, text: t })); });

  // 1) 五个真实形状：每一个都必须命中，且只命中该命中的那一帧。
  const p1 = store.search('P1', { limit: 100 });
  assert(p1.matchMode === 'token' && p1.scanPath === 'raw-scan', 'P1 is a word token, so it must take the raw-scan path (no whole-word FTS prescreen): ' + p1.matchMode + '/' + p1.scanPath);
  assertPtrs(p1, ['log:session-aaa#seq=0'], 'P1 must find v4-P1b-实现 (prefix of the token P1b)');
  assertPtrs(store.search('P1b', { limit: 100 }), ['log:session-aaa#seq=0'], 'P1b still hits');
  assertPtrs(store.search('8f3a', { limit: 100 }), ['log:session-aaa#seq=1'], '8f3a must find 8f3a2c');
  assertPtrs(store.search('8f3a2c', { limit: 100 }), ['log:session-aaa#seq=1'], 'the full hash prefix still hits');
  assertPtrs(store.search('7eff99', { limit: 100 }), ['log:session-aaa#seq=2'], '7eff99 must find session-7eff99a7');
  assertPtrs(store.search('makeStream', { limit: 100 }), ['log:session-aaa#seq=3'], 'makeStream must find makeStreamFingerprint');
  assertPtrs(store.search('StreamFingerprint', { limit: 100 }), ['log:session-aaa#seq=3'], 'StreamFingerprint must find the camel-case tail');
  assertPtrs(store.search('makeStreamFingerprint', { limit: 100 }), ['log:session-aaa#seq=3'], 'the whole symbol still hits');
  assertPtrs(store.search('couple', { limit: 100 }), ['log:session-aaa#seq=4'], 'couple must find Decouple');
  assertPtrs(store.search('Decouple', { limit: 100 }), ['log:session-aaa#seq=4'], 'Decouple still hits');

  // 2) 对拍：这些查询与暴力 includes 逐条相等（含括号里的"片段"形状）。
  const all = store.listFrames({ limit: 100 });
  const brute = function (q) {
    const needle = q.trim().toLowerCase();
    return all.filter(function (f) { return f.snippet.toLowerCase().indexOf(needle) !== -1; })
      .map(function (f) { return f.ptr; }).sort();
  };
  const queries = ['P1', 'P1b', '8f3a', '8f3a2c', '7eff99', '7eff99a7', 'makeStream', 'StreamFingerprint',
    'makeStreamFingerprint', 'couple', 'Decouple', 'decouple', '4', '_', 'é', 'É', 'a_b',
    '六层解耦', '解耦', '哨兵', '墨', 'naïve', 'NAÏVE', 'orderId', 'session-'];
  for (const q of queries) {
    const got = ptrList(store.search(q, { limit: 100 }));
    const want = brute(q);
    assert(JSON.stringify(got) === JSON.stringify(want), 'query ' + JSON.stringify(q) + ' must equal includes(): got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
  }
  store.close();
});

// ── T49 600 诱饵 + 第 601 条真命中：候选不截断 ─────────────────────────────
test('T49 rev: 600 decoys + the 601st real hit — limit 20 returns the real hit, candidates are never truncated', () => {
  // A) CJK 路径：诱饵都含 六层/层解/解耦 三个 bigram 但四字不连续；真命中更长（bm25 排最后）。
  const cjk = freshStore('t49-cjk');
  for (let i = 0; i < 600; i += 1) {
    cjk.ingest(frameRecord({ seq: i, text: '六层解码解耦' }));
  }
  cjk.ingest(frameRecord({ seq: 600, text: '这里才是真的六层解耦，它是唯一的真命中，其余都只是分片。' }));
  const res = cjk.search('六层解耦', { limit: 20 });
  assert(res.matchMode === 'bigram' && res.scanPath === 'bigram-fts', 'CJK query keeps the bigram prescreen: ' + res.matchMode + '/' + res.scanPath);
  assertPtrs(res, ['log:session-aaa#seq=600'], 'the 601st candidate is the only real hit');
  assert(res.candidatesTruncated === false, 'candidatesTruncated must be false: the scan is exhaustive, never a silent cap');
  assert(res.candidates >= 601, 'the scan examined every candidate (>= 601), got ' + res.candidates);
  assert(res.batches >= 4, 'a 601-candidate scan takes >= 4 batches of ' + 200 + ', got ' + res.batches);
  assert(res.exhausted === true, 'scan ended because candidates ran out, not because of a cap');
  assert(res.results[0].score !== null && res.results[0].score !== undefined, 'CJK hits still carry a bm25 score');
  assertPtrs(cjk.search('六层解耦', { limit: 500 }), ['log:session-aaa#seq=600'], 'a larger limit changes nothing (the hit set is the answer)');

  // B) raw 扫描路径：前 600 行根本不含 needle，真命中在第 601 行 —— 位置不能成为漏报理由。
  const raw = freshStore('t49-raw');
  for (let i = 0; i < 600; i += 1) {
    raw.ingest(frameRecord({ seq: i, text: '填充内容 ' + i + ' 与查询无关' }));
  }
  raw.ingest(frameRecord({ seq: 600, text: 'needle 出现在第六百零一条' }));
  const hit = raw.search('needle', { limit: 20 });
  assert(hit.scanPath === 'raw-scan', 'non-CJK uses the raw scan: ' + hit.scanPath);
  assertPtrs(hit, ['log:session-aaa#seq=600'], 'a hit beyond 600 non-matching rows is still returned');
  assert(hit.candidatesTruncated === false && hit.candidates >= 601, 'raw scan also examined every row, got ' + hit.candidates);
  assert(hit.exhausted === true, 'raw scan exhausted the candidate set');
  cjk.close();
  raw.close();
});

// ── T50 limit 语义：limit 只限制返回条数，不限制被检查的候选 ────────────────
test('T50 rev: limit caps the returned list, never the number of candidates checked', () => {
  const store = freshStore('t50');
  for (let i = 0; i < 6; i += 1) store.ingest(frameRecord({ seq: i, text: 'needleword 命中 ' + i }));
  for (let i = 6; i < 9; i += 1) store.ingest(frameRecord({ seq: i, text: '无关 ' + i }));

  const one = store.search('needleword', { limit: 1 });
  assert(one.results.length === 1 && one.results[0].ptr === 'log:session-aaa#seq=0', 'limit 1 returns exactly the first hit');
  assert(one.exhausted === false && one.candidatesTruncated === false, 'stopping early because limit was satisfied is not a truncation');
  assert(one.candidates >= 1 && one.scanned === one.candidates, 'scanned and candidates describe the same rows');

  const two = store.search('needleword', { limit: 2 });
  assert(two.results.length === 2, 'limit 2 returns two');
  assertPtrs(two, ['log:session-aaa#seq=0', 'log:session-aaa#seq=1'], 'and they are the first two in scan order');

  const all = store.search('needleword', { limit: 500 });
  assert(all.results.length === 6, 'limit 500 returns all six hits, got ' + all.results.length);
  assert(all.exhausted === true, 'the full scan reports exhaustion');
  assert(all.candidates === 9, 'the full scan checked all nine rows (limit did not shorten the scan), got ' + all.candidates);

  const clampedLow = store.search('needleword', { limit: 0 });
  assert(clampedLow.results.length === 1, 'limit 0 clamps to 1');
  const clampedHigh = store.search('needleword', { limit: 9999 });
  assert(clampedHigh.results.length === 6, 'limit above the ceiling clamps to SEARCH_LIMIT_MAX and still returns every hit');
  store.close();
});

// ── T51 批次边界无漏：命中落在第一批之后也必须被找到 ───────────────────────
test('T51 rev: a hit past the batch boundary is found on both scan paths (batching must not lose rows)', () => {
  const store = freshStore('t51');
  for (let i = 0; i < 450; i += 1) store.ingest(frameRecord({ seq: i, text: '填充 ' + i + ' 无关键词' }));
  store.ingest(frameRecord({ seq: 450, text: 'needleword 在第四百五十一条' }));
  const raw = store.search('needleword', { limit: 20 });
  assertPtrs(raw, ['log:session-aaa#seq=450'], 'raw scan crosses the 200-row batch boundary and still finds the hit');
  assert(raw.batches >= 3 && raw.candidates === 451 && raw.exhausted === true, 'batches/scan bookkeeping: ' + JSON.stringify({ b: raw.batches, c: raw.candidates, e: raw.exhausted }));

  for (let i = 1000; i < 1450; i += 1) store.ingest(frameRecord({ seq: i, text: '六层解码解耦' }));
  store.ingest(frameRecord({ seq: 1450, text: '真命中的六层解耦在这里' }));
  const cjk = store.search('六层解耦', { limit: 20 });
  assertPtrs(cjk, ['log:session-aaa#seq=1450'], 'bigram prescreen also crosses batch boundaries without losing the hit');
  assert(cjk.batches >= 3 && cjk.exhausted === true, 'bigram scan bookkeeping: ' + JSON.stringify({ b: cjk.batches, c: cjk.candidates }));
  assert(cjk.candidatesTruncated === false, 'no truncation flag on the CJK path either');
  store.close();
});

// ── T52 CJK 硬样例与边界：跨位置假阳性、bigram 内部、mixed 整串 ─────────────
test('T52 rev: CJK hard samples keep substring semantics (cross-position killed, incised bigram hits, mixed stays exact)', () => {
  const store = freshStore('t52');
  store.ingest(frameRecord({ seq: 0, text: '六层解码后缓冲解耦机制' }));
  store.ingest(frameRecord({ seq: 1, text: '这里才是真的六层解耦。' }));
  store.ingest(frameRecord({ seq: 2, text: '解耦v4 连写' }));
  store.ingest(frameRecord({ seq: 3, text: 'v4解耦 连写' }));

  const cross = store.search('六层解耦');
  assert(cross.matchMode === 'bigram' && cross.candidates >= 1, 'the prescreen does return the scattered candidate');
  assertPtrs(cross, ['log:session-aaa#seq=1'], 'only the contiguous phrase hits; the scattered candidate is killed by raw verification');

  assertPtrs(store.search('耦机'), ['log:session-aaa#seq=0'], 'a bigram strictly inside 解耦机制 is a real substring and must hit');
  assertPtrs(store.search('机制解耦'), [], 'a phrase that is not contiguous anywhere hits nothing');
  assertPtrs(store.search('耦v'), ['log:session-aaa#seq=2'], 'mixed CJK+ASCII fragment hits by raw substring');
  assertPtrs(store.search('v4解耦'), ['log:session-aaa#seq=3'], 'the other mixed order hits only its own frame');
  assertPtrs(store.search('六层解耦机制'), [], 'four-plus chars across a non-existent phrase still hit nothing');
  assertPtrs(store.search('墨'), [], 'a single CJK char that appears nowhere hits nothing');
  store.close();
});

// ── T53 验收后门不存在：expectFile 被移除，三条判据无条件生效 ─────────────
test('T53 rev: verifyPtrSample has no expectFile escape hatch — missing file / wrong hash / non-relocatable always fail', () => {
  const acceptSource = readFileSync(join(SRC_DB, 'accept.mjs'), 'utf8');
  assert(acceptSource.indexOf('expectFile') === -1, 'accept.mjs must not contain the expectFile option at all (the backdoor is gone from the source, not just ignored)');

  const store = freshStore('t53');
  const root = join(tempRoot, 'p6-rev');
  const relFile = join('session-rev', 'frames.jsonl');
  mkdirSync(join(root, 'session-rev'), { recursive: true });
  writeFileSync(join(root, relFile), '{"seq":0,"text":"六层解耦"}\n', 'utf8');
  const canonical = '{"seq":0,"text":"六层解耦"}';
  store.ingest(frameRecord({ source: dshSource({ rawPath: root }), seq: 0, rawPath: join(root, relFile), text: canonical }));

  // 文件还在 + 三个判据都成立 → ok。传 expectFile:false 也不能改变任何判据。
  const ok = store.verifyPtrSample({ ptr: 'log:session-aaa#seq=0', canonicalText: canonical, expectFile: false });
  assert(ok.ok === true && ok.checks.fileExists === true, 'a real file still passes even when the legacy option is smuggled in: ' + JSON.stringify(ok.checks));
  assert(typeof ok.checks.fileExists === 'boolean' && ok.checks.fileExists !== null, 'fileExists is a boolean verdict, never null');

  // 删掉文件 → 即便传 expectFile:false，也必须 FAIL（旧实现这里会给 ok:true）。
  rmSync(join(root, relFile), { force: true });
  const missing = store.verifyPtrSample({ ptr: 'log:session-aaa#seq=0', contentHash: ok.contentHash, expectFile: false });
  assert(missing.ok === false, 'a missing file must fail even with expectFile:false (this was the backdoor), got ' + JSON.stringify(missing.checks));
  assert(missing.checks.fileExists === false && missing.fileExists === false, 'fileExists is the failing criterion and it is a real boolean');
  assert(String(missing.reason).indexOf('does not exist') !== -1, 'reason names the missing file: ' + missing.reason);

  // 错 hash：文件在不在都不是理由，hash 不一致就必须 FAIL。
  writeFileSync(join(root, relFile), '{"seq":0,"text":"六层解耦"}\n', 'utf8');
  const wrongHash = store.verifyPtrSample({ ptr: 'log:session-aaa#seq=0', canonicalText: 'another body entirely', expectFile: false });
  assert(wrongHash.ok === false && wrongHash.checks.hashMatch === false, 'a wrong canonical text still fails with the option present');

  // 不可搬迁：前两条都真，也必须 FAIL。
  store.db.prepare('INSERT INTO frame_index (source_id, session_id, seq, raw_path, raw_rel_path, frame_ordinal, authority, ptr, snippet, snippet_truncated, content_hash, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('dsh-home', 'session-aaa', 9, join(root, relFile), null, 0, 'primary', 'log:session-aaa#seq=9', canonical, 0, hashFrame(canonical), '2026-11-09T00:00:00.000Z');
  const notReloc = store.verifyPtrSample({ ptr: 'log:session-aaa#seq=9', canonicalText: canonical, expectFile: false });
  assert(notReloc.ok === false && notReloc.checks.relocatable === false, 'a non-relocatable frame fails regardless of the option');
  store.close();
});

// ═══ P1c（v5：产物元数据 + 检索索引闸 + 顶层 fileExists 一致）═══════════════
// 铁律同前：所有 fixture 只在 tempRoot 下。不读 data/、sessions/、40-产物索引 —— 
// 这里没有一个字节来自真实记忆或真实产物目录。

function p1cRoot(name) {
  const root = join(tempRoot, 'p1c-' + name);
  mkdirSync(root, { recursive: true });
  assert(root.startsWith(tempRoot), 'refusing to use a file fixture outside tempRoot: ' + root);
  return root;
}

// 产物必须挂在某个 source 下；用一次 ingest 建 source（与真实调用同一条路）。
function seedSource(store, root) {
  return store.ingest(frameRecord({
    source: dshSource({ rawPath: root }),
    rawPath: join(root, 'session-aaa', 'frames.jsonl'),
    text: 'seed frame for the artifact tests',
  }));
}

function writeFixture(root, rel, body) {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, body, 'utf8');
  return abs;
}

function shaOf(abs) {
  return createHash('sha256').update(readFileSync(abs)).digest('hex');
}

function eventActions(store, ref) {
  return store.listArtifactEvents(ref).items.map(function (e) { return e.action; });
}

// ── T54 v5 结构 + v1–v4 的 SQL 逐位未改 ───────────────────────────────────
test('T54 P1c/v5: artifacts + append-only artifact_events exist, and v1–v4 digests are literally unchanged', () => {
  const store = freshStore('t54');
  assert(SCHEMA_VERSION === 5, 'P1c bumps the schema to v5, got ' + SCHEMA_VERSION);
  assert(MIGRATION_LIST.length === 5, 'five migrations applied in history order, got ' + MIGRATION_LIST.length);
  const v5 = MIGRATION_LIST[4];
  assert(v5.version === 5 && v5.name === 'artifacts-and-append-only-events', 'v5 identity: ' + v5.version + ':' + v5.name);
  assert(typeof v5.after !== 'function', 'v5 needs no backfill step: v1-v4 never held artifact rows to migrate');
  assert(store.state.applied.length === 5 && store.state.applied[4].version === 5, 'schema_migrations records v5 last');

  // v1–v4 的 migrationDigest 与 P1b 实现报告 §7 记的四行逐位相同。
  // 这是「本轮没有碰历史 SQL」的客观证据，不是一句声明。
  const known = [
    '046c7100cb20b5b7018fd6b77551daa0dac55d54438833e117c0578ccbf7cf9e',
    '1a367d8566d033c4012d854be6e7396abfde6f85e932632899cfdb423a39535f',
    'e0014010e97a2d9409f52c5e1b981ce835b4bed9874180cc4d925973481639f9',
    '5ca56ab74384b93bd9f92ece39a1cffc498bf0be2db37d4413520e6d5c884cf1',
  ];
  MIGRATION_LIST.slice(0, 4).forEach(function (m, i) {
    assert(migrationDigest(m) === known[i], 'v' + m.version + ' digest changed in P1c (history is read-only): ' + migrationDigest(m));
  });

  const cols = store.db.prepare('PRAGMA table_info(artifacts)').all().map(function (c) { return c.name; });
  ['artifact_id', 'source_id', 'rel_path', 'kind', 'title', 'producer_session', 'producer_task',
    'created_at', 'updated_at', 'status', 'bytes', 'sha256', 'metadata_json', 'last_seen_at'].forEach(function (c) {
    assert(cols.indexOf(c) !== -1, 'artifacts column ' + c + ' (have ' + cols.join(',') + ')');
  });
  const evCols = store.db.prepare('PRAGMA table_info(artifact_events)').all().map(function (c) { return c.name; });
  ['event_id', 'artifact_id', 'action', 'from_status', 'to_status', 'bytes', 'sha256', 'detail_json', 'created_at'].forEach(function (c) {
    assert(evCols.indexOf(c) !== -1, 'artifact_events column ' + c + ' (have ' + evCols.join(',') + ')');
  });

  // 两个唯一索引：PK(artifact_id) 的自动索引 + 显式的 UNIQUE(source_id, rel_path)。
  // 只看非 pk 的那个 —— 断言的是「产物在同一个 source 里的相对路径唯一」。
  const uniq = store.db.prepare("PRAGMA index_list('artifacts')").all().filter(function (i) { return i.unique === 1 && i.origin !== 'pk'; });
  assert(uniq.length === 1, 'exactly one explicit unique index on artifacts, got ' + JSON.stringify(uniq));
  const uniqCols = store.db.prepare("PRAGMA index_info('" + uniq[0].name + "')").all().map(function (c) { return c.name; });
  assert(JSON.stringify(uniqCols) === JSON.stringify(['source_id', 'rel_path']), 'UNIQUE(source_id, rel_path), got ' + JSON.stringify(uniqCols));

  const triggers = store.db.prepare("select name from sqlite_master where type = 'trigger' order by name").all().map(function (r) { return r.name; });
  assert(triggers.indexOf('trg_artifact_events_no_update') !== -1 && triggers.indexOf('trg_artifact_events_no_delete') !== -1,
    'append-only triggers exist: ' + triggers.join(','));

  // 库层护栏：状态枚举、rel_path 形状、事件动作枚举、外键。
  const root = p1cRoot('t54');
  seedSource(store, root);
  const insArtifact = store.db.prepare([
    'insert into artifacts (artifact_id, source_id, rel_path, kind, created_at, updated_at, status, bytes, sha256, last_seen_at)',
    'values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ].join(' '));
  const baseRow = function (over) {
    return Object.assign({
      id: 'art_probe', source: 'dsh-home', rel: 'docs/a.md', kind: 'doc',
      at: '2026-11-09T00:00:00.000Z', status: 'present', bytes: 1, sha: 'a'.repeat(64),
    }, over || {});
  };
  const tryArtifact = function (over) {
    const r = baseRow(over);
    try {
      insArtifact.run(r.id, r.source, r.rel, r.kind, r.at, r.at, r.status, r.bytes, r.sha, r.at);
      return null;
    } catch (err) { return String(err.message); }
  };
  assert(String(tryArtifact({ status: 'archived' })).indexOf('CHECK') !== -1, 'status is constrained to present|stale|missing');
  assert(String(tryArtifact({ rel: '../escape.md' })).indexOf('CHECK') !== -1, "rel_path rejects a '..' segment at the DB layer too");
  assert(String(tryArtifact({ rel: 'docs\\a.md' })).indexOf('CHECK') !== -1, 'rel_path rejects backslashes (posix-normalized only)');
  assert(String(tryArtifact({ rel: '/abs.md' })).indexOf('CHECK') !== -1, 'rel_path rejects an absolute form');
  assert(String(tryArtifact({ rel: 'C:/x.md' })).indexOf('CHECK') !== -1, 'rel_path rejects a drive-qualified form');
  assert(String(tryArtifact({ kind: 'DOC' })).indexOf('CHECK') !== -1, 'kind must be lowercase');
  assert(tryArtifact() === null, 'a well-formed row is accepted');
  assert(String(tryArtifact({ id: 'art_probe2' })).indexOf('UNIQUE') !== -1, 'UNIQUE(source_id, rel_path) is real');
  const insEvent = store.db.prepare([
    'insert into artifact_events (artifact_id, action, from_status, to_status, bytes, sha256, created_at)',
    'values (?, ?, ?, ?, ?, ?, ?)',
  ].join(' '));
  let evErr = null;
  try { insEvent.run('art_probe', 'rewritten', null, 'present', 1, 'a'.repeat(64), '2026-11-09T00:00:00.000Z'); } catch (err) { evErr = String(err.message); }
  assert(evErr && evErr.indexOf('CHECK') !== -1, 'event actions are constrained: ' + evErr);
  evErr = null;
  try { insEvent.run('art_missing', 'registered', null, 'present', 1, 'a'.repeat(64), '2026-11-09T00:00:00.000Z'); } catch (err) { evErr = String(err.message); }
  assert(evErr && evErr.indexOf('FOREIGN KEY') !== -1, 'an event cannot point at a nonexistent artifact: ' + evErr);
  store.close();
});

// ── T55 登记：真读文件、只存 bytes+sha256、一条 registered 事件 ─────────────
test('T55 P1c: registerArtifact hashes the real file, stores no content, and writes exactly one registered event', () => {
  const root = p1cRoot('t55');
  const store = freshStore('t55');
  seedSource(store, root);
  const abs = writeFixture(root, 'docs/report.md', '# P1c 产物报告\n正文只在文件里，库里只留 bytes 与 sha256。\n');
  const sizeBefore = statSync(abs).size;

  const r = store.registerArtifact({
    sourceId: 'dsh-home',
    path: 'docs/report.md',
    kind: 'report',
    title: 'P1c 实现报告',
    producerSession: 'session-p1c',
    producerTask: 'P1c 实现',
    metadata: { stage: 'p1c', tags: ['artifact', 'v5'] },
  });

  assert(r.outcome === 'inserted', 'first registration is an insert, got ' + r.outcome);
  assert(r.artifact.bytes === sizeBefore, 'bytes come from the real file, got ' + r.artifact.bytes + ' want ' + sizeBefore);
  assert(r.artifact.sha256 === shaOf(abs), 'sha256 is the file bytes hash, got ' + r.artifact.sha256);
  assert(r.artifact.status === 'present' && r.artifact.kind === 'report', 'status/kind stored');
  assert(r.artifact.producerSession === 'session-p1c' && r.artifact.producerTask === 'P1c 实现', 'producer is recorded');
  assert(r.artifact.metadata && r.artifact.metadata.stage === 'p1c' && r.artifact.metadata.tags.length === 2, 'metadata round-trips: ' + JSON.stringify(r.artifact.metadata));
  assert(r.artifact.createdAt === r.artifact.updatedAt && r.artifact.createdAt === r.artifact.lastSeenAt, 'a fresh row has one timestamp');
  assert(r.artifact.artifactId === 'art_' + createHash('sha256').update('dsh-home' + '\n' + 'docs/report.md').digest('hex').slice(0, 32),
    'artifact_id is derived from (source_id, rel_path), so a rebuilt db keeps the same ids: ' + r.artifact.artifactId);
  assert(statSync(abs).size === sizeBefore, 'registration never writes the file');

  // 内容权威在原文件：整行里不该出现正文。
  const row = store.db.prepare('select * from artifacts').get();
  assert(JSON.stringify(row).indexOf('正文只在文件里') === -1, 'the artifact row must not carry file content: ' + JSON.stringify(row));

  const ev = store.listArtifactEvents({ sourceId: 'dsh-home', relPath: 'docs/report.md' });
  assert(ev.total === 1, 'exactly one event, got ' + ev.total);
  assert(ev.items[0].action === 'registered' && ev.items[0].fromStatus === null && ev.items[0].toStatus === 'present', 'registered: null -> present');
  assert(ev.items[0].bytes === sizeBefore && ev.items[0].sha256 === r.artifact.sha256, 'the event carries the observed bytes/hash');
  assert(ev.items[0].detail && ev.items[0].detail.relPath === 'docs/report.md', 'detail keeps the normalized rel path');
  store.close();
});

// ── T56 幂等：同内容重放不新增事件，只刷新 last_seen_at ────────────────────
test('T56 P1c: replaying identical content appends no event and only refreshes last_seen_at', () => {
  const root = p1cRoot('t56');
  const store = freshStore('t56');
  seedSource(store, root);
  writeFixture(root, 'docs/a.md', 'stable body\n');
  const record = { sourceId: 'dsh-home', path: 'docs/a.md', kind: 'doc', title: 'A', metadata: { k: 'v' } };

  const first = store.registerArtifact(record, { now: '2026-11-09T00:00:00.000Z' });
  const replay = store.registerArtifact(record, { now: '2026-11-09T06:00:00.000Z' });
  assert(replay.outcome === 'unchanged', 'same bytes + same metadata is a no-op, got ' + replay.outcome);
  assert(replay.eventsAppended === 0, 'no event on replay, got ' + replay.eventsAppended);
  const ref = { sourceId: 'dsh-home', relPath: 'docs/a.md' };
  assert(store.listArtifactEvents(ref).total === 1, 'event count stays 1');
  assert(replay.artifact.createdAt === first.artifact.createdAt, 'created_at never moves');
  assert(replay.artifact.updatedAt === first.artifact.updatedAt, 'updated_at does not move on a pure replay');
  assert(replay.artifact.lastSeenAt === '2026-11-09T06:00:00.000Z', 'last_seen_at does move (it was seen), got ' + replay.artifact.lastSeenAt);

  // 分隔符 / '.' 段不同 → 同一个产物，不是第二行。
  const mixed = store.registerArtifact(Object.assign({}, record, { path: 'docs\\.\\a.md' }));
  assert(mixed.outcome === 'unchanged' && mixed.eventsAppended === 0, 'mixed separators are the same artifact: ' + mixed.outcome);
  assert(store.countArtifacts().artifacts === 1, 'still one artifact row, got ' + store.countArtifacts().artifacts);

  // 元数据变了：留 metadata-updated，且只有这一条。
  const metaOnly = store.registerArtifact(Object.assign({}, record, { metadata: { k: 'v2' } }));
  assert(metaOnly.outcome === 'metadata-updated' && metaOnly.eventsAppended === 1, 'metadata change is recorded: ' + metaOnly.outcome);
  assert(JSON.stringify(eventActions(store, ref)) === JSON.stringify(['registered', 'metadata-updated']), 'event ledger: ' + JSON.stringify(eventActions(store, ref)));
  assert(metaOnly.artifact.bytes === first.artifact.bytes && metaOnly.artifact.sha256 === first.artifact.sha256, 'metadata change does not touch content fields');
  store.close();
});

// ── T57 内容变化：更新当前元数据 + 追加 content-changed（含旧值）────────────
test('T57 P1c: changed content updates bytes/sha256 and appends one content-changed event carrying the old values', () => {
  const root = p1cRoot('t57');
  const store = freshStore('t57');
  seedSource(store, root);
  const abs = writeFixture(root, 'docs/b.md', 'v1\n');
  const before = store.registerArtifact({ sourceId: 'dsh-home', path: 'docs/b.md', kind: 'doc' });

  writeFileSync(abs, 'v2 with more bytes\n', 'utf8');
  const after = store.registerArtifact({ sourceId: 'dsh-home', path: 'docs/b.md', kind: 'doc' });
  assert(after.outcome === 'content-changed', 'content change is its own outcome, got ' + after.outcome);
  assert(after.eventsAppended === 1, 'exactly one event');
  assert(after.artifact.bytes === statSync(abs).size && after.artifact.sha256 === shaOf(abs), 'bytes/sha256 follow the new content');
  assert(after.artifact.sha256 !== before.artifact.sha256, 'hash actually differs');
  assert(after.artifact.status === 'present', 'status stays present after a successful re-register');
  assert(after.artifact.createdAt === before.artifact.createdAt, 'created_at is the first sighting, not the last');

  const ev = store.listArtifactEvents({ sourceId: 'dsh-home', relPath: 'docs/b.md' });
  assert(JSON.stringify(ev.items.map(function (e) { return e.action; })) === JSON.stringify(['registered', 'content-changed']), 'ledger: ' + JSON.stringify(ev.items.map(function (e) { return e.action; })));
  const changed = ev.items[1];
  assert(changed.fromStatus === 'present' && changed.toStatus === 'present', 'content change keeps the status, so from == to');
  assert(changed.sha256 === after.artifact.sha256, 'the event stores the observed (new) hash');
  assert(changed.detail.before.sha256 === before.artifact.sha256 && changed.detail.before.bytes === before.artifact.bytes, 'the old values live in detail_json: ' + JSON.stringify(changed.detail.before));
  store.close();
});

// ── T58 verify：present / stale / missing，且只读（不写库、不碰文件）────────
test('T58 P1c: verifyArtifact reports present/stale/missing against the disk and never writes (db or file)', () => {
  const root = p1cRoot('t58');
  const store = freshStore('t58');
  seedSource(store, root);
  const abs = writeFixture(root, 'docs/c.md', 'body v1\n');
  const reg = store.registerArtifact({ sourceId: 'dsh-home', path: 'docs/c.md', kind: 'doc' });
  const ref = { sourceId: 'dsh-home', relPath: 'docs/c.md' };

  const v1 = store.verifyArtifact(ref);
  assert(v1.state === 'present', 'a matching file is present, got ' + v1.state);
  assert(v1.checks.pathSafe && v1.checks.exists && v1.checks.isFile && v1.checks.bytesMatch && v1.checks.sha256Match, 'all checks true: ' + JSON.stringify(v1.checks));
  assert(v1.db.status === 'present' && v1.db.sha256 === reg.artifact.sha256, 'the db snapshot is returned alongside');
  assert(v1.disk.sha256 === reg.artifact.sha256, 'disk hash recomputed');
  assert(v1.path && v1.path.toLowerCase() === abs.toLowerCase(), 'the resolved path is the real one, got ' + v1.path);

  // 只读证明：改文件前后，verify 不移动 updated_at / last_seen_at，也不写事件。
  const rowsBefore = store.db.prepare('select updated_at, last_seen_at, status from artifacts').get();
  const eventsBefore = store.db.prepare('select count(*) as n from artifact_events').get().n;
  writeFileSync(abs, 'body v2 changed\n', 'utf8');
  const v2 = store.verifyArtifact(ref);
  const v3 = store.verifyArtifact(ref);
  assert(v2.state === 'stale' && v3.state === 'stale', 'changed content is stale, got ' + v2.state);
  assert(v2.checks.sha256Match === false && v2.disk.sha256 === shaOf(abs), 'stale means the disk hash differs');
  assert(v2.db.status === 'present', 'db.status still says what was last confirmed (present), not what the disk says now');
  assert(v2.needsReregister === true, 'stale asks the caller to re-register');
  const rowsAfter = store.db.prepare('select updated_at, last_seen_at, status from artifacts').get();
  assert(JSON.stringify(rowsBefore) === JSON.stringify(rowsAfter), 'verify wrote nothing: ' + JSON.stringify(rowsAfter));
  assert(store.db.prepare('select count(*) as n from artifact_events').get().n === eventsBefore, 'verify appended no event');

  // 内容回到原样 → 又变 present（stale 是磁盘事实，不是粘性状态）。
  writeFileSync(abs, 'body v1\n', 'utf8');
  assert(store.verifyArtifact(ref).state === 'present', 'restoring the content restores present');

  // 文件没了 → missing；register 也随之拒收（不写半条记录）。
  rmSync(abs, { force: true });
  const v4 = store.verifyArtifact(ref);
  assert(v4.state === 'missing', 'a deleted file is missing, got ' + v4.state);
  assert(v4.checks.exists === false && v4.checks.isFile === false && v4.checks.pathSafe === true, 'missing keeps pathSafe true: ' + JSON.stringify(v4.checks));
  assert(v4.db.status === 'present' && v4.db.sha256 === reg.artifact.sha256, 'the db keeps the last confirmed values (so the loss is visible, not silently forgotten)');
  assertCode(function () { store.registerArtifact({ sourceId: 'dsh-home', path: 'docs/c.md', kind: 'doc' }); }, CODES.ARTIFACT_FILE_MISSING, 'register a missing file');
  assert(store.db.prepare('select count(*) as n from artifact_events').get().n === eventsBefore, 'a refused register writes no event');

  // 显式状态写路径：updateArtifact 让库跟上磁盘，并且必须留事件。
  const u = store.updateArtifact(ref, { status: 'missing' });
  assert(u.outcome === 'status-changed' && u.artifact.status === 'missing', 'explicit status write, got ' + u.outcome);
  assert(eventActions(store, ref).slice(-1)[0] === 'status-changed', 'status change is appended: ' + JSON.stringify(eventActions(store, ref)));
  const again = store.updateArtifact(ref, { status: 'missing' });
  assert(again.outcome === 'unchanged' && again.eventsAppended === 0, 'same status is not a change');
  assertCode(function () { store.updateArtifact(ref, { status: 'archived' }); }, CODES.ARTIFACT_STATUS_INVALID, 'invalid status');
  assertCode(function () { store.updateArtifact(ref, { bytes: 5 }); }, CODES.INVALID_INPUT, 'content fields are not patchable');
  store.close();
});

// ── T59 路径安全：根外 / .. / 目录 / 根自己 / 混合分隔符 / junction 逃逸 ────
test('T59 P1c: path safety — outside root, dotdot, directory, root itself, mixed separators and a junction escape', () => {
  const root = p1cRoot('t59');
  const store = freshStore('t59');
  seedSource(store, root);
  writeFixture(root, 'docs/sub/a.md', 'nested\n');
  const outside = p1cRoot('t59-outside');
  writeFileSync(join(outside, 'secret.md'), 'outside the root\n', 'utf8');

  const reg = function (p) { return store.registerArtifact({ sourceId: 'dsh-home', path: p, kind: 'doc' }); };

  assertCode(function () { reg('../evil.md'); }, CODES.PATH_OUTSIDE_SOURCE_ROOT, 'a dotdot escape');
  assertCode(function () { reg('docs/../../evil.md'); }, CODES.PATH_OUTSIDE_SOURCE_ROOT, 'a deeper dotdot escape');
  assertCode(function () { reg(join(outside, 'secret.md')); }, CODES.PATH_OUTSIDE_SOURCE_ROOT, 'an absolute path outside the root');
  assertCode(function () { reg('C:/Windows/win.ini'); }, CODES.PATH_OUTSIDE_SOURCE_ROOT, 'a drive-qualified path outside the root');
  assertCode(function () { reg('docs/sub'); }, CODES.ARTIFACT_NOT_A_FILE, 'a directory is not an artifact');
  assertCode(function () { reg(root); }, CODES.ARTIFACT_NOT_A_FILE, 'the source root itself is not an artifact');
  assertCode(function () { reg('docs/nope.md'); }, CODES.ARTIFACT_FILE_MISSING, 'a missing file');
  assertCode(function () { store.registerArtifact({ sourceId: 'nope', path: 'docs/sub/a.md', kind: 'doc' }); }, CODES.SOURCE_NOT_FOUND, 'an unknown source');
  assert(store.countArtifacts().artifacts === 0, 'every refusal left zero rows, got ' + store.countArtifacts().artifacts);

  // 混合分隔符 + '.' 段：同一条规范路径。
  const a = reg('docs\\sub/a.md');
  assert(a.outcome === 'inserted' && a.relPath === 'docs/sub/a.md', 'mixed separators normalize to one rel path, got ' + a.relPath);
  const b = reg(join(root, 'docs', 'sub', 'a.md').replace(/\//g, '\\'));
  assert(b.outcome === 'unchanged' && b.artifact.artifactId === a.artifact.artifactId, 'the absolute backslash form hits the same artifact');
  const c = reg('docs/./sub/../sub/a.md');
  assert(c.outcome === 'unchanged', "'.' and an internal '..' normalize to the same artifact, got " + c.outcome);

  // 符号链接 / junction 逃逸：根内的 reparse point 指向根外 —— 解析出来的 realpath 不在根内，
  // 必须拒收（Windows 上 junction 不需要管理员权限，所以这条在真机上可复现）。
  symlinkSync(outside, join(root, 'linkdir'), 'junction');
  const escape = assertCode(function () { reg('linkdir/secret.md'); }, CODES.ARTIFACT_PATH_ESCAPE, 'a junction escaping the root');
  assert(escape.details && escape.details.realPath && escape.details.realPath.toLowerCase().indexOf(outside.toLowerCase()) === 0,
    'the error names the real path that escaped: ' + JSON.stringify(escape.details));
  assert(store.countArtifacts().artifacts === 1, 'still one artifact after the escape attempt');
  store.close();
});

// ── T60 事件只追加：UPDATE / DELETE 都被库层触发器拒 ───────────────────────
test('T60 P1c: artifact_events is append-only at the DB layer (no UPDATE, no DELETE, even by hand)', () => {
  const root = p1cRoot('t60');
  const store = freshStore('t60');
  seedSource(store, root);
  writeFixture(root, 'docs/d.md', 'body v1\n');
  const ref = { sourceId: 'dsh-home', relPath: 'docs/d.md' };
  store.registerArtifact({ sourceId: 'dsh-home', path: 'docs/d.md', kind: 'doc' });
  writeFixture(root, 'docs/d.md', 'body v2 is longer\n');
  store.registerArtifact({ sourceId: 'dsh-home', path: 'docs/d.md', kind: 'doc' });
  const before = store.db.prepare('select * from artifact_events order by event_id').all();
  assert(before.length === 2, 'two events to protect, got ' + before.length);

  let err = null;
  try { store.db.prepare("update artifact_events set action = 'metadata-updated' where event_id = ?").run(before[0].event_id); } catch (e) { err = String(e.message); }
  assert(err && err.indexOf('META_ARTIFACT_EVENTS_APPEND_ONLY') !== -1, 'UPDATE is refused by the trigger: ' + err);
  err = null;
  try { store.db.prepare('delete from artifact_events where event_id = ?').run(before[0].event_id); } catch (e) { err = String(e.message); }
  assert(err && err.indexOf('META_ARTIFACT_EVENTS_APPEND_ONLY') !== -1, 'DELETE is refused by the trigger: ' + err);
  err = null;
  try { store.db.exec('delete from artifact_events'); } catch (e) { err = String(e.message); }
  assert(err && err.indexOf('META_ARTIFACT_EVENTS_APPEND_ONLY') !== -1, 'a blanket DELETE is refused too: ' + err);

  const after = store.db.prepare('select * from artifact_events order by event_id').all();
  assert(JSON.stringify(after) === JSON.stringify(before), 'the ledger is byte-identical after three refused attempts');
  store.close();
});

// ── T61 元数据更新 / 状态生命周期：每次变更一条事件，重复更新不叠 ─────────
test('T61 P1c: metadata and lifecycle updates always append an event, and identical updates append nothing', () => {
  const root = p1cRoot('t61');
  const store = freshStore('t61');
  seedSource(store, root);
  writeFixture(root, 'docs/e.md', 'body\n');
  const ref = { sourceId: 'dsh-home', relPath: 'docs/e.md' };
  const reg = store.registerArtifact({ sourceId: 'dsh-home', path: 'docs/e.md', kind: 'doc', title: 'E', metadata: { a: 1 } });

  const u1 = store.updateArtifact(ref, { title: 'E2', metadata: { a: 2, b: [1, 2] }, producerTask: 'P1c 返修' });
  assert(u1.outcome === 'metadata-updated' && u1.eventsAppended === 1, 'one metadata event, got ' + u1.outcome + '/' + u1.eventsAppended);
  assert(JSON.stringify(u1.changedFields) === JSON.stringify(['title', 'producerTask', 'metadata']), 'changed fields are named: ' + JSON.stringify(u1.changedFields));
  assert(u1.artifact.bytes === reg.artifact.bytes && u1.artifact.sha256 === reg.artifact.sha256, 'content fields untouched');
  assert(u1.artifact.metadata.b[1] === 2, 'metadata round-trips with arrays: ' + JSON.stringify(u1.artifact.metadata));

  const u2 = store.updateArtifact(ref, { title: 'E2', metadata: { b: [1, 2], a: 2 }, producerTask: 'P1c 返修' });
  assert(u2.outcome === 'unchanged' && u2.eventsAppended === 0, 'same values in a different key order is not a change, got ' + u2.outcome);

  const u3 = store.updateArtifact(ref, { status: 'stale' });
  assert(u3.outcome === 'status-changed' && u3.eventsAppended === 1 && u3.artifact.status === 'stale', 'status transition recorded');
  const u4 = store.updateArtifact(ref, { status: 'stale' });
  assert(u4.outcome === 'unchanged' && u4.eventsAppended === 0, 'same status is not a transition');

  const ev = store.listArtifactEvents(ref);
  assert(JSON.stringify(ev.items.map(function (e) { return e.action; })) === JSON.stringify(['registered', 'metadata-updated', 'status-changed']),
    'ledger order: ' + JSON.stringify(ev.items.map(function (e) { return e.action; })));
  const metaEvent = ev.items[1];
  assert(metaEvent.detail.changed.indexOf('title') !== -1 && metaEvent.detail.before.title === 'E' && metaEvent.detail.after.title === 'E2', 'detail keeps before/after: ' + JSON.stringify(metaEvent.detail));
  store.close();
});

// ── T62 列举 / 取回 / 重开库 / 只读库 ──────────────────────────────────────
test('T62 P1c: list/get filter correctly, the metadata survives a reopen, and a readonly store refuses writes', () => {
  const path = dbPath('t62');
  const root = p1cRoot('t62');
  const store = openStore({ path, mode: 'readwrite' });
  store.migrate();
  seedSource(store, root);
  writeFixture(root, 'docs/one.md', 'one\n');
  writeFixture(root, 'docs/two.md', 'two is longer\n');
  writeFixture(root, 'notes/three.txt', 'three\n');
  store.registerArtifact({ sourceId: 'dsh-home', path: 'docs/one.md', kind: 'report', title: 'One' });
  store.registerArtifact({ sourceId: 'dsh-home', path: 'docs/two.md', kind: 'report', title: 'Two' });
  store.registerArtifact({ sourceId: 'dsh-home', path: 'notes/three.txt', kind: 'note', title: 'Three' });

  assert(store.countArtifacts().artifacts === 3 && store.countArtifacts().events === 3, 'three rows, three events');
  assert(store.listArtifacts().total === 3, 'list all');
  assert(store.listArtifacts({ kind: 'report' }).total === 2, 'filter by kind');
  assert(store.listArtifacts({ prefix: 'notes/' }).total === 1, 'filter by rel path prefix');
  assert(store.listArtifacts({ prefix: 'docs' }).total === 2, 'prefix is a raw string prefix (docs matches docs/...)');
  assert(store.listArtifacts({ limit: 1 }).items.length === 1 && store.listArtifacts({ limit: 1 }).total === 3, 'limit caps items, not total');
  assertCode(function () { store.listArtifacts({ status: 'gone' }); }, CODES.ARTIFACT_STATUS_INVALID, 'bad status filter');
  assertCode(function () { store.listArtifacts({ prefix: 'docs\\sub' }); }, CODES.INVALID_INPUT, 'backslash prefix');

  const got = store.getArtifact({ sourceId: 'dsh-home', relPath: 'docs/two.md' });
  assert(got && got.title === 'Two' && got.bytes === statSync(join(root, 'docs', 'two.md')).size, 'get by (source, relPath)');
  assert(store.getArtifact(got.artifactId).title === 'Two', 'get by id');
  assert(store.getArtifact('art_nope') === null, 'unknown id is null, not a throw');
  assertCode(function () { store.verifyArtifact('art_nope'); }, CODES.ARTIFACT_NOT_FOUND, 'verify an unknown artifact');
  assertCode(function () { store.listArtifactEvents('art_nope'); }, CODES.ARTIFACT_NOT_FOUND, 'events of an unknown artifact');
  store.close();

  const ro = openStore({ path, mode: 'readonly' });
  assert(ro.getArtifact(got.artifactId).sha256 === got.sha256, 'metadata survives close + reopen');
  assert(ro.listArtifacts().total === 3 && ro.listArtifactEvents(got.artifactId).total === 1, 'events survive too');
  assert(ro.verifyArtifact(got.artifactId).state === 'present', 'verify works on a readonly connection (it never writes)');
  assertCode(function () { ro.registerArtifact({ sourceId: 'dsh-home', path: 'docs/one.md', kind: 'report' }); }, CODES.READONLY, 'register on readonly');
  assertCode(function () { ro.updateArtifact(got.artifactId, { title: 'X' }); }, CODES.READONLY, 'update on readonly');
  ro.close();
});

// ── T63 v4 → v5 迁移、失败回滚、两条路径行为一致 ──────────────────────────
test('T63 P1c: a v4 db migrates to v5 without touching frames, a failing v5 rolls back whole, and both paths agree', () => {
  const root = p1cRoot('t63');
  const now = '2026-11-09T00:00:00.000Z';
  const fixture = writeFixture(root, 'docs/mig.md', 'migrated artifact body\n');
  const hash = hashFrame('migrated artifact body\n');

  const buildV4 = function (path) {
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL');
    try {
      migrate(db, { migrations: MIGRATION_LIST.slice(0, 4), targetVersion: 4 });
      db.prepare('INSERT INTO sources (source_id, kind, namespace, authority, raw_path, path_kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('dsh-home', 'dsh-log', 'log', 'primary', root, 'dir', now, now);
      db.prepare('INSERT INTO sessions (source_id, session_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)')
        .run('dsh-home', 'session-aaa', now, now);
      const ins = db.prepare('INSERT INTO frame_index (source_id, session_id, seq, raw_path, raw_rel_path, frame_ordinal, authority, ptr, snippet, snippet_truncated, content_hash, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      ins.run('dsh-home', 'session-aaa', 0, join(root, 'session-aaa', 'frames.jsonl'), 'session-aaa/frames.jsonl', 0, 'primary', 'log:session-aaa#seq=0', '六层解耦的历史帧', 0, hashFrame('六层解耦的历史帧'), now);
      ins.run('dsh-home', 'session-aaa', 1, join(root, 'session-aaa', 'frames.jsonl'), 'session-aaa/frames.jsonl', 1, 'primary', 'log:session-aaa#seq=1', 'P1b 的历史帧', 0, hashFrame('P1b 的历史帧'), now);
      ins.run('dsh-home', 'session-aaa', 2, join(root, 'session-aaa', 'frames.jsonl'), 'session-aaa/frames.jsonl', 2, 'primary', 'log:session-aaa#seq=2', '无关帧', 0, hashFrame('无关帧'), now);
      // 这几帧是裸 SQL 插进去的，v4 的回填早已跑过（那时表是空的），所以这里补建一次 FTS，
      // 让起点是一个「对齐的 v4 库」—— 否则后面测的就不是 v5，而是我这个 fixture 的漏洞。
      rebuildFrameFts(db);
    } finally {
      db.close();
    }
  };

  const path = dbPath('t63-v4');
  buildV4(path);
  const store = openStore({ path, mode: 'readwrite' });
  assert(store.state.current === 4 && store.state.ready === false, 'a v4 db is not ready for v5 code, got ' + store.state.current);
  assertCode(function () { store.registerArtifact({ sourceId: 'dsh-home', path: 'docs/mig.md', kind: 'doc' }); }, CODES.MIGRATION_REQUIRED, 'artifacts require v5');
  // ★ 注意：v4 库在 v5 代码下不是 ready，store.listFrames 会先抛 MIGRATION_REQUIRED。
  //   所以「迁移前」的快照只能走裸 SQL —— 这不是绕过护栏，而是护栏在正常工作。
  const beforeRows = store.db.prepare('select source_id, session_id, seq, ptr, raw_rel_path, content_hash from frame_index order by seq').all();
  const framesBefore = JSON.stringify(beforeRows);

  const res = store.migrate();
  assert(res.applied.length === 1 && res.applied[0].version === 5, 'only v5 applies: ' + JSON.stringify(res.applied.map(function (a) { return a.version; })));
  assert(store.state.ready === true && store.state.current === 5, 'ready at v5');
  const afterRows = store.db.prepare('select source_id, session_id, seq, ptr, raw_rel_path, content_hash from frame_index order by seq').all();
  assert(JSON.stringify(afterRows) === framesBefore, 'v5 did not touch a single frame row\nbefore: ' + framesBefore + '\nafter: ' + JSON.stringify(afterRows));
  assert(store.searchIndexInfo().aligned === true, 'v5 did not disturb the FTS index');
  assert(store.countArtifacts().artifacts === 0, 'artifacts start empty: there was no legacy artifact data to carry over');
  assert(store.listSourceRelocations('dsh-home').length === 0, 'no relocation audit rows invented by the migration');

  // 迁移库 vs 新库：同一次登记应当逐字段一致（时间戳除外）。
  const migratedReg = store.registerArtifact({ sourceId: 'dsh-home', path: 'docs/mig.md', kind: 'doc', title: 'Mig', metadata: { m: 1 } });
  const fresh = freshStore('t63-fresh');
  fresh.ingest(frameRecord({ source: dshSource({ rawPath: root }) }));
  const freshReg = fresh.registerArtifact({ sourceId: 'dsh-home', path: 'docs/mig.md', kind: 'doc', title: 'Mig', metadata: { m: 1 } });
  const scrub = function (a) {
    const c = Object.assign({}, a);
    ['createdAt', 'updatedAt', 'lastSeenAt'].forEach(function (k) { delete c[k]; });
    return c;
  };
  assert(JSON.stringify(scrub(migratedReg.artifact)) === JSON.stringify(scrub(freshReg.artifact)),
    'migrated and fresh v5 stores register identically\nmigrated: ' + JSON.stringify(scrub(migratedReg.artifact)) + '\nfresh: ' + JSON.stringify(scrub(freshReg.artifact)));
  assert(migratedReg.artifact.sha256 === hash && shaOf(fixture) === hash, 'the stored hash is the real file hash');
  assert(store.verifyArtifact({ sourceId: 'dsh-home', relPath: 'docs/mig.md' }).state === 'present', 'verify works on the migrated store');
  fresh.close();
  store.close();

  // 失败的 v5：整批回滚，库留在 v4，半成品表不留。
  const badPath = dbPath('t63-bad');
  buildV4(badPath);
  const bad = new DatabaseSync(badPath);
  try {
    const broken = Object.freeze({ version: 5, name: 'artifacts-and-append-only-events', sql: 'CREATE TABLE artifacts (this is not valid sql;' });
    let err = null;
    try {
      migrate(bad, { migrations: MIGRATION_LIST.slice(0, 4).concat([broken]), targetVersion: 5 });
    } catch (e) { err = e; }
    assert(err && isMetaStoreError(err) && err.code === CODES.MIGRATION_FAILED, 'a broken v5 reports MIGRATION_FAILED, got ' + (err && err.code) + ' / ' + (err && err.message));
    assert(bad.prepare('select max(version) as v from schema_migrations').get().v === 4, 'history stays at v4 after the rollback');
    assert(bad.prepare("select 1 as x from sqlite_master where type = 'table' and name = 'artifacts'").get() === undefined, 'the half-created artifacts table was rolled back');
    assert(bad.prepare('select count(*) as n from frame_index').get().n === 3, 'frames survived the rollback');
    assert(bad.prepare('select count(*) as n from frame_fts').get().n === 3, 'FTS rows survived the rollback');
  } finally {
    bad.close();
  }
});

// ── T64 索引闸：两条扫描路径都不许静默漏帧 ────────────────────────────────
test('T64 P1c: a mis-aligned index blocks both scan paths (CJK prescreen and raw scan) instead of silently losing frames', () => {
  const store = freshStore('t64');
  store.ingest(frameRecord({ seq: 0, text: '六层解耦的第一层' }));
  store.ingest(frameRecord({ seq: 1, text: 'P1c 报告与 artifact 登记' }));
  store.ingest(frameRecord({ seq: 2, text: '无关的一帧' }));
  assertPtrs(store.search('解耦'), ['log:session-aaa#seq=0'], 'baseline: CJK path hits');
  assertPtrs(store.search('P1c'), ['log:session-aaa#seq=1'], 'baseline: raw-scan path hits');

  const rid = store.db.prepare("select rowid as rid from frame_index where ptr = 'log:session-aaa#seq=1'").get().rid;
  store.db.prepare('delete from frame_fts where rowid = ?').run(rid);
  const info = store.searchIndexInfo();
  assert(info.aligned === false && info.framesWithoutFts === 1 && info.frames === 3, 'misalignment is visible: ' + JSON.stringify(info));

  const cjk = assertCode(function () { store.search('解耦'); }, CODES.SEARCH_INDEX_STALE, 'CJK prescreen path');
  const raw = assertCode(function () { store.search('P1c'); }, CODES.SEARCH_INDEX_STALE, 'raw-scan path');
  const empty = assertCode(function () { store.search(''); }, CODES.SEARCH_INDEX_STALE, 'empty query on a broken index');
  [cjk, raw, empty].forEach(function (e, i) {
    assert(e.details && e.details.index && e.details.index.framesWithoutFts === 1, 'error #' + i + ' carries the counts: ' + JSON.stringify(e.details));
  });
  assert(String(cjk.message).indexOf('rebuildSearchIndex') !== -1, 'the message names the fix: ' + cjk.message);

  const rebuilt = store.rebuildSearchIndex();
  assert(rebuilt.inserted === 3 && store.searchIndexInfo().aligned === true, 'rebuild restores alignment: ' + JSON.stringify(rebuilt));
  assertPtrs(store.search('P1c'), ['log:session-aaa#seq=1'], 'the previously invisible frame is searchable again (this is the frame that used to be silently dropped)');
  assertPtrs(store.search('解耦'), ['log:session-aaa#seq=0'], 'and the other path is intact');

  // 孤儿 FTS 行（有索引行、没有帧行）也算不一致 —— 两边都不能有。
  store.db.prepare('insert into frame_fts (rowid, search_text, raw_text, ptr, source_id, session_id, seq) values (?, ?, ?, ?, ?, ?, ?)')
    .run(99999, '孤儿', '孤儿行', 'log:session-ghost#seq=0', 'dsh-home', 'session-ghost', 0);
  const orphanInfo = store.searchIndexInfo();
  assert(orphanInfo.orphanFtsRows === 1 && orphanInfo.aligned === false, 'an orphan FTS row also breaks alignment: ' + JSON.stringify(orphanInfo));
  assertCode(function () { store.search('孤儿'); }, CODES.SEARCH_INDEX_STALE, 'orphan row blocks too');
  store.close();
});

// ── T65 exhausted 的保守语义 + candidatesTruncated 兼容字段 ────────────────
test('T65 P1c: exhausted is conservative (true = proven complete, false = merely not proven) and candidatesTruncated stays false', () => {
  const store = freshStore('t65');
  store.ingest(frameRecord({ seq: 0, text: 'zzz 无关 0' }));
  store.ingest(frameRecord({ seq: 1, text: 'zzz 无关 1' }));
  store.ingest(frameRecord({ seq: 2, text: 'P1c 真命中在最后一行 哨兵' }));  // 最后一行才是真命中

  // raw-scan 路径（ASCII 查询）：候选 = 全部 3 行，limit 只限制返回，不限制扫描。
  const wide = store.search('P1c', { limit: 10 });
  assert(wide.results.length === 1 && wide.exhausted === true, 'limit >= hits ⇒ the whole candidate stream was read: ' + JSON.stringify({ e: wide.exhausted, c: wide.candidates }));
  const narrow = store.search('P1c', { limit: 1 });
  assert(narrow.results.length === 1 && narrow.results[0].ptr === 'log:session-aaa#seq=2', 'the hit is returned (it is the last row, so nothing was skipped)');
  assert(narrow.exhausted === false, 'limit exactly met ⇒ false = "not proven complete" (conservative, not "there is more"): ' + narrow.exhausted);
  assert(wide.candidates === 3 && narrow.candidates === 3, 'both runs inspected all 3 candidates: ' + wide.candidates + '/' + narrow.candidates);
  assert(store.search('P1c', { limit: 3 }).exhausted === true, 'raising the limit turns the same query into a proven-complete scan');
  // CJK 路径（bigram 预筛）同一条保守语义：预筛只交回真候选，取够 limit 就停。
  assert(store.search('哨兵', { limit: 10 }).exhausted === true, 'CJK path: scanning to the end proves completeness');
  assert(store.search('哨兵', { limit: 1 }).exhausted === false, 'CJK path: meeting the limit exactly is "not proven", not "exhausted"');
  assert(wide.candidatesTruncated === false && narrow.candidatesTruncated === false, 'candidatesTruncated is a legacy field that no longer encodes truncation');
  store.close();
});

// ── T66 顶层 fileExists 与 checks.fileExists 一致（目录也算 false）──────────
test('T66 P1c: verifyPtrSample top-level fileExists agrees with checks.fileExists, and a directory counts as false', () => {
  const store = freshStore('t66');
  const root = p1cRoot('t66');
  mkdirSync(join(root, 'session-dir'), { recursive: true });
  store.ingest(frameRecord({ source: dshSource({ rawPath: root }), seq: 0, rawPath: join(root, 'session-dir'), text: 'dir body' }));

  const dirSample = store.verifyPtrSample({ ptr: 'log:session-aaa#seq=0', canonicalText: 'dir body' });
  assert(dirSample.checks.fileExists === false, 'a directory is not a file');
  assert(dirSample.fileExists === false, 'the top-level field must say the same thing, got ' + dirSample.fileExists);
  assert(dirSample.fileExists === dirSample.checks.fileExists, 'one name, one verdict');
  assert(dirSample.ok === false, 'a directory cannot pass P6 acceptance');

  writeFixture(root, 'session-aaa/frames.jsonl', 'file body');
  store.ingest(frameRecord({ source: dshSource({ rawPath: root }), seq: 1, rawPath: join(root, 'session-aaa', 'frames.jsonl'), text: 'file body' }));
  const fileSample = store.verifyPtrSample({ ptr: 'log:session-aaa#seq=1', canonicalText: 'file body' });
  assert(fileSample.fileExists === true && fileSample.checks.fileExists === true, 'a real file reads true on both');
  assert(fileSample.ok === true, 'and the sample passes');

  rmSync(join(root, 'session-aaa', 'frames.jsonl'), { force: true });
  const goneSample = store.verifyPtrSample({ ptr: 'log:session-aaa#seq=1', canonicalText: 'file body' });
  assert(goneSample.fileExists === false && goneSample.checks.fileExists === false && goneSample.ok === false, 'a deleted file reads false on both');
  store.close();
});

// ── 收尾 ─────────────────────────────────────────────────────────────────
const failed = results.filter(function (r) { return !r.ok; });
console.log('');
console.log('engine  : ' + process.version + ' / sqlite ' + engineInfo().sqliteVersion);
console.log('schema  : v' + SCHEMA_VERSION + ' (' + MIGRATIONS.map(function (m) { return m.version + ':' + m.name; }).join(', ') + ')');
console.log('temp db : ' + tempRoot);
console.log('result  : ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed, ' + results.length + ' total');

// 先把所有还开着的连接关掉，再删目录（否则 Windows 上 rmSync 会 EPERM）。
for (const s of openStores) {
  try { s.close(); } catch (_) { /* 已关闭或连接已损坏 */ }
}

let cleaned = false;
let cleanupError = null;
for (let attempt = 0; attempt < 6 && !cleaned; attempt += 1) {
  try {
    rmSync(tempRoot, { recursive: true, force: true });
    cleaned = true;
  } catch (err) {
    cleanupError = err;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
  }
}
if (cleaned) {
  console.log('cleanup : temp dbs removed (exists=' + existsSync(tempRoot) + ')');
} else {
  console.log('cleanup : temp dir kept (not a test failure): ' + (cleanupError && cleanupError.message));
}

if (failed.length > 0) process.exitCode = 1;
