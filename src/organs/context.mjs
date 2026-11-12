import fsMod from 'node:fs';
import pathMod from 'node:path';

// 上下文器官 —— 时间 + 水位
//
// ★ 从老 clock（1,023 行）和 dsh-yanqing-memory 的推送层（334 行）各搬一半。
//
// ★★ 老 clock 那里有个判断要先说清：**它整个是浏览器侧栏组件**，
//    宿主半 `index.js` 只有 21 行、且 `apply(){}` 是空的 ——
//    「这个插件没有宿主侧能力：时钟完全在浏览器里用 new Date() 算」。
//    所以那份代码对我们是**零价值**（我们有 5 槽位壳，不是 DSH 侧栏）。
//    真正值钱的是它的**判断**：我该知道自己现在是什么时候、刚才隔了多久。
//
// ★ 水位那一半来自 memory 的推送层。那段注释值得整段保留：
//    「ACP 已经不存在了，那三段提示换了个地方住 …… 压缩只在兜底那一刻才发生，
//      一路上没有任何提示。」
//    水位是**安全网**，不是考核。这句话原样搬过来。

/**
 * 粗估 token 数。
 *
 * ★ **宁可估高，不许估低** —— 它是安全网。估低 = 以为还有余地，实际快满了。
 * ★ 中文按 1 字 1 token（偏保守，实际通常 0.6–0.9），
 *   ASCII 按 4 字符 1 token（标准的粗算法）。
 */
export function estimateTokens(text) {
  const s = String(text || '');
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    const p = ch.codePointAt(0);
    if (p >= 0x4e00 && p <= 0x9fff) cjk++;
    else if (p >= 0x3000 && p <= 0x303f) cjk++;   // 中文标点（、。「」）
    else if (p >= 0xff00 && p <= 0xffef) cjk++;   // ★ 全角区：，！？：；（）等她最常见的那几个
    //   ★ 这一行是补的：第一版只认 U+3000 段，于是「，！？」（U+FF0C / U+FF01 / U+FF1F）
    //     全被当成 ASCII 按 4 折算 —— **低估**。
    //     而注释里写的是「宁可估高，不许估低」，估低正好是危险方向：以为还有余地，实际快满了。
    else other++;
  }
  return cjk + Math.ceil(other / 4);
}

/** 星期几（中文） */
export const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

/**
 * 当前时间的一句话。
 *
 * ★ 为什么它重要：我不知道「现在」的时候，会把「他说过的话」当成「此刻的状态」。
 *   老 clock 的 README 里那句「时钟完全在浏览器里算」的意思就是这个 ——
 *   **模型自己没有时钟**，得有人告诉它。
 */
export function nowText(d) {
  const t = d || new Date();
  const pad = (n) => (n < 10 ? '0' + n : String(n));
  return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate()) +
    ' ' + pad(t.getHours()) + ':' + pad(t.getMinutes()) +
    '（星期' + WEEK[t.getDay()] + '）';
}

/** 距上次多久，说人话 */
export function idleText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  // ★ 用整秒判断「刚刚」，不用四舍五入的分钟数 ——
  //   Math.round(0.5) = 1，于是「刚刚」这一档永远触发不到（第一版就是这么写的）。
  if (ms < 60000) return '刚刚';
  const min = Math.round(ms / 60000);
  if (min < 60) return min + ' 分钟前';
  const h = Math.floor(min / 60);
  const rem = min % 60;
  if (h < 24) return h + ' 小时' + (rem ? ' ' + rem + ' 分钟' : '') + '前';
  return Math.floor(h / 24) + ' 天前';
}

/** 水位三档。★ 数字和原项目一一对齐，不另定一套。 */
export const WATERMARK = { warn: 0.45, alert: 0.60, emergency: 0.80 };

/**
 * 判一档水位。返回 null 表示「不用提示」。
 *
 * ★★ 老版 2026-10-25 的一个改动值得抄下来：
 *   「原来主位是『【水位】69%（724K / 1049K）』，读起来是『你已经用掉三分之二』。」
 *   改之后**主位让给余量** —— 剩下的有多少，比用掉了多少有用。
 */
export function watermarkOf(used, window, opts) {
  const o = opts || {};
  const w = Number.isFinite(window) && window > 0 ? window : 1048576;
  const u = Number.isFinite(used) ? Math.max(0, used) : 0;
  if (!u) return null;
  const pct = u / w;
  const left = Math.max(0, w - u);
  const pctText = (pct * 100).toFixed(1) + '%';
  const fmt = (n) => (n >= 1024 ? Math.round(n / 1024) + 'K' : String(n));

  let mark = '';
  let level = 'ok';
  if (pct >= (o.emergency || WATERMARK.emergency)) { mark = ' ★★★'; level = 'emergency'; }
  else if (pct >= (o.alert || WATERMARK.alert)) { mark = ' ★★'; level = 'alert'; }
  else if (pct >= (o.warn || WATERMARK.warn)) { mark = ' ⚠'; level = 'warn'; }
  else return null;

  return {
    level,
    pct,
    text: '【水位】还剩 ' + fmt(left) + '（用了 ' + pctText + '）' + mark,
  };
}

/**
 * 拼成一段可以塞进 systemPrompt 的上下文。
 *
 * ★ 三段各自独立失败：读不到时间就不写时间，读不到水位就不写水位。
 *   **任何一段都不许让「拼上下文」这件事本身失败** —— 那是零号要求。
 */
