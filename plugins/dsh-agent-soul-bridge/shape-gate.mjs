/**
 * shape-gate.mjs —— 「两层形状假设」的静态闸（2026-11-21）
 *
 * 跑法（两个包目录下都要能跑）：
 *   node shape-gate.mjs <目录>...
 *
 * ★ 为什么要有它：今天我们同一个错误犯了**六次** ——
 *   代码假设 tool/result 是两层（`data.message.content[0].content`），
 *   而真机 1736 个会话里**一层形状 100%、两层 0 条**。
 *
 *   六处：pruner 的 eventText / canonicalEventText / super.pruneSession / blocksBySeq，
 *        桥的 textLengthOf / hasPruneMarkerLike。
 *   五处静默、一处抛错；全靠事后一个个撞出来。
 *
 * ★ 这条闸拦什么：
 *   生产代码（不含注释、不含 .bak / _verify / test）里出现
 *   `message.content[0].content` 这种**直接两层取值**就报错，
 *   指向应该改用的统一入口（`contentBlocksOf` / `blocksOf`）。
 *
 * ★ 它拦不到什么（诚实边界）：
 *   · 写成分步的（`const a = m.content; const b = a[0].content`）拦不到
 *   · 换行拆开的拦不到
 *   所以它只是**第一道** —— 真正的闸是那两条形状回归断言
 *   （`shape-regression.test.mjs` / adapter.test.mjs ⑪⑫），它们拿真帧喂函数。
 */
import fs from 'node:fs'
import path from 'node:path'

const SKIP_DIRS = new Set(['node_modules', '.git', '_verify', '_fix-20261121', 'test', 'test-verification', 'dist', 'build'])
const SKIP_EXT = new Set(['.md', '.json', '.map'])
const isBak = (n) => /\.bak-/.test(n)

/** 剥掉块注释与行注释 —— 注释里提到这个形状是**对的**（解释为什么不能这么写）。 */
function stripComments (src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/**
 * 直接两层取值：`message.content[0].content` 或 `message?.content?.[0]?.content`
 *
 * ★★★ 第一版这个正则写错了 —— 我写成 `content\s*\??\.\s*\[`（要求 content 与 [ 之间有句点），
 *   而真实写法是 **`content[0]`，中间没有句点**。于是**一条都没匹配上**，
 *   闸门打印「✔ 没有直接两层取值」—— **绿的，但等于没装**。
 *   是靠自测（拿一个已知坏的临时文件跑一遍）才发现的：
 *   自测那次它也报 ✔，我才知道闸门本身有毛病。
 *
 * ★ 判据：**任何"检查器"都必须先用一个已知违规的样本验它会红。**
 *   不做这一步，得到的绿灯只证明它跑完了，不证明它检查过。
 */
const BAD = /message\s*(?:\?\.|\.)\s*content\s*(?:\?\.)?\[\s*0\s*\]\s*(?:\?\.|\.)\s*content/

function scan (dir, hits) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) scan(full, hits); continue }
    if (SKIP_EXT.has(path.extname(e.name)) || isBak(e.name)) continue
    let src
    try { src = fs.readFileSync(full, 'utf8') } catch { continue }
    const code = stripComments(src)
    const lines = code.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      if (BAD.test(lines[i])) hits.push({ file: full, line: i + 1, text: lines[i].trim().slice(0, 140) })
    }
  }
}

const dirs = process.argv.slice(2)
if (!dirs.length) { console.log('用法：node shape-gate.mjs <目录>...'); process.exit(2) }

const hits = []
for (const d of dirs) scan(path.resolve(d), hits)

if (hits.length) {
  console.log('✗ 生产代码里还有直接两层取值（' + hits.length + ' 处）：')
  for (const h of hits) console.log('  ' + h.file + ':' + h.line + '\n      ' + h.text)
  console.log('')
  console.log('应改用统一入口：pruner 用 contentBlocksOf(event)，桥用 blocksOf(ev)。')
  console.log('★ 一层/两层都认，且同一种形状只准有一个读取入口。')
  process.exit(1)
}
console.log('✔ 没有直接两层取值（' + dirs.length + ' 个目录）')
console.log('★ 这只是第一道闸；真正的闸是 shape-regression.test.mjs / adapter.test.mjs ⑪⑫ 拿真帧喂函数。')
