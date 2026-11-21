
import fs from 'node:fs';
import path from 'node:path';
import { openMetaStore } from 'file:///D:/AI/agent-soul/src/db/index.mjs';
import { createBgeEmbedder, buildModelFingerprint } from 'file:///D:/AI/agent-soul/tools/echo-embed.mjs';
import { findEchoVectorModel } from 'file:///D:/AI/agent-soul/src/db/echo-vectors.mjs';
import { searchWindowVectors } from 'file:///D:/AI/agent-soul/src/db/echo-window-search.mjs';

const store = openMetaStore({ path: 'D:/AI/agent-soul/data/meta.sqlite', mode: 'readonly' });
const db = store.db;
const sid = db.prepare("SELECT echo_source_id FROM echo_index_sources WHERE state='committed'").get().echo_source_id;
const modelDir = 'D:/AI/agent-soul/models/bge-small-zh';
const fp = buildModelFingerprint({ modelDir,
  modelBytes: fs.readFileSync(path.join(modelDir,'onnx','model_quantized.onnx')),
  tokenizerBytes: fs.readFileSync(path.join(modelDir,'tokenizer.json')),
  configBytes: fs.readFileSync(path.join(modelDir,'config.json')),
  transformersVersion: '4.3.2' });
const spec = {
  modelId: fp.modelId, revision: fp.modelRevision, modelSha256: fp.modelSha256,
  tokenizerSpec: JSON.stringify({ sha256: fp.tokenizerSha256, configSha256: fp.configSha256 }),
  preprocessSpec: JSON.stringify({ queryPrefix: fp.queryPrefix, documentPrefix: fp.documentPrefix, maxInputChars: fp.maxInputChars, truncation: fp.truncation, granularity: 'sentence-window' }),
  poolingSpec: JSON.stringify({ pooling: fp.pooling, dtype: fp.dtype }),
  normalize: fp.normalized, dimension: fp.dimension, maxSeqLength: fp.maxInputChars,
};
const m = findEchoVectorModel(db, spec, { granularity: 'sentence-window' });
console.log('windowModel=' + (m && m.modelKey) + ' candidates=' + (m && m.candidates));
const emb = await createBgeEmbedder({ expectedModelFingerprint: fp });
for (const q of ['向量检索跑在显卡上快多少', '空白窗口为什么会炸掉向量化']) {
  const qs = await emb.embedQueries([q]);
  const t=Date.now();
  const r = searchWindowVectors(db, qs[0].vector, { modelKey: m.modelKey, echoSourceId: sid, limit: 3 });
  console.log('Q=' + q + ' ms=' + (Date.now()-t) + ' scanned=' + r.scanned);
  for (const h of r.results) console.log('   ' + h.score.toFixed(4) + '  ' + (h.ptr||'') + '  chars[' + h.charStart + ',' + h.charEnd + ']  ' + String(h.text||'').slice(0,60).replace(/\s+/g,' '));
}
