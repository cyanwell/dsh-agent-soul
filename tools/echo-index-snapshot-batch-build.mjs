#!/usr/bin/env node
// ECHO snapshot batch builder (T-SNAP-2).
//
// 输入：调用方显式给出的**一份完整冻结快照根**（--snapshot-root，无默认值；本工具不含任何
// 生产路径常量）。快照的契约就是 tools/echo-index-freeze.mjs 的产物：manifest.json（含
// snapshotDigest 与逐文件 sha256/bytes）+ 逐字节复制过来的 .jsonl。
//
// 顺序是硬的，不靠自律：
//   ① 读 manifest.json，按同样的规则重算 snapshotDigest，比对 fileCount/totalBytes；
//   ② 逐个文件重算 sha256 与 size，全部对上之后才允许读 files.jsonl；
//   ③ files.jsonl 的每一行 = 一个源；把该源的两个分片**再验一次哈希**后读字节；
//   ④ 只把 wordOut/sumOut 两个指针改写成 TEMP 内唯一分片路径，其余字段原样；
//      每源独立目录，调用 buildFromEchoIndexFiles(selectedLogPath) 构建；
//   ⑤ 每源三态：built / skippedEmpty / refused。built+skippedEmpty+refused === sourceRows。
//
// 为什么重复分片声明要全局失败（fail closed）：冻结快照是**覆盖后**的字节。两个源声明同一对
// (wordOut,sumOut) 说明生产侧一个写了另一个，后者盖掉了前者 —— 快照里只剩一份分片，谁的、
// 少了多少，**都不可能从快照里推断或修复**。所以不合并、不猜测、不跳过：整批拒绝。
//
// 不打开：数据库（无连接、无 sqlite 文件）、会话日志、02-墨、生产索引、网络、模型、服务。
// 唯一的模块级副作用是 import 了 echo-source-build.mjs（构建器就在那里），它自带的 engine
// 导入只是模块装载，本工具从不创建连接。
//
// ── 输出里的「不落地」判据 ────────────────────────────────────────────────
// 报告与 batch-manifest 只出现：位置 ID（src-0000，由 digest 钉住的 files.jsonl 行序决定）、
// 固定码表里的拒绝码、计数、sha256、相对 out 的产物名。**不出现**源日志路径、分片路径、
// 行文本。逐源 manifest 是构建器自己的产物（里面按 ECHO 格式带 log 字段），留在 TEMP 里。
//
// ── 退出码 ───────────────────────────────────────────────────────────────
//   0 全部 built/skippedEmpty 且全局派生 feed 已产出
//   2 用法   3 拒绝（快照校验/重复声明/有 refused 源/全局冲突）   4 IO
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildFromEchoIndexFiles, ECHO_INDEX_FILE_FIELDS } from './echo-source-build.mjs';
import { computeSnapshotDigest, FORMAT as SNAPSHOT_FORMAT } from './echo-index-freeze.mjs';

export const FORMAT = 'echo-index-snapshot-batch/1';
export const GLOBAL_FEED_FORMAT = 'echo-index-snapshot-batch/1-global-feed';
export const USAGE = 'usage: echo-index-snapshot-batch-build.mjs --snapshot-root <dir> --out <dir> [--built-at <ISO>]';
const LOCK_NAME = '.batch-build.lock';
const MAX_SOURCES = 20000;
const SHA_RE = /^[0-9a-f]{64}$/;
const SID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const ROLE_VALUES = new Set(['files', 'words', 'summaries', 'shard']);
const IS_WIN = process.platform === 'win32';

