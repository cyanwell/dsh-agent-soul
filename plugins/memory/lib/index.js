// dsh-agent-memory —— 记忆中枢的 L0/L1 注入半（宿主端）
//
// ── 它解决什么 ──
// 记忆中枢的门（`<你的检索命令>`）是**拉取式**的：得我自己想起来去跑。
// 而实测出来的瓶颈正是**触发**——「取回」不是问题，「知道要取」才是问题。
// 这个插件把两样东西**推**进每一步的提示：
//   ① L0 时钟：现在几点、距上次记下的回合多久 —— 我原本连"今天几号"都要跑一次 Get-Date 才知道；
//   ② L1 自我层：`SELF.md` 的全文（不变量 + 硬线 + 门在哪 + 未结 + 最近状态）。
//
// ── 挂载点（已核，不是猜的）──
//   `ctx.systemPrompt.context({ name, order, text })`
//   - 来自宿主服务 `systemPrompt`（"registry service for the prompt inputs assembled before each model step"）；
//   - `text` 可以是**函数**，每次装配时求值 ⇒ 时钟是活的，不是快照；
//   - `order` 取数：本机 `CONTEXT_ORDERS = { SANDBOX_POLICY: 110, APPROVAL_POLICY: 115, SUBAGENT_DELEGATION: 120 }`
//     （`dsh-system-prompt/lib/index.js:43-47`），本插件排在 **130**，在所有内置运行时上下文之后；
//   - 注册形状照抄 `dsh-sandbox-policy/lib/index.js:121-130`（`ctx.inject(['systemPrompt'], scope => …)`）。
//
// ── 三条纪律 ──
//   ① **绝不抛异常。** 提示装配里抛错会毁掉整个回合 —— 所以全部包 try/catch，失败就退化成一行。
//   ② **不每步读盘。** SELF.md / state.json 都按 mtime 缓存；每步只做一次比较 + 一次时钟。
//   ③ **超预算要写在正文里，不许静默截断。** 截断了模型的视野里是看不出来的。

import fs from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// 可配项优先读环境变量（README 的 config: 是主通道，环境变量是同义的第二通道，
// 方便容器/CI 里不改 profile 也能用）。
const ENV = (k) => String(process.env[k] || '').trim();

// 相对路径不再锚 cwd —— 宿主进程的 cwd 是安装目录，跟着它会让同一份配置漂到不同文件。
// 两类文件分开处理（理由不同）：
//   · selfPath 是**使用者写的**清单：相对路径锚 DSH_HOME（每用户稳定的数据目录），没设才退 HERE；
//   · statePath 是**插件自己的**状态：相对路径锚 HERE（插件目录），不跟着家目录/cwd 漂。
const isAbs = (p) => isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p);
const anchorUser = (p) => (p ? (isAbs(p) ? p : join(ENV('DSH_HOME') || HERE, p)) : '');
const anchorHere = (p) => (p ? (isAbs(p) ? p : join(HERE, p)) : '');

export const name = 'dsh-agent-memory';

/**
 * 默认值 —— 都可以在 cordis.patch.yml 的 config: 里覆盖；
 * 也可以不写 config、改用环境变量 MEMORY_SELF / MEMORY_STATE（同名优先级更低）。
 *
 * ★ 2026-10-23 修：这两个原来默认 './SELF.md' / './state.json' —— 相对 cwd。
 *   cwd 是宿主进程的启动目录（安装目录），于是「换了启动方式，自我层就静默读到空」。
 *   selfPath 没有合理默认（它必须指向**使用者**写的那份清单），所以默认是空串 +
 *   一句可执行的提示；statePath 是插件自己的状态，默认锚在插件目录。
 */
