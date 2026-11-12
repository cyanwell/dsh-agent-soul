// agent-soul 入口
//
// 起法：node src/index.mjs
// 配置：项目根的 config.json（或 AGENT_SOUL_KEY / AGENT_SOUL_BASE_URL / AGENT_SOUL_MODEL / AGENT_SOUL_PORT）

import fs from 'node:fs';
import path from 'node:path';
import { useStore as syncUseStore, roundAsync as syncRoundAsync, cancelSync as syncCancel, syncQuiesce as syncQuiesce } from '../tools/soul-sync.mjs';
import { ControlHub } from './control/hub.mjs';
import { loadConfig, ROOT, personaFilesOf, devPathOr } from './config.mjs';
import { readonlyEnabled, syncDisabled } from './security/write-manifest.mjs';
import { installParentWatchdog } from './util/parent-watchdog.mjs';
import { SessionStore } from './session/store.mjs';
import { ToolRegistry } from './tools/registry.mjs';
import { LlmClient } from './llm/client.mjs';
import { AgentLoop } from './agent/loop.mjs';
import { createServer } from './web/server.mjs';
import { registerBuiltins } from './tools/builtin.mjs';
import { registerJobTools } from './tools/jobs.mjs';
import { registerTodoTools } from './tools/todo.mjs';
import { registerAskTools } from './tools/ask.mjs';
import { registerDelegateTools } from './tools/delegate.mjs';
import { checkPanel, redactBody, deliverPanelNotice } from './organs/guard.mjs';
import { EventBus } from './events/bus.mjs';
import { Scheduler } from './events/scheduler.mjs';
import { PersonaLayer } from './persona/layer.mjs';
import { HuanqiDetector, STALL } from './organs/huanqi.mjs';
import { Autonomy } from './organs/autonomy.mjs';
// ★ 2026-11-10 D 切片：自主的「投给谁、投到没有」从本文件搬到这里 —— 它需要 control hub，
//   而本文件只负责接线（顺序见下面「自主投递」那一段）。
import { createHostAutonomy, pickHostActivity } from './organs/autonomy-host.mjs';
// ★ 2026-11-11：目标「留空 = 跟随《墨》当前 lead」。解析**不做在这里** ——
//   它复用 DSH 心跳的判定结果（/heartbeat/auto 的 primarySessionId），本文件只负责把它挂上。
import { createLeadTargetResolver } from './organs/lead-target.mjs';
// ★ 2026-11-10 E/F 切片：定点清理（只能走宿主 pruner）· 回声哨兵（真只读探测）
import { createTargetedCleanup } from './organs/cleanup.mjs';
import { createEchoSentinel } from './organs/echo-sentinel.mjs';
import { Ledger, buildWakeText } from './organs/waker.mjs';
import { renderContext, usedTokens } from './organs/context.mjs';
import { DegradationTracker } from './organs/degradation.mjs';
// ★ 2026-11-10：Aurabot 只读事件 → core 的唯一事件账（宿主半没有搬，见 src/events/index.mjs 头注释）。
import { createEventsIngress } from './events/index.mjs';
// ★ 2026-11-12：会话调度器**只在这里建一次** —— web 的 /api/session 与事件层的投递器
//   必须共用同一个实例，否则 counts / noHost 各算各的，面板上两个数对不上。
import { createSessionDispatch } from './organs/session-dispatch.mjs';
import { createOutbox } from './adapters/outbox.mjs';
// ★ 2026-11-12：③ 取回式同步的入口 —— GET /api/search?q=...
//   取回式而不是推送式（爀曦拍板）：推送会把别人的帧写进当前上下文，而上下文变大正是污染源，
//   于是「同步」和「换气」直接对冲。取回只提供入口，不占上下文。
import { handleSearchEndpoint, searchView } from './adapters/search-http.mjs';
// ★ 2026-11-12：换气的语义判据 —— 用 v4 内嵌 LLM 判断上下文污染点。
//   ★ 必须在 core 里跑：apiKeyRef 是 dpapi: 密文，只有 AgentSoul.exe 以当前用户身份起的进程解得开。
import { handleHuanqiAnalyze, huanqiView } from './adapters/huanqi-http.mjs';
// ★ 2026-11-12：aurabot 的状态口（③ 面板的数据源）。只读 + 白名单脱敏。
import { handleAurabotStatus, aurabotView } from './adapters/aurabot-http.mjs';
// ★★ 2026-11-12：aurabot 整个插件搬进 v4。
//   src/aurabot/ 是它的完整源码副本（85 文件 / 1363KB），一行没改；
//   适配层把 cordis 的 ctx 换成我们的（9 个能力），57 个 route 就全注册了。
import { createAurabotCtx } from './aurabot/adapter/ctx.mjs';
import { handleAurabotApi, AURABOT_API_PREFIX } from './aurabot/adapter/http.mjs';
import { handleAurabotStatic } from './aurabot/adapter/static.mjs';
// ★ 2026-11-13：echo 体检页（照 v3 的 dsh-yanqing-echo，15 项）。
//   逻辑不搬 —— 调 D:\AI\memory\hub\echo-doctor.mjs 的 runDoctor()，
//   那是命令行与面板共用的同一份。v4 只做壳。
import { handleEchoApi, isEchoPath, echoView } from './adapters/echo-http.mjs';
// ★ 2026-11-13：台账面板搬进 v4（v3 的 dsh-yanqing-lead-waker 就是这个）。
import { handleWakerApi, isWakerPath } from './adapters/waker-http.mjs';
// ★ 2026-11-13：主动诊断 —— 扫所有活跃会话，不等退化才起作用（爀曦定的方向）。
import { handleHuanqiScan, isHuanqiScanPath } from './adapters/huanqi-scan.mjs';
// ★ 2026-11-13：扫**宿主**的活跃会话（3 天内），不是 v4 自己的。
import { handleHostScan, isHostScanPath } from './adapters/host-scan-http.mjs';
import { scanActiveHostSessions } from './adapters/host-sessions.mjs';
// ★ 2026-11-13：上下文手术的 HTTP 入口（v4 → bridge 的 cap='context'）。
import { handleContextApi, isContextPath, setIntervener, setPurgedFile, setHostScanner } from './adapters/context-http.mjs';
import { fileURLToPath } from 'node:url';
// ★ 2026-11-12：静态资源要按「这个文件在哪」定位（和 server.mjs 的 HERE 同法）。
const HERE = path.dirname(fileURLToPath(import.meta.url));

// ★ 索引库在哪：爀曦 2026-11-12 定「统一记忆库在 00-记忆库」，所以位置从配置读。
//   没配就退回老位置 <dataDir>/meta.sqlite —— 不让"没配"变成"打不开"。
function indexDbPath (cfg) {
  const lib = (cfg && cfg.memory && cfg.memory.libraryDir) || '';
  if (!lib) return path.join(cfg.dataDir, 'meta.sqlite');
  const f = (cfg.memory && cfg.memory.indexFile) || 'meta.sqlite';
  return path.join(lib, f);
}
import { makeWsTransport } from './adapters/events-ws.mjs';

const config = loadConfig();
const store = new SessionStore(config.dataDir);
const tools = new ToolRegistry();
const llm = new LlmClient(config.llm);
const loop = new AgentLoop({ store, llm, tools, config });

