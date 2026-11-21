#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// echo-index-source-snapshot-import-production-selftest.mjs
//   keeper 的**生产模式**护栏：每一条拒绝码一个用例，外加一次真的跑通。
//
// ★ 全部在 os.tmpdir() 里：库是 TEMP 里新建并 migrate 出来的 v10 副本，快照是合成的，
//   回执是合成的。**不碰真实库、不碰 live 索引、不读任何会话原档。**
// ★ 每个拒绝用例都额外核两件事，这才是"在打开库写之前拒"的证据：
//     ① 库文件的 sha256 一个位都没变；② journal 根本没被创建。
//   只看"抛了正确的码"不够 —— 一个先写后拒的实现也能让码对。
// ★ 变异证明：把 keeper 复制到 TEMP，关掉**回执哈希**与**库版本**两条判据，
//   对应的断言必须随之变红（即：这两种情形不再被拒）。判据能被关掉，才说明它真的在判。
// ─────────────────────────────────────────────────────────────────────────────
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openMetaStore, readSchemaState, SCHEMA_VERSION } from '../src/db/index.mjs';
import { importSnapshot, assertProductionGate, EXIT, BACKUP_RECEIPT_FIELDS, LIVE_MEMORY_INDEX_ROOT, RECEIPT_MAX_AGE_MS } from './echo-index-source-snapshot-import.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-snapshot-import-production-'));
process.on('exit', () => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* 清理失败不该掩盖原错误 */ } });
const T = '2026-11-16T00:00:00.000Z';
const NOW = Date.now();
const sha = (b) => createHash('sha256').update(b).digest('hex');
const isoAgo = (ms) => new Date(NOW - ms).toISOString();
const results = [];
const SKIP = Symbol('SKIP');
function check(label, fn) {
  const verdict = fn();
  results.push({ kind: verdict === SKIP ? 'SKIP' : 'PASS', label });
  return verdict;
}
function expectCode(fn, code) {
  try { fn(); } catch (e) {
    assert.equal(e.code, code, 'expected ' + code + ' got ' + e.code + ': ' + e.message);
    return e;
  }
  throw new Error('expected refusal ' + code + ' but nothing was thrown');
}
const fieldKey = (o) => Object.keys(o).sort().join(',');
const journalLines = (file) => fs.readFileSync(file, 'utf8').trimEnd().split('\n').filter((l) => l !== '').map(JSON.parse);

