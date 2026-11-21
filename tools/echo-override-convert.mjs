// echo-override-convert.mjs — 把 rebuild 侧的 16-hex sidHash manifest 转成 producer 要的
// echo-snapshot-import-override/1 形状。
//
// ★ producer（echo-snapshot-to-import-input.mjs）的 override 条目形状**只由它自己定义**：
//     { variant, sidSha256, wordFile, sumFile, wordSha256, sumSha256, wordRows, sumRows }
//   字段集必须**精确**（多一个少一个都拒）；相对路径**相对 override manifest 自己的目录**解析；
//   用之前逐条核：普通文件 / 非符号链接 / sha256 / 行数。
//   rebuild 侧那份 manifest 是另一套格式，只带 sidHash = sha256(sid)[0:16]，不带明文 sid。
//   所以中间的这一步不是"改个名字"，是**在两种身份规则之间做一次可核对的换算**。
//
// 本工具的判定只有三件事：
//   ① 六个候选 sid → sha256(utf8(sid))，前 16 hex 必须与 manifest 的 sidHash 对上：
//      每个条目恰好命中一个候选、每个候选至少命中一次、键不重复、条目数到位。否则整批拒。
//   ② 每条重建分片在**发出之前**逐个核实：存在、普通文件、非符号链接、字节数、sha256、行数。
//      （行数用 producer 读分片时的同一套严格 JSONL 规则数 —— 差一行的声明等于没核。）
//   ③ 分片路径按**输出文件所在目录**重算成相对路径（producer 就是按这个规则解析的），
//      越过该目录就拒 —— 让"输出落在哪"不影响正确性。
//
// 用法：node echo-override-convert.mjs --manifest <rebuilt-override.json> --out <producer-override.json>
// 退出码：0 好 / 2 用法 / 3 拒 / 4 IO
// 输出：只回计数与 sha256 —— **不打印 sid，也不打印路径**。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const OVERRIDE_FORMAT = 'echo-snapshot-import-override/1';
export const EXIT = Object.freeze({ ok: 0, usage: 2, refused: 3, io: 4 });
export const PRODUCER_ENTRY_FIELDS = Object.freeze([
  'variant', 'sidSha256', 'wordFile', 'sumFile', 'wordSha256', 'sumSha256', 'wordRows', 'sumRows',
]);
export const REBUILT_ENTRY_FIELDS = Object.freeze([
  'variant', 'sidHash', 'wordFile', 'wordBytes', 'wordRows', 'wordSha256',
  'sumFile', 'sumBytes', 'sumRows', 'sumSha256',
]);
export const EXPECTED_ENTRY_COUNT = 12;

// ★ 六个候选 sid。只在本文件里参与哈希匹配，绝不打印、绝不写进产物。
export const SID_CANDIDATES = Object.freeze([
  '78246cc0-c640-4c5b-b917-07b2d6443db0',
  '531e23fe-9208-4b2f-8bd3-559190a350df',
  'session-3ef3b2f8-59a8-4f48-8c7f-464cb5974bbb',
  'session-1099f531-7cac-4989-a14c-7fd499ac1fc0',
  'session-bad5d64d-479a-4586-9d35-72f886e51b40',
  'session-f6c738d6-3eb5-4cc3-aacc-b8a5440d2147',
]);

const SHA64 = /^[0-9a-f]{64}$/;
const HASH16 = /^[0-9a-f]{16}$/;
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

export const sidSha256Of = (sid) => sha256(Buffer.from(String(sid), 'utf8'));
export const sidHash16Of = (sid) => sidSha256Of(sid).slice(0, 16);

class Refusal extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'Refusal';
    this.code = code;
    this.extra = extra || null;
  }
}
const refuse = (code, message, extra) => { throw new Refusal(code, message, extra); };

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const setKey = (fields) => fields.slice().sort().join(',');
const SET_REBUILT_ENTRY = setKey(REBUILT_ENTRY_FIELDS);
const fieldKey = (obj) => Object.keys(obj).sort().join(',');

