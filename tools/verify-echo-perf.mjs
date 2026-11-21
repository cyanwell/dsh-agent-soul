// 端到端验证：新实现（缓存矩阵）vs 旧实现（每次读库），同一查询向量逐条比对 + 计时。
// ★ 只读生产库；旧实现在这里照抄备份文件的算法复算，不改任何东西。
import { DatabaseSync } from 'node:sqlite';
import { searchWindowVectors } from '../src/db/echo-window-search.mjs';
import { searchEchoSourceVectors } from '../src/db/echo-vectors.mjs';
import { vectorCacheStats } from '../src/db/echo-vector-cache.mjs';

const DB = 'D:/AI/agent-soul/data/meta.sqlite';
const SRC = 'echo-7dc13d639f0d5236a0de9354b38e37d7';
const DIM = 512;

const db = new DatabaseSync(DB, { readOnly: true });
const wModel = db.prepare("SELECT model_key FROM echo_word_windows GROUP BY model_key LIMIT 1").get().model_key;
const vModel = db.prepare("SELECT model_key FROM echo_word_vectors GROUP BY model_key LIMIT 1").get().model_key;

function makeQuery(seed0) {
  const q = new Float32Array(DIM);
  let seed = seed0;
  for (let i = 0; i < DIM; i += 1) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; q[i] = (seed / 0x7fffffff) * 2 - 1; }
  return q;
}
const q = makeQuery(20261118);

function oldWindowSearch(db, qv, { echoSourceId, modelKey, limit = 10 }) {
  const model = db.prepare('SELECT * FROM echo_vector_models WHERE model_key=?').get(modelKey);
  const dim = Number(model.dimension);
  const rows = db.prepare('SELECT word_ord, window_ord, char_start, char_end, vector_dimension, vector_blob FROM echo_word_windows WHERE echo_source_id=? AND model_key=? ORDER BY word_ord, window_ord').all(echoSourceId, modelKey);
  const hashByWord = new Map();
  for (const r of db.prepare('SELECT word_ord, content_hash, session, seq, log FROM echo_words WHERE echo_source_id=?').all(echoSourceId)) hashByWord.set(Number(r.word_ord), r);
  let qn = 0; for (let i = 0; i < dim; i += 1) qn += qv[i] * qv[i];
  const qnorm = Math.sqrt(qn) || 1;
  const out = [];
  for (const row of rows) {
    const word = hashByWord.get(Number(row.word_ord));
    if (!word) continue;
    if (Number(row.vector_dimension) !== dim) throw Object.assign(new Error('stale'), { code: 'ECHO_WINDOW_STALE' });
    const raw = row.vector_blob;
    let vec;
    if (raw.byteOffset % 4 === 0 && raw.byteLength === dim * 4) vec = new Float32Array(raw.buffer, raw.byteOffset, dim);
    else { const copy = new Uint8Array(dim * 4); copy.set(raw.subarray(0, dim * 4)); vec = new Float32Array(copy.buffer); }
    let dot = 0, vn = 0;
    for (let i = 0; i < dim; i += 1) { const v = vec[i]; dot += qv[i] * v; vn += v * v; }
    out.push({ score: vn === 0 ? 0 : dot / (qnorm * Math.sqrt(vn)), ptr: 'log:' + word.session + '#seq=' + Number(word.seq), wordOrd: Number(row.word_ord), windowOrd: Number(row.window_ord), charStart: Number(row.char_start), charEnd: Number(row.char_end) });
  }
  out.sort((a, b) => b.score - a.score || a.ptr.localeCompare(b.ptr) || a.windowOrd - b.windowOrd);
  return { modelKey, granularity: 'sentence-window', scanned: out.length, results: out.slice(0, limit) };
}

