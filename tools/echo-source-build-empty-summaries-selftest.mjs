#!/usr/bin/env node
// TEMP-only synthetic test: the authoritative ECHO index JSONL reader's allowEmpty contract.
//   零字节 与 单个 LF（canonical 空工件）在 allowEmpty 下**都表示零行**；
//   非空文件的 BOM / UTF-8 / 空行 / 字段集 / JSON / 末行截断校验一条都不许松；
//   words/files 这类没有 allowEmpty 的读者照旧拒绝。
// 全部夹具在 os.tmpdir() 之下；不读生产索引、不碰 DB、不 import、不 reload。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildFromEchoIndexFiles, inspectEchoIndexFeed, readEchoIndexJsonl,
  ECHO_INDEX_SUMMARY_FIELDS, ECHO_INDEX_WORD_FIELDS
} from './echo-source-build.mjs';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-source-build-empty-summaries-'));
const FIX = path.join(ROOT, 'fixtures');
let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log('✓ ' + name); }
  catch (e) { failed += 1; console.error('✗ ' + name + ': ' + (e && e.stack || e)); }
}

const SUMMARY_SET = [ECHO_INDEX_SUMMARY_FIELDS];
const WORD_SET = [ECHO_INDEX_WORD_FIELDS];
const ZERO = Buffer.alloc(0);
const ONE_LF = Buffer.from('\n', 'utf8');

