#!/usr/bin/env node
// Pure in-memory selftest. No fs, no path, no temp directories, no services.
// Every byte is built here with TextEncoder and handed to the adapter in memory.
import assert from 'node:assert/strict';
import { parseSyntheticEchoImporterShards, auditSummaryRefs, IMPORTER_WORD_FIELDS, IMPORTER_SUMMARY_FIELDS, IMPORTER_SUMMARY_STATUSES } from './echo-source-shard-importer-adapter.mjs';

const enc=(s)=>new TextEncoder().encode(s);
const line=(x)=>JSON.stringify(x)+'\n';
const SESSION='session-adapter-a1';
// Importer/builder-shaped row: exactly the 11 ECHO_WORD_FIELDS.
const word=(seq,text,over={})=>({t:'2026-11-15T10:00:00.000Z',session:SESSION,ws:'--synthetic-workspace--',seq,turn:null,log:null,role:'user',kind:'原话',len:Array.from(text).length,truncated:false,text,...over});
const summary=(over={})=>({cmpId:'cmp-adapter-01',t:'2026-11-15T10:00:01.000Z',session:SESSION,ws:null,log:null,srcSeqs:[1,0,1],shadowedTokens:4,shadowedChars:9,provider:'synthetic',model:'synthetic-summary-1',status:'active',summary:'Synthetic summary body',...over});
const source={sourcePath:'D:/synthetic/echo-source-adapter/index',version:'synthetic-source/1',namespace:'log'};
const WORD_PATH='D:/synthetic/echo-source-adapter/index/words.jsonl';
const shard=(bytes,over={})=>({shardId:'shard-a',path:WORD_PATH,bytes,expectedWords:[{session:SESSION,seq:0},{session:SESSION,seq:1}],expectedSummaries:[],...over});
const both=()=>enc(line(word(0,'alpha'))+line(word(1,'beta')));
const withSummary=(over={},wordsOverride={})=>{
  const bytes=enc(line(word(0,'alpha'))+line(word(1,'beta')));
  const s=summary(over);
  return {shard:shard(bytes,{expectedSummaries:[{cmpId:s.cmpId,session:s.session,srcSeqs:s.srcSeqs.slice()}],summaryBytes:enc(line(s)),...wordsOverride}),summary:s,bytes};
};
const parse=(bytes,sh)=>parseSyntheticEchoImporterShards({source,shards:[sh||shard(bytes)]});
const hasProblem=(list,type)=>list.some((p)=>p.type===type);

let passed=0,failed=0;
function test(name,fn){try{fn();passed++;console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name+': '+(e&&e.stack||e));}}

test('field lists mirror the importer contract exactly (no hidden extras)',()=>{
  assert.deepEqual([...IMPORTER_WORD_FIELDS],['t','session','ws','seq','turn','log','role','kind','len','truncated','text']);
  assert.deepEqual([...IMPORTER_SUMMARY_FIELDS],['cmpId','t','session','ws','log','srcSeqs','shadowedTokens','shadowedChars','provider','model','status','summary']);
  assert.deepEqual([...IMPORTER_SUMMARY_STATUSES],['active','void']);
});

test('sparse seq 0,1 with summary refs [1,0,1] completes without gap inference',()=>{
  const {shard:sh}=withSummary();
  const r=parseSyntheticEchoImporterShards({source,shards:[sh]});
  const receipt=r.parsedShards[0].receipt;
  assert.equal(receipt.status,'complete');
  assert.equal(receipt.cursorSeq,1);
  assert.deepEqual(receipt.rows,[{session:SESSION,seq:0},{session:SESSION,seq:1}]);
  assert.equal(r.sourceAudit.sourceReadCoverage,'complete');
  assert.equal(r.sourceAudit.sourceReadProblems.length,0);
  assert.equal(r.coverageAudit.ok,true,JSON.stringify(r.coverageAudit));
  assert.deepEqual(r.sourceAudit.derivedSnapshot.shards[0].words,[{session:SESSION,seq:0},{session:SESSION,seq:1}]);
  assert.deepEqual(r.sourceAudit.derivedSnapshot.shards[0].summaries,[{cmpId:'cmp-adapter-01',session:SESSION,srcSeqs:[1,0,1]}]);
  assert.deepEqual(r.summaryRefAudit,{checked:3,resolvedPresent:3,resolvedDeclaredOnly:0,missing:0});
  assert.deepEqual(r.diagnostics,[]);
});

