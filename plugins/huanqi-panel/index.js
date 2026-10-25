// dsh-agent-huanqi-panel · 宿主半
//
// 干什么：把换气插件（dsh-huanqi）的参数搬到 DSH 设置面板里，并且显示实时延续额度。
//
// ★★★ 为什么是「独立插件」而不是给 dsh-huanqi 加界面：
//   dsh-huanqi 是第三方包（有 LICENSE、README），而且它自己没有客户端半。
//   改它是侵入式的；这个面板只把它 profile 里那段配置当数据来读写，两边解耦。
//
// ★★★ 全篇最要紧的一条：**绝不能重新序列化 cordis.patch.yml。**
//   那个文件（18 KB）里塞满了中文注释、`!!js` 表达式和手工排过版的分节，
//   任何"读成对象 → 写回 YAML"的做法都会把它们全丢掉。
//   所以这里的写操作是**字节级的**：定位到 `- id: huanqi` 那一段里的 `config:` 块，
//   只替换「某一行值的等号右边」或在块尾插入一行，其余字节原样保留。
//   （这个思路抄自 dsh-huanqi 自带的 set-quota.mjs，但做成了通用键值。）
//
// 路由（都挂在 /yanqing-huanqi 前缀下）：
//   GET  /yanqing-huanqi/api/state     读：当前配置 + 实时额度账本 + 文件路径
//   POST /yanqing-huanqi/api/config    写：{ profile: "desktop"|"web", values: {键: 值} }
//   GET  /yanqing-huanqi/api/preview   只读地告诉你"改完会变成哪几行"，不落盘
//   GET  /yanqing-huanqi/api/health    自检

import { join, isAbsolute, resolve as resolvePath } from 'node:path'
import { homedir } from 'node:os'
import { readFileSync, writeFileSync, existsSync, copyFileSync, statSync, renameSync, openSync, fsyncSync, closeSync, readdirSync } from 'node:fs'

export const name = 'dsh-agent-huanqi-panel'
export const inject = ['webServer']

// ═══════════════════════════════════════════════════════════════════════════
// DSH 家目录定位 —— 2026-10-23 实机报告 E3 / E4
//
// 病灶：默认写成了 `homedir() + '/dsh/home'`。Windows 下 `~` 是 <用户目录>，
// 于是默认值落在 `<用户目录>/dsh/home` —— 桌面端根本没有这个目录（桌面端是 `~/.dsh`）。
// 作者机器上设了 DSH_HOME 用户环境变量，这条默认分支永远走不到，所以它一直活着；
// 换台机器（尤其 DSH_HOME 没设）立刻表现为「面板里全是空的，但不报错」。
//
// 候选顺序，每一处都写清「为什么是这个候选」：
//   ① DSH_HOME        —— DSH 自己用的变量；显式给的一律采信（哪怕暂不存在，也如实报告）
//   ② HUANQI_HOME     —— 本插件专用覆盖（在没有 DSH 的机器上单独验面板用）
//   ③ <home>/.dsh     —— DSH 未设 DSH_HOME 时的标准位置（E3：桌面端就是这里）
//   ④ <home>/dsh/home —— 早期安装器的旧布局；只在它真的存在时采用（E3 的旧默认值）
//
// 全都不存在时**不静默**：照旧返回 ③（最可能的标准位置），并带一句可执行的下一步。
// 这句话会出现在 /api/health 和设置页上 —— 「找不到」必须能被人看见。
// ═══════════════════════════════════════════════════════════════════════════
function isDir(p) {
  try { return !!p && existsSync(p) && statSync(p).isDirectory() } catch { return false }
}

