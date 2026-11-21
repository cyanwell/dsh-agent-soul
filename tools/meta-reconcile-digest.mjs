#!/usr/bin/env node
// tools/meta-reconcile-digest.mjs —— 迁移文本被等价改写后，显式对账 schema_migrations 里的 checksum。
//
// ★ 为什么需要它（2026-11-17 实际撞到）：
//   生产库 v10 记录的 digest 与当前代码算出来的不一致 —— 说明 v10 的 SQL 文本在入库之后被改过。
//   结构是等价的（同一个 CHECK 约束换了位置），但 digest 只看文本，于是它拦住了所有后续迁移。
//
// ★ 它不许做的事：
//   · 不许「直接把数字改掉就算」—— 必须先用结构比对证明该版本的产物与当前代码一致；
//   · 不许静默 —— 每一次对账都追加一行到 data/digest-reconciliation.jsonl（只追加，不改不删）。
//
// 用法：node tools/meta-reconcile-digest.mjs --db <path> --version 10 [--apply]

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, configureConnection } from '../src/db/engine.mjs';
// 注意：这里不 import migrate —— 见下方 targetVersion 的坑。
import { MIGRATIONS, migrationDigest } from '../src/db/schema.mjs';

function argOf(a, n) { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : null; }

// ★ 归一化的每一处让步都要能说清，并且会被写进对账记录：
//   ① 去掉标识符上的双引号 —— SQLite 在 ALTER TABLE RENAME 之后会加引号，
//      那不是结构差异（echo_source_builds 就因此报过假阳性）；
//   ② 重复的、逐字相同的约束去重 —— 同一个 CHECK 写两遍与写一遍等价
//      （echo_vector_models 的 model_key 就是写了两遍）。
function normalizeDdl(sql) {
  let s = String(sql || '')
    .replace(/"([A-Za-z_][A-Za-z0-9_]*)"/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1')
    .trim()
    .toLowerCase();
  // 同一段 check(...) 出现多次 -> 只留一次
  const seen = new Set();
  // 注意 check(...) 里几乎总有嵌套括号（length(...) / trim(...)），
  // 所以不能用 [^()]* —— 那匹配不到，去重就静默失效（2026-11-17 踩过）。
  s = s.replace(/check\(((?:[^()]|\([^()]*\))*)\)/g, (m) => {
    if (seen.has(m)) return '';
    seen.add(m);
    return m;
  });
  return s.replace(/,{2,}/g, ',').replace(/,\s*\)/g, ')').replace(/\s+/g, ' ').trim();
}

