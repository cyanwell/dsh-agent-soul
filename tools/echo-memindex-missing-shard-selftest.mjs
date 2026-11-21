#!/usr/bin/env node
// TEMP-only synthetic selftest —— memindex.mjs 的「续读点 vs 缺失分片」缺陷回归。
//
// 复现的缺陷（读源码确认的行为，不是猜的）：
//   build 的帧级增量路径只要求「上次 nextByte > 0 且文件变长」，就把 fromByte 设成 nextByte，
//   **不看这次要写的 sumF / wordF 是否存在**。于是：
//     上次 nextByte 落在文件中间（日志仍在 append）+ 这次两个分片名都不在了
//   ⇒ 仍从 nextByte 开始解压，新写出的分片里**只有后缀那几条**，
//     前缀（此前的原话/摘要）永久丢失，而 files.jsonl 却记着「已索引」—— 静默丢数据。
//
// 只做三件事：
//   ① 在 os.tmpdir() 下造合成日志（zstd 帧，内容全是 SYNTH- 前缀的假记录）；
//   ② 把 memindex.mjs **复制**到临时目录，用 --root / --index 指到临时目录跑 build；
//   ③ 断言：两个目标缺失 ⇒ 全量重建；只缺一个 ⇒ 两份都全量重建；旧共享指针 ⇒ 两个都强制重建。
//
// 绝不读：D:/AI/memory/hub/index、D:/AI/dsh/home/sessions、任何真实会话内容。
// 绝不写：os.tmpdir() 下的临时目录以外的地方。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);

// ── 一个真的 node ───────────────────────────────────────────────────────────
// 本会话里 process.execPath 是 Electron 宿主（DeepSeek Harness.exe）：拿它当 node 跑
// **会静默什么都不做**（退出码 0、零输出）。所以必须显式解析真 node。
const NODE_CANDIDATES = [
  process.env.ECHO_SELFTEST_NODE,
  'C:/Users/pc/.workbuddy/binaries/node/versions/22.22.2-3/node.exe',
  'C:/Program Files/nodejs/node.exe',
  '/usr/local/bin/node',
  '/usr/bin/node'
].filter(Boolean);

function looksLikeNode(bin) {
  try {
    const r = spawnSync(bin, ['-e', 'process.stdout.write(process.version)'], { encoding: 'utf8', timeout: 20000 });
    if (r.status !== 0) return false;
    const v = String(r.stdout || '').trim();
    return v.length > 2 && v.charAt(0) === 'v' && v.indexOf('.') > 1;
  } catch { return false; }
}

function resolveNode() {
  for (const bin of NODE_CANDIDATES) {
    try { if (fs.existsSync(bin) && looksLikeNode(bin)) return bin; } catch { /* 下一个 */ }
  }
  const where = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['node'], { encoding: 'utf8' });
  const lines = String(where.stdout || '').split(NL);
  for (const line of lines) {
    const bin = line.split(CR).join('').trim();
    if (bin && looksLikeNode(bin)) return bin;
  }
  return null;
}

// 默认测的是现役文件；ECHO_MEMINDEX_SUBJECT 只用于「同一条测试在修补前/后各跑一遍」的红绿取证。
const SRC = process.env.ECHO_MEMINDEX_SUBJECT || 'D:/AI/memory/hub/memindex.mjs';
const NODE = resolveNode();
const TMP = path.resolve(os.tmpdir());
const ROOT = fs.mkdtempSync(path.join(TMP, 'echo-memindex-missing-shard-'));
const sha = (b) => createHash('sha256').update(b).digest('hex');
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log('PASS ' + name); }
  catch (e) { failed += 1; console.error('FAIL ' + name + ': ' + (e && e.stack || e)); }
}
const note = (s) => console.log('     ' + s);

// ── 合成语料 ────────────────────────────────────────────────────────────────
const WS = '--synthetic-workspace--';
const BASE_T = Date.UTC(2026, 10, 15, 9, 0, 0);