// ── 合成库 / 快照 / 回执 ────────────────────────────────────────────────────
// 库住在 ROOT/db/ 里（它自己一个目录），于是"journal 不许在库目录里"这条才可测：
// ROOT 本身是一个合法 journal 落点，ROOT/db 与 ROOT/db/* 都不是。
let dbSeq = 0;
const DB_DIR = path.join(ROOT, 'db');
const BAK_DIR = path.join(ROOT, 'bak');
fs.mkdirSync(DB_DIR, { recursive: true });
fs.mkdirSync(BAK_DIR, { recursive: true });
function makeDb(name) {
  const p = path.join(DB_DIR, (name || ('db-' + (++dbSeq))) + '.sqlite');
  const store = openMetaStore({ path: p, mode: 'readwrite' });
  try { store.migrate(); } finally { store.close(); }
  return p;
}
const WS = 'ws-synthetic';
const T0 = '2026-11-16T00:00:00.000Z';
let cmpSeq = 0;
function makeSource(sid, text, log) {
  return {
    sourceVersion: 'v4',
    sid,
    files: [{
      file: log, key: 'synth-key-' + sid, nextByte: 64, ws: WS, sid,
      nSum: 1, nWord: 1,
      sumOut: 'D:/AI/memory/hub/index/sum.jsonl', wordOut: 'D:/AI/memory/hub/index/word.jsonl',
    }],
    words: [{
      t: T0, session: sid, ws: WS, seq: 1, turn: null, log,
      role: 'user', kind: 'human', len: Array.from(text).length, truncated: false, text,
    }],
    summaries: [{
      // ★ cmp id 里**不许**出现 sid：keeper 的 sid 判据也扫内容列（cmp_id 不在白名单里），
      //   而 'cmp-session-x' 含 'session-x' —— 那是 fixture 自己撞上去，不是 keeper 的错。
      id: 'cmp-synth-' + (++cmpSeq), t: T0, session: sid, ws: WS, log, srcSeqs: [1],
      shadowedTokens: 1, chars: 1, provider: 'synthetic', model: 'synthetic', status: 'active',
      summary: 'summary ' + sid, manifest: { synthetic: true },
    }],
  };
}
let snapSeq = 0;
function writeSnapshot(name) {
  const p = path.join(ROOT, (name || ('snap-' + (++snapSeq))) + '.json');
  const sid = 'session-' + (name || ('snap' + snapSeq)).replace(/[^A-Za-z0-9._-]/g, '-');
  fs.writeFileSync(p, JSON.stringify({ sources: [makeSource(sid, 'synthetic body', 'D:/AI/memory/hub/index/sessions/' + sid + '.v4.zst')] }) + '\n', { flag: 'wx' });
  return p;
}
// 备份回执：字段**恰好**六个（与 keeper 的 BACKUP_RECEIPT_FIELDS 同源）
function writeReceipt(name, o) {
  const backupPath = o.backupPath;
  const backupBytes = o.backupBytes !== undefined ? o.backupBytes : fs.readFileSync(backupPath);
  const receipt = {
    backupPath,
    sha256: o.sha256 !== undefined ? o.sha256 : sha(backupBytes),
    bytes: o.bytes !== undefined ? o.bytes : backupBytes.length,
    schemaVersion: o.schemaVersion !== undefined ? o.schemaVersion : SCHEMA_VERSION,
    takenAt: o.takenAt !== undefined ? o.takenAt : isoAgo(60 * 1000),
    sourceDbPath: o.sourceDbPath,
  };
  const body = o.raw !== undefined ? o.raw : JSON.stringify(receipt, null, 2) + '\n';
  const p = path.join(ROOT, name + '.receipt.json');
  fs.writeFileSync(p, body);
  return { path: p, receipt, bytes: fs.readFileSync(p) };
}
// 一份"配好的"生产现场：库 + 备份 + 回执 + 快照。每个用例都从这里出发，只改一处。
function scene(name) {
  const db = makeDb(name);
  const backup = path.join(BAK_DIR, name + '.sqlite.bak');
  fs.copyFileSync(db, backup);
  const receipt = writeReceipt(name, { backupPath: backup, sourceDbPath: db });
  return { name, db, backup, receipt: receipt.path, receiptBytes: receipt.bytes, snapshot: writeSnapshot(name) };
}
function prodOpts(s, extra) {
  return Object.assign({
    generation: 1, builtAt: T, production: true,
    allowDb: s.db, backupReceipt: s.receipt,
  }, extra || {});
}
// 拒绝用例的统一证据：码对 + 库一个位没变 + journal 没被创建
function expectProdRefusal(s, code, extra, journalOverride) {
  const journal = journalOverride === undefined ? path.join(ROOT, s.name + '.journal.jsonl') : journalOverride;
  const before = sha(fs.readFileSync(s.db));
  const e = expectCode(() => importSnapshot(s.snapshot, s.db, journal, prodOpts(s, extra)), code);
  assert.equal(sha(fs.readFileSync(s.db)), before, 'a refused production run must not change one byte of the database');
  assert.equal(fs.existsSync(journal), false, 'a refused production run must not create the journal');
  return e;
}

// ── ① 默认行为一个字没变 ────────────────────────────────────────────────────
check('default (no --production): a database outside TEMP is still refused with TEMP_ONLY', () => {
  const s = scene('default-temp-only');
  // 一个**存在于 TEMP 之外**的文件当库：这条判据针对的是真路径，不是字符串。
  const outside = path.join(HERE, 'echo-index-source-snapshot-import.mjs');
  const journal = path.join(ROOT, 'default.jsonl');
  expectCode(() => importSnapshot(s.snapshot, outside, journal, { generation: 1, builtAt: T }), 'TEMP_ONLY');
  assert.equal(fs.existsSync(journal), false);
});

check('default (no --production): a TEMP database still works, and the journal says temp-only', () => {
  const s = scene('default-ok');
  const journal = path.join(ROOT, 'default-ok.jsonl');
  const r = importSnapshot(s.snapshot, s.db, journal, { generation: 1, builtAt: T });
  assert.equal(r.ok, true);
  assert.equal(r.imported, 1);
  const header = JSON.parse(fs.readFileSync(journal, 'utf8').split('\n')[0]);
  assert.equal(header.mode, 'temp-only');
  assert.equal(header.production, null);
});

