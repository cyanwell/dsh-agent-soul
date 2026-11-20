// src/util/sync-timer.mjs —— 量「某一段同步代码占了多久」，超阈值就记一行。
//
// ★★ 2026-11-17（阶段 1）：为什么不用采样器。
//   我在 loop-stall 探针里试过 busy-wait 抓 CPU profile —— 结果探针自己变成了
//   造卡顿的机器（100 秒记出 259 条"阻塞"，热帧全是采样器自己）。
//   **在同步段里做同步采样，测到的必然是采样器。** 这是观测者效应，不是 bug。
//
//   正确做法是**打桩**：在自己知道的同步大段前后各记一个时间戳，差值超阈值就记一行。
//   它只测「我明确包起来的那一段」，不会把别处的卡顿记到自己头上，
//   而且开销是两次 process.hrtime.bigint()（纳秒级）。
//
// ★ 判据：桩的**名字**必须能被搜到（形如 'store:buildIndex:cache'），
//   这样日志里出现 'store:buildIndex:cache 823ms' 时，一眼知道去哪一行看。

import fs from 'node:fs';

const enabled = process.env.AGENT_SOUL_SYNCTRACE !== 'off';
let logFile = '';
let thresholdMs = 200;
let file = null;

export function installSyncTimer(opts) {
  const o = opts || {};
  logFile = o.logFile ? String(o.logFile) : '';
  thresholdMs = Number(o.thresholdMs) > 0 ? Number(o.thresholdMs) : 200;
  return { logFile, thresholdMs, enabled: enabled && Boolean(logFile) };
}

/**
 * 包住一段同步代码：超阈值就记一行（含桩名与毫秒）。
 * ★ 它不改任何行为 —— 返回值原样透传，抛错原样抛出。
 */
export function span(name, fn) {
  if (!enabled || !logFile) return fn();
  const t0 = process.hrtime.bigint();
  try {
    return fn();
  } finally {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (ms >= thresholdMs) {
      try {
        fs.appendFileSync(logFile, JSON.stringify({
          at: new Date().toISOString(), span: name, ms: Math.round(ms), pid: process.pid,
        }) + '\n', 'utf8');
      } catch { /* 记不进去不影响业务 */ }
    }
  }
}

/** 异步版：用 await 包住一段（量的是总墙钟，含其中所有 await） */
export async function spanAsync(name, fn) {
  if (!enabled || !logFile) return fn();
  const t0 = process.hrtime.bigint();
  try {
    return await fn();
  } finally {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (ms >= thresholdMs) {
      try {
        fs.appendFileSync(logFile, JSON.stringify({
          at: new Date().toISOString(), span: name, ms: Math.round(ms), pid: process.pid, async: true,
        }) + '\n', 'utf8');
      } catch { /* ignore */ }
    }
  }
}
