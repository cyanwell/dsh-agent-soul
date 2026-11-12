// tools/diagnose-selftest.mjs —— 换气诊断的自检
//
// ★ 重心放**反例**：能不能不误报。
//   判据写错的两个方向，代价不对称：
//     漏报 → 污染还在，但人还能自己看出来；
//     误报 → 人按它去删一段正常的历史，**删掉了就回不来**（本库只追加）。
//   所以反例比正例重要。

import { diagnose, looksFailed, callFingerprint, KIND } from '../src/organs/diagnose.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + JSON.stringify(extra).slice(0, 160) : '')); }
};

const SID = 'session-test';
let n = 0;
const frame = (type, payload = {}) => {
  const f = { seq: ++n, t: 1000 + n, type, meta: { src: 'dsh', seq: n * 10 }, ...payload };
  return f;
};
const reset = () => { n = 0; };

// ── ① looksFailed 的样子 ──────────────────────────────
console.log('\n① 「失败」长什么样');
ok('exit code 1', looksFailed('  [exit code: 1]'));
ok('✗ 开头', looksFailed('✗ 语法'));
ok('Error 开头', looksFailed('Error: code run failed'));
ok('Cannot find', looksFailed('Cannot find module x'));
ok('中文「失败：」', looksFailed('失败：参数不对'));
ok('★ 反例：正常输出不判失败', !looksFailed('✓ 全部通过\nok'));
ok('★ 反例：长文本中间的 Error 不判（只看前 400 字）',
   !looksFailed('✓ 好了\n' + 'x'.repeat(500) + '\nError: 这是日志里引用的一句'));

// ── ② 绕圈：同指纹连续失败 ────────────────────────────
console.log('\n② 绕圈（同一件事用同样方式反复失败）');
{
  reset();
  const f = [frame('session', { id: SID })];
  for (let i = 0; i < 4; i++) {
    f.push(frame('tool_call', { name: 'run_code', args: '{"code":"same"}' , callId: 'c' + i }));
    f.push(frame('tool_result', { callId: 'c' + i, content: '✗ Error: boom' }));
  }
  const r = diagnose(f);
  const spin = r.candidates.filter(c => c.kind === KIND.SPIN);
  ok('4 次同样失败 → 报 1 段绕圈', spin.length === 1, r.stats);
  ok('段里 count = 4', spin[0] && spin[0].count === 4);
  ok('带门牌', spin[0] && spin[0].door.length > 0);
}
{
  // ★ 反例：同样的调用**成功**了 —— 那是正常重复劳动，不该报
  reset();
  const f = [frame('session', { id: SID })];
  for (let i = 0; i < 6; i++) {
    f.push(frame('tool_call', { name: 'run_code', args: '{"code":"same"}', callId: 'k' + i }));
    f.push(frame('tool_result', { callId: 'k' + i, content: '✓ 好了，结果如下…' }));
  }
  const r = diagnose(f);
  ok('★ 反例：同一调用的 6 次成功 → 不报（正常重复劳动）',
     r.candidates.filter(c => c.kind === KIND.SPIN).length === 0, r.stats);
}
{
  // ★ 反例：失败但每次换了办法 —— 那是正常试错，不该报
  reset();
  const f = [frame('session', { id: SID })];
  for (let i = 0; i < 5; i++) {
    f.push(frame('tool_call', { name: 'run_code', args: '{"code":"attempt' + i + '"}', callId: 'd' + i }));
    f.push(frame('tool_result', { callId: 'd' + i, content: '✗ Error: nope' }));
  }
  const r = diagnose(f);
  ok('★ 反例：5 次失败但每次都不同 → 不报（正常试错）',
     r.candidates.filter(c => c.kind === KIND.SPIN).length === 0, r.stats);
}

// ── ③ 空转 ──────────────────────────────────────────
console.log('\n③ 空转（连续几条几乎没有内容）');
{
  reset();
  const f = [frame('session', { id: SID })];
  for (let i = 0; i < 5; i++) f.push(frame('assistant', { text: '好。' }));
  const r = diagnose(f);
  ok('连续 5 条「好。」→ 报 1 段空转', r.candidates.filter(c => c.kind === KIND.EMPTY).length === 1);
}
{
  reset();
  const f = [frame('session', { id: SID })];
  f.push(frame('assistant', { text: '好。' }));
  f.push(frame('assistant', { text: '这是一段正常的、有内容的回答，长度超过阈值。'.repeat(3) }));
  f.push(frame('assistant', { text: '好。' }));
  const r = diagnose(f);
  ok('★ 反例：空转被打断 → 不报（要求连续）',
     r.candidates.filter(c => c.kind === KIND.EMPTY).length === 0);
}

