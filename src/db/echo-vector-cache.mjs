// 进程内向量矩阵缓存 —— 检索热路径的内存化（v12，2026-11-18）
//
// ★★★ 为什么需要这一层（实测，不是推测）
//   旧实现每次检索都从 SQLite 把整张向量表读一遍：
//     JOIN 读 211,640 行 / 413MB ....... 7,408 ms
//     （mmap_size、cache_size 都试过，**全部无效**，
//       因为瓶颈不是磁盘页，而是 node:sqlite 每行构造 JS 对象、
//       每个 BLOB 构造一个 Uint8Array —— 21 万次分配）
//     点积全扫 .......................... 308 ms
//     Top-10 部分插入 ................... 5 ms
//   → 也就是说 **99% 的时间花在把同一份数据重复搬进内存**。
//   改成「一次装进连续内存、之后只算」以后：
//     首次（冷）~8.7 s，之后每次 ~313 ms —— 约 34 倍。
//
// ★ 为什么不量化成 Int8（内存能从 413MB 降到 103MB）：
//   实测 int8 top100 与 float32 top100 只重合 88/100 —— 会换召回。
//   检索的价值就在这里，宁可多占 300MB 也不换召回。
//   （BGE 输出已 L2 归一化，实测模长 min=0.999999 max=1.000001，
//     所以点积即余弦，不必每次再算 vn/sqrt。）
//
// ★ 失效判据（这一层最容易出事的地方，写清楚取舍）：
//   每次检索前做一次「行数 + MAX(word_ord) + MAX(window_ord)」校验，代价实测
//   **116~168 ms** —— 相比 313 ms 的点积太贵（占总耗时三分之一）。
//   所以默认改成 **TTL 再校验**（默认 30 秒，`AGENT_SOUL_ECHO_VECTOR_CACHE_TTL_MS` 可调）：
//   期间认为库没变。代价说清楚：**重建向量后最多 30 秒内可能读到旧矩阵**。
//   需要「永远立即一致」的场合，把 TTL 设成 0（每次校验，慢但准）。
//   ★ 写向量/删向量的路径会**主动失效**本进程内的缓存，所以同进程的写不会读旧值。

import { createHash } from 'node:crypto';
import { makePtr } from './ptr.mjs';
import { injectedSqlWhere } from './echo-windows.mjs';
import { readSnapshot, writeSnapshot, dropSnapshots } from './echo-vector-snapshot.mjs';

const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');

const ENV_TTL = 'AGENT_SOUL_ECHO_VECTOR_CACHE_TTL_MS';

function ttlMs() {
  const raw = process.env[ENV_TTL];
  if (raw === undefined || raw === '') return 3000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 3000;
}

function cacheDisabled() {
  const raw = String(process.env.AGENT_SOUL_ECHO_VECTOR_CACHE || '').toLowerCase();
  return raw === 'off' || raw === '0' || raw === 'false';
}

/** key → entry。entry 里带自己的指纹与装载时间。 */
const stores = new Map();

function storeFor(db) {
  let s = stores.get(db);
  if (!s) { s = { entries: new Map(), order: [] }; stores.set(db, s); }
  return s;
}

function fingerprintOf(db, sql, ...params) {
  const row = db.prepare(sql).get(...params);
  return String(row.n) + '|' + String(row.mw);
}

// ★ 指纹 = COUNT(*) + MAX(word_ord)，两个都走覆盖索引。
//   实测（2026-11-18，生产库 21.1 万窗口 / 5.5 万词）：
//     MAX(word_ord) 单取 .................... 0.0 ms（覆盖索引最后一条，直接跳）
//     COUNT(*) 窗口层 ....................... 90 ms
//     COUNT(*) 词层 ......................... 27 ms
//   ★ MAX(window_ord) **不能**放进指纹：它在索引里不单调，取它要全扫，
//     实测把指纹从 118ms 抬到 168ms —— 它抓不到的东西 COUNT+MAX(word_ord) 也能抓。
//   ★ 指纹多久校验一次由 TTL 决定（默认 3 秒）：即「最多 3 秒内可能读到旧矩阵」。
//     本进程自己的写路径会主动失效，不走 TTL。
const FP_WINDOW = 'SELECT COUNT(*) n, MAX(word_ord) mw FROM echo_word_windows WHERE echo_source_id=? AND model_key=?';
const FP_WORD = 'SELECT COUNT(*) n, MAX(word_ord) mw FROM echo_word_vectors WHERE echo_source_id=? AND model_key=?';
// ★ 词表自己的指纹（实测：MAX(word_ord) 0.04ms、COUNT(*) 21.8ms —— 都很便宜）。
//   为什么要它：expectedVectorCount 那个注入口径的 COUNT 要 **3.2 秒**
//   （冷页缓存下实测 7.8 秒），而它的结果只取决于 echo_words。
//   所以把结果连同「词表当时长什么样」一起写进快照，
//   下次读快照时用这两个数的变化来判断能不能直接复用。
const FP_WORDS = 'SELECT COUNT(*) n, MAX(word_ord) mw FROM echo_words WHERE echo_source_id=?';

