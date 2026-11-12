// 能力注册表 —— v4 认识「能力」，不认识「宿主」
//
// ★ 这是整个解耦的核心数据结构。
//   v4 说「有人会换气吗」，DSH 插件举手，Codex 适配器不举手（它没这个能力）。
//   **v4 的主程序里一次都不该出现 'dsh' 这个词。**
//
// ★ 一个宿主连上来的第一件事是 hello，自报能力和状态：
//   {"type":"hello","host":"dsh","caps":["followup","huanqi","pruner"],
//    "meta":{"contextWindow":1048576,"contextTokens":482000,"turnId":"..."}}
//
// ★ 之后它每轮可以再报 state：
//   {"type":"state","contextTokens":...,"contextWindow":...,"turnId":...,"outputTokens":0}
//   **这就是「检测宿主上下文污染」的数据源** —— v4 拿它来判断思考是否在退化。

let seq = 0;

export class ControlHub {
  constructor(opts) {
    const o = opts || {};
    this.hosts = new Map();      // id → { id, host, caps:Set, meta, conn, at, state }
    this.pending = new Map();    // 指令 id → { resolve, reject, timer }
    this.log = o.log || (() => {});
    this.onState = o.onState || (() => {});   // 宿主上报状态时回调（给换气/思考退化判断用）
  }

  /** 一条连接进来 */
  attach(conn) {
    const id = 'host-' + (++seq) + '-' + Date.now().toString(36);
    // ★ 2026-11-10（概览状态面板）：多记三样**排障时才需要**的东西 —— 这条桥怎么接的、
    //   派过几次活、最近一次为什么失败。它们不改路由行为，只是把「看不见的」记下来。
    const rec = {
      id, host: null, caps: new Set(), meta: null, conn, at: Date.now(), state: null,
      transport: (conn && conn.transport) || 'ws',
      calls: 0, failures: 0, lastError: null, lastErrorAt: null,
    };
    this.hosts.set(id, rec);

    conn.onmessage = (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      this.#onMessage(rec, m);
    };
    conn.onclose = () => {
      this.hosts.delete(id);
      this.log('断开 ' + (rec.host || id));
    };
    this.log('连上 ' + id + '（等 hello）');
    return id;
  }

  /**
   * 关掉所有宿主连接。★ 退出流程专用。
   * ★★ 2026-11-11：`server.close()` 会一直等连接自己断开，而 `closeAllConnections()`
   *   **不关 WebSocket** —— 实证 stages 里没有 closeServer（卡死在那一段），ms 恒等于壳的 5 秒超时。
   *   所以退出时必须显式关：不是「等它们体面断开」，是「告诉它们现在就走」。
   * ★ 返回关掉几条 —— 日志里要能说出这个数，否则「关了」和「一条都没连」长得一样。
   */
  closeAll(reason = 'shutdown') {
    let n = 0;
    for (const [id, rec] of this.hosts) {
      try {
        if (rec && rec.conn && typeof rec.conn.close === 'function') rec.conn.close(1001, String(reason).slice(0, 60));
        n++;
      } catch { /* 已经断了 */ }
      this.hosts.delete(id);
    }
    if (n && this.log) this.log('关闭宿主连接 ' + n + ' 条（' + reason + '）');
    return n;
  }

  #onMessage(rec, m) {
    if (m.type === 'hello') {
      rec.host = String(m.host || 'unknown');
      rec.caps = new Set(Array.isArray(m.caps) ? m.caps.map(String) : []);
      rec.meta = m.meta || {};
      this.log('hello: ' + rec.host + ' 能力=[' + [...rec.caps].join(',') + ']');
      rec.conn.send({ type: 'welcome', id: rec.id, you: rec.host, caps: [...rec.caps] });
      return;
    }
    if (m.type === 'state') {
      rec.state = { ...m, at: Date.now() };
      try { this.onState(rec, rec.state); } catch (e) { this.log('onState 出错: ' + e.message); }
      return;
    }
    if (m.type === 'result') {
      const p = this.pending.get(m.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(m.id);
      if (m.ok) p.resolve(m.data ?? null);
      else {
        // ★★ 2026-11-07 补（bridge-dev 抓出来的）：
        //   `hint` 原来是**到这一行就丢了** —— 宿主回的机器可读原因被 new Error(人话) 吃掉，
        //   v4 程序只能去正则解析那句中文。那正是「数据只存在于注释里」的另一种形态。
        //
        //   ★ 两层分工，别混：
        //     canDo + meta.stubs = **静态**：这台机器这个能力通没通，**事前**就能问。
        //     result.hint        = **动态**：这一次为什么没成，**事后**才能答。
        //   **前者挡不住「昨天还通、今天断了」** —— 所以两个都要。
        const e = new Error(String(m.error || '宿主报错'));
        if (m.hint) e.hint = String(m.hint);
        // ★ 宿主自己报的失败，是「为什么没干成」最可信的一手 —— 记在连接上，面板才看得见。
        rec.failures = (rec.failures || 0) + 1;
        rec.lastError = String(m.error || '宿主报错').slice(0, 260);
        rec.lastErrorAt = new Date().toISOString();
        p.reject(e);
      }
      return;
    }
  }

  /** 谁能做这件事 */
  whoHas(cap) {
    return [...this.hosts.values()].filter((h) => h.caps.has(cap) && h.conn.open);
  }

