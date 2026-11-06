import fs from 'node:fs';
import path from 'node:path';
import { SessionStore } from '../src/session/store.mjs';
import { idleMinutes, decidePhase, autonomousPrompt, Autonomy, PHASE, DEFAULT_AUTONOMY } from '../src/organs/autonomy.mjs';
import { ROOT } from '../src/config.mjs';

const ok = []; const bad = [];
const push = (n, c, e) => (c ? ok : bad).push((c ? '✓ ' : '✗ ') + n + (e ? '  → ' + e : ''));

const DATA = path.join(ROOT, 'data', 'autonomy-' + Date.now());
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

// ① idleMinutes 排除自己
const idle = idleMinutes(store, { ignoreSessions: ['sess-me'], now });
push('★ 排除自己后算 30 分钟', idle.ok && idle.minutes >= 29 && idle.minutes <= 31, idle.minutes + ' 分钟，扫了 ' + idle.scanned + ' 个，跳过 ' + idle.skipped);
const idle2 = idleMinutes(store, { ignoreSessions: [], now });
push('★ 不排除就是 0 分钟', idle2.minutes === 0, idle2.minutes + ' 分钟');

// ② 总开关
const p1 = decidePhase({ now, state: {}, config: { enabled: false }, idleMinutes: 30 });
push('总开关关 → disabled', p1.phase === PHASE.DISABLED, p1.reason);

// ③ 静默不够
const p2 = decidePhase({ now, state: {}, config: { enabled: true, idleThresholdMinutes: 60 }, idleMinutes: 30 });
push('静默不够 → idle', p2.phase === PHASE.IDLE, p2.reason);

// ④ 静默够
const p3 = decidePhase({ now, state: {}, config: { enabled: true, idleThresholdMinutes: 15 }, idleMinutes: 30 });
push('★ 静默够 → autonomous', p3.phase === PHASE.AUTONOMOUS, p3.reason);

// ⑤ 预算用尽
const today = new Date(now).toISOString().slice(0, 10);
const p4 = decidePhase({ now, state: { runsTodayDate: today, runsToday: 24 }, config: { enabled: true, idleThresholdMinutes: 15, maxRunsPerDay: 24 }, idleMinutes: 30 });
push('预算用尽 → idle', p4.phase === PHASE.IDLE, p4.reason);

// ⑥ 安静时段
const h = new Date(now).getHours();
const p5 = decidePhase({ now, state: {}, config: { enabled: true, idleThresholdMinutes: 15, quietHours: [h, (h + 1) % 24] }, idleMinutes: 30 });
push('安静时段 → idle', p5.phase === PHASE.IDLE, p5.reason);

// ⑦ 拿不到静默数
const p6 = decidePhase({ now, state: {}, config: { enabled: true }, idleMinutes: undefined });
push('没有静默数 → unknown', p6.phase === PHASE.UNKNOWN, p6.reason);

// ⑧ 自主提示文本
const txt = autonomousPrompt(p3, { threshold: 15 });
push('★ 提示里有「静默 N 分钟」', /静默 30 分钟/.test(txt), txt.split('\n')[0]);
push('★ 提示里说「不必汇报」', txt.includes('不必汇报'), '');
push('★ 提示里要求落盘', txt.includes('落盘'), '');

// ⑨ Autonomy 类
const stateFile = path.join(DATA, 'autonomy.json');
const a = new Autonomy(store, { enabled: true, idleThresholdMinutes: 15, ignoreSessions: ['sess-me'] }, stateFile);
const c1 = a.check(now);
push('Autonomy.check 走通', c1.phase === PHASE.AUTONOMOUS, c1.reason);
a.recordRun(now);
push('recordRun 记了预算', a.state.runsToday === 1, JSON.stringify(a.state));
const st2 = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
push('★ 状态落盘了', st2.runsToday === 1, stateFile);

// ⑩ 手动触发仍看总开关
const a2 = new Autonomy(store, { enabled: false }, path.join(DATA, 'autonomy2.json'));
const m = a2.manual(now);
push('★ 总开关关时手动也不许绕', m.ok === false && m.reason.includes('不许绕过'), m.reason);

// ⑪ 默认值
push('默认是关着的', DEFAULT_AUTONOMY.enabled === false, '要自己动必须明确打开');

store.saveIndexCache?.(); store.closeAll();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}

console.log(''); console.log('=== 自主循环器官自检 ==='); console.log('');
console.log(ok.join('\n'));
if (bad.length) { console.log(''); console.log(bad.join('\n')); }
console.log(''); console.log(ok.length + ' 通过 / ' + bad.length + ' 失败'); console.log('');
process.exit(bad.length ? 1 : 0);