export function renderContext(opts) {
  const o = opts || {};
  const lines = [];
  try { if (o.now !== false) lines.push('现在：' + nowText(o.at)); } catch { /* 不写这一行 */ }
  try {
    const idle = idleText(o.idleMs);
    if (idle) lines.push('上次有人说话：' + idle);
  } catch { /* 不写这一行 */ }
  try {
    const wm = watermarkOf(o.usedTokens, o.windowTokens, o.watermark);
    if (wm) lines.push(wm.text);
  } catch { /* 不写这一行 */ }
  return lines.join('\n');
}

/**
 * 从会话里算「当前上下文用了多少」。
 *
 * ★ 和 DSH 那边「读 projcache」不同：**我们自己的上下文是我们自己拼的**，
 *   所以直接数 —— 人格层 + 未压缩的帧。这比猜别人的缓存文件可靠。
 * ★ 只数「还没被压缩掉的」：被 compaction.summary 覆盖的区间跳过。
 */
export function usedTokens(store, sid, personaText) {
  let total = estimateTokens(personaText || '');
  const s = store && store.load ? store.load(sid) : null;
  if (!s || !Array.isArray(s.frames)) return total;

  // 收集已被压缩覆盖的区间
  const covered = [];
  for (const f of s.frames) {
    const m = f.meta;
    if (m && m.kind === 'compaction.summary' && Number.isFinite(m.start) && Number.isFinite(m.end)) {
      covered.push([m.start, m.end]);
    }
  }
  const inCovered = (seq) => covered.some(([a, b]) => seq >= a && seq <= b);

  for (const f of s.frames) {
    if (f.type === 'session') continue;
    if (inCovered(f.seq)) continue;
    total += estimateTokens(f.text) + 4;   // 每帧 4 个 token 的框架开销
  }
  return total;
}

/**
 * 读宿主（DSH）自己算的水位 —— **唯一权威口径**。
 *
 * ★ 2026-11-09 修的一个真 bug：`soul_context` 曾把 session-7aa72f04 报成
 *   2,199,393 tokens / 209.8%，而 DSH 侧同一会话只有 52,036 / 4.96%（差 42 倍）。
 *   根因是 `usedTokens` 数的是「v4 加载的全量帧」，只跳过 `compaction.summary` 覆盖的区间；
 *   可 v4 现在量的是 **DSH 会话**，DSH 的压缩记录格式 v4 认不出 → covered 为空
 *   → 整条 7.6 MB 历史全被算成「当前上下文」。
 *   **它报的不是水位，是历史总量。**
 *
 * ★ 判据（2026-09-27 实测，别再改回去）：
 *   水位只有一种读法是准的 —— `contextPressure.pressureTokens`（= input + cacheRead）。
 *   `surfaceTokens` 只是「可见消息面」，**不是水位**（GUI 把两把尺子画在一张图上）。
 *
 * ★ 读不到就明说读不到，**不许拿自算的数冒充宿主口径**。
 *
 * @param {string} sessionId  会话 id（可带或不带 `session-` 前缀）
 * @param {{dshHome?:string, staleMs?:number}} [opts]
 * @returns {{ok:true, tokens:number, window:number|null, surfaceTokens:number|null,
 *            mtimeMs:number, stale:boolean}
 *          |{ok:false, reason:string}}
 */
export function hostPressure(sessionId, opts) {
  const o = opts || {};
  try {
    const sid = String(sessionId || '').trim();
    if (!sid) return { ok: false, reason: '没有会话 id' };

    // ★ 只允许安全字符：会话 id 会拼进路径，不许有 .. 或分隔符
    if (!/^[A-Za-z0-9._-]+$/.test(sid)) return { ok: false, reason: '会话 id 含非法字符' };

    const home = String(o.dshHome || process.env.DSH_HOME || 'D:/AI/dsh/home');
    const name = (sid.startsWith('session-') ? sid : 'session-' + sid) + '.json';
    const file = pathMod.join(home, 'storages', 'session_projcache', 'sessions', name);

    if (!fsMod.existsSync(file)) return { ok: false, reason: 'projcache 里没有这个会话：' + file };

    const st = fsMod.statSync(file);
    const j = JSON.parse(fsMod.readFileSync(file, 'utf8'));
    const rows = (j && j.record && j.record.rows) || (j && j.rows) || null;
    const cp = rows && rows.contextPressure && rows.contextPressure.val;
    if (!cp) return { ok: false, reason: 'projcache 里没有 contextPressure 段' };

    const tokens = Number(cp.pressureTokens);
    if (!Number.isFinite(tokens) || tokens < 0) {
      return { ok: false, reason: 'pressureTokens 不是有效数字：' + String(cp.pressureTokens) };
    }

    const staleMs = Number.isFinite(o.staleMs) ? o.staleMs : 30 * 60 * 1000;
    const age = Date.now() - st.mtimeMs;

    return {
      ok: true,
      tokens,
      window: Number.isFinite(Number(cp.contextWindow)) ? Number(cp.contextWindow) : null,
      surfaceTokens: Number.isFinite(Number(cp.surfaceTokens)) ? Number(cp.surfaceTokens) : null,
      mtimeMs: st.mtimeMs,
      stale: age > staleMs,
    };
  } catch (e) {
    return { ok: false, reason: '读宿主水位失败：' + (e && e.message ? e.message : String(e)) };
  }
}