/**
 * Thinking-loop guard for the dsh harness.
 *
 * Closes a guard-layer gap the in-tree `guard/` family does not cover.
 * `guard/timeout-policy` is a per-tool `tools/execute` deadline and
 * `guard/repeat-tool-reminder` is a same-tool-call chain detector — only a tool
 * *call* arms either. When a model degrades into a pure-thinking loop
 * (`deepseek-v4.1-flash-expires-on-0910` under `max`/`high` reasoning effort and
 * a long context), it emits only `reasoning-delta` chunks — zero `text-delta`,
 * zero `tool-call-delta` — so neither fires, `turn()` never sets `turnEnds`, and
 * the agent-loop `while (true)` never breaks until the user manually aborts.
 *
 * This plugin observes the public `llm/stream` waterfall (present on dsh
 * **0.1.2-rc.1 and 0.1.5-alpha.1**), tallies the `StreamChunk` composition of
 * each loop-built model call, and escalates through a configured reaction.
 *
 * Why `llm/stream` and not `agent/assistant-stream`: the latter (scoped emit
 * with `start`/`chunk`/`end` frames) only exists from dsh 0.1.5-alpha.1; the
 * widely-installed 0.1.2-rc.1 has neither it nor `AssistantStreamFrame`, so a
 * plugin pinned to that seam silently no-ops on the common release. `llm/stream`
 * is a Cordis waterfall around every streaming model call in both versions and
 * carries the same `StreamChunk` delta types, and its `GenerateOptions` carries
 * `sessionId`, from which the live Agent is reachable via `ctx.agents.get(...)`.
 *
 * ## Detection (two per-call shapes, plus two in-call breakers)
 *
 * Issue #1's re-test on dsh 0.1.2-rc.1 showed the v0.1.2 detector did not fire on
 * the reproduction: the loop recurred with the plugin loaded and working. The
 * v0.1.2 detector had two blind spots that together miss the reported shape:
 *
 *  1. It required **consecutive** reasoning-only calls and reset the counter on
 *     *any* text output. A loop whose steps each emit some (boilerplate) text
 *     after their reasoning never accumulates, because every step looks like
 *     progress.
 *  2. Its only content signal was `repeatRatio` — verbatim n-gram repetition
 *     *within one call*. A model that re-derives the same stalled conclusion with
 *     different wording every step scores near zero on that measure, so it also
 *     slipped through.
 *
 * The fix for (2) is a **cross-call** measure: the **containment** of the
 * previous call's distinct n-grams in this call's. A step is "stalled" when it
 * either produced no output at all (shape 1) *or* it repeats most of the previous
 * step's distinct reasoning material (shape 2 — the same conclusion reworded,
 * which is what a stuck model actually does). Anything else is genuine progress
 * and resets the run.
 *
 * The intra-call ratio itself turned out not to be salvageable as a signal and is
 * no longer wired in; {@link LoopDetector.observe} carries the measurement.
 *
 * ## Mid-stream repetition (issue #2848, v0.1.6)
 *
 * The three shapes above are judged **after** a model call ends, which is
 * structurally too late for the failure in issue #2848: a ~10-minute, 420,000
 * character bleed where the model repeated one sentence across ~2825 text chunks
 * — all inside a **single** call. No per-call detector can help, because there is
 * no call boundary to react at; the harness must intervene mid-stream.
 *
 * `maxRepeatedText` therefore adds an intra-call breaker: count consecutive
 * identical normalized `text-delta` payloads and, on the Nth, **end the stream
 * from inside the `llm/stream` wrapper** by yielding a terminal `finish` chunk
 * and returning. Two facts make that expressible and safe, both verified on
 * 0.1.5-alpha.1 and re-checked against the 0.1.2-rc.1 typings:
 *
 *  - The agent loop consumes the waterfall's iterable (`for await (const chunk
 *    of stream) live.push(chunk)`), so a listener's own chunk reaches the same
 *    assembler as an adapter's.
 *  - `packages/llm/llm/src/invariant.ts` requires a terminal finish chunk and
 *    explicitly permits an `error`/`aborted` finish with blocks still open — so
 *    a mid-call cut is a sanctioned protocol outcome, not a violation. A stream
 *    that simply ends is an invariant failure, which is why the breaker emits a
 *    finish rather than merely returning.
 *
 * The break is always an `error` finish carrying `REPETITIVE_OUTPUT`: it fails
 * the step through the loop's normal error path (and the `agent/request-error`
 * waterfall, where a retry policy may act on the code). A quiet `stop` is not
 * offered, because the breaker fires with the call's text block still open and
 * the invariant admits only `error`/`aborted` finishes in that state — measured,
 * not assumed. `breakCorrection` steers the agent so the resumed turn is told
 * what happened. Deliberately **no model fallback and no automatic retry**: a
 * degenerate model must not be silently re-billed.
 *
 * ## Cycled repetition (discussion #7043, v0.1.8)
 *
 * `maxRepeatedText` compares *deltas*, so it only covers the period-1 case: the
 * same payload emitted over and over. The #7043 report is a **cycle** — a few
 * short lines rotating ("好。 / 发。 / 好。 / 好。", and a mixed-language variant
 * with "Emitting." in front) for tens of lines, and the same signature in a long
 * session where the model bleeds instead of calling the tool it obviously means
 * to call. Measured against the shipped v0.1.7 detector, that shape **never
 * fires under any of four chunkings** (one delta per line, per cycle, per four
 * characters, per character) within 40 repeats: the longest run of identical
 * consecutive deltas is 3, against a threshold of 60.
 *
 * `maxRepeatedCycleChars` / `minRepeatedCycleChars` add the missing rule at the
 * character level: when the tail of the call's visible output is an exact
 * repetition of one period no longer than `maxRepeatedCycleChars` and spanning
 * at least `minRepeatedCycleChars`, the stream is cut by the same terminal
 * `error` finish. Character-level because the shape does not depend on line
 * breaks — a provider that streams the same bleed with no newline at all is
 * caught identically — and because the reported period is short (12 and 26
 * characters for the two reported shapes).
 *
 * Why exactness and not a low-entropy ratio, when `repeatRatio` was already in
 * the file: measured on the same texts, a *coverage* measure reads 0.92-0.99 for
 * the two reported shapes at a 512-character tail but 0.72 for a 40-row
 * markdown table, 0.76 for a log listing, 0.82 for generated CSS rows and 0.84
 * for a JSON dump. Separating "degenerate" from "legitimately repetitive" by
 * 0.06 is not a margin worth truncating a user's call over; verbatim
 * periodicity is 0 for every one of those samples.
 *
 * ## Reaction
 *
 * On a threshold crossing it applies `escalate`. Unlike v0.1.2 it does **not**
 * latch after one reaction: a single steer often does not break a strong loop
 * (which is exactly what issue #1's re-test observed), so the run counter resets
 * and re-fires after another `maxThinkingSteps`, up to `maxFires` times.
 *
 * Mechanism notes (verified against packages/core/agent-loop/src/agent.ts,
 * packages/llm/llm/src/index.ts, and packages/core/agent/src/runtime-types.ts on
 * dsh 0.1.5-alpha.1; the `llm/stream` / `StreamChunk` / `ctx.agents.get` trio is
 * present unchanged on 0.1.2-rc.1):
 *  - `llm/stream` is a waterfall; a listener wraps `next()` and sees each chunk.
 *  - `chunk: StreamChunk` distinguishes `reasoning-delta` / `text-delta` /
 *    `tool-call-delta` (packages/llm/llm/src/types.ts).
 *  - Loop-built requests carry `markAgentLoopRequest`; `isAgentLoopRequest`
 *    filters out arbitrary non-agent streaming (tool streams, etc.).
 *  - `options.sessionId` → `ctx.agents.get(sessionId)` yields the live `Agent`.
 *  - `agent.steer(message)`, `agent.inject(message)`, and `agent.cancel(cause)`
 *    are public methods; a listener can react but not veto an in-flight step.
 *
 * ## Reasoning bleed (issue #5976, v0.1.9)
 *
 * The three per-call shapes above all assume the call eventually **ends**. #5976
 * is the case where it does not: the model degrades into a pure reasoning bleed
 * — no `text-delta`, no `tool-call-delta` — and keeps generating indefinitely.
 * The harness derives `StepEndReason` from the finished message
 * (`packages/core/agent-loop`, `step()` returns `completed` only once a message
 * exists), so a stream that never finishes never settles the step, `turnEnds`
 * stays null, and the `while (true)` turn loop never breaks. The reporter's
 * experience — "只能手动中止" — is that loop.
 *
 * Every detector above is therefore blind to it by construction:
 *
 *  - {@link LoopDetector} judges a call after it ends, and this one does not end;
 *  - {@link TextRepetitionDetector} watches visible output, and this failure
 *    emits none — deliberately, since reasoning is where the bleed lives and
 *    reasoning legitimately revisits itself far more often.
 *
 * {@link ReasoningLoopBreaker} closes it with the only mechanism that can: it
 * watches `reasoning-delta`, and on a verbatim cycle it ends the stream from
 * inside the `llm/stream` wrapper with a terminal `error` finish. That failure
 * is what makes the turn end at all — `agent-loop`'s `step()` turns a non-retried
 * `error` finish into a thrown `LlmError`, `turn()` catches it into
 * `turnEnds = { kind: 'error' }`, and the `finally` appends `turn/end`.
 *
 * The rule is exact periodicity, not a ratio, and the thresholds are measured
 * rather than guessed — see {@link ReasoningLoopBreaker} for the calibration
 * against a real reproduction.
 *
 * @module dsh-loop-guard
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 家目录。
 *
 * ★ 2026-10-23：这里**故意不用** `import { homedir } from 'node:os'` ——
 *   这个项目自带的 `@types/node` 太旧（连 `appendFileSync` 都没有声明，见 bootLog 的注释），
 *   引 `node:os` 会 TS2307，`tsc` 直接失败。而 `lib/index.js` 其实照样生成，
 *   于是「本机能跑、别人 build 报错」—— 又一个只在不该出问题的地方出问题的东西。
 *   读环境变量同样可靠，且不动依赖。
 */
function homeDir(): string {
  return process.env.USERPROFILE ?? process.env.HOME ?? '.'
}
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, AgentCancelCause } from '@deepseek-ai/dsh-agent'
import { BlockAssembler, createUserMessage, isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
/* ★ 2026-10-28（源同步）：范围压缩要判「这个切点两侧的工具调用配不配对」。
 *   它是宿主自带的导出（`dsh-compaction/tool-pairing`），本包的 dependencies 里没有 ——
 *   与 `ctx.get('compaction')` 同一个前提：**运行时由宿主提供**。 */
import { toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import type { ContextFormed, LlmFailure, StreamChunk } from '@deepseek-ai/dsh-llm'

type UserMessage = ReturnType<typeof createUserMessage>

/**
 * The agent's public methods the guard reacts with.
 *
 * `whenIdle`/`followup` are optional because they are only needed for
 * {@link Config.resumeAfterBreak}, and a guard that required them would fail to
 * mount on any Agent-shaped stand-in that omits them.
 */
type GuardableAgent = Pick<Agent, 'inject' | 'steer' | 'cancel'>
  & Partial<Pick<Agent, 'whenIdle' | 'followup' | 'status'>>

/** Plugin configuration. */
export interface Config {
  /**
   * Consecutive stalled model calls before a reaction. A call is stalled when it
   * produced no text/tool output, or when it repeated most of the previous
   * call's distinct reasoning material. Default `3`.
   */
  maxThinkingSteps?: number
  /**
   * Minimum reasoning text within one call before that call is judged at all; a
   * short burst is normal. Default `2048` chars.
   */
  minReasoningChars?: number
  /**
   * Cross-call similarity: how much of the previous call's distinct reasoning
   * material must reappear in this call before the call counts as a repetition
   * of stalled thinking rather than progress. `1.0` requires an exact rerun of
   * the same material; `0` disables this signal. Default `0.8`.
   */
  similarityThreshold?: number
  /**
   * Reaction to fire on a threshold crossing. `warn` injects a notice, `steer`
   * sends a steering message, `cancel` hard-aborts the turn. Default `steer`.
   */
  escalate?: 'warn' | 'steer' | 'cancel'
  /**
   * How many times one agent may be reacted to before the guard stops
   * re-firing. A single intervention often does not break a strong loop, so the
   * default allows several. Default `4`.
   */
  maxFires?: number
  /** Cancel cause used when `escalate` is `cancel`. Default `'thinking-loop'`. */
  cancelCause?: string

  /* ────────────────────────────────────────────────────────────────────────
   * 换气层（huanqi）—— 思考预算管理
   *
   * 上面那些是「循环检测」：这一轮是不是在绕圈。
   * 下面这些是「预算管理」：这一轮把输出额度烧光、正文没出来，接下来怎么办。
   * ★ 两者的处方不同 —— 前者要「别绕了」，后者要「直接说」。
   * ──────────────────────────────────────────────────────────────────────── */

  /**
   * ★★ 子 agent（含 Agent Teams 成员）的严格程度 —— 三档。
   *
   * 2026-10-23 爀曦定：**智能体团队的 agent 和一次性子 agent 归成一类**，
   * 不再区分（实测它们在投影缓存里长得一样：都有 `subagent.identity`、
   * `mode` 都是 `continuable`，`parentSession` 两边都没有）。
   *
   * | 档 | 循环检测 react() | 流内早杀 | 空回合续/熔断 | 判词 |
   * |---|---|---|---|---|
   * | `strict`  | 生效 | 生效 | 生效 | `continue` / `circuit-break` |
   * | `relaxed` | 跳过 | **生效** | 跳过 | `skip:subagent:relaxed` |
   * | `exempt`  | 跳过 | **跳过** | 跳过 | `skip:subagent:exempt` |
   *
   * ★ 为什么默认 `strict`：它等于「现在的行为」，不会让谁突然失去保护。
   * ★ 为什么 `relaxed` 保留流内早杀：2026-10-23 实测（子 agent S5 的四条通知），
   *   流内早杀那次**恰恰是有用的** —— 它把一个正在推演的 agent 推向了「写盘」。
   *   真正白烧额度的是「空回合被判 continue」那三次，而它们发生在**任务已交付之后**。
   *
   * ★ 判据（三条，任一命中即认定是子 agent）：
   *   ① 运行时 `session.meta.parentSession`（DSH 写进 session header 的父会话 id）
   *   ② `session.meta.origin === 'subagent'` / `delegationDepth > 0`（别的版本可能用）
   *   ③ 兜底：读投影缓存 `record.rows.subagent.val.identity` 非空
   *
   * Default `'strict'`.
   */
  subagentPolicy?: 'strict' | 'relaxed' | 'exempt'
  /**
   * 投影缓存的会话目录，`subagentPolicy` 兜底判据要读它。
   * 留空 = `<dsh home>/storages/session_projcache/sessions`。
   */
  sessionCacheDir?: string

  /**
   * 一口气能接几次（延续上限，也是额度上限）。
   *
   * 一轮把输出预算烧光、正文没出来时，截断这一轮并**再发起一轮**
   * （`whenIdle()` → `followup()`），让它有机会把正文吐出来。这个数字是那个上限。
   *
   * ★ 它是天花板，不是充值 —— 用户把上限调高时当前额度不会自动跟着涨，
   * 要涨得靠正常对话攒（见 `正常轮阈值`）。
   * `0` 关闭整个换气层：只保留循环检测，行为回到纯 loop-guard。默认 `4`。
   */
  maxContinuations?: number
  /**
   * 攒够多少个「正常轮」额度 +1。上限不超过 `maxContinuations`。
   *
   * 「正常轮」= 用户发一句 → 正常思考并输出正文，全程没触发延续。
   * 默认 `20`。
   */
  normalTurnThreshold?: number
  /**
   * 出正文之后多少轮内又触发延续，算一次「异常」（额度 −1）。
   *
   * 窗口太短会误伤正常的长思考，太长会反应迟钝。
   * 额度降到 1 时不再降，改为提示用户手动压缩上下文。默认 `10`。
   */
  anomalyWindow?: number
  /**
   * 额度降到这个值时给一次显眼提示（GUI，不走微信 —— 那条通道要人工续命）。
   * 默认 `2`。
   */
  warnAtCredit?: number
  /**
   * 额度账本落盘路径。留空则用 `<DSH_HOME>/state/dsh-huanqi.json`。
   * ★ 落盘是必须的：不落盘的话重启一次就忘了，「每 N 轮回血」永远攒不满。默认空。
   */
  ledgerPath?: string

  /**
   * **流内早杀**：一次调用里思考写到这么多字符、而**正文和工具调用都还是零**，就地截断。
   *
   * ★ 为什么非有它不可 —— 流末那条判据要等这一轮**结束**才看见，而真实的循环能在
   * 一次调用里写满 5140 个字符（2026-10-11 实测：14:34:26 那一步，正文 0、工具 0）。
   * 等它自己停，那几分钟里没有任何人能介入。这是唯一能在流内掐掉它的判据。
   *
   * ★ 判据只有「有没有产出」这一个维度，**没有形态判断** —— 实测过，不可用：
   * 本会话 6737 步的短语池去重比，正常长推理最低到 0.12，真循环是 0.13；
   * 平均句长也一样重叠（正常有 4.17 的，循环是 5.7）。这和 `observe` 上那段
   * `low-entropy` 被删掉的标定记录是同一个结论：**没有阈值能分开它们**。
   * 所以形态维度是死的，只剩「有没有产出」。
   *
   * ★ 误报的代价可接受：被截断的一轮本来也没有产出，换气会带着「别绕了、直接做」
   * 重开一轮。漏报的代价是整条会话卡死（要人来捞）。宁可错杀。
   * `0` 关掉这条，只留流末那条。默认 `3000`。
   */
  silentReasoningChars?: number
  /**
   * 流末那条判据要**连续**几次「只有思考、没有产出」才出手。默认 `1`。
   *
   * ★ 它和 `maxThinkingSteps`（常规反应的门槛，默认 3）是**两个计数器**，
   * 这一条只管换气层，互不侵占。
   *
   * ★ 分家的理由：常规反应是「提醒一句」，错了代价小、可以等；换气是
   * 「截断 + 重开一轮」，而它要抓的那个现象**一次就足够卡死整条会话**。
   *
   * ★ 定 `1` 的依据（2026-10-11 实测本会话 6737 步）：`reasoning-only` 全史只出现
   * 4 次，**4 次全是循环事件**，正常步一次都没有 —— 误报率约等于零。
   * 而门槛停在 3，意味着**要连卡三次才有人管**；真实情况是第一次就没人管了：
   * 14:34 那一步卡死之后，是爀曦手动出声把我捞回来的，插件全程没动。
   */
  reasoningOnlySteps?: number

  /**
   * Consecutive identical normalized visible-output chunks that end the stream
   * mid-call. `0` disables the breaker. This is the only guard here that fires
   * *inside* a model call, so it is the only one that can stop a single-call
   * repetition bleed (issue #2848). Default `60`.
   *
   * Covers the period-1 case only (a byte-identical delta repeated); a model
   * bleeding a *cycle* of a few short lines resets this counter on every phase
   * change. See `maxRepeatedCycleChars`.
   */
  maxRepeatedText?: number
  /**
   * Longest repeating period, in visible-output characters, that
   * {@link trailingCycle} will recognize at the tail of a call's output.
   * `0` disables the cycle rule. Default `512`.
   *
   * Discussion #7043 reported a model that bleeds a cycle of a few short lines
   * ("好。 / 发。 / 好。 / 好。", and a mixed-language variant) for tens of
   * lines; measured on v0.1.7, that shape never fires `maxRepeatedText` under any
   * chunking, because no two consecutive deltas are identical.
   *
   * ## Why the default is 512 and not 64
   *
   * The same silent-failure rule that set the reasoning cap applies here, and
   * this side was left behind. Measured on a real 44 387-character visible-output
   * bleed: its exact minimal period is **172** characters (stable across every
   * tail window from 512 to 16 384), and the loop starts at character **139 —
   * 0.3 %** of the final text. At the old `64` default `trailingCycle` returned
   * **0** for it, so the guard never fired, the call was never cut, and the text
   * ran to 44 387 characters until the user stopped the turn by hand.
   *
   * A streaming replay of that text through {@link TextRepetitionDetector} — the
   * real detector, delta by delta, not the settled message — puts the candidate
   * caps side by side. The figures are for that ONE text:
   *
   * | cap | fires on it |
   * | --- | --- |
   * | 64 (shipped) | **0** |
   * | 128 | 0 |
   * | 256 | 1, cut at character 576 (1.3 %) |
   * | 512 | 1, cut at character 576 (1.3 %) |
   *
   * `512` is chosen over the bare-minimum `256` for the same reason the reasoning
   * side chose it: a cap below a real period fails *silently*, and the periods
   * seen on this side have already grown past a previous default once. It costs
   * nothing in precision — across every visible-output text in the session store
   * (2 973 texts of 1 500+ characters, all sessions) the cycle rule fires on
   * exactly one: the real bleed. The other 2 972 legitimate texts — reports,
   * code, tables — score `0` at every cap from 64 through 4096.
   */
  maxRepeatedCycleChars?: number
  /**
   * Shortest tail span that must be an exact repetition of a single period before
   * the cycle rule ends the stream. Default `256`.
   *
   * Exact repetition rather than a low-entropy ratio on purpose: measured against
   * legitimately repetitive long output — a 40-row markdown table (0.72 at a
   * 512-char tail), generated CSS rows (0.82), a JSON dump (0.84), a log listing
   * (0.76) — a coverage threshold only separates the loop (0.92-0.99) by ~0.06,
   * too thin for a rule that truncates a call. Verbatim periodicity is 0 for all
   * of those samples and non-zero only for the reported shapes.
   */
  minRepeatedCycleChars?: number
  /**
   * Longest repeating period, in **reasoning** characters, that ends the stream
   * mid-call. `0` disables the reasoning rule. Default `512`.
   *
   * This is the rule that closes issue #5976. That failure is a model bleeding
   * reasoning and never returning — no text, no tool call — so no post-call
   * detector can reach it and the harness turn loop never settles (`StepEndReason`
   * is derived from a finished message). Cutting the stream from inside the
   * `llm/stream` wrapper is the only mechanism that ends such a turn.
   *
   * Calibrated on real reproductions. Measured bleed periods: 89, 102, 105, 154,
   * 187, 235, and **409** characters. The 409 is why this default is `512` and
   * not the `256` an earlier calibration chose: with `256` that bleed was
   * invisible (`trailingCycle` returns 0), the guard never fired, and the turn
   * had to be aborted by hand — the exact failure the rule exists to prevent.
   * A too-low period cap fails silently, so it must sit above every observed
   * period rather than at the middle of the ones seen so far.
   */
  maxRepeatedReasoningCycleChars?: number
  /**
   * Shortest reasoning tail that must be an exact repetition of one period
   * before the reasoning rule ends the stream. Default `512`.
   *
   * Higher than the visible-output default (`256`) on purpose: reasoning is
   * private scratch space that legitimately restates a heading or a plan step, so
   * the reasoning rule demands a longer verbatim run before truncating a call.
   * Measured, `512` and `1024` select exactly the same seven calls as `256` on
   * the reproduction, so the stricter value costs no recall.
   */
  minRepeatedReasoningCycleChars?: number
  /**
   * How many characters of *repeated lines* end a reasoning bleed. Default
   * `2048`, `0` disables the rule.
   *
   * The cycle rule above only sees a bleed that repeats in the same order every
   * time. A measured reproduction recombined a pool of about eleven sentences in
   * a different order each pass, so it had no period at any cap and the cycle
   * rule never fired: 330 188 characters until the user aborted. Counting the
   * mass sitting in lines already seen catches that shape, and the two rules are
   * complementary — a pool of very short phrases is the cycle rule's job.
   *
   * The threshold is deliberately far below the smallest aborted bleed that
   * matters: the worst measured case is cut at 4096 characters, 1.2 % of its
   * final length, with no false positive on any of the 119 calls in the same
   * session that produced text or a tool call.
   */
  maxRepeatedReasoningLineChars?: number
  /**
   * The share of counted reasoning characters that must sit in repeated lines
   * before the line rule fires. Default `0.6`.
   *
   * Coherent reasoning reuses phrases ("Let me check", "OK") but the bulk of its
   * text is new, so its repeated share stays low; a bleed drawn from a fixed
   * pool approaches 1.0. Lines shorter than two characters are excluded from
   * both the numerator and the denominator, so generated code full of `}` and
   * `);` cannot drive the ratio up.
   */
  minRepeatedReasoningLineCoverage?: number
  /**
   * How concentrated the line vocabulary must be before the line rule fires:
   * the average number of sightings per distinct line. Default `4`.
   *
   * ## Why the coverage threshold alone is not enough
   *
   * `addLine` contributes `len * k` for a line seen `k >= 2` times, so the
   * "repeated mass" is exactly the total length of every line that appears at
   * least twice. The coverage ratio is therefore
   * `chars in lines seen >= 2x / chars in all lines`, and a model that quotes one
   * code block **twice** — the "before" and "after" of an edit it is planning —
   * puts almost all of its mass in lines seen exactly twice. Coverage approaches
   * 1.0 while the vocabulary is not a pool at all.
   *
   * Measured on a real reproduction (a 3713-character planning call that quoted
   * `chatStream` and `probeEffort` before and after): 58 distinct lines across
   * 104 sightings, i.e. **1.79 sightings per line**, coverage 0.640. The shipped
   * thresholds (2048 / 0.6) were cleared with 30 characters and 0.04 of margin to
   * spare, and the cut landed at character 3712 of 3713 — it saved nothing and
   * cost the turn a step.
   *
   * Across every session on this machine, the two populations separate cleanly at
   * the tripping delta:
   *
   * | shape | sightings per distinct line |
   * | --- | --- |
   * | real phrase-pool bleeds (28) | **6.4 - 84** |
   * | code-quoting calls (12) | **1.41 - 2.48** |
   *
   * `4` sits between them with a factor of ~1.6 on each side, and costs nothing
   * on the true positives: every real bleed trips at exactly the same character
   * with and without the guard.
   *
   * A large pool repeated few times (100 lines x 3) scores `3` and is rejected
   * here — that shape is {@link trailingCycle}'s job, and it catches it: 24 of
   * those 28 bleeds trip the cycle rule too.
   */
  minRepeatedReasoningLineConcentration?: number
  /**
   * Repeated-LINE characters in the call's **visible output** that end the stream
   * — the phrase-pool rule for text, mirroring
   * {@link Config.maxRepeatedReasoningLineChars}. `0` disables it. Default `2048`.
   *
   * ## Why the visible-output side needs its own phrase-pool rule
   *
   * The two visible-output rules that predate this one cannot see a reshuffled
   * phrase pool, and on a real 56 465-character bleed **both missed it by
   * construction, not by a margin**:
   *
   *  - `maxRepeatedText` counts *consecutive identical deltas*. Providers chunk
   *    text into 2-3 character fragments, so `Go.` arrives as `Go` + `.` and the
   *    longest run of identical payloads over the whole bleed was **1**, against a
   *    threshold of 60. It cannot fire at any length.
   *  - `maxRepeatedCycleChars` needs an exact period, and a reshuffled pool has
   *    none: `trailingCycle(512, 256)` returned **0**.
   *
   * That bleed was one call with zero reasoning and zero tool calls, so the
   * reasoning-side rule ({@link Config.maxRepeatedReasoningLineChars}) could not
   * reach it either — the loop ran entirely in visible output. Measured on it: 26
   * distinct phrases across 5 569 sightings, repeat mass **44 995** characters
   * (22x this threshold), coverage **0.993**, concentration **214**.
   */
  maxRepeatedTextLineChars?: number
  /**
   * Share of counted visible-output characters that must sit in repeated lines
   * before the phrase-pool rule fires. Default `0.6`, matching the reasoning side.
   */
  minRepeatedTextLineCoverage?: number
  /**
   * Average sightings per distinct line required of the visible output. Default
   * `4`, matching the reasoning side — see
   * {@link Config.minRepeatedReasoningLineConcentration} for why coverage alone is
   * not enough.
   */
  minRepeatedTextLineConcentration?: number
  /**
   * Error code carried by the breaker's terminal failure. Default
   * `'REPETITIVE_OUTPUT'`.
   *
   * There is deliberately no way to choose a quiet `stop` finish instead: the
   * breaker fires while the call's text block is still open, and the `llm/stream`
   * invariant rejects a `stop` finish with open blocks (only `error`/`aborted`
   * may leave them open). Verified by running the wrapper's own output through
   * `@deepseek-ai/dsh-llm/invariant` — see `test/text-breaker.spec.mjs`.
   */
  breakCode?: string
  /**
   * Steer the agent after a mid-stream break so the resumed turn is told what
   * happened instead of silently continuing. Default `true`.
   */
  breakCorrection?: boolean
  /**
   * Continue the turn automatically after a mid-stream break, instead of
   * leaving the session waiting for the user. Default `false`.
   *
   * Off by default because it re-enters the model without the user asking, and
   * because the failure it responds to is one where the model has already shown
   * it cannot act on its own. Turn it on when an unattended run must not stall.
   *
   * How it works, and why a naive attempt cannot work: the break is observed
   * inside the stream wrapper, which runs while the agent's phase is `running`.
   * In that phase `agent-loop` deliberately suppresses every wake —
   * `wakeDriver()` only latches behind maintenance or an aborted activity, so a
   * `steer()`/`followup()` issued here sets no `wakeRequested`, and `kick()`'s
   * `finally` (`if (wakeRequested && inbox.hasPending) wakeDriver()`) finds
   * neither and lets the session come to rest. The wake has to happen *after*
   * the driver returns to `idle`, which is what `whenIdle()` waits for.
   *
   * The continuation message is the same correction text `breakCorrection`
   * queues, delivered as a follow-up turn. It is never empty: a user message
   * with no text blocks carries no instruction, and `createUserMessage` is
   * happy to build one, so an "empty retry" would re-enter the model with the
   * degenerate history unchanged — the shape that produced the loop.
   */
  resumeAfterBreak?: boolean

  /** 空回合也续一轮（吸收自 dsh-stalled-turn-continue）。默认 true。 */
  emptyTurnContinue?: boolean

  /* ── 思考退化「治疗」层（2026-10-26 落，2026-10-28 从 lib 同步回源） ──────
   *  ★ 这四个是打断之外的**清创**参数：打断只是止血，把那段循环留在历史里，
   *    下一次更容易被激活。压缩才是把污染搬到磁盘上 + 留门牌。 */

  /**
   * 累计截断多少次后做一次范围压缩。0 = 关闭。默认 `3`。
   *
   * ★ 为什么不在第一次截断就压：单次截断是正常呼吸（`normalTurnThreshold: 20`，
   *   一轮能截断几十次）。每次都压等于每轮都在换容器。
   */
  regionCompactAfterCuts?: number
  /** 熔断时是否做全量压缩。默认 `true`。 */
  fullCompactOnBreaker?: boolean
  /** 压缩后是否注入「取回一手原文」的指引。默认 `true`。 */
  postCompactRecallHint?: boolean
  /**
   * 压缩成功后是否**再延续一次**（2026-10-31 爀曦定）。
   *
   * ★ 与 `postCompactRecallHint` 的分工：那个管**早杀后的范围压缩**，
   *   这个管**熔断后的全量压缩** —— `false` 时压缩完就停下等人。
   */
  resumeAfterCompact?: boolean
  /** 压缩后注入的「召回提示」正文。留空 = 用内置默认（{@link recallPromptText}）。 */
  recallPrompt?: string
  /**
   * 两次**范围压缩**之间至少隔多少轮（2026-10-31 加）。0 = 不限制。默认 18。
   *
   * ★ 「几次截断」量的是单轮内强度，「几轮」才是时间尺度 ——
   *   一轮里截断三十次会让 `regionCompactAfterCuts` 反复满足。
   */
  regionCompactEveryTurns?: number
  /**
   * 两次**熔断救援**（全量压缩 + 续跑召回）之间至少隔多少轮。0 = 不限制。默认 18。
   *
   * ★★★ 防死循环的主保险。没到间隔就只停下提示手动 /compact ——
   *   「依靠熔断机制来终结循环」。
   */
  breakerRescueEveryTurns?: number
  /**
   * 截断压缩是否改走「定点清除」（2026-10-31 加）。默认 `true`。
   *
   * ★ 关掉就完全退回老路：`compactRegion` / 全量 `/compact`。
   *   留这个开关是因为定点清除会**改写工具结果**，出问题时得能一键停。
   */
  purgeOnCuts?: boolean
  /** 一次最多清几条（保守起见默认 3）。 */
  purgeMaxItems?: number
  /** 多大的工具结果算「沙袋」（超过这个字符数就进候选）。默认 20000。 */
  purgeMaxChars?: number
  /** 要接的压缩服务名。留空 = `compaction`。 */
  compactionService?: string
}

/** Resolved config: every field carries its validated default. */
type ResolvedConfig = Required<Config>

export const Config: z<Config> = z.object({
  maxThinkingSteps: z.number().min(2).default(3),
  minReasoningChars: z.number().min(256).default(2048),
  similarityThreshold: z.number().min(0).max(1).default(0.8),
  escalate: z.union(['warn', 'steer', 'cancel']).default('steer'),
  maxFires: z.number().min(1).default(4),
  cancelCause: z.string().default('thinking-loop'),
  // 换气层（huanqi）—— 思考预算管理，见文件头的 Config 接口注释
  maxContinuations: z.number().step(1).min(0).max(10).default(6),
  /** 累计截断多少次后做一次范围压缩。0 = 关闭。默认 3。 */
  regionCompactAfterCuts: z.number().step(1).min(0).max(10).default(3),
  /** 熔断时是否做全量压缩。默认 true。 */
  fullCompactOnBreaker: z.boolean().default(true),
  /** 压缩后是否注入「取回一手原文」的指引。默认 true。 */
  postCompactRecallHint: z.boolean().default(true),
  /** 压缩成功后是否再延续一次（2026-10-31 加）。默认 true。 */
  resumeAfterCompact: z.boolean().default(true),
  /** 召回提示正文。留空 = 用内置默认。 */
  recallPrompt: z.string().default(''),
  /** 两次范围压缩之间至少隔多少轮。0 = 不限制。默认 18。 */
  regionCompactEveryTurns: z.number().step(1).min(0).max(200).default(18),
  /** 两次熔断救援之间至少隔多少轮。0 = 不限制。默认 18。 */
  breakerRescueEveryTurns: z.number().step(1).min(0).max(200).default(18),
  /**
   * 截断压缩是否改走「定点清除」（2026-10-31 加）。默认 true。
   *
   * 背景：`/compact-region` 内在矛盾 —— 它要 open turn + 整面静止，
   * 而换气只能在 turn 外行动，两个要求不能同时满足（六次尝试全败）。
   * 改走 surfaceOp 直接替换 tool/result，不需要 open turn。
   */
  purgeOnCuts: z.boolean().default(true),
  /** 一次最多清几条（保守起见默认 3）。 */
  purgeMaxItems: z.number().step(1).min(1).max(20).default(3),
  /** 多大的工具结果算「沙袋」（字符数）。默认 20000。 */
  purgeMaxChars: z.number().step(1000).min(2000).max(200000).default(20000),
  /** 要接的压缩服务名。留空 = `compaction`。 */
  compactionService: z.string().default(''),
  /** 子 agent（含 Agent Teams 成员）的严格程度。默认 `strict` = 现在的行为。 */
  subagentPolicy: z.union(['strict', 'relaxed', 'exempt']).default('strict'),
  /** 投影缓存目录（`subagentPolicy` 兜底判据用）。留空 = `<dsh home>/storages/session_projcache/sessions`。 */
  sessionCacheDir: z.string().default(''),
  normalTurnThreshold: z.number().step(1).min(5).max(100).default(20),
  anomalyWindow: z.number().step(1).min(3).max(50).default(10),
  warnAtCredit: z.number().step(1).min(1).max(10).default(2),
  ledgerPath: z.string().default(''),
  /**
   * 流内早杀阈值：推理写到这么多字、正文与工具调用仍是零，就地截断。
   *
   * ★★ 2026-10-23 默认值 3000 → **8000**。
   *   这个数 2026-10-12 就已经在本机拍板改成 8000 了（3000 实测误杀约 7.9% 的正常长推理：
   *   probe-loop 全量 7533 步里，3000 字以上的正常步有 592 个，当晚被误截断 4 次、全是正常思考，
   *   额度被误耗到 0 导致熔断；放宽后误杀率降到 0.37%）。
   *   **但那天只改了本机 profile 的覆盖值，默认值一直停在 3000** ——
   *   于是「作者机器上对、新装的人会被误杀」，和本仓库这一整天在修的是同一个病。
   *   ★ 判据：一个参数的安全值不该靠「记得在 profile 里覆盖它」来保证。
   */
  silentReasoningChars: z.number().step(1).min(0).default(8000),
  reasoningOnlySteps: z.number().step(1).min(1).max(10).default(1),
  maxRepeatedText: z.number().step(1).min(0).default(60),
  maxRepeatedCycleChars: z.number().step(1).min(0).default(512),
  minRepeatedCycleChars: z.number().step(1).min(2).default(256),
  maxRepeatedReasoningCycleChars: z.number().step(1).min(0).default(512),
  minRepeatedReasoningCycleChars: z.number().step(1).min(2).default(512),
  maxRepeatedReasoningLineChars: z.number().step(1).min(0).default(2048),
  minRepeatedReasoningLineCoverage: z.number().min(0).max(1).default(0.6),
  minRepeatedReasoningLineConcentration: z.number().min(0).default(4),
  maxRepeatedTextLineChars: z.number().step(1).min(0).default(2048),
  minRepeatedTextLineCoverage: z.number().min(0).max(1).default(0.6),
  minRepeatedTextLineConcentration: z.number().min(0).default(4),
  breakCode: z.string().default('REPETITIVE_OUTPUT'),
  breakCorrection: z.boolean().default(true),
  resumeAfterBreak: z.boolean().default(false),

  /**
   * 空回合也续一轮（2026-10-19 从 `dsh-stalled-turn-continue` 吸收）。
   *
   * 上面所有判据都挂在 `llm/stream` 上 —— 它们只在「有一次模型调用」时才有机会看一眼。
   * 而有一种失败是「调用了，但什么都没留下」：模型只发了 reasoning 块，
   * 然后直接给 end-of-turn，没有 text、没有工具调用。引擎把它当成正常结束
   * （`finish_reason: stop`、零工具调用），于是 auto-continue 不管它，
   * 会话就停在那儿等人手打「继续」。
   *
   * ★ 这是换气原本的第四个缺口。前三个（流内早杀 / 流末 reasoning-only /
   *   重复输出）都要求「流里有东西可看」，而空回合**流里什么都没有**。
   *
   * ★ 判据：`turn/end` 且 reason 是 `completed` 或 `no-visible-output`，
   *   且这一轮从头到尾没出现 text / tool-call。
   *
   * ★ 它和流内那几条**共用同一个额度账本**（`ledger`），不另立一本 ——
   *   一次续命就是一次续命，不管起因是哪种病。`false` 关掉这条，别的不受影响。
   */
  emptyTurnContinue: z.boolean().default(true),
})

export const name = 'huanqi'

/**
 * Cordis services this plugin resolves off the Context.
 *
 * Declaring `agents` is REQUIRED, not documentation: Cordis's context proxy
 * throws `cannot get property "agents" without inject` for any service read
 * that the fiber did not declare (vendor/cordis/src/reflect.ts, the
 * `waterfall('internal/get', …)` guard). The plugin reaches the live Agent via
 * `ctx.agents.get(options.sessionId)`, so without this line `apply()` throws on
 * activation and every session in that deployment fails to run.
 *
 * TypeScript cannot catch this: `ctx.agents` type-checks as soon as
 * `@deepseek-ai/dsh-agent` is in the type graph, because the guard is purely
 * runtime. That is exactly how v0.1.1 shipped broken (issue #1).
 */
export const inject = ['agents']

/**
 * Register this plugin's own message-source kind with the harness.
 *
 * `MessageSourceMap` is a merge-extensible sum type: each producer declares its
 * own `kind` in its own module. The augmentation is what makes
 * `source: { kind: 'loop-guard', ... }` typecheck, and it is additive — consumers
 * fall through unknown kinds, so it cannot break a host that has never heard of
 * us. Declared this way rather than by widening our own literal, so the compiler
 * still rejects a misspelled kind.
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'loop-guard': {
      kind: 'loop-guard'
    } & ContextFormed
  }
}

/** The attribution this plugin stamps on every notice it injects. */
const PLUGIN_SOURCE = { kind: 'loop-guard' } as const

/**
 * Build one model-facing notice from the guard.
 *
 * The source kind is the plugin's own id, which is what the transcript's
 * attribution row renders. `summary` is a one-line account of *what happened* —
 * the collapsed transcript row renders it, and `boundContextSummary` caps it at
 * {@link CONTEXT_SUMMARY_MAX_CHARS} — so it states the event rather than
 * repeating the plugin name, the way `guard/repeat-tool-reminder` summarises as
 * `<tool> × <count>`.
 *
 * @param text - the full notice body.
 * @param form - the context form; always `notice` here.
 * @param summary - the one-line account for the collapsed row.
 */
function message(text: string, form: 'notice', summary: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { ...PLUGIN_SOURCE, form, summary },
  })
}

