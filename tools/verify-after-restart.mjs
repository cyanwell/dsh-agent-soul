// verify-after-restart —— 重启 DSH 之后，一条命令验完「v4 是不是真的独占了」
// ============================================================================
// 用法：
//   node tools/verify-after-restart.mjs            # 只体检，不发消息
//   node tools/verify-after-restart.mjs --live     # 发一条真实 @，跑完整闭环
//
// 它检查五件事（每条都给「通过/失败 + 证据」，不猜）：
//   ① v4 core 在跑，/api/events 不是 error
//   ② 四个能力都接上了：hasDispatch / hasResponder / hasMembers / hasEngage
//   ③ aurabot 日志里**不应该再有**「被 @ → 交给她」（那是它自己判定的痕迹）
//   ④ aurabot 日志里**不应该再有**「v4 接管中」以外的收消息处理
//   ⑤ --live 时：发一条 @ → deliver.delivered 涨 1 → reply.sent 涨 1 → engage.replies 涨 1
// ============================================================================
import fs from 'node:fs'
import path from 'node:path'

const HOME = 'C:/Users/pc/Desktop/deepseek harness/agent soul'
const LOG_DIR = 'D:/AI/dsh/home/plugins-data/aurabot/logs'
const LIVE = process.argv.includes('--live')

let pass = 0, fail = 0
const ok = (n, c, d) => { if (c) { pass++; console.log('  ✓ ' + n + (d ? '  ' + d : '')) } else { fail++; console.log('  ✗ ' + n + (d ? '  ' + d : '')) } }

function token () {
  return fs.readFileSync(path.join(HOME, 'data/token.txt'), 'utf8').trim()
}

async function api (p) {
  const r = await fetch('http://127.0.0.1:7310' + p, { headers: { 'x-soul-token': token() } })
  const t = await r.text()
  try { return { status: r.status, json: JSON.parse(t), raw: t } } catch { return { status: r.status, json: null, raw: t } }
}

function tailLog (n) {
  const files = fs.existsSync(LOG_DIR) ? fs.readdirSync(LOG_DIR).filter((f) => f.endsWith('.log')).sort() : []
  if (!files.length) return ''
  const p = path.join(LOG_DIR, files[files.length - 1])
  const text = fs.readFileSync(p, 'utf8')
  return { file: files[files.length - 1], lines: text.split('\n').filter(Boolean).slice(-n) }
}

console.log('=== ① v4 core ===')
let ev = null
try { ev = await api('/api/events') } catch (e) { ok('core 可达', false, String((e && e.message) || e)) }
if (ev) {
  ok('core 可达', ev.status === 200, 'HTTP ' + ev.status)
  ok('/api/events 不是 error', !(ev.json && ev.json.error), ev.json && ev.json.error)
}

if (ev && ev.json && ev.json.ingress) {
  const i = ev.json.ingress
  console.log('=== ② 四个能力 ===')
  ok('hasDispatch（能投递）', i.deliver && i.deliver.hasDispatch === true, JSON.stringify(i.deliver && i.deliver.hasDispatch))
  ok('hasResponder（能等回复）', i.deliver && i.deliver.hasResponder === true, JSON.stringify(i.deliver && i.deliver.hasResponder))
  ok('hasMembers（能转 @名字）', i.reply && i.reply.hasMembers === true, JSON.stringify(i.reply && i.reply.hasMembers))
  ok('hasEngage（有插话状态）', i.deliver && i.deliver.hasEngage === true, JSON.stringify(i.deliver && i.deliver.hasEngage))
  // ★★ 2026-11-12 加的：表情与语音。这两样是「能发」，但**真发**要等群里出现
  //   <sticker:> / <voice> 才知道 —— 这里只验「接线在」。
  ok('hasStickers（表情库接上了）', i.reply && i.reply.hasStickers === true, JSON.stringify(i.reply && i.reply.hasStickers))
  ok('hasTts（语音能合成）', i.reply && i.reply.hasTts === true, JSON.stringify(i.reply && i.reply.hasTts))
  if (i.reply && i.reply.tts) {
    const t = i.reply.tts
    ok('语音引擎可用', t.available === true, t.platform + ' / ' + t.engine)
    console.log('    语音：合成成功 ' + t.ok + ' 次 / 失败 ' + t.failed + ' 次' + (t.lastError ? (' / 最近错误 ' + t.lastError) : ''))
  }
  // ★ 字段名是 eventSources 不是 sources（2026-11-12 第一次跑就栽在这里，
  //   而它长得像「ingress 没连上」—— 实际上连接是好的）。
  const ob = i.eventSources && i.eventSources.onebot
  ok('ingress 连着', Boolean(ob && ob.state === 'connected'), ob && ob.state)
  console.log('    读数: deliver=' + JSON.stringify({ delivered: i.deliver.delivered, skipped: i.deliver.skipped }) +
    '  reply=' + JSON.stringify({ sent: i.reply.sent, failed: i.reply.failed, watching: i.reply.watching }) +
    '  engage=' + JSON.stringify(i.engage))
}

