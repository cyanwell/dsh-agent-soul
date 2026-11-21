// tools/echo-refusal-classify.mjs
// 只读分类器：把 echo-source-build.mjs 抛出的拒绝，归成「结构化拒绝码 + 原因类别 + 安全代表诊断」。
//
// 为什么要有这一层（2026-11-16 · ECHO Phase 1 切片）：
//   builder 的 fail() 只抛 `new Error(message)` —— message 里没有 .code，
//   于是 sync 干跑（echo-index-production-sync.mjs）里所有 builder 拒绝都被压成一个
//   'Error:UNCLASSIFIED'。运维看不出这是「源库结构不对」「游标不连续」还是「输出目录不干净」。
//
// 三条判据（都可被自检验证，不靠注释自觉）：
//   ① 表里每个前缀都必须在 builder 源码里**逐字存在** —— 不许编造码（自检会扫源码核对）。
//   ② 未命中一律 UNCLASSIFIED：照记数、照拒该源，绝不因为认不出就跳过（fail-closed）。
//   ③ 输出只含静态字面量或净化过的代表（仅 [a-z ]、≤40 字符），**绝不回传 message 原文**
//      —— message 里带绝对路径、会话 id、既有行号，回传等于把数据带进日志。
//
// 分层：本模块只做纯函数 + 报告增量；文件 I/O、快照、TEMP 根都由调用方负责。

export const UNCLASSIFIED_CODE = 'UNCLASSIFIED';
export const UNRECOGNIZED_CATEGORY = 'unrecognized';

// 权威索引收下的 collected refusal（builder 把它们拼进同一条 message）；
// 它们是「语义性拒绝」而不是结构性错误 —— 分类时必须认出，不能被前缀表吞掉。
export const COLLECTED_REFUSAL_PREFIX = 'refusing to build from the authoritative ECHO index: ';
export const COLLECTED_REFUSAL_CODES = Object.freeze(['WORD_SEQ_CONFLICT', 'SUMMARY_ID_CONFLICT', 'SRC_SEQ_DANGLING']);

// sync 干跑自己的拒绝码（fail('SHARD_MISSING') 这类 —— message 就是码本身）。
const LOCAL_CODE_CATEGORY = Object.freeze({
  SHARD_PATH_NOT_ABSOLUTE: 'shard-path',
  SHARD_PATH_OUTSIDE_AUTHORIZED_ROOT: 'shard-path',
  SHARD_MISSING: 'shard-path',
  SHARD_UNAVAILABLE: 'shard-path',
  SOURCE_READ_FAILED: 'source-input',
  INVALID_UTF8: 'source-input',
  JSONL_INVALID: 'source-input',
  UNKNOWN_ARGUMENT: 'argument',
  PRODUCTION_APPLY_NOT_IMPLEMENTED_IN_TASK62: 'argument',
  TEMP_IMPORT_FAILED: 'temp-target',
  TEMP_TARGET_NOT_EMPTY: 'temp-target',
  TEMP_TARGET_NOT_ALIGNED: 'temp-target',
  TEMP_ROOT_CLEANUP_FAILED: 'temp-target',
  SYNC_DRYRUN_FAILED: 'sync-report',
});

