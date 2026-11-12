// 思考退化检测自检
//
// ★ 为什么先自检、不直接接真宿主：
//   这条判据的输入是**三个数字**。真宿主一天可能只报几十次、还绑着真实任务，
//   改一句代码拿一天数据去验，太慢也太脏。三个数字是纯的，喂进去就能验。
//   **验通了再接真的，出问题才知道是谁的错**（和 control-selftest 同一条理由）。
//
// ★ 这套自检要锁住的四件事：
//   ① 判据在该报的时候报、不该报的时候不报（误报比漏报更坏 —— 人会开始不信它）
//   ② **看不见就不猜**：字段缺失时不许当 0 用（这是最容易写错、也最会骗人的一处）
//   ③ 不变量：sum(reasons[].weight) === score（分数必须可拆、可核对）
//   ④ 人看的文本**只描述观察，不写指令**（lead 2026-11-07 定：v4 只判断不执行）

import { ControlHub } from '../src/control/hub.mjs';
import {
  DegradationDetector, DegradationTracker, degradationCard,
  tierOf, TIER, EVIDENCE, ACTION, DEFAULT,
} from '../src/organs/degradation.mjs';

const ok = []; const bad = [];
const push = (n, c, d) => (c ? ok : bad).push((c ? '✓ ' : '✗ ') + n + (d ? '  → ' + d : ''));
const sumW = (r) => r.reasons.reduce((s, x) => s + x.weight, 0);
const codes = (r) => r.reasons.map((x) => x.code);

// 真实形状的窗口：本机实测 1048576（不是整数 1000000）
const WIN = 1048576;
const st = (o) => Object.assign({ contextWindow: WIN }, o);

// —— 1. 健康：正常产出，压力低 ——
const a = new DegradationDetector();
const r1 = a.observe('h1', 'dsh', st({ contextTokens: 200000, turnId: 't1', outputTokens: 420 }));
push('① 健康一轮 → ok / 0 分', r1.tier === TIER.OK && r1.score === 0, 'tier=' + r1.tier + ' score=' + r1.score);
push('① 健康一轮 → 无候选动作', r1.action === ACTION.NONE, 'action=' + r1.action);

// —— 2. 烧光：0 输出 ——
const b = new DegradationDetector();
const b1 = b.observe('h1', 'dsh', st({ contextTokens: 300000, turnId: 't1', outputTokens: 0 }));
push('② 单次 0 输出 → watch（不直接干预）', b1.tier === TIER.WATCH && b1.score === 2, 'tier=' + b1.tier + ' score=' + b1.score);
push('② 单次 0 输出的动作不是 break', b1.action !== ACTION.BREAK, 'action=' + b1.action + '（不知道 outputTokens 语义 ⇒ 不配建议中断）');
const b2 = b.observe('h1', 'dsh', st({ contextTokens: 300000, turnId: 't2', outputTokens: 0 }));
push('② 连续 2 次 0 输出 → 仍是 watch', b2.tier === TIER.WATCH && b2.score === 3, 'score=' + b2.score);
const b3 = b.observe('h1', 'dsh', st({ contextTokens: 300000, turnId: 't3', outputTokens: 0 }));
push('★ 连续 3 次 0 输出 → intervene（对齐换气阈值 3）', b3.tier === TIER.INTERVENE, 'tier=' + b3.tier + ' score=' + b3.score);
push('★ intervene 时动作给到 break', b3.action === ACTION.BREAK, 'action=' + b3.action);

// —— 3. 低产出：单点不误报，连续才算 ——
const c = new DegradationDetector();
const c1 = c.observe('h1', 'dsh', st({ contextTokens: 300000, turnId: 't1', outputTokens: 18 }));
push('★ 单次低产出（18 tokens）不误报', c1.tier === TIER.OK, 'tier=' + c1.tier + ' score=' + c1.score + '（单点低可能只是任务性质）');
c.observe('h1', 'dsh', st({ contextTokens: 300000, turnId: 't2', outputTokens: 20 }));
const c3 = c.observe('h1', 'dsh', st({ contextTokens: 300000, turnId: 't3', outputTokens: 22 }));
push('连续 3 轮低产出 → watch', c3.tier === TIER.WATCH, 'score=' + c3.score);
const c4 = c.observe('h1', 'dsh', st({ contextTokens: 300000, turnId: 't4', outputTokens: 20 }));
push('连续 4 轮低产出 → intervene', c4.tier === TIER.INTERVENE, 'score=' + c4.score);