function resolveDshHome(env = process.env, userHome = homedir()) {
  const tried = []
  const add = (path, source, required) => tried.push({ path, source, required: !!required, exists: isDir(path) })
  const envHome = String(env.DSH_HOME || '').trim()
  const ownHome = String(env.HUANQI_HOME || '').trim()

  // ① / ②：显式设置优先，而且**只信它** —— 设错了要报错，不能悄悄换一个目录继续跑
  if (envHome) add(envHome, 'DSH_HOME 环境变量（DSH 自己用的那个）', true)
  if (ownHome) add(ownHome, 'HUANQI_HOME 环境变量（本插件专用覆盖）', true)

  // ③ / ④：只有没设 DSH_HOME 时才需要猜 —— 这正是报告 E3 的场景
  if (!envHome) {
    add(join(userHome, '.dsh'), 'DSH 未设 DSH_HOME 时的标准位置（报告 E3：桌面端就是这里）')
    add(join(userHome, 'dsh', 'home'), '早期安装器的旧布局；只在真的存在时采用（报告 E3 的旧默认值）')
  }

  for (const c of tried) {
    if (c.exists) return { home: c.path, source: c.source, tried, exists: true, hint: null }
  }
  const explicit = tried.find((c) => c.required)
  if (explicit) {
    return {
      home: explicit.path, source: explicit.source, tried, exists: false,
      hint: explicit.source + ' 指向的目录不存在：' + explicit.path + '。下一步：把环境变量改成你机器上真实的 DSH 家目录，再重启 DSH。'
    }
  }
  const fallback = tried[0]
  return {
    home: fallback.path, source: fallback.source, tried, exists: false,
    hint: '找不到 DSH 家目录（试过：' + tried.map((t) => t.path).join('；') + '）。'
      + '下一步：设 DSH_HOME 环境变量指向你的 DSH 家目录（DSH 用它，本面板也读它），然后重启 DSH；'
      + '或在 profile 的 cordis.patch.yml 里给本插件配 home。'
  }
}

const HOME_RES = resolveDshHome()
const HOME = HOME_RES.home

