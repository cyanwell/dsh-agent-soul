#!/usr/bin/env node
// Explicit ECHO source builder.
//
// 两种模式，互不冒充：
//   ① synthetic（默认，行为一字不改）：显式 user/assistant JSONL → words.jsonl + summaries.jsonl + manifest.json
//   ② source（--db）：显式指定的 v4 SQLite 源库 → 同一套 importer 形状的产物
//
// ── source 模式的源库契约（只读；绝不迁移、绝不写源库）──────────────────────
//   · dbPath 必须显式、绝对、**落在 os.tmpdir() 之下**（本阶段只接受临时库；
//     生产库连"顺手读一下"都不允许 —— 这条由代码挡，不靠自律）。
//   · 必填表/列（缺一即拒；列用 PRAGMA table_info 实读，不猜）：
//       schema_migrations(version)
//       sources(source_id, kind, namespace, authority, raw_path)
//       sessions(source_id, session_id)
//       frame_index(source_id, session_id, seq, raw_path, snippet, snippet_truncated, type, event_at)
//   · schema 版本 4 ≤ MAX(version) ≤ 本仓 SCHEMA_VERSION；越界=不支持（不迁移、不降级）。
//   · 只取 **指定的那一条 sourceId**；帧按 (session_id, seq) 稳定序。
//     log = frame_index.raw_path 原文。
//   · 只有 type=user|assistant 且 snippet_truncated=0 进 words；snippet 是有上限的索引预览，
//     不是可证明完整的原始 payload。
//   · frame_index 没有原始 summary payload / srcSeqs 字段；source 模式不解析 summary frame，
//     summaries.jsonl 固定为空（单 LF），manifest 标 source=none / capability=unavailable。
//   · 源库在构建期间必须稳定（size+mtime 前后一致），只读打开、finally 关闭。
//
// feed 模式（buildFromEchoIndexFiles）从显式选定的 files/words/summaries JSONL 映射；
// 它保留原声明 srcSeqs（顺序/重复均不改），计算已解析/悬空计数并拒绝悬空代；cmpId 冲突拒绝。
// 此 feed 契约不适用于 SQLite snippet source 模式。
//
// 第三种模式（tail，2026-11-15）：只读追加读取**会话日志本身**（权威、只追加）→ ECHO 三件套。
//   ★ 这不是「迁移 / 搬家」：原始日志原地不动，ECHO 只增量派生自己的索引。
//   见文件末尾「tail 模式」一节。
//
// 三种模式共用：校验 / 哈希 / 清单 / 不覆盖 / 三件套回滚。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isCanonicalSourcePath, wordContentHash, charLen, isReasoningRow, ECHO_WORD_FIELDS, ECHO_SUMMARY_FIELDS, ECHO_SUMMARY_STATUSES, ECHO_INDEX_VERSION_RE } from './echo-index-import.mjs';
import zlib from 'node:zlib';
import { openDatabase, configureConnection } from '../src/db/engine.mjs';
import { SCHEMA_VERSION, echoSourceIdFor } from '../src/db/schema.mjs';

const fail = (message) => { throw new Error(message); };
const required = ['--input','--out-dir','--source-path','--namespace','--generation','--built-at','--cursor-seq'];
// source 模式（--db）用自己的必填集合：--input/--summaries 不许混入，--cursor-seq 可选（不给就由源库推导）。
const sourceRequired = ['--db','--source-id','--out-dir','--source-path','--namespace','--generation','--built-at'];
export function parseArgs(argv) {
  const out = {};
  const allowed = new Set([...required, '--summaries', '--db', '--source-id']);
  for (let i=0;i<argv.length;i++) {
    const flag=String(argv[i]);
    if (!allowed.has(flag)) fail('unknown argument: '+flag);
    if (out[flag] !== undefined) fail('duplicate argument: '+flag);
    const value=argv[i+1];
    if (value===undefined || String(value).startsWith('--')) fail('missing value for '+flag);
    out[flag]=String(value); i++;
  }
  if (out['--db'] !== undefined) {
    if (out['--input'] !== undefined) fail('--input is not allowed with --db (source mode reads the v4 SQLite database)');
    if (out['--summaries'] !== undefined) fail('--summaries is not allowed with --db (summaries come from explicit v4 summary frames)');
    for (const flag of sourceRequired) if (!out[flag]) fail('required argument missing: '+flag);
    return out;
  }
  if (out['--source-id'] !== undefined) fail('--source-id requires --db');
  for(const flag of required) if(!out[flag]) fail('required argument missing: '+flag);
  return out;
}
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const sourcePathOk = isCanonicalSourcePath;
const CMP_RE = /^[A-Za-z0-9._-]{1,128}$/;
const SESSION_RE = /^[A-Za-z0-9._-]{1,128}$/;
const SUMMARY_FIELDS = ECHO_SUMMARY_FIELDS;
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

// true when child === parent or lives under it (path.relative is case-insensitive on win32).
function isSameOrWithin(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

// 源库身份判据与 manifest.sourcePath 同一套：绝对、posix、无 '.'/'..' 段。
const toPosix = (p) => String(p).replace(/\\/g, '/');

// Strict validation of an optional ECHO summary JSONL: caller supplies the exact bytes,
// they are kept verbatim (the importer hashes/echoes the raw line), only fields are judged.
function parseSummariesBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) fail('summaries must be a non-empty UTF-8 JSONL file');
  if (bytes.length >= 3 && bytes[0] === BOM[0] && bytes[1] === BOM[1] && bytes[2] === BOM[2]) fail('summaries must not start with a UTF-8 BOM');
  if (bytes[bytes.length - 1] !== 10) fail('summaries must end with LF (a missing terminator is the signature of a truncated write)');
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) fail('summaries are not valid UTF-8');
  const lines = text.split('\n'); lines.pop();
  const seen = new Set(); let rows = 0, srcSeqs = 0;
  for (let i=0;i<lines.length;i++) {
    const line = lines[i]; const where = 'summaries line ' + (i + 1);
    if (!line.trim()) fail(where + ' must be a non-blank JSONL row');
    let x; try { x = JSON.parse(line); } catch (e) { fail(where + ' invalid JSON: ' + e.message); }
    if (!x || typeof x !== 'object' || Array.isArray(x)) fail(where + ' must be a JSON object');
    for (const k of Object.keys(x)) if (!SUMMARY_FIELDS.includes(k)) fail(where + ' unsupported field ' + k);
    for (const k of SUMMARY_FIELDS) if (!Object.prototype.hasOwnProperty.call(x, k)) fail(where + ' missing field ' + k);
    if (typeof x.cmpId !== 'string' || !CMP_RE.test(x.cmpId)) fail(where + ' cmpId must be idx-safe');
    if (seen.has(x.cmpId)) fail(where + ' duplicate cmpId ' + x.cmpId); seen.add(x.cmpId);
    if (typeof x.t !== 'string' || !x.t || !Number.isFinite(Date.parse(x.t))) fail(where + ' t must be a parseable timestamp');
    if (typeof x.session !== 'string' || !SESSION_RE.test(x.session)) fail(where + ' session must be ptr-safe');
    for (const k of ['ws','log','provider','model']) if (x[k] !== null && typeof x[k] !== 'string') fail(where + ' ' + k + ' must be a string or null');
    if (!Array.isArray(x.srcSeqs) || x.srcSeqs.some(n => !Number.isSafeInteger(n) || n < 0)) fail(where + ' srcSeqs must be non-negative safe integers');
    for (const k of ['shadowedTokens','shadowedChars']) if (!Number.isSafeInteger(x[k]) || x[k] < 0) fail(where + ' ' + k + ' must be a non-negative safe integer');
    if (typeof x.status !== 'string' || !ECHO_SUMMARY_STATUSES.includes(x.status)) fail(where + ' status must be ' + ECHO_SUMMARY_STATUSES.join('|'));
    if (typeof x.summary !== 'string' || x.summary.length === 0) fail(where + ' summary must be a non-empty string');
    rows++; srcSeqs += x.srcSeqs.length;
  }
  if (rows === 0) fail('summaries has no data rows');
  return { bytes, rows, srcSeqs };
}

// 输出三件套：不覆盖 + 写失败整组回滚（synthetic 与 source 共用同一份实现）。
function writeOutputTriplet(outDir, wordsBytes, summariesBytes, manifestBytes) {
  fs.mkdirSync(outDir,{recursive:true});
  const wordsPath=path.join(outDir,'words.jsonl');
  const summariesPath=path.join(outDir,'summaries.jsonl');
  const manifestPath=path.join(outDir,'manifest.json');
  for (const file of [wordsPath,summariesPath,manifestPath]) {
    if (fs.existsSync(file)) fail('refusing to overwrite existing output: '+file);
  }
  const written=[];
  try {
    fs.writeFileSync(wordsPath,wordsBytes,{flag:'wx'}); written.push(wordsPath);
    fs.writeFileSync(summariesPath,summariesBytes,{flag:'wx'}); written.push(summariesPath);
    fs.writeFileSync(manifestPath,manifestBytes,{flag:'wx'}); written.push(manifestPath);
  } catch (err) {
    for (const file of written.reverse()) { try { fs.unlinkSync(file); } catch {} }
    throw err;
  }
  return {wordsPath,summariesPath,manifestPath};
}

function parseInput(inputPath) {
  const bytes=fs.readFileSync(inputPath);
  if(bytes.length===0) fail('input JSONL is empty');
  if(bytes[bytes.length-1]!==0x0a) fail('input JSONL must end with LF');
  const text=bytes.toString('utf8');
  if(Buffer.from(text,'utf8').compare(bytes)!==0) fail('input JSONL is not valid UTF-8');
  const rows=[]; const seen=new Set(); const lines=text.split('\n'); lines.pop();
  for(let i=0;i<lines.length;i++) {
    const raw=lines[i]; if(!raw.trim()) continue;
    let row; try{row=JSON.parse(raw);}catch(e){fail('line '+(i+1)+': invalid JSON: '+e.message);}
    if(!row||typeof row!=='object'||Array.isArray(row)) fail('line '+(i+1)+': row must be object');
    const allowed=new Set(['seq','t','session','ws','role','text']);
    for(const k of Object.keys(row)) if(!allowed.has(k)) fail('line '+(i+1)+': unsupported field '+k);
    if(!Number.isSafeInteger(row.seq)||row.seq<0) fail('line '+(i+1)+': seq must be safe integer >=0');
    if(typeof row.t!=='string'||!row.t.trim()||!Number.isFinite(Date.parse(row.t))) fail('line '+(i+1)+': t must be parseable timestamp');
    if(typeof row.session!=='string'||! /^[A-Za-z0-9._-]{1,128}$/.test(row.session)) fail('line '+(i+1)+': session must be ptr-safe');
    if(row.ws!==undefined && (typeof row.ws!=='string'||!row.ws.trim())) fail('line '+(i+1)+': ws must be non-empty string');
    if(row.role!=='user'&&row.role!=='assistant') fail('line '+(i+1)+': role must be user|assistant');
    if(typeof row.text!=='string'||!row.text.trim()) fail('line '+(i+1)+': text must be non-empty string');
    if(seen.has(row.seq)) fail('line '+(i+1)+': duplicate seq '+row.seq); seen.add(row.seq);
    rows.push({...row,src_line:i+1});
  }
  if(rows.length===0) fail('input has no data rows');
  return {rows,bytes};
}

export function buildSource(options) {
  const o=options||{};
  for(const k of ['input','outDir','sourcePath','namespace','generation','builtAt','cursorSeq']) if(o[k]===undefined||o[k]===null||o[k]==='') fail('missing explicit option '+k);
  if(!sourcePathOk(o.sourcePath)) fail('sourcePath must be canonical absolute posix path without dot segments');
  if(!['log','v4log'].includes(o.namespace)) fail('namespace must be log|v4log');
  if(!Number.isSafeInteger(o.generation)||o.generation<1) fail('generation must be safe integer >=1');
  if(typeof o.builtAt!=='string'||!Number.isFinite(Date.parse(o.builtAt))) fail('builtAt must be parseable timestamp');
  if(!Number.isSafeInteger(o.cursorSeq)||o.cursorSeq<0) fail('cursorSeq must be safe integer >=0');
  const input=path.resolve(o.input), outDir=path.resolve(o.outDir);
  // The optional summaries input must never be the output triplet itself (or live among it):
  // a build that reads a file it is about to create would either overwrite its own input or
  // hash bytes from a previous run. Reject before mkdir/writes, not after.
  let summariesInput=null;
  if(o.summariesPath!==undefined && o.summariesPath!==null) {
    if(typeof o.summariesPath!=='string'||o.summariesPath==='') fail('summariesPath must be a non-empty path when provided');
    summariesInput=path.resolve(o.summariesPath);
    if(isSameOrWithin(outDir,summariesInput)) fail('summaries input must not be equal to or inside the output directory: '+summariesInput);
  }
  const parsed=parseInput(input);
  const parsedSummaries=summariesInput===null?null:parseSummariesBytes(fs.readFileSync(summariesInput));
  const maxSeq=Math.max(...parsed.rows.map(r=>r.seq));
  if(o.cursorSeq<maxSeq) fail('cursorSeq must be >= max input seq');
  const wordsRows=parsed.rows.map(r=>{
    const row={t:new Date(Date.parse(r.t)).toISOString(),session:r.session,ws:r.ws??null,seq:r.seq,turn:null,log:null,role:r.role,kind:r.role==='assistant'?'结论':'原话',len:charLen(r.text),truncated:false,text:r.text};
    wordContentHash(row); // Validate canonical hash input order; importer recomputes and stores the digest.
    return row;
  });
  const wordsBytes=Buffer.from(wordsRows.map(x=>JSON.stringify(x)).join('\n')+'\n','utf8');
  // No summariesPath: importer requires non-empty, strict UTF-8, final LF — one blank row is canonical.
  // With summariesPath: the caller's bytes are written untouched and hashed as-is.
  const summariesBytes=parsedSummaries===null?Buffer.from('\n','utf8'):parsedSummaries.bytes;
  const summariesRows=parsedSummaries===null?0:parsedSummaries.rows;
  const summarySrcSeqs=parsedSummaries===null?0:parsedSummaries.srcSeqs;
  const inputHash=sha256(parsed.bytes);
  const inputStem=path.basename(input);
  const manifest={
    echoIndexVersion:'echo-index/1',sourcePath:o.sourcePath,version:'synthetic-source/1',namespace:o.namespace,
    generation:o.generation,builtAt:new Date(Date.parse(o.builtAt)).toISOString(),
    cursor:{seq:o.cursorSeq,inputSha256:inputHash,inputBytes:parsed.bytes.length},
    words:{path:'words.jsonl',sha256:sha256(wordsBytes),bytes:wordsBytes.length,rows:wordsRows.length},
    summaries:{path:'summaries.jsonl',sha256:sha256(summariesBytes),bytes:summariesBytes.length,rows:summariesRows},
    counts:{words:wordsRows.length,summaries:summariesRows,srcSeqs:summarySrcSeqs,excludedReasoning:0},
    sourceInput:{name:inputStem,sha256:inputHash,bytes:parsed.bytes.length,rows:parsed.rows.length},
  };
  const manifestBytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n','utf8');
  const {wordsPath,summariesPath,manifestPath}=writeOutputTriplet(outDir,wordsBytes,summariesBytes,manifestBytes);
  return {manifestPath,manifestSha256:sha256(manifestBytes),manifest,wordsPath,summariesPath};
}

// ════════════════════════════════════════════════════════════════════════════
// source 模式：显式 v4 SQLite 源库 → ECHO importer 形状
// ════════════════════════════════════════════════════════════════════════════

export const V4_SOURCE_VERSION = 'v4-source/1';
export const V4_SOURCE_TABLES = Object.freeze(['schema_migrations','sources','sessions','frame_index']);
export const V4_SOURCE_COLUMNS = Object.freeze({
  schema_migrations: ['version'],
  sources: ['source_id','kind','namespace','authority','raw_path'],
  sessions: ['source_id','session_id'],
  frame_index: ['source_id','session_id','seq','raw_path','snippet','snippet_truncated','type','event_at'],
});
export const V4_MIN_SCHEMA_VERSION = 4;
export const V4_WORD_TYPES = Object.freeze(['user','assistant']);
export const V4_SUMMARY_TYPE = 'summary';

// 顺序读文件算 SHA-256（不把整库读进内存）。
function hashFileSync(file, chunkSize) {
  const fd = fs.openSync(file, 'r');
  const hash = createHash('sha256');
  const buf = Buffer.allocUnsafe(chunkSize || 1048576);
  let bytes = 0;
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      hash.update(buf.subarray(0, n));
      bytes += n;
    }
  } finally { fs.closeSync(fd); }
  return { sha256: hash.digest('hex'), bytes };
}

