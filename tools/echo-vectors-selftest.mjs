#!/usr/bin/env node
// TEMP-only SQLite BGE vector tests. Fixture ECHO source is imported through the public importer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openMetaStore } from '../src/db/index.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url));
const FIXTURE=path.join(HERE,'fixtures','echo-index-import','corpus','manifest.json');
const IMPORTER=path.join(HERE,'echo-index-import.mjs');
const ROOT=fs.mkdtempSync(path.join(os.tmpdir(),'echo-vectors-selftest-'));
const DB=path.join(ROOT,'meta.sqlite');
const NODE=process.execPath;
const sha=(b)=>createHash('sha256').update(b).digest('hex');
const spec={modelId:'BAAI/bge-small-zh-v1.5',revision:'local-test',modelSha256:'a'.repeat(64),tokenizerSpec:'tokenizer-sha256:'+'b'.repeat(64),preprocessSpec:'bge-small-zh-v1.5:q-only-prefix-v1',poolingSpec:'mean-l2-f32le-v1',normalize:true,dimension:3,maxSeqLength:512};
const manifest=JSON.parse(fs.readFileSync(FIXTURE,'utf8'));
let store=null; const passed=[];
function ok(name,fn){fn();passed.push(name);console.log('PASS '+name)}
try {
  store=openMetaStore({path:DB,mode:'readwrite'}); store.migrate();
  store.close(); store=null;
  const imported=spawnSync(NODE,[IMPORTER,'--manifest',FIXTURE,'--sha256',sha(fs.readFileSync(FIXTURE)),'--generation','1','--db',DB,'--json'],{encoding:'utf8'});
  if(imported.status!==0) throw new Error('TEMP ECHO importer failed: '+imported.stdout+' '+imported.stderr);
  const importReceipt=JSON.parse(imported.stdout);
  assert.equal(importReceipt.code,'IMPORTED');
  const sourceId=importReceipt.source.echoSourceId;
  store=openMetaStore({path:DB,mode:'readwrite'});
  const words=store.db.prepare('SELECT echo_source_id,word_ord,session,seq,text,content_hash FROM echo_words WHERE echo_source_id=? ORDER BY word_ord').all(sourceId);
  assert.equal(words.length,6);
  const related=words.filter((w)=>w.text.includes('解耦'));
  assert.equal(related.length,3);
  const canary=words.find((w)=>w.text.includes('8f3a'));
  const vectors=words.map((w)=>({wordOrd:w.word_ord,contentHash:w.content_hash,vector:w.text.includes('解耦')?[1,0,0]:w.text.includes('8f3a')?[0,1,0]:[0,0,1]}));
  let modelKey=null;
  ok('v10 schema creates model and vector tables in TEMP DB',()=>assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('echo_vector_models','echo_word_vectors')").get().n,2));
  const registration=store.echoVectorRegister(spec);
  const put=store.echoVectorPut(sourceId,spec,vectors);
  modelKey=put.modelKey;
  const expectedRelated=related.map((w)=>'log:'+w.session+'#seq='+w.seq).sort((a,b)=>a.localeCompare(b));
  const expectedCanary='log:'+canary.session+'#seq='+canary.seq;
  const canaryHit=store.echoVectorSearch([0,1,0],{modelKey,echoSourceId:sourceId,limit:1});
  ok('vectors persist by source and word_ord without text duplication',()=>{assert.equal(put.rows,6);assert.equal(put.modelKey,modelKey);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM echo_word_vectors WHERE echo_source_id=?').get(sourceId).n,6);const cols=store.db.prepare('PRAGMA table_info(echo_word_vectors)').all().map(x=>x.name);assert.equal(cols.includes('text'),false);});
  const hit=store.echoVectorSearch([1,0,0],{modelKey,echoSourceId:sourceId,limit:10});
  ok('search ranks related pointers first and returns pointer-only results',()=>{assert.deepEqual(hit.results.slice(0,2).map(x=>x.ptr).sort(),expectedRelated.slice(0,2));assert.ok(hit.results.every(x=>!Object.hasOwn(x,'text')&&x.echoSourceId===sourceId));assert.equal(hit.results[0].score,1);assert.equal(hit.results[1].score,1);assert.ok(hit.results.find(x=>x.ptr===expectedCanary).score<1);});
  ok('a different canary vector retrieves its own authoritative pointer',()=>{assert.equal(canaryHit.results[0].ptr,expectedCanary);});
  const readonlyStore=openMetaStore({path:DB,mode:'readonly'});
  try { ok('readonly Store facade rejects vector writes',()=>assert.throws(()=>readonlyStore.echoVectorPut(sourceId,spec,[vectors[0]]),(e)=>e.code==='READONLY')); }
  finally { readonlyStore.close(); }
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM echo_word_vectors WHERE echo_source_id=?').get(sourceId).n,6);
  assert.throws(()=>store.echoVectorPut(sourceId,spec,[{...vectors[0],contentHash:'c'.repeat(64)}]),(e)=>e.code==='ECHO_VECTOR_STALE');
  ok('mismatched content hash is rejected transactionally',()=>assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM echo_word_vectors WHERE echo_source_id=?').get(sourceId).n,6));
  const changed=store.db.prepare('SELECT text,session,seq,log,kind,role FROM echo_words WHERE echo_source_id=? AND word_ord=?').get(sourceId,related[0].word_ord);
  store.db.prepare('UPDATE echo_words SET content_hash=? WHERE echo_source_id=? AND word_ord=?').run('d'.repeat(64),sourceId,related[0].word_ord);
  assert.throws(()=>store.echoVectorSearch([1,0,0],{modelKey,echoSourceId:sourceId}),(e)=>e.code==='ECHO_VECTOR_STALE');
  store.db.prepare('UPDATE echo_words SET content_hash=? WHERE echo_source_id=? AND word_ord=?').run(related[0].content_hash,sourceId,related[0].word_ord);
  ok('changed ECHO word hash makes vector search fail closed as stale',()=>assert.equal(changed.kind,'message'));
  const readStore=openMetaStore({path:DB,mode:'readonly'});
  try {
    readStore.ensureReady();
    let readonlyError=null;
    try { readStore.echoVectorPut(sourceId,spec,vectors); } catch (err) { readonlyError=err; }
    assert.ok(readonlyError,'readonly Store must reject vector writes');
    assert.equal(readonlyError.code,'READONLY');
  } finally { readStore.close(); }
  passed.push('readonly Store refuses vector writes'); console.log('PASS readonly Store refuses vector writes');
  ok('delete clears vectors and prunes unused model spec',()=>{assert.equal(store.echoVectorDelete(sourceId,modelKey),6);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM echo_word_vectors').get().n,0);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM echo_vector_models').get().n,0);});
  console.log(passed.length+' vector checks passed');
} finally {
  if(store) store.close();
  fs.rmSync(ROOT,{recursive:true,force:true});
  assert.equal(fs.existsSync(ROOT),false,'TEMP root removed');
}
