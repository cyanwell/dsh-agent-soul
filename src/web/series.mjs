// 概览页的迷你趋势 —— **进程内环形缓冲**，不落盘、不读历史文件。
//
// ★ 为什么需要它：概览页现在全是「此刻的一个数」。一个数看不出变化 ——
//   「索引 14,830 行」是涨是停、「内存 413MB」是稳是漏，只有连成线才看得出来。
// ★ 为什么不做成监控系统：它只是**采样器**，不是指标库。
//   进程重启就清零 —— 那是真话（重启前的值不属于这个进程），也是刻意的：
//   不落盘就不会出现「三天前的点混在今天」，也不必处理时间戳漂移与磁盘膨胀。
// ★ 容量 60：概览页 30 秒缓存 → 60 点 ≈ 半小时窗口。

const MAX_POINTS = 60;
const pts = [];

/**
 * 记一次采样。同一秒内的重复请求不造点（缓存命中 / 页面并发都不该造假点）。
 * @returns {Array} 当前窗口内的点（旧 -> 新）
 */
export function recordOverview(o) {
  const s = o || {};
  const now = Number.isFinite(s.nowMs) ? s.nowMs : Date.now();
  const last = pts[pts.length - 1];
  if (last && now - last.at < 800) return pts.slice();
  pts.push({
    at: now,
    sessions: numOrNull(s.sessions),
    indexRows: numOrNull(s.indexRows),
    dataMB: numOrNull(s.dataMB),
    memMB: numOrNull(s.memMB),
    searchMs: numOrNull(s.searchMs),
  });
  while (pts.length > MAX_POINTS) pts.shift();
  return pts.slice();
}

/** 当前窗口（不采样）。缓存命中时用这个，让趋势仍然往前走。 */
export function getSeries() { return pts.slice(); }

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