export class BatchError extends Error {
  constructor(code, message, exitCode = 3) {
    super(message);
    this.name = 'BatchError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const norm = (p) => path.resolve(p).replace(/\\/g, '/').replace(/(.)\/+$/, '$1');
const ci = (s) => (IS_WIN ? s.toLowerCase() : s);
const toPosixRel = (rel) => rel.split(path.sep).join('/');

function insideStrict(childAbs, parentAbs) {
  const c = ci(norm(childAbs));
  const p = ci(norm(parentAbs));
  if (c === p) return false;
  return c.startsWith(p.endsWith('/') ? p : p + '/');
}
function realOf(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const want = { 'snapshot-root': 'snapshotRoot', out: 'out', 'built-at': 'builtAt' };
  const got = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (!arg.startsWith('--')) throw new BatchError('E_USAGE', USAGE, 2);
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const key = want[name];
    if (!key) throw new BatchError('E_UNKNOWN_ARG', 'unknown argument: --' + name, 2);
    let value;
    if (eq === -1) {
      if (i + 1 >= argv.length) throw new BatchError('E_USAGE', 'missing value for --' + name, 2);
      value = argv[i + 1];
      i += 1;
    } else {
      value = arg.slice(eq + 1);
    }
    if (value === '') throw new BatchError('E_USAGE', 'empty value for --' + name, 2);
    if (got[key] !== undefined) throw new BatchError('E_USAGE', 'duplicate --' + name, 2);
    got[key] = value;
  }
  if (got.snapshotRoot === undefined) throw new BatchError('E_USAGE', 'missing required --snapshot-root (this tool has no default source)', 2);
  if (got.out === undefined) throw new BatchError('E_USAGE', 'missing required --out', 2);
  let builtAt = null;
  if (got.builtAt !== undefined) {
    if (!Number.isFinite(Date.parse(got.builtAt))) throw new BatchError('E_USAGE', '--built-at must be a parseable timestamp', 2);
    builtAt = new Date(Date.parse(got.builtAt)).toISOString();
  }
  return { snapshotRoot: got.snapshotRoot, out: got.out, builtAt };
}

function resolveSnapshotRoot(rawRoot) {
  const given = norm(rawRoot);
  let st;
  try {
    st = fs.statSync(given);
  } catch {
    throw new BatchError('E_SNAPSHOT_ROOT_MISSING', '--snapshot-root does not exist');
  }
  if (!st.isDirectory()) throw new BatchError('E_SNAPSHOT_ROOT_NOT_DIR', '--snapshot-root is not a directory', 2);
  const real = realOf(given);
  if (real === null) throw new BatchError('E_SNAPSHOT_ROOT_UNREADABLE', '--snapshot-root is not readable', 4);
  if (ci(norm(real)) !== ci(given)) throw new BatchError('E_SNAPSHOT_ROOT_SYMLINK', '--snapshot-root resolves through a symlink or junction');
  return { abs: given, real };
}

// ---- 快照校验：manifest 先自洽，再逐文件对字节 -------------------------------------
function readSnapshotManifest(snapshotAbs) {
  const manifestPath = path.join(snapshotAbs, 'manifest.json');
  let bytes;
  try {
    bytes = fs.readFileSync(manifestPath);
  } catch {
    throw new BatchError('E_SNAPSHOT_MANIFEST_MISSING', 'snapshot manifest.json is not readable');
  }
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new BatchError('E_SNAPSHOT_MANIFEST_INVALID', 'snapshot manifest.json is not valid JSON');
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new BatchError('E_SNAPSHOT_MANIFEST_INVALID', 'snapshot manifest.json is not an object');
  if (manifest.format !== SNAPSHOT_FORMAT) throw new BatchError('E_SNAPSHOT_FORMAT', 'snapshot manifest format is not ' + SNAPSHOT_FORMAT);
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new BatchError('E_SNAPSHOT_MANIFEST_INVALID', 'snapshot manifest declares no files');
  if (typeof manifest.snapshotDigest !== 'string' || !SHA_RE.test(manifest.snapshotDigest)) throw new BatchError('E_SNAPSHOT_MANIFEST_INVALID', 'snapshot manifest carries no usable snapshotDigest');
  if (manifest.fileCount !== manifest.files.length) throw new BatchError('E_SNAPSHOT_MANIFEST_INVALID', 'snapshot manifest fileCount does not match its file list');
  const records = [];
  const byRel = new Map();
  let totalBytes = 0;
  for (let i = 0; i < manifest.files.length; i += 1) {
    const r = manifest.files[i];
    const where = 'snapshot manifest file ' + (i + 1);
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new BatchError('E_SNAPSHOT_MANIFEST_INVALID', where + ' is not an object');
    if (typeof r.path !== 'string' || r.path === '') throw new BatchError('E_SNAPSHOT_MANIFEST_INVALID', where + ' has no path');
    if (r.path.includes('\\')) throw new BatchError('E_SNAPSHOT_MANIFEST_INVALID', where + ' path is not posix');
    if (path.posix.isAbsolute(r.path)) throw new BatchError('E_SNAPSHOT_MANIFEST_INVALID', where + ' path is absolute');
    const segs = r.path.split('/');
    if (segs.some((s) => s === '' || s === '.' || s === '..')) throw new BatchError('E_SNAPSHOT_MANIFEST_INVALID', where + ' path has an unusable segment');
    if (typeof r.sha256 !== 'string' || !SHA_RE.test(r.sha256)) throw new BatchError('E_SNAPSHOT_MANIFEST_INVALID', where + ' has no usable sha256');
    if (!Number.isSafeInteger(r.bytes) || r.bytes < 0) throw new BatchError('E_SNAPSHOT_MANIFEST_INVALID', where + ' has no usable byte count');
    if (!ROLE_VALUES.has(r.role)) throw new BatchError('E_SNAPSHOT_MANIFEST_INVALID', where + ' has an unknown role');
    if (byRel.has(r.path)) throw new BatchError('E_SNAPSHOT_MANIFEST_INVALID', where + ' repeats a path already declared');
    const record = { path: r.path, role: r.role, sha256: r.sha256, bytes: r.bytes };
    records.push(record);
    byRel.set(r.path, record);
    totalBytes += r.bytes;
  }
  if (manifest.totalBytes !== totalBytes) throw new BatchError('E_SNAPSHOT_MANIFEST_INVALID', 'snapshot manifest totalBytes does not match its file list');
  const recomputed = computeSnapshotDigest(records);
  if (recomputed !== manifest.snapshotDigest) throw new BatchError('E_SNAPSHOT_DIGEST_MISMATCH', 'snapshot digest does not recompute from its own file records');
  const sourceRoot = typeof manifest.sourceRoot === 'string' && manifest.sourceRoot !== '' ? norm(manifest.sourceRoot) : null;
  return { manifest, records, byRel, totalBytes, sourceRoot, manifestSha256: sha256(bytes) };
}

async function hashFile(abs) {
  const hash = createHash('sha256');
  let bytes = 0;
  const input = fs.createReadStream(abs, { highWaterMark: 1 << 20 });
  for await (const chunk of input) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest('hex'), bytes };
}