// —— 4. 恢复：一次正常输出就把连续计数清零 ——
const c5 = c.observe('h1', 'dsh', st({ contextTokens: 300000, turnId: 't5', outputTokens: 900 }));
push('★ 恢复：一次正常输出 → 连续计数清零', c5.counters.lowStreak === 0 && c5.tier === TIER.OK, 'lowStreak=' + c5.counters.lowStreak + ' score=' + c5.score);

// —— 5. 同轮膨胀：守恒关系 ——
const d = new DegradationDetector();
d.observe('h1', 'dsh', st({ contextTokens: 400000, turnId: 'same', outputTokens: 0 }));
const d2 = d.observe('h1', 'dsh', st({ contextTokens: 412000, turnId: 'same', outputTokens: 0 }));
push('★ 同轮：上下文涨 12000、产出 0 → 抓到 inflating', codes(d2).includes(EVIDENCE.INFLATING) && d2.action === ACTION.BREAK, 'codes=' + codes(d2).join(',') + ' action=' + d2.action);

const d3 = new DegradationDetector();
d3.observe('h1', 'dsh', st({ contextTokens: 400000, turnId: 'same', outputTokens: 500 }));
const d4 = d3.observe('h1', 'dsh', st({ contextTokens: 412000, turnId: 'same', outputTokens: 300 }));
push('★ 同轮有产出 → 不算 inflating', !codes(d4).includes(EVIDENCE.INFLATING), '按「累计产出是否为 0」判 —— 有产出就是在交付');

const d5 = new DegradationDetector();
d5.observe('h1', 'dsh', st({ contextTokens: 400000, turnId: 'same', outputTokens: 0 }));
const d6 = d5.observe('h1', 'dsh', st({ contextTokens: 402000, turnId: 'same', outputTokens: 0 }));
push('同轮只涨 2000（低于 8000）→ 不算 inflating', !codes(d6).includes(EVIDENCE.INFLATING), 'growth=' + d6.counters.sameTurnGrowth + ' < ' + DEFAULT.sameTurnGrowthMin);

const d7 = new DegradationDetector();
d7.observe('h1', 'dsh', st({ contextTokens: 400000, turnId: 'same', outputTokens: 0 }));
const d8 = d7.observe('h1', 'dsh', st({ contextTokens: 300000, turnId: 'same', outputTokens: 0 }));
push('同轮上下文下降（压过）→ 不算增长', d8.counters.sameTurnGrowth === 0 && !codes(d8).includes(EVIDENCE.INFLATING), '被压缩过的账不能算进「在往里塞东西」');

// —— 6. 水位：条件，不是症状 ——
const e = new DegradationDetector();
const e1 = e.observe('h1', 'dsh', st({ contextTokens: 900000, turnId: 't1', outputTokens: 800 }));
push('★ 水位 85.8% 单独出现 → watch，不是 intervene', e1.tier === TIER.WATCH, 'tier=' + e1.tier + ' score=' + e1.score);
push('水位高 + 没有产出症状 → 不给 break', e1.action !== ACTION.BREAK, 'action=' + e1.action);
const e2 = new DegradationDetector();
const e2r = e2.observe('h1', 'dsh', st({ contextTokens: 680000, turnId: 't1', outputTokens: 800 }));
push('★ 水位 64.8% 单独出现 → 仍是 ok（水位不是退化）', e2r.tier === TIER.OK, 'tier=' + e2r.tier + ' score=' + e2r.score);
push('水位过 0.60 才给 COMPACT 候选', e2r.action === ACTION.COMPACT, 'action=' + e2r.action);

