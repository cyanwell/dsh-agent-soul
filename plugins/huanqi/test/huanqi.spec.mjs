/**
 * 换气层（huanqi）的对照测试。
 *
 * 那些 `*.spec.mjs` 是**回归**（证明 fork 之后没弄坏原来的检测）；
 * 这一份是**新功能的对照**：额度怎么扣、怎么攒、什么时候熔断，
 * 以及隔离是否真的成立。
 *
 * ★ 最后一条 test 是**正对照**。没有它，前面那些全绿说明不了任何事 ——
 * 一组"永远通过"的断言和一组"真的在检查"的断言，在输出上长得一模一样。
 * 所以这里故意造一个坏账本，要求同一组断言把它抓出来。
 * （同一条纪律的来源：本机 2026-10-02 在 phone-node 上踩过一个
 * "拒绝被当成放行"的 bug，检测法也假通过了 —— 从那以后正对照是硬要求。）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CreditLedger, Config } from '../lib/index.js'

/* ────────────────────────── 额度层 ────────────────────────── */

test('额度：初始就等于上限', () => {
  const l = new CreditLedger(4)
  assert.equal(l.credit, 4)
  assert.equal(l.creditMax, 4)
  assert.equal(l.normalTurns, 0)
  assert.ok(l.canContinue(), '刚起来的时候必须能用')
})

test('额度：用一次掉一点，降到 0 就不再降（不会负）', () => {
  const l = new CreditLedger(2)
  assert.equal(l.spendContinuation(), 1)
  assert.equal(l.spendContinuation(), 0)
  assert.equal(l.spendContinuation(), 0, '★ 已经是 0 了，再花还是 0 —— 不许变成负数')
  assert.equal(l.credit, 0)
  assert.equal(l.canContinue(), false, '★ 额度 0 = 不能再续命，这正是熔断的入口')
})

test('额度：正常轮攒够阈值，涨 1 点', () => {
  const l = new CreditLedger(4)
  l.spendContinuation()
  l.spendContinuation()
  assert.equal(l.credit, 2)
  // 阈值 3：前两轮不涨，第三轮涨
  assert.equal(l.onNormalTurn(3), false)
  assert.equal(l.onNormalTurn(3), false)
  assert.equal(l.onNormalTurn(3), true, '第三轮该涨了')
  assert.equal(l.credit, 3)
})

test('额度：涨不过上限（天花板不是充值）', () => {
  const l = new CreditLedger(2)
  for (let i = 0; i < 20; i++) l.onNormalTurn(1)
  assert.equal(l.credit, 2, '★ 攒再多也顶到上限为止')
})

test('额度：★ 上限调高不充值，只抬高天花板', () => {
  const l = new CreditLedger(2)
  l.spendContinuation()
  l.spendContinuation()
  assert.equal(l.credit, 0)
  l.reconcileMax(8)
  assert.equal(l.creditMax, 8)
  assert.equal(l.credit, 0, '★ 这是爀曦 2026-10-10 亲口定的：上限是天花板，不是充值')
})

test('额度：上限调低要当场压下来', () => {
  const l = new CreditLedger(8)
  assert.equal(l.credit, 8)
  l.reconcileMax(3)
  assert.equal(l.credit, 3, '★ 不然"上限"比当前额度还小，语义就崩了')
})

test('额度：扣分不会把额度打到 1 以下（地板 = 1）', () => {
  const l = new CreditLedger(4)
  for (let i = 0; i < 10; i++) l.penalise(Date.now())
  assert.equal(l.credit, 1, '★ 到 1 就停手 —— 再降等于彻底关掉自己，而那时最需要它说话')
})

test('额度：`maxContinuations = 0` 时整个换气层关掉', () => {
  const l = new CreditLedger(0)
  assert.equal(l.canContinue(), false, '★ 用户把上限设成 0，就是"只要循环检测，不要换气"')
})

/* ────────────────────────── 隔离 ────────────────────────── */