// 前缀表：[builder 源码里的字面量前缀, 结构化拒绝码, 原因类别]
// 约束：第一列必须是 echo-source-build.mjs 里 fail(...) 的字面量（或其子串），
// 自检 tools/echo-refusal-classify-selftest.mjs 会逐个 indexOf 核对。
const RULES = [
  // ── 参数/选项守卫 ──────────────────────────────────────────────
  ['missing explicit option ', 'ARG_MISSING_EXPLICIT_OPTION', 'argument'],
  ['unknown argument: ', 'ARG_UNKNOWN', 'argument'],
  ['duplicate argument: ', 'ARG_DUPLICATE', 'argument'],
  ['missing value for ', 'ARG_MISSING_VALUE', 'argument'],
  ['required argument missing: ', 'ARG_REQUIRED_MISSING', 'argument'],
  ['--input is not allowed with --db', 'ARG_INPUT_WITH_DB', 'argument'],
  ['--source-id requires --db', 'ARG_SOURCE_ID_WITHOUT_DB', 'argument'],
  ['--summaries is not allowed with --db', 'ARG_SUMMARIES_WITH_DB', 'argument'],
  ['allowExternalSourceRoot must be a boolean when provided', 'OPT_ALLOW_EXTERNAL_ROOT_NOT_BOOL', 'argument'],
  ['allowReadOnlyExternalInputs is valid only with an explicit selectedLogPath', 'OPT_ALLOW_EXTERNAL_INPUTS_WITHOUT_SELECTED_LOG', 'argument'],
  ['allowReadOnlyExternalInputs must be a boolean', 'OPT_ALLOW_EXTERNAL_INPUTS_NOT_BOOL', 'argument'],
  ['fullRebuild must be a boolean when provided', 'OPT_FULL_REBUILD_NOT_BOOL', 'argument'],
  ['namespace must be log|v4log', 'OPT_NAMESPACE_INVALID', 'argument'],
  ['generation must be safe integer >=1', 'OPT_GENERATION_INVALID', 'argument'],
  ['builtAt must be parseable timestamp', 'OPT_BUILT_AT_INVALID', 'argument'],
  ['sourceId must be a non-empty string', 'OPT_SOURCE_ID_INVALID', 'argument'],
  ['cursorSeq must be safe integer >=0', 'OPT_CURSOR_SEQ_INVALID', 'argument'],
  ['cursorSeq must be >= max input seq', 'OPT_CURSOR_SEQ_BELOW_INPUT', 'argument'],
  ['cursorSeq must be >= max emitted word seq (', 'OPT_CURSOR_SEQ_BELOW_EMITTED', 'argument'],
  ['sourcePath must be canonical absolute posix path without dot segments', 'OPT_SOURCE_PATH_NOT_CANONICAL', 'argument'],
  ['sourcePath must not be a temporary identity: ', 'OPT_SOURCE_PATH_TEMPORARY', 'argument'],
  ['sourcePath collides with the output directory: ', 'OPT_SOURCE_PATH_COLLIDES_OUTDIR', 'argument'],
  ['sourcePath collides with the source database path: ', 'OPT_SOURCE_PATH_COLLIDES_DB', 'argument'],
  ['sourcePath for selectedLogPath must equal its deterministic per-log identity: ', 'OPT_SOURCE_PATH_NOT_DERIVED', 'argument'],
  ['dbPath must be an absolute path', 'OPT_DB_PATH_NOT_ABSOLUTE', 'argument'],
  ['dbPath must be a real file (source databases are never opened as memory/URI)', 'OPT_DB_PATH_NOT_REAL_FILE', 'argument'],
  ['summariesPath must be a non-empty path when provided', 'OPT_SUMMARIES_PATH_INVALID', 'argument'],

  // ── 输出/落点守卫（不覆盖、不落生产、不落非 TEMP）─────────────────
  ['refusing to overwrite existing output: ', 'GUARD_OUTPUT_EXISTS', 'output-guard'],
  ['outDir must be absent or empty (each generation gets its own directory): ', 'GUARD_OUTDIR_NOT_EMPTY', 'output-guard'],
  ['outDir must be a directory: ', 'GUARD_OUTDIR_NOT_DIRECTORY', 'output-guard'],
  ['outDir must live under the OS temporary directory for this stage: ', 'GUARD_OUTDIR_NOT_TEMP', 'output-guard'],
  ['outDir must live under the OS temporary directory for this test/prototype writer: ', 'GUARD_OUTDIR_NOT_TEMP', 'output-guard'],
  ['summaries input must not be equal to or inside the output directory: ', 'GUARD_SUMMARIES_INSIDE_OUTDIR', 'output-guard'],
  ['sourceRoot must be an existing directory: ', 'GUARD_SOURCE_ROOT_MISSING', 'output-guard'],
  ['sourceRoot must live under the OS temporary directory unless allowExternalSourceRoot is explicitly true: ', 'GUARD_SOURCE_ROOT_NOT_TEMP', 'output-guard'],
  ['declared source is not a regular file: ', 'GUARD_SOURCE_NOT_REGULAR_FILE', 'output-guard'],

  // ── 权威索引输入（files/words/summaries 的结构）────────────────────
  ['index manifest is empty', 'INPUT_MANIFEST_EMPTY', 'source-input'],
  ['index manifest declares no files', 'INPUT_MANIFEST_NO_FILES', 'source-input'],
  ['index manifest is not valid UTF-8', 'INPUT_MANIFEST_NOT_UTF8', 'source-input'],
  ['index manifest must be an existing file: ', 'INPUT_MANIFEST_MISSING', 'source-input'],
  ['index manifest must not start with a UTF-8 BOM', 'INPUT_MANIFEST_BOM', 'source-input'],
  ['input JSONL is empty', 'INPUT_JSONL_EMPTY', 'source-input'],
  ['input JSONL is not valid UTF-8', 'INPUT_JSONL_NOT_UTF8', 'source-input'],
  ['input JSONL must end with LF', 'INPUT_JSONL_NO_FINAL_LF', 'source-input'],
  ['input has no data rows', 'INPUT_JSONL_NO_ROWS', 'source-input'],
  ['summaries are not valid UTF-8', 'INPUT_SUMMARIES_NOT_UTF8', 'source-input'],
  ['summaries has no data rows', 'INPUT_SUMMARIES_NO_ROWS', 'source-input'],
  ['summaries must be a non-empty UTF-8 JSONL file', 'INPUT_SUMMARIES_INVALID_FILE', 'source-input'],
  ['summaries must end with LF (a missing terminator is the signature of a truncated write)', 'INPUT_SUMMARIES_NO_FINAL_LF', 'source-input'],
  ['summaries must not start with a UTF-8 BOM', 'INPUT_SUMMARIES_BOM', 'source-input'],

  // ── 逐行校验（words/summaries/manifest 的行形状）──────────────────
  ['words.jsonl line ', 'ROW_WORDS_INVALID', 'row'],
  ['summaries.jsonl line ', 'ROW_SUMMARIES_INVALID', 'row'],
  ['files.jsonl line ', 'ROW_FILES_INVALID', 'row'],
  ['line ', 'ROW_INPUT_INVALID', 'row'],
  ['log path must be a non-empty absolute path: ', 'ROW_LOG_PATH_INVALID', 'row'],
  ['two source frames share session+seq', 'ROW_WORD_SEQ_CONFLICT', 'row'],
  ['two compaction/summary frames declare the same cmpId ', 'ROW_SUMMARY_ID_CONFLICT', 'row'],

  // ── 指针/来源身份 ────────────────────────────────────────────────
  ['selectedLogPath is not declared in files.jsonl: ', 'PTR_SELECTED_LOG_UNDECLARED', 'pointer'],
  ['selectedLogPath must match exactly one files.jsonl row: ', 'PTR_SELECTED_LOG_AMBIGUOUS', 'pointer'],
  ['selectedLogPath manifest row could not be resolved to its canonical source', 'PTR_SELECTED_LOG_UNRESOLVED', 'pointer'],
  ['the index declares source ', 'PTR_SOURCE_NOT_IN_INDEX', 'pointer'],

  // ── v4 SQLite 源库 ─────────────────────────────────────────────
  ['source database does not exist: ', 'SRCDB_MISSING', 'source-db'],
  ['source database must be a regular file: ', 'SRCDB_NOT_REGULAR_FILE', 'source-db'],
  ['source database must live under the OS temporary directory for this stage: ', 'SRCDB_NOT_TEMP', 'source-db'],
  ['source database must not be equal to or inside the output directory: ', 'SRCDB_INSIDE_OUTDIR', 'source-db'],
  ['source database is missing required table(s): ', 'SRCDB_MISSING_TABLES', 'source-db'],
  ['source database has no readable schema version (schema_migrations is empty)', 'SRCDB_NO_SCHEMA_VERSION', 'source-db'],
  ['source table ', 'SRCDB_MISSING_COLUMNS', 'source-db'],
  ['source database bytes changed during the build; refusing an inconsistent snapshot', 'SRCDB_CHANGED_DURING_BUILD', 'source-db'],
  ['source database changed during the build; refusing an inconsistent snapshot', 'SRCDB_CHANGED_DURING_BUILD', 'source-db'],
  ['unsupported source schema v', 'SRCDB_SCHEMA_UNSUPPORTED', 'source-db'],
  ['no v4 source row for sourceId ', 'SRCDB_SOURCE_ROW_MISSING', 'source-db'],
  ['ambiguous v4 source rows for sourceId ', 'SRCDB_SOURCE_ROW_AMBIGUOUS', 'source-db'],
  ['dbPath must be an existing v9 database (this stage never creates or migrates one): ', 'SRCDB_V9_MISSING', 'source-db'],
  ['dbPath must live under the OS temporary directory for this stage: ', 'SRCDB_V9_NOT_TEMP', 'source-db'],
  ['dbPath must not live inside outDir (the output triplet is written as one group)', 'SRCDB_V9_INSIDE_OUTDIR', 'source-db'],
  ['destination database lacks the v9 ECHO structure ', 'SRCDB_V9_NO_ECHO_STRUCTURE', 'source-db'],
  ['failed to put the destination connection into query_only mode; refusing to read a database', 'SRCDB_V9_NOT_QUERY_ONLY', 'source-db'],

  // ── 游标/世代连续性（追加语义）──────────────────────────────────
  ['cursor must be a JSON object', 'CURSOR_NOT_OBJECT', 'cursor'],
  ['cursor.version must be ', 'CURSOR_VERSION_DRIFT', 'cursor'],
  ['cursor.generation must be a positive safe integer', 'CURSOR_GENERATION_INVALID', 'cursor'],
  ['cursor.files must be an object keyed by source path', 'CURSOR_FILES_NOT_OBJECT', 'cursor'],
  ['cursor.files holds an empty source path', 'CURSOR_FILES_EMPTY_PATH', 'cursor'],
  ['cursor.files[', 'CURSOR_FILES_ENTRY_INVALID', 'cursor'],
  ['generation must be exactly the cursor generation + 1 (', 'CURSOR_GENERATION_GAP', 'cursor'],
  ['generation ', 'CURSOR_GENERATION_NOT_COMMITTED', 'cursor'],
  ['stored cursor for ', 'CURSOR_STORED_INVALID', 'cursor'],
  ['stored cursor_json is not JSON: ', 'CURSOR_STORED_NOT_JSON', 'cursor'],
  ['stored summary full_json is not JSON: ', 'CURSOR_STORED_SUMMARY_NOT_JSON', 'cursor'],
  ['stored tail cursor version is ', 'CURSOR_TAIL_VERSION_DRIFT', 'cursor'],
  ['stored tail cursor has no per-file map', 'CURSOR_TAIL_NO_FILE_MAP', 'cursor'],
  ['stored cursor carries no tail block; this database was not written by ', 'CURSOR_TAIL_ABSENT', 'cursor'],
  ['source changed while being read; refusing this generation without advancing its cursor: ', 'CURSOR_SOURCE_CHANGED', 'cursor'],
  ['source was rewritten in place (same size, different file key): ', 'CURSOR_SOURCE_REWRITTEN', 'cursor'],
  ['source shrank after path stat: ', 'CURSOR_SOURCE_SHRANK', 'cursor'],
  ['source shrank (truncation): ', 'CURSOR_SOURCE_SHRANK', 'cursor'],
  ['read window exceeded stable source size: ', 'CURSOR_READ_WINDOW_EXCEEDED', 'cursor'],
  ['short read on ', 'CURSOR_SHORT_READ', 'cursor'],
  ['source path ', 'CURSOR_SOURCE_PATH_DROPPED', 'cursor'],
  ['deterministic echo_source_id collision: the stored row is ', 'CURSOR_ECHO_ID_COLLISION', 'cursor'],
  ['the target database holds a conflicting echo_source_id for this (path, version); refusing ', 'CURSOR_ECHO_ID_CONFLICT', 'cursor'],

  // ── 契约漂移（importer 形状）────────────────────────────────────
  ['importer word contract drifted from the authoritative ECHO index shape: ', 'CONTRACT_WORD_DRIFT', 'contract'],
  ['importer summary contract drifted from the authoritative ECHO index shape (id->cmpId, chars->shadowedChars, manifest passed through): ', 'CONTRACT_SUMMARY_DRIFT', 'contract'],

  // ── 空产出/其它结构性拒绝 ───────────────────────────────────────
  ['the authoritative ECHO index produced no user/assistant rows for the selected sources; ref', 'EMPTY_NO_SELECTED_ROWS', 'empty-output'],
  ['the declared sources produced no user/assistant rows at all; refusing to emit an empty gen', 'EMPTY_NO_ROWS', 'empty-output'],
  ['source ', 'SRC_FRAME_OR_SOURCE_INVALID', 'source-db'],
  ['decodeSessionTailFrames expects a Buffer', 'TAIL_DECODE_NOT_BUFFER', 'cursor'],
  ['not a zstd-framed session log: no frame magic at byte 0', 'TAIL_NOT_ZSTD', 'cursor'],
  ['malformed zstd frame header at byte ', 'TAIL_BAD_FRAME_HEADER', 'cursor'],
  ['malformed zstd frame boundary at byte ', 'TAIL_BAD_FRAME_BOUNDARY', 'cursor'],
  ['malformed zstd frame at byte ', 'TAIL_BAD_FRAME', 'cursor'],
  ['malformed zstd stream: bytes after frame boundary at byte ', 'TAIL_TRAILING_BYTES', 'cursor'],
  ['malformed complete zstd frame at byte ', 'TAIL_BAD_COMPLETE_FRAME', 'cursor'],
  ['complete zstd frame at byte ', 'TAIL_INCOMPLETE_FRAME', 'cursor'],
  ['complete zstd frame contains invalid JSON: ', 'TAIL_FRAME_NOT_JSON', 'cursor'],
  ['prefix of ', 'TAIL_PREFIX_MISMATCH', 'cursor'],
  ['computed cursor nextByte ', 'TAIL_CURSOR_MISMATCH', 'cursor'],
];

