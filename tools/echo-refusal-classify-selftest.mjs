#!/usr/bin/env node
// tools/echo-refusal-classify-selftest.mjs —— 拒绝分类器的合成自检（不读生产索引、不碰任何库）
//
// 跑法：node tools/echo-refusal-classify-selftest.mjs
// 只读 D:/AI/agent-soul/tools/echo-source-build.mjs 的**源码文本**做静态核对，
// 不执行 builder、不读 D:/AI/memory/hub/index、不写任何文件。
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  REFUSAL_RULES, COLLECTED_REFUSAL_CODES, COLLECTED_REFUSAL_PREFIX,
  UNCLASSIFIED_CODE, UNRECOGNIZED_CATEGORY,
  classifyRefusal, recordRefusal, refusalKey, refusalReportFields,
} from './echo-refusal-classify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILDER = path.join(HERE, 'echo-source-build.mjs');
let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log('✓ ' + name); }
  catch (e) { failed += 1; console.error('✗ ' + name + ': ' + (e && e.message || e)); }
}

const builderSource = fs.readFileSync(BUILDER, 'utf8');

// builder 里 fail() 的**字面量**首参（双/单/反引号都能取），用作覆盖率的样本集。
function builderFailLiterals(src) {
  const out = new Set();
  const re = /fail\((\s*)(['"\`])((?:\\.|(?!\2)[^\\])*)\2/g;
  let m;
  while ((m = re.exec(src)) !== null) out.add(m[3]);
  return [...out];
}

// 由 readEchoIndexJsonl(label + ' line ' + n) **拼出来**的消息头，
// 源码里不存在完整字面量 —— 显式列为派生前缀，并单独核对它的 label 首词存在。
const DERIVED_PREFIXES = new Set(['summaries.jsonl line ', 'files.jsonl line ']);

check('每条规则的前缀都在 builder 源码里逐字存在（派生前缀单独核对 label）', () => {
  const missing = [];
  for (const rule of REFUSAL_RULES) {
    if (DERIVED_PREFIXES.has(rule.prefix)) {
      const label = rule.prefix.split(' ')[0];
      if (builderSource.indexOf(label) < 0) missing.push(rule.prefix + ' (label ' + label + ' absent)');
      continue;
    }
    if (builderSource.indexOf(rule.prefix) < 0) missing.push(rule.prefix);
  }
  assert.deepEqual(missing, [], '臆造前缀：' + JSON.stringify(missing));
});

check('prefix 唯一且码/类别非空（同前缀不许两种归法）', () => {
  const seen = new Set();
  for (const rule of REFUSAL_RULES) {
    assert.ok(!seen.has(rule.prefix), '重复前缀 ' + rule.prefix);
    seen.add(rule.prefix);
    assert.match(rule.code, /^[A-Z0-9_]{2,64}$/);
    assert.match(rule.category, /^[a-z][a-z-]{1,31}$/);
  }
});

check('collected refusal 码都在 builder 源码里出现', () => {
  for (const code of COLLECTED_REFUSAL_CODES) assert.ok(builderSource.indexOf(code) >= 0, code);
  assert.ok(builderSource.indexOf(COLLECTED_REFUSAL_PREFIX.trim()) >= 0);
});

check('builder fail() 字面量的分类覆盖率', () => {
  const literals = builderFailLiterals(builderSource);
  assert.ok(literals.length >= 100, '样本太少：' + literals.length);
  let classified = 0;
  const unclassified = [];
  for (const message of literals) {
    const r = classifyRefusal(new Error(message));
    if (r.code === UNCLASSIFIED_CODE) unclassified.push(message.slice(0, 60));
    else classified += 1;
  }
  const pct = Math.round((classified / literals.length) * 1000) / 10;
  console.log('  · 覆盖率 ' + classified + '/' + literals.length + ' = ' + pct + '%' +
    (unclassified.length ? ' · 未归类 ' + JSON.stringify(unclassified) : ''));
  assert.ok(pct >= 60, '覆盖率跌到 ' + pct + '%（低于 60% 底线）');
});

check('最长前缀优先（source database 系列不被 source 吞掉）', () => {
  const r = classifyRefusal(new Error('source database is missing required table(s): sessions'));
  assert.equal(r.code, 'SRCDB_MISSING_TABLES');
  assert.equal(r.category, 'source-db');
});

check('collected refusal 走自己的类别，不被前缀表吞掉', () => {
  const r = classifyRefusal(new Error(COLLECTED_REFUSAL_PREFIX + 'WORD_SEQ_CONFLICT: words.jsonl line 3: session+seq x #1 was already declared'));
  assert.equal(r.code, 'WORD_SEQ_CONFLICT');
  assert.equal(r.category, 'collected-refusal');
});

check('带 code 的错误优先用 code（TEMP 导入失败一类）', () => {
  const e = new Error('TEMP_IMPORT_FAILED');
  e.code = 'IMPORT_SHA_MISMATCH';
  const r = classifyRefusal(e);
  assert.equal(r.code, 'IMPORT_SHA_MISMATCH');
  assert.equal(r.source, 'error.code');
});

check('sync 干跑自己的码（message 就是码）单独归类', () => {
  assert.equal(classifyRefusal(new Error('SHARD_MISSING')).category, 'shard-path');
  assert.equal(classifyRefusal(new Error('PRODUCTION_APPLY_NOT_IMPLEMENTED_IN_TASK62')).category, 'argument');
});

check('认不出时 UNCLASSIFIED + unrecognized，且代表不含数据', () => {
  const r = classifyRefusal(new Error('something new happened at D:/AI/memory/hub/index/shards/abc.jsonl seq 12345'));
  assert.equal(r.code, UNCLASSIFIED_CODE);
  assert.equal(r.category, UNRECOGNIZED_CATEGORY);
  assert.match(r.head, /^[a-z ]*$/);
  assert.ok(r.head === null || r.head.length <= 40);
});

check('安全代表永不回传路径/数字/会话 id（一律字面量或 [a-z ] 净化段）', () => {
  const probes = [
    'source D:/AI/memory/hub/index/shards/word-0123.jsonl shrank (truncation): 100 -> 50',
    'cursor.files[D:/AI/x].nextByte must be a non-negative safe integer',
    'session-9f3a2c #123 words.jsonl line 77 exploded',
    'WEIRD_thing happened',
    'totally novel 9f3a2c-thing at C:/secret/path.jsonl',
  ];
  for (const message of probes) {
    const r = classifyRefusal(new Error(message));
    const serialized = JSON.stringify(r);
    assert.ok(serialized.indexOf('D:/AI') < 0 && serialized.indexOf('C:/') < 0, '结果里带出了路径：' + serialized);
    assert.ok(serialized.indexOf('9f3a2c') < 0, '结果里带出了会话 id：' + serialized);
    // 两条允许的来源：① 头部就是 builder 里的静态字面量；② 未归类时的净化段，只允许 [a-z ]。
    if (r.head === null) continue;
    assert.ok(r.head.length <= 40, 'head 过长：' + r.head);
    if (r.source === 'unclassified') assert.match(r.head, /^[a-z ]+$/);
    else assert.ok(builderSource.indexOf(r.head) >= 0, '分类头部不是字面量：' + JSON.stringify(r.head));
  }
});

check('确定性：同一输入两次分类完全一致', () => {
  const e = new Error('outDir must be absent or empty (each generation gets its own directory): D:/tmp/x');
  assert.deepEqual(classifyRefusal(e), classifyRefusal(e));
});

check('recordRefusal 只加拒绝计数，绝不动 eligible/builtSources（fail-closed）', () => {
  const report = {
    ...refusalReportFields(),
    buildRefusals: 0, missingShards: 0, builtSources: 0,
    eligible: { words: 7, summaries: 2 },
    sourceBuckets: { manifestDeclaredEmpty: 0, physicalEmpty: 0, declaredCountMismatch: 0, declaredNonemptyBuilt: 1, declaredNonemptyRefused: 0, declaredEmptyRefused: 0 },
  };
  const before = JSON.parse(JSON.stringify({ eligible: report.eligible, builtSources: report.builtSources }));
  recordRefusal(report, new Error('source database is missing required table(s): sources'), { phase: 'build', declaredNonempty: true });
  recordRefusal(report, new Error('totally novel failure'), { phase: 'build', declaredNonempty: false });
  recordRefusal(report, new Error('SHARD_MISSING'), { phase: 'shard' });
  assert.deepEqual({ eligible: report.eligible, builtSources: report.builtSources }, before, 'eligible/built 被拒绝路径改动了');
  assert.equal(report.buildRefusals, 2);
  assert.equal(report.missingShards, 1);
  assert.equal(report.builtSources, 0);
  assert.equal(report.unclassifiedRefusals, 1);
  assert.equal(report.refusalCategories['source-db'], 1);
  assert.equal(report.refusalCategories[UNRECOGNIZED_CATEGORY], 1);
  assert.equal(report.refusalCategories['shard-path'], 1);
  assert.equal(report.sourceBuckets.declaredNonemptyRefused, 1);
  assert.equal(report.sourceBuckets.declaredEmptyRefused, 1);
  assert.deepEqual(report.representativeBuilderError, { name: 'Error', code: 'SRCDB_MISSING_TABLES', category: 'source-db', head: 'source database is missing required table(s)' });
  assert.equal(report.representativeRefusals['SHARD_MISSING'].category, 'shard-path');
  assert.equal(refusalKey({ name: 'Error', code: 'X' }), 'Error:X');
});

check('recordRefusal 的键形状与旧 refusalCodes 兼容（name:code）', () => {
  const report = { ...refusalReportFields(), buildRefusals: 0, missingShards: 0, builtSources: 0, eligible: { words: 0, summaries: 0 }, sourceBuckets: { manifestDeclaredEmpty: 0, physicalEmpty: 0, declaredCountMismatch: 0, declaredNonemptyBuilt: 0, declaredNonemptyRefused: 0, declaredEmptyRefused: 0 } };
  recordRefusal(report, new TypeError('line 4: row must be object'), { phase: 'build', declaredNonempty: true });
  assert.deepEqual(Object.keys(report.refusalCodes), ['TypeError:ROW_INPUT_INVALID']);
});

// ── 集成锚点（只读核对，不改那个文件）─────────────────────────────────
// 本模块的落点是 echo-index-production-sync.mjs 的 safeBuildErrorCode()，而那个文件
// 2026-11-16 13:25–13:32 期间有另一个写者在改（新增 refusalTemplate/safeRefusalFingerprint/
// runDiagnostic(options)/CLI 入口守卫）。所以这里只核对**锚点还在不在**，不写它。
// 锚点漂移 = 补丁要重新对一遍，而不是静默失效。
const SYNC_TOOL = path.join(HERE, 'echo-index-production-sync.mjs');
const FINGERPRINT_ANCHOR = 'function safeBuildErrorCode(error){';
const UNCLASSIFIED_ANCHOR = "return 'UNCLASSIFIED';";
check('集成锚点仍在（safeBuildErrorCode + UNCLASSIFIED 战士位）', () => {
  const src = fs.readFileSync(SYNC_TOOL, 'utf8');
  assert.ok(src.indexOf(FINGERPRINT_ANCHOR) >= 0, '锚点 function safeBuildErrorCode(error){ 不见了');
  assert.ok(src.indexOf(UNCLASSIFIED_ANCHOR) >= 0, '锚点 return UNCLASSIFIED 不见了（可能已被集成）');
  const integrated = src.indexOf('echo-refusal-classify.mjs') >= 0;
  console.log('  · sync 干跑当前是否已接本模块：' + (integrated ? '是' : '否（待集成，2 行补丁）'));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exitCode = 1;
