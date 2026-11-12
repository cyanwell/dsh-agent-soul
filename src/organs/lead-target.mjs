// 动态目标 —— 「留空 = 跟随《墨》当前 lead」
//
// ★★ 这个文件**不读《墨》**。
//   lead 的判据只有一个真源：DSH 的 dsh-yanqing-heartbeat 插件 —— 它读《墨》里最后一条 lead、
//   在**活的会话根**里匹配，再把 primarySessionId 经 GET /heartbeat/auto 报出来。
//   v4 只做一件事：**把那个 id 取回来用**。
//
//   ★ 为什么不在 v4 里写「读 02-墨.jsonl 找最后一条 lead」：那是**第二套主脑规则**。
//     两份实现迟早给出两个答案，而「投给谁」这件事没有第二个答案可以容忍 ——
//     一旦两边不一致，面板说一套、投递做一套，而错的从来不会被发现（投错没人看得见）。
//   ★ 也不读 /heartbeat/state（那是面板用的聚合），只读 /heartbeat/auto —— 它回的才是活值。
//
// 三条语义（2026-11-11 爀曦定）：
//   ① targetSession **留空** → 动态跟随当前 lead；交接后**下一次 tick 就用新 id**（不缓存旧 id 当目标）；
//   ② targetSession **显式填写** → 固定覆盖（不请求心跳，也不因心跳读不到而失效）；
//   ③ 心跳不可用 / primaryFound=false / sessionId 缺失 / 候选歧义 / 上次解析过期 → **fail-closed（不动）**。
//
// ★ 这里**没有计时器**：不新增第二套倒计时，只在别人（自主 tick）问的时候读一次。
//   心跳该不该动、还剩多久，仍由 dsh-yanqing-heartbeat 自己回答（runtime-status.mjs 显示它）。
//
// ── 「到哪问心跳」（2026-11-11 · 地址自动发现）────────────────────────
//   DSH 每次重启换端口（59174 → 57099 → 56207 → 49394）。所以地址是这样定的：
//     ① integrations.heartbeatUrl / dshBaseUrl —— 人显式配的，**最高优先**（配了就一次日志都不读）；
//     ② 没配 → 从本机最新 DSH 启动记录里发现 origin（organs/dsh-origin.mjs，每次 refresh 现读，不缓存）；
//     ③ 发现不到 / 多源不一致 → fail-closed（不动）。
//   ★ 发现的是「到哪问」，不是「谁是 lead」—— 后者仍然只由 /heartbeat/auto 回答，这里没有第二套判定。
//   ★ 每一次 refresh 都重新解析地址：端口变了，**下一个 tick** 就用新 origin，旧端口不留任何缓存。

import fs from 'node:fs';
import { readJsonWith } from '../web/runtime-status.mjs';
import { resolveHeartbeatEndpoint } from './dsh-origin.mjs';

/** 目标从哪来 */
export const TARGET_SOURCE = Object.freeze({
  FIXED: 'fixed',             // 人显式填的 autonomy.targetSession
  LEAD: 'heartbeat-lead',     // 心跳解析出的当前 lead
  NONE: 'none',               // 解析不出（fail-closed）
});

// ★ 解析结果的有效期：tick 每次都会先刷新（见 index.mjs 的 autonomy 规则），
//   所以这个 TTL 只影响「两次 tick 之间显示/手动触发」看到的值 ——
//   超过它就当成「不知道」，不拿一个可能已经交接掉的旧 id 去投。
export const DEFAULT_LEAD_TTL_MS = 5 * 60 * 1000;
// ★★ 2026-11-11 实测：1500ms 太短。DSH 在**处理一轮对话**时，/heartbeat/auto 要排队，
//   稳定超时 —— 而我单独用 curl 测只要 101ms（那条 200 是在它空闲时打的）。
//   日志原话：「读心跳失败：请求超时（1500ms）」，而同一刻账本兜底给出了正确答案。
//   **判据：超时值要按「宿主最忙的时候」定，不是按「我测它的时候」定。**
const DEFAULT_TIMEOUT_MS = 5000;
const WHY_SLICE = 300;

