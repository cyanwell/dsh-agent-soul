// MCP over stdio —— 写者收口（2026-11-09）
//
// ★ 要解决的问题（实测过，不是设想）：
//   DSH 的 mcp-hub 以 stdio 拉起 mcp.mjs；它 import mcp-tools.mjs，后者 store() 一被调
//   就 new SessionStore —— **两个进程各持一套写句柄写同一批 frames.jsonl**。
//   更糟的是 _index.cache：两边各写整份指纹文件，最后一个写完的赢，
//   而输的那边内存里还留着旧索引 —— **数据不是慢慢坏的，是对不上的**。
//
// ★ 收口只有一条铁律：**写只允许有一个人。**
//   ① 7310 主服务在线 → 本进程**不开 store、不写任何文件**，tools/call 全转过去；
//   ② 主服务不在线 → 本进程**只读打开**（写方法一律抛 SOUL_OFFLINE），写工具全拒；
//   ③ 一旦确认过在线 → **永久锁定代理**，主服务中途挂掉也**绝不落回本机写**
//      （「反正它挂了，我写一下」正是双写的入口）。
//
// ★ 只读为什么能成立：store 的读路径（list/load/buildIndex/search）只读盘，
//   写只发生在 append/create/closeAll/saveIndexCache —— 见 src/session/store.mjs:234-260,388-392。
//   所以只要把那几个方法挡死，读就是安全的。**挡死这件事必须由结构保证，不能靠自觉。**

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, appRoot } from '../config.mjs';
import { classifyMcpCall } from '../security/write-manifest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

/** 探测缓存窗口。主服务起/停都在 2 秒内被看见，又不至于每个 call 都探一次。 */
export const PROBE_TTL_MS = Number(process.env.SOUL_PROBE_TTL_MS) || 2000;
/** 探测超时：500ms。本机回环正常是 1-3ms，500ms 已经足够宽松。 */
export const PROBE_TIMEOUT_MS = Number(process.env.SOUL_PROBE_TIMEOUT_MS) || 500;
/** 转发超时：soul_ask_host 可能要等宿主 15s，所以默认给 20s。 */
export const FORWARD_TIMEOUT_MS = Number(process.env.SOUL_HUB_TIMEOUT_MS) || 20000;

/**
 * 主服务地址。
 * ★ SOUL_HUB_URL 优先 —— 自检要用它指向随机端口的假服务，
 *   否则「测的是真服务」这件事永远只能靠人赌咒。
 */
let _hubBase = null;
export function hubBase() {
  if (_hubBase) return _hubBase;
  const env = String(process.env.SOUL_HUB_URL || '').trim();
  if (env) { _hubBase = env.replace(/\/+$/, ''); return _hubBase; }
  let port = 7310;
  // ★ 2026-11-10（G2a）：与 mcp-tools.mjs:86 同一处修正 —— 走 appRoot() 而不是写死 ROOT，
  //   否则隔离环境（AGENT_SOUL_HOME=临时目录）下这一层仍然去探**生产**端口，
  //   等于「隔离了数据但没隔离路由」。没设 HOME 时 appRoot() === ROOT，生产行为不变。
  try { port = Number(loadConfig(path.join(appRoot(), 'config.json')).port) || 7310; } catch { /* 没配就是 7310 */ }
  _hubBase = 'http://127.0.0.1:' + port;
  return _hubBase;
}

/** 探一次：GET /api/health，超时 500ms。只判「端口上有人且认得是 agent-soul」。 */
export function probeHub({ timeoutMs = PROBE_TIMEOUT_MS, base = hubBase() } = {}) {
  return new Promise((resolve) => {
    const at = Date.now();
    let done = false;
    const finish = (online, err) => {
      if (done) return;
      done = true;
      resolve({ online, err: err || null, at, ms: Date.now() - at, base });
    };
    let req;
    try {
      req = http.get(base + '/api/health', { timeout: timeoutMs }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { if (body.length < 8192) body += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) return finish(false, 'HTTP ' + res.statusCode);
          let j = null;
          try { j = JSON.parse(body); } catch { /* 下面判 */ }
          // ★ 只认「像 agent-soul 的 /api/health」：ok / sessions / tools 至少有一个。
          //   否则「端口有人」会被误判成「主服务在」——那正是把写权交出去的判据。
          const looksLikeSoul = Boolean(j && (j.ok !== undefined || j.sessions !== undefined || j.tools !== undefined));
          finish(looksLikeSoul, looksLikeSoul ? null : '端口有响应，但不像 agent-soul 的 /api/health');
        });
      });
      req.on('timeout', () => { try { req.destroy(); } catch {} finish(false, 'timeout ' + timeoutMs + 'ms'); });
      req.on('error', (e) => finish(false, String((e && e.code) || (e && e.message) || e)));
    } catch (e) { finish(false, String((e && e.message) || e)); }
  });
}

