// In-memory-only adapter: importer/builder-shaped ECHO word rows -> reader-contract + coverage audit.
// No filesystem or path APIs are imported or used. Caller supplies every byte; nothing is opened.
//
// Why this file exists (the seam it bridges):
//   tools/echo-source-build.mjs emits rows with the importer's 11 fields
//   (t,session,ws,seq,turn,log,role,kind,len,truncated,text). The TEMP row parser
//   (tools/echo-source-shard-parser.mjs) only accepts the older 6-field row
//   (seq,t,session,ws?,role,text) and rejects 'turn' as an unsupported field. So builder
//   output and the TEMP reader cannot meet today; this adapter reads the importer shape and
//   then reuses the SAME contract surfaces the old parser feeds (echo-source-reader-contract,
//   echo-source-coverage), so inventory/snapshot/problem/audit shapes stay identical.
//
// Contract decisions (all fail-closed, all explicit):
//   1. Field set is exact: every field present, no extra field. The importer tolerates extras
//      (it only requires presence) and drops them when inserting; the synthetic path rejects
//      them instead of silently discarding source text.
//   2. Rows mirror importer rules: seq safe int >=0; turn null or safe int >=0; ws/log string
//      or null; role/kind non-empty; reasoning|thinking rejected (importer + schema both refuse);
//      truncated boolean or 0/1; text non-empty; text chars <= len; truncated=0 implies
//      chars === len (the importer's ROW_TRUNCATION_INCONSISTENT rule).
//   3. Stricter than the importer on one point, on purpose: word/summary 't' must be parseable
//      (the importer only requires a non-empty string). A timestamp nobody can read is not a
//      usable source row for a synthetic fixture.
//   4. Summary JSONL follows the existing TEMP summary contract (12 fields, strict, blank line
//      rejected, final LF required, duplicate cmpId rejected). NOTE, measured: the builder's
//      canonical no-summary file is a single LF byte, which this contract rejects as a blank
//      summary line. That is the existing TEMP summary contract, mirrored deliberately.
//   5. Coverage is derived only from explicit declarations. No contiguous-seq or max(seq)
//      inference, ever.
//   6. Summary srcSeqs are resolved only when the (session,seq) key is BOTH declared in
//      expectedWords AND present in parsed rows, source-wide INSIDE ONE parent source identity
//      (sourcePath,version,namespace) - never across identities. Sibling shards of the same
//      source satisfy each other; two sources that merely share version+namespace do not, even
//      though the coverage module (whose flattened inventory has no sourcePath) can only scope
//      by version+namespace. A ref satisfying only one side (reason not-declared / not-parsed)
//      or neither is reported as 'summary-source-ref-missing' with its reason; coverageAudit.ok
//      becomes false and sourceReadCoverage cannot claim 'complete'. The coverage module applies
//      its own ref rule to the same inventory/snapshot, so an unresolved ref may also surface in
//      its problems; the diagnostics are independent even when both agree the ref is unresolved.
//   7. Word keys (session,seq) and summary cmpIds are unique per SOURCE (v9 schema:
//      UNIQUE(echo_source_id,session,seq), PRIMARY KEY(echo_source_id,cmp_id)). Duplicates
//      inside one shard fail that shard; duplicates across shards are explicit
//      'duplicate-source-word-key-across-shards' / 'duplicate-summary-id-across-shards'
//      diagnostics and force coverageAudit.ok=false.
//   8. Byte/raw-line accounting is exact and carried on the receipt and per shard:
//      consumedBytes = last complete line's end offset (LF included); byteLength = total shard
//      bytes; lineCount = parsed word lines; summaryByteLength/summaryLineCount for the table;
//      every parsed line keeps byteStart/byteEnd/bytes/rawLine (raw text without the LF).
//   9. Unlike tools/echo-source-shard-parser.mjs, a reader-contract rejection is NOT swallowed
//      into a stub audit: it propagates as TypeError. The old parser turns it into an 'unknown'
//      audit object; returning a half-shaped audit would look like a successful read.
import { adaptEchoSourceReads } from './echo-source-reader-contract.mjs';
import { auditEchoSourceCoverage } from './echo-source-coverage.mjs';

