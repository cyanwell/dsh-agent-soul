// src/db/echo-integrity.mjs —— ECHO v9 派生索引的**完整性判据**（全库唯一一处定义）
// ============================================================================
// 为什么有这一层（Task-14）：
//   同一条判据原来活着两份 —— src/db/store.mjs 的 echoStatsIn() 与
//   tools/echo-index-import.mjs 的 verifyEchoIntegrity()。两份都在算「对齐 / 审计列 /
//   游标 / 代次 / 孤儿 FTS」，各自抄了一遍 SQL 与字段名；而 src/db/echo.mjs 又是
//   **直接 import tools/** 才拿到其中一份 —— 方向是反的（src/ 不许 import tools/）。
//   现在「什么算完整」只在这里定义，两个调用方各加一层**薄适配**：
//
//     Store 面   store.echoStats()               → analyzeEchoIntegrity()
//     导入器面   tools/…verifyEchoIntegrity()    → analyzeEchoIntegrity() + 旧字段名映射
//
// ★ 依赖方向铁律：本模块**零 import tools/**，也不 import 任何会 import tools/ 的模块。
//   它只吃一个 db 句柄（node:sqlite 形状：prepare / all / get / run）。
//   tools/echo-integrity-selftest.mjs 有一条静态断言盯着它（源码里出现 tools/ 就红）。
//
// ★★ 两个词必须分清（本模块对外唯一的语义承诺）：
//     aligned = **计数对齐**：每来源 words == words_fts、summaries == summaries_fts、
//               declared srcSeq rows == 实际 srcSeqs 行数，**且三条来源声明计数与实际相等**。
//               它回答「检索会不会静默少命中」——所以**只有它**决定要不要闸住检索。
//     ok      = aligned **且** 没有任何完整性 problem（审计列 / 游标 / state / 孤儿 FTS）。
//               它回答「这份索引健不健康」——诊断面用它，检索面不用。
//   ★ 混成一个词的后果：一条游标 JSON 写坏了、但计数完全对齐的索引会被判"不可检索"，
//     那是把「元数据脏了」说成「结果会少」—— 另一句谎。两者必须分开。
//
// ★★ Task-16：来源行的**声明计数**（echo_index_sources.words_count /
//    summaries_count / src_seq_count）要与实际内容核一遍。
//    · 声明从哪来：导入器在**同一个事务**里写这三列，写之前已经拿清单 counts 与源文件行数
//      核过（tools/echo-index-import.mjs 的 MANIFEST_COUNTS_MISMATCH）；所以健康库里三条恒等。
//    · 为什么 schema 说是「审计列」还要查：库层**不强制**它们等于子表行数（schema.mjs 原话），
//      于是不查，这三列就是三句没人核对过的话。查了才有意义。
//    · **一条 kind、三个成对字段**（不拆成三条 kind）：对外形状只长一个名字
//      （source-declared-counts），三个维度写成三对「声明 / 实际」——
//      wordsCount/words、summariesCount/summaries、srcSeqCount/declaredSeqRows。
//      ★ 为什么 srcSeq 那一对比的是 declaredSeqRows（= SUM(echo_summaries.src_seq_count)）
//        而不是子表行数：来源列与摘要声明之和在**同一根声明链**上，拿它再跟子表行数比一遍，
//        等于把「摘要自己声明了多少」算两次 —— 链与子表对不上时，src-seq-count 已经说过
//        一次，不该换一条 kind 再说一次（一次坏法报成两条问题）。链自洽时
//        SUM == 子表行数，两种口径在这一层给出同一个答案。
//    · 为什么**进 aligned（也进检索闸）**（final amendment）：
//      C11 实测：**行与它的 FTS 孪生行被同时删掉**时，words==words_fts、
//      summaries==summaries_fts、声明的 srcSeq 行数==子表行数 全部自洽，
//      只有来源行声明看得出来（wordsCount > words）—— 而检索会静默少命中 1 条。
//      闸问的正是「会不会静默少命中」，所以声明必须进 aligned；
//      否则这道闸在唯一真正需要它的形状上放行。
//    · 判据只有一份：isEchoSourceAligned 要求调用方把三条声明一起传进来；
//      Store 的 echoSourceFromRow 与本模块的 echoIndexInfo 都已传。
//    · 纯声明漂移（表里行没少）也 fail closed：这是有意选择 —— 声明与内容不一致时，
//      无法从声明这一侧证明「没有行缺失」，所以宁可拒绝，不做部分结果。
//
// ★★★ 兼容字段（Task-14 明确要求，**不许静默改名**）：
//     generation-vs-builds 里「构建审计里最大的 generation」：
//       Store（新面）  → maxBuildGeneration
//       导入器（旧面） → maxBuild            ← 由导入器自己映射
//     cursor-seq-json-mismatch 里「解析出来的游标」：
//       Store（新面）  → cursor
//       导入器（旧面） → json                ← 由导入器自己映射
//   本模块只发**一个**规范名（新面那套）；映射写在调用方的薄适配里。
//   ★ 为什么不在这里同时发两个名字：那会把「兼容」永久钉进唯一判据里，
//     下一个读代码的人会以为这两种写法都应该存在。
//
// ★★ 游标坏掉只报**一个** kind：cursor-seq-json-mismatch。
//    解析不了的 JSON 与「解析出来但 seq 对不上」是同一件事：json.seq == cursor_seq 不成立。
//    ★ 为什么不再多报 cursor-json-invalid（2026-11-15 回退掉的那次行为扩张）：
//      Store / MCP 的**已发布契约**里只有 cursor-seq-json-mismatch（cursor:null、cursorSeq 保留），
//      导入器再把它映射成 json。多出一个 kind，就等于把「一种坏法」说成「两种」——
//      按 kind 穷举的调用方会被迫认识一个从没存在过的名字。
//      事实一点没丢：JSON 坏掉时这条 problem 里的 cursor 就是 null。
// ============================================================================

