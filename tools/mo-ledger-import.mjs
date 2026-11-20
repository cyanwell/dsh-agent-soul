#!/usr/bin/env node
// tools/mo-ledger-import.mjs —— 隔离的 v8「墨」JSONL 导入器（legacy → mo_ledger）
// ============================================================================
// 只做一件事：把**一份显式指定的**旧账本 JSONL 逐行导进**显式指定的**一个 SQLite 库里
// 的 mo_ledger，并留下一行 mo_import_batches 作为批次凭据。
//
// ★ 为什么这么窄：这是一次性迁移工具，不是服务，不是 API，不猜任何默认值。
//   没有 --source / --sha256 / --db 就什么都不做（连库都不打开）。
//
// ── 契约（逐条对应，别改口径）──────────────────────────────────────────────
//   1. 源文件**只读一次字节**；SHA-256 在**解析之前**与 --sha256 比对（必须小写 64 hex）。
//   2. 严格 UTF-8（TextDecoder fatal:true；有坏字节就拒，不静默替换成 U+FFFD）。
//   3. 文件必须以 LF 结尾（没有 = 写入中断过的证据，拒）。
//   4. 行号是**物理行号**（1 起）。空行（含纯空白行）**计数、跳过**，但仍占一个物理行号。
//   5. **先把所有行解析并校验完**，任何一行不合格 → 整批拒，一个字节都不写。
//   6. t / type / by / ref / feel / byUser 一律**按原值语义**入库：不 trim、不改大小写、
//      不把 8 字符的 by 还原成 UUID（actor_session 恒为 NULL，绝不从 by 推断）。
//   7. legacy_raw = 该物理行去掉 LF 终止符后的**完整字节解码文本**（CRLF 文件连 CR 一起留），
//      legacy_line = 物理行号。⇒ **每一条入库行都能逐字节回到源文件的那一行**。
//      ★ 整文件重建**不**保证：空行不入库（只计数），所以空行原文（'' vs '   '）不在这张表里。
//   8. 批次行 + 全部账本行在**同一个事务**里；任何失败整体回滚，并复读计数证明没变。
//   9. 同一个源 SHA 不许导入第二次（批次表 UNIQUE + 插入前预检）。
//  10. 目标库必须**已经**具备 v8 结构；本工具**从不迁移、从不建表**。
//      缺结构 → SCHEMA_DELTA_REQUIRED，并把需要的**结构清单**打出来（见 V8_REQUIRED_SCHEMA）。
//      ★ 清单只说结构，不复制 SQL：DDL 的唯一来源是 src/db/schema.mjs 的 MIGRATION_008_SQL。
//
// ── 硬护栏（不协商）────────────────────────────────────────────────────────
//   · 源 = D:/AI/yanqing-soul/02-墨.jsonl（解析到真路径后比较）→ 拒。
//   · 目标 = config.dataDir/meta.sqlite、config.memory.libraryDir/indexFile、
//     或 config.soul.root 子树里的任何文件 → 拒。config.json 读不到 → 也拒（fail-closed，
//     不因为"证明不了它是生产库"就放行）。只读 dataDir / memory / soul 三个键，不碰任何秘密。
//   · 目标 = :memory: → 拒（批次凭据必须能事后复核）。
//   · 目标文件不存在 → 拒（不替人建库；建库/迁移是另一个决定）。
//
// ── 与闸门的关系（v8 已经把语义说清，本工具照它做）──────────────────────────
//   v6 的 mo_ledger 有三个 BEFORE INSERT 触发器；v8（src/db/schema.mjs MIGRATION_008）
//   把它们按**权威口径**收窄，而不是绕过：
//     mo_ledger_lead_requires_ref / _lead_generation  只约束 import_batch_id IS NULL 的行
//     mo_ledger_promise_gate                          只比较 import_batch_id IS NULL 的 lead
//   为什么这是对的、不是放水：**导入行是溯源，不是「现在」**。
//     · 导入行的 actor_session 恒 NULL（契约，绝不从 8 字符 by 反推），所以它写不出承诺；
//     · 导入的 lead 行不参与「谁是当前主导」——store.latestLead()/ledgerStats().latestLead
//       与 organs/ledger.currentLead() 都只认本机写入的行；
//     · 于是 8 类（含历史 lead / 历史 promise）都能逐字入库，而**当前权威一夜不变**。
//   ★ 本工具仍然不迁移、不建表：结构不在就拒（SCHEMA_DELTA_REQUIRED），并说清缺什么。
//
// ── 用法 ───────────────────────────────────────────────────────────────────
//   node tools/mo-ledger-import.mjs --source <file> --sha256 <64 lowercase hex> --db <file>
//                                   [--dry-run] [--json]
//   退出码：0 成功 / 2 用法 / 3 拒绝（源、行、护栏）/ 4 schema / 5 IO / 6 写库失败
//   输出：一个 JSON 回执（--json 时单行）；人读模式下 pretty-print 同一个对象。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openMetaStore, SCHEMA_VERSION } from '../src/db/index.mjs';