test('★ 隔离：`stalledRun` 读得到，而且和 `fired` 是两个计数器', async () => {
  const mod = await import('../lib/index.js')
  const Detector = mod.LoopDetector
  assert.equal(typeof Detector, 'function', 'LoopDetector 应该是导出的')

  // ★ 注意：这插件的 `Config` 是 `@deepseek-ai/schemastery` 的 schema 对象，
  // 不是纯 zod —— **没有 `.parse`**，直接调用 `Config({})` 就得到带默认值的实例。
  // （探过：own keys = type/meta/toString/dict，prototype 只有 constructor。）
  const cfg = Config({})
  const d = new Detector(cfg)
  assert.equal(d.stalledRun, 0)
  assert.equal(d.fired, 0)

  // 喂几轮"只有推理、没有正文"的调用
  for (let i = 0; i < cfg.maxThinkingSteps; i++) {
    d.observe({ hasOutput: false, reasoning: 'x'.repeat(3000) + String(i) })
  }
  assert.ok(d.stalledRun >= cfg.maxThinkingSteps, '停滞数应该已经到阈值')

  const firesBefore = d.fired
  d.reset()   // ← 换气出手后走的就是这一步
  assert.equal(d.stalledRun, 0, 'reset 之后停滞数归零（换气和循环检测都从头数）')
  assert.equal(d.fired, firesBefore, '★★ 而 `fires` 不变 —— 换气不许白送常规反应的预算')
})

/* ────────────────────────── 配置 ────────────────────────── */

test('配置：五个新字段的默认值和边界', () => {
  const c = Config({})
  assert.equal(c.maxContinuations, 4)
  assert.equal(c.normalTurnThreshold, 20)
  assert.equal(c.anomalyWindow, 10)
  assert.equal(c.warnAtCredit, 2)
  assert.equal(c.ledgerPath, '')

  assert.equal(Config({ maxContinuations: 0 }).maxContinuations, 0, '0 必须合法（关掉换气）')
  assert.equal(Config({ maxContinuations: 10 }).maxContinuations, 10)
  // ★ 这两条在探明 schemastery 的真实行为之前是"猜"的 —— 先跑，看它到底是
  // 抛错、还是把越界值夹回范围。两种都可接受，但**必须知道是哪一种**。
  assert.throws(() => Config({ maxContinuations: 11 }), '超过 10 该被拒')
  assert.throws(() => Config({ maxContinuations: -1 }), '负数该被拒')
})

/* ────────────────────────── ★ 正对照 ────────────────────────── */

/**
 * 一组"额度账本该守的规矩"。**它同时跑在真账本和故意写坏的账本上。**
 *
 * @returns 被抓到的问题清单，空数组 = 全部规矩都守住了。
 */
function auditLedger(make) {
  const problems = []

  // 规矩 1：上限调高不充值
  {
    const l = make(2)
    l.spendContinuation(); l.spendContinuation()
    l.reconcileMax(8)
    if (l.credit !== 0) problems.push(`上限调高后额度变成了 ${l.credit}，应该还是 0`)
  }

  // 规矩 2：额度不许为负
  {
    const l = make(1)
    l.spendContinuation(); l.spendContinuation(); l.spendContinuation()
    if (l.credit < 0) problems.push(`额度变成了负数 ${l.credit}`)
  }

  // 规矩 3：涨不过上限
  {
    const l = make(2)
    for (let i = 0; i < 20; i++) l.onNormalTurn(1)
    if (l.credit > 2) problems.push(`攒过头了：${l.credit} > 上限 2`)
  }

  // 规矩 4：扣分的地板是 1
  {
    const l = make(4)
    for (let i = 0; i < 10; i++) l.penalise(Date.now())
    if (l.credit < 1) problems.push(`扣分把额度打到 ${l.credit}，地板应该是 1`)
  }

  return problems
}

test('★ 正对照：真账本守得住全部规矩', () => {
  const problems = auditLedger((max) => new CreditLedger(max))
  assert.deepEqual(problems, [], '真账本不该有任何问题')
})