const userRec = (seq) => ({
  seq, time: BASE_T + seq * 1000, type: 'user/message',
  data: { content: [{ type: 'text', text: 'SYNTH-USR-' + seq }] }
});
const astRec = (seq) => ({
  seq, time: BASE_T + seq * 1000 + 500, type: 'assistant/message',
  data: { message: { content: [{ type: 'text', text: 'SYNTH-AST-' + seq }] } }
});
const sumRec = (seq, id, shadowed) => ({
  seq, time: BASE_T + seq * 1000 + 700, type: 'compaction/summary',
  data: { compactionId: id, shadowedSeqs: shadowed, shadowedTokenCount: 11,
    summary: [{ type: 'text', text: 'SYNTH-SUM-' + id }] }
});

const frame = (recs) => zlib.zstdCompressSync(Buffer.from(recs.map((r) => JSON.stringify(r)).join(NL) + NL));

function corpus(caseName, sid) {
  const sessions = path.join(ROOT, caseName, 'sessions');
  const index = path.join(ROOT, caseName, 'index');
  const dir = path.join(sessions, WS, sid);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(index, { recursive: true });
  const log = path.join(dir, 'session.v4.jsonl.zstd');
  return { sessions, index, log, shardDir: path.join(index, 'shards') };
}

const appendFrames = (log, recs) => fs.appendFileSync(log, frame(recs));
const writeJsonl = (file, rows) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join(NL) + NL, 'utf8');
};
const readJsonl = (file) => {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split(NL)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
  }
  return out;
};
const isShardName = (n) => n.endsWith('.sum.jsonl') || n.endsWith('.word.jsonl');

let CODE_SHA = '';
function prepareCopy() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const bytes = fs.readFileSync(SRC);
    const copy = path.join(ROOT, 'memindex-under-test.mjs');
    fs.writeFileSync(copy, bytes);
    const probe = spawnSync(NODE, ['--check', copy], { encoding: 'utf8' });
    if (probe.status === 0 && sha(fs.readFileSync(copy)) === sha(bytes)) { CODE_SHA = sha(bytes); return copy; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
  }
  throw new Error('copied memindex.mjs never passed node --check');
}

function build(copy, c) {
  const r = spawnSync(NODE, [copy, 'build', '--root', c.sessions, '--index', c.index], { encoding: 'utf8', timeout: 120000 });
  return { status: r.status, out: String(r.stdout || '') + String(r.stderr || '') };
}