/** 把一条 JSON-RPC 原样 POST 给主服务的 /mcp，回它返回的那条。 */
export function forwardRpc(msg, { base = hubBase(), timeoutMs = FORWARD_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(msg);
    let u;
    try { u = new URL(base + '/mcp'); } catch { return reject(Object.assign(new Error('主服务地址不合法：' + base), { code: 'SOUL_HUB_BAD' })); }
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { out += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          const e = new Error('主服务 HTTP ' + res.statusCode + '：' + out.slice(0, 160));
          e.code = 'SOUL_HUB_HTTP';
          return reject(e);
        }
        try { resolve(JSON.parse(out)); }
        catch { reject(Object.assign(new Error('主服务回的不是 JSON-RPC：' + out.slice(0, 160)), { code: 'SOUL_HUB_BAD' })); }
      });
    });
    req.setTimeout(timeoutMs, () => {
      try { req.destroy(); } catch {}
      reject(Object.assign(new Error('主服务超时 ' + timeoutMs + 'ms'), { code: 'SOUL_HUB_TIMEOUT' }));
    });
    req.on('error', (e) => reject(Object.assign(new Error(String((e && e.code) || (e && e.message) || e)), { code: 'SOUL_HUB_DOWN' })));
    req.write(body);
    req.end();
  });
}

/**
 * 哪些调用是「会落盘的」。
 *
 * ★★ 2026-11-10（G2a）：**判据搬走了** —— 现在只有一份，在 src/security/write-manifest.mjs。
 *   这里保留函数名（stdio 腿和 tools/stdio-writer-guard-selftest.mjs 都在用），
 *   但**不再自己写清单**。
 *
 * ★ 为什么要搬：这份清单、HTTP 腿（原先没有判据）、和总方案 §二.5 的表各判各的，
 *   已经漂过一次 —— soul_autonomy 被列在这里，注释说「会写 autonomy.json」，
 *   而那个写点在 organs/autonomy.mjs 的 recordRun() 里，**压根不在 soul_autonomy 的调用链上**
 *   （check() 只读内存里的 state）。方向是 fail-closed，所以没出过事；
 *   但它证明了一件更要紧的事：**两份判据一定会漂，只是早晚**。
 *
 * ★ WRITE_TOOLS 没删：它现在只是「无条件算写」的那几个工具的名字，给人看。
 *   **它不是判据** —— 判据只有 classifyMcpCall()，连 isWriteCall 也走它。
 *   （漏判一个写工具会毁数据，错判一个读工具只是少个功能，所以方向仍然是宁可从宽。）
 */
export const WRITE_TOOLS = new Set([
  'soul_index',    // 写 frames.jsonl + index.jsonl
  'soul_compact',  // 写压缩帧
  'soul_ask_host', // 派活给宿主 —— 宿主能干什么我们不知道，一律不当读
  'soul_cleanup',  // 2026-11-10 E 切片：裁剪发生在宿主那边，同样不能当读
]);

export function isWriteCall(name, args) {
  return classifyMcpCall(name, args).write;
}

export function normMode(v) {
  const m = String(v || '').trim().toLowerCase();
  if (m === 'proxy' || m === 'standalone' || m === 'auto') return m;
  return 'auto';
}

/**
 * 路由状态机。
 *
 *   auto（默认）        探 7310 → 在线=proxy(锁死) / 不在线=offline(只读+写全拒)
 *   proxy              永远转发；**永不落回本机**（主服务挂了就报错，不写）
 *   standalone         永远本机读写（= 今天的行为，显式认领单写者责任时才用）
 *
 * ★ latched 是关键：auto 模式下只要**确认过一次在线**，之后就不再考虑本机。
 *   没有它的话，「主服务刚好在探测窗口里挂了」= 静默变成本机写 = 双写。
 */
export class StdioRouter {
  constructor() {
    this.mode = normMode(process.env.SOUL_STDIO_MODE);
    this.route = null;      // 'proxy' | 'offline' | 'standalone'
    this.latched = false;   // 走过代理就锁死，不再回本机
    this.onlineAt = null;   // 最近一次确认在线的时刻（ms）
    this.lastProbe = null;
    this.probes = 0;
    this.initAt = null;
  }

  async init() {
    this.initAt = Date.now();
    if (this.mode === 'standalone') { this.route = 'standalone'; return this.route; }
    if (this.mode === 'proxy') { this.route = 'proxy'; this.latched = true; return this.route; }
    await this.refresh(true);
    return this.route;
  }

