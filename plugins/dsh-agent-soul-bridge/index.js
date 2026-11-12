/**
 * dsh-agent-soul-bridge —— v4 控制通道的**宿主端**。
 *
 * ── 它是什么 ─────────────────────────────────────────────────────────
 * agent-soul v4 有两条腿：① MCP server（宿主调它）② **控制通道 WS**（它主动推指令给宿主）。
 * 本插件接的是第 ②。它做四件事：
 *   1. 连 ws://127.0.0.1:7310/control，连上第一件事发 hello **自报能力**；
 *   2. 处理 v4 推来的 exec，**每条都必须回 result**（不回的话 v4 那边 15 秒超时）；
 *   3. 每轮上报 state（上下文水位），供 v4 做「思考退化检测」；
 *   4. 断线指数退避重连（1s → 2s → 4s → … → 30s 上限），**日志不刷屏**。
 *
 * ── 为什么第一件事是自报能力，而不是告诉 v4「dsh 是什么」 ──────────────
 * v4 的设计原则是「**v4 认识能力，不认识宿主**」：它说「有人会换气吗」，谁举手谁执行。
 * 所以 hello 里给的是 caps，不是能力介绍信。协议源码见 D:\AI\agent-soul\src\control\hub.mjs
 * （那里一句话写死了：「v4 的主程序里一次都不该出现 'dsh' 这个词」）。
 *
 * ── 三条诚实纪律（写死在代码里，别改） ─────────────────────────────────
 * ① **桩就是桩。** huanqi / pruner 目前只报能力、不干活，exec 进来一律回 ok:false 并说明原因。
 *    在 hello 的 meta.stubs 里**主动声明**这两个是桩 —— 让 v4 知道，而不是等它撞墙。
 *    ★ 2026-11-10 评估过 pruner 能不能接真（结论：接不了，见 PRUNER_GAP 与
 *    _verify/pruner-eval/EVALUATION.md）。所以这里回的还是 ok:false，只是回得**更具体**：
 *    缺哪个参数、缺口在哪、不会拿默认会话兜底 —— 一句话能看出卡在哪。
 * ② **拿不到的水位不许编。** contextTokens 只认真水位（projectedTokens / pressureTokens）。
 *    拿不到就报 null + 一句 reason；tokenMeter 的 surfaceTokens 是「可见消息面」不是水位，
 *    只能单独放在 surfaceTokens 字段里，绝不冒充 contextTokens。
 * ③ **回执必达。** 任何异常路径都走 sendResult(ok:false)，绝不静默吞掉一条 exec。
 *
 * ── 零第三方依赖 ─────────────────────────────────────────────────────
 * 只用 node: 内置。WS 客户端自己写在 ws.js（v4 那边整条链也是零依赖，这条要一起守）。
 *
 * 服务依赖（全部用 ctx.get 软取，缺了只降级不崩）：
 *   agents              叫醒会话，followup 需要它
 *   systemPrompt        每轮一次的钩子（借它报 state；**不注入任何文字**）
 *   sessionProjections  读真水位（首选）
 *   tokenMeter          读面值（次选，只做参考）
 */

import process from 'node:process'
import fs from 'node:fs'
import path from 'node:path'

import { connectWs } from './ws.js'
import { runTargetedCleanup } from './pruner-adapter.mjs'
// ★ 2026-11-13：上下文手术刀 —— 不依赖 DSH 的 pruner，直接用 Session API 公开原语。
import { makeContextSurgeon, purgeMany } from './context-surgeon.mjs'

export const name = 'dsh-agent-soul-bridge'

// ★ 2026-11-13：版本号加标记 —— 用来做**决定性实验**：
//   v4 的 /api/session 会吐出 meta.version。
//   重启 DSH 后如果看到 '0.1.1-context' → 加载了新代码（问题在别处）；
//   如果还是 '0.1.0' → **DSH 没读这个文件**（这才是真因）。
const VERSION = '0.1.1-context'
const TAG = '[agent-soul-bridge]'

export const DEFAULTS = {
  /** 控制通道端点（协议已冻结，见 agent-soul 的 src/control/） */
  url: 'ws://127.0.0.1:7310/control',
  /** hello 里的 host 名。v4 用它区分宿主，不参与路由 */
  hostName: 'dsh',
  /** ★ 自报的能力。谁举手谁执行 —— 报了就代表「这条 exec 我接得住」 */
  // ★ 2026-11-12：加 session —— v4 要能「往指定会话说一句话 / 插一句 / 开一个新会话」。
  // ★★ 2026-11-12 深夜订正：这里原本写着「resolve 不在这里，v4 自己读 aurabot 的 sessions.json」。
  //   那句话在「v4 要发布给别人用」这个前提下是错的 ——
  //   · 那张表是 **aurabot 的私有数据**：别人的机器上未必有 aurabot，v4 去读它
  //     = 跨应用硬编码别家的目录，而且失败的样子很隐蔽（读不到 → 空表 → 像"没配好"）；
  //   · 而 chatId → sessionId 本来就是 **DSH 侧的知识**，它属于适配层，不属于独立调度器。
  //   （上面原来还写着「宿主做不了持久映射」——宿主的 import fs 就在第 39 行，那是假的。）
  //   所以 resolve 现在归这里：读表、只查映射、**不验活**（验活是 followup 的事）。
  // ★ 2026-11-13 加 'context'：上下文手术（对 surface 动刀，不依赖 DSH 的 pruner）。
  //   ★ 它**不进 stubCaps** —— 它是有真实现的，不是桩。
  caps: ['followup', 'session', 'huanqi', 'pruner', 'context'],
  /**
   * chatId → sessionId 映射表的位置（aurabot 的 sessions.json）。
   * 空 = 按 <DSH_HOME>/plugins-data/aurabot/sessions.json 自动找。
   * ★ 留这个口，是为了「aurabot 装在别处 / 将来换了别的会话映射来源」时不必改代码。
   */
  sessionsFile: '',
  /** ★ 只举手不干活的那些（会原样写进 hello.meta.stubs，别偷偷藏） */
  stubCaps: ['huanqi', 'pruner'],
  /**
   * ★ 2026-11-11：「定点清理」的同步实现已经在 dsh-yanqing-pruner 里落地
   *   （applyDrops，复用官方 pruneSession 的落盘原语），本桥也写了薄适配
   *   （pruner-adapter.mjs）。但**默认仍然关着**，原因只有一条：
   *   这条链还没在真实会话上跑过 —— 拿不到活 pruner 实例时它会报 no-pruner，
   *   而「能不能拿到」取决于 realm 可见性，那个前提没有实测证据。
   *
   * ★ 开它的顺序（写死在 README 的「部署」一节里）：
   *   ① 先只把本开关设 true（stubCaps 仍含 pruner，hub 不会派活）；
   *   ② 用一个**非生产**会话手工 exec 一次，看回执是不是 ok:true 且 framesAffected ≥ 0；
   *   ③ 再删掉 stubCaps 里的 'pruner'，才轮到 v4 真派活。
   * ★ 开关关着时行为与 11-10 完全一致：回 ok:false + 缺口说明（不是静默失败）。
   */
  prunerLive: false,
  /** 退避：1s → 2s → 4s → 8s → 16s → 30s → 30s … */
  reconnectMinMs: 1000,
  reconnectMaxMs: 30000,
  reconnectFactor: 2,
  /** 心跳：服务端会把 0x9 回成 0xA。0 = 关掉 */
  pingMs: 25000,
  /** 每轮上报 state（借 systemPrompt 的 render 当钩子） */
  statePerTurn: true,
  /** state 最短间隔，防一轮多步时抖成刷屏 */
  stateMinGapMs: 800,
  /** followup 默认投给谁；空 = 自动挑一个 live root agent */
  defaultSessionId: '',
  /** 上下文窗口的兜底值（真值优先从 contextPressure.contextWindow 读）。本机实测 1048576 */
  contextWindowFallback: 1048576,
  /** 记忆落盘的投影缓存目录（读水位第三兜底，不依赖任何 ctx 服务） */
  projCacheDir: 'D:/AI/dsh/home/storages/session_projcache/sessions',
  /** followup 的 source.kind，便于在会话日志里认出是谁叫醒的 */
  // ★★ 2026-11-12（爀曦提的）：投递消息的来源要**一眼看出来自 v4**。
  //   DSH 那边只显示「收到执行请求」，看不出是谁发起的 ——
  //   于是「v4 到底有没有生效」只能靠翻日志。
  //   source.kind 是结构化字段，改它不污染正文；配合 via 一起看：
  //     kind = agent-soul-v4  → 走的是 v4 调度
  //     kind = user / plugin:xxx → 别的路
  followupSource: 'agent-soul-v4',
  log: true,
}

