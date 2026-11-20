#!/usr/bin/env node
// TEMP-only synthetic coverage for per-source ECHO snapshot import (the ONE harness).
// Snapshot data here is synthetic and inert; nothing touches a production DB or index.
// ★ ECHO_SNAPSHOT_IMPORT_MODULE lets the mutation check (item 11) point this suite at a
//   TEMP copy of the harness, so "can this assertion go red" is provable without editing
//   the repo file.
// ★ 2026-11-16（batch 2）：本节自检补了九件事 —— 正文列放行 sid（而路径列一格不放）、
//   每个失败码的反向对照、整库残留（不再按 echo_source_id 抽样）、journal 逐源落盘的
//   时序证据、身份与机器无关、CLI 的 journal/stderr 隐私、check() 的 SKIP 通道、
//   cmpId 两个计数器的区别、以及七个拒绝码的正反两面。
//   ★ SKIP 不等于 PASS：跳过单独计数，最终那行会把它算出来。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openMetaStore } from '../src/db/index.mjs';
import { echoSourceIdFor } from '../src/db/schema.mjs';
import { listEchoSources } from './echo-index-import.mjs';
// 身份版本的**唯一真相**来自 builder：不可达证明要用它和 keeper 的 SOURCE_VERSION 对比。
import { ECHO_INDEX_VERSION } from './echo-source-build.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = process.env.ECHO_SNAPSHOT_IMPORT_MODULE
  ? (path.isAbsolute(process.env.ECHO_SNAPSHOT_IMPORT_MODULE)
    ? pathToFileURL(process.env.ECHO_SNAPSHOT_IMPORT_MODULE).href
    : pathToFileURL(path.resolve(process.cwd(), process.env.ECHO_SNAPSHOT_IMPORT_MODULE)).href)
  : new URL('./echo-index-source-snapshot-import.mjs', import.meta.url).href;
const I = await import(MODULE_PATH);

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-source-snapshot-selftest-'));
// 收尾：无论断言过不过，TEMP 工作目录都不留（断言失败时也要清 —— 这里不用 try/finally 就不成立）。
process.on('exit', () => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* 清理失败不该掩盖原错误 */ } });
const T = '2026-11-16T00:00:00.000Z';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const SIDS = [];
const results = []; // { kind: 'PASS' | 'SKIP', label } —— 一条 check 只落一条
// ★ 2026-11-16（batch 2）：check 有了 SKIP 通道，而且**跳过不算通过**。
//   返回 SKIP 哨兵 = 记一条 SKIP；正常返回（含 undefined）= 记一条 PASS。两者互斥 ——
//   一条 check 永远只落一条记录，所以「跳过」不会被同时读成「通过」。
const SKIP = Symbol('SKIP');
function check(label, fn) {
  const verdict = fn();
  results.push({ kind: verdict === SKIP ? 'SKIP' : 'PASS', label });
  return verdict;
}
function countResults() {
  const pass = results.filter((r) => r.kind === 'PASS').length;
  const skip = results.filter((r) => r.kind === 'SKIP').length;
  return { total: results.length, pass, skip };
}

// ── fixtures ─────────────────────────────────────────────────────────────
// 源行形状 = 权威 ECHO 索引行的形状；files/words/summaries 字段集必须精确。
function makeSource(o) {
  const ns = o.namespace;
  const sid = o.sid;
  SIDS.push(sid);
  const ws = o.ws === undefined ? 'ws-synth' : o.ws;
  // ★ 这里的 log 故意写成本机真实路径（canary）：用它证明 feed/清单/库/journal 都把它脱敏掉了。
  const log = o.log || ('D:/AI/memory/hub/index/sessions/' + sid + '.v4.zst');
  const words = (o.words || []).map((w) => ({
    t: T, session: sid, ws, seq: w.seq, turn: null, log,
    role: w.role === undefined ? 'user' : w.role, kind: w.kind || 'human',
    len: Array.from(w.text).length, truncated: w.truncated === true, text: w.text,
  }));
  // srcSeqs 默认指向本源的第一个 word：悬空引用会被 builder 拒（那是它该做的事），
  // 这里让 fixture 本身自洽，别把「fixture 写错」当成「harness 坏了」。
  const firstSeq = (o.words && o.words.length) ? o.words[0].seq : 1;
  const summaries = (o.summaries || []).map((s) => ({
    id: s.id, t: T, session: sid, ws, log, srcSeqs: s.srcSeqs || [firstSeq],
    shadowedTokens: 1, chars: 1, provider: 'synthetic', model: 'synthetic', status: 'active',
    summary: s.summary || ('summary ' + s.id), manifest: { synthetic: true },
  }));
  const file = o.file || {
    file: log, key: 'synth-key-' + sid, nextByte: 64, ws, sid,
    nSum: summaries.length, nWord: words.length,
    sumOut: 'D:/AI/memory/hub/index/sum.jsonl', wordOut: 'D:/AI/memory/hub/index/word.jsonl',
  };
  return {
    sourceVersion: o.sourceVersion === undefined ? (ns === 'log' ? 'v3' : 'v4') : o.sourceVersion,
    sid,
    files: o.dropFiles ? [] : [file],
    words,
    summaries,
  };
}
function writeSnapshot(name, sources) {
  const p = path.join(ROOT, name + '.json');
  fs.writeFileSync(p, JSON.stringify({ sources }) + '\n', { flag: 'wx' });
  return p;
}
function makeDb(name) {
  const dbPath = path.join(ROOT, name + '.sqlite');
  const store = openMetaStore({ path: dbPath, mode: 'readwrite' });
  try { store.migrate(); } finally { store.close(); }
  return dbPath;
}
function withDb(p, fn) { const s = openMetaStore({ path: p, mode: 'readwrite' }); try { return fn(s); } finally { s.close(); } }
const ECHO_TABLES = ['echo_index_sources', 'echo_words', 'echo_summaries', 'echo_summary_src_seqs', 'echo_words_fts', 'echo_summaries_fts', 'echo_source_builds'];
function rowsFor(db, id) {
  const out = {};
  for (const t of ECHO_TABLES) out[t] = Number(db.prepare('SELECT COUNT(*) AS n FROM ' + t + ' WHERE echo_source_id = ?').get(id).n);
  return out;
}
function echoRowCount(db, table) { return Number(db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n); }
// 「TEMP 外面」的一个现存绝对文件。用途：TEMP_ONLY 判据必须对着真的外部路径断言，
// 而这个仓库/自检本身可能就放在 TEMP 里（变异证明的副本就是这样）。
function outsideTempFile() {
  const root = fs.realpathSync(os.tmpdir()).toLowerCase();
  const candidates = ['C:/Windows/win.ini', 'C:/Windows/System32/drivers/etc/hosts', 'C:/Windows/System32/notepad.exe'];
  for (const c of candidates) {
    if (!path.isAbsolute(c) || !fs.existsSync(c)) continue;
    let real;
    try { real = fs.realpathSync(c); } catch { continue; }
    if (!real.toLowerCase().startsWith(root)) return real;
  }
  return null;
}
const journalLines = (p) => fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
function expectCode(fn, code) {
  try { fn(); } catch (e) { assert.equal(e.code, code, 'expected ' + code + ' got ' + e.code + ': ' + e.message); return e; }
  throw new Error('expected refusal ' + code + ' but nothing was thrown');
}

// ── batch 2 helpers ──────────────────────────────────────────────────────
// 整库行数（**不按 echo_source_id 过滤**）：残留判据要的是「库里到底多了什么」，
// 不是「这一批的 id 名下有没有行」—— 后者漏掉任何写错 id 的残留。
function allEchoCounts(db) {
  const out = {};
  for (const t of ECHO_TABLES) out[t] = echoRowCount(db, t);
  return out;
}
function addTrigger(dbPath, sql) { withDb(dbPath, (s) => s.db.exec(sql)); }
// 一条 check 的通用形状：preflight/主流程之外的拒绝码都在写库之前，所以顺带断言
// 「库里没有来源行、盘上没有 journal」—— 那才是 fail closed，而不是「抛了个错」。
function expectRefusal(name, sources, code) {
  const snap = writeSnapshot(name, sources);
  const db = makeDb(name);
  const journal = path.join(ROOT, name + '-journal.jsonl');
  const err = expectCode(() => I.importSnapshot(snap, db, journal, { generation: 1, builtAt: T }), code);
  withDb(db, (s) => assert.equal(listEchoSources(s.db).length, 0, code + ': must not write a source row'));
  assert.equal(fs.existsSync(journal), false, code + ': must not create a journal');
  return err;
}
function expectImports(name, sources) {
  const snap = writeSnapshot(name, sources);
  const db = makeDb(name);
  const run = I.importSnapshot(snap, db, path.join(ROOT, name + '-journal.jsonl'), { generation: 1, builtAt: T });
  assert.equal(run.ok, true, name + ' must import cleanly: ' + JSON.stringify(run.problems));
  assert.equal(run.imported, sources.length, name + ': every source must be imported');
  return { run, db, snap };
}
// fs 层的**测试缝**（batch 2）：不碰 keeper 一个字，只在 syscall 边界拦一次。
// 之所以拦得到：keeper 与这里拿的是同一个 node:fs 模块对象，而它在**调用时**才取属性。
// 用法：const h = hookFs('readFileSync', (origin, state, args) => {...}); try {...} finally { h.restore(); }
function hookFs(name, impl) {
  const origin = fs[name];
  const state = { calls: 0 };
  fs[name] = function (...args) { state.calls++; return impl(origin, state, args); };
  return { state, restore: () => { fs[name] = origin; } };
}

