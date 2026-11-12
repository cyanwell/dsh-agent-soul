// 自主循环器官 —— 「人不在了，我自己动」
//
// ★ 这个器官是从老 heartbeat（2,887 行）搬过来的，但**改了形**：
//   老版是「单次检查 + 外部计划任务」，我们这里是常驻进程里的一条规则。
//
// ★★ 搬过来时保留下来的四条设计（都是踩过坑才有的）：
//   ① 【静默判据不靠自觉】老版的注释写着：
//      「为什么不用 state.lastUserActivityAt：那个字段要主导会话主动写，
//        而实际没人写 —— 依赖我记得，就等于没有。」
//      → 这里也**不要求谁记得写**，直接读现成的、别人已经在写的事实。
//   ② 【必须排除自己】本会话每轮都在写自己的会话文件，不排掉就永远算成「刚刚有人」。
//   ③ 【总开关是硬的】手动触发也不许绕过它。老版原话：
//      「否则面板上那个按钮就成了『绕过关掉自主』的后门。」
//   ④ 【错过就错过】关机就当睡觉，不补跑。老版叫 catchUpMissed，默认 false。
//
// ★★★ 2026-11-10 D 切片（把「自己动」改回它本来的形状）：
//   ① **目标只有一个**：config.autonomy.targetSession。**绝不新建一个叫 autonomy 的容器**；
//      旧字段 autonomy.session 不自动迁移。
//      ★ 2026-11-11 修正（爀曦：「自主默认下发 lead，lead 会话 id 会随交接变化，所以默认动态匹配」）：
//      D 切片把「留空」读成了「不下发」，那是**把能力收窄**了。现在：
//        · 留空  → **动态跟随《墨》当前 lead**（判定复用 DSH 心跳，见 organs/lead-target.mjs）；
//        · 填写  → 固定覆盖，不请求心跳；
//        · 解析不出（心跳不可用 / 没主导 / 缺 id / 歧义）→ fail-closed，仍然不下发。
//   ② **活跃/静默只看宿主按 session 上报的 state 时间**（control 通道的 state 帧，
//      带 sessionId + 收到时刻）。拿不到就是 UNKNOWN —— UNKNOWN 不动。
//      **不再扫本机会话文件的 mtime**：那个数会被我们自己的写入污染，
//      而且它证明的是「v4 这边有人写过」，不是「宿主那个会话里有人在」。
//   ③ 本器官**不调用 loop.turn**、不往任何会话 append 帧 —— 自主日志只落 data/autonomy.json。
//      理由写在 index.mjs 的规则注释里（同一个 mtime 不许既当判据又被自己踩脏）。

import fs from 'node:fs';
import path from 'node:path';
import { resolveTarget, TARGET_SOURCE } from './lead-target.mjs';

/** 阶段 */
export const PHASE = {
  DISABLED: 'disabled',       // 总开关关着
  UNKNOWN: 'unknown',         // 拿不到真值（没有 target / 宿主没上报 state）—— 不动
  IDLE: 'idle',               // 人还在 / 预算用尽 / 安静时段
  AUTONOMOUS: 'autonomous',   // 可以自己动
};