// 工作区：默认就是项目根；可在 config.json 里改
const workspace = config.workspace || ROOT;
// ★★ 2026-11-07 + 2026-11-11：把「叫主导」提成具名常量，放在**所有注册之前**。
//   现在有**两个**调用方（notify_lead 工具、ask_user 工具），投递策略只该有一份 ——
//   复制一份给别人用 = 给「block 了但照样投」那个坑挖第二个入口。
//   ★ 顺序有讲究：`const` 有 TDZ，放在后面用它的地方会直接 ReferenceError（实测炸过一次）。
const notifyLead = async ({ title, facts }) => deliverPanelNotice({
  title,
  facts,
  guardFn: globalThis.__guardCheck,
  waker: globalThis.__ledger,
  hub: globalThis.__controlHub,
  // ★ 2026-11-10 D 切片：面板通知也按**同一个目标**核对回执（「通知 expectTarget 从
  //   targetSession 接线」）。留空 = 不指名，保持旧行为（投给宿主默认会话，ambiguous 时拒）。
  //   闭包在调用那一刻读 —— 不缓存，避免与热改的配置出现两个答案。
  expectTarget: (autonomy.config && autonomy.config.targetSession) || undefined,
});
// ★ 2026-11-11：后台任务（P0 的另一半）。run_shell 是同步等的、超时上限 300 秒 ——
//   真实活里有大量「跑起来就不管、过一会来看」的，没这层 v4 一件长活就把自己堵死。
//   manager 要留住引用：v4 退出时用它把活着的子进程一起收掉（见 shutdown()）。
const jobManager = registerJobTools(tools, { workspace, log: (m) => { if (!config.quiet) console.log('  [任务] ' + m); } });
// ★ 2026-11-11（P1）：待办。没有「列步骤」，做完一步就不知道下一步该干什么 ——
//   实测那次 glob 失败连换三次路子，就是现场试错而不是照步骤走。
//   按会话隔离、落 <dataDir>/todos.json（重启后「刚才列到第几步」本身是有用的记忆）。
const todoStore = registerTodoTools(tools, { dataDir: config.dataDir, log: (m) => { if (!config.quiet) console.log('  [待办] ' + m); } });
// ★ 2026-11-11（P1 另一半）：ask_user。两段式 —— 问是异步事件，答案在下一轮上下文里回来。
//   设计全文 _verify/v3-v4-takeover-20261111/ASK-USER-DESIGN.md。
//   ★ 复用 notifyLead / globalThis.__guardCheck：**不新开投递通道、不新写一套宪章判定**。
const questionStore = registerAskTools(tools, {
  dataDir: config.dataDir,
  notify: notifyLead,
  guardFn: globalThis.__guardCheck,
  log: (m) => { if (!config.quiet) console.log('  [问] ' + m); },
});
globalThis.__questionStore = questionStore;
// ★★ 2026-11-11（批二）：委派。v4 是调度基体 —— 它的正面职责是把活派出去，
//   而不是自己什么都能干（后者是 harness 的思路）。
//   ★ 依赖 loop，所以注册点必须在 loop 创建之后。
if (loop && store) {
  try {
    registerDelegateTools(tools, { store, loop, config, log: (m) => { if (!config.quiet) console.log('  [委派] ' + m); } });
  } catch (e) {
    if (!config.quiet) console.log('  [委派] 注册失败（不影响其它工具）：' + String((e && e.message) || e));
  }
}
// ★ 2026-11-11：/api/vitals 的取数口。**刻意只放轻的东西** ——
//   人格用量、内存、会话数、同步时间。不碰索引（那是 /api/overview 的活，也是它慢的原因）。
//   页面每 5 秒轮一次，所以这个口必须轻到「轮 100 次也不心疼」。
globalThis.__vitals = () => {
  let personaChars = 0;
  try { personaChars = loop ? loop.personaText().length : 0; } catch { personaChars = 0; }
  // ★ 2026-11-11：上下文水位 —— 让它在界面上能看见「我快满了」。
  //   数据来自最近一次 turn 的预算结果（loop.__lastBudget），没跑过就是 null。
  let ctx = null;
  try {
    const b = loop && loop.__lastBudget;
    if (b) ctx = { kept: b.kept, folded: b.folded, keptTokens: b.keptTokens, foldedTokens: b.foldedTokens, span: b.span || null };
  } catch { ctx = null; }
  return {
    personaChars,
    personaBudget: (config.persona && config.persona.budget) || 80000,
    context: ctx,
  };
};
// ★ 2026-11-07：给 v4 面板里的 LLM 装上「叫醒主导」。
//   之前它只有 读/写/列/跑 四个文件类工具 —— 于是它在面板里说的话永远到不了主导。
//   ★ 为什么用 globalThis 而不是直接传 control：control 在本文件第 250 行才创建，
//     而 builtin 在 34 行就要注册。用闭包延迟取，调用那一刻才去读。

registerBuiltins(tools, {
  workspace,
  // ★★ 2026-11-10 第九轮（入口/出口安全修正）：notify 的**出口策略**已收口到
  //   guard 的 deliverPanelNotice() —— 同一份实现能被假宿主驱动（见
  //   _verify/guard-entry-egress-20261110/probe-egress.mjs），所以「block 到底投没投」
  //   这件事终于可以被证据回答，而不是靠读代码。
  //   · block     → 不投递、不调 followup、不拼原文（旧行为是照样投、只把 stage 置 blocked，
  //                 于是 facts 里的凭据仍会被送到主导）；
  //   · ask/pass  → 只投 redactBody 后的字段；
  //   · 台账      → 只用脱敏字段（block 也留痕，但留的是脱敏标题）。
  //   ★ 拼接点只有一个（在 deliverPanelNotice 里）。这里**不许**再往通知里拼原文。
  notify: notifyLead,
});

// ★ 一个示范守卫：拒绝在工作区外写文件（单调守卫，只否决）
tools.guard((exec) => {
  if (exec.name === 'run_shell') {
    const cmd = String(exec.args && exec.args.command || '');
    // 明显危险的三类，直接否决
    if (/\bformat\b|\brd\s+\/s|\bdel\s+\/f\s+\/s\s+\/q\s+[A-Za-z]:\\/i.test(cmd)) {
      return '守卫拒绝：这条命令像格式化/批量删除磁盘，不在允许范围';
    }
  }
  return undefined;   // 不表态 = 不否决
});

// —— 人格层 ——
const persona = new PersonaLayer({ budget: (config.persona && config.persona.budget) || 80000 });
// ★ 2026-11-11：不再直接用 config.persona.files —— 那份默认是空的，
//   于是 v4 跑着却一个字人格都没读进来（占比 0 / 80000 B）。
//   判据收进 config.personaFilesOf()：显式配置优先，没配就自动发现本机那三份。
const pr = persona.load(personaFilesOf(config), { root: ROOT });
loop.personaLayer = persona;
// ★ 上下文器官（时间 + 水位）—— 每轮拼进 systemPrompt
loop.__ctxMod = { renderContext, usedTokens };

// —— 器官：换气（huanqi）——
// ★ 这不是复制粘贴：它挂在 loop 的观察点上，用新运行时自己的流做判定。
const huanqiByRound = new Map();
// ★★ 2026-11-10（三项死读数修复之一）：**把判定表挂到 loop 上**。
//   在这之前，server.mjs 的 /api/organs 读 `loop.__huanqiByRound`，而全库没有一处给它赋值 ——
//   于是那张卡永远读到空表、再取一个不存在的字段，界面上长期写着「0 / 3」。
//   这里只交出**引用**：不改判定、不改熔断、不新增写者；读的人拿到的就是器官正在用的那一份。
//   ★ 字段名 `__huanqiByRound` 是对外契约（server.mjs / status-data.mjs 都按它读），改它要三处一起改。
loop.__huanqiByRound = huanqiByRound;
loop.organs.push({
  name: 'huanqi',
  beforeCall: (obs) => {
    if (!huanqiByRound.has(obs.sessionId)) huanqiByRound.set(obs.sessionId, new HuanqiDetector({
      stallThreshold: (config.organs && config.organs.huanqi && config.organs.huanqi.stallThreshold) || 3,
    }));
  },
  afterCall: (obs) => {
    const d = huanqiByRound.get(obs.sessionId);
    if (!d) return undefined;
    const v = d.observe({ hasOutput: obs.hasOutput, reasoning: obs.reasoning });
    obs.huanqi = v;
    if (d.shouldBreak()) {
      d.reset();
      return { breakTurn: true, reason: '连续 ' + v.consecutive + ' 次没产出（' + v.reason + '）' };
    }
    return undefined;
  },
  // ★ 回合要「自然结束」时再看一眼：这一轮真的是完成，还是废轮？
  endTurn: (obs) => {
    const d = huanqiByRound.get(obs.sessionId);
    const v = obs.huanqi;
    if (!v || !v.stalled) return undefined;
    return { voidTurn: true, reason: v.reason || 'no-output' };
  },
});

// —— 事件层 ——
const bus = new EventBus({ store });
const tickMs = Number(process.env.AGENT_SOUL_TICK_MS) || (config.events && config.events.intervalMs) || 60000;
const sched = new Scheduler({ bus, intervalMs: tickMs });

// ★ 一条真实规则：会话静默太久就记一条事件。
//   这是「自己注意到时间过去了」的最小形态 —— 不是闹钟，是每隔一会儿看一眼。
const silenceMs = (config.events && config.events.silenceMs) || 15 * 60 * 1000;
sched.rule({
  name: 'silence',
  every: silenceMs / 2,
  check: ({ session }) => {
    if (!session) return null;
    const s = store.load(session);
    if (!s || !s.frames.length) return null;
    const last = s.frames[s.frames.length - 1];
    const idle = Date.now() - last.t;
    if (idle < silenceMs) return null;
    return { summary: '会话静默 ' + Math.round(idle / 60000) + ' 分钟（阈值 ' + Math.round(silenceMs / 60000) + '）' };
  },
});

// ★ 另一条：每次 tick 之间，如果帧数变了，说明有活动 —— 记下来（留给以后做「最近在忙什么」）
sched.rule({
  name: 'alive',
  every: 5 * 60 * 1000,
  check: () => ({ summary: '心跳 ' + new Date().toISOString().slice(11, 19) }),
});

// —— 器官：自主循环 ——
// ★ 判据②「能自己动，不是只能被调用」就落在这几行上。
//   老 heartbeat 是「单次检查 + 外部计划任务」，这里改成常驻进程里的一条规则。
const autonomy = new Autonomy(
  store,
  {
    ...(config.autonomy || {}),
    // ★ 必须排除自己 —— 否则「本会话每轮都在写」会永远算成「他刚刚还在」
    ignoreSessions: [].concat(
      (config.autonomy && config.autonomy.ignoreSessions) || [],
      (config.events && config.events.session) ? [config.events.session] : []
    ),
  },
  path.join(config.dataDir, 'autonomy.json')
);

// —— 器官：唤醒台账 ——
// ★ 队列（事件总线）与台账（这个文件）分开写。队列回答「说过什么」，
//   台账回答「走到哪了」—— 两个问题两份文件，两个写者。
// ★ 这个东西叫 Ledger，但它**不是《墨》** —— 它是**唤醒台账**：
//   find / ingest / markWoken / decide / views，管「有人找主导 → 叫醒 → 判定」。
//   它没有 list({type}) / stats()，所以谁拿它当《墨》用，页面会一片空白**且不报错**。
//   《墨》在 dataDir/ledger.jsonl 或 soul.root/02-墨.jsonl，由 LedgerBase 读 ——
//   名字撞了，这里点名说清，免得下一个人又踩。
const ledger = new Ledger(path.join(config.dataDir, 'ledger.json'));

