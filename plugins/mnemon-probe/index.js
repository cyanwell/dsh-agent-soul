// dsh-agent-mnemon-probe —— 热记忆投影探针（宿主半，无客户端半）
//
// 干什么：每一个 model step 组装 system prompt 时，读一次热记忆文件，
//   把「磁盘上有几条 / 多少字节 / 占预算多少」作为一条 context 挂进去。
//   于是**每一轮我都能看到**，不必主动去查 —— 接近上限时它自己会喊。
//
// ★ 为什么需要它：「投影省略」是静默的。MEMORY.md 有 10KB 预算，满了以后
//   **条目仍留在磁盘上，但不再进入上下文** —— 丢的从来不是内容，是「内容存在过」这条线索。
//   实测过一次：标称 13 条 8,990 B，实际只进来 5 条。
//
// ★★ 它**做不到**的那一半（说清，免得后人以为是 bug）：
//   「Mnemon 实际注入了几条」拿不到。实测扫过 assembly 的 **26 个 sections + 3 个 contexts**，
//   里面**没有** `<runtime-memory-file>` —— 热记忆不走 system prompt，它是**每轮作为消息注入**的。
//   所以这一列只能由模型自己数（比对注解里的 entries="N" 与正文实际条数）。
//   ★ 换成正则去扫会话消息可以做，但那要 agent/session 服务、代价大得多，暂不做。
//
// 前置：热记忆的真实路径通常**不在** DSH_HOME 下（本项目找错过一次，所以做成可配的）一次）。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// ★ 热记忆目录 —— 通常不在 DSH_HOME 下，所以做成可配的。
const RUNTIME = process.env.MNEMON_RUNTIME || path.join(os.homedir(), '.mnemon', 'runtime')

export const name = 'dsh-agent-mnemon-probe'
export const inject = ['systemPrompt']

const FILES = [
  { key: 'MEMORY.md', path: path.join(RUNTIME, 'MEMORY.md'), cap: 10240 },
  { key: 'USER.md', path: path.join(RUNTIME, 'USER.md'), cap: 4096 },
]

// 「几条」= 用 § 分隔符数非空段。
function countEntries(raw) {
  const body = String(raw === undefined || raw === null ? '' : raw)
  if (body.trim().length === 0) return 0
  return body.split(/\n\s*§\s*\n/).filter((s) => s.trim().length > 0).length
}

function readDisk() {
  const out = {}
  for (const f of FILES) {
    try {
      const text = fs.readFileSync(f.path, 'utf8')
      out[f.key] = { entries: countEntries(text), bytes: Buffer.byteLength(text, 'utf8'), cap: f.cap }
    } catch (e) {
      out[f.key] = { error: String((e && e.message) || e).slice(0, 100), cap: f.cap }
    }
  }
  return out
}

function render() {
  const disk = readDisk()
  const parts = []
  let hot = false
  for (const f of FILES) {
    const d = disk[f.key]
    const short = f.key.replace('.md', '')
    if (!d || d.error) {
      parts.push(short + ' 读盘失败(' + (d ? d.error : '?') + ')')
      hot = true
      continue
    }
    const pct = Math.round((d.bytes / d.cap) * 100)
    const tag = pct >= 90 ? '★已到上限' : pct >= 80 ? '⚠接近上限' : '宽裕'
    if (pct >= 80) hot = true
    parts.push(short + ' ' + d.entries + '条/' + (d.bytes / 1024).toFixed(1) + 'KB(' + pct + '%) ' + tag)
  }
  const lines = ['[MNEMON 探针 v0.1] ' + parts.join('　｜　')]
  lines.push(hot
    ? '  ★ 接近/到达上限 —— 想加新条目前先精简（优先砍"孤立、且能指向别的文件"的描述）。跑 `python <你的记忆工具目录>/mem-doctor.py` 看全貌。'
    : '  磁盘没问题。')
  lines.push('  注：「实际注入几条」探针拿不到 —— 热记忆不走 system prompt。自己数：比对本轮 entries="N" 与正文实际条数。')
  return lines.join('\n')
}

export function apply(ctx) {
  ctx.on('system-prompt/assemble', async (assembly, assembleContext, next) => {
    const out = await next()
    try {
      /* ★★★ 2026-10-30 修「探针逐字重复」（GitHub #22）：
       *
       * 原来是无条件 `concat([{ name: 'mnemon-projection-probe' ... }])`。
       * 只要这个 assemble 钩子在同一条链上被走到两次，就会追加两份 ——
       * 而实测它确实会走到两次（system prompt 的装配不只有一个阶段）。
       * 于是每轮白白多花约 300 token，且**一模一样的两块连着出现**，
       * 看起来像坏了，实际是重复注入。
       *
       * ⇒ 做幂等：**追加前先剔掉同名 context**，无论走到几次，最终只留一份。
       *   判据用 `name`（这是我们自己起的名字，宿主不会占用）。
       *   ★ 之所以不改成「只走第一次」：那样要引入状态，而状态会和热重载打架；
       *     幂等是**无状态的**，重排、重入、多阶段都不影响结果。
       */
      const NAME = 'mnemon-projection-probe'
      out.contexts = (Array.isArray(out.contexts) ? out.contexts : [])
        .filter((c) => !(c && c.name === NAME))
        .concat([{ name: NAME, text: render() }])
    } catch (e) {
      console.error('[dsh-agent-mnemon-probe] assemble hook failed: ' + String((e && e.message) || e))
    }
    return out
  })
}
