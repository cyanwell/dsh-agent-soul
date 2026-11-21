#!/usr/bin/env node
// runner：跑完 tools/ 下全部 *-selftest.mjs（2026-11-18 从 _run-all-selftests.mjs 转正）
//
// ★ 十个套件一批、每套独立进程、stdio 直连文件、单条超时强杀、每完成一条就 flush summary.json。
//   这些设计都是被同一个问题逼出来的：**一个卡死的套件会拖垮整个循环**。
//   2026-11-18 之前用「前台串行跑」的方式，两次撞上 worker-exit，40–80 号套件全丢，
//   而 exit code 又不可信（PowerShell 会把 node 的 ExperimentalWarning 判成 NativeCommandError）。
//   所以现在：① 不信 exit code，只认断言文本（判红请看 rescan-selftests.mjs）；
//             ② 每个套件独立进程，卡死就 taskkill 自己，不影响别人。
//
// 用法：
//   node tools/run-all-selftests.mjs                # 全跑
//   node tools/run-all-selftests.mjs --only=echo    # 只跑名字含 echo 的
//   SELFTEST_TIMEOUT_MS=600000 node tools/run-all-selftests.mjs   # 放宽单条超时
// 设计：每个套件起独立进程、stdio 直连文件（不开管道，避免 EPERM/cleanup 问题）、
//       单条超时强杀、每完成一条就 flush summary.json（随时可轮询进度）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd()
const TOOLS = path.join(ROOT, 'tools');
const OUT = path.join(ROOT, '_selftest_logs');
fs.mkdirSync(OUT, { recursive: true });

const NODE = process.execPath;
const TIMEOUT_MS = Number(process.env.SELFTEST_TIMEOUT_MS || 300000);

const argv = process.argv.slice(2);
const onlyArg = (argv.find((a) => a.startsWith('--only=')) || '').slice(7);
const skipArg = (argv.find((a) => a.startsWith('--skip=')) || '').slice(7);

let files = fs.readdirSync(TOOLS).filter((f) => f.endsWith('-selftest.mjs')).sort();
if (onlyArg) files = files.filter((f) => f.includes(onlyArg));
if (skipArg) files = files.filter((f) => !f.includes(skipArg));

const startedAt = new Date().toISOString();
const summaryPath = path.join(OUT, 'summary.json');
const results = [];
let current = null;

function flush() {
  const body = {
    startedAt,
    updatedAt: new Date().toISOString(),
    total: files.length,
    done: results.length,
    current,
    counts: {
      ok: results.filter((r) => r.verdict === 'ok').length,
      suspicious: results.filter((r) => r.verdict === 'suspicious').length,
      timeout: results.filter((r) => r.verdict === 'timeout').length,
      crashed: results.filter((r) => r.verdict === 'crashed').length,
    },
    results,
  };
  fs.writeFileSync(summaryPath, JSON.stringify(body, null, 2), 'utf8');
}

const RX_ERR = /\b(TypeError|SyntaxError|ReferenceError|AssertionError|RangeError|ERR_[A-Z_]+):|^\s*Error: /;
const RX_FAIL = /\bFAIL\b|✗|✘|not ok\b|断言失败|失败：/;

function scanTail(logPath) {
  let text = '';
  try { text = fs.readFileSync(logPath, 'utf8'); } catch { return { tail: [], failLines: [], errLines: [] }; }
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const failLines = [];
  const errLines = [];
  for (const l of lines) {
    if (RX_FAIL.test(l)) failLines.push(l.trim().slice(0, 220));
    else if (RX_ERR.test(l)) errLines.push(l.trim().slice(0, 220));
  }
  return {
    tail: lines.slice(-18).map((l) => l.trim().slice(0, 220)),
    failLines: [...new Set(failLines)].slice(0, 25),
    errLines: [...new Set(errLines)].slice(0, 25),
    bytes: Buffer.byteLength(text, 'utf8'),
  };
}

function runOne(name) {
  return new Promise((resolve) => {
    const file = path.join(TOOLS, name);
    const logPath = path.join(OUT, name.replace(/\.mjs$/, '') + '.log');
    const fd = fs.openSync(logPath, 'w');
    const t0 = Date.now();
    let killed = false;
    const child = spawn(NODE, [file], {
      cwd: ROOT,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    const timer = setTimeout(() => {
      killed = true;
      try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
    }, TIMEOUT_MS);
    child.on('exit', (code) => {
      clearTimeout(timer);
      try { fs.closeSync(fd); } catch {}
      const durationMs = Date.now() - t0;
      const scan = scanTail(logPath);
      let verdict = 'ok';
      if (killed) verdict = 'timeout';
      else if (scan.failLines.length > 0) verdict = 'suspicious';
      else if (code === null || (code !== 0 && /Uncaught|UnhandledPromiseRejection/.test(scan.tail.join('\n')))) verdict = 'crashed';
      resolve({ name, exitCode: code, durationMs, verdict, logPath, ...scan });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      try { fs.closeSync(fd); } catch {}
      resolve({ name, exitCode: null, durationMs: Date.now() - t0, verdict: 'crashed', error: String(e && e.message), logPath, tail: [], failLines: [], errLines: [] });
    });
  });
}

(async () => {
  flush();
  for (const name of files) {
    current = name;
    flush();
    const r = await runOne(name);
    results.push(r);
    current = null;
    flush();
    console.log('[done]', name, r.verdict, r.durationMs + 'ms', 'exit=' + r.exitCode);
  }
  current = null;
  flush();
  console.log('[all finished] ok=' + results.filter((r) => r.verdict === 'ok').length + ' suspicious=' + results.filter((r) => r.verdict === 'suspicious').length);
})();
