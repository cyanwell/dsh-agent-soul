// SQLite-backed derived ECHO vector persistence. Embedding inference remains an adapter concern.
import { createHash } from 'node:crypto';
import { makePtr } from './ptr.mjs';
import { injectedSqlWhere } from './echo-windows.mjs';
import { loadWordMatrix, expectedVectorCount, invalidateVectorCache, assertFreshRows, strictMode, readEchoAuthority } from './echo-vector-cache.mjs';
const fail = (code, message, details) => { const e = new Error(message); e.code = code; if (details) e.details = details; throw e; };
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const isHash = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/i.test(v);
const canonicalJson = (v) => {
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
  return JSON.stringify(v);
};
function normalizeSpec(input) {
  const s = input && typeof input === 'object' ? input : {};
  for (const k of ['modelId','revision','modelSha256','tokenizerSpec','preprocessSpec','poolingSpec']) {
    if (typeof s[k] !== 'string' || !s[k].trim()) fail('ECHO_VECTOR_SPEC_INVALID', k + ' must be a non-empty string');
  }
  if (!isHash(s.modelSha256)) fail('ECHO_VECTOR_SPEC_INVALID', 'modelSha256 must be a SHA-256 hex digest');
  if (!Number.isSafeInteger(s.dimension) || s.dimension <= 0) fail('ECHO_VECTOR_SPEC_INVALID', 'dimension must be a positive safe integer');
  if (!Number.isSafeInteger(s.maxSeqLength) || s.maxSeqLength <= 0) fail('ECHO_VECTOR_SPEC_INVALID', 'maxSeqLength must be a positive safe integer');
  if (typeof s.normalize !== 'boolean') fail('ECHO_VECTOR_SPEC_INVALID', 'normalize must be boolean');
  const normalized = { modelId:s.modelId, revision:s.revision, modelSha256:s.modelSha256.toLowerCase(), tokenizerSpec:s.tokenizerSpec, preprocessSpec:s.preprocessSpec, poolingSpec:s.poolingSpec, normalize:s.normalize, dimension:s.dimension, maxSeqLength:s.maxSeqLength };
  const specSha256 = sha256(Buffer.from(canonicalJson(normalized), 'utf8'));
  return { ...normalized, modelKey:specSha256, specSha256 };
}
function vectorBytes(values, dimension) {
  if (!(Array.isArray(values) || ArrayBuffer.isView(values)) || values.length !== dimension) fail('ECHO_VECTOR_DIMENSION_MISMATCH', 'vector dimension does not match model spec', { expected:dimension, actual:values && values.length });
  const out = Buffer.allocUnsafe(dimension * 4);
  for (let i=0;i<dimension;i+=1) {
    const n = Number(values[i]);
    if (!Number.isFinite(n)) fail('ECHO_VECTOR_INVALID', 'vector values must be finite', { index:i });
    out.writeFloatLE(n, i*4);
  }
  return out;
}
function vectorFromBytes(blob, dimension) {
  if (!(Buffer.isBuffer(blob) || ArrayBuffer.isView(blob)) || blob.byteLength !== dimension * 4) fail('ECHO_VECTOR_CORRUPT', 'stored vector BLOB has an invalid byte length', { expected:dimension*4, actual:blob && blob.length });
  const bytes = Buffer.isBuffer(blob) ? blob : Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  const out = new Float32Array(dimension);
  for (let i=0;i<dimension;i+=1) out[i] = bytes.readFloatLE(i*4);
  return out;
}
function vectorsTableReady(db) {
  const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
  if (!names.has('echo_vector_models') || !names.has('echo_word_vectors')) fail('ECHO_VECTOR_SCHEMA_REQUIRED', 'schema v10 vector tables are required');
}
function ensureModel(db, s) {
  db.prepare('INSERT OR IGNORE INTO echo_vector_models (model_key,model_id,model_revision,model_sha256,tokenizer_spec,preprocess_spec,pooling_spec,normalize,dimension,max_seq_length,spec_sha256,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(s.modelKey,s.modelId,s.revision,s.modelSha256,s.tokenizerSpec,s.preprocessSpec,s.poolingSpec,s.normalize?1:0,s.dimension,s.maxSeqLength,s.specSha256,new Date().toISOString());
  const row = db.prepare('SELECT * FROM echo_vector_models WHERE model_key=?').get(s.modelKey);
  if (!row || row.model_id!==s.modelId || row.model_revision!==s.revision || row.model_sha256!==s.modelSha256 || row.tokenizer_spec!==s.tokenizerSpec || row.preprocess_spec!==s.preprocessSpec || row.pooling_spec!==s.poolingSpec || row.normalize!==(s.normalize?1:0) || row.dimension!==s.dimension || row.max_seq_length!==s.maxSeqLength || row.spec_sha256!==s.specSha256) fail('ECHO_VECTOR_SPEC_COLLISION', 'stored model spec differs for identical model_key');
}
const begin = (db) => db.exec('BEGIN IMMEDIATE');
const commit = (db) => db.exec('COMMIT');
const rollback = (db) => { try { db.exec('ROLLBACK'); } catch {} };
export function registerEchoVectorModel(db, modelSpec) {
  vectorsTableReady(db);
  const s = normalizeSpec(modelSpec);
  begin(db);
  try { ensureModel(db, s); commit(db); }
  catch (err) { rollback(db); throw err; }
  return { modelKey:s.modelKey, modelId:s.modelId, revision:s.revision, dimension:s.dimension, specSha256:s.specSha256 };
}
/**
 * 按「模型同一性 + 粒度」找已登记的向量模型。返回 null = 没登记过。
 *
 * ★ 为什么需要它（2026-11-18 修）：读端**复现不出**写端的 spec。
 *   窗口模型的 preprocess_spec 里还带着 targetChars / maxChars（切窗参数），
 *   而那是**生成时的一次选择**，不是模型的属性。读端只知道「我要句子窗口」，
 *   不知道当初几字切一刀 —— 拿它做 9 字段精确匹配，永远 0 命中。
 *   （那次的实际症状：soul_echo_window_search 报 ECHO_WINDOW_MODEL_NOT_FOUND，
 *     而库里明明有 20590 行窗口向量。）
 *
 * ★ 所以匹配只认**决定向量可比性的字段**：权重 / 分词器 / 池化 / 归一 / 维度 /
 *   preprocess 里的前缀与截断策略 + granularity。
 *   targetChars / maxChars **不参与** —— 它们变了，向量仍然可比，只是窗口边界不同。
 *
 * ★ granularity 严格比：null 只配 null。长文本模型记 null（spec 里根本没这个键），
 *   窗口模型记 'sentence-window'。这样两套向量永远不会互串。
 *
 * ★ 多个候选（同一个模型用不同切窗参数跑过几次）时取**最新登记**的那个 ——
 *   后建的替代先建的；但把候选数与全部 key 一起回给调用方，不隐瞒有多个。
 */
export function findEchoVectorModel(db, modelSpec, options = {}) {
  const s = normalizeSpec(modelSpec);
  const wantGrain = options.granularity === undefined ? null : options.granularity;
  const want = JSON.parse(s.preprocessSpec);
  const rows = db.prepare(
    'SELECT model_key, preprocess_spec, created_at FROM echo_vector_models '
    + 'WHERE model_id=? AND model_revision=? AND model_sha256=? AND tokenizer_spec=? '
    + 'AND pooling_spec=? AND normalize=? AND dimension=? AND max_seq_length=? '
    + 'ORDER BY created_at DESC'
  ).all(s.modelId, s.revision, s.modelSha256, s.tokenizerSpec, s.poolingSpec, s.normalize ? 1 : 0, s.dimension, s.maxSeqLength);

  const hits = [];
  for (const r of rows) {
    let inner;
    try { inner = JSON.parse(r.preprocess_spec); } catch { continue; }
    const grain = typeof inner.granularity === 'string' ? inner.granularity : null;
    if (grain !== wantGrain) continue;
    if (inner.queryPrefix !== want.queryPrefix) continue;
    if (inner.documentPrefix !== want.documentPrefix) continue;
    if (inner.maxInputChars !== want.maxInputChars) continue;
    if (inner.truncation !== want.truncation) continue;
    hits.push({ modelKey: r.model_key, preprocessSpec: r.preprocess_spec, createdAt: r.created_at });
  }
  if (!hits.length) return null;
  return {
    modelKey: hits[0].modelKey,
    preprocessSpec: hits[0].preprocessSpec,
    createdAt: hits[0].createdAt,
    candidates: hits.length,
    allModelKeys: hits.map((h) => h.modelKey),
  };
}

export function putEchoSourceVectors(db, echoSourceId, modelSpec, rows, options) {
  vectorsTableReady(db);
  if (typeof echoSourceId !== 'string' || !echoSourceId) fail('ECHO_VECTOR_SOURCE_REQUIRED','echoSourceId is required');
  if (!Array.isArray(rows)) fail('ECHO_VECTOR_ROWS_INVALID','rows must be an array');
  const s = normalizeSpec(modelSpec);
  const opts = options || {};
  const mode = opts.mode === undefined ? 'replace' : opts.mode;
  if (mode!=='replace' && mode!=='upsert') fail('ECHO_VECTOR_MODE_INVALID','mode must be replace|upsert');
  const seen = new Set();
  const prepared = rows.map((r,i) => {
    if (!r || typeof r!=='object' || !Number.isSafeInteger(r.wordOrd) || r.wordOrd<0 || !isHash(r.contentHash)) fail('ECHO_VECTOR_ROW_INVALID','each row requires wordOrd and source contentHash',{index:i});
    if (seen.has(r.wordOrd)) fail('ECHO_VECTOR_DUPLICATE_WORD','duplicate wordOrd in vector batch',{wordOrd:r.wordOrd});
    seen.add(r.wordOrd);
    const blob=vectorBytes(r.vector,s.dimension);
    return { wordOrd:r.wordOrd, contentHash:r.contentHash, blob, vectorSha256:sha256(blob) };
  });
  begin(db);
  try {
    ensureModel(db,s);
    const selectWord = db.prepare('SELECT content_hash FROM echo_words WHERE echo_source_id=? AND word_ord=?');
    for (const row of prepared) {
      const word = selectWord.get(echoSourceId,row.wordOrd);
      if (!word) fail('ECHO_VECTOR_WORD_NOT_FOUND','vector row has no matching authoritative ECHO word',{echoSourceId,wordOrd:row.wordOrd});
      if (word.content_hash !== row.contentHash) fail('ECHO_VECTOR_STALE','source word content hash changed before vector commit',{echoSourceId,wordOrd:row.wordOrd,expected:word.content_hash,actual:row.contentHash});
    }
    if (mode==='replace') db.prepare('DELETE FROM echo_word_vectors WHERE echo_source_id=? AND model_key=?').run(echoSourceId,s.modelKey);
    const insert=db.prepare('INSERT INTO echo_word_vectors (echo_source_id,word_ord,model_key,source_content_hash,vector_dimension,vector_blob,vector_sha256,created_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(echo_source_id,word_ord,model_key) DO UPDATE SET source_content_hash=excluded.source_content_hash,vector_dimension=excluded.vector_dimension,vector_blob=excluded.vector_blob,vector_sha256=excluded.vector_sha256,created_at=excluded.created_at');
    const now=new Date().toISOString();
    for (const row of prepared) insert.run(echoSourceId,row.wordOrd,s.modelKey,row.contentHash,s.dimension,row.blob,row.vectorSha256,now);
    commit(db);
    // ★ 同进程写完立刻失效，否则会读到旧矩阵。
    invalidateVectorCache(db, echoSourceId, s.modelKey);
  } catch(err) { rollback(db); throw err; }
  return { echoSourceId, modelKey:s.modelKey, rows:prepared.length, mode };
}
export function deleteEchoSourceVectors(db, echoSourceId, modelKey) {
  vectorsTableReady(db);
  if (typeof echoSourceId!=='string' || !echoSourceId) fail('ECHO_VECTOR_SOURCE_REQUIRED','echoSourceId is required');
  begin(db);
  try {
    const result = modelKey === undefined
      ? db.prepare('DELETE FROM echo_word_vectors WHERE echo_source_id=?').run(echoSourceId)
      : db.prepare('DELETE FROM echo_word_vectors WHERE echo_source_id=? AND model_key=?').run(echoSourceId,modelKey);
    db.prepare('DELETE FROM echo_vector_models WHERE NOT EXISTS (SELECT 1 FROM echo_word_vectors WHERE echo_word_vectors.model_key=echo_vector_models.model_key)').run();
    commit(db);
    // ★ 删完立刻失效（不传 modelKey = 该源所有维度都清），否则同进程还会读到旧矩阵。
    invalidateVectorCache(db, echoSourceId);
    return Number(result.changes);
  } catch (err) { rollback(db); throw err; }
}
export function searchEchoSourceVectors(db, queryVector, options) {
  vectorsTableReady(db);
  const o=options||{};
  if (typeof o.modelKey!=='string' || !isHash(o.modelKey)) fail('ECHO_VECTOR_MODEL_REQUIRED','modelKey is required');
  const requestedAuthority = o.echoSourceId ? readEchoAuthority(db, o.echoSourceId, 'ECHO_VECTOR_STALE') : null;
  const model=db.prepare('SELECT * FROM echo_vector_models WHERE model_key=?').get(o.modelKey);
  if (!model) fail('ECHO_VECTOR_MODEL_NOT_FOUND','vector model spec is not stored',{modelKey:o.modelKey});
  const q=vectorBytes(queryVector,model.dimension);
  const limit=Number.isSafeInteger(o.limit)?Math.max(1,Math.min(100,o.limit)):10;
  const selectedSources=db.prepare([
    'SELECT s.echo_source_id,s.namespace,s.words_count,COUNT(v.word_ord) AS vector_count',
    'FROM echo_index_sources s LEFT JOIN echo_word_vectors v ON v.echo_source_id=s.echo_source_id AND v.model_key=?',
    "WHERE s.state='committed' AND (? IS NULL OR s.echo_source_id=?)",
    'GROUP BY s.echo_source_id,s.namespace,s.words_count ORDER BY s.echo_source_id'
  ].join(' ')).all(o.modelKey,o.echoSourceId||null,o.echoSourceId||null);
  if (o.echoSourceId && selectedSources.length!==1) fail('ECHO_VECTOR_SOURCE_INCOMPLETE','selected ECHO source is missing or not committed',{echoSourceId:o.echoSourceId});
  // ★★★ 2026-11-18：完整性判据必须认**这一套向量的覆盖口径**，不能一律拿全部词数硬套。
  //   起因（实测）：ECHO 里 67,509/122,630 行是**注入块**（system-reminder / runtime context /
  //   Instructions from），占 90.5% 字符。给它们建长文本向量毫无意义（同一段模板建几万份），
  //   所以建向量时**有意跳过**。这时「该有多少向量」就不是 words_count；
  //   一律拿 words_count 比，这套向量就**永远判不完整、永远检索不了**（实测撞到）。
  //   ★ 判据该问的是「有没有静默少命中」：按 spec 声明的覆盖口径算出该有的数，再比。
  const skipInjected = /skipInjected[":\s]*true/.test(String(model.preprocess_spec || ''));
  for(const source of selectedSources) {
    // ★★★ 2026-11-18 修：注入口径的应有条数**不再每次检索重算**。
    //   那段谓词是 6 个 LTRIM(...) LIKE 的 OR，对 echo_words 全表 122,630 行 /
    //   4.77 亿字符逐行扫 —— 实测 **3,238~3,295 ms**，而它算出来的是个常数。
    //   旧实现把它放在每次检索的路径上，「词层热检索 3.5 秒」里有 3.2 秒是在
    //   反复证明同一个 54,858。
    //   ★ 现在它与向量矩阵共用同一条 TTL（默认 30 秒）：判据没放松，
    //     只是同一份不变的数据不再每秒重算一遍。
    //   ★ 谓词仍从 echo-windows.mjs 的唯一真源生成 —— 那个「抄漏 [MNEMON /
    //     ⛬ 压缩索引导致 expected 55,121 vs 54,858、向量跑完也永远报不完整」
    //     的坑不会再回来。
    const expected = skipInjected
      ? expectedVectorCount(db, source.echo_source_id, o.modelKey, true)
      : source.words_count;
    if(expected!==source.vector_count) fail('ECHO_VECTOR_SOURCE_INCOMPLETE','selected ECHO source does not have a complete vector set',{echoSourceId:source.echo_source_id,expected,actual:source.vector_count,modelKey:o.modelKey,skipInjected});
  }

  // ★★★ 2026-11-18 性能：向量本体与元数据改由 echo-vector-cache.mjs 常驻内存。
  //   旧实现每次检索都重读 107MB BLOB、逐行算 sha256（539ms）、逐行 readFloatLE（1.12 亿次），
  //   再加上 JOIN 122,630 行 echo_words —— 合计 10.4 秒，其中 99% 是重复搬运。
  //   ★ 完整性/陈旧/校验和三件事一个都没省，只是把它们挪到**矩阵构建时做一次**：
  //     - 维度不符 → ECHO_VECTOR_STALE（构建时逐行查，与旧口径同序同码）
  //     - source_content_hash 与 content_hash 不符 → ECHO_VECTOR_STALE
  //     - vector_sha256 校验和不符 → ECHO_VECTOR_CORRUPT
  //   代价说明白：这些校验在缓存 TTL（默认 30 秒）内不重复做。
  //   要「每次都校验」，把 AGENT_SOUL_ECHO_VECTOR_CACHE_TTL_MS 设成 0。
  // ★ 查询向量在这里**解析一次**成 Float32Array。
  //   第一版我把它留在内层循环里（q.readFloatLE(i*4)），实测 54,858 行 × 512 次
  //   = 2,800 万次 readFloatLE，热检索仍是 3,918ms —— 换了个地方重复同样的错。
  const dim=model.dimension;
  const qv=new Float32Array(dim);
  let qn=0;
  for(let i=0;i<dim;i+=1){ const x=q.readFloatLE(i*4); qv[i]=x; qn+=x*x; }
  const qnorm=Math.sqrt(qn)||1;

  const scored=[];
  for(const source of selectedSources){
    const m=loadWordMatrix(db,source.echo_source_id,o.modelKey);
    const {n,flat,norms,ptrs,wordOrd:wordOrdArr}=m;
    for(let k=0;k<n;k+=1){
      const off=k*dim;
      let dot=0;
      for(let i=0;i<dim;i+=1) dot+=qv[i]*flat[off+i];
      const vnorm=norms[k];
      scored.push({echoSourceId:source.echo_source_id,ptr:ptrs[k],score:vnorm===0?0:dot/(qnorm*vnorm),wordOrd:wordOrdArr[k]});
    }
  }
  scored.sort((a,b)=>b.score-a.score||a.echoSourceId.localeCompare(b.echoSourceId)||a.ptr.localeCompare(b.ptr));
  const top=scored.slice(0,limit);
  // ★ 交付前校验「入选这几条」的词条没变（实测 0.62ms）。见 assertFreshRows 的注释。
  if(!strictMode()) {
    const bySource=new Map();
    for(const r of top){ const a=bySource.get(r.echoSourceId); if(a) a.push(r.wordOrd); else bySource.set(r.echoSourceId,[r.wordOrd]); }
    for(const [src,ords] of bySource) assertFreshRows(db,'word',src,o.modelKey,ords);
  }
  const authorities = new Map();
  for (const source of selectedSources) authorities.set(source.echo_source_id, readEchoAuthority(db, source.echo_source_id, 'ECHO_VECTOR_STALE'));
  const authority = requestedAuthority || (selectedSources.length === 1 ? authorities.get(selectedSources[0].echo_source_id) : null);
  const snapshotId = authority ? 'vector:' + authority.sourceId + ':' + o.modelKey + ':g' + authority.generation : null;
  return { modelKey:o.modelKey, authority: authority ? { sourceId:authority.sourceId, generation:authority.generation, state:authority.state, snapshotId } : null, generation: authority ? authority.generation : undefined, state: authority ? authority.state : undefined, authorities: Array.from(authorities.values()).map((a) => ({ sourceId:a.sourceId, generation:a.generation, state:a.state, snapshotId:'vector:' + a.sourceId + ':' + o.modelKey + ':g' + a.generation })), results:top.map((r)=>({echoSourceId:r.echoSourceId,ptr:r.ptr,score:r.score})) };
}