const PROFILES_RES = (() => {
  try {
    const list = readdirSync(join(HOME, 'profiles'), { withFileTypes: true })
      // node_modules 不是 profile（pnpm 会把依赖放在 profiles/ 下），隐藏目录也不是。
      // 不排除的话面板会列出一个叫 node_modules 的假 profile —— 正好是「不报错但里面是空的」那一类。
      .filter((e) => e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort()
    return { list, hint: null }
  } catch {
    // 扫不到就退回两个常见的 —— 不要因为目录不存在就整个面板挂掉。
    // 但要把「为什么是猜的」说出来，别让界面以为它扫过了。
    return { list: ['desktop', 'web'], hint: '扫描不到 ' + join(HOME, 'profiles') + '，先按 desktop / web 两个常用 profile 显示；请确认 DSH_HOME 是否正确。' }
  }
})()
const PROFILES = PROFILES_RES.list

/**
 * 换气的账本路径 —— 2026-10-23 实机报告 E4。
 *
 * 原来面板自己拼 `<HOME>/state/dsh-huanqi.json`，而 HOME 又来自那个错的默认值，
 * 于是作者机器上恰好对上，别人机器上是 `C:\Users\<用户>\dsh\home\state\dsh-huanqi.json`（不存在）。
 * 正确做法是**跟着换气自己走**：它把实际路径写在 desktop profile 的 `- id: huanqi` → config.ledgerPath；
 * 没写时才回落到它自己的默认 `<DSH_HOME>/state/dsh-huanqi.json`。
 */
function expandHomeish(p, userHome) {
  const s = String(p == null ? '' : p).trim()
  if (!s) return ''
  if (s === '~') return userHome
  if (s.startsWith('~/') || s.startsWith('~\\')) return join(userHome, s.slice(2))
  // 相对路径按 DSH 家目录解析 —— 与 dsh-huanqi 内部 join(home, ...) 的口径一致
  return isAbsolute(s) ? s : resolvePath(userHome, s)
}

function readHuanqiConfigValue(key) {
  try {
    const f = cfgPath('desktop')
    if (!existsSync(f)) return ''
    const r = readValues(readFileSync(f, 'utf8'))
    let v = r.found ? String(r.values[key] || '').trim() : ''
    // 面板的 readValues 是「按行取值」，不替人解析 YAML 引号；这里补一步去引号，
    // 否则 `ledgerPath: 'D:/x/y.json'` 会被当成带单引号的路径（文件永远找不到）。
    if (v.length > 1 && ((v[0] === "'" && v[v.length - 1] === "'") || (v[0] === '"' && v[v.length - 1] === '"'))) {
      v = v.slice(1, -1).replace(/''/g, "'")
    }
    return v
  } catch { return '' }
}

function resolveLedger(userHome) {
  // 面板专用覆盖（README 里写的 PANEL_LEDGER；文档承诺过，代码必须实现）
  const envLedger = expandHomeish(process.env.PANEL_LEDGER, userHome)
  // ★ E4 的核心：账本位置**跟着换气自己走** —— 它写在 desktop profile 的
  //   `- id: huanqi` → config.ledgerPath。这条配置即使指向的文件还没生成，也以它为准
  //   （换气第一次出手时才会创建它）；不能因为「文件不存在」就退回一个别的路径。
  const profilePath = expandHomeish(readHuanqiConfigValue('ledgerPath'), userHome)
  // 两处都没配时才回落到换气自己的默认值（它的 lib/index.js 就是 <DSH_HOME>/state/dsh-huanqi.json）
  const fallback = join(userHome, 'state', 'dsh-huanqi.json')

  const chosen = envLedger || profilePath || fallback
  const source = envLedger
    ? 'PANEL_LEDGER 环境变量（本面板专用覆盖）'
    : profilePath
      ? 'desktop profile 的 huanqi.ledgerPath（换气真正在写的位置）'
      : '换气默认位置 <DSH_HOME>/state/dsh-huanqi.json（报告 E4 的回落）'
  const tried = [
    { path: envLedger || '(未设)', source: 'PANEL_LEDGER 环境变量', exists: !!envLedger && existsSync(envLedger) },
    { path: profilePath || '(未配)', source: 'desktop profile 的 huanqi.ledgerPath', exists: !!profilePath && existsSync(profilePath) },
    { path: fallback, source: '换气默认位置', exists: existsSync(fallback) }
  ]
  const exists = existsSync(chosen)
  return {
    path: chosen, source, tried, exists,
    hint: exists ? null : '账本还不存在：可能换气还没出过手（正常）；也可能它在别处 —— '
      + '在设置页把「账本路径」填成实际文件，或设 PANEL_LEDGER 环境变量。已尝试：'
      + tried.filter((t) => t.path !== '(未设)' && t.path !== '(未配)').map((t) => t.path).join('；')
  }
}

const LEDGER_RES = resolveLedger(HOME)
/** 换气的账本（按上面的顺序解析）。它在换气出手时被重写，是"实时额度"的唯一来源。 */
const LEDGER = LEDGER_RES.path

/** 面板里暴露的参数：类型 + 取值范围 + 中文说明。范围抄自 dsh-huanqi 的 Config（zod schema）。 */
const FIELDS = [
  { key: 'maxContinuations', type: 'int', min: 0, max: 10, def: 4, label: '延续额度上限', hint: '一口气能接几次；0 = 关掉换气层（只留循环检测）' },
  { key: 'normalTurnThreshold', type: 'int', min: 5, max: 100, def: 20, label: '涨额度所需正常轮', hint: '攒够多少「正常轮」额度 +1（正常轮 = 出了正文、没触发延续）' },
  { key: 'anomalyWindow', type: 'int', min: 3, max: 50, def: 10, label: '异常判定窗口', hint: '出正文后多少轮内又卡住，算一次异常（额度 −1）' },
  { key: 'warnAtCredit', type: 'int', min: 1, max: 10, def: 2, label: '剩几点开始提示', hint: '额度降到这个数时换气会在提示里带上警告' },
  { key: 'silentReasoningChars', type: 'int', min: 0, max: 100000, def: 8000, label: '流内早杀阈值（字）', hint: '推理写到这么多字、正文与工具仍为零，就地截断。★ 太小会误杀正常的长推理（3000 曾误杀 7.9%）' },
  {
    // ★ 2026-10-23 加。三档语义见 dsh-huanqi 的 Config 注释。
    //   `strict` 是默认值 —— 等于「和主会话同样的保护」，不改变任何现有行为。
    key: 'subagentPolicy',
    type: 'enum',
    def: 'strict',
    label: '子 agent 严格程度',
    hint: '子 agent（含 Agent Teams 成员）适用哪一档换气判据。strict = 与主会话同保护（默认）；relaxed = 只保留流内早杀；exempt = 完全豁免。改完需重启 DSH。',
    options: [
      { value: 'strict', label: '全局应用（最严格）' },
      { value: 'relaxed', label: '子 agent 放宽（保留流内早杀）' },
      { value: 'exempt', label: '子 agent 完全豁免' },
    ],
  },
  { key: 'ledgerPath', type: 'str', def: '', label: '账本路径', hint: '留空 = <DSH_HOME>/state/dsh-huanqi.json' }
]

function json(res, code, obj) {
  const body = JSON.stringify(obj)
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', Buffer.byteLength(body))
  res.end(body)
}

function cors(res) {
  // ★ 桌面端设置页的 origin 是 file:// 或 app://，从那种页面 fetch 本机端口属于跨域；
  //   缺这几个头就是 `Failed to fetch`，而界面只会显示「载入中」。
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'content-type')
}

