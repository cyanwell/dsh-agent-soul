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
//   ③ 精准修复：`purge`（宿主 bridge 的 cap='context' context/purge），逐条替换
//
// ── ★ 一条不能忘的纪律 ───────────────────────────────────────────────────
//
//   ③ 的成功**必须来自宿主回执**（targetSession / opId / 起止 seq / 影响帧数，四样对上）。
//   这是 `organs/cleanup.mjs` 头注里写的判据，也是 v3 栽过的地方：
//     它有 37 条 `{ok:false, error:"compaction service not found"}`，
//     而注释写着「**从没验证过成功是什么样**」。
//
//   ★ 所以这里：**没有宿主就明说没有，绝不假装修好了。**
//
// ── ★★★ 2026-11-17（task-9）：这一条链上原先有五处「看起来通了」的地方 ──────
//
//   ① 区间只取了 start：
//        `purgeFn({startSeq: start, endSeq: end})` 交给 index.mjs:643-654 的适配器，
//        而它**只读 startSeq**、一次只清一条。于是「标了 81 帧，只清 1 帧」。
//        → 修：在 `organs/huanqi-targets.mjs` 的 expandRanges 里**展开成逐条宿主 seq**。
//          （宿主那边的 purge 本身就是逐条 replace，区间操作在那里根本不存在。）
//   ② 类型不匹配：诊断提示词没限类型，执行侧硬拒非 tool/result。
//        → 修：analyzeContext 传 `onlyTypes: PURGEABLE_TYPES`，「可看的集合 = 可动的集合」。
//   ③ 部分成功报成功：原来 `anyOk = results.some(x=>x.ok)`。
//        → 修：summarizeResults —— 全成才叫 cleaned，有成有败叫 partial，全败叫 clean-failed。
//   ④ 占位文本模板化 → 下一轮被判「重复」→ 再清再写，越清越脏。
//        → 修：isPlaceholderFrame 把**已经清过的帧**排除在候选之外（循环在这里断掉）。
//          ★ 占位文本本身在 plugins/dsh-agent-soul-bridge/context-surgeon.mjs:102-104，
//            不在本仓库的作用域里 —— 这里只负责「不再对它二次动刀」。
//          ★★ 实测（2026-11-17）：生产库里**还没有真的占位块**（严格判据 0 命中）——
//            因为它们前面的 ①③⑤ 让链路走不到写占位那一步。所以这条是**闸**，不是补丁。
//   ⑤ 编号不同源（**实测查出来的**）：
//        注释原话是「ranges 的 start/end 是帧 seq；宿主的 event seq 同源，可直接用」。
//        实测 1402 个两边都有的会话、抽 4009 对帧：
//          v4 帧 seq 7 (tool_result) → meta.seq 26 (tool/result)
//          v4 帧 seq 11 (tool_result) → meta.seq 36 (tool/result)
//        4009/4009 类型吻合，但**两个编号从来不是同一个数**。
//        → 修：buildSeqMap 用 meta.seq 显式映射；缺 meta.seq 就 fail-closed。
import { analyzeContext, PURGEABLE_TYPES } from '../organs/huanqi-llm.mjs'
import {
  PURGEABLE_TYPE,
  buildSeqMap,
  expandRanges,
  summarizeResults,
  isPlaceholderFrame,
} from '../organs/huanqi-targets.mjs'

export const INTERVENE_DEFAULTS = {
  // 送去分析的帧数（太多会拖慢，而且污染总在最近）
  framesToAnalyze: 40,
  // 一次最多认几段污染区间（防手抖裁太多）
  maxRangesPerCall: 3,
  // ★ 一次最多真的清几帧。区间展开之后条数会放大（这正是缺陷①的修法），
  //   所以必须有一个上限 —— 否则「3 段区间」可能变成「两百次宿主替换」。
  maxTargetsPerCall: 40,
}