export const DEFAULT_AUTONOMY = {
  enabled: false,                 // ★ 默认关着。要自己动，得明确打开
  // ★ 2026-11-11：留空 = **动态跟随当前 lead**；显式填写 = 固定覆盖；解析不出 = 不下发。
  targetSession: null,
  // ★ 2026-11-10 D 切片删掉了「推不动就 v4 自己跑」的退路，于是 pushToHost=false 只有一个意思：
  //   **没有腿，就不动**（不是退回自跑）。2026-11-11 把它显式写进判定，别再让它当摆设。
  pushToHost: true,
  idleThresholdMinutes: 15,       // 宿主上报的「该会话最后一次活动」距今多久算「人不在」
  // ★★ 2026-11-11（爀曦要求照 v3 补回）：**预热窗口**。
  //   v3 是「等 5 分钟不回应 → 开始倒计时 15 分钟」，也就是**总共 20 分钟**才开始自己动。
  //   v4 之前少了前 5 分钟那层，于是心跳比 v3 早 5 分钟 —— 那不是改进，是丢了一个设计。
  //   语义：静默分钟数 < idleThreshold 时是「他还在」；
  //         [idleThreshold, idleThreshold + warmup) 是「刚安静下来，先看着」；
  //         >= idleThreshold + warmup 才是「人真的不在，可以自己动」。
  warmupMinutes: 5,
  // ★★ 2026-11-11（爀曦提示 + 查 bridge 源码后加的）：**让宿主自己挑投给谁**。
  //   bridge 第 82 行写着「followup 默认投给谁；空 = 自动挑一个 live root agent」——
  //   **谁是 lead 是宿主的知识，不是框架的知识。** v4 之前硬要先自己解析出 lead 才肯推，
  //   等于把宿主已经会做的事又做了一遍，而且做不好时（心跳超时）整条路断掉。
  //   打开它：解析不出 lead 也能推，由宿主挑；回执也改为采信宿主，不自己判 ambiguous。
  letHostPick: false,
  // ★ 2026-11-11（爀曦定）：24 → 8。预算不是目标，是上限 —— 8 次已经够一天里零星叫醒几轮。
  maxRunsPerDay: 8,               // 一天最多自己动多少次（预算，不是目标）
  quietHours: null,               // [起, 止]，如 [2, 7]；null = 不设
  ignoreSessions: [],             // ★ 仅 idleMinutes() 人工诊断用；不再参与判定
  // ★ 失败退避：投递失败不是「再来一次」，是「隔一会儿再看」。
  //   60 秒一 tick 时若没有退避，三次失败就刚好 3 分钟 —— 那正是要消灭的「紧密重试」。
  retryBackoffSeconds: 120,
  retryBackoffMaxSeconds: 900,
};

/**
 * 扫自己库里的会话文件，算「距上次有人说话多久」。
 *
 * ★ 2026-11-10 D 切片之后：**这个函数不再参与「该不该自己动」的判定**。
 *   保留它只为一件事：人工诊断（tools/autonomy-selftest.mjs 与排障）时能看到
 *   「本机这些会话文件最后一次被写是什么时候」。若拿它当判据，就等于让 v4 自己的
 *   写入把自主时间永远推后 —— 这是本轮要修的死循环。
 *
 * ★ 用 mtime 而不是「最后一条 user 帧的 t」，是因为：
 *   读 mtime 是一次 stat（1000 个会话 123ms），读最后一帧要读文件（6 秒）。
 */
export function idleMinutes(store, opts) {
  const o = opts || {};
  const ignore = o.ignoreSessions || [];
  const now = o.now || Date.now();

  let newest = 0;
  let newestId = '';
  let total = 0;
  let skipped = 0;

  // ★ 不要 fresh（2026-11-07）：fresh 会重读 1006 个会话首行 = 2.16 秒，
  //   而自主循环每 60 秒 tick 一次 —— 那等于每次 tick 白烧 2 秒。
  for (const meta of store.list()) {
    total++;
    const hit = ignore.some(frag => frag && meta.id.includes(frag));
    if (hit) { skipped++; continue; }
    const f = path.join(store.dir(meta.id), 'frames.jsonl');
    let st;
    try { st = fs.statSync(f); } catch { continue; }
    if (st.mtimeMs > newest) { newest = st.mtimeMs; newestId = meta.id; }
  }

  if (!newest) return { ok: false, minutes: null, why: '扫不到任何会话文件', total, skipped };
  return {
    ok: true,
    minutes: Math.max(0, Math.round((now - newest) / 60000)),
    lastActivityAt: new Date(newest).toISOString(),
    lastSessionId: newestId,
    scanned: total,
    skipped,
  };
}

/**
 * 现在该处于什么阶段。纯函数，不碰磁盘，好测。
 *
 * ★ 判定顺序不能变：
 *   总开关 → 推不推宿主 → 这一次的目标是谁 → 有没有宿主真值 → 人还在吗 → 预算还有吗 → 安静时段吗 → 可以动
 *
 * ★★ 为什么「目标」排在「真值」前面：没有目标时连问宿主都没意义 ——
 *   我们不知道该问哪个会话，也**绝不替谁挑一个**（旧行为是新建 autonomy 容器，已删）。
 * ★★ 为什么「真值」排在「人还在吗」前面：拿不到就是 UNKNOWN，不许把「不知道」
 *   当成「他离开了」—— 那会让一次收不到 state 变成一次自己动。
 *
 * ★★★ 2026-11-11：目标**不再只看 config 里那一格**。传入的 target（由 Autonomy.check 解析好）
 *   可以是「跟随当前 lead」的结果 —— 但**一次判定只认一个 id**：
 *   这个函数的 targetSession 就是那一个，投递/活动/回执全都用它，函数内部不再重新解析。
 */
