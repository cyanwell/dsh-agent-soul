
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
const require = createRequire('D:/AI/agent-soul/models/bge-small-zh/package.json');
const { pipeline, env } = require('@huggingface/transformers');
const modelDir = 'D:/AI/agent-soul/models/bge-small-zh';
env.allowRemoteModels = false; env.allowLocalModels = true; env.localModelPath = modelDir; env.useBrowserCache = false;
const db = new DatabaseSync('D:/AI/agent-soul/data/meta.sqlite', { readOnly: true });
const rows = db.prepare("SELECT text FROM echo_words WHERE length(text) >= 900 ORDER BY word_ord LIMIT 8").all();
const texts = rows.map(r => String(r.text).slice(0,1000));
const out = {};
for (const dev of ['cpu','dml']) {
  const pipe = await pipeline('feature-extraction', modelDir, { dtype:'q8', device: dev });
  const r = await pipe(texts, { pooling:'mean', normalize:true });
  const dim = r.dims[r.dims.length-1];
  out[dev] = [];
  for (let i=0;i<texts.length;i++) out[dev].push(Array.from(r.data.slice(i*dim,(i+1)*dim)));
}
const cos = (a,b) => { let d=0,na=0,nb=0; for(let i=0;i<a.length;i++){d+=a[i]*b[i];na+=a[i]*a[i];nb+=b[i]*b[i];} return d/Math.sqrt(na*nb); };
const primes = out.cpu.map((v,i)=>cos(v,out.dml[i]));
const maxAbs = out.cpu.map((v,i)=>Math.max(...v.map((x,j)=>Math.abs(x-out.dml[i][j]))));
console.log('n=' + texts.length);
console.log('cosine cpu-vs-dml: ' + primes.map(x=>x.toFixed(8)).join(' '));
console.log('minCosine=' + Math.min(...primes).toFixed(8) + '  maxComponentDelta=' + Math.max(...maxAbs).toExponential(2));
// 关键：这个量级的差异会不会改变检索排序？看 c7 与随机向量的分差是否被淹没