// ★ 把总线上「找人」类的事件收进台账，然后叫醒
bus.on('rule:silence', (payload) => {
  // ★ 2026-11-10 第三轮（独立验收 P2：台账是**落盘**的自由文本写入点）：
  //   summary 不是常量 —— 自主规则里带着 rec.title（rec.title 来自上游调用方），
  //   它经这里进台账、再被 soul_waker / 状态页读出去。以前两处都原样写，
  //   于是一条 {"key":{"inner":"…"}} 能被"截断"后原封不动存进磁盘。
  //   现在 key 与 title 都先过 redactBody（与 HTTP / MCP 出口同一份实现）。
  const summary = redactBody(String(payload.summary || '会话静默'));
  const key = redactBody(String(payload.t || Date.now()) + '|' + summary.slice(0, 60));
  ledger.ingest({ key, t: payload.t || new Date().toISOString(), title: summary.slice(0, 200), from: 'event-bus', tier: 'watch' });
});

// —— 自主投递（2026-11-10 D 切片）——
//
// ★ 旧规矩在这里被删掉了（逐条对应审计结论）：
//   · 不再 loop.turn(sid) 自己跑 —— 没有宿主就不动，不自跑；
//   · 不再 autonomySessionId() 新建「autonomy」容器 —— 目标只有 config.autonomy.targetSession；
//   · 不再「hub.exec resolve 就 recordRun」—— 回执 delivered===true 且 target 匹配才算投到；
//   · 不再把自主日志 append 进任何会话 —— 那会改那个会话的 mtime，而 mtime 曾是静默判据。
//
// ★ 规则本身晚一点注册（在 control hub 建好之后）：sched.start 只起定时器，
//   规则表是 tick 时才读的，所以顺序不是问题，**没有 hub 才是问题**。

const mainSession = (config.events && config.events.session) || null;
sched.start({ session: mainSession });

// ★ 启动时不再在这里同步建索引（2026-11-10）。
//
// 原来这三行是： store.buildIndex(); store.saveIndexCache();
// 它跑在 **server.listen 之前** —— 也就是说进程起来之后还有 3–40 秒**连端口都没监听**。
// 用户这时候关窗，壳的 POST /api/shutdown 拿到的是 ECONNREFUSED（或者更糟：
// 端口通了但事件循环被同步建库占着），等 10 秒 → 强杀 → 索引缓存没写 → 下次还慢。
//
// 同一件事 warmup 里已经做了一遍（src/web/server.mjs 的 server.warmup：
// 分片建索引 + 存缓存，跑在 listen 回调里、启动日志之后）。所以这里不再重复做，
// 「/api/overview 的 cacheMB 恒为 0」由 warmup 那一步保证 —— 而且现在它是让出事件循环的，
// 期间端口一直能应答。
//
// 谁先要索引谁负责建：/api/overview 与 status-data 里都有「没建就建一次」的懒建兜底。

// ★ 控制通道（2026-11-07）：v4 主动推指令给宿主的唯一出口。
//   onState 是「检测宿主上下文污染」的数据入口 —— 宿主每轮上报水位、回合、输出量。
// ★ 器官：思考退化（2026-11-07）。判据在 organs/degradation.mjs 里，这里只接线。
//   为什么是器官而不是 hub 的一部分：hub 认识「谁连上来了、谁会什么」，
//   **器官认识「这意味着什么」** —— 两件事不该住在一个类里。
const degradation = new DegradationTracker({
  log: (m) => { if (!config.quiet) console.log('  [退化] ' + m); },
  ...((config.organs && config.organs.degradation) || {}),
});

const control = new ControlHub({
  log: (m) => { if (!config.quiet) console.log('  [控制] ' + m); },
  onState: (rec, st) => {
    // rec.lastState 留着原样（面板/调试仍要看到宿主报什么）；
    // 判断交给器官 —— 它不执行任何动作，只给读数与观察。
    rec.lastState = st;
    try { degradation.observe(rec.id, rec.host, st); }
    catch (e) { /* 判断失败不许把控制通道带下去（hub.broadcast 同一条规矩） */ }
  },
});

// ★ 2026-11-12：会话调度器。web 的 /api/session 和事件层的投递器共用这一个。
//   ★ 不投递、不自己造会话、没有定时器 —— 它只是把「发给谁、发什么」翻译成控制通道上的 exec。
//   ★ 它自己带计数（counts / noHost / lastOutcome），所以**只能建一次**：
//     建两处就是两套读数，面板上「投了几次」会永远对不上。
const sessionDispatch = createSessionDispatch({
  hub: control,
  log: (m) => { if (!config.quiet) console.log('  ' + m); },
});

// ── 事件接入（2026-11-10 · Aurabot 只读事件 → core 事件账）──────────────
//
// ★ 这是本文件里唯一的「接入副作用」出口（别的模块 import 时不产生任何副作用）：
//   · 默认 mode=off —— 不连、不收、**不建事件目录**；
//   · AGENT_SOUL_READONLY=1 时即使 enabled 也不 start（连目录都不创建）；
//   · 账落 <dataDir>/events，manifest 登记 core 为唯一写者（security/write-manifest.mjs）。
//
// ★ 为什么放在 core 里而不是再开一个 runner：单实例 + 现成的 shutdown。
//   另起一个进程写同一份账 = 两个写者、没人负责退出 —— 那正是原型被验收判 FAIL 的点。
// ★ 2026-11-11：出站口（与 ingress 对称，但**总是创建**）。
//   为什么不按 mode=off 跳过创建：那样 /api/outbox 只能说「没创建」，
//   而「没创建」「缺 baseUrl」「缺 token」「已就绪」是四种不同状态 —— 面板要能分开。
//   创建对象本身零副作用：不发消息、不连网、不建目录；send() 才会碰网络。
const _egress = (config.events && config.events.egress) || {};
const _egressOb = _egress.onebot || {};
const outbox = createOutbox({
  baseUrl: _egressOb.httpUrl || '',
  tokenEnv: _egressOb.tokenEnv || '',
  timeoutMs: _egressOb.timeoutMs,
  dedupeTtlMs: _egressOb.dedupeTtlMs,
  env: process.env,
  log: (m) => { if (!config.quiet) console.log('  ' + m); },
});

const eventsIngress = createEventsIngress({
  config,
  env: process.env,
  log: (m) => { if (!config.quiet) console.log('  ' + m); },
  transport: makeWsTransport({ log: (m) => { if (!config.quiet) console.log('  ' + m); } }),
  // ★ 2026-11-12：事件 → 唤醒的出口。事件算出来之后，靠它把话送进会话。
  //   关着的时候整条投递路径一次都不进（deliver 自己判 enabled）。
  dispatch: sessionDispatch,
  // ★★ 2026-11-12：出站口也传进去 —— 投递成功之后，会话的回复靠它发回 QQ。
  //   不传就是「只投不回」：话送进会话了，但群里一个字都看不到。
  outbox,
});