/**
 * 把 GET /heartbeat/auto 的响应翻译成「当前目标是谁」。
 *
 * ★ 纯函数：不发请求、不碰磁盘。这样「心跳说什么 → 我们做什么」可以被直接断言，
 *   而不是靠跑起整个进程去猜。
 *
 * @param {object} payload /heartbeat/auto 的 JSON
 * @param {{atMs?:number}} [opts] 读到它的时刻（用**我们自己的钟**，不用对面的）
 * @returns {{ok:boolean, source:string, sessionId:string|null, candidates:number,
 *            leadSource:string|null, atMs:number, why:string}}
 */
export function resolveTargetFromHeartbeatPayload(payload, opts) {
  const o = opts || {};
  const atMs = Number.isFinite(o.atMs) ? o.atMs : Date.now();
  const base = {
    source: TARGET_SOURCE.LEAD, sessionId: null, candidates: 0,
    leadSource: null, atMs, why: '',
  };

  if (!payload || typeof payload !== 'object') {
    return { ...base, ok: false, why: '心跳接口没回数据（不是 JSON 对象）' };
  }
  if (payload.ok === false) {
    return { ...base, ok: false, why: '心跳接口回了 ok:false：' + String(payload.why || '未给原因').slice(0, 160) };
  }
  const note = payload.primaryWhy ? '（心跳自述：' + String(payload.primaryWhy).slice(0, 160) + '）' : '';

  if (payload.primaryFound !== true) {
    return { ...base, ok: false, why: '心跳说没有找到主导会话' + note };
  }
  const id = payload.primarySessionId == null ? '' : String(payload.primarySessionId).trim();
  if (!id) {
    return {
      ...base, ok: false,
      why: '心跳响应里没有 primarySessionId（旧版 dsh-yanqing-heartbeat？它只回 primaryFound，'
        + '解析不出该投给谁）—— 需要升级心跳插件' + note,
    };
  }
  const candidates = Number.isInteger(payload.primaryCandidates) ? payload.primaryCandidates : 1;
  if (candidates > 1) {
    return {
      ...base, sessionId: id, candidates, ok: false,
      why: '心跳报告有 ' + candidates + ' 个活会话都命中当前 lead（歧义）—— 不替你挑一个' + note,
    };
  }
  return {
    ok: true, source: TARGET_SOURCE.LEAD, sessionId: id, candidates,
    leadSource: payload.leadSource ? String(payload.leadSource).slice(0, 40) : null,
    atMs, why: '',
  };
}

/**
 * 这一次 tick 的**唯一**目标。纯函数。
 *
 * @param {object} args
 *   config  —— Autonomy 合并后的配置（读 targetSession / pushToHost）
 *   dynamic —— 最近一次心跳解析结果（没有就 null）
 *   nowMs   —— 现在
 *   ttlMs   —— 解析结果的有效期
 * @returns {{ok:boolean, sessionId:string|null, source:string, why:string, candidates?:number,
 *            leadSource?:string|null, atMs?:number}}
 */
export function resolveTarget({ config, dynamic, nowMs, ttlMs } = {}) {
  const cfg = config || {};
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_LEAD_TTL_MS;

  // ① 固定覆盖优先 —— 而且**与心跳无关**：人指定了就不该被一个读不到的接口拖失效。
  const fixed = String(cfg.targetSession == null ? '' : cfg.targetSession).trim();
  if (fixed) {
    return { ok: true, sessionId: fixed, source: TARGET_SOURCE.FIXED, atMs: now, why: '' };
  }

  // ② 动态：还没有解析过
  if (!dynamic || typeof dynamic !== 'object') {
    return {
      ok: false, sessionId: null, source: TARGET_SOURCE.LEAD,
      why: '没有 targetSession，且还没有解析到当前 lead（心跳没读过）',
    };
  }
  // ③ 动态：最近一次解析本身失败（读不到 / 没主导 / 歧义 / 旧版插件）
  if (dynamic.ok !== true) {
    return {
      ok: false, sessionId: null, source: TARGET_SOURCE.LEAD, atMs: dynamic.atMs,
      why: String(dynamic.why || '解析不到当前 lead（fail-closed）').slice(0, WHY_SLICE),
    };
  }
  // ④ 动态：解析成立，但太旧了 —— 「可能已经交接」和「知道」是两件事，不混
  const at = Number.isFinite(dynamic.atMs) ? dynamic.atMs : 0;
  if (!at || now - at > ttl) {
    return {
      ok: false, sessionId: null, source: TARGET_SOURCE.LEAD, atMs: at || null,
      why: '上一次解析到的 lead 已经过期（' + Math.round(Math.max(0, now - at) / 1000) + ' 秒前）—— 不拿旧 id 冒险',
    };
  }
  return {
    ok: true, sessionId: dynamic.sessionId, source: TARGET_SOURCE.LEAD,
    candidates: dynamic.candidates, leadSource: dynamic.leadSource || null, atMs: at, why: '',
  };
}

