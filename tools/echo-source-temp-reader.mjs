// TEMP-only filesystem bridge for synthetic ECHO shard fixtures.
// Explicit paths only; every read is realpath-contained beneath caller's TEMP root.
// format:'importer' reads declared word+summary files and hands the bytes to the
// importer-shaped parser. Omitting format (or 'legacy') keeps the legacy 6-field row
// parser. There is no schema auto-detection: a wrong format fails, it never falls back.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseSyntheticEchoShards } from './echo-source-shard-parser.mjs';
import { parseSyntheticEchoImporterShards } from './echo-source-shard-importer-adapter.mjs';
const isObj=(x)=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const str=(x)=>typeof x==='string'&&x.length>0;
const inside=(root,candidate)=>candidate===root||candidate.startsWith(root+path.sep);
const READER_FORMATS=Object.freeze(['legacy','importer']);
function assertRelativeChild(child,label){
 if(!str(child)||path.isAbsolute(child)||path.win32.isAbsolute(child))throw new TypeError(label+' must be an explicit relative path');
 const parts=child.split(/[\/]+/);if(parts.some((p)=>p==='..'||p==='.'||p===''))throw new TypeError(label+' must not contain traversal or empty path segments');
}
function resolveContained(rootReal,child,label){
 assertRelativeChild(child,label);const candidate=path.resolve(rootReal,child);
 if(!inside(rootReal,candidate))throw new Error(label+' escapes TEMP root');
 const real=fs.realpathSync(candidate);
 if(!inside(rootReal,real))throw new Error(label+' resolves outside TEMP root');
 const st=fs.statSync(real);if(!st.isFile())throw new Error(label+' is not a regular file');return real;
}
export function readSyntheticEchoRoot(options){
 const o=options||{};
 if(!isObj(o)||typeof o.root!=='string'||!path.isAbsolute(o.root)||(process.platform==='win32'&&!(/^[A-Za-z]:[\\/]/.test(o.root)||/^\\\\[^\\/]+[\\/][^\\/]+/.test(o.root))))throw new TypeError('root must be an explicit absolute path for this platform');
 if(!isObj(o.source)||!Array.isArray(o.shards))throw new TypeError('source and explicit shard descriptors are required');
 const format=o.format===undefined?'legacy':o.format;
 if(!str(format)||!READER_FORMATS.includes(format))throw new TypeError("format must be 'legacy' or 'importer'");
 const rootReal=fs.realpathSync(o.root);const tempReal=fs.realpathSync(os.tmpdir());
 if(!inside(tempReal,rootReal))throw new Error('root must resolve beneath os.tmpdir()');
 const descriptors=[];const ids=new Set(),resolvedPaths=new Set();
 for(let i=0;i<o.shards.length;i++){
  const d=o.shards[i];if(!isObj(d)||typeof d.shardId!=='string'||!d.shardId||typeof d.wordPath!=='string')throw new TypeError('shards['+i+'] requires shardId and wordPath');
  if(ids.has(d.shardId))throw new Error('duplicate shardId');ids.add(d.shardId);
  const wordFile=resolveContained(rootReal,d.wordPath,'wordPath');if(resolvedPaths.has(wordFile))throw new Error('duplicate resolved shard path');resolvedPaths.add(wordFile);
  let summaryBytes;
  if(d.summaryPath!==undefined){if(typeof d.summaryPath!=='string')throw new TypeError('summaryPath must be relative string');const summaryFile=resolveContained(rootReal,d.summaryPath,'summaryPath');if(resolvedPaths.has(summaryFile))throw new Error('duplicate resolved shard path');resolvedPaths.add(summaryFile);summaryBytes=fs.readFileSync(summaryFile);}
  const bytes=fs.readFileSync(wordFile);
  descriptors.push({shardId:d.shardId,path:wordFile.replace(/\\/g,'/'),bytes,summaryBytes,expectedWords:d.expectedWords,expectedSummaries:d.expectedSummaries,expectedByteEnd:d.expectedByteEnd,expectedCursorSeq:d.expectedCursorSeq});
 }
 const parse=format==='importer'?parseSyntheticEchoImporterShards:parseSyntheticEchoShards;
 const parsed=parse({source:o.source,shards:descriptors});
 return { ...parsed, coverageAudit: parsed.coverageAudit, readerProblems: parsed.sourceAudit.sourceReadProblems };
}
