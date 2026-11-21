/**
 * client-half-preflight.mjs —— 「这个包的浏览器半会不会被加载」的**静态前置检查**（2026-11-21）
 *
 * 跑法：node _verify/client-half-preflight.mjs
 *
 * ★ 为什么要有它：客户端半没加载时**界面上什么都不显示、控制台也未必报错**。
 *   要判它，正常需要「带登录态打开页面 + 看 window.__DSH_BOOT__」，而那一步
 *   我在无登录态时做不到（/api/client-modules 返回 401）。
 *
 *   所以这里把**不需要登录态就能判**的部分，逐项按 dsh-client-modules 的真实判据做一遍：
 *     ① dsh.client.platform 必须是 'web'（否则 resolveMeta 直接把包当非 client 包，静默跳过）
 *     ② exports["./client"] 必须存在（缺了会 throw "declares dsh.client but exports no ./client bundle"）
 *     ③ 拼出来的 clientPath 必须真的存在（它会 readFileSync）
 *     ④ client.js 必须是 window.__ModuleLoader__.load({...}) 自注册形状
 *     ⑤ client.js 必须 export apply 与 inject:["slots"]
 *
 * ★ 它证明的是「形状没问题」，**不证明「加载发生了」**。全绿而界面上没有，
 *   问题就在 loader entries（包没被挂）或运行期，那要 BOOT 图。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const rows = []
const add = (ok, label, detail) => rows.push({ ok, label, detail: detail === undefined ? '' : String(detail) })

const pkgPath = path.join(ROOT, 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))

// ① platform —— 必须 web
const decl = pkg.dsh && pkg.dsh.client
add(!!decl, 'dsh.client 已声明（没它 = 不在扫描范围）', decl ? JSON.stringify(decl) : '(缺)')
if (decl) {
  add(decl.platform === 'web', "dsh.client.platform === 'web'（不是 web 会被静默跳过）", decl.platform)
  add(Array.isArray(decl.inject) || decl.inject === undefined, 'dsh.client.inject 是字符串数组或省略', JSON.stringify(decl.inject))
}

// ② exports["./client"]
const clientRel = pkg.exports && pkg.exports['./client']
add(!!clientRel, 'exports["./client"] 已声明', clientRel || '(缺)')

// ③ clientPath 真的存在
let clientPath = null
if (clientRel) {
  const rel = typeof clientRel === 'string' ? clientRel : (clientRel && clientRel.default)
  add(typeof rel === 'string', 'exports["./client"] 是 string 或 {default:string}', typeof rel)
  if (typeof rel === 'string') {
    clientPath = path.join(ROOT, rel)
    let exists = false
    let size = 0
    try { const st = fs.statSync(clientPath); exists = st.isFile(); size = st.size } catch { }
    add(exists, '拼出来的 clientPath 真的存在（它会 readFileSync 它）', clientPath + (exists ? '（' + size + ' B）' : '  → 不存在'))
  }
}

// ④⑤ 读 client.js 看形状
if (clientPath && fs.existsSync(clientPath)) {
  const txt = fs.readFileSync(clientPath, 'utf8')
  add(/window\.__ModuleLoader__\.load\s*\(/.test(txt), 'client.js 用 window.__ModuleLoader__.load({...}) 自注册', '')
  add(/exports\.inject\s*=\s*\[[^\]]*["']slots["']/.test(txt), 'exports.inject 含 "slots"（少了它整包静默失效）', '')
  add(/exports\.apply\s*=/.test(txt), 'exports.apply 已导出', '')
  add(/id\s*:\s*["'][^"']*agent-soul/.test(txt), 'load({ id }) 里的 id 带包名（便于 BOOT 图里认出来）', '')
}

// 汇总
const bad = rows.filter((r) => !r.ok)
console.log('dsh-agent-soul-bridge · client half 静态前置检查')
console.log('包目录：' + ROOT)
console.log('')
for (const r of rows) console.log((r.ok ? '  ✔ ' : '  ✘ ') + r.label + (r.detail ? '  — ' + r.detail : ''))
console.log('')
if (bad.length) {
  console.log('结果：' + bad.length + ' 项不通过 —— **浏览器半不会被加载**，先修上面标 ✘ 的。')
  process.exit(1)
} else {
  console.log('结果：全通过。★ 这只证明「形状对」，**不证明「加载发生了」**。')
  console.log('  若界面上仍无按钮：问题在 loader entries（包没被挂）或运行期注册。')
  console.log('  判据（需登录态）：window.__DSH_BOOT__.entries.map(e=>e.id).filter(id=>id.includes("agent-soul"))')
  console.log('    → 空 = 没进 loader entries；有值 = 进了但运行期没注册。')
}