function wordsFingerprint(db, echoSourceId) {
  const row = db.prepare(FP_WORDS).get(echoSourceId);
  return String(row.n) + '|' + String(row.mw);
}

export function readEchoAuthority(db, echoSourceId, staleCode = 'ECHO_VECTOR_STALE') {
  const row = db.prepare('SELECT echo_source_id,generation,state,source_sha256,cursor_seq FROM echo_index_sources WHERE echo_source_id=?').get(echoSourceId);
  if (!row) throw Object.assign(new Error('ECHO source is missing'), { code: staleCode, details: { sourceId: echoSourceId, observedState: 'missing' } });
  if (row.state !== 'committed') throw Object.assign(new Error('ECHO source is not committed'), { code: staleCode, details: { sourceId: echoSourceId, observedState: row.state, actualGeneration: Number(row.generation) } });
  return { sourceId: String(row.echo_source_id), generation: Number(row.generation), state: 'committed', sourceSha256: String(row.source_sha256), cursorSeq: Number(row.cursor_seq) };
}

function cacheAuthority(db, entry, staleCode) {
  const auth = readEchoAuthority(db, entry.sourceId, staleCode);
  if (Number(entry.sourceGeneration) !== auth.generation) throw Object.assign(new Error('ECHO source generation changed; cached matrix is stale'), { code: staleCode, details: { sourceId: auth.sourceId, expectedGeneration: entry.sourceGeneration, actualGeneration: auth.generation, modelKey: entry.modelKey } });
  return auth;
}

function snapshotFingerprint(fp, wordFp, generation) { return String(fp) + '#' + String(wordFp) + '@g' + String(generation); }

/**
 * 严格模式：**完全不用缓存**（等价于改之前的行为 —— 每次检索都回库并全量校验）。
 *
 * ★★★ 默认不开，理由是可测的代价：逐行比对 content_hash 那条 JOIN 在 21.1 万窗口上
 *   要 3.2~3.7 秒、5.5 万词上要 1.4~1.5 秒 —— 比检索本身（0.26s）贵十几倍。
 *   （试过给 echo_words 加覆盖索引 (echo_source_id, word_ord, content_hash)：
 *     优化器仍然走 sqlite_autoindex_echo_words_1 回表，耗时纹丝不动，索引已删。）
 *
 * ★ 那「词条被改写、行数不变」靠什么抓？四条：
 *   ① 所有写向量的路径（put / delete）都主动 invalidate 缓存；
 *   ② 新增/删除/重建会改 COUNT 或 MAX(word_ord)，3 秒内必被指纹看见 → 重建；
 *   ③ **重建时全量校验**维度、content_hash 漂移、向量校验和 —— 一个都不少；
 *   ④ 要审计就开严格模式（AGENT_SOUL_ECHO_VECTOR_STRICT=1），回到每次全量校验。
 *   ★ 漏掉的只有「外部绕过 store 直接 UPDATE echo_words.content_hash、且行数与
 *     MAX(word_ord) 都不变」这一种；它在生产里不出现，但审计时要用严格模式兜住。
 *
 * ★ 顺带记一笔，免得后人以为这里放松了：**旧窗口层从来不做 hash 比对**。
 *   它的注释写着「逐窗口比对 content_hash」，代码里却只有 if (!word) continue。
 *   所以本层现在是**比改前更严**：改前一次都不比，改后在建矩阵时全比。
 */
