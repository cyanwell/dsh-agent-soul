// 向量层落地：把 ECHO 的词写成 BGE 向量。**只跑生产库之外**——
// ★ 硬护栏（本机纪律）：先断言目标是副本，否则拒绝跑。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openMetaStore } from '../src/db/index.mjs';
import { registerEchoVectorModel, putEchoSourceVectors } from '../src/db/echo-vectors.mjs';
import { createBgeEmbedder, buildModelFingerprint } from '../tools/echo-embed.mjs';

const DB = process.argv[2] || '';
if (!DB) { console.error('usage: <db-copy-path>'); process.exit(2); }
if (/data\\meta\.sqlite$/.test(DB) || DB === 'D:/AI/agent-soul/data/meta.sqlite') {
  console.error('REFUSE: never run against the production database'); process.exit(3);
}

const modelDir = 'D:/AI/agent-soul/models/bge-small-zh';
const fp = buildModelFingerprint({
  modelDir,
  modelBytes: fs.readFileSync(path.join(modelDir, 'onnx', 'model_quantized.onnx')),
  tokenizerBytes: fs.readFileSync(path.join(modelDir, 'tokenizer.json')),
  configBytes: fs.readFileSync(path.join(modelDir, 'config.json')),
  transformersVersion: '4.3.2',
});

const store = openMetaStore({ path: DB, mode: 'readwrite' });
store.migrate();
const db = store.db;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

const sources = db.prepare('SELECT echo_source_id, words_count FROM echo_index_sources').all();
const report = { db: DB, sources: sources.length, modelKey: null, perSource: [] };

const emb = await createBgeEmbedder({ expectedModelFingerprint: fp });
const spec = {
  modelKey: 'bge-small-zh-v1.5-q8',
  modelId: fp.modelId,
  revision: fp.modelRevision,
  modelSha256: fp.modelSha256,
  tokenizerSpec: fp.tokenizerSha256,
  preprocessSpec: fp.queryPrefix + '|' + fp.truncation,
  poolingSpec: fp.pooling,
  normalize: fp.normalized,
  dimension: fp.dimension,
  maxSeqLength: fp.maxInputChars,
  specSha256: sha256(JSON.stringify([fp.modelId, fp.modelRevision, fp.modelSha256, fp.tokenizerSha256, fp.dimension, fp.pooling, fp.normalized])),
};
report.modelKey = registerEchoVectorModel(db, spec).modelKey;

for (const src of sources) {
  const words = db.prepare('SELECT word_ord, content_hash, text FROM echo_words WHERE echo_source_id=? ORDER BY word_ord').all(src.echo_source_id);
  if (!words.length) { report.perSource.push({ id: src.echo_source_id, words: 0, vectors: 0 }); continue; }
  const BATCH = 64;
  let written = 0;
  const t0 = Date.now();
  for (let i = 0; i < words.length; i += BATCH) {
    const chunk = words.slice(i, i + BATCH);
    const vectors = await emb.embedDocuments(chunk.map((w) => w.text));
    const rows = chunk.map((w, k) => ({ wordOrd: w.word_ord, contentHash: w.content_hash, vector: vectors[k].vector }));
    putEchoSourceVectors(db, src.echo_source_id, spec, rows, { mode: 'upsert' });
    written += rows.length;
  }
  report.perSource.push({ id: src.echo_source_id, words: words.length, vectors: written, ms: Date.now() - t0 });
}
const totalVectors = db.prepare("SELECT COUNT(*) AS n FROM echo_word_vectors").get().n;
report.totalVectors = Number(totalVectors);
report.models = db.prepare("SELECT model_key, dimension FROM echo_vector_models").all();
console.log(JSON.stringify(report, null, 1));
store.close();