// ── ① 身份：机器可迁移，只由 (namespace, sid) 决定 ────────────────────────
check('identity is f(namespace, sid) only — exact formula, no path/ws/digest/row index', () => {
  const sid = 'session-identity-A';
  const expected = 'D:/synthetic/echo-source/log/' + sha('echo-source-identity/v1\n' + sid);
  assert.equal(I.sourceIdentityFor('log', sid), expected);
  assert.equal(I.echoSourceIdForSource('log', sid), echoSourceIdFor(expected, 'echo-index/1'));
  assert.equal(I.sourceIdentityFor('v4log', sid), 'D:/synthetic/echo-source/v4log/' + sha('echo-source-identity/v1\n' + sid));
  assert.notEqual(I.sourceIdentityFor('log', sid), I.sourceIdentityFor('v4log', sid));
  // 换个 sid 一定换身份；同一 sid 换 ws/路径一定不换身份
  assert.notEqual(I.sourceIdentityFor('log', sid), I.sourceIdentityFor('log', sid + 'x'));
});

check('namespace is explicit: v3→log, v4→v4log; anything else fails closed', () => {
  assert.equal(I.namespaceForSourceVersion('v3'), 'log');
  assert.equal(I.namespaceForSourceVersion('v4'), 'v4log');
  expectCode(() => I.namespaceForSourceVersion('v5'), 'SOURCE_VERSION_UNKNOWN');
  expectCode(() => I.namespaceForSourceVersion(undefined), 'SOURCE_VERSION_MISSING');
  expectCode(() => I.namespaceForSourceVersion(4), 'SOURCE_VERSION_UNKNOWN');
});

// ── ② 主流程：两源（同名 sid，不同 namespace）────────────────────────────
const mainSnap = writeSnapshot('main', [
  makeSource({ namespace: 'log', sid: 'session-shared', words: [{ seq: 7, text: 'legacy source word' }], summaries: [{ id: 'cmp-shared' }] }),
  makeSource({ namespace: 'v4log', sid: 'session-shared', words: [{ seq: 7, text: 'v4 source word' }], summaries: [{ id: 'cmp-shared' }] }),
]);
const mainDb = makeDb('main');
const mainJournal = path.join(ROOT, 'main-journal.jsonl');
let mainRun;
check('two namespaces with the same sid import as two distinct source identities', () => {
  mainRun = I.importSnapshot(mainSnap, mainDb, mainJournal, { generation: 1, builtAt: T });
  assert.equal(mainRun.ok, true);
  assert.equal(mainRun.imported, 2);
  assert.deepEqual(mainRun.outcomes.map((o) => o.outcome), ['IMPORTED', 'IMPORTED']);
  assert.equal(new Set(mainRun.outcomes.map((o) => o.echoSourceId)).size, 2);
});

check('journal: manifest sha, identity and counts are recorded; no tautological conservation', () => {
  const lines = journalLines(mainJournal);
  assert.equal(lines[0].type, 'header');
  assert.equal(lines[0].harness, I.HARNESS_VERSION);
  assert.equal(lines[0].sourceVersion, 'echo-index/1');
  assert.match(String(lines[0].atomicity), /NOT atomic/);
  assert.equal(lines[lines.length - 1].type, 'summary');
  const summary = lines[lines.length - 1];
  assert.equal(summary.ok, true);
  assert.equal(summary.sourceCount, 2);
  assert.equal(summary.imported, 2);
  assert.equal(summary.alreadyCurrent, 0);
  assert.equal(summary.refused, 0);
  assert.equal(summary.failed, 0);
  assert.equal(summary.counts.importedWords, 2);
  assert.equal(summary.counts.importedSummaries, 2);
  assert.deepEqual(summary.frameIndex.before, summary.frameIndex.after);
  assert.deepEqual(summary.problems, []);
  assert.equal(summary.counts.accountedRows, undefined);
  for (const line of lines.filter((l) => l.type === 'outcome')) {
    assert.match(line.manifestSha256, /^[0-9a-f]{64}$/);
    assert.match(line.sourcePathHash, /^[0-9a-f]{64}$/);
    assert.equal(line.generation, 1);
    // 身份可以从 (namespace, sid) 独立重算 —— journal 里的 id 不是「抄来的」。
    assert.equal(line.echoSourceId, I.echoSourceIdForSource(line.namespace, 'session-shared'));
    assert.equal(line.sourcePathHash, sha(I.sourceIdentityFor(line.namespace, 'session-shared')));
  }
});

check('builder-written manifest bytes reach the DB unchanged (journal sha == stored source_sha256)', () => {
  const lines = journalLines(mainJournal).filter((l) => l.type === 'outcome');
  withDb(mainDb, (s) => {
    for (const line of lines) {
      const row = s.db.prepare('SELECT source_sha256, source_version, source_path, namespace FROM echo_index_sources WHERE echo_source_id = ?').get(line.echoSourceId);
      assert.equal(row.source_sha256, line.manifestSha256);
      assert.equal(row.source_version, 'echo-index/1');
      assert.equal(row.namespace, line.namespace);
      assert.equal(row.source_path, I.sourceIdentityFor(line.namespace, 'session-shared'));
    }
    assert.equal(listEchoSources(s.db).length, 2);
  });
});

check('log vs v4log for the same sid+seq resolve to different text through store.echoOpen', () => {
  withDb(mainDb, (s) => {
    const legacy = s.echoOpen('log:session-shared#seq=7');
    const v4 = s.echoOpen('v4log:session-shared#seq=7');
    assert.equal(legacy.word.text, 'legacy source word');
    assert.equal(v4.word.text, 'v4 source word');
    assert.notEqual(legacy.source.echoSourceId, v4.source.echoSourceId);
    // 行级 log 值已脱敏：不是本机路径，网络同步时不会带出机器布局。
    assert.equal(legacy.word.log, I.REDACTED_LOG);
    assert.equal(v4.word.log, I.REDACTED_LOG);
  });
});

// ── ③ idx 歧义：跨源重复 cmpId ────────────────────────────────────────────
check('duplicate cmpId across two sources: AMBIGUOUS with candidates, selector picks one, wrong selector MISMATCH', () => {
  withDb(mainDb, (s) => {
    const ids = listEchoSources(s.db).map((x) => x.echoSourceId);
    const err = expectCode(() => s.echoOpen('idx:cmp-shared'), 'ECHO_PTR_AMBIGUOUS');
    assert.equal(err.details.candidates.length, 2);
    assert.deepEqual(err.details.candidates.map((c) => c.echoSourceId).sort(), ids.slice().sort());
    const picked = s.echoOpen('idx:cmp-shared', { echoSourceId: ids[0] });
    assert.equal(picked.kind, 'summary');
    assert.equal(picked.source.echoSourceId, ids[0]);
    const other = s.echoOpen('idx:cmp-shared', { echoSourceId: ids[1] });
    assert.notEqual(other.source.echoSourceId, ids[0]);
    assert.equal(other.summary.cmpId, 'cmp-shared');
    const mismatch = expectCode(() => s.echoOpen('idx:cmp-shared', { echoSourceId: 'f'.repeat(64) }), 'ECHO_PTR_SOURCE_MISMATCH');
    assert.equal(mismatch.details.candidateIds.length, 2);
  });
});

check('preflight counts the cross-source cmpId ambiguity as a risk (not silently dropped)', () => {
  assert.equal(mainRun.risks.cmpIdAmbiguityIds, 1);
  assert.equal(mainRun.risks.cmpIdAmbiguityRows, 1);
  assert.equal(mainRun.risks.wordKeysRefused, 0);
});

// ── ④ 同一 namespace 内跨源重复 word key = 歧义风险，预检拒 ────────────────
check('identical word key in the SAME namespace across two sources is refused in preflight', () => {
  // 两条行同一个 sid、同一个 seq、同样的字节 —— 指针键完全重合。
  const snap = writeSnapshot('wordkey-identical', [
    makeSource({ namespace: 'log', sid: 'session-dup-same', words: [{ seq: 3, text: 'same bytes' }] }),
    makeSource({ namespace: 'log', sid: 'session-dup-same', words: [{ seq: 3, text: 'same bytes' }] }),
  ]);
  const db = makeDb('wordkey-identical');
  const journal = path.join(ROOT, 'wordkey-identical-journal.jsonl');
  const err = expectCode(() => I.importSnapshot(snap, db, journal, { generation: 1, builtAt: T }), 'WORD_KEY_AMBIGUOUS_ACROSS_SOURCES');
  // 相同（不是「不同」）：静默留两份正是这里要拦的那件事。
  assert.equal(err.detail.risks.identicalWordKeysAcrossSources, 1);
  assert.equal(err.detail.risks.differingWordKeysAcrossSources, 0);
  assert.equal(err.detail.risks.wordKeysRefused, 1);
  // fail closed before any DB write and before any journal
  withDb(db, (s) => assert.equal(listEchoSources(s.db).length, 0));
  assert.equal(fs.existsSync(journal), false);
});

check('differing word key in the same namespace across two sources is refused and counted separately', () => {
  const snap = writeSnapshot('wordkey-differing', [
    makeSource({ namespace: 'v4log', sid: 'session-dup-diff', words: [{ seq: 9, text: 'first' }] }),
    makeSource({ namespace: 'v4log', sid: 'session-dup-diff', words: [{ seq: 9, text: 'second' }] }),
  ]);
  const err = expectCode(() => I.importSnapshot(snap, makeDb('wordkey-differing'), path.join(ROOT, 'wk2.jsonl'), { generation: 1, builtAt: T }), 'WORD_KEY_AMBIGUOUS_ACROSS_SOURCES');
  assert.equal(err.detail.risks.differingWordKeysAcrossSources, 1);
  assert.equal(err.detail.risks.identicalWordKeysAcrossSources, 0);
});