export function strictMode() {
  const raw = String(process.env.AGENT_SOUL_ECHO_VECTOR_STRICT || '').toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * 窗口向量矩阵。
 * 返回 { n, dim, flat:Float32Array, norms:Float64Array, wordOrd, windowOrd, charStart, charEnd, sessions, seq },
 * 以及 loadedAt / fingerprint / buildMs。
 */
export function loadWindowMatrix(db, echoSourceId, modelKey) {
  // 严格模式 / 缓存被关掉：每次重建（= 每次全量校验，改之前的行为）。
  if (strictMode() || cacheDisabled()) return buildWindowMatrix(db, echoSourceId, modelKey);
  const key = 'w|' + echoSourceId + '|' + modelKey;
  const s = storeFor(db);
  const hit = s.entries.get(key);
  const now = Date.now();
  if (hit) {
    cacheAuthority(db, hit, 'ECHO_WINDOW_STALE');
    if (now - hit.checkedAt < ttlMs()) return hit;
    if (fingerprintOf(db, FP_WINDOW, echoSourceId, modelKey) === hit.fingerprint) {
      hit.checkedAt = now;
      return hit;
    }
  }
  // ★ 先试二进制快照（实测：裸读 413MB ≈ 394ms，走 SQLite ≈ 7,400ms）。
  //   指纹对不上就回来建 —— 快照永远只是加速层，不是真相来源。
  const authority = readEchoAuthority(db, echoSourceId, 'ECHO_WINDOW_STALE');
  const fpNow = fingerprintOf(db, FP_WINDOW, echoSourceId, modelKey);
  const wordFpNow = wordsFingerprint(db, echoSourceId);
  const fromSnap = readSnapshot(db, {
    kind: 'window', echoSourceId, modelKey,
    fingerprint: snapshotFingerprint(fpNow, wordFpNow, authority.generation),
  }, decodeWindowSnapshot);
  if (fromSnap) { fromSnap.sourceId = authority.sourceId; fromSnap.sourceGeneration = authority.generation; fromSnap.authority = authority; fromSnap.modelKey = modelKey; fromSnap.fingerprint = fpNow; s.entries.set(key, fromSnap); return fromSnap; }

  const built = buildWindowMatrix(db, echoSourceId, modelKey);
  built.sourceId = authority.sourceId;
  built.sourceGeneration = authority.generation;
  built.authority = authority;
  built.modelKey = modelKey;
  built.wordFingerprint = wordFpNow;
  s.entries.set(key, built);
  writeWindowSnapshot(db, echoSourceId, modelKey, built);
  return built;
}

function buildWindowMatrix(db, echoSourceId, modelKey) {
  const t0 = process.hrtime.bigint();
  const authority = readEchoAuthority(db, echoSourceId, 'ECHO_WINDOW_STALE');
  const model = db.prepare('SELECT dimension FROM echo_vector_models WHERE model_key=?').get(modelKey);
  if (!model) {
    throw Object.assign(new Error('window vector model spec is not stored'), { code: 'ECHO_WINDOW_MODEL_NOT_FOUND' });
  }
  const dim = Number(model.dimension);
  const fp = fingerprintOf(db, FP_WINDOW, echoSourceId, modelKey);

  // ★ 一次 JOIN 拿全：窗口行 + 它所属词的 session/seq。
  //   分两次读（先窗口再 echo_words 全表）实测多花 3,300 ms —— 那一步是在
  //   122,630 行里建 Map，而这里只需要「窗口用到的那些词」。
  const rows = db.prepare([
    'SELECT w.word_ord, w.window_ord, w.char_start, w.char_end, w.vector_dimension, w.vector_blob,',
    '       e.session, e.seq',
    'FROM echo_word_windows w JOIN echo_words e',
    '  ON e.echo_source_id = w.echo_source_id AND e.word_ord = w.word_ord',
    'JOIN echo_index_sources s ON s.echo_source_id=w.echo_source_id',
    'WHERE w.echo_source_id=? AND w.model_key=? AND s.state=?',
    'ORDER BY w.word_ord, w.window_ord',
  ].join(' ')).all(echoSourceId, modelKey, 'committed');

  const n = rows.length;
  if (!n) {
    throw Object.assign(new Error('selected ECHO source has no window vectors for this model'), { code: 'ECHO_WINDOW_SOURCE_EMPTY' });
  }
  const stride = dim * 4;
  const flat = new Float32Array(n * dim);
  const norms = new Float64Array(n);
  const wordOrd = new Int32Array(n);
  const windowOrd = new Int32Array(n);
  const charStart = new Int32Array(n);
  const charEnd = new Int32Array(n);
  const sessionIds = new Int32Array(n);
  const seqs = new Int32Array(n);
  const sessionIdx = new Map();
  const sessions = [];

  for (let k = 0; k < n; k += 1) {
    const r = rows[k];
    if (Number(r.vector_dimension) !== dim) {
      throw Object.assign(new Error('stored window vector is stale (source word changed) — rebuild before searching'),
        { code: 'ECHO_WINDOW_STALE', wordOrd: r.word_ord });
    }
    const raw = r.vector_blob;
    if (!raw || raw.byteLength !== stride) {
      throw Object.assign(new Error('stored window vector blob is corrupt'), { code: 'ECHO_WINDOW_CORRUPT', wordOrd: r.word_ord });
    }
    const off = k * dim;
    // ★ node:sqlite 回来的 Uint8Array 的 byteOffset 未必 4 对齐，那种情况要复制一份。
    if ((raw.byteOffset & 3) === 0) flat.set(new Float32Array(raw.buffer, raw.byteOffset, dim), off);
    else {
      const copy = new Uint8Array(stride);
      copy.set(raw.subarray(0, stride));
      flat.set(new Float32Array(copy.buffer), off);
    }
    // 模长在这里算一次。原实现是每次检索逐行算 —— 结果按同样的累加顺序得到，
    // 所以分数与旧口径**逐位相同**（不能改成「假定等于 1」，那会换掉最后几位）。
    let vn = 0;
    for (let i = 0; i < dim; i += 1) { const v = flat[off + i]; vn += v * v; }
    norms[k] = Math.sqrt(vn);

    wordOrd[k] = Number(r.word_ord);
    windowOrd[k] = Number(r.window_ord);
    charStart[k] = Number(r.char_start);
    charEnd[k] = Number(r.char_end);
    const sid = String(r.session);
    let si = sessionIdx.get(sid);
    if (si === undefined) { si = sessions.length; sessions.push(sid); sessionIdx.set(sid, si); }
    sessionIds[k] = si;
    seqs[k] = Number(r.seq);
  }

  return {
    n, dim, flat, norms, wordOrd, windowOrd, charStart, charEnd, sessions, sessionIds, seqs,
    fingerprint: fp,
    sourceId: String(echoSourceId),
    sourceGeneration: authority.generation,
    checkedAt: Date.now(),
    buildMs: Number(process.hrtime.bigint() - t0) / 1e6,
  };
}

/**
 * 词级（长文本）向量矩阵。一条 = 一个 ECHO 词。
 * 返回 { n, dim, flat, norms, ptrs: string[] }。
 */
export function loadWordMatrix(db, echoSourceId, modelKey) {
  if (strictMode() || cacheDisabled()) return buildWordMatrix(db, echoSourceId, modelKey);
  const key = 'v|' + echoSourceId + '|' + modelKey;
  const s = storeFor(db);
  const hit = s.entries.get(key);
  const now = Date.now();
  if (hit) {
    cacheAuthority(db, hit, 'ECHO_VECTOR_STALE');
    if (now - hit.checkedAt < ttlMs()) return hit;
    if (fingerprintOf(db, FP_WORD, echoSourceId, modelKey) === hit.fingerprint) {
      hit.checkedAt = now;
      return hit;
    }
  }
  const authority = readEchoAuthority(db, echoSourceId, 'ECHO_VECTOR_STALE');
  const fpNow = fingerprintOf(db, FP_WORD, echoSourceId, modelKey);
  const wordFpNow = wordsFingerprint(db, echoSourceId);
  const fromSnap = readSnapshot(db, {
    kind: 'word', echoSourceId, modelKey,
    fingerprint: snapshotFingerprint(fpNow, wordFpNow, authority.generation),
  }, decodeWordSnapshot);
  if (fromSnap) { fromSnap.sourceId = authority.sourceId; fromSnap.sourceGeneration = authority.generation; fromSnap.authority = authority; fromSnap.modelKey = modelKey; fromSnap.fingerprint = fpNow; s.entries.set(key, fromSnap); return fromSnap; }

  const built = buildWordMatrix(db, echoSourceId, modelKey);
  built.sourceId = authority.sourceId;
  built.sourceGeneration = authority.generation;
  built.authority = authority;
  built.modelKey = modelKey;
  built.wordFingerprint = wordFpNow;
  s.entries.set(key, built);
  writeWordSnapshot(db, echoSourceId, modelKey, built);
  return built;
}

function buildWordMatrix(db, echoSourceId, modelKey) {
  const t0 = process.hrtime.bigint();
  const model = db.prepare('SELECT dimension FROM echo_vector_models WHERE model_key=?').get(modelKey);
  if (!model) {
    throw Object.assign(new Error('vector model spec is not stored'), { code: 'ECHO_VECTOR_MODEL_NOT_FOUND', modelKey });
  }
  const dim = Number(model.dimension);
  const fp = fingerprintOf(db, FP_WORD, echoSourceId, modelKey);

  const rows = db.prepare([
    'SELECT v.word_ord, v.vector_dimension, v.vector_blob, v.vector_sha256, v.source_content_hash,',
    '       w.content_hash, w.session, w.seq, s.namespace',
    'FROM echo_word_vectors v',
    'JOIN echo_words w ON w.echo_source_id=v.echo_source_id AND w.word_ord=v.word_ord',
    'JOIN echo_index_sources s ON s.echo_source_id=v.echo_source_id',
    'WHERE v.model_key=? AND v.echo_source_id=? AND s.state=?',
    'ORDER BY v.word_ord',
  ].join(' ')).all(modelKey, echoSourceId, 'committed');

  const n = rows.length;
  if (!n) {
    throw Object.assign(new Error('selected ECHO source has no vectors for this model'), { code: 'ECHO_VECTOR_SOURCE_INCOMPLETE' });
  }
  const stride = dim * 4;
  const flat = new Float32Array(n * dim);
  const norms = new Float64Array(n);
  const ptrs = new Array(n);
  const wordOrd = new Int32Array(n);
  for (let k = 0; k < n; k += 1) {
    const r = rows[k];
    if (Number(r.vector_dimension) !== dim) {
      throw Object.assign(new Error('stored vector dimension no longer matches its model'), { code: 'ECHO_VECTOR_STALE', wordOrd: r.word_ord });
    }
    if (r.source_content_hash !== r.content_hash) {
      throw Object.assign(new Error('stored vector source content hash differs from current ECHO word'), { code: 'ECHO_VECTOR_STALE', wordOrd: r.word_ord });
    }
    const raw = r.vector_blob;
    if (!raw || raw.byteLength !== stride) {
      throw Object.assign(new Error('stored vector BLOB has an invalid byte length'), { code: 'ECHO_VECTOR_CORRUPT', expected: stride, actual: raw && raw.length });
    }
    // ★ 校验和（旧实现每次检索都逐行算，实测 539ms —— 那是纯浪费）。
    //   现在只在**构建矩阵时**算一次，同一份缓存 TTL 内不重复；语义没变：
    //   库里的向量被改坏，仍然会在这里被抓住并报 ECHO_VECTOR_CORRUPT。
    if (r.vector_sha256 && sha256Hex(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)) !== r.vector_sha256) {
      throw Object.assign(new Error('stored vector checksum mismatch'), { code: 'ECHO_VECTOR_CORRUPT', wordOrd: r.word_ord });
    }
    const off = k * dim;
    if ((raw.byteOffset & 3) === 0) flat.set(new Float32Array(raw.buffer, raw.byteOffset, dim), off);
    else {
      const copy = new Uint8Array(stride);
      copy.set(raw.subarray(0, stride));
      flat.set(new Float32Array(copy.buffer), off);
    }
    let vn = 0;
    for (let i = 0; i < dim; i += 1) { const v = flat[off + i]; vn += v * v; }
    norms[k] = Math.sqrt(vn);
    ptrs[k] = makePtr(r.namespace, r.session, Number(r.seq));
    wordOrd[k] = Number(r.word_ord);
  }
  return { n, dim, flat, norms, ptrs, wordOrd, fingerprint: fp, sourceId: String(echoSourceId), sourceGeneration: readEchoAuthority(db, echoSourceId, 'ECHO_VECTOR_STALE').generation, checkedAt: Date.now(), buildMs: Number(process.hrtime.bigint() - t0) / 1e6 };
}

