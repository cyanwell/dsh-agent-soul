import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore } from '../src/session/store.mjs';
import { idleMinutes, decidePhase, autonomousPrompt, Autonomy, PHASE, DEFAULT_AUTONOMY } from '../src/organs/autonomy.mjs';
import { resolveTarget, resolveTargetFromHeartbeatPayload, createLeadTargetResolver } from '../src/organs/lead-target.mjs';
import { ROOT } from '../src/config.mjs';

const ok = []; const bad = [];
const push = (n, c, e) => (c ? ok : bad).push((c ? '✓ ' : '✗ ') + n + (e ? '  → ' + e : ''));

// ★★ 2026-11-10（E/F 切片的顺手修复）：这里原来写 path.join(ROOT, 'data', 'autonomy-<ts>')。
//   ROOT 是**仓库根**（不是 AGENT_SOUL_HOME），于是这条自检每次都往**生产 data/** 里造一个会话目录，
//   再在末尾 rmSync 掉 —— 跑崩在中间就留一份垃圾，而且「测试不碰生产数据」这句话当场就不成立。
//   现在：系统临时目录 + realpath 断言。逻辑一个字没改，改的只是「这些帧写在哪」。
const TMP_ROOT = fs.realpathSync(os.tmpdir());
const DATA = fs.mkdtempSync(path.join(TMP_ROOT, 'agent-soul-autonomy-'));
{
  const real = fs.realpathSync(DATA);
  const prodData = (() => { try { return fs.realpathSync(path.join(ROOT, 'data')); } catch { return path.join(ROOT, 'data'); } })();
  const underTmp = real === TMP_ROOT || real.startsWith(TMP_ROOT + path.sep);
  const underProd = real === prodData || real.startsWith(prodData + path.sep);
  if (!underTmp || underProd) {
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
    throw new Error('自检的临时目录不在 os.tmpdir() 下（或落进了生产 data/）：' + real);
  }
}
const store = new SessionStore(DATA);
store.create(ROOT, null, { id: 'sess-a' });
store.append('sess-a', 'user', { text: '他说话' });
store.create(ROOT, null, { id: 'sess-me' });
store.append('sess-me', 'user', { text: '我自己' });

// 把 sess-me 的 mtime 改成刚刚，sess-a 改成 30 分钟前
const fA = path.join(DATA, 'sessions', 'sess-a', 'frames.jsonl');
const fMe = path.join(DATA, 'sessions', 'sess-me', 'frames.jsonl');
const now = Date.now();
fs.utimesSync(fA, new Date(now - 30 * 60000), new Date(now - 30 * 60000));
fs.utimesSync(fMe, new Date(now), new Date(now));

// ① idleMinutes 排除自己 —— ★ 2026-11-10 D 切片后它**只用于人工诊断**，不再参与判定
const idle = idleMinutes(store, { ignoreSessions: ['sess-me'], now });
push('★ idleMinutes 排除自己后算 30 分钟（诊断用）', idle.ok && idle.minutes >= 29 && idle.minutes <= 31, idle.minutes + ' 分钟，扫了 ' + idle.scanned + ' 个，跳过 ' + idle.skipped);
const idle2 = idleMinutes(store, { ignoreSessions: [], now });
push('★ idleMinutes 不排除就是 0 分钟', idle2.minutes === 0, idle2.minutes + ' 分钟');

const TARGET = 'sess-target';
const HA = { ok: true, minutes: 30, lastActivityAt: new Date(now - 30 * 60000).toISOString(), host: 'fake-dsh', sessionId: TARGET, targetSession: TARGET };

// ② 总开关
const p1 = decidePhase({ now, state: {}, config: { enabled: false, targetSession: TARGET }, hostActivity: HA });
push('总开关关 → disabled', p1.phase === PHASE.DISABLED, p1.reason);

// ③ 没有目标 → fail-closed（★ D 切片新增）
const p0 = decidePhase({ now, state: {}, config: { enabled: true }, hostActivity: HA });
push('★ enabled 但没 targetSession → unknown（fail-closed）', p0.phase === PHASE.UNKNOWN && /targetSession/.test(p0.reason), p0.reason);