// 直接写一段原始字节，返回绝对路径（读者只认字节，不认名字）。
function blob(dirName, name, bytes) {
  const dir = path.join(FIX, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return file;
}
const readSummaryBytes = (dirName, bytes) => blob(dirName, 'summaries.jsonl', bytes);
const rejected = (fn, pattern, label) => assert.throws(fn, pattern, label);

// ── 合成 feed 夹具（files/words 正常，summaries 由调用方给原始字节）─────────
const SID = 'session-empty-sum-a1';
const WS = '--D-AI-synthetic-empty-sum--';
const LOG = 'D:/synthetic/echo-source-build-empty-summaries/sessions/' + WS + '/' + SID + '/session.v4.jsonl.zstd';
const TEXT = 'empty summary query';
const fileRow = () => ({
  file: path.resolve(LOG), key: '1800000000000:512', nextByte: 512, ws: WS, sid: SID,
  nSum: 0, nWord: 1,
  sumOut: 'D:/synthetic/echo-source-build-empty-summaries/shards/' + SID + '.sum.jsonl',
  wordOut: 'D:/synthetic/echo-source-build-empty-summaries/shards/' + SID + '.word.jsonl'
});
const wordRow = () => ({
  t: '2026-11-16T07:00:00', session: SID, ws: WS, seq: 0, turn: null, log: LOG,
  role: 'user', kind: 'human', len: Array.from(TEXT).length, truncated: false, text: TEXT
});
const lines = (rows) => Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
const FILES_BYTES = lines([fileRow()]);
const WORDS_BYTES = lines([wordRow()]);

function makeFeed(dirName, over) {
  const o = over || {};
  const dir = path.join(FIX, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const write = (name, bytes) => { const file = path.join(dir, name); fs.writeFileSync(file, bytes); return file; };
  return {
    dir,
    filesPath: write('files.jsonl', o.files === undefined ? FILES_BYTES : o.files),
    wordsPath: write('words.jsonl', o.words === undefined ? WORDS_BYTES : o.words),
    summariesPath: write('summaries.jsonl', o.summaries === undefined ? ONE_LF : o.summaries)
  };
}
function buildOptions(fixture, tag) {
  return {
    filesPath: fixture.filesPath, wordsPath: fixture.wordsPath, summariesPath: fixture.summariesPath,
    sourcePath: 'D:/synthetic/echo-source-build-empty-summaries/index', namespace: 'log', generation: 1,
    builtAt: '2026-11-16T07:10:00.000Z', outDir: path.join(fixture.dir, 'out', tag)
  };
}

// ══ 1. allowEmpty true + 零字节 → 零行（不是「跳过整个源」）══════════════════
check('allowEmpty true + 0-byte summaries → zero rows, source still counted', () => {
  const file = readSummaryBytes('zero-byte-reader', ZERO);
  const parsed = readEchoIndexJsonl(file, 'summaries.jsonl', SUMMARY_SET, { allowEmpty: true });
  assert.equal(parsed.rows.length, 0, '0-byte 必须是零行');
  assert.equal(parsed.bytes, 0);
  assert.equal(parsed.finalLf, false, '0 字节文件确实不以 LF 结尾：如实记录，不假装');
  const fixture = makeFeed('zero-byte-build', { summaries: ZERO });
  const built = buildFromEchoIndexFiles(buildOptions(fixture, 'g1'));
  assert.equal(built.manifest.counts.summaries, 0);
  assert.equal(built.manifest.counts.summaryRows, 0);
  assert.equal(built.manifest.counts.words, 1, 'summary 为空绝不代表整个源被跳过');
  assert.equal(built.manifest.counts.files, 1);
  assert.equal(built.manifest.counts.srcSeqs, 0);
  assert.equal(built.manifest.sourceInput.summaries.bytes, 0);
  assert.equal(built.manifest.sourceInput.summaries.rows, 0);
  assert.equal(built.manifest.sourceInput.summaries.finalLf, false);
  assert.deepEqual(fs.readFileSync(built.summariesPath), ONE_LF, '输出仍是 canonical 空工件（单个 LF）');
});

// ══ 2. allowEmpty true + 单个 LF → 零行 ═════════════════════════════════════
check('allowEmpty true + single LF summaries → zero rows', () => {
  const file = readSummaryBytes('one-lf-reader', ONE_LF);
  const parsed = readEchoIndexJsonl(file, 'summaries.jsonl', SUMMARY_SET, { allowEmpty: true });
  assert.equal(parsed.rows.length, 0);
  assert.equal(parsed.bytes, 1);
  assert.equal(parsed.finalLf, true);
  const fixture = makeFeed('one-lf-build', { summaries: ONE_LF });
  const built = buildFromEchoIndexFiles(buildOptions(fixture, 'g1'));
  assert.equal(built.manifest.counts.summaries, 0);
  assert.equal(built.manifest.counts.summaryRows, 0);
  assert.equal(built.manifest.counts.words, 1);
  assert.equal(built.manifest.sourceInput.summaries.bytes, 1);
  assert.equal(built.manifest.sourceInput.summaries.finalLf, true);
  assert.deepEqual(fs.readFileSync(built.summariesPath), ONE_LF);
});

// ══ 3. allowEmpty false + 零字节 → 拒 ═══════════════════════════════════════
check('allowEmpty false + 0-byte refuses (helper, words reader, build outputs withheld)', () => {
  const file = readSummaryBytes('zero-byte-strict', ZERO);
  rejected(() => readEchoIndexJsonl(file, 'summaries.jsonl', SUMMARY_SET, { allowEmpty: false }), /is empty/);
  rejected(() => readEchoIndexJsonl(file, 'summaries.jsonl', SUMMARY_SET), /is empty/, '缺省 = 严格：不许默默收下空文件');
  rejected(() => readEchoIndexJsonl(file, 'words.jsonl', WORD_SET), /is empty/, 'words 的空拒绝不变');
  const dirName = 'zero-byte-words';
  const fixture = makeFeed(dirName, { words: ZERO });
  rejected(() => buildFromEchoIndexFiles(buildOptions(fixture, 'g1')), /words\.jsonl is empty/);
  assert.equal(fs.existsSync(path.join(fixture.dir, 'out', 'g1')), false, '拒绝不许留下输出');
  const filesEmpty = makeFeed('zero-byte-files', { files: ZERO });
  rejected(() => buildFromEchoIndexFiles(buildOptions(filesEmpty, 'g1')), /files\.jsonl is empty/);
});

// ══ 4. allowEmpty false + 单个 LF → 拒 ══════════════════════════════════════
check('allowEmpty false + single LF refuses (helper, words reader, build outputs withheld)', () => {
  const file = readSummaryBytes('one-lf-strict', ONE_LF);
  rejected(() => readEchoIndexJsonl(file, 'summaries.jsonl', SUMMARY_SET, { allowEmpty: false }), /has no data rows/);
  rejected(() => readEchoIndexJsonl(file, 'summaries.jsonl', SUMMARY_SET), /has no data rows/);
  rejected(() => readEchoIndexJsonl(file, 'words.jsonl', WORD_SET), /has no data rows/, 'words 的空拒绝不变');
  const fixture = makeFeed('one-lf-words', { words: ONE_LF });
  rejected(() => buildFromEchoIndexFiles(buildOptions(fixture, 'g1')), /words\.jsonl has no data rows/);
  assert.equal(fs.existsSync(path.join(fixture.dir, 'out', 'g1')), false);
  const filesLf = makeFeed('one-lf-files', { files: ONE_LF });
  rejected(() => buildFromEchoIndexFiles(buildOptions(filesLf, 'g1')), /files\.jsonl has no data rows/);
});

// ══ 5. allowEmpty 不放松任何非空文件的校验 ══════════════════════════════════
check('allowEmpty keeps BOM / UTF-8 / blank-line / field / JSON / truncation strict', () => {
  const goodRow = JSON.stringify({
    id: 'cmp-empty-sum-1', t: '2026-11-16T07:00:00', session: SID, ws: WS, log: LOG, srcSeqs: [0],
    shadowedTokens: 1, chars: 2, provider: 'synthetic', model: 'synthetic-summary', status: 'active',
    summary: 'synthetic summary', manifest: { range: [0, 0], n: 1, marks: [] }
  });
  let seq = 0;
  // 每条都用 allowEmpty:true 走同一个读者：样本拒绝只能来自内容本身，不能来自「没开 allowEmpty」。
  const strict = (bytes, pattern, label) => {
    seq += 1;
    const dirName = 'strict-' + String(seq).padStart(2, '0');
    const file = readSummaryBytes(dirName, bytes);
    rejected(() => readEchoIndexJsonl(file, 'summaries.jsonl', SUMMARY_SET, { allowEmpty: true }), pattern, label);
  };
  const L = (name, bytes) => readSummaryBytes(name, bytes);

  strict(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(goodRow + '\n', 'utf8')]), /BOM/, 'BOM');
  strict(Buffer.from([0xef, 0xbb, 0xbf]), /BOM/, '只有 BOM 也是 BOM：先判 BOM 再判别的');
  strict(Buffer.concat([Buffer.from([0x7b, 0xc3, 0x28, 0x7d]), Buffer.from('\n', 'utf8')]), /not valid UTF-8/, 'invalid UTF-8');
  strict(Buffer.from('\n\n', 'utf8'), /non-blank JSONL row/, '两个 LF = 一个空行，不是 canonical 空工件');
  strict(Buffer.from('\r\n', 'utf8'), /non-blank JSONL row/, 'CRLF 的空行也不是 canonical 空工件');
  strict(Buffer.from(' \n', 'utf8'), /non-blank JSONL row/, '只有空白的行');
  strict(Buffer.from(goodRow + '\n\n', 'utf8'), /non-blank JSONL row/, '有效行之后的空行');
  // 缺末行 LF **且**末行残缺 = 截断写坏（这是既有契约：末行完整但缺 LF 是收下并记 finalLf:false）。
  strict(Buffer.from(goodRow.slice(0, goodRow.length - 24), 'utf8'), /does not end with LF|truncated write/, '缺末行 LF 且末行残缺 = 截断写坏');
  // 末行完整但缺 LF：不是空工件，也不是截断 —— 收下，finalLf 如实记 false。
  const noFinalLf = readSummaryBytes('complete-no-final-lf', Buffer.from(goodRow, 'utf8'));
  const parsedNoLf = readEchoIndexJsonl(noFinalLf, 'summaries.jsonl', SUMMARY_SET, { allowEmpty: true });
  assert.equal(parsedNoLf.rows.length, 1, '末行完整但缺 LF：收下这一行');
  assert.equal(parsedNoLf.finalLf, false);
  strict(Buffer.from('{"id":\n', 'utf8'), /invalid JSON|end with LF/, 'invalid JSON');
  strict(Buffer.from(JSON.stringify({ id: 'cmp-x' }) + '\n', 'utf8'), /field set/, '字段集漂移');
  strict(Buffer.from(JSON.stringify({ ...JSON.parse(goodRow), extra: 1 }) + '\n', 'utf8'), /field set/, '多出字段');
  strict(Buffer.from('null\n', 'utf8'), /must be a JSON object/, '非对象行');
  strict(Buffer.from('[]\n', 'utf8'), /must be a JSON object/, '数组行');
  // 有效单行仍然被收下（允许空 ≠ 只允许空）
  const one = L('one-valid-row', Buffer.from(goodRow + '\n', 'utf8'));
  const parsed = readEchoIndexJsonl(one, 'summaries.jsonl', SUMMARY_SET, { allowEmpty: true });
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].obj.id, 'cmp-empty-sum-1');
});

