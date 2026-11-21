#!/usr/bin/env node
// Synthetic, TEMP-only selftest for the count-only selected-log rejection telemetry
// added to collectEchoIndexFeed (report.selectionFilter + manifest.counts.selectionFilter).
//
// 它证明四件事：
//   ① 计数精确 —— 选定源之外的行 / 缺 log 的行 / log 不是字符串的行，各归各的桶，逐数对上；
//   ② 筛选决定不变 —— 被挡下的行一条都不发射，选中的行按原样发射；
//   ③ 输出与既有语义等于 baseline —— 发射的 words/summaries 与**改动前构建器**产出的字节逐字相同
//      （GOLDEN_* 常量取自改动前的构建器，见下方 provenance），既有 counts 一个都没动；
//   ④ 纯计数 —— telemetry 里不含任何路径、会话 id、行文本。
//
// provenance（GOLDEN_*）：
//   改动前的 echo-source-build.mjs（SHA-256 = 2D5B7BEC…4D0885C）对**同一份 fixture** 构建出的
//   words.jsonl / summaries.jsonl 原文，原样抄在这里。两次构建的 words/summaries 字节相同、
//   manifest 除新增 counts.selectionFilter 外相同 —— 已用那份原件副本实测过。
//
// 只读合成 JSONL，fixture 全部落在 os.tmpdir() 之下；声称的 log 路径是合成路径（feed 模式从不读它）。
// 不碰生产索引、不碰 DB、不碰会话日志。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {
  buildFromEchoIndexFiles, inspectEchoIndexFeed, ECHO_INDEX_FEED_VERSION,
} from './echo-source-build.mjs';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-selection-filter-selftest-'));
// 合成 log 路径：机器无关，所以 GOLDEN_* 的字节是稳定的（feed 模式不读这些文件）。
const SELECTED_LOG = 'D:/synthetic/echo-selection-filter-selftest/selected.jsonl';
const FOREIGN_LOG = 'D:/synthetic/echo-selection-filter-selftest/foreign.jsonl';
const SID_SELECTED = 'synthetic-selected-session';
const SID_FOREIGN = 'synthetic-foreign-session';
const T0 = '2026-11-16T06:00:00.000Z';
const T1 = '2026-11-16T06:05:00.000Z';

// baseline：改动前构建器对这一份 fixture 发射的**原文**（逐字节比对用）。
const GOLDEN_WORDS = [
  '{"t":"2026-11-16T06:00:00.000Z","session":"synthetic-selected-session","ws":null,"seq":0,"turn":null,"log":"D:/synthetic/echo-selection-filter-selftest/selected.jsonl","role":"user","kind":"human","len":30,"truncated":false,"text":"synthetic selected query alpha"}',
  '{"t":"2026-11-16T06:00:00.000Z","session":"synthetic-selected-session","ws":null,"seq":1,"turn":null,"log":"D:/synthetic/echo-selection-filter-selftest/selected.jsonl","role":"assistant","kind":"结论","len":30,"truncated":false,"text":"synthetic selected answer beta"}',
].join('\n') + '\n';
const GOLDEN_SUMMARIES = '{"cmpId":"cmp-synthetic-selected","t":"2026-11-16T06:05:00.000Z","session":"synthetic-selected-session","ws":null,"log":"D:/synthetic/echo-selection-filter-selftest/selected.jsonl","srcSeqs":[1,0],"shadowedTokens":5,"shadowedChars":7,"provider":"synthetic","model":"synthetic-summary","status":"active","summary":"synthetic summary of the selected source","manifest":{"range":[0,0],"n":2,"marks":[]}}' + '\n';

let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  console.log('ok ' + checks + ' - ' + name);
}

const fileRow = (file, sid, nWord, nSum) => ({
  file, key: 'synthetic-key-' + sid, nextByte: 4096, ws: null, sid, nSum, nWord,
  sumOut: file.split('.jsonl').join('.summaries.jsonl'),
  wordOut: file.split('.jsonl').join('.words.jsonl'),
});