// 表/列/schema 版本：全部实读，缺一即拒。
function inspectV4Source(db) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
  const missingTables = V4_SOURCE_TABLES.filter((t) => !tables.has(t));
  if (missingTables.length > 0) fail('source database is missing required table(s): ' + missingTables.join(', '));
  for (const table of V4_SOURCE_TABLES) {
    const columns = new Set(db.prepare('PRAGMA table_info(' + table + ')').all().map((r) => r.name));
    const missing = V4_SOURCE_COLUMNS[table].filter((c) => !columns.has(c));
    if (missing.length > 0) fail('source table ' + table + ' is missing required column(s): ' + missing.join(', '));
  }
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get();
  const version = row === undefined || row.v === null || row.v === undefined ? null : Number(row.v);
  if (!Number.isSafeInteger(version)) fail('source database has no readable schema version (schema_migrations is empty)');
  if (version < V4_MIN_SCHEMA_VERSION) fail('unsupported source schema v' + version + ': a v4 frame/session/source schema (v>=' + V4_MIN_SCHEMA_VERSION + ') is required');
  if (version > SCHEMA_VERSION) fail('unsupported source schema v' + version + ': this builder reads at most v' + SCHEMA_VERSION + ' (it never migrates)');
  return { schemaVersion: version, columns: V4_SOURCE_COLUMNS };
}

function readSourceRow(db, sourceId) {
  const rows = db.prepare('SELECT source_id, kind, namespace, authority, raw_path FROM sources WHERE source_id = ?').all(sourceId);
  if (rows.length === 0) fail('no v4 source row for sourceId ' + JSON.stringify(sourceId));
  if (rows.length > 1) fail('ambiguous v4 source rows for sourceId ' + JSON.stringify(sourceId));
  const row = rows[0];
  if (row.kind !== 'v4-mirror') fail('source ' + sourceId + ' has kind ' + JSON.stringify(row.kind) + '; a v4 frame source must be kind v4-mirror');
  if (row.authority !== 'mirror') fail('source ' + sourceId + ' has authority ' + JSON.stringify(row.authority) + '; a v4 frame source must be authority mirror');
  if (typeof row.raw_path !== 'string' || row.raw_path.length === 0) fail('source ' + sourceId + ' has no raw_path');
  return { sourceId: row.source_id, kind: row.kind, namespace: row.namespace, authority: row.authority, rawPath: row.raw_path };
}

function readFrames(db, sourceId) {
  // 稳定序：同一 source 内按 (session_id, seq) —— 不依赖 rowid / 插入顺序。
  return db.prepare([
    'SELECT session_id, seq, raw_path, snippet, snippet_truncated, type, event_at',
    'FROM frame_index WHERE source_id = ? ORDER BY session_id, seq',
  ].join(' ')).all(sourceId);
}

// 一帧 → (排除 | word row | summary 原文)。
function classifyFrame(raw, where) {
  const seq = Number(raw.seq);
  if (!Number.isSafeInteger(seq) || seq < 0) fail(where + ': seq must be a non-negative safe integer');
  if (typeof raw.session_id !== 'string' || !SESSION_RE.test(raw.session_id)) fail(where + ': session_id ' + JSON.stringify(raw.session_id) + ' is not ptr-safe ([A-Za-z0-9._-]{1,128})');
  if (raw.type === null || raw.type === undefined || raw.type === '') fail(where + ': frame type is missing and cannot be classified');
  if (typeof raw.type !== 'string') fail(where + ': frame type must be a string');
  const type = raw.type;
  if (type === V4_SUMMARY_TYPE) return { kindOf: 'summary', type, seq, sessionId: raw.session_id };
  if (!V4_WORD_TYPES.includes(type)) return { kindOf: 'excluded', type, seq, sessionId: raw.session_id };
  if (typeof raw.snippet !== 'string' || raw.snippet.length === 0) fail(where + ': eligible ' + type + ' frame has no text');
  if (!raw.snippet.trim()) fail(where + ': eligible ' + type + ' frame has blank text');
  const truncatedFlag = raw.snippet_truncated === true || raw.snippet_truncated === 1 ? 1 : raw.snippet_truncated === false || raw.snippet_truncated === 0 ? 0 : null;
  if (truncatedFlag === null) fail(where + ': snippet_truncated must be boolean or 0/1');
  if (typeof raw.event_at !== 'string' || !raw.event_at || !Number.isFinite(Date.parse(raw.event_at))) fail(where + ': event_at must be a parseable timestamp');
  if (raw.raw_path !== null && typeof raw.raw_path !== 'string') fail(where + ': raw_path must be a string or null');
  return { kindOf: 'word', type, seq, sessionId: raw.session_id, truncated: truncatedFlag, raw };
}

function validateSummaryPayload(obj, where) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) fail(where + ': summary frame must hold a JSON object');
  for (const k of Object.keys(obj)) if (!SUMMARY_FIELDS.includes(k)) fail(where + ': unsupported summary field ' + k);
  for (const k of SUMMARY_FIELDS) if (!Object.prototype.hasOwnProperty.call(obj, k)) fail(where + ': missing summary field ' + k);
  if (typeof obj.cmpId !== 'string' || !CMP_RE.test(obj.cmpId)) fail(where + ': cmpId must be idx-safe ([A-Za-z0-9._-]{1,128})');
  if (typeof obj.t !== 'string' || !obj.t || !Number.isFinite(Date.parse(obj.t))) fail(where + ': t must be a parseable timestamp');
  if (typeof obj.session !== 'string' || !SESSION_RE.test(obj.session)) fail(where + ': session must be ptr-safe');
  for (const k of ['ws','log','provider','model']) if (obj[k] !== null && typeof obj[k] !== 'string') fail(where + ': ' + k + ' must be a string or null');
  if (!Array.isArray(obj.srcSeqs) || obj.srcSeqs.some((n) => !Number.isSafeInteger(n) || n < 0)) fail(where + ': srcSeqs must be non-negative safe integers');
  for (const k of ['shadowedTokens','shadowedChars']) if (!Number.isSafeInteger(obj[k]) || obj[k] < 0) fail(where + ': ' + k + ' must be a non-negative safe integer');
  if (typeof obj.status !== 'string' || !ECHO_SUMMARY_STATUSES.includes(obj.status)) fail(where + ': status must be ' + ECHO_SUMMARY_STATUSES.join('|'));
  if (typeof obj.summary !== 'string' || obj.summary.length === 0) fail(where + ': summary must be a non-empty string');
  return obj;
}

export function buildFromMetaSqlite(options) {
  const o = options || {};
  for (const k of ['dbPath','sourceId','sourcePath','namespace','generation','builtAt','outDir']) {
    if (o[k] === undefined || o[k] === null || o[k] === '') fail('missing explicit option ' + k);
  }
  if (typeof o.dbPath !== 'string' || !path.isAbsolute(o.dbPath)) fail('dbPath must be an absolute path');
  if (o.dbPath === ':memory:' || o.dbPath.startsWith('file:')) fail('dbPath must be a real file (source databases are never opened as memory/URI)');
  if (!sourcePathOk(o.sourcePath)) fail('sourcePath must be canonical absolute posix path without dot segments');
  if (!['log','v4log'].includes(o.namespace)) fail('namespace must be log|v4log');
  if (!Number.isSafeInteger(o.generation) || o.generation < 1) fail('generation must be safe integer >=1');
  if (typeof o.builtAt !== 'string' || !Number.isFinite(Date.parse(o.builtAt))) fail('builtAt must be parseable timestamp');
  if (typeof o.sourceId !== 'string' || o.sourceId.length === 0) fail('sourceId must be a non-empty string');
  if (o.cursorSeq !== undefined && o.cursorSeq !== null && (!Number.isSafeInteger(o.cursorSeq) || o.cursorSeq < 0)) fail('cursorSeq must be safe integer >=0');

  const dbPath = path.resolve(o.dbPath);
  const outDir = path.resolve(o.outDir);
  if (!fs.existsSync(dbPath)) fail('source database does not exist: ' + dbPath);
  if (!fs.statSync(dbPath).isFile()) fail('source database must be a regular file: ' + dbPath);
  const realDb = fs.realpathSync(dbPath);
  // 本阶段唯一允许的源库位置：OS 临时目录之内。生产库在这里就被挡住，读都读不到。
  const realTemp = fs.existsSync(os.tmpdir()) ? fs.realpathSync(os.tmpdir()) : path.resolve(os.tmpdir());
  if (!isSameOrWithin(realTemp, realDb)) fail('source database must live under the OS temporary directory for this stage: ' + realDb);
  // 输出不许包住源库（否则三件套会写进源库目录）。
  if (isSameOrWithin(outDir, realDb)) fail('source database must not be equal to or inside the output directory: ' + realDb);
  // 来源身份不许与输出/源库撞车，也不许用临时目录当身份（临时身份不可追溯）。
  // 具体冲突先判，再判"临时身份"：两者同时成立时，报出真正的那一个。
  if (toPosix(path.resolve(o.sourcePath)) === toPosix(outDir)) fail('sourcePath collides with the output directory: ' + o.sourcePath);
  if (toPosix(path.resolve(o.sourcePath)) === toPosix(realDb)) fail('sourcePath collides with the source database path: ' + o.sourcePath);
  if (isSameOrWithin(realTemp, path.resolve(toPosix(o.sourcePath)))) fail('sourcePath must not be a temporary identity: ' + o.sourcePath);

  // 源库指纹（构建前后必须一致；只读打开，绝不写）。
  const before = fs.statSync(realDb);
  const digest = hashFileSync(realDb);

  const db = openDatabase(realDb, { readOnly: true });
  let scanned = [];
  let sourceRow = null;
  let schema = null;
  let wordsRows = [];
  const excludedByType = Object.create(null);
  const seenSeq = new Set();
  try {
    configureConnection(db, { readOnly: true });
    schema = inspectV4Source(db);
    sourceRow = readSourceRow(db, o.sourceId);
    if (sourceRow.namespace !== o.namespace) {
      fail('source ' + o.sourceId + ' declares namespace ' + JSON.stringify(sourceRow.namespace) + ' but --namespace says ' + JSON.stringify(o.namespace) + ' (namespaces are never invented)');
    }
    scanned = readFrames(db, o.sourceId);
    if (scanned.length === 0) fail('source ' + o.sourceId + ' has no frames');
    for (let i = 0; i < scanned.length; i += 1) {
      const raw = scanned[i];
      const where = 'frame ' + (i + 1) + ' (session ' + raw.session_id + ' #' + raw.seq + ')';
      const cls = classifyFrame(raw, where);
      const key = cls.sessionId + '\u0000' + String(cls.seq);
      if (seenSeq.has(key)) fail(where + ': duplicate (session, seq) in the source');
      seenSeq.add(key);
      if (cls.kindOf === 'excluded') { excludedByType[cls.type] = (excludedByType[cls.type] || 0) + 1; continue; }
      if (cls.kindOf === 'summary') {
        // frame_index is an index snippet, never an authoritative summary/sourceSeq payload.
        excludedByType[cls.type] = (excludedByType[cls.type] || 0) + 1;
        continue;
      }
      if (cls.truncated === 1) {
        const key = cls.type + ':truncated';
        excludedByType[key] = (excludedByType[key] || 0) + 1;
        continue;
      }
      const row = {
        t: new Date(Date.parse(raw.event_at)).toISOString(),
        session: cls.sessionId,
        ws: null,
        seq: cls.seq,
        turn: null,
        log: raw.raw_path === null ? null : String(raw.raw_path),
        role: cls.type,
        kind: cls.type,
        len: charLen(raw.snippet),
        truncated: cls.truncated === 1,
        text: raw.snippet,
      };
      wordContentHash(row); // 同一份 canonical hash 输入序（importer 会重算并入库）。
      wordsRows.push(row);
    }
    if (wordsRows.length === 0) fail('source ' + o.sourceId + ' has no eligible non-truncated user/assistant frames');
  } finally {
    try { db.close(); } catch { /* 关闭失败不掩盖原错误 */ }
  }

  // 构建期间源库必须没变（只读连接也不会写；变了说明有并发写者，结论不可信）。
  const after = fs.statSync(realDb);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) fail('source database changed during the build; refusing an inconsistent snapshot');
  const afterDigest = hashFileSync(realDb);
  if (afterDigest.sha256 !== digest.sha256) fail('source database bytes changed during the build; refusing an inconsistent snapshot');

  const wordsBytes = Buffer.from(wordsRows.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
  // v4 frame_index has no authoritative summary payload/srcSeqs. Emit the canonical empty artifact.
  const nonEmptySummaries = Buffer.from('\n', 'utf8');
  const maxSeq = Math.max(...wordsRows.map((r) => r.seq));
  const cursorSeq = o.cursorSeq === undefined || o.cursorSeq === null ? maxSeq : o.cursorSeq;
  if (cursorSeq < maxSeq) fail('cursorSeq must be >= max emitted word seq (' + maxSeq + ')');
  const excludedTotal = Object.values(excludedByType).reduce((a, n) => a + n, 0);
  const version = V4_SOURCE_VERSION;
  const manifest = {
    echoIndexVersion: 'echo-index/1',
    sourcePath: o.sourcePath,
    version,
    namespace: o.namespace,
    generation: o.generation,
    builtAt: new Date(Date.parse(o.builtAt)).toISOString(),
    cursor: { seq: cursorSeq, inputSha256: digest.sha256, inputBytes: digest.bytes },
    words: { path: 'words.jsonl', sha256: sha256(wordsBytes), bytes: wordsBytes.length, rows: wordsRows.length },
    summaries: {
      path: 'summaries.jsonl', sha256: sha256(nonEmptySummaries), bytes: nonEmptySummaries.length, rows: 0,
      source: 'none', capability: 'unavailable',
    },
    counts: {
      words: wordsRows.length,
      summaries: 0,
      srcSeqs: 0,
      excludedReasoning: 0,
      scanned: scanned.length,
      excluded: excludedTotal,
      excludedByType: { ...excludedByType },
    },
    sourceInput: {
      name: path.basename(realDb),
      kind: sourceRow.kind,
      sourceId: sourceRow.sourceId,
      schemaVersion: schema.schemaVersion,
      sourceBytes: digest.bytes,
      sourceSha256: digest.sha256,
      frameCount: scanned.length,
      version,
    },
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  const paths = writeOutputTriplet(outDir, wordsBytes, nonEmptySummaries, manifestBytes);
  return {
    manifestPath: paths.manifestPath,
    manifestSha256: sha256(manifestBytes),
    manifest,
    wordsPath: paths.wordsPath,
    summariesPath: paths.summariesPath,
    source: { ...sourceRow, schemaVersion: schema.schemaVersion, dbSha256: digest.sha256, dbBytes: digest.bytes },
    excluded: { total: excludedTotal, byType: { ...excludedByType } },
  };
}


// ════════════════════════════════════════════════════════════════════════════
// tail 模式：只读追加读取**会话日志本身**（权威、只追加）→ ECHO 三件套
// ════════════════════════════════════════════════════════════════════════════
//
// ★ 这不是「迁移 / 搬家」。原始会话日志是权威且只追加的；这里只读它，增量派生 ECHO 自己的
//   索引。任何一步失败都不推进游标、也不写源树（源文件与索引清单在构建前后必须逐字节不变，
//   这一条由 selftest 实测断言）。
//
// 源契约（2026-11-15 实测；样本与计数见接收回执）：
//   · 会话日志 = <root>/<ws>/<sid>/session.v4.jsonl.zstd（老会话是 session.v3.…，两种都接受）。
//   · 多帧 zstd：zstdDecompressSync(整文件) 只解第一帧。边界由本模块按标准 frame header/block header
//     长度字段逐帧解析，绝不扫描 payload 内的 magic；skippable frame 按其 length 字段跳过。
//   · 半截 frame header/block 是 open tail：不算错，但 completeBytes 停在其起点；坏 descriptor / reserved block
//     或完整 frame 解码失败则整代拒绝，不推进游标、不输出。多帧完整文本需以 LF 结束。
//   · words 来源：user/message（data.content 的 text 块）、assistant/message
//     （data.message.content 的 text 块）。reasoning 块不入索引，单独计数。
//   · summaries 来源：compaction/summary —— cmpId = data.compactionId 原文；
//     srcSeqs = data.shadowedSeqs **原样原序**（重复保留、顺序不改）；shadowedTokens =
//     data.shadowedTokenCount。源帧没有声明「被遮蔽字符数」→ shadowedChars 记 0，不推断。
//   · 索引清单（files.jsonl 形状）：每行至少 {file, sid}，ws 可选。sid 必须等于 <sid> 目录名，
//     否则拒绝 —— 源→会话映射是钉住的，不靠猜。
//
// 游标与指纹：**只落在 TEMP v9 目标里**（echo_index_sources.cursor_json.tail），不另存 sidecar、
// 不写清单、不写源树。
//   · 每个源记 {key:'<mtimeMs>:<bytes>', nextByte, head:<首 4096B 的 sha256>, words, summaries}
//   · key 相同 → 一个字节都不读（skip unchanged）
//   · bytes 变大 → 从 nextByte 起只读追加段；读之前先核 head，前缀变了就拒绝
//   · bytes 变小 → 截断 → 默认拒绝（除非显式 fullRebuild:true）
//   · bytes 相同但 key 变 → 同长改写/轮转 → 默认拒绝（除非显式 fullRebuild:true）
//
// 本阶段唯一允许的落点：outDir 与 dbPath 都必须在 os.tmpdir() 之下；sourceRoot 也必须在临时
// 目录下，除非调用方显式 allowExternalSourceRoot:true。测试永不传它 —— 生产路径不许进这个
// TEMP 写入器。构建器自己**不写目标库**：generation/cursor 由既有 importer 落盘，构建器只读它。
export const SESSION_TAIL_VERSION = 'session-tail/1';
// ★ 源身份里的 "version" 不是本模块的版本：importer 用 manifest.echoIndexVersion 做 (path, version)
//   里的 version（实测：库里 source_version 恒为 'echo-index/1'，即使 manifest.version 是
//   'v4-source/1' 或 'session-tail/1'）。查上一代状态必须用同一把钥匙，否则每次都认成第一代。
export const ECHO_INDEX_VERSION = 'echo-index/1';
export const SESSION_TAIL_WORD_KINDS = Object.freeze({ user: 'human', assistant: '结论' });
const TAIL_PREFIX_BYTES = 4096;

function requireAbsolutePath(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(label + ' must be a non-empty path');
  if (!path.isAbsolute(value)) fail(label + ' must be an absolute path');
  return path.resolve(value);
}

function sha256OfPrefix(file, limit) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.allocUnsafe(limit);
  try {
    const n = fs.readSync(fd, buf, 0, limit, 0);
    return createHash('sha256').update(buf.subarray(0, n)).digest('hex');
  } finally { fs.closeSync(fd); }
}

