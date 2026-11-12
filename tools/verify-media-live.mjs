// 真发验证：把「表情能发」「语音能发」从「接线在」推到「群里真的收到」
// ============================================================================
// 为什么需要它：第 21–22 轮只验到「接线在」和「能合成/能挑图」，
//   但「QQ 网关接不接受这个格式」是另一回事 ——
//   record 段要 base64、image 段要 file 路径、语音不能带引用。
//   任何一条格式不对，网关会回 retcode != 0，而 v4 的 respond 只记 failed 就完了。
//
// ★ 发到**私聊**（private:1901372960），不发群 —— 群里可能有别人，
//   测试消息不该打扰他们。私聊只有主人一个人。
// ============================================================================
import fs from 'node:fs'
import { createOutbox } from '../src/adapters/outbox.mjs'
import { createStickerLib } from '../src/events/stickers.mjs'
import { createTts } from '../src/voice/tts.mjs'
import { toMessages } from '../src/events/format.mjs'

const cfg = JSON.parse(fs.readFileSync('D:/AI/SnowLuma/config/onebot_3937956599.json', 'utf8'))
const http = cfg.networks.httpServers[0]
const token = String(http.accessToken || '')
const base = 'http://127.0.0.1:' + http.port

const outbox = createOutbox({ baseUrl: base, tokenEnv: '', timeoutMs: 15000 })
// ★ outbox 只认 tokenEnv（环境变量名），这里直接把 token 塞进 env
process.env.__V4_TEST_TOKEN = token
const ob = createOutbox({ baseUrl: base, tokenEnv: '__V4_TEST_TOKEN', timeoutMs: 15000 })

const stickers = createStickerLib({ root: 'D:/AI/dsh/home/plugins-data/aurabot/stickers', log: (m) => console.log(m) })
const tts = createTts({ outDir: 'D:/AI/agent-soul/data/voice-cache', log: (m) => console.log(m) })

const CHAT = 'private:1901372960'
let pass = 0, fail = 0
const ok = (n, c, d) => { if (c) { pass++; console.log('  ✓ ' + n + (d ? '  ' + d : '')) } else { fail++; console.log('  ✗ ' + n + (d ? '  ' + d : '')) } }

// ---------- ① 表情 ----------
console.log('=== ① 表情：真的发一张 ===')
const st = stickers.pick('开心')
ok('挑到一张', Boolean(st), st ? st.file.split(/[\\/]/).pop() : null)
if (st) {
  const r = await ob.send(CHAT, [{ type: 'image', data: { file: st.file } }])
  ok('网关接受了图片段', r && r.ok === true, JSON.stringify({ ok: r && r.ok, retcode: r && r.retcode, code: r && r.code }))
}

// ---------- ② 语音 ----------
console.log('=== ② 语音：真的合成并发出 ===')
const t0 = Date.now()
const sp = await tts.speak('这是第六验证，语音条能不能真的发出去。')
ok('合成成功', sp && sp.ok === true, sp ? (sp.engine + '  ' + Math.round((Date.now() - t0) / 1000) + 's') : JSON.stringify(sp))
if (sp && sp.ok) {
  const bytes = fs.statSync(sp.file).size
  ok('音频文件有内容', bytes > 1000, Math.round(bytes / 1024) + 'KB')
  const b64 = fs.readFileSync(sp.file).toString('base64')
  const r = await ob.send(CHAT, [{ type: 'record', data: { file: 'base64://' + b64 } }])
  ok('网关接受了语音段', r && r.ok === true, JSON.stringify({ ok: r && r.ok, retcode: r && r.retcode, code: r && r.code, error: r && r.error }))
}

// ---------- ③ 混合段（一条消息里 文字 + 表情）----------
console.log('=== ③ 混合：文字 + 表情同一条 ===')
const fmt = toMessages('这是一条带表情的消息<sticker:开心>')
// ★ toMessages 返回 { ok, messages: [{ segments }] }，不是 { segments } ——
//   第一次写这条测试时按自己的印象写成 fmt.segments，跑到这里才炸。
const firstMsg = fmt.ok && fmt.messages && fmt.messages[0]
ok('切成两段', Boolean(firstMsg && firstMsg.segments.length === 2), firstMsg ? firstMsg.segments.map((s) => s.type).join(',') : null)
if (firstMsg) {
  const segs = []
  for (const s of firstMsg.segments) {
    if (s.type === 'sticker') {
      const hit = stickers.pick(s.data.tag)
      if (hit) segs.push({ type: 'image', data: { file: hit.file } })
    } else segs.push(s)
  }
  const r = await ob.send(CHAT, segs)
  ok('网关接受了混合段', r && r.ok === true, JSON.stringify({ ok: r && r.ok, retcode: r && r.retcode, code: r && r.code }))
}

console.log('')
console.log((fail === 0 ? 'ALL PASS' : 'FAILED') + ' · ' + pass + ' 通过 / ' + fail + ' 失败')
console.log('outbox 读数 = ' + JSON.stringify(ob.view(5).stats))
process.exit(fail === 0 ? 0 : 1)
