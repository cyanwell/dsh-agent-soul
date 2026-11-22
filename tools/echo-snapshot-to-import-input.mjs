#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// echo-snapshot-to-import-input.mjs — 冻结快照 → keeper 输入 JSON（唯一的一座桥）
//
// ★ 它是什么：把 tools/echo-index-freeze.mjs 产出的**冻结快照目录**翻译成
//   tools/echo-index-source-snapshot-import.mjs（"keeper"）能吃的 sources[] JSON。
//   keeper 的 --db 是 TEMP-only，它的输入形状**没有任何工具产出过** —— 这个文件就是那半边。
//   它**不**建索引、不建 feed、不碰数据库、不打开任何会话原档。只做：读字节、核摘要、
//   读分片、映射形状、写一份 JSON。
//
// ── 为什么快照 digest 必须在这里重算 ────────────────────────────────────────
//   快照目录自带的 manifest.json 声明了 snapshotDigest。这个 digest 只由**记录**推出
//   （sort 后 "path\nsha256\nbytes\n" 串接再 sha256，见 echo-index-freeze.mjs 的
//   computeSnapshotDigest —— 直接 import，绝不抄第二份规则）。不重算就等于相信一份
//   自证的文件：谁改了分片又改了记录，digest 一个字节都不会变。所以：
//     ① manifest 自身自洽（format / fileCount / totalBytes / 每条记录形状）；
//     ② 重算 digest == manifest.snapshotDigest（不符 → SNAPSHOT_DIGEST_MISMATCH）；
//     ③ **真正要读的每一个文件**再按记录核 bytes + sha256（不符 → SHARD_MISMATCH）。
//   ② 管"这份快照是不是它自称的那份"，③ 管"我读到的字节是不是这份快照记录的字节"。
//   两条都要有：只有 ② 的话，一个自洽的假 manifest 能过；只有 ③ 的话，被漏读的文件
//   永远不会被发现。
//
// ── 源行怎么来（身份 = (namespace, sid)，与 keeper 同一把钥匙）──────────────
//   一个 files.jsonl 行 = 一份会话日志 = 一个源。三个字段是身份的输入端：
//     · sid          ← 行自己的 sid 字段（原样，不派生）
//     · sourceVersion ← 行 file 里的 session.v3 / session.v4 记号（显式，不猜）
//                      v3 → namespace log，v4 → v4log（由 keeper 自己映射并复核）
//     · wordOut / sumOut ← 该源的字行分片与摘要分片（本工具要读它们）
//   一个 (variant, sid) 出现多于一行 → 拒：那在 keeper 里必然落成 DUPLICATE_SOURCE_IDENTITY，
//   在这里就说清楚比让 keeper 在半路拒好。
//
// ── 重复分片对（六组）：为什么必须靠 --override，而不是靠猜 ─────────────────
//   生产侧一个写者覆盖了另一个时，两个 files.jsonl 行会声明**同一对** (wordOut, sumOut)。
//   此时快照里只剩**一份**字节，而两行仍然声明各自的 nWord/nSum —— 也就是说：
//     · 那份共享分片只属于其中一个变体；
//     · 另一个变体这一代的行**根本没被冻结**（不是空、是丢了）。
//   任何"读一次、给两个源各发一份"的做法都会把 A 的行灌进 B 的身份下
//   （keeper 的 WORD_KEY_AMBIGUOUS_ACROSS_SOURCES 正是为这个形状准备的）。
//   所以共享对**一律不猜**：没有 override 就整批拒（SHARED_SHARD_PAIR_NO_OVERRIDE），
//   只回计数。要导入必须先有人**重建**那个变体的分片，并把重建结果显式声明出来。
//
// ── override manifest 的格式（本工具自己定义；没有第二份实现）───────────────
//   文件：任意路径，--override <file.json>
//   {
//     "format": "echo-snapshot-import-override/1",
//     "entries": [
//       {
//         "variant":   "v3" | "v4",
//         "sidSha256": "<64 hex>",   sha256(utf8(sid)) —— 不落 sid 明文
//         "wordFile":  "<abs 路径 或 相对本 manifest 所在目录>",
//         "sumFile":   "<同上>",
//         "wordSha256":"<64 hex>",   重建后分片的 sha256（用前必核）
//         "sumSha256": "<64 hex>",
//         "wordRows":  <int>,        重建后分片的行数（用前必核）
//         "sumRows":   <int>
//       }
//     ]
//   }
//   逐条在**用之前**核：字段集精确、variant 合法、sidSha256 是 hex64、两个文件存在且是
//   普通文件（不是符号链接）、重算 sha256 == 声明值、真实行数 == 声明行数。
//   任何一条不符 → OVERRIDE_* 码，整批不写。
//   ★ sidSha256 是 sha256(sid 明文) 而不是 keeper 身份串的哈希：那串里含 identity 前缀，
//     会诱使别人把身份规则抄进 override 文件。这里只要一个"对不对得上"的校验值。
//   ★ 用了 override 的源，files[].nWord/nSum 写**实际读到的行数**（= 已核对的 override
//     行数），因为那一行的原声明属于**被覆盖掉的那份分片**，不是这份。差异单独计数上报
//     （overriddenRowCountDiffers），不静默。
//   ★ override 对**任何**源都生效，不只共享对：一份被修好的分片也是合法输入，
//     条件相同（hash + 行数先核）。共享对则**两侧都必须被命名**（B 侧没被命名 = 这一批
//     仍然不知道那几行是谁的 → SHARED_SHARD_PAIR_NO_OVERRIDE）。
//   ★ 申报了却没用上的 override 条目 → OVERRIDE_UNUSED_ENTRY（拒）。"我以为它生效了"
//     和"它真的生效了"必须分得开。
//
// ── 输出 ────────────────────────────────────────────────────────────────────
//   {"sources":[{sourceVersion,sid,namespace,files:[9 字段],words:[10|11 字段],
//                summaries:[13 字段]}],
//    "provenance":{format,producer,snapshotDigest,filesRows,sources,variants,words,
//                  summaries,sharedPairs,overridesApplied}}
//   · files 行的字段集 == ECHO_INDEX_FILE_FIELDS（keeper 按精确字段集校验，不许少也不许多）；
//     wordOut/sumOut 写成**实际读的那两个分片**（用了 override 就是 override 的），
//     否则这一行描述的就不是它旁边那些行了。
//   · provenance 只有计数与哈希，**一个路径、一个 sid 都没有**。
//   · 输出文件含**私有消息正文**：mode 0o600 + flag 'wx'（绝不覆盖既有文件），
//     报告只回计数与 sha256。TEMP 是它的默认家，因为 keeper 默认只吃 os.tmpdir() 下的输入。
//
// ── 拒绝码（全部在写文件之前；整批不做半份）────────────────────────────────
//   用法：  USAGE_UNKNOWN_FLAG / USAGE_MISSING_ARG / USAGE_DUPLICATE_FLAG
//   路径：  SNAPSHOT_DIR_INVALID / SNAPSHOT_DIR_SYMLINK / OUT_DIR_INVALID
//           / OUT_NOT_IN_OUT_DIR / OUT_FORBIDDEN_ROOT / OUT_EXISTS / OUT_WRITE_MISMATCH
//   快照：  SNAPSHOT_MANIFEST_MISSING / SNAPSHOT_MANIFEST_INVALID / SNAPSHOT_FORMAT
//           / SNAPSHOT_DIGEST_MISMATCH / SNAPSHOT_FILES_RECORD_MISSING
//   行：    FILES_ROW_INVALID / VARIANT_UNDETECTABLE / VARIANT_CONFLICT / SID_MALFORMED
//           / MULTIPLE_ROWS_PER_SOURCE / SHARD_ROLE_COLLISION
//   分片：  SHARD_UNMAPPABLE / SHARD_NOT_IN_MANIFEST / SHARD_MISSING / SHARD_SYMLINK
//           / SHARD_MISMATCH / JSONL_* / SHARD_FIELD_SET / SHARD_SESSION_MISMATCH
//           / SHARD_ROW_COUNT_MISMATCH / WORKSPACE_MIXED
//   覆盖：  OVERRIDE_INVALID / OVERRIDE_DUPLICATE_ENTRY / OVERRIDE_UNUSED_ENTRY
//           / OVERRIDE_FILE_MISSING / OVERRIDE_FILE_MISMATCH / OVERRIDE_ROW_COUNT_MISMATCH
//           / SHARED_SHARD_PAIR_NO_OVERRIDE / OVERRIDE_PAIR_STILL_SHARED
//           （★ 没有 OVERRIDE_VARIANT_MISMATCH：variant 是查表的键，"写错变体"= 这个源
//             没被命名，落成上面两个码之一。永远跑不到的分支不写。）
//   退出码：0 ok / 2 用法 / 3 拒绝 / 4 IO
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
// digest 规则与快照 format 的**唯一真相**都在 freeze 里 —— 引用，不抄。
import { computeSnapshotDigest, FORMAT as SNAPSHOT_FORMAT } from './echo-index-freeze.mjs';
// 字段表的**唯一定义**在 builder 里（快照行就是权威 ECHO 索引行的形状）。
import {
  ECHO_INDEX_FILE_FIELDS, ECHO_INDEX_WORD_FIELDS,
  ECHO_INDEX_WORD_FIELDS_WITH_ROLE, ECHO_INDEX_SUMMARY_FIELDS,
} from './echo-source-build.mjs';