// 索引清单 → 钉住的源→会话映射。清单里的 cursor 字段（nextByte/nWord/nSum/…）属于**生产索引器**，
// 这里读一眼都不当游标用：本模块的游标只在 TEMP v9 目标里。
export function readSessionTailIndex(options) {
  const o = options || {};
  const rootPath = requireAbsolutePath(o.sourceRoot, 'sourceRoot');
  const manifestPath = requireAbsolutePath(o.manifestPath, 'manifestPath');
  if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) fail('sourceRoot must be an existing directory: ' + rootPath);
  if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) fail('index manifest must be an existing file: ' + manifestPath);
  const root = fs.realpathSync(rootPath);
  const bytes = fs.readFileSync(manifestPath);
  if (bytes.length === 0) fail('index manifest is empty');
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) fail('index manifest must not start with a UTF-8 BOM');
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) fail('index manifest is not valid UTF-8');
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const files = [];
  const seenFile = new Set();
  const seenSid = new Map();
  for (let i = 0; i < lines.length; i += 1) {
    const where = 'index manifest line ' + (i + 1);
    if (!lines[i].trim()) fail(where + ' must be a non-blank JSON row');
    let row;
    try { row = JSON.parse(lines[i]); } catch (err) { fail(where + ' invalid JSON: ' + err.message); }
    if (!row || typeof row !== 'object' || Array.isArray(row)) fail(where + ' must be a JSON object');
    if (typeof row.file !== 'string' || row.file.length === 0) fail(where + ' requires a non-empty file');
    if (typeof row.sid !== 'string' || !SESSION_RE.test(row.sid)) fail(where + ' requires a ptr-safe sid ([A-Za-z0-9._-]{1,128})');
    if (row.ws !== undefined && row.ws !== null && typeof row.ws !== 'string') fail(where + ' ws must be a string or null');
    const file = path.resolve(row.file);
    if (!isSameOrWithin(root, file)) fail(where + ' declares a file outside sourceRoot: ' + row.file);
    const dirSid = path.basename(path.dirname(file));
    if (dirSid !== row.sid) {
      fail(where + ' sid ' + JSON.stringify(row.sid) + ' does not match its session directory ' + JSON.stringify(dirSid) + ' (the source->session mapping is pinned, never inferred)');
    }
    if (seenFile.has(file)) fail(where + ' declares the same file twice: ' + row.file);
    seenFile.add(file);
    if (seenSid.has(row.sid)) {
      fail(where + ' session ' + row.sid + ' is declared by two files (' + seenSid.get(row.sid) + ' and ' + row.file + '); an ambiguous source->session mapping is refused, not resolved by picking one');
    }
    seenSid.set(row.sid, row.file);
    files.push({ file, sid: row.sid, ws: row.ws === undefined ? null : row.ws });
  }
  if (files.length === 0) fail('index manifest declares no files');
  files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return { root, sourcePath: toPosix(root), files, manifestBytes: bytes.length };
}

// Zstd standard frame boundary parser. It walks frame headers and block lengths, so magic-looking
// bytes inside compressed/raw payloads cannot be mistaken for a new frame. It returns null only for
// a structurally plausible but incomplete tail; malformed descriptors/blocks throw (no cursor move).
const ZSTD_MAGIC_BYTES = [0x28, 0xb5, 0x2f, 0xfd];
const ZSTD_SKIP_MAGIC = [0x50,0x2a,0x4d,0x18];
function hasZstdMagic(buf, at) {
  return at + 4 <= buf.length && ZSTD_MAGIC_BYTES.every((b, i) => buf[at + i] === b);
}
function isZstdMagicPrefix(buf, at) {
  const remain = buf.length - at;
  return remain > 0 && remain < 4 && ZSTD_MAGIC_BYTES.slice(0, remain).every((b, i) => buf[at + i] === b);
}
function isZstdSkippablePrefix(buf, at) {
  const remain = buf.length - at;
  return remain > 0 && remain < 4 && ZSTD_SKIP_MAGIC.slice(0, remain).every((b, i) => buf[at + i] === b);
}
function zstdSkippableEnd(buf, at) {
  if (at + 4 > buf.length || !ZSTD_SKIP_MAGIC.every((b, i) => buf[at + i] === b)) return undefined;
  if (at + 8 > buf.length) return null;
  const length = buf[at + 4] | (buf[at + 5] << 8) | (buf[at + 6] << 16) | (buf[at + 7] << 24);
  const end = at + 8 + (length >>> 0);
  return end <= buf.length ? end : null;
}
function readU24LE(buf, at) { return buf[at] | (buf[at + 1] << 8) | (buf[at + 2] << 16); }
function zstdFrameEnd(buf, start) {
  if (!hasZstdMagic(buf, start)) {
    if (isZstdMagicPrefix(buf, start)) return null;
    fail('malformed zstd frame boundary at byte ' + start + ': standard frame magic expected');
  }
  let p = start + 4;
  if (p >= buf.length) return null;
  const descriptor = buf[p++];
  const fcsFlag = descriptor >>> 6;
  const singleSegment = (descriptor & 0x20) !== 0;
  const unused = (descriptor & 0x18) !== 0;
  const checksum = (descriptor & 0x04) !== 0;
  const dictFlag = descriptor & 0x03;
  if (unused) fail('malformed zstd frame header at byte ' + start + ': reserved/unused descriptor bits are set');
  if (!singleSegment) {
    if (p >= buf.length) return null;
    p += 1; // window descriptor
  }
  const dictBytes = [0, 1, 2, 4][dictFlag];
  const fcsBytes = fcsFlag === 0 ? (singleSegment ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8;
  if (p + dictBytes + fcsBytes > buf.length) return null;
  p += dictBytes + fcsBytes;
  for (;;) {
    if (p + 3 > buf.length) return null;
    const h = readU24LE(buf, p); p += 3;
    const last = (h & 1) !== 0;
    const blockType = (h >>> 1) & 3;
    const blockSize = h >>> 3;
    if (blockType === 3) fail('malformed zstd frame at byte ' + start + ': reserved block type');
    const payloadBytes = blockType === 1 ? 1 : blockSize; // RLE stores one byte regardless of decompressed size
    if (p + payloadBytes > buf.length) return null;
    p += payloadBytes;
    if (last) break;
  }
  if (checksum) {
    if (p + 4 > buf.length) return null;
    p += 4;
  }
  return p;
}

export function decodeSessionTailFrames(buf) {
  if (!Buffer.isBuffer(buf)) fail('decodeSessionTailFrames expects a Buffer');
  if (buf.length === 0) return { records: [], completeBytes: 0, frames: 0, badFrames: 0, openTail: false };
  const records = [];
  let completeBytes = 0;
  let frames = 0;
  let openTail = false;
  // ★★★ 2026-11-17：**帧边界 ≠ 记录边界**（生产数据查出来的）。
  //
  //   实测（session-8332345a，79.1MB）：在字节 61,675,845 处有一个**完整**的 zstd 帧，
  //   解压出来的文本却不以 '\n' 结尾 —— 也就是说 DSH 把**一行 JSON 切成了两个帧**。
  //   原来的实现遇到这种就硬失败（"did not decode to complete LF-terminated records"），
  //   于是那一个会话永远无法被索引。
  //
  //   ★ 判据：字节流完整不等于记录完整。**帧是压缩单位，行才是记录单位。**
  //     所以这里跨帧结转：上一帧收口的余料拼到下一帧，只有「收口之后」的字节
  //     才算真的完整。
  //   ★ 收口点（safeBoundary）用于增量续读：如果最后仍有未收口的余料，
  //     说明那一帧的记录还没写完，completeBytes 回退到最后一个收口点，
  //     下一轮从那里重读 —— 而不是把半条记录当成完整数据吃进去。
  let carry = '';
  let safeBoundary = 0;
  while (completeBytes < buf.length) {
    const skipEnd = zstdSkippableEnd(buf, completeBytes);
    if (skipEnd === null) { openTail = true; break; }
    if (skipEnd !== undefined) { completeBytes = skipEnd; frames += 1; continue; }
    if (isZstdMagicPrefix(buf, completeBytes)) { openTail = true; break; }
    if (!hasZstdMagic(buf, completeBytes)) {
      if (frames === 0) fail('not a zstd-framed session log: no frame magic at byte 0');
      fail('malformed zstd stream: bytes after frame boundary at byte ' + completeBytes);
    }
    const end = zstdFrameEnd(buf, completeBytes);
    if (end === null) { openTail = true; break; }
    let text;
    try { text = zlib.zstdDecompressSync(buf.subarray(completeBytes, end)).toString('utf8'); }
    catch (err) { fail('malformed complete zstd frame at byte ' + completeBytes + ': ' + (err && err.message || err)); }
    // 跨帧结转（见循环上方的长注释）
    let body = carry + text;
    carry = '';
    if (!body.endsWith('\n')) {
      const cut = body.lastIndexOf('\n');
      if (cut < 0) { carry = body; body = ''; }
      else { carry = body.slice(cut + 1); body = body.slice(0, cut + 1); }
    }
    if (body.length > 0) {
      for (const line of body.split('\n')) {
        const t = line.trim(); if (!t) continue;
        let rec; try { rec = JSON.parse(t); } catch (err) { fail('complete zstd frame contains invalid JSON: ' + (err && err.message || err)); }
        records.push(rec);
      }
    }
    completeBytes = end;
    frames += 1;
    if (carry === '') safeBoundary = end;
  }
  // 末尾仍有未收口的余料 → 半条记录不算完整数据：回退到最后收口点，按开放尾部处理。
  if (carry !== '') { carry = ''; openTail = true; completeBytes = safeBoundary; }
  return { records, completeBytes, frames, badFrames: 0, openTail };
}

function isoFromSourceTime(value, where) {
  const ms = typeof value === 'number' ? value : (typeof value === 'string' ? Date.parse(value) : NaN);
  if (!Number.isFinite(ms)) fail(where + ': the source record carries no usable time; timestamps are never invented');
  return new Date(ms).toISOString();
}

function textFromBlockArray(value, where, label) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) fail(where + ': ' + label + ' must be a string or a content-block array');
  const parts = [];
  for (const block of value) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

function reasoningBlockCount(value) {
  if (!Array.isArray(value)) return 0;
  let n = 0;
  for (const block of value) {
    if (block && typeof block === 'object' && block.type === 'reasoning' && typeof block.text === 'string' && block.text.length > 0) n += 1;
  }
  return n;
}

// 固定字段序 → 逐字节稳定的 words.jsonl 行（与 importer 的 ECHO_WORD_FIELDS 同序）。
function canonicalWordLine(row) {
  return JSON.stringify({
    t: row.t, session: row.session, ws: row.ws, seq: row.seq, turn: row.turn, log: row.log,
    role: row.role, kind: row.kind, len: row.len, truncated: row.truncated, text: row.text,
  });
}

function wordRowFromDb(row) {
  return {
    t: row.t, session: row.session, ws: row.ws, seq: Number(row.seq), turn: row.turn === null ? null : Number(row.turn),
    log: row.log, role: row.role, kind: row.kind, len: Number(row.len),
    truncated: Number(row.truncated) === 1, text: row.text,
  };
}

// 一条会话记录 → { words, summaries }（纯粹的映射，不推断、不补行）。
function rowsFromSessionRecord(rec, ctx) {
  const where = ctx.where;
  const type = rec && rec.type;
  if (type === 'user/message') {
    const blocks = rec.data && rec.data.content;
    const text = textFromBlockArray(blocks, where + ' (user/message)', 'data.content');
    if (!text.trim()) return { excluded: 'user/message(空)' };
    return { word: { t: isoFromSourceTime(rec.time, where), session: ctx.sid, ws: ctx.ws, seq: seqOf(rec, where), turn: null, log: ctx.log, role: 'user', kind: SESSION_TAIL_WORD_KINDS.user, len: charLen(text), truncated: false, text } };
  }
  if (type === 'assistant/message') {
    const message = rec.data && rec.data.message;
    if (!message || typeof message !== 'object') return { excluded: 'assistant/message(无 message)' };
    const text = textFromBlockArray(message.content, where + ' (assistant/message)', 'data.message.content');
    const reasoning = reasoningBlockCount(message.content);
    if (!text.trim()) return { excluded: 'assistant/message(空)', reasoning };
    return { word: { t: isoFromSourceTime(rec.time, where), session: ctx.sid, ws: ctx.ws, seq: seqOf(rec, where), turn: null, log: ctx.log, role: 'assistant', kind: SESSION_TAIL_WORD_KINDS.assistant, len: charLen(text), truncated: false, text }, reasoning };
  }
  if (type === 'compaction/summary') {
    const data = rec.data;
    if (!data || typeof data !== 'object') return { excluded: 'compaction/summary(无 data)' };
    const cmpId = data.compactionId;
    if (typeof cmpId !== 'string' || !CMP_RE.test(cmpId)) fail(where + ': compaction/summary carries no idx-safe compactionId');
    const summary = textFromBlockArray(data.summary, where + ' (compaction/summary)', 'data.summary');
    if (summary.length === 0) fail(where + ': compaction/summary declares an empty summary; refusing to index nothing');
    if (!Array.isArray(data.shadowedSeqs) || data.shadowedSeqs.length === 0) fail(where + ': compaction/summary declares no shadowedSeqs; srcSeqs are never inferred');
    for (const n of data.shadowedSeqs) if (!Number.isSafeInteger(n) || n < 0) fail(where + ': shadowedSeqs must be non-negative safe integers');
    const tokens = data.shadowedTokenCount;
    if (!Number.isSafeInteger(tokens) || tokens < 0) fail(where + ': shadowedTokenCount must be a non-negative safe integer');
    if (data.provider !== null && data.provider !== undefined && typeof data.provider !== 'string') fail(where + ': provider must be a string or null');
    if (data.model !== null && data.model !== undefined && typeof data.model !== 'string') fail(where + ': model must be a string or null');
    return { summary: {
      cmpId, t: isoFromSourceTime(rec.time, where), session: ctx.sid, ws: ctx.ws, log: ctx.log,
      srcSeqs: data.shadowedSeqs.slice(), shadowedTokens: tokens,
      // 源帧没有声明「被遮蔽字符数」（只有 shadowedRange/shadowedSeqs/shadowedTokenCount）。
      // 0 = 未声明，不是测量值 —— 不拿 summary 的长度冒充它。
      shadowedChars: 0,
      provider: typeof data.provider === 'string' ? data.provider : null,
      model: typeof data.model === 'string' ? data.model : null,
      status: 'active', summary,
    } };
  }
  return { excluded: typeof type === 'string' ? type : '(无 type)' };
}

function seqOf(rec, where) {
  if (!Number.isSafeInteger(rec.seq) || rec.seq < 0) fail(where + ': ' + String(rec.type) + ' carries no non-negative integer seq (log:<sid>#seq would be unresolvable)');
  return rec.seq;
}