function main() {
  const argv = process.argv.slice(2);
  const dbPath = argOf(argv, '--db');
  const version = Number(argOf(argv, '--version'));
  const apply = argv.includes('--apply');
  if (!dbPath || !version) { console.log(JSON.stringify({ ok: false, code: 'E_ARGS', need: '--db <path> --version <n> [--apply]' })); process.exitCode = 2; return; }
  const mig = MIGRATIONS.find((m) => m.version === version);
  if (!mig) { console.log(JSON.stringify({ ok: false, code: 'E_NO_MIGRATION', version })); process.exitCode = 2; return; }

  const db = openDatabase(dbPath, { readOnly: !apply });
  configureConnection(db, { readOnly: !apply });
  try {
    const row = db.prepare('SELECT version,name,checksum,applied_at FROM schema_migrations WHERE version=?').get(version);
    if (!row) { console.log(JSON.stringify({ ok: false, code: 'E_NOT_APPLIED', version })); process.exitCode = 3; return; }
    const computed = migrationDigest(mig);
    if (computed === row.checksum) { console.log(JSON.stringify({ ok: true, code: 'ALREADY_MATCHES', version })); return; }

    // ★ 结构比对：把这次迁移建出来的对象（表/索引/触发器）的 DDL 全部取出，
    //   与「当前代码跑一遍得到的样子」比 —— 做法是：把这些对象名从当前库读出，
    //   逐条规范化后记录；然后在临时库里只跑到该版本，再比一次。
    // ★ schema_migrations 不在迁移 SQL 里 —— 它是 migrate() 在跑完之后自己建的，
    //   所以「只执行迁移 SQL」的临时库必然没有它。拿它当差异是比对范围错了，要排除。
    const objectsOf = (conn) => conn.prepare(
      "SELECT type,name,sql FROM sqlite_master WHERE type IN ('table','index','trigger','view') AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY type,name",
    ).all().map((r) => ({ type: r.type, name: r.name, ddl: normalizeDdl(r.sql) }));

    // ★ 真比对：在临时库里只迁移到这个版本，把它建出的对象逐个对齐生产库。
    //   不一致就不许改 digest —— 那说明不是「文本等价」，是结构真的漂了。
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-'));
    const tmpPath = path.join(tmpDir, 'probe.sqlite');
    let drift = null;
    let tmpObjects = null;
    try {
      const tmpDb = openDatabase(tmpPath, { readOnly: false });
      configureConnection(tmpDb, { readOnly: false });
      try {
        // ★★ 不能用 migrate(db, { targetVersion }) 当「只跑到这个版本」——
        //    2026-11-17 实测：那个参数只是**期望值校验**（migrate.mjs:116），
        //    迁移照样从 1 跑到 SCHEMA_VERSION。拿它做基准，会把 v11 之后的结构
        //    当成「这个版本应有的样子」，于是比对全是假阳性。
        //    正确做法：把该版本及之前的 SQL 逐条执行，不多跑一步。
        MIGRATIONS.filter((m) => m.version <= version).forEach((m) => tmpDb.exec(m.sql));
        tmpObjects = objectsOf(tmpDb);
      } finally { tmpDb.close(); }
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (ignored) { /* temp */ }
    }
    const live = objectsOf(db);
    const key = (o) => o.type + ':' + o.name;
    const tmpMap = new Map(tmpObjects.map((o) => [key(o), o.ddl]));
    const liveMap = new Map(live.map((o) => [key(o), o.ddl]));
    const onlyLive = [...liveMap.keys()].filter((k) => !tmpMap.has(k));
    const onlyTmp = [...tmpMap.keys()].filter((k) => !liveMap.has(k));
    const differing = [...liveMap.keys()].filter((k) => tmpMap.has(k) && tmpMap.get(k) !== liveMap.get(k));
    if (onlyLive.length || onlyTmp.length || differing.length) {
      drift = { onlyLive: onlyLive.slice(0, 10), onlyTmp: onlyTmp.slice(0, 10), differing: differing.slice(0, 10) };
      console.log(JSON.stringify({ ok: false, code: 'E_STRUCTURE_DRIFT', version, drift, note: 'refusing to rewrite the digest: the schema does not match what this migration produces' }, null, 1));
      process.exitCode = 5;
      return;
    }
    const evidence = { liveObjects: live.length, comparedObjects: tmpMap.size, structureIdentical: true, storedDigest: String(row.checksum), computedDigest: computed };

    if (!apply) {
      console.log(JSON.stringify({ ok: true, code: 'PLANNED', version, name: mig.name, evidence, note: 'DRY-RUN: add --apply' }, null, 1));
      return;
    }

    const auditPath = path.join(path.dirname(dbPath), 'digest-reconciliation.jsonl');
    const rec = {
      at: new Date().toISOString(),
      version, name: mig.name, db: dbPath,
      storedDigest: String(row.checksum), computedDigest: computed,
      appliedAt: row.applied_at,
      reason: 'migration text rewritten equivalently after the db recorded it; structure re-verified before rewriting the digest',
      evidence,
    };
    db.prepare('UPDATE schema_migrations SET checksum=? WHERE version=?').run(computed, version);
    fs.appendFileSync(auditPath, JSON.stringify(rec) + '\n', 'utf8');
    const after = db.prepare('SELECT checksum FROM schema_migrations WHERE version=?').get(version).checksum;
    console.log(JSON.stringify({ ok: true, code: 'RECONCILED', version, name: mig.name, storedDigest: rec.storedDigest, computedDigest: computed, recordedIn: auditPath, verified: after === computed }, null, 1));
  } finally { db.close(); }
}

main();