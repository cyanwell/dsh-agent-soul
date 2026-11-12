// ★★★ 换气判据 v5：滚动窗口 + 三档（2026-11-13 完成标定与形态验证）
//
// ── 为什么从「连续 3 轮」改成「滚动窗口中位数」────────────────────────────
//
//   调查报告（4 个主导会话 / 25,696 条推理）发现：
//     **退化是「发作」，不是「渐进」** —— 低多样性只占 2.7%~3.6%，但成簇（4~18 簇），
//     最大一簇连续 285 条。
//
//   ★ 「连续 3 轮都低」这个判据有个致命弱点：
//     **被一次短回复打断就清零** —— 而短回复的多样性天然是 1.0（38 字就是 1.000，实测过）。
//     于是整簇 285 条可能因为中间插了一句短话就完全漏掉。
//
//   ★ 改成「最近 N 条长推理的**中位数**」：
//     · 中位数天然抗离群（一条短回复不影响）
//     · 不要求「连续」—— 它看的是「这一段整体在什么水平」
//     · 能更早触发（第 2~3 条长推理就有数）
//
// ── 三档（照水位那套的写法）────────────────────────────────────────────
//
//   观察  median ≤ 0.25   只记录，不动
//   预警  median ≤ 0.15   落 event + 面板亮（**这里开始干预的方向就确定了**）
//   干预  median ≤ 0.10   调内嵌 LLM 检测上下文 → 找污染点 → 精准修复
//
//   ★ 阈值依据（调查报告第五节）：
//     真退化 多样性 0.02~0.08 · 正常 p50 0.42~0.60 —— 两者不重叠，中间是空带。
import { declStats } from './process-guard.mjs'

export const DECL_DEFAULTS = {
  // 窗口：取最近多少条「长推理」算中位数
  // ★ 2026-11-13 自检发现：5 太慢 —— 要连续 5 条长推理才反映当前状态，
  //   而退化簇可能只有 10~20 轮（实测最大簇 285 条，但小簇只有 18 条）。
  //   3 条够反映趋势，而且不会像 2 条那样被单条离群带偏。
  windowSize: 3,
  // 字数门槛：太短的一段多样性没有统计意义（38 字的回复天然 1.0）
  minChars: 300,
  // 三档阈值（中位数）
  watchAt: 0.25,
  warnAt: 0.15,
  interveneAt: 0.10,
  // 同一档位重复触发的最小间隔（避免每轮都喊）
  rearmTurns: 3,
}

export const LEVEL = { NONE: 'none', WATCH: 'watch', WARN: 'warn', INTERVENE: 'intervene' }

function median (arr) {
  if (!arr.length) return null
  const s = arr.slice().sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * 滚动窗口：按会话维护「最近 N 条长推理」的多样性序列。
 *
 * ★ 只收长推理（≥300 字）—— 短的不进窗口，因为它们会把中位数拉高（假正常）。
 */
export class DeclWindow {
  constructor (opts) {
    this.c = { ...DECL_DEFAULTS, ...(opts || {}) }
    this.bySession = new Map()
  }

  #slot (sessionId) {
    let s = this.bySession.get(sessionId)
    if (!s) { s = { uniq: [], turns: 0, lastLevel: LEVEL.NONE, sinceFire: 0 }; this.bySession.set(sessionId, s) }
    return s
  }

  /**
   * 记一轮，返回判定。
   * @param {string} sessionId
   * @param {string} reasoning 这一轮的推理全文
   * @returns {{level:string, median:number|null, uniqRatio:number, chars:number, n:int, window:number[], reason?:string}|null}
   */
  push (sessionId, reasoning) {
    const text = String(reasoning || '')
    const st = declStats(text)
    const slot = this.#slot(sessionId)
    slot.turns++
    slot.sinceFire++

    // ★ 只把「够长」的放进窗口 —— 短的会制造假正常
    const long = text.length >= this.c.minChars
    if (long) {
      slot.uniq.push(Math.round(st.uniqRatio * 1000) / 1000)
      while (slot.uniq.length > this.c.windowSize) slot.uniq.shift()
    }

    const med = median(slot.uniq)
    if (med === null) return null

    let level = LEVEL.NONE
    if (med <= this.c.interveneAt) level = LEVEL.INTERVENE
    else if (med <= this.c.warnAt) level = LEVEL.WARN
    else if (med <= this.c.watchAt) level = LEVEL.WATCH

    // ★ 只在「档位没变低」时才重报 —— 免得每轮都喊
    const rank = { none: 0, watch: 1, warn: 2, intervene: 3 }
    const escalated = rank[level] > rank[slot.lastLevel]
    const rearm = slot.sinceFire >= this.c.rearmTurns
    slot.lastLevel = level
    if (escalated || (level !== LEVEL.NONE && rearm)) slot.sinceFire = 0

    return {
      level,
      median: Math.round(med * 1000) / 1000,
      uniqRatio: st.uniqRatio,
      chars: text.length,
      n: slot.uniq.length,
      window: slot.uniq.slice(),
      watchAt: this.c.watchAt,
      warnAt: this.c.warnAt,
      interveneAt: this.c.interveneAt,
      escalated,
      shouldReport: escalated || (level !== LEVEL.NONE && rearm),
      top: st.top.slice(0, 3),
    }
  }

  /** 看某个会话当前状态（调试/面板用） */
  peek (sessionId) {
    const s = this.bySession.get(sessionId)
    if (!s) return null
    return { window: s.uniq.slice(), median: median(s.uniq), level: s.lastLevel, turns: s.turns }
  }

  reset (sessionId) { this.bySession.delete(sessionId) }
}