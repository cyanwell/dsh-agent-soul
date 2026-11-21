
import fs from 'node:fs';
import path from 'node:path';
import { openMetaStore } from 'file:///D:/AI/agent-soul/src/db/index.mjs';
import { createBgeEmbedder, buildModelFingerprint } from 'file:///D:/AI/agent-soul/tools/echo-embed.mjs';
import { windowsOf, putWindowVectors } from 'file:///D:/AI/agent-soul/src/db/echo-windows.mjs';
import { registerEchoVectorModel } from 'file:///D:/AI/agent-soul/src/db/echo-vectors.mjs';

const store = openMetaStore({ path: 'D:/AI/agent-soul/data/meta.sqlite', mode: 'readwrite' });
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
  preprocessSpec: JSON.stringify({ queryPrefix: fp.queryPrefix, documentPrefix: fp.documentPrefix, maxInputChars: fp.maxInputChars, truncation: fp.truncation, granularity: 'sentence-window', targetChars: 192, maxChars: 512 }),
  poolingSpec: JSON.stringify({ pooling: fp.pooling, dtype: fp.dtype }),
  normalize: fp.normalized, dimension: fp.dimension, maxSeqLength: fp.maxInputChars,
};
const reg = registerEchoVectorModel(db, spec);
console.log('windowModelKey=' + reg.modelKey);
const w = db.prepare('SELECT word_ord, content_hash, text FROM echo_words WHERE echo_source_id=? AND word_ord=?').get(sid, 16901);
const wins = windowsOf(w.text);
console.log('windows=' + wins.length);
const emb = await createBgeEmbedder({ expectedModelFingerprint: fp });
const vecs = await emb.embedDocuments(wins.map(x=>x.text));
const rows = wins.map((win,i)=>({ wordOrd: w.word_ord, windowOrd: win.index, charStart: win.start, charEnd: win.end, text: win.text, sourceContentHash: w.content_hash, vector: vecs[i].vector }));
putWindowVectors(db, sid, reg.modelKey, fp.dimension, rows, { mode: 'upsert' });
const n = db.prepare('SELECT COUNT(*) n FROM echo_word_windows WHERE echo_source_id=? AND model_key=?').get(sid, reg.modelKey).n;
console.log('totalAfterFix=' + n);