// Declared copies of the importer's exports. The source of truth is tools/echo-index-import.mjs;
// tools/echo-source-build-temp-e2e-selftest.mjs asserts these equal the real exports, so drift
// fails a test instead of silently redefining "importer-shaped". A copy is used here because
// importing the importer would load src/db + the native sqlite binding into a memory-only path.
export const IMPORTER_WORD_FIELDS = Object.freeze(['t','session','ws','seq','turn','log','role','kind','len','truncated','text']);
export const IMPORTER_SUMMARY_FIELDS = Object.freeze(['cmpId','t','session','ws','log','srcSeqs','shadowedTokens','shadowedChars','provider','model','status','summary']);
export const IMPORTER_SUMMARY_STATUSES = Object.freeze(['active','void']);

const own = (o,k) => Object.prototype.hasOwnProperty.call(o,k);
const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const str = (x) => typeof x === 'string' && x.trim().length > 0;
const safe = (x) => Number.isSafeInteger(x) && x >= 0;
const canonical = (p) => typeof p === 'string' && p.length > 0 && !p.includes('\\') && (p.startsWith('/') || /^[A-Za-z]:\//.test(p)) && !p.endsWith('/') && !p.includes('//') && !p.split('/').some((s) => s === '.' || s === '..');
const identity = (s) => JSON.stringify([s.path,s.version,s.namespace]);
const wordKey = (w) => JSON.stringify([w.session,w.seq]);
// Full parent source identity. The flattened inventory handed back by the reader contract carries
// only path/version/namespace per shard, so sourcePath is threaded in from the descriptors instead.
const sourceIdentity = (sourcePath,version,namespace) => JSON.stringify([sourcePath,version,namespace]);
const scopedWordKey = (scope,w) => JSON.stringify([scope,w.session,w.seq]);
const SESSION_RE = /^[A-Za-z0-9._-]{1,128}$/;
const CMP_RE = /^[A-Za-z0-9._-]{1,128}$/;
const REASONING = ['reasoning','thinking'];

function validateExpectedWord(w,where){ if(!object(w)||!str(w.session)||!safe(w.seq))throw new TypeError(where+' requires session and seq >= 0'); }
function validateExpectedSummary(s,where){ if(!object(s)||!str(s.cmpId)||!str(s.session)||!Array.isArray(s.srcSeqs)||s.srcSeqs.some((x)=>!safe(x)))throw new TypeError(where+' requires cmpId/session/srcSeqs'); }

// Importer-shaped word row. Every rule names the importer clause it mirrors.
function validateWordRow(row){
  if(!object(row))throw new Error('row must be a JSON object');
  for(const k of Object.keys(row))if(!IMPORTER_WORD_FIELDS.includes(k))throw new Error('unsupported field '+k+' (importer shape is exactly '+IMPORTER_WORD_FIELDS.join(',')+')');
  for(const k of IMPORTER_WORD_FIELDS)if(!own(row,k))throw new Error('missing source field '+k);
  if(typeof row.t!=='string'||!row.t.trim()||!Number.isFinite(Date.parse(row.t)))throw new Error('t must be a parseable timestamp');
  if(typeof row.session!=='string'||!SESSION_RE.test(row.session))throw new Error('session must be ptr-safe ([A-Za-z0-9._-]{1,128})');
  if(!(row.ws===null||typeof row.ws==='string'))throw new Error('ws must be a string or null');
  if(!safe(row.seq))throw new Error('seq must be a safe integer >= 0');
  if(!(row.turn===null||safe(row.turn)))throw new Error('turn must be null or a safe integer >= 0');
  if(!(row.log===null||typeof row.log==='string'))throw new Error('log must be a string or null');
  if(!str(row.role))throw new Error('role must be a non-empty string');
  if(!str(row.kind))throw new Error('kind must be a non-empty string');
  if(REASONING.includes(row.role)||REASONING.includes(row.kind))throw new Error('reasoning rows are not indexed (role/kind reasoning|thinking)');
  if(!safe(row.len))throw new Error('len must be a safe integer >= 0');
  if(!(row.truncated===true||row.truncated===false||row.truncated===0||row.truncated===1))throw new Error('truncated must be boolean or 0/1');
  if(!str(row.text))throw new Error('text must be a non-empty string');
  const chars = Array.from(row.text).length;
  if(chars>row.len)throw new Error('text has '+chars+' chars but len says '+row.len+' (text can never be longer than the declared length)');
  if(!(row.truncated===true||row.truncated===1)&&chars!==row.len)throw new Error('truncated=0 but text has '+chars+' chars while len='+row.len+' (the flag would be a lie)');
}

// Importer-shaped summary row (existing TEMP summary contract, strict field set).
function validateSummaryRow(r){
  if(!object(r))throw new Error('summary must be an object');
  for(const k of Object.keys(r))if(!IMPORTER_SUMMARY_FIELDS.includes(k))throw new Error('unsupported summary field '+k);
  for(const k of IMPORTER_SUMMARY_FIELDS)if(!own(r,k))throw new Error('missing summary field '+k);
  if(typeof r.cmpId!=='string'||!CMP_RE.test(r.cmpId))throw new Error('cmpId must be idx-safe');
  if(typeof r.t!=='string'||!r.t.trim()||!Number.isFinite(Date.parse(r.t)))throw new Error('summary t must be parseable');
  if(typeof r.session!=='string'||!SESSION_RE.test(r.session))throw new Error('summary session must be ptr-safe');
  for(const k of ['ws','log','provider','model'])if(r[k]!==null&&typeof r[k]!=='string')throw new Error(k+' must be string or null');
  if(!Array.isArray(r.srcSeqs)||r.srcSeqs.some((x)=>!safe(x)))throw new Error('srcSeqs must be ordered nonnegative safe integers');
  if(!safe(r.shadowedTokens)||!safe(r.shadowedChars))throw new Error('shadowed counts must be nonnegative safe integers');
  if(!IMPORTER_SUMMARY_STATUSES.includes(r.status))throw new Error('summary status must be active|void');
  if(typeof r.summary!=='string'||!r.summary.trim())throw new Error('summary text must be nonempty');
}

function parseWordBytes(parent,sh,raw){
  const hasFinalLf = raw.length>0 && raw[raw.length-1]===0x0a;
  const rows=[],lines=[],problems=[],seen=new Set();
  let byteStart=0,consumedBytes=0,failedError=null,malformedTail=false,lineNo=0;
  for(let i=0;i<raw.length;i++){
    if(raw[i]!==0x0a)continue;
    lineNo++;
    const physical=raw.subarray(byteStart,i);
    if(physical.length===0){malformedTail=true;failedError='blank physical line '+lineNo;problems.push({type:'blank-line',shardId:sh.shardId,line:lineNo});break;}
    let line;
    try{line=new TextDecoder('utf-8',{fatal:true}).decode(physical);}catch(e){failedError='invalid UTF-8 on line '+lineNo;problems.push({type:'invalid-utf8',shardId:sh.shardId,line:lineNo});break;}
    let row;
    try{row=JSON.parse(line);}catch(e){malformedTail=true;failedError='malformed JSON on line '+lineNo;problems.push({type:'malformed-json',shardId:sh.shardId,line:lineNo});break;}
    try{validateWordRow(row);}catch(e){failedError=e.message+' on line '+lineNo;problems.push({type:'invalid-row',shardId:sh.shardId,line:lineNo,detail:e.message});break;}
    const k=wordKey(row);
    if(seen.has(k)){failedError='duplicate source word key '+row.session+'#'+row.seq;problems.push({type:'duplicate-source-word-key',shardId:sh.shardId,session:row.session,seq:row.seq});break;}
    seen.add(k);
    rows.push({session:row.session,seq:row.seq});
    lines.push({line:lineNo,byteStart,byteEnd:i+1,bytes:i+1-byteStart,session:row.session,seq:row.seq,rawLine:line});
    consumedBytes=i+1;byteStart=i+1;
  }
  if(!hasFinalLf){malformedTail=true;problems.push({type:'missing-final-lf',shardId:sh.shardId});}
  return {rows,lines,problems,failedError,malformedTail,consumedBytes};
}

function parseSummaryBytes(parent,sh,raw){
  const byteLength = raw instanceof Uint8Array ? raw.length : 0;
  const fail=(type,detail)=>({status:'failed',summaries:[],lines:[],malformedTail:false,consumedBytes:0,byteLength,problems:[{type,shardId:sh.shardId,detail,sourcePath:parent.sourcePath}]});
  if(!(raw instanceof Uint8Array))return fail('invalid-summary-byte-buffer','summaryBytes must be Uint8Array');
  if(raw.length>=3&&raw[0]===0xef&&raw[1]===0xbb&&raw[2]===0xbf)return fail('summary-utf8-bom','UTF-8 BOM is not allowed in summaries');
  try{new TextDecoder('utf-8',{fatal:true}).decode(raw);}catch(e){return fail('summary-invalid-utf8','invalid UTF-8 in summaries');}
  const hasFinalLf = raw.length>0 && raw[raw.length-1]===0x0a;
  const summaries=[],lines=[],problems=[],seen=new Set();
  let start=0,consumedBytes=0,lineNo=0,failed=null;
  for(let i=0;i<raw.length;i++){
    if(raw[i]!==0x0a)continue;
    lineNo++;
    const bytes=raw.subarray(start,i);
    if(bytes.length===0){failed='blank summary line '+lineNo;problems.push({type:'blank-summary-line',shardId:sh.shardId,line:lineNo,sourcePath:parent.sourcePath});break;}
    let line,row;
    try{line=new TextDecoder('utf-8',{fatal:true}).decode(bytes);row=JSON.parse(line);validateSummaryRow(row);}catch(e){failed=(e&&e.message)||'invalid summary row';problems.push({type:'invalid-summary-row',shardId:sh.shardId,line:lineNo,detail:failed,sourcePath:parent.sourcePath});break;}
    if(seen.has(row.cmpId)){failed='duplicate summary cmpId '+row.cmpId;problems.push({type:'duplicate-summary-id',shardId:sh.shardId,cmpId:row.cmpId,line:lineNo,sourcePath:parent.sourcePath});break;}
    seen.add(row.cmpId);
    summaries.push({cmpId:row.cmpId,session:row.session,srcSeqs:row.srcSeqs.slice(),rawLine:line});
    lines.push({line:lineNo,byteStart:start,byteEnd:i+1,bytes:i+1-start,cmpId:row.cmpId,session:row.session,srcSeqs:row.srcSeqs.slice(),rawLine:line});
    consumedBytes=i+1;start=i+1;
  }
  if(!hasFinalLf){problems.push({type:'summary-missing-final-lf',shardId:sh.shardId,sourcePath:parent.sourcePath});return {status:failed?'failed':'partial',summaries,lines,malformedTail:true,consumedBytes,byteLength,problems};}
  if(failed)return {status:'failed',summaries:[],lines:[],malformedTail:false,consumedBytes:0,byteLength,problems};
  return {status:'complete',summaries,lines,malformedTail:false,consumedBytes,byteLength,problems};
}

function failReceipt(parent,sh,error,accounting){
  return {sourcePath:parent.sourcePath,version:parent.version,namespace:parent.namespace,shardId:sh.shardId,status:'failed',consumedBytes:accounting.consumedBytes,cursorSeq:accounting.rows.length?Math.max(...accounting.rows.map((r)=>r.seq)):0,completeFrameBoundary:false,malformedTail:false,rows:[],summaries:[],error,
    byteLength:sh.bytes instanceof Uint8Array?sh.bytes.length:0,lineCount:accounting.lines.length,summaryByteLength:accounting.summaryByteLength,summaryLineCount:accounting.summaryLineCount};
}

function parseShard(parent,sh){
  const blankAccounting={rows:[],lines:[],consumedBytes:0,summaryByteLength:0,summaryLineCount:0};
  const failEarly=(type,error)=>({
    receipt:failReceipt(parent,sh,error,blankAccounting),
    diagnostics:[{type,shardId:sh.shardId,sourcePath:parent.sourcePath}],
    wordLines:[],summaryLines:[]
  });
  const raw=sh.bytes;
  // Unreachable through the public entry (descriptor validation rejects non-Uint8Array first).
  // Kept so a shard-level byte failure has the same taxonomy as echo-source-shard-parser.mjs.
  if(!(raw instanceof Uint8Array))return failEarly('invalid-byte-buffer','bytes must be Uint8Array');
  if(raw.length>=3&&raw[0]===0xef&&raw[1]===0xbb&&raw[2]===0xbf)return failEarly('utf8-bom','UTF-8 BOM is not allowed');
  try{new TextDecoder('utf-8',{fatal:true}).decode(raw);}catch(e){return failEarly('invalid-utf8','invalid UTF-8');}
  const words=parseWordBytes(parent,sh,raw);
  const summaryParsed=sh.summaryBytes===undefined?null:parseSummaryBytes(parent,sh,sh.summaryBytes);
  const accounting={rows:words.rows,lines:words.lines,consumedBytes:words.consumedBytes,
    summaryByteLength:summaryParsed?summaryParsed.byteLength:0,summaryLineCount:summaryParsed?summaryParsed.lines.length:0};
  if(words.failedError){
    return {receipt:failReceipt(parent,sh,words.failedError,accounting),diagnostics:words.problems,wordLines:words.lines,summaryLines:summaryParsed?summaryParsed.lines:[]};
  }
  let status=words.malformedTail?'partial':'complete';
  const receipt={sourcePath:parent.sourcePath,version:parent.version,namespace:parent.namespace,shardId:sh.shardId,status,consumedBytes:words.consumedBytes,
    cursorSeq:words.rows.length?Math.max(...words.rows.map((r)=>r.seq)):0,completeFrameBoundary:!words.malformedTail,malformedTail:words.malformedTail,
    rows:words.rows,summaries:summaryParsed?summaryParsed.summaries:[],byteLength:raw.length,lineCount:words.rows.length,
    summaryByteLength:summaryParsed?summaryParsed.byteLength:0,summaryLineCount:summaryParsed?summaryParsed.summaries.length:0};
  const diagnostics=[...words.problems];
  if(summaryParsed){
    diagnostics.push(...summaryParsed.problems);
    if(summaryParsed.status==='failed'){receipt.status='failed';receipt.completeFrameBoundary=false;receipt.malformedTail=summaryParsed.malformedTail;receipt.summaries=[];}
    else if(summaryParsed.status==='partial'&&receipt.status==='complete'){receipt.status='partial';receipt.completeFrameBoundary=false;receipt.malformedTail=true;}
  }
  return {receipt,diagnostics,wordLines:words.lines,summaryLines:summaryParsed?summaryParsed.lines:[]};
}

const refProblemSort=(a,b)=>[a.shardId||'',a.cmpId||'',a.session||'',String(a.seq),a.origin||''].join('|').localeCompare([b.shardId||'',b.cmpId||'',b.session||'',String(b.seq),b.origin||''].join('|'),'en');
const coverageProblemSort=(a,b)=>[a.shard||'',a.type||'',a.cmpId||'',a.session||'',String(a.seq??''),a.origin||''].join('|').localeCompare([b.shard||'',b.type||'',b.cmpId||'',b.session||'',String(b.seq??''),b.origin||''].join('|'),'en');
const diagSort=(a,b)=>[a.shardId||'',a.type||'',String(a.line??''),a.session||'',String(a.seq??''),a.cmpId||'',a.detail||''].join('|').localeCompare([b.shardId||'',b.type||'',String(b.line??''),b.session||'',String(b.seq??''),b.cmpId||'',b.detail||''].join('|'),'en');

// Ref resolution is scoped per FULL parent source identity (sourcePath,version,namespace):
// present = parsed rows of the derived snapshot, declared = expectedWords, each grouped by the
// identity of the source that owns the shard. Inside one group the union is source-wide because a
// word key is (session,seq) within a source; across groups nothing is shared, so a word held by
// source A can never resolve a ref of source B even when both carry the same version+namespace.
// parentByShard maps coverage shard identity -> parent source identity; a missing entry is a
// contract violation, not something to paper over, so it throws instead of silently unscoping.
export function auditSummaryRefs(sourceInventory,derivedShards,shardIdByPath,parentByShard){
  if(!(parentByShard instanceof Map))throw new TypeError('summary-ref audit requires a parent source identity map');
  const scopeOf=(s)=>{
    const scope=parentByShard.get(identity(s));
    if(typeof scope!=='string')throw new TypeError('summary-ref audit has no parent source identity for shard '+s.path+' · '+s.version+' · '+s.namespace);
    return scope;
  };
  const present=new Set(),declared=new Set();
  for(const s of derivedShards){const scope=scopeOf(s);for(const w of s.words)present.add(scopedWordKey(scope,w));}
  for(const s of sourceInventory){const scope=scopeOf(s);for(const w of s.expectedWords)declared.add(scopedWordKey(scope,w));}
  // One row per (source identity, shard, cmpId): a summary that is both declared and parsed is
  // counted once, and the parsed row wins because it carries the bytes that actually arrived.
  const byShardCmp=new Map();
  for(const s of sourceInventory){
    const shardId=shardIdByPath.get(identity(s)),scope=scopeOf(s);
    for(const m of s.expectedSummaries){
      const key=JSON.stringify([scope,shardId,m.cmpId]);
      if(!byShardCmp.has(key))byShardCmp.set(key,{origin:'declared',scope,shard:s,shardId,cmpId:m.cmpId,session:m.session,srcSeqs:m.srcSeqs});
    }
  }
  for(const shard of derivedShards){
    const shardId=shardIdByPath.get(identity(shard)),scope=scopeOf(shard);
    for(const m of shard.summaries){
      const key=JSON.stringify([scope,shardId,m.cmpId]);
      byShardCmp.set(key,{origin:'parsed',scope,shard,shardId,cmpId:m.cmpId,session:m.session,srcSeqs:m.srcSeqs});
    }
  }
  const candidates=[...byShardCmp.values()];
  const missing=[],seen=new Set();let checked=0,resolvedPresent=0,resolvedDeclaredOnly=0;
  for(const c of candidates){
    for(const seq of c.srcSeqs){
      checked++;
      const k=scopedWordKey(c.scope,{session:c.session,seq});
      const inPresent=present.has(k),inDeclared=declared.has(k);
      // Fail closed: a ref is covered only when BOTH sides carry the word inside the summary's own
      // source identity. A one-sided ref is reported with the missing side, never resolved by a
      // sibling source.
      if(inPresent&&inDeclared){resolvedPresent++;continue;}
      if(inDeclared)resolvedDeclaredOnly++;
      const reason=inPresent?'not-declared':inDeclared?'not-parsed':'neither';
      const dedupe=JSON.stringify([c.scope,c.shardId,c.cmpId,c.session,seq,reason]);
      if(seen.has(dedupe))continue;
      seen.add(dedupe);
      missing.push({type:'summary-source-ref-missing',sourcePath:null,shardId:c.shardId,cmpId:c.cmpId,session:c.session,seq,origin:c.origin,reason,
        shardLabel:c.shard.path+' · '+c.shard.version+' · '+c.shard.namespace});
    }
  }
  missing.sort(refProblemSort);
  // sourcePath is null by schema: the flattened inventory carries no parent path, so the caller
  // attaches its own from the descriptor (see parseSyntheticEchoImporterShards).
  return {checked,resolvedPresent,resolvedDeclaredOnly,missing};
}

/**
 * Parse caller-supplied synthetic importer-shaped JSONL byte shards. Memory only.
 * input = { source:{sourcePath,version,namespace}, shards:[{shardId,path,bytes,summaryBytes?,expectedWords,expectedSummaries,expectedByteEnd?,expectedCursorSeq?}] }
 * Descriptors are the same objects tools/echo-source-temp-reader.mjs hands to the old parser.
 * Returns { parsedShards, sourceAudit:{sourceInventory,derivedSnapshot,sourceReadProblems,sourceReadCoverage},
 *           coverageAudit:{ok,problems}, summaryRefAudit:{checked,resolvedPresent,resolvedDeclaredOnly,missing},
 *           diagnostics:[...] } (diagnostics = per-shard parse problems + ref/source-wide duplicate problems,
 *           deterministically sorted). summaryRefAudit.resolvedPresent counts refs that are BOTH declared
 *           and parsed inside the summary's own source identity; resolvedDeclaredOnly counts
 *           declared-but-unparsed refs, which are also in missing.
 * Ref scope is the declared parent source identity (sourcePath,version,namespace), source-wide across
 * that identity's shards. This entry takes exactly one parent source, so cross-source isolation is
 * exercised directly through the exported auditSummaryRefs seam (see the selftest).
 */
export function parseSyntheticEchoImporterShards(input){
  if(!object(input)||!object(input.source)||!Array.isArray(input.shards))throw new TypeError('requires {source,shards}');
  const parent=input.source;
  if(!canonical(parent.sourcePath)||!str(parent.version)||!['log','v4log'].includes(parent.namespace))throw new TypeError('source requires canonical sourcePath/version/namespace');
  const seenIds=new Set(),seenCoverage=new Set(),inventoryShards=[],parsedShards=[],parserReceipts=[],sourceReadProblems=[],shardIdByPath=new Map(),
    parentIdentity=sourceIdentity(parent.sourcePath,parent.version,parent.namespace),parentByShard=new Map();
  for(let i=0;i<input.shards.length;i++){
    const sh=input.shards[i];
    if(!object(sh)||!str(sh.shardId)||!canonical(sh.path)||!(sh.bytes instanceof Uint8Array))throw new TypeError('shards['+i+'] requires shardId, canonical path and Uint8Array bytes');
    if(seenIds.has(sh.shardId))throw new TypeError('duplicate shardId within source');
    seenIds.add(sh.shardId);
    if(!Array.isArray(sh.expectedWords)||!Array.isArray(sh.expectedSummaries))throw new TypeError('each shard requires expectedWords and expectedSummaries arrays');
    sh.expectedWords.forEach((w,j)=>validateExpectedWord(w,'expectedWords['+j+']'));
    sh.expectedSummaries.forEach((s,j)=>validateExpectedSummary(s,'expectedSummaries['+j+']'));
    const covId=identity({path:sh.path,version:parent.version,namespace:parent.namespace});
    if(seenCoverage.has(covId))throw new TypeError('duplicate coverage shard identity');
    seenCoverage.add(covId);
    shardIdByPath.set(covId,sh.shardId);
    // Every descriptor of this call belongs to the one declared parent source; the identity is
    // carried per shard so ref resolution never falls back to a call-wide union.
    parentByShard.set(covId,parentIdentity);
    const inv={shardId:sh.shardId,path:sh.path,expectedByteEnd:sh.expectedByteEnd,expectedCursorSeq:sh.expectedCursorSeq,
      expectedWords:sh.expectedWords.map((w)=>({session:w.session,seq:w.seq})),
      expectedSummaries:sh.expectedSummaries.map((s)=>({cmpId:s.cmpId,session:s.session,srcSeqs:s.srcSeqs.slice()}))};
    inventoryShards.push(inv);
    const parsed=parseShard(parent,sh);
    if(inv.expectedSummaries.length&&sh.summaryBytes===undefined){
      const missing={type:'summary-bytes-not-provided',sourcePath:parent.sourcePath,shardId:sh.shardId,expectedSummaries:inv.expectedSummaries.length};
      parsed.diagnostics=[...(parsed.diagnostics||[]),missing];
      // Missing summary bytes are a coverage gap, never a licence to overwrite a failure.
      // The downgrade is one-directional (complete -> partial): a receipt that already failed
      // keeps its status, error, rows and boundary flags, and only gains the diagnostic, so a
      // shard that parsed nothing stays visibly failed instead of looking merely incomplete.
      if(parsed.receipt.status==='complete'){
        parsed.receipt.status='partial';
        parsed.receipt.completeFrameBoundary=false;
        parsed.receipt.summaries=[];
        parsed.receipt.summaryLineCount=0;
        parsed.receipt.summaryByteLength=0;
      }
    }
    parserReceipts.push(parsed.receipt);
    parsedShards.push({shardId:sh.shardId,path:sh.path,receipt:parsed.receipt,diagnostics:parsed.diagnostics,wordLines:parsed.wordLines,summaryLines:parsed.summaryLines});
    for(const problem of parsed.diagnostics)sourceReadProblems.push({...problem,sourcePath:parent.sourcePath});
  }
  // Source-wide uniqueness: the v9 schema is UNIQUE(source,session,seq) and PK(source,cmp_id).
  // A key repeated across shards of one source is a duplicate source row, not extra coverage.
  const wordShard=new Map(),summaryShard=new Map(),duplicateProblems=[];
  const shardLabelOf=(p)=>p.path+' · '+parent.version+' · '+parent.namespace;
  for(const p of parsedShards){
    if(p.receipt.status==='failed')continue; // a failed receipt carries no rows by contract
    for(const w of p.receipt.rows){
      const k=wordKey(w),prev=wordShard.get(k);
      if(prev&&prev.shardId!==p.shardId)duplicateProblems.push({type:'duplicate-source-word-key-across-shards',shardIds:[prev.shardId,p.shardId],shardLabel:shardLabelOf(prev),session:w.session,seq:w.seq});
      else if(!prev)wordShard.set(k,p);
    }
    for(const m of p.receipt.summaries){
      const prev=summaryShard.get(m.cmpId);
      if(prev&&prev.shardId!==p.shardId)duplicateProblems.push({type:'duplicate-summary-id-across-shards',shardIds:[prev.shardId,p.shardId],shardLabel:shardLabelOf(prev),cmpId:m.cmpId});
      else if(!prev)summaryShard.set(m.cmpId,p);
    }
  }
  // Contract rejections propagate: a half-shaped audit would silently look like a successful read.
  const sourceAudit=adaptEchoSourceReads({sourceInventory:[{sourcePath:parent.sourcePath,version:parent.version,namespace:parent.namespace,shards:inventoryShards}],parserReceipts});
  sourceAudit.sourceReadProblems=sourceReadProblems.concat(sourceAudit.sourceReadProblems||[]);
  const coverageAudit=auditEchoSourceCoverage({sourceInventory:sourceAudit.sourceInventory,derivedSnapshot:sourceAudit.derivedSnapshot});
  const refAudit=auditSummaryRefs(sourceAudit.sourceInventory,sourceAudit.derivedSnapshot.shards,shardIdByPath,parentByShard);
  for(const m of refAudit.missing){
    sourceAudit.sourceReadProblems.push({type:m.type,sourcePath:parent.sourcePath,shardId:m.shardId,cmpId:m.cmpId,session:m.session,seq:m.seq,origin:m.origin,reason:m.reason});
    coverageAudit.problems.push({type:m.type,shard:m.shardLabel,cmpId:m.cmpId,session:m.session,seq:m.seq,origin:m.origin,reason:m.reason});
  }
  for(const d of duplicateProblems){
    sourceAudit.sourceReadProblems.push({type:d.type,sourcePath:parent.sourcePath,shardId:d.shardIds[0],shardIds:d.shardIds,session:d.session,seq:d.seq,cmpId:d.cmpId});
    coverageAudit.problems.push({type:d.type,shard:d.shardLabel,shardIds:d.shardIds,session:d.session,seq:d.seq,cmpId:d.cmpId});
  }
  if(refAudit.missing.length||duplicateProblems.length){
    coverageAudit.problems.sort(coverageProblemSort);
    coverageAudit.ok=false;
    if(sourceAudit.sourceReadCoverage==='complete')sourceAudit.sourceReadCoverage='partial';
  }
  const diagnostics=[];
  for(const p of parsedShards)for(const d of p.diagnostics||[])diagnostics.push({...d,sourcePath:parent.sourcePath,shardId:p.shardId});
  for(const m of refAudit.missing)diagnostics.push({type:m.type,sourcePath:parent.sourcePath,shardId:m.shardId,cmpId:m.cmpId,session:m.session,seq:m.seq,origin:m.origin,reason:m.reason});
  for(const d of duplicateProblems)diagnostics.push({type:d.type,sourcePath:parent.sourcePath,shardIds:d.shardIds,session:d.session,seq:d.seq,cmpId:d.cmpId});
  diagnostics.sort(diagSort);
  return {parsedShards,sourceAudit,coverageAudit,summaryRefAudit:{checked:refAudit.checked,resolvedPresent:refAudit.resolvedPresent,resolvedDeclaredOnly:refAudit.resolvedDeclaredOnly,missing:refAudit.missing.length},diagnostics};
}
