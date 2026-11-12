// 极光设计系统 · 截图与体检（无头 Edge + CDP）
//
// ★ 为什么用 CDP 而不是 msedge --screenshot：见 tools/chat-shot.mjs 的实测笔记 ——
//   --window-size 给的不是布局视口，裁出来的图会让你去改本来正确的 CSS。
// ★ 这里比 chat-shot 多做三件事：
//   ① 读 HTTP 状态与**控制台报错**（渲染无报错是验收项，不靠肉眼）；
//   ② 算**对比度**：按「光帘最亮处」合成背景，取最低的那几个，不是凭感觉；
//   ③ 用 Emulation.setEmulatedMedia 真开 prefers-reduced-motion，断言动画真的停了。
//
// 用法：
//   node tools/aurora-shot.mjs --base http://127.0.0.1:PORT --out data/_shots
//   node tools/aurora-shot.mjs --paths /,/chat,/params --width 1280
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PROBE = `function probe(){
  const out={};
  const de=document.documentElement;
  out.overflowX=de.scrollWidth-de.clientWidth;
  out.sheets=[...document.styleSheets].map(s=>s.href||'inline').filter(Boolean);
  out.sky=!!document.getElementById('as-sky');
  const cs1=n=>n?getComputedStyle(n).animationName:'-';
  out.anim={curtain:cs1(document.querySelector('.as-curtain')),dot:cs1(document.querySelector('.as-dot')),lead:cs1(document.querySelector('.as-lead')),skel:cs1(document.querySelector('.sk'))};
  const SKY=[88,128,165];
  const f=v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)};
  const lum=c=>0.2126*f(c[0])+0.7152*f(c[1])+0.0722*f(c[2]);
  const over=(fg,bg)=>{const a=fg[3]==null?1:fg[3];return [0,1,2].map(i=>fg[i]*a+bg[i]*(1-a))};
  const nums=x=>String(x).split(')')[0].split('(').pop().split(',').map(Number);
  const parse=s=>{const t=String(s);const i=t.indexOf('(');if(i<0)return null;const p=nums(t.slice(i));return [p[0],p[1],p[2],p.length>3?p[3]:1]};
  const all=s=>{const out=[];String(s).split('rgb').forEach(function(seg,ix){if(!ix)return;const i=seg.indexOf('(');if(i<0)return;const p=nums(seg.slice(i));out.push([p[0],p[1],p[2],p.length>3?p[3]:1])});return out};
  function bgOf(el){
    const chain=[];for(let n=el;n;n=n.parentElement)chain.unshift(n);
    let bg=SKY.slice();
    for(const n of chain){
      const s=getComputedStyle(n),cols=[];
      const bc=parse(s.backgroundColor);if(bc&&bc[3]>0.01)cols.push(bc);
      if(s.backgroundImage&&s.backgroundImage!=='none'){const g=all(s.backgroundImage).filter(c=>c[3]>0.01);if(g.length){g.sort((a,b)=>a[3]-b[3]);cols.push(g[0])}}
      for(const c of cols)bg=over(c,bg);
    }
    return bg;
  }
  const ratio=(a,b)=>{const L1=lum(a),L2=lum(b),hi=Math.max(L1,L2),lo=Math.min(L1,L2);return (hi+0.05)/(lo+0.05)};
  const SEL='p,span,div,td,th,li,b,em,strong,h1,h2,h3,label,a,button,code,pre,i';
  const rows=[],seen=new Set();
  for(const el of document.querySelectorAll(SEL)){
    const tn=[...el.childNodes].filter(n=>n.nodeType===3&&n.textContent.trim()).map(n=>n.textContent.trim()).join(' ');
    if(!tn)continue;
    const r=el.getBoundingClientRect();if(r.width<2||r.height<2)continue;
    const s=getComputedStyle(el);
    if(s.visibility==='hidden'||s.display==='none'||Number(s.opacity)===0)continue;
    const col=parse(s.color);if(!col)continue;
    const bg=bgOf(el);
    const cr=ratio(over(col,bg),bg);
    const sel=el.tagName.toLowerCase()+(typeof el.className==='string'&&el.className.trim()?'.'+el.className.trim().split(/\s+/).join('.'):'');
    const key=sel+'|'+tn.slice(0,20);if(seen.has(key))continue;seen.add(key);
    rows.push({sel,text:tn.slice(0,36),color:s.color,bg:'rgb('+bg.slice(0,3).map(Math.round).join(',')+')',ratio:Math.round(cr*100)/100,fs:s.fontSize});
  }
  out.debug={bodyBg:getComputedStyle(document.body).backgroundColor,navBg:document.querySelector('nav')?String(getComputedStyle(document.querySelector('nav')).backgroundImage).slice(0,90):'-',base:bgOf(document.body).map(v=>Math.round(v))};
  rows.sort((a,b)=>a.ratio-b.ratio);
  out.contrast={min:rows.length?rows[0].ratio:null,n:rows.length,worst:rows.slice(0,6)};
  return out;
}`;

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const BASE = arg('base', 'http://127.0.0.1:8901');
const OUT = arg('out', path.join('data', '_shots'));
const W = Number(arg('width', 1280));
const H = Number(arg('height', 900));
const CDP = Number(arg('cdp', 9444));
const PATHS = arg('paths', '/,/chat,/params,/settings,/organs,/diary,/yantai,/status').split(',');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureBrowser() {
  try { const r = await fetch('http://127.0.0.1:' + CDP + '/json/version'); if (r.ok) return; } catch {}
  const prof = path.resolve('_verify', 'edge-aurora-' + Date.now());
  fs.mkdirSync(prof, { recursive: true });
  spawn(EDGE, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--remote-debugging-port=' + CDP, '--user-data-dir=' + prof, 'about:blank'],
    { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch('http://127.0.0.1:' + CDP + '/json/version'); if (r.ok) return; } catch {}
    await sleep(250);
  }
  throw new Error('Edge 起不来（CDP ' + CDP + ' 没应答）');
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
let log = [];           // 本页的控制台/异常/坏响应
ws.addEventListener('message', (ev) => {
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
    log.push('console.' + m.params.type + ': ' + (m.params.args || []).map(a => a.value ?? a.description ?? a.type).join(' ').slice(0, 200));
  }
  if (m.method === 'Runtime.exceptionThrown') log.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 200));
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') log.push('log: ' + m.params.entry.text.slice(0, 200));
  if (m.method === 'Network.responseReceived') {
    const r = m.params.response;
    if (r.status >= 400) log.push('http ' + r.status + ' ' + r.url.slice(-60));
  }
});
const send = (method, params) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.exception?.description || 'eval error' };
  return r.result?.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Network.enable');

