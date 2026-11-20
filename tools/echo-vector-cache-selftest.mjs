#!/usr/bin/env node
// 向量矩阵缓存 / 快照 / 失效 的自检（2026-11-18 加）
//
// ★ 为什么要它：这一层是本轮性能优化的核心（检索 10.5s → 0.26s），
//   而它引入的全是**看不见的约定**：快照的段偏移、对齐、指纹语义、缓存失效时机。
//   这些东西一旦漂了，症状是「检索结果悄悄变了」—— 最难查的那一类。
//   下面每条断言都对着一个我实际踩过的坑。
//
// ★ 只在 TEMP 里造库，绝不碰生产 data/。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openMetaStore } from '../src/db/store.mjs';
import { searchWindowVectors } from '../src/db/echo-window-search.mjs';
import { putWindowVectors } from '../src/db/echo-windows.mjs';
import { loadWindowMatrix, loadWordMatrix, invalidateVectorCache, vectorCacheStats, clearVectorCacheAll } from '../src/db/echo-vector-cache.mjs';
import { readSnapshot } from '../src/db/echo-vector-snapshot.mjs';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-vector-cache-selftest-'));
const DB = path.join(ROOT, 'meta.sqlite');
const DIM = 8;
const SRC = 'echo-cachetest';
let store = null;
let passed = 0;
const ok = (name, fn) => { fn(); passed += 1; console.log('PASS ' + name); };
const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const unitVector = (i) => { const v = new Array(DIM).fill(0); v[i % DIM] = 1; return v; };
const Q = (() => { const q = new Float32Array(DIM); q[0] = 1; return q; })();

function env(snap, strict, cache) {
  if (snap === undefined) delete process.env.AGENT_SOUL_ECHO_VECTOR_SNAPSHOT; else process.env.AGENT_SOUL_ECHO_VECTOR_SNAPSHOT = snap;
  if (strict === undefined) delete process.env.AGENT_SOUL_ECHO_VECTOR_STRICT; else process.env.AGENT_SOUL_ECHO_VECTOR_STRICT = strict;
  if (cache === undefined) delete process.env.AGENT_SOUL_ECHO_VECTOR_CACHE; else process.env.AGENT_SOUL_ECHO_VECTOR_CACHE = cache;
}

