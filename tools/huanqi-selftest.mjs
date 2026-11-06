import { grams, repeatRatio, containment, countRepeatedText, trailingCycle, periodicTailSpan, HuanqiDetector, STALL } from '../src/organs/huanqi.mjs';
const ok = []; const bad = [];
const push = (n, c, e) => (c ? ok : bad).push((c ? '✓ ' : '✗ ') + n + (e ? '  → ' + e : ''));

// —— 真实形状的测试数据 ——

// ① 真实病征：README 里写的那种低熵重复
const BLEED = ('好。执行。好。执行。').repeat(300);

// ② 正常中文推理（不循环）
const NORMAL = '我需要先拆开 transport 层和 renderer 层。如果 transport 是独立的，那 desktop 的实现应该也能复用。'.repeat(4);

// ③ 真实的 markdown 表格（40 行，看起来重复度很高）
const TABLE = (() => {
  const rows = ['| 模块 | 行数 | 状态 |', '|---|---|---|'];
  for (let i = 0; i < 40; i++) rows.push('| module-' + i + ' | ' + (100 + i) + ' | ✓ |');
  return rows.join('\n');
})();

// ④ 真实的日志（60 行，格式一样但内容不同）
const LOG = (() => {
  const ls = [];
  for (let i = 0; i < 60; i++) ls.push('2026-11-07 01:' + String(i % 60).padStart(2, '0') + ':00 INFO tick=' + i + ' handled=' + (i * 3));
  return ls.join('\n');
})();

// ⑤ 分隔线（合法的长横线，不该判成循环）
const RULE = '正文内容结束。\n' + '-'.repeat(800);

push('测数据长度', BLEED.length > 2000 && TABLE.length > 800, 'bleed ' + BLEED.length + 'B / 表格 ' + TABLE.length + 'B / 日志 ' + LOG.length + 'B');

// —— 1. grams / containment ——
const g1 = grams('abcdabcdabcd');
push('grams 去重', g1.size === 4, '4 个不同 4-gram');
push('containment 自比 = 1', containment(g1, g1) === 1);
const gA = grams('这是第一步的材料，我要处理传输层。');
const gB = grams('这是第一步的材料，我要处理传输层。然后再补一句。');
push('containment 识别「重述+补一句」', containment(gA, gB) > 0.8, 'containment=' + containment(gA, gB).toFixed(3));

// —— 2. repeatRatio 是诊断量，不是判据（这条本身是回归测试）——
const rBleed = repeatRatio(BLEED);
const rTable = repeatRatio(TABLE);
const rLog = repeatRatio(LOG);
push('★ repeatRatio：循环文本接近 1', rBleed > 0.98, rBleed.toFixed(3));
push('★ repeatRatio：正常表格也不低（所以不能当判据）', rTable > 0.5, '表格 ' + rTable.toFixed(3) + ' ← 这正是它被降级为诊断量的原因');
push('★ repeatRatio：日志同样偏高', rLog > 0.5, '日志 ' + rLog.toFixed(3));

// —— 3. trailingCycle 是判据（精确重复才认）——
const cBleed = trailingCycle(BLEED, 512, 512);
const cTable = trailingCycle(TABLE, 512, 512);
const cLog = trailingCycle(LOG, 512, 512);
const cRule = trailingCycle(RULE, 512, 512);
const cNormal = trailingCycle(NORMAL, 512, 512);
push('★ trailingCycle：循环文本命中', cBleed >= 512, 'span=' + cBleed);
push('★ trailingCycle：markdown 表格 = 0', cTable === 0, '表格被判为非循环（repeatRatio 却是 ' + rTable.toFixed(2) + '）');
push('★ trailingCycle：日志 = 0', cLog === 0);
push('★ trailingCycle：长横线 = 0（单字符周期被排除）', cRule === 0);
push('★ trailingCycle：正常推理 = 0', cNormal === 0);

// —— 4. 真实跨度 ——
const realSpan = periodicTailSpan(BLEED, 512, 512);
push('periodicTailSpan 报真实跨度', realSpan > cBleed, '判定值 ' + cBleed + ' → 真实 ' + realSpan);

// —— 5. countRepeatedText ——
push('countRepeatedText 连击 3', countRepeatedText(['a', 'x', 'x', 'x']) === 3);
push('countRepeatedText 无连击 = 1', countRepeatedText(['a', 'b']) === 1);

// —— 6. 判定器：真实病征 ——
const d = new HuanqiDetector();
const r1 = d.observe({ hasOutput: false, reasoning: '思考中…'.repeat(200) });
push('第 1 次纯推理不判死', !r1.stalled || r1.reason === STALL.REASONING_ONLY, 'reason=' + r1.reason);
d.observe({ hasOutput: false, reasoning: '思考中…'.repeat(200) + '再想一下' });
const r3 = d.observe({ hasOutput: false, reasoning: '思考中…'.repeat(200) + '再想两下' });
push('★ 连续三次纯推理 → 该断', d.shouldBreak(), '连续 ' + r3.consecutive + ' 次，阈值 ' + d.stallThreshold);

// —— 7. 判定器：正常调用不误报 ——
const d2 = new HuanqiDetector();
d2.observe({ hasOutput: true, reasoning: '先看 transport 层，它是独立的。' });
const n2 = d2.observe({ hasOutput: true, reasoning: '然后是 renderer，它依赖 slot 树。' });
const n3 = d2.observe({ hasOutput: true, reasoning: '最后是存储，它跟浏览器无关。' });
push('★ 三次正常推理不误报', !n2.stalled && !n3.stalled, '两次都没判死');

// —— 8. 判定器：重述也抓 ——
// ★ 注意：这里必须用 hasOutput: true。
//   reasoning-only（完全没输出）优先级更高，hasOutput:false 会先命中它。
//   两个原因是「或」的关系，不是「且」—— 没输出是最硬的信号，先报它。
const d3 = new HuanqiDetector();
const SAME = '这一步要做的是：把 transport 层拆出来，确认它不依赖 renderer。'.repeat(2);
d3.observe({ hasOutput: true, reasoning: SAME });
const rep = d3.observe({ hasOutput: true, reasoning: SAME + '嗯。' });
push('★ 重述上一次材料被识别（有输出但没推进）', rep.stalled && rep.reason === STALL.REPEATED_MATERIAL, 'reason=' + rep.reason);

// 优先级回归：没输出时，reasoning-only 优先于 repeated-material
const d4 = new HuanqiDetector();
d4.observe({ hasOutput: true, reasoning: SAME });
const pri = d4.observe({ hasOutput: false, reasoning: SAME + '嗯。' });
push('★ 优先级：没输出时报 reasoning-only', pri.reason === STALL.REASONING_ONLY, 'reason=' + pri.reason + '（两个条件同时成立，取更硬的那个）');

console.log(''); console.log('=== huanqi（换气）迁移自检 ==='); console.log('');
console.log(ok.join('\n'));
if (bad.length) { console.log(''); console.log(bad.join('\n')); }
console.log(''); console.log(ok.length + ' 通过 / ' + bad.length + ' 失败'); console.log('');
process.exit(bad.length ? 1 : 0);