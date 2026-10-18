/**
 * check-soul-refs.mjs —— 对账 soul/ 下所有文档里的「引用」是否还成立
 *
 * 为什么需要它：
 *   soul/ 里那些文档会引用别的文件、引用脚本命令、引用「一共几份」这种数字。
 *   改一处忘了另一处，就是第二份真相 —— 而它不会报错，只会让照着做的人踩空。
 *   ★ 2026-10-18 实测就踩到过：05-doctor.md 的四条自检命令指向
 *     tools/ledger/ tools/gateway/ tools/self/ —— 那三个目录在这个仓库里根本不存在。
 *     照着跑 404，而 404 会被误读成「我的架构坏了」。
 *
 * 它查四类：
 *   ① `node <路径>`          —— 文件在不在
 *   ② 反引号里的 <名字>.md   —— 文件在不在
 *   ③ 「N 份知识文件」        —— 和实际份数对不对
 *   ④ 硬编码的本机绝对路径    —— 换台机器就崩
 *
 * 用法：node tools/check-soul-refs.mjs
 * 退出码：0 = 全对；1 = 有问题（CI 可以直接用它）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const SOUL = path.join(ROOT, 'soul')
const KIT = path.join(ROOT, 'kit', 'echo')

const problems = []
const notes = []

function mdFiles(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => path.join(dir, f))
}

// ★ 「知识文件」= soul/ 下的**所有**文件，不只 .md。
//   第一版只数 .md，于是 04-manifest.json / 07-bundle.json 不算，
//   09 份对 11 份 —— 检查器自己错，却把对的文档报成错的。
//   这正是它要防的那类错：**尺子和被量对象不是同一把尺子。**
function allSoulFiles(dir) {
  return fs.readdirSync(dir).filter((f) => !f.startsWith('.')).map((f) => path.join(dir, f))
}

const files = mdFiles(SOUL)          // 要扫引用的：只扫 .md
const allSoul = allSoulFiles(SOUL)   // 用来数「N 份知识文件」的：全部
const fileNames = new Set(files.map((f) => path.basename(f)))

// ★ 这些是**用户侧**的文件：装配器给你生成、或者你自己写的。
//   包里当然没有它们 —— 引用它们是对的，不是失效引用。
//   （2026-10-18 第一版没这条白名单，把 SELF.md / AGENTS.md 全报成了错。）
const USER_SIDE = new Set([
  'SELF.md', 'SELF.src.md',
  'AGENTS.md', 'GLOSSARY.md', 'VITAL.md',
  '02-墨.jsonl',
  'README.md', 'INSTALL.md',
])

/** 中文/阿拉伯数字 → 数。解析不出来返回 undefined（调用方必须报告，不能静默跳过）。 */
function parseCnNumber(s) {
  if (/^\d+$/.test(s)) return Number(s)
  const d = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  if (s === '十') return 10
  if (s.includes('十')) {
    const [a, b] = s.split('十')
    // 「十五」→ a 空、b 五；「二十」→ a 二、b 空；「二十三」→ 两边都有
    const l = a === '' ? 1 : d[a]
    const r = b === '' ? 0 : d[b]
    if (l === undefined || r === undefined) return undefined
    return l * 10 + r
  }
  if (s.length === 1) return d[s]
  return undefined
}

/** 这个路径在仓库里找得到吗（按几个常见的落点试） */
function resolveRef(ref) {
  const cleaned = ref.replace(/[`'"]/g, '').trim()
  if (!cleaned) return null
  // 带占位符的不查 —— 那不是真路径
  if (/[<>\[\]]/.test(cleaned)) return { placeholder: true }
  const candidates = [
    path.join(ROOT, cleaned),
    path.join(KIT, cleaned),
    path.join(SOUL, cleaned),
  ]
  for (const c of candidates) if (fs.existsSync(c)) return { ok: true, at: c }
  return { ok: false }
}

for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/')
  const text = fs.readFileSync(f, 'utf8')
  const lines = text.split('\n')

  lines.forEach((line, i) => {
    const lineNo = i + 1

    // ① node <路径>
    for (const m of line.matchAll(/node\s+([^\s`'"|]+\.(?:mjs|js|cmd|py))/g)) {
      const r = resolveRef(m[1])
      if (r && r.ok === false) {
        problems.push(`${rel}:${lineNo}  命令指向不存在的文件  ${m[1]}`)
      } else if (r && r.placeholder) {
        notes.push(`${rel}:${lineNo}  命令里带占位符（跳过）  ${m[1]}`)
      }
    }

    // ② 反引号里的 <名字>.md
    for (const m of line.matchAll(/`([A-Za-z0-9_\u4e00-\u9fa5-]+\.md)`/g)) {
      if (fileNames.has(m[1]) || USER_SIDE.has(m[1])) continue
      const r = resolveRef(m[1])
      if (!r || r.ok === false) problems.push(`${rel}:${lineNo}  引用不存在的文档  ${m[1]}`)
    }

    // ③ 「N 份知识文件」—— ★ 只认这个完整说法。
    //    第一版写成「N 份(?:知识)?文件」，于是「改同一份文件的副本」里的「一份」也被抓了。
    //    少一个可选括号，多一条假警报。
    for (const m of line.matchAll(/([一二三四五六七八九十两]+|\d+)\s*份知识文件/g)) {
      const n = parseCnNumber(m[1])
      if (n !== undefined && n !== allSoul.length) {
        problems.push(`${rel}:${lineNo}  说「${m[1]}份」，实际 ${allSoul.length} 份`)
      }
      // ★ 解析不出来要说出来，不能静默跳过。
      //   第一版只认「一到十」，于是「十五份」被当成 undefined 直接跳过 ——
      //   正对照实测漏掉了这一条。**检查器漏检比不检查更坏**，因为它给的是「全对」的错觉。
      if (n === undefined) {
        notes.push(`${rel}:${lineNo}  「${m[1]}份知识文件」里的数读不出来，这条没查`)
      }
    }

    // ④ 硬编码本机绝对路径（注释和示例里出现也算 —— 那是最容易被复制走的地方）
    if (/[A-Z]:[\\/](?:AI|Users)[\\/]/.test(line)) {
      problems.push(`${rel}:${lineNo}  硬编码本机路径  ${line.trim().slice(0, 72)}`)
    }
  })
}

// ── 报告 ──
console.log('')
console.log(`soul 引用对账（扫了 ${files.length} 份文档）`)
console.log('─'.repeat(72))
if (!problems.length) {
  console.log('  ✓ 全部引用都成立')
} else {
  for (const p of problems) console.log('  ✗ ' + p)
  console.log('')
  console.log(`  共 ${problems.length} 处。`)
}
if (notes.length) {
  console.log('')
  console.log(`  （${notes.length} 处带占位符的命令，跳过不查）`)
}
console.log('')
process.exit(problems.length ? 1 : 0)
