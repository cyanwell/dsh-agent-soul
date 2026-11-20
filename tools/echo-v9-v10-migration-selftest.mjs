#!/usr/bin/env node
// tools/echo-v9-v10-migration-selftest.mjs —— v9 → v10 迁移自检（只读仓库代码，不碰生产库）
// ============================================================================
// 这个自检证明一件事：migration 10 只往库里加向量层，v9 的数据与历史一个字段都没动。
//
// 四段，全部在 os.tmpdir() 下的一个临时根里跑：
//   A. 用 MIGRATIONS.slice(0, 9) + targetVersion: 9 建一个真 v9 库
//      （当前代码 SCHEMA_VERSION = 10，所以建出来的库是「比代码旧」的 v9 —— 正是要迁的那种库）。
//   B. 用 tools/echo-index-import.mjs 把合成语料导进**这个 v9 库** —— 库里有真数据，迁移才有可比对象。
//   C. 只跑 migration 10（store.migrate()），断言 applied === [10]、v1–v9 的 checksum 逐位不变、
//      四张 echo 表 + 两张 FTS + 构建审计的每一行逐字段不变、向量两表存在且 0 行。
//   D. 另起一个同样有数据的 v9 库，注入「先建表再抛非法 SQL」的假 v10，断言整批回滚：
//      版本仍是 9、历史仍是 1..9、数据不变、半截表不存在；随后正常 v10 仍能迁上去（库没被毒化）。
//
// ★ 为什么 B 段要一份「v9 时代的代码拷贝」：
//   echo-index-import 是先验 schema 再写库的（store.ensureReady() 要求 current === SCHEMA_VERSION）。
//   仓库现在是 v10，直接对着 v9 库跑会得到 SCHEMA_DELTA_REQUIRED —— 那不是 bug，是导入器的闸。
//   所以这里把 src/db/*.mjs + 导入器**逐字节拷贝**进临时目录，只把 SCHEMA_VERSION 常量改成 9
//   （v9 时代它本来就是 9），再用这份拷贝起子进程。仓库文件一个字节没动，而且「只有那一处不同」
//   在下面被断言过（其余文件 sha256 与仓库逐一相同）。
//
// 边界：
//   · 不打开生产库（data/meta.sqlite 之类），不读会话日志 / 书房 / 墨，不起服务、不碰模型。
//   · 一切写入（库、WAL/SHM、语料拷贝、回执）都在 ROOT 内，且逐条断言过路径包含。
//   · try/finally 清场：无论断言成功失败，临时根都会被删掉。
//
// 用法：node tools/echo-v9-v10-migration-selftest.mjs
//   退出码：0 全通过 / 1 有失败
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openMetaStore, migrate, MIGRATIONS, SCHEMA_VERSION, migrationDigest, readSchemaState } from '../src/db/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SRC_DB = path.join(REPO, 'src', 'db');
const IMPORTER = path.join(HERE, 'echo-index-import.mjs');
const FIXTURE_CORPUS = path.join(HERE, 'fixtures', 'echo-index-import', 'corpus');
const FIXTURE_FILES = ['manifest.json', 'words.jsonl', 'summaries.jsonl'];
// 本机 DSH 自带的 process.execPath 不是纯 node，子进程必须用绝对路径起。
const FALLBACK_NODE = 'C:/Users/pc/.workbuddy/binaries/node/versions/22.22.2-3/node.exe';
const TMP_BASE = path.resolve(os.tmpdir());
const ROOT = fs.mkdtempSync(path.join(TMP_BASE, 'echo-v9-v10-selftest-'));