// ── ⑤ 预检：每个拒绝都有独立码，且都在写库之前 ────────────────────────────
check('preflight refusal codes are distinct and every one happens before any DB write', () => {
  const base = (seq = 1, text = 'x') => makeSource({ namespace: 'log', sid: 'session-preflight', words: [{ seq, text }] });
  const cases = [
    ['SID_MISSING', () => { const s = base(); delete s.sid; return [s]; }],
    ['SID_MALFORMED', () => { const s = base(); s.sid = 'bad sid/with#stuff'; s.files[0].sid = s.sid; return [s]; }],
    ['SOURCE_VERSION_MISSING', () => { const s = base(); delete s.sourceVersion; return [s]; }],
    ['SOURCE_VERSION_UNKNOWN', () => { const s = base(); s.sourceVersion = 'v9'; return [s]; }],
    // 同一 (namespace, sid) 两行、行集**不重叠** → 走到重复身份这一条（同键那条更优先，见上）。
    ['DUPLICATE_SOURCE_IDENTITY', () => [base(1, 'x'), base(2, 'y')]],
    ['COUNT_MISMATCH', () => { const s = base(); s.files[0].nWord = 5; return [s]; }],
    ['FIELD_SET_INVALID', () => { const s = base(); s.words[0].extra = 'nope'; return [s]; }],
    ['SESSION_MISMATCH', () => { const s = base(); s.files[0].sid = 'session-other'; return [s]; }],
  ];
  for (const [code, build] of cases) {
    const name = 'pre-' + code.toLowerCase();
    const snap = writeSnapshot(name, build());
    const db = makeDb(name);
    const journal = path.join(ROOT, name + '-journal.jsonl');
    expectCode(() => I.importSnapshot(snap, db, journal, { generation: 1, builtAt: T }), code);
    withDb(db, (s) => assert.equal(listEchoSources(s.db).length, 0, code + ' must not write a source row'));
    assert.equal(fs.existsSync(journal), false, code + ' must not create a journal');
  }
});

check('generation and builtAt are explicit: no fabricated defaults', () => {
  const snap = writeSnapshot('noopts', [makeSource({ namespace: 'log', sid: 'session-noopts', words: [{ seq: 1, text: 'x' }] })]);
  const db = makeDb('noopts');
  expectCode(() => I.importSnapshot(snap, db, path.join(ROOT, 'noopts-a.jsonl'), { builtAt: T }), 'OPTIONS_GENERATION_REQUIRED');
  expectCode(() => I.importSnapshot(snap, db, path.join(ROOT, 'noopts-b.jsonl'), { generation: 1 }), 'OPTIONS_BUILT_AT_REQUIRED');
  expectCode(() => I.importSnapshot(snap, db, path.join(ROOT, 'noopts-c.jsonl'), { generation: 0, builtAt: T }), 'OPTIONS_GENERATION_REQUIRED');
});

// ── ⑥ 推理行：builder 排除了它 → 清单计数与发射文件不符 → 提前拒 ──────────
check('a real reasoning row is refused up front with EXCLUDED_REASONING_UNREPRESENTABLE', () => {
  const snap = writeSnapshot('reasoning', [
    makeSource({
      namespace: 'v4log', sid: 'session-reasoning',
      words: [
        { seq: 1, text: 'user question' },
        { seq: 2, text: 'internal reasoning text', role: 'reasoning', kind: 'reasoning' },
      ],
    }),
  ]);
  const db = makeDb('reasoning');
  const journal = path.join(ROOT, 'reasoning-journal.jsonl');
  const run = I.importSnapshot(snap, db, journal, { generation: 1, builtAt: T });
  assert.equal(run.ok, false);
  assert.equal(run.refused, 1);
  assert.equal(run.failed, 0);
  assert.equal(run.imported, 0);
  const outcome = run.outcomes[0];
  assert.equal(outcome.outcome, 'REFUSED');
  assert.equal(outcome.code, 'EXCLUDED_REASONING_UNREPRESENTABLE');
  assert.equal(outcome.counts.excludedReasoning, 1);
  assert.equal(outcome.counts.emittedWords, 1);
  withDb(db, (s) => assert.equal(listEchoSources(s.db).length, 0));
});

// ── ⑦ 空源 / 只有摘要：显式非导入结果 ────────────────────────────────────
check('canonical 0/0 and summary-only sources stay explicit non-import outcomes', () => {
  const empty = { sourceVersion: 'v3', sid: 'session-empty', files: [], words: [], summaries: [] };
  const summaryOnly = makeSource({ namespace: 'v4log', sid: 'session-sumonly', words: [], summaries: [{ id: 'cmp-only' }] });
  summaryOnly.files[0].nWord = 0;
  const snap = writeSnapshot('skips', [empty, summaryOnly]);
  const db = makeDb('skips');
  const run = I.importSnapshot(snap, db, path.join(ROOT, 'skips-journal.jsonl'), { generation: 1, builtAt: T });
  assert.deepEqual(run.outcomes.map((o) => o.outcome), ['SKIPPED_EMPTY', 'SKIPPED_SUMMARY_ONLY']);
  assert.equal(run.imported, 0);
  assert.equal(run.skippedEmpty, 1);
  assert.equal(run.skippedSummaryOnly, 1);
  assert.equal(run.ok, true, 'skips are not failures');
  withDb(db, (s) => assert.equal(listEchoSources(s.db).length, 0));
});

// ── ⑧ generation 语义：同一 sid、重排的快照、换掉的摘要 → 同一个 id ────────
check('same sid from a re-ordered later snapshot with a changed digest keeps the same echoSourceId', () => {
  const mk = (text, seqs) => makeSource({ namespace: 'v4log', sid: 'session-gen', words: seqs.map((s) => ({ seq: s, text })), summaries: [{ id: 'cmp-gen' }] });
  const snapA = writeSnapshot('gen-a', [mk('generation one text', [1])]);
  const snapB = writeSnapshot('gen-b', [mk('generation two text', [1])]);
  const digestA = sha(fs.readFileSync(snapA));
  const digestB = sha(fs.readFileSync(snapB));
  assert.notEqual(digestA, digestB);
  const db = makeDb('gen');
  const a = I.importSnapshot(snapA, db, path.join(ROOT, 'gen-a.jsonl'), { generation: 1, builtAt: T });
  const rerun = I.importSnapshot(snapA, db, path.join(ROOT, 'gen-a2.jsonl'), { generation: 1, builtAt: T });
  const b = I.importSnapshot(snapB, db, path.join(ROOT, 'gen-b.jsonl'), { generation: 2, builtAt: T });
  // generation 1 重跑 = ALREADY_CURRENT（不是第二次导入，也不涨行数）
  assert.deepEqual(rerun.outcomes.map((o) => o.outcome), ['ALREADY_CURRENT']);
  assert.equal(rerun.alreadyCurrent, 1);
  assert.equal(rerun.imported, 0);
  // generation 2 换了数据 = IMPORTED，同一个身份，仍然只有一行来源
  assert.deepEqual(b.outcomes.map((o) => o.outcome), ['IMPORTED']);
  assert.equal(a.outcomes[0].echoSourceId, rerun.outcomes[0].echoSourceId);
  assert.equal(a.outcomes[0].echoSourceId, b.outcomes[0].echoSourceId);
  assert.notEqual(a.outcomes[0].manifestSha256, b.outcomes[0].manifestSha256);
  withDb(db, (s) => {
    const rows = listEchoSources(s.db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].generation, 2);
    assert.equal(s.echoOpen('v4log:session-gen#seq=1').word.text, 'generation two text');
  });
});

check('identity ignores the machine: moving the snapshot to another absolute path changes nothing', () => {
  // 同一个 sid、不同的（假的）本机路径与 ws：身份必须一模一样。
  const a = makeSource({ namespace: 'log', sid: 'session-portable', words: [{ seq: 1, text: 'x' }], log: 'D:/AI/memory/hub/index/sessions/session-portable.v3.zst', ws: 'ws-one' });
  const b = makeSource({ namespace: 'log', sid: 'session-portable', words: [{ seq: 1, text: 'x' }], log: 'E:/other/machine/elsewhere/session-portable.v3.zst', ws: 'ws-two' });
  const idA = I.echoSourceIdForSource('log', a.sid);
  const idB = I.echoSourceIdForSource('log', b.sid);
  assert.equal(idA, idB);
});