  /** 把一条指令发给某个宿主，等它的回执（超时就 reject —— 宿主可能卡住了） */
  exec(hostId, cap, action, args, timeoutMs = 15000) {
    const h = this.hosts.get(hostId);
    if (!h || !h.conn.open) return Promise.reject(new Error('宿主不在: ' + hostId));
    if (!h.caps.has(cap)) return Promise.reject(new Error(h.host + ' 没有能力 ' + cap));
    // ★★ 2026-11-07 加：**声明是桩的能力，不要发过去等超时**。
    //
    //   理由（bridge-dev 指出、我认同的那条）：宿主的诚实声明如果只用来拒绝、不用来**提前**拒绝，
    //   那它就还是噪音 —— 区别只是「超时 15 秒后才知道」和「一秒钟就知道」。
    //   ★ 现在起：**桩 = 立刻 reject + 说清是哪一方的问题**，不是「等它超时」。
    const stubs = h.meta && Array.isArray(h.meta.stubs) ? h.meta.stubs : [];
    if (stubs.includes(cap)) {
      const e = new Error(h.host + ' 声明 ' + cap + ' 是桩（能力在、路没通）—— 派活前该问 canDo，不是 whoHas');
      e.hint = 'stub_declared';
      e.host = h.host;
      e.cap = cap;
      h.failures = (h.failures || 0) + 1;
      h.lastError = '桩声明：' + cap + '（没有发过去）';
      h.lastErrorAt = new Date().toISOString();
      return Promise.reject(e);
    }
    const id = 'cmd-' + (++seq);
    h.calls = (h.calls || 0) + 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        h.failures = (h.failures || 0) + 1;
        h.lastError = cap + '/' + action + ' 超时 ' + timeoutMs + 'ms';
        h.lastErrorAt = new Date().toISOString();
        reject(new Error(cap + '/' + action + ' 超时 ' + timeoutMs + 'ms'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      h.conn.send({ type: 'exec', id, cap, action, args: args || {} });
    });
  }

  /**
   * 广播给所有具备该能力的宿主。
   * ★ 返回 [{host, ok, data|error}] —— **不因为一个宿主失败就中断**：
   *   这条规矩是从器官那边学来的（一段失败不影响其他）。
   */
  async broadcast(cap, action, args, timeoutMs) {
    const targets = this.whoHas(cap);
    if (!targets.length) return [];
    return Promise.all(targets.map(async (h) => {
      try { return { host: h.host, ok: true, data: await this.exec(h.id, cap, action, args, timeoutMs) }; }
      catch (e) { return { host: h.host, ok: false, error: e.message }; }
    }));
  }

  /** 快照 —— 给面板和 MCP 工具看 */
  snapshot() {
    return [...this.hosts.values()].map((h) => ({
      id: h.id, host: h.host || '(未 hello)', caps: [...h.caps],
      // ★★ 2026-11-07 补的（bridge-dev 抓出来的 bug）：原来 hello 的 meta 存了却不输出。
      //
      //   后果比看起来严重：桥接插件在 hello.meta.stubs 里声明「huanqi/pruner 是桩」，
      //   而 snapshot 不暴露 meta → **v4 永远看不到这个声明** →
      //   等于「派了活、超时了、才发现对方做不到」。
      //   ★ 诚实声明必须让派活的人看得见，否则那只是自我安慰。
      meta: h.meta || null,
      stubs: Array.isArray(h.meta && h.meta.stubs) ? h.meta.stubs.slice() : [],
      // ★ 2026-11-10：这三样以前只活在注释里（「宿主可能卡住」）—— 现在如实报出来。
      transport: h.transport || 'ws',
      calls: Number.isFinite(h.calls) ? h.calls : 0,
      failures: Number.isFinite(h.failures) ? h.failures : 0,
      lastError: h.lastError || null,
      lastErrorAt: h.lastErrorAt || null,
      connectedAt: new Date(h.at).toISOString(),
      state: h.state ? {
        contextTokens: h.state.contextTokens ?? null,
        contextWindow: h.state.contextWindow ?? null,
        turnId: h.state.turnId ?? null,
        outputTokens: h.state.outputTokens ?? null,
        // ★ 2026-11-10 D 切片：**这条 state 属于哪个会话**、**v4 是何时收到的**。
        //   前者让自主能按 targetSession 过滤（不再拿「所有会话里最新的一条」凑数）；
        //   后者是静默判定的时间基准 —— 用我们的钟，不用宿主自报的 at（两台机器未必同源）。
        sessionId: h.state.sessionId ?? null,
        atMs: h.state.at,
        turn: h.state.turn ?? null,
        step: h.state.step ?? null,
        at: new Date(h.state.at).toISOString(),
      } : null,
    }));
  }

  /**
   * 这个能力**现在真的能干**吗（不只是「声称会」）。
   *
   * ★ 和 whoHas() 的区别，是关键：
   *   whoHas(cap)  = 谁在 hello.caps 里报了这个能力 → **声称**
   *   canDo(cap)   = 报了这个能力、且没在 hello.meta.stubs 里声明它是桩 → **实际能干**
   *
   * ★ 派活前应该问 canDo，不是 whoHas。
   *   问 whoHas 然后超时，等于把「对方的诚实声明」当成了噪音。
   */
  canDo(cap) {
    return [...this.hosts.values()].filter((h) => {
      if (!h.caps.has(cap) || !h.conn.open) return false;
      const stubs = h.meta && Array.isArray(h.meta.stubs) ? h.meta.stubs : [];
      return !stubs.includes(cap);
    });
  }
}
