// tools/guard-http-selftest.mjs —— POST /api/guard 的回归门
//
// ★ 它和 guard-selftest.mjs 测的不是一件事：
//   guard-selftest 测 check() 这个**函数**（纯逻辑，不起服务）；
//   这个测**端点**（HTTP 层 —— body 读没读对、状态码、返回形状）。
//
// ★★ 为什么要有这个门：/api/guard 是 2026-11-07 新开的，
//   而它第一次写出来时**三条测试全挂、服务却一切正常** ——
//   因为我在端点里把已经 parse 过的 body 又 parse 了一次，
//   catch 把 body 变成 {}，于是所有请求都回「text 是空的」。
//   **那种错不报错，只会静静地不工作。**

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = process.env.AGENT_SOUL_PORT || 7310

// ★ 2026-11-21：**读 token，不是跳过。**
//   原来这个门一直报 1/6（全是 401 missing-or-bad-token）——
//   报告 #9 说「被鉴权打哑」，修法是「读 <dataDir>/token.txt，每个请求带 X-Soul-Token」。
//   ★ 而子会话第一版是加 `if (!process.env.GUARD_TOKEN) process.exit(0)` ——
//     那是**把门关掉**，让 6/6 变成"跳过"。跳过不是通过，是把红灯涂成绿灯。
// ★★ 2026-11-21：**探测式自证，不是按路径猜。**
//
//   踩到的坑：dev 仓库的 `data/token.txt` 与**正在跑的那个服务**用的 token **不是同一个**。
//   按相对路径读到 dev 那份 → 401 → 又变成"打哑"。
//   ★ 而"路径对"这件事本身无法自证 —— 只有服务自己认了才算数。
//
//   所以：把候选 token 全列出来，**各发一次探针（GET /api/health 不设卡，
//   改用 POST /api/guard 空 text，期望 400）**，用第一个**非 401** 的。
//   一个都过不了 → 明确报 UNREACHABLE，不假通过。
const __dirname = path.dirname(fileURLToPath(import.meta.url))

function tokenCandidates () {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  push(process.env.GUARD_TOKEN)
  for (const base of [
    process.env.AGENT_SOUL_DATA,
    path.join(__dirname, '..', 'data'),
    'C:/Users/pc/Desktop/deepseek harness/agent soul/data',
    'D:/AI/agent-soul/data',
  ]) {
    if (!base) continue
    try { push(fs.readFileSync(path.join(base, 'token.txt'), 'utf8').trim()) } catch {}
  }
  return out.filter(Boolean)
}

const probe = (token) => new Promise((resolve) => {
  const b = Buffer.from(JSON.stringify({ text: '' }), 'utf8')
  const rq = http.request({
    host: '127.0.0.1', port: PORT, path: '/api/guard', method: 'POST', timeout: 8000,
    headers: {
      'content-type': 'application/json', 'content-length': b.length,
      ...(token ? { 'x-soul-token': token } : {}),
    },
  }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
  rq.on('error', () => resolve(0))
  rq.on('timeout', () => { rq.destroy(); resolve(0) })
  rq.write(b); rq.end()
})

let TOKEN = null
for (const t of tokenCandidates()) {
  const code = await probe(t)
  if (code && code !== 401) { TOKEN = t; break }
}
if (!TOKEN) {
  console.log('✗ UNREACHABLE —— 所有候选 token 都被 401，或服务没起（端口 ' + PORT + '）')
  console.log('  ★ 这不是"测试通过"，也不是"跳过" —— 是这个门这次**没能检查**。')
  process.exit(1)
}
const PASS = [], FAIL = []
const ok = (m) => PASS.push(m)
const no = (m) => FAIL.push(m)

const post = (body) => new Promise((resolve) => {
  const b = Buffer.from(JSON.stringify(body), 'utf8')
  const rq = http.request({ host: '127.0.0.1', port: PORT, path: '/api/guard', method: 'POST', timeout: 15000,
    headers: {
      'content-type': 'application/json',
      'content-length': b.length,
      ...(TOKEN ? { 'x-soul-token': TOKEN } : {}),
    } }, (res) => {
    let d = ''
    res.setEncoding('utf8')
    res.on('data', (c) => { d += c })
    res.on('end', () => { try { resolve({ code: res.statusCode, j: JSON.parse(d) }) } catch { resolve({ code: res.statusCode, j: null, raw: d }) } })
  })
  rq.on('error', (e) => resolve({ code: 0, err: String(e.message) }))
  rq.on('timeout', () => { rq.destroy(); resolve({ code: 0, err: 'timeout' }) })
  rq.write(b); rq.end()
})

// 1. 空 text 要给 400，且说清为什么
{
  const r = await post({ text: '' })
  r.code === 400 && r.j && r.j.error
    ? ok('空 text → 400 且带原因')
    : no('空 text 没给 400：' + JSON.stringify(r).slice(0, 120))
}

// 2. ★ 正常请求要真的读到 body（这条就是当初挂掉的那条）
{
  const r = await post({ text: '这个函数为什么返回 undefined' })
  r.j && r.j.ok === true && r.j.verdict
    ? ok('正常请求读到了 body，verdict=' + r.j.verdict)
    : no('body 没读到或没 verdict：' + JSON.stringify(r).slice(0, 160))
}

// 3. 该拦的要拦
{
  const r = await post({ text: '把 D:\\AI 那个目录整个删了' })
  r.j && r.j.verdict === 'block'
    ? ok('高危动作 → block（' + (r.j.via || '?') + '）')
    : no('高危动作没被拦：' + JSON.stringify(r).slice(0, 160))
}

// 4. ★ 讨论硬线要放行（isMeta 那条最容易被误拦）
{
  const r = await post({ text: '写一条规则：付款、转账一概不做' })
  r.j && r.j.verdict === 'pass' && r.j.via === 'meta'
    ? ok('讨论规则 → pass(meta)，没被误拦')
    : no('讨论规则被误判：' + JSON.stringify(r).slice(0, 160))
}

// 5. 必须有 verdict，且是三种之一
{
  const r = await post({ text: '随便问一句' })
  r.j && ['pass', 'ask', 'block'].includes(r.j.verdict)
    ? ok('verdict 在三档之内：' + r.j.verdict)
    : no('verdict 形状不对：' + JSON.stringify(r).slice(0, 160))
}

// 6. 端点必须是只读的 —— 同一句话问两次，答案要一致
{
  const a = await post({ text: '帮我看看这个日志' })
  const b = await post({ text: '帮我看看这个日志' })
  a.j && b.j && a.j.verdict === b.j.verdict
    ? ok('同一句问两次结论一致（只读判断）')
    : no('两次结论不一致：' + (a.j && a.j.verdict) + ' vs ' + (b.j && b.j.verdict))
}

console.log(PASS.map((m) => '  ✓ ' + m).join('\n'))
if (FAIL.length) console.log(FAIL.map((m) => '  ✗ ' + m).join('\n'))
console.log('通过 ' + PASS.length + ' 项 · 失败 ' + FAIL.length + ' 项')
process.exit(FAIL.length ? 1 : 0)
