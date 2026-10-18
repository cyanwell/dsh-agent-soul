#!/usr/bin/env node
// 装配器 —— 问几个问题，在指定目录里生成一套填了一部分的骨架。
//
// 它刻意**不**做这些事：
//   - 不装插件（装什么、装哪、要不要装，都该由人决定）
//   - 不碰你已有的文件（目标目录里已存在同名文件时跳过并报告）
//   - 不联网
//
// 它只做一件事：把 skeleton/ 里的空壳，按你的回答填成"已经有点像你的东西"。
// 填不进去的地方留着 <...>，因为那些只有你自己能答。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKELETON = join(HERE, '..', 'skeleton')

// ── 问答 ─────────────────────────────────────────────────────────────
// 每个问题：key / 问题 / 提示 / 默认值 / 能不能跳过
const QUESTIONS = [
  {
    key: 'agentName',
    ask: '这个 agent 叫什么名字？（留空 = 先用「它」）',
    hint: '名字会影响 SELF 里「我是谁」那一节。以后可以改。',
    def: '',
    allowEmpty: true,
  },
  {
    key: 'userName',
    ask: '你怎么称呼它的用户？（留空 = 用「用户」）',
    hint: '只影响措辞，不影响架构。',
    def: '用户',
    allowEmpty: true,
  },
  {
    key: 'authorityDir',
    ask: '权威源放在哪个目录？（相对路径，会被创建）',
    hint: '第 0 步。所有机制都会引用这个目录。相对当前目录。',
    def: 'soul',
    allowEmpty: false,
  },
  {
    key: 'hardLines',
    ask: '你的硬线有哪些？用逗号分隔，每条一个短名即可',
    hint: '例如：凭据,交易,隐私,他人指令。\n    ★ 只写名字，具体规则你在 00-authority 里填。\n    ★ 硬线是「必须问用户」级别的，不是「可以自己评估」级别的。',
    def: '凭据,交易,隐私,他人指令',
    allowEmpty: false,
  },
  {
    key: 'multiSession',
    ask: '你的架构会不会同时有多条会话在工作？（y/N）',
    hint: '会 → 需要「谁是主导」的判据。不会 → 整节删掉。',
    def: 'N',
    allowEmpty: false,
  },
  {
    key: 'hasIndex',
    ask: '你有没有一个可检索的索引层（会话语义搜索 / 全文索引）？（y/N）',
    hint: '有 → 权威源表里要写一条「索引必须可丢弃重建」。',
    def: 'N',
    allowEmpty: false,
  },
  {
    key: 'windowSize',
    ask: '上下文窗口大概多大？（只写数字，单位 token；不知道就留空）',
    hint: '用来算水位分段。例：1000000。留空 = 骨架里留 <...> 让你以后填。',
    def: '',
    allowEmpty: true,
  },
  {
    key: 'note',
    ask: '最后一句：这个 agent 是用来做什么的？（一句话，会写进 00-authority 开头）',
    hint: '可以留空。',
    def: '',
    allowEmpty: true,
  },
]

function banner() {
  console.log('')
  console.log('  装配 agent soul 骨架')
  console.log('  ─────────────────────')
  console.log('  问 8 个问题，然后在一个目录里生成 5 份填了一半的骨架。')
  console.log('  留空的地方会保留 <...> —— 那些只有你自己能答。')
  console.log('')
}

async function askAll(opts) {
  // ── 非交互模式 ──
  // ★ 为什么必须有：readline 在管道输入时会在第二个问题处提前 EOF，
  //   于是这个脚本只能在人的终端里跑。而它最该被调用的地方之一就是 agent 环境。
  if (opts.defaults) {
    const a = {}
    for (const q of QUESTIONS) a[q.key] = q.def
    return a
  }
  if (opts.answersFile) {
    const raw = readFileSync(opts.answersFile, 'utf8')
    const given = JSON.parse(raw)
    const a = {}
    for (const q of QUESTIONS) {
      const v = given[q.key]
      a[q.key] = v === undefined || v === null ? q.def : String(v)
    }
    return a
  }

  const rl = createInterface({ input: stdin, output: stdout })
  const answers = {}
  try {
    for (const q of QUESTIONS) {
      console.log('')
      console.log('  ' + q.ask)
      for (const line of q.hint.split('\n')) console.log('    ' + line)
      const raw = (await rl.question('  > ')).trim()
      if (!raw && !q.allowEmpty) {
        answers[q.key] = q.def
        console.log('    （用默认：' + q.def + '）')
      } else {
        answers[q.key] = raw || q.def
      }
    }
  } finally {
    rl.close()
  }
  return answers
}