// 逐文件复核：不通过就不允许进入第 ③ 步（读 files.jsonl）。
async function verifySnapshotFiles(snapshotAbs, byRel) {
  const ordered = [...byRel.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const record of ordered) {
    const abs = path.join(snapshotAbs, record.path.split('/').join(path.sep));
    if (!insideStrict(abs, snapshotAbs)) throw new BatchError('E_SNAPSHOT_FILE_OUTSIDE', 'snapshot file path escapes the snapshot root: ' + record.path);
    let lst;
    try {
      lst = fs.lstatSync(abs);
    } catch {
      throw new BatchError('E_SNAPSHOT_FILE_MISSING', 'snapshot file is missing: ' + record.path);
    }
    if (lst.isSymbolicLink()) throw new BatchError('E_SNAPSHOT_FILE_SYMLINK', 'snapshot file is a symlink or junction: ' + record.path);
    if (!lst.isFile()) throw new BatchError('E_SNAPSHOT_FILE_NOT_REGULAR', 'snapshot file is not a regular file: ' + record.path);
    if (lst.size !== record.bytes) throw new BatchError('E_SNAPSHOT_FILE_MISMATCH', 'snapshot file size differs from the manifest: ' + record.path);
    const hashed = await hashFile(abs);
    if (hashed.sha256 !== record.sha256) throw new BatchError('E_SNAPSHOT_FILE_MISMATCH', 'snapshot file sha256 differs from the manifest: ' + record.path);
  }
  return ordered.length;
}

function readVerifiedFile(snapshotAbs, record) {
  const abs = path.join(snapshotAbs, record.path.split('/').join(path.sep));
  let bytes;
  try {
    bytes = fs.readFileSync(abs);
  } catch {
    throw new BatchError('E_SNAPSHOT_FILE_MISSING', 'snapshot file disappeared: ' + record.path);
  }
  if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256) {
    throw new BatchError('E_SNAPSHOT_FILE_CHANGED', 'snapshot file changed after verification: ' + record.path);
  }
  return bytes;
}

// ---- files.jsonl → 源行 ---------------------------------------------------------
const REQUIRED_FILE_FIELDS = [...ECHO_INDEX_FILE_FIELDS].sort().join(',');

function mapDeclaredToSnapshot(declared, snapshotAbs, sourceRoot) {
  if (typeof declared !== 'string' || declared === '') return null;
  const abs = path.isAbsolute(declared) ? path.resolve(declared) : path.resolve(snapshotAbs, declared);
  if (insideStrict(abs, snapshotAbs)) return toPosixRel(path.relative(snapshotAbs, abs));
  // 冻结快照原样复制 files.jsonl，行里的绝对路径仍指向**生产根**；用 manifest 自己记的
  // sourceRoot 只做路径改写（纯字符串前缀），绝不去打开那个目录。
  if (sourceRoot !== null && insideStrict(abs, sourceRoot)) return toPosixRel(path.relative(sourceRoot, abs));
  return null;
}

function parseSourceRows(filesBytes, snapshotAbs, sourceRoot) {
  const text = filesBytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(filesBytes)) throw new BatchError('E_FILES_INVALID', 'files.jsonl is not valid UTF-8');
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) throw new BatchError('E_FILES_INVALID', 'files.jsonl declares no source rows');
  if (lines.length > MAX_SOURCES) throw new BatchError('E_TOO_MANY_SOURCES', 'files.jsonl declares more than ' + MAX_SOURCES + ' source rows');
  const rows = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (!raw.trim()) throw new BatchError('E_FILES_INVALID', 'files.jsonl line ' + (i + 1) + ' is blank');
    let parsed = null;
    let problem = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      problem = 'ROW_INVALID_JSON';
    }
    if (problem === null) {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) problem = 'ROW_NOT_OBJECT';
      else if (Object.keys(parsed).sort().join(',') !== REQUIRED_FILE_FIELDS) problem = 'ROW_FIELD_SET';
      else if (typeof parsed.file !== 'string' || parsed.file === '' || !path.isAbsolute(parsed.file)) problem = 'ROW_FILE_PATH';
      else if (typeof parsed.key !== 'string' || parsed.key === '') problem = 'ROW_KEY';
      else if (!Number.isSafeInteger(parsed.nextByte) || parsed.nextByte < 0) problem = 'ROW_NEXT_BYTE';
      else if (parsed.ws !== null && (typeof parsed.ws !== 'string' || parsed.ws === '')) problem = 'ROW_WS';
      else if (typeof parsed.sid !== 'string' || !SID_RE.test(parsed.sid)) problem = 'ROW_SID';
      else if (!Number.isSafeInteger(parsed.nSum) || parsed.nSum < 0) problem = 'ROW_N_SUM';
      else if (!Number.isSafeInteger(parsed.nWord) || parsed.nWord < 0) problem = 'ROW_N_WORD';
      else if (typeof parsed.wordOut !== 'string' || parsed.wordOut === '') problem = 'ROW_WORD_OUT';
      else if (typeof parsed.sumOut !== 'string' || parsed.sumOut === '') problem = 'ROW_SUM_OUT';
    }
    const row = { index: i, id: 'src-' + String(i).padStart(4, '0'), raw, problem, source: problem === null ? parsed : null };
    if (problem === null) {
      const wordRel = mapDeclaredToSnapshot(parsed.wordOut, snapshotAbs, sourceRoot);
      const sumRel = mapDeclaredToSnapshot(parsed.sumOut, snapshotAbs, sourceRoot);
      if (wordRel === null) row.problem = 'ROW_WORD_OUT_UNMAPPABLE';
      else if (sumRel === null) row.problem = 'ROW_SUM_OUT_UNMAPPABLE';
      else row.shards = { wordRel, sumRel };
    }
    rows.push(row);
  }
  return rows;
}