test('byte/raw-line accounting is exact for words and summaries',()=>{
  const {shard:sh,bytes,summary:s}=withSummary();
  const r=parseSyntheticEchoImporterShards({source,shards:[sh]});
  const receipt=r.parsedShards[0].receipt;
  const wordLines=r.parsedShards[0].wordLines;
  assert.equal(receipt.consumedBytes,bytes.length);
  assert.equal(receipt.byteLength,bytes.length);
  assert.equal(receipt.lineCount,2);
  assert.equal(wordLines.length,2);
  assert.equal(wordLines[0].byteStart,0);
  assert.equal(wordLines[0].bytes,enc(line(word(0,'alpha'))).length);
  assert.equal(wordLines[0].rawLine,JSON.stringify(word(0,'alpha')));
  assert.equal(wordLines[0].byteEnd,wordLines[1].byteStart);
  assert.equal(wordLines[1].byteEnd,bytes.length);
  assert.equal(wordLines.reduce((n,l)=>n+l.bytes,0),bytes.length);
  const summaryBytes=enc(line(s));
  assert.equal(receipt.summaryByteLength,summaryBytes.length);
  assert.equal(receipt.summaryLineCount,1);
  assert.equal(r.parsedShards[0].summaryLines[0].bytes,summaryBytes.length);
  assert.equal(r.parsedShards[0].summaryLines[0].byteEnd,summaryBytes.length);
  assert.equal(receipt.summaries[0].rawLine,JSON.stringify(s));
  assert.deepEqual(receipt.summaries[0].srcSeqs,[1,0,1]);
});

test('input descriptors and bytes are not mutated; two calls are identical',()=>{
  const {shard:sh}=withSummary();
  const bytes=Array.from(sh.bytes),summaryBytes=Array.from(sh.summaryBytes);
  const before=JSON.stringify({shardId:sh.shardId,path:sh.path,expectedWords:sh.expectedWords,expectedSummaries:sh.expectedSummaries});
  const a=parseSyntheticEchoImporterShards({source,shards:[sh]});
  const b=parseSyntheticEchoImporterShards({source,shards:[sh]});
  assert.deepEqual(a,b);
  assert.deepEqual(Array.from(sh.bytes),bytes);
  assert.deepEqual(Array.from(sh.summaryBytes),summaryBytes);
  assert.equal(JSON.stringify({shardId:sh.shardId,path:sh.path,expectedWords:sh.expectedWords,expectedSummaries:sh.expectedSummaries}),before);
});

test('malformed JSON row fails closed at the first bad line',()=>{
  const r=parse(enc(line(word(0,'alpha'))+'{bad}\n'));
  assert.equal(r.parsedShards[0].receipt.status,'failed');
  assert.equal(r.parsedShards[0].receipt.rows.length,0);
  assert.equal(r.parsedShards[0].receipt.consumedBytes,enc(line(word(0,'alpha'))).length);
  assert.ok(hasProblem(r.sourceAudit.sourceReadProblems,'malformed-json'));
  assert.equal(r.sourceAudit.sourceReadCoverage,'unknown');
});

test('schema violations fail closed with invalid-row (missing/extra/seq/session/turn/len/truncated)',()=>{
  const cases=[
    ['missing-field',(()=>{const w=word(0,'alpha');delete w.turn;return w;})()],
    ['extra-field',{...word(0,'alpha'),payload:'tool'}],
    ['seq-negative',word(-1,'alpha')],
    ['seq-unsafe',word(Number.MAX_SAFE_INTEGER+2,'alpha')],
    ['bad-session',word(0,'alpha',{session:'bad session'})],
    ['turn-negative',word(0,'alpha',{turn:-1})],
    ['len-too-small',word(0,'alpha',{len:2})],
    ['truncated-lie',word(0,'alpha',{len:99,truncated:false})],
    ['bad-ws',word(0,'alpha',{ws:7})],
    ['bad-t',word(0,'alpha',{t:'not-a-time'})],
    ['reasoning-row',word(0,'alpha',{kind:'reasoning'})],
    ['empty-text',word(0,'   ')]
  ];
  for(const [name,row] of cases){
    const r=parse(enc(line(row)));
    assert.equal(r.parsedShards[0].receipt.status,'failed',name);
    assert.ok(hasProblem(r.sourceAudit.sourceReadProblems,'invalid-row'),name+': '+JSON.stringify(r.sourceAudit.sourceReadProblems));
  }
});

