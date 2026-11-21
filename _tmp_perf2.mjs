
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('D:/AI/agent-soul/data/meta.sqlite', { readOnly: true });
const sid = db.prepare('SELECT echo_source_id FROM echo_index_sources').get().echo_source_id;
const KEY='c7c0c12a8dba770c67904b2538a00c06cc8c35722ac4be71df4b63ac8ef33518';
const dim=512; const q=new Float32Array(dim).fill(0.04);

let t=Date.now();
const rows=db.prepare('SELECT word_ord,window_ord,char_start,char_end,vector_dimension,vector_blob FROM echo_word_windows WHERE echo_source_id=? AND model_key=? ORDER BY word_ord,window_ord').all(sid,KEY);
const tRead=Date.now()-t;

// 方式 A：readFloatLE 逐字节（现状）
t=Date.now(); let best=0;
for(const r of rows){ const b=Buffer.isBuffer(r.vector_blob)?r.vector_blob:Buffer.from(r.vector_blob.buffer,r.vector_blob.byteOffset,r.vector_blob.byteLength); let d=0; for(let i=0;i<dim;i++) d+=q[i]*b.readFloatLE(i*4); if(d>best) best=d; }
const tA=Date.now()-t;

// 方式 B：Float32Array 视图 + 对齐复制
t=Date.now(); best=0;
for(const r of rows){ const u=r.vector_blob; const f=(u.byteOffset%4===0)? new Float32Array(u.buffer,u.byteOffset,dim) : new Float32Array(Uint8Array.prototype.slice.call(u,0,dim*4).buffer); let d=0; for(let i=0;i<dim;i++) d+=q[i]*f[i]; if(d>best) best=d; }
const tB=Date.now()-t;

console.log(JSON.stringify({rows:rows.length,tReadMs:tRead,tA_ms:tA,tB_ms:tB,bestA:Number(best.toFixed(4))}));