// ── ② 生产模式跑通 ─────────────────────────────────────────────────────────
check('production: a TEMP database standing in for production imports, and the journal header records the receipt sha (not paths)', () => {
  const s = scene('prod-ok');
  const journal = path.join(ROOT, 'prod-ok.jsonl');
  const r = importSnapshot(s.snapshot, s.db, journal, prodOpts(s));
  assert.equal(r.ok, true);
  assert.equal(r.imported, 1);
  assert.equal(r.outcomes[0].outcome, 'IMPORTED');
  const headerLine = fs.readFileSync(journal, 'utf8').split('\n')[0];
  const header = JSON.parse(headerLine);
  assert.equal(header.mode, 'production');
  assert.equal(header.production.receiptFileSha256, sha(s.receiptBytes), 'the header must pin the receipt file it ran under');
  assert.equal(header.production.schemaVersionAtOpen, SCHEMA_VERSION);
  assert.equal(typeof header.production.backupSha256, 'string');
  // ★ 不记路径：header 里不许出现任何盘符字面量
  assert.equal(/[A-Za-z]:[\\/]/.test(headerLine), false, 'journal header must not carry a local path');
  assert.equal(headerLine.indexOf(os.tmpdir()) === -1, true);
});

check('production dangling refs: strict default refuses before commit, explicit opt-in imports refs and records counts without identity or text', () => {
  const strict = scene('prod-dangling-strict');
  const strictSource = makeSource('fixture-strict-dangling', 'strict body', 'D:/AI/memory/hub/index/sessions/strict-dangling.v4.zst');
  strictSource.files[0].sid = strictSource.sid;
  strictSource.summaries[0].srcSeqs = [1, 2, 1];
  const strictSnapshot = path.join(ROOT, 'prod-dangling-strict-input.json');
  fs.writeFileSync(strictSnapshot, JSON.stringify({ sources: [strictSource] }) + '\n', { flag: 'wx' });
  strict.snapshot = strictSnapshot;
  const strictJournal = path.join(ROOT, 'prod-dangling-strict.jsonl');
  const before = sha(fs.readFileSync(strict.db));
  const strictResult = importSnapshot(strict.snapshot, strict.db, strictJournal, prodOpts(strict));
  assert.equal(strictResult.failed, 1);
  assert.equal(strictResult.outcomes[0].code, 'BUILD_REFUSED');
  assert.equal(strictResult.outcomes[0].counts.srcSeqRefs, 3);
  assert.equal(strictResult.outcomes[0].counts.srcSeqResolved, 2);
  assert.equal(strictResult.outcomes[0].counts.srcSeqDangling, 1);
  const strictLines = fs.readFileSync(strictJournal, 'utf8').trimEnd().split('\n').map(JSON.parse);
  assert.equal(strictLines[0].allowDanglingSrcSeq, false);
  assert.equal(strictLines[1].outcome, 'FAILED');
  assert.equal(strictLines[1].counts.srcSeqRefs, 3);
  assert.equal(strictLines[1].counts.srcSeqResolved, 2);
  assert.equal(strictLines[1].counts.srcSeqDangling, 1);
  assert.equal(sha(fs.readFileSync(strict.db)), before);

  const enabled = scene('prod-dangling-enabled');
  const enabledSource = makeSource('fixture-enabled-dangling', 'enabled body', 'D:/AI/memory/hub/index/sessions/enabled-dangling.v4.zst');
  enabledSource.summaries[0].srcSeqs = [1, 2, 1];
  const enabledSnapshot = path.join(ROOT, 'prod-dangling-enabled-input.json');
  fs.writeFileSync(enabledSnapshot, JSON.stringify({ sources: [enabledSource] }) + '\n', { flag: 'wx' });
  enabled.snapshot = enabledSnapshot;
  const enabledJournal = path.join(ROOT, 'prod-dangling-enabled.jsonl');
  const enabledResult = importSnapshot(enabled.snapshot, enabled.db, enabledJournal, prodOpts(enabled, { allowDanglingSrcSeq: true }));
  assert.equal(enabledResult.imported, 1);
  assert.equal(enabledResult.outcomes[0].outcome, 'IMPORTED');
  const lines = fs.readFileSync(enabledJournal, 'utf8').trimEnd().split('\n').map(JSON.parse);
  assert.equal(lines[0].allowDanglingSrcSeq, true);
  assert.equal(lines[1].counts.srcSeqRefs, 3);
  assert.equal(lines[1].counts.srcSeqResolved, 2);
  assert.equal(lines[1].counts.srcSeqDangling, 1);
  assert.equal(JSON.stringify(lines).includes('session-enabled-dangling'), false);
  assert.equal(JSON.stringify(lines).includes('enabled body'), false);
  const dbStore = openMetaStore({ path: enabled.db, mode: 'readonly' });
  try {
    const source = dbStore.db.prepare('SELECT echo_source_id, source_version FROM echo_index_sources').get();
    const stored = dbStore.db.prepare('SELECT seq FROM echo_summary_src_seqs WHERE echo_source_id = ? ORDER BY ord').all(source.echo_source_id).map((r) => Number(r.seq));
    assert.deepEqual(stored, [1, 2, 1]);
    const summary = dbStore.db.prepare('SELECT cmp_id FROM echo_summaries WHERE echo_source_id = ?').get(source.echo_source_id);
    assert.equal(summary.cmp_id, enabledSource.summaries[0].id);
    assert.equal(dbStore.echoOpen('idx:' + summary.cmp_id).opensFrame, false);
  } finally { dbStore.close(); }
});

