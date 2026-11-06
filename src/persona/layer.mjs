// 人格层 —— 分层装载 + 预算裁剪（超了要说出来，不许静默丢）
//
// ★ 这是从 DSH 那套学到的教训：
//   旧系统 AGENTS.md 有 65536 预算，满了会「静默丢弃」，而且「最宽泛的先丢」——
//   也就是说先丢的正是最要紧的总纲。SELF.md 独立 12288 就是为了兜这个。
//
//   新系统把它做成显式规则：
//     1. 每层声明自己的预算与优先级（默认 80000B，对齐旧系统 SELF 12288 + AGENTS 65536）
//     2. 超预算时按优先级从**最可换**的开始裁
//     3. **裁剪结果写进正文** —— 模型看得见「哪层被裁了」，不假装完整

import fs from 'node:fs';
import path from 'node:path';

export const TIER = {
  CORE: 'core',      // 不变量：身份 / 硬线 / 门。永不被裁
  WORK: 'work',      // 工作约定 / 当前状态。可压
  CONTEXT: 'context',// 背景材料。最先裁
};

export class PersonaLayer {
  constructor({ budget = 80000 } = {}) {
    this.budget = budget;
    this.entries = [];   // { name, tier, text, mtime }
    this.loadedAt = 0;
  }

  /**
   * 装载一组文件。spec = [{ path, tier, name? }]
   * ★ 读不到的文件不报错，记进 missing —— 允许部分人格。
   */
  load(specs, { root = process.cwd() } = {}) {
    this.entries = [];
    const missing = [];
    for (const s of specs || []) {
      const abs = path.isAbsolute(s.path) ? s.path : path.join(root, s.path);
      try {
        const st = fs.statSync(abs);
        const text = fs.readFileSync(abs, 'utf8');
        this.entries.push({
          name: s.name || path.basename(abs),
          tier: s.tier || TIER.CONTEXT,
          text: text.trim(),
          bytes: Buffer.byteLength(text),
          mtime: st.mtimeMs,
        });
      } catch {
        missing.push(abs);
      }
    }
    this.loadedAt = Date.now();
    return { loaded: this.entries.length, missing };
  }

  /** 按 tier 分组统计 */
  stats() {
    const out = {};
    for (const e of this.entries) {
      out[e.tier] = out[e.tier] || { files: 0, bytes: 0 };
      out[e.tier].files++;
      out[e.tier].bytes += e.bytes;
    }
    return out;
  }

  /**
   * 渲染成一段文本。超预算时按 tier 从低到高裁，并把裁剪结果写在正文里。
   * ★ 返回 { text, used, budget, dropped }
   */
  render() {
    const order = { [TIER.CORE]: 0, [TIER.WORK]: 1, [TIER.CONTEXT]: 2 };
    const sorted = [...this.entries].sort((a, b) => (order[a.tier] - order[b.tier]));

    let used = 0;
    const kept = [];
    const dropped = [];

    for (const e of sorted) {
      // CORE 永不被裁 —— 即使超预算也留，因为它是身份
      if (e.tier === TIER.CORE || used + e.bytes <= this.budget) {
        kept.push(e);
        used += e.bytes;
      } else {
        dropped.push(e);
      }
    }

    const parts = [];
    let lastTier = null;
    for (const e of kept) {
      if (e.tier !== lastTier) {
        const label = e.tier === TIER.CORE ? '【不变量 · 永不裁剪】'
          : e.tier === TIER.WORK ? '【工作约定 · 可压缩】'
          : '【背景材料 · 最先裁剪】';
        parts.push('\n===== ' + label + ' =====');
        lastTier = e.tier;
      }
      parts.push('\n<!-- ' + e.name + ' · ' + e.bytes + 'B -->\n' + e.text);
    }

    let text = parts.join('\n');

    // ★ 裁剪要写在正文里，不许静默
    if (dropped.length) {
      text += '\n\n===== ⚠ 人格层裁剪记录 =====\n';
      text += '预算 ' + this.budget + 'B，已用 ' + used + 'B。以下文件因超预算被裁掉：\n';
      for (const d of dropped) text += '  · ' + d.name + '（' + d.tier + '，' + d.bytes + 'B）\n';
      text += '★ 这不是「它们不存在」—— 是这一轮没装进来。需要时用 soul_frame / 文件系统直接读。';
    }

    return { text, used, budget: this.budget, dropped: dropped.map(d => d.name) };
  }

  /** 只要某一层 */
  tier(t) { return this.entries.filter(e => e.tier === t); }
}