// 缺表判定用的七张表。顺序只影响报错文本里的列法，不影响判据。
export const ECHO_INTEGRITY_TABLES = Object.freeze([
  'echo_index_sources', 'echo_words', 'echo_summaries',
  'echo_summary_src_seqs', 'echo_words_fts', 'echo_summaries_fts', 'echo_source_builds',
]);

// 九种 problem（对外形状的一部分：调用方按 kind 分支）。
// ★ Task-16 新增一种（source-declared-counts），是**加法**不是改名：老八种一个都没动，
//   按已知 kind 分支的调用方只会「不认识这一条」，不会被改掉语义。
export const ECHO_INTEGRITY_PROBLEM_KINDS = Object.freeze([
  'words-fts', 'summaries-fts', 'src-seq-count',
  'source-declared-counts',
  'generation-vs-builds', 'state',
  'cursor-seq-json-mismatch',
  'orphan-words-fts', 'orphan-summaries-fts',
]);

// ── 缺表探测：**永不抛** ───────────────────────────────────────────────────
// ★ 为什么 catch 掉异常还要回「全缺」：连 sqlite_master 都查不了（句柄已关 / 不是库），
//   能确定的事实只有「一张都不认得」。回一句能读的 available:false，好过让调用方
//   去 catch 一个 SqliteError —— 那是把「没建过」说成「程序崩了」。
export function echoMissingTables(db) {
  let rows;
  try {
    rows = db.prepare('SELECT name FROM sqlite_master WHERE name IN (' + ECHO_INTEGRITY_TABLES.map(function () { return '?'; }).join(',') + ')').all(...ECHO_INTEGRITY_TABLES);
  } catch (_) {
    return ECHO_INTEGRITY_TABLES.slice();
  }
  const have = new Set(rows.map(function (r) { return String(r.name); }));
  return ECHO_INTEGRITY_TABLES.filter(function (t) { return !have.has(t); });
}

