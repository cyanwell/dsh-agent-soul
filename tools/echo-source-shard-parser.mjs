// In-memory parser only. Caller supplies bytes; this module never accesses filesystem APIs.
import { adaptEchoSourceReads } from './echo-source-reader-contract.mjs';
import { auditEchoSourceCoverage } from './echo-source-coverage.mjs';

const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const object=(x)=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const str=(x)=>typeof x==='string'&&x.trim().length>0;
const safe=(x)=>Number.isSafeInteger(x)&&x>=0;
const canonical=(p)=>typeof p==='string'&&p.length>0&&!p.includes('\\')&&(p.startsWith('/')||/^[A-Za-z]:\//.test(p))&&!p.endsWith('/')&&!p.includes('//')&&!p.split('/').some((s)=>s==='.'||s==='..');
const identity=(s)=>JSON.stringify([s.path,s.version,s.namespace]);
const key=(w)=>JSON.stringify([w.session,w.seq]);
function validateExpectedWord(w,where){if(!object(w)||!str(w.session)||!safe(w.seq))throw new TypeError(where+' requires session and seq >= 0');}
function validateExpectedSummary(s,where){if(!object(s)||!str(s.cmpId)||!str(s.session)||!Array.isArray(s.srcSeqs)||s.srcSeqs.some((x)=>!safe(x)))throw new TypeError(where+' requires cmpId/session/srcSeqs');}
function validateRow(row){
  if(!object(row))throw new Error('row must be object');
  const allow=new Set(['seq','t','session','ws','role','text']);
  for(const k of Object.keys(row))if(!allow.has(k))throw new Error('unsupported field '+k);
  if(!safe(row.seq))throw new Error('seq must be safe integer >=0');
  if(typeof row.t!=='string'||!row.t.trim()||!Number.isFinite(Date.parse(row.t)))throw new Error('t must be parseable timestamp');
  if(typeof row.session!=='string'||!/^[A-Za-z0-9._-]{1,128}$/.test(row.session))throw new Error('session must be ptr-safe');
  if(own(row,'ws')&&(typeof row.ws!=='string'||!row.ws.trim()))throw new Error('ws must be non-empty string');
  if(row.role!=='user'&&row.role!=='assistant')throw new Error('role must be user|assistant');
  if(typeof row.text!=='string'||!row.text.trim())throw new Error('text must be non-empty string');
}
const SUMMARY_FIELDS=new Set(['cmpId','t','session','ws','log','srcSeqs','shadowedTokens','shadowedChars','provider','model','status','summary']);
function validateSummaryRow(r){
  if(!object(r))throw new Error('summary must be object');
  for(const k of Object.keys(r))if(!SUMMARY_FIELDS.has(k))throw new Error('unsupported summary field '+k);
  for(const k of SUMMARY_FIELDS)if(!own(r,k))throw new Error('missing summary field '+k);
  if(typeof r.cmpId!=='string'||!/^[A-Za-z0-9._-]{1,128}$/.test(r.cmpId))throw new Error('cmpId must be idx-safe');
  if(typeof r.t!=='string'||!r.t.trim()||!Number.isFinite(Date.parse(r.t)))throw new Error('summary t must be parseable');
  if(typeof r.session!=='string'||!/^[A-Za-z0-9._-]{1,128}$/.test(r.session))throw new Error('summary session must be ptr-safe');
  for(const k of ['ws','log','provider','model'])if(r[k]!==null&&typeof r[k]!=='string')throw new Error(k+' must be string or null');
  if(!Array.isArray(r.srcSeqs)||r.srcSeqs.some((x)=>!safe(x)))throw new Error('srcSeqs must be ordered nonnegative safe integers');
  if(!safe(r.shadowedTokens)||!safe(r.shadowedChars))throw new Error('shadowed counts must be nonnegative safe integers');
  if(r.status!=='active'&&r.status!=='void')throw new Error('summary status must be active|void');
  if(typeof r.summary!=='string'||!r.summary.trim())throw new Error('summary text must be nonempty');
}
function parseSummaryBytes(parent,sh,raw){
  const failAll=(problem,error,consumedBytes=0)=>({status:'failed',summaries:[],malformedTail:false,problems:[{type:problem,shardId:sh.shardId,detail:error,sourcePath:parent.sourcePath,consumedBytes}]});
  if(!(raw instanceof Uint8Array))return failAll('invalid-summary-byte-buffer','summaryBytes must be Uint8Array');
  if(raw.length>=3&&raw[0]===0xef&&raw[1]===0xbb&&raw[2]===0xbf)return failAll('summary-utf8-bom','UTF-8 BOM is not allowed in summaries');
  try{new TextDecoder('utf-8',{fatal:true}).decode(raw);}catch{return failAll('summary-invalid-utf8','invalid UTF-8 in summaries');}
  const hasFinalLf=raw.length>0&&raw[raw.length-1]===0x0a;const summaries=[],seen=new Set(),problems=[];let start=0,consumedBytes=0,lineNo=0,failed=null;
  for(let i=0;i<raw.length;i++){if(raw[i]!==0x0a)continue;lineNo++;const bytes=raw.subarray(start,i);if(bytes.length===0){failed='blank summary line '+lineNo;problems.push({type:'blank-summary-line',shardId:sh.shardId,line:lineNo,sourcePath:parent.sourcePath});break;}let line,row;try{line=new TextDecoder('utf-8',{fatal:true}).decode(bytes);row=JSON.parse(line);validateSummaryRow(row);}catch(e){failed=(e&&e.message)||'invalid summary row';problems.push({type:'invalid-summary-row',shardId:sh.shardId,line:lineNo,detail:failed,sourcePath:parent.sourcePath});break;}if(seen.has(row.cmpId)){failed='duplicate summary cmpId '+row.cmpId;problems.push({type:'duplicate-summary-id',shardId:sh.shardId,cmpId:row.cmpId,line:lineNo,sourcePath:parent.sourcePath});break;}seen.add(row.cmpId);summaries.push({cmpId:row.cmpId,session:row.session,srcSeqs:row.srcSeqs.slice(),rawLine:line});consumedBytes=i+1;start=i+1;}
  if(!hasFinalLf){problems.push({type:'summary-missing-final-lf',shardId:sh.shardId,sourcePath:parent.sourcePath});return {status:failed?'failed':'partial',summaries,malformedTail:true,problems};}
  if(failed)return {status:'failed',summaries:[],malformedTail:false,problems};
  return {status:'complete',summaries,malformedTail:false,problems};
}
function failReceipt(parent,sh,error,consumedBytes,rows){return {sourcePath:parent.sourcePath,version:parent.version,namespace:parent.namespace,shardId:sh.shardId,status:'failed',consumedBytes,cursorSeq:rows.length?Math.max(...rows.map((r)=>r.seq)):0,completeFrameBoundary:false,malformedTail:false,rows:[],summaries:[],error};}
function parseShard(parent,sh){
  const raw=sh.bytes;let decoded;
  if(!(raw instanceof Uint8Array))return {receipt:failReceipt(parent,sh,'bytes must be Uint8Array',0,[]),problem:{type:'invalid-byte-buffer',shardId:sh.shardId}};
  if(raw.length>=3&&raw[0]===0xef&&raw[1]===0xbb&&raw[2]===0xbf)return {receipt:failReceipt(parent,sh,'UTF-8 BOM is not allowed',0,[]),problem:{type:'utf8-bom',shardId:sh.shardId}};
  try{decoded=new TextDecoder('utf-8',{fatal:true}).decode(raw);}catch(e){return {receipt:failReceipt(parent,sh,'invalid UTF-8',0,[]),problem:{type:'invalid-utf8',shardId:sh.shardId}};}
  const hasFinalLf=raw.length>0&&raw[raw.length-1]===0x0a;
  const rows=[],seen=new Set(),problems=[];let byteStart=0,consumedBytes=0,malformedTail=false,failedError=null;
  for(let i=0;i<raw.length;i++){
    if(raw[i]!==0x0a)continue;
    const physicalLine=raw.subarray(byteStart,i);const lineNo=rows.length+problems.length+1;
    if(physicalLine.length===0){malformedTail=true;failedError='blank physical line '+lineNo;problems.push({type:'blank-line',shardId:sh.shardId,line:lineNo});break;}
    let line;
    try{line=new TextDecoder('utf-8',{fatal:true}).decode(physicalLine);}catch(e){failedError='invalid UTF-8 on line '+lineNo;problems.push({type:'invalid-utf8',shardId:sh.shardId,line:lineNo});break;}
    let row;
    try{row=JSON.parse(line);}catch(e){malformedTail=true;failedError='malformed JSON on line '+lineNo;problems.push({type:'malformed-json',shardId:sh.shardId,line:lineNo});break;}
    try{validateRow(row);}catch(e){failedError=e.message+' on line '+lineNo;problems.push({type:'invalid-row',shardId:sh.shardId,line:lineNo,detail:e.message});break;}
    const k=key(row);if(seen.has(k)){failedError='duplicate source word key '+row.session+'#'+row.seq;problems.push({type:'duplicate-source-word-key',shardId:sh.shardId,session:row.session,seq:row.seq});break;}
    seen.add(k);rows.push({session:row.session,seq:row.seq});consumedBytes=i+1;byteStart=i+1;
  }
  if(!hasFinalLf){malformedTail=true;problems.push({type:'missing-final-lf',shardId:sh.shardId});}
  if(byteStart<raw.length&&hasFinalLf===false){/* remaining bytes are an incomplete physical record */}
  const cursorSeq=rows.length?Math.max(...rows.map((r)=>r.seq)):0;
  if(failedError){return {receipt:{...failReceipt(parent,sh,failedError,consumedBytes,rows),malformedTail},problem:problems[0]||{type:'invalid-shard',shardId:sh.shardId},diagnostics:problems};}
  const status=malformedTail?'partial':'complete';
  const receipt={sourcePath:parent.sourcePath,version:parent.version,namespace:parent.namespace,shardId:sh.shardId,status,consumedBytes,cursorSeq,completeFrameBoundary:!malformedTail,malformedTail,rows,summaries:[]};
  const summaryProblems=[];
  if(sh.summaryBytes!==undefined){
    const parsed=parseSummaryBytes(parent,sh,sh.summaryBytes);
    receipt.summaries=parsed.summaries;summaryProblems.push(...parsed.problems);
    if(parsed.status==='failed'){receipt.status='failed';receipt.completeFrameBoundary=false;receipt.malformedTail=parsed.malformedTail;}
    else if(parsed.status==='partial'&&receipt.status==='complete'){receipt.status='partial';receipt.completeFrameBoundary=false;receipt.malformedTail=true;}
  }
  return {receipt,diagnostics:problems.concat(summaryProblems)};
}
/**
 * Parse caller-supplied synthetic UTF-8 JSONL byte shards. The only indexed records are
 * explicitly declared word rows; summaries remain unparsed and therefore are not fabricated.
 * Summary declarations are preserved as expectations, so coverage reports absent summaries.
 */
export function parseSyntheticEchoShards(input){
  if(!object(input)||!object(input.source)||!Array.isArray(input.shards))throw new TypeError('requires {source,shards}');
  const parent=input.source;if(!canonical(parent.sourcePath)||!str(parent.version)||!['log','v4log'].includes(parent.namespace))throw new TypeError('source requires canonical sourcePath/version/namespace');
  const seenIds=new Set(),seenCoverage=new Set(),inventoryShards=[],parsedShards=[],parserReceipts=[],sourceReadProblems=[];
  for(let i=0;i<input.shards.length;i++){
    const sh=input.shards[i];if(!object(sh)||!str(sh.shardId)||!canonical(sh.path)||!(sh.bytes instanceof Uint8Array))throw new TypeError('shards['+i+'] requires shardId, canonical path and Uint8Array bytes');
    if(seenIds.has(sh.shardId))throw new TypeError('duplicate shardId within source');seenIds.add(sh.shardId);
    const inv={shardId:sh.shardId,path:sh.path,expectedByteEnd:sh.expectedByteEnd,expectedCursorSeq:sh.expectedCursorSeq,expectedWords:Array.isArray(sh.expectedWords)?sh.expectedWords.map((w)=>({session:w.session,seq:w.seq})):[],expectedSummaries:Array.isArray(sh.expectedSummaries)?sh.expectedSummaries.map((s)=>({cmpId:s.cmpId,session:s.session,srcSeqs:Array.isArray(s.srcSeqs)?s.srcSeqs.slice():[]})):[]};
    if(!Array.isArray(sh.expectedWords)||!Array.isArray(sh.expectedSummaries))throw new TypeError('each shard requires expectedWords and expectedSummaries arrays');
    sh.expectedWords.forEach((w,j)=>validateExpectedWord(w,'expectedWords['+j+']'));sh.expectedSummaries.forEach((s,j)=>validateExpectedSummary(s,'expectedSummaries['+j+']'));
    const covId=identity({path:sh.path,version:parent.version,namespace:parent.namespace});if(seenCoverage.has(covId))throw new TypeError('duplicate coverage shard identity');seenCoverage.add(covId);
    inventoryShards.push(inv);
    const parsed=parseShard(parent,sh);
    if(inv.expectedSummaries.length&&sh.summaryBytes===undefined){
      const missing={type:'summary-bytes-not-provided',sourcePath:parent.sourcePath,shardId:sh.shardId,expectedSummaries:inv.expectedSummaries.length};
      parsed.diagnostics=[...(parsed.diagnostics||[]),missing];
      // Downgrade only complete -> partial. A failed word shard keeps status, error and rows so the
      // reader contract still reports sourceReadCoverage 'unknown' with a failed-shard problem.
      if(parsed.receipt.status==='complete'){
        parsed.receipt.status='partial';
        parsed.receipt.completeFrameBoundary=false;
        parsed.receipt.summaries=[];
      }
    }
    parserReceipts.push(parsed.receipt);parsedShards.push({shardId:sh.shardId,path:sh.path,receipt:parsed.receipt,diagnostics:parsed.diagnostics||[parsed.problem]});
    for(const problem of parsed.diagnostics||[parsed.problem])sourceReadProblems.push({...problem,sourcePath:parent.sourcePath});
  }
  let sourceAudit;
  try{sourceAudit=adaptEchoSourceReads({sourceInventory:[{sourcePath:parent.sourcePath,version:parent.version,namespace:parent.namespace,shards:inventoryShards}],parserReceipts});}
  catch(e){sourceAudit={sourceInventory:[],derivedSnapshot:{shards:[]},sourceReadProblems:[{type:'adapter-contract-rejected',detail:String(e.message||e)}],sourceReadCoverage:'unknown'};}
  sourceAudit.sourceReadProblems=sourceReadProblems.concat(sourceAudit.sourceReadProblems||[]);
  if(sourceReadProblems.length&&sourceAudit.sourceReadCoverage==='complete')sourceAudit.sourceReadCoverage='partial';
  const coverageAudit=auditEchoSourceCoverage({sourceInventory:sourceAudit.sourceInventory,derivedSnapshot:sourceAudit.derivedSnapshot});
  return {parsedShards,sourceAudit,coverageAudit};
}