const word = (o) => {
  const row = {
    t: o.t === undefined ? T0 : o.t,
    session: o.session,
    ws: null,
    seq: o.seq,
    turn: null,
    log: o.log,
    kind: o.kind === undefined ? 'human' : o.kind,
    len: Array.from(o.text).length,
    truncated: false,
    text: o.text,
  };
  if (o.role !== undefined) row.role = o.role;
  return row;
};

const summary = (o) => ({
  id: o.id,
  t: o.t === undefined ? T1 : o.t,
  session: o.session,
  ws: null,
  log: o.log,
  srcSeqs: o.srcSeqs,
  shadowedTokens: 5,
  chars: 7,
  provider: 'synthetic',
  model: 'synthetic-summary',
  status: 'active',
  summary: o.summary,
  manifest: { range: [0, 0], n: o.srcSeqs.length, marks: [] },
});

function writeFeed(dirName, spec) {
  const dir = path.join(ROOT, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const write = (name, list) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, Buffer.from(list.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8'));
    return file;
  };
  return {
    dir,
    filesPath: write('files.jsonl', spec.files),
    wordsPath: write('words.jsonl', spec.words),
    summariesPath: write('summaries.jsonl', spec.summaries),
  };
}

const buildOptions = (fixture, tag, extra) => ({
  filesPath: fixture.filesPath,
  wordsPath: fixture.wordsPath,
  summariesPath: fixture.summariesPath,
  selectedLogPath: SELECTED_LOG,
  namespace: 'log',
  generation: 1,
  builtAt: '2026-11-16T06:30:00.000Z',
  outDir: path.join(fixture.dir, 'out', tag),
  ...(extra || {}),
});

const readRows = (file) => fs.readFileSync(file, 'utf8').trimEnd().split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l));

// ── 被选中源的两条 word / 一条 summary（这些必须一字不易地发射出去）───────────
const SELECTED_WORDS = [
  word({ session: SID_SELECTED, seq: 0, log: SELECTED_LOG, text: 'synthetic selected query alpha' }),
  word({ session: SID_SELECTED, seq: 1, log: SELECTED_LOG, kind: '结论', role: 'assistant', text: 'synthetic selected answer beta' }),
];
const SELECTED_SUMMARY = summary({
  id: 'cmp-synthetic-selected', session: SID_SELECTED, log: SELECTED_LOG,
  srcSeqs: [1, 0], summary: 'synthetic summary of the selected source',
});

// ── 会被筛选挡下的行：三桶各一条（foreign 路径 / 缺 log / log 不是字符串）──────
const FOREIGN_WORD = word({ session: SID_FOREIGN, seq: 2, log: FOREIGN_LOG, text: 'synthetic foreign query gamma' });
const MISSING_LOG_WORD = word({ session: SID_SELECTED, seq: 3, log: null, text: 'synthetic word with no log' });
const INVALID_LOG_WORD = word({ session: SID_SELECTED, seq: 4, log: 4242, text: 'synthetic word whose log is a number' });
const FOREIGN_SUMMARY = summary({ id: 'cmp-synthetic-foreign', session: SID_FOREIGN, log: FOREIGN_LOG, srcSeqs: [], summary: 'synthetic foreign summary' });
const MISSING_LOG_SUMMARY = summary({ id: 'cmp-synthetic-no-log', session: SID_SELECTED, log: null, srcSeqs: [], summary: 'synthetic summary with no log' });
const INVALID_LOG_SUMMARY = summary({ id: 'cmp-synthetic-bad-log', session: SID_SELECTED, log: true, srcSeqs: [], summary: 'synthetic summary whose log is a boolean' });

// 三个真实会出现的桶各一条；nonCanonicalLog 恒为 0：log 是字符串却归不成规范路径时，
// keepSelected 自己会抛、构建随之中止 —— 那种情况永远不会出现在「成功的构建」读数里。
const EXPECTED_BUCKET = { missingLog: 1, invalidType: 1, nonCanonicalLog: 0, nonSelectedPath: 1, rejected: 3 };
const ZERO_BUCKET = { missingLog: 0, invalidType: 0, nonCanonicalLog: 0, nonSelectedPath: 0, rejected: 0 };