function summaryLine(summary) {
  return JSON.stringify({
    cmpId: summary.cmpId, t: summary.t, session: summary.session, ws: summary.ws, log: summary.log,
    srcSeqs: summary.srcSeqs, shadowedTokens: summary.shadowedTokens, shadowedChars: summary.shadowedChars,
    provider: summary.provider, model: summary.model, status: summary.status, summary: summary.summary,
  });
}

// 读 TEMP v9 目标里这一代之前的状态；构建器只读，绝不写库（写库是 importer 的事）。
function readTailState(db, echoSourceId, sourcePath) {
  const row = db.prepare('SELECT * FROM echo_index_sources WHERE echo_source_id = ?').get(echoSourceId);
  if (row === undefined) {
    const same = db.prepare('SELECT echo_source_id FROM echo_index_sources WHERE source_path = ? AND source_version = ?').all(sourcePath, ECHO_INDEX_VERSION);
    if (same.length > 0) fail('the target database holds a conflicting echo_source_id for this (path, version); refusing to guess which one is authoritative');
    return null;
  }
  if (row.source_path !== sourcePath || row.source_version !== ECHO_INDEX_VERSION) {
    fail('deterministic echo_source_id collision: the stored row is ' + JSON.stringify([row.source_path, row.source_version]) + ' but this build is ' + JSON.stringify([sourcePath, ECHO_INDEX_VERSION]));
  }
  if (row.state !== 'committed') fail('generation ' + row.generation + ' is not committed; refusing to build the next generation on an unimported base');
  let cursor;
  try { cursor = JSON.parse(row.cursor_json); } catch (err) { fail('stored cursor_json is not JSON: ' + err.message); }
  const tail = cursor && cursor.tail;
  if (!tail || typeof tail !== 'object' || Array.isArray(tail)) fail('stored cursor carries no tail block; this database was not written by ' + SESSION_TAIL_VERSION);
  if (tail.version !== SESSION_TAIL_VERSION) fail('stored tail cursor version is ' + JSON.stringify(tail.version) + ' but this builder speaks ' + SESSION_TAIL_VERSION);
  if (!tail.files || typeof tail.files !== 'object' || Array.isArray(tail.files)) fail('stored tail cursor has no per-file map');
  return { generation: Number(row.generation), cursor, tail, wordsCount: Number(row.words_count), summariesCount: Number(row.summaries_count) };
}

function readCommittedRows(db, echoSourceId) {
  const words = db.prepare('SELECT t, session, ws, seq, turn, log, role, kind, len, truncated, text FROM echo_words WHERE echo_source_id = ? ORDER BY word_ord').all(echoSourceId).map(wordRowFromDb);
  const summaries = readCommittedSummaries(db, echoSourceId);
  return { words, summaries };
}

// ★★★ 2026-11-17：**只读摘要，不读词表**。
//
//   为什么需要它（生产数据查出来的）：append 模式为了省时间不读已提交行，
//   于是 factById / summaryLines 都是空的。这时如果某个会话被整份重读
//   （新出现的、或游标里没有的文件），它里面的 compaction/summary 帧会被**重新产出**，
//   而那条摘要早就以同一个 cmpId 提交过了 —— 批内去重看不见库里的，于是直接撞
//   UNIQUE constraint failed: echo_summaries(echo_source_id, cmp_id)，整笔回滚。
//
//   ★ 为什么可以只读摘要：摘要条数是百位（本机 125 条），词表是十万位（5.9 万条）。
//     读摘要是毫秒级，读词表是秒级 —— 缺失的那部分信息只需要摘要就够。
function readCommittedSummaries(db, echoSourceId) {
  return db.prepare('SELECT full_json FROM echo_summaries WHERE echo_source_id = ? ORDER BY ord').all(echoSourceId).map((r) => String(r.full_json));
}