// ④ 拿不到宿主上报 → unknown（★ D 切片：不许把不知道当成人不在）
const p6 = decidePhase({ now, state: {}, config: { enabled: true, targetSession: TARGET }, hostActivity: null });
push('★ 拿不到宿主上报 → unknown（不动）', p6.phase === PHASE.UNKNOWN && /UNKNOWN/.test(p6.reason), p6.reason);

// ⑤ 静默不够
const p2 = decidePhase({ now, state: {}, config: { enabled: true, targetSession: TARGET, idleThresholdMinutes: 60 }, hostActivity: HA });
push('静默不够 → idle', p2.phase === PHASE.IDLE, p2.reason);

// ⑥ 静默够
const p3 = decidePhase({ now, state: {}, config: { enabled: true, targetSession: TARGET, idleThresholdMinutes: 15 }, hostActivity: HA });
push('★ 静默够 → autonomous', p3.phase === PHASE.AUTONOMOUS, p3.reason);
push('★ 判定结果带着目标（唯一目标）', p3.targetSession === TARGET, p3.targetSession);

// ⑦ 预算用尽
const today = new Date(now).toISOString().slice(0, 10);
const p4 = decidePhase({ now, state: { runsTodayDate: today, runsToday: 24 }, config: { enabled: true, targetSession: TARGET, idleThresholdMinutes: 15, maxRunsPerDay: 24 }, hostActivity: HA });
push('预算用尽 → idle', p4.phase === PHASE.IDLE, p4.reason);

// ⑧ 安静时段
const h = new Date(now).getHours();
const p5 = decidePhase({ now, state: {}, config: { enabled: true, targetSession: TARGET, idleThresholdMinutes: 15, quietHours: [h, (h + 1) % 24] }, hostActivity: HA });
push('安静时段 → idle', p5.phase === PHASE.IDLE, p5.reason);

// ⑨ 自主提示文本
const txt = autonomousPrompt(p3, { threshold: 15 });
push('★ 提示里有「静默 N 分钟」', /静默 30 分钟/.test(txt), txt.split('\n')[0]);
push('★ 提示里说「不必汇报」', txt.includes('不必汇报'), '');
push('★ 提示里要求落盘', txt.includes('落盘'), '');

// ⑩ Autonomy 类
const stateFile = path.join(DATA, 'autonomy.json');
const a = new Autonomy(store, { enabled: true, targetSession: TARGET, idleThresholdMinutes: 15, ignoreSessions: ['sess-me'] }, stateFile);
const c1 = a.check(now, HA);
push('Autonomy.check 走通（注入宿主真值）', c1.phase === PHASE.AUTONOMOUS, c1.reason);
push('★ check 不写状态文件（没投成功就不记预算）', !fs.existsSync(stateFile), stateFile);
a.recordRun(now);
push('recordRun 记了预算', a.state.runsToday === 1, JSON.stringify(a.state));
const st2 = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
push('★ 状态落盘了', st2.runsToday === 1, stateFile);

// ⑪ 旧字段不迁移
const aLegacy = new Autonomy(store, { enabled: true, session: 'autonomy', targetSession: TARGET }, path.join(DATA, 'autonomy-legacy.json'));
push('★ 旧 session 字段不迁移（记下来但不使用）', aLegacy.legacySession === 'autonomy' && aLegacy.config.session === undefined, aLegacy.legacySession);
const cLegacy = aLegacy.check(now, HA);
push('★ 旧 session 存在时目标仍是 targetSession', cLegacy.targetSession === TARGET && cLegacy.phase === PHASE.AUTONOMOUS, cLegacy.targetSession);

// ⑫ 手动触发仍看总开关
const a2 = new Autonomy(store, { enabled: false }, path.join(DATA, 'autonomy2.json'));
const m = a2.manual(now);
push('★ 总开关关时手动也不许绕', m.ok === false && m.reason.includes('不许绕过'), m.reason);

