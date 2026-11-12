// adapters/qq · 第一批 QQ 只读工具（8 个）
// ============================================================================
// ★ 这批为什么单独成文件，而不是继续往 mcp-tools.mjs 那个 if 链里塞：
//   mcp-tools.mjs 已经 1157 行、20 个 soul_* 工具。再塞 8 个跨系统的工具进去，
//   「读灵魂自己的东西」和「读另一个进程的 QQ」就混成了同一坨 ——
//   而它们的依赖根本不同：后者**不需要会话 store**（见 mcp-tools.mjs 的提前分派）。
//
// ★★ 与参考实现（dsh-tools/qq-bridge 的 mcp-snowluma-safe.js）的**事实核对**：
//   任务书里说「8 个全是走 onebot() → OneBot HTTP」。逐条核过，**不成立**：
//     · get_login_info / get_status / get_group_list / get_group_member_list → OneBot HTTP；
//     · 未读 / 最近消息 / 二代状态 / 轻记忆 / 黑话 → 走的是 agentApi()，
//       也就是 SnowLuma 桥接控制台（默认 :3100）的 /api/socialV2/*，用 x-agent-token。
//   而任务书说「三个纯本地、不碰网关」的那 3 个（黑话 / 轻记忆 / 状态）—— 本机磁盘上
//   **没有**它们的本地文件：SnowLuma 把它们放在进程内存里，只经控制台暴露
//   （已查：D:\\AI\\SnowLuma 下无 slang / memory / social 命名的状态文件；
//    D:\\AI\\dsh-tools\\qq-bridge 只是客户端，没有服务端代码）。
//   所以这里**不编造文件读**：黑话与轻记忆老老实实走控制台；
//   状态那条在没有控制台时只读**进程内**快照缓存，且必须把 stale 标出来。
//
// ★ 为什么 8 个里没有一个是「没接线就假装成功」的：
//   没接线 → { ok:false, code:'QQ_UNCONFIGURED' | 'QQ_CONSOLE_UNCONFIGURED' }；
//   有接线但读不到 → { ok:false, code:'QQ_TIMEOUT' | 'QQ_HTTP' | ... }。
//   「读不到」和「读到空」必须分得开 —— 这个项目为混这两件事付过代价。
// ============================================================================

import { createQqClient, createQqConsoleClient, QQ_CLIENT_PORT } from './client.mjs';

/** 状态缓存的「还新」门槛。过了这个点仍可用，但必须标 stale。 */
const STATE_STALE_MS = 5 * 60 * 1000;
const MEMBER_LIMIT = 500;

/** 参数不合法 → 也是返回，不是抛。★ 所有出口形状一致，调用方才不用分两种写法。 */
function badArg(error) {
  return { ok: false, code: 'QQ_BAD_ARG', error };
}