export function syncFromSessionTail(options) {
  const o = options || {};
  for (const k of ['sourceRoot', 'manifestPath', 'outDir', 'dbPath', 'builtAt']) {
    if (o[k] === undefined || o[k] === null || o[k] === '') fail('missing explicit option ' + k);
  }
  const fullRebuild = o.fullRebuild === undefined ? false : o.fullRebuild;
  if (typeof fullRebuild !== 'boolean') fail('fullRebuild must be a boolean when provided');
  if (o.allowExternalSourceRoot !== undefined && typeof o.allowExternalSourceRoot !== 'boolean') fail('allowExternalSourceRoot must be a boolean when provided');
  if (o.namespace !== undefined && !['log', 'v4log'].includes(o.namespace)) fail('namespace must be log|v4log');
  const namespace = o.namespace === undefined ? 'log' : o.namespace;
  if (typeof o.builtAt !== 'string' || !Number.isFinite(Date.parse(o.builtAt))) fail('builtAt must be parseable timestamp');

  const outDir = requireAbsolutePath(o.outDir, 'outDir');
  const dbPath = requireAbsolutePath(o.dbPath, 'dbPath');
  const realTemp = fs.existsSync(os.tmpdir()) ? fs.realpathSync(os.tmpdir()) : path.resolve(os.tmpdir());
  if (!isSameOrWithin(realTemp, outDir)) fail('outDir must live under the OS temporary directory for this stage: ' + outDir);
  if (o.allowExternalDb !== true && !isSameOrWithin(realTemp, dbPath)) fail('dbPath must live under the OS temporary directory unless allowExternalDb is explicitly true: ' + dbPath);
  if (isSameOrWithin(outDir, dbPath)) fail('dbPath must not live inside outDir (the output triplet is written as one group)');
  if (fs.existsSync(outDir) && (!fs.statSync(outDir).isDirectory() || fs.readdirSync(outDir).length > 0)) {
    fail('outDir must be absent or empty (each generation gets its own directory): ' + outDir);
  }

  const index = readSessionTailIndex({ sourceRoot: o.sourceRoot, manifestPath: o.manifestPath });
  if (o.allowExternalSourceRoot !== true && !isSameOrWithin(realTemp, index.root)) {
    fail('sourceRoot must live under the OS temporary directory unless allowExternalSourceRoot is explicitly true: ' + index.root);
  }
  if (!fs.existsSync(dbPath) || !fs.statSync(dbPath).isFile()) fail('dbPath must be an existing v9 database (this stage never creates or migrates one): ' + dbPath);

  const echoSourceId = echoSourceIdFor(index.sourcePath, ECHO_INDEX_VERSION);
  // ★ 为什么不是 readOnly:true（实测，2026-11-15）：目标库是 importer 用 WAL 写的，上一代刚提交
  //   的数据还在 -wal 里；纯只读连接读不到它，于是「上一代明明提交了，构建器却当成第一代」——
  //   表现就是每次 sync 都整份重读。这里以可写句柄打开、**立刻 query_only=ON**：连接能读 WAL，
  //   而 SQLite 层直接挡掉本构建器的任何写操作（写库是 importer 的事，这条由库层护栏保证）。
  const db = openDatabase(dbPath, { readOnly: false });
  let prior = null;
  let committed = { words: [], summaries: [] };
  let committedSrcSeqs = 0;
  try {
    configureConnection(db, { memory: true });
    db.exec('PRAGMA query_only = ON');
    if (db.prepare('PRAGMA query_only').get().query_only !== 1) fail('failed to put the destination connection into query_only mode; refusing to read a database this builder could write to');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map((r) => r.name));
    for (const t of ['echo_index_sources', 'echo_words', 'echo_summaries', 'echo_summary_src_seqs']) {
      if (!tables.has(t)) fail('destination database lacks the v9 ECHO structure ' + t + ' (this stage never migrates a database)');
    }
    prior = readTailState(db, echoSourceId, index.sourcePath);
    // deltaOnly 时需要「上一代已提交的 srcSeq 子表行数」——它不进 manifest 的声明计数，
    // 但 counts.srcSeqs 的对账对象是子表实际行数，所以必须加回来。
    if (prior !== null && o.deltaOnly === true) {
      committedSrcSeqs = Number(db.prepare('SELECT COUNT(*) AS n FROM echo_summary_src_seqs WHERE echo_source_id = ?').get(echoSourceId).n);
    }
    // ★★ 2026-11-17（阶段 3 · 第三次提速）：deltaOnly 时**不读回已提交的全部行**。
    //
    //   实测（38k 词 / 862MB 库）：一轮 append 8,326 ms 里 buildMs 占 6,301 ms，
    //   而这一轮只新增 1 个词。那 6 秒主要花在
    //     readCommittedRows: SELECT 全部 38k 行 → 逐行 map → 重建 Map → 重新排序 → 序列化整代
    //   而 append 模式根本不看整代（它只吃 delta）。整代三件套存在的意义是「可全量重建」，
    //   不是「每轮都重写一遍」。
    //
    //   ★ 所以给它一个显式开关：deltaOnly 时只产出 delta + 游标，整代文件不写。
    //     代价：出问题要全量重建时得跑一次 deltaOnly:false（那是人在做的动作，不在一轮里）。
    if (prior !== null && o.deltaOnly !== true) committed = readCommittedRows(db, echoSourceId);
    // ★ deltaOnly：词表不读（省的就是它），但**摘要必须读** —— 否则重读出来的
    //   compaction/summary 帧会以同一个 cmpId 二次提交，撞 UNIQUE 整笔回滚。
    else if (prior !== null && o.deltaOnly === true) committed = { words: [], summaries: readCommittedSummaries(db, echoSourceId) };
    // ★ fullRebuild = 「把这一代当成全新一代」：上一代的词/摘要**不并入**（否则同一 (session,seq)
    //   会被读两遍，被判成重复）。代际仍 +1（importer 一次只走一步），旧代由 importer 整代替换。
    if (fullRebuild) committed = { words: [], summaries: [] };
  } finally {
    try { db.close(); } catch { /* 关闭失败不掩盖原结论 */ }
  }

  // ★ deltaOnly：只产出 delta + 游标，不读回/不重写整代（理由见上面 readCommittedRows 那段）。
  //   声明必须**早于**任何用到它的地方 —— 我第一版写在使用点之后，自检直接 ReferenceError。
  const deltaOnly = prior !== null && o.deltaOnly === true;
  const generation = prior === null ? 1 : prior.generation + 1;
  const priorFiles = prior === null ? {} : prior.tail.files;
  // ★★★ 2026-11-17：**路径键必须归一**。
  //   踩到的形状（生产首建时白跑 20 分钟）：游标里的键是 path.resolve() 出来的
  //   Windows 反斜杠路径，而调用方传的清单用 posix 正斜杠。直接查表永远对不上
  //   → 每个文件都被判成「从没读过」→ 645MB 全部重新解压重派生。
  //   修法：读时两种键都认，写回时统一成 posix（下一轮就都一样了）。
  const toPosixKey = (v) => String(v).replace(/\\/g, '/');
  const priorIndex = new Map();
  for (const [k, v] of Object.entries(priorFiles)) {
    priorIndex.set(k, v);
    priorIndex.set(toPosixKey(k), v);
  }
  const stateFiles = Object.create(null);
  const report = [];
  const newWords = [];
  const newSummaries = [];
  const excludedByType = Object.create(null);
  let excludedReasoningFrames = 0;
  let recordsSeen = 0;
  let badFrames = 0;
  let openTails = 0;

  for (const entry of index.files) {
    const stat = fs.statSync(entry.file);
    if (!stat.isFile()) fail('declared source is not a regular file: ' + entry.file);
    const key = stat.mtimeMs + ':' + stat.size;
    const prev = priorIndex.get(entry.file) || priorIndex.get(toPosixKey(entry.file)) || undefined;
    let mode;
    let from = 0;
    if (prev === undefined || fullRebuild || prev.nextByte === undefined) {
      mode = prev === undefined ? 'full' : 'full-rebuild';
    } else if (!Number.isSafeInteger(prev.nextByte) || prev.nextByte < 0 || prev.nextByte > prev.size) {
      fail('stored cursor for ' + entry.file + ' is inconsistent (nextByte ' + String(prev.nextByte) + ' vs size ' + String(prev.size) + ')');
    } else if (stat.size < prev.size) {
      fail('source shrank (truncation): ' + entry.file + ' is ' + stat.size + ' bytes but the cursor was taken at ' + prev.size + '; refusing to re-read a truncated log (pass fullRebuild:true to rebuild from byte 0 on purpose)');
    } else if (stat.size === prev.size && key !== prev.key) {
      fail('source was rewritten in place (same size, different file key): ' + entry.file + ' (' + prev.key + ' -> ' + key + '); refusing a rotation under an append cursor (pass fullRebuild:true to rebuild from byte 0 on purpose)');
    } else if (stat.size === prev.size) {
      mode = 'unchanged';
      from = prev.nextByte;
    } else {
      mode = 'append';
      from = prev.nextByte;
    }

    // ★★ 2026-11-17（第 5 次提速）：**unchanged 时不再读 4KB 算头部哈希**。
    //
    //   实测（1,608 会话 / 646MB）：一轮增量 buildMs 3,039 ms，而这一轮只变了 1 个文件。
    //   那 3 秒 = 每个会话一次 sha256OfPrefix（读 4KB）×2（校验一次、写回游标又一次）。
    //
    //   ★ 为什么 unchanged 下这道校验是冗余的：
    //     进入 unchanged 的前提是 key（mtimeMs:size）与上次**逐位相同**。
    //     「文件被原地重写但大小没变」这种情况会改 mtime —— 那 key 就不同，会落到上面
    //     的 'source was rewritten in place' 分支被拒。所以 key 相同 ⇒ 内容未变，
    //     再读一遍 4KB 只是把一个已知为真的断言又证一遍。
    //   ★ append 分支仍然照旧核头 —— 那里确实可能「变长了但前缀被改」。
    if (mode === 'append') {
      const head = sha256OfPrefix(entry.file, Math.min(TAIL_PREFIX_BYTES, from));
      if (typeof prev.head === 'string' && prev.head !== head) {
        fail('prefix of ' + entry.file + ' changed under an append cursor (head sha256 ' + prev.head + ' -> ' + head + '); rotation suspected, refusing');
      }
    }

    let bytesRead = 0;
    let fileRecords = 0;
    let fileBadFrames = 0;
    let fileOpenTail = false;
    let nextByte = mode === 'unchanged' ? prev.nextByte : 0;
    let stableFileStat = stat;
    let stableKey = key;
    if (mode !== 'unchanged') {
      const whole = mode === 'full' || mode === 'full-rebuild' ? 0 : from;
      const fd = fs.openSync(entry.file, 'r');
      let window;
      let openedStat;
      let postReadFdStat;
      try {
        openedStat = fs.fstatSync(fd);
        if (typeof o.afterSourceSnapshot === 'function') o.afterSourceSnapshot({ file: entry.file, size: openedStat.size, mtimeMs: openedStat.mtimeMs, offset: whole });
        if (openedStat.size < whole) fail('source shrank after path stat: ' + entry.file + ' (descriptor size ' + openedStat.size + ' < offset ' + whole + ')');
        window = Buffer.allocUnsafe(openedStat.size - whole);
        let read = 0;
        while (read < window.length) {
          const n = fs.readSync(fd, window, read, window.length - read, whole + read);
          if (n <= 0) break;
          read += n;
        }
        if (read !== window.length) fail('short read on ' + entry.file + ' (' + read + ' of ' + window.length + ' bytes)');
        postReadFdStat = fs.fstatSync(fd);
      } finally { fs.closeSync(fd); }
      const postReadPathStat = fs.statSync(entry.file);
      const sameSnapshot = (a, b) => a.size === b.size && a.mtimeMs === b.mtimeMs;
      if (!sameSnapshot(stat, openedStat) || !sameSnapshot(openedStat, postReadFdStat) || !sameSnapshot(postReadFdStat, postReadPathStat)) {
        fail('source changed while being read; refusing this generation without advancing its cursor: ' + entry.file);
      }
      const stableSize = postReadFdStat.size;
      if (whole + window.length > stableSize) fail('read window exceeded stable source size: ' + entry.file);
      stableFileStat = postReadFdStat;
      stableKey = stableFileStat.mtimeMs + ':' + stableFileStat.size;
      bytesRead = window.length;
      const decoded = decodeSessionTailFrames(window);
      fileRecords = decoded.records.length;
      fileBadFrames = decoded.badFrames;
      fileOpenTail = decoded.openTail;
      recordsSeen += fileRecords;
      badFrames += fileBadFrames;
      if (fileOpenTail) openTails += 1;
      const ctx = { sid: entry.sid, ws: entry.ws, log: entry.file, where: entry.sid + ' @' + whole };
      for (const rec of decoded.records) {
        const mapped = rowsFromSessionRecord(rec, ctx);
        if (mapped.reasoning) excludedReasoningFrames += mapped.reasoning;
        if (mapped.excluded) { excludedByType[mapped.excluded] = (excludedByType[mapped.excluded] || 0) + 1; continue; }
        if (mapped.word) newWords.push(mapped.word);
        if (mapped.summary) newSummaries.push(mapped.summary);
      }
      nextByte = whole + decoded.completeBytes;
    }
    if (!Number.isSafeInteger(nextByte) || nextByte < 0 || nextByte > stableFileStat.size) {
      fail('computed cursor nextByte ' + nextByte + ' exceeds stable source size ' + stableFileStat.size + ' for ' + entry.file + '; refusing this generation');
    }
    const fileWords = newWords.filter((w) => w.session === entry.sid).length;
    const fileSummaries = newSummaries.filter((s) => s.session === entry.sid).length;
    stateFiles[toPosixKey(entry.file)] = {
      key: stableKey, size: stableFileStat.size, mtimeMs: stableFileStat.mtimeMs, nextByte,
      // head 只覆盖**已消费的**前缀（nextByte），这样「追加后核 head」两边比的是同一段字节。
      // ★ unchanged 时直接沿用上一代的 head —— 文件一个字节都没动，重算它没有新信息。
      head: mode === 'unchanged' && typeof prev.head === 'string'
        ? prev.head
        : sha256OfPrefix(entry.file, Math.min(TAIL_PREFIX_BYTES, nextByte)),
      words: fileWords, summaries: fileSummaries, mode,
    };
    report.push({ file: entry.file, sid: entry.sid, mode, from, bytesRead, records: fileRecords, badFrames: fileBadFrames, openTail: fileOpenTail, nextByte, size: stableFileStat.size, words: fileWords, summaries: fileSummaries });
  }

  // 累计工件：上一代已提交的行（从 TEMP v9 目标读回，逐字重建）+ 本次新增行。
  const wordLines = new Map();
  for (const row of committed.words) wordLines.set(row.session + '\u0000' + String(row.seq), canonicalWordLine(row));
  for (const row of newWords) {
    const k = row.session + '\u0000' + String(row.seq);
    if (wordLines.has(k)) fail('two source frames share session+seq ' + row.session + ' #' + row.seq + ' (log:<sid>#seq must stay unambiguous within a source)');
    wordContentHash(row);
    wordLines.set(k, canonicalWordLine(row));
  }
  const summaryLines = new Map();
  for (const line of committed.summaries) {
    let parsed;
    try { parsed = JSON.parse(line); } catch (err) { fail('stored summary full_json is not JSON: ' + err.message); }
    summaryLines.set(parsed.cmpId, line);
  }
  const factById = new Map();
  const summaryOrder = [...summaryLines.keys()];
  // ★ 增量路径：上一代已提交的摘要必须也进 factById，否则第二轮会把「同一个重放」
  //   判成「内容不同」—— 因为 factById 是空的。这条是被第五次试跑逼出来的：
  //   首轮该过的已经过了，下一轮从 committed 重建时又会被拒。
  for (const line of summaryLines.values()) {
    try {
      const p = JSON.parse(line);
      factById.set(p.cmpId, JSON.stringify({
        cmpId: p.cmpId, summary: p.summary, srcSeqs: p.srcSeqs,
        shadowedTokens: p.shadowedTokens, status: p.status,
      }));
    } catch { /* 解析不了就不入表 —— 后面会按「不同」处理，宁可拒不可错合 */ }
  }
  // ★★ 2026-11-17：同一个 cmpId 出现两次 —— 只有在**内容等价**时才允许。
  //
  //   实测证据（本机 1,609 个会话里命中 1 例，cmpId a9467636-…）：
  //     会话 1c370fe1 与 c47366f7 各存了一条 compaction/summary，
  //     seq 2365 / time 1794590032244 / summaryLen 13,316 / shadowedSeqs 607 / tokens 305,724
  //     —— **逐项相同**。那是同一次压缩被两条会话各记了一遍（fork 出来的会话把父会话的
  //     压缩帧一起带走了），不是「两个不同的摘要抢一个 id」。
  //
  //   判据与 importer 处理 word 的那条完全一致：**比内容，不比 id**。
  //     内容相同 → 保留一份（重放），不报错；
  //     内容不同 → 仍然拒绝（idx:<cmpId> 必须唯一指向一个摘要）。
  //   ★ 这不是放宽契约，是把「id 撞了」和「同一个东西被记了两遍」分开 ——
  //     后者是数据事实，前者才是错误。
  //   ★★ 比什么：**压缩事实本身**，不是整行。
  //   第一次我把 summaryLine(s) 整行拿来比，结果仍然判「不同」—— 因为那一行里有
  //   session 与 log 两个**记录位置**字段，而同一份压缩被两个会话各记一遍时，
  //   这两个字段本来就不同（一条属于 1c370fe1、一条属于 c47366f7）。
  //   真正属于「这次压缩」的只有：cmpId + 摘要正文 + shadowedSeqs + shadowedTokens。
  //   那四样一样，就是同一次压缩；不一样，才是两个摘要抢一个 id。
  const compressionFacts = (s) => JSON.stringify({
    cmpId: s.cmpId, summary: s.summary, srcSeqs: s.srcSeqs,
    shadowedTokens: s.shadowedTokens, status: s.status,
  });
  let replaySummaries = 0;
  // ★★ 2026-11-17：**只记「真正新加入的」**，不是「解析到的全部」。
  //   踩到的形状（生产巨会话批次，UNIQUE constraint failed on echo_summaries）：
  //   newSummaryIds 原先由 newSummaries（原始解析列表）构建，于是那些被判定为
  //   「重放」而 continue 掉的摘要**仍然出现在 delta 文件里**，入库时与库内已有行
  //   撞 (echo_source_id, cmp_id) 唯一约束 —— 整笔回滚。
  //   ★ 判据：delta 的语义是「本代新增」，所以它只能包含**确实调用过
  //     summaryLines.set 的那些 id**。重放不是新增。
  const addedSummaryIds = new Set();
  for (const s of newSummaries) {
    const fact = compressionFacts(s);
    if (summaryLines.has(s.cmpId)) {
      if (factById.get(s.cmpId) === fact) { replaySummaries += 1; continue; }
      fail('two compaction/summary frames declare the same cmpId ' + s.cmpId + ' with DIFFERENT content (idx:<cmpId> must stay unambiguous within a source)');
    }
    summaryLines.set(s.cmpId, summaryLine(s));
    factById.set(s.cmpId, fact);
    summaryOrder.push(s.cmpId);
    addedSummaryIds.add(s.cmpId);
  }
  if (wordLines.size === 0) fail('the declared sources produced no user/assistant rows at all; refusing to emit an empty generation');

  // ★★ 2026-11-17（阶段 3 · 追加模式）：把「本代**新增**的行」单独落一份。
  //
  //   为什么要多这一份：importer 原来是「删整代 → 重写整代」，61k 词一轮 441 秒。
  //   实测（同一台机器、61k 行的库上）：
  //     整代替换（删 61k + 重写 61k）      441,188 ms
  //     纯追加 31 行（不删任何东西）              73 ms
  //   差的不是 SQLite，是「有没有必要重写没变的东西」。
  //   这里输出的 delta 只含本代新派生的行，供 importer 的 append 模式用。
  //   ★ 整代三件套仍然照旧写全 —— append 用 delta，全量重建用整代，两条路都能走。
  const newWordKeySet = new Set(newWords.map((w) => w.session + '\u0000' + String(w.seq)));
  const newSummaryIds = addedSummaryIds;

  const wordRows = [...wordLines.entries()].map(([k, line]) => ({ k, line, key: k.split('\u0000') }))
    .sort((a, b) => (a.key[0] < b.key[0] ? -1 : a.key[0] > b.key[0] ? 1 : Number(a.key[1]) - Number(b.key[1])));
  const wordsBytes = Buffer.from(wordRows.map((r) => r.line).join('\n') + '\n', 'utf8');

  const parsedSummaries = [...summaryLines.values()].map((line) => JSON.parse(line));
  parsedSummaries.sort((a, b) => {
    if (a.session !== b.session) return a.session < b.session ? -1 : 1;
    if (a.t !== b.t) return a.t < b.t ? -1 : 1;
    return a.cmpId < b.cmpId ? -1 : a.cmpId > b.cmpId ? 1 : 0;
  });
  const summaryLinesSorted = parsedSummaries.map((s) => summaryLines.get(s.cmpId));
  const summariesBytes = summaryLinesSorted.length === 0 ? Buffer.from('\n', 'utf8') : Buffer.from(summaryLinesSorted.join('\n') + '\n', 'utf8');

  // srcSeq 覆盖是**声明 vs 已发射**的诚实对照：既不丢声明，也不假装解析得到。
  const emittedKeys = new Set(wordRows.map((r) => r.key[0] + '\u0000' + r.key[1]));
  let srcSeqRefs = 0;
  let srcSeqResolved = 0;
  const dangling = [];
  for (const s of parsedSummaries) {
    for (const seq of s.srcSeqs) {
      srcSeqRefs += 1;
      if (emittedKeys.has(s.session + '\u0000' + String(seq))) srcSeqResolved += 1;
      else dangling.push({ cmpId: s.cmpId, session: s.session, seq });
    }
  }

  const maxSeq = Math.max(...wordRows.map((r) => Number(r.key[1])));
  const tailState = { version: SESSION_TAIL_VERSION, files: stateFiles };
  const snapshot = Object.keys(stateFiles).sort().map((f) => ({ file: f, key: stateFiles[f].key, nextByte: stateFiles[f].nextByte }));
  const snapshotSha = sha256(Buffer.from(JSON.stringify(snapshot), 'utf8'));
  const sourceBytes = Object.values(stateFiles).reduce((a, s) => a + s.nextByte, 0);
  const skippedUnchanged = report.filter((r) => r.mode === 'unchanged').length;
  const appended = report.filter((r) => r.mode === 'append').length;
  const fullyRead = report.filter((r) => r.mode === 'full' || r.mode === 'full-rebuild').length;
  const totalExcluded = Object.values(excludedByType).reduce((a, n) => a + n, 0);

  // ★ deltaOnly：整代文件不承载全量时，manifest.words.rows / summaries.rows 必须仍是
  //   **整代总数**（importer 的交叉验证拿它对账「库内现状 + delta」）。
  //   算法：上一代已提交计数 + 本代新增。
  const totalWords = deltaOnly ? (Number(prior.wordsCount) + wordRows.length) : wordRows.length;
  // ★★★ 2026-11-17：append 下「整代摘要总数」= 库里已有 + **本批新增**，
  //   不是「库里已有 + summaryLines 全部」。
  //   summaryLines 现在被已提交摘要**预置**了（为了让重放能被识别），
  //   所以它的长度包含旧摘要 —— 拿它当新增数会把 91 条旧摘要重复计进总数，
  //   于是 importer 的交叉校验报 "summaries 125+473 != declared 689"。
  //   ★ 新增的判据只有一处：**真正写进 delta 文件的那批**（addedSummaryIds）。
  //   ★ 这里踩了第二次同样的坑：先用 newSummaries.length（解析到的 473），
  //     而实际新增只有 439 —— 差额 34 就是那些与库内 cmp_id 相同的重放。
  //     「解析到的」永远不等于「新增的」；记账要用后者。
  const totalSummaries = deltaOnly
    ? (Number(prior.summariesCount) + addedSummaryIds.size)
    : summaryLinesSorted.length;
  const manifest = {
    echoIndexVersion: ECHO_INDEX_VERSION,
    sourcePath: index.sourcePath,
    version: SESSION_TAIL_VERSION,
    namespace,
    generation,
    builtAt: new Date(Date.parse(o.builtAt)).toISOString(),
    cursor: { seq: maxSeq, inputSha256: snapshotSha, inputBytes: sourceBytes, tail: tailState },
    words: { path: 'words.jsonl', sha256: sha256(wordsBytes), bytes: wordsBytes.length, rows: totalWords },
    summaries: { path: 'summaries.jsonl', sha256: sha256(summariesBytes), bytes: summariesBytes.length, rows: totalSummaries },
    counts: {
      // ★ srcSeqs 同样是「整代累计」：deltaOnly 时要把上一代已提交的加回来，
      //   否则 importer 的 srcSeqs 对账（它比的是子表实际行数）会对不上。
      words: totalWords, summaries: totalSummaries,
      srcSeqs: deltaOnly ? (Number(prior.cursor && prior.cursor.seq !== undefined ? 0 : 0) + srcSeqRefs + committedSrcSeqs) : srcSeqRefs,
      excludedReasoning: 0,
      files: index.files.length, records: recordsSeen, excluded: totalExcluded, excludedByType: { ...excludedByType },
      skippedUnchanged, appended, fullyRead, badFrames, openTails, excludedReasoningFrames,
      srcSeqResolved, srcSeqDangling: dangling.length,
    },
    sourceInput: {
      kind: 'session-tail', root: index.sourcePath, version: SESSION_TAIL_VERSION,
      manifestBytes: index.manifestBytes, files: index.files.length, bytesRead: report.reduce((a, r) => a + r.bytesRead, 0),
      fullRebuild, generation,
    },
  };
  // ★ delta 两件套：只含本代新增行（append 模式用）。整代三件套照旧 —— 两条路都能走。
  const deltaWordRows = wordRows.filter((r) => newWordKeySet.has(r.key[0] + '\u0000' + r.key[1]));
  const deltaSummaryLines = summaryLinesSorted.filter((line) => {
    try { return newSummaryIds.has(JSON.parse(line).cmpId); } catch { return false; }
  });
  manifest.counts.newWords = deltaWordRows.length;
  manifest.counts.newSummaries = deltaSummaryLines.length;
  const deltaWordsBytes = Buffer.from(deltaWordRows.length ? deltaWordRows.map((r) => r.line).join('\n') + '\n' : '', 'utf8');
  const deltaSummariesBytes = Buffer.from(deltaSummaryLines.length ? deltaSummaryLines.join('\n') + '\n' : '', 'utf8');

  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  const paths = writeOutputTriplet(outDir, wordsBytes, summariesBytes, manifestBytes);
  const deltaWordsPath = path.join(outDir, 'new-words.jsonl');
  const deltaSummariesPath = path.join(outDir, 'new-summaries.jsonl');
  fs.writeFileSync(deltaWordsPath, deltaWordsBytes);
  fs.writeFileSync(deltaSummariesPath, deltaSummariesBytes);
  return {
    manifestPath: paths.manifestPath, manifestSha256: sha256(manifestBytes), manifest,
    wordsPath: paths.wordsPath, summariesPath: paths.summariesPath,
    deltaWordsPath, deltaSummariesPath,
    delta: { words: deltaWordRows.length, summaries: deltaSummaryLines.length },
    generation, echoSourceId,
    tail: {
      files: report, skippedUnchanged, appended, fullyRead,
      records: recordsSeen, badFrames, openTails,
      srcSeqRefs, srcSeqResolved, dangling,
      bytesRead: report.reduce((a, r) => a + r.bytesRead, 0),
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// feed 模式（2026-11-15）：只读复制**权威 ECHO 索引 JSONL** → 独立 TEMP v4 索引
// ════════════════════════════════════════════════════════════════════════════
//
// ★ 它是什么：把 memory/hub/index 里**已经存在、已经权威**的
//   files.jsonl / words.jsonl / summaries.jsonl 逐字复制成 importer 能吃的一份 feed。
//   它**不是**「从原始 zstd 会话重建索引」—— 那件事本模块不做，也绝不假装做过。
//   原始会话日志 / 02-墨 / shards 在这条路径上**一个字节都不读**：源身份（log 路径）原样来自
//   words.jsonl，游标（key/nextByte）原样来自 files.jsonl，全部是索引自己声明的字段。
//
// 实测（2026-11-15，只读元数据）：
//   · files.jsonl 1458 行，字段 file,key,nextByte,ws,sid,nSum,nWord,sumOut,wordOut，无重复 path。
//   · words.jsonl 26577 行，**两种字段形状**：老行 10 字段，新行多一个 role（18427 行）。
//     kind ∈ {human 7995, 结论 18427, task 155}；truncated=true 361 行；另有 167 行
//     truncated=false 但 len ≠ 码点数（len 恰好等于 UTF-16 长度 —— 生产者用的是另一把尺子）。
//     → 这里 len 一律按 charLen(text) 重测并计数（lenRebased），text 一个字符都不改。
//   · summaries.jsonl 370 行 / 305 个 id：45 对逐字节相同的 replay（去重），
//     20 对**同 id 不同 session**（拒绝，不挑一个当权威）。
//   · 三个文件**都不以 LF 结尾**（末行是完整 JSON）→ 末行必须完整可解析可校验；缺 LF 本身不拒，
//     但记进 manifest（finalLf:false）；缺终止符 **且** 末行残缺才是截断写坏的签名（拒）。
//   · srcSeqs 是**帧 seq**（含 tool/thinking 帧），不是 words 的 seq：实测 65857 个引用里只有
//     17801 个能落到 words 上。→ 本适配器按契约要求每个 srcSeq 都落在同一会话的已发射 word 上，
//     不满足即拒；真实索引目前因此会被拒（这是读数，不是 bug —— 见 inspectEchoIndexFeed）。
//
// 两种用途，一个只读一个可写：
//   · inspectEchoIndexFeed(paths)       只读：只看元数据、只出报告，**不建目录、不写文件**。
//     生产索引只能走这一条（它允许仓库之外的路径）。
//   · buildFromEchoIndexFiles(options)  测试/原型写出器：所有输入与 outDir **必须**在 os.tmpdir() 之下。
//
// 游标（可选 cursor）：**只由 files.jsonl 自己声明的 (path, key, nextByte) 决定**。
//   · path 在上一代有、这一代没了        → 拒绝（路径变了）
//   · nextByte 变小                       → 拒绝（回退/截断）
//   · nextByte 不变但 key 变了            → 拒绝（同消费点、不同文件身份 = 轮转）
//   · nextByte 前进                       → append（该源派生的行数只允许增，不许减）
//   · key 与 nextByte 都没变              → unchanged（该源派生的行数必须一模一样，否则拒）
//   · 显式 fullRebuild:true               → 以上连续性检查全部跳过（有意从头再来一代）
export const ECHO_INDEX_FEED_VERSION = 'echo-index-feed/1';

// ── 清单里的两个「版本」，别再混成一个字段 ────────────────────────────────────
//   measure（实测 2026-11-16，读 echo-index-import.mjs）:
//     · importer 校验的是 manifest.echoIndexVersion（validateManifest → ECHO_INDEX_VERSION_RE），
//       并把**校验后的那个值**当成 (path, version) 里的 version 派生 echoSourceId
//       （:682 返回 { version }, :814 echoSourceIdFor(sourcePath, version)）。
//     · importer **从不读**原始 manifest.version —— 这条路径上它既不是格式、也不是身份。
//   所以清单里其实有两个互不相干的东西：
//     · 源身份版本（importer 的 (path, version)）：今天 = echoIndexVersion = ECHO_INDEX_VERSION
//     · 清单格式版本（本模块自己写的这份 JSONL 三件套长什么样）：ECHO_INDEX_FEED_VERSION
//   本模块的 feed 写出器历史上把后者写进 manifest.version，于是下游要拿它当源版本只能**手改清单**
//   （既有证据：tools/echo-index-source-snapshot-import.mjs 先 build、再读回、覆写 version、重写文件）。
//   现在给出显式出口 sourceVersion（见 buildFromEchoIndexFiles）：
//     · 不给 = 旧行为逐字节不变（version 承载清单格式、不发 feedFormat 键）
//     · 给了 = version 承载源身份版本、清单格式单独记进 manifest.feedFormat
//   身份派生一律走 ECHO_INDEX_VERSION（= importer 实际用的那把钥匙），不随这个开关漂。

// 权威索引的**精确字段集**。任何别的形状一律拒（不猜、不容忍）。
export const ECHO_INDEX_WORD_FIELDS = Object.freeze(['t','session','ws','seq','turn','log','kind','len','truncated','text']);
export const ECHO_INDEX_WORD_FIELDS_WITH_ROLE = Object.freeze(['t','session','ws','seq','turn','log','role','kind','len','truncated','text']);
export const ECHO_INDEX_SUMMARY_FIELDS = Object.freeze(['id','t','session','ws','log','srcSeqs','shadowedTokens','chars','provider','model','status','summary','manifest']);
export const ECHO_INDEX_FILE_FIELDS = Object.freeze(['file','key','nextByte','ws','sid','nSum','nWord','sumOut','wordOut']);
// 权威索引的 kind → importer 的 role。表外的 kind（任务/tool/reasoning…）一律排除并计数。
export const ECHO_INDEX_KIND_ROLE = Object.freeze({ human: 'user', '结论': 'assistant' });
// 发射出去的摘要行 = importer 的 12 个字段 + 原样保留的 manifest（importer 存 full_json 原文，额外字段不丢）。
export const ECHO_INDEX_FEED_SUMMARY_FIELDS = Object.freeze([...ECHO_SUMMARY_FIELDS, 'manifest']);
// 权威索引 → importer 的唯一两个改名；其余同名字段逐字复制。
export const ECHO_INDEX_SUMMARY_RENAMES = Object.freeze({ id: 'cmpId', chars: 'shadowedChars' });

// 契约一致性：importer 的字段表必须正好是权威索引字段表（words 多一个 role；summaries 两个改名）。
// ★ 2026-11-15（task49）：摘要这一半改成**先按名字映射出形状，再比字段集**。
//   原先的「每个 importer 字段都能在权威表里查到源名 + 两边长度相等」是绕道：它不说清映射，
//   也认不出「两个源字段被改成同一个目标名」这种有损映射（长度不变、每个都查得到）。
//   现在只有一份显式映射：id → cmpId、chars → shadowedChars；manifest 不改名、**原样透传**
//   （它落在末位，所以映射后的权威形状就是 feed 形状）。字段集按名字比、不比顺序 ——
//   与 assertExactFields 同一把尺子（下游 importer 按字段名取值，不按位置）。
//   任何一处漂移都在 import 这一刻失败，而不是等写进库才发现。
(function assertFeedContract() {
  const wordWithoutRole = ECHO_WORD_FIELDS.filter((f) => f !== 'role');
  if (wordWithoutRole.join(',') !== ECHO_INDEX_WORD_FIELDS.join(',')) {
    fail('importer word contract drifted from the authoritative ECHO index shape: ' + JSON.stringify(wordWithoutRole) + ' vs ' + JSON.stringify(ECHO_INDEX_WORD_FIELDS));
  }
  const renamedSummary = ECHO_INDEX_SUMMARY_FIELDS.map((f) => ECHO_INDEX_SUMMARY_RENAMES[f] || f);
  const feedSummary = [...ECHO_INDEX_FEED_SUMMARY_FIELDS];
  if (renamedSummary.slice().sort().join(',') !== feedSummary.slice().sort().join(',')) {
    fail('importer summary contract drifted from the authoritative ECHO index shape (id->cmpId, chars->shadowedChars, manifest passed through): ' + JSON.stringify(renamedSummary) + ' vs ' + JSON.stringify(feedSummary));
  }
}());

function assertExactFields(obj, allowedFieldSets, where) {
  const keys = Object.keys(obj).sort();
  const got = keys.join(',');
  for (const set of allowedFieldSets) if (set.slice().sort().join(',') === got) return;
  const want = allowedFieldSets.map((s) => '[' + s.join(',') + ']').join(' | ');
  fail(where + ': field set ' + JSON.stringify(keys) + ' is not exactly ' + want + ' (fail-closed: no row shape is guessed)');
}

// 严格 JSONL 读入：无 BOM、严格 UTF-8、无空行、每行是对象且字段集精确。
// 末行缺 LF 且解析/校验不过 = 截断写坏的签名 → 拒；缺 LF 但末行完整 → 收下并记 finalLf:false。
// ★ 空工件（零行）：只有 opts.allowEmpty 才成立，且**两种形态同义** —— 0 字节与单个 LF。
//   它们是「这个工件确实没有行」，不是「跳过某个源」；words/files 这类没有 allowEmpty 的读者照旧拒。
//   非空文件的 BOM / UTF-8 / 空行 / 字段集 / JSON / 末行截断校验**一条都不放松**（下面的顺序不变）。
export function readEchoIndexJsonl(abs, label, allowedFieldSets, opts) {
  const allowEmpty = !!(opts && opts.allowEmpty);
  if (!fs.existsSync(abs)) fail(label + ' does not exist: ' + abs);
  if (!fs.statSync(abs).isFile()) fail(label + ' must be a regular file: ' + abs);
  const bytes = fs.readFileSync(abs);
  // 0 字节：allowEmpty 下的第二种 canonical 空工件 → 零行（finalLf 如实记 false，不假装有终止符）。
  if (bytes.length === 0) {
    if (!allowEmpty) fail(label + ' is empty');
    return { path: abs, bytes: 0, finalLf: false, rows: [] };
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) fail(label + ' must not start with a UTF-8 BOM');
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) fail(label + ' is not valid UTF-8');
  const finalLf = text.endsWith('\n');
  const body = finalLf ? text.slice(0, -1) : text;
  // 纯 '\n' 是 canonical 空工件（零行）；只有 summaries 允许空，files/words 空=没有源。
  const lines = body === '' ? [] : body.split('\n');
  const rows = [];
  for (let i = 0; i < lines.length; i += 1) {
    const where = label + ' line ' + (i + 1);
    const rawLine = lines[i];
    if (!rawLine.trim()) fail(where + ' must be a non-blank JSONL row');
    const lastUnterminated = i === lines.length - 1 && !finalLf;
    let obj;
    try { obj = JSON.parse(rawLine); } catch (err) {
      if (lastUnterminated) fail(where + ': the file does not end with LF and its last row does not parse (' + err.message + '); that is the signature of a truncated write');
      fail(where + ' invalid JSON: ' + err.message);
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) fail(where + ' must be a JSON object');
    assertExactFields(obj, allowedFieldSets, where);
    rows.push({ line: i + 1, raw: rawLine, obj });
  }
  if (rows.length === 0 && !allowEmpty) fail(label + ' has no data rows');
  return { path: abs, bytes: bytes.length, finalLf, rows };
}

// files.jsonl → 每个源一条记录。Windows path identity is separator- and case-insensitive.
function canonicalEchoLogPath(value) {
  if (typeof value !== 'string' || value.length === 0 || !path.isAbsolute(value)) fail('log path must be a non-empty absolute path: ' + JSON.stringify(value));
  const canonical = toPosix(path.resolve(value));
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}
// ★ 导出给 per-source 导入用：那边**不许**再写第二份派生（同一份日志两个 id = 静默的身份分叉）。
export function echoOneLogSourcePath(selectedLogPath) {
  const canonical = canonicalEchoLogPath(selectedLogPath);
  return 'D:/synthetic/echo-one-log/' + sha256(Buffer.from(canonical, 'utf8'));
}
function readEchoIndexFiles(abs) {
  const parsed = readEchoIndexJsonl(abs, 'files.jsonl', [ECHO_INDEX_FILE_FIELDS]);
  const byPath = new Map();
  let totalNextByte = 0;
  for (const row of parsed.rows) {
    const where = 'files.jsonl line ' + row.line;
    const o = row.obj;
    if (typeof o.file !== 'string' || o.file.length === 0) fail(where + ': file must be a non-empty path');
    if (!path.isAbsolute(o.file)) fail(where + ': file must be an absolute path: ' + o.file);
    if (typeof o.key !== 'string' || o.key.length === 0) fail(where + ': key must be a non-empty string');
    if (!Number.isSafeInteger(o.nextByte) || o.nextByte < 0) fail(where + ': nextByte must be a non-negative safe integer (it is the consumed offset, not the file length)');
    if (o.ws !== null && (typeof o.ws !== 'string' || o.ws.length === 0)) fail(where + ': ws must be a non-empty string or null');
    if (typeof o.sid !== 'string' || !SESSION_RE.test(o.sid)) fail(where + ': sid must be ptr-safe ([A-Za-z0-9._-]{1,128})');
    for (const k of ['nSum', 'nWord']) if (!Number.isSafeInteger(o[k]) || o[k] < 0) fail(where + ': ' + k + ' must be a non-negative safe integer');
    for (const k of ['sumOut', 'wordOut']) if (typeof o[k] !== 'string' || o[k].length === 0) fail(where + ': ' + k + ' must be a non-empty path');
    const id = toPosix(path.resolve(o.file));
    if (byPath.has(id)) fail(where + ': source path is declared twice (' + o.file + '); a source identity must stay unique');
    byPath.set(id, { id, file: o.file, key: o.key, nextByte: o.nextByte, ws: o.ws, sid: o.sid, nSum: o.nSum, nWord: o.nWord, line: row.line });
    totalNextByte += o.nextByte;
  }
  return { ...parsed, byPath, totalNextByte };
}

// 权威索引 → { words, summaries, report, refusals }（纯映射；结构性错误直接抛，语义性拒绝收集）。
function collectEchoIndexFeed(options) {
  const o = options || {};
  const files = readEchoIndexFiles(o.filesPath);
  const wordsParsed = readEchoIndexJsonl(o.wordsPath, 'words.jsonl', [ECHO_INDEX_WORD_FIELDS, ECHO_INDEX_WORD_FIELDS_WITH_ROLE]);
  const summariesParsed = readEchoIndexJsonl(o.summariesPath, 'summaries.jsonl', [ECHO_INDEX_SUMMARY_FIELDS], { allowEmpty: true });
  let selected = null;
  const sourceIdentityByRawPath = new Map();
  const rowDiagnostics = { exactDuplicateWords: 0, exactDuplicateSummaries: 0 };
  // selected-log 过滤器的**纯计数**投影（不留路径/会话/行内容）：不改变筛选结果，只把被挡下的行数说清。
  // 四类分开数，因为它们**不是同一种事**：
  //   · missingLog       —— 根本没有 log（选定模式下 keepSelected 直接判 false，静默落下）
  //   · invalidType      —— log 存在但不是字符串（同上，静默落下）
  //   · nonCanonicalLog  —— log 是字符串但归不成规范路径（keepSelected 会抛，构建随之中止；
  //                         单独立桶，免得把「构建中止」说成「静默落下」）
  //   · nonSelectedPath  —— 归得成规范路径，但不是选定源（静默落下）
  const emptySelectionBucket = () => ({ missingLog: 0, invalidType: 0, nonCanonicalLog: 0, nonSelectedPath: 0, rejected: 0 });
  const selectionFilter = { applied: false, words: emptySelectionBucket(), summaries: emptySelectionBucket() };
  if (o.selectedLogPath !== undefined) {
    const selectedCanonical = canonicalEchoLogPath(o.selectedLogPath);
    const declared = files.rows.filter((r) => canonicalEchoLogPath(r.obj.file) === selectedCanonical);
    if (declared.length === 0) fail('selectedLogPath is not declared in files.jsonl: ' + o.selectedLogPath);
    if (declared.length !== 1) fail('selectedLogPath must match exactly one files.jsonl row: ' + o.selectedLogPath + ' (found ' + declared.length + ')');
    const original = files.byPath.get(toPosix(path.resolve(declared[0].obj.file)));
    if (!original) fail('selectedLogPath manifest row could not be resolved to its canonical source');
    const syntheticPath = echoOneLogSourcePath(o.selectedLogPath);
    const selectedSource = { ...original, id: syntheticPath };
    selected = { originalPath: original.file, canonicalPath: selectedCanonical, sourcePath: syntheticPath, source: selectedSource };
    // Synthetic identity keys cursor/source joins; original file path and row.log stay unchanged.
    files.byPath = new Map([[syntheticPath, selectedSource]]);
    sourceIdentityByRawPath.set(selectedCanonical, syntheticPath);
    files.totalNextByte = original.nextByte;
    files.selected = selected;
    const keepSelected = (entry) => {
      const log = entry.obj.log;
      return typeof log === 'string' && canonicalEchoLogPath(log) === selectedCanonical;
    };
    // 紧贴过滤器之前计数：判据与 keepSelected 逐条同义（缺 log / 类型不可归一 / 路径不等），
    // 只是不抛、不留痕 —— 归一化失败仍旧由 keepSelected 自己抛，拒绝语义一字不改。
    const countSelectionRejections = (rows) => {
      const bucket = emptySelectionBucket();
      for (const entry of rows) {
        const log = entry.obj.log;
        if (log === null || log === undefined) { bucket.missingLog += 1; continue; }
        if (typeof log !== 'string') { bucket.invalidType += 1; continue; }
        let canonical = null;
        try { canonical = canonicalEchoLogPath(log); } catch { canonical = null; }
        if (canonical === null) bucket.nonCanonicalLog += 1;
        else if (canonical !== selectedCanonical) bucket.nonSelectedPath += 1;
      }
      bucket.rejected = bucket.missingLog + bucket.invalidType + bucket.nonCanonicalLog + bucket.nonSelectedPath;
      return bucket;
    };
    selectionFilter.applied = true;
    selectionFilter.words = countSelectionRejections(wordsParsed.rows);
    selectionFilter.summaries = countSelectionRejections(summariesParsed.rows);
    wordsParsed.rows = wordsParsed.rows.filter(keepSelected);
    summariesParsed.rows = summariesParsed.rows.filter(keepSelected);
    files.rows = declared;
  }
  const refusals = [];
  const excludedByType = Object.create(null);
  const kinds = Object.create(null);
  const roles = Object.create(null);
  const bump = (bag, key) => { bag[key] = (bag[key] || 0) + 1; };
  let excludedReasoning = 0;
  let truncatedExcluded = 0;
  let lenRebased = 0;
  let exactDuplicateWords = 0;
  let exactDuplicateSummaries = 0;
  const wordBySeq = new Map();
  const summaryById = new Map();
  const wordKey = (sourceId, session, seq) => (selected === null ? '' : sourceId + '\u0000') + session + '\u0000' + String(seq);
  const summaryKeyFor = (sourceId, cmpId) => (selected === null ? '' : sourceId + '\u0000') + cmpId;

  for (const entry of wordsParsed.rows) {
    const where = 'words.jsonl line ' + entry.line;
    const row = entry.obj;
    if (typeof row.t !== 'string' || row.t.length === 0 || !Number.isFinite(Date.parse(row.t))) fail(where + ': t must be a parseable timestamp');
    if (typeof row.session !== 'string' || !SESSION_RE.test(row.session)) fail(where + ': session must be ptr-safe ([A-Za-z0-9._-]{1,128}); log:<sid>#seq must stay resolvable');
    if (row.ws !== null && typeof row.ws !== 'string') fail(where + ': ws must be a string or null');
    if (!Number.isSafeInteger(row.seq) || row.seq < 0) fail(where + ': seq must be a non-negative safe integer');
    if (row.turn !== null && (!Number.isSafeInteger(row.turn) || row.turn < 0)) fail(where + ': turn must be null or a non-negative safe integer');
    if (row.log !== null && typeof row.log !== 'string') fail(where + ': log must be a string or null');
    if (typeof row.kind !== 'string' || row.kind.length === 0) fail(where + ': kind must be a non-empty string');
    if (!Number.isSafeInteger(row.len) || row.len < 0) fail(where + ': len must be a non-negative safe integer');
    if (row.truncated !== true && row.truncated !== false && row.truncated !== 0 && row.truncated !== 1) fail(where + ': truncated must be boolean or 0/1');
    if (typeof row.text !== 'string') fail(where + ': text must be a string');
    const hasRole = Object.prototype.hasOwnProperty.call(row, 'role');
    if (hasRole && (typeof row.role !== 'string' || row.role.length === 0)) fail(where + ': role must be a non-empty string when present');
    const kindRole = ECHO_INDEX_KIND_ROLE[row.kind];
    if (hasRole && kindRole !== undefined && kindRole !== row.role) {
      fail(where + ': role ' + JSON.stringify(row.role) + ' contradicts kind ' + JSON.stringify(row.kind) + '; refusing to pick one of them');
    }
    const role = hasRole ? row.role : kindRole;
    bump(kinds, row.kind);
    if (role !== undefined) bump(roles, role);
    if (isReasoningRow(role, row.kind)) { excludedReasoning += 1; bump(excludedByType, 'reasoning:' + row.kind); continue; }
    if (role !== 'user' && role !== 'assistant') { bump(excludedByType, 'kind:' + row.kind); continue; }
    if (row.truncated === true || row.truncated === 1) { truncatedExcluded += 1; bump(excludedByType, 'truncated:' + row.kind); continue; }
    if (!row.text.trim()) fail(where + ': eligible ' + role + ' row carries blank text; an empty word is not citable and the importer refuses it');
    if (row.log === null) fail(where + ': row declares no log; the source join is pinned by files.jsonl and is never inferred');
    const rawSourceId = toPosix(path.resolve(row.log));
    const sourceId = sourceIdentityByRawPath.get(canonicalEchoLogPath(row.log)) || rawSourceId;
    const source = files.byPath.get(sourceId);
    if (source === undefined) fail(where + ': log ' + JSON.stringify(row.log) + ' has no files.jsonl record (the source join is pinned, never guessed)');
    if (source.sid !== row.session) fail(where + ': session ' + JSON.stringify(row.session) + ' does not match the files.jsonl sid ' + JSON.stringify(source.sid));
    if (source.ws !== null && row.ws !== null && source.ws !== row.ws) fail(where + ': ws ' + JSON.stringify(row.ws) + ' does not match the files.jsonl ws ' + JSON.stringify(source.ws));
    const measured = charLen(row.text);
    if (row.len !== measured) lenRebased += 1;
    const mapped = {
      t: row.t, session: row.session, ws: row.ws, seq: row.seq, turn: row.turn, log: row.log,
      role, kind: row.kind, len: measured, truncated: false, text: row.text,
    };
    const key = wordKey(sourceId, row.session, row.seq);
    const prior = wordBySeq.get(key);
    if (prior !== undefined) {
      if (prior.raw === entry.raw) { exactDuplicateWords += 1; rowDiagnostics.exactDuplicateWords += 1; continue; }
      refusals.push({
        code: 'WORD_SEQ_CONFLICT',
        message: where + ': session+seq ' + row.session + ' #' + row.seq + ' was already declared by words.jsonl line ' + prior.line + ' with different bytes (log:<sid>#seq must stay unambiguous)',
      });
      continue;
    }
    wordContentHash(mapped);
    wordBySeq.set(key, { key, line: entry.line, raw: entry.raw, row: mapped, sourceId });
  }

  for (const entry of summariesParsed.rows) {
    const where = 'summaries.jsonl line ' + entry.line;
    const row = entry.obj;
    if (typeof row.id !== 'string' || !CMP_RE.test(row.id)) fail(where + ': id must be idx-safe ([A-Za-z0-9._-]{1,128})');
    if (typeof row.t !== 'string' || row.t.length === 0 || !Number.isFinite(Date.parse(row.t))) fail(where + ': t must be a parseable timestamp');
    if (typeof row.session !== 'string' || !SESSION_RE.test(row.session)) fail(where + ': session must be ptr-safe');
    for (const k of ['ws', 'log', 'provider', 'model']) if (row[k] !== null && typeof row[k] !== 'string') fail(where + ': ' + k + ' must be a string or null');
    if (!Array.isArray(row.srcSeqs) || row.srcSeqs.some((n) => !Number.isSafeInteger(n) || n < 0)) fail(where + ': srcSeqs must be non-negative safe integers');
    for (const k of ['shadowedTokens', 'chars']) if (!Number.isSafeInteger(row[k]) || row[k] < 0) fail(where + ': ' + k + ' must be a non-negative safe integer');
    if (typeof row.status !== 'string' || !ECHO_SUMMARY_STATUSES.includes(row.status)) fail(where + ': status must be ' + ECHO_SUMMARY_STATUSES.join('|'));
    if (typeof row.summary !== 'string' || row.summary.length === 0) fail(where + ': summary must be a non-empty string');
    if (!row.manifest || typeof row.manifest !== 'object' || Array.isArray(row.manifest)) fail(where + ': manifest must be a JSON object');
    if (row.log === null) fail(where + ': summary declares no log; the source join is pinned by files.jsonl and is never inferred');
    const rawSourceId = toPosix(path.resolve(row.log));
    const sourceId = sourceIdentityByRawPath.get(canonicalEchoLogPath(row.log)) || rawSourceId;
    const source = files.byPath.get(sourceId);
    if (source === undefined) fail(where + ': log ' + JSON.stringify(row.log) + ' has no files.jsonl record (the source join is pinned, never guessed)');
    if (source.sid !== row.session) fail(where + ': session ' + JSON.stringify(row.session) + ' does not match the files.jsonl sid ' + JSON.stringify(source.sid));
    const mapped = {
      cmpId: row.id, t: row.t, session: row.session, ws: row.ws, log: row.log,
      srcSeqs: row.srcSeqs.slice(), shadowedTokens: row.shadowedTokens, shadowedChars: row.chars,
      provider: row.provider, model: row.model, status: row.status, summary: row.summary,
      manifest: row.manifest,
    };
    const summaryKey = summaryKeyFor(sourceId, mapped.cmpId);
    const prior = summaryById.get(summaryKey);
    if (prior !== undefined) {
      if (prior.raw === entry.raw) { exactDuplicateSummaries += 1; rowDiagnostics.exactDuplicateSummaries += 1; continue; }
      refusals.push({
        code: 'SUMMARY_ID_CONFLICT',
        message: where + ': id ' + mapped.cmpId + ' was already declared by summaries.jsonl line ' + prior.line + ' with different bytes (an id must name exactly one summary)',
      });
      continue;
    }
    summaryById.set(summaryKey, { cmpId: mapped.cmpId, line: entry.line, raw: entry.raw, row: mapped, sourceId });
  }

  // srcSeq 引用：只认**本次已发射、同一会话**的 word。不推断、不跳过、不删声明。
  let srcSeqRefs = 0;
  let danglingCount = 0;
  const danglingSample = [];
  for (const entry of summaryById.values()) {
    for (const seq of entry.row.srcSeqs) {
      srcSeqRefs += 1;
      if (!wordBySeq.has(wordKey(entry.sourceId, entry.row.session, seq))) {
        danglingCount += 1;
        if (danglingSample.length < 8) danglingSample.push(entry.cmpId + '#' + seq);
      }
    }
  }
  const danglingRefs = [];
  for (const entry of summaryById.values()) {
    for (let ord = 0; ord < entry.row.srcSeqs.length; ord += 1) {
      const seq = entry.row.srcSeqs[ord];
      if (!wordBySeq.has(wordKey(entry.sourceId, entry.row.session, seq))) {
        danglingRefs.push({ cmpId: entry.cmpId, session: entry.row.session, ord, seq });
      }
    }
  }
  if (danglingCount > 0 && o.allowDanglingSrcSeq !== true) {
    refusals.push({
      code: 'SRC_SEQ_DANGLING',
      message: danglingCount + ' of ' + srcSeqRefs + ' declared srcSeq(s) do not resolve to an emitted word in the same session (first: ' + danglingSample.join(', ') + '); srcSeqs are never inferred, dropped or re-pointed',
      detail: { refs: srcSeqRefs, resolved: srcSeqRefs - danglingCount, dangling: danglingCount, sample: danglingSample },
    });
  }
  const danglingReport = {
    refs: srcSeqRefs,
    resolved: srcSeqRefs - danglingCount,
    dangling: danglingCount,
    sample: danglingRefs.slice(0, 32),
  };

  const words = [...wordBySeq.values()].sort((a, b) => (a.row.session < b.row.session ? -1 : a.row.session > b.row.session ? 1 : a.row.seq - b.row.seq)).map((e) => e.row);
  const summaries = [...summaryById.values()].sort((a, b) => {
    if (a.row.session !== b.row.session) return a.row.session < b.row.session ? -1 : 1;
    if (a.row.t !== b.row.t) return a.row.t < b.row.t ? -1 : 1;
    return a.row.cmpId < b.row.cmpId ? -1 : a.row.cmpId > b.row.cmpId ? 1 : 0;
  }).map((e) => e.row);

  const perSource = new Map();
  for (const entry of wordBySeq.values()) {
    if (!perSource.has(entry.sourceId)) perSource.set(entry.sourceId, { words: 0, summaries: 0 });
    perSource.get(entry.sourceId).words += 1;
  }
  for (const entry of summaryById.values()) {
    if (!perSource.has(entry.sourceId)) perSource.set(entry.sourceId, { words: 0, summaries: 0 });
    perSource.get(entry.sourceId).summaries += 1;
  }

  const report = {
    files: { path: files.path, bytes: files.bytes, rows: files.rows.length, finalLf: files.finalLf, sources: files.byPath.size, totalNextByte: files.totalNextByte },
    selectedSource: selected ? { originalLogPath: selected.originalPath, sourcePath: selected.sourcePath, pointerLimitation: 'log:<sid>#seq does not encode source identity; collisions across sources remain AMBIGUOUS' } : null,
    summaryRefs: selected ? danglingReport : null,
    selectionFilter: { applied: selectionFilter.applied, words: { ...selectionFilter.words }, summaries: { ...selectionFilter.summaries } },
    pointerLimitations: selected ? ['log:<sid>#seq cannot distinguish sources that share session+seq; resolver ambiguity is preserved and no frame anchors are synthesized'] : [],
    words: {
      path: wordsParsed.path, bytes: wordsParsed.bytes, rows: wordsParsed.rows.length, finalLf: wordsParsed.finalLf,
      fieldSets: [ECHO_INDEX_WORD_FIELDS, ECHO_INDEX_WORD_FIELDS_WITH_ROLE].map((s) => ({ fields: s.slice(), rows: wordsParsed.rows.filter((r) => s.slice().sort().join(',') === Object.keys(r.obj).sort().join(',')).length })),
      kinds: { ...kinds }, roles: { ...roles },
      emitted: words.length, excludedByType: { ...excludedByType }, excludedReasoning,
      truncatedExcluded, lenRebased, exactDuplicateWords,
      sessions: new Set(words.map((w) => w.session)).size,
    },
    summaries: {
      path: summariesParsed.path, bytes: summariesParsed.bytes, rows: summariesParsed.rows.length, finalLf: summariesParsed.finalLf,
      emitted: summaries.length, distinctIds: summaryById.size + refusals.filter((r) => r.code === 'SUMMARY_ID_CONFLICT').length,
      exactDuplicateSummaries, conflictingIds: refusals.filter((r) => r.code === 'SUMMARY_ID_CONFLICT').length,
      srcSeqRefs, srcSeqDangling: danglingCount,
      srcSeqResolved: srcSeqRefs - danglingCount,
    },
    perSource: Object.fromEntries([...perSource.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))),
  };
  return { files, wordsParsed, summariesParsed, words, summaries, report, refusals };
}

