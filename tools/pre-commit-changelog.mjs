#!/usr/bin/env node
/**
 * pre-commit-changelog.mjs —— 提交前的「公告闸门」
 *
 * 为什么有这个东西
 * ----------------
 * 发布纪律里有这么一条：**代码、更新公告、文档口径三样必须在同一个推送里。**
 * 2026-10-22 我连着三个 commit 只推了代码、README 的更新记录一行没动；
 * 2026-10-26 又漏了一次（3513e61 修完 bug，公告拖到 8dde935 才补）。
 *
 * 两次漏的是**同一个动作**：提交前没想着去看更新记录。
 * 记在 AGENTS.md 里没用 —— 条文我记得，动作没执行。
 * 所以把它变成一道会**拒绝提交**的闸，而不是一句需要我自觉的话。
 *
 * 判据（只有一条）
 * ----------------
 * **本次暂存里动了「会被加载的实现文件」，而且 README 的「更新记录」段没有变长 → 拒绝。**
 *
 * 「会被加载的实现文件」具体指：
 *   - `plugins/**` 下的 `.js` / `.ts`（源码和构建产物都算 —— 后者才是真被加载的）
 *   - 根目录入口：`index.js` / `client.js` / `kit-bridge.mjs` / `probe-kit-tools.mjs`
 *   - `soul/**` 下的 `.json`（清单与参考实现清单是内容，不只是文档）
 *
 * 放行（任一成立）
 * ----------------
 * 1. 没动实现（只动文档 / 工具 / 测试 / 杂项）
 * 2. README 的「更新记录」段**字符数净增**（= 真的往里写了东西）
 * 3. 提交信息里带 `[no-changelog]` —— 显式的、可见的绕过，理由写在信息里
 * 4. `git commit --no-verify` —— git 自己的逃生门，不归这个脚本管
 *
 * ★ 为什么用「字符数净增」而不是「有没有 + 行」：
 *   更新记录是**只追加**的，所以它只该变长。净增是最贴近这个性质的判据，
 *   而且不需要把 diff 行号映射回段内（那一步容易写错，写错就会误放或误拦）。
 *   真要做等长的措辞修正时，用 `[no-changelog]` —— 这反而让人多想一次。
 *
 * 退出码：0 = 放行；1 = 拒绝
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ANCHOR = '## 更新记录'

/**
 * ★★ 找 git —— 这一步是**必须的**，不能省。
 *
 * 2026-10-26 自测时抓到的自身 bug：脚本原来直接 `execFileSync('git', ...)`，
 * 依赖 PATH。而这台机器 **git 不在 PATH 里**（用绝对路径调用）。
 * 于是 hook 跑起来时所有 git 调用都失败 → 返回空串 → 判定成「暂存区为空」→ **静默放行**。
 * 也就是说：闸门装上了，但它天天闭着眼睛。
 *
 * ★ 判据：**一个检查工具，它「读不到输入」和「输入是空的」必须是两件事。**
 *   混在一起，失效就变成沉默。
 *
 * 查找顺序：env → installer 注入的路径 → PATH → 几个已知位置。
 */
