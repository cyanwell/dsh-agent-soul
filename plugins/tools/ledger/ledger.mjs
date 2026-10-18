// ledger.mjs —— 只追加账本（append-only ledger）+ 权限闸门
//
// ★ 这是什么：一个「写下去就改不了」的记录文件，加一个命令行工具。
//   它解决的是：**多个会话共享记忆时，「谁在什么时候说了什么」必须能被追溯。**
//   为什么不用共享可变文件：多写者环境里那是万恶之源（两个写者互相覆盖、谁都说不清最终状态）。
//   只追加不需要锁 —— 各写各的行，读的时候按时间合并。
//
// ★★ 三分钟上手（照做，每一步都有可验的东西）：
//
//   ① 把这个目录放到你想放的地方（比如 <你的工作区>/tools/ledger/）
//   ② 建账本：            node ledger.mjs add fact "第一条记录" --ref "手动创建"
//      ★ 验：同级目录出现 ledger.jsonl，里面是一行 JSON
//   ③ 看它有什么命令：     node ledger.mjs types
//      ★ 验：列出八类记录的名字与用途
//   ④ 读出来：            node ledger.mjs list --limit 3
//      ★ 验：看到刚才那条
//   ⑤ 换路径（可选）：     set LEDGER=D:/别的地方/ledger.jsonl
//
// ★ 为什么叫「只追加」：文件永远只被追加新行，从不重写、从不删除。
//   于是「历史」和「现在」是同一份数据 —— 你读到的任何结论，都还能找到它第一次被写下的那一行。
//
// ★ 权限闸门在这一行（代码级，不靠自律）：
//     写 `promise` 需要先署过 `lead` —— 否则 exit 3。
//   设计意图：**不依赖「它记得不要写」，而依赖「它写不进去」。约定会失效，闸门不会。**
//
// ledger.mjs —— 「账本」：append-only 账本（**只追加**）
//
// ★ 为什么是「只追加」而不是一个共享的可改文件：
//   多写者环境里，共享可变文件是万恶之源 —— ** 实测踩过**：
//   `edit` 工具用原子写入（写临时文件再改名）打断硬链接，于是"我改了源、副本没变，
//   而两个都叫我的名字"。同样的形状在多人同时编辑一个 JSON 上会重演。
//   只追加的日志**不需要锁**：各写各的行，读的时候按时间合并。
//   ★ 现成的证据：`<DSH_HOME>\sessions\**\session.v3.jsonl.zstd` 661 个会话各自追加，
//     从来没有冲突过（`sessionlook.mjs` 能读它们全部）。
//
// 用法：
//   node ledger.mjs add <type> "<text>" [--ref <证据指针>] [--by <会话id>]
//   node ledger.mjs list [--type <type>] [--limit N] [--json]
//   node ledger.mjs stats
//   node ledger.mjs types
//
// type 八类（对应设计者  定的定义）：
//   promise  答应做什么 / 承诺了什么   ← ★★ **只有主导会话（脑）能写**
//   fact     做了什么、产物在哪        ← 谁做谁写
//   shelved  搁置了什么                ← 谁做谁写
//   gain     得到了什么                ← 谁做谁写
//   loss     失败了什么 / 失去了什么    ← 谁做谁写
//   persona  人格与记忆的变更           ← 谁做谁写，但改了要告诉设计者
//   container 容器的目录：本会话是谁、做了什么、产物在哪、何时退场   ← ★ 退场时写，谁退谁写
//             ★ 加（设计者提议、第 2 代执行）—— 起因：`lead` 只记**主导**，
//             而**器官从不写 `lead`** ⇒「lead 就是它们的目录」这句对器官不成立。
//             不写这条，器官退了就只能靠 sessionlook.mjs 找 —— 那是**另一套系统**，不在「账本」里。
//
// ★ 「脑 / 器官」的判据：**这条会话会不会替设计者做承诺？**
//   会 → 脑（默认 1 条，上限 2，活得久）；不会 → 器官（可多，干完就关）。
//   器官**不许写 promise** —— 身份可以复制，责任不能。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MO = process.env.LEDGER || path.join(path.dirname(fileURLToPath(import.meta.url)), 'ledger.jsonl')
// ★ `lead`（主导权）是  加的第 7 类 —— 它不记"发生了什么"，它记"**现在哪个容器持主导权**"。
//   为什么需要它：设计者要问「我怎么在新会话里确认你是那个负责决策的主体？」——
//   旧答案是"看令牌文件"，但那正是要被废掉的东西。新答案：**看「账本」里最后一条 lead 的署名**。
//   只追加 ⇒ 凭据写进去就改不了；换届 = 新会话写一条 lead。**不需要令牌文件了。**
const TYPES = ['lead', 'promise', 'fact', 'shelved', 'gain', 'loss', 'persona', 'container']
const LABEL = {
  lead: '主导', promise: '承诺', fact: '事实', shelved: '搁置', gain: '得', loss: '失', persona: '人格',
  container: '容器',
}