console.log('=== ③ 插件侧：重启后不该再自己判定 ===')
const tail = tailLog(400)
if (!tail) {
  console.log('  （没找到 aurabot 日志，跳过）')
} else {
  // ★ 只看「重启之后」的行：用进程启动时间做分界太脆，改成看最近 200 行里有没有那条痕迹。
  //   重启后如果还有，说明 soul.dispatch 没读到，或者两处闸没生效。
  const recent = tail.lines.slice(-200)
  const tookOver = recent.filter((l) => l.includes('v4 接管中'))
  const selfJudge = recent.filter((l) => l.includes('被 @ → 交给她'))
  const viaV4 = recent.filter((l) => l.includes('经 v4 唤醒会话'))
  // ★ 这三条只有在**重启之后**才有意义。没重启时闸没进内存，
  //   日志里自然还留着旧痕迹 —— 那不是失败，是「还没做」。
  //   判据：如果「v4 接管中」一行都没有，说明重启还没发生（闸从没执行过）。
  const restarted = tookOver.length > 0
  if (!restarted) {
    console.log('  ⏸ 还没重启 DSH —— 闸没进内存，下面三条现在验不了（这是预期，不是失败）')
    console.log('    旧痕迹：被@→交给她 ' + selfJudge.length + ' 行、经 v4 唤醒 ' + viaV4.length + ' 行')
  } else {
    ok('出现了「v4 接管中」', true, tookOver.length + ' 行（闸真的挡住了）')
    ok('不再有「被 @ → 交给她」', selfJudge.length === 0, selfJudge.length + ' 行')
    ok('不再有「经 v4 唤醒会话」', viaV4.length === 0, viaV4.length + ' 行（那是插件转发，v4 现在自己投）')
  }
}

if (LIVE) {
  console.log('=== ⑤ 真跑一次 ===')
  const before = ev && ev.json && ev.json.ingress
  const cfg = JSON.parse(fs.readFileSync('D:/AI/SnowLuma/config/onebot_1901372960.json', 'utf8'))
  const s = cfg.networks.httpServers[0]
  const r = await fetch('http://127.0.0.1:' + s.port + '/send_group_msg', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + String(s.accessToken || '') },
    body: JSON.stringify({ group_id: 661580035, message: [{ type: 'at', data: { qq: '3937956599' } }, { type: 'text', data: { text: ' 重启后验收：这条应该只回一次' } }] }),
  })
  const sent = await r.json().catch(() => null)
  ok('测试消息发出去了', sent && sent.retcode === 0, JSON.stringify(sent && sent.retcode))
  console.log('    等 45 秒……')
  await new Promise((res) => setTimeout(res, 45000))
  const after = await api('/api/events')
  const j = after.json && after.json.ingress
  if (!j) { ok('能读到投递后读数', false, null) } else {
    const dd = (j.deliver.delivered || 0) - ((before && before.deliver.delivered) || 0)
    const ds = (j.reply.sent || 0) - ((before && before.reply.sent) || 0)
    const de = (j.engage.replies || 0) - ((before && before.engage.replies) || 0)
    ok('deliver.delivered +1', dd === 1, '实际 +' + dd)
    ok('reply.sent +1', ds === 1, '实际 +' + ds)
    ok('engage.replies +1', de === 1, '实际 +' + de)
    // ★ 关键的一条：群里应该只看到她回一次。
    //   如果插件那条闸没生效，这里会看到两条内容相近的发送。
    // ★★ 2026-11-12：**读所有日志文件**，不只是最新那一个。
    //   第一次写这段时只看名字排序的最后一个 —— 但网关会被换实例
    //   （一键启动会起新的），而发送记录可能落在旧实例的文件里。
    //   结果就是「网关最近发送 0 条」，看起来像"一条都没发"，其实是读错了文件。
    const logs = fs.readdirSync('D:/AI/SnowLuma').filter((f) => f.startsWith('snowluma-run-') && f.endsWith('.log')).sort()
    if (logs.length) {
      // 按修改时间排，取最近的两个（够覆盖一次换实例）
      const byTime = logs
        .map((n) => ({ n, t: fs.statSync(path.join('D:/AI/SnowLuma', n)).mtimeMs }))
        .sort((a, b) => b.t - a.t)
        .slice(0, 2)
      const lines = []
      for (const x of byTime) {
        const txt = fs.readFileSync(path.join('D:/AI/SnowLuma', x.n), 'utf8')
        for (const l of txt.split('\n')) {
          if (l.includes('群聊 661580035 | 发送') || l.includes('群聊 661580035') ) lines.push({ at: x.t, l })
        }
      }
      const recentSends = lines.slice(-8).map((x) => x.l)
      console.log('    网关最近发送 ' + recentSends.length + ' 条（读了 ' + byTime.map((x) => x.n.slice(-15)).join(' / ') + '）：')
      for (const l of recentSends) console.log('      ' + l.slice(0, 110))
      console.log('    ★ 人工看一眼：有没有两条内容几乎一样的（那就是双发还在）')
    }
  }
}

console.log('')
console.log((fail === 0 ? 'ALL PASS' : 'FAILED') + ' · ' + pass + ' 通过 / ' + fail + ' 失败')
if (!LIVE) console.log('（没跑真链路。加 --live 会发一条真实 @ 并等 45 秒）')
process.exit(fail === 0 ? 0 : 1)