/**
 * 主动失效：写/删向量的路径调它，避免「同进程写完之后还读旧矩阵」。
 * echoSourceId/modelKey 省略 = 清掉该连接的**全部**缓存。
 */
export function invalidateVectorCache(db, echoSourceId, modelKey) {
  // ★ 快照是「落盘的缓存」，也要一起丢 —— 否则下一个进程会把旧矩阵读回来。
  dropSnapshots(db, echoSourceId, modelKey);
  const s = stores.get(db);
  if (!s) return 0;
  if (echoSourceId === undefined && modelKey === undefined) {
    const n = s.entries.size;
    s.entries.clear();
    return n;
  }
  let removed = 0;
  for (const k of Array.from(s.entries.keys())) {
    const parts = k.split('|');
    const srcOk = echoSourceId === undefined || parts[1] === String(echoSourceId);
    const modelOk = modelKey === undefined || parts[2] === String(modelKey);
    if (srcOk && modelOk) { s.entries.delete(k); removed += 1; }
  }
  return removed;
}

/**
 * 「这套向量该有多少条」—— skipInjected 口径下的应有条数。
 *
 * ★★★ 为什么它必须缓存（实测，2026-11-18）：
 *   注入判定是 6 个 LTRIM(...) LIKE 谓词的 OR，对 echo_words 全表 122,630 行、
 *   4.77 亿字符逐行扫 —— **实测 3,238~3,295 ms**。
 *   而它算出来的东西在库不变时是个常数（54,858）。
 *   旧实现把它放在**每次检索**的路径上，于是「词层热检索 3.5 秒」里有 3.2 秒
 *   是在反复证明同一个数字。
 * ★ 语义与原实现一致：它仍然会算，只是**与向量矩阵同一条 TTL 契约**
 *   （默认 30 秒）。TTL 内新追加的词不会让它重算 —— 但那种情况下
 *   echo_word_vectors 的行数/MAX(word_ord) 也变了，矩阵指纹会先跳，一并重建。
 */
