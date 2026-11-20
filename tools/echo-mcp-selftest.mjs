#!/usr/bin/env node
// tools/echo-mcp-selftest.mjs —— v9 ECHO 只读工具面（Store + MCP）自检 · TEMP ONLY
// ============================================================================
// 它钉住的是**接口契约**，不是「大概能跑」：
//
//   A 登记：三个工具在 TOOLS 里、write-manifest 逐条判 read、TOOLS ↔ manifest 逐名相同
//   B 检索语义：结果集合 == 对源 JSONL 的**独立暴力枚举**（不经 FTS、不经导入器函数）
//        · 非 CJK 子串（8f3a → 8f3a2c）、大小写不敏感、截断行可搜、推理行不可搜
//        · bigram 超集 + 逐条子串核实：'六层解耦' 有候选、0 命中（证明假阳性被拦下）
//   C summaries 面同样是子串语义
//   D 过滤：来源（id）/ 时间窗（since/until，含**闭区间**边界）/ 非法输入
//   E cap 与 exhaustion：limit 夹取、取够即停（exhausted=false = 未证明完整）
//   F 门牌：单条解析 / 多条 = AMBIGUOUS（候选路径、顺序稳定、无优先）/ 四种坏形状
//   G idx: 只开 L4 摘要：srcSeqs 按源顺序且**保留重复**；无帧正文（opensFrame:false）
//   K 来源选择器（echoSourceId）：多候选可指定、只能在候选里挑（错的 id = MISMATCH）、
//     且「搜索命中自带 echoSourceId → echoOpen 往返」真的落到那一条；不传时旧行为逐字不变
//   H 缺表 / 索引陈旧：显式失败，绝不回「看着正常」的半份结果
//   I v4log 与 log 互不冒充（同名 sid+seq 是两条流，不是重复）
//   J 只读零副作用：库字节哈希不变、目录不新增文件、MCP 腿不建 sessions 目录
//
// ★ 全程只碰临时目录：源 = tools/fixtures/echo-index-import/（合成语料）；
//   库 = os.tmpdir() 下每个用例新建的 meta.sqlite。不碰 data/、不碰任何生产库。
// ★ 跑法：node tools/echo-mcp-selftest.mjs   （退出码 0 = 全绿）
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openMetaStore, migrate, MIGRATIONS, SCHEMA_VERSION } from '../src/db/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures', 'echo-index-import');
const IMPORTER = path.join(HERE, 'echo-index-import.mjs');
const NODE = process.execPath;
const FIX_NAMES = ['corpus', 'v3-index', 'v4-index', 'log-mirror'];
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-mcp-selftest-'));

const ok = [];
const bad = [];
function t(name, cond, detail) {
  (cond ? ok : bad).push((cond ? '✓ ' : '✗ ') + name + (detail === undefined || detail === null ? '' : '  → ' + String(detail)));
  return cond;
}
const shaOf = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (a) => a.slice().sort();

// ── 独立 oracle：直接读源 JSONL，不经 FTS、不经 DB、不经导入器函数 ─────────
function readFixture(name, file) {
  const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURES, name, 'manifest.json'), 'utf8'));
  const rows = fs.readFileSync(path.join(FIXTURES, name, file), 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
  return { manifest, rows };
}
const isReasoning = (r) => ['reasoning', 'thinking'].indexOf(String(r.role)) !== -1 || ['reasoning', 'thinking'].indexOf(String(r.kind)) !== -1;

function oracleWords() {
  const out = [];
  for (const n of FIX_NAMES) {
    const { manifest, rows } = readFixture(n, 'words.jsonl');
    for (const w of rows) {
      if (isReasoning(w)) continue;
      out.push({ sourcePath: manifest.sourcePath, namespace: manifest.namespace, session: w.session, seq: w.seq, t: w.t, text: w.text });
    }
  }
  return out;
}
function oracleSummaries() {
  const out = [];
  for (const n of FIX_NAMES) {
    const { manifest, rows } = readFixture(n, 'summaries.jsonl');
    for (const s of rows) {
      out.push({ sourcePath: manifest.sourcePath, session: s.session, cmpId: s.cmpId, t: s.t, text: s.summary, srcSeqs: s.srcSeqs, status: s.status });
    }
  }
  return out;
}
function oracleFilter(rows, opts) {
  const o = opts || {};
  const needle = String(o.q).trim().toLowerCase();
  const since = o.since ? Date.parse(o.since) : null;
  const until = o.until ? Date.parse(o.until) : null;
  return rows.filter((r) => {
    if (o.sourcePath && r.sourcePath !== o.sourcePath) return false;
    if (since !== null && Date.parse(r.t) < since) return false;
    if (until !== null && Date.parse(r.t) > until) return false;
    return String(r.text).toLowerCase().indexOf(needle) !== -1;
  });
}

// ── 库准备 ────────────────────────────────────────────────────────────────
function makeDb(name, version) {
  const dir = path.join(ROOT, 'db-' + name);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'meta.sqlite');
  const store = openMetaStore({ path: dbPath, mode: 'readwrite' });
  try {
    if (version === undefined || version === SCHEMA_VERSION) store.migrate();
    else { migrate(store.db, { migrations: MIGRATIONS.slice(0, version), targetVersion: version }); store.refreshState(); }
  } finally { store.close(); }
  return dbPath;
}