// ── 对齐判据（唯一一份；store / 导入器 / 本模块都用它）─────────────────────
//   words == words_fts && summaries == summaries_fts && declared srcSeq rows == 实际 rows
//   **并且**来源行的三条声明计数与实际相等（Task-16 final amendment）：
//     words == declaredWords && summaries == declaredSummaries
//     && declaredSeqRows == declaredSrcSeqs
// ★ 为什么声明也进闸：行与它的 FTS 孪生行被同时删掉时，上面三对仍然自洽，
//   只有声明看得出来（declared > actual）—— 那正是「检索静默少命中」的形状。
// ★ 调用方必须把三条声明一起传进来（store.mjs: echoSourceFromRow；本模块: echoIndexInfo）。
export function isEchoSourceAligned(s) {
  return s.words === s.wordsFts && s.summaries === s.summariesFts
    && s.declaredSeqRows === s.seqRows
    && (s.declaredWords === undefined || s.words === s.declaredWords)
    && (s.declaredSummaries === undefined || s.summaries === s.declaredSummaries)
    && (s.declaredSrcSeqs === undefined || s.declaredSeqRows === s.declaredSrcSeqs);
}

// ── 每来源计数（一条 SQL，供对齐与问题明细共用）────────────────────────────
// ★ 字段名与 v9 导入器的 echoIndexInfoFor() 历史形状**逐字一致**：
//   那是已发布形状（src/db/echo.mjs、导入器自检、MCP 回执都在读），不许改。
// ★ 列与子查询只写这一份：整库读数与单来源读数**共用**它，末尾的 FROM / WHERE 才分叉。
//   两处各抄一份 SQL 就多一份漂移 —— 而「全库扫描」这个病本来就长在「人人都调全库那条」上。
const ECHO_INDEX_INFO_COLUMNS = [
  'SELECT s.echo_source_id AS sid, s.source_path AS path, s.source_version AS version,',
  // 三条声明列（Task-16）：与计数在**同一条语句**里读，才不会读到「声明是新一代、计数是旧一代」。
  '  s.words_count AS declared_words, s.summaries_count AS declared_summaries, s.src_seq_count AS declared_src_seqs,',
  '  (SELECT COUNT(*) FROM echo_words w WHERE w.echo_source_id = s.echo_source_id) AS words,',
  '  (SELECT COUNT(*) FROM echo_words_fts f WHERE f.echo_source_id = s.echo_source_id) AS words_fts,',
  '  (SELECT COUNT(*) FROM echo_summaries m WHERE m.echo_source_id = s.echo_source_id) AS summaries,',
  '  (SELECT COUNT(*) FROM echo_summaries_fts f WHERE f.echo_source_id = s.echo_source_id) AS summaries_fts,',
  '  (SELECT COALESCE(SUM(m.src_seq_count), 0) FROM echo_summaries m WHERE m.echo_source_id = s.echo_source_id) AS declared_seq_rows,',
  '  (SELECT COUNT(*) FROM echo_summary_src_seqs q WHERE q.echo_source_id = s.echo_source_id) AS seq_rows',
];
// 整库读数：n 行 × 每行 6 条相关子查询 = O(n²)。只在**确实要全库**的地方调
//（analyzeEchoIntegrity 的收尾复核、导入器/keeper 的收尾断言）。
const ECHO_INDEX_INFO_SQL = ECHO_INDEX_INFO_COLUMNS.concat(['FROM echo_index_sources s ORDER BY s.source_path, s.source_version']).join(' ');
// 单来源读数：同一条 SQL 只多一个 WHERE —— 列、子查询、判定口径全部照旧。
// ★ 「一条来源」的代价必须与库里有多少来源**无关**，否则一次导入的自检会随库增长而变慢。
const ECHO_INDEX_INFO_ONE_SQL = ECHO_INDEX_INFO_COLUMNS.concat(['FROM echo_index_sources s WHERE s.echo_source_id = ?']).join(' ');

function emptyEchoIndex() {
  return { sources: [], words: 0, summaries: 0, aligned: false };
}