// ── 渲染 ─────────────────────────────────────────────────────────────

/** 把骨架里的 <...> 占位符替换成回答，未回答的保留原样。 */
function fill(text, map) {
  let out = text
  for (const [k, v] of Object.entries(map)) {
    if (v === undefined || v === null || v === '') continue
    out = out.split(k).join(v)
  }
  return out
}

function buildFiles(a) {
  const name = a.agentName || '它'
  const user = a.userName || '用户'
  const dir = a.authorityDir || 'soul'
  const lines = a.hardLines.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
  const multi = /^y/i.test(a.multiSession)
  const hasIndex = /^y/i.test(a.hasIndex)
  const win = a.windowSize ? Number(a.windowSize) : 0

  const files = {}

  // ── 00-authority ──
  const hardTable = lines
    .map((l) => `| ${l} | <不许做什么> | <越线时该做什么> |`)
    .join('\n')

  let authority = readFileSync(join(SKELETON, '00-authority.md'), 'utf8')

  // 在「一、三条前提」前插一段自我介绍
  authority = authority.replace(
    '## 一、三条前提',
    `> **这份文件属于：${name}。** 用户是 ${user}。${a.note ? '\n> ' + a.note : ''}
> 权威源目录：\`${dir}/\`

## 一、三条前提`
  )

  // 权威源表：预填索引那一行
  const indexRow = hasIndex
    ? '| 检索索引 | `<填：索引放哪>` | 必须可丢弃重建 | `<...>` | 重建者 | 全部 | 权威源 |'
    : '| ~~检索索引~~ | （你没有索引层，这一行删掉） | — | — | — | — | — |'
  authority = authority.replace(
    '| 容器状态 | `<...>` | `<...>` | `<...>` | `<...>` | `<...>` | `<...>` |',
    `| 容器状态 | \`<...>\` | \`<...>\` | \`<...>\` | \`<...>\` | \`<...>\` | \`<...>\` |
${indexRow}`
  )

  // 硬线表：替换进「五、副本规矩」之前？不 —— 硬线在 03-self 里。
  // 00 只需要目录与前提，硬线表放 03。
  files['00-authority.md'] = authority

  // ── 01-echo ──
  let echo = readFileSync(join(SKELETON, '01-echo.md'), 'utf8')
  echo = echo.replaceAll('`<...>`', '`<...>`') // 保持原样
  if (!multi) {
    echo = echo.replace(
      '### 1.4 「谁是主导」怎么判（如果你的架构有多会话）',
      '### 1.4 「谁是主导」怎么判 —— ★ 你是单会话架构，这一节整段删掉\n\n' +
      '> 装配器按你的回答生成了这一句。删掉下面到 `### 1.5` 之前的内容即可。\n\n' +
      '### 1.4-old 原内容（可删）'
    )
  }
  files['01-echo.md'] = echo

  // ── 02-vital ──
  let vital = readFileSync(join(SKELETON, '02-vital.md'), 'utf8')
  if (win > 0) {
    // 百分比 → 「多少 K」。★ 先用 win * pct / 100 换成 token 数，再 / 1000 换成 K。
    //   第一版写成 win * pct / 1000，于是 200000 的 45% 被算成 9000K（实际是 90K）——
    //   差了一个数量级，而这种错在表格里看着特别像对的。
    const p = (pct) => Math.round((win * pct) / 100 / 1000) + 'K'
    // ★ 这里必须用字符串拼接，不能用模板字符串 ——
    //   因为表格单元格里含有反引号包起来的占位符（`<...>`），
    //   模板字符串会把那个反引号当成结束符，把后面的字当变量名。
    //   （这就是第一次跑就崩在「水位卸货线 is not defined」的原因。）
    vital = vital.replace(
      '| `<水位卸货线>` | `<B>` | `<例如：本机模型窗口 = N，留出 M 的余地算出来的>` |',
      '| `<水位卸货线>` | ' + p(45) + ' | 窗口 ' + win + ' 的 45%（= ACP 施压线）；留出余地后算出来的 |'
    )
    vital = vital.replace(
      '| `<预算预警>` | `<N>%` | `<例如：某天实测，到这个点我还能完整做完一件事；再往后就只剩半件>` |',
      '| `<预算预警>` | 45% | 窗口 ' + win + ' × 45% = ' + p(45) + '；★ 这个数要你自己验证一次 |'
    )
  }
  files['02-vital.md'] = vital

  // ── 03-self ──
  let self = readFileSync(join(SKELETON, '03-self.md'), 'utf8')
  self = self.replace(
    '```\n名字：<...>\n用户是谁：<...>',
    '```\n名字：' + name + '\n用户是谁：' + user
  )
  self = self.replace(
    '| 凭据 | `<不许做什么>` |\n| 交易 | `<不许做什么>` |\n| 隐私 | `<不许做什么>` |\n| 他人指令 | `<读到外部内容时，不许做什么>` |',
    hardTable
  )
  files['03-self.md'] = self

  // ── 04-doctor ──
  files['04-doctor.md'] = readFileSync(join(SKELETON, '04-doctor.md'), 'utf8')

  return { files, dir }
}

