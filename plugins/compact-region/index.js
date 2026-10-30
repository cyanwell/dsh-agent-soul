/**
 * dsh-agent-compact-region —— 在 compaction realm 内部开一扇「能指定范围」的门。
 *
 * ════════════════ 为什么需要它 ════════════════
 *
 * `compaction` 服务被 `isolate: { compaction: true }` 关在 preset 的 realm 里
 * （`agent.cordis.yml` 的 `- id: compaction` 那一段）。而换气插件 `dsh-huanqi`
 * 挂在 profile 根层 —— cordis 的 isolate 是作用域边界，根层**看不到**子 realm 的服务。
 *
 * 2026-10-27 实测三级探测全落空：
 *   agent.ctx → agent.session.ctx → 根 ctx，三次都拿不到 `compaction`。
 * 而 isolate 删不得（硬约束，删了报 `RemoteError: Preset services require isolate realms`）。
 *
 * 于是 huanqi 退到第二条路：借 `commands` 执行 `/compact`。
 * `commands` 是**根层服务**，根层拿得到；而命令的 handler 是在 realm 内注册的，
 * 它自带 realm 内的 compaction —— 等于借道进去。这条路 2026-10-27 14:12 验通了。
 *
 * ════════════════ 那为什么还要加这一条 ════════════════
 *
 * 因为官方的 `/compact` 是**无参数**命令，而且它调的是 `compactNow`（全量）。
 * 证据（`@deepseek-ai/dsh-command-compact/lib/index.js`）：
 *   L49-52  `if (invocation.rawInput.trim().length > 0) return { kind: "error", text: USAGE }`
 *   L54     `await ctx.compaction.compactNow(invocation.agent, ...)`
 *
 * 于是换气的两条路塌成一条：
 *   · 路 B 范围压缩（`compactOnce(agent,'region')`）→ 实际做了全量，`range` 是 null
 *   · 路 C 全量压缩（`compactOnce(agent,'full')`）→ 全量，正确
 * 路 C 刚好够用，路 B 被带偏了。判据是日志里那行 `compactOnce(region) → OK range=null`。
 *
 * 本包补的就是这个缺口：注册 `/compact-region <start> <end>`，
 * 参数是 huanqi 自己算好的 seq 范围（`pickRegion()`，从末尾往前退到
 * `toolPairingBalancedBefore` 成立、保留最后一条、跳过 system 头）。
 *
 * ════════════════ 它为什么能站在这里 ════════════════
 *
 * 同一个 group 里，官方 `command-compact` 就是 `inject: ["commands","compaction"]`
 * 并成功把自己的命令注册进了根层 —— 那是**活证**：这两条服务在这个 realm 里都拿得到。
 * 本包与它完全同构，只是多给一个参数、改调 `compactRegion`。
 *
 * ════════════════ 安全阀 ════════════════
 *
 * 1. 参数不合法 → 返回 error，不猜范围。
 * 2. `compactRegion` 抛（边界不平衡 / 区间被替换 / 正在压缩）→ 返回 error，
 *    由调用方（huanqi）决定要不要降级成全量。**这里绝不自己降级** ——
 *    降级是策略，策略归 huanqi。
 * 3. 诊断写 `_plugin-diag.log`（和 huanqi 同一个文件，方便对照两条桥的先后）。
 *    诊断本身绝不抛。
 */
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-agent-compact-region'

/**
 * ★ `commands` 是根层服务（注册入口）；
 *   `compaction` 是本 realm 内的服务（真正干活的那个）。
 *   两个都要，缺一个 apply 不会被调用 —— 那会表现成「插件加载了但命令不存在」。
 */
export const inject = ['commands', 'compaction']

// ★ 诊断日志位置：优先环境变量，否则落到系统临时目录。
//   原来写死 `D:\AI\memory\hub\_plugin-diag.log` —— 那是本机路径，
//   别人装上会往一个不存在的目录写（diag 本身被 try 包住，所以失败是静默的，更难查）。
const LOG = process.env.DSH_PLUGIN_DIAG || join(tmpdir(), '_dsh-plugin-diag.log')
const USAGE = 'Usage: /compact-region <startSeq> <endSeq>'

/** 诊断写文件，不走 console.error —— 主进程的 stderr 抓不到。 */
function diag(line) {
  try {
    appendFileSync(LOG, new Date().toISOString() + ' [compact-region] ' + line + '\n')
  } catch {
    /* 诊断绝不影响主流程 */
  }
}

function describeError(err) {
  if (err instanceof Error) return err.name + ': ' + err.message
  return String(err)
}

/**
 * 解析 `<start> <end>`。
 *
 * ★ 为什么要求两个都是正整数且 `end >= start`：
 *   `compactRegion` 内部会自己做边界校验（`selectCompactableRange` 那套），
 *   但让它因为一个明显写错的参数去抛，会把「参数错误」和「区间不平衡」混成同一种失败 ——
 *   而 huanqi 要靠这个区分该不该降级。所以先在门口挡掉。
 */
function parseRange(rawInput) {
  const raw = rawInput === undefined || rawInput === null ? '' : String(rawInput)
  const parts = raw.trim().split(/\s+/).filter(function (s) { return s !== '' })
  if (parts.length !== 2) return null
  const start = Number(parts[0])
  const end = Number(parts[1])
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null
  if (start <= 0 || end <= 0 || end < start) return null
  return { start, end }
}