function cmp(label, a, b) {
  const okLen = a.results.length === b.results.length;
  let same = 0;
  let firstDiff = null;
  for (let i = 0; i < Math.min(a.results.length, b.results.length); i += 1) {
    const x = a.results[i], y = b.results[i];
    const ok = x.score === y.score && x.ptr === y.ptr && x.wordOrd === y.wordOrd && x.windowOrd === y.windowOrd && x.charStart === y.charStart && x.charEnd === y.charEnd;
    if (ok) same += 1; else if (!firstDiff) firstDiff = { i, x, y };
  }
  console.log('  [' + label + '] 条数' + (okLen ? '相同' : '不同(' + a.results.length + ' vs ' + b.results.length + ')') + '  逐条完全一致 ' + same + '/' + b.results.length + '  scanned ' + a.scanned + ' vs ' + b.scanned);
  if (firstDiff) console.log('    首个差异 #' + firstDiff.i + '\n      新: ' + JSON.stringify(firstDiff.x) + '\n      旧: ' + JSON.stringify(firstDiff.y));
  return same === b.results.length && okLen;
}

console.log('=== 窗口层 ===');
const t0 = process.hrtime.bigint();
const nw = searchWindowVectors(db, Float32Array.from(q), { echoSourceId: SRC, modelKey: wModel, limit: 10 });
const tNewCold = Number(process.hrtime.bigint() - t0) / 1e6;
const t1 = process.hrtime.bigint();
const nw2 = searchWindowVectors(db, Float32Array.from(q), { echoSourceId: SRC, modelKey: wModel, limit: 10 });
const tNewWarm = Number(process.hrtime.bigint() - t1) / 1e6;
const t2 = process.hrtime.bigint();
const ow = oldWindowSearch(db, q, { echoSourceId: SRC, modelKey: wModel, limit: 10 });
const tOld = Number(process.hrtime.bigint() - t2) / 1e6;
const winOk = cmp('window top10 ', nw, ow);
console.log('  新（冷/建矩阵）' + tNewCold.toFixed(0) + 'ms   新（热）' + tNewWarm.toFixed(0) + 'ms   旧 ' + tOld.toFixed(0) + 'ms');
const nw100 = searchWindowVectors(db, Float32Array.from(q), { echoSourceId: SRC, modelKey: wModel, limit: 100 });
const ow100 = oldWindowSearch(db, q, { echoSourceId: SRC, modelKey: wModel, limit: 100 });
const winOk100 = cmp('window top100', nw100, ow100);

console.log('');
console.log('=== 词层 ===');
const t3 = process.hrtime.bigint();
const nv = searchEchoSourceVectors(db, q, { modelKey: vModel, echoSourceId: SRC, limit: 10 });
const tVNewCold = Number(process.hrtime.bigint() - t3) / 1e6;
const t4 = process.hrtime.bigint();
const nv2 = searchEchoSourceVectors(db, q, { modelKey: vModel, echoSourceId: SRC, limit: 10 });
const tVWarm = Number(process.hrtime.bigint() - t4) / 1e6;
console.log('  新（冷/建矩阵）' + tVNewCold.toFixed(0) + 'ms   新（热）' + tVWarm.toFixed(0) + 'ms');
console.log('  top5 score: ' + nv2.results.slice(0, 5).map((r) => r.score.toFixed(6)).join(', '));
const stable = JSON.stringify(nv.results) === JSON.stringify(nv2.results);
console.log('  冷/热两次结果一致: ' + (stable ? 'PASS' : 'FAIL'));

console.log('');
console.log('=== 缓存清单 ===');
console.log('  ' + JSON.stringify(vectorCacheStats()));

const allOk = winOk && winOk100 && stable;
console.log('');
console.log('=== 判定: ' + (allOk ? 'PASS' : 'FAIL') + ' ===');
console.log('  窗口层提速 ' + (tOld / tNewWarm).toFixed(1) + '×  (' + tOld.toFixed(0) + 'ms → ' + tNewWarm.toFixed(0) + 'ms)');
if (!allOk) process.exitCode = 1;
db.close();
