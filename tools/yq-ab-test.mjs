#!/usr/bin/env node
/**
 * A/B/A 对照：同一页面、同一时刻，注入护栏前后各测一次
 *
 * ★ 为什么这么测：
 *   页面内容会变（流式输出、虚拟列表回收），跨时刻比较 fps 没有意义。
 *   所以在**同一次连接里**做三段：不注入 → 注入 → 移除，
 *   三段之间只隔 1 秒，页面内容的差异最小化。
 *
 * ★ 它和 yq-measure.mjs 的分工：
 *   yq-measure  → 验"部署后插件有没有生效"（依赖插件自己注入）
 *   本脚本      → 验"这套 CSS 到底值不值"（不依赖插件，自己注入同样的规则）
 *
 * 用法：node yq-ab-test.mjs [--port 9222] [--sec 3]
 */

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const PORT = arg('port', '9222');
const SEC = Number(arg('sec', '3'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* 和 client.js 里 DENSE 完全一致的 15 条选择器 */
const SELECTORS = [
  '[class*="markdown"] > p',
  '[class*="markdown"] > :where(ul, ol)',
  '[class*="markdown"] > pre',
  '[class*="markdown"] > :where(h1, h2, h3, h4, h5, h6, blockquote)',
  '[class*="markdown"] > :where(div, section, table, hr)',
  '[class*="tableScroll"]',
  '[data-disclosure-row]',
  '[class*="md-code-block"]',
  '[data-slot="main.conversation"] [class*="callRow"]',
  '[data-slot="main.conversation"] [class*="bubble"]',
  '[data-slot="main.conversation"] [class*="title"]',
  '[data-slot="main.conversation"] [class*="anchor"]',
  '[data-slot="main.conversation"] [class*="overlayLayer"]',
  '[data-slot="main.conversation"] [class*="hE4tRW_root"]',
  '[data-slot="main.conversation"] [class*="BE0jCW_title"]',
];
const CSS = `${SELECTORS.join(',')}{backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}`;

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq; pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`${method} 超时`)); } }, 30000);
});
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id); pending.delete(m.id);
    m.error ? rej(new Error(m.error.message)) : res(m.result);
  }
});
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    // ★ 只取 .text 永远得到 "Uncaught"，真正的信息在 exception.description。
    const d = r.exceptionDetails;
    const detail = d.exception?.description || d.exception?.value || d.text;
    throw new Error(`页面抛异常: ${String(detail).slice(0, 600)}`);
  }
  return r.result.value;
};

const measure = () => ev(`new Promise(resolve => {
  const t0 = performance.now();
  let frames = 0, gaps = [], last = t0;
  function tick(now) {
    if (frames > 0) gaps.push(now - last);
    last = now; frames++;
    if (now - t0 < ${SEC * 1000}) requestAnimationFrame(tick);
    else {
      gaps.sort((a,b)=>a-b);
      const q = p => gaps.length ? Math.round(gaps[Math.floor(gaps.length*p)]) : null;
      const els = [...document.querySelectorAll('*')];
      let bd = 0, zero = 0, maxA = 0;
      for (const el of els) {
        const bf = getComputedStyle(el).backdropFilter;
        if (!bf || bf === 'none') continue;
        bd++;
        const r = el.getBoundingClientRect();
        const a = Math.round(r.width * r.height);
        if (a > maxA) maxA = a;
        if (/^blur\\(0px\\)/.test(bf)) zero++;
      }
      resolve({
        fps: Math.round(frames / ((now - t0) / 1000) * 10) / 10,
        median: q(0.5), p95: q(0.95), max: q(0.999),
        janky: gaps.filter(g => g > 50).length, frames,
        backdrop: bd, zero, maxArea: maxA,
        dom: els.length,
      });
    }
  }
  requestAnimationFrame(tick);
})`);

// ★ 这里踩过两次，都记着：
//   ① 用 ${JSON.stringify(CSS)} 拼：JSON 的 \" 进模板字符串会被再解释，字符串提前闭合
//   ② 更蠢的一次：`if (!on)` —— on 是 Node 侧变量，页面里根本没有，ReferenceError。
//      给页面传值必须**显式插值成字面量**，不能指望闭包。
const CSS_B64 = Buffer.from(CSS, 'utf8').toString('base64');
const applyGuard = (on) => ev(`(() => {
  const id = '__ab_guard__';
  let el = document.getElementById(id);
  if (!${Boolean(on)}) { if (el) el.remove(); return 'removed'; }
  if (!el) { el = document.createElement('style'); el.id = id; document.head.appendChild(el); }
  el.textContent = atob('${CSS_B64}');
  return 'applied=' + el.textContent.length;
})()`);

const L = '─'.repeat(56);
console.log(`页面: ${page.title}`);
console.log(`每段采样 ${SEC}s，三段之间不刷新、不重启`);
console.log(L);

/* A1 · 不注入 */
const a1 = await measure();
console.log(`A1 原始      fps ${String(a1.fps).padStart(5)}  中位 ${String(a1.median).padStart(4)}ms  p95 ${String(a1.p95).padStart(4)}ms  backdrop ${a1.backdrop}  空转 ${a1.zero}  DOM ${a1.dom}`);

/* B · 注入护栏 */
const applied = await applyGuard(true);
await sleep(600);
const b = await measure();
console.log(`B  护栏生效  fps ${String(b.fps).padStart(5)}  中位 ${String(b.median).padStart(4)}ms  p95 ${String(b.p95).padStart(4)}ms  backdrop ${b.backdrop}  空转 ${b.zero}  DOM ${b.dom}   (${applied})`);

/* A2 · 移除护栏，确认可逆 */
const removed = await applyGuard(false);
await sleep(600);
const a2 = await measure();
console.log(`A2 移除后    fps ${String(a2.fps).padStart(5)}  中位 ${String(a2.median).padStart(4)}ms  p95 ${String(a2.p95).padStart(4)}ms  backdrop ${a2.backdrop}  空转 ${a2.zero}  DOM ${a2.dom}   (${removed})`);

console.log(L);
const base = Math.round((a1.median + a2.median) / 2);
const gain = base > 0 ? Math.round((1 - b.median / base) * 100) : null;
console.log(`基线中位帧(两次平均) : ${base} ms`);
console.log(`护栏下中位帧         : ${b.median} ms`);
console.log(`中位帧变化           : ${gain === null ? 'n/a' : (gain >= 0 ? '-' + gain + '%' : '+' + (-gain) + '%')}`);
console.log(`backdrop 元素        : ${a1.backdrop} → ${b.backdrop} → ${a2.backdrop}`);
console.log(`空转层 blur(0px)     : ${a1.zero} → ${b.zero} → ${a2.zero}`);
console.log(L);
console.log('★ 可逆性：A2 的 backdrop/空转 应该回到 A1 的值附近，否则说明注入有残留');

ws.close();
process.exit(0);