// ─────────────── pruner：为什么它还是桩（2026-11-10 评估） ───────────────
//
// ★ 别再从头查一遍，结论与判据都在这儿（一手，全部读源码/inspect 得来）：
//
//   ① 宿主的裁剪服务只有一个入口是「按会话整扫」：
//        toolResultPruner.measureContent / pruneContent / pruneSession(session)
//        —— 出处：@deepseek-ai/dsh-compaction-tool-result-pruner 0.1.5-rc.2
//           lib/types/index.d.ts:19-51；lib/index.js:137-180
//        pruneSession 的**选目标规则是字符预算**（谁超 8192 code point 裁谁），
//        它**不接受 seq 范围、不接受点名列表、也不接受 opId**。
//   ② Session 的 surface 操作只有两种：
//        SurfaceOp = 'append' | { op: 'replace', startSeq, endSeq }
//        —— **没有 remove/drop**。也就是说「把一段帧拿掉」这件事在协议层不存在，
//        唯一的「范围级」改写是 compaction.compactRegion(start,end,...)：
//        它把整段换成**一条 LLM 摘要**（语义是压缩，不是裁剪），要活着的 Agent、
//        要模型调用，而且它住在 preset 的 compaction 隔离组里（yanqing 的
//        agent.cordis.yml 那个 group，isolate:{compaction:true}）——
//        本桥挂在 profile 根层，够不到那个 realm。
//   ③ 本机确实有「点名剪某条 tool/result」的真本事，但它在 dsh-yanqing-pruner 里，
//        形态是**指令文件 + 该 agent 下一次 agent/pre-step 时执行**（index.js:480 那个
//        ctx.on('agent/pre-step')，指令 schema {id,action:'drop',session,seq,why}，
//        执行结果写回执文件）。它是**异步**的：桥这边回不回得出 framesAffected，
//        取决于那个会话下一轮跑不跑 —— 拿这个冒充「现在已清理 N 帧」就是伪成功。
//
// ★ 所以本桥**不自己拼 compaction/prune + surfaceOp.replace**（那是把 pruner 的策略
//   抄一份到桥里：门牌、影子定价、tool-pair 平衡、replay 语义全要跟着漂）。
//   最小缺口与推荐接点写在 _verify/pruner-eval/EVALUATION.md §四。
export const PRUNER_CAP = 'pruner'
export const PRUNER_ACTION = 'targeted-cleanup'

/** ★ 一句话缺口（写进回执的 error 里，v4 那边一眼能看出卡在哪一层）。 */
export const PRUNER_GAP = '宿主的 toolResultPruner 只有 measureContent/pruneContent/pruneSession(session)（'
  + '@deepseek-ai/dsh-compaction-tool-result-pruner 0.1.5-rc.2 lib/types/index.d.ts:19-51）——'
  + '选目标靠字符预算整会话扫，没有「按 seq 范围点名」的入口；Session 的 SurfaceOp 只有 '
  + "append 与 {op:'replace',startSeq,endSeq}，没有 remove。不自造改写就做不出定点清理"

const toInt = (v) => {
  if (v === null || v === undefined || v === '') return NaN
  const n = Number(v)
  return Number.isInteger(n) ? n : NaN
}

/**
 * 把一次 pruner 请求翻译成「能不能落地 + 缺什么」。
 *
 * ★ 纯函数、不碰 ctx —— 为了**能测**（同 readUsageFromFile 的教训：测的必须是我改的那个东西）。
 * ★ 只认**显式** sessionId：本函数里没有 defaultSessionId、没有 roots[0]、
 *   没有「挑一个最近的会话凑数」。缺就报缺，让 v4 那边看见是自己没给。
 */