// —— 自主投递规则（接线，判据在 organs/autonomy-host.mjs）——
//
// ★★ 四条不许回退的判据：
//   ① 目标只有一个来源：autonomy.config.targetSession。**留空 = 跟随《墨》当前 lead（动态）**；
//      填了 = 固定覆盖；解析不出（心跳不可用 / 没主导 / 缺 id / 歧义）= UNKNOWN，不下发，
//      **绝不建 autonomy 容器**；
//   ② 静默真值来自宿主按 session 上报的 state（hub.snapshot().state.sessionId / atMs），
//      **而且要按①解析出的那个 id 去问**。拿不到 = UNKNOWN = 不动；
//   ③ 只有回执 delivered===true 且 target 与①的 id 逐字相等，才 recordRun / markWoken；
//   ④ enabled=false / pushToHost=false 都不动（没有自跑退路）。
const leadTarget = createLeadTargetResolver({
  config,
  // ★ 2026-11-11：账本兜底的两样 ——— 能列会话 + 知道账本在哪。
  //   两样都给不齐就**不兜底**（宁可 UNKNOWN，也不要拿一个猜出来的 id 去投递）。
  // ★ 2026-11-13 修：原来直接给 `store.list()` —— 它的 `id` 来自会话文件首行，
  //   而 leadFromLedger 要拿它去匹配《墨》里的**8 位署名**（如 cfa54217）。
  //   两者对不上，账本兜底就永远接不了手（模拟心跳死亡时暴露的）。
  //   → 多给一个 `dir` 字段（会话目录名，含完整 id），匹配时两条路都试。
  // ★★ 2026-11-13 修（第二次）：**直接读目录名**，不走 store.list()。
  //
  //   为什么要这样：账本里存的是 8 位署名（cfa54217），而 leadFromLedger 拿它
  //   去 `s.id.indexOf(short) >= 0`。`store.list()` 的 id 来自会话文件首行 ——
  //   多一层转述就多一处对不上的可能。目录名（session-cfa54217-...）本身就是
  //   **宿主回执里用的那个 id**，是最直接的答案。
  //
  //   ★ 这件事的判据来自 2026-11-12 那条：**「我这边对了」≠「对面认了」**。
  //     账本兜底单独测能成（给它 {id:目录名}），接进真链路就不成 ——
  //     说明中间那一层（store.list 的 id）和测试假设不一样。
  sessionsProvider: () => {
    try {
      // ★ 用文件顶部已经 import 的 fs / path —— **ESM 里没有 require**
      //   （今天在 db-sync.mjs 上刚踩过一模一样的一脚）
      const root = path.join(config.dataDir || 'data', 'sessions')
      return fs.readdirSync(root).map((name) => ({ id: name }))
    } catch { return [] }
  },
  // ★★★ 2026-11-13 修：这里是**唯一**没走 devFileOr 的硬编码（别处 2026-11-10 都改过了）。
  //   后果：分发版装到新用户机上，ledgerFile 指向 'D:/AI/yanqing-soul/02-墨.jsonl' ——
  //   一个**不存在的路径** → leadFromLedger 回「账本读不到」→ 自主永远 fail-closed。
  //   ★ 它不崩，所以没人发现 —— 但那个用户**永远没有自主**，而自主是 v4 的一半。
  //   现在：配了就用配的；没配就只在开发路径**真的存在**时用它；否则留空（= 没有账本）。
  //   ★ 用 devPathOr('soulRoot', '') —— 那个 key 指向 D:/AI/yanqing-soul（**目录**），
  //     目录真的存在才拼出 02-墨.jsonl；不存在就是 ''（= 没有账本，自主 fail-closed 但不再指空）。
  ledgerFile: (config.integrations && config.integrations.ledgerFile)
    || (devPathOr('soulRoot', '') ? devPathOr('soulRoot', '') + '/02-墨.jsonl' : ''),
  log: (m) => { if (!config.quiet) console.log('  [目标] ' + m); },
});
// ★ 2026-11-11：把**同一个**解析器交出去给状态台（水位卡要回答「本会话是哪一条」）。
//   理由与上面 cleanup 那条一字不差：lead 只有一个真源；第二套实现（读账本 8 位签名）
//   在交接后会各说各话 —— 而交接恰恰是它最该准的时候。
globalThis.__leadTarget = leadTarget;
autonomy.leadTargetProvider = (nowMs) => leadTarget.current(nowMs);
// ★ 活跃真值的第二个参数 = **这一次 tick 解析好的目标**（Autonomy.check 传下来）。
//   不传就用配置 —— 那会在「动态跟随」时把 A 的活跃时间拿去给 B 判静默。
// ★★ 2026-11-12（爀曦指出）：**lead 还在活跃时，心跳计时必须暂停。**
//
//   原来的判据是「宿主最后一次上报 state 距今多久」。问题是：
//   **我连续跑一个长回合时，宿主不会一直推新 state** —— 于是 minutes 一路涨，
//   超过 15 分钟就触发自主；可我还在忙，那条消息只能进队列干等。
//   **计时器把我的「正在干活」当成了「人不在」。**
//
//   修法：再叠一个判据 —— **目标会话的 frames.jsonl 还在被写 = 我还在跑**。
//   ★ 为什么这个比 state 准：回合每写一帧就 touch 一次文件，mtime 就是「此刻」；
//     而 state 是宿主按它自己的节奏推的，长回合中间的空白它不知道。
//   ★ 取两者**更小**的那个：任一判据说「刚还在动」，就不该判静默。
//   ★ 只在能读到文件时覆盖；读不到（路径不对 / 权限）就保留 state 的判断，不硬改。
const fileActivityMinutes = (sessionId, nowMs) => {
  try {
    if (!sessionId) return null;
    const fp = path.join(store.dir(String(sessionId)), 'frames.jsonl');
    const st = fs.statSync(fp);
    return Math.max(0, (nowMs - st.mtimeMs) / 60000);
  } catch { return null; }
};
autonomy.hostActivityProvider = (nowMs, tgt) => {
  const nowMsSafe = Number.isFinite(nowMs) ? nowMs : Date.now();
  const ha = pickHostActivity(
    control.snapshot(),
    tgt && tgt.ok === true ? tgt.sessionId : null,
    nowMsSafe,
    // ★ 2026-11-11：兜底开关（默认关）。理由见 autonomy-host.mjs 里那段注释 ——
    //   bridge 的 state 帧缺 sessionId，正解是补它；这里只是让「不补也能跑」成为可选项。
    { allowSessionless: !!(config.autonomy && config.autonomy.acceptSessionlessState) }
  );
  if (!ha || ha.ok !== true) return ha;
  const fileMin = fileActivityMinutes(tgt && tgt.ok === true ? tgt.sessionId : null, nowMsSafe);
  if (fileMin == null) return ha;
  if (fileMin < ha.minutes) {
    return {
      ...ha,
      minutes: fileMin,
      lastActivityAt: new Date(nowMsSafe - fileMin * 60000).toISOString(),
      byFileActivity: true,
    };
  }
  return ha;
};
const hostAutonomy = createHostAutonomy({
  autonomy,
  ledger,
  control,
  log: (m) => { if (!config.quiet) console.log('  [自主] ' + m); },
});

// —— 器官：定点清理（2026-11-10 · E 切片）——
//
// ★ 它**只调宿主**的 pruner/targeted-cleanup。没有宿主、能力是桩、回执对不上、超时 ——
//   一律 ok:false 并落一条失败回执。**没有内部退路**：这个模块连 loop / compaction 都没 import，
//   所以「推不动就自己压一段再记成功」这条路在结构上不存在（见 organs/cleanup.mjs 头注释）。
// ★ 回执落在 <dataDir>/cleanup-receipts.json；隔离实例自然落在隔离根，生产 data 一个字不动。
// ★★ 2026-11-11：**同一个** leadTarget 实例交给清理 —— 不是另建一个。
//   两个实例会各自缓存一份「上次解析到的 lead」，交接时正好会各说各话；
//   而清理的目标与自主的目标本来就是同一个问题（「现在是哪个主脑」），答案只该有一处。
//   ★ 清理侧调 refresh()（现读一次），不调 current()（读缓存）：清理是人点的一次动作，
//     不能拿「上一次 tick 时的 lead」当这一次的目标。
const cleanup = createTargetedCleanup({
  control,
  autonomy,
  leadTarget,
  dataDir: config.dataDir,
  log: (m) => { if (!config.quiet) console.log('  [清理] ' + m); },
});
globalThis.__targetedCleanup = cleanup;

// ★★★ 2026-11-13：**换气的干预通道**（爀曦：「过了预警机制的红线，换气就要开始干预，
//   调用 soul 内嵌的 LLM 去检测宿主会话的上下文，并做精准修复。
//   **而不是等到极端场景，触发了截断熔断才做。**」）
//
//   链路：DeclWindow 判到 intervene 档 → 这里取上下文 → analyzeContext 找 ranges
//         → cleanup（宿主的 targeted-cleanup）只裁那几个 seq。
//
//   ★ cleanup 失败时**如实回报**（organs/cleanup.mjs 的判据：没有宿主回执就不算成功）。
//   ★ 挂到 loop 上，由它在那一步之后异步调 —— 诊断要一次 LLM 调用，不能阻塞主循环。
loop.huanqiIntervene = async ({ sessionId, dryRun }) => {
  const { intervene } = await import('./agent/huanqi-intervene.mjs');
  return intervene({
    sessionId,
    store,
    llm,
    // ★★ 2026-11-13：改走 bridge 的 context/purge（不再走 pruner）。
    //   实测已通：purged ok, seq 18972 → newSeq 19079。
    //   ★ 签名适配：intervene 传 {sessionId, startSeq, endSeq, reason}，
    //     而 dispatch.purge 要 {sessionId, items:[{seq, reason}]}。
    purge: async ({ sessionId: sid, startSeq, endSeq, reason }) => {
      // ★ dryRun 时只诊断不修（手动触发接口默认 dryRun=true，安全第一）
      if (dryRun) return { ok: true, dryRun: true, note: 'dryRun：只诊断，没有真的清' }
      const seq = Number(startSeq)
      if (!Number.isFinite(seq)) return { ok: false, error: '没有可用的 seq' }
      // ★ 一次只清一条（ranges 可能给区间，但 purge 是逐条替换）
      return sessionDispatch.purge({
        sessionId: sid,
        items: [{ seq, reason: String(reason || '换气干预').slice(0, 80) }],
      })
    },
    log: (m) => { if (!config.quiet) console.log('  [换气干预] ' + m); },
  });
};
// ★ 把干预接给 HTTP 入口（/api/huanqi/intervene）
setIntervener(loop.huanqiIntervene);
// ★ 2026-11-13：把宿主扫描接给自动巡视（/api/huanqi/auto，心跳调它）。
//   爀曦：「换气以条件触发为主，省性能；定时触发集成进心跳」。
setHostScanner(scanActiveHostSessions);
// ★ 已清 seq 的记录文件（放 dataDir 里，跟其它状态文件一起）
try {
  const path = await import('node:path');
  setPurgedFile(path.join(config.dataDir || 'data', 'huanqi-purged.json'));
} catch (e) { if (!config.quiet) console.log('  [换气] 记录文件没接上：' + String((e && e.message) || e)); }