/** 「没读到」的统一形状 —— 每条都带 atMs，让调用方能说过期。 */
function failAt(atMs, why) {
  return {
    ok: false, source: TARGET_SOURCE.LEAD, sessionId: null, candidates: 0,
    leadSource: null, atMs, why: String(why || '').slice(0, WHY_SLICE),
  };
}

/**
 * 造一个「当前 lead」解析器。
 *
 * ★ 它是**同步可读、异步刷新**的：交付路径（tick）先 await refresh()，再同步读 current()；
 *   显示路径（/api/organs）直接读 current()，不额外发请求。
 *   这样「一次 tick 只用一个 id」在结构上成立，而不是靠调用方自觉。
 *
 * @param {object} opts
 *   config    —— 整份配置（只用 integrations.*；地址解析复用 web/runtime-status.mjs 的同一份）
 *   fetchImpl —— 注入（测试用）
 *   now       —— 注入时钟
 *   timeoutMs —— 单次读超时
 *   log       —— 可选日志
 */
export function createLeadTargetResolver(opts) {
  const o = opts || {};
  const config = o.config || {};
  const it = config.integrations || {};
  const fetchImpl = o.fetchImpl
    || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  const timeoutMs = Number.isFinite(o.timeoutMs) ? o.timeoutMs
    : (Number.isFinite(Number(it.timeoutMs)) && Number(it.timeoutMs) > 0 ? Number(it.timeoutMs) : DEFAULT_TIMEOUT_MS);
  const log = typeof o.log === 'function' ? o.log : () => {};
  // ★ 地址来源的三条注入点（测试用）：不注入就按 config + 本机默认位置自己发现。
  const endpointOpts = { logDir: o.logDir, originFile: o.originFile, discover: o.discover, now };
  // ★ 2026-11-11：账本兜底要能列会话（把账本里的 8 位署名对到完整 id）。不注入就不兜底。
  const sessionsProvider = typeof o.sessionsProvider === 'function' ? o.sessionsProvider : null;
  const ledgerFile = String(o.ledgerFile || it.ledgerFile || '');
  const ledgerFallback = it.ledgerFallback === true;

  const stats = { refreshes: 0, fetches: 0 };
  let lastEndpointKey = null;
  let last = {
    ok: false, source: TARGET_SOURCE.LEAD, sessionId: null, candidates: 0, leadSource: null,
    atMs: 0, why: '还没有解析过当前 lead（本进程还没走过一次需要动态目标的 tick）',
  };

  async function refresh() {
    const t = now();
    // ★★ 每一 tick 现解析一次地址（显式配置 > 自动发现 > fail-closed），**不缓存 origin**：
    //   缓存旧端口就是这次要修的那个故障本身 —— 它不报错，只是永远不再通。
    // ★★★ 2026-11-13 修：**账本兜底要覆盖两种失败** ——
    //   ① 心跳地址解析不出来（DSH 插件不在 = 没有任何 origin）
    //   ② 地址有、但请求失败
    //   原来只有 ② 走兜底，① 直接早退 —— 而「禁掉 DSH 心跳插件」正好制造的是 ①。
    //   于是「准备解耦」的兜底在真正该起作用的那一刻**永远不触发**。
    //   教训形状：兜底写在了**第二个失败出口**，而最常见的失败走的是第一个。
    const tryLedger = (why) => {
      if (!ledgerFallback || !ledgerFile || !sessionsProvider) return null
      let sess = []
      try { sess = sessionsProvider() || [] } catch { sess = [] }
      const led = leadFromLedger(ledgerFile, sess)
      if (!led.ok) {
        log('账本兜底没成：' + led.why)
        return null
      }
      log('当前 lead = ' + led.sessionId + '（账本，' + why + '）')
      return {
        ...last,
        ok: true,
        sessionId: led.sessionId,
        candidates: 1,
        leadSource: 'ledger:last-lead',
        atMs: t,
        why: '心跳不通（' + why + '）→ 账本兜底命中：' + led.why,
      }
    }

    const ep = resolveHeartbeatEndpoint(config, { ...endpointOpts, now: t });
    if (!ep.ok) {
      const led = tryLedger('地址解析失败：' + ep.why)
      if (led) { last = led; return last }
      last = failAt(t, ep.why)
      return last
    }
    // ★ 只在地址**变了**的时候说一句（不然每 60 秒刷一行同样的字）。
    const key = ep.source + '|' + (ep.origin || ep.url || '');
    if (key !== lastEndpointKey) {
      lastEndpointKey = key;
      log('心跳地址：' + (ep.origin || ep.url) + '（来源：' + ep.source
        + (ep.file ? ' / ' + ep.file : '') + '）');
    }
    if (typeof fetchImpl !== 'function') { last = failAt(t, '运行时没有 fetch —— 解析不到当前 lead'); return last; }

    stats.fetches++;
    let r = null;
    try { r = await readJsonWith(ep.url, timeoutMs, fetchImpl); }
    catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
    if (!r || r.ok !== true) {
      const why = '读心跳失败：' + String((r && r.error) || '未知错误').slice(0, 160);
      // ★★ 2026-11-11：账本兜底（默认关，integrations.ledgerFallback 打开）。
      //   它不是为了「心跳坏了也能跑」，是为了「解耦之后不依赖 DSH」。
      //   命中时 source 标成 ledger:last-lead —— 面板与日志能分清这一轮是谁给的答案。
      if (ledgerFallback && ledgerFile && sessionsProvider) {
        let sess = [];
        try { sess = sessionsProvider() || []; } catch { sess = []; }
        const led = leadFromLedger(ledgerFile, sess);
        if (led.ok) {
          last = {
            ok: true, source: TARGET_SOURCE.LEAD, sessionId: led.sessionId,
            candidates: 1, leadSource: led.source, atMs: t, by: led.by, at: led.at,
            why: why + ' → 已由账本兜底（' + led.why + '）',
            endpoint: { source: ep.source, origin: ep.origin, file: ep.file || null },
          };
          log('当前 lead = ' + led.sessionId + '（账本兜底；心跳失败：' + why.slice(0, 60) + '）');
          return last;
        }
        last = failAt(t, why + '；账本兜底也没成：' + led.why);
        return last;
      }
      last = failAt(t, why);
      return last;
    }
    const res = resolveTargetFromHeartbeatPayload(r.data, { atMs: t });
    // ★ endpoint 一并留下（**只有 origin / 来源 / 文件名**，永远没有查询串）：
    //   面板与排障要能回答「这一次到底问的是哪个端口」，而「连不上」和「问错了端口」是两种病。
    last = { ...res, fetchedAtMs: t, endpoint: { source: ep.source, origin: ep.origin, file: ep.file || null } };
    if (res.ok) log('当前 lead = ' + res.sessionId + '（' + (res.leadSource || '来源未标注') + '，候选 ' + res.candidates + '）');
    else log('动态目标解析失败（不动）：' + res.why);
    return last;
  }

  /**
   * 只在真的需要时读：开关关着 / 不推宿主 / 人已经固定指定了目标 —— 一次网络请求都不发。
   * ★ 这不是省流量，是「不动的时候不许有副作用」。
   */
  async function refreshIfNeeded(cfg) {
    const c = cfg || {};
    if (c.enabled !== true) return last;
    if (c.pushToHost === false) return last;
    if (String(c.targetSession == null ? '' : c.targetSession).trim()) return last;
    stats.refreshes++;
    return refresh();
  }

  /** 最近一次解析结果（同步）。新鲜度由 resolveTarget() 判，这里不替它判。 */
  function current() { return last; }

  function state() {
    return {
      ...last, refreshes: stats.refreshes, fetches: stats.fetches,
      // ★ 即使这一次解析失败，也把「刚才想向哪里问」留出来（失败原因里已经含 origin）。
      endpoint: last.endpoint || null,
    };
  }

  return { refresh, refreshIfNeeded, current, state };
}

