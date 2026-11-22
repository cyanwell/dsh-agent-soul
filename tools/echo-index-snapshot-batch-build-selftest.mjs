#!/usr/bin/env node
// T-SNAP-2 selftest. Synthetic trees only: every fixture is built under os.tmpdir() by this
// file, and the tool is only ever pointed at those synthetic snapshot roots. It never reads the
// production index, a database, a session log, the ledger, or the model.
// Run: node tools/echo-index-snapshot-batch-build-selftest.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runBatch, BatchError, FORMAT } from './echo-index-snapshot-batch-build.mjs';
import { computeSnapshotDigest } from './echo-index-freeze.mjs';

const TMP = os.tmpdir();
if (!path.isAbsolute(TMP) || !fs.existsSync(TMP)) {
  process.stdout.write('ENV os.tmpdir() is not an absolute existing directory\n');
  process.exit(2);
}
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const BUILT_AT = '2026-11-16T00:00:00.000Z';

let pass = 0;
const failures = [];
function ok(name) { pass += 1; process.stdout.write('PASS ' + name + '\n'); }
function fail(name, detail) { failures.push(name + ': ' + detail); process.stdout.write('FAIL ' + name + ': ' + detail + '\n'); }
function check(name, cond, detail) { if (cond) ok(name); else fail(name, detail || 'assertion failed'); }

const roots = [];
function mkTmp(label) {
  const dir = fs.mkdtempSync(path.join(TMP, 'echo-snapbatch-st-' + label + '-'));
  roots.push(dir);
  return dir;
}