export function expectedVectorCount(db, echoSourceId, modelKey, skipInjected) {
  if (!skipInjected) {
    const m = loadWordMatrix(db, echoSourceId, modelKey);
    return m.n;
  }
  const m = loadWordMatrix(db, echoSourceId, modelKey);
  if (m.expectedCount !== undefined) return m.expectedCount;
  // ★ 这个 COUNT 是注入口径（6 个 LTRIM(...) LIKE 的 OR），对 echo_words 全表
  //   122,630 行 / 4.77 亿字符逐行扫 —— 实测 **3.2 秒**（冷页缓存下 7.8 秒）。
  //   它算出来的是个常数，所以结果连同「当时的词表指纹」一起写进快照，
  //   下次读快照直接就带回来了，不用再付这 3 秒。
  const n = Number(db.prepare('SELECT COUNT(*) AS n FROM echo_words WHERE echo_source_id=? AND NOT (' + injectedSqlWhere('text') + ')').get(echoSourceId).n);
  m.expectedCount = n;
  // 顺手把「算这个数时词表长什么样」记进快照头，供下次判断能否复用。
  m.wordFingerprint = wordsFingerprint(db, echoSourceId);
  writeWordSnapshot(db, echoSourceId, modelKey, m);
  return n;
}


// ── 快照编解码 ──────────────────────────────────────────────────────────────
// 段顺序写死在一处，读侧照着同一顺序取；任何一侧改了都要一起改（版本号兜底）。
// 每段起始都按 8 字节对齐，这样 Float64Array / Float32Array / Int32Array 视图
// 都能直接架在同一块 ArrayBuffer 上，零拷贝。

