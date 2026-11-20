#!/usr/bin/env node
// tools/echo-live-sync-selftest.mjs —— 阶段 3 第 1 步的自检（TEMP ONLY）
//
// 它要证明的是「一条链真的能跑通」，而不只是「函数不抛」：
//   ① 空库 → 第一代：清单 / 构建 / 入库三段都真的发生，回执带真实计数
//   ② 文件没变 → 第二次跑：unchanged，**读 0 字节**（增量的判据在这里）
//   ③ 追加两帧 → 第三次跑：appended>0，词数只增不减，代次 +1
//   ④ 检索可用：写进去的词能被 store.echoSearch 查到（端到端，不是只看表）
//   ⑤ 源文件与 02-墨 一个字节都没变（只读边界）
//
// ★ 全程只碰 os.tmpdir()：源、清单、outDir、目标库都在临时目录里。
//   生产库（data/meta.sqlite）与真实会话日志**一次都不打开**。
//
// 退出码：0 全过 / 1 有失败

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { openMetaStore } from '../src/db/index.mjs';
import { runLiveSync, listSessionFiles } from './echo-live-sync.mjs';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-live-sync-selftest-'));
const ok = [];
const bad = [];
const t = (name, cond, detail) => {
  (cond ? ok : bad).push((cond ? '✓ ' : '✗ ') + name + (detail === undefined ? '' : '  → ' + String(detail)));
  return cond;
};

/** 把若干条记录写成「多帧 zstd 只追加流」—— 与 DSH 会话文件同形。 */
function appendFrames(file, records, flag) {
  const parts = records.map((r) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(r) + '\n', 'utf8')));
  fs.writeFileSync(file, Buffer.concat(parts), { flag: flag || 'wx' });
}

const SID = 'session-livesync-0001';
const sessDir = path.join(ROOT, 'ws', SID);
fs.mkdirSync(sessDir, { recursive: true });
const sessFile = path.join(sessDir, 'session.v4.jsonl.zstd');

const userMsg = (seq, text) => ({
  type: 'user/message', seq, time: Date.parse('2026-11-17T09:00:00.000Z') + seq * 1000,
  data: { content: [{ type: 'text', text }] },
});
const asstMsg = (seq, text) => ({
  type: 'assistant/message', seq, time: Date.parse('2026-11-17T09:00:00.000Z') + seq * 1000,
  data: { message: { content: [{ type: 'text', text }] } },
});

appendFrames(sessFile, [
  { type: 'session', seq: 0, time: Date.parse('2026-11-17T09:00:00.000Z'), cwd: 'D:/AI', agentPreset: 'yanqing' },
  userMsg(1, '回声增量索引的第一条原话：传输层'),
  asstMsg(2, '这是第一条结论，讲的是传输层与增量'),
]);

const before = fs.readFileSync(sessFile);
const dbPath = path.join(ROOT, 'meta.sqlite');
{
  const s = openMetaStore({ path: dbPath, mode: 'readwrite' });
  try { s.migrate(); } finally { s.close(); }
}

// ── ① 第一代 ──────────────────────────────────────────────────────────
const r1 = runLiveSync({ db: dbPath, sourceRoot: path.join(ROOT, 'ws') });
t('① 第一代 IMPORTED', r1.code === 'IMPORTED', r1.code);
t('① 代次 = 1', r1.generation === 1, r1.generation);
t('① 清单 1 个会话', r1.manifest.rows === 1, r1.manifest.rows);
t('① 写入 2 个词（session 头不算词）', r1.counts.words === 2, r1.counts.words);
t('① 首次是 full 读', r1.tail.fullyRead === 1 && r1.tail.appended === 0, JSON.stringify({ full: r1.tail.fullyRead, app: r1.tail.appended }));
t('① 读字节 > 0', r1.tail.bytesRead > 0, r1.tail.bytesRead);