function cfgPath(profile) { return join(HOME, 'profiles', profile, 'cordis.patch.yml') }

/**
 * 找到 `- id: huanqi` 那一节，返回它在文本里的行号范围与 config 块的缩进。
 *
 * 判据用的是**缩进**而不是"找下一个 `- `"：这一段嵌在 `- set:` 下面，
 * 所以它的兄弟项缩进和它一样（4 空格），而它的子项（`config:`）更深。
 * 遇到缩进 ≤ 自己的 `- ` 就是本节结束 —— 与 set-quota.mjs 同一套判据。
 */
function locate(text) {
  const lines = text.split('\n')
  let start = -1, idIndent = 0
  for (let i = 0; i < lines.length; i++) {
    // ★ 2026-10-25：兼容两种 entry id —— 换气的 patch 里目前仍写 huanqi，
    //   若将来与包名对齐成 dsh-huanqi，这里不必再改一次。
    if (/^\s*-\s*id:\s*(huanqi|dsh-huanqi)\s*$/.test(lines[i])) { start = i; idIndent = lines[i].search(/\S/); break }
  }
  if (start < 0) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*-\s/.test(lines[i]) && lines[i].search(/\S/) <= idIndent) { end = i; break }
  }
  // config: 必须在 id 之后、本节结束之前
  let cfg = -1, cfgIndent = 0
  for (let i = start + 1; i < end; i++) {
    const m = lines[i].match(/^(\s*)config:\s*$/)
    if (m) { cfg = i; cfgIndent = m[1].length; break }
  }
  return { lines, start, end, cfg, cfgIndent, idIndent }
}

