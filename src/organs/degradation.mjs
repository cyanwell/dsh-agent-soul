// 思考退化检测 —— 从宿主每轮上报的状态里，看它是不是在变傻
//
// ★★ 为什么这件事要由「外面」来做：
//   上下文被污染（塞满无关材料／反复绕圈／输出预算烧光）之后，退化的是**判断本身**，
//   而判断又是在同一段被污染的上下文里做出来的 —— **宿主看不见自己**。
//   v4 在外面，只看数字：水位、回合、产出量。它不认识模型，也不读思考内容；
//   但它能看见「付出在涨、交付为零」这种形状。
//
// ★★ 为什么给「证据清单」而不是一个漂亮的总分：
//   一个 0..1 的分数看起来科学，实际权重全是拍的 —— **它没法被核对**。
//   所以这里每一项证据单独计分、单独进 reasons[]，总分只是它们的和：
//   **sum(reasons[].weight) === score**（自检里有一条断言专门锁这个不变量）。
//   要反驳这个判断，指着 reasons 里那一条说「它不对」就行。
//
// ★★★ 判据（每条后面是为什么）
//
//   ① 上下文占比 = contextTokens / contextWindow
//      为什么：上下文越长，注意力被无关材料稀释得越厉害；而每轮成本还与它成正比。
//      但 —— **它不是退化，它是退化的条件**。所以它单独最多只到 watch，
//      并且永远不会单独建议「中断」（那是症状才配的档位）。
//      ★ 一条修过的 bug 教会的事：**尺子只能有一把**（2026-11-07，/api/organs 那个
//      「字节 ÷ token」的人格占比）。所以档位直接 import 自 organs/context.mjs 的
//      WATERMARK（0.45 / 0.60 / 0.80），绝不在这里另写一套数 ——
//      两个面板报不同的水位，人就会开始不信任何一个。
//
//   ② outputTokens === 0（烧光）
//      为什么权重最高：它是**确定性**的，不是概率推断 —— 这一轮没有可见产出，
//      没有解释空间。它的因有两种（思考占满预算／被熔断截断），
//      但对「这一轮白烧了」这个结论，两种因指向同一个答案。
//      ★ 但它单独只到 watch（+2）：因为**我们不知道宿主怎么定义 outputTokens**。
//      若它统计的是「最终正文」而不含工具调用，那么一个正常的纯工具轮也会是 0。
//      所以：单次 = 记下来；连续 3 次 = 才和换气的阈值（默认 3）对齐。
//
//   ③ 连续低产出（0 < outputTokens ≤ 24）
//      为什么看「连续」而不是单点：**单点低可能是任务性质**（他问一句「好」，
//      回一句「好」就够了）。连续低排除了任务性质这个解释 ——
//      一段连续的工作流不可能连续多轮都只需要一句话。连续性把「这一次」变成「这一段」。
//      ★ 阈值 24 是**拍的**，不是量出来的（没有真实宿主的产出分布可标定）。
//      正因为是拍的，干预线放到连续 4 轮，让误报被连续性摊薄。
//
//   ④ 同轮膨胀（turnId 没变、上下文在涨、累计产出仍是 0）
//      为什么这条最有价值：它是**守恒关系**，不是统计。
//      上下文只会因为「往里塞东西」而增长（读文件、跑工具、重试）；
//      产出为 0 ⇒ 付出在积累、交付没跟上。这就是「绕圈」最直白的形状，
//      而且它只用两个数字之差，不需要读任何文本。
//      ★ 只用「累计产出是否为 0」，不用它的大小 —— 因为 outputTokens 是
//      「每次调用」还是「整轮累计」我们不知道，但**0 在两种口径下含义相同**。
//
// ★★ 局限（写在这里，不只写在报告里 —— 报告会丢，注释不会）
//   · 我们只有三个数字。**读不到 reasoning，也读不到正文。**
//     所以它判得出「这一段没产出」，判不出「它在想什么、错在哪」。
//   · outputTokens 的语义未在协议里约定（是否含工具调用、是否累计）。
//   · turnId 的格式未约定 —— 所以**绝不解析它里面的序号**，只比较「变没变」。
//     把宿主的内部约定当协议，改一次就全错。
//   · 阈值（24 / 8000 / 连续 4 轮）都是拍的，能配，且应当被真实数据重新标定。
//   · **看不见的东西不要猜**：窗口缺失时 pressure.pct = null（不是 0，也不是 1）；
//     产出字段缺失时不动任何计数 —— 拿「不知道」去充数，
//     会让判断从「可疑」变成「骗人」。
//
// ★★ 它**只判断，不执行**（爀曦 2026-11-07 定，lead 转达）：
//   给人看的文本（observation）**只描述观察到什么**，不写「建议压缩」「建议中断」——
//   那会把「判断」说成「命令」，读的人会以为系统已经打算动手了。
//   机器可读的候选动作单独放在 action 里（枚举），由后续策略层决定要不要用；
//   本器官不调用 hub.exec，也不做任何副作用。
//
// ★ 2026-11-07：首版。lead 指出「不该挂在 control 底下」—— hub 认识
//   「谁连上来了、谁会什么」，器官认识「这意味着什么」。所以它是 createServer
//   的第七个平级参数，和 autonomy / ledger / persona 一样。

