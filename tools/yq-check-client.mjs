#!/usr/bin/env node
/**
 * 插件 client.js 静态自检（不需要 DSH 在跑，也不需要 CDP）
 *
 * ★ 为什么要有它：
 *   2026-11-01 部署 dsh-yanqing-perf 后立刻刷新，web boot 崩在
 *   `Loading plugins…`。事后的 node --check / sha / 冒烟全部正常，
 *   什么都查不出来 —— 因为查的是磁盘上写完的文件，而崩发生在写完之前。
 *
 *   所以真正的缺口不是"检查不够多"，是"没有一条能在部署前 3 秒跑完、
 *   覆盖 factory 真实行为的检查"。这个脚本补的就是那一格。
 *
 * ★ 它查什么（全部在 vm 沙箱里真跑，不是文本匹配）：
 *   ① 语法（vm.compileFunction）
 *   ② 顶层调 __ModuleLoader__.load 时 id 是否正确
 *   ③ factory 能不能执行、exports 有没有 apply / inject
 *   ④ apply(ctx) 在假 ctx 上会不会抛
 *   ⑤ 注入的 CSS 字符串内容（可选：断言必须包含哪些选择器）
 *
 * 用法：
 *   node yq-check-client.mjs <path/to/client.js> [期望的包名]
 */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const file = process.argv[2];
const expectId = process.argv[3] || null;
if (!file) {
  console.error('用法: node yq-check-client.mjs <client.js> [期望包名]');
  process.exit(2);
}

const src = readFileSync(file, 'utf8');
const problems = [];
const info = {};

/* ── ① 语法 ─────────────────────────────────────────────── */
try {
  new vm.Script(src, { filename: file });
  info.语法 = 'ok';
} catch (e) {
  problems.push(`语法错误: ${e.message}`);
}

/* ── ② 顶层执行：抓 __ModuleLoader__.load 的入参 ─────────── */
let captured = null;
const sandbox = {
  window: {
    __ModuleLoader__: {
      load: (row) => { captured = row; return row; },
    },
  },
  document: {
    head: { appendChild() {} },
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    querySelectorAll: () => [],
  },
  localStorage: {
    _v: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._v, k) ? this._v[k] : null; },
    setItem(k, v) { this._v[k] = String(v); },
  },
  console,
};
sandbox.globalThis = sandbox;

try {
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: file });
  info.顶层执行 = 'ok';
} catch (e) {
  problems.push(`顶层执行抛错: ${e.message}`);
}

if (captured) {
  info.注册id = captured.id;
  if (expectId && captured.id !== expectId) {
    problems.push(`id 不匹配: 文件里是 "${captured.id}"，期望 "${expectId}" —— 这正是 es 那种「全界面进不去」的错`);
  }
  if (typeof captured.factory !== 'function') {
    problems.push('load 的 factory 不是函数');
  }
} else {
  problems.push('顶层没有调用 window.__ModuleLoader__.load —— 整包会静默不加载');
}

/* ── ③ factory 执行 + exports ───────────────────────────── */
let mod = null;
if (captured && typeof captured.factory === 'function') {
  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    Fragment: 'Fragment',
  };
  const req = (name) => {
    if (name === 'react') return fakeReact;
    throw new Error(`未 mock 的依赖: ${name}`);
  };
  try {
    mod = captured.factory(req);
    info.factory执行 = 'ok';
    const keys = mod ? Object.keys(mod).sort() : [];
    info.exports = keys;
    if (!keys.includes('apply')) problems.push('exports 里没有 apply');
    if (!keys.includes('inject')) {
      problems.push('exports 里没有 inject —— 缺了它会整包静默不加载');
    }
  } catch (e) {
    problems.push(`factory 执行抛错: ${e.message}`);
  }
}

/* ── ④ apply 在假 ctx 上跑一遍 ──────────────────────────── */
if (mod && typeof mod.apply === 'function') {
  const calls = [];
  const fakeCtx = {
    slots: {
      inject: (name, fn) => { calls.push(['inject', name]); if (typeof fn === 'function') fn(); },
      register: (spec, comp) => { calls.push(['register', spec, comp]); return () => {}; },
    },
    logger: { info() {}, warn() {}, error() {} },
  };
  try {
    mod.apply(fakeCtx);
    info.apply执行 = 'ok';
    info.apply调用 = calls.map(c => c[0] + (c[1] && typeof c[1] === 'object' ? `(${c[1].name || ''})` : c[1] ? `(${c[1]})` : ''));
    const reg = calls.find(c => c[0] === 'register');
    if (reg) {
      const comp = reg[2];
      // ★ 这条是踩过的坑：第二个参数必须是组件本身，
      //   传 `() => h(Panel)` 会让整个顶栏一起消失。
      if (typeof comp !== 'function') {
        problems.push('slots.register 的第二参不是组件（会是 promise 而不是 function）');
      }
    }
  } catch (e) {
    problems.push(`apply 抛错: ${e.message}`);
  }
}

