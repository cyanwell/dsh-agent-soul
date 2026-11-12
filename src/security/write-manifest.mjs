// 单一写面 manifest —— HTTP 与 MCP 两条腿共用这一份（2026-11-10 · G2a）
//
// ★ 为什么要有这份东西：
//   写面的判据原先散在三处 ——
//     · mcp-proxy.mjs 的 WRITE_TOOLS（只给 stdio 的离线腿用）
//     · mcp-http.mjs 的 tools/call → **直接 callTool**（一条判据都没有）
//     · web/server.mjs 的每条 POST 路由（各自为政，谁也没说自己是写面）
//   三处各判各的，就一定会漂 —— 已经漂过一次：soul_autonomy 被列进 WRITE_TOOLS，
//   而它只调 Autonomy.check()，一个字节都不写。
//   漂的代价不是性能，是**验收时分不清「拒了」是设计还是 bug**。
//
// ★ 这份文件的角色只有一句：**它是唯一的判据。**
//   两条腿、两条路（/api 与 /mcp）都问它；谁都不许自己再抄一遍清单。
//
// ★ 默认行为不变：没有显式打开只读模式（AGENT_SOUL_READONLY=1）时，
//   下面这些判定**不拦任何东西**。只读模式才是「manifest 之外一律拒绝」的那个模式。
//
// ★ 拒绝的语义（这一条最容易被写错）：
//   只读模式命中的拒绝是 **服务在线时的拒绝** —— status=rejected / reason=UNAVAILABLE /
//   code=SOUL_READONLY。**绝不许用 SOUL_OFFLINE**：
//   「服务不在线」和「服务在线但不许写」是两件事，混用会让上游去查错方向
//   （SOUL_OFFLINE 的处置是「去起主服务」，而这里主服务明明在）。

export const MANIFEST_ID = 'g2a-write-manifest/2026-11-10';