/** 从本节里读出键值（只认 `键: 值` 这一种标量行）。 */
function readValues(text) {
  const loc = locate(text)
  if (!loc) return { found: false, values: {} }
  const { lines, start, end, cfg, cfgIndent } = loc
  const values = {}
  const scopeStart = cfg >= 0 ? cfg + 1 : start + 1
  for (let i = scopeStart; i < end; i++) {
    const m = lines[i].match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*):\s*(.*?)\s*$/)
    if (!m) continue
    if (m[1].length <= (cfg >= 0 ? cfgIndent : loc.idIndent)) continue
    let raw = m[3]
    // ★★★ 2026-10-23 修（换气面板下拉框「选了又跳回去」的真正原因）：
    //   YAML 里的字符串值是 `subagentPolicy: 'relaxed'`，按行取值会把**引号一起带出来**，
    //   于是 `raw = "'relaxed'"`。
    //     · 文本框看着没毛病（显示成 `'relaxed'`，但没人细看）；
    //     · `<select value="'relaxed'">` 却**匹配不上** value 为 `relaxed` 的 option，
    //       浏览器静默回落到第一项 —— 看起来就是「保存后又跳回 strict」。
    //   原来只特判了空串 `''`，带引号的非空串没剥。
    //   注：`readHuanqiConfigValue()` 早就单独补过这一步（本文件 128-132 行），
    //   但那是给账本路径打的补丁；放在源头，所有消费方都受益，且对它是幂等的。
    if (raw === "''" || raw === '""') raw = ''
    else if (
      raw.length > 1
      && ((raw[0] === "'" && raw[raw.length - 1] === "'") || (raw[0] === '"' && raw[raw.length - 1] === '"'))
    ) {
      // YAML 单引号里转义单引号是写两遍 `''`，剥完要还原成一个
      raw = raw.slice(1, -1).replace(/''/g, "'")
    }
    values[m[2]] = raw
  }
  return { found: true, hasConfig: cfg >= 0, values }
}

/** 把值渲染成 YAML 里的写法（字符串要引号，数字不加）。 */
function render(field, value) {
  if (field.type === 'int') {
    const n = Number(value)
    if (!isFinite(n)) throw new Error(`${field.key} 不是数字：${value}`)
    // ★ 不静默取整（N11，2026-10-22）。这几个字段都是「算字数 / 算轮数」的硬阈值，
    //   输 3.7 存成 3 是一个没人看见的改动 —— 与其处理得像个小智能，不如直接说不行。
    if (!Number.isInteger(n)) throw new Error(`${field.key} 只接受整数，你给的是 ${value}`)
    if (field.min != null && n < field.min) throw new Error(`${field.key} 不能小于 ${field.min}`)
    if (field.max != null && n > field.max) throw new Error(`${field.key} 不能大于 ${field.max}`)
    return String(n)
  }
  // ★ enum：只接受 options 里列出的值。白名单校验放在服务端 —— 面板是 `<select>`，
  //   但接口也能被直接 POST，所以不能只靠前端。
  if (field.type === 'enum') {
    const s = String(value == null ? '' : value)
    const opts = (field.options || []).map((o) => o.value)
    if (!opts.includes(s)) {
      throw new Error(`${field.key} 只能是 ${opts.join(' / ')} 之一，你给的是「${s}」`)
    }
    return `'${s.replace(/'/g, "''")}'`
  }
  const s = String(value == null ? '' : value)
  return s === '' ? "''" : `'${s.replace(/'/g, "''")}'`
}

/**
 * ★ 字节级写入：只动该动的行，其余原样。
 * 返回新的整段文本 + 一份"改了什么"的账（给界面显示，也给测试断言）。
 */