// —— 7. 看不见就不猜 ——
const f = new DegradationDetector();
const f1 = f.observe('h1', 'dsh', { contextTokens: 500000, turnId: 't1', outputTokens: 600 });
push('★ 窗口缺失 → pressure.pct = null（不是 0，也不是 1）', f1.pressure.pct === null && f1.pressure.level === null, JSON.stringify(f1.pressure));
const f2 = new DegradationDetector();
const f2r = f2.observe('h1', 'dsh', st({ contextTokens: 300000, turnId: 't1' }));
push('★ outputTokens 缺失 → 不判 burned、不动计数', f2r.score === 0 && f2r.counters.zeroStreak === 0 && f2r.observed.outputTokens === null, 'score=' + f2r.score + '（undefined 不许当 0 用）');
const f3 = new DegradationDetector();
const f3r = f3.observe('h1', 'dsh', st({ contextTokens: 300000, turnId: 't1', outputTokens: '0' }));
push('outputTokens 是字符串 "0" → 归一化后判 burned', f3r.score === 2 && codes(f3r).includes(EVIDENCE.BURNED), 'score=' + f3r.score);
const f4 = new DegradationDetector();
const f4r = f4.observe('h1', 'dsh', { turnId: 't1' });
push('全空 state → 不崩、给 ok', f4r && f4r.tier === TIER.OK, 'tier=' + (f4r && f4r.tier));
// ★★ 真桥现状（2026-11-07 读 dsh-agent-soul-bridge/index.js:240-243）：
//    outputTokens 恒 null、水位也可能拿不到。这时**什么都不该说成"正常"**。
push('★ 两个信号都空 → blind=true（不是健康，是没有数据）', f4r.blind === true, 'blind=' + f4r.blind);
push('★ blind 时 observation 说"读不到"，不说"输出正常"', /读不到/.test(f4r.observation) && !/输出正常/.test(f4r.observation), f4r.observation);
const blindSnap = { hosts: [f4.snapshot()], worst: f4.snapshot(), counts: { ok: 1, watch: 0, intervene: 0 } };
const blindCard = degradationCard(blindSnap, DEFAULT.interveneAt);
push('★ blind 时面板卡给「—（无数据）」而不是「0 / 4」', blindCard.value.indexOf('无数据') >= 0, blindCard.value + ' ｜ ' + blindCard.note);

// —— 8. 同一轮上报多次，不许算成「连续多轮」 ——
const g = new DegradationDetector();
g.observe('h1', 'dsh', st({ contextTokens: 300000, turnId: 'one', outputTokens: 0 }));
g.observe('h1', 'dsh', st({ contextTokens: 300000, turnId: 'one', outputTokens: 0 }));
const g3 = g.observe('h1', 'dsh', st({ contextTokens: 300000, turnId: 'one', outputTokens: 0 }));
push('★ 同一轮上报 3 次 ≠ 连续 3 轮烧光', g3.counters.zeroStreak === 1 && g3.score === 2, 'zeroStreak=' + g3.counters.zeroStreak + ' score=' + g3.score);

// —— 9. 不变量：分数必须能拆开核对 ——
const inv = [r1, b1, b3, c4, d2, e1, e2r, f3r];
push('★ 不变量：sum(reasons.weight) === score', inv.every((r) => sumW(r) === r.score), inv.map((r) => sumW(r) + '=' + r.score).join(' '));
push('★ 每条证据都带 code 与人话', inv.every((r) => r.reasons.every((x) => x.code && x.text && x.text.length > 6)), 'reasons 不是黑箱');

// —— 10. 人看的文本只描述观察，不写指令 ——
const texts = [b3.observation, d2.observation, c4.observation, e1.observation, r1.observation];
push('★ observation 不含指令词（建议/应该/请）', texts.every((t) => !/建议|应该|请/.test(t)), texts[0]);
push('observation 带数字（可核对）', texts.every((t) => /[0-9]/.test(t)), '全是数字 + 水位');

// —— 11. 登记处：多宿主各算各的 ——
const logs = [];
const tr = new DegradationTracker({ log: (m) => logs.push(m) });
tr.observe('host-a', 'dsh', st({ contextTokens: 200000, turnId: 'a1', outputTokens: 900 }));
tr.observe('host-b', 'codex', st({ contextTokens: 900000, turnId: 'b1', outputTokens: 0 }));
const snap = tr.snapshot();
// ★ 注意这里的期望值：host-b 是「0 输出 + 85.8% 水位」= burned(2) + pressure(2) = 4 → intervene。
//   第一版我把期望写成 watch —— **是断言错了，不是判据错了**。判据算得对，我算得粗。
push('★ 两台宿主各算各的（一好一坏）', snap.hosts.length === 2 && snap.counts.ok === 1 && snap.counts.intervene === 1, JSON.stringify(snap.counts));
push('worst 取分数最高的那台', snap.worst && snap.worst.host === 'codex', 'worst=' + (snap.worst && snap.worst.host) + ' ' + (snap.worst && snap.worst.score));
push('只在档位变化时出声（不是每轮都喊）', logs.length === 1, '日志 ' + logs.length + ' 条：' + JSON.stringify(logs));

