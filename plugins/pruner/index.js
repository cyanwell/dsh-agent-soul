/**
 * dsh-agent-pruner —— 给工具结果的裁剪装上「门牌」
 * ==================================================
 *
 * ★ 为什么要有这个包
 * ------------------
 * `@deepseek-ai/dsh-compaction-tool-result-pruner` 会把**过大的工具结果**中间挖掉：
 * 留 head 4096 + tail 1024 个 Unicode code point，中间换成一句固定文本
 * （官方 lib/index.js:8）：
 *
 *     const PRUNE_MARKER = "\n\n[... tool result middle pruned ...]\n\n";
 *
 * **它其实已经做对了一半** —— `pruneSession` 在替换时留了完整的回链
 * （官方 lib/index.js:162-180）：
 *
 *     session.append("compaction/prune", {
 *         shadowedRange: { start: seq, end: seq },
 *         shadowedSeqs: [seq],                    // ← 记下了被遮蔽的 seq
 *         shadowedTokenCount: ...
 *     });
 *     const replacement = session.append("tool/result", { ... }, {
 *         surfaceOp: { op: "replace", startSeq: seq, endSeq: seq },
 *         sourceEventSeqs: [seq]                  // ← 替换节点指向原节点
 *     });
 *
 * 原文永远在 append-only 日志里，`eventAt(seq)` 随时取得回来（这就是 `Replay-safe`）。
 *
 * **缺口只有一个**：那句 marker 是**死文本**。它告诉我「这里被挖了一块」，
 * **但不告诉我那块在哪个 seq**。于是我在正文里看到 `[... pruned ...]` 时，
 * 不知道该去哪儿捞。**日志里有指针，我看得到的地方没有。**
 *
 * ★ 做法：完全不碰裁剪逻辑，只在输出里换掉那句 marker
 * ----------------------------------------------------
 * - 覆盖 `pruneSession`：先按**官方那两行筛选逻辑**排出一个候选 seq 队列，
 *   再把活交给 super（它的 append / surfaceOp / replay 语义一个字不改）；
 * - 覆盖 `pruneContent`：先调 super 拿到裁好的 blocks，再把官方 marker
 *   替换成带 seq 的版本；
 * - **安全阀三条**（缺一不可）：
 *     ① 换上去之后若超出 `thresholdChars`，**退回官方 marker**（官方
 *        `pruneContent` 尾部那条 "replacement must be smaller and within threshold"
 *        的约束不能被我的替换破坏）；
 *     ② 拿不到 seq 或会话号时**原样返回**，不猜；
 *     ③ 全程 try/catch —— **宁可写不出门牌，也不能写错门牌**，
 *        更不能让裁剪本身失败。
 *
 * ★ 判据出处（都是读源码得来的，不是猜的）
 * ----------------------------------------
 *  - `lib/index.js:8`      `PRUNE_MARKER` 的定义
 *  - `lib/index.js:79-83`  `measureContent`：按 **Unicode code point**、
 *                          只累加 `block.type === "text"`（非 text 块零成本）
 *  - `lib/index.js:91-124` `pruneContent`：`totalChars <= thresholdChars` 直接返回 null；
 *                          否则留 head/tail，中间插 marker；尾部校验
 *                          「必须更小且不超阈值」
 *  - `lib/index.js:137-194` `pruneSession`：候选取自
 *                          `[...session.surface.nodes]` 中 `event.type === "tool/result"` 的那些
 *  - `lib/index.js:43-44`  `resolveConfig` 校验
 *                          `headChars + marker + tailChars <= thresholdChars`
 *                          ⇒ 用默认 4096/1024/8192 时，marker 有约 3000 字符余量
 *  - `lib/types/types.d.ts:5-10` 三个预算字段的含义（Unicode code point）
 *
 * ★ 为什么「候选队列顺序对应」是成立的
 * -----------------------------------
 * 官方 `pruneSession` 的循环体对**每一个** candidate 都调一次 `this.pruneContent(...)`
 * （无论它是否超预算，见官方 :151），所以第 i 次 `pruneContent` 调用必然对应
 * 第 i 个 candidate。这条对应关系是**结构性**的，不是启发式的。
 *
 * ★ 但这条对应依赖官方候选筛选逻辑不变 —— 所以留了钩子：
 *   如果哪天官方改了筛选，队列就会错位。`super.pruneSession` 的返回值里
 *   有 `pruned[].originalSeq`，可以拿来事后对照（见下面 `#audit`）。
 *
 * @module dsh-agent-pruner
 */
import { ToolResultPruner, PRUNE_MARKER } from '@deepseek-ai/dsh-compaction-tool-result-pruner'

/** memq 的门 —— 和 SELF.md 里印的是同一扇门。 */
/**
 * ★ 取回命令 —— 换成你自己的检索工具。
 *
 * 门牌会被渲染成：`<MEMQ> open log:<会话号>#seq=<n>`
 * 所以它只要认 `open <指针>` 这个形式就行；不认 `open` 的话，
 * 把这一行连同下面 markerFor 里那两句一起改成你的写法。
 *
 * 本包只负责【写指针】，不规定你用什么工具去【回取】。
 */