const results = [];
fs.mkdirSync(OUT, { recursive: true });

for (const p of PATHS) {
  log = [];
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false, screenWidth: W, screenHeight: H });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  const nav = await send('Page.navigate', { url: BASE + p });
  await sleep(Number(arg('wait', 1800)));
  const status = nav.result?.frameId ? await evaluate('performance.getEntriesByType("navigation")[0] && performance.getEntriesByType("navigation")[0].responseStatus') : null;
  const probed = await evaluate('(' + PROBE + ')()');
  const title = await evaluate('document.title');

  // 全页截图
  const lm = await send('Page.getLayoutMetrics');
  const full = Math.min(lm.result?.cssContentSize?.height || H, 6000);
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: W, height: full, scale: 1 } });
  // ★ 2026-11-11：带 query 的路径（如 /lumen?sel=vital）过去会拼出含 '?' 的文件名 → Windows 直接 ENOENT。
  //   '?' 与 '&' 一律转成 '-'，名字仍然能看出是哪个页面。
  const name = (p === '/' ? 'index' : p.replace(/^\//, '').replace(/\//g, '_').replace(/[?&=]/g, '-')) + '.png';
  const file = path.join(OUT, name);
  if (shot.result?.data) fs.writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
  else log.push('截图失败: ' + JSON.stringify(shot).slice(0, 200));

  // prefers-reduced-motion：真开一遍，断言动画停了
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await sleep(150);
  const reduced = await evaluate('JSON.stringify({curtain:getComputedStyle(document.querySelector(".as-curtain")||document.body).animationName,skel:(document.querySelector(".sk")?getComputedStyle(document.querySelector(".sk")).animationName:"-"),lead:(document.querySelector(".as-lead")?getComputedStyle(document.querySelector(".as-lead")).animationName:"-")})');

  const row = {
    path: p, name, status: status ?? 'n/a', title: String(title || '').slice(0, 30),
    sky: probed?.sky, sheets: probed?.sheets, overflowX: probed?.overflowX,
    contrastMin: probed?.contrast?.min, contrastN: probed?.contrast?.n,
    worst: probed?.contrast?.worst, anim: probed?.anim, debug: probed?.debug,
    reduced: reduced ? JSON.parse(reduced) : null,
    errors: log.slice(0, 8), bytes: shot.result?.data ? fs.statSync(file).size : 0,
  };
  results.push(row);
  console.log('── ' + p + ' ─ status=' + row.status + ' sky=' + row.sky + ' overflowX=' + row.overflowX +
    ' 对比最低=' + row.contrastMin + ' 报错=' + row.errors.length + ' → ' + file);
  if (row.worst) row.worst.forEach((w) => console.log('      ' + w.ratio + ' ×  ' + w.sel + '  ' + (w.fs || '') + '  ' + w.text.slice(0, 26) + '  on ' + w.bg));
  if (row.anim) console.log('      动效 no-pref: curtain=' + row.anim.curtain + ' dot=' + row.anim.dot + ' | reduced: ' + JSON.stringify(row.reduced));
  if (row.errors.length) row.errors.forEach((e) => console.log('      ! ' + e));
}

fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ at: new Date().toISOString(), base: BASE, width: W, rows: results }, null, 2));
console.log('\n汇总: ' + results.length + ' 页 · 截图在 ' + OUT + ' · 明细 ' + path.join(OUT, 'report.json'));
ws.close();