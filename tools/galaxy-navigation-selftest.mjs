import assertModule from 'node:assert/strict';
let assertionCount = 0;
const assert = new Proxy(assertModule, { get(target, key) { const value = Reflect.get(target, key, target); return typeof value === 'function' && key !== 'AssertionError' ? (...args) => { const result = value.apply(target, args); assertionCount++; return result; } : value; } });
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import vm from 'node:vm';
import * as Three from '../src/web/vendor/three.module.min.js';

const web = new URL('../src/web/', import.meta.url);
const assets = await Promise.all(['galaxy.html', 'aurora.css', 'vendor/three.module.min.js', 'vendor/OrbitControls.js'].map(async name => [name, await readFile(new URL(name, web), 'utf8')]));
const files = new Map(assets);
const html = files.get('galaxy.html');
const moduleBody = html.match(/<script type="module">(.*?)<[/]script>/s)[1];
assert.match(html, /外层运行分区[^<]*六条旋臂[\s\S]*ECHO 内层 L0–L5/);
assert.match(html, /ECHO 内层 · L0–L5（外层分区 6 独立）/);
assert.match(html, /未知 · not-connected/);
assert.match(html, /not-queried/);
assert.match(html, /上下文管理[\s\S]*观察 · 整理 · 压缩 · 交接/);
assert.match(html, /authority-view/);
assert.doesNotMatch(html, /L0 面板|L0 的面板|L0 时收起/);
assert.match(html, /param, value\] of \[[\s\S]*echoLayer/);
const armKeys = ['echo', 'vital', 'capability', 'archive', 'ops', 'events'];
const organName = '夹具水位器官';
const organValue = '水位 25%';
const privatePath = 'D:\\SYNTHETIC_DIR\\not-for-display.json';
const privateBody = 'SYNTHETIC_SESSION_BODY';
const literalTitle = '<img onerror=unexpected()> 合成事件';
const ledgerRow = {
  key: privatePath, title: literalTitle, t: '2026-01-05T09:08:07.000Z', from: '合成来源', tier: 'act',
  stage: 'woken', decision: null, charter: 'unchecked', charterNote: '合成审计备注', note: '合成台账备注',
  body: privateBody, receipt: 'SYNTHETIC_RECEIPT', fromSession: privateBody
};
function wakerFixture() {
  return {
    ok: true, file: privatePath, why: null, total: 250,
    counts: { act: 205, done: 1, audit: 0, auto: 1 },
    views: {
      act: Array.from({ length: 200 }, (_, i) => i === 0 ? ledgerRow : { ...ledgerRow, title: '合成待执行 ' + i }),
      done: [{ ...ledgerRow, title: '合成执行判定', stage: 'done', decision: 'resume', note: privatePath }], audit: [],
      auto: [{ ...ledgerRow, title: '合成自主判定', charter: 'pass', decision: 'hold', from: '源自 /var/SYNTHETIC_PATH/log' }],
      blocked: [{ ...ledgerRow, title: 'SYNTHETIC_BLOCKED' }]
    }
  };
}
const emptyWaker = () => ({ ok:true, why:null, total:0, counts:{ act:0, done:0, audit:0, auto:0 }, views:{ act:[], done:[], audit:[], auto:[] } });
function makeFixture(key, call = 1) {
  if (key === 'status') return {
    tookMs: 700 + call,
    watermarks: { lead:{ok:true,pct:25,used:25600,window:1048576}, active:{ok:true,count:3}, mirror:{ok:true,pct:2.5} },
    layers: Object.fromEntries(armKeys.map(k => [k, k === 'events'
      ? { level: 'ok', items: [{ label:'私有夹具', value:privateBody, sub:privatePath }], note:privatePath }
      : { level: 'ok', items: [{ label: '夹具 ' + k, value: call }] }]))
  };
  if (key === 'waker') return wakerFixture();
  const fixtures = {
    vitals: {}, health: {}, overview: { control:{connected:0,hosts:[]}, sessions:3, indexRows:1234, dataMB:4.25, cacheMB:0.38, memMB:144, heapMB:48, uptimeSec:3660, node:'v22.22.2', model:'synthetic-local', llmUsable:true, persona:{used:1024,budget:8192,dropped:[]}, events:{rules:2,ticks:12}, series:[{sessions:1,indexRows:1000,memMB:130},{sessions:2,indexRows:1100,memMB:138},{sessions:3,indexRows:1234,memMB:144}] },
    organs: { organs: [
      { key: 'watermark', name: organName, level: 'ok', value: organValue, note: '合成说明' },
      { key: 'waker', name: privateBody, level: 'warn', value: privateBody, note: privatePath }
    ] },
    live: { recent: [] }, diagnose: { unavailable: true }, 'echo-sentinel': { unavailable: true },
    'echo/authority-view': {
      sync: { configured:true, enabled:true, running:false, last:{ at:'2026-11-19T01:00:00.000Z', code:'IMPORTED', ok:true, attemptId:'synthetic-attempt', attempt:4, commitId:'synthetic-commit', commit:8, authority:{ sourceId:'synthetic-source', generation:12, state:'committed' } } },
      sources: { available:true, aligned:true, rows:[{ sourceId:'synthetic-source', namespace:'test', generation:12, state:'committed', cursorSeq:55, aligned:true, counts:{ words:4, wordsFts:4, summaries:2, summariesFts:2, srcSeqs:3, declaredSrcSeqs:3 } }] },
      freshness: { state:'unknown', checkedAt:'2026-11-19T01:00:00.000Z' }, query:{ status:'not-queried' },
      dbPath:privatePath, sourceRoot:privatePath, receiptFile:privatePath, error:privateBody
    }
  };
  return Object.hasOwn(fixtures, key) ? fixtures[key] : undefined;
}