// ★★ 回取命令：**没配置就不给命令，只给指针**（2026-10-22 全面验证报告 P2-6）。
//
//   原来这里写死 '<你的检索命令>'，渲染出来是一条**不可执行的假命令**：
//     > 回取：`<你的检索命令> open log:session-x#seq=123`
//   而指针本身（log:...#seq=）是好的。
//
//   ★ 给一条假命令**比不给更坏**：读的人（人或 agent）会照着敲，敲不通之后
//     可能反过来怀疑「这个门牌是坏的」—— 而那恰好是这套机制最要紧的东西。
//   所以没配置时只说「用你自己的检索命令打开它」，不假装知道那是什么。
//
//   配置方式（任一即可）：SOUL_MEMQ / MEMQ
//     例：SOUL_MEMQ='node /path/to/memq.mjs'
const MEMQ = String(process.env.SOUL_MEMQ || process.env.MEMQ || '').trim()

/**
 * 渲染一块带门牌的 marker。
 * 长度要克制：`resolveConfig` 只保证 `head + marker + tail <= thresholdChars`，
 * 默认配置下余量约 3000 字符，但用户的配置可能更紧（见 pruneContent 的安全阀①）。
 */
function markerFor(sid, seq) {
  const where = sid ? `（会话 ${sid}）` : ''
  const how = sid
    ? MEMQ
      ? `${MEMQ} open log:${sid}#seq=${seq}`
      : `用你自己的检索命令打开：log:${sid}#seq=${seq}`
    : MEMQ
      ? `${MEMQ} open log:<会话号>#seq=${seq}`
      : `用你自己的检索命令打开：log:<会话号>#seq=${seq}`
  return `\n\n[... 中间被裁${where} · 原文在 append-only 会话日志 seq ${seq}，取回：${how} ...]\n\n`
}

/** 把 blocks 里的官方 marker 换成带 seq 的版本。找不到就原样返回。 */
function replaceMarkerIn(blocks, marker) {
  const out = []
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string'
        && block.text.indexOf(PRUNE_MARKER) >= 0) {
      out.push({ ...block, text: block.text.split(PRUNE_MARKER).join(marker) })
    } else {
      out.push(block)
    }
  }
  return out
}

export default class YanqingPruner extends ToolResultPruner {
  /** 本次 pruneSession 的候选 seq 队列；不在裁剪中时为 null。 */
  __yqQueue = null
  /** 队列游标；每次 pruneContent 调用前进一格（官方对每个候选都调一次）。 */
  __yqCursor = 0
  /** 本次裁剪的会话号，用于把门牌写完整。 */
  __yqSid = ''

  /**
   * 记下候选队列与会话号，再把活原样交给 super。
   * **不动 super 的任何行为** —— 落盘、surfaceOp、回链、计价全部照旧。
   */
  pruneSession(session) {
    let queue = null
    let sid = ''
    try {
      // 与官方 lib/index.js:138-146 逐字等价的两行筛选
      const q = []
      for (const seq of [...session.surface.nodes]) {
        const event = session.eventAt(seq)
        if (event?.type === 'tool/result') q.push(seq)
      }
      queue = q
      if (session && session.id !== undefined && session.id !== null) sid = String(session.id)
    } catch {
      // 拿不到候选或会话号不是错误 —— 退化成"不带门牌的官方行为"
      queue = null
      sid = ''
    }

    this.__yqQueue = queue
    this.__yqCursor = 0
    this.__yqSid = sid
    try {
      return super.pruneSession(session)
    } finally {
      this.__yqQueue = null
      this.__yqCursor = 0
      this.__yqSid = ''
    }
  }

  /**
   * 先让裁剪照常发生，再把官方 marker 换成带 seq 的。
   * ★ 顺序不能反：先 super（该抛的让它抛、该校验的让它校验），再换。
   */
  pruneContent(blocks) {
    const seq = this.__yqQueue === null ? undefined : this.__yqQueue[this.__yqCursor]
    if (this.__yqQueue !== null) this.__yqCursor += 1

    const pruned = super.pruneContent(blocks)
    if (pruned === null) return null
    // 安全阀②：拿不到 seq 就原样返回 —— 不猜
    if (seq === undefined) return pruned

    try {
      const swapped = replaceMarkerIn(pruned, markerFor(this.__yqSid, seq))
      // 安全阀①：换上去之后仍须不超阈值，否则退回官方的
      if (this.measureContent(swapped) > this.config.thresholdChars) return pruned
      return swapped
    } catch {
      // 安全阀③：换门牌失败绝不能拖垮裁剪本身
      return pruned
    }
  }
}

// 具名导出：只为让 selftest 能直接测这两个纯函数。
// Cordis 用的是 default 导出，多两个具名导出不影响装载。
export { markerFor, replaceMarkerIn, MEMQ }
