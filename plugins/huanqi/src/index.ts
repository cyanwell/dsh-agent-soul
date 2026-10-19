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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, AgentCancelCause } from '@deepseek-ai/dsh-agent'
import { createUserMessage, isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
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
  maxContinuations: z.number().step(1).min(0).max(10).default(4),
  normalTurnThreshold: z.number().step(1).min(5).max(100).default(20),
  anomalyWindow: z.number().step(1).min(3).max(50).default(10),
  warnAtCredit: z.number().step(1).min(1).max(10).default(2),
  ledgerPath: z.string().default(''),
  silentReasoningChars: z.number().step(1).min(0).default(3000),
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
   * 换一台机器、换一次安装位置都自动跟着走。取不到才退回相对路径。
   */
  static defaultPath(): string {
    const home = process.env.DSH_HOME
    return home !== undefined && home !== ''
      ? join(home, 'state', 'dsh-huanqi.json')
      : join('.', 'dsh-huanqi.json')
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
    `[huanqi] Thinking circuit-broken: ${max} continuations in a row produced no text, `
    + 'so no further turn will be started. Save your progress and compact the context manually.',
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
  circuitBreakNotice: (max) =>
    `〔换气〕本场思考已熔断：连续 ${max} 次延续都没有产出正文，不再开新一轮。`
    + '请对砚青说「保存当前进度，做好手动压缩」，然后开一条新会话继续。',
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
    return home !== undefined && home !== '' ? join(home, 'state') : '.'
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
  const turnsFile = join(stateDir, 'huanqi-turns.jsonl')
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

  function react(agent: GuardableAgent, reason: StallReason): void {
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

    ctx.on('session/event', ((session: { id?: string } | undefined, event: { type?: string; data?: unknown } | undefined): void => {
      const sid = session === undefined || session === null ? undefined : session.id
      if (typeof sid !== 'string') return
      const type = event === undefined ? undefined : event.type
      if (type === 'turn/start') {
        lastMessageHadOutput.set(sid, false)
        // ★ 诊断：记下本轮开始时间（用来算「卡了多久」）
        turnStartedAt.set(sid, Date.now())
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
      if (!kindAccepted) verdict = 'skip:kind=' + kindStr
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
        scheduleResume(
          agent,
          strings.continueNotice(left, ledger.creditMax, config.normalTurnThreshold),
          `huanqi: empty-turn continuation, credit ${left}/${ledger.creditMax}`,
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
        ctx.logger.warn('dsh-huanqi: empty turn and continuation budget exhausted; circuit-breaking')
        agent.inject(message(
          strings.circuitBreakNotice(ledger.creditMax),
          'notice',
          'huanqi: circuit break (empty turn)',
        ))
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
          }
          for (const c of tail) yield c
          return
        }
      }

      const fire = detector.takeFire()
      if (fire !== undefined) react(agent, fire)

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
