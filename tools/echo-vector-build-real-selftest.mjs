#!/usr/bin/env node
// Opt-in real local BGE build/search on a synthetic imported ECHO source in TEMP only.
// Model/runtime files are read-only; no service, network, production DB/index/session data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { openMetaStore } from '../src/db/index.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url));
const NODE=process.execPath;
const FIXTURE=path.join(HERE,'fixtures','echo-index-import','corpus');
const IMPORTER=path.join(HERE,'echo-index-import.mjs');
const CLI=path.join(HERE,'echo-vector-build.mjs');
const MODEL_DIR=path.resolve(process.env.ECHO_BGE_MODEL_DIR||'D:/AI/dsh-tools/dsh-agent-soul/kit/echo/models/bge-small-zh');
const KIT_ROOT=path.dirname(MODEL_DIR);
const TRANSFORMERS_DIR=path.join(MODEL_DIR,'node_modules','.pnpm','@huggingface+transformers@4.3.2_@types+node@26.6.6','node_modules','@huggingface','transformers');
const ROOT=fs.mkdtempSync(path.join(os.tmpdir(),'echo-vector-build-real-selftest-'));
const CORPUS=path.join(ROOT,'corpus');
const DB=path.join(ROOT,'meta.sqlite');
const EXPECTED=path.join(ROOT,'fingerprint.json');
const sha=(b)=>createHash('sha256').update(b).digest('hex');
const fingerprint={
  modelId:'BAAI/bge-small-zh-v1.5',modelRevision:'local-bundled-unpinned',transformersVersion:'4.3.2',
  modelSha256:'15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc',
  tokenizerSha256:'48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26',
  configSha256:'d4193ead3a810fd694fa8a31d7fc72fbaebc0668b603e398734bf2f6538ff42f',
  dimension:512,dtype:'q8',pooling:'mean',normalized:true,
  queryPrefix:'为这个句子生成表示以用于检索相关文章：',documentPrefix:'',
  maxInputChars:1000,truncation:'slice-code-units-before-tokenization',
};
let store=null;
function run(args){
  const r=spawnSync(NODE,[CLI,...args],{encoding:'utf8',cwd:HERE,env:{...process.env}});
  if(r.error) throw r.error;
  return r;
}
try{
  assert.ok(fs.existsSync(path.join(MODEL_DIR,'onnx','model_quantized.onnx')),'pinned local Q8 ONNX weights exist');
  assert.ok(fs.existsSync(path.join(MODEL_DIR,'tokenizer.json')),'pinned local tokenizer exists');
  assert.ok(fs.existsSync(path.join(MODEL_DIR,'config.json')),'pinned local config exists');
  assert.ok(fs.existsSync(path.join(TRANSFORMERS_DIR,'package.json')),'pinned Transformers.js package exists');
  fs.cpSync(FIXTURE,CORPUS,{recursive:true});
  fs.writeFileSync(EXPECTED,JSON.stringify(fingerprint,null,2));
  store=openMetaStore({path:DB,mode:'readwrite'});store.migrate();store.close();store=null;
  const manifest=path.join(CORPUS,'manifest.json');
  const imported=spawnSync(NODE,[IMPORTER,'--manifest',manifest,'--sha256',sha(fs.readFileSync(manifest)),'--generation','1','--db',DB,'--json'],{encoding:'utf8',cwd:HERE,env:{...process.env}});
  if(imported.error)throw imported.error;
  if(imported.status!==0)throw new Error('TEMP public importer failed exit='+imported.status+' stdout='+imported.stdout+' stderr='+imported.stderr);
  const receipt=JSON.parse(imported.stdout);
  assert.equal(receipt.code,'IMPORTED');
  assert.equal(receipt.counts.words,6);
  const sourceId=receipt.source.echoSourceId;
  const base=['--db',DB,'--echo-source-id',sourceId,'--model-dir',MODEL_DIR,'--expected-fingerprint',EXPECTED];
  const built=run(['--mode','build',...base]);
  if(built.status!==0)throw new Error('REAL BGE build failed exit='+built.status+' stdout='+built.stdout+' stderr='+built.stderr);
  const build=JSON.parse(built.stdout);
  assert.equal(build.ok,true);assert.equal(build.rows,6);assert.equal(build.echoSourceId,sourceId);
  store=openMetaStore({path:DB,mode:'readonly'});store.ensureReady();
  const source=store.db.prepare('SELECT words_count FROM echo_index_sources WHERE echo_source_id=?').get(sourceId);
  const vectors=store.db.prepare('SELECT COUNT(*) AS n FROM echo_word_vectors WHERE echo_source_id=? AND model_key=?').get(sourceId,build.modelKey);
  assert.equal(vectors.n,source.words_count);
  store.close();store=null;
  const searched=run(['--mode','search',...base,'--query','语义召回测试：六层解耦及8f3a片段','--limit','10']);
  if(searched.status!==0)throw new Error('REAL BGE search failed exit='+searched.status+' stdout='+searched.stdout+' stderr='+searched.stderr);
  const result=JSON.parse(searched.stdout);
  assert.equal(result.ok,true);assert.equal(result.mode,'search');
  assert.ok(Array.isArray(result.results));
  assert.ok(result.results.length>0,'query should return at least one vector match');
  for(const hit of result.results){
    assert.ok(hit.ptr.startsWith('log:')||hit.ptr.startsWith('v4log:'));
    assert.equal(hit.echoSourceId,sourceId);
    assert.ok(Number.isFinite(hit.score));
    assert.deepEqual(Object.keys(hit).sort(),['echoSourceId','ptr','score']);
  }
  console.log('PASS public synthetic importer rows='+receipt.counts.words+' source='+sourceId);
  console.log('PASS real local BGE build model='+build.modelKey+' vectors='+vectors.n+'/'+source.words_count);
  console.log('PASS real local BGE search pointer-only hits='+result.results.length);
}finally{
  if(store)store.close();
  fs.rmSync(ROOT,{recursive:true,force:true});
  assert.equal(fs.existsSync(ROOT),false,'real BGE TEMP root removed');
  console.log('TEMP cleanup: '+String(!fs.existsSync(ROOT)));
}