check('production: the backup file is not touched by the run (the receipt still describes it afterwards)', () => {
  const s = scene('prod-backup-intact');
  const before = sha(fs.readFileSync(s.backup));
  importSnapshot(s.snapshot, s.db, path.join(ROOT, 'prod-backup-intact.jsonl'), prodOpts(s));
  assert.equal(sha(fs.readFileSync(s.backup)), before, 'the backup must be exactly what the receipt described');
  // 也核一下回执本身没被改写：它落在 journal 之外，是审计凭据
  assert.equal(sha(fs.readFileSync(s.receipt)), sha(s.receiptBytes));
});

// ── ③ PRODUCTION_FLAG_INCOMPLETE ──────────────────────────────────────────
check('PRODUCTION_FLAG_INCOMPLETE: --production without --allow-db / --backup-receipt is refused', () => {
  const s = scene('flag-a');
  expectProdRefusal(s, 'PRODUCTION_FLAG_INCOMPLETE', { allowDb: undefined });
  expectProdRefusal(s, 'PRODUCTION_FLAG_INCOMPLETE', { backupReceipt: undefined });
  expectProdRefusal(s, 'PRODUCTION_FLAG_INCOMPLETE', { allowDb: '' });
  // --db 必须是绝对路径
  expectCode(() => assertProductionGate('relative.sqlite', path.join(ROOT, 'x.jsonl'), { allowDb: s.db, backupReceipt: s.receipt }), 'PRODUCTION_FLAG_INCOMPLETE');
});

// ── ④ PRODUCTION_DB_IS_LIVE_INDEX ─────────────────────────────────────────
check('PRODUCTION_DB_IS_LIVE_INDEX: the live memory hub index directory is refused before any filesystem access', () => {
  const s = scene('live-index');
  // 刻意用一个**不存在**的路径：能拿到这个码就证明判据在 stat 之前（字符串层）就已生效。
  const liveDb = LIVE_MEMORY_INDEX_ROOT + '/meta.sqlite';
  const e = expectCode(() => assertProductionGate(liveDb, path.join(ROOT, 'li.jsonl'), { allowDb: liveDb, backupReceipt: s.receipt }), 'PRODUCTION_DB_IS_LIVE_INDEX');
  assert.equal(typeof e.message, 'string');
  // 阳性对照：同一个函数，把库挪到 TEMP 下就过（证明拒绝来自落点，不是来自"总是拒"）
  const ok = assertProductionGate(s.db, path.join(ROOT, 'li-ok.jsonl'), { allowDb: s.db, backupReceipt: s.receipt });
  assert.equal(ok.schemaVersion, SCHEMA_VERSION);
});

// ── ⑤ PRODUCTION_DB_MISMATCH ──────────────────────────────────────────────
check('PRODUCTION_DB_MISMATCH: db != allowDb, a missing db, and a receipt taken from another database', () => {
  const s = scene('db-mismatch');
  const other = makeDb('db-mismatch-other');
  expectProdRefusal(s, 'PRODUCTION_DB_MISMATCH', { allowDb: other });
  // 库不存在
  expectCode(() => assertProductionGate(path.join(DB_DIR, 'ghost.sqlite'), path.join(ROOT, 'g.jsonl'), { allowDb: path.join(DB_DIR, 'ghost.sqlite'), backupReceipt: s.receipt }), 'PRODUCTION_DB_MISMATCH');
  // 回执写的是另一个库
  const badReceipt = path.join(ROOT, 'db-mismatch.receipt2.json');
  const body = JSON.parse(fs.readFileSync(s.receipt, 'utf8'));
  body.sourceDbPath = other;
  fs.writeFileSync(badReceipt, JSON.stringify(body) + '\n');
  expectProdRefusal(s, 'PRODUCTION_DB_MISMATCH', { backupReceipt: badReceipt });
});

// ── ⑥ PRODUCTION_DB_HARDLINKED ────────────────────────────────────────────
check('PRODUCTION_DB_HARDLINKED: a database with more than one hard link is refused', () => {
  const s = scene('hardlink');
  const link = path.join(ROOT, 'hardlink-alias.sqlite');
  fs.linkSync(s.db, link);
  try {
    assert.equal(fs.statSync(s.db).nlink > 1, true, 'the fixture must really be hard-linked');
    expectProdRefusal(s, 'PRODUCTION_DB_HARDLINKED');
  } finally {
    fs.rmSync(link, { force: true });
  }
});

