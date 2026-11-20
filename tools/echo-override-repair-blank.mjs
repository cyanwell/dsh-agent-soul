#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// echo-override-repair-blank.mjs — 空行分片修复器 + override 扩展器
//
// ★ 它为什么存在：producer（echo-snapshot-to-import-input.mjs）是整批 fail-closed 的。
//   快照里只要有**一个分片**里出现**一行空行**，整批就是 JSONL_BLANK_ROW，一份都不写。
//   而空行不是数据 —— 它是**写坏的形状**（多写出来的那个换行）。删掉它、其余字节一个不动，
//   就是合法的 producer 输入；producer 自己也写明了：override 对任何源都生效，
//   一份修好的分片是合法输入，条件与共享对相同（hash + 行数用前必核）。
//   这个文件负责**产**那份输入，并把它显式声明进 override。
//
// ★ 它不猜：
//   · 只修「有空行、且没有非法 JSON 行」的分片 —— 空行是形状错，坏行是数据坏，不能靠删。
//   · 修复只做一件事：删空行。其它字节逐字节相同，行尾约定（末行有无 LF）照旧。
//   · 每条 override 都要能指认主人：wordOut / sumOut 的**basename**必须唯一命中一行
//     files.jsonl。命中 0 行 → REPAIR_OWNER_MISSING；命中多行 → REPAIR_OWNER_AMBIGUOUS。
//   · 那一行的**另一侧**分片如果是被别的行共享的（生产侧覆盖事故留下的形状）→ 拒。
//     共享对的两侧必须分别被显式命名，只修一侧等于替另一个源猜身份。
//   · 用另一侧之前先按 manifest 核它的 bytes + sha256 —— 不核就等于相信路径。
//
// ★ 它绝不改快照：写之前拒（落点落在快照内 → OUT_INSIDE_SNAPSHOT），写之后**重算整份
//   快照的每一份 sha256**、再算一次 snapshotDigest；任何一处不符 → SNAPSHOT_MUTATED。
//
// 输出
//   <out-dir>/repaired-<原分片 sha256 前 16 位>.jsonl    修好的分片
//   <out-override>                                      override-in 的副本 + 新增条目
//   stdout 只回**计数与哈希**：没有路径、没有 sid、没有正文。
//
// 拒绝码
//   USAGE_UNKNOWN_FLAG / USAGE_MISSING_ARG / USAGE_DUPLICATE_FLAG
//   SNAPSHOT_DIR_INVALID / SNAPSHOT_MANIFEST_MISSING / SNAPSHOT_MANIFEST_INVALID
//   SNAPSHOT_FORMAT / SNAPSHOT_DIGEST_MISMATCH / SNAPSHOT_FILES_RECORD_MISSING
//   FILES_ROW_MISMATCH / FILES_ROW_INVALID / SID_MALFORMED / VARIANT_UNDETECTABLE / VARIANT_CONFLICT
//   OVERRIDE_IN_INVALID / OVERRIDE_DUPLICATE_ENTRY
//   OUT_INSIDE_SNAPSHOT / OUT_DIR_INVALID / OUT_EXISTS / OUT_OVERRIDE_EXISTS / OUT_WRITE_MISMATCH
//   SHARD_NOT_UTF8 / BLANK_SHARD_INVALID_JSON / TOO_MANY_BLANK_SHARDS
//   REPAIR_OWNER_MISSING / REPAIR_OWNER_AMBIGUOUS / REPAIR_OTHER_SIDE_MISSING
//   REPAIR_OTHER_SIDE_MISMATCH / REPAIR_OTHER_SIDE_SHARED / SNAPSHOT_MUTATED
// 退出码：0 ok / 2 用法 / 3 拒绝 / 4 IO
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
// digest 规则与快照 format 的**唯一真相**都在 freeze 里 —— 引用，不抄第二份。
import { computeSnapshotDigest, FORMAT as SNAPSHOT_FORMAT } from './echo-index-freeze.mjs';
// files.jsonl 行字段表的**唯一定义**在 builder 里 —— 引用，不抄第二份。
import { ECHO_INDEX_FILE_FIELDS } from './echo-source-build.mjs';