// ── ① 计数精确 ───────────────────────────────────────────────────────────────
const mixed = writeFeed('mixed', {
  files: [fileRow(SELECTED_LOG, SID_SELECTED, 2, 1)],
  words: [...SELECTED_WORDS, FOREIGN_WORD, MISSING_LOG_WORD, INVALID_LOG_WORD],
  summaries: [SELECTED_SUMMARY, FOREIGN_SUMMARY, MISSING_LOG_SUMMARY, INVALID_LOG_SUMMARY],
});
const mixedBuilt = buildFromEchoIndexFiles(buildOptions(mixed, 'g1'));

check('混合 feed：三个桶逐数对上（选定源之外 / 缺 log / log 不是字符串 各一条）', () => {
  const f = mixedBuilt.manifest.counts.selectionFilter;
  assert.equal(f.applied, true, '走 selectedLogPath 的构建必须标记 applied');
  assert.deepEqual(f.words, EXPECTED_BUCKET, 'words：nonSelectedPath 1 + missingLog 1 + invalidType 1');
  assert.deepEqual(f.summaries, EXPECTED_BUCKET, 'summaries：同样的三桶各一条');
  assert.deepEqual(Object.keys(f.words).sort(), ['invalidType', 'missingLog', 'nonCanonicalLog', 'nonSelectedPath', 'rejected'],
    '桶的字段集固定，不许再塞别的东西');
  for (const k of Object.keys(f.words)) assert.ok(Number.isSafeInteger(f.words[k]) && f.words[k] >= 0, '计数必须是非负安全整数');
  assert.equal(f.words.rejected, f.words.missingLog + f.words.invalidType + f.words.nonCanonicalLog + f.words.nonSelectedPath,
    'rejected 必须是各桶之和，不许自成一数');
});

// ── ② 被挡下的行一条都没发射 ─────────────────────────────────────────────────
check('混合 feed：被挡下的行一条都没发射，选中的行逐条发射', () => {
  const words = readRows(mixedBuilt.wordsPath);
  const summaries = readRows(mixedBuilt.summariesPath);
  assert.equal(words.length, 2);
  assert.equal(summaries.length, 1);
  assert.deepEqual(words.map((w) => w.text), SELECTED_WORDS.map((w) => w.text), 'words 只剩被选中源那两条，顺序不变');
  assert.deepEqual(words.map((w) => w.role), ['user', 'assistant']);
  assert.deepEqual(words.map((w) => w.seq), [0, 1]);
  assert.equal(words.every((w) => w.log === SELECTED_LOG), true);
  assert.equal(summaries[0].cmpId, 'cmp-synthetic-selected');
  assert.deepEqual(summaries[0].srcSeqs, [1, 0], 'srcSeqs 顺序原样保留');
});

// ── ③ 输出等于 baseline（改动前构建器的原文）─────────────────────────────────
check('baseline：words.jsonl / summaries.jsonl 与改动前构建器的产出逐字节相同', () => {
  assert.equal(fs.readFileSync(mixedBuilt.wordsPath, 'utf8'), GOLDEN_WORDS, 'words 必须等于改动前的原文');
  assert.equal(fs.readFileSync(mixedBuilt.summariesPath, 'utf8'), GOLDEN_SUMMARIES, 'summaries 必须等于改动前的原文');
  assert.equal(mixedBuilt.manifest.words.rows, 2);
  assert.equal(mixedBuilt.manifest.summaries.rows, 1);
  assert.equal(mixedBuilt.manifest.version, ECHO_INDEX_FEED_VERSION);
});