function applyValues(text, values) {
  const loc = locate(text)
  if (!loc) throw new Error('这份 cordis.patch.yml 里没有 `- id: huanqi` 这一节，不敢动它')
  const { lines, end, cfg, cfgIndent } = loc
  const changes = []

  // 没有 config: 就补一个（缩进比 id 深一级）
  if (cfg < 0) {
    const unit = ' '.repeat(loc.idIndent)
    lines.splice(loc.start + 1, 0, `${unit}  config:`)
    return applyValues(lines.join('\n'), values)   // 补完重跑一次，逻辑只写一份
  }

  const childIndent = ' '.repeat(cfgIndent + 2)
  let insertAt = cfg + 1
  // 先算出 config 块的结束行（下一个缩进 ≤ cfgIndent 的非空行）
  while (insertAt < end) {
    const l = lines[insertAt]
    if (l.trim() !== '' && l.search(/\S/) <= cfgIndent) break
    insertAt++
  }

  for (const field of FIELDS) {
    if (!(field.key in values)) continue
    const want = render(field, values[field.key])
    let hit = -1
    for (let i = cfg + 1; i < insertAt; i++) {
      const m = lines[i].match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*):\s*(.*?)\s*$/)
      if (m && m[2] === field.key) { hit = i; break }
    }
    if (hit >= 0) {
      const old = lines[hit]
      // ★ 只换 value 那一段，保留该行自己的行尾注释（N8，2026-10-22）。
      //   原来是重新拼整行 —— 文件头注释保住了（这是它引以为傲的"绝不重新序列化"），
      //   但被改的那一行的 `# 说明` 会跟着消失。改一行吃掉一行注释，说不过去。
      const mm = old.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*):\s*(.*?)(\s+#.*)?$/)
      const tail = mm && mm[4] ? mm[4] : ''
      const indent = mm && mm[1] !== undefined ? mm[1] : childIndent
      const next = `${indent}${field.key}: ${want}${tail}`
      if (old !== next) { lines[hit] = next; changes.push({ key: field.key, from: old.trim(), to: next.trim() }) }
    } else {
      lines.splice(insertAt, 0, `${childIndent}${field.key}: ${want}`)
      insertAt++
      changes.push({ key: field.key, from: '(未设置 → 用默认值)', to: `${field.key}: ${want}` })
    }
  }
  return { text: lines.join('\n'), changes }
}

function readLedger() {
  try {
    if (!existsSync(LEDGER)) return { exists: false, path: LEDGER, source: LEDGER_RES.source, hint: LEDGER_RES.hint }
    const s = JSON.parse(readFileSync(LEDGER, 'utf8'))
    const credit = Number(s.credit), max = Number(s.creditMax)
    return {
      exists: true, path: LEDGER,
      credit, creditMax: max,
      ratio: isFinite(credit) && isFinite(max) && max > 0 ? credit / max : null,
      normalTurns: s.normalTurns, turnsSinceOutput: s.turnsSinceOutput,
      stats: s.stats || {},
      mtime: existsSync(LEDGER) ? undefined : undefined
    }
  } catch (e) {
    return { exists: true, path: LEDGER, error: String((e && e.message) || e) }
  }
}

/**
 * 换气的热重载补丁**在这个进程里活着吗**？
 *
 * ★ 判据是「文件 mtime 早于本进程启动时刻」—— 而不是「文件存在」。
 *   文件在、但进程比它老，说明这次启动加载的还是旧代码，补丁没进内存。
 *   这一个比较就能如实回答用户那句「要重启吗」，不用猜。
 */
function hotPatchLive() {
  try {
    const p = `${HOME}/profiles/desktop/node_modules/dsh-huanqi/lib/index.js`
    if (!existsSync(p)) return false
    const startedAt = Date.now() - process.uptime() * 1000
    return statSync(p).mtimeMs < startedAt
  } catch (e) {
    return false
  }
}