test('truncated=true is accepted and still demands exact byte accounting',()=>{
  const bytes=enc(line(word(0,'alpha',{len:99,truncated:true})));
  const r=parse(bytes,shard(bytes,{expectedWords:[{session:SESSION,seq:0}]}));
  assert.equal(r.parsedShards[0].receipt.status,'complete');
  assert.equal(r.parsedShards[0].receipt.consumedBytes,bytes.length);
  assert.equal(r.coverageAudit.ok,true,JSON.stringify(r.coverageAudit));
});

test('duplicate word key fails closed',()=>{
  const r=parse(enc(line(word(0,'alpha'))+line(word(0,'alpha-again'))));
  assert.equal(r.parsedShards[0].receipt.status,'failed');
  assert.ok(hasProblem(r.sourceAudit.sourceReadProblems,'duplicate-source-word-key'));
});

test('sparse seq 0,5 stays complete without inventing 1..4',()=>{
  const bytes=enc(line(word(0,'alpha'))+line(word(5,'omega')));
  const s=summary({srcSeqs:[5,0]});
  const sh=shard(bytes,{expectedWords:[{session:SESSION,seq:0},{session:SESSION,seq:5}],expectedSummaries:[{cmpId:s.cmpId,session:s.session,srcSeqs:s.srcSeqs.slice()}],summaryBytes:enc(line(s))});
  const r=parseSyntheticEchoImporterShards({source,shards:[sh]});
  assert.equal(r.parsedShards[0].receipt.status,'complete');
  assert.equal(r.parsedShards[0].receipt.cursorSeq,5);
  assert.deepEqual(r.parsedShards[0].receipt.rows,[{session:SESSION,seq:0},{session:SESSION,seq:5}]);
  assert.deepEqual(r.parsedShards[0].receipt.rows.map((w)=>w.seq),[0,5]);
  assert.equal(r.coverageAudit.ok,true,JSON.stringify(r.coverageAudit));
  assert.equal(r.diagnostics.length,0);
});

test('a word key duplicated across shards fails closed (source-wide uniqueness)',()=>{
  const a=shard(both(),{shardId:'shard-a',path:WORD_PATH});
  const b=shard(both(),{shardId:'shard-b',path:'D:/synthetic/echo-source-adapter/index/words-b.jsonl'});
  const r=parseSyntheticEchoImporterShards({source,shards:[a,b]});
  assert.ok(hasProblem(r.sourceAudit.sourceReadProblems,'duplicate-source-word-key-across-shards'));
  assert.ok(hasProblem(r.coverageAudit.problems,'duplicate-source-word-key-across-shards'));
  assert.equal(r.coverageAudit.ok,false);
  assert.notEqual(r.sourceAudit.sourceReadCoverage,'complete');
  assert.ok(r.diagnostics.some((d)=>d.type==='duplicate-source-word-key-across-shards'&&d.seq===0));
});

test('a summary cmpId duplicated across shards fails closed',()=>{
  const s1=summary();
  const s2=summary({srcSeqs:[2]});
  const a=shard(both(),{expectedSummaries:[{cmpId:s1.cmpId,session:s1.session,srcSeqs:s1.srcSeqs.slice()}],summaryBytes:enc(line(s1))});
  const b=shard(enc(line(word(2,'gamma'))+line(word(3,'delta'))),{shardId:'shard-b',path:'D:/synthetic/echo-source-adapter/index/words-b.jsonl',
    expectedWords:[{session:SESSION,seq:2},{session:SESSION,seq:3}],
    expectedSummaries:[{cmpId:s2.cmpId,session:s2.session,srcSeqs:s2.srcSeqs.slice()}],summaryBytes:enc(line(s2))});
  const r=parseSyntheticEchoImporterShards({source,shards:[a,b]});
  assert.ok(hasProblem(r.sourceAudit.sourceReadProblems,'duplicate-summary-id-across-shards'));
  assert.ok(hasProblem(r.coverageAudit.problems,'duplicate-summary-id-across-shards'));
  assert.equal(r.coverageAudit.ok,false);
  assert.notEqual(r.sourceAudit.sourceReadCoverage,'complete');
  assert.ok(r.diagnostics.some((d)=>d.type==='duplicate-summary-id-across-shards'&&d.cmpId==='cmp-adapter-01'));
});

test('missing final LF is partial, not complete',()=>{
  const bytes=enc(JSON.stringify(word(0,'alpha')));
  const r=parse(bytes,shard(bytes,{expectedWords:[{session:SESSION,seq:0}]}));
  assert.equal(r.parsedShards[0].receipt.status,'partial');
  assert.equal(r.parsedShards[0].receipt.malformedTail,true);
  assert.ok(hasProblem(r.sourceAudit.sourceReadProblems,'missing-final-lf'));
  assert.notEqual(r.sourceAudit.sourceReadCoverage,'complete');
});

