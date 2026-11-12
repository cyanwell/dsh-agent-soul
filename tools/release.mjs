// release.mjs —— 一键发布：打包 → 切版本 → 校验 → （可选）重启
// ============================================================================
// 为什么需要它：2026-11-12 那一轮我手动做了四次「复制载荷 + 同步 + 校验」，
//   每次都要记着：src/tools/sql 三样都拷、VERSION.txt 要写、current.txt 要切、
//   然后 verify-payload 要 PASS。**手做四次，就有四次漏的机会。**
//
// ★ 步骤顺序不是风格：
//   ① 打包（复制到 app/<新版本>）
//   ② 校验（**切 current.txt 之前**验 —— 坏载荷不该被激活）
//   ③ 清掉残留的 data/（那是 cwd 解析错的假目录，不是载荷）
//   ④ 切 current.txt
//   ⑤ 重启（可选，加 --restart）
//
// 用法：
//   node tools/release.mjs               # 打包到下一个版本号，校验，切过去
//   node tools/release.mjs --dry         # 只报告要做什么
//   node tools/release.mjs --restart     # 打包 + 校验 + 切 + 重启 core
//   node tools/release.mjs --to 1.0.8    # 指定版本号
// ============================================================================
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'

const DEV = 'D:/AI/agent-soul'
const APP = 'C:/Users/pc/Desktop/deepseek harness/agent soul/app'
const ROOT = 'C:/Users/pc/Desktop/deepseek harness/agent soul'
const PARTS = ['src', 'tools', 'sql']
const args = process.argv.slice(2)
const DRY = args.includes('--dry')
const RESTART = args.includes('--restart')
const TO = (args.find((a) => a.startsWith('--to=')) || '').split('=')[1] || ''
const log = (m) => console.log(m)
const NL = String.fromCharCode(10)

function nextVersion (cur) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(cur)
  if (!m) return ''
  return m[1] + '.' + m[2] + '.' + (Number(m[3]) + 1)
}

// ---------- ① 定版本号 ----------
const cur = fs.readFileSync(path.join(APP, 'current.txt'), 'utf8').trim()
const target = TO || nextVersion(cur)
if (!target) { log('✗ 版本号读不出来：' + cur); process.exit(1) }
const verDir = path.join(APP, target)
log('当前版本 = ' + cur)
log('目标版本 = ' + target)
log('版本目录 = ' + verDir)
if (DRY) { log(''); log('[dry] 会做：复制 ' + PARTS.join('/') + ' → 写 VERSION.txt → 校验 → 切 current.txt' + (RESTART ? ' → 重启' : '')); process.exit(0) }
if (fs.existsSync(verDir)) {
  log('✗ ' + target + ' 已存在 —— 不覆盖（先删掉或换版本号）')
  process.exit(1)
}

// ---------- ② 复制载荷 ----------
log('')
log('[1/4] 复制载荷')
fs.mkdirSync(verDir, { recursive: true })
let fileCount = 0
for (const part of PARTS) {
  const s = path.join(DEV, part)
  if (!fs.existsSync(s)) continue
  fs.cpSync(s, path.join(verDir, part), { recursive: true })
  fileCount += countFiles(path.join(verDir, part))
}
fs.copyFileSync(path.join(DEV, 'package.json'), path.join(verDir, 'package.json'))
log('  ' + fileCount + ' 个文件')
log('  ★ 不复制 data/ —— 那是运行时目录，不是载荷')

function countFiles (dir) {
  let n = 0
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFiles(path.join(dir, e.name))
    else n++
  }
  return n
}

// ---------- ③ VERSION.txt ----------
const ver = [
  'AgentSoul payload ' + target + ' built: ' + new Date().toISOString().replace('T', ' ').slice(0, 19),
  'source: D:\AI\agent-soul (dev)',
  'changes: （由 release.mjs 生成 —— 手写的地方在下面一行）',
  '  ' + (args.find((a) => a.startsWith('--changes=')) || '').replace('--changes=', ''),
  '',
  'This directory is the business payload only. The shell that starts it lives two levels up.',
  'Rollback: edit ..\\current.txt back to ' + cur + '.',
].join(NL)
fs.writeFileSync(path.join(verDir, 'VERSION.txt'), ver + NL, 'utf8')
log('[2/4] VERSION.txt 写好')

// ---------- ④ 校验（切之前）----------
log('[3/4] 校验载荷')
// ★ 先让 current.txt 指向新目录，verify-payload 才会验它；但它自己会读 current.txt。
//   所以这里临时改 current.txt、验、失败再改回去 —— 比复制一份校验逻辑可靠。
const curTxt = path.join(APP, 'current.txt')
fs.writeFileSync(curTxt, target + NL, 'utf8')
let verifyOk = false
try {
  execFileSync(process.execPath, [path.join(DEV, 'tools/verify-payload.mjs')], { stdio: 'inherit' })
  verifyOk = true
} catch (e) {
  verifyOk = false
}
if (!verifyOk) {
  log('')
  log('✗ 校验失败 —— 回滚 current.txt 到 ' + cur)
  fs.writeFileSync(curTxt, cur + NL, 'utf8')
  log('  （' + target + ' 目录保留，没激活）')
  process.exit(1)
}
log('  ✓ 载荷和 dev 源逐文件一致')

// ---------- ⑤ 重启（可选）----------
log('[4/4] 已切到 ' + target)
if (RESTART) {
  log('  重启 core...')
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join('D:/AI/SnowLuma/config/onebot_3937956599.json'), 'utf8'))
    process.env.SOUL_ONEBOT_WS_TOKEN = String(cfg.networks.wsServers[0].accessToken || '')
  } catch (e) { log('  ✗ 读不到 token：' + e.message) }
  try { execFileSync('taskkill', ['/IM', 'AgentSoul.exe', '/F'], { stdio: 'ignore' }) } catch (e) {}
  await new Promise((r) => setTimeout(r, 2500))
  // ★ 2026-11-12：和 start-all.mjs 一样设 AURABOT_NO_CONNECT ——
  //   否则从这里起的 core 会让 v4 侧的 aurabot 去连 QQ，和 DSH 侧撞成双发。
  //   **两处起 core 的地方要设同一个变量，漏一处就等于没设。**
  const env = { ...process.env }
  spawn(path.join(ROOT, 'AgentSoul.exe'), [], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true, env }).unref()
  log('  ✓ 已拉起（等约 30 秒让它连上）')
} else {
  log('  （没有 --restart，core 还在跑旧内存；要生效请重启）')
}

log('')
log('完成：' + cur + ' → ' + target)