// Browser mode only serves a loopback synthetic fixture. It never launches or controls a browser.
// Follow the injected browser-skill (no CDP) and the cases exposed at /__checklist.
if (process.argv[2] === '--serve-fixture') await serveFixture();
else if (process.argv.length === 2) await runNode();
else throw Error('Usage: node tools/galaxy-navigation-selftest.mjs [--serve-fixture]');

async function runNode() {
  const threeURL = new URL('vendor/three.module.min.js', web);
  const orbitSource = 'const window = { devicePixelRatio: 1 };' + files.get('vendor/OrbitControls.js').replace("from 'three'", 'from ' + JSON.stringify(threeURL.href));
  const { OrbitControls } = await import('data:text/javascript;base64,' + Buffer.from(orbitSource).toString('base64'));
  const body = moduleBody.replace(/^import .*?;$/gm, '');

  async function boot(path, reduce, { webgl = true, clamp = false, reply, width = 1280, height = 800 } = {}) {
    let elapsed = 0, now = 1000, nextId = 0, nextFrame;
    const timers = new Map(), arrivals = new Map(), held = new Map(), requests = [];
    const waiters = new Map();
    const byId = new Map();
    const doc = new EventTarget();
    let url = new URL(path, 'http://127.0.0.1');
    const entries = [url.href]; let historyIndex = 0;
    function el(tagName) {
      const node = new EventTarget();
      Object.assign(node, {
        tagName, children: [], style: {}, dataset: {}, scrollTop: 0, textContent: '', clientHeight: 800, offsetHeight: 250, offsetWidth: 340,
        classList: new Set(), attrs: new Map(), setAttribute(n, v) { this.attrs.set(n, v); }, setPointerCapture() {}, releasePointerCapture() {},
        getContext: kind => kind === '2d' ? new Proxy({}, { get: (_, k) => k === 'createRadialGradient' ? () => ({ addColorStop() {} }) : () => {} }) : null,
        appendChild(child) { this.children.push(child); },
        append(...children) { this.children.push(...children); },
        replaceChildren(...children) { this.children = children; },
        querySelector(selector) {
          if (selector === 'h2') return this.heading || null;
          const attr = selector.match(/^\[data-(k|organ)="([^"]+)"\]$/);
          return attr && this.children.find(e => e.dataset[attr[1]] === attr[2]);
        },
        contains(candidate) { return candidate != null && (this === candidate || this.heading === candidate || this.children.some(e => e.contains(candidate))); },
        focus() { doc.activeElement = this; }
      });
      node.classList.remove = node.classList.delete;
      let ownText = '';
      Object.defineProperty(node, 'textContent', { get() { return ownText + this.children.map(child => child.textContent || '').join(''); }, set(value) { ownText = String(value); this.children = []; } });
      Object.defineProperty(node, 'innerHTML', { get: () => node.html, set(value) {
        node.html = value;
        const heading = value.match(/<h2>(.*?)<[/]h2>/);
        node.heading = heading ? { textContent: heading[1], focus() { doc.activeElement = this; } } : null;
      } });
      return node;
    }
    Object.assign(doc, {
      hidden: false, activeElement: null,
      createElement: el,
      getElementById(id) { if (!byId.has(id)) byId.set(id, el()); return byId.get(id); }
    });
    const win = Object.assign(new EventTarget(), { innerWidth: width, innerHeight: height, matchMedia: () => ({ matches: reduce }) });
    const history = {
      state: null,
      pushState(_, __, u) { url = new URL(u); entries.splice(++historyIndex, Infinity, url.href); },
      replaceState(_, __, u) { url = new URL(u); entries[historyIndex] = url.href; },
      go(delta) { url = new URL(entries[historyIndex += delta]); win.dispatchEvent(new Event('popstate')); }
    };
    const THREE = { ...Three,
      Clock: class { getElapsedTime() { return elapsed; } },
      WebGLRenderer: class {
        constructor() { if (!webgl) throw Error('fixture: WebGL unavailable'); }
        setSize() {} setPixelRatio() {} setClearColor() {}
        render(scene, camera) { scene.updateMatrixWorld(); camera.updateMatrixWorld(); }
      }
    };
    const context = vm.createContext({ THREE, OrbitControls, window: win, document: doc, history, URL, URLSearchParams,
      get location() { return url; },
      Date: class extends Date { static now() { return now; } },
      performance: { now: () => now },
      console,
      requestAnimationFrame(cb) { nextFrame = cb; },
      setTimeout(cb, ms) { timers.set(++nextId, { cb, due: now + ms }); return nextId; },
      clearTimeout(id) { timers.delete(id); }, AbortController,
      async fetch(path, options) {
        assert.ok(path.startsWith('/api/'));
        const key = path.slice(5), call = (arrivals.get(key) || 0) + 1;
        const fixture = makeFixture(key, call);
        // Log before rejecting; fetch errors are legitimately caught by the page module.
        requests.push({ path, method:options?.method ?? 'GET' });
        assert.ok(fixture, 'unexpected endpoint ' + path);
        arrivals.set(key, call);
        if (held.get(key) === call) await new Promise((resolve, reject) => {
          options?.signal?.addEventListener('abort', () => { waiters.delete(key); reject(new DOMException('Timed out', 'AbortError')); }, { once:true });
          waiters.set(key, resolve);
        });
        return reply?.(key, call) ?? { ok: true, json: async () => fixture };
      }
    });
    // Evaluate the actual page module body, replacing only its imports and browser-provided boundaries.
    const program = clamp ? body.replace('controls.minDistance = ORGAN_MIN_DISTANCE;', 'controls.minDistance = WIDE_MIN_DISTANCE;') : body;
    const code = vm.compileFunction('return (async () => {' + program +
      '\nreturn { controls, gal, constNodes, camera }; })();', [], { parsingContext: context, filename: 'galaxy.html:module' });
    const scene = await code();
    async function advance(ms) {
      const until = now + ms;
      for (;;) {
        await new Promise(resolve => setImmediate(resolve));
        const next = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
        if (!next || next[1].due > until) break;
        now = next[1].due;
        timers.delete(next[0]); next[1].cb();
      }
      now = until;
    }
    function frame(count = 1, dt = 1 / 60) {
      for (let i = 0; i < count; i++) { elapsed += dt; nextFrame(); }
      return win.__galaxyDiag();
    }
    const element = id => doc.getElementById(id);
    const key = value => doc.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key: value }));
    return {
      ...scene, diag: () => win.__galaxyDiag(), element, frame, advance, key, history, requests, active: () => doc.activeElement,
      href: () => url.href, heading: () => element('galaxy-detail').heading?.textContent,
      detail: () => element('galaxy-detail').innerHTML, feed: () => element('feed').innerHTML,
      rail: k => element('rail').querySelector('[data-k="' + k + '"]'),
      organ: (k = 'watermark') => element('galaxy-organs').querySelector('[data-organ="' + k + '"]'),
      hold: (k, call) => held.set(k, call), arrived: k => arrivals.get(k) || 0,
      release(k) { assert.ok(waiters.has(k)); waiters.get(k)(); waiters.delete(k); }
    };
  }

  const dist = (a, b) => a.distanceTo(new Three.Vector3().fromArray(b));
  function close(value, expected, eps = 1e-8) {
    assert.ok(Number.isFinite(value) && Math.abs(value - expected) <= eps, 'expected ' + expected + ' ± ' + eps + ', got ' + value);
  }
  function measured(scene, diag, focus, limit) {
    const c = diag.cameraFrame;
    assert.equal(c.focus, focus);
    close(c.minDistance, limit);
    close(c.cameraTargetDist, scene.camera.position.distanceTo(scene.controls.target));
    close(dist(scene.camera.position, c.position), 0);
    close(dist(scene.controls.target, c.target), 0);
    return c;
  }
  function landed(scene, diag, gap, focus = 'organ') {
    assert.equal(diag.planetVisible, focus === 'organ');
    const c = measured(scene, diag, focus, focus === 'organ' ? 0.75 : 3.2);
    assert.ok(c.goalGap >= 0 && c.goalGap < gap, JSON.stringify(c));
    assert.ok(c.targetGap < gap, JSON.stringify(c));
    if (focus === 'organ') assert.ok(c.cameraTargetDist > 1 && c.cameraTargetDist < 1.5, JSON.stringify(c));
    else assert.ok(c.cameraTargetDist >= 3.2);
    close(c.cameraTargetDist, c.goalTargetDist, gap * 2);
    return c;
  }

  const reduced = await boot('/?sel=archive', true);
  assert.equal(reduced.diag().selected, 'archive');
  assert.match(reduced.heading(), /档案/);
  assert.match(reduced.detail(), /旋臂读数还没到/);
  assert.equal(reduced.arrived('status'), 0);
  reduced.hold('organs', 1);
  reduced.hold('status', 2);
  await reduced.advance(24000);
  assert.match(reduced.detail(), /夹具 archive/);
  assert.equal(reduced.arrived('organs'), 1);
  assert.equal(reduced.organ().textContent, 'watermark'); // arrival does not mean rendered
  reduced.release('organs');
  await reduced.advance(0);
  assert.match(reduced.organ().textContent, /夹具水位器官/);
  reduced.organ().onclick();
  assert.equal(new URL(reduced.href()).search, '?sel=archive&organ=watermark');
  assert.equal(reduced.heading(), organName);
  assert.ok(reduced.detail().includes(organValue));
  const rd = reduced.frame(1);
  const near = landed(reduced, rd, 1e-8);
  assert.equal(rd.galRotY, 0); assert.equal(rd.uTime, 0); assert.equal(rd.autoRotate, false);
  reduced.element('galaxy-up').onclick();
  assert.equal(reduced.diag().organ, null);
  landed(reduced, reduced.frame(100), 1e-8, 'arm');
  reduced.key('Escape');
  const home = measured(reduced, reduced.frame(), 'core', 3.2);
  close(home.goalGap, 0); close(home.targetGap, 0);
  assert.equal(reduced.frame().cameraFrame.goalGap, null);
  reduced.history.go(-1); assert.equal(reduced.diag().selected, 'archive');
  reduced.history.go(-1); assert.equal(reduced.diag().organ, 'watermark');
  reduced.history.go(1); assert.equal(reduced.diag().organ, null);
  reduced.history.go(1); assert.equal(reduced.diag().selected, null);
  assert.match(reduced.feed(), /701ms/);
  await reduced.advance(14000);
  assert.equal(reduced.arrived('status'), 2);
  assert.match(reduced.feed(), /701ms/); // second request reached fixture, not applied yet
  reduced.release('status');
  await reduced.advance(0);
  assert.match(reduced.feed(), /702ms/);
  assert.doesNotMatch(reduced.feed(), /渲染出错/);
  assert.equal(reduced.heading(), '核球');
  assert.equal(new URL(reduced.href()).search, '');
  assert.equal(reduced.diag().selected, null);
  reduced.key('4'); assert.equal(reduced.diag().selected, 'archive');
  assert.match(reduced.detail(), /夹具 archive<[/]b><span>2<[/]span>/);
  reduced.key('0'); assert.equal(reduced.diag().selected, null);

  // A direct L2 load holds the view while status and organ data arrive separately.
  const deep = await boot('/?sel=archive&organ=watermark', true);
  assert.equal(deep.heading(), 'watermark');
  assert.match(deep.detail(), /器官读数还没到/);
  landed(deep, deep.diag(), 1e-8);
  deep.hold('organs', 1);
  await deep.advance(24000);
  assert.equal(deep.arrived('status'), 1);
  assert.equal(deep.heading(), 'watermark');
  deep.release('organs');
  await deep.advance(0);
  assert.equal(deep.heading(), organName);
  assert.ok(deep.detail().includes(organValue));
  assert.match(deep.element('galaxy-crumb').textContent, /夹具水位器官/);
  assert.equal(new URL(deep.href()).search, '?sel=archive&organ=watermark');

  // Negative control: restore the original wide clamp only in memory. The post-controls
  // probe must report the displacement (the old pre-update goal-clearing metric could not).
  const clamped = await boot('/?sel=archive&organ=watermark', true, { clamp: true });
  const oldClamp = measured(clamped, clamped.diag(), 'organ', 3.2);
  close(oldClamp.cameraTargetDist, 3.2);
  close(oldClamp.goalGap, 3.2 - oldClamp.goalTargetDist);
  assert.throws(() => landed(clamped, clamped.diag(), 1e-8), assert.AssertionError);

  const normal = await boot('/', false);
  assert.equal(normal.diag().autoRotate, true);
  normal.rail('archive').onclick();
  const arm = landed(normal, normal.frame(180), 0.16, 'arm');
  normal.organ().onclick();
  const mid = measured(normal, normal.frame(6), 'organ', 0.75);
  assert.ok(mid.goalGap > 0.5 && mid.targetGap > 0.5);
  assert.ok(mid.cameraTargetDist < arm.cameraTargetDist && mid.cameraTargetDist > 1.5);
  const end = landed(normal, normal.frame(180), 0.08);
  const moving = landed(normal, normal.frame(120), 0.08);
  const [organ] = normal.constNodes[3];
  close(dist(organ.getWorldPosition(new Three.Vector3()), moving.target), moving.targetGap);
  assert.ok(new Three.Vector3().fromArray(end.target).distanceTo(new Three.Vector3().fromArray(moving.target)) > 0.05);
  assert.ok(new Three.Vector3().fromArray(end.position).distanceTo(new Three.Vector3().fromArray(moving.position)) > 0.05);
  assert.equal(normal.element('panel').style.left, '910.0px'); // right-docked detail pane stays opposite the left-side archive arm
  const mobile = await boot('/?sel=archive&organ=watermark', true, { width: 390, height: 844 });
  mobile.frame(1);
  const mobilePanel = mobile.element('panel');
  assert.equal(mobilePanel.style.left, '16px');
  assert.equal(mobilePanel.style.right, '16px');
  assert.equal(mobilePanel.style.top, 'auto');
  assert.equal(mobilePanel.style.bottom, '86px');
  assert.equal(mobilePanel.style.width, 'auto');
  assert.equal(mobilePanel.style.maxHeight, '42vh');
  assert.equal(mobilePanel.style.transform, 'none');
  mobile.element('galaxy-up').onclick();
  assert.equal(mobile.element('panel').style.bottom, '86px'); // overview after deselection remains in the mobile sheet slot
  assert.match(html, /@media\(max-width:760px\)\{body #panel\{left:16px;right:16px;top:auto;bottom:86px;width:auto;max-height:42vh;transform:none\}/);
  mobile.element('galaxy-up').onclick();
  normal.element('galaxy-up').onclick();
  const back = normal.frame().cameraFrame;
  assert.equal(back.focus, 'arm');
  assert.ok(back.cameraTargetDist > moving.cameraTargetDist && back.cameraTargetDist < 3.2, JSON.stringify(back));
  normal.key('2');
  const switched = normal.frame(4);
  assert.equal(switched.selected, 'vital');
  assert.equal(switched.cameraFrame.focus, 'arm');
  assert.equal(switched.cameraFrame.arm, 'vital');
  assert.equal(normal.heading(), '上下文管理');
  normal.key('Escape');
  assert.equal(normal.frame(4).cameraFrame.focus, 'core');
  const reset = normal.frame(180);
  assert.equal(normal.heading(), '核球');
  assert.equal(new URL(normal.href()).search, '');
  measured(normal, reset, 'core', 3.2);
  assert.equal(reset.autoRotate, true);
  assert.equal(reset.cameraFrame.goalGap, null);
  assert.equal(reset.planetVisible, false);
  close(reset.cameraFrame.targetGap, 0, 0.02);
  close(reset.cameraFrame.cameraTargetDist, Math.hypot(2.35, 4.55), 0.02);

  // Exercise vendored controls inputs without claiming OS/browser delivery of those inputs.
  function input(type, fields) { return Object.assign(new Event(type, { cancelable: true }), fields); }
  const canvas = reduced.element('c');
  const wide = reduced.frame(2).cameraFrame.cameraTargetDist;
  for (let i = 0; i < 30; i++) canvas.dispatchEvent(input('wheel', { deltaY: -100, deltaMode: 0 }));
  close(reduced.frame().cameraFrame.cameraTargetDist, 3.2);
  assert.ok(wide > 3.2);
  const theta = reduced.controls.getAzimuthalAngle();
  canvas.dispatchEvent(input('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 40, clientY: 40 }));
  canvas.dispatchEvent(input('pointermove', { pointerId: 1, pointerType: 'mouse', clientX: 100, clientY: 40 }));
  canvas.dispatchEvent(input('pointerup', { pointerId: 1, pointerType: 'mouse' }));
  assert.ok(Math.abs(reduced.controls.getAzimuthalAngle() - theta) > 0.01);
  reduced.key('4');
  reduced.frame();
  canvas.dispatchEvent(input('wheel', { deltaY: -100, deltaMode: 0 }));
  assert.equal(reduced.diag().organ, 'watermark');
  await reduced.advance(651);
  canvas.dispatchEvent(input('wheel', { deltaY: 100, deltaMode: 0 }));
  assert.equal(reduced.diag().organ, null);
  assert.equal(reduced.frame().cameraFrame.minDistance, 3.2);

  const invalid = await boot('/?sel=bad&organ=watermark&dust=1#keep', true);
  assert.equal(new URL(invalid.href()).search + new URL(invalid.href()).hash, '?dust=1#keep');
  assert.match(invalid.element('galaxy-link-note').textContent, /无效旋臂/);
  const fallback = await boot('/?sel=archive&c=0', true, { webgl: false });
  assert.equal(new URL(fallback.href()).search, '?sel=archive&organ=watermark');
  assert.equal(fallback.diag().webgl, false);
  assert.equal(fallback.diag().cameraFrame, null);
  assert.equal(fallback.element('fallback').style.display, 'block');
  fallback.key('Escape'); assert.ok(fallback.organ());
  fallback.organ().onclick(); assert.equal(fallback.diag().organ, 'watermark');
  fallback.element('galaxy-up').onclick(); assert.equal(fallback.diag().organ, null);

  const json = value => ({ ok:true, json:async () => value });
  const events = await boot('/', true, { reply: (k, call) => {
    if (k !== 'waker') return;
    if (call === 2) return { ok:false, status:500 };
    if (call === 3) return json({ ...emptyWaker(), file:privatePath, why:'文件不存在：' + privatePath });
    if (call === 4) return json(emptyWaker());
    if (call === 5) return json({ ...emptyWaker(), why:'解析失败：' + privatePath + privateBody });
    if (call === 6) return json({ ...emptyWaker(), counts:{ act:0 } });
  } });
  const W = (id, scene = events) => scene.element('waker-' + id);
  const state = (scene = events) => W('state', scene).dataset.state;
  const subtree = n => [n.textContent, n.innerHTML, ...n.children.map(subtree)].filter(Boolean).join(' ');
  const read = (scene = events) => W('load', scene).onclick();
  await events.advance(24000);
  assert.equal(W('ledger').hidden, true);
  assert.equal(events.arrived('waker'), 0);
  events.rail('events').onclick();
  assert.equal(events.heading(), 'Ⅵ · 事件');
  assert.equal(W('ledger').hidden, false);
  assert.equal(state(), 'idle');
  assert.match(W('count').textContent, /计数 — · 当前行数 —/);
  assert.equal(events.organ('waker').textContent, '台账');
  const tabs = W('tabs').children;
  assert.deepEqual(tabs.map(t => t.dataset.view), ['act', 'done', 'audit', 'auto']);
  tabs[2].onclick();
  await events.advance(50000);
  assert.equal(events.arrived('waker'), 0, 'navigation, tabs and multiple EP cycles do not scan the ledger');
  assert.doesNotMatch(events.detail(), /SYNTHETIC/);

  tabs[0].onclick();
  events.hold('waker', 1);
  W('load').focus();
  const firstRead = read();
  assert.equal(state(), 'loading');
  await read();
  assert.equal(events.arrived('waker'), 1, 'at most one in-flight ledger read');
  events.organ('waker').onclick();
  const organURL = events.href();
  assert.equal(new URL(organURL).search, '?sel=events&organ=waker');
  assert.equal(events.heading(), '台账');
  assert.equal(state(), 'loading');
  assert.doesNotMatch(events.detail(), /SYNTHETIC/);
  const camera = landed(events, events.frame(), 1e-8);
  const pane = events.element('panel');
  pane.scrollTop = 32;
  W('load').focus();
  events.release('waker');
  await firstRead;
  assert.equal(events.href(), organURL);
  assert.equal(pane.scrollTop, 32);
  assert.equal(events.active(), W('load'));
  assert.equal(events.diag().cameraFrame, camera);
  assert.equal(state(), 'ready');
  assert.match(W('count').textContent, /全本 250 条 · 此视图 205 条 · 当前列出 200 条（有界列表）/);
  assert.equal(W('rows').children.length, 200);
  const row = W('rows').children[0];
  assert.equal(row.children[0].tagName, 'summary');
  assert.equal(row.children[0].textContent, literalTitle, 'untrusted title is text, not markup');
  assert.equal(row.children[0].innerHTML, undefined);
  assert.match(subtree(row), /事件时间 2026-01-05T09:08:07.000Z.*来源 合成来源.*宪章判词 unchecked.*审计备注 合成审计备注.*台账备注 合成台账备注/);
  assert.deepEqual(tabs.map(t => t.children[1].textContent), ['205','1','0','1']);
  tabs[0].onkeydown(new Event('keydown'));
  tabs[0].onkeydown(Object.assign(new Event('keydown', { cancelable:true }), { key:'ArrowRight' }));
  assert.equal(events.active(), tabs[1]);
  assert.equal(tabs[1].attrs.get('aria-selected'), 'true');
  assert.equal(W('view').attrs.get('aria-labelledby'), 'waker-tab-done');
  assert.match(subtree(W('rows')), /合成执行判定.*台账阶段 done.*登记判定 resume.*含路径分隔符，已隐藏/);
  tabs[2].onclick();
  assert.match(W('count').textContent, /此视图 0 条 · 当前列出 0 条 · 此视图为空/);
  assert.equal(W('rows').children.length, 0);
  tabs[3].onclick();
  assert.match(subtree(W('rows')), /合成自主判定.*含路径分隔符，已隐藏.*宪章判词 pass/);
  assert.doesNotMatch(subtree(W('ledger')), /SYNTHETIC|not-for-display/);
  assert.equal(events.arrived('waker'), 1, 'switching tabs does not read again');
  await events.advance(60001);
  assert.equal(state(), 'stale');
  assert.match(W('state').textContent, /陈旧缓存 · 上次读取/);
  assert.equal(events.arrived('waker'), 1, 'expiry does not refresh');
  assert.equal(events.diag().organ, 'waker');
  await read();
  assert.equal(state(), 'stale');
  assert.match(W('state').textContent, /读取台账失败 · 陈旧缓存/);
  assert.equal(W('rows').children.length, 1, 'failed refresh keeps old rows visibly stale');
  await read();
  assert.equal(state(), 'stale');
  assert.match(W('state').textContent, /未读到台账.*陈旧缓存/);
  assert.doesNotMatch(subtree(W('ledger')), /SYNTHETIC|not-for-display/);
  await read();
  assert.equal(state(), 'ready');
  assert.match(W('count').textContent, /全本 0 条 · 此视图 0 条 · 当前列出 0 条 · 此视图为空/);
  await read();
  assert.match(W('state').textContent, /读取台账失败/);
  await read();
  assert.match(W('state').textContent, /读取台账失败/);
  assert.doesNotMatch(subtree(W('ledger')), /SYNTHETIC|not-for-display/);

  // Do not reopen or re-render a departed view when an in-flight GET finishes.
  events.hold('waker', 7);
  const late = read();
  events.key('0');
  const homeHeading = events.element('galaxy-detail').heading;
  const hiddenPanelState = W('state').textContent;
  events.release('waker');
  await late;
  assert.equal(W('ledger').hidden, true);
  assert.equal(W('state').textContent, hiddenPanelState);
  assert.equal(events.element('galaxy-detail').heading, homeHeading);
  assert.equal(new URL(events.href()).search, '');
  assert.equal(events.frame().cameraFrame.focus, 'core');
  events.history.go(-1);
  assert.equal(events.href(), organURL);
  assert.equal(state(), 'ready', 'late response was cached but applied only on intentional reentry');
  assert.match(W('count').textContent, /全本 250 条/);
  assert.equal(events.arrived('waker'), 7);
  events.element('galaxy-up').onclick();
  assert.equal(events.heading(), 'Ⅵ · 事件');
  assert.equal(state(), 'ready');
  assert.equal(events.arrived('waker'), 7);
  assert.equal(events.requests.filter(r => r.path === '/api/waker' && r.method === 'GET').length, 7);
  assert.ok(events.requests.every(r => r.method === 'GET' && !/decide|context/.test(r.path)));

  const cold = await boot('/?sel=events&organ=waker', true, { webgl:false, reply:(k, call) => {
    if (k !== 'waker') return;
    if (call === 1) return { ok:false, status:503 };
    if (call === 2) return json({ ...emptyWaker(), why:'没有 events 数组（格式不对）：' + privatePath });
    if (call === 3) return json({ ...emptyWaker(), why:'文件不存在：' + privatePath });
  } });
  assert.equal(cold.heading(), '台账');
  assert.equal(cold.arrived('waker'), 0);
  await read(cold);
  assert.equal(state(cold), 'missing');
  assert.match(W('count', cold).textContent, /计数 — · 当前行数 —/);
  await read(cold);
  assert.equal(state(cold), 'error');
  assert.match(W('count', cold).textContent, /计数 — · 当前行数 —/);
  await read(cold);
  assert.equal(state(cold), 'missing');
  cold.hold('waker', 4);
  const timedOut = read(cold);
  await cold.advance(12001);
  await timedOut;
  assert.equal(state(cold), 'error');
  assert.equal(cold.arrived('waker'), 4);
  assert.doesNotMatch(subtree(W('ledger', cold)), /SYNTHETIC|not-for-display/);

  const echo = await boot('/?sel=echo&echoLayer=L4', true, { reply:(k, call) => {
    if (k !== 'echo/authority-view') return;
    if (call === 2) return json({ sync:{configured:null,enabled:null,running:null,last:null}, sources:{available:null,aligned:null,rows:null}, freshness:{state:'unknown'}, query:{status:'not-queried'}, dbPath:privatePath, sourceRoot:privatePath, receiptFile:privatePath, error:privateBody });
  } });
  const authoritySection = echo.element('echo-authority'), authorityLoad = echo.element('echo-authority-load');
  await echo.advance(24000);
  assert.equal(echo.arrived('echo/authority-view'), 0, 'ECHO endpoint is not polled');
  assert.equal(authoritySection.hidden, false);
  assert.equal(echo.element('echo-authority-state').textContent.includes('未知'), true);
  assert.equal(echo.element('echo-authority-rows').children.length, 0);
  assert.equal(echo.requests.filter(r => r.path === '/api/echo/authority-view').length, 0);
  authorityLoad.onclick();
  assert.equal(echo.arrived('echo/authority-view'), 1, 'button performs one GET on demand');
  await new Promise(resolve => setImmediate(resolve));
  const authorityTree = n => [n.textContent, ...n.children.map(authorityTree)].join(' ');
  const authorityText = authorityTree(echo.element('echo-authority-rows'));
  assert.match(authorityText, /IMPORTED.*synthetic-attempt.*synthetic-commit.*committed.*generation.*12.*cursor.*55.*words.*4.*summaries.*2.*aligned.*true/);
  assert.match(echo.element('echo-authority-state').textContent, /新鲜度：未知.*query 未查询/);
  assert.doesNotMatch(authorityText, /SYNTHETIC_DIR|SYNTHETIC_SESSION_BODY|not-for-display|meta.sqlite|receiptFile|sourceRoot|dbPath/);
  assert.equal(echo.requests.filter(r => r.path === '/api/echo/authority-view' && r.method === 'GET').length, 1);
  assert.ok(echo.requests.filter(r => r.path === '/api/echo/authority-view').every(r => r.method === 'GET'), 'authority UI uses only its dedicated read-only endpoint');
  echo.element('galaxy-up').onclick();
  assert.equal(authoritySection.hidden, true);
  echo.key('4');
  assert.equal(echo.element('galaxy-detail').innerHTML.includes(organName), false, 'non-ECHO organ text is not mixed into authority surface');
  assert.equal(echo.arrived('echo/authority-view'), 1, 'navigating does not refresh authority');
  echo.key('1');
  assert.equal(authoritySection.hidden, true, 'authority is scoped only to ECHO L4');
  echo.element('echo-layer-tabs').children.find(button => button.dataset.layer === 'L4').onclick();
  assert.equal(authoritySection.hidden, false);
  echo.element('echo-layer-tabs').children.find(button => button.dataset.layer === 'L0').onclick();
  assert.match(echo.href(), /echoLayer=L0/);
  assert.match(echo.element('galaxy-crumb').textContent, /ECHO.*L0/);
  assert.equal(authoritySection.hidden, true);
  const beforeOutOfScopeRead = echo.arrived('echo/authority-view');
  authorityLoad.onclick();
  assert.equal(echo.arrived('echo/authority-view'), beforeOutOfScopeRead, 'authority GET is refused outside L4');
  echo.element('echo-layer-tabs').children.find(button => button.dataset.layer === 'L4').onclick();
  assert.equal(authoritySection.hidden, false);
  authorityLoad.onclick();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(echo.element('echo-authority-state').textContent, /未知.*query 未查询/);
  assert.doesNotMatch(authorityTree(echo.element('echo-authority-rows')), /SYNTHETIC_DIR|SYNTHETIC_SESSION_BODY|not-for-display/);

  const lateAuthority = await boot('/?sel=echo&echoLayer=L4', true);
  lateAuthority.hold('echo/authority-view', 1);
  const beforeLate = lateAuthority.href(), cameraBeforeLate = lateAuthority.diag().cameraFrame;
  const lateAuthorityRead = lateAuthority.element('echo-authority-load').onclick();
  assert.equal(lateAuthority.arrived('echo/authority-view'), 1);
  lateAuthority.key('6');
  const routeAfterDeparture = lateAuthority.href(), cameraAfterDeparture = lateAuthority.diag().cameraFrame;
  lateAuthority.release('echo/authority-view');
  await lateAuthorityRead;
  assert.equal(lateAuthority.href(), routeAfterDeparture, 'late authority response does not alter URL');
  assert.equal(lateAuthority.diag().cameraFrame, cameraAfterDeparture, 'late authority response does not alter camera');
  assert.equal(lateAuthority.element('echo-authority').hidden, true, 'departed ECHO scope is not reopened');
  assert.notEqual(routeAfterDeparture, beforeLate);
  assert.equal(cameraAfterDeparture, cameraBeforeLate, 'network completion does not drive camera');
  console.log('PASS ECHO authority: on-demand GET only, committed/unknown, redaction, scope separation and late response; no server/browser/DB.');
  console.log('ASSERTIONS_PASSED=' + assertionCount);
  console.log('PASS Events: on-demand GET only, shared L1/L2 cache, bounded counts, four tabs, text-only rows, empty/missing/error/stale and late response.');
  console.log('PASS Node: real vendored Three camera/OrbitControls, page module with synthetic clock/fetch/DOM and stub renderer; no browser.');
  console.log(JSON.stringify({ oldClamp, reducedLanding: near, arm, mid, normalLanding: end, normalTracking: moving, returnFirstFrame: back,
    reset: reset.cameraFrame, statusApplied: '701ms → 702ms; URL remained L0' }, null, 2));
  console.log('PENDING injected browser: pixel/layout/WebGL, DOM wait, applied poll, pointer/wheel/keyboard and history. See --serve-fixture /__checklist.');
}

async function serveFixture() {
  const checklist = [
    'Open the loopback URL using browser-skill only. This fixture never starts a browser.',
    'L1 cold /?sel=archive: visible heading 档案 and 旋臂读数还没到, then wait until #galaxy-detail contains 夹具 archive AND [data-organ=watermark] contains 夹具水位器官.',
    'Open the watermark button: URL ?sel=archive&organ=watermark, heading 夹具水位器官 and 水位 25%. For cold L2 repeat by direct link; pending organ detail must become real detail without reapplying the route.',
    'Use browser_inspect scoped HTML on #fixture-camera for the latest post-controls sample and first frame after a navigation. Wait until sample focus organ, cameraTargetDist 1.0–1.5, goalGap and targetGap < 0.1 in normal mode (near zero in reduced mode). With ordinary motion check early in-flight gap and take two settled samples: position and target both change while following the organ. Reduced mode must have zero scene angle/time and land on first frame.',
    'During a flight switch layers (e.g. key 2 then Esc); camera, breadcrumb, title and URL must converge on final layer. Test upper-level button, Esc, digits, history Back/Forward, wheel in/out when over canvas, and wide L0 zoom/drag. L0/L1 final minDistance=3.2.',
    'Return L0 before next status. Wait for #feed to show the next fixture marker (701ms → 702ms), not just for the request to be recorded. Then require URL without sel/organ and heading 核球; L1 reopened must show fixture value 2.',
    'Enter 事件 from the rail, then 台账 (also test the direct L2 link). No GET /api/waker until 读取台账. Inspect the four views, 205 counted vs 200 visible in act, the empty audit view, and literal markup in the first title. No raw path/body or execution receipt should appear. Use arrow keys to switch tabs without changing the location or camera.',
    'Also check invalid/legacy deep links with extra query/hash preserved, narrow panel bounds, and WebGL fallback (if authorized browser tests support disabling WebGL). Inspect runtime errors. Reduced-motion requires a browser environment with the actual media preference; do not fake it by altering production code.'
  ].join('\n\n');
  const evidence = `<pre id="fixture-camera" hidden></pre><script>
    let route, first, written = -Infinity;
    function observeFixture(t) {
      const d = window.__galaxyDiag?.();
      if (d && (!d.webgl || d.cameraFrame?.arm === d.selected && d.cameraFrame?.organ === d.organ)) {
        const key = JSON.stringify([d.selected, d.organ]);
        if (key !== route) { route = key; first = d.cameraFrame; }
        if (t - written >= 100) {
          document.getElementById("fixture-camera").textContent = JSON.stringify({ first, latest: d });
          written = t;
        }
      }
      requestAnimationFrame(observeFixture);
    }
    requestAnimationFrame(observeFixture);
  </script>`;
  const byPage = new Map();
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    if (path === '/__checklist') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(checklist); return; }
    if (path === '/' || path === '/galaxy.html') {
      byPage.clear();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html.replace('</body>', evidence + '</body>'));
      return;
    }
    const name = path.slice(1);
    if (files.has(name) && name !== 'galaxy.html') {
      res.writeHead(200, { 'Content-Type': name.endsWith('.css') ? 'text/css' : 'text/javascript' }).end(files.get(name));
      return;
    }
    if (path === '/favicon.ico') { res.writeHead(204).end(); return; }
    const key = path.slice(5);
    const call = (byPage.get(key) || 0) + 1;
    const fixture = path.startsWith('/api/') && makeFixture(key, call);
    if (fixture) {
      byPage.set(key, call);
      const send = () => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(fixture));
      if (key === 'organs' || key === 'status' && call > 1) setTimeout(send, 1200); else send();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  console.log('Synthetic fixture: http://127.0.0.1:' + server.address().port + '/');
  console.log('No browser launched. Checklist: /__checklist');
}