// —— 器官：回声哨兵（2026-11-10 · F 切片）——
//
// ★ 结果落 <dataDir>/echo-sentinel.json；状态台只读那份文件，不在渲染时跑体检。
// ★ 不注册定时器：启动探一次、读接口发现过期再探一次、显式 ?refresh=1 —— 三处触发，没有倒计时。
const echoSentinel = createEchoSentinel({
  dataDir: config.dataDir,
  doctorPath: (config.integrations && config.integrations.echoDoctorPath) || '',
  nodePath: process.execPath,
  timeoutMs: (config.integrations && config.integrations.echoProbeTimeoutMs) || undefined,
  ttlMs: (config.integrations && config.integrations.echoProbeTtlMs) || undefined,
  log: (m) => { if (!config.quiet) console.log('  [哨兵] ' + m); },
});

let autonomousBusy = false;
sched.rule({
  name: 'autonomy',
  every: 60 * 1000,
  check: async () => {
    if (autonomousBusy) return null;
    autonomousBusy = true;
    try {
      // ★★ 2026-11-11：动态目标**先解析、再判定** —— 同一次 tick 从头到尾只用一个 id。
      //   refreshIfNeeded 只在「开着 + 推宿主 + 没固定指定」时才真的发请求；
      //   其它情况一次网络请求都不发（不动的时候不许有副作用）。
      //   ★ 这**不是**第二套倒计时：读的是 dsh-yanqing-heartbeat 自己的 /heartbeat/auto，
      //     节拍仍是本规则这 60 秒一下，只是每个节拍先问一句「现在的主导是谁」。
      await leadTarget.refreshIfNeeded(autonomy.config);
      await hostAutonomy.tick();
    } catch (e) {
      // ★ 投递器自己炸了不许把调度带下去；但要说出来，不许静默。
      if (!config.quiet) console.log('  [自主] tick 失败（不影响服务）：' + (e && e.message));
    } finally {
      autonomousBusy = false;
    }
    // ★★★ 返回 null 是**设计**：sched 会把 truthy 的 summary append 进 events.session 的
    //   frames.jsonl —— 而那会改 mtime。自主的判据要的是「宿主那边有没有人」，
    //   不是「v4 刚往哪个会话写没写」。结果已落 autonomy.json 的 lastAttempt。
    return null;
  },
});

// ★ 2026-11-07：让 MCP 工具（同进程内的另一个模块）能拿到 hub ——
//   它是 soul_ask_host 的唯一出口。**挂在 globalThis 上是权宜**：
//   更干净的做法是让 callTool 通过参数拿到它，但那是接口改动，先不动。
globalThis.__controlHub = control;
// ★ 2026-11-07：notify_lead 要「先入账、再过宪章」，所以把这两个器官也挂出来。
//   ★ 用 globalThis 而不是 import：notify 是闭包，创建时这些还没建好。
globalThis.__ledger = ledger;
// ★ 2026-11-10 第八轮（整合 ③）：面板入口收口到 guard 的 checkPanel()（内部 = check()）。
//   ★ 与 /api/guard、soul_guard 用同一个 LlmClient 实例与同一套 llmConfigured 判据；
//     不再有「面板只跑规则层」这条第二条判据。
//   ★ from='v4-panel' 是内部上下文标记，不是身份认证（外部来源永远不因 role 获得授权）。
globalThis.__guardCheck = (text) => checkPanel(text, {
  llm,
  llmConfigured: Boolean(llm && (typeof llm.ready === 'function' ? llm.ready() : typeof llm.chat === 'function')),
});
// ★ 2026-11-10：llm 一起交出去 —— /api/guard 的模糊层用它（同一个实例，不新建宿主）。
const server = createServer({ store, loop, tools, config, bus, sched, persona, autonomy, ledger, control, degradation, eventsIngress, sessionDispatch, llm, cleanup, echoSentinel });

// ── POST /api/shutdown（2026-11-09 · M0 壳集成）──────────────────────────────
//
// ★ 为什么要它：桌面壳（build\Shell.cs）关窗时要让 core **自己走优雅退出**
//   （冲索引缓存 + 写 shutdown.log），而不是把它杀掉。杀掉的话，
//   data/shutdown.log 里会留下一行 graceful:false —— 而「关了再开就慢」
//   正是那条路造成的（见下面优雅退出那一段的长注释）。
//
// ★ 为什么写在 index.mjs 而不是 web/server.mjs：
//   路由表在 server.mjs，但**退出的实现**（shutdown()）在这里。
//   把「能不能杀这个进程」交给一个只该渲染页面的模块，是把权力放错了地方。
//   所以这里包一层 request 监听：命中 /api/shutdown 就自己回包，
//   没命中就**原样**交给 server.mjs 的路由处理 —— 别的路由一个字都不动。
//
// ★ 只认回环。判据是 req.socket.remoteAddress ——
//   **不是** Host 头、**不是** X-Forwarded-For（那两样客户端随便写）。
//   config.host 本来就是 127.0.0.1，这一条是第二道锁：
//   万一以后有人把 host 改成 0.0.0.0，这个端点也不会变成「局域网任意人关我服务」。
const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1']);

function isLoopbackRequest(req) {
  const a = String((req.socket && req.socket.remoteAddress) || '');
  return LOOPBACK_ADDRS.has(a);
}

/** 命中并处理了返回 true；不是这个路由返回 false（调用方继续走原路由）。 */
function handleShutdownEndpoint(req, res) {
  let p = '';
  try { p = new URL(req.url, 'http://x').pathname; } catch { return false; }
  if (p !== '/api/shutdown') return false;

  const reply = (code, obj) => {
    try {
      const body = JSON.stringify(obj);
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
        Connection: 'close',
      });
      res.end(body);
    } catch { /* 回包失败也不许改退出决定 */ }
  };

  if (req.method !== 'POST') {
    reply(405, { ok: false, error: '只接受 POST' });
    return true;
  }
  if (!isLoopbackRequest(req)) {
    if (!config.quiet) console.log('  [退出] 拒绝 /api/shutdown：来源 ' + ((req.socket && req.socket.remoteAddress) || '?') + ' 不是回环');
    reply(403, { ok: false, error: '只接受 127.0.0.1 的请求' });
    return true;
  }

  // ★ 顺序：**先回 202，再退出**。反过来的话壳那头拿到的是「连接被重置」，
  //   它会误判成「端点没生效」→ 转去强杀 → graceful:false。
  reply(202, { ok: true, accepted: true, reason: 'shell', pid: process.pid });
  // 50ms 足够把 202 冲出 socket，又不至于让壳觉得端点没反应。
  setTimeout(() => { shutdown('shell').catch(() => process.exit(0)); }, 50).unref?.();
  return true;
}

// 包一层：先看是不是 /api/shutdown，不是就交给原监听器（server.mjs 的路由）。
// ★ 不 removeAllListeners 之后再 listen —— 顺序必须是「先取出来、再重挂」，
//   取下和重挂之间不许有 await（这里是同步段，不会有请求插进来）。
// ★★ 2026-11-12：把 aurabot 插件挂起来。
//   顺序：必须在路由包装之前 —— handleAurabotApi 要在包装层里被调用。
//   用 try 包死：aurabot 起不来不该让 v4 起不来（它是新增能力，不是命脉）。
let aurabot = null;
try {
  const ab = createAurabotCtx({
    llm,
    log: (m) => { if (!config.quiet) console.log(m) },
    logLevel: config.quiet ? 'warn' : 'info',
    services: { llm, config },
  });
  const mod = await import('./aurabot/src/host.js');
  await mod.apply(ab.ctx);
  aurabot = ab;
  const v = ab.view();
  console.log('  aurabot 已挂载：' + v.routes + ' 个接口 · 变量 ' + v.variables.length + ' 个 · 定时器 ' + v.intervals);
} catch (e) {
  console.log('  aurabot 挂载失败（不影响 v4）：' + String((e && e.message) || e).slice(0, 200));
}