/**
 * 干预。
 *
 * @param {object} o
 * @param {string} o.sessionId
 * @param {object} o.store       SessionStore（要 recent()）
 * @param {object} o.llm         内嵌 LLM（要 chat / ready）
 * @param {object} [o.cleanup]   createTargetedCleanup 造出来的清理函数（pruner 通道，本文件不直接用）
 * @param {Function} [o.purge]   宿主清理通道（走 bridge 的 cap='context'，见下面 ③）。没有就只诊断。
 *   ★★ 2026-11-16 补：这一项**一直在被用、却一直没写进签名**（index.mjs 的
 *      huanqiIntervene 传的就是它）。缺了它看代码的人会以为这里只走 pruner。
 * @param {Function} [o.log]
 * @returns {Promise<object>}
 */
export async function intervene (o) {
  const cfg = { ...INTERVENE_DEFAULTS, ...((o && o.options) || {}) }
  const log = (o && o.log) || (() => {})
  const sessionId = o && o.sessionId
  const store = o && o.store
  const llm = o && o.llm

  const out = {
    ok: false, stage: 'start', sessionId,
    ranges: [], targets: [], rejected: [], skipped: [], cleaned: null, reason: null,
    seqMap: { mapped: 0, noHostSeq: 0, duplicates: 0 },
  }

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

  // ── ①.5 编号表（缺陷⑤）。★ 用**全部**帧建表，不用筛过的 ——
  //   区间是按帧 seq 给的，表缺一格就会把一整段误判成「不可清」。
  const seqMap = buildSeqMap(frames)
  out.seqMap = {
    mapped: seqMap.byV4.size,
    noHostSeq: seqMap.noHostSeq.length,
    dupV4: seqMap.dupV4.length,
    why: seqMap.why,
  }
  if (!seqMap.ok) {
    out.stage = 'no-seq-map'
    out.reason = '编号映射不可用：' + String(seqMap.why || '未知') + ' —— 不拿帧序号当宿主 seq 去清'
    return out
  }

  // ── ①.6 占位帧不参与分析（缺陷④：它们会被判成「重复」，然后越清越脏）
  const live = frames.filter((f) => !isPlaceholderFrame(f))
  const placeholders = frames.length - live.length
  out.alreadyCleared = placeholders

  // ── ② 找污染点
  if (!llm) { out.stage = 'analyze'; out.reason = '没有内嵌 LLM，只能报多样性、不能定位污染点'; return out }
  let verdict
  try {
    // ★ 缺陷②：只把「能动刀的类型」给模型看，而且提示词里也写明（systemPromptOf）
    verdict = await analyzeContext({ llm, frames: live, onlyTypes: PURGEABLE_TYPES, log })
  } catch (e) {
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
  out.analyzed = verdict.analyzed
  out.dropped = verdict.dropped
  out.filteredOut = verdict.filteredOut

  if (!out.polluted || !out.ranges.length) {
    out.ok = true
    out.stage = 'clean'
    out.reason = 'LLM 判断这段上下文没找到明确污染点'
    return out
  }

  // ── ②.5 区间 → 逐条宿主 seq（缺陷①）
  const expanded = expandRanges(out.ranges, seqMap, { maxTargets: cfg.maxTargetsPerCall })
  // The current frame-to-host mapping has no independently verifiable provenance.
  // Keep only diagnostic frame targets; never expose host seqs or authorize purge.
  const mappedTargets = expanded.targets
  out.targets = mappedTargets.map(({ hostSeq, ...target }) => target)
  out.provenance = { status: 'unverified', mappedTargets: mappedTargets.length, rejectedTargets: mappedTargets.length }
  out.rejected = expanded.rejected.concat(mappedTargets.map((target) => ({
    v4Seq: target.v4Seq,
    why: 'provenance-unverified: no verified v4-frame to DSH-event binding',
  })))
  out.skipped = expanded.skipped
  out.truncated = expanded.truncated

  if (mappedTargets.length) {
    out.ok = false
    out.stage = 'provenance-unverified'
    out.reason = 'provenance-unverified: no verified v4-frame to DSH-event binding; purge not invoked'
    out.executionAvailable = false
    log('[huanqi/intervene] provenance-unverified · ' + mappedTargets.length + ' mapped diagnostic targets; purge not invoked')
    return out
  }

  const purgeFn = (o && o.purge) || null
  if (typeof purgeFn !== 'function') {
    out.ok = true
    out.stage = 'diagnosed-only'
    out.reason = '**找到污染点，但没有宿主清理通道** —— 不假装修好了。ranges / 目标 seq 已给出，可人工处理'
    log('[huanqi/intervene] 诊断到 ' + out.ranges.length + ' 段污染（' + out.targets.length + ' 条可清），但无宿主，不清理')
    return out
  }
  if (!out.targets.length) {
    out.ok = false
    out.stage = 'clean-failed'
    out.reason = 'LLM 给了 ' + out.ranges.length + ' 段，但展开后一条可清的（' + PURGEABLE_TYPE + '）都没有'
      + (out.rejected.length ? '：' + out.rejected.map((x) => x.why).join('；').slice(0, 300) : '')
    return out
  }

  // ── ③ 精准修复：**逐条**，每条一个宿主 seq
  //
  //   ★ 为什么逐条而不是按区间：宿主侧的 purge 就是「eventAt(seq) → append(surfaceOp
  //     replace startSeq=seq,endSeq=seq)」（plugins/dsh-agent-soul-bridge/context-surgeon.mjs:40-62），
  //     而且 v4 这边的适配器（index.mjs:643-654）只取 startSeq。
  //     所以「区间」这个概念在这条链上**任何一层都不存在** —— 必须在调用前展开。
  const results = []
  for (const t of out.targets) {
    try {
      const res = await purgeFn({
        sessionId,
        startSeq: t.hostSeq,
        endSeq: t.hostSeq,
        reason: '换气干预：' + String(t.reason || '多样性收敛').slice(0, 80),
      })
      results.push({
        ok: Boolean(res && res.ok),
        dryRun: Boolean(res && res.dryRun),
        v4Seq: t.v4Seq,
        hostSeq: t.hostSeq,
        receipt: res,
        why: (res && (res.error || res.detail || res.code)) || null,
      })
    } catch (e) {
      results.push({
        ok: false, dryRun: false, v4Seq: t.v4Seq, hostSeq: t.hostSeq,
        why: String((e && e.message) || e).slice(0, 200),
      })
    }
  }

  out.cleaned = results
  // ★ 缺陷③：不再用 some() —— 部分成功必须报 partial，不许读成成功
  const sum = summarizeResults(results)
  out.summaryOfClean = sum

  if (sum.stage === 'diagnosed-only') {
    // dryRun：只诊断没真清。★ 这也**不是** cleaned。
    out.ok = true
    out.stage = 'diagnosed-only'
    out.reason = '这次是 dryRun（' + sum.dryRunCount + ' 条目标只诊断、没有真的清）'
  } else if (sum.stage === 'cleaned') {
    out.ok = true
    out.stage = 'cleaned'
    // ★ 上限截断也要说出来：清成的都清成了，但**还有没轮到的**。
    //   不说，下一次干预会以为这段已经干净了。
    if (out.truncated > 0) {
      out.reason = '已清 ' + sum.okCount + ' 条，还有 ' + out.truncated + ' 条超出单次上限（maxTargetsPerCall）没动 —— 下一轮再来'
    }
  } else if (sum.stage === 'partial') {
    // ★ ok:false 是故意的：11 条里成 1 条**不算做了这件事**。
    //   但仍要留下「成了哪些」—— 所以 stage 明确叫 partial，cleaned 里逐条可查。
    out.ok = false
    out.stage = 'partial'
    out.reason = '部分成功：' + sum.okCount + '/' + sum.total + ' 条清成，' + sum.failCount + ' 条失败'
      + (sum.failures.length ? '（首条：' + sum.failures[0].why + '）' : '')
  } else {
    out.ok = false
    out.stage = 'clean-failed'
    out.reason = '**清理全部失败** —— 按 cleanup.mjs 的判据，没有宿主回执就不算成功'
      + (sum.failures.length ? '（首条：' + sum.failures[0].why + '）' : '')
  }

  log('[huanqi/intervene] ' + out.stage + ' · ' + sum.okCount + '/' + sum.total + ' 条成功'
    + (out.rejected.length ? ' · ' + out.rejected.length + ' 段区间不可清' : '')
    + (placeholders ? ' · ' + placeholders + ' 帧是已清占位' : ''))
  return out
}