export const TOOL_VERSION = 'echo-override-repair-blank/1';
export const OVERRIDE_FORMAT = 'echo-snapshot-import-override/1';
export const MAX_BLANK_SHARDS = 5;
export const EXIT = Object.freeze({ ok: 0, usage: 2, refused: 3, io: 4 });

const SHA_RE = /^[0-9a-f]{64}$/;
const SID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const ROLE_VALUES = new Set(['files', 'words', 'summaries', 'shard']);
const IS_WIN = process.platform === 'win32';
const LF = String.fromCharCode(10);
const ENTRY_FIELDS = ['variant', 'sidSha256', 'wordFile', 'sumFile', 'wordSha256', 'sumSha256', 'wordRows', 'sumRows'];
const USAGE = 'usage: echo-override-repair-blank.mjs --snapshot-dir <dir> --override-in <file.json> --out-dir <dir> --out-override <file.json>';

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const norm = (p) => { let s = path.resolve(p).split(path.sep).join('/'); while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1); return s; };
const ci = (s) => (IS_WIN ? String(s).toLowerCase() : String(s));
const toPosixRel = (rel) => rel.split(path.sep).join('/');
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const fieldKey = (obj) => Object.keys(obj).sort().join(',');
const setKey = (fields) => fields.slice().sort().join(',');
const SET_FILE = setKey(ECHO_INDEX_FILE_FIELDS);
const SET_ENTRY = setKey(ENTRY_FIELDS);

export class RepairError extends Error {
  constructor(code, message, detail, exitCode) {
    super(message);
    this.name = 'RepairError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
    this.exitCode = exitCode === undefined ? EXIT.refused : exitCode;
  }
}
const refuse = (code, message, detail, exitCode) => { throw new RepairError(code, message, detail, exitCode); };

function insideStrict(childAbs, parentAbs) {
  const c = ci(norm(childAbs));
  const p = ci(norm(parentAbs));
  if (c === p) return false;
  return c.startsWith(p.endsWith('/') ? p : p + '/');
}
function realOf(p) { try { return fs.realpathSync(p); } catch { return null; } }

// ── 严格 JSONL 的**分类**（这里不抛：先把形状看清楚，再由调用方决定拒还是修）──────────
export function classifyJsonl(bytes) {
  const text = bytes.toString('utf8');
  const utf8Ok = Buffer.from(text, 'utf8').equals(bytes);
  const finalLf = text.endsWith(LF);
  const body = finalLf ? text.slice(0, -1) : text;
  const lines = body === '' ? [] : body.split(LF);
  const blankLines = [];
  const invalidLines = [];
  let valid = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim()) { blankLines.push(i + 1); continue; }
    let obj;
    try { obj = JSON.parse(lines[i]); } catch { invalidLines.push(i + 1); continue; }
    if (!isPlainObject(obj)) { invalidLines.push(i + 1); continue; }
    valid += 1;
  }
  return { utf8Ok, finalLf, lines, blankLines, invalidLines, valid };
}

// 删空行，其余字节一个不动；末行有无 LF 照原样（保持原文件的换行约定）。
export function repairBytes(cls) {
  if (!cls.utf8Ok) refuse('SHARD_NOT_UTF8', 'a shard that needs repair is not valid UTF-8 (repairing it would rewrite bytes that are not text)');
  const kept = cls.lines.filter((l) => l.trim() !== '');
  const text = kept.join(LF) + (cls.finalLf && kept.length > 0 ? LF : '');
  return Buffer.from(text, 'utf8');
}

// ── 变体：从 file 字段的 session.v3 / session.v4 记号取（显式，不猜）──────────────
export function variantOfFile(file) {
  if (typeof file !== 'string' || file === '') refuse('FILES_ROW_INVALID', 'a files.jsonl row carries no file path');
  const found = new Set();
  const re = /(?:^|[^A-Za-z0-9])session\.v([34])(?![0-9])/g;
  let m;
  while ((m = re.exec(file)) !== null) found.add('v' + m[1]);
  if (found.size === 0) refuse('VARIANT_UNDETECTABLE', 'a files.jsonl row carries no session.v3 / session.v4 marker');
  if (found.size > 1) refuse('VARIANT_CONFLICT', 'a files.jsonl row carries both session.v3 and session.v4 markers');
  return [...found][0];
}