function importFixture(dbPath, name) {
  const manifest = path.join(FIXTURES, name, 'manifest.json');
  const r = spawnSync(NODE, [IMPORTER, '--manifest', manifest, '--sha256', shaOf(manifest), '--generation', '1', '--db', dbPath, '--json'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('import ' + name + ' failed: ' + String(r.stdout || '').slice(-400) + String(r.stderr || '').slice(-400));
  return r;
}

function dirSnapshot(dir) {
  return fs.readdirSync(dir).sort().map((n) => n + ':' + fs.statSync(path.join(dir, n)).size);
}

function throwsCode(fn) {
  try { fn(); return null; } catch (e) { return { code: (e && e.code) || null, details: (e && e.details) || null, message: String((e && e.message) || e) }; }
}

// ── 主流程 ────────────────────────────────────────────────────────────────
async function main() {
  // ★ MCP 腿与 Store 腿读同一个库：AGENT_SOUL_META_DB 是给自检的显式覆盖（不来自 MCP 参数）。
  process.env.AGENT_SOUL_META_DB = path.join(ROOT, 'not-yet.sqlite');
  process.env.AGENT_SOUL_READONLY = '1';   // 只读模式：写面一律拒，读面照常
  delete process.env.AGENT_SOUL_DATA;

  const dbPath = makeDb('main');
  for (const n of FIX_NAMES) importFixture(dbPath, n);
  process.env.AGENT_SOUL_META_DB = dbPath;

  const words = oracleWords();
  const summaries = oracleSummaries();
  const paths = new Map();   // echoSourceId -> sourcePath（由 stats 提供，不猜）
  const ro = openMetaStore({ path: dbPath, mode: 'readonly' });
  for (const s of ro.echoStats().sources || []) paths.set(s.echoSourceId, s.sourcePath);
  const pathOf = (hit) => paths.get(hit.echoSourceId) || ('??' + hit.echoSourceId);

  const wordKeys = (res) => sorted(res.filter((h) => h.surface === 'words').map((h) => pathOf(h) + '|' + h.session + '|' + h.seq));
  const summaryKeys = (res) => sorted(res.filter((h) => h.surface === 'summaries').map((h) => pathOf(h) + '|' + h.cmpId));
  const oracleWordKeys = (rows) => sorted(rows.map((r) => r.sourcePath + '|' + r.session + '|' + r.seq));
  const oracleSummaryKeys = (rows) => sorted(rows.map((r) => r.sourcePath + '|' + r.cmpId));

  // ── A 登记与分类 ───────────────────────────────────────────────────────
  {
    // 同步拿 MCP 面（import 会读环境；上面已经设好）
    const mcp = await import('../src/adapters/mcp-tools.mjs');
    const manifestMod = await import('../src/security/write-manifest.mjs');
    globalThis.__mcp = mcp;
    globalThis.__manifest = manifestMod;
    const names = ['soul_echo_search', 'soul_echo_open', 'soul_echo_stats', 'soul_echo_semantic_search'];
    for (const n of names) {
      t('[A] TOOLS 里有 ' + n, mcp.TOOLS.some((x) => x.name === n));
      const c = manifestMod.classifyMcpCall(n, {});
      t('[A] ' + n + ' 判 read（write=false）', c.write === false && c.verdict === 'read', JSON.stringify(c));
      // ★ 身份不参与：给了 sessionId/by/action 也不该把它变成写面。
      const c2 = manifestMod.classifyMcpCall(n, { action: 'write', by: 'someone', sessionId: 'session-x', type: 'fact', text: 'x' });
      t('[A] ' + n + ' 带 action/by/sessionId 仍是 read', c2.write === false, JSON.stringify(c2));
    }
    const toolNames = sorted(mcp.TOOLS.map((x) => x.name));
    const manNames = sorted(manifestMod.MCP_TOOL_NAMES);
    t('[A] TOOLS ↔ manifest 逐名相同（' + toolNames.length + ' 个）', same(toolNames, manNames),
      toolNames.filter((n) => manNames.indexOf(n) === -1).concat(manNames.filter((n) => toolNames.indexOf(n) === -1)).join(','));
    const schema = (n) => (mcp.TOOLS.find((x) => x.name === n) || {}).inputSchema || {};
    t('[A] 三个工具的入参形状', (schema('soul_echo_search').required || []).indexOf('query') !== -1
      && (schema('soul_echo_open').required || []).indexOf('ptr') !== -1
      && !(schema('soul_echo_stats').required || []).length,
      JSON.stringify({ s: schema('soul_echo_search').required, o: schema('soul_echo_open').required }));
    // ★ 不许有「写」的口子：schema 里不出现 session/by 这类身份参数
    const props = Object.keys(schema('soul_echo_search').properties || {});
    t('[A] search 入参不含身份字段', props.indexOf('by') === -1 && props.indexOf('sessionId') === -1 && props.indexOf('session') === -1, props.join(','));
    t('[A] search exposes boolean includeNonDialogue opt-in', schema('soul_echo_search').properties.includeNonDialogue.type === 'boolean' && !schema('soul_echo_search').required.includes('includeNonDialogue'), JSON.stringify(schema('soul_echo_search').properties.includeNonDialogue));
    const semSchema = schema('soul_echo_semantic_search');
    t('[A] semantic input requires query and explicit source', same(sorted(semSchema.required || []), ['echoSourceId', 'query']) && !!semSchema.properties.limit, JSON.stringify(semSchema));
    const cSemantic = manifestMod.classifyMcpCall('soul_echo_semantic_search', { query:'x', echoSourceId:'echo-abc', action:'write' });
    t('[A] semantic search is explicitly read-only', cSemantic.write === false && cSemantic.verdict === 'read', JSON.stringify(cSemantic));
    // ★ echoSourceId 是**选择器**，不是身份也不是写入口：带它仍然判 read（写面不许借这个参数长出来）。
    const cSel = manifestMod.classifyMcpCall('soul_echo_open', { ptr: 'log:x#seq=1', echoSourceId: 'echo-abc' });
    t('[A] soul_echo_open 带 echoSourceId 仍是 read（选择器不是写口子）', cSel.write === false && cSel.verdict === 'read', JSON.stringify(cSel));
    const semanticHelper = mcp.runEchoSemanticSearch;
    const fingerprint={modelId:'BAAI/bge-small-zh-v1.5',modelRevision:'local-bundled-unpinned',modelSha256:'15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc',tokenizerSha256:'48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26',configSha256:'d4193ead3a810fd694fa8a31d7fc72fbaebc0668b603e398734bf2f6538ff42f',dimension:512,dtype:'q8',pooling:'mean',normalized:true,queryPrefix:'为这个句子生成表示以用于检索相关文章：',documentPrefix:'',maxInputChars:1000,truncation:'slice-code-units-before-tokenization'};
    let requestedModelSpec=null;
    // ★★ 2026-11-18 04:03 修：这个替身原来只实现了 .get()，而 findEchoVectorModel
//   现在用 .all()（它要按 created_at DESC 拿候选列表再在 JS 侧筛 spec）——
//   于是整个套件在 [A] 就崩在「db.prepare(...).all is not a function」，后面的断言一条都没跑。
//   ★ 要点：**早在今晚的改动之前它就已经是红的**（换回改动前的 mcp-tools 照样崩在同一行）。
//     一个永远红的自检等于没有自检 —— 它不报警，只是让人习惯性忽略红。
//   ★ 另一处跟着错实现走的地方：model 原来返回 {model_key}，而 helper 读的是驼峰 modelKey
//     （同一个 bug 的测试镜像：测试把 bug 固化成了「期望」）。一并改成 modelKey。
    const makeSemanticStore=(model)=>({db:{prepare:()=>({get:(...params)=>{requestedModelSpec=params;return model;},all:(...params)=>{requestedModelSpec=params;return model?[model]:[];}})},echoVectorSearch:(_v,o)=>({results:[{ptr:'log:semantic-fixture#seq=9',echoSourceId:o.echoSourceId,score:0.875}]})});
    const fakeEmbedder={fingerprint,embedQueries:async()=>[{vector:new Float32Array(512)}]};
    const missingSemantic=await semanticHelper(makeSemanticStore(null),{query:'meaning',echoSourceId:'echo-fixture'},fakeEmbedder).then(()=>null,e=>e);
    t('[A] semantic helper fails closed when pinned vectors are unavailable',missingSemantic&&missingSemantic.code==='MODEL_UNAVAILABLE');
    const semanticResult=await semanticHelper(makeSemanticStore({modelKey:'test-model-key',model_key:'test-model-key',preprocess_spec:JSON.stringify({queryPrefix:fingerprint.queryPrefix,documentPrefix:fingerprint.documentPrefix,maxInputChars:fingerprint.maxInputChars,truncation:fingerprint.truncation}),created_at:'2026-11-18'}),{query:'meaning',echoSourceId:'echo-fixture',limit:4},fakeEmbedder);
    t('[A] semantic helper returns pointers/scores only and never calls lexical search',semanticResult.ok===true&&semanticResult.results.length===1&&same(Object.keys(semanticResult.results[0]).sort(),['echoSourceId','ptr','score'])&&semanticResult.results[0].score===0.875&&requestedModelSpec[3]===JSON.stringify({sha256:fingerprint.tokenizerSha256,configSha256:fingerprint.configSha256}));
    const ledgerName = 'soul_ledger';
    const ledgerSchema = schema(ledgerName);
    const ledgerProps = Object.keys(ledgerSchema.properties || {}).sort();
    for (const [label, args] of [['default', {}], ['list', { action: 'list' }], ['stats', { action: 'stats' }]]) {
      const cLedger = manifestMod.classifyMcpCall(ledgerName, args);
      t('[A] soul_ledger ' + label + ' is read', cLedger.write === false && cLedger.verdict === 'read', JSON.stringify(cLedger));
    }
    t('[A] soul_ledger schema keeps list filtering, limit, and explicit write enum only',
      same(ledgerProps, ['action', 'limit', 'type']) && (ledgerSchema.properties.action.enum || []).includes('write'), JSON.stringify(ledgerSchema));
    const ledgerReject = JSON.parse(await mcp.callTool(ledgerName, { action: 'write', type: 'fact', text: 'must-not-write', by: 'spoof' }, {}));
    t('[A] soul_ledger write remains handler-rejected after manifest read classification',
      ledgerReject.status === 'rejected' && ledgerReject.code === 'LEDGER_AUTH_REQUIRED' && ledgerReject.action === 'write', JSON.stringify(ledgerReject));
  }

  // ── B 检索语义（words 面）───────────────────────────────────────────────
  {
    const got = ro.echoSearch('解耦', { surface: 'words', limit: 500 });
    t('[B] 普通查询「解耦」结果集合 == 源 JSONL 暴力枚举', same(wordKeys(got.results), oracleWordKeys(oracleFilter(words, { q: '解耦' }))),
      wordKeys(got.results).join(' , ') + ' vs ' + oracleWordKeys(oracleFilter(words, { q: '解耦' })).join(' , '));
    t('[B] 取够上限以外还扫到底 → exhausted=true', got.exhausted === true, 'candidates=' + got.candidates);

    const substr = ro.echoSearch('8f3a', { surface: 'words' });
    t('[B] 非 CJK 子串：8f3a 命中 8f3a2c 那一行（整词 FTS 不是超集 → 走原文扫描）',
      same(substr.results.map((h) => h.session + '#' + h.seq), ['session-aaaa1111#3', 'session-bbbb2222#1']),
      JSON.stringify(substr.results.map((h) => h.ptr)) + ' scanPath=' + substr.scanPath);
    t('[B] 该查询走的是 raw-scan（不是 bigram-fts）', substr.scanPath === 'raw-scan', substr.scanPath);

    const fake = ro.echoSearch('六层解耦', { surface: 'words' });
    t('[B] bigram 超集里的跨位置假阳性被逐条子串核实拦下（候选>0、命中 0）',
      fake.candidates > 0 && fake.results.length === 0, 'candidates=' + fake.candidates + ' hits=' + fake.results.length);
    t('[B] 同一查询 exhausted=true（真的扫到底了，不是「没搜」）', fake.exhausted === true);

    const ci = ro.echoSearch('MAKESTREAM', { surface: 'words' });
    t('[B] 大小写不敏感（MAKESTREAM 命中 makeStreamFingerprint）',
      same(ci.results.map((h) => h.session + '#' + h.seq), ['session-aaaa1111#3', 'session-cccc3333#1']), JSON.stringify(ci.results.map((h) => h.ptr)));

    const trunc = ro.echoSearch('TRUNCATED-CANARY', { surface: 'words', includeNonDialogue: true });
    t('[B] 截断行仍可检索（len=4096 / truncated=true 原样保留）',
      trunc.results.length === 1 && trunc.results[0].truncated === true, JSON.stringify(trunc.results.map((h) => h.ptr)));

    const reasoning = ro.echoSearch('REASONING-CANARY', { surface: 'words' });
    t('[B] 推理行不进索引 → 0 命中', reasoning.results.length === 0 && reasoning.exhausted === true, 'hits=' + reasoning.results.length);
  }

  // ── C summaries 面 ──────────────────────────────────────────────────────
  {
    const got = ro.echoSearch('摘要', { surface: 'summaries', limit: 500 });
    t('[C] summaries 面同样是子串语义，集合 == 暴力枚举',
      same(summaryKeys(got.results), oracleSummaryKeys(oracleFilter(summaries, { q: '摘要' }))),
      summaryKeys(got.results).join(' , '));
    t('[C] summaries 面的命中是 idx: 门牌', got.results.every((h) => h.ptr.indexOf('idx:') === 0), JSON.stringify(got.results.map((h) => h.ptr)));
    const voided = got.results.filter((h) => h.status === 'void');
    t('[C] 被吊销（void）的摘要仍在索引里、可被搜到（吊销是追加不是删）', voided.length === 1, 'void=' + voided.length);
  }

  // ── D 过滤 ──────────────────────────────────────────────────────────────
  {
    const corpus = (ro.echoStats().sources || []).find((s) => s.sourcePath === 'D:/synthetic/echo/corpus/index');
    const got = ro.echoSearch('解耦', { surface: 'words', echoSourceId: corpus.echoSourceId, limit: 500 });
    t('[D] echoSourceId 把结果收窄到那一个来源',
      got.results.every((h) => h.echoSourceId === corpus.echoSourceId) && got.results.length === 3,
      got.results.map((h) => h.ptr).join(','));
    const bad = throwsCode(() => ro.echoSearch('解耦', { surface: 'words', echoSourceId: 'echo-does-not-exist' }));
    t('[D] 不存在的来源 → ECHO_SOURCE_NOT_FOUND（不是静默空）', bad && bad.code === 'ECHO_SOURCE_NOT_FOUND', bad && bad.code);

    const s0 = ro.echoSearch('解耦', { surface: 'words', since: '2026-11-02T00:00:00.000Z' });
    t('[D] since 把 11-01 的 words 全部挡在外面', s0.results.length === 0 && s0.exhausted === true, 'hits=' + s0.results.length);
    const s1 = ro.echoSearch('摘要', { surface: 'summaries', since: '2026-11-02T12:00:00.000Z' });
    t('[D] since 对 summaries 生效（11-03 那条留下）', same(summaryKeys(s1.results), ['D:/synthetic/echo/corpus/index|cmp-0002']), summaryKeys(s1.results).join(','));
    const s2 = ro.echoSearch('摘要', { surface: 'summaries', until: '2026-11-02T00:00:00.000Z' });
    t('[D] until 是闭区间（t == until 的那行包含）',
      summaryKeys(s2.results).indexOf('D:/synthetic/echo/corpus/index|cmp-0001') !== -1
      && summaryKeys(s2.results).indexOf('D:/synthetic/echo/corpus/index|cmp-0002') === -1,
      summaryKeys(s2.results).join(','));
    const d1 = throwsCode(() => ro.echoSearch('x', { since: '2026-11-03T00:00:00.000Z', until: '2026-11-01T00:00:00.000Z' }));
    t('[D] since > until → INVALID_INPUT（不当成「0 条」）', d1 && d1.code === 'INVALID_INPUT', d1 && d1.code);
    const d2 = throwsCode(() => ro.echoSearch('x', { since: 'not-a-date' }));
    t('[D] 不可解析的时间 → INVALID_INPUT', d2 && d2.code === 'INVALID_INPUT', d2 && d2.code);
    const d3 = throwsCode(() => ro.echoSearch('x', { surface: 'frames' }));
    t('[D] 非法 surface → INVALID_INPUT', d3 && d3.code === 'INVALID_INPUT', d3 && d3.code);
  }

  // ── E cap / exhaustion ──────────────────────────────────────────────────
  {
    const one = ro.echoSearch('解耦', { surface: 'words', limit: 1 });
    t('[E] limit=1 → 只回 1 条', one.results.length === 1, 'n=' + one.results.length);
    t('[E] limit=1 时 exhausted=false（未证明完整，不是「只有一条」）', one.exhausted === false);
    const all = ro.echoSearch('解耦', { surface: 'words', limit: 500 });
    t('[E] limit ≥ 真命中数 → exhausted=true 且条数 == 枚举数',
      all.exhausted === true && all.results.length === oracleFilter(words, { q: '解耦' }).length,
      all.results.length + ' vs ' + oracleFilter(words, { q: '解耦' }).length);
    const zero = ro.echoSearch('解耦', { surface: 'words', limit: 0 });
    t('[E] limit=0 夹到 1（不是 0 条，也不是不限）', zero.filters.limitPerSurface === 1, 'limitPerSurface=' + zero.filters.limitPerSurface);
    const huge = ro.echoSearch('解耦', { surface: 'words', limit: 99999 });
    t('[E] limit 上限 500', huge.filters.limitPerSurface === 500, 'limitPerSurface=' + huge.filters.limitPerSurface);
    const emptyQ = ro.echoSearch('   ', {});
    t('[E] 空查询：0 条 + exhausted=true（诚实：真的没有更多）', emptyQ.results.length === 0 && emptyQ.exhausted === true);
  }

  // ── F 门牌 ──────────────────────────────────────────────────────────────
  {
    const amb = throwsCode(() => ro.echoOpen('log:session-shared-0001#seq=12'));
    t('[F] 同一 sid+seq 命中两个 log 来源 → ECHO_PTR_AMBIGUOUS', amb && amb.code === 'ECHO_PTR_AMBIGUOUS', amb && amb.code);
    const c1 = (amb && amb.details && amb.details.candidates) || [];
    t('[F] 候选是两条显式路径（v3 + log-mirror），v4 不在里面',
      same(sorted(c1.map((c) => c.sourcePath)), ['D:/synthetic/echo/log-mirror/index', 'D:/synthetic/echo/v3/index']),
      JSON.stringify(c1.map((c) => c.sourcePath)));
    const amb2 = throwsCode(() => ro.echoOpen('log:session-shared-0001#seq=12'));
    t('[F] 候选顺序稳定（两次逐字相同，不按时间/插入顺序摇）',
      JSON.stringify(c1) === JSON.stringify((amb2.details || {}).candidates));
    t('[F] 候选里没有「推荐/第一个」这种暗示字段', c1.every((c) => Object.keys(c).indexOf('preferred') === -1 && Object.keys(c).indexOf('picked') === -1));

    const v4 = ro.echoOpen('v4log:session-shared-0001#seq=12');
    t('[F] v4log: 单条解析，落到 v4 路径', v4.source.sourcePath === 'D:/synthetic/echo/v4/index' && v4.word.text === 'V4 流里的第十二帧', v4.source.sourcePath);
    const single = ro.echoOpen('log:session-aaaa1111#seq=1');
    t('[F] log: 单条解析，正文与源一致', single.word.text === '解耦机制记在六层解码之后' && single.namespace === 'log', single.word.text);

    const nf = throwsCode(() => ro.echoOpen('log:session-aaaa1111#seq=999'));
    t('[F] 不存在的门牌 → ECHO_PTR_NOT_FOUND', nf && nf.code === 'ECHO_PTR_NOT_FOUND', nf && nf.code);
    const z = throwsCode(() => ro.echoOpen('log:session-aaaa1111#seq=01'));
    t('[F] 前导零 → ECHO_PTR_MALFORMED（不当成 seq=1）', z && z.code === 'ECHO_PTR_MALFORMED', z && z.code);
    const ext = throwsCode(() => ro.echoOpen('log:session-aaaa1111#seq=1@stream16'));
    t('[F] @stream16 之类扩展语法完全没有实现 → ECHO_PTR_MALFORMED', ext && ext.code === 'ECHO_PTR_MALFORMED', ext && ext.code);
    const ns = throwsCode(() => ro.echoOpen('http:session-aaaa1111#seq=1'));
    t('[F] 未知命名空间 → ECHO_PTR_UNKNOWN_NAMESPACE', ns && ns.code === 'ECHO_PTR_UNKNOWN_NAMESPACE', ns && ns.code);
    const idxBad = throwsCode(() => ro.echoOpen('idx:cmp-0001/../../x'));
    t('[F] idx: 只认单个 cmp id → ECHO_PTR_MALFORMED', idxBad && idxBad.code === 'ECHO_PTR_MALFORMED', idxBad && idxBad.code);
  }

  // ── G idx: 只开 L4 摘要 ─────────────────────────────────────────────────
  {
    const r = ro.echoOpen('idx:cmp-0001');
    t('[G] srcSeqs 严格按源顺序、重复保留（[7,3,3,11]）', same(r.srcSeqs, [7, 3, 3, 11]), JSON.stringify(r.srcSeqs));
    t('[G] opensFrame=false（摘要打不开帧）', r.opensFrame === false);
    t('[G] 返回里没有帧正文字段', r.word === undefined && r.rawText === undefined && r.frames === undefined, Object.keys(r).join(','));
    // ★ 摘要正文本来就可能提到 words 的措辞，所以这里判**结构**：srcSeqs 只有数字，没有一帧的字段。
    t('[G] srcSeqs 只有数字（不是展开后的 words 行）', Array.isArray(r.srcSeqs) && r.srcSeqs.every((n) => typeof n === 'number'), JSON.stringify(r.srcSeqs));
    t('[G] summary 只是一段文字（不是 words 子对象）', typeof r.summary.summary === 'string' && r.summary.fullJson !== undefined);
    const voided = ro.echoOpen('idx:cmp-0002');
    t('[G] status=void 的摘要仍能打开（吊销是追加不删）', voided.summary.status === 'void', voided.summary.status);
    const nf = throwsCode(() => ro.echoOpen('idx:cmp-nope'));
    t('[G] 不存在的 cmp id → ECHO_PTR_NOT_FOUND', nf && nf.code === 'ECHO_PTR_NOT_FOUND', nf && nf.code);
  }

  // ── K 来源选择器：歧义之后可以指定，但只能在候选里挑 ────────────────────
  // ★ 修的是这个具体场景：搜索命中回 log:session-shared-0001#seq=12 与它的 echoSourceId，
  //   但打开时要跨过 AMBIGUOUS 才能拿到**那一条**。选择器不是「替他猜」，是把已经知道的事说清楚。
  {
    const srcByPath = (p) => (ro.echoStats().sources || []).find((s) => s.sourcePath === p);
    const v3 = srcByPath('D:/synthetic/echo/v3/index');
    const mirror = srcByPath('D:/synthetic/echo/log-mirror/index');
    const v4 = srcByPath('D:/synthetic/echo/v4/index');
    const WPTR = 'log:session-shared-0001#seq=12';
    const IPTR = 'idx:cmp-shared-0001';
    const codeOf = (fn) => (throwsCode(fn) || {}).code;
    const idsOf = (e) => ((e && e.details && e.details.candidateIds) || []).slice();

    // ① 省略 / 空 / null：旧行为逐字保留（多候选仍 AMBIGUOUS）
    t('[K] 省略 echoSourceId：word 多候选仍 ECHO_PTR_AMBIGUOUS', codeOf(() => ro.echoOpen(WPTR)) === 'ECHO_PTR_AMBIGUOUS', codeOf(() => ro.echoOpen(WPTR)));
    t('[K] 省略 echoSourceId：idx 多候选仍 ECHO_PTR_AMBIGUOUS', codeOf(() => ro.echoOpen(IPTR)) === 'ECHO_PTR_AMBIGUOUS', codeOf(() => ro.echoOpen(IPTR)));
    t('[K] 空串 / null 等同于「没给」（不变成「找不到来源」）',
      codeOf(() => ro.echoOpen(WPTR, { echoSourceId: '' })) === 'ECHO_PTR_AMBIGUOUS'
      && codeOf(() => ro.echoOpen(WPTR, { echoSourceId: null })) === 'ECHO_PTR_AMBIGUOUS');

    // ② word 多来源：每个候选都能打开**它自己那一条**
    const w3 = ro.echoOpen(WPTR, { echoSourceId: v3.echoSourceId });
    const wm = ro.echoOpen(WPTR, { echoSourceId: mirror.echoSourceId });
    t('[K] word：给 v3 的 id → 打开 v3 的正文', w3.source.echoSourceId === v3.echoSourceId && w3.word.text === 'V3 流里的第十二帧', w3.word.text);
    t('[K] word：给 mirror 的 id → 打开 mirror 的正文', wm.source.echoSourceId === mirror.echoSourceId && wm.word.text === '镜像流里的第十二帧', wm.word.text);
    t('[K] 两条确实不是同一条（选择器真分开了，不是都回第一条）', w3.word.text !== wm.word.text && w3.word.contentHash !== wm.word.contentHash);
    t('[K] 指针文本原样保留（不给选择器加任何后缀/改写）', w3.ptr === WPTR && wm.ptr === WPTR && w3.kind === 'word' && w3.namespace === 'log');

    // ③ idx 多来源：同理，各自打开自己的摘要
    const i3 = ro.echoOpen(IPTR, { echoSourceId: v3.echoSourceId });
    const im = ro.echoOpen(IPTR, { echoSourceId: mirror.echoSourceId });
    t('[K] idx：给 v3 的 id → 打开 v3 的摘要', i3.source.echoSourceId === v3.echoSourceId && i3.summary.summary === 'v3 摘要：第十二帧的压缩', i3.summary.summary);
    t('[K] idx：给 mirror 的 id → 打开 mirror 的摘要', im.source.echoSourceId === mirror.echoSourceId && im.summary.summary === '镜像摘要：与 v3 同 cmpId 的那一条', im.summary.summary);
    t('[K] idx 选定来源后仍只给摘要 + srcSeqs（opensFrame=false，没顺手打开帧）',
      i3.opensFrame === false && i3.word === undefined && same(i3.srcSeqs, [12]) && same(im.srcSeqs, [12]), JSON.stringify(i3.srcSeqs));

    // ④ 给错的 id：只能是 MISMATCH，绝不跨候选找、绝不退回「唯一那条」
    const wrongV4 = throwsCode(() => ro.echoOpen(WPTR, { echoSourceId: v4.echoSourceId }));
    t('[K] 用 v4log 来源的 id 开 log 指针 → ECHO_PTR_SOURCE_MISMATCH（命名空间不因选择器而混）', wrongV4 && wrongV4.code === 'ECHO_PTR_SOURCE_MISMATCH', wrongV4 && wrongV4.code);
    t('[K] MISMATCH 的 details 带该指针自己的 candidateIds（两条）', same(sorted(idsOf(wrongV4)), sorted([v3.echoSourceId, mirror.echoSourceId])), JSON.stringify(idsOf(wrongV4)));
    t('[K] idx 选了一个存在但不是候选的来源 → ECHO_PTR_SOURCE_MISMATCH（不是 ECHO_SOURCE_NOT_FOUND）', codeOf(() => ro.echoOpen(IPTR, { echoSourceId: v4.echoSourceId })) === 'ECHO_PTR_SOURCE_MISMATCH');
    t('[K] 根本不存在的 id 也是 MISMATCH（不是「来源不存在」，也不是静默打开别的）', codeOf(() => ro.echoOpen(IPTR, { echoSourceId: 'echo-does-not-exist' })) === 'ECHO_PTR_SOURCE_MISMATCH');
    const singleSrc = ro.echoOpen('log:session-aaaa1111#seq=1').source.echoSourceId;
    t('[K] 单候选 + 错的 id 同样 MISMATCH（选择器不退回「那唯一一条」）', codeOf(() => ro.echoOpen('log:session-aaaa1111#seq=1', { echoSourceId: mirror.echoSourceId })) === 'ECHO_PTR_SOURCE_MISMATCH');
    const okSingle = ro.echoOpen('log:session-aaaa1111#seq=1', { echoSourceId: singleSrc });
    t('[K] 单候选 + 对的 id 正常打开（选择器不破坏单候选路径）', okSingle.source.echoSourceId === singleSrc && okSingle.word.text === '解耦机制记在六层解码之后', okSingle.word.text);
    t('[K] 不存在的指针给什么 id 都还是 ECHO_PTR_NOT_FOUND（顺序：先判指针存在）', codeOf(() => ro.echoOpen('log:session-aaaa1111#seq=999', { echoSourceId: singleSrc })) === 'ECHO_PTR_NOT_FOUND');

    // ⑤ 成功搜索命中 → 打开 的往返：命中自带的 echoSourceId 就是那把钥匙
    const sw = ro.echoSearch('流里的第十二帧', { surface: 'words', limit: 500 });
    const logHits = sw.results.filter((h) => h.ptr === WPTR);
    t('[K] 搜索结果里同一个 ptr 出现两次、来源不同（v3 + mirror）',
      logHits.length === 2 && same(sorted(logHits.map((h) => h.echoSourceId)), sorted([v3.echoSourceId, mirror.echoSourceId])),
      JSON.stringify(logHits.map((h) => h.echoSourceId)));
    const rt = logHits.map((h) => ro.echoOpen(h.ptr, { echoSourceId: h.echoSourceId }));
    t('[K] words 往返：每条命中都打开它自己的来源，正文逐字相同',
      rt.length === 2 && rt.every((r, i) => r.source.echoSourceId === logHits[i].echoSourceId && r.word.text === logHits[i].rawText),
      JSON.stringify(rt.map((r) => r.source.sourcePath)));
    const v4Hit = sw.results.find((h) => h.ptr === 'v4log:session-shared-0001#seq=12');
    const rtV4 = v4Hit ? ro.echoOpen(v4Hit.ptr, { echoSourceId: v4Hit.echoSourceId }) : null;
    t('[K] v4log 命中的往返仍落在 v4log（选择器不把 v4 门牌开成 log 帧）',
      !!rtV4 && rtV4.namespace === 'v4log' && rtV4.word.text === 'V4 流里的第十二帧', rtV4 && rtV4.word.text);
    const idxHits = ro.echoSearch('摘要', { surface: 'summaries', limit: 500 }).results.filter((h) => h.ptr === IPTR);
    const rtI = idxHits.map((h) => ro.echoOpen(h.ptr, { echoSourceId: h.echoSourceId }));
    t('[K] summaries 往返：两条 cmp-shared-0001 各自打开自己的摘要',
      idxHits.length === 2 && rtI.every((r, i) => r.source.echoSourceId === idxHits[i].echoSourceId && r.summary.summary === idxHits[i].rawText),
      JSON.stringify(rtI.map((r) => r.summary.summary)));
    t('[K] 往返不改变读语义：每条命中仅凭 ptr 打开还会 AMBIGUOUS（选择器是「必需的补充」，不是默认行为）',
      codeOf(() => ro.echoOpen(WPTR)) === 'ECHO_PTR_AMBIGUOUS' && codeOf(() => ro.echoOpen(IPTR)) === 'ECHO_PTR_AMBIGUOUS');

    // ⑥ MCP 腿：schema 声明可选参数，调用真的透传，错误码原样回
    const mcp = globalThis.__mcp;
    const openSchema = (mcp.TOOLS.find((x) => x.name === 'soul_echo_open') || {}).inputSchema || {};
    t('[K] MCP schema 声明可选 echoSourceId，required 仍只有 ptr',
      !!openSchema.properties && !!openSchema.properties.echoSourceId && same(openSchema.required || [], ['ptr']),
      JSON.stringify({ props: Object.keys(openSchema.properties || {}), required: openSchema.required }));
    const mcpW = JSON.parse(await mcp.callTool('soul_echo_open', { ptr: WPTR, echoSourceId: mirror.echoSourceId }));
    t('[K] MCP 腿：传 echoSourceId 打开指定来源',
      mcpW.ok === true && mcpW.source.echoSourceId === mirror.echoSourceId && mcpW.word.text === '镜像流里的第十二帧',
      JSON.stringify({ ok: mcpW.ok, src: mcpW.source && mcpW.source.echoSourceId }));
    const mcpBad = JSON.parse(await mcp.callTool('soul_echo_open', { ptr: WPTR, echoSourceId: v4.echoSourceId }));
    t('[K] MCP 腿：错的 id → ok:false + ECHO_PTR_SOURCE_MISMATCH + 候选（含 id 列表）',
      mcpBad.ok === false && mcpBad.code === 'ECHO_PTR_SOURCE_MISMATCH'
      && (mcpBad.candidateIds || []).length === 2 && (mcpBad.candidates || []).length === 2
      && /不替你挑/.test(mcpBad.hint || ''),
      JSON.stringify({ code: mcpBad.code, ids: (mcpBad.candidateIds || []).length }));
    const mcpAmb = JSON.parse(await mcp.callTool('soul_echo_open', { ptr: WPTR }));
    t('[K] MCP 腿：不传 id 仍然 AMBIGUOUS（默认路径没被改掉）',
      mcpAmb.ok === false && mcpAmb.code === 'ECHO_PTR_AMBIGUOUS' && /不替你挑/.test(mcpAmb.hint || ''), mcpAmb.code);
    const mcpIdx = JSON.parse(await mcp.callTool('soul_echo_open', { ptr: IPTR, echoSourceId: v3.echoSourceId }));
    t('[K] MCP 腿：idx 选择器同样生效，摘要正文对得上',
      mcpIdx.ok === true && mcpIdx.source.echoSourceId === v3.echoSourceId && mcpIdx.summary.summary === 'v3 摘要：第十二帧的压缩', mcpIdx.summary && mcpIdx.summary.summary);
  }

  // ── I v4log 与 log 互不冒充 ─────────────────────────────────────────────
  {
    const v4src = (ro.echoStats().sources || []).find((s) => s.sourcePath === 'D:/synthetic/echo/v4/index');
    const r = ro.echoSearch('第十二帧', { surface: 'words', echoSourceId: v4src.echoSourceId });
    t('[I] v4log 来源只回 v4 那一行', r.results.length === 1 && r.results[0].namespace === 'v4log', JSON.stringify(r.results.map((h) => h.ptr)));
    const all = ro.echoSearch('第十二帧', { surface: 'words', limit: 500 });
    const byNs = {};
    for (const h of all.results) byNs[h.namespace] = (byNs[h.namespace] || 0) + 1;
    t('[I] 同名 sid+seq 在 log / v4log 各有一条（是两条流，不是重复）', byNs.log === 2 && byNs.v4log === 1, JSON.stringify(byNs));
  }

  // ── H 缺表 / 陈旧：显式失败 ─────────────────────────────────────────────
  {
    // H1 删掉一行 FTS：计数不再对齐
    const copy = path.join(ROOT, 'stale.sqlite');
    fs.copyFileSync(dbPath, copy);
    const w = openMetaStore({ path: copy, mode: 'readwrite' });
    w.db.prepare('DELETE FROM echo_words_fts WHERE rowid IN (SELECT rowid FROM echo_words_fts LIMIT 1)').run();
    w.close();
    const st = openMetaStore({ path: copy, mode: 'readonly' });
    const stale = throwsCode(() => st.echoSearch('解耦', { surface: 'words' }));
    t('[H] FTS 与行数不一致 → ECHO_INDEX_STALE（绝不回一份少命中的结果）', stale && stale.code === 'ECHO_INDEX_STALE', stale && stale.code);
    const stats = st.echoStats();
    t('[H] echoStats 不抛：如实报 aligned=false + problem 明细',
      stats.available === true && stats.aligned === false && stats.problems.some((p) => p.kind === 'words-fts'),
      JSON.stringify(stats.problems));
    const staleOpen = throwsCode(() => st.echoOpen('log:session-aaaa1111#seq=1'));
    t('[H] 门牌解析同样被闸住（同一个判据，不是两套）', staleOpen && staleOpen.code === 'ECHO_INDEX_STALE', staleOpen && staleOpen.code);
    st.close();

    // H2 没迁到 v9 的库（v8）：不许假装「索引是空的」
    const v8 = makeDb('v8', 8);
    const st8 = openMetaStore({ path: v8, mode: 'readonly' });
    const miss = throwsCode(() => st8.echoSearch('解耦', { surface: 'words' }));
    t('[H] v9 之前的库在 Store 层报 MIGRATION_REQUIRED（readonly 从不迁移）', miss && miss.code === 'MIGRATION_REQUIRED', miss && miss.code);
    st8.close();

    // MCP 腿把同一件事翻成 ECHO_INDEX_MISSING（可用性口径），而不是抛
    const mcp = globalThis.__mcp;
    process.env.AGENT_SOUL_META_DB = v8;
    const r8 = JSON.parse(await mcp.callTool('soul_echo_search', { query: '解耦' }));
    t('[H] MCP 腿：v8 库 → ok:false + ECHO_INDEX_MISSING（可解释，不是空结果）', r8.ok === false && r8.code === 'ECHO_INDEX_MISSING', r8.code);
    process.env.AGENT_SOUL_META_DB = dbPath;

    const noFile = path.join(ROOT, 'nope.sqlite');
    process.env.AGENT_SOUL_META_DB = noFile;
    const rn = JSON.parse(await mcp.callTool('soul_echo_stats', {}));
    t('[H] MCP 腿：库不存在 → ECHO_INDEX_MISSING，且**没有**把库建出来', rn.ok === false && rn.code === 'ECHO_INDEX_MISSING' && !fs.existsSync(noFile), rn.code);
    process.env.AGENT_SOUL_META_DB = dbPath;
  }

  // ── J MCP 腿 + 只读零副作用 ─────────────────────────────────────────────
  {
    const mcp = globalThis.__mcp;
    const before = shaOf(dbPath);
    const beforeDir = dirSnapshot(path.dirname(dbPath));

    const s = JSON.parse(await mcp.callTool('soul_echo_search', { query: '解耦', surface: 'words', limit: 500 }));
    t('[J] MCP soul_echo_search 可用且带 readonly 标记', s.ok === true && s.readonly === true, JSON.stringify({ ok: s.ok, n: (s.results || []).length }));
    t('[J] MCP 结果与 Store 层逐条同集合',
      same(sorted((s.results || []).map((h) => pathOf(h) + '|' + h.session + '|' + h.seq)), oracleWordKeys(oracleFilter(words, { q: '解耦' }))),
      sorted((s.results || []).map((h) => h.session + '#' + h.seq)).join(','));
    const identity1 = JSON.stringify((s.results || []).map((h) => h.ptr));
    const s2 = JSON.parse(await mcp.callTool('soul_echo_search', { query: '解耦', surface: 'words', limit: 500, sessionId: 'session-forged', by: 'someone', action: 'write' }));
    t('[J] 传 sessionId/by/action 不改变一个字节（身份不是权威）', identity1 === JSON.stringify((s2.results || []).map((h) => h.ptr)));

    const st = JSON.parse(await mcp.callTool('soul_echo_stats', {}));
    const semanticBefore=shaOf(dbPath);
    const semanticBeforeDir=dirSnapshot(path.dirname(dbPath));
    const oldModelDir=process.env.ECHO_BGE_MODEL_DIR;
    process.env.ECHO_BGE_MODEL_DIR=path.join(ROOT,'no-bge-runtime');
    const semanticUnavailable=JSON.parse(await mcp.callTool('soul_echo_semantic_search',{query:'semantic probe',echoSourceId:(ro.echoStats().sources||[])[0].echoSourceId}));
    if(oldModelDir===undefined)delete process.env.ECHO_BGE_MODEL_DIR;else process.env.ECHO_BGE_MODEL_DIR=oldModelDir;
    t('[J] missing local model fails closed with no lexical results',semanticUnavailable.ok===false&&semanticUnavailable.code==='MODEL_UNAVAILABLE'&&Array.isArray(semanticUnavailable.results)&&semanticUnavailable.results.length===0,JSON.stringify({code:semanticUnavailable.code,count:(semanticUnavailable.results||[]).length}));
    t('[J] semantic unavailability leaves the TEMP index byte-identical',semanticBefore===shaOf(dbPath)&&same(semanticBeforeDir,dirSnapshot(path.dirname(dbPath))));
    t('[J] MCP soul_echo_stats 报来源与对齐', st.ok === true && st.aligned === true && (st.sources || []).length === 4, 'sources=' + (st.sources || []).length);

    const amb = JSON.parse(await mcp.callTool('soul_echo_open', { ptr: 'log:session-shared-0001#seq=12' }));
    t('[J] MCP soul_echo_open 的歧义回执带 code + 候选路径 +「不替你挑」',
      amb.ok === false && amb.code === 'ECHO_PTR_AMBIGUOUS' && (amb.candidates || []).length === 2 && /不替你挑/.test(amb.hint || ''),
      JSON.stringify({ code: amb.code, n: (amb.candidates || []).length }));
    const one = JSON.parse(await mcp.callTool('soul_echo_open', { ptr: 'idx:cmp-0001' }));
    t('[J] MCP soul_echo_open 的 idx: 回执只给摘要 + 有序 srcSeqs',
      one.ok === true && same(one.srcSeqs, [7, 3, 3, 11]) && one.opensFrame === false && one.summary !== undefined);

    const after = shaOf(dbPath);
    const afterDir = dirSnapshot(path.dirname(dbPath));
    t('[J] 库文件字节哈希不变（读没有写）', before === after, before.slice(0, 12) + ' → ' + after.slice(0, 12));
    t('[J] 目录里没有新增文件（含 -wal/-shm 残留）', same(beforeDir, afterDir), beforeDir.join(',') + ' → ' + afterDir.join(','));
    // ★ 这一条是 G2a 那个事故的形状：只读模式下一条纯读工具不该把 data/sessions 造出来
    t('[J] MCP 腿没有创建 sessions 目录（ECHO 与会话存储无关）', !fs.existsSync(path.join(path.dirname(dbPath), 'sessions')));
  }

  ro.close();

  // ── 汇总 ────────────────────────────────────────────────────────────────
  console.log(ok.join('\n'));
  if (bad.length) console.log('\n' + bad.join('\n'));
  console.log('\n' + (bad.length ? '✗ ' : '✓ ') + '通过 ' + ok.length + ' / ' + (ok.length + bad.length) + '　临时目录：' + ROOT);
  return bad.length ? 1 : 0;
}

let code = 1;
try { code = await main(); } catch (e) {
  console.error('SELFTEST CRASHED:', e && e.stack ? e.stack : e);
  code = 1;
}
process.exit(code);