test('★★ 正对照的另一半：故意写坏的账本，必须被同一组规矩抓住', () => {
  /** 坏账本：把"上限是天花板"实现成了"上限是充值"。其余照抄。 */
  class BrokenLedger {
    constructor(max) { this.max = max; this.credit = max }
    spendContinuation() { this.credit = Math.max(0, this.credit - 1); return this.credit }
    onNormalTurn(t) { this.credit = Math.min(this.max, this.credit + 1); return true }
    penalise() { this.credit -= 1; return this.credit }
    reconcileMax(next) {
      this.max = next
      this.credit = next        // ✗ 错在这里：调高上限时顺手充值了
    }
  }

  const problems = auditLedger((max) => new BrokenLedger(max))
  assert.ok(
    problems.length > 0,
    '★★ 坏账本居然通过了 —— 说明这组"规矩"根本不检查东西，前面那些绿灯全是假的',
  )
  assert.ok(
    problems.some((p) => p.includes('上限调高')),
    `应该抓到"上限调高变充值"这一条，实际抓到的是：${JSON.stringify(problems)}`,
  )
})

/* ────────────────────────── 落盘 ────────────────────────── */

test('落盘：存了能读回来，而且账对得上', () => {
  const p = join(tmpdir(), `huanqi-spec-${process.pid}-${Date.now()}.json`)
  const warn = () => {}

  const a = new CreditLedger(4)
  a.spendContinuation()
  a.spendContinuation()
  a.penalise(Date.now())
  a.onNormalTurn(3)          // 攒到阈值，回一点血
  a.save(p, warn)

  const b = new CreditLedger(4)
  assert.equal(b.load(p, warn), true, 'load 应该报告成功')
  assert.equal(b.credit, a.credit, '额度要对得上')
  assert.equal(b.normalTurns, a.normalTurns, '回血进度要对得上')
  assert.deepEqual(b.snapshot().stats, a.snapshot().stats, '统计要对得上')

  rmSync(p, { force: true })
})

test('落盘：★ 上限以配置为准，不认盘上的旧值', () => {
  const p = join(tmpdir(), `huanqi-spec-cap-${process.pid}-${Date.now()}.json`)
  const warn = () => {}

  // 盘上记着 creditMax=8 的场景
  const a = new CreditLedger(8)
  a.save(p, warn)

  // ★ 但用户已经把上限调到 3 了 —— 读档时必须压到 3，而不是听话地回到 8
  const b = new CreditLedger(3)
  b.load(p, warn)
  assert.equal(b.creditMax, 3, '上限只由配置决定')
  assert.ok(b.credit <= 3, `额度不许超过新上限，实际 ${b.credit}`)

  rmSync(p, { force: true })
})

test('落盘：★ 坏文件/缺文件都不许抛（记分牌不能拖垮会话）', () => {
  const warn = []
  const report = (m) => warn.push(m)

  // 文件根本不存在
  const missing = new CreditLedger(4)
  assert.equal(missing.load(join(tmpdir(), 'huanqi-definitely-not-here-12345.json'), report), false)
  assert.equal(missing.credit, 4, '读不到就满额开局')

  // 文件存在但不是 JSON
  const bad = join(tmpdir(), `huanqi-spec-bad-${process.pid}-${Date.now()}.json`)
  writeFileSync(bad, '{ not json at all', 'utf8')
  const broken = new CreditLedger(4)
  assert.equal(broken.load(bad, report), false, '坏文件应该返回 false')
  assert.equal(broken.credit, 4, '坏文件也回到满额，而不是抛')
  rmSync(bad, { force: true })

  // JSON 合法但形状不对
  const wrong = join(tmpdir(), `huanqi-spec-wrong-${process.pid}-${Date.now()}.json`)
  writeFileSync(wrong, JSON.stringify({ hello: 'world' }), 'utf8')
  const shapeless = new CreditLedger(4)
  assert.equal(shapeless.load(wrong, report), false, '形状不对也返回 false')
  assert.equal(shapeless.credit, 4)
  rmSync(wrong, { force: true })

  assert.ok(warn.length >= 2, `出了两次问题，应该至少报告两次，实际 ${warn.length}`)
  assert.ok(warn.every((m) => m.startsWith('dsh-agent-huanqi:')), '警告要带前缀，方便在日志里搜')
})

