import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const SEP = path.sep
const issues = []
const checks = []

function check(name, ok, detail) {
  checks.push({ name, ok, detail })
  if (!ok) issues.push(name + (detail ? ' -- ' + detail : ''))
}

// ── 1. 主包 package.json ──────────────────────────
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
check('package.json 可解析', true)
check('有 files 字段', Array.isArray(pkg.files) && pkg.files.length > 0, 'items=' + (pkg.files || []).length)

const mustTop = ['index.js', 'client.js', 'install.js', 'cordis.patch.yml']
for (const f of mustTop) {
  check('files 含 ' + f, pkg.files.includes(f))
}
for (const d of ['soul/', 'skeleton/', 'kit/', 'plugins/', 'tools/']) {
  check('files 含 ' + d, pkg.files.includes(d))
}

// files 里每一项都真实存在
for (const f of pkg.files) {
  check('files 条目存在: ' + f, fs.existsSync(f.replace(/\/$/, '')))
}

// exports 映射的目标存在
for (const [k, v] of Object.entries(pkg.exports || {})) {
  if (typeof v === 'string' && v.startsWith('./')) {
    check('exports' + k + ' 指向存在', fs.existsSync(v))
  }
}

// dsh.client 声明了就必须有 client.js
if (pkg.dsh?.client) {
  check('dsh.client 已声明时 client.js 存在', fs.existsSync('client.js'))
}