// ── 快照 manifest：自洽 + digest 重算（与 producer 同一套判据）──────────────────
export function readAndVerifyManifest(snapshotAbs) {
  const manifestPath = path.join(snapshotAbs, 'manifest.json');
  let bytes;
  try { bytes = fs.readFileSync(manifestPath); } catch { refuse('SNAPSHOT_MANIFEST_MISSING', 'snapshot manifest.json is not readable'); }
  let manifest;
  try { manifest = JSON.parse(bytes.toString('utf8')); } catch { refuse('SNAPSHOT_MANIFEST_INVALID', 'snapshot manifest.json is not valid JSON'); }
  if (!isPlainObject(manifest)) refuse('SNAPSHOT_MANIFEST_INVALID', 'snapshot manifest.json is not an object');
  if (manifest.format !== SNAPSHOT_FORMAT) refuse('SNAPSHOT_FORMAT', 'snapshot manifest format is not ' + SNAPSHOT_FORMAT);
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) refuse('SNAPSHOT_MANIFEST_INVALID', 'snapshot manifest declares no files');
  if (typeof manifest.snapshotDigest !== 'string' || !SHA_RE.test(manifest.snapshotDigest)) refuse('SNAPSHOT_MANIFEST_INVALID', 'snapshot manifest carries no usable snapshotDigest');
  if (manifest.fileCount !== manifest.files.length) refuse('SNAPSHOT_MANIFEST_INVALID', 'snapshot manifest fileCount does not match its file list');
  const records = [];
  const byRel = new Map();
  let totalBytes = 0;
  for (let i = 0; i < manifest.files.length; i += 1) {
    const r = manifest.files[i];
    const where = 'snapshot manifest file ' + (i + 1);
    if (!isPlainObject(r)) refuse('SNAPSHOT_MANIFEST_INVALID', where + ' is not an object');
    if (typeof r.path !== 'string' || r.path === '') refuse('SNAPSHOT_MANIFEST_INVALID', where + ' has no path');
    if (r.path.includes('\\')) refuse('SNAPSHOT_MANIFEST_INVALID', where + ' path is not posix');
    if (path.posix.isAbsolute(r.path)) refuse('SNAPSHOT_MANIFEST_INVALID', where + ' path is absolute');
    const segs = r.path.split('/');
    if (segs.some((s) => s === '' || s === '.' || s === '..')) refuse('SNAPSHOT_MANIFEST_INVALID', where + ' path has an unusable segment');
    if (typeof r.sha256 !== 'string' || !SHA_RE.test(r.sha256)) refuse('SNAPSHOT_MANIFEST_INVALID', where + ' has no usable sha256');
    if (!Number.isSafeInteger(r.bytes) || r.bytes < 0) refuse('SNAPSHOT_MANIFEST_INVALID', where + ' has no usable byte count');
    if (!ROLE_VALUES.has(r.role)) refuse('SNAPSHOT_MANIFEST_INVALID', where + ' has an unknown role');
    if (byRel.has(r.path)) refuse('SNAPSHOT_MANIFEST_INVALID', where + ' repeats a path already declared');
    const record = { path: r.path, role: r.role, sha256: r.sha256, bytes: r.bytes };
    records.push(record);
    byRel.set(r.path, record);
    totalBytes += r.bytes;
  }
  if (manifest.totalBytes !== totalBytes) refuse('SNAPSHOT_MANIFEST_INVALID', 'snapshot manifest totalBytes does not match its file list');
  const recomputed = computeSnapshotDigest(records);
  if (recomputed !== manifest.snapshotDigest) {
    refuse('SNAPSHOT_DIGEST_MISMATCH', 'snapshot digest does not recompute from its own file records (the manifest is not self-consistent)', { recomputed, declared: manifest.snapshotDigest });
  }
  const sourceRoot = typeof manifest.sourceRoot === 'string' && manifest.sourceRoot !== '' ? norm(manifest.sourceRoot) : null;
  return { manifest, records, byRel, totalBytes, sourceRoot, manifestSha256: sha256(bytes) };
}