const baseRouteListeners = server.listeners('request');
server.removeAllListeners('request');
server.on('request', (req, res) => {
  try {
    if (handleShutdownEndpoint(req, res)) return;
    // ★ 同一个形状：命中 /api/search 就由它回，不是就往下走。
    //   库路径固定为 <dataDir>/meta.sqlite —— 那个库由 tools/db-sync.mjs 建。
    // ★ 2026-11-12：库挪到统一记忆库（00-记忆库），路径从配置读，不写死 dataDir。
    if (handleSearchEndpoint(req, res, { dbPath: indexDbPath(config) })) return;
    // ★ 换气：只判断不动手。执行清理走 cleanup.mjs 的 targeted-cleanup。
    if (handleHuanqiAnalyze(req, res, { llm, dataDir: config.dataDir, log: (m) => { if (!config.quiet) console.log(m) } })) return;
    // ★ aurabot 的 57 个接口（整个插件搬过来之后，面板要的都在这）
    // ★ aurabot 面板的静态资源（client.js / vendor/react / 面板页）
    // ★ echo 体检（只读）—— 放在 aurabot 前面。
    //   ★ 为什么这么写：这个 request 回调是**同步**的，不能 await。
    //     所以先**同步**判断路径（isEchoPath），命中再把异步处理丢出去。
    //     如果写成 `if (await handleEchoApi(...))` 会直接 SyntaxError（我踩了一下）。
    // ★ 上下文手术（异步：要等 bridge 回执）
    if (isContextPath(req)) {
      handleContextApi(req, res, { dispatch: sessionDispatch, log: (m) => { if (!config.quiet) console.log(m) } })
        .catch((e) => { try { res.destroy() } catch {} });
      return;
    }
    // ★ 宿主会话扫描（同步，只读文件）
    if (isHostScanPath(req)) {
      handleHostScan(req, res, { log: (m) => { if (!config.quiet) console.log(m) } });
      return;
    }
    // ★ 主动诊断：扫所有活跃会话（异步，先同步判路径）
    if (isHuanqiScanPath(req)) {
      handleHuanqiScan(req, res, { dataDir: config.dataDir, llm, log: (m) => { if (!config.quiet) console.log(m) } })
        .catch((e) => { try { res.destroy() } catch (e2) {} });
      return;
    }
    // ★ 台账：读五视图 + 写判定（异步，和 echo 一样先同步判路径）
    if (isWakerPath(req)) {
      handleWakerApi(req, res, { ledger, config, log: (m) => { if (!config.quiet) console.log(m) } })
        .catch((e) => { try { res.destroy() } catch (e2) {} });
      return;
    }
    if (isEchoPath(req)) {
      handleEchoApi(req, res, { log: (m) => { if (!config.quiet) console.log(m) } })
        .catch((e) => { try { res.destroy() } catch (e2) {} });
      return;
    }
    if (handleAurabotStatic(req, res, {
      webDir: path.join(HERE, 'web'),
      aurabotDir: path.join(HERE, 'aurabot'),
    })) return;
    if (aurabot && handleAurabotApi(req, res, { routes: aurabot.routes, log: (m) => { if (!config.quiet) console.log(m) } })) return;
    if (handleAurabotStatus(req, res, {})) return;
  } catch {
    // 端点自己出错不许把正常路由带下去；落到下面照常处理（会被当未知路由 404）
  }
  for (const fn of baseRouteListeners) {
    try { fn.call(server, req, res); } catch { /* 原路由自己的 try/catch 更细，这里只防同步抛出 */ }
  }
});

// ★ 2026-11-09：优雅退出要关掉这两样东西 —— 但它们一个在 listen 回调里、一个在
//   动态 import 之后才创建。先声明成 null，退出时按「有没有」来关，不猜。
let watchdog = null;      // 父进程看门狗
let mobileChat = null;    // 手机通道（第二个监听，另一个端口）

// ── 同步：把 DSH 的会话日志持续吸进来 ──────────────────────────
//
// ★★ 为什么这件事必须在主进程里做，而不是「想跑的时候跑一下命令行」：
//
//   爀曦 2026-11-07：「上下文要抄给 v4，这样才能做有力的诊断和定点清除」
//   —— 但内容本来就在（soul-sync 早就把 DSH 的 session.v4.jsonl 读进来了）。
//   **缺的从来不是「抄」，是「持续」。**
//   实测：sync-state.json 的 at 停在 2026-11-06T20:30，而那时起已经过去 15 小时 ——
//   于是 v4 手上是「昨天的我」，刚才说的话搜不到。
//
// ★ 为什么用主进程的 store 实例（useStore），不另起一个：
//   两边各 new 一个 SessionStore 写同一个目录 = 谁也看不见谁写的帧
//   —— 那就是「两条腿互相看不见」那个坑的形状，只不过这次是进程内两条腿。
//   主进程自己的 store 带 index 缓存，它写的帧主进程立刻能搜到。
//
// ★ 三条纪律（都来自踩过的坑）：
//   ① **失败不许影响主服务** —— 包死 try/catch，打一条 warn 就过
//   ② **不许叠加** —— 上一轮没跑完，这一轮直接跳过（1016 个会话扫一次不便宜）
//   ③ **间隔可配** —— config.sync.intervalSec，默认 30 秒
// ★ 2026-11-10：tick 改成**分片轮次**（roundAsync），不再是同步 round()。
//
//   原来 tick 里直接调同步 round()：40 个会话、逐帧 zstdDecompressSync。
//   实测 39.18MB 的单文件就要 3.3 秒，而这几秒里事件循环是死的 ——
//   用户在这时关窗，POST /api/shutdown 进不来，壳等满超时就强杀，
//   shutdown.log 留下 graceful:false（下次启动又慢）。**慢 → 关不掉 → 还慢。**
//   ★ 只在文件之间让出不够：最大的那个文件自己就能占满整个窗口。
//
//   roundAsync 逐帧让出，并且**认得到关闭**：shutdown 里 cancelSync() 一调，
//   正在跑的那一轮在下一次让出时立刻 saveState 后返回，不写下一批。
//
//   代价与收益（实测，脚本与读数在 _verify/frame-yield-20261110-044858/）：
//     · 读一个 39.18MB 会话：3.3s → 4.1s（+25%），最长阻塞 22.6ms（原来整段 3.3 秒）
//     · 整轮 3 个会话 15,707 帧：21.8s → 22.9s（+5%，写盘占大头）；
//       同一台机负载高时 30.2s → 35.1s（+16%）
//     · 整轮最长阻塞 1919ms —— 来自一个「14 个 zstd 帧装下 7.86MB」的会话：
//       单帧解压 + 解析是原子的，逐帧让出挡不住它（报告里写在「已知残留」）
let shuttingDown = false;   // ★ 提前声明（原来在下面 552 行）—— tick 的 shouldStop 要读它；
                            //   let 在 TDZ 里连 typeof 都会抛，所以声明必须在定时器注册之前。
// ★★ 2026-11-10（G2a）：AGENT_SOUL_SYNC=off —— **首轮与定时都不跑**。
//
//   为什么需要这个开关：原来关同步只能改 config.json 的 sync.enabled，
//   而那是**生产配置文件**。隔离测试不许动生产配置，没有 env 开关，
//   测试就只能"测一个和线上不同的配置"—— 那测的就不是同一条启动路径了。
//
//   ★ 只关**进程内的**首轮与定时；显式 CLI 同步（node tools/soul-sync.mjs）不看这个变量 ——
//     那是人明确要跑的动作，不该被一个后台开关顺手关掉。
//   ★ 也不写 sync-state.json：水位只在 round() 里落盘（tools/soul-sync.mjs:46-50），
//     轮次不跑就没有这一笔 —— 这是"关掉"的判据，不是副产品。
//   ★ 启动仍会写的三样（index cache / _index.fp / shutdown.log）**不在这个开关的管辖内**——
//     它们是 store 与优雅退出自己的白名单边界，改了就是另一个改动包的事。
const syncEnvOff = syncDisabled();
const syncOn = !syncEnvOff && !(config.sync && config.sync.enabled === false);
if (syncEnvOff && !config.quiet) {
  console.log('  同步    已关（AGENT_SOUL_SYNC=off）—— 首轮与定时都不跑，不写 sync-state.json；显式 node tools/soul-sync.mjs 不受影响');
}
if (syncOn) {
  try {
    syncUseStore(store);   // ★ 关键：用主进程的 store，不是 sync 自己 new 的那个
    const sec = (config.sync && config.sync.intervalSec) || 30;
    let syncing = false;
    const tick = () => {
      if (syncing || shuttingDown) return;   // 纪律②：不叠加；关闭中不开新轮
      syncing = true;
      syncRoundAsync({ yieldMs: 8, shouldStop: () => shuttingDown })
        .then((r) => {
          if (!r) return;
          if (r.aborted) {
            if (!config.quiet) console.log('  [同步] 已中止（关闭中）· 水位已落盘（让出 ' + r.yields + ' 次）');
            return;
          }
          if (r.wrote > 0 && !config.quiet) {
            console.log('  [同步] +' + r.wrote + ' 帧进 ' + r.touched + ' 个容器（扫了 ' + r.files + ' 个会话 · 让出 ' + r.yields + ' 次 / 最长阻塞 ' + r.maxBlockMs + 'ms）');
          }
        })
        .catch((e) => {
          // 纪律①：同步挂了不许把服务带下去
          if (!config.quiet) console.log('  [同步] 失败（不影响服务）：' + (e && e.message));
        })
        .finally(() => { syncing = false; });
    };
    // 启动 5 秒后跑第一次（让服务先起来），之后每 sec 秒一次
    setTimeout(tick, 5000);
    setInterval(tick, sec * 1000).unref?.();
    console.log('  同步    每 ' + sec + ' 秒一次（DSH 会话日志 → v4 · 分片版）');
  } catch (e) {
    console.log('  同步    ✗ 起不来（不影响服务）：' + (e && e.message));
  }
}