// 只读体检：**只出报告，不建目录、不写文件**。生产索引只允许走这一条。
export function inspectEchoIndexFeed(options) {
  const o = options || {};
  const paths = {};
  for (const k of ['filesPath', 'wordsPath', 'summariesPath']) {
    if (typeof o[k] !== 'string' || o[k].length === 0) fail('missing explicit option ' + k);
    paths[k] = requireAbsolutePath(o[k], k);
  }
  const collected = collectEchoIndexFeed(paths);
  const refused = collected.refusals.map((r) => ({ code: r.code, message: r.message }));
  return {
    ok: true,
    readOnly: true,
    version: ECHO_INDEX_FEED_VERSION,
    inputs: Object.fromEntries(Object.entries(paths)),
    files: collected.report.files,
    words: collected.report.words,
    summaries: collected.report.summaries,
    perSource: collected.report.perSource,
    wouldBuild: { allowed: refused.length === 0, refusals: refused, words: collected.words.length, summaries: collected.summaries.length },
  };
}

// 游标校验：形状不对一律拒（不修、不补默认值）。
function readFeedCursor(cursor) {
  if (cursor === undefined || cursor === null) return null;
  if (typeof cursor !== 'object' || Array.isArray(cursor)) fail('cursor must be a JSON object');
  if (cursor.version !== ECHO_INDEX_FEED_VERSION) fail('cursor.version must be ' + ECHO_INDEX_FEED_VERSION + ' (got ' + JSON.stringify(cursor.version) + '); this cursor was not written by this builder');
  if (!Number.isSafeInteger(cursor.generation) || cursor.generation < 1) fail('cursor.generation must be a positive safe integer');
  const files = cursor.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) fail('cursor.files must be an object keyed by source path');
  const out = new Map();
  for (const [p, entry] of Object.entries(files)) {
    if (!p) fail('cursor.files holds an empty source path');
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('cursor.files[' + p + '] must be an object');
    if (typeof entry.key !== 'string' || entry.key.length === 0) fail('cursor.files[' + p + '].key must be a non-empty string');
    if (!Number.isSafeInteger(entry.nextByte) || entry.nextByte < 0) fail('cursor.files[' + p + '].nextByte must be a non-negative safe integer');
    for (const k of ['words', 'summaries']) if (!Number.isSafeInteger(entry[k]) || entry[k] < 0) fail('cursor.files[' + p + '].' + k + ' must be a non-negative safe integer');
    out.set(p, { key: entry.key, nextByte: entry.nextByte, words: entry.words, summaries: entry.summaries });
  }
  return { version: cursor.version, generation: cursor.generation, files: out };
}