test('BOM, invalid UTF-8 and non-Uint8Array bytes fail closed',()=>{
  const bom=parse(new Uint8Array([0xef,0xbb,0xbf,...both()]));
  assert.equal(bom.parsedShards[0].receipt.status,'failed');
  assert.ok(hasProblem(bom.sourceAudit.sourceReadProblems,'utf8-bom'));
  const bad=parse(new Uint8Array([0xc3,0x28,0x0a]));
  assert.ok(hasProblem(bad.sourceAudit.sourceReadProblems,'invalid-utf8'));
  // Non-byte buffers never reach a receipt: descriptor validation rejects them up front.
  assert.throws(()=>parseSyntheticEchoImporterShards({source,shards:[{...shard(enc('')),bytes:[1,2,3]}]}),/Uint8Array bytes/);
});

test('non-Uint8Array shard bytes are rejected by descriptor validation',()=>{
  assert.throws(()=>parseSyntheticEchoImporterShards({source,shards:[{...shard(enc('')),bytes:'text'}]}),/requires shardId, canonical path and Uint8Array bytes/);
});

test('summary srcSeqs pointing at no present and no declared word are rejected, not counted as coverage',()=>{
  const {shard:sh}=withSummary({srcSeqs:[1,0,5]});
  const r=parseSyntheticEchoImporterShards({source,shards:[sh]});
  assert.equal(r.coverageAudit.ok,false,JSON.stringify(r.coverageAudit));
  assert.ok(hasProblem(r.coverageAudit.problems,'summary-source-ref-missing'));
  assert.ok(hasProblem(r.sourceAudit.sourceReadProblems,'summary-source-ref-missing'));
  assert.notEqual(r.sourceAudit.sourceReadCoverage,'complete');
  assert.deepEqual(r.summaryRefAudit,{checked:3,resolvedPresent:2,resolvedDeclaredOnly:0,missing:1});
  const problem=r.coverageAudit.problems.find((p)=>p.type==='summary-source-ref-missing');
  assert.equal(problem.seq,5);
  assert.equal(problem.origin,'parsed');
});

test('a ref satisfied only by a declared word fails closed: both sides are required',()=>{
  const bytes=enc(line(word(0,'alpha')));
  const s=summary({srcSeqs:[0,2]});
  const sh=shard(bytes,{expectedWords:[{session:SESSION,seq:0},{session:SESSION,seq:2}],expectedSummaries:[{cmpId:s.cmpId,session:s.session,srcSeqs:s.srcSeqs.slice()}],summaryBytes:enc(line(s))});
  const r=parseSyntheticEchoImporterShards({source,shards:[sh]});
  assert.equal(r.summaryRefAudit.missing,1);
  assert.equal(r.summaryRefAudit.resolvedDeclaredOnly,1);
  assert.equal(r.summaryRefAudit.resolvedPresent,1);
  assert.ok(hasProblem(r.coverageAudit.problems,'summary-source-ref-missing'));
  assert.ok(hasProblem(r.coverageAudit.problems,'missing-word'));
  assert.equal(r.coverageAudit.ok,false);
  const problem=r.coverageAudit.problems.find((p)=>p.type==='summary-source-ref-missing');
  assert.equal(problem.seq,2);
  assert.equal(problem.reason,'not-parsed');
  assert.ok(r.diagnostics.some((d)=>d.type==='summary-source-ref-missing'&&d.seq===2&&d.reason==='not-parsed'));
  assert.notEqual(r.sourceAudit.sourceReadCoverage,'complete');
});

test('a ref present in parsed words but absent from expectedWords fails closed (not-declared)',()=>{
  const bytes=both();
  const s=summary({srcSeqs:[1,0]});
  const sh=shard(bytes,{expectedWords:[{session:SESSION,seq:0}],expectedSummaries:[{cmpId:s.cmpId,session:s.session,srcSeqs:s.srcSeqs.slice()}],summaryBytes:enc(line(s))});
  const r=parseSyntheticEchoImporterShards({source,shards:[sh]});
  assert.equal(r.summaryRefAudit.resolvedPresent,1,JSON.stringify(r.summaryRefAudit));
  assert.equal(r.summaryRefAudit.missing,1,JSON.stringify(r.summaryRefAudit));
  const problem=r.coverageAudit.problems.find((p)=>p.type==='summary-source-ref-missing');
  assert.equal(problem.seq,1);
  assert.equal(problem.reason,'not-declared');
  assert.equal(r.coverageAudit.ok,false);
  assert.ok(hasProblem(r.coverageAudit.problems,'unexpected-word'));
  assert.notEqual(r.sourceAudit.sourceReadCoverage,'complete');
});

