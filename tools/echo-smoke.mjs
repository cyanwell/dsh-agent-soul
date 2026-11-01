#!/usr/bin/env node
/**
 * 回声面板渲染冒烟测试 v3（2026-11-01）
 *
 * v2 能抓运行时异常，但有个盲区：
 *   **它永远只渲染「数据还没来」那一帧。**
 *   因为 mock 的 useState 不保存状态、useEffect 不执行 ——
 *   而 CheckCard 只在 d.checks 有值时才会被渲染。
 *   于是「折叠改成 grid 过渡」这种改动，实测前后节点数完全一样（137 → 137），
 *   等于没验到。
 *
 * v3 补上两件事：
 *   ① useState 有状态：多轮渲染之间保留 value，setter 记下新值
 *   ② 两轮渲染：第一轮拿初始值（数据未到），把 setter 写入的值合并进状态，
 *      第二轮就是「数据到了」的样子 —— CheckCard 这才出现在树里
 *
 * ★ 仍然只验「不抛异常 + 结构」，不验 CSS 效果。
 *
 * 用法：node dsh-echo-smoke.mjs [client.js 路径]
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] || join(HERE, "dsh-yanqing-echo", "client.js");

let src;
try {
  src = readFileSync(target, "utf8");
} catch {
  console.error(`✗ 读不到 ${target}`);
  process.exit(1);
}

/* ── 有状态的 mock react ─────────────────────────────────── */
const hookStates = [];      // 跨轮持久：hookStates[i] = 当前值
const pendingSets = [];     // 本轮 setter 调用的新值
let hookIdx = 0;

const hookImpl = {
  useState(init) {
    const i = hookIdx;
    // 第二轮起用持久值；第一轮用初始值
    const cur = hookStates.length > i ? hookStates[i] : (typeof init === "function" ? init() : init);
    hookStates[i] = cur;
    return [cur, (v) => {
      const nv = typeof v === "function" ? v(hookStates[i]) : v;
      if (!pendingSets.some((p) => p.i === i)) pendingSets.push({ i, v: nv });
    }];
  },
  useEffect() { return undefined; },
  useLayoutEffect() { return undefined; },
  useMemo(fn) { return fn(); },
  useCallback(fn) { return fn; },
  useRef(v) { return { current: v }; },
  useContext() { return {}; },
  useReducer(_r, init) { return [init, () => {}]; },
  useId() { return "mock-id"; },
  useTransition() { return [false, () => {}]; },
  useDeferredValue(v) { return v; },
  useSyncExternalStore(_sub, get) { return get(); },
};

const mockReact = {
  version: "18.mock",
  createElement(type, props, ...children) { return { __vnode: true, type, props, children }; },
  Fragment: "Fragment",
  createContext() { return { Provider: "Provider", Consumer: "Consumer" }; },
  memo: (c) => c,
  forwardRef: (c) => c,
  cloneElement(el, props) { return { ...el, props: { ...(el.props || {}), ...(props || {}) } }; },
  isValidElement: (v) => !!(v && v.__vnode),
  Children: { toArray: (c) => (Array.isArray(c) ? c : [c]) },
};
for (const [k, fn] of Object.entries(hookImpl)) {
  mockReact[k] = (...a) => { const r = fn(...a); hookIdx++; return r; };
}

/* ── mock 宿主 ───────────────────────────────────────────── */
const cap = { packageId: null, factory: null, panels: [], injects: [] };

const noopEl = () => ({ style: {}, setAttribute() {}, appendChild() {}, remove() {}, classList: { add() {}, remove() {} } });
const fakeDoc = {
  documentElement: noopEl(), body: noopEl(), head: noopEl(),
  createElement: noopEl, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {}, visibilityState: "visible",
};

/* ★ 关键：/status 返回带 checks 的假数据，CheckCard 才会出现 */
const MOCK_STATUS = {
  overall: "warn",
  counts: { error: 0, warn: 1, ok: 2, pending: 0 },
  checks: [
    {
      id: "mock-warn", status: "warn", label: "冒烟假数据 · 警告项",
      detail: "用于让 CheckCard 出现在组件树里",
      evidence: { note: "smoke", at: "2026-11-01" },
    },
    { id: "mock-ok", status: "ok", label: "冒烟假数据 · 正常项", detail: "ok", evidence: { note: "ok" } },
  ],
  history: [],
  fastAgeMs: 1000, deepAgeMs: 2000, nextFastInMs: 30000,
  huanqi: { turns: [] },
};

