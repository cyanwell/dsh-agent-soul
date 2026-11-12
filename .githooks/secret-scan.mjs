#!/usr/bin/env node
// 提交前硬闸门：**staged 的内容里不许出现密钥**
//
// ★ 2026-11-13 立（起因）：config.json 里的明文 DeepSeek key 被提交并推到公开仓库，
//   群友从 raw.githubusercontent.com 匿名读到（HTTP 200），87 stars 的仓库。
//   那之后只能吊销 key + 洗历史 + 强推 ——**代价远大于这道闸门**。
//
// ★ 设计原则（三条，都有理由）：
//   ① **只看 staged 的内容，不看工作区** —— 我要提交什么才是问题，工作区里有 key 是正常的。
//   ② **宁可误报，不可漏报** —— 误报的代价是「加一行白名单」，漏报的代价是「吊销 key + 洗历史」。
//   ③ **不打印命中的原文** —— 只报文件、行号、模式名。日志本身也不能成为泄露渠道。
//
// 用法：git config core.hooksPath .githooks  （只需一次）
import { execSync } from 'node:child_process'

const PATTERNS = [
  { name: 'OpenAI/DeepSeek 风格 sk-', re: /sk-[A-Za-z0-9_-]{20,}/ },
  { name: 'Anthropic sk-ant-', re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{30,}/ },
  { name: 'GitHub fine-grained PAT', re: /github_pat_[A-Za-z0-9_]{50,}/ },
  { name: 'AWS Access Key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'Google API key', re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: 'Slack token', re: /xox[baprs]-[0-9A-Za-z-]{10,}/ },
  { name: '私钥块', re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  {
    name: '配置里的非空密钥字段',
    re: /["']?(api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd)["']?\s*[:=]\s*["'][^"'\s]{8,}["']/i,
  },
]

// ★ 白名单：这些是**故意的占位符**，不是真 key。
//   规则：值本身要像占位（含 xxx / your / < / example / placeholder / changeme 之类）。
const ALLOW = [
  /\bxxx+\b/i, /your[_-]?/i, /<[^>]*>/, /example/i, /placeholder/i, /changeme/i,
  /\bdpapi:/i, /\benv:/i, /\$\{/, /redacted/i, /\*{3,}/,
]

function allowed (line) {
  return ALLOW.some((re) => re.test(line))
}

function sh (cmd) {
  try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }) }
  catch { return '' }
}

const BIN = /\.(exe|dll|zip|7z|gz|png|jpg|jpeg|gif|webp|ico|nupkg|woff2?|ttf|otf|mp4|mp3|wav|sqlite|db)$/i

const files = sh('git diff --cached --name-only --diff-filter=ACMR')
  .split('\n').map((s) => s.trim()).filter(Boolean)

if (!files.length) process.exit(0)

const hits = []
for (const f of files) {
  if (BIN.test(f)) continue
  const diff = sh('git diff --cached -U0 -- "' + f.replace(/"/g, '\\"') + '"')
  if (!diff) continue
  let lineNo = 0
  for (const raw of diff.split('\n')) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw)
    if (m) { lineNo = Number(m[1]); continue }
    if (!raw.startsWith('+') || raw.startsWith('+++')) continue
    const line = raw.slice(1)
    lineNo++
    for (const p of PATTERNS) {
      if (!p.re.test(line)) continue
      if (allowed(line)) continue
      hits.push({ file: f, line: lineNo, kind: p.name })
    }
  }
}

if (!hits.length) process.exit(0)

console.error('')
console.error('  ⛔ 提交被拒：staged 内容里疑似有密钥')
console.error('')
for (const h of hits.slice(0, 20)) {
  console.error('     ' + h.file + ':' + h.line + '   ' + h.kind)
}
if (hits.length > 20) console.error('     …还有 ' + (hits.length - 20) + ' 处')
console.error('')
console.error('  为什么挡：2026-11-13 有一次 config.json 的明文 apiKey 被推到公开仓库，')
console.error('  只能靠吊销 key + 洗历史 + 强推收场。这道闸门就是为了不再来第二次。')
console.error('')
console.error('  怎么过：')
console.error('     · 真 key → 别提交。用 dpapi: / env: 引用，或写进 .env（已在 .gitignore 里）')
console.error('     · 是占位符 → 值里带 xxx / your / <...> / example / placeholder / changeme')
console.error('     · 确实要传（比如测试用假 key）→ git commit --no-verify（想清楚再用）')
console.error('')
process.exit(1)