// ── ⑨ 混合批次：一个成功，一个在 importer 事务里失败 ──────────────────────
check('mixed batch: whole-DB residue — the failed source adds zero rows in ALL ECHO tables (both FTS + src_seqs), the first stays committed', () => {
  const snap = writeSnapshot('mixed', [
    makeSource({ namespace: 'log', sid: 'session-ok-a', words: [{ seq: 1, text: 'survivor' }], summaries: [{ id: 'cmp-ok' }] }),
    makeSource({ namespace: 'v4log', sid: 'session-fail-b', words: [{ seq: 2, text: 'doomed' }], summaries: [{ id: 'cmp-doomed' }] }),
  ]);
  const db = makeDb('mixed');
  const idOk = I.echoSourceIdForSource('log', 'session-ok-a');
  const idBad = I.echoSourceIdForSource('v4log', 'session-fail-b');
  // ★ batch 2：旧版这一条按 echo_source_id 抽样，而且帧表是 0 → 0（等于什么都没证明）。
  //   现在：帧表先种**真行**（三行帧 + 它们的父行 sources/sessions），残留判据换成**整库行数**。
  withDb(db, (s) => {
    s.db.prepare('INSERT INTO sources (source_id, kind, namespace, authority, raw_path, path_kind, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      // 库层护栏：只有 namespace = 'log' 才能配 authority = 'primary'（trg_sources_log_namespace_insert）。
      .run('synth-frames-src', 'dsh-log', 'log', 'primary', 'D:/synthetic/frames', 'dir', T, T);
    s.db.prepare('INSERT INTO sessions (source_id, session_id, container_id, first_seen_at, last_seen_at) VALUES (?,?,?,?,?)')
      .run('synth-frames-src', 'session-frames-synth', 'container-synth', T, T);
    const insFrame = s.db.prepare('INSERT INTO frame_index (source_id, session_id, seq, raw_path, frame_ordinal, authority, ptr, snippet, content_hash, indexed_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
    for (const seq of [0, 1, 2]) {
      insFrame.run('synth-frames-src', 'session-frames-synth', seq, 'D:/synthetic/frames/frames.jsonl', seq, 'primary',
        'log:session-frames-synth#seq=' + seq, 'synthetic frame ' + seq, sha(Buffer.from('synthetic-frame-' + seq)), T);
    }
    // 只在第二个源的会话上炸：证明「逐源事务」而不是「整批回滚」。
    s.db.exec("CREATE TRIGGER synth_fail_b BEFORE INSERT ON echo_words WHEN NEW.session = 'session-fail-b' BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_ROLLBACK'); END;");
  });
  const framesSql = 'SELECT source_id, session_id, seq, ptr, content_hash FROM frame_index ORDER BY seq';
  const framesBefore = withDb(db, (s) => s.db.prepare(framesSql).all());
  assert.equal(framesBefore.length, 3, 'the frame seed must be REAL rows — a 0-to-0 check proves nothing');
  const before = withDb(db, (s) => allEchoCounts(s.db));
  const journal = path.join(ROOT, 'mixed-journal.jsonl');
  const run = I.importSnapshot(snap, db, journal, { generation: 1, builtAt: T });
  assert.equal(run.ok, false);
  assert.equal(run.imported, 1);
  assert.equal(run.failed, 1);
  assert.equal(run.refused, 0);
  assert.equal(run.outcomes[0].outcome, 'IMPORTED');
  assert.equal(run.outcomes[1].outcome, 'FAILED');
  assert.equal(run.outcomes[1].code, 'IMPORT_WRITE_FAILED');
  const after = withDb(db, (s) => allEchoCounts(s.db));
  const okRows = withDb(db, (s) => rowsFor(s.db, idOk));
  // ① 整库增量 == 第一个源已提交的行（逐表）。失败源一行都不许留。
  for (const t of ECHO_TABLES) {
    assert.equal(after[t] - before[t], okRows[t],
      t + ': whole-DB growth must equal the committed first source only (' + before[t] + ' -> ' + after[t] + ', expected +' + okRows[t] + ')');
  }
  // ② 失败源名下每张表都是 0（旧判据保留 —— 但它不再**代替**整库判据）
  const badRows = withDb(db, (s) => rowsFor(s.db, idBad));
  for (const t of ECHO_TABLES) assert.equal(badRows[t], 0, 'failed source must leave zero rows in ' + t);
  assert.deepEqual(okRows, {
    echo_index_sources: 1, echo_words: 1, echo_summaries: 1, echo_summary_src_seqs: 1,
    echo_words_fts: 1, echo_summaries_fts: 1, echo_source_builds: 1,
  });
  // ③ 帧表逐行不变（不是「都是 3」这种自证）
  const framesAfter = withDb(db, (s) => s.db.prepare(framesSql).all());
  assert.deepEqual(framesAfter, framesBefore);
  assert.equal(run.frameIndex.before, 3);
  assert.equal(run.frameIndex.after, 3);
  assert.equal(run.problems.some((p) => p.kind === 'frame-index-touched'), false);
  assert.equal(withDb(db, (s) => listEchoSources(s.db).length), 1);
  assert.equal(withDb(db, (s) => s.echoOpen('log:session-ok-a#seq=1').word.text), 'survivor');
  const lines = journalLines(journal);
  assert.equal(lines[0].type, 'header');
  assert.equal(lines[lines.length - 1].type, 'summary');
  assert.equal(lines[lines.length - 1].ok, false);
  assert.equal(lines[lines.length - 1].failed, 1);
});

check('CLI exits non-zero for a mixed batch (real process), and its journal + stderr carry no path and no raw sid', () => {
  // ★ batch 2（item 8）：node 路径**写死**。这条断言要考的是「真的能起一个子进程」——
  //   起不来就是**失败**，不是跳过（本机的 node 位置是固定的，没有「找不到」这种正常情况）。
  //   也**不再**用 process.execPath：那是「运行自检的那个解释器」，不是被测对象该用的那个。
  const NODE_BIN = process.env.ECHO_NODE_BIN || 'C:/Users/pc/.workbuddy/binaries/node/versions/22.22.2-3/node.exe';
  assert.equal(fs.existsSync(NODE_BIN), true, 'no usable node binary at ' + NODE_BIN + ' — this is a FAILURE, not a skip');
  const snap = writeSnapshot('mixed-spawn', [
    makeSource({ namespace: 'log', sid: 'session-spawn-ok', words: [{ seq: 1, text: 'kept' }] }),
    makeSource({ namespace: 'v4log', sid: 'session-spawn-bad', words: [{ seq: 2, text: 'nope' }] }),
  ]);
  const db = makeDb('mixed-spawn');
  withDb(db, (s) => {
    s.db.exec("CREATE TRIGGER synth_fail_b2 BEFORE INSERT ON echo_words WHEN NEW.session = 'session-spawn-bad' BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_ROLLBACK'); END;");
  });
  const journal = path.join(ROOT, 'mixed-spawn.jsonl');
  const cli = spawnSync(NODE_BIN, [path.join(HERE, 'echo-index-source-snapshot-import.mjs'), '--snapshot', snap, '--db', db, '--journal', journal, '--generation', '1', '--built-at', T], { encoding: 'utf8' });
  assert.equal(cli.status, I.EXIT.unfinished, 'CLI must exit non-zero: ' + cli.stderr);
  const printed = JSON.parse(String(cli.stdout).trim().split('\n').pop());
  assert.equal(printed.ok, false);
  assert.equal(printed.failed, 1);
  assert.equal(printed.imported, 1);
  // CLI 输出里不许有路径 / sid
  assert.equal(String(cli.stdout).includes(ROOT), false);
  assert.equal(String(cli.stdout).includes('session-spawn-ok'), false);
  // ★ batch 2（item 7）：**journal 与 stderr** 也过同一把尺子（路径 + sid），
  //   根用 realpath 比 —— 否则 /tmp 与 /private/tmp 这种软链会让判据两边不同源。
  const tempRoot = fs.realpathSync(os.tmpdir());
  const sidList = [...new Set(SIDS)];
  const surfaces = [['journal', fs.readFileSync(journal, 'utf8')], ['stderr', String(cli.stderr)]];
  for (const [what, text] of surfaces) {
    const hits = I.privacyScan(text, { tempRoot, sids: sidList });
    assert.equal(hits.tempRoot, 0, what + ' leaks the TEMP root (' + path.basename(journal) + ')');
    assert.equal(hits.driveLiterals, 0, what + ' carries a drive-letter literal outside the whitelist');
    assert.equal(hits.sid, 0, what + ' leaks a raw sid');
    assert.equal(hits.rawPaths, 0, what + ' leaks a raw path');
    assert.equal(text.toLowerCase().includes(tempRoot.toLowerCase()), false, what + ' leaks the realpath TEMP root');
    assert.equal(text.includes(ROOT), false, what + ' leaks the work directory');
    // 白名单那两条合成常量是**允许**的：不这么写，「一个盘符都不许」会把身份根也判成泄漏。
    const driveToks = text.match(/[A-Za-z]:[\\/]/g) || [];
    for (const tok of driveToks) {
      assert.equal([I.REDACTED_LOG, I.IDENTITY_ROOT, 'D:/synthetic/echo-feed/'].some((w) => tok.toLowerCase().indexOf(w.toLowerCase()) === 0), true, what + ' has an unexpected drive token ' + tok);
    }
  }
  // journal 本身也得能被读回（隐私断言不能建立在「文件是坏的」之上）
  const spawnLines = journalLines(journal);
  assert.equal(spawnLines[0].type, 'header');
  assert.equal(spawnLines[spawnLines.length - 1].type, 'summary');
});

// ── ⑩ 隐私：journal / 清单 / 库 都不带本机路径与原始 sid ──────────────────
check('journal text carries no TEMP root, no drive letter outside the whitelist, no raw sid', () => {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const files = [mainJournal, path.join(ROOT, 'reasoning-journal.jsonl'), path.join(ROOT, 'mixed-journal.jsonl')];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    assert.equal(text.toLowerCase().includes(tempRoot.toLowerCase()), false, 'journal leaks the TEMP root: ' + path.basename(f));
    assert.equal(text.includes(ROOT), false);
    const drive = text.match(/[A-Za-z]:[\\/]/g) || [];
    assert.equal(drive.length, 0, 'journal carries a drive-letter literal: ' + path.basename(f));
    for (const sid of new Set(SIDS)) assert.equal(text.includes(sid), false, 'journal leaks the raw sid ' + sid);
  }
});

check('DB rows carry no local path; the raw sid survives only in pointer columns', () => {
  withDb(mainDb, (s) => {
    const findings = I.privacyScan(JSON.stringify(s.db.prepare('SELECT * FROM echo_index_sources').all()), { tempRoot: os.tmpdir() });
    assert.equal(findings.tempRoot, 0);
    // log 列全部等于脱敏 token
    for (const row of s.db.prepare('SELECT log FROM echo_words').all()) assert.equal(row.log, I.REDACTED_LOG);
    for (const row of s.db.prepare('SELECT log FROM echo_summaries').all()) assert.equal(row.log, I.REDACTED_LOG);
    // cursor feed 的键不是路径（生产索引里那通常是「会话名.jsonl」）
    for (const row of s.db.prepare('SELECT cursor_json FROM echo_index_sources').all()) {
      const cursor = JSON.parse(row.cursor_json);
      for (const key of Object.keys(cursor.feed.files)) assert.equal(key, I.REDACTED_LOG);
    }
    // 本机生产索引目录一个字都不该进库
    const dump = JSON.stringify(s.db.prepare('SELECT * FROM echo_index_sources').all()) + JSON.stringify(s.db.prepare('SELECT full_json FROM echo_summaries').all());
    assert.equal(dump.includes('D:/AI/memory/hub/index'), false);
  });
});

// ── ⑪ 端到端：库层完整性 + 帧表没被动过 ──────────────────────────────────
check('frame_index is untouched by a full run (rows seeded before, identical after)', () => {
  const snap = writeSnapshot('frames', [makeSource({ namespace: 'log', sid: 'session-frames', words: [{ seq: 1, text: 'hello frame' }] })]);
  const db = makeDb('frames');
  withDb(db, (s) => {
    const before = echoRowCount(s.db, 'frame_index');
    const run = I.importSnapshot(snap, db, path.join(ROOT, 'frames-journal.jsonl'), { generation: 1, builtAt: T });
    assert.equal(run.ok, true);
    assert.equal(run.frameIndex.before, before);
    assert.equal(run.frameIndex.after, before);
    assert.equal(echoRowCount(s.db, 'frame_index'), before);
    assert.equal(run.integrity.ok, true);
    assert.deepEqual(run.problems, []);
  });
});

// ── ⑪b journal 时序：逐源**落盘**（batch 2 item 5）──────────────────────
// 判据不是「跑完之后 journal 里有几行」—— 那只证明最后写全了。
// 判据是：**第 2 个源开始干活的那一刻**，第 1 个源的行已经在盘上了。
// 拦截点：keeper 在每源开头 mkdirSync(root/source-<i>) —— 那就是「这个源开始了」。
check('source 0 is already on disk when source 1 starts (intercepted at the per-source directory)', () => {
  const snap = writeSnapshot('timing', [
    makeSource({ namespace: 'log', sid: 'session-timing-a', words: [{ seq: 1, text: 'a' }] }),
    makeSource({ namespace: 'v4log', sid: 'session-timing-b', words: [{ seq: 2, text: 'b' }] }),
  ]);
  const db = makeDb('timing');
  const journal = path.join(ROOT, 'timing-journal.jsonl');
  let atSource1 = null;
  const hook = hookFs('mkdirSync', (origin, state, args) => {
    const p = args[0];
    if (atSource1 === null && typeof p === 'string' && p.endsWith('source-1')) {
      atSource1 = fs.existsSync(journal) ? fs.readFileSync(journal, 'utf8') : '';
    }
    return origin.apply(fs, args);
  });
  let run;
  try { run = I.importSnapshot(snap, db, journal, { generation: 1, builtAt: T }); } finally { hook.restore(); }
  assert.equal(run.ok, true);
  assert.notEqual(atSource1, null, 'the mkdir hook must fire for source 1 — otherwise this check proves nothing');
  const seen = atSource1.split('\n').filter(Boolean);
  assert.equal(seen.length, 2, 'header + source 0 outcome must already be on disk (got ' + seen.length + ' lines)');
  const first = JSON.parse(seen[1]);
  assert.equal(first.type, 'outcome');
  assert.equal(first.index, 0);
  assert.equal(first.outcome, 'IMPORTED');
  assert.equal(first.committedRows, 1);
  assert.equal(atSource1.includes('"index":1'), false, 'source 1 must not be journaled before it starts');
  // 全部落定后的形状（header / 两条 outcome / summary）
  assert.deepEqual(journalLines(journal).map((l) => l.type), ['header', 'outcome', 'outcome', 'summary']);
});

check('a crash mid-run leaves a readable partial journal (header + source 0, no summary)', () => {
  const snap = writeSnapshot('crash', [
    makeSource({ namespace: 'log', sid: 'session-crash-a', words: [{ seq: 1, text: 'a' }] }),
    makeSource({ namespace: 'v4log', sid: 'session-crash-b', words: [{ seq: 2, text: 'b' }] }),
  ]);
  const db = makeDb('crash');
  const journal = path.join(ROOT, 'crash-journal.jsonl');
  let outcomeAppends = 0;
  const journalName = path.basename(journal);
  // 第 2 条 outcome 落盘时炸（模拟磁盘层面的硬故障）。keeper 的 abort 行仍然写得下去。
  // ★ 按**文件名**匹配，不按整串路径：keeper 传进来的是 realpath（TEMP 根的真实大小写
  //   可能与 os.tmpdir() 的写法不同），整串比较会让这个钩子静默不触发 —— 那正是上一版
  //   的错：断言「必须真的崩」，结果根本没崩，却也没人说。
  const hook = hookFs('appendFileSync', (origin, state, args) => {
    const p = args[0], data = String(args[1]);
    if (typeof p === 'string' && path.basename(p) === journalName && data.includes('"type":"outcome"')) {
      outcomeAppends += 1;
      // ★ 一旦坏就**一直是坏的**：keeper 的逐源 catch 会重试一次 finish()，
      //   只炸一次的话重试会成功、崩溃被吸收 —— 那就不叫「崩」，也就没测到部分 journal。
      if (outcomeAppends >= 2) { const e = new Error('synthetic hard failure while journaling source 1'); e.code = 'ENOSPC'; throw e; }
    }
    return origin.apply(fs, args);
  });
  let threw = null;
  try { I.importSnapshot(snap, db, journal, { generation: 1, builtAt: T }); } catch (e) { threw = e; } finally { hook.restore(); }
  assert.equal(outcomeAppends >= 2, true, 'the append hook must actually fire twice (otherwise this check proves nothing)');
  assert.notEqual(threw, null, 'the run must actually crash (otherwise the partial-journal claim is untested)');
  assert.equal(String(threw.code), 'ENOSPC');
  const text = fs.readFileSync(journal, 'utf8');
  const lines = text.split('\n').filter(Boolean);
  // 每一行都必须能读 —— 「部分 journal」不等于「坏 journal」。
  for (const line of lines) { const parsed = JSON.parse(line); assert.equal(typeof parsed.type, 'string'); }
  assert.equal(lines[0].startsWith('{"type":"header"'), true, 'the header must survive the crash');
  assert.equal(text.includes('"index":0'), true, 'source 0 must be in the partial journal');
  assert.equal(text.includes('"type":"summary"'), false, 'a crashed run must not pretend to have a summary');
  const kinds = lines.map((l) => JSON.parse(l).type);
  assert.deepEqual(kinds, ['header', 'outcome', 'abort'], 'partial journal shape: ' + JSON.stringify(kinds));
  const abort = JSON.parse(lines[lines.length - 1]);
  assert.equal(abort.committedSources >= 1, true, 'the abort line must still report how much landed');
  // 崩之前已提交的源确实在库里（「部分 journal」说的是进度，不是回滚）
  const landed = withDb(db, (s) => listEchoSources(s.db).length);
  assert.equal(landed >= 1, true, 'the crash must not roll back what was already committed');
  assert.equal(JSON.parse(lines[1]).committedRows, 1, 'source 0 reported its committed row count before the crash');
});

// ── ⑫ 扫描器自己也得有牙（否则「扫过、没问题」是空话）───────────────────
check('privacyScan detects the TEMP root, foreign drive literals and sids it is given', () => {
  const tempRoot = fs.realpathSync(os.tmpdir());
  assert.equal(I.privacyScan('{"log":"' + tempRoot + '/x.jsonl"}', { tempRoot }).tempRoot, 1);
  assert.equal(I.privacyScan('{"log":"C:/Users/pc/secret/session-x.jsonl"}', { tempRoot }).driveLiterals, 1);
  assert.equal(I.privacyScan('{"session":"session-canary"}', { tempRoot, sid: 'session-canary' }).sid, 1);
  // 白名单里的两条合成常量必须放行，否则身份根自己就过不了自己的扫描。
  assert.equal(I.privacyScan('{"sourcePath":"' + I.sourceIdentityFor('log', 'x') + '"}', { tempRoot }).driveLiterals, 0);
  assert.equal(I.privacyScan('{"log":"' + I.REDACTED_LOG + '"}', { tempRoot }).driveLiterals, 0);
});

// ── ⑬ 正文列放行 sid；承载路径/身份的列一格不放（batch 2 item 1）──────────
check('a message body that quotes a session id imports cleanly: text / summary / FTS are content, not identity', () => {
  const sid = 'session-body-quote';
  const snap = writeSnapshot('body-sid', [
    makeSource({
      namespace: 'v4log', sid,
      words: [{ seq: 4, text: 'per the earlier note see log:' + sid + '#seq=7 for the whole thread' }],
      summaries: [{ id: 'cmp-body-sid', summary: 'recap of ' + sid + ', which settled the question' }],
    }),
  ]);
  const db = makeDb('body-sid');
  const run = I.importSnapshot(snap, db, path.join(ROOT, 'body-sid-journal.jsonl'), { generation: 1, builtAt: T });
  assert.equal(run.ok, true, 'a body quoting a sid is not a privacy violation: ' + JSON.stringify(run.problems));
  assert.deepEqual(run.problems, []);
  assert.equal(run.problems.some((p) => p.kind === 'privacy'), false);
  const id = I.echoSourceIdForSource('v4log', sid);
  withDb(db, (s) => {
    // 正文**真的**带着那个 sid 进了库 —— 否则「没有 finding」也可能只是「根本没写进去」。
    const w = s.db.prepare('SELECT text FROM echo_words WHERE echo_source_id = ?').get(id);
    assert.equal(w.text.includes(sid), true, 'the body must keep the sid it quoted');
    const wf = s.db.prepare('SELECT raw_text FROM echo_words_fts WHERE echo_source_id = ?').get(id);
    assert.equal(wf.raw_text.includes(sid), true, 'the FTS mirror of the body must keep it too');
    const sum = s.db.prepare('SELECT summary FROM echo_summaries WHERE echo_source_id = ?').get(id);
    assert.equal(sum.summary.includes(sid), true);
    const sf = s.db.prepare('SELECT raw_text FROM echo_summaries_fts WHERE echo_source_id = ?').get(id);
    assert.equal(sf.raw_text.includes(sid), true);
  });
});

check('the same sid in echo_words.log IS a privacy finding (the log column stays strict)', () => {
  const sid = 'session-log-tamper';
  const mk = () => makeSource({ namespace: 'log', sid, words: [{ seq: 1, text: 'body text' }] });
  const snap = writeSnapshot('log-tamper', [mk()]);
  const db = makeDb('log-tamper');
  const first = I.importSnapshot(snap, db, path.join(ROOT, 'log-tamper-1.jsonl'), { generation: 1, builtAt: T });
  assert.equal(first.ok, true);
  const id = I.echoSourceIdForSource('log', sid);
  // 把 sid 直接塞进**承载路径的那一列**（模拟「我们哪天把身份抄进了 log」）。
  withDb(db, (s) => s.db.prepare('UPDATE echo_words SET log = ? WHERE echo_source_id = ?').run('log:' + sid + '#seq=1', id));
  // 同 generation + 同一份快照 → ALREADY_CURRENT（不写行），但事后整库扫描仍然看得到那一列。
  const second = I.importSnapshot(snap, db, path.join(ROOT, 'log-tamper-2.jsonl'), { generation: 1, builtAt: T });
  assert.equal(second.outcomes[0].outcome, 'ALREADY_CURRENT');
  assert.equal(second.ok, false);
  const priv = second.problems.find((p) => p.kind === 'privacy');
  assert.notEqual(priv, undefined, 'a sid in a log column must be reported');
  const f = priv.findings.filter((x) => x.table === 'echo_words' && x.column === 'log');
  assert.equal(f.length >= 1, true, 'the finding must name echo_words.log: ' + JSON.stringify(priv.findings));
  assert.equal(f.some((x) => x.kind === 'sid'), true, 'the sid kind must be among them');
});

check('the same sid in echo_index_sources.source_path IS a privacy finding', () => {
  const sid = 'session-path-tamper';
  const mk = () => makeSource({ namespace: 'v4log', sid, words: [{ seq: 1, text: 'x' }] });
  const snap = writeSnapshot('path-tamper', [mk()]);
  const db = makeDb('path-tamper');
  const first = I.importSnapshot(snap, db, path.join(ROOT, 'path-tamper-1.jsonl'), { generation: 1, builtAt: T });
  assert.equal(first.ok, true);
  const id = I.echoSourceIdForSource('v4log', sid);
  withDb(db, (s) => s.db.prepare('UPDATE echo_index_sources SET source_path = ? WHERE echo_source_id = ?').run('D:/elsewhere/' + sid, id)); // 库层 CHECK 要求 path 是绝对形，所以给一个绝对形；重点是它带着 sid
  const second = I.importSnapshot(snap, db, path.join(ROOT, 'path-tamper-2.jsonl'), { generation: 1, builtAt: T });
  // 两个判据同时响：身份被改（STORED_IDENTITY_MISMATCH）+ 那一列带 sid（privacy）
  assert.equal(second.outcomes[0].outcome, 'FAILED');
  assert.equal(second.outcomes[0].code, 'STORED_IDENTITY_MISMATCH');
  const priv = second.problems.find((p) => p.kind === 'privacy');
  assert.notEqual(priv, undefined, 'a sid in source_path must be reported');
  // ★ source_path 是**同时**受两把尺子管的列：路径式判据先报一条，sid 判据再报一条。
  //   这里两条都要 —— 只要 sid 那条在，就说明「sid 出现在 source_path 里算问题」这条判据活着。
  const f = priv.findings.filter((x) => x.table === 'echo_index_sources' && x.column === 'source_path');
  assert.equal(f.length >= 1, true, 'the finding must name echo_index_sources.source_path: ' + JSON.stringify(priv.findings));
  assert.equal(f.some((x) => x.kind === 'sid'), true, 'the sid kind must be among them: ' + JSON.stringify(f));
});

check('REACHABILITY NOTE — manifest log token / journal line: the sid judgment exists, no fixture can feed it one', () => {
  // 这两处的判据就是 privacyScan 的 sid 计数（assertManifestClean 与 assertClean 都调它）：
  const sid = 'session-seam-note';
  const tempRoot = fs.realpathSync(os.tmpdir());
  assert.equal(I.privacyScan('{"log":"log:' + sid + '#seq=1"}', { tempRoot, sids: [sid] }).sid, 1,
    'a manifest log token carrying a sid is a finding by the same predicate');
  assert.equal(I.privacyScan('{"type":"outcome","detail":{"message":"' + sid + '"}}', { tempRoot, sids: [sid] }).sid, 1,
    'a journal line carrying a sid is a finding by the same predicate');
  // 正方向（实测）：真正产出的 journal 里一个 sid 都没有。
  for (const f of [mainJournal, path.join(ROOT, 'body-sid-journal.jsonl')]) {
    assert.equal(I.privacyScan(fs.readFileSync(f, 'utf8'), { tempRoot, sids: [sid] }).sid, 0);
  }
  // ★ 字段级调用点**不可达**：feed 把每一行的 log 都换成 REDACTED_LOG 之后才交给 builder
  //   （清单里的 log 记号因此永远是常量），而 journal 行里唯一的自由文本 entry.detail 在
  //   写入前已过 journalSafeMessage —— 它用的就是同一个 sidScan。所以任何 fixture 都无法
  //   让那两处真的带一个 sid 进去；能造出来的只有「改代码」。这条如实标 SKIP，不冒充通过。
  return SKIP;
});

// ── ⑭ 每个失败码的反向对照（batch 2 item 3）──────────────────────────────
check('MANIFEST_MUTATED_AFTER_BUILD: one byte changed between builder and importer is caught', () => {
  const snap = writeSnapshot('mutated', [makeSource({ namespace: 'log', sid: 'session-mutated', words: [{ seq: 1, text: 'x' }] })]);
  const db = makeDb('mutated');
  // 拦截点：keeper 读清单字节那一次（它正是 sha 比对的对象）。
  const hook = hookFs('readFileSync', (origin, state, args) => {
    const p = args[0];
    const buf = origin.apply(fs, args);
    if (typeof p === 'string' && p.endsWith('manifest.json') && Buffer.isBuffer(buf)) return Buffer.concat([buf, Buffer.from(' ')]);
    return buf;
  });
  let run;
  try { run = I.importSnapshot(snap, db, path.join(ROOT, 'mutated-journal.jsonl'), { generation: 1, builtAt: T }); } finally { hook.restore(); }
  assert.equal(hook.state.calls > 0, true);
  assert.equal(run.failed, 1);
  assert.equal(run.outcomes[0].outcome, 'FAILED');
  assert.equal(run.outcomes[0].code, 'MANIFEST_MUTATED_AFTER_BUILD');
  assert.equal(withDb(db, (s) => listEchoSources(s.db).length), 0);
  // 正方向对照：同一份快照、不拦 —— 导入成功。这条断言不是恒红的。
  const clean = I.importSnapshot(snap, makeDb('mutated-clean'), path.join(ROOT, 'mutated-clean.jsonl'), { generation: 1, builtAt: T });
  assert.equal(clean.ok, true);
});

check('STORED_IDENTITY_MISMATCH: a stored source_path that is not the derived identity fails the source', () => {
  const snap = writeSnapshot('stored', [makeSource({ namespace: 'v4log', sid: 'session-stored', words: [{ seq: 1, text: 'x' }] })]);
  const db = makeDb('stored');
  // 库里那一行被别的路径改过（触发器 = 库层面的 fixture，不是改 keeper）。
  addTrigger(db, "CREATE TRIGGER synth_store_tamper AFTER INSERT ON echo_index_sources BEGIN UPDATE echo_index_sources SET source_path = NEW.source_path || '/tampered' WHERE echo_source_id = NEW.echo_source_id; END;");
  const run = I.importSnapshot(snap, db, path.join(ROOT, 'stored-journal.jsonl'), { generation: 1, builtAt: T });
  assert.equal(run.outcomes[0].outcome, 'FAILED');
  assert.equal(run.outcomes[0].code, 'STORED_IDENTITY_MISMATCH');
  assert.equal(run.ok, false);
});

check('ACCOUNTING_MISMATCH: a DB that lost a row under an ALREADY_CURRENT receipt is caught by the keeper', () => {
  // ★ 为什么走 ALREADY_CURRENT 这条路：importer 在自己的事务里**写完就核**（数不符 →
  //   IMPORT_VERIFY_FAILED），所以在写入路径上做手脚，先响的是它 —— 那是它对，不是 keeper。
  //   而 ALREADY_CURRENT 分支的 counts 是「从文件重算」的，**不核库**；keeper 才是那一道
  //   把「回执自报」与「库里实况」两处独立取值对起来的闸门。要考 keeper，就得走这里。
  const sid = 'session-acct';
  const mk = () => makeSource({ namespace: 'log', sid, words: [{ seq: 1, text: 'x' }] });
  const snap = writeSnapshot('acct', [mk()]);
  const db = makeDb('acct');
  const first = I.importSnapshot(snap, db, path.join(ROOT, 'acct-1.jsonl'), { generation: 1, builtAt: T });
  assert.equal(first.ok, true);
  const id = I.echoSourceIdForSource('log', sid);
  // 库层面把那一行正文拿掉（FTS 里还留着 —— 这正是「两处取值不一致」的真实形状）
  withDb(db, (s) => s.db.prepare('DELETE FROM echo_words WHERE echo_source_id = ? AND seq = 1').run(id));
  assert.equal(withDb(db, (s) => Number(s.db.prepare('SELECT COUNT(*) AS n FROM echo_words WHERE echo_source_id = ?').get(id).n)), 0);
  const second = I.importSnapshot(snap, db, path.join(ROOT, 'acct-2.jsonl'), { generation: 1, builtAt: T });
  assert.equal(second.outcomes[0].outcome, 'FAILED');
  assert.equal(second.outcomes[0].code, 'ACCOUNTING_MISMATCH');
  assert.equal(second.ok, false);
  // 回执那侧仍然说 1 行（它数的是文件），库里是 0 —— 两个数都在 journal 里，事后能对。
  assert.equal(second.outcomes[0].receipt.counts.words, 1);
  assert.equal(second.outcomes[0].committedRows, 0);
});

check('BUILD_EMPTY_GENERATION: a source whose only row is a non-chat role is refused by the builder', () => {
  const snap = writeSnapshot('empty-gen', [
    makeSource({ namespace: 'v4log', sid: 'session-empty-gen', words: [{ seq: 1, text: 'system banner', role: 'system', kind: 'system' }] }),
  ]);
  const db = makeDb('empty-gen');
  const run = I.importSnapshot(snap, db, path.join(ROOT, 'empty-gen-journal.jsonl'), { generation: 1, builtAt: T });
  assert.equal(run.outcomes[0].outcome, 'FAILED');
  assert.equal(run.outcomes[0].code, 'BUILD_EMPTY_GENERATION');
  assert.equal(withDb(db, (s) => listEchoSources(s.db).length), 0);
});

check('TEMP_ONLY: any path that resolves outside os.tmpdir() is refused before anything is written', () => {
  const snap = writeSnapshot('temp-only', [makeSource({ namespace: 'log', sid: 'session-temp-only', words: [{ seq: 1, text: 'x' }] })]);
  const db = makeDb('temp-only');
  // ★ 找一个**确实在 TEMP 外面**的现存文件。不能用 HERE 自己：自检被复制进 TEMP 跑时
  //   （item 11 的变异证明就这么跑），HERE 也在 TEMP 里，这条断言会静默改变含义
  //   —— 上一版就是这么坏掉的：以为在测「外面」，实际测的是「一个不是 JSON 的文件」。
  const outside = outsideTempFile();
  assert.notEqual(outside, null, 'this machine must have at least one readable file outside os.tmpdir()');
  assert.equal(fs.realpathSync(outside).toLowerCase().startsWith(fs.realpathSync(os.tmpdir()).toLowerCase()), false);
  const journalA = path.join(ROOT, 'temp-only-a.jsonl');
  const errA = expectCode(() => I.importSnapshot(outside, db, journalA, { generation: 1, builtAt: T }), 'TEMP_ONLY');
  assert.match(String(errA.message), /os\.tmpdir\(\)/);
  assert.equal(fs.existsSync(journalA), false);
  // db 侧同理（snapshot 合法、db 在外面）
  const journalB = path.join(ROOT, 'temp-only-b.jsonl');
  expectCode(() => I.importSnapshot(snap, outside, journalB, { generation: 1, builtAt: T }), 'TEMP_ONLY');
  assert.equal(fs.existsSync(journalB), false);
  // 阳性对照：同样的输入路径规则下，TEMP 里的那份导入成功。
  const ok = I.importSnapshot(snap, db, path.join(ROOT, 'temp-only-c.jsonl'), { generation: 1, builtAt: T });
  assert.equal(ok.ok, true);
});

check('REACHABILITY NOTE — BUILDER_IDENTITY_MISMATCH / RECEIPT_IDENTITY_MISMATCH cannot be produced by any fixture', () => {
  // 三处比较的两个端，都是**同一个纯函数、同一个输入**：
  //   builder  : echoSourceIdFor(sourcePath, ECHO_INDEX_VERSION)   ← sourcePath 就是 keeper 传进去的那一个
  //   receipt  : echoSourceIdFor(manifest.sourcePath, manifest.version) ← 刚被 sha 验过的那份清单
  //   keeper   : echoSourceIdFor(id.sourcePath, SOURCE_VERSION)
  // 因此要它们不等，只能改代码 —— 那正是 item 11 的变异证明在做的事。
  assert.equal(ECHO_INDEX_VERSION, I.SOURCE_VERSION, 'builder and keeper must derive identity with the same version string');
  assert.equal(echoSourceIdFor(I.sourceIdentityFor('log', 'session-shared'), ECHO_INDEX_VERSION),
    I.echoSourceIdForSource('log', 'session-shared'), 'same (path, version) must give the same id on both sides');
  // 主流程里回执 id / 清单 id / keeper id 三者实测相等（这条是它们在真跑里的对照）。
  for (const o of mainRun.outcomes) assert.equal(o.echoSourceId, I.echoSourceIdForSource(o.namespace, 'session-shared'));
  // ★ 如实标 SKIP：这两个码在当前实现下**不可达**（不是没测到，是结构上造不出来）。
  //   要用一条 fixture 造出来，只能先改 keeper —— 那就不是「测它」而是「绕过它」。
  return SKIP;
});

// ── ⑭b 身份与机器无关；generation 与内容各自独立（batch 2 item 6）───────────
check('two snapshots that differ only in log/ws get ONE id and ONE stored source_path row', () => {
  const mk = (log, ws) => makeSource({ namespace: 'v4log', sid: 'session-portable-2', words: [{ seq: 5, text: 'portable' }], log, ws });
  const snapA = writeSnapshot('portable-a', [mk('D:/AI/memory/hub/index/sessions/p.v4.zst', 'ws-one')]);
  const snapB = writeSnapshot('portable-b', [mk('E:/other/machine/elsewhere/p.v4.zst', 'ws-two')]);
  assert.notEqual(sha(fs.readFileSync(snapA)), sha(fs.readFileSync(snapB)), 'the two snapshots really do differ');
  const db = makeDb('portable');
  const a = I.importSnapshot(snapA, db, path.join(ROOT, 'portable-a.jsonl'), { generation: 1, builtAt: T });
  const b = I.importSnapshot(snapB, db, path.join(ROOT, 'portable-b.jsonl'), { generation: 2, builtAt: T });
  assert.equal(a.outcomes[0].outcome, 'IMPORTED');
  assert.equal(b.outcomes[0].outcome, 'IMPORTED');
  // 同一个 id（身份只由 namespace + sid 决定），但数据变了 → 清单 sha 必须变
  assert.equal(a.outcomes[0].echoSourceId, b.outcomes[0].echoSourceId);
  assert.notEqual(a.outcomes[0].manifestSha256, b.outcomes[0].manifestSha256);
  assert.equal(a.outcomes[0].sourcePathHash, b.outcomes[0].sourcePathHash);
  const rows = withDb(db, (s) => s.db.prepare('SELECT echo_source_id, source_path, namespace, generation FROM echo_index_sources').all());
  // ★ 「同一行」：另一台机器上的同一个会话不是第二个来源 —— 库里只能有一行。
  assert.equal(rows.length, 1, 'one row, not two');
  assert.equal(rows[0].echo_source_id, a.outcomes[0].echoSourceId);
  assert.equal(rows[0].source_path, I.sourceIdentityFor('v4log', 'session-portable-2'));
  assert.equal(rows[0].namespace, 'v4log');
  assert.equal(rows[0].generation, 2);
});

check('the same sid under v3 and v4 is two different sources (namespace is part of identity)', () => {
  const db = makeDb('ns-split');
  const snap = writeSnapshot('ns-split', [
    makeSource({ namespace: 'log', sid: 'session-ns-split', words: [{ seq: 1, text: 'legacy' }] }),
    makeSource({ namespace: 'v4log', sid: 'session-ns-split', words: [{ seq: 1, text: 'v4' }] }),
  ]);
  const run = I.importSnapshot(snap, db, path.join(ROOT, 'ns-split.jsonl'), { generation: 1, builtAt: T });
  assert.equal(run.ok, true);
  assert.equal(new Set(run.outcomes.map((o) => o.echoSourceId)).size, 2, 'v3 and v4 for one sid must not share an identity');
  assert.notEqual(I.echoSourceIdForSource('log', 'session-ns-split'), I.echoSourceIdForSource('v4log', 'session-ns-split'));
  const rows = withDb(db, (s) => s.db.prepare('SELECT namespace, source_path FROM echo_index_sources ORDER BY namespace').all());
  assert.equal(rows.length, 2);
  assert.equal(rows[0].source_path.startsWith(I.IDENTITY_ROOT + '/log/'), true);
  assert.equal(rows[1].source_path.startsWith(I.IDENTITY_ROOT + '/v4log/'), true);
});

check('manifest sha separates generation from content: a new generation moves it, new data moves it', () => {
  const mkSrc = (text) => makeSource({ namespace: 'v4log', sid: 'session-sha', words: [{ seq: 1, text }], summaries: [{ id: 'cmp-sha' }] });
  const sameA = writeSnapshot('sha-a', [mkSrc('same text')]);
  const sameB = writeSnapshot('sha-b', [mkSrc('same text')]);
  const diff = writeSnapshot('sha-c', [mkSrc('other text')]);
  assert.equal(sha(fs.readFileSync(sameA)), sha(fs.readFileSync(sameB)), 'the "same data" pair must really be the same bytes');
  assert.notEqual(sha(fs.readFileSync(sameA)), sha(fs.readFileSync(diff)));
  // ① 同一份数据 + 换 generation → sha 变（generation 单独就能推动它）
  const dbA = makeDb('shaA');
  const g1 = I.importSnapshot(sameA, dbA, path.join(ROOT, 'shaA-1.jsonl'), { generation: 1, builtAt: T });
  const g2 = I.importSnapshot(sameB, dbA, path.join(ROOT, 'shaA-2.jsonl'), { generation: 2, builtAt: T });
  assert.notEqual(g1.outcomes[0].manifestSha256, g2.outcomes[0].manifestSha256, 'same data + new generation -> new manifest sha');
  // ② 控制组：同一份数据 + 同一个 generation，在**另一个库**里 sha 一模一样
  //    —— 证明 sha 是内容的函数，不是「这次运行」的属性。
  const dbC = makeDb('shaC');
  const c1 = I.importSnapshot(sameA, dbC, path.join(ROOT, 'shaC-1.jsonl'), { generation: 1, builtAt: T });
  assert.equal(c1.outcomes[0].manifestSha256, g1.outcomes[0].manifestSha256);
  // ③ 不同数据 + **同一个** generation → sha 也变（内容单独就能推动它）
  const dbB = makeDb('shaB');
  const d1 = I.importSnapshot(diff, dbB, path.join(ROOT, 'shaB-1.jsonl'), { generation: 1, builtAt: T });
  assert.notEqual(d1.outcomes[0].manifestSha256, g1.outcomes[0].manifestSha256, 'different data under the SAME generation -> different manifest sha');
  // 而身份一直没动：sa 只挪「哪一版」，不挪「这是谁」
  assert.equal(d1.outcomes[0].echoSourceId, g1.outcomes[0].echoSourceId);
  assert.equal(g2.outcomes[0].echoSourceId, g1.outcomes[0].echoSourceId);
});

// ── ⑮ cmpId 两个计数器是两个量（batch 2 item 9）───────────────────────────
check('cmpId ambiguity counters are two DIFFERENT quantities: 3 sources sharing 2 cmpIds -> ids=2, rows=4', () => {
  const snap = writeSnapshot('cmp3', ['a', 'b', 'c'].map((tag, i) => makeSource({
    namespace: 'v4log', sid: 'session-cmp-' + tag,
    words: [{ seq: 10 + i, text: 'word ' + tag }],
    summaries: [{ id: 'cmp-alpha' }, { id: 'cmp-beta' }],
  })));
  const run = I.importSnapshot(snap, makeDb('cmp3'), path.join(ROOT, 'cmp3-journal.jsonl'), { generation: 1, builtAt: T });
  assert.equal(run.imported, 3);
  // ids = 有几个 cmpId 被多个源共用（本题 2 个：alpha、beta）
  assert.equal(run.risks.cmpIdAmbiguityIds, 2);
  // rows = 每个被共用 cmpId 的「多出来的拥有者」之和（3 源 × 2 个 cmpId，各多 2 家 = 4）
  assert.equal(run.risks.cmpIdAmbiguityRows, 4);
  assert.notEqual(run.risks.cmpIdAmbiguityIds, run.risks.cmpIdAmbiguityRows,
    'if these two were the same quantity this counter pair would be redundant');
  // 顺带把「数是这么数出来的」钉住：2 个 cmpId × (3-1) 个额外拥有者
  assert.equal(run.risks.cmpIdAmbiguityRows, 2 * 2);
});

// ── ⑯ 七个拒绝码：正反两面（batch 2 item 10）──────────────────────────────
check('NAMESPACE_MISMATCH: a namespace contradicting sourceVersion is refused; the consistent one imports', () => {
  const bad = makeSource({ namespace: 'log', sid: 'session-ns-bad', words: [{ seq: 1, text: 'x' }] });
  bad.namespace = 'v4log'; // sourceVersion 仍是 v3 → 矛盾
  expectRefusal('ns-bad', [bad], 'NAMESPACE_MISMATCH');
  const good = makeSource({ namespace: 'log', sid: 'session-ns-good', words: [{ seq: 1, text: 'x' }] });
  good.namespace = 'log';
  expectImports('ns-good', [good]);
});

check('WORKSPACE_MIXED: two workspaces inside one source row are refused; one workspace imports', () => {
  const mixed = makeSource({ namespace: 'log', sid: 'session-ws-bad', words: [{ seq: 1, text: 'a' }, { seq: 2, text: 'b' }], ws: 'ws-a' });
  mixed.words[1].ws = 'ws-b';
  expectRefusal('ws-bad', [mixed], 'WORKSPACE_MIXED');
  expectImports('ws-good', [makeSource({ namespace: 'log', sid: 'session-ws-good', ws: 'ws-a', words: [{ seq: 1, text: 'a' }, { seq: 2, text: 'b' }] })]);
});

check('WORD_KEY_DUPLICATE_IN_SOURCE: the same (session, seq) twice in one source is refused; distinct seqs import', () => {
  const dup = makeSource({ namespace: 'log', sid: 'session-wk-bad', words: [{ seq: 3, text: 'first' }, { seq: 3, text: 'second' }] });
  const err = expectRefusal('wk-bad', [dup], 'WORD_KEY_DUPLICATE_IN_SOURCE');
  assert.match(String(err.message), /session-wk-bad#3/);
  expectImports('wk-good', [makeSource({ namespace: 'log', sid: 'session-wk-good', words: [{ seq: 3, text: 'first' }, { seq: 4, text: 'second' }] })]);
});

check('SOURCE_ROW_INVALID: a non-object row is refused; a well-shaped row imports', () => {
  const bad = makeSource({ namespace: 'log', sid: 'session-row-bad', words: [{ seq: 1, text: 'x' }] });
  bad.words = [null];
  expectRefusal('row-bad', [bad], 'SOURCE_ROW_INVALID');
  expectImports('row-good', [makeSource({ namespace: 'log', sid: 'session-row-good', words: [{ seq: 1, text: 'x' }] })]);
});

check('SNAPSHOT_INVALID: a snapshot without a sources[] array is refused; an empty-but-valid one is not', () => {
  const badPath = path.join(ROOT, 'snap-bad.json');
  fs.writeFileSync(badPath, JSON.stringify({ sources: 'nope' }) + '\n', { flag: 'wx' });
  const db = makeDb('snap-bad');
  const journal = path.join(ROOT, 'snap-bad-journal.jsonl');
  expectCode(() => I.importSnapshot(badPath, db, journal, { generation: 1, builtAt: T }), 'SNAPSHOT_INVALID');
  assert.equal(fs.existsSync(journal), false);
  // 阳性对照：合法但**空**的快照（0 源）不是错误 —— 它是「什么都没发生」。
  const emptyPath = path.join(ROOT, 'snap-empty.json');
  fs.writeFileSync(emptyPath, JSON.stringify({ sources: [] }) + '\n', { flag: 'wx' });
  const run = I.importSnapshot(emptyPath, db, path.join(ROOT, 'snap-empty-journal.jsonl'), { generation: 1, builtAt: T });
  assert.equal(run.ok, true);
  assert.equal(run.sourceCount, 0);
  assert.equal(run.imported, 0);
});

check('SNAPSHOT_NOT_UTF8: bytes that are not valid UTF-8 are refused before parsing', () => {
  const badPath = path.join(ROOT, 'snap-notutf8.json');
  fs.writeFileSync(badPath, Buffer.from([0x7b, 0xff, 0xfe, 0x7d]), { flag: 'wx' });
  const db = makeDb('snap-notutf8');
  const journal = path.join(ROOT, 'snap-notutf8-journal.jsonl');
  expectCode(() => I.importSnapshot(badPath, db, journal, { generation: 1, builtAt: T }), 'SNAPSHOT_NOT_UTF8');
  assert.equal(fs.existsSync(journal), false);
  // 阳性对照：同样的形状、合法 UTF-8 —— 走到下一层校验（这里是合法的空快照）。
  const okPath = path.join(ROOT, 'snap-utf8.json');
  fs.writeFileSync(okPath, Buffer.from('{"sources":[]}\n', 'utf8'), { flag: 'wx' });
  assert.equal(I.importSnapshot(okPath, db, path.join(ROOT, 'snap-utf8-journal.jsonl'), { generation: 1, builtAt: T }).ok, true);
});

check('PATH_INVALID: a relative or missing path is refused; a real TEMP path is not', () => {
  const db = makeDb('path-inv');
  expectCode(() => I.importSnapshot('relative/snap.json', db, path.join(ROOT, 'pi-a.jsonl'), { generation: 1, builtAt: T }), 'PATH_INVALID');
  expectCode(() => I.importSnapshot(path.join(ROOT, 'does-not-exist.json'), db, path.join(ROOT, 'pi-b.jsonl'), { generation: 1, builtAt: T }), 'PATH_INVALID');
  assert.equal(fs.existsSync(path.join(ROOT, 'pi-a.jsonl')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'pi-b.jsonl')), false);
  const ok = I.importSnapshot(writeSnapshot('path-inv-ok', [makeSource({ namespace: 'log', sid: 'session-path-inv', words: [{ seq: 1, text: 'x' }] })]),
    db, path.join(ROOT, 'pi-ok.jsonl'), { generation: 1, builtAt: T });
  assert.equal(ok.ok, true);
});

// ── ⑰ check() 自己的 SKIP 通道（batch 2 item 8）────────────────────────────
check('check() records SKIP but NOT PASS, and the final count reflects the skips', () => {
  const before = results.length;
  const skipVerdict = check('synthetic skip probe', () => SKIP);
  assert.equal(skipVerdict, SKIP);
  const added = results.slice(before);
  assert.equal(added.length, 1, 'a skipped check must add exactly ONE record');
  assert.equal(added[0].kind, 'SKIP', 'a skip must not be recorded as PASS');
  assert.deepEqual(results.filter((r) => r.label === 'synthetic skip probe').map((r) => r.kind), ['SKIP']);
  check('synthetic pass probe', () => 42);
  assert.deepEqual(results.filter((r) => r.label === 'synthetic pass probe').map((r) => r.kind), ['PASS']);
  const c = countResults();
  assert.equal(c.total, results.length);
  assert.equal(c.pass, results.filter((r) => r.kind === 'PASS').length);
  assert.equal(c.skip, results.filter((r) => r.kind === 'SKIP').length);
  assert.equal(c.pass + c.skip, c.total, 'the printed counts must add up: no third bucket, no double counting');
  // 这条 check 自己的两条探针不许留进最终报表（它们是探针，不是覆盖）。
  results.length = before;
  assert.equal(countResults().total, before);
});

const final = countResults();
console.log(results.map((r) => r.kind + ' ' + r.label).join('\n'));
console.log(final.total + ' checks, ' + final.pass + ' passed, ' + final.skip + ' skipped (a skip is NOT a pass)');