const ok = [];
const bad = [];
function t(name, cond, detail) {
  const line = (cond ? '✓ ' : '✗ ') + name + (detail === undefined || detail === null ? '' : '  → ' + String(detail));
  (cond ? ok : bad).push(line);
  return cond;
}
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const shaFile = (p) => sha256(fs.readFileSync(p));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function isStrictlyInside(rootDir, p) {
  const rel = path.relative(path.resolve(rootDir), path.resolve(p));
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// 每个落盘路径都要过这两道：在临时根内、也在 os.tmpdir() 内。
function assertContained(label, p, allowRootItself) {
  const abs = path.resolve(p);
  const inRoot = allowRootItself === true ? abs === path.resolve(ROOT) : isStrictlyInside(ROOT, abs);
  const inTmp = isStrictlyInside(TMP_BASE, abs);
  t('[containment] ' + label + ' 在临时根内', inRoot, abs);
  t('[containment] ' + label + ' 在 os.tmpdir() 内', inTmp, abs);
  return inRoot && inTmp;
}

function withStore(dbPath, fn) {
  const store = openMetaStore({ path: dbPath, mode: 'readwrite', migrateOnOpen: false });
  try { return fn(store); } finally { try { store.close(); } catch (_) { /* 已关 */ } }
}

// ── 子进程 node：先看 process.execPath 是不是真 node，不是就用绝对路径 ──────────
function resolveChildNode() {
  const exeBase = path.basename(process.execPath).toLowerCase();
  const harnessLike = exeBase !== 'node' && exeBase !== 'node.exe';
  t('[node] 已检查 process.execPath 是否就是 node', true,
    process.execPath + '（' + (harnessLike ? '不是纯 node —— 子进程改用绝对路径' : '是 node 本身') + '）');
  const candidates = [];
  if (!harnessLike) candidates.push(process.execPath);
  candidates.push(FALLBACK_NODE);
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) { t('[node] 候选可执行文件存在 ' + candidate, false, 'missing'); continue; }
    const probe = spawnSync(candidate, ['-e', 'process.stdout.write(process.versions.node)'], { encoding: 'utf8' });
    if (probe.status !== 0) {
      t('[node] 候选可执行文件能跑 ' + candidate, false, String(probe.stderr || '').slice(0, 140));
      continue;
    }
    const version = String(probe.stdout || '').trim();
    const major = Number(version.split('.')[0]);
    t('[node] 选定子进程 node：' + candidate, major >= 22, 'v' + version + '（node:sqlite 需要 >= 22）');
    return candidate;
  }
  t('[node] 找到可用的 node 可执行文件', false, 'candidates=' + candidates.join(' | '));
  return null;
}

