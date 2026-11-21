
import fs from 'node:fs';
import path from 'node:path';
import { openMetaStore } from 'file:///D:/AI/agent-soul/src/db/index.mjs';
import { createBgeEmbedder, buildModelFingerprint } from 'file:///D:/AI/agent-soul/tools/echo-embed.mjs';
import { findEchoVectorModel, searchEchoSourceVectors } from 'file:///D:/AI/agent-soul/src/db/echo-vectors.mjs';

const store = openMetaStore({ path: 'D:/AI/agent-soul/data/meta.sqlite', mode: 'readonly' });
const db = store.db;
const sid = db.prepare("SELECT echo_source_id FROM echo_index_sources WHERE state='committed'").get().echo_source_id;

const modelDir = 'D:/AI/agent-soul/models/bge-small-zh';
const fp = buildModelFingerprint({
  modelDir,
  modelBytes: fs.readFileSync(path.join(modelDir,'onnx','model_quantized.onnx')),
  tokenizerBytes: fs.readFileSync(path.join(modelDir,'tokenizer.json')),
  configBytes: fs.readFileSync(path.join(modelDir,'config.json')),
  transformersVersion: '4.3.2',
});
const emb = await createBgeEmbedder({ expectedModelFingerprint: fp });
console.log('device=' + emb.device());

const spec = {
  modelId: fp.modelId, revision: fp.modelRevision, modelSha256: fp.modelSha256,
  tokenizerSpec: JSON.stringify({ sha256: fp.tokenizerSha256, configSha256: fp.configSha256 }),
  preprocessSpec: JSON.stringify({ queryPrefix: fp.queryPrefix, documentPrefix: fp.documentPrefix, maxInputChars: fp.maxInputChars, truncation: fp.truncation, skipInjected: true }),
  poolingSpec: JSON.stringify({ pooling: fp.pooling, dtype: fp.dtype }),
  normalize: fp.normalized, dimension: fp.dimension, maxSeqLength: fp.maxInputChars,
};
const model = findEchoVectorModel(db, spec, { granularity: null });
console.log('wordModel=' + (model && model.modelKey) + ' candidates=' + (model && model.candidates));

for (const q of ['向量检索是怎么实现的', 'BGE 模型用 CPU 还是显卡']) {
  const t0 = Date.now();
  const qs = await emb.embedQueries([q]);
  const embedMs = Date.now() - t0;
  const t1 = Date.now();
  const r = searchEchoSourceVectors(db, qs[0].vector, { modelKey: model.modelKey, echoSourceId: sid, limit: 3 });
  console.log('QUERY=' + q + ' embedMs=' + embedMs + ' searchMs=' + (Date.now()-t1) + ' scanned=' + r.scanned);
  for (const hit of r.results) console.log('   ' + hit.score.toFixed(4) + '  ' + hit.ptr);
}
