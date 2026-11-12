// 定点清理（targeted cleanup）—— 「裁剪」只能由宿主做，v4 不许拿自己的容器假装
//
// ★★ 这个模块补的是 D 切片之后仍然留着的一条退路。
//   旧行为是「推不动宿主就 loop.turn(sid) 自己跑」。在自主上它已经删了；
//   在清理上它有同一个形状的变种 —— **内部压缩（compactRange）冒充宿主清理**。
//   两者都「有产物」、都「没报错」，但都不是宿主那边真的发生了什么。
//
// ★ 所以这里的判据只有一条：**成功必须来自宿主回执，而且回执能被逐字核对**。
//   targetSession 对上、opId 对上、起止 seq 对上、影响帧数给了 —— 四样缺一就是失败。
//   ★ 缺 seq 或 target 不匹配时**不许伪造成功**：宁可回 ok:false 并说清缺什么。
//
// ── 目标（2026-11-11 · 接动态 lead）─────────────────────────────
//   ① 调用方显式给的 sessionId / targetSession —— 最具体，也最不会变；
//   ② 固定配置 autonomy.targetSession —— 人钉死的，**同样不请求心跳**；
//   ③ 都没有 → 用**同一个** lead-target 解析器（organs/lead-target.mjs）**现读一次**
//      /heartbeat/auto，取「当前 lead」（交接后就是新 id，不沿用上一次解析的缓存）。
//   ★ 解析不出 / 心跳不可用 / 候选歧义 → no-target，fail-closed，**不派活**。
//   ★ 这里**不读《墨》**：主脑判据只有心跳一处，复制一份就是第二套规则
//     （理由见 lead-target.mjs 头注释 —— 投错没人看得见，停摆反而看得见）。
//   ★ 顺序不是风格：**seq 先判、目标后解析** —— 缺 seq 注定不派活，
//     那就不要为一次不会发生的清理去读一次心跳。

// ★ 为什么本文件**不 import loop / compaction**：
//   不是风格，是结构性的。只要它拿不到这两个东西，就不可能出现
//   「宿主没接 → 我自己压一段 → 然后记一次成功」这条路。
//   一条能走的退路，迟早会被走到。
//
// ── 协议（v4 → 宿主）──────────────────────────────────────────────
//   cap:    'pruner'
//   action: 'targeted-cleanup'
//   args:   { sessionId, targetSession, opId, startSeq, endSeq, reason }
//           ★ sessionId 与 targetSession 同值：前者是通行叫法，后者与自主的目标同名，
//             两个都送，省得宿主那边再猜一次「你说的是哪个会话」。
//   ★ opId 由 **v4 生成并下发**，不是宿主自己编的 —— 回执必须原样带回。
//     这样「这一条回执属于这一次请求」是可核对的，不是靠信任。
//
// ── 回执（宿主 → v4，放 result.data）────────────────────────────
//   {
//     targetSession:  "session-xxx",   // 必填、必须逐字等于请求
//     opId:           "clean-...",     // 必填、必须逐字等于请求
//     startSeq:       100,             // 必填、整数、等于请求
//     endSeq:         180,             // 必填、整数、等于请求
//     framesAffected: 81,              // 必填、整数 >= 0（真的动了几帧）
//     bytesAffected:  1234567,         // 可选：宿主量得出才填，量不出就别填 0
//     at:             "2026-11-10T...",// 可选：宿主那边的时刻；不给就用 v4 收到回执的时刻（会标注）
//   }
//   ★ bytesAffected 不给就是 null，**不补 0** —— 0 和「没量」在界面上必须能分开。
//
// ── 门牌 ────────────────────────────────────────────────────────
//   成功回执一定带 'log:<session>#seq=<startSeq>'（并在 coverage 里写覆盖到哪），
//   可直接喂给 soul_open / Query.open()。取不到 seq 就不会有成功回执 —— 这是设计。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveTarget, TARGET_SOURCE } from './lead-target.mjs';

export const CLEANUP_CAP = 'pruner';
export const CLEANUP_ACTION = 'targeted-cleanup';
export const CLEANUP_FILE = 'cleanup-receipts.json';
export const CLEANUP_HISTORY_MAX = 20;

/** 目标来源的词。★ 写进回执，事后才分得清「投错了」还是「人改过配置」。
 *  第三级（heartbeat-lead）的词由 lead-target 的 TARGET_SOURCE 给，这里不另起一套。 */
