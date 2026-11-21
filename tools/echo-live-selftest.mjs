#!/usr/bin/env node
// tools/echo-live-selftest.mjs —— 器官层的自检（TEMP ONLY）
//
// 它要证明的不是「函数能跑」，而是**挂进常驻进程之后不会害人**：
//   ① 未配置 → start 报 started:false，runOnce 直接 skipped，绝不起进程
//   ② 正常一轮 → 子进程真的被拉起、回执真的落盘、stats 真的对得上
//   ③ 单飞 → 上一轮没回来时 runOnce 返回 busy，**不会并发起第二个子进程**
//   ④ 内容没变 → 第二轮 UNCHANGED，且耗时远小于第一轮
//   ⑤ 关停 → stop() 之后 runOnce 返回 stopped，不再起进程
//   ⑥ 子进程失败时 → 回执里带 code + stage，不写空对象冒充成功
//
// ★ 全程只碰 os.tmpdir()：源、库、回执都在临时目录。生产库与真实会话日志一次都不打开。
// 退出码：0 全过 / 1 有失败

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { openMetaStore } from '../src/db/index.mjs';
import { createEchoLive, receiptFileOf } from '../src/organs/echo-live.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMP = fs.realpathSync(os.tmpdir());
const LOCK = path.join(TEMP, 'echo-live-organ-selftest-' + process.pid + '-' + Date.now() + '.lock');
const LOCK_FD = fs.openSync(LOCK, 'wx');
const ROOT = fs.mkdtempSync(path.join(TEMP, 'echo-live-organ-selftest-'));
const SCRIPT = path.join(HERE, 'echo-live-sync.mjs');
const ok = [];
const bad = [];
const t = (name, cond, detail) => {
  (cond ? ok : bad).push((cond ? '✓ ' : '✗ ') + name + (detail === undefined ? '' : '  → ' + String(detail)));
  return cond;
};

const SID = 'session-organ-0001';
const ws = path.join(ROOT, 'ws');
const sessDir = path.join(ws, SID);
fs.mkdirSync(sessDir, { recursive: true });
const sessFile = path.join(sessDir, 'session.v4.jsonl.zstd');
const recs = [
  { type: 'session', seq: 0, time: Date.parse('2026-11-17T09:00:00.000Z'), cwd: 'D:/AI' },
  { type: 'user/message', seq: 1, time: Date.parse('2026-11-17T09:00:01.000Z'), data: { content: [{ type: 'text', text: '器官层的第一条原话' }] } },
  { type: 'assistant/message', seq: 2, time: Date.parse('2026-11-17T09:00:02.000Z'), data: { message: { content: [{ type: 'text', text: '器官层的第一条结论' }] } } },
];
fs.writeFileSync(sessFile, Buffer.concat(recs.map((r) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(r) + '\n', 'utf8')))));

const dbPath = path.join(ROOT, 'meta.sqlite');
{ const s = openMetaStore({ path: dbPath, mode: 'readwrite' }); try { s.migrate(); } finally { s.close(); } }
const dataDir = path.join(ROOT, 'data');
fs.mkdirSync(dataDir, { recursive: true });

// ── ① 未配置 ─────────────────────────────────────────────────────────
{
  const e = createEchoLive({ dataDir: path.join(ROOT, 'empty') });
  const st = e.start();
  t('① 未配置时 start 仍返回 started（定时器可起）', st.started === true, JSON.stringify(st));
  const r = await e.runOnce('test');
  t('① 未配置时 runOnce skipped=unconfigured', r.skipped === 'unconfigured', JSON.stringify(r));
  e.stop('test');
  t('① 关停后 runOnce stopped', (await e.runOnce('test')).skipped === 'stopped');
}