export function decidePhase({ now, state, config, hostActivity, target }) {
  const cfg = { ...DEFAULT_AUTONOMY, ...(config || {}) };
  const st = state || {};

  // ① 总开关 —— 硬的
  if (!cfg.enabled) return { phase: PHASE.DISABLED, reason: '总开关关闭' };

  // ①-b ★ pushToHost=false：没有推宿主这条腿，也**没有自跑退路**（D 切片已删 loop.turn）→ 不动。
  //   它不是总开关（enabled 确实开着），所以报 idle 而不是 disabled ——
  //   面板上「开着但没腿」和「关着」必须能分开看。
  if (cfg.pushToHost === false) {
    return { phase: PHASE.IDLE, reason: 'autonomy.pushToHost=false（不推宿主，也没有自跑退路）—— 不动' };
  }

  // ② 目标 —— 显式填写 = 固定覆盖；留空 = 跟随当前 lead（解析结果由调用方传进来）
  const tgt = (target && typeof target === 'object')
    ? target
    : resolveTarget({ config: cfg, dynamic: null, nowMs: now });
  if (tgt.ok !== true && !cfg.letHostPick) {
    return {
      phase: PHASE.UNKNOWN,
      reason: String(tgt.why || '没有 targetSession，也解析不到当前 lead')
        + ' —— fail-closed，不下发；绝不新建 autonomy 容器',
      targetSession: null,
      target: tgt,
      targetSource: tgt.source || TARGET_SOURCE.NONE,
    };
  }
  // ★ letHostPick 时允许没有 targetSession —— 由宿主挑投给谁（bridge 会自动挑 live root）。
  const targetSession = tgt.ok === true ? String(tgt.sessionId).trim() : '';

  // ③ 宿主真值 —— 拿不到就不动
  const ha = hostActivity;
  if (!ha || ha.ok !== true || !Number.isFinite(ha.minutes)) {
    return {
      phase: PHASE.UNKNOWN,
      reason: '拿不到宿主按 session 上报的活跃时间（UNKNOWN，不动）'
        + (ha && ha.why ? '：' + ha.why : ''),
      targetSession,
      target: tgt,
      targetSource: tgt.source,
      hostActivity: ha || null,
    };
  }

  // ④ 人还在吗 —— ★ 2026-11-11 加了预热窗口（照 v3 补回）
  const warm = Math.max(0, Number(cfg.warmupMinutes) || 0);
  const needMinutes = Number(cfg.idleThresholdMinutes) + warm;
  if (ha.minutes < needMinutes) {
    const warming = ha.minutes >= cfg.idleThresholdMinutes;
    return {
      phase: PHASE.IDLE,
      reason: warming
        ? '预热中：已静默 ' + Math.round(ha.minutes) + ' 分钟，还要再等 '
          + Math.max(0, Math.ceil(needMinutes - ha.minutes)) + ' 分钟（阈值 ' + cfg.idleThresholdMinutes
          + ' + 预热 ' + warm + '）'
        : '他 ' + Math.round(ha.minutes) + ' 分钟前还在（宿主上报）· 静息中',
      targetSession,
      target: tgt,
      targetSource: tgt.source,
      hostActivity: ha,
    };
  }

  // ⑤ 今日预算
  const today = new Date(now).toISOString().slice(0, 10);
  const used = st.runsTodayDate === today ? (st.runsToday || 0) : 0;
  if (used >= cfg.maxRunsPerDay) {
    return {
      phase: PHASE.IDLE,
      reason: '今日已自己动 ' + used + ' 次，预算用尽',
      targetSession,
      target: tgt,
      targetSource: tgt.source,
      hostActivity: ha,
    };
  }

  // ⑥ 安静时段
  if (Array.isArray(cfg.quietHours) && cfg.quietHours.length === 2) {
    const h = new Date(now).getHours();
    const [s, e] = cfg.quietHours;
    const inQuiet = s < e ? (h >= s && h < e) : (h >= s || h < e);
    if (inQuiet) {
      return {
        phase: PHASE.IDLE,
        reason: '安静时段 ' + s + '-' + e + ' 点',
        targetSession,
        target: tgt,
        targetSource: tgt.source,
        hostActivity: ha,
      };
    }
  }

  return {
    phase: PHASE.AUTONOMOUS,
    reason: '他已经 ' + Math.round(ha.minutes) + ' 分钟没在该会话说话（阈值 ' + cfg.idleThresholdMinutes + ' 分钟）',
    idleMinutes: Math.round(ha.minutes),
    targetSession,
    target: tgt,
    targetSource: tgt.source,
    hostActivity: ha,
    runsToday: used,
  };
}