export const SOURCE_CALLER = 'caller';
export const SOURCE_FIXED = 'autonomy.targetSession';

/** 回执落在 <dataDir> —— 隔离实例自然落在隔离根下，不会碰生产 data。 */
export function cleanupFileOf(dataDir) {
  const d = String(dataDir == null ? '' : dataDir).trim();
  return d ? path.join(d, CLEANUP_FILE) : null;
}

function newOpId(nowMs) {
  return 'clean-' + Number(nowMs).toString(36) + '-' + crypto.randomBytes(3).toString('hex');
}

function seqOf(v) {
  if (v === null || v === undefined || v === '') return NaN;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : NaN;
}

/** 门牌 + 覆盖范围。★ startSeq 必须是回执里那个真数，不许拿请求里的值顶替。 */
export function pointerOf(sessionId, startSeq, endSeq) {
  const sid = String(sessionId == null ? '' : sessionId).trim();
  if (!sid || !Number.isInteger(startSeq)) return null;
  return {
    pointer: 'log:' + sid + '#seq=' + startSeq,
    coverage: Number.isInteger(endSeq) ? 'seq ' + startSeq + '–' + endSeq : 'seq ' + startSeq,
  };
}

/** 调用方显式给的目标。★ 两个名字都送且不一致 = 不替你选。纯函数，不碰网络/磁盘。 */
export function callerTargetOf(input) {
  const a = input || {};
  const callerSid = String(a.sessionId == null ? '' : a.sessionId).trim();
  const callerTarget = String(a.targetSession == null ? '' : a.targetSession).trim();
  if (callerSid && callerTarget && callerSid !== callerTarget) {
    return {
      ok: false, stage: 'bad-request', sessionId: null, source: null,
      reason: 'sessionId 与 targetSession 不一致（' + callerSid + ' / ' + callerTarget + '）—— 不替你选一个',
    };
  }
  const explicit = callerSid || callerTarget;
  return explicit
    ? { ok: true, stage: null, sessionId: explicit, source: SOURCE_CALLER, reason: '' }
    : { ok: false, stage: null, sessionId: null, source: null, reason: '' };
}

/** 起止 seq 的形状判定。纯函数 —— 目标还没解析就能用它判「这一次注定不派活」。 */
export function seqRangeOf(input) {
  const a = input || {};
  const startSeq = seqOf(a.startSeq);
  const endSeq = seqOf(a.endSeq);
  if (!Number.isInteger(startSeq) || !Number.isInteger(endSeq)) {
    return {
      ok: false, stage: 'no-seq',
      reason: '没有可核对的起止 seq（startSeq=' + JSON.stringify(a.startSeq) + ' / endSeq=' + JSON.stringify(a.endSeq) + '）',
    };
  }
  if (startSeq > endSeq) {
    return { ok: false, stage: 'bad-request', reason: 'startSeq > endSeq（' + startSeq + ' > ' + endSeq + '）' };
  }
  return { ok: true, stage: null, startSeq, endSeq, reason: '' };
}

/**
 * 把调用方的入参归一成一个**可核对**的请求。
 *
 * ★ 目标三级（顺序是语义，不是风格）：
 *   ① 调用方显式给的 sessionId / targetSession；
 *   ② 固定配置 autonomy.targetSession；
 *   ③ 都没有 → 用**同一个** lead-target 解析器解析出的当前 lead。
 *      dynamic 参数就是那一次解析的结果，由 run() 现读一次心跳后传进来 ——
 *      本函数**不发请求、不读《墨》**：解析只有一处（心跳），这里只负责「用哪个 id」。
 * ★ 解析不出来（dynamic 不 ok / 没传）→ no-target，fail-closed，**不挑一个「最近的会话」凑数**。
 * ★ seq 必须由调用方给，且**先于目标解析判**：不给 seq 就没法核对宿主回执，
 *   而缺 seq 的那一次注定不派活 —— 不该为它去读一次心跳。
 */
