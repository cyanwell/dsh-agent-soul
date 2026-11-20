// 自检：/api/health 的 ECHO 摘要 —— aligned 必须是三态（TEMP / mock，纯函数）
//
// 判据：true → true，false → false，缺失 / 其它 → null。
// ★ 为什么缺失不能压成 false：false 在契约里是「读到了、没对齐」，缺失是「不知道」。
//   把「不知道」写成「没对齐」，就是死读数 —— 本项目为这类读数付过代价。
// ★ 这个文件不起服务、不读配置、不碰 DB / 文件 / 网络：只 import 一个函数，注入假 store。
import { echoHealthSummary } from '../src/web/server.mjs';

let pass = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { pass++; console.log('✓ ' + name); return; }
  const line = name + (detail === undefined ? '' : '  → ' + detail);
  failures.push(line);
  console.log('✗ ' + line);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

function eq(name, actual, expected) {
  ok(name + ' = ' + JSON.stringify(expected), deepEqual(actual, expected), '实际 ' + JSON.stringify(actual));
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

function leaksIn(out, needles) {
  const s = JSON.stringify(out);
  return needles.filter((n) => s.includes(n));
}

// 回退形状是契约的一部分：字段集合与顺序之外的任何增减都算破坏。
const UNKNOWN = { available: false, aligned: null, ok: null, searchable: null, counts: null, problemKinds: [], reason: 'Store unavailable' };
const UNAVAILABLE = { available: false, aligned: null, ok: null, searchable: null, counts: null, problemKinds: [], reason: 'ECHO index unavailable' };
const THROWN = { available: false, aligned: null, ok: null, searchable: null, counts: null, problemKinds: [], reason: 'ECHO stats read failed' };

// ─────────────────────────────────────────────────────────────────────
// 1. 没有 store / 没有 echoStats → available:false, aligned:null
// ─────────────────────────────────────────────────────────────────────
for (const [label, fakeStore] of [
  ['null', null],
  ['undefined', undefined],
  ['空对象 {}', {}],
  ['echoStats 不是函数', { echoStats: 'not-a-function' }],
]) {
  const out = echoHealthSummary(fakeStore);
  eq('缺 store（' + label + '）· available', out.available, false);
  eq('缺 store（' + label + '）· aligned', out.aligned, null);
  eq('缺 store（' + label + '）· 整份回退对象', out, UNKNOWN);
}

// ─────────────────────────────────────────────────────────────────────
// 2. store 在、但索引不可用：hostile why 必须被固定理由替换，且不脱敏失败漏字
// ─────────────────────────────────────────────────────────────────────
{
  const hostileStats = deepFreeze({
    available: false,
    why: 'secret path D:/private token=abc123',
    error: 'secret path D:/private',
    reason: 'secret reason that must never surface',
  });
  const fakeStore = deepFreeze({ echoStats: () => hostileStats });
  const before = JSON.stringify(hostileStats);
  const fnRef = fakeStore.echoStats;
  const out = echoHealthSummary(fakeStore);

  eq('不可用 store（hostile why）· reason 固定', out.reason, 'ECHO index unavailable');
  eq('不可用 store（hostile why）· aligned', out.aligned, null);
  eq('不可用 store（hostile why）· available', out.available, false);
  eq('不可用 store（hostile why）· 整份回退对象', out, UNAVAILABLE);
  eq('不可用 store（hostile why）· 泄漏检查', leaksIn(out, ['secret', 'D:/private', 'token=', 'abc123']), []);
  ok('不可用 store（hostile why）· 输入 stats 未被修改', JSON.stringify(hostileStats) === before);
  ok('不可用 store（hostile why）· 假 store 未被修改', fakeStore.echoStats === fnRef);
}

// ─────────────────────────────────────────────────────────────────────
// 3. echoStats 抛错：固定理由，异常里的路径 / 秘密不外泄
// ─────────────────────────────────────────────────────────────────────
{
  const throwers = [
    ['Error', () => { throw new Error('secret path D:/private token=abc123'); }],
    ['字符串', () => { throw 'secret path D:/private'; }],
    ['带附加字段的 Error', () => { const e = new Error('secret path D:/private'); e.code = 'secret-code'; throw e; }],
  ];
  for (const [label, echoStats] of throwers) {
    const fakeStore = deepFreeze({ echoStats });
    const fnRef = fakeStore.echoStats;
    const out = echoHealthSummary(fakeStore);
    eq('抛错 store（' + label + '）· reason 固定', out.reason, 'ECHO stats read failed');
    eq('抛错 store（' + label + '）· aligned', out.aligned, null);
    eq('抛错 store（' + label + '）· 整份回退对象', out, THROWN);
    eq('抛错 store（' + label + '）· 泄漏检查', leaksIn(out, ['secret', 'D:/private', 'abc123']), []);
    ok('抛错 store（' + label + '）· 假 store 未被修改', fakeStore.echoStats === fnRef);
  }
}

// 带输入快照的可用分支：同时证明注入对象没被碰过
function runWithStats(label, stats) {
  const before = JSON.stringify(stats);
  const fakeStore = deepFreeze({ echoStats: () => stats });
  const fnRef = fakeStore.echoStats;
  const out = echoHealthSummary(fakeStore);
  ok(label + ' · 输入 stats 未被修改', JSON.stringify(stats) === before, '前 ' + before + ' / 后 ' + JSON.stringify(stats));
  ok(label + ' · 假 store 未被修改（echoStats 仍是同一个函数）', fakeStore.echoStats === fnRef);
  ok(label + ' · 返回值是新对象（不是 stats 本身）', out !== stats && out !== fakeStore);
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// 4. 健康：aligned:true 仍是 true，其它字段的既有口径不变
// ─────────────────────────────────────────────────────────────────────
{
  const stats = {
    available: true,
    aligned: true,
    ok: true,
    searchable: true,
    words: 12,
    summaries: 3,
    problems: [{ kind: 'stale' }, { kind: 'missing' }, { kind: 'stale' }, null, {}, { kind: '' }],
  };
  const out = runWithStats('健康 store（aligned:true）', deepFreeze(stats));
  eq('健康 store（aligned:true）· aligned', out.aligned, true);
  eq('健康 store（aligned:true）· available', out.available, true);
  eq('健康 store（aligned:true）· ok', out.ok, true);
  eq('健康 store（aligned:true）· searchable', out.searchable, true);
  eq('健康 store（aligned:true）· counts', out.counts, { words: 12, summaries: 3, problems: 6 });
  eq('健康 store（aligned:true）· problemKinds（去重 + 排序）', out.problemKinds, ['missing', 'stale']);
}

// ─────────────────────────────────────────────────────────────────────
// 5. 过期：aligned:false 仍是 false（不能因为「缺省给 null」把明确的 false 也吃掉）
// ─────────────────────────────────────────────────────────────────────
{
  const stats = { available: true, aligned: false, ok: false, searchable: false, words: 0, summaries: 0, problems: [] };
  const out = runWithStats('过期 store（aligned:false）', deepFreeze(stats));
  eq('过期 store（aligned:false）· aligned', out.aligned, false);
  eq('过期 store（aligned:false）· ok', out.ok, false);
  eq('过期 store（aligned:false）· searchable', out.searchable, false);
  eq('过期 store（aligned:false）· counts', out.counts, { words: 0, summaries: 0, problems: 0 });
}

// ─────────────────────────────────────────────────────────────────────
// 6. 核心回归：其它健康字段都是 true，但 aligned 缺失 / undefined → null（不是 false）
// ─────────────────────────────────────────────────────────────────────
{
  const statsNoKey = { available: true, ok: true, searchable: true, words: 5, summaries: 1, problems: [] };
  const outNoKey = runWithStats('缺 aligned 键（其余 true）', deepFreeze(statsNoKey));
  eq('缺 aligned 键（其余 true）· aligned', outNoKey.aligned, null);
  eq('缺 aligned 键（其余 true）· ok', outNoKey.ok, true);
  eq('缺 aligned 键（其余 true）· searchable', outNoKey.searchable, true);
  eq('缺 aligned 键（其余 true）· available', outNoKey.available, true);
  ok('缺 aligned 键（其余 true）· 不能是 false', outNoKey.aligned !== false);

  const statsUndef = { available: true, aligned: undefined, ok: true, searchable: true, words: 5, summaries: 1, problems: [] };
  const outUndef = runWithStats('aligned === undefined（其余 true）', deepFreeze(statsUndef));
  eq('aligned === undefined（其余 true）· aligned', outUndef.aligned, null);
  eq('aligned === undefined（其余 true）· ok', outUndef.ok, true);
  eq('aligned === undefined（其余 true）· searchable', outUndef.searchable, true);
  ok('aligned === undefined（其余 true）· 不能是 false', outUndef.aligned !== false);
}

// ─────────────────────────────────────────────────────────────────────
// 7. 非布尔值的 aligned：一律 null（不做真假强转）
// ─────────────────────────────────────────────────────────────────────
for (const [label, value] of [
  ['null', null],
  ['字符串 "true"', 'true'],
  ['字符串 "false"', 'false'],
  ['数字 1', 1],
  ['数字 0', 0],
  ['空对象', {}],
  ['空数组', []],
  ['NaN', NaN],
]) {
  const stats = deepFreeze({ available: true, aligned: value, ok: true, searchable: true, words: 1, summaries: 1, problems: [] });
  const out = echoHealthSummary({ echoStats: () => stats });
  eq('aligned 为 ' + label + ' · aligned', out.aligned, null);
}

// ─────────────────────────────────────────────────────────────────────
// 8. 未改动的口径：available 必须是真 true、counts 非数字落 null、problems 非数组按 0
// ─────────────────────────────────────────────────────────────────────
{
  const outNotTrue = echoHealthSummary({ echoStats: () => ({ available: 1, aligned: true }) });
  eq('available 为 1（非 true）· reason', outNotTrue.reason, 'ECHO index unavailable');
  eq('available 为 1（非 true）· aligned', outNotTrue.aligned, null);

  const badCounts = echoHealthSummary({
    echoStats: () => ({ available: true, aligned: null, ok: false, searchable: false, words: '12', summaries: NaN, problems: 'nope' }),
  });
  eq('counts 非数字 · words', badCounts.counts.words, null);
  eq('counts 非数字 · summaries', badCounts.counts.summaries, null);
  eq('problems 非数组 · problems', badCounts.counts.problems, 0);
  eq('problems 非数组 · problemKinds', badCounts.problemKinds, []);
  eq('problems 非数组 · ok/searchable 仍是布尔', [badCounts.ok, badCounts.searchable], [false, false]);
}

// ─────────────────────────────────────────────────────────────────────
// 9. 两次调用互不共享对象（回退常量也不会被上一次调用改脏）
// ─────────────────────────────────────────────────────────────────────
{
  const a = echoHealthSummary(null);
  const b = echoHealthSummary(null);
  ok('两次缺 store 调用返回不同对象', a !== b);
  const c = echoHealthSummary({ echoStats: () => ({ available: true, aligned: true, ok: true, searchable: true }) });
  const d = echoHealthSummary({ echoStats: () => ({ available: true, aligned: true, ok: true, searchable: true }) });
  ok('两次健康调用返回不同对象', c !== d);
  c.problemKinds.push('poison');
  ok('改动一次结果不影响另一次', d.problemKinds.length === 0);
}

console.log('');
console.log(failures.length ? '失败 ' + failures.length + ' 条 / 通过 ' + pass + ' 条' : '全部通过：' + pass + ' 条断言');
if (failures.length) {
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
