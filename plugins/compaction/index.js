/**
 * dsh-agent-compaction —— 给兜底压缩装上「门牌」
 * ================================================
 *
 * ★ 为什么要有这个包
 * ------------------
 * DSH 的上下文压缩有两条路：
 *   ① ACP（billion-context-dsh）—— 模型驱动，摘要**我自己写**，因此天然带指针；
 *   ② compaction-basic（DSH 内置）—— **自动兜底**，在我没响应 nudge 时出手。
 *
 * 确认：这份兜底压出来的 checkpoint 无法回溯。原因在它那段硬编码
 * 指令（`@deepseek-ai/dsh-compaction-basic` lib/index.js:220-255）——
 * 它要求保留 exact file paths / commands / error strings / numeric values /
 * function signatures，**但通篇没有一句要求标注「这话从哪来」**。
 * 它写出来的东西每一条都对，每一条都无从核对。
 *
 * 而记忆架构里只有一条硬规矩：**摘要只能是索引，不能是记忆本体**
 * （见本包 README 的「门牌」一节）。
 * 所以兜底不能停在「写得好」，它得**写得出门牌**。
 *
 * ★ 做法：不重写 LLM 调用、不碰落盘策略，只加一段指针
 * ----------------------------------------------------
 * 三步：
 *   1. 覆盖 `compactRegion` —— 它参数里就有 start/end seq，先记下来再交给 super；
 *   2. 覆盖 `summarize`    —— 调 super 拿到摘要，然后在**最前面**插一个 text block；
 *   3. 全程兜底：任何一步出错都降级成「没加指针」，**绝不让压缩本身失败**。
 *
 * ★ 每条判据都读过源码，不是猜的（照「没验过的不写」）
 * --------------------------------------------------
 *  - `lib/types/index.d.ts:20`   「`summarize()` is the sole subclass customization hook;
 *                                  the replay and durable mutation strategy stays fixed」
 *                                ⇒ 继承类是被设计支持的，且只需动这一处
 *  - `lib/types/index.d.ts:34-38` 「`compactIfNeeded` stays dynamically dispatched so
 *                                  subclass overrides are honored at event time」
 *                                ⇒ 覆盖在事件发生时一定被采纳
 *  - `lib/index.js:975`          `summarize: (input, owner, abort) => this.summarize(...)`
 *                                ⇒ 覆盖 `this.summarize` 就是覆盖 dependencies.summarize
 *  - `lib/index.js:542-562`      `prepared` 里有 `start` / `end` / `shadowedSeqs`
 *  - `lib/index.js:666-675`      `buildSummarizationInput` 把 seq 映射成 messages 后就丢了，
 *                                `SummarizationInput` 只有 `{tools, messages}`
 *                                ⇒ **摘要模型看不到 seq，所以指针必须由外面补**
 *  - `lib/index.js:572`          `if (framedSummaryTokenCount >= prepared.shadowedRouteTokenCount) throw`
 *                                ⇒ 摘下来的必须比原文小；所以指针块要极短（见下面 SIZE 的权衡）
 *  - `dsh-session/lib/types/index.d.ts:121`  `get id(): SessionId`
 *  - `dsh-agent/lib/types/runtime-types.d.ts:143`  `readonly session: Session`
 *                                ⇒ `agent.session.id` 就是门牌上的会话号
 *
 * ★★ 补：手动 `/compact` 那条路也修好了
 * ----------------------------------------------------
 * 上面第 1 步只覆盖了 `compactRegion`，而 `lib/index.js:930` 的 `compactRegion` 只被
 * **自动路径**调用（`compactIfNeeded` 的 `:893` 与 `:915`）。
 * **手动 `/compact` 走 `compactNow`（`:944-970`），它在 `:953` 直调模块私有的
 * `compactSurfaceRegion`（`:433`），根本不经过 `compactRegion`** ⇒ `#range` 是 null。
 *
 * 想覆盖 `compactNow` 是死路：`selectCompactableRange`（`:393`）与 `compactSurfaceRegion`
 * 都**没有导出**（`:980` 只导出 `BasicCompactionEngine`）。
 * ⇒ 改为**在 `summarize` 里把范围复原出来**：`compactNow` 在 `:951` 用的是
 * `selectCompactableRange(session, meter.measure(session), 0)`，而 `retainTokens = 0`
 * 把 `:400-405` 那个累加循环**退化成「第一次迭代就 break」**，
 * 于是 `keepFromIdx` 恒等于 `pricedNodes.length - 1`，`end = surfaceNodes[length - 2]`。
 * 剩下的只有 `start`：`:398` 的 `firstIdx` 只可能是 0 或 1。**两个候选都试，用内容自检定夺。**
 *
 * ★★★ 自检是这一版的命门 —— 「错的门牌比没有更坏」
 * ------------------------------------------------
 * 复原出来的范围**必须通过往返校验**才会被采用：
 *   `input.messages` 的末条应当等于 `session.deriveEventMessage(session.eventAt(end))`；
 *   首条（或次条，system 头占位）应当等于 `...eventAt(start)` 的文本。
 * 对不上就**丢掉门牌、退回降级式**。宁可只说「会话号 + 检索入口」，也不写一个会引我去翻无关原文的 seq。
 *
 * ★ 指针为什么长这样
 * ----------------
 * 指针形如
 *   `log:session-5c6fa2d9-19d8-4bc2-b9e3-35008a5e1340#seq=8405`
 * 而 `agent.session.id` 的值正好是 `session-5c6fa2d9-...`，一字不差 —— 所以拼得出来。
 * 事后用你自己的检索入口打开它即可：
 *   <你的检索命令> log:<会话>#seq=<起点>
 *
 * ★ 本包只负责【写指针】，不规定你用什么工具去【回取】。
 *   换一套检索系统也能用 —— 只要它认 `log:<会话>#seq=<n>` 这种形式。
 *
 * ★ SIZE：指针块有多大，为什么不担心把压缩压失败
 * --------------------------------------------
 * 第 572 行那个检查要求「框好的摘要 < 被遮蔽原文」。指针块约 60–90 token，
 * 而压缩比常态在 10:1 上下 —— 影响不到 3%。真正危险的是压缩比本来就接近 1:1，
 * 那种情况**不加指针也一样会抛**，所以指针不是把「本来成功」变成「失败」的原因。
 * 仍然保留 try/catch：出错就原样返回，让兜底照常工作。
 *
 * @module dsh-agent-compaction
 */
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'