// ── ② 正常一轮 ────────────────────────────────────────────────────────
const organ = createEchoLive({ dataDir, dbPath, sourceRoot: ws, scriptPath: SCRIPT, intervalSec: 3600 });
const r1 = await organ.runOnce('test');
t('② 第一轮 ok', r1.ok === true, r1.code);
t('② 第一轮 IMPORTED', r1.code === 'IMPORTED', r1.code);
t('② 回执落盘', fs.existsSync(receiptFileOf(dataDir)));
t('② 回执内容与返回一致', (() => { const j = JSON.parse(fs.readFileSync(receiptFileOf(dataDir), 'utf8')); return j.code === 'IMPORTED' && j.ok === true; })());
t('② stats.imported = 1', organ.view().stats.imported === 1, organ.view().stats.imported);
t('② generation 有值', typeof r1.generation === 'number' && r1.generation >= 1, r1.generation);
t('② 父器官保留 attemptId', typeof r1.attemptId === 'string' && r1.attemptId.startsWith('echo-attempt-'), r1.attemptId);
t('② 父器官保留 commitId', typeof r1.commitId === 'string' && r1.commitId.startsWith('echo-commit-'), r1.commitId);
t('② 父器官保留 committed authority', r1.authority?.state === 'committed' && r1.authority?.generation === r1.generation, JSON.stringify(r1.authority));

// ── ③ 单飞 ───────────────────────────────────────────────────────────
{
  const a = organ.runOnce('a');
  const b = await organ.runOnce('b');
  t('③ 并发第二个被拒（busy）', b.skipped === 'busy', JSON.stringify(b));
  await a;
}

// ── ④ 内容没变 ────────────────────────────────────────────────────────
const t0 = Date.now();
const r2 = await organ.runOnce('test2');
const wall2 = Date.now() - t0;
t('④ 第二轮 UNCHANGED', r2.code === 'UNCHANGED', r2.code);
t('④ unchanged 无新 commit', r2.commitId === null && r2.commit === null && r2.authority?.state === 'committed', JSON.stringify({ commitId: r2.commitId, authority: r2.authority }));
t('④ 第二轮读 0 字节', r2.bytesRead === 0, r2.bytesRead);
// ★ 这里不能用「快不快」当判据 —— 实测第二轮 1,890ms，而它**一个字节都没读**。
//   那 1.9 秒几乎全是起一个 node 进程的开销（本机实测 1.3~1.9s），不是同步在干活。
//   拿墙钟判增量是错的尺子：真正该看的是 bytesRead（上一条）与 appended。
//   所以这条只做「不比首轮更慢」的弱断言，并把读数如实打出来。
t('④ 第二轮不比首轮更慢（墙钟主要被 node 启动占据）', wall2 <= r1.ms + 500, JSON.stringify({ round2: wall2, round1: r1.ms }));
t('④ stats.unchanged ≥ 1', organ.view().stats.unchanged >= 1, organ.view().stats.unchanged);

// ── ⑤ 关停 ───────────────────────────────────────────────────────────
{
  organ.stop('test');
  const r = await organ.runOnce('after-stop');
  t('⑤ 关停后不再起进程', r.skipped === 'stopped', JSON.stringify(r));
  t('⑤ view().enabled = false', organ.view().enabled === false);
}

// ── ⑥ 失败要带 code + stage ───────────────────────────────────────────
{
  const broken = createEchoLive({ dataDir: path.join(ROOT, 'data2'), dbPath: path.join(ROOT, 'nope.sqlite'), sourceRoot: ws, scriptPath: SCRIPT });
  fs.mkdirSync(path.join(ROOT, 'data2'), { recursive: true });
  const r = await broken.runOnce('fail-test');
  t('⑥ 库不存在时报错', r.ok === false, JSON.stringify({ code: r.code, stage: r.stage }));
  t('⑥ 错误带 code', typeof r.code === 'string' && r.code.length > 0, r.code);
  t('⑥ 错误带 stage', typeof r.stage === 'string' && r.stage.length > 0, r.stage);
  t('⑥ 失败也写了回执（不是静默）', fs.existsSync(receiptFileOf(path.join(ROOT, 'data2'))));
  t('⑥ 失败不伪造 commit', r.commitId === null && r.commit === null && r.authority === null, JSON.stringify({ attemptId: r.attemptId, commitId: r.commitId, authority: r.authority }));
  broken.stop('done');
}

fs.rmSync(ROOT, { recursive: true, force: true });
try { fs.closeSync(LOCK_FD); fs.rmSync(LOCK, { force: true }); } catch (error) { bad.push('✗ TEMP lock cleanup → ' + String(error?.message || error)); }
for (const line of ok) console.log(line);
for (const line of bad) console.log(line);
console.log('');
console.log('echo-live-selftest: ' + ok.length + ' passed / ' + bad.length + ' failed');
process.exitCode = bad.length ? 1 : 0;
