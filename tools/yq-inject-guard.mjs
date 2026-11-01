#!/usr/bin/env node
/**
 * 把护栏 CSS 直接注入当前页面（不等重启、不刷新）
 *
 * ★ 用途：
 *   插件代码改了，但要下次重启才生效。而用户等不了那么久 ——
 *   这个脚本用**和 client.js 完全相同的选择器**，把同一个 style 标签塞进当前页面，
 *   id 也用同一个（yq-perf-style-v1），下次插件生效时 ensureStyle 会发现内容一致、不重复插入。
 *
 * ★ 安全性：
 *   只创建一个 <style> 元素，随时可以删；不碰文件、不 reload、不重启。
 *
 * 用法：node yq-inject-guard.mjs [--port 9222] [--off]
 */

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const PORT = arg('port', '9222');
const OFF = args.includes('--off');

// ★ 必须和 dsh-tools/dsh-yanqing-perf/client.js 的 DENSE 逐条一致。
//   改那边的时候，这里要同步 —— 所以下面用 yq-check-client 的自检来兜底。
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
const CSS_B64 = Buffer.from(CSS, 'utf8').toString('base64');

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq; pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`${method} 超时`)); } }, 20000);
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
    const d = r.exceptionDetails;
    throw new Error(`页面抛异常: ${String(d.exception?.description || d.text).slice(0, 500)}`);
  }
  return r.result.value;
};

const result = await ev(`(() => {
  const ID = 'yq-perf-style-v1';
  let el = document.getElementById(ID);
  if (${OFF}) { if (el) el.remove(); return { action: 'removed' }; }
  if (!el) { el = document.createElement('style'); el.id = ID; document.head.appendChild(el); }
  el.textContent = atob('${CSS_B64}');
  return { action: 'injected', len: el.textContent.length };
})()`);

const stats = await ev(`(() => {
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
  return { bd, zero, maxA, dom: els.length };
})()`);

const L = '─'.repeat(50);
console.log(L);
console.log(`页面: ${page.title}`);
console.log(`动作: ${result.action}${result.len ? `（style ${result.len} 字符）` : ''}`);
console.log(L);
console.log(`backdrop-filter 总数 : ${stats.bd}`);
console.log(`空转层 blur(0px)    : ${stats.zero}`);
console.log(`最大面积             : ${stats.maxA}`);
console.log(`DOM 节点             : ${stats.dom}`);
console.log(L);

ws.close();
process.exit(stats.zero === 0 ? 0 : 2);