export const IMPORT_TYPES = Object.freeze(['lead', 'promise', 'fact', 'shelved', 'gain', 'loss', 'persona', 'container']);
export const PRODUCTION_LEDGER = 'D:/AI/yanqing-soul/02-墨.jsonl';
export const IMPORTER_VERSION = 'mo-ledger-import/2';

const SHA_RE = /^[0-9a-f]{64}$/;
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// 缺的这些结构就是 v8 补的。**这不是可选项**：没有它们，批次凭据无处可写，重复 SHA 也无法在库层被拒。
// ★ 这里只描述**结构**，不复制 DDL 文本：SQL 的唯一来源是 src/db/schema.mjs 的 MIGRATION_008_SQL。
//   两处各存一份 SQL，迟早一份改了另一份没改 —— 那正是最难查的一类错。
export const V8_REQUIRED_SCHEMA = [
  'migration v8 (src/db/schema.mjs, name "mo-import-provenance") is required:',
  '  · mo_ledger is rebuilt with a nullable import_batch_id -> mo_import_batches(batch_id)',
  '  · UNIQUE (import_batch_id, legacy_line)   -- per batch; the v6 global UNIQUE is gone',
  '  · mo_import_batches(batch_id, source_path, source_sha256 UNIQUE, source_bytes,',
  '                     physical_lines, blank_lines, rows_imported, imported_at, importer)',
  '  · append-only batch triggers (MO_IMPORT_BATCH_APPEND_ONLY on UPDATE / DELETE)',
  '  · row guards: MO_IMPORT_ACTOR_FORBIDDEN / MO_IMPORT_ROW_INCOMPLETE / MO_IMPORT_BATCH_REQUIRED',
  '  · promise gate + lead ref/generation guards keyed on import_batch_id IS NULL',
].join('\n');

// 已在 v8 解决、因此**不再拒绝**的两件事（写在回执里，让读回执的人知道口径变了）：
//   1. legacy_line 不再是全局 UNIQUE ⇒ 同一个库可以装多份源（多源重叠行号合法）。
//   2. 历史 lead / 历史 promise 可以入库，因为它们不参与「当前主导」的判定。
// 不变的两条：重复 SHA 仍拒（批次表 UNIQUE），源行永远不是当前权威。

const EXIT = { ok: 0, usage: 2, refused: 3, schema: 4, io: 5, write: 6 };

export class ImportRefusal extends Error {
  constructor(code, message, detail, exit) {
    super(message);
    this.name = 'ImportRefusal';
    this.code = code;
    this.detail = detail === undefined ? null : detail;
    this.exit = typeof exit === 'number' ? exit : EXIT.refused;
  }
}

const refuse = (code, message, detail, exit) => { throw new ImportRefusal(code, message, detail, exit); };

// ── 路径 ──────────────────────────────────────────────────────────────────
function normPath(p) {
  let s = path.resolve(String(p));
  try { s = fs.realpathSync.native(s); } catch { /* 不存在：用解析后的绝对路径比较 */ }
  return s.replace(/\\/g, '/').toLowerCase();
}

