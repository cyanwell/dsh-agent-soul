#!/usr/bin/env node
// Read-only production ECHO shard profile with optional TEMP-target import simulation.
// No production DB, session log, frame_index, 02-墨, service, network, or production writes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { openMetaStore } from '../src/db/index.mjs';
import { buildFromEchoIndexFiles } from './echo-source-build.mjs';

const NODE=process.execPath;
const HERE=path.dirname(fileURLToPath(import.meta.url));
const IMPORTER=path.join(HERE,'echo-index-import.mjs');
const INDEX='D:/AI/memory/hub/index';
const FILES=path.join(INDEX,'files.jsonl');
const SHARDS=path.join(INDEX,'shards');
const sha=(b)=>createHash('sha256').update(b).digest('hex');
const fail=(m)=>{throw new Error(m)};
const SAFE_BUILDER_CODES=['WORD_SEQ_CONFLICT','SUMMARY_ID_CONFLICT','SRC_SEQ_DANGLING','UNKNOWN_KIND','ROLE_KIND_CONFLICT','WORD_TEXT_BLANK','LOG_MISSING','SOURCE_NOT_DECLARED','SESSION_MISMATCH','WS_MISMATCH','SUMMARY_ID_INVALID','SUMMARY_SESSION_MISMATCH','SUMMARY_LOG_MISSING'];
function safeBuildErrorCode(error){
  if(error&&typeof error.code==='string'&&SAFE_BUILDER_CODES.includes(error.code))return error.code;
  const message=String(error&&error.message||'');
  for(const code of SAFE_BUILDER_CODES)if(message.includes(code))return code;
  return 'UNCLASSIFIED';
}
const SAFE_ARTIFACTS=['files.jsonl','words.jsonl','summaries.jsonl','manifest.json'];
const SAFE_FIELDS=new Set(['seq','session','ws','role','kind','text','cmpId','srcSeqs','summary','status','t','log','provider','model','nWord','nSum']);
export function refusalTemplate(error){
  const text=String(error&&error.message||'');
  const tokens=[];
  for(const artifact of SAFE_ARTIFACTS)if(text.includes(artifact))tokens.push('artifact:'+artifact);
  for(const match of text.matchAll(/\b([A-Za-z][A-Za-z0-9_]*)\b/g))if(SAFE_FIELDS.has(match[1]))tokens.push('field:'+match[1]);
  return [...new Set(tokens)].sort();
}
const SHAPE_VOCAB=new Set('a about absolute after all allowed already an and any are array as at be because before boolean build built by byte bytes cannot case code codes conflict count counts cursor data declared did do does duplicate empty entry error exists expected explicit failed field fields file files first for from got has have id ids if in index invalid is it json key keys kind line lines log logs manifest may mismatch must name negative no not number object of offset on only option options or order out parse path paths posix range read record records refuse refused refuses refusing role row rows safe seq session signed source sources string supported than that the their them then there these this those to token tokens truncated try two type under unexpected unless unsigned unresolved unsupported use used user value values was were when where which while will with without word words write'.split(' '));
const SHAPE_MARKER=/^<[a-z]+>$/;
const SHAPE_MARKERS=new Set(['<path>','<quoted>','<num>','<hash>','<text>','<tok>','<more>']);
const SHAPE_MAX_TOKENS=24,SHAPE_MAX_INPUT=2000;
// 只产出「形状」，不产出原文：路径 / 引号值 / 数字标识 / 十六进制串 / 非 ASCII 一律抹成标记，剩余词还必须在固定词表内。
// 结果可以进报告、进 stdout；原文与用户数据永远不落。
export function sanitizeRefusalMessage(message){
  let text=String(message===undefined||message===null?'':message).slice(0,SHAPE_MAX_INPUT);
  text=text.replace(/[^\x09\x0A\x0D\x20-\x7E]+/g,' <text> ');
  text=text.replace(/\b[0-9a-fA-F]{16,}\b/g,' <hash> ');
  text=text.replace(/'[^'\n]{0,200}'|"[^"\n]{0,200}"|\x60[^\x60\n]{0,200}\x60/g,' <quoted> ');
  text=text.replace(/[A-Za-z]:[\\/][^\s'"\x60<>|]*/g,' <path> ');
  text=text.replace(/\\\\[^\s'"\x60<>|]+/g,' <path> ');
  text=text.replace(/(^|[\s'"\x60(=,;:])(\/[^\s'"\x60]*)/g,(m,lead)=>lead+' <path> ');
  text=text.replace(/(?<![A-Za-z0-9])\d[\w.:+-]*(?![A-Za-z0-9])/g,' <num> ');
  const out=[];
  for(const tok of text.split(/\s+/)){
    if(!tok)continue;
    const core=tok.replace(/^[^\w<>]+/,'').replace(/[^\w<>]+$/,'');
    if(core.length===0)continue;
    if(SHAPE_MARKER.test(core)&&SHAPE_MARKERS.has(core))out.push(core);
    else if(/^[A-Za-z][A-Za-z_]{0,23}$/.test(core)&&SHAPE_VOCAB.has(core.toLowerCase()))out.push(core.toLowerCase());
    else out.push('<tok>');
    if(out.length>=SHAPE_MAX_TOKENS){out.push('<more>');break;}
  }
  return out.join(' ');
}
export function safeRefusalFingerprint(error){
  const name=error&&error.name==='TypeError'?'TypeError':error&&error.name==='RangeError'?'RangeError':'Error';
  return {name,code:safeBuildErrorCode(error),template:refusalTemplate(error),shape:sanitizeRefusalMessage(error&&error.message)};
}
function parseLines(file){
  let bytes; try { bytes=fs.readFileSync(file); } catch (e) { const x=new Error('SOURCE_READ_FAILED'); x.code='SOURCE_READ_FAILED'; throw x; }
  const text=bytes.toString('utf8');
  if(!Buffer.from(text,'utf8').equals(bytes)){const e=new Error('INVALID_UTF8');e.code='INVALID_UTF8';throw e;}
  const lines=text.split('\n');
  if(lines[lines.length-1]==='')lines.pop();
  const rows=[];
  for(let i=0;i<lines.length;i++){const raw=lines[i];if(!raw)continue;let row;try{row=JSON.parse(raw)}catch{const e=new Error('JSONL_INVALID');e.code='JSONL_INVALID';throw e;}rows.push({raw,row});}
  return {bytes,rows};
}
function sourceFile(file,shardsRoot=SHARDS){
  if(typeof file!=='string'||!path.isAbsolute(file))fail('SHARD_PATH_NOT_ABSOLUTE');
  const abs=path.resolve(file),root=path.resolve(shardsRoot),rel=path.relative(root,abs);
  if(rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))fail('SHARD_PATH_OUTSIDE_AUTHORIZED_ROOT');
  if(!fs.existsSync(abs)||!fs.statSync(abs).isFile())fail('SHARD_MISSING');
  return abs;
}
function snap(file){const bytes=fs.readFileSync(file),s=fs.statSync(file);return {bytes:bytes.length,mtimeMs:s.mtimeMs,mtimeUtc:s.mtime.toISOString(),sha256:sha(bytes)};}
function importerReceipt(manifestPath,dbPath){
  const r=spawnSync(NODE,[IMPORTER,'--manifest',manifestPath,'--sha256',sha(fs.readFileSync(manifestPath)),'--generation','1','--db',dbPath,'--json'],{encoding:'utf8',cwd:HERE});
  if(r.error)throw r.error;
  if(r.status!==0){let x={};try{x=JSON.parse(r.stdout)}catch{};const e=new Error('TEMP_IMPORT_FAILED');e.code=x.code||'TEMP_IMPORT_FAILED';throw e;}
  return JSON.parse(r.stdout);
}
function parseArgs(argv){
  if(argv.includes('--apply'))fail('PRODUCTION_APPLY_NOT_IMPLEMENTED_IN_TASK62');
  const allowed=new Set(['--dry-run','--temp-sim']);let mode='dry-run';
  for(const arg of argv){if(!allowed.has(arg))fail('UNKNOWN_ARGUMENT');if(arg==='--temp-sim')mode='temp-sim';}
  return mode;
}
function summaryRefs(manifest){
  const r=manifest.summaryRefs||{};return {refs:Number(r.refs)||0,resolved:Number(r.resolved)||0,dangling:Number(r.dangling)||0};
}
let stage='parse-args';
export function runDiagnostic(argv=[],options={}){
  const mode=parseArgs(argv);
  stage='snapshot';
  const index=options.indexDir||INDEX, filesPath=options.filesPath||path.join(index,'files.jsonl'), wordsPath=options.wordsPath||path.join(index,'words.jsonl'), summariesPath=options.summariesPath||path.join(index,'summaries.jsonl'), shardsRoot=options.shardsRoot||path.join(index,'shards');
  const tempRoot=options.tempRoot||fs.mkdtempSync(path.join(os.tmpdir(),'echo-index-sync-dryrun-'));
  const ownsTempRoot=!options.tempRoot;
  if(!path.isAbsolute(tempRoot)||!path.resolve(tempRoot).startsWith(path.resolve(os.tmpdir())+path.sep))fail('TEMP_ROOT_REQUIRED');
  const targetDb=path.join(tempRoot,'simulation-target.sqlite');
  const ownedSnapshots=new Map();
  try{
    stage='snapshot-global';for(const p of [filesPath,wordsPath,summariesPath])ownedSnapshots.set(p,snap(p));
    stage='parse-files';const files=parseLines(filesPath);const sourceRows=files.rows;
    const report={mode,sourceRows:sourceRows.length,declared:{words:0,summaries:0},physical:{words:0,summaries:0},eligible:{words:0,summaries:0},excluded:{reasoning:0,truncated:0,other:0},duplicates:{wordExact:0,summaryExact:0,perSourceCmpIds:0,globalCmpIds:0},references:{srcSeqs:0,resolved:0,dangling:0},missingShards:0,buildRefusals:0,builtSources:0,refusalCodes:{},sourceBuckets:{manifestDeclaredEmpty:0,physicalEmpty:0,declaredCountMismatch:0,declaredEmptyPhysicalNonempty:0,declaredNonemptyBuilt:0,declaredNonemptyRefused:0},refusalTemplates:{},importCodes:{},importedSources:0,representativeBuilderError:null,sourceFiles:null,allSourcesUnchanged:false};
    if(mode==='temp-sim'){stage='init-temp-target';const s=openMetaStore({path:targetDb,mode:'readwrite'});try{s.migrate();if((s.echoStats().sources||[]).length!==0)fail('TEMP_TARGET_NOT_EMPTY')}finally{s.close();}}
    const globalCmp=new Map();
    for(let i=0;i<sourceRows.length;i++){
      stage='source-'+i+'-validate-shards';const src=sourceRows[i].row;report.declared.words+=Number(src.nWord)||0;report.declared.summaries+=Number(src.nSum)||0;
      const declaredEmpty=Number(src.nWord)===0&&Number(src.nSum)===0; if(declaredEmpty)report.sourceBuckets.manifestDeclaredEmpty++;
      const declaredNonempty=!declaredEmpty;
      let wordPath,summaryPath;
      try{wordPath=sourceFile(src.wordOut,shardsRoot);summaryPath=sourceFile(src.sumOut,shardsRoot);}catch(e){report.missingShards++;const code=e.code||'SHARD_UNAVAILABLE';report.refusalCodes[code]=(report.refusalCodes[code]||0)+1;continue;}
      stage='source-'+i+'-snapshot-shards';for(const p of [wordPath,summaryPath])if(!ownedSnapshots.has(p))ownedSnapshots.set(p,snap(p));
      stage='source-'+i+'-copy-temp';const dir=path.join(tempRoot,'source-'+String(i).padStart(4,'0'));const shardDir=path.join(dir,'shards');fs.mkdirSync(shardDir,{recursive:true});
      const tempWord=path.join(shardDir,path.basename(wordPath)),tempSummary=path.join(shardDir,path.basename(summaryPath));
      const tempRow={...src,wordOut:tempWord,sumOut:tempSummary};const tempFiles=path.join(dir,'files.jsonl');
      fs.writeFileSync(tempFiles,JSON.stringify(tempRow)+'\n');fs.copyFileSync(wordPath,tempWord);fs.copyFileSync(summaryPath,tempSummary);
      const wordSnap=snap(tempWord),summarySnap=snap(tempSummary);
      const physicalWordRows=parseLines(tempWord).rows.length;
      const physicalSummaryRows=parseLines(tempSummary).rows.length;
      report.physical.words+=physicalWordRows;report.physical.summaries+=physicalSummaryRows;
      if(physicalWordRows===0&&physicalSummaryRows===0)report.sourceBuckets.physicalEmpty++;
      if(Number(src.nWord)!==physicalWordRows||Number(src.nSum)!==physicalSummaryRows)report.sourceBuckets.declaredCountMismatch++;
      // 相反方向：清单说这个源是空的，物理上却不空。只做诊断，不改变是否尝试构建。
      if(Number(src.nWord)===0&&Number(src.nSum)===0&&(physicalWordRows>0||physicalSummaryRows>0))report.sourceBuckets.declaredEmptyPhysicalNonempty++;
      let built;
      try{
        stage='source-'+i+'-build-feed';const builder=options.builder||buildFromEchoIndexFiles;built=builder({filesPath:tempFiles,wordsPath:tempWord,summariesPath:tempSummary,selectedLogPath:src.file,namespace:'log',generation:1,builtAt:new Date().toISOString(),outDir:path.join(dir,'out')});
      }catch(e){report.buildRefusals++;const fp=safeRefusalFingerprint(e);const code=fp.code;const name=fp.name;const key=name+':'+code;report.refusalCodes[key]=(report.refusalCodes[key]||0)+1;const tk=JSON.stringify({template:fp.template,shape:fp.shape});report.refusalTemplates[tk]=(report.refusalTemplates[tk]||0)+1;fs.rmSync(path.join(dir,'out'),{recursive:true,force:true});if(declaredNonempty)report.sourceBuckets.declaredNonemptyRefused++;if(!report.representativeBuilderError)report.representativeBuilderError={name,code};continue;}
      const c=built.manifest.counts;const refs=summaryRefs(built.manifest);
      report.eligible.words+=c.words;report.eligible.summaries+=c.summaries;if(declaredNonempty)report.sourceBuckets.declaredNonemptyBuilt++;
      report.excluded.reasoning+=c.excludedReasoning||0;report.excluded.truncated+=c.truncatedExcluded||0;report.excluded.other+=(c.excluded||0)-(c.excludedReasoning||0)-(c.truncatedExcluded||0);
      report.duplicates.wordExact+=c.exactDuplicateWords||0;report.duplicates.summaryExact+=c.exactDuplicateSummaries||0;
      report.references.srcSeqs+=refs.refs;report.references.resolved+=refs.resolved;report.references.dangling+=refs.dangling;
      const summaryRows=parseLines(tempSummary).rows;for(const e of summaryRows){const cmp=String(e.row.id);globalCmp.set(cmp,(globalCmp.get(cmp)||0)+1);}
      report.builtSources++;
      if(mode==='temp-sim'){
        stage='source-'+i+'-temp-import';const receipt=importerReceipt(built.manifestPath,targetDb);
        if(receipt.code==='IMPORTED')report.importedSources++;
        report.importCodes=report.importCodes||{};report.importCodes[receipt.code]=(report.importCodes[receipt.code]||0)+1;
        const check=openMetaStore({path:targetDb,mode:'readonly'});try{if(!check.echoStats().aligned)fail('TEMP_TARGET_NOT_ALIGNED')}finally{check.close();}
      }
    }
    report.duplicates.globalCmpIds=[...globalCmp.values()].reduce((n,c)=>n+Math.max(0,c-1),0);
    report.target=mode==='temp-sim'?(function(){const s=openMetaStore({path:targetDb,mode:'readonly'});try{return {sources:s.echoStats().sources.length,aligned:s.echoStats().aligned};}finally{s.close();}})():null;
    stage='verify-sources';const after=[];for(const [p,before]of ownedSnapshots){const now=snap(p);after.push({pathHash:sha(Buffer.from(p)),...now,unchanged:now.bytes===before.bytes&&now.mtimeMs===before.mtimeMs&&now.sha256===before.sha256});}
    after.sort((a,b)=>a.pathHash.localeCompare(b.pathHash));
    const globalFiles={files:filesPath,words:wordsPath,summaries:summariesPath};
    const globalHashes=new Set(Object.values(globalFiles).map((p)=>sha(Buffer.from(p))));
    const global={};for(const [name,p]of Object.entries(globalFiles)){const v=after.find(x=>x.pathHash===sha(Buffer.from(p)));if(v)global[name]={sha256:v.sha256,bytes:v.bytes,mtimeUtc:v.mtimeUtc,unchanged:v.unchanged};}
    const shards=after.filter((x)=>!globalHashes.has(x.pathHash));
    report.sourceFiles={count:after.length,unchangedCount:after.filter(x=>x.unchanged).length,allUnchanged:after.length===ownedSnapshots.size&&after.every(x=>x.unchanged),global,shardCount:shards.length,shardUnchangedCount:shards.filter(x=>x.unchanged).length,shardPathHash:sha(Buffer.from(shards.map(x=>JSON.stringify([x.pathHash,x.sha256,x.bytes,x.mtimeUtc])).join('\n')))};
    report.allSourcesUnchanged=report.sourceFiles.allUnchanged;
    return report;
  }finally{if(ownsTempRoot){fs.rmSync(tempRoot,{recursive:true,force:true});if(fs.existsSync(tempRoot))fail('TEMP_ROOT_CLEANUP_FAILED');}}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{process.stdout.write(JSON.stringify(runDiagnostic(process.argv.slice(2)))+'\n');}catch(e){process.stderr.write(JSON.stringify({ok:false,stage,code:e.code||'SYNC_DRYRUN_FAILED'})+'\n');process.exitCode=1;}}
