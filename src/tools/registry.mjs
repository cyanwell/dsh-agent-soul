// 工具注册表 + 单调守卫
//
// ★ 守卫契约照抄 DSH 的 ToolGuard（官方类型定义 index.d.ts:489）：
//     type ToolGuard = (exec) => string | undefined
//   返回字符串 = 拒绝（字符串即理由）；返回 undefined = 不表态。
//   **没有 allow 这个返回值** —— 所以多守卫的求值顺序不会把否决翻回允许。

import { withTimeout } from '../util/timeout.mjs';

export class ToolRegistry {
  constructor() {
    this.tools = new Map();      // name -> def
    this.guards = [];            // 单调守卫
    this.log = [];
    // ★ 工具执行的默认时限。
    //   之前这里没有边 —— handler 不返回，整条回合永远不返回，MAX_STEPS 救不了。
    //   300 秒 = 够跑完一个慢工具，又不至于让人干等半小时。
    this.defaultTimeoutMs = 300000;
  }

  /**
   * 注册一个工具
   * def = { name, description, parameters (JSON Schema), handler, scope? }
   */
  register(def) {
    if (!def || !def.name || typeof def.handler !== 'function') {
      throw new Error('工具定义必须含 name 与 handler');
    }
    if (this.tools.has(def.name)) throw new Error('工具重名: ' + def.name);
    this.tools.set(def.name, {
      scope: 'global',
      parameters: { type: 'object', properties: {} },
      ...def,
    });
    return () => this.tools.delete(def.name);
  }

  /**
   * 注册一个单调守卫。
   * ★ 返回 disposer，用于有序清理。
   */
  guard(fn) {
    if (typeof fn !== 'function') throw new Error('guard 必须是函数');
    this.guards.push(fn);
    return () => {
      const i = this.guards.indexOf(fn);
      if (i >= 0) this.guards.splice(i, 1);
    };
  }

  /** 给模型看的工具清单（OpenAI 兼容格式） */
  specs(scope = 'global') {
    const out = [];
    for (const t of this.tools.values()) {
      if (t.scope !== 'global' && t.scope !== scope) continue;
      out.push({
        type: 'function',
        function: { name: t.name, description: t.description || '', parameters: t.parameters },
      });
    }
    return out;
  }

  /**
   * 执行一个工具。
   * ★ 顺序：先跑全部守卫（任一拒绝即停）→ 再跑 handler。
   */
  async execute(name, args, ctx = {}) {
    const def = this.tools.get(name);
    if (!def) return { ok: false, error: '没有这个工具: ' + name };

    const exec = { name, args, at: Date.now(), sessionId: ctx.sessionId || null };

    // 单调守卫：只否决，不放行
    for (const g of this.guards) {
      let reason;
      try { reason = g(exec); }
      catch (e) { return { ok: false, denied: true, reason: '[守卫异常] ' + (e && e.message) }; }
      if (typeof reason === 'string' && reason) {
        return { ok: false, denied: true, reason };
      }
    }

    const tms = def.timeoutMs === undefined ? this.defaultTimeoutMs : def.timeoutMs;
    try {
      const result = await withTimeout(def.handler(args ?? {}, ctx), tms, '工具 ' + name);
      const content = typeof result === 'string' ? result : JSON.stringify(result ?? null);
      this.log.push({ name, at: exec.at, ok: true });
      return { ok: true, content, timeout: false };
    } catch (e) {
      const timedOut = e && e.code === 'TIMEOUT';
      this.log.push({ name, at: exec.at, ok: false, error: String(e && e.message), timeout: timedOut });
      return { ok: false, error: String((e && e.message) || e), timeout: !!timedOut };
    }
  }
}
