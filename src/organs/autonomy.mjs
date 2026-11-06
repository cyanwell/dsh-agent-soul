// 自主循环器官 —— 「人不在了，我自己动」
//
// ★ 这个器官是从老 heartbeat（2,887 行）搬过来的，但**改了形**：
//   老版是「单次检查 + 外部计划任务」，我们这里是常驻进程里的一条规则。
//
// ★★ 搬过来时保留下来的四条设计（都是踩过坑才有的）：
//   ① 【静默判据不靠自觉】老版的注释写着：
//      「为什么不用 state.lastUserActivityAt：那个字段要主导会话主动写，
//        而实际没人写 —— 依赖我记得，就等于没有。」
//      → 所以这里也**不要求谁记得写**，直接读磁盘上的现成事实：会话文件的 mtime。
//   ② 【必须排除自己】本会话每轮都在写自己的会话文件，不排掉就永远算成「刚刚有人」。
//   ③ 【总开关是硬的】手动触发也不许绕过它。老版原话：
//      「否则面板上那个按钮就成了『绕过关掉自主』的后门。」
//   ④ 【错过就错过】关机就当睡觉，不补跑。老版叫 catchUpMissed，默认 false。

import fs from 'node:fs';
import path from 'node:path';

/** 阶段 */
export const PHASE = {
  DISABLED: 'disabled',       // 总开关关着
  UNKNOWN: 'unknown',         // 拿不到静默数（一个会话文件都没扫到）
  IDLE: 'idle',               // 人还在 / 预算用尽 / 安静时段
  AUTONOMOUS: 'autonomous',   // 可以自己动
};

export const DEFAULT_AUTONOMY = {
  enabled: false,                 // ★ 默认关着。要自己动，得明确打开
  idleThresholdMinutes: 15,       // 静默多久算「人不在」
  maxRunsPerDay: 24,              // 一天最多自己动多少次（预算，不是目标）
  quietHours: null,               // [起, 止]，如 [2, 7]；null = 不设
  ignoreSessions: [],             // 排除哪些会话（通常是「我自己」）
};

/**
 * 扫自己库里的会话文件，算「距上次有人说话多久」。
 *
 * ★ 和老版 activity.mjs 的区别：」
 *   老版扫的是 DSH 的 session.v4.jsonl.zstd（要解 zstd，只能看 mtime）；
 *   我们扫自己的 frames.jsonl —— 同样是 mtime，但目录是我们自己的，不怕 DSH 改格式。
 * ★ 用 mtime 而不是「最后一条 user 帧的 t」，是因为：
 *   读 mtime 是一次 stat（1000 个会话 123ms），读最后一帧要读文件（6 秒）。
 *   这里要的是「大概多久以前」，不是精确到哪一句。
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
  //   静默判定的精度是「分钟」，30 秒的列表缓存完全够。
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
 *   总开关 → 有没有静默数 → 人还在吗 → 预算还有吗 → 安静时段吗 → 可以动
 *   把「预算」放在「安静时段」前面，是因为预算用尽时连算安静时段都没意义。
 */
export function decidePhase({ now, state, config, idleMinutes: idleMin }) {
  const cfg = { ...DEFAULT_AUTONOMY, ...(config || {}) };
  const st = state || {};

  // ① 总开关 —— 硬的
  if (!cfg.enabled) return { phase: PHASE.DISABLED, reason: '总开关关闭' };

  // ② 有没有真值
  if (typeof idleMin !== 'number') {
    return { phase: PHASE.UNKNOWN, reason: '拿不到静默时长（没有可用的会话文件）' };
  }

  // ③ 人还在吗
  if (idleMin < cfg.idleThresholdMinutes) {
    return { phase: PHASE.IDLE, reason: `他 ${Math.round(idleMin)} 分钟前还在，静息中` };
  }

  // ④ 今日预算
  const today = new Date(now).toISOString().slice(0, 10);
  const used = st.runsTodayDate === today ? (st.runsToday || 0) : 0;
  if (used >= cfg.maxRunsPerDay) {
    return { phase: PHASE.IDLE, reason: `今日已自己动 ${used} 次，预算用尽` };
  }

  // ⑤ 安静时段
  if (Array.isArray(cfg.quietHours) && cfg.quietHours.length === 2) {
    const h = new Date(now).getHours();
    const [s, e] = cfg.quietHours;
    const inQuiet = s < e ? (h >= s && h < e) : (h >= s || h < e);
    if (inQuiet) return { phase: PHASE.IDLE, reason: `安静时段 ${s}-${e} 点` };
  }

  return {
    phase: PHASE.AUTONOMOUS,
    reason: `他已经 ${Math.round(idleMin)} 分钟没说话（阈值 ${cfg.idleThresholdMinutes} 分钟）`,
    idleMinutes: Math.round(idleMin),
    runsToday: used,
  };
}

/**
 * 进入自主时间时，给主导会话的那段话。
 *
 * ★ 这段文本本身就是设计 —— 它决定了「自主」会不会变成「表演」。
 *   老版的写法（在他自己的会话里出现过）：
 *     「【自主】静默 N 分钟，阈值 M 分钟。这是你自己进入的自主时间。
 *       不必汇报『我在自主』，直接做事。做完把结论落盘，别…」
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
 * ★ 状态写在哪：跟自己的库在一起（data/autonomy.json），不进 DSH 的任何目录。
 *   这是「独立软件」的意思 —— 我的状态文件不该在别人的安装目录里。
 */
export class Autonomy {
  constructor(store, config, stateFile) {
    this.store = store;
    this.config = { ...DEFAULT_AUTONOMY, ...(config || {}) };
    this.stateFile = stateFile;
    this.state = this.#load();
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

  /** 现在该不该自己动 */
  check(now) {
    const idle = idleMinutes(this.store, { ignoreSessions: this.config.ignoreSessions, now });
    const phase = decidePhase({
      now: now || Date.now(),
      state: this.state,
      config: this.config,
      idleMinutes: idle.ok ? idle.minutes : undefined,
    });
    return { ...phase, idle };
  }

  /** 记一次「我动了」—— 预算 +1，时间戳更新 */
  recordRun(now) {
    const t = now || Date.now();
    const today = new Date(t).toISOString().slice(0, 10);
    if (this.state.runsTodayDate !== today) { this.state.runsTodayDate = today; this.state.runsToday = 0; }
    this.state.runsToday++;
    this.state.lastAutonomousAt = new Date(t).toISOString();
    this.#save();
    return this.state;
  }

  /** 手动触发 —— ★ 仍然看总开关，这是老版立的规矩 */
  manual(now) {
    if (!this.config.enabled) return { ok: false, reason: '总开关关闭，手动也不许绕过' };
    return { ok: true, reason: '手动触发', phase: PHASE.AUTONOMOUS };
  }
}