// ── files.jsonl：字节核过之后再逐行核形状 ───────────────────────────────────
export function readFilesRows(snapshotAbs, records) {
  const fileRecs = records.filter((r) => r.role === 'files');
  if (fileRecs.length !== 1) refuse('SNAPSHOT_FILES_RECORD_MISSING', 'the snapshot manifest must declare exactly one file with role "files"', { declared: fileRecs.length });
  const rec = fileRecs[0];
  const abs = path.join(snapshotAbs, rec.path.split('/').join(path.sep));
  const bytes = fs.readFileSync(abs);
  if (bytes.length !== rec.bytes || sha256(bytes) !== rec.sha256) refuse('FILES_ROW_MISMATCH', 'the snapshot files.jsonl does not hash to its manifest record');
  const cls = classifyJsonl(bytes);
  if (!cls.utf8Ok) refuse('FILES_ROW_INVALID', 'the snapshot files.jsonl is not valid UTF-8');
  if (cls.blankLines.length > 0) refuse('FILES_ROW_INVALID', 'the snapshot files.jsonl contains blank lines', { blankLines: cls.blankLines.length });
  if (cls.invalidLines.length > 0) refuse('FILES_ROW_INVALID', 'the snapshot files.jsonl contains lines that are not JSON objects', { invalidLines: cls.invalidLines.length });
  const rows = [];
  for (let i = 0; i < cls.lines.length; i += 1) {
    const row = JSON.parse(cls.lines[i]);
    if (fieldKey(row) !== SET_FILE) refuse('FILES_ROW_INVALID', 'a files.jsonl row field set is not exactly ECHO_INDEX_FILE_FIELDS', { row: i });
    if (typeof row.sid !== 'string' || !SID_RE.test(row.sid)) refuse('SID_MALFORMED', 'a files.jsonl row sid is not ptr-safe', { row: i });
    if (typeof row.wordOut !== 'string' || row.wordOut === '' || typeof row.sumOut !== 'string' || row.sumOut === '') refuse('FILES_ROW_INVALID', 'a files.jsonl row must declare wordOut and sumOut', { row: i });
    rows.push({ index: i, row, variant: variantOfFile(row.file), sidSha256: sha256(Buffer.from(row.sid, 'utf8')) });
  }
  return rows;
}

// 行里声明的分片路径 → 快照内相对路径（与 producer 同一规则：快照根内，或用 sourceRoot 做纯字符串改写）。
export function mapDeclaredToSnapshot(declared, snapshotAbs, sourceRoot) {
  const abs = path.isAbsolute(declared) ? path.resolve(declared) : path.resolve(snapshotAbs, declared);
  if (insideStrict(abs, snapshotAbs)) return toPosixRel(path.relative(snapshotAbs, abs));
  if (sourceRoot !== null && insideStrict(abs, sourceRoot)) return toPosixRel(path.relative(sourceRoot, abs));
  return null;
}

// ── 扫描：只扫 role === 'shard' 的文件 ─────────────────────────────────────
export function scanBlankShards(snapshotAbs, records) {
  const hits = [];
  let scanned = 0;
  for (const rec of records) {
    if (rec.role !== 'shard') continue;
    scanned += 1;
    const abs = path.join(snapshotAbs, rec.path.split('/').join(path.sep));
    const bytes = fs.readFileSync(abs);
    const cls = classifyJsonl(bytes);
    if (cls.blankLines.length === 0) continue;
    if (!cls.utf8Ok) refuse('SHARD_NOT_UTF8', 'a shard that contains blank lines is not valid UTF-8', { sha256: rec.sha256 });
    if (cls.invalidLines.length > 0) {
      refuse('BLANK_SHARD_INVALID_JSON', 'a shard that contains blank lines also has lines that are not JSON objects; a blank line is a shape error that deletion can fix, a broken line is broken data that it cannot', { blankLines: cls.blankLines.length, invalidLines: cls.invalidLines.length, sha256: rec.sha256 });
    }
    hits.push({ rec, abs, bytes, cls });
  }
  if (hits.length > MAX_BLANK_SHARDS) {
    refuse('TOO_MANY_BLANK_SHARDS', 'more shards than this tool repairs in one batch contain blank lines; that no longer looks like a single stray newline', { affected: hits.length, limit: MAX_BLANK_SHARDS });
  }
  return { scanned, hits };
}