// ★ 2026-11-09 补两处（本轮自检发现，都是「说了不该说的话」同一类）：
//   A. **产出未知 ≠ 产出正常**。原来只有「两个信号都空」才判 blind；
//      当 outputTokens 空、水位有值时，observation 会吐「输出正常 · 上下文 30%」——
//      那正是本文件第 135 行反复警告的「拿不知道充数」。现在单列一档：产出未知。
//   B. **候选动作不许越过档位**。原来 `zeroStreak>=3` 是写死的硬编码，
//      于是把 interveneAt 调到 8 之后，4 分（watch）照样给 break —— 面板说「观察」，
//      动作说「中断」，两句话打架。现在 break 先要求 tier===intervene，阈值也纳入配置。

import { WATERMARK } from './context.mjs';

/** 水位三档 —— 不做第二把尺子，直接用 context 器官那一把 */
export const PRESSURE = WATERMARK;

/** 三档结论 */
export const TIER = { OK: 'ok', WATCH: 'watch', INTERVENE: 'intervene' };

/** 证据品类（面板和日志都按这个说话） */
export const EVIDENCE = {
  BURNED: 'burned',        // 这一轮输出为 0
  LOW_STREAK: 'low-streak', // 连续几轮产出都低
  INFLATING: 'inflating',  // 同一轮里上下文在涨、产出为 0
  PRESSURE: 'pressure',    // 水位高（条件，不是症状）
};

/** 候选动作 —— **机器可读，本器官不执行**，也不写进人看的文本 */
export const ACTION = { NONE: 'none', LOOK: 'look', COMPACT: 'compact', BREAK: 'break' };

/** 默认阈值。★ 全部可被 config.organs.degradation 覆盖 */
export const DEFAULT = {
  lowOutputTokens: 24,     // 拍的：一句中文回答约 10–20 token，一次真推进远超 100
  sameTurnGrowthMin: 8000, // 拍的：一份像样的材料/一次工具结果的量级
  watchAt: 2,
  interveneAt: 4,
  breakZeroStreak: 3,      // 连续几轮 0 输出才配给 break（原写死 3，纳入配置）
  historyMax: 32,
};

/** 数字归一化。**返回 null = 不知道**，绝不返回 0 冒充 */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 非负数字；负数当不知道（协议里没定义负数，出现就是有问题） */
function nonNeg(v) {
  const n = num(v);
  return n === null || n < 0 ? null : n;
}

