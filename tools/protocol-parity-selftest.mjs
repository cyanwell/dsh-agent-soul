// 协议一致性自检 —— v4 发的动作名 vs 宿主认的动作名
// ============================================================================
// 为什么要有这一条（2026-11-12 的实际事故）：
//   v4 发 { cap:'session', action:'followup' }，宿主的 session 分支只认 'say'。
//   于是每条投递都掉到 runExec 最后一行 bad-request，2ms 返回，回执还带着 host/hostId/code ——
//   看起来像一条正常失败，实际上这个动作名**从来没被认过**。
//   而当时的 206 条自检全绿，因为那些测试用的假 hub 是照我自己的假设写的。
//
//   假 hub 永远对 —— 它测的是「我的假设自洽」，不是「对面认这个假设」。
//   所以这一条**不 import 假东西**，直接读宿主源码里那几行 action 判断。
//
// 判据：v4 会发的每个 action，宿主必须认；认不出的当场红。
// ★ 宿主不在本机（或没装）时 skip，不假装通过也不误报失败。
// ============================================================================

import fs from 'node:fs'
import { ACTIONS } from '../src/organs/session-dispatch.mjs'

let pass = 0, fail = 0, skip = 0
const bad = []
function ok (name, cond, d) {
  if (cond) { pass++; console.log('  ✓ ' + name + (d === undefined ? '' : '  ' + d)) }
  else { fail++; bad.push(name); console.log('  ✗ ' + name + (d === undefined ? '' : '  ' + d)) }
}
function skipped (name, why) { skip++; console.log('  - ' + name + '（跳过：' + why + '）') }

const BRIDGE = 'D:/AI/dsh-tools/dsh-agent-soul-bridge/index.js'

console.log('=== 一、v4 侧的动作表 ===')
const wanted = Object.values(ACTIONS)
console.log('  v4 会发：', wanted.join(', '))
ok('v4 的动作表非空', wanted.length > 0, wanted.length + ' 个')

console.log('=== 二、宿主侧真认哪些 ===')
if (!fs.existsSync(BRIDGE)) {
  skipped('读宿主源码', '没找到 ' + BRIDGE + '（换机器/没装插件时正常）')
} else {
  const src = fs.readFileSync(BRIDGE, 'utf8')
  // 只取 session 分支那一段：从 'cap === 'session'' 到下一个顶层 cap 判断
  const start = src.indexOf("cap === 'session'")
  ok('找到了 session 分支', start > 0, 'offset=' + start)
  const tail = src.slice(start)
  const end = tail.indexOf("cap === 'huanqi'")
  const seg = end > 0 ? tail.slice(0, end) : tail.slice(0, 4000)

  // 宿主里认动作的写法就两种：action === 'x' 和 action !== 'x'（排除式）
  const accepted = new Set()
  for (const m of seg.matchAll(/action\s*===\s*'([^']+)'/g)) accepted.add(m[1])
  // 排除式：action !== PRUNER_ACTION 之类不算认
  console.log('  宿主认：', [...accepted].join(', ') || '(一个都没匹配到)')

  ok('宿主至少认一个动作', accepted.size > 0, accepted.size + ' 个')

  console.log('=== 三、逐个比对 ===')
  for (const a of wanted) {
    ok('宿主认 ' + a, accepted.has(a), accepted.has(a) ? '' : '← v4 会发，宿主不认！')
  }

  console.log('=== 四、宿主回执里的字段（followup 必须自报 sessionId）===')
  // 判据来自 v4 的 judgeDeliveryReceipt：requireSessionId: true
  // 宿主 doFollowup 的 return 里要有 sessionId
  const dfStart = src.indexOf('function doFollowup')
  if (dfStart > 0) {
    const dfSeg = src.slice(dfStart, dfStart + 2500)
    ok('doFollowup 回执带 sessionId', /sessionId:\s*String\(/.test(dfSeg))
    ok('doFollowup 回执带 delivered', /delivered:\s*true/.test(dfSeg))
  } else {
    ok('找到 doFollowup', false, '没找到')
  }

  console.log('=== 五、反向：宿主认的有没有 v4 根本不发的 ===')
  for (const a of accepted) {
    if (!wanted.includes(a)) console.log('  · 宿主多认了一个「' + a + '」—— 不是错，但要知道它从哪来')
  }
}

console.log('\n────────────────────────────────────────────')
console.log('通过 ' + pass + ' 项 · 失败 ' + fail + ' 项' + (skip ? ' · 跳过 ' + skip + ' 项' : ''))
if (fail) { console.log('失败项：\n  - ' + bad.join('\n  - ')); process.exit(1) }
