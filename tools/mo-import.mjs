#!/usr/bin/env node
// tools/mo-import.mjs —— 把 02-墨.jsonl 导进 SQLite 的 mo_ledger（带批次溯源）
//
// 口径（爀曦 2026-11-17 定）：墨以 SQLite 的 mo_ledger 为准；
//   JSONL 继续是只追加的源文件（多写者天然安全），SQLite 是权威查询面。
//
// 契约（schema 触发器定的，不是我编的）：
//   · 导入行必须带 import_batch_id + legacy_line + legacy_raw；
//   · 导入行不许有 actor_session；
//   · 导入进来的历史 lead 永远不是「当前主导」（判据只认 import_batch_id IS NULL）；
//   · 批次表只追加。
//
// 幂等：按源文件 sha256，同一个文件导第二次什么都不做。
//
// 用法：node tools/mo-import.mjs --file <02-墨.jsonl> --db <meta.sqlite> [--apply]

import fs from 'node:fs';
import crypto from 'node:crypto';
import { openDatabase, configureConnection } from '../src/db/engine.mjs';

const TYPES = ['lead', 'promise', 'fact', 'shelved', 'gain', 'loss', 'persona', 'container'];

function argOf(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

function main() {
  const argv = process.argv.slice(2);
  const file = argOf(argv, '--file');
  const dbPath = argOf(argv, '--db');
  const apply = argv.includes('--apply');
  // ★ 把最后一条 lead 作为 **live 行**（import_batch_id NULL）写入。
  //   理由：导入的历史 lead 永远不是「当前主导」（判据只认 import_batch_id IS NULL），
  //   若 787 行全按历史导，SQLite 里就一个 live lead 都没有 —— 之后写 promise 会被
  //   MO_NO_LEAD 直接拒掉。而「当前主导」恰恰必须是一条可参与权威判定的行。
  //   ★ 不多行：这一行从批次里剔除，再作为 live 插入，总数仍是 787。
  if (!file || !dbPath) { console.log(JSON.stringify({ ok: false, code: 'E_ARGS', need: '--file <jsonl> --db <meta.sqlite> [--apply]' })); process.exitCode = 2; return; }
  if (!fs.existsSync(file)) { console.log(JSON.stringify({ ok: false, code: 'E_FILE', file })); process.exitCode = 2; return; }
  if (!fs.existsSync(dbPath)) { console.log(JSON.stringify({ ok: false, code: 'E_DB', db: dbPath })); process.exitCode = 2; return; }

  const buf = fs.readFileSync(file);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  const blankLines = lines.filter((l) => l.trim() === '').length;
  const rows = [];
  const bad = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw.trim() === '') continue;
    let obj;
    try { obj = JSON.parse(raw); } catch (e) { bad.push({ line: i + 1, why: 'invalid JSON' }); continue; }
    const type = String(obj.type || '');
    const body = (typeof obj.text === 'string' && obj.text) || (typeof obj['概要'] === 'string' && obj['概要']) || '';
    const by = (typeof obj.by === 'string' && obj.by.trim()) ? obj.by.trim() : 'unknown';
    if (!TYPES.includes(type)) { bad.push({ line: i + 1, why: 'unknown type ' + JSON.stringify(type) }); continue; }
    if (!body.trim()) { bad.push({ line: i + 1, why: 'empty body' }); continue; }
    const t = (typeof obj.t === 'string' && obj.t) ? obj.t : (typeof obj.time === 'string' ? obj.time : '');
    if (!t) { bad.push({ line: i + 1, why: 'no time field t' }); continue; }
    rows.push({
      line: i + 1, raw, t, type, text: body, by, isLastLine: false,
      ref: typeof obj.ref === 'string' && obj.ref ? obj.ref : null,
      feel: typeof obj.feel === 'string' && obj.feel ? obj.feel : null,
      byUser: obj.byUser === true || obj.by_user === 1 ? 1 : 0,
    });
  }

  // 找出「最后一条 lead」：它要以 live 行写入。
  let liveLead = null;
  for (let i = rows.length - 1; i >= 0; i -= 1) { if (rows[i].type === 'lead') { liveLead = rows[i]; break; } }
  const batchRows = liveLead ? rows.filter((r) => r !== liveLead) : rows;
  const perType = {};
  for (const k of TYPES) perType[k] = rows.filter((r) => r.type === k).length;
  const plan = { file, db: dbPath, sha256: sha, bytes: buf.length, physicalLines: lines.length, blankLines, parsed: rows.length, rejected: bad.length, perType,
    batchRows: batchRows.length, liveLeadLine: liveLead ? liveLead.line : null, liveLeadBy: liveLead ? liveLead.by : null };

  if (bad.length) { console.log(JSON.stringify({ ok: false, code: 'E_BAD_ROWS', plan, bad: bad.slice(0, 10) }, null, 1)); process.exitCode = 3; return; }
  if (rows.length === 0) { console.log(JSON.stringify({ ok: false, code: 'E_EMPTY', plan })); process.exitCode = 3; return; }

  const db = openDatabase(dbPath, { readOnly: !apply });
  configureConnection(db, { readOnly: !apply });
  try {
    const existing = db.prepare('SELECT batch_id, rows_imported FROM mo_import_batches WHERE source_sha256 = ?').get(sha);
    if (existing) {
      const live = Number(db.prepare('SELECT COUNT(*) AS n FROM mo_ledger').get().n);
      console.log(JSON.stringify({ ok: true, code: 'ALREADY_IMPORTED', plan, batchId: Number(existing.batch_id), rowsInBatch: Number(existing.rows_imported), ledgerRows: live }, null, 1));
      return;
    }
    if (!apply) { console.log(JSON.stringify({ ok: true, code: 'PLANNED', plan, note: 'DRY-RUN: add --apply to write' }, null, 1)); return; }

    db.exec('BEGIN IMMEDIATE');
    let batchId = null;
    try {
      const importedAt = new Date().toISOString();
      const res = db.prepare('INSERT INTO mo_import_batches (source_path, source_sha256, source_bytes, physical_lines, blank_lines, rows_imported, imported_at, importer) VALUES (?,?,?,?,?,?,?,?)')
        .run(file, sha, buf.length, lines.length, blankLines, batchRows.length, importedAt, 'tools/mo-import.mjs');
      batchId = Number(res.lastInsertRowid);
      const ins = db.prepare('INSERT INTO mo_ledger (t, type, text, by, actor_session, ref, feel, by_user, legacy_line, legacy_raw, import_batch_id) VALUES (?,?,?,?,NULL,?,?,?,?,?,?)');
      for (const r of batchRows) ins.run(r.t, r.type, r.text, r.by, r.ref, r.feel, r.byUser, r.line, r.raw, batchId);
      if (liveLead) {
        // live 行没有 legacy_line（触发器要求「有 legacy_line 就必须挂批次」）——
        // 所以它靠 text/ref/feel 与源文件那一行逐字相同来对账，不靠行号。
        db.prepare('INSERT INTO mo_ledger (t, type, text, by, actor_session, ref, feel, by_user) VALUES (?,?,?,?,?,?,?,?)')
          .run(liveLead.t, liveLead.type, liveLead.text, liveLead.by, liveLead.by, liveLead.ref, liveLead.feel, liveLead.byUser);
      }
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (ignored) { /* ignore */ }
      console.log(JSON.stringify({ ok: false, code: 'E_WRITE', why: String((e && e.message) || e).slice(0, 300), plan }, null, 1));
      process.exitCode = 4;
      return;
    }

    const byType = db.prepare('SELECT type, COUNT(*) AS n FROM mo_ledger GROUP BY type ORDER BY type').all();
    const total = Number(db.prepare('SELECT COUNT(*) AS n FROM mo_ledger').get().n);
    const imported = Number(db.prepare('SELECT COUNT(*) AS n FROM mo_ledger WHERE import_batch_id IS NOT NULL').get().n);
    const liveLeads = Number(db.prepare("SELECT COUNT(*) AS n FROM mo_ledger WHERE type='lead' AND import_batch_id IS NULL").get().n);
    const hist = {};
    for (const r of byType) hist[r.type] = Number(r.n);
    console.log(JSON.stringify({ ok: true, code: 'IMPORTED', plan, batchId, after: { total, importedRows: imported, byType: hist, liveLeads } }, null, 1));
  } finally { db.close(); }
}

main();