/** 分数 → 档位 */
export function tierOf(score, thresholds) {
  const t = thresholds || {};
  const interveneAt = Number.isFinite(t.interveneAt) ? t.interveneAt : DEFAULT.interveneAt;
  const watchAt = Number.isFinite(t.watchAt) ? t.watchAt : DEFAULT.watchAt;
  if (score >= interveneAt) return TIER.INTERVENE;
  if (score >= watchAt) return TIER.WATCH;
  return TIER.OK;
}

/** 候选动作：先看症状，再看水位 —— 水位只给到 COMPACT 档，不配给 BREAK */
function decideAction(x) {
  // ★ break 是「建议中断」，它的门槛必须 >= 档位门槛：
  //   否则把 interveneAt 调高（意思是「别轻易报干预」）之后，动作反而更激进。
  const breakAt = Number.isFinite(x.breakZeroStreak) ? x.breakZeroStreak : DEFAULT.breakZeroStreak;
  if (x.tier === TIER.INTERVENE && (x.inflating || x.zeroStreak >= breakAt)) return ACTION.BREAK;
  if (x.pressurePct !== null && x.pressurePct >= PRESSURE.alert) return ACTION.COMPACT;
  if (x.tier !== TIER.OK) return ACTION.LOOK;
  return ACTION.NONE;
}

/**
 * 人看的一句话：**只写观察到什么，不写该怎么办**。
 * ★ 带数字 —— 人只信能核对的句子，不信一个形容词。
 */
function observationText(x) {
  const pct = x.pressurePct === null ? '水位未知' : '上下文 ' + (x.pressurePct * 100).toFixed(1) + '%';
  // ★★ 「读不到」不许说成「正常」。
  //   真桥（dsh-agent-soul-bridge）现在 outputTokens 恒为 null、水位也可能拿不到 —
  //   两个都空时，我们其实**什么都没观测到**。这时说一句「输出正常」就是骗人：
  //   它会让面板显示一片 ok，而 ok 会被读成「它很健康」。
  if (x.blind) return '这一轮什么都读不到（outputTokens 与上下文都是空值）—— 这不是健康，是没有数据';
  // ★★ 2026-11-09：**产出未知 ≠ 产出正常**。
  //   只挡住了「两个都空」，漏了「水位有、产出空」——那时原来会吐「输出正常」：
  //   一个宿主没报 outputTokens，面板却在说它健康。这和本文件的判据 ② 是同一个谎。
  if (!x.outputKnown) return '产出未知（这一轮没读到 outputTokens）—— 不是「没有产出」，是没数据 · ' + pct;
  if (x.inflating) {
    return '同一轮里上下文长了 ' + x.growth + ' tokens（本轮已上报 ' + x.sameTurnSeen + ' 次），该轮累计输出 0 · ' + pct;
  }
  if (x.zeroStreak >= 1) return '连续 ' + x.zeroStreak + ' 轮输出为 0 · ' + pct;
  if (x.lowStreak >= 1) return '连续 ' + x.lowStreak + ' 轮输出 ≤ ' + x.lowOutputTokens + ' tokens（本轮 ' + x.outputTokens + '）· ' + pct;
  if (x.tier !== TIER.OK) return '没有产出症状，' + pct + ' 偏高';
  return '输出正常 · ' + pct;
}

/**
 * 一台宿主一个检测器。**纯函数式的**：喂 state，吐判断，不读时钟也不读文件
 * （时钟可注入，自检里才能复现）。
 */
