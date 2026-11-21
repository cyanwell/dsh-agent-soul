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

// ══════════════════════════════════════════════════════════════════════
// 9. 干预链（task-9 · 2026-11-17）：编号桥 + 区间展开 + 诚实聚合
//    ★ 这一节全是**回归测试**：每一条对应一处已经确认过的缺陷。
// ══════════════════════════════════════════════════════════════════════
{
  const T = await import('../src/organs/huanqi-targets.mjs');
  const { intervene } = await import('../src/agent/huanqi-intervene.mjs');
  const { annotateRanges } = await import('../src/adapters/huanqi-scan.mjs');
  const { analyzeContext, PURGEABLE_TYPES } = await import('../src/organs/huanqi-llm.mjs');

  // 一帧真实形状的会话：v4 帧 seq 0..8，meta.seq 是宿主事件号（13,14,20,26,...）
  const mkFrame = (seq, type, extra) => ({ seq, type, text: 'x' + seq, meta: { src: 'dsh', seq: 12 + seq * 2 }, ...(extra || {}) });
  const FRAMES = [
    { seq: 0, type: 'session', text: 'header' },                       // ← 没有 meta.seq（会话头本来就没有）
    mkFrame(1, 'user', { meta: { src: 'dsh', seq: 13 } }),
    mkFrame(2, 'assistant', { meta: { src: 'dsh', seq: 16 } }),
    mkFrame(3, 'tool_result', { meta: { src: 'dsh', seq: 26 } }),
    mkFrame(4, 'assistant', { meta: { src: 'dsh', seq: 28 } }),
    mkFrame(5, 'tool_result', { meta: { src: 'dsh', seq: 36 } }),
    mkFrame(6, 'tool_result', { meta: { src: 'dsh', seq: 44 } }),
  ]

  // ── 9.1 编号桥：v4 帧 seq ≠ 宿主 seq，映射只认 meta.seq（缺陷⑤）
  const map = T.buildSeqMap(FRAMES)
  push('9.1a 编号表能建出来', map.ok === true, '映射 ' + map.byV4.size + ' 条 / 缺 meta.seq ' + map.noHostSeq.length + ' 帧')
  push('9.1b ★ 映射给的是宿主 seq（不是帧 seq）', map.byV4.get(3).hostSeq === 26 && map.byV4.get(3).v4Seq === 3, 'v4 seq 3 → 宿主 seq ' + map.byV4.get(3).hostSeq)
  push('9.1c 会话头没有 meta.seq → 记进缺口（不拿 0 顶替）', map.noHostSeq.length === 1 && map.noHostSeq[0] === 0, JSON.stringify(map.noHostSeq))

  const noMeta = T.buildSeqMap([{ seq: 1, type: 'tool_result', text: 'a' }, { seq: 2, type: 'tool_result', text: 'b' }])
  push('9.1d ★ 全都没 meta.seq → fail-closed（不退回帧序号）', noMeta.ok === false && /拒绝/.test(noMeta.why), noMeta.why)

  // ── 9.2 区间展开：标 3 帧就要清 3 帧（缺陷①）
  const ranges = [{ start: 3, end: 6, kinds: ['loop'], reasons: ['同一条命令试了三次'] }]
  const ex = T.expandRanges(ranges, map, { maxTargets: 40 })
  push('9.2a ★ 区间 3–6 展开成 3 条（tool_result 3/5/6），不是 1 条',
    ex.targets.length === 3 && ex.targets.map((t) => t.hostSeq).join(',') === '26,36,44',
    '宿主 seq = ' + ex.targets.map((t) => t.hostSeq).join(','))
  push('9.2b 混在区间里的 assistant 帧被跳过并记下类型',
    ex.skipped.length === 1 && ex.skipped[0].skippedByType.assistant === 1,
    JSON.stringify(ex.skipped[0] ? ex.skipped[0].skippedByType : null))

  const onlyAssistant = T.expandRanges([{ start: 4, end: 4, kinds: ['loop'], reasons: ['x'] }], map)
  push('9.2c 一整段都不可清 → 整段 rejected，并说清跳过了什么（缺陷②）',
    onlyAssistant.targets.length === 0 && onlyAssistant.rejected.length === 1 && /assistant/.test(onlyAssistant.rejected[0].why),
    onlyAssistant.rejected[0] ? onlyAssistant.rejected[0].why : '')
  const scanRanges = annotateRanges([{ start: 3, end: 3 }], FRAMES)
  push('9.2d scan 保留区间诊断但不暴露 hostSeq/hostSeqs',
    scanRanges[0].executionAvailable === false && scanRanges[0].provenance === 'unverified' && !Object.hasOwn(scanRanges[0], 'hostSeq') && !Object.hasOwn(scanRanges[0], 'hostSeqs') && scanRanges[0].mappedCandidates === 1, JSON.stringify(scanRanges[0]))
  const hostileScan = annotateRanges([{ start: 3, end: 3, kinds: ['loop'], reasons: ['fixture'], hostSeq: 777, hostSeqs: [777, 778], arbitrary: 'must not echo' }], FRAMES)[0]
  push('9.2e scan hostile range identifiers are not propagated',
    !Object.hasOwn(hostileScan, 'hostSeq') && !Object.hasOwn(hostileScan, 'hostSeqs') && !Object.hasOwn(hostileScan, 'arbitrary') && hostileScan.start === 3 && hostileScan.end === 3 && hostileScan.kinds[0] === 'loop' && hostileScan.reasons[0] === 'fixture', JSON.stringify(hostileScan))

  // ── 9.3 占位帧不再进候选（缺陷④：越清越脏的循环）
  const PLACEHOLDER = '[换气] 定点清除 seq 26（原因：同一件事试了三次）\n原文可取回：log:sess-x#seq=26\n（这是清除留下的占位，不是压缩摘要。）'
  push('9.3a 认得出 bridge 的占位文本', T.isPlaceholderText(PLACEHOLDER) === true, null)
  push('9.3b 认得出 v3 的旧占位写法（原文可取回 log: 没有冒号）', T.isPlaceholderText('[换气] 定点清除 seq 9（原文可取回 log:s#seq=9）') === true, null)
  push('9.3c 正常工具输出不会被误判成占位', T.isPlaceholderText('npm ERR! code ENOENT') === false, null)
  const withPh = { ...map, byV4: new Map(map.byV4) }
  withPh.byV4.set(7, { v4Seq: 7, hostSeq: 52, type: 'tool_result' })
  const exPh = T.expandRanges([{ start: 7, end: 7 }], withPh)
  push('9.3d 占位帧**仍然**可展开（占位识别在帧级，不在展开里）—— 语义分层不混', exPh.targets.length === 1, null)

  // ── 9.4 诚实聚合（缺陷③）
  const s1 = T.summarizeResults([{ ok: true }, { ok: false, why: 'type=assistant' }])
  push('9.4a ★ 2 条成 1 条 → partial，且 ok=false（不再报成功）', s1.stage === 'partial' && s1.ok === false, s1.stage + ' / ' + s1.okCount + '成' + s1.failCount + '败')
  const s2 = T.summarizeResults([{ ok: true }, { ok: true }])
  push('9.4b 全成 → cleaned', s2.stage === 'cleaned' && s2.ok === true, s2.stage)
  const s3 = T.summarizeResults([{ ok: false, why: 'a' }, { ok: false, why: 'b' }])
  push('9.4c 全败 → clean-failed', s3.stage === 'clean-failed' && s3.ok === false, s3.stage)
  const s4 = T.summarizeResults([{ ok: true, dryRun: true }])
  push('9.4d ★ dryRun 不算清理成功（只诊断）', s4.stage === 'diagnosed-only' && s4.ok === false, s4.stage)

  // ── 9.5 端到端：intervene 真的按宿主 seq 逐条调 purge
  const calls = []
  const fakeStore = { recent: () => FRAMES }
  let promptChecked = 0   // ★ 只断言一次：这个假 LLM 会被多次调用，重复 push 会把账算重
  const fakeLlm = {
    ready: () => true,
    chat: async (msgs) => {
      if (promptChecked++ === 0) {
        const sys = String(msgs[0].content)
        push('9.5a ★ 提示词里写明了只许标 tool_result', /只有 \(tool_result\) 类型的帧可以被清理/.test(sys), sys.match(/只有 \(tool_result\)[^\n]{0,30}/) ? sys.match(/只有 \(tool_result\)[^\n]{0,30}/)[0] : '')
        const user = String(msgs[1].content)
        push('9.5b ★ 送给模型的正文里没有 assistant 帧（只给可动的集合）',
          user.includes('[3] (tool_result)') && !user.includes('(assistant)'),
          'prompt 里出现的类型：' + (user.match(/\((\w+)\)/g) || []).join(''))
      }
      return JSON.stringify({ polluted: true, ranges: [{ start: 3, end: 6, kind: 'loop', reason: '同一条命令试了三次' }], confidence: 0.9 })
    },
  }
  const run1 = await intervene({
    sessionId: 'sess-x', store: fakeStore, llm: fakeLlm,
    purge: async ({ startSeq, endSeq }) => { calls.push(startSeq + '-' + endSeq); return { ok: true, purgedCount: 1, purged: [{ start: startSeq }] } },
  })
  push('9.5c ★ 端到端：未验证映射时 purge 不调用', calls.length === 0 && run1.stage === 'provenance-unverified', 'calls=' + calls.length + ' / ' + run1.stage)
  push('9.5d 不报 cleaned 且目标不含 hostSeq', run1.ok === false && run1.stage !== 'cleaned' && run1.targets.every((t) => !Object.hasOwn(t, 'hostSeq')), run1.stage)
  push('9.5e 分析仅看可清类型，区间仍覆盖 v4 帧 3/5/6', run1.analyzed === 3 && run1.filteredOut === 4 && run1.targets.map((t) => t.v4Seq).join(',') === '3,5,6', 'analyzed=' + run1.analyzed + ' targets=' + run1.targets.map((t) => t.v4Seq).join(','))

  // ── 9.6 端到端：一条失败 → 不许报 cleaned
  const calls2 = []
  const run2 = await intervene({
    sessionId: 'sess-x', store: fakeStore, llm: fakeLlm,
    purge: async ({ startSeq }) => {
      calls2.push(startSeq)
      return startSeq === 36 ? { ok: false, error: 'type=assistant（只动 tool/result）' } : { ok: true, purgedCount: 1 }
    },
  })
  push('9.6a ★ provenance 未验证时，不按 fake purge 结果计算 partial/cleaned', calls2.length === 0 && run2.stage === 'provenance-unverified' && run2.ok === false, run2.stage + ' / calls=' + calls2.length)
  push('9.6b 所有候选目标都不暴露 hostSeq', run2.targets.length === 3 && run2.targets.every((t) => !Object.hasOwn(t, 'hostSeq')), JSON.stringify(run2.targets))

  // ── 9.7 端到端：dryRun 不许记成 cleaned
  const run3 = await intervene({
    sessionId: 'sess-x', store: fakeStore, llm: fakeLlm,
    purge: async () => ({ ok: true, dryRun: true }),
  })
  push('9.7 ★ provenance 未验证优先于 dryRun：stage 不会伪报诊断清理', run3.stage === 'provenance-unverified' && run3.ok === false, run3.stage)

  // ── 9.8 端到端：没有宿主 ⇒ 明说，且不改 stage 冒充成功
  const run4 = await intervene({ sessionId: 'sess-x', store: fakeStore, llm: fakeLlm })
  push('9.8 无论 purge 通道是否存在，未验证来源都不可执行', run4.stage === 'provenance-unverified' && run4.executionAvailable === false, run4.reason.slice(0, 80))

  // ── 9.9 端到端：帧没有 meta.seq ⇒ fail-closed，一次 purge 都不调
  let calls5 = 0
  const run5 = await intervene({
    sessionId: 'sess-y',
    store: { recent: () => [{ seq: 1, type: 'tool_result', text: 'a' }, { seq: 2, type: 'tool_result', text: 'b' }] },
    llm: fakeLlm,
    purge: async () => { calls5++; return { ok: true } },
  })
  push('9.9 ★ 缺 meta.seq → no-seq-map，purge 不调用',
    run5.stage === 'no-seq-map' && calls5 === 0, run5.stage + ' / calls=' + calls5)

  // ── 9.9a 任意手造 meta.seq/src 均不能授权 purge ──
  for (const [label, meta] of [['src=dsh', { src: 'dsh', seq: 26 }], ['src缺失', { seq: 26 }], ['foreign src', { src: 'other', seq: 26 }]]) {
    let calls = 0
    const result = await intervene({
      sessionId: 'synthetic-' + label,
      store: { recent: () => [{ seq: 1, type: 'tool_result', text: 'synthetic', meta }] },
      llm: { ready: () => true, chat: async () => JSON.stringify({ polluted: true, ranges: [{ start: 1, end: 1, kind: 'loop', reason: 'fixture' }] }) },
      purge: async () => { calls += 1; return { ok: true } },
    })
    push('9.9a ' + label + ' 手造 meta.seq/src 不授权 purge', calls === 0 && result.stage === 'provenance-unverified', 'calls=' + calls + ' / ' + result.stage)
    push('9.9b ' + label + ' 不输出可操作 hostSeq', result.targets.length === 1 && !Object.hasOwn(result.targets[0], 'hostSeq') && result.executionAvailable === false, JSON.stringify(result.targets))
  }

  // ── 9.10 端到端：占位帧不进分析窗口
  const withPlaceholder = FRAMES.concat([{ seq: 7, type: 'tool_result', text: PLACEHOLDER, meta: { src: 'dsh', seq: 52 } }])
  let seenPrompt = ''
  const run6 = await intervene({
    sessionId: 'sess-z',
    store: { recent: () => withPlaceholder },
    llm: { ready: () => true, chat: async (m) => { seenPrompt = String(m[1].content); return JSON.stringify({ polluted: false, ranges: [] }) } },
    purge: async () => ({ ok: true }),
  })
  push('9.10 ★ 已清占位帧不再送给 LLM（缺陷④）',
    !seenPrompt.includes('[7]') && run6.alreadyCleared === 1, 'alreadyCleared=' + run6.alreadyCleared)

  // ── 9.11 analyzeContext 自身：onlyTypes 的边界
  const r11 = await analyzeContext({ llm: { ready: () => true, chat: async () => '{}' }, frames: FRAMES, onlyTypes: PURGEABLE_TYPES })
  push('9.11a analyzeContext(onlyTypes) 过滤掉非可清帧', r11.ok === true && r11.analyzed === 3 && r11.filteredOut === 4, 'analyzed=' + r11.analyzed + ' filteredOut=' + r11.filteredOut)
  const r12 = await analyzeContext({ llm: { ready: () => true, chat: async () => '{}' }, frames: [FRAMES[1], FRAMES[2]], onlyTypes: PURGEABLE_TYPES })
  push('9.11b 一条可清帧都没有 → 明说，不拿别的类型凑数', r12.ok === false && /没有「可清理类型」/.test(r12.error), r12.error)
}

console.log(''); console.log('=== huanqi（换气）迁移自检 ==='); console.log('');
console.log(ok.join('\n'));
if (bad.length) { console.log(''); console.log(bad.join('\n')); }
console.log(''); console.log(ok.length + ' 通过 / ' + bad.length + ' 失败'); console.log('');
process.exit(bad.length ? 1 : 0);