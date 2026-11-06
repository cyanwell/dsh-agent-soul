#!/usr/bin/env node
// 全量迁移 DSH 会话 → agent-soul
//
// ★ 三个必须有的东西：
//   ① 幂等标记 —— 迁过的会话记在 data/migrated.json，重复跑不会重复追加
//   ② 分批 —— --limit N 只迁 N 个，出问题不用从头来
//   ③ 单文件容错 —— 一个坏会话不该毁掉整批
//
// 用法：
//   node tools/migrate-all.mjs --dry-run          只看会迁什么
//   node tools/migrate-all.mjs --limit 20         先迁 20 个试试
//   node tools/migrate-all.mjs                    全量
//   node tools/migrate-all.mjs --force            忽略幂等标记

import fs from 'node:fs';
import path from 'node:path';
import { migrateOne } from '../src/migrate/dsh.mjs';
import { SessionStore } from '../src/session/store.mjs';
import { loadConfig, ROOT } from '../src/config.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const val = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const DRY = flag('dry-run');
const FORCE = flag('force');
const LIMIT = Number(val('limit', '0')) || 0;
const SRC = val('src', 'D:/AI/dsh/home/sessions');

const cfg = loadConfig();
const store = new SessionStore(cfg.dataDir);
const MARK = path.join(cfg.dataDir, 'migrated.json');

let done = {};
try { done = JSON.parse(fs.readFileSync(MARK, 'utf8')); } catch {}

// 收集
const files = [];
const walk = (d, depth) => {
  if (depth > 3) return;
  let ents = [];
  try { ents = fs.readdirSync(d); } catch { return; }
  for (const e of ents) {
    const p = path.join(d, e);
    let st; try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, depth + 1);
    else if (e === 'session.v4.jsonl.zstd') files.push({ p, size: st.size, id: path.basename(d) });
  }
};
walk(SRC, 0);
files.sort((a, b) => a.size - b.size);   // 小的先来，早见结果

const todo = files.filter(f => FORCE || !done[f.id]);
console.log('源: ' + SRC);
console.log('会话 ' + files.length + ' 个，已迁 ' + (files.length - todo.length) + '，本次要迁 ' + todo.length);
if (DRY) {
  console.log('\n[dry-run] 前 10 个：');
  for (const f of todo.slice(0, 10)) console.log('  ' + (f.size / 1024).toFixed(0) + 'KB  ' + f.id);
  process.exit(0);
}

const batch = LIMIT ? todo.slice(0, LIMIT) : todo;
console.log('实际处理 ' + batch.length + ' 个\n');

const t0 = Date.now();
let okCount = 0, failCount = 0, totalFrames = 0, totalRecords = 0;
const fails = [];

for (let i = 0; i < batch.length; i++) {
  const f = batch[i];
  const mark = '[' + (i + 1) + '/' + batch.length + '] ' + (f.size / 1024).toFixed(0) + 'KB ' + f.id.slice(0, 24);
  try {
    const r = migrateOne(store, f.p, {});
    okCount++;
    totalFrames += r.frames;
    totalRecords += r.records;
    done[f.id] = { at: Date.now(), frames: r.frames, records: r.records, bytes: r.bytes };
    if ((i + 1) % 10 === 0 || batch.length <= 20) {
      console.log(mark + '  → ' + r.frames + ' 帧  (' + r.records + ' 条记录)');
    }
  } catch (e) {
    failCount++;
    fails.push({ id: f.id, err: String(e && e.message || e) });
    console.log(mark + '  ✗ ' + (e && e.message));
  }
  if ((i + 1) % 25 === 0) {
    fs.writeFileSync(MARK, JSON.stringify(done, null, 1), 'utf8');
  }
}

fs.writeFileSync(MARK, JSON.stringify(done, null, 1), 'utf8');
store.closeAll();

const sec = ((Date.now() - t0) / 1000).toFixed(1);
console.log('\n=== 完成 ===');
console.log('成功 ' + okCount + ' / 失败 ' + failCount + ' / 用时 ' + sec + 's');
console.log('共 ' + totalRecords + ' 条记录 → ' + totalFrames + ' 帧');
console.log('索引标记: ' + MARK);
if (fails.length) {
  console.log('\n失败的:');
  for (const x of fails.slice(0, 10)) console.log('  ' + x.id + '  ' + x.err);
}