// 清掉 chunks.jsonl 里的 v4 块（它们现在由 echo 从 sqlite 读）
import fs from 'node:fs'

const F = 'D:/AI/yanqing-soul/00-记忆库/chunks.jsonl'
const BAK = F + '.bak-before-v4clean'

if (!fs.existsSync(F)) { console.log('文件不存在'); process.exit(1) }
const sizeBefore = fs.statSync(F).size
console.log('清理前 ' + Math.round(sizeBefore / 1024 / 1024) + 'MB')

if (!fs.existsSync(BAK)) { fs.copyFileSync(F, BAK); console.log('已备份 → ' + BAK.split('/').pop()) }
else { console.log('备份已存在，不重复备份') }

const lines = fs.readFileSync(F, 'utf8').split('\n')
const keep = []
let dropped = 0
for (const l of lines) {
  if (!l.trim()) continue
  if (l.includes('"mem":"mem:v4-sessions/')) { dropped++; continue }
  keep.push(l)
}
console.log('保留 ' + keep.length + ' 块 · 丢掉 v4 块 ' + dropped + ' 个')

// ★ 原子写：先写 .tmp 再 rename —— echo-mcp 会读这个文件，直接覆盖会让它读到半截
const TMP = F + '.tmp'
fs.writeFileSync(TMP, keep.join('\n') + '\n', 'utf8')
fs.renameSync(TMP, F)

const sizeAfter = fs.statSync(F).size
console.log('清理后 ' + Math.round(sizeAfter / 1024 / 1024) + 'MB（省 ' + Math.round((sizeBefore - sizeAfter) / 1024 / 1024) + 'MB）')

// 复核
const check = fs.readFileSync(F, 'utf8')
console.log('复核：还有 v4 块吗 = ' + check.includes('mem:v4-sessions/'))