/* -------------------------------------------------------------------------- */
/* Detection primitives (exported for tests)                                  */
/* -------------------------------------------------------------------------- */

/** Fixed window used for both the intra-call and cross-call measures. */
export const GRAM_SIZE = 4

/**
 * How many newly emitted visible characters must accumulate before the cycle
 * rule re-scans the tail. The scan is bounded by `minRepeatedCycleChars`, so a
 * fixed stride keeps the whole rule linear in emitted characters.
 */
const CYCLE_CHECK_STRIDE = 32

/**
 * The shortest line the line-repeat rule counts, in characters.
 *
 * A line this short or shorter is not evidence of anything: generated code
 * repeats `}` and `);` by the hundred legitimately, and a brace is one
 * character. Two characters is the floor at which a line starts carrying
 * content (`OK`, `Go`), which is exactly the vocabulary a phrase-pool bleed
 * recombines.
 */
const LINE_MIN_CHARS = 2

/**
 * Which detector ended a call, for the log line, the notice noun and tests.
 *
 * `identical-chunks` and `repeating-cycle` watch visible output;
 * `reasoning-cycle` and `reasoning-lines` watch reasoning under the two
 * complementary rules described on {@link ReasoningLoopBreaker}.
 */
export type BreakRule = 'identical-chunks' | 'repeating-cycle' | 'reasoning-cycle' | 'reasoning-lines' | 'text-lines'

/**
 * The phrase-pool accumulator shared by the reasoning and visible-output rules.
 *
 * Both sides need the same measure: how much of the text sits in lines that have
 * been seen more than once, and how concentrated that vocabulary is. Keeping one
 * implementation means a threshold change cannot make the two sides disagree.
 *
 * ## Why the visible-output side needs it at all
 *
 * A bleed can reshuffle a small phrase pool instead of repeating one period, and
 * that shape is invisible to both visible-output rules that predate this:
 *
 *  - `identical-chunks` counts *consecutive identical deltas*. Providers chunk
 *    text into 2-3 character fragments, so `Go.` arrives as `Go` + `.` and the
 *    longest run of identical payloads on a real 56 465-character bleed was
 *    **1** — the rule cannot reach 60 at any length.
 *  - `repeating-cycle` needs an exact period. A reshuffled pool has none: on that
 *    same bleed `trailingCycle(512, 256)` returned **0**.
 *
 * Measured on that bleed (one call, zero reasoning, zero tool calls): 26 distinct
 * phrases across 5 569 sightings, repeat mass **44 995** characters, coverage
 * **0.993**, concentration **214**. Every threshold here is cleared by an order of
 * magnitude, so the rule fires early rather than at the end.
 *
 * Incremental: each complete line is folded in exactly once, so the cost stays
 * linear in emitted characters.
 */
class PhrasePool {
  /** How many times each counted line has been seen. */
  private readonly counts = new Map<string, number>()
  /** Characters sitting in counted lines. */
  private total = 0
  /** Characters sitting in lines that have been seen more than once. */
  private repeat = 0
  /** Total sightings of counted lines (the denominator of the concentration). */
  private instances = 0
  /** Trailing text not yet terminated by a newline. */
  private partial = ''

  /** The repeated mass so far, for the break report. */
  get repeatedChars(): number {
    return this.repeat
  }

  /** Fold one delta in, counting only the lines it completes. */
  push(text: string): void {
    this.partial += text
    let idx: number
    while ((idx = this.partial.indexOf('\n')) >= 0) {
      this.addLine(this.partial.slice(0, idx).trim())
      this.partial = this.partial.slice(idx + 1)
    }
  }

  /**
   * Whether the accumulated pool has crossed every threshold.
   *
   * @param minRepeat - characters that must sit in repeated lines.
   * @param minCoverage - share of counted characters that must be repeated.
   * @param minConcentration - average sightings per distinct line. Coverage alone
   *   cannot tell a phrase pool from one long block quoted twice; see
   *   {@link Config.minRepeatedReasoningLineConcentration}.
   */
  tripped(minRepeat: number, minCoverage: number, minConcentration: number): boolean {
    if (this.repeat < minRepeat) return false
    if (this.total === 0) return false
    if (this.repeat / this.total < minCoverage) return false
    if (this.counts.size === 0) return false
    return this.instances / this.counts.size >= minConcentration
  }

  /**
   * Fold one complete line into the running counts.
   *
   * The repeat mass is maintained rather than recomputed: on the *second*
   * sighting of a line both copies become repetition, hence `* 2`, and every
   * sighting after that adds one more copy. Lines below {@link LINE_MIN_CHARS}
   * are dropped entirely so they never enter the denominator either.
   *
   * @param line - the trimmed line.
   */
  private addLine(line: string): void {
    if (line.length < LINE_MIN_CHARS) return
    const prev = this.counts.get(line) ?? 0
    this.counts.set(line, prev + 1)
    this.total += line.length
    this.instances += 1
    if (prev === 1) this.repeat += line.length * 2
    else if (prev > 1) this.repeat += line.length
  }
}

/**
 * The distinct fixed-length grams of one reasoning text.
 *
 * Fixed-length windows are the language-agnostic choice: CJK loops
 * ("好。执行。") have no whitespace, so a whitespace-token histogram collapses to
 * one token and can never distinguish repetition.
 *
 * @param text - the reasoning text of one call.
 * @param size - the window length in characters.
 * @returns the set of distinct windows (empty for text shorter than `size`).
 */
export function grams(text: string, size = GRAM_SIZE): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i + size <= text.length; i++) out.add(text.slice(i, i + size))
  return out
}

/**
 * Low-entropy ratio: coverage of one text by repeated fixed-length grams.
 *
 * ## Not a loop detector — do not use it as one
 *
 * This is kept as a **diagnostic**, exported for `tools/analyze-session.mjs` and
 * the tests. It is deliberately no longer wired into {@link LoopDetector}; the
 * measurement behind that decision is on {@link LoopDetector.observe}.
 *
 * The short version: the ratio rises with **length**, because the number of
 * distinct 4-grams in natural language saturates. One continuous non-repeating
 * English document scores 0.290 at 2048 characters and 0.629 at 20 000; this
 * repo's own `README_EN.md` and `src/index.ts` score 0.54-0.65, above the `0.5`
 * that used to be the threshold, while a genuine periodic loop scores
 * 0.994-0.999. It separates "long" from "short", not "stuck" from "working".
 *
 * A tight repetition ("好。执行。" x N) still scores near 1.0, so it remains a
 * useful *descriptive* statistic on a text already known to be a loop.
 *
 * @param reasoning - the reasoning text of one call.
 * @returns the fraction of windows that had already appeared in the same text.
 */
export function repeatRatio(reasoning: string): number {
  if (reasoning.length < 16) return 0
  const k = Math.min(GRAM_SIZE, Math.max(2, Math.floor(reasoning.length / 16)))
  let repeated = 0
  let total = 0
  const seen = new Set<string>()
  for (let i = 0; i + k <= reasoning.length; i++) {
    const gram = reasoning.slice(i, i + k)
    total++
    if (seen.has(gram)) repeated++
    else seen.add(gram)
  }
  return total === 0 ? 0 : repeated / total
}

/**
 * Containment of one gram set in another: the fraction of the SMALLER set's
 * grams present in the larger.
 *
 * Containment rather than Jaccard on purpose. A stuck model typically restates
 * the previous step's material and appends another sentence, so the new set is a
 * near-superset of the old one; Jaccard would dilute that with the new material
 * and let the step look like progress, while containment reports the repetition
 * directly.
 *
 * @param a - one call's distinct grams.
 * @param b - another call's distinct grams.
 * @returns `0` when either set is empty, otherwise the containment in `[0, 1]`.
 */
export function containment(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let shared = 0
  for (const gram of small) if (large.has(gram)) shared++
  return shared / small.size
}

/** What one completed model call looked like to the guard. */
export interface StepObservation {
  /** Whether the call emitted any `text-delta` or `tool-call-delta`. */
  readonly hasOutput: boolean
  /** The call's total reasoning text. */
  readonly reasoning: string
}

/**
 * Why one call was counted as stalled (`undefined` = it was progress).
 *
 * Both reasons are structural: no output at all, or the previous call's material
 * restated. There is deliberately no "low-entropy" member — see
 * {@link LoopDetector.observe} for the measurement that removed it.
 */
export type StallReason = 'reasoning-only' | 'repeated-material'

/**
 * The per-agent detector: accumulates stalled calls and decides when to react.
 *
 * Kept free of Cordis types so the decision rule is unit-testable without a
 * harness: the plugin only feeds it observations and applies the reaction.
 */
/* ────────────────────────────────────────────────────────────────────────── */
/* 换气（huanqi）：延续额度                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

/** 账本里记着什么。将来要落盘时，这个形状就是落盘的形状。 */
export interface LedgerState {
  /** 当前额度。`0` 表示不允许延续。 */
  credit: number
  /** 额度上限（用户设置的那个数）。★ 它是天花板，不是充值。 */
  creditMax: number
  /** 距离下一次回血还差几个正常轮。 */
  normalTurns: number
  /**
   * 距离上一次"真的输出了正文"过了几次流。
   *
   * ★ 这一个字段就是"异常扣分"的判据本体：出正文说明这一轮通顺，
   * **紧接着又卡**说明"卡"不是偶然，是上下文在变脏。
   *
   * `undefined` = 这个账本还从没见过一次正文输出 —— 那时**不判异常**，
   * 因为没有可比对的基准。（第一次就卡不算"刚恢复又卡"。）
   */
  turnsSinceOutput?: number
  /** 上次"异常"的时间戳（毫秒）。没有过就是 `undefined`。 */
  lastAnomalyAt?: number
  /** 累计统计，只增不减，用于复盘。 */
  stats: { continuations: number; circuitBreaks: number; anomalies: number }
}

/**
 * 延续额度的记账本。
 *
 * ## 它是什么
 *
 * 一支**体温计**，不是配额表。逻辑链：
 * **上下文脏了 → 模型更容易卡 → 额度自动降 → 降到 1 → 提示用户手动压缩 →
 * 压缩后上下文干净 → 正常对话攒够 → 额度自己涨回来。**
 *
 * 它量的是**实际发生的事**（卡了几次、中间隔了多少轮），不是谁报告的数值。
 *
 * ## 三条不能改的规则
 *
 * 1. **上限调高不充值。** 用户把 `maxContinuations` 从 4 调到 8，当前额度**不动**；
 *    要涨得靠正常对话攒。（爀曦 2026-10-10 明确同意：「上限是天花板，不是充值。」）
 * 2. **上限调低要压。** 额度高于新上限时立刻压到新上限。
 * 3. **额度最低 1。** 到 1 就不再降 —— 继续降等于彻底关掉这个功能，
 *    而那时恰恰最需要它把问题摆到用户面前。
 *
 * ## 全局，不按会话
 *
 * 额度是**跨会话共享**的（爀曦 2026-10-10 定：「分会话管理会很麻烦」）。
 * 所以一个会话把额度耗光，会影响其他会话 —— 这是有意的：
 * **上下文变脏通常是全局性的**（同一台机器、同一批模型、同样的用法）。
 */
export class CreditLedger {
  private state: LedgerState

  /**
   * @param max - 额度上限（来自配置）。
   */
  constructor(private readonly max: number) {
    this.state = {
      credit: max,
      creditMax: max,
      normalTurns: 0,
      stats: { continuations: 0, circuitBreaks: 0, anomalies: 0 },
    }
  }

  /** 当前额度。 */
  get credit(): number {
    return this.state.credit
  }

  /** 上限。 */
  get creditMax(): number {
    return this.state.creditMax
  }

  /** 攒到哪一步了（离回血还差几轮）。 */
  get normalTurns(): number {
    return this.state.normalTurns
  }

  /**
   * 距离上一次真的输出正文，过了几轮。
   *
   * `undefined` = 这个账本还从没见过一次正文输出 —— 那时**不判异常**（没有基准）。
   */
  get turnsSinceOutput(): number | undefined {
    return this.state.turnsSinceOutput
  }

  /** 累计统计（只增不减，复盘用）。 */
  get stats(): Readonly<LedgerState['stats']> {
    return this.state.stats
  }

  /** 只读快照，给日志和界面用。 */
  snapshot(): Readonly<LedgerState> {
    return this.state
  }

  /** 还能不能延续。 */
  canContinue(): boolean {
    return this.max > 0 && this.state.credit > 0
  }

  /**
   * 用掉一次延续机会。
   *
   * @returns 用掉之后还剩多少；已经是 0 就返回 0（调用方应该已经查过 `canContinue`）。
   */
  spendContinuation(): number {
    if (this.state.credit > 0) this.state.credit -= 1
    this.state.stats.continuations += 1
    return this.state.credit
  }

