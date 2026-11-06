import fs from 'node:fs';
import path from 'node:path';
import { normalizeRecord, applyDecision, viewsOf, badgeOf, buildWakeText, Ledger,
         STAGES, DECISIONS, CHARTERS, STAGE_BY_DECISION } from '../src/organs/waker.mjs';
import { ROOT } from '../src/config.mjs';

const ok = []; const bad = [];
const push = (n, c, e) => (c ? ok : bad).push((c ? '✓ ' : '✗ ') + n + (e ? '  → ' + e : ''));

// ① ★★ 最重要的不变量：缺 charter 绝不回落 pass
const r1 = normalizeRecord({ key: 'k1' });
push('★ 缺 charter → unchecked（不是 pass）', r1.charter === 'unchecked', r1.charter);
const r2 = normalizeRecord({ key: 'k2', charter: 'pass' });
push('★ 给了 pass 才是 pass', r2.charter === 'pass', r2.charter);
const r3 = normalizeRecord({ key: 'k3', charter: '乱写' });
push('★ 乱写的 charter 也回落 unchecked', r3.charter === 'unchecked', r3.charter);
const r4 = normalizeRecord({ key: 'k4', charter: null });
push('★ null 回落 unchecked', r4.charter === 'unchecked', r4.charter);

// ② 其余字段回落
const r5 = normalizeRecord({ key: 'k5', stage: '不存在的阶段', decision: '乱写' });
push('非法 stage 回落 pending', r5.stage === 'pending', r5.stage);
push('非法 decision 回落 null', r5.decision === null, String(r5.decision));
const r6 = normalizeRecord({ key: 'k6', wakeCount: -5 });
push('负数 wakeCount 归零', r6.wakeCount === 0, r6.wakeCount);
const r7 = normalizeRecord({ key: 'k7', fromSession: 'sess-abc' });
push('★ 回邮地址穿过了白名单', r7.fromSession === 'sess-abc', r7.fromSession);

// ③ applyDecision
const led = { events: [normalizeRecord({ key: 'a', charter: 'unchecked' })] };
const d1 = applyDecision(led, 'a', { decision: 'resume' });
push('写判定成功', d1.ok, d1.ok ? 'stage=' + d1.event.stage : d1.err);
push('★ resume → done', d1.event.stage === 'done', d1.event.stage);
push('★ 不传 charter 就保留原值（不是默认 pass）', d1.event.charter === 'unchecked', d1.event.charter);
const d2 = applyDecision(led, 'a', { decision: 'hold' });
push('hold → held', d2.event.stage === 'held', d2.event.stage);
const d3 = applyDecision(led, 'a', { decision: 'audit' });
push('audit → auditing', d3.event.stage === 'auditing', d3.event.stage);
const d4 = applyDecision(led, 'a', { decision: '乱写' });
push('非法 decision 被拒', d4.ok === false, d4.err);
const d5 = applyDecision(led, '不存在', { decision: 'resume' });
push('不存在的 key 被拒', d5.ok === false, d5.err);

// ④ 四视图
const ev = [
  normalizeRecord({ key: 't1', stage: 'woken' }),                      // act
  normalizeRecord({ key: 't2', decision: 'resume', charter: 'pass' }),// done + auto
  normalizeRecord({ key: 't3', decision: 'audit', charter: 'ask' }),  // audit
  normalizeRecord({ key: 't4', stage: 'stuck' }),                     // audit（★ 叫不醒的不能消失）
  normalizeRecord({ key: 't5', decision: 'resume', charter: 'unchecked' }), // done only
];
const v = viewsOf(ev);
push('act = 等判定的', v.act.length === 1 && v.act[0].key === 't1', v.act.map(x => x.key).join(','));
push('done = resume 的', v.done.length === 2, v.done.map(x => x.key).join(','));
push('★ audit 收进了 stuck', v.audit.some(x => x.key === 't4'), v.audit.map(x => x.key).join(','));
push('auto = 判定且 pass 的', v.auto.length === 1 && v.auto[0].key === 't2', v.auto.map(x => x.key).join(','));
push('★ 一条可以同时进两个视图', v.done.some(x => x.key === 't2') && v.auto.some(x => x.key === 't2'), 't2 在 done 和 auto 里都出现');

// ⑤ 徽章去重
push('★ 徽章去重（act + audit 的并集）', badgeOf(v) === 3, badgeOf(v) + '（t1 + t3 + t4）');

// ⑥ buildWakeText
const wt = buildWakeText(normalizeRecord({ key: 'K-123', title: '有事找你', from: 'QQ', tier: 'act' }), { facts: '内容内容', kind: 'message', level: 'act' });
push('★ 叫醒文案里有台账 key', wt.includes('K-123'), '（不然回写判定对不上）');
push('文案里说明「不是他本人刚说的」', wt.includes('不是他本人刚说的话'), '');
push('文案里要求落盘', wt.includes('落盘'), '');

// ⑦ Ledger
const DATA = path.join(ROOT, 'data', 'waker-' + Date.now());
const lf = path.join(DATA, 'ledger.json');
const L1 = new Ledger(lf);
const i1 = L1.ingest({ key: 'e1', t: '2026-11-07T00:00:00Z', title: '第一条', from: 'QQ' });
push('收一条事件', i1.ok, L1.events.length + ' 条');
const i2 = L1.ingest({ key: 'e1', title: '重复' });
push('★ 幂等：同 key 不重复收', i2.ok === false && i2.dup === true, i2.err);
push('落盘了', fs.existsSync(lf), lf.replace(ROOT, '.'));

// 叫醒计数
for (let i = 0; i < 3; i++) L1.markWoken('e1', 3);
push('★ wakeCount 到 3 判 stuck', L1.find('e1').stage === 'stuck', 'wakeCount=' + L1.find('e1').wakeCount + ' stage=' + L1.find('e1').stage);

// 判定
const dd = L1.decide('e1', { decision: 'resume', charter: 'pass' });
push('Ledger.decide 走通', dd.ok, dd.ok ? 'stage=' + dd.event.stage : dd.err);

// 重载
const L2 = new Ledger(lf);
push('★ 重载后台账还在', L2.events.length === 1 && L2.events[0].key === 'e1', L2.events.length + ' 条');
push('★ 重载后判定也在', L2.events[0].decision === 'resume' && L2.events[0].charter === 'pass', L2.events[0].decision + '/' + L2.events[0].charter);

// ⑧ 常量表
push('STAGES 七个', STAGES.length === 7, STAGES.join(','));
push('DECISIONS 三个', DECISIONS.length === 3, DECISIONS.join(','));
push('CHARTERS 四个', CHARTERS.length === 4, CHARTERS.join(','));
push('decision→stage 映射完整', DECISIONS.every(d => STAGE_BY_DECISION[d]), JSON.stringify(STAGE_BY_DECISION));

try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}

console.log(''); console.log('=== 唤醒台账器官自检 ==='); console.log('');
console.log(ok.join('\n'));
if (bad.length) { console.log(''); console.log(bad.join('\n')); }
console.log(''); console.log(ok.length + ' 通过 / ' + bad.length + ' 失败'); console.log('');
process.exit(bad.length ? 1 : 0);