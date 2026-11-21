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
  '/api/huanqi', '/mcp',
  // ★ 2026-11-22：`/api/waker/decide` 是**写判定**（记「要你执行 / 已执行 / 要审计」），在 `/api/waker` 下
  '/api/waker',
];

export function needsAuth(pathname, method) {
  const p = String(pathname || '');
  const m = String(method || '').toUpperCase();
  for (const g of GUARDED) if (p === g || p.indexOf(g + '/') === 0) return true;
  // ★ 2026-11-22：`POST /api/config` 会重写整份 config.json（含 apiKey / baseUrl / port / dataDir）。
  //   ★ 只卡 POST —— `GET /api/config` 是 safeDisplayOf 脱敏后的只读视图，settings 首屏要用。
  if (p === '/api/config' && m === 'POST') return true;
  if (p === '/api/sessions' && m === 'POST') return true;
  return false;
}

/** 只读白名单：**在任何鉴权/只读闸之前**就要放行的路径（界面靠它们活着）。 */
export const OPEN_READS = ['/api/health', '/api/vitals', '/api/questions'];