// ── ④ 重复 ──────────────────────────────────────────
console.log('\n④ 重复（同一大段文字多次）');
{
  reset();
  const f = [frame('session', { id: SID })];
  const big = '这是一段足够长的文本。'.repeat(60);   // 660 字
  for (let i = 0; i < 3; i++) f.push(frame('tool_result', { content: big }));
  const r = diagnose(f);
  ok('同一段 660 字出现 3 次 → 报重复', r.candidates.filter(c => c.kind === KIND.REPEAT).length === 1);
}
{
  reset();
  const f = [frame('session', { id: SID })];
  for (let i = 0; i < 8; i++) f.push(frame('tool_result', { content: 'ok' }));
  const r = diagnose(f);
  ok('★ 反例：短输出重复 8 次 → 不报（门槛 400 字）',
     r.candidates.filter(c => c.kind === KIND.REPEAT).length === 0);
}

// ── ⑤ 重影 ──────────────────────────────────────────
console.log('\n⑤ 重影（同一 DSH seq 写了多次）');
{
  reset();
  const f = [frame('session', { id: SID })];
  f.push({ seq: 99, t: 1, type: 'user', text: 'a', meta: { src: 'dsh', seq: 5 } });
  f.push({ seq: 100, t: 1, type: 'user', text: 'a', meta: { src: 'dsh', seq: 5 } });
  const r = diagnose(f);
  const dup = r.candidates.filter(c => c.kind === KIND.DUP);
  ok('同一 seq 写两次 → 报重影', dup.length === 1);
  ok('重影的 why 说「同步器的疤」', dup[0] && /同步器/.test(dup[0].why));
}

// ── ⑥ 干净会话不报 ──────────────────────────────────
console.log('\n⑥ 干净的会话');
{
  reset();
  const f = [frame('session', { id: SID })];
  for (let i = 0; i < 10; i++) {
    f.push(frame('user', { text: '问题 ' + i }));
    f.push(frame('assistant', { text: '这是第 ' + i + ' 个回答，内容各不相同，也有足够的长度来说明事情。'.repeat(2) }));
    f.push(frame('tool_call', { name: 'run_code', args: '{"code":"v' + i + '"}', callId: 'z' + i }));
    f.push(frame('tool_result', { callId: 'z' + i, content: '✓ 结果 ' + i }));
  }
  const r = diagnose(f);
  ok('★ 反例：10 轮各不相同的正常对话 → 0 候选', r.candidates.length === 0, r.stats);
}

// ── ⑦ 边界 ──────────────────────────────────────────
console.log('\n⑦ 边界');
ok('空数组不炸', diagnose([]).candidates.length === 0);
// ★ 2026-11-07 补：`null` 这条**抓出过两次同一个 bug**（都是某段代码用了原参数 frames 而不是 all）。
//   所以单独留一条，把「每段都走 all」这件事钉住。
ok('★ null 时四档判据都不炸（抓过两次同一个 bug）', (() => {
  try { const r = diagnose(null); return r.candidates.length === 0 && r.frames === 0; } catch (e) { return false; }
})());
ok('null 不炸', diagnose(null).candidates.length === 0);
ok('没有 session 帧时 sid 为空字符串', diagnose([{ seq: 1, type: 'user', text: 'x' }]).sessionId === '');
ok('没有 meta.seq 时门牌为空数组不炸',
   (() => { const r = diagnose([{ seq: 1, type: 'assistant', text: '好。' }, { seq: 2, type: 'assistant', text: '嗯。' }, { seq: 3, type: 'assistant', text: '对。' }, { seq: 4, type: 'assistant', text: '是。' }]);
            return r.candidates.every(c => Array.isArray(c.door)); })());

console.log('\n通过 ' + pass + ' 项 · 失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
