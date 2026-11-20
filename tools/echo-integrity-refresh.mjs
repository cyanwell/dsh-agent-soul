// tools/echo-integrity-refresh.mjs —— 显式刷新 ECHO 索引体检读数（阶段 2 · 2026-11-17）
//
// ★ 为什么需要这条命令：体检本身是几十秒的同步 SQL，**不能**放在请求路径上自动跑
//   （试过的后果：8 分钟起了 17 个 node 进程，每个都在扫 2.5GB 的 FTS5）。
//   所以现在它只由显式动作触发 —— 这条就是那个动作。
//
// 用法：
//   node tools/echo-integrity-refresh.mjs            # 日常体检（约 4 秒）
//   node tools/echo-integrity-refresh.mjs --deep     # 连孤儿检查一起（多 2~3 秒）
//   node tools/echo-integrity-refresh.mjs --db <path>
//
// 它做的事：起一个子进程跑 src/db/echo-stats-probe.mjs，把结果写到 data/_echo-integrity.json。
// 那个文件是 /api/status 与 /api/organs 里 ECHO 那一格的**唯一**来源。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const argv = process.argv.slice(2);
const deep = argv.includes('--deep');
const dbIdx = argv.indexOf('--db');
const dbPath = dbIdx >= 0 ? argv[dbIdx + 1] : path.join(root, 'data', 'meta.sqlite');
const outPath = path.join(root, 'data', '_echo-integrity.json');
const probe = path.join(root, 'src', 'db', 'echo-stats-probe.mjs');

if (!fs.existsSync(dbPath)) {
  console.error('找不到库：' + dbPath);
  process.exit(2);
}

const startedAt = Date.now();
const args = [probe, outPath, dbPath];
if (deep) args.push('--deep');

console.log('[刷新] 开始体检' + (deep ? '（含孤儿检查）' : '（日常路径）') + ' → ' + outPath);
const child = spawn(process.execPath, args, { stdio: 'inherit', env: process.env });

child.on('exit', (code) => {
  const wall = Date.now() - startedAt;
  let rec = null;
  try { rec = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch { rec = null; }
  if (!rec) {
    console.error('[刷新] 失败：探针没有留下可读的读数（退出码 ' + code + '，' + wall + 'ms）');
    process.exit(3);
  }
  const head = '[刷新] ' + (rec.ok === true ? '完成' : '出错') + '  stage=' + (rec.stage || '?') + '  ' + wall + 'ms';
  console.log(head);
  if (rec.ok === true) {
    console.log('  sources=' + rec.sources + '  words=' + rec.words + '  summaries=' + rec.summaries
      + '  aligned=' + rec.aligned + '  problems=' + rec.problems);
    if (Array.isArray(rec.steps)) {
      for (const s of rec.steps) console.log('    ' + s.name + ': ' + s.ms + 'ms');
    }
  } else {
    console.log('  error=' + (rec.error || '未知'));
  }
  process.exit(rec.ok === true ? 0 : 3);
});

child.on('error', (e) => {
  console.error('[刷新] 起不来：' + String((e && e.message) || e));
  process.exit(3);
});