export const PRODUCER_VERSION = 'echo-snapshot-to-import-input/1';
export const OUTPUT_FORMAT = 'echo-snapshot-import-input/1';
export const OVERRIDE_FORMAT = 'echo-snapshot-import-override/1';
export const EXIT = Object.freeze({ ok: 0, usage: 2, refused: 3, io: 4 });
// 绝不许落盘的两个根：仓库自己（快照产物不该混进源码树）与记忆留底库。
export const FORBIDDEN_OUT_ROOTS = Object.freeze(['D:/AI/agent-soul', 'D:/AI/memory']);
const SHA_RE = /^[0-9a-f]{64}$/;
const SID_RE = /^[A-Za-z0-9._~-]{1,128}$/;
const ROLE_VALUES = new Set(['files', 'words', 'summaries', 'shard']);
const NAMESPACE_BY_VARIANT = Object.freeze({ v3: 'log', v4: 'v4log' });
const IS_WIN = process.platform === 'win32';
const USAGE = 'usage: echo-snapshot-to-import-input.mjs --snapshot-dir <dir> --out-dir <dir> --out <file> [--override <manifest.json>]';

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
// 不带正则的规范化：Windows 上 path.sep 就是反斜杠，末端斜杠用循环剥 —— 少一处转义就少一处坑。
const norm = (p) => {
  let s = path.resolve(p).split(path.sep).join('/');
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
};
const ci = (s) => (IS_WIN ? String(s).toLowerCase() : String(s));
const toPosixRel = (rel) => rel.split(path.sep).join('/');
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

