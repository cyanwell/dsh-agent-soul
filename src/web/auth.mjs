// src/web/auth.mjs —— 最小鉴权（批二收尾，2026-11-11）。
//
// ★ 为什么要有：按爀曦的定位，v4 是**要被别的平台接进去的基体**。
//   而 /api/turn 之前是**裸的** —— 这台机器上任何进程（我随手写的脚本、
//   某个被污染的书签、别的东西）都能指挥它干活，而它有 run_shell 和 edit_file。
//
//   **能被别人接，就得能被别人认得。** 这两件事是一体的。
//
// ★ 四条判据：
//   1. **只读不设卡**：/api/health、/api/vitals、/api/questions 谁都能看 ——
//      它们不含秘密、也不产生动作（管理界面要靠它们活着）。
//   2. **写/执行要 token**：/api/turn、/api/shutdown、/api/sessions(POST)、/api/answer、/api/guard。
//   3. **token 只在磁盘上**：<dataDir>/token.txt，0600，启动时若没有则生成。
//      ★ 不写进 config.json —— 那会被打包、被复制、被贴进日志。
//   4. **页面同源注入**：GET / 时把 token 内联进 HTML，前端用 fetch 拦截器自动带上。
//      **不新增一个「取 token」的 HTTP 口** —— 那种口等于把锁挂在门上。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function createAuth({ dataDir, log = () => {} } = {}) {
  const file = path.join(dataDir || '.', 'token.txt');
  let token = '';
  try { token = String(fs.readFileSync(file, 'utf8') || '').trim(); } catch { token = ''; }
  if (!token || token.length < 24) {
    token = crypto.randomBytes(24).toString('base64url');
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, token, { mode: 0o600 });
      log('鉴权 token 已生成（' + file + '，24 字节）');
    } catch (e) {
      log('鉴权 token 落盘失败：' + String((e && e.message) || e) + ' —— 本次运行用内存里的那份');
    }
  } else {
    log('鉴权 token 已加载（' + file + '）');
  }

  /** 从请求里取 token：头优先，其次 query。 */
  function presented(req, url) {
    const h = (req && req.headers) || {};
    const a = h['x-soul-token'] || h['authorization'];
    if (a) return String(Array.isArray(a) ? a[0] : a).replace(/^Bearer\s+/i, '').trim();
    try { return String(url.searchParams.get('token') || '').trim(); } catch { return ''; }
  }

  /** 定时安全比较 —— 本机其实不怕时序攻击，但不写一个坏示范。 */
  function eq(a, b) {
    const x = Buffer.from(String(a || ''));
    const y = Buffer.from(String(b || ''));
    if (x.length !== y.length) return false;
    try { return crypto.timingSafeEqual(x, y); } catch { return false; }
  }

  function ok(req, url) { return eq(presented(req, url), token); }

  return { token, file, ok, presented };
}

/** 需要 token 的路径（前缀匹配）。 */
// ★ 2026-11-12：加入 /api/session —— POST 会**真的叫醒一个会话**，是这台机器上副作用最大的一个口。
//   前缀匹配，所以 GET /api/session 也一并要 token（观测面本身不敏感，但少一个例外少一条要记的规矩）。
// ★★ 2026-11-22（#鉴权缺口）：**清单补全。**
//   下游实实测：`POST /api/config` 不带 token 就 200，且**真的写盘**（written:true + 新 mtime）。
//   它能重写 llm.baseUrl / apiKey / port / dataDir —— 而服务端**不校验 Origin**，
//   于是**浏览器里任意一个网页**发个 `text/plain` 的简单请求就能打中（不触发预检，CORS 都挡不住）。
//
//   ★ 补了 `/api/config`（只补 POST 那条语义，GET 是脱敏只读视图，settings 首屏要用）。
//   ★ 补了 `/api/huanqi` 前缀 —— context/purge 是**不可逆**的上下文清理，intervene 会动宿主。
//   ★ 补了 `/mcp` —— MCP 面里有 soul_index（写帧）、soul_cleanup（让宿主裁剪）、soul_ledger。
//
//   ★★ 但**清单不是最终解法**：外层包装层（core-entry.mjs:1106 起）在鉴权点之前就 return，
//     所以真正的闸提到外层 listener 最前面（见 core-entry 的 patchAuthAtOuterLayer）。
//     这里是**内层的兜底**，两层都判 = 新增路由漏一层还有另一层。
export const GUARDED = [
  '/api/turn', '/api/shutdown', '/api/answer', '/api/guard',
  '/api/restart', '/api/compact', '/api/session', '/api/manager-proof',
  '/mcp',
  // Waker reads are public read-only; only the charter/decision mutation requires the token.
  '/api/waker/decide',
];

