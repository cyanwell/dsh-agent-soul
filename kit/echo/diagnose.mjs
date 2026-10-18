#!/usr/bin/env node
/**
 * diagnose.mjs —— 体检之后，把「红了」翻译成「该改哪一行、去哪看」
 * ================================================================
 *
 * ★ 这个文件解决的是「验证之后」那一步
 * ------------------------------------
 * echo-doctor 能说「推送层 SELF 红」，但 agent 拿到这句话之后没有下一步：
 * 红在哪个文件的哪一行？该跑什么命令？日志在哪？
 *
 * 所以这一层做三件事，都是 doctor 做不了的：
 *   1. **补动作**：每个 check id 对应一组具体命令，不是「去检查一下」
 *   2. **抓现场**：evidence 里有文件路径就去读它，前后各几行，让人看见原文
 *   3. **指日志**：doctor 自己崩了的话，stderr 在哪、上一份输出在哪
 *
 * ★ 纪律：它只说「事实 + 动作」，不说「可能」「也许」
 *   每条都必须是「跑这个」「看这个文件」，否则 agent 还得再猜一次。
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// ── 每个 check id 的处方 ──────────────────────────────────────
// fix   = 具体能跑的命令 / 具体能做的动作
// where = 去哪看（文件路径、日志、输出字段）
const REMEDY = {
  config: {
    means: '三个数据根（书房 / 中枢 / 会话日志）没配齐，后面的检查一项都跑不了',
    fix: [
      '跑一次 agent_soul_scaffold —— 它会把目录建出来再把配置写好',
      '或者手动设环境变量 ECHO_SOUL / ECHO_MEM / ECHO_SESSIONS',
    ],
    where: [
      'evidence.problems 里逐条列了缺哪一个',
      '配置示例：plugins/echo/echo.config.example.json',
    ],
  },
  logs: {
    means: '找不到会话日志目录',
    fix: [
      '确认 DSH 的会话日志目录在哪（装了 DSH 就有，一般在 <DSH_HOME>/storages 或 sessions 下）',
      '设 ECHO_SESSIONS 指向它，或写进 echo.config.json',
    ],
    where: ['evidence.dir / evidence.problems', 'DSH 自己的 storages 目录'],
  },
  doorsign: {
    means: '门牌回取链断了 —— 压缩发生了，但摘要里没有能回取原文的指针',
    fix: [
      '确认压缩插件装的是带门牌的版本（dsh-agent-compaction，不是裸的 compaction-basic）',
      '或者：如果你的 agent 自己写摘要，检查它有没有在摘要第一行写 log:session-<id>#seq=<n>',
    ],
    where: ['evidence.summary —— 最近一次压缩的摘要开头几行', '对应那份会话日志'],
  },
  compaction: {
    means: '压缩机制的状态不对',
    fix: [
      '确认 dsh-agent-compaction 已装且进了 bundles',
      '跑 agent_soul_install scan 看它是不是「文件在但没启用」',
    ],
    where: ['evidence', 'DSH 的 cordis.patch.yml 里 compaction 那一段'],
  },
  index: {
    means: '索引层（L4）没建过，或者太旧了',
    fix: [
      '没建过 → node kit/echo/memindex.mjs build',
      '太旧（>24h）→ 同上，重建一次',
    ],
    where: ['evidence.metaPath —— meta.json 的位置和内容', 'evidence.lagHours —— 滞后多少小时'],
  },
  self: {
    means: '推送层 SELF.md 没装配，或者装配了但注入时读不到',
    fix: [
      '没装配 → node kit/echo/self.mjs build',
      '装好了却报「读不到」→ 查 dsh-agent-memory 的 selfPath 配的是不是实际位置',
    ],
    where: ['evidence.selfPath —— 配置说的位置', 'evidence.actualPath —— 文件实际在哪', 'evidence.injectionLogs —— 哪些日志里出现了「读不到」'],
  },
  mo: {
    means: '《墨》账本读不了或者格式不对',
    fix: [
      '确认账本路径（一般 <书房>/02-墨.jsonl）',
      '如果是空文件 → 跑 scaffold，它会写一条种子记录',
    ],
    where: ['evidence.path / evidence.problems'],
  },
  hot: {
    means: '热记忆（MEMORY.md / USER.md）读不到或超预算',
    fix: [
      '超预算 → 精简条目，或者让 mnemon 归档溢出部分',
      '读不到 → 确认它们在 DSH 的热记忆目录里',
    ],
    where: ['evidence.bytes / evidence.budget —— 实际多少、预算多少'],
  },
  identity: {
    means: '身份判据（谁是主导）读不出来',
    fix: [
      '确认账本里有 lead 记录：node tools/mo.mjs list --type lead --limit 3',
      '没有 lead → 新会话里让用户指定主导，然后自己写一条',
    ],
    where: ['evidence.leadCount / evidence.lastLead'],
  },
  heartbeat: {
    means: '心跳（自律神经）没在跑',
    fix: ['这是可选件 —— 不装不影响六层', '要装的话确认它进了 bundles'],
    where: ['evidence'],
  },
  drift: {
    means: '插件版本和仓库里的对不上',
    fix: ['跑 tools/sync-plugins.mjs --check 看两个仓库是否一致', '跑 agent_soul_install scan 看装的是哪个版本'],
    where: ['evidence.files —— 扫到几个脚本、有几个不匹配'],
  },
  huanqi: {
    means: '换气插件没装或者没配好',
    fix: ['确认 dsh-agent-huanqi 已装且进 bundles', '参数在 cordis.patch.yml 的 huanqi 段'],
    where: ['evidence'],
  },
}

// ── 抓现场：evidence 里出现路径就去读 ────────────────────────
function harvest(value, out, depth = 0) {
  if (depth > 3 || value == null) return
  if (typeof value === 'string') {
    // 像路径的字符串
    if (/^[A-Za-z]:[\\/]|\//.test(value) && value.length < 400) out.push(value)
    return
  }
  if (Array.isArray(value)) { for (const v of value) harvest(v, out, depth + 1); return }
  if (typeof value === 'object') { for (const v of Object.values(value)) harvest(v, out, depth + 1) }
}

function readContext(file, before = 2, after = 2) {
  try {
    if (!fs.existsSync(file)) return { exists: false }
    const st = fs.statSync(file)
    if (st.isDirectory()) {
      const items = fs.readdirSync(file).slice(0, 8)
      return { exists: true, dir: true, bytes: 0, items }
    }
    const txt = fs.readFileSync(file, 'utf8')
    const lines = txt.split('\n')
    return { exists: true, bytes: st.size, lines: lines.length, head: lines.slice(0, before + after).join('\n') }
  } catch (e) { return { exists: false, err: String(e.message || e) } }
}

// ── 跑 doctor ────────────────────────────────────────────────
function runDoctor() {
  const script = path.join(HERE, 'echo-doctor.mjs')
  const r = spawnSync(process.execPath, [script, '--json'], { encoding: 'utf8', timeout: 60000 })
  const out = (r.stdout || '').trim()
  const err = (r.stderr || '').trim()
  if (out) {
    try { return { ok: true, report: JSON.parse(out) } } catch (e) {
      return { ok: false, why: 'doctor 输出了东西但不是 JSON', stdoutHead: out.slice(0, 600), stderr: err.slice(0, 800) }
    }
  }
  return { ok: false, why: 'doctor 一行输出都没有' + (r.error ? '（' + r.error.message + '）' : ''), exitCode: r.status, stderr: err.slice(0, 800) }
}

// ── 主流程 ──────────────────────────────────────────────────
const res = runDoctor()

if (!res.ok) {
  console.log('══ 体检器自己跑不起来 ══')
  console.log('')
  console.log('  说的是：' + res.why)
  console.log('  退出码：' + (res.exitCode ?? '（无）'))
  console.log('')
  console.log('  ★ 红在哪：' + path.join(HERE, 'echo-doctor.mjs'))
  console.log('    —— 它自己崩了，所以底下这一层替你把它的话捞出来：')
  console.log('')
  if (res.stderr) {
    console.log('  stderr（最后 15 行）：')
    for (const l of res.stderr.split('\n').slice(-15)) console.log('    ' + l)
  } else {
    console.log('  stderr 是空的 —— 说明它不是崩了，是静默退出（很可能 export 语句根本没执行到）')
  }
  if (res.stdoutHead) {
    console.log('')
    console.log('  stdout 开头（说明输出不是 JSON，可能是被人话污染了）：')
    for (const l of res.stdoutHead.split('\n').slice(0, 12)) console.log('    ' + l)
  }
  console.log('')
  console.log('  ★ 该做什么：')
  console.log('    1. node --check ' + path.join(HERE, 'echo-doctor.mjs'))
  console.log('    2. 直接跑一次看原始报错：node ' + path.join(HERE, 'echo-doctor.mjs'))
  console.log('    3. 如果报 ERR_MODULE_NOT_FOUND —— 检查它 import 的文件在不在同目录')
  console.log('       （echo-config.mjs 曾经就漏打包过，症状是「输出不是 JSON」）')
  process.exit(2)
}

const report = res.report
const bad = (report.checks || []).filter((c) => c.status === 'error' || c.status === 'warn')
const wantJson = process.argv.includes('--json')

// ── 把每一条「红的」整理成可执行的结构 ──
const findings = bad.map((c) => {
  const r = REMEDY[c.id] || {}
  const paths = []
  harvest(c.evidence, paths)
  const files = []
  const seen = new Set()
  for (const p of paths) {
    if (seen.has(p) || files.length >= 3) continue
    seen.add(p)
    files.push({ path: p, ...readContext(p) })
  }
  return {
    id: c.id,
    label: c.label || c.id,
    status: c.status,
    says: c.detail || '',
    means: r.means || '',
    where: files,
    fix: r.fix || [],
    lookAt: r.where || [],
    evidenceKeys: c.evidence && typeof c.evidence === 'object' ? Object.keys(c.evidence) : [],
  }
})

if (wantJson) {
  console.log(JSON.stringify({
    ok: true,
    overall: report.overall || null,
    counts: report.counts || null,
    total: (report.checks || []).length,
    findings,
    // ★ 下一步：最该先做的那一件事。空的就说明通了。
    next: findings.length ? findings[0].fix[0] || findings[0].lookAt[0] || '' : '',
  }, null, 2))
  process.exit(0)
}

console.log('══ 体检报告：' + (report.overall || '?') + ' ══')
console.log('  ' + (report.checks || []).length + ' 项，其中 ' +
  (report.counts?.error ?? 0) + ' 红 / ' + (report.counts?.warn ?? 0) + ' 黄 / ' + (report.counts?.ok ?? 0) + ' 绿')
console.log('')

if (!findings.length) {
  console.log('  全部通过，没有需要处理的。')
  process.exit(0)
}

for (const f of findings) {
  const mark = f.status === 'error' ? '【红】' : '【黄】'
  console.log(mark + ' ' + f.label + '   (' + f.id + ')')
  console.log('  说的是：' + (f.says || '（没给说明）'))
  if (f.means) console.log('  意思是：' + f.means)

  if (f.where.length) {
    console.log('  ★ 红在哪：')
    for (const w of f.where) {
      if (!w.exists) {
        console.log('    ' + w.path + '   —— 不存在' + (w.err ? '（' + w.err + '）' : ''))
      } else if (w.dir) {
        console.log('    ' + w.path + '   —— 目录，' + w.items.length + ' 项：' + w.items.join(', '))
      } else {
        console.log('    ' + w.path + '   —— ' + w.bytes + ' B / ' + w.lines + ' 行')
        if (w.head) for (const l of w.head.split('\n').slice(0, 5)) console.log('        │ ' + l.slice(0, 120))
      }
    }
  }
  if (f.fix.length) {
    console.log('  ★ 该做什么：')
    for (const x of f.fix) console.log('    · ' + x)
  }
  if (f.lookAt.length) {
    console.log('  ★ 去看哪：')
    for (const x of f.lookAt) console.log('    · ' + x)
  }
  if (f.evidenceKeys.length) console.log('  ★ evidence 字段：' + f.evidenceKeys.join(', '))
  console.log('')
}