try {
  store = openMetaStore({ path: DB, mode: 'readwrite' });
  store.migrate();
  store.ensureReady();
  const db = store.db;
  const NOW = new Date().toISOString();

  // ── 造一个最小 ECHO 源：6 个词 × 2 个窗口 ─────────────────────────
  db.prepare([
    'INSERT INTO echo_index_sources (echo_source_id, source_path, source_version, namespace, generation, state,',
    '  cursor_seq, cursor_json, words_count, summaries_count, src_seq_count, source_sha256, source_bytes,',
    '  built_at, imported_at, importer) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  ].join(' ')).run(SRC, 'D:/synthetic/source', 'echo-index/1', 'log', 1, 'committed',
    0, '{"seq":0}', 6, 0, 0, sha('src'), 1024, NOW, NOW, 'echo-vector-cache-selftest');

  const words = [];
  for (let i = 0; i < 6; i += 1) {
    const text = 'word-' + i + '-内容';
    // 列全按真实 schema 给（src_line / t 也是 NOT NULL；漏了就 constraint failed）
    db.prepare('INSERT INTO echo_words (echo_source_id, word_ord, src_line, t, session, ws, seq, turn, log, role, kind, len, truncated, text, content_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(SRC, i, i + 1, '2026-11-18T00:00:00Z', 'sess-a', 'w', 100 + i, 0, 'log', 'assistant', 'text', text.length, 0, text, sha(text));
    words.push({ wordOrd: i, contentHash: sha(text) });
  }

  const spec = {
    modelId: 'cache-test', revision: 'r1', modelSha256: sha('m'), tokenizerSpec: 'tok',
    preprocessSpec: JSON.stringify({ queryPrefix: '', documentPrefix: '', maxInputChars: 1000, truncation: 'tail', skipInjected: true }),
    poolingSpec: 'mean', normalize: true, dimension: DIM, maxSeqLength: 512,
  };
  const reg = store.echoVectorRegister(spec);
  const modelKey = reg.modelKey;
  store.echoVectorPut(SRC, spec, words.map((w, i) => ({ wordOrd: w.wordOrd, contentHash: w.contentHash, vector: unitVector(i) })));

  const winRows = [];
  for (let i = 0; i < 6; i += 1) {
    for (let k = 0; k < 2; k += 1) {
      winRows.push({ wordOrd: i, windowOrd: k, charStart: k * 10, charEnd: k * 10 + 10, text: 'win-' + i + '-' + k, sourceContentHash: words[i].contentHash, vector: unitVector(i) });
    }
  }
  assert.ok(putWindowVectors(db, SRC, modelKey, DIM, winRows).written >= 12, '窗口向量写入');

  // ── 1. 库建 vs 快照读：逐位一致 ───────────────────────────────────
  env('off'); clearVectorCacheAll();
  const mDb = loadWindowMatrix(db, SRC, modelKey);
  assert.equal(mDb.fromSnapshot, undefined, '关掉快照时应从库建');

  env('on'); clearVectorCacheAll();
  loadWindowMatrix(db, SRC, modelKey);                  // 从库建 + 写快照
  clearVectorCacheAll();
  const mSnap = loadWindowMatrix(db, SRC, modelKey);     // 应命中快照
  ok('快照写得出、读得回，且逐位一致', () => {
    assert.equal(mSnap.fromSnapshot, true, '第三次应命中快照');
    assert.equal(mSnap.n, mDb.n);
    for (let i = 0; i < mDb.flat.length; i += 1) assert.equal(mSnap.flat[i], mDb.flat[i], 'flat[' + i + '] 逐位相同');
    for (let i = 0; i < mDb.n; i += 1) {
      assert.equal(mSnap.norms[i], mDb.norms[i], 'norms[' + i + ']');
      assert.equal(mSnap.wordOrd[i], mDb.wordOrd[i]);
      assert.equal(mSnap.windowOrd[i], mDb.windowOrd[i]);
      assert.equal(mSnap.charStart[i], mDb.charStart[i]);
      assert.equal(mSnap.charEnd[i], mDb.charEnd[i]);
      assert.equal(mSnap.seqs[i], mDb.seqs[i]);
      assert.equal(mSnap.sessionIds[i], mDb.sessionIds[i]);
    }
    assert.deepEqual(mSnap.sessions, mDb.sessions);
  });

  // ── 2. 检索结果与快照无关 ─────────────────────────────────────────
  env('off'); clearVectorCacheAll();
  const rNoSnap = searchWindowVectors(db, Float32Array.from(Q), { echoSourceId: SRC, modelKey, limit: 3 });
  env('on'); clearVectorCacheAll();
  const rSnap = searchWindowVectors(db, Float32Array.from(Q), { echoSourceId: SRC, modelKey, limit: 3 });
  ok('检索结果不因快照而变', () => {
    assert.deepEqual(rSnap.results, rNoSnap.results);
    assert.equal(rSnap.scanned, rNoSnap.scanned);
  });

  // ── 3. 身份/指纹对不上 → 拒用 ─────────────────────────────────────
  ok('快照身份对不上时拒绝使用（回库重建）', () => {
    assert.equal(readSnapshot(db, { kind: 'window', echoSourceId: 'echo-other', modelKey, fingerprint: '0|0' }, () => ({ n: 1 })), null, '源 id 不同');
    assert.equal(readSnapshot(db, { kind: 'window', echoSourceId: SRC, modelKey, fingerprint: '999|999#' }, () => ({ n: 1 })), null, '指纹不同');
    assert.equal(readSnapshot(db, { kind: 'word', echoSourceId: SRC, modelKey, fingerprint: 'x' }, () => ({ n: 1 })), null, '类型不同');
  });

  // ── 4. 词表变了 → 词矩阵快照作废 ─────────────────────────────────
  ok('词表新增一行会让词矩阵快照失效', () => {
    env('on'); clearVectorCacheAll();
    loadWordMatrix(db, SRC, modelKey);                  // 建 + 写快照
    clearVectorCacheAll();
    const v1 = loadWordMatrix(db, SRC, modelKey);
    assert.equal(v1.fromSnapshot, true, '先应命中快照');
    const fp1 = v1.wordFingerprint;
    const text = 'word-new-内容';
    db.prepare('INSERT INTO echo_words (echo_source_id, word_ord, src_line, t, session, ws, seq, turn, log, role, kind, len, truncated, text, content_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(SRC, 6, 7, '2026-11-18T00:00:00Z', 'sess-a', 'w', 999, 0, 'log', 'assistant', 'text', text.length, 0, text, sha(text));
    clearVectorCacheAll();
    const v2 = loadWordMatrix(db, SRC, modelKey);
    assert.notEqual(v2.wordFingerprint, fp1, '词表指纹必须变了');
    assert.equal(v2.fromSnapshot, undefined, '重建后不该带 fromSnapshot');
    db.prepare('DELETE FROM echo_words WHERE echo_source_id=? AND word_ord=?').run(SRC, 6);
  });

  // ── 5. 主动失效 ───────────────────────────────────────────────────
  ok('invalidateVectorCache 会清掉内存矩阵与快照', () => {
    env('on'); clearVectorCacheAll();
    loadWindowMatrix(db, SRC, modelKey);
    assert.ok(vectorCacheStats().length >= 1, '先有缓存');
    invalidateVectorCache(db, SRC);
    assert.equal(vectorCacheStats().length, 0, '失效后内存缓存为空');
    const dir = path.join(ROOT, 'vector-cache');
    const left = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.bin')) : [];
    assert.equal(left.length, 0, '失效后快照文件也该没了');
  });

  // ── 6. 严格模式 = 每次回库 ────────────────────────────────────────
  ok('严格模式下每次重建（不吃缓存也不吃快照）', () => {
    clearVectorCacheAll(); env('on', '1');
    const a = loadWindowMatrix(db, SRC, modelKey);
    const b = loadWindowMatrix(db, SRC, modelKey);
    assert.notEqual(a, b, '严格模式两次是不同对象');
    assert.equal(a.fromSnapshot, undefined);
    env('on', undefined);
  });

  // ── 7. 缓存关闭 = 完全退回旧路径 ─────────────────────────────────
  ok('缓存被关掉时退回「每次回库」', () => {
    clearVectorCacheAll(); env('on', undefined, 'off');
    const a = loadWindowMatrix(db, SRC, modelKey);
    const b = loadWindowMatrix(db, SRC, modelKey);
    assert.notEqual(a, b);
    env('on', undefined, undefined);
  });

  // ── 8. 损坏的快照必须被拒 ─────────────────────────────────────────
  ok('截断/乱码的快照一律拒用而不是崩', () => {
    clearVectorCacheAll(); env('on');
    loadWindowMatrix(db, SRC, modelKey);   // 保证有快照
    const dir = path.join(ROOT, 'vector-cache');
    const name = fs.readdirSync(dir).find((x) => x.startsWith('window-'));
    const f = path.join(dir, name);
    const buf = fs.readFileSync(f);
    fs.writeFileSync(f, buf.subarray(0, Math.floor(buf.length / 2)));   // 截断
    clearVectorCacheAll();
    const m = loadWindowMatrix(db, SRC, modelKey);
    assert.equal(m.fromSnapshot, undefined, '坏快照 → 回库重建');
    assert.ok(m.n > 0, '仍然拿到了真实矩阵');
  });

  // ── 9. 缓存开/关 top-1 完全一致 ───────────────────────────────────
  ok('缓存开/关 top-1 完全一致', () => {
    clearVectorCacheAll(); env('off', undefined, 'off');
    const a = searchWindowVectors(db, Float32Array.from(Q), { echoSourceId: SRC, modelKey, limit: 1 });
    clearVectorCacheAll(); env('on', undefined, undefined);
    const b = searchWindowVectors(db, Float32Array.from(Q), { echoSourceId: SRC, modelKey, limit: 1 });
    assert.deepEqual(b.results, a.results);
    assert.equal(a.results[0].score, 1, 'unit vector 自比 = 1');
  });

  console.log(passed + ' vector-cache checks passed');
} finally {
  try { if (store) store.close(); } catch { /* 忽略 */ }
  env(undefined, undefined, undefined);
  fs.rmSync(ROOT, { recursive: true, force: true });
  assert.equal(fs.existsSync(ROOT), false, 'TEMP root removed');
}
