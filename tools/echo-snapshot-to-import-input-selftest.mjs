#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// echo-snapshot-to-import-input-selftest.mjs — 合成冻结快照，覆盖 producer 的每一条判据
//
// ★ 全部在 os.tmpdir() 里造：合成快照（manifest + files.jsonl + 分片）、合成 override、
//   合成 v10 库。**不读任何真实快照、不读任何真实库、不读会话原档。**
//   所有 sid / 正文都是合成的 inert 字符串。
//
// ★ 每个拒绝码都有**正反两面**：拒了之后还要问一句"在合法输入上它是不是不拒"。
//   只测"会拒"的套件，把判据改成一概拒绝也会全绿。
//
// ★ 最后一条是端到端：producer 的输出**直接喂给 keeper**（echo-index-source-snapshot-import.mjs），
//   在全新 TEMP v10 库上期望 IMPORTED。这是这个 producer 存在的理由，也是唯一能证明
//   "它产出的形状 keeper 真的吃得下"的断言 —— 光看字段名对得上不算。
// ─────────────────────────────────────────────────────────────────────────────
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { computeSnapshotDigest, FORMAT as SNAPSHOT_FORMAT } from './echo-index-freeze.mjs';
import * as P from './echo-snapshot-to-import-input.mjs';
import { importSnapshot } from './echo-index-source-snapshot-import.mjs';
import { openMetaStore } from '../src/db/index.mjs';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-snap-input-selftest-'));
process.on('exit', () => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* 清理失败不该掩盖原错误 */ } });
const T = '2026-11-16T00:00:00.000Z';
const sha = (b) => createHash('sha256').update(b).digest('hex');
// 合成的"生产索引根"：行里的绝对路径指向它，快照里则是它下面的相对路径。
const PROD_ROOT = 'D:/synthetic/prod-index';
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
const fieldKey = (obj) => Object.keys(obj).sort().join(',');
const WORD_FIELDS = fieldKey({ t: 1, session: 1, ws: 1, seq: 1, turn: 1, log: 1, role: 1, kind: 1, len: 1, truncated: 1, text: 1 });
const SUM_FIELDS = fieldKey({ id: 1, t: 1, session: 1, ws: 1, log: 1, srcSeqs: 1, shadowedTokens: 1, chars: 1, provider: 1, model: 1, status: 1, summary: 1, manifest: 1 });
const FILE_FIELDS = fieldKey({ file: 1, key: 1, nextByte: 1, ws: 1, sid: 1, nSum: 1, nWord: 1, sumOut: 1, wordOut: 1 });

// ── 合成行（字段集精确 == 权威 ECHO 索引形状）─────────────────────────────────
const logFor = (sid, variant) => PROD_ROOT + '/sessions/' + sid + '/session.' + variant + '.jsonl';
function wordRow(sid, seq, text, ws) {
  return {
    t: T, session: sid, ws, seq, turn: null, log: logFor(sid, 'v4'),
    role: 'user', kind: 'human', len: Array.from(text).length, truncated: false, text,
  };
}
function sumRow(sid, id, srcSeqs, ws) {
  return {
    id, t: T, session: sid, ws, log: logFor(sid, 'v4'), srcSeqs,
    shadowedTokens: 1, chars: 1, provider: 'synthetic', model: 'synthetic', status: 'active',
    summary: 'synthetic summary ' + id, manifest: { synthetic: true },
  };
}
const WS = 'ws-synthetic';
const jsonl = (rows) => Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');