// ── ⑦ PRODUCTION_JOURNAL_IN_DB_DIR ────────────────────────────────────────
check('PRODUCTION_JOURNAL_IN_DB_DIR: a journal in the database directory (or under it) is refused', () => {
  const s = scene('journal-dir');
  expectProdRefusal(s, 'PRODUCTION_JOURNAL_IN_DB_DIR', {}, path.join(DB_DIR, 'j.jsonl'));
  const sub = path.join(DB_DIR, 'sub');
  fs.mkdirSync(sub, { recursive: true });
  expectProdRefusal(s, 'PRODUCTION_JOURNAL_IN_DB_DIR', {}, path.join(sub, 'j.jsonl'));
  // 阳性对照：库目录之外的同一次调用是通过的
  const okJournal = path.join(ROOT, 'journal-dir-ok.jsonl');
  const r = importSnapshot(s.snapshot, s.db, okJournal, prodOpts(s));
  assert.equal(r.ok, true);
});

// ── ⑧ BACKUP_RECEIPT_INVALID ──────────────────────────────────────────────
check('BACKUP_RECEIPT_INVALID: missing file, wrong field set, and a malformed sha are all refused', () => {
  const s = scene('receipt-invalid');
  expectProdRefusal(s, 'BACKUP_RECEIPT_INVALID', { backupReceipt: path.join(ROOT, 'no-such-receipt.json') });
  const extra = path.join(ROOT, 'receipt-extra.json');
  const body = JSON.parse(fs.readFileSync(s.receipt, 'utf8'));
  body.checkedBy = 'somebody'; // 多一个字段 = 形状不对（回执是别人给的，形状不猜）
  fs.writeFileSync(extra, JSON.stringify(body) + '\n');
  expectProdRefusal(s, 'BACKUP_RECEIPT_INVALID', { backupReceipt: extra });
  const badSha = path.join(ROOT, 'receipt-badsha.json');
  const body2 = JSON.parse(fs.readFileSync(s.receipt, 'utf8'));
  body2.sha256 = 'NOT-A-SHA';
  fs.writeFileSync(badSha, JSON.stringify(body2) + '\n');
  expectProdRefusal(s, 'BACKUP_RECEIPT_INVALID', { backupReceipt: badSha });
  // 字段集与 keeper 的常量同源：抄错一个名字就红
  assert.deepEqual(BACKUP_RECEIPT_FIELDS.slice().sort(), ['backupPath', 'bytes', 'schemaVersion', 'sha256', 'sourceDbPath', 'takenAt']);
});

// ── ⑨ BACKUP_FILE_MISMATCH ────────────────────────────────────────────────
check('BACKUP_FILE_MISMATCH: a backup whose bytes do not match the receipt is refused', () => {
  const s = scene('backup-mismatch');
  const st = fs.statSync(s.backup);
  fs.truncateSync(s.backup, Math.max(0, st.size - 4096));
  // 回执还是原来那张（描述的是截断前那份字节）
  expectProdRefusal(s, 'BACKUP_FILE_MISMATCH');
  const e = expectProdRefusal(s, 'BACKUP_FILE_MISMATCH');
  assert.equal(e.detail.actualBytes < e.detail.declaredBytes, true);
});

// ── ⑩ SCHEMA_VERSION_MISMATCH ─────────────────────────────────────────────
check('SCHEMA_VERSION_MISMATCH: a receipt from another schema generation is refused', () => {
  const s = scene('schema-mismatch');
  const p = path.join(ROOT, 'schema-mismatch.receipt-old.json');
  const body = JSON.parse(fs.readFileSync(s.receipt, 'utf8'));
  body.schemaVersion = SCHEMA_VERSION - 1;
  fs.writeFileSync(p, JSON.stringify(body) + '\n');
  const e = expectProdRefusal(s, 'SCHEMA_VERSION_MISMATCH', { backupReceipt: p });
  assert.equal(e.detail.liveSchemaVersion, SCHEMA_VERSION);
  assert.equal(e.detail.receiptSchemaVersion, SCHEMA_VERSION - 1);
});