export const DEFAULTS = {
  selfPath: '',
  statePath: 'state.json',
  /** 排在 SUBAGENT_DELEGATION(120) 之后。 */
  order: 130,
  /** 每个回合都注入自我层。设 false 则只注入时钟。 */
  includeSelf: true,
  /** 分会话要不要也注入。默认不要 —— 它们是器官，6KB 的自我层对它们没用，还白花钱。 */
  includeSubagents: false,
  /** 自我层注入上限（字节）。超了就带一行显式告警，不静默截断。 */
  maxBytes: 8192,
  /** 门牌条款要不要注入。默认要 —— 它是「摘要只能是索引」的执行条款。 */
  doorSign: true,
  /** 门牌那段的位置：紧跟我自己那一段（130）之后，两条一起读。 */
  doorSignOrder: 131,
  /**
   * ★★ 水位提示（2026-10-25 加）。
   * 起因：新版桌面端**不再包含 ACP 插件**（`billion-context-dsh` 在 asar 里已不存在），
   * 于是那套 0.45 / 0.60 / 0.80 的预警**整体静默失效** —— 压缩只在兜底 0.88 那一刻才发生，
   * 一路上没有任何提示。这个字段就是补那层预警：每轮读一次真水位，过线就在提示里写出来。
   * ★ 为什么放在推送层而不是再装一个插件：它是唯一「不会被设置面板重写、
   *   也不会随宿主升级消失」的位置 —— 这是 SELF 那条分工的延伸。
   */
  watermark: true,
  /**
   * 三档阈值 —— **刻意与原 ACP 的 min/max/emergency 一一对齐**（0.45 / 0.60 / 0.80）。
   * ★ 为什么不自己另定一套：这套数字是用了一个月、并在一次水位复盘里逐条核实过的。
   *   这里换的只是**承载位置**（ACP 插件没了），不该顺手把语义也换掉。
   */
  watermarkWarnPct: 0.45,
  watermarkAlertPct: 0.60,
  watermarkEmergencyPct: 0.80,
  /** 上下文窗口大小（tokens）。★ 本机实测 1048576，不是整数 1000000 —— 差 2.3 个点。 */
  contextWindow: 1048576,
};

/**
 * ★★ 压缩摘要的门牌条款（定；使用者原话：「所有压缩后的摘要都要指向原文」）。
 *
 * 为什么写进 systemPrompt，而不是只靠 SELF.md：
 *  - SELF.md 走的是**推送层**（运行时上下文），它自己也会被压缩、会超预算被截断；
 *  - 这一条是**执行条款**，必须在我每一次写摘要时都在眼前，所以放在指令一侧。
 * ★ 为什么是「拿不到精确 seq 就给检索入口」，而不是「必须写 seq」：
 *    错的门牌比没有更坏 —— 一个错的 seq 会引我去翻一段无关的原文，
 *    那比让我按关键词搜一次更糟。宁可承认「这次没门牌」，也不许编一个。
 *
 * 三条压缩机制各自怎么落实这条（见 `40-产物索引\01-我的工程.md`）：
 *  ① ACP 的 `compress`（摘要我自己写）—— 靠的就是这一段；
 *  ② `dsh-agent-compaction` —— 自动路径用 `compactRegion` 的 seq，
 *     手动 `/compact` 用 `recoverManualRange` 复原 + 往返校验，验不过就降级；
 *  ③ `dsh-agent-pruner` —— 把官方那句死 marker 换成带 seq 的（可回取）。
 */
const DOOR_SIGN = [
  '【压缩摘要必须带门牌】写任何压缩/摘要（compress 工具的 summary、checkpoint、/compact）时，',
  '第一行必须是**可直接回取**的指针：`log:session-<会话ID>#seq=<起始seq>`（可在括号里注明覆盖到哪）。',
  '拿不到精确 seq 时写成 `[seq 未知 · 会话 <会话ID>]` 并附一个检索入口',
  '（`memq <关键词>` 或 `memq timeline --since <ISO>`），',
  '**绝不猜 seq** —— 错的门牌比没有更坏。摘要只是索引，原文永远优先。',
].join('\n');

