// agent-soul 入口
//
// 起法：node src/index.mjs
// 配置：项目根的 config.json（或 AGENT_SOUL_KEY / AGENT_SOUL_BASE_URL / AGENT_SOUL_MODEL / AGENT_SOUL_PORT）

import path from 'node:path';
import { loadConfig, ROOT } from './config.mjs';
import { installParentWatchdog } from './util/parent-watchdog.mjs';
import { SessionStore } from './session/store.mjs';
import { ToolRegistry } from './tools/registry.mjs';
import { LlmClient } from './llm/client.mjs';
import { AgentLoop } from './agent/loop.mjs';
import { createServer } from './web/server.mjs';
import { registerBuiltins } from './tools/builtin.mjs';
import { EventBus } from './events/bus.mjs';
import { Scheduler } from './events/scheduler.mjs';
import { PersonaLayer } from './persona/layer.mjs';
import { HuanqiDetector, STALL } from './organs/huanqi.mjs';
import { Autonomy, autonomousPrompt, PHASE } from './organs/autonomy.mjs';
import { Ledger, buildWakeText } from './organs/waker.mjs';
import { renderContext, usedTokens } from './organs/context.mjs';

const config = loadConfig();
const store = new SessionStore(config.dataDir);
const tools = new ToolRegistry();
const llm = new LlmClient(config.llm);
const loop = new AgentLoop({ store, llm, tools, config });

// 工作区：默认就是项目根；可在 config.json 里改
const workspace = config.workspace || ROOT;
registerBuiltins(tools, { workspace });

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
const pr = persona.load((config.persona && config.persona.files) || [], { root: ROOT });
loop.personaLayer = persona;
// ★ 上下文器官（时间 + 水位）—— 每轮拼进 systemPrompt
loop.__ctxMod = { renderContext, usedTokens };

// —— 器官：换气（huanqi）——
// ★ 这不是复制粘贴：它挂在 loop 的观察点上，用新运行时自己的流做判定。
const huanqiByRound = new Map();
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
  const key = String(payload.t || Date.now()) + '|' + String(payload.summary || '').slice(0, 60);
  ledger.ingest({ key, t: payload.t || new Date().toISOString(), title: payload.summary || '会话静默', from: 'event-bus', tier: 'watch' });
});

let autonomousBusy = false;
sched.rule({
  name: 'autonomy',
  every: 60 * 1000,
  check: async ({ session }) => {
    if (autonomousBusy) return null;
    const c = autonomy.check();
    if (c.phase !== PHASE.AUTONOMOUS) return null;

    // ★ 先看台账：有没有「叫过了但没人判」的
    const pending = ledger.views().act;
    if (pending.length) {
      const rec = pending[0];
      if (!llm.ready()) {
        return { summary: '台账里有 ' + pending.length + ' 条等人判定，但没有 apiKey' };
      }
      autonomousBusy = true;
      try {
        const sid = session || autonomySessionId();
        store.append(sid, 'event', { text: buildWakeText(rec, {}), meta: { kind: 'waker.wake', key: rec.key } });
        ledger.markWoken(rec.key, 3);
        const r = await loop.turn(sid);
        return { summary: '叫醒了（' + rec.title + '），' + (r && r.steps || 0) + ' 步' };
      } catch (e) {
        return { summary: '叫醒失败：' + (e && e.message) };
      } finally {
        autonomousBusy = false;
      }
    }

    // ★ 没有模型时不许「假装自主」—— 记一条事件可以，但不许空转
    if (!llm.ready()) {
      return { summary: '可以自主了（' + c.reason + '），但没有 apiKey，不跑' };
    }

    autonomousBusy = true;
    try {
      const sid = session || autonomySessionId();
      const text = autonomousPrompt(c, { threshold: autonomy.config.idleThresholdMinutes });
      // 把「我为什么现在自己动」写进会话，再跑一轮
      store.append(sid, 'event', { text, meta: { kind: 'autonomy.enter', idleMinutes: c.idleMinutes } });
      const r = await loop.turn(sid);
      autonomy.recordRun();
      return { summary: '自主回合结束（' + (r && r.stopReason || '?') + '，' + (r && r.steps || 0) + ' 步）' };
    } catch (e) {
      return { summary: '自主回合失败：' + (e && e.message) };
    } finally {
      autonomousBusy = false;
    }
  },
});

