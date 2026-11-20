#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const TEMP=fs.realpathSync(os.tmpdir());
const ROOT=path.resolve(TEMP,'echo-current-contract-'+randomUUID());
const DB=path.join(ROOT,'meta.sqlite');
const SOURCE=path.join(ROOT,'source');
const planned=[ROOT,DB,SOURCE,path.join(ROOT,'vector-cache')];
function assertTempTarget(p,label){const a=path.resolve(p);assert(a===TEMP||a.startsWith(TEMP+path.sep),label+' is outside os.tmpdir: '+a);assert(a===ROOT||a.startsWith(ROOT+path.sep),label+' is outside unique test root: '+a);return a;}
// First action: assert every intended output path before creating anything.
for(const p of planned)assertTempTarget(p,'planned target');
fs.mkdirSync(ROOT,{recursive:false});
const tests=[];let passed=0,failed=0,store=null,db=null;let clearVectorCacheAll=null;
const sha=b=>createHash('sha256').update(b).digest('hex');
const check=(name,fn)=>{try{const evidence=fn();passed++;tests.push({status:'PASS',name,evidence});return evidence;}catch(e){failed++;tests.push({status:'FAIL',name,error:String(e?.stack||e)});return null;}};
const finding=(name,severity,conclusion,evidence)=>tests.push({status:'FINDING',name,severity,conclusion,evidence});
const REPO=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURE=path.join(REPO,'tools','fixtures','echo-index-import','corpus');
const sourceDir=assertTempTarget(SOURCE,'fixture destination');
let importer,searchEcho,registerEchoVectorModel,putEchoSourceVectors,searchEchoSourceVectors,searchWindowVectors;
let sourceId=null,vectorModel=null;
function readManifest(){return JSON.parse(fs.readFileSync(path.join(SOURCE,'manifest.json'),'utf8'));}
function importGeneration(generation){
 const m=readManifest();m.generation=generation;m.builtAt='2026-11-19T13:00:0'+generation+'.000Z';
 const wp=assertTempTarget(path.join(SOURCE,'words.jsonl'),'words'),sp=assertTempTarget(path.join(SOURCE,'summaries.jsonl'),'summaries');
 let words=fs.readFileSync(wp,'utf8'),sums=fs.readFileSync(sp,'utf8');
 if(generation>1){words=words.split('\n').map(line=>{if(!line)return line;const row=JSON.parse(line);if(row.text.includes('解耦机制')||row.text.startsWith('generation '))row.text='generation '+generation+' lexical marker';row.len=row.text.length;return JSON.stringify(row);}).join('\n');sums=sums.split('\n').map(line=>{if(!line)return line;const row=JSON.parse(line);if(row.summary.includes('解耦机制'))row.summary='generation '+generation+' summary marker';return JSON.stringify(row);}).join('\n');}
 fs.writeFileSync(wp,words);fs.writeFileSync(sp,sums);
 m.words.sha256=sha(Buffer.from(words));m.words.bytes=Buffer.byteLength(words);m.words.rows=words.trimEnd().split('\n').length;
 m.summaries.sha256=sha(Buffer.from(sums));m.summaries.bytes=Buffer.byteLength(sums);m.summaries.rows=sums.trimEnd().split('\n').length;
 const mp=assertTempTarget(path.join(SOURCE,'manifest.json'),'manifest');fs.writeFileSync(mp,JSON.stringify(m,null,2)+'\n');
 const receipt=importer.runImport(['--manifest',mp,'--sha256',sha(fs.readFileSync(mp)),'--generation',String(generation),'--db',DB,'--json','--now','2026-11-19T13:00:00.000Z']);
 for(const p of [DB,receipt.manifest?.path,receipt.inputs?.words?.path,receipt.inputs?.summaries?.path])if(p)assertTempTarget(p,'reported importer path');return receipt;
}
function query(surface,term='解耦'){return searchEcho(db,{terms:[term],surface,limit:100,sources:[sourceId]});}
function expectCode(fn,code){let caught;try{fn();}catch(e){caught=e;}assert(caught,'expected '+code);assert.equal(caught.code,code);return{code:caught.code,message:caught.message};}
function expectOneOfCodes(fn,codes){let caught;try{fn();}catch(e){caught=e;}assert(caught,'expected a fail-closed authority error');assert(codes.includes(caught.code),'unexpected code '+caught.code);return{code:caught.code,message:caught.message};}
try{
 const apis=await Promise.all([import('../src/db/index.mjs'),import('./echo-index-import.mjs'),import('../src/db/echo.mjs'),import('../src/db/echo-vectors.mjs'),import('../src/db/echo-window-search.mjs'),import('../src/db/echo-vector-cache.mjs')]);
 const [dbApi,impApi,echoApi,vecApi,winApi,cacheApi]=apis;importer=impApi;searchEcho=echoApi.searchEcho;registerEchoVectorModel=vecApi.registerEchoVectorModel;putEchoSourceVectors=vecApi.putEchoSourceVectors;searchEchoSourceVectors=vecApi.searchEchoSourceVectors;searchWindowVectors=winApi.searchWindowVectors;clearVectorCacheAll=cacheApi.clearVectorCacheAll;
 fs.cpSync(FIXTURE,SOURCE,{recursive:true});
 store=dbApi.openMetaStore({path:DB,mode:'readwrite'});store.migrate();store.ensureReady();db=store.db;
 const moSource=assertTempTarget(path.join(ROOT,'mo-legacy-fixture.jsonl'),'synthetic Mo source');const moRaw=JSON.stringify({t:'2026-11-19T13:00:00.000Z',type:'fact',text:'synthetic imported Mo row',by:'fixture'})+'\n';fs.writeFileSync(moSource,moRaw);const moSha=sha(Buffer.from(moRaw));db.prepare('INSERT INTO mo_import_batches(source_path,source_sha256,source_bytes,physical_lines,blank_lines,rows_imported,imported_at,importer) VALUES(?,?,?,?,?,?,?,?)').run(moSource,moSha,Buffer.byteLength(moRaw),1,0,1,'2026-11-19T13:00:01.000Z','synthetic-mo-fixture/1');const moBatchId=Number(db.prepare('SELECT batch_id FROM mo_import_batches WHERE source_sha256=?').get(moSha).batch_id);db.prepare('INSERT INTO mo_ledger(t,type,text,by,actor_session,ref,feel,by_user,legacy_line,legacy_raw,import_batch_id) VALUES(?,?,?,?,NULL,?,?,0,?,?,?)').run('2026-11-19T13:00:00.000Z','fact','synthetic imported Mo row','fixture',null,null,1,moRaw.trimEnd(),moBatchId);const moSnapshot=()=>({batches:db.prepare('SELECT batch_id,source_path,source_sha256,source_bytes,physical_lines,blank_lines,rows_imported,imported_at,importer FROM mo_import_batches ORDER BY batch_id').all(),ledger:db.prepare('SELECT row_id,t,type,text,by,actor_session,ref,feel,by_user,legacy_line,legacy_raw,import_batch_id FROM mo_ledger WHERE import_batch_id IS NOT NULL ORDER BY row_id').all()});const moBefore=JSON.stringify(moSnapshot());
 const first=importGeneration(1);sourceId=first.source.echoSourceId;
 check('real importer commits generation 1',()=>{assert.equal(first.code,'IMPORTED');const row=db.prepare('SELECT generation,state FROM echo_index_sources WHERE echo_source_id=?').get(sourceId);assert.deepEqual({generation:Number(row.generation),state:row.state},{generation:1,state:'committed'});return{receipt:{code:first.code,generation:first.generation},authority:row};});
 const lex=query('words');
 check('committed lexical query returns generation/state/authority',()=>{const face=lex.words;assert(lex.ok&&face.results.length>0);assert.equal(face.generation,1);assert.equal(face.state,'committed');assert.deepEqual({sourceId:face.authority.sourceId,generation:face.authority.generation,state:face.authority.state},{sourceId,generation:1,state:'committed'});assert.equal(face.index.sources.find(x=>x.echoSourceId===sourceId).generation,1);return{generation:face.generation,state:face.state,authority:face.authority,hits:face.results.length};});
 const modelSpec={modelId:'synthetic-current-contract',revision:'1',modelSha256:'b'.repeat(64),tokenizerSpec:'synthetic-tokenizer',preprocessSpec:'synthetic-preprocess',poolingSpec:'mean',normalize:true,dimension:2,maxSeqLength:64};
 vectorModel=registerEchoVectorModel(db,modelSpec);
 for(const state of ['pending','failed']){
  db.prepare('UPDATE echo_index_sources SET state=? WHERE echo_source_id=?').run(state,sourceId);
  const le=expectCode(()=>query('words'),'ECHO_SOURCE_NOT_COMMITTED');
  const ve=expectCode(()=>searchEchoSourceVectors(db,[1,0],{modelKey:vectorModel.modelKey,echoSourceId:sourceId,limit:1}),'ECHO_VECTOR_STALE');
  const we=expectCode(()=>searchWindowVectors(db,[1,0],{modelKey:vectorModel.modelKey,echoSourceId:sourceId,limit:1}),'ECHO_WINDOW_STALE');
  check('pending/failed lexical and vector reads refused: '+state,()=>({state,lexical:le,wordVector:ve,windowVector:we}));
 }
 db.prepare("UPDATE echo_index_sources SET state='committed' WHERE echo_source_id=?").run(sourceId);
 let writerAttempt={attempted:false,result:null};
 const hookedDb={exec(sql){return db.exec(sql);},prepare(sql){if(!writerAttempt.attempted&&/from echo_summaries_fts/i.test(String(sql))&&/match/i.test(String(sql))){writerAttempt.attempted=true;try{const receipt=importGeneration(2);writerAttempt.result={outcome:'committed',code:receipt.code,generation:receipt.generation};}catch(e){writerAttempt.result={outcome:'rejected-or-locked',code:e.code||null,message:e.message};}}return db.prepare(sql);}};
 const both=searchEcho(hookedDb,{terms:['解耦'],surface:'both',limit:100,sources:[sourceId]});
 check('both SAVEPOINT shares generation and records writer outcome',()=>{assert(writerAttempt.attempted&&writerAttempt.result);assert.equal(both.ok,true);assert.equal(both.sharedGeneration,1);assert.equal(both.words.generation,1);assert.equal(both.summaries.generation,1);assert.equal(both.words.authority.snapshotId,both.summaries.authority.snapshotId);assert.equal(both.words.state,'committed');assert.equal(both.summaries.state,'committed');assert(both.words.results.some(x=>String(x.rawText).includes('解耦机制记在六层解码之后')));assert(both.summaries.results.some(x=>String(x.rawText).includes('压缩摘要：解耦机制的六层结构')));assert(!both.words.results.some(x=>String(x.rawText).includes('generation 2 lexical marker')));assert(!both.summaries.results.some(x=>String(x.rawText).includes('generation 2 summary marker')));const live=Number(db.prepare('SELECT generation FROM echo_index_sources WHERE echo_source_id=?').get(sourceId).generation);if(writerAttempt.result.outcome==='committed')assert.equal(live,2);else assert.equal(live,1);return{readerGeneration:both.sharedGeneration,wordsGeneration:both.words.generation,summariesGeneration:both.summaries.generation,snapshotId:both.words.authority.snapshotId,writer:writerAttempt.result,liveGeneration:live};});
 let activeGen=Number(db.prepare('SELECT generation FROM echo_index_sources WHERE echo_source_id=?').get(sourceId).generation);
 if(activeGen===1){const gen2=importGeneration(2);assert.equal(gen2.code,'IMPORTED');activeGen=2;}
 const words=db.prepare('SELECT word_ord,content_hash FROM echo_words WHERE echo_source_id=? ORDER BY word_ord').all(sourceId);
 const put=putEchoSourceVectors(db,sourceId,modelSpec,words.map(w=>({wordOrd:Number(w.word_ord),contentHash:w.content_hash,vector:[1,0]})));
 const wordVec=searchEchoSourceVectors(db,[1,0],{modelKey:vectorModel.modelKey,echoSourceId:sourceId,limit:1});
 const w=words[0],blob=Buffer.alloc(8);blob.writeFloatLE(1,0);blob.writeFloatLE(0,4);
 db.prepare('INSERT INTO echo_word_windows (echo_source_id,word_ord,window_ord,model_key,char_start,char_end,window_text_sha256,source_content_hash,vector_dimension,vector_blob,vector_sha256,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(sourceId,Number(w.word_ord),0,vectorModel.modelKey,0,17,sha(Buffer.from('synthetic window')),w.content_hash,2,blob,sha(blob),'2026-11-19T13:00:00.000Z');
 clearVectorCacheAll();const windowVec=searchWindowVectors(db,[1,0],{modelKey:vectorModel.modelKey,echoSourceId:sourceId,limit:1});
 check('word/window hits expose current generation and committed authority',()=>{assert(put.rows>0);for(const result of [wordVec,windowVec]){assert.equal(result.generation,activeGen);assert.equal(result.state,'committed');assert.equal(result.authority.sourceId,sourceId);assert.equal(result.authority.generation,activeGen);assert.equal(result.authority.state,'committed');assert.match(result.authority.snapshotId,new RegExp('g'+activeGen+'$'));assert(result.results.length>0);}return{activeGen,word:{generation:wordVec.generation,authority:wordVec.authority,hits:wordVec.results.length},window:{generation:windowVec.generation,authority:windowVec.authority,hits:windowVec.results.length}};});
 const next=activeGen+1,replacement=importGeneration(next);
 check('importer advances the authoritative source generation',()=>{assert.equal(replacement.code,'IMPORTED');const row=db.prepare('SELECT generation,state FROM echo_index_sources WHERE echo_source_id=?').get(sourceId);assert.deepEqual({generation:Number(row.generation),state:row.state},{generation:next,state:'committed'});return{receipt:{code:replacement.code,generation:replacement.generation},authority:row};});
 clearVectorCacheAll();const staleWord=expectCode(()=>searchEchoSourceVectors(db,[1,0],{modelKey:vectorModel.modelKey,echoSourceId:sourceId,limit:1}),'ECHO_VECTOR_SOURCE_INCOMPLETE');const staleWindow=expectOneOfCodes(()=>searchWindowVectors(db,[1,0],{modelKey:vectorModel.modelKey,echoSourceId:sourceId,limit:1}),['ECHO_WINDOW_STALE','ECHO_WINDOW_SOURCE_EMPTY']);
 check('replacement generation invalidates stale vector/window authority',()=>({cachedGeneration:activeGen,currentGeneration:next,word:staleWord,window:staleWindow}));
 check('ECHO generations leave SQL Mo import provenance unchanged',()=>{const after=JSON.stringify(moSnapshot());assert.equal(after,moBefore,'ECHO re-import must not mutate Mo batches or imported ledger rows');const moSchema=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name IN ('mo_ledger','mo_import_batches') ORDER BY name").all();const echoColumns=moSchema.filter(row=>/echo_source_id|echo_generation|echo_ptr/i.test(String(row.sql||'')));assert.deepEqual(echoColumns,[],'Mo ledger provenance schema must not pretend its JSONL source is the ECHO session-log source');return{moBatchId,moSourceSha256:moSha,moBatchCount:moSnapshot().batches.length,moImportedRows:moSnapshot().ledger.length,echoSourceId:sourceId,moSchemaEchoSpecificColumns:echoColumns.length};});
} catch(e){failed++;tests.push({status:'FAIL',name:'uncaught harness failure',error:String(e?.stack||e)});}
finally{try{clearVectorCacheAll?.();}catch{}try{store?.close();}catch{}try{fs.rmSync(ROOT,{recursive:true,force:true});}catch(e){failed++;tests.push({status:'FAIL',name:'TEMP cleanup',error:String(e)});}}
const result={node:process.version,temp: TEMP,tempRoot:ROOT,passed,failed,tests,cleanup:!fs.existsSync(ROOT)};
console.log(JSON.stringify(result,null,2));process.exitCode=failed>0||!result.cleanup?1:0;