// ── 主人：basename 唯一命中一行 files.jsonl ─────────────────────────────────
export function resolveOwner(hit, rows, snapshotAbs, sourceRoot) {
  const shardBase = hit.rec.path.split('/').pop();
  const matches = [];
  for (const r of rows) {
    const wRel = mapDeclaredToSnapshot(r.row.wordOut, snapshotAbs, sourceRoot);
    const sRel = mapDeclaredToSnapshot(r.row.sumOut, snapshotAbs, sourceRoot);
    if (wRel !== null && ci(wRel.split('/').pop()) === ci(shardBase)) matches.push({ r, side: 'word', wRel, sRel });
    if (sRel !== null && ci(sRel.split('/').pop()) === ci(shardBase)) matches.push({ r, side: 'sum', wRel, sRel });
  }
  if (matches.length === 0) refuse('REPAIR_OWNER_MISSING', 'a shard with blank lines is not declared by any files.jsonl row (by wordOut / sumOut basename), so no override entry can be built for it', { sha256: hit.rec.sha256 });
  if (matches.length > 1) refuse('REPAIR_OWNER_AMBIGUOUS', 'more than one files.jsonl row declares a shard with the same basename; which identity owns those rows cannot be inferred', { sha256: hit.rec.sha256, candidates: matches.length });
  return matches[0];
}

// 另一侧必须是这一行独占的（共享对 = 生产侧覆盖事故，两侧都要被显式命名，这里只修一侧）。
export function declareCount(rows, relPath, snapshotAbs, sourceRoot) {
  let n = 0;
  for (const r of rows) {
    const wRel = mapDeclaredToSnapshot(r.row.wordOut, snapshotAbs, sourceRoot);
    const sRel = mapDeclaredToSnapshot(r.row.sumOut, snapshotAbs, sourceRoot);
    if ((wRel !== null && ci(wRel) === ci(relPath)) || (sRel !== null && ci(sRel) === ci(relPath))) n += 1;
  }
  return n;
}

function writeNew(abs, bytes, existsCode, label) {
  try {
    const fd = fs.openSync(abs, 'wx', 0o600);
    try { fs.writeSync(fd, bytes, 0, bytes.length, 0); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return { wrote: true, existedIdentical: false };
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      const cur = fs.readFileSync(abs);
      if (sha256(cur) === sha256(Buffer.from(bytes))) return { wrote: false, existedIdentical: true };
      refuse(existsCode, 'a file this tool writes already exists with different bytes; refusing to overwrite evidence', { target: label });
    }
    throw e;
  }
}

// ── override-in：形状不猜 ────────────────────────────────────────────────
export function readOverrideIn(overrideInAbs) {
  let bytes;
  try { bytes = fs.readFileSync(overrideInAbs); } catch { refuse('OVERRIDE_IN_INVALID', '--override-in is not readable'); }
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { refuse('OVERRIDE_IN_INVALID', '--override-in is not valid JSON'); }
  if (!isPlainObject(parsed)) refuse('OVERRIDE_IN_INVALID', '--override-in is not an object');
  if (parsed.format !== OVERRIDE_FORMAT) refuse('OVERRIDE_IN_INVALID', '--override-in format is not ' + OVERRIDE_FORMAT);
  if (!Array.isArray(parsed.entries)) refuse('OVERRIDE_IN_INVALID', '--override-in carries no entries[]');
  const seen = new Set();
  for (let i = 0; i < parsed.entries.length; i += 1) {
    const e = parsed.entries[i];
    if (!isPlainObject(e) || fieldKey(e) !== SET_ENTRY) refuse('OVERRIDE_IN_INVALID', 'an --override-in entry field set is not exactly the declared entry shape', { entry: i + 1 });
    const k = String(e.variant) + String.fromCharCode(0) + String(e.sidSha256);
    if (seen.has(k)) refuse('OVERRIDE_IN_INVALID', 'two --override-in entries declare the same (variant, sid hash)', { entry: i + 1 });
    seen.add(k);
  }
  return { format: parsed.format, entries: parsed.entries.map((e) => Object.assign({}, e)), seen, sha256: sha256(bytes), bytes: bytes.length };
}

