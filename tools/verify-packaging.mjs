import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import os from 'node:os'

// ★ 占位符判定的唯一真源（R1，2026-10-22）
const { inspect: inspectPlaceholders } = await import('../kit/echo/placeholder.mjs')

// ★ 不从 cwd 起步（V4，2026-10-22）。
//   原来写的是 `const ROOT = process.cwd()`，然后所有读取都用相对路径 ——
//   于是 `node tools/verify-packaging.mjs` 从仓库根跑没事，
//   从别的地方跑（或子目录里）就 ENOENT，而脚本没有「我在对的目录吗」的自检，
//   用户会以为是「包坏了」。
//   现在自己 chdir 到脚本的上一级，跟从哪调用无关。
const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.join(HERE, '..')
process.chdir(PKG_ROOT)

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
check('ps1 自检在改 bundles 之前', ps1.indexOf('$mustHave') > 0 && ps1.indexOf('$mustHave') < ps1.indexOf('add-bundle.cjs'))
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
  // ORDER 里的条目有两类：本仓库 plugins/<dir>，以及外部件（07-bundle.json 里
  // external: true 的）。外部件不是目录，但必须出现在 ORDER 里 ——
  // 否则 plan 永远不提示装它（2026-10-22 就是这样漏掉了 I ECHO 的 dsh-mnemon）。
  const bundleJson = JSON.parse(fs.readFileSync('soul/07-bundle.json', 'utf8'))
  const allParts = Array.isArray(bundleJson.parts) ? bundleJson.parts : []
  const externalDirs = allParts.filter((p) => p.external === true).map((p) => p.dir)
  const missing = pkgDirs.filter((d) => !listed.includes(d))
  const unknown = listed.filter((d) => !pkgDirs.includes(d) && !externalDirs.includes(d))
  check('install.js ORDER 覆盖全部本仓库包', missing.length === 0, '漏: ' + missing.join(','))
  check('install.js ORDER 没有来历不明的条目', unknown.length === 0, '多: ' + unknown.join(','))
  check('install.js ORDER 总数 = 包数 + 外部件数',
    listed.length === pkgDirs.length + externalDirs.length,
    'ORDER=' + listed.length + ' pkgs=' + pkgDirs.length + ' ext=' + externalDirs.length)

  // ★ 必备零件必须都在 ORDER 里。这条是补 2026-10-22 那个洞的：
  //   dsh-mnemon 在 07-bundle.json 里标着 required: true、layer I-echo，
  //   却不在 ORDER 里 —— 参考清单说要装，plan 从不提起。
  const requiredParts = allParts.filter((p) => p.required === true).map((p) => p.dir)
  const reqMissing = requiredParts.filter((d) => !listed.includes(d))
  check('bundle 里 required 的零件都在 ORDER 里', reqMissing.length === 0,
    '漏: ' + reqMissing.join(','))

  // ★ 外部件不能被当成 file: 路径安装 —— 那个目录在本仓库里不存在。
  const installSrc = fs.readFileSync('install.js', 'utf8')
  check('install.js 对外部件给的是包名不是 file: 路径',
    installSrc.includes('EXTERNAL_DIRS.has(dir)'),
    '需要 installCommand 里单独处理 external')
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