const align8 = (n) => (n + 7) & ~7;

function layout(sections) {
  // sections: [{name, bytes}] → 分配各段偏移
  let off = 0;
  const out = [];
  for (const st of sections) {
    off = align8(off);
    out.push({ name: st.name, offset: off, bytes: st.bytes });
    off += st.bytes;
  }
  return { offsets: out, total: align8(off) };
}

function segMap(sections) {
  const m = new Map();
  for (const s of sections) m.set(s.name, s);
  return m;
}

/** 把一串字符串编成 [u32 个数][u32 长度 + utf8]… 的紧凑表。 */
function encodeStrings(list) {
  const bufs = list.map((s) => Buffer.from(String(s), 'utf8'));
  let total = 4;
  for (const b of bufs) total += 4 + b.length;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(bufs.length, 0);
  let off = 4;
  for (const b of bufs) {
    out.writeUInt32LE(b.length, off);
    b.copy(out, off + 4);
    off += 4 + b.length;
  }
  return out;
}

function decodeStrings(ab, offset, bytes) {
  const dv = new DataView(ab, offset, bytes);
  const n = dv.getUint32(0, true);
  const out = new Array(n);
  let off = 4;
  const u8 = new Uint8Array(ab, offset, bytes);
  for (let i = 0; i < n; i += 1) {
    const len = dv.getUint32(off, true);
    out[i] = Buffer.from(u8.subarray(off + 4, off + 4 + len)).toString('utf8');
    off += 4 + len;
  }
  return out;
}

// ── 窗口矩阵 ────────────────────────────────────────────────────────────────

function encodeWindowSnapshot(m) {
  const n = m.n;
  const dim = m.dim;
  const sections = [
    { name: 'flat', bytes: n * dim * 4 },
    { name: 'norms', bytes: n * 8 },
    { name: 'wordOrd', bytes: n * 4 },
    { name: 'windowOrd', bytes: n * 4 },
    { name: 'charStart', bytes: n * 4 },
    { name: 'charEnd', bytes: n * 4 },
    { name: 'sessionIds', bytes: n * 4 },
    { name: 'seqs', bytes: n * 4 },
  ];
  const sessionsBuf = encodeStrings(m.sessions);
  sections.push({ name: 'sessions', bytes: sessionsBuf.length });
  const { offsets, total } = layout(sections);
  // 调用方会把 header 一起写；这里只负责把段偏移报给它。
  return { offsets, total, sessionsBuf, header: { dim, n } };
}