// ── ② 文件没变 → unchanged，读 0 字节 ────────────────────────────────────
const r2 = runLiveSync({ db: dbPath, sourceRoot: path.join(ROOT, 'ws') });
// ★ 判据变过一次，理由在这里：原来断言 ALREADY_CURRENT（走完整链、importer 认出同代同 SHA）。
//   但那条路每轮都要重建整代 words（本机 2.6 万行起），而 soul-sync 绝大多数轮次一个字都没变 ——
//   于是「空转一轮 = 重写全库」变成常态。现在加了一道磁盘预检：mtime:size 全对 → 直接 UNCHANGED，
//   连构建器都不进。ALREADY_CURRENT 仍存在，它现在只覆盖「预检放行了、但内容真的等价」这种边角。
t('② 第二次 UNCHANGED（预检短路）', r2.code === 'UNCHANGED', r2.code);
t('② 读 0 字节（增量判据）', r2.tail.bytesRead === 0, r2.tail.bytesRead);
t('② 代次没有前进', r2.generation === 1, r2.generation);
t('② 没写任何东西', r2.wrote === false, r2.wrote);

// ── ③ 追加两帧 → 只读尾部 ────────────────────────────────────────────────
appendFrames(sessFile, [userMsg(3, '追加的第三条：只读尾部'), asstMsg(4, '追加的第四条结论')], 'a');
const r3 = runLiveSync({ db: dbPath, sourceRoot: path.join(ROOT, 'ws') });
t('③ 第三次 IMPORTED', r3.code === 'IMPORTED', r3.code);
t('③ 代次 = 2', r3.generation === 2, r3.generation);
t('③ 走的是 append（不是全读）', r3.tail.appended === 1 && r3.tail.fullyRead === 0, JSON.stringify({ app: r3.tail.appended, full: r3.tail.fullyRead }));
t('③ 词数增到 4', r3.counts.words === 4, r3.counts.words);
t('③ 只读了新增那段（远小于全文）', r3.tail.bytesRead > 0 && r3.tail.bytesRead < fs.statSync(sessFile).size, JSON.stringify({ read: r3.tail.bytesRead, size: fs.statSync(sessFile).size }));

// ── ④ 检索端到端 ──────────────────────────────────────────────────────
{
  const s = openMetaStore({ path: dbPath, mode: 'readonly' });
  try {
    const hit = s.echoSearch('传输层', { surface: 'words', limit: 10 });
    t('④ 检索命中「传输层」', hit.results.length >= 1, hit.results.length);
    t('④ 命中带 log: 门牌', hit.results.every((x) => typeof x.ptr === 'string' && x.ptr.startsWith('log:')), hit.results[0] && hit.results[0].ptr);
    const idx = s.echoStats();
    t('④ 索引对齐', idx.aligned === true, idx.aligned);
    t('④ 汇总词数 = 4', idx.words === 4, idx.words);
  } finally { s.close(); }
}

// ── ⑤ 只读边界 ────────────────────────────────────────────────────────
t('⑤ 源会话日志一个字节没变', Buffer.compare(before, fs.readFileSync(sessFile).subarray(0, before.length)) === 0);
const moPath = 'D:/AI/yanqing-soul/02-墨.jsonl';
if (fs.existsSync(moPath)) {
  const a = fs.statSync(moPath);
  t('⑤ 02-墨 未被打开写（mtime 未变）', Math.abs(Date.now() - a.mtimeMs) > 60_000, new Date(a.mtimeMs).toISOString());
} else {
  t('⑤ 02-墨 不存在于本机（跳过写边界核对）', true);
}

// ── ⑥ listSessionFiles 只认会话文件名 ─────────────────────────────────────
{
  fs.writeFileSync(path.join(sessDir, 'notes.md'), 'x');
  const files = listSessionFiles(path.join(ROOT, 'ws'));
  t('⑥ 只列 session.v[34].jsonl.zstd', files.length === 1, files.length);
}

fs.rmSync(ROOT, { recursive: true, force: true });
for (const line of ok) console.log(line);
for (const line of bad) console.log(line);
console.log('');
console.log('echo-live-sync-selftest: ' + ok.length + ' passed / ' + bad.length + ' failed');
process.exitCode = bad.length ? 1 : 0;
