// 自主投递 —— 「该动了」之后，**只走宿主**，并且要回执
//
// ★★ 2026-11-10 D 切片：这个文件取代了 index.mjs 里那段「先问宿主、推不动就 loop.turn(sid)」。
//
//   旧行为有三个洞，都是「看起来在工作」：
//     ① 没有目标时 autonomySessionId() 会**新建一个叫 autonomy 的会话** ——
//        于是「自主」有了自己的容器，而那从来不是任何人指定的目标；
//     ② hub.exec resolve 就记一次 recordRun —— 但 resolve 只证明宿主回了一帧 result，
//        不证明话真的进了某个会话（「RPC 成功」≠「投递成功」，第十轮已经在面板那条路上修过）；
//     ③ 推失败就 loop.turn(sid) 自己跑，还照样 recordRun ——
//        那既是「伪报」，也是「拿自己的容器假装是宿主」。
//
//   现在：
//     · 目标唯一：autonomy.config.targetSession（留空 = 不下发）；
//     · 只调 control 的 followup，**没有宿主就不动**，不自跑、不编一个会话；
//     · 回执必须 delivered===true 且 target 与 targetSession **逐字相等**，才 recordRun / markWoken；
//     · 失败不扣预算、不标已叫醒，只记一次尝试 + 指数退避（60 秒 tick 不会变成 3 分钟三次）。
//
// ★ 为什么「退避」是必须的而不是优化：sched 每 60 秒 tick 一次，maxWake=3 的 markWoken
//   在旧路径上恰好三次就判 stuck —— 失败时也在推进，于是「叫不醒」被记成「叫过了」。
//   保留待办 + 退避，才让「没投成」在台账里仍是待办。

import { autonomousPrompt, PHASE } from './autonomy.mjs';
import { buildWakeText } from './waker.mjs';
import { judgeFollowupReceipt } from './guard.mjs';

/**
 * 从控制通道快照里挑「目标会话最后一次被宿主上报」的时刻。
 *
 * ★ 只认 state.sessionId === targetSession 的宿主上报；**不认任何其它会话**。
 *   多个宿主都报同一个会话时取最新的那一条（同一个人在两台机器上，取最近说话的那台）。
 * ★ 拿不到就 ok:false —— 调用方必须把 UNKNOWN 当成「不动」，不许当成「人不在」。
 *
 * @param {Array} hosts control.snapshot() 的结果
 * @param {string} targetSession
 * @param {number} nowMs
 */
export function pickHostActivity(hosts, targetSession, nowMs, opts) {
  const wanted = String(targetSession == null ? '' : targetSession).trim();
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (!wanted) return { ok: false, why: '没有 targetSession', targetSession: null };
  const list = Array.isArray(hosts) ? hosts : [];
  // ★★ 2026-11-11（实测暴露的接口缺口）：bridge 上报的 state 帧**不带 sessionId**，
  //   而这里按 sessionId 精确匹配 —— 于是「人不在」这条判据永远返回 UNKNOWN，
  //   autonomy 打开后也只能停在 unknown（实测：state 里只有 contextTokens/turnId/at）。
  //
  //   ★ 正确解是**bridge 补上 sessionId**（DSH 侧插件改动，要重启 DSH，只有爀曦能做）。
  //   ★ 这里给的只是**可配置兜底**，默认关闭 —— 因为「拿 A 的活跃去判 B 的静默」是真的会误判，
  //     而误判的后果是它在你正跟它说话的时候自己动。**宁可不动，不可乱动。**
  //   兜底条件很窄：显式打开 + 宿主没报 sessionId + 只有唯一一个 host。
  const allowSessionless = !!(opts && opts.allowSessionless);

  let best = null;
  for (const h of list) {
    const st = h && h.state;
    if (!st) continue;
    const sid = String(st.sessionId == null ? '' : st.sessionId).trim();
    if (sid !== wanted) {
      const canFallback = allowSessionless && !sid && list.length === 1;
      if (!canFallback) continue;
    }
    // ★ 优先用「v4 收到这条 state 的时刻」（自己的钟），宿主自报的 at 只作展示：
    //   两台机器的钟不保证同源，而静默判定的两分钟误差就足以让一次自主提前/延后。
    // ★★ 2026-11-11 根因（查了四轮才到这里）：`hub.snapshot()` 把 `h.state.at` 放进 `atMs` 字段，
    //   而那个值**可能是 ISO 字符串**。这里原来用 `Number.isFinite(st.atMs)` 判它，
    //   字符串一律 false → 退回 `Date.parse(st.at)` —— 而 snapshot 里**根本没有 at 字段**
    //   → NaN → continue → 一个宿主都匹配不上 → 「没有宿主上报过这个会话的 state」。
    //   **判据本身没错，是它读的那个字段名与上游给的不一致。**
    //   现在三种形状都认：数字 / 数字字符串 / ISO 字符串。
    let atMs = st.atMs;
    if (typeof atMs === 'string') atMs = atMs.trim() === '' ? NaN : Number(atMs);
    if (!Number.isFinite(atMs)) {
      const raw = st.at != null ? st.at : st.atMs;
      atMs = raw == null ? NaN : Date.parse(String(raw));
    }
    if (!Number.isFinite(atMs)) continue;
    if (!best || atMs > best.atMs) {
      best = {
        atMs,
        at: new Date(atMs).toISOString(),
        host: h.host || null,
        hostId: h.id || null,
        sessionId: st.sessionId == null ? (allowSessionless ? wanted : null) : st.sessionId,
        sessionless: st.sessionId == null,
      };
    }
  }

  if (!best) {
    return {
      ok: false,
      why: '没有宿主上报过这个会话的 state（sessionId=' + wanted + '）',
      targetSession: wanted,
    };
  }
  return {
    ok: true,
    minutes: Math.max(0, (now - best.atMs) / 60000),
    lastActivityAt: new Date(best.atMs).toISOString(),
    ...best,
    targetSession: wanted,
  };
}