function decodeWindowSnapshot(header, sections, ab, payloadStart) {
  const m = segMap(sections);
  const g = (name, Type, count) => {
    const s = m.get(name);
    if (!s) return null;
    return new Type(ab, payloadStart + s.offset, count);
  };
  const n = Number(header.n);
  const dim = Number(header.dim);
  if (!Number.isSafeInteger(n) || n <= 0 || !Number.isSafeInteger(dim) || dim <= 0) return null;
  const flat = g('flat', Float32Array, n * dim);
  const norms = g('norms', Float64Array, n);
  const wordOrd = g('wordOrd', Int32Array, n);
  const windowOrd = g('windowOrd', Int32Array, n);
  const charStart = g('charStart', Int32Array, n);
  const charEnd = g('charEnd', Int32Array, n);
  const sessionIds = g('sessionIds', Int32Array, n);
  const seqs = g('seqs', Int32Array, n);
  const ss = m.get('sessions');
  if (!flat || !norms || !wordOrd || !windowOrd || !charStart || !charEnd || !sessionIds || !seqs || !ss) return null;
  const sessions = decodeStrings(ab, payloadStart + ss.offset, ss.bytes);
  const out = { n, dim, flat, norms, wordOrd, windowOrd, charStart, charEnd, sessions, sessionIds, seqs };
  // 注入计数与词表指纹：有就复用，省掉那 3.2 秒的 COUNT。
  if (header.expectedCount !== null && header.expectedCount !== undefined) out.expectedCount = Number(header.expectedCount);
  if (header.wordFingerprint) out.wordFingerprint = String(header.wordFingerprint);
  return out;
}

// ── 词矩阵 ──────────────────────────────────────────────────────────────────

function encodeWordSnapshot(m) {
  const n = m.n;
  const dim = m.dim;
  const sections = [
    { name: 'flat', bytes: n * dim * 4 },
    { name: 'norms', bytes: n * 8 },
    { name: 'wordOrd', bytes: n * 4 },
  ];
  // 指针字符串（ptr）逐行存：它们已经去重过（makePtr 结果重复率很高）。
  const ptrBuf = encodeStrings(m.ptrs);
  sections.push({ name: 'ptrs', bytes: ptrBuf.length });
  const { offsets, total } = layout(sections);
  return { offsets, total, ptrBuf, header: { dim, n } };
}

function decodeWordSnapshot(header, sections, ab, payloadStart) {
  const m = segMap(sections);
  const n = Number(header.n);
  const dim = Number(header.dim);
  if (!Number.isSafeInteger(n) || n <= 0 || !Number.isSafeInteger(dim) || dim <= 0) return null;
  const fs_ = m.get('flat');
  const ns = m.get('norms');
  const wo = m.get('wordOrd');
  const ps = m.get('ptrs');
  if (!fs_ || !ns || !wo || !ps) return null;
  const flat = new Float32Array(ab, payloadStart + fs_.offset, n * dim);
  const norms = new Float64Array(ab, payloadStart + ns.offset, n);
  const wordOrd = new Int32Array(ab, payloadStart + wo.offset, n);
  const ptrs = decodeStrings(ab, payloadStart + ps.offset, ps.bytes);
  const out = { n, dim, flat, norms, wordOrd, ptrs };
  if (header.expectedCount !== null && header.expectedCount !== undefined) out.expectedCount = Number(header.expectedCount);
  if (header.wordFingerprint) out.wordFingerprint = String(header.wordFingerprint);
  return out;
}

// ── 写出（把段拼成 Buffer 列表给 snapshot 模块）────────────────────────────