export class ProducerError extends Error {
  constructor(code, message, detail, exitCode) {
    super(message);
    this.name = 'ProducerError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
    this.exitCode = exitCode === undefined ? EXIT.refused : exitCode;
  }
}
// 消息里**不许**出现路径 / sid：这条消息会被打到 stdout/stderr、也会被上层抄进报告。
const refuse = (code, message, detail, exitCode) => {
  throw new ProducerError(code, message, detail, exitCode);
};

function insideStrict(childAbs, parentAbs) {
  const c = ci(norm(childAbs));
  const p = ci(norm(parentAbs));
  if (c === p) return false;
  return c.startsWith(p.endsWith('/') ? p : p + '/');
}
function realOf(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}
const fieldKey = (obj) => Object.keys(obj).sort().join(',');
const setKey = (fields) => fields.slice().sort().join(',');
const SET_FILE = setKey(ECHO_INDEX_FILE_FIELDS);
const SET_WORD = setKey(ECHO_INDEX_WORD_FIELDS);
const SET_WORD_ROLE = setKey(ECHO_INDEX_WORD_FIELDS_WITH_ROLE);
const SET_SUM = setKey(ECHO_INDEX_SUMMARY_FIELDS);
const SET_OVERRIDE_ENTRY = setKey(['variant', 'sidSha256', 'wordFile', 'sumFile', 'wordSha256', 'sumSha256', 'wordRows', 'sumRows']);

// ── 严格 JSONL（BOM / UTF-8 / 空行 / 末行截断）────────────────────────────────
// 末行缺 LF 但能解析 = 收下（冻结快照的产物本来就不保证以 LF 结尾）；
// 缺 LF **且**末行解析不了 = 截断写坏的签名，拒。
export function readJsonlStrict(bytes, label) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) refuse('JSONL_BOM', label + ' must not start with a UTF-8 BOM');
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) refuse('JSONL_NOT_UTF8', label + ' is not valid UTF-8');
  const finalLf = text.endsWith('\n');
  const body = finalLf ? text.slice(0, -1) : text;
  const lines = body === '' ? [] : body.split('\n');
  const rows = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim()) refuse('JSONL_BLANK_ROW', label + ' line ' + (i + 1) + ' is blank');
    let obj;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      const last = i === lines.length - 1 && !finalLf;
      refuse('JSONL_INVALID_JSON', label + ' line ' + (i + 1) + ' is not JSON' + (last ? ' and the file has no final LF (truncated write)' : ''));
    }
    if (!isPlainObject(obj)) refuse('JSONL_NOT_OBJECT', label + ' line ' + (i + 1) + ' is not a JSON object');
    rows.push(obj);
  }
  return { rows, finalLf, bytes: bytes.length };
}

// ── 变体：从 file 字段的 session.v3 / session.v4 记号取（显式，不猜）──────────
// 记号前面不许紧贴字母数字（my_session.v3x / session.v13 都不算），后面不许紧跟数字。
export function variantOfFile(file) {
  if (typeof file !== 'string' || file === '') refuse('FILES_ROW_INVALID', 'a files.jsonl row carries no file path');
  const found = new Set();
  const re = /(?:^|[^A-Za-z0-9])session\.v([34])(?![0-9])/g;
  let m;
  while ((m = re.exec(file)) !== null) found.add('v' + m[1]);
  if (found.size === 0) refuse('VARIANT_UNDETECTABLE', 'a files.jsonl row carries no session.v3 / session.v4 marker, so its sourceVersion cannot be derived (it must be explicit)');
  if (found.size > 1) refuse('VARIANT_CONFLICT', 'a files.jsonl row carries both session.v3 and session.v4 markers; one row cannot be two variants');
  return [...found][0];
}

// ── 快照 manifest（自洽 + digest 重算）────────────────────────────────────
export function readSnapshotManifest(snapshotAbs) {
  const manifestPath = path.join(snapshotAbs, 'manifest.json');
  let bytes;
  try {
    bytes = fs.readFileSync(manifestPath);
  } catch {
    refuse('SNAPSHOT_MANIFEST_MISSING', 'snapshot manifest.json is not readable');
  }
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch {
    refuse('SNAPSHOT_MANIFEST_INVALID', 'snapshot manifest.json is not valid JSON');
  }
  if (!isPlainObject(manifest)) refuse('SNAPSHOT_MANIFEST_INVALID', 'snapshot manifest.json is not an object');
  if (manifest.format !== SNAPSHOT_FORMAT) refuse('SNAPSHOT_FORMAT', 'snapshot manifest format is not ' + SNAPSHOT_FORMAT);
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) refuse('SNAPSHOT_MANIFEST_INVALID', 'snapshot manifest declares no files');
  if (typeof manifest.snapshotDigest !== 'string' || !SHA_RE.test(manifest.snapshotDigest)) {
    refuse('SNAPSHOT_MANIFEST_INVALID', 'snapshot manifest carries no usable snapshotDigest');
  }
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
    refuse('SNAPSHOT_DIGEST_MISMATCH', 'snapshot digest does not recompute from its own file records (the manifest is not self-consistent; nothing was read)', { recomputed, declared: manifest.snapshotDigest });
  }
  const sourceRoot = typeof manifest.sourceRoot === 'string' && manifest.sourceRoot !== '' ? norm(manifest.sourceRoot) : null;
  return { manifest, records, byRel, totalBytes, sourceRoot, manifestSha256: sha256(bytes) };
}

