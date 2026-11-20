#!/usr/bin/env node
// tools/echo-fixed-query-parity-selftest.mjs —— Q01–Q12 固定查询集「fixture-only」覆盖矩阵 + 逐维差分自检
// ============================================================================
// 它要证明的只有两件事，且都按「面」限定：
//
//   ① 覆盖矩阵：Q01–Q12 每一条都被显式判成 COVERED_FIXTURE 或 NOT_COVERED，
//      判据写在 tools/fixtures/echo-fixed-query-parity/queries.json 的 coverageRule 里，
//      并且**由本文件按同一条规则重算一遍**（queries.json 写错了就会被抓出来）。
//   ② 逐维差分：对被标为 COVERAGE 的探针（只有 Q04/Q05 的 summaries@limit=3），
//      Store / MCP / importer helper 三条腿都必须与**独立 oracle**在
//      pointer 集合 / pointer 顺序 / 条数 / exhausted / 截断 上逐项一致。
//
// ★ 三条腿分别是什么（名字要精确，别混）：
//   · Store          = src/db 的 echoSearch（读同一个临时库）
//   · MCP            = src/adapters/mcp-tools.mjs 的 soul_echo_search（同一个临时库）
//   · importer helper= tools/echo-index-import.mjs 导出的 searchEchoWords / searchEchoSummaries
//     （同一份临时库、同一个连接；**不是** live 的 memq CLI —— 后者一次都没跑，也算 NOT_COVERED）
//
// ★ COVERED_FIXTURE 是一句很窄的话：某个**指定面**在**基线自己的 limit** 下，
//   上述三条腿与 fixture oracle 逐维一致。它**不**等于 live 一致：
//   live 命中数 / live 首指针 / 墨腿 / src=索引 的 words 腿 / 语义召回，一律记为
//   notReproduced，且**不计入**覆盖。每一条 Q 的 coverage / why / gaps / notReproduced
//   都会逐条打到 stdout —— 单独截取任何一段输出，都不该被读成「live 等价」。
//
// ★ 为什么 Q01–Q03 / Q07–Q09 是 NOT_COVERED（而不是「覆盖了 0 命中的部分」）：
//   它们的基线选项是 src=墨,索引，而 墨 这条腿在 v9 派生索引里**根本不存在**。
//   负对照（Q07–Q09）更进一层：合成语料上的 0 命中只说明「这份 fixture 里没有那一行」，
//   它**不能**证明 live 全局零命中 —— 那是两件事，混起来就是「搜不到冒充没有」。
//   Q06 另有一条：基线的 since=2026-11-13T00:00:00 没有时区，按本机本地时解析是
//   2026-11-12T16:00:00Z，与 fixture 探针用的 ...000Z **不是同一个瞬间**，
//   因此精确基线不复现；UTC 形式只作为 AUXILIARY_FIXTURE 保留。
//
// ★ F2/F3 是**加了范围的话**，别读大了：
//   F2（来源作用域）= 同一份 fixture 库上按 echoSourceId 收窄，三条腿仍与 oracle 一致，
//      各源并集 = 不收窄时的全库结果；未知 echoSourceId 在 Store/MCP/importer helper 上都必须
//      报 ECHO_SOURCE_NOT_FOUND；各自错误形状不同，但不得静默返回空或退回全库。
//   F3（同名命名空间歧义）= 在**临时库副本**上把两条源改成同一个 namespace，验证：
//      多候选时抛 ECHO_PTR_AMBIGUOUS、候选带 echoSourceId + sourcePath、拿候选 id 才能
//      精确打开、给错 id 报 ECHO_PTR_SOURCE_MISMATCH、搜索侧同一 ptr 文本靠 echoSourceId 区分。
//      它不证明生产库里真有同名源。
//   两者都**不**等于 live：live 的 src=索引 过滤 / memq --src / 生产 idx 指针一律没跑。
//
// ★ oracle 的独立性：直接读 fixture 的 JSONL（不经 FTS、不经导入器、不经 DB），
//   按「导入顺序 → 源文件行序」重建 rowid 顺序，用与 v9 相同的子串语义
//   （toLowerCase indexOf）与同一套 exhausted 判据（matchedTotal < limit）算期望值。
//   ★ 顺序结论只在「oracle 顺序 = rowid 顺序」时才成立，所以：
//     - COVERAGE 探针必须落在 raw-scan（非 bigram）模式 —— 静态与运行时两边都断言；
//     - 任何 bigram 探针只允许出现在 AUXILIARY_FIXTURE 里，且命中 ≤ 1 条（顺序平凡）。
//   实际模式（buildQueryPlan 现算）：Q01–Q05 token（raw-scan）；Q06/Q07/Q08/Q09 bigram。
//   ★ 旧版本这里写着「只有 Q06 是 bigram」，那是错的 —— Q07/Q08/Q09 同样是 bigram。
//
// 反证：自检里有一组**变异测试**——把已通过的 Store/MCP/helper 回执副本故意改坏
// （换序 / 丢条 / 加条 / 翻 exhausted / 改计数 / 造伪截断），逐条断言「差分器必须报出来」。
// 差分器不会因为一直说 true 而"通过"。
//
// 安全边界（本文件也自检，全部是**静态**判据 + 运行时读盘审计）：
//   · 只 spawn 一次子进程（导入器 CLI），argv 字面量只允许 --manifest/--sha256/--generation/--db/--json；
//   · 临时库、临时报告都建在 os.tmpdir() 下，跑完删除；
//   · 基线文件只读：前后 SHA-256 必须相同（不改基线）；
//   · **不构造、不探测任何 live 路径**：禁止串由片段拼出来，只对源码里的字符串字面量做静态断言；
//     运行时再把「这一次真的读了哪些文件」逐条审计（读盘清单必须全部落在 fixture / tmp / 基线 / 自身之内）。
//   · 生产索引/日志/墨/live memq/db-sync/migrate/live 服务一律不碰（不重启、不改路由）。
//
// 跑法：node tools/echo-fixed-query-parity-selftest.mjs    （退出码 0 = 全绿）
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openMetaStore } from '../src/db/index.mjs';
import { buildQueryPlan } from '../src/db/search.mjs';
import { echoSourceIdFor } from '../src/db/schema.mjs';
import { searchEchoWords, searchEchoSummaries } from './echo-index-import.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OWN = fileURLToPath(import.meta.url);
const FIXTURES = path.join(HERE, 'fixtures', 'echo-fixed-query-parity');
const SPEC_PATH = path.join(FIXTURES, 'queries.json');
const IMPORTER = path.join(HERE, 'echo-index-import.mjs');
const NODE = process.execPath;
const TMP_BASE = os.tmpdir();
const ROOT = fs.mkdtempSync(path.join(TMP_BASE, 'echo-fixed-query-parity-'));
const DB = path.join(ROOT, 'meta.sqlite');
const REPORT = path.join(ROOT, 'report.json');

// ── 读盘追踪：这一次**真的读了哪些文件**（审计用，不猜）──────────────────────
const READS = [];
function readBytes(p) {
  const abs = path.resolve(p);
  READS.push(abs);
  return fs.readFileSync(abs);
}
function readText(p) {
  return readBytes(p).toString('utf8');
}
function readJsonl(p) {
  return readText(p).split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

const SPEC = JSON.parse(readText(SPEC_PATH));
const BASELINE = SPEC.baseline.path;

const ok = [];
const bad = [];
function t(name, cond, detail) {
  (cond ? ok : bad).push((cond ? '✓ ' : '✗ ') + name + (detail === undefined || detail === null ? '' : '  → ' + String(detail)));
  return cond;
}
const shaOf = (p) => createHash('sha256').update(readBytes(p)).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (a) => a.slice().sort();
const lower = (s) => String(s === undefined || s === null ? '' : s).toLowerCase();
const isReasoning = (r) => ['reasoning', 'thinking'].indexOf(String(r.role)) !== -1 || ['reasoning', 'thinking'].indexOf(String(r.kind)) !== -1;
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const inside = (root, p) => {
  const r = path.resolve(root);
  const x = path.resolve(p);
  return x === r || x.indexOf(r + path.sep) === 0;
};

function fixtureFileList() {
  const out = [SPEC_PATH];
  for (const s of SPEC.sources) {
    const dir = path.dirname(s.manifest);
    const man = JSON.parse(readText(path.join(FIXTURES, s.manifest)));
    out.push(path.join(FIXTURES, s.manifest), path.join(FIXTURES, dir, man.words.path), path.join(FIXTURES, dir, man.summaries.path));
  }
  return out;
}
function hashMap(paths) {
  const m = {};
  for (const p of paths) m[p.split(path.sep).join('/')] = shaOf(p);
  return m;
}

// ── 基线选项解析（判据只有这一处，矩阵也照它重算）───────────────────────────
function parseLimit(s) {
  const m = /limit=(\d+)/.exec(String(s || ''));
  return m ? Number(m[1]) : null;
}
function parseSrc(s) {
  const m = /src=([^\s]+)/.exec(String(s || ''));
  return m ? m[1].split(/[,，]/).filter((x) => x !== '') : [];
}
function parseSince(s) {
  const m = /since=([^,\s]+)/.exec(String(s || ''));
  return m ? m[1] : null;
}
function isCanonicalInstant(s) {
  return /(?:[Zz]|[+-]\d\d:?\d\d)$/.test(String(s || ''));
}
// 覆盖判据重算：与 queries.json 的 coverageRule 同一句话，代码里只写一遍。
function expectedCoverage(q) {
  const legs = parseSrc(q.baselineOptions);
  const limit = parseLimit(q.baselineOptions);
  const since = parseSince(q.baselineOptions);
  const cov = (q.probes || []).filter((p) => p.role === 'COVERAGE');
  if (legs.indexOf('墨') !== -1) return 'NOT_COVERED';
  if (since !== null && !isCanonicalInstant(since)) return 'NOT_COVERED';
  if (limit === null) return 'NOT_COVERED';
  if (cov.length === 0) return 'NOT_COVERED';
  if (!cov.every((p) => p.limit === limit)) return 'NOT_COVERED';
  return 'COVERED_FIXTURE';
}

// ── 独立 oracle：只读 fixture JSONL，按导入顺序 + 源文件行序重建 ─────────────
function buildOracle() {
  const sources = SPEC.sources.slice().sort((a, b) => a.importOrder - b.importOrder);
  const words = [];
  const summaries = [];
  for (const s of sources) {
    const man = JSON.parse(readText(path.join(FIXTURES, s.manifest)));
    const dir = path.join(FIXTURES, path.dirname(s.manifest));
    const wRows = readJsonl(path.join(dir, man.words.path));
    const sRows = readJsonl(path.join(dir, man.summaries.path));
    for (const r of wRows) {
      if (isReasoning(r)) continue;
      words.push({
        order: words.length,
        ptr: man.namespace + ':' + r.session + '#seq=' + r.seq,
        namespace: man.namespace,
        sourcePath: man.sourcePath,
        session: r.session,
        seq: r.seq,
        t: r.t,
        text: r.text,
        truncated: r.truncated === true || r.truncated === 1,
        len: r.len,
      });
    }
    for (const r of sRows) {
      summaries.push({
        order: summaries.length,
        ptr: 'idx:' + r.cmpId,
        cmpId: r.cmpId,
        namespace: man.namespace,
        sourcePath: man.sourcePath,
        session: r.session,
        t: r.t,
        text: r.summary,
        status: r.status,
        srcSeqs: r.srcSeqs.slice(),
      });
    }
  }
  return { sources, words, summaries };
}

function oracleProbe(oracle, probe) {
  const surface = probe.surface;
  const pool = surface === 'words' ? oracle.words : oracle.summaries;
  const needle = lower(String(probe.query).trim());
  const since = probe.since === undefined || probe.since === null ? null : Date.parse(probe.since);
  const until = probe.until === undefined || probe.until === null ? null : Date.parse(probe.until);
  if (since !== null && Number.isNaN(since)) throw new Error('bad since in queries.json: ' + probe.since);
  if (until !== null && Number.isNaN(until)) throw new Error('bad until in queries.json: ' + probe.until);
  // ★ 来源收窄由 oracle 自己算（sourcePath 来自 manifest，不从库里读 echoSourceId）。
  const srcFilter = probe.sourcePath === undefined || probe.sourcePath === null ? null : String(probe.sourcePath);
  const matched = pool.filter((e) => {
    if (srcFilter !== null && e.sourcePath !== srcFilter) return false;
    const ms = Date.parse(e.t);
    if (since !== null && ms < since) return false;
    if (until !== null && ms > until) return false;
    return lower(e.text).indexOf(needle) !== -1;
  });
  const limit = probe.limit;
  const returned = matched.slice(0, limit);
  return {
    surface,
    query: probe.query,
    needle,
    limit,
    since: probe.since === undefined ? null : probe.since,
    pointers: returned.map((e) => e.ptr),
    times: returned.map((e) => e.t),
    texts: returned.map((e) => e.text),
    matchedTotal: matched.length,
    returnedCount: returned.length,
    truncated: matched.length > limit,
    exhausted: matched.length < limit,
  };
}

// ── 差分器（被变异测试反过来检验的那一个）──────────────────────────────────
// 只认 5 个维度：pointer 集合 / pointer 顺序 / 条数 / exhausted / 截断。
// orderCheck=false 时**不声称顺序**（bigram 的 bm25 顺序不等于 rowid 顺序）。
function checkReceipt(oracle, receipt, opts) {
  const m = [];
  const orderCheck = !opts || opts.orderCheck !== false;
  const p = receipt.pointers || [];
  const o = oracle.pointers;
  if (!same(sorted(p), sorted(o))) m.push('pointer-set');
  else if (orderCheck && !same(p, o)) m.push('pointer-order');
  if (receipt.count !== oracle.returnedCount) m.push('count');
  if (receipt.exhausted !== oracle.exhausted) m.push('exhausted');
  // 回执侧「有更多」的证据 = 取满 limit 且未证明完整；oracle 侧 = matchedTotal > limit。
  // ★ fixture 里没有任何探针落在 matchedTotal === limit（见 [E] 的断言），
  //   所以这个推导在本语料上是精确的，不是近似。
  const truncatedObserved = receipt.count === oracle.limit && receipt.exhausted === false;
  if (truncatedObserved !== oracle.truncated) m.push('truncation');
  if (receipt.skipped === true) m.push('skipped');
  return m;
}

// 作用域差分器（第 6 维）：命中的**来源身份**必须是本次查询允许的来源集合。
// 单独一个函数，因为 checkReceipt 的输入是 pointer 数组，而来源身份不在 pointer 文本里 ——
// 同名命名空间时两次命中的 ptr 文本可以逐字相同（F3 就是这件事）。
function checkScope(allowedIds, hits) {
  const m = [];
  const ids = hits.map((h) => (h && h.echoSourceId === undefined ? null : h.echoSourceId));
  if (!ids.every((id) => typeof id === 'string' && id.length > 0)) m.push('source-id-missing');
  if (!ids.every((id) => allowedIds.indexOf(id) !== -1)) m.push('source-scope');
  return m;
}

function storeReceipt(res, surface) {
  const s = res.surfaces[surface];
  const otherName = surface === 'words' ? 'summaries' : 'words';
  const other = res.surfaces[otherName];
  return {
    pointers: s.results.map((h) => h.ptr),
    count: s.results.length,
    exhausted: s.exhausted,
    skipped: s.skipped === true,
    rawTexts: s.results.map((h) => h.rawText),
    otherClean: other.skipped === true && other.results.length === 0 && other.exhausted === true,
    limitPerSurface: res.filters.limitPerSurface,
    matchMode: res.matchMode,
    scanPath: res.scanPath,
  };
}

function mcpReceipt(json, surface) {
  const otherName = surface === 'words' ? 'summaries' : 'words';
  const per = json.perSurface[surface];
  const other = json.perSurface[otherName];
  return {
    pointers: json.results.map((h) => h.ptr),
    count: json.results.length,
    exhausted: json.exhausted,
    skipped: per.skipped === true,
    rawTexts: json.results.map((h) => h.rawText),
    perSurfaceExhausted: per.exhausted,
    perSurfaceHits: per.hits,
    otherClean: other.skipped === true && other.hits === 0 && other.exhausted === true,
    limitPerSurface: json.filters.limitPerSurface,
    matchMode: json.matchMode,
    scanPath: json.scanPath,
    readonly: json.readonly === true,
    ok: json.ok === true,
  };
}

// importer helper 的回执：形状同族，但**没有 ptr**（它不知道命名空间），也没有时间过滤。
function helperReceipt(raw, surface, namespaceById) {
  const pointers = raw.results.map((h) => (surface === 'words'
    ? String(namespaceById.get(h.echoSourceId)) + ':' + h.session + '#seq=' + h.seq
    : 'idx:' + h.cmpId));
  return {
    pointers,
    count: raw.results.length,
    exhausted: raw.exhausted,
    skipped: false,
    rawTexts: raw.results.map((h) => h.rawText),
    matchMode: raw.matchMode,
    scanPath: raw.scanPath,
  };
}

async function mcpCall(mcp, name, args) {
  try {
    const text = await mcp.callTool(name, args, {});
    return { ok: true, json: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// ── 静态护栏：只对字符串字面量做判定，不构造、不探测任何 live 路径 ───────────
// ★ 禁止串一律由片段拼成：源码里找不到完整串，所以断言不会匹配到自己（自证陷阱）。
const LIVE_ROOT = ['D:/AI', 'memory'].join('/');
const LIVE_INDEX = [LIVE_ROOT, 'hub', 'index'].join('/');
const MO_LEDGER = ['02-', '墨.jsonl'].join('');
const PROD_DB = [LIVE_ROOT, '00-记忆库', 'meta.sqlite'].join('/');
const SESSIONS_DIR = ['data', 'sessions'].join('/');
const LIVE_MARKERS = [LIVE_INDEX, MO_LEDGER, PROD_DB, SESSIONS_DIR];
const FORBIDDEN_EXES = ['memq', 'db-sync', 'migrate-all', 'start-all', 'echo-mcp', 'echo-svc'].map((n) => n + '.mjs');
// 白名单 = 导入器（import 说明符 + path.join 里的文件名）、三个 import 目标、本自检自身的记录路径。
const ALLOWED_MJS = ['./echo-index-import.mjs', 'echo-index-import.mjs', '../src/db/index.mjs', '../src/db/search.mjs', '../src/db/schema.mjs', '../src/adapters/mcp-tools.mjs', 'tools/echo-fixed-query-parity-selftest.mjs'];

// ★ 逐行取字面量：跨行配对会被注释里的引号带偏（实测过一次，取出一堆假字面量）。
function quotedLiterals(src) {
  const out = [];
  const re = /'((?:\\.|[^'\\\n])*)'|"((?:\\.|[^"\\\n])*)"/g;
  for (const line of src.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.indexOf('//') === 0 || trimmed.indexOf('*') === 0 || trimmed.indexOf('/*') === 0) continue;
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(line))) out.push(m[1] !== undefined ? m[1] : m[2]);
  }
  return out;
}