// ── ④ 既有 counts / 游标记号一个都没被挤走 ───────────────────────────────────
check('既有 counts 全部照旧（新字段只加不换）', () => {
  const c = mixedBuilt.manifest.counts;
  assert.equal(c.words, 2);
  assert.equal(c.summaries, 1);
  assert.equal(c.srcSeqs, 2);
  assert.equal(c.excludedReasoning, 0);
  assert.equal(c.wordRows, 2, 'wordRows 仍是过滤后的行数');
  assert.equal(c.summaryRows, 1);
  assert.equal(c.files, 1);
  assert.equal(c.srcSeqResolved, 2);
  assert.equal(c.srcSeqDangling, 0);
  assert.equal(c.lenRebased, 0);
  assert.equal(c.exactDuplicateWords, 0);
  assert.equal(c.exactDuplicateSummaries, 0);
  assert.equal(c.excluded, 0);
  assert.equal(c.skippedUnchanged, 0);
  assert.equal(c.appended, 0);
  assert.equal(c.fresh, 1);
  assert.equal(mixedBuilt.manifest.cursor.seq, 1, '游标仍是发射出去的最大 seq');
  assert.equal(mixedBuilt.manifest.summaryRefs.dangling, 0);
  assert.deepEqual(mixedBuilt.manifest.pointerLimitations.length, 1);
});

// ── ⑤ 筛选决定不变：混合 feed ≡ 只含被选中行的 feed ─────────────────────────
const selectedOnly = writeFeed('selected-only', {
  files: [fileRow(SELECTED_LOG, SID_SELECTED, 2, 1)],
  words: [...SELECTED_WORDS],
  summaries: [SELECTED_SUMMARY],
});
const selectedOnlyBuilt = buildFromEchoIndexFiles(buildOptions(selectedOnly, 'g1'));

check('筛选决定不变：混合 feed 与「只含选中行」的 feed 发射逐字节相同', () => {
  assert.deepEqual(fs.readFileSync(mixedBuilt.wordsPath), fs.readFileSync(selectedOnlyBuilt.wordsPath), 'words.jsonl 逐字节相同');
  assert.deepEqual(fs.readFileSync(mixedBuilt.summariesPath), fs.readFileSync(selectedOnlyBuilt.summariesPath), 'summaries.jsonl 逐字节相同');
  assert.equal(mixedBuilt.manifest.words.sha256, selectedOnlyBuilt.manifest.words.sha256, '同一份输出 → 同一个 sha');
  assert.deepEqual(selectedOnlyBuilt.manifest.counts.selectionFilter.words, ZERO_BUCKET, '没有该挡的行 → 全零，不虚报');
  assert.deepEqual(selectedOnlyBuilt.manifest.counts.selectionFilter.summaries, ZERO_BUCKET);
  assert.equal(selectedOnlyBuilt.manifest.counts.selectionFilter.applied, true);
});

check('baseline：清单除新增计数键与 sourceInput 输入指纹外逐字节相同', () => {
  // sourceInput 记的是**输入文件**的 sha/bytes —— 两份 fixture 的输入物理上就不同（混合版多三行），
  // 它必然不同，且与本次改动无关；输出侧（words/summaries + 全部既有 counts）必须完全一致。
  const strip = (m) => {
    const copy = JSON.parse(JSON.stringify(m));
    delete copy.counts.selectionFilter;
    delete copy.sourceInput;
    return copy;
  };
  assert.deepEqual(strip(mixedBuilt.manifest), strip(selectedOnlyBuilt.manifest),
    '删掉 counts.selectionFilter 与 sourceInput 后，整份 manifest 必须与「只含选中行」的构建完全一致');
  assert.equal(mixedBuilt.manifest.summaries.sha256, selectedOnlyBuilt.manifest.summaries.sha256, '输出 summaries 的 sha 相同');
  assert.equal(mixedBuilt.manifest.sourceInput.words.rows, selectedOnlyBuilt.manifest.sourceInput.words.rows,
    'sourceInput.words.rows 记的是过滤后的行数，两边相同');
  assert.notEqual(mixedBuilt.manifest.sourceInput.words.sha256, selectedOnlyBuilt.manifest.sourceInput.words.sha256,
    '输入文件本身不同 —— 这正是 fixture 的构造意图，不是输出变了');
});