/* ──────────────── 异常扣分（2026-10-10 接线；此前是占位实现）────────────────
 * 判据：出正文说明这一轮通顺，**紧接着又卡**说明"卡"不是偶然，是上下文在变脏。
 * 所以"距上次正文输出 ≤ anomalyWindow 轮"时，除了延续本身那一分，再额外扣一分。
 * ─────────────────────────────────────────────────────────────────────────── */

test('异常：★ 没见过正文时不判异常（没有基准）', () => {
  const l = new CreditLedger(4)
  assert.equal(l.turnsSinceOutput, undefined, '刚起来时没有基准')
  assert.equal(l.onContinuation({ window: 10, now: 1000 }), false, '没基准就不该判异常')
  assert.equal(l.credit, 4, '额度一点不动')
  assert.equal(l.stats.anomalies, 0, '统计也不记')
})

test('异常：★ 出正文后窗口内又卡 → 额外扣一分', () => {
  const l = new CreditLedger(4)
  l.noteOutput()
  l.noteTurn()
  l.noteTurn()
  assert.equal(l.turnsSinceOutput, 2, '出了正文后过了 2 轮')
  assert.equal(l.onContinuation({ window: 10, now: 2000 }), true, '2 ≤ 10，算异常')
  assert.equal(l.credit, 3, '额外扣一分')
  assert.equal(l.stats.anomalies, 1)
})

test('异常：★ 出正文后超过窗口才卡 → 不算异常', () => {
  const l = new CreditLedger(4)
  l.noteOutput()
  for (let i = 0; i < 11; i++) l.noteTurn()
  assert.equal(l.turnsSinceOutput, 11)
  assert.equal(l.onContinuation({ window: 10, now: 3000 }), false, '11 > 10，隔得够远了')
  assert.equal(l.credit, 4, '额度不动')
  assert.equal(l.stats.anomalies, 0)
})

test('异常：★ 窗口 = 0 时整档关掉（只记时间，不扣分）', () => {
  const l = new CreditLedger(4)
  l.noteOutput()
  assert.equal(l.onContinuation({ window: 0, now: 4000 }), false)
  assert.equal(l.credit, 4)
  assert.equal(l.stats.anomalies, 0)
})

test('异常：★ 扣分不破地板 1', () => {
  const l = new CreditLedger(4)
  l.spendContinuation()
  l.spendContinuation()
  l.spendContinuation()
  assert.equal(l.credit, 1, '先用完三次')
  l.noteOutput()
  l.onContinuation({ window: 10, now: 5000 })
  assert.equal(l.credit, 1, '已经到底了，不再往下')
  assert.equal(l.stats.anomalies, 1, '但这次异常还是记了 —— 统计是复盘用的')
})

test('异常：★ 落盘往返带上计数器（重启不忘"脚下有多滑"）', () => {
  const f = join(tmpdir(), `huanqi-spec-anom-${process.pid}-${Date.now()}.json`)
  const a = new CreditLedger(4)
  a.noteOutput()
  a.noteTurn()
  a.noteTurn()
  a.noteTurn()
  a.onContinuation({ window: 10, now: 6000 })
  a.save(f, () => {})
  const b = new CreditLedger(4)
  assert.equal(b.load(f, () => {}), true)
  assert.equal(b.turnsSinceOutput, 3, '计数器要跟着走')
  assert.equal(b.credit, a.credit, '额度和源一致')
  assert.equal(b.stats.anomalies, 1, '统计也一致')
  rmSync(f, { force: true })
})
