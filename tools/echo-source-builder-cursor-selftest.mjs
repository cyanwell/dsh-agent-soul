import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { openMetaStore } from '../src/db/index.mjs';
import { openDatabase, configureConnection } from '../src/db/engine.mjs';
import { resolveEchoPtr } from './echo-index-import.mjs';
import { syncFromSessionTail } from './echo-source-build.mjs';
import { runImport } from './echo-index-import.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'echo-builder-cursor-'));
const sourceRoot=path.join(root,'source');const outRoot=path.join(root,'out');const dbPath=path.join(root,'v9.sqlite');const session='synthetic-builder-session';const log=path.join(sourceRoot,session,'session.v4.jsonl.zst');const manifestPath=path.join(sourceRoot,'index.jsonl');const t='2026-11-20T00:00:00.000Z';
const record=(seq,text)=>JSON.stringify({seq,type:'user/message',time:t,data:{content:[{type:'text',text}]}});
const firstFrame=zstdCompressSync(Buffer.from(record(1,'first synthetic row')+'\n'));const row2=record(2,'second synthetic row')+'\n';const split=Math.floor(row2.length/2);const partialFrame=zstdCompressSync(Buffer.from(row2.slice(0,split)));const restFrame=zstdCompressSync(Buffer.from(row2.slice(split)));
function writeManifest(){fs.writeFileSync(manifestPath,JSON.stringify({file:log,sid:session,ws:'synthetic-workspace'})+'\n')}
function run(generation,outDir,cursor){return syncFromSessionTail({sourceRoot,manifestPath,outDir,dbPath,sourcePath:'D:/synthetic/v4-sessions',namespace:'v4log',generation,builtAt:t,fullRebuild:generation===1,cursor})}
function commit(result,generation,append){const args=['--manifest',result.manifestPath,'--sha256',result.manifestSha256,'--generation',String(generation),'--db',dbPath];if(append)args.push('--append','--delta-words',result.deltaWordsPath,'--delta-summaries',result.deltaSummariesPath);args.push('--json');return runImport(args)}
try{
  fs.mkdirSync(path.dirname(log),{recursive:true});fs.mkdirSync(outRoot);const store=openMetaStore({path:dbPath,mode:'readwrite'});try{store.migrate()}finally{store.close()}
  fs.writeFileSync(log,firstFrame);writeManifest();
  const g1=run(1,path.join(outRoot,'g1'));assert.equal(g1.manifest.counts.newWords,1);assert.equal(g1.manifest.counts.openTails,0);const i1=commit(g1,1,false);assert.equal(i1.ok,true,JSON.stringify(i1));assert.equal(i1.authority.state,'committed');const c1=i1.cursor;const key=Object.keys(c1.tail.files).find(k=>k.endsWith('session.v4.jsonl.zst'));assert.ok(key);const f1=c1.tail.files[key];assert.equal(f1.nextByte,firstFrame.length);
  const pointerDb=openDatabase(dbPath,{readOnly:true});try{configureConnection(pointerDb,{readOnly:true});const found=resolveEchoPtr(pointerDb,`v4log:${session}#seq=1`);assert.equal(found.status,'ok');assert.equal(found.kind,'word');assert.equal(found.word.seq,1);assert.throws(()=>resolveEchoPtr(pointerDb,`v4log:${session}#seq=999`),e=>e.code==='ECHO_PTR_NOT_FOUND')}finally{pointerDb.close()}
  fs.appendFileSync(log,partialFrame);writeManifest();
  const g2=run(2,path.join(outRoot,'g2'),c1);assert.equal(g2.manifest.counts.newWords,0);assert.equal(g2.manifest.counts.openTails,1);const f2=g2.manifest.cursor.tail.files[key];assert.equal(f2.nextByte,f1.nextByte,'partial JSON must not advance committed byte cursor');assert.equal(f2.mode,'append');const i2=commit(g2,2,true);assert.equal(i2.ok,true,JSON.stringify(i2));assert.equal(i2.authority.state,'committed');const c2=i2.cursor;assert.deepEqual(c2.tail.files[key],f2);
  fs.appendFileSync(log,restFrame);writeManifest();const eofBeforeTruncate=fs.statSync(log).size;
  const g3=run(3,path.join(outRoot,'g3'),c2);assert.equal(g3.manifest.counts.newWords,1);assert.equal(g3.manifest.counts.openTails,0);const f3=g3.manifest.cursor.tail.files[key];assert.equal(f3.nextByte,eofBeforeTruncate);assert.equal(f3.mode,'append');const i3=commit(g3,3,true);assert.equal(i3.ok,true,JSON.stringify(i3));assert.equal(i3.authority.state,'committed');assert.deepEqual(i3.cursor.tail.files[key],f3);
  const rows=fs.readFileSync(g3.wordsPath,'utf8').trimEnd().split('\n').map(JSON.parse);assert.deepEqual(rows.map(row=>row.seq),[1,2]);
  fs.writeFileSync(log,firstFrame);writeManifest();assert.throws(()=>run(4,path.join(outRoot,'g4'),i3.cursor),/source shrank \(truncation\)/);
  console.log(JSON.stringify({ok:true,tempOnly:true,g1:{authority:i1.authority.state,newWords:g1.manifest.counts.newWords,nextByte:f1.nextByte},g2:{authority:i2.authority.state,newWords:g2.manifest.counts.newWords,openTails:g2.manifest.counts.openTails,nextByte:f2.nextByte,mode:f2.mode},g3:{authority:i3.authority.state,newWords:g3.manifest.counts.newWords,openTails:g3.manifest.counts.openTails,nextByte:f3.nextByte,eofBeforeTruncate,mode:f3.mode,seqs:rows.map(row=>row.seq)},truncateRefused:true,realSourceOrDB:false},null,2));
}finally{fs.rmSync(root,{recursive:true,force:true});assert.equal(fs.existsSync(root),false,'TEMP root remains');console.log('TEMP cleanup: PASS')}