// --- ref identity scope ---------------------------------------------------------------------
// The adapter entry accepts exactly one parent source, so cross-source isolation is proven at the
// exported auditSummaryRefs seam with hand-built inventory/derived rows. A scope is the FULL parent
// identity (sourcePath,version,namespace): source-wide across that identity's shards, closed across
// identities.
const SRC_A='D:/synthetic/echo-source-adapter/ref-a';
const SRC_B='D:/synthetic/echo-source-adapter/ref-b';
const shardIdentity=(path,version,namespace)=>JSON.stringify([path,version,namespace]);
const sourceIdentity=(sourcePath,version,namespace)=>JSON.stringify([sourcePath,version,namespace]);
const refInventory=(path,version,namespace,seqs,summaries=[])=>({path,version,namespace,
  expectedWords:seqs.map((seq)=>({session:SESSION,seq})),
  expectedSummaries:summaries.map((m)=>({cmpId:m.cmpId,session:SESSION,srcSeqs:m.srcSeqs.slice()}))});
const refDerived=(path,version,namespace,seqs,summaries=[])=>({path,version,namespace,
  cursorSeq:seqs.length?Math.max(...seqs):0,
  words:seqs.map((seq)=>({session:SESSION,seq})),
  summaries:summaries.map((m)=>({cmpId:m.cmpId,session:SESSION,srcSeqs:m.srcSeqs.slice()}))});
// descriptors = [{shardId,shardPath,version,namespace,sourcePath}]
const refScope=(descriptors)=>{
  const byShard=new Map(),idsByShard=new Map();
  for(const d of descriptors){
    const k=shardIdentity(d.shardPath,d.version,d.namespace);
    byShard.set(k,sourceIdentity(d.sourcePath,d.version,d.namespace));
    idsByShard.set(k,d.shardId);
  }
  return {byShard,idsByShard};
};
const countRefAudit=(a)=>({checked:a.checked,resolvedPresent:a.resolvedPresent,resolvedDeclaredOnly:a.resolvedDeclaredOnly,missing:a.missing.length});

test('a summary ref resolves across sibling shards of one source identity',()=>{
  const s=summary({srcSeqs:[0]});
  const a=shard(both(),{shardId:'shard-a',path:WORD_PATH});
  const b=shard(enc(line(word(2,'gamma'))),{shardId:'shard-b',path:'D:/synthetic/echo-source-adapter/index/words-b.jsonl',
    expectedWords:[{session:SESSION,seq:2}],
    expectedSummaries:[{cmpId:s.cmpId,session:s.session,srcSeqs:[0]}],summaryBytes:enc(line(s))});
  const r=parseSyntheticEchoImporterShards({source,shards:[a,b]});
  assert.deepEqual(r.summaryRefAudit,{checked:1,resolvedPresent:1,resolvedDeclaredOnly:0,missing:0});
  assert.equal(r.coverageAudit.ok,true,JSON.stringify(r.coverageAudit));
  assert.deepEqual(r.diagnostics,[]);
  assert.deepEqual(r.sourceAudit.sourceReadProblems,[]);
});

test('a ref never cross-resolves between different sourcePath at identical version+namespace',()=>{
  const version='synthetic-source/1',namespace='log';
  const pathA=SRC_A+'/words.jsonl',pathB=SRC_B+'/words.jsonl';
  const row={cmpId:'cmp-scope',srcSeqs:[0]};
  const inventory=[refInventory(pathA,version,namespace,[0]),refInventory(pathB,version,namespace,[1],[row])];
  const derived=[refDerived(pathA,version,namespace,[0]),refDerived(pathB,version,namespace,[1],[row])];
  const split=refScope([
    {shardId:'shard-a',shardPath:pathA,version,namespace,sourcePath:SRC_A},
    {shardId:'shard-b',shardPath:pathB,version,namespace,sourcePath:SRC_B}
  ]);
  const audit=auditSummaryRefs(inventory,derived,split.idsByShard,split.byShard);
  assert.deepEqual(countRefAudit(audit),{checked:1,resolvedPresent:0,resolvedDeclaredOnly:0,missing:1},JSON.stringify(audit));
  assert.equal(audit.missing[0].reason,'neither');
  assert.equal(audit.missing[0].cmpId,'cmp-scope');
  assert.equal(audit.missing[0].origin,'parsed');
  assert.equal(audit.missing[0].shardId,'shard-b');
  // Control: the exact same rows resolve once both shards sit under ONE source identity, so the
  // negative result above is the source boundary and not a fixture that could never resolve.
  const merged=refScope([
    {shardId:'shard-a',shardPath:pathA,version,namespace,sourcePath:SRC_B},
    {shardId:'shard-b',shardPath:pathB,version,namespace,sourcePath:SRC_B}
  ]);
  const control=auditSummaryRefs(inventory,derived,merged.idsByShard,merged.byShard);
  assert.deepEqual(countRefAudit(control),{checked:1,resolvedPresent:1,resolvedDeclaredOnly:0,missing:0});
});