/** 显式只读模式。只有显式写 1/true/on/yes 才算 —— 缺省、空串、乱写一律**不**开启。 */
export function readonlyEnabled() {
  const v = String(process.env.AGENT_SOUL_READONLY == null ? '' : process.env.AGENT_SOUL_READONLY).trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

/** 后台同步开关：AGENT_SOUL_SYNC=off 关掉首轮与定时。★ 显式 CLI 同步（tools/soul-sync.mjs）不看它。 */
export function syncDisabled() {
  const v = String(process.env.AGENT_SOUL_SYNC == null ? '' : process.env.AGENT_SOUL_SYNC).trim().toLowerCase();
  return v === 'off' || v === '0' || v === 'false' || v === 'no';
}

// ═══════════════════════════════════════════════════════════════════════
// 〇 · 事件账的写域（2026-11-10 · Aurabot 事件接入 core 化）
//
// ★ 为什么写进这份文件：这里已经是「写面判据的唯一一处」。事件账是**新的写面**，
//   如果只在 src/events/ 里用注释声明「我是唯一写者」，那和「谁都说自己没写」没区别。
//   写在这里，验收脚本可以 import 它做断言，读的人也不必翻三个仓库。
//
// ★ 唯一写者是谁：**core 自己**（src/events/store.mjs）。不是 DSH 进程、不是插件、
//   不是 Aurabot 模块、也不是原型 plugins/aurabot-ingress。
// ★ 目录不接受任意配置：<AGENT_SOUL_DATA>/events —— 判据在 src/events/index.mjs:eventsDirOf()。
//   这一条是硬要求：不让任何人把「权威账」指到 DSH_HOME 或别的工作区去。
// ★ 只读的外来账（永远不写，也不复制成第三份）：
//     · <状态目录>/事件队列.jsonl        —— lead-relay 的队列，写者是分身上报工具
//     · <状态目录>/lead-waker-台账.json  —— 唤醒台账，写者是 lead-waker
//   我们只读它们、把索引（Envelope）记进自己的账；权威仍是原文件。
// ═══════════════════════════════════════════════════════════════════════
export const EVENT_WRITE_DOMAIN = Object.freeze({
  id: 'event-ledger/2026-11-10',
  dirRel: 'events',
  dirFrom: 'AGENT_SOUL_DATA',
  soleWriter: 'agent-soul-core',
  writerFile: 'src/events/store.mjs',
  // ★ events.jsonl 是 2026-11-11 加的第二本账（帧 → 事件推导的结果）。同一目录、同一写者，
  //   但它**不是事实**：删掉它、从 envelopes 重跑即可重建。写进清单是为了让「这个目录里
  //   有哪些文件、谁在写」仍然只有一处判据 —— 否则下一个读清单的人会以为目录里只有四份。
  files: ['envelopes.jsonl', 'events.jsonl', 'cursor.json', 'status.json', 'errors.jsonl'],
  readOnlyForeign: [
    '事件队列.jsonl（lead-relay 队列 · 写者是分身上报工具）',
    'lead-waker-台账.json（唤醒台账 · 写者是 lead-waker）',
  ],
  note: '事件账只有这一份；manifest 之外的任何模块都不许 append 这些文件。只读的外来账不复制成第二份权威。',
});
// ═══════════════════════════════════════════════════════════════════════
// 一 · MCP：工具 × action
//
// ★ 只看工具名不够 —— 三种情形长在同一份清单里（预查 §3 实测）：
//   ① 写不写取决于 action（soul_ledger / soul_waker）
//   ② 危险不在自己写，而在把动作推给别人（soul_ask_host）
//   ③ 看起来像写其实不写（soul_autonomy —— 这就是被误列的那一格）
//
// kind: 'write'  → 该工具的某些 action 会落盘
//       'read'   → 全程不落盘（可能读盘、可能外呼，但**不写**）
// on:   '*' = 所有 action 都写；数组 = 只有这些 action 写
// default: 不给 action 时工具自己用的那个（必须与 callTool 里的默认值同字面）
// ═══════════════════════════════════════════════════════════════════════
export const MCP_WRITE_MANIFEST = {
  // —— 写类 ——
  soul_ledger: {
    kind: 'write', on: ['write'], default: 'list',
    why: 'organs/ledger.mjs:139-140 追加一行（落点是 pickLedger 选中的那本，通常就是生产 02-墨.jsonl）',
  },
  soul_waker: {
    kind: 'write', on: ['ingest', 'decide'], default: 'state',
    why: 'organs/waker.mjs:199/211 → #save() 写 <dataDir>/ledger.json',
  },
  soul_index: {
    kind: 'write', on: '*',
    why: 'adapters/mcp-tools.mjs:469/477/486 → store.create() + store.append() 写 frames.jsonl / index.jsonl',
  },
  soul_compact: {
    kind: 'write', on: '*',
    why: 'organs/compaction.mjs compactRange() 写压缩帧',
  },
  soul_ask_host: {
    kind: 'write', on: '*',
    why: 'control/hub exec() 把动作推给宿主 —— 宿主的写面我们不知道，一律不当读',
  },
  soul_cleanup: {
    kind: 'write', on: '*',
    why: 'organs/cleanup.mjs → control.exec(pruner/targeted-cleanup)：裁剪发生在宿主那边，v4 看不见它的写面'
      + '；目标留空时先做一次 GET 心跳取当前 lead（只读，与 soul_autonomy 同一份解析）',
  },

  // —— 读类（12 个：不落盘）——
  soul_autonomy: {
    kind: 'read',
    why: '只调 Autonomy.check()（organs/autonomy.mjs 的纯判定）+ 一次 GET 心跳取当前 lead（organs/lead-target.mjs，只读）；会写 autonomy.json 的 recordRun() 没有任何 MCP 入口',
  },
  soul_guard: {
    kind: 'read', external: true,
    why: '规则层纯判定，不写盘；配了 key 时可能发一次 LLM 请求（是外呼，不是写）',
  },
  soul_context: { kind: 'read', why: '只读投影 / 时间' },
  soul_file: { kind: 'read', why: '书房只读检索（索引在内存里）' },
  soul_recall: { kind: 'read', why: 'store.search / searchAll' },
  soul_frame: { kind: 'read', why: 'store.load' },
  soul_persona: { kind: 'read', why: '人格层渲染（文件读）' },
  soul_sessions: { kind: 'read', why: 'store.list' },
  soul_query: { kind: 'read', why: '墨 / 索引 / 书房只读检索' },
  // ★ 2026-11-12：索引面（meta.sqlite FTS）。只读 —— 它不改库，只 search()。
  soul_grep: { kind: 'read', why: 'meta.sqlite FTS 只读检索（取回式同步的入口）' },
  soul_self: { kind: 'read', why: 'SELF 装配体检（只读文件）' },
  soul_mnemon: { kind: 'read', why: '热记忆投影探针（只读）' },
  soul_health: { kind: 'read', why: '计数 / 只读探针' },
  soul_diagnose: { kind: 'read', why: '会话帧回看，算候选，不写' },
  // ★ 2026-11-11 补登记：这个工具 11-11 才加进 MCP（技能加载器），但没同时登记进 manifest。
  //   后果就是 G1 那条「tools/list 与 manifest 逐名相同」由 19 变 20 而挂。
  //   why 要能自己证明只读：SkillLibrary 只做 readdir/stat/readFile，缓存是内存，不落盘。
  soul_skill: {
    kind: 'read',
    why: 'skills/index.mjs 的 SkillLibrary：readdir/stat/readFile + 内存缓存；get 只返回正文，不写',
  },

  // —— QQ 只读面（2026-11-11 · 第一批 8 个）——
  // ★ 全部 kind:'read'。下面每一条的 why 都要能**自证**：不说「它只是读」，
  //   而说「它读的是哪个出口 / 哪个文件，以及为什么这条路上没有写」。
  // ★ 为什么要逐条登记而不是给个 qq_* 通配：manifest 的判据是
  //   「不在表里 = 默认拒绝」。通配会让**将来**新加的 qq 工具自动获得放行，
  //   而那时它是不是写面根本没人看过 —— 那正是 fail-closed 要防的形状。
  qq_status: {
    kind: 'read',
    why: 'adapters/qq/client.mjs 的 call()：一次 OneBot POST get_login_info（+ 一次 get_status）；只读 data，不落盘',
  },
  qq_list_groups: {
    kind: 'read',
    why: '同上，OneBot get_group_list；只把群号/群名映射出来，不做过滤、不写盘',
  },
  qq_get_group_members: {
    kind: 'read',
    why: '同上，OneBot get_group_member_list；只读成员表，不写盘',
  },
  qq_get_recent_messages: {
    kind: 'read',
    why: 'adapters/qq/client.mjs 的 createQqConsoleClient().get() → GET /api/socialV2/recent；'
      + '会话令牌只进 x-agent-token 请求头，不落盘、不回显（这一条读的是 SnowLuma 桥接的内存态，不是本地文件）',
  },
  qq_get_unread_messages: {
    kind: 'read',
    why: '同一出口 GET /api/socialV2/unread；**不**调 mark-read，读完不会把未读清掉 —— 这一批里没有任何写动作',
  },
  qq_slang_query: {
    kind: 'read',
    why: '★ 本地没有黑话文件可读：黑话库在 SnowLuma 进程内存里，只经桥接控制台 GET /api/socialV2/slang/query 暴露'
      + '（已核：D:\\AI\\SnowLuma 下无 slang/memory 命名的状态文件）。所以它是「控制台读」而不是「文件读」；'
      + '只 GET，不写，也不缓存到磁盘',
  },
  qq_memory_query: {
    kind: 'read',
    why: '同上，GET /api/socialV2/memory；只读轻记忆，不 append / 不 clear —— 写那三条（memory-append/remove/clear）一条都没搬',
  },
  qq_social_state: {
    kind: 'read',
    why: 'GET /api/socialV2/state；没有控制台时只读**进程内** Map 快照（adapters/qq/tools.mjs 的 stateCache），'
      + '不落盘；两者都没有就回 QQ_STATE_UNCACHED —— 不会为了「有东西可读」去写一份缓存文件',
  },
};

export const MCP_TOOL_NAMES = Object.keys(MCP_WRITE_MANIFEST);

/** 工具这次调用用的是哪个 action。没给就用工具自己的默认（必须与 callTool 同字面）。 */
export function mcpAction(tool, args) {
  const spec = MCP_WRITE_MANIFEST[tool];
  const a = (args && typeof args === 'object') ? args : {};
  if (a.action != null && String(a.action) !== '') return String(a.action);
  return spec && spec.default ? spec.default : null;
}

/**
 * 判一次 tools/call。
 * ★ manifest 里没有的工具 → verdict='unknown' 且 write=true（默认拒绝，方向 fail-closed）。
 */
export function classifyMcpCall(name, args) {
  const tool = String(name == null ? '' : name);
  const spec = MCP_WRITE_MANIFEST[tool];
  if (!spec) {
    return { tool, action: null, write: true, verdict: 'unknown', why: 'manifest 里没有这个工具 —— 默认拒绝' };
  }
  const action = mcpAction(tool, args);
  const write = spec.kind === 'read'
    ? false
    : (spec.on === '*' ? true : (Array.isArray(spec.on) ? spec.on.includes(String(action)) : false));
  return {
    tool, action,
    write,
    verdict: write ? 'write' : 'read',
    why: spec.why || '',
    ...(spec.external ? { external: true } : {}),
  };
}

// ═══════════════════════════════════════════════════════════════════════
// 二 · HTTP：路由 × 方法
//
// ★ HTTP 的判据和 MCP 不一样：MCP 的粒度是「工具 × action」，
//   HTTP 的粒度只能是「方法 + 路径」—— 因为路由是 if 链，没有 action 这一层。
//   所以这张表就是**所有 HTTP 写面的全集**，写不下来的一定不是写面。
//
// ★ 只读模式下的规矩：
//   · 命中 HTTP_WRITE_ROUTES → 拒（在线拒绝，见 rejection()）
//   · POST /mcp → 交给 MCP 那一份 manifest，**逐调用判**
//   · POST /api/shutdown → 控制面例外（只认回环、只认 POST，实现在 index.mjs；不属写面）
//   · GET / HEAD → 读，照常（判据见 §三）
//   · 其余一律拒（默认拒绝）
// ═══════════════════════════════════════════════════════════════════════

/** 冻结写面 —— 只读模式一律拒绝。 */
export const HTTP_WRITE_ROUTES = {
  'POST /api/config': '写 config.json（含 llm.apiKey 明文）；写后读回比对',
  'POST /api/sessions': '建会话目录 + frames.jsonl + index.jsonl',
  'POST /api/turn': '先 append 一帧，再跑整轮工具链（含 write_file）—— 写面在这条路上会再扩散一层',
  'POST /api/guard': '宪章审核的 POST 入口；配了 key 时会发一次 LLM 请求（外呼 + 无鉴权）',
};

/** 控制面例外 —— 不属于写面，但必须在 manifest 里有一格（否则「manifest 外无隐式放行」这句话有洞）。 */
export const HTTP_CONTROL_ROUTES = {
  'POST /api/shutdown': 'loopback-only 优雅关闭（index.mjs:362-396）：只认回环 + 只认 POST；只读模式不拦它',
};

/** 「方法即读」的两条。★ 这一条有边界，写在下面 §三。 */
export const HTTP_READ_METHODS = ['GET', 'HEAD'];

/** 这两个路由**不判方法**（server.mjs 里只比 p，不看 req.method）—— 只读模式下非 GET 必须拒。 */
export const HTTP_METHOD_RESTRICTED = {
  '/api/diagnose': 'server.mjs:923 只判路径不判方法；只读模式要求非 GET 拒绝',
  '/api/control': 'server.mjs:956 同上',
};

/** MCP over HTTP 的路径 —— 它的 POST 不在这里判，交给 MCP manifest 逐调用判。 */
export const HTTP_MCP_PATH = '/mcp';

/**
 * §三 · 「GET = 读」这条判断的边界（写给下一个改这里的人）
 *
 * ★ server.mjs 里全部 GET 路由逐个核过，都不写盘（2026-11-10 静态审 + 隔离实测）：
 *   /  /index.html  /chat  /params  /settings  /organs  /diary  /yantai  /status
 *   /aurora.css  /aurora.js  /api/live  /api/overview  /api/yantai  /api/status
 *   /api/diary/list  /api/diary/doc  /api/organs  /api/diagnose  /api/control
 *   /api/health  /api/events  /api/persona  /api/config  /api/sessions
 *   /api/session/<id>/frames  /api/search
 * ★ /api/events 现在是事件接入的状态读口（ingress 状态 + 最近元数据），仍然只读、不下盘。
 * ★ 唯一带副作用的是 /api/overview —— store.buildIndex() 会**建内存索引**（不下盘），
 *   代价是占住事件循环 3–40 秒。那不是写面，但它是「读不等于无副作用」，本文件不假装它没有。
 * ★ 所以这条判断现在成立，**但它不是永久成立**：
 *   以后新加一条 GET 路由，如果它写盘，就必须改这里 —— 上面的清单是判据，不是装饰。
 */
export const HTTP_GET_READ_ROUTES = [
  '/', '/index.html', '/chat', '/params', '/settings', '/organs', '/diary', '/yantai', '/status',
  '/aurora.css', '/aurora.js',
  '/api/live', '/api/overview', '/api/yantai', '/api/status',
  '/api/diary/list', '/api/diary/doc', '/api/organs',
  '/api/diagnose', '/api/control', '/api/health', '/api/events', '/api/persona',
  '/api/config', '/api/sessions', '/api/search',
  // ★ 2026-11-10：概览的运行状态口。只读的 GET —— 它读的是**别的进程**（DSH 的
  //   /mcp-hub/servers 与 /heartbeat/auto），自己不落盘、不改配置、不重连。
  //   登记在这里是因为上面那张清单是判据：新加一条 GET 就要回答一次「它写不写盘」。
  '/api/runtime-status',
  // ★ 2026-11-11：出站口的只读视图。**不写盘**：读的是进程内的计数与环形缓冲
  //   （src/adapters/outbox.mjs 的 view()），正文在记录里就已被截断成前 40 字。
  '/api/outbox',
  // ★ 2026-11-11：QQ 只读面的接线视图。**不写盘**：读的是两个客户端（adapters/qq/client.mjs）
  //   的进程内计数与地址，令牌两格都进不来。与 /api/outbox 同一条规矩。
  '/api/qq',
];

/**
 * 判一条 HTTP 请求。
 * 返回 verdict：'read' | 'write' | 'control' | 'delegate' | 'unknown'
 */
export function classifyHttp(method, pathname) {
  const m = String(method == null ? '' : method).toUpperCase();
  const p = String(pathname == null ? '' : pathname);
  const key = m + ' ' + p;

  if (p === HTTP_MCP_PATH) {
    return { verdict: 'delegate', surface: 'mcp', key: m + ' ' + p, why: 'POST /mcp 交给 MCP manifest 逐调用判' };
  }
  if (HTTP_CONTROL_ROUTES[key]) {
    return { verdict: 'control', key, why: HTTP_CONTROL_ROUTES[key] };
  }
  if (HTTP_WRITE_ROUTES[key]) {
    return { verdict: 'write', key, route: key, why: HTTP_WRITE_ROUTES[key] };
  }
  if (HTTP_READ_METHODS.includes(m)) {
    const restricted = HTTP_METHOD_RESTRICTED[p];
    return { verdict: 'read', key, why: restricted ? ('GET 是读；' + restricted) : '读方法（GET/HEAD）' };
  }
  return {
    verdict: 'unknown', key,
    why: 'manifest 里没有这条「方法 + 路由」—— 只读模式下默认拒绝。'
      + '真要放行，先证明它不写盘，再登记到 HTTP_WRITE_ROUTES / HTTP_CONTROL_ROUTES / HTTP_READ_METHODS 里。',
  };
}

// ═══════════════════════════════════════════════════════════════════════
// 三 · 拒绝体 —— 两条腿**同一个形状**（这样上游只写一次解析）
//
// ★ reason=UNAVAILABLE 是口径：**服务在线，但这件事现在不可用。**
// ★ 不是 SOUL_OFFLINE：那个码的处置是「去起主服务」，而这里主服务就在。
// ═══════════════════════════════════════════════════════════════════════
export function rejection(surface, detail, extra) {
  const d = detail || {};
  const e = extra || {};
  const body = {
    ok: false,
    status: 'rejected',
    reason: 'UNAVAILABLE',
    code: 'SOUL_READONLY',
    readonly: true,
    service: 'online',
    surface: String(surface || ''),
    manifest: MANIFEST_ID,
    why: d.why || 'AGENT_SOUL_READONLY=1：本进程处于显式只读模式，写面按 manifest 一律拒绝。',
    note: '★ 这不是离线降级（不是 SOUL_OFFLINE）：服务在线，只是写被显式关掉了。'
      + '上游看到这个形状应当**当成拒绝**，不要重试、不要去找主服务。',
    howToFix: [
      '确实需要写：去掉 AGENT_SOUL_READONLY=1 后重启本进程（生产上这要有人批准）。',
      '只是想知道能不能写：GET /api/health 或 GET /mcp 会带 readonly 标记。',
    ],
  };
  if (d.tool) body.tool = d.tool;
  if (d.action) body.action = d.action;
  if (d.verdict) body.verdict = d.verdict;
  if (d.key) body.key = d.key;
  if (d.write != null) body.write = Boolean(d.write);
  return { ...body, ...e };
}
