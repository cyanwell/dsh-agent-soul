#!/usr/bin/env node
/**
 * verify-preset-shape.mjs —— 检查 presets/*.yml 的层级形状
 *
 * 为什么有这个文件（2026-11-05，外部干净机器验证报告 P0-6）
 * ---------------------------------------------------------
 * preset 文件的合法形状只有两种顶层行：
 *   ① 顶层缩进的 preset 块   —— 形如 `   - id: preset-xxx`（有缩进）
 *   ② 顶层 `- insert:`        —— 之后的列表项必须**缩进在被它下面**
 *
 * 2026-11-05 实测到的坏形状：8 个条目（llm-pi-ai / web-ui-pet / webserver …）
 * **顶格**（0 缩进）地散在文件里 —— 那不是 preset 内部条目，而是**profile 级 patch**。
 * 后果：装个 preset 顺手把宿主的 llm-pi-ai providers 覆盖成只剩 3 个，**不报错**。
 *
 * 判据
 * ----
 *   · 扣掉注释与空行后，任何「0 缩进且以 - 开头」的行，只允许是 `- insert:`
 *   · 文件里若出现 `- insert:`，它必须是**最后一个顶格块**，且后面不能有顶格条目
 *   · 有任一违规 → exit 1
 *
 * 用法：node tools/verify-preset-shape.mjs [--dir presets]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

const argOf = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined }
const REPO = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const DIR = argOf('--dir') || join(REPO, 'presets')

if (!existsSync(DIR)) { console.error('✗ 目录不存在：' + DIR); process.exit(1) }

const files = readdirSync(DIR).filter((f) => f.endsWith('.yml'))
if (!files.length) { console.error('✗ ' + DIR + ' 里没有 .yml'); process.exit(1) }

let bad = 0
for (const f of files) {
  const lines = readFileSync(join(DIR, f), 'utf8').split(/\r?\n/)
  const issues = []

  // 收集所有顶格 `- ` 行
  const top = []
  lines.forEach((l, i) => {
    if (!l || /^\s/.test(l) || /^#/.test(l)) return   // 空 / 有缩进 / 注释
    if (/^-/.test(l)) top.push({ n: i + 1, text: l })
  })

  for (const t of top) {
    const isInsert = /^-\s*insert:/.test(t.text)
    if (!isInsert) {
      issues.push(`L${t.n} 顶格条目（会被当成 profile 级 patch）：${t.text.slice(0, 60)}`)
    }
  }

  // insert: 之后不应再有顶格条目
  const insIdx = top.findIndex((t) => /^-\s*insert:/.test(t.text))
  if (insIdx >= 0 && insIdx !== top.length - 1) {
    issues.push(`L${top[insIdx].n} \`- insert:\` 之后还有 ${top.length - 1 - insIdx} 个顶格条目 —— 它们本该缩进在 insert 下`)
  }

  if (issues.length) {
    bad++
    console.log(`\n❌ ${f}  （${issues.length} 处）`)
    issues.slice(0, 12).forEach((s) => console.log('     ' + s))
    if (issues.length > 12) console.log(`     …还有 ${issues.length - 12} 处`)
  } else {
    console.log(`✅ ${f}`)
  }
}

console.log(bad === 0
  ? `\n★ ${files.length} 个 preset 文件层级形状正常。`
  : `\n✗ ${bad} / ${files.length} 个 preset 文件形状不对 —— 这些会被当成 profile 级 patch 打进去。`)
process.exit(bad === 0 ? 0 : 1)