// ── 2. install-desktop.ps1 清单 ──────────────────
const ps1 = fs.readFileSync('install-desktop.ps1', 'utf8')
const psFilesM = ps1.match(/\$files = @\(([^)]*)\)/)
const psDirsM = ps1.match(/foreach \(\$d in @\(([^)]*)\)\)/)
const clean = (s) => s.trim().replace(/^['"]|['"]$/g, '')
const psFiles = (psFilesM ? psFilesM[1] : '').split(',').map(clean).filter(Boolean)
const psDirs = (psDirsM ? psDirsM[1] : '').split(',').map(clean).filter(Boolean)

check('ps1 有 $files 清单', psFiles.length > 0, psFiles.length + ' 项')
check('ps1 $files 含 client.js', psFiles.includes('client.js'))
check('ps1 $dirs 含 plugins', psDirs.includes('plugins'))
for (const f of psFiles) {
  if (f === 'install-desktop.ps1') continue
  check('ps1 清单文件存在: ' + f, fs.existsSync(f))
}
for (const d of psDirs) {
  check('ps1 清单目录存在: ' + d, fs.existsSync(d))
}

// ── 3. 两份清单一致性 ────────────────────────────
check('ps1 与 package.json 都覆盖 client.js', psFiles.includes('client.js') && pkg.files.includes('client.js'))
check('ps1 与 package.json 都覆盖 plugins', psDirs.includes('plugins') && pkg.files.includes('plugins/'))

// ── 4. ps1 的关键防护 ────────────────────────────
check('ps1 有暂存目录（stage）', ps1.includes('dsh-agent-soul-stage-'))
check('ps1 自检在改 bundles 之前', ps1.indexOf('$mustHave') > 0 && ps1.indexOf('$mustHave') < ps1.indexOf('add-bundle.js'))
check('ps1 失败时删暂存目录', ps1.includes('Remove-Item $stage'))
check('ps1 用 Move-Item 换到位', ps1.includes('Move-Item $stage $dest'))
check('ps1 自检包含 client.js', ps1.includes("'client.js'"))

// ── 5. plugins/ 全部有 files 且覆盖 main/client ───
const pluginNames = fs
  .readdirSync('plugins', { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()

let pluginOk = 0
for (const n of pluginNames) {
  const pj = path.join('plugins', n, 'package.json')
  if (!fs.existsSync(pj)) continue // tools/ 这类不是插件
  const p = JSON.parse(fs.readFileSync(pj, 'utf8'))
  const files = (p.files || []).map((f) => f.replace(/^\.\//, ''))
  if (!p.files) {
    check('plugins/' + n + ' 有 files', false)
    continue
  }
  const need = []
  if (p.main) need.push(p.main.replace(/^\.\//, ''))
  if (p.dsh?.client) need.push('client.js')
  if (p.dsh?.bundle?.patch) need.push(p.dsh.bundle.patch.replace(/^\.\//, ''))
  const miss = need.filter((x) => {
    const top = x.split('/')[0]
    return !files.includes(x) && !files.includes(top) && !files.includes(top + '/')
  })
  check('plugins/' + n + ' files 覆盖 main/client/patch', miss.length === 0, miss.join(','))
  if (miss.length === 0) pluginOk++
}

// ── 5b. 每个包的 cordis.patch.yml 里 name 必须等于 package.json 的 name ──
//     ★ 2026-10-22 由外部审核揪出来的：huanqi 的包名是 dsh-huanqi，patch 里
//     却写 dsh-agent-huanqi。patch 指向一个不存在的模块名，包照样装得上、
//     进程照样活着，只是那一层永远不会被加载 —— 没有报错，是最难发现的一种坏。
{
  const dirs = fs
    .readdirSync('plugins', { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
  for (const d of dirs) {
    const pjPath = path.join('plugins', d, 'package.json')
    if (!fs.existsSync(pjPath)) continue
    const pj = JSON.parse(fs.readFileSync(pjPath, 'utf8'))
    const patchRel = pj.dsh && pj.dsh.bundle && pj.dsh.bundle.patch
    if (!patchRel) continue
    const patchPath = path.join('plugins', d, path.basename(patchRel))
    if (!fs.existsSync(patchPath)) {
      check('plugins/' + d + ' bundle.patch 文件存在', false, patchPath)
      continue
    }
    const yml = fs.readFileSync(patchPath, 'utf8')
    const line = yml.split('\n').find((l) => /^\s*name:\s*\S/.test(l)) || ''
    const m = line.match(/^\s*name:\s*['"]?([^'"]+?)['"]?\s*$/)
    const patchName = m ? m[1].trim() : ''
    check(
      'plugins/' + d + ' patch.name 等于包名',
      patchName === pj.name,
      'pkg=' + pj.name + ' patch=' + (patchName || '(缺)')
    )
  }
}

// ── 5c. install.js 的 ORDER 必须覆盖 plugins/ 下每个包，且不多不少 ──
{
  const src = fs.readFileSync('install.js', 'utf8')
  const groups = [...src.matchAll(/parts:\s*\[([^\]]+)\]/g)].map((m) =>
    m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean)
  )
  const listed = groups.flat()
  const pkgDirs = fs
    .readdirSync('plugins', { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((d) => fs.existsSync(path.join('plugins', d, 'package.json')))
  const missing = pkgDirs.filter((d) => !listed.includes(d))
  const extra = listed.filter((d) => !pkgDirs.includes(d))
  check('install.js ORDER 覆盖全部包', missing.length === 0, '漏: ' + missing.join(','))
  check('install.js ORDER 没有多余项', extra.length === 0, '多: ' + extra.join(','))
  check('install.js ORDER 总数等于包数', listed.length === pkgDirs.length,
    'ORDER=' + listed.length + ' pkgs=' + pkgDirs.length)
}

// ── 5d. install.js 的 PKG() 不能只靠前缀拼 ──
{
  const src = fs.readFileSync('install.js', 'utf8')
  check(
    'install.js 的 PKG 会读真实包名',
    src.includes('loadPkgNames') && src.includes('PKG_NAMES.get(dir)'),
    '硬编码前缀对 huanqi 会算错'
  )
}

// ── 6. 文档里的关键条目 ──────────────────────────
const install = fs.readFileSync('INSTALL.md', 'utf8')
check('INSTALL.md 有恢复步骤', install.includes('如果已经中招了'))
check('INSTALL.md 记录了执行策略坑', install.includes('PSSecurityException'))
check('INSTALL.md 记录了 staged 拷贝', install.includes('暂存目录'))

const readme = fs.readFileSync('README.md', 'utf8')
check('README 有 2026-10-22 的更新记录', (readme.match(/### 2026-10-22/g) || []).length >= 2)

// ── 输出 ────────────────────────────────────────
console.log('=== 自检结果 ===')
for (const c of checks) {
  console.log((c.ok ? '  OK   ' : '  FAIL ') + c.name + (c.detail && !c.ok ? '  [' + c.detail + ']' : ''))
}
console.log('')
console.log('通过 ' + checks.filter((c) => c.ok).length + ' / ' + checks.length)
console.log('插件 files 合格 ' + pluginOk + ' 个')
console.log('')
if (issues.length) {
  console.log('=== 失败项 ===')
  for (const i of issues) console.log('  * ' + i)
  process.exitCode = 1
} else {
  console.log('★ 全部通过')
}