/** 自主回合落在哪个会话：优先用配置的，没有就新建一个专属容器 */
function autonomySessionId() {
  const want = (config.autonomy && config.autonomy.session) || 'autonomy';
  if (!store.load(want)) store.create(workspace, null, { id: want });
  return want;
}

const mainSession = (config.events && config.events.session) || null;
sched.start({ session: mainSession });

// ★ 启动时写一次索引缓存 —— 否则 /api/overview 的 cacheMB 恒为 0
try { store.buildIndex(); store.saveIndexCache(); } catch { /* 写不了就算了 */ }

const server = createServer({ store, loop, tools, config, bus, sched, persona, autonomy, ledger });

server.listen(config.port, config.host, () => {
  const url = 'http://' + config.host + ':' + config.port;
  console.log('');
  console.log('  agent-soul  v0.1.0');
  console.log('  ─────────────────────────────');
  console.log('  GUI      ' + url);
  console.log('  MCP      ' + url + '/mcp   ← 别的 harness 接这个地址');
  console.log('  工作区   ' + workspace);
  console.log('  数据     ' + config.dataDir);
  console.log('  模型     ' + config.llm.model + (llm.ready() ? '  ✓ 已配置' : '  ✗ 缺 apiKey'));
  console.log('  工具     ' + [...tools.tools.keys()].join(', '));
  console.log('  会话     ' + store.list().length + ' 个');
  console.log('  人格     ' + (pr.loaded ? pr.loaded + ' 个文件 / ' + persona.render().used + 'B' : '未配置') + (pr.missing.length ? '（缺 ' + pr.missing.length + '）' : ''));
  console.log('  事件     ' + sched.rules.length + ' 条规则 / 每 ' + Math.round(sched.intervalMs / 1000) + 's 一次');
  console.log('  自主     ' + (autonomy.config.enabled ? '开（静默 ' + autonomy.config.idleThresholdMinutes + ' 分钟触发）' : '关（config.autonomy.enabled 打开）'));
  const lv = ledger.views();
  console.log('  台账     ' + lv.badge + ' 条未处理（等判定 ' + lv.act.length + ' / 待审计 ' + lv.audit.length + '）');
  console.log('');
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
  if (installParentWatchdog().active) console.log('  看门狗  已装（父进程退出时我会跟着退）');

  // ★ 手机通道：**第二个监听**，绑 0.0.0.0（主 server 绑 127.0.0.1，手机连不上）。
  //   单独一个端口、不带认证 —— 所以它只读最近的对话 + 能发消息，
  //   **不给文件访问、不给命令执行**。关掉它：config.chat.enabled = false。
  import('./chat/mobile.mjs').then(({ startMobileChat }) => startMobileChat({ store, loop, config, log: console.log }))
    .then((r) => {
      if (r && r.started) console.log('  手机    http://' + (r.urls && r.urls[0] || ('0.0.0.0:' + r.settings.port)) + '  ← 同一局域网可开');
      else if (r && r.reason) console.log('  手机    ' + r.reason + '（' + (r.hint || '') + '）');
    })
    .catch((e) => console.log('  手机    没起来（不影响主服务）：' + (e && e.message)));
  if (!llm.ready()) {
    console.log('  ⚠ 还没配 apiKey —— 在 ' + path.join(ROOT, 'config.json') + ' 里填 llm.apiKey，');
    console.log('    或设环境变量 AGENT_SOUL_KEY。填完重启即可。');
    console.log('');
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { console.log('\n关闭中…'); server.close(() => process.exit(0)); });
}