export function buildFromEchoIndexFiles(options) {
  const o = options || {};
  for (const k of ['filesPath', 'wordsPath', 'summariesPath', 'namespace', 'generation', 'builtAt', 'outDir']) {
    if (o[k] === undefined || o[k] === null || o[k] === '') fail('missing explicit option ' + k);
  }
  let sourcePath = o.sourcePath;
  if (o.selectedLogPath !== undefined) {
    const derivedSourcePath = echoOneLogSourcePath(o.selectedLogPath);
    if (sourcePath !== undefined && sourcePath !== derivedSourcePath) fail('sourcePath for selectedLogPath must equal its deterministic per-log identity: ' + derivedSourcePath);
    sourcePath = derivedSourcePath;
  } else if (sourcePath === undefined || sourcePath === null || sourcePath === '') fail('missing explicit option sourcePath');
  if (!sourcePathOk(sourcePath)) fail('sourcePath must be canonical absolute posix path without dot segments');
  if (!['log', 'v4log'].includes(o.namespace)) fail('namespace must be log|v4log');
  if (!Number.isSafeInteger(o.generation) || o.generation < 1) fail('generation must be safe integer >=1');
  if (typeof o.builtAt !== 'string' || !Number.isFinite(Date.parse(o.builtAt))) fail('builtAt must be parseable timestamp');
  const fullRebuild = o.fullRebuild === undefined ? false : o.fullRebuild;
  if (typeof fullRebuild !== 'boolean') fail('fullRebuild must be a boolean when provided');
  const allowDanglingSrcSeq = o.allowDanglingSrcSeq === undefined ? false : o.allowDanglingSrcSeq;
  if (typeof allowDanglingSrcSeq !== 'boolean') fail('allowDanglingSrcSeq must be a boolean when provided');
  const allowReadOnlyExternalInputs = o.allowReadOnlyExternalInputs === undefined ? false : o.allowReadOnlyExternalInputs;
  if (typeof allowReadOnlyExternalInputs !== 'boolean') fail('allowReadOnlyExternalInputs must be a boolean');
  if (allowReadOnlyExternalInputs && o.selectedLogPath === undefined) fail('allowReadOnlyExternalInputs is valid only with an explicit selectedLogPath');
  const cursor = readFeedCursor(o.cursor);
  // ★ 源身份版本的显式出口（见 ECHO_INDEX_FEED_VERSION 旁的说明）。
  //   undefined = 旧行为；给了就必须是 importer 认识的那个形状（regex 来自 importer，不在这里抄第二份）。
  const sourceVersionGiven = o.sourceVersion !== undefined;
  if (sourceVersionGiven) {
    if (o.sourceVersion === null || typeof o.sourceVersion !== 'string' || o.sourceVersion.length === 0) {
      fail('sourceVersion must be a non-empty string when provided (omit it to keep manifest.version = ' + ECHO_INDEX_FEED_VERSION + ')');
    }
    if (!ECHO_INDEX_VERSION_RE.test(o.sourceVersion)) {
      fail('sourceVersion must match the importer source-version shape ' + String(ECHO_INDEX_VERSION_RE) + ' (got ' + JSON.stringify(o.sourceVersion) + '); the importer derives echo_source_id from it');
    }
    // ★ 为什么钉死成 ECHO_INDEX_VERSION 而不是「随便给」：importer 存进库的 source_version
    //   来自 manifest.echoIndexVersion（本模块恒发 ECHO_INDEX_VERSION），**不是** manifest.version。
    //   让 manifest.version 记一个别于它的值，清单就会声称一个库永远不会记录的源身份 ——
    //   那正是「静默的身份分叉」。要真的换身份版本，得同时改 echoIndexVersion 与行形状，
    //   那是 schema/importer 层的事，不在这条 builder-only 的口子里悄悄做。
    if (o.sourceVersion !== ECHO_INDEX_VERSION) {
      fail('sourceVersion must equal ' + JSON.stringify(ECHO_INDEX_VERSION) + ' (got ' + JSON.stringify(o.sourceVersion) + '): the importer records manifest.echoIndexVersion as echo_index_sources.source_version, so a different manifest.version would claim a source identity the import path never stores; changing the identity version needs a schema/importer decision, not a builder flag');
    }
  }

  const outDir = requireAbsolutePath(o.outDir, 'outDir');
  const inputs = {
    filesPath: requireAbsolutePath(o.filesPath, 'filesPath'),
    wordsPath: requireAbsolutePath(o.wordsPath, 'wordsPath'),
    summariesPath: requireAbsolutePath(o.summariesPath, 'summariesPath'),
  };
  // 本阶段唯一允许的落点与来源：OS 临时目录之内。生产索引在这里连读都读不到（那句由这条判据挡）。
  const realTemp = fs.existsSync(os.tmpdir()) ? fs.realpathSync(os.tmpdir()) : path.resolve(os.tmpdir());
  const tempForms = [realTemp, path.resolve(os.tmpdir())];
  const underTemp = (p) => tempForms.some((t) => isSameOrWithin(t, p));
  const externalRoot = 'D:/AI/memory/hub/index';
  const externalExpected = {
    filesPath: externalRoot + '/files.jsonl',
    wordsPath: externalRoot + '/words.jsonl',
    summariesPath: externalRoot + '/summaries.jsonl',
  };
  const canonicalCompare = (p) => toPosix(path.resolve(p)).toLowerCase();
  const authorizedProductionRoot = 'D:/AI/memory/hub/index';
  const authorizedProductionInputs = {
    filesPath: authorizedProductionRoot + '/files.jsonl',
    wordsPath: authorizedProductionRoot + '/words.jsonl',
    summariesPath: authorizedProductionRoot + '/summaries.jsonl',
  };
  const canonicalPathCompare = (value) => toPosix(path.resolve(value)).toLowerCase();
  for (const [label, p] of Object.entries(inputs)) {
    if (!fs.existsSync(p)) fail(label + ' does not exist: ' + p);
    const real = fs.realpathSync(p);
    if (allowReadOnlyExternalInputs) {
      const expected = externalExpected[label];
      if (canonicalCompare(p) !== expected.toLowerCase() || canonicalCompare(real) !== expected.toLowerCase()) {
        fail(label + ' external read is restricted to exact authorized path ' + expected + ' (symlink/path aliases are rejected)');
      }
    } else if (!underTemp(real)) {
      fail(label + ' must live under the OS temporary directory unless allowReadOnlyExternalInputs is explicitly enabled for the three authorized selected-log inputs: ' + real);
    }
  }
  const outReal = fs.existsSync(outDir) ? fs.realpathSync(outDir) : path.resolve(outDir);
  if (!underTemp(outReal)) fail('outDir must live under the OS temporary directory for this test/prototype writer: ' + outReal);
  if (fs.existsSync(outDir)) {
    if (!fs.statSync(outDir).isDirectory()) fail('outDir must be a directory: ' + outDir);
    if (fs.readdirSync(outDir).length > 0) fail('outDir must be absent or empty (each generation gets its own directory): ' + outDir);
  }
  for (const [label, p] of Object.entries(inputs)) {
    if (isSameOrWithin(outReal, fs.realpathSync(p))) fail(label + ' must not live inside outDir (the output triplet is written as one group): ' + p);
  }
  if (toPosix(path.resolve(sourcePath)) === toPosix(outReal)) fail('sourcePath collides with the output directory: ' + sourcePath);

  const collected = collectEchoIndexFeed({ ...inputs, selectedLogPath: o.selectedLogPath, allowDanglingSrcSeq });
  if (o.selectedLogPath !== undefined && collected.report.selectedSource && sourcePath !== collected.report.selectedSource.sourcePath) {
    fail('sourcePath for selectedLogPath must equal its deterministic per-log identity: ' + collected.report.selectedSource.sourcePath);
  }
  if (o.selectedLogPath !== undefined) sourcePath = collected.report.selectedSource.sourcePath;
  if (collected.refusals.length > 0) {
    const first = collected.refusals[0];
    const more = collected.refusals.length > 1 ? ' (+' + (collected.refusals.length - 1) + ' more refusal(s))' : '';
    const error = new Error('refusing to build from the authoritative ECHO index: ' + first.code + ': ' + first.message + more);
    error.srcSeqCounts = first.code === 'SRC_SEQ_DANGLING' && first.detail
      ? { refs: first.detail.refs, resolved: first.detail.resolved, dangling: first.detail.dangling }
      : null;
    throw error;
  }
  if (collected.words.length === 0) fail('the authoritative ECHO index produced no user/assistant rows for the selected sources; refusing to emit an empty generation');

  // 游标连续性（只由 files.jsonl 自己声明的 (path, key, nextByte) 决定）。
  const modes = new Map();
  const stateFiles = Object.create(null);
  const sourceReport = [];
  const priorFiles = cursor === null ? new Map() : cursor.files;
  if (cursor !== null) {
    if (o.generation !== cursor.generation + 1) fail('generation must be exactly the cursor generation + 1 (' + (cursor.generation + 1) + '), got ' + o.generation + '; generations advance one step at a time');
    for (const pathId of priorFiles.keys()) {
      if (!collected.files.byPath.has(pathId)) fail('source path ' + pathId + ' was consumed by the previous generation but is no longer declared by files.jsonl; a source path change is refused (pass fullRebuild:true to rebuild on purpose)');
    }
  }
  let skippedUnchanged = 0;
  let appended = 0;
  let fresh = 0;
  for (const [pathId, source] of collected.files.byPath) {
    const derived = collected.report.perSource[pathId] || { words: 0, summaries: 0 };
    const prior = priorFiles.get(pathId);
    let mode;
    if (fullRebuild) mode = 'full-rebuild';
    else if (prior === undefined) mode = cursor === null ? 'full' : 'new';
    else if (source.nextByte < prior.nextByte) {
      fail('source ' + pathId + ' rolled back (nextByte ' + prior.nextByte + ' -> ' + source.nextByte + '); refusing to re-read under a consumed offset (pass fullRebuild:true to rebuild on purpose)');
    } else if (source.nextByte === prior.nextByte && source.key !== prior.key) {
      fail('source ' + pathId + ' was rotated under the same consumed offset (key ' + prior.key + ' -> ' + source.key + '); refusing (pass fullRebuild:true to rebuild on purpose)');
    } else if (source.nextByte === prior.nextByte) {
      if (derived.words !== prior.words || derived.summaries !== prior.summaries) {
        fail('the index declares source ' + pathId + ' unchanged but its derived rows moved (' + prior.words + '/' + prior.summaries + ' -> ' + derived.words + '/' + derived.summaries + '); refusing to call that an unchanged source');
      }
      mode = 'unchanged'; skippedUnchanged += 1;
    } else {
      if (derived.words < prior.words || derived.summaries < prior.summaries) {
        fail('source ' + pathId + ' advanced its consumed offset but lost rows (' + prior.words + '/' + prior.summaries + ' -> ' + derived.words + '/' + derived.summaries + '); an append never shrinks');
      }
      mode = 'append'; appended += 1;
    }
    if (mode === 'new' || mode === 'full' || mode === 'full-rebuild') fresh += 1;
    modes.set(pathId, mode);
    stateFiles[pathId] = { key: source.key, nextByte: source.nextByte, sid: source.sid, ws: source.ws, words: derived.words, summaries: derived.summaries, mode };
    sourceReport.push({ path: pathId, sid: source.sid, mode, nextByte: source.nextByte, key: source.key, words: derived.words, summaries: derived.summaries });
  }

  const wordsBytes = Buffer.from(collected.words.map((w) => canonicalWordLine(w)).join('\n') + '\n', 'utf8');
  const summariesBytes = collected.summaries.length === 0
    ? Buffer.from('\n', 'utf8')
    : Buffer.from(collected.summaries.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8');

  const maxSeq = Math.max(...collected.words.map((w) => w.seq));
  const snapshot = Object.keys(stateFiles).sort().map((f) => ({ file: f, key: stateFiles[f].key, nextByte: stateFiles[f].nextByte }));
  const snapshotSha = sha256(Buffer.from(JSON.stringify(snapshot), 'utf8'));
  const feedCursor = { version: ECHO_INDEX_FEED_VERSION, generation: o.generation, files: stateFiles };
  let srcSeqRefs = 0;
  for (const s of collected.summaries) srcSeqRefs += s.srcSeqs.length;

  // ★ 键序是刻意的：不给 sourceVersion 时这里展开出且仅展开出 { version }，
  //   与改动前逐字节一致（旧调用方与既有 selftest 的清单哈希都不许漂）。
  const manifestVersionBlock = sourceVersionGiven
    ? { version: o.sourceVersion, feedFormat: ECHO_INDEX_FEED_VERSION }
    : { version: ECHO_INDEX_FEED_VERSION };
  const manifest = {
    echoIndexVersion: ECHO_INDEX_VERSION,
    sourcePath,
    ...manifestVersionBlock,
    namespace: o.namespace,
    generation: o.generation,
    builtAt: new Date(Date.parse(o.builtAt)).toISOString(),
    cursor: {
      seq: maxSeq,
      inputSha256: snapshotSha,
      inputBytes: collected.files.totalNextByte,
      feed: feedCursor,
    },
    words: { path: 'words.jsonl', sha256: sha256(wordsBytes), bytes: wordsBytes.length, rows: collected.words.length },
    summaries: { path: 'summaries.jsonl', sha256: sha256(summariesBytes), bytes: summariesBytes.length, rows: collected.summaries.length },
    counts: {
      words: collected.words.length,
      summaries: collected.summaries.length,
      srcSeqs: srcSeqRefs,
      excludedReasoning: collected.report.words.excludedReasoning,
      files: collected.files.byPath.size,
      wordRows: collected.report.words.rows,
      summaryRows: collected.report.summaries.rows,
      excluded: Object.values(collected.report.words.excludedByType).reduce((a, n) => a + n, 0),
      excludedByType: collected.report.words.excludedByType,
      truncatedExcluded: collected.report.words.truncatedExcluded,
      lenRebased: collected.report.words.lenRebased,
      exactDuplicateWords: collected.report.words.exactDuplicateWords,
      exactDuplicateSummaries: collected.report.summaries.exactDuplicateSummaries,
      skippedUnchanged, appended, fresh, fullRebuild,
      srcSeqResolved: collected.report.summaries.srcSeqResolved,
      srcSeqDangling: collected.report.summaries.srcSeqDangling,
      selectionFilter: {
        applied: collected.report.selectionFilter.applied,
        words: { ...collected.report.selectionFilter.words },
        summaries: { ...collected.report.selectionFilter.summaries },
      },
    },
    summaryRefs: collected.report.summaryRefs,
    pointerLimitations: collected.report.pointerLimitations,
    sourceInput: {
      kind: 'echo-index-feed',
      selectedLog: collected.report.selectedSource,
      version: ECHO_INDEX_FEED_VERSION,
      files: { rows: collected.files.rows.length, bytes: collected.files.bytes, finalLf: collected.files.finalLf, sha256: sha256(fs.readFileSync(inputs.filesPath)) },
      words: { rows: collected.report.words.rows, bytes: collected.report.words.bytes, finalLf: collected.report.words.finalLf, sha256: sha256(fs.readFileSync(inputs.wordsPath)) },
      summaries: { rows: collected.report.summaries.rows, bytes: collected.report.summaries.bytes, finalLf: collected.report.summaries.finalLf, sha256: sha256(fs.readFileSync(inputs.summariesPath)) },
      totalNextByte: collected.files.totalNextByte,
      fullRebuild,
    },
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  const paths = writeOutputTriplet(outDir, wordsBytes, summariesBytes, manifestBytes);
  return {
    manifestPath: paths.manifestPath, manifestSha256: sha256(manifestBytes), manifest,
    wordsPath: paths.wordsPath, summariesPath: paths.summariesPath,
    generation: o.generation,
    sourcePath,
    cursor: feedCursor,
    sources: sourceReport,
    counts: manifest.counts,
    // 调用方要断言「这份清单会被导成哪个源」不必自己猜：给出与 importer 同一条算式的结果。
    //   importer 用的是 manifest.echoIndexVersion（恒为 ECHO_INDEX_VERSION），不是 manifest.version。
    sourceIdentity: {
      sourcePath,
      sourceVersion: ECHO_INDEX_VERSION,
      echoSourceId: echoSourceIdFor(sourcePath, ECHO_INDEX_VERSION),
      feedFormat: ECHO_INDEX_FEED_VERSION,
      manifestVersionField: manifest.version,
    },
  };
}

if(process.argv[1] && path.resolve(process.argv[1])===path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:'))) {
  try {
    const a=parseArgs(process.argv.slice(2));
    const r = a['--db'] !== undefined
      ? buildFromMetaSqlite({dbPath:a['--db'],sourceId:a['--source-id'],outDir:a['--out-dir'],sourcePath:a['--source-path'],namespace:a['--namespace'],generation:Number(a['--generation']),builtAt:a['--built-at'],cursorSeq:a['--cursor-seq']===undefined?undefined:Number(a['--cursor-seq'])})
      : buildSource({input:a['--input'],summariesPath:a['--summaries'],outDir:a['--out-dir'],sourcePath:a['--source-path'],namespace:a['--namespace'],generation:Number(a['--generation']),builtAt:a['--built-at'],cursorSeq:Number(a['--cursor-seq'])});
    console.log(JSON.stringify({ok:true,manifest:r.manifestPath,sha256:r.manifestSha256,counts:r.manifest.counts,version:r.manifest.version},null,2));
  }
  catch(e){ console.error('echo-source-build: '+(e&&e.message||e)); process.exitCode=2; }
}
