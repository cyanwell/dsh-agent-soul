#!/usr/bin/env node
// In-memory synthetic tests only: no files, DB, network, or services.
import assert from 'node:assert/strict';
import { auditEchoSourceCoverage } from './echo-source-coverage.mjs';
const base = () => ({ sourceInventory:[{path:'/synthetic/a',version:'echo-index/1',namespace:'log',expectedWords:[{session:'s-a',seq:2},{session:'s-a',seq:9}],expectedSummaries:[{cmpId:'cmp-a',session:'s-a',srcSeqs:[2,9]}]}],derivedSnapshot:{shards:[{path:'/synthetic/a',version:'echo-index/1',namespace:'log',cursorSeq:9,words:[{session:'s-a',seq:2},{session:'s-a',seq:9}],summaries:[{cmpId:'cmp-a',session:'s-a',srcSeqs:[2,9]}]}]}});
let passed=0;let failed=0;function testCase(name,fn){try{fn();passed++;console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name+': '+e.stack);}}
const types=(input)=>auditEchoSourceCoverage(input).problems.map((p)=>p.type);
testCase('complete sparse inventory accepts seq 2 and 9 without inferring gaps',()=>assert.deepEqual(types(base()),[]));
testCase('explicitly expected absent word is missing-word',()=>{const x=base();x.derivedSnapshot.shards[0].words.pop();assert.ok(types(x).includes('missing-word'));});
testCase('absent shard accounts for declared rows and summaries',()=>{const x=base();x.derivedSnapshot.shards=[];const p=auditEchoSourceCoverage(x).problems.find((q)=>q.type==='missing-shard');assert.equal(p.unresolvedExpectedWords,2);assert.equal(p.unresolvedExpectedSummaries,1);assert.equal(p.unresolvedExpectedSummaryRefs,2);});
testCase('missing summary source word is reported',()=>{const x=base();x.derivedSnapshot.shards[0].words.pop();const p=auditEchoSourceCoverage(x).problems.find((q)=>q.type==='missing-summary-source-ref');assert.equal(p.seq,9);});
testCase('cursor is checked only against declared word keys',()=>{const x=base();x.derivedSnapshot.shards[0].cursorSeq=5;const p=auditEchoSourceCoverage(x).problems.find((q)=>q.type==='cursor-before-declared-row');assert.equal(p.seq,9);});
testCase('unexpected word and shard are explicit',()=>{const x=base();x.derivedSnapshot.shards[0].words.push({session:'s-a',seq:10});x.derivedSnapshot.shards.push({path:'/synthetic/extra',version:'echo-index/1',namespace:'v4log',cursorSeq:0,words:[],summaries:[]});const t=types(x);assert.ok(t.includes('unexpected-word'));assert.ok(t.includes('unexpected-shard'));});
testCase('duplicate identity and keys are deterministic diagnostics',()=>{const x=base();x.sourceInventory[0].expectedWords.push({session:'s-a',seq:2});x.derivedSnapshot.shards[0].words.push({session:'s-a',seq:2});x.derivedSnapshot.shards.push({...x.derivedSnapshot.shards[0]});const a=auditEchoSourceCoverage(x),b=auditEchoSourceCoverage(x);assert.ok(types(x).includes('duplicate-expected-word'));assert.ok(types(x).includes('duplicate-present-word'));assert.ok(types(x).includes('duplicate-present-shard'));assert.deepEqual(a,b);});
testCase('output has stable ordering and input remains unchanged',()=>{const x=base();x.derivedSnapshot.shards[0].words.pop();const before=JSON.stringify(x);const a=auditEchoSourceCoverage(x),b=auditEchoSourceCoverage(x);assert.deepEqual(a,b);assert.equal(JSON.stringify(x),before);});
testCase('declared summary omitted is missing-summary',()=>{const x=base();x.derivedSnapshot.shards[0].summaries=[];assert.ok(types(x).includes('missing-summary'));});
testCase('duplicate expected shard identity is reported',()=>{const x=base();x.sourceInventory.push({...x.sourceInventory[0]});assert.ok(types(x).includes('duplicate-expected-shard'));});
testCase('invalid contract shape is rejected',()=>assert.throws(()=>auditEchoSourceCoverage({sourceInventory:[],derivedSnapshot:{shards:[{path:'/x',version:'v',namespace:'bad'}]}}),TypeError));
// ── source-wide summary-ref resolution (same source identity, multiple shards) ──
// Shards share version+namespace: that is one source identity. Word keys are source-wide, so a
// summary declared in part-a may legitimately cite a word that part-b holds (and vice versa).
const split=()=>({sourceInventory:[
  {path:'/synthetic/src/part-a',version:'echo-index/1',namespace:'log',expectedWords:[{session:'s-a',seq:2}],expectedSummaries:[{cmpId:'cmp-a',session:'s-a',srcSeqs:[2,9]}]},
  {path:'/synthetic/src/part-b',version:'echo-index/1',namespace:'log',expectedWords:[{session:'s-a',seq:9}],expectedSummaries:[]}],
  derivedSnapshot:{shards:[
  {path:'/synthetic/src/part-a',version:'echo-index/1',namespace:'log',cursorSeq:2,words:[{session:'s-a',seq:2}],summaries:[{cmpId:'cmp-a',session:'s-a',srcSeqs:[2,9]}]},
  {path:'/synthetic/src/part-b',version:'echo-index/1',namespace:'log',cursorSeq:9,words:[{session:'s-a',seq:9}],summaries:[]}]}});
