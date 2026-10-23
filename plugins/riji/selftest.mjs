// dsh-agent-riji 自检 —— 用假 ctx 把宿主半跑一遍，不开 DSH 就能验证：
//   ① 模块能不能导入、inject 写得对不对
//   ② apply 会不会真的去注册路由、路径对不对
//   ③ 两条路由拿得到数据吗（直接调 handler，不外发请求）
//
// ★ 为什么值得写：插件加载失败大多是【静默】的 —— 少写一个服务名、
//   槽位名字写错、工具名撞车，界面只会「什么都不显示」，一个错都不吐。
//   这个探针把「能不能加载」和「有没有数据」拆开验，省掉一轮重启。
//
// 用法：node selftest.mjs

import { pathToFileURL } from 'node:url'

const results = []
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then((v) => results.push({ ok: true, name, note: v === undefined ? '' : String(v) }))
    .catch((e) => results.push({ ok: false, name, note: String((e && e.message) || e) }))
}

// ── 假 ctx：只提供宿主半真正用到的那一个服务 ──────────────────────
let captured = null
const fakeCtx = {
  webServer: {
    register(cfg) {
      captured = cfg
      return { kind: cfg.kind, path: cfg.path }
    },
  },
}

await check('模块可导入', async () => {
  const mod = await import(pathToFileURL('<插件目录>').href)
  globalThis.__mod = mod
  if (!mod.name) throw new Error('没有 export name')
  return 'name=' + mod.name
})

await check('inject 只写 webServer（多写不存在的服务名会静默不加载）', () => {
  const mod = globalThis.__mod
  const inj = mod.inject
  if (!Array.isArray(inj)) throw new Error('inject 不是数组')
  const bad = inj.filter((s) => s !== 'webServer')
  if (bad.length) throw new Error('多写了：' + bad.join(', '))
  return 'inject=' + JSON.stringify(inj)
})

await check('apply 注册了 /riji 前缀路由', async () => {
  const mod = globalThis.__mod
  if (typeof mod.apply !== 'function') throw new Error('没有 export apply')
  mod.apply(fakeCtx)
  if (!captured) throw new Error('apply 没有调用 webServer.register')
  if (captured.path !== '/riji') throw new Error('路径不对：' + captured.path)
  if (captured.kind !== 'prefix') throw new Error('kind 不对：' + captured.kind)
  return captured.kind + ' ' + captured.path
})

// ── 假的 req/res，直接打 handler ────────────────────────────────────
function mockRes() {
  const r = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this },
    end(b) { this.body = b === undefined ? '' : String(b); return this },
  }
  return r
}

async function hit(pathname) {
  const res = mockRes()
  const req = { method: 'GET', url: pathname, headers: {} }
  await captured.handler(req, res)
  let parsed = null
  try { parsed = JSON.parse(res.body) } catch { /* 非 JSON 就留 null */ }
  return { res, parsed }
}

await check('OPTIONS 预检回 204（桌面端跨域必须）', async () => {
  const res = mockRes()
  await captured.handler({ method: 'OPTIONS', url: '/riji/api/list', headers: {} }, res)
  if (res.statusCode !== 204) throw new Error('状态码是 ' + res.statusCode)
  if (res.headers['access-control-allow-origin'] !== '*') throw new Error('没有 CORS 头')
  return '204 + CORS'
})

await check('GET /api/list 能列到日记', async () => {
  const { res, parsed } = await hit('/riji/api/list')
  if (res.statusCode !== 200) throw new Error('状态码 ' + res.statusCode)
  if (!parsed || !parsed.ok) throw new Error('返回 not ok：' + res.body.slice(0, 200))
  if (!parsed.count) throw new Error('一篇都没有，目录可能是空的或路径错了：' + parsed.dir)
  return parsed.count + ' 篇，例如「' + parsed.docs[0].title + '」'
})

await check('GET /api/doc 能取到某一篇的原文', async () => {
  const { parsed: list } = await hit('/riji/api/list')
  const name = list.docs[0].name
  const { res, parsed } = await hit('/riji/api/doc?name=' + encodeURIComponent(name))
  if (res.statusCode !== 200) throw new Error('状态码 ' + res.statusCode)
  if (!parsed || !parsed.ok) throw new Error('返回 not ok')
  if (!parsed.text || parsed.text.length < 10) throw new Error('原文是空的')
  globalThis.__firstTitle = parsed.title
  return name + ' → 「' + parsed.title + '」' + parsed.bytes + ' 字节'
})

await check('目录穿越被拦住（name 带 .. 或路径分隔符）', async () => {
  for (const bad of ['..\\AGENTS.md', '../../secret.md', 'C:/x/y.md', 'a/b.md']) {
    const { res } = await hit('/riji/api/doc?name=' + encodeURIComponent(bad))
    if (res.statusCode === 200) throw new Error('竟然放过了：' + bad)
  }
  return '四种非法名全被拒'
})

await check('新写的《晴天的记录》在目录里', async () => {
  const { parsed } = await hit('/riji/api/list')
  const hitDoc = parsed.docs.find((d) => d.name.indexOf('晴天的记录') >= 0)
  if (!hitDoc) throw new Error('没找到，日记目录里有：' + parsed.docs.map((d) => d.name).join(' / '))
  return hitDoc.name + ' → 「' + hitDoc.title + '」'
})

// ── 报告 ────────────────────────────────────────────────────────────
console.log('')
console.log('dsh-agent-riji 自检')
console.log('─'.repeat(58))
let bad = 0
for (const r of results) {
  if (!r.ok) bad++
  console.log((r.ok ? '  ✓ ' : '  ★ ') + r.name + (r.note ? '   → ' + r.note : ''))
}
console.log('─'.repeat(58))
console.log('  ' + (results.length - bad) + ' / ' + results.length + ' 通过')
if (bad) {
  console.log('')
  console.log('  ★ 有 ' + bad + " 项没过 —— 先别重启，把上面带 ★ 的修掉。")
  process.exit(1)
}