test('a ref never cross-resolves across a version or namespace boundary',()=>{
  const base='D:/synthetic/echo-source-adapter/ref-scope';
  const pathA=base+'/a/words.jsonl',pathB=base+'/b/words.jsonl';
  const row={cmpId:'cmp-scope',srcSeqs:[0]};
  const variants=[
    ['version',{aVersion:'synthetic-source/1',bVersion:'synthetic-source/2',aNamespace:'log',bNamespace:'log'}],
    ['namespace',{aVersion:'synthetic-source/1',bVersion:'synthetic-source/1',aNamespace:'log',bNamespace:'v4log'}]
  ];
  for(const [name,v] of variants){
    // Same parent sourcePath, same shard paths; only the dimension under test differs.
    const inventory=[refInventory(pathA,v.aVersion,v.aNamespace,[0]),refInventory(pathB,v.bVersion,v.bNamespace,[1],[row])];
    const derived=[refDerived(pathA,v.aVersion,v.aNamespace,[0]),refDerived(pathB,v.bVersion,v.bNamespace,[1],[row])];
    const split=refScope([
      {shardId:'shard-a',shardPath:pathA,version:v.aVersion,namespace:v.aNamespace,sourcePath:base},
      {shardId:'shard-b',shardPath:pathB,version:v.bVersion,namespace:v.bNamespace,sourcePath:base}
    ]);
    const audit=auditSummaryRefs(inventory,derived,split.idsByShard,split.byShard);
    assert.deepEqual(countRefAudit(audit),{checked:1,resolvedPresent:0,resolvedDeclaredOnly:0,missing:1},name+': '+JSON.stringify(audit));
    assert.equal(audit.missing[0].reason,'neither',name);
    assert.equal(audit.missing[0].shardId,'shard-b',name);
    // Control: collapsing only the dimension under test resolves the same rows.
    const mergedInventory=[refInventory(pathA,v.aVersion,v.aNamespace,[0]),refInventory(pathB,v.aVersion,v.aNamespace,[1],[row])];
    const mergedDerived=[refDerived(pathA,v.aVersion,v.aNamespace,[0]),refDerived(pathB,v.aVersion,v.aNamespace,[1],[row])];
    const merged=refScope([
      {shardId:'shard-a',shardPath:pathA,version:v.aVersion,namespace:v.aNamespace,sourcePath:base},
      {shardId:'shard-b',shardPath:pathB,version:v.aVersion,namespace:v.aNamespace,sourcePath:base}
    ]);
    const control=auditSummaryRefs(mergedInventory,mergedDerived,merged.idsByShard,merged.byShard);
    assert.equal(control.resolvedPresent,1,name+': '+JSON.stringify(control));
    assert.equal(control.missing.length,0,name);
  }
});