// ── 主流程 ────────────────────────────────────────────────────────────────
let mcp = null;
let store = null;
const report = {
  harness: 'tools/echo-fixed-query-parity-selftest.mjs',
  mode: 'fixture-only',
  coverageRule: SPEC.coverageRule,
  baseline: { path: BASELINE, sha256: null, unchanged: null },
  scope: {
    productionIndexRead: false,
    productionLogRead: false,
    moLedgerRead: false,
    liveMetaSqliteRead: false,
    memqInvoked: false,
    dbSyncOrMigrateInvoked: false,
    liveServiceRestarted: false,
    routingChanged: false,
    childProcesses: 'echo-index-import.mjs CLI only (one call site, executed once per fixture source)',
    legs: ['Store (src/db echoSearch)', 'MCP (soul_echo_search)', 'importer helper (searchEchoWords / searchEchoSummaries)'],
    notLegs: ['live memq CLI', 'production ECHO index', '墨 ledger', 'semantic/BGE recall'],
  },
  readAudit: { paths: [], allInsideAllowedRoots: null, noLiveMarkers: null },
  sources: [],
  matrix: [],
  queries: [],
  pointerCases: [],
  sourceScope: null,
  namespaceAmbiguity: null,
  mismatchDetector: { mutations: [] },
  cleanup: { tempRootInsideTmp: null, dbInsideTmp: null, removed: null },
  summary: {},
};

let baselineHashBefore = null;
let fixtureHashBefore = null;
let dbHashAfterImport = null;
let storeStatsBefore = null;
let reportBytes = null;

