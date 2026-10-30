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
import { readFileSync, existsSync } from 'node:fs'

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
