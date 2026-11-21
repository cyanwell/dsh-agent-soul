import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDiagnostic, safeRefusalFingerprint } from './echo-index-production-sync.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'echo-sync-selftest-'));
let temp=null, okTemp=null;
try {
 const shards=path.join(root,'shards'); fs.mkdirSync(shards);
 const words=path.join(shards,'words.jsonl'), summaries=path.join(shards,'summaries.jsonl');
 const word=JSON.stringify({t:'2026-01-01T00:00:00.000Z',session:'session-123456',ws:null,seq:7,turn:null,log:null,role:'user',kind:'原话',len:3,truncated:false,text:'hey'})+'\n';
 fs.writeFileSync(words,word); fs.writeFileSync(summaries,'\n');
 const before=[words,summaries].map(f=>fs.readFileSync(f));
 const emptyWords=path.join(shards,'empty-words.jsonl'), emptySums=path.join(shards,'empty-sums.jsonl'); fs.writeFileSync(emptyWords,'\n'); fs.writeFileSync(emptySums,'\n');
 const files=path.join(root,'files.jsonl');
 const rows=[{file:'/tmp/session-123456.jsonl',nWord:0,nSum:0,wordOut:words,sumOut:summaries},{file:'/tmp/session-987654.jsonl',nWord:0,nSum:0,wordOut:emptyWords,sumOut:emptySums}];
 fs.writeFileSync(files,rows.map(x=>JSON.stringify(x)).join('\n')+'\n');
 const globals=path.join(root,'globals'); fs.mkdirSync(globals); for(const f of ['words.jsonl','summaries.jsonl']) fs.writeFileSync(path.join(globals,f),'\n');
 temp=fs.mkdtempSync(path.join(os.tmpdir(),'echo-sync-out-'));
 const report=runDiagnostic(['--dry-run'],{filesPath:files,wordsPath:path.join(globals,'words.jsonl'),summariesPath:path.join(globals,'summaries.jsonl'),shardsRoot:shards,tempRoot:temp,builder:({outDir})=>{fs.mkdirSync(outDir,{recursive:true});fs.writeFileSync(path.join(outDir,'manifest.json'),'temporary');throw new Error('bad C:\\private\\session-123456 cmpId=987654 \"quoted value\"');}});
 assert.equal(report.buildRefusals,2); assert.equal(report.builtSources,0);
 assert.equal(report.sourceBuckets.manifestDeclaredEmpty,2); assert.equal(report.sourceBuckets.physicalEmpty,1); assert.equal(report.sourceBuckets.declaredCountMismatch,1);
 // 相反方向：声明空 / 物理非空，必须单独成桶，不能和「物理空」混成一条。
 assert.equal(report.sourceBuckets.declaredEmptyPhysicalNonempty,1);
 assert.deepEqual(Object.keys(report.sourceBuckets).sort(),['declaredCountMismatch','declaredEmptyPhysicalNonempty','declaredNonemptyBuilt','declaredNonemptyRefused','manifestDeclaredEmpty','physicalEmpty']);
 // 两个源都被真的尝试构建过（builder 抛错 2 次）—— 声明计数没有让任何源被跳过或被接受。
 assert.equal(report.buildRefusals+report.builtSources,2);
 assert.equal(report.refusalCodes['Error:UNCLASSIFIED'],2); assert.equal(Object.values(report.refusalTemplates).reduce((a,b)=>a+b,0),2);
 // 报告只能带指纹（template + 脱敏 shape），不能带原文与任何标识。
 const reportText=JSON.stringify(report);
 for(const secret of ['private','987654','quoted value','session-123456']) assert.equal(reportText.includes(secret),false,'report leaked: '+secret);
 const key=Object.keys(report.refusalTemplates)[0]; assert.equal(key.includes('"shape"'),true,'fingerprint key must carry sanitized shape');
 assert.equal(fs.existsSync(path.join(temp,'source-0000','out')),false); assert.equal(fs.existsSync(path.join(temp,'source-0001','out')),false);
 assert.deepEqual([words,summaries].map(f=>fs.readFileSync(f)),before); assert.deepEqual([emptyWords,emptySums].map(f=>fs.readFileSync(f)),[Buffer.from('\n'),Buffer.from('\n')]);
 const fp=safeRefusalFingerprint(new Error('files.jsonl C:\\Users\\name\\secret.jsonl session-456 cmpId=998877 \"quoted\"'));
 assert.deepEqual(fp.template,['artifact:files.jsonl','field:cmpId','field:session']); const encoded=JSON.stringify(fp); for(const secret of ['Users','secret','456','998877','"quoted"']) assert.equal(encoded.includes(secret),false);
 assert.equal(safeRefusalFingerprint(new Error('unrecognized diagnostic')).code,'UNCLASSIFIED');
 const shaped=safeRefusalFingerprint(new Error('cannot read D:\\AI\\memory\\hub\\index\\shards\\s1.jsonl row 48213 field "user secret" 会话张三'));
 const shapeJson=JSON.stringify(shaped.shape);
 assert.equal(shaped.code,'UNCLASSIFIED');
 for(const secret of ['AI','memory','hub','shards','s1','48213','user secret','张三']) assert.equal(shapeJson.includes(secret),false,'sanitizer leaked: '+secret);
 for(const marker of ['<path>','<num>','<quoted>','<text>']) assert.equal(shapeJson.includes(marker),true,'missing shape marker: '+marker);
 assert.notEqual(safeRefusalFingerprint(new Error('cannot read /tmp/a/b.jsonl row 1')).shape,safeRefusalFingerprint(new Error('invalid value at /tmp/z/q.jsonl row 9')).shape);
 assert.equal(safeRefusalFingerprint({name:'TypeError',message:'x'}).name,'TypeError');
 assert.throws(()=>runDiagnostic(['--apply'],{filesPath:files}),/PRODUCTION_APPLY_NOT_IMPLEMENTED/);
 // 成功路径（合成）：声明非空、但 nWord/nSum 与物理不符的源，必须真的被交给 builder。
 // 诊断只记一次 declaredCountMismatch，不能因此跳过构建、也不能因此接受声明计数。
 const okRoot=path.join(root,'success'), okShards=path.join(okRoot,'shards'); fs.mkdirSync(okShards,{recursive:true});
 const okWords=path.join(okShards,'words.jsonl'), okSums=path.join(okShards,'summaries.jsonl');
 fs.writeFileSync(okWords,word+word);
 fs.writeFileSync(okSums,JSON.stringify({t:'2026-01-01T00:00:00.000Z',session:'session-123456',id:'cmp-1',srcSeqs:[7],summary:'s'})+'\n');
 const okFiles=path.join(okRoot,'files.jsonl');
 fs.writeFileSync(okFiles,JSON.stringify({file:'/tmp/session-123456.jsonl',nWord:99,nSum:99,wordOut:okWords,sumOut:okSums})+'\n');
 const okBefore=[okWords,okSums].map(f=>fs.readFileSync(f));
 okTemp=fs.mkdtempSync(path.join(os.tmpdir(),'echo-sync-ok-'));
 const okReport=runDiagnostic(['--dry-run'],{filesPath:okFiles,wordsPath:okWords,summariesPath:okSums,shardsRoot:okShards,tempRoot:okTemp,builder:({outDir})=>{fs.mkdirSync(outDir,{recursive:true});const manifestPath=path.join(outDir,'manifest.json');fs.writeFileSync(manifestPath,'{"synthetic":true}');return {manifestPath,manifest:{counts:{words:2,summaries:1,excluded:0,excludedReasoning:0,truncatedExcluded:0,exactDuplicateWords:0,exactDuplicateSummaries:0},summaryRefs:{refs:1,resolved:1,dangling:0}}};}});
 assert.equal(okReport.mode,'dry-run'); assert.equal(okReport.sourceRows,1);
 assert.deepEqual(okReport.declared,{words:99,summaries:99}); assert.deepEqual(okReport.physical,{words:2,summaries:1});
 assert.equal(okReport.sourceBuckets.declaredCountMismatch,1);
 assert.equal(okReport.sourceBuckets.declaredNonemptyBuilt,1);
 assert.equal(okReport.sourceBuckets.declaredNonemptyRefused,0); assert.equal(okReport.sourceBuckets.manifestDeclaredEmpty,0);
 assert.equal(okReport.sourceBuckets.physicalEmpty,0); assert.equal(okReport.sourceBuckets.declaredEmptyPhysicalNonempty,0);
 assert.equal(okReport.builtSources,1); assert.equal(okReport.buildRefusals,0); assert.equal(okReport.representativeBuilderError,null);
 assert.equal(okReport.eligible.words,2); assert.equal(okReport.eligible.summaries,1);
 assert.deepEqual(okReport.references,{srcSeqs:1,resolved:1,dangling:0});
 // 快照判据：fixture 文件跑完必须一字未动。
 assert.equal(okReport.sourceFiles.unchangedCount,okReport.sourceFiles.count);
 assert.equal(okReport.sourceFiles.allUnchanged,true); assert.equal(okReport.allSourcesUnchanged,true);
 assert.equal(okReport.sourceFiles.shardUnchangedCount,okReport.sourceFiles.shardCount);
 assert.deepEqual([okWords,okSums].map(f=>fs.readFileSync(f)),okBefore);
 // 临时输出：构建确实发生在 TEMP 下，且跑完能整棵删干净。
 assert.equal(fs.existsSync(path.join(okTemp,'source-0000','out','manifest.json')),true);
 fs.rmSync(okTemp,{recursive:true,force:true}); assert.equal(fs.existsSync(okTemp),false); okTemp=null;
 // B1-b：同一次运行里「构建成功的源」+「构建被拒的源」，两个源的声明计数都与物理不符。
 // declaredCountMismatch 必须在物理行数已知之后、builder 之前对每条源都记一次 —— 被拒的源不能漏计。
 const mixRoot=path.join(root,'mixed'), mixShards=path.join(mixRoot,'shards'); fs.mkdirSync(mixShards,{recursive:true});
 const mixBadWords=path.join(mixShards,'bad-words.jsonl'), mixBadSums=path.join(mixShards,'bad-sums.jsonl');
 const mixOkWords=path.join(mixShards,'ok-words.jsonl'), mixOkSums=path.join(mixShards,'ok-sums.jsonl');
 fs.writeFileSync(mixBadWords,word); fs.writeFileSync(mixBadSums,'\n');
 fs.writeFileSync(mixOkWords,word+word);
 fs.writeFileSync(mixOkSums,JSON.stringify({t:'2026-01-01T00:00:00.000Z',session:'session-123456',id:'cmp-2',srcSeqs:[7],summary:'s'})+'\n');
 const mixBefore=[mixBadWords,mixBadSums,mixOkWords,mixOkSums].map(f=>fs.readFileSync(f));
 const mixFiles=path.join(mixRoot,'files.jsonl');
 const mixRows=[
  {file:'/tmp/refuse-me-123456.jsonl',nWord:5,nSum:0,wordOut:mixBadWords,sumOut:mixBadSums},
  {file:'/tmp/build-me-123456.jsonl',nWord:99,nSum:99,wordOut:mixOkWords,sumOut:mixOkSums}
 ];
 fs.writeFileSync(mixFiles,mixRows.map(x=>JSON.stringify(x)).join('\n')+'\n');
 const mixGlobals=path.join(mixRoot,'globals'); fs.mkdirSync(mixGlobals); for(const f of ['words.jsonl','summaries.jsonl']) fs.writeFileSync(path.join(mixGlobals,f),'\n');
 const mixTemp=fs.mkdtempSync(path.join(os.tmpdir(),'echo-sync-mix-'));
 let mixReport;
 try {
  mixReport=runDiagnostic(['--dry-run'],{filesPath:mixFiles,wordsPath:path.join(mixGlobals,'words.jsonl'),summariesPath:path.join(mixGlobals,'summaries.jsonl'),shardsRoot:mixShards,tempRoot:mixTemp,builder:({selectedLogPath,outDir})=>{fs.mkdirSync(outDir,{recursive:true});if(String(selectedLogPath).includes('refuse-me'))throw new Error('synthetic refusal');const manifestPath=path.join(outDir,'manifest.json');fs.writeFileSync(manifestPath,'{"synthetic":true}');return {manifestPath,manifest:{counts:{words:2,summaries:1,excluded:0,excludedReasoning:0,truncatedExcluded:0,exactDuplicateWords:0,exactDuplicateSummaries:0},summaryRefs:{refs:1,resolved:1,dangling:0}}};}});
 } finally { fs.rmSync(mixTemp,{recursive:true,force:true}); }
 assert.equal(mixReport.sourceRows,2); assert.equal(mixReport.missingShards,0);
 // 核心断言：一成功一被拒，两个源都声明计数不符 → 必须都记上（拒掉的源没有漏计）。
 assert.equal(mixReport.sourceBuckets.declaredCountMismatch,2);
 assert.equal(mixReport.builtSources,1); assert.equal(mixReport.buildRefusals,1);
 assert.equal(mixReport.buildRefusals+mixReport.builtSources,2);
 assert.equal(mixReport.sourceBuckets.declaredNonemptyBuilt,1); assert.equal(mixReport.sourceBuckets.declaredNonemptyRefused,1);
 assert.equal(mixReport.sourceBuckets.physicalEmpty,0); assert.equal(mixReport.sourceBuckets.manifestDeclaredEmpty,0);
 assert.equal(mixReport.sourceBuckets.declaredEmptyPhysicalNonempty,0);
 assert.deepEqual(mixReport.declared,{words:104,summaries:99}); assert.deepEqual(mixReport.physical,{words:3,summaries:1});
 assert.deepEqual(Object.keys(mixReport.sourceBuckets).sort(),['declaredCountMismatch','declaredEmptyPhysicalNonempty','declaredNonemptyBuilt','declaredNonemptyRefused','manifestDeclaredEmpty','physicalEmpty']);
 assert.equal(mixReport.allSourcesUnchanged,true);
 assert.deepEqual([mixBadWords,mixBadSums,mixOkWords,mixOkSums].map(f=>fs.readFileSync(f)),mixBefore);
 assert.equal(fs.existsSync(path.join(mixTemp,'source-0000','out','manifest.json')),false);
 console.log('echo-index-production-sync-selftest: PASS');
} finally { if(okTemp) fs.rmSync(okTemp,{recursive:true,force:true}); if(temp) fs.rmSync(temp,{recursive:true,force:true}); fs.rmSync(root,{recursive:true,force:true}); }
