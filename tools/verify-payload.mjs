// verify-payload —— 验「app/<版本>/ 里的载荷真的等于 dev 源」
// ============================================================================
// 为什么需要它：exe 是壳，改代码只是改 src。**打包漏一个文件，core 就跑着旧代码，
//   而没有任何地方会喊一声** —— 表现是"这个功能怎么没生效"，然后是几小时的排查。
//
// ★ 判据三条（和「编译进程序」那件事对齐）：
//   ① app/current.txt 指向的版本目录存在
//   ② 该目录里 src/tools/sql 的每个文件，hash 都等于 dev 源
//   ③ 没有多出 dev 里不存在的文件（多出来通常是被拷错的残留）
//
// ★ 只报告，不改任何东西。
// ============================================================================
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const DEV = 'D:/AI/agent-soul'
const APP = 'C:/Users/pc/Desktop/deepseek harness/agent soul/app'
const PARTS = ['src', 'tools', 'sql']

const hashOf = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')

// ★ 2026-11-12：工作笔记（_*.md）不是载荷。
//
//   第一次跑校验时它报「缺失 tools/_append-build.md」—— 而那个文件本来就不该进载荷。
//   校验器把「笔记」也当成「必须一致的东西」，于是永远 FAILED。
//
//   ★ 判据：只排下划线开头且 .md 结尾的（笔记 / 临时记录），
//     不排 _*.mjs（探针之类可能是真工具），也不排全部 .md（README 该跟着走）。
const isNote = (rel) => /(^|[\\/])_[^\\/]*[.]md$/.test(rel)

function walk (dir, base, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, base, out)
    else {
      const rel = path.relative(base, full)
      if (!isNote(rel)) out.push(rel)
    }
  }
  return out
}

const cur = fs.readFileSync(path.join(APP, 'current.txt'), 'utf8').trim()
const verDir = path.join(APP, cur)
console.log('current.txt = ' + cur)
console.log('版本目录    = ' + verDir)
if (!fs.existsSync(verDir)) {
  console.log('✗ 版本目录不存在')
  process.exit(1)
}

let total = 0, missing = 0, diff = 0, extra = 0
const missList = [], diffList = [], extraList = []

for (const part of PARTS) {
  const srcDir = path.join(DEV, part)
  if (!fs.existsSync(srcDir)) continue
  const files = walk(srcDir, DEV, [])
  for (const rel of files) {
    total++
    const d = path.join(verDir, rel)
    if (!fs.existsSync(d)) { missing++; if (missList.length < 10) missList.push(rel); continue }
    if (hashOf(path.join(DEV, rel)) !== hashOf(d)) { diff++; if (diffList.length < 10) diffList.push(rel) }
  }
  // 反向：版本目录里有没有 dev 没有的
  const verPartDir = path.join(verDir, part)
  if (fs.existsSync(verPartDir)) {
    for (const rel of walk(verPartDir, verDir, [])) {
      if (!fs.existsSync(path.join(DEV, rel))) { extra++; if (extraList.length < 10) extraList.push(rel) }
    }
  }
}

console.log('')
console.log('比对 ' + total + ' 个文件')
console.log('  缺失 ' + missing)
for (const x of missList) console.log('    - ' + x)
console.log('  不同 ' + diff)
for (const x of diffList) console.log('    ≠ ' + x)
console.log('  多出 ' + extra)
for (const x of extraList) console.log('    + ' + x)
console.log('')
const ok = missing === 0 && diff === 0 && extra === 0
console.log(ok ? 'ALL PASS · 载荷和 dev 源逐文件一致' : 'FAILED · 载荷和 dev 源不一致（重打包）')
process.exit(ok ? 0 : 1)