// 行 → 已发布形状（每来源十键）。整库读数与单来源读数**都**走这里，形状只有一处。
// ★ aligned 是**逐行**判据（只比本行的计数与声明，不看别的来源），所以单条读出的 aligned
//   与整库读出的那一项必然一致 —— 这是「换成单条查询不改变语义」的依据。
function echoSourceInfoFromRow(r, withDeclarations) {
  const words = Number(r.words);
  const wordsFts = Number(r.words_fts);
  const summaries = Number(r.summaries);
  const summariesFts = Number(r.summaries_fts);
  const declaredSeqRows = Number(r.declared_seq_rows);
  const seqRows = Number(r.seq_rows);
  const declaredWords = Number(r.declared_words);
  const declaredSummaries = Number(r.declared_summaries);
  const declaredSrcSeqs = Number(r.declared_src_seqs);
  const row = {
    echoSourceId: r.sid, sourcePath: r.path, sourceVersion: r.version,
    words, wordsFts, summaries, summariesFts, declaredSeqRows, seqRows,
    aligned: isEchoSourceAligned({
      words, wordsFts, summaries, summariesFts, declaredSeqRows, seqRows,
      declaredWords, declaredSummaries, declaredSrcSeqs,
    }),
  };
  if (withDeclarations) {
    row.declaredWords = declaredWords;
    row.declaredSummaries = declaredSummaries;
    row.declaredSrcSeqs = declaredSrcSeqs;
  }
  return row;
}

// 计数面：缺表时由调用方先用 echoMissingTables 判，这里不兜底（SQL 会抛，语义上就是"不该走到这"）。
// ★ 默认返回**逐字不动**的已发布形状（每来源十键）。options.withDeclarations 只给
//   analyzeEchoIntegrity 用：它要拿声明值拼漂移问题，但那些值不许出现在任何对外回执里。
//   为什么不做成「再发一条 SQL」：两条语句 = 两个快照，导入在两者之间提交时会读出一对假的漂移。
// ── 整库读数的**聚合实现**（2026-11-16：O(n²) → O(n)）────────────────────
// ★ 为什么必须换：ECHO_INDEX_INFO_SQL 是 n 行 × 6 条相关子查询。echo_words_fts /
//   echo_summaries_fts 是 FTS5 虚表，echo_source_id 声明为 UNINDEXED —— 那两条
//   COUNT(*) 走不了索引，只能整表扫。实测生产库（946 来源 / 46,536 词行）：
//   单源一条 COUNT 就 1.09 s，× 946 = 90 秒以上，而**每次检索前的对齐闸**都要跑一次。
//   这不是慢，这是打不开。
// ★ 换成「每张表一次 GROUP BY，再在 JS 里按 echo_source_id 合并」：扫描次数从
//   n（来源数）降到 1，总量仍是全表一遍。行的形状**仍然只由 echoSourceInfoFromRow 产出**，
//   所以十键形状、aligned 判据、声明值全部逐字不变 —— 变的只是"把六个数字取回来"的方式。
// ★ 快照一致性：原来一条 SQL = 一个快照；现在七条。用 SAVEPOINT 把它们框进同一个读事务，
//   否则导入在两个语句之间提交，就会读出一对**假的**漂移（这正是原注释警告过的形状）。
const ECHO_COUNT_SQL = Object.freeze({
  words: 'SELECT echo_source_id AS sid, COUNT(*) AS n FROM echo_words GROUP BY echo_source_id',
  wordsFts: 'SELECT echo_source_id AS sid, COUNT(*) AS n FROM echo_words_fts GROUP BY echo_source_id',
  summaries: 'SELECT echo_source_id AS sid, COUNT(*) AS n FROM echo_summaries GROUP BY echo_source_id',
  summariesFts: 'SELECT echo_source_id AS sid, COUNT(*) AS n FROM echo_summaries_fts GROUP BY echo_source_id',
  declaredSeqRows: 'SELECT echo_source_id AS sid, COALESCE(SUM(src_seq_count), 0) AS n FROM echo_summaries GROUP BY echo_source_id',
  seqRows: 'SELECT echo_source_id AS sid, COUNT(*) AS n FROM echo_summary_src_seqs GROUP BY echo_source_id',
});
const ECHO_INDEX_SOURCES_SQL = [
  'SELECT s.echo_source_id AS sid, s.source_path AS path, s.source_version AS version,',
  '  s.words_count AS declared_words, s.summaries_count AS declared_summaries, s.src_seq_count AS declared_src_seqs',
  'FROM echo_index_sources s ORDER BY s.source_path, s.source_version',
].join(' ');