server.listen(config.port, config.host, () => {
  const url = 'http://' + config.host + ':' + config.port;
  console.log('');
  console.log('  agent-soul  v0.1.0');
  console.log('  ─────────────────────────────');
  console.log('  GUI      ' + url);
  console.log('  MCP      ' + url + '/mcp   ← 别的 harness 接这个地址');
  console.log('  工作区   ' + workspace);
  console.log('  数据     ' + config.dataDir);
  // ★ 1.0.2：这一行要说清三件事 —— 走哪个协议、发往哪个端点、key 从哪来。
  //   「已配置」三个字不够：协议配错也是一种「配好了但调不通」。
  console.log('  模型     ' + config.llm.model + ' · ' + llm.protocol + ' → ' + llm.endpoint()
    + (llm.ready() ? '  ✓ key 来自 ' + (config.llm.apiKeySource || 'unknown') : '  ✗ 缺 apiKey'));
  // ★ 2026-11-10（G2a）：只在显式只读时多打一行 —— 生产默认输出逐字不变。
  if (readonlyEnabled()) {
    console.log('  只读     ★ 显式只读（AGENT_SOUL_READONLY=1）—— 写面按 manifest 全部拒绝（服务在线，不是离线降级）');
  }
  console.log('  工具     ' + [...tools.tools.keys()].join(', '));
  // ★ 2026-11-10：不再在这里调 store.list() —— 它会同步 readdir + 逐会话读首行 + stat，
  //   1000 个会话实测 0.7–1.2 秒，正好卡在「端口已经监听了、但事件循环被占住」的窗口里。
  //   那一刻用户关窗，POST /api/shutdown 就得干等 —— 这是同一个坑的另一个入口。
  //   有缓存就直接用；没有就交给预热（它分片扫描，计数随后打在同一段日志里）。
  console.log('  会话     ' + (store.listCache ? store.listCache.length + ' 个' : '预热时统计'));
  console.log('  人格     ' + (pr.loaded ? pr.loaded + ' 个文件 / ' + persona.render().used + 'B' : '未配置') + (pr.missing.length ? '（缺 ' + pr.missing.length + '）' : ''));
  console.log('  事件     ' + sched.rules.length + ' 条规则 / 每 ' + Math.round(sched.intervalMs / 1000) + 's 一次');
  // ★ 2026-11-10 D 切片：把**目标**和**退路**一起印出来 —— 旧版这里只说「静默 N 分钟触发」，
  //   看的人会以为到点就一定有人被叫醒。现在没有目标就是 fail-closed，必须一眼可见。
  // ★ 2026-11-11：目标有三种状态，必须一眼分得开 —— 跟随 lead / 固定覆盖 / 解析不出。
  //   「跟随」**不是**「没配」：D 切片那版这里印的是「★ 未配置 → fail-closed，不下发」，
  //   看的人会以为自主是残废的；其实留空才是默认该走的路。
  const autoTarget = String(autonomy.config.targetSession || '').trim();
  const leadNow = leadTarget.state();
  const autoTargetText = autoTarget
    ? '固定 ' + autoTarget
    : '跟随《墨》当前 lead（动态；'
      + (leadNow.ok ? '当前 ' + leadNow.sessionId : '尚未解析：' + String(leadNow.why || '').slice(0, 60))
      + '；解析不出 → 不下发）';
    console.log('  自主     ' + (autonomy.config.enabled
      ? '开（目标 ' + autoTargetText
        + ' · 静默 ' + autonomy.config.idleThresholdMinutes + ' 分钟 · 推宿主 '
        + (autonomy.config.pushToHost === false ? '关（也没有自跑退路）' : '开')
        + '）'
      : '关（config.autonomy.enabled 打开）'));
    if (autonomy.legacySession) {
    console.log('          ↳ 旧字段 autonomy.session="' + autonomy.legacySession + '" 不迁移 —— 它语义是「没有就新建」；要固定目标请填 autonomy.targetSession，要跟随 lead 就留空');
    }
  const lv = ledger.views();
  console.log('  台账     ' + lv.badge + ' 条未处理（等判定 ' + lv.act.length + ' / 待审计 ' + lv.audit.length + '）');
  // ★ 2026-11-10（F 切片）：哨兵配了谁做体检、结果落哪 —— 一行说清，省得去猜「为什么是 UNKNOWN」
  console.log('  哨兵     ' + (echoSentinel.doctorPath
    ? 'echo-doctor --fast（' + echoSentinel.doctorPath + '）→ ' + path.join(config.dataDir, 'echo-sentinel.json')
    : '未配置（integrations.echoDoctorPath）—— 状态台会显示 UNKNOWN，不假装健康'));
  // ★ 2026-11-10：事件接入的 start 放在这里 —— 服务已经真的在监听了，这一行之后再决定连不连。
  //   两道闸在 eventsIngress.start() 里：① enabled（mode！=off 且配置没错）② 非 readonly。
  //   它自己会打印「为什么没起」—— 不静默。
  try {
    const ir = eventsIngress.start();
    if (ir.started) {
      console.log('  事件接入 ' + ir.mode + ' → ' + ir.dir + '（本进程是这份账的唯一写者）');
    } else {
      const why = (ir.reason && (ir.reason.message || ir.reason.code)) || 'disabled';
      console.log('  事件接入 未启动：' + why);
    }
  } catch (e) {
    console.log('  事件接入 起不来（不影响主服务）：' + (e && e.message));
  }
  console.log('');
  // ★ 2026-11-10（F 切片）：启动后跑一次真探测（**没有定时器** —— 这是唯一一次自动触发）。
  //   失败不影响服务：结果只是一条 probe.ok:false 的记录，状态台会如实显示。
  echoSentinel.probeInBackground('startup')
    .then((r) => {
      if (!r || config.quiet) return;
      if (r.probe && r.probe.ok) console.log('  哨兵     首探 ' + r.state + ' · ' + r.probe.latencyMs + 'ms');
      else console.log('  哨兵     首探失败：' + ((r.probe && r.probe.error) || '未知'));
    })
    .catch(() => { /* 哨兵炸了不许影响服务 */ });
  // ★ 预热：把首次访问才会算的慢活挪到启动期（用户看不见）
  if (server.warmup) {
    server.warmup().then((w) => {
      console.log('  预热完成 ' + w.ms + 'ms  (' + w.steps.join(' · ') + ')');
      console.log('');
    }).catch((e) => {
      console.log('  预热失败（不影响使用）：' + (e && e.message));
      console.log('');
    });
  }

  // ★ 父进程看门狗（见 src/util/parent-watchdog.mjs）。
  //   为什么放在这里而不是文件最开头：此刻服务已经真的能用、预热也跑完了 ——
  //   **这时候「启动器没了」才是异常**。放在最前面的话，启动器恰好在这个窗口退出，
  //   我们会连一句「起来了」都没打就消失，那比多活两秒更糟。
  watchdog = installParentWatchdog();
  if (watchdog.active) console.log('  看门狗  已装（父进程退出时我会跟着退）');

  // ★ 手机通道：**第二个监听**，绑 0.0.0.0（主 server 绑 127.0.0.1，手机连不上）。
  //   单独一个端口、不带认证 —— 所以它只读最近的对话 + 能发消息，
  //   **不给文件访问、不给命令执行**。关掉它：config.chat.enabled = false。
  import('./chat/mobile.mjs').then(({ startMobileChat }) => startMobileChat({ store, loop, config, log: console.log }))
    .then((r) => {
      mobileChat = r;   // ★ 退出时要把这个监听也关掉（它绑的是另一个端口）
      if (r && r.started) console.log('  手机    http://' + (r.urls && r.urls[0] || ('0.0.0.0:' + r.settings.port)) + '  ← 同一局域网可开');
      else if (r && r.reason) console.log('  手机    ' + r.reason + '（' + (r.hint || '') + '）');
    })
    .catch((e) => console.log('  手机    没起来（不影响主服务）：' + (e && e.message)));
  if (!llm.ready()) {
    console.log('  ⚠ 还没配 apiKey —— 三种填法任选一种：');
    console.log('      ① 运行 AgentSoul-Setup 安装向导，在「API 配置」页填（推荐，key 交给 DPAPI）');
    console.log('      ② 在 ' + path.join(ROOT, 'config.json') + ' 里填 llm.apiKey，或配 llm.apiKeyRef = dpapi:<providerId> / env:<变量名>');
    console.log('      ③ 设环境变量 AGENT_SOUL_KEY。填完重启即可。');
    if (config.llm.apiKeyRefError) console.log('     ↳ 引用没解出来：' + config.llm.apiKeyRefError);
    console.log('');
  }
});

// ── 优雅退出（G2a 硬前置③ · 2026-11-09）────────────────────────────────────
//
// ★ 改之前这里只有三行：
//     for (const sig of ['SIGINT','SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
//   全文没有 closeAll / saveIndexCache，store.mjs 也没有 exit 兜底。后果是实测出来的：
//   服务跑起来之后追加的所有帧，**索引缓存一个字都没写回去**
//   （data/_index.cache 停在启动那一刻，72.6MB；_index.fp 也一起停住），
//   于是下次启动 fp 里的 size:mtime 大面积对不上 → 逐个会话重读 index.jsonl 重建索引。
//   「关了再开就慢」不是玄学，就是这条路没走。
//
// ★ 顺序为什么是「先停止收活 → 再冲缓存」，不能反：
//   反过来的话 HTTP 还在接活，而 store 的写句柄已经关了 ——
//   那不是优雅退出，那是关灯之后再让人进门。
//
// ★ 为什么在 process.on('exit') 里也做一次：exit 里只能跑同步代码，
//   而 store 的落盘恰好全是同步的（writeFileSync / closeSync）—— 所以这条路真兜得住
//   「父进程看门狗判死」「uncaught 之后进程退出」这些不走信号的退出。
//   ★ 它兜不住 taskkill /F 和断电：那两种没有任何钩子会跑。
//     判据：data/shutdown.log 里有没有对应那一行 —— 没有就是被硬杀的。

const SHUTDOWN_TIMEOUT_MS = Math.max(
  200,
  Number(process.env.AGENT_SOUL_SHUTDOWN_TIMEOUT_MS) ||
  Number(config.shutdown && config.shutdown.timeoutMs) ||
  5000
);

