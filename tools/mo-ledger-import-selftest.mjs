#!/usr/bin/env node
// tools/mo-ledger-import-selftest.mjs —— 当前 schema v12 导入器自检（TEMP DB ONLY）
// ============================================================================
// 这个自检只证明一件事：**导入器会不会在错的时候停下来，在对的时候一字不改地导进去**，
// 以及 v8 引入导入溯源之后那两条边界是不是真的成立：
//
//   1. **8 类都能入库**（含历史 lead / 历史 promise）—— 导入的是溯源，不是「现在」；
//   2. **源行永远不是当前权威** —— 历史 lead 不在 store.latestLead() /
//      ledgerStats().latestLead 里，也不在 organs/ledger.currentLead() / isBrain 里；
//      只有在临时库里用**显式 raw SQL** 写入的、非导入的 lead 才会成为 live lead。
//
// ★ 全程只碰临时目录：
//     · 源 = tools/fixtures/mo-ledger-import/ 下的合成文件（不读 02-墨.jsonl）；
//     · 目标 = os.tmpdir() 下每个用例新建的 meta.sqlite（不碰 data/、不碰 00-记忆库/）。
//   ★ 生产路径**只作为字符串传进去**，用来证明护栏真的会拒 —— 从不打开、从不写入。
//
// ★ 完整库走真实 schema v12 迁移（v8 导入溯源、v9 ECHO 派生索引、v10 长文本向量、
//   v11 构建审计迁移、v12 句子窗口向量），v7 用例显式验证真实 v8-v12 前向迁移；
//   不再套用测试夹具 SQL：
//   夹具能复制的只是结构，复制不了「迁移本身是对的这一件事」。
// ★ 每个失败用例都断言**目标库 ledger/batch 计数没变**，且**源文件哈希前后一致**。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openMetaStore, migrate, MIGRATIONS, migrationDigest, SCHEMA_VERSION } from '../src/db/index.mjs';
import { LedgerBase, normId } from '../src/organs/ledger.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures', 'mo-ledger-import');
const CLI = path.join(HERE, 'mo-ledger-import.mjs');
const NODE = process.execPath;
function assertTempPath(target) {
  const root = path.resolve(os.tmpdir()).toLowerCase() + path.sep;
  const resolved = path.resolve(target).toLowerCase();
  if (resolved !== root.slice(0, -1) && !resolved.startsWith(root)) {
    throw new Error('selftest fixture path is outside os.tmpdir(): ' + target);
  }
  return target;
}
assertTempPath(os.tmpdir());
const ROOT = fs.mkdtempSync(assertTempPath(path.join(os.tmpdir(), 'mo-import-selftest-')));
const PRODUCTION_LEDGER = 'D:/AI/yanqing-soul/02-墨.jsonl';
const PRODUCTION_META = path.resolve(HERE, '..', 'data', 'meta.sqlite');

// 显式 fixture 身份：live = 本机写入的 lead；historical = 从旧账本导入的 lead。
const LIVE_LEAD_SESSION = 'session-12345678-aaaa-bbbb-cccc-dddddddddddd';
const LIVE_LEAD_ACTOR = '12345678-aaaa-bbbb-cccc-dddddddddddd';
const HISTORICAL_ACTOR = '7a7a7a7a-1111-2222-3333-444444444444';

const ok = [];
const bad = [];
function t(name, cond, detail) {
  (cond ? ok : bad).push((cond ? '✓ ' : '✗ ') + name + (detail === undefined || detail === null ? '' : '  → ' + String(detail)));
  return cond;
}
const shaOf = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// version 参数只用来造「不够新」的库（证明导入器会拒，而不是偷偷迁移）。
function makeDb(name, version) {
  const target = version === undefined ? SCHEMA_VERSION : version;
  const dir = assertTempPath(path.join(ROOT, 'db-' + name));
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = assertTempPath(path.join(dir, 'meta.sqlite'));
  const store = openMetaStore({ path: dbPath, mode: 'readwrite' });
  try {
    if (target === SCHEMA_VERSION) store.migrate();
    else {
      migrate(store.db, { migrations: MIGRATIONS.slice(0, target), targetVersion: target });
      store.refreshState();
    }
  } finally {
    store.close();
  }
  return dbPath;
}

function inspect(dbPath) {
  const store = openMetaStore({ path: dbPath, mode: 'readwrite' });
  try {
    return {
      ledger: Number(store.db.prepare('SELECT COUNT(*) AS n FROM mo_ledger').get().n),
      batches: (() => {
        const has = store.db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='mo_import_batches'").get();
        return has ? Number(store.db.prepare('SELECT COUNT(*) AS n FROM mo_import_batches').get().n) : -1;
      })(),
      rows: (() => {
        const cols = store.db.prepare('PRAGMA table_info(mo_ledger)').all().map((c) => c.name);
        const select = ['row_id', 't', 'type', 'text', 'by', 'actor_session', 'ref', 'feel', 'by_user', 'legacy_line', 'legacy_raw']
          .concat(cols.indexOf('import_batch_id') === -1 ? [] : ['import_batch_id']).join(',');
        return store.db.prepare('SELECT ' + select + ' FROM mo_ledger ORDER BY row_id').all();
      })(),
      schemaVersion: Number(store.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v),
      // ★ 「导入器从不迁移」要能取证：迁移史逐条（version + checksum）原样拿出来比对，
      //   而不是只看 max(version) —— 一个库就算被重写过同一批版本号，max(version) 也看不出来。
      migrations: store.db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all(),
      // ★ 每次调用另开一个连接：inspect() 返回前会 close()，闭包里的 store 不能再用。
      exec(fn) {
        const s = openMetaStore({ path: dbPath, mode: 'readwrite' });
        try { return fn(s.db); } finally { s.close(); }
      },
    };
  } finally {
    store.close();
  }
}

function runCli(args) {
  const r = spawnSync(NODE, [CLI, '--json'].concat(args), { encoding: 'utf8' });
  let receipt = null;
  try { receipt = JSON.parse(String(r.stdout || '').trim().split('\n').pop()); } catch { receipt = null; }
  return { status: r.status, stderr: String(r.stderr || ''), receipt };
}

const fixture = (name) => path.join(FIXTURES, name);