export function echoIndexInfo(db, options) {
  const withDeclarations = !!(options && options.withDeclarations === true);
  // SAVEPOINT 在自动提交与已有事务里都能用（可以嵌套），所以库里正跑着导入也安全。
  db.exec('SAVEPOINT echo_index_info_read');
  let base;
  const bag = {};
  try {
    base = db.prepare(ECHO_INDEX_SOURCES_SQL).all();
    for (const key of Object.keys(ECHO_COUNT_SQL)) {
      const m = new Map();
      for (const r of db.prepare(ECHO_COUNT_SQL[key]).all()) m.set(r.sid, Number(r.n));
      bag[key] = m;
    }
  } finally {
    db.exec('RELEASE echo_index_info_read');
  }
  const sources = base.map(function (r) {
    const at = (key) => bag[key].get(r.sid) || 0;
    return echoSourceInfoFromRow({
      sid: r.sid, path: r.path, version: r.version,
      declared_words: r.declared_words, declared_summaries: r.declared_summaries,
      declared_src_seqs: r.declared_src_seqs,
      words: at('words'), words_fts: at('wordsFts'),
      summaries: at('summaries'), summaries_fts: at('summariesFts'),
      declared_seq_rows: at('declaredSeqRows'), seq_rows: at('seqRows'),
    }, withDeclarations);
  });
  return {
    sources,
    words: sources.reduce(function (a, x) { return a + x.words; }, 0),
    summaries: sources.reduce(function (a, x) { return a + x.summaries; }, 0),
    aligned: sources.every(function (x) { return x.aligned; }),
  };
}

// ── 单来源读数（给「一次只导入一条、只需要自己那一条」的调用方）───────────────
// ★ 它存在的唯一理由：整库读数是 O(n²)。n 行，每行 6 条相关子查询，每一条子查询都要
//   过一遍 echo_words / echo_words_fts / echo_summaries / echo_summaries_fts
//   / echo_summary_src_seqs。/ 1490 条来源、2.2 GB 的库上实测 **24.5 秒 per source**，
//   而导入器每导入一条来源都要在事务里自检一次 —— 于是 1490 条 = 5 小时以上，全花在
//   反复读「别人」的计数上。它只关心自己刚写进去的那一条。
// ★ 形状与 echoIndexInfo().sources 里的一项**逐字相同**（同样十键、同样过 isEchoSourceAligned），
//   所以调用方从「全库 find」换成「单条 get」时，判定逻辑一行都不用改。
// ★ 找不到就回 null，**不回一个全零的假来源**：零计数会被读成「导入把它写空了」，
//   而真相是「那一行根本不存在」—— 两者不许混（与 store 侧「0 条 ≠ 不在索引里」同一判据）。
// ★ 整库那条 echoIndexInfo 一个字都没改：analyzeEchoIntegrity 与各收尾复核照旧用它。
export function echoIndexInfoForOne(db, echoSourceId, options) {
  const withDeclarations = !!(options && options.withDeclarations === true);
  const row = db.prepare(ECHO_INDEX_INFO_ONE_SQL).get(echoSourceId);
  return row ? echoSourceInfoFromRow(row, withDeclarations) : null;
}