/** 指数退避：第 1 次失败等 base，之后翻倍，封顶 max。 */
export function backoffMs(fails, baseMs, maxMs) {
  const n = Math.max(1, Math.floor(Number(fails) || 1));
  const base = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : 120000;
  const cap = Number.isFinite(maxMs) && maxMs > 0 ? maxMs : 900000;
  return Math.min(base * Math.pow(2, n - 1), cap);
}

/** 从 hub.exec 的异常里给出机器可读的阶段（与 guard 的 stage 词同构）。 */
function stageOfError(e) {
  const msg = String((e && e.message) || e);
  if (e && e.hint === 'stub_declared') return 'stub';
  if (/超时|timeout/i.test(msg)) return 'timeout';
  if (/宿主不在|没有能力/.test(msg)) return 'no-host';
  return 'transport-error';
}

/** 能接 followup 的宿主：优先用 hub.canDo（它会滤掉 hello.meta.stubs 里声明的桩）。 */
function followupPeers(control) {
  if (!control) return [];
  if (typeof control.canDo === 'function') {
    return control.canDo('followup').map((h) => ({
      id: h.id, host: h.host, connectedAt: h.at ? new Date(h.at).toISOString() : '',
    }));
  }
  if (typeof control.snapshot === 'function') {
    return (control.snapshot() || [])
      .filter((h) => (h.caps || []).includes('followup') && !(h.stubs || []).includes('followup'))
      .map((h) => ({ id: h.id, host: h.host, connectedAt: h.connectedAt || '' }));
  }
  return [];
}

/**
 * 造一个「自主投递器」。
 *
 * @param {object} opts
 *   autonomy  —— Autonomy 实例（只读判定 + 成功时记预算）
 *   ledger    —— 唤醒台账（有 views()/markWoken() 就用；没有就跳过待办分支）
 *   control   —— ControlHub（canDo/snapshot/exec）
 *   timeoutMs —— 等回执的超时；测试可以调到几十毫秒
 *   clock     —— 注入时间（测试用）
 *   log       —— 可选日志
 * @returns {{tick:Function, retry:object, state:Function}}
 */
