#!/usr/bin/env node
// TEMP-only end-to-end ECHO vector build/search proof through the public importer and Store facade.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { openMetaStore } from '../src/db/index.mjs';
import { runVectorCli } from './echo-vector-build.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url));
const NODE=process.execPath;
const FIXTURE=path.join(HERE,'fixtures','echo-index-import','corpus');
const ROOT=fs.mkdtempSync(path.join(os.tmpdir(),'echo-vector-build-selftest-'));
const CORPUS=path.join(ROOT,'corpus');
const DB=path.join(ROOT,'meta.sqlite');
const MODEL=path.join(ROOT,'fake-model');
const EXPECTED=path.join(ROOT,'fingerprint.json');
const sha=(b)=>createHash('sha256').update(b).digest('hex');
const fingerprint={modelId:'BAAI/bge-small-zh-v1.5',modelRevision:'test-pinned',transformersVersion:'4.3.2',modelSha256:'a'.repeat(64),tokenizerSha256:'b'.repeat(64),configSha256:'c'.repeat(64),dimension:512,dtype:'q8',pooling:'mean',normalized:true,queryPrefix:'query-prefix:',documentPrefix:'',maxInputChars:1000,truncation:'test-code-units'};
const checks=[];const check=(name,fn)=>{fn();checks.push(name);console.log('PASS '+name)};
let store=null;
function makeEmbedder(){
  const vectorFor=(text,kind)=>{const v=new Float32Array(512);v[text.includes('解耦')?0:1]=1;return {vector:v,kind,modelFingerprint:fingerprint,inputSha256:sha(Buffer.from(text,'utf8'))};};
  return {fingerprint,embedDocuments:async(texts)=>texts.map((text)=>vectorFor(text,'document')),embedQueries:async(texts)=>texts.map((text)=>vectorFor(text,'query'))};
}
async function capture(argv){
  const original=process.stdout.write;const chunks=[];
  process.stdout.write=function(chunk){chunks.push(Buffer.from(chunk));return true;};
  try{const code=await runVectorCli(argv,{createEmbedder:async()=>makeEmbedder()});return {code,text:Buffer.concat(chunks).toString('utf8')};}
  finally{process.stdout.write=original;}
}
try{
  fs.cpSync(FIXTURE,CORPUS,{recursive:true});
  fs.mkdirSync(MODEL,{recursive:true});
  fs.writeFileSync(EXPECTED,JSON.stringify(fingerprint));
  store=openMetaStore({path:DB,mode:'readwrite'});store.migrate();store.close();store=null;
  const manifestPath=path.join(CORPUS,'manifest.json');
  const imported=spawnSync(NODE,[path.join(HERE,'echo-index-import.mjs'),'--manifest',manifestPath,'--sha256',sha(fs.readFileSync(manifestPath)),'--generation','1','--db',DB,'--json'],{encoding:'utf8'});
  if(imported.status!==0)throw new Error('TEMP importer failed: '+imported.stdout+' '+imported.stderr);
  const receipt=JSON.parse(imported.stdout);assert.equal(receipt.code,'IMPORTED');
  const sourceId=receipt.source.echoSourceId;
  const base=['--db',DB,'--echo-source-id',sourceId,'--model-dir',MODEL,'--expected-fingerprint',EXPECTED];
  const built=await capture(['--mode','build',...base]);assert.equal(built.code,0);const buildReceipt=JSON.parse(built.text);assert.equal(buildReceipt.rows,6);
  const searched=await capture(['--mode','search',...base,'--query','关于解耦的语义查询','--limit','10']);assert.equal(searched.code,0);const searchReceipt=JSON.parse(searched.text);
  assert.ok(searchReceipt.results.length>0);assert.ok(searchReceipt.results.every(x=>x.ptr.startsWith('log:')||x.ptr.startsWith('v4log:')));assert.ok(searchReceipt.results.every(x=>x.echoSourceId===sourceId&&Number.isFinite(x.score)&&!Object.hasOwn(x,'text')));
  store=openMetaStore({path:DB,mode:'readonly'});store.ensureReady();
  const vectorCount=store.db.prepare('SELECT COUNT(*) AS n FROM echo_word_vectors WHERE echo_source_id=?').get(sourceId).n;
  check('public importer loads six fixture words into TEMP SQLite',()=>assert.equal(receipt.counts.words,6));
  check('CLI builds six document vectors through injected adapter and Store facade',()=>assert.equal(vectorCount,6));
  check('CLI semantic search returns pointer/source/score only',()=>assert.ok(searchReceipt.results.every(x=>Object.keys(x).sort().join(',')==='echoSourceId,ptr,score')));
  store.close();store=null;
  console.log(checks.length+' vector-build integration checks passed');
}finally{
  if(store)store.close();
  fs.rmSync(ROOT,{recursive:true,force:true});
  assert.equal(fs.existsSync(ROOT),false,'TEMP integration root removed');
  console.log('TEMP cleanup: '+String(!fs.existsSync(ROOT)));
}
