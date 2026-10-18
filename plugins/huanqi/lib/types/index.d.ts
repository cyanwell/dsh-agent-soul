import { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { ContextFormed } from '@deepseek-ai/dsh-llm';
/** Plugin configuration. */
export interface Config {
    /**
     * Consecutive stalled model calls before a reaction. A call is stalled when it
     * produced no text/tool output, or when it repeated most of the previous
     * call's distinct reasoning material. Default `3`.
     */
    maxThinkingSteps?: number;
    /**
     * Minimum reasoning text within one call before that call is judged at all; a
     * short burst is normal. Default `2048` chars.
     */
    minReasoningChars?: number;
    /**
     * Cross-call similarity: how much of the previous call's distinct reasoning
     * material must reappear in this call before the call counts as a repetition
     * of stalled thinking rather than progress. `1.0` requires an exact rerun of
     * the same material; `0` disables this signal. Default `0.8`.
     */
    similarityThreshold?: number;
    /**
     * Reaction to fire on a threshold crossing. `warn` injects a notice, `steer`
     * sends a steering message, `cancel` hard-aborts the turn. Default `steer`.
     */
    escalate?: 'warn' | 'steer' | 'cancel';
    /**
     * How many times one agent may be reacted to before the guard stops
     * re-firing. A single intervention often does not break a strong loop, so the
     * default allows several. Default `4`.
     */
    maxFires?: number;
    /** Cancel cause used when `escalate` is `cancel`. Default `'thinking-loop'`. */
    cancelCause?: string;
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
    maxContinuations?: number;
    /**
     * 攒够多少个「正常轮」额度 +1。上限不超过 `maxContinuations`。
     *
     * 「正常轮」= 用户发一句 → 正常思考并输出正文，全程没触发延续。
     * 默认 `20`。
     */
    normalTurnThreshold?: number;
    /**
     * 出正文之后多少轮内又触发延续，算一次「异常」（额度 −1）。
     *
     * 窗口太短会误伤正常的长思考，太长会反应迟钝。
     * 额度降到 1 时不再降，改为提示用户手动压缩上下文。默认 `10`。
     */
    anomalyWindow?: number;
    /**
     * 额度降到这个值时给一次显眼提示（GUI，不走微信 —— 那条通道要人工续命）。
     * 默认 `2`。
     */
    warnAtCredit?: number;
    /**
     * 额度账本落盘路径。留空则用 `<DSH_HOME>/state/dsh-agent-huanqi.json`。
     * ★ 落盘是必须的：不落盘的话重启一次就忘了，「每 N 轮回血」永远攒不满。默认空。
     */
    ledgerPath?: string;
    /**
     * **流内早杀**：一次调用里思考写到这么多字符、而**正文和工具调用都还是零**，就地截断。
     *
     * ★ 为什么非有它不可 —— 流末那条判据要等这一轮**结束**才看见，而真实的循环能在
     * 一次调用里写满 5140 个字符（实测：14:34:26 那一步，正文 0、工具 0）。
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
    silentReasoningChars?: number;
    /**
     * 流末那条判据要**连续**几次「只有思考、没有产出」才出手。默认 `1`。
     *
     * ★ 它和 `maxThinkingSteps`（常规反应的门槛，默认 3）是**两个计数器**，
     * 这一条只管换气层，互不侵占。
     *
     * ★ 分家的理由：常规反应是「提醒一句」，错了代价小、可以等；换气是
     * 「截断 + 重开一轮」，而它要抓的那个现象**一次就足够卡死整条会话**。
     *
     * ★ 定 `1` 的依据（实测 6737 步）：`reasoning-only` 全史只出现
     * 4 次，**4 次全是循环事件**，正常步一次都没有 —— 误报率约等于零。
     * 而门槛停在 3，意味着**要连卡三次才有人管**；真实情况是第一次就没人管了：
     * 14:34 那一步卡死之后，是是使用者手动出声把它捞回来的，插件全程没动。
     */
    reasoningOnlySteps?: number;
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
    maxRepeatedText?: number;
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
    maxRepeatedCycleChars?: number;
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
    minRepeatedCycleChars?: number;
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
    maxRepeatedReasoningCycleChars?: number;
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
    minRepeatedReasoningCycleChars?: number;
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
    maxRepeatedReasoningLineChars?: number;
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
    minRepeatedReasoningLineCoverage?: number;
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
    minRepeatedReasoningLineConcentration?: number;
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
    maxRepeatedTextLineChars?: number;
    /**
     * Share of counted visible-output characters that must sit in repeated lines
     * before the phrase-pool rule fires. Default `0.6`, matching the reasoning side.
     */
    minRepeatedTextLineCoverage?: number;
    /**
     * Average sightings per distinct line required of the visible output. Default
     * `4`, matching the reasoning side — see
     * {@link Config.minRepeatedReasoningLineConcentration} for why coverage alone is
     * not enough.
     */
    minRepeatedTextLineConcentration?: number;
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
    breakCode?: string;
    /**
     * Steer the agent after a mid-stream break so the resumed turn is told what
     * happened instead of silently continuing. Default `true`.
     */
    breakCorrection?: boolean;
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
    resumeAfterBreak?: boolean;
}
/** Resolved config: every field carries its validated default. */
type ResolvedConfig = Required<Config>;
export declare const Config: z<Config>;
export declare const name = "huanqi";
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
export declare const inject: string[];
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
            kind: 'loop-guard';
        } & ContextFormed;
    }
}
/** Fixed window used for both the intra-call and cross-call measures. */
export declare const GRAM_SIZE = 4;
/**
 * Which detector ended a call, for the log line, the notice noun and tests.
 *
 * `identical-chunks` and `repeating-cycle` watch visible output;
 * `reasoning-cycle` and `reasoning-lines` watch reasoning under the two
 * complementary rules described on {@link ReasoningLoopBreaker}.
 */