function clampInt(v, dflt, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/**
 * 运行期装配（两条客户端 + 状态缓存）。
 * ★ 为什么不直接用 process.env 在模块顶层建：自检要能把这些**整体换掉**
 *   （换成 mock 的地址与假 token）。装配点只有这一个，测试和生产走同一份代码。
 */
export function createQqRuntime(opts = {}) {
  const env = opts.env || process.env;
  const onebot = opts.onebot || {};
  const bridge = opts.bridge || {};
  const client = createQqClient({
    httpUrl: onebot.httpUrl != null ? onebot.httpUrl : String(env.QQ_ONEBOT_URL || ''),
    tokenEnv: onebot.tokenEnv != null ? onebot.tokenEnv : String(env.QQ_ONEBOT_TOKEN_ENV || 'QQ_ONEBOT_TOKEN'),
    env,
    timeoutMs: onebot.timeoutMs,
  });
  const consoleClient = createQqConsoleClient({
    baseUrl: bridge.baseUrl != null ? bridge.baseUrl : String(env.QQ_CONSOLE_URL || ''),
    tokenEnv: bridge.tokenEnv != null ? bridge.tokenEnv : String(env.QQ_CONSOLE_TOKEN_ENV || 'QQ_CONSOLE_TOKEN'),
    // ★ 2026-11-11：第三条来源 —— 文件。参考实现读 <qq-bridge>/state/console-token，
    //   而且每次请求重读（令牌轮换，缓存旧值 = 一直 401）。
    //   所以「5 个控制台工具缺令牌来源」不成立：来源在文件里，配这个变量就接上了。
    tokenFile: bridge.tokenFile != null ? bridge.tokenFile : String(env.QQ_CONSOLE_TOKEN_FILE || ''),
    env,
    timeoutMs: bridge.timeoutMs,
  });
  // ★ 缓存只在内存里。写进磁盘就破了「这批工具 kind=read」这条登记 ——
  //   而 manifest 里的 why 是要能自证的，不能让一句注释替代码说谎。
  const stateCache = new Map();
  return { client, bridge: consoleClient, stateCache, env };
}

let _runtime = null;

/** 换掉本进程的运行期（自检用）。生产路径永远走下面的懒建。 */
export function setQqRuntime(rt) {
  _runtime = rt || null;
  return _runtime;
}

export function qqRuntime() {
  if (!_runtime) _runtime = createQqRuntime();
  return _runtime;
}

// ── 三个网关读 ────────────────────────────────────────────────────────────────

async function runStatus(args, rt) {
  const login = await rt.client.call('get_login_info');
  if (!login.ok) return login;
  // ★ get_status 失败不该把整条查询判死：账号信息已经拿到了。
  //   但也**不许静默** —— 在 partial 里写清是哪一格读不到。
  const st = await rt.client.call('get_status');
  const d = (login.data && typeof login.data === 'object') ? login.data : {};
  const s = (st.ok && st.data && typeof st.data === 'object') ? st.data : null;
  return {
    ok: true,
    data: {
      user_id: d.user_id == null ? null : d.user_id,
      nickname: d.nickname == null ? '' : String(d.nickname),
      online: s ? (s.online == null ? null : Boolean(s.online)) : null,
      good: s ? (s.good == null ? null : Boolean(s.good)) : null,
    },
    ...(s ? {} : { partial: 'get_status 读不到：' + String(st.error || '未知') }),
  };
}

async function runListGroups(args, rt) {
  const r = await rt.client.call('get_group_list');
  if (!r.ok) return r;
  // ★ 两种网关形状都兜：OneBot 标准是数组，个别实现会包一层 { data: [...] }。
  const rows = Array.isArray(r.data)
    ? r.data
    : (r.data && Array.isArray(r.data.data) ? r.data.data : []);
  return {
    ok: true,
    count: rows.length,
    groups: rows.map((g) => ({
      group_id: g && g.group_id != null ? g.group_id : null,
      group_name: g && g.group_name != null ? String(g.group_name) : '',
    })),
    note: '★ 本机 v4 还没有 allow/deny 群白名单（参考实现有）—— 这里是「网关报了多少就看多少」，不做过滤。',
  };
}

async function runGroupMembers(args, rt) {
  const gid = String(args.groupId == null ? '' : args.groupId).trim();
  if (!gid) return badArg('要给 groupId（群号）');
  const num = /^\d+$/.test(gid) ? Number(gid) : gid;
  const r = await rt.client.call('get_group_member_list', { group_id: num });
  if (!r.ok) return r;
  const rows = Array.isArray(r.data)
    ? r.data
    : (r.data && Array.isArray(r.data.data) ? r.data.data : []);
  return {
    ok: true,
    groupId: gid,
    count: rows.length,
    members: rows.slice(0, MEMBER_LIMIT).map((m) => ({
      user_id: m && m.user_id != null ? m.user_id : null,
      nickname: m && m.nickname != null ? String(m.nickname) : '',
      card: m && m.card != null ? String(m.card) : '',
    })),
    ...(rows.length > MEMBER_LIMIT ? { truncated: '只列前 ' + MEMBER_LIMIT + ' 个（共 ' + rows.length + '）' } : {}),
  };
}

// ── 五个桥接控制台读 ──────────────────────────────────────────────────────────

/** 会话 key 的两种形状只认这两种 —— 打错类型不会报错，只会读到「没有这条」并让人以为会话空着。 */
function sessionKeyOf(args) {
  const key = String(args.key == null ? '' : args.key).trim();
  if (!/^(group|private):\S+$/.test(key)) return null;
  return key;
}

async function runRecent(args, rt) {
  const key = sessionKeyOf(args);
  if (!key) return badArg('key 必须是 group:<群号> 或 private:<QQ号>');
  const limit = clampInt(args.limit, 20, 1, 100);
  const offset = clampInt(args.offset, 0, 0, 10000);
  const r = await rt.bridge.get('/api/socialV2/recent', { query: { key, limit, offset }, token: args.token });
  return r.ok ? { ok: true, key, limit, offset, data: r.data } : r;
}

async function runUnread(args, rt) {
  const key = sessionKeyOf(args);
  if (!key) return badArg('key 必须是 group:<群号> 或 private:<QQ号>');
  const limit = clampInt(args.limit, 30, 1, 100);
  const r = await rt.bridge.get('/api/socialV2/unread', { query: { key, limit }, token: args.token });
  return r.ok ? { ok: true, key, limit, data: r.data } : r;
}

async function runSlangQuery(args, rt) {
  const key = sessionKeyOf(args);
  if (!key) return badArg('key 必须是 group:<群号> 或 private:<QQ号>');
  const q = args.q == null ? '' : String(args.q).trim();
  const r = await rt.bridge.get('/api/socialV2/slang/query', { query: { key, q }, token: args.token });
  if (!r.ok) return r;
  return { ok: true, key, ...(q ? { q } : {}), data: r.data, source: 'bridge-console' };
}

async function runMemoryQuery(args, rt) {
  const key = sessionKeyOf(args);
  if (!key) return badArg('key 必须是 group:<群号> 或 private:<QQ号>');
  const category = args.category == null ? '' : String(args.category).trim();
  if (category && !['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) {
    return badArg('category 只能是 activeTopic / pendingThought / memberImpression');
  }
  const r = await rt.bridge.get('/api/socialV2/memory', { query: { key, category }, token: args.token });
  if (!r.ok) return r;
  return { ok: true, key, ...(category ? { category } : {}), data: r.data, source: 'bridge-console' };
}

/**
 * 二代仿真状态。
 * ★ 为什么它比别的多一层：这条最容易被读成「状态是空的」——
 *   而实际上「没接线」「没令牌」「没缓存」是三种不同的处境，必须分开说。
 *   在线读到 → 记进进程内缓存（source:'live'）；
 *   在线读不到但有缓存 → 给旧的，**标 stale 并说明为什么**；
 *   都没有 → ok:false + QQ_STATE_UNCACHED，并明写「这不是没有状态，是读不到」。
 */
async function runSocialState(args, rt) {
  const key = sessionKeyOf(args);
  if (!key) return badArg('key 必须是 group:<群号> 或 private:<QQ号>');

  const hit = rt.stateCache.get(key);
  const ageMs = hit ? Date.now() - hit.at : null;
  const cacheOf = (why) => ({
    ok: true,
    key,
    source: 'cache',
    stale: ageMs > STATE_STALE_MS,
    ageMs,
    cachedAt: new Date(hit.at).toISOString(),
    ...(why ? { why } : { why: '没有可用控制台，给的是本进程上一次读到的快照' }),
    data: hit.data,
  });

  const view = rt.bridge.view();
  if (view.configured || args.token) {
    const r = await rt.bridge.get('/api/socialV2/state', { query: { key }, token: args.token });
    if (r.ok) {
      rt.stateCache.set(key, { at: Date.now(), data: r.data });
      return { ok: true, key, source: 'live', stale: false, ageMs: 0, data: r.data };
    }
    if (hit) return cacheOf('在线读失败（' + String(r.code || '?') + '：' + String(r.error || '') + '），退回上一次快照');
    // ★ 保留原来的 code（超时/HTTP/未配置），额外把「没有缓存」写进 why ——
    //   调用方据此能分清「这次读挂了」和「本来就没读过」。
    return { ...r, key, source: 'none', stale: true, why: '在线读失败，且本进程没有任何缓存 —— 这不是「状态为空」，是「读不到」' };
  }

  if (hit) return cacheOf();
  return {
    ok: false,
    code: 'QQ_STATE_UNCACHED',
    key,
    source: 'none',
    stale: true,
    error: '既没有配置桥接控制台，也没有本进程缓存 —— 这一格是「读不到」，不是「没有状态」',
  };
}

// ── 工具表 ────────────────────────────────────────────────────────────────────
//
// inputShape 是**本文件自己的**轻量形状（不是 zod、也不是 JSON Schema）：
// mcp-tools.mjs 用 qqJsonSchema() 把它翻成 tools/list 要的 JSON Schema。
// 这样这份表在没装 MCP SDK 的环境里也能被 node 直接跑（自检就是靠这个）。

export const QQ_READ_TOOLS = [
  {
    name: 'qq_status',
    description: '查询 QQ 机器人登录状态与账号信息（只读）。网关没接线时回 ok:false，不假装在线。',
    inputShape: {},
    run: (args, rt) => runStatus(args || {}, rt || qqRuntime()),
  },
  {
    name: 'qq_list_groups',
    description: '列出机器人所在的全部 QQ 群（只读）：群号、群名。★ 本机没有群白名单，不做过滤。',
    inputShape: {},
    run: (args, rt) => runListGroups(args || {}, rt || qqRuntime()),
  },
  {
    name: 'qq_get_group_members',
    description: '列出指定群的成员列表（只读）：QQ 号、昵称、群名片。',
    inputShape: {
      groupId: { type: 'string', description: '群号（数字或字符串都收）', required: true },
    },
    run: (args, rt) => runGroupMembers(args || {}, rt || qqRuntime()),
  },
  {
    name: 'qq_get_recent_messages',
    description: '查看指定会话的最近消息（只读），支持 offset 向前翻。走桥接控制台的 /api/socialV2/recent，'
      + '需要会话令牌 token（唤醒提示里的【会话令牌】）。',
    inputShape: {
      key: { type: 'string', description: '会话 key，格式 group:群号 或 private:QQ号', required: true },
      token: { type: 'string', description: '会话令牌（这一轮由调用方给；不落盘、不回显）' },
      limit: { type: 'integer', description: '最多返回条数，默认 20，最大 100' },
      offset: { type: 'integer', description: '跳过最近 N 条，默认 0' },
    },
    run: (args, rt) => runRecent(args || {}, rt || qqRuntime()),
  },
  {
    name: 'qq_get_unread_messages',
    description: '查看指定会话的未读消息（只读，**不自动标已读**）。走 /api/socialV2/unread，需要会话令牌。',
    inputShape: {
      key: { type: 'string', description: '会话 key，格式 group:群号 或 private:QQ号', required: true },
      token: { type: 'string', description: '会话令牌' },
      limit: { type: 'integer', description: '最多返回条数，默认 30，最大 100' },
    },
    run: (args, rt) => runUnread(args || {}, rt || qqRuntime()),
  },
  {
    name: 'qq_slang_query',
    description: '查看已确认的群聊黑话/梗（只读）。★ 黑话库不在本地文件里 —— 它在 SnowLuma 进程内存、'
      + '经桥接控制台 /api/socialV2/slang/query 提供，所以这条要控制台接线 + 会话令牌。',
    inputShape: {
      key: { type: 'string', description: '会话 key，格式 group:群号 或 private:QQ号', required: true },
      token: { type: 'string', description: '会话令牌' },
      q: { type: 'string', description: '可选搜索词，按词条/含义/用法过滤' },
    },
    run: (args, rt) => runSlangQuery(args || {}, rt || qqRuntime()),
  },
  {
    name: 'qq_memory_query',
    description: '查看当前会话的轻量记忆：进行中的话题 / 想说没说的话 / 对群友的印象（只读）。'
      + '★ 同样不在本地文件里，走 /api/socialV2/memory，需要控制台接线 + 会话令牌。',
    inputShape: {
      key: { type: 'string', description: '会话 key，格式 group:群号 或 private:QQ号', required: true },
      token: { type: 'string', description: '会话令牌' },
      category: { type: 'string', description: '可选：activeTopic / pendingThought / memberImpression' },
    },
    run: (args, rt) => runMemoryQuery(args || {}, rt || qqRuntime()),
  },
  {
    name: 'qq_social_state',
    description: '查看指定会话的二代仿真状态（只读）：WakeConfig、未读、上次唤醒原因等。'
      + '★ 读不到就报 stale，不假装：在线读到标 source:live；只有旧快照就标 source:cache + stale:true；'
      + '两者都没有就 ok:false + QQ_STATE_UNCACHED。',
    inputShape: {
      key: { type: 'string', description: '会话 key，格式 group:群号 或 private:QQ号', required: true },
      token: { type: 'string', description: '会话令牌' },
    },
    run: (args, rt) => runSocialState(args || {}, rt || qqRuntime()),
  },
];

/** inputShape → tools/list 要的 JSON Schema。 */
export function qqJsonSchema(tool) {
  const properties = {};
  const required = [];
  for (const [k, v] of Object.entries((tool && tool.inputShape) || {})) {
    const { required: req, ...rest } = v || {};
    properties[k] = rest;
    if (req) required.push(k);
  }
  const schema = { type: 'object', properties };
  if (required.length) schema.required = required;
  return schema;
}

/** GET /api/qq 的形状。★ 只有接线状态与计数：token 两格都进不来，消息正文也不进来。 */
export function qqView() {
  const rt = qqRuntime();
  return {
    port: QQ_CLIENT_PORT.id,
    v: QQ_CLIENT_PORT.v,
    tools: QQ_READ_TOOLS.map((t) => t.name),
    client: rt.client.view(),
    bridge: rt.bridge.view(),
    note: '这里只有「接线了没有 / 调过几次」。令牌不进这个视图，消息正文也不进 —— 要看正文请对工具本身发问。',
  };
}

/** 工具名清单（mcp-tools.mjs 与自检都用它，避免两处各抄一份）。 */
export const QQ_READ_TOOL_NAMES = QQ_READ_TOOLS.map((t) => t.name);
