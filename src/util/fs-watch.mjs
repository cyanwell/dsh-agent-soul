// src/util/fs-watch.mjs —— 给 node:fs 的**同步**方法打桩：超过阈值就记一行。
//
// ★★ 2026-11-17（阶段 1）：为什么要全局打桩，而不是在几处可疑代码前手工加。
//   我先前只在 store 的 saveIndex / saveMetaCache / buildIndex:cache 三处打了桩，
//   结果一次 95 秒的运行里：loop-stall 记了 9 条（含一条 3,474ms），
//   而桩一条都没触发 —— **说明阻塞根本不在我猜的那几段里**。
//   与其继续猜下一段，不如把「所有同步文件操作」一次全罩住：
//   同步 fs 调用是 Node 里唯一能长时间按住事件循环的东西（第二是纯 CPU 循环）。
//
// ★ 开销：每个被包的调用多两次 hrtime.bigint()。实测这批方法是微秒级的，
//   纳秒计时相对它可忽略。**只包同步方法**，异步的不碰。
//
// ★ 判据：日志里出现 { fn:'readFileSync', path:'...', ms:823 } 就是直接指名道姓。

import fs from 'node:fs';

const WATCH = [
  'readFileSync', 'writeFileSync', 'appendFileSync',
  'readdirSync', 'statSync', 'lstatSync', 'fstatSync',
  'existsSync', 'openSync', 'readSync', 'writeSync', 'closeSync',
  'mkdirSync', 'unlinkSync', 'renameSync', 'realpathSync',
];

let logFile = '';
let thresholdMs = 100;
let installed = false;
const totals = new Map();

// ★★★ 2026-11-17（实测抓到的自激）：探针会**把自己噎死**。
//   现象：fs-slow.log 里 941 条记录中 **696 条是探针自己写日志**，
//         自激累计 398,637 ms（占全部记录时间 431,072 ms 的 92%），
//         最坏一次「写 fs-slow.log」用了 **14,310 ms**。
//   机制：finally 里用 fs.appendFileSync 写日志 —— 而 appendFileSync **也被包着**，
//         于是写日志本身被测量；日志越大写得越慢，越慢越超阈值，越超越多写。
//   这是**测量仪器污染被测对象**：它把 900ms 的平均卡顿大部分算给了自己。
//   修法（两道，缺一不可）：
//     ① 用**打桩前捕获的原函数**写日志 —— 不经过探针；
//     ② 加 re-entrancy 闸 —— 探针内部产生的 fs 调用一律不计。
//   另外：探针自己的日志文件永远不参与测量（它们不是业务）。
const PRISTINE = new Map();
for (const name of WATCH) if (typeof fs[name] === 'function') PRISTINE.set(name, fs[name]);
const pristineAppend = PRISTINE.get('appendFileSync') || fs.appendFileSync;
const pristineStat = PRISTINE.get('statSync') || fs.statSync;
let inProbe = false;                 // re-entrancy 闸（同步代码，单线程足够）

/** 这是不是探针自己的日志文件（是 → 不计、不记）。 */
function isProbeOwnedLog(p) {
  const s = String(p || '');
  return /(fs-slow|loop-stall|sync-spans)\.log$/.test(s);
}

export function installFsWatch(opts) {
  const o = opts || {};
  logFile = o.logFile ? String(o.logFile) : '';
  thresholdMs = Number(o.thresholdMs) > 0 ? Number(o.thresholdMs) : 100;
  if (installed || !logFile) return { installed: false, logFile, thresholdMs };
  installed = true;

  for (const name of WATCH) {
    const orig = fs[name];
    if (typeof orig !== 'function') continue;
    fs[name] = function patched(...args) {
      // ① 探针内部产生的调用：直接过，不计时、不记。
      if (inProbe) return orig.apply(fs, args);
      const t0 = process.hrtime.bigint();
      try {
        return orig.apply(fs, args);
      } finally {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        // 累计：即使单次不超阈值，累计也说明问题
        totals.set(name, (totals.get(name) || 0) + ms);
        const p = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].path) || '';
        // ② 探针自己的日志文件：不计、不记（它们不是业务）。
        if (ms >= thresholdMs && !isProbeOwnedLog(p)) {
          try {
            let size = null;
            try { if (p) size = pristineStat(p).size; } catch { /* 可能已删 */ }
            // ★★ 2026-11-17：**把调用方也记下来**。
            //   光知道「readFileSync 花了 5 秒」不够 —— 要治它必须知道**是谁让它读的**。
            //   抓栈不额外花时间（调用栈是现成的），而且不会像采样器那样制造观察者效应。
            let stack = '';
            try {
              const e = new Error();
              stack = String(e.stack || '').split('\n').slice(2, 5)
                .map((l) => l.trim().replace(/^at\s+/, '').replace(/^.*agent-soul[\\/]/, ''))
                .join(' <- ');
            } catch { /* 抓不到栈不影响 */ }
            // ③ 用**原函数**写，且整段上闸 —— 写日志这件事本身不进测量。
            inProbe = true;
            try {
              pristineAppend(logFile, JSON.stringify({
                at: new Date().toISOString(), fn: name, path: String(p).slice(-90), ms: Math.round(ms), size, pid: process.pid, stack: stack.slice(0, 320),
              }) + '\n', 'utf8');
            } finally { inProbe = false; }
          } catch { /* 记不进去不影响业务 */ }
        }
      }
    };
  }
  return { installed: true, logFile, thresholdMs, watched: WATCH.length };
}

export function fsWatchTotals() {
  return [...totals.entries()].map(([k, v]) => ({ fn: k, ms: Math.round(v) })).sort((a, b) => b.ms - a.ms);
}
