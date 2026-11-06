// 手机页截图工具 —— 用 CDP 精确控制视口，不靠 --window-size。
//
// ★ 为什么不用 `msedge --headless=new --window-size=375,812 --screenshot`：
//   在本机实测**它给的不是 375 的布局视口** —— 截出来的图右半边内容被裁掉，
//   看起来像"页面横向溢出了"，于是你会去改 CSS，而 CSS 本来是对的。
//   我在这上面浪费了两轮：真正的判据是 innerWidth / scrollWidth，
//   而那两样只有连上 DevTools 协议才读得到。
//
// ★ 用法：
//   node tools/chat-shot.mjs --url http://127.0.0.1:8901/ --out _verify/phone.png
//   node tools/chat-shot.mjs --width 375 --height 812 --scale 2
//
// ★ 它会先起一个自己的 Edge（独立 user-data-dir，端口 9333），截完不关 ——
//   要复用就重复调用，要清就自己 taskkill msedge。这里故意不杀：
//   **杀错一个别人正在用的浏览器比起多留一个进程更糟。**

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const URL_ = arg('url', 'http://127.0.0.1:8898/');
const OUT = arg('out', path.join('_verify', 'phone.png'));
const W = Number(arg('width', 375));
const H = Number(arg('height', 812));
const SCALE = Number(arg('scale', 2));
const CDP = Number(arg('cdp', 9333));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起 Edge（如果 9333 上已经有人在答，就不重复起 —— 重复起只会得到一堆互不相干的进程） */
async function ensureBrowser() {
  try { const r = await fetch('http://127.0.0.1:' + CDP + '/json/version'); if (r.ok) return; } catch {}
  const prof = path.resolve('_verify', 'edge-prof-' + Date.now());
  fs.mkdirSync(prof, { recursive: true });
  spawn(EDGE, ['--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--remote-debugging-port=' + CDP, '--user-data-dir=' + prof, 'about:blank'],
    { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch('http://127.0.0.1:' + CDP + '/json/version'); if (r.ok) return; } catch {}
    await sleep(250);
  }
  throw new Error('Edge 起不来（CDP 端口 ' + CDP + ' 没应答）');
}

async function target() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + CDP + '/json/list')).json();
      const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('拿不到 CDP target');
}

await ensureBrowser();

const ws = new WebSocket(await target());
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
let seq = 0;
const pend = new Map();
ws.addEventListener('message', (ev) => {
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
const send = (method, params) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: W, height: H, deviceScaleFactor: SCALE, mobile: true, screenWidth: W, screenHeight: H,
});
await send('Page.navigate', { url: URL_ });
await sleep(3500);   // 首屏要等 /api/recent 回来；3.5 秒是实测够用的余量

// ★ 先把布局读数打出来再截图：图会骗人（裁掉了半截你会以为溢出），
//   innerWidth / scrollWidth 不会。overflow > 0 就是真的横向溢出了。
const probe = await send('Runtime.evaluate', {
  returnByValue: true,
  expression: 'JSON.stringify({innerW:innerWidth,innerH:innerHeight,dpr:devicePixelRatio,scrollW:document.documentElement.scrollWidth,overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,msgs:document.querySelectorAll(".row").length,note:(document.querySelector(".note")||{}).textContent})',
});
console.log('布局:', probe.result?.result?.value || JSON.stringify(probe).slice(0, 200));

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
if (!shot.result || !shot.result.data) throw new Error('截图失败：' + JSON.stringify(shot).slice(0, 300));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
console.log('截图:', OUT, fs.statSync(OUT).size, 'bytes', '(' + W + 'x' + H + ' @' + SCALE + 'x)');
ws.close();