export function normalizeCleanupRequest(input, cfg, nowMs, dynamic) {
  const a = input || {};
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();

  const ct = callerTargetOf(input);
  // ★ 调用方自己给的两个人名打架 —— 与有没有 seq 无关，先拒（不替你选一个）
  if (ct.stage === 'bad-request') return { ok: false, stage: 'bad-request', reason: ct.reason };
  const fixed = String((cfg && cfg.targetSession) || '').trim();

  // ① seq 先判（缺 seq / 反序 = 这一次注定不派活）
  const range = seqRangeOf(input);
  if (!range.ok) {
    return {
      ok: false, stage: range.stage, reason: range.reason,
      sessionId: ct.ok ? ct.sessionId : (fixed || null),
      targetSource: ct.ok ? ct.source : (fixed ? SOURCE_FIXED : null),
    };
  }

  // ② 目标三级
  let sessionId = ct.ok ? ct.sessionId : '';
  let targetSource = ct.ok ? ct.source : null;
  if (!sessionId && fixed) { sessionId = fixed; targetSource = SOURCE_FIXED; }
  let targetWhy = null;
  if (!sessionId) {
    const r = resolveTarget({ config: cfg || {}, dynamic: dynamic || null, nowMs: now });
    const id = r.ok === true && r.sessionId != null ? String(r.sessionId).trim() : '';
    if (id) { sessionId = id; targetSource = r.source || TARGET_SOURCE.LEAD; }
    else targetWhy = String(r.why || '解析不到当前 lead').slice(0, 300);
  }
  if (!sessionId) {
    return {
      ok: false, stage: 'no-target', targetSource: targetSource || TARGET_SOURCE.LEAD, targetWhy,
      reason: '没有目标会话：调用方没给 sessionId，autonomy.targetSession 也是空的，'
        + '并且解析不到当前 lead' + (targetWhy ? '（' + targetWhy + '）' : '') + ' —— fail-closed',
    };
  }

  const opId = String(a.opId == null ? '' : a.opId).trim() || newOpId(now);
  return {
    ok: true,
    request: {
      sessionId, targetSource, startSeq: range.startSeq, endSeq: range.endSeq, opId,
      reason: String(a.reason == null ? '' : a.reason).slice(0, 200),
      at: now,
    },
  };
}

/**
 * 核对宿主回执。**所有失败都带 stage**（与自主投递的 stage 词汇同构，排障时读一份就够）。
 */
export function judgeCleanupReceipt({ data, request, nowMs }) {
  const req = request || {};
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const bad = (stage, reason) => ({ ok: false, stage, reason });

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return bad('bad-receipt', '宿主回执不是对象（拿到 ' + (data === null ? 'null' : typeof data) + '）');
  }

  const target = String(data.targetSession == null ? '' : data.targetSession).trim();
  if (!target) return bad('bad-receipt', '回执缺 targetSession —— 证明不了这次清理落在哪个会话');
  const want = String(req.sessionId == null ? '' : req.sessionId).trim();
  if (target !== want) {
    return { ok: false, stage: 'target-mismatch', target, reason: '回执的 targetSession（' + target + '）与请求目标（' + want + '）不一致 —— 不认这次清理' };
  }

  const opId = String(data.opId == null ? '' : data.opId).trim();
  if (!opId) return bad('bad-receipt', '回执缺 opId —— 这一条回执无法归属于某一次请求');
  if (opId !== String(req.opId || '')) return bad('opid-mismatch', '回执的 opId（' + opId + '）与请求（' + req.opId + '）不一致');

  const startSeq = seqOf(data.startSeq);
  const endSeq = seqOf(data.endSeq);
  if (!Number.isInteger(startSeq) || !Number.isInteger(endSeq)) {
    return bad('no-seq', '回执缺真实起止 seq（startSeq=' + JSON.stringify(data.startSeq) + ' / endSeq=' + JSON.stringify(data.endSeq) + '）—— 缺 seq 不能算成功');
  }
  if (startSeq !== req.startSeq || endSeq !== req.endSeq) {
    return bad('seq-mismatch', '回执的 seq 范围（' + startSeq + '–' + endSeq + '）与请求（' + req.startSeq + '–' + req.endSeq + '）不一致');
  }

  const frames = Number(data.framesAffected);
  if (!Number.isInteger(frames) || frames < 0) {
    return bad('bad-receipt', '回执缺影响帧数（framesAffected=' + JSON.stringify(data.framesAffected) + '）');
  }

  let bytes = null;
  if (data.bytesAffected !== undefined && data.bytesAffected !== null) {
    const b = Number(data.bytesAffected);
    if (!Number.isInteger(b) || b < 0) return bad('bad-receipt', '回执的 bytesAffected 不是非负整数（' + JSON.stringify(data.bytesAffected) + '）');
    bytes = b;
  }

  // ★ 宿主给的时刻优先；它不给就用我们收到回执的时刻，但**标明来源**。
  //   两种时间不该长得一样 —— 一个是「它说的」，一个是「我看见的」。
  let at = now, atSource = 'v4-receive';
  if (data.at !== undefined && data.at !== null && data.at !== '') {
    const t = Date.parse(String(data.at));
    if (Number.isFinite(t)) { at = t; atSource = 'host'; }
    else return bad('bad-receipt', '回执的 at 不是可解析时间（' + String(data.at).slice(0, 40) + '）');
  }

  const ptr = pointerOf(target, startSeq, endSeq);
  return {
    ok: true,
    receipt: {
      targetSession: target,
      opId,
      startSeq, endSeq,
      framesAffected: frames,
      bytesAffected: bytes,
      at: new Date(at).toISOString(),
      atMs: at,
      atSource,
      pointer: ptr.pointer,
      coverage: ptr.coverage,
    },
  };
}

