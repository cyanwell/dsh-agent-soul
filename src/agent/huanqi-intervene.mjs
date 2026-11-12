// ★★★ 换气 · 干预：过红线 → 调内嵌 LLM 检测上下文 → 精准修复
//
// ── 这一环为什么重要（爀曦 2026-11-13）──────────────────────────────────
//
//   「过了预警机制的红线，换气就要开始**干预**，调用 soul 内嵌的 LLM
//    去**检测宿主会话的上下文**，并做**精准修复**。
//    **而不是等到极端场景，触发了截断熔断才做。**」
//
//   ★ v3 的教训：它只在「熔断」这一刻才动手 —— 而熔断意味着**已经烧掉了整轮预算**。
//   ★ v4 要做的是：**在多样性刚开始收敛时就动手**。
//
// ── 三步 ─────────────────────────────────────────────────────────────────
//
//   ① 取上下文：从 store 拿这个会话最近的帧
//   ② 找污染点：`analyzeContext`（内嵌 LLM，语义判断）→ ranges[{start,end,kinds,reasons}]
//   ③ 精准修复：`createTargetedCleanup` 调宿主 pruner，只裁那几个 seq
//
// ── ★ 一条不能忘的纪律 ───────────────────────────────────────────────────
//
//   ③ 的成功**必须来自宿主回执**（targetSession / opId / 起止 seq / 影响帧数，四样对上）。
//   这是 `organs/cleanup.mjs` 头注里写的判据，也是 v3 栽过的地方：
//     它有 37 条 `{ok:false, error:"compaction service not found"}`，
//     而注释写着「**从没验证过成功是什么样**」。
//
//   ★ 所以这里：**没有宿主就明说没有，绝不假装修好了。**
import { analyzeContext } from '../organs/huanqi-llm.mjs'

export const INTERVENE_DEFAULTS = {
  // 送去分析的帧数（太多会拖慢，而且污染总在最近）
  framesToAnalyze: 40,
  // 一次最多裁几段（防手抖裁太多）
  maxRangesPerCall: 3,
}

/**
 * 干预。
 *
 * @param {object} o
 * @param {string} o.sessionId
 * @param {object} o.store       SessionStore（要 recent()）
 * @param {object} o.llm         内嵌 LLM（要 chat / ready）
 * @param {object} [o.cleanup]   createTargetedCleanup 造出来的清理函数（没有就只诊断）
 * @param {Function} [o.log]
 * @returns {Promise<object>}
 */
export async function intervene (o) {
  const cfg = { ...INTERVENE_DEFAULTS, ...((o && o.options) || {}) }
  const log = (o && o.log) || (() => {})
  const sessionId = o && o.sessionId
  const store = o && o.store
  const llm = o && o.llm
  const cleanup = o && o.cleanup

  const out = { ok: false, stage: 'start', sessionId, ranges: [], cleaned: null, reason: null }

  // ── ① 取上下文
  if (!store || typeof store.recent !== 'function') {
    out.reason = '没有 store，取不到会话上下文'
    return out
  }
  let frames = []
  try { frames = store.recent(sessionId, cfg.framesToAnalyze) || [] } catch (e) {
    out.reason = '取帧失败：' + String((e && e.message) || e)
    return out
  }
  if (!frames.length) { out.reason = '这个会话没有帧'; return out }

  // ── ② 找污染点
  if (!llm) { out.stage = 'analyze'; out.reason = '没有内嵌 LLM，只能报多样性、不能定位污染点'; return out }
  let verdict
  try { verdict = await analyzeContext({ llm, frames, log }) } catch (e) {
    out.stage = 'analyze'
    out.reason = 'LLM 分析失败：' + String((e && e.message) || e)
    return out
  }
  if (!verdict || verdict.ok === false) {
    out.stage = 'analyze'
    out.reason = 'LLM 分析不可用：' + String((verdict && verdict.error) || '未知')
    return out
  }

  out.stage = 'analyzed'
  out.ranges = Array.isArray(verdict.ranges) ? verdict.ranges.slice(0, cfg.maxRangesPerCall) : []
  out.polluted = Boolean(verdict.polluted)
  out.summary = String(verdict.summary || '').slice(0, 500)

  if (!out.polluted || !out.ranges.length) {
    out.ok = true
    out.stage = 'clean'
    out.reason = 'LLM 判断这段上下文没找到明确污染点'
    return out
  }

  // ── ③ 精准修复（★ 2026-11-13 改：走 bridge 的 context/purge，不再走 pruner）
  //
  //   ★ 为什么换路：pruner 要 DSH 的 toolResultPruner 服务（拿不到、还要开 prunerLive、
  //     而且它是 DSH 侧插件会跟着 DSH 更新变）。
  //   ★ 现在走 bridge 的 cap='context'：直接用 Session API 的 surfaceOp，零第三方依赖。
  //   实测（2026-11-13 17:40）：purged ok, seq 18972 → newSeq 19079。
  const purgeFn = (o && o.purge) || null
  if (typeof purgeFn !== 'function') {
    out.ok = true
    out.stage = 'diagnosed-only'
    out.reason = '**找到污染点，但没有宿主清理通道** —— 不假装修好了。ranges 已给出，可人工处理'
    log('[huanqi/intervene] 诊断到 ' + out.ranges.length + ' 段污染，但无宿主，不清理')
    return out
  }

  const results = []
  for (const r of out.ranges) {
    // ★ ranges 的 start/end 是帧 seq；宿主的 event seq 同源，可直接用。
    //   如果 start≠end，按「取 start」处理（purge 是逐条替换，不是区间操作）。
    const start = Number(r && r.start), end = Number(r && (r.end != null ? r.end : r.start))
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      results.push({ ok: false, why: '这段没有可用的 seq 范围', range: r })
      continue
    }
    try {
      const res = await purgeFn({
        sessionId,
        startSeq: start,
        endSeq: end,
        reason: '换气干预：' + String((r && r.reasons && r.reasons[0]) || (r && r.kinds && r.kinds[0]) || '多样性收敛').slice(0, 80),
      })
      results.push({ ok: Boolean(res && res.ok), start, end, receipt: res })
    } catch (e) {
      results.push({ ok: false, start, end, why: String((e && e.message) || e).slice(0, 200) })
    }
  }

  out.cleaned = results
  const anyOk = results.some((x) => x.ok)
  out.ok = anyOk
  out.stage = anyOk ? 'cleaned' : 'clean-failed'
  if (!anyOk) out.reason = '**清理全部失败** —— 按 cleanup.mjs 的判据，没有宿主回执就不算成功'
  log('[huanqi/intervene] ' + out.stage + ' · ' + results.filter((x) => x.ok).length + '/' + results.length + ' 段成功')
  return out
}