// ---- 分片字节判据 ---------------------------------------------------------------
// canonical-empty = 0 字节，或单个 LF（读取器对两者都是**零行**；words 的 0 仍是 0）。
function inspectArtifact(bytes) {
  if (bytes.length === 0) return { canonicalEmpty: true, rows: 0, problem: null };
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { canonicalEmpty: false, rows: 0, problem: 'SHARD_BOM' };
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) return { canonicalEmpty: false, rows: 0, problem: 'SHARD_INVALID_UTF8' };
  if (bytes[bytes.length - 1] !== 10) return { canonicalEmpty: false, rows: 0, problem: 'SHARD_NO_FINAL_LF' };
  const body = text.slice(0, -1);
  if (body === '') return { canonicalEmpty: true, rows: 0, problem: null };
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim()) return { canonicalEmpty: false, rows: 0, problem: 'SHARD_BLANK_ROW' };
    let obj;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      return { canonicalEmpty: false, rows: 0, problem: 'SHARD_INVALID_JSON' };
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { canonicalEmpty: false, rows: 0, problem: 'SHARD_NOT_OBJECT' };
  }
  return { canonicalEmpty: false, rows: lines.length, problem: null };
}

// 构建器拒绝 → 固定码表（绝不回显它带路径的原文）。
const BUILDER_CODE_RULES = [
  ['produced no user/assistant rows', 'EMPTY_NO_SELECTED_ROWS'],
  ['share session+seq', 'WORD_SEQ_CONFLICT'],
  ['already declared by summaries.jsonl line', 'SUMMARY_ID_CONFLICT'],
  ['does not match the files.jsonl sid', 'SESSION_MISMATCH'],
  ['has no files.jsonl record', 'SOURCE_NOT_DECLARED'],
  ['words.jsonl is empty', 'WORDS_ARTIFACT_EMPTY'],
  ['must not start with a UTF-8 BOM', 'SHARD_BOM'],
  ['is not valid UTF-8', 'SHARD_INVALID_UTF8'],
  ['must be a non-blank JSONL row', 'SHARD_BLANK_ROW'],
  ['invalid JSON', 'SHARD_INVALID_JSON'],
  ['must be a JSON object', 'SHARD_NOT_OBJECT'],
  ['does not end with LF', 'SHARD_NO_FINAL_LF'],
  ['must be a non-empty path', 'FIELD_SHAPE_INVALID'],
  ['must be a parseable timestamp', 'ROW_TIMESTAMP_INVALID'],
  ['must be ptr-safe', 'ROW_SESSION_INVALID'],
  ['outDir', 'OUTDIR_INVALID'],
];
function classifyBuilderFailure(error) {
  const declared = error && typeof error.code === 'string' ? error.code : '';
  if (/^[A-Z0-9_]{2,64}$/.test(declared)) return declared;
  const message = String(error && error.message ? error.message : '');
  for (const [needle, code] of BUILDER_CODE_RULES) if (message.includes(needle)) return code;
  return 'BUILDER_REFUSED';
}

// ---- 输出根（TEMP 内、开工前必须缺失或为空、并发锁）------------------------------
function prepareOut(rawOut, snapshotAbs) {
  const outAbs = norm(rawOut);
  const tmpRaw = os.tmpdir();
  if (!path.isAbsolute(tmpRaw)) throw new BatchError('E_NO_TMPDIR', 'os.tmpdir() is not an absolute path; refusing to guess', 4);
  const tmpReal = realOf(tmpRaw);
  if (tmpReal === null) throw new BatchError('E_NO_TMPDIR', 'os.tmpdir() is not readable', 4);
  if (!insideStrict(outAbs, tmpReal)) throw new BatchError('E_OUT_OUTSIDE_TMP', '--out must be a directory strictly inside os.tmpdir()', 2);
  if (insideStrict(outAbs, snapshotAbs) || ci(norm(outAbs)) === ci(norm(snapshotAbs))) {
    throw new BatchError('E_OUT_INSIDE_SNAPSHOT', '--out must not be inside --snapshot-root', 2);
  }
  const base = path.basename(outAbs);
  if (base === '' || base === '.' || base === '..') throw new BatchError('E_BAD_OUT', '--out must name a directory', 2);
  const parentReal = realOf(path.dirname(outAbs));
  if (parentReal === null) throw new BatchError('E_OUT_PARENT_MISSING', '--out parent directory does not exist', 2);
  if (!insideStrict(parentReal, tmpReal) && ci(norm(parentReal)) !== ci(norm(tmpReal))) {
    throw new BatchError('E_OUT_OUTSIDE_TMP', '--out resolves outside os.tmpdir()', 2);
  }
  let preexisting = false;
  try {
    const st = fs.lstatSync(outAbs);
    if (st.isSymbolicLink()) throw new BatchError('E_OUT_SYMLINK', '--out is a symlink', 2);
    if (!st.isDirectory()) throw new BatchError('E_OUT_NOT_DIR', '--out exists and is not a directory', 2);
    const entries = fs.readdirSync(outAbs);
    if (entries.length === 1 && entries[0] === LOCK_NAME) {
      throw new BatchError('E_CONCURRENT_RUN', 'another batch build holds ' + LOCK_NAME + ' in --out', 3);
    }
    if (entries.length > 0) throw new BatchError('E_OUT_NOT_EMPTY', '--out exists and is not empty', 3);
    preexisting = true;
  } catch (error) {
    if (error instanceof BatchError) throw error;
    if (error && error.code === 'ENOENT') preexisting = false;
    else throw new BatchError('E_OUT_UNREADABLE', '--out could not be inspected', 4);
  }
  if (!preexisting) {
    try {
      fs.mkdirSync(outAbs, { recursive: true, mode: 0o700 });
    } catch {
      throw new BatchError('E_OUT_CREATE_FAILED', 'output directory could not be created', 4);
    }
  }
  return { abs: outAbs, preexisting };
}