try {
  // ── A. fixture / 基线 / 覆盖矩阵的静态校验 ──────────────────────────────
  baselineHashBefore = shaOf(BASELINE);
  fixtureHashBefore = hashMap(fixtureFileList());
  report.baseline.sha256 = baselineHashBefore;

  t('[A] baseline 的 SHA 与 queries.json 记录一致', baselineHashBefore === SPEC.baseline.sha256,
    baselineHashBefore.slice(0, 16) + ' vs ' + String(SPEC.baseline.sha256).slice(0, 16));

  const ids = SPEC.queries.map((q) => q.id);
  t('[A] 固定查询集正好 Q01–Q12（顺序固定）', same(ids, ['Q01', 'Q02', 'Q03', 'Q04', 'Q05', 'Q06', 'Q07', 'Q08', 'Q09', 'Q10', 'Q11', 'Q12']), ids.join(','));

  const covered = SPEC.queries.filter((q) => q.coverage === 'COVERED_FIXTURE');
  const notCovered = SPEC.queries.filter((q) => q.coverage === 'NOT_COVERED');

  t('[A] 每条 Q 都被显式标成 COVERED_FIXTURE / NOT_COVERED（无第三种、无缺省）',
    SPEC.queries.every((q) => q.coverage === 'COVERED_FIXTURE' || q.coverage === 'NOT_COVERED'));
  t('[A] 每个探针都带 role，且只能是 COVERAGE / AUXILIARY_FIXTURE',
    SPEC.queries.every((q) => (q.probes || []).every((p) => p.role === 'COVERAGE' || p.role === 'AUXILIARY_FIXTURE')));

  // 辅助探针的标注是**必须写清**的：它证明了什么 / 绝不能读成什么。缺一条就不许挂牌。
  const auxProbes = [];
  for (const q of SPEC.queries) for (const p of (q.probes || [])) if (p.role === 'AUXILIARY_FIXTURE') auxProbes.push({ q: q.id, p });
  t('[A] 每条 AUXILIARY_FIXTURE 都写了 establishes / doesNotEstablish（辅助测试要自带边界）',
    auxProbes.length === 8 && auxProbes.every((x) => typeof x.p.establishes === 'string' && x.p.establishes.length > 8
      && typeof x.p.doesNotEstablish === 'string' && x.p.doesNotEstablish.length > 8),
    auxProbes.map((x) => x.q).join(','));
  t('[A] COVERAGE 探针不许带 establishes（覆盖是断言，不是「辅助说明」）',
    SPEC.queries.every((q) => (q.probes || []).filter((p) => p.role === 'COVERAGE').every((p) => p.establishes === undefined)));
  const q04extra = SPEC.queries.filter((q) => q.id === 'Q04')[0].probes.filter((p) => p.role === 'AUXILIARY_FIXTURE')[0];
  t('[A] Q04 的 limit=6 探针必须在 doesNotEstablish 里写明「超出基线 limit=3」',
    !!q04extra && q04extra.limit === 6 && /limit=3/.test(String(q04extra.doesNotEstablish)), q04extra && q04extra.doesNotEstablish);
  t('[A] queries.json 带 auxiliaryRule（辅助探针的判据写在数据里，不只在代码里）',
    typeof SPEC.auxiliaryRule === 'string' && SPEC.auxiliaryRule.length > 80);

  // ★ 核心修正：COVERED 由**基线整腿范围**决定，queries.json 的标注必须与重算结果一致。
  const recalculated = SPEC.queries.map((q) => ({ id: q.id, declared: q.coverage, expected: expectedCoverage(q), legs: parseSrc(q.baselineOptions), limit: parseLimit(q.baselineOptions), since: parseSince(q.baselineOptions) }));
  t('[A] 每条的 coverage 都等于按 coverageRule 重算的结果（基线整腿范围决定 COVERED）',
    recalculated.every((r) => r.declared === r.expected),
    recalculated.filter((r) => r.declared !== r.expected).map((r) => r.id + ':' + r.declared + '≠' + r.expected).join(',') || 'all agree');
  t('[A] 覆盖计数 2 COVERED_FIXTURE / 10 NOT_COVERED（Q04/Q05 vs 其余）',
    covered.length === 2 && notCovered.length === 10
    && same(covered.map((q) => q.id), ['Q04', 'Q05'])
    && same(notCovered.map((q) => q.id), ['Q01', 'Q02', 'Q03', 'Q06', 'Q07', 'Q08', 'Q09', 'Q10', 'Q11', 'Q12']),
    covered.map((q) => q.id).join(',') + ' | ' + notCovered.map((q) => q.id).join(','));
  t('[A] 基线带 墨 腿的 Q 一律 NOT_COVERED（且不得有 COVERAGE 探针）',
    SPEC.queries.filter((q) => parseSrc(q.baselineOptions).indexOf('墨') !== -1)
      .every((q) => q.coverage === 'NOT_COVERED' && (q.probes || []).every((p) => p.role !== 'COVERAGE')));
  t('[A] NOT_COVERED 必须带 why(>20 字) 与非空 gaps，且不得有 COVERAGE 探针',
    notCovered.every((q) => typeof q.why === 'string' && q.why.length > 20 && Array.isArray(q.gaps) && q.gaps.length >= 1
      && (q.probes || []).every((p) => p.role !== 'COVERAGE')));
  t('[A] COVERED_FIXTURE 必须带 coveredLeg、非空 notReproduced、空 gaps，且 coveredLeg 对得上一个 COVERAGE 探针',
    covered.every((q) => q.coveredLeg && Array.isArray(q.notReproduced) && q.notReproduced.length >= 2
      && Array.isArray(q.gaps) && q.gaps.length === 0
      && (q.probes || []).some((p) => p.role === 'COVERAGE' && p.surface === q.coveredLeg.surface && p.limit === q.coveredLeg.limit)));
  t('[A] COVERED_FIXTURE 的 notReproduced 必须写明 live 首指针与 live 命中数都没有复现',
    covered.every((q) => q.notReproduced.some((s) => /first/i.test(s)) && q.notReproduced.some((s) => /live hit count/i.test(s))));
  t('[A] COVERED_FIXTURE 的 notReproduced 必须点明 src=索引 的 words 腿没有覆盖',
    covered.every((q) => q.notReproduced.some((s) => /words leg of src=索引/.test(s))));

  // 负对照：不能靠合成语料 0 命中冒充全局零命中。
  const negatives = SPEC.queries.filter((q) => ['Q07', 'Q08', 'Q09'].indexOf(q.id) !== -1);
  t('[A] 负对照 Q07–Q09 是 NOT_COVERED，且 gaps 里写明「合成 0 命中不能证明全局零命中」',
    negatives.every((q) => q.coverage === 'NOT_COVERED'
      && (q.gaps || []).some((g) => g.kind === 'NEGATIVE_CONTROL_NOT_GLOBAL_ZERO')));

  // Q06：无时区 since ⇒ 精确基线不复现；UTC 形式只作辅助。
  const q06 = SPEC.queries.filter((q) => q.id === 'Q06')[0];
  const q06Probes = q06.probes || [];
  t('[A] Q06 是 NOT_COVERED，gaps 写明 TIMEZONE_LESS_SINCE',
    q06.coverage === 'NOT_COVERED' && (q06.gaps || []).some((g) => g.kind === 'TIMEZONE_LESS_SINCE'));
  t('[A] Q06 的探针全是 AUXILIARY_FIXTURE，且 since 必须是显式时区的形式',
    q06Probes.length >= 1 && q06Probes.every((p) => p.role === 'AUXILIARY_FIXTURE' && isCanonicalInstant(p.since)),
    q06Probes.map((p) => p.role + ':' + p.since).join(','));
  t('[A] Q06 的基线 since 确实没有时区（否则上面那条修正就没有依据）',
    isCanonicalInstant(parseSince(q06.baselineOptions)) === false, String(parseSince(q06.baselineOptions)));

  // Q10–Q12 仍然是 NOT_COVERED，且不许有探针。
  t('[A] Q10–Q12 是 NOT_COVERED，且一个探针都没有',
    SPEC.queries.filter((q) => ['Q10', 'Q11', 'Q12'].indexOf(q.id) !== -1)
      .every((q) => q.coverage === 'NOT_COVERED' && (q.probes || []).length === 0));

  // 顺序结论的前提：COVERAGE 探针必须是 raw-scan 可判定的词面（非 bigram）。
  const probePlans = [];
  for (const q of SPEC.queries) {
    for (const p of (q.probes || [])) {
      const plan = buildQueryPlan(p.query);
      probePlans.push({ q: q.id, role: p.role, query: p.query, surface: p.surface, limit: p.limit, matchMode: plan.matchMode, scanPath: plan.matchMode === 'bigram' ? 'bigram-fts' : 'raw-scan' });
    }
  }
  t('[A] 每个 COVERAGE 探针的查询计划都不是 bigram（oracle 的 rowid 顺序只在 raw-scan 下成立）',
    probePlans.filter((p) => p.role === 'COVERAGE').every((p) => p.matchMode !== 'bigram'),
    probePlans.filter((p) => p.role === 'COVERAGE').map((p) => p.q + ':' + p.matchMode).join(','));
  t('[A] 实际模式清点：Q01–Q05 = token(raw-scan)，Q06/Q07/Q08/Q09 = bigram',
    same(probePlans.filter((p) => ['Q01', 'Q02', 'Q03', 'Q04', 'Q05'].indexOf(p.q) !== -1).map((p) => p.matchMode).filter((m, i, a) => a.indexOf(m) === i), ['token'])
    && same(probePlans.filter((p) => ['Q06', 'Q07', 'Q08', 'Q09'].indexOf(p.q) !== -1).map((p) => p.matchMode).filter((m, i, a) => a.indexOf(m) === i), ['bigram']),
    probePlans.map((p) => p.q + '=' + p.matchMode).join(' '));

  const sourcePaths = SPEC.sources.map((s) => JSON.parse(readText(path.join(FIXTURES, s.manifest))).sourcePath);
  t('[A] 两份 fixture 源都是合成的 D:/synthetic 路径（不指向生产）',
    sourcePaths.every((p) => p.indexOf('D:/synthetic/') === 0) && sourcePaths.length === 2, sourcePaths.join(' , '));

  // ── B. 临时库 + 导入（只 spawn 导入器）───────────────────────────────────
  report.cleanup.tempRootInsideTmp = ROOT.indexOf(TMP_BASE) === 0;
  report.cleanup.dbInsideTmp = DB.indexOf(TMP_BASE) === 0;
  t('[B] 临时目录在 os.tmpdir() 之下', report.cleanup.tempRootInsideTmp, ROOT);
  t('[B] 临时库在 os.tmpdir() 之下', report.cleanup.dbInsideTmp, rel(DB));

  const created = openMetaStore({ path: DB, mode: 'readwrite' });
  try { created.migrate(); } finally { created.close(); }
  t('[B] 临时库建好并迁到 v9', fs.existsSync(DB));

  function importFixture(entry) {
    const manifest = path.join(FIXTURES, entry.manifest);
    return spawnSync(NODE, [IMPORTER, '--manifest', manifest, '--sha256', shaOf(manifest), '--generation', '1', '--db', DB, '--json'], { encoding: 'utf8' });
  }
  for (const entry of SPEC.sources) {
    const r = importFixture(entry);
    let receipt = null;
    try { const lines = String(r.stdout || '').trim().split('\n'); receipt = JSON.parse(lines[lines.length - 1]); } catch { receipt = null; }
    const man = JSON.parse(readText(path.join(FIXTURES, entry.manifest)));
    t('[B] 导入 ' + man.namespace + ' (' + entry.name + ') 成功', r.status === 0 && receipt && receipt.code === 'IMPORTED',
      receipt ? receipt.code + ' words=' + receipt.counts.words + ' summaries=' + receipt.counts.summaries + ' srcSeqs=' + receipt.counts.srcSeqs : String(r.stderr || '').slice(0, 200));
    report.sources.push({
      name: entry.name, namespace: man.namespace, sourcePath: man.sourcePath,
      words: receipt ? receipt.counts.words : null, summaries: receipt ? receipt.counts.summaries : null,
      srcSeqs: receipt ? receipt.counts.srcSeqs : null, excludedReasoning: receipt ? receipt.counts.excludedReasoning : null,
      echoSourceId: receipt && receipt.source ? receipt.source.echoSourceId : null,
      manifestSha256: shaOf(path.join(FIXTURES, entry.manifest)),
    });
  }

  store = openMetaStore({ path: DB, mode: 'readonly' });
  const stats = store.echoStats();
  storeStatsBefore = stats;
  t('[B] 导入后索引对齐（aligned=true）且只有两个来源',
    stats.ok === true && stats.aligned === true && stats.sources.length === 2,
    'sources=' + stats.sources.map((s) => s.sourcePath + ' ' + s.words + '/' + s.summaries).join(' | '));
  t('[B] 每来源 words/summaries 与 FTS、有序 srcSeqs 全对齐', stats.sources.every((s) => s.aligned === true));
  dbHashAfterImport = shaOf(DB);

  const namespaceById = new Map(stats.sources.map((s) => [s.echoSourceId, s.namespace]));

  // ── C. oracle（独立于 DB/FTS/导入器）───────────────────────────────────
  const oracle = buildOracle();
  t('[C] oracle 只从 fixture JSONL 重建：12 words / 5 summaries',
    oracle.words.length === 12 && oracle.summaries.length === 5,
    'words=' + oracle.words.length + ' summaries=' + oracle.summaries.length);
  t('[C] oracle 里没有推理行（REASONING-CANARY 不进索引）',
    oracle.words.every((w) => lower(w.text).indexOf('reasoning-canary') === -1));

  // ── C2. oracle 的「顺序」主张必须被库验一次（不是自证）────────────────────
  // oracle 用「导入顺序 → 源文件行序」重建，而 raw-scan 按 rowid 升序返回 ——
  // 只有两者真的相同，才允许拿 oracle 去断言 pointer **顺序**。这里把库的 rowid 顺序
  // 直接读出来对一遍：oracle 全程没读过库，读库的只有这一句，方向是「库 → 断言」。
  const dbWordOrder = store.db.prepare('select rowid as rid, echo_source_id as sid, session, seq from echo_words order by rowid').all()
    .map((r) => (namespaceById.get(r.sid) || '<unknown-source>') + ':' + r.session + '#seq=' + r.seq);
  const dbSummaryOrder = store.db.prepare('select rowid as rid, cmp_id from echo_summaries order by rowid').all()
    .map((r) => 'idx:' + r.cmp_id);
  t('[C] oracle 的 words 顺序 == 临时库的 rowid 顺序（raw-scan 的返回顺序就是它）',
    same(oracle.words.map((w) => w.ptr), dbWordOrder), 'oracle=' + oracle.words.length + ' db=' + dbWordOrder.length);
  t('[C] oracle 的 summaries 顺序 == 临时库的 rowid 顺序', same(oracle.summaries.map((x) => x.ptr), dbSummaryOrder),
    'oracle=' + oracle.summaries.length + ' db=' + dbSummaryOrder.length);

  // ── D. MCP 腿：同一个临时库（env 是给自检的显式覆盖，不来自 MCP 参数）─────
  process.env.AGENT_SOUL_META_DB = DB;
  process.env.AGENT_SOUL_READONLY = '1';
  delete process.env.AGENT_SOUL_DATA;
  mcp = await import('../src/adapters/mcp-tools.mjs');
  const mcpStats = await mcpCall(mcp, 'soul_echo_stats', {});
  t('[D] MCP soul_echo_stats 读同一个临时库（readonly=true，两来源）',
    mcpStats.ok && mcpStats.json.ok === true && mcpStats.json.readonly === true && mcpStats.json.sources.length === 2,
    mcpStats.ok ? 'sources=' + mcpStats.json.sources.length : mcpStats.error);

  // ── E. Q01–Q12：逐 Q 打覆盖矩阵；逐探针做三条腿的差分 ────────────────────
  const dateFilteredProbes = [];
  const positiveProbes = [];
  const negativeProbes = [];
  const coverageProbes = [];
  const auxiliaryProbes = [];

  for (const q of SPEC.queries) {
    const legs = parseSrc(q.baselineOptions);
    const qReport = {
      id: q.id, baselineInput: q.baselineInput, baselineOptions: q.baselineOptions,
      baselineEvidence: q.baselineEvidence || null, legs,
      coverage: q.coverage, coveredLeg: q.coveredLeg || null, why: q.why || null,
      gaps: q.gaps || [], notReproduced: q.notReproduced || [], probes: [],
    };
    console.log('');
    console.log('  ' + q.id + '  ' + q.coverage + (q.coveredLeg ? '(' + q.coveredLeg.surface + '@limit=' + q.coveredLeg.limit + ')' : '')
      + '  baseline: ' + JSON.stringify(q.baselineInput) + '  options=' + JSON.stringify(q.baselineOptions) + '  legs=[' + legs.join(',') + ']');
    if (q.why) console.log('        why: ' + q.why);
    if ((q.gaps || []).length) console.log('        gaps: ' + q.gaps.map((g) => g.kind + ' — ' + g.detail).join(' | '));
    console.log('        notReproduced: ' + ((q.notReproduced || []).length ? q.notReproduced.join(' | ') : '(无 —— 这一条什么都没声称)'));
    console.log('        probes: ' + ((q.probes || []).length
      ? q.probes.map((p) => p.role + '(' + p.surface + '@' + p.limit + ')').join(' + ')
      : '0（没有探针，覆盖为 0）'));

    if (q.coverage === 'COVERED_FIXTURE') {
      console.log('        ★ COVERED_FIXTURE 只到这一步：' + q.coveredLegNote);
    }

    for (let i = 0; i < (q.probes || []).length; i += 1) {
      const probe = q.probes[i];
      const label = q.id + '#' + (i + 1);
      const roleTag = '[' + probe.role + ']';
      const plan = buildQueryPlan(probe.query);
      const orderCheck = plan.matchMode !== 'bigram';
      const o = oracleProbe(oracle, probe);
      const exp = probe.expect || {};

      t('[E] ' + label + ' ' + roleTag + ' fixture oracle 与 queries.json 的期望一致（hits/truncated/exhausted）',
        exp.hits === o.returnedCount && exp.truncated === o.truncated && exp.exhausted === o.exhausted,
        'oracle=' + JSON.stringify({ hits: o.returnedCount, truncated: o.truncated, exhausted: o.exhausted, matched: o.matchedTotal }) + ' expect=' + JSON.stringify(exp));
      // ★ 这条保证「截断」这一维可从回执精确推导（不落在 matchedTotal === limit 的歧义点）。
      t('[E] ' + label + ' ' + roleTag + ' 不落在 matchedTotal === limit 的歧义点', o.matchedTotal !== probe.limit,
        'matched=' + o.matchedTotal + ' limit=' + probe.limit);
      // bigram 探针只允许「命中 ≤1 条」，否则顺序不可由 rowid 推导，就不许拿它当证据。
      if (plan.matchMode === 'bigram') {
        t('[E] ' + label + ' ' + roleTag + ' bigram 探针命中 ≤1（顺序平凡，不声称顺序）', o.returnedCount <= 1,
          'hits=' + o.returnedCount);
      }

      const options = { surface: probe.surface, limit: probe.limit };
      if (probe.since !== undefined) options.since = probe.since;
      if (probe.until !== undefined) options.until = probe.until;
      const res = store.echoSearch(probe.query, options);
      const sr = storeReceipt(res, probe.surface);

      const m1 = await mcpCall(mcp, 'soul_echo_search', Object.assign({ query: probe.query }, options));
      const mr = m1.ok ? mcpReceipt(m1.json, probe.surface) : { pointers: [], count: -1, exhausted: null, skipped: false, rawTexts: [], error: m1.error };

      // importer helper 腿：同一份库、同一个连接；**没有** since/until 参数。
      const helperFn = probe.surface === 'words' ? searchEchoWords : searchEchoSummaries;
      const cliRaw = helperFn(store.db, probe.query, { limit: probe.limit });
      const hr = helperReceipt(cliRaw, probe.surface, namespaceById);
      const cliLegApplies = probe.since === undefined && probe.until === undefined;

      const storeDiff = checkReceipt(o, sr, { orderCheck });
      const mcpDiff = m1.ok ? checkReceipt(o, mr, { orderCheck }) : ['mcp-call-failed:' + m1.error];
      const helperDiff = cliLegApplies ? checkReceipt(o, hr, { orderCheck }) : ['helper-leg-not-applicable:no-date-filter'];

      t('[E] ' + label + ' ' + roleTag + ' Store == fixture oracle（集合/顺序/条数/exhausted/截断）', storeDiff.length === 0, storeDiff.join(',') || ('pointers=' + sr.count + ' exhausted=' + sr.exhausted));
      t('[E] ' + label + ' ' + roleTag + ' MCP == fixture oracle（同一组维度）', mcpDiff.length === 0, mcpDiff.join(',') || ('pointers=' + mr.count + ' exhausted=' + mr.exhausted));
      if (cliLegApplies) {
        t('[E] ' + label + ' ' + roleTag + ' importer helper == fixture oracle（同一组维度）', helperDiff.length === 0, helperDiff.join(',') || ('pointers=' + hr.count + ' exhausted=' + hr.exhausted));
        t('[E] ' + label + ' ' + roleTag + ' importer helper 与 Store 逐条同一（ptr、原文、顺序）',
          same(hr.pointers, sr.pointers) && same(hr.rawTexts, sr.rawTexts), 'helper=' + hr.count + ' store=' + sr.count);
      } else {
        // 证明「helper 腿不适用」不是推托：传了 since 也不过滤（它的签名里没有时间过滤）。
        // 对照的是**不带 since 的 oracle 计数**（同一探针去掉 since 再算一次），不是带 since 的那一份。
        const rawUnfiltered = helperFn(store.db, probe.query, { limit: probe.limit, since: probe.since });
        const noSinceProbe = Object.assign({}, probe);
        delete noSinceProbe.since;
        const unfilteredOracle = oracleProbe(oracle, noSinceProbe);
        t('[E] ' + label + ' ' + roleTag + ' helper 没有时间过滤（传 since 仍返回未过滤的全量）→ CLI 腿记为 NOT_COVERED',
          rawUnfiltered.results.length === unfilteredOracle.matchedTotal && rawUnfiltered.results.length !== sr.count,
          'helper(unfiltered)=' + rawUnfiltered.results.length + ' oracle(without since)=' + unfilteredOracle.matchedTotal
          + ' store(filtered)=' + sr.count + ' oracle(with since)=' + o.matchedTotal);
      }
      t('[E] ' + label + ' ' + roleTag + ' Store 与 MCP 逐条同一（ptr 与原文、顺序、exhausted）',
        same(sr.pointers, mr.pointers) && same(sr.rawTexts, mr.rawTexts) && sr.exhausted === mr.exhausted && sr.count === mr.count,
        'store=' + sr.count + ' mcp=' + mr.count);
      t('[E] ' + label + ' ' + roleTag + ' 非目标面被显式标 skipped（不把「没查」伪装成「0 命中」）',
        sr.otherClean === true && (m1.ok ? mr.otherClean === true : false));
      t('[E] ' + label + ' ' + roleTag + ' limit 原样传入（Store 与 MCP 一致）', sr.limitPerSurface === probe.limit && (m1.ok ? mr.limitPerSurface === probe.limit : false),
        'store=' + sr.limitPerSurface + ' mcp=' + (m1.ok ? mr.limitPerSurface : 'n/a'));

      // ★ matchMode 约束：COVERAGE 探针必须走 raw-scan（三条腿都要），否则顺序结论不成立。
      if (probe.role === 'COVERAGE') {
        t('[E] ' + label + ' ' + roleTag + ' COVERAGE 探针三条腿都走 raw-scan（顺序可由 rowid 推导）',
          plan.matchMode !== 'bigram' && sr.scanPath === 'raw-scan' && mr.scanPath === 'raw-scan' && hr.scanPath === 'raw-scan',
          'plan=' + plan.matchMode + ' store=' + sr.scanPath + ' mcp=' + mr.scanPath + ' helper=' + hr.scanPath);
      }

      const res2 = store.echoSearch(probe.query, options);
      const sr2 = storeReceipt(res2, probe.surface);
      t('[E] ' + label + ' ' + roleTag + ' 确定性：同一查询重复一次，pointer 顺序逐字相同',
        same(sr.pointers, sr2.pointers) && sr.exhausted === sr2.exhausted);

      if (probe.since !== undefined) dateFilteredProbes.push(label);
      if (probe.role === 'COVERAGE') coverageProbes.push(label); else auxiliaryProbes.push(label);
      if (o.returnedCount > 0) positiveProbes.push(label); else negativeProbes.push(label);

      // helper 腿不适用时（有 since），它不参与 parity —— 但它「不适用」这件事由上一条断言单独证明。
      const helperOk = cliLegApplies ? helperDiff.length === 0 : true;
      const parity = storeDiff.length === 0 && mcpDiff.length === 0 && helperOk && same(sr.pointers, mr.pointers);
      qReport.probes.push({
        label, role: probe.role, query: probe.query, surface: probe.surface, limit: probe.limit, since: o.since,
        matchMode: plan.matchMode, scanPath: sr.scanPath,
        oracle: { pointers: o.pointers, count: o.returnedCount, matchedTotal: o.matchedTotal, truncated: o.truncated, exhausted: o.exhausted },
        store: { pointers: sr.pointers, count: sr.count, exhausted: sr.exhausted },
        mcp: { pointers: mr.pointers, count: mr.count, exhausted: mr.exhausted },
        helper: { pointers: hr.pointers, count: hr.count, exhausted: hr.exhausted },
        cliLeg: cliLegApplies ? 'COMPARED' : 'NOT_COVERED_NO_DATE_FILTER',
        parity,
      });
      console.log('        ' + label + '  ' + probe.role + '  ' + probe.surface + '  query=' + JSON.stringify(probe.query) + '  limit=' + probe.limit
        + (o.since ? '  since=' + o.since : '')
        + '  mode=' + plan.matchMode + '/' + sr.scanPath
        + '  → hits=' + o.returnedCount + '/' + o.matchedTotal + ' exhausted=' + o.exhausted + ' truncated=' + o.truncated
        + '  ptr=[' + o.pointers.join(', ') + ']'
        + '  store=' + (storeDiff.length === 0 ? 'ok' : 'FAIL') + ' mcp=' + (mcpDiff.length === 0 ? 'ok' : 'FAIL')
        + ' helper=' + (cliLegApplies ? (helperDiff.length === 0 ? 'ok' : 'FAIL') : 'n/a(no-date-filter)')
        + '  parity=' + (parity ? 'ok' : 'FAIL'));
    }
    report.matrix.push(qReport);
  }

  t('[E] 覆盖探针只有 Q04/Q05 的 summaries@limit=3（共 2 条），其余探针一律 AUXILIARY_FIXTURE',
    same(coverageProbes, ['Q04#1', 'Q05#1']), coverageProbes.join(','));
  t('[E] 辅助探针 8 条（Q01/Q02/Q03/Q04#2/Q06/Q07/Q08/Q09）',
    same(auxiliaryProbes, ['Q01#1', 'Q02#1', 'Q03#1', 'Q04#2', 'Q06#1', 'Q07#1', 'Q08#1', 'Q09#1']), auxiliaryProbes.join(','));
  t('[E] 三种面都在：正例 / 负例 / 日期过滤',
    positiveProbes.length >= 6 && negativeProbes.length >= 3 && dateFilteredProbes.length >= 1,
    'positive=' + positiveProbes.join(',') + ' | negative=' + negativeProbes.join(',') + ' | dated=' + dateFilteredProbes.join(','));


  // ── E2. 时间边界：显式带偏移量的 ISO 瞬间（AUXILIARY_FIXTURE · 临时合成语料）────
  // ★ 这一节只建立**一件事**：**显式带时区偏移量**的 ISO-8601 边界（since / until）被解释成
  //   哪个瞬间，以及边界上的包含/排除语义 —— t==since 含入、t==since-1s 排除、
  //   t==until 含入、t==until+1s 排除，另有只给 since / 只给 until 两条。
  // ★ 语料是本进程**临时目录里现写的合成行**，走的仍是同一个导入器 CLI
  //   （不是 fixture 文件；fixture 的字节由 [H] 前后 SHA 比对，一个字节都不动）。
  // ★ 比较基要写清（否则「瞬间语义」是句空话）：Store 与 MCP 这条腿的日期过滤是
  //   比较基为 SQLite julianday 瞬间比较（回执 filters.timeComparedAs='julianday-instant'）。
  //   本节刻意让相同瞬间使用 Z 与 +08:00 两种文本，验证输入 offset 归一后仍命中同一时间边界。
  // ★ 它**绝不**建立：基线 Q06 那条**没有时区**的 since 的语义（本机按 +08:00 解析成
  //   2026-11-12T16:00:00Z，与 UTC 形式差 8 小时）—— Q06 仍然是 NOT_COVERED；
  //   也**不**等于 live 一致（生产索引 / live memq / 墨 一次都没跑）。
  // ★ 三条腿里只有 Store 与 MCP 有时间过滤：importer helper 的签名里没有 since/until，
  //   所以它只与**不带日期过滤的 oracle** 对齐，这一维记为 NOT_COVERED_NO_DATE_FILTER。
  const TB_SESSION = 'session-echoq-timebound';
  const TB_NEEDLE = 'TIMEBOUND';
  const TB_SINCE = '2026-11-13T00:00:00+08:00';
  const TB_UNTIL = '2026-11-13T01:00:00+08:00';
  const TB_SINCE_UTC = '2026-11-12T16:00:00.000Z';
  const TB_UNTIL_UTC = '2026-11-12T17:00:00.000Z';
  const TB_ROWS = [
    { seq: 1, t: '2026-11-12T15:59:59.000Z', text: 'TIMEBOUND one second before the since instant' },
    { seq: 2, t: '2026-11-12T16:00:00.000Z', text: 'TIMEBOUND exactly at the since instant with UTC text' },
    { seq: 3, t: '2026-11-12T16:30:00.000Z', text: 'TIMEBOUND inside the window' },
    { seq: 4, t: '2026-11-12T17:00:00.000Z', text: 'TIMEBOUND exactly at the until instant with UTC text' },
    { seq: 5, t: '2026-11-12T17:00:01.000Z', text: 'TIMEBOUND one second after the until instant' },
    { seq: 6, t: '2026-11-12T16:45:00.000Z', text: 'inside the window but without the needle' },
  ];
  const tbPtr = (seq) => 'log:' + TB_SESSION + '#seq=' + seq;
  const tbSeqsOf = (pointers) => pointers.map((p) => Number(String(p).split('#seq=')[1]));

  const AUX_DIR = path.join(ROOT, 'aux-timebound');
  const AUX_DB = path.join(ROOT, 'aux-timebound.sqlite');
  fs.mkdirSync(AUX_DIR, { recursive: true });
  function writeTbFile(name, body) {
    const abs = path.join(AUX_DIR, name);
    fs.writeFileSync(abs, body);
    return abs;
  }
  const tbWordRows = TB_ROWS.map((r) => ({
    t: r.t, session: TB_SESSION, ws: 'ws-echoq-timebound', seq: r.seq, turn: r.seq,
    log: 'D:/synthetic/logs/echoq-timebound.jsonl', role: 'user', kind: 'message',
    len: r.text.length, truncated: false, text: r.text,
  }));
  const tbSummaryRows = [{
    cmpId: 'cmp-echoq-timebound-01', t: '2026-11-12T15:00:00.000Z', session: TB_SESSION,
    ws: 'ws-echoq-timebound', log: 'D:/synthetic/logs/echoq-timebound.jsonl', srcSeqs: [1],
    shadowedTokens: 4, shadowedChars: 8, provider: null, model: null, status: 'active',
    summary: 'tb summary inside the time-boundary corpus (no needle here)',
  }];
  const tbWordsPath = writeTbFile('words.jsonl', tbWordRows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const tbSummariesPath = writeTbFile('summaries.jsonl', tbSummaryRows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const tbManifest = {
    echoIndexVersion: 'echo-index/1',
    sourcePath: 'D:/synthetic/echo-fixed-query/timebound/index',
    namespace: 'log',
    generation: 1,
    builtAt: '2026-11-10T02:00:00.000Z',
    cursor: { seq: 6 },
    words: { path: 'words.jsonl', sha256: shaOf(tbWordsPath), bytes: fs.statSync(tbWordsPath).size, rows: tbWordRows.length },
    summaries: { path: 'summaries.jsonl', sha256: shaOf(tbSummariesPath), bytes: fs.statSync(tbSummariesPath).size, rows: tbSummaryRows.length },
    counts: { words: tbWordRows.length, summaries: tbSummaryRows.length, srcSeqs: 1, excludedReasoning: 0 },
  };
  const tbManifestPath = writeTbFile('manifest.json', JSON.stringify(tbManifest, null, 2) + '\n');
  t('[E2] 合成语料与临时库都在 os.tmpdir() 之下（不是仓库里的文件）',
    inside(TMP_BASE, AUX_DIR) && inside(TMP_BASE, AUX_DB), rel(AUX_DIR) + ' , ' + rel(AUX_DB));

  const tbCreated = openMetaStore({ path: AUX_DB, mode: 'readwrite' });
  try { tbCreated.migrate(); } finally { tbCreated.close(); }
  const tbImport = spawnSync(NODE, [IMPORTER, '--manifest', tbManifestPath, '--sha256', shaOf(tbManifestPath), '--generation', '1', '--db', AUX_DB, '--json'], { encoding: 'utf8' });
  let tbReceipt = null;
  try { const lines = String(tbImport.stdout || '').trim().split('\n'); tbReceipt = JSON.parse(lines[lines.length - 1]); } catch { tbReceipt = null; }
  t('[E2] 合成语料经同一个导入器 CLI 入库（AUXILIARY_FIXTURE，不是 fixture 文件）',
    tbImport.status === 0 && !!tbReceipt && tbReceipt.code === 'IMPORTED' && tbReceipt.counts.words === tbWordRows.length,
    tbReceipt ? tbReceipt.code + ' words=' + tbReceipt.counts.words + ' summaries=' + tbReceipt.counts.summaries : String(tbImport.stderr || '').slice(0, 200));
  const tbSourceId = tbReceipt && tbReceipt.source ? tbReceipt.source.echoSourceId : null;
  const tbStore = openMetaStore({ path: AUX_DB, mode: 'readonly' });
  const tbNamespaceById = new Map([[tbSourceId, 'log']]);

  // oracle 仍然只读「写在盘上的 JSONL」，不经 FTS / 不经 DB / 不用 SQLite 的 julianday。
  const tbOracle = {
    words: readJsonl(tbWordsPath).map((r, i) => ({ order: i, ptr: 'log:' + r.session + '#seq=' + r.seq, t: r.t, text: r.text })),
    summaries: [],
  };
  t('[E2] 合成语料落盘后是 6 行 words / 1 行 summaries（oracle 从盘上的 JSONL 重建）',
    tbOracle.words.length === 6 && tbOracle.words.map((w) => w.ptr).join(',') === TB_ROWS.map((r) => tbPtr(r.seq)).join(','),
    tbOracle.words.length + ' rows');
  t('[E2] 合成行的 t 一律是规范 UTC 文本（字符串序 == 时间序，比较基才对得上）',
    TB_ROWS.every((r) => isCanonicalInstant(r.t) && r.t === new Date(Date.parse(r.t)).toISOString()),
    TB_ROWS.map((r) => r.t).join(' , '));

  const tbProbes = [
    {
      label: 'TB#1', limit: 10, since: TB_SINCE, until: TB_UNTIL, expectSeqs: [2, 3, 4], truncated: false, exhausted: true,
      establishes: '显式 +08:00 偏移量的 since/until 被归一化成同一个 UTC 瞬间，两端都**含入**：t==since 与 t==until 在集合内，两端各差 1 秒的行都被排除',
      doesNotEstablish: '基线 Q06 那条没有时区的 since（本机按 +08:00 解析成 2026-11-12T16:00:00Z）；live 命中数 / 首指针 / 生产库；importer helper 的时间过滤（它没有这个参数）',
    },
    {
      label: 'TB#2', limit: 10, since: TB_SINCE, expectSeqs: [2, 3, 4, 5], truncated: false, exhausted: true,
      establishes: '**只给 since** 时上界不生效：t==since 含入，until 之后的行仍然返回',
      doesNotEstablish: '基线 Q06 的无时区 since；live 的 24 命中；helper 腿（无时间过滤）；非规范时间文本',
    },
    {
      label: 'TB#3', limit: 10, until: TB_UNTIL, expectSeqs: [1, 2, 3, 4], truncated: false, exhausted: true,
      establishes: '**只给 until** 时下界不生效：t==until 含入，since 之前的行仍然返回',
      doesNotEstablish: '基线 Q06 的无时区 since（这条探针根本没有 since）；live 命中数；helper 腿；非规范时间文本',
    },
    {
      label: 'TB#4', limit: 2, since: TB_SINCE, until: TB_UNTIL, expectSeqs: [2, 3], truncated: true, exhausted: false,
      establishes: '两端都给的窗口在 limit 不足时按 rowid 顺序截断（count==limit 且 exhausted=false 才叫截断）',
      doesNotEstablish: '基线 Q06 的无时区 since；基线自己的 limit（这是辅助探针自己的 limit=2）；live 排名',
    },
  ];

  const tbResults = {};
  for (const p of tbProbes) {
    const probe = { surface: 'words', query: TB_NEEDLE, limit: p.limit };
    if (p.since !== undefined) probe.since = p.since;
    if (p.until !== undefined) probe.until = p.until;
    const o = oracleProbe(tbOracle, probe);
    t('[E2] ' + p.label + ' fixture oracle 与写死的期望一致（seqs / truncated / exhausted）',
      same(tbSeqsOf(o.pointers), p.expectSeqs) && o.truncated === p.truncated && o.exhausted === p.exhausted,
      'oracle=' + JSON.stringify({ seqs: tbSeqsOf(o.pointers), matched: o.matchedTotal, truncated: o.truncated, exhausted: o.exhausted }));
    t('[E2] ' + p.label + ' 不落在 matchedTotal === limit 的歧义点（截断可精确推导）',
      o.matchedTotal !== p.limit, 'matched=' + o.matchedTotal + ' limit=' + p.limit);

    const options = { surface: 'words', limit: p.limit };
    if (p.since !== undefined) options.since = p.since;
    if (p.until !== undefined) options.until = p.until;
    const res = tbStore.echoSearch(TB_NEEDLE, options);
    const sr = storeReceipt(res, 'words');

    let m1;
    try {
      process.env.AGENT_SOUL_META_DB = AUX_DB;
      m1 = await mcpCall(mcp, 'soul_echo_search', Object.assign({ query: TB_NEEDLE }, options));
    } finally {
      process.env.AGENT_SOUL_META_DB = DB;
    }
    const mr = m1.ok ? mcpReceipt(m1.json, 'words') : { pointers: [], count: -1, exhausted: null, skipped: false, rawTexts: [], error: m1.error };

    // helper 腿：**没有** since/until —— 传了也不过滤。所以它只能与「不带日期过滤的 oracle」对齐。
    const helperRaw = searchEchoWords(tbStore.db, TB_NEEDLE, { limit: p.limit, since: p.since, until: p.until });
    const hr = helperReceipt(helperRaw, 'words', tbNamespaceById);
    const oNoDate = oracleProbe(tbOracle, { surface: 'words', query: TB_NEEDLE, limit: p.limit });

    const storeDiff = checkReceipt(o, sr, { orderCheck: true });
    const mcpDiff = m1.ok ? checkReceipt(o, mr, { orderCheck: true }) : ['mcp-call-failed:' + m1.error];
    const helperDiff = checkReceipt(oNoDate, hr, { orderCheck: true });

    t('[E2] ' + p.label + ' Store == fixture oracle（集合/顺序/条数/exhausted/截断）',
      storeDiff.length === 0, storeDiff.join(',') || ('seqs=' + tbSeqsOf(sr.pointers).join(',') + ' exhausted=' + sr.exhausted));
    t('[E2] ' + p.label + ' MCP == fixture oracle（同一组维度）', mcpDiff.length === 0,
      mcpDiff.join(',') || ('seqs=' + tbSeqsOf(mr.pointers).join(',') + ' exhausted=' + mr.exhausted));
    t('[E2] ' + p.label + ' Store 与 MCP 逐条同一（ptr、原文、顺序、exhausted）',
      same(sr.pointers, mr.pointers) && same(sr.rawTexts, mr.rawTexts) && sr.exhausted === mr.exhausted && sr.count === mr.count,
      'store=' + sr.count + ' mcp=' + mr.count);
    t('[E2] ' + p.label + ' importer helper == 不带日期过滤的 oracle（同一 limit；集合/顺序/条数/exhausted）',
      helperDiff.length === 0, helperDiff.join(',') || ('seqs=' + tbSeqsOf(hr.pointers).join(',') + ' exhausted=' + hr.exhausted));
    t('[E2] ' + p.label + ' helper 的时间过滤不存在：传了 since/until 仍返回未过滤的全量 → 这一维 CLI 腿记 NOT_COVERED_NO_DATE_FILTER',
      same(tbSeqsOf(hr.pointers), tbSeqsOf(oNoDate.pointers)) && !same(hr.pointers, sr.pointers),
      'helper=' + hr.count + ' store(filtered)=' + sr.count + ' helperSeqs=' + tbSeqsOf(hr.pointers).join(',') + ' storeSeqs=' + tbSeqsOf(sr.pointers).join(','));
    t('[E2] ' + p.label + ' 非目标面被显式标 skipped（不把「没查」伪装成「0 命中」）', sr.otherClean === true && mr.otherClean === true);

    tbResults[p.label] = { probe: p, o, sr, mr, hr, oNoDate, res, mfilters: m1.ok ? m1.json.filters : null };
    console.log('        ' + p.label + '  AUXILIARY_FIXTURE  words  query=' + JSON.stringify(TB_NEEDLE) + '  limit=' + p.limit
      + (p.since ? '  since=' + p.since : '') + (p.until ? '  until=' + p.until : '')
      + '  → oracle seqs=[' + tbSeqsOf(o.pointers).join(',') + '] matched=' + o.matchedTotal
      + ' exhausted=' + o.exhausted + ' truncated=' + o.truncated
      + '  store=' + (storeDiff.length === 0 ? 'ok' : 'FAIL') + ' mcp=' + (mcpDiff.length === 0 ? 'ok' : 'FAIL')
      + ' helper(unfiltered)=' + hr.count + ' [NOT_COVERED_NO_DATE_FILTER]');
  }

  // 比较基与边界的归一化：这两条把「显式偏移量被解释成哪个瞬间」写成可核对的字据。
  const tbMain = tbResults['TB#1'];
  t('[E2] 显式 +08:00 偏移量的边界被归一化成 UTC 瞬间（Store 回执 filters.since/until）',
    tbMain.res.filters.since === TB_SINCE_UTC && tbMain.res.filters.until === TB_UNTIL_UTC,
    tbMain.res.filters.since + ' .. ' + tbMain.res.filters.until);
  t('[E2] 边界字符串与行字符串不同（+08:00 vs Z）但同一瞬间 → 含入，说明不是按字面比较边界',
    TB_ROWS[1].t !== TB_SINCE && Date.parse(TB_ROWS[1].t) === Date.parse(TB_SINCE)
    && tbResults['TB#1'].sr.pointers.indexOf(tbPtr(2)) !== -1,
    TB_ROWS[1].t + ' vs ' + TB_SINCE);
  t('[E2] Store 与 MCP 都声明 julianday-instant，并含入 offset 文本的等时刻行',
    tbMain.res.filters.timeComparedAs === 'julianday-instant' && !!tbMain.mfilters && tbMain.mfilters.timeComparedAs === 'julianday-instant'
      && tbMain.sr.pointers.indexOf(tbPtr(2)) !== -1 && tbMain.sr.pointers.indexOf(tbPtr(4)) !== -1,
    String(tbMain.res.filters.timeComparedAs) + ' / ' + String(tbMain.mfilters && tbMain.mfilters.timeComparedAs));

  // 四条边界事实逐条点名（都拿「不过滤」的结果做对照：行本身存在且含 needle）。
  const tbUnfilteredStore = storeReceipt(tbStore.echoSearch(TB_NEEDLE, { surface: 'words', limit: 50 }), 'words');
  const tbFactRows = [
    { name: 't == since **含入**', seq: 2, expected: true },
    { name: 't == since-1s **排除**', seq: 1, expected: false },
    { name: 't == until **含入**', seq: 4, expected: true },
    { name: 't == until+1s **排除**', seq: 5, expected: false },
  ];
  const tbFacts = [];
  for (const f of tbFactRows) {
    const ptr = tbPtr(f.seq);
    const included = tbResults['TB#1'].sr.pointers.indexOf(ptr) !== -1;
    const control = tbUnfilteredStore.pointers.indexOf(ptr) !== -1;
    t('[E2] 边界事实：' + f.name, included === f.expected && control === true,
      ptr + ' included=' + included + ' (expected ' + f.expected + ') control(unfiltered)=' + control);
    tbFacts.push({ fact: f.name, ptr, included, expected: f.expected, controlUnfiltered: control });
  }
  t('[E2] 本节两端的边界都是显式带偏移量的 ISO 瞬间（不是 Q06 那种无时区形式）',
    isCanonicalInstant(TB_SINCE) && isCanonicalInstant(TB_UNTIL)
      && TB_ROWS[1].t.endsWith('Z') && TB_ROWS[1].t !== TB_SINCE && Date.parse(TB_ROWS[1].t) === Date.parse(TB_SINCE)
      && TB_ROWS[3].t.endsWith('Z') && TB_ROWS[3].t !== TB_UNTIL && Date.parse(TB_ROWS[3].t) === Date.parse(TB_UNTIL)
      && isCanonicalInstant(parseSince(q06.baselineOptions)) === false,
    TB_SINCE + ' , ' + TB_UNTIL);

  // 反证：边界不是空转 —— 把 oracle 换成「严格大于 / 严格小于」的排他约定，差分器必须报出来。
  const tbStrictOracle = (sinceMs, untilMs) => {
    const matched = tbOracle.words.filter((e) => {
      const x = Date.parse(e.t);
      if (sinceMs !== null && x <= sinceMs) return false;
      if (untilMs !== null && x >= untilMs) return false;
      return lower(e.text).indexOf(lower(TB_NEEDLE)) !== -1;
    });
    const limit = 10;
    const returned = matched.slice(0, limit);
    return { pointers: returned.map((e) => e.ptr), limit, returnedCount: returned.length, matchedTotal: matched.length, truncated: matched.length > limit, exhausted: matched.length < limit };
  };
  const strictSinceDiff = checkReceipt(tbStrictOracle(Date.parse(TB_SINCE), null), tbResults['TB#2'].sr, { orderCheck: true });
  const strictUntilDiff = checkReceipt(tbStrictOracle(null, Date.parse(TB_UNTIL)), tbResults['TB#3'].sr, { orderCheck: true });
  t('[E2] 反证：若 since 是**排他**的（严格大于），TB#2 的 Store 回执会被差分器判成 pointer-set',
    strictSinceDiff.indexOf('pointer-set') !== -1, strictSinceDiff.join(',') || 'NO DIFF — 边界测试是空转');
  t('[E2] 反证：若 until 是**排他**的（严格小于），TB#3 的 Store 回执会被差分器判成 pointer-set',
    strictUntilDiff.indexOf('pointer-set') !== -1, strictUntilDiff.join(',') || 'NO DIFF — 边界测试是空转');

  // 与 Q06 的关系：本节的合成探针一条都不进覆盖矩阵，Q06 仍然是 NOT_COVERED。
  t('[E2] Q06 仍然是 NOT_COVERED，且它名下没有 COVERAGE 探针（本节合成探针不计入覆盖）',
    q06.coverage === 'NOT_COVERED' && q06Probes.every((p) => p.role === 'AUXILIARY_FIXTURE')
    && coverageProbes.indexOf('Q06#1') === -1);
  t('[E2] 本节探针只此 4 条，且全部标成 AUXILIARY_FIXTURE（带 establishes / doesNotEstablish）',
    tbProbes.length === 4 && tbProbes.every((p) => p.establishes.length > 8 && p.doesNotEstablish.length > 8));

  tbStore.close();
  report.timeBoundary = {
    corpus: 'synthetic rows written into this process tmp dir (not fixture files)',
    db: rel(AUX_DB),
    surface: 'words',
    bounds: { since: TB_SINCE, until: TB_UNTIL, normalizedToUtc: [TB_SINCE_UTC, TB_UNTIL_UTC], form: 'explicit ISO-8601 offset (+08:00)' },
    comparisonBasis: tbMain.res.filters.timeComparedAs,
    boundaryFacts: tbFacts,
    probes: tbProbes.map((p) => ({
      label: p.label, role: 'AUXILIARY_FIXTURE', limit: p.limit, since: p.since || null, until: p.until || null,
      oracleSeqs: tbSeqsOf(tbResults[p.label].o.pointers),
      oracleMatchedTotal: tbResults[p.label].o.matchedTotal,
      oracleTruncated: tbResults[p.label].o.truncated, oracleExhausted: tbResults[p.label].o.exhausted,
      storeSeqs: tbSeqsOf(tbResults[p.label].sr.pointers), mcpSeqs: tbSeqsOf(tbResults[p.label].mr.pointers),
      helperSeqsUnfiltered: tbSeqsOf(tbResults[p.label].hr.pointers),
      helperLeg: 'NOT_COVERED_NO_DATE_FILTER',
      establishes: p.establishes, doesNotEstablish: p.doesNotEstablish,
    })),
    helperLeg: 'NOT_COVERED_NO_DATE_FILTER (searchEchoWords has no since/until option)',
    strictnessControls: { exclusiveSinceWouldBeFlagged: strictSinceDiff.indexOf('pointer-set') !== -1, exclusiveUntilWouldBeFlagged: strictUntilDiff.indexOf('pointer-set') !== -1 },
    establishes: 'explicit-offset ISO-8601 bounds are normalized to the UTC instant, and both ends are inclusive (t==since and t==until included; t==since-1s and t==until+1s excluded); only-since and only-until behave as one-sided bounds',
    doesNotEstablish: 'the timezone-less baseline since of Q06 (local +08:00 parse, not the UTC instant), live parity, production data, the importer helper date filter (it has none), and instant semantics for non-canonical t text such as +08:00 (Store/MCP compare ISO-8601 strings: filters.timeComparedAs=iso8601-string)',
    liveEvidenceReproduced: false,
    q06StillNotCovered: true,
  };
  console.log('');
  console.log('  时间边界（AUXILIARY_FIXTURE · 临时合成语料 · 只建立「显式偏移量」的边界语义）：');
  for (const f of tbFacts) console.log('    ' + f.fact + '  → included=' + f.included + '（不过滤时存在=' + f.controlUnfiltered + '）');
  console.log('    比较基=' + report.timeBoundary.comparisonBasis + '；边界 ' + TB_SINCE + ' → ' + TB_SINCE_UTC + '，' + TB_UNTIL + ' → ' + TB_UNTIL_UTC);
  console.log('    ★ 不建立：Q06 的无时区 since（NOT_COVERED）、live 一致、helper 的时间过滤（没有这个参数）、非规范时间文本的瞬间语义');

  // ── F. 门牌打开：log / v4log / idx（含两跳）─────────────────────────────
  const openCases = SPEC.pointerCases;
  for (const c of openCases) {
    const caseReport = { id: c.id, ptr: c.ptr, ptrs: c.ptrs, coverage: c.coverage, checks: [], parity: false };
    if (c.ptrs) {
      const [a, b] = c.ptrs;
      const sa = store.echoOpen(a);
      const sb = store.echoOpen(b);
      const ma = await mcpCall(mcp, 'soul_echo_open', { ptr: a });
      const mb = await mcpCall(mcp, 'soul_echo_open', { ptr: b });
      t('[F] ' + c.id + ' 同名 session+seq 在 log / v4log 各自打开自己的正文（互不冒充）',
        sa.word.text === c.expect.logText && sb.word.text === c.expect.v4Text && sa.word.text !== sb.word.text);
      t('[F] ' + c.id + ' MCP 腿给出同样的两条正文',
        ma.ok && mb.ok && ma.json.word.text === c.expect.logText && mb.json.word.text === c.expect.v4Text);
      t('[F] ' + c.id + ' 门牌文本原样返回、命名空间不互相改写',
        sa.ptr === a && sb.ptr === b && sa.namespace === 'log' && sb.namespace === 'v4log' && ma.json.ptr === a && mb.json.ptr === b);
      caseReport.checks.push({ logText: sa.word.text, v4Text: sb.word.text, namespaces: [sa.namespace, sb.namespace] });
      caseReport.parity = true;
      console.log('');
      console.log('  ' + c.id + '  COVERED_FIXTURE  log=' + JSON.stringify(sa.word.text) + ' v4log=' + JSON.stringify(sb.word.text));
      report.pointerCases.push(caseReport);
      continue;
    }

    const s = store.echoOpen(c.ptr);
    const m = await mcpCall(mcp, 'soul_echo_open', { ptr: c.ptr });
    t('[F] ' + c.id + ' MCP 与 Store 都打开 ' + c.ptr, m.ok && m.json.ok === true && m.json.ptr === c.ptr && m.json.status === s.status);
    if (s.kind === 'word') {
      t('[F] ' + c.id + ' kind=word / 正文逐字等于 fixture', s.kind === 'word' && s.word.text === c.expect.text, s.word.text);
      t('[F] ' + c.id + ' 命名空间与截断字段原样保留',
        s.namespace === c.expect.namespace && (c.expect.truncated === undefined || s.word.truncated === c.expect.truncated)
        && (c.expect.len === undefined || s.word.len === c.expect.len),
        'ns=' + s.namespace + ' truncated=' + s.word.truncated + ' len=' + s.word.len);
      t('[F] ' + c.id + ' MCP 腿的正文/命名空间/截断与 Store 逐字相同',
        m.json.namespace === s.namespace && m.json.word.text === s.word.text && m.json.word.truncated === s.word.truncated);
      caseReport.checks.push({ kind: s.kind, namespace: s.namespace, text: s.word.text, truncated: s.word.truncated, len: s.word.len });
    } else {
      t('[F] ' + c.id + ' kind=summary / opensFrame=false（idx 只开摘要）',
        s.kind === 'summary' && s.opensFrame === false && m.json.opensFrame === false && m.json.kind === 'summary');
      t('[F] ' + c.id + ' srcSeqs 顺序与重复原样（' + JSON.stringify(c.expect.srcSeqs) + '）',
        same(s.srcSeqs, c.expect.srcSeqs) && same(m.json.srcSeqs, c.expect.srcSeqs), JSON.stringify(s.srcSeqs));
      if (c.expect.status !== undefined) {
        t('[F] ' + c.id + ' 摘要状态保留（' + c.expect.status + '）',
          s.summary.status === c.expect.status && m.json.summary.status === c.expect.status);
      } else {
        t('[F] ' + c.id + ' 摘要状态可读且 Store/MCP 一致',
          typeof s.summary.status === 'string' && s.summary.status === m.json.summary.status, s.summary.status);
      }
      if (c.expect.framePtrs) {
        const derived = s.srcSeqs.map((seq) => s.source.namespace + ':' + s.summary.session + '#seq=' + seq);
        t('[F] ' + c.id + ' 两跳门牌由 idx 的 namespace + session + srcSeqs 推导', same(derived, c.expect.framePtrs), derived.join(','));
        const frameTexts = [];
        for (const fp of derived) {
          const fr = store.echoOpen(fp);
          const fm = await mcpCall(mcp, 'soul_echo_open', { ptr: fp });
          t('[F] ' + c.id + ' 第二跳 ' + fp + ' 打开原文且 Store/MCP 一致',
            fm.ok && fm.json.word.text === fr.word.text && fr.word.text.length > 0);
          frameTexts.push(fr.word.text);
        }
        t('[F] ' + c.id + ' 两跳原文与 fixture 期望逐字相同', same(frameTexts, c.expect.frameTexts), JSON.stringify(frameTexts));
        caseReport.checks.push({ srcSeqs: s.srcSeqs, framePtrs: derived, frameTexts });
      } else {
        caseReport.checks.push({ kind: s.kind, status: s.summary.status, srcSeqs: s.srcSeqs });
      }
    }
    caseReport.parity = true;
    console.log('');
    console.log('  ' + c.id + '  COVERED_FIXTURE(open)  ' + c.ptr + '  ' + JSON.stringify(caseReport.checks[0]));
    report.pointerCases.push(caseReport);
  }
  t('[F] 门牌覆盖三种命名空间：log / v4log / idx 都有用例',
    ['log:', 'v4log:', 'idx:'].every((p) => SPEC.pointerCases.some((c) => String(c.ptr || (c.ptrs || [])[0]).indexOf(p) === 0)));

  // ── F2. 来源作用域：全查询上的 echoSourceId / sourcePath 一致性 ─────────────
  // ★ 这一节的话很窄：同一份 fixture 库上，把查询按 echoSourceId 收窄时，三条腿仍与
  //   oracle（按 manifest 的 sourcePath 收窄）逐条一致，且每个命中的来源身份都落回
  //   **这一条 fixture 源**。它不证明 live 的 src=索引 过滤，也不证明任何生产 source id
  //   （本机生产源的身份在这里一次都没出现）。
  const manByPath = new Map(SPEC.sources.map((e) => {
    const m = JSON.parse(readText(path.join(FIXTURES, e.manifest)));
    return [m.sourcePath, m];
  }));
  const srcRows = stats.sources.slice();
  t('[F2] 库里的来源身份可被独立推导：echoSourceId === echoSourceIdFor(sourcePath, echoIndexVersion)',
    srcRows.length === 2 && srcRows.every((s) => {
      const m = manByPath.get(s.sourcePath);
      return !!m && s.echoSourceId === echoSourceIdFor(m.sourcePath, m.echoIndexVersion);
    }), srcRows.map((s) => s.sourcePath + ' → ' + s.echoSourceId).join(' | '));
  t('[F2] 库里的 sourcePath 只有 fixture 那两条（没有任何生产 sourcePath）',
    srcRows.every((s) => manByPath.has(s.sourcePath)));

  const scopeQuery = 'ECHO';
  const scopeSurface = 'summaries';
  const scopedUnion = [];
  const scopeCases = [];
  for (const s of srcRows) {
    const m = manByPath.get(s.sourcePath);
    const oScoped = oracleProbe(oracle, { surface: scopeSurface, query: scopeQuery, limit: 500, sourcePath: m.sourcePath });
    const res = store.echoSearch(scopeQuery, { surface: scopeSurface, limit: 500, echoSourceId: s.echoSourceId });
    const hits = res.surfaces.summaries.results;
    const sr = { pointers: hits.map((h) => h.ptr), count: hits.length, exhausted: res.surfaces.summaries.exhausted, skipped: false };
    const diff = checkReceipt(oScoped, sr, { orderCheck: true });
    const scopeDiff = checkScope([s.echoSourceId], hits);
    t('[F2] ' + m.namespace + ' 作用域：Store == oracle（按 sourcePath 收窄；集合/顺序/条数/exhausted）',
      diff.length === 0 && scopeDiff.length === 0, diff.concat(scopeDiff).join(',') || ('hits=' + hits.length));
    t('[F2] ' + m.namespace + ' 作用域：每个命中的 echoSourceId/namespace 指向自己这条源',
      hits.every((h) => h.echoSourceId === s.echoSourceId && h.namespace === m.namespace),
      hits.map((h) => String(h.echoSourceId).slice(0, 10) + '/' + h.namespace).join(',') || 'no hits');
    const mScoped = await mcpCall(mcp, 'soul_echo_search', { query: scopeQuery, surface: scopeSurface, limit: 500, echoSourceId: s.echoSourceId });
    t('[F2] ' + m.namespace + ' 作用域：MCP 与 Store 逐条同一（ptr / echoSourceId / exhausted）',
      !!mScoped.ok && same(mScoped.json.results.map((h) => h.ptr), sr.pointers)
      && mScoped.json.results.every((h) => h.echoSourceId === s.echoSourceId)
      && mScoped.json.exhausted === sr.exhausted,
      mScoped.ok ? ('mcp=' + mScoped.json.results.length) : mScoped.error);
    const hScoped = searchEchoSummaries(store.db, scopeQuery, { limit: 500, echoSourceId: s.echoSourceId });
    t('[F2] ' + m.namespace + ' 作用域：importer helper 与 Store 逐条同一（idx:cmpId / echoSourceId）',
      same(hScoped.results.map((x) => 'idx:' + x.cmpId), sr.pointers)
      && hScoped.results.every((x) => x.echoSourceId === s.echoSourceId), 'helper=' + hScoped.results.length);
    scopedUnion.push.apply(scopedUnion, sr.pointers);
    scopeCases.push({ namespace: m.namespace, echoSourceId: s.echoSourceId, sourcePath: s.sourcePath, pointers: sr.pointers, hits: hits.length, diff });
  }
  const unrestricted = store.echoSearch(scopeQuery, { surface: scopeSurface, limit: 500 }).surfaces.summaries.results.map((h) => h.ptr);
  t('[F2] 各来源作用域的并集 == 不收窄时的全库结果（既不跨源渗漏，也不漏源）',
    same(sorted(scopedUnion), sorted(unrestricted)), 'union=' + scopedUnion.length + ' unrestricted=' + unrestricted.length);

  // 缺席源：生产的 source id 在这里当然不存在 —— 必须**报错**，不许静默退化成全库扫描。
  const ABSENT_SOURCE = 'echo-' + '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f';
  let absentStoreErr = null;
  try { store.echoSearch(scopeQuery, { surface: scopeSurface, limit: 3, echoSourceId: ABSENT_SOURCE }); } catch (e) { absentStoreErr = e; }
  t('[F2] 未知 echoSourceId 在 Store 上必须报 ECHO_SOURCE_NOT_FOUND（不许静默退化成全库）',
    !!absentStoreErr && String(absentStoreErr.code) === 'ECHO_SOURCE_NOT_FOUND', absentStoreErr ? String(absentStoreErr.code) : 'no throw');
  const absentMcp = await mcpCall(mcp, 'soul_echo_search', { query: scopeQuery, surface: scopeSurface, limit: 3, echoSourceId: ABSENT_SOURCE });
  t('[F2] MCP 腿同样报错且不给结果（ok=false + ECHO_SOURCE_NOT_FOUND + 无 results）',
    !!absentMcp.ok && absentMcp.json.ok === false && absentMcp.json.code === 'ECHO_SOURCE_NOT_FOUND' && absentMcp.json.results === undefined,
    absentMcp.ok ? absentMcp.json.code : absentMcp.error);
  let absentHelperErr = null;
  try { searchEchoSummaries(store.db, scopeQuery, { limit: 3, echoSourceId: ABSENT_SOURCE }); } catch (e) { absentHelperErr = e; }
  t('[F2] importer helper 对未知 echoSourceId 报 ECHO_SOURCE_NOT_FOUND',
    !!absentHelperErr && String(absentHelperErr.code) === 'ECHO_SOURCE_NOT_FOUND',
    absentHelperErr ? String(absentHelperErr.code) : 'no throw');
  const controlHits = store.echoSearch(scopeQuery, { surface: scopeSurface, limit: 3 }).surfaces.summaries.results.length;
  t('[F2] 控制组：不传 echoSourceId 时全库确有命中（缺席测试不是空转）', controlHits > 0, 'hits=' + controlHits);
  report.sourceScope = {
    query: scopeQuery, surface: scopeSurface, cases: scopeCases,
    unionEqualsUnrestricted: same(sorted(scopedUnion), sorted(unrestricted)),
    absent: {
      echoSourceId: ABSENT_SOURCE,
      storeCode: absentStoreErr ? String(absentStoreErr.code) : null,
      mcpCode: absentMcp.ok ? absentMcp.json.code : null,
      helperBehaviour: absentHelperErr ? String(absentHelperErr.code) : 'unexpected-no-throw',
      controlHits,
    },
  };
  console.log('');
  console.log('  来源作用域（全查询 = summaries / "ECHO"，limit 放到 500 取全量）：');
  for (const c of scopeCases) console.log('    ' + c.namespace + '  ' + c.echoSourceId + '  ' + c.sourcePath + '  hits=' + c.hits + '  ' + c.pointers.join(', '));
  console.log('    并集=全库：' + (report.sourceScope.unionEqualsUnrestricted ? 'ok' : 'FAIL')
    + ' ｜ 缺席源：store=' + report.sourceScope.absent.storeCode + ' mcp=' + report.sourceScope.absent.mcpCode
    + ' helper=' + report.sourceScope.absent.helperBehaviour);

  // ── F3. 同名命名空间歧义：两条源都用 log 时，不许「挑一个」────────────────
  // 做法：把 fixture 库**复制一份**（仍在临时目录里），只把 v4log 那条源的 namespace 改成
  // log —— 制造「同一个 log:<sid>#seq 命中两个来源」。原库一个字节都不动（[H] 有 SHA 对照）。
  // ★ 它不证明生产索引里真有同名源；它证明**判据在**：多候选时抛歧义、候选带
  //   echoSourceId + sourcePath、拿候选 id 才能精确打开、给错 id 报 MISMATCH。
  const AMB_DB = path.join(ROOT, 'ambiguous.sqlite');
  fs.copyFileSync(DB, AMB_DB);
  const v4Row = srcRows.filter((s) => (manByPath.get(s.sourcePath) || {}).namespace === 'v4log')[0];
  const logRow = srcRows.filter((s) => (manByPath.get(s.sourcePath) || {}).namespace === 'log')[0];
  const ambRw = openMetaStore({ path: AMB_DB, mode: 'readwrite' });
  try { ambRw.db.prepare('update echo_index_sources set namespace = ? where echo_source_id = ?').run('log', v4Row.echoSourceId); } finally { ambRw.close(); }
  const ambStore = openMetaStore({ path: AMB_DB, mode: 'readonly' });
  const nsCase = SPEC.pointerCases.filter((c) => c.ptrs)[0];
  const ambPtr = 'log:session-echoq-shared#seq=12';
  let ambErr = null;
  try { ambStore.echoOpen(ambPtr); } catch (e) { ambErr = e; }
  const ambCandidates = ambErr && ambErr.details && Array.isArray(ambErr.details.candidates) ? ambErr.details.candidates : [];
  t('[F3] 同名命名空间下 ptr 命中两个来源 → ECHO_PTR_AMBIGUOUS（不按顺序/mtime 挑一个）',
    String(ambErr && ambErr.code) === 'ECHO_PTR_AMBIGUOUS', ambErr ? String(ambErr.code) : 'no throw');
  t('[F3] 歧义回执带 2 条显式候选（echoSourceId + sourcePath），不替调用方选',
    ambCandidates.length === 2 && ambCandidates.every((c) => typeof c.echoSourceId === 'string' && String(c.sourcePath).indexOf('D:/synthetic/') === 0),
    ambCandidates.map((c) => c.echoSourceId.slice(0, 10) + ' ' + c.sourcePath).join(' | ') || 'no candidates');
  const pickLog = ambStore.echoOpen(ambPtr, { echoSourceId: logRow.echoSourceId });
  const pickV4 = ambStore.echoOpen(ambPtr, { echoSourceId: v4Row.echoSourceId });
  t('[F3] 用候选 echoSourceId 精确打开：两条正文各自正确、互不冒充',
    pickLog.word.text === nsCase.expect.logText && pickV4.word.text === nsCase.expect.v4Text,
    'log=' + JSON.stringify(pickLog.word.text.slice(0, 14)) + ' v4=' + JSON.stringify(pickV4.word.text.slice(0, 14)));
  t('[F3] selector 只选来源、不改写指针文本（两条都返回同一个 ptr 文本）', pickLog.ptr === ambPtr && pickV4.ptr === ambPtr);
  let mismatchErr = null;
  try { ambStore.echoOpen('log:session-echoq-log#seq=1', { echoSourceId: v4Row.echoSourceId }); } catch (e) { mismatchErr = e; }
  t('[F3] selector 不是该指针的候选项 → ECHO_PTR_SOURCE_MISMATCH（不跨候选去找）',
    String(mismatchErr && mismatchErr.code) === 'ECHO_PTR_SOURCE_MISMATCH', mismatchErr ? String(mismatchErr.code) : 'no throw');
  const dupHits = ambStore.echoSearch('帧', { surface: 'words', limit: 10 }).surfaces.words.results.filter((h) => h.ptr === ambPtr);
  t('[F3] 歧义库上搜索：同一段 ptr 文本出现两次、靠 echoSourceId 区分（同一性不靠 ptr 文本）',
    dupHits.length === 2 && dupHits[0].echoSourceId !== dupHits[1].echoSourceId
    && same(sorted(dupHits.map((h) => h.echoSourceId)), sorted([logRow.echoSourceId, v4Row.echoSourceId])),
    dupHits.map((h) => h.echoSourceId.slice(0, 10)).join(' | ') || 'no dup hits');
  let ambMcp = { ok: false, error: 'not-run' };
  let ambMcpPicked = { ok: false, error: 'not-run' };
  try {
    process.env.AGENT_SOUL_META_DB = AMB_DB;
    ambMcp = await mcpCall(mcp, 'soul_echo_open', { ptr: ambPtr });
    ambMcpPicked = await mcpCall(mcp, 'soul_echo_open', { ptr: ambPtr, echoSourceId: v4Row.echoSourceId });
  } finally {
    process.env.AGENT_SOUL_META_DB = DB;
  }
  t('[F3] MCP 腿同样回 ECHO_PTR_AMBIGUOUS 并列出候选；给 echoSourceId 才打开',
    !!ambMcp.ok && ambMcp.json.ok === false && ambMcp.json.code === 'ECHO_PTR_AMBIGUOUS'
    && (ambMcp.json.candidates || []).length === 2
    && !!ambMcpPicked.ok && ambMcpPicked.json.ok === true && ambMcpPicked.json.word.text === nsCase.expect.v4Text,
    ambMcp.ok ? ambMcp.json.code : ambMcp.error);
  ambStore.close();
  report.namespaceAmbiguity = {
    case: 'two sources forced to the same namespace (log) on a temp COPY of the fixture db',
    ptr: ambPtr,
    ambiguousCode: ambErr ? String(ambErr.code) : null,
    candidates: ambCandidates.map((c) => ({ echoSourceId: c.echoSourceId, sourcePath: c.sourcePath })),
    resolvedBySelector: { log: pickLog.word.text, v4log: pickV4.word.text },
    mismatchCode: mismatchErr ? String(mismatchErr.code) : null,
    duplicatePtrTextHits: dupHits.length,
    mcpCode: ambMcp.ok ? ambMcp.json.code : null,
  };
  console.log('');
  console.log('  同名命名空间歧义（临时库副本，原库未动）：' + ambPtr + ' → ' + report.namespaceAmbiguity.ambiguousCode
    + '，候选 ' + ambCandidates.length + ' 条；selector 精确打开 log/v4log 各一条；错 id → ' + report.namespaceAmbiguity.mismatchCode);

  // ── G. 反证：差分器必须对「改坏的副本」报错（否则它只会一直说 true）────────
  const baseOracle = {
    pointers: ['log:session-a#seq=1', 'log:session-a#seq=2', 'log:session-a#seq=3'],
    limit: 3, returnedCount: 3, matchedTotal: 5, truncated: true, exhausted: false,
  };
  const goodReceipt = { pointers: ['log:session-a#seq=1', 'log:session-a#seq=2', 'log:session-a#seq=3'], count: 3, exhausted: false, skipped: false };
  t('[G] 未改坏的回执 + 同一 oracle → 差分器不报错（对照）', checkReceipt(baseOracle, goodReceipt).length === 0);

  const mutations = [
    { name: 'pointer 顺序对调', make: (r) => { const x = Object.assign({}, r); x.pointers = [r.pointers[1], r.pointers[0], r.pointers[2]]; return x; }, expect: 'pointer-order' },
    { name: '丢掉最后一条', make: (r) => { const x = Object.assign({}, r); x.pointers = r.pointers.slice(0, 2); x.count = 2; return x; }, expect: 'pointer-set' },
    { name: '多塞一条不存在的 pointer', make: (r) => { const x = Object.assign({}, r); x.pointers = r.pointers.concat(['log:session-a#seq=999']); x.count = 4; return x; }, expect: 'pointer-set' },
    { name: '把 count 改小', make: (r) => Object.assign({}, r, { count: 2 }), expect: 'count' },
    { name: '把 exhausted 翻成 true（谎称扫到底）', make: (r) => Object.assign({}, r, { exhausted: true }), expect: 'exhausted' },
    { name: '伪造「未截断」（count=limit 且 exhausted=false 说没有更多）', make: (r) => Object.assign({}, r, { exhausted: true }), oracle: Object.assign({}, baseOracle, { truncated: false }), expect: 'exhausted' },
    { name: '伪造截断（真值未截断却说有更多）', make: (r) => Object.assign({}, r, { exhausted: false }), oracle: Object.assign({}, baseOracle, { truncated: false }), expect: 'truncation' },
    { name: 'bigram 场景下谎报顺序（orderCheck=false 时不该报 pointer-order）', make: (r) => { const x = Object.assign({}, r); x.pointers = [r.pointers[2], r.pointers[0], r.pointers[1]]; return x; }, oracle: baseOracle, expect: 'none', orderCheck: false },
  ];
  for (const mu of mutations) {
    const r = mu.make(goodReceipt);
    const diff = checkReceipt(mu.oracle || baseOracle, r, mu.orderCheck === false ? { orderCheck: false } : undefined);
    if (mu.expect === 'none') {
      t('[G] 变异「' + mu.name + '」在 orderCheck=false 下确实不报（顺序不是被声称的维度）', diff.length === 0, diff.join(',') || 'no diff');
    } else {
      t('[G] 变异「' + mu.name + '」被差分器报出（' + mu.expect + '）',
        diff.indexOf(mu.expect) !== -1 && diff.length > 0, diff.join(',') || 'NO DIFF — 差分器失效');
    }
    report.mismatchDetector.mutations.push({ name: mu.name, expected: mu.expect, detected: diff, caught: mu.expect === 'none' ? diff.length === 0 : diff.indexOf(mu.expect) !== -1 });
  }
  // 真实用例上的反证：把 Q07（辅助负例）的回执塞进一条 pointer，差分器必须报 pointer-set。
  const q07 = SPEC.queries.filter((q) => q.id === 'Q07')[0];
  const q07o = oracleProbe(oracle, q07.probes[0]);
  const q07fake = { pointers: ['log:session-echoq-log#seq=1'], count: 1, exhausted: true, skipped: false };
  const q07diff = checkReceipt(q07o, q07fake);
  t('[G] 负例被伪造命中时差分器报 pointer-set（0 命中不许被塞进一条）', q07diff.indexOf('pointer-set') !== -1, q07diff.join(','));
  // 作用域维度的变异体：差分器必须能认出「命中来自别的来源」和「命中没有来源身份」。
  const scopeMutants = [
    { name: '作用域回执混进另一个来源的命中', hits: [{ echoSourceId: 'echo-aaa' }, { echoSourceId: 'echo-bbb' }], expect: 'source-scope' },
    { name: '命中的 echoSourceId 丢失', hits: [{ echoSourceId: 'echo-aaa' }, {}], expect: 'source-id-missing' },
  ];
  for (const mu of scopeMutants) {
    const diff = checkScope(['echo-aaa'], mu.hits);
    t('[G] 变异「' + mu.name + '」被作用域差分器报出（' + mu.expect + '）',
      diff.indexOf(mu.expect) !== -1, diff.join(',') || 'NO DIFF — 作用域差分器失效');
    report.mismatchDetector.mutations.push({ name: mu.name, expected: mu.expect, detected: diff, caught: diff.indexOf(mu.expect) !== -1 });
  }
  t('[G] 对照：同一来源集合内的命中，作用域差分器不报错', checkScope(['echo-aaa'], [{ echoSourceId: 'echo-aaa' }]).length === 0);

  report.mismatchDetector.negativeFixtureProbe = { q: 'Q07', role: q07.probes[0].role, oraclePointers: q07o.pointers, injected: q07fake.pointers, diff: q07diff };

  // ── H. 作用域 / 只读 / 静态护栏 / 清理 ──────────────────────────────────
  const ownSource = readText(OWN);
  const spawnSites = (ownSource.match(/spawnSync\(/g) || []).length;
  t('[H] 本自检的子进程调用点只有两处，且都是同一个导入器 CLI（基线 fixture 逐源一次 + 时间边界合成语料一次）',
    spawnSites === 2, 'sites=' + spawnSites);

  const lits = quotedLiterals(ownSource);
  t('[H] 源码没有可选执行的字面量：memq / db-sync / migrate-all / start-all / echo-mcp / echo-svc 的 .mjs',
    lits.every((v) => FORBIDDEN_EXES.every((x) => v.indexOf(x) === -1)) && lits.every((v) => ownSource.split(v).length > 0),
    'literals=' + lits.length);
  // 只认「像模块路径」的字面量：长度 > 4、不含空格（排除 '.mjs' 这种切片参数与说明文字）。
  const mjsLits = lits.filter((v) => v.length > 4 && v.indexOf(' ') === -1 && v.slice(-4) === '.mjs')
    .filter((v, i, a) => a.indexOf(v) === i).sort();
  t('[H] 源码里的 .mjs 模块路径字面量全部落在白名单内（导入器 + import 目标 + 自身记录路径）',
    same(mjsLits, ALLOWED_MJS.slice().sort()), mjsLits.join(','));
  t('[H] 源码字面量里没有 live 索引 / 墨 / 生产库 / 生产会话目录的完整串（禁止串由片段拼成，无自证陷阱）',
    lits.every((v) => LIVE_MARKERS.every((mk) => v.indexOf(mk) === -1)), 'markers=' + LIVE_MARKERS.length + ' literals=' + lits.length);
  t('[H] 源码字面量里没有 live 根（' + LIVE_ROOT + '）的任何完整出现',
    lits.every((v) => v.indexOf(LIVE_ROOT) === -1));
  const writeSites = (ownSource.match(/fs\.writeFileSync\(/g) || []).length;
  const rmSites = (ownSource.match(/fs\.rmSync\(/g) || []).length;
  const copySites = (ownSource.match(/fs\.copyFileSync\(/g) || []).length;
  t('[H] 写盘调用点 = 1 处报告 + 1 处合成语料写入器 + 1 处歧义库副本（全部在 os.tmpdir() 之内；无仓库内写入）',
    writeSites === 2 && copySites === 1, 'write=' + writeSites + ' copy=' + copySites);
  t('[H] 只有一处删除调用点（临时目录）', rmSites === 1, 'sites=' + rmSites);
  // 打开的库只允许是临时目录里的那两个（DB / AMB_DB）；别的路径会立刻在这里露出来。
  // ★ 判据串按片段拼，并且排除断言自己的那一行 —— 否则会匹配到这一行的字面量（自证陷阱，实测踩过）。
  const openNeedle = 'openMetaStore({ ' + 'path:';
  const storeOpenSites = ownSource.split('\n').filter((l) => l.indexOf(openNeedle) !== -1 && l.indexOf('openNeedle') === -1);
  t('[H] openMetaStore 的每一处都开在临时目录里的库（DB / AUX_DB / AMB_DB）',
    storeOpenSites.length === 6 && storeOpenSites.every((l) => /path: (DB|AUX_DB|AMB_DB),/.test(l)), storeOpenSites.length + ' sites');

  // 运行时读盘审计：这一次真的读了哪些文件，逐条判定。
  const allowedRead = (p) => p === path.resolve(OWN) || p === path.resolve(SPEC_PATH) || p === path.resolve(BASELINE)
    || inside(FIXTURES, p) || inside(ROOT, p);
  const outside = READS.filter((p) => !allowedRead(p));
  report.readAudit.paths = READS.map((p) => (inside(ROOT, p) ? 'tmp/' + rel(p) : p.split(path.sep).join('/')));
  report.readAudit.allInsideAllowedRoots = outside.length === 0;
  report.readAudit.noLiveMarkers = READS.every((p) => LIVE_MARKERS.every((mk) => p.indexOf(mk) === -1));
  t('[H] 运行时读盘清单全部落在 fixture / 临时目录 / 基线 / 自身之内', outside.length === 0, outside.join(',') || (READS.length + ' 次读取'));
  t('[H] 运行时读到的路径里没有 live 索引 / 墨 / 生产库 / 生产会话目录',
    report.readAudit.noLiveMarkers, READS.filter((p) => LIVE_MARKERS.some((mk) => p.indexOf(mk) !== -1)).join(',') || 'none');
  t('[H] 运行时确实读过基线（只读，用于 SHA 前后比对）', READS.some((p) => p === path.resolve(BASELINE)));
  // 把读盘清单打出来：这是「没有碰生产路径」的可核对证据，不是一句自我声明。
  console.log('');
  console.log('  读盘审计（这一次真的读了这些文件，共 ' + READS.length + ' 次；临时目录记为 tmp/）：');
  console.log('    ' + report.readAudit.paths.join('\n    '));

  const fixtureHashAfter = hashMap(fixtureFileList());
  t('[H] fixture 文件在自检期间一个字节都没变（输入只读）', same(fixtureHashBefore, fixtureHashAfter), Object.keys(fixtureHashAfter).length + ' files');
  t('[H] 导入后没有再写库：读完全部用例后库 SHA 不变', shaOf(DB) === dbHashAfterImport,
    dbHashAfterImport.slice(0, 16) + ' → ' + shaOf(DB).slice(0, 16));
  const statsAfter = store.echoStats();
  // ★ 旧断言写的是 s.srcSeqCount —— echoStats() 里没有这个字段，两边都取到 undefined，
  //   「相等」于是永远成立：一条空转的绿勾（Task-14 顺带修）。真实字段是 declared.srcSeqs。
  const statsProjection = (sources) => sources.map((s) => [s.echoSourceId, s.words, s.summaries, s.declared && s.declared.srcSeqs]);
  t('[H] 读用例没有改变索引结构（sources/words/summaries/declared.srcSeqs 与读前一致）',
    same(statsProjection(statsAfter.sources), statsProjection(storeStatsBefore.sources)));
  t('[H] declared.srcSeqs 是真实字段且为数字（不是 undefined 的空比较）',
    statsAfter.sources.length > 0 && statsAfter.sources.every((s) => s.declared && typeof s.declared.srcSeqs === 'number' && Number.isFinite(s.declared.srcSeqs)),
    JSON.stringify(statsAfter.sources.map((s) => s.declared && s.declared.srcSeqs)));
  const baselineHashAfter = shaOf(BASELINE);
  t('[H] 基线文件 SHA 前后相同（没有改基线）', baselineHashAfter === baselineHashBefore,
    baselineHashBefore.slice(0, 16) + ' → ' + baselineHashAfter.slice(0, 16));
  report.baseline.unchanged = baselineHashAfter === baselineHashBefore;

  // 报告（临时）—— 内容不含时间戳，因此同一输入下逐字节确定。
  report.summary = {
    coveredFixture: covered.length,
    notCovered: notCovered.length,
    coveredIds: covered.map((q) => q.id),
    notCoveredIds: notCovered.map((q) => q.id),
    coverageProbes: coverageProbes.length,
    auxiliaryProbes: auxiliaryProbes.length,
    pointerCases: report.pointerCases.length,
    assertionsPassed: ok.length,
    assertionsFailed: bad.length,
    sourceScopeCases: report.sourceScope ? report.sourceScope.cases.length : 0,
    sourceScopeUnion: report.sourceScope ? report.sourceScope.unionEqualsUnrestricted : null,
    absentSourceGuarded: report.sourceScope && report.sourceScope.absent ? report.sourceScope.absent.storeCode === 'ECHO_SOURCE_NOT_FOUND' : null,
    sameNamespaceAmbiguity: report.namespaceAmbiguity ? report.namespaceAmbiguity.ambiguousCode : null,
    timeBoundaryProbes: report.timeBoundary ? report.timeBoundary.probes.length : 0,
    timeBoundaryBoundaryFacts: report.timeBoundary ? report.timeBoundary.boundaryFacts.length : 0,
    timeBoundaryHelperLeg: report.timeBoundary ? report.timeBoundary.helperLeg : null,
    timeBoundaryEstablishes: report.timeBoundary ? report.timeBoundary.establishes : null,
    timeBoundaryDoesNotEstablish: report.timeBoundary ? report.timeBoundary.doesNotEstablish : null,
    q06StillNotCovered: report.timeBoundary ? report.timeBoundary.q06StillNotCovered : null,
    liveEvidenceReproduced: false,
  };
  reportBytes = Buffer.from(JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(REPORT, reportBytes);
  t('[H] 临时报告写在 os.tmpdir() 下（不是仓库里）', REPORT.indexOf(TMP_BASE) === 0 && fs.existsSync(REPORT), rel(REPORT));
} catch (e) {
  t('自检本身没有抛异常', false, e && e.stack ? e.stack.split('\n').slice(0, 6).join(' | ') : String(e));
} finally {
  try { if (store) store.close(); } catch (_) { /* 关闭失败不掩盖结果 */ }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) { /* 保留现场以便排查 */ }
  report.cleanup.removed = !fs.existsSync(ROOT);
  t('[H] 临时目录（库 + 报告）已删除', report.cleanup.removed, ROOT);
  // ★ 只对本进程的目录下断言：并发的同名运行各有自己的 mkdtemp 目录，
  //   拿「全局前缀为空」当判据会把别人的目录算成本进程残留（实测撞过一次）。
  const concurrentSamePrefix = fs.readdirSync(TMP_BASE).filter((n) => n.indexOf('echo-fixed-query-parity-') === 0);
  t('[H] 清理后本进程的临时目录不在了（同前缀的目录只可能来自并发的另一次运行）',
    !fs.existsSync(ROOT), 'ROOT exists=' + fs.existsSync(ROOT) + '，同前缀目录数=' + concurrentSamePrefix.length);
}

console.log('');
console.log('=== ECHO 固定查询集 Q01–Q12 覆盖矩阵 + 差分自检（fixture-only · 临时库）===');
console.log('  三条腿 = Store(echoSearch) / MCP(soul_echo_search) / importer helper(searchEchoWords·searchEchoSummaries)');
console.log('  ★ 不是 live memq CLI；live 索引、墨、生产库、live 服务一次都没跑。');
console.log('');
console.log(ok.join('\n'));
if (bad.length) { console.log(''); console.log(bad.join('\n')); }
console.log('');
console.log('── 逐 Q 结论（孤立截取也不该被读成 live 等价）────────────────────────────');
console.log(JSON.stringify(report.matrix.map((m) => ({
  id: m.id, coverage: m.coverage, coveredLeg: m.coveredLeg ? m.coveredLeg.surface + '@limit=' + m.coveredLeg.limit : null,
  legs: m.legs, why: m.why, gaps: (m.gaps || []).map((g) => g.kind), notReproduced: m.notReproduced,
})), null, 1));
console.log('');
console.log('  COVERED_FIXTURE = ' + (report.summary.coveredFixture || 0) + '（Q04/Q05，各只覆盖 summaries 面 @ 基线 limit=3）');
console.log('  NOT_COVERED     = ' + (report.summary.notCovered || 0) + '（Q01/Q02/Q03/Q06/Q07/Q08/Q09/Q10/Q11/Q12）');
console.log('  来源作用域(F2)  = ' + (report.summary.sourceScopeCases || 0) + ' 条源各自收窄 + 并集=全库；缺席 echoSourceId → Store/MCP/importer helper 均报 ECHO_SOURCE_NOT_FOUND。');
console.log('  同名命名空间(F3)= ' + String(report.summary.sameNamespaceAmbiguity) + '（临时库副本上两源同名 log；候选 2 条；selector 精确打开；错 id → ECHO_PTR_SOURCE_MISMATCH）');
console.log('  时间边界(E2)    = ' + (report.summary.timeBoundaryProbes || 0) + ' 条 AUXILIARY_FIXTURE（临时合成语料，不是 fixture 文件）：'
  + '显式 +08:00 偏移量的 t==since / t==until 含入、两端各差 1 秒排除、only-since / only-until 行为；'
  + 'Store/MCP 与独立 oracle 逐维一致；helper 腿 NOT_COVERED_NO_DATE_FILTER（它没有时间过滤）。');
console.log('  live 命中数 / live 首指针 / 墨腿 / src=索引 的 words 腿 / 语义召回：一律未复现，不计入覆盖。');
console.log('');
console.log(ok.length + ' 通过 / ' + bad.length + ' 失败');
if (reportBytes) console.log('报告（临时，已删除）字节数=' + reportBytes.length + ' sha256=' + createHash('sha256').update(reportBytes).digest('hex'));
console.log('临时目录已清理: ' + report.cleanup.removed);

process.exitCode = bad.length === 0 ? 0 : 1;