/**
 * ★★ 2026-11-11（下午自主）：**直读《墨》账本**，作为心跳的兜底 —— 绕开 DSH。
 *
 * ★ 这条改了一个原本明确反对它的决定，所以理由必须写清楚：
 *
 *   **原判据**（见文件头）：「不在 v4 里读 02-墨.jsonl，那是第二套主脑规则，两份实现迟早两个答案。」
 *   那个判断在**v4 还是 DSH 的一个插件**时是对的 —— 同一进程生态里，真源外包给心跳就够了。
 *
 *   **现在的前提变了**：v4 是**独立框架**，要被别的 harness 接进去。
 *   它不能再依赖「DSH 愿意告诉我谁是 lead」—— 否则 heartbeat 插件永远禁不掉，解耦就是空话。
 *
 *   ★ 而这不是「第二套规则」，是**直连同一份数据**：
 *     DSH 的 /heartbeat/auto 本身就是「读账本最后一条 lead + 在活会话里匹配」。
 *     这里做的是同一件事，只是少了转述那一层。
 *
 *   ★ 风险与缓解（必须成对出现，否则就是裸奔）：
 *     · 风险：两边解析出不同答案 → 「投给谁」出现两个结果。
 *     · 缓解：两边都有答案时**交叉比对**，不一致就 warn 并**以账本为准**（它是真源）；
 *       路径读的是**同一个文件**（02-墨.jsonl），不各读各的。
 *
 * ★ 默认**关**（integrations.ledgerFallback=false）。打开它是「准备解耦」，不是「已经解耦」。
 */
