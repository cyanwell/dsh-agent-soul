/**
 * pruner 定点清理 · 请求解析测试（2026-11-10 建；**2026-11-20 改写**）
 *
 * 跑法：node --test _verify/pruner-eval/pruner-stub.test.mjs
 *
 * ★★★ 为什么改写两次：
 *   第一轮（11-20）把 pruner 接真，走的是 context-surgeon（自己拼 surfaceOp.replace）。
 *   第二轮（11-21）翻协议发现那样是错的 —— v4 要的是**原生 pruner 回执**（带 pointer），
 *   而 adapter 的头注早就写明「绝不自己拼 surface 改写」。所以改回 pruner-adapter.mjs。
 *   跟着变的断言：
 *     · ③「分支里必须 pickLiveAgent(sid)」→ 现在找会话在适配器里做，分支只需原样交 args
 *     · ⑯「必须调 purgeMany + via=context-surgeon」→ 现在必须调 runTargetedCleanup，
 *        且**不许**出现 purgeMany / surfaceOp
 *   仍然成立、一字未改的判据：请求怎么判、缺什么要说清、不许拿默认会话兜底、不许回桩文案。
 *
 * ★ 这份**保留**的是仍然成立的判据：请求怎么判、缺什么要说清、不许拿默认会话兜底。
 *   真正的成功路径由 _verify/capability-real.test.mjs 覆盖（那条走完整 ws exec 链路）。
 * ★ 全部离线：不连 7310、不起 DSH、不读不写任何真实会话。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  describePrunerRequest,
  prunerRefusalMessage,
  PRUNER_GAP,
  PRUNER_CAP,
  PRUNER_ACTION,
  DEFAULTS,
} from '../../index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = fs.readFileSync(path.join(HERE, '..', '..', 'index.js'), 'utf8')

const GOOD = { sessionId: 'session-abc', targetSession: 'session-abc', opId: 'clean-x1-9f3a', startSeq: 100, endSeq: 180 }

/**
 * 只取 runExec 里 pruner 那一段（到「不认识的能力」那句为止）。
 * ★ 为什么必须切准：doFollowup 那一支**本来就**用 defaultSessionId 兜底（那是它的语义），
 *   把它的代码算进 pruner 分支，测出来的失败是假的。
 */
function prunerBranch () {
  const start = SRC.indexOf("if (cap === 'pruner')")
  assert.ok(start > 0, '找不到 pruner 分支')
  const end = SRC.indexOf('不认识的能力', start)
  assert.ok(end > start, 'pruner 分支边界没找到（runExec 结构变了？重新看一眼再改断言）')
  return SRC.slice(start, end)
}

test('① 完整请求：判定通过，字段原样回显', () => {
  const d = describePrunerRequest(GOOD)
  assert.equal(d.ok, true)
  assert.equal(d.problems.length, 0)
  assert.deepEqual(d.echo, { sessionId: 'session-abc', targetSession: 'session-abc', startSeq: 100, endSeq: 180, opId: 'clean-x1-9f3a' })
})

test('② 缺 sessionId：不通过，并且明说「不挑默认会话兜底」', () => {
  const d = describePrunerRequest({ ...GOOD, sessionId: undefined, targetSession: undefined })
  assert.equal(d.ok, false)
  assert.ok(d.problems.some((s) => /sessionId/.test(s)), d.problems.join('|'))
  assert.ok(d.problems.some((s) => /roots\[0\]|兜底/.test(s)), '缺目标时必须交代不兜底：' + d.problems.join('|'))
})

