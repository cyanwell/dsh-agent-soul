#!/usr/bin/env node
/**
 * 重启后一键测量：等 CDP → 等页面渲染完 → 查护栏 → 数 backdrop → 量 fps
 *
 * ★ 为什么要有它：
 *   重启后 DSH 要几十秒才起完，页面又要几十秒才把会话内容渲染出来。
 *   手动敲三四条命令，中间任何一步查早了都会得到假读数
 *   （2026-11-01 就在刷新后 5 秒查到 styleExists:false，差点误判"插件坏了"）。
 *   所以把"等"和"验"写进同一个脚本，一次性拿全。
 *
 * 用法：
 *   node yq-measure.mjs [--port 9222] [--fps 3] [--wait 180]
 */

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const PORT = arg('port', '9222');
const FPS_SEC = Number(arg('fps', '3'));
const MAX_WAIT = Number(arg('wait', '180'));
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ── ① 等 CDP 开门 ──────────────────────────────────────── */
let targets = null;
const t0 = Date.now();
while (Date.now() - t0 < MAX_WAIT * 1000) {
  try {
    const r = await fetch(`${BASE}/json/list`);
    targets = await r.json();
    if (targets.some(t => t.type === 'page')) break;
  } catch { /* 还没起 */ }
  await sleep(2000);
}
if (!targets || !targets.some(t => t.type === 'page')) {
  console.error(`✗ ${MAX_WAIT}s 内没等到 CDP 的 page target`);
  process.exit(1);
}
const page = targets.find(t => t.type === 'page');
console.log(`目标: ${page.title}`);
console.log(`等 CDP 用了 ${Math.round((Date.now() - t0) / 1000)}s`);

/* ── ② 连上 ─────────────────────────────────────────────── */
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
  if (r.exceptionDetails) throw new Error(`页面抛异常: ${r.exceptionDetails.text}`);
  return r.result.value;
};

/* ── ③ 等页面真的渲染出会话内容 ─────────────────────────── */
// 判据不是"DOM 有多大"，而是"markdown 内容出现了没有"。
// 空态页面 DOM 只有两百多个节点，看起来也能连上，但什么都测不到。
const t1 = Date.now();
let ready = false;
while (Date.now() - t1 < MAX_WAIT * 1000) {
  try {
    const n = await ev(`document.querySelectorAll('[class*="markdown"] *').length`);
    if (n > 50) { ready = true; break; }
  } catch { /* 页面还在换 */ }
  await sleep(2000);
}
if (!ready) {
  console.error(`✗ ${MAX_WAIT}s 内页面没渲染出 markdown 内容（可能停在空态）`);
  ws.close();
  process.exit(1);
}
console.log(`等页面内容用了 ${Math.round((Date.now() - t1) / 1000)}s`);
await sleep(1500);   // 让布局/合成稳定一下再测

/* ── ④ 护栏状态 ─────────────────────────────────────────── */
const guard = await ev(`(() => {
  const s = document.getElementById('yq-perf-style-v1');
  const txt = s ? s.textContent : '';
  return {
    exists: !!s,
    len: txt.length,
    hasHeadingSel: txt.includes('h1, h2, h3'),
    hasBlockquote: txt.includes('blockquote'),
    hasCallRow: txt.includes('callRow'),
  };
})()`);

/* ── ⑤ backdrop 全量枚举 ────────────────────────────────── */
const blur = await ev(`(() => {
  const all = [...document.querySelectorAll('*')];
  let total = 0, zero = 0, maxArea = 0;
  const byVal = {}, samples = [];
  for (const el of all) {
    const bf = getComputedStyle(el).backdropFilter;
    if (!bf || bf === 'none') continue;
    total++;
    const r = el.getBoundingClientRect();
    const area = Math.round(r.width * r.height);
    if (area > maxArea) maxArea = area;
    if (/^blur\\(0px\\)/.test(bf)) {
      zero++;
      if (samples.length < 5) samples.push({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 40), area });
    }
    byVal[bf] = (byVal[bf] || 0) + 1;
  }
  return { total, zero, maxArea, byVal, zeroSamples: samples, domNodes: all.length };
})()`);

/* ── ⑥ 帧率 ─────────────────────────────────────────────── */
const fps = await ev(`new Promise(resolve => {
  let frames = 0, gaps = [], last = performance.now(), start = last;
  function tick(now) {
    if (frames > 0) gaps.push(now - last);
    last = now; frames++;
    if (now - start < ${FPS_SEC * 1000}) requestAnimationFrame(tick);
    else {
      gaps.sort((a,b)=>a-b);
      const q = p => gaps.length ? Math.round(gaps[Math.floor(gaps.length*p)]) : null;
      resolve({
        fps: Math.round(frames / ((now-start)/1000) * 10) / 10,
        median: q(0.5), p95: q(0.95), max: q(0.999),
        janky: gaps.filter(g => g > 50).length, frames,
      });
    }
  }
  requestAnimationFrame(tick);
})`);

/* ── 输出 ───────────────────────────────────────────────── */
const L = '─'.repeat(52);
const ok = (b) => b ? '✓' : '✗';
console.log(L);
console.log('护栏');
console.log(`  ${ok(guard.exists)} <style id="yq-perf-style-v1"> 存在  (${guard.len} 字符)`);
console.log(`  ${ok(guard.hasHeadingSel)} 含标题族 h1,h2,h3`);
console.log(`  ${ok(guard.hasBlockquote)} 含 blockquote`);
console.log(`  ${ok(guard.hasCallRow)} 含 callRow`);
if (!guard.exists) console.log('  ⚠ 插件没挂上 —— 先查 web boot，别先怀疑 CSS');

console.log(L);
console.log(`backdrop-filter（DOM ${blur.domNodes} 节点）`);
console.log(`  总数            : ${blur.total}`);
console.log(`  ${ok(blur.zero === 0)} 空转层 blur(0px) : ${blur.zero}`);
console.log(`  最大面积        : ${blur.maxArea}`);
for (const [k, n] of Object.entries(blur.byVal).sort((a, b) => b[1] - a[1])) {
  console.log(`       ${String(n).padStart(4)}  ${k}`);
}
if (blur.zeroSamples.length) {
  console.log('  空转层样本（这些是护栏没覆盖到的）:');
  for (const s of blur.zeroSamples) console.log(`       ${s.tag}.${s.cls}  面积 ${s.area}`);
}

console.log(L);
console.log('帧率');
console.log(`  fps ${fps.fps}   中位 ${fps.median} ms   p95 ${fps.p95} ms   最长 ${fps.max} ms`);
console.log(`  卡顿帧 ${fps.janky}/${fps.frames}`);
console.log(L);

ws.close();
process.exit(blur.zero === 0 && guard.exists ? 0 : 2);