export function createHostAutonomy(opts) {
  const o = opts || {};
  const autonomy = o.autonomy;
  const ledger = o.ledger || null;
  const control = o.control || null;
  const clock = typeof o.clock === 'function' ? o.clock : () => Date.now();
  const timeoutMs = Number.isFinite(o.timeoutMs) ? o.timeoutMs : 20000;
  const log = typeof o.log === 'function' ? o.log : () => {};

  // ★ 退避状态放内存：重启后从「可以再试」开始是安全的（最多多试一次），
  //   而持久化它会让一次失败的旧账拖住新进程。
  const retry = { fails: 0, nextAt: 0, lastStage: null, lastReason: null };

  function snapshotRetry() {
    return { ...retry, waitMs: retry.nextAt > 0 ? Math.max(0, retry.nextAt - clock()) : 0 };
  }

  function fail(now, stage, reason, extra) {
    retry.fails++;
    const baseMs = (autonomy.config.retryBackoffSeconds || 120) * 1000;
    const maxMs = (autonomy.config.retryBackoffMaxSeconds || 900) * 1000;
    retry.nextAt = now + backoffMs(retry.fails, baseMs, maxMs);
    retry.lastStage = stage;
    retry.lastReason = String(reason || '').slice(0, 300);
    autonomy.recordAttempt({
      at: now,
      outcome: 'failed',
      stage,
      reason,
      host: extra && extra.host,
      target: extra && extra.target,
      // ★ 2026-11-11：这一次的目标是从哪来的（fixed / heartbeat-lead）—— 交接能不能被查出来靠它。
      source: extra && extra.source,
      kind: extra && extra.kind,
      key: extra && extra.key,
    });
    log('自主投递失败 [' + stage + ']：' + reason + '（退避 ' + Math.round((retry.nextAt - now) / 1000) + 's）');
    return {
      acted: false, ok: false, delivered: false,
      phase: PHASE.AUTONOMOUS, stage,
      reason: String(reason || '').slice(0, 300),
      retry: snapshotRetry(),
    };
  }

  async function tick() {
    const now = clock();
    const c = autonomy.check(now);

    // ★ 不是「该动了」就什么都不做 —— 尤其 UNKNOWN：不猜、不写、不投。
    if (c.phase !== PHASE.AUTONOMOUS) {
      return { acted: false, ok: false, delivered: false, phase: c.phase, reason: c.reason, retry: snapshotRetry() };
    }

    // ★ 退避中：连宿主都不问。否则「重试」只是换了个名字的紧密循环。
    if (retry.nextAt > now) {
      return {
        acted: false, ok: false, delivered: false, phase: 'backoff',
        reason: '退避中，还有 ' + Math.ceil((retry.nextAt - now) / 1000) + ' 秒（上次 ' + retry.lastStage + '）',
        retry: snapshotRetry(),
      };
    }

    // ★ 2026-11-11：目标来源（fixed / heartbeat-lead）跟着这一次 tick 走，
    //   后面三处 recordAttempt 都记它 —— 否则出了事分不清「投错了」还是「人改过配置」。
    const targetSource = c.targetSource || null;
    const target = String(c.targetSession || '').trim();
    // decidePhase 已在 target 为空时回 UNKNOWN；这里是第二道锁（不许绕过判定直接投）。
    // ★ 2026-11-11：letHostPick 打开时，没有 target 也放行 —— 由 bridge 自己挑 live root。
    const letHostPick = !!(autonomy.config && autonomy.config.letHostPick);
    if (!target && !letHostPick) return fail(now, 'no-target', '没有 targetSession 也解析不到当前 lead（fail-closed）', { source: targetSource });

    const peers = followupPeers(control);
    if (!peers.length) {
      return fail(now, 'no-host', '没有能接 followup 的宿主（连不上 / 能力是桩）—— 不自跑、不扣预算', { source: targetSource });
    }
    // ★ 新连上的优先（与 guard.deliverPanelNotice 一致）；多个宿主时 target 仍只有一个。
    peers.sort((a, b) => String(b.connectedAt || '').localeCompare(String(a.connectedAt || '')));
    const peer = peers[0];

    // ① 台账里「已叫过但没人判」的，先投它 —— 这样失败时会保留在 act 视图里。
    let rec = null;
    if (ledger && typeof ledger.views === 'function') {
      try {
        const v = ledger.views();
        rec = (v.act && v.act[0]) || null;
      } catch { rec = null; }
    }

    const kind = rec ? 'waker' : 'autonomy';
    const text = rec
      ? buildWakeText(rec, {})
      : autonomousPrompt(c, { threshold: autonomy.config.idleThresholdMinutes });

    const args = { text, why: kind === 'waker' ? 'waker' : 'autonomy', idleMinutes: c.idleMinutes };
    if (target) args.sessionId = target;

    let data;
    try {
      data = await control.exec(peer.id, 'followup', 'say', args, timeoutMs);
    } catch (e) {
      return fail(now, stageOfError(e), String((e && e.message) || e), {
        host: peer.host, target, kind, key: rec ? rec.key : null, source: targetSource,
      });
    }

    // ② ★★ 回执真相：与面板通知同一份判据（guard.judgeFollowupReceipt）。
    // ★ letHostPick 时不校验 expectTarget —— 宿主挑的就是对的（它挑完会在回执里说投给了谁）。
    //   这和「降低标准」不是一回事：**标准从「我猜的目标」换成了「宿主报的目标」**，后者才是真值。
    const judged = judgeFollowupReceipt({ data, expectTarget: letHostPick ? null : target });
    if (!judged.ok) {
      return fail(now, judged.stage, judged.reason, {
        host: peer.host, target: judged.target || target, kind, key: rec ? rec.key : null, source: targetSource,
      });
    }

    // ③ 到这里才是「投到了」。
    if (rec && ledger && typeof ledger.markWoken === 'function') {
      try { ledger.markWoken(rec.key, 3); } catch { /* 台账写不进去不许毁掉已成立的投递 */ }
    }
    autonomy.recordRun(now);
    autonomy.recordAttempt({
      at: now,
      outcome: 'delivered',
      stage: 'delivered',
      reason: 'host-confirmed',
      host: peer.host,
      target: judged.target,
      source: targetSource,
      kind,
      key: rec ? rec.key : null,
    });
    retry.fails = 0;
    retry.nextAt = 0;
    retry.lastStage = null;
    retry.lastReason = null;
    log('自主投递成功 → ' + peer.host + ' / ' + target + '（' + kind + '）');

    return {
      acted: true, ok: true, delivered: true,
      phase: PHASE.AUTONOMOUS, stage: 'delivered',
      host: peer.host, target: judged.target, kind,
      key: rec ? rec.key : null,
      retry: snapshotRetry(),
    };
  }

  return { tick, retry, state: snapshotRetry };
}