// 只读三个键：dataDir / memory / soul。config 读不到就不放行（fail-closed）。
function productionTargets() {
  const cfgPath = path.join(REPO_ROOT, 'config.json');
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch (err) {
    refuse('CONFIG_UNREADABLE', 'cannot derive production paths: config.json unreadable at ' + cfgPath
      + ' (' + (err && err.message) + '). Refusing to guess a destination.', { configPath: cfgPath }, EXIT.io);
  }
  const abs = (p) => (path.isAbsolute(String(p)) ? String(p) : path.join(REPO_ROOT, String(p)));
  const out = [];
  const dataDir = abs(cfg.dataDir || 'data');
  out.push({ code: 'DB_IS_PRODUCTION_META', why: 'config.dataDir/meta.sqlite', file: path.join(dataDir, 'meta.sqlite') });
  const mem = cfg.memory && typeof cfg.memory === 'object' ? cfg.memory : {};
  if (mem.libraryDir) {
    out.push({ code: 'DB_IS_PRODUCTION_META', why: 'config.memory.libraryDir/indexFile', file: path.join(abs(mem.libraryDir), mem.indexFile || 'meta.sqlite') });
  }
  const soulRoot = cfg.soul && cfg.soul.root ? abs(cfg.soul.root) : 'D:/AI/yanqing-soul';
  out.push({ code: 'DB_IS_PRODUCTION_SOUL_ROOT', why: 'config.soul.root (entire subtree is production)', file: soulRoot, subtree: true });
  return out;
}

function guardSource(sourceArg) {
  if (!sourceArg) refuse('USAGE_MISSING_ARG', 'missing required --source <file>', null, EXIT.usage);
  const abs = path.resolve(sourceArg);
  // 生产账本的判据放在"存在吗"之前：即使路径当前不存在，这个目标也一律拒，
  // 不靠"文件刚好在不在"来决定要不要放行。
  if (normPath(abs) === normPath(PRODUCTION_LEDGER)) {
    refuse('SOURCE_IS_PRODUCTION_LEDGER',
      'refusing to read the production ledger ' + PRODUCTION_LEDGER + ' (pass an explicit copy instead)', { source: abs });
  }
  if (!fs.existsSync(abs)) refuse('SOURCE_NOT_FOUND', 'source file does not exist: ' + abs, { source: abs }, EXIT.io);
  const st = fs.statSync(abs);
  if (!st.isFile()) refuse('SOURCE_NOT_FILE', 'source is not a regular file: ' + abs, { source: abs }, EXIT.io);
  return abs;
}

function guardDestination(dbArg, sourceAbs) {
  if (!dbArg) refuse('USAGE_MISSING_ARG', 'missing required --db <file>', null, EXIT.usage);
  if (dbArg === ':memory:' || String(dbArg).startsWith('file::memory:')) {
    refuse('DB_IS_MEMORY', 'destination must be a real file so the batch receipt survives the process (got ' + dbArg + ')');
  }
  const abs = path.resolve(dbArg);
  const nAbs = normPath(abs);
  if (sourceAbs && nAbs === normPath(sourceAbs)) refuse('DB_IS_SOURCE', 'destination equals the source file: ' + abs, { db: abs });
  for (const t of productionTargets()) {
    const nT = normPath(t.file);
    if (nAbs === nT || (t.subtree && nAbs.startsWith(nT.endsWith('/') ? nT : nT + '/'))) {
      refuse(t.code, 'refusing production destination ' + abs + ' (= ' + t.why + ')', { db: abs, rule: t.code, production: t.file });
    }
  }
  if (!fs.existsSync(abs)) {
    refuse('DB_NOT_FOUND', 'destination database does not exist: ' + abs
      + ' (this importer never creates or migrates a database)', { db: abs }, EXIT.io);
  }
  if (!fs.statSync(abs).isFile()) refuse('DB_NOT_FILE', 'destination is not a regular file: ' + abs, { db: abs }, EXIT.io);
  return abs;
}