// ── 用例表 ─────────────────────────────────────────────────────────────────
function negativeCase(label, source, expectedCode, opts) {
  const o = opts || {};
  const db = makeDb(o.dbName || label);
  const before = inspect(db);
  const srcShaBefore = shaOf(source);
  const r = runCli(['--source', source, '--sha256', o.sha || shaOf(source), '--db', db]);
  const after = inspect(db);
  t('[' + label + '] exit ' + (o.exit === undefined ? 3 : o.exit), r.status === (o.exit === undefined ? 3 : o.exit), 'status=' + r.status + ' stderr=' + r.stderr.trim().split('\n').pop());
  t('[' + label + '] code ' + expectedCode, r.receipt && r.receipt.code === expectedCode, r.receipt ? r.receipt.code + ' · ' + String(r.receipt.message).slice(0, 90) : 'no receipt');
  t('[' + label + '] 目标库计数未变', before.ledger === after.ledger && before.batches === after.batches, 'ledger ' + before.ledger + '→' + after.ledger + ' · batches ' + before.batches + '→' + after.batches);
  t('[' + label + '] 源文件哈希未变', srcShaBefore === shaOf(source), srcShaBefore.slice(0, 12) + ' → ' + shaOf(source).slice(0, 12));
  if (o.line !== undefined) {
    t('[' + label + '] 报出行号 ' + o.line, !!(r.receipt && r.receipt.detail && r.receipt.detail.line === o.line), r.receipt && r.receipt.detail ? JSON.stringify(r.receipt.detail).slice(0, 120) : 'no detail');
  }
  return { r, db };
}

// 临时库里的 raw SQL：这是**显式 fixture**，不是「库会认证裸 SQL 作者」的证据。
function insertLiveLead(dbPath, text) {
  const store = openMetaStore({ path: dbPath, mode: 'readwrite' });
  try {
    store.db.prepare([
      'INSERT INTO mo_ledger (t,type,text,by,actor_session,ref,feel,by_user)',
      "VALUES ('2026-11-14T00:00:00.000Z','lead',?,?,?,'fixture:owner-seat',NULL,0)",
    ].join(' ')).run(text, LIVE_LEAD_SESSION.slice(8, 16), LIVE_LEAD_ACTOR);
  } finally {
    store.close();
  }
}