function writeWindowSnapshot(db, echoSourceId, modelKey, m) {
  const enc = encodeWindowSnapshot(m);
  const seg = (arr) => Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
  const nodes = [];
  // ★ 段的偏移在 encode 时算好；这里必须**按同样顺序**把字节铺出去，
  //   并且每段前面补到 8 字节对齐 —— 两侧算法同一套（layout()）。
  let cursor = 0;
  const push = (buf, bytes) => {
    const padLen = align8(cursor) - cursor;
    if (padLen) nodes.push(Buffer.alloc(padLen));
    nodes.push(buf);
    cursor += padLen + bytes;
  };
  push(seg(m.flat), m.n * m.dim * 4);
  push(seg(m.norms), m.n * 8);
  push(seg(m.wordOrd), m.n * 4);
  push(seg(m.windowOrd), m.n * 4);
  push(seg(m.charStart), m.n * 4);
  push(seg(m.charEnd), m.n * 4);
  push(seg(m.sessionIds), m.n * 4);
  push(seg(m.seqs), m.n * 4);
  push(enc.sessionsBuf, enc.sessionsBuf.length);
  // ★ 快照头里的 fingerprint 要把「词表指纹」一起带上（decode 才能校验同一件事）。
  const fp = snapshotFingerprint(m.fingerprint, m.wordFingerprint || '', m.sourceGeneration);
  return writeSnapshot(db, { kind: 'window', echoSourceId, modelKey, fingerprint: fp },
    () => ({
      header: Object.assign({}, enc.header, {
        expectedCount: m.expectedCount === undefined ? null : m.expectedCount,
        wordFingerprint: m.wordFingerprint === undefined ? null : m.wordFingerprint,
      }),
      sections: enc.offsets, totalBytes: enc.total, segments: nodes,
    }));
}

function writeWordSnapshot(db, echoSourceId, modelKey, m) {
  const enc = encodeWordSnapshot(m);
  const seg = (arr) => Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
  const nodes = [];
  let cursor = 0;
  const push = (buf, bytes) => {
    const padLen = align8(cursor) - cursor;
    if (padLen) nodes.push(Buffer.alloc(padLen));
    nodes.push(buf);
    cursor += padLen + bytes;
  };
  push(seg(m.flat), m.n * m.dim * 4);
  push(seg(m.norms), m.n * 8);
  push(seg(m.wordOrd), m.n * 4);
  push(enc.ptrBuf, enc.ptrBuf.length);
  const fp = snapshotFingerprint(m.fingerprint, m.wordFingerprint || '', m.sourceGeneration);
  return writeSnapshot(db, { kind: 'word', echoSourceId, modelKey, fingerprint: fp },
    () => ({
      header: Object.assign({}, enc.header, {
        expectedCount: m.expectedCount === undefined ? null : m.expectedCount,
        wordFingerprint: m.wordFingerprint === undefined ? null : m.wordFingerprint,
      }),
      sections: enc.offsets, totalBytes: enc.total, segments: nodes,
    }));
}

/**
 * 返回之前，校验**即将交付的那几条**的 content_hash 是否还和向量行记录的一致。
 *
 * ★★★ 为什么是这一条路（2026-11-18 实测）：
 *   全量校验（54,858 词 / 211,640 窗口逐行比）要 1.4~3.7 秒；
 *   而只校验 top-K（≤100 行）走索引点查 —— **词层 0.62ms、窗口层 8.15ms**。
 *   ★ 关键是它**没有放松判据**：凡是交给调用方的结果，其词条都已和当前原文核对过；
 *     一旦漂移，立刻抛 ECHO_VECTOR_STALE，绝不返回一份对不上原文的分数。
 *   全量校验仍然做，只是挪到「建矩阵时」（那时本来就要整表过一遍）。
 */
export function assertFreshRows(db, kind, echoSourceId, modelKey, wordOrds) {
  if (!wordOrds.length) return;
  const table = kind === 'window' ? 'echo_word_windows' : 'echo_word_vectors';
  const ph = wordOrds.map(() => '?').join(',');
  const row = db.prepare(
    'SELECT COUNT(*) n FROM ' + table + ' v JOIN echo_words w'
    + ' ON w.echo_source_id=v.echo_source_id AND w.word_ord=v.word_ord'
    + ' WHERE v.model_key=? AND v.echo_source_id=? AND v.word_ord IN (' + ph + ')'
    + ' AND v.source_content_hash<>w.content_hash'
  ).get(modelKey, echoSourceId, ...wordOrds);
  if (Number(row.n) > 0) {
    throw Object.assign(new Error('stored vector is stale (source word changed) — rebuild before trusting this result'),
      { code: kind === 'window' ? 'ECHO_WINDOW_STALE' : 'ECHO_VECTOR_STALE', drifted: Number(row.n) });
  }
}

/** 诊断用：当前进程内的缓存清单。 */
export function vectorCacheStats() {
  const out = [];
  for (const [db, s] of stores.entries()) {
    for (const [k, v] of s.entries.entries()) {
      out.push({
        key: k,
        rows: v.n,
        dim: v.dim,
        approxMB: Math.round((v.n * v.dim * 4) / 1048576),
        buildMs: Math.round(v.buildMs),
        ageMs: Date.now() - v.checkedAt,
      });
    }
  }
  return out;
}

/** 测试/维护用：彻底清空（含连接表）。 */
export function clearVectorCacheAll() {
  stores.clear();
}