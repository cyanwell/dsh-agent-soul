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

/** 宿主自报地址的唯一合法形状：本机回环 + 端口。 */
const HOST_ORIGIN_RE = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;

export class ControlHub {
  constructor(opts) {
    const o = opts || {};
    this.hosts = new Map();      // id → { id, host, caps:Set, meta, conn, at, state }
    this.pending = new Map();    // 指令 id → { resolve, reject, timer }
    // ★★★ 2026-11-14（第 14 代）：**反向调用表**（宿主 → v4）。
    //   为什么需要：aurabot 的工具实现活在 v4 进程里，而工具必须挂在 DSH 的 agent 上 ——
    //   函数跨不了进程，所以 DSH 侧挂一个「转发器」，真实现登记在这里。
    //   协议从原来的三型（hello/welcome/exec/result）扩一个 invoke/invoke-result。
    this.invokers = new Map();
    // ★★★ 2026-11-14（第 14 代 · bridge 协议 v2）：**推的方向**（宿主 → v4）。
    //
    //   为什么要有这一段：aurabot 的 `ctx.on('session/event', (session, event) => …)`
    //   在 v4 里**一直没有人调 emit** —— 订阅存在、事件从不发生。于是「她的话回不到 QQ」。
    //   事件源在 DSH 那边（它自己的 `ctx.on('session/event')`），跨进程只能由宿主 push 过来。
    //
    //   ★ 四样状态各有各的用途，别混（混了就会出现「确认了没收到的东西」）：
    //     subs      topic → Set<fn>        本地订阅者（bridge-events 挂在这里）
    //     subSeq    sub   → 已见的最大 seq  ★ 断线重连的 resumeFrom 就从这里取（按订阅分别记）
    //     subOwner  sub   → hostId         ack 必须发回**拥有这个订阅的那条连接**，不是随便一条
    //     ackQueue  sub   → 待确认的最大 seq 500ms 合并，只发最大的（见 ack()）
    this.subs = new Map();
    this.subSeq = new Map();
    this.subOwner = new Map();
    this.ackQueue = new Map();
    this.ackTimer = null;
    this.ackDelayMs = Number.isFinite(o.ackDelayMs) && o.ackDelayMs >= 0 ? o.ackDelayMs : 500;
    // ★ push 的账：面板要能回答「到底推过来了没有」。只写在注释里不算数。
    this.pushStats = { frames: 0, dispatched: 0, noListener: 0, acked: 0, ackFailed: 0 };
    this.warnedTopics = new Set();
    // ★ 宿主连接断开的回调集合（可后注册）—— bridge-events 靠它立刻知道「该重连了」，
    //   不必干等 3 秒轮询。轮询仍然保留：换宿主、静默掉线时它是唯一的信号。
    this.hostCloseHooks = new Set();
    if (typeof o.onHostClose === 'function') this.hostCloseHooks.add(o.onHostClose);
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
      // ★★ 断线时**不清** subSeq：它正是重连时 resumeFrom 的来源（契约 §2.2）。
      //   清掉等于「忘了我看到哪儿了」→ 补帧退化成全量重放 → 每条事件重复发一遍 QQ。
      this.hosts.delete(id);
      this.log('断开 ' + (rec.host || id));
      for (const fn of [...this.hostCloseHooks]) {
        try { fn(rec); } catch (e) { this.log('hostClose 回调出错: ' + ((e && e.message) || e)); }
      }
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
    if (this.ackTimer) { clearTimeout(this.ackTimer); this.ackTimer = null; }
    // ★ 待确认的 seq 不丢：留在 ackQueue 里等下次 ack() 触发（或者随进程退出一起消失，
    //   那时宿主那边也会断开 —— 它靠 resumeFrom 补，不靠这条 ack）。
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
    // ★★★ 2026-11-14（第 14 代 · 协议 v2）：`push` —— 宿主 → v4，**单向，不等回执**。
    //   ★ 它**不是** result：没有 id、不进 pending 表。混进来会让某条 exec 等错东西。
    if (m.type === 'push') { this.#dispatchPush(rec, m); return; }

    // ★★★ 2026-11-14（第 14 代）：宿主反过来调 v4 —— 工具转发器走这条。
    //   ★ 必须**永远回执**，包括「没登记这个工具」：宿主那边在等，不回就是挂死。
    //   ★ 失败不回抛，回结构化 { ok:false, error }：宿主是外部进程，异常跨不过 ws。
    if (m.type === 'invoke') {
      const tool = String(m.tool || '');
      const id = m.id;
      const reply = (ok, payload) => {
        try { rec.conn.send(Object.assign({ type: 'invoke-result', id, ok }, payload)) }
        catch (e) { this.log('invoke 回执发不出去：' + ((e && e.message) || e)) }
      };
      const fn = this.invokers.get(tool);
      if (typeof fn !== 'function') { reply(false, { error: 'v4 没有登记这个工具：' + tool }); return; }
      rec.calls = (rec.calls || 0) + 1;
      Promise.resolve()
        .then(() => fn(m.args || {}))
        .then((data) => reply(true, { data: data === undefined ? null : data }))
        .catch((e) => {
          rec.failures = (rec.failures || 0) + 1;
          rec.lastError = String((e && e.message) || e).slice(0, 260);
          rec.lastErrorAt = new Date().toISOString();
          reply(false, { error: String((e && e.message) || e) });
        });
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
        // ★★ 2026-11-14（协议 v2）：**stage 原来在这里被丢掉了。**
        //   bridge 的失败帧是 { type:'result', ok:false, error, stage }（见它的 execFailure），
        //   而这里原来只搬 error 和 hint —— 于是 v4 永远拿不到机器可读的原因，
        //   只能去正则解析那句带 [stage:xxx] 前缀的中文。
        //   契约 §2.5 要求 attach 失败把 code 带出来（resolveAgent 的失败判据靠它）：
        //   stage 就是那一层 code；宿主将来若直接给 code，也一起搬。
        if (m.stage) e.stage = String(m.stage);
        if (m.code) e.code = String(m.code);
        else if (m.stage) e.code = String(m.stage);
        // ★ 宿主自己报的失败，是「为什么没干成」最可信的一手 —— 记在连接上，面板才看得见。
        rec.failures = (rec.failures || 0) + 1;
        rec.lastError = String(m.error || '宿主报错').slice(0, 260);
        rec.lastErrorAt = new Date().toISOString();
        p.reject(e);
      }
      return;
    }
  }