  /** 是否该重探。latched 之后不再探（探也没用：已经不能回本机了）。 */
  async refresh(force) {
    if (this.latched) { this.route = 'proxy'; return this.route; }
    const now = Date.now();
    if (!force && this.lastProbe && now - this.lastProbe.at < PROBE_TTL_MS) return this.route;
    const p = await probeHub();
    this.probes++;
    this.lastProbe = p;
    if (p.online) {
      this.onlineAt = p.at;
      this.latched = true;
      this.route = 'proxy';
    } else {
      this.route = 'offline';
    }
    return this.route;
  }

  /** 处理一条 tools/call 时问它：现在算哪种。 */
  async routeNow() {
    if (this.route === 'standalone') return 'standalone';
    if (this.latched) return 'proxy';
    return this.refresh(false);
  }

  async forward(msg) {
    const r = await forwardRpc(msg);
    this.onlineAt = Date.now();   // 转发成功 = 确认在线
    return r;
  }

  /** staleSince：最后一次确认在线的时间。从没在线过就是 null —— 不编一个时间。 */
  get staleSince() {
    return this.onlineAt ? new Date(this.onlineAt).toISOString() : null;
  }

  get probedAt() {
    return this.lastProbe ? new Date(this.lastProbe.at).toISOString() : null;
  }

  get probeError() {
    return this.lastProbe ? this.lastProbe.err : null;
  }

  describe() {
    const hub = hubBase();
    if (this.route === 'proxy') {
      return '路由=proxy → ' + hub + '/mcp（本进程不开 store、不写任何文件）';
    }
    if (this.route === 'standalone') {
      return '路由=standalone（SOUL_STDIO_MODE 显式指定）—— 本进程是本机唯一的写者，风险自负';
    }
    return '路由=offline（' + hub + ' 不可达：' + (this.probeError || '未知') + '）—— 只读打开，写工具全拒';
  }
}

/** 离线时给读工具挂的那块结构化尾巴。读结果原样保留，降级单独放一条 content。 */
export function degradedBlock(router, extra) {
  return {
    degraded: true,
    status: 'degraded',
    code: 'SOUL_OFFLINE',
    staleSince: router.staleSince,
    probedAt: router.probedAt,
    probeError: router.probeError,
    hub: hubBase(),
    note: '7310 主服务不在线：本进程以只读方式打开会话存储（写方法被结构挡死），' +
      '所以这条读结果可能落后于最后一次在线时刻（staleSince）。写操作一律拒绝。',
    ...(extra || {}),
  };
}

/** 写工具在离线时的拒绝体。★ 拒绝就说清拒绝，不软化、不给「大概行」。 */
export function rejectedBlock(router, name, args, extra) {
  return {
    ok: false,
    status: 'rejected',
    code: 'SOUL_OFFLINE',
    tool: String(name || ''),
    action: isWriteCall(name, args) ? 'write' : 'unknown',
    hub: hubBase(),
    staleSince: router.staleSince,
    probedAt: router.probedAt,
    probeError: router.probeError,
    why: '7310 主服务不在线。本进程不开写句柄 —— 两个 SessionStore 写同一批 frames.jsonl，' +
      '坏的不是某一帧，是 _index.cache 的整份指纹（最后写完的赢，另一边内存里还是旧的）。',
    howToFix: [
      '启动 agent-soul 主服务（桌面图标 / node src/index.mjs）—— 本进程 2 秒内自动切回代理，无需重启 DSH；',
      '或显式认领单写者：给 DSH 的 mcp-hub 配 SOUL_STDIO_MODE=standalone（那时务必确保主服务不起）。',
    ],
    ...(extra || {}),
  };
}

/** 主服务中途挂掉时的拒绝体 —— 和「一开始就不在线」分开写，因为处置不一样。 */
export function hubDownBlock(router, name, err) {
  return {
    ok: false,
    status: 'rejected',
    code: 'SOUL_HUB_DOWN',
    tool: String(name || ''),
    hub: hubBase(),
    staleSince: router.staleSince,
    error: String((err && err.message) || err),
    why: '主服务刚刚还在，这次转发失败了。★ 本进程**没有**因此落回本机执行 —— ' +
      '「它挂了我就写一下」正是双写的入口，所以这里选择失败而不是写。',
    howToFix: '确认主服务是否还活着（curl http://127.0.0.1:7310/api/health）；起来之后本进程会自动恢复转发。',
  };
}

/** 工具自检用：不启动进程，直接看这套判据怎么分。 */
export function classify(name, args) {
  return { tool: name, write: isWriteCall(name, args) };
}
