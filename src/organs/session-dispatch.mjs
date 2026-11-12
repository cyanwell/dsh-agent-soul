// 会话调度契约层 —— v4 指挥宿主那边的会话，只认能核对的回执
//
// ── 它补的是哪一段 ────────────────────────────────────────────────
//   autonomy-host 只管「该动了」那一次投递；cleanup 只管「裁哪一段」。
//   这一层管更前面的事：**这个 chatId 对应哪个会话、这句话投给谁、
//   什么时候可以新开一个**。四个动作全部只走控制通道、全部只认宿主回执。
//
// ── 协议（v4 → 宿主）──────────────────────────────────────────────
//   { cap:'session', action:'resolve'|'followup'|'steer'|'create', args:{…} }
//   resolve : args { chatId, preset? }            ← 只查，**绝不新建**
//   followup: args { sessionId, text, meta? }     ← 投一句话进会话
//   steer   : args { sessionId, text }            ← 打断正在跑的回合
//   create  : args { chatId, preset?, level? }    ← 从无到有开一个（唯一会新建的）
//
// ── 回执（宿主 → v4，放 result.data）──────────────────────────────
//   resolve : { ok:true, sessionId } | { ok:false, code:'NOT_FOUND' }
//   followup: { ok:true, delivered:true, sessionId } | { ok:false, code }
//   steer   : { ok:true, delivered:true, sessionId? } | { ok:false, code:'NOT_RUNNING' }
//   create  : { ok:true, sessionId } | { ok:false, code }
//   ★ 宿主也允许用**帧级** ok:false 表达失败（hub.exec 会 reject），这时 code 从
//     `[code:XXX]` / `[stage:XXX]` 前缀或 hint 里读 —— 两条路都认，因为
//     「怎么表达失败」是宿主侧的自由，而「我们认不认」必须一致。
//
// ── 三条判据（落成代码，不是注释里的期望）────────────────────────
//   ① **逐字相等**：回执里的 sessionId 必须与请求里那个一字符不差。
//      ★ 不 trim、不大小写折叠 —— `"sess-1 "` 和 `"sess-1"` 是两个东西，
//        那个差异正是「到底投给了谁」的证据，规范化等于把证据抹掉。
//   ② **超时不抛**：返回 { ok:false, code:'TIMEOUT' }。调用方不该为了用它写 try/catch。
//   ③ **没人接 ≠ 发了失败**：两者都进 counts.failed，但只有前者进 noHost.count，
//      view() 里一眼能分开。
//
// ── 硬纪律：正文不进日志、不进 view()、不进返回值 ────────────────
//   text 是私内容。本模块任何日志行、返回值的 detail、view() 的字段都不含 text，
//   也**不含宿主回执里的 error 原文** —— 那是宿主可控的自由文本，它完全可以把正文回显一遍。
//   进返回值的只有封闭集合里的 code（+ 可选 hint 名）。
//   ★ 截断的正文仍然是正文，所以是「不打印」，不是「少打印几个字」。
//
// ── 三条「不」（写在结构里，不靠自觉）────────────────────────────
//   · 没有周期任务、没有重试循环 —— 唯一的 setTimeout 是单次超时的兜底闸；
//   · 没有内部退路 —— 拿不到回执就是失败，不自己开容器、不自己写帧；
//   · resolve 不新建 —— 找不到就交回 NOT_FOUND。猜一个 chatId 去新建，
//     等于替人开了一个他会话树里本来不存在的分支。

export const SESSION_CAP = 'session';
export const DISPATCH_DEFAULT_TIMEOUT_MS = 8000;

/** 兜底闸比下层超时多留的余量：正常永远走不到，走到说明下层没按约定超时。 */
const HARD_GRACE_MS = 250;
const MAX_DETAIL = 200;
const HARD = Symbol('hard-deadline');

export const ACTIONS = Object.freeze({
  RESOLVE: 'resolve',
  FOLLOWUP: 'followup',
  STEER: 'steer',
  CREATE: 'create',
});