const refProblems=(input)=>auditEchoSourceCoverage(input).problems.filter((p)=>p.type==='missing-summary-source-ref');

testCase('a ref declared in one shard and parsed in a sibling shard of the same source resolves',()=>{
  const x=split();
  const r=auditEchoSourceCoverage(x);
  assert.deepEqual(r.problems,[]);
  assert.equal(r.ok,true);
  assert.equal(refProblems(x).length,0);
});
testCase('source-wide ref that is present but declared nowhere is missing-summary-source-ref (not-declared)',()=>{
  const x=split();x.sourceInventory[1].expectedWords=[];
  const p=refProblems(x);
  assert.equal(p.length,1);
  assert.equal(p[0].cmpId,'cmp-a');assert.equal(p[0].session,'s-a');assert.equal(p[0].seq,9);
  assert.equal(p[0].reason,'not-declared');
  assert.ok(types(x).includes('unexpected-word'));
  assert.equal(auditEchoSourceCoverage(x).ok,false);
});
testCase('source-wide ref that is declared but parsed nowhere is missing-summary-source-ref (not-parsed)',()=>{
  const x=split();x.derivedSnapshot.shards[1].words=[];
  const p=refProblems(x);
  assert.equal(p.length,1);
  assert.equal(p[0].seq,9);assert.equal(p[0].reason,'not-parsed');
  assert.ok(types(x).includes('missing-word'));
  assert.equal(auditEchoSourceCoverage(x).ok,false);
});
testCase('a word held only under a different version or namespace identity never resolves a ref',()=>{
  for(const patch of ['version','namespace']){
    const x=split();
    const value=patch==='version'?'echo-index/2':'v4log';
    x.sourceInventory[1][patch]=value;x.derivedSnapshot.shards[1][patch]=value;
    const p=refProblems(x);
    // The ref's own identity neither declares nor holds seq 9, so it is not laundered across identities.
    assert.equal(p.length,1,patch);assert.equal(p[0].seq,9,patch);assert.equal(p[0].reason,'neither',patch);
    assert.equal(types(x).includes('missing-shard'),false,patch);
  }
});
testCase('sparse refs spread over shards never infer an unlisted seq gap',()=>{
  const x=split();
  x.sourceInventory[0].expectedSummaries[0].srcSeqs=[9,2];
  x.sourceInventory[1].expectedWords=[{session:'s-a',seq:9}];
  x.derivedSnapshot.shards[0].summaries[0].srcSeqs=[9,2];
  const r=auditEchoSourceCoverage(x);
  assert.deepEqual(r.problems,[]);
  assert.equal(r.problems.filter((p)=>p.seq>=3&&p.seq<=8).length,0);
  assert.equal(refProblems(x).length,0);
});
testCase('repeated missing refs are walked in order but deduped per (shard,cmpId,session,seq)',()=>{
  const x=split();
  x.sourceInventory[0].expectedSummaries[0].srcSeqs=[7,7];
  x.derivedSnapshot.shards[0].summaries[0].srcSeqs=[7,7];
  const p=refProblems(x);
  assert.equal(p.length,1);
  assert.equal(p[0].seq,7);assert.equal(p[0].reason,'neither');
  x.sourceInventory[0].expectedSummaries.push({cmpId:'cmp-b',session:'s-a',srcSeqs:[7]});
  x.derivedSnapshot.shards[0].summaries.push({cmpId:'cmp-b',session:'s-a',srcSeqs:[7]});
  const q=refProblems(x);
  assert.equal(q.length,2);
  assert.deepEqual(q.map((r)=>r.cmpId),['cmp-a','cmp-b']);
});
// ── documented limitation: (version, namespace) is the entire ref scope ──
// The coverage inventory is flattened: the parent sourcePath is gone and a shard path names only a
// shard. So two logically different sources that share version+namespace are ONE scope, and a
// summary in 'one' is resolved by a word key only 'two' declares/holds. Pinned for two reasons:
// (a) the honest expectation is stated instead of discovered by surprise, (b) nobody "fixes" it by
// scoping refs to a shard path, which would re-break the cross-shard case above.
testCase('documented limitation: sources sharing version+namespace share one ref scope',()=>{
  const x={sourceInventory:[
    {path:'/synthetic/src/one',version:'echo-index/1',namespace:'log',expectedWords:[],expectedSummaries:[{cmpId:'cmp-a',session:'s-a',srcSeqs:[9]}]},
    {path:'/synthetic/src/two',version:'echo-index/1',namespace:'log',expectedWords:[{session:'s-a',seq:9}],expectedSummaries:[]}],
    derivedSnapshot:{shards:[
    {path:'/synthetic/src/one',version:'echo-index/1',namespace:'log',cursorSeq:0,words:[],summaries:[{cmpId:'cmp-a',session:'s-a',srcSeqs:[9]}]},
    {path:'/synthetic/src/two',version:'echo-index/1',namespace:'log',cursorSeq:9,words:[{session:'s-a',seq:9}],summaries:[]}]}};
  const r=auditEchoSourceCoverage(x);
  assert.deepEqual(r.problems,[]);
  assert.equal(r.ok,true);
  // Same shared scope, but the only holder of the word is gone: the ref is still unresolved.
  x.derivedSnapshot.shards[1].words=[];
  const p=refProblems(x);
  assert.equal(p.length,1);
  assert.equal(p[0].reason,'not-parsed');
});
console.log('RESULT '+passed+' passed / '+failed+' failed');if(failed)process.exitCode=1;