  /** 记一次熔断（额度耗尽、不再开新一轮）。 */
  noteCircuitBreak(): void {
    this.state.stats.circuitBreaks += 1
  }

  /**
   * 一个"正常轮"结束了：用户发了一句 → 正常思考并输出正文，全程没触发延续。
   *
   * @param threshold - 攒够多少轮涨一点额度。
   * @returns 这一次是否涨了额度。
   */
  onNormalTurn(threshold: number): boolean {
    if (threshold <= 0) return false
    this.state.normalTurns += 1
    if (this.state.normalTurns < threshold) return false
    this.state.normalTurns = 0
    if (this.state.credit >= Math.min(this.max, this.state.creditMax)) return false
    this.state.credit += 1
    return true
  }

  /**
   * 这一轮流真的输出了正文 —— 重置"距上次出正文"的计数。
   *
   * ★ 它是异常判据的锚点：只有见过一次正文，后面的"又卡了"才有可比对的基准。
   */
  noteOutput(): void {
    this.state.turnsSinceOutput = 0
  }

  /**
   * 这一轮流结束，但没有正文输出（或者还没轮到判）。
   *
   * ★ 刻意在 `undefined` 时不动 —— 它表示"这个账本从没见过一次正文"，
   * 那时不该开始计数，否则"会话刚开始就卡"会被误判成"刚恢复又卡"。
   */
  noteTurn(): void {
    if (this.state.turnsSinceOutput !== undefined) this.state.turnsSinceOutput += 1
  }

  /**
   * 一次延续发生了。判断它算不算"异常"，算就扣分。
   *
   * 判据（设计文档第五节）：**出正文说明这一轮通顺，紧接着又卡说明"卡"不是偶然，
   * 而是上下文在变脏。** 所以 `turnsSinceOutput <= window` 时扣一分。
   *
   * @param window - 异常窗口（轮）。`<= 0` = 用户关掉了这一档，只记时间不扣分。
   * @param now - 当前时间戳（毫秒）。传入是为了让测试可控。
   * @returns 这一次是否记成了异常（也就是是否扣了额度）。
   */
  onContinuation(options: {
    window: number
    now: number
  }): boolean {
    const since = this.state.turnsSinceOutput
    // ★ 两个"不判异常"的情形：没见过正文（没有基准）、或窗口被关掉。
    const isAnomaly = since !== undefined && options.window > 0 && since <= options.window
    if (!isAnomaly) {
      this.state.lastAnomalyAt = options.now
      return false
    }
    this.penalise(options.now)
    return true
  }

  /**
   * 记一次异常并扣额度。
   *
   * @returns 扣完之后的额度。
   */
  penalise(now: number): number {
    this.state.lastAnomalyAt = now
    this.state.stats.anomalies += 1
    if (this.state.credit > 1) this.state.credit -= 1
    return this.state.credit
  }

  /** 上限变了（用户在设置里改的）。规则见类注释：调高不充值，调低要压。 */
  reconcileMax(next: number): void {
    this.state.creditMax = next
    if (this.state.credit > next) this.state.credit = next
  }

  /* ── 落盘 ─────────────────────────────────────────────────────────────
   * 不落盘的话重启一次就回到满额，「攒额度」永远攒不满 —— 那这支体温计
   * 就只能量一段会话，量不了长期。所以这里补上。
   * ────────────────────────────────────────────────────────────────────── */

  /**
   * 从盘上恢复额度。
   *
   * 三条纪律：
   *
   * 1. **读不到就当没有** —— 第一次跑、文件被删、路径写错，都退回"满额开局"。
   * 2. **坏了也不抛** —— 格式不对就忽略。一个记分牌不该让会话起不来。
   * 3. **上限以配置为准，不用盘上的** —— 盘里的 `creditMax` 可能是旧的（用户改过设置），
   *    所以只拿回 `credit` / `normalTurns` / `stats`，上限仍由构造时的 `max` 决定。
   *    这样"改上限"永远只由配置说了算，账本只负责记额度。
   *
   * @param path - 账本路径。
   * @param onWarn - 出问题时的报告口（通常是 `ctx.logger.warn`）。
   * @returns 是否真的恢复了（`false` = 按满额开局）。
   */
  load(path: string, onWarn: (msg: string) => void): boolean {
    if (path === '') return false
    try {
      if (!existsSync(path)) return false
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<LedgerState>
      const credit = typeof raw.credit === 'number' && Number.isFinite(raw.credit)
        ? Math.max(0, Math.min(Math.trunc(raw.credit), this.state.creditMax))
        : undefined
      if (credit === undefined) {
        onWarn(`dsh-huanqi: ledger at ${path} has no usable "credit"; starting from full`)
        return false
      }
      this.state.credit = credit
      if (typeof raw.normalTurns === 'number' && raw.normalTurns >= 0) {
        this.state.normalTurns = Math.trunc(raw.normalTurns)
      }
      // ★ 异常窗口的计数器也要跟着走 —— 不然重启一次"脚下有多滑"就忘了。
      if (typeof raw.turnsSinceOutput === 'number' && raw.turnsSinceOutput >= 0) {
        this.state.turnsSinceOutput = Math.trunc(raw.turnsSinceOutput)
      }
      const s = raw.stats
      if (s !== undefined && typeof s === 'object') {
        const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0)
        this.state.stats = {
          continuations: n(s.continuations),
          circuitBreaks: n(s.circuitBreaks),
          anomalies: n(s.anomalies),
        }
      }
      return true
    } catch (error: unknown) {
      // ★ 绝不抛：账本坏掉不是让会话起不来的理由。
      onWarn(`dsh-huanqi: could not read the ledger at ${path}: ${String(error)}`)
      return false
    }
  }

  /**
   * 把额度写回盘。
   *
   * ★ 同样是"失败只报告、绝不抛"。写盘发生在延续/回血这些低频时刻，
   * 不是每次流式调用，所以同步写不会卡；而**宁可丢一次记账，也不能让守卫本身成为故障**。
   *
   * @param path - 账本路径。空字符串 = 不落盘（用户没配也没默认值时）。
   * @param onWarn - 出问题时的报告口。
   */
  save(path: string, onWarn: (msg: string) => void): void {
    if (path === '') return
    try {
      const dir = dirname(path)
      if (dir !== '' && !existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(path, JSON.stringify(this.state, null, 2) + '\n', 'utf8')
    } catch (error: unknown) {
      onWarn(`dsh-huanqi: could not write the ledger at ${path}: ${String(error)}`)
    }
  }

  /**
   * 账本的默认路径：`<DSH_HOME>/state/dsh-huanqi.json`。
   *
   * 为什么要走环境变量而不是硬编码：`DSH_HOME` 是 DSH 自己给每个子进程的，
   * 换一台机器、换一次安装位置都自动跟着走。
   *
   * ★★ 2026-10-23 改：取不到 `DSH_HOME` 时**不能再退回 `join('.', ...)`**。
   *   那是相对**进程 cwd** 的 —— 账本落点会随启动目录漂移，重启一次就可能「额度莫名回满」，
   *   而且写不进去时只 `logger.warn`（桌面端根本不落盘）→ 完全静默。
   *   这个 bug 来自第一个用户的实机验收报告：他的机器上 `DSH_HOME` **就是空的**，
   *   于是账本落到 profile 根，而换气面板按 `DSH_HOME/state` 去找 —— **两边分叉，面板永远空**。
   *   DSH 的标准位置是 `~/.dsh`（本机实测 `~/.dsh` 也存在），所以兜底用它。
   */
  static defaultPath(): string {
    const home = process.env.DSH_HOME
    const root = home !== undefined && home !== ''
      ? home
      : join(homeDir(), '.dsh')
    return join(root, 'state', 'dsh-huanqi.json')
  }
}

export class LoopDetector {
  private stalled = 0
  private fires = 0
  private previous: Set<string> | undefined
  private lastReason: StallReason | undefined

  /**
   * @param config - the resolved plugin configuration.
   */
  constructor(private readonly config: ResolvedConfig) {}

  /** The stalled-run length that would trigger the next reaction. */
  get threshold(): number {
    return this.config.maxThinkingSteps
  }

  /** How many reactions have fired for this agent so far. */
  get fired(): number {
    return this.fires
  }

  /**
   * 当前连续停滞了几次（没被 `takeFire` 或 `reset` 清零之前）。
   *
   * ★ 这是给**换气层**用的：它不消费 `fires`（那是常规反应的预算），
   * 而是自己数"连着几次只有推理、没有正文"。两个计数器各管一段，互不侵占 ——
   * 否则一次出手会同时扣掉两边的额度，行为就说不清了。
   */
  get stalledRun(): number {
    return this.stalled
  }

  /** 上一次停滞的形态；`undefined` 表示没有正在累积的停滞。 */
  get lastStallReason(): StallReason | undefined {
    return this.lastReason
  }

  /**
   * Observe one completed model call.
   *
   * ## Why there is no intra-call ratio rule here
   *
   * An earlier version added a third reason, `low-entropy`: `repeatRatio` at or
   * above `0.5` on a call that did produce output. It was removed after being
   * measured on a real 4380-record session, where it fired **12 times and not
   * once on a loop**:
   *
   *  - Of the 36 calls it judged across those 12 fires, **33 (92 %)** were calls
   *    that had just made a tool call — `edit`, `write`, `read`, `grep`, `pwsh`.
   *    **Zero** were calls that produced neither output nor a tool call.
   *  - Across the whole session, on the 152 calls that produced output, it fired
   *    on **91 (59.9 %)**.
   *  - No threshold rescues it: the highest ratio on a productive call is
   *    **0.797** and the lowest on a reasoning-only call is **0.308**, so the
   *    ranges overlap and no cut-off separates them. At `0.5` it flags 60 % of
   *    productive calls; at `0.8` it flags none but also misses half the real
   *    bleeds.
   *  - The reason is arithmetic, not tuning. `repeatRatio` counts 4-grams
   *    already seen; the distinct 4-gram count of natural language saturates, so
   *    the ratio is pushed up by **length**. Scoring one continuous
   *    non-repeating English document at growing prefixes gives 0.290 at 2048
   *    characters, 0.495 at 8000, 0.629 at 20 000 — and the repo's own
   *    `README_EN.md` and `src/index.ts` score 0.54-0.65, i.e. above the
   *    threshold, while a genuine periodic loop scores 0.994-0.999. Spearman
   *    rho(length, ratio) = 0.606.
   *
   * So the rule was not a loop detector but a "reasoning longer than roughly
   * 8000 characters" detector. Its cost was not only the wrong steers: `fires` is
   * a per-agent budget, so four false positives exhausted `maxFires` and left the
   * guard silent for the rest of the process — the failure recorded in
   * {@link ReasoningLoopBreaker}'s calibration notes, where the three real bleeds
   * of a reproduction drew no reaction at all.
   *
   * The two reasons that remain are both structural and were clean on the same
   * data: `reasoning-only` fired on 0 of 152 productive calls, and
   * `repeated-material` needs 80 % of the previous call's distinct material
   * restated.
   *
   * @param step - the call's output shape and reasoning text.
   * @returns the reason it counted as stalled, or `undefined` when it was progress.
   */
  observe(step: StepObservation): StallReason | undefined {
    // A short burst is normal and carries too little material to judge. It is
    // neither counted nor treated as progress — it must not clear a run built
    // from substantive steps.
    if (step.reasoning.length < this.config.minReasoningChars) return undefined

    const current = grams(step.reasoning)
    const repeated = this.previous !== undefined
      && this.config.similarityThreshold > 0
      && containment(this.previous, current) >= this.config.similarityThreshold
    this.previous = current

    const reason: StallReason | undefined = !step.hasOutput
      ? 'reasoning-only'
      : repeated
        ? 'repeated-material'
        : undefined

    if (reason === undefined) {
      // Real progress: the run is over.
      this.stalled = 0
      this.lastReason = undefined
      return undefined
    }

    this.stalled += 1
    this.lastReason = reason
    return reason
  }

  /**
   * Whether a reaction is due now, consuming one fire when it is.
   *
   * A single intervention often does not break a strong loop, so a fire resets
   * the run counter (another full run of stalled calls is needed) and is capped
   * by `maxFires` so the guard cannot intervene forever.
   *
   * @returns the reason to report in the reaction, or `undefined` when no reaction is due.
   */
  takeFire(): StallReason | undefined {
    if (this.stalled < this.config.maxThinkingSteps) return undefined
    if (this.fires >= this.config.maxFires) return undefined
    this.fires += 1
    this.stalled = 0
    const reason = this.lastReason ?? 'reasoning-only'
    this.lastReason = undefined
    return reason
  }

  /** Forget every observation (used when a loop is judged broken by real output). */
  reset(): void {
    this.stalled = 0
    this.previous = undefined
    this.lastReason = undefined
  }
}

/* -------------------------------------------------------------------------- */
/* Mid-stream repetition breaker (issue #2848)                                */
/* -------------------------------------------------------------------------- */

/**
 * Count how many of a list of visible-output chunks are a trailing run of
 * identical payloads (compared after trimming).
 *
 * Anchored at the tail on purpose: the breaker wants the *current* run, so
 * interleaved reasoning deltas (which are not passed here) and any earlier
 * unrelated text cannot mask it. Whitespace-only chunks normalize to `''` and
 * therefore count as repetitions of each other, which is the intended reading —
 * a stream emitting nothing but blank lines for a minute is equally stuck.
 *
 * @param texts - the call's `text-delta` payloads, in stream order.
 * @returns the length of the trailing identical run (`0` for an empty list).
 */
export function countRepeatedText(texts: readonly string[]): number {
  const last = texts.at(-1)
  if (last === undefined) return 0
  const normalized = last.trim()
  let run = 0
  for (let i = texts.length - 1; i >= 0; i--) {
    if (texts[i]!.trim() !== normalized) break
    run++
  }
  return run
}

/**
 * The tail span that is an exact repetition of one short period, or `0` when the
 * tail is not periodic (discussion #7043).
 *
 * This generalizes {@link countRepeatedText} from "the same delta twice" to
 * "the same *cycled* output for hundreds of characters", and it is
 * newline-agnostic: the period is measured in characters, so a bleed that never
 * emits a line break is caught identically to a one-line-per-delta bleed.
 *
 * Two guards keep it off legitimate output:
 *
 *  - **Exactness.** The whole span must be a verbatim repetition; a near-repeat
 *    scores `0`. Measured: a 40-row markdown table, generated CSS rows, a JSON
 *    dump and a 60-line log listing are all period-free while scoring
 *    0.72-0.84 on a *coverage* measure of the same text — a ratio rule would
 *    have had to separate the loop from those by ~0.06.
 *  - **A period of at least two distinct characters.** A run of `=` or `-` is a
 *    legitimate divider, and a one-character period would flag every long rule
 *    line in a generated document.
 *
 * The scan stops as soon as the minimum is met, so the returned span is
 * `max(minSpan, 2 * period)` rather than the longest periodic tail that exists:
 * the caller only distinguishes zero from non-zero, and stopping early keeps the
 * rule bounded on a call that bleeds for hundreds of thousands of characters.
 *
 * @param text - the accumulated visible output of one call.
 * @param maxPeriod - the longest period to consider, in characters.
 * @param minSpan - the shortest qualifying tail span, in characters.
 * @returns the qualifying span in characters (`>= minSpan`), or `0`.
 */
export function trailingCycle(text: string, maxPeriod: number, minSpan: number): number {
  if (maxPeriod < 1) return 0
  for (let period = 1; period <= maxPeriod; period++) {
    // The last `period` characters are the template; walk backwards while the
    // output still matches itself one period earlier.
    const template = text.slice(text.length - period)
    if (new Set(template).size < 2) continue
    const need = Math.max(minSpan, 2 * period) - period
    const limit = Math.min(text.length - period, need)
    let matched = 0
    while (matched < limit && text[text.length - period - 1 - matched] === text[text.length - 1 - matched]) matched++
    if (matched >= need) return matched + period
  }
  return 0
}

/**
 * The FULL span of the periodic tail, for reporting how much actually repeated.
 *
 * {@link trailingCycle} is the decision rule and deliberately stops as soon as the
 * minimum span is met — it runs on a fixed stride while the stream is still open,
 * so walking the whole tail every time would be wasted work. The consequence is
 * that its return value is a **lower bound** (`>= minSpan`), not the size of the
 * repetition: a bleed that cycles for 20 000 characters still reports `512`, the
 * threshold.
 *
 * That is fine for deciding, and wrong for telling the model how long it has been
 * going in circles. This picks the same period by the same qualification test and
 * then walks it all the way back, so the figure is the true span. It is O(tail)
 * and runs exactly once, at the delta that trips the rule.
 *
 * @param text - the accumulated output of one call.
 * @param maxPeriod - the longest period to consider, in characters.
 * @param minSpan - the shortest qualifying tail span, in characters.
 * @returns the full periodic span in characters, or `0` when no period qualifies.
 */
export function periodicTailSpan(text: string, maxPeriod: number, minSpan: number): number {
  if (maxPeriod < 1) return 0
  for (let period = 1; period <= maxPeriod; period++) {
    const template = text.slice(text.length - period)
    if (new Set(template).size < 2) continue
    const need = Math.max(minSpan, 2 * period) - period
    // Same test as `trailingCycle`, but the walk is unbounded, so `matched` is
    // the real extent of the periodicity rather than a capped one.
    const limit = text.length - period
    let matched = 0
    while (matched < limit && text[text.length - period - 1 - matched] === text[text.length - 1 - matched]) matched++
    if (matched >= need) return matched + period
  }
  return 0
}

/**
 * The reasoning breaker: the one rule that can end a thinking loop.
 *
 * ## Why this exists separately from every other detector here
 *
 * Issue #5976's failure is a model that degrades into a **pure reasoning bleed**
 * and never returns: no `text-delta`, no `tool-call-delta`, so the step never
 * settles. Measured on a real reproduction (a 174 MB session, 4628 calls, dsh
 * 0.1.5-rc.2), the final three calls emitted 74 193 / 357 112 / 134 244
 * characters of reasoning and nothing else.
 *
 * Every other detector in this file is structurally too late for that shape:
 *
 *  - {@link LoopDetector} judges a call **after** it ends. A bleed that does not
 *    end never reaches it. On the reproduction its `maxFires` budget was already
 *    spent by four false positives early in the session (the `low-entropy` rule,
 *    since removed — see {@link LoopDetector.observe}), so the three real bleeds
 *    produced no reaction at all.
 *  - {@link TextRepetitionDetector} watches `text-delta` only, by design, because
 *    visible output is what a repetition is normally visible in. Here the bleed
 *    is entirely in reasoning, so it never saw a chunk.
 *
 * The harness itself has no seam for this either: `packages/core/agent-loop`
 * derives `StepEndReason` from the finished message, so a stream that keeps
 * producing reasoning never settles and the `while (true)` turn loop never
 * breaks — which is exactly what the reporter observed as "只能手动中止".
 *
 * ## Why it is safe to watch reasoning, which legitimately revisits itself
 *
 * The rule is the same **exact verbatim periodicity** as the visible-output
 * cycle rule, not a low-entropy ratio. Calibrated against real reproductions —
 * every call with >= 2048 reasoning characters, of which the overwhelming
 * majority produced text or a tool call:
 *
 *  - Measured bleed periods: **89, 102, 105, 154, 187, 235 and 409** characters.
 *  - `maxPeriod: 64` (the shipped visible-output default) finds **none** of them.
 *  - The period cap must sit **above every observed period**, not in the middle
 *    of the ones seen so far: a cap below a real period fails *silently* —
 *    `trailingCycle` returns 0, the breaker never fires, and the turn runs until
 *    the user aborts it. A `256` default did exactly that to the 409-character
 *    bleed. Hence `512`.
 *  - Verbatim periodicity is what separates a bleed from legitimately repetitive
 *    reasoning: the highest-`repeatRatio` non-loop calls have *no* period at
 *    all, so a ratio rule would flag them while the exact rule does not.
 *
 * Free of Cordis types so the decision rule is unit-testable without a harness.
 */
export class ReasoningLoopBreaker {
  private broken = false
  private chars = 0
  private reasoning = ''
  private lastCycleCheck = 0
  private trippedRule: 'reasoning-cycle' | 'reasoning-lines' | undefined
  /** The phrase-pool accumulator for the `reasoning-lines` rule. */
  private readonly pool = new PhrasePool()
  /** Repetition size recorded by whichever rule tripped. */
  private repeated = 0

  /**
   * @param config - the resolved plugin configuration.
   */
  constructor(private readonly config: ResolvedConfig) {}

  /** Whether the breaker has already fired for this call. */
  get tripped(): boolean {
    return this.broken
  }

  /** Which rule fired, for the log line and for tests. */
  get trippedBy(): 'reasoning-cycle' | 'reasoning-lines' | undefined {
    return this.trippedRule
  }

  /**
   * How much of this call was repetition, in characters.
   *
   * NOT the same as {@link emittedChars}: that is the call's total length, and
   * most of a real call is new material even when it bleeds. Reporting the total
   * as "repeated" overstated the repetition by **1.6x to 10.1x** across 17
   * measured firings (median 1.9x), which matters because the notice's whole
   * purpose is to tell the model how long it has been going in circles.
   *
   * Each rule reports its own measure:
   *
   *  - `reasoning-lines` -> {@link lineRepeat}, the mass sitting in repeated lines;
   *  - `reasoning-cycle` -> the periodic span {@link trailingCycle} returned.
   */
  get repeatedChars(): number {
    return this.repeated
  }

  /** Reasoning characters observed so far in this call (the call's total length). */
  get emittedChars(): number {
    return this.chars
  }

  /**
   * Observe one `reasoning-delta` payload.
   *
   * @param text - the delta's text.
   * @returns `true` exactly once, on the delta that trips a rule.
   */
  push(text: string): boolean {
    if (this.broken) return false
    this.chars += text.length
    this.reasoning += text
    if (this.pushLines(text)) {
      this.broken = true
      this.trippedRule = 'reasoning-lines'
      // The line rule's own measure of how much repeated: the mass sitting in
      // lines seen more than once. Reporting `chars` here instead would claim the
      // call's entire length was repetition.
      this.repeated = this.pool.repeatedChars
      return true
    }
    if (this.config.maxRepeatedReasoningCycleChars <= 0) return false
    // Same fixed-stride scan as the visible-output rule: the check is bounded by
    // `minRepeatedReasoningCycleChars`, so a bleed that runs for hundreds of
    // thousands of characters is still scanned a bounded number of times.
    if (this.reasoning.length - this.lastCycleCheck < CYCLE_CHECK_STRIDE) return false
    this.lastCycleCheck = this.reasoning.length
    const span = trailingCycle(
      this.reasoning,
      this.config.maxRepeatedReasoningCycleChars,
      this.config.minRepeatedReasoningCycleChars,
    )
    if (span === 0) return false
    this.broken = true
    this.trippedRule = 'reasoning-cycle'
    // `span` is the decision rule's capped lower bound; report the real extent.
    this.repeated = periodicTailSpan(
      this.reasoning,
      this.config.maxRepeatedReasoningCycleChars,
      this.config.minRepeatedReasoningCycleChars,
    ) || span
    return true
  }

  /**
   * The line-repeat rule: a bleed that recombines a small pool of phrases.
   *
   * Verbatim periodicity ({@link trailingCycle}) only catches a bleed whose unit
   * repeats in the same order every time. A real reproduction broke that
   * assumption: 330 188 reasoning characters drawn from roughly eleven sentences
   * — `Let me read the section.` / `Executing.` / `Go.` / `Now.` / `Writing.` /
   * `OK.` / `Let me write.` — **reshuffled** each pass, so no period exists at
   * any cap (measured: 0 at every cap from 64 to 4096, and the minimum period of
   * the trailing 8192 characters was 6767, i.e. none). The cycle rule was blind
   * to it and the turn ran to 330 188 characters until the user aborted.
   *
   * What such a bleed *does* have is a tiny line vocabulary. Counting how much
   * of the text sits in lines already seen separates it cleanly, and the two
   * rules are complementary rather than redundant: short-phrase bleeds (`Go.`,
   * `OK.` — under {@link LINE_MIN_CHARS}) are the cycle rule's job, long-phrase
   * pools are this one's.
   *
   * Calibrated on 146 real reasoning calls (17 aborted bleeds, 119 calls that
   * produced text or a tool call): the shipped thresholds catch the bleed at
   * **4096 characters — 1.2 % of its 330 188** — with **zero false positives on
   * all 119 producing calls**, and zero across every parameter set in the sweep
   * that this one was chosen from.
   *
   * ## What that control set could not see
   *
   * The 119-call control contains only calls that **produced output**, so it
   * structurally excludes reasoning-only calls — which is exactly where a
   * planning call that quotes code lives. Re-measured over every session on this
   * machine (85 firings), the coverage threshold alone fires on 12 calls that are
   * quoting a code block before and after an edit rather than bleeding, with a
   * vocabulary of 1.4-2.5 sightings per line. One of them was cut for real, at
   * character 3712 of 3713 — see
   * {@link Config.minRepeatedReasoningLineConcentration} for the guard that
   * separates the two shapes and the margin it leaves.
   *
   * Incremental, so the rule stays linear in emitted characters: only complete
   * lines are counted, and each line is folded in exactly once.
   *
   * @param text - the delta's text.
   * @returns `true` when the repeated mass crosses every threshold.
   */
  private pushLines(text: string): boolean {
    if (this.config.maxRepeatedReasoningLineChars <= 0) return false
    this.pool.push(text)
    return this.pool.tripped(
      this.config.maxRepeatedReasoningLineChars,
      this.config.minRepeatedReasoningLineCoverage,
      this.config.minRepeatedReasoningLineConcentration,
    )
  }
}

/**
 * The intra-call breaker: watches one call's visible output and reports when the
 * model has repeated itself enough to be considered degenerate.
 *
 * Kept separate from {@link LoopDetector} because the two answer different
 * questions on different clocks — this one must decide *while the stream is
 * still open* (a call that bleeds for ten minutes never reaches the other), and
 * it is deliberately blind to reasoning text, which legitimately revisits itself
 * far more often than visible output does. A bleed that happens *inside*
 * reasoning is {@link ReasoningLoopBreaker}'s job, under a stricter rule.
 * Free of Cordis types so the decision rule is unit-testable without a harness.
 */
export class TextRepetitionDetector {
  private texts: string[] = []
  private broken = false
  private visible = ''
  private lastCycleCheck = 0
  private reason: 'identical-chunks' | 'repeating-cycle' | 'text-lines' | undefined
  /** Repetition size recorded by whichever rule tripped. */
  private repeated = 0
  /** The phrase-pool accumulator for the `text-lines` rule. */
  private readonly pool = new PhrasePool()

  /**
   * @param config - the resolved plugin configuration.
   */
  constructor(private readonly config: ResolvedConfig) {}

  /** Whether the breaker has already fired for this call. */
  get tripped(): boolean {
    return this.broken
  }

  /** Which rule fired, for the log line and for tests. */
  get trippedBy(): 'identical-chunks' | 'repeating-cycle' | 'text-lines' | undefined {
    return this.reason
  }

