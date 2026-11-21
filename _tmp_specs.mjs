
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { buildModelFingerprint } from 'file:///D:/AI/agent-soul/tools/echo-embed.mjs';
const db = new DatabaseSync('D:/AI/agent-soul/data/meta.sqlite', { readOnly: true });
const rows = db.prepare('SELECT * FROM echo_vector_models').all();
for (const r of rows) {
  console.log('--- model_key=' + r.model_key);
  for (const k of Object.keys(r)) if (k !== 'model_key') console.log('   ' + k + ' = ' + String(r[k]).slice(0,200));
}
const modelDir = 'D:/AI/agent-soul/models/bge-small-zh';
const fp = buildModelFingerprint({
  modelDir,
  modelBytes: fs.readFileSync(path.join(modelDir,'onnx','model_quantized.onnx')),
  tokenizerBytes: fs.readFileSync(path.join(modelDir,'tokenizer.json')),
  configBytes: fs.readFileSync(path.join(modelDir,'config.json')),
  transformersVersion: '4.3.2',
});
console.log('=== actual fp ===');
console.log(JSON.stringify(fp, null, 1));