export type BreakRule = 'identical-chunks' | 'repeating-cycle' | 'reasoning-cycle' | 'reasoning-lines' | 'text-lines';
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
export declare function grams(text: string, size?: number): Set<string>;
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
export declare function repeatRatio(reasoning: string): number;
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
export declare function containment(a: ReadonlySet<string>, b: ReadonlySet<string>): number;
/** What one completed model call looked like to the guard. */
export interface StepObservation {
    /** Whether the call emitted any `text-delta` or `tool-call-delta`. */
    readonly hasOutput: boolean;
    /** The call's total reasoning text. */
    readonly reasoning: string;
}
/**
 * Why one call was counted as stalled (`undefined` = it was progress).
 *
 * Both reasons are structural: no output at all, or the previous call's material
 * restated. There is deliberately no "low-entropy" member — see
 * {@link LoopDetector.observe} for the measurement that removed it.
 */
export type StallReason = 'reasoning-only' | 'repeated-material';
/**
 * The per-agent detector: accumulates stalled calls and decides when to react.
 *
 * Kept free of Cordis types so the decision rule is unit-testable without a
 * harness: the plugin only feeds it observations and applies the reaction.
 */
/** 账本里记着什么。将来要落盘时，这个形状就是落盘的形状。 */
export interface LedgerState {
    /** 当前额度。`0` 表示不允许延续。 */
    credit: number;
    /** 额度上限（用户设置的那个数）。★ 它是天花板，不是充值。 */
    creditMax: number;
    /** 距离下一次回血还差几个正常轮。 */
    normalTurns: number;
    /**
     * 距离上一次"真的输出了正文"过了几次流。
     *
     * ★ 这一个字段就是"异常扣分"的判据本体：出正文说明这一轮通顺，
     * **紧接着又卡**说明"卡"不是偶然，是上下文在变脏。
     *
     * `undefined` = 这个账本还从没见过一次正文输出 —— 那时**不判异常**，
     * 因为没有可比对的基准。（第一次就卡不算"刚恢复又卡"。）
     */
    turnsSinceOutput?: number;
    /** 上次"异常"的时间戳（毫秒）。没有过就是 `undefined`。 */
    lastAnomalyAt?: number;
    /** 累计统计，只增不减，用于复盘。 */
    stats: {
        continuations: number;
        circuitBreaks: number;
        anomalies: number;
    };
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
 *    要涨得靠正常对话攒。（设计取舍：「上限是天花板，不是充值。」）
 * 2. **上限调低要压。** 额度高于新上限时立刻压到新上限。
 * 3. **额度最低 1。** 到 1 就不再降 —— 继续降等于彻底关掉这个功能，
 *    而那时恰恰最需要它把问题摆到用户面前。
 *
 * ## 全局，不按会话
 *
 * 额度是**跨会话共享**的（设计取舍：分会话管理会很麻烦）。
 * 所以一个会话把额度耗光，会影响其他会话 —— 这是有意的：
 * **上下文变脏通常是全局性的**（同一台机器、同一批模型、同样的用法）。
 */
export declare class CreditLedger {
    private readonly max;
    private state;
    /**
     * @param max - 额度上限（来自配置）。
     */
    constructor(max: number);
    /** 当前额度。 */
    get credit(): number;
    /** 上限。 */
    get creditMax(): number;
    /** 攒到哪一步了（离回血还差几轮）。 */
    get normalTurns(): number;
    /**
     * 距离上一次真的输出正文，过了几轮。
     *
     * `undefined` = 这个账本还从没见过一次正文输出 —— 那时**不判异常**（没有基准）。
     */
    get turnsSinceOutput(): number | undefined;
    /** 累计统计（只增不减，复盘用）。 */
    get stats(): Readonly<LedgerState['stats']>;
    /** 只读快照，给日志和界面用。 */
    snapshot(): Readonly<LedgerState>;
    /** 还能不能延续。 */
    canContinue(): boolean;
    /**
     * 用掉一次延续机会。
     *
     * @returns 用掉之后还剩多少；已经是 0 就返回 0（调用方应该已经查过 `canContinue`）。
     */
    spendContinuation(): number;
    /** 记一次熔断（额度耗尽、不再开新一轮）。 */
    noteCircuitBreak(): void;
    /**
     * 一个"正常轮"结束了：用户发了一句 → 正常思考并输出正文，全程没触发延续。
     *
     * @param threshold - 攒够多少轮涨一点额度。
     * @returns 这一次是否涨了额度。
     */
    onNormalTurn(threshold: number): boolean;
    /**
     * 这一轮流真的输出了正文 —— 重置"距上次出正文"的计数。
     *
     * ★ 它是异常判据的锚点：只有见过一次正文，后面的"又卡了"才有可比对的基准。
     */
    noteOutput(): void;
    /**
     * 这一轮流结束，但没有正文输出（或者还没轮到判）。
     *
     * ★ 刻意在 `undefined` 时不动 —— 它表示"这个账本从没见过一次正文"，
     * 那时不该开始计数，否则"会话刚开始就卡"会被误判成"刚恢复又卡"。
     */
    noteTurn(): void;
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
        window: number;
        now: number;
    }): boolean;
    /**
     * 记一次异常并扣额度。
     *
     * @returns 扣完之后的额度。
     */
    penalise(now: number): number;
    /** 上限变了（用户在设置里改的）。规则见类注释：调高不充值，调低要压。 */
    reconcileMax(next: number): void;
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
    load(path: string, onWarn: (msg: string) => void): boolean;
    /**
     * 把额度写回盘。
     *
     * ★ 同样是"失败只报告、绝不抛"。写盘发生在延续/回血这些低频时刻，
     * 不是每次流式调用，所以同步写不会卡；而**宁可丢一次记账，也不能让守卫本身成为故障**。
     *
     * @param path - 账本路径。空字符串 = 不落盘（用户没配也没默认值时）。
     * @param onWarn - 出问题时的报告口。
     */
    save(path: string, onWarn: (msg: string) => void): void;
    /**
     * 账本的默认路径：`<DSH_HOME>/state/dsh-agent-huanqi.json`。
     *
     * 为什么要走环境变量而不是硬编码：`DSH_HOME` 是 DSH 自己给每个子进程的，
     * 换一台机器、换一次安装位置都自动跟着走。取不到才退回相对路径。
     */
    static defaultPath(): string;
}
export declare class LoopDetector {
    private readonly config;
    private stalled;
    private fires;
    private previous;
    private lastReason;
    /**
     * @param config - the resolved plugin configuration.
     */
    constructor(config: ResolvedConfig);
    /** The stalled-run length that would trigger the next reaction. */
    get threshold(): number;
    /** How many reactions have fired for this agent so far. */
    get fired(): number;
    /**
     * 当前连续停滞了几次（没被 `takeFire` 或 `reset` 清零之前）。
     *
     * ★ 这是给**换气层**用的：它不消费 `fires`（那是常规反应的预算），
     * 而是自己数"连着几次只有推理、没有正文"。两个计数器各管一段，互不侵占 ——
     * 否则一次出手会同时扣掉两边的额度，行为就说不清了。
     */
    get stalledRun(): number;
    /** 上一次停滞的形态；`undefined` 表示没有正在累积的停滞。 */
    get lastStallReason(): StallReason | undefined;
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
    observe(step: StepObservation): StallReason | undefined;
    /**
     * Whether a reaction is due now, consuming one fire when it is.
     *
     * A single intervention often does not break a strong loop, so a fire resets
     * the run counter (another full run of stalled calls is needed) and is capped
     * by `maxFires` so the guard cannot intervene forever.
     *
     * @returns the reason to report in the reaction, or `undefined` when no reaction is due.
     */
    takeFire(): StallReason | undefined;
    /** Forget every observation (used when a loop is judged broken by real output). */
    reset(): void;
}
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
export declare function countRepeatedText(texts: readonly string[]): number;
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
export declare function trailingCycle(text: string, maxPeriod: number, minSpan: number): number;
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
export declare function periodicTailSpan(text: string, maxPeriod: number, minSpan: number): number;
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
export declare class ReasoningLoopBreaker {
    private readonly config;
    private broken;
    private chars;
    private reasoning;
    private lastCycleCheck;
    private trippedRule;
    /** The phrase-pool accumulator for the `reasoning-lines` rule. */
    private readonly pool;
    /** Repetition size recorded by whichever rule tripped. */
    private repeated;
    /**
     * @param config - the resolved plugin configuration.
     */
    constructor(config: ResolvedConfig);
    /** Whether the breaker has already fired for this call. */
    get tripped(): boolean;
    /** Which rule fired, for the log line and for tests. */
    get trippedBy(): 'reasoning-cycle' | 'reasoning-lines' | undefined;
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
    get repeatedChars(): number;
    /** Reasoning characters observed so far in this call (the call's total length). */
    get emittedChars(): number;
    /**
     * Observe one `reasoning-delta` payload.
     *
     * @param text - the delta's text.
     * @returns `true` exactly once, on the delta that trips a rule.
     */
    push(text: string): boolean;
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
    private pushLines;
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
export declare class TextRepetitionDetector {
    private readonly config;
    private texts;
    private broken;
    private visible;
    private lastCycleCheck;
    private reason;
    /** Repetition size recorded by whichever rule tripped. */
    private repeated;
    /** The phrase-pool accumulator for the `text-lines` rule. */
    private readonly pool;
    /**
     * @param config - the resolved plugin configuration.
     */
    constructor(config: ResolvedConfig);
    /** Whether the breaker has already fired for this call. */
    get tripped(): boolean;
    /** Which rule fired, for the log line and for tests. */
    get trippedBy(): 'identical-chunks' | 'repeating-cycle' | 'text-lines' | undefined;
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
    get repeatedChars(): number;
    /** How many characters the call had emitted when the breaker tripped. */
    private chars;
    /** Visible-output characters observed so far in this call. */
    get emittedChars(): number;
    /**
     * Observe one `text-delta` payload.
     *
     * @param text - the delta's text.
     * @returns `true` exactly once, on the delta that completes the run.
     */
    push(text: string): boolean;
}
/**
 * Install the listener. Per-`Agent` state is keyed in a `WeakMap` so a disposed
 * agent is collected; detectors are scoped to one agent lifecycle.
 */
export declare function apply(ctx: Context, config: ResolvedConfig): void;
export {};