const _ledgerCache = new Map();

export function leadFromLedger(ledgerFile, sessions) {
  const file = String(ledgerFile || '');
  if (!file) return { ok: false, why: '没配 ledgerFile' };
  let stat;
  try { stat = fs.statSync(file); } catch { return { ok: false, why: '账本读不到：' + file }; }
  const hit = _ledgerCache.get(file);
  let last = null;
  if (hit && hit.mtimeMs === stat.mtimeMs) {
    last = hit.last;
  } else {
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const ln = lines[i];
        if (!ln || ln.indexOf('"lead"') < 0) continue;
        try {
          const o = JSON.parse(ln);
          if (o && o.type === 'lead') { last = o; break; }
        } catch { /* 坏行跳过，不中断 */ }
      }
      _ledgerCache.set(file, { mtimeMs: stat.mtimeMs, last });
    } catch (e) {
      return { ok: false, why: '账本解析失败：' + String((e && e.message) || e) };
    }
  }
  if (!last) return { ok: false, why: '账本里没有一条 type=lead' };
  const short = String(last.by == null ? '' : last.by).trim();
  if (!short) return { ok: false, why: '最后一条 lead 没有署名（by 空）' };

  const list = Array.isArray(sessions) ? sessions : [];
  const hits = list.filter((s) => String((s && s.id) || '').indexOf(short) >= 0);
  if (!hits.length) {
    return { ok: false, by: short, why: '账本 lead 的署名 ' + short + ' 在本地会话里找不到（共 ' + list.length + ' 个）' };
  }
  if (hits.length > 1) {
    return { ok: false, by: short, why: '署名 ' + short + ' 匹配到 ' + hits.length + ' 个会话，有歧义（fail-closed）' };
  }
  return {
    ok: true,
    sessionId: String(hits[0].id),
    by: short,
    at: last.t || null,
    source: 'ledger:last-lead',
    why: '《墨》最后一条 lead 署名 ' + short,
  };
}