export class DegradationDetector {
  constructor(opts) {
    const o = opts || {};
    this.lowOutputTokens = Number.isFinite(o.lowOutputTokens) ? o.lowOutputTokens : DEFAULT.lowOutputTokens;
    this.sameTurnGrowthMin = Number.isFinite(o.sameTurnGrowthMin) ? o.sameTurnGrowthMin : DEFAULT.sameTurnGrowthMin;
    this.watchAt = Number.isFinite(o.watchAt) ? o.watchAt : DEFAULT.watchAt;
    this.interveneAt = Number.isFinite(o.interveneAt) ? o.interveneAt : DEFAULT.interveneAt;
    this.breakZeroStreak = Number.isFinite(o.breakZeroStreak) ? o.breakZeroStreak : DEFAULT.breakZeroStreak;
    this.historyMax = Number.isFinite(o.historyMax) ? o.historyMax : DEFAULT.historyMax;
    this.now = o.now || (() => Date.now());

    // —— 计数状态 ——
    this.turnKey = '';
    this.zeroStreak = 0;        // 连续几轮 outputTokens === 0
    this.lowStreak = 0;         // 连续几轮 0 < outputTokens ≤ 阈值
    this.sameTurnSeen = 0;      // 这一轮被上报了几次
    this.sameTurnGrowth = 0;    // 这一轮里上下文净增长（被压缩过就重新计）
    this.sameTurnOutput = 0;    // 这一轮累计产出
    this.sameTurnOutputKnown = true; // 只要有一次不知道，就不能声称「累计为 0」
    this.lastContext = null;
    this.lastTier = TIER.OK;
    this.observations = 0;
    this.last = null;
    this.history = [];
  }