// ── 严格 JSONL：与 producer 的 readJsonlStrict 同一套规则 ────────────────────
// 末行缺 LF 但能解析 = 收下；缺 LF **且**解析不了 = 截断，拒。空行不算行，且拒。
export function countJsonlRows(bytes, label) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    refuse('JSONL_BOM', label + ' must not start with a UTF-8 BOM');
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) refuse('JSONL_NOT_UTF8', label + ' is not valid UTF-8');
  const finalLf = text.endsWith('\n');
  const body = finalLf ? text.slice(0, -1) : text;
  const lines = body === '' ? [] : body.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim()) refuse('JSONL_BLANK_ROW', label + ' line ' + (i + 1) + ' is blank');
    let obj;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      refuse('JSONL_INVALID_JSON', label + ' line ' + (i + 1) + ' is not JSON');
    }
    if (!isPlainObject(obj)) refuse('JSONL_NOT_OBJECT', label + ' line ' + (i + 1) + ' is not a JSON object');
  }
  return lines.length;
}

// ── ① sidHash → 完整 sidSha256 ───────────────────────────────────────────────
// 十二条重建条目 = 六个会话 × 两个变体；sidHash 只有 16 hex，靠候选表换成 64 hex。
export function resolveSidHashes(entries, candidates) {
  const byHash16 = new Map();
  for (const sid of candidates) {
    const h16 = sidHash16Of(sid);
    if (byHash16.has(h16)) refuse('SID_CANDIDATE_COLLISION', 'two candidate sids share the same 16-hex prefix');
    byHash16.set(h16, sidSha256Of(sid));
  }
  const seenKeys = new Set();
  const usedHashes = new Set();
  const out = [];
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    const where = 'rebuilt entry ' + (i + 1);
    if (!isPlainObject(e)) refuse('REBUILT_ENTRY_INVALID', where + ' is not an object');
    if (fieldKey(e) !== SET_REBUILT_ENTRY) {
      refuse('REBUILT_ENTRY_FIELD_SET', where + ' field set is not the rebuilt entry shape');
    }
    if (e.variant !== 'v3' && e.variant !== 'v4') refuse('REBUILT_ENTRY_INVALID', where + '.variant must be v3 or v4');
    if (typeof e.sidHash !== 'string' || !HASH16.test(e.sidHash)) {
      refuse('REBUILT_ENTRY_INVALID', where + '.sidHash must be 16 lowercase hex chars');
    }
    const full = byHash16.get(e.sidHash);
    if (full === undefined) {
      refuse('SID_HASH_UNMATCHED', 'a rebuilt sidHash matches none of the candidate sids; refusing rather than guessing the identity', { entry: i + 1 });
    }
    if (usedHashes.has(e.sidHash) === false) usedHashes.add(e.sidHash);
    const key = e.variant + '\u0000' + full;
    if (seenKeys.has(key)) {
      refuse('DUPLICATE_ENTRY_KEY', 'two rebuilt entries declare the same (variant, sid); one would silently win', { entry: i + 1 });
    }
    seenKeys.add(key);
    out.push(Object.assign({}, e, { sidSha256: full }));
  }
  // 每个候选都必须被命中：少一个就说明那份 manifest 不是这一批的形状。
  for (const sid of candidates) {
    const h16 = sidHash16Of(sid);
    if (!usedHashes.has(h16)) {
      refuse('SID_CANDIDATE_UNUSED', 'a candidate sid is matched by no rebuilt entry (the candidate list and the manifest disagree)');
    }
  }
  return out;
}