/** 从 hub.exec 的异常里给出机器可读阶段（与 autonomy-host.stageOfError 同一套词）。 */
function stageOfError(e) {
  const msg = String((e && e.message) || e);
  if (e && e.hint === 'stub_declared') return 'stub';
  // ★ 2026-11-11（F1 闭环）：宿主可以用稳定的 `[stage:<code>]` 前缀**自报**阶段
  //   （dsh-agent-soul-bridge 的失败回执现在就这么带）。机器可读的声明优先于人话正则 ——
  //   否则 no-target / no-pruner / opid-reused 这些词只会被记成 transport-error。
  //   词表由宿主侧封闭为 [a-z][a-z0-9-]{0,39}；这里只做形状校验，不改写它的结论。
  const own = /^\[stage:([a-z][a-z0-9-]{0,39})\]/.exec(msg);
  if (own) return own[1];
  if (/超时|timeout/i.test(msg)) return 'timeout';
  if (/宿主不在|没有能力/.test(msg)) return 'no-host';
  return 'transport-error';
}

/** 读回执账（状态台 / API / 自检共用这一份读法）。 */
export function readCleanupState(opts) {
  const o = opts || {};
  const file = cleanupFileOf(o.dataDir);
  const empty = { ok: false, file, mtimeMs: null, updatedAt: null, last: null, history: [], why: null };
  if (!file) return { ...empty, why: '没有 dataDir —— 回执没地方落' };
  let st = null;
  try { st = fs.statSync(file); } catch { return { ...empty, why: '还没有回执文件（这台实例从未调用过定点清理）' }; }
  let doc = null;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return { ...empty, mtimeMs: st.mtimeMs, why: '回执文件读不出来：' + String((e && e.message) || e) }; }
  const history = Array.isArray(doc && doc.history) ? doc.history : [];
  return {
    ok: true, file, mtimeMs: st.mtimeMs,
    updatedAt: doc && doc.updatedAt ? doc.updatedAt : null,
    last: (doc && doc.last) || history[0] || null,
    history,
    why: null,
  };
}

/**
 * 造一个定点清理器官。
 *
 * @param {object} o
 *   control   —— ControlHub（canDo / exec / snapshot）；没有就一律失败，不许自跑
 *   autonomy  —— Autonomy 实例（只为读 config.targetSession 这个**固定覆盖**）
 *   leadTarget —— **同一个** lead-target 解析器（index.mjs 里与自主共用的那个实例）；
 *                 只在「既没显式目标、也没固定目标」时才用，而且调的是 refresh()（现读一次），
 *                 不是 current()（读缓存）—— 读缓存等于让「上一次的 lead」冒充这一次的目标。
 *   dataDir   —— 回执落盘目录（隔离实例 = 隔离根）
 *   clock / timeoutMs / log —— 测试可注入
 */