  /**
   * How much of this call's visible output was repetition, in characters.
   *
   * Distinct from {@link emittedChars}, which is the call's total output. The
   * two are far apart on a real bleed: a call can emit thousands of characters of
   * new material before its tail starts cycling, and the notice must report the
   * repetition, not the total.
   *
   * Each rule reports its own measure:
   *
   *  - `identical-chunks` -> the trailing run of identical deltas;
   *  - `repeating-cycle` -> the periodic span {@link trailingCycle} returned.
   */
  get repeatedChars(): number {
    return this.repeated
  }

  /** How many characters the call had emitted when the breaker tripped. */
  private chars = 0

  /** Visible-output characters observed so far in this call. */
  get emittedChars(): number {
    return this.chars
  }

  /**
   * Observe one `text-delta` payload.
   *
   * @param text - the delta's text.
   * @returns `true` exactly once, on the delta that completes the run.
   */
  push(text: string): boolean {
    if (this.broken) return false
    this.chars += text.length
    if (this.config.maxRepeatedText <= 0 && this.config.maxRepeatedCycleChars <= 0
      && this.config.maxRepeatedTextLineChars <= 0) return false
    this.texts.push(text)
    if (this.config.maxRepeatedText > 0
      && this.texts.length >= this.config.maxRepeatedText
      && countRepeatedText(this.texts) >= this.config.maxRepeatedText) {
      this.broken = true
      this.reason = 'identical-chunks'
      // The run of identical deltas IS the repetition; multiply by the payload
      // length so the figure is comparable with the cycle rule's span.
      this.repeated = countRepeatedText(this.texts) * text.length
      return true
    }
    // The phrase-pool rule. Fed before the cycle scan and independent of it: a
    // reshuffled pool has no period at all, so the two rules cannot substitute
    // for each other. See {@link PhrasePool} for the measurement.
    if (this.config.maxRepeatedTextLineChars > 0) {
      this.pool.push(text)
      if (this.pool.tripped(
        this.config.maxRepeatedTextLineChars,
        this.config.minRepeatedTextLineCoverage,
        this.config.minRepeatedTextLineConcentration,
      )) {
        this.broken = true
        this.reason = 'text-lines'
        this.repeated = this.pool.repeatedChars
        return true
      }
    }
    if (this.config.maxRepeatedCycleChars <= 0) return false
    this.visible += text
    // The scan grows with the qualifying span, so run it on a fixed stride
    // rather than per delta: a bleed is hundreds of characters long and 32
    // characters of latency cost nothing next to the cost of not firing.
    if (this.visible.length - this.lastCycleCheck < CYCLE_CHECK_STRIDE) return false
    this.lastCycleCheck = this.visible.length
    const span = trailingCycle(this.visible, this.config.maxRepeatedCycleChars, this.config.minRepeatedCycleChars)
    if (span === 0) return false
    this.broken = true
    this.reason = 'repeating-cycle'
    // `span` is the decision rule's capped lower bound; report the real extent.
    this.repeated = periodicTailSpan(
      this.visible,
      this.config.maxRepeatedCycleChars,
      this.config.minRepeatedCycleChars,
    ) || span
    return true
  }
}

/* -------------------------------------------------------------------------- */
/* Plugin                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The language the guard speaks to the model in. Default `zh`.
 *
 * Chinese is the default and the fallback in every direction: this guard's
 * primary audience reads Chinese, and a wrong guess costs more than a default
 * does. Only an explicit `en` preference selects English; an absent settings
 * service, an unregistered namespace, a malformed section, an unknown id or a
 * throwing reader all resolve to `zh`.
 *
 * The service is read with `ctx.get('settings')` rather than `ctx.settings`:
 * Cordis's context proxy throws `cannot get property "settings" without inject`
 * for any service the fiber did not declare, and the guard only declares
 * `agents`. Reading through `get` is the non-throwing accessor, so the settings
 * service stays genuinely optional — a profile without it works, and one with it
 * gets the user's real choice.
 */
function readLanguage(ctx: Context): 'zh' | 'en' {
  try {
    const settings = (ctx as { get?: (name: string) => unknown }).get?.('settings') as
      | { get?: (ns: string) => unknown }
      | undefined
    if (settings === undefined || typeof settings.get !== 'function') return 'zh'
    const section = settings.get('locale')
    if (section === null || typeof section !== 'object') return 'zh'
    const preference = (section as { preference?: unknown }).preference
    if (typeof preference !== 'string') return 'zh'
    return preference.toLowerCase().startsWith('en') ? 'en' : 'zh'
  } catch {
    return 'zh'
  }
}

/** Localized strings for the messages the guard sends the model. */
interface Strings {
  /** `warn` escalation notice. */
  warn(detail: string): string
  /** `steer` escalation notice. */
  steer(detail: string): string
  /** `cancel` escalation notice. */
  cancel(detail: string): string
  /** What the stall looked like, for the `warn`/`steer`/`cancel` templates. */
  detail(reason: StallReason): string
  /**
   * The correction queued after a mid-stream break.
   *
   * @param what - what repeated (visible output / reasoning).
   * @param chars - how much of the call was repetition, NOT the call's length.
   */
  correction(what: string, chars: number): string
  /* ── 换气层（huanqi）的文案 ─────────────────────────────────────────── */

  /**
   * 截断之后塞进新一轮的那句话（延续）。
   *
   * ★ 措辞有一条硬约束（从 `correction` 那次的教训来）：**只能要求"继续完成原本的任务"，
   * 绝不能写成"把结论说一遍"** —— 后者被模型读成"现在就收尾"，于是它丢下做了一半的活。
   * 截断的目的是打断循环，不是结束任务。
   *
   * @param credit - 这次延续之后还剩多少额度。
   * @param max - 额度上限。
   * @param threshold - 攒回一点额度需要的正常轮数。
   */
  continueNotice(credit: number, max: number, threshold: number): string
  /**
   * 额度用尽、不再开新一轮时塞的兜底文本（熔断）。
   *
   * ★ 它同时承担两件事：告诉用户"该你介入了"，以及**让 assistant 消息不为空**
   * （空消息会让整条会话从那一刻起永久不可用）。
   *
   * @param max - 延续上限（用户看到的"连续 N 次都没成功"里的 N）。
   */
  circuitBreakNotice(max: number): string
  /**
   * 额度降到警戒线时的提示（GUI，不走微信）。
   *
   * @param credit - 剩余额度。
   * @param max - 上限。
   * @param threshold - 攒回一点额度需要的正常轮数。
   */
  creditWarning(credit: number, max: number, threshold: number): string
  /**
   * 流内早杀时塞进新一轮的那句话。
   *
   * ★ 它和 `continueNotice` 是**两种病**，所以不能共用一条文案：那条是「预算烧光了」，
   * 这条是「光在想、没动手」。措辞纪律相同 —— **只要求继续任务，不要求收尾**。
   *
   * @param chars - 截断时思考已经写到的字符数。
   * @param credit - 这次延续之后还剩多少额度。
   * @param max - 额度上限。
   */
  silentCutNotice(chars: number, credit: number, max: number): string

  /** One-line account for the collapsed transcript row of a stall notice. */
  stallSummary(reason: StallReason): string
  /**
   * One-line account for the collapsed transcript row of a break notice.
   *
   * @param what - what repeated (visible output / reasoning).
   * @param chars - the repetition size, not the cut position.
   */
  breakSummary(what: string, chars: number): string
}

const EN: Strings = {
  warn: (d) => `The agent has produced ${d}. If this continues it will be interrupted.`,
  steer: (d) => `You are repeating the same reasoning without acting (${d}). Stop deliberating and carry on `
    + 'with the task: take the next concrete step instead of restating it.',
  cancel: (d) => `Aborting: ${d}.`,
  detail: (reason) => reason === 'reasoning-only'
    ? 'several long reasoning-only calls with no output'
    : 'several calls that restate the same reasoning without adding anything',
  correction: (what, chars) => `Your ${what} had repeated itself for ${chars} characters without progressing, `
    + 'so the response was cut off mid-stream. Do not repeat it: carry on with the task you were working on.',
  stallSummary: (reason) => reason === 'reasoning-only'
    ? 'stalled: reasoning-only calls'
    : 'stalled: restated reasoning',
  breakSummary: (what, chars) => `cut a repeating ${what} at ${chars} chars`,

  /* ── huanqi (换气) layer ─────────────────────────────────────────────
   * Wording discipline, same as the ZH table: the continuation notice must ask the
   * model to CARRY ON, never to "state the conclusion" — the latter reads as
   * "finish now" and makes it abandon work in progress (the correction-note lesson).
   * ──────────────────────────────────────────────────────────────────── */

  continueNotice: (credit, max, threshold) =>
    `[huanqi] This turn spent its whole output budget on reasoning and produced no text, `
    + `so it was cut and a new turn started. Continuation credit left: ${credit}/${max} `
    + `(it grows back one point every ${threshold} normal turns). `
    + 'Carry on with the task you were working on; do not restate this reasoning.',
  circuitBreakNotice: (max) =>
    `[huanqi] Continuation credit exhausted: ${max} continuations in a row produced no text, `
    + 'so no further turn will be started. Do exactly these three things and nothing else: '
    + '(1) save your progress to durable storage — a ledger entry or a file — stating where you got to, '
    + 'what comes next, and where you are stuck; '
    + '(2) add an index entry pointing back at it (`log:session-<id>#seq=<n>`; if you cannot get an exact '
    + 'seq, write search keywords — never guess, a wrong pointer is worse than none); '
    + '(3) stop and tell the user the context needs a manual compaction. '
    + 'Do not start new work and do not keep exploring.',
  creditWarning: (credit, max, threshold) =>
    `[huanqi] Continuation credit is down to ${credit}/${max}: the context may have gone dirty. `
    + `Consider compacting it manually; normal turns restore credit every ${threshold} turns.`,
  silentCutNotice: (chars, credit, max) =>
    `[huanqi] This turn reasoned for ${chars} characters without producing any text or tool call, `
    + `so it was cut mid-stream. Continuation credit left: ${credit}/${max}. `
    + 'Stop deliberating and take the next concrete step: make the tool call, or write the answer.',
}

const ZH: Strings = {
  warn: (d) => `模型已出现${d}。若继续，将被中断。`,
  steer: (d) => `你正在重复相同的推理而没有行动（${d}）。停止空转，继续推进任务：直接执行下一步，不要再复述。`,
  cancel: (d) => `正在中止：${d}。`,
  detail: (reason) => reason === 'reasoning-only'
    ? '连续多次只输出思考、没有任何产出'
    : '连续多次复述同样的推理、没有新增内容',
  // The correction must send the model BACK to its task, not wrap it up. An
  // earlier wording ("state the conclusion once, briefly") read as "finish now"
  // and made the model abandon work in progress — the break ended the loop but
  // also derailed the turn. The instruction is therefore only "stop repeating,
  // carry on".
  correction: (what, chars) => `你的${what}已连续重复 ${chars} 个字符而没有进展，因此响应被中途截断。`
    + '不要重复这段内容，继续完成你原本的任务。',
  stallSummary: (reason) => reason === 'reasoning-only'
    ? '空转：仅思考无产出'
    : '空转：复述推理',
  breakSummary: (what, chars) => `已截断重复的${what}（${chars} 字符）`,

  /* ── 换气层（huanqi）────────────────────────────────────────────────
   * ★ 措辞纪律：延续那条**只能要求"继续原本的任务"**，绝不能写成"把结论说一遍"。
   * 原作者的 correction 踩过这个坑 —— 后者被读成"现在就收尾"，模型于是丢下做了一半的活。
   * 截断的目的是打断循环，不是结束任务。
   * ──────────────────────────────────────────────────────────────────── */

  continueNotice: (credit, max, threshold) =>
    `〔换气〕本轮思考用尽了输出预算、正文没能产生，已截断这一轮并开新一轮。`
    + `延续额度剩 ${credit}/${max}（每 ${threshold} 个正常轮涨回一点）。`
    + '继续完成你原本的任务，不要复述这段思考。',
  /* ★ 2026-10-23（爀曦定，砚青落）：熔断后的动作从「转达一句话」改成「自己去做」。
   *
   * 病因：原来这条只说「请对砚青说『保存当前进度』」——那是**要求它转达**，不是要求它落盘。
   * 而熔断恰恰发生在「它已经连续 N 轮只顾着推演、不肯动手」的时刻，
   * 这时候再给它一句「去跟人说一声」，等于让一个已经空转的循环再说一句空话。
   *
   * 现在写明三件事，且写明「别的都不要做」——因为熔断后的额度已经是 0，
   * 任何新任务都只会再烧一次、再断一次。落盘是唯一还能产生价值的方向。 */
  circuitBreakNotice: (max) =>
    `〔换气〕延续额度已耗尽、思考已熔断（连续 ${max} 次都没产出正文），本轮不再自动续跑。`
    + '现在只做三件事，别的一概不做：'
    + '① 把当前进度落盘 —— 写一条《墨》或落一个文件，写清「做到哪、下一步是什么、卡在哪」；'
    + '② 在账本里加一条索引，带能回取的指针（`log:session-<会话id>#seq=<n>`；'
    + '拿不到精确 seq 就写检索词，**不许猜** —— 错的门牌比没有更坏）；'
    + '③ 落完就停，告诉爀曦「需要手动压缩」。不要再开新任务、不要再探索。',
  creditWarning: (credit, max, threshold) =>
    `〔换气〕延续额度只剩 ${credit}/${max}：上下文可能已经变脏。`
    + `建议手动压缩上下文；正常对话每满 ${threshold} 轮会涨回一点。`,
  silentCutNotice: (chars, credit, max) =>
    `〔换气〕本轮思考写了 ${chars} 字，正文和工具调用都还没产生，已在流中截断。`
    + `延续额度剩 ${credit}/${max}。`
    + '停止推演，直接做下一步：发出那个调用，或者把话写出来。',
}

/** The strings for one language. */
function stringsFor(lang: 'zh' | 'en'): Strings {
  return lang === 'zh' ? ZH : EN
}

/** The noun naming what repeated, in the language the model is addressed in. */
function whatFor(lang: 'zh' | 'en', rule: BreakRule): string {
  const visible = rule === 'identical-chunks' || rule === 'repeating-cycle' || rule === 'text-lines'
  if (lang === 'zh') return visible ? '可见输出' : '思考内容'
  return visible ? 'visible output' : 'reasoning'
}

/**
 * Install the listener. Per-`Agent` state is keyed in a `WeakMap` so a disposed
 * agent is collected; detectors are scoped to one agent lifecycle.
 */