/**
 * 结果码 —— **封闭集合**。
 *
 * ★ 为什么封闭：一旦它变成自由文本，调用方就只能靠人读，那等于没加。
 *   宿主说别的词一律归 HOST_ERROR（不认识 ≠ 成功）。
 */
export const CODES = Object.freeze({
  NO_HOST: 'NO_HOST',
  NO_CONTROL: 'NO_CONTROL',
  TIMEOUT: 'TIMEOUT',
  MISMATCH: 'MISMATCH',
  NOT_DELIVERED: 'NOT_DELIVERED',
  NOT_RUNNING: 'NOT_RUNNING',
  NOT_FOUND: 'NOT_FOUND',
  // ★ 2026-11-12：这两个是**宿主已经明确表达过的**词（bridge 的 execError('no-target') /
  //   execError('unsupported')），不是自由文本。收进来是「认出已知的」，不是发明新语义。
  //   ★ 不收的代价：它们全落到 HOST_ERROR，而 HOST_ERROR 同时涵盖「宿主崩了」「回执坏了」
  //     「动作名不认识」—— 排障时这三种处置完全不同，压成一个词等于把处置也丢了。
  NO_TARGET: 'NO_TARGET',      // 宿主说「找不到可以叫醒的 agent」（会话不存在 / 没在跑）
  UNSUPPORTED: 'UNSUPPORTED',  // 宿主说「这个能力我没有」（如 create：agents 只暴露 get/roots）
  BAD_REQUEST: 'BAD_REQUEST',
  BAD_RECEIPT: 'BAD_RECEIPT',
  HOST_ERROR: 'HOST_ERROR',
});

const KNOWN_CODES = new Set(Object.values(CODES));

/** 宿主/适配器的同义词 → 本模块的词。只做等价归一，不发明语义。 */
const CODE_ALIASES = Object.freeze({
  SESSION_NOT_FOUND: CODES.NOT_FOUND,
  NO_SUCH_SESSION: CODES.NOT_FOUND,
  NOT_ACTIVE: CODES.NOT_RUNNING,
  IDLE: CODES.NOT_RUNNING,
  STUB_DECLARED: CODES.NO_HOST,
  CAPABILITY_MISSING: CODES.NO_HOST,
  CAPABILITY_NOT_WIRED: CODES.NO_HOST,
  NO_SUCH_HOST: CODES.NO_HOST,
  NO_SUCH_AGENT: CODES.NO_TARGET,
  NOT_SUPPORTED: CODES.UNSUPPORTED,
});

/** 把任意来源的词归一成封闭集合里的一个；不认识 → null（绝不猜）。 */
export function normCode(raw) {
  const s = String(raw == null ? '' : raw).trim().toUpperCase().replace(/[\s.\-]+/g, '_');
  if (!s) return null;
  if (KNOWN_CODES.has(s)) return s;
  return CODE_ALIASES[s] || null;
}

/**
 * 从 hub.exec 的异常里取**机器可读**的码。
 *
 * ★★ 这里刻意**不返回 e.message**：那条 message 是宿主回执里的 error 原文，
 *   宿主完全可以把投递正文回显在里面。所以只取封闭集合里的 code / hint，
 *   原文一个字符都不进返回值、不进日志。
 */