// ── 读源（一次字节）────────────────────────────────────────────────────────
function readSourceOnce(abs) {
  let bytes;
  try { bytes = fs.readFileSync(abs); } catch (err) {
    refuse('SOURCE_READ_FAILED', 'cannot read source: ' + (err && err.message), { source: abs }, EXIT.io);
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { bytes, sha256 };
}

function decodeStrict(bytes) {
  if (bytes.length === 0) refuse('SOURCE_EMPTY', 'source file is empty (0 bytes)', { bytes: 0 });
  if (bytes.length >= 3 && bytes[0] === BOM[0] && bytes[1] === BOM[1] && bytes[2] === BOM[2]) {
    refuse('SOURCE_HAS_BOM', 'source starts with a UTF-8 BOM; strip it first — this importer never drops bytes silently');
  }
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  try { return decoder.decode(bytes); } catch (err) {
    refuse('SOURCE_INVALID_UTF8', 'source is not valid UTF-8: ' + (err && err.message), null);
  }
}

// ── 行 → 记录（纯函数，不碰库）──────────────────────────────────────────────
function bodyOf(record, lineNo) {
  const hasK = Object.prototype.hasOwnProperty.call(record, '概要');
  const hasT = Object.prototype.hasOwnProperty.call(record, 'text');
  if (hasK && record['概要'] !== undefined && record['概要'] !== null) {
    if (typeof record['概要'] !== 'string') {
      refuse('ROW_FIELD_INVALID', 'line ' + lineNo + ': 概要 must be a string', { line: lineNo, field: '概要', got: typeof record['概要'] });
    }
    return { text: record['概要'], field: '概要' };
  }
  if (hasT && record.text !== undefined && record.text !== null) {
    if (typeof record.text !== 'string') {
      refuse('ROW_FIELD_INVALID', 'line ' + lineNo + ': text must be a string', { line: lineNo, field: 'text', got: typeof record.text });
    }
    return { text: record.text, field: 'text' };
  }
  refuse('ROW_BODY_MISSING', 'line ' + lineNo + ': body missing (need a non-blank 概要 or text)', { line: lineNo });
}

function optionalString(record, key, lineNo) {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return null;
  const v = record[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') {
    refuse('ROW_FIELD_INVALID', 'line ' + lineNo + ': ' + key + ' must be a string or absent', { line: lineNo, field: key, got: typeof v });
  }
  return v;
}

function rowFrom(lineNo, rawLine) {
  const jsonText = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
  let record;
  try { record = JSON.parse(jsonText); } catch (err) {
    refuse('ROW_JSON_INVALID', 'line ' + lineNo + ': malformed JSON (' + (err && err.message) + ')', { line: lineNo });
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    refuse('ROW_NOT_OBJECT', 'line ' + lineNo + ': expected a JSON object, got '
      + (record === null ? 'null' : Array.isArray(record) ? 'array' : typeof record), { line: lineNo });
  }
  if (!Object.prototype.hasOwnProperty.call(record, 't')) refuse('ROW_FIELD_MISSING', 'line ' + lineNo + ': missing t', { line: lineNo, field: 't' });
  if (typeof record.t !== 'string' || record.t.trim() === '') {
    refuse('ROW_FIELD_INVALID', 'line ' + lineNo + ': t must be a non-empty string', { line: lineNo, field: 't', got: typeof record.t });
  }
  if (!Object.prototype.hasOwnProperty.call(record, 'by')) refuse('ROW_FIELD_MISSING', 'line ' + lineNo + ': missing by', { line: lineNo, field: 'by' });
  if (typeof record.by !== 'string' || record.by.trim() === '') {
    refuse('ROW_FIELD_INVALID', 'line ' + lineNo + ': by must be a non-empty string (empty signature breaks provenance)', { line: lineNo, field: 'by', got: typeof record.by });
  }
  if (!Object.prototype.hasOwnProperty.call(record, 'type')) refuse('ROW_FIELD_MISSING', 'line ' + lineNo + ': missing type', { line: lineNo, field: 'type' });
  if (typeof record.type !== 'string' || IMPORT_TYPES.indexOf(record.type) === -1) {
    refuse('ROW_UNKNOWN_TYPE', 'line ' + lineNo + ': unknown type ' + JSON.stringify(record.type) + ' (allowed: ' + IMPORT_TYPES.join('|') + ')',
      { line: lineNo, got: record.type === undefined ? 'undefined' : String(record.type) });
  }
  const body = bodyOf(record, lineNo);
  if (body.text.trim() === '') refuse('ROW_BODY_BLANK', 'line ' + lineNo + ': body (from ' + body.field + ') is blank', { line: lineNo, field: body.field });

  let byUser = 0;
  if (Object.prototype.hasOwnProperty.call(record, 'byUser') && record.byUser !== null) {
    if (record.byUser !== true && record.byUser !== false) {
      refuse('ROW_FIELD_INVALID', 'line ' + lineNo + ': byUser must be a JSON boolean', { line: lineNo, field: 'byUser', got: typeof record.byUser });
    }
    byUser = record.byUser ? 1 : 0;
  }

  return {
    legacy_line: lineNo,
    legacy_raw: rawLine,
    t: record.t,
    type: record.type,
    text: body.text,
    by: record.by,
    ref: optionalString(record, 'ref', lineNo),
    feel: optionalString(record, 'feel', lineNo),
    by_user: byUser,
  };
}

export function parseSource(text) {
  // 契约要求以 LF 结尾；调用方已验。这里只切物理行。
  const parts = text.split('\n');
  parts.pop(); // 结尾 LF 之后那一格不是一行
  const rows = [];
  let blank = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const rawLine = parts[i];
    const lineNo = i + 1;
    if (rawLine.trim() === '') { blank += 1; continue; }
    rows.push(rowFrom(lineNo, rawLine));
  }
  return { rows, physicalLines: parts.length, blankLines: blank };
}