try {
  if (!NODE) throw new Error('no real node binary found (process.execPath is ' + process.execPath + ')');
  const copy = prepareCopy();
  const mod = await import(pathToFileURL(copy).href);
  console.log('code under test: ' + SRC);
  note('code sha256=' + CODE_SHA);
  note('node=' + NODE);
  note('temp root=' + ROOT);

  // ═══ 守卫：一切都在 os.tmpdir() 里，且跑的是复制品 ═══════════════════════
  check('guard: temp root, subject copy all live under os.tmpdir; NODE is a real node', () => {
    assert.equal(path.resolve(ROOT).indexOf(TMP), 0, 'ROOT 必须在 tmpdir');
    assert.equal(path.resolve(copy).indexOf(TMP), 0, 'copy 必须在 tmpdir');
    assert.equal(typeof NODE, 'string');
    assert.equal(NODE.toLowerCase().indexOf('deepseek harness'), -1, 'NODE 不许是 Electron 宿主');
  });

  // ═══ CASE A：两个目标都缺 + nextByte 落在文件中间 ⇒ 必须全量重建 ═════════
  const A = corpus('caseA', 'session-a1');
  appendFrames(A.log, [userRec(0)]);
  appendFrames(A.log, [astRec(1)]);
  appendFrames(A.log, [sumRec(2, 'aaaa1111', [0])]);
  const a0 = build(copy, A);
  check('CASE A1 baseline build indexes 2 words + 1 summary', () => {
    assert.equal(a0.status, 0, 'build 必须退出 0；输出：' + NL + a0.out);
    assert.equal(readJsonl(path.join(A.index, 'words.jsonl')).length, 2);
    assert.equal(readJsonl(path.join(A.index, 'summaries.jsonl')).length, 1);
  });

  appendFrames(A.log, [userRec(3)]);
  appendFrames(A.log, [astRec(4)]);
  const aPrev = readJsonl(path.join(A.index, 'files.jsonl'))[0];
  const aSize = fs.statSync(A.log).size;
  check('CASE A2 fixture: prior row has mid-file nextByte, both shard targets then removed', () => {
    assert.ok(aPrev, 'prior files.jsonl 行必须在');
    assert.ok(aPrev.nextByte > 0, 'nextByte 必须 > 0，拿到 ' + aPrev.nextByte);
    assert.equal(aPrev.nextByte < aSize, true, 'nextByte 必须落在文件中间（' + aPrev.nextByte + ' < ' + aSize + '）');
    const before = fs.readdirSync(A.shardDir).filter(isShardName).sort();
    assert.equal(before.length, 2, '前置条件：应有 2 个分片，实际 ' + JSON.stringify(before));
    assert.equal(fs.existsSync(aPrev.sumOut), true);
    assert.equal(fs.existsSync(aPrev.wordOut), true);
    fs.rmSync(aPrev.sumOut, { force: true });
    fs.rmSync(aPrev.wordOut, { force: true });
    assert.equal(fs.existsSync(aPrev.sumOut), false, 'sum 目标必须真的不见了');
    assert.equal(fs.existsSync(aPrev.wordOut), false, 'word 目标必须真的不见了');
    note('shard targets removed: ' + before.join(', '));
  });

  const a1 = build(copy, A);
  check('CASE A3 both targets missing -> full words count (4) rebuilt from full source', () => {
    assert.equal(a1.status, 0, 'build 必须退出 0；输出：' + NL + a1.out);
    const words = readJsonl(path.join(A.index, 'words.jsonl'));
    const texts = words.map((w) => w.text).sort();
    assert.equal(words.length, 4, '必须是 4 条（全量），拿到 ' + words.length + ' 条：' + JSON.stringify(texts));
    assert.deepEqual(texts, ['SYNTH-AST-1', 'SYNTH-AST-4', 'SYNTH-USR-0', 'SYNTH-USR-3'], '前缀不许丢');
    const row = readJsonl(path.join(A.index, 'files.jsonl'))[0];
    assert.equal(row.nWord, 4, 'manifest nWord 必须是全量 4，拿到 ' + row.nWord);
    const wordLines = fs.readFileSync(row.wordOut, 'utf8').split(NL).filter((l) => l.trim());
    assert.equal(wordLines.length, 4, 'word 分片必须整份重写为 4 行（不是只写后缀），拿到 ' + wordLines.length);
    assert.equal(readJsonl(path.join(A.index, 'summaries.jsonl')).length, 1, '摘要必须仍是 1 条');
  });

  // ═══ CASE B：只缺一个目标（另一个还在且归属校验能过）⇒ 两份都全量重建 ═══
  const B = A;
  appendFrames(B.log, [sumRec(5, 'bbbb2222', [3])]);
  appendFrames(B.log, [userRec(6)]);
  const bPrev = readJsonl(path.join(B.index, 'files.jsonl'))[0];
  const bSize = fs.statSync(B.log).size;
  check('CASE B1 fixture: only the sum target removed; word target holds sentinel that PASSES ownership', () => {
    assert.ok(bPrev && bPrev.nextByte > 0 && bPrev.nextByte < bSize, 'nextByte 必须落在文件中间');
    fs.rmSync(bPrev.sumOut, { force: true });
    assert.equal(fs.existsSync(bPrev.sumOut), false);
    assert.equal(fs.existsSync(bPrev.wordOut), true, 'word 分片必须还在（这才是只缺一个）');
    writeJsonl(bPrev.wordOut, [{ log: B.log, text: 'STALE-SENTINEL' }]);
    const owner = readJsonl(bPrev.wordOut)[0];
    assert.equal(owner.log, B.log, '哨兵首行必须是本日志（让归属校验通过，考验的是存在性而不是归属）');
  });

  const b1 = build(copy, B);
  check('CASE B2 one target missing -> BOTH artifacts rebuilt from full source', () => {
    assert.equal(b1.status, 0, 'build 必须退出 0；输出：' + NL + b1.out);
    const words = readJsonl(path.join(B.index, 'words.jsonl'));
    const sums = readJsonl(path.join(B.index, 'summaries.jsonl'));
    assert.equal(words.length, 5, '原话必须 5 条（全量），拿到 ' + words.length);
    assert.equal(sums.length, 2, '摘要必须 2 条（全量），拿到 ' + sums.length);
    assert.deepEqual(words.map((w) => w.text).sort(),
      ['SYNTH-AST-1', 'SYNTH-AST-4', 'SYNTH-USR-0', 'SYNTH-USR-3', 'SYNTH-USR-6']);
    const row = readJsonl(path.join(B.index, 'files.jsonl'))[0];
    const wordLines = fs.readFileSync(row.wordOut, 'utf8').split(NL).filter((l) => l.trim());
    assert.equal(wordLines.length, 5, 'word 分片必须 5 行（全量），拿到 ' + wordLines.length);
    assert.equal(wordLines.join(NL).indexOf('STALE-SENTINEL'), -1, '旧行残留说明走的是追加（只写后缀）');
    const sumLines = fs.readFileSync(row.sumOut, 'utf8').split(NL).filter((l) => l.trim());
    assert.equal(sumLines.length, 2, 'sum 分片必须 2 行（全量），拿到 ' + sumLines.length);
    assert.equal(row.nWord, 5);
    assert.equal(row.nSum, 2);
  });

  // ═══ CASE C：旧共享指针（两个日志声明同一分片路径）⇒ 两个都强制全量重建 ══
  const C = corpus('caseC', 'session-c9');
  const cV3 = path.join(path.dirname(C.log), 'session.v3.jsonl.zstd');
  appendFrames(C.log, [userRec(0)]);
  appendFrames(C.log, [astRec(1)]);
  appendFrames(cV3, [userRec(7)]);
  appendFrames(cV3, [userRec(8)]);
  const sharedSum = path.join(C.shardDir, 'session-c9.sum.jsonl');
  const sharedWord = path.join(C.shardDir, 'session-c9.word.jsonl');
  check('CASE C1 fixture: two rows declare the SAME old shard path holding sentinel content', () => {
    fs.mkdirSync(C.shardDir, { recursive: true });
    writeJsonl(sharedSum, [{ log: C.log, summary: 'STALE-SENTINEL-SUM' }]);
    writeJsonl(sharedWord, [{ log: C.log, text: 'STALE-SENTINEL-WORD' }]);
    const st4 = fs.statSync(C.log);
    const st3 = fs.statSync(cV3);
    writeJsonl(path.join(C.index, 'files.jsonl'), [
      { file: C.log, key: st4.mtimeMs + ':' + st4.size, nextByte: 1, ws: WS, sid: 'session-c9', nSum: 1, nWord: 1, sumOut: sharedSum, wordOut: sharedWord },
      { file: cV3, key: st3.mtimeMs + ':' + st3.size, nextByte: 1, ws: WS, sid: 'session-c9', nSum: 1, nWord: 1, sumOut: sharedSum, wordOut: sharedWord }
    ]);
  });

  const c1 = build(copy, C);
  check('CASE C2 shared old pointer -> warning + both colliding rows rebuilt to unique names', () => {
    assert.equal(c1.status, 0, 'build 必须退出 0；输出：' + NL + c1.out);
    assert.notEqual(c1.out.indexOf('ECHO_SHARD_PATH_SHARED_IN_MANIFEST'), -1, '必须打出结构化告警');
    const words = readJsonl(path.join(C.index, 'words.jsonl'));
    assert.deepEqual(words.map((w) => w.text).sort(),
      ['SYNTH-AST-1', 'SYNTH-USR-0', 'SYNTH-USR-7', 'SYNTH-USR-8'], '两个变体的原话都要在（谁都不继承共享分片）');
    const blob = fs.readFileSync(path.join(C.index, 'words.jsonl'), 'utf8')
      + fs.readFileSync(path.join(C.index, 'summaries.jsonl'), 'utf8');
    assert.equal(blob.indexOf('STALE-SENTINEL'), -1, '共享旧分片的内容不许进入索引');
    const rows = readJsonl(path.join(C.index, 'files.jsonl'));
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.notEqual(path.resolve(r.sumOut), path.resolve(sharedSum), '不许再声明共享 sum 路径');
      assert.notEqual(path.resolve(r.wordOut), path.resolve(sharedWord), '不许再声明共享 word 路径');
    }
    assert.notEqual(path.resolve(rows[0].sumOut), path.resolve(rows[1].sumOut), '两个变体必须各写各的');
    assert.notEqual(path.resolve(rows[0].wordOut), path.resolve(rows[1].wordOut), '两个变体必须各写各的');
  });

  // ═══ CASE D：两个目标都在 ⇒ 必须仍然走增量（证明补丁没有把快路径打死）══════
  const D = corpus('caseD', 'session-d7');
  appendFrames(D.log, [userRec(0)]);
  appendFrames(D.log, [astRec(1)]);
  appendFrames(D.log, [userRec(2)]);
  const d0 = build(copy, D);
  const dRow0 = readJsonl(path.join(D.index, 'files.jsonl'))[0];
  const sumBytesBefore = fs.readFileSync(dRow0.sumOut);
  const wordBytesBefore = fs.readFileSync(dRow0.wordOut);
  check('CASE D1 baseline build for the incremental fast path', () => {
    assert.equal(d0.status, 0, 'build 必须退出 0；输出：' + NL + d0.out);
    assert.equal(readJsonl(path.join(D.index, 'words.jsonl')).length, 3);
    assert.equal(fs.existsSync(dRow0.sumOut), true);
    assert.equal(fs.existsSync(dRow0.wordOut), true);
  });

  appendFrames(D.log, [userRec(3)]);
  const dRowPrev = readJsonl(path.join(D.index, 'files.jsonl'))[0];
  const d1 = build(copy, D);
  check('CASE D2 both targets present -> incremental resume preserved (suffix appended, prefix intact)', () => {
    assert.equal(d1.status, 0, 'build 必须退出 0；输出：' + NL + d1.out);
    const words = readJsonl(path.join(D.index, 'words.jsonl'));
    assert.equal(words.length, 4, '原话必须 4 条，拿到 ' + words.length);
    assert.deepEqual(words.map((w) => w.text).sort(),
      ['SYNTH-AST-1', 'SYNTH-USR-0', 'SYNTH-USR-2', 'SYNTH-USR-3']);
    const dRowNext = readJsonl(path.join(D.index, 'files.jsonl'))[0];
    assert.ok(dRowNext.nextByte > dRowPrev.nextByte, 'nextByte 必须往前走（' + dRowPrev.nextByte + ' -> ' + dRowNext.nextByte + '）');
    const sumBytesAfter = fs.readFileSync(dRowNext.sumOut);
    const wordBytesAfter = fs.readFileSync(dRowNext.wordOut);
    assert.equal(wordBytesAfter.length > wordBytesBefore.length, true, 'word 分片必须变长（增量追加）');
    assert.equal(wordBytesAfter.subarray(0, wordBytesBefore.length).equals(wordBytesBefore), true,
      'word 分片的前缀必须逐字节不变 —— 变了就说明不是追加而是整份重写');
    assert.equal(sumBytesAfter.subarray(0, sumBytesBefore.length).equals(sumBytesBefore), true,
      'sum 分片的前缀必须逐字节不变');
  });

  // ═══ CASE E：直接测导出的两个纯函数（证明「快路径不能复用共享旧分片」是判断层的硬约束）═══
  check('CASE E1 computeShardPlan: two rows sharing one old shard path are BOTH forcedRebuild', () => {
    const shardDir = path.join(ROOT, 'caseE', 'index', 'shards');
    const logs = [
      { file: 'D:/synthetic/x/session.v4.jsonl.zstd', ws: WS, sid: 'session-e5' },
      { file: 'D:/synthetic/x/session.v3.jsonl.zstd', ws: WS, sid: 'session-e5' }
    ];
    const shared = path.join(shardDir, 'session-e5.sum.jsonl');
    const sharedW = path.join(shardDir, 'session-e5.word.jsonl');
    const prevRows = [
      { file: logs[0].file, sumOut: shared, wordOut: sharedW, nextByte: 5, key: 'a' },
      { file: logs[1].file, sumOut: shared, wordOut: sharedW, nextByte: 5, key: 'b' }
    ];
    const plan = mod.computeShardPlan(logs, prevRows, shardDir);
    const warn = plan.warnings.find((w) => w.code === 'ECHO_SHARD_PATH_SHARED_IN_MANIFEST');
    assert.ok(warn, '必须有 ECHO_SHARD_PATH_SHARED_IN_MANIFEST 告警，拿到 ' + JSON.stringify(plan.warnings));
    assert.equal(warn.action, 'force-full-rebuild-both-variants');
    assert.equal(plan.byFile.get(logs[0].file).forcedRebuild, true, 'v4 必须强制重建');
    assert.equal(plan.byFile.get(logs[1].file).forcedRebuild, true, 'v3 必须强制重建');
    assert.notEqual(plan.byFile.get(logs[0].file).sumF, plan.byFile.get(logs[1].file).sumF, '两个变体必须算出不同的唯一名');
  });

  check('CASE E2 decideFileReuse: forcedRebuild disarms reuse AND canResume even when names match and targets exist', () => {
    const dir = path.join(ROOT, 'caseE2');
    fs.mkdirSync(dir, { recursive: true });
    const sumF = path.join(dir, 'z.sum.jsonl');
    const wordF = path.join(dir, 'z.word.jsonl');
    fs.writeFileSync(sumF, '', 'utf8');
    fs.writeFileSync(wordF, '', 'utf8');
    const prevRow = { key: 'k', nextByte: 1, sumOut: sumF, wordOut: wordF };
    const live = mod.decideFileReuse({ prevRow, key: 'k', force: false, size: 99,
      shard: { sumF, wordF, forcedRebuild: false } });
    assert.equal(live.targetsPresent, true);
    assert.equal(live.reuse, true, '目标都在时该复用');
    assert.equal(live.canResume, true, '目标都在时该能续读');
    const forced = mod.decideFileReuse({ prevRow, key: 'k', force: false, size: 99,
      shard: { sumF, wordF, forcedRebuild: true } });
    assert.equal(forced.reuse, false, '强制重建的分片绝不许复用');
    assert.equal(forced.canResume, false, '强制重建时绝不许续读（fromByte 必须回到 0）');
    const missing = mod.decideFileReuse({ prevRow, key: 'k', force: false, size: 99,
      shard: { sumF: path.join(dir, 'nope.sum.jsonl'), wordF, forcedRebuild: false } });
    assert.equal(missing.targetsPresent, false);
    assert.equal(missing.reuse, false);
    assert.equal(missing.canResume, false, '缺一个目标就不许续读');
  });

  // ═══ CASE F：什么都没变 ⇒ 必须仍是 no-op 早退（补丁没把快路径的「全部未变」判死）═══
  const fWordsBefore = fs.readFileSync(path.join(B.index, 'words.jsonl'));
  const f1 = build(copy, B);
  check('CASE F unchanged corpus -> no-op early exit, nothing rewritten or lost', () => {
    assert.equal(f1.status, 0, 'build 必须退出 0；输出：' + NL + f1.out);
    const meta = JSON.parse(fs.readFileSync(path.join(B.index, 'meta.json'), 'utf8'));
    assert.equal(String(meta.note || '').indexOf('no-op'), 0, '必须仍走 no-op 早退，meta.note=' + meta.note);
    assert.equal(meta.skippedUnchanged, 1, '唯一那个日志必须被判为「未变且分片可用」，拿到 ' + meta.skippedUnchanged);
    const fWordsAfter = fs.readFileSync(path.join(B.index, 'words.jsonl'));
    assert.equal(fWordsAfter.equals(fWordsBefore), true, 'no-op 分支不许重写 words.jsonl');
    assert.equal(readJsonl(path.join(B.index, 'words.jsonl')).length, 5, 'no-op 之后原话仍是 5 条');
  });

  // ═══ CASE G：日志一个字没变、但分片没了 ⇒ 也不许「跳过」（快路径的 reuse 半边）═══
  const gRow = readJsonl(path.join(B.index, 'files.jsonl'))[0];
  const gKeyBefore = gRow.key;
  fs.rmSync(gRow.sumOut, { force: true });
  fs.rmSync(gRow.wordOut, { force: true });
  const g1 = build(copy, B);
  check('CASE G unchanged log but both shards gone -> reuse refused, full rebuild (no silent skip)', () => {
    assert.equal(g1.status, 0, 'build 必须退出 0；输出：' + NL + g1.out);
    const gRowAfter = readJsonl(path.join(B.index, 'files.jsonl'))[0];
    assert.equal(gRowAfter.key, gKeyBefore, '日志本身确实没变（key 相同）—— 这就是本 case 的前提');
    assert.equal(fs.existsSync(gRowAfter.sumOut), true, '分片必须被重新写出来');
    assert.equal(fs.existsSync(gRowAfter.wordOut), true, '分片必须被重新写出来');
    const words = readJsonl(path.join(B.index, 'words.jsonl'));
    assert.equal(words.length, 5, '原话必须仍是全量 5 条，拿到 ' + words.length);
    assert.equal(readJsonl(path.join(B.index, 'summaries.jsonl')).length, 2, '摘要必须仍是全量 2 条');
    const meta = JSON.parse(fs.readFileSync(path.join(B.index, 'meta.json'), 'utf8'));
    assert.equal(String(meta.note || '').indexOf('no-op'), -1, '分片缺了就不许走 no-op 早退');
    note('G: rebuilt ' + path.basename(gRowAfter.wordOut));
  });

  check('guard: temp index output never references the live corpus root', () => {
    for (const caseName of ['caseA', 'caseC']) {
      const dir = path.join(ROOT, caseName, 'index');
      for (const n of fs.readdirSync(dir)) {
        if (!n.endsWith('.jsonl')) continue;
        const t = fs.readFileSync(path.join(dir, n), 'utf8');
        assert.equal(t.indexOf('D:/AI/dsh/home/sessions'), -1, '不许出现真实语料根');
      }
    }
  });
} catch (e) {
  failed += 1;
  console.error('FAIL fatal: ' + (e && e.stack || e));
} finally {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); }
  catch (e) { failed += 1; console.error('FAIL cleanup: ' + e.message); }
  if (fs.existsSync(ROOT)) { failed += 1; console.error('FAIL cleanup: TEMP root still exists ' + ROOT); }
}
console.log('RESULT ' + passed + ' passed / ' + failed + ' failed  (code sha256=' + CODE_SHA + ')');
if (failed) process.exitCode = 1;
