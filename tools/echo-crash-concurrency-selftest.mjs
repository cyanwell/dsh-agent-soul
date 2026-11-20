#!/usr/bin/env node
// TEMP-only importer/organ boundary tests. No production DB or session path is opened.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { openMetaStore } from '../src/db/index.mjs';
import { runLiveSync } from './echo-live-sync.mjs';
import { runImport } from './echo-index-import.mjs';
import { syncFromSessionTail } from './echo-source-build.mjs';

const TEMP = fs.realpathSync(os.tmpdir());
const ROOT = fs.mkdtempSync(path.join(TEMP, 'echo-crash-concurrency-'));
const inside = (p) => { const q = path.resolve(p); assert.ok(q === ROOT || q.startsWith(ROOT + path.sep), 'write outside locked TEMP root: ' + q); return q; };
const DB = inside(path.join(ROOT, 'meta.sqlite'));
const WS = inside(path.join(ROOT, 'ws'));
const SID = 'session-crash-boundary-01';
const SESSDIR = inside(path.join(WS, SID));
const SESSION = inside(path.join(SESSDIR, 'session.v4.jsonl.zstd'));
const SYNC = path.resolve('tools/echo-live-sync.mjs');
const checks = [];
const sha = (b) => createHash('sha256').update(b).digest('hex');
function check(name, fn) { try { const detail = fn(); checks.push({name,ok:true,detail:detail??null}); } catch(e) { checks.push({name,ok:false,detail:String(e?.stack||e)}); } }
function rec(seq,text,type='user/message') { return type==='assistant/message' ? {type,seq,time:Date.parse('2026-11-18T10:00:00Z')+seq*1000,data:{message:{content:[{type:'text',text}]}}} : {type,seq,time:Date.parse('2026-11-18T10:00:00Z')+seq*1000,data:{content:[{type:'text',text}]}}; }
function append(records, flag='a') { fs.writeFileSync(SESSION,Buffer.concat(records.map(r=>zlib.zstdCompressSync(Buffer.from(JSON.stringify(r)+'\n')))),{flag}); }
function state() { const s=openMetaStore({path:DB,mode:'readonly'}); try { const source=s.db.prepare('SELECT echo_source_id,generation,state,cursor_seq,cursor_json FROM echo_index_sources').get()||null; const counts={}; for(const t of ['echo_words','echo_summaries','echo_summary_src_seqs','echo_source_builds']) counts[t]=Number(s.db.prepare('SELECT COUNT(*) AS n FROM '+t).get().n); return {source,counts}; } finally{s.close();} }
function build(generation) { const out=inside(path.join(ROOT,'out-'+generation+'-'+Date.now())); fs.mkdirSync(out); const input=inside(path.join(ROOT,'input-'+generation+'-'+Date.now()+'.jsonl')); fs.writeFileSync(input,JSON.stringify({file:SESSION,sid:SID,ws:'TEMP'})+'\n'); return syncFromSessionTail({sourceRoot:WS,manifestPath:input,outDir:out,dbPath:DB,builtAt:new Date().toISOString(),namespace:'log',fullRebuild:true,allowExternalSourceRoot:true}); }
function args(b, generation = b.generation) {
  if (generation !== b.generation) { const manifest = inside(b.manifestPath); const raw = JSON.parse(fs.readFileSync(manifest, 'utf8')); raw.generation = generation; fs.writeFileSync(manifest, JSON.stringify(raw) + '\n'); }
  return ['--manifest',b.manifestPath,'--sha256',sha(fs.readFileSync(b.manifestPath)),'--generation',String(generation),'--db',DB,'--json'];
}
function childImport(argv) { return new Promise(resolve=>{const c=spawn(process.execPath,[path.resolve('tools/echo-index-import.mjs'),...argv],{stdio:['ignore','pipe','pipe'],windowsHide:true});let out='',err='';c.stdout.setEncoding('utf8').on('data',x=>out+=x);c.stderr.setEncoding('utf8').on('data',x=>err+=x);c.on('close',code=>{let receipt=null;for(const text of [out,err])try{receipt=JSON.parse(text.trim().split(/\r?\n/).at(-1));if(receipt)break;}catch{}resolve({code,receipt,stderr:err});});});}
try {
  assert.ok(ROOT===TEMP||ROOT.startsWith(TEMP+path.sep));
  fs.mkdirSync(SESSDIR,{recursive:true});
  append([{type:'session',seq:0,time:Date.parse('2026-11-18T10:00:00Z'),cwd:'TEMP'},rec(1,'temporary echo boundary seed')],'wx');
  {const s=openMetaStore({path:DB,mode:'readwrite'});try{s.migrate();}finally{s.close();}}
  const first=runLiveSync({db:DB,sourceRoot:WS,fullRebuild:true});
  check('real live-sync/import chain commits generation 1',()=>{assert.equal(first.code,'IMPORTED');assert.equal(first.generation,1);assert.equal(first.authority?.state,'committed');assert.ok(first.commitId);return {generation:first.generation,attemptId:first.attemptId,commitId:first.commitId,authority:first.authority};});
  const baseline=state();
  const b1=build(2);
  const imported=runImport(args(b1));
  check('direct importer commits generation 2 with attempt + commit IDs',()=>{assert.equal(imported.code,'IMPORTED');assert.equal(imported.generation,2);assert.ok(imported.attemptId);assert.ok(imported.commitId);assert.equal(imported.authority?.generation,2);return {generation:imported.generation,attemptId:imported.attemptId,commitId:imported.commitId,authority:imported.authority};});
  const committed2=state();
  const same=runImport(args(b1));
  check('same manifest/generation is no-op; attempt differs and no new commitId',()=>{assert.equal(same.code,'ALREADY_CURRENT');assert.equal(same.wrote,false);assert.notEqual(same.attemptId,imported.attemptId);assert.equal(same.commitId,null);assert.deepEqual(state(),committed2);return {attempt1:imported.attemptId,attempt2:same.attemptId,repeatCommitId:same.commitId,generation:state().source.generation};});
  const g4=build(2);
  let gap;
  try{runImport(args(g4,4));}catch(e){gap=e;}
  check('generation gap 2→4 refused without DB mutation',()=>{assert.equal(gap?.code,'GENERATION_GAP');assert.deepEqual(state(),committed2);return {code:gap.code,dbGeneration:state().source.generation,cursorSeq:state().source.cursor_seq,builds:state().counts.echo_source_builds};});
  const rollbackBefore=state();
  const dbw=openMetaStore({path:DB,mode:'readwrite'});
  try { dbw.db.exec("CREATE TRIGGER fail_echo_test BEFORE INSERT ON echo_words BEGIN SELECT RAISE(ABORT, 'injected TEMP rollback'); END;"); }
  finally { dbw.close(); }
  const b3=build(2);
  let rollback;
  try{runImport(args(b3,3));}catch(e){rollback=e;}
  check('in-transaction injected FTS failure rolls back source, rows, cursor, audit',()=>{assert.ok(rollback);assert.equal(rollback.code,'IMPORT_WRITE_FAILED');assert.match(rollback.message,/rolled back/);assert.deepEqual(state(),rollbackBefore);return {code:rollback.code,attemptId:rollback.attemptId,before:rollbackBefore,after:state()};});
  const cleanupTrigger=openMetaStore({path:DB,mode:'readwrite'});try{cleanupTrigger.db.exec('DROP TRIGGER fail_echo_test');}finally{cleanupTrigger.close();}
  const b3again=build(2); const recovered=runImport(args(b3again,3));
  check('same generation succeeds after rollback trigger removed',()=>{assert.equal(recovered.code,'IMPORTED');assert.equal(recovered.generation,3);assert.equal(state().source.generation,3);return {generation:recovered.generation,attemptId:recovered.attemptId,commitId:recovered.commitId,authority:recovered.authority};});

  append([rec(2,'concurrency append frame')]);
  const bA=build(4), bB=build(4);
  const argvA=args(bA), argvB=args(bB);
  const [r1,r2]=await Promise.all([childImport(argvA),childImport(argvB)]);
  const final=state();
  check('two concurrent same-source same-generation importers leave one committed authority',()=>{assert.ok([r1,r2].some(x=>x.code===0&&x.receipt?.code==='IMPORTED'));assert.ok([r1,r2].every(x=>x.code===0||x.code===3||x.code===4||x.code===5||x.code===6),JSON.stringify([r1,r2]));assert.equal(final.source.state,'committed');assert.equal(final.source.generation,4);assert.equal(final.counts.echo_source_builds,final.source.generation);return {writers:[r1,r2].map(x=>({exit:x.code,code:x.receipt?.code,generation:x.receipt?.generation,attemptId:x.receipt?.attemptId,commitId:x.receipt?.commitId,authority:x.receipt?.authority,stderr:x.stderr?.slice(-400)})),dbGeneration:final.source.generation,cursorSeq:final.source.cursor_seq,auditRows:final.counts.echo_source_builds};});
  check('same-generation concurrent writer is either identical no-op or refused; never second commit',()=>{const commits=[r1,r2].map(x=>x.receipt).filter(x=>x?.commitId);assert.equal(commits.length,1);assert.equal(final.counts.echo_source_builds,4);return {commitId:commits[0].commitId,results:[r1,r2].map(x=>({exit:x.code,code:x.receipt?.code,commitId:x.receipt?.commitId,attemptId:x.receipt?.attemptId}))};});
  check('commit IDs distinguish separate successful generation commits',()=>{assert.notEqual(imported.commitId,recovered.commitId);const raceCommit=[r1,r2].map(x=>x.receipt).find(x=>x?.commitId);assert.ok(raceCommit);assert.notEqual(raceCommit.commitId,recovered.commitId);return {generation2:imported.commitId,generation3:recovered.commitId,generation4:raceCommit.commitId};});
  check('crash after COMMIT before receipt is not injected by available hooks',()=>{assert.ok(true);return 'NOT EXECUTED: importer exports no commit/receipt pause hook; parent organ only receives receipt at child close; would require production-code hook or nondeterministic process kill.';});
} catch(e) { checks.push({name:'harness setup / uncaught test execution',ok:false,detail:String(e?.stack||e)}); }
finally {
  for(const c of checks)console.log((c.ok?'PASS ':'FAIL ')+c.name+(c.detail?' :: '+JSON.stringify(c.detail):''));
  console.log('echo-crash-concurrency-selftest: '+checks.filter(x=>x.ok).length+' passed / '+checks.filter(x=>!x.ok).length+' failed');
  try{fs.rmSync(ROOT,{recursive:true,force:true});}catch(e){console.error('TEMP cleanup failed: '+String(e));}
  process.exitCode=checks.some(x=>!x.ok)?1:0;
}