// ★ 这里**没有**「触发器冲突预判」了：v8 之后 8 类（含历史 lead / 历史 promise）都必须能入库，
//   而 lead 的 ref/代次约束与 promise 闸门都只对 import_batch_id IS NULL 的行生效。
//   ⇒ 「先判会不会撞触发器」这件事本身被消掉了 —— 不是放宽，是把口径写进了库层。

// ── 目标库能力检查（只读；不迁移、不建表）────────────────────────────────────
function inspectSchema(store) {
  const db = store.db;
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
  const cols = tables.has('mo_ledger') ? db.prepare('PRAGMA table_info(mo_ledger)').all().map((c) => c.name) : [];
  const requiredBatchCols = ['batch_id', 'source_path', 'source_sha256', 'source_bytes', 'physical_lines', 'blank_lines', 'rows_imported', 'imported_at', 'importer'];
  const batchCols = tables.has('mo_import_batches') ? db.prepare('PRAGMA table_info(mo_import_batches)').all().map((c) => c.name) : [];
  let shaUnique = false;
  if (tables.has('mo_import_batches')) {
    for (const idx of db.prepare("PRAGMA index_list('mo_import_batches')").all()) {
      if (!idx.unique) continue;
      const colsOf = db.prepare("PRAGMA index_info('" + String(idx.name).replace(/'/g, "''") + "')").all().map((c) => c.name);
      if (colsOf.length === 1 && colsOf[0] === 'source_sha256') { shaUnique = true; break; }
    }
  }
  const missing = [];
  if (!tables.has('mo_ledger')) missing.push('table mo_ledger (v6)');
  else if (cols.indexOf('import_batch_id') === -1) missing.push('column mo_ledger.import_batch_id');
  if (!tables.has('mo_import_batches')) missing.push('table mo_import_batches');
  else {
    for (const c of requiredBatchCols) if (batchCols.indexOf(c) === -1) missing.push('column mo_import_batches.' + c);
    if (!shaUnique) missing.push('UNIQUE(source_sha256) on mo_import_batches');
  }
  const triggers = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='mo_ledger'").all().map((r) => r.name));
  return {
    schemaVersion: (() => {
      try { return Number(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v); } catch { return null; }
    })(),
    codeSchemaVersion: SCHEMA_VERSION,
    missing,
    hasPromiseGate: triggers.has('mo_ledger_promise_gate'),
    triggers: [...triggers].sort(),
  };
}

// 当前权威的快照：**只认 import_batch_id IS NULL 的 lead**（与 store.latestLead() 同一口径）。
// 导入前后逐位相同 —— 「源行永远不是当前权威」这条边界要在这里被真的检查，而不是只写在注释里。
function liveAuthority(db) {
  const row = db.prepare("SELECT row_id, by, actor_session FROM mo_ledger WHERE type='lead' AND import_batch_id IS NULL ORDER BY row_id DESC LIMIT 1").get();
  if (!row) return null;
  return { rowId: Number(row.row_id), by: row.by, actorSession: row.actor_session == null ? null : String(row.actor_session) };
}

function shaAlreadyImported(db, sha256) {
  const row = db.prepare('SELECT batch_id FROM mo_import_batches WHERE source_sha256 = ?').get(sha256);
  return row ? Number(row.batch_id) : null;
}

// ── 主流程 ────────────────────────────────────────────────────────────────
export function runImport(argv) {
  const opts = { source: null, sha256: null, db: null, dryRun: false, json: false };
  const takesValue = { '--source': 'source', '--sha256': 'sha256', '--db': 'db' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i]);
    if (takesValue[a]) {
      const v = argv[i + 1];
      if (v === undefined || String(v).startsWith('--')) refuse('USAGE_MISSING_ARG', 'missing value for ' + a, null, EXIT.usage);
      opts[takesValue[a]] = String(v);
      i += 1;
    } else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--json') opts.json = true;
    else refuse('USAGE_UNKNOWN_FLAG', 'unknown argument: ' + a, null, EXIT.usage);
  }
  for (const key of ['source', 'sha256', 'db']) {
    if (!opts[key]) refuse('USAGE_MISSING_ARG', 'missing required --' + key, { missing: key }, EXIT.usage);
  }
  if (!SHA_RE.test(opts.sha256)) {
    refuse('USAGE_BAD_SHA', '--sha256 must be exactly 64 lowercase hex chars (got ' + JSON.stringify(opts.sha256) + ')',
      { got: opts.sha256, length: opts.sha256.length }, EXIT.usage);
  }

  // ① 源护栏 → 读一次字节 → 先比 SHA
  const sourceAbs = guardSource(opts.source);
  const { bytes, sha256 } = readSourceOnce(sourceAbs);
  if (sha256 !== opts.sha256) {
    refuse('SOURCE_HASH_MISMATCH', 'source SHA-256 does not match --sha256 (refusing before parsing)', {
      expected: opts.sha256, actual: sha256, bytes: bytes.length, source: sourceAbs,
    });
  }
  // ② 解码 + 结尾 LF
  const text = decodeStrict(bytes);
  if (bytes[bytes.length - 1] !== 0x0a) {
    refuse('SOURCE_NO_FINAL_LF', 'source does not end with LF (byte 0x0a); a missing terminator is the signature of a truncated write', {
      lastByte: bytes[bytes.length - 1],
    });
  }
  // ③ 全量解析 + 逐行校验（事务之前）
  const parsed = parseSource(text);
  if (parsed.rows.length === 0) {
    refuse('ZERO_ROWS', 'source contains no data rows (' + parsed.physicalLines + ' physical lines, all blank/skipped)', {
      physicalLines: parsed.physicalLines, blankLines: parsed.blankLines,
    });
  }
  // ④ 目标护栏 → 打开（不迁移）→ 结构能力检查
  const dbAbs = guardDestination(opts.db, sourceAbs);
  let store;
  try {
    store = openMetaStore({ path: dbAbs, mode: 'readwrite' });
  } catch (err) {
    refuse('DB_OPEN_FAILED', 'cannot open destination database: ' + (err && err.message), { db: dbAbs, code: err && err.code }, EXIT.io);
  }
  try {
    // ★ 目标不是 v8：ensureReady() 会先拒（版本不够 / 比代码新 / 迁移史断裂）。
    //   那不是「连接失败」，而是「目标缺结构」—— 翻译成同一个可执行的回执码，别让人看到裸栈。
    try {
      store.ensureReady();
    } catch (err) {
      const code = err && err.code;
      if (code === 'MIGRATION_REQUIRED') {
        refuse('SCHEMA_DELTA_REQUIRED',
          'destination is at schema v' + (err.details && err.details.current) + ', code expects v' + SCHEMA_VERSION
            + '. Apply migration v8 first — this importer never migrates.',
          { missing: ['migration v8'], schema: { version: err.details && err.details.current, code: SCHEMA_VERSION }, requiredSchema: V8_REQUIRED_SCHEMA }, EXIT.schema);
      }
      if (code === 'SCHEMA_TOO_NEW' || code === 'MIGRATION_HISTORY_BROKEN') {
        refuse(code, 'destination schema is not usable for this import: ' + (err && err.message),
          { schema: { version: err.details && err.details.current, code: SCHEMA_VERSION }, requiredSchema: V8_REQUIRED_SCHEMA }, EXIT.schema);
      }
      throw err;
    }
    const schema = inspectSchema(store);
    if (schema.missing.length > 0) {
      refuse('SCHEMA_DELTA_REQUIRED',
        'destination lacks the v8 import structures: ' + schema.missing.join('; ') + '. Apply migration v8 first — this importer never migrates.',
        { missing: schema.missing, schema: { version: schema.schemaVersion, code: SCHEMA_VERSION }, requiredSchema: V8_REQUIRED_SCHEMA }, EXIT.schema);
    }
    const dupBatch = shaAlreadyImported(store.db, sha256);
    if (dupBatch !== null) {
      refuse('DUPLICATE_SOURCE_SHA', 'this source SHA-256 was already imported as batch ' + dupBatch, { source_sha256: sha256, batch_id: dupBatch });
    }
    // ★ 多源：同一个库可以装多份源，行号允许重叠 —— UNIQUE 是 (import_batch_id, legacy_line)。
    //   这里**不再**检查「库里已有导入行」：那是 v6 全局 UNIQUE 时代的临时限制，v8 取消了。
    const authorityBefore = liveAuthority(store.db);
    const countsBefore = {
      ledger: Number(store.db.prepare('SELECT COUNT(*) AS n FROM mo_ledger').get().n),
      batches: Number(store.db.prepare('SELECT COUNT(*) AS n FROM mo_import_batches').get().n),
    };

    if (opts.dryRun) {
      return {
        ok: true, code: 'VALIDATED', dryRun: true,
        source: { path: sourceAbs, sha256, bytes: bytes.length, physicalLines: parsed.physicalLines, blankLines: parsed.blankLines, rows: parsed.rows.length },
        db: { path: dbAbs, schemaVersion: schema.schemaVersion, codeSchemaVersion: SCHEMA_VERSION },
        rowsByType: countByType(parsed.rows),
        countsBefore, countsAfter: countsBefore,
        authority: { before: authorityBefore, after: authorityBefore },
      };
    }

    const importedAt = new Date().toISOString();
    const insertBatch = store.db.prepare([
      'INSERT INTO mo_import_batches',
      '(source_path, source_sha256, source_bytes, physical_lines, blank_lines, rows_imported, imported_at, importer)',
      'VALUES (?,?,?,?,?,?,?,?)',
    ].join(' '));
    const insertRow = store.db.prepare([
      'INSERT INTO mo_ledger',
      '(t, type, text, by, actor_session, ref, feel, by_user, legacy_line, legacy_raw, import_batch_id)',
      'VALUES (?,?,?,?,NULL,?,?,?,?,?,?)',
    ].join(' '));

    let batchId = null;
    let rowIds = [];
    store.db.exec('BEGIN IMMEDIATE');
    try {
      const res = insertBatch.run(sourceAbs, sha256, bytes.length, parsed.physicalLines, parsed.blankLines, parsed.rows.length, importedAt, IMPORTER_VERSION);
      batchId = Number(res.lastInsertRowid);
      for (const r of parsed.rows) {
        const ins = insertRow.run(r.t, r.type, r.text, r.by, r.ref, r.feel, r.by_user, r.legacy_line, r.legacy_raw, batchId);
        rowIds.push(Number(ins.lastInsertRowid));
      }
      // 提交前自检：数量、行号集合、actor_session 全空、raw 可重建
      const seen = store.db.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT legacy_line) AS d, MIN(legacy_line) AS lo, MAX(legacy_line) AS hi FROM mo_ledger WHERE import_batch_id = ?').get(batchId);
      const withActor = store.db.prepare('SELECT COUNT(*) AS n FROM mo_ledger WHERE import_batch_id = ? AND actor_session IS NOT NULL').get(batchId).n;
      const rawOk = store.db.prepare('SELECT COUNT(*) AS n FROM mo_ledger WHERE import_batch_id = ? AND legacy_raw IS NOT NULL').get(batchId).n;
      if (Number(seen.n) !== parsed.rows.length || Number(seen.d) !== parsed.rows.length
        || Number(seen.lo) !== parsed.rows[0].legacy_line || Number(seen.hi) !== parsed.rows[parsed.rows.length - 1].legacy_line
        || Number(withActor) !== 0 || Number(rawOk) !== parsed.rows.length) {
        refuse('IMPORT_VERIFY_FAILED', 'post-insert verification failed inside the transaction', {
          expectedRows: parsed.rows.length, seen: { rows: Number(seen.n), distinctLines: Number(seen.d), lo: Number(seen.lo), hi: Number(seen.hi), withActor: Number(withActor), withRaw: Number(rawOk) },
        }, EXIT.write);
      }
      // ★ 边界：导入**不得**改变当前权威。历史 lead 行只进溯源，不进「现在」——
      //   如果这一批把 live lead 换掉了，那就是口径破了，整批回滚（不是「记一笔继续」）。
      const authorityInTx = liveAuthority(store.db);
      if (JSON.stringify(authorityInTx) !== JSON.stringify(authorityBefore)) {
        refuse('IMPORT_AUTHORITY_CHANGED', 'this batch would change the live lead; refusing the whole batch (nothing written)',
          { before: authorityBefore, after: authorityInTx }, EXIT.write);
      }
      store.db.exec('COMMIT');
    } catch (err) {
      try { store.db.exec('ROLLBACK'); } catch { /* 可能已回滚 */ }
      if (err instanceof ImportRefusal) throw err;
      refuse('IMPORT_WRITE_FAILED', 'write failed and was rolled back: ' + (err && err.message), { sqlite: err && err.code }, EXIT.write);
    }

    const countsAfter = {
      ledger: Number(store.db.prepare('SELECT COUNT(*) AS n FROM mo_ledger').get().n),
      batches: Number(store.db.prepare('SELECT COUNT(*) AS n FROM mo_import_batches').get().n),
    };
    if (countsAfter.ledger !== countsBefore.ledger + parsed.rows.length || countsAfter.batches !== countsBefore.batches + 1) {
      refuse('IMPORT_COUNT_MISMATCH', 'committed counts do not match the parsed batch', { countsBefore, countsAfter, rows: parsed.rows.length }, EXIT.write);
    }
    return {
      ok: true, code: 'IMPORTED',
      source: { path: sourceAbs, sha256, bytes: bytes.length, physicalLines: parsed.physicalLines, blankLines: parsed.blankLines, rows: parsed.rows.length },
      db: { path: dbAbs, schemaVersion: schema.schemaVersion, codeSchemaVersion: SCHEMA_VERSION },
      batch: { id: batchId, importedAt, rowsImported: parsed.rows.length },
      rows: { firstLine: parsed.rows[0].legacy_line, lastLine: parsed.rows[parsed.rows.length - 1].legacy_line, firstRowId: rowIds[0], lastRowId: rowIds[rowIds.length - 1] },
      rowsByType: countByType(parsed.rows),
      countsBefore, countsAfter,
      authority: { before: authorityBefore, after: liveAuthority(store.db) },
    };
  } finally {
    try { if (store && !store.closed) store.close(); } catch { /* 关闭失败不掩盖原错误 */ }
  }
}

function countByType(rows) {
  const out = {};
  for (const r of rows) out[r.type] = (out[r.type] || 0) + 1;
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  let json = argv.indexOf('--json') !== -1;
  let receipt;
  let exitCode = EXIT.ok;
  try {
    receipt = runImport(argv);
  } catch (err) {
    if (err instanceof ImportRefusal) {
      receipt = { ok: false, code: err.code, message: err.message, detail: err.detail };
      exitCode = err.exit;
    } else {
      receipt = { ok: false, code: 'INTERNAL', message: String(err && err.stack ? err.stack : err) };
      exitCode = EXIT.io;
    }
  }
  process.stdout.write((json ? JSON.stringify(receipt) : JSON.stringify(receipt, null, 2)) + '\n');
  process.exitCode = exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();
