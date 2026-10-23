// dsh-agent-yantai 自检 —— 不装、不重启，先把宿主半跑通。
// 做的事：import 真包 → 造一个假 ctx → 用真 handler 跑一次 /api/state → 打印摘要。
import { apply, name, inject } from './index.js'

console.log('name =', name, ' inject =', JSON.stringify(inject))

let captured = null
const fakeCtx = {
  webServer: {
    register(opts) { captured = opts; return { dispose() {} } },
  },
  effect(fn, label) { console.log('effect:', label); return fn() },
}

apply(fakeCtx)
if (!captured) { console.error('FAIL: 没有注册路由'); process.exit(1) }
console.log('route =', captured.kind, captured.path)

function fakeRes() {
  return {
    code: 0,
    headers: null,
    body: null,
    writeHead(code, headers) { this.code = code; this.headers = headers },
    end(buf) { this.body = buf },
  }
}

const res = fakeRes()
await captured.handler({ url: '/yantai/api/state', method: 'GET' }, res)

console.log('status =', res.code)
let j = null
try { j = JSON.parse(String(res.body)) } catch (e) { /* 下面会报 */ }
if (!j || !j.ok) {
  console.error('FAIL: state 不是 ok')
  console.error(String(res.body).slice(0, 900))
  process.exit(1)
}

console.log('--- 水位 ---')
console.log(JSON.stringify(j.water, null, 2))
console.log('--- 账本 ---')
console.log('total =', j.ledger.total, ' rows =', j.ledger.rows.length, ' open =', j.ledger.open.length)
console.log('最近一条:', JSON.stringify(j.ledger.rows[0] || null).slice(0, 260))
console.log('未结一条:', JSON.stringify(j.ledger.open[0] || null).slice(0, 260))
console.log('--- 门 ---')
console.log((j.gates || []).map((g) => g.label).join(' / '))
console.log('OK')
