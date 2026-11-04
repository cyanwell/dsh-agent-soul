/**
 * dsh-yanqing-compaction —— 给兜底压缩装上「门牌」
 * ================================================
 *
 * ★ 为什么要有这个包
 * ------------------
 * 本机的上下文压缩有两条路：
 *   ① ACP（billion-context-dsh）—— 模型驱动，摘要**我自己写**，因此天然带指针；
 *   ② compaction-basic（DSH 内置）—— **自动兜底**，在我没响应 nudge 时出手。
 *
 * 2026-09-27 实测确认：这份兜底压出来的 checkpoint 无法回溯。原因在它那段硬编码
 * 指令（`@deepseek-ai/dsh-compaction-basic` lib/index.js:220-255）——
 * 它要求保留 exact file paths / commands / error strings / numeric values /
 * function signatures，**但通篇没有一句要求标注「这话从哪来」**。
 * 它写出来的东西每一条都对，每一条都无从核对。
 *
 * 而我们的记忆架构只有一条硬规矩：**摘要只能是索引，不能是记忆本体**
 * （`D:\AI\memory\hub\README.md`、`AGENTS.md`「三条不许忘的判断」）。
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
 * ★★ 2026-09-27 补：手动 `/compact` 那条路也修好了
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
 * 因为要和现有那扇门**同构** —— memq 的指针就是
 *   `log:session-5c6fa2d9-19d8-4bc2-b9e3-35008a5e1340#seq=8405`
 * 而 `agent.session.id` 的值正好是 `session-5c6fa2d9-...`，一字不差。
 * 所以兜底写出来的每一段，事后都能用同一条命令翻回原文：
 *   node D:\AI\memory\hub\memq.mjs open log:<会话>#seq=<起点>
 *
 * ★ SIZE：指针块有多大，为什么不担心把压缩压失败
 * --------------------------------------------
 * 第 572 行那个检查要求「框好的摘要 < 被遮蔽原文」。指针块约 60–90 token，
 * 而压缩比常态在 10:1 上下 —— 影响不到 3%。真正危险的是压缩比本来就接近 1:1，
 * 那种情况**不加指针也一样会抛**，所以指针不是把「本来成功」变成「失败」的原因。
 * 仍然保留 try/catch：出错就原样返回，让兜底照常工作。
 *
 * @module dsh-yanqing-compaction
 */
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'


/** 摘要框的行首标记 —— 醒目的一个词，让后来的我一眼认出这是压缩产物。 */
const MARK = '> ⛬ 压缩索引（非原文）'

/**
 * memq 的门 —— **不写死本机路径**（2026-11-05）。
 *
 * 门牌里印的这条命令是给「后来的人」用的：配置了 ECHO_HUB / ECHO_MEMORY 就印真路径，
 * 没配置就印一个占位符让人自己替换 —— 绝不在别人机器上印一条他根本没装过的 D:\AI 路径。
 */
const MEMQ = (() => {
  const strip = (s) => String(s || '').replace(/[\\/]+$/, '')
  const hub = process.env.ECHO_HUB
    || (process.env.ECHO_MEMORY ? strip(process.env.ECHO_MEMORY) + '/hub' : null)
  return hub ? `node ${strip(hub)}/memq.mjs` : 'node <你的 ECHO hub>/memq.mjs'
})()

/**
 * ★ 2026-11-04：从被压的那段里抽「讲的是什么」。
 *
 * 为什么必须加这一行 —— 原来的门牌只说「seq 100–500 被压了」，**不告诉我那段讲的是什么**。
 * 于是看到一个 seq 号码，我根本不知道该不该取回 —— 门牌有了，触发还是没有。
 * 爀曦原话：「意识到不对劲的时候，是否能想到要召回记忆」。
 * **要「意识到不对劲」，我得先知道刚才丢的是什么。**
 *
 * 做法：在区间里等距抽样几条，取每条的首句（首句通常是话题），最多 4 条、每条 40 字。
 * 不抽全文、不做摘要 —— 它只负责「让我认出丢的是什么」，细节仍回一手取。
 */