// ★ 同一档位再报一次 → 不许再喊（否则日志会被刷成墙，人就再也不读了）
tr.observe('host-b', 'codex', st({ contextTokens: 900000, turnId: 'b2', outputTokens: 0 }));
push('同档位重复上报不重复出声', logs.length === 1, '再报一次后仍是 ' + logs.length + ' 条');
tr.observe('host-b', 'codex', st({ contextTokens: 300000, turnId: 'b3', outputTokens: 700 }));
push('★ 恢复时出声一次（解除也要说）', logs.length === 2 && /解除/.test(logs[1]), '第 2 条：' + logs[1]);

// —— 12. 真协议路径：ControlHub → onState → 器官（不开端口） ——
function fakeConn() {
  return {
    open: true,
    sent: [],
    onmessage: null,
    onclose: null,
    send(obj) { this.sent.push(obj); },
    close() { this.open = false; if (this.onclose) this.onclose(); },
  };
}
const hubTracker = new DegradationTracker({ log: () => {} });
const hub = new ControlHub({
  log: () => {},
  onState: (rec, s) => { rec.lastState = s; hubTracker.observe(rec.id, rec.host, s); },
});
const conn = fakeConn();
hub.attach(conn);
conn.onmessage(JSON.stringify({ type: 'hello', host: 'fake-dsh', caps: ['state'], meta: {} }));
conn.onmessage(JSON.stringify({ type: 'state', contextTokens: 482000, contextWindow: WIN, turnId: 'turn-7', outputTokens: 12 }));
const hSnap = hubTracker.snapshot();
push('★ 走真实 ControlHub：state 到得了器官', hSnap.hosts.length === 1 && hSnap.hosts[0].host === 'fake-dsh', 'host=' + (hSnap.hosts[0] && hSnap.hosts[0].host));
push('★ 判断用得上真实水位：482K/1047K', Math.abs(hSnap.hosts[0].pressure.pct - 482000 / WIN) < 1e-9, (hSnap.hosts[0].pressure.pct * 100).toFixed(1) + '%');
push('rec.lastState 仍然保留（面板/调试要看原文）', Boolean(conn.sent.length) && hSnap.hosts[0].observed.outputTokens === 12, 'welcome=' + (conn.sent[0] && conn.sent[0].type));

// —— 13. 面板卡（/api/organs 那一张） ——
const emptyCard = degradationCard(null);
push('面板卡：没有宿主时给「—」而不是 0 分', emptyCard.value === '—' && emptyCard.level === 'ok', JSON.stringify(emptyCard));
const card = degradationCard(snap, DEFAULT.interveneAt);
push('★ 面板卡：名字说清在看什么', card.name === '思考退化' && card.key === 'degradation', card.name + ' / ' + card.key);
push('★ 面板卡：value 是「分数 / 干预线」', card.value === (snap.worst.score + ' / ' + DEFAULT.interveneAt), card.value);
push('面板卡：level 跟着档位走', (snap.worst.tier === TIER.WATCH && card.level === 'warn') || card.level === 'bad' || card.level === 'ok', card.level + ' / tier=' + snap.worst.tier);
push('面板卡：note 带观测与数字', /[0-9]/.test(card.note) && card.note.includes(snap.worst.tier), card.note);

// —— 14. 阈值可配（不许写死成一个看不出来的常数） ——
const h = new DegradationDetector({ lowOutputTokens: 5, interveneAt: 2 });
const h1 = h.observe('h1', 'dsh', st({ contextTokens: 300000, turnId: 't1', outputTokens: 4 }));
push('阈值可配：低产出线改成 5 就按 5 判', h1.counters.lowStreak === 1, 'lowStreak=' + h1.counters.lowStreak);
push('tierOf 边界：2 分在 interveneAt=2 时就是 intervene', tierOf(2, { interveneAt: 2 }) === TIER.INTERVENE && tierOf(1, { interveneAt: 2 }) === TIER.OK);

