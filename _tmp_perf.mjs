
import crypto from 'node:crypto';
import { openMetaStore } from 'file:///D:/AI/agent-soul/src/db/index.mjs';
const store = openMetaStore({ path: 'D:/AI/agent-soul/data/meta.sqlite', mode: 'readonly' });
const db = store.db;
const KEY='6537613a94d22026a60e9cc2dde43bb5c66c7b1c1b0d8dc7ae998de53ce50fed';
let t=Date.now();
const rows=db.prepare("SELECT v.word_ord,v.vector_blob,v.vector_sha256,w.content_hash FROM echo_word_vectors v JOIN echo_words w ON w.echo_source_id=v.echo_source_id AND w.word_ord=v.word_ord WHERE v.model_key=?").all(KEY);
const tRead=Date.now()-t;
t=Date.now();
let bad=0;
for(const r of rows){ const h=crypto.createHash('sha256').update(r.vector_blob).digest('hex'); if(h!==r.vector_sha256) bad++; }
const tSha=Date.now()-t;
t=Date.now();
let acc=0;
for(const r of rows){ const b=Buffer.from(r.vector_blob.buffer||r.vector_blob, r.vector_blob.byteOffset||0, r.vector_blob.byteLength); let dot=0; for(let i=0;i<512;i++){ dot+=b.readFloatLE(i*4); } acc+=dot; }
const tDot=Date.now()-t;
console.log(JSON.stringify({rows:rows.length,tReadMs:tRead,tShaMs:tSha,tDotMs:tDot,badHash:bad,acc:Number(acc.toFixed(2))}));