  /**
   * 观察一次上报。
   * @param hostId 宿主 id（hub 给的）
   * @param hostName 宿主自称的名字（hello 里那个）
   * @param state { contextTokens, contextWindow, turnId, outputTokens, at }
   */
  observe(hostId, hostName, state) {
    const st = state || {};
    const contextTokens = nonNeg(st.contextTokens);
    const contextWindow = nonNeg(st.contextWindow);
    const outputTokens = nonNeg(st.outputTokens);
    const turnId = st.turnId === null || st.turnId === undefined ? '' : String(st.turnId).trim();
    const at = Number.isFinite(st.at) ? st.at : this.now();

    // ① 水位。窗口缺失 → null（不知道），绝不猜。
    let pressurePct = null;
    if (contextTokens !== null && contextWindow !== null && contextWindow > 0) pressurePct = contextTokens / contextWindow;
    const pressureLevel = pressurePct === null ? null
      : pressurePct >= PRESSURE.emergency ? 'emergency'
        : pressurePct >= PRESSURE.alert ? 'alert'
          : pressurePct >= PRESSURE.warn ? 'warn' : 'ok';

    // ② 这条上报算不算「新的一轮」
    //    ★ 没有 turnId 时降级为「每次上报 = 一轮」，这是**已知的降精度**，不是等价处理。
    const turnKey = turnId || ('@' + at);
    const isNewTurn = turnKey !== this.turnKey;
    this.turnKey = turnKey;

    // ③ 同轮累积（膨胀判据用）。负增长 = 被压缩过 ⇒ 从头算，不把旧账算进新账。
    if (isNewTurn) {
      this.sameTurnSeen = 1;
      this.sameTurnGrowth = 0;
      this.sameTurnOutput = 0;
      this.sameTurnOutputKnown = true;
    } else {
      this.sameTurnSeen++;
      if (contextTokens !== null && this.lastContext !== null) {
        const d = contextTokens - this.lastContext;
        if (d > 0) this.sameTurnGrowth += d;
        else if (d < 0) this.sameTurnGrowth = 0;
      }
    }
    if (outputTokens === null) this.sameTurnOutputKnown = false;
    else this.sameTurnOutput += outputTokens;
    if (contextTokens !== null) this.lastContext = contextTokens;

    // ④ 连续计数只按「轮」走 —— 同一轮上报 5 次，不能算成连续 5 轮。
    if (isNewTurn) {
      if (outputTokens === null) { /* 不知道 → 不动任何计数（拿不知道充数就是骗人） */ }
      else if (outputTokens === 0) { this.zeroStreak += 1; this.lowStreak = 0; }
      else if (outputTokens <= this.lowOutputTokens) { this.zeroStreak = 0; this.lowStreak += 1; }
      else { this.zeroStreak = 0; this.lowStreak = 0; }
    }

    // ⑤ 记证据。★ 每一项的 weight 就是它的分，没有第二步加权。
    const reasons = [];
    let score = 0;
    const add = (code, weight, text) => {
      if (!(weight > 0)) return;
      score += weight;
      reasons.push({ code, weight, text });
    };

    if (outputTokens === 0) {
      const w = Math.min(2 + (this.zeroStreak - 1), 4);
      add(EVIDENCE.BURNED, w, 'outputTokens=0' + (this.zeroStreak > 1 ? '（连续 ' + this.zeroStreak + ' 轮）' : '') + '：这一轮没有任何可见产出');
    }
    if (this.lowStreak > 0) {
      const w = Math.min(this.lowStreak, 4);
      add(EVIDENCE.LOW_STREAK, w, 'outputTokens=' + outputTokens + '（连续 ' + this.lowStreak + ' 轮 ≤ ' + this.lowOutputTokens + '）：产出一直不够一次真推进');
    }
    const inflating = this.sameTurnSeen >= 2 && this.sameTurnOutputKnown
      && this.sameTurnOutput === 0 && this.sameTurnGrowth >= this.sameTurnGrowthMin;
    if (inflating) {
      add(EVIDENCE.INFLATING, 2, '同一轮里上下文长了 ' + this.sameTurnGrowth + ' tokens（' + this.sameTurnSeen + ' 次上报），累计产出 0：在往里塞东西，没有交付');
    }
    if (pressurePct !== null && pressurePct >= PRESSURE.alert) {
      const w = pressurePct >= PRESSURE.emergency ? 2 : 1;
      add(EVIDENCE.PRESSURE, w, '上下文 ' + (pressurePct * 100).toFixed(1) + '%（' + contextTokens + ' / ' + contextWindow + '）：水位不是退化，是退化的条件 —— 单独出现只到 watch');
    }

    const tier = tierOf(score, { watchAt: this.watchAt, interveneAt: this.interveneAt });
    const action = decideAction({ tier, zeroStreak: this.zeroStreak, inflating, pressurePct, breakZeroStreak: this.breakZeroStreak });
    // ★ blind = 两个信号都没读到。它不是「健康」，是「没有数据」——
    //   面板必须能把这两种状态分开，否则「一直 ok」会被当成「一直很好」。
    const blind = outputTokens === null && pressurePct === null;
    const outputKnown = outputTokens !== null;
    const observation = observationText({
      blind, outputKnown, tier, inflating, pressurePct, growth: this.sameTurnGrowth, sameTurnSeen: this.sameTurnSeen,
      zeroStreak: this.zeroStreak, lowStreak: this.lowStreak,
      lowOutputTokens: this.lowOutputTokens, outputTokens,
    });

    const result = {
      hostId: String(hostId || 'unknown'),
      host: String(hostName || hostId || 'unknown'),
      at,
      tier,
      score,
      action,
      blind,
      outputKnown,
      observation,
      pressure: { pct: pressurePct, level: pressureLevel, tokens: contextTokens, window: contextWindow },
      turnId: turnId || null,
      observed: { contextTokens, contextWindow, outputTokens },
      counters: { zeroStreak: this.zeroStreak, lowStreak: this.lowStreak, sameTurnSeen: this.sameTurnSeen, sameTurnGrowth: this.sameTurnGrowth },
      reasons,
    };

    this.observations++;
    this.last = result;
    this.history.push({ at, tier, score, action, outputTokens, pressurePct });
    while (this.history.length > this.historyMax) this.history.shift();
    return result;
  }

  /** 给面板用的读数（比 result 多带一点上下文，但不带结算过程） */
  snapshot() {
    if (!this.last) return null;
    return { ...this.last, observations: this.observations, recent: this.history.slice(-8) };
  }
}

/**
 * 多宿主的登记处。
 * ★ 一条规矩来自 hub.broadcast：**一段失败不影响其他** —— 一个宿主的状态解析炸了，
 *   不许把整条控制通道带下去，也不许影响别的宿主。
 */
export class DegradationTracker {
  constructor(opts) {
    this.opts = opts || {};
    this.log = this.opts.log || (() => {});
    this.dets = new Map();
    this.observations = 0;
  }