// ── ⑪ BACKUP_STALE ────────────────────────────────────────────────────────
check('BACKUP_STALE: a receipt older than 24 hours — or stamped in the future — is refused', () => {
  const s = scene('stale');
  const old = path.join(ROOT, 'stale.receipt-old.json');
  const b1 = JSON.parse(fs.readFileSync(s.receipt, 'utf8'));
  b1.takenAt = isoAgo(RECEIPT_MAX_AGE_MS + 60 * 60 * 1000);
  fs.writeFileSync(old, JSON.stringify(b1) + '\n');
  expectProdRefusal(s, 'BACKUP_STALE', { backupReceipt: old });
  const fut = path.join(ROOT, 'stale.receipt-future.json');
  const b2 = JSON.parse(fs.readFileSync(s.receipt, 'utf8'));
  b2.takenAt = new Date(NOW + 60 * 60 * 1000).toISOString();
  fs.writeFileSync(fut, JSON.stringify(b2) + '\n');
  expectProdRefusal(s, 'BACKUP_STALE', { backupReceipt: fut });
  // 阳性对照：正好在窗口内（23 小时）不拒
  const fresh = path.join(ROOT, 'stale.receipt-fresh.json');
  const b3 = JSON.parse(fs.readFileSync(s.receipt, 'utf8'));
  b3.takenAt = isoAgo(23 * 60 * 60 * 1000);
  fs.writeFileSync(fresh, JSON.stringify(b3) + '\n');
  const okJournal = path.join(ROOT, 'stale-ok.jsonl');
  assert.equal(importSnapshot(s.snapshot, s.db, okJournal, prodOpts(s, { backupReceipt: fresh })).ok, true);
});

