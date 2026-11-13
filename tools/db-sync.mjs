// db-sync —— 把 v4 会话帧灌进索引（② 的接线，**真增量**）
// ============================================================================
// ★ 增量怎么做：v4 的 frames.jsonl 是**只追加**的，所以「读到第几行」就是最好的游标。
//   游标存在 data/index-cursors.json：{ [sessionId]: { lines: N, mtime } }
//   ★ 为什么不用 sync_cursors 表：那是给「偏移续读二进制流」设计的（tailOffset/tailState/
//     streamFingerprint），而这里是纯文本行。用行号更简单，也不会被指纹校验卡住。
//   ★ 文件变短了（被截断/重建）→ 从头读，并把游标清零。
//
// 用法：
//   node tools/db-sync.mjs            # 全量（首次或重建）
//   node tools/db-sync.mjs --incr     # 增量（只读新行）
//   node tools/db-sync.mjs --limit=3  # 只处理前 3 个会话（调试）
// ============================================================================
import fs from 'node:fs'
import path from 'node:path'
import { openMetaStore, V4_NAMESPACE } from '../src/db/index.mjs'
import { loadConfig, ROOT as REPO_ROOT } from '../src/config.mjs'

// ★★★ 2026-11-13 修（群友的品鉴报告指出，P0-1）：这里原来写死
//   `C:/Users/pc/Desktop/deepseek harness/agent soul/data` —— 我自己的机器路径。
//
//   后果比看起来严重：**别人机器上全新安装，检索 100% 不可用。**
//     /api/search 依赖 <dataDir>/meta.sqlite；
//     而那个库只有这个脚本会建；
//     脚本读死路径 → SQLITE_CANTOPEN → 库永远不存在 → 检索永远 503。
//
//   ★ 而 README 写着「索引在写入时产生」—— 用户会以为是索引机制坏了。
//     实际上索引机制是对的，是「建库的那只手」找不到地方。
//
//   现在：走 loadConfig()，和 core 读同一份配置（也就不可能再读岔）。
const CFG = (() => {
  try { return loadConfig() } catch (e) { return null }
})()
const DATA_DIR = (() => {
  const d = (CFG && CFG.dataDir) || 'data'
  return path.isAbsolute(d) ? d : path.join(REPO_ROOT, d)
})()
const ROOT = DATA_DIR
const SESS = path.join(ROOT, 'sessions')

// ★ 2026-11-12 爀曦定：库挪到统一记忆库（00-记忆库）。路径从 config.json 的 memory 段读，
//   **不再写死 data/** —— 否则这个脚本会往旧位置建一个新库，
//   而 core 读的是新位置，于是「索引看着建了、检索却是空的」。
const MEM = (() => {
  try {
    // ★★★ 2026-11-13 修：这里原来是 `const fs = require('node:fs')` ——
    //   **ESM 里没有 require**，抛 ReferenceError 被 catch 吞掉 → 静默退回 data/meta.sqlite。
    //   后果：db-sync 往 data/ 建了个 152MB 的新库，而 core 读的是 00-记忆库 那份（135MB，
    //   停在 08:11）—— **「索引看着建了，检索却是空的」**，和注释里警告的一模一样。
    //   顶部已经 import fs，直接用它。
    // ★ 同一个病：cfgPath 也写死过。现在直接用 loadConfig 的结果（上面已经读好了）。
    const cfgPath = path.join(REPO_ROOT, 'config.json')
    const cfg = CFG || JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    const m = cfg.memory || {}
    if (m.libraryDir) {
      return { db: path.join(m.libraryDir, m.indexFile || 'meta.sqlite'), cursors: path.join(m.libraryDir, m.cursorsFile || 'index-cursors.json') }
    }
  } catch (e) {}
  return { db: path.join(ROOT, 'meta.sqlite'), cursors: path.join(ROOT, 'index-cursors.json') }
})()
const DB = MEM.db
const CURSORS = MEM.cursors

const args = process.argv.slice(2)
const INCR = args.includes('--incr')
const LIMIT = Number((args.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || 0

const store = openMetaStore({ path: DB, mode: 'readwrite' })
store.migrate()

const source = {
  sourceId: 'v4-self',
  // ★ kind 只有两个合法值：dsh-log（DSH 原文）/ v4-mirror（v4 镜像）。
  //   写 'v4-session' 会让每一帧都抛 invalid source.kind —— 看起来像"每帧都有问题"。
  kind: 'v4-mirror',
  namespace: V4_NAMESPACE,
  authority: 'mirror',
  rawPath: SESS,
  pathKind: 'dir',
}

let cursors = {}
try { cursors = JSON.parse(fs.readFileSync(CURSORS, 'utf8')) } catch (e) { cursors = {} }

let ingested = 0, skipped = 0, failed = 0, touched = 0
const dirs = fs.readdirSync(SESS, { withFileTypes: true }).filter((d) => d.isDirectory()).slice(0, LIMIT || undefined)

for (const d of dirs) {
  const f = path.join(SESS, d.name, 'frames.jsonl')
  if (!fs.existsSync(f)) continue
  const st = fs.statSync(f)
  const cur = cursors[d.name]
  // ★ 增量：文件没变就跳过（mtime 相同 = 没新行）
  if (INCR && cur && cur.mtime === st.mtimeMs) continue
  // ★ 文件变短 → 游标失效，从头读
  const startLine = (INCR && cur && cur.lines >= 0 && st.size >= (cur.size || 0)) ? cur.lines : 0

  const text = fs.readFileSync(f, 'utf8')
  const lines = text.split('\n')
  // 末行可能是半行（正在写）——只处理到最后一个换行
  const complete = text.endsWith('\n') ? lines.length - 1 : lines.length - 1
  if (complete <= startLine) { cursors[d.name] = { lines: complete, mtime: st.mtimeMs, size: st.size }; continue }

  let ordinal = 0
  for (let i = 0; i < complete; i++) {
    const line = lines[i]
    if (!line) { ordinal++; continue }
    if (i < startLine) { ordinal++; continue }
    let rec = null
    try { rec = JSON.parse(line) } catch { failed++; ordinal++; continue }
    if (!rec || typeof rec.seq !== 'number') { failed++; ordinal++; continue }
    if (rec.type === 'session') { ordinal++; continue }   // header 不是内容
    const t = typeof rec.text === 'string' ? rec.text : ''
    if (!t) { skipped++; ordinal++; continue }
    try {
      store.ingest({
        source,
        session: { sessionId: d.name, containerId: null },
        frame: {
          seq: rec.seq,
          frameOrdinal: ordinal,
          rawPath: f,           // 必须在 source.rawPath 之下
          text: t,
          type: String(rec.type || 'unknown').slice(0, 64),
          eventAt: rec.t ? new Date(rec.t).toISOString() : null,
        },
      })
      ingested++
    } catch (e) {
      failed++
      if (failed <= 3) console.log('  失败: ' + String((e && e.message) || e).slice(0, 150))
    }
    ordinal++
  }
  cursors[d.name] = { lines: complete, mtime: st.mtimeMs, size: st.size }
  touched++
}

fs.writeFileSync(CURSORS, JSON.stringify(cursors), 'utf8')

const t0 = Date.now()
console.log((INCR ? '[增量] ' : '[全量] ') + '会话 ' + dirs.length + ' · 有变化 ' + touched +
  ' · 入库 ' + ingested + ' · 跳过 ' + skipped + ' · 失败 ' + failed +
  ' · 库 ' + Math.round(fs.statSync(DB).size / 1024 / 1024) + 'MB')
store.close()