  observe(hostId, hostName, state) {
    const key = String(hostId || 'unknown');
    let d = this.dets.get(key);
    if (!d) { d = new DegradationDetector(this.opts); this.dets.set(key, d); }
    let r;
    try { r = d.observe(key, hostName, state); }
    catch (e) { this.log('退化判断出错（不影响通道）：' + (e && e.message)); return null; }
    this.observations++;
    // ★ 只在**档位变化**时出声。每轮都喊，喊就不再是信号 —— 那叫噪音。
    if (r.tier !== d.lastTier) {
      d.lastTier = r.tier;
      if (r.tier === TIER.OK) this.log(r.host + ' 退化已解除');
      else this.log(r.host + ' → ' + r.tier + '（' + r.score + ' 分）：' + r.observation);
    }
    return r;
  }

  forget(hostId) { this.dets.delete(String(hostId || 'unknown')); }

  /**
   * ★ 2026-11-09 补：只保留还活着的宿主。
   *   来历：hub.mjs:37-38 在 onclose 里把宿主从 this.hosts 删掉，但**没人通知本器官**，
   *   于是断开的宿主会永远留在 dets 里，worst 可能一直是它 —— 面板挂着一个早已不存在的
   *   『intervene』。按时间自动过期是错的（空闲但活着的宿主该显示「无数据」，不该消失），
   *   所以只能由调用方把「现在谁活着」传进来。
   */
  prune(liveIds) {
    const live = new Set((liveIds || []).map((x) => String(x)));
    let dropped = 0;
    for (const key of Array.from(this.dets.keys())) {
      if (!live.has(key)) { this.dets.delete(key); dropped++; }
    }
    return dropped;
  }

  /** liveIds 可选：传了就顺手剪掉已断开的宿主（不传 = 保持原行为） */
  snapshot(liveIds) {
    if (Array.isArray(liveIds)) this.prune(liveIds);
    const hosts = [];
    let worst = null;
    for (const d of this.dets.values()) {
      const s = d.snapshot();
      if (!s) continue;
      hosts.push(s);
      if (!worst || s.score > worst.score) worst = s;
    }
    const counts = { ok: 0, watch: 0, intervene: 0 };
    for (const h of hosts) if (Object.prototype.hasOwnProperty.call(counts, h.tier)) counts[h.tier] += 1;
    return { hosts, worst, counts, observeCount: this.observations };
  }
}

/**
 * 面板卡（/api/organs 的一张卡）。
 * ★ 放在器官里、不放在 server 里：**这张卡的读数只该由器官定义**，
 *   否则面板和判据会各自漂移（本项目已经为「两把尺子」付过一次代价）。
 * ★ 显示名用「思考退化」而不是「退化」：单看「退化」太抽象，一眼不知道看的是什么。
 */
export function degradationCard(snap, interveneAt) {
  const line = Number.isFinite(interveneAt) ? interveneAt : DEFAULT.interveneAt;
  if (!snap || !snap.worst) {
    return { name: '思考退化', key: 'degradation', value: '—', note: '还没有宿主上报 state', level: 'ok' };
  }
  const w = snap.worst;
  const pct = w.pressure && w.pressure.pct !== null ? (w.pressure.pct * 100).toFixed(1) + '%' : '水位未知';
  return {
    name: '思考退化',
    key: 'degradation',
    // ★ 读不到时给「—」而不是「0 / 4」：0 分会被读成「很健康」，
    //   而实际上我们一个信号都没有 —— 面板上这两种状态必须长得不一样。
    value: w.blind ? '—（无数据）' : (w.outputKnown === false ? '—（产出未知）' : (w.score + ' / ' + line)),
    note: w.tier + ' · ' + w.host + ' · ' + pct + ' · ' + w.observation,
    level: w.tier === TIER.INTERVENE ? 'bad' : w.tier === TIER.WATCH ? 'warn' : 'ok',
  };
}