export function apply(ctx) {
  /* ★ 2026-10-27 22:47 启动自检：apply 到底有没有被调用。
   *
   *   查了三轮都是「纸面上全对、命令就是不出现」——包能 import、导出齐全、
   *   preset 里那行在、isolate 父链对、YAML 合法、重启了两次。只剩两种可能：
   *     ① 插件根本没被 apply（`inject` 没满足 / patch 那行没进树）
   *     ② apply 跑了，但 register 失败（服务缺失 / 用法不对）
   *   这两行的差别决定后面查哪条路，所以必须在 apply 最开头就写。
   *   ★ 若连这行都没有，就是 ① —— 那时问题不在本文件，在「它有没有被加载」。
   */
  try {
    let cn = 'n/a'
    let cp = 'n/a'
    try {
      const c = ctx.get('commands')
      cn = c === undefined ? 'undefined' : 'execute=' + typeof c.execute
    } catch (e) { cn = 'threw:' + describeError(e) }
    try {
      const c = ctx.get('compaction')
      cp = c === undefined ? 'undefined' : 'compactRegion=' + typeof c.compactRegion
    } catch (e) { cp = 'threw:' + describeError(e) }
    diag('★ apply() 被调用 · commands[' + cn + '] · compaction[' + cp + ']')
  } catch { /* 自检绝不影响主流程 */ }

  /** 取 compaction 服务 —— 与 huanqi 那边同样的双保险（属性访问可能不存在或抛）。 */
  function compactionService() {
    try {
      const got = ctx.get('compaction')
      if (got !== undefined && got !== null) return got
    } catch {
      /* 退到属性访问 */
    }
    try {
      const got = ctx.compaction
      if (got !== undefined && got !== null) return got
    } catch {
      /* 两条都不行就是真没有 */
    }
    return undefined
  }

  const handler = async (invocation) => {
    const range = parseRange(invocation.rawInput)
    if (range === null) {
      diag('参数无法解析: ' + JSON.stringify(String(invocation.rawInput)))
      return { kind: 'error', text: USAGE }
    }

    const svc = compactionService()
    if (svc === undefined || typeof svc.compactRegion !== 'function') {
      diag('compaction 服务或 compactRegion 不可用（服务名或签名变了？）')
      return { kind: 'error', text: 'compaction service unavailable in this realm' }
    }

    const agent = invocation.agent
    if (agent === undefined || agent === null || agent.session === undefined || agent.session === null) {
      diag('invocation.agent 不可用')
      return { kind: 'error', text: 'no agent session for region compaction' }
    }

    /* ★ 和 huanqi 里构造的 `manualCtx` 同形 —— `compactRegion` 要的是
     *   `ManualCompactAgentContext`（`session` + `runMaintenance`）。
     *   官方 `/compact` 直接把 `invocation.agent` 传给 `compactNow`，
     *   说明 Agent 结构上就满足；这里显式构造一层，是为了不依赖那个巧合。 */
    const manualCtx = {
      session: agent.session,
      options: {},
      runMaintenance: (task) => agent.runMaintenance(task),
    }

    const span = range.start + '–' + range.end
    try {
      const result = await svc.compactRegion(range.start, range.end, manualCtx, invocation.signal)
      /* ★★★ 2026-10-27 23:40 —— **界面那条提示的开关就是这一个字段。**
       *
       *   现象：部分压缩执行成功、会话里四件套事件都写了，界面上一个字都没有；
       *         而官方 `/compact` 压完有 `· compact · 已压缩 N 条历史记录（约 X tokens）`。
       *
       *   原因（一手对照，`@deepseek-ai/dsh-command-compact/lib/index.js` 的 executeCompact）：
       *     return {
       *       kind: 'success',
       *       text: `Compacted ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens).`,
       *       sourceEventSeq: result.summarySeq,        ← ★ 就这一行
       *     }
       *   前端拿 `command/done.sourceEventSeq` 去关联 `compaction/summary` 事件，
       *   关联上了才渲染那条提示（`dsh-client-ui-chat/lib/client.js`）。
       *   本文件原来 return 时没带它 → 前端找不到 summary → **压缩成功也没有提示**。
       *
       *   为什么拿得到 summarySeq：`compactRegion` 和 `compactNow` 都是
       *     `return compactSurfaceRegion(...)`（`dsh-compaction-basic/lib/index.js:930-935 / 953-960`），
       *   返回的就是同一个成功结果对象，字段同构。
       *
       *   ★ 不猜字段：拿不到就交 undefined（等于不关联），绝不让诊断把主流程带崩。
       */
      const resultSeqs = result === null || result === undefined ? undefined : result.shadowedSeqs
      const n = Array.isArray(resultSeqs) ? String(resultSeqs.length) : '?'
      const tok = result === null || result === undefined ? '?' : String(result.shadowedTokenCount)
      const summarySeq = result === null || result === undefined ? undefined : result.summarySeq
      diag('compactRegion(' + span + ') → OK n=' + n + ' tok=' + tok + ' summarySeq=' + String(summarySeq))
      return {
        kind: 'success',
        text: 'Compacted ' + n + ' history items (~' + tok + ' tokens).',
        sourceEventSeq: summarySeq,
      }
    } catch (err) {
      diag('compactRegion(' + span + ') → FAILED: ' + describeError(err))
      return { kind: 'error', text: 'region compaction failed: ' + describeError(err) }
    }
  }

  ctx.effect(function* () {
    try {
      yield ctx.commands.register({
        name: 'compact-region',
        description: 'Compact one seq range of older history (used by dsh-huanqi)',
        handler,
      })
      diag('★ /compact-region 注册成功')
    } catch (err) {
      diag('✗ /compact-region 注册失败: ' + describeError(err))
      throw err
    }
  }, 'compact-region lifecycle')
}