function main() {
  // ── 0. 版本前提：完整库必须走当前 schema v12 ──
  t('[v12] SCHEMA_VERSION 是 12', SCHEMA_VERSION === 12, SCHEMA_VERSION);
  t('[v12] 迁移清单 1..12，v8-v12 名称/顺序符合契约',
    MIGRATIONS.map((m) => m.version).join(',') === '1,2,3,4,5,6,7,8,9,10,11,12'
    && MIGRATIONS.slice(7).map((m) => m.name).join(',') === 'mo-import-provenance,echo-derived-index,echo-word-vectors,echo-builds-audit-survives-source,echo-sentence-window-vectors',
    MIGRATIONS.map((m) => m.version + ':' + m.name).join(', '));

  // ── A. 用法：三个必填参数，一个都不许省 ───────────────────────────────
  {
    const db = makeDb('usage');
    const src = fixture('happy-lf.jsonl');
    let r = runCli(['--sha256', shaOf(src), '--db', db]);
    t('[usage] 缺 --source → exit 2 / USAGE_MISSING_ARG', r.status === 2 && r.receipt && r.receipt.code === 'USAGE_MISSING_ARG', r.receipt && r.receipt.code);
    r = runCli(['--source', src, '--sha256', shaOf(src).toUpperCase(), '--db', db]);
    t('[usage] 大写 SHA 被拒 → USAGE_BAD_SHA', r.status === 2 && r.receipt && r.receipt.code === 'USAGE_BAD_SHA', r.receipt && r.receipt.code);
    r = runCli(['--source', src, '--sha256', shaOf(src).slice(0, 63), '--db', db]);
    t('[usage] 63 位 SHA 被拒 → USAGE_BAD_SHA', r.status === 2 && r.receipt && r.receipt.code === 'USAGE_BAD_SHA', r.receipt && r.receipt.code);
    r = runCli(['--source', src, '--sha256', shaOf(src), '--db', db, '--nope']);
    t('[usage] 未知参数被拒 → USAGE_UNKNOWN_FLAG', r.status === 2 && r.receipt && r.receipt.code === 'USAGE_UNKNOWN_FLAG', r.receipt && r.receipt.code);
    t('[usage] 目标库仍是 0/0', inspect(db).ledger === 0 && inspect(db).batches === 0, 'ledger=' + inspect(db).ledger);
  }

  // ── B. 源护栏：生产账本，连读都不读 ───────────────────────────────────
  {
    const db = makeDb('prod-source');
    const r = runCli(['--source', PRODUCTION_LEDGER, '--sha256', 'a'.repeat(64), '--db', db]);
    t('[source-guard] 生产账本被拒 → exit 3 / SOURCE_IS_PRODUCTION_LEDGER',
      r.status === 3 && r.receipt && r.receipt.code === 'SOURCE_IS_PRODUCTION_LEDGER', r.receipt && r.receipt.code);
    t('[source-guard] 目标库未被写入', inspect(db).ledger === 0 && inspect(db).batches === 0, 'ledger=' + inspect(db).ledger);
  }

  // ── C. 目标护栏：生产 meta.sqlite / :memory: / 不存在 ─────────────────
  {
    const src = fixture('happy-lf.jsonl');
    const good = shaOf(src);
    let r = runCli(['--source', src, '--sha256', good, '--db', PRODUCTION_META]);
    t('[db-guard] config.dataDir/meta.sqlite 被拒 → DB_IS_PRODUCTION_META',
      r.status === 3 && r.receipt && r.receipt.code === 'DB_IS_PRODUCTION_META', r.receipt && (r.receipt.code + ' · ' + String(r.receipt.detail && r.receipt.detail.rule)));
    r = runCli(['--source', src, '--sha256', good, '--db', ':memory:']);
    t('[db-guard] :memory: 被拒 → DB_IS_MEMORY', r.status === 3 && r.receipt && r.receipt.code === 'DB_IS_MEMORY', r.receipt && r.receipt.code);
    const missing = path.join(ROOT, 'no-such-dir', 'meta.sqlite');
    r = runCli(['--source', src, '--sha256', good, '--db', missing]);
    t('[db-guard] 不存在的目标库被拒 → DB_NOT_FOUND（不替人建库）', r.status === 5 && r.receipt && r.receipt.code === 'DB_NOT_FOUND', r.receipt && r.receipt.code);
    t('[db-guard] 被拒后目录仍然不存在', !fs.existsSync(path.dirname(missing)), path.dirname(missing));
  }

  // ── D. 源内容：哈希 / 编码 / BOM / 换行 / 空行 / 坏行 ─────────────────
  negativeCase('hash-mismatch', fixture('happy-lf.jsonl'), 'SOURCE_HASH_MISMATCH', { sha: 'b'.repeat(64) });
  negativeCase('no-final-lf', fixture('no-final-lf.jsonl'), 'SOURCE_NO_FINAL_LF');
  negativeCase('invalid-utf8', fixture('invalid-utf8.bin'), 'SOURCE_INVALID_UTF8');
  negativeCase('bom', fixture('bom.jsonl'), 'SOURCE_HAS_BOM');
  negativeCase('zero-rows', fixture('zero-rows.jsonl'), 'ZERO_ROWS');
  negativeCase('bad-json', fixture('bad-json.jsonl'), 'ROW_JSON_INVALID', { line: 2 });
  negativeCase('not-object', fixture('not-object.jsonl'), 'ROW_NOT_OBJECT', { line: 1 });
  {
    const r = negativeCase('not-object-array', fixture('not-object-array.jsonl'), 'ROW_NOT_OBJECT', { line: 1 });
    t('[not-object-array] 消息里说清是 array', !!(r.r.receipt && /array/.test(String(r.r.receipt.message))), r.r.receipt && String(r.r.receipt.message).slice(0, 90));
  }
  negativeCase('missing-t', fixture('missing-t.jsonl'), 'ROW_FIELD_MISSING', { line: 1 });
  {
    const r = negativeCase('missing-by', fixture('missing-by.jsonl'), 'ROW_FIELD_MISSING', { line: 1 });
    t('[missing-by] 报的字段是 by', !!(r.r.receipt && r.r.receipt.detail && r.r.receipt.detail.field === 'by'), r.r.receipt && JSON.stringify(r.r.receipt.detail));
  }
  {
    const r = negativeCase('empty-by', fixture('empty-by.jsonl'), 'ROW_FIELD_INVALID', { line: 1 });
    t('[empty-by] 空署名被拒且报 by', !!(r.r.receipt && r.r.receipt.detail && r.r.receipt.detail.field === 'by'), r.r.receipt && JSON.stringify(r.r.receipt.detail));
  }
  {
    const r = negativeCase('unknown-type', fixture('unknown-type.jsonl'), 'ROW_UNKNOWN_TYPE', { line: 1 });
    t('[unknown-type] detail 带上了那个坏值', !!(r.r.receipt && r.r.receipt.detail && r.r.receipt.detail.got === 'Fact'), r.r.receipt && JSON.stringify(r.r.receipt.detail));
  }
  negativeCase('empty-body-missing', fixture('empty-body-missing.jsonl'), 'ROW_BODY_MISSING', { line: 1 });
  negativeCase('empty-body-blank', fixture('empty-body-blank.jsonl'), 'ROW_BODY_BLANK', { line: 1 });
  {
    const r = negativeCase('bad-field-byUser', fixture('bad-field.jsonl'), 'ROW_FIELD_INVALID', { line: 1 });
    t('[bad-field-byUser] 报的字段是 byUser', !!(r.r.receipt && r.r.receipt.detail && r.r.receipt.detail.field === 'byUser'), r.r.receipt && JSON.stringify(r.r.receipt.detail));
  }

  // ── E. 结构缺口：v7 库直接拒（导入器不迁移），并说清缺什么 ──────────────
  {
    const db = makeDb('v7-only', 7);
    const src = fixture('happy-lf.jsonl');
    const before = inspect(db);
    const r = runCli(['--source', src, '--sha256', shaOf(src), '--db', db]);
    const after = inspect(db);
    t('[schema] v7 库 → exit 4 / SCHEMA_DELTA_REQUIRED', r.status === 4 && r.receipt && r.receipt.code === 'SCHEMA_DELTA_REQUIRED', r.receipt && r.receipt.code);
    t('[schema] 回执说清「缺 v8」', !!(r.receipt && /migration v8/.test(String(r.receipt.message))), r.receipt && String(r.receipt.message).slice(0, 110));
    t('[schema] 回执带出结构清单（点名 mo_import_batches 与 import_batch_id）',
      typeof (r.receipt && r.receipt.detail && r.receipt.detail.requiredSchema) === 'string'
      && /mo_import_batches/.test(r.receipt.detail.requiredSchema)
      && /import_batch_id/.test(r.receipt.detail.requiredSchema),
      'len=' + String(r.receipt && r.receipt.detail && r.receipt.detail.requiredSchema).length);
    t('[schema] 计数未变（没有偷偷建表/写行）', before.ledger === after.ledger && before.batches === after.batches, 'ledger ' + before.ledger + '→' + after.ledger + ' · batches ' + before.batches + '→' + after.batches);
    t('[schema] 被拒后库里仍然没有 mo_import_batches', after.batches === -1, 'batches=' + after.batches);
    t('[schema] 被拒后库仍是 v7（导入器不迁移）', after.schemaVersion === 7, 'max(version)=' + after.schemaVersion);
  }
  {
    // v8-only：导入器要求 schema 与当前代码一致；仅有 provenance 而缺 v9-v12 仍应被拒。
    // 用裸 migrate 精确停在 v8，验证导入器不会替调用方继续迁移。
    const db = makeDb('v8-only', 8);
    const src = fixture('happy-lf.jsonl');
    const before = inspect(db);
    const r = runCli(['--source', src, '--sha256', shaOf(src), '--db', db]);
    const after = inspect(db);
    t('[schema] v8 库 → exit 4 / SCHEMA_DELTA_REQUIRED', r.status === 4 && r.receipt && r.receipt.code === 'SCHEMA_DELTA_REQUIRED', r.receipt && r.receipt.code);
    t('[schema] 回执写明「库在 v8、代码要 v12」',
      !!(r.receipt && r.receipt.detail && r.receipt.detail.schema
        && r.receipt.detail.schema.version === 8 && r.receipt.detail.schema.code === SCHEMA_VERSION),
      r.receipt && JSON.stringify(r.receipt.detail && r.receipt.detail.schema));
    t('[schema] 回执仍带出 v8 导入溯源清单（点名 mo_import_batches 与 import_batch_id）',
      typeof (r.receipt && r.receipt.detail && r.receipt.detail.requiredSchema) === 'string'
      && /mo_import_batches/.test(r.receipt.detail.requiredSchema)
      && /import_batch_id/.test(r.receipt.detail.requiredSchema),
      'len=' + String(r.receipt && r.receipt.detail && r.receipt.detail.requiredSchema).length);
    t('[schema] v8 被拒后计数未变（没有偷偷建表/写行）', before.ledger === after.ledger && before.batches === after.batches, 'ledger ' + before.ledger + '→' + after.ledger + ' · batches ' + before.batches + '→' + after.batches);
    t('[schema] v8 被拒后库仍停在 v8（导入器不迁移）', after.schemaVersion === 8, 'max(version)=' + after.schemaVersion);
    t('[schema] v8 被拒后库里没有任何 v9 ECHO 表（没有半截迁移）',
      after.exec((d) => d.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE 'echo%'").get().n) === 0,
      'echo tables=' + after.exec((d) => d.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE 'echo%'").get().n));
  }
  {
    // 比代码新：同样不写、不读、不降级。
    const db = makeDb('too-new', SCHEMA_VERSION);
    fs.existsSync(db);
    const store = openMetaStore({ path: db, mode: 'readwrite' });
    try { store.db.exec('UPDATE schema_migrations SET version = 99 WHERE version = 12'); } finally { store.close(); }
    const src = fixture('happy-lf.jsonl');
    const r = runCli(['--source', src, '--sha256', shaOf(src), '--db', db]);
    t('[schema] 比代码新的库 → SCHEMA_TOO_NEW（不降级）', r.status === 4 && r.receipt && r.receipt.code === 'SCHEMA_TOO_NEW', r.receipt && r.receipt.code);
  }

  // ── F. ★ 8 类都能入库，但历史 lead 永远不是当前权威 ──────────────────
  {
    const db = makeDb('all-8-types');
    const src = fixture('all-8-types.jsonl');
    const sha = shaOf(src);
    const srcText = fs.readFileSync(src, 'utf8');

    const dry = runCli(['--source', src, '--sha256', sha, '--db', db, '--dry-run']);
    t('[all8] --dry-run → VALIDATED 且计数未变', dry.status === 0 && dry.receipt && dry.receipt.code === 'VALIDATED' && inspect(db).ledger === 0, dry.receipt && dry.receipt.code);

    const r = runCli(['--source', src, '--sha256', sha, '--db', db]);
    t('[all8] 导入成功（含历史 lead + 历史 promise）→ exit 0 / IMPORTED', r.status === 0 && r.receipt && r.receipt.code === 'IMPORTED', r.receipt && (r.receipt.code + ' · ' + String(r.receipt.message || '').slice(0, 100)));
    const after = inspect(db);
    t('[all8] 8 行账本 + 1 个批次', after.ledger === 8 && after.batches === 1, 'ledger=' + after.ledger + ' batches=' + after.batches);
    t('[all8] 8 类各一行',
      ['lead', 'promise', 'fact', 'shelved', 'gain', 'loss', 'persona', 'container'].every((ty) => after.rows.filter((x) => x.type === ty).length === 1),
      after.rows.map((x) => x.type).join(','));
    t('[all8] 全部行的 actor_session 为 NULL（绝不从 8 字符 by 推断）', after.rows.every((x) => x.actor_session === null), JSON.stringify(after.rows.map((x) => x.actor_session)));
    t('[all8] 物理行号 = 1..8', after.rows.map((x) => Number(x.legacy_line)).join(',') === '1,2,3,4,5,6,7,8', after.rows.map((x) => x.legacy_line).join(','));
    t('[all8] 每行都挂了同一个 import_batch_id（且指向唯一的那个批次）', (() => {
      const ids = new Set(after.rows.map((x) => Number(x.import_batch_id)));
      if (ids.size !== 1 || ids.has(0)) return false;
      const bid = [...ids][0];
      const known = after.exec((d) => d.prepare('SELECT 1 AS x FROM mo_import_batches WHERE batch_id = ?').get(bid));
      return !!known && after.batches === 1;
    })(), after.rows.map((x) => x.import_batch_id).join(','));
    const srcLines = srcText.split('\n'); srcLines.pop();
    t('[all8] 每行 legacy_raw 逐字节等于源文件那一行', after.rows.every((x) => String(x.legacy_raw) === srcLines[Number(x.legacy_line) - 1]), 'mismatch=' + after.rows.filter((x) => String(x.legacy_raw) !== srcLines[Number(x.legacy_line) - 1]).length);
    t('[all8] 导入前后当前权威不变（回执自证）',
      !!(r.receipt && r.receipt.authority && JSON.stringify(r.receipt.authority.before) === JSON.stringify(r.receipt.authority.after)),
      JSON.stringify(r.receipt && r.receipt.authority));
    t('[all8] 源文件哈希前后一致（导入不改源）', sha === shaOf(src), sha.slice(0, 12));

    // ★★ 边界一：store 的三个权威读口都不认历史 lead。
    const store = openMetaStore({ path: db, mode: 'readwrite' });
    try {
      t('[all8] store.latestLead() 不返回历史 lead', store.latestLead() === null, JSON.stringify(store.latestLead()));
      t('[all8] store.ledgerStats().latestLead 为 null', store.ledgerStats().latestLead === null, store.ledgerStats().latestLead);
      t('[all8] 8 行**都还在**（没被过滤掉，只是不当权威）', store.ledgerStats().total === 8, store.ledgerStats().total);
      const leadRow = store.listLedger({ type: 'lead' })[0];
      t('[all8] listLedger 仍能读出历史 lead 行（历史可读、不可当权）', !!leadRow && leadRow.type === 'lead' && leadRow.importBatchId === after.batches, JSON.stringify(leadRow && [leadRow.type, leadRow.importBatchId]));
      // 历史 lead 的 actor_session 是 NULL ⇒ 拿它的 by 去写承诺必须被拒。
      let err = null;
      try { store.appendLedger({ type: 'promise', text: '历史会话想写承诺' }, { sessionId: 'session-11112222-1111-2222-3333-444444444444' }); } catch (e) { err = e; }
      t('[all8] 历史 lead 的会话写 promise 被拒（闸门没被导入绕过）', !!err && /MO_NO_LEAD/.test(String(err.message)), err && err.code + ' · ' + String(err.message).slice(0, 80));
      t('[all8] ledgerTypes 仍是 8 类', store.ledgerTypes().length === 8);
    } finally {
      store.close();
    }

    // ★★ 边界二：organs/ledger（JSONL 形态）的 currentLead 也不认导入行。
    const jsonl = assertTempPath(path.join(ROOT, 'organ-ledger.jsonl'));
    fs.writeFileSync(assertTempPath(jsonl), [
      JSON.stringify({ t: '2026-11-01T00:00:00+08:00', type: 'lead', by: 'live0001', text: '第 1 代 · 本机写入的 lead', ref: 'fixture:live' }),
      JSON.stringify({ t: '2026-11-02T00:00:00+08:00', type: 'lead', by: 'old00002', text: '第 2 代 · 从旧账本导入的 lead', ref: 'fixture:old', import_batch_id: 1, legacy_line: 2, legacy_raw: '...' }),
      JSON.stringify({ t: '2026-11-03T00:00:00+08:00', type: 'fact', by: 'old00002', text: '历史事实' }),
    ].join('\n') + '\n', 'utf8');
    const organ = new LedgerBase(jsonl);
    t('[all8] organs currentLead() 跳过导入行 → live0001', normId(organ.currentLead()) === 'live0001', organ.currentLead());
    t('[all8] organs isBrain(live) 为 true', organ.isBrain('session-live0001') === true);
    t('[all8] organs isBrain(历史 lead 的会话) 为 false', organ.isBrain('old00002') === false);
    t('[all8] organs stats().lead 也是 live0001', normId(organ.stats().lead) === 'live0001', organ.stats().lead);
    t('[all8] organs 仍能列出两条 lead（历史不隐藏）', organ.list({ type: 'lead' }).length === 2, organ.list({ type: 'lead' }).length);
    t('[all8] organs 器官写 promise 仍被拒', organ.write({ type: 'promise', text: 'x', by: 'old00002' }).code === 'NOT_BRAIN');
    t('[all8] organs 本机 lead 写 promise 仍允许', organ.write({ type: 'promise', text: '本机承诺', by: 'session-live0001' }).ok === true);

    // ★★ 边界三：同库再导入一个源（行号重叠）—— v8 之后必须成功。
    const second = fixture('happy-crlf.jsonl');
    const r2 = runCli(['--source', second, '--sha256', shaOf(second), '--db', db]);
    t('[multi] 第二个源（行号与第一份重叠）→ exit 0 / IMPORTED', r2.status === 0 && r2.receipt && r2.receipt.code === 'IMPORTED', r2.receipt && (r2.receipt.code + ' · ' + String(r2.receipt.message || '').slice(0, 90)));
    const after2 = inspect(db);
    t('[multi] 8 + 5 = 13 行、2 个批次', after2.ledger === 13 && after2.batches === 2, 'ledger=' + after2.ledger + ' batches=' + after2.batches);
    t('[multi] 两份源的行号确实重叠（1..6 vs 1,3,4,5,7,8,9）',
      after2.rows.filter((x) => Number(x.import_batch_id) === 1).map((x) => Number(x.legacy_line)).join(',') === '1,2,3,4,5,6,7,8'
      && after2.rows.filter((x) => Number(x.import_batch_id) === 2).map((x) => Number(x.legacy_line)).join(',') === '1,2,4,5,6',
      'b1=' + after2.rows.filter((x) => Number(x.import_batch_id) === 1).map((x) => x.legacy_line).join(',')
      + ' b2=' + after2.rows.filter((x) => Number(x.import_batch_id) === 2).map((x) => x.legacy_line).join(','));
    t('[multi] 每份源内部行号仍然唯一', (() => {
      for (const bid of [1, 2]) {
        const lines = after2.rows.filter((x) => Number(x.import_batch_id) === bid).map((x) => Number(x.legacy_line));
        if (new Set(lines).size !== lines.length) return false;
      }
      return true;
    })());
    t('[multi] 历史 lead 仍然不是当前权威（两份源都没换掉主导）', (() => {
      const s = openMetaStore({ path: db, mode: 'readwrite' });
      try { return s.latestLead() === null && s.ledgerStats().latestLead === null; } finally { s.close(); }
    })());

    // ★★ 边界四：同一份源不许导入第二次（库层 UNIQUE(source_sha256)）。
    const dup = runCli(['--source', src, '--sha256', sha, '--db', db]);
    const afterDup = inspect(db);
    t('[multi] 同一 SHA 二次导入 → DUPLICATE_SOURCE_SHA', dup.status === 3 && dup.receipt && dup.receipt.code === 'DUPLICATE_SOURCE_SHA', dup.receipt && dup.receipt.code);
    t('[multi] 重复被拒后计数未变', afterDup.ledger === 13 && afterDup.batches === 2, 'ledger=' + afterDup.ledger + ' batches=' + afterDup.batches);

    // ★★ 边界五：UNIQUE(batch,line) 是真的 —— 同一批同一行插不进去。
    const dupLine = after2.exec((d) => {
      try {
        d.prepare([
          'INSERT INTO mo_ledger (t,type,text,by,actor_session,ref,feel,by_user,legacy_line,legacy_raw,import_batch_id)',
          "VALUES ('x','fact','dup line','1',NULL,NULL,NULL,0,1,'raw',1)",
        ].join(' ')).run();
        return 'ALLOWED';
      } catch (e) { return String(e.message); }
    });
    t('[multi] UNIQUE(import_batch_id, legacy_line) 挡住同批重复行', /UNIQUE constraint failed/.test(dupLine) && /import_batch_id/.test(dupLine), dupLine.slice(0, 90));

    // ★★ 边界六：**非导入**（显式 raw SQL）的 lead 才成为 live lead。
    insertLiveLead(db, '第 1 代 · 接手于 2026-11-14');
    const live = openMetaStore({ path: db, mode: 'readwrite' });
    try {
      t('[live] raw SQL 写入的非导入 lead 成为 latestLead', !!live.latestLead() && live.latestLead().by === LIVE_LEAD_SESSION.slice(8, 16), JSON.stringify(live.latestLead()));
      t('[live] ledgerStats().latestLead 同步', live.ledgerStats().latestLead === LIVE_LEAD_SESSION.slice(8, 16), live.ledgerStats().latestLead);
      t('[live] 仍能安全 appendLedger fact', (() => { try { live.appendLedger({ type: 'fact', text: 'live lead 写的事实' }, { sessionId: LIVE_LEAD_SESSION }); return true; } catch (e) { return String(e.message); } })() === true);
      // ★ 调用方**永远**不能自带 import_batch_id：这是导入器的溯源列，不是写入方的字段。
      for (const field of ['import_batch_id', 'importBatchId']) {
        let spoof = null;
        try { live.appendLedger({ type: 'fact', text: '冒充历史行', [field]: 1 }, { sessionId: LIVE_LEAD_SESSION }); } catch (e) { spoof = e; }
        t('[live] appendLedger 拒收调用方自带的 ' + field, !!spoof && spoof.code === 'INVALID_INPUT' && /import provenance/.test(String(spoof.message)), spoof && spoof.code + ' · ' + String(spoof.message).slice(0, 80));
      }
      t('[live] 被拒之后账本没有多出「冒充」的行',
        live.db.prepare("SELECT COUNT(*) AS n FROM mo_ledger WHERE text = '冒充历史行'").get().n === 0);
      // promise 闸门：本机 lead 可以，历史 lead（actor_session NULL / 别的 UUID）不行。
      const p = live.appendLedger({ type: 'promise', text: '本机承诺' }, { sessionId: LIVE_LEAD_SESSION });
      t('[live] promise 闸门对**本机** lead 放行（gate 没被 v8 改松）', p.type === 'promise' && p.actorSession === LIVE_LEAD_ACTOR, JSON.stringify([p.type, p.actorSession]));
      let delegated = null;
      try { live.appendLedger({ type: 'promise', text: '历史会话的承诺' }, { sessionId: 'session-' + HISTORICAL_ACTOR }); } catch (e) { delegated = e; }
      t('[live] promise 闸门对**别的**会话照旧拒（MO_NOT_CURRENT_LEAD）', !!delegated && /MO_NOT_CURRENT_LEAD/.test(String(delegated.message)), delegated && String(delegated.message).slice(0, 80));
      // 导入行仍然不是权威 —— 历史 lead 的 by 甚至不在任何 actor_session 里。
      const histLead = live.db.prepare("SELECT by FROM mo_ledger WHERE type='lead' AND import_batch_id IS NOT NULL LIMIT 1").get();
      t('[live] 历史 lead 行仍在库里（可回查）', !!histLead && histLead.by === '11112222', histLead && histLead.by);
      t('[live] 但 latestLead 仍是本机那条', live.latestLead().by === LIVE_LEAD_SESSION.slice(8, 16));
    } finally { live.close(); }

    // 只追加：批次行不可改、不可删。
    const upd = after.exec((db2) => { try { db2.prepare('UPDATE mo_import_batches SET rows_imported = 99').run(); return 'updated'; } catch (e) { return String(e.message); } });
    t('[all8] 批次行被 append-only 触发器挡住', /MO_IMPORT_BATCH_APPEND_ONLY/.test(upd), upd.slice(0, 60));
  }

  // ── G. 正路（LF）：7 类都导得进去，且按原值语义 ───────────────────────
  {
    const db = makeDb('happy-lf');
    const src = fixture('happy-lf.jsonl');
    const shaBefore = shaOf(src);
    const srcText = fs.readFileSync(src, 'utf8');
    const before = inspect(db);
    const r = runCli(['--source', src, '--sha256', shaBefore, '--db', db]);
    t('[happy] 导入成功', r.status === 0 && r.receipt && r.receipt.code === 'IMPORTED', r.receipt && r.receipt.code);
    const after = inspect(db);
    t('[happy] 7 行账本 + 1 个批次', after.ledger === 7 && after.batches === 1, 'ledger=' + after.ledger + ' batches=' + after.batches);
    t('[happy] 源文件哈希前后一致', shaBefore === shaOf(src), shaBefore.slice(0, 12));

    const batch = after.exec((db2) => db2.prepare('SELECT * FROM mo_import_batches').get()) || {};
    t('[happy] 批次记下源路径/SHA/字节/物理行/空行/行数/importer 版本',
      batch.source_sha256 === shaBefore && Number(batch.source_bytes) === fs.statSync(src).size
      && Number(batch.physical_lines) === 9 && Number(batch.blank_lines) === 2 && Number(batch.rows_imported) === 7
      && String(batch.importer) === 'mo-ledger-import/2',
      JSON.stringify({ sha: String(batch.source_sha256).slice(0, 12), bytes: Number(batch.source_bytes), physical: Number(batch.physical_lines), blank: Number(batch.blank_lines), rows: Number(batch.rows_imported), importer: batch.importer }));

    t('[happy] 全部 7 行 actor_session 为 NULL', after.rows.every((x) => x.actor_session === null), JSON.stringify(after.rows.map((x) => x.actor_session)));
    t('[happy] by 原值保留（8 字符 / unknown 都不改写）',
      after.rows.map((x) => x.by).join(',') === '03ee7b55,03ee7b55,9b8f7775,unknown,03ee7b55,03ee7b55,0f11aa22',
      after.rows.map((x) => x.by).join(','));
    t('[happy] 物理行号 = [1,3,4,5,7,8,9]（空行计数、跳过、但占号）',
      after.rows.map((x) => Number(x.legacy_line)).join(',') === '1,3,4,5,7,8,9', after.rows.map((x) => x.legacy_line).join(','));
    t('[happy] 插入顺序与文件行序一致（row_id 递增 = legacy_line 递增）',
      after.rows.map((x) => Number(x.legacy_line)).every((v, i, a) => i === 0 || a[i - 1] < v), 'ok');
    t('[happy] text 形状正文原样入库', after.rows[1].text === '旧仓里 text 形状的事实行', JSON.stringify(after.rows[1].text));
    t('[happy] 概要 形状正文原样入库（同一列）', after.rows[2].text === '旧仓里 概要 形状的搁置行', JSON.stringify(after.rows[2].text));
    t('[happy] t 原值保留（含 +08:00 偏移，不转 UTC）', after.rows[0].t === '2026-09-26T10:00:00+08:00', after.rows[0].t);
    t('[happy] ref / feel 缺省为 NULL，有值原样', after.rows[0].ref === '爀曦 2026-09-25 说：你是主导' && after.rows[1].ref === null && after.rows[4].feel === '有点沉', JSON.stringify([after.rows[0].ref, after.rows[1].ref, after.rows[4].feel]));
    t('[happy] byUser true → 1，其余 0', after.rows.map((x) => Number(x.by_user)).join(',') === '0,0,0,0,0,1,0', after.rows.map((x) => x.by_user).join(','));
    const srcLines = srcText.split('\n');
    srcLines.pop();
    const rawMismatch = after.rows.filter((x) => String(x.legacy_raw) !== srcLines[Number(x.legacy_line) - 1]);
    t('[happy] 每一行的 legacy_raw 逐字节等于源文件那一物理行（含空行占号）',
      rawMismatch.length === 0 && srcLines.length === 9, 'mismatch=' + rawMismatch.length + ' · srcLines=' + srcLines.length);
    t('[happy] 空行没有入库（只计数）', after.rows.length === 7 && srcLines[1] === '' && srcLines[5] === '   ', JSON.stringify([srcLines[1], srcLines[5]]));
    // 起点就是当前 schema；完整迁移史逐条不变，证明导入器没有迁移或改写 checksum。
    t('[happy] 导入器没迁移、没改版本（库本来就是 v12）',
      after.schemaVersion === SCHEMA_VERSION
      && before.schemaVersion === SCHEMA_VERSION
      && before.migrations.length === SCHEMA_VERSION
      && after.migrations.length === SCHEMA_VERSION
      && JSON.stringify(after.migrations) === JSON.stringify(before.migrations),
      'max(version)=' + after.schemaVersion + ' · migrations=' + after.migrations.length + '/' + SCHEMA_VERSION
      + ' · unchanged=' + (JSON.stringify(after.migrations) === JSON.stringify(before.migrations)));
  }

  // ── H. CRLF + 空行：raw 连 CR 一起留，重建仍是逐字节 ─────────────────
  {
    const db = makeDb('happy-crlf');
    const src = fixture('happy-crlf.jsonl');
    const sha = shaOf(src);
    const srcBytes = fs.readFileSync(src);
    const srcText = srcBytes.toString('utf8');
    const r = runCli(['--source', src, '--sha256', sha, '--db', db]);
    t('[crlf] 导入成功', r.status === 0 && r.receipt && r.receipt.code === 'IMPORTED', r.receipt && r.receipt.code);
    const after = inspect(db);
    t('[crlf] 6 物理行 / 1 空行 / 5 行入库', after.ledger === 5
      && Number(after.exec((d) => d.prepare('SELECT physical_lines AS p FROM mo_import_batches').get().p)) === 6
      && Number(after.exec((d) => d.prepare('SELECT blank_lines AS b FROM mo_import_batches').get().b)) === 1, 'ledger=' + after.ledger);
    t('[crlf] legacy_line = [1,2,4,5,6]', after.rows.map((x) => Number(x.legacy_line)).join(',') === '1,2,4,5,6', after.rows.map((x) => x.legacy_line).join(','));
    t('[crlf] legacy_raw 保留 CR（字节保真，不悄悄去掉）', after.rows.every((x) => String(x.legacy_raw).endsWith('\r')), JSON.stringify(after.rows.map((x) => String(x.legacy_raw).slice(-3))));
    const srcLines = srcText.split('\n');
    srcLines.pop();
    const rawMismatch = after.rows.filter((x) => String(x.legacy_raw) !== srcLines[Number(x.legacy_line) - 1]);
    t('[crlf] 每一行 legacy_raw 逐字节等于源文件那一物理行（CR 也在内）', rawMismatch.length === 0 && srcLines.length === 6, 'mismatch=' + rawMismatch.length);
    t('[crlf] 每行补回 LF 后可重放该行原始字节', Buffer.compare(Buffer.from(after.rows[0].legacy_raw + '\n', 'utf8'), srcBytes.subarray(0, Buffer.byteLength(after.rows[0].legacy_raw) + 1)) === 0, 'line1');
    t('[crlf] 正文里没有残留 CR', after.rows.every((x) => String(x.text).indexOf('\r') === -1), JSON.stringify(after.rows.map((x) => x.text)));
    t('[crlf] source hash 前后一致', sha === shaOf(src), sha.slice(0, 12));
  }

  // ── I. 原子性：写行阶段失败 ⇒ 整批回滚（批次行也不留）────────────────
  {
    const db = makeDb('atomic');
    const pristine = inspect(db);
    // 用一个临时库里的临时触发器把第 4 物理行打断（不是改生产 schema，只是造一个失败点）。
    const store = openMetaStore({ path: db, mode: 'readwrite' });
    try {
      store.db.exec("CREATE TRIGGER probe_fail BEFORE INSERT ON mo_ledger WHEN NEW.legacy_line = 4 BEGIN SELECT RAISE(ABORT, 'PROBE_FAIL'); END;");
    } finally { store.close(); }
    const src = fixture('happy-lf.jsonl');
    const r = runCli(['--source', src, '--sha256', shaOf(src), '--db', db]);
    const after = inspect(db);
    t('[atomic] 行写入失败 → exit 6 / IMPORT_WRITE_FAILED', r.status === 6 && r.receipt && r.receipt.code === 'IMPORT_WRITE_FAILED', r.receipt && (r.receipt.code + ' · ' + String(r.receipt.message).slice(0, 80)));
    t('[atomic] 失败原因被原样带出（PROBE_FAIL）', !!(r.receipt && /PROBE_FAIL/.test(String(r.receipt.message))), r.receipt && String(r.receipt.message).slice(0, 90));
    t('[atomic] 账本 0 行、批次 0 行（批次凭据也回滚了）', after.ledger === pristine.ledger && after.batches === 0, 'ledger=' + after.ledger + ' batches=' + after.batches);
  }

  // ── J. v7 → v12：保留 v7 起点与 v1–v7 历史，覆盖 v8-v12 实际迁移 ──
  {
    const db = makeDb('migrate-v7-v12', 7);
    const digestsV1to7 = MIGRATIONS.slice(0, 7).map(migrationDigest);
    const store = openMetaStore({ path: db, mode: 'readwrite' });
    let beforeRows = null;
    let beforeSeq = null;
    try {
      t('[migrate] 起点是 v7 且不 ready', store.state.current === 7 && store.state.ready === false, 'current=' + store.state.current);
      const ins = store.db.prepare('INSERT INTO mo_ledger (t,type,text,by,actor_session,ref,feel,by_user) VALUES (?,?,?,?,?,?,?,?)');
      ins.run('2026-11-01T00:00:00.000Z', 'lead', '第 3 代 · 迁移前的本机 lead', 'aaaa1111', LIVE_LEAD_ACTOR, 'fixture:owner', '稳', 0);
      ins.run('2026-11-02T00:00:00.000Z', 'promise', '迁移前的承诺', 'aaaa1111', LIVE_LEAD_ACTOR, null, null, 0);
      ins.run('2026-11-03T00:00:00.000Z', 'fact', '迁移前的事实', 'bbbb2222', null, null, null, 0);
      beforeRows = store.db.prepare('SELECT * FROM mo_ledger ORDER BY row_id').all();
      beforeSeq = store.db.prepare('SELECT name, seq FROM sqlite_sequence').all();
    } finally { store.close(); }

    const up = openMetaStore({ path: db, mode: 'readwrite' });
    let applied = null;
    try {
      applied = up.migrate().applied.map((m) => m.version);
      t('[migrate] v7 起点逐项应用 v8-v12（v1-v7 不重跑）', JSON.stringify(applied) === '[8,9,10,11,12]', JSON.stringify(applied));
      t('[migrate] 迁移后 ready 且为 v12', up.state.ready === true && up.state.current === 12, 'current=' + up.state.current);
      const expectedV8to12 = MIGRATIONS.slice(7).map(migrationDigest);
      const checksumsV8to12 = up.db.prepare('SELECT checksum FROM schema_migrations WHERE version >= 8 ORDER BY version').all();
      t('[migrate] v8-v12 逐版本 checksum 对应当前迁移 SQL',
        checksumsV8to12.length === 5 && checksumsV8to12.every((row, i) => row.checksum === expectedV8to12[i]),
        checksumsV8to12.map((row, i) => (i + 8) + ':' + String(row.checksum).slice(0, 8)).join(' '));
      const hasTable = (name) => !!up.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
      const hasIndex = (name) => !!up.db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(name);
      t('[migrate] v9 派生索引表/FTS 与 v10 长文本向量结构存在',
        ['echo_index_sources','echo_words','echo_summaries','echo_summary_src_seqs','echo_source_builds','echo_words_fts','echo_summaries_fts','echo_vector_models','echo_word_vectors'].every(hasTable)
          && hasIndex('idx_echo_word_vectors_model'), 'v9/v10 tables present');
      t('[migrate] v11 builds 审计表无 source FK 且保留 append-only triggers',
        up.db.prepare('PRAGMA foreign_key_list(echo_source_builds)').all().length === 0
          && ['echo_source_builds_no_update','echo_source_builds_no_delete'].every((name) => !!up.db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name)), 'foreign keys=' + up.db.prepare('PRAGMA foreign_key_list(echo_source_builds)').all().length);
      const windowColumns = up.db.prepare('PRAGMA table_info(echo_word_windows)').all().map((row) => row.name);
      t('[migrate] v12 句子窗口向量字段/索引存在（独立于长文本向量）',
        ['window_ord','char_start','char_end','window_text_sha256','source_content_hash','vector_blob'].every((name) => windowColumns.includes(name))
          && hasIndex('echo_word_windows_by_source_model')
          && hasTable('echo_word_vectors'), windowColumns.join(','));
      const checksums = up.db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all();
      t('[migrate] v1–v7 摘要逐位不变（历史只读）',
        checksums.slice(0, 7).every((row, i) => row.checksum === digestsV1to7[i]),
        checksums.slice(0, 7).map((r) => r.version + ':' + r.checksum.slice(0, 6)).join(' '));
      const afterRows = up.db.prepare('SELECT * FROM mo_ledger ORDER BY row_id').all().map((r) => {
        const c = Object.assign({}, r);
        delete c.import_batch_id;    // 新增列：旧行一律 NULL
        return c;
      });
      t('[migrate] 旧数据逐行逐字段不变（row_id 也在内）', JSON.stringify(afterRows) === JSON.stringify(beforeRows), 'rows=' + afterRows.length);
      t('[migrate] 旧行 import_batch_id 全为 NULL',
        up.db.prepare('SELECT COUNT(*) AS n FROM mo_ledger WHERE import_batch_id IS NOT NULL').get().n === 0);
      t('[migrate] 旧行的 append-only 触发器仍在',
        (() => { try { up.db.prepare('UPDATE mo_ledger SET text=? WHERE row_id=1').run('x'); return false; } catch (e) { return /MO_APPEND_ONLY/.test(String(e.message)); } })());
      t('[migrate] 当前主导仍是迁移前那条（迁移没换人）', !!up.latestLead() && up.latestLead().by === 'aaaa1111', JSON.stringify(up.latestLead()));
      const seq = up.db.prepare('SELECT name, seq FROM sqlite_sequence').all();
      t('[migrate] v11 rebuild 后 sqlite_sequence 保留 mo_ledger 并新增 builds 序列',
        seq.find((x) => x.name === 'mo_ledger')?.seq === 3
          && seq.find((x) => x.name === 'echo_source_builds')?.seq === 0, JSON.stringify(seq));
      // 迁移后 legacy_line 的全局 UNIQUE 必须已经消失：两批可以各有第 1 行。
      up.db.prepare("INSERT INTO mo_import_batches (source_path,source_sha256,source_bytes,physical_lines,blank_lines,rows_imported,imported_at,importer) VALUES ('p1',?,10,1,0,1,'now','probe')").run('1'.repeat(64));
      const b1 = Number(up.db.prepare("SELECT batch_id FROM mo_import_batches WHERE source_path='p1'").get().batch_id);
      up.db.prepare("INSERT INTO mo_import_batches (source_path,source_sha256,source_bytes,physical_lines,blank_lines,rows_imported,imported_at,importer) VALUES ('p2',?,10,1,0,1,'now','probe')").run('2'.repeat(64));
      const b2 = Number(up.db.prepare("SELECT batch_id FROM mo_import_batches WHERE source_path='p2'").get().batch_id);
      const insImp = up.db.prepare('INSERT INTO mo_ledger (t,type,text,by,actor_session,by_user,legacy_line,legacy_raw,import_batch_id) VALUES (?,?,?,?,NULL,0,?,?,?)');
      let legacyUniqueGone = true;
      try { insImp.run('h', 'fact', 'batch1 line1', '1', 1, 'r', b1); insImp.run('h', 'fact', 'batch2 line1', '1', 1, 'r', b2); } catch (e) { legacyUniqueGone = String(e.message); }
      t('[migrate] legacy_line 的全局 UNIQUE 已消失（两批各有第 1 行）', legacyUniqueGone === true, legacyUniqueGone);
      // 历史 lead 行（迁移后导入）不改变当前权威。
      insImp.run('h', 'lead', '历史主导（不带 ref/代次）', 'cccc3333', 2, 'raw', b2);
      t('[migrate] 迁移后导入的历史 lead 不改变 latestLead', up.latestLead().by === 'aaaa1111', JSON.stringify(up.latestLead()));
      t('[migrate] ledgerStats().latestLead 同口径', up.ledgerStats().latestLead === 'aaaa1111', up.ledgerStats().latestLead);
    } finally { up.close(); }
  }
}

let thrown = null;
try { main(); } catch (err) { thrown = err; }
if (thrown) t('自检本身没抛异常', false, thrown && thrown.stack ? thrown.stack.split('\n').slice(0, 5).join(' | ') : String(thrown));

console.log('');
console.log('=== 墨 JSONL 导入器自检 v12（临时目录：' + ROOT + '）===');
console.log('');
console.log(ok.join('\n'));
if (bad.length) { console.log(''); console.log(bad.join('\n')); }
console.log('');
console.log(ok.length + ' 通过 / ' + bad.length + ' 失败');

try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* 保留现场以便排查 */ }
console.log('临时目录已清理: ' + !fs.existsSync(ROOT));
process.exit(bad.length ? 1 : 0);