// ── 主流程 ──────────────────────────────────────────────────────────────
export function runRepair(options) {
  const o = options || {};
  if (typeof o.snapshotDir !== 'string' || o.snapshotDir === '') refuse('USAGE_MISSING_ARG', 'missing required argument: --snapshot-dir', undefined, EXIT.usage);
  if (typeof o.overrideIn !== 'string' || o.overrideIn === '') refuse('USAGE_MISSING_ARG', 'missing required argument: --override-in', undefined, EXIT.usage);
  if (typeof o.outDir !== 'string' || o.outDir === '') refuse('USAGE_MISSING_ARG', 'missing required argument: --out-dir', undefined, EXIT.usage);
  if (typeof o.outOverride !== 'string' || o.outOverride === '') refuse('USAGE_MISSING_ARG', 'missing required argument: --out-override', undefined, EXIT.usage);

  // ① 快照目录
  const snapGiven = path.resolve(o.snapshotDir);
  let st;
  try { st = fs.statSync(snapGiven); } catch { refuse('SNAPSHOT_DIR_INVALID', '--snapshot-dir does not exist'); }
  if (!st.isDirectory()) refuse('SNAPSHOT_DIR_INVALID', '--snapshot-dir is not a directory');
  const snapshotAbs = snapGiven;

  // ② 落点先判：绝不许写进快照（快照是证据）
  const outDirAbs = path.resolve(o.outDir);
  const outOverrideAbs = path.resolve(o.outOverride);
  if (insideStrict(outDirAbs, snapshotAbs) || ci(norm(outDirAbs)) === ci(norm(snapshotAbs))) refuse('OUT_INSIDE_SNAPSHOT', '--out-dir must not be inside the snapshot (the snapshot is evidence and this tool never writes into it)');
  if (insideStrict(outOverrideAbs, snapshotAbs) || ci(norm(outOverrideAbs)) === ci(norm(snapshotAbs))) refuse('OUT_INSIDE_SNAPSHOT', '--out-override must not be inside the snapshot (the snapshot is evidence and this tool never writes into it)');
  const realOutParent = realOf(path.dirname(outOverrideAbs));
  if (realOutParent === null) refuse('OUT_DIR_INVALID', 'the --out-override parent directory does not exist');

  // ③ manifest + files.jsonl
  const snap = readAndVerifyManifest(snapshotAbs);
  const rows = readFilesRows(snapshotAbs, snap.records);

  // ④ override-in（副本 + 追加，不改原文件）
  const ovIn = readOverrideIn(path.resolve(o.overrideIn));

  // ⑤ 扫分片
  const scan = scanBlankShards(snapshotAbs, snap.records);

  // ⑥ 逐片修 + 建 entry
  fs.mkdirSync(outDirAbs, { recursive: true, mode: 0o700 });
  const repaired = [];
  const newEntries = [];
  for (const hit of scan.hits) {
    const owner = resolveOwner(hit, rows, snapshotAbs, snap.sourceRoot);
    const otherRel = owner.side === 'word' ? owner.sRel : owner.wRel;
    if (otherRel === null) refuse('REPAIR_OTHER_SIDE_MISSING', 'the other shard of the owning files.jsonl row cannot be located inside the snapshot');
    const otherRec = snap.byRel.get(otherRel);
    if (!otherRec) refuse('REPAIR_OTHER_SIDE_MISSING', 'the other shard of the owning row is not listed in the snapshot manifest', { role: owner.side === 'word' ? 'summaries' : 'words' });
    const otherAbs = path.join(snapshotAbs, otherRel.split('/').join(path.sep));
    const otherBytes = fs.readFileSync(otherAbs);
    if (otherBytes.length !== otherRec.bytes || sha256(otherBytes) !== otherRec.sha256) {
      refuse('REPAIR_OTHER_SIDE_MISMATCH', 'the other shard of the owning row does not hash to its manifest record', { role: owner.side === 'word' ? 'summaries' : 'words' });
    }
    const otherDeclaredBy = declareCount(rows, otherRel, snapshotAbs, snap.sourceRoot);
    if (otherDeclaredBy > 1) {
      refuse('REPAIR_OTHER_SIDE_SHARED', 'the other shard of this row is declared by more than one files.jsonl row; a shared pair needs both sides named explicitly, so repairing one side alone would let the rows of one identity land under another', { declaredBy: otherDeclaredBy });
    }
    const otherCls = classifyJsonl(otherBytes);
    if (!otherCls.utf8Ok || otherCls.blankLines.length > 0 || otherCls.invalidLines.length > 0) {
      refuse('REPAIR_OTHER_SIDE_MISMATCH', 'the other shard of the owning row is not clean strict JSONL, so it cannot be declared as the other side as-is', { role: owner.side === 'word' ? 'summaries' : 'words' });
    }
    const repairedBytes = repairBytes(hit.cls);
    const origSha = hit.rec.sha256;
    const name = 'repaired-' + origSha.slice(0, 16) + '.jsonl';
    const repairedAbs = path.join(outDirAbs, name);
    const w = writeNew(repairedAbs, repairedBytes, 'OUT_EXISTS', 'repaired shard');
    const repairedSha = sha256(fs.readFileSync(repairedAbs));
    if (repairedSha !== sha256(repairedBytes)) refuse('OUT_WRITE_MISMATCH', 'the written repaired shard does not hash to the bytes handed to the disk', undefined, EXIT.io);
    const repairedRows = hit.cls.valid;
    const entry = {
      variant: owner.r.variant,
      sidSha256: owner.r.sidSha256,
      wordFile: owner.side === 'word' ? repairedAbs.split(path.sep).join('/') : otherAbs.split(path.sep).join('/'),
      sumFile: owner.side === 'sum' ? repairedAbs.split(path.sep).join('/') : otherAbs.split(path.sep).join('/'),
      wordSha256: owner.side === 'word' ? repairedSha : otherRec.sha256,
      sumSha256: owner.side === 'sum' ? repairedSha : otherRec.sha256,
      wordRows: owner.side === 'word' ? repairedRows : otherCls.valid,
      sumRows: owner.side === 'sum' ? repairedRows : otherCls.valid,
    };
    if (fieldKey(entry) !== SET_ENTRY) refuse('OUT_WRITE_MISMATCH', 'an assembled override entry does not have the declared field set', undefined, EXIT.io);
    const dupKey = entry.variant + String.fromCharCode(0) + entry.sidSha256;
    if (ovIn.seen.has(dupKey)) refuse('OVERRIDE_DUPLICATE_ENTRY', 'the override already names this (variant, sid hash); appending a second entry would let one silently win');
    ovIn.seen.add(dupKey);
    newEntries.push(entry);
    repaired.push({
      file: name, side: owner.side, variant: owner.r.variant,
      originalBytes: hit.rec.bytes, originalSha256: origSha,
      repairedBytes: fs.statSync(repairedAbs).size, repairedSha256: repairedSha,
      rows: repairedRows, blankLinesRemoved: hit.cls.blankLines.length,
      finalLf: hit.cls.finalLf, wordRows: entry.wordRows, sumRows: entry.sumRows,
      wrote: w.wrote, existedIdentical: w.existedIdentical,
    });
  }

  // ⑦ override 副本 + 追加
  const merged = { format: OVERRIDE_FORMAT, entries: ovIn.entries.concat(newEntries) };
  const outJson = Buffer.from(JSON.stringify(merged, null, 2) + LF, 'utf8');
  const ow = writeNew(outOverrideAbs, outJson, 'OUT_OVERRIDE_EXISTS', 'extended override');
  const outOverrideSha = sha256(fs.readFileSync(outOverrideAbs));
  if (outOverrideSha !== sha256(outJson)) refuse('OUT_WRITE_MISMATCH', 'the written override does not hash to the bytes handed to the disk', undefined, EXIT.io);

  // ⑧ 事后：整个快照逐份重算 sha256 + 重算 digest（它一个字节都不许动过）
  let filesChecked = 0;
  let mismatches = 0;
  for (const rec of snap.records) {
    const abs = path.join(snapshotAbs, rec.path.split('/').join(path.sep));
    let bytes;
    try { bytes = fs.readFileSync(abs); } catch { mismatches += 1; continue; }
    filesChecked += 1;
    if (bytes.length !== rec.bytes || sha256(bytes) !== rec.sha256) mismatches += 1;
  }
  const digestAfter = computeSnapshotDigest(snap.records);
  if (mismatches > 0 || digestAfter !== snap.manifest.snapshotDigest) {
    refuse('SNAPSHOT_MUTATED', 'the snapshot no longer hashes to its own manifest after this run; the snapshot is evidence and must never change', { filesChecked, mismatches }, EXIT.io);
  }

  return {
    ok: true,
    tool: TOOL_VERSION,
    shardsScanned: scan.scanned,
    blankShardsFound: scan.hits.length,
    repairedShards: repaired.length,
    repaired,
    overrideInEntries: ovIn.entries.length,
    overrideOutEntries: merged.entries.length,
    overrideOutSha256: outOverrideSha,
    overrideOutBytes: fs.statSync(outOverrideAbs).size,
    overrideOutWrote: ow.wrote,
    overrideInSha256: ovIn.sha256,
    snapshotDigest: snap.manifest.snapshotDigest,
    snapshotFilesChecked: filesChecked,
    snapshotMismatches: mismatches,
    snapshotDigestRecomputed: digestAfter,
  };
}