// ⑬ 默认值
push('默认是关着的', DEFAULT_AUTONOMY.enabled === false, '要自己动必须明确打开');
push('默认没有**固定**目标（留空 = 跟随《墨》当前 lead，动态）', !DEFAULT_AUTONOMY.targetSession, String(DEFAULT_AUTONOMY.targetSession));


// ═══════════════════════════════════════════════════════════════════
// ⑭ ★★ 2026-11-11 动态目标（爀曦：「自主默认下发 lead，lead 会话 id 会随交接变化，
//    所以默认动态匹配」）。判据都在 organs/lead-target.mjs，这里测的是**语义**：
//    留空 = 跟随当前 lead · 填写 = 固定覆盖 · 解析不出 = fail-closed。
// ═══════════════════════════════════════════════════════════════════
const LEAD_A = 'sess-lead-a';
const LEAD_B = 'sess-lead-b';
const payload = (id, extra) => ({
  ok: true, enabled: true, primaryFound: !!id, primarySessionId: id || null,
  primaryCandidates: 1, leadSource: 'ledger:last-lead', ...(extra || {}),
});

// ⑭-1 心跳响应 → 目标（纯函数）
const rA = resolveTargetFromHeartbeatPayload(payload(LEAD_A), { atMs: now });
push('★ 心跳说 lead=A → 解析出 A', rA.ok && rA.sessionId === LEAD_A && rA.source === 'heartbeat-lead', rA.sessionId + ' / ' + rA.source);
const rB = resolveTargetFromHeartbeatPayload(payload(LEAD_B), { atMs: now });
push('★ 交接：心跳说 lead=B → 解析出 B（不是记住的 A）', rB.ok && rB.sessionId === LEAD_B, rB.sessionId);
const rNone = resolveTargetFromHeartbeatPayload(payload(null), { atMs: now });
push('★ primaryFound=false → 解析不出（fail-closed）', rNone.ok === false && /没有找到主导/.test(rNone.why), rNone.why);
const rNoId = resolveTargetFromHeartbeatPayload({ ok: true, primaryFound: true }, { atMs: now });
push('★ 旧版心跳没有 primarySessionId → 解析不出（点名要升级）', rNoId.ok === false && /primarySessionId/.test(rNoId.why), rNoId.why);
const rAmbig = resolveTargetFromHeartbeatPayload(payload(LEAD_A, { primaryCandidates: 2 }), { atMs: now });
push('★ 候选歧义（2 个活会话都命中）→ 不替你挑一个', rAmbig.ok === false && /歧义/.test(rAmbig.why), rAmbig.why);
const rDead = resolveTargetFromHeartbeatPayload({ ok: false, why: 'ECONNREFUSED' }, { atMs: now });
push('★ 心跳接口 ok:false → 解析不出', rDead.ok === false && /ECONNREFUSED/.test(rDead.why), rDead.why);

// ⑭-2 固定覆盖 vs 动态跟随
const dynA = { ok: true, sessionId: LEAD_A, atMs: now, candidates: 1, leadSource: 'ledger:last-lead' };
const tFixed = resolveTarget({ config: { targetSession: TARGET }, dynamic: dynA, nowMs: now });
push('★ 显式填写 = 固定覆盖（压过心跳给的 A）', tFixed.ok && tFixed.sessionId === TARGET && tFixed.source === 'fixed', tFixed.sessionId + ' / ' + tFixed.source);
const tLead = resolveTarget({ config: {}, dynamic: dynA, nowMs: now });
push('★ 留空 = 跟随当前 lead（A）', tLead.ok && tLead.sessionId === LEAD_A && tLead.source === 'heartbeat-lead', tLead.sessionId + ' / ' + tLead.source);
const tStale = resolveTarget({ config: {}, dynamic: dynA, nowMs: now + 10 * 60 * 1000 });
push('★ 上一次解析过期 → 不拿旧 id 冒险', tStale.ok === false && /过期/.test(tStale.why), tStale.why);