/** 摘要框的行首标记 —— 醒目的一个词，让后来的我一眼认出这是压缩产物。 */
const MARK = '> ⛬ 压缩索引（非原文）'

/** memq 的门。路径写死成绝对路径 —— 它和 SELF.md 里印的是同一扇门。 */
/**
 * ★ 取回命令 —— 换成你自己的检索工具。
 *
 * 门牌会被渲染成：`<MEMQ> open log:<会话号>#seq=<n>`
 * 所以它只要认 `open <指针>` 这个形式就行。
 *
 * 包只负责【写指针】，不规定你用什么工具去【回取】。
 */
const MEMQ = '<你的检索命令>'

/** 把 seq 范围渲染成一小段指针。取不到会话号时退化成没有门牌的一句。 */
function pointerText(sid, start, end) {
  const span = `seq ${start}–${end}`
  if (sid) {
    // ★ 第一行就带指针 —— 和 systemPrompt 里那条门牌要求同构：
    //   一律 `log:<sid>#seq=<起>`（sid 自带 `session-` 前缀），可被 `memq open` 直接消费。
    return [
      `${MARK} · log:${sid}#seq=${start}（本段覆盖 ${span}）`,
      `> 回取：\`${MEMQ} open log:${sid}#seq=${start}\``,
    ].join('\n')
  }
  return [
    `${MARK}　本段覆盖 ${span}。`,
    `> 原文仍在一手层（append-only 会话日志）。会话号取不到，按 seq 找。`,
  ].join('\n')
}

// ════════════════ 手动路径的范围复原（外部可单测） ════════════════

/** 从一个派生出来的 Message 里取纯文本；取不到返回 null。 */
export function msgText(message) {
  if (message === null || message === undefined || typeof message !== 'object') return null
  const content = message.content
  if (!Array.isArray(content)) return null
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.length === 0 ? null : parts.join('\n')
}

/** seq → 该节点派生出的消息文本；任何一步不成立都返回 null（调用方据此降级）。 */
function textAtSeq(session, seq) {
  try {
    const event = session.eventAt(seq)
    if (event === null || event === undefined) return null
    return msgText(session.deriveEventMessage(event))
  } catch {
    return null
  }
}