function acquireLock(outAbs) {
  const lockPath = path.join(outAbs, LOCK_NAME);
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error && error.code === 'EEXIST') throw new BatchError('E_CONCURRENT_RUN', 'another batch build holds ' + LOCK_NAME + ' in --out', 3);
    throw new BatchError('E_LOCK_FAILED', 'batch build lock could not be created', 4);
  }
  try {
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + '\n');
  } finally {
    fs.closeSync(fd);
  }
  return lockPath;
}

function removeQuietly(target, opts) {
  try {
    fs.rmSync(target, opts);
  } catch {
    // 残留的 TEMP 目录不是正确性问题
  }
}

// ---- 单源构建 -------------------------------------------------------------------
function buildOneSource(ctx, row) {
  const { outAbs, snapshotAbs, byRel, builtAt } = ctx;
  const outcome = { id: row.id, status: 'refused', code: null, declared: null, physical: null, build: null };
  if (row.problem !== null) {
    outcome.code = row.problem;
    return outcome;
  }
  const src = row.source;
  outcome.declared = { nWord: src.nWord, nSum: src.nSum };
  const wordRecord = byRel.get(row.shards.wordRel);
  const sumRecord = byRel.get(row.shards.sumRel);
  if (!wordRecord || !sumRecord) {
    outcome.code = 'SHARD_UNDECLARED_IN_SNAPSHOT';
    return outcome;
  }
  if (wordRecord.role !== 'shard' || sumRecord.role !== 'shard') {
    outcome.code = 'SHARD_ROLE_INVALID';
    return outcome;
  }
  // 读字节时再验一次哈希：校验与使用之间不留 TOCTOU 缝隙。
  let wordBytes;
  let sumBytes;
  try {
    wordBytes = readVerifiedFile(snapshotAbs, wordRecord);
    sumBytes = readVerifiedFile(snapshotAbs, sumRecord);
  } catch (error) {
    if (error instanceof BatchError) throw error;
    throw new BatchError('E_SNAPSHOT_FILE_CHANGED', 'snapshot shard could not be read as verified bytes');
  }
  const wordShape = inspectArtifact(wordBytes);
  const sumShape = inspectArtifact(sumBytes);
  outcome.physical = { words: wordShape.rows, summaries: sumShape.rows };
  if (wordShape.problem !== null) {
    outcome.code = wordShape.problem;
    return outcome;
  }
  if (sumShape.problem !== null) {
    outcome.code = sumShape.problem;
    return outcome;
  }
  outcome.bytes = { word: wordBytes.length, sum: sumBytes.length };
  outcome.sha = { word: sha256(wordBytes), sum: sha256(sumBytes) };

  const declaredEmpty = src.nWord === 0 && src.nSum === 0;
  if (declaredEmpty && wordShape.canonicalEmpty && sumShape.canonicalEmpty) {
    // 唯一允许的「跳过」：声明 0/0，且两个工件都通过严格字节检查并确为 canonical 空。
    outcome.status = 'skippedEmpty';
    outcome.code = 'DECLARED_AND_PHYSICALLY_EMPTY';
    return outcome;
  }
  if (wordShape.rows !== src.nWord || sumShape.rows !== src.nSum) {
    outcome.code = 'COUNT_MISMATCH';
    return outcome;
  }
  if (declaredEmpty) {
    // 声明空但物理非空（或反之）都在上面被拦下；到这里仍声明空说明两工件都是 0 行却不是 canonical 空 —— 不存在。
    outcome.code = 'COMPUTE_MISMATCH';
    return outcome;
  }

  const dir = path.join(outAbs, 'work', row.id);
  const shardDir = path.join(dir, 'shards');
  fs.mkdirSync(shardDir, { recursive: true, mode: 0o700 });
  const tempWord = path.join(shardDir, 'word.jsonl');
  const tempSum = path.join(shardDir, 'sum.jsonl');
  const tempFiles = path.join(dir, 'files.jsonl');
  try {
    fs.writeFileSync(tempWord, wordBytes, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(tempSum, sumBytes, { flag: 'wx', mode: 0o600 });
  } catch {
    removeQuietly(dir, { recursive: true, force: true });
    outcome.code = 'TEMP_COPY_FAILED';
    return outcome;
  }
  // 只改这两个指针：其余字段原样，字段序与 files.jsonl 契约一致。
  const rewritten = {
    file: src.file, key: src.key, nextByte: src.nextByte, ws: src.ws, sid: src.sid,
    nSum: src.nSum, nWord: src.nWord, sumOut: norm(tempSum), wordOut: norm(tempWord),
  };
  fs.writeFileSync(tempFiles, JSON.stringify(rewritten) + '\n', { flag: 'wx', mode: 0o600 });

  let built;
  try {
    built = buildFromEchoIndexFiles({
      filesPath: tempFiles,
      wordsPath: tempWord,
      summariesPath: tempSum,
      selectedLogPath: src.file,
      namespace: 'log',
      generation: 1,
      builtAt,
      outDir: path.join(dir, 'out'),
    });
  } catch (error) {
    removeQuietly(dir, { recursive: true, force: true });
    outcome.code = classifyBuilderFailure(error);
    return outcome;
  }
  const counts = built.manifest.counts || {};
  const selection = counts.selectionFilter || { words: {}, summaries: {} };
  const rejected = (Number(selection.words && selection.words.rejected) || 0) + (Number(selection.summaries && selection.summaries.rejected) || 0);
  if (rejected > 0) {
    // 声明属于这个源的分片里混进了别的源的行走 —— 构建器会静默筛掉，这里不接受静默。
    removeQuietly(dir, { recursive: true, force: true });
    outcome.code = 'SHARD_FOREIGN_ROWS';
    return outcome;
  }
  outcome.status = 'built';
  outcome.code = 'BUILT';
  outcome.build = {
    words: Number(counts.words) || 0,
    summaries: Number(counts.summaries) || 0,
    excludedReasoning: Number(counts.excludedReasoning) || 0,
    truncatedExcluded: Number(counts.truncatedExcluded) || 0,
    exactDuplicateWords: Number(counts.exactDuplicateWords) || 0,
    exactDuplicateSummaries: Number(counts.exactDuplicateSummaries) || 0,
    srcSeqRefs: Number(counts.srcSeqs) || 0,
    srcSeqDangling: Number(counts.srcSeqDangling) || 0,
  };
  outcome.artifacts = {
    manifest: 'work/' + row.id + '/out/manifest.json',
    words: 'work/' + row.id + '/out/words.jsonl',
    summaries: 'work/' + row.id + '/out/summaries.jsonl',
  };
  outcome.artifactSha = {
    manifest: built.manifestSha256,
    words: built.manifest.words.sha256,
    summaries: built.manifest.summaries.sha256,
  };
  return outcome;
}

// ---- 全局派生 feed：只在「每源都可代表」且无跨源冲突时产出 -----------------------
function readBuiltFeed(ctx, outcome) {
  const wordsPath = path.join(ctx.outAbs, outcome.artifacts.words);
  const summariesPath = path.join(ctx.outAbs, outcome.artifacts.summaries);
  const split = (bytes) => {
    const text = bytes.toString('utf8');
    if (text === '\n' || text === '') return [];
    const body = text.endsWith('\n') ? text.slice(0, -1) : text;
    return body === '' ? [] : body.split('\n');
  };
  return { words: split(fs.readFileSync(wordsPath)), summaries: split(fs.readFileSync(summariesPath)) };
}

function mergeGlobalFeed(ctx, builtOutcomes) {
  const words = new Map();
  const summaries = new Map();
  const conflicts = { wordKey: 0, cmpId: 0, wordKeySample: [], cmpIdSample: [] };
  let dedupedWords = 0;
  let dedupedSummaries = 0;
  for (const outcome of builtOutcomes) {
    const feed = readBuiltFeed(ctx, outcome);
    for (const line of feed.words) {
      const row = JSON.parse(line);
      const key = row.session + '\u0000' + String(row.seq);
      const prior = words.get(key);
      if (prior === undefined) words.set(key, line);
      else if (prior === line) dedupedWords += 1;
      else {
        conflicts.wordKey += 1;
        if (conflicts.wordKeySample.length < 4) conflicts.wordKeySample.push({ a: prior === line ? 'same' : 'diff' });
      }
    }
    for (const line of feed.summaries) {
      const row = JSON.parse(line);
      const key = String(row.cmpId);
      const prior = summaries.get(key);
      if (prior === undefined) summaries.set(key, line);
      else if (prior === line) dedupedSummaries += 1;
      else {
        conflicts.cmpId += 1;
        if (conflicts.cmpIdSample.length < 4) conflicts.cmpIdSample.push({ a: 'diff' });
      }
    }
  }
  const wordRows = [...words.values()].sort((x, y) => {
    const a = JSON.parse(x);
    const b = JSON.parse(y);
    if (a.session !== b.session) return a.session < b.session ? -1 : 1;
    return a.seq - b.seq;
  });
  const summaryRows = [...summaries.values()].sort((x, y) => {
    const a = JSON.parse(x);
    const b = JSON.parse(y);
    if (a.session !== b.session) return a.session < b.session ? -1 : 1;
    if (a.t !== b.t) return a.t < b.t ? -1 : 1;
    return String(a.cmpId) < String(b.cmpId) ? -1 : 1;
  });
  return { wordRows, summaryRows, conflicts, dedupedWords, dedupedSummaries };
}

function writeGlobalFeed(ctx, merged, snapshotDigest, sourceCounts) {
  const globalDir = path.join(ctx.outAbs, 'global');
  fs.mkdirSync(globalDir, { recursive: true, mode: 0o700 });
  const wordsBytes = Buffer.from(merged.wordRows.join('\n') + '\n', 'utf8');
  const summariesBytes = merged.summaryRows.length === 0 ? Buffer.from('\n', 'utf8') : Buffer.from(merged.summaryRows.join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(globalDir, 'words.jsonl'), wordsBytes, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(globalDir, 'summaries.jsonl'), summariesBytes, { flag: 'wx', mode: 0o600 });
  let srcSeqRefs = 0;
  for (const line of merged.summaryRows) srcSeqRefs += JSON.parse(line).srcSeqs.length;
  const manifest = {
    format: GLOBAL_FEED_FORMAT,
    createdAt: ctx.builtAt,
    // 合成身份，不是任何真实磁盘路径：指向「快照 digest 标识的这一批」。
    sourcePath: 'D:/synthetic/echo-snapshot-batch/' + snapshotDigest,
    namespace: 'log',
    generation: 1,
    builtAt: ctx.builtAt,
    snapshotDigest,
    sources: sourceCounts,
    words: { path: 'words.jsonl', sha256: sha256(wordsBytes), bytes: wordsBytes.length, rows: merged.wordRows.length },
    summaries: { path: 'summaries.jsonl', sha256: sha256(summariesBytes), bytes: summariesBytes.length, rows: merged.summaryRows.length },
    counts: {
      words: merged.wordRows.length,
      summaries: merged.summaryRows.length,
      srcSeqs: srcSeqRefs,
      dedupedWords: merged.dedupedWords,
      dedupedSummaries: merged.dedupedSummaries,
    },
    importerVerified: false,
    importerNote: 'aggregated in TEMP from per-source builds; never imported and never verified by tools/echo-index-import.mjs',
    pointerLimitation: 'log:<sid>#seq does not encode source identity; the merge refuses cross-source word-key/cmpId conflicts but cannot make a shared sid+seq unambiguous',
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(globalDir, 'manifest.json'), manifestBytes, { flag: 'wx', mode: 0o600 });
  return {
    emitted: true,
    artifacts: { words: 'global/words.jsonl', summaries: 'global/summaries.jsonl', manifest: 'global/manifest.json' },
    counts: manifest.counts,
    wordsSha256: manifest.words.sha256,
    summariesSha256: manifest.summaries.sha256,
    manifestSha256: sha256(manifestBytes),
  };
}

export async function runBatch(options = {}) {
  const log = options.log ?? ((line) => process.stdout.write(line + '\n'));
  const args = options.argv !== undefined ? parseArgs(options.argv) : options.args || parseArgs([]);
  if (args.help) {
    log(USAGE);
    return { ok: true, help: true, code: 'E_HELP', exitCode: 0 };
  }
  const builtAt = args.builtAt ?? new Date().toISOString();

  // ① 快照根 + manifest 自洽
  const snapshot = resolveSnapshotRoot(args.snapshotRoot);
  const snap = readSnapshotManifest(snapshot.abs);
  log('SNAPSHOT format=' + snap.manifest.format + ' files=' + snap.records.length + ' digest=' + snap.manifest.snapshotDigest);

  // ② 逐文件哈希复核（在读任何源数据之前）
  const verified = await verifySnapshotFiles(snapshot.abs, snap.byRel);
  log('VERIFY OK files=' + verified + ' bytes=' + snap.totalBytes);

  // ③ files.jsonl
  const filesRecord = snap.byRel.get('files.jsonl');
  if (!filesRecord) throw new BatchError('E_FILES_MISSING', 'snapshot declares no files.jsonl');
  const filesBytes = readVerifiedFile(snapshot.abs, filesRecord);
  const rows = parseSourceRows(filesBytes, snapshot.abs, snap.sourceRoot);

  // 身份唯一性：同一源路径出现两次 = 无法判定谁是它。
  const byFile = new Map();
  for (const row of rows) {
    if (row.problem !== null) continue;
    const id = ci(norm(row.source.file));
    if (byFile.has(id)) throw new BatchError('E_DUPLICATE_SOURCE_PATH', 'files.jsonl declares the same source twice (rows ' + (byFile.get(id) + 1) + ' and ' + (row.index + 1) + ')');
    byFile.set(id, row.index);
  }

  // ④ 重复 (wordOut,sumOut) 声明组 → 全局 fail closed（快照已被覆盖，碰撞不可推断/不可修复）
  const byPair = new Map();
  for (const row of rows) {
    if (row.problem !== null || !row.shards) continue;
    if (row.shards.wordRel === row.shards.sumRel) throw new BatchError('E_SHARD_ROLE_COLLISION', 'a source declares one file as both wordOut and sumOut (row ' + (row.index + 1) + ')');
    const key = row.shards.wordRel + '\u0000' + row.shards.sumRel;
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push(row.index + 1);
  }
  const collisionGroups = [...byPair.values()].filter((g) => g.length > 1);
  if (collisionGroups.length > 0) {
    const first = collisionGroups[0];
    throw new BatchError(
      'E_DUPLICATE_SHARD_DECLARATION',
      collisionGroups.length + ' duplicate (wordOut,sumOut) declaration group(s); first group covers files.jsonl rows ' + first.join(',')
      + '. A frozen snapshot holds only the overwritten bytes, so the earlier producer cannot be reconstructed and a combined feed cannot be emitted',
    );
  }

  // ⑤ 输出根（TEMP 内、开工前缺失或为空）+ 并发锁
  const staging = prepareOut(args.out, snapshot.abs);
  const createdNow = !staging.preexisting;
  const lockPath = acquireLock(staging.abs);
  const ctx = { outAbs: staging.abs, snapshotAbs: snapshot.abs, byRel: snap.byRel, builtAt };
  const commit = () => removeQuietly(lockPath, { force: true });
  try {
    log('OUT ready (sources=' + rows.length + ')');

    const outcomes = [];
    for (const row of rows) outcomes.push(buildOneSource(ctx, row));

    const built = outcomes.filter((o) => o.status === 'built');
    const skipped = outcomes.filter((o) => o.status === 'skippedEmpty');
    const refused = outcomes.filter((o) => o.status === 'refused');
    const refusalCategories = Object.create(null);
    for (const o of refused) refusalCategories[o.code] = (refusalCategories[o.code] || 0) + 1;

    const accounting = {
      sourceRows: rows.length,
      built: built.length,
      skippedEmpty: skipped.length,
      refused: refused.length,
      conserved: built.length + skipped.length + refused.length === rows.length,
    };
    if (!accounting.conserved) throw new BatchError('E_ACCOUNTING_NOT_CONSERVED', 'per-source outcomes do not add up to sourceRows', 4);

    let globalFeed;
    const conflicts = { wordKey: 0, cmpId: 0 };
    if (refused.length > 0 && built.length === 0) {
      globalFeed = { emitted: false, code: 'NO_BUILDABLE_SOURCE', refusalCategories: { ...refusalCategories } };
    } else if (refused.length > 0) {
      globalFeed = { emitted: false, code: 'REFUSED_SOURCES_PRESENT', refused: refused.length, refusalCategories: { ...refusalCategories } };
    } else {
      const merged = mergeGlobalFeed(ctx, built);
      conflicts.wordKey = merged.conflicts.wordKey;
      conflicts.cmpId = merged.conflicts.cmpId;
      if (merged.conflicts.wordKey > 0 || merged.conflicts.cmpId > 0) {
        globalFeed = { emitted: false, code: 'GLOBAL_CROSS_SOURCE_CONFLICT', categories: { wordKey: merged.conflicts.wordKey, cmpId: merged.conflicts.cmpId } };
      } else if (merged.wordRows.length === 0) {
        globalFeed = { emitted: false, code: 'GLOBAL_EMPTY_FEED', detail: 'every source is representable but no word row survives; an empty generation is never emitted' };
      } else {
        globalFeed = writeGlobalFeed(ctx, merged, snap.manifest.snapshotDigest, { built: built.length, skippedEmpty: skipped.length });
      }
    }

    const batchManifest = {
      format: FORMAT,
      createdAt: builtAt,
      snapshot: {
        format: snap.manifest.format,
        snapshotDigest: snap.manifest.snapshotDigest,
        fileCount: snap.records.length,
        totalBytes: snap.totalBytes,
        manifestSha256: snap.manifestSha256,
        verified: true,
        verification: 'snapshotDigest recomputed from per-file sha256/bytes, then every listed file re-hashed and size-checked before any source row was parsed',
      },
      sourceRows: rows.length,
      accounting,
      refusalCategories,
      globalFeed,
      sources: outcomes.map((o) => ({
        id: o.id,
        status: o.status,
        code: o.code,
        declared: o.declared,
        physical: o.physical,
        bytes: o.bytes ?? null,
        shardSha256: o.sha ?? null,
        build: o.build ?? null,
        artifacts: o.artifacts ?? null,
        artifactSha: o.artifactSha ?? null,
      })),
      tool: {
        format: FORMAT,
        writes: 'TEMP only',
        importsDatabase: false,
        runsModel: false,
        readsLiveIndex: false,
        sourceIdentity: 'positional src-NNNN within the digest-pinned files.jsonl; no path, log line, or text is recorded in this manifest',
      },
      limitations: [
        'skippedEmpty sources produce no generation: their zero rows are absent from every feed, and only this manifest distinguishes an empty source from an absent one',
        'refused sources are represented nowhere except this manifest (code + counts); their rows are not carried into any feed',
        'a duplicate (wordOut,sumOut) declaration group aborts the whole batch: the frozen snapshot keeps only the overwriting bytes, so the earlier producer is unrecoverable',
        'per-source manifests (work/<id>/out/manifest.json) are builder products and do carry the ECHO log field; they stay in TEMP and are not summarized here',
        'the global feed is aggregated, never imported: tools/echo-index-import.mjs was not run, so importability is unverified',
        'log:<sid>#seq cannot encode source identity; the merge refuses differing cross-source word keys but a byte-identical shared sid+seq is deduped, not disambiguated',
      ],
    };
    const manifestPath = path.join(staging.abs, 'batch-manifest.json');
    const manifestTmp = manifestPath + '.tmp';
    fs.writeFileSync(manifestTmp, JSON.stringify(batchManifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(manifestTmp, manifestPath);
    commit();

    const exitCode = refused.length === 0 && globalFeed.emitted ? 0 : 3;
    log('BATCH built=' + built.length + ' skippedEmpty=' + skipped.length + ' refused=' + refused.length + ' sourceRows=' + rows.length + ' conserved=' + accounting.conserved);
    log('GLOBAL feed=' + (globalFeed.emitted ? 'emitted' : 'withheld:' + globalFeed.code));
    log('BATCH-MANIFEST ' + path.join(staging.abs, 'batch-manifest.json'));
    return {
      ok: exitCode === 0,
      exitCode,
      out: staging.abs,
      batchManifestPath: manifestPath,
      accounting,
      refusalCategories,
      conflicts,
      globalFeed,
      batchManifest,
    };
  } catch (error) {
    commit();
    removeQuietly(staging.abs, { recursive: true, force: true });
    if (createdNow) removeQuietly(staging.abs, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  try {
    const result = await runBatch({ argv: process.argv.slice(2) });
    process.exitCode = result.exitCode;
  } catch (error) {
    const code = error instanceof BatchError ? error.code : 'E_INTERNAL';
    process.stderr.write('REFUSED ' + code + ': ' + String((error && error.message) || '').replace(/[A-Za-z]:[\\/][^\s'"<>|]*/g, '<path>') + '\n');
    process.exitCode = error instanceof BatchError ? error.exitCode : 4;
  }
}

const invokedAsScript = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedAsScript) await main();