const fakeWindow = {
  __ModuleLoader__: { load({ id, factory }) { cap.packageId = id; cap.factory = factory; } },
  document: fakeDoc,
  addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  setTimeout: () => 0, clearTimeout() {},
  setInterval: () => 0, clearInterval() {},
  getComputedStyle: () => ({ getPropertyValue: () => "", backgroundColor: "" }),
  fetch: (url) => {
    const u = String(url);
    let body = {};
    if (u.includes("/status")) body = MOCK_STATUS;
    else if (u.includes("/settings")) body = { budgetMB: 512 };
    else if (u.includes("/huanqi")) body = { turns: [] };
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  },
  MutationObserver: class { observe() {} disconnect() {} },
  ResizeObserver: class { observe() {} disconnect() {} },
  IntersectionObserver: class { observe() {} disconnect() {} },
  WebSocket: class { close() {} },
  EventSource: class { close() {} },
};

function fakeRequire(name) {
  if (name === "react") return mockReact;
  throw new Error(`未 mock 的 require: "${name}"`);
}

const sandbox = {
  window: fakeWindow, document: fakeDoc, require: fakeRequire, console,
  setTimeout: fakeWindow.setTimeout, clearTimeout: fakeWindow.clearTimeout,
  setInterval: fakeWindow.setInterval, clearInterval: fakeWindow.clearInterval,
  requestAnimationFrame: fakeWindow.requestAnimationFrame, cancelAnimationFrame: fakeWindow.cancelAnimationFrame,
  localStorage: fakeWindow.localStorage, matchMedia: fakeWindow.matchMedia,
  getComputedStyle: fakeWindow.getComputedStyle, MutationObserver: fakeWindow.MutationObserver,
  ResizeObserver: fakeWindow.ResizeObserver, fetch: fakeWindow.fetch,
  navigator: { userAgent: "smoke-test", language: "zh-CN" },
};
sandbox.globalThis = sandbox;

try {
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: target, timeout: 20000 });
} catch (e) {
  console.error("✗ 模块加载阶段抛异常：");
  console.error("   ", e.constructor.name, ":", e.message);
  if (e.stack) console.error(e.stack.split("\n").slice(1, 5).join("\n    "));
  process.exit(1);
}
console.log(`✓ 模块加载通过   id=${cap.packageId || "(未捕获)"}`);

if (!cap.factory) { console.error("✗ __ModuleLoader__.load 没被调用"); process.exit(1); }

let exp;
try { exp = cap.factory(fakeRequire); }
catch (e) { console.error("✗ factory() 抛异常：", e.message); process.exit(1); }
console.log(`✓ factory() 通过   apply=${typeof exp.apply}  inject=${JSON.stringify(exp.inject)}`);

const mockCtx = {
  slots: {
    inject(slot, cb) { cap.injects.push(slot); if (cb) cb(); },
    register(spec, Comp) { cap.panels.push({ spec, Comp }); },
  },
  on() {}, off() {}, emit() {}, get: () => undefined, set() {},
  logger: console, provide() {}, effect() {},
};

try { exp.apply(mockCtx); }
catch (e) {
  console.error("✗ apply(ctx) 抛异常：", e.message);
  if (e.stack) console.error(e.stack.split("\n").slice(1, 6).join("\n    "));
  process.exit(1);
}
console.log(`✓ apply(ctx) 通过   注册 ${cap.panels.length} 个面板`);

if (!cap.panels.length) { console.error("✗ 没注册任何面板"); process.exit(1); }

/* ── 递归展开 + 两轮渲染 ─────────────────────────────────── */
let componentCount = 0, nodeCount = 0;
const seen = new Set();
const MAX_DEPTH = 40;