// ── 合成冻结快照 ────────────────────────────────────────────────────────────
// spec.sources: [{ variant, sid, base, wordRows, sumRows, declareWord?: <path>, declareSum?: <path> }]
// 分片按 base 落一处：两个源声明同一个 base = 共享分片对（生产侧覆盖的真实形状）。
// spec.opts:
//   sourceRoot      manifest.sourceRoot（默认 PROD_ROOT）
//   dropShardRel    写完之后把某个相对路径的分片删掉（造"manifest 声明了但文件不在"）
//   tamperShardRel  写完之后改一个分片内容（造 sha 不符）
//   digestOverride  直接把 manifest.snapshotDigest 改成别的值（造 digest 不符）
//   dropFilesRecord 不把 files.jsonl 记进 manifest
function buildSnapshot(name, spec) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(path.join(dir, 'shards'), { recursive: true });
  const sourceRoot = spec.opts && spec.opts.sourceRoot !== undefined ? spec.opts.sourceRoot : PROD_ROOT;
  const shardByBase = new Map();
  const filesRows = [];
  for (const s of spec.sources) {
    const base = s.base || (s.variant + '-' + s.sid);
    if (!shardByBase.has(base)) {
      shardByBase.set(base, {
        word: s.wordRows === undefined ? [wordRow(s.sid, 1, 'word one of ' + base, WS)] : s.wordRows,
        sum: s.sumRows === undefined ? [] : s.sumRows,
      });
    }
    const declaredWord = s.declareWord !== undefined ? s.declareWord : (sourceRoot + '/shards/' + base + '.word.jsonl');
    const declaredSum = s.declareSum !== undefined ? s.declareSum : (sourceRoot + '/shards/' + base + '.sum.jsonl');
    const shard = shardByBase.get(base);
    filesRows.push({
      file: s.fileOverride !== undefined ? s.fileOverride : (sourceRoot + '/sessions/' + s.sid + '/session.' + s.variant + '.jsonl'),
      key: 'synth-key-' + base + '-' + s.variant,
      nextByte: 128,
      ws: WS,
      sid: s.sid,
      nSum: s.nSum !== undefined ? s.nSum : shard.sum.length,
      nWord: s.nWord !== undefined ? s.nWord : shard.word.length,
      sumOut: declaredSum,
      wordOut: declaredWord,
    });
  }
  const records = [];
  const filesBytes = jsonl(filesRows);
  if (!(spec.opts && spec.opts.dropFilesRecord)) {
    fs.writeFileSync(path.join(dir, 'files.jsonl'), filesBytes);
    records.push({ path: 'files.jsonl', role: 'files', sha256: sha(filesBytes), bytes: filesBytes.length });
  }
  const written = [];
  for (const [base, shard] of shardByBase) {
    for (const [kind, rows] of [['word', shard.word], ['sum', shard.sum]]) {
      const rel = 'shards/' + base + '.' + kind + '.jsonl';
      const bytes = jsonl(rows);
      fs.writeFileSync(path.join(dir, rel.split('/').join(path.sep)), bytes);
      records.push({ path: rel, role: 'shard', sha256: sha(bytes), bytes: bytes.length });
      written.push(rel);
    }
  }
  if (spec.opts && spec.opts.dropShardRel) fs.rmSync(path.join(dir, spec.opts.dropShardRel.split('/').join(path.sep)), { force: true });
  if (spec.opts && spec.opts.tamperShardRel) {
    const p = path.join(dir, spec.opts.tamperShardRel.split('/').join(path.sep));
    fs.writeFileSync(p, Buffer.concat([fs.readFileSync(p), Buffer.from('\n', 'utf8')]));
  }
  const totalBytes = records.reduce((a, r) => a + r.bytes, 0);
  const manifest = {
    format: SNAPSHOT_FORMAT,
    sourceRoot,
    fileCount: records.length,
    totalBytes,
    files: records,
    snapshotDigest: (spec.opts && spec.opts.digestOverride) || computeSnapshotDigest(records),
    snapshotDigestRule: 'sha256 of sorted "path\\nsha256\\nbytes\\n" concatenation (byte-ordered by path)',
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { dir, manifest, records, written, filesBytes, sourceRoot };
}