// analyze 的返回里 index 必须是默认形状 —— 声明值只用于拼 problems，绝不回给调用方。
function echoIndexWithoutDeclarations(info) {
  return {
    sources: info.sources.map(function (s) {
      return {
        echoSourceId: s.echoSourceId, sourcePath: s.sourcePath, sourceVersion: s.sourceVersion,
        words: s.words, wordsFts: s.wordsFts, summaries: s.summaries, summariesFts: s.summariesFts,
        declaredSeqRows: s.declaredSeqRows, seqRows: s.seqRows, aligned: s.aligned,
      };
    }),
    words: info.words,
    summaries: info.summaries,
    aligned: info.aligned,
  };
}

// ── 审计面：代次 / state / 游标 / 构建记录（每来源一行）─────────────────────
// ★ 排序与计数面同一套（source_path, source_version），这样 problems 的顺序
//   和 echoStats().sources 的顺序对得上 —— 人拿着两段输出对照时不用再排序。
const ECHO_SOURCE_AUDIT_SQL = [
  'SELECT s.echo_source_id AS sid, s.generation AS generation, s.state AS state,',
  '  s.cursor_seq AS cursor_seq, s.cursor_json AS cursor_json,',
  '  (SELECT COUNT(*) FROM echo_source_builds b WHERE b.echo_source_id = s.echo_source_id) AS builds,',
  '  (SELECT MAX(b.generation) FROM echo_source_builds b WHERE b.echo_source_id = s.echo_source_id) AS max_build_generation',
  'FROM echo_index_sources s ORDER BY s.source_path, s.source_version',
].join(' ');

/**
 * FTS 里存在、但来源表里没有对应行的计数（「孤儿」）。
 *
 * ★ 2026-11-17 导出：原来只有 analyzeEchoIntegrity 内部用。
 *   子进程探针要能**单独**跑它（--deep），否则想查孤儿就得连整轮 analyze 一起付钱。
 * ★ 它很贵：NOT IN 在 FTS5 的 UNINDEXED 列上，必须全表扫（words 1.5s / summaries 0.2s 实测）。
 *   所以它**不在**日常体检的路径上，只在 --deep 时才跑。
 */
export function echoOrphanFts(db) {
  return {
    words: Number(db.prepare('SELECT COUNT(*) AS n FROM echo_words_fts WHERE echo_source_id NOT IN (SELECT echo_source_id FROM echo_index_sources)').get().n),
    summaries: Number(db.prepare('SELECT COUNT(*) AS n FROM echo_summaries_fts WHERE echo_source_id NOT IN (SELECT echo_source_id FROM echo_index_sources)').get().n),
  };
}

