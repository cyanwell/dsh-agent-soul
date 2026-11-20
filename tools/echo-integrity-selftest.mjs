#!/usr/bin/env node
// tools/echo-integrity-selftest.mjs —— ECHO 索引完整性自检（TEMP DB ONLY）
// ============================================================================
// 覆盖面刻意窄。只测「完整性判据」这一件事，不测导入语义 / 指针 / 检索排序：
//
//   A. Store 门面上的完整性闸：
//      1. 正常库：store.echoStats() → aligned=true / ok=true，problems=[]，检索照常命中；
//      2. 人为从 echo_words_fts 删掉一行（只删 FTS，不动 echo_words）：
//         · store.echoStats() 必须 aligned=false、ok=false，problems 里指名 words-fts 差多少；
//         · store.echoSearch() 必须抛 ECHO_INDEX_STALE，
//           **不许**回一份看起来正常、实际少命中的结果。
//   B. 判据只有一份（Task-14）：analyzer / store / 导入器三条腿在同一个库上必须说同一句话
//      （problems 逐条相同、ok / aligned / orphanFts 相同）。覆盖：
//        healthy / FTS 缺行 / 代次 vs 构建记录 / 游标 JSON 坏 / 游标 seq 不一致 /
//        state 未 committed / 孤儿 FTS 行 / 缺表（不许抛）。
//   C. 来源行**声明计数**（Task-16 final amendment）：echo_index_sources.words_count /
//      summaries_count / src_seq_count 与实际内容比 —— 只报**一条** kind
//      （source-declared-counts，三个成对字段），且**参与 aligned / 闸检索**：
//        · 三列各自单独改一次 → problems 里出现那一条，字段逐字段可对，ok=false，
//          aligned=false、检索抛 ECHO_INDEX_STALE（纯声明漂移也 fail closed）；
//        · 行与它的 FTS 孪生行被**同时**删掉 → 只有声明看得出来（3 vs 2）；
//          这一条钉住的是「不许静默少命中」：aligned=false、检索抛 ECHO_INDEX_STALE，
//          **不许**回一份少 1 条的部分结果；
//        · 真导一份**没有摘要**的清单 → 声明 0/0/0 与空结构一致，判健康（声明值不是
//          只有「改坏」这一种形态，0 也必须被认成健康）。
//   D. 两条老案子补上（Task-16 之前没覆盖的坏法）：
//        · 删一行 echo_summaries_fts → summaries-fts / aligned=false / ECHO_INDEX_STALE；
//        · 删一行 echo_summary_src_seqs，摘要自己声明的和不动 → **只有** src-seq-count
//          （对齐真坏了），且不许多报 source-declared-counts —— 一次坏法只许报一条。
//      另加静态断言：
//        · src/db/echo-integrity.mjs 里**不能出现** tools/ 的 import（依赖方向铁律）；
//        · 九种 problem kind 一个不少（名字是对外形状，改名就是破坏）；
//        · isEchoSourceAligned 把声明列算进对齐（相等才 true；store 调用点必须传声明值）。
//      ★ 形状：echoIndexInfo / analyzeEchoIntegrity().index 的来源行仍是原来的十个键 ——
//        声明值只在判据内部用，不许外泄成新字段。
//   C. 收尾：关连接、删整个临时目录（并断言它真的没了）。
//
// ★ 全程只碰 os.tmpdir() 下的合成语料与新建 meta.sqlite：不碰 data/、不碰任何生产库、
//   不调共享 doctor、不改源码/迁移/配置/路由、不起服务。
// ★ 语料在本文件里现造，不复制 tools/fixtures/echo-index-import/ ——
//   那个目录被别的自检共用，属写者冲突面；共享只读文件也会让「我的自检为什么红了」
//   变成一句无法归因的猜测。
// ★ 为什么必须删 FTS 行而不是改计数：计数列是审计值，FTS 行是索引本体。
//   删索引本体正是「检索会静默少命中」的形状 —— 这道闸存在的唯一理由。
// ★ 每种坏法都从同一份健康库**复制**出来打，打完立刻关 —— 前一种坏法不许污染后一种
//   （否则「游标坏」那条可能是被 FTS 缺行带红的假通过）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openMetaStore } from '../src/db/index.mjs';
import { runImport, charLen, verifyEchoIntegrity } from './echo-index-import.mjs';
import { analyzeEchoIntegrity, echoIndexInfo, isEchoSourceAligned, ECHO_INTEGRITY_PROBLEM_KINDS, ECHO_INTEGRITY_TABLES } from '../src/db/echo-integrity.mjs';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-integrity-selftest-'));

