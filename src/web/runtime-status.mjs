// 概览页 · 运行状态只读聚合（2026-11-10 · overview-status-panels）
//
// 四块，两个侧：
//   v4 侧（本进程 = agent-soul core） 控制通道（谁连上来了）· 模型（LLM 运行统计）
//   DSH 侧（宿主 DSH 的只读接口）      MCP Hub（服务 / 工具）· 心跳倒计时（自主计时器）
//
// ★★ 这个文件的价值，一半在它**拒绝**做的三件事上：
//   ① 不写盘、不重连、不动自主开关 —— 这里只有 GET。MCP Hub 的写路由一条都没碰。
//   ② 读不到就写 unavailable / UNCONFIGURED，**绝不拿 0 顶**：
//      0 和「没读到」长得一模一样，而这一屏就是拿来判断「通不通」的。
//   ③ **不猜端口**：DSH 每次重启换一个端口（本机实测 59174 → 57099 → 56207 → 57763 → 62775），
//      所以地址**绝不硬编码**，也不替谁试一个数字。
//      ★ 2026-11-11 补：但「没配」不等于「不知道」—— 本机有心跳插件写下的 dsh-origin.txt
//        与 DSH 启动日志，organs/dsh-origin.mjs 已经会读它们。这里接上那条发现链：
//        **读事实**（不是猜数字），读不到才回落 UNCONFIGURED。
//        这一条的由来：软件版（分发树）没有开发机上那份 config，于是两块面板一直是
//        UNCONFIGURED —— 而端口其实就明写在 dsh-origin.txt 里。

import { discoverDshOrigin, dshLogDirOf, dshOriginFileOf } from '../organs/dsh-origin.mjs';

export const SIDES = Object.freeze({ v4: 'v4', dsh: 'dsh' });

// ★ 2026-11-11：与 config.mjs 的 integrations.timeoutMs 同步（1500 → 5000）。
//   两处默认值必须一起改 —— 这正是「同一个数写两遍」的老坑。
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_STALE_MS = 30000;
// 倒计时本该到点却没动多久，判「数据被卡住了」（不是「还没到点」）
const STUCK_MS = 120000;
const UNHELLO = '(未 hello)';