// ══ 6. 只读体检走同一个读者：零行摘要照样出报告，不是整源跳过 ══════════════
check('read-only inspect accepts both empty shapes and keeps per-source word counts', () => {
  for (const [tag, bytes] of [['inspect-zero', ZERO], ['inspect-lf', ONE_LF]]) {
    const fixture = makeFeed(tag, { summaries: bytes });
    const report = inspectEchoIndexFeed({
      filesPath: fixture.filesPath, wordsPath: fixture.wordsPath, summariesPath: fixture.summariesPath
    });
    assert.equal(report.ok, true);
    assert.equal(report.summaries.rows, 0);
    assert.equal(report.words.rows, 1);
    assert.equal(report.wouldBuild.summaries, 0);
    assert.equal(report.wouldBuild.words, 1);
    assert.equal(report.wouldBuild.allowed, true);
    const counts = Object.values(report.perSource);
    assert.equal(counts.length, 1);
    assert.equal(counts[0].words, 1, '源仍被计数：空摘要不是跳过整源的许可');
    assert.equal(counts[0].summaries, 0);
  }
});

// ══ 7. 两种空形态产出同一种 canonical 工件（字节相同）══════════════════════
check('0-byte and single-LF inputs emit byte-identical summaries output', () => {
  const a = buildFromEchoIndexFiles(buildOptions(makeFeed('parity-zero', { summaries: ZERO }), 'g1'));
  const b = buildFromEchoIndexFiles(buildOptions(makeFeed('parity-lf', { summaries: ONE_LF }), 'g1'));
  assert.deepEqual(fs.readFileSync(a.summariesPath), fs.readFileSync(b.summariesPath));
  assert.equal(a.manifest.summaries.sha256, b.manifest.summaries.sha256);
  assert.deepEqual(fs.readFileSync(a.wordsPath), fs.readFileSync(b.wordsPath));
  assert.equal(a.manifest.words.sha256, b.manifest.words.sha256);
  assert.notEqual(a.manifest.sourceInput.summaries.sha256, b.manifest.sourceInput.summaries.sha256,
    '输入指纹必须如实区分「0 字节」与「1 字节 LF」');
});

console.log('RESULT ' + passed + ' passed / ' + failed + ' failed');
if (failed) process.exitCode = 1;
fs.rmSync(ROOT, { recursive: true, force: true });