// ── 7. 子包的 exports 通配符必须落在 files 白名单里（V2，2026-10-22）──
//
// ★ 这条治的病：`exports["./src/*"]` 指向一个不在 `files` 里的目录 ——
//   源仓库里能跑，**`npm pack` 之后就是死链**，运行时才 404。
//   以前自检只看 main/client/patch 三个字段，exports 一个字没查。
{
  const plugDir = 'plugins'
  for (const e of fs.readdirSync(plugDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const pj = path.join(plugDir, e.name, 'package.json')
    if (!fs.existsSync(pj)) continue
    let sub
    try {
      sub = JSON.parse(fs.readFileSync(pj, 'utf8').replace(/^\uFEFF/, ''))
    } catch {
      check('子包 package.json 可解析: ' + e.name, false)
      continue
    }
    const exportsMap = sub.exports && typeof sub.exports === 'object' ? sub.exports : {}
    const files = Array.isArray(sub.files) ? sub.files : []
    for (const [key, val] of Object.entries(exportsMap)) {
      if (!key.includes('*')) continue
      const target = typeof val === 'string' ? val : val && (val.default || val.import)
      if (typeof target !== 'string' || !target.includes('*')) continue
      // 取通配符之前的目录前缀，例如 "./src/*" -> "src"
      const prefix = target.replace(/^\.\//, '').split('*')[0].replace(/\/+$/, '')
      if (!prefix) continue
      const covered = files.some((f) => f === prefix || f === prefix + '/' || f.startsWith(prefix + '/'))
      check(
        `子包 exports 通配符落在 files 里: ${e.name} → ${key}`,
        covered,
        `前缀 "${prefix}" 不在 files 里，打包后是死链`,
      )
    }
  }
}

// ── 8. plan 和 scan 走同一条包名解析路径（V3，2026-10-22）──
//
// ★ 这条是 N4 的判据：`loadPkgNames()` 当时只在 plan 分支调，
//   scan 分支在它之前就 return 了 —— 于是装好的 dsh-huanqi 在 scan 里永远认不出来
//   （PKG('huanqi') 退化成 dsh-agent-huanqi）。补丁式修复最容易犯的错就是
//   「改了 plan 忘了 scan」，所以拿行号顺序把它钉住。
{
  const src = fs.readFileSync('install.js', 'utf8')
  const idxLoad = src.search(/\bloadPkgNames\s*\(/)
  const idxScan = src.search(/action\s*===\s*'scan'/)
  check(
    'loadPkgNames 在 scan 分支之前就被调用',
    idxLoad >= 0 && idxScan >= 0 && idxLoad < idxScan,
    `loadPkgNames@${idxLoad} scan@${idxScan}`,
  )
}

// ── 9. ps1 的结构校验接进主自检（V1，2026-10-22）──
//
// ★ 这一条不是「检查某个字符串在不在」，而是**调子进程跑结构断言**：
//   verify-ps1-logic.mjs 用 PowerShell 的 AST 解析 install-desktop.ps1，
//   验的是「这句 Die 在不在 $rollbackOk 为真的分支里」这类**逻辑位置**。
//   旧的字符串断言证明不了这个 —— N1（回滚失败却谎称已恢复）在旧代码里能全绿。
{
  const tool = path.join(PKG_ROOT, 'tools', 'verify-ps1-logic.mjs')
  check('ps1 结构校验工具存在', fs.existsSync(tool))
  if (fs.existsSync(tool)) {
    try {
      const out = execFileSync(process.execPath, [tool], { encoding: 'utf8', timeout: 90000 })
      check('ps1 结构断言全部通过（AST，不是字符串包含）', /★ 全部通过/.test(out))
    } catch (e) {
      const tail = String((e && e.stdout) || '').trim().split('\n').slice(-4).join(' / ')
      check('ps1 结构断言全部通过（AST，不是字符串包含）', false, tail.slice(0, 160))
    }
  }
}

// ── 8b. add-bundle 必须是 .cjs，而且必须真能跑（P0-1，2026-10-22 外部验证）──
//
// ★ 这条治的病，今天真实发生过：
//   `package.json` 里有 `"type": "module"`，所以 `tools/add-bundle.js` 会被
//   Node 当成 ESM —— 而它的第一行是 `require("fs")`，于是：
//       ReferenceError: require is not defined in ES module scope
//   install-desktop.ps1 的第 5 步拿这个脚本去登记 bundles，它必然失败，
//   脚本于是回滚 package.json 并 Die —— **文件拷过去了，插件不加载**。
//
// ★ 为什么以前没发现：我改这个文件之后跑的是 `node --check`。
//   那只检查语法，**不看模块系统**，所以它给了绿灯。假绿。
//
// ★ 所以这条断言**真的跑一遍**，跑在一个临时 package.json 上，看结果文件变了没有。
{
  const cjs = path.join('tools', 'add-bundle.cjs')
  const js = path.join('tools', 'add-bundle.js')
  check('add-bundle 用的是 .cjs 后缀', fs.existsSync(cjs))
  check('旧的 add-bundle.js 已不存在（type=module 下会被当 ESM）', !fs.existsSync(js))

  const pkgType = JSON.parse(fs.readFileSync('package.json', 'utf8').replace(/^\uFEFF/, '')).type
  check('package.json 的 type 是 module（这条断言的前提）', pkgType === 'module', 'type=' + pkgType)

  if (fs.existsSync(cjs)) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-probe-'))
    const probe = path.join(tmp, 'package.json')
    fs.writeFileSync(probe, JSON.stringify({ name: 'probe', dsh: { profile: { bundles: ['a'] } } }), 'utf8')
    let ran = false
    let out = ''
    try {
      out = execFileSync(process.execPath, [cjs, probe, 'b'], { encoding: 'utf8', timeout: 30000 })
      ran = true
    } catch (e) {
      out = String((e && (e.stderr || e.message)) || e).slice(0, 160)
    }
    let landed = false
    try {
      const after = JSON.parse(fs.readFileSync(probe, 'utf8').replace(/^\uFEFF/, ''))
      landed = (after.dsh.profile.bundles || []).includes('b')
    } catch { /* 读不回来就是没成 */ }
    fs.rmSync(tmp, { recursive: true, force: true })
    check('add-bundle 真能跑（不是只在 node --check 下通过）', ran && landed, out || '没写进去')
  }
}


// ── 8c. 版本范围里的预发布标识符必须带点（P0-4，2026-10-22 外部验证）──
//
// ★ 这条治的病：huanqi 写着 `>=0.2.1-rc2 <0.3.0`，而 DSH 是 0.2.1-rc.2。
//   semver 里 `rc2` 和 `rc.2` 是**两个不同的预发布标识符**：
//   `rc.2` 拆成 ["rc","2"]，`rc2` 是单个 ["rc2"]，逐段比时 "rc2" > "rc"（前缀更长的更大）。
//   所以 satisfies("0.2.1-rc.2", ">=0.2.1-rc2 <0.3.0") === false —— 换气因此装不上。
// ★ 用真 semver 库验，不靠肉眼：
{
  let semverLib = null
  const candidates = [
    'semver',
    'D:/AI/dsh/home/profiles/desktop/node_modules/semver',
  ]
  for (const c of candidates) {
    try { semverLib = require(c); break } catch { /* 换下一个 */ }
  }

  for (const e of fs.readdirSync('plugins', { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const pj = path.join('plugins', e.name, 'package.json')
    if (!fs.existsSync(pj)) continue
    const sub = JSON.parse(fs.readFileSync(pj, 'utf8').replace(/^﻿/, ''))
    const peers = sub.peerDependencies || {}
    for (const [dep, range] of Object.entries(peers)) {
      // 找 -rcN 形式（rc 后面直接跟数字，没有点）
      const bad = range.match(/-rcd/)
      check(`子包 peer 范围没用 -rcN 写法: ${e.name} → ${dep}`, !bad, bad ? '发现 ' + bad[0] : '')
      if (semverLib && bad) {
        // 真验一遍：当前 DSH 版本落不落得进去
        const cur = '0.2.1-rc.2'
        const ok = semverLib.satisfies(cur, range)
        check(`  └ ${e.name} 的 ${dep} 能接受 ${cur}`, ok, range)
      }
    }
  }
}


// ── 8d. doctor 的 SELF 判据不能用「工具描述里也会出现」的词（P1-7，2026-10-22）──
//
// ★ 这条治的病：判据原来是 `raw.includes("SELF.md")`，而
//   `agent_soul_scaffold` 的工具描述里就写着 SELF 模板 / SELF.md ——
//   也就是说**只要插件装上了**，日志里必然出现这个字符串，判据恒真。
//   一个永远通过的自检比没有更坏：它会明确告诉你「装好了」。
// ★ 修法是改认 SELF.md **正文里才有的**词（「四条硬线」「## 我是谁」），
//   工具描述不会写这些。这条断言就守在这个边界上。
{
  const doctor = fs.readFileSync('kit/echo/echo-doctor.mjs', 'utf8')
  check(
    'doctor 的 SELF 判据不认裸 SELF.md（工具描述里也有这个串）',
    !doctor.includes('raw.includes("SELF.md")'),
  )
  check(
    'doctor 的 SELF 判据认 SELF.md 正文独有词',
    doctor.includes('四条硬线') || doctor.includes('## 我是谁'),
  )
}


// ── 8e. 占位符判定：HTML 注释不能混进来（R1 回归，2026-10-22）──
//
// ★ 这条治的病，是我自己造成的：为了让 30 多字的长占位符能被认出来，
//   把正则从 {2,12} 放宽到 {2,80}，结果模板里三处「填法」注释
//   （<!-- 填法：…… -->，有 < 有 >、中间没换行）被当成三个永远填不完的占位符，
//   `plan` 卡在第 3 步，第 4 到 6 步不可达。
//   **修一个「漏数」的 bug，换来一个「永远过不去」的 bug —— 后者更坏。**
// ★ 现在判定收拢在 kit/echo/placeholder.mjs 一处，plan 和 self 都从那儿拿。
//   这三条断言守的就是那个模块的行为。
{
  const tpl = fs.readFileSync('kit/templates/SELF.src.md', 'utf8')
  const ins = await inspectPlaceholders(tpl)
  check('占位符里不含 HTML 注释（R1 回归）', ins.fromComments.length === 0)
  check('能认出 30+ 字的长占位符', ins.placeholders.some((x) => x.length > 20))
  check('模板占位符恰为 3 个', ins.placeholders.length === 3)
  // ★ 两处必须共用同一判定 —— 各写一套就是这次回归的来源
  const planSrc = fs.readFileSync('kit/echo/plan.mjs', 'utf8')
  const selfSrc = fs.readFileSync('kit/echo/self.mjs', 'utf8')
  check('plan.mjs 用共享判定', planSrc.includes('findPlaceholders('))
  check('self.mjs 用共享判定', selfSrc.includes('findPlaceholders('))
  check('两处都不再自己写正则',
    !planSrc.includes('match(/<[^<>') && !selfSrc.includes('match(/<['))
}

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