function expand(v, depth) {
  if (v == null || depth > MAX_DEPTH) return v;
  nodeCount++;
  if (Array.isArray(v)) return v.map((c) => expand(c, depth + 1));
  if (typeof v !== "object" || !v.__vnode) return v;

  const name = typeof v.type === "function" ? (v.type.name || "(匿名)") : String(v.type);

  if (typeof v.type === "function") {
    componentCount++;
    seen.add(name);
    const saved = hookIdx;
    hookIdx = 0;
    let child;
    try {
      child = v.type({ ...(v.props || {}) });
    } catch (e) {
      console.error(`\n✗ ✗ 组件 <${name}> 渲染时抛异常 —— 这正是「面板整块空白」的原因：`);
      console.error(`    ${e.constructor.name}: ${e.message}`);
      if (e.stack) console.error(e.stack.split("\n").slice(1, 7).map((l) => "      " + l.trim()).join("\n"));
      process.exit(1);
    }
    hookIdx = saved;
    return { ...v, children: [expand(child, depth + 1)] };
  }

  const kids = v.children;
  return { ...v, children: Array.isArray(kids) ? kids.map((c) => expand(c, depth + 1)) : [expand(kids, depth + 1)] };
}

const { Comp } = cap.panels[0];
const comp = typeof Comp === "function" ? Comp : Comp && Comp.render;

function renderOnce() {
  hookIdx = 0;
  let r;
  try { r = comp({}); }
  catch (e) {
    console.error("✗ 入口组件抛异常：", e.message);
    process.exit(1);
  }
  return expand(r, 0);
}

/* 第一轮：初始状态（数据未到） */
const pass1 = renderOnce();
const n1 = nodeCount; nodeCount = 0;
const c1 = componentCount; componentCount = 0;

/* ★ mock 的 useEffect 不执行 ⇒ fetch 从没被调用 ⇒ setD 从没被调用。
   所以「等 setState」这条路走不通。

   换个办法：第一轮已经把每个 useState 的**初始值**记进了 hookStates。
   数据槽的特征很明确 —— **初始值是 null 或 undefined**（useState(null)）。
   把这些槽位统统灌成 MOCK_STATUS，第二轮就是「数据到了」的样子。

   ★ 为什么敢这么灌：如果灌错槽位，第二轮会抛异常或结构崩 —— 冒烟会立刻报出来。
     也就是说「灌错」本身是安全的，会被下一道判据拦住。 */

let probeSlots = [];
for (let i = 0; i < hookStates.length; i++) {
  if (hookStates[i] == null) probeSlots.push(i);
}
const applied = pendingSets.length;
for (const { i, v } of pendingSets) hookStates[i] = v;
pendingSets.length = 0;
for (const i of probeSlots) hookStates[i] = MOCK_STATUS;
console.log('   探查到的数据槽：' + (probeSlots.length ? probeSlots.join(', ') : '(无)'));

/* 第二轮：有数据 */
const pass2 = renderOnce();
const n2 = nodeCount;
const c2 = componentCount;

console.log(`✓ 第一轮（数据未到）  组件=${c1}  节点=${n1}`);
console.log(`✓ 第二轮（数据已到）  组件=${c2}  节点=${n2}   （setState ${applied} 个）`);

const names = [...seen];
console.log(`   出现过的组件：${names.join(", ")}`);

/* ── 判据 ───────────────────────────────────────────────── */
let bad = 0;

if (c2 < 2) { console.error("✗ 第二轮组件数 < 2 —— 测试太浅"); bad++; }

/* ★ 核心判据：有数据时必须出现 CheckCard（折叠卡片） */
if (!seen.has("CheckCard")) {
  console.error("✗ 组件树里没有 CheckCard —— 说明 mock 数据没被用上，折叠那条路径**没被测到**");
  bad++;
} else {
  console.log("✓ CheckCard 已被渲染（折叠路径覆盖到了）");
}

/* ★ 第二轮应该比第一轮多节点（数据把内容撑起来了） */
if (n2 <= n1) {
  console.error(`✗ 第二轮节点数(${n2}) 没超过第一轮(${n1}) —— mock 数据可能没生效`);
  bad++;
} else {
  console.log(`✓ 数据撑起了内容：${n1} → ${n2} 节点（+${n2 - n1}）`);
}

if (bad) {
  console.error(`\n✗ 冒烟失败（${bad} 项）`);
  process.exit(1);
}

console.log("\n═══════════════════════════════════════════");
console.log("  冒烟通过：两轮渲染 + CheckCard 覆盖");
console.log("  ★ 仍只证明「不抛异常 + 结构对」，不证明好看或交互手感");
console.log("═══════════════════════════════════════════");
process.exit(0);
