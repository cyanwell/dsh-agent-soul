// 验证：心跳计时的「文件活跃」覆盖是否生效
// ============================================================================
// 程序：
//   ① 读我这个会话的 frames.jsonl mtime
//   ② 构造两种 hostActivity：
//      a) state 说 20 分钟前（会触发自主）
//      b) 文件 mtime 说 0 分钟前（说明我还在跑）
//   ③ 走一遍我新加的逻辑，看它用哪个
// ============================================================================
import fs from 'node:fs'
import path from 'node:path'

const DATA = 'C:/Users/pc/Desktop/deepseek harness/agent soul/data'
const SID = 'session-cfa54217-28a1-4876-a6f5-30e4c644f472'

const fp = path.join(DATA, 'sessions', SID, 'frames.jsonl')
const st = fs.statSync(fp)
const nowMs = Date.now()
const fileMin = Math.max(0, (nowMs - st.mtimeMs) / 60000)

console.log('=== 目标会话的 frames.jsonl ===')
console.log('  路径 ' + fp)
console.log('  mtime ' + new Date(st.mtimeMs).toISOString())
console.log('  距今 ' + fileMin.toFixed(2) + ' 分钟')
console.log('')

// 模拟 state 说 20 分钟前（触发条件）
const haState = { ok: true, minutes: 20, lastActivityAt: new Date(nowMs - 20 * 60000).toISOString(), sessionId: SID }
console.log('=== 模拟两种判据 ===')
console.log('  state 说：' + haState.minutes + ' 分钟前（≥15 → 会触发自主）')
console.log('  文件说：' + fileMin.toFixed(2) + ' 分钟前（<15 → 我还在跑）')
console.log('')

// 我新加的逻辑
const merged = fileMin < haState.minutes
  ? { ...haState, minutes: fileMin, byFileActivity: true }
  : haState

console.log('=== 合并后 ===')
console.log('  minutes = ' + merged.minutes.toFixed(2))
console.log('  byFileActivity = ' + (merged.byFileActivity === true))
console.log('')
const TH = 15
console.log('=== 判定 ===')
if (merged.minutes >= TH) console.log('  ✗ 会触发自主（不对，我还在跑）')
else console.log('  ✓ 不触发（正确：读到了文件活跃，暂停计时）')
console.log('')
console.log('★ 关键：没修之前只会看 state（20 分钟）→ 触发；修完看两者更小的 → ' + merged.minutes.toFixed(2) + ' 分钟 → 不触发。')