export function describePrunerRequest (args) {
  const a = (args && typeof args === 'object') ? args : {}
  const sid = String(a.sessionId ?? '').trim()
  const tgt = String(a.targetSession ?? '').trim()
  const opId = String(a.opId ?? '').trim()
  const startSeq = toInt(a.startSeq)
  const endSeq = toInt(a.endSeq)
  const problems = []

  if (!sid) problems.push('缺 args.sessionId（本宿主不挑默认会话兜底，禁止 roots[0]）')
  if (tgt && sid && tgt !== sid) problems.push('args.targetSession(' + tgt + ') 与 args.sessionId(' + sid + ') 不一致 —— 不替你选一个')
  if (!Number.isInteger(startSeq)) problems.push('args.startSeq 不是整数（拿到 ' + JSON.stringify(a.startSeq ?? null) + '）')
  if (!Number.isInteger(endSeq)) problems.push('args.endSeq 不是整数（拿到 ' + JSON.stringify(a.endSeq ?? null) + '）')
  if (Number.isInteger(startSeq) && Number.isInteger(endSeq) && startSeq > endSeq) {
    problems.push('startSeq > endSeq（' + startSeq + ' > ' + endSeq + '）')
  }
  if (!opId) problems.push('缺 args.opId（v4 生成的请求号，回执要原样带回；宿主不许自己编一个）')

  return {
    ok: problems.length === 0,
    problems,
    echo: {
      sessionId: sid || null,
      targetSession: tgt || null,
      startSeq: Number.isInteger(startSeq) ? startSeq : null,
      endSeq: Number.isInteger(endSeq) ? endSeq : null,
      opId: opId || null,
    },
  }
}

/** 桩的回执文案：请求原样回显 + 缺什么 + 缺口在哪。单行（v4 把 error 当一行读）。 */
export function prunerRefusalMessage (args, action) {
  const d = describePrunerRequest(args)
  const e = d.echo
  const head = '未实现（桩）：' + (action ? PRUNER_CAP + '/' + action : PRUNER_CAP) + ' 没有可执行的宿主实现'
  const req = '请求会话=' + (e.sessionId || '（缺）')
    + ' seq=' + (e.startSeq === null ? '?' : e.startSeq) + '–' + (e.endSeq === null ? '?' : e.endSeq)
    + ' opId=' + (e.opId || '（缺）')
  const bad = d.problems.length ? '｜请求不合法：' + d.problems.join('；') : '｜请求合法，卡在宿主能力'
  return head + '｜' + req + bad + '｜缺口：' + PRUNER_GAP + '｜本宿主已在 hello.meta.stubs 里声明 pruner'
}

// ─────────── exec 失败：把 stage 带回线上（F1，2026-11-11） ───────────
/**
 * ★ 缺陷（复核 F1）：线上 result 帧原来只有一句 error 字符串，stage 只活在进程内 ——
 *   v4 的 stageOfError() 只认 timeout / 「宿主不在 / 没有能力」，其余一律记
 *   transport-error，排障时分不清「没目标」和「拿不到 pruner」。
 *
 * ★ 现在的口径（稳定、可解析、封闭词表）：
 *   result.ok=false 时必然带 `error: '[stage:<code>] <一句话原因>'`，
 *   并在帧上额外给结构化字段 `stage: '<code>'`（向前兼容：只读 error 的消费方也能正则解析）。
 *   code 只取 [a-z][a-z0-9-]{0,39}：优先用适配器 e.stage 自报的
 *   （no-target / no-pruner / no-session / target-mismatch / bad-request / opid-reused /
 *    prune-threw / no-agents …），取不到才用下面的兜底映射
 *   （stub / timeout / no-host / host-error）。
 *
 * ★ 不泄露秘密：错误正文只保留一行、压掉换行、把 token/secret/password/api_key/
 *   cookie/authorization 这类键值对隐去，并截断到 500 字符；请求参数本身不回显。
 */
const STAGE_RE = /^[a-z][a-z0-9-]{0,39}$/
const SECRET_RE = /\b(token|secret|password|passwd|api[_-]?key|cookie|authorization)\b\s*[=:]\s*[^\s,;，；）)]+/gi

/** 隐去可能被顺手打进错误正文的凭据键值对。导出来，测试直接核。 */
export function redactSecrets (s) {
  return String(s ?? '').replace(SECRET_RE, '$1=…（已隐去）')
}

/** 从异常里取机器可读的 stage：宿主自报优先，文本启发式只做兜底。 */
export function execStageOf (e) {
  const own = e && typeof e.stage === 'string' ? e.stage.trim() : ''
  if (STAGE_RE.test(own)) return own
  if (e && e.hint === 'stub_declared') return 'stub'
  const msg = String((e && e.message) || e || '')
  // 桩态：prunerRefusalMessage / huanqi 桩都以「未实现」起头（这是它们唯一的稳定共同点）
  if (/^未实现（桩）|^未实现：/.test(msg)) return 'stub'
  if (/超时|timeout/i.test(msg)) return 'timeout'
  if (/宿主不在|没有能力/.test(msg)) return 'no-host'
  return 'host-error'
}

/** 失败回执的线上形状：{ stage, error } —— error 的第一段就是 [stage:code]。 */
export function execFailure (e) {
  const stage = execStageOf(e)
  const one = redactSecrets(String((e && e.message) || e || '未知错误'))
    .replace(/[\r\n]+/g, ' ')
    .trim()
  return { stage, error: '[stage:' + stage + '] ' + one.slice(0, 500) }
}

/** 带 stage 的拒绝 —— runExec 内部用（适配器的 stageError 在 pruner-adapter.mjs）。 */
function execError (stage, msg) {
  const e = new Error(msg)
  e.stage = stage
  return e
}

// ─────────────────────────── 小工具 ───────────────────────────

function fmtMs (ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?'
  if (ms < 1000) return Math.round(ms) + 'ms'
  if (ms < 60000) return (ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1) + 's'
  return Math.round(ms / 60000) + 'min'
}

function shortId (id) {
  const s = String(id || '')
  return s.length > 12 ? s.slice(0, 8) + '…' : s
}

// ─────────────────────────── 插件本体 ───────────────────────────

