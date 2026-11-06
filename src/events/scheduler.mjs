// 心跳 —— 让 agent-soul 自己动起来
//
// ★ 这一层从 heartbeat / lead-waker 的经验来，只取最必要的三件：
//   ① tick：隔一段时间醒一次
//   ② 条件：醒来时看什么
//   ③ 动作：该动的时候动（发事件，不直接干活）
//
// ★ 一条纪律（学自旧系统的坑）：心跳不是闹钟。
//   它是「每隔 N 秒看一眼」的持续循环，不是「每天 9 点响一次」。
//   所以没有「错过」这个概念 —— 只有「这次看的时候它是什么样」。

export class Scheduler {
  constructor(opts) {
    const o = opts || {};
    this.bus = o.bus;
    this.intervalMs = o.intervalMs || 60000;
    this.rules = o.rules || [];
    this.timer = null;
    this.ticks = 0;
    this.lastTickAt = 0;
    this.lastFired = new Map();
  }

  rule(r) {
    this.rules.push(r);
    return this;
  }

  async tickOnce(ctx) {
    const c = ctx || {};
    this.ticks++;
    this.lastTickAt = Date.now();
    const fired = [];

    for (const r of this.rules) {
      if (r.every) {
        const last = this.lastFired.get(r.name) || 0;
        if (Date.now() - last < r.every) continue;
      }
      let payload = null;
      try { payload = await r.check({ ...c, ticks: this.ticks, now: this.lastTickAt }); }
      catch (e) { payload = null; }
      if (payload) {
        this.lastFired.set(r.name, Date.now());
        fired.push(r.name);
        await this.bus.emit('rule:' + r.name, { ...payload, rule: r.name }, { session: c.session || null });
      }
    }

    await this.bus.emit('tick', { ticks: this.ticks, fired }, { session: c.session || null });
    return { ticks: this.ticks, fired };
  }

  start(ctx) {
    if (this.timer) return;
    const c = ctx || {};
    this.timer = setInterval(() => { this.tickOnce(c).catch(() => {}); }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  stats() { return { ticks: this.ticks, lastTickAt: this.lastTickAt, rules: this.rules.map(r => r.name) }; }
}