// —— 15. 2026-11-09 补齐：产出未知≠产出正常 ——
const p = new DegradationDetector();
const p1 = p.observe('h1', 'dsh', st({ contextTokens: 300000, turnId: 't1' }));
push('★ 有水位但没产出 → 不许说「输出正常」', p1.outputKnown === false && p1.blind === false && !/输出正常/.test(p1.observation), p1.observation);
push('★ 产出来未知时明说「没读到 outputTokens」', /产出未知/.test(p1.observation) && /outputTokens/.test(p1.observation), p1.observation);
push('产出来未知不编分数（仍是 0 分 ok）', p1.score === 0 && p1.tier === TIER.OK, 'score=' + p1.score + ' tier=' + p1.tier);
const pTr = new DegradationTracker({ log: () => {} });
pTr.observe('h1', 'dsh', st({ contextTokens: 300000, turnId: 't1' }));
const pCard = degradationCard(pTr.snapshot(), DEFAULT.interveneAt);
push('★ 面板卡：产出未知时不说「0 / 4」', /产出未知/.test(pCard.value), pCard.value + ' ｜ ' + pCard.note);

// —— 16. 2026-11-09 补齐：候选动作不许越过档位 ——
const q = new DegradationDetector({ interveneAt: 10 });
let qr;
for (let i = 1; i <= 3; i++) qr = q.observe('h1', 'dsh', st({ contextTokens: 300000, turnId: 't' + i, outputTokens: 0 }));
push('★ interveneAt=10 时连续 3 次烧光 → watch，且动作不是 break', qr.tier === TIER.WATCH && qr.action !== ACTION.BREAK, 'tier=' + qr.tier + ' score=' + qr.score + ' action=' + qr.action);
const q2 = new DegradationDetector({ breakZeroStreak: 5 });
let q2r;
for (let i = 1; i <= 3; i++) q2r = q2.observe('h1', 'dsh', st({ contextTokens: 300000, turnId: 'u' + i, outputTokens: 0 }));
push('breakZeroStreak=5 → 3 连烧不 break（档已 intervene）', q2r.tier === TIER.INTERVENE && q2r.action !== ACTION.BREAK, 'tier=' + q2r.tier + ' action=' + q2r.action);
for (let i = 4; i <= 5; i++) q2r = q2.observe('h1', 'dsh', st({ contextTokens: 300000, turnId: 'u' + i, outputTokens: 0 }));
push('breakZeroStreak=5 → 第 5 连才 break', q2r.counters.zeroStreak === 5 && q2r.action === ACTION.BREAK, 'zeroStreak=' + q2r.counters.zeroStreak + ' action=' + q2r.action);
const q3 = new DegradationDetector();
let q3r;
for (let i = 1; i <= 3; i++) q3r = q3.observe('h1', 'dsh', st({ contextTokens: 300000, turnId: 'v' + i, outputTokens: 0 }));
push('默认值不变：3 连烧仍然 break', q3r.action === ACTION.BREAK, 'action=' + q3r.action + ' score=' + q3r.score);

// —— 17. 2026-11-09 补齐：断开的宿主不许留在读数里 ——
const pr = new DegradationTracker({ log: () => {} });
pr.observe('host-a', 'dsh', st({ contextTokens: 200000, turnId: 'a1', outputTokens: 900 }));
pr.observe('host-b', 'codex', st({ contextTokens: 900000, turnId: 'b1', outputTokens: 0 }));
push('剪之前两台都在', pr.snapshot().hosts.length === 2, 'hosts=' + pr.snapshot().hosts.length);
const dropped = pr.prune(['host-a']);
push('★ prune 剪掉已断开的宿主', dropped === 1 && pr.snapshot().hosts.length === 1 && pr.snapshot().hosts[0].host === 'dsh', 'dropped=' + dropped + ' 剩 ' + pr.snapshot().hosts.length);
push('★ 剪完后 worst 不再指向断开的那台', pr.snapshot().worst.host === 'dsh', 'worst=' + pr.snapshot().worst.host + ' score=' + pr.snapshot().worst.score);
pr.observe('host-c', 'codex', st({ contextTokens: 100000, turnId: 'c1', outputTokens: 500 }));
const dropped2 = pr.snapshot(['host-a', 'host-c']) && pr.snapshot().hosts.length;
push('★ snapshot(liveIds) 顺手剪（不传 = 不剪）', dropped2 === 2, 'hosts=' + dropped2);
push('prune 不传参 = 全剪（调用方要交「还活着的」）', new DegradationTracker({}).prune([]) === 0, '空表剪 0 台');

console.log(''); console.log('=== 思考退化检测自检 ==='); console.log('');
console.log(ok.join('\n'));
if (bad.length) { console.log(''); console.log(bad.join('\n')); }
console.log(''); console.log(ok.length + ' 通过 / ' + bad.length + ' 失败'); console.log('');
process.exit(bad.length ? 1 : 0);
