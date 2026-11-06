// huanqi（换气）—— 思考预算管理器的核心算法
//
// ★ 从 dsh-agent-soul/plugins/huanqi 迁来。**只搬纯函数**：
//   原包 4513 行里，跟宿主打交道的只有 19 行（两个事件 + 一次反查）。
//   真正的价值在这几个算法里，它们跟宿主无关。
//
// ★ 两条从原代码注释里原样保留的教训（都是踩出来的）：
//
//   ① **repeatRatio 不是循环检测器。**
//      它的值随长度上升 —— 自然语言的 4-gram 会饱和。
//      一份不重复的英文文档：2048 字符时 0.290，20000 字符时 0.629。
//      本仓库自己的 README 是 0.54-0.65，**高于曾经用的 0.5 阈值**。
//      而真正的周期循环是 0.994-0.999。
//      → **它区分的是「长」和「短」，不是「卡住」和「在干活」。**
//      所以它只留作诊断量，不参与判定。
//
//   ② **trailingCycle 用「精确重复」而不是「比值」。**
//      40 行 markdown 表格 / 生成的 CSS / JSON dump / 60 行日志，
//      在覆盖度度量上得 0.72-0.84，但周期精确为 0。
//      → 比值规则要把它们和循环分开只差 0.06；精确重复能一分到底。

const GRAM_SIZE = 4;

/** 一个文本的定长窗口集合。短于 size 返回空集。 */
export function grams(text, size) {
  const n = size || GRAM_SIZE;
  const out = new Set();
  for (let i = 0; i + n <= text.length; i++) out.add(text.slice(i, i + n));
  return out;
}

/**
 * 低熵比值 —— 【诊断量，不是判据】。
 * 见文件头的教训①：它区分长短，不区分卡住。
 */
export function repeatRatio(reasoning) {
  if (reasoning.length < 16) return 0;
  const k = Math.min(GRAM_SIZE, Math.max(2, Math.floor(reasoning.length / 16)));
  let repeated = 0;
  let total = 0;
  const seen = new Set();
  for (let i = 0; i + k <= reasoning.length; i++) {
    const g = reasoning.slice(i, i + k);
    total++;
    if (seen.has(g)) repeated++;
    else seen.add(g);
  }
  return total === 0 ? 0 : repeated / total;
}

/**
 * 包含度：较小集合里有多大比例出现在较大集合中。
 * ★ 用包含度不用 Jaccard：卡住的模型通常是把上一步的材料重述再补一句，
 *   新集合近似是旧集合的超集。Jaccard 会被新内容稀释，看起来像在推进；
 *   包含度直接报出重复。
 */
export function containment(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const g of small) if (large.has(g)) shared++;
  return shared / small.size;
}

/** 尾部相同 delta 的连击数（最后一个元素连续出现几次）。 */
export function countRepeatedText(texts) {
  const last = texts[texts.length - 1];
  if (last === undefined) return 0;
  const normalized = String(last).trim();
  let run = 0;
  for (let i = texts.length - 1; i >= 0; i--) {
    if (String(texts[i]).trim() !== normalized) break;
    run++;
  }
  return run;
}

/**
 * 尾部周期跨度 —— 判定用。
 * 从「同一个 delta 出现两次」推广到「同一段循环输出几百字符」，且不依赖换行：
 * 周期以字符计，所以一个从不换行的 bleed 和一行一个 delta 的 bleed 判得一样。
 *
 * 两道保护让它避开正常输出：
 *  · **精确性** —— 整段必须逐字重复，近似重复算 0。
 *  · **周期至少含两个不同字符** —— `====` 或 `----` 是合法的分隔线，
 *    单字符周期会把每一行长横线都标红。
 *
 * 满足最小跨度即停（调用方只区分「零」和「非零」），所以返回值是下界。
 */