  /**
   * 登记一个「宿主可以反向调用」的工具实现。
   * ★ 返回注销函数 —— 卸载插件/换会话时要能撤掉，否则表会一直长。
   * ★ 同名覆盖：后来的赢。理由是「重挂工具」比重名报错更常见（模块热重载）。
   */
  registerInvoker(name, fn) {
    const key = String(name || '');
    if (!key) throw new Error('registerInvoker 需要一个名字');
    if (typeof fn !== 'function') throw new Error('registerInvoker(' + key + ') 需要函数');
    this.invokers.set(key, fn);
    return () => { if (this.invokers.get(key) === fn) this.invokers.delete(key); };
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

  /**
   * 宿主自报的 DSH 地址（hello.meta.dshBaseUrl）。
   *
   * ★ 2026-11-13（爀曦定）：**心跳要直接读宿主地址**，不再靠日志文件或 dsh-origin.txt 猜。
   *   理由：DSH 的 webServer 端口每次重启都变（本机实测 65334 → 64445），
   *   而 bridge 就住在 DSH 进程里 —— 它报的是**自己**的地址，永远不会过期。
   * ★ 只认 `http://127.0.0.1:<port>` 这一种形状，别的（https / localhost / 别的 host）一律不认：
   *   本机回环之外不是「我们的 DSH」。
   */
  hostOrigin() {
    try {
      for (const h of this.hosts.values()) {
        const u = h && h.meta && typeof h.meta.dshBaseUrl === 'string' ? h.meta.dshBaseUrl.trim() : '';
        if (HOST_ORIGIN_RE.test(u)) return u;
      }
    } catch { /* 拿不到就是没有，调用方 fail-closed */ }
    return null;
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
      // ★ 2026-11-14（协议 v2）：推过来的帧数 + 最近一帧的 topic/时间。
      //   「她的话回不到 QQ」那整晚，面板上没有任何一个数字能说明「事件根本没到」。
      pushes: Number.isFinite(h.pushes) ? h.pushes : 0,
      lastTopic: h.lastTopic || null,
      lastPushAt: h.lastPushAt || null,
      capsAt: h.capsAt || null,
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
        // ★★ 2026-11-13（第二批）：state 是**白名单** —— rec.state 存了全部（`...m`），
        //   但 snapshot 只挑这几个往外交。新字段不加进来，等于发出去又被丢掉。
        //   ★ 这三个是状态台要的：标题 / 是不是子会话 / 水位来源（null = 不知道，不编造）。
        sessionTitle: h.state.sessionTitle ?? null,
        isSub: h.state.isSub === true ? true : (h.state.isSub === false ? false : null),
        watermarkSource: h.state.watermarkSource ?? null,
        atMs: h.state.at,
        turn: h.state.turn ?? null,
        step: h.state.step ?? null,
        // ★★★ 2026-11-21：桥 0.1.7 起会带这两个 —— **必须加进白名单**，否则发出去又被丢掉。
        //   rec.state 是 `...m` 全量存的，但 snapshot 只挑白名单里的往外给；
        //   这条注释上方 311-313 行早就写着「新字段不加进来，等于发出去又被丢掉」，
        //   我这次就是又踩了一遍：stateVia 一直是 null，看上去像"桥没报"。
        //   判据：stateVia=走哪条钩子（agent/pre-step | systemPrompt.context），
        //        fallback=是不是拿不到 agent 时的兜底上报（那种不该当成"这个会话活跃过"的证据）。
        stateVia: h.state.stateVia ?? null,
        fallback: typeof h.state.fallback === 'boolean' ? h.state.fallback : null,
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

  // ───────────────────── push（协议 v2 · 宿主 → v4）─────────────────────

  /**
   * 订阅一个 topic 的 push 帧。
   *
   * ★ 返回**注销函数**（不是对象）—— 调用处（ctx.effect 的 dispose）写得最短。
   * ★ 同名多次订阅 = 多个订阅者，按注册顺序调用（不是覆盖）。
   *
   * @param {string} topic 例：'session/event'
   * @param {(frame:object)=>void} fn 收到的是**整帧**（type/topic/sub/seq/at/data）
   * @returns {() => void} unsubscribe
   */
  subscribe(topic, fn) {
    const t = String(topic || '');
    if (!t) throw new Error('subscribe 需要一个 topic');
    if (typeof fn !== 'function') throw new Error('subscribe(' + t + ') 需要函数');
    if (!this.subs.has(t)) this.subs.set(t, new Set());
    this.subs.get(t).add(fn);
    return () => {
      const s = this.subs.get(t);
      if (!s) return;
      s.delete(fn);
      if (!s.size) this.subs.delete(t);
    };
  }

  /** 注册「宿主断了」的回调。★ 返回注销函数。 */
  onHostClose(fn) {
    if (typeof fn !== 'function') throw new Error('onHostClose 需要函数');
    this.hostCloseHooks.add(fn);
    return () => { this.hostCloseHooks.delete(fn); };
  }

  /**
   * 确认收到（契约 §2.3）。**500ms 合并，只发最大的 seq。**
   *
   * ★ 为什么要合并：一轮 turn 会推好几帧，逐帧回是拿网络写压力换一个宿主并不需要的精度 ——
   *   它只需要知道「到哪儿为止可以裁 ring」。
   * ★ 没收到 ack 宿主要重发吗？**不**（契约明说）。重发会雪崩，补帧靠 resumeFrom。
   */
  ack(sub, seq) {
    const s = String(sub || '');
    if (!s || !Number.isInteger(seq)) return;
    const prev = this.ackQueue.get(s);
    if (prev === undefined || seq > prev) this.ackQueue.set(s, seq);
    if (this.ackTimer) return;
    this.ackTimer = setTimeout(() => { this.ackTimer = null; this.#flushAcks(); }, this.ackDelayMs);
    if (this.ackTimer.unref) this.ackTimer.unref();
  }

  #flushAcks() {
    for (const [sub, seq] of [...this.ackQueue]) {
      this.ackQueue.delete(sub);
      const hostId = this.subOwner.get(sub);
      const h = hostId ? this.hosts.get(hostId) : null;
      if (!h || !h.conn || !h.conn.open) {
        // ★ 连接没了就不发，也**不算确认过**：seq 仍留在 subSeq 里，重连时 resumeFrom 会带上它。
        this.pushStats.ackFailed++;
        continue;
      }
      try { h.conn.send({ type: 'ack', sub, seq }); this.pushStats.acked++; }
      catch (e) { this.pushStats.ackFailed++; this.log('ack 发不出去（' + sub + ' #' + seq + '）：' + ((e && e.message) || e)); }
    }
  }

  /**
   * 一帧 push 到了。四步，顺序不能换：
   * ① 记 seq（按订阅）② host/state 合进本地能力视图 ③ 分发给订阅者 ④ 合并 ack。
   *
   * ★ 幂等**不在这里做**：判据是 per-subscription 的 seq，而「哪些 seq 已经被业务消费过」
   *   只有消费方（bridge-events）知道 —— hub 只负责把帧送到，不替它判重。
   */
  #dispatchPush(rec, m) {
    const topic = String(m.topic || '');
    const sub = String(m.sub || '');
    const seq = Number.isInteger(m.seq) ? m.seq : null;

    this.pushStats.frames++;
    rec.pushes = (rec.pushes || 0) + 1;
    rec.lastPushAt = Date.now();
    rec.lastTopic = topic;

    // ① seq 只许前进不许后退：重复/乱序帧不能把游标拉回去（拉回去 = 下次重连重复补一批）。
    if (sub && seq !== null) {
      const prev = this.subSeq.get(sub);
      if (prev === undefined || seq > prev) this.subSeq.set(sub, seq);
      this.subOwner.set(sub, rec.id);
    }

    // ② host/state = **能力声明变了**，不是业务事件。
    //   不合进本地视图的话，whoHas/canDo 会一直用 hello 那一刻的快照 ——
    //   宿主新开的能力永远看不见，而「看不见」和「没开」在调用方眼里长得一样。
    if (topic === 'host/state') this.#applyHostState(rec, m.data);

    // ③ 分发。★ 一个订阅者抛错不许打断别的（同 broadcast 的规矩）。
    const set = this.subs.get(topic);
    if (!set || !set.size) {
      this.pushStats.noListener++;
      if (!this.warnedTopics.has(topic)) {
        this.warnedTopics.add(topic);
        this.log('push 无人订阅：' + topic + '（第一帧 seq=' + seq + '）—— 事件到了 v4 门口被丢掉了');
      }
    } else {
      this.pushStats.dispatched++;
      for (const fn of [...set]) {
        try { fn(m); } catch (e) { this.log('push 订阅者抛错（' + topic + '）：' + ((e && e.message) || e)); }
      }
    }

    // ④ 确认。★ 无人订阅的帧也确认：不确认会让宿主的 ring 一直涨，
    //   而「没人听」不是宿主的错 —— 重发一遍还是没人听。
    if (sub && seq !== null) this.ack(sub, seq);
    return this.pushStats.dispatched;
  }

  /** host/state 合并进 rec。★ 拿不到的字段保留旧值，不用 null 覆盖掉已知的能力。 */
  #applyHostState(rec, data) {
    if (!data || typeof data !== 'object') return;
    try {
      if (Array.isArray(data.caps)) { rec.caps = new Set(data.caps.map(String)); rec.capsAt = Date.now(); }
      if (Array.isArray(data.stubs)) rec.meta = Object.assign({}, rec.meta || {}, { stubs: data.stubs.map(String) });
      if (Array.isArray(data.agents)) {
        rec.agents = data.agents
          .map((a) => ({
            sessionId: a && (a.sessionId || a.id) ? String(a.sessionId || a.id) : null,
            title: a && a.title ? String(a.title) : null,
          }))
          .filter((a) => a.sessionId);
      }
    } catch (e) {
      this.log('host/state 合并失败（保留旧值）：' + ((e && e.message) || e));
    }
  }

  /** 面板/体检用：订阅、游标、ack、推送计数一次看全。 */
  pushStatus() {
    return {
      subscriptions: [...this.subSeq.entries()].map(([sub, seq]) => ({
        subscriptionId: sub, lastSeq: seq, hostId: this.subOwner.get(sub) || null,
      })),
      listeners: [...this.subs.entries()].map(([t, s]) => ({ topic: t, count: s.size })),
      pendingAcks: [...this.ackQueue.entries()].map(([sub, seq]) => ({ sub, seq })),
      stats: { ...this.pushStats },
      hosts: [...this.hosts.values()].map((h) => ({
        id: h.id, host: h.host, open: Boolean(h.conn && h.conn.open),
        pushes: h.pushes || 0, lastTopic: h.lastTopic || null, lastPushAt: h.lastPushAt || null,
      })),
    };
  }
}