const ok = [];
const bad = [];
function t(name, cond, detail) {
  (cond ? ok : bad).push((cond ? '✓ ' : '✗ ') + name + (detail === undefined || detail === null ? '' : '  → ' + String(detail)));
  return cond;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function sha256File(p) {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

// ── 合成语料（现造，2 个 session / 3 条词行 / 1 条摘要覆盖 seq 1,2）──────────
const FIXTURE_WORDS = [
  { t: '2026-11-01T00:00:00.000Z', session: 'session-integrity-0001', ws: 'ws-integrity', seq: 1, turn: 1, log: 'D:/synthetic/integrity/s1.jsonl', role: 'user', kind: 'message', text: '解耦机制写在派生索引里' },
  { t: '2026-11-01T00:00:01.000Z', session: 'session-integrity-0001', ws: 'ws-integrity', seq: 2, turn: 2, log: 'D:/synthetic/integrity/s1.jsonl', role: 'assistant', kind: 'message', text: 'makeStreamFingerprint 与 FTS 对齐' },
  { t: '2026-11-01T00:00:02.000Z', session: 'session-integrity-0002', ws: null, seq: 1, turn: null, log: null, role: 'user', kind: 'message', text: '索引计数不对齐就拒绝检索' },
];
const FIXTURE_SUMMARIES = [
  { cmpId: 'cmp-integrity-0001', t: '2026-11-02T00:00:00.000Z', session: 'session-integrity-0001', ws: 'ws-integrity', log: 'D:/synthetic/integrity/s1.jsonl', srcSeqs: [1, 2], shadowedTokens: 120, shadowedChars: 340, provider: 'deepseek', model: 'deepseek-v4', status: 'active', summary: '压缩摘要：派生索引的完整性闸（解耦）' },
];
const MANIFEST_CURSOR_SEQ = 7;

function writeFixture() {
  const dir = path.join(ROOT, 'fixture');
  fs.mkdirSync(dir, { recursive: true });
  const wordsPath = path.join(dir, 'words.jsonl');
  const summariesPath = path.join(dir, 'summaries.jsonl');
  // len 用导入器自己的 charLen 算，免得「我以为的字符数」和它的判据分叉。
  fs.writeFileSync(wordsPath, FIXTURE_WORDS.map((r) => JSON.stringify({ ...r, len: charLen(r.text), truncated: false })).join('\n') + '\n');
  fs.writeFileSync(summariesPath, FIXTURE_SUMMARIES.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const manifest = {
    echoIndexVersion: 'echo-index/1',
    sourcePath: 'D:/synthetic/echo/integrity/index',
    namespace: 'log',
    generation: 1,
    builtAt: '2026-11-10T00:00:00.000Z',
    cursor: { seq: MANIFEST_CURSOR_SEQ, turn: 3, t: '2026-11-09T23:59:00.000Z' },
    words: { path: 'words.jsonl', sha256: sha256File(wordsPath), bytes: fs.statSync(wordsPath).size, rows: FIXTURE_WORDS.length },
    summaries: { path: 'summaries.jsonl', sha256: sha256File(summariesPath), bytes: fs.statSync(summariesPath).size, rows: FIXTURE_SUMMARIES.length },
    counts: {
      words: FIXTURE_WORDS.length,
      summaries: FIXTURE_SUMMARIES.length,
      srcSeqs: FIXTURE_SUMMARIES.reduce((a, s) => a + s.srcSeqs.length, 0),
      excludedReasoning: 0,
    },
  };
  const manifestPath = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return { manifestPath, sha256: sha256File(manifestPath) };
}

// ── 三条腿的公共判据 ───────────────────────────────────────────────────────
const kindsOf = (list) => (list || []).map((p) => p.kind);
const sortedKinds = (list) => kindsOf(list).slice().sort();
const problemOf = (list, kind) => (list || []).filter((p) => p && p.kind === kind)[0] || null;

// 导入器的旧字段名 → 判据的规范名（**只**这两个，见 src/db/echo-integrity.mjs 头注释）
function importerToCanonical(p) {
  if (p.kind === 'generation-vs-builds') {
    return { echoSourceId: p.echoSourceId, kind: p.kind, generation: p.generation, builds: p.builds, maxBuildGeneration: p.maxBuild };
  }
  if (p.kind === 'cursor-seq-json-mismatch') {
    return { echoSourceId: p.echoSourceId, kind: p.kind, cursorSeq: p.cursorSeq, cursor: p.json };
  }
  return p;
}

// 一个库、三条腿各说一遍 —— 先把「说的是不是同一件事」钉死，再谈各案细节。
function triView(store) {
  const analyzer = analyzeEchoIntegrity(store.db);
  const stats = store.echoStats();
  const importer = verifyEchoIntegrity(store.db);
  return { analyzer, stats, importer, db: store.db };
}

function assertParity(label, v) {
  const db = v.db;
  const a = v.analyzer;
  const s = v.stats;
  const im = v.importer;
  const canon = (im.problems || []).map(importerToCanonical);
  t('[parity:' + label + '] store.problems 与判据逐条相同', same(s.problems, a.problems), JSON.stringify({ stats: s.problems, analyzer: a.problems }));
  t('[parity:' + label + '] 导入器 problems 映射回规范名后与判据逐条相同（只映射 maxBuild / json）',
    same(canon, a.problems), JSON.stringify({ importer: canon, analyzer: a.problems }));
  t('[parity:' + label + '] 三条腿的 kind 集合相同', same(sortedKinds(s.problems), sortedKinds(a.problems)) && same(sortedKinds(im.problems), sortedKinds(a.problems)),
    JSON.stringify({ stats: sortedKinds(s.problems), importer: sortedKinds(im.problems), analyzer: sortedKinds(a.problems) }));
  t('[parity:' + label + '] ok 三处一致', s.ok === a.ok && im.ok === a.ok, JSON.stringify({ stats: s.ok, importer: im.ok, analyzer: a.ok }));
  t('[parity:' + label + '] aligned 两处一致（导入器只经 index.aligned 暴露）',
    s.aligned === a.aligned && im.index.aligned === a.aligned, JSON.stringify({ stats: s.aligned, importer: im.index.aligned, analyzer: a.aligned }));
  t('[parity:' + label + '] orphanFts 三处一致', same(s.orphanFts, a.orphanFts) && same(im.orphanFts, a.orphanFts), JSON.stringify(a.orphanFts));
  t('[parity:' + label + '] 计数面：store 的富来源行与 echoIndexInfo 的计数逐条相同',
    same(s.sources.map((x) => [x.echoSourceId, x.words, x.wordsFts, x.summaries, x.summariesFts, x.seqRows, x.declaredSeqRows]),
      echoIndexInfo(db).sources.map((x) => [x.echoSourceId, x.words, x.wordsFts, x.summaries, x.summariesFts, x.seqRows, x.declaredSeqRows])));
  return { a, s, im, canon };
}

function searchOk(store) {
  const r = store.echoSearch('解耦', { limit: 10 });
  return r.results.length === 2;
}

// 闸住 = 抛 ECHO_INDEX_STALE，且**没有**返回任何结果（走到 return 就算 fail）。
function searchStale(store) {
  try {
    store.echoSearch('解耦', { limit: 10 });
    return false;
  } catch (e) {
    return !!e && e.code === 'ECHO_INDEX_STALE';
  }
}

function main() {
  const dbPath = path.join(ROOT, 'meta.sqlite');
  const fixture = writeFixture();
  t('[fixture] 合成语料写进临时目录', fs.existsSync(fixture.manifestPath) && fs.existsSync(dbPath) === false, path.relative(ROOT, fixture.manifestPath));

  // ① 先建一个干净的 v9 库（迁移只作用在这个临时文件上）
  const boot = openMetaStore({ path: dbPath, mode: 'readwrite' });
  try { boot.migrate(); } finally { boot.close(); }
  t('[schema] 临时库迁到 v9 且文件已落盘', fs.existsSync(dbPath), 'db=' + dbPath);

  // ② 走真实导入器（同一进程，只写这个临时库）
  const receipt = runImport(['--manifest', fixture.manifestPath, '--sha256', fixture.sha256, '--generation', '1', '--db', dbPath]);
  t('[import] code=IMPORTED / wrote=true', receipt.code === 'IMPORTED' && receipt.wrote === true, receipt.code);
  t('[import] counts 与合成语料一致', same(receipt.counts, { words: 3, summaries: 1, srcSeqs: 2, excludedReasoning: 0 }), JSON.stringify(receipt.counts));

  // ②b 留一份**健康库副本**：后面每种坏法都从它复制，互不污染。
  const healthy = path.join(ROOT, 'healthy.sqlite');
  fs.copyFileSync(dbPath, healthy);
  t('[fixture] 健康库副本已落盘（后续坏法都从它复制）', fs.existsSync(healthy));

  const store = openMetaStore({ path: dbPath, mode: 'readwrite' });
  try {
    // ③ 正常状态：统计对齐、检索可用
    const stats1 = store.echoStats();
    const src1 = stats1.sources && stats1.sources.length === 1 ? stats1.sources[0] : null;
    t('[stats:normal] available=true', stats1.available === true, 'available=' + stats1.available);
    t('[stats:normal] aligned=true', stats1.aligned === true, 'aligned=' + stats1.aligned);
    t('[stats:normal] ok=true', stats1.ok === true, 'ok=' + stats1.ok);
    t('[stats:normal] problems=[]', Array.isArray(stats1.problems) && stats1.problems.length === 0, JSON.stringify(stats1.problems));
    t('[stats:normal] searchable=true', stats1.searchable === true);
    t('[stats:normal] 计数：3 words / 3 FTS / 1 summary / 1 FTS / 2 srcSeqs',
      !!src1 && src1.words === 3 && src1.wordsFts === 3 && src1.summaries === 1 && src1.summariesFts === 1 && src1.seqRows === 2 && src1.declaredSeqRows === 2,
      src1 ? JSON.stringify({ words: src1.words, wordsFts: src1.wordsFts, summaries: src1.summaries, summariesFts: src1.summariesFts, seqRows: src1.seqRows }) : 'no source row');

    // ★ 形状铁律（Task-16）：来源行的默认形状不许因为新增判据而多键。
    //   声明值只在判据内部用来拼 problems —— 它一旦出现在回执里，就成了下一个人以为该读的字段。
    const shapeKeys = ['aligned', 'declaredSeqRows', 'echoSourceId', 'seqRows', 'sourcePath', 'sourceVersion', 'summaries', 'summariesFts', 'words', 'wordsFts'];
    t('[shape:normal] echoIndexInfo 默认来源行仍是十个键（无声明值外泄）',
      same(Object.keys(echoIndexInfo(store.db).sources[0]).sort(), shapeKeys), Object.keys(echoIndexInfo(store.db).sources[0]).sort().join(','));
    t('[shape:normal] analyzeEchoIntegrity().index 的来源行同样是十个键',
      same(Object.keys(analyzeEchoIntegrity(store.db).index.sources[0]).sort(), shapeKeys),
      Object.keys(analyzeEchoIntegrity(store.db).index.sources[0]).sort().join(','));

    const before = store.echoSearch('解耦', { limit: 10 });
    t('[search:normal] 同一查询此时正常命中（1 词 + 1 摘要）',
      before.results.length === 2 && before.surfaces.words.results.length === 1 && before.surfaces.summaries.results.length === 1,
      'results=' + before.results.length + ' w=' + before.surfaces.words.results.length + ' s=' + before.surfaces.summaries.results.length);

    // ④ 人为破坏：只删一行 FTS（索引本体），不动 echo_words（审计值）
    const sid = src1.echoSourceId;
    const del = store.db.prepare('DELETE FROM echo_words_fts WHERE echo_source_id = ? AND word_ord = 0').run(sid);
    t('[corrupt] 只删掉 1 行 echo_words_fts（changes=1）', Number(del.changes) === 1, 'changes=' + Number(del.changes));
    const wordsLeft = Number(store.db.prepare('SELECT COUNT(*) AS n FROM echo_words WHERE echo_source_id = ?').get(sid).n);
    const ftsLeft = Number(store.db.prepare('SELECT COUNT(*) AS n FROM echo_words_fts WHERE echo_source_id = ?').get(sid).n);
    t('[corrupt] echo_words 仍 3 行 / echo_words_fts 只剩 2 行', wordsLeft === 3 && ftsLeft === 2, 'words=' + wordsLeft + ' fts=' + ftsLeft);

    // ⑤ 统计必须把问题报出来（诊断面不闸，只说实话）
    const stats2 = store.echoStats();
    const prob = (stats2.problems || []).filter((p) => p && p.kind === 'words-fts')[0] || null;
    t('[stats:stale] available 仍为 true（缺表 ≠ 不对齐）', stats2.available === true, 'available=' + stats2.available);
    t('[stats:stale] aligned=false', stats2.aligned === false, 'aligned=' + stats2.aligned);
    t('[stats:stale] ok=false', stats2.ok === false, 'ok=' + stats2.ok);
    t('[stats:stale] problems 指名 words-fts 差 3 vs 2', !!prob && prob.words === 3 && prob.fts === 2, JSON.stringify(prob));
    t('[stats:stale] searchable=false', stats2.searchable === false);
    t('[stats:stale] note 指向 ECHO_INDEX_STALE', typeof stats2.note === 'string' && stats2.note.indexOf('ECHO_INDEX_STALE') !== -1, stats2.note);

    // ⑥ 检索必须拒绝，且不许「先回一半再报错」
    let thrown = null;
    let leaked = null;
    try { leaked = store.echoSearch('解耦', { limit: 10 }); } catch (e) { thrown = e; }
    t('[search:stale] 抛错（没有返回结果）', thrown !== null && leaked === null, leaked === null ? 'no result returned' : 'RETURNED RESULTS');
    t('[search:stale] err.code === ECHO_INDEX_STALE', !!thrown && thrown.code === 'ECHO_INDEX_STALE', thrown && thrown.code);
    t('[search:stale] details.index.aligned === false',
      !!thrown && !!thrown.details && !!thrown.details.index && thrown.details.index.aligned === false,
      thrown && thrown.details ? JSON.stringify({ aligned: thrown.details.index && thrown.details.index.aligned }) : 'no details');
    t('[search:stale] 消息说明拒绝返回不完整结果',
      !!thrown && /out of sync/i.test(String(thrown.message)) && /refusing/i.test(String(thrown.message)),
      thrown && String(thrown.message).slice(0, 120));
    t('[search:stale] 闸优先于扫描：同一个查询（正常态已命中 2 条）现在 0 结果、只抛错',
      before.results.length === 2 && thrown !== null);
  } finally {
    try { if (store && !store.closed) store.close(); } catch { /* 关闭失败不掩盖原错误 */ }
    t('[cleanup] 连接已关闭', store.closed === true);
  }

  corruptionMatrix(healthy);
  zeroSummaryCase();
  staticChecks();
}

// ── B. 三条腿 × 八种库状态 ────────────────────────────────────────────────
// ★ 每一案：复制健康库 → 打开 → 改坏一处 → 三条腿各说一遍 → 关。
function runCase(healthy, name, mutate, body, options) {
  const p = path.join(ROOT, 'case-' + name + '.sqlite');
  fs.copyFileSync(healthy, p);
  const store = openMetaStore({ path: p, mode: 'readwrite' });
  try {
    if (mutate) mutate(store.db);
    const v = triView(store);
    // 缺表这一案没法走「逐条相同」的对照：三条腿各自换成了"不可用"回执（见 C7 的专门断言）。
    const got = (options && options.parity === false)
      ? { a: v.analyzer, s: v.stats, im: v.importer }
      : assertParity(name, v);
    body(store, got);
  } finally {
    try { if (store && !store.closed) store.close(); } catch (e) { t('[cleanup:' + name + '] 关闭失败', false, e && e.message); }
  }
}

function corruptionMatrix(healthyPath) {
  // C0. 健康库：三条腿都说「没问题」
  runCase(healthyPath, 'healthy', null, (store, v) => {
    t('[case:healthy] 判据 ok=true / problems=[]', v.a.ok === true && v.a.problems.length === 0, JSON.stringify(v.a.problems));
    t('[case:healthy] 判据 aligned=true', v.a.aligned === true);
    t('[case:healthy] 检索照常命中', searchOk(store));
  });

  // C1. FTS 缺一行：唯一会闸住检索的坏法
  runCase(healthyPath, 'words-fts', (db) => { db.prepare('DELETE FROM echo_words_fts WHERE word_ord = 0').run(); }, (store, v) => {
    const p = problemOf(v.a.problems, 'words-fts');
    t('[case:words-fts] 判据报 words-fts（3 vs 2）', !!p && p.words === 3 && p.fts === 2, JSON.stringify(p));
    t('[case:words-fts] aligned=false / ok=false / searchable=false', v.a.aligned === false && v.s.ok === false && v.s.searchable === false);
    let err = null;
    try { store.echoSearch('解耦', { limit: 10 }); } catch (e) { err = e; }
    t('[case:words-fts] 检索仍被 ECHO_INDEX_STALE 闸住（对齐优先）', !!err && err.code === 'ECHO_INDEX_STALE', err && err.code);
  });

  // C2. 代次 vs 构建审计：aligned 不受影响，ok 变 false —— 这就是「两个词必须分开」的证据
  runCase(healthyPath, 'generation', (db) => { db.prepare('UPDATE echo_index_sources SET generation = generation + 1').run(); }, (store, v) => {
    const p = problemOf(v.a.problems, 'generation-vs-builds');
    t('[case:generation] 判据报 generation-vs-builds（gen=2 builds=1 max=1）',
      !!p && p.generation === 2 && p.builds === 1 && p.maxBuildGeneration === 1, JSON.stringify(p));
    t('[case:generation] 判据字段名是 maxBuildGeneration（新面）', !!p && !('maxBuild' in p), JSON.stringify(p));
    const ip = problemOf(v.im.problems, 'generation-vs-builds');
    t('[case:generation] 导入器字段名仍是 maxBuild（旧面），值相同', !!ip && ip.maxBuild === 1 && !('maxBuildGeneration' in ip), JSON.stringify(ip));
    t('[case:generation] aligned 仍为 true（代次不是对齐问题）', v.a.aligned === true && v.s.aligned === true);
    t('[case:generation] ok=false（审计列脏了）', v.a.ok === false && v.s.ok === false && v.im.ok === false);
    t('[case:generation] 检索不被闸（searchable=true 且能命中）', v.s.searchable === true && searchOk(store));
  });

  // C3. 游标 JSON 坏掉：只报 cursor-seq-json-mismatch（不对应任何 cursor-json-invalid），不闸检索
  // ★ 这是回退后的**已发布契约**：Store / MCP 从来只有这一个 kind，cursor=null 说明是「读不出来」。
  runCase(healthyPath, 'cursor-json', (db) => { db.prepare("UPDATE echo_index_sources SET cursor_json = 'not json at all'").run(); }, (store, v) => {
    t('[case:cursor-json] 判据只报 cursor-seq-json-mismatch（不再多报 cursor-json-invalid）',
      same(sortedKinds(v.a.problems), ['cursor-seq-json-mismatch']), JSON.stringify(kindsOf(v.a.problems)));
    const mp = problemOf(v.a.problems, 'cursor-seq-json-mismatch');
    t('[case:cursor-json] 判据里的 cursor 为 null、cursorSeq 为清单值', !!mp && mp.cursor === null && mp.cursorSeq === MANIFEST_CURSOR_SEQ, JSON.stringify(mp));
    const sp = problemOf(v.s.problems, 'cursor-seq-json-mismatch');
    t('[case:cursor-json] Store 同样只这一条：cursor=null、cursorSeq 保留',
      same(sortedKinds(v.s.problems), ['cursor-seq-json-mismatch']) && !!sp && sp.cursor === null && sp.cursorSeq === MANIFEST_CURSOR_SEQ,
      JSON.stringify(v.s.problems));
    const ip = problemOf(v.im.problems, 'cursor-seq-json-mismatch');
    t('[case:cursor-json] 导入器旧字段名 json=null（映射回规范名即 cursor=null）、cursorSeq 保留、kind 集合相同',
      same(v.im.problems.map(importerToCanonical).map((x) => x.kind), ['cursor-seq-json-mismatch'])
        && !!ip && ip.json === null && ip.cursorSeq === MANIFEST_CURSOR_SEQ,
      JSON.stringify(v.im.problems));
    t('[case:cursor-json] aligned 仍为 true / ok=false', v.a.aligned === true && v.a.ok === false);
    t('[case:cursor-json] 游标坏掉不闸检索（元数据脏了 ≠ 会少命中）', v.s.searchable === true && searchOk(store));
  });

  // C4. 游标 JSON 合法但 seq 对不上：只报 mismatch，不报 invalid
  runCase(healthyPath, 'cursor-seq', (db) => { db.prepare('UPDATE echo_index_sources SET cursor_json = ?').run(JSON.stringify({ seq: 999 })); }, (store, v) => {
    t('[case:cursor-seq] 只报 cursor-seq-json-mismatch（JSON 本身是合法的）', same(sortedKinds(v.a.problems), ['cursor-seq-json-mismatch']), JSON.stringify(kindsOf(v.a.problems)));
    const mp = problemOf(v.a.problems, 'cursor-seq-json-mismatch');
    t('[case:cursor-seq] 判据里 cursor.seq=999 / cursorSeq=清单值', !!mp && mp.cursor && mp.cursor.seq === 999 && mp.cursorSeq === MANIFEST_CURSOR_SEQ, JSON.stringify(mp));
    const ip = problemOf(v.im.problems, 'cursor-seq-json-mismatch');
    t('[case:cursor-seq] 导入器 json.seq=999', !!ip && ip.json && ip.json.seq === 999, JSON.stringify(ip));
    t('[case:cursor-seq] aligned 仍为 true / ok=false / 检索不闸', v.a.aligned === true && v.a.ok === false && v.s.searchable === true);
  });

  // C5. state 不是 committed：报 state，不闸检索
  runCase(healthyPath, 'state', (db) => { db.prepare("UPDATE echo_index_sources SET state = 'pending'").run(); }, (store, v) => {
    const p = problemOf(v.a.problems, 'state');
    t('[case:state] 判据报 state=pending', !!p && p.state === 'pending', JSON.stringify(p));
    t('[case:state] aligned 仍为 true / ok=false / 检索不闸', v.a.aligned === true && v.a.ok === false && v.s.searchable === true && searchOk(store));
  });

  // C6. 孤儿 FTS 行（来源行已不在）：不改变对齐，但 ok=false —— 对齐/健康两词的第二个证据
  runCase(healthyPath, 'orphan', (db) => {
    db.prepare("INSERT INTO echo_words_fts (search_text, raw_text, echo_source_id, word_ord, session, seq) VALUES ('ghost', 'ghost', 'echo-source-ghost', 0, 'session-ghost', 1)").run();
  }, (store, v) => {
    const p = problemOf(v.a.problems, 'orphan-words-fts');
    t('[case:orphan] 判据报 orphan-words-fts rows=1', !!p && p.rows === 1, JSON.stringify(p));
    t('[case:orphan] orphanFts 三处一致且 words=1', v.a.orphanFts.words === 1 && v.s.orphanFts.words === 1 && v.im.orphanFts.words === 1, JSON.stringify(v.a.orphanFts));
    t('[case:orphan] aligned 仍为 true（孤儿不在任何来源的计数里）', v.a.aligned === true);
    t('[case:orphan] ok=false', v.a.ok === false);
  });

  // ── C8–C13：来源行的声明计数 vs 实际（Task-16）────────────────────────────
  // ★ 判据从哪来：schema 三条声明列是 NOT NULL 的审计列（库层不强制等于实际），
  //   导入器在同一个事务里把它们写成「源文件行数」。健康库里恒等 —— 所以这些案子
  //   都是**人为改声明或删行**造出来的，不是导入能造出来的。
  // ★ 一条 kind（source-declared-counts）+ 三个成对字段。下面每一案只改**一列**，
  //   并把整条 problem 逐字段对一遍 —— 字段名也是对外的形状，改一个就红。
  // ★ 声明漂移**进 aligned、也进检索闸**（final amendment）：纯 typo 也 fail closed。

  const declaredOf = (list) => problemOf(list, 'source-declared-counts');
  const sidOf = (v) => v.s.sources[0].echoSourceId;
  // 健康语料的三个实际值：3 words / 1 summary / 摘要声明 2 个 srcSeq。
  const expectedDeclared = (sid, over) => Object.assign({
    echoSourceId: sid, kind: 'source-declared-counts',
    wordsCount: 3, words: 3, summariesCount: 1, summaries: 1, srcSeqCount: 2, declaredSeqRows: 2,
  }, over);

  // C8. words_count 3 → 4（多报方向）
  runCase(healthyPath, 'source-declared-words-up', (db) => {
    db.prepare('UPDATE echo_index_sources SET words_count = 4').run();
  }, (store, v) => {
    const p = declaredOf(v.a.problems);
    t('[case:declared-words-up] 一条 source-declared-counts，字段逐个对得上（4 vs 3）',
      same(p, expectedDeclared(sidOf(v), { wordsCount: 4 })), JSON.stringify(p));
    t('[case:declared-words-up] 只有这一条（不牵连其它 kind）', same(sortedKinds(v.a.problems), ['source-declared-counts']), JSON.stringify(kindsOf(v.a.problems)));
    t('[case:declared-words-up] aligned=false / ok=false（声明也进判据）', v.a.aligned === false && v.s.aligned === false && v.a.ok === false && v.s.ok === false);
    t('[case:declared-words-up] searchable=false；检索抛 ECHO_INDEX_STALE，不回部分结果', v.s.searchable === false && searchStale(store));
  });

  // C8b. words_count 3 → 1（反方向也要报：判据是「不相等」，不是「actual 少了」）
  runCase(healthyPath, 'source-declared-words-down', (db) => {
    db.prepare('UPDATE echo_index_sources SET words_count = 1').run();
  }, (store, v) => {
    const p = declaredOf(v.a.problems);
    t('[case:declared-words-down] 一条 source-declared-counts（1 vs 3）', same(p, expectedDeclared(sidOf(v), { wordsCount: 1 })), JSON.stringify(p));
    t('[case:declared-words-down] aligned=false / searchable=false / 检索抛 ECHO_INDEX_STALE', v.a.aligned === false && v.s.searchable === false && searchStale(store));
  });

  // C9. summaries_count 1 → 2（同一案里 words / srcSeq 那两对必须保持相等）
  runCase(healthyPath, 'source-declared-summaries-up', (db) => {
    db.prepare('UPDATE echo_index_sources SET summaries_count = 2').run();
  }, (store, v) => {
    const p = declaredOf(v.a.problems);
    t('[case:declared-summaries-up] 一条 source-declared-counts（2 vs 1），另两对仍相等',
      same(p, expectedDeclared(sidOf(v), { summariesCount: 2 })), JSON.stringify(p));
    t('[case:declared-summaries-up] aligned=false / searchable=false / 检索抛 ECHO_INDEX_STALE', v.a.aligned === false && v.s.searchable === false && searchStale(store));
  });

  // C10. src_seq_count 2 → 5：比的是「摘要声明之和」（declaredSeqRows），不是子表行数
  runCase(healthyPath, 'source-declared-srcseqs-up', (db) => {
    db.prepare('UPDATE echo_index_sources SET src_seq_count = 5').run();
  }, (store, v) => {
    const p = declaredOf(v.a.problems);
    t('[case:declared-srcseqs-up] 一条 source-declared-counts（srcSeqCount 5 vs declaredSeqRows 2）',
      same(p, expectedDeclared(sidOf(v), { srcSeqCount: 5 })), JSON.stringify(p));
    t('[case:declared-srcseqs-up] 不牵连 src-seq-count（摘要链与子表仍自洽）',
      problemOf(v.a.problems, 'src-seq-count') === null && same(sortedKinds(v.a.problems), ['source-declared-counts']), JSON.stringify(kindsOf(v.a.problems)));
    t('[case:declared-srcseqs-up] aligned=false / searchable=false / 检索抛 ECHO_INDEX_STALE', v.a.aligned === false && v.s.searchable === false && searchStale(store));
  });

  // C11. 决定性的那一案：行与它的 FTS 孪生行**同时**删掉 —— 计数之间全自洽，
  //      只有声明看得见（declared 3 vs actual 2）。这正是「检索静默少 1 条」的形状。
  //      ★ final amendment：aligned 必须 false、检索必须抛 ECHO_INDEX_STALE，
  //        不许回一份少 1 条的部分结果。
  runCase(healthyPath, 'source-declared-row-loss', (db) => {
    db.prepare('DELETE FROM echo_words WHERE word_ord = 0').run();
    db.prepare('DELETE FROM echo_words_fts WHERE word_ord = 0').run();
  }, (store, v) => {
    const p = declaredOf(v.a.problems);
    t('[case:declared-row-loss] 一条 source-declared-counts（3 vs 2）', same(p, expectedDeclared(sidOf(v), { words: 2 })), JSON.stringify(p));
    t('[case:declared-row-loss] 行与 FTS 同步少一行 ⇒ words-fts 不报（计数之间自洽）',
      problemOf(v.a.problems, 'words-fts') === null && v.a.problems.length === 1, JSON.stringify(v.a.problems));
    t('[case:declared-row-loss] aligned=false / searchable=false（声明参与对齐）', v.a.aligned === false && v.s.aligned === false && v.s.searchable === false);
    let r = null;
    let err = null;
    try { r = store.echoSearch('解耦', { limit: 10 }); } catch (e) { err = e; }
    t('[case:declared-row-loss] 检索抛 ECHO_INDEX_STALE，且不回部分结果',
      r === null && !!err && err.code === 'ECHO_INDEX_STALE',
      err ? 'threw ' + err.code : (r && r.results ? 'results=' + r.results.length : 'no result'));
  });

  // C12. 删一行 echo_summaries_fts（摘要那一半的索引本体）—— 之前没覆盖的坏法。
  runCase(healthyPath, 'summaries-fts', (db) => { db.prepare('DELETE FROM echo_summaries_fts').run(); }, (store, v) => {
    const p = problemOf(v.a.problems, 'summaries-fts');
    t('[case:summaries-fts] 判据报 summaries-fts（1 vs 0）', !!p && p.summaries === 1 && p.fts === 0, JSON.stringify(p));
    t('[case:summaries-fts] 只有这一条', same(sortedKinds(v.a.problems), ['summaries-fts']), JSON.stringify(kindsOf(v.a.problems)));
    t('[case:summaries-fts] aligned=false / ok=false / searchable=false', v.a.aligned === false && v.a.ok === false && v.s.searchable === false);
    let err = null;
    try { store.echoSearch('解耦', { limit: 10 }); } catch (e) { err = e; }
    t('[case:summaries-fts] 检索被 ECHO_INDEX_STALE 闸住（摘要那一半也不许静默少命中）', !!err && err.code === 'ECHO_INDEX_STALE', err && err.code);
  });

  // C13. 删一行 echo_summary_src_seqs，摘要自己声明的和**不动** ⇒ 对齐真坏了。
  //      ★ 这一案同时是「不许重复报」的实测：来源列（2）与摘要声明之和（2）仍然相符，
  //        所以只许有 src-seq-count 一条，不许再冒一条 source-declared-counts。
  runCase(healthyPath, 'src-seq-child-loss', (db) => { db.prepare('DELETE FROM echo_summary_src_seqs WHERE seq = 2').run(); }, (store, v) => {
    const p = problemOf(v.a.problems, 'src-seq-count');
    t('[case:src-seq-child-loss] 判据报 src-seq-count（声明 2 vs 子表 1）', !!p && p.declared === 2 && p.actual === 1, JSON.stringify(p));
    t('[case:src-seq-child-loss] 一次坏法只报一条：不额外冒 source-declared-counts',
      same(sortedKinds(v.a.problems), ['src-seq-count']), JSON.stringify(kindsOf(v.a.problems)));
    t('[case:src-seq-child-loss] aligned=false / ok=false / searchable=false', v.a.aligned === false && v.a.ok === false && v.s.searchable === false);
    let err = null;
    try { store.echoSearch('解耦', { limit: 10 }); } catch (e) { err = e; }
    t('[case:src-seq-child-loss] 检索被 ECHO_INDEX_STALE 闸住', !!err && err.code === 'ECHO_INDEX_STALE', err && err.code);
  });

  // C7. 缺表：三条腿都不许抛，口径是 available:false + missing 逐张列
  runCase(healthyPath, 'missing-tables', (db) => {
    for (const tbl of ['echo_summary_src_seqs', 'echo_words_fts', 'echo_summaries_fts', 'echo_words', 'echo_summaries', 'echo_source_builds', 'echo_index_sources']) {
      db.prepare('DROP TABLE ' + tbl).run();
    }
  }, (store, v) => {
    t('[case:missing] 判据 available=false 且不抛', v.a.available === false && v.a.ok === false);
    t('[case:missing] missing 逐张列出七张表', same(v.a.missing.slice().sort(), ECHO_INTEGRITY_TABLES.slice().sort()), JSON.stringify(v.a.missing));
    t('[case:missing] store.echoStats() 不抛：available=false + code=ECHO_INDEX_MISSING',
      v.s.available === false && v.s.code === 'ECHO_INDEX_MISSING' && same(v.s.missing.slice().sort(), ECHO_INTEGRITY_TABLES.slice().sort()), v.s.code);
    t('[case:missing] 导入器不抛：ok=false + available=false + missing', v.im.ok === false && v.im.available === false && v.im.missing.length === 7, JSON.stringify(v.im.missing));
    let err = null;
    try { store.echoSearch('解耦', { limit: 10 }); } catch (e) { err = e; }
    t('[case:missing] 检索报 ECHO_INDEX_MISSING（没建过 ≠ 索引是空的）', !!err && err.code === 'ECHO_INDEX_MISSING', err && err.code);
  }, { parity: false });
}

// ── C14. 零摘要来源：声明 0/0/0 与空结构一致 ⇒ 判健康（Task-16 的反面证据）────
// ★ 为什么单开一个库、单写一份语料：健康库那份带 1 条摘要（摘要声明 2 个 srcSeq）。
//   「把声明改成 0」造出来的 0 是**假**的（行还在，于是立刻是漂移）；要证明
//   「0 声明 == 空结构」不是漂移，只能真导一份**没有摘要**的清单。
// ★ 为什么 summaries.jsonl 不写成 0 字节：导入器拒空输入（SUMMARIES_EMPTY），
//   一行空白才是「合法但没有行」。
// ★ sourcePath 故意取一个健康库没用的唯一路径：将来若有人把两份语料并进一个库，
//   也不会撞 UNIQUE(source_path, source_version)。
function zeroSummaryCase() {
  const dir = path.join(ROOT, 'zero-summary');
  fs.mkdirSync(dir, { recursive: true });
  const words = [
    { t: '2026-11-05T00:00:00.000Z', session: 'session-zero-0001', ws: 'ws-zero', seq: 1, turn: 1, log: 'D:/synthetic/integrity/zero.jsonl', role: 'user', kind: 'message', text: '零摘要来源仍然要判健康' },
    { t: '2026-11-05T00:00:01.000Z', session: 'session-zero-0001', ws: 'ws-zero', seq: 2, turn: 2, log: 'D:/synthetic/integrity/zero.jsonl', role: 'assistant', kind: 'message', text: '声明值是零不等于漂移' },
  ];
  const wordsPath = path.join(dir, 'words.jsonl');
  const summariesPath = path.join(dir, 'summaries.jsonl');
  fs.writeFileSync(wordsPath, words.map((r) => JSON.stringify({ ...r, len: charLen(r.text), truncated: false })).join('\n') + '\n');
  fs.writeFileSync(summariesPath, '\n');
  const manifest = {
    echoIndexVersion: 'echo-index/1',
    sourcePath: 'D:/synthetic/echo/integrity/zero-summary',
    namespace: 'log',
    generation: 1,
    builtAt: '2026-11-10T00:00:00.000Z',
    cursor: { seq: 2, turn: 2, t: '2026-11-05T00:00:01.000Z' },
    words: { path: 'words.jsonl', sha256: sha256File(wordsPath), bytes: fs.statSync(wordsPath).size, rows: words.length },
    summaries: { path: 'summaries.jsonl', sha256: sha256File(summariesPath), bytes: fs.statSync(summariesPath).size, rows: 0 },
    counts: { words: words.length, summaries: 0, srcSeqs: 0, excludedReasoning: 0 },
  };
  const manifestPath = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  const dbPath = path.join(ROOT, 'zero-summary.sqlite');
  const boot = openMetaStore({ path: dbPath, mode: 'readwrite' });
  try { boot.migrate(); } finally { boot.close(); }

  const receipt = runImport(['--manifest', manifestPath, '--sha256', sha256File(manifestPath), '--generation', '1', '--db', dbPath]);
  t('[case:zero-summary] 零摘要清单能导入（code=IMPORTED），counts = 2/0/0',
    receipt.code === 'IMPORTED' && same(receipt.counts, { words: 2, summaries: 0, srcSeqs: 0, excludedReasoning: 0 }),
    JSON.stringify({ code: receipt.code, counts: receipt.counts }));

  const store = openMetaStore({ path: dbPath, mode: 'readwrite' });
  try {
    const decl = store.db.prepare('SELECT words_count AS w, summaries_count AS s, src_seq_count AS q FROM echo_index_sources').get();
    t('[case:zero-summary] 来源行声明就是 2/0/0（不是「改出来」的零）',
      !!decl && Number(decl.w) === 2 && Number(decl.s) === 0 && Number(decl.q) === 0, JSON.stringify(decl));
    const a = analyzeEchoIntegrity(store.db);
    const s = store.echoStats();
    t('[case:zero-summary] 判据 problems=[]（声明零与空结构一致，不是漂移）',
      a.available === true && a.problems.length === 0, JSON.stringify(a.problems));
    t('[case:zero-summary] aligned=true / ok=true / searchable=true', a.aligned === true && a.ok === true && s.searchable === true);
    t('[case:zero-summary] 没有摘要的库照样能检索到词行（1 条）',
      store.echoSearch('零摘要', { limit: 10 }).results.length === 1);
  } finally {
    try { if (store && !store.closed) store.close(); } catch (e) { t('[cleanup:zero-summary] 关闭失败', false, e && e.message); }
  }
}

// ── 静态断言：依赖方向 + 九种 kind ────────────────────────────────────────
function staticChecks() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const srcPath = path.join(here, '..', 'src', 'db', 'echo-integrity.mjs');
  let text = '';
  try { text = fs.readFileSync(srcPath, 'utf8'); } catch (e) { t('[static] 读得到 src/db/echo-integrity.mjs', false, e && e.message); return; }
  t('[static] 判据模块存在且非空', text.length > 1000, srcPath);
  t('[static] 判据模块**零** import tools/（依赖方向铁律）',
    !/from\s+['"][^'"]*tools\//.test(text), (text.match(/from\s+['"][^'"]*tools\/[^'"]*['"]/g) || []).join(', '));
  t('[static] 九种 problem kind 一个不少（老八种 + Task-16 的 source-declared-counts）', ECHO_INTEGRITY_PROBLEM_KINDS.length === 9
    && ['words-fts', 'summaries-fts', 'src-seq-count', 'generation-vs-builds', 'state',
      'cursor-seq-json-mismatch', 'orphan-words-fts', 'orphan-summaries-fts',
      'source-declared-counts'].every((k) => ECHO_INTEGRITY_PROBLEM_KINDS.indexOf(k) !== -1),
    ECHO_INTEGRITY_PROBLEM_KINDS.join(' | '));
  t('[static] 三条 source-* 变体不在名单里（声明漂移只有**一个**名字）',
    ['source-words-count', 'source-summaries-count', 'source-src-seq-count'].every((k) => ECHO_INTEGRITY_PROBLEM_KINDS.indexOf(k) === -1),
    ECHO_INTEGRITY_PROBLEM_KINDS.join(' | '));
  t('[static] kind 名单没有重复（重复 = 同一个坏法会报两次）',
    new Set(ECHO_INTEGRITY_PROBLEM_KINDS).size === ECHO_INTEGRITY_PROBLEM_KINDS.length, ECHO_INTEGRITY_PROBLEM_KINDS.length + ' 条');
  // ★ 声明进对齐是一条**判据性质**，不是注释里的承诺：三条声明与实际相等才算 aligned。
  const alignedBase = { words: 3, wordsFts: 3, summaries: 1, summariesFts: 1, declaredSeqRows: 2, seqRows: 2 };
  t('[static] isEchoSourceAligned 兼容旧六字段调用；声明字段传入时必须相等',
    isEchoSourceAligned(Object.assign({}, alignedBase)) === true
    && isEchoSourceAligned(Object.assign({}, alignedBase, { declaredWords: 3, declaredSummaries: 1, declaredSrcSeqs: 2 })) === true
    && isEchoSourceAligned(Object.assign({}, alignedBase, { declaredWords: 99, declaredSummaries: 1, declaredSrcSeqs: 2 })) === false
    && isEchoSourceAligned(Object.assign({}, alignedBase, { declaredWords: 3, declaredSummaries: 99, declaredSrcSeqs: 2 })) === false
    && isEchoSourceAligned(Object.assign({}, alignedBase, { declaredWords: 3, declaredSummaries: 1, declaredSrcSeqs: 99 })) === false,
    '声明字段省略时保持结构校验，传入时逐项严格比较');
  t('[static] cursor-json-invalid 既不在 kind 名单、也不再被 push（回退掉的行为扩张）',
    ECHO_INTEGRITY_PROBLEM_KINDS.indexOf('cursor-json-invalid') === -1 && !/kind:\s*'cursor-json-invalid'/.test(text),
    ECHO_INTEGRITY_PROBLEM_KINDS.join(' | '));
}