function wordRow(o) {
  return {
    t: o.t || '2026-11-16T00:00:00Z', session: o.sid, ws: null, seq: o.seq, turn: 0,
    log: 'unset', kind: o.kind || 'human', len: Array.from(String(o.text)).length,
    truncated: false, text: o.text,
  };
}
function summaryRow(o) {
  const text = o.summary || 'sum';
  return {
    id: o.id, t: o.t || '2026-11-16T00:00:00Z', session: o.sid, ws: null, log: 'unset',
    srcSeqs: o.srcSeqs || [], shadowedTokens: 0, chars: Array.from(text).length,
    provider: null, model: null, status: 'active', summary: text, manifest: { v: 1 },
  };
}
const jsonl = (rows) => (rows.length === 0 ? Buffer.alloc(0) : Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8'));

// Build a synthetic "live" source root, then the frozen snapshot echo-index-freeze.mjs would have
// produced from it: same relative layout, verbatim files.jsonl, manifest carrying the digest.
// Every word/summary row's log is pinned to that source's own file path, so the builder's
// selected-log join resolves on purpose rather than by accident.
function makeSnapshot(label, spec) {
  const sourceRoot = mkTmp('src-' + label);
  const shardDir = path.join(sourceRoot, 'shards');
  fs.mkdirSync(shardDir, { recursive: true });
  const rows = [];
  for (const s of spec) {
    const base = s.logName || s.sid;
    const logPath = path.join(sourceRoot, base + '.jsonl');
    const wordPath = s.wordOut || path.join(shardDir, base + '.word.jsonl');
    const sumPath = s.sumOut || path.join(shardDir, base + '.sum.jsonl');
    const words = (s.words || []).map((w) => ({ ...w, log: logPath }));
    const sums = (s.summaries || []).map((x) => ({ ...x, log: logPath }));
    const wordBytes = s.wordBytes !== undefined ? s.wordBytes : jsonl(words);
    const sumBytes = s.sumBytes !== undefined ? s.sumBytes : jsonl(sums);
    fs.mkdirSync(path.dirname(path.resolve(wordPath)), { recursive: true });
    fs.writeFileSync(path.resolve(wordPath), wordBytes);
    fs.writeFileSync(path.resolve(sumPath), sumBytes);
    const physicalWords = s.physicalWords !== undefined ? s.physicalWords : words.length;
    const physicalSums = s.physicalSums !== undefined ? s.physicalSums : sums.length;
    rows.push({
      file: logPath, key: 'k-' + base, nextByte: 1024, ws: null, sid: s.sid,
      nSum: s.nSum !== undefined ? s.nSum : physicalSums,
      nWord: s.nWord !== undefined ? s.nWord : physicalWords,
      sumOut: sumPath, wordOut: wordPath,
    });
  }
  const filesBody = Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(sourceRoot, 'files.jsonl'), filesBody);
  fs.writeFileSync(path.join(sourceRoot, 'words.jsonl'), '\n');
  fs.writeFileSync(path.join(sourceRoot, 'summaries.jsonl'), '\n');

  const snapRoot = mkTmp('snap-' + label);
  const plan = [
    ['files.jsonl', 'files', path.join(sourceRoot, 'files.jsonl')],
    ['words.jsonl', 'words', path.join(sourceRoot, 'words.jsonl')],
    ['summaries.jsonl', 'summaries', path.join(sourceRoot, 'summaries.jsonl')],
  ];
  const seen = new Set(['files.jsonl', 'words.jsonl', 'summaries.jsonl']);
  for (const row of rows) {
    for (const p of [row.wordOut, row.sumOut]) {
      const rel = path.relative(sourceRoot, path.resolve(p)).split(path.sep).join('/');
      if (rel.startsWith('..') || seen.has(rel)) continue;
      seen.add(rel);
      plan.push([rel, 'shard', path.resolve(p)]);
    }
  }
  const records = [];
  for (const item of plan) {
    const rel = item[0];
    const role = item[1];
    const abs = item[2];
    const dest = path.join(snapRoot, rel.split('/').join(path.sep));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(abs, dest);
    const bytes = fs.readFileSync(dest);
    const st = fs.statSync(dest);
    records.push({ path: rel, role, sha256: sha256(bytes), bytes: bytes.length, mtimeMs: Math.trunc(st.mtimeMs) });
  }
  const digest = computeSnapshotDigest(records);
  const manifest = {
    format: 'echo-index-freeze/v1', task: 'T-SNAP-1', createdAt: BUILT_AT,
    sourceRoot: sourceRoot.replace(/\\/g, '/'),
    sourceFingerprint: sha256(filesBody),
    filesDeclared: rows.length * 2,
    snapshotDigest: digest,
    fileCount: records.length,
    totalBytes: records.reduce((n, r) => n + r.bytes, 0),
    files: records,
  };
  fs.writeFileSync(path.join(snapRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { snapRoot, sourceRoot, rows, digest };
}

function freshOut(label) {
  const dir = mkTmp('out-' + label);
  return path.join(dir, 'batch'); // deliberately absent
}

async function run(snapshotRoot, out) {
  const log = [];
  const result = await runBatch({ args: { snapshotRoot, out, builtAt: BUILT_AT }, log: (l) => log.push(l) });
  return { result, log };
}
async function expectCode(name, snapshotRoot, out, code) {
  try {
    const r = await run(snapshotRoot, out);
    fail(name, 'expected ' + code + ' but the run succeeded: ' + JSON.stringify(r.result.accounting));
  } catch (error) {
    if (error instanceof BatchError && error.code === code) ok(name);
    else fail(name, 'expected ' + code + ', got ' + String((error && error.code) || (error && error.name)) + ': ' + String(error && error.message).slice(0, 200));
  }
}
function conserved(name, r) {
  const a = r.accounting;
  check(name, a.built + a.skippedEmpty + a.refused === a.sourceRows && a.conserved === true, 'accounting ' + JSON.stringify(a));
}

// ── T1 两个互不相干的源：都 built，全局 feed 产出，报告不含路径/正文/会话 id ──────────
{
  const snap = makeSnapshot('t1', [
    { sid: 's-alpha', words: [wordRow({ sid: 's-alpha', seq: 1, text: 'alpha-one' })], summaries: [summaryRow({ sid: 's-alpha', id: 'cmp-alpha', srcSeqs: [1], summary: 'sum-alpha' })] },
    { sid: 's-beta', words: [wordRow({ sid: 's-beta', seq: 1, text: 'beta-two' })], summaries: [summaryRow({ sid: 's-beta', id: 'cmp-beta', srcSeqs: [1], summary: 'sum-beta' })] },
  ]);
  const out = freshOut('t1');
  const r = await run(snap.snapRoot, out);
  const result = r.result;
  check('t1 exit 0', result.exitCode === 0, 'exit=' + result.exitCode);
  check('t1 two built', result.accounting.built === 2 && result.accounting.refused === 0, JSON.stringify(result.accounting));
  conserved('t1 accounting conserved', result);
  check('t1 global feed emitted', result.globalFeed.emitted === true, JSON.stringify(result.globalFeed));
  check('t1 global words 2', result.globalFeed.emitted === true && result.globalFeed.counts.words === 2, JSON.stringify(result.globalFeed.counts || null));
  check('t1 global summaries 2', result.globalFeed.emitted === true && result.globalFeed.counts.summaries === 2, '');
  check('t1 per-source manifests exist', result.batchManifest.sources.every(function (s) { return fs.existsSync(path.join(out, s.artifacts.manifest)); }), 'missing artifact');
  check('t1 global artifacts exist', fs.existsSync(path.join(out, 'global', 'words.jsonl')), 'global words missing');
  check('t1 no database file written', fs.readdirSync(out).filter(function (n) { return /\.(sqlite|db|sqlite3)$/i.test(n); }).length === 0, 'a database file appeared in out');
  const manifestText = fs.readFileSync(result.batchManifestPath, 'utf8');
  check('t1 no source root path', manifestText.indexOf(snap.sourceRoot.replace(/\\/g, '/')) === -1 && manifestText.indexOf(snap.sourceRoot) === -1, 'batch manifest leaked the source root');
  check('t1 no raw word text', manifestText.indexOf('alpha-one') === -1 && manifestText.indexOf('beta-two') === -1, 'batch manifest leaked word text');
  check('t1 no raw summary text', manifestText.indexOf('sum-alpha') === -1 && manifestText.indexOf('sum-beta') === -1, 'batch manifest leaked summary text');
  check('t1 no session id', manifestText.indexOf('s-alpha') === -1 && manifestText.indexOf('s-beta') === -1, 'batch manifest leaked a session id');
  check('t1 no absolute jsonl path', /[A-Za-z]:[\\/][^\s"]*\.jsonl/.test(manifestText) === false, 'batch manifest carries an absolute path');
  const stdoutText = r.log.join('\n');
  check('t1 stdout carries no source path or text', stdoutText.indexOf(snap.sourceRoot) === -1 && stdoutText.indexOf('alpha-one') === -1, 'stdout leaked');
  check('t1 global manifest sha recorded', typeof result.globalFeed.manifestSha256 === 'string' && result.globalFeed.manifestSha256.length === 64, '');
  check('t1 batch manifest format', result.batchManifest.format === FORMAT, '');
  check('t1 source ids are positional', result.batchManifest.sources.map(function (s) { return s.id; }).join(',') === 'src-0000,src-0001', result.batchManifest.sources.map(function (s) { return s.id; }).join(','));
  check('t1 snapshot provenance recorded', result.batchManifest.snapshot.verified === true && result.batchManifest.snapshot.snapshotDigest === snap.digest, 'digest not pinned');
}

// ── T2 有 words、summary canonical 空（声明 nSum=0）→ 正常 built，summary 空允许 ─────
{
  const snap = makeSnapshot('t2', [{
    sid: 's-words-only', nSum: 0, sumBytes: Buffer.from('\n', 'utf8'),
    words: [wordRow({ sid: 's-words-only', seq: 1, text: 'w1' }), wordRow({ sid: 's-words-only', seq: 2, text: 'w2', kind: '结论' })],
  }]);
  const out = freshOut('t2');
  const r = await run(snap.snapRoot, out);
  check('t2 exit 0', r.result.exitCode === 0, 'exit=' + r.result.exitCode);
  check('t2 built', r.result.accounting.built === 1, JSON.stringify(r.result.accounting));
  const s0 = r.result.batchManifest.sources[0];
  check('t2 build counts', s0.build.words === 2 && s0.build.summaries === 0, JSON.stringify(s0.build));
  check('t2 declared 0 / physical 0 summaries', s0.declared.nSum === 0 && s0.physical.summaries === 0, JSON.stringify(s0.physical));
  check('t2 global emitted', r.result.globalFeed.emitted === true && r.result.globalFeed.counts.words === 2, JSON.stringify(r.result.globalFeed));
}

// ── T3 声明 0/0 且两工件 canonical 空 → skippedEmpty（既不是 refusal 也不是 built）────
{
  const snap = makeSnapshot('t3', [
    { sid: 's-empty', nWord: 0, nSum: 0, wordBytes: Buffer.alloc(0), sumBytes: Buffer.alloc(0) },
    { sid: 's-live', words: [wordRow({ sid: 's-live', seq: 1, text: 'kept' })] },
  ]);
  const out = freshOut('t3');
  const r = await run(snap.snapRoot, out);
  check('t3 exit 0', r.result.exitCode === 0, 'exit=' + r.result.exitCode);
  check('t3 one skippedEmpty', r.result.accounting.skippedEmpty === 1, JSON.stringify(r.result.accounting));
  check('t3 one built', r.result.accounting.built === 1, JSON.stringify(r.result.accounting));
  conserved('t3 accounting conserved', r.result);
  const skip = r.result.batchManifest.sources.filter(function (s) { return s.status === 'skippedEmpty'; })[0] || null;
  check('t3 skippedEmpty code', !!skip && skip.code === 'DECLARED_AND_PHYSICALLY_EMPTY', skip ? skip.code : 'no skippedEmpty source');
  check('t3 skippedEmpty emits no artifacts', !!skip && skip.artifacts === null, 'skip must not emit artifacts');
  check('t3 skippedEmpty physical zero', !!skip && skip.physical.words === 0 && skip.physical.summaries === 0, '');
  check('t3 global emitted from the live source', r.result.globalFeed.emitted === true && r.result.globalFeed.counts.words === 1, JSON.stringify(r.result.globalFeed));
}

// ── T4 words 物理为空但声明非零 → COUNT_MISMATCH refusal（绝不被跳成 skippedEmpty）────
{
  const snap = makeSnapshot('t4', [{ sid: 's-bad', nWord: 3, nSum: 0, wordBytes: Buffer.alloc(0), sumBytes: Buffer.from('\n', 'utf8') }]);
  const out = freshOut('t4');
  const r = await run(snap.snapRoot, out);
  check('t4 exit 3', r.result.exitCode === 3, 'exit=' + r.result.exitCode);
  check('t4 refused 1 / skipped 0', r.result.accounting.refused === 1 && r.result.accounting.skippedEmpty === 0, JSON.stringify(r.result.accounting));
  check('t4 COUNT_MISMATCH', r.result.refusalCategories.COUNT_MISMATCH === 1, JSON.stringify(r.result.refusalCategories));
  conserved('t4 accounting conserved', r.result);
  check('t4 global withheld', r.result.globalFeed.emitted === false && r.result.globalFeed.code === 'NO_BUILDABLE_SOURCE', JSON.stringify(r.result.globalFeed));
}

// ── T5 分片里有畸形行 → SHARD_INVALID_JSON refusal ────────────────────────────────
{
  const bad = Buffer.from('{"t":"2026-11-16T00:00:00Z","session":"s-mal"' + '\n', 'utf8');
  const snap = makeSnapshot('t5', [{ sid: 's-mal', wordBytes: bad, physicalWords: 1, nWord: 1, nSum: 0, sumBytes: Buffer.from('\n', 'utf8') }]);
  const out = freshOut('t5');
  const r = await run(snap.snapRoot, out);
  check('t5 exit 3', r.result.exitCode === 3, 'exit=' + r.result.exitCode);
  check('t5 SHARD_INVALID_JSON', r.result.refusalCategories.SHARD_INVALID_JSON === 1, JSON.stringify(r.result.refusalCategories));
  conserved('t5 accounting conserved', r.result);
  check('t5 nothing built', r.result.accounting.built === 0, JSON.stringify(r.result.accounting));
}

// ── T6 重复 (wordOut,sumOut) 声明组 → 整批 fail closed，不产出任何 feed ─────────────
{
  const sourceRoot = mkTmp('src-t6');
  fs.mkdirSync(path.join(sourceRoot, 'shards'), { recursive: true });
  const sharedWord = path.join(sourceRoot, 'shards', 'same.word.jsonl');
  const sharedSum = path.join(sourceRoot, 'shards', 'same.sum.jsonl');
  const w = wordRow({ sid: 's-dup', seq: 1, text: 'x' });
  fs.writeFileSync(sharedWord, JSON.stringify(Object.assign({}, w, { log: path.join(sourceRoot, 'a.jsonl') })) + '\n');
  fs.writeFileSync(sharedSum, '\n');
  const rows = [
    { file: path.join(sourceRoot, 'a.jsonl'), key: 'k1', nextByte: 1, ws: null, sid: 's-dup', nSum: 0, nWord: 1, sumOut: sharedSum, wordOut: sharedWord },
    { file: path.join(sourceRoot, 'b.jsonl'), key: 'k2', nextByte: 2, ws: null, sid: 's-dup', nSum: 0, nWord: 1, sumOut: sharedSum, wordOut: sharedWord },
  ];
  fs.writeFileSync(path.join(sourceRoot, 'files.jsonl'), rows.map(function (x) { return JSON.stringify(x); }).join('\n') + '\n');
  fs.writeFileSync(path.join(sourceRoot, 'words.jsonl'), '\n');
  fs.writeFileSync(path.join(sourceRoot, 'summaries.jsonl'), '\n');
  const snapRoot = mkTmp('snap-t6');
  const plan = [
    ['files.jsonl', 'files', path.join(sourceRoot, 'files.jsonl')],
    ['words.jsonl', 'words', path.join(sourceRoot, 'words.jsonl')],
    ['summaries.jsonl', 'summaries', path.join(sourceRoot, 'summaries.jsonl')],
    ['shards/same.word.jsonl', 'shard', sharedWord],
    ['shards/same.sum.jsonl', 'shard', sharedSum],
  ];
  const records = [];
  for (const item of plan) {
    const dest = path.join(snapRoot, item[0].split('/').join(path.sep));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(item[2], dest);
    const bytes = fs.readFileSync(dest);
    records.push({ path: item[0], role: item[1], sha256: sha256(bytes), bytes: bytes.length, mtimeMs: 0 });
  }
  fs.writeFileSync(path.join(snapRoot, 'manifest.json'), JSON.stringify({
    format: 'echo-index-freeze/v1', createdAt: BUILT_AT, sourceRoot: sourceRoot.replace(/\\/g, '/'),
    filesDeclared: 2, snapshotDigest: computeSnapshotDigest(records),
    fileCount: records.length, totalBytes: records.reduce(function (n, x) { return n + x.bytes; }, 0), files: records,
  }, null, 2) + '\n');
  const out = freshOut('t6');
  await expectCode('t6 duplicate declaration group fails the whole batch', snapRoot, out, 'E_DUPLICATE_SHARD_DECLARATION');
  check('t6 out absent (no combined feed)', !fs.existsSync(out), 'out survived a fail-closed refusal');
}

// ── T7 空 words + 非零 summary 声明：构建器 EMPTY_NO_SELECTED_ROWS 仍是 refusal ─────
{
  const snap = makeSnapshot('t7', [{
    sid: 's-emptygen', nWord: 0, nSum: 1, wordBytes: Buffer.alloc(0),
    summaries: [summaryRow({ sid: 's-emptygen', id: 'cmp-e', srcSeqs: [], summary: 'only-summary' })],
  }]);
  const out = freshOut('t7');
  const r = await run(snap.snapRoot, out);
  check('t7 exit 3', r.result.exitCode === 3, 'exit=' + r.result.exitCode);
  check('t7 not skipped', r.result.accounting.skippedEmpty === 0, JSON.stringify(r.result.accounting));
  // words 工件本身为空（声明 0 行）而 summaries 非空：不是「空产出」也不是 skip，是拒绝。
  check('t7 empty words artifact refused, not skipped', r.result.refusalCategories.WORDS_ARTIFACT_EMPTY === 1, JSON.stringify(r.result.refusalCategories));
  check('t7 source status refused', r.result.batchManifest.sources[0].status === 'refused', r.result.batchManifest.sources[0].status);
  conserved('t7 accounting conserved', r.result);
}

// ── T7b words 行全被 kind 排除 → 构建器 EMPTY_NO_SELECTED_ROWS 仍是 refusal（不跳）──
{
  const snap = makeSnapshot('t7b', [{
    sid: 's-all-excluded', nSum: 0, sumBytes: Buffer.from('\n', 'utf8'),
    words: [wordRow({ sid: 's-all-excluded', seq: 1, text: 'tool payload', kind: 'tool' })],
  }]);
  const out = freshOut('t7b');
  const r = await run(snap.snapRoot, out);
  check('t7b exit 3', r.result.exitCode === 3, 'exit=' + r.result.exitCode);
  check('t7b EMPTY_NO_SELECTED_ROWS stays a refusal', r.result.refusalCategories.EMPTY_NO_SELECTED_ROWS === 1, JSON.stringify(r.result.refusalCategories));
  check('t7b not skipped and not built', r.result.accounting.skippedEmpty === 0 && r.result.accounting.built === 0, JSON.stringify(r.result.accounting));
  conserved('t7b accounting conserved', r.result);
}

// ── T8 跨源同 (session,seq) 不同字节 → 全局冲突，分类汇总，全局 feed 不产出 ─────────
{
  const snap = makeSnapshot('t8', [
    { sid: 'same-sid', logName: 'a', words: [wordRow({ sid: 'same-sid', seq: 1, text: 'left' })], nSum: 0, sumBytes: Buffer.from('\n', 'utf8') },
    { sid: 'same-sid', logName: 'b', words: [wordRow({ sid: 'same-sid', seq: 1, text: 'right' })], nSum: 0, sumBytes: Buffer.from('\n', 'utf8') },
  ]);
  const out = freshOut('t8');
  const r = await run(snap.snapRoot, out);
  check('t8 both sources built', r.result.accounting.built === 2, JSON.stringify(r.result.accounting));
  check('t8 exit 3', r.result.exitCode === 3, 'exit=' + r.result.exitCode);
  check('t8 GLOBAL_CROSS_SOURCE_CONFLICT', r.result.globalFeed.emitted === false && r.result.globalFeed.code === 'GLOBAL_CROSS_SOURCE_CONFLICT', JSON.stringify(r.result.globalFeed));
  check('t8 categorized conflict counts', r.result.globalFeed.categories.wordKey === 1 && r.result.globalFeed.categories.cmpId === 0, JSON.stringify(r.result.globalFeed.categories));
  check('t8 no global artifacts', !fs.existsSync(path.join(out, 'global')), 'global feed written despite a conflict');
}

// ── T9 快照内任一文件被改动 → 读源之前就拒绝（逐文件哈希）─────────────────────────
{
  const snap = makeSnapshot('t9', [{ sid: 's9', words: [wordRow({ sid: 's9', seq: 1, text: 'ok' })] }]);
  const target = path.join(snap.snapRoot, 'shards', 's9.word.jsonl');
  const bytes = fs.readFileSync(target);
  bytes[0] = bytes[0] === 0x7b ? 0x5b : 0x7b;
  fs.writeFileSync(target, bytes);
  const out = freshOut('t9');
  await expectCode('t9 tampered snapshot refused before reading sources', snap.snapRoot, out, 'E_SNAPSHOT_FILE_MISMATCH');
  check('t9 out absent', !fs.existsSync(out), 'out survived');
}

// ── T10 并发：out 里已有本工具的锁 → E_CONCURRENT_RUN（不并发写）────────────────────
{
  const snap = makeSnapshot('t10', [{ sid: 's10', words: [wordRow({ sid: 's10', seq: 1, text: 'x' })] }]);
  const out = freshOut('t10');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, '.batch-build.lock'), '{"pid":1}' + '\n');
  await expectCode('t10 concurrent run refused', snap.snapRoot, out, 'E_CONCURRENT_RUN');
}

// ── T11 没有默认源：不给 --snapshot-root 就是用法错误 ──────────────────────────────
{
  let code = null;
  try {
    await runBatch({ argv: [], log: function () {} });
  } catch (error) {
    code = error instanceof BatchError ? error.code : null;
  }
  check('t11 no default snapshot root', code === 'E_USAGE', 'got ' + code);
}

// ── T12 tilde SID：冻结快照经真实 batch builder 构建并进入全局 feed ──────────────
{
  const sid = 'jinglan~003Amain';
  const snap = makeSnapshot('t12-tilde-sid', [{
    sid,
    words: [wordRow({ sid, seq: 3, text: 'tilde-sid-word' })],
    summaries: [summaryRow({ sid, id: 'cmp-tilde-sid', srcSeqs: [3], summary: 'tilde-sid-summary' })],
  }]);
  const out = freshOut('t12-tilde-sid');
  const r = await run(snap.snapRoot, out);
  check('t12 tilde SID exit 0', r.result.exitCode === 0, 'exit=' + r.result.exitCode);
  check('t12 tilde SID source built', r.result.accounting.built === 1 && r.result.accounting.refused === 0 && r.result.batchManifest.sources[0].status === 'built', JSON.stringify(r.result.accounting));
  check('t12 tilde SID output row preserved', r.result.globalFeed.emitted === true && JSON.parse(fs.readFileSync(path.join(out, 'global', 'words.jsonl'), 'utf8').trim()).session === sid, 'global word row did not preserve SID');
  check('t12 tilde SID valid summary output', r.result.globalFeed.emitted === true && JSON.parse(fs.readFileSync(path.join(out, 'global', 'summaries.jsonl'), 'utf8').trim()).cmpId === 'cmp-tilde-sid', 'global summary output missing or invalid');
}

// ── T13 非法 SID：仍由真实 batch builder 按 ROW_SID 拒绝 ───────────────────────────
{
  const sid = 's invalid';
  const snap = makeSnapshot('t13-invalid-sid', [{
    sid, words: [wordRow({ sid, seq: 1, text: 'invalid-sid-word' })], nSum: 0, sumBytes: Buffer.from('\n', 'utf8'),
  }]);
  const out = freshOut('t13-invalid-sid');
  const r = await run(snap.snapRoot, out);
  check('t13 illegal SID exit 3', r.result.exitCode === 3, 'exit=' + r.result.exitCode);
  check('t13 illegal SID refused as ROW_SID', r.result.accounting.refused === 1 && r.result.batchManifest.sources[0].code === 'ROW_SID', JSON.stringify(r.result.batchManifest.sources[0]));
  check('t13 illegal SID withholds global feed', r.result.globalFeed.emitted === false, JSON.stringify(r.result.globalFeed));
  conserved('t13 accounting conserved', r.result);
}

for (const dir of roots) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* leftover temp is acceptable */ }
}

process.stdout.write('\n' + pass + ' passed, ' + failures.length + ' failed\n');
if (failures.length > 0) {
  for (const f of failures) process.stdout.write('  FAILED ' + f + '\n');
  process.exitCode = 1;
}