test('one-sided refs stay missing inside their own source identity (present-only / declared-only)',()=>{
  const version='synthetic-source/1',namespace='log';
  const pathA=SRC_A+'/words.jsonl',pathB=SRC_A+'/words-b.jsonl';
  const row={cmpId:'cmp-scope',srcSeqs:[0]};
  const bInv=refInventory(pathB,version,namespace,[1],[row]),bDerived=refDerived(pathB,version,namespace,[1],[row]);
  const scope=refScope([
    {shardId:'shard-a',shardPath:pathA,version,namespace,sourcePath:SRC_A},
    {shardId:'shard-b',shardPath:pathB,version,namespace,sourcePath:SRC_A}
  ]);
  // present-only: a sibling parses seq 0, but no shard of the identity ever declared it.
  const present=auditSummaryRefs([refInventory(pathA,version,namespace,[]),bInv],
    [refDerived(pathA,version,namespace,[0]),bDerived],scope.idsByShard,scope.byShard);
  assert.deepEqual(countRefAudit(present),{checked:1,resolvedPresent:0,resolvedDeclaredOnly:0,missing:1},JSON.stringify(present));
  assert.equal(present.missing[0].reason,'not-declared');
  // declared-only: a sibling declares seq 0, but no shard of the identity parsed it.
  const declared=auditSummaryRefs([refInventory(pathA,version,namespace,[0]),bInv],
    [refDerived(pathA,version,namespace,[]),bDerived],scope.idsByShard,scope.byShard);
  assert.deepEqual(countRefAudit(declared),{checked:1,resolvedPresent:0,resolvedDeclaredOnly:1,missing:1},JSON.stringify(declared));
  assert.equal(declared.missing[0].reason,'not-parsed');
});

test('summary-ref audit fails closed when a shard has no parent source identity',()=>{
  const version='synthetic-source/1',namespace='log',pathA=SRC_A+'/words.jsonl';
  const inventory=[refInventory(pathA,version,namespace,[0])],derived=[refDerived(pathA,version,namespace,[0])];
  const ids=new Map([[shardIdentity(pathA,version,namespace),'shard-a']]);
  assert.throws(()=>auditSummaryRefs(inventory,derived,ids,undefined),/parent source identity map/);
  assert.throws(()=>auditSummaryRefs(inventory,derived,ids,new Map()),/no parent source identity/);
});

test('strict summary schema rejects extra/missing fields, bad status, bad counts, bad cmpId, bad types',()=>{
  const cases=[
    ['extra',{...summary(),payload:'tool'}],
    ['missing',(()=>{const s=summary();delete s.model;return s;})()],
    ['status',summary({status:'draft'})],
    ['shadowed',summary({shadowedTokens:-1})],
    ['cmpId',summary({cmpId:'bad/id'})],
    ['ws-type',summary({ws:7})],
    ['srcSeqs',summary({srcSeqs:[1,-1]})],
    ['empty-summary',summary({summary:'  '})]
  ];
  for(const [name,s] of cases){
    const bytes=both();
    const sh=shard(bytes,{expectedSummaries:[{cmpId:'cmp-adapter-01',session:SESSION,srcSeqs:[1,0,1]}],summaryBytes:enc(line(s))});
    const r=parseSyntheticEchoImporterShards({source,shards:[sh]});
    assert.equal(r.parsedShards[0].receipt.status,'failed',name);
    assert.equal(r.parsedShards[0].receipt.summaries.length,0,name);
    assert.ok(hasProblem(r.sourceAudit.sourceReadProblems,'invalid-summary-row'),name+': '+JSON.stringify(r.sourceAudit.sourceReadProblems));
  }
});

test('duplicate summary cmpId and blank summary line fail closed',()=>{
  const bytes=both();
  const dup=parseSyntheticEchoImporterShards({source,shards:[shard(bytes,{expectedSummaries:[{cmpId:'cmp-adapter-01',session:SESSION,srcSeqs:[1,0,1]}],summaryBytes:enc(line(summary())+line(summary()))})]});
  assert.equal(dup.parsedShards[0].receipt.status,'failed');
  assert.ok(hasProblem(dup.sourceAudit.sourceReadProblems,'duplicate-summary-id'));
  // The builder's canonical no-summary file is a single LF; the TEMP summary contract rejects it.
  const blank=parseSyntheticEchoImporterShards({source,shards:[shard(bytes,{summaryBytes:enc('\n')})]});
  assert.equal(blank.parsedShards[0].receipt.status,'failed');
  assert.ok(hasProblem(blank.sourceAudit.sourceReadProblems,'blank-summary-line'));
});

test('summary table without final LF is partial',()=>{
  const bytes=both();
  const sh=shard(bytes,{expectedSummaries:[{cmpId:'cmp-adapter-01',session:SESSION,srcSeqs:[1,0,1]}],summaryBytes:enc(JSON.stringify(summary()))});
  const r=parseSyntheticEchoImporterShards({source,shards:[sh]});
  assert.equal(r.parsedShards[0].receipt.status,'partial');
  assert.equal(r.parsedShards[0].receipt.malformedTail,true);
  assert.ok(hasProblem(r.sourceAudit.sourceReadProblems,'summary-missing-final-lf'));
});

