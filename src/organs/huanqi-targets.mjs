// 换气 · 编号桥 —— 把「LLM 看到的 seq」翻成「宿主能动的 seq」
// ============================================================================
// ★★★ 这个文件存在的理由（2026-11-17 · task-9 缺陷⑤，实测查出来的）：
//
//   `huanqi-intervene.mjs` 原来在 :114-115 写着一句注释：
//     「★ ranges 的 start/end 是帧 seq；宿主的 event seq 同源，可直接用。」
//   **那句话是错的。** 实测（1402 个两边都有的会话，抽 4009 对帧）：
//
//     v4 frames.jsonl 的 seq   = 0,1,2,3…         ← 容器自己数的**帧序号**
//     DSH 事件的 seq            = 13,14,26,36…     ← 宿主那边的事件序号
//     两者的换算只有一个入口：**帧上的 meta.seq**
//
//   证据形状（sid b4c2430c…）：
//     v4 seq 7  (tool_result)  → meta.seq 26 (tool/result)
//     v4 seq 11 (tool_result)  → meta.seq 36 (tool/result)
//     4009/4009 对「按 meta.seq 取到的事件类型」与「帧类型」逐条吻合，0 不符。
//
//   ★ 也就是说：**编号不是同源，但可映射，而且映射是可靠的那一种。**
//     所以这里不拒绝，而是显式映射；**缺 meta.seq 就 fail-closed 拒绝** ——
//     拿 v4 的帧序号当宿主 seq 去清，会清掉**另一条完全不相关的事件**
//     （或者因为类型不对被 bridge 拒掉，看起来像「清了但没清成」）。
//
// ── 可清集合 = 可动集合 ────────────────────────────────────────────────
// ② 的另一半修在这里：bridge 的 context-surgeon **硬检查** `type === 'tool/result'`，
//   而 analyzeContext 的提示词原来没限定类型 —— LLM 指向 assistant 推理帧时全部失败。
//   所以「给 LLM 看的集合」必须**恰好**等于「能动刀的集合」：
//   非 tool_result 帧根本不进候选。这一条由 analyzeContext 的 onlyTypes 落实，
//   这里只负责在展开区间时再核一遍（防御性：万一 LLM 硬编了一个越界 seq）。
// ============================================================================

/** 能被宿主替换的帧类型 —— 与 plugins/dsh-agent-soul-bridge/context-surgeon.mjs:46 的硬检查对齐。 */
export const PURGEABLE_TYPE = 'tool_result';

/**
 * 占位帧识别（④）。
 *
 * ★ 为什么要认它：bridge 会写 `[换气] 定点清除 seq N（原因：…）原文可取回：log:…`
 *   （plugins/dsh-agent-soul-bridge/context-surgeon.mjs:102-104）。
 *   这段文本**逐字模板化、只换 seq 和原因**。而 analyzeContext 的判据里
 *   「重复 = 同一段内容出现两次以上」，于是清过两次之后**占位自己就构成污染证据**，
 *   再清一次 → 再写一个几乎一样的占位 → **越清越脏**。
 *   ★ 修法不是「让占位更好看」（那在 bridge 里，不在本仓库的作用域），
 *     而是：**已经清过的帧不再进候选、也不再被清**。循环在这里断掉。
 *
 * ★★ 2026-11-17 实测诚实说明：**生产库上还没有观测到这 266 次「定点清除」字样属于
 *   真的占位块** —— 严格按「正文以 `[换气] 定点清除` 开头」扫最近 60 个宿主会话，
 *   命中 **0** 条；v4 镜像 1408 个会话里命中 0 条。命中的全是文档/源码正文里
 *   提到这四个字的内容。
 *   也就是说：④ 目前是**机制上成立、尚未被生产数据证实**的一条，
 *   因为它前面的 ①③⑤ 让清理链路根本走不到「写占位」那一步。
 *   → 这条识别仍然必要（它是那道循环唯一的闸），但**不许在汇报里说它修好了一次真实事故**。
 *   ★ 判据用两个特征之一：开头标记，或「原文可取回」这句话。
 *     v3 的旧占位是 `[换气] 定点清除 seq …（原文可取回 log:…）` —— 中间没有冒号，
 *     所以两个正则分开写，别指望一条覆盖。
 */
const PLACEHOLDER_PATTERNS = [
  /^\s*\[换气\]\s*定点清除\s*seq\b/,
  /原文可取回[：:]\s*log:/,
  /（这是清除留下的占位/,
]