export function createTargetedCleanup(o) {
  const opt = o || {};
  const control = opt.control || null;
  const autonomy = opt.autonomy || null;
  const leadTarget = opt.leadTarget || null;
  const dataDir = opt.dataDir || null;
  const clock = typeof opt.clock === 'function' ? opt.clock : () => Date.now();
  const timeoutMs = Number.isFinite(opt.timeoutMs) ? opt.timeoutMs : 15000;
  const log = typeof opt.log === 'function' ? opt.log : () => {};
  const file = cleanupFileOf(dataDir);
  let lastWriteError = null;

  function persist(rec) {
    if (!file) return { persisted: false, error: '没有 dataDir' };
    try {
      const prev = readCleanupState({ dataDir });
      const history = [rec].concat(prev.ok ? prev.history : []).slice(0, CLEANUP_HISTORY_MAX);
      const doc = { version: 1, updatedAt: rec.at, last: rec, history };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
      fs.renameSync(tmp, file);
      lastWriteError = null;
      return { persisted: true, error: null };
    } catch (e) {
      // ★ 回执写不进去不许把「宿主那边真的清理了」改判成失败 —— 但必须说出来。
      lastWriteError = String((e && e.message) || e);
      return { persisted: false, error: lastWriteError };
    }
  }

  function finish(rec) {
    const p = persist(rec);
    return { ...rec, receiptPersisted: p.persisted, receiptFile: file, ...(p.error ? { receiptError: p.error } : {}) };
  }

  function fail(req, stage, reason, extra) {
    const now = clock();
    const rec = {
      ok: false, stage, reason: String(reason || '').slice(0, 400),
      opId: req && req.opId ? req.opId : null,
      at: new Date(now).toISOString(),
      targetSession: req && req.sessionId ? req.sessionId : (extra && extra.targetSession) || null,
      targetSource: (req && req.targetSource) ? req.targetSource : ((extra && extra.targetSource) || null),
      // ★ no-target 时 dyn 解析为什么失败要留下 —— 否则面板上只有一句「没有目标会话」，
      //   而真正的原因（没配地址 / 没主导 / 旧版心跳 / 歧义）被丢掉了。
      targetWhy: (extra && extra.targetWhy) || null,
      startSeq: req && Number.isInteger(req.startSeq) ? req.startSeq : null,
      endSeq: req && Number.isInteger(req.endSeq) ? req.endSeq : null,
      pointer: req && Number.isInteger(req.startSeq) ? pointerOf(req.sessionId, req.startSeq, req.endSeq)?.pointer || null : null,
      host: (extra && extra.host) || null,
      hostId: (extra && extra.hostId) || null,
      elapsedMs: extra && Number.isFinite(extra.elapsedMs) ? extra.elapsedMs : null,
      receipt: null,
    };
    log('定点清理失败 [' + stage + ']：' + rec.reason);
    return finish(rec);
  }

  async function run(input) {
    const t0 = clock();
    const now = t0;
    const cfg = (autonomy && autonomy.config) || {};

    // ★★★ 2026-11-11（动态目标接进 cleanup）：三级目标里的第三级必须**现读一次**心跳。
    //   发请求的判据只有一条：① 调用方没给目标 ② 也没固定目标 ③ seq 齐（否则注定不派活）。
    //   其它情况**一次网络请求都不发** —— 与自主那边同一条规矩：不动的时候不许有副作用。
    const ct = callerTargetOf(input);
    const range = seqRangeOf(input);
    const needDynamic = ct.ok !== true && ct.stage !== 'bad-request'
      && !String(cfg.targetSession == null ? '' : cfg.targetSession).trim()
      && range.ok === true;

    let dynamic = null;
    if (needDynamic) {
      if (leadTarget && typeof leadTarget.refresh === 'function') {
        try { dynamic = await leadTarget.refresh(); }
        catch (e) {
          dynamic = {
            ok: false, source: TARGET_SOURCE.LEAD, sessionId: null, atMs: now,
            why: '读心跳抛异常：' + String((e && e.message) || e).slice(0, 160),
          };
        }
        if (dynamic && dynamic.ok === true) {
          log('目标来自当前 lead：' + dynamic.sessionId + '（' + (dynamic.leadSource || '来源未标注')
            + '，候选 ' + (dynamic.candidates == null ? '?' : dynamic.candidates) + '）');
        } else {
          log('动态目标解析不出（fail-closed，不动）：' + String((dynamic && dynamic.why) || '未给原因'));
        }
      } else {
        // ★ 没接解析器 = 解析不出。**不自己读《墨》兜底** —— 那会长出第二套主脑规则。
        log('没有接 lead 解析器（leadTarget）—— 留空就解析不出，按 fail-closed 处理');
      }
    }

    const norm = normalizeCleanupRequest(input, cfg, now, dynamic);
    if (!norm.ok) {
      return fail(null, norm.stage, norm.reason, {
        targetSession: norm.sessionId || null,
        targetSource: norm.targetSource || null,
        targetWhy: norm.targetWhy || null,
      });
    }
    const req = norm.request;
    // ★ 单次超时可以被调用方收紧（100ms–120s），但**不可能取消超时** —— 没有超时的 host RPC
    //   等于「永远挂着的等待」，而挂着的等待在下游看起来和成功前一刻一模一样。
    const execTimeoutMs = Number.isFinite(input && input.timeoutMs)
      ? Math.max(100, Math.min(120000, Number(input.timeoutMs)))
      : timeoutMs;

    if (!control || typeof control.exec !== 'function') {
      return fail(req, 'no-control', '没有控制通道（control hub 没接）—— 定点清理只能由宿主执行，不自跑');
    }

    const snap = typeof control.snapshot === 'function' ? control.snapshot() : [];
    const connected = snap.filter((h) => h && h.host && h.host !== '(未 hello)');
    const able = typeof control.canDo === 'function'
      ? control.canDo(CLEANUP_CAP)
      : connected.filter((h) => (h.caps || []).includes(CLEANUP_CAP) && !(h.stubs || []).includes(CLEANUP_CAP));

    if (!able.length) {
      const claimed = connected.filter((h) => (h.caps || []).includes(CLEANUP_CAP));
      const stubbed = claimed.filter((h) => (h.stubs || []).includes(CLEANUP_CAP));
      if (claimed.length && stubbed.length === claimed.length) {
        return fail(req, 'stub', '连着的宿主都声明 ' + CLEANUP_CAP + ' 是桩（' + stubbed.map((h) => h.host).join(',') + '）—— 能力在、路没通，不派、不自跑', { host: stubbed[0].host, hostId: stubbed[0].id });
      }
      return fail(req, 'no-host', '没有能接 ' + CLEANUP_CAP + ' 的宿主（连着 ' + connected.length + ' 个）—— 不自跑、不用内部压缩冒充');
    }

    // ★ 新连上的优先（与自主投递、面板投递同一规则：有新鲜 state 的更可能活着）。
    const peers = able.slice().sort((a, b) => String(b.connectedAt || '').localeCompare(String(a.connectedAt || '')));
    const peer = peers[0];

    const args = {
      sessionId: req.sessionId,
      targetSession: req.sessionId,
      opId: req.opId,
      startSeq: req.startSeq,
      endSeq: req.endSeq,
      ...(req.reason ? { reason: req.reason } : {}),
    };

    let data;
    try {
      data = await control.exec(peer.id, CLEANUP_CAP, CLEANUP_ACTION, args, execTimeoutMs);
    } catch (e) {
      return fail(req, stageOfError(e), String((e && e.message) || e), {
        host: peer.host, hostId: peer.id, elapsedMs: clock() - t0,
      });
    }

    const judged = judgeCleanupReceipt({ data, request: req, nowMs: clock() });
    if (!judged.ok) {
      return fail(req, judged.stage, judged.reason, {
        host: peer.host, hostId: peer.id, elapsedMs: clock() - t0,
      });
    }

    const r = judged.receipt;
    const rec = {
      ok: true, stage: 'cleaned',
      opId: r.opId,
      at: r.at, atSource: r.atSource,
      targetSession: r.targetSession,
      targetSource: req.targetSource,
      startSeq: r.startSeq, endSeq: r.endSeq,
      framesAffected: r.framesAffected,
      bytesAffected: r.bytesAffected,
      pointer: r.pointer,
      coverage: r.coverage,
      host: peer.host, hostId: peer.id,
      cap: CLEANUP_CAP, action: CLEANUP_ACTION,
      reason: req.reason || '',
      elapsedMs: clock() - t0,
      receipt: {
        targetSession: r.targetSession, opId: r.opId,
        startSeq: r.startSeq, endSeq: r.endSeq,
        framesAffected: r.framesAffected, bytesAffected: r.bytesAffected,
        at: r.at, atSource: r.atSource,
      },
    };
    log('定点清理成功 → ' + peer.host + ' / ' + r.targetSession + '（目标来源：' + req.targetSource + '）' + r.coverage +
      '（' + r.framesAffected + ' 帧' + (r.bytesAffected === null ? '' : ' / ' + r.bytesAffected + ' B') + '）· ' + r.pointer);
    return finish(rec);
  }

  return { run, file, lastWriteError: () => lastWriteError };
}
