#!/usr/bin/env node
// tools/ledger-dualwrite-selftest.mjs —— 墨双写（文件 + SQLite）四条行为。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LedgerBase } from '../src/organs/ledger.mjs';
import { openMetaStore } from '../src/db/index.mjs';

const ok = []; const bad = [];
const t = (name, cond, detail) => { (cond ? ok : bad).push(name + (cond ? '' : '  ← ' + String(detail))); return cond; };

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-dual-'));
const SESSION = 'd0cb8ea1-ad57-47a0-8406-4541443def3f';

function fresh(name) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '02-墨.jsonl');
  const store = openMetaStore({ path: path.join(dir, 'meta.sqlite'), mode: 'readwrite' });
  store.migrate();
  return { dir, file, store };
}

// ── 1. 双写：文件和库都有 ──
{
  const { file, store } = fresh('dual');
  const L = new LedgerBase(file, { store, sessionId: SESSION });
  const r = L.write({ type: 'fact', text: '双写这一条', by: 'd0cb8ea1' });
  const fileRows = fs.readFileSync(file, 'utf8').trim().split('\n');
  const dbRows = store.listLedger({});
  t('双写：返回 sqlite+jsonl', r.ok && r.backend === 'sqlite+jsonl', JSON.stringify(r).slice(0, 160));
  t('双写：文件有一行', fileRows.length === 1, fileRows.length);
  t('双写：库有一行', dbRows.length === 1, dbRows.length);
  t('双写：两边文本一致', dbRows[0].text === '双写这一条', dbRows[0].text);
  store.close();
}

// ── 2. 库写失败 → 文件仍成功 + 留痕 ──
{
  const { file, store } = fresh('degrade');
  const broken = Object.create(store);
  broken.appendLedger = () => { const e = new Error('simulated store failure'); e.code = 'SIM_FAIL'; throw e; };
  const L = new LedgerBase(file, { store: broken, sessionId: SESSION });
  const r = L.write({ type: 'fact', text: '库坏了也要写进去', by: 'd0cb8ea1' });
  const fileRows = fs.readFileSync(file, 'utf8').trim().split('\n');
  const degradeFile = path.join(path.dirname(file), 'ledger-degrade.jsonl');
  const degrades = fs.existsSync(degradeFile) ? fs.readFileSync(degradeFile, 'utf8').trim().split('\n') : [];
  t('降级：仍然 ok:true', r.ok === true, JSON.stringify(r).slice(0, 160));
  t('降级：文件写进去了', fileRows.length === 1, fileRows.length);
  t('降级：留下了一条降级记录', degrades.length === 1, degrades.length);
  t('降级：返回里带着库错误', String(r.storeError || '').startsWith('SIM_FAIL'), r.storeError);
  t('降级：backend 注明 jsonl', r.backend === 'jsonl', r.backend);
  store.close();
}

// ── 3. 没有 sessionId → 文件成功、库跳过、留痕 ──
{
  const { file, store } = fresh('nosession');
  const L = new LedgerBase(file, { store });
  const r = L.write({ type: 'fact', text: '不知道完整会话 id', by: 'd0cb8ea1' });
  const dbRows = store.listLedger({});
  const degradeFile = path.join(path.dirname(file), 'ledger-degrade.jsonl');
  const degrades = fs.existsSync(degradeFile) ? fs.readFileSync(degradeFile, 'utf8').trim().split('\n') : [];
  t('无会话：仍 ok:true', r.ok === true, JSON.stringify(r).slice(0, 160));
  t('无会话：库没写', dbRows.length === 0, dbRows.length);
  t('无会话：storeSkipped=NO_SESSION', r.storeSkipped === 'NO_SESSION', r.storeSkipped);
  t('无会话：留痕', degrades.length === 1, degrades.length);
  store.close();
}

// ── 4. lead 换届：只有当前主导能写 ──
{
  const { file, store } = fresh('lead');
  const L = new LedgerBase(file, { store, sessionId: SESSION });
  // ★ lead 有三道闸门（宪章级，不许绕）：完整 sessionId / 世代自述 / 必须带 ref。
  const GEN1 = '第1代 · 接手于 2026-11-17 · 上一代做了：无（首代）';
  const GEN2 = '第2代 · 接手于 2026-11-17 · 上一代做了：起手';
  const REF = '自检：ledger-dualwrite-selftest';
  const first = L.write({ type: 'lead', text: GEN1, by: 'd0cb8ea1', ref: REF });
  t('lead：库空时允许第一条', first.ok === true && first.backend === 'sqlite+jsonl', JSON.stringify(first).slice(0, 200));
  const other = new LedgerBase(file, { store, sessionId: 'ffffffff-1111-2222-3333-444444444444' });
  const bad1 = other.write({ type: 'lead', text: GEN2, by: 'ffffffff', ref: REF });
  t('lead：非当前主导被拒（且不落文件）', bad1.ok === false && String(bad1.code) === 'LEDGER_LEAD_AUTH_REQUIRED', JSON.stringify(bad1).slice(0, 220));
  const fileRowsAfterReject = fs.readFileSync(file, 'utf8').trim().split('\n').length;
  t('lead：被拒后文件仍然只有 1 行（没有分叉）', fileRowsAfterReject === 1, fileRowsAfterReject);
  const mine = L.write({ type: 'lead', text: GEN2, by: 'd0cb8ea1', ref: REF });
  t('lead：当前主导可以再写', mine.ok === true && mine.backend === 'sqlite+jsonl', JSON.stringify(mine).slice(0, 200));
  const missingRef = L.write({ type: 'lead', text: '第3代 · 接手于 2026-11-17 · 上一代做了：交班', by: 'd0cb8ea1' });
  t('lead：不带 ref 被拒（宪章闸门）', missingRef.ok === false && /MO_LEAD_REF_REQUIRED/.test(String(missingRef.message)), JSON.stringify(missingRef).slice(0, 200));
  store.close();
}

