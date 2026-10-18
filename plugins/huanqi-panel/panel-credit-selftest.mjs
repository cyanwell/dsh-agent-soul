// 面板 /api/credit 的端到端自检（不重启就能跑）· 
//
// 为什么能这么测：面板的 `apply(ctx)` 只做一件事 —— 把 handler 交给 ctx.webServer.register。
// 所以喂一个假的 webServer 就能把 handler 拿到手，再喂假的 req/res 就能走完整条路由逻辑
// （参数校验 → 读账本 → clamp → 备份 → 写回 → 回读校验 → 响应）。
//
// ★ 唯一测不到的：**这个进程里加载的是不是新代码**。那要重启才知道。
//   所以本脚本证明的是"逻辑对"，不是"已上线"。
//
// 用法：node panel-credit-selftest.mjs

import { readFileSync } from 'node:fs'

const PANEL = 'file:///./index.js'
const LEDGER = '<额度账本路径>'

const m = await import(PANEL)

let handler = null
// ★ 注意 register 收到的是一整个对象（{ kind, path, handler }），handler 在里面 ——
//   第一版我写成 `handler = h` 了，于是报 "handler is not a function"。
m.apply({ logger: { info: () => {} }, webServer: { register: (r) => { handler = r && r.handler } } })
if (!handler) { console.log('★ apply() 没有注册 handler'); process.exit(1) }

function fakeReq(method, path, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    method, url: path,
    [Symbol.asyncIterator]() {
      let i = 0
      return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { done: true }) }
    }
  }
}
function fakeRes() {
  const out = { code: 0, body: null }
  return {
    get statusCode() { return out.code },
    set statusCode(v) { out.code = v },
    setHeader() {},
    end(b) { try { out.body = JSON.parse(b) } catch (e) { out.body = b } },
    out
  }
}
async function call(method, path, body) {
  const res = fakeRes()
  await handler(fakeReq(method, path, body), res)
  return res.out
}

const readCredit = () => JSON.parse(readFileSync(LEDGER, 'utf8')).credit

console.log('① GET /api/credit（应该 405，只收 POST）')
const a = await call('GET', '/agent-huanqi/api/credit')
console.log('   →', a.code, JSON.stringify(a.body))
console.log('')

const start = readCredit()
console.log('② 账本现在的 credit =', start)
console.log('')

console.log('③ POST 一个越界值（999）—— 应该被 clamp 到 creditMax')
const b = await call('POST', '/agent-huanqi/api/credit', { credit: 999 })
console.log('   →', b.code, JSON.stringify(b.body))
console.log('   文件里现在是', readCredit())
console.log('')

console.log('④ POST 一个正常值（2）')
const c = await call('POST', '/agent-huanqi/api/credit', { credit: 2 })
console.log('   →', c.code, JSON.stringify(c.body))
console.log('   文件里现在是', readCredit())
console.log('')

console.log('⑤ POST 一个坏值（"abc"）—— 应该 400')
const d = await call('POST', '/agent-huanqi/api/credit', { credit: 'abc' })
console.log('   →', d.code, JSON.stringify(d.body))
console.log('')

console.log('⑥ 还原成', start)
const e = await call('POST', '/agent-huanqi/api/credit', { credit: start })
console.log('   →', e.code, JSON.stringify(e.body))
console.log('   文件里现在是', readCredit())