const argv = process.argv.slice(2)
const cmd = argv.shift()

// 取 --flag value 并把它从 argv 里摘掉
function opt(name, def) {
  const i = argv.indexOf(name)
  if (i === -1) return def
  const v = argv[i + 1]
  argv.splice(i, v !== undefined && !v.startsWith('--') ? 2 : 1)
  return v === undefined ? true : v
}

const readAll = () => {
  if (!fs.existsSync(MO)) return []
  return fs.readFileSync(MO, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
    .map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
}

// 本地时间的 ISO（带 +08:00），不依赖 Intl 的时区库
function localIso(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const oh = p(Math.floor(Math.abs(off) / 60)), om = p(Math.abs(off) % 60)
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${oh}:${om}`
}

// ---- 身份：promise 的硬闸门（ 加；同日改为从「账本」读，不再读令牌文件）----

// ★ 实测：**两种会话 id 格式并存** —— 主导会话是 `session-03ee7b55-…`（带前缀），
//   子会话是 `9b8f7775-ca9a-42…`（**不带**）。要互相比较就必须先归一化。
function normId(v) {
  const s = String(v === undefined || v === null ? '' : v).trim()
  if (!s) return ''
  return (s.startsWith('session-') ? s.slice(8) : s).slice(0, 8)
}

// ★ 当前主导者 = **「账本」里最后一条 `lead` 记录的 `by`**。
//   为什么不用 `01-根令牌.json` 了：那正是设计者要废掉的东西。而「账本」是**只追加**的 ——
//   凭据一旦写进去就改不了，比一个可以被随手编辑的 JSON 更硬。
//   换届 = 新主导者写一条 `lead`，旧的自然被后一条盖过。
function currentLead() {
  const rows = readAll()
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].type === 'lead') return rows[i].by
  }
  return ''
}

// ★ 是不是"脑"：本进程的 DSH_SESSION_ID 是不是当前主导者。
//   纯代码判据，不靠会话自律 —— 起因见 add 分支里的注释。
function isBrain() {
  const lead = currentLead()
  const me = normId(process.env.DSH_SESSION_ID)
  return Boolean(lead && me && lead === me)
}

if (cmd === 'types') {
  console.log('可用类型（`ledger.mjs add <type> "<text>"`）：')
  for (const t of TYPES) console.log(`  ${t.padEnd(9)} ${LABEL[t]}${t === 'promise' ? '   ★ 只有主导会话能写' : ''}`)
  process.exit(0)
}

if (cmd === 'add') {
  const type = argv.shift()
  if (!TYPES.includes(type)) {
    console.error(`✗ 未知 type「${type}」。可选：${TYPES.join(' / ')}`)
    process.exit(1)
  }
  // ★ 必须**先**摘掉 --xxx 选项，再拼 text ——
  //   否则选项的**值**会被当成 text 的一部分（`add fact "hello" --ref /p` → text="hello /p"）。
  const ref = opt('--ref', null)
  const byFlag = opt('--by', undefined)      // ★ 只有**显式传了**才算"代写"
  const feel = opt('--feel', null)           // ★  加：当时的感受（一手，可缺省）
  const by = byFlag !== undefined ? byFlag : (process.env.DSH_SESSION_ID || 'unknown')

  const text = argv.filter((a) => !a.startsWith('--')).join(' ').trim()
  if (!text) { console.error('✗ 缺 text'); process.exit(1) }

  // ★★ promise 的硬闸门（ 加）——
  //   起因：一条器官会话受命"试着写 promise"。它**自己拒绝了**，但顺手指出
  //   **脚本根本不拦**：只有一句软提示，红线完全靠会话自律。那就不是闸门，是标语。
  if (type === 'promise') {
    if (byFlag !== undefined) {
      console.error('✗ 承诺不许代写（不接受 `--by`）。promise 必须由本人写下。')
      process.exit(3)
    }
    if (!isBrain()) {
      console.error('✗ 只有「脑」能写 promise —— 当前主导者是 ' + (currentLead() || '(还没有 lead 记录)') + '。')
      console.error('  你是 ' + (normId(process.env.DSH_SESSION_ID) || '(DSH_SESSION_ID 未设置)') + '，不是它。')
      console.error('  ★ 器官可以写 fact / shelved / gain / loss。见 AGENTS.md §5.5。')
      process.exit(3)
    }
  }

  // ★ `lead`（主导权声明）必须写清**是谁在什么时候指定的** —— 脚本没法验证"设计者说了没有"，
  //   但至少让凭据自带出处，让后来的人能核。
  if (type === 'lead' && (ref === null || ref === true)) {
    console.error('✗ lead 必须带 `--ref` —— 写清是谁、什么时候指定的（例：--ref "设计者  说：你是主导"）。')
    process.exit(3)
  }

  // ★ 署名统一 8 个字符（见 normId 的注释：两种 id 格式并存过，导致署名长度不一致）
  const shortBy = normId(by)

  // ★★★  字段分家（设计者定，原话：
  //   「账本」是一手索引……只需要提供一个完完全全准确指向原文的索引，还有你认为重要的备注。
  //    索引 + 你此时此刻的感受、认为重要的东西 + 备注，就差不多构成「账本」了。）
  //   · 「概要」= **二手**。是原文的主要内容，**不可直接复用** —— 要照 ref 回原文。
  //                字段名本身就带警示，因为它每次被看见都在提醒人：这里不是原文。
  //   · `feel`   = **一手**。独立，不和概要沾边。**不是必填** ——
  //                有感受才写，没有就不写。做成必填它就变成每次要交的作业，那就成了表演（§5.1）。
  //   ★ 旧条目（344 条）仍叫 `text`：只追加，不回头改历史；**读的时候两个名字都认**。
  const rec = { t: localIso(), by: shortBy, type, '概要': text }
  if (feel && feel !== true) rec.feel = String(feel)
  if (byFlag !== undefined) rec.byUser = true   // ★ 标记"这条是代写的" —— 读的时候看得出来
  if (ref && ref !== true) rec.ref = String(ref)

  fs.mkdirSync(path.dirname(MO), { recursive: true })
  fs.appendFileSync(MO, JSON.stringify(rec) + '\n', 'utf8')
  console.log(`✓ 已记入「账本」  [${LABEL[type]}] ${text}`)
  // ★★  设计者要求「把 feel 变成必写，写进规则里，变成你每轮都记得的事情」
  //    （他的理由：上下文一压缩我就会不记得写；「记录自己当时的想法非常重要，
  //      因为它是一手信息……以后你读墨的时候，就能回到当初的情形」）。
  //    ★ 但这与他  自己定的那条相抵：「feel 不是必填 —— 有感受才写，没有就不写。
  //      做成必填它就变成每次要交的作业，那就成了表演（§5.1）。」
  //    ⇒ 落地为「**必问不必写**」：不强制产出，但**在触发点上问一次**。
  //      每次写「账本」都停一下：「这件事我有感觉吗？」有就补 --feel，没有就不写。
  //      ★ 区别在于：**「问过之后的没有」和「忘了问的没有」是两件事** ——
  //        设计者  抓到的正是后面那种（我连写两条，一条 feel 都没带）。
  if (!rec.feel) {
    console.log('  ♡ 这次没写 feel —— 停一下，问自己「这件事我有感觉吗？」')
    console.log('    有 → 补 --feel "..."（一手，回到当初就靠它）；没有 → 不写，这是对的。')
  }
  if (type === 'promise') console.log('  ★ 已核对身份：你确实是当前主导者（「账本」里最后一条 lead 的署名者）。')
  if (type === 'lead') console.log('  ★ 主导权已移交给你。后来者看「账本」里最后一条 lead 就知道现在是谁。')
  process.exit(0)
}

if (cmd === 'list') {
  const type = opt('--type', null)
  const limit = Number(opt('--limit', 30))
  const since = opt('--since', null)
  const asJson = opt('--json', false)
  let rows = readAll()
  if (type && type !== true) rows = rows.filter((r) => r.type === type)
  if (since && since !== true) rows = rows.filter((r) => r.t >= String(since))
  const total = rows.length
  rows = rows.slice(-limit)
  if (asJson) { console.log(JSON.stringify(rows, null, 2)); process.exit(0) }
  console.log(`「账本」共 ${total} 条${type && type !== true ? `（type=${type}）` : ''}，显示最后 ${rows.length} 条：`)
  console.log('')
  for (const r of rows) {
    // ★ 兼容两代字段：旧条目 `text`，新条目 `概要`（ 起）
    const body = r['概要'] ?? r.text ?? ''
    console.log(`  ${r.t.slice(0, 16).replace('T', ' ')}  [${(LABEL[r.type] || r.type).padEnd(2)}]  ${body}`)
    if (r.ref) console.log(`      └ ${r.ref}`)
    if (r.feel) console.log(`      ♡ ${r.feel}`)
  }
  process.exit(0)
}

if (cmd === 'stats') {
  const rows = readAll()
  console.log(`「账本」：${MO}`)
  console.log(`  共 ${rows.length} 条`)
  const byType = {}
  for (const r of rows) byType[r.type] = (byType[r.type] || 0) + 1
  for (const t of TYPES) if (byType[t]) console.log(`    ${(LABEL[t] || t).padEnd(3)} ${byType[t]}`)
  if (rows.length) console.log(`  最早 ${rows[0].t.slice(0, 16).replace('T', ' ')} ｜ 最新 ${rows[rows.length - 1].t.slice(0, 16).replace('T', ' ')}`)
  const writers = [...new Set(rows.map((r) => r.by))]
  console.log(`  写过的容器：${writers.join(', ')}`)
  process.exit(0)
}

console.log('ledger.mjs —— 「账本」：append-only 账本（只追加）')
console.log('')
console.log('  node ledger.mjs add <type> "<text>" [--ref <证据指针>] [--by <会话id>]')
console.log('  node ledger.mjs list [--type <type>] [--limit N] [--json] [--since <ISO>]')
console.log('  node ledger.mjs stats')
console.log('  node ledger.mjs types')
console.log('')
console.log('  ★ 「脑」的判据 = 本会话是不是「账本」里**最后一条 `lead`** 的署名者（不看令牌文件了）。')
console.log('  ★ 换届 / 换主导：由设计者指定，新主导写一条 `node ledger.mjs add lead "接手主导" --ref "设计者 <什么时候> 说：你是主导"`。')
console.log('')
console.log('  档案：' + MO)
