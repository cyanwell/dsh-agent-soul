import path from 'node:path';
import fs from 'node:fs';
import { SessionStore } from '../src/session/store.mjs';
import { EventBus } from '../src/events/bus.mjs';
import { Scheduler } from '../src/events/scheduler.mjs';
import { loadConfig, ROOT } from '../src/config.mjs';

const ok = []; const bad = [];
const push = (n, c, e) => (c ? ok : bad).push((c ? '✓ ' : '✗ ') + n + (e ? '  → ' + e : ''));

const cfg = loadConfig();
cfg.dataDir = path.join(ROOT, 'data', 'evtest-' + Date.now());
const store = new SessionStore(cfg.dataDir);
const h = store.create(ROOT, null);
const sid = h.id;

const bus = new EventBus({ store });
const seen = [];
bus.on('tick', (e) => seen.push('tick'));
bus.on('rule:*', (e) => seen.push('rule:' + e.payload.rule));

// 1. 基本收发
await bus.emit('hello', { summary: '打招呼' });
push('emit / on', seen.length === 0, '没订阅 hello 所以不触发');

let got = null;
bus.on('hello', (e) => { got = e; });
await bus.emit('hello', { summary: '再来一次' });
push('订阅后收到', Boolean(got && got.type === 'hello'));

// 2. ★ 事件写进索引
await bus.emit('note', { summary: '这条事件应该进索引' }, { session: sid });
const hits = store.search(sid, '这条事件应该进索引');
push('★ 事件写进索引', hits.length === 1, '命中 #' + (hits[0] && hits[0].seq) + ' type=' + (hits[0] && hits[0].type));

// 3. 通配订阅
let wild = 0;
bus.on('*', () => wild++);
await bus.emit('a.b', {});
await bus.emit('c', {});
push('通配 *', wild === 2, '收到 ' + wild + ' 次');

let pre = 0;
bus.on('rule:*', () => pre++);
await bus.emit('rule:x', { rule: 'x' }, {});
await bus.emit('other', { rule: 'y' });
push('前缀 rule:* 只匹配 rule 开头', pre === 1, 'rule:x 触发 1 次，other 不算');

// 4. once
let onceN = 0;
bus.on('only', () => onceN++, { once: true });
await bus.emit('only', {});
await bus.emit('only', {});
push('once 只触发一次', onceN === 1, '触发 ' + onceN + ' 次');

// 5. handler 抛错不影响别的
bus.on('boom', () => { throw new Error('我坏了'); });
let after = 0;
bus.on('boom', () => after++);
let threw = false;
try { await bus.emit('boom', {}); } catch { threw = true; }
push('handler 抛错不中断', !threw && after === 1, '后面的 handler 仍然执行了');

// 6. 心跳 tick
const sched = new Scheduler({ bus, intervalMs: 1000 });
let ruleHits = 0;
sched.rule({ name: 'always', check: () => { ruleHits++; return { summary: '命中了' }; } });
sched.rule({ name: 'never', check: () => null });
const r = await sched.tickOnce({ session: sid });
push('tickOnce 跑规则', r.ticks === 1 && r.fired.length === 1, '检查了 ' + sched.rules.length + ' 条规则，触发: ' + (r.fired.join(',') || '无'));
push('只有返回真值的规则触发', r.fired.length === 1 && r.fired[0] === 'always');

// 7. ★ 规则触发的事件也进索引
const hits2 = store.search(sid, '命中了');
push('★ 规则事件也进索引', hits2.length >= 1, '命中 ' + hits2.length + ' 条');

// 8. 节流：带 every 的规则，触发后短时间内不再触发
let throttled = 0;
sched.rule({ name: 'throttle-me', every: 60000, check: () => { throttled++; return { summary: '节流测试' }; } });
const r2a = await sched.tickOnce({ session: sid });
const r2b = await sched.tickOnce({ session: sid });
push('节流生效（every 内不重复）', r2a.fired.includes('throttle-me') && !r2b.fired.includes('throttle-me'), '第一次触发，第二次被节流');

// 9. tick 事件本身也发
push('tick 事件发出', seen.filter(x => x === 'tick').length >= 2, 'tick 出现 ' + seen.filter(x => x === 'tick').length + ' 次');

// 10. store 里事件帧的数量
const s = store.load(sid);
const evFrames = s.frames.filter(f => f.type === 'event');
push('事件帧落进会话', evFrames.length >= 2, evFrames.length + ' 条 event 帧');

try { fs.rmSync(cfg.dataDir, { recursive: true, force: true }); } catch {}

console.log(''); console.log('=== 事件层自检 ==='); console.log('');
console.log(ok.join('\n'));
if (bad.length) { console.log(''); console.log(bad.join('\n')); }
console.log(''); console.log(ok.length + ' 通过 / ' + bad.length + ' 失败'); console.log('');
process.exit(bad.length ? 1 : 0);