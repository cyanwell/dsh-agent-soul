
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
const log = (s) => { fs.appendFileSync('D:/AI/agent-soul/_bench.log', s + '\n'); console.log(s); };
const require = createRequire('D:/AI/agent-soul/models/bge-small-zh/package.json');
const { pipeline, env } = require('@huggingface/transformers');
const modelDir = 'D:/AI/agent-soul/models/bge-small-zh';
env.allowRemoteModels = false; env.allowLocalModels = true; env.localModelPath = modelDir; env.useBrowserCache = false;
const db = new DatabaseSync('D:/AI/agent-soul/data/meta.sqlite', { readOnly: true });
const rows = db.prepare("SELECT text FROM echo_words WHERE length(text) >= 900 ORDER BY word_ord LIMIT 24").all();
const texts = rows.map(r => String(r.text).slice(0, 1000));
log('sample=' + texts.length + ' avgLen=' + Math.round(texts.reduce((a,b)=>a+b.length,0)/Math.max(1,texts.length)));
for (const dev of ['cpu','dml']) {
  let pipe; const t0 = Date.now();
  try { pipe = await pipeline('feature-extraction', modelDir, { dtype: 'q8', device: dev }); }
  catch (e) { log(dev + ' LOAD_FAIL ' + String(e.message).slice(0,200)); continue; }
  log(dev + ' loadMs=' + (Date.now()-t0));
  for (const b of [8]) {
    await pipe(texts.slice(0,b), { pooling:'mean', normalize:true });
    const t1 = Date.now(); let n = 0;
    for (let i=0;i<texts.length;i+=b) { const c = texts.slice(i,i+b); if(!c.length) break; await pipe(c,{pooling:'mean',normalize:true}); n += c.length; }
    const ms = Date.now()-t1;
    log(dev + ' b=' + b + ' n=' + n + ' ms=' + ms + ' msPerItem=' + (ms/n).toFixed(1) + ' perSec=' + (n/(ms/1000)).toFixed(2));
  }
}
log('DONE');
