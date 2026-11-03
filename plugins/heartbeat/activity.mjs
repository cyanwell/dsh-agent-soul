// activity.mjs —— 算「距上次有人活动多久」（计时器）
//
// 为什么不用 state.lastUserActivityAt：
//   那个字段要「主导会话主动写」，而实际没人写 —— 依赖我记得，就等于没有。
//
// 改用**磁盘上的现成事实**：DSH 每次有人说话都会写会话日志。
//   路径  D:\AI\dsh\home\sessions\<工作区>\<会话id>\session.v4.jsonl.zstd
//   取 mtime 就行 —— 不用解压 zstd（多帧压缩解不干净）。
//
// ★ 必须排除「我自己」：本会话每轮都在写，不排掉就永远是 0 分钟。
//   排除靠路径里的会话 id，id 从 ignore 列表来。

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const SESSIONS_ROOT = join(DSH_HOME, 'sessions')

/**
 * 扫一遍所有会话文件，找最新的 mtime。
 * @param {string[]} ignore 会话 id 片段，命中就跳过（通常是「本会话」）
 * @param {number} maxDepth
 */
export function scanSessions(ignore = [], maxDepth = 3) {
  let newest = { t: 0, path: '', id: '' }
  let total = 0
  let skipped = 0

  function walk(dir, depth) {
    if (depth > maxDepth) return
    let ents
    try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = join(dir, e.name)
      if (e.isDirectory()) { walk(p, depth + 1); continue }
      if (!e.name.endsWith('.zstd') && !e.name.endsWith('.jsonl')) continue
      total++
      // 路径里任一 ignore 片段命中就跳过
      if (ignore.some((frag) => frag && p.includes(frag))) { skipped++; continue }
      try {
        const st = statSync(p)
        if (st.mtimeMs > newest.t) {
          newest = { t: st.mtimeMs, path: p, id: p.match(/session-([0-9a-f-]+)/)?.[1] || '' }
        }
      } catch { /* 单个文件失败不影响整体 */ }
    }
  }

  walk(SESSIONS_ROOT, 0)
  return {
    ok: newest.t > 0,
    lastActivityAt: newest.t ? new Date(newest.t).toISOString() : null,
    lastActivityMs: newest.t || null,
    lastSessionId: newest.id,
    total,
    skipped,
  }
}

/** 距上次活动多少分钟；拿不到就 null */
export function idleMinutes(ignore = [], now = Date.now()) {
  const r = scanSessions(ignore)
  if (!r.ok) return { ok: false, minutes: null, why: '扫不到任何会话文件' }
  return {
    ok: true,
    minutes: Math.round((now - r.lastActivityMs) / 60000),
    lastActivityAt: r.lastActivityAt,
    lastSessionId: r.lastSessionId,
    scanned: r.total,
    skipped: r.skipped,
  }
}