// 落点目录：所有产物都写进 TEMP 下的 out-* 目录
function outDir(name) {
  const d = path.join(ROOT, 'out-' + name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function produceOk(name, snapDir, extra) {
  const d = outDir(name);
  const out = path.join(d, 'import-input.json');
  const r = P.produceImportInput(Object.assign({ snapshotDir: snapDir, outDir: d, out: out }, extra || {}));
  assert.equal(r.ok, true);
  return { result: r, out, dir: d };
}

// ── ① 快乐路径：v3 + v4 两个源 ───────────────────────────────────────────────
const happy = buildSnapshot('happy', {
  sources: [
    {
      variant: 'v3', sid: 'session-a',
      wordRows: [wordRow('session-a', 1, 'alpha one', WS)],
      sumRows: [sumRow('session-a', 'cmp-a', [1], WS)],
    },
    {
      variant: 'v4', sid: 'session-b',
      wordRows: [wordRow('session-b', 1, 'beta one', WS), wordRow('session-b', 2, 'beta two', WS)],
      sumRows: [],
    },
  ],
});
check('happy: two sources, digest verified, counts and variants right', () => {
  const r = produceOk('happy', happy.dir).result;
  assert.equal(r.sources, 2);
  assert.equal(r.words, 3);
  assert.equal(r.summaries, 1);
  assert.equal(r.filesRows, 2);
  assert.deepEqual(r.variants, { v3: 1, v4: 1 });
  assert.equal(r.sharedPairs, 0);
  assert.equal(r.overridesApplied, 0);
  assert.equal(r.snapshotDigest, happy.manifest.snapshotDigest);
  assert.equal(r.overridesApplied, 0);
});

check('happy: output JSON carries exactly the keeper field sets, and the report sha equals the file on disk', () => {
  const { result, out } = produceOk('happy-shape', happy.dir);
  const bytes = fs.readFileSync(out);
  assert.equal(sha(bytes), result.outputSha256, 'reported sha must be the bytes on disk');
  assert.equal(bytes.length, result.outputBytes);
  const parsed = JSON.parse(bytes.toString('utf8'));
  assert.equal(Array.isArray(parsed.sources), true);
  assert.equal(parsed.sources.length, 2);
  for (const s of parsed.sources) {
    assert.equal(s.sourceVersion === 'v3' || s.sourceVersion === 'v4', true);
    assert.equal(s.namespace, s.sourceVersion === 'v3' ? 'log' : 'v4log');
    assert.equal(s.files.length, 1);
    assert.equal(fieldKey(s.files[0]), FILE_FIELDS, 'files row must be exactly ECHO_INDEX_FILE_FIELDS');
    for (const w of s.words) assert.equal(fieldKey(w), WORD_FIELDS);
    for (const m of s.summaries) assert.equal(fieldKey(m), SUM_FIELDS);
    // 声明计数必须等于实际行数（keeper 的 COUNT_MISMATCH 就是这条）
    assert.equal(s.files[0].nWord, s.words.length);
    assert.equal(s.files[0].nSum, s.summaries.length);
    assert.equal(s.files[0].sid, s.sid);
    for (const w of s.words) assert.equal(w.session, s.sid);
  }
});

check('happy: provenance carries counts and hashes only — no local path, no sid', () => {
  const { out } = produceOk('happy-prov', happy.dir);
  const parsed = JSON.parse(fs.readFileSync(out, 'utf8'));
  const prov = JSON.stringify(parsed.provenance);
  assert.equal(prov.indexOf('D:/') === -1, true, 'provenance must not carry a path');
  assert.equal(prov.indexOf('session-a') === -1, true, 'provenance must not carry a sid');
  assert.equal(prov.indexOf('session-b') === -1, true, 'provenance must not carry a sid');
  assert.equal(parsed.provenance.format, 'echo-snapshot-import-input/1');
  assert.equal(parsed.provenance.snapshotDigest, happy.manifest.snapshotDigest);
});

check('happy: the same input produces the same bytes (no timestamp in the output)', () => {
  const a = produceOk('happy-det-a', happy.dir).result.outputSha256;
  const b = produceOk('happy-det-b', happy.dir).result.outputSha256;
  assert.equal(a, b);
});

// ── ② 落点守卫 ──────────────────────────────────────────────────────────────
check('OUT_FORBIDDEN_ROOT: agent-soul and memory roots are refused for both --out and --out-dir', () => {
  const d = outDir('forbidden');
  expectCode(() => P.produceImportInput({ snapshotDir: happy.dir, outDir: 'D:/AI/agent-soul/tools', out: 'D:/AI/agent-soul/tools/never.json' }), 'OUT_FORBIDDEN_ROOT');
  expectCode(() => P.produceImportInput({ snapshotDir: happy.dir, outDir: 'D:/AI/memory/hub', out: 'D:/AI/memory/hub/never.json' }), 'OUT_FORBIDDEN_ROOT');
  assert.equal(fs.existsSync('D:/AI/agent-soul/tools/never.json'), false);
  // 阳性对照：TEMP 下的目录不拒
  const okOut = path.join(d, 'ok.json');
  assert.equal(P.produceImportInput({ snapshotDir: happy.dir, outDir: d, out: okOut }).ok, true);
  assert.equal(fs.existsSync(okOut), true);
});

check('OUT_NOT_IN_OUT_DIR and OUT_EXISTS are distinct refusals', () => {
  const d = outDir('inside');
  const elsewhere = path.join(ROOT, 'elsewhere');
  fs.mkdirSync(elsewhere, { recursive: true });
  expectCode(() => P.produceImportInput({ snapshotDir: happy.dir, outDir: d, out: path.join(elsewhere, 'x.json') }), 'OUT_NOT_IN_OUT_DIR');
  const out = path.join(d, 'twice.json');
  P.produceImportInput({ snapshotDir: happy.dir, outDir: d, out });
  expectCode(() => P.produceImportInput({ snapshotDir: happy.dir, outDir: d, out }), 'OUT_EXISTS');
  expectCode(() => P.produceImportInput({ snapshotDir: happy.dir, outDir: path.join(ROOT, 'no-such-dir'), out: path.join(ROOT, 'no-such-dir', 'x.json') }), 'OUT_DIR_INVALID');
});

check('SNAPSHOT_DIR_INVALID / USAGE_* are refusals, not crashes', () => {
  const d = outDir('usage');
  expectCode(() => P.produceImportInput({ snapshotDir: path.join(ROOT, 'nope'), outDir: d, out: path.join(d, 'a.json') }), 'SNAPSHOT_DIR_INVALID');
  expectCode(() => P.parseArgs([]), 'USAGE_MISSING_ARG');
  expectCode(() => P.parseArgs(['--nope', 'x']), 'USAGE_UNKNOWN_FLAG');
  expectCode(() => P.parseArgs(['--out', 'a', '--out', 'b']), 'USAGE_DUPLICATE_FLAG');
  expectCode(() => P.produceImportInput({}), 'USAGE_MISSING_ARG');
});

// ── ③ 快照层：digest / 缺文件 / 内容不符 ────────────────────────────────────
check('SNAPSHOT_DIGEST_MISMATCH: a manifest whose digest does not recompute is refused before anything is read', () => {
  const bad = buildSnapshot('digest-bad', {
    sources: [{ variant: 'v3', sid: 'session-digest' }],
    opts: { digestOverride: 'a'.repeat(64) },
  });
  const d = outDir('digest-bad');
  const e = expectCode(() => P.produceImportInput({ snapshotDir: bad.dir, outDir: d, out: path.join(d, 'x.json') }), 'SNAPSHOT_DIGEST_MISMATCH');
  assert.equal(typeof e.detail.recomputed, 'string');
  assert.equal(fs.existsSync(path.join(d, 'x.json')), false, 'a refused run must not leave an output file');
  // 阳性对照：同一份内容、只把 digest 改回真值 → 通过
  const good = buildSnapshot('digest-good', { sources: [{ variant: 'v3', sid: 'session-digest' }] });
  assert.equal(P.produceImportInput({ snapshotDir: good.dir, outDir: d, out: path.join(d, 'ok.json') }).ok, true);
});

check('SHARD_MISSING: a shard the manifest declares but that is absent is refused (not silently empty)', () => {
  const bad = buildSnapshot('shard-missing', {
    sources: [{ variant: 'v3', sid: 'session-miss', base: 'miss' }],
    opts: { dropShardRel: 'shards/miss.word.jsonl' },
  });
  const d = outDir('shard-missing');
  expectCode(() => P.produceImportInput({ snapshotDir: bad.dir, outDir: d, out: path.join(d, 'x.json') }), 'SHARD_MISSING');
});

check('SHARD_MISMATCH: bytes that changed after the manifest was written are refused by sha', () => {
  const bad = buildSnapshot('shard-tamper', {
    sources: [{ variant: 'v3', sid: 'session-tamper', base: 'tamper' }],
    opts: { tamperShardRel: 'shards/tamper.word.jsonl' },
  });
  const d = outDir('shard-tamper');
  expectCode(() => P.produceImportInput({ snapshotDir: bad.dir, outDir: d, out: path.join(d, 'x.json') }), 'SHARD_MISMATCH');
});

check('SHARD_NOT_IN_MANIFEST: a shard pointer inside the snapshot but absent from the manifest is refused', () => {
  const snapDir = path.join(ROOT, 'shard-notin');
  const bad = buildSnapshot('shard-notin', {
    sources: [{
      variant: 'v3', sid: 'session-notin', base: 'notin',
      declareWord: snapDir + '/shards/ghost.word.jsonl',
    }],
  });
  const d = outDir('shard-notin');
  expectCode(() => P.produceImportInput({ snapshotDir: bad.dir, outDir: d, out: path.join(d, 'x.json') }), 'SHARD_NOT_IN_MANIFEST');
});

check('SHARD_UNMAPPABLE: a shard pointer outside both the snapshot and sourceRoot is refused', () => {
  const bad = buildSnapshot('shard-unmap', {
    sources: [{ variant: 'v3', sid: 'session-unmap', base: 'unmap', declareWord: 'D:/synthetic/other-root/shards/x.word.jsonl' }],
  });
  const d = outDir('shard-unmap');
  expectCode(() => P.produceImportInput({ snapshotDir: bad.dir, outDir: d, out: path.join(d, 'x.json') }), 'SHARD_UNMAPPABLE');
});

check('SNAPSHOT_FILES_RECORD_MISSING: a manifest without a files role is refused', () => {
  const bad = buildSnapshot('no-files-record', {
    sources: [{ variant: 'v3', sid: 'session-nofile' }],
    opts: { dropFilesRecord: true },
  });
  const d = outDir('no-files-record');
  expectCode(() => P.produceImportInput({ snapshotDir: bad.dir, outDir: d, out: path.join(d, 'x.json') }), 'SNAPSHOT_FILES_RECORD_MISSING');
});

// ── ④ 行层 ─────────────────────────────────────────────────────────────────
check('SHARD_SESSION_MISMATCH: a shard row belonging to another session is refused', () => {
  const bad = buildSnapshot('session-mismatch', {
    sources: [{
      variant: 'v3', sid: 'session-owner', base: 'own',
      // 分片里的行属于**另一个**会话 —— 把两个会话塞进一个身份是这里最坏的错
      wordRows: [wordRow('session-intruder', 1, 'not mine', WS)],
    }],
  });
  const d = outDir('session-mismatch');
  const e = expectCode(() => P.produceImportInput({ snapshotDir: bad.dir, outDir: d, out: path.join(d, 'x.json') }), 'SHARD_SESSION_MISMATCH');
  assert.equal(typeof e.detail.line, 'number');
});

check('SHARD_ROW_COUNT_MISMATCH: a declaration that disagrees with the shard is refused, not rewritten', () => {
  const bad = buildSnapshot('count-drift', {
    sources: [{ variant: 'v3', sid: 'session-drift', base: 'drift', nWord: 5 }],
  });
  const d = outDir('count-drift');
  const e = expectCode(() => P.produceImportInput({ snapshotDir: bad.dir, outDir: d, out: path.join(d, 'x.json') }), 'SHARD_ROW_COUNT_MISMATCH');
  assert.equal(e.detail.declaredWords, 5);
  assert.equal(e.detail.actualWords, 1);
});

check('VARIANT_UNDETECTABLE: a file field without a session.v3 / session.v4 marker is refused', () => {
  const bad = buildSnapshot('no-variant', {
    sources: [{
      variant: 'v3', sid: 'session-novar',
      fileOverride: PROD_ROOT + '/sessions/session-novar/log.jsonl',
    }],
  });
  const d = outDir('no-variant');
  expectCode(() => P.produceImportInput({ snapshotDir: bad.dir, outDir: d, out: path.join(d, 'x.json') }), 'VARIANT_UNDETECTABLE');
});

check('MULTIPLE_ROWS_PER_SOURCE: two rows of one (variant, sid) are refused before they can overwrite each other', () => {
  const bad = buildSnapshot('two-rows', {
    sources: [
      { variant: 'v3', sid: 'session-twice', base: 'twice-a' },
      { variant: 'v3', sid: 'session-twice', base: 'twice-b' },
    ],
  });
  const d = outDir('two-rows');
  expectCode(() => P.produceImportInput({ snapshotDir: bad.dir, outDir: d, out: path.join(d, 'x.json') }), 'MULTIPLE_ROWS_PER_SOURCE');
});

check('WORKSPACE_MIXED: a shard row from another ws is refused', () => {
  const bad = buildSnapshot('ws-mixed', {
    sources: [{
      variant: 'v3', sid: 'session-ws', base: 'ws',
      wordRows: [wordRow('session-ws', 1, 'other ws', 'ws-OTHER')],
    }],
  });
  const d = outDir('ws-mixed');
  expectCode(() => P.produceImportInput({ snapshotDir: bad.dir, outDir: d, out: path.join(d, 'x.json') }), 'WORKSPACE_MIXED');
});

// ── ⑤ 共享分片对（六组那种形状）──────────────────────────────────────────────
// 同一份 (wordOut,sumOut) 被 v3 与 v4 两行同时声明：字节只有一份，属于谁不可推断。
const sharedBase = 'shared';
const dupSid = 'session-dup';
const sharedSnap = buildSnapshot('shared', {
  sources: [
    {
      variant: 'v3', sid: dupSid, base: sharedBase,
      wordRows: [wordRow(dupSid, 1, 'the bytes that survived (v3)', WS)],
      sumRows: [sumRow(dupSid, 'cmp-dup', [1], WS)],
    },
    { variant: 'v4', sid: dupSid, base: sharedBase, nWord: 1, nSum: 1 },
  ],
});
const sharedWordAbs = path.join(sharedSnap.dir, 'shards', sharedBase + '.word.jsonl');
const sharedSumAbs = path.join(sharedSnap.dir, 'shards', sharedBase + '.sum.jsonl');

// 重建出来的 v4 分片（override 指向它）
const rebuiltDir = path.join(ROOT, 'rebuilt');
fs.mkdirSync(rebuiltDir, { recursive: true });
const rebuiltWordAbs = path.join(rebuiltDir, 'session-dup.v4.word.jsonl');
const rebuiltSumAbs = path.join(rebuiltDir, 'session-dup.v4.sum.jsonl');
const rebuiltWords = [wordRow(dupSid, 2, 'rebuilt v4 row one', WS), wordRow(dupSid, 3, 'rebuilt v4 row two', WS)];
fs.writeFileSync(rebuiltWordAbs, jsonl(rebuiltWords));
fs.writeFileSync(rebuiltSumAbs, jsonl([]));

function mkOverride(name, items) {
  const p = path.join(ROOT, name + '.json');
  const entries = items.map((it) => {
    const wordBytes = fs.readFileSync(it.wordAbs);
    const sumBytes = fs.readFileSync(it.sumAbs);
    const wordRows = it.wordRows !== undefined ? it.wordRows : wordBytes.toString('utf8').split('\n').filter((l) => l.trim()).length;
    const sumRows = it.sumRows !== undefined ? it.sumRows : sumBytes.toString('utf8').split('\n').filter((l) => l.trim()).length;
    return {
      variant: it.variant,
      sidSha256: it.sidSha256 !== undefined ? it.sidSha256 : sha(Buffer.from(it.sid, 'utf8')),
      wordFile: it.wordAbs,
      sumFile: it.sumAbs,
      wordSha256: it.wordSha256 !== undefined ? it.wordSha256 : sha(wordBytes),
      sumSha256: it.sumSha256 !== undefined ? it.sumSha256 : sha(sumBytes),
      wordRows: it.wordRowsDeclared !== undefined ? it.wordRowsDeclared : wordRows,
      sumRows: it.sumRowsDeclared !== undefined ? it.sumRowsDeclared : sumRows,
    };
  });
  fs.writeFileSync(p, JSON.stringify({ format: P.OVERRIDE_FORMAT, entries }, null, 2) + '\n');
  return p;
}

check('SHARED_SHARD_PAIR_NO_OVERRIDE: a shared pair without an override is refused and the detail is counts only', () => {
  const d = outDir('shared-no-ov');
  const e = expectCode(() => P.produceImportInput({ snapshotDir: sharedSnap.dir, outDir: d, out: path.join(d, 'x.json') }), 'SHARED_SHARD_PAIR_NO_OVERRIDE');
  assert.equal(e.detail.sharedPairs, 1);
  assert.equal(e.detail.rowsInSharedPairs, 2);
  assert.equal(e.detail.rowsNeedingOverride, 2, 'both sides of a shared pair need to be named: nobody can tell whose bytes survived');
  assert.equal(e.detail.overridesProvided, 0);
  // 详情里不许有路径 / sid（它会被抄进报告）
  const detailText = JSON.stringify(e.detail);
  assert.equal(detailText.indexOf('D:/') === -1, true);
  assert.equal(detailText.indexOf(dupSid) === -1, true);
  assert.equal(fs.existsSync(path.join(d, 'x.json')), false, 'nothing may be written when a shared pair is unresolved');
});

check('shared pair WITH override: both variants are named, rows stay under their own identity', () => {
  const ovPath = mkOverride('ov-good', [
    { variant: 'v3', sid: dupSid, wordAbs: sharedWordAbs, sumAbs: sharedSumAbs },
    { variant: 'v4', sid: dupSid, wordAbs: rebuiltWordAbs, sumAbs: rebuiltSumAbs },
  ]);
  const { result, out } = produceOk('shared-with-ov', sharedSnap.dir, { overridePath: ovPath });
  assert.equal(result.sources, 2, 'v3 and v4 of one sid are two sources: identity is (namespace, sid)');
  assert.deepEqual(result.variants, { v3: 1, v4: 1 });
  assert.equal(result.overridesApplied, 2);
  assert.equal(result.sharedPairs, 1);
  assert.equal(result.overriddenRowCountDiffers, 1, 'the v4 row declared the overwritten shard counts; that difference is reported, not silently rewritten');
  const parsed = JSON.parse(fs.readFileSync(out, 'utf8'));
  const v3 = parsed.sources.find((s) => s.sourceVersion === 'v3');
  const v4 = parsed.sources.find((s) => s.sourceVersion === 'v4');
  assert.equal(v3.words.length, 1);
  assert.equal(v3.words[0].text, 'the bytes that survived (v3)');
  assert.equal(v4.words.length, 2, 'the rebuilt shard is what the v4 identity gets');
  assert.equal(v4.words[0].text, 'rebuilt v4 row one');
  // 两个源指向的分片必须不同（否则歧义没解决）
  assert.notEqual(path.resolve(v3.files[0].wordOut), path.resolve(v4.files[0].wordOut));
});

check('OVERRIDE_FILE_MISMATCH: a rebuilt shard whose hash does not match its declaration is refused', () => {
  const ovPath = mkOverride('ov-badhash', [
    { variant: 'v3', sid: dupSid, wordAbs: sharedWordAbs, sumAbs: sharedSumAbs },
    { variant: 'v4', sid: dupSid, wordAbs: rebuiltWordAbs, sumAbs: rebuiltSumAbs, wordSha256: 'b'.repeat(64) },
  ]);
  const d = outDir('ov-badhash');
  expectCode(() => P.produceImportInput({ snapshotDir: sharedSnap.dir, outDir: d, out: path.join(d, 'x.json'), overridePath: ovPath }), 'OVERRIDE_FILE_MISMATCH');
});

check('OVERRIDE_ROW_COUNT_MISMATCH: a declared row count that disagrees with the rebuilt shard is refused', () => {
  const ovPath = mkOverride('ov-badrows', [
    { variant: 'v3', sid: dupSid, wordAbs: sharedWordAbs, sumAbs: sharedSumAbs },
    { variant: 'v4', sid: dupSid, wordAbs: rebuiltWordAbs, sumAbs: rebuiltSumAbs, wordRowsDeclared: 99 },
  ]);
  const d = outDir('ov-badrows');
  expectCode(() => P.produceImportInput({ snapshotDir: sharedSnap.dir, outDir: d, out: path.join(d, 'x.json'), overridePath: ovPath }), 'OVERRIDE_ROW_COUNT_MISMATCH');
});

check('OVERRIDE_SID/UNKNOWN: an override whose sid hash matches nothing is refused, not ignored', () => {
  const ovPath = mkOverride('ov-unused', [
    { variant: 'v3', sid: dupSid, wordAbs: sharedWordAbs, sumAbs: sharedSumAbs },
    { variant: 'v4', sid: dupSid, wordAbs: rebuiltWordAbs, sumAbs: rebuiltSumAbs },
    { variant: 'v4', sid: 'session-somebody-else', wordAbs: rebuiltWordAbs, sumAbs: rebuiltSumAbs },
  ]);
  const d = outDir('ov-unused');
  expectCode(() => P.produceImportInput({ snapshotDir: sharedSnap.dir, outDir: d, out: path.join(d, 'x.json'), overridePath: ovPath }), 'OVERRIDE_UNUSED_ENTRY');
});

check('naming only one side of a shared pair is not enough (the other side still refuses)', () => {
  // 只给 v4 重建、不给 v3 → v3 那一侧仍然"没被命名"，整批照旧拒。
  const ovPath = mkOverride('ov-one-side', [
    { variant: 'v4', sid: dupSid, wordAbs: rebuiltWordAbs, sumAbs: rebuiltSumAbs },
  ]);
  const d = outDir('ov-one-side');
  const e = expectCode(() => P.produceImportInput({ snapshotDir: sharedSnap.dir, outDir: d, out: path.join(d, 'x.json'), overridePath: ovPath }), 'SHARED_SHARD_PAIR_NO_OVERRIDE');
  assert.equal(e.detail.rowsNeedingOverride, 1);
  assert.equal(e.detail.overridesProvided, 1);
});

check('variant is part of the override key: a wrong-variant entry never applies and is reported as unused', () => {
  // 非共享源 + 一条写错变体的条目 → 它命中不了任何 (variant, sid)，必须被当成"没生效"拒，
  // 而不是静默忽略（"我以为它生效了"正是要防的形状）。
  const solo = buildSnapshot('variant-key', { sources: [{ variant: 'v3', sid: 'session-vkey', base: 'vkey' }] });
  const soloWord = path.join(solo.dir, 'shards', 'vkey.word.jsonl');
  const soloSum = path.join(solo.dir, 'shards', 'vkey.sum.jsonl');
  const ovPath = mkOverride('ov-vkey', [
    { variant: 'v4', sid: 'session-vkey', wordAbs: soloWord, sumAbs: soloSum },
  ]);
  const d = outDir('variant-key');
  expectCode(() => P.produceImportInput({ snapshotDir: solo.dir, outDir: d, out: path.join(d, 'x.json'), overridePath: ovPath }), 'OVERRIDE_UNUSED_ENTRY');
  // 阳性对照：同一个 kit、把变体写对 → 通过，且 override 真的被用上（不只是"存着"）。
  const ovOk = mkOverride('ov-vkey-ok', [
    { variant: 'v3', sid: 'session-vkey', wordAbs: soloWord, sumAbs: soloSum },
  ]);
  const d2 = outDir('variant-key-ok');
  const res = P.produceImportInput({ snapshotDir: solo.dir, outDir: d2, out: path.join(d2, 'x.json'), overridePath: ovOk });
  assert.equal(res.ok, true);
  assert.equal(res.overridesApplied, 1, 'an override applies to any source once its hash and row count check out');
  assert.equal(res.overriddenRowCountDiffers, 0, 'this shard matches its row declaration, so nothing should differ');
});

check('a repaired shard for a non-shared source can be imported through an override', () => {
  // 冻结那一刻截断、事后重建：不共享，但冻结分片已经不能用了。override 是唯一出路。
  const broken = buildSnapshot('repaired', {
    sources: [{ variant: 'v3', sid: 'session-rep', base: 'rep' }],
    opts: { tamperShardRel: 'shards/rep.word.jsonl' },
  });
  const d = outDir('repaired');
  expectCode(() => P.produceImportInput({ snapshotDir: broken.dir, outDir: d, out: path.join(d, 'x.json') }), 'SHARD_MISMATCH');
  const fixedWord = path.join(ROOT, 'repaired-word.jsonl');
  fs.writeFileSync(fixedWord, jsonl([wordRow('session-rep', 1, 'repaired row', WS)]));
  const fixedSum = path.join(broken.dir, 'shards', 'rep.sum.jsonl');
  const ov = mkOverride('ov-repaired', [
    { variant: 'v3', sid: 'session-rep', wordAbs: fixedWord, sumAbs: fixedSum },
  ]);
  const res = P.produceImportInput({ snapshotDir: broken.dir, outDir: d, out: path.join(d, 'fixed.json'), overridePath: ov });
  assert.equal(res.ok, true);
  assert.equal(res.overridesApplied, 1);
  const parsed = JSON.parse(fs.readFileSync(path.join(d, 'fixed.json'), 'utf8'));
  assert.equal(parsed.sources[0].words[0].text, 'repaired row');
});

check('OVERRIDE_INVALID: a malformed override manifest is refused before any shard is read', () => {
  const p = path.join(ROOT, 'ov-malformed.json');
  fs.writeFileSync(p, JSON.stringify({ format: 'wrong/1', entries: [] }) + '\n');
  const d = outDir('ov-malformed');
  expectCode(() => P.produceImportInput({ snapshotDir: sharedSnap.dir, outDir: d, out: path.join(d, 'x.json'), overridePath: p }), 'OVERRIDE_INVALID');
  const missing = path.join(ROOT, 'ov-absent.json');
  expectCode(() => P.produceImportInput({ snapshotDir: sharedSnap.dir, outDir: d, out: path.join(d, 'x2.json'), overridePath: missing }), 'OVERRIDE_INVALID');
});

check('OVERRIDE_PAIR_STILL_SHARED: an override that keeps both sides on one shard pair is refused', () => {
  const ovPath = mkOverride('ov-still', [
    { variant: 'v3', sid: dupSid, wordAbs: sharedWordAbs, sumAbs: sharedSumAbs },
    { variant: 'v4', sid: dupSid, wordAbs: sharedWordAbs, sumAbs: sharedSumAbs },
  ]);
  const d = outDir('ov-still');
  expectCode(() => P.produceImportInput({ snapshotDir: sharedSnap.dir, outDir: d, out: path.join(d, 'x.json'), overridePath: ovPath }), 'OVERRIDE_PAIR_STILL_SHARED');
});

// ── ⑥ 端到端：producer → keeper → 全新 TEMP v10 库 ───────────────────────────
function makeDb(name) {
  const dbPath = path.join(ROOT, name + '.sqlite');
  const store = openMetaStore({ path: dbPath, mode: 'readwrite' });
  try { store.migrate(); } finally { store.close(); }
  return dbPath;
}
function countRows(dbPath, table) {
  const store = openMetaStore({ path: dbPath, mode: 'readonly' });
  try { return Number(store.db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n); } finally { store.close(); }
}

const e2e = buildSnapshot('e2e', {
  sources: [
    {
      variant: 'v3', sid: 'session-e2e-a',
      wordRows: [wordRow('session-e2e-a', 1, 'e2e v3 word one', WS), wordRow('session-e2e-a', 2, 'e2e v3 word two', WS)],
      sumRows: [sumRow('session-e2e-a', 'cmp-e2e-a', [1], WS)],
    },
    {
      variant: 'v4', sid: 'session-e2e-b',
      wordRows: [wordRow('session-e2e-b', 1, 'e2e v4 word one', WS)],
      sumRows: [],
    },
  ],
});
check('E2E: producer output fed straight into the keeper imports as IMPORTED into a fresh TEMP v10 database', () => {
  const { out } = produceOk('e2e', e2e.dir);
  const dbPath = makeDb('e2e');
  const journal = path.join(ROOT, 'e2e-journal.jsonl');
  const result = importSnapshot(out, dbPath, journal, { generation: 1, builtAt: T });
  assert.equal(result.ok, true);
  assert.equal(result.imported, 2, 'both sources must import');
  assert.equal(result.failed, 0);
  for (const o of result.outcomes) assert.equal(o.outcome, 'IMPORTED', 'outcome must be IMPORTED, got ' + o.outcome + ' / ' + o.code);
  assert.equal(countRows(dbPath, 'echo_words'), 3);
  assert.equal(countRows(dbPath, 'echo_summaries'), 1);
  assert.equal(countRows(dbPath, 'echo_index_sources'), 2);
  // 身份必须是 (namespace, sid) 派生出来的，而且 log / v4log 各一条
  const store = openMetaStore({ path: dbPath, mode: 'readonly' });
  try {
    const ns = store.db.prepare('SELECT namespace, COUNT(*) AS n FROM echo_index_sources GROUP BY namespace ORDER BY namespace').all().map((r) => r.namespace + ':' + r.n);
    assert.deepEqual(ns, ['log:1', 'v4log:1']);
    // 指针打得开：log:<sid>#seq=1 与 v4log:<sid>#seq=1
    assert.equal(store.echoOpen('log:session-e2e-a#seq=1').word.text, 'e2e v3 word one');
    assert.equal(store.echoOpen('v4log:session-e2e-b#seq=1').word.text, 'e2e v4 word one');
  } finally { store.close(); }
});

check('E2E: re-running the producer on the same snapshot yields the same bytes, and the keeper sees ALREADY_CURRENT', () => {
  const { out } = produceOk('e2e-again', e2e.dir);
  const dbPath = makeDb('e2e-again');
  const journal = path.join(ROOT, 'e2e-again-journal.jsonl');
  const first = importSnapshot(out, dbPath, journal, { generation: 1, builtAt: T });
  assert.equal(first.imported, 2);
  const second = importSnapshot(out, dbPath, path.join(ROOT, 'e2e-again-journal2.jsonl'), { generation: 1, builtAt: T });
  assert.equal(second.alreadyCurrent, 2);
  assert.equal(second.imported, 0);
  assert.equal(second.ok, true);
});

// ── 报表 ───────────────────────────────────────────────────────────────────
const pass = results.filter((r) => r.kind === 'PASS').length;
const skip = results.filter((r) => r.kind === 'SKIP').length;
console.log(results.map((r) => r.kind + ' ' + r.label).join('\n'));
console.log(results.length + ' checks, ' + pass + ' passed, ' + skip + ' skipped (a skip is NOT a pass)');