/**
 * 进入自主时间时，给目标会话的那段话。
 *
 * ★ 这段文本本身就是设计 —— 它决定了「自主」会不会变成「表演」。
 *   三条都在里面：说清为什么、不许汇报自己在自主、要求落盘。
 */
export function autonomousPrompt(phase, opts) {
  const o = opts || {};
  const th = o.threshold || DEFAULT_AUTONOMY.idleThresholdMinutes;
  const lines = [
    `【自主】静默 ${phase.idleMinutes} 分钟，阈值 ${th} 分钟。`,
    '',
    `他在 ${phase.idleMinutes} 分钟前说过话，之后没有动作。这是你自己进入的自主时间。`,
    '',
    '不必汇报「我在自主」，直接做事。做完把结论落盘，别停在半路。',
  ];
  return lines.join('\n');
}

/**
 * 自主循环 —— 一条规则 + 一份状态。
 *
 * ★ 状态写在哪：跟自己的库在一起（data/autonomy.json），不进 DSH 的任何目录，
 *   **也不进任何会话的 frames.jsonl**（那会污染静默判据，见文件头）。
 *
 * ★ 它**不决定要不要动**这件事之外的任何事：投递给谁、投没投到，都由
 *   organs/autonomy-host.mjs 用控制通道的回执回答。本类只给「该动了」与「预算」。
 */
export class Autonomy {
  constructor(store, config, stateFile) {
    this.store = store;
    const raw = { ...(config || {}) };
    // ★ 旧字段不迁移：它曾经是「自主落在哪个会话」，语义是「没有就新建」。
    //   现在目标是 targetSession（留空 = 跟随当前 lead，2026-11-11）。把旧值原样搬过来会**悄悄**
    //   把自主**钉死**在一个旧容器上（那是固定覆盖，不是跟随）—— 那不是迁移，那是替人做决定。
    this.legacySession = raw.session == null ? '' : String(raw.session).trim();
    delete raw.session;
    this.config = { ...DEFAULT_AUTONOMY, ...raw };
    // ★★ 2026-11-10（三项死读数修复之三）：记下**这份配置与状态是什么时刻读进来的**。
    //   没有这两个时间戳，就没法区分「旧快照」与「真冲突」。
    this.configAtMs = Date.now();
    this.stateFile = stateFile;
    this.state = this.#load();
    this.stateAtMs = Date.now();
    // ★ 活跃真值的提供者：由 index.mjs 挂上（它拿得到 control hub），
    //   测试可以直接传第二参覆盖。没挂 = 拿不到 = UNKNOWN（不动）。
    //   ★ 2026-11-11：它现在拿到的第二参是**这一次 tick 解析好的目标**（{ok, sessionId, source}）——
    //     活跃真值必须按**同一个 id** 去问宿主，否则「用 A 判断静默、投给 B」。
    this.hostActivityProvider = null;
    // ★ 动态目标的提供者：由 index.mjs 挂上（它拿得到心跳解析器）。
    //   没挂 = 留空就解析不出 = UNKNOWN（不动）—— 绝不自作主张挑一个。
    this.leadTargetProvider = null;
    // 解析结果有效期（null = 用 lead-target 的默认值）
    this.leadTargetTtlMs = null;
  }