/**
 * 复原手动 `/compact`（`compactNow`）将要压的 seq 范围。
 *
 * 依据（`@deepseek-ai/dsh-compaction-basic` lib/index.js）：
 *  - `:951` `selectCompactableRange(agent.session, this.ctx.tokenMeter.measure(agent.session), 0)`
 *  - `:400-405` `retainTokens = 0` ⇒ 累加循环第一次迭代即 break ⇒ `keepFromIdx = length - 1`
 *  - `:407-410` 从 `keepFromIdx` 往回退，直到 `toolPairingBalancedBefore` 成立
 *  - `:398` `firstIdx` 只可能是 0（无 system 头）或 1（有）
 *  - `:412-415` 返回 `{ start: surfaceNodes[firstIdx], end: surfaceNodes[keepFromIdx - 1] }`
 *
 * ★ `systemHead` 已照源码复刻（basic `lib/index.js:379-381` 就一句：
 *   `return head.type === "system/message" ? head : void 0;`），所以 `firstIdx` 是**算出来的、不是猜的**。
 * ★ 最后仍有**往返校验**兜底：`input.messages` 的末条必须由 `end` 派生、首条（或次条，
 *   `buildSummarizationInput` 会把 system 头拼在最前）必须由 `start` 派生。
 *   对不上就返回 null —— **宁可退回降级式，也不写一个会引我去翻无关原文的 seq**。
 *
 * @param agent - 拥有目标 session 的 agent。
 * @param input - `SummarizationInput`，即 `{ tools?, messages }`。
 * @param deps - 仅供单测注入 `{ toolPairingBalancedBefore }`；生产路径省略即用官方实现。
 * @returns `{ start, end }` 或 `null`（拿不准一律 null）。
 */
export function recoverManualRange(agent, input, deps) {
  try {
    const session = agent !== null && agent !== undefined ? agent.session : null
    if (session === null || session === undefined) return null
    const surface = session.surface
    if (surface === null || surface === undefined) return null
    const surfaceNodes = surface.nodes
    if (!Array.isArray(surfaceNodes) || surfaceNodes.length < 3) return null

    const messages = input !== null && input !== undefined && Array.isArray(input.messages) ? input.messages : []
    if (messages.length === 0) return null

    const balancedBefore =
      deps !== null && deps !== undefined && typeof deps.toolPairingBalancedBefore === 'function'
        ? deps.toolPairingBalancedBefore
        : toolPairingBalancedBefore

    // retainTokens = 0 ⇒ 起点恒为最后一个索引（第一次迭代就 break）
    let keepFromIdx = surfaceNodes.length - 1
    const floor = 0
    while (keepFromIdx > floor) {
      if (balancedBefore(session, surfaceNodes[keepFromIdx])) break
      keepFromIdx -= 1
    }
    if (keepFromIdx <= floor) return null

    // 复刻 systemHead：只决定 firstIdx 是 0 还是 1
    let firstIdx = 0
    try {
      const headEvent = session.eventAt(surfaceNodes[0])
      if (headEvent !== null && headEvent !== undefined && headEvent.type === 'system/message') firstIdx = 1
    } catch {
      firstIdx = 0
    }
    if (keepFromIdx <= firstIdx) return null

    // 宽松校验：shadowedSeqs 里若有节点不投影成 message，messages 只会更短，绝不会更长
    if (messages.length > keepFromIdx) return null

    const startSeq = surfaceNodes[firstIdx]
    const endSeq = surfaceNodes[keepFromIdx - 1]

    // ★ 往返校验：末条对应 end
    const endText = textAtSeq(session, endSeq)
    if (endText === null || msgText(messages[messages.length - 1]) !== endText) return null

    // ★ 往返校验：首条或次条对应 start（次条命中 = system 头占了首位）
    const startText = textAtSeq(session, startSeq)
    if (startText === null) return null
    const hitFirst = msgText(messages[0]) === startText
    const hitSecond = messages.length > 1 && msgText(messages[1]) === startText
    if (!hitFirst && !hitSecond) return null

    return { start: startSeq, end: endSeq }

  } catch {
    return null
  }
}