// ── ② 用之前逐条核分片：普通文件 / 非符号链接 / 字节数 / sha256 / 行数 ────────
export function verifyShard(abs, declaredBytes, declaredSha, declaredRows, role) {
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch {
    refuse('SHARD_MISSING', 'a rebuilt shard file does not exist', { role });
  }
  if (st.isSymbolicLink()) refuse('SHARD_MISSING', 'a rebuilt shard file is a symlink or junction', { role });
  if (!st.isFile()) refuse('SHARD_MISSING', 'a rebuilt shard file is not a regular file', { role });
  if (st.size !== declaredBytes) {
    refuse('SHARD_BYTES_MISMATCH', 'a rebuilt shard size does not match its declaration', { role, declared: declaredBytes, actual: st.size });
  }
  let bytes;
  try {
    bytes = fs.readFileSync(abs);
  } catch {
    refuse('SHARD_UNREADABLE', 'a rebuilt shard file is not readable', { role });
  }
  const actual = sha256(bytes);
  if (actual !== declaredSha) refuse('SHARD_SHA_MISMATCH', 'a rebuilt shard sha256 does not match its declaration', { role });
  const rows = countJsonlRows(bytes, 'rebuilt ' + role + ' shard');
  if (rows !== declaredRows) {
    refuse('SHARD_ROWS_MISMATCH', 'a rebuilt shard row count does not match its declaration', { role, declared: declaredRows, actual: rows });
  }
  return { sha256: actual, bytes: bytes.length, rows };
}

const toPosix = (p) => p.split(path.sep).join('/');