// ── CLI ────────────────────────────────────────────────────────────────
const FLAGS = Object.freeze({ '--snapshot-dir': 'snapshotDir', '--override-in': 'overrideIn', '--out-dir': 'outDir', '--out-override': 'outOverride' });
export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const k = String(argv[i]);
    if (k === '--help' || k === '-h') return { help: true };
    if (!Object.prototype.hasOwnProperty.call(FLAGS, k)) refuse('USAGE_UNKNOWN_FLAG', 'unknown argument: ' + k, undefined, EXIT.usage);
    if (opts[FLAGS[k]] !== undefined) refuse('USAGE_DUPLICATE_FLAG', 'duplicate argument: ' + k, undefined, EXIT.usage);
    const v = argv[i + 1];
    if (v === undefined || String(v).startsWith('--')) refuse('USAGE_MISSING_ARG', 'missing value for ' + k, undefined, EXIT.usage);
    opts[FLAGS[k]] = String(v);
    i += 1;
  }
  for (const k of Object.keys(FLAGS)) if (opts[FLAGS[k]] === undefined) refuse('USAGE_MISSING_ARG', 'missing required argument: ' + k, undefined, EXIT.usage);
  return opts;
}
export function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) { console.log(USAGE); return EXIT.ok; }
  const result = runRepair(opts);
  console.log(JSON.stringify(result));
  return EXIT.ok;
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (e) {
    const code = String((e && e.code) || 'REPAIR_REFUSED');
    const exitCode = (e && e.exitCode) || (/^USAGE_/.test(code) ? EXIT.usage : EXIT.refused);
    const out = { ok: false, code, exitCode };
    if (e && e.detail !== undefined) out.detail = e.detail;
    console.error(JSON.stringify(out));
    process.exitCode = exitCode;
  }
}