// ── 收尾：连 finally 都不信任，单独再断一次「临时目录真的没了」──────────────
let fatal = null;
try { main(); } catch (err) { fatal = err; }
if (fatal) t('自检本身没抛异常', false, fatal && fatal.stack ? fatal.stack.split('\n').slice(0, 6).join(' | ') : String(fatal));

const dbPath = path.join(ROOT, 'meta.sqlite');
const existed = fs.existsSync(dbPath);
let removed = false;
try { fs.rmSync(ROOT, { recursive: true, force: true }); removed = true; } catch { removed = false; }
t('[cleanup] 临时库先存在、删后整个目录不存在', existed === true && removed === true && fs.existsSync(ROOT) === false && fs.existsSync(dbPath) === false,
  'existed=' + existed + ' rm=' + removed + ' gone=' + (fs.existsSync(ROOT) === false));

console.log('');
console.log('=== ECHO 完整性自检（临时目录：' + ROOT + '）===');
console.log('');
console.log(ok.join('\n'));
if (bad.length) { console.log(''); console.log(bad.join('\n')); }
console.log('');
console.log(ok.length + ' 通过 / ' + bad.length + ' 失败');

// 给 CI 一个可用的退出码：有失败就非零。
process.exitCode = bad.length === 0 ? 0 : 1;