/** 一段文本是不是「换气清除留下的占位」。 */
export function isPlaceholderText (text) {
  const t = String(text == null ? '' : text)
  if (!t) return false
  for (const re of PLACEHOLDER_PATTERNS) if (re.test(t)) return true
  return false
}

/** 一帧的可检索正文（不同 type 落在不同字段上，与 migrate/dsh.mjs 的取法一致）。 */
export function frameTextOf (frame) {
  const f = frame || {}
  if (typeof f.text === 'string' && f.text) return f.text
  if (typeof f.content === 'string' && f.content) return f.content
  return ''
}

/** 这一帧是不是「已经清过的占位」。 */
export function isPlaceholderFrame (frame) {
  return isPlaceholderText(frameTextOf(frame))
}

/** v4 帧序号（容器自己数的）。拿不到就是 NaN —— 不拿 0 顶替。 */
export function frameSeqOf (frame) {
  const n = Number(frame && frame.seq)
  return Number.isInteger(n) && n >= 0 ? n : NaN
}

/**
 * 宿主事件序号 —— **唯一**的换算入口。
 * ★ 只认 `meta.seq`（migrate/dsh.mjs:202 写进去的那个 r.seq）。
 *   没有就返回 NaN：**绝不退回帧序号**，那正是缺陷⑤的成因。
 */
export function hostSeqOf (frame) {
  const m = frame && frame.meta
  const n = Number(m && m.seq)
  return Number.isInteger(n) && n >= 0 ? n : NaN
}

/** 可清 = 类型对 + 不是占位（占位再清只会再写一个占位）。 */
export function isPurgeableFrame (frame) {
  return String(frame && frame.type) === PURGEABLE_TYPE && !isPlaceholderFrame(frame)
}

/**
 * 从一批帧造「v4 seq → 宿主 seq」表。
 *
 * @returns {{
 *   ok:boolean, byV4:Map<number,{v4Seq:number,hostSeq:number,type:string}>,
 *   noHostSeq:number[], dupV4:number[], byType:Record<string,number>, why:string|null
 * }}
 *   ★ noHostSeq 是**真实存在的缺口**（老会话在 meta.seq 之前迁进来的），必须能被看见。
 *   ★ dupV4 是「同一个 v4 seq 出现两次」—— 那说明 frames.jsonl 被两个写者追加过，
 *     不是正常形状；**保留第一条**（先写的那条），但把这件事报出来。
 */
export function buildSeqMap (frames) {
  const list = Array.isArray(frames) ? frames : []
  const byV4 = new Map()
  const noHostSeq = []
  const dupV4 = []
  const byType = {}
  for (const f of list) {
    const v4 = frameSeqOf(f)
    if (!Number.isInteger(v4)) continue
    const type = String((f && f.type) || 'unknown')
    byType[type] = (byType[type] || 0) + 1
    const host = hostSeqOf(f)
    if (!Number.isInteger(host)) { noHostSeq.push(v4); continue }
    if (byV4.has(v4)) { dupV4.push(v4); continue }
    byV4.set(v4, { v4Seq: v4, hostSeq: host, type })
  }
  if (!byV4.size) {
    return {
      ok: false, byV4, noHostSeq, dupV4, byType,
      why: list.length
        ? '这批帧一条都没有 meta.seq（' + list.length + ' 帧）—— 没有宿主编号就没法核对清的是哪一条，拒绝'
        : '没有帧',
    }
  }
  return { ok: true, byV4, noHostSeq, dupV4, byType, why: null }
}

/**
 * 把 LLM 给的 ranges 展开成**逐条宿主 seq**（缺陷①的修法就在这里）。
 *
 * ★ 为什么要展开：区间操作在宿主那边**不存在**。
 *   bridge 的 purge 是「逐条 eventAt(seq) + append(surfaceOp replace startSeq=seq,endSeq=seq)」，
 *   而 v4 的 index.mjs:643-654 那个适配器**只取 startSeq**。
 *   所以「标了 81 帧只清 1 帧」不是宿主小气，是这条链上没有任何一处做过展开。
 *   展开放在这里，是因为这里是**唯一同时握着 ranges 和 seq 表**的地方。
 *
 * ★ 区间里混着不可清的帧是**常态**（一段绕圈里既有 tool_result 也有 assistant）：
 *   把可清的挑出来，把跳过的**按类型数清楚**报回去 —— 不是静默丢。
 *   一个区间里一帧都挑不出来才算 rejected。
 *
 * @param {Array} ranges  analyzeContext 的输出（{start,end,kinds,reasons}，单位是 v4 帧 seq）
 * @param {object} seqMap buildSeqMap 的结果
 * @param {{maxTargets?:number}} [opts]
 * @returns {{targets:Array, rejected:Array, skipped:Array, truncated:number, why:string|null}}
 */