export function trailingCycle(text, maxPeriod, minSpan) {
  if (!maxPeriod || maxPeriod < 1) return 0;
  for (let period = 1; period <= maxPeriod; period++) {
    const template = text.slice(text.length - period);
    if (new Set(template).size < 2) continue;
    const need = Math.max(minSpan, 2 * period) - period;
    const limit = Math.min(text.length - period, need);
    let matched = 0;
    while (matched < limit && text[text.length - period - 1 - matched] === text[text.length - 1 - matched]) matched++;
    if (matched >= need) return matched + period;
  }
  return 0;
}

/**
 * 尾部周期的**真实**跨度（trailingCycle 返回的是下界）。
 * 判定时用 trailingCycle（快），要告诉模型「你转了多久」时用这个（准，O(尾长)）。
 */
export function periodicTailSpan(text, maxPeriod, minSpan) {
  if (!maxPeriod || maxPeriod < 1) return 0;
  for (let period = 1; period <= maxPeriod; period++) {
    const template = text.slice(text.length - period);
    if (new Set(template).size < 2) continue;
    const need = Math.max(minSpan, 2 * period) - period;
    const limit = text.length - period;
    let matched = 0;
    while (matched < limit && text[text.length - period - 1 - matched] === text[text.length - 1 - matched]) matched++;
    if (matched >= need) return matched + period;
  }
  return 0;
}

/** 停滞原因。两个都是结构性的：完全没输出，或者重述了上一次的材料。 */
export const STALL = { REASONING_ONLY: 'reasoning-only', REPEATED_MATERIAL: 'repeated-material' };

/**
 * 换气判定器 —— 逐个调用喂观察，它判「这一步是不是白烧了」。
 * ★ 不依赖任何宿主类型，可以单测。
 */
export class HuanqiDetector {
  constructor(opts) {
    const o = opts || {};
    this.containmentMin = o.containmentMin == null ? 0.85 : o.containmentMin;
    this.stallThreshold = o.stallThreshold == null ? 2 : o.stallThreshold;
    this.cycleMaxPeriod = o.cycleMaxPeriod == null ? 512 : o.cycleMaxPeriod;
    this.cycleMinSpan = o.cycleMinSpan == null ? 512 : o.cycleMinSpan;
    this.lastGrams = null;
    this.stalled = 0;
    this.history = [];
  }

  /**
   * 观察一次调用。
   * @param o { hasOutput: bool, reasoning: string }
   * @returns { stalled, reason, repeatedSpan }
   */
  observe(o) {
    const hasOutput = Boolean(o && o.hasOutput);
    const reasoning = String((o && o.reasoning) || '');
    let reason;

    if (!hasOutput && reasoning.length > 0) {
      reason = STALL.REASONING_ONLY;
    } else if (reasoning.length > 0 && this.lastGrams) {
      const g = grams(reasoning);
      if (g.size > 0 && containment(this.lastGrams, g) >= this.containmentMin) {
        reason = STALL.REPEATED_MATERIAL;
      } else {
        this.lastGrams = g;
      }
    } else if (reasoning.length > 0) {
      this.lastGrams = grams(reasoning);
    }

    if (reason) this.stalled++;
    else this.stalled = 0;

    const span = reason ? periodicTailSpan(reasoning, this.cycleMaxPeriod, this.cycleMinSpan) : 0;
    const rec = { at: Date.now(), hasOutput, reasoningChars: reasoning.length, stalled: Boolean(reason), reason: reason || null, repeatedSpan: span };
    this.history.push(rec);
    if (this.history.length > 200) this.history.shift();

    return { stalled: Boolean(reason), reason: reason || null, repeatedSpan: span, consecutive: this.stalled };
  }

  /** 额度用完没有 */
  shouldBreak() { return this.stalled >= this.stallThreshold; }
  reset() { this.stalled = 0; this.lastGrams = null; }
  stats() { return { stalled: this.stalled, threshold: this.stallThreshold, observed: this.history.length }; }
}