// 按记录读一个快照内文件：存在性、是否符号链接、bytes、sha256 —— 一个都不省。
// codePrefix 决定拒绝码前缀（'FILES_ROW' / 'SHARD'），于是"缺一个分片"和"缺 files.jsonl"
// 在报告里是两个不同的码。
function readVerifiedSnapshotFile(snapshotAbs, record, codePrefix) {
  const abs = path.join(snapshotAbs, record.path.split('/').join(path.sep));
  if (!insideStrict(abs, snapshotAbs)) refuse(codePrefix + '_OUTSIDE', 'snapshot file path escapes the snapshot root');
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch {
    refuse(codePrefix + '_MISSING', 'a file declared by the snapshot manifest is missing from the snapshot directory', { role: record.role });
  }
  if (st.isSymbolicLink()) refuse(codePrefix + '_SYMLINK', 'a snapshot file is a symlink or junction', { role: record.role });
  if (!st.isFile()) refuse(codePrefix + '_NOT_REGULAR', 'a snapshot file is not a regular file', { role: record.role });
  if (st.size !== record.bytes) refuse(codePrefix + '_MISMATCH', 'a snapshot file size differs from its manifest record', { role: record.role, declaredBytes: record.bytes, actualBytes: st.size });
  const bytes = fs.readFileSync(abs);
  if (sha256(bytes) !== record.sha256) refuse(codePrefix + '_MISMATCH', 'a snapshot file sha256 differs from its manifest record', { role: record.role });
  return { bytes, path: abs, rel: record.path };
}

// 行里声明的分片路径 → 快照内相对路径。镜像 echo-index-snapshot-batch-build.mjs 的规则：
// 先看是否落在快照根内；否则用 manifest 自己记的 sourceRoot 做**纯字符串**前缀改写
// （冻结快照原样复制了 files.jsonl，行里的绝对路径仍指向生产根）。
export function mapDeclaredToSnapshot(declared, snapshotAbs, sourceRoot) {
  const abs = path.isAbsolute(declared) ? path.resolve(declared) : path.resolve(snapshotAbs, declared);
  if (insideStrict(abs, snapshotAbs)) return toPosixRel(path.relative(snapshotAbs, abs));
  if (sourceRoot !== null && insideStrict(abs, sourceRoot)) return toPosixRel(path.relative(sourceRoot, abs));
  return null;
}

// ── override manifest ────────────────────────────────────────────────────
export function readOverrideManifest(overrideAbs) {
  let bytes;
  try {
    bytes = fs.readFileSync(overrideAbs);
  } catch {
    refuse('OVERRIDE_INVALID', '--override file is not readable');
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    refuse('OVERRIDE_INVALID', '--override file is not valid JSON');
  }
  if (!isPlainObject(parsed)) refuse('OVERRIDE_INVALID', '--override file is not an object');
  if (parsed.format !== OVERRIDE_FORMAT) refuse('OVERRIDE_INVALID', '--override format is not ' + OVERRIDE_FORMAT);
  if (!Array.isArray(parsed.entries)) refuse('OVERRIDE_INVALID', '--override carries no entries[]');
  const baseDir = path.dirname(overrideAbs);
  const byKey = new Map();
  for (let i = 0; i < parsed.entries.length; i += 1) {
    const e = parsed.entries[i];
    const where = 'override entry ' + (i + 1);
    if (!isPlainObject(e)) refuse('OVERRIDE_INVALID', where + ' is not an object');
    if (fieldKey(e) !== SET_OVERRIDE_ENTRY) {
      refuse('OVERRIDE_INVALID', where + ' field set is not exactly the declared entry shape (fail-closed: no entry shape is guessed)');
    }
    if (e.variant !== 'v3' && e.variant !== 'v4') refuse('OVERRIDE_INVALID', where + '.variant must be v3 or v4');
    if (typeof e.sidSha256 !== 'string' || !SHA_RE.test(e.sidSha256)) refuse('OVERRIDE_INVALID', where + '.sidSha256 must be 64 lowercase hex chars');
    for (const k of ['wordSha256', 'sumSha256']) {
      if (typeof e[k] !== 'string' || !SHA_RE.test(e[k])) refuse('OVERRIDE_INVALID', where + '.' + k + ' must be 64 lowercase hex chars');
    }
    for (const k of ['wordRows', 'sumRows']) {
      if (!Number.isSafeInteger(e[k]) || e[k] < 0) refuse('OVERRIDE_INVALID', where + '.' + k + ' must be a non-negative safe integer');
    }
    for (const k of ['wordFile', 'sumFile']) {
      if (typeof e[k] !== 'string' || e[k] === '') refuse('OVERRIDE_INVALID', where + '.' + k + ' must be a non-empty path');
    }
    const key = e.variant + '\u0000' + e.sidSha256;
    if (byKey.has(key)) refuse('OVERRIDE_DUPLICATE_ENTRY', 'two override entries declare the same (variant, sid hash); one would silently win', { variant: e.variant });
    byKey.set(key, Object.assign({}, e, {
      wordAbs: path.isAbsolute(e.wordFile) ? path.resolve(e.wordFile) : path.resolve(baseDir, e.wordFile),
      sumAbs: path.isAbsolute(e.sumFile) ? path.resolve(e.sumFile) : path.resolve(baseDir, e.sumFile),
      used: false,
    }));
  }
  return { entries: byKey, count: parsed.entries.length };
}
// 用之前逐条核：普通文件、sha256、行数。任一条不符 → 拒（消息里不带路径）。
export function verifyOverrideShard(abs, declaredSha, declaredRows, role) {
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch {
    refuse('OVERRIDE_FILE_MISSING', 'an override shard file does not exist', { role });
  }
  if (st.isSymbolicLink()) refuse('OVERRIDE_FILE_MISSING', 'an override shard file is a symlink or junction', { role });
  if (!st.isFile()) refuse('OVERRIDE_FILE_MISSING', 'an override shard file is not a regular file', { role });
  const bytes = fs.readFileSync(abs);
  const actual = sha256(bytes);
  if (actual !== declaredSha) refuse('OVERRIDE_FILE_MISMATCH', 'an override shard sha256 does not match its declaration (a rebuilt shard must be pinned by hash)', { role });
  const parsed = readJsonlStrict(bytes, 'override ' + role + ' shard');
  if (parsed.rows.length !== declaredRows) {
    refuse('OVERRIDE_ROW_COUNT_MISMATCH', 'an override shard row count does not match its declaration', { role, declared: declaredRows, actual: parsed.rows.length });
  }
  return { bytes, rows: parsed.rows, sha256: actual };
}