// ── 5. 读：库为主，且 currentLead 认的是 live lead ──
{
  const { file, store } = fresh('read');
  const L = new LedgerBase(file, { store, sessionId: SESSION });
  L.write({ type: 'lead', text: '第1代 · 接手于 2026-11-17 · 上一代做了：无（首代）', by: 'd0cb8ea1', ref: '自检' });
  L.write({ type: 'fact', text: '一条事实', by: 'd0cb8ea1' });
  t('读：all() 走库', L.all().length === 2 && L.storeMayLag() === false, JSON.stringify({n: L.all().length, lag: L.storeMayLag()}));
  t('读：currentLead 是 d0cb8ea1', L.currentLead() === 'd0cb8ea1', L.currentLead());
  t('读：isBrain 认自己', L.isBrain(SESSION) === true, 'false');
  t('读：不认别人', L.isBrain('ffffffff-1111-2222-3333-444444444444') === false, 'true');
  store.close();
}

// ── 6. SQL 溯源投影：较新的 imported lead 不覆盖 live lead ──
{
  const { file, store } = fresh('imported-lead');
  const L = new LedgerBase(file, { store, sessionId: SESSION });
  const liveBy = 'd0cb8ea1';
  const live = L.write({ type: 'lead', text: '第1代 · 接手于 2026-11-19 · 上一代做了：无（首代）', by: liveBy, ref: '自检' });
  t('导入主导：live lead 写入成功', live.ok === true && live.backend === 'sqlite+jsonl', JSON.stringify(live).slice(0, 180));

  const batch = store.db.prepare([
    'INSERT INTO mo_import_batches',
    '(source_path, source_sha256, source_bytes, physical_lines, blank_lines, rows_imported, imported_at, importer)',
    'VALUES (?,?,?,?,?,?,?,?)',
  ].join(' ')).run('fixture/imported-lead.jsonl', 'b'.repeat(64), 64, 1, 0, 1, new Date().toISOString(), 'selftest-fixture');
  const batchId = Number(batch.lastInsertRowid);
  store.db.prepare('INSERT INTO mo_ledger (t,type,text,by,actor_session,ref,feel,by_user,legacy_line,legacy_raw,import_batch_id) VALUES (?,?,?,?,NULL,?,?,?,?,?,?)')
    .run(new Date(Date.now() + 1000).toISOString(), 'lead', 'imported historical lead', 'deadbeef', null, null, 0, 1, JSON.stringify({ type: 'lead', by: 'deadbeef' }), batchId);

  const imported = L.all().find((r) => r.importBatchId === batchId);
  t('导入主导：SQL 行投影保留 importBatchId', imported && imported.importBatchId === batchId, imported && imported.importBatchId);
  t('导入主导：SQL 行投影保留 legacyLine', imported && imported.legacyLine === 1, imported && imported.legacyLine);
  t('导入主导：currentLead 跳过较新的 imported lead', L.currentLead() === liveBy, L.currentLead());
  store.close();
}

// -- 6. SQL projection preserves import provenance for currentLead --
{
  const dir = path.join(ROOT, 'provenance');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '02-墨.jsonl');
  const rows = [
    { t: '2026-11-17T00:00:00.000Z', type: 'lead', by: 'oldlead1', text: '第0代 · 历史导入', importBatchId: 7, legacyLine: 1 },
    { t: '2026-11-18T00:00:00.000Z', type: 'lead', by: 'd0cb8ea1', text: '第1代 · 当前主导', importBatchId: null, legacyLine: null },
  ];
  const fakeStore = {
    listLedger: () => [{ t: rows[1].t }],
    listLedgerAll: () => rows,
  };
  const L = new LedgerBase(file, { store: fakeStore, sessionId: SESSION });
  t('SQL投影保留历史导入标记', L.all()[0].importBatchId === 7 && L.all()[0].legacyLine === 1, JSON.stringify(L.all()));
  t('currentLead跳过历史导入lead', L.currentLead() === 'd0cb8ea1', L.currentLead());
}

fs.rmSync(ROOT, { recursive: true, force: true });

for (const line of ok) console.log('  ✓ ' + line);
for (const line of bad) console.log('  ✗ ' + line);
console.log('');
console.log(bad.length ? (bad.length + ' 失败 / ' + (ok.length + bad.length) + ' 总') : (ok.length + ' 通过 / 0 失败'));
process.exitCode = bad.length ? 1 : 0;