check('两份构建的既有 counts / 游标 / 引用读数完全一致', () => {
  const keys = ['words', 'summaries', 'srcSeqs', 'excludedReasoning', 'wordRows', 'summaryRows', 'files',
    'srcSeqResolved', 'srcSeqDangling', 'lenRebased', 'exactDuplicateWords', 'exactDuplicateSummaries',
    'excluded', 'skippedUnchanged', 'appended', 'fresh', 'fullRebuild', 'excludedByType', 'truncatedExcluded'];
  for (const k of keys) {
    assert.deepEqual(mixedBuilt.manifest.counts[k], selectedOnlyBuilt.manifest.counts[k], '既有 counts.' + k + ' 不该随 telemetry 变动');
  }
  assert.equal(mixedBuilt.manifest.cursor.seq, selectedOnlyBuilt.manifest.cursor.seq);
  assert.equal(mixedBuilt.manifest.cursor.inputBytes, selectedOnlyBuilt.manifest.cursor.inputBytes);
  assert.deepEqual(mixedBuilt.manifest.cursor.feed, selectedOnlyBuilt.manifest.cursor.feed);
  assert.deepEqual(mixedBuilt.manifest.summaryRefs, selectedOnlyBuilt.manifest.summaryRefs);
  assert.deepEqual(mixedBuilt.manifest.pointerLimitations, selectedOnlyBuilt.manifest.pointerLimitations);
});

// ── ⑥ 计数与声明无关：foreign 源在 files.jsonl 里声明与否，计数一样 ───────────
const declaredForeign = writeFeed('declared-foreign', {
  files: [fileRow(SELECTED_LOG, SID_SELECTED, 2, 1), fileRow(FOREIGN_LOG, SID_FOREIGN, 1, 1)],
  words: [...SELECTED_WORDS, FOREIGN_WORD, MISSING_LOG_WORD, INVALID_LOG_WORD],
  summaries: [SELECTED_SUMMARY, FOREIGN_SUMMARY, MISSING_LOG_SUMMARY, INVALID_LOG_SUMMARY],
});
const declaredForeignBuilt = buildFromEchoIndexFiles(buildOptions(declaredForeign, 'g1'));

check('计数只看路径是否等于选定源，与 files.jsonl 是否声明该源无关', () => {
  assert.deepEqual(declaredForeignBuilt.manifest.counts.selectionFilter.words, EXPECTED_BUCKET);
  assert.deepEqual(declaredForeignBuilt.manifest.counts.selectionFilter.summaries, EXPECTED_BUCKET);
  assert.deepEqual(fs.readFileSync(declaredForeignBuilt.wordsPath), fs.readFileSync(mixedBuilt.wordsPath), '发射结果不受影响');
  assert.equal(declaredForeignBuilt.manifest.counts.words, mixedBuilt.manifest.counts.words);
});

// ── ⑦ 纯计数：telemetry 里不含路径 / 会话 / 行文本 ───────────────────────────
check('telemetry 是纯计数：序列化后不含任何路径、会话 id 或行文本', () => {
  const serialized = JSON.stringify(mixedBuilt.manifest.counts.selectionFilter);
  for (const needle of ['selected.jsonl', 'foreign.jsonl', 'synthetic', 'D:/', ROOT,
    SID_SELECTED, SID_FOREIGN, 'alpha', 'beta', 'gamma', 'query', 'summary']) {
    assert.equal(serialized.includes(needle), false, 'telemetry 里不该出现 ' + JSON.stringify(needle));
  }
  assert.deepEqual(Object.keys(mixedBuilt.manifest.counts.selectionFilter).sort(), ['applied', 'summaries', 'words'],
    '顶层只有 applied/words/summaries');
  assert.equal(typeof mixedBuilt.manifest.counts.selectionFilter.applied, 'boolean');
});