// ── ⑫ CLI ─────────────────────────────────────────────────────────────────
const NODE_BIN = process.env.ECHO_NODE_BIN || 'C:/Users/pc/.workbuddy/binaries/node/versions/22.22.2-3/node.exe';
check('CLI: --production gates are enforced through argv (exit 3), and a full production argv run exits 0', () => {
  assert.equal(fs.existsSync(NODE_BIN), true, 'no usable node binary at ' + NODE_BIN + ' — this is a FAILURE, not a skip');
  const KEEPER = path.join(HERE, 'echo-index-source-snapshot-import.mjs');
  const s = scene('cli');
  // ① --production 但没有 --allow-db
  const j1 = path.join(ROOT, 'cli-1.jsonl');
  const r1 = spawnSync(NODE_BIN, [KEEPER, '--snapshot', s.snapshot, '--db', s.db, '--journal', j1, '--generation', '1', '--built-at', T, '--production', '--backup-receipt', s.receipt], { encoding: 'utf8' });
  assert.equal(r1.status, EXIT.refused, 'stderr=' + r1.stderr);
  assert.equal(JSON.parse(r1.stderr.trim().split('\n').pop()).code, 'PRODUCTION_FLAG_INCOMPLETE');
  assert.equal(fs.existsSync(j1), false);
  // ② 只给 --allow-db 不给 --production：说错了，不许静默忽略
  const r2 = spawnSync(NODE_BIN, [KEEPER, '--snapshot', s.snapshot, '--db', s.db, '--journal', path.join(ROOT, 'cli-2.jsonl'), '--generation', '1', '--built-at', T, '--allow-db', s.db], { encoding: 'utf8' });
  assert.equal(r2.status, EXIT.usage, 'stderr=' + r2.stderr);
  assert.equal(JSON.parse(r2.stderr.trim().split('\n').pop()).code, 'USAGE_UNKNOWN_FLAG');
  // ③ dangling opt-in without --production is a usage refusal before snapshot/db access.
  const rDanglingTemp = spawnSync(NODE_BIN, [KEEPER, '--snapshot', s.snapshot, '--db', s.db, '--journal', path.join(ROOT, 'cli-dangling-temp.jsonl'), '--generation', '1', '--built-at', T, '--allow-dangling-srcseq'], { encoding: 'utf8' });
  assert.equal(rDanglingTemp.status, EXIT.usage, 'stderr=' + rDanglingTemp.stderr);
  assert.equal(JSON.parse(rDanglingTemp.stderr.trim().split('\n').pop()).code, 'USAGE_UNKNOWN_FLAG');
  // ④ 完整 production flags, but no dangling opt-in: strict default must still refuse.
  const strictSnap = path.join(ROOT, 'cli-strict-dangling.json');
  const strictSource = makeSource('fixture-cli-strict', 'strict text', 'D:/AI/memory/hub/index/sessions/strict.v4.zst');
  strictSource.files[0].sid = strictSource.sid;
  strictSource.summaries[0].srcSeqs = [1, 2];
  fs.writeFileSync(strictSnap, JSON.stringify({ sources: [strictSource] }) + '\n', { flag: 'wx' });
  const strictScene = { ...scene('cli-strict'), snapshot: strictSnap };
  const jStrict = path.join(ROOT, 'cli-strict-dangling.jsonl');
  const strictRun = spawnSync(NODE_BIN, [KEEPER, '--snapshot', strictScene.snapshot, '--db', strictScene.db, '--journal', jStrict, '--generation', '1', '--built-at', T, '--production', '--allow-db', strictScene.db, '--backup-receipt', strictScene.receipt], { encoding: 'utf8' });
  assert.equal(strictRun.status, EXIT.unfinished, 'stdout=' + strictRun.stdout + ' stderr=' + strictRun.stderr);
  const strictJournal = fs.readFileSync(jStrict, 'utf8').trimEnd().split('\n').map(JSON.parse);
  assert.equal(strictJournal[0].allowDanglingSrcSeq, false);
  assert.equal(strictJournal[1].outcome, 'FAILED');
  assert.equal(strictJournal[1].counts.srcSeqRefs, 2);
  assert.equal(strictJournal[1].counts.srcSeqResolved, 1);
  assert.equal(strictJournal[1].counts.srcSeqDangling, 1);
  // ⑤ production opt-in builds/imports into TEMP DB and records counts, preserving the refs.
  const optSnap = path.join(ROOT, 'cli-opt-in-input.json');
  const optSource = makeSource('fixture-cli-opt-in', 'opt text', 'D:/AI/memory/hub/index/sessions/opt.v4.zst');
  optSource.files[0].sid = optSource.sid;
  optSource.summaries[0].srcSeqs = [1, 2, 1];
  fs.writeFileSync(optSnap, JSON.stringify({ sources: [optSource] }) + '\n', { flag: 'wx' });
  const optScene = { ...scene('cli-dangling-opt-in'), snapshot: optSnap };
  const jOpt = path.join(ROOT, 'cli-dangling-opt-in.jsonl');
  const optRun = spawnSync(NODE_BIN, [KEEPER, '--snapshot', optScene.snapshot, '--db', optScene.db, '--journal', jOpt, '--generation', '1', '--built-at', T, '--production', '--allow-db', optScene.db, '--backup-receipt', optScene.receipt, '--allow-dangling-srcseq'], { encoding: 'utf8' });
  assert.equal(optRun.status, EXIT.ok, 'stdout=' + optRun.stdout + ' stderr=' + optRun.stderr);
  const optJournal = fs.readFileSync(jOpt, 'utf8').trimEnd().split('\n').map(JSON.parse);
  assert.equal(optJournal[0].allowDanglingSrcSeq, true);
  assert.equal(optJournal[1].outcome, 'IMPORTED');
  assert.equal(optJournal[1].counts.srcSeqRefs, 3);
  assert.equal(optJournal[1].counts.srcSeqResolved, 2);
  assert.equal(optJournal[1].counts.srcSeqDangling, 1);
  const optStore = openMetaStore({ path: optScene.db, mode: 'readonly' });
  try {
    const source = optStore.db.prepare('SELECT echo_source_id FROM echo_index_sources').get();
    const seqs = optStore.db.prepare('SELECT seq FROM echo_summary_src_seqs WHERE echo_source_id=? ORDER BY ord').all(source.echo_source_id).map((r) => Number(r.seq));
    assert.deepEqual(seqs, [1, 2, 1]);
  } finally { optStore.close(); }
  // ⑥ 完整 production argv with strict default → 0
  const j3 = path.join(ROOT, 'cli-3.jsonl');
  const r3 = spawnSync(NODE_BIN, [KEEPER, '--snapshot', s.snapshot, '--db', s.db, '--journal', j3, '--generation', '1', '--built-at', T, '--production', '--allow-db', s.db, '--backup-receipt', s.receipt], { encoding: 'utf8' });
  assert.equal(r3.status, EXIT.ok, 'stdout=' + r3.stdout + ' stderr=' + r3.stderr);
  const header = JSON.parse(fs.readFileSync(j3, 'utf8').split('\n')[0]);
  assert.equal(header.mode, 'production');
  assert.equal(header.allowDanglingSrcSeq, false);
  // CLI 的 stdout 只回脱敏摘要：不许有盘符
  assert.equal(/[A-Za-z]:[\\/]/.test(r3.stdout), false, 'CLI stdout must stay path-free');
});

// ── ⑬ 快照仍然是 TEMP-only（生产模式也不放松）──────────────────────────────
check('production does NOT relax the snapshot guard: a snapshot outside TEMP is still refused', () => {
  const s = scene('snap-outside');
  const outside = path.join(HERE, 'echo-index-source-snapshot-import.mjs');
  const journal = path.join(ROOT, 'snap-outside.jsonl');
  expectCode(() => importSnapshot(outside, s.db, journal, prodOpts(s)), 'TEMP_ONLY');
  assert.equal(fs.existsSync(journal), false, 'the refusal must happen before the journal is created');
});