/* ── ⑤ CSS 内容断言（对本插件特定）──────────────────────── */
// ★ 第一版这里只去匹配 `const CSS = \`...\``，结果吃到的是
//   `${DENSE}{backdrop-filter:none...}` 这 82 个字符 —— 选择器全在
//   DENSE 数组里，一条都没检查到，却报"缺 5 个族"。假警报。
//   现在改成：先抓 DENSE 数组里的字符串字面量，拼成真实选择器串，再断言。
const denseBlock = src.match(/const\s+DENSE\s*=\s*\[([\s\S]*?)\]\.join/);
if (denseBlock) {
  // ★★ 这里踩过两次，都记在这儿：
  //   第一次只匹配 `const CSS = \`...\``，吃到的是 `${DENSE}` 那个模板，0 个族。
  //   第二次改用引号正则 `['"`]([^'"`]+)['"`]` —— 但属性选择器自带双引号，
  //   `'[class*="tableScroll"]'` 会被切成 `'[class*="` 和 `"]'`，
  //   中间的 tableScroll 正好掉在缝里，于是又报"缺 4 个族"。
  //   → 正确做法：按行切。本插件的风格是每个选择器单独一行、单个字符串字面量。
  const selectors = denseBlock[1]
    .split('\n')
    .map(l => l.replace(/\/\/.*$/, '').trim())          // 去掉行尾注释
    .filter(l => /^['"`].*['"`],?$/.test(l))             // 只留完整的字符串字面量行
    .map(l => l.replace(/^['"`]/, '').replace(/['"`],?$/, ''));
  const joined = selectors.join(',');
  info.选择器条数 = selectors.length;
  const families = {
    '标题 h1-h6': /h1,\s*h2,\s*h3/,
    '引用块 blockquote': /blockquote/,
    '正文 p': /> p/,
    '列表 ul/ol': /ul,\s*ol/,
    'codeBlock': /md-code-block/,
    'tableScroll': /tableScroll/,
    'callRow': /callRow/,
    'bubble': /bubble/,
    'title': /title/,
    'anchor': /anchor/,
    'overlayLayer': /overlayLayer/,
  };
  const hit = Object.entries(families).filter(([, re]) => re.test(joined)).map(([k]) => k);
  const miss = Object.entries(families).filter(([, re]) => !re.test(joined)).map(([k]) => k);
  info.选择器族 = `${hit.length}/${Object.keys(families).length}`;
  if (miss.length) problems.push(`DENSE 里缺少选择器族: ${miss.join(' / ')}`);
} else {
  info.选择器条数 = '(没有匹配到 const DENSE = [...]，如果不是本插件的格式可忽略)';
}

// CSS 规则本体（展开变量这一步做不到，只断言"有没有那条规则"）
if (!/backdrop-filter\s*:\s*none\s*!important/.test(src)) {
  problems.push('源码里没有 backdrop-filter:none !important —— 护栏等于没写');
}

/* ── 输出 ───────────────────────────────────────────────── */
const L = '─'.repeat(50);
// ★ 第一版这里打印的是 src.length（字符数），和资源管理器里看到的字节数差 214 B
//   （中文注释的 UTF-8 字节），差点被当成"文件变了"。字节数要显式算。
console.log(L);
console.log(`文件: ${path.basename(file)}  (${Buffer.byteLength(src, 'utf8')} B / ${src.length} 字符)`);
console.log(L);
for (const [k, v] of Object.entries(info)) {
  console.log(`  ${k.padEnd(10)}: ${Array.isArray(v) ? JSON.stringify(v) : v}`);
}
console.log(L);
if (problems.length) {
  console.log(`✗ ${problems.length} 个问题`);
  for (const p of problems) console.log(`  · ${p}`);
  process.exit(1);
} else {
  console.log('✓ 静态自检通过（语法 / id / factory / exports / apply / CSS 族）');
  process.exit(0);
}