export default class YanqingCompaction extends BasicCompactionEngine {
  /**
   * 本次被压缩的 seq 范围。只在 compactRegion 的调用栈里有效，
   * 出栈即清空 —— 免得下一次 summarize 用错门牌。
   *
   * ★★★ 踩过的坑：这里原来写的是 `#range`（真私有字段），**绝不能那样写**。
   * preset 里这一行带着 `isolate: { compaction: true }`，cordis 的 realm 会把插件实例包成
   * **Proxy** 再交出去（`this` 是 Proxy，不是那个类的实例），而**私有字段的 brand check
   * 对 Proxy 一律失败** —— 一读就抛：
   *   `Cannot read private member #range from an object whose class did not declare it`
   * 现场就在会话日志的 `compaction/end` 里（一次手动 `/compact`）。
   *
   * 后果分两层，都很坏：
   *   · 旧版把这个读取放在 `summarize` 的 try **内部** ⇒ 抛错被 catch 吞掉 ⇒
   *     **压缩照常成功、门牌静默丢失**（20:30 探针那次「压通了但没门牌」就是它）；
   *   · 一旦这个读取被挪到 try 外面（哪怕只是写进诊断的参数里），
   *     同一个 bug 就升级成**压缩直接失败**。
   *
   * ⇒ 在 realm 里只能用**普通属性**：Proxy 会把 get/set 转发到 target。
   *   不能用 `#private`；也不能用 WeakMap —— Proxy 与 target 是两个对象，按对象取键一样落空。
   */
  __yqRange = null

  /**
   * 记下范围再交回去。**不动 super 的任何行为** —— 落盘、定价、边界校验都原样。
   * 这里只做一件事：把调用方知道、而 summarize 拿不到的 seq 留下来。
   */
  async compactRegion(start, end, agent, signal) {
    this.__yqRange = { start, end }
    try {
      return await super.compactRegion(start, end, agent, signal)
    } finally {
      this.__yqRange = null
    }
  }

  /**
   * 先让兜底照常工作，再在它的成果前面加一块门牌。
   * ★ 顺序不能反：先 super（该抛的让它抛），再加。加的部分单独兜底。
   */
  async summarize(input, agent, signal) {
    const result = await super.summarize(input, agent, signal)
    if (!result || !Array.isArray(result.summary) || result.summary.length === 0) return result

    try {
      let sid = ''
      try {
        const raw = agent && agent.session ? agent.session.id : ''
        sid = raw === undefined || raw === null ? '' : String(raw)
      } catch {
        // 取不到会话号不是错误 —— 退化成按关键词检索
        sid = ''
      }

      // ★ 两条路，两种拿范围的方式：
      //   · 自动兜底（pressure / overflow）走官方 `this.compactRegion(...)`
      //     （dsh-compaction-basic/lib/index.js:893 与 :915）⇒ 我覆盖了它 ⇒ __yqRange 就是精确的
      //   · 手动 `/compact` 走官方 `compactNow`，它**直调模块私有的 compactSurfaceRegion**
      //     （:953），不经过我覆盖的 compactRegion ⇒ __yqRange 是 null
      //     ★ 于是现场**复原**一次（recoverManualRange），并用往返校验确认；
      //     复原不出来就退回降级式 —— **绝不猜 seq**，错的门牌比没有更坏。
      //   ★ 已验证：手动路径端到端验通 —— 门牌插进 `compaction/summary`
      //     的第一个 block，且那段门牌能用 `memq open` 打开一手原文（会话 session-3c7f289d，
      //     范围 {start:10, end:15}）。自动兜底那条路仍未验。
      const range = this.__yqRange === null ? recoverManualRange(agent, input) : this.__yqRange
      const text = range === null
        ? [
            `${MARK}　${sid ? `会话 ${sid}` : '本会话'}。`,
            `> ★ 本段 seq 范围未取到（手动压缩路径，复原后未通过往返校验，不猜）。`,
            `> 原文仍在 append-only 会话日志；按关键词检索：\`${MEMQ} <关键词>\``,
          ].join('\n')
        : pointerText(sid, range.start, range.end)

      return { ...result, summary: [{ type: 'text', text }, ...result.summary] }
    } catch {
      // ★ 绝不因为「加不上门牌」让压缩失败 —— 兜底的职责是先兜住
      return result
    }
  }
}