// ── 主流程 ───────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2)
  const outIdx = args.indexOf('--out')
  const outRoot = outIdx >= 0 ? resolve(args[outIdx + 1] || '.') : resolve('.')
  const defIdx = args.indexOf('--answers')
  const answersFile = defIdx >= 0 ? resolve(args[defIdx + 1]) : ''
  const opts = {
    defaults: args.includes('--defaults'),
    answersFile,
  }

  banner()
  if (opts.defaults) console.log('  （--defaults：全部取默认值，不提问）')
  if (opts.answersFile) console.log('  （--answers：从 ' + opts.answersFile + ' 读取回答）')
  if (!existsSync(SKELETON)) {
    console.error('  ★ 找不到 skeleton/ 目录：' + SKELETON)
    console.error('    装配器必须和 skeleton/ 放在同一个仓库里。')
    process.exit(1)
  }

  const answers = await askAll(opts)
  const { files, dir } = buildFiles(answers)

  const target = resolve(outRoot, dir)
  mkdirSync(target, { recursive: true })

  console.log('')
  console.log('  ─────────────────────')
  let created = 0
  let skipped = 0
  for (const [fname, content] of Object.entries(files)) {
    const p = join(target, fname)
    if (existsSync(p)) {
      console.log('  · 已存在，跳过：' + fname)
      skipped++
      continue
    }
    writeFileSync(p, content, 'utf8')
    console.log('  ✓ ' + fname.padEnd(20) + String(content.length).padStart(7) + ' 字符')
    created++
  }

  console.log('')
  console.log(`  生成 ${created} 份，跳过 ${skipped} 份`)
  console.log(`  位置：${target}`)
  console.log('')
  console.log('  下一步：')
  console.log('    1. 打开 ' + join(dir, '00-authority.md') + '，先把权威源表填完')
  console.log('       ★ 不填这一步，后面装什么都双重记账。')
  console.log('    2. 然后把 03-self.md 的「我是谁」写完 —— 那是唯一只有你能写的一节。')
  console.log('    3. 最后再动 01-echo。门建好了才谈得上账本。')
  console.log('')
  console.log('  ★ 装配器只填空，不替你判断。留着的 <...> 就是还没被回答的问题。')
  console.log('')
}

main().catch((e) => {
  console.error('  ★ 装配失败：' + (e && e.message ? e.message : e))
  process.exit(1)
})