const SECRET_STRIPS = [
  [/bearer\s+[A-Za-z0-9._\-]{6,}/gi, 'Bearer ***'],
  [/\b(?:sk|rk|pk)-[A-Za-z0-9._\-]{6,}/g, 'key-***'],
  [/\b(api[_-]?key|token|secret|password|passwd)\s*[=:]\s*[^\s,;'"}]+/gi, '$1=***'],
  [/https?:\/\/[^/\s@]+@/g, 'http://***@'],
];

/** 对外可见的错误文本：先脱敏再截断。★ 任何要进响应/日志的异常都走这里。 */
export function sanitizeError(msg, max = 300) {
  let s = String(msg == null ? '' : msg);
  for (const [re, rep] of SECRET_STRIPS) s = s.replace(re, rep);
  s = s.replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

function intOrNull(v) { return Number.isFinite(v) ? Math.round(v) : null; }
function strOrNull(v, max = 200) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}
function boolOrNull(v) { return typeof v === 'boolean' ? v : null; }

/** 'http://host:port/' → { configured, url, error }。★ 凭据一律剥掉：面板不该回显密码。 */
export function parseHttpUrl(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return { configured: false, url: null, error: null };
  let u;
  try { u = new URL(s); } catch { return { configured: true, url: null, error: '不是合法 URL（' + sanitizeError(s, 80) + '）' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { configured: true, url: null, error: '只接受 http(s)，收到 ' + u.protocol };
  }
  if (u.username || u.password) { u.username = ''; u.password = ''; }
  return { configured: true, url: u.toString().replace(/\/+$/, ''), error: null };
}

export function joinUrl(base, suffix) {
  const b = String(base || '').replace(/\/+$/, '');
  const s = String(suffix || '');
  return b + (s.startsWith('/') ? s : '/' + s);
}

/**
 * 自动发现当前 DSH 的 origin（读 dsh-origin.txt / 启动日志，**不发任何请求**）。
 * ★ 3 秒缓存：心跳卡每次刷新都会问一次，而这是两次 stat + 一次小文件读。
 * ★ 发现失败不抛 —— 它只是「另一条来源」，不是必经之路。
 */
const DISCOVER_TTL_MS = 3000;
let _disc = { at: 0, origin: null, why: null };
function discoveredOrigin(cfg, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (now - _disc.at < DISCOVER_TTL_MS) return _disc;
  let origin = null, why = null;
  try {
    const r = discoverDshOrigin({ logDir: dshLogDirOf(cfg), originFile: dshOriginFileOf(cfg), now });
    if (r && r.ok === true && r.origin) origin = r.origin;
    else why = (r && r.why) || '发现不到 DSH origin';
  } catch (e) {
    why = sanitizeError(e && e.message || e, 160) || '发现 DSH origin 时抛错';
  }
  _disc = { at: now, origin, why: why ? sanitizeError(why, 200) : null };
  return _disc;
}

/** MCP Hub 的口：integrations.mcpHubUrl 优先，其次 integrations.dshBaseUrl，再次自动发现。 */
export function hubUrlOf(cfg) {
  const it = (cfg && cfg.integrations) || {};
  const own = parseHttpUrl(it.mcpHubUrl);
  if (own.configured) return { ...own, url: own.url ? joinUrl(own.url, '/mcp-hub/servers') : null };
  const base = parseHttpUrl(it.dshBaseUrl);
  if (base.configured) return { ...base, url: base.url ? joinUrl(base.url, '/mcp-hub/servers') : null };
  const d = discoveredOrigin(cfg);
  if (d.origin) {
    return { configured: true, url: joinUrl(d.origin, '/mcp-hub/servers'), error: null, source: 'discovered', foundAt: d.origin };
  }
  return { configured: false, url: null, error: null, discoverWhy: d.why || null };
}

/** 心跳的口：integrations.heartbeatUrl（整条）优先，其次 dshBaseUrl，再次自动发现。 */
export function heartbeatUrlOf(cfg) {
  const it = (cfg && cfg.integrations) || {};
  const own = parseHttpUrl(it.heartbeatUrl);
  if (own.configured) return own;
  const base = parseHttpUrl(it.dshBaseUrl);
  if (base.configured) return { ...base, url: base.url ? joinUrl(base.url, '/heartbeat/auto') : null };
  const d = discoveredOrigin(cfg);
  if (d.origin) {
    return { configured: true, url: joinUrl(d.origin, '/heartbeat/auto'), error: null, source: 'discovered', foundAt: d.origin };
  }
  return { configured: false, url: null, error: null, discoverWhy: d.why || null };
}

// ═══════════════════════════════════════════════════════════════════════
// 一 · 控制通道（v4 侧）
//
// ★★ 这里修的是一个**静默丢字段**的 bug：hub.mjs 的 snapshot() 早就带了 meta，
//   而 server.mjs 的 /api/overview 在映射时只抄了 id/host/caps/stubs/connectedAt ——
//   于是桥接在 hello.meta 里报的 pid / plugin / version / contextWindow /
//   contextTokens / watermarkSource **一个都没到过界面**。
//   丢字段不会报错，只会让人以为「宿主没报」—— 那正是最难查的一类。
//   ★ 未知字段不抄值（防未来的 meta 里混进凭据），但**抄下键名**：meta 里有啥，面板上看得见。
// ═══════════════════════════════════════════════════════════════════════

const SENSITIVE_KEY = /^(api[_-]?key|apikey|key|token|secret|password|passwd|authorization|cookie|credential|credentials|bearer)$/i;

export function buildControlView(snapshot) {
  const hosts = Array.isArray(snapshot) ? snapshot : [];
  const rows = hosts.map((h) => {
    const m = (h && h.meta && typeof h.meta === 'object') ? h.meta : {};
    const keys = Object.keys(m).filter((k) => !SENSITIVE_KEY.test(k));
    return {
      id: strOrNull(h && h.id, 60),
      host: strOrNull(h && h.host, 60) || UNHELLO,
      // ★ transport 是「这条桥是怎么接的」。宿主没报时写 'ws'（本通道只有 ws 一条腿），
      //   不写 null —— null 会让人以为「不知道」，而这里其实是知道的。
      transport: strOrNull((h && h.transport) || m.transport, 20) || 'ws',
      caps: Array.isArray(h && h.caps) ? h.caps.map(String) : [],
      stubs: Array.isArray(h && h.stubs) ? h.stubs.map(String)
        : (Array.isArray(m.stubs) ? m.stubs.map(String) : []),
      meta: {
        pid: intOrNull(m.pid),
        plugin: strOrNull(m.plugin, 80),
        version: strOrNull(m.version, 40),
        node: strOrNull(m.node, 20),
        platform: strOrNull(m.platform, 20),
        contextWindow: intOrNull(m.contextWindow),
        contextTokens: intOrNull(m.contextTokens),
        watermarkSource: strOrNull(m.watermarkSource, 60),
        surfaceTokens: intOrNull(m.surfaceTokens),
        notWired: Array.isArray(m.notWired) ? m.notWired.map(String) : [],
        note: strOrNull(m.note, 160),
        keys,
      },
      state: (h && h.state && typeof h.state === 'object') ? {
        contextTokens: intOrNull(h.state.contextTokens),
        contextWindow: intOrNull(h.state.contextWindow),
        outputTokens: intOrNull(h.state.outputTokens),
        turnId: strOrNull(h.state.turnId, 60),
        at: strOrNull(h.state.at, 40),
      } : null,
      connectedAt: strOrNull(h && h.connectedAt, 40),
      lastError: sanitizeError(h && h.lastError),
      lastErrorAt: strOrNull(h && h.lastErrorAt, 40),
      calls: intOrNull(h && h.calls),
      failures: intOrNull(h && h.failures),
    };
  });
  return {
    side: SIDES.v4,
    enabled: true,
    connected: rows.filter((r) => r.host && r.host !== UNHELLO).length,
    total: rows.length,
    hosts: rows,
  };
}

export function emptyControl(note) {
  return { side: SIDES.v4, enabled: false, connected: 0, total: 0, hosts: [], note: note || null };
}

// ═══════════════════════════════════════════════════════════════════════
// 二 · MCP Hub（DSH 侧）
//
// 形状来自 DSH 的 GET /mcp-hub/servers：
//   { ok, file, servers:[{ serverName, transport, enabled, status, toolCount, tools, error, lastErrorAt }],
//     stats:{ servers, connected, tools } }
// ★ 只读 GET。这个接口还有 POST/PATCH/DELETE（增删服务器、连接/断开）—— 一条都不碰。
// ═══════════════════════════════════════════════════════════════════════

function emptyHub(state, error, atMs, url) {
  return {
    side: SIDES.dsh,
    source: 'dsh:/mcp-hub/servers',
    url: url || null,
    state,
    configured: state !== 'UNCONFIGURED',
    enabledServers: null,
    readyServers: null,
    errorServers: null,
    serverCount: null,
    connectedServers: null,
    toolCount: null,
    stale: state === 'stale',
    items: [],
    manifestFile: null,
    fetchedAt: atMs ? new Date(atMs).toISOString() : null,
    error: error ? sanitizeError(error) : null,
  };
}

export function parseMcpHubPayload(payload, atMs, url) {
  if (!payload || typeof payload !== 'object') return emptyHub('error', '响应不是 JSON 对象', atMs, url);
  if (payload.ok === false) return emptyHub('error', payload.error || '接口回了 ok:false', atMs, url);
  if (!Array.isArray(payload.servers)) {
    return emptyHub('error', '响应里没有 servers 数组（这个地址不是 mcp-hub 的 GET /mcp-hub/servers？）', atMs, url);
  }
  const items = payload.servers.map((s) => {
    const status = strOrNull(s && s.status, 20) || 'unknown';
    return {
      name: strOrNull(s && s.serverName, 60) || '(无名)',
      transport: strOrNull(s && s.transport, 20),
      enabled: Boolean(s && s.enabled === true),
      status,
      ready: status === 'ready',
      toolCount: intOrNull(s && s.toolCount),
      error: sanitizeError(s && s.error),
      lastErrorAt: strOrNull(s && s.lastErrorAt, 40),
    };
  });
  const stats = (payload.stats && typeof payload.stats === 'object') ? payload.stats : {};
  const sumTools = items.reduce((n, i) => n + (i.toolCount || 0), 0);
  return {
    side: SIDES.dsh,
    source: 'dsh:/mcp-hub/servers',
    url: url || null,
    state: 'ok',
    configured: true,
    enabledServers: items.filter((i) => i.enabled).length,
    readyServers: items.filter((i) => i.ready).length,
    errorServers: items.filter((i) => i.error).length,
    serverCount: items.length,
    connectedServers: intOrNull(stats.connected),
    toolCount: intOrNull(stats.tools) != null ? intOrNull(stats.tools) : sumTools,
    stale: false,
    items,
    manifestFile: strOrNull(payload.file, 200),
    fetchedAt: new Date(atMs).toISOString(),
    error: null,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// 三 · 心跳倒计时（DSH 侧）
//
// ★★ 唯一真源：DSH 的 dsh-yanqing-heartbeat 插件自己的 GET /heartbeat/auto。
//   那个接口回的是**它进程内的活计数器**：enabled / state / remainMs / totalMs /
//   lastActivityAt / thresholdMs / autoRunsToday / maxRunsPerDay / autoLastError / primaryFound。
//
// ★ 为什么绝不能用 v4 的 autonomy 算一个数贴上来：那是**另一台计时器**。
//   v4 的 autonomy 按「会话文件 mtime」判静默（organs/autonomy.mjs），DSH 的心跳按
//   「插件里的 lastActivityAt」。两个数都叫「还有多久」，但换一个屏幕就对不上 ——
//   而这一格的全部意义就是「DSH 到底还有多久会自己动」。混用比不显示更糟。
//
// ★ 状态词按实际，不按好看：
//   disabled     —— DSH 那边 enabled=false（**不是**倒计时为 0）
//   unavailable  —— 读不到（没配地址 / 连不上 / 从没读到过）
//   stale        —— 读到过，但已经旧了；或倒计时早该到点却还在「计时」
// ═══════════════════════════════════════════════════════════════════════

function emptyHeartbeat(state, error, atMs, url) {
  return {
    side: SIDES.dsh,
    source: 'dsh:/heartbeat/auto',
    url: url || null,
    state,
    enabled: null,
    disabled: false,
    unavailable: state !== 'disabled',
    stale: state === 'stale',
    phase: null,
    secondsRemaining: null,
    nextAutonomyAt: null,
    dueAt: null,
    overdueMs: null,
    lastActivityAt: null,
    idleMs: null,
    thresholdMinutes: null,
    graceMinutes: null,
    quiet: null,
    quietWhy: null,
    autoRunsToday: null,
    maxRunsPerDay: null,
    primaryFound: null,
    lastError: null,
    fetchedAt: atMs ? new Date(atMs).toISOString() : null,
    error: error ? sanitizeError(error) : null,
  };
}

export function buildHeartbeatView(payload, opts) {
  const o = opts || {};
  const atMs = Number.isFinite(o.atMs) ? o.atMs : Date.now();
  const url = o.url || null;
  if (!payload || typeof payload !== 'object' || payload.ok === false) {
    return emptyHeartbeat('unavailable', (payload && payload.why) || o.error || 'DSH 心跳接口没有回数据', atMs, url);
  }
  if (typeof payload.enabled !== 'boolean') {
    return emptyHeartbeat('error', '响应里没有布尔字段 enabled（这个地址不是 /heartbeat/auto？）', atMs, url);
  }
  const enabled = payload.enabled === true;
  const disabled = !enabled;
  const remainMs = intOrNull(payload.remainMs);
  const totalMs = intOrNull(payload.totalMs);
  const thresholdMs = intOrNull(payload.thresholdMs);
  const lastActivityAtMs = intOrNull(payload.lastActivityAt);
  const dueAtMs = (!disabled && lastActivityAtMs != null && totalMs != null) ? lastActivityAtMs + totalMs : null;
  // ★ disabled / 读不到 remainMs 时是 **null**，不是 0 —— 0 会被读成「马上就要动」。
  const secondsRemaining = (disabled || remainMs == null) ? null : Math.max(0, Math.round(remainMs / 1000));
  const due = dueAtMs != null && dueAtMs <= atMs;
  const overdueMs = dueAtMs != null ? atMs - dueAtMs : null;
  const stuck = !disabled && overdueMs != null && overdueMs > STUCK_MS
    && (payload.state === 'present' || payload.state === 'counting');
  return {
    side: SIDES.dsh,
    source: 'dsh:/heartbeat/auto',
    url,
    state: disabled ? 'disabled' : (stuck ? 'stale' : 'ok'),
    enabled,
    disabled,
    unavailable: false,
    stale: stuck,
    phase: strOrNull(payload.state, 20),
    secondsRemaining,
    // ★ 只在**还没到点**时给「下次何时」。已经到点却没触发（预算耗尽 / 安静时段 / 找不到主导会话）
    //   给 null + dueAt + overdueMs，让面板说「已到点，没动」，而不是显示一个过去的时间假装还有将来。
    nextAutonomyAt: (!disabled && dueAtMs != null && !due) ? new Date(dueAtMs).toISOString() : null,
    dueAt: dueAtMs != null ? new Date(dueAtMs).toISOString() : null,
    overdueMs: overdueMs != null && overdueMs > 0 ? overdueMs : null,
    lastActivityAt: lastActivityAtMs != null ? new Date(lastActivityAtMs).toISOString() : null,
    idleMs: intOrNull(payload.idleMs),
    thresholdMinutes: thresholdMs != null ? Math.round(thresholdMs / 60000) : null,
    graceMinutes: intOrNull(payload.graceMin),
    quiet: boolOrNull(payload.quiet),
    quietWhy: strOrNull(payload.quietWhy, 120),
    autoRunsToday: intOrNull(payload.autoRunsToday),
    maxRunsPerDay: intOrNull(payload.maxRunsPerDay),
    primaryFound: boolOrNull(payload.primaryFound),
    lastError: sanitizeError(payload.autoLastError),
    fetchedAt: new Date(atMs).toISOString(),
    error: null,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// 四 · 模型（v4 侧）
//
// 数据来自 LlmClient.stats()（src/llm/client.mjs）。★ 这里只做「拼装 + 白名单」：
//   ① keySource 只放来源**标签**（none / unresolved / config:llm.apiKey / env:NAME / dpapi:id），
//      其它任何写法一律折成 'unknown' —— 手改 config.json 把 key 粘进来源字段时，
//      这一格不许变成新的泄漏出口。
//   ② usage 拿不到就是 unavailable，绝不用 0 补。
// ═══════════════════════════════════════════════════════════════════════

const KEY_SOURCE_SAFE = /^(none|unresolved|config:llm\.apiKey|env:[A-Za-z_][A-Za-z0-9_]*|dpapi:[a-z][a-z0-9_-]*)$/;

export function safeKeySource(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return 'none';
  return KEY_SOURCE_SAFE.test(s) ? s : 'unknown';
}

function unavailableUsage(reason) {
  return {
    status: 'unavailable',
    protocol: null,
    promptTokens: null,
    completionTokens: null,
    cacheReadTokens: null,
    totalTokens: null,
    at: null,
    reason: reason || '拿不到 usage（不拿 0 顶）',
  };
}

export function buildLlmView(loop, config) {
  const client = loop && loop.llm;
  const cl = (config && config.llm) || {};
  const base = {
    side: SIDES.v4,
    available: false,
    why: null,
    ready: null,
    protocol: null,
    model: null,
    provider: strOrNull(cl.provider, 40),
    providerName: strOrNull(cl.providerName, 40),
    keySource: safeKeySource(cl.apiKeySource),
    calls: null,
    failures: null,
    lastCallAt: null,
    lastOkAt: null,
    lastLatencyMs: null,
    lastError: null,
    lastErrorAt: null,
    usage: unavailableUsage('还没有调用过'),
  };
  if (!client) return { ...base, why: 'loop.llm 不在（createServer 没收到 loop）' };

  let s = null;
  try { s = (typeof client.stats === 'function') ? client.stats() : null; }
  catch (e) { return { ...base, why: 'client.stats() 读失败：' + (sanitizeError(e && e.message || e) || '未知错误') }; }

  let ready = null;
  try { ready = (typeof client.ready === 'function') ? client.ready() === true : null; } catch { ready = null; }

  const st = (s && typeof s === 'object') ? s : {};
  const rawUsage = (st.usage && typeof st.usage === 'object') ? st.usage : null;
  const usage = (rawUsage && rawUsage.status === 'ok') ? {
    status: 'ok',
    protocol: strOrNull(rawUsage.protocol, 20),
    promptTokens: intOrNull(rawUsage.promptTokens),
    completionTokens: intOrNull(rawUsage.completionTokens),
    cacheReadTokens: intOrNull(rawUsage.cacheReadTokens),
    totalTokens: intOrNull(rawUsage.totalTokens),
    at: strOrNull(rawUsage.at, 40),
    reason: null,
  } : unavailableUsage(rawUsage && rawUsage.reason);

  return {
    ...base,
    available: true,
    why: st.statsAvailable === false ? (strOrNull(st.why, 160) || '这个 LlmClient 没有运行统计（老版本）') : null,
    ready,
    protocol: strOrNull(st.protocol, 20) || strOrNull(client.protocol, 20),
    model: strOrNull(st.model, 80) || strOrNull(client.model, 80) || strOrNull(cl.model, 80),
    calls: intOrNull(st.calls),
    failures: intOrNull(st.failures),
    lastCallAt: strOrNull(st.lastCallAt, 40),
    lastOkAt: strOrNull(st.lastOkAt, 40),
    lastLatencyMs: intOrNull(st.lastLatencyMs),
    lastError: sanitizeError(st.lastError),
    lastErrorAt: strOrNull(st.lastErrorAt, 40),
    usage,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// 五 · 采集器
//
// ★ 为什么要有缓存：DSH 那边一断（它重启时就是这样），面板不该瞬间从「有数」变成「全空」——
//   那会让人以为是自己这边坏了。**上次读到的值 + stale 标记 + 读失败原因**，三样一起给。
// ★ 缓存**只用于显示**：过了 staleMs 就退回 unavailable / unreachable，不拿旧数冒充实况。
// ═══════════════════════════════════════════════════════════════════════

// ★ 2026-11-11：从内部函数改成导出 —— 动态自主目标（organs/lead-target.mjs）要读**同一个**
//   /heartbeat/auto，用的必须是同一份取数实现（超时、脱敏、错误词）。复制一份 = 两套超时与两套错误文案。
export async function readJsonWith(url, timeoutMs, fetchImpl) {
  if (typeof fetchImpl !== 'function') return { ok: false, error: '运行时没有 fetch（Node < 18？）' };
  const ac = new AbortController();
  const timer = setTimeout(() => { try { ac.abort(); } catch { /* ignore */ } }, timeoutMs);
  try {
    const resp = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' }, signal: ac.signal });
    if (!resp || resp.ok !== true) {
      const code = resp && resp.status != null ? resp.status : '?';
      let detail = '';
      try { detail = String(await resp.text()).slice(0, 160); } catch { /* 没体就算了 */ }
      return { ok: false, error: 'HTTP ' + code + (detail ? '：' + detail : '') };
    }
    return { ok: true, data: await resp.json() };
  } catch (e) {
    if (ac.signal && ac.signal.aborted) return { ok: false, error: '请求超时（' + timeoutMs + 'ms）' };
    return { ok: false, error: sanitizeError(e && e.message || e) || '请求失败' };
  } finally {
    clearTimeout(timer);
  }
}

export function createRuntimeStatusCollector(opts) {
  const o = opts || {};
  const config = o.config || {};
  const control = o.control || null;
  const loop = o.loop || null;
  // ★★ 2026-11-13：心跳迁进 v4 —— DSH 心跳不通时，用本进程的 autonomy 算同一份状态。
  const autonomy = o.autonomy || null;
  const it = config.integrations || {};
  const fetchImpl = o.fetchImpl || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  const timeoutMs = Number.isFinite(o.timeoutMs) ? o.timeoutMs
    : (Number.isFinite(Number(it.timeoutMs)) && Number(it.timeoutMs) > 0 ? Number(it.timeoutMs) : DEFAULT_TIMEOUT_MS);
  const staleMs = Number.isFinite(o.staleMs) ? o.staleMs
    : (Number.isFinite(Number(it.staleMs)) && Number(it.staleMs) > 0 ? Number(it.staleMs) : DEFAULT_STALE_MS);

  const cache = { hub: { at: 0, data: null }, hb: { at: 0, data: null } };

  async function hubView() {
    const atMs = now();
    const u = hubUrlOf(config);
    if (!u.configured) return emptyHub('UNCONFIGURED', null, atMs, null);
    if (u.error) return emptyHub('error', 'MCP Hub 地址不合法：' + u.error, atMs, null);
    const r = await readJsonWith(u.url, timeoutMs, fetchImpl);
    if (r.ok) {
      const v = parseMcpHubPayload(r.data, atMs, u.url);
      if (v.state === 'ok') cache.hub = { at: atMs, data: v };
      return v;
    }
    const c = cache.hub;
    const ageMs = c.at ? atMs - c.at : null;
    if (c.data && ageMs != null && ageMs <= staleMs) {
      return { ...c.data, state: 'stale', stale: true, error: sanitizeError(r.error), fetchedAt: new Date(c.at).toISOString(), ageMs };
    }
    return { ...emptyHub('unreachable', r.error, atMs, u.url), ageMs };
  }

  async function heartbeatView() {
    const atMs = now();
    const u = heartbeatUrlOf(config);
    if (!u.configured) return emptyHeartbeat('UNCONFIGURED', null, atMs, null);
    if (u.error) return emptyHeartbeat('error', '心跳地址不合法：' + u.error, atMs, null);
    const r = await readJsonWith(u.url, timeoutMs, fetchImpl);
    if (r.ok) {
      const v = buildHeartbeatView(r.data, { atMs, url: u.url });
      if (v.state === 'ok' || v.state === 'disabled') cache.hb = { at: atMs, data: v };
      return v;
    }
    const c = cache.hb;
    const ageMs = c.at ? atMs - c.at : null;
    if (c.data && ageMs != null && ageMs <= staleMs) {
      return { ...c.data, state: 'stale', stale: true, unavailable: false, error: sanitizeError(r.error), fetchedAt: new Date(c.at).toISOString(), ageMs };
    }
    // ★★★ 2026-11-13：**回落** —— DSH 心跳不通时用本进程的 autonomy 算。
    //
    //   爀曦定的方向：「心跳插件集成到 v4 之后就禁用 DSH 侧的心跳插件」。
    //   所以这一格不能只有「DSH 报什么」一种来源 —— 没有 DSH 也得能回答
    //   「现在离自主触发还有多久」。
    //
    //   ★ 判据用同一个 autonomy.check()（和真正投递时用的是同一份判定）——
    //     不是另写一套倒计时。两种来源给的 state 字段**同名同义**。
    //   ★ 回落时 state 前加 'local:' 吗？不加。但 `source` 会写 'v4:autonomy'，
    //     让界面能分清这一轮是谁给的答案。
    const local = (() => {
      try {
        if (!autonomy || typeof autonomy.check !== 'function') return null
        // ★ check() 的真实返回（organs/autonomy.mjs）：
        //   { phase, reason, idleMinutes?, targetSession, target, targetSource, hostActivity, runsToday? }
        //   **没有 state / remainMs** —— 那两个要在这里算，不要假装它有。
        const c = autonomy.check(atMs)
        if (!c || typeof c !== 'object') return null
        const cfgA = autonomy.config || {}
        const thMin = Number(cfgA.idleThresholdMinutes) > 0 ? Number(cfgA.idleThresholdMinutes) : 15
        const idleMin = Number.isFinite(c.idleMinutes) ? Number(c.idleMinutes) : null
        // 剩余 = 阈值 - 已静默（只对 counting 有意义；autonomous 时是 0）
        const remainMs = idleMin == null ? null
          : Math.max(0, Math.round((thMin - idleMin) * 60000))
        return {
          side: 'v4',
          source: 'v4:autonomy',
          url: null,
          state: c.phase === 'autonomous' ? 'due' : (c.phase || 'unknown'),
          enabled: true,
          phase: c.phase || null,
          remainMs,
          secondsRemaining: remainMs == null ? null : Math.round(remainMs / 1000),
          thresholdMinutes: thMin,
          idleMs: idleMin == null ? null : Math.round(idleMin * 60000),
          autoRunsToday: Number.isFinite(c.runsToday) ? c.runsToday : null,
          maxRunsPerDay: Number.isFinite(cfgA.maxRunsPerDay) ? cfgA.maxRunsPerDay : null,
          primaryFound: Boolean(c.targetSession),
          primarySessionId: c.targetSession || null,
          reason: String(c.reason || '').slice(0, 160),
          dshUnavailable: true,
          dshError: sanitizeError(r.error),
          note: 'DSH 心跳不通（' + sanitizeError(r.error) + '）—— 改用本进程 autonomy 判定',
        }
      } catch { return null }
    })()
    if (local) return local
    return { ...emptyHeartbeat('unavailable', r.error, atMs, u.url), ageMs };
  }

  function controlView() {
    if (!control) return emptyControl('控制通道没接（createServer 没收到 control）');
    try {
      const snap = typeof control.snapshot === 'function' ? control.snapshot() : control;
      return buildControlView(snap);
    } catch (e) {
      return { ...emptyControl('snapshot() 读失败：' + (sanitizeError(e && e.message || e) || '未知错误')), enabled: true };
    }
  }

  return async function collect() {
    const t0 = now();
    const [mcpHub, dshHeartbeat] = await Promise.all([hubView(), heartbeatView()]);
    return {
      at: new Date(t0).toISOString(),
      tookMs: Math.max(0, now() - t0),
      // ★ 这两张表是给界面用的「这一格属于谁」—— 不是装饰：同一页上并排放着
      //   两个进程的状态，混了就会让人拿着 v4 的读数去修 DSH 的问题。
      sides: { v4: ['control', 'llm'], dsh: ['mcpHub', 'dshHeartbeat'] },
      note: 'v4 侧 = 本进程（agent-soul core）；DSH 侧 = 宿主 DSH 的只读接口（显式配置优先；没配就自动读 dsh-origin.txt / 启动日志，读不到才显示 UNCONFIGURED）',
      control: controlView(),
      mcpHub,
      dshHeartbeat,
      llm: buildLlmView(loop, config),
    };
  };
}
