// src/db/migrate.mjs —— 显式迁移。open 不自动迁移；调用方要么传 migrateOnOpen: true，
// 要么自己调 store.migrate()。只读连接永远不迁移（它连 CREATE TABLE 都做不了）。
//
// 四条硬规矩：
//   1. 已应用迁移的 sql 文本被改过 → MIGRATION_CHECKSUM_MISMATCH（不静默重跑）。
//   2. 库里的版本高于代码知道的版本 → SCHEMA_TOO_NEW（不降级、不猜）。
//      ★ 读路径与写路径同判：readSchemaState 带出 tooNew，store.ensureReady 先看它。
//   3. 迁移史必须从 1 连续到 current（O1）→ 缺行就 MIGRATION_HISTORY_BROKEN，
//      ready 不再只看「最后一行」；空手删掉 v1 行不会让库「看起来正常」。
//   4. 旧库里的非法行先验后迁（O2）→ LEGACY_CONSTRAINT_VIOLATION，绝不原样带入新库。
//   一批迁移在一个事务里跑完，任何一步失败整批回滚（含 v3 的 JS 补丁）。

import { engineInfo } from './engine.mjs';
import { BOOTSTRAP_SQL, MIGRATIONS, SCHEMA_VERSION, migrationDigest } from './schema.mjs';
import { fail, CODES, isMetaStoreError } from './errors.mjs';

const INSERT_MIGRATION_SQL = [
  'INSERT INTO schema_migrations (version, name, checksum, applied_at, node_version, sqlite_version)',
  'VALUES (?, ?, ?, ?, ?, ?)',
].join(' ');

function tableExists(db, name) {
  return db.prepare("select 1 as x from sqlite_master where type = 'table' and name = ?").get(name) !== undefined;
}

function expectedVersions() {
  const out = [];
  for (let v = 1; v <= SCHEMA_VERSION; v += 1) out.push(v);
  return out;
}

// O1：迁移史 = 已应用版本必须恰好是 1..rows.length（按 version 升序读出来的）。
function describeHistory(rows) {
  const versions = rows.map(function (r) { return r.version; });
  let contiguous = true;
  for (let i = 0; i < versions.length; i += 1) {
    if (versions[i] !== i + 1) { contiguous = false; break; }
  }
  const expected = expectedVersions();
  const missing = expected.filter(function (v) { return versions.indexOf(v) === -1; });
  const extra = versions.filter(function (v) { return v > SCHEMA_VERSION; });
  return { versions, contiguous, expected, missing, extra };
}

function emptyHistoryState() {
  return {
    ready: false,
    tooNew: false,
    current: 0,
    applied: [],
    expected: SCHEMA_VERSION,
    historyBroken: false,
    history: Object.assign(describeHistory([]), { emptyHistoryWithTables: false }),
  };
}

export function readSchemaState(db) {
  if (!tableExists(db, 'schema_migrations')) return emptyHistoryState();
  const rows = db
    .prepare('select version, name, checksum, applied_at, node_version, sqlite_version from schema_migrations order by version')
    .all();
  const history = describeHistory(rows);
  const current = rows.length ? rows[rows.length - 1].version : 0;
  // 库比代码新：读和写都必须报 SCHEMA_TOO_NEW，而不是"去迁移"（migrate 会拒绝降级）。
  const tooNew = current > SCHEMA_VERSION;
  // 迁移史被删空、但核心表还在 —— 这不是新库，是历史丢了。
  const emptyHistoryWithTables = rows.length === 0 && tableExists(db, 'sources');
  const historyBroken = rows.length > 0 ? !history.contiguous : emptyHistoryWithTables;
  return {
    ready: !tooNew && !historyBroken && history.contiguous && current === SCHEMA_VERSION,
    tooNew,
    current,
    applied: rows.map(function (r) {
      return { version: r.version, name: r.name, checksum: r.checksum, appliedAt: r.applied_at, nodeVersion: r.node_version, sqliteVersion: r.sqlite_version };
    }),
    expected: SCHEMA_VERSION,
    historyBroken,
    history: Object.assign({}, history, { emptyHistoryWithTables }),
  };
}

// O2：旧库（v1，触发器只约束新写）可能塞着非法行。迁移前先验证，绝不原样带入新库。
// 校验的是 v2 起由触发器保证的那两组不变量：
//   sources: namespace='log' <=> (kind='dsh-log' 且 authority='primary')
//   frame_index.authority 必须等于所属 source 的 authority
function assertNoLegacyConstraintViolations(db) {
  if (!tableExists(db, 'sources')) return;
  const badSources = db.prepare([
    'select source_id, namespace, kind, authority from sources where',
    "  (namespace = 'log' and (kind <> 'dsh-log' or authority <> 'primary'))",
    "  or (namespace <> 'log' and authority = 'primary')",
  ].join(' ')).all();
  if (badSources.length > 0) {
    fail(CODES.LEGACY_CONSTRAINT_VIOLATION,
      'legacy sources violate the log-namespace invariant; refusing to migrate them into the new schema',
      { invariant: "namespace='log' <=> (kind='dsh-log' and authority='primary')", violations: badSources });
  }
  if (!tableExists(db, 'frame_index')) return;
  const badFrames = db.prepare([
    'select f.source_id, f.session_id, f.seq, f.ptr, f.authority, s.authority as source_authority',
    'from frame_index f join sources s on s.source_id = f.source_id',
    'where f.authority <> s.authority',
  ].join(' ')).all();
  if (badFrames.length > 0) {
    fail(CODES.LEGACY_CONSTRAINT_VIOLATION,
      'legacy frames have an authority that disagrees with their source; refusing to migrate them',
      { invariant: 'frame_index.authority = sources.authority', violations: badFrames });
  }
}