export function needsAuth(pathname, method, req) {
  const p = String(pathname || '');
  const m = String(method || '').toUpperCase();
  for (const g of GUARDED) if (p === g || p.indexOf(g + '/') === 0) return true;
  // ★ 2026-11-22：`POST /api/config` 会重写整份 config.json（含 apiKey / baseUrl / port / dataDir）。
  //   ★ 只卡 POST —— `GET /api/config` 是 safeDisplayOf 脱敏后的只读视图，settings 首屏要用。
  if (p === '/api/config' && m === 'POST') return true;
  // ★★ 2026-11-22（第二版）：`/api/huanqi` **不能整个前缀挡**。
  //   我第一版写成 `'/api/huanqi'` 放进 GUARDED，实测把
  //   `panel` / `host-list` / `scan` 这些**只读**接口也 401 了 —— 而面板要用它们。
  //   ★ 判据：**鉴权该跟"会不会产生副作用"走，不跟路径前缀走。**
  //   报告原文点名的是四条写面：context/purge（不可逆）/ intervene / auto / analyze。
  const HUANQI_WRITES = ['/api/huanqi/context/purge', '/api/huanqi/intervene', '/api/huanqi/auto', '/api/huanqi/analyze'];
  for (const g2 of HUANQI_WRITES) if (p === g2 || p.indexOf(g2 + '/') === 0) return true;
  // ★★★ 2026-11-22（爀曦：顺带补）—— **aurabot 的两个接口面。**
  //
  //   洞在哪：`/api/aurabot`（状态聚合，走 adapters/aurabot-http.mjs）与
  //   `/aurabot/api/*`（模块动态路由：stickers / voice/* / memory/* …，走 aurabot/adapter/http.mjs）
  //   **两套都完全不鉴权** —— 实测无 token 全部 200。
  //
  //   为什么这个洞一直没人发现：`/aurabot` 页面的 `window.__SOUL_TOKEN` **永远是 undefined**
  //   （token 注入原来只写在首页那个分支里，PAGE_OF 那条路全是裸 readFileSync）。
  //   于是"页面不带 token"与"接口不要 token"**互相掩护**，两边看起来都正常。
  //
  //   ★ 判据：**一个洞不能用另一个洞来兜。** 两处必须一起补：
  //     ① server.mjs 的 injectPage() 让页面真拿到 token；
  //     ② 这里把接口面纳入鉴权。
  //   顺序不能反 —— 先加鉴权再注入，页面会先坏。
  if (p === '/api/aurabot' || p.indexOf('/api/aurabot/') === 0) return true;
  // ★★★ 2026-11-22 第三版 —— **上一版把这块面板整个锁死了，是爀曦报的。**
  //
  //   症状：面板显示「画板读不到插件：读不到插件状态。」
  //   原因：那块面板的 JS 是 aurabot 自带的 client.js（260KB，第三方代码），
  //   取数是 fetch('/aurabot/api' + p, { cache:'no-store' }) —— **裸 fetch，不带任何 header**。
  //   而本文件第 15 行那条判据「页面同源注入，前端拦截器自动带上」**只对 v4 自己的页面成立**，
  //   对搬进来的第三方前端**不成立** —— 我不会去改那 260KB。
  //
  //   ★ 所以这里换判据，不是降级：
  //     **这个口要挡的是什么？** 是「浏览器里随便一个网页发个请求就能操作我的插件」。
  //     那正好是 CSRF，而 CSRF 的特征是**跨站**。
  //     Sec-Fetch-Site 由浏览器自己填，跨站请求一定是 cross-site / same-site，
  //     **拿不到 same-origin**。所以判同源恰好挡住该挡的。
  //   ★ 不带这个头的（curl / 本机脚本）**照旧要 token** —— 它们才是真需要凭证的调用方。
  //     伪造这个头需要有在本机执行的能力，而那时他本来就能读 token.txt。**边界没松。**
  if (p === '/aurabot/api' || p.indexOf('/aurabot/api/') === 0) {
    const hh = (req && req.headers) || {};
    const sf = String(hh['sec-fetch-site'] || '').toLowerCase();
    // ★ 两道都认 —— 有的环境不发 Sec-Fetch-Site，但会发 Referer。
    //   面板再坏一次的代价（爀曦看到「读不到插件」）比多写这几行大得多。
    const ref = String(hh.referer || hh.referrer || '');
    const host = String(hh.host || '');
    let sameOriginByRef = false;
    if (ref && host) {
      try { sameOriginByRef = new URL(ref).host === host } catch {}
    }
    if (sf === 'same-origin' || sf === 'none' || sameOriginByRef) return false;
    return true;
  }
  if (p === '/api/sessions' && m === 'POST') return true;
  return false;
}

/** 只读白名单：**在任何鉴权/只读闸之前**就要放行的路径（界面靠它们活着）。 */
export const OPEN_READS = ['/api/health', '/api/vitals', '/api/questions'];