export function apply(ctx: Context, config: ResolvedConfig): void {
  /**
   * ★★ 启动探针（2026-10-19 加）：只要进了 apply() 就往 <DSH_HOME>/state/huanqi-boot.log 追加一行。
   *
   * 为什么需要它：换气哑了三次，每次查都是「文件在、bundles 里有、配置也对」，
   * 但分不清两种完全不同的情况 ——
   *   ① 插件压根没被加载（boot 文件不会出现）
   *   ② 加载了、但判据一次没触发（boot 有，但 turn/end 的日志没有）
   * 没有这个区别，就只能靠猜着改。
   *
   * ★ 不依赖任何判据、不依赖 session/event、不发消息 —— 纯粹的「我到了」记号。
   * ★ 任何失败都吞掉：探针不许变成插件的故障点。
   */
  /** 状态目录：启动探针与检测层共用同一个落点。 */
  const stateDir = ((): string => {
    const home = process.env.DSH_HOME
    // ★ 2026-10-23：同 Ledger.defaultPath —— 不退回 cwd。
    //   启动探针、huanqi-turns.jsonl、账本三者必须落在**同一个目录**，
    //   否则换气面板读 turns、运维看 boot log、面板看账本，三边各看各的。
    const root = home !== undefined && home !== ''
      ? home
      : join(homeDir(), '.dsh')
    return join(root, 'state')
  })()

  /**
   * 往 huanqi-boot.log 追加一行。
   *
   * ★ 用 read + write 而不是 appendFileSync —— 这个项目自带的 @types/node 太旧，
   *   没有 appendFileSync 的类型声明（TS2305 实测过）。
   * ★ 任何失败都吞掉：探针不许变成插件的故障点。
   */
  const bootLog = (text: string): void => {
    try {
      mkdirSync(stateDir, { recursive: true })
      const p = join(stateDir, 'huanqi-boot.log')
      let prev = ''
      try {
        prev = readFileSync(p, 'utf8')
      } catch {
        prev = ''
      }
      writeFileSync(p, prev + '[' + new Date().toISOString() + '] ' + text + '\n', 'utf8')
    } catch {
      // 探针失败不许影响主流程
    }
  }
  bootLog('apply() entered; config=' + JSON.stringify(config))

  /**
   * ★★ 换气检测层（2026-10-19 加，爀曦定）：每一轮结束写一条 JSONL 到
   * `<DSH_HOME>/state/huanqi-turns.jsonl`，给回声哨兵面板读。
   *
   * ## 为什么需要它
   *
   * 判据④（空回合）的判断原本只写进 `ctx.logger.warn` —— 而 DSH 桌面端的 logger
   * **不落盘**（state / storages / logs 三处都查过，没有 `[huanqi]` 的影子），
   * 于是「换气到底有没有在看着这一轮」这件事，在机器上没有任何痕迹。
   *
   * 这一行的作用是把「不可视」变成「可视」：面板能直接列出最近每一轮的
   * kind / 最后一条消息形状 / 有没有产出 / 判词 / 剩余额度。
   *
   * ## 为什么是 JSONL 而不是 JSON 数组
   *
   * 只追加、每行独立、坏一行不影响前面 —— 和《墨》同一个理由。
   * 同时限制保留最近 2000 行，避免无限长。
   * ★ 任何失败都吞掉：检测层不许影响主流程。
   */
  /* ★ 这一行的 `;` 不是风格，是 ASI 必需：本文件不带分号，而紧接着的 IIFE 以 `(`
   *   开头 —— 没有分号时 JS 会把 `join(...)` 的返回值当成函数再调一次（tsc 报 TS2349）。
   *   lib 里本来就带分号（tsc 输出时补的），这里写出来反而正好对齐它。 */
  const turnsFile = join(stateDir, 'huanqi-turns.jsonl');

  // ══════════════════════════════════════════════════════════════════════
  // ★ 2026-10-27（砚青加）**测试触发口** —— 验证两段压缩能不能真的跑起来。
  //
  //   背景：huanqi-turns.jsonl 里 37 条 compact 全是
  //   {ok:false, error:"compaction service not found"}，从没验证过成功是什么样。
  //   compactOnce 是闭包函数、外面调不到；huanqi 没注册工具/命令；
  //   DSH 的 HTTP API 要 token。所以只能从插件内部开一个口子。
  //
  //   用法：写 D:\AI\memory\hub\_huanqi-trigger.json
  //     { "mode": "region" | "full" | "both" }
  //   用最近一次真实事件里的会话（就是当前在跑的那条），**不模拟**。
  //   执行完删文件，结果写 _plugin-diag.log。
  // ══════════════════════════════════════════════════════════════════════
  ((): void => {
    const TRIGGER = 'D:\\AI\\memory\\hub\\_huanqi-trigger.json'
    const DIAGF = 'D:\\AI\\memory\\hub\\_plugin-diag.log'
    const diag = (line: string): void => {
      try { appendFileSync(DIAGF, new Date().toISOString() + ' ' + line + '\n') } catch { /* */ }
    }
    setInterval(() => {
      /* ★ 声明成 `string | null` 是为了产物与 lib 逐字一致（lib 里是 `let raw = null`）；
       *   后面用 `as string` 断言收窄 —— `catch { return }` 已保证初值永不被读到，
       *   而 `as` 在 tsc 擦掉类型后就消失了，运行时与 lib 完全相同。 */
      let raw: string | null = null
      try { raw = readFileSync(TRIGGER, 'utf8') } catch { return }
      // ★ 2026-10-27（第 5 代修）：空文件 = 没指令。原来这两行紧挨着 ——
      //   上面刚把文件清空、下面立刻去 parse，于是「文件存在且为空」时会
      //   每 3 秒报一次 JSON 解析失败（实测累计 6588 条，自 10-26 17:37 起）。
      //   读到空就静默跳过：不清空、不报错、不触发。
      if ((raw as string).trim() === '') return
      try { writeFileSync(TRIGGER, '', 'utf8') } catch { /* 清空，避免重复触发 */ }
      void (async () => {
        let req: any = null
        try { req = JSON.parse(raw as string) } catch (e: any) {
          diag('[huanqi][trigger] JSON 解析失败: ' + String((e as any) && (e as any).message))
          return
        }
        const mode = String(req.mode || 'region').trim()
        diag('[huanqi][trigger] 收到 mode=' + mode
          + ' lastSid=' + (lastSeenSid || '(空)')
          + ' hasAgent=' + (lastSeenAgent === null ? '否' : '是'))
        // ★ 兜底：lastSeenAgent 为空时，用请求里的 sid（或我们这条会话）直接取
        let target: any = lastSeenAgent
        let targetSid: string = lastSeenSid
        if (target === null) {
          const wantSid = String(req.sid || 'session-1099f531-7cac-4989-a14c-7fd499ac1fc0').trim()
          try {
            target = ctx.agents.get(wantSid as never) ?? null
            targetSid = wantSid
            diag('[huanqi][trigger] 兜底 ctx.agents.get(' + wantSid + ') → '
              + (target === null ? '没拿到' : '拿到了'))
          } catch (e: any) {
            diag('[huanqi][trigger] 兜底取 agent 抛: ' + String((e as any) && (e as any).message))
          }
        }
        if (target === null) {
          diag('[huanqi][trigger] 取不到 agent，放弃')
          return
        }
        /* ══════════════════════════════════════════════════════════
         * ★ 2026-10-27：只读探针。摸清自研压缩引擎缺的两样 API。
         *   绝不用 Object.keys（对 Cordis ctx 恒为空，上一轮就栽在这）。
         * ══════════════════════════════════════════════════════════ */
        const __probeDump = (tag: string, obj: any, depth?: number): string[] => {
          const lines: string[] = []
          const seen = new Set<string>()
          let cur = obj
          let level = 0
          while (cur !== null && cur !== undefined && level < (depth === undefined ? 3 : depth)) {
            let names: string[] = []
            try { names = Object.getOwnPropertyNames(cur) } catch { names = ['(读不到)'] }
            const fresh = names.filter((n) => !seen.has(n))
            fresh.forEach((n) => seen.add(n))
            if (fresh.length > 0) {
              lines.push(tag + ' [L' + level + '] ' + fresh.slice(0, 60).join(','))
            }
            try { cur = Object.getPrototypeOf(cur) } catch { cur = null }
            level += 1
            if (cur === null || cur === Object.prototype) break
          }
          return lines
        }
        if (mode === 'probe') {
          diag('[huanqi][probe] ===== 开始 =====')
          const put = (arr: string[]): void => { arr.forEach((l) => diag('[huanqi][probe] ' + l)) }
          try { put(__probeDump('AGENT', target, 3)) } catch (e: any) { diag('[huanqi][probe] AGENT 抛: ' + e.message) }
          try {
            const sess = target !== null ? target.session : undefined
            put(__probeDump('SESSION', sess, 4))
          } catch (e: any) { diag('[huanqi][probe] SESSION 抛: ' + e.message) }
          try {
            const surf = target !== null && target.session !== undefined ? target.session.surface : undefined
            put(__probeDump('SURFACE', surf, 4))
            // 额外：surface 上有没有「写」类方法
            const wr: string[] = []
            let c2 = surf
            while (c2 !== null && c2 !== undefined) {
              try {
                Object.getOwnPropertyNames(c2).forEach((n) => {
                  if (/^(set|add|splice|replace|remove|delete|insert|push|append|truncate|compact|rewrite|put)/i.test(n)) wr.push(n)
                })
              } catch { /* */ }
              try { c2 = Object.getPrototypeOf(c2) } catch { c2 = null }
            }
            diag('[huanqi][probe] SURFACE 上的写类方法: ' + (wr.length > 0 ? wr.join(',') : '(无)'))
          } catch (e: any) { diag('[huanqi][probe] SURFACE 抛: ' + e.message) }
          try {
            const sctx = target !== null && target.session !== undefined ? target.session.ctx : undefined
            put(__probeDump('SESSION.CTX', sctx, 3))
          } catch (e: any) { diag('[huanqi][probe] SESSION.CTX 抛: ' + e.message) }
          try { put(__probeDump('ROOT.CTX', ctx, 2)) } catch (e: any) { diag('[huanqi][probe] ROOT.CTX 抛: ' + e.message) }
          // 关键：这些显式探测
          const probes2 = ['compaction', 'llm', 'model', 'modelAdapter', 'agents', 'sessionProjections']
          probes2.forEach((n) => {
            let got: any
            try { got = (ctx as any).get(n) } catch { got = '(抛)' }
            diag('[huanqi][probe] ctx.get(' + n + ') -> '
              + (got === undefined ? 'undefined' : (got === null ? 'null' : (got === '(抛)' ? '抛' : typeof got))))
          })
          diag('[huanqi][probe] ===== 结束 =====')
          return
        }
        const tryOnce = async (m: string): Promise<void> => {
          try {
            /* ★★★ 2026-10-31（砚青补）：**调试通道也必须先等 agent 静下来。**
             *
             *   实测（03:20:19，那一次我已经结束了回合、确实 idle）：
             *     11:20:16 回合结束 → 11:20:19 trigger 启动 → 11:20:32 失败
             *     FAILED: compaction: session surface changed during summarization
             *
             *   ★ 3 秒的间隔不够 —— `compactRegion` 要求摘要那十几秒里
             *     整个 surface 一个节点都不许变，而回合收尾的写入可能还没落完。
             *   ★ 主路径（早杀 / 熔断）靠 `waitUntilQuiet` 静 3 秒再动；
             *     原来这个调试口直接调 `compactOnce`，所以它测出来的失败
             *     **不能代表主路径的真实情况** —— 这也是它必须改的原因。 */
            diag('[huanqi][trigger] 等 agent 静下来 …')
            const quiet = await waitUntilQuiet(target)
            diag('[huanqi][trigger] agent=' + quiet.how + ' 静 '
              + String(Math.round(quiet.quietMs / 1000)) + 's → 开始压缩')
            const outcome = await compactOnce(target, m, targetSid)
            diag('[huanqi][trigger] compactOnce(' + m + ') → '
              + (outcome.ok ? 'OK' : 'FAILED: ' + String(outcome.error))
              + ' range=' + (outcome.range === null
                ? 'null'
                : String(outcome.range.start) + '–' + String(outcome.range.end)))
          } catch (e: any) {
            diag('[huanqi][trigger] compactOnce(' + m + ') 抛: ' + String((e as any) && (e as any).message))
          }
        }
        if (mode === 'region' || mode === 'both') await tryOnce('region')
        if (mode === 'full' || mode === 'both') await tryOnce('full')
        diag('[huanqi][trigger] 完成')
      })()
    }, 3000)
  })()

  const recordTurn = (rec: Record<string, unknown>): void => {
    try {
      mkdirSync(stateDir, { recursive: true })
      let prev = ''
      try {
        prev = readFileSync(turnsFile, 'utf8')
      } catch {
        prev = ''
      }
      const MAX_LINES = 2000
      const lines = prev === '' ? [] : prev.split('\n').filter((l) => l.trim() !== '')
      lines.push(JSON.stringify(rec))
      const kept = lines.length > MAX_LINES ? lines.slice(lines.length - MAX_LINES) : lines
      writeFileSync(turnsFile, kept.join('\n') + '\n', 'utf8')
    } catch {
      // 检测层不许影响主流程
    }
  }

  const detectors = new WeakMap<object, LoopDetector>()
  /* ══════════════════════════════════════════════════════════════════════
   * ★★ 2026-10-26（砚青落）：思考退化「治疗」层 —— 压缩
   *
   * 为什么要有这一层：
   *   打断（ReasoningLoopBreaker）只结束当前这一轮，但那段「做。做。做。」
   *   已经进了历史。下一次模型读到「刚才是这样做出来的」，**更容易被激活** ——
   *   这是复利：每打断一次，上下文里就多一段「循环记录」，下一次更容易。
   *
   *   ⇒ 打断是止血，不是清创。清创＝把污染搬到磁盘上 + 留门牌。
   *
   * 三级阶梯：
   *   ① 打断（已有，流级，极轻）
   *   ② 范围压缩：累计截断 N 次 → **先走定点清除**（表面替换，不动摘要）；
   *      没有候选或全部失败才落回 compactRegion / `/compact-region`（旧路），压走最近这一段，**继续对话**
   *   ③ 全量压缩：熔断时 → compactNow，彻底清空 + 告知用户 + **不再延续**
   *
   * ★ 为什么②不在第一次截断就做：单次截断是正常呼吸（normalTurnThreshold: 20，
   *   一轮能截断几十次）。每次都压缩等于每轮都在换容器。
   *
   * ★★ 为什么压缩之后要「让它自己去取一手原文」而不是读摘要：
   *   如果压缩后去读摘要，**摘要就成了新的输入** —— 那是摘要复利，压了等于白压。
   *   所以注入的是一张地图（seq 指针），不是一段转述。
   * ══════════════════════════════════════════════════════════════════════ */
  /** 每个会话在当前 turn 内累计的截断次数。`turn/end` 时清零。 */
  const cutCounts = new Map<any, number>()
  // ★ 2026-10-27（砚青加）：记住最近一次事件里的会话与 agent，给下面的测试触发口用。
  let lastSeenSid = ''
  /* ★ any：测试触发口与压缩层都直接摸 agent 的 `session` / `runMaintenance`，
   *   而那些成员不在本包声明的 Agent 面上 —— 和本文件其余「够不到就用 any」一致。 */
  let lastSeenAgent: any = null
  const lastCompact = new Map<any, any>()
  /**
   * 取压缩服务。
   *
   * ★ 用 `ctx.get(...)` 而不是 `ctx.compaction` —— 和本文件其余地方一致
   *   （见 `readConfig` 那段注释：`ctx.get` 在没有该服务时返回 undefined，
   *    而属性访问在类型上存在、运行时可能没有，会抛）。
   */
  function compactionService(agent: any): any {
    const name = config.compactionService !== '' ? config.compactionService : 'compaction'
    try {
      /* ★ 2026-10-27（砚青修）：**从离得最近的 ctx 找**，不再只看根层。
       * 病（实测 _plugin-diag.log）：ctx.get(compaction) -> UNDEFINED ;
       *   相关键（无）→ compactOnce 恒 FAILED，历史 37 条全是这个。
       * 因：compaction 是 cordis:group + isolate:{compaction:true}，
       *   服务只在该 group 内可见，而 huanqi 在 profile 根层。
       * 修：agent 属 preset 内部，它的 ctx 与那个 group 同作用域。逐级退。 */
      let svc: any
      {
        const probes: Array<[string, any]> = [
          ['agent.ctx', agent !== undefined && agent !== null ? agent.ctx : undefined],
          ['agent.session.ctx', agent !== undefined && agent !== null && agent.session !== undefined && agent.session !== null
            ? agent.session.ctx
            : undefined],
          ['ctx(根层)', ctx],
        ]
        for (let i = 0; i < probes.length; i += 1) {
          const tag = probes[i]![0]
          const holder = probes[i]![1]
          if (holder === undefined || holder === null || typeof holder.get !== 'function')
            continue
          let got
          try { got = holder.get(name) }
          catch { continue }
          if (got !== undefined && got !== null) {
            svc = got
            try {
              appendFileSync('D:\\AI\\memory\\hub\\_plugin-diag.log',
                new Date().toISOString() + ' [huanqi][diag] ' + tag + '.get(' + name + ') -> OK\n')
            }
            catch { /* */ }
            break
          }
        }
        if (svc === undefined) {
          try {
            appendFileSync('D:\\AI\\memory\\hub\\_plugin-diag.log',
              new Date().toISOString() + ' [huanqi][diag] 三级全落空：' + name + ' 在 agent.ctx / agent.session.ctx / ctx 都拿不到\n')
          }
          catch { /* */ }
        }
      }
      // ★ 2026-10-27（砚青加诊断）：huanqi-turns.jsonl 里 37 条 compact 全是
      //   {ok:false, error:"compaction service not found"}，
      //   而 asar 里 dsh-compaction-basic 的 inject = ["commands","compaction"]
      //   且它能正常加载（/compact 可用）—— 说明服务是存在的，是这里取不到。
      // ★ 写文件，不走 console.error（主进程的 stderr 抓不到）
      // ★★ 也别用 require —— 这个包是 ESM（package.json type=module），require 会抛，
      //    被 catch 吃掉就变成「诊断装了但什么也没写」，比不装更坏。
      try {
        var __line: string | null = null
        if (!svc) {
          var keys = '?'
          try {
            keys = Object.keys(ctx).filter(function (k) {
              return /compact|compress|prune|service/i.test(k)
            }).join(',') || '(无相关键)'
          }
          catch (e2: any) { keys = '(读不到)' }
          __line = '[huanqi][diag] ctx.get(' + name + ') -> UNDEFINED ; 相关键: ' + keys
        }
        else {
          var sk: string[] = []
          try { sk = Object.keys(svc).slice(0, 10) } catch (e3: any) { sk = ['(读不到)'] }
          __line = '[huanqi][diag] ctx.get(' + name + ') -> OK typeof=' + typeof svc + ' keys=' + sk.join(',')
        }
        appendFileSync('D:\\AI\\memory\\hub\\_plugin-diag.log',
          new Date().toISOString() + ' ' + __line + '\n')
      }
      catch (eX: any) { /* 诊断本身绝不许影响主流程 */ }
      return svc
    }
    catch (e: any) {
      console.error('[huanqi][diag] ctx.get(' + name + ') 抛了: ' + (e && e.message))
      return undefined
    }
  }
  /* ★ `type` 声明要放在那两段 JSDoc **之前** —— 否则 tsc 把注释归给这个纯类型声明，
   *   擦掉声明时注释一起消失（lib 里留着这两段注释，产物就与它对不上了）。 */
  /** `pickRegionEx` 的返回值形状。`info` 只在诊断分支出现（可选）。 */
  type RegionPick = {
    range: { start: number; end: number } | null
    why: string | null
    info?: string
  }
  /* ===== 定点清除（2026-10-31 新增） =====
   *
   * 背景：`/compact-region` 要 open turn + 整面静止，在换气的时机上不可用。
   * 改用 surfaceOp 直接替换 tool/result（已实测通过，见 30-状态/设计-换气定点清除.md）。
   *
   *   collectPurgeCandidates —— 找「污染源」候选（启发式，不依赖 LLM）
   *   purgeOne              —— 替换一条（四条硬约束都已满足）
   *   purgeMany             —— 批量替换
   *
   * ★ 本段在 compactOnce 作用域外，`diag` / `targetSid` 不可见 —— 用 appendFileSync 直接写。
   */

  const PURGE_LOG = 'D:\\AI\\memory\\hub\\_plugin-diag.log';
  const purgeLog = (line: any): void => {
      try {
          appendFileSync(PURGE_LOG, new Date().toISOString() + ' ' + line + '\n');
      }
      catch { /* 诊断不许影响主流程 */ }
  };

  /** 候选：找「超大工具结果」和「重复前缀的工具结果」。 */
  function collectPurgeCandidates(agent: any, opts: any): any {
      const sess = agent !== null && agent !== undefined && agent.session !== undefined ? agent.session : undefined;
      if (sess === undefined) return { ok: false, error: 'no session', items: [] };
      const nodes = sess.surface === undefined ? undefined : sess.surface.nodes;
      if (nodes === undefined || nodes === null) return { ok: false, error: 'no surface', items: [] };

      const maxChars = Number(opts && opts.maxChars ? opts.maxChars : 20000);
      const maxItems = Number(opts && opts.maxItems ? opts.maxItems : 3);

      const arr = [];
      try {
          for (const v of nodes) arr.push(v);
      }
      catch (e) {
          return { ok: false, error: 'iter: ' + String((e as any) && (e as any).message), items: [] };
      }

      /* 只看尾巴：动太老的历史风险大、收益小。 */
      const tail = arr.slice(-400);
      const items = [];
      const seen = new Map();

      for (const seq of tail) {
          let ev;
          try { ev = sess.eventAt(seq); }
          catch (e) { continue; }
          if (ev === undefined || ev === null) continue;
          if (String(ev.type) !== 'tool/result') continue;

          const d = ev.data || {};
          const msg = d.message || {};
          const content = Array.isArray(msg.content) ? msg.content : [];
          let text = '';
          for (const c of content) {
              if (c !== null && typeof c === 'object' && typeof c.text === 'string') text += c.text;
          }
          if (text.length === 0) continue;

          const key = text.slice(0, 200);
          if (!seen.has(key)) seen.set(key, []);
          seen.get(key).push({ seq: seq, len: text.length });

          const preview = text.slice(0, 300).replace(/\s+/g, ' ');
          items.push({ seq: seq, len: text.length, preview: preview, reason: 'candidate' });
      }

      /* 重复前缀：保留最后一条，前面的都算候选。 */
      for (const entry of seen) {
          const list = entry[1];
          if (list.length < 2) continue;
          for (let i = 0; i < list.length - 1; i += 1) {
              items.push({ seq: list[i].seq, len: list[i].len, reason: 'duplicate x' + String(list.length) });
          }
      }

      const uniq = new Map();
      for (const it of items) if (!uniq.has(it.seq)) uniq.set(it.seq, it);
      /* 送诊断的候选：先取最长的 maxCandidates 条（沙袋优先），再由 LLM 挑。 */
      const maxCandidates = Number(opts && opts.maxCandidates ? opts.maxCandidates : 12);
      const byLen = Array.from(uniq.values()).sort((a, b) => b.len - a.len).slice(0, maxCandidates);
      const out = byLen.sort((a, b) => a.seq - b.seq);

      return { ok: true, items: out, scanned: tail.length, total: arr.length };
  }

  /** 替换一条 tool/result。四条硬约束：类型、去重、只改 content、不加额外字段。 */
  function purgeOne(sess: any, seq: any, note: any): any {
      const ev = sess.eventAt(seq);
      if (ev === undefined || ev === null) return { ok: false, seq: seq, error: 'no event' };
      if (String(ev.type) !== 'tool/result') return { ok: false, seq: seq, error: 'type=' + String(ev.type) };
      const od = ev.data || {};
      const omsg = od.message || {};
      const nm = Object.assign({}, omsg, { content: [{ type: 'text', text: note }] });
      const r = sess.append('tool/result', Object.assign({}, od, { message: nm }), {
          surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
          sourceEventSeqs: [seq],
      });
      return { ok: true, seq: seq, newSeq: r === undefined || r === null ? null : r.seq };
  }

  /** 批量：逐条替换，任何一条失败都不影响其它条。 */
  function purgeMany(agent: any, items: any, sid: any): any {
      const sess = agent !== null && agent !== undefined && agent.session !== undefined ? agent.session : undefined;
      if (sess === undefined) return { ok: false, error: 'no session', purged: [] };
      const purged = [];
      for (const it of items) {
          const note = '[huanqi] 定点清除 seq ' + String(it.seq) + '（原因：' + String(it.reason) + '）\n'
              + '原文可取回：log:' + String(sid) + '#seq=' + String(it.seq) + '\n'
              + '（这是清除留下的占位，不是压缩摘要。）';
          try {
              const one = purgeOne(sess, it.seq, note);
              if (one.ok) {
                  purged.push(one);
                  purgeLog('[huanqi][purge] OK ' + String(it.seq) + ' 新seq=' + String(one.newSeq) + ' 原因=' + String(it.reason));
              }
              else {
                  purgeLog('[huanqi][purge] 跳过 seq ' + String(it.seq) + ': ' + String(one.error));
              }
          }
          catch (e) {
              purgeLog('[huanqi][purge] seq ' + String(it.seq) + ' 抛: ' + String((e as any) && (e as any).message));
          }
      }
      return { ok: purged.length > 0, purged: purged };
  }


  /* ===== LLM 诊断（2026-10-31 加） =====
   *
   * 爀曦定的口径：「让 LLM 检查上下文有哪些地方导致了污染，造成思考退化」。
   * 启发式（collectPurgeCandidates）只负责**筛出可疑段**，
   * 真正判断「哪几段是诱因、删了安不安全」交给模型。
   *
   * 调用方式照官方 compaction 的 summarizeWithLlm：
   *   ctx.get('llm').stream({ provider, model, messages, maxTokens, sessionId, purpose })
   *   for await (chunk) assembler.push(chunk)
   */

  const PURGE_DIAG_INSTRUCTION = [
      '你是一个上下文污染诊断器。下面列出当前会话里若干条工具结果（tool/result）的 seq、长度和开头片段。',
      '',
      '背景：这个 agent 出现了「思考退化」——重复推理、重复输出、空回合。',
      '你的任务：判断哪些工具结果**最可能是导致退化的诱因**。',
      '',
      '典型诱因：',
      '- 同一内容被反复读取/输出的残留（重复前缀）',
      '- 超长的、已经用完的工具输出（整份文件 dump、大段日志）',
      '- 失败的循环留下的错误刷屏',
      '',
      '对每条候选给出：',
      '- seq：原样返回',
      '- reason：一句话（中文）说明为什么它是诱因，或为什么不是',
      '- safe：true 表示「删掉它对因果链无损」；false 表示「它可能是唯一记录，别动」',
      '',
      '★ safe 要保守：拿不准就 false。删错比不删更坏。',
      '★ 最多挑 3 条 safe=true。没有真正的诱因就返回空数组。',
      '',
      '只输出 JSON，不要解释、不要 markdown 围栏：',
      '{"items":[{"seq":123,"reason":"...","safe":true}]}'
  ].join('\n');

  /** 从模型输出里抠出 JSON 对象。四层退让：直解析 → 剥围栏 → 括号配平 → 截断抢救。 */
  function extractJsonObject(text: any): any {
      const s = String(text === null || text === undefined ? '' : text);
      if (s.length === 0) return null;
      try {
          const o = JSON.parse(s.trim());
          if (o !== null && typeof o === 'object' && Array.isArray(o.items)) return o;
      } catch { /* 退下一层 */ }
      const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (fence !== null && fence[1] !== undefined) {
          try {
              const o = JSON.parse(fence[1].trim());
              if (o !== null && typeof o === 'object' && Array.isArray(o.items)) return o;
          } catch { /* 退下一层 */ }
      }
      for (let start = 0; start < s.length; start += 1) {
          if (s[start] !== '{') continue;
          let depth = 0;
          let inStr = false;
          let esc = false;
          for (let i = start; i < s.length; i += 1) {
              const ch = s[i];
              if (inStr) {
                  if (esc) esc = false;
                  else if (ch === '\\') esc = true;
                  else if (ch === '"') inStr = false;
                  continue;
              }
              if (ch === '"') { inStr = true; continue; }
              if (ch === '{') depth += 1;
              else if (ch === '}') {
                  depth -= 1;
                  if (depth === 0) {
                      try {
                          const o = JSON.parse(s.slice(start, i + 1));
                          if (o !== null && typeof o === 'object' && Array.isArray(o.items)) return o;
                      } catch { /* 换下一个起点 */ }
                      break;
                  }
              }
          }
      }
      const re = /\{\s*"seq"\s*:\s*(-?\d+)[\s\S]*?\}/g;
      const kept = [];
      let m;
      while ((m = re.exec(s)) !== null) {
          try {
              const o = JSON.parse(m[0]);
              if (o !== null && typeof o === 'object') kept.push(o);
          } catch { /* 跳过坏片 */ }
      }
      if (kept.length > 0) return { items: kept, __salvaged: true };
      return null;
  }

  /** LLM 诊断：返回 { ok, items:[{seq, reason, safe}], raw }。失败时 items 为空。 */
  async function diagnosePurge(agent: any, sid: any, opts: any): Promise<any> {
      const llm = ctx.get('llm');
      if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
          return { ok: false, error: 'llm service unavailable', items: [] };
      }

      const cands = collectPurgeCandidates(agent, opts);
      if (cands.ok !== true) return { ok: false, error: String(cands.error), items: [] };
      if (cands.items.length === 0) return { ok: true, items: [], scanned: cands.scanned, total: cands.total, raw: '(no candidates)' };

      /* 目标 provider/model：优先会话最近一次路由的 config，其次 agent.options。 */
      let target;
      try {
          const head = agent.session.requestHeader === undefined ? undefined : agent.session.requestHeader();
          if (head !== undefined && head !== null && head.config !== undefined && head.config !== null) {
              if (typeof head.config.provider === 'string' && typeof head.config.model === 'string') {
                  target = { provider: head.config.provider, model: head.config.model };
              }
          }
      }
      catch { /* 拿不到就退下一步 */ }
      if (target === undefined) {
          const o = agent.options === undefined ? {} : agent.options;
          if (typeof o.provider === 'string' && o.provider.length > 0 && typeof o.model === 'string' && o.model.length > 0) {
              target = { provider: o.provider, model: o.model };
          }
      }
      if (target === undefined) return { ok: false, error: 'no provider/model for diagnosis', items: [] };

      const lines = cands.items.map((it: any) => 'seq=' + String(it.seq) + ' len=' + String(it.len) + ' preview=' + String(it.preview));
      const body = PURGE_DIAG_INSTRUCTION + '\n\n候选（共 ' + String(cands.items.length) + ' 条）：\n' + lines.join('\n');

      const assembler = new BlockAssembler();
      try {
          const message = createUserMessage({
              content: [{ type: 'text', text: body }],
              source: { kind: 'plugin', plugin: 'dsh-huanqi' } as any
          });
          const options = {
              provider: target.provider,
              model: target.model,
              messages: [message],
              maxTokens: 24000,
              sessionId: agent.session.id,
              purpose: 'purge-diagnose' as any
          };
          for await (const chunk of llm.stream(options)) assembler.push(chunk);
      }
      catch (e) {
          return { ok: false, error: 'llm stream threw: ' + String((e as any) && (e as any).message), items: [] };
      }

      let text = '';
      let blockSig = '(none)';
      try {
          const blocks = assembler.blocks();
          const parts = [];
          for (const b of blocks) {
              if (b === null || typeof b !== 'object') { parts.push('?'); continue; }
              parts.push(String(b.type) + ':' + (typeof (b as any).text === 'string' ? String((b as any).text.length) : '-'));
              if (b.type === 'text') text += String(b.text);
          }
          blockSig = 'n=' + String(blocks.length) + '[' + parts.join(',') + ']';
      }
      catch (e) {
          return { ok: false, error: 'assembler.blocks threw: ' + String((e as any) && (e as any).message), items: [] };
      }

      const parsed = extractJsonObject(text);
      if (parsed !== null && parsed.__salvaged === true) {
          return { ok: false, error: 'output truncated (salvaged ' + String(parsed.items.length) + ')', items: [], diag: blockSig + ' SALVAGED textLen=' + String(text.length), raw: text.slice(0, 800) };
      }
      if (parsed === null || !Array.isArray(parsed.items)) {
          return { ok: false, error: 'model output not parseable', items: [], diag: blockSig + ' textLen=' + String(text.length), raw: text.slice(0, 800) };
      }

      const known = new Map();
      for (const it of cands.items) known.set(Number(it.seq), it);
      const picked = [];
      for (const raw of parsed.items) {
          const seq = Number(raw === null || raw === undefined ? NaN : raw.seq);
          if (!Number.isFinite(seq)) continue;
          if (!known.has(seq)) continue;                 /* 模型编的 seq 一律不认 */
          if (raw.safe !== true) continue;               /* 只采纳明确 safe 的 */
          picked.push({ seq: seq, len: known.get(seq).len, reason: String(raw.reason === undefined ? 'llm' : raw.reason), safe: true });
      }
      return { ok: true, items: picked.slice(0, 3), scanned: cands.scanned, total: cands.total, diag: blockSig, raw: text.slice(0, 500) };
  }

  /**
   * 算一个「可以安全压」的 seq 范围 —— 从末尾往前找，直到工具调用配对平衡。
   *
   * 依据（`dsh-compaction-basic` 的 `selectCompactableRange`）：
   *   - `retainTokens = 0` ⇒ 起点是最后一个 surface 节点
   *   - 从那里往回退，直到 `toolPairingBalancedBefore` 成立
   *   - start = 第一个（有 system 头就跳过它），end = 退到的前一个
   *
   * ★ 也就是说：**默认压「最后一条之前的所有东西」** —— 这正是「范围压缩」要的形态：
   *   保留最后一条（通常是刚产出/正在产出的那条），把前面这段换成摘要。
   */
  /* ★★★ 2026-10-27 22:31（第 5 代）：把 7 个**静默 `return null`** 变成带原因。
   *
   *   病（14:26 那枪实测）：日志只有一行 `kind=full range=null`，
   *   看不出是哪一步放弃的 —— 是拿不到 surface？节点太少？还是边界不平衡？
   *   猜一次改一次，每次都得重启，成本高而信息量极低。
   *
   *   现在 `pickRegionEx` 返回 `{ range, why, info }`，`why` 是诊断码：
   *     no-agent-session / surface-threw:<msg> / no-surface /
   *     nodes-not-array:<typeof> / nodes-too-few:<n> / node-undefined@<i> /
   *     unbalanced-to-zero / keep<=first:<keep>/<first> / edge-undefined /
   *     start>=end:<s>~<e> / threw:<msg>
   *   `pickRegion` 保留成薄包装 —— 另一处调用（`compactOnce` 后半段）不用动。
   *
   *   ★ 为什么要分 `surface-threw` 和 `no-surface`：`agent` 来自根层的
   *     `ctx.agents.get(sid)`，而 `session.surface` 的 getter 在 isolate realm 外
   *     可能抛 —— 这两种失败修法完全不同，不能混成同一个 null。
   */
  function pickRegionEx(agent: any): RegionPick {
    try {
      if (agent === undefined || agent === null || agent.session === undefined || agent.session === null)
        return { range: null, why: 'no-agent-session' }
      let surface: any
      try {
        surface = agent.session.surface
      }
      catch (e: any) {
        return { range: null, why: 'surface-threw:' + String((e as any) && (e as any).message) }
      }
      if (surface === undefined || surface === null)
        return { range: null, why: 'no-surface' }
      const nodes = surface.nodes
      if (!Array.isArray(nodes))
        return { range: null, why: 'nodes-not-array:' + (nodes === null ? 'null' : typeof nodes) }
      if (nodes.length < 3)
        return { range: null, why: 'nodes-too-few:' + nodes.length }
      // 保留最后一个（`retainTokens = 0` 的等价形态）
      let keepFromIdx = nodes.length - 1
      /* ★ 边界必须平衡：不满足就往前退，退到 0 就放弃。
       *   这里用 try/catch 包住 —— `toolPairingBalancedBefore` 是官方导出，
       *   但守卫不该因为它签名变了就整个挂掉。 */
      let unbalanced = 0
      let guard = 0
      while (keepFromIdx > 0 && guard < 512) {
        guard += 1
        const seq = nodes[keepFromIdx]
        if (seq === undefined)
          return { range: null, why: 'node-undefined@' + keepFromIdx }
        let balanced = true
        try {
          balanced = toolPairingBalancedBefore(agent.session, seq)
        }
        catch {
          balanced = true // 判不了就当它平衡 —— 不能被一个辅助判据卡死
        }
        if (balanced)
          break
        unbalanced += 1
        keepFromIdx -= 1
      }
      if (keepFromIdx <= 0)
        return { range: null, why: 'unbalanced-to-zero', info: 'retreated=' + unbalanced + ' nodes=' + nodes.length }
      // system 头占首位的话要跳过（它不该被压进摘要）
      let firstIdx = 0
      try {
        const head = nodes[0]
        if (head !== undefined) {
          const ev = agent.session.eventAt(head)
          if (ev !== null && ev !== undefined && ev.type === 'system/message')
            firstIdx = 1
        }
      }
      catch {
        firstIdx = 0
      }
      if (keepFromIdx <= firstIdx)
        return { range: null, why: 'keep<=first', info: 'keep=' + keepFromIdx + ' first=' + firstIdx + ' nodes=' + nodes.length }
      const start = nodes[firstIdx]
      const end = nodes[keepFromIdx - 1]
      if (start === undefined || end === undefined)
        return { range: null, why: 'edge-undefined', info: 'start=' + String(start) + ' end=' + String(end) }
      if (!(start < end))
        return { range: null, why: 'start>=end', info: String(start) + '~' + String(end) + ' nodes=' + nodes.length + ' first=' + firstIdx + ' keep=' + keepFromIdx }
      return {
        range: { start, end },
        why: null,
        info: 'nodes=' + nodes.length + ' first=' + firstIdx + ' keep=' + keepFromIdx + ' end=' + String(end),
      }
    }
    catch (e: any) {
      return { range: null, why: 'threw:' + String((e as any) && (e as any).message) }
    }
  }
  function pickRegion(agent: any): { start: number; end: number } | null {
    return pickRegionEx(agent).range
  }
  /**
   * 压缩一次。**永不抛** —— 失败只记录，绝不让守卫自己变成故障。
   *
   * @param mode `region` = 尽量只压最近这一段（失败降级全量）；
   *             `full`   = 直接全量。
   */
  async function compactOnce(agent: any, mode: string, sid: string): Promise<any> {
    /* ★★★ 2026-10-31：**region 改走「定点清除」**，不再碰 /compact-region。
     *
     * 原因（一手的四次实测，见 30-状态/设计-换气定点清除.md）：
     *   compactRegion 要 open turn + 整面静止，而换气只能在 turn 外行动 ——
     *   这两个要求不能同时满足，六次尝试全部失败。
     *
     * surfaceOp 直接替换 tool/result 已实测通过（2026-10-31 12:54，
     * `[huanqi][purge] OK 27815-27815 新seq=28423 节点 203->203`）。
     *
     * 顺序：先试定点清除（轻），没有候选或全失败 → 落回原来那条路（重）。 */
    purgeLog('[huanqi][purge] config purgeOnCuts=' + String(config.purgeOnCuts) + ' purgeMaxItems=' + String(config.purgeMaxItems) + ' purgeMaxChars=' + String(config.purgeMaxChars))
    if (mode === 'region' && config.purgeOnCuts === true) {
        let picked;
        try {
            /* ★ 主路径：LLM 诊断。它自带候选收集 + safe 判定。
             *   失败时 picked.ok=false → 下面会退回启发式。 */
            picked = await diagnosePurge(agent, sid, {
                maxChars: config.purgeMaxChars,
                maxItems: config.purgeMaxItems,
                maxCandidates: 12,
            });
            purgeLog('[huanqi][purge] LLM 诊断 ok=' + String(picked.ok)
                + ' 采纳=' + String(picked.items.length)
                + ' 扫描=' + String(picked.scanned === undefined ? '-' : picked.scanned)
                + ' err=' + String(picked.error === undefined || picked.error === null ? '-' : picked.error)
                + ' diag=' + String(picked.diag === undefined ? '-' : picked.diag)
                + ' raw=' + JSON.stringify(String(picked.raw === undefined ? '' : picked.raw).slice(0, 400)));
        }
        catch (e) {
            picked = { ok: false, error: 'diagnose threw: ' + String((e as any) && (e as any).message), items: [] };
        }
        if (picked.ok !== true) {
            purgeLog('[huanqi][purge] 收集候选失败: ' + String(picked.error) + ' → 落回全量');
        }
        else if (picked.items.length === 0) {
            purgeLog('[huanqi][purge] 扫描 ' + String(picked.scanned) + '/' + String(picked.total)
                + ' 个节点，没有污染源候选 → 落回全量');
        }
        else {
            const why = picked.items.map((it: any) => String(it.seq) + '(' + String(it.reason) + ')').join(' ');
            purgeLog('[huanqi][purge] 扫描 ' + String(picked.scanned) + '/' + String(picked.total)
                + ' 个节点，候选 ' + String(picked.items.length) + ' 条: ' + why);
            const done = purgeMany(agent, picked.items, sid);
            purgeLog('[huanqi][purge] 清除 ' + String(done.purged.length) + '/' + String(picked.items.length) + ' 条');
            if (done.ok) {
                return { ok: true, kind: 'purge', range: null, purged: done.purged, error: null };
            }
            purgeLog('[huanqi][purge] 全部失败 → 落回全量');
        }
    }
    const svc = compactionService(agent)
    if (svc === undefined) {
      /* ★★ 2026-10-27（第 5 代加）：第二条路 —— 借 `commands` 执行 /compact。
       *
       *   为什么原来拿不到：`compaction` 被 isolate 关在 preset 的 realm 里
       *   （profile 的 patch 里写着 `compaction: true` 是硬约束；01:14 删过一次，
       *    被 `RemoteError: Preset services require isolate realms` 拒了）。
       *   所以根层的 huanqi 无论从 agent.ctx / agent.session.ctx / 根 ctx 都够不到。
       *
       *   为什么这条路通：`/compact` 这条**命令**由 `@deepseek-ai/dsh-command-compact`
       *   （inject: ['commands','compaction']，同样在 realm 内）注册进 `commands`
       *   服务 —— 而 commands 是**根层服务**，这里 `ctx.get('commands')` 拿得到。
       *   命令的 handler 自带 realm 内的 compaction，等于借道进去。
       *
       *   代价：命令只做全量压缩，没有 region。可接受 —— 原来 region 失败本来就
       *   降级全量，而换气熔断时用的正是全量。
       */
      const viaCmd: any = await (async () => {
        let commands: any
        try { commands = (ctx as any).get('commands') }
        catch { commands = undefined }
        if (commands === undefined || commands === null || typeof commands.execute !== 'function')
          return { ok: false, kind: 'full', range: null, error: 'commands service not found' }
        /* 每次都用新的 AbortController —— 复用一个会在第一次 abort 之后让后续调用立刻失败。 */
        const runCommand = async (line: string): Promise<any> => {
          let ac: any
          try { ac = new AbortController() }
          catch { return { ok: false, error: 'AbortController unavailable' } }
          try {
            const settled = await commands.execute(agent, line, [], ac.signal)
            if (settled === undefined)
              return { ok: false, error: line + ' not registered' }
            const r = settled.result
            if (r !== undefined && r !== null && r.kind === 'success')
              return { ok: true }
            return {
              ok: false,
              error: 'command result: '
                + (r === undefined || r === null ? 'undefined' : String(r.kind) + ' ' + String(r.text || '')),
            }
          }
          catch (e: any) {
            return { ok: false, error: 'command threw: ' + String((e as any) && (e as any).message) }
          }
        }
        /* ★★★ 2026-10-27（第 5 代补）：**把「范围压缩」修回来。**
         *
         * 病（实测 _plugin-diag.log）：`compactOnce(region) → OK range=null`。
         * 因为唯一那条桥是官方 `/compact`，而它是**无参数 + 只做全量**
         * （dsh-command-compact/lib/index.js L49-52 拒任何参数、L54 调 compactNow）。
         * 于是 region 与 full 在桥上都塌成全量 —— 路 C 刚好够用，路 B 被带偏。
         *
         * 修：huanqi 自己算 range（`pickRegion` 只要 agent.session，根层够得到），
         * 再把 range 当参数交给**同在 realm 内注册**的 `/compact-region`
         * （dsh-yanqing-compact-region，与官方 command-compact 同构的那一扇门）。
         *
         * 三条退路，顺序不能换：
         *   ① 算得出 range → 先试范围压缩（这才是「初步治疗」的本意：只搬走脏的那段）
         *   ② 范围压缩失败（边界不平衡 / 区间被替换 / 忙）→ 降级全量
         *   ③ 算不出 range → 直接全量
         * ★ 无论走哪条，`kind` 记的是**实际做了什么**，不是**请求了什么** ——
         *   否则 recallHint 会一边说「范围压缩」一边说「全量压缩没有压了哪一段」。
         */
        if (mode === 'region') {
          const picked = pickRegionEx(agent)
          const range = picked.range
          /* ★ 2026-10-27 22:31：算不出范围就把**原因**写进日志，并顺手验一次
           *   `/compact-region` 到底注册上没有。
           *
           *   为什么用**非法参数**当探针：命令自己在门口挡（`parseRange` 拒 start<=0），
           *   所以 `/compact-region 0 0` 零副作用、绝不会真压。
           *   两种结果可区分：
           *     · 出现 `[compact-region] 参数无法解析` → 命令**注册了**（realm 内可达）
           *     · `not registered` → 命令**没注册**（包没加载 / inject 没满足）
           *   —— 这一枪同时回答「为什么算不出」和「命令在不在」两个问题。
           */
          if (range === null) {
            let probeNote = 'probe=skipped'
            try {
              const probe = await runCommand('/compact-region 0 0')
              probeNote = probe.ok ? 'probe=unexpected-ok' : 'probe=' + String(probe.error)
            }
            catch (e: any) {
              probeNote = 'probe-threw:' + String((e as any) && (e as any).message)
            }
            try {
              appendFileSync('D:\\AI\\memory\\hub\\_plugin-diag.log',
                new Date().toISOString() + ' [huanqi][region] pickRegion → null why='
                + String(picked.why) + ' info='
                + String(picked.info === undefined ? '-' : picked.info)
                + ' ' + probeNote + '\n')
            }
            catch { /* 诊断不许影响主流程 */ }
          }
          if (range !== null) {
            /* ★★★ 2026-10-27 23:05 定论（一手证据：会话事件 #1481–#1495）
             *
             *   **`/compact-region` 这条路废掉了 —— 不是它写错，是它接错了语义。**
             *
             *   `dsh-compaction-basic/lib/index.js:930-935`：
             *     compactRegion(start, end, agent, signal)
             *       → compactSurfaceRegion(..., { owner: 'current-turn', stability: 'whole-surface' })
             *   即：**必须在一个 open turn 里**，而且摘要的那一二十秒里
             *   **整个 surface 一个节点都不能变**（`assertWholeSurfaceUnchanged`，L581）。
             *   在 live 会话上这是不可能的 —— 实测 turn=17 时抛
             *   `compaction: session surface changed during summarization`。
             *   它本来是给「step 边界自动压缩」用的，不是给外部插件在熔断时用的。
             *
             *   官方 `/compact` 走 `compactNow`（L944-970）：
             *     { owner: null, stability: 'selected-span', flush }
             *   内部先 `agent.runMaintenance(...)` **排队等 turn 收尾**，
             *   校验只要求「被选中的那一段没变」，外面追加新节点不影响。
             *   ★ 实测它选的范围 = seq 943–1479（186 条 / 190,694 tokens），
             *     与 pickRegion 算出来的 943–1476 是同一段 ——
             *     **引擎本来就在做「部分压缩」，路 B 和路 C 在官方实现里是同一件事。**
             *
             *   所以：**不再调 /compact-region**。
             *   ★ 好处不只是能成功 —— 界面上只会留一条干净的
             *     `· compact · 已压缩 N 条历史记录（约 X tokens）`
             *     （文案在 dsh-client-ui-chat/lib/client.js:2671，
             *       数据来自 compaction/summary 的 shadowedSeqs/shadowedTokenCount），
             *     而不是先冒一条 `compact-region` 的失败命令块。
             */
            /* ★ 2026-10-27 23:21（第一次实测撞出来的第二个坑）：
             *   `/compact` 在**回合进行中**会被命令层直接拒绝，原话是
             *     `Compaction is unavailable because this process has an active compaction,
             *      or the agent is not idle.`
             *   —— 它**不像** compactNow 内部那样自己排队等 turn 结束：
             *   命令入口先做 idle 检查，忙就直接 return error。
             *
             *   而 huanqi 的触发时机恰恰是「我刚说完话」——那几十秒里回合还在收尾。
             *   22:53 那次之所以能成，纯属巧合：前面 compactRegion 白跑了 21 秒，
             *   到它出手时回合刚好结束。**不能靠时机撞。**
             *
             *   所以：忙就等，10 次 × 3 秒 = 30 秒，覆盖回合收尾那一段。
             *   只对「忙」这一种错误重试；别的错误（真失败）立刻返回，不掩盖。
             */
            /* ★★★ 2026-10-27 23:42（爀曦定）：**region 只走 /compact-region，失败绝不降级全量。**
             *   ★ 2026-10-31 补：这句现在只在**降级分支内部**成立 —— 主路径已改走定点清除。
             *
             *   为什么不能降级：降级把"只想压走最近这一段"变成"把整段 surface 压掉"。
             *   对一条刚开始换气、还没脏到底的会话，那是**加重**而不是治疗：
             *   本来只该搬走三个白烧的回合，结果把有用的上下文一起清了。
             *   而且用户在界面上看不出区别（两种都只显示一条 compact 提示）。
             *
             *   所以 region 失败就**如实失败**：why 进日志，交给 recallHint，
             *   下一次攒够截断再试。宁可这一轮不治，也不误伤整段历史。
             *
             *   ★ 熔断那条（full）不受影响 —— 那时候已经救不回来了，全量才是对的。
             */
            const span = String(range.start) + ' ' + String(range.end)
            let compact = await runCommand('/compact-region ' + span)
            for (let attempt = 0; attempt < 10 && !compact.ok
              && /not idle|active compaction|no open turn/i.test(String(compact.error)); attempt += 1) {
              await new Promise((resolve) => { setTimeout(resolve, 3000) })
              compact = await runCommand('/compact-region ' + span)
            }
            return {
              ok: compact.ok,
              /* ★ 现在 range 是真的用了：它既是这次调用的参数，也是 recallHint 要念的那段。 */
              kind: 'region',
              range,
              error: compact.ok ? null : String(compact.error),
            }
          }
          /* ★ 算不出范围 → 如实失败，**同样不降级全量**（理由同上）。
           *   落到下面那句 `runCommand('/compact')` 就是误伤，所以这里必须 return。 */
          return {
            ok: false,
            kind: 'region',
            range: null,
            error: 'no balanced range: ' + String(picked.why),
          }
        }
        const full = await runCommand('/compact')
        return { ok: full.ok, kind: 'full', range: null, error: full.ok ? null : full.error }
      })()
      const out = {
        kind: viaCmd.kind === undefined ? mode : viaCmd.kind,
        ok: viaCmd.ok,
        range: viaCmd.range === undefined ? null : viaCmd.range,
        error: viaCmd.ok ? null : viaCmd.error,
      }
      lastCompact.set(sid, out)
      try {
        appendFileSync('D:\\AI\\memory\\hub\\_plugin-diag.log',
          new Date().toISOString() + ' [huanqi][compact] 走 commands 桥 → kind='
          + String(viaCmd.kind) + ' range='
          + (viaCmd.range === null || viaCmd.range === undefined
            ? 'null'
            : String(viaCmd.range.start) + '-' + String(viaCmd.range.end))
          + ' / '
          + (viaCmd.ok ? 'OK' : 'FAILED: ' + String(viaCmd.error)) + '\n')
      }
      catch { /* 诊断不许影响主流程 */ }
      return out
    }
    /* ★★ 2026-10-26（砚青落）：`compactNow` 要 `ManualCompactAgentContext`，
     *   它比 `CompactionAgentContext` 多一个 `runMaintenance` —— 因为**手动压缩必须在
     *   agent 空闲时跑**（它是非 turn 维护任务，不能和正在跑的回合抢史）。
     *
     *   `Agent` 上正好有 `runMaintenance<T>(task: (signal) => Promise<T>)`，
     *   所以最干净的写法是**把整件事塞进 runMaintenance 里**：
     *     - 它会给我们一个 signal（省掉自己造 AbortController）
     *     - 它会保证「没在跑回合」
     *     - 它会挡住后续唤醒输入直到任务落定
     *
     *   ★ 这比自己 new 一个 AbortController 更对：手动压缩本来就该是维护任务。
     */
    const manualCtx = {
      session: agent.session,
      options: {},
      /* ★ 不注解 `signal` 的类型 —— 本项目的 tsconfig 只开了 `lib: ["ES2022"]`，
       *   没有 DOM，所以 `AbortSignal` 是**不存在的名字**。
       *   让 TS 从 `agent.runMaintenance` 的签名里推断即可（那是权威来源）。 */
      runMaintenance: (task: any): any => agent.runMaintenance(task),
    }
    let out: any
    if (mode === 'region') {
      const range = pickRegion(agent)
      if (range === null) {
        out = { kind: 'region', ok: false, range: null, error: 'no balanced range' }
      }
      else {
        try {
          /* ★ SessionSeq 是 branded type（`{ readonly [BRAND]: 'SessionSeq' }`），
           *   运行时就一个 number —— 所以这里必须显式过一道。
           *   不 cast 的话 strict 模式直接拒绝。 */
          await svc.compactRegion(range.start, range.end, manualCtx)
          out = { kind: 'region', ok: true, range }
        }
        catch (err) {
          /* ★ 边界不平衡 / 区间被替换 / 正在压缩 —— 都退到全量。
           *   这和熔断时的动作是同一个，所以共用一个 outcome 形态。 */
          out = { kind: 'region', ok: false, range, error: describeError(err) }
        }
      }
    }
    else {
      out = { kind: 'full', ok: false, range: null, error: 'not attempted' }
    }
    // 范围压缩失败（或本来就是全量）→ 走 compactNow
    if (!out.ok) {
      try {
        await agent.runMaintenance(async (signal: any) => {
          await svc.compactNow(manualCtx, signal)
        })
        out = { kind: 'full', ok: true, range: out.range }
      }
      catch (err) {
        out = { kind: 'full', ok: false, range: null, error: describeError(err) }
      }
    }
    lastCompact.set(sid, out)
    return out
  }
  /** 把任意 throw 值变成一行可读的字。 */
  function describeError(err: unknown): string {
    if (err instanceof Error)
      return err.name + ': ' + err.message
    return String(err)
  }
  /**
   * 压缩之后的「取回指引」。
   *
   * ★★ 这是整层的最后一环，也是最容易被写坏的一环：
   *   **不能让 agent 去读摘要** —— 摘要会变成新的输入，回到摘要复利。
   *   所以给的是一张地图（seq 指针）+ 明确的「去取一手原文」。
   */
  function recallHint(outcome: any, cuts: number, sid: string): string {
    /* ★★ 2026-10-26（砚青落·仿真抓出来的真 bug）：
     *   这里原来写的是 `const sid = ...; void sid;` 然后直接用字面量 `log:<会话>` ——
     *   也就是说**发出去的门牌是坏的**（`log:<会话>#seq=1–5`，那个 `<会话>` 是字面量）。
     *   仿真跑第一次就把它打出来了：「本段原文：log:<会话>#seq=1–5」。
     *   ★ 这正是我们自己定的那条 —— **错的门牌比没有更坏**。所以必须拿真 sid。
     *     拿不到真 sid 时（理论上不会）宁可不说 seq，也不能给一个假门牌。 */
    const span = outcome.range !== null && sid !== ''
      ? 'log:' + sid + '#seq=' + String(outcome.range.start) + '–' + String(outcome.range.end)
      : outcome.range !== null
        // 有 range 但没 sid：不猜门牌，只给检索入口
        ? '（这段落在第 ' + String(outcome.range.start) + '–' + String(outcome.range.end) +
          ' 条，但没拿到会话号 —— 用 memq 按关键词检索）'
        // 全量压缩没有 range：给会话号 + 检索入口
        : sid !== ''
          ? '（全量压缩没有「压了哪一段」—— 用 `memq timeline --since <时间>` 或 memq 搜关键词，会话 ' + sid + '）'
          : '（这段的 seq 没能算准，用会话号 + 关键词检索）'
    return [
      '[huanqi] 刚才连续 ' + String(cuts) + ' 次陷入重复，已做',
      outcome.kind === 'region' ? '范围压缩' : '全量压缩',
      '（上下文已清）。',
      '',
      '本段原文：' + span,
      '',
      '★ 不要依赖摘要 —— 它是二手转述。需要细节时先用 memq open（或 mcp__echo__echo_open）',
      '  取回一手原文，再继续。你要的不是「我记得当时怎样」，是「原文写着什么」。',
    ].join('\n')
  }
  /**
   * 让出一拍（2026-10-31 加）—— `waitUntilQuiet` 底下的最小单位。
   *
   * ★ `turn/end` 是在 append 事务里广播的，处理器起的 async IIFE
   *   在第一个 await 之前仍在发布过程中；`setTimeout(0)` 跨到下一个宏任务才安全。
   */
  const yieldToHost = (ms = 0) => new Promise<void>((resolve) => { setTimeout(resolve, ms) })

  /**
   * 等 agent 停下来，再让它静 3 秒（2026-10-31 爀曦定）。
   *
   * ★ 爀曦原话：「有不用做退避延迟的方法，直接检测 agent 是否还在活跃，
   *   停止活动后 3s 立刻执行范围或者全量压缩」
   *
   * ★ 退避是**猜**时间，检测是**看**状态。`whenIdle` resolve 就是真的停了。
   * ★ 那 3 秒留给「写锁彻底放开」—— `whenIdle` 只保证回合结束，
   *   但 `turn/end` 的 append 事务可能还没发布完。
   * ★ 上限：`whenIdle` 万一永远不 resolve，不能陪着卡死 ——
   *   等满就放弃等待、直接去压，让压缩自己如实报错。
   */
  async function waitUntilQuiet(agent: any, quietMs = 3000, maxWaitMs = 60000): Promise<{ how: string; quietMs: number }> {
    const whenIdle = agent === undefined || agent === null ? undefined : agent.whenIdle
    if (typeof whenIdle !== 'function') {
      await yieldToHost(quietMs)
      return { how: 'no-whenIdle', quietMs }
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<string>((resolve) => {
      timer = setTimeout(() => { resolve('timeout') }, maxWaitMs)
    })
    let how = 'idle'
    try {
      const r = await Promise.race([whenIdle.call(agent), timeout])
      if (r === 'timeout') how = 'timeout'
    } catch {
      how = 'idle-threw'
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    if (how === 'timeout') return { how, quietMs: 0 }
    await yieldToHost(quietMs)
    return { how, quietMs }
  }

  /**
   * 压缩后的「召回提示」（2026-10-31 爀曦定）。
   * ★ 为什么要它：压缩是为了救，但压缩本身会丢细节 —— 给一轮机会自己找回来。
   * ★ 不硬编码：`config.recallPrompt` 非空就用它的，留空才用这段默认。
   */
  function recallPromptText(): string {
    const custom = typeof config.recallPrompt === 'string' ? config.recallPrompt.trim() : ''
    if (custom !== '') return custom
    return [
      '[huanqi] 上下文刚被压缩过，里面有东西丢了。',
      '先别急着干活 —— 把丢掉的东西找回来：',
      '  · 一手原文：`memq open <指针>` 或 `mcp__echo__echo_open`',
      '  · 按关键词检索：`mcp__echo__echo_search terms=["<最近在做的关键词>"]` 或 `memq <词>`',
      '  · 按时间定位：`memq timeline --since <ISO>`',
      '',
      '拿回来的东西写一句「我找回了：…」，再继续。',
      '★ 别依赖摘要 —— 摘要只是索引，原文永远优先。',
    ].join('\n')
  }

  /**
   * 诊断落盘（2026-10-31 砚青落）。
   * ★ `ctx.logger.warn` 在这台 Electron 上不进任何文件（实测 grep 一条都没有），
   *   熔断分支原来只有 logger，所以那一晚整个过程一个字都没留下。
   */
  function diagLog(tag: string, line: string): void {
    try {
      appendFileSync('D:\\AI\\memory\\hub\\_plugin-diag.log',
        new Date().toISOString() + ' [huanqi][' + tag + '] ' + line + '\n')
    } catch { /* 诊断不许影响主流程 */ }
  }
  /**
   * 已经收到过「落盘指令」的 agent。
   *
   * ★ 2026-10-23（砚青落）：为什么需要它 —— 熔断后 `steer` 会把会话推进下一轮，
   * 而那一轮的延续额度**仍然是 0**。如果它又没产出，就会再走一次熔断、再 steer 一次，
   * 变成**无限循环**（每轮都烧一次钱，却永远不让人介入）。
   *
   * 所以：每条 agent 的一生只收到一次落盘指令。第二次熔断起就不再推它 ——
   * 那时候能做的确实只剩「停下来等人手动压缩」。
   */
  const landPrompted = new WeakSet<object>()
  /**
   * 换气账本。
   *
   * ★ **全局一份，跨会话共享**（爀曦 2026-10-10 定：「分会话管理会很麻烦」）。
   * 理由是上下文变脏通常是全局性的 —— 同一台机器、同一批模型、同样的用法。
   * 所以一个会话把额度耗光会影响别的会话，**这是有意的**。
   */
  const ledger = new CreditLedger(config.maxContinuations)
  /**
   * 账本路径：用户在设置里给了就用它，否则走 `<DSH_HOME>/state/dsh-huanqi.json`。
   * ★ 落盘的意义：不落盘的话重启一次就回满额，「靠正常对话攒额度」永远攒不满。
   */
  const ledgerPath = config.ledgerPath !== '' ? config.ledgerPath : CreditLedger.defaultPath()
  /** 记账出问题时唯一的出口 —— ★ 只报告，绝不抛（守卫不能自己变成故障）。 */
  const warnLedger = (msg: string): void => { ctx.logger.warn(msg) }
  if (ledger.load(ledgerPath, warnLedger)) {
    ctx.logger.info(`dsh-huanqi: restored credit ${ledger.credit}/${ledger.creditMax} from ${ledgerPath}`)
  }

  function detectorFor(agent: Agent): LoopDetector {
    let detector = detectors.get(agent)
    if (detector === undefined) {
      detector = new LoopDetector(config)
      detectors.set(agent, detector)
    }
    return detector
  }

  /**
   * Is this a delegated (sub-)agent rather than a root conversation?
   *
   * ★ 2026-10-23（爀曦指出，砚青落）—— **子 agent 不参与换气判定。**
   *
   * 病因（2026-10-22 夜实测）：子 agent 正在干活时被反复「误杀」。
   * 换气判的是「这一轮没出正文」，而子 agent 的「没出正文」**通常只是它还在读文件、
   * 跑工具、或等一个长命令** —— 那不是循环，是工作。主会话和子 agent 在同一把尺子下，
   * 被误判的那一方永远是子 agent，因为它本来就更少「说话」、更多「做事」。
   *
   * 判据用 DSH 自己的分类，不猜：
   *   `session.meta.parentSession`（**字符串，父会话 id** —— ★★ 实测这才是这个 DSH 版本用的），
   *   或 `session.meta.origin === 'subagent'`（若某版本有 coarse classification），
   *   或 `session.meta.delegationDepth > 0`（递归深度）。
   *
   * ★★★ **2026-10-23 22:29 找到根因**：前两版都只读 `origin` / `delegationDepth`，
   *   而这两个字段**在这个 DSH 版本里根本不存在** —— 于是 `isSubagent()` 恒为 false，
   *   豁免从写下的第一天起就没生效过（`react()` 那条路也一样）。
   *   真字段是 `parentSession`，来源见 `dsh-session/lib/index.js:1398`：
   *     `...meta?.parentSession === void 0 ? {} : { parentSession: meta.parentSession }`
   *   以及 `dsh-subagent/lib/index.js:2073` 的 `record.header.parentSession === parentSessionId`。
   *   ★ 教训：**「字段读出来是 undefined」不等于「这个会话不是子 agent」** ——
   *     我连续两次把「读不到」当成「不成立」，两次都写成了「已修复」。
   *
   * ★★ **拿不到 session 时不拦。** 这是有意的方向：宁可漏拦一个子 agent
   *   （它照旧会被后面的流内/流末保护兜住），也不能因为读不到元数据
   *   就把主会话这层保险悄悄关掉 —— 那是「保险失效还说自己在值班」。
   */
  /* ★★★ 2026-10-23 22:47 爀曦拍板：**智能体团队的 agent 和一次性子 agent 归成一类。**
   *   —— 实测它们在投影缓存里长得一样（都有 `subagent.identity`、`mode` 都是
   *   `continuable`，`parentSession` 两边都没有），分开判要绕去读父会话的两张表，
   *   而「常驻」这件事本身**不增加换气的负担**（空闲时没有 turn，不产生判定）。
   *
   *   `subagentPolicy` 三档（见 `Config` 注释里的表）：
   *     strict  循环检测 + 流内早杀 + 空回合续  （= 现在的行为）
   *     relaxed 只保留流内早杀
   *     exempt  全跳过
   *
   *   判定带缓存：一个会话只读一次投影缓存。
   */
  const subagentCache = new Map<string, boolean>()

  /** 投影缓存目录。配置留空时按 dsh home 推。 */
  function sessionCacheDir(): string {
    if (config.sessionCacheDir !== '') return config.sessionCacheDir
    // DSH_HOME 优先；否则从 ledgerPath（state/…）往上两级。都没有就用 cwd 拼。
    const home = process.env.DSH_HOME
    if (home !== undefined && home !== '') {
      return join(home, 'storages', 'session_projcache', 'sessions')
    }
    const stateDir = dirname(config.ledgerPath === '' ? 'state/dsh-huanqi.json' : config.ledgerPath)
    return join(dirname(stateDir), 'storages', 'session_projcache', 'sessions')
  }

  /** 兜底判据：投影缓存里 `record.rows.subagent.val.identity` 非空 ⇒ 子 agent。 */
  function readSubagentFromCache(sid: string): boolean {
    try {
      const file = join(sessionCacheDir(), `${sid}.json`)
      if (!existsSync(file)) return false
      const j = JSON.parse(readFileSync(file, 'utf8')) as {
        record?: { rows?: { subagent?: { val?: { identity?: unknown } } } }
      }
      const identity = j?.record?.rows?.subagent?.val?.identity
      if (identity === undefined || identity === null) return false
      if (typeof identity !== 'object') return false
      // `{}`（主会话）不算；有 `mode` / `label` 的才算。
      return Object.keys(identity as object).length > 0
    } catch {
      // 读不到就当「不是」—— 与 isSubagent 同一条方向：不因为读失败就关掉主会话的保险。
      return false
    }
  }

  /**
   * 这个会话是不是子 agent（含 Agent Teams 成员）？
   *
   * 四条判据，任一命中即认定：
   *   ① `session.header.parentSession` ← **★★ 实测才是真位置**
   *   ② `session.meta.parentSession`（若某版本放 meta）
   *   ③ `ctx.agents.get(sid)?.session.header / meta`
   *   ④ 投影缓存 `record.rows.subagent.val.identity` 非空（兜底）
   *
   * ★★★ 2026-10-23 23:05 实测（探针 `5961cb4f` 一条真子 agent 的 turn/end）：
   *   `diag` = `policy=strict, hasParent=false, hasMeta=false, agentFound=true`
   *   `sessionKeys` = `log, surfaceManager, **header**, inheritedEventCount, …`
   *   → **`session.meta` 根本不存在；`parentSession` 在 `session.header` 里。**
   *
   * ★★ 四次踩坑的完整链条（每次都以为「找到了」）：
   *   1. 读 `ctx.agents.get(sid)?.session.meta` → 拿到 agent，但 meta 是 undefined
   *   2. 改用 `meta.origin`              → 字段名错
   *   3. 改用 `meta.parentSession`       → 对象对了，但 meta 不是容器
   *   4. 改用 `session.header.parentSession` → ✅
   *   **每次都不是逻辑错，是「我以为它在那儿」。**
   *   判据：**拿到 undefined 时，先把 key 全 dump 出来，别猜路径。**
   */
  function isSubagentSession(
    sid: string | undefined,
    meta?: unknown,
    header?: unknown,
  ): boolean {
    if (sid === undefined || sid === '') return false
    const cached = subagentCache.get(sid)
    if (cached !== undefined) return cached

    let result = false
    const hasParent = (o: unknown): boolean => {
      if (o === undefined || o === null || typeof o !== 'object') return false
      const p = (o as { parentSession?: unknown }).parentSession
      return typeof p === 'string' && p.length > 0
    }
    const looksSubagent = (o: unknown): boolean => {
      if (o === undefined || o === null || typeof o !== 'object') return false
      const m = o as { origin?: unknown; delegationDepth?: unknown }
      if (m.origin === 'subagent') return true
      return typeof m.delegationDepth === 'number' && m.delegationDepth > 0
    }

    // ① header（实测真字段）
    if (hasParent(header)) result = true
    // ② meta
    else if (hasParent(meta) || looksSubagent(meta)) result = true

    // ② ctx.agents
    if (!result) {
      const agent = ctx.agents.get(sid as never) as GuardableAgent | undefined
      const m2 = (agent as { session?: { meta?: Record<string, unknown> } } | undefined)?.session?.meta
      if (typeof m2?.parentSession === 'string' && (m2.parentSession as string).length > 0) result = true
      else if (m2?.origin === 'subagent') result = true
      else if (typeof m2?.delegationDepth === 'number' && (m2.delegationDepth as number) > 0) result = true
    }

    // ③ 投影缓存兜底
    if (!result) result = readSubagentFromCache(sid)

    subagentCache.set(sid, result)
    return result
  }

  /** 循环检测链（warn / steer / cancel）要不要跳过？ → strict 才不跳。 */
  function skipLoopGuard(sid: string | undefined, meta?: unknown, header?: unknown): boolean {
    if (config.subagentPolicy === 'strict') return false
    return isSubagentSession(sid, meta, header)
  }

  /** 流内早杀要不要跳过？ → 只有 exempt 跳，relaxed 保留。 */
  function skipStreamCut(sid: string | undefined, meta?: unknown, header?: unknown): boolean {
    if (config.subagentPolicy !== 'exempt') return false
    return isSubagentSession(sid, meta, header)
  }

  /** 空回合续/熔断要不要跳过？ → strict 之外都跳。 */
  function skipEmptyTurn(sid: string | undefined, meta?: unknown, header?: unknown): boolean {
    if (config.subagentPolicy === 'strict') return false
    return isSubagentSession(sid, meta, header)
  }

  /** 判词里那一段后缀，用来区分是哪个档位放过的。 */
  function policySuffix(): string {
    return config.subagentPolicy === 'strict' ? '' : ':' + config.subagentPolicy
  }


  function react(agent: GuardableAgent, reason: StallReason, sid?: string, header?: unknown): void {
    // ★ 循环检测链（warn / steer / cancel）—— `subagentPolicy` 不是 strict 时，
    //   子 agent 整条跳过。判词里也能看出来（`skipLoopGuard` 只影响循环检测，
    //   流内早杀另有开关 `skipStreamCut`）。
    if (skipLoopGuard(sid, undefined, header)) {
      ctx.logger.info(`dsh-huanqi: skip loop-guard — subagent (policy=${config.subagentPolicy})`)
      return
    }
    const s = stringsFor(readLanguage(ctx))
    switch (config.escalate) {
      case 'warn':
        agent.inject(message(s.warn(s.detail(reason)), 'notice', s.stallSummary(reason)))
        return
      case 'steer':
        agent.steer(message(s.steer(s.detail(reason)), 'notice', s.stallSummary(reason)))
        return
      case 'cancel':
        agent.cancel(config.cancelCause as unknown as AgentCancelCause)
        return
    }
  }

  /**
   * End one in-flight model call from inside the stream wrapper.
   *
   * The synthesized `finish` is the part that must not be skipped: the agent
   * loop feeds every chunk this wrapper yields into the same assembler an
   * adapter feeds, and `packages/llm/llm/src/invariant.ts` requires a terminal
   * finish chunk while explicitly allowing `error`/`aborted` to leave blocks
   * open. Returning without one would violate that grammar.
   *
   * Order matters — steer first, then return the terminal chunk. The user
   * message must be durably enqueued *before* the `error` finish throws out of
   * the step, so the resumed turn that the loop's `turn/end` finally block
   * schedules (`if (!this.inbox.hasPending) return false`) claims it. The error
   * path reaches `turn/end` through `throwError` without passing a turn-stopping
   * idle check, so this ordering is what makes the correction survive.
   *
   * @param agent - the live agent that owns the call.
   * @param chars - visible-output characters emitted before the break.
   * @returns the terminal chunk to yield as the call's last.
   */
  /**
   * End one in-flight model call from inside the stream wrapper.
   *
   * ## Why the call is closed, not failed
   *
   * An earlier version ended the call with a terminal `error` finish. That is
   * legal at the stream level — `llm/invariant` permits `error`/`aborted` to
   * leave blocks open — but it produces a session shape the rest of the harness
   * cannot handle, in two independent ways:
   *
   *  1. **The client cannot render it.** `agent-loop` settles an `error` finish
   *     as an `assistant/attempt` and appends no `assistant/message`
   *     (`step()`, the `finish.kind === 'error' || 'aborted'` branch). The
   *     conversation renderer builds its `assistant-step` node from a settled
   *     message, so it returns `null` for that step — and
   *     `buildTargetUpserts` refuses to withdraw a target it already
   *     materialized, throwing `conversation Definition "assistant-step"
   *     withdrew materialized target "chat"`. A reasoning-only break has no
   *     visible content to fall back on, so every break crashed the UI.
   *  2. **The turn could never continue.** The same branch ends in
   *     `throwError(error)`, so `turn()` throws out of the loop *before* it
   *     reaches `if (!this.inbox.hasPending) return false` — the line that
   *     decides whether another turn opens. A queued steer was therefore never
   *     claimed, which is why a break looked like "it just stopped".
   *
   * Closing the open blocks and finishing with `stop` instead puts the call on
   * the ordinary path: `step()` assembles `live.blocks()` into a real
   * `assistant/message`, the client renders it, and `turn()` returns normally so
   * pending steering opens the next turn.
   *
   * The invariant requires `open.size === 0` for a `stop` finish, which is
   * exactly what closing the blocks establishes.
   *
   * @param agent - the live agent that owns the call.
   * @param repeated - characters of REPETITION, not the call's total length. The
   *   two differ by 1.6x-10.1x on measured firings, and the notice is about the
   *   repetition, so this is the figure that reaches the model.
   * @param rule - which detector fired.
   * @param open - the blocks still open, in stream order, with their text.
   * @returns the terminal chunks to yield, or `null` when the break cannot be
   *   made safe and the stream should be left alone.
   */
  function breakStream(
    agent: GuardableAgent,
    repeated: number,
    rule: BreakRule,
    open: readonly { index: number; blockType: string; text: string }[],
  ): StreamChunk[] | null {
    // A `stop` finish is only legal with no open block, so every open block must
    // be closed. That is safe for text/reasoning, whose payload this wrapper
    // accumulated. It is NOT safe for a tool-call: closing one would commit a
    // half-streamed call into `message.content`, and `step()` executes any
    // tool-call block it finds — running a call whose arguments are still
    // truncated JSON. Leaving it open fails the invariant instead. Neither is
    // acceptable, so the break is abandoned; the post-call detectors still
    // apply, and a few more repeated characters are cheaper than a bad call.
    if (open.some((block) => block.blockType !== 'text' && block.blockType !== 'reasoning')) {
      ctx.logger.warn(`loop-guard: repetition detected but a non-text block is open; not breaking (rule: ${rule})`)
      return null
    }
    const lang = readLanguage(ctx)
    const s = stringsFor(lang)
    const what = whatFor(lang, rule)
    ctx.logger.warn(`dsh-loop-guard: breaking a repetitive stream (${repeated} repeated chars, one call, rule: ${rule}, code: ${config.breakCode})`)
    if (config.breakCorrection) {
      agent.steer(message(s.correction(what, repeated), 'notice', s.breakSummary(what, repeated)))
    }
    // Start waiting for the driver to return to `idle` BEFORE the terminal chunk
    // is yielded. The `whenIdle()` promise is captured here, synchronously, so
    // it observes this turn's completion; awaiting it later (from the break
    // path) would race the very wind-down it needs to follow.
    if (config.resumeAfterBreak) scheduleResume(agent, s.correction(what, repeated), s.breakSummary(what, repeated))
    const out: StreamChunk[] = []
    for (const block of open) {
      // `block-end` wins over the accumulated deltas (`BlockAssembler.assemble`
      // returns `partial.block` when set), so this payload is what the committed
      // message carries.
      out.push({
        type: 'block-end',
        index: block.index,
        block: { type: block.blockType, text: block.text } as never,
      })
    }
    out.push({ type: 'finish', reason: { kind: 'stop' } })
    return out
  }

  /**
   * 干净地结束这一轮流：关掉所有还开着的块，再发一个 terminal `finish`。
   *
   * ## 为什么需要它（而不是直接 `return`）
   *
   * `llm/invariant` 要求：流必须以 terminal `finish` 收尾，而且**带 `stop` 的 finish
   * 只在没有任何块开着的时候才合法**。所以从流内部截断一轮，不能只是 `return` ——
   * 那会留下开着的块，违反语法。
   *
   * ## 为什么工具调用块开着就放弃
   *
   * 关掉一个还开着的 tool-call 块，会把一个**只流了一半的调用**提交进 `message.content`，
   * 而 `step()` 会执行它找到的任何 tool-call 块 —— 也就是去跑一个参数还是断 JSON 的调用。
   * 留着不关又违反 invariant。两条都不可接受，所以**放弃截断**：
   * 调用后的那些检测器照样会跑，多流几个字符比执行一个坏调用便宜得多。
   *
   * 这段判断和 `breakStream` 里那段是同一条理由；这里独立成函数是因为
   * **换气的截断和"重复切断"是两种病，不该共用同一套日志与文案** ——
   * 共用一个函数会让以后调其中一个必然动到另一个。
   *
   * @param open - 还没关的块，按流顺序。
   * @returns 要 yield 的收尾块；不该截断时返回 `null`。
   */
  function finishStream(
    open: readonly { index: number; blockType: string; text: string }[],
  ): StreamChunk[] | null {
    if (open.some((block) => block.blockType !== 'text' && block.blockType !== 'reasoning')) {
      return null
    }
    const out: StreamChunk[] = []
    for (const block of open) {
      out.push({
        type: 'block-end',
        index: block.index,
        block: { type: block.blockType, text: block.text } as never,
      })
    }
    out.push({ type: 'finish', reason: { kind: 'stop' } })
    return out
  }

  /**
   * Re-enter the model once the broken turn has actually finished unwinding.
   *
   * `wakeDriver()` only starts a driver when the agent is `idle`, so a wake
   * issued from inside the stream wrapper (phase `running`) is silently
   * dropped: `send()` classifies it as a non-abort wake, `wakeDriver` refuses
   * to latch it, and `kick()`'s `finally` sees no `wakeRequested`. Waiting on
   * `whenIdle()` is what puts the wake on the far side of that boundary.
   *
   * The continuation is a follow-up turn carrying the correction text rather
   * than an empty message: an empty one would hand the model the same
   * degenerate history with no new instruction, which is the loop's own input.
   *
   * Failures here are logged, never thrown: this runs detached from the stream,
   * and a guard must not be the reason a session dies.
   */
  function scheduleResume(agent: GuardableAgent, text: string, summary: string): void {
    const whenIdle = agent.whenIdle
    const followup = agent.followup
    if (typeof whenIdle !== 'function' || typeof followup !== 'function') return
    void whenIdle.call(agent).then(() => {
      followup.call(agent, message(text, 'notice', summary))
      ctx.logger.debug('dsh-loop-guard: resumed the turn after a break')
    }).catch((error: unknown) => {
      ctx.logger.warn(`dsh-loop-guard: could not resume after a break: ${String(error)}`)
    })
  }

  /* ── 空回合（2026-10-19 从 dsh-stalled-turn-continue 吸收）─────────────────
   *
   * 上面所有判据都挂在 `llm/stream` 上 —— 也就是说，**它们只在「有一次模型调用」时
   * 才有机会看一眼**。而有一种失败是「调用了，但什么都没留下」：只发了 reasoning，
   * 然后直接 end-of-turn，没有 text、没有 tool-call。引擎认为这一轮正常结束了，
   * 于是没有人再开口，会话停在那里。
   *
   * ★ 这条判据必须挂在 `session/event` 上：只有 `turn/end` 知道「整个回合结束了」，
   *   而流只知道「这一次调用结束了」。一次回合可能有好几次调用，
   *   中间某次没产出是正常的，整轮都没产出才是病。
   *
   * ★ 记账：**共用同一个 `ledger`**。一次续命就是一次续命，不分病种。
   *   额度耗尽时和流内那条一样熔断 —— 并且**留一条可见的消息**，
   *   因为空消息会让会话从那一刻起永久不可用。
   */
  // ★ 用 `!== false` 而不是真值判断：zod 的默认值只在「经过 schema 解析」时生效。
  // 任何绕过解析的路径（测试夹具、配置注入、旧版本升级）拿到的都是 `undefined`，
  // 而 `undefined` 在做真值判断时等于「关掉」—— 那条判据就会静默失效，没人知道。
  // 默认开 = 只有显式写 false 才关。
  if (config.emptyTurnContinue !== false && config.maxContinuations > 0) {
    /**
     * sessionId → **最后一条** assistant 消息有没有出现 text / tool-call。
     *
     * ★ 2026-10-19 修（爀曦当天实测抓到的真实形状）：
     *   第一版记的是「这一轮里**任何一次**产出」，于是每次读文件、写文件（tool-call）
     *   都会把整轮标成「有产出」—— 而**最后一步卡在思考里**的时候，判据就永远不触发。
     *
     *   真实形状（他的原话）：「前面有正常思考和调用文件、读写，但是到最后一步思考的时候
     *   停留在思考里了，没有再继续调用，输出，结果就是最后一步没有正文输出」。
     *
     *   而判据 ①（流内早杀）要求思考够 silentReasoningChars 才动，最后那一步常常够不到。
     *   **两条判据都漏在这个形状上。**
     *
     *   所以这里记的是「最后一条」—— 每收到一条 assistant/message 就**覆盖**，
     *   不是 OR 累积。turn/end 时看最后留下的那个值。
     */
    const lastMessageHadOutput = new Map<string, boolean>()
    /** sessionId → 最后一条 assistant 消息的形状（如 "text" / "reasoning" / "reasoning+tool-call"） */
    const lastMessageShape = new Map<string, string>()
    /** sessionId → 本轮 turn/start 的时间戳（毫秒），用来算「卡了多久」 */
    const turnStartedAt = new Map<string, number>()
    /** sessionId → 累计开过多少轮（2026-10-31 加；两套压缩冷却都按它算） */
    const turnSeq = new Map<string, number>()
    /** sessionId → 上次范围压缩时的轮次号（配合 `regionCompactEveryTurns`） */
    const lastRegionCompactAt = new Map<string, number>()
    /** sessionId → 上次熔断救援时的轮次号（配合 `breakerRescueEveryTurns`） */
    const lastBreakerRescueAt = new Map<string, number>()

    ctx.on('session/event', ((session: { id?: string } | undefined, event: { type?: string; data?: unknown } | undefined): void => {
      const sid = session === undefined || session === null ? undefined : session.id
      if (typeof sid !== 'string') return
      const type = event === undefined ? undefined : event.type
      if (type === 'turn/start') {
        lastMessageHadOutput.set(sid, false)
        // ★ 诊断：记下本轮开始时间（用来算「卡了多久」）
        turnStartedAt.set(sid, Date.now())
        // ★ 2026-10-31：每条会话自己的轮次序号 —— 两套压缩冷却都按它算。
        turnSeq.set(sid, (turnSeq.get(sid) ?? 0) + 1)
        return
      }
      if (type === 'assistant/message') {
        // 一条 assistant 消息只要有 text 或 tool-call，这一轮就算有产出。
        const data = event === undefined ? undefined : (event.data as { message?: { content?: unknown } } | undefined)
        const content = data === undefined ? undefined : data.message?.content
        if (Array.isArray(content)) {
          const has = content.some((part: unknown): boolean => {
            if (part === null || typeof part !== 'object') return false
            const t = (part as { type?: unknown }).type
            return t === 'text' || t === 'tool-call' || t === 'tool_call'
          })
          // ★ 覆盖，不是 OR —— 见上面那段注释
          lastMessageHadOutput.set(sid, has)
          // ★ 诊断：记下最后一条消息里到底有什么（给排查用）
          lastMessageShape.set(
            sid,
            content
              .map((p: unknown) => (p !== null && typeof p === 'object' ? String((p as { type?: unknown }).type) : '?'))
              .join('+') || '(空)',
          )
        }
        return
      }
      if (type !== 'turn/end') return

      const data = event === undefined ? undefined : (event.data as { reason?: { kind?: unknown } } | undefined)
      const kind = data === undefined ? undefined : data.reason?.kind

      // ★★ 诊断（2026-10-19 第二次加，改成 warn 级必定可见）：
      // 上一版的 debug 日志看不到，所以「停在思考里」那次查不出到底是哪种情况。
      // 这一行在任何 kind 下都会打，能区分三种可能：
      //   ① 压根没这行 → turn 没结束，卡在中间了（判据 ④ 管不到，得靠判据 ①）
      //   ② 有这行但 kind 不是 completed → 判断被我筛掉了
      //   ③ 有这行、kind=completed、最后一条=reasoning → 应该续却没续（代码 bug）
      /* ★★ 2026-10-23（砚青落，第二版）：子 agent 不参与判定 —— 这条判据在 `turn/end` 这条路
       *   原来整个漏掉了。
       *
       * `react()`（挂在 `llm/stream` 上）有 isSubagent 早退，但「空回合」这条判据是挂在
       * `session/event` 上的 —— 走的是另一条路，于是：
       *   ① 判词照记 `continue:credit=N`，面板上看着像「换气要续一个子 agent」；
       *   ② 更要紧的是后面真会 `scheduleResume` —— 那会把一个正在读文件、跑长命令的
       *      子 agent 推走。**它不是循环，是工作。**
       *
       * ★★ 第一版只查了 `ctx.agents.get(sid)` —— **实测拿不到**（子 agent 的会话不一定在
       *   `ctx.agents` 里），于是 `subagentExempt` 恒为 false，修复等于没生效。
       *   证据：2026-10-23 20:36 子 agent `84b4994d` 仍被判 `continue:credit=4`，
       *   而 `skip:subagent` 一条都没出现过。
       *
       * ★ 所以**两路都查**：`session.meta`（这个回调的入参对象上就带着，最可靠）
       *   与 `ctx.agents.get(sid)?.session.meta`（兜底）。任一命中就整条早退。
       * ★ 两路都拿不到时不拦 —— 与 isSubagent 同一条方向：宁可漏拦一个子 agent，
       *   也不能读不到元数据就把主会话这层保险悄悄关掉。
       */
      const verdictAgent = ctx.agents.get(sid as never) as GuardableAgent | undefined
      const eventSessionMeta = (session as { meta?: unknown } | undefined)?.meta
      /* ★★★ 2026-10-23 23:05 实测（探针 `5961cb4f`）：
       *   `session.meta` **不存在**，`parentSession` 在 **`session.header`** 里。
       *   `sessionKeys` 明确列出了 `header`。
       *   这就是前四版全都失败的真正原因 —— 一直在 `meta` 下找，而那个对象是 undefined。 */
      const eventSessionHeader = (session as { header?: unknown } | undefined)?.header

      /* ★★ 2026-10-23 三档落地：`skipEmptyTurn` 在 `strict` 档恒为 false ——
       *   也就是说 strict 的行为**和以前完全一样**，不会让谁突然失去保护。
       *   `relaxed` / `exempt` 档才对子 agent 跳过「空回合续/熔断」。
       *
       *   判定本身在 `isSubagentSession(sid, meta, header)`，四路：
       *     ① `session.header.parentSession` ← 实测真字段
       *     ② `session.meta.parentSession` / origin / delegationDepth
       *     ③ `ctx.agents.get(sid)?.session.header / meta`
       *     ④ 投影缓存 `record.rows.subagent.val.identity`（带 sid 缓存，只读一次）
       */
      const subagentExempt = skipEmptyTurn(sid, eventSessionMeta, eventSessionHeader)

      /* ★ 诊断（2026-10-23 第五版）：读数全部写进 `huanqi-turns.jsonl`。
       *
       * 前四版的教训：
       *   v1 `ctx.agents.get(sid)?.session.meta` → agent 拿到了，但 meta 是 undefined
       *   v2 `meta.origin` / `delegationDepth`    → 字段名错
       *   v3 `meta.parentSession`                 → 对象对了，meta 不是容器
       *   v4 加 `session.meta` 兜底               → 同上
       *   v5 `session.header.parentSession`       → ✅
       *   **每次都不是逻辑错，是「我以为它在那儿」。**
       *
       * `hasParent` 现在同时看 header 和 meta，`headerKeys` 把 header 的键打出来。
       */
      const diag = {
        policy: config.subagentPolicy,
        sessionKeys: session === undefined || session === null ? null : Object.keys(session as object),
        hasMeta: eventSessionMeta !== undefined && eventSessionMeta !== null,
        metaKeys: eventSessionMeta === undefined || eventSessionMeta === null
          ? null
          : Object.keys(eventSessionMeta as object),
        hasHeader: eventSessionHeader !== undefined && eventSessionHeader !== null,
        headerKeys: eventSessionHeader === undefined || eventSessionHeader === null
          ? null
          : Object.keys(eventSessionHeader as object),
        hasParent:
          typeof (eventSessionHeader as { parentSession?: unknown } | undefined)?.parentSession === 'string'
          || typeof (eventSessionMeta as { parentSession?: unknown } | undefined)?.parentSession === 'string',
        agentFound: verdictAgent !== undefined,
        exempt: subagentExempt,
      }

      const lastHad = lastMessageHadOutput.get(sid) === true
      const shape = lastMessageShape.get(sid) ?? '(还没有 assistant 消息)'
      const startedAt = turnStartedAt.get(sid)
      const elapsed = startedAt === undefined ? -1 : Math.round((Date.now() - startedAt) / 1000)

      // ★★ 先算判词，再落盘 —— 面板看到的必须是「当时真实的决定」，不是事后推测。
      // 三种判词对应三种完全不同的病因，混在一起就失去了信息量：
      //   skip:kind=…     → 根本没走到判据④（回合以别的方式结束）
      //   skip:had-output → 走到了，但最后一轮其实有正文，不该续
      //   continue:…      → 该续且续了（额度够）
      //   circuit-break   → 该续但额度耗尽，熔断
      const kindStr = kind === undefined ? '(none)' : String(kind)
      const kindAccepted = kind === 'completed' || kind === 'no-visible-output'
      let verdict: string
      if (subagentExempt) verdict = 'skip:subagent' + policySuffix()
      else if (!kindAccepted) verdict = 'skip:kind=' + kindStr
      else if (lastHad) verdict = 'skip:had-output'
      else if (ledger.canContinue()) verdict = 'continue:credit=' + String(ledger.credit)
      else verdict = 'circuit-break:credit=0'

      ctx.logger.warn(
        '[huanqi] turn/end kind=' + kindStr +
          ' 最后一条=[' + shape + ']' +
          ' 有产出=' + lastHad +
          ' 本轮时长=' + elapsed + 's' +
          ' → ' + verdict,
      )

      recordTurn({
        t: new Date().toISOString(),
        sid,
        kind: kindStr,
        shape,
        hadOutput: lastHad,
        elapsedSec: elapsed,
        credit: ledger.credit,
        creditMax: ledger.creditMax,
        verdict,
        /* ★ 2026-10-26（砚青落）：最近一次压缩的结果。
         *
         * ★★ 注意一个**真实的顺序限制**：判词在 recordTurn 这里就写完了，
         *   而压缩发生在它**后面**（续跑/熔断分支）。所以这里带的是
         *   「之前压过没有、压成什么了」，不是「本轮这次熔断压了什么」。
         *
         * 这不是缺陷 —— 面板要回答的是「换气到底有没有动手」，那看的是历史；
         * 而本轮熔断压缩通过 inject 的告知直接给人看。
         * 硬把两者绑在一起，反而会让判词说一个当时还没发生的事。 */
        compact: lastCompact.get(sid) ?? null,
        /* ★ 诊断（2026-10-23 第三版）：**写进 JSONL，不走 logger** ——
         *   这台 Electron 上 logger 输出看不到，前两版就死在这里。
         *   一条命令就能读出真相：
         *     Get-Content huanqi-turns.jsonl | ConvertFrom-Json |
         *       Select t,sid,verdict,diag
         *   `diag.sessionKeys` 会直接告诉我 `session` 对象上有哪些字段 ——
         *   如果连 `meta` 都不在里面，那就说明这版 DSH 的判据得彻底换（不是修）。 */
        diag,
      })

      // 只认「正常结束」这两种；error / interrupted / max-tokens 归 auto-continue 管。
      if (!kindAccepted) return

      // ★ 看的是**最后一条**消息有没有产出，不是「这一轮任何一次」。
      if (lastHad) return
      lastMessageHadOutput.delete(sid)
      lastMessageShape.delete(sid)
      turnStartedAt.delete(sid)

      const agent = ctx.agents.get(sid as never) as GuardableAgent | undefined
      if (agent === undefined) return
      /* ★★ 2026-10-23（砚青落）：这里才是**真正会出手**的地方 ——
       *   `scheduleResume`（自动再开一轮）和熔断后的 `steer` 都在下面。
       *   上面那条 `subagentExempt` 只修了判词（让面板说真话），
       *   这一道才是拦「把正在干活的子 agent 推走」的。
       *   ★ 两道都要有：只改判词不改行为＝假装修好了；只改行为不改判词＝面板继续撒谎。 */
      if (subagentExempt) return

      const strings = stringsFor(readLanguage(ctx))
      if (ledger.canContinue()) {
        const left = ledger.spendContinuation()
        if (ledger.onContinuation({ window: config.anomalyWindow, now: Date.now() })) {
          ctx.logger.warn(
            `dsh-huanqi: empty-turn continuation inside the anomaly window (${config.anomalyWindow} turns); credit penalised to ${ledger.credit}`,
          )
        }
        ledger.save(ledgerPath, warnLedger)
        ctx.logger.warn(
          `dsh-huanqi: turn ended with no visible output; continuing (credit left ${left}/${ledger.creditMax})`,
        )
        /* ══════════════════════════════════════════════════════════════
         * ★★ 2026-10-26（砚青落）：范围压缩（初步治疗）
         *
         * 为什么不在「一检测到循环就压」：单次截断是正常呼吸
         * （normalTurnThreshold: 20，一轮能截断几十次）。每次都压等于每轮都在换容器。
         * 所以**攒够 N 次才压一次**（N = regionCompactAfterCuts，默认 3）。
         *
         * ★★ 为什么包一层 async IIFE：`session/event` 的处理器是**同步**的，
         *    不能直接 `await`（TS1308）。而压缩必须 await 完才 resume ——
         *    否则压缩改 surface 会和下一轮撞车。
         *    所以：处理器**同步返回**，压缩+resume 在后台按顺序跑完。
         *    这不是偷懒，是唯一既能 await 又不阻塞宿主的写法。
         * ══════════════════════════════════════════════════════════════ */
        void (async () => {
          lastSeenSid = sid
          lastSeenAgent = agent
          const cuts = (cutCounts.get(sid) ?? 0) + 1
          cutCounts.set(sid, cuts)
          let notice = strings.continueNotice(left, ledger.creditMax, config.normalTurnThreshold)
          const cutThreshold = config.regionCompactAfterCuts
          /* ★★★ 2026-10-31：**冷却 —— 范围压缩之间至少隔 N 轮**
           *   爀曦原话：「每 N 轮内只能触发一次范围压缩」。
           *   ★ 光有截断次数不够：一轮里截断三十次会让它反复满足。 */
          const everyTurns = config.regionCompactEveryTurns
          const seqNow = turnSeq.get(sid) ?? 0
          const lastCompactAt = lastRegionCompactAt.get(sid)
          const cooledDown = everyTurns <= 0
            || lastCompactAt === undefined
            || (seqNow - lastCompactAt) >= everyTurns
          if (cutThreshold > 0 && cuts >= cutThreshold && cooledDown && !subagentExempt) {
            cutCounts.set(sid, 0) // 攒够了 —— 归零重计
            lastRegionCompactAt.set(sid, seqNow)
            /* ★ as any：`session` 不在本包声明的 Agent 面上，压缩层却必须摸它。 */
            const agentFull = ctx.agents.get(sid as never) as any
            if (agentFull !== undefined && agentFull.session !== undefined) {
              /* ★★★ 2026-10-31（砚青落·爀曦定）：**先检测，再动手。**
               *   `turn/end` 是在 append 事务里广播的 —— 处理器起的 async IIFE
               *   在第一个 await 之前仍在发布过程中，所以一调压缩就撞锁。
               *   `waitUntilQuiet` 用 `agent.whenIdle()` 拿信号，再静 3 秒。 */
              diagLog('region', '准备压缩 sid=' + sid + ' cuts=' + String(cuts)
                + ' credit=' + String(left) + '/' + String(ledger.creditMax) + ' —— 等 agent 静下来')
              const quiet = await waitUntilQuiet(agentFull)
              diagLog('region', 'agent=' + quiet.how + ' 静 '
                + String(Math.round(quiet.quietMs / 1000)) + 's → 开始压缩')
              const outcome = await compactOnce(agentFull, 'region', sid)
              diagLog('region', '压缩完成 ' + (outcome.ok
                ? 'OK kind=' + String(outcome.kind)
                : 'FAILED: ' + String(outcome.error))
                + (outcome.range === null
                  ? ''
                  : ' range=' + String(outcome.range.start) + '–' + String(outcome.range.end)))
              ctx.logger.warn('dsh-huanqi: region compaction after ' + String(cuts) + ' cuts → '
                + (outcome.ok ? 'ok' : 'failed(' + String(outcome.error) + ')')
                + (outcome.range === null
                  ? ''
                  : ' range=' + String(outcome.range.start) + '–' + String(outcome.range.end)))
              /* ★ 压缩成功 → 换成「取回指引」而不是普通续跑提示。
               *   压缩把上下文清了一大块，普通提示会让它「不知道为什么变干净了」。 */
              if (outcome.ok && config.postCompactRecallHint !== false) {
                notice = recallHint(outcome, cuts, sid)
              }
            }
          }
          scheduleResume(agent, notice, `huanqi: empty-turn continuation, credit ${left}/${ledger.creditMax}`)
        })()
        if (left <= config.warnAtCredit) {
          agent.inject(message(
            strings.creditWarning(left, ledger.creditMax, config.normalTurnThreshold),
            'notice',
            `huanqi: credit low (${left}/${ledger.creditMax})`,
          ))
        }
      } else {
        ledger.noteCircuitBreak()
        ledger.save(ledgerPath, warnLedger)
        ctx.logger.warn('dsh-huanqi: empty turn and continuation budget exhausted; circuit-breaking')
        /* ══════════════════════════════════════════════════════════════
         * ★★ 2026-10-26（砚青落）：熔断 → 全量压缩（彻底清空）
         *
         * 和范围压缩的区别不是「手段」而是「后续」：
         *   范围压缩之后**继续对话**；全量压缩之后**不再延续**。
         *
         * ★ 为什么熔断时也要压：打断只结束这一轮，那段循环已经进了历史，
         *   下一次更容易被激活。压掉它 + 留门牌 = 把污染搬走、把钥匙留下。
         *
         * ★ 告知必须写清三件事（circuitBreakNotice 里补不上，所以单独组装）：
         *   ① 做了什么（全量压缩）② 原文在哪（seq 指针）③ 不再延续。
         * 少了任何一条，用户都会以为是崩溃 —— 那可能让他直接重开，整轮工作就真丢了。
         *
         * ★ 同样包 async IIFE：处理器是同步的（见上面范围压缩那段的说明）。
         * ══════════════════════════════════════════════════════════════ */
        void (async () => {
          let fullNote: string | null = null
          let compacted = false
          let attemptedCompact = false
          let cooledDown = false
          /* ══════════════════════════════════════════════════════════════
           * ★★★ 2026-10-31（爀曦定）：**两次熔断救援之间至少隔 N 轮**
           *
           * 他原话：「每 N 轮内只能触发一次范围压缩，否则延续额度用完、
           *   触发的熔断调用全量压缩后，不会再延续会话，
           *   **我们要依靠熔断机制来终结循环**」
           *
           * ★ 为什么比「救过一次就记标记」可靠：那种写法只要召回轮产出一次
           *   （哪怕只是调了个工具）就把标记清了，于是变成 2 轮循环。
           *   换成轮次冷却，救援被钉死成「18 轮一次」。
           * ══════════════════════════════════════════════════════════════ */
          const rescueEvery = config.breakerRescueEveryTurns
          const rescueSeqNow = turnSeq.get(sid) ?? 0
          const lastRescue = lastBreakerRescueAt.get(sid)
          const canRescue = config.fullCompactOnBreaker !== false
            && !subagentExempt
            && (rescueEvery <= 0
              || lastRescue === undefined
              || (rescueSeqNow - lastRescue) >= rescueEvery)
          if (config.fullCompactOnBreaker !== false && !subagentExempt && !canRescue) {
            cooledDown = true
            diagLog('breaker', '熔断救援冷却中（距上次 '
              + String(lastRescue === undefined ? 0 : rescueSeqNow - lastRescue)
              + ' 轮 < ' + String(rescueEvery) + '）→ 不压、不续 sid=' + sid)
          }
          if (canRescue) {
            /* ★ as any：同上 —— `session` 不在本包声明的 Agent 面上。 */
            const agentFull = ctx.agents.get(sid as never) as any
            if (agentFull !== undefined && agentFull.session !== undefined) {
              attemptedCompact = true
              /* ★ 先记轮次 —— **成败都算「尝试过救援」**，失败也不该在 18 轮内反复撞。 */
              lastBreakerRescueAt.set(sid, rescueSeqNow)
              diagLog('breaker', '熔断 → 准备全量压缩 sid=' + sid
                + ' credit=0/' + String(ledger.creditMax) + ' —— 等 agent 静下来')
              const quiet = await waitUntilQuiet(agentFull)
              diagLog('breaker', 'agent=' + quiet.how + ' 静 '
                + String(Math.round(quiet.quietMs / 1000)) + 's → 开始压缩')
              const outcome = await compactOnce(agentFull, 'full', sid)
              compacted = outcome.ok
              diagLog('breaker', '全量压缩 ' + (outcome.ok
                ? 'OK kind=' + String(outcome.kind)
                : 'FAILED: ' + String(outcome.error)))
              ctx.logger.warn('dsh-huanqi: circuit break → full compaction '
                + (outcome.ok ? 'ok' : 'failed(' + String(outcome.error) + ')'))
              if (outcome.ok) {
                /* ★ 2026-10-26（砚青落）：全量压缩没有「压了哪一段」，所以给不出 seq 门牌。
                 *   但不能就此只说「seq 未算准」—— 那样它连去哪找都不知道。
                 *   至少要把**会话号**递过去，并给出可执行的检索入口。 */
                const span = outcome.range === null
                  ? '（全量压缩没有「压了哪一段」—— 会话 ' + sid +
                    '，用 `memq timeline --since <时间>` 或按关键词 `memq <词>` 取回）'
                  : 'log:' + sid + '#seq=' + String(outcome.range.start) + '–' + String(outcome.range.end)
                fullNote = [
                  '[huanqi] 思考退化熔断。',
                  '- 原因：连续 ' + String(ledger.creditMax) + ' 次续跑仍无产出，判定为退化。',
                  '- 已做：**全量压缩，上下文已清空**（不是崩溃，是换气插件主动清的）。',
                  '- 原文：' + span + '（memq open 可取回一手原文，别只看摘要）。',
                  '- 本轮**不再延续**。请确认任务状态后，再决定继续还是换容器。',
                ].join('\n')
              }
            }
          }
          agent.inject(message(fullNote === null ? strings.circuitBreakNotice(ledger.creditMax) : fullNote, 'notice', 'huanqi: circuit break (empty turn)'))
          /* ★ 压缩成功 → 按 `resumeAfterCompact` 续一轮召回。
           *   上限靠 `breakerRescueEveryTurns` 冷却，不靠一次性标记。 */
          if (compacted && config.resumeAfterCompact !== false) {
            diagLog('breaker', '压缩成功 → 注入召回提示并续一次 sid=' + sid)
            scheduleResume(agent, recallPromptText(), 'huanqi: resume once after full compaction (recall what the compression dropped)')
            return
          }
          /* ★ 冷却中 → 不压不续，只提示人手动压（熔断的默认结局是停下）。 */
          if (cooledDown) {
            diagLog('breaker', '冷却中 → 停下等人手动 /compact sid=' + sid)
            agent.inject(message([
              '[huanqi] 思考退化熔断。',
              '- 距上次全量压缩还不到 ' + String(rescueEvery) + ' 轮，**这次既不压缩也不延续**。',
              '- 请你手动输入 `/compact` 清一次，再决定是继续还是换容器。',
            ].join('\n'), 'notice', 'huanqi: breaker rescue cooled down — stop and ask the user to compact manually'))
            return
          }
          /* ★ 尝试过但失败 → 同样停下，不推模型。 */
          if (attemptedCompact && !compacted) {
            diagLog('breaker', '全量压缩失败 → 停下，只提示用户手动 /compact sid=' + sid)
            agent.inject(message([
              '[huanqi] 思考退化熔断，但**全量压缩没有成功**。',
              '- 本轮**不再延续**（不推模型，等你）。',
              '- 请你手动输入 `/compact` 做一次全量压缩，再决定是继续还是换容器。',
              '- 压缩失败的原因见 `D:\\AI\\memory\\hub\\_plugin-diag.log`。',
            ].join('\n'), 'notice', 'huanqi: full compaction FAILED — stop and ask the user to compact manually'))
            return
          }
        })()
      }
    }) as never)
  }

  // Observe every streaming model call through the `llm/stream` waterfall. This
  // is present on both dsh 0.1.2-rc.1 and 0.1.5-alpha.1 and carries the SAME
  // StreamChunk delta types, so no version branching is needed.
  ctx.on('llm/stream', (options, next): AsyncIterable<StreamChunk> => {
    // Only agent-loop-built calls carry the loop identity; skip arbitrary
    // non-agent streaming (tool streams, assistant replay, etc.).
    if (!isAgentLoopRequest(options)) return next()
    if (options.sessionId === undefined) return next()
    const agent = ctx.agents.get(options.sessionId)
    if (agent === undefined) return next()
    const detector = detectorFor(agent)

    return (async function* wrapped(): AsyncIterable<StreamChunk> {
      let reasoning = ''
      let hasOutput = false
      /* ★ 流内早杀是否对子 agent 跳过 —— 只在 `exempt` 档为 true。
       * 在流开头算一次并缓存（`skipStreamCut` 内部又有 sid 缓存），别放进每帧的 delta 分支。
       * `relaxed` 档**保留**早杀：2026-10-23 实测，它那次恰恰把一个正在推演的
       * 子 agent 推向了「写盘」，是有用的。 */
      /* ★ header 从 agent 上取（`options` 只有 sessionId）。
       * 2026-10-23 23:05 实测：真字段在 `session.header.parentSession`，不在 `meta`。 */
      const cutHeader = (agent as GuardableAgent & { session?: { header?: unknown } }).session?.header
      const subagentStreamExempt = skipStreamCut(options.sessionId, undefined, cutHeader)
      // 流内早杀是否已经掐过这一轮。掐过之后流末那条判据就不必再判 ——
      // 病是同一种（只有思考、没有产出），处理也走同一段换气代码。
      let silentCut = false
      // 早杀试过一次但被「有非文本块开着」挡回去 —— 不再重试，免得每个 delta 刷一行 warning。
      let silentCutBlocked = false
      const textBreaker = new TextRepetitionDetector(config)
      const reasoningBreaker = new ReasoningLoopBreaker(config)
      // Blocks still open, in stream order. A break has to close them itself:
      // `llm/invariant` rejects a `stop` finish while any block is open, and the
      // committed content of each block comes from the `block-end` payload.
      const open = new Map<number, { blockType: string; text: string }>()
      const openBlocks = () => [...open.entries()].map(([index, b]) => ({ index, ...b }))
      for await (const chunk of next()) {
        if (chunk.type === 'block-start') open.set(chunk.index, { blockType: chunk.blockType, text: '' })
        else if (chunk.type === 'block-end') open.delete(chunk.index)
        else if (chunk.type === 'reasoning-delta') {
          reasoning += chunk.text
          const block = open.get(chunk.index)
          if (block !== undefined) block.text += chunk.text
        } else if (chunk.type === 'text-delta') {
          hasOutput = true
          const block = open.get(chunk.index)
          if (block !== undefined) block.text += chunk.text
        } else if (chunk.type === 'tool-call-delta') hasOutput = true
        yield chunk
        // Visible-output repetition is the one failure the post-call judgement
        // above cannot reach (issue #2848: ~2825 repeats inside ONE call), so it
        // is checked per chunk and ends the stream while it is still open. The
        // returning branch skips the post-call observation: the call did not
        // finish, and its breaker already reacted.
        if (chunk.type === 'text-delta' && textBreaker.push(chunk.text)) {
          // `return` here ends the generator — this is not the C# `yield break`.
          const tail = breakStream(agent, textBreaker.repeatedChars, textBreaker.trippedBy ?? 'identical-chunks', openBlocks())
          if (tail === null) continue
          for (const c of tail) yield c
          return
        }
        // Reasoning repetition is the failure in issue #5976: the model emits
        // reasoning forever and never returns, so the step never settles and the
        // harness turn loop never breaks. This is the only detector here that
        // can end such a turn, and it must run mid-stream to do it.
        if (chunk.type === 'reasoning-delta' && reasoningBreaker.push(chunk.text)) {
          const tail = breakStream(agent, reasoningBreaker.repeatedChars, reasoningBreaker.trippedBy ?? 'reasoning-cycle', openBlocks())
          if (tail === null) continue
          for (const c of tail) yield c
          return
        }

        /* ── 流内早杀：思考够长、产出还是零 ────────────────────────────────
         * ★ 这是唯一一条**只看"有没有产出"**的流内判据。形态维度是死的 ——
         * 实测过（2026-10-11，本会话 6737 步）：短语池去重比在正常长推理里能低到
         * 0.12，和真循环的 0.13 完全重叠；句长同理。`low-entropy` 那条被删掉
         * 就是这个原因（见 `observe` 上那段标定），所以这里不再碰形态。
         *
         * ★ 为什么必须流内：真实循环能在**一次调用里**写满 5140 个字符还不停
         * （14:34:26 那一步），而流末的 `observe` 要等这一轮结束才看得见。
         * 不在这里掐，那几分钟里没有任何人能介入。
         *
         * ★ 误报可接受：被误杀的这一轮本来也没产出，换气会带着「直接做」重开一轮。
         * 漏报的代价是整条会话卡死。宁可错杀 —— 这是定这条判据时的原话。
         * ─────────────────────────────────────────────────────────────── */
        if (
          !silentCut
          && !silentCutBlocked
          && !hasOutput
          && !subagentStreamExempt
          && config.silentReasoningChars > 0
          && reasoning.length >= config.silentReasoningChars
        ) {
          const tail = finishStream(openBlocks())
          if (tail === null) {
            // 有 tool-call 块开着 → 不截断（理由同 `finishStream`：半个调用不能提交）。
            // 记一笔就不再试，免得每个 delta 都刷一行。
            silentCutBlocked = true
            ctx.logger.warn('dsh-huanqi: silent reasoning hit the cut threshold, but a non-text block is open; not truncating')
          } else {
            silentCut = true
            ctx.logger.warn(
              `dsh-huanqi: cut a silent stream at ${reasoning.length} chars (no text, no tool call; threshold ${config.silentReasoningChars})`,
            )
            // 收尾块先发出去，再 `break` 出循环 —— 不在这里 `return`，
            // 因为下面的换气段才是真正"续命"的地方，两条判据共用它。
            for (const c of tail) yield c
            break
          }
        }
      }
      // Judge the call only once its stream has ended: a call that turns out to
      // produce output after its reasoning is progress, not a thinking loop.
      const reason = detector.observe({ hasOutput, reasoning })
      if (reason !== undefined) ctx.logger.debug(`dsh-huanqi: stalled call (${reason})`)

      // ── 换气层（huanqi）─────────────────────────────────────────────────
      //
      // 它只接管一条线：**「这一轮没有产出正文」** —— 思考把输出预算烧光了、
      // 正文一个字没出，或者光在想而始终没动手。
      //
      // ★ `repeated-material`（复述上一步）**仍然归下面的常规反应**。
      // 理由：那条判据的原作者实测它有误报空间（见 `observe` 上那段标定记录），
      // 而"再给它续一轮"这个动作比"提醒它一句"贵得多 —— **不该建立在可能误报的判据上**。
      //
      // ★ 它有**两条入口**（2026-10-11 加第二条）：
      //   ① `silentCut`：流内早杀 —— 思考写到 `silentReasoningChars` 还是零产出，
      //      当场截断。**不等这一轮自己结束**，因为真实循环能在一次调用里写满 5140 字。
      //   ② 流末判定：`reasoning-only` 且连续停滞达到 `reasoningOnlySteps`（默认 1）。
      //      这条兜住"没长到阈值就自己停了"的短循环 —— 实测 1990 字那种。
      //   两条判的是**同一种病**，所以共用下面这段续命代码，只是文案不同。
      //
      // ★ 它**不消费 `fires`**：那是常规反应的预算。换气自己数 `stalled`，
      // 出手后 `reset()` 清零。两个计数器各管一段，互不侵占 ——
      // 否则一次出手同时扣两边的额度，行为就说不清了。
      //
      // ★ 出手 ≠ 一定续命：额度耗尽时这里是**熔断**（不再开新一轮）。
      // 那才是这个东西存在的理由 —— 「一旦循环了就控制不住自己，只有插件能把我拉回来」。
      if (
        config.maxContinuations > 0
        && (silentCut || (reason === 'reasoning-only' && detector.stalledRun >= config.reasoningOnlySteps))
      ) {
        // 流内早杀那条路已经在循环里 yield 过收尾块了，这里不能再发一次。
        const tail = silentCut ? [] : finishStream(openBlocks())
        if (tail === null) {
          // 有 tool-call 块开着 → 不截断（理由见 finishStream 的注释）。
          ctx.logger.warn('dsh-huanqi: output budget spent on reasoning, but a non-text block is open; not truncating')
        } else {
          detector.reset()
          const strings = stringsFor(readLanguage(ctx))
          if (ledger.canContinue()) {
            const left = ledger.spendContinuation()
            /* ★ 异常判定（2026-10-10 接线）：出正文后 `anomalyWindow` 轮之内又卡，
             * 说明"卡"不是偶然，是上下文在变脏 —— 除了这次延续本身扣的那一分，
             * 再额外扣一分。它让额度不只在"我摔了"时降，也在"脚下越来越滑"时降。 */
            if (ledger.onContinuation({ window: config.anomalyWindow, now: Date.now() })) {
              ctx.logger.warn(
                `dsh-huanqi: continuation inside the anomaly window (${config.anomalyWindow} turns); credit penalised to ${ledger.credit}`,
              )
            }
            ledger.save(ledgerPath, warnLedger)
            ctx.logger.warn(
              silentCut
                ? `dsh-huanqi: silent stream cut mid-call; continuing (credit left ${left}/${ledger.creditMax})`
                : `dsh-huanqi: output budget spent on reasoning; continuing (credit left ${left}/${ledger.creditMax})`,
            )
            // ★ 顺序要紧：先排续跑再 yield terminal（理由见 scheduleResume 的注释）。
            // 文案分两种病：流内早杀是「光在想没动手」，流末是「预算烧光了」。
            scheduleResume(
              agent,
              silentCut
                ? strings.silentCutNotice(reasoning.length, left, ledger.creditMax)
                : strings.continueNotice(left, ledger.creditMax, config.normalTurnThreshold),
              `huanqi: continuation, credit ${left}/${ledger.creditMax}`,
            )
            if (left <= config.warnAtCredit) {
              agent.inject(message(
                strings.creditWarning(left, ledger.creditMax, config.normalTurnThreshold),
                'notice',
                `huanqi: credit low (${left}/${ledger.creditMax})`,
              ))
            }
          } else {
            ledger.noteCircuitBreak()
            ledger.save(ledgerPath, warnLedger)
            ctx.logger.warn('dsh-huanqi: continuation budget exhausted; circuit-breaking this thinking run')
            // ★ 这条同时干两件事：告诉人该介入了，以及**让 assistant 消息不为空**
            // （空消息会让整条会话从那一刻起永久不可用）。
            agent.inject(message(
              strings.circuitBreakNotice(ledger.creditMax),
              'notice',
              'huanqi: circuit break',
            ))
            /* ★ 2026-10-23：同上 —— inject 给人看，steer 让它去做，且只发一次。 */
            if (!landPrompted.has(agent)) {
              landPrompted.add(agent)
              agent.steer(message(
                strings.circuitBreakNotice(ledger.creditMax),
                'notice',
                'huanqi: land your state, then ask the user to compact',
              ))
            }
          }
          for (const c of tail) yield c
          return
        }
      }

      const fire = detector.takeFire()
      if (fire !== undefined) {
        // ★ header 从 agent 上取 —— `options` 只有 sessionId，没有 header。
        const liveHeader = (agent as GuardableAgent & { session?: { header?: unknown } }).session?.header
        react(agent, fire, options.sessionId, liveHeader)
      }

      /* ── 换气：正常轮的回血 ──────────────────────────────────────────────
       * ★ 这是额度**唯一会涨**的地方。没有它，这支体温计只能单向下降 ——
       * 那不是体温计，那是倒计时。
       *
       * "正常轮"的判据：这一轮**产出了正文**（`hasOutput`，含工具调用），
       * 而且**没有触发延续** —— 走到这一行就说明没触发（触发的话上面已经 return）。
       *
       * ★ 攒够 `normalTurnThreshold` 轮才涨 1 点，并且涨不过上限。
       * 这两条都在 `onNormalTurn` 里；这里只负责"判定 + 落盘"。
       *
       * ★ 同时喂"异常窗口"的计数器（2026-10-10 补）：
       *   出正文 → `noteOutput()` 重置基准；
       *   没出正文 → `noteTurn()` 窗口 +1，下一轮再卡就可能是"刚恢复又卡"。
       *   这两个合起来才是完整的体温计 —— 只量"摔了没"不够，还要量"脚下是不是越来越滑"。
       * ──────────────────────────────────────────────────────────────────── */
      if (hasOutput) {
        ledger.noteOutput()
        if (ledger.onNormalTurn(config.normalTurnThreshold)) {
          ledger.save(ledgerPath, warnLedger)
          ctx.logger.debug(`dsh-huanqi: credit restored to ${ledger.credit}/${ledger.creditMax}`)
        }
      } else {
        ledger.noteTurn()
      }
    })()
  })

  // ★ 启动探针的「走到底」记号：只有 entered 没有 done = apply 中途抛错了。
  // 和 entered 配对，才能区分「加载了但注册失败」和「压根没加载」。
  bootLog('apply() done')
}
