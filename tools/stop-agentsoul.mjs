// stop-agentsoul.mjs —— 优雅停掉 AgentSoul 软件（核 + 壳），并核对这次退出是否 graceful。
//
// ★ 为什么要有它：2026-11-11 凌晨我手动重启了七八次，每次都是 `curl /api/shutdown` 之后
//   `Stop-Process -Force` 把壳杀掉 —— 壳根本没机会走完优雅退出，于是 shutdown.log 里
//   连续三条 `shell:timeout`、`cacheDirty: true`。后果不是「难看」，是**下次启动要重建索引**
//   （15,000+ 行），而那正是「打开页面等 4 秒」的来源。
//
// ★ 正确顺序：先请核自己退 → 等它真的退 → 读日志核对 graceful → 壳若还在再收壳。
//   判定用日志，不用「看起来没了」。

import fs from 'node:fs';
import path from 'node:path';

const PORT = process.env.AGENT_SOUL_PORT || '7310';
const BASE = 'http://127.0.0.1:' + PORT;
const LOG = process.env.AGENT_SOUL_DATA
  ? path.join(process.env.AGENT_SOUL_DATA, 'data', 'shutdown.log')
  : 'D:/AI/agent-soul/dist/AgentSoul/data/shutdown.log';

async function health(ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms || 2000);
  try {
    const r = await fetch(BASE + '/api/health', { signal: ac.signal });
    return r.ok ? await r.json() : null;
  } catch { return null; } finally { clearTimeout(t); }
}

function readLastShutdown() {
  try {
    const lines = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
    return JSON.parse(lines[lines.length - 1]);
  } catch { return null; }
}

async function main() {
  const before = await health();
  if (!before) { console.log('核没在跑（' + BASE + ' 无应答）—— 无需停止'); return; }
  console.log('核 pid=' + before.pid + '，请求优雅退出…');
  try { await fetch(BASE + '/api/shutdown', { method: 'POST' }); } catch { /* 它可能立刻断开 */ }

  const t0 = Date.now();
  let gone = false;
  while (Date.now() - t0 < 20000) {
    await new Promise((r) => setTimeout(r, 400));
    if (!(await health(1200))) { gone = true; break; }
  }
  console.log(gone ? ('核已退出 · ' + (Date.now() - t0) + 'ms') : '核 20 秒内没退 —— 需要外部处理');

  const last = readLastShutdown();
  if (last) {
    console.log('shutdown.log 最后一条：' + (last.graceful ? '✔ graceful' : '✘ 非优雅（' + last.reason + '）')
      + ' · cacheDirty=' + last.cacheDirty + ' · ' + last.ms + 'ms');
    if (!last.graceful) process.exitCode = 2;
  } else {
    console.log('（读不到 shutdown.log：' + LOG + '）');
  }

  // 壳：核退了壳还在 —— 这是本机的常态（见 README「停软件」一节）。到这里才收它。
  if (process.env.AGENT_SOUL_KEEP_SHELL === '1') { console.log('保留壳（AGENT_SOUL_KEEP_SHELL=1）'); return; }
  console.log((await health(1200)) ? '核又起来了（壳重启了核？）' : '核确认不在');
}

main();