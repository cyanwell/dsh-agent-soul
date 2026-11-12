// patch-selftest —— 验 patch-aurabot.mjs 的**打补丁路径**（不只是 --check）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

let pass = 0, fail = 0
const ok = (n, c, d) => { if (c) { pass++; console.log('  ✓ ' + n + (d ? '  ' + d : '')) } else { fail++; console.log('  ✗ ' + n + (d ? '  ' + d : '')) } }

const NODE = process.execPath
const SCRIPT = 'D:/AI/agent-soul/tools/patch-aurabot.mjs'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-test-'))
const target = path.join(tmp, 'hub.js')

// ★ 造一份**最小但锚点精确**的 hub.js —— 两个锚点逐字照抄真实的。
const ORIGINAL = [
  '// 假的 hub.js，只保留打补丁需要的两个锚点',
  'function hub () {',
  '  function release (id) {}',
  '  function soulOn () { return true }',
  '  const log = { debug () {} }',
  '  async function pushToSession(chat, content, senderId, opts = {}) {',
  '    return 1',
  '  }',
  '  function onSessionEvent (chatId, text) {',
  // ★ 缩进必须与真实文件逐字一致（脚本的锚点是 "      if (!text) return release(chatId)"，6 空格）。
  //   第一次写成 4 空格，补丁找不到锚点，报「失败 1 个」——
  //   而那条失败信息在输出末尾，看起来像"打补丁成功了但没插入"。
  '      if (!text) return release(chatId)',
  '    return 2',
  '  }',
  '}',
  '',
].join('\n')
fs.writeFileSync(target, ORIGINAL, 'utf8')

const run = (args) => {
  try {
    return { ok: true, out: execFileSync(NODE, [SCRIPT, '--target', target, ...args], { encoding: 'utf8' }) }
  } catch (e) {
    return { ok: false, out: String((e && e.stdout) || '') + String((e && e.stderr) || '') }
  }
}

console.log('=== ① 原始文件 ===')
{
  const r = run(['--check'])
  ok('--check 报未打', r.out.includes('未打'), r.out.split('\n').filter((l) => l.includes('闸')).join(' / '))
  ok('--check 不动文件', fs.readFileSync(target, 'utf8') === ORIGINAL, null)
}

console.log('=== ② 打补丁 ===')
let after = ''
{
  const r = run([])
  ok('打补丁没报错', r.ok === true, r.out.split('\n').slice(-2).join(' '))
  after = fs.readFileSync(target, 'utf8')
  ok('插入了收/判/投闸', after.includes('// [v4-gate-recv]'), null)
  ok('插入了发回复闸', after.includes('// [v4-gate-send]'), null)
  const gateCount = (after.match(/if \(soulOn\(\)\) \{/g) || []).length
  ok('闸代码真的在', gateCount === 2, gateCount + ' 处')
  // ★ 先判存在再读，别让"没备份"变成"读取抛错崩掉整个自检"。
  const bakExists = fs.existsSync(target + '.before-v4gate')
  ok('产生了备份', bakExists, null)
  ok('备份是原始内容', bakExists && fs.readFileSync(target + '.before-v4gate', 'utf8') === ORIGINAL, null)
}

console.log('=== ③ 幂等 ===')
{
  const r = run([])
  const again = fs.readFileSync(target, 'utf8')
  const gateCount = (again.match(/if \(soulOn\(\)\) \{/g) || []).length
  ok('第二次不重复插入', gateCount === 2, gateCount + ' 处')
  ok('内容一字没变', again === after, null)
  ok('报告跳过', r.out.includes('跳过'), r.out.split('\n').filter(Boolean).slice(-1)[0])
}

console.log('=== ④ 打过之后 ===')
{
  const r = run(['--check'])
  const lines = r.out.split('\n').filter((l) => l.includes('闸')).join(' / ')
  ok('--check 报已打', lines.includes('已打') && !lines.includes('未打'), lines)
}

console.log('=== ⑤ 打完仍合法 ===')
{
  let syntaxOk = true
  try { execFileSync(NODE, ['--check', target], { encoding: 'utf8', stdio: 'pipe' }) } catch { syntaxOk = false }
  ok('打完语法 OK', syntaxOk, null)
}

try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 忽略 */ }

console.log('')
console.log((fail === 0 ? 'ALL PASS' : 'FAILED') + ' · ' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
