#!/usr/bin/env node
// Read-only aggregate audit of canonical ECHO index shards. Emits counts/hashes only.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const ROOT='D:/AI/memory/hub/index';
const FILES=path.join(ROOT,'files.jsonl');
const WORDS=path.join(ROOT,'words.jsonl');
const SUMS=path.join(ROOT,'summaries.jsonl');
const sha=(b)=>createHash('sha256').update(b).digest('hex');
function readLines(p){const b=fs.readFileSync(p);const s=b.toString('utf8');if(!Buffer.from(s,'utf8').equals(b))throw new Error('INVALID_UTF8');return {bytes:b,rows:s.split('\n').filter(x=>x.trim()).map(x=>JSON.parse(x))};}
function snap(p){const b=fs.readFileSync(p),st=fs.statSync(p);return {sha256:sha(b),bytes:b.length,mtimeMs:st.mtimeMs};}
const initial=new Map([FILES,WORDS,SUMS].map(p=>[p,snap(p)]));
const manifest=readLines(FILES).rows;
for(const f of manifest)for(const p of [f.wordOut,f.sumOut])if(typeof p==='string'&&fs.existsSync(p)&&!initial.has(p))initial.set(p,snap(p));
const isReasoning=(row)=>['reasoning','thinking'].includes(String(row.role))||['reasoning','thinking'].includes(String(row.kind));
const globalWords=readLines(WORDS).rows;
const globalSummaries=readLines(SUMS).rows;
const sourceKeys=new Set();
let declaredWords=0,declaredSummaries=0,physicalWords=0,physicalSummaries=0,eligibleWords=0,truncated=0,reasoning=0,other=0,duplicateWordKeys=0,exactDuplicateWordKeys=0,conflictingDuplicateWordKeys=0,duplicateSummaryIds=0,exactDuplicateSummaries=0,conflictingSummaryIds=0,srcSeqRefs=0,srcSeqResolved=0,srcSeqDangling=0,missingShards=0;
const globalWordKeys=new Map();const globalCmpIds=new Map();
for(const row of globalWords){const k=String(row.session)+'\n'+String(row.seq);const arr=globalWordKeys.get(k)||[];arr.push(JSON.stringify(row));globalWordKeys.set(k,arr);}
for(const row of globalSummaries){const k=String(row.cmpId??row.id);globalCmpIds.set(k,(globalCmpIds.get(k)||0)+1);}
const sourceSummaries=new Map();
for(let i=0;i<manifest.length;i++){
  const f=manifest[i];declaredWords+=Number(f.nWord)||0;declaredSummaries+=Number(f.nSum)||0;
  for(const p of [f.wordOut,f.sumOut]){if(typeof p!=='string'||!fs.existsSync(p))missingShards++;}
  if(!fs.existsSync(f.wordOut)||!fs.existsSync(f.sumOut))continue;
  const wr=readLines(f.wordOut).rows;const sr=readLines(f.sumOut).rows;physicalWords+=wr.length;physicalSummaries+=sr.length;
  const localKeys=new Map();const localWordSet=new Set();
  for(const row of wr){const k=String(row.session)+'\n'+String(row.seq);const ser=JSON.stringify(row);const old=localKeys.get(k);if(old!==undefined){duplicateWordKeys++;if(old===ser)exactDuplicateWordKeys++;else conflictingDuplicateWordKeys++;}else localKeys.set(k,ser);
    if(row.truncated===true||row.truncated===1)truncated++;
    if(isReasoning(row)){reasoning++;continue;}
    eligibleWords++;
    localWordSet.add(k);
  }
  const localCmp=new Map();for(const row of sr){const id=String(row.cmpId??row.id);const ser=JSON.stringify(row);const old=localCmp.get(id);if(old!==undefined){duplicateSummaryIds++;if(old===ser)exactDuplicateSummaries++;else conflictingSummaryIds++;}else localCmp.set(id,ser);
    const k=String(row.session)+'\n'+id;const ar=sourceSummaries.get(k)||[];ar.push(row);sourceSummaries.set(k,ar);
    for(const seq of Array.isArray(row.srcSeqs)?row.srcSeqs:[]){srcSeqRefs++;const key=String(row.session)+'\n'+String(seq);if(localWordSet.has(key))srcSeqResolved++;else srcSeqDangling++;}
  }
  sourceKeys.add(String(f.sourcePath||f.file||f.sid||i));
}
const snapshots=[...initial].map(([p,b])=>({pathHash:sha(Buffer.from(p)),...b,unchanged:(()=>{const a=snap(p);return a.sha256===b.sha256&&a.bytes===b.bytes&&a.mtimeMs===b.mtimeMs})()}));
const cmpGlobalDuplicates=[...globalCmpIds.values()].reduce((n,c)=>n+Math.max(0,c-1),0);
const keyGlobalDuplicates=[...globalWordKeys.values()].reduce((n,a)=>n+Math.max(0,a.length-1),0);
const globalPaths=new Map([[FILES,'files'],[WORDS,'words'],[SUMS,'summaries']]);
const global={};for(const [p,name]of globalPaths){const x=snapshots.find(v=>v.pathHash===sha(Buffer.from(p)));if(x)global[name]={sha256:x.sha256,bytes:x.bytes,mtimeMs:x.mtimeMs,unchanged:x.unchanged};}
const shardRows=snapshots.filter(x=>![...globalPaths.keys()].some(p=>sha(Buffer.from(p))===x.pathHash));
const shardSnapshotDigest=sha(Buffer.from(JSON.stringify(shardRows.map(x=>[x.pathHash,x.sha256,x.bytes,x.mtimeMs]).sort((a,b)=>a[0].localeCompare(b[0])))));
const allSourceFilesUnchanged=snapshots.every(x=>x.unchanged);
console.log(JSON.stringify({sources:manifest.length,uniqueSourceKeys:sourceKeys.size,declared:{words:declaredWords,summaries:declaredSummaries},global:{words:globalWords.length,summaries:globalSummaries.length},physical:{words:physicalWords,summaries:physicalSummaries},eligible:{words:eligibleWords},excluded:{truncated,reasoning,other},duplicates:{wordKeyRows:keyGlobalDuplicates,withinSourceWordKeys:duplicateWordKeys,exactWithinSourceWordKeys:exactDuplicateWordKeys,conflictingWithinSourceWordKeys:conflictingDuplicateWordKeys,withinSourceSummaryIds:duplicateSummaryIds,exactWithinSourceSummaryRows:exactDuplicateSummaries,conflictingWithinSourceSummaryIds:conflictingSummaryIds,globalCmpIdExcess:cmpGlobalDuplicates},references:{srcSeqRefs,srcSeqResolved,srcSeqDangling},missingShards,sourceFiles:{count:snapshots.length,unchangedCount:snapshots.filter(x=>x.unchanged).length,allUnchanged:allSourceFilesUnchanged,global,shardCount:shardRows.length,shardSnapshotDigest},allSourceFilesUnchanged}));
