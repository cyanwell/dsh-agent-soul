// heartbeat-core.mjs —— 纯函数，无副作用，便于单测
export function decidePhase({ now, state, config, idleMinutes }) {
  const o = config.options;
  if (!config.enabled) return { phase: 'disabled', reason: '总开关关闭' };

  // ★ 2026-11-03 改：原来读 state.lastUserActivityAt（没人写它，永远 null → 永远 unknown）。
  //   现在由调用方传 idleMinutes 进来（scanSessions 算的真值）。没传才退回旧字段。
  let idleMin;
  if (typeof idleMinutes === 'number') {
    idleMin = idleMinutes;
  } else if (state.lastUserActivityAt) {
    idleMin = (now - new Date(state.lastUserActivityAt).getTime()) / 60000;
  } else {
    return { phase: 'unknown', reason: '既没有外部 idle 数、也没有 state.lastUserActivityAt' };
  }

  if (idleMin < o.idleThresholdMinutes) {
    return { phase: 'idle', reason: `用户 ${Math.round(idleMin)} 分钟前还在，静息中` };
  }
  // 今日预算
  const today = new Date(now).toISOString().slice(0, 10);
  const used = state.runsTodayDate === today ? state.runsToday : 0;
  if (used >= o.budget.maxRunsPerDay) {
    return { phase: 'idle', reason: `今日已跑 ${used} 次，预算用尽` };
  }
  // 安静时段（可选）
  if (o.quietHours) {
    const h = new Date(now).getHours();
    const [s, e] = o.quietHours;
    const inQuiet = s < e ? (h >= s && h < e) : (h >= s || h < e);
    if (inQuiet) return { phase: 'idle', reason: `安静时段 ${s}-${e}` };
  }
  return { phase: 'autonomous', reason: `用户已 ${Math.round(idleMin)} 分钟未活动` };
}

export function decideCron({ now, config, lastRunAt }) {
  // 用 schedule.cron 的 hour 位判断「现在该不该跑」
  const o = config.options;
  if (o.schedule.mode !== "cron") return { due: false, reason: "非 cron 模式" };
  const parts = o.schedule.cron.split(" ");
  if (parts.length !== 5) return { due: false, reason: "cron 格式非法" };
  const hours = parts[1].split(",").map(Number).filter(n => Number.isFinite(n));
  if (!hours.length) return { due: false, reason: "cron hour 位解析不了" };

  const nowD = new Date(now);
  const h = nowD.getHours();

  // ★ 2026-11-03 补实现 catchUpMissed（参数 4）
  //   false（默认）：只看「当前这个点」——错过就是错过（爀曦的定论：关机就当睡觉）
  //   true        ：回看「今天所有还没跑的点」，只要有一个漏了且现在已过它，就补跑
  if (o.catchUpMissed === true) {
    const todayStart = new Date(nowD); todayStart.setHours(0, 0, 0, 0);
    const lastRun = lastRunAt ? new Date(lastRunAt) : null;
    const lastRunToday = lastRun && lastRun >= todayStart ? lastRun : null;
    // 今天已经过去的触发点（按小时，分钟位暂按 :00 处理）
    const passed = hours.filter(hh => hh <= h).sort((a, b) => a - b);
    for (const hh of passed) {
      const t = new Date(todayStart); t.setHours(hh, 0, 0, 0);
      if (!lastRunToday || lastRunToday < t) {
        return { due: true, reason: `补跑：${hh} 点的触发错过了（catchUpMissed=true）`, catchUp: true, targetHour: hh };
      }
    }
    return { due: false, reason: passed.length === 0
      ? `今天还没到任何触发点（下一个是 ${hours.find(hh => hh > h) ?? "明天"} 点）`
      : "今天的触发点都跑过了" };
  }

  // 默认路径：只看当前小时
  if (!hours.includes(h)) return { due: false, reason: `当前 ${h} 点不在 ${parts[1]}` };
  if (lastRunAt) {
    const sameHour = new Date(lastRunAt).getHours() === h &&
                     new Date(lastRunAt).toDateString() === new Date(now).toDateString();
    if (sameHour) return { due: false, reason: "这一小时已经跑过" };
  }
  return { due: true, reason: `${h} 点，到点` };
}