// ── 落点守卫 ─────────────────────────────────────────────────────────────
// 两个判据：① 不许落进源码树 / 记忆留底库（拒）；② --out 必须**直接**在 --out-dir 里
// （不做隐式目录，落点由调用方显式给定）。
export function assertOutAllowed(absOut, outDirAbs) {
  const outGiven = path.resolve(absOut);
  for (const root of FORBIDDEN_OUT_ROOTS) {
    if (insideStrict(outGiven, root) || ci(norm(outGiven)) === ci(norm(root))) {
      refuse('OUT_FORBIDDEN_ROOT', '--out must not be inside a source tree or the memory archive root');
    }
  }
  const realDir = realOf(path.resolve(outDirAbs));
  if (realDir === null) refuse('OUT_DIR_INVALID', '--out-dir does not exist');
  for (const root of FORBIDDEN_OUT_ROOTS) {
    if (insideStrict(realDir, root) || ci(norm(realDir)) === ci(norm(root))) {
      refuse('OUT_FORBIDDEN_ROOT', '--out-dir must not be inside a source tree or the memory archive root');
    }
  }
  const realParent = realOf(path.dirname(outGiven));
  if (realParent === null) refuse('OUT_DIR_INVALID', '--out parent directory does not exist');
  if (ci(norm(realParent)) !== ci(norm(realDir))) refuse('OUT_NOT_IN_OUT_DIR', '--out must sit directly inside --out-dir (no implicit directories)');
  if (fs.existsSync(outGiven)) refuse('OUT_EXISTS', '--out already exists; this tool never overwrites a file that holds private message text');
  return { realDir, realParent };
}