// ── ⑧ 未走 selectedLogPath 的既有路径：applied=false、全零，别的照旧 ─────────
// 注意：不带 selectedLogPath 时行会被完整校验（缺 log / log 非字符串是硬拒，不是筛掉），
// 所以这一份 fixture 每行都带合法 log —— 它测的是「没筛选过就不许报挡过行」。
const plain = writeFeed('plain', {
  files: [fileRow(SELECTED_LOG, SID_SELECTED, 2, 1), fileRow(FOREIGN_LOG, SID_FOREIGN, 1, 1)],
  words: [...SELECTED_WORDS, word({ session: SID_FOREIGN, seq: 7, log: FOREIGN_LOG, text: 'synthetic foreign query delta' })],
  summaries: [SELECTED_SUMMARY, summary({ id: 'cmp-synthetic-foreign-plain', session: SID_FOREIGN, log: FOREIGN_LOG, srcSeqs: [], summary: 'synthetic foreign summary' })],
});
const plainBuilt = buildFromEchoIndexFiles({
  ...buildOptions(plain, 'g-plain'),
  selectedLogPath: undefined,
  sourcePath: 'D:/synthetic/echo-index-feed/index',
});

check('非 selected 构建：applied=false 且计数全零（不冒充「挡过行」），发射照旧', () => {
  const f = plainBuilt.manifest.counts.selectionFilter;
  assert.equal(f.applied, false);
  assert.deepEqual(f.words, ZERO_BUCKET);
  assert.deepEqual(f.summaries, ZERO_BUCKET);
  assert.equal(plainBuilt.manifest.counts.words, 3, '未筛选时两个源的 word 都发射');
  assert.equal(plainBuilt.manifest.counts.summaries, 2);
  assert.equal(plainBuilt.manifest.counts.files, 2);
  assert.equal(plainBuilt.manifest.counts.srcSeqResolved, 2);
  assert.equal(plainBuilt.manifest.counts.srcSeqDangling, 0);
  assert.equal(readRows(plainBuilt.wordsPath).length, 3);
});

// ── ⑨ 只读视图一字不改 ───────────────────────────────────────────────────────
check('只读 inspect 视图未膨胀：没有 selectionFilter 字段、读数与构建一致、不写任何文件', () => {
  const before = fs.readdirSync(plain.dir).sort();
  const report = inspectEchoIndexFeed({ filesPath: plain.filesPath, wordsPath: plain.wordsPath, summariesPath: plain.summariesPath });
  const after = fs.readdirSync(plain.dir).sort();
  assert.deepEqual(after, before, 'inspect 只读：目录内容一个都不许变');
  assert.equal(report.ok, true);
  assert.equal(report.readOnly, true);
  assert.equal(Object.prototype.hasOwnProperty.call(report, 'selectionFilter'), false,
    '新字段只加在 collected.report / manifest.counts，不改 inspect 的既有视图');
  assert.equal(report.words.emitted, 3, '只读视图的发射读数与构建一致');
  assert.equal(report.summaries.emitted, 2);
  assert.deepEqual(report.wouldBuild.refusals, []);
});

// ── ⑩ 确定性：同一份输入 → 同一份计数与同一份字节 ───────────────────────────
check('确定性：同一份输入两次构建，计数与发射字节都相同', () => {
  const again = buildFromEchoIndexFiles(buildOptions(mixed, 'g1-again'));
  assert.deepEqual(again.manifest.counts.selectionFilter, mixedBuilt.manifest.counts.selectionFilter, '同一份输入 → 同一份计数');
  assert.deepEqual(fs.readFileSync(again.wordsPath), fs.readFileSync(mixedBuilt.wordsPath), '同一份输入 → 同一份 words 字节');
  assert.deepEqual(fs.readFileSync(again.summariesPath), fs.readFileSync(mixedBuilt.summariesPath), '同一份输入 → 同一份 summaries 字节');
});

fs.rmSync(ROOT, { recursive: true, force: true });
assert.equal(fs.existsSync(ROOT), false, 'TEMP fixture 必须清干净');
console.log('# selection-filter selftest passed: ' + checks + ' checks');