// ⑭-3 判定：一次 tick 只认一个 id（目标 / 活跃真值 / 回执期望都必须是它）
const aDyn = new Autonomy(store, { enabled: true, idleThresholdMinutes: 15 }, path.join(DATA, 'autonomy-dyn.json'));
let leadNow = rA;
let providerCalls = 0;
let activitySawTarget = null;
aDyn.leadTargetProvider = () => { providerCalls++; return leadNow; };
aDyn.hostActivityProvider = (nowMs, tgt) => {
  activitySawTarget = tgt && tgt.ok ? tgt.sessionId : null;
  return { ok: true, minutes: 30, sessionId: activitySawTarget, host: 'fake-dsh' };
};
const cDynA = aDyn.check(now);
push('★ 动态目标 A → autonomous，目标是 A', cDynA.phase === PHASE.AUTONOMOUS && cDynA.targetSession === LEAD_A, cDynA.phase + ' / ' + cDynA.targetSession);
push('★ 同一次 tick 只解析一次（provider 只被叫 1 次）', providerCalls === 1, '调用 ' + providerCalls + ' 次');
push('★ 活跃真值按**同一个 id** 去问（不是配置里那一格）', activitySawTarget === LEAD_A, String(activitySawTarget));
push('★ 阶段对象带着来源', cDynA.targetSource === 'heartbeat-lead' && cDynA.target.ok === true, String(cDynA.targetSource));

// 交接：A → B，下一次 tick 全切 B
leadNow = rB;
providerCalls = 0;
const cDynB = aDyn.check(now + 60000);
push('★ 交接后下一次 tick：目标切到 B', cDynB.targetSession === LEAD_B && cDynB.phase === PHASE.AUTONOMOUS, cDynB.targetSession);
push('★ 交接后：活跃真值也跟着切成 B', activitySawTarget === LEAD_B, String(activitySawTarget));
push('★ 交接后：仍然只解析一次', providerCalls === 1, '调用 ' + providerCalls + ' 次');

// ⑭-4 心跳读不到 / 没主导 → 不动作（即使静默够、宿主在线）
const aDead = new Autonomy(store, { enabled: true, idleThresholdMinutes: 15 }, path.join(DATA, 'autonomy-dead.json'));
aDead.leadTargetProvider = () => ({ ok: false, source: 'heartbeat-lead', sessionId: null, atMs: now, why: '读心跳失败：ECONNREFUSED' });
aDead.hostActivityProvider = () => ({ ok: true, minutes: 60, sessionId: LEAD_A, host: 'fake-dsh' });
const cDead = aDead.check(now);
push('★ 心跳不可用 → UNKNOWN（不动），理由是读不到而不是「他没说话」', cDead.phase === PHASE.UNKNOWN && /ECONNREFUSED/.test(cDead.reason), cDead.reason);
const aNoLead = new Autonomy(store, { enabled: true }, path.join(DATA, 'autonomy-nolead.json'));
aNoLead.leadTargetProvider = () => rNone;
aNoLead.hostActivityProvider = () => ({ ok: true, minutes: 60, sessionId: LEAD_A, host: 'fake-dsh' });
const cNoLead = aNoLead.check(now);
push('★ 心跳说没主导 → UNKNOWN（不动）', cNoLead.phase === PHASE.UNKNOWN && /没有找到主导/.test(cNoLead.reason), cNoLead.reason);
const aNoProvider = new Autonomy(store, { enabled: true }, path.join(DATA, 'autonomy-noprov.json'));
const cNoProv = aNoProvider.check(now, { ok: true, minutes: 60 });
push('★ 没挂解析器 → 解析不出（绝不自己挑一个）', cNoProv.phase === PHASE.UNKNOWN && /targetSession/.test(cNoProv.reason), cNoProv.reason);

// ⑭-5 pushToHost=false → 不动（没有自跑退路）
const aNoPush = new Autonomy(store, { enabled: true, pushToHost: false, targetSession: TARGET }, path.join(DATA, 'autonomy-nopush.json'));
const cNoPush = aNoPush.check(now, HA);
push('★ pushToHost=false → idle（不投、不自跑）', cNoPush.phase === PHASE.IDLE && /pushToHost/.test(cNoPush.reason), cNoPush.reason);