// ★ shuttingDown 已在同步段之前声明（tick 的 shouldStop 读它）
let shutdownLogged = false;  // ★ 日志只写一行 —— exit 兜底会回头看一眼它
let httpDrained = null;      // null=还没试 / true=关干净了

/** 缓存文件指纹 —— 判断「这一次到底写没写进去」，不拿返回值猜 */
function cacheStamp() {
  try { const st = fs.statSync(store.cacheFile); return st.size + ':' + st.mtimeMs; } catch { return '0:0'; }
}

/** 退出路径里唯一必须同步的那一段：冲索引缓存 + 关句柄。正常退出与 exit 兜底共用。 */
function flushStoreSync() {
  const dirty = store.ixDirty === true;
  const before = cacheStamp();
  let rows = 0;
  let error = null;
  try { rows = store.saveIndexCache(); } catch (e) { error = String((e && e.message) || e); }
  const wrote = cacheStamp() !== before;
  let closed = false;
  try { store.closeAll(); closed = true; } catch (e) { error = error || String((e && e.message) || e); }
  return {
    // ★ 不脏也算保存成功：磁盘上那份就是最新，没丢东西。
    //   只有「脏了但文件没变」才是真失败 —— 那才是下次要重建的原因。
    cacheSaved: dirty ? wrote : before !== '0:0',
    cacheDirty: dirty,
    cacheRows: rows,
    fdsClosed: closed,
    ...(error ? { cacheError: error } : {}),
  };
}

/** 写一行结构化日志。★ 只有它能写，所以每次退出最多一行。 */
function recordShutdown(reason, graceful, t0, extra) {
  if (shutdownLogged) return null;
  shutdownLogged = true;
  const rec = {
    at: new Date().toISOString(),
    reason: String(reason || 'unknown'),
    graceful: !!graceful,
    ...flushStoreSync(),
    ms: Date.now() - t0,
    pid: process.pid,
    ...(extra || {}),
  };
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.appendFileSync(path.join(config.dataDir, 'shutdown.log'), JSON.stringify(rec) + '\n', 'utf8');
  } catch {
    // ★ 日志写不进去也不许挡着退出。退出路径上抛异常是最坏的结果 ——
    //   它会盖掉原本那个「为什么要退」的原因。
  }
  return rec;
}

/** 完整关闭流程（可 await）；SIGINT / SIGTERM 走这条 */
async function shutdown(reason) {
  if (shuttingDown) {
    if (!config.quiet) console.log('\n（已经在关闭中，' + reason + ' 忽略）');
    return;
  }
  shuttingDown = true;
  const t0 = Date.now();
  // ★ 2026-11-11：退出耗时分在哪些阶段 —— 写进 shutdown.log 的 stages 字段。
  //   起因：连续四五次退出全是 shell:timeout / ms≈5300 / cacheDirty，但**不知道卡在哪一步**。
  //   盲改超时值只会把「5 秒强退」变成「10 秒强退」，cacheDirty 照旧。先量，再改。
  const stages = {};
  const mark = (k) => { stages[k] = Date.now() - t0; };
  if (!config.quiet) console.log('\n关闭中…（' + reason + '，最多等 ' + SHUTDOWN_TIMEOUT_MS + 'ms）');

  // ★ 超时保底：到点就自己收尾。★ 它必须能在「什么都没关掉」的状态下
  //   也把缓存写下去 —— 所以走的是同一个 recordShutdown，不是另开一条路。
  const hardTimer = setTimeout(() => {
    httpDrained = false;
    const rec = recordShutdown(reason + ':timeout', false, t0, { forced: true, httpDrained: false, stages });
    if (!config.quiet && rec) {
      console.error('  强退（等满 ' + SHUTDOWN_TIMEOUT_MS + 'ms）· 索引缓存 ' + (rec.cacheSaved ? '已落盘' : '未落盘'));
    }
    process.exit(0);   // ★ 0：这是「有人让我停」，不是崩溃
  }, SHUTDOWN_TIMEOUT_MS);
  hardTimer.unref?.();   // ★ 不许它成为「进程不退」的理由

  // ★★ 2026-11-10：**先叫停正在跑的异步同步轮次**，再往下走。
  //   取消是令牌式的：那一轮在下一次让出时发现令牌变了，立刻 saveState 后返回。
  //   ★ 这里最多等 1000ms —— 「等长帧解析全部结束」是绝对不允许的
  //     （39MB 单文件 3.3 秒，那正是 5 秒超时与 graceful:false 的来源）。
  //     无上限的那一段只留给「让出本身」，它几毫秒。
  try { syncCancel('shutdown'); } catch {}
  // ★★ 2026-11-11：1000ms → 200ms。诊断结论（shutdown.log 的 stages 一直是空对象，
  //   说明 mark('quiesce') 一次都没执行 —— 卡就卡在这一行）：
  //   syncQuiesce 自己的超时用 setTimeout，而它要等的那个轮次正在做**同步大文件解析**
  //   （注释里写过实测 39MB 单文件 3.3 秒）。事件循环被同步段占死时，
  //   1000ms 的定时器回调根本排不上，于是它一路等到壳的 5 秒强杀 ——
  //   而 hardTimer 也排在同一队列里，最后是**强杀**收场，graceful=false。
  //   等它不会让数据更安全：退出时那一轮无论如何都会被 process.exit 带走。
  //   等它只会把「优雅退出」变成「被壳超时强杀」，那是更糟的一种。
  try { await syncQuiesce(200); } catch {}
  mark('quiesce');

  // ① 停掉定期活：关闭过程中不许再开新活
  try { sched.stop(); } catch {}
  // ★★ 事件接入必须先停：WS/轮询一停就不会再有 append，之后 recordShutdown 里的
  //   store.closeAll() 才是干净的（顺序反了就是关灯之后还让人进门 —— 那条教训是这个项目付过的）。
  try { eventsIngress.stop('shutdown'); } catch {}
  try { if (watchdog && watchdog.stop) watchdog.stop(); } catch {}
  // ★ 2026-11-11：后台任务要跟着收 —— 否则每次关软件都留下一串孤儿 cmd.exe。
  try { jobManager.killAll('shutdown'); } catch {}
  mark('stopTimers');

  // ①-b ★★ 2026-11-11：**先关宿主 WS**，再关监听。
  //   顺序有讲究：server.close 只等 HTTP 连接；WS 是 upgrade 出来的，它不认那套。
  //   不先关它，close 的回调永远不来 —— 实证 stages 里根本没有 closeServer。
  try { control && typeof control.closeAll === 'function' && control.closeAll('shutdown'); } catch {}
  mark('closeHosts');

  // ② 关监听（**带硬上限**，不无限等）
  //
  // ★★ 2026-11-11 诊断实证：stages 一直是 {"quiesce":1,"stopTimers":1} 然后就没有 closeServer ——
  //   也就是卡死在这一段。而 shutdown.log 的 ms 恒为 ~5100，正好等于壳的 5 秒超时。
  //   原因：`server.close()` 会**一直等所有连接自己断开**，而 `closeAllConnections()`
  //   **不关 WebSocket** —— bridge 那条 /control 的 WS 是长连接，它不断，close 回调就永远不来。
  //   【因此】这里加一个硬上限：800ms 内没关干净就往下走。
  //   退出时不需要「所有连接都体面断开」，需要的是「缓存写完、进程干净退出」。
  await Promise.race([
    new Promise((resolve) => {
      let done = false;
      const fin = (ok) => { if (!done) { done = true; httpDrained = ok; resolve(); } };
      try {
        server.close(() => fin(true));
        server.closeIdleConnections?.();
        const grace = Math.min(600, Math.max(0, Math.floor(SHUTDOWN_TIMEOUT_MS / 2)));
        setTimeout(() => { try { server.closeAllConnections?.(); } catch {} }, grace).unref?.();
      } catch { fin(true); }
    }),
    new Promise((resolve) => setTimeout(() => resolve(), 800).unref?.()),
  ]);
  mark('closeServer');
  try { if (mobileChat && mobileChat.server) mobileChat.server.close(); } catch {}

  // ③④ 冲缓存 + 写日志（同步，不会被上面任何超时打断）
  const rec = recordShutdown(reason, true, t0, { httpDrained, stages });
  clearTimeout(hardTimer);
  if (!config.quiet && rec) {
    console.log('  已退出 ' + rec.ms + 'ms · 索引 ' + (rec.cacheSaved ? '缓存已落盘' : '缓存未落盘')
      + '（' + rec.cacheRows + ' 行）· 日志 ' + path.join(config.dataDir, 'shutdown.log'));
  }
  process.exit(0);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { shutdown(sig).catch(() => process.exit(0)); });
}

// ★ 最后一道网：不走信号的退出（父进程看门狗、uncaught、显式 process.exit）
//   ★ 这里只能同步；而且绝不许再抛 —— 退出路径上抛异常会把真正的死因盖掉。
process.on('exit', (code) => {
  // ★ 不走信号时的兜底：先把接入停掉（不再收、不再写账），再记退出账。
  //   finalSnapshot:false —— 退出路径上不再多写一个文件，账由 recordShutdown 收尾。
  try { eventsIngress.stop('exit:' + code, { finalSnapshot: false }); } catch {}
  try {
    if (shutdownLogged) return;   // 正常路径已经记过账，不重复
    recordShutdown('exit:' + code, false, Date.now(), { via: 'exit', exitCode: code });
  } catch { /* 兜底的兜底 */ }
});

