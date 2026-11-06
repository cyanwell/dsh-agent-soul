// 事件总线 —— 灵魂层的事件
//
// ★ 与 DSH 那套的区别：
//   旧系统的 ctx.on / ctx.fire 是宿主提供的，事件只在宿主活着的时候存在。
//   新系统的事件是自己的，而且 —— 关键 —— 每一条事件也写进索引。
//
//   为什么：事件是历史。如果事件不进索引，「那天我以为他在忙」这种线索就永远找不回来。

export class EventBus {
  constructor({ store = null, onWrite = null } = {}) {
    this.handlers = [];
    this.history = [];
    this.maxHistory = 500;
    this.store = store;
    this.onWrite = onWrite;
  }

  on(pattern, fn, opts) {
    const once = Boolean(opts && opts.once);
    const h = { pattern, fn, once };
    this.handlers.push(h);
    return () => {
      const i = this.handlers.indexOf(h);
      if (i >= 0) this.handlers.splice(i, 1);
    };
  }

  match(pattern, type) {
    if (pattern === '*') return true;
    if (pattern === type) return true;
    if (pattern.endsWith(':*')) return type.startsWith(pattern.slice(0, -1));
    return false;
  }

  async emit(type, payload, opts) {
    const p = payload || {};
    const o = opts || {};
    const ev = { type, at: Date.now(), payload: p };
    this.history.push(ev);
    if (this.history.length > this.maxHistory) this.history.shift();

    if (o.session && this.store) {
      try {
        const summary = p.summary || JSON.stringify(p).slice(0, 500);
        this.store.append(o.session, 'event', { text: '[' + type + '] ' + summary, eventType: type, at: ev.at });
      } catch (e) { /* 写索引失败不能毁掉事件 */ }
    }
    if (this.onWrite) { try { this.onWrite(ev); } catch (e) {} }

    const dead = [];
    for (const h of this.handlers) {
      if (!this.match(h.pattern, type)) continue;
      try { await h.fn(ev); } catch (e) {}
      if (h.once) dead.push(h);
    }
    for (const d of dead) {
      const i = this.handlers.indexOf(d);
      if (i >= 0) this.handlers.splice(i, 1);
    }
    return ev;
  }

  recent(n) { return this.history.slice(-(n || 20)); }
  stats() { return { handlers: this.handlers.length, history: this.history.length }; }
}