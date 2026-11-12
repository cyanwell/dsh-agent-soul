
import fs from 'node:fs'
import { createEventWaker } from '../src/events/wake.mjs'

const dir = 'C:/Users/pc/Desktop/deepseek harness/agent soul/data/events'
const envelopes = fs.readFileSync(dir + '/envelopes.jsonl', 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
const events = fs.readFileSync(dir + '/events.jsonl', 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)

console.log('账上的帧 =', envelopes.length, ' 事件 =', events.length)
console.log('帧的 event_id =', envelopes.map((e) => e.event_id).join(','))
console.log('事件的 frameIds =', JSON.stringify(events[0].frameIds))

const logs = []
const waker = createEventWaker({
  store: { readAll: () => envelopes },
  allow: { all: true },     // 这里显式放行：目的只是看拼得出来什么
  log: (m) => logs.push(m),
})
const r = waker.compose(events)   // 全部事件都喂进去（第一版写死 events[0]，只看得到第一条）

console.log('--- compose 结果 ---')
console.log('ok =', r.ok, ' 跳过 =', JSON.stringify(r.skipped))
for (const a of r.asks) {
  console.log('chatId =', a.chatId)
  console.log('eventId =', a.eventId)
  console.log('frames =', a.frames, ' truncated =', a.truncated, ' windowMs =', a.windowMs)
  console.log('拼出来的正文 =', JSON.stringify(a.text))
}
console.log('--- view ---')
console.log(JSON.stringify(waker.view()))
console.log('--- 日志行 ---')
for (const l of logs) console.log(l)