export const REFUSAL_RULES = Object.freeze(RULES.map(([prefix, code, category]) => Object.freeze({ prefix, code, category })));

// 未命中时的「安全代表」：只取开头的 [a-z ] 连写段（≤40 字符）。
// 证明：输出字母表 ⊆ {a-z, 空格} 且长度受限 ⇒ 不可能带出路径、盘符、冒号、数字、会话 id。
const SAFE_HEAD_RE = /^[a-z][a-z ]{3,39}/;

function errorName(error) {
  if (error && error.name === 'TypeError') return 'TypeError';
  if (error && error.name === 'RangeError') return 'RangeError';
  return 'Error';
}

function categoryOfLocalCode(code) {
  return LOCAL_CODE_CATEGORY[code] || 'local-code';
}

// 头部统一收口：去掉尾随空白与冒号（仍然是静态字面量的前缀，不含任何数据）。
function normalizeHead(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/[\s:]+$/, '');
  return trimmed.length === 0 ? null : trimmed;
}

function freezeResult(name, code, category, head, source) {
  return Object.freeze({ name, code, category, head: normalizeHead(head), source });
}

// error → { name, code, category, head, source }
// 优先级：error.code > message 整体就是码 > 权威索引 collected 码 > 前缀表 > UNCLASSIFIED
export function classifyRefusal(error) {
  const name = errorName(error);
  const message = error && typeof error.message === 'string' ? error.message : '';
  const declared = error && typeof error.code === 'string' ? error.code : null;
  if (declared !== null && /^[A-Z0-9_]{2,64}$/.test(declared)) {
    return freezeResult(name, declared, categoryOfLocalCode(declared), null, 'error.code');
  }
  if (/^[A-Z0-9_]{2,64}$/.test(message)) {
    return freezeResult(name, message, categoryOfLocalCode(message), message, 'message-code');
  }
  if (message.indexOf(COLLECTED_REFUSAL_PREFIX) === 0) {
    const rest = message.slice(COLLECTED_REFUSAL_PREFIX.length);
    const matched = /^([A-Z0-9_]{2,64}):/.exec(rest);
    const code = matched && COLLECTED_REFUSAL_CODES.indexOf(matched[1]) >= 0 ? matched[1] : 'COLLECTED_REFUSAL_UNCODED';
    return freezeResult(name, code, 'collected-refusal', COLLECTED_REFUSAL_PREFIX.trim(), 'collected');
  }
  let best = null;
  for (const rule of REFUSAL_RULES) {
    if (message.indexOf(rule.prefix) !== 0) continue;
    if (best === null || rule.prefix.length > best.prefix.length) best = rule;
  }
  if (best !== null) return freezeResult(name, best.code, best.category, best.prefix.trim(), 'message-prefix');
  const safe = SAFE_HEAD_RE.exec(message);
  return freezeResult(name, UNCLASSIFIED_CODE, UNRECOGNIZED_CATEGORY, safe === null ? null : safe[0].trim(), 'unclassified');
}