// ⑭-6 解析器的网络闸门：不动的时候一次请求都不发
let fetched = 0;
const fakeFetch = async () => { fetched++; return { ok: true, status: 200, json: async () => payload(LEAD_B) }; };
// ★ 2026-11-13（架构收敛）：心跳路径已退役 —— lead 判定改成纯本地（读《墨》最后一条 lead）。
//   本段测的是「不动的时候一次请求都不发」，那个意图仍然成立；只是现在**一次都不发**是常态。
//   ★ 署名用 'lead-b' 而不是 id 前 8 位：'sess-lea' 同时是 sess-lead-a / sess-lead-b 的前缀，
//     那样账本判定会把它判成歧义（而歧义是 fail-closed，不是「随便挑一个」）。
const LT_LEDGER = path.join(DATA, 'ledger-autonomy.jsonl');
fs.writeFileSync(LT_LEDGER, JSON.stringify({ t: new Date(now).toISOString(), type: 'lead', by: 'lead-b' }) + '\n', 'utf8');
const lt = createLeadTargetResolver({
  config: { integrations: { heartbeatUrl: 'http://127.0.0.1:9/heartbeat/auto', ledgerFile: LT_LEDGER } },
  sessionsProvider: () => [{ id: LEAD_A }, { id: LEAD_B }],
  fetchImpl: fakeFetch, now: () => now,
});
await lt.refreshIfNeeded({ enabled: false });
push('★ 总开关关着 → 一次请求都不发', fetched === 0, 'fetches=' + fetched);
await lt.refreshIfNeeded({ enabled: true, pushToHost: false });
push('★ pushToHost=false → 一次请求都不发', fetched === 0, 'fetches=' + fetched);
await lt.refreshIfNeeded({ enabled: true, targetSession: TARGET });
push('★ 已固定指定目标 → 一次请求都不发', fetched === 0, 'fetches=' + fetched);
await lt.refreshIfNeeded({ enabled: true });
push('★ 留空 + 开着 → 从《墨》账本解析出 lead=B（**仍然 0 次网络请求**）', fetched === 0 && lt.current().ok && lt.current().sessionId === LEAD_B, 'fetches=' + fetched + ' / ' + lt.current().sessionId + ' / ' + String(lt.current().why || '').slice(0, 60));

// ⑭-7 地址没配**且发现不到** → 解析不出（不是「投给默认会话」）
// ★ 2026-11-11 地址自动发现之后，「没配」不再等于失败 —— 没配会去读本机最新 DSH 启动记录。
//   所以这条用例把两个来源都指到临时空目录/不存在的文件：判的仍是「发现不到就必须 fail-closed」。
//   ★ 必须指走：不指的话这条用例会去读**本机真实**的 D:AIdshhomeguardlogs，结果取决于这台机器今天的状态。
const EMPTY_LOGS = path.join(DATA, 'no-dsh-logs');
fs.mkdirSync(EMPTY_LOGS, { recursive: true });
const lt2 = createLeadTargetResolver({
  config: {}, fetchImpl: fakeFetch, now: () => now,
  logDir: EMPTY_LOGS, originFile: path.join(DATA, 'no-such-dsh-origin.txt'),
});
await lt2.refresh();
push('★ 没配账本、也发现不到 —— fail-closed（并说清缺什么）',
  lt2.current().ok === false && /账本|心跳/.test(lt2.current().why), lt2.current().why);

store.saveIndexCache?.(); store.closeAll();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}

console.log(''); console.log('=== 自主循环器官自检 ==='); console.log('');
console.log(ok.join('\n'));
if (bad.length) { console.log(''); console.log(bad.join('\n')); }
console.log(''); console.log(ok.length + ' 通过 / ' + bad.length + ' 失败'); console.log('');
process.exit(bad.length ? 1 : 0);
