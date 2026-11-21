// 句子级窗口向量检索 —— 第二套向量层的读面（v12）。
//
// ★ 它与长文本检索（searchEchoSourceVectors）的分工，写在这里免得混：
//   长文本（echo_word_vectors）：一个词一个向量。**问「哪一段在讲这件事」**——
//     召回一片泛泛相关的东西，适合结论提炼、话题归类。
//   窗口（echo_word_windows）：一句话/一小段一个向量。**问「哪一句真的说了这件事」**——
//     召回更锐利，适合快速精确定位，命中后能直接落到原文的字符区间。
//
// ★ 命中要能回原文：本模块只回 char_start/char_end + 门牌，**不回正文**。
//   正文必须走账本那条路（log:/v4log: 指针），否则这里就成了第二份真相。
//
// ★★★ 2026-11-18 性能（实测，不是推测）：
//   旧实现每次检索都从 SQLite 重读整张向量表 —— JOIN 7,408ms + 建 words Map 3,306ms
//   + 点积 775ms + 全排序 274ms ≈ 10.5 秒。**99% 的时间花在重复搬运同一份数据**。
//   （mmap_size / cache_size 都实测无效：瓶颈是 node:sqlite 每行构造 JS 对象、
//     每个 BLOB 构造一个 Uint8Array —— 21 万次分配，不是磁盘。）
//   现在向量矩阵由 echo-vector-cache.mjs 常驻内存：首次 ~8.7s，之后 **~0.3s**。

import { loadWindowMatrix, assertFreshRows, readEchoAuthority } from './echo-vector-cache.mjs';

const MSG = {
  MODEL_REQUIRED: 'modelKey is required',
  MODEL_NOT_FOUND: 'window vector model spec is not stored',
  VECTOR_DIM: 'query vector dimension does not match the stored model',
  STALE: 'stored window vector is stale (source word changed) — rebuild before searching',
  CORRUPT: 'stored window vector blob is corrupt',
  INCOMPLETE: 'selected ECHO source has no window vectors for this model',
};

/**
 * 在常驻矩阵上取 top-limit（返回下标数组，已按口径排好）。
 *
 * ★ 为什么用「部分插入」而不是「全排序再切片」：
 *   21.1 万条构造对象 + 全排序实测 274ms；只要前 10~100 条时绝大多数元素
 *   根本进不了答案。部分插入实测 5ms。
 * ★ 排序口径与旧实现**逐字一致**：score 降序 → ptr 升序 → windowOrd 升序。
 *   相等项插在**后面**，以复现 V8 稳定排序保留的原始（word_ord, window_ord）次序。
 *
 * @param {number} n          候选总数
 * @param {number} limit      要几条
 * @param {Float64Array} scores 每个候选的分数
 * @param {(a:number,b:number)=>number} compareK 负= a 排在 b 前面
 */
function topKIndices(n, limit, scores, compareK) {
  const out = [];
  for (let k = 0; k < n; k += 1) {
    if (out.length === limit) {
      if (compareK(k, out[out.length - 1]) >= 0) continue;
    }
    let lo = 0;
    let hi = out.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compareK(k, out[mid]) < 0) hi = mid; else lo = mid + 1;
    }
    out.splice(lo, 0, k);
    if (out.length > limit) out.pop();
  }
  return out;
}

export function searchWindowVectors(db, queryVector, options = {}) {
  const modelKey = options.modelKey;
  if (typeof modelKey !== 'string' || !/^[0-9a-f]{64}$/.test(modelKey)) {
    throw Object.assign(new Error(MSG.MODEL_REQUIRED), { code: 'ECHO_WINDOW_MODEL_REQUIRED' });
  }
  const model = db.prepare('SELECT * FROM echo_vector_models WHERE model_key=?').get(modelKey);
  if (!model) throw Object.assign(new Error(MSG.MODEL_NOT_FOUND), { code: 'ECHO_WINDOW_MODEL_NOT_FOUND' });

  const q = queryVector;
  const dim = Number(model.dimension);
  if (!q || q.length !== dim) throw Object.assign(new Error(MSG.VECTOR_DIM), { code: 'ECHO_WINDOW_DIMENSION_MISMATCH' });

  const echoSourceId = options.echoSourceId;
  if (!echoSourceId) throw Object.assign(new Error(MSG.INCOMPLETE), { code: 'ECHO_WINDOW_SOURCE_REQUIRED' });
  const authority = readEchoAuthority(db, echoSourceId, 'ECHO_WINDOW_STALE');

  const limit = Math.min(100, Math.max(1, Number(options.limit) || 10));

  // ★ 一次取到常驻矩阵（首次构建，之后命中缓存）。
  //   陈旧/损坏检测在构建时做，错误码与旧实现一致（ECHO_WINDOW_STALE / CORRUPT / SOURCE_EMPTY）。
  const m = loadWindowMatrix(db, echoSourceId, modelKey);

  // 查询向量归一化（存储端已归一化，点积即余弦；输入不一定归一，这里归一）。
  let qn = 0;
  for (let i = 0; i < dim; i += 1) qn += q[i] * q[i];
  const qnorm = Math.sqrt(qn) || 1;

  const { n, flat, norms, wordOrd, windowOrd, charStart, charEnd, sessions, sessionIds, seqs } = m;

  // 分数：与旧实现同一累加顺序（i 从 0 到 dim-1，float64 累加），
  // 模长在建缓存时算好 —— 所以分数与旧口径**逐位相同**。
  const scores = new Float64Array(n);
  for (let k = 0; k < n; k += 1) {
    const off = k * dim;
    let dot = 0;
    for (let i = 0; i < dim; i += 1) dot += q[i] * flat[off + i];
    const vnorm = norms[k];
    scores[k] = vnorm === 0 ? 0 : dot / (qnorm * vnorm);
  }

  // 指针字符串只在需要比较或入选时生成（相等分数很罕见）。
  const ptrCache = new Map();
  const ptrOf = (k) => {
    let p = ptrCache.get(k);
    if (p === undefined) { p = 'log:' + sessions[sessionIds[k]] + '#seq=' + seqs[k]; ptrCache.set(k, p); }
    return p;
  };
  const compareK = (k1, k2) => {
    const d = scores[k2] - scores[k1];
    if (d !== 0) return d < 0 ? -1 : 1;
    const pc = ptrOf(k1).localeCompare(ptrOf(k2));
    if (pc !== 0) return pc;
    return windowOrd[k1] - windowOrd[k2];
  };

  const picked = topKIndices(n, limit, scores, compareK);

  // ★ 交付前校验「入选这几条」的词条没变（实测 8.15ms，走索引点查）。
  //   全量校验在构建矩阵时做过；这里补的是「矩阵装好之后、词条被改」那段窗口。
  assertFreshRows(db, 'window', echoSourceId, modelKey, picked.map((k) => wordOrd[k]));

  const results = picked.map((k) => ({
    score: scores[k],
    ptr: ptrOf(k),
    wordOrd: wordOrd[k],
    windowOrd: windowOrd[k],
    charStart: charStart[k],
    charEnd: charEnd[k],
  }));

  return { modelKey, granularity: 'sentence-window', scanned: n, authority: { sourceId:authority.sourceId, generation:authority.generation, state:authority.state, snapshotId:'window:' + authority.sourceId + ':' + modelKey + ':g' + authority.generation }, generation: authority.generation, state: authority.state, results };
}