export function expandRanges (ranges, seqMap, opts) {
  const o = opts || {}
  const max = Number(o.maxTargets) > 0 ? Number(o.maxTargets) : 40
  const map = (seqMap && seqMap.byV4) || new Map()
  const out = { targets: [], rejected: [], skipped: [], truncated: 0, why: null }
  if (!seqMap || seqMap.ok !== true) {
    out.why = (seqMap && seqMap.why) || '没有可用的编号映射表'
    return out
  }
  const list = Array.isArray(ranges) ? ranges : []
  const seen = new Set()
  for (let i = 0; i < list.length; i++) {
    const r = list[i] || {}
    const a = Number(r.start)
    const b = Number(r.end != null ? r.end : r.start)
    if (!Number.isInteger(a) || !Number.isInteger(b) || b < a) {
      out.rejected.push({ range: r, why: '区间不合法（start=' + JSON.stringify(r.start) + ' / end=' + JSON.stringify(r.end) + '）' })
      continue
    }
    const skippedHere = {}
    let took = 0
    for (let v4 = a; v4 <= b; v4++) {
      const hit = map.get(v4)
      if (!hit) { skippedHere['(不在分析窗口里的 seq)'] = (skippedHere['(不在分析窗口里的 seq)'] || 0) + 1; continue }
      if (hit.type !== PURGEABLE_TYPE) { skippedHere[hit.type] = (skippedHere[hit.type] || 0) + 1; continue }
      if (seen.has(hit.hostSeq)) { skippedHere['(同一宿主 seq 已排进本次清理)'] = (skippedHere['(同一宿主 seq 已排进本次清理)'] || 0) + 1; continue }
      seen.add(hit.hostSeq)
      out.targets.push({
        v4Seq: hit.v4Seq,
        hostSeq: hit.hostSeq,
        type: hit.type,
        rangeIndex: i,
        reason: String(((r.reasons && r.reasons[0]) || (r.kinds && r.kinds[0]) || '多样性收敛')).slice(0, 80),
      })
      took += 1
    }
    if (!took) {
      out.rejected.push({
        range: r,
        why: '这个区间里没有一帧可以清（' + Object.entries(skippedHere).map(([k, v]) => k + '×' + v).join(' / ') + '）',
      })
    } else if (Object.keys(skippedHere).length) {
      out.skipped.push({ range: r, kept: took, skippedByType: skippedHere })
    }
  }
  if (out.targets.length > max) {
    out.truncated = out.targets.length - max
    out.targets = out.targets.slice(0, max)
  }
  return out
}

/**
 * 把逐条结果聚合成**一个诚实的结论**（缺陷③的修法就在这里）。
 *
 * ★ 原来的写法是 `const anyOk = results.some(x=>x.ok)` ——
 *   **11 条失败 1 条成功也报 cleaned。** 那不是乐观，那是假账：
 *   面板上写「已清理」，而 10 条污染还在上下文里。
 * ★ 现在的判据三条：全部成功才算 cleaned；有成功有失败叫 partial（并列出失败原因）；
 *   一条都没成叫 clean-failed。**partial 不许被读成成功**，所以 stage 单独一个词。
 *
 * ★ dryRun 单独算：宿主回了 {dryRun:true} 表示「只诊断、没真清」——
 *   把它算成功，等于把「什么都没做」记成「做完了」。
 */
export function summarizeResults (results) {
  const list = Array.isArray(results) ? results : []
  const dry = list.filter((x) => x && x.dryRun)
  const real = list.filter((x) => x && !x.dryRun)
  const okList = real.filter((x) => x.ok)
  const badList = real.filter((x) => !x.ok)
  const total = list.length
  let stage = 'clean-failed'
  if (!total) stage = 'nothing-to-do'
  else if (!real.length) stage = 'diagnosed-only'
  else if (okList.length === real.length) stage = 'cleaned'
  else if (okList.length > 0) stage = 'partial'
  return {
    total,
    okCount: okList.length,
    failCount: badList.length,
    dryRunCount: dry.length,
    stage,
    ok: stage === 'cleaned',
    failures: badList.slice(0, 5).map((x) => ({
      hostSeq: x.hostSeq, v4Seq: x.v4Seq, why: String(x.why || x.error || '未知').slice(0, 200),
    })),
  }
}