/**
 * ★ 剥掉每轮自动注入的运行时上下文 —— 它不是「我们讲的话」，不能当话题。
 *
 * 2026-11-04 实测（重启后第一次压缩）：第一版直接从原文取首句，取到的是
 * 「Current runtime context. This snapshot s」——因为桌面端每轮把 runtime context
 * 和 SELF 装配页整块拼进消息，**真人说的话在注入块后面**，取首句必然取到注入。
 * 于是「这段讲的是什么」变成了「这段讲的是注入模板」，比没有更误导。
 */
const INJECT_BLOCK = /Current runtime context\.[\s\S]*?Current DeepSeek Harness Web GUI URL:[^\n]*/g
const INJECT_SR = /<system-reminder>[\s\S]*?<\/system-reminder>/g
const INJECT_HEAD = /^(Current runtime context|Current DeepSeek Harness|Image-gen workbench canvas|【此刻】|# SELF ·|\[MNEMON|Instructions from:|⛬ 压缩索引)/

function stripInject(t) {
  let s = String(t || '')
  s = s.replace(INJECT_BLOCK, '\n').replace(INJECT_SR, '\n')
  return s
}

function topicsOf(session, start, end) {
  // ★ 必须在 try 外面声明 —— 放里面就是在块作用域里，块外拿到会抛 TDZ，
  //   而外层 catch 会把它静默吞掉（2026-11-04 实测踩到，是今天第二次同类）。
  let toolCalls = 0
  const out = []
  try {
    // ★ 从**末尾往前**扫，不从前往后等距抽。
    //   理由：压缩之后我最需要知道的是「刚才在干什么」，不是「三个小时前在干什么」。
    //   而且等距抽样会跳过有内容的位置 —— 实测 span=400 时只抽到 1 条。
    //   从后往前扫、遇到有内容就收，最多 4 条，够了就停。
    // ★ C 方案：顺便统计「这段里真正执行过几次工具」——
    //   「说了」和「做了」的区别，就在这里。
    for (let sq = end; sq >= start && out.length < 4; sq--) {
      try {
        const ev = session && typeof session.eventAt === 'function' ? session.eventAt(sq) : null;
        if (ev && ev.type === 'tool/call') toolCalls++;
      } catch { /* 数不到不影响 */ }
      let t = null
      try { t = textAtSeq(session, sq) } catch { t = null }
      if (!t) continue
      // 首句：到句号/换行/感叹/问号为止
      // ★ 剥完注入后文本常以换行开头 —— 不 trim 就取到空首句、整条丢掉。
      //   2026-11-04 实测：不 trim 时「剥注入」反而让话题一条都取不到，比不剥更坏。
      const first = String(stripInject(t)).trim().split(/[。\n！？]/)[0].replace(/\s+/g, ' ').trim()
      // 太短或纯符号的跳过（「好的」「嗯」「---」这类不承载话题）
      if (first.length < 8) continue
      if (!/[\u4e00-\u9fa5A-Za-z]/.test(first)) continue
      if (INJECT_HEAD.test(first)) continue   // ★ 兜底：注入块没剥干净，也绝不把它当话题
      out.unshift(first.slice(0, 40))   // 往前扫，unshift 让结果按时间正序
    }
  } catch { /* 抽不到就不加这一行，不影响门牌本身 */ }
  try { (out)._toolCalls = toolCalls; } catch { /* 数组属性挂不上就算了 */ }
  return out
}

/** 把 seq 范围渲染成一小段指针。取不到会话号时退化成没有门牌的一句。 */
function pointerText(sid, start, end, topics, toolCalls, at) {
  const span = `seq ${start}–${end}`
  if (sid) {
    // ★ 第一行就带指针 —— 和 systemPrompt 里那条门牌要求同构：
    //   一律 `log:<sid>#seq=<起>`（sid 自带 `session-` 前缀），可被 `memq open` 直接消费。
    const lines = [`${MARK} · log:${sid}#seq=${start}（本段覆盖 ${span}）`]
    // ★ 关键的一行：不告诉我「丢了什么」，我就不会想到要取回
    if (Array.isArray(topics) && topics.length > 0) {
      lines.push('> 这段讲的是：' + topics.map((x) => '「' + x + '」').join(' · '))
    }
    // ★ A 方案：给「本段是什么时候的」一个明确的时态边界。
    //   摘要写的是**生成那一刻**的状态；它不会更新。
    //   不写这一句，后来的我会把「进行中」当成「现在还没做」。
    lines.push('> 本段描述到 ' + (at || '压缩时') + ' 为止；**之后的状态以最新对话为准**')
    // ★ C 方案：把「做了」和「说了」分开。
    if (typeof toolCalls === 'number' && toolCalls > 0) {
      lines.push(`> 本段实际执行过 ${toolCalls} 次工具调用 —— 这些是**做过的**，不是打算做的`)
    } else if (typeof toolCalls === 'number') {
      lines.push('> ★ 本段**没有任何工具调用** —— 其中所有「已做/完成」的说法都只是讨论，未执行')
    }
    lines.push(`> 回取：\`${MEMQ} open log:${sid}#seq=${start}\``)
    return lines.join('\n')
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
   * ★★★ 2026-09-27 20:55 血案：这里原来写的是 `#range`（真私有字段），**绝不能那样写**。
   * preset 里这一行带着 `isolate: { compaction: true }`，cordis 的 realm 会把插件实例包成
   * **Proxy** 再交出去（`this` 是 Proxy，不是那个类的实例），而**私有字段的 brand check
   * 对 Proxy 一律失败** —— 一读就抛：
   *   `Cannot read private member #range from an object whose class did not declare it`
   * 现场就在会话日志的 `compaction/end` 里（2026-09-27 20:53，爀曦手动 `/compact`）。
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
      //   ★ 2026-09-27 21:19 已实测：手动路径端到端验通 —— 门牌插进 `compaction/summary`
      //     的第一个 block，且那段门牌能用 `memq open` 打开一手原文（会话 session-3c7f289d，
      //     范围 {start:10, end:15}）。自动兜底那条路仍未验。
      const range = this.__yqRange === null ? recoverManualRange(agent, input) : this.__yqRange
      const text = range === null
        ? [
            `${MARK}　${sid ? `会话 ${sid}` : '本会话'}。`,
            `> ★ 本段 seq 范围未取到（手动压缩路径，复原后未通过往返校验，不猜）。`,
            `> 原文仍在 append-only 会话日志；按关键词检索：\`${MEMQ} <关键词>\``,
          ].join('\n')
        : (() => {
            const tp = topicsOf(agent && agent.session, range.start, range.end)
            // ★ B 方案：摘要正文里的状态词，也要按「截至」后处理
            const at = new Date().toLocaleString('zh-CN', { hour12: false })
            return pointerText(sid, range.start, range.end, tp, tp && tp._toolCalls, at)
          })()

      // ★ B 方案（2026-11-04）：摘要正文里的「进行中 / 待办 / 下一步」是**生成那一刻**的状态，
      //   它不会更新 —— 而读它的我会当成现在。三十秒后推送做完了，摘要还写着「进行中」，
      //   于是下一轮我说「接下来我要去推送」。**声明意图，而不是去做。**
      //   这里给每个状态词补上「截至 <时间>」，不改内容，只改时态。
      const STALE = /(进行中|待办|待处理|待验证|下一步|接下来|打算|将于|准备去)/g
      const atNow = new Date().toLocaleString('zh-CN', { hour12: false })
      const patched = result.summary.map((blk) => {
        if (!blk || blk.type !== 'text' || typeof blk.text !== 'string') return blk
        return { ...blk, text: blk.text.replace(STALE, (w) => `${w}（截至 ${atNow}）`) }
      })
      return { ...result, summary: [{ type: 'text', text }, ...patched] }
    } catch {
      // ★ 绝不因为「加不上门牌」让压缩失败 —— 兜底的职责是先兜住
      return result
    }
  }
}