// ── ⑭ 变异证明：判据能被关掉，才说明它真的在判 ─────────────────────────────
// 做法：把 keeper 复制到 TEMP，**把相对 import 改写成绝对 file:// URL**（于是副本不依赖
// 目录结构、也不复制整个仓库），再动一处文本关掉一条判据，然后用真现场跑同一个用例。
// 关掉之后"必须不再拒" —— 否则说明红是别的原因红的。
function mutatedKeeper(name, mutations) {
  let src = fs.readFileSync(path.join(HERE, 'echo-index-source-snapshot-import.mjs'), 'utf8');
  src = src.replace(/from '(\.\/|\.\.\/)([^']+)'/g, (m, pre, rest) => "from '" + pathToFileURL(path.resolve(HERE, pre + rest)).href + "'");
  for (const m of mutations) {
    assert.equal(src.includes(m.from), true, 'mutation anchor not found (the check moved): ' + m.label);
    src = src.split(m.from).join(m.to);
  }
  const p = path.join(ROOT, 'mutated-' + name + '.mjs');
  fs.writeFileSync(p, src);
  return pathToFileURL(p).href;
}
async function checkAsync(label, fn) {
  const verdict = await fn();
  results.push({ kind: verdict === SKIP ? 'SKIP' : 'PASS', label });
  return verdict;
}

await checkAsync('mutation: with the receipt-hash check removed, the backup-mismatch scene is no longer refused', async () => {
  const M = await import(mutatedKeeper('no-hash-check', [{
    label: 'receipt hash/size check',
    from: 'if (backupActualBytes !== receipt.bytes || backupActualSha !== receipt.sha256) {',
    to: 'if (false) {',
  }]));
  const s = scene('mut-hash');
  const st = fs.statSync(s.backup);
  fs.truncateSync(s.backup, Math.max(0, st.size - 4096));
  // 真模块：拒
  expectCode(() => importSnapshot(s.snapshot, s.db, path.join(ROOT, 'mut-hash-a.jsonl'), prodOpts(s)), 'BACKUP_FILE_MISMATCH');
  // 变异模块：同一次调用不再拒（判据被关掉后确实没人拦它了）
  const r = M.importSnapshot(s.snapshot, s.db, path.join(ROOT, 'mut-hash-b.jsonl'), prodOpts(s));
  assert.equal(r.ok, true, 'with the check removed the run must proceed — if it still refused, the red was coming from somewhere else');
  assert.equal(r.imported, 1);
});

await checkAsync('mutation: with the schema-version check removed, a receipt from another schema generation is no longer refused', async () => {
  const M = await import(mutatedKeeper('no-schema-check', [{
    label: 'schema version check',
    from: 'if (receipt.schemaVersion !== liveSchema) {',
    to: 'if (false) {',
  }]));
  const s = scene('mut-schema');
  const p = path.join(ROOT, 'mut-schema.receipt.json');
  const body = JSON.parse(fs.readFileSync(s.receipt, 'utf8'));
  body.schemaVersion = SCHEMA_VERSION - 1;
  fs.writeFileSync(p, JSON.stringify(body) + '\n');
  expectCode(() => importSnapshot(s.snapshot, s.db, path.join(ROOT, 'mut-schema-a.jsonl'), prodOpts(s, { backupReceipt: p })), 'SCHEMA_VERSION_MISMATCH');
  const r = M.importSnapshot(s.snapshot, s.db, path.join(ROOT, 'mut-schema-b.jsonl'), prodOpts(s, { backupReceipt: p }));
  assert.equal(r.ok, true);
  assert.equal(r.imported, 1);
});

await checkAsync('mutation: the mutated copy really is a different file (so the two runs above were not the same code twice)', async () => {
  const a = sha(fs.readFileSync(path.join(ROOT, 'mutated-no-hash-check.mjs')));
  const b = sha(fs.readFileSync(path.join(ROOT, 'mutated-no-schema-check.mjs')));
  const real = sha(fs.readFileSync(path.join(HERE, 'echo-index-source-snapshot-import.mjs')));
  assert.notEqual(a, real);
  assert.notEqual(b, real);
  assert.notEqual(a, b);
});

// ── 报表 ───────────────────────────────────────────────────────────────────
const pass = results.filter((r) => r.kind === 'PASS').length;
const skip = results.filter((r) => r.kind === 'SKIP').length;
console.log(results.map((r) => r.kind + ' ' + r.label).join('\n'));
console.log(results.length + ' checks, ' + pass + ' passed, ' + skip + ' skipped (a skip is NOT a pass)');