// 分片相对**输出文件目录**的路径（producer 按 override manifest 所在目录解析）。
function relativeFromOutDir(outDirAbs, abs) {
  const rel = path.relative(outDirAbs, abs);
  if (rel === '') refuse('SHARD_PATH_ESCAPES', 'a shard path resolves to the output directory itself');
  const posix = toPosix(rel);
  if (posix === '..' || posix.startsWith('../')) {
    refuse('SHARD_PATH_ESCAPES', 'a shard path lies outside the output directory, so the emitted relative path would not resolve');
  }
  return posix;
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
export function convert(manifestPath, outPath) {
  const manifestAbs = path.resolve(manifestPath);
  const outAbs = path.resolve(outPath);
  const outDirAbs = path.dirname(outAbs);
  const manifestDir = path.dirname(manifestAbs);

  if (manifestAbs === outAbs) refuse('USAGE_SAME_PATH', '--out must not be the input manifest');

  let raw;
  try {
    raw = fs.readFileSync(manifestAbs);
  } catch {
    refuse('MANIFEST_UNREADABLE', 'the rebuilt manifest is not readable');
  }
  let manifest;
  try {
    manifest = JSON.parse(raw.toString('utf8'));
  } catch {
    refuse('MANIFEST_INVALID', 'the rebuilt manifest is not valid JSON');
  }
  if (!isPlainObject(manifest)) refuse('MANIFEST_INVALID', 'the rebuilt manifest is not an object');
  if (!Array.isArray(manifest.entries)) refuse('MANIFEST_INVALID', 'the rebuilt manifest carries no entries[]');
  if (manifest.entries.length !== EXPECTED_ENTRY_COUNT) {
    refuse('MANIFEST_ENTRY_COUNT', 'the rebuilt manifest does not carry the expected number of entries', {
      declared: EXPECTED_ENTRY_COUNT, actual: manifest.entries.length,
    });
  }

  const resolved = resolveSidHashes(manifest.entries, SID_CANDIDATES);

  const emitted = [];
  const variantCounts = { v3: 0, v4: 0 };
  let totalWordRows = 0;
  let totalSumRows = 0;
  for (const e of resolved) {
    const wordAbs = path.resolve(manifestDir, e.wordFile);
    const sumAbs = path.resolve(manifestDir, e.sumFile);
    const w = verifyShard(wordAbs, e.wordBytes, e.wordSha256, e.wordRows, 'word');
    const s = verifyShard(sumAbs, e.sumBytes, e.sumSha256, e.sumRows, 'sum');
    emitted.push({
      variant: e.variant,
      sidSha256: e.sidSha256,
      wordFile: relativeFromOutDir(outDirAbs, wordAbs),
      sumFile: relativeFromOutDir(outDirAbs, sumAbs),
      wordSha256: w.sha256,
      sumSha256: s.sha256,
      wordRows: w.rows,
      sumRows: s.rows,
    });
    variantCounts[e.variant] += 1;
    totalWordRows += w.rows;
    totalSumRows += s.rows;
  }
  // 顺序固定：变体 + sid 哈希。同一份输入永远产出同一份字节。
  emitted.sort((a, b) => (a.variant === b.variant
    ? (a.sidSha256 < b.sidSha256 ? -1 : a.sidSha256 > b.sidSha256 ? 1 : 0)
    : (a.variant < b.variant ? -1 : 1)));

  const payload = JSON.stringify({ format: OVERRIDE_FORMAT, entries: emitted }, null, 2) + '\n';
  const payloadBytes = Buffer.from(payload, 'utf8');
  let fd;
  try {
    fd = fs.openSync(outAbs, 'wx', 0o600);
  } catch (err) {
    if (err && err.code === 'EEXIST') refuse('OUT_EXISTS', 'the output file already exists; refusing to overwrite');
    refuse('OUT_UNWRITABLE', 'the output file cannot be created');
  }
  try {
    fs.writeFileSync(fd, payloadBytes);
  } catch {
    refuse('OUT_UNWRITABLE', 'the output file cannot be written');
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
  const written = fs.readFileSync(outAbs);
  if (!written.equals(payloadBytes)) refuse('OUT_WRITE_MISMATCH', 'the written output does not match the bytes intended');

  return {
    ok: true,
    entryCount: emitted.length,
    variantCounts,
    sessionCount: new Set(emitted.map((e) => e.sidSha256)).size,
    totalWordRows,
    totalSumRows,
    outBytes: written.length,
    outSha256: sha256(written),
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const USAGE = 'usage: echo-override-convert.mjs --manifest <rebuilt-override.json> --out <producer-override.json>';

function parseArgs(argv) {
  const known = new Set(['--manifest', '--out']);
  const got = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!known.has(a)) refuse('USAGE_UNKNOWN_FLAG', 'unknown flag; ' + USAGE, { flag: a });
    if (got[a] !== undefined) refuse('USAGE_DUPLICATE_FLAG', 'flag given twice; ' + USAGE, { flag: a });
    const v = argv[i + 1];
    if (v === undefined || v === '' || known.has(v)) refuse('USAGE_MISSING_ARG', 'flag has no value; ' + USAGE, { flag: a });
    got[a] = v;
    i += 1;
  }
  for (const k of known) if (got[k] === undefined) refuse('USAGE_MISSING_ARG', 'a required flag is missing; ' + USAGE, { flag: k });
  return { manifestPath: got['--manifest'], outPath: got['--out'] };
}

function main() {
  try {
    const o = parseArgs(process.argv.slice(2));
    const r = convert(o.manifestPath, o.outPath);
    // 只回计数与哈希 —— 没有 sid，没有路径。
    process.stdout.write(JSON.stringify({
      ok: true,
      entryCount: r.entryCount,
      sessionCount: r.sessionCount,
      v3: r.variantCounts.v3,
      v4: r.variantCounts.v4,
      totalWordRows: r.totalWordRows,
      totalSumRows: r.totalSumRows,
      outBytes: r.outBytes,
      outSha256: r.outSha256,
    }) + '\n');
    process.exitCode = EXIT.ok;
  } catch (err) {
    if (err instanceof Refusal) {
      process.stderr.write(JSON.stringify({ ok: false, code: err.code, message: err.message, detail: err.extra }) + '\n');
      process.exitCode = EXIT.refused;
      return;
    }
    process.stderr.write(JSON.stringify({ ok: false, code: 'IO', message: String(err && err.message ? err.message : err) }) + '\n');
    process.exitCode = EXIT.io;
  }
}

const isMain = (() => {
  try { return process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) main();