export function migrate(db, options) {
  const o = options || {};
  const migrations = (o.migrations || MIGRATIONS).slice().sort(function (a, b) { return a.version - b.version; });
  const now = o.now || new Date().toISOString();
  const engine = o.engine || engineInfo();
  const expectedVersion = o.targetVersion || SCHEMA_VERSION;

  for (let i = 1; i < migrations.length; i += 1) {
    if (migrations[i].version === migrations[i - 1].version) {
      fail(CODES.MIGRATION_FAILED, 'duplicate migration version ' + migrations[i].version, { version: migrations[i].version });
    }
  }

  db.exec(BOOTSTRAP_SQL);

  const appliedRows = db
    .prepare('select version, name, checksum, applied_at from schema_migrations order by version')
    .all();

  const known = new Map();
  for (const m of migrations) known.set(m.version, m);

  // 先做「库比代码新」与 checksum 判定，保持原有报错优先级（T14/T21）。
  for (const row of appliedRows) {
    if (row.version > expectedVersion) {
      fail(CODES.SCHEMA_TOO_NEW, 'database schema v' + row.version + ' is newer than code v' + expectedVersion, { version: row.version, expected: expectedVersion });
    }
    const m = known.get(row.version);
    if (!m) {
      fail(CODES.MIGRATION_CHECKSUM_MISMATCH, 'schema_migrations has v' + row.version + ' which no longer exists in code', { version: row.version });
    }
    const digest = migrationDigest(m);
    if (digest !== row.checksum) {
      fail(CODES.MIGRATION_CHECKSUM_MISMATCH, 'checksum mismatch for migration v' + row.version + ' (' + (row.name || m.name) + '): db has ' + row.checksum + ', code computes ' + digest, { version: row.version, stored: row.checksum, computed: digest });
    }
  }

  // O1：迁移史必须连续完整。只删 v1 行、留下 v2 的库在这里就被拒（读路径也一样）。
  const history = describeHistory(appliedRows);
  if (!history.contiguous) {
    fail(CODES.MIGRATION_HISTORY_BROKEN,
      'schema_migrations is not contiguous: applied versions [' + history.versions.join(', ') + '] do not match 1..' + history.versions.length,
      { applied: history.versions, missing: history.expected.filter(function (v) { return history.versions.indexOf(v) === -1; }), expected: history.expected });
  }
  if (appliedRows.length === 0 && tableExists(db, 'sources')) {
    fail(CODES.MIGRATION_HISTORY_BROKEN,
      'schema_migrations is empty but the core tables already exist; the migration history was lost, not never applied',
      { applied: [], expected: history.expected });
  }

  const appliedVersions = new Set(appliedRows.map(function (r) { return r.version; }));
  const pending = migrations.filter(function (m) { return !appliedVersions.has(m.version); });

  if (pending.length === 0) {
    return { applied: [], current: appliedRows.length ? appliedRows[appliedRows.length - 1].version : 0, engine, postSteps: [] };
  }

  // O2：动任何 DDL 之前先把旧库里的非法行验清楚；失败时整批不执行，库留在原版本。
  assertNoLegacyConstraintViolations(db);

  db.exec('BEGIN IMMEDIATE');
  const postSteps = [];
  try {
    const insert = db.prepare(INSERT_MIGRATION_SQL);
    for (const m of pending) {
      try {
        db.exec(m.sql);
      } catch (err) {
        fail(CODES.MIGRATION_FAILED, 'migration v' + m.version + ' (' + m.name + ') failed: ' + err.message, { version: m.version, name: m.name });
      }
      // 迁移可以带一个 JS 补丁（v3 的 raw_rel_path 归一）。它和 SQL 在同一个事务里，
      // 失败就整批回滚；它用的归一函数与运行时 ingest 是同一份（locator.relToSource）。
      if (typeof m.after === 'function') {
        let effect;
        try {
          effect = m.after(db);
        } catch (err) {
          if (isMetaStoreError(err)) throw err;
          fail(CODES.MIGRATION_FAILED, 'migration v' + m.version + ' (' + m.name + ') post-step failed: ' + err.message, { version: m.version, name: m.name });
        }
        postSteps.push({ version: m.version, name: m.name, result: effect === undefined ? null : effect });
      }
      // 每条迁移都记自己的 node / sqlite 版本与 checksum —— 事后能复算、能对账。
      insert.run(m.version, m.name, migrationDigest(m), now, engine.nodeVersion, engine.sqliteVersion);
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 事务可能已经没了 */ }
    throw err;
  }

  return {
    applied: pending.map(function (m) { return { version: m.version, name: m.name, checksum: migrationDigest(m) }; }),
    current: pending[pending.length - 1].version,
    engine,
    postSteps,
  };
}