// 报告键（与旧实现同名同形：name + ':' + code），供 refusalCodes 使用。
export function refusalKey(result) {
  return result.name + ':' + result.code;
}

// 把一条拒绝记进 report。**只加计数，绝不改动 eligible/builtSources** —— fail-closed 的唯一保证点。
// 返回分类结果，调用方据此 continue（该源既不算 built，也不算 eligible）。
export function recordRefusal(report, error, options) {
  const result = classifyRefusal(error);
  const opts = options || {};
  const key = refusalKey(result);
  report.refusalCodes[key] = (report.refusalCodes[key] || 0) + 1;
  report.refusalCategories[result.category] = (report.refusalCategories[result.category] || 0) + 1;
  if (result.code === UNCLASSIFIED_CODE) report.unclassifiedRefusals += 1;
  if (report.representativeRefusals[result.code] === undefined) {
    report.representativeRefusals[result.code] = { name: result.name, category: result.category, head: result.head };
  }
  if (opts.phase === 'build') {
    report.buildRefusals += 1;
    if (report.representativeBuilderError === null) {
      report.representativeBuilderError = { name: result.name, code: result.code, category: result.category, head: result.head };
    }
    if (opts.declaredNonempty) report.sourceBuckets.declaredNonemptyRefused += 1;
    else report.sourceBuckets.declaredEmptyRefused += 1;
  } else {
    report.missingShards += 1;
  }
  return result;
}

// 新报告里本模块要用的字段（调用方把它并进 report 初始值）。
export function refusalReportFields() {
  return {
    refusalCodes: {},
    refusalCategories: {},
    unclassifiedRefusals: 0,
    representativeRefusals: {},
    representativeBuilderError: null,
  };
}
