// 自我层（SELF）— 从 dsh-yanqing-memory 移植进 v4。
//
// ★★ 为什么要移植（爀曦 2026-11-17）：
//   「self 层每轮注入依靠一个插件叫 yanqing-memory，这个东西也很重要，也要搬进 v4，
//     它实现 self 层注入上下文。」
//   它在 DSH 侧是一个 Cordis 插件（挂 ctx.systemPrompt.context）；v4 是独立服务，
//   没有 Cordis —— 所以**搬的是算法与口径，不是那段宿主代码**。
//
// ★★ 搬过来要保住的三件事（这三件才是那个插件存在的理由）：
//   ① **变量 / 不变量拆开**（2026-11-09 的精细化改动）：
//      SELF.md 在 '## 活体（自动装配）' 处切成两段 ——
//        骨架段：**每轮不变**，所以它落在提示的前缀里，prefix cache 能命中，几乎不要钱；
//        活体段：时钟 / 距上次多久 / 本容器 / 未结，每轮变 —— 只让它变，别把骨架也拖下水。
//      旧写法是整篇 SELF.md 每轮重发一次，等于**每轮都为不变的字节付一次钱**。
//   ② **时钟降频**：默认按分钟粒度取整（clockGranularityMs=60000）。
//      秒级变化对「我在哪一刻」没有意义，却会让整段缓存失效。
//   ③ **读不到不许炸**：SELF 缺失 / 超预算 / 读盘失败，都只影响这一段，绝不影响对话本身。

import fs from 'node:fs';

/** SELF.md 里「活体」段的起始标记 —— 与 dsh-yanqing-memory 同一个口径，不许改。 */
export const LIVE_MARKER = '## 活体（自动装配）';

/** 默认参数。数值沿用插件实测值。 */
export const DEFAULTS = Object.freeze({
  selfPath: null,           // 由调用方给（v4 里来自 config）
  maxBytes: 12288,          // 骨架段预算（插件实测值：SELF 预算是 12288 B）
  clockGranularityMs: 60000,
  includeLive: true,
});

/**
 * 把 SELF.md 切成「静态骨架」与「活体」两段。
 * ★ 没有标记就整篇当骨架 —— **宁多进一次前缀，不许丢内容**。
 * ★ 只切片，不 trim、不改写：骨架的字节必须原样，否则 prefix cache 白算。
 */
export function splitSelf(text) {
  const raw = String(text || '');
  const i = raw.indexOf(LIVE_MARKER);
  if (i < 0) return { skeleton: raw, live: '' };
  return { skeleton: raw.slice(0, i), live: raw.slice(i) };
}

/** 从活体段里抠「未结 N 条」（抠不到就 null，绝不猜）。 */
export function readUnclosed(live) {
  const m = /未结\s*(\d+)\s*条/.exec(String(live || ''));
  return m ? Number(m[1]) : null;
}

/** 切到「UTF-8 字节数 <= max」的最长前缀（不切半个字）。 */
export function truncateToBytes(s, max) {
  if (Buffer.byteLength(s, 'utf8') <= max) return s;
  let out = s;
  while (out.length > 0 && Buffer.byteLength(out, 'utf8') > max) {
    out = out.slice(0, Math.floor(out.length * 0.9));
  }
  return out;
}

/** 按粒度取整的时钟字符串（默认分钟）。 */
export function stampAt(d, granMs) {
  const t = d instanceof Date ? d : new Date();
  const gran = Math.max(1000, Number(granMs) || 60000);
  const bucket = Math.floor(t.getTime() / gran) * gran;
  const b = new Date(bucket);
  const p2 = (n) => String(n).padStart(2, '0');
  const ymd = b.getFullYear() + '-' + p2(b.getMonth() + 1) + '-' + p2(b.getDate());
  const hm = p2(b.getHours()) + ':' + p2(b.getMinutes());
  if (gran < 60000) return ymd + ' ' + hm + ':' + p2(b.getSeconds());
  return ymd + ' ' + hm;
}

/**
 * 自我层装配器。
 * @param {{selfPath:string, maxBytes?:number, clockGranularityMs?:number, log?:Function}} opts
 */
export function createSelfLayer(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  // mtime 缓存：不是每轮读盘，也不是永久缓存（自检改完 SELF 立刻生效）
  let cache = { mtimeMs: -1, text: '' };

  function readSelf() {
    if (!cfg.selfPath) return '';
    try {
      const st = fs.statSync(cfg.selfPath);
      if (st.mtimeMs !== cache.mtimeMs) {
        cache = { mtimeMs: st.mtimeMs, text: fs.readFileSync(cfg.selfPath, 'utf8') };
      }
      return cache.text;
    } catch {
      cache = { mtimeMs: -1, text: '' };
      return '';
    }
  }

  /** 骨架段（前缀用，每轮不变）。 */
  function skeletonText() {
    if (!cfg.selfPath) return '';
    const self = readSelf();
    if (!self) {
      return '【自我层】★ 读不到 ' + cfg.selfPath + ' —— 自我层缺席，不是「没有自我」，是文件不在。';
    }
    let out = splitSelf(self).skeleton;
    const bytes = Buffer.byteLength(out, 'utf8');
    if (bytes > cfg.maxBytes) {
      const cut = truncateToBytes(out, cfg.maxBytes);
      const kept = Buffer.byteLength(cut, 'utf8');
      if (kept < bytes) {
        out = cut + '\n【自我层】★ 超预算 ' + bytes + ' B > ' + cfg.maxBytes + ' B，已截断到 ' + kept + ' B —— 这是故障，去精简 SELF.src.md。';
      }
    }
    return out;
  }

  /** 活体段（每轮变，但只让它变）。 */
  function liveText(env = {}) {
    if (!cfg.includeLive) return '';
    const self = readSelf();
    const live = self ? splitSelf(self).live : '';
    // 活体原文里可能有 self.mjs 写好的动态内容；这里只补 v4 自己知道的几行。
    const lines = [];
    lines.push('【此刻】' + stampAt(env.at, cfg.clockGranularityMs));
    if (env.sessionId) lines.push('【本容器】' + String(env.sessionId));
    if (Number.isFinite(env.gapMinutes)) lines.push('【距上次记下的回合】' + env.gapMinutes + ' 分钟');
    if (env.lastNote) lines.push('【上次记下的事】' + String(env.lastNote).slice(0, 200));
    if (live) lines.push(live.trimEnd());
    return lines.join('\n');
  }

  /** 每轮拼一次：骨架在前（稳定），活体在后（变化）。 */
  function render(env = {}) {
    const parts = [];
    try { const s = skeletonText(); if (s) parts.push(s); } catch (e) { parts.push('【自我层】★ 骨架装配失败：' + String((e && e.message) || e).slice(0, 120)); }
    try { const l = liveText(env); if (l) parts.push(l); } catch (e) { parts.push('【自我层】★ 活体装配失败：' + String((e && e.message) || e).slice(0, 120)); }
    return parts.join('\n\n');
  }

  return { render, skeletonText, liveText, readSelf, split: () => splitSelf(readSelf()), cfg };
}