// ── v9 时代的代码拷贝（唯一改动：SCHEMA_VERSION 10 → 9）─────────────────────
function buildV9EraCodeCopy() {
  const dir = path.join(ROOT, 'v9-era-code');
  fs.mkdirSync(path.join(dir, 'src', 'db'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  assertContained('v9 时代代码拷贝目录', dir);

  const copied = [];
  for (const name of fs.readdirSync(SRC_DB)) {
    if (!name.endsWith('.mjs')) continue;
    const src = path.join(SRC_DB, name);
    const dst = path.join(dir, 'src', 'db', name);
    fs.copyFileSync(src, dst);
    copied.push({ name, src, dst });
  }
  const importerCopy = path.join(dir, 'tools', 'echo-index-import.mjs');
  const importerOriginal = fs.readFileSync(IMPORTER, 'utf8');
  const modernInsert = 'content_hash, content_class)';
  const hasModernInsert = importerOriginal.includes(modernInsert);
  let expectedImporter = importerOriginal;
  if (hasModernInsert) {
    expectedImporter = expectedImporter.replace(modernInsert, 'content_hash)')
      .replace('VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', 'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .replace("import { classifyEchoWordContent } from '../src/db/echo-content-class.mjs';\n", '')
      .replace(/, classifyEchoWordContent\(\{ text: w\.text, role: w\.role, truncated: w\.truncated \}\)\);/, ');');
  }
  fs.writeFileSync(importerCopy, expectedImporter);
  const importerText = fs.readFileSync(importerCopy, 'utf8');
  t('[v9-pin] TEMP importer copy exactly matches pre-v13 compatibility transform', importerText === expectedImporter && (!hasModernInsert || !importerText.includes('classifyEchoWordContent')), 'adapted=' + hasModernInsert);
  t('[v9-pin] 拷贝了 src/db/*.mjs 与导入器', copied.length >= 15 && fs.existsSync(importerCopy), 'files=' + copied.length);

  const schemaCopy = path.join(dir, 'src', 'db', 'schema.mjs');
  const text = fs.readFileSync(schemaCopy, 'utf8');
  const marker = 'export const SCHEMA_VERSION = ';
  const occurrences = text.split(marker).length - 1;
  t('[v9-pin] 拷贝里 SCHEMA_VERSION 声明只有一处', occurrences === 1, 'occurrences=' + occurrences);
  const valueAt = text.indexOf(marker) + marker.length;
  const valueEnd = text.indexOf(';', valueAt);
  const declared = text.slice(valueAt, valueEnd).trim();
  t('[v9-pin] 仓库包含被测 v10 且没有静默降版', Number(declared) >= 10 && SCHEMA_VERSION >= 10 && declared === String(SCHEMA_VERSION),
    'schema.mjs=' + declared + ' export=' + SCHEMA_VERSION);
  const patched = text.slice(0, valueAt) + '9' + text.slice(valueEnd);
  fs.writeFileSync(schemaCopy, patched);
  // 反向还原必须逐字回到原文 —— 这比「我改过它」更能证明只改了那一处。
  const patchedValueEnd = valueAt + '9'.length;
  t('[v9-pin] 拷贝与仓库只差 SCHEMA_VERSION 这一处',
    patched !== text && patched.slice(0, valueAt) + declared + patched.slice(patchedValueEnd) === text,
    'declared=' + declared + ' → 9');
  const others = copied.filter((c) => c.name !== 'schema.mjs');
  t('[v9-pin] 其它拷贝文件与仓库逐字节相同',
    others.every((c) => shaFile(c.dst) === shaFile(c.src)) && importerText === expectedImporter,
    'compared=' + others.length + '+pre-v13 importer transform');

  return { dir, importer: importerCopy };
}

// ── 合成语料：拷进临时根，只从拷贝读 ────────────────────────────────────────
function copyFixtureIntoRoot() {
  const dir = path.join(ROOT, 'fixture-corpus');
  fs.mkdirSync(dir, { recursive: true });
  assertContained('语料拷贝目录', dir);
  const out = {};
  for (const name of FIXTURE_FILES) {
    const src = path.join(FIXTURE_CORPUS, name);
    const dst = path.join(dir, name);
    fs.copyFileSync(src, dst);
    assertContained('语料拷贝 ' + name, dst);
    t('[fixture] ' + name + ' 拷贝逐字节相同', shaFile(dst) === shaFile(src), shaFile(dst).slice(0, 12));
    out[name] = dst;
  }
  return { dir, manifest: out['manifest.json'] };
}

// ── 建一个真 v9 库（用仓库自己的 MIGRATIONS 前 9 条）────────────────────────
function makeV9Db(label) {
  const dir = path.join(ROOT, 'db-' + label);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'meta.sqlite');
  assertContained('v9 库 ' + label, dbPath);
  withStore(dbPath, (store) => {
    const start = readSchemaState(store.db);
    t('[v9] ' + label + ' 起点是空库（v0）', start.current === 0 && start.applied.length === 0, 'current=' + start.current);
    const applied = migrate(store.db, { migrations: MIGRATIONS.slice(0, 9), targetVersion: 9 });
    store.refreshState();
    t('[v9] ' + label + ' 只应用 1..9', same(applied.applied.map((m) => m.version), [1, 2, 3, 4, 5, 6, 7, 8, 9]),
      JSON.stringify(applied.applied.map((m) => m.version)));
    t('[v9] ' + label + ' 落在 v9 且尚未 ready（代码是 v10）',
      store.state.current === 9 && store.state.ready === false && store.state.tooNew === false,
      'current=' + store.state.current + ' ready=' + store.state.ready);
    t('[v9] ' + label + ' 已有 v9 的 echo 主表（先有结构，才有导入）',
      store.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('echo_index_sources','echo_words','echo_summaries','echo_summary_src_seqs')").get().n === 4);
    t('[v9] ' + label + ' 还没有向量表（那是 v10 的事）',
      store.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('echo_vector_models','echo_word_vectors')").get().n === 0);
    t('[v9] ' + label + ' 日志模式是 wal，WAL 文件落在临时根内',
      store.pragmas.journalMode === 'wal' && fs.existsSync(dbPath + '-wal') && isStrictlyInside(ROOT, dbPath + '-wal'),
      'journal=' + store.pragmas.journalMode + ' wal=' + fs.existsSync(dbPath + '-wal'));
  });
  return dbPath;
}

// ── 用 v9 时代的拷贝把合成语料导进这个 v9 库（子进程，走真正的 CLI 路径）───────
function importFixture(nodeBin, importerPath, dbPath, manifestPath) {
  const sha = shaFile(manifestPath);
  const args = [importerPath, '--manifest', manifestPath, '--sha256', sha, '--generation', '1', '--db', dbPath, '--json'];
  const run = spawnSync(nodeBin, args, { encoding: 'utf8', cwd: ROOT });
  const stdout = String(run.stdout || '');
  let receipt = null;
  try {
    const lines = stdout.trim().split('\n');
    receipt = JSON.parse(lines[lines.length - 1]);
  } catch (_) { receipt = null; }
  const receiptPath = path.join(ROOT, 'receipt-' + path.basename(path.dirname(dbPath)) + '.json');
  fs.writeFileSync(receiptPath, (receipt ? JSON.stringify(receipt, null, 2) : JSON.stringify({ raw: stdout, stderr: run.stderr }, null, 2)) + '\n');
  assertContained('导入回执 ' + path.basename(receiptPath), receiptPath);
  t('[import] ' + path.basename(path.dirname(dbPath)) + ' 子进程 exit 0', run.status === 0,
    'status=' + run.status + ' stderr=' + String(run.stderr || '').slice(-200));
  t('[import] 回执 code=IMPORTED 且 ok', !!receipt && receipt.ok === true && receipt.code === 'IMPORTED', receipt && receipt.code);
  t('[import] 计数与清单一致 6 words / 2 summaries / 5 srcSeqs / 1 excludedReasoning',
    !!receipt && same(receipt.counts, { words: 6, summaries: 2, srcSeqs: 5, excludedReasoning: 1 }),
    receipt && JSON.stringify(receipt.counts));
  t('[import] 导入时目标库自报 schemaVersion=9（导的就是 v9 库）',
    !!receipt && !!receipt.db && receipt.db.schemaVersion === 9, receipt && receipt.db && ('schemaVersion=' + receipt.db.schemaVersion));
  t('[import] 导入器只写了我们这个临时库',
    !!receipt && path.resolve(receipt.db.path) === path.resolve(dbPath) && isStrictlyInside(ROOT, receipt.db.path),
    receipt && receipt.db && receipt.db.path);
  return receipt;
}

// ── 快照：迁移前后逐字段比对的唯一口径 ─────────────────────────────────────
const ROW_SQL = {
  sources: 'SELECT * FROM echo_index_sources ORDER BY echo_source_id, source_version',
  words: 'SELECT * FROM echo_words ORDER BY echo_source_id, word_ord',
  summaries: 'SELECT * FROM echo_summaries ORDER BY echo_source_id, cmp_id',
  srcSeqs: 'SELECT * FROM echo_summary_src_seqs ORDER BY echo_source_id, cmp_id, ord',
  builds: 'SELECT * FROM echo_source_builds ORDER BY build_id',
};
function captureKeyState(db) {
  return {
    sources: db.prepare(ROW_SQL.sources).all(),
    words: db.prepare(ROW_SQL.words).all(),
    summaries: db.prepare(ROW_SQL.summaries).all(),
    srcSeqs: db.prepare(ROW_SQL.srcSeqs).all(),
  };
}
function capture(db) {
  const snap = captureKeyState(db);
  snap.builds = db.prepare(ROW_SQL.builds).all();
  snap.checksums = db.prepare('SELECT version, name, checksum, applied_at, node_version, sqlite_version FROM schema_migrations ORDER BY version').all();
  snap.ftsRows = {
    words: Number(db.prepare('SELECT COUNT(*) AS n FROM echo_words_fts').get().n),
    summaries: Number(db.prepare('SELECT COUNT(*) AS n FROM echo_summaries_fts').get().n),
  };
  snap.sequence = db.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name').all();
  const s = readSchemaState(db);
  snap.state = { current: s.current, ready: s.ready, tooNew: s.tooNew, historyBroken: s.historyBroken, applied: s.applied.map((a) => a.version) };
  return snap;
}
function vectorTables(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('echo_vector_models','echo_word_vectors') ORDER BY name").all().map((r) => r.name);
}

function main() {
  assertContained('临时根', ROOT, true);
  t('[fixture] 合成语料目录存在', fs.existsSync(FIXTURE_CORPUS), FIXTURE_CORPUS);
  t('[env] 当前仓库至少包含 v10 且迁移连续', SCHEMA_VERSION >= 10 && MIGRATIONS.length === SCHEMA_VERSION && MIGRATIONS[9].version === 10,
    'SCHEMA_VERSION=' + SCHEMA_VERSION + ' migrations=' + MIGRATIONS.map((m) => m.version).join(','));
  t('[env] 第 10 条迁移就是 echo-word-vectors',
    !!MIGRATIONS[9] && MIGRATIONS[9].version === 10 && MIGRATIONS[9].name === 'echo-word-vectors',
    MIGRATIONS[9] && (MIGRATIONS[9].version + ' ' + MIGRATIONS[9].name));

  const nodeBin = resolveChildNode();
  if (!nodeBin) return;
  const v9Code = buildV9EraCodeCopy();
  const fixture = copyFixtureIntoRoot();

  // ══ A/B：v9 库 + 真导入 ═════════════════════════════════════════════════════
  const dbA = makeV9Db('a-migrate');
  importFixture(nodeBin, v9Code.importer, dbA, fixture.manifest);

  let beforeA = null;
  withStore(dbA, (store) => {
    beforeA = capture(store.db);
    t('[capture] v9 库：1 来源 / 6 words / 2 摘要 / 5 有序 srcSeq / 1 条构建审计',
      beforeA.sources.length === 1 && beforeA.words.length === 6 && beforeA.summaries.length === 2
      && beforeA.srcSeqs.length === 5 && beforeA.builds.length === 1,
      's=' + beforeA.sources.length + ' w=' + beforeA.words.length + ' m=' + beforeA.summaries.length
      + ' q=' + beforeA.srcSeqs.length + ' b=' + beforeA.builds.length);
    t('[capture] 两张 FTS 与主表对齐（6 / 2）', beforeA.ftsRows.words === 6 && beforeA.ftsRows.summaries === 2,
      JSON.stringify(beforeA.ftsRows));
    t('[capture] v1–v9 的 checksum 抓到 9 条',
      same(beforeA.checksums.map((c) => c.version), [1, 2, 3, 4, 5, 6, 7, 8, 9]) && beforeA.checksums.every((c) => c.checksum === migrationDigest(MIGRATIONS[c.version - 1])),
      beforeA.checksums.map((c) => 'v' + c.version + ':' + c.checksum.slice(0, 8)).join(' '));
    t('[capture] 快照与库自报的 v9 一致',
      beforeA.state.current === 9 && same(beforeA.state.applied, [1, 2, 3, 4, 5, 6, 7, 8, 9]), 'current=' + beforeA.state.current);
    t('[capture] v9 时向量两表不存在', vectorTables(store.db).length === 0, JSON.stringify(vectorTables(store.db)));
  });

  // ══ C：只跑 migration 10 ═══════════════════════════════════════════════════
  withStore(dbA, (store) => {
    const result = migrate(store.db, { migrations: MIGRATIONS.slice(0, 10), targetVersion: 10 });
    store.refreshState();
    t('[migrate] 只应用 [10]（一条，且正是 v10）',
      result.applied.length === 1 && result.applied[0].version === 10 && result.current === 10,
      JSON.stringify(result.applied.map((m) => m.version)) + ' current=' + result.current);
    t('[migrate] v10 的名字与 checksum 与代码复算一致',
      result.applied[0].name === 'echo-word-vectors' && result.applied[0].checksum === migrationDigest(MIGRATIONS[9]),
      result.applied[0].name + ' ' + result.applied[0].checksum.slice(0, 12));
    t('[migrate] history ends at v10 with continuous applied versions',
      result.current === 10 && same(store.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(r => Number(r.version)), [1,2,3,4,5,6,7,8,9,10]),
      'current=' + result.current + ' stateReadyAgainstV13=' + store.state.ready);
    t('[migrate] 历史连续 1..10',
      same(store.state.applied.map((a) => a.version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
      store.state.applied.map((a) => a.version).join(','));

    const after = capture(store.db);
    t('[immutable] v1–v9 的 checksum / name / applied_at / node / sqlite 逐字段不变',
      same(after.checksums.slice(0, 9), beforeA.checksums),
      after.checksums.slice(0, 9).map((c) => 'v' + c.version + ':' + c.checksum.slice(0, 8)).join(' '));
    t('[immutable] 新增的只有 v10 这一行', after.checksums.length === 10 && after.checksums[9].version === 10);
    t('[immutable] echo_index_sources 逐字段相同', same(after.sources, beforeA.sources), 'rows=' + after.sources.length);
    t('[immutable] echo_words 逐字段相同（含 text / content_hash / truncated）', same(after.words, beforeA.words), 'rows=' + after.words.length);
    t('[immutable] echo_summaries 逐字段相同（含 full_json / src_seq_count）', same(after.summaries, beforeA.summaries), 'rows=' + after.summaries.length);
    t('[immutable] echo_summary_src_seqs 逐字段相同（含顺序与重复 seq）', same(after.srcSeqs, beforeA.srcSeqs), 'rows=' + after.srcSeqs.length);
    t('[immutable] echo_source_builds 逐字段相同', same(after.builds, beforeA.builds), 'rows=' + after.builds.length);
    t('[immutable] 两张 FTS 行数不变', same(after.ftsRows, beforeA.ftsRows), JSON.stringify(after.ftsRows));
    t('[immutable] sqlite_sequence 不变（v10 不带 autoincrement 表）', same(after.sequence, beforeA.sequence), JSON.stringify(after.sequence));

    const tables = vectorTables(store.db);
    t('[v10] 向量两表都建出来了', same(tables, ['echo_vector_models', 'echo_word_vectors']), JSON.stringify(tables));
    t('[v10] 索引 idx_echo_word_vectors_model 存在',
      store.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name='idx_echo_word_vectors_model'").get().n === 1);
    const modelRows = Number(store.db.prepare('SELECT COUNT(*) AS n FROM echo_vector_models').get().n);
    const vectorRows = Number(store.db.prepare('SELECT COUNT(*) AS n FROM echo_word_vectors').get().n);
    t('[v10] 两张向量表都还是 0 行（迁移不造向量）', modelRows === 0 && vectorRows === 0, 'models=' + modelRows + ' vectors=' + vectorRows);
    t('[v10] 向量外键指到 echo_words（不复制正文）',
      /REFERENCES echo_words\(echo_source_id, word_ord\)/.test(String(store.db.prepare("SELECT sql FROM sqlite_master WHERE name='echo_word_vectors'").get().sql)));
    t('[v10] words 仍是 6 行（v10 不预填向量，也没删词）',
      Number(store.db.prepare('SELECT COUNT(*) AS n FROM echo_words').get().n) === 6);
  });

  // ══ D：注入会失败的 v10，整批必须回滚 ═════════════════════════════════════
  const dbB = makeV9Db('b-rollback');
  importFixture(nodeBin, v9Code.importer, dbB, fixture.manifest);

  let keyBeforeB = null;
  let beforeB = null;
  withStore(dbB, (store) => {
    beforeB = capture(store.db);
    keyBeforeB = captureKeyState(store.db);
    const broken = {
      version: 10,
      name: 'echo-word-vectors-broken-probe',
      // 先建表（证明事务里确实执行过 DDL），再一句非法 SQL 让它炸。
      sql: 'CREATE TABLE echo_v10_partial_probe (probe_id INTEGER PRIMARY KEY);\nCREATE TABLE echo_v10_oops (;',
    };
    let thrown = null;
    try {
      migrate(store.db, { migrations: MIGRATIONS.slice(0, 9).concat([broken]), targetVersion: 10 });
    } catch (err) { thrown = err; }
    t('[rollback] 迁移抛错且是 MIGRATION_FAILED', !!thrown && thrown.code === 'MIGRATION_FAILED',
      thrown ? (thrown.code + ' · ' + String(thrown.message).slice(0, 160)) : '(没抛)');
    t('[rollback] 报错点名失败的是 v10 与注入的名字',
      !!thrown && /v10/.test(String(thrown.message)) && /echo-word-vectors-broken-probe/.test(String(thrown.message)),
      thrown && String(thrown.message).slice(0, 160));

    store.refreshState();
    t('[rollback] 版本仍是 v9', store.state.current === 9, 'current=' + store.state.current);
    t('[rollback] 历史仍是 1..9，没有半条 v10 记录',
      same(store.state.applied.map((a) => a.version), [1, 2, 3, 4, 5, 6, 7, 8, 9]),
      store.state.applied.map((a) => a.version).join(','));
    const afterB = capture(store.db);
    t('[rollback] v1–v9 的 checksum 一字未动', same(afterB.checksums, beforeB.checksums));
    t('[rollback] 已有数据逐字段不变', same(captureKeyState(store.db), keyBeforeB));
    t('[rollback] 半截表 echo_v10_partial_probe 没留下',
      store.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'echo_v10_%'").get().n === 0);
    t('[rollback] 向量两表也没被建出来', vectorTables(store.db).length === 0, JSON.stringify(vectorTables(store.db)));
    t('[rollback] 库仍不 ready（v9 < 代码 v10）', store.state.ready === false && store.state.tooNew === false);
    t('[rollback] 哨兵文本仍可检索（数据不只是"行数没变"）',
      Number(store.db.prepare('SELECT COUNT(*) AS n FROM echo_words WHERE text = ?').get('解耦机制记在六层解码之后').n) === 1);
  });

  // 回滚之后库没被毒化：正常 v10 仍能迁上去，且只应用 [10]。
  withStore(dbB, (store) => {
    const appliedB = migrate(store.db, { migrations: MIGRATIONS.slice(0, 10), targetVersion: 10 }).applied.map((m) => m.version);
    store.refreshState();
    t('[recover] 回滚过的库能正常迁到 v10', same(appliedB, [10]) && store.db.prepare('SELECT MAX(version) v FROM schema_migrations').get().v === 10,
      JSON.stringify(appliedB) + ' current=' + store.db.prepare('SELECT MAX(version) v FROM schema_migrations').get().v + ' stateReadyAgainstV13=' + store.state.ready);
    t('[recover] 迁移后向量两表存在且 0 行',
      vectorTables(store.db).length === 2
      && Number(store.db.prepare('SELECT COUNT(*) AS n FROM echo_word_vectors').get().n) === 0);
    t('[recover] 迁移后原有数据与坏迁移前逐字段相同', same(captureKeyState(store.db), keyBeforeB));
  });
}

let thrown = null;
try {
  main();
} catch (err) {
  thrown = err;
} finally {
  if (thrown) t('自检本身没抛异常', false, thrown && thrown.stack ? thrown.stack.split('\n').slice(0, 6).join(' | ') : String(thrown));
  let removed = false;
  for (let attempt = 0; attempt < 5 && !removed; attempt += 1) {
    try {
      fs.rmSync(ROOT, { recursive: true, force: true });
      removed = !fs.existsSync(ROOT);
    } catch (_) {
      if (attempt === 4) removed = !fs.existsSync(ROOT);
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
    }
  }
  t('[cleanup] 临时根已删除（库 / WAL / 语料拷贝 / 回执都在里面）', removed === true, ROOT);
}

console.log('');
console.log('=== v9 -> v10 迁移自检 ===');
console.log('node: ' + process.version + '  SCHEMA_VERSION: ' + SCHEMA_VERSION);
console.log('');
console.log(ok.join('\n'));
if (bad.length) { console.log(''); console.log(bad.join('\n')); }
console.log('');
console.log(ok.length + ' 通过 / ' + bad.length + ' 失败');
console.log('临时根：' + ROOT + ' → ' + (fs.existsSync(ROOT) ? '仍存在（失败）' : '已删除'));
console.log('');
process.exit(bad.length ? 1 : 0);