export function apply (ctx, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) }
  if (cfg.enabled === false) return

  const log = (m) => { if (cfg.log !== false) console.log(TAG + ' ' + m) }
  const warn = (m) => { if (cfg.log !== false) console.warn(TAG + ' ' + m) }

  const st = {
    ws: null,
    connected: false,
    helloed: false,
    hostId: '',          // v4 给的 welcome.id
    attempts: 0,         // 本轮掉线后已重试次数（连上就清零）
    delay: cfg.reconnectMinMs,
    downSince: 0,
    loggedCap: false,
    retryTimer: null,
    pingTimer: null,
    step: 0,
    lastUsageStep: -1,      // ★ 上次报出去的 step —— 用来防重复计 outputTokens
    lastUsageSource: null,
    lastStateAt: 0,
    lastWatermarkSource: 'unavailable',
  }
  let disposed = false

  // ── 水位：只认真水位 ─────────────────────────────────────────
  //
  // ★ 口径来自 AGENTS.md（2026-09-27 那次复盘）：**真水位 = inputTokens + cacheReadTokens**，
  //   投影缓存里它叫 pressureTokens；引擎的 resolveTokenCount 首选 projectedTokens（它的外推）。
  //   surfaceTokens 只是「可见消息面」，**不是同一把尺子** —— 2026-09-27 实测差 270K。
  // ★ 三条来源都 try/catch 包死：读水位这件事任何情况下都不许影响对话。
  function readWatermark (agent) {
    const session = agent && agent.session
    if (!session) {
      return { tokens: null, window: null, source: 'unavailable', reason: '拿不到：宿主此刻没有活动会话（agent.session 为空）' }
    }

    // ① 投影服务（首选，与引擎同源）
    try {
      const sp = ctx.get('sessionProjections')
      if (sp && typeof sp.snapshot === 'function') {
        const snap = sp.snapshot(session)
        const cp = snap && snap.values && snap.values.contextPressure
        if (cp) {
          const n = Number(cp.projectedTokens || cp.pressureTokens || 0)
          const w = Number(cp.contextWindow || 0)
          if (n > 0) return { tokens: n, window: w > 0 ? w : null, source: 'sessionProjections.contextPressure' }
        }
      }
    } catch { /* 换下一种来源 */ }

    // ② 投影缓存文件（不依赖任何 ctx 服务；按 mtime 缓存，别每轮 parse 1.6MB）
    try {
      const sid = String(session.id || '')
      if (sid) {
        const f = String(cfg.projCacheDir || '').replace(/\\/g, '/').replace(/\/+$/, '') + '/session-' + sid + '.json'
        const stat = fs.statSync(f)
        const key = sid + ':' + stat.mtimeMs + ':' + stat.size
        if (readWatermark._k !== key) {
          const j = JSON.parse(fs.readFileSync(f, 'utf8'))
          const v = j && j.record && j.record.rows && j.record.rows.contextPressure && j.record.rows.contextPressure.val
          readWatermark._t = Number((v && (v.projectedTokens || v.pressureTokens)) || 0)
          readWatermark._w = Number((v && v.contextWindow) || 0)
          readWatermark._k = key
        }
        if (readWatermark._t > 0) {
          return { tokens: readWatermark._t, window: readWatermark._w > 0 ? readWatermark._w : null, source: 'projcache.contextPressure' }
        }
      }
    } catch { /* 文件读不到不算故障 */ }

    // ③ 面值：**不进 contextTokens**，只单独带出去当参考
    try {
      const tm = ctx.get('tokenMeter')
      if (tm && typeof tm.measure === 'function') {
        const m = tm.measure(session)
        const surface = Number((m && (m.surfaceTokens || m.tokens)) || 0)
        if (surface > 0) {
          return {
            tokens: null,
            window: null,
            surface,
            source: 'unavailable',
            reason: '拿不到真水位：只有 tokenMeter 的面值 ' + surface + '（surfaceTokens 是可见消息面，不是 input+cacheRead，不冒充）',
          }
        }
      }
    } catch { /* 读不到就算了 */ }

    return { tokens: null, window: null, source: 'unavailable', reason: '拿不到上下文水位：sessionProjections / 投影缓存 / tokenMeter 三路都取不到' }
  }

  /** 从 ctx 里找一个 live agent；hello 时和报 state 时都要用 */
  /** sessionController —— 能「恢复」一个不在跑的会话（aurabot 的 hub.js 一直在用它）。 */
  function useController () {
    const c = ctx.get('sessionController')
    return (c && typeof c.resolveAgent === 'function') ? c : null
  }

  /**
   * ★★ 2026-11-12：找不到活 agent 时**先试着恢复**，再放弃。
   *
   * 为什么必须加这一步：v4 的 session/resolve 只查映射表、**不验活**（那是设计：
   * 「这个 chatId 有对应会话」和「那个会话现在在跑」是两件事）。所以 resolve 会成功，
   * 而 followup 这边拿到一个合法的 sessionId，却发现没有活 agent ——
   * 于是每条被 @ 的消息都停在 NO_TARGET 上。
   *
   * aurabot 原来走的是 sessionController.resolveAgent(sid)：会话没在跑也能把它拉起来。
   * 宿主以前只做 get/roots（"找活着的"），所以少了这一步。
   *
   * ★ 拿不到 sessionController 时**不假装成功**：why 里明说是「没有这个服务」，
   *   不是「会话不存在」—— 那两个处置完全不同。
   */
  async function pickOrResumeAgent (wantId) {
    const picked = pickLiveAgent(wantId)
    if (picked.agent) return picked
    if (!wantId) return picked
    const c = useController()
    if (!c) {
      return { ...picked, why: (picked.why || '找不到') + '；宿主没有 sessionController，无法恢复会话' }
    }
    try {
      const r = await c.resolveAgent(String(wantId))
      if (r && r.agent && typeof r.agent.followup === 'function') {
        return { agent: r.agent, how: 'resolveAgent(sessionId)', why: null }
      }
      return { ...picked, why: (picked.why || '找不到') + '；resolveAgent 也没恢复出来' }
    } catch (e) {
      return { ...picked, why: (picked.why || '找不到') + '；恢复失败：' + String((e && e.message) || e).slice(0, 120) }
    }
  }

  function pickLiveAgent (wantId) {
    const agents = ctx.get('agents')
    if (!agents) return { agent: null, why: 'agents 服务不可用' }
    const roots = (typeof agents.roots === 'function' ? agents.roots() : []) || []
    if (wantId) {
      const byGet = typeof agents.get === 'function' ? agents.get(String(wantId)) : null
      if (byGet && typeof byGet.followup === 'function') return { agent: byGet, how: 'get(sessionId)' }
      const hit = roots.find((a) => a && String(a.id || '') === String(wantId) && typeof a.followup === 'function')
      if (hit) return { agent: hit, how: 'roots(sessionId)' }
      return { agent: null, why: '找不到指定的 live agent: ' + shortId(wantId) }
    }
    const live = roots.filter((a) => a && typeof a.followup === 'function')
    if (!live.length) return { agent: null, why: '当前没有 live agent（没有活动会话）' }
    return { agent: live[0], how: 'roots[0]', live }
  }

  // ── 发 hello ────────────────────────────────────────────────
  function sendHello (ws) {
    // hello 时可能已经有活动会话 —— 有就把水位一起带上，别等下一轮
    const picked = pickLiveAgent(cfg.defaultSessionId)
    const w = picked.agent ? readWatermark(picked.agent) : { tokens: null, window: null, source: 'unavailable', reason: '拿不到：连上时还没有活动会话（' + (picked.why || 'agents.roots() 为空') + '）' }
    st.lastWatermarkSource = w.source

    const meta = {
      pid: process.pid,
      plugin: 'dsh-agent-soul-bridge',
      version: VERSION,
      node: process.versions.node,
      platform: process.platform,
      // ★ 主动交代哪几个能力是桩 —— 让 v4 在派活之前就知道，而不是派了才发现
      stubs: cfg.stubCaps.slice(),
      // ★ 明确交代哪些字段暂时是空的（不编数）
      //   2026-11-07：outputTokens 已接（读 sessionProjections.tokenUsage），从这张表里拿掉。
      notWired: [],
      // ★ 2026-11-12：能不能「恢复一个不在跑的会话」。
      //   这条决定了 followup 对「映射表里有、但当前没活 agent」的会话是能投还是 NO_TARGET。
      //   写进 hello 是让这件事**连上就能看见**，不用等一条消息失败才知道。
      hasSessionController: Boolean(useController()),
      contextWindow: w.window || cfg.contextWindowFallback,
      contextTokens: w.tokens,
      watermarkSource: w.source,
    }
    if (w.tokens == null) meta.note = w.reason
    if (w.surface) meta.surfaceTokens = w.surface

    ws.send({ type: 'hello', host: cfg.hostName, caps: cfg.caps.slice(), meta })
  }

  // ── 读 tokenUsage（2026-11-07 接上）────────────────────────────
  //
  // ★ 为什么现在能接了：之前这里是 `outputTokens: null // 不读宿主内部消息，宁可空着`。
  //   那份克制是对的（不编数），但结论错了 —— **不需要读宿主内部消息**，
  //   投影里本来就有一份：`tokenUsage.last = { turn, step, buckets: { outputTokens, ... } }`。
  //
  // ★★ 它一次解决了两件事：
  //   ① outputTokens（退化器官的「烧光」和「连续低产出」两条判据要它）
  //   ② turnId 的语义（原来是插件自己 `st.step++` 编的假号，现在用**真的** turn/step）
  //
  // ★ 三个坑，都在代码里标了：
  //   · step 不变 = 同一轮的重复上报 → **不许重复计 outputTokens**（会把「累计零产出」判错）
  //   · 拿不到就返回 null，**绝不填 0** —— 0 在退化器官里是「烧光了」，那是完全相反的含义
  //   · turn 是「第几轮」，不是时间；别拿它判断新鲜度（这条在 diagnose 那边刚踩过）
  function readUsage (agent) {
    const session = agent && agent.session
    if (!session) return null

    // ① 投影服务（首选，和 readWatermark 同源）
    try {
      const sp = ctx.get('sessionProjections')
      if (sp && typeof sp.snapshot === 'function') {
        const snap = sp.snapshot(session)
        const tu = snap && snap.values && snap.values.tokenUsage
        const last = tu && tu.last
        if (last && last.buckets) {
          return {
            turn: Number(last.turn) || 0,
            step: Number(last.step) || 0,
            outputTokens: Number(last.buckets.outputTokens) || 0,
            source: 'sessionProjections.tokenUsage',
          }
        }
      }
    } catch { /* 换下一种来源 */ }

    // ② 投影缓存文件（不依赖 ctx）
    try {
      const sid = String(session.id || '')
      if (sid) {
        const r = readUsageFromFile(sid, cfg.projCacheDir)
        if (r) return r
      }
    } catch { /* 文件读不到不算故障 */ }

    return null
  }

  // ★ 抽出成独立函数（不依赖 ctx）—— 为了**能测**。
  //   2026-11-07：上一轮教训是「测的必须是我改的那个东西」，
  //   而 readUsage 在插件里、依赖 ctx，没法单独跑。抽出来才测得动。
  function readUsageFromFile (sid, projCacheDir) {
    // ★★ 2026-11-07 更正：**session.id 是带 `session-` 前缀的。**
    //
    //   我上一轮写成了「实测不带前缀」——**错了**，而且是从文件名倒推的：
    //   看到 projcache 里叫 `session-xxx.json`，就以为拼接时加的。
    //
    //   真证据在旧代码的输出里：老的 turnId 一直是 `dsh-session--44`，
    //   那个 `session--` 就是 `String(sid).slice(0,8)` 取到了 `session-`。
    //   → **id 本身带前缀**。
    //
    //   所以这行 `.replace()` 不是「防御万一」，是**必需** ——
    //   去掉它就会拼出 `session-session-xxx.json`，文件不存在 → 返回 null
    //   → **静默降级成「没有 outputTokens」，而且不报错**。
    const bare = String(sid || '').replace(/^session-/, '')
    const f = String(projCacheDir || '').replace(/\\/g, '/').replace(/\/+$/, '') + '/session-' + bare + '.json'
    let stat
    try { stat = fs.statSync(f) } catch { return null }
    const key = sid + ':' + stat.mtimeMs + ':' + stat.size
    if (readUsage._k === key) return readUsage._v || null
    let v = null
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'))
      const tu = j && j.record && j.record.rows && j.record.rows.tokenUsage && j.record.rows.tokenUsage.val
      const last = tu && tu.last
      if (last && last.buckets) {
        v = {
          turn: Number(last.turn) || 0,
          step: Number(last.step) || 0,
          outputTokens: Number(last.buckets.outputTokens) || 0,
          source: 'projcache.tokenUsage',
        }
      }
    } catch { v = null }
    readUsage._k = key
    readUsage._v = v
    return v
  }

  // ── 每轮上报 state ──────────────────────────────────────────
  function reportState (agent) {
    if (!st.connected || !st.ws) return
    const now = Date.now()
    if (now - st.lastStateAt < Number(cfg.stateMinGapMs || 0)) return
    st.lastStateAt = now

    const w = readWatermark(agent)
    st.lastWatermarkSource = w.source
    const sid = agent && agent.session ? String(agent.session.id || '') : ''

    // ★ 2026-11-07：outputTokens 接上了，turnId 也换成真的
    const u = readUsage(agent)
    st.lastUsageSource = u ? u.source : 'unavailable'

    // ★ 关键：step 没变 = 同一轮的重复上报。
    //   这时**不许重复报 outputTokens** —— v4 的退化器官对同 turnId 是**累加**的，
    //   重复报会把「这一轮产出了 615」变成「产出了 1230」，然后把「累计零产出」判错。
    //   ★ 所以：没有新 step 就报 null（= 没有新数据），而不是 0（= 烧光了）。
    let outTok = null
    if (u && u.step !== st.lastUsageStep) { outTok = u.outputTokens; st.lastUsageStep = u.step }

    const msg = {
      type: 'state',
      contextTokens: w.tokens,               // ★ 拿不到就是 null，绝不填估算
      contextWindow: w.window || cfg.contextWindowFallback,
      // ★ turnId 用**真的** turn，不再是自己 ++ 的假号。
      //   同一步的多次上报得到同一个 turnId —— 这正是 v4 判「同轮膨胀」需要的。
      turnId: u ? ('dsh-t' + u.turn + '-s' + u.step) : ('dsh-' + (sid ? sid.slice(0, 8) : 'no-session') + '-n' + st.step),
      turn: u ? u.turn : null,
      step: u ? u.step : null,
      outputTokens: outTok,                  // ★ 只有新的 step 才带数；否则 null
      usageSource: u ? u.source : null,
      sessionId: sid || null,
      watermarkSource: w.source,
      at: new Date(now).toISOString(),
    }
    if (w.tokens == null) msg.note = w.reason
    if (w.surface) msg.surfaceTokens = w.surface
    st.ws.send(msg)
  }

  // ── exec：必须回执 ──────────────────────────────────────────
  function sendResult (id, ok, payload) {
    if (!st.connected || !st.ws) return false
    if (!id) { warn('收到一条没有 id 的 exec，无法回执（协议要求必须有 id）'); return false }
    if (ok) return st.ws.send({ type: 'result', id, ok: true, data: payload === undefined ? null : payload })
    // ★ F1：失败帧必然带 [stage:<code>] 前缀 + 结构化 stage 字段（见 execFailure 头注）
    const f = execFailure(payload)
    return st.ws.send({ type: 'result', id, ok: false, error: f.error, stage: f.stage })
  }

  function handleExec (m) {
    const id = m && m.id
    // ★ 先回执、后干活？不行 —— 必须等结果。但**任何路径都要有回执**，所以统一包一层。
    Promise.resolve()
      .then(() => runExec(m))
      .then((data) => {
        if (!sendResult(id, true, data)) warn('回执发不出去（连接已断），这条会被 v4 判超时：' + shortId(id))
      })
      .catch((e) => {
        const why = String((e && e.message) || e)
        // ★ F1 的根就在这一行：原来这里传的是 **String(e)**，e.stage 在压成字符串时丢了。
        //   现在把异常对象本身交给 sendResult（execFailure 取 stage + 隐去秘密 + 加前缀）。
        if (!sendResult(id, false, e)) warn('失败回执发不出去（连接已断）：' + shortId(id) + '｜' + why)
      })
  }

  async function runExec (m) {
    const cap = String((m && m.cap) || '')
    const action = String((m && m.action) || '')
    const args = (m && m.args && typeof m.args === 'object') ? m.args : {}

    // ★★★ 2026-11-13：**上下文手术**（cap='context'）—— 不依赖 DSH 的 pruner。
    //
    //   爀曦定的架构方向：不改造 DSH、降低对宿主的依赖、功能集中在 bridge。
    //   所以这里直接用 DSH 的 Session API 公开原语（sess.eventAt / sess.append + surfaceOp），
    //   而不是去调 dsh-yanqing-pruner（那个是 DSH 侧插件，它自己也在变）。
    //
    //   ★ 这套用法 v3 的 purgeOne 已实测通过（2026-10-31）。见 context-surgeon.mjs 头注。
    if (cap === 'context') {
      const sid = String(args.sessionId || '').trim()
      if (!sid) throw execError('bad-request', 'context 缺 args.sessionId（本宿主不挑默认会话兜底）')
      const picked = pickLiveAgent(sid)
      if (!picked.agent) throw execError('not-found', picked.why || '找不到这个会话')

      if (action === 'candidates') {
        const s = makeContextSurgeon(picked.agent, sid)
        if (!s.ok) throw execError('unsupported', s.why)
        const list = s.candidates(args.limit)
        return { sessionId: sid, action: 'candidates', count: list.length, items: list }
      }

      if (action === 'purge') {
        const items = Array.isArray(args.items) ? args.items : null
        if (!items || !items.length) throw execError('bad-request', 'context/purge 缺 args.items[]（每项 {seq, reason?}）')
        const s = makeContextSurgeon(picked.agent, sid)
        if (!s.ok) throw execError('unsupported', s.why)
        const r = purgeMany(s, items, sid)
        // ★ 回执把「成功 / 失败」分开列 —— 一条失败不该让整批看起来成功
        return {
          sessionId: sid,
          action: 'purge',
          ok: r.ok,
          purgedCount: r.purged.length,
          failedCount: r.failed.length,
          purged: r.purged,
          failed: r.failed,
        }
      }

      throw execError('bad-request', 'context 只认 action = candidates | purge（拿到 ' + JSON.stringify(action) + '）')
    }

    if (cap === 'followup' && action === 'say') return doFollowup(args, m.id)

    // ★ 2026-11-12：session 能力。三个动作，全部**只认显式 sessionId**（不挑 roots[0] 兜底 ——
    //   那是「拿不到目标就自己造一个」的邻居，2026-11-10 已经为它付过代价）。
    if (cap === 'session') {
      // ★★ 2026-11-12：**必须同时认 say 和 followup**。
      //   v4 的 session-dispatch 发的动作名是 'followup'（ACTIONS.FOLLOWUP），
      //   而这里原来只认 'say' —— 于是 session/followup 一路掉到最后一行 bad-request，
      //   2ms 就回来了。链路看起来是通的（回执有 code 有 host），实际上一次都没投成。
      //   ★ 两个名字都留：'say' 是 followup cap 的历史写法（autonomy-host 在用），不能拆。
      if (action === 'say' || action === 'followup') return doFollowup(args, m.id)
      if (action === 'resolve') return doResolve(args)
      if (action === 'steer') {
        const sid = String(args.sessionId || '').trim()
        if (!sid) throw execError('bad-request', 'session/steer 缺 args.sessionId')
        const picked = pickLiveAgent(sid)
        if (!picked.agent) throw execError('not-found', picked.why || '找不到这个会话')
        if (typeof picked.agent.steer !== 'function') {
          throw execError('unsupported', '这个会话的 agent 没有 steer（插话只在正在跑的那一轮有效）')
        }
        return Promise.resolve(picked.agent.steer(String(args.text ?? args.content ?? ''))).then(() => ({
          delivered: true, sessionId: sid, action: 'steer',
        }))
      }
      if (action === 'create') {
        // ★ 宿主侧**没有**「凭空造会话」的入口（agents 只暴露 get/roots）。
        //   所以如实回 unsupported —— 不假装，也不退回 roots[0]。
        throw execError('unsupported',
          'session/create：这个宿主没有创建会话的入口（agents 服务只暴露 get/roots）；' +
          '要新会话请在 DSH 界面里开，或等宿主侧补上 create API')
      }
      throw execError('bad-request', 'session 只认 action = resolve | followup | say | steer | create（拿到 ' + JSON.stringify(action) + '）')
    }

    // ★ 桩：举手了但还干不了 —— 明说，不假装
    if (cap === 'huanqi') {
      throw execError('stub', '未实现：要 hook 才能截断（huanqi 目前只有桩，本宿主在 hello.meta.stubs 里已声明）')
    }
    if (cap === 'pruner') {
      // ★ 2026-11-11：后面有一条**真**路（宿主侧同步 applyDrops），但它默认不开 ——
      //   没在真实会话上验过，就不许它接活。开关关着 = 与 11-10 行为完全一致。
      if (!cfg.prunerLive) {
        // 仍然 ok:false —— 但回执里带着请求本身与会话/seq/opId 的原样回显，
        // 排障时不必再猜「它到底收到什么、卡在哪一层」。**成功路径不存在，也不留兜底。**
        // 仍然走**同一条**统一拒绝（静态测试按这行核对「没有成功路径」）；
        // stage 由 execStageOf 从桩文案（「未实现（桩）：」）识别，不另开一条抛出路径。
        throw new Error(prunerRefusalMessage(args, action))
      }
      if (action && action !== PRUNER_ACTION) {
        throw execError('bad-request', 'pruner 只认 action=' + PRUNER_ACTION + '（拿到 ' + JSON.stringify(action) + '）')
      }
      // ★ 薄适配：解析请求 → 找活 agent → 找活 pruner → 调 applyDrops → 原样翻译回执。
      //   任何一步失败都抛带 stage 的错，绝不自己拼 surface 改写、绝不伪造 framesAffected。
      return await runTargetedCleanup({ ctx, args, describe: describePrunerRequest })
    }
    throw execError('bad-request', '不认识的能力/动作：' + cap + '/' + action)
  }

  /** 映射表的实际路径：配置优先，其次 <DSH_HOME>/plugins-data/aurabot/sessions.json。 */
  function sessionsFilePath () {
    const cfgd = String(cfg.sessionsFile || '').trim()
    if (cfgd) return cfgd
    const home = String(process.env.DSH_HOME || '').trim()
    if (!home) return null
    return path.join(home, 'plugins-data', 'aurabot', 'sessions.json')
  }

  /**
   * session/resolve —— chatId → sessionId 的**映射查询**。
   *
   * ★ 只查映射，**不验活**。协议写的是「只查，绝不新建」，而「那会话现在在不在跑」
   *   是 followup 的判断。映射存在、会话此刻没在跑，是两条不同的信息；
   *   在这里把它判成 NOT_FOUND，等于替调用方决定了它该不该知道这件事。
   *
   * ★ 三类失败分开报，因为它们的处置完全不同：
   *   · 没有 DSH_HOME / 没有映射表文件 → not-found，且说清「这台机器上没有这张表」
   *   · 表读坏（JSON 错、权限）          → unavailable，这是配置问题，不该说成「没找到」
   *   · 表里没有这个 chatId              → not-found，正常业务分支
   */
  function doResolve (args) {
    const chatId = String(args.chatId || '').trim()
    if (!chatId) throw execError('bad-request', 'session/resolve 缺 args.chatId')
    const file = sessionsFilePath()
    if (!file) {
      throw execError('not-found', '这个宿主上没有 DSH_HOME，读不到 chatId→sessionId 映射表（可用 config.sessionsFile 指定）')
    }
    let table
    try {
      table = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (e) {
      if (e && e.code === 'ENOENT') {
        throw execError('not-found', '没有映射表文件：' + file + '（这台机器没装 aurabot，或它的数据不在默认位置）')
      }
      throw execError('unavailable', '映射表读不了：' + file + '（' + String((e && e.message) || e) + '）')
    }
    const chats = (table && typeof table === 'object' && table.chats && typeof table.chats === 'object') ? table.chats : null
    if (!chats) throw execError('unavailable', '映射表结构不认识：' + file + '（缺 chats 对象）')
    const hit = chats[chatId]
    const sid = (hit && typeof hit === 'object') ? String(hit.sessionId || '').trim() : ''
    if (!sid) throw execError('not-found', '映射表里没有这个 chatId：' + chatId)
    // ★ 回执只带映射本身，不带 preset / title / model —— 那些是 aurabot 的账，不是调度需要的东西。
    return { ok: true, chatId, sessionId: sid }
  }

  async function doFollowup (args, cmdId) {
    const text = String(args.text ?? args.content ?? '').trim()
    if (!text) throw execError('bad-request', 'followup/say 缺少 args.text（空文本触发不了一轮）')

    const want = String(args.sessionId || cfg.defaultSessionId || '').trim()
    // ★ 2026-11-12：从 pickLiveAgent 换成 pickOrResumeAgent —— 不活的会话先拉起来再投。
    const picked = await pickOrResumeAgent(want)
    if (!picked.agent) throw execError('no-target', picked.why || '找不到可以叫醒的 agent')

    picked.agent.followup({
      id: 'soul-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: cfg.followupSource, via: 'control-channel', cmd: String(cmdId || '') },
    })

    const live = picked.live || []
    // ★★ 2026-11-12：补 sessionId —— 协议要求 followup 的**投递回执**自报「投给了谁」，
    //   而这里原来只有 target。v4 的 session-dispatch 判据是「自报的 sessionId 必须与请求逐字相等」，
    //   缺了它这条回执一律判成「投递未证实」—— 投成功了也记成失败。
    //   ★ 回的是 **agent.id**（真的投给了谁），不是请求里的 want：
    //     宿主若投给了别的会话，那个差异正是证据；回 want 等于把 MISMATCH 抹掉。
    return {
      delivered: true,
      sessionId: String(picked.agent.id || want || ''),
      target: String(picked.agent.id || ''),
      how: picked.how,
      candidates: live.length || 1,
      ambiguous: live.length > 1,
      candidateIds: live.length > 1 ? live.slice(0, 5).map((a) => String(a.id || '')) : undefined,
      chars: text.length,
      note: 'followup 已投递。「真的开了一轮」由 agent 的运行状态决定，本回执只证明投进去了',
    }
  }

  function onMessage (raw) {
    let m
    try { m = JSON.parse(raw) } catch { warn('收到非 JSON 帧，已忽略'); return }
    if (!m || typeof m !== 'object') return

    if (m.type === 'welcome') {
      st.hostId = String(m.id || '')
      log('v4 认了我：id=' + st.hostId + ' you=' + String(m.you || '?') + ' caps=[' + (Array.isArray(m.caps) ? m.caps.join(',') : '') + ']')
      return
    }
    if (m.type === 'exec') { handleExec(m); return }
    // 将来若加新类型：静默放过，别因为不认识就把连接搞崩
  }

  // ── 连接 / 重连 ─────────────────────────────────────────────
  function stopPing () {
    if (st.pingTimer) { clearInterval(st.pingTimer); st.pingTimer = null }
  }

  function startPing () {
    stopPing()
    const ms = Number(cfg.pingMs) || 0
    if (ms <= 0) return
    st.pingTimer = setInterval(() => {
      try { if (st.ws) st.ws.ping() } catch { /* 下一轮会走 onclose */ }
    }, ms)
    if (st.pingTimer.unref) st.pingTimer.unref()
  }

  function nextDelay () {
    const d = st.delay
    const next = Math.min(Number(cfg.reconnectMaxMs), Math.round(st.delay * Number(cfg.reconnectFactor || 2)))
    st.delay = Math.max(Number(cfg.reconnectMinMs), Number.isFinite(next) ? next : Number(cfg.reconnectMinMs))
    return d
  }

  function scheduleRetry (why) {
    if (disposed) return
    const delay = nextDelay()
    st.attempts += 1
    if (!st.downSince) st.downSince = Date.now()

    // ★ 日志纪律：第 1 次失败说清楚「开始退避」，之后静默；到顶再说一次。
    //   v4 那边 7310 常常不开机，一开一关就是几十次重试 —— 每次打一行会把日志埋掉。
    if (st.attempts === 1) {
      warn('控制通道不可用（' + why + '）—— 开始指数退避重连：' + fmtMs(delay) + ' → 上限 ' + fmtMs(Number(cfg.reconnectMaxMs)) + '，重试期间不刷屏')
    } else if (delay >= Number(cfg.reconnectMaxMs) && !st.loggedCap) {
      st.loggedCap = true
      warn('仍在重连（已 ' + st.attempts + ' 次，间隔已到 ' + fmtMs(Number(cfg.reconnectMaxMs)) + ' 上限）—— 保持静默重试，连上会报一声')
    }

    if (st.retryTimer) clearTimeout(st.retryTimer)
    st.retryTimer = setTimeout(connect, delay)
    if (st.retryTimer.unref) st.retryTimer.unref()
  }

  function onClosed (why) {
    const wasConnected = st.connected
    st.connected = false
    st.helloed = false
    st.ws = null
    stopPing()
    if (disposed) return
    if (wasConnected) {
      // 断的时候说一句就够 —— 后面的重试由 scheduleRetry 管
      warn('控制通道断了（' + why + '）')
    }
    scheduleRetry(why)
  }

  function onOpen (ws) {
    if (!ws || st.helloed) return
    st.helloed = true
    st.connected = true
    const waited = st.downSince ? Date.now() - st.downSince : 0
    const tries = st.attempts
    st.attempts = 0
    st.delay = Number(cfg.reconnectMinMs)
    st.downSince = 0
    st.loggedCap = false
    if (tries > 0) log('已重连 ' + cfg.url + '（重试 ' + tries + ' 次，空了 ' + fmtMs(waited) + '）')
    else log('已连上 ' + cfg.url)
    try { sendHello(ws) } catch (e) { warn('hello 发不出去：' + String((e && e.message) || e)) }
    startPing()
  }

  function connect () {
    if (disposed) return
    let cur = null
    try {
      cur = connectWs(cfg.url, {
        onopen: () => onOpen(cur),
        onmessage: onMessage,
        onclose: onClosed,
        onerror: () => { /* 原因字符串由 onclose 带出来，这里不重复刷 */ },
      })
    } catch (e) {
      onClosed(String((e && e.message) || e))
      return
    }
    st.ws = cur
    // 握手可能在 connectWs 里同步完成（本地回环常见），那时 onopen 里的 cur 还是 null —— 补一次
    if (cur.open) onOpen(cur)
  }

  function stop () {
    disposed = true
    stopPing()
    if (st.retryTimer) { clearTimeout(st.retryTimer); st.retryTimer = null }
    try { if (st.ws) st.ws.close() } catch { /* 已经死了 */ }
    st.ws = null
    st.connected = false
    st.helloed = false
  }

  // ── 装配 ────────────────────────────────────────────────────
  const boot = () => {
    log('启动（' + cfg.url + '）能力=[' + cfg.caps.join(',') + '] 桩=[' + cfg.stubCaps.join(',') + ']')
    connect()
  }
  try {
    if (typeof ctx.effect === 'function') ctx.effect(() => { boot(); return stop })
    else boot()
  } catch (e) {
    warn('装配失败（不影响宿主）：' + String((e && e.message) || e))
  }

  // ── 每轮一次的钩子 ───────────────────────────────────────────
  //
  // ★ 借 systemPrompt.context 的 render 当「每轮触发一次」的钩子：它在每次组装提示时被调用。
  //   **返回空串** —— 一个字都不往提示里塞。dsh-yanqing-memory 已经用同一条路做过「按轮注入」，
  //   所以这条路在本机是验证过的（那条路失败也不会伤到对话：整个 render 包在 try 里）。
  if (cfg.statePerTurn !== false) {
    try {
      ctx.inject(['systemPrompt'], (scope) => {
        scope.systemPrompt.context({
          name: 'agent-soul:state-probe',
          order: 900,
          text: (context) => {
            try { reportState(context && context.agent) } catch { /* 报不出去也不许影响这一轮 */ }
            return ''
          },
        })
      })
    } catch (e) {
      warn('装不上每轮钩子（state 不会上报，其余照常）：' + String((e && e.message) || e))
    }
  }

  // 给 probe.mjs / 调试用：不参与宿主行为
  ctx.__agentSoulBridge = { cfg, st, readWatermark, pickLiveAgent }
}

export default { name, apply }
