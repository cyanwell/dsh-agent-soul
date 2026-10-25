#!/usr/bin/env node
/** INSTALL.md 补 crash 日志路径 + README 更新记录（纯片段替换）。 */
import fs from 'node:fs'

const REPO = 'D:\\AI\\dsh-tools\\dsh-agent-soul'
const out = []

function patch(file, label, pairs) {
  const raw = fs.readFileSync(file, 'utf8')
  let s = raw
  const hit = []
  for (const [from, to] of pairs) {
    if (!s.includes(from)) { hit.push('MISS:' + from.slice(0, 24)); continue }
    s = s.split(from).join(to)
    hit.push('ok')
  }
  if (s === raw) { out.push(['NOCHG', label, hit.join(' ')]); return }
  fs.writeFileSync(file, s, 'utf8')
  out.push(['OK', label, raw.length + '→' + s.length + '  ' + hit.join(' ')])
}

// ── INSTALL.md：crash 日志路径 ──────────────────────────────────────────
const INSTALL_ANCHOR = 'crash 日志里 `intercom` 的 `failed to import` 排在很次要的位置'
const INSTALL_INSERT = [
  '> **crash 日志在哪儿**：`%APPDATA%\\@deepseek-ai\\dsh-desktop\\logs\\crash-*.log`',
  '> （本机实测路径；**不在** Cache、**不在** Storage —— 是从 asar 里 `writeCrashReport(app.getPath("logs"))` 反推的。）',
  '> 崩了先看这里，**别反复重启**：每重启一次，可能又掉一批插件，而看起来一切正常。',
  '',
  INSTALL_ANCHOR,
].join('\n')

patch(REPO + '\\INSTALL.md', 'INSTALL 补 crash 路径', [[INSTALL_ANCHOR, INSTALL_INSERT]])

// ── README：更新记录 ────────────────────────────────────────────────────
const TITLE = '### 2026-10-25 · 八条用户反馈：两条已修过、四条修掉了、一条不成立'
const BODY = [
  TITLE,
  '',
  '来自两封邮件（白毛狼狼 10-25、此胡桃非比胡桃是也 10-24），逐条核实后：',
  '',
  '**已经修过的**（只回信说明，没再动）',
  '',
  '- `memindex.mjs` / `memq.mjs` 的 `Buffer.concat` 巨串 —— 10-23 已改成逐帧 + carry。',
  '  反馈里「原话数 382 → 439」少的 57 条，正是旧实现在小日志上**静默吞掉**的',
  '- `self.mjs` 不写 `state.json` —— 现在写了（`lastSelfAt` / `updatedAt`）',
  '',
  '**修掉的**',
  '',
  '- `tools/soul-one-shot.mjs`：包名匹配同时接受 `dsh-<x>` 与 `dsh-agent-<x>`。',
  '  原来用写死的 `part.pkg` 精确匹配，而 PARTS 表里两种写法混着 —— 于是「装了、只是名字写法不同」被判没装',
  '- `echo-doctor.mjs`（kit + hub 两份）：换气账本按优先级找多处。',
  '  `dsh-huanqi` 的 `defaultPath()` 在 `DSH_HOME` 为空时落在**宿主 cwd**，不在 `<DSH_HOME>/state/`；只认一处就会误报「没装」',
  '- `echo-doctor.mjs`（两份）：心跳那项说清**本仓库不提供**这个零件，别让人去找一个不存在的东西',
  '- `plugins/echo/client.js` 首行注释：旧注册名改成 `dsh-agent-echo`，并把「历史名已弃用」写上去',
  '- `INSTALL.md`：补 crash 日志真实路径（`%APPDATA%\\@deepseek-ai\\dsh-desktop\\logs\\crash-*.log`）',
  '',
  '**不成立的**',
  '',
  '- `compaction` 的 `files` 漏 `lib`：那个 `lib/` 目录现在已经不存在（内容并进 `index.js`），所以不再适用。',
  '  但反馈建议的「打包期校验 `files` 必须覆盖入口的相对 import」是对的，已列入待做',
  '',
  '★ 反馈里有一句总结值得记住：**「白名单类配置，漏一项就是静默失效，而且症状长得像另一个病。」**',
  '  这条已经踩过三次（`peerDependencies` / client id / `files`）—— 第四次该由自动检查挡住，不是再由人踩。',
  '',
  '',
].join('\n')

patch(REPO + '\\README.md', 'README 更新记录', [
  ['## 更新记录\n\n只保留最近三条。', '## 更新记录\n\n只保留最近三条。\n\n' + BODY + '\n<!--SPLIT-->'],
])

for (const [st, label, msg] of out) console.log('  ' + st.padEnd(6) + label + '  ' + msg)