export function codeFromError(e) {
  if (!e) return CODES.HOST_ERROR;
  // ★ 2026-11-12：先认**结构化字段**。宿主失败帧上本来就有 stage（bridge 的 execFailure：
  //   { stage, error:'[stage:<code>] …' }），hub.exec 把它挂成 e.stage / e.code 时，
  //   这比去正则解析一句人话可靠。原来的实现只读 hint 和 message 标签，于是
  //   「设置了 e.code 的宿主」和「只在消息里带标签的宿主」被区别对待 —— 那是实现细节泄漏。
  //   ★ normCode 不认识就返回 null（ECONNREFUSED 这类系统码不在封闭集合里），不会误判。
  const byStage = normCode(e.stage) || normCode(e.code);
  if (byStage) return byStage;
  const byHint = normCode(e.hint);
  if (byHint) return byHint;
  const msg = String(e.message || '');
  const tagged = /\[(?:code|stage):([a-zA-Z][a-zA-Z0-9_-]{0,39})\]/.exec(msg);
  if (tagged) {
    const c = normCode(tagged[1]);
    if (c) return c;
  }
  if (/超时|timeout/i.test(msg)) return CODES.TIMEOUT;
  if (/宿主不在|没有能力/.test(msg)) return CODES.NO_HOST;
  return CODES.HOST_ERROR;
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const nonEmptyStr = (v) => typeof v === 'string' && v.length > 0;

/**
 * resolve 的回执判据。
 * @returns {{ok:true, sessionId:string}|{ok:false, code:string, detail:string}}
 */
export function judgeResolveReceipt({ data, expectChatId } = {}) {
  const bad = (code, detail) => ({ ok: false, code, detail });
  if (!isObj(data)) return bad(CODES.BAD_RECEIPT, 'resolve 回执不是对象');
  if (data.ok === false) {
    const c = normCode(data.code);
    return c ? bad(c, '宿主自报失败（' + c + '）') : bad(CODES.BAD_RECEIPT, '回执说失败但没给可识别的 code');
  }
  const sid = nonEmptyStr(data.sessionId) ? data.sessionId : '';
  if (!sid) return bad(CODES.BAD_RECEIPT, '回执没有 sessionId —— 证明不了查到了哪个会话');
  // ★ 交叉校验：宿主**主动报了** chatId 时它必须对得上，否则就是「回错行」。
  //   它不报就不检 —— 不默认要求宿主多给一层证据。
  if (nonEmptyStr(data.chatId) && expectChatId != null && data.chatId !== expectChatId) {
    return bad(CODES.MISMATCH, '回执的 chatId 与请求不一致');
  }
  return { ok: true, sessionId: sid };
}

/**
 * followup / steer 的回执判据。
 *
 * ★ 两者差一处：**followup 必须自报 sessionId**（它是「投递」，得证明投给了谁），
 *   steer 可以不自报（打断的目标由请求唯一确定），但**一旦报了就必须逐字对上**。
 *   这不是降低标准：标准始终是「回执说过的话必须能被核对」，只是 steer 少说了那一句。
 */
export function judgeDeliveryReceipt({ data, expectSessionId, requireSessionId } = {}) {
  const bad = (code, detail) => ({ ok: false, code, detail });
  if (!isObj(data)) return bad(CODES.BAD_RECEIPT, '回执不是对象');
  if (data.ok === false) {
    const c = normCode(data.code);
    return c ? bad(c, '宿主自报失败（' + c + '）') : bad(CODES.BAD_RECEIPT, '回执说失败但没给可识别的 code');
  }
  if (data.delivered !== true) return bad(CODES.NOT_DELIVERED, '回执没有 delivered===true —— 不认这次投递');

  const sid = nonEmptyStr(data.sessionId) ? data.sessionId : '';
  if (!sid) {
    if (requireSessionId) return bad(CODES.BAD_RECEIPT, '回执没自报 sessionId —— 证明不了投给了谁');
    return { ok: true, sessionId: null };
  }
  if (expectSessionId != null && sid !== expectSessionId) {
    // ★ 逐字比较。detail 里也不放那两个值 —— 它们是标识不是正文，但没必要外带。
    return bad(CODES.MISMATCH, '回执的 sessionId 与请求逐字不一致');
  }
  return { ok: true, sessionId: sid };
}

/** 能接 session 的宿主（滤掉 hello.meta.stubs 里声明为桩的）。认不出 hub 形状 → null。 */
function peersOf(hub) {
  if (!hub) return null;
  if (typeof hub.canDo === 'function') {
    const list = hub.canDo(SESSION_CAP);
    return Array.isArray(list) ? list.slice() : null;
  }
  if (typeof hub.snapshot === 'function') {
    const snap = hub.snapshot();
    if (!Array.isArray(snap)) return null;
    return snap.filter((h) => h
      && Array.isArray(h.caps) && h.caps.includes(SESSION_CAP)
      && !(Array.isArray(h.stubs) ? h.stubs : []).includes(SESSION_CAP));
  }
  return null;
}

/** 声称会 session、但自己声明是桩的那几个（只为了把 NO_HOST 的 detail 说清楚）。 */
function stubbedPeers(hub) {
  if (!hub || typeof hub.snapshot !== 'function') return [];
  let snap = [];
  try { snap = hub.snapshot() || []; } catch { return []; }
  return (Array.isArray(snap) ? snap : []).filter((h) => h
    && Array.isArray(h.caps) && h.caps.includes(SESSION_CAP)
    && (Array.isArray(h.stubs) ? h.stubs : []).includes(SESSION_CAP));
}

/**
 * 造一个会话调度器。
 *
 * @param {object} opts
 *   hub       —— ControlHub（canDo / snapshot / exec）。没有它 = NO_CONTROL，不自己干。
 *   log       —— 一行一次调用的日志。**不含正文**。
 *   timeoutMs —— 等回执的超时，默认 8000；测试可调小。
 *   clock     —— 注入时间（测试用）。
 * @returns {{resolve:Function, followup:Function, steer:Function, create:Function, view:Function, timeoutMs:number}}
 */
export function createSessionDispatch(opts) {
  const o = opts || {};
  const hub = o.hub || null;
  const log = typeof o.log === 'function' ? o.log : () => {};
  const clock = typeof o.clock === 'function' ? o.clock : () => Date.now();
  const timeoutMs = Number.isFinite(o.timeoutMs) && o.timeoutMs > 0
    ? Math.floor(o.timeoutMs)
    : DISPATCH_DEFAULT_TIMEOUT_MS;

  const counts = { resolve: 0, followup: 0, steer: 0, create: 0, failed: 0 };
  /** ★ 只数「没人接」。它就是 view() 用来区分「没人接 / 发了失败」的那一格。 */
  const noHost = { count: 0, at: null };
  let lastAt = null;
  let lastOutcome = null;

  function elapsed(t0) {
    const n = clock() - t0;
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  /** 一次调用的收尾：计数 + 一行日志。**只在能核对到结果之后调用**（失败也算结果）。 */
  function record(action, res, t0) {
    const at = clock();
    const iso = new Date(at).toISOString();
    const ms = elapsed(t0);
    const out = { ...res, action, elapsedMs: ms };
    if (out.ok === true) {
      counts[action] = (counts[action] || 0) + 1;
    } else {
      counts.failed += 1;
      if (out.code === CODES.NO_HOST) { noHost.count += 1; noHost.at = iso; }
    }
    lastAt = iso;
    lastOutcome = { ok: out.ok === true, code: out.ok === true ? null : out.code, action, at: iso };
    // ★ 日志只有：动作 / 宿主名 / 结果码 / 耗时。不拼 args、不拼回执。
    const peer = out.host ? ' → ' + out.host : '';
    log(out.ok === true
      ? '会话调度 session/' + action + peer + ' ok ' + ms + 'ms'
      : '会话调度 session/' + action + peer + ' 失败[' + out.code + '] ' + ms + 'ms');
    return out;
  }

  function bad(action, code, detail, t0) {
    return record(action, { ok: false, code, detail: String(detail || '').slice(0, MAX_DETAIL) }, t0);
  }

  /**
   * 选一个能干的宿主。
   * ★ 新连上的优先 —— 与自主投递、定点清理、面板投递同一条规则（有新鲜 state 的更可能活着）。
   */
  function pickPeer() {
    const able = peersOf(hub);
    if (!able) {
      return { ok: false, code: CODES.NO_CONTROL, detail: '没有可用的控制通道（hub 没接或形状不认识）' };
    }
    if (!able.length) {
      const stubbed = stubbedPeers(hub);
      const howMany = (() => {
        try {
          const snap = typeof hub.snapshot === 'function' ? (hub.snapshot() || []) : [];
          return Array.isArray(snap) ? snap.length : 0;
        } catch { return 0; }
      })();
      return {
        ok: false,
        code: CODES.NO_HOST,
        detail: stubbed.length
          ? '连着的宿主都声明 ' + SESSION_CAP + ' 是桩（能力在、路没通）'
          : '没有声明 ' + SESSION_CAP + ' 能力且未标桩的宿主（连着 ' + howMany + ' 个）',
      };
    }
    const sorted = able.slice().sort((a, b) => (Number(b && b.at) || 0) - (Number(a && a.at) || 0));
    return { ok: true, peer: sorted[0] };
  }

  /**
   * 发一条指令并等回执。**任何异常都被折成结果码**，绝不外抛。
   * ★ 除了 hub.exec 自己的超时，还有一道 +250ms 的兜底闸：契约层不该把
   *   「永不返回」的责任完全押在下层的实现上（下层将来换了实现，这里也不该挂死）。
   */
  async function callHub(peer, action, args, budgetMs, cap) {
    // ★ 2026-11-13：cap 可传了 —— 换气要用 'context'（对上下文动刀），
    //   不再是只有 'session'。默认仍是 'session'，老调用方不用改。
    const useCap = cap || SESSION_CAP
    let timer = null;
    const hard = new Promise((res) => {
      timer = setTimeout(() => res(HARD), budgetMs + HARD_GRACE_MS);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
    try {
      const r = await Promise.race([hub.exec(peer.id, useCap, action, args, budgetMs), hard]);
      if (r === HARD) return { ok: false, code: CODES.TIMEOUT, detail: '等回执超过 ' + budgetMs + 'ms（兜底闸）' };
      return { ok: true, data: r };
    } catch (e) {
      const code = codeFromError(e);
      // ★ detail 按码给固定文本，**不拼接 e.message**（那是宿主可控的自由文本，可能回显正文）。
      const detail = code === CODES.TIMEOUT
        ? '等回执超过 ' + budgetMs + 'ms'
        : (code === CODES.NO_HOST ? '宿主不在或没有 ' + useCap + ' 能力' : '宿主没有给出可用的回执');
      return { ok: false, code, detail };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 公共前半段：拿宿主 → 发 → 判回执。 */
  async function invoke(action, args, judge, t0, cap) {
    const picked = pickPeer();
    if (!picked.ok) return bad(action, picked.code, picked.detail, t0);
    const peer = picked.peer;
    const r = await callHub(peer, action, args, timeoutMs, cap);
    if (!r.ok) {
      const out = bad(action, r.code, r.detail, t0);
      out.host = peer.host || null;
      out.hostId = peer.id || null;
      return out;
    }
    const judged = judge(r.data);
    if (!judged.ok) {
      const out = bad(action, judged.code, judged.detail, t0);
      out.host = peer.host || null;
      out.hostId = peer.id || null;
      return out;
    }
    return { peer, judged };
  }

  // ── 四个动作 ────────────────────────────────────────────────────

  async function resolve(input) {
    const t0 = clock();
    const a = input || {};
    if (!nonEmptyStr(a.chatId)) return bad(ACTIONS.RESOLVE, CODES.BAD_REQUEST, 'chatId 必须是非空字符串', t0);
    const args = { chatId: a.chatId };
    if (nonEmptyStr(a.preset)) args.preset = a.preset;
    const r = await invoke(ACTIONS.RESOLVE, args, (data) => judgeResolveReceipt({ data, expectChatId: a.chatId }), t0);
    if (r.ok === false) return r;
    const res = record(ACTIONS.RESOLVE, {
      ok: true, sessionId: r.judged.sessionId, host: r.peer.host || null, hostId: r.peer.id || null,
    }, t0);
    return res;
  }

  async function followup(input) {
    const t0 = clock();
    const a = input || {};
    if (!nonEmptyStr(a.sessionId)) return bad(ACTIONS.FOLLOWUP, CODES.BAD_REQUEST, 'sessionId 必须是非空字符串', t0);
    if (!nonEmptyStr(a.text)) return bad(ACTIONS.FOLLOWUP, CODES.BAD_REQUEST, 'text 必须是非空字符串', t0);
    const args = { sessionId: a.sessionId, text: a.text };
    if (a.meta !== undefined && a.meta !== null) args.meta = a.meta;
    const r = await invoke(ACTIONS.FOLLOWUP, args,
      (data) => judgeDeliveryReceipt({ data, expectSessionId: a.sessionId, requireSessionId: true }), t0);
    if (r.ok === false) return r;
    return record(ACTIONS.FOLLOWUP, {
      ok: true, delivered: true, sessionId: r.judged.sessionId,
      host: r.peer.host || null, hostId: r.peer.id || null,
    }, t0);
  }

  async function steer(input) {
    const t0 = clock();
    const a = input || {};
    if (!nonEmptyStr(a.sessionId)) return bad(ACTIONS.STEER, CODES.BAD_REQUEST, 'sessionId 必须是非空字符串', t0);
    if (!nonEmptyStr(a.text)) return bad(ACTIONS.STEER, CODES.BAD_REQUEST, 'text 必须是非空字符串', t0);
    const r = await invoke(ACTIONS.STEER, { sessionId: a.sessionId, text: a.text },
      (data) => judgeDeliveryReceipt({ data, expectSessionId: a.sessionId, requireSessionId: false }), t0);
    if (r.ok === false) return r;
    return record(ACTIONS.STEER, {
      ok: true, delivered: true, sessionId: r.judged.sessionId,
      host: r.peer.host || null, hostId: r.peer.id || null,
    }, t0);
  }

  /**
   * ★ 四个动作里**唯一会新建容器**的一个。
   *   它的正确触发者是**人/宿主的显式请求**，不是 v4 的定时器或自主循环
   *   （理由写在报告里；代码这层只保证「没显式 chatId 就不发」）。
   */
  async function create(input) {
    const t0 = clock();
    const a = input || {};
    if (!nonEmptyStr(a.chatId)) return bad(ACTIONS.CREATE, CODES.BAD_REQUEST, 'chatId 必须是非空字符串', t0);
    const args = { chatId: a.chatId };
    if (nonEmptyStr(a.preset)) args.preset = a.preset;
    if (a.level !== undefined && a.level !== null) args.level = a.level;
    const r = await invoke(ACTIONS.CREATE, args, (data) => judgeResolveReceipt({ data, expectChatId: a.chatId }), t0);
    if (r.ok === false) return r;
    return record(ACTIONS.CREATE, {
      ok: true, sessionId: r.judged.sessionId, host: r.peer.host || null, hostId: r.peer.id || null,
    }, t0);
  }

  /**
   * 观测面。**不含任何 message 正文**（连长度都没有）。
   * ★ 「没人接」和「发了失败」在这里是可分辨的两格：noHost.count / lastOutcome.code。
   */
  function view() {
    const able = peersOf(hub) || [];
    return {
      hosts: able.map((h) => ({
        id: h.id || null,
        host: h.host || null,
        caps: Array.isArray(h.caps) ? h.caps.slice() : (h.caps ? [...h.caps] : []),
        stubs: Array.isArray(h.stubs) ? h.stubs.slice() : [],
        // ★ 2026-11-13：把 meta 也吐出来 —— 里面有 bridge 的 **pid 和 version**，
        //   那是唯一能证明「运行的是哪份代码」的东西（文件内容证明不了）。
        meta: (h.meta && typeof h.meta === 'object') ? {
          pid: h.meta.pid ?? null,
          version: h.meta.version ?? null,
          plugin: h.meta.plugin ?? null,
          node: h.meta.node ?? null,
          stubs: Array.isArray(h.meta.stubs) ? h.meta.stubs.slice() : null,
        } : null,
        connectedAt: Number.isFinite(h.at) ? new Date(h.at).toISOString() : (h.connectedAt || null),
      })),
      hostCount: able.length,
      lastAt,
      lastOutcome,
      noHost: { count: noHost.count, at: noHost.at },
      counts: { ...counts },
      cap: SESSION_CAP,
      timeoutMs,
    };
  }

  // ── ★★★ 换气：上下文手术（2026-11-13）────────────────────────────────
  //
  //   爀曦：「把 bridge 拓展成 v4 的调度平台」「不要依赖改造 DSH 自己的东西」。
  //   所以修复不走 DSH 的 pruner，改走 bridge 的 cap='context'：
  //     · candidates → 列可清的 tool/result（只读）
  //     · purge      → 按 seq 精准替换（真的对上下文动刀）
  //
  //   ★ 判据看 bridge 的回执：purgedCount / failedCount / purged[] / failed[]。
  //     **一条失败不该让整批看起来成功** —— 全失败时回 ok:false。
  const CONTEXT_CAP = 'context'

  async function candidates (input) {
    const t0 = clock()
    const a = input || {}
    if (!nonEmptyStr(a.sessionId)) return bad('candidates', CODES.BAD_REQUEST, 'sessionId 必须是非空字符串', t0)
    const args = { sessionId: a.sessionId }
    if (Number.isFinite(a.limit)) args.limit = a.limit
    const r = await invoke('candidates', args, (data) => {
      if (!data || typeof data !== 'object') return { ok: false, code: CODES.NO_HOST, detail: '回执不是对象' }
      if (!Array.isArray(data.items)) return { ok: false, code: CODES.NO_HOST, detail: '回执没有 items[]' }
      return { ok: true, count: data.count || data.items.length, items: data.items }
    }, t0, CONTEXT_CAP)
    if (r.ok === false) return r
    return record('candidates', {
      ok: true, sessionId: a.sessionId,
      count: r.judged.count, items: r.judged.items,
      host: r.peer.host || null, hostId: r.peer.id || null,
    }, t0)
  }

  async function purge (input) {
    const t0 = clock()
    const a = input || {}
    if (!nonEmptyStr(a.sessionId)) return bad('purge', CODES.BAD_REQUEST, 'sessionId 必须是非空字符串', t0)
    if (!Array.isArray(a.items) || !a.items.length) return bad('purge', CODES.BAD_REQUEST, 'items 必须是非空数组（每项 {seq, reason?}）', t0)
    const r = await invoke('purge', { sessionId: a.sessionId, items: a.items }, (data) => {
      if (!data || typeof data !== 'object') return { ok: false, code: CODES.NO_HOST, detail: '回执不是对象' }
      const pc = Number(data.purgedCount)
      const fc = Number(data.failedCount)
      if (!Number.isFinite(pc) || !Number.isFinite(fc)) return { ok: false, code: CODES.NO_HOST, detail: '回执缺 purgedCount/failedCount' }
      // ★ 全失败 = 这次手术没成，不能报 ok
      if (pc === 0) return { ok: false, code: 'no-purge-succeeded', detail: '一条都没清成：' + JSON.stringify((data.failed || []).slice(0, 2)) }
      return { ok: true, purgedCount: pc, failedCount: fc, purged: data.purged || [], failed: data.failed || [] }
    }, t0, CONTEXT_CAP)
    if (r.ok === false) return r
    return record('purge', {
      ok: true, sessionId: a.sessionId,
      purgedCount: r.judged.purgedCount, failedCount: r.judged.failedCount,
      purged: r.judged.purged, failed: r.judged.failed,
      host: r.peer.host || null, hostId: r.peer.id || null,
    }, t0)
  }

  return { resolve, followup, steer, create, candidates, purge, view, timeoutMs };
}

export default { createSessionDispatch, judgeResolveReceipt, judgeDeliveryReceipt, normCode, CODES, ACTIONS, SESSION_CAP };