test('③ 会话只认显式 id：分支把 args 原样交给适配器，自己没有 defaultSessionId / roots[0] 兜底', () => {
  // ★ 2026-11-21：改回适配器以后，找活会话这件事在 pruner-adapter.mjs 里做，
  //   而它有一条比原来更硬的判据：session.id 必须**等于**请求里的 sessionId，
  //   不等就抛 target-mismatch（"不替你换一个"）。所以分支侧要守的是：
  //   把 args 原样交出去，自己不挑、不猜、不兜底。
  const branch = prunerBranch()
  assert.ok(/runTargetedCleanup\(\{[^}]*args/.test(branch), 'pruner 分支必须把 args 交给适配器：' + branch)
  assert.ok(!/defaultSessionId|roots\[0\]/.test(branch), 'pruner 分支里出现了默认会话兜底：' + branch)
  assert.ok(/throw execError\(/.test(branch), 'pruner 分支必须走带 stage 的拒绝：' + branch)
})

test('④ targetSession 与 sessionId 不一致：不通过（不替你选一个）', () => {
  const d = describePrunerRequest({ ...GOOD, targetSession: 'session-other' })
  assert.equal(d.ok, false)
  assert.ok(d.problems.some((s) => /不一致/.test(s)), d.problems.join('|'))
})

test('⑤ targetSession 与 sessionId 同值（v4 实际会两个都送）：通过', () => {
  assert.equal(describePrunerRequest({ ...GOOD }).ok, true)
})

test('⑥ 缺 startSeq / 缺 endSeq：分别不通过，并回显拿到了什么', () => {
  const a = describePrunerRequest({ ...GOOD, startSeq: undefined })
  const b = describePrunerRequest({ ...GOOD, endSeq: null })
  assert.equal(a.ok, false)
  assert.equal(b.ok, false)
  assert.ok(a.problems.some((s) => /startSeq/.test(s)))
  assert.ok(b.problems.some((s) => /endSeq/.test(s)))
})

test('⑦ startSeq > endSeq：不通过', () => {
  const d = describePrunerRequest({ ...GOOD, startSeq: 200, endSeq: 180 })
  assert.equal(d.ok, false)
  assert.ok(d.problems.some((s) => /startSeq > endSeq/.test(s)), d.problems.join('|'))
})

test('⑧ seq 非整数（1.5 / "12abc" / 负数不拦但非整数拦）：一律不通过', () => {
  for (const bad of [1.5, '12abc', {}, '']) {
    const d = describePrunerRequest({ ...GOOD, startSeq: bad })
    assert.equal(d.ok, false, '居然接受了 startSeq=' + JSON.stringify(bad))
  }
})

test('⑨ 缺 opId：不通过（宿主不许自己编请求号）', () => {
  const d = describePrunerRequest({ ...GOOD, opId: '' })
  assert.equal(d.ok, false)
  assert.ok(d.problems.some((s) => /opId/.test(s)), d.problems.join('|'))
})

test('⑩ opId 原样保留（含冒号、长串、大写），并出现在回执文案里', () => {
  const opId = 'clean-ABC:9f3a-0000'
  const d = describePrunerRequest({ ...GOOD, opId })
  assert.equal(d.echo.opId, opId)
  const msg = prunerRefusalMessage({ ...GOOD, opId }, PRUNER_ACTION)
  assert.ok(msg.includes(opId), '文案里没看到 opId：' + msg)
})

test('⑪ ★ 桩文案已删：拒绝文案以「请求不合法」开头，且是单行、带请求回显', () => {
  const msg = prunerRefusalMessage(GOOD, PRUNER_ACTION)
  assert.ok(!msg.includes('未实现（桩）'), '桩文案必须已经删掉：' + msg)
  assert.ok(msg.startsWith('请求不合法：'), msg)
  assert.ok(!/\n/.test(msg), '回执文案必须是单行：' + msg)
  assert.ok(msg.includes('session-abc') && msg.includes('100') && msg.includes('180') && msg.includes('clean-x1-9f3a'), msg)
})

test('⑫ 不合法请求的文案：只谈请求哪里不对，不掺「宿主能力缺口」', () => {
  // ★★★ 2026-11-21 改写：原来要求文案里**同时**出现「请求不合法」和「缺口：」。
  //   现在这两种信息必须**分开**，因为混在一起会误导：
  //   · 「缺口」原本说的是「官方 pruner 没有按 seq 点名的入口」——
  //     而 dsh-yanqing-pruner 用 applyDrops 把它填上了，再报它等于告诉人「这事做不了」；
  //   · 能力通不通由适配器的 stage 去答（no-pruner / no-target / target-mismatch），
  //     一个参数错误的回执里不该出现它。
  //   ★ 断言从「两者都在」变成「两者分离」：请求文案里有前者、没有后者。
  const msg = prunerRefusalMessage({}, PRUNER_ACTION)
  assert.ok(msg.includes('请求不合法'), '要明说请求不合法：' + msg)
  assert.ok(!msg.includes('缺口'), '不该在参数错误里谈能力缺口：' + msg)
  assert.ok(!/hello\.meta\.stubs/.test(msg), '不该再让人去看 stubs：' + msg)
})

test('⑬ 缺口描述仍留在常量里（沿革），但不再进任何对外回执', () => {
  // ★ 2026-11-21：PRUNER_GAP 保留作**沿革与判据**（它记录了 2026-11-10 那次评估的
  //   可核依据：官方包版本、pruneSession 签名、SurfaceOp 只有 append/replace 没有 remove）。
  //   那段判据仍然成立且有用 —— 它正是「为什么必须靠 fork 的 applyDrops」的理由。
  //   变的只是：它**不再出现在对外回执里**（见 ⑫）。
  assert.ok(PRUNER_GAP.includes('pruneSession'), PRUNER_GAP)
  assert.ok(/SurfaceOp|append/.test(PRUNER_GAP), PRUNER_GAP)
  assert.ok(PRUNER_GAP.includes('0.1.5-rc.2'), '缺口要带版本，判据才可核：' + PRUNER_GAP)
  const msg = prunerRefusalMessage({}, PRUNER_ACTION)
  assert.ok(!msg.includes(PRUNER_GAP), '对外文案不许再带这段缺口')
})

test('⑭ 能力已转正：pruner 仍在 caps，且已不在 stubCaps', () => {
  assert.ok(DEFAULTS.caps.includes(PRUNER_CAP), 'caps 里丢了 pruner')
  assert.ok(!DEFAULTS.stubCaps.includes(PRUNER_CAP), '★ pruner 已接真，不该再留在 stubCaps')
  assert.equal(PRUNER_ACTION, 'targeted-cleanup')
})

test('⑮ 全空输入：四类问题都要报出来（不缺项装哑巴）', () => {
  const d = describePrunerRequest(undefined)
  assert.equal(d.ok, false)
  assert.ok(d.problems.length >= 4, '问题项太少：' + JSON.stringify(d.problems))
})

test('⑯ 源码静态核对：pruner 走**原生 applyDrops**，绝不自己拼 surface 改写', () => {
  // ★★★ 2026-11-21 改回来。上一版这条断言写的是「分支里必须调 purgeMany、via 写 context-surgeon」，
  //   而那正是错的：adapter 的头注早就写着「绝不自己拼 compaction/prune + surfaceOp.replace 顶上
  //   （那是把 pruner 的策略抄一份到桥里：门牌、影子定价、replay 语义全要跟着漂）」。
  //   更硬的理由：v4 的 judgeCleanupReceipt 要的是原生回执里的 pointer（log:<会话>#seq=<n>），
  //   context-surgeon 给不出 pointer —— 交上去的是 v4 认不出的回执。
  const branch = prunerBranch()
  // ★ 判据只看代码，不看注释：注释里当然会出现 surfaceOp（那是在解释「为什么不用它」）。
  //   不剥注释的静态检查会把「解释自己没做的事」判成「做了那件事」—— 这是假阳性。
  const code = branch
    .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1') // 行注释（避开 http:// 这类）
  assert.ok(/runTargetedCleanup\(/.test(code), 'pruner 分支必须走适配器（原生 applyDrops）：' + code)
  assert.ok(!/purgeMany\(/.test(code), 'pruner 分支不许自己拼 surface 改写（purgeMany 是 cap=context 的路）：' + code)
  assert.ok(!/surfaceOp/.test(code), 'pruner 分支不许直接写 surfaceOp —— 那是把 pruner 的策略抄进桥里：' + code)
  assert.ok(/capability: PRUNER_CAP/.test(branch) && /action: PRUNER_ACTION/.test(branch), '回执要带 capability/action：' + branch)
})