test('declared summaries without bytes stay explicitly missing',()=>{
  const bytes=both();
  const sh=shard(bytes,{expectedSummaries:[{cmpId:'cmp-adapter-01',session:SESSION,srcSeqs:[1,0,1]}]});
  const r=parseSyntheticEchoImporterShards({source,shards:[sh]});
  assert.equal(r.parsedShards[0].receipt.status,'partial');
  assert.ok(hasProblem(r.parsedShards[0].diagnostics,'summary-bytes-not-provided'));
  assert.equal(r.coverageAudit.ok,false);
  assert.ok(hasProblem(r.coverageAudit.problems,'missing-summary'));
  assert.equal(hasProblem(r.coverageAudit.problems,'summary-source-ref-missing'),false);
});

test('failed word shard stays failed when summary bytes are also absent',()=>{
  // Regression: the missing-summary downgrade used to force status='partial' on every receipt,
  // so a shard whose word JSONL was malformed (zero parsed rows) reported itself as merely
  // incomplete. A failure must survive an unrelated coverage gap.
  const bytes=enc(line(word(0,'alpha'))+'{bad}\n');
  const sh=shard(bytes,{expectedSummaries:[{cmpId:'cmp-adapter-01',session:SESSION,srcSeqs:[1,0,1]}]});
  const r=parseSyntheticEchoImporterShards({source,shards:[sh]});
  const receipt=r.parsedShards[0].receipt;
  assert.equal(receipt.status,'failed');
  // Failure semantics are untouched: no rows are emitted and the parse error is still carried.
  assert.deepEqual(receipt.rows,[]);
  assert.equal(typeof receipt.error,'string');
  assert.match(receipt.error,/malformed JSON/);
  assert.equal(receipt.completeFrameBoundary,false);
  assert.deepEqual(receipt.summaries,[]);
  // A failed shard emits no data by contract, so coverage cannot be claimed in any form.
  assert.equal(r.sourceAudit.sourceReadCoverage,'unknown');
  // Diagnostics stay fail-closed and additive: the parse failure, the reader's failed-shard
  // verdict and the missing summary bytes all survive; the coverage gap never masks the failure.
  assert.ok(hasProblem(r.sourceAudit.sourceReadProblems,'malformed-json'),JSON.stringify(r.sourceAudit.sourceReadProblems));
  assert.ok(hasProblem(r.sourceAudit.sourceReadProblems,'failed-shard'),JSON.stringify(r.sourceAudit.sourceReadProblems));
  assert.ok(hasProblem(r.sourceAudit.sourceReadProblems,'summary-bytes-not-provided'));
  assert.ok(hasProblem(r.parsedShards[0].diagnostics,'malformed-json'));
  assert.ok(hasProblem(r.parsedShards[0].diagnostics,'summary-bytes-not-provided'));
  assert.equal(r.coverageAudit.ok,false);
  // The declared summary's refs can never be "parsed" when the receipt failed, so none of them
  // may be counted as resolved: present is empty, so every ref stays missing (fail-closed).
  assert.equal(r.summaryRefAudit.resolvedPresent,0,JSON.stringify(r.summaryRefAudit));
  assert.ok(r.summaryRefAudit.missing>0,JSON.stringify(r.summaryRefAudit));
});

test('top-level shape, source and shard identities fail closed with TypeError',()=>{
  assert.throws(()=>parseSyntheticEchoImporterShards(),/requires \{source,shards\}/);
  assert.throws(()=>parseSyntheticEchoImporterShards({source:{sourcePath:'relative',version:'v',namespace:'log'},shards:[]}),/canonical sourcePath/);
  assert.throws(()=>parseSyntheticEchoImporterShards({source:{...source,namespace:'idx'},shards:[]}),/canonical sourcePath/);
  assert.throws(()=>parseSyntheticEchoImporterShards({source,shards:[null]}),/requires shardId, canonical path and Uint8Array bytes/);
  assert.throws(()=>parseSyntheticEchoImporterShards({source,shards:[shard(both()),{...shard(both()),path:WORD_PATH}]}),/duplicate shardId/);
  assert.throws(()=>parseSyntheticEchoImporterShards({source,shards:[shard(both()),shard(both(),{shardId:'shard-b'})]}),/duplicate coverage shard identity/);
  assert.throws(()=>parseSyntheticEchoImporterShards({source,shards:[{...shard(both()),expectedWords:undefined}]}),/expectedWords and expectedSummaries/);
});

console.log('RESULT '+passed+' passed / '+failed+' failed');
if(failed)process.exitCode=1;
