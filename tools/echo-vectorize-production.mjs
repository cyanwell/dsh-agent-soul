#!/usr/bin/env node
// 生产库向量化：把 ECHO 的每个词写成 BGE 向量。
// ★ 护栏：必须显式给 --yes-production 才允许写 data/meta.sqlite；
//   否则只接受 tempdir 下的副本（记忆里那条「测量脚本必须先拒绝写生产路径」）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { openMetaStore } from '../src/db/index.mjs';
import { registerEchoVectorModel, putEchoSourceVectors } from '../src/db/echo-vectors.mjs';
import { createBgeEmbedder, buildModelFingerprint, DEFAULT_MODEL_DIR } from './echo-embed.mjs';
import { isInjectedText, injectedSqlWhere } from '../src/db/echo-windows.mjs';

const args = process.argv.slice(2);
const argOf = (flag) => { const a = args.find((x) => x.startsWith(flag + '=')); return a ? a.slice(flag.length + 1) : null; };
const dbArg = argOf('--db') || 'D:/AI/agent-soul/data/meta.sqlite';
const confirmed = args.includes('--yes-production');
// ★ 2026-11-20 收紧：原来只在「正好等于开发库路径」时要求旗标，别的路径一律放行 ——
//   部署之后生产库变成 <根>/data/meta.sqlite，那条判据就不再拦任何东西。
//   现在的口径是**白名单**：要么显式声明这是生产库（--yes-production），
//   要么库必须在系统临时目录里（副本）。别的地方一律拒绝，不认识就不写。
const inTmp = (() => {
  const t = path.resolve(os.tmpdir());
  const d = path.resolve(dbArg);
  return d === t || d.startsWith(t + path.sep);
})();
if (!confirmed && !inTmp) {
  console.error('REFUSE: 只写 tempdir 下的副本；要写生产库必须显式传 --yes-production');
  process.exit(3);
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
// ★ 2026-11-20：模型目录**不再自己拼**，改用 echo-embed.mjs 里那份三候选解析
//   （<根>/app/<版本>/models → <根>/models）。自己拼会在部署后指向空的 app/<版本>/models。
const modelDir = argOf('--model-dir') || process.env.ECHO_BGE_MODEL_DIR || DEFAULT_MODEL_DIR;
const fp = buildModelFingerprint({
  modelDir,
  modelBytes: fs.readFileSync(path.join(modelDir, 'onnx', 'model_quantized.onnx')),
  tokenizerBytes: fs.readFileSync(path.join(modelDir, 'tokenizer.json')),
  configBytes: fs.readFileSync(path.join(modelDir, 'config.json')),
  transformersVersion: '4.3.2',
});
// ★★★ 2026-11-18：**跳过注入块，并把这件事写进 spec**。
//   起因（实测）：这套向量原来给全部 122,630 个词建。而其中 67,772 条（55.3%）是注入块，
//   光 Current runtime context. 就有 64,379 条 —— 平均 5,857 字，抽样前 8 条开头一字不差。
//   BGE 的 maxInputChars=1000，它们被截断后全都是「Current runtime context. This snapshot
//   supersedes…」同一个开头的向量，彼此余弦≈1 —— 检索时会把真实记忆整个挤掉。
//   改后：目标 122,630 → 54,858，省掉的正是这 6.7 万条垃圾。
//
//   ★ 另一半坑：读侧的完整性判据靠 preprocess_spec 里的 skipInjected 决定「该有多少」。
//   写侧跳了却不声明，读侧就按全量要 → 永远 ECHO_VECTOR_SOURCE_INCOMPLETE（实测撞到）。
//   所以 skipInjected 必须写进 preprocessSpec，它参与 model_key 的 sha256，读写两侧同源。
const skipInjected = !args.includes('--include-injected');
const spec = {
  modelId: fp.modelId, revision: fp.modelRevision, modelSha256: fp.modelSha256,
  tokenizerSpec: JSON.stringify({ sha256: fp.tokenizerSha256, configSha256: fp.configSha256 }),
  preprocessSpec: JSON.stringify({ queryPrefix: fp.queryPrefix, documentPrefix: fp.documentPrefix, maxInputChars: fp.maxInputChars, truncation: fp.truncation, skipInjected }),
  poolingSpec: JSON.stringify({ pooling: fp.pooling, dtype: fp.dtype }),
  normalize: fp.normalized, dimension: fp.dimension, maxSeqLength: fp.maxInputChars,
};

const store = openMetaStore({ path: dbArg, mode: 'readwrite' });
store.migrate();
const db = store.db;
const reg = registerEchoVectorModel(db, spec);
console.log('modelKey=' + reg.modelKey);

const srcRow = db.prepare('SELECT echo_source_id, words_count FROM echo_index_sources').get();
const sid = srcRow.echo_source_id;
const total = Number(srcRow.words_count);
const have = Number(db.prepare('SELECT COUNT(*) AS n FROM echo_word_vectors WHERE echo_source_id=? AND model_key=?').get(sid, reg.modelKey).n);
console.log('source=' + sid + ' words=' + total + ' vectorsAlready=' + have);

const t0 = Date.now();
const emb = await createBgeEmbedder({ expectedModelFingerprint: fp });
console.log('modelLoadedMs=' + (Date.now() - t0) + ' device=' + emb.device());

// 去重：同一段文本在多个位置出现时，embedding 只算一次（与窗口层同一套做法）。
// ★ 存的是 Float32Array 本体；实测非注入词里重复率不高，缓存占用可控。
const vecCache = new Map();
let embedCalls = 0, cacheHits = 0, skippedInjected = 0;
const BATCH = 128;
const SCAN = 512;   // 每轮从 DB 取的原始行数（要大于 BATCH，因为会过滤掉一些）
let written = have;
let cursor = Number(db.prepare('SELECT COALESCE(MAX(word_ord), -1) AS m FROM echo_word_vectors WHERE echo_source_id=? AND model_key=?').get(sid, reg.modelKey).m);
const expectTotal = skipInjected
  ? Number(db.prepare('SELECT COUNT(*) AS n FROM echo_words WHERE echo_source_id=? AND NOT (' + injectedSqlWhere('text') + ')').get(sid).n)
  : total;
console.log('expectTotal=' + expectTotal + ' (skipInjected=' + skipInjected + ')');
const tStart = Date.now();
let scanned = 0;
for (;;) {
  const rows = db.prepare([
    'SELECT w.word_ord, w.content_hash, w.text FROM echo_words w',
    'WHERE w.echo_source_id=? AND w.word_ord > ? ORDER BY w.word_ord LIMIT ?',
  ].join(' ')).all(sid, cursor, SCAN);
  if (!rows.length) break;
  cursor = rows[rows.length - 1].word_ord;
  scanned += rows.length;
  const keep = skipInjected ? rows.filter((r) => !isInjectedText(r.text)) : rows;
  skippedInjected += rows.length - keep.length;
  for (let i = 0; i < keep.length; i += BATCH) {
    const batch = keep.slice(i, i + BATCH);
    if (!batch.length) continue;
    const miss = batch.filter((b) => !vecCache.has(b.content_hash));
    cacheHits += batch.length - miss.length;
    if (miss.length) {
      const vecs = await emb.embedDocuments(miss.map((b) => b.text));
      embedCalls += miss.length;
      miss.forEach((b, k) => vecCache.set(b.content_hash, vecs[k].vector));
    }
    putEchoSourceVectors(db, sid, spec, batch.map((b) => ({ wordOrd: b.word_ord, contentHash: b.content_hash, vector: vecCache.get(b.content_hash) })), { mode: 'upsert' });
    written += batch.length;
  }
  if (written % 2048 < BATCH + SCAN) {
    const pct = (written / expectTotal * 100).toFixed(1);
    const el = (Date.now() - tStart) / 1000;
    const eta = written > 0 ? el / written * (expectTotal - written) : 0;
    console.log('  ' + written + '/' + expectTotal + ' (' + pct + '%)  scan=' + scanned + ' skip=' + skippedInjected + '  ' + el.toFixed(0) + 's  eta ' + eta.toFixed(0) + 's');
  }
}
const ms = Date.now() - tStart;
const final = Number(db.prepare('SELECT COUNT(*) AS n FROM echo_word_vectors WHERE echo_source_id=? AND model_key=?').get(sid, reg.modelKey).n);
console.log(JSON.stringify({ ms, vectors: final, expected: expectTotal, complete: final === expectTotal, skipInjected, scanned, skippedInjected, embedCalls, cacheHits, uniqueCached: vecCache.size }));
store.close();