// patch-aurabot —— 把 v4 接管的两处闸打进 dsh-aurabot-qq（**可重复执行**）
// ============================================================================
// 为什么需要它：那两处闸改在 node_modules/dsh-aurabot-qq/src/chat/hub.js 里，
//   **pnpm install / 插件重装会覆盖它** —— 双发会悄悄回来，而那时你不会想到是重装。
//
// ★ 幂等：已经打过就跳过，不重复插入。
// ★ 只认标记注释，不认行号 —— 行号会漂，标记不会。
// ★ 打之前备份，打失败自动还原。
//
// 用法：
//   node tools/patch-aurabot.mjs          # 打补丁
//   node tools/patch-aurabot.mjs --check  # 只检查，不动文件
// ============================================================================
import fs from 'node:fs'
import path from 'node:path'

// ★ 目标可注入（--target <path>）：自检要在一份**副本**上验打补丁的行为，
//   不能拿真的 hub.js 去试（那是正在跑的插件的代码）。
const DEFAULT_TARGETS = [
  'D:/AI/dsh/home/profiles/desktop/node_modules/dsh-aurabot-qq/src/chat/hub.js',
  'D:/AI/dsh/node_modules/dsh-aurabot-qq/src/chat/hub.js',
]
function targetsFromArgv (argv) {
  const i = argv.indexOf('--target')
  if (i >= 0 && argv[i + 1]) return [argv[i + 1]]
  return DEFAULT_TARGETS
}
const TARGETS = targetsFromArgv(process.argv.slice(2))

const MARK_RECV = '// [v4-gate-recv]'
const MARK_SEND = '// [v4-gate-send]'

const GATE_RECV = [
    MARK_RECV + ' —— v4 接管时这条入口整条关掉（收/判/投三段都不做）。',
    '    // 为什么：v4 和本插件都连着同一个 OneBot WS（3003，Universal 广播），',
    '    // 同一条 QQ 消息两边都收到；两边各自判、各自投 —— 一条 @ 会被叫醒两次。',
    '    // 关掉的是「收→判→投」，**不是发**：会话跑完后 onSessionEvent 仍然 deliver()。',
    '    if (soulOn()) {',
    "      log.debug(chat.chatId + '：v4 接管中 —— 插件不再处理进来的消息（只保留把回复发出去）')",
    '      if (!opts.steer) release(chat.chatId)',
    '      return',
    '    }',
].join('\n')

const GATE_SEND = [
    MARK_SEND + ' —— v4 接管时回复也不由这里发（v4 自己读日志发）。',
    '    // 上面那条闸关了收/判/投，但这条发送路径还留着的话 —— 同一条回复会发两遍。',
    '    if (soulOn()) {',
    "      log.debug(chatId + '：v4 接管中 —— 回复由 v4 自己发，这里不发')",
    '      release(chatId)',
    '      return',
    '    }',
].join('\n')

const check = process.argv.includes('--check')
let touched = 0, skipped = 0, failed = 0

for (const target of TARGETS) {
  if (!fs.existsSync(target)) { console.log('  ⏭  不存在: ' + target); skipped++; continue }
  let src = fs.readFileSync(target, 'utf8')
  const before = src
  const hasRecv = src.includes(MARK_RECV)
  const hasSend = src.includes(MARK_SEND)
  console.log('  📄 ' + target.replace('/node_modules/', '/…/'))
  console.log('     收/判/投闸: ' + (hasRecv ? '已打' : '未打') + '   发回复闸: ' + (hasSend ? '已打' : '未打'))

  if (hasRecv && hasSend) { skipped++; continue }
  if (check) { touched++; continue }

  // ① 收/判/投闸：插在 pushToSession 开头
  if (!hasRecv) {
    const anchor = '  async function pushToSession(chat, content, senderId, opts = {}) {'
    if (!src.includes(anchor)) { console.log('     ✗ 找不到 pushToSession 锚点'); failed++; continue }
    src = src.replace(anchor, anchor + '\n' + GATE_RECV)
  }
  // ② 发回复闸：插在 turn/end 里 text 判空之后
  if (!hasSend) {
    const anchor2 = "      if (!text) return release(chatId)"
    if (!src.includes(anchor2)) { console.log('     ✗ 找不到 turn/end 锚点'); failed++; continue }
    src = src.replace(anchor2, anchor2 + '\n' + GATE_SEND)
  }

  // 备份 + 落盘
  const bak = target + '.before-v4gate'
  // ★ 只在没备份过时写 —— 重复执行不会把"已经打过补丁的版本"当原始备份。
  if (!fs.existsSync(bak)) fs.writeFileSync(bak, before, 'utf8')
  fs.writeFileSync(target, src, 'utf8')
  console.log('     ✓ 已写入（备份 ' + path.basename(bak) + '）')
  touched++
}

console.log('')
console.log((check ? '[检查] ' : '') + '打了 ' + touched + ' 个 · 跳过 ' + skipped + ' 个 · 失败 ' + failed + ' 个')
if (check && touched > 0) console.log('（有文件没打补丁。去掉 --check 再跑一次会打上）')
process.exit(failed === 0 ? 0 : 1)