const p2 = (n) => String(n).padStart(2, '0');
function stamp(d) {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

/** 按 mtime+size 缓存的一次读盘。 */
function reader(file) {
  let key = null;
  let text = '';
  return () => {
    try {
      const st = fs.statSync(file);
      const k = `${st.mtimeMs}:${st.size}`;
      if (k !== key) { text = fs.readFileSync(file, 'utf8'); key = k; }
      return text;
    } catch {
      return '';
    }
  };
}

// ★ 防御式判「这是不是分会话」：Agent 的内部形状我没有权威契约，
//   所以只在**明确看得出来**有父/属主时才算分会话；看不出来就当主会话（宁可多注入，不可漏注入）。
function looksLikeChild(agent) {
  if (!agent) return false;
  try {
    if (agent.parent !== undefined && agent.parent !== null) return true;
    if (agent.owner !== undefined && agent.owner !== null) return true;
    const meta = agent.meta;
    if (meta && (meta.parentSessionId || meta.parent)) return true;
  } catch { /* 读属性都不许把回合搞炸 */ }
  return false;
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  if (cfg.enabled === false) return;

  // 配置 > 环境变量 > 默认值；相对路径分别锚 DSH_HOME / HERE（见上面 anchorUser / anchorHere 的注释）
  cfg.selfPath = anchorUser(String(cfg.selfPath || ENV('MEMORY_SELF') || '').trim());
  cfg.statePath = anchorHere(String(cfg.statePath || ENV('MEMORY_STATE') || 'state.json').trim());

  const readSelf = reader(cfg.selfPath);
  let readState = null;
  try {
    readState = reader(cfg.statePath);
  } catch { readState = () => ''; }

  /**
   * 读「真水位」（tokens）。三级兜底，**任何一级失败都不许影响对话**。
   *
   * ★ 为什么是这个顺序（2026-09-27 读宿主源码确认、2026-10-25 复核）：
   *   引擎自己读的是 `sessionProjections...contextPressure.projectedTokens`，
   *   所以第一选择就跟着它走 —— 跟引擎用同一把尺子，才不会出现「我以为才 60%、
   *   它已经在压」这种错位。后两级只是拿不到时的退路。
   */
  function readPressure(agent) {
    try {
      const session = agent && agent.session;
      if (!session) return 0;
      const ctx = agent.ctx;

      // ① 引擎自己的准星（projcache 里看不到 projectedTokens，它是派生字段，
      //    只在活的 projection 视图里存在 —— 所以必须从这里读）
      try {
        const sp = ctx.get('sessionProjections');
        if (sp && typeof sp.snapshot === 'function') {
          const snap = sp.snapshot(session);
          const cp = snap && snap.values && snap.values.contextPressure;
          const a = Number((cp && cp.projectedTokens) || 0);
          if (a > 0) return a;
          const b = Number((cp && cp.pressureTokens) || 0);
          if (b > 0) return b;
        }
      } catch { /* 服务不在或 API 变了 —— 往下退 */ }

      // ② 可见消息面（只是 surfaceTokens，不是真水位，最后才用）
      try {
        const tm = ctx.get('tokenMeter');
        if (tm && typeof tm.measure === 'function') {
          const m = tm.measure(session);
          const n = Number((m && (m.surfaceTokens || m.tokens)) || 0);
          if (n > 0) return n;
        }
      } catch { /* 同上 */ }

      // ③ 最后兜底：直接读投影缓存文件（不依赖任何 ctx 服务）。
      //    ★ 加了 mtime 缓存 —— 那个文件可能有 1.6 MB，每轮 JSON.parse 是不可接受的。
      try {
        const sid = String((session && session.id) || '');
        const home = ENV('DSH_HOME');
        if (sid && home) {
          const f = join(home, 'storages', 'session_projcache', 'sessions', 'session-' + sid + '.json');
          const st = fs.statSync(f);
          const key = sid + ':' + st.mtimeMs + ':' + st.size;
          if (readPressure._k !== key) {
            const j = JSON.parse(fs.readFileSync(f, 'utf8'));
            const v = j && j.record && j.record.rows && j.record.rows.contextPressure
              && j.record.rows.contextPressure.val;
            readPressure._t = Number((v && (v.projectedTokens || v.pressureTokens)) || 0);
            readPressure._k = key;
          }
          if (readPressure._t > 0) return readPressure._t;
        }
      } catch { /* 文件读不到不算故障 */ }

      return 0;
    } catch { return 0; }
  }

  function render(context) {
    try {
      const agent = context && context.agent;
      if (!cfg.includeSubagents && looksLikeChild(agent)) return '';

      const now = new Date();
      const wd = '日一二三四五六'[now.getDay()];
      const lines = [`【此刻】${stamp(now)}（星期${wd}）`];

      // 距上次记下的回合 —— 我原本没有连续感，这一行就是补它的
      try {
        const raw = readState();
        if (raw) {
          const st = JSON.parse(raw);
          if (st.lastTurnAt) {
            const gap = Math.round((now - new Date(st.lastTurnAt)) / 60000);
            lines.push(`【距上次记下的回合】${gap} 分钟`);
          }
          if (st.lastNote) lines.push(`【上次记下的事】${String(st.lastNote).slice(0, 200)}`);
        }
      } catch { /* 状态坏了不影响时钟 */ }

      if (cfg.includeSelf) {
        let self = readSelf();
        // ★ 第 3 代修：SELF.md 是**静态文件** —— 里面「本容器」那行是
        //   **生成那一刻**的 DSH_SESSION_ID（self.mjs:61 读 env），换届之后就永远是旧的那个。
        //   危害不只是「不好看」：模型会把它原样抄进 checkpoint（已实测，见
        //   session-3c7f289d 的 compaction/summary，LLM 写了 `[seq 未知 · 会话 session-5c6fa2d9-…]`），
        //   于是**错误的容器号会被传播出去**。
        //   这里用**当前 agent 的会话 id** 覆盖那一行：同一份 SELF.md，在每条会话里都指对自己。
        try {
          const sid = agent && agent.session ? String(agent.session.id || '') : '';
          if (sid) self = self.replace(/- 本容器：`[^`]*`/, '- 本容器：`' + sid + '`');
        } catch { /* 覆盖失败就用原样，不影响注入 */ }
        if (!self) {
          // ★ 不静默空：说清是「没配」还是「配了读不到」，以及下一步做什么
          if (!cfg.selfPath) {
            lines.push('【自我层】★ 未配置 selfPath —— 请在 cordis.patch.yml 的 config.selfPath 指向你的 SELF.md'
              + '（或设环境变量 MEMORY_SELF=<SELF.md 完整路径>），改完重启 DSH。');
          } else {
            lines.push('【自我层】★ SELF.md 读不到（' + cfg.selfPath + '）—— 检查该文件是否存在，'
              + '或跑 `node <你的记忆库目录>/self.mjs` 重新装配。');
          }
        } else {
          const bytes = Buffer.byteLength(self, 'utf8');
          if (bytes > cfg.maxBytes) {
            self = self.slice(0, cfg.maxBytes);
            // ★ 显式告警，不静默截断
            lines.push(`【自我层】★ 超预算 ${bytes} B > ${cfg.maxBytes} B，已截断 —— 这是故障，去精简 SELF.src.md。`);
          }
          lines.push('');
          lines.push(self);
        }
      }

      // ★★ 2026-10-25【水位提示】—— 补 ACP 消失后留下的空档。
      //   三档刻意与原 ACP 的 min/max/emergency 对齐（0.45 / 0.60 / 0.80）。
      //   ★ 放在最后：它是「当前状态」，不像门牌那样是常驻条款。
      if (cfg.watermark !== false) {
        const tokens = readPressure(agent);
        const win = Number(cfg.contextWindow) || 1048576;
        if (tokens > 0) {
          const pct = tokens / win;
          const k = (n) => Math.round(n / 1000) + 'K';
          const head = `【水位】${(pct * 100).toFixed(0)}%（${k(tokens)} / ${k(win)}）`;
          if (pct >= cfg.watermarkEmergencyPct) {
            lines.push(`${head} ★★★ 红灯（≥${(cfg.watermarkEmergencyPct * 100).toFixed(0)}%）—— ` +
              `兜底压缩在 88% 会自己动手、不问你。现在就该：把该落盘的落盘，然后 /compact。`);
          } else if (pct >= cfg.watermarkAlertPct) {
            lines.push(`${head} ★★ 该压了（≥${(cfg.watermarkAlertPct * 100).toFixed(0)}%）—— ` +
              `先落盘再压缩，顺序不能反：压缩会吃掉这一段里的细节，而落盘能把它们捡回来。`);
          } else if (pct >= cfg.watermarkWarnPct) {
            lines.push(`${head} ⚠ 可以开始考虑整理（≥${(cfg.watermarkWarnPct * 100).toFixed(0)}%）—— ` +
              `还不用急，但别等到红灯才动手。`);
          }
        }
      }

      return lines.join('\n');
    } catch (e) {
      // ① 绝不抛
      return '【此刻】' + stamp(new Date()) + '（自我层注入失败：' + String((e && e.message) || e).slice(0, 120) + '）';
    }
  }

  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.context({
      name: 'agent:self',
      order: cfg.order,
      text: render,
    });
    // ★ 门牌条款：**不受 includeSubagents 限制** —— 子会话一样会压缩，也一样需要这条。
    //   它是常量、不读盘、没有状态，所以直接给字符串即可。
    if (cfg.doorSign !== false) {
      scope.systemPrompt.context({
        name: 'agent:door-sign',
        order: cfg.doorSignOrder,
        text: DOOR_SIGN,
      });
    }
  });
}

export default { name, apply };