// ── 公共入口 ───────────────────────────────────────────────────────────────
// 只读、不开事务（诊断面永远拿得到话）。
// 返回：
//   available  false = 库里有表没建齐（此时 problems 为空，missing 里逐张列）
//   missing    string[]（available:true 时恒为空数组）
//   aligned    计数对齐（决定要不要闸检索）
//   ok         aligned && problems.length === 0（诊断结论）
//   index      { sources, words, summaries, aligned }
//   problems   九种 kind 的明细（含孤儿 FTS 两条、来源声明一条）
//   orphanFts  { words, summaries }
export function analyzeEchoIntegrity(db) {
  const missing = echoMissingTables(db);
  if (missing.length > 0) {
    return {
      available: false,
      missing,
      aligned: false,
      ok: false,
      index: emptyEchoIndex(),
      problems: [],
      orphanFts: { words: 0, summaries: 0 },
    };
  }

  // 声明值只在本函数里用来拼 problems；对外回的 index 由 echoIndexWithoutDeclarations() 还原。
  const enriched = echoIndexInfo(db, { withDeclarations: true });
  const index = echoIndexWithoutDeclarations(enriched);
  const problems = [];

  // ① 计数面：对齐破了的三条 —— 这三条正是「检索会静默少命中」的形状。
  for (const s of enriched.sources) {
    if (s.words !== s.wordsFts) problems.push({ echoSourceId: s.echoSourceId, kind: 'words-fts', words: s.words, fts: s.wordsFts });
    if (s.summaries !== s.summariesFts) problems.push({ echoSourceId: s.echoSourceId, kind: 'summaries-fts', summaries: s.summaries, fts: s.summariesFts });
    if (s.declaredSeqRows !== s.seqRows) problems.push({ echoSourceId: s.echoSourceId, kind: 'src-seq-count', declared: s.declaredSeqRows, actual: s.seqRows });
    // ①b 来源行的声明 vs 实际（Task-16 final amendment）。声明同时参与 aligned
    //    （见 isEchoSourceAligned），所以这条 problem 与检索闸说的是同一件事。
    //    ★ 一条 kind、三个成对字段；srcSeq 那一对跟「摘要声明之和」比，不跟子表行数比
    //      （否则链与子表对不上时会跟 src-seq-count 重复报同一件事，见文件头）。
    if (s.words !== s.declaredWords || s.summaries !== s.declaredSummaries || s.declaredSrcSeqs !== s.declaredSeqRows) {
      problems.push({
        echoSourceId: s.echoSourceId, kind: 'source-declared-counts',
        wordsCount: s.declaredWords, words: s.words,
        summariesCount: s.declaredSummaries, summaries: s.summaries,
        srcSeqCount: s.declaredSrcSeqs, declaredSeqRows: s.declaredSeqRows,
      });
    }
  }

  // ② 审计面：代次 vs 构建记录 / state / 游标自洽。
  for (const r of db.prepare(ECHO_SOURCE_AUDIT_SQL).all()) {
    const sid = r.sid;
    const generation = Number(r.generation);
    const builds = Number(r.builds);
    const maxBuildGeneration = r.max_build_generation === null ? null : Number(r.max_build_generation);
    // ★★★ 2026-11-17 修一个**判据比它想检查的东西更严格**的 bug。
    //   原判据：builds(审计行数) === generation(代次号)。它隐含假设「每一代都写过一行」。
    //   而事实是：早期导入器只在**全量**路径写审计行，增量代次一行都没留 ——
    //   于是生产库 generation=88、builds=1，这条判据**永久性地自证有罪**（ok:false 永远不会变绿）。
    //   ★ 判据该问的是：**最新一代有没有审计行**。那正是 maxBuildGeneration === generation。
    //   历史缺行是真事实，不能靠补写假行来消掉（补写 = 伪造「当时那一代长什么样」）。
    //   所以 builds 数只作展示，不作判据；判据只认 max。
    if (maxBuildGeneration !== generation) {
      problems.push({ echoSourceId: sid, kind: 'generation-vs-builds', generation, builds, maxBuildGeneration });
    }
    if (r.state !== 'committed') problems.push({ echoSourceId: sid, kind: 'state', state: r.state });
    // ★ 解析失败**不是** continue：游标读不出来，本身就让「json.seq == cursor_seq」不成立。
    //   cursor 落成 null —— 调用方看见这个 null 就知道是「读不出来」，不是「读出来但 seq 不同」。
    let cursor = null;
    try { cursor = JSON.parse(r.cursor_json); } catch (_) { cursor = null; }
    if (!cursor || typeof cursor !== 'object' || Number(cursor.seq) !== Number(r.cursor_seq)) {
      problems.push({ echoSourceId: sid, kind: 'cursor-seq-json-mismatch', cursorSeq: Number(r.cursor_seq), cursor });
    }
  }

  // ③ 孤儿 FTS：来源行已经不在了，索引本体还在 —— 只要不报，检索就会回一条开不到门的命中。
  const orphanFts = echoOrphanFts(db);
  if (orphanFts.words > 0) problems.push({ kind: 'orphan-words-fts', rows: orphanFts.words });
  if (orphanFts.summaries > 0) problems.push({ kind: 'orphan-summaries-fts', rows: orphanFts.summaries });

  return {
    available: true,
    missing: [],
    aligned: index.aligned,
    ok: index.aligned && problems.length === 0,
    index,
    problems,
    orphanFts,
  };
}