// ── 主流程 ──────────────────────────────────────────────────────────────
export function produceImportInput(options) {
  const o = options || {};
  if (typeof o.snapshotDir !== 'string' || o.snapshotDir === '') refuse('USAGE_MISSING_ARG', 'missing required argument: --snapshot-dir', undefined, EXIT.usage);
  if (typeof o.outDir !== 'string' || o.outDir === '') refuse('USAGE_MISSING_ARG', 'missing required argument: --out-dir', undefined, EXIT.usage);
  if (typeof o.out !== 'string' || o.out === '') refuse('USAGE_MISSING_ARG', 'missing required argument: --out', undefined, EXIT.usage);

  // ① 快照目录（存在、是目录、不经符号链接）
  const snapGiven = path.resolve(o.snapshotDir);
  let snapStat;
  try {
    snapStat = fs.statSync(snapGiven);
  } catch {
    refuse('SNAPSHOT_DIR_INVALID', '--snapshot-dir does not exist');
  }
  if (!snapStat.isDirectory()) refuse('SNAPSHOT_DIR_INVALID', '--snapshot-dir is not a directory');
  const snapReal = realOf(snapGiven);
  if (snapReal === null) refuse('SNAPSHOT_DIR_INVALID', '--snapshot-dir is not readable');
  if (ci(norm(snapReal)) !== ci(norm(snapGiven))) refuse('SNAPSHOT_DIR_SYMLINK', '--snapshot-dir resolves through a symlink or junction');
  const snapshotAbs = snapGiven;

  // ② 落点守卫先判：不该为了一份写不出去的产物白读一遍私有字节
  const outAbs = path.resolve(o.out);
  assertOutAllowed(outAbs, path.resolve(o.outDir));

  // ③ manifest：自洽 + digest 重算
  const snap = readSnapshotManifest(snapshotAbs);

  // ④ files.jsonl（按 manifest 记录核字节）
  const filesRecords = snap.records.filter((r) => r.role === 'files');
  if (filesRecords.length !== 1) refuse('SNAPSHOT_FILES_RECORD_MISSING', 'the snapshot manifest must declare exactly one file with role "files"', { declared: filesRecords.length });
  const filesFile = readVerifiedSnapshotFile(snapshotAbs, filesRecords[0], 'FILES_ROW');
  const filesParsed = readJsonlStrict(filesFile.bytes, 'files.jsonl');
  if (filesParsed.rows.length === 0) refuse('FILES_ROW_INVALID', 'files.jsonl declares no source rows');
  const stat = { filesRows: filesParsed.rows.length, finalLf: filesParsed.finalLf, snapshotDigest: snap.manifest.snapshotDigest };

  // ⑤ 逐行：字段集 / 变体 / sid / 分片对
  const rows = [];
  for (let i = 0; i < filesParsed.rows.length; i += 1) {
    const row = filesParsed.rows[i];
    if (fieldKey(row) !== SET_FILE) {
      refuse('FILES_ROW_INVALID', 'a files.jsonl row field set is not exactly ECHO_INDEX_FILE_FIELDS (fail-closed: no row shape is guessed)', { row: i });
    }
    if (typeof row.file !== 'string' || row.file === '' || !path.isAbsolute(row.file)) refuse('FILES_ROW_INVALID', 'a files.jsonl row file must be an absolute path', { row: i });
    if (typeof row.key !== 'string' || row.key === '') refuse('FILES_ROW_INVALID', 'a files.jsonl row key must be a non-empty string', { row: i });
    if (!Number.isSafeInteger(row.nextByte) || row.nextByte < 0) refuse('FILES_ROW_INVALID', 'a files.jsonl row nextByte must be a non-negative safe integer', { row: i });
    if (row.ws !== null && (typeof row.ws !== 'string' || row.ws === '')) refuse('FILES_ROW_INVALID', 'a files.jsonl row ws must be a non-empty string or null', { row: i });
    if (typeof row.sid !== 'string' || !SID_RE.test(row.sid)) refuse('SID_MALFORMED', 'a files.jsonl row sid is not ptr-safe ([A-Za-z0-9._~-]{1,128})', { row: i });
    for (const k of ['nWord', 'nSum']) {
      if (!Number.isSafeInteger(row[k]) || row[k] < 0) refuse('FILES_ROW_INVALID', 'a files.jsonl row ' + k + ' must be a non-negative safe integer', { row: i });
    }
    for (const k of ['wordOut', 'sumOut']) {
      if (typeof row[k] !== 'string' || row[k] === '') refuse('FILES_ROW_INVALID', 'a files.jsonl row ' + k + ' must be a non-empty path', { row: i });
    }
    if (ci(norm(row.wordOut)) === ci(norm(row.sumOut))) refuse('SHARD_ROLE_COLLISION', 'a files.jsonl row declares one file as both wordOut and sumOut (a shard cannot be two roles)', { row: i });
    const variant = variantOfFile(row.file);
    rows.push({
      index: i, row, variant, sid: row.sid, sidSha256: sha256(Buffer.from(row.sid, 'utf8')),
      pairKey: ci(norm(row.wordOut)) + '\u0000' + ci(norm(row.sumOut)),
    });
  }

  // ⑥ 源身份分组：(variant, sid) 一组一行；同一身份两行 = keeper 必然拒的形状，这里先说清
  const bySource = new Map();
  for (const r of rows) {
    const key = r.variant + '\u0000' + r.sid;
    const prior = bySource.get(key);
    if (prior) {
      refuse('MULTIPLE_ROWS_PER_SOURCE', 'two files.jsonl rows resolve to the same (variant, sid); they would overwrite each other under one identity', { variant: r.variant, firstRow: prior.index, secondRow: r.index });
    }
    bySource.set(key, r);
  }

  // ⑦ 共享分片对：同一个 (wordOut,sumOut) 被两行声明 → 字节只有一份，谁的不推断
  const pairOwners = new Map();
  for (const r of rows) {
    const owners = pairOwners.get(r.pairKey) || [];
    owners.push(r);
    pairOwners.set(r.pairKey, owners);
  }
  const sharedPairKeys = new Set();
  for (const [pairKey, owners] of pairOwners) if (owners.length > 1) sharedPairKeys.add(pairKey);
  stat.sharedPairs = sharedPairKeys.size;
  stat.sharedRows = rows.filter((r) => sharedPairKeys.has(r.pairKey)).length;

  // ⑧ override（可选）：只在需要时读，用之前逐条核
  let overrides = null;
  if (o.overridePath !== undefined && o.overridePath !== null && o.overridePath !== '') {
    const overrideAbs = path.resolve(String(o.overridePath));
    if (!fs.existsSync(overrideAbs)) refuse('OVERRIDE_INVALID', '--override file does not exist');
    overrides = readOverrideManifest(overrideAbs);
  }
  if (sharedPairKeys.size > 0) {
    const missing = [];
    for (const r of rows) {
      if (!sharedPairKeys.has(r.pairKey)) continue;
      const key = r.variant + '\u0000' + r.sidSha256;
      if (!overrides || !overrides.entries.has(key)) missing.push(r);
    }
    if (missing.length > 0) {
      refuse('SHARED_SHARD_PAIR_NO_OVERRIDE',
        'a (wordOut,sumOut) pair is declared by more than one files.jsonl row: the frozen snapshot keeps only the overwriting bytes, so which variant those rows belong to cannot be inferred. Provide an --override manifest naming a rebuilt shard pair per (variant, sid); nothing was written',
        {
          sharedPairs: sharedPairKeys.size,
          rowsInSharedPairs: stat.sharedRows,
          rowsNeedingOverride: missing.length,
          overridesProvided: overrides ? overrides.count : 0,
        });
    }
  }

  // ⑨ 逐源读分片 → 组装 keeper 的 sources[]
  const sources = [];
  const counts = { words: 0, summaries: 0, v3: 0, v4: 0, overridesApplied: 0, overriddenRowCountDiffers: 0 };
  const usedPairs = new Map();
  for (const r of rows) {
    const sid = r.sid;
    const ov = overrides ? overrides.entries.get(r.variant + '\u0000' + r.sidSha256) : undefined;
    // 共享对上的每一行都已被第 ⑧ 步判定"必须有 override"，所以这里不需要再问一次
    // inSharedGroup —— 再问一遍会写出一条跑不到的分支。
    let wordRows;
    let sumRows;
    let wordPathForFile;
    let sumPathForFile;
    // ★ override 对**任何**源都生效（不只是共享对）：一份被修好的分片也是合法输入。
    //   共同条件是同一套：hash 与行数在用之前都要核。
    // ★ 变体是查表的键（variant + sid hash），所以"变体写错"不会命中 —— 它落成
    //   SHARED_SHARD_PAIR_NO_OVERRIDE（共享对没被命名）或 OVERRIDE_UNUSED_ENTRY
    //   （申报了却没被用上）。不写永远跑不到的分支。
    if (ov) {
      ov.used = true;
      const w = verifyOverrideShard(ov.wordAbs, ov.wordSha256, ov.wordRows, 'words');
      const s = verifyOverrideShard(ov.sumAbs, ov.sumSha256, ov.sumRows, 'summaries');
      wordRows = w.rows;
      sumRows = s.rows;
      wordPathForFile = ov.wordFile;
      sumPathForFile = ov.sumFile;
      counts.overridesApplied += 1;
      // 被覆盖的那份分片是别人的，所以原声明的计数属于别人 —— 差异只计数，不静默也不改写别人。
      if (r.row.nWord !== wordRows.length || r.row.nSum !== sumRows.length) counts.overriddenRowCountDiffers += 1;
    } else {
      const wordRel = mapDeclaredToSnapshot(r.row.wordOut, snapshotAbs, snap.sourceRoot);
      if (wordRel === null) refuse('SHARD_UNMAPPABLE', 'a files.jsonl row wordOut cannot be located inside the snapshot (neither snapshot-relative nor under manifest.sourceRoot)', { row: r.index });
      const sumRel = mapDeclaredToSnapshot(r.row.sumOut, snapshotAbs, snap.sourceRoot);
      if (sumRel === null) refuse('SHARD_UNMAPPABLE', 'a files.jsonl row sumOut cannot be located inside the snapshot (neither snapshot-relative nor under manifest.sourceRoot)', { row: r.index });
      const wordRec = snap.byRel.get(wordRel);
      if (!wordRec) refuse('SHARD_NOT_IN_MANIFEST', 'a shard declared by files.jsonl is not listed in the snapshot manifest', { row: r.index, role: 'words' });
      const sumRec = snap.byRel.get(sumRel);
      if (!sumRec) refuse('SHARD_NOT_IN_MANIFEST', 'a shard declared by files.jsonl is not listed in the snapshot manifest', { row: r.index, role: 'summaries' });
      const wordFile = readVerifiedSnapshotFile(snapshotAbs, wordRec, 'SHARD');
      const sumFile = readVerifiedSnapshotFile(snapshotAbs, sumRec, 'SHARD');
      wordRows = readJsonlStrict(wordFile.bytes, 'words shard').rows;
      sumRows = readJsonlStrict(sumFile.bytes, 'summaries shard').rows;
      wordPathForFile = wordFile.rel;
      sumPathForFile = sumFile.rel;
      // 非共享源：行声明的计数必须与实际分片行数一致。不一致 = 冻结那一刻索引与分片已经
      // 不同步（丢行）—— 此时既不替它改数字，也不替它猜哪一边对，拒。
      if (wordRows.length !== r.row.nWord || sumRows.length !== r.row.nSum) {
        refuse('SHARD_ROW_COUNT_MISMATCH', 'a shard row count differs from the count its files.jsonl row declares (the snapshot drifted; refusing rather than rewriting the declaration)', {
          row: r.index, declaredWords: r.row.nWord, actualWords: wordRows.length, declaredSummaries: r.row.nSum, actualSummaries: sumRows.length,
        });
      }
    }

    // 字段集 + 会话归属：分片里的行必须属于这个 sid（否则就是两个会话混进一个身份）
    for (let i = 0; i < wordRows.length; i += 1) {
      const w = wordRows[i];
      const fk = fieldKey(w);
      if (fk !== SET_WORD && fk !== SET_WORD_ROLE) refuse('SHARD_FIELD_SET', 'a words shard row field set is neither ECHO_INDEX_WORD_FIELDS nor ECHO_INDEX_WORD_FIELDS_WITH_ROLE', { row: r.index, line: i + 1 });
      if (w.session !== sid) refuse('SHARD_SESSION_MISMATCH', 'a words shard row belongs to a different session than the files.jsonl row that declares it (refusing to merge sessions under one identity)', { row: r.index, line: i + 1 });
      if (w.log !== null && typeof w.log !== 'string') refuse('SHARD_FIELD_SET', 'a words shard row log must be a string or null', { row: r.index, line: i + 1 });
    }
    for (let i = 0; i < sumRows.length; i += 1) {
      const s = sumRows[i];
      if (fieldKey(s) !== SET_SUM) refuse('SHARD_FIELD_SET', 'a summaries shard row field set is not exactly ECHO_INDEX_SUMMARY_FIELDS', { row: r.index, line: i + 1 });
      if (s.session !== sid) refuse('SHARD_SESSION_MISMATCH', 'a summaries shard row belongs to a different session than the files.jsonl row that declares it', { row: r.index, line: i + 1 });
      if (s.log !== null && typeof s.log !== 'string') refuse('SHARD_FIELD_SET', 'a summaries shard row log must be a string or null', { row: r.index, line: i + 1 });
    }
    // 一个源行只能有一个工作区（builder 按文件把行归到源上，混 ws 会被它拒 —— 这里先说清）
    const fileWs = r.row.ws;
    if (wordRows.length > 0 && fileWs !== null) {
      for (let i = 0; i < wordRows.length; i += 1) {
        if (wordRows[i].ws !== null && wordRows[i].ws !== fileWs) {
          refuse('WORKSPACE_MIXED', 'a words shard row declares a different ws than its files.jsonl row; one source cannot span two workspaces', { row: r.index, line: i + 1 });
        }
      }
    }

    const pairKeyNow = ci(norm(wordPathForFile)) + '\u0000' + ci(norm(sumPathForFile));
    if (usedPairs.has(pairKeyNow)) refuse('OVERRIDE_PAIR_STILL_SHARED', 'two sources still resolve to the same shard pair after overrides; the ambiguity was not resolved');
    usedPairs.set(pairKeyNow, true);

    const fileRow = {
      file: r.row.file, key: r.row.key, nextByte: r.row.nextByte, ws: r.row.ws, sid,
      nSum: sumRows.length, nWord: wordRows.length,
      sumOut: sumPathForFile, wordOut: wordPathForFile,
    };
    sources.push({
      sourceVersion: r.variant,
      sid,
      namespace: NAMESPACE_BY_VARIANT[r.variant],
      files: [fileRow],
      words: wordRows,
      summaries: sumRows,
    });
    counts.words += wordRows.length;
    counts.summaries += sumRows.length;
    if (r.variant === 'v3') counts.v3 += 1; else counts.v4 += 1;
  }
  // ⑩ 申报了却没用上的 override 条目：有人以为它生效了。这也是"我以为核过了"的形状 → 拒。
  if (overrides) {
    for (const e of overrides.entries.values()) {
      if (!e.used) refuse('OVERRIDE_UNUSED_ENTRY', 'an override entry does not match any source that needs one (variant + sid hash not found among the shared pairs); refusing rather than silently ignoring it', { variant: e.variant });
    }
  }

  const provenance = {
    format: OUTPUT_FORMAT,
    producer: PRODUCER_VERSION,
    snapshotDigest: snap.manifest.snapshotDigest,
    filesRows: stat.filesRows,
    sources: sources.length,
    variants: { v3: counts.v3, v4: counts.v4 },
    words: counts.words,
    summaries: counts.summaries,
    sharedPairs: stat.sharedPairs,
    overridesApplied: counts.overridesApplied,
  };
  const bytes = Buffer.from(JSON.stringify({ sources, provenance }) + '\n', 'utf8');
  // 私有正文落盘：0o600 + 'wx'（永不覆盖）。写完读回核哈希 —— 报告的哈希必须是盘上的字节。
  const fd = fs.openSync(outAbs, 'wx', 0o600);
  try {
    fs.writeSync(fd, bytes, 0, bytes.length, 0);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const onDisk = fs.readFileSync(outAbs);
  const outputSha256 = sha256(onDisk);
  if (outputSha256 !== sha256(bytes)) refuse('OUT_WRITE_MISMATCH', 'the written file does not hash to the bytes handed to the disk', undefined, EXIT.io);
  try { fs.chmodSync(outAbs, 0o600); } catch { /* Windows 上 mode 基本是 no-op，尽力而为 */ }

  const tmpRoot = realOf(os.tmpdir());
  return {
    ok: true,
    out: outAbs,
    outputSha256,
    outputBytes: onDisk.length,
    outputFormat: OUTPUT_FORMAT,
    sources: sources.length,
    words: counts.words,
    summaries: counts.summaries,
    filesRows: stat.filesRows,
    variants: { v3: counts.v3, v4: counts.v4 },
    sharedPairs: stat.sharedPairs,
    overridesApplied: counts.overridesApplied,
    overriddenRowCountDiffers: counts.overriddenRowCountDiffers,
    snapshotDigest: snap.manifest.snapshotDigest,
    // 提示（不拒）：keeper 默认只吃 os.tmpdir() 下的输入。落在 TEMP 外它会在 TEMP_ONLY 拒。
    underOsTmpdir: tmpRoot !== null && insideStrict(outAbs, tmpRoot),
  };
}

// ── CLI ────────────────────────────────────────────────────────────────
const FLAGS = Object.freeze({
  '--snapshot-dir': 'snapshotDir', '--out': 'out', '--out-dir': 'outDir', '--override': 'overridePath',
});
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
  for (const [flag, key] of Object.entries(FLAGS)) {
    if (key === 'overridePath') continue;
    if (opts[key] === undefined) refuse('USAGE_MISSING_ARG', 'missing required argument: ' + flag, undefined, EXIT.usage);
  }
  return opts;
}
export function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(USAGE);
    return EXIT.ok;
  }
  const result = produceImportInput(opts);
  // 只回计数与哈希：没有路径、没有 sid、没有正文。
  console.log(JSON.stringify({
    ok: result.ok,
    outputSha256: result.outputSha256,
    outputBytes: result.outputBytes,
    sources: result.sources,
    words: result.words,
    summaries: result.summaries,
    filesRows: result.filesRows,
    variants: result.variants,
    sharedPairs: result.sharedPairs,
    overridesApplied: result.overridesApplied,
    overriddenRowCountDiffers: result.overriddenRowCountDiffers,
    snapshotDigest: result.snapshotDigest,
    underOsTmpdir: result.underOsTmpdir,
  }));
  return EXIT.ok;
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    const code = String((e && e.code) || 'PRODUCER_REFUSED');
    const exitCode = (e && e.exitCode) || (/^USAGE_/.test(code) ? EXIT.usage : EXIT.refused);
    const out = { ok: false, code, exitCode };
    if (e && e.detail !== undefined) out.detail = e.detail;
    console.error(JSON.stringify(out));
    process.exitCode = exitCode;
  }
}