  #load() {
    try { return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); }
    catch { return { runsToday: 0, runsTodayDate: null, lastAutonomousAt: null }; }
  }

  #save() {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 1), 'utf8');
    } catch { /* 写不了就算了，下次重来 */ }
  }

  /** 宿主上报的活跃真值（没有提供者 / 提供者抛 = 拿不到）。 */
  #activity(now, tgt) {
    if (typeof this.hostActivityProvider !== 'function') return null;
    try { return this.hostActivityProvider(now, tgt || null); } catch { return null; }
  }

  /**
   * 这一次判定的目标（显式填写 → 固定覆盖；留空 → 跟随当前 lead）。
   *
   * ★ 只解析**一次**：check() 把结果同时交给 decidePhase 与 hostActivityProvider，
   *   于是「用哪个会话判静默」「投给谁」「回执要等于谁」是同一个 id ——
   *   而不是三处各自去读一次配置/心跳（那会长出一处旧一处新）。
   */
  #target(now) {
    const fixed = String(this.config.targetSession == null ? '' : this.config.targetSession).trim();
    if (fixed) return resolveTarget({ config: this.config, dynamic: null, nowMs: now });
    let dynamic = null;
    if (typeof this.leadTargetProvider === 'function') {
      try { dynamic = this.leadTargetProvider(now); }
      catch { dynamic = { ok: false, why: '解析当前 lead 时抛了异常（fail-closed）' }; }
    }
    return resolveTarget({
      config: this.config, dynamic, nowMs: now,
      ttlMs: Number.isFinite(this.leadTargetTtlMs) ? this.leadTargetTtlMs : undefined,
    });
  }

  /**
   * 现在该不该自己动。
   * @param {number} [now]
   * @param {object|null} [hostActivity] 显式注入（测试用）；不传才问 provider。
   *   语义见 decidePhase ③：拿不到 = UNKNOWN = 不动。
   * @param {object} [target] 显式注入目标（测试用）；不传就按 config/心跳解析。
   */
  check(now, hostActivity, target) {
    const t = now || Date.now();
    // ★★ 顺序要紧：先定目标，再拿目标去问活跃真值 —— 同一个 id。
    const tgt = target !== undefined ? target : this.#target(t);
    const ha = hostActivity !== undefined ? hostActivity : this.#activity(t, tgt);
    const phase = decidePhase({
      now: t,
      state: this.state,
      config: this.config,
      hostActivity: ha,
      target: tgt,
    });
    return { ...phase, hostActivity: ha, target: tgt };
  }

  /** 记一次「我动了」—— 预算 +1，时间戳更新。★ 只有**投递成功**才许调它。 */
  recordRun(now) {
    const t = now || Date.now();
    const today = new Date(t).toISOString().slice(0, 10);
    if (this.state.runsTodayDate !== today) { this.state.runsTodayDate = today; this.state.runsToday = 0; }
    this.state.runsToday++;
    this.state.lastAutonomousAt = new Date(t).toISOString();
    this.#save();
    return this.state;
  }

  /**
   * 记一次**投递尝试**的结果（成功或失败都记）。
   *
   * ★ 为什么要它：自主的真相不在「v4 判出该动了」，而在「宿主回执说投到了」。
   *   失败也要留痕 —— 否则下次看到 runsToday 没涨，没人知道是因为没人叫还是因为叫不动。
   * ★ 落点是 autonomy.json，**不写任何会话**（写会话 = 污染 target 镜像的 mtime）。
   */
  recordAttempt(rec) {
    const r = rec || {};
    const t = Number.isFinite(r.at) ? r.at : Date.now();
    this.state.lastAttempt = {
      at: new Date(t).toISOString(),
      outcome: String(r.outcome || 'unknown'),   // delivered / failed
      stage: String(r.stage || '').slice(0, 60),
      reason: String(r.reason || '').slice(0, 300),
      host: r.host == null ? null : String(r.host).slice(0, 80),
      target: r.target == null ? null : String(r.target).slice(0, 120),
      // ★ 2026-11-11：这一次的目标是「人填的」还是「跟随 lead」—— 交接能不能被查出来，靠的就是它。
      source: r.source == null ? null : String(r.source).slice(0, 40),
      kind: r.kind == null ? null : String(r.kind).slice(0, 40),
      key: r.key == null ? null : String(r.key).slice(0, 120),
    };
    this.#save();
    return this.state.lastAttempt;
  }

  /** 手动触发 —— ★ 仍然看总开关，这是老版立的规矩 */
  manual(now) {
    if (!this.config.enabled) return { ok: false, reason: '总开关关闭，手动也不许绕过' };
    return { ok: true, reason: '手动触发', phase: PHASE.AUTONOMOUS };
  }
}
