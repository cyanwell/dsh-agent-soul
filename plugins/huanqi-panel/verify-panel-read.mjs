/**
 * verify-panel-read.mjs —— 用**真的** cordis.patch.yml 跑一遍面板的 readValues
 *
 * 为什么要这个文件：2026-10-23 那次「下拉框选了又跳回去」，
 * 根因是 readValues 从 `subagentPolicy: 'relaxed'` 里读出了**带引号**的 `'relaxed'`，
 * `<select value="'relaxed'">` 匹配不上 value 为 `relaxed` 的 option，浏览器静默回落第一项。
 *
 * 测的是真函数、真文件 —— 不是复制一份逻辑再自称验过。
 */
import { readFileSync } from 'node:fs'
// ★ Windows 上 ESM 的 import 不接受裸盘符路径（会报 ERR_UNSUPPORTED_ESM_URL_SCHEME），
//   用相对路径最省事 —— 这个脚本和 index.js 同目录。
import { readValues, FIELDS } from './index.js'

const YML = 'D:/AI/dsh/home/profiles/desktop/cordis.patch.yml'
const text = readFileSync(YML, 'utf8')
const r = readValues(text)

console.log('found =', r.found, ' hasConfig =', r.hasConfig)
console.log('')
console.log('面板会看到的每个字段：')
let bad = 0
for (const f of FIELDS) {
  const raw = r.values[f.key]
  const shown = raw === undefined || raw === '' ? String(f.def == null ? '' : f.def) : String(raw)
  let ok = true
  if (f.type === 'enum') {
    const opts = (f.options || []).map((o) => o.value)
    ok = opts.includes(shown)
  }
  if (!ok) bad++
  console.log(
    `  ${f.key.padEnd(22)} 读到的=${JSON.stringify(raw)}  下拉会显示=${JSON.stringify(shown)}  ${ok ? '✓' : '★ 匹配不上 option'}`,
  )
}

console.log('')
if (bad === 0) {
  console.log('✓ 全部能对上 —— 下拉框会显示 YAML 里的真实值')
  process.exit(0)
} else {
  console.log(`★ ${bad} 个字段对不上`)
  process.exit(1)
}