export function apply(ctx) {
  ctx.webServer.register({
    kind: 'prefix',
    path: '/yanqing-huanqi',
    handler: async (req, res) => {
      cors(res)
      if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end() }

      let url
      try { url = new URL(req.url, 'http://127.0.0.1') } catch { return json(res, 400, { ok: false, message: 'URL 不合法' }) }
      const p = url.pathname.replace(/^\/yanqing-huanqi/, '') || '/'

      try {
        if (p === '/api/health') {
          return json(res, 200, {
            ok: true,
            files: PROFILES.map((x) => ({ profile: x, path: cfgPath(x), exists: existsSync(cfgPath(x)) })),
            fields: FIELDS.map((f) => f.key),
            ledger: LEDGER,
            // ★ E3/E4 的诊断：路径是怎么定下来的、试过哪些、找不到时下一步做什么。
            home: { path: HOME, source: HOME_RES.source, exists: HOME_RES.exists, tried: HOME_RES.tried, hint: HOME_RES.hint },
            profiles: { list: PROFILES, hint: PROFILES_RES.hint },
            ledgerInfo: { path: LEDGER, source: LEDGER_RES.source, exists: LEDGER_RES.exists, tried: LEDGER_RES.tried, hint: LEDGER_RES.hint }
          })
        }

        if (p === '/api/state') {
          const per = {}
          for (const prof of PROFILES) {
            const f = cfgPath(prof)
            if (!existsSync(f)) { per[prof] = { exists: false, path: f }; continue }
            const text = readFileSync(f, 'utf8')
            const r = readValues(text)
            per[prof] = { exists: true, path: f, found: r.found, hasConfig: r.hasConfig, values: r.values, bytes: Buffer.byteLength(text, 'utf8') }
          }
          return json(res, 200, {
            ok: true, fields: FIELDS, profiles: per, ledger: readLedger(),
            home: { path: HOME, source: HOME_RES.source, exists: HOME_RES.exists, hint: HOME_RES.hint },
            profilesInfo: { list: PROFILES, hint: PROFILES_RES.hint }
          })
        }

        if (p === '/api/preview') {
          const prof = url.searchParams.get('profile') || 'desktop'
          const f = cfgPath(prof)
          if (!existsSync(f)) return json(res, 404, { ok: false, message: '没有这个 profile 的配置文件：' + f })
          const values = {}
          for (const [k, v] of url.searchParams.entries()) { if (k !== 'profile' && k !== 't') values[k] = v }
          const before = readFileSync(f, 'utf8')
          let r
          try { r = applyValues(before, values) } catch (e) { return json(res, 400, { ok: false, message: String((e && e.message) || e) }) }
          return json(res, 200, {
            ok: true, profile: prof, path: f,
            changes: r.changes,
            bytesBefore: Buffer.byteLength(before, 'utf8'),
            bytesAfter: Buffer.byteLength(r.text, 'utf8'),
            // 只回"改后那一段"，不回整份文件（免得界面把它当正文显示）
            diff: r.changes.length ? r.text.split('\n').slice(Math.max(0, locate(r.text).start - 6), locate(r.text).end + 2).join('\n') : '(没有变化)'
          })
        }

        if (p === '/api/config') {
          if (req.method !== 'POST') return json(res, 405, { ok: false, message: '只支持 POST' })
          const chunks = []
          for await (const c of req) chunks.push(c)
          let body
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch (e) {
            return json(res, 400, { ok: false, message: '发上来的不是合法 JSON：' + String((e && e.message) || e) })
          }
          const targets = Array.isArray(body.profiles) && body.profiles.length
            ? body.profiles.filter((x) => PROFILES.includes(x))
            : ['desktop']
          const values = body.values || {}
          const unknown = Object.keys(values).filter((k) => !FIELDS.some((f) => f.key === k))
          if (unknown.length) return json(res, 400, { ok: false, message: '不认识的参数：' + unknown.join(', ') })

          const results = []
          for (const prof of targets) {
            const f = cfgPath(prof)
            if (!existsSync(f)) { results.push({ profile: prof, ok: false, message: '文件不存在：' + f }); continue }
            const before = readFileSync(f, 'utf8')
            let r
            try { r = applyValues(before, values) } catch (e) {
              results.push({ profile: prof, ok: false, message: String((e && e.message) || e) }); continue
            }
            if (!r.changes.length) { results.push({ profile: prof, ok: true, changes: [], note: '值没变，没写盘' }); continue }
            try {
              // 写前留一份带时间戳的备份（这个文件承载着整套 profile 配置，不能只有一份）
              const stamp = new Date().toISOString().replace(/[:.]/g, '-')
              copyFileSync(f, `${f}.bak-huanqi-panel-${stamp}`)
              // ★★ 原子写（N9，2026-10-22）：先写同目录的 .tmp，fsync 落盘，再 rename 顶替。
              //   原来是 writeFileSync 直接覆盖 —— 进程在写的半路被杀（DSH 退出、断电、
              //   杀软锁文件）就会留下半截 YAML，而 cordis.patch.yml 读不动 = DSH 起不来 =
              //   sanitizeProfile 把 bundles 重置。那正是这个面板最不该造成的事：
              //   它是为了让改参数变安全才存在的。
              //   ★ 备份救不了这一下 —— YAML 坏掉时没人会想到去用那个 .bak-时间戳。
              const tmp = `${f}.tmp-huanqi-panel-${stamp}`
              writeFileSync(tmp, r.text, 'utf8')
              try { const fd = openSync(tmp, 'r+'); fsyncSync(fd); closeSync(fd) } catch { /* fsync 失败不致命，rename 才是关键 */ }
              renameSync(tmp, f)
              results.push({ profile: prof, ok: true, changes: r.changes, backup: `${f}.bak-huanqi-panel-${stamp}` })
            } catch (e) {
              results.push({ profile: prof, ok: false, message: '写盘失败：' + String((e && e.message) || e) })
            }
          }
          return json(res, 200, { ok: results.every((x) => x.ok), results, needsRestart: true })
        }

        // ── 恢复额度（手动给换气加命）────────────────────────────────────────
        // ★ 两条恢复机制里的第二条：自然恢复靠轮数（每 normalTurnThreshold 轮 +1），
        //   这一条是使用者手动给的。改的是**账本文件**的 credit 字段。
        // ★ 落盘之后能不能"不重启就生效"，取决于换气那边有没有热重载补丁 ——
        //   没有补丁时它内存里的旧值会在下次 save() 时覆盖回去，所以响应里如实报告。
        if (p === '/api/credit') {
          if (req.method !== 'POST') return json(res, 405, { ok: false, message: '只支持 POST' })
          const chunks = []
          for await (const c of req) chunks.push(c)
          let body
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch (e) {
            return json(res, 400, { ok: false, message: '发上来的不是合法 JSON：' + String((e && e.message) || e) })
          }
          const want = Number(body.credit)
          if (!isFinite(want) || want < 0) return json(res, 400, { ok: false, message: 'credit 必须是不小于 0 的数字' })
          if (!existsSync(LEDGER)) return json(res, 404, { ok: false, message: '账本不存在：' + LEDGER })
          let state
          try { state = JSON.parse(readFileSync(LEDGER, 'utf8')) } catch (e) {
            return json(res, 500, { ok: false, message: '账本读不出来：' + String((e && e.message) || e) })
          }
          const max = Number(state.creditMax)
          const cap = isFinite(max) && max > 0 ? Math.trunc(max) : Math.trunc(want)
          const next = Math.max(0, Math.min(Math.trunc(want), cap))
          const before = state.credit
          state.credit = next
          const stamp = new Date().toISOString().replace(/[:.]/g, '-')
          const backup = LEDGER + '.bak-credit-' + stamp
          copyFileSync(LEDGER, backup)
          writeFileSync(LEDGER, JSON.stringify(state, null, 2) + '\n', 'utf8')
          return json(res, 200, { ok: true, before, credit: next, creditMax: max, backup, hot: hotPatchLive() })
        }

        return json(res, 404, { ok: false, message: '没有这条路由：' + p })
      } catch (e) {
        try { return json(res, 500, { ok: false, message: String((e && e.message) || e) }) } catch { return res.end() }
      }
    }
  })

  ctx.logger?.info?.('[dsh-yanqing-huanqi-panel] 路由已挂：/yanqing-huanqi/api/{health,state,preview,config}')
}

// ★ 把三个纯函数导出，**为了能在不重启 DSH 的情况下直接对它们做自检**：
//   locate/readValues/applyValues 都是「文本进、文本出」的纯函数，
//   于是可以拿 profile 文件的真实副本反复试（包括"改了再改回去必须字节相同"这种断言），
//   而不用碰运行中的那一份。这是这个插件最要紧的一条不变量，必须可测。
export { locate, readValues, applyValues, FIELDS, LEDGER, cfgPath, resolveDshHome, resolveLedger }