function findGit() {
  const tried = []
  const candidates = [
    process.env.CHANGELOG_GATE_GIT,   // installer 注入（最可靠）
    process.env.GIT_BIN,
    'git',                             // PATH
    // ★ 下面两条是**本机兜底**，不是硬性依赖 —— 前面已经试过 GIT_BIN 和 PATH 里的 git。
    //   为什么留：这台机器的 git 不在 PATH 里（2026-10-26 实测），不注进去闸门会静默放行。
    //   别人机器上这两条路径不存在 → 试下一个 → 不影响。
    'C:/Users/pc/AppData/Local/Programs/Git/cmd/git.exe',
    'D:/AI/dsh-tools/mingit/cmd/git.exe',
  ].filter(Boolean)

  for (const c of candidates) {
    try {
      execFileSync(c, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      return { bin: c, tried }
    } catch {
      tried.push(c)
    }
  }
  return { bin: null, tried }
}

const GIT = findGit()

/** 跑 git，返回 stdout（失败返回 null —— 注意是 null 不是空串）。 */
function git(args) {
  if (GIT.bin === null) return null
  try {
    return execFileSync(GIT.bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

if (GIT.bin === null) {
  console.error('')
  console.error('  ⚠ [changelog-gate] 找不到 git，闸门无法工作 —— **放行**。')
  console.error('    试过这些位置：')
  for (const t of GIT.tried) console.error('      ' + t)
  console.error('')
  console.error('    解法：重跑 node tools/install-hooks.mjs（它会把 git 绝对路径注进 hook），')
  console.error('          或设环境变量 CHANGELOG_GATE_GIT=<git 绝对路径>。')
  console.error('')
  console.error('    ★ 这次是放行，不是通过 —— 别把「没报错」当成「检查过了」。')
  console.error('')
  process.exit(0)
}

/** 取某版本的 README 文本（'' = 暂存区；'HEAD' = 上次提交）。拿不到返回 null。 */
function readReadme(rev) {
  const spec = rev === '' ? ':README.md' : 'HEAD:README.md'
  return git(['show', spec])
}

/** 从 README 全文里切出「更新记录」段（到文件末尾）。 */
function changelogSection(text) {
  if (text === '') return null
  const i = text.indexOf(ANCHOR)
  if (i < 0) return null
  return text.slice(i)
}

// ── 1. 暂存了哪些文件 ────────────────────────────────────────────────
const stagedRaw = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'])

// ★ 读不到 ≠ 空。读不到时必须说出来，不能静默放行（那就是闸门闭着眼睛）。
if (stagedRaw === null) {
  console.error('')
  console.error('  ⚠ [changelog-gate] 读不到暂存区（git diff 失败）—— **放行**。')
  console.error('    这次没检查，不是检查过了。')
  console.error('')
  process.exit(0)
}

const staged = stagedRaw.split('\n').map((l) => l.trim()).filter(Boolean)

if (staged.length === 0) {
  console.log('  [changelog-gate] 暂存区确实为空 —— 放行')
  process.exit(0)
}

/** 判断某个路径是否属于「会被加载的实现文件」。 */
function isImplementation(p) {
  if (p.startsWith('plugins/')) {
    return /\.(js|ts|mjs|cjs)$/.test(p)
  }
  if (p === 'index.js' || p === 'client.js' || p === 'kit-bridge.mjs' || p === 'probe-kit-tools.mjs') {
    return true
  }
  if (p.startsWith('soul/')) {
    return /\.json$/.test(p)
  }
  return false
}

const impl = staged.filter(isImplementation)

/* ── 1.5 语法闸（2026-11-01 加）────────────────────────────────────
 *
 * 为什么要这一道
 * --------------
 * 2026-11-01 我在 486be3d 里给回声面板加「记忆常驻」「内存水位」两栏，
 * 把旧的「预算」段 12 行残留下来 —— 括号不匹配 → client.js 第 930 行
 * `Unexpected token ')'` → 整个前端文件解析失败，
 * DSH 打开窗口报 `Web boot: 1 entry did not activate dsh-agent-echo: import failed`，
 * 重试几次后进 `phase: recovery`。
 *
 * 而这道闸当时是**放行**的 —— 它只比 README 的更新记录有没有变长，
 * 一个字都不看代码对不对。**「公告写了」和「代码能跑」是两件事**，闸门以前只管前者。
 *
 * 判据：**暂存的实现文件里，任何一个语法不过 → 拒绝提交。**
 *
 * ★ 为什么检查 index 的内容，而不是磁盘上的文件
 * ---------------------------------------------
 * 要提交的是**暂存内容**。磁盘上改好了、暂存里还是坏的，提交出去的仍然是坏的。
 * 所以取 `git show :<path>` 的字节，绝不 `readFileSync(磁盘路径)`。
 *
 * ★ 为什么用 `process.execPath` 而不是 'node'
 * -------------------------------------------
 * 和上面 findGit 同一个坑：这台机器的 node **不在 PATH 里**。
 * 依赖 PATH 的检查会静默失效 —— 而一个「读不到就放行」的闸，比没有更坏。
 *
 * ★ .ts 不在检查范围：`node --check` 不认 TypeScript，会误报。
 *   本仓库的 .ts 目前只有类型声明，没有需要挂到浏览器里的那份。
 */
function syntaxCheckStaged(paths) {
  const bad = []
  const skipped = []
  // 临时目录：每文件一个，保留扩展名（--check 要靠扩展名判断 ESM / CJS）
  const tmpRoot = join(tmpdir(), 'dsh-gate-' + process.pid + '-' + Date.now())
  mkdirSync(tmpRoot, { recursive: true })

  for (const p of paths) {
    const isJson = p.endsWith('.json')
    const isTs = p.endsWith('.ts')
    if (isTs) { skipped.push({ p, why: 'TypeScript，node --check 不认' }); continue }

    const bytes = git(['show', ':' + p])
    if (bytes === null) {
      // 读不到暂存内容 —— 说出来，不当成通过
      bad.push({ p, why: '读不到暂存内容（git show 失败）' })
      continue
    }

    if (isJson) {
      try {
        JSON.parse(bytes)
      } catch (e) {
        bad.push({ p, why: 'JSON 解析失败：' + (e && e.message) })
      }
      continue
    }

    const ext = p.slice(p.lastIndexOf('.')) || '.js'
    const tmp = join(tmpRoot, p.replace(/[\\/]/g, '_') + ext)
    try {
      writeFileSync(tmp, bytes, 'utf8')
    } catch (e) {
      bad.push({ p, why: '写临时文件失败：' + (e && e.message) })
      continue
    }
    try {
      execFileSync(process.execPath, ['--check', tmp], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      // 把 node 的报错原文抠出来 —— 它带行号和那一行源码
      const detail = String((e && (e.stderr || e.message)) || '').trim()
      const lines = detail.split('\n').filter((l) => l.trim())
      const head = lines.slice(0, 4).join('\n        ')
      bad.push({ p, why: head || '语法检查未通过' })
    }
  }

  try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* 临时目录清不掉不影响结论 */ }
  return { bad, skipped }
}

if (impl.length > 0) {
  const { bad, skipped } = syntaxCheckStaged(impl)
  if (bad.length > 0) {
    console.error('')
    console.error('  ✗ [syntax-gate] 暂存的实现文件里有语法错误 —— **拒绝提交**。')
    console.error('')
    for (const b of bad) {
      console.error('    ' + b.p)
      console.error('        ' + b.why)
      console.error('')
    }
    console.error('    这些文件会被 DSH 在打开窗口时加载。语法错一个字节，')
    console.error('    整个插件就 import 失败，宿主进 recovery 模式 —— 2026-11-01 刚踩过。')
    console.error('')
    console.error('    修法：改到 `node --check <文件>` 返回 0 为止。')
    console.error('    ★ 注意检查的是**暂存内容**，不是磁盘 —— 磁盘改好了还要 git add。')
    console.error('')
    process.exit(1)
  }
  if (skipped.length > 0) {
    for (const s of skipped) console.log('  [syntax-gate] 跳过 ' + s.p + '（' + s.why + '）')
  }
  console.log('  [syntax-gate] ' + impl.length + ' 个实现文件语法检查通过')
}

/* ── 1.6 client.js 注册 id 闸（2026-11-01 加）────────────────────────
 *
 * 症状：桌面端弹「应用无法启动」，控制台报
 *   web boot: 1 entry did not activate / dsh-yanqing-echo: import failed
 * 还在 renderer console 里看到 `duplicate factory registration for "dsh-agent-echo"`。
 *
 * 根因：`client.js` 里 `__ModuleLoader__.load({ id })` 必须是**部署包的名字**。
 *   client-modules 拿 profile `dsh.profile.bundles` 的条目名当 key 去找注册表，
 *   找不到 → 整批 web boot 不激活 → 宿主进 recovery，全界面进不去。
 *
 * ★ 为什么 node --check 拦不住：这是**配对**问题，不是语法问题。
 *   两份文件各自都合法，只有「id 对不上那个名字」时才炸 —— 而那一炸是全界面进不去。
 *
 * ★ 2026-11-01 怎么踩的：`dsh-agent-soul/plugins/echo/`（发布版，名字 dsh-agent-echo）
 *   和 `dsh-tools/dsh-yanqing-echo/`（本机部署包，名字 dsh-yanqing-echo）是**两个不同的包**，
 *   我把前者 cp 进后者的 node_modules —— 一个 cp 就把整个界面弄崩了。
 *   `tools/verify-client-ids.mjs` 10-26 就写好了，只是**从来没在提交前跑过**。
 *   所以这里不是重新发明检查，是把它接上一个没人能忘记的时机。
 *
 * ★ 它拦不住「手工 cp 到部署目录」——那一步没有 commit，gate 看不见。
 *   真正对症的是部署脚本，或者：**cp 完立刻跑一次 verify-client-ids**。
 *
 * 只在暂存了 client.js 时才跑（它扫整个 profiles 目录，一秒左右）。
 */
if (impl.some((p) => p.endsWith('client.js'))) {
  // pre-commit 时 cwd 就是仓库根，直接拼，不依赖 ESM 里没有的 __dirname
  const verifier = join(process.cwd(), 'tools', 'verify-client-ids.mjs')
  if (existsSync(verifier)) {
    let out = ''
    let ok = true
    try {
      out = execFileSync(process.execPath, [verifier], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      ok = false
      out = String((e && (e.stdout || e.stderr || e.message)) || '')
    }
    if (!ok) {
      const tail = out.split('\n').filter((l) => l.trim()).slice(-12).join('\n        ')
      console.error('')
      console.error('  ✗ [id-gate] client.js 的注册 id 与包名对不上 —— **拒绝提交**。')
      console.error('')
      console.error('        ' + tail)
      console.error('')
      console.error('    判据（顺序不能变）：')
      console.error('      bundles 条目名 → dependencies 键 → package.json.name → client.js 的 id')
      console.error('      最后一项必须等于第一项。')
      console.error('')
      console.error('    ★ 只拷 client.js 到另一个包目录，就会把 id 一起带错 ——')
      console.error('      2026-11-01 正是这么把整个界面弄崩的。')
      console.error('')
      process.exit(1)
    }
    console.log('  [id-gate] client.js 注册 id 全部对上包名')
  }
}

// ── 2. 没动实现 → 放行 ───────────────────────────────────────────────
if (impl.length === 0) {
  console.log('  [changelog-gate] 没动实现文件（只有文档 / 工具 / 配置）—— 放行')
  process.exit(0)
}

// ── 3. 提交信息里的显式绕过 ──────────────────────────────────────────
//   git 在跑 pre-commit 时把 commit message 写在 COMMIT_EDITMSG 里；
//   -m 提交时那份文件已经是最终信息（实测 git 2.4x 行为）。
let msg = ''
try {
  msg = readFileSync('.git/COMMIT_EDITMSG', 'utf8')
} catch {
  msg = ''
}
if (msg.includes('[no-changelog]')) {
  console.log('  [changelog-gate] 提交信息含 [no-changelog] —— 放行（已显式声明不写公告）')
  process.exit(0)
}

// ── 4. 比「更新记录」段有没有变长 ────────────────────────────────────
const headSection = changelogSection(readReadme('HEAD'))
const stagedSection = changelogSection(readReadme(''))

if (stagedSection === null) {
  // README 里连锚点都没有了 —— 那不是「没写」，那是结构被弄坏了
  console.error('')
  console.error('  ✗ [changelog-gate] README.md 里找不到「' + ANCHOR + '」这个标题。')
  console.error('    更新记录是只追加的，这个标题不该消失。')
  console.error('')
  process.exit(1)
}

const headLen = headSection === null ? 0 : headSection.length
const stagedLen = stagedSection.length

if (stagedLen > headLen) {
  console.log('  [changelog-gate] 动了实现，更新记录也变长了（+' + (stagedLen - headLen) + ' 字符）—— 放行')
  process.exit(0)
}

// ── 5. 拒绝，并把话说到能照着做的程度 ───────────────────────────────
console.error('')
console.error('  ✗ [changelog-gate] 这次动了实现，但 README 的「更新记录」没变长。')
console.error('')
console.error('    动了这些实现文件：')
for (const p of impl.slice(0, 12)) console.error('      ' + p)
if (impl.length > 12) console.error('      … 还有 ' + (impl.length - 12) + ' 个')
console.error('')
console.error('    发布纪律：代码、更新公告、文档口径三样必须在同一个推送里。')
console.error('    更新记录是「只追加」的 —— 漏了就补不回来，所以不能下次再说。')
console.error('')
console.error('    三条出路（选一条）：')
console.error('      ① 在 README 的「## ' + ANCHOR.replace('## ', '') + '」下面加一条：')
console.error('         写清「为什么改、改了什么、怎么验的」，不要只写「修复若干问题」')
console.error('      ② 这次确实不需要公告 → 在提交信息里写 [no-changelog]，并说明理由')
console.error('      ③ 确认是误报 → git commit --no-verify（慎用：这就是在绕开纪律）')
console.error('')
console.error('    ★ 这次闸门是 2026-10-26 因为连漏两次才装的，别让它变成天天绕的东西。')
console.error('')
process.exit(1)
