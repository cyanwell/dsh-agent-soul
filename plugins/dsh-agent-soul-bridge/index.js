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
import crypto from 'node:crypto'
import { zstdDecompressSync } from 'node:zlib'
import path from 'node:path'

import { spawn } from 'node:child_process'
import { connectWs } from './ws.js'
import { createBridgeMarker } from './bridge-proof.mjs'
import { runTargetedCleanup } from './pruner-adapter.mjs'
// ★ 2026-11-13：上下文手术刀 —— 不依赖 DSH 的 pruner，直接用 Session API 公开原语。
import { makeContextSurgeon, purgeMany } from './context-surgeon.mjs'
// ★ 2026-11-20：真实生命周期身份核验（进程本体 + 管理器证明 + 三者对齐）。
import { makeRunPowerShell, makeCanonicalizePath, makeInspect } from './lifecycle-inspect.mjs'
import { readManagerProof } from './manager-proof-client.mjs'

export const name = 'dsh-agent-soul-bridge'
/** 需要 webServer 才能注册管理端点（DSH 面板用） */
export const inject = ['webServer']

// ★ 发布版本：与 package.json.version 保持一致。
const VERSION = '0.1.5'
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
  //   它是已实现的 Host cap，不属于 stubCaps。
  // ★★★ 2026-11-13（爀曦定）：加 'sessions' —— v4 **不再直接读 DSH 的会话文件**。
  //   理由：v4 与 DSH 之间只留两个接口（bridge + MCP hub），这样两边连得最浅、
  //   维护成本最低。文件直读看着简单，实际是「路径变了/目录结构变了」就静默失效的另一种耦合。
  //   ★ 失败必须外显：读不到就返回带 stage 的错，绝不回空数组冒充「没有会话」。
  // ★★★ 2026-11-13（第 14 代）：加 'workspaces'。
  //   aurabot 搬进 v4 之后，它手里的 `ctx` 是 v4 造的适配对象（agent-soul/src/aurabot/adapter/ctx.mjs）——
  //   那里**没有** workspaceRegistry 服务，于是「先把 QQ 消息送进某个工作区里的会话」这一步
  //   永远停在 `宿主没有 workspaceRegistry`（11-12 起一直在报，11-13 22:54 还在报）。
  //   爀曦定：**宿主有的能力，就该能从 bridge 这里调**。所以把它搬到这条通道上。
  //   ★ 只读 + 建工作区，不碰会话内容；ensure 是幂等的（同路径直接复用，不改标题）。
  // ★★★ 2026-11-14（第 14 代）：加 'agent' —— 把 aurabot 的工具**挂到会话上**。
  //   工具实现活在 v4，agent 活在 DSH —— 函数跨不了进程，所以这里挂「转发器」：
  //   调用时发 invoke 回 v4 执行。没有这条，她连 report_to_lead 都调不到。
  // ★★★ 2026-11-14（第 14 代 · bridge 协议 v2）：加 'events' 与 'service'。
  //   · events  —— 事件回流（session/event）+ 句柄生死（handle/revoked）+ 宿主状态（host/state）
  //                + 补帧（resumeFrom）。没有它，v4 只能被动发指令，永远不知道 DSH 里发生了什么。
  //   · service —— 把 llm / attachments / workspaceRegistry / sessions 的**纯数据方法**借给 v4。
  //   ★★ 但**真正生效的是 cordis.patch.yml 的 caps**（本文件这份会被它覆盖）——
  //     两边都写是因为「读代码的人该看到全貌」，不是因为它能生效。这条已经踩过五次。
  caps: ['followup', 'session', 'sessions', 'workspaces', 'agent', 'events', 'service', 'huanqi', 'pruner', 'context'],
  /**
   * chatId → sessionId 映射表的位置（aurabot 的 sessions.json）。
   * 空 = 按 <DSH_HOME>/plugins-data/aurabot/sessions.json 自动找。
   * ★ 留这个口，是为了「aurabot 装在别处 / 将来换了别的会话映射来源」时不必改代码。
   */
  sessionsFile: '',
  /** ★ 只举手不干活的那些（会原样写进 hello.meta.stubs，别偷偷藏） */
  // 未经真实能力验收的 Host cap 必须继续显式标为桩.
  stubCaps: ['huanqi', 'pruner'],
  /**
   * ★ 2026-11-11：「定点清理」的同步实现已经在 dsh-yanqing-pruner 里落地
   *   （applyDrops，复用官方 pruneSession 的落盘原语），本桥也写了薄适配
   *   （pruner-adapter.mjs）。但**默认仍然关着**，原因只有一条：
   *   这条链还没在真实会话上跑过 —— 拿不到活 pruner 实例时它会报 no-pruner，
   *   而「能不能拿到」取决于 realm 可见性，那个前提没有实测证据。
   *
   * ★ 发布默认：prunerLive=false，且 stubCaps 保留 'pruner'。
   *   真适配层仍在，但桥能否拿到目标 pruner 实例尚未完成真实会话验收。
   *   开关关闭时回 ok:false + 缺口说明，不伪造 framesAffected。
   *   原有适配层代码保留，待非生产真实会话验收后再考虑开启。
   *   （历史评估记录保留在 _verify/pruner-eval/。）
   *   解析不到活实例时仍然抛 no-pruner，不自行拼 surface 改写。
   *   开关关着时行为与 11-10 行为一致：回 ok:false + 缺口说明。

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
  /** ★ 2026-11-13：agent-soul **本体**的根目录（WebView2 窗口 + 内嵌 node core）。
   *  它不是 node 服务 —— start 要拉的是 build/AgentSoul.exe，而且 cwd 必须是这个根
   *  （dataDir 按 cwd 解析，指错会建出一个假 data 目录）。
   *  cordis.patch.yml 里没写它，所以这份 DEFAULTS 就是生效值。 */
  /** ★ 2026-11-20：默认指**生产安装**（壳在根下 AgentSoul.exe）。开发树可显式覆盖。 */
  agentSoulRoot: 'C:/Users/pc/Desktop/deepseek harness/agent soul',
  /** stop 用哪个镜像名杀进程；空 = 取 exe 的文件名（AgentSoul.exe）。仅保留兼容字段，不再用于终止。 */
  agentSoulImage: '',
  /** 管理端点独立的 local-admin bearer；缺少则管理面 fail-closed。 */
  localAdminToken: '',
  localAdminTokenFile: '',
  /** 管理 POST 的一次性 nonce；未配置时随机生成且不通过端点暴露。 */
  localAdminCsrfNonce: '',
  /** 守护要不要自动拉起（false = 只探测不拉起；测试与排障时用） */
  // ★★★ 2026-11-17（爀曦定）：默认**不自动拉起**。
  //   实测：我手动 stop 之后 95 秒内它又 spawn 了一个 core + 一个壳（core.lock pid=1320），
  //   于是「开发期同一时刻只有一个 core」这条纪律守不住。
  //   它不是坏了 —— 它按设计工作（30s 一探、连续 2 次没应答就拉）。
  //   但开发期要的是「我不叫它，它就不动」。
  //   ★ 探测仍在、面板「启动」按钮仍在（start 端点与守护是同一条 spawn 路径）。
  //   要恢复自动拉起：把这行改回 true，或者在自己的 profile patch 里覆盖成 true。
  agentSoulAutoStart: false,
  /** start 之后等 /api/health 应答的上限（ms） */
  agentSoulWaitMs: 15000,
  /** /api/session 要的 token 文件；空 = <root>/data/token.txt。只用来发请求头，不打印不外泄 */
  agentSoulTokenFile: '',
  /** apply 回执目录 —— 日志看不见时靠它取证 */
  receiptDir: 'D:/AI/dsh/home/plugins-data/agent-soul-bridge',
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

/**
 * ★★★ 2026-11-14（bridge 协议 v2，契约 §3.5）：失败帧必须带**结构**，不能只有一句话。
 *
 * 缺陷：原来只有 { stage, error }。stage 是粗桶（host-error / no-target / unavailable…），
 *   而调用方真正要区分的是「句柄失效」「服务没就绪」「schema 不被接受」——
 *   它们全落在同一个桶里，v4 只能拿 error 文本做正则猜。今晚那条头号阻塞
 *   （tool "... must declare output …"）就是这样：它能被看见，但**不可判定**。
 *
 * 现在的口径（封闭词表、可解析、向前兼容）：
 *   ok:false 的 result 帧同时给：
 *     stage    粗粒度桶（沿用既有词表，不许乱加）
 *     code     细粒度码 "<域>/<动作>"，如 handle/revoked、service/unavailable、tool/schema
 *     message  一行人话（已隐去凭据、截 500 字符）
 *     detail   可选，结构化补充（JSON）
 *     error    '[stage:<stage>] <message>' —— **保留**，老消费方仍按正则读它
 *   ★ code 恒非空：没显式给就回落成 stage（两者不互相冒充：一个是桶，一个是原因）。
 */
const CODE_RE = /^[a-z][a-z0-9-]{0,31}(\/[a-z][a-z0-9-]{0,31})?$/

/** 失败回执的线上形状：{ ok:false, stage, code, message, detail?, error }。 */
export function execFailure (e) {
  const stage = execStageOf(e)
  const rawCode = (e && typeof e.code === 'string') ? e.code.trim() : ''
  const code = CODE_RE.test(rawCode) ? rawCode : stage
  const one = redactSecrets(String((e && e.message) || e || '未知错误'))
    .replace(/[\r\n]+/g, ' ')
    .trim()
  const message = one.slice(0, 500)
  const f = { ok: false, stage, code, message, error: '[stage:' + stage + '] ' + message }
  if (e && e.detail !== undefined) f.detail = e.detail
  return f
}

/**
 * 带 stage / code / detail 的拒绝 —— runExec 内部用。
 * ★ 三个参数都可省（老调用点只给前两个），但**新代码必须给 code**：
 *   只有 stage 的话，v4 又回到「同一个桶里猜原因」。
 */
function execError (stage, msg, code, detail) {
  const e = new Error(msg)
  e.stage = stage
  if (code) e.code = code
  if (detail !== undefined) e.detail = detail
  return e
}

/* ══════════════ bridge 协议 v2 的机器（2026-11-14 · 契约 §2 / §3）══════════
   ★ 为什么这些写成「注入依赖的工厂」而不是直接塞进 apply：
     它们要么是纯逻辑（环形缓冲 / seq / 白名单 / schema 归一），要么只需要一根线
     （「发一帧」/「拿一个服务」）。做成工厂之后，测试脚本 import 进去拿假 ctx 就能跑，
     **不必起 DSH、不必连 v4**（本文件的老教训：测的必须是我改的那个东西）。
   ★ 每个工厂都不持有 ctx —— ctx 只作为参数进来。
   ─────────────────────────────────────────────────────────────────────── */

/** 契约 §2.2：push 只认这三个 topic。多余的一律拒（别让 v4 以为发了个有效订阅）。 */
export const PUSH_TOPICS = ['session/event', 'handle/revoked', 'host/state']
/** 契约 §3.1 */
export const RING_MAX = 2000
export const RING_TTL_MS = 5 * 60 * 1000
/** 句柄复验周期（契约 §3.3 写死 5s） */
export const HANDLE_VERIFY_MS = 5000

/** 造一个带 stage/code/detail 的错误（工厂内部用；shape 与 execError 一致）。 */
export function codeError (code, stage, message, detail) {
  const e = new Error(message)
  e.stage = stage || 'host-error'
  e.code = code
  if (detail !== undefined) e.detail = detail
  return e
}

/* ───────────── 事件层：per-subscription 单调 seq + 环形缓冲 + resumeFrom ───────────── */

/**
 * 订阅/推帧/补帧的全部状态机。**不认识 ctx，也不认识 ws** —— 只认一个 send(frame)。
 *
 * 语义（逐条对契约）：
 *   · seq 是 per-subscription 单调递增（§2.2）；v4 记 lastSeq，重连时拿它补帧。
 *   · push 发送失败**不许抛** → dropped++，帧留在 ring 里等 resumeFrom 补（§3.2）。
 *   · ack 到了 → 裁掉 ring 里 <= seq 的（§2.3）；**没 ack 不重发**（避免雪崩）。
 *   · resumeFrom：接上**原来那条订阅**的 ring（见 findResumable）。
 *     接上了 → resumed:true；接不上（宿主重启过 / ring 已裁掉那段）→ gap:true，v4 就知道丢了什么。
 */
export function makeEventHub (opts) {
  const o = opts || {}
  const send = typeof o.send === 'function' ? o.send : () => false
  const now = typeof o.now === 'function' ? o.now : Date.now
  const log = typeof o.log === 'function' ? o.log : () => {}
  const ringMax = Number.isInteger(o.ringMax) && o.ringMax > 0 ? o.ringMax : RING_MAX
  const ringTtlMs = Number.isFinite(o.ringTtlMs) && o.ringTtlMs >= 0 ? Number(o.ringTtlMs) : RING_TTL_MS
  const subs = new Map()
  let ids = 0
  let published = 0

  /* 过滤规则（契约 §2.4 的 filter 形状）：
     · session/event —— sessionIds 命中 data.session.id，kinds 命中 data.event.type
     · handle/revoked —— sessionIds 命中 data.sessionId（kinds 对它无意义，忽略）
     · host/state    —— 广播（没有会话维度可筛） */
  function matches (sub, topic, data) {
    if (!sub.topics.has(topic)) return false
    const f = sub.filter || {}
    const wantIds = Array.isArray(f.sessionIds) && f.sessionIds.length ? f.sessionIds.map(String) : null
    if (topic === 'session/event') {
      const sid = String((data && data.session && data.session.id) || '')
      if (wantIds && wantIds.indexOf(sid) < 0) return false
      const wantKinds = Array.isArray(f.kinds) && f.kinds.length ? f.kinds.map(String) : null
      const kind = String((data && data.event && data.event.type) || '')
      if (wantKinds && wantKinds.indexOf(kind) < 0) return false
      return true
    }
    if (topic === 'handle/revoked') {
      const sid = String((data && data.sessionId) || '')
      if (wantIds && wantIds.indexOf(sid) < 0) return false
      return true
    }
    return true
  }

  /** 把 ring 裁到上限：先按条数，再按时间；被裁且**没 ack 过**的记 evicted（= 这段真的丢了）。 */
  function trim (sub, at) {
    while (sub.ring.length > ringMax) {
      const gone = sub.ring.shift()
      if (gone && gone.seq > sub.ackSeq) sub.evicted += 1
    }
    if (!ringTtlMs) return
    while (sub.ring.length) {
      const head = sub.ring[0]
      if (at - Number(head.at || 0) <= ringTtlMs) break
      const gone = sub.ring.shift()
      if (gone && gone.seq > sub.ackSeq) sub.evicted += 1
    }
  }

  function deliver (sub, frame) {
    try {
      const ok = send(frame) !== false
      if (ok) sub.sent += 1
      return ok
    } catch (e) {
      /* ★ 契约 §3.2：push 发送失败不许抛。记 dropped，等 v4 重连用 resumeFrom 补。
         ★ 但**不许静默**：每条订阅只抱怨一次（否则一条断线能刷满日志）。 */
      if (!sub.sendWarned) {
        sub.sendWarned = true
        log('push 发送失败（' + sub.id + ' / ' + frame.topic + ' seq=' + frame.seq + '）：'
          + String((e && e.message) || e) + ' —— 记 dropped，等 resumeFrom 补；本条订阅不再重复报')
      }
      return false
    }
  }

  /** 发布一条事件给所有命中的订阅。返回造出的帧数。**永不抛**（它跑在 ctx.on 的回调里）。 */
  function publish (topic, data, atMs) {
    const at = Number.isFinite(atMs) ? atMs : now()
    let made = 0
    try {
      for (const sub of subs.values()) {
        if (!matches(sub, topic, data)) continue
        sub.seq += 1
        const frame = { type: 'push', topic, sub: sub.id, seq: sub.seq, at, data }
        sub.ring.push(frame)
        made += 1
        trim(sub, at)
        if (!deliver(sub, frame)) sub.dropped += 1
        sub.lastAt = at
      }
    } catch (e) {
      log('publish 内部异常（这一条已丢，事件=' + String(topic) + '）：' + String((e && e.message) || e))
    }
    published += made
    return made
  }

  /** 找一条能接上 resumeFrom 的旧订阅：seq 够新 + topic 有交集；取 createdAt 最新的那条。 */
  function findResumable (topics, resumeFrom) {
    let best = null
    for (const sub of subs.values()) {
      if (sub.seq < resumeFrom) continue
      let hit = false
      for (const t of topics) { if (sub.topics.has(t)) { hit = true; break } }
      if (!hit) continue
      if (!best || sub.createdAt >= best.createdAt) best = sub
    }
    return best
  }

  function normalizeFilter (f) {
    const src = (f && typeof f === 'object') ? f : {}
    const out = {}
    if (Array.isArray(src.sessionIds) && src.sessionIds.length) out.sessionIds = src.sessionIds.map(String)
    if (Array.isArray(src.kinds) && src.kinds.length) out.kinds = src.kinds.map(String)
    return out
  }

  function subscribe (args) {
    const a = (args && typeof args === 'object') ? args : {}
    const topics = Array.isArray(a.topics) ? a.topics.map(String).filter(Boolean) : []
    if (!topics.length) {
      throw codeError('events/bad-request', 'bad-request', 'events/subscribe 缺 args.topics（至少一个 topic，可用：' + PUSH_TOPICS.join(' / ') + '）', { allowed: PUSH_TOPICS.slice() })
    }
    const unknown = topics.filter((t) => PUSH_TOPICS.indexOf(t) < 0)
    if (unknown.length) {
      throw codeError('events/unknown-topic', 'bad-request', 'events/subscribe 收到不认识的 topic：' + unknown.join(', ') + '（可用：' + PUSH_TOPICS.join(' / ') + '）', { unknown, allowed: PUSH_TOPICS.slice() })
    }
    const filter = normalizeFilter(a.filter)
    const resumeFrom = (Number.isFinite(a.resumeFrom) && Number(a.resumeFrom) >= 0) ? Math.floor(Number(a.resumeFrom)) : null

    if (resumeFrom !== null) {
      const adopt = findResumable(topics, resumeFrom)
      if (adopt) {
        adopt.topics = new Set(topics)
        adopt.filter = filter
        const backlog = adopt.ring.filter((fr) => fr.seq > resumeFrom).map((fr) => Object.assign({}, fr))
        let gap = false
        if (adopt.seq >= resumeFrom + 1) {
          const haveFirst = adopt.ring.length ? adopt.ring[0].seq : null
          gap = haveFirst === null || haveFirst > resumeFrom + 1
        }
        adopt.lastResumeAt = now()
        adopt.sendWarned = false
        log('events/subscribe 接上原订阅 ' + adopt.id + '（resumeFrom=' + resumeFrom + '，seq=' + adopt.seq + '，backlog=' + backlog.length + (gap ? '，⚠ 中间那段已被裁掉' : '') + '）')
        return { subscriptionId: adopt.id, seq: adopt.seq, backlog, resumed: true, gap }
      }
    }

    const id = 'sub-' + (++ids)
    const sub = {
      id,
      topics: new Set(topics),
      filter,
      seq: resumeFrom === null ? 0 : resumeFrom,
      ring: [],
      sent: 0,
      dropped: 0,
      evicted: 0,
      ackSeq: resumeFrom === null ? 0 : resumeFrom,
      createdAt: now(),
      lastAt: 0,
      lastResumeAt: 0,
      sendWarned: false,
    }
    subs.set(id, sub)
    /* ★ 没接上原订阅却给了 resumeFrom = 中间那段**真的没了**（宿主重启 / ring 已裁）。
       如实标 gap:true，v4 才知道「丢了什么」，而不是以为一条都没漏。 */
    const gap = resumeFrom !== null && resumeFrom > 0
    if (gap) log('events/subscribe 新建 ' + id + '：resumeFrom=' + resumeFrom + ' 但找不到能接上的旧订阅 —— 中间那段丢了（gap:true）')
    return { subscriptionId: id, seq: sub.seq, backlog: [], resumed: false, gap }
  }

  function unsubscribe (subscriptionId) {
    const key = String(subscriptionId || '')
    const had = subs.delete(key)
    return { ok: true, subscriptionId: key, removed: had }
  }

  /** 契约 §2.3：ack 到了就裁 ring；**不重发**（补帧靠 resumeFrom）。 */
  function ack (args) {
    const a = args || {}
    const key = String(a.sub || '')
    const sub = subs.get(key)
    if (!sub) return { ok: false, code: 'events/unknown-subscription', subscriptionId: key || null }
    const seq = Number.isFinite(a.seq) ? Math.floor(Number(a.seq)) : 0
    if (seq > sub.ackSeq) sub.ackSeq = seq
    let trimmed = 0
    while (sub.ring.length && sub.ring[0].seq <= sub.ackSeq) { sub.ring.shift(); trimmed += 1 }
    return { ok: true, subscriptionId: sub.id, ackSeq: sub.ackSeq, trimmed }
  }

  function status () {
    const at = now()
    const list = []
    let ringSize = 0
    for (const sub of subs.values()) {
      trim(sub, at)
      ringSize += sub.ring.length
      list.push({
        subscriptionId: sub.id,
        topics: [...sub.topics],
        seq: sub.seq,
        sent: sub.sent,
        dropped: sub.dropped,
        // 下面几项是补充信息（契约没要求，但排障时正是它解释了「为什么 backlog 有洞」）
        ackSeq: sub.ackSeq,
        evicted: sub.evicted,
        ringSize: sub.ring.length,
        createdAt: sub.createdAt,
        lastAt: sub.lastAt || null,
        lastResumeAt: sub.lastResumeAt || null,
      })
    }
    return { subscriptions: list, ringSize, ringMax, ringTtlMs, published }
  }

  return { subscribe, unsubscribe, ack, status, publish, size: () => subs.size, findResumable }
}
/* ───────────── 句柄通道：attach / detach / 5s 复验 / 失效必拒 ───────────── */

/**
 * 句柄表。**只认两个注入**：怎么看「这个会话现在有没有活 agent」、失效时通知谁。
 *
 * 契约 §2.5 / §3.3：
 *   · attach 记下 agent 引用 + sessionId；5s 用 agents.get(sessionId) 复验
 *   · 拿不到 or 引用变了 → 推 handle/revoked、删 handle
 *   · **失效的 handleId 上做 followup 必须失败**（ok:false + code:'handle/revoked'），不许假装成功
 *
 * ★ 为什么要句柄这一层（而不是继续每条消息传 sessionId）：
 *   传 sessionId 的表达力只有「这个 id 有没有会话」；而 v4 真正需要的是
 *   「**我手里这个 agent 还活着吗**」。这两个问题在会话被归档/重建/换实例时答案不同，
 *   而传 id 的形态下那个差别**不可观测** —— 投递会静默成功或静默失败，两种都坏。
 */
export function makeHandleTable (opts) {
  const o = opts || {}
  const getLiveAgent = typeof o.getLiveAgent === 'function' ? o.getLiveAgent : () => null
  const onRevoked = typeof o.onRevoked === 'function' ? o.onRevoked : () => {}
  const now = typeof o.now === 'function' ? o.now : Date.now
  const rows = new Map()
  let n = 0
  let revokedTotal = 0

  function attach (input) {
    const i = input || {}
    const sessionId = String(i.sessionId || '').trim()
    if (!sessionId) throw codeError('session/bad-request', 'bad-request', 'session/attach 缺 args.sessionId（本宿主不挑默认会话兜底）')
    if (!i.agent) throw codeError('handle/no-agent', 'host-error', 'attach 拿到的是空 agent（宿主内部错误：agent 没传进来）', { sessionId })
    // 同一个会话只留一个有效句柄：旧的那条先撤（v4 手里同时握两个会漂）
    for (const [id, row] of [...rows]) {
      if (row.sessionId === sessionId) revoke(id, 'replaced-by-new-attach', 'handle/revoked')
    }
    const handleId = 'h-' + (++n)
    const row = { handleId, sessionId, agent: i.agent, createdAt: now(), session: i.session || null }
    rows.set(handleId, row)
    return row
  }

  function get (handleId) {
    return rows.get(String(handleId || '')) || null
  }

  /**
   * ★★★ 2026-11-14（第 14 代）：句柄还活着的判据是「**同一个会话的 agent 还在**」，
   * 不是「同一个 JS 对象实例」。
   *
   * 为什么改（原来写的是 `live !== row.agent`）：
   *   DSH 的 agents.get(sessionId) 是否每次都返回同一个对象引用，**没有可读的实现能证实**
   *   （本机 DSH 是 asar 打包，agents 服务找不到源）。如果它每次返回新包装，
   *   5 秒复验就会把**所有健康句柄**判成 agent-replaced 全撤掉 —— 症状是日志每 5 秒
   *   刷一遍「句柄失效」，而她的话一条也发不出去。
   *
   *   「对象身份」从来不是这个句柄要表达的东西；它要表达的是「这个会话此刻有没有活的 agent」。
   *   所以先比引用（最快、最常见），再比稳定标识（id / session.id）——
   *   同一个 sessionId 的 agent 就是同一个，这条语义不会因为宿主怎么包对象而变。
   *
   * ★ 代价（写清楚，不藏）：真出现「同一 sessionId 换了实例」时这个判据抓不到。
   *   那种情况由 agent/disposed 事件兜底；且用错实例的风险低于「每 5 秒全撤」。
   */
  function sameAgent (a, b) {
    if (a === b) return true
    if (!a || !b) return false
    const ida = String(a.id || a.sessionId || '')
    const idb = String(b.id || b.sessionId || '')
    if (ida && idb && ida === idb) return true
    const sa = a.session && a.session.id
    const sb = b.session && b.session.id
    return Boolean(sa && sb && String(sa) === String(sb))
  }

  /** 撤一条句柄并发通知。onRevoked 抛错就让它抛（调用方逐行兜住）—— 不许在这里吞。 */
  function revoke (handleId, reason, code) {
    const id = String(handleId || '')
    const row = rows.get(id)
    if (!row) return null
    rows.delete(id)
    revokedTotal += 1
    const info = {
      handleId: id,
      sessionId: row.sessionId,
      reason: String(reason || 'unknown'),
      code: String(code || 'handle/revoked'),
      at: now(),
    }
    onRevoked(info)
    return info
  }

  /** 5s 复验：agent 拿不到、或引用换了 → 撤。返回 {checked, surviving}。 */
  function verify () {
    let checked = 0
    for (const [id, row] of [...rows]) {
      checked += 1
      let live = null
      try { live = getLiveAgent(row.sessionId) } catch (e) { live = null }
      if (!live) { revoke(id, 'agent-gone', 'handle/revoked'); continue }
      if (!sameAgent(live, row.agent)) { revoke(id, 'agent-replaced', 'handle/revoked'); continue }
    }
    return { checked, surviving: rows.size }
  }

  /**
   * 用之前再核一次（followup / steer 走这里）。
   * ★ 这是「不许假装成功」的落点：句柄失效 -> 抛 code:'handle/revoked'。
   */
  function mustGet (handleId) {
    const id = String(handleId || '')
    const row = rows.get(id)
    if (!row) {
      throw codeError('handle/revoked', 'handle-revoked',
        '句柄不存在或已失效：' + (id || '（空）') + '（本宿主只认 attach 发出去的句柄；失效后必须重新 attach）',
        { handleId: id || null, reason: 'unknown-handle' })
    }
    let live = null
    try { live = getLiveAgent(row.sessionId) } catch (e) { live = null }
    if (!live) {
      revoke(id, 'agent-gone', 'handle/revoked')
      throw codeError('handle/revoked', 'handle-revoked', '句柄已失效：会话 ' + shortId(row.sessionId) + ' 此刻没有活 agent（已推 handle/revoked）', { handleId: id, sessionId: row.sessionId, reason: 'agent-gone' })
    }
    if (!sameAgent(live, row.agent)) {
      revoke(id, 'agent-replaced', 'handle/revoked')
      throw codeError('handle/revoked', 'handle-revoked', '句柄已失效：会话 ' + shortId(row.sessionId) + ' 的 agent 换了实例（已推 handle/revoked，请重新 attach）', { handleId: id, sessionId: row.sessionId, reason: 'agent-replaced' })
    }
    return row
  }

  function detach (handleId) {
    const id = String(handleId || '')
    const row = rows.get(id)
    if (!row) return { ok: true, handleId: id, removed: false }
    rows.delete(id)
    return { ok: true, handleId: id, removed: true, sessionId: row.sessionId }
  }

  function list () {
    return [...rows.values()].map((r) => ({ handleId: r.handleId, sessionId: r.sessionId, createdAt: r.createdAt }))
  }

  return { attach, get, revoke, verify, mustGet, detach, list, size: () => rows.size, revokedTotal: () => revokedTotal }
}
/* ───────────── 服务网关：只暴露声明过的方法，不许反射任意属性 ───────────── */

/**
 * 白名单（契约 §2.4 的表 + 本机类型定义的实测）。每一条都能核：
 *   llm        @deepseek-ai/dsh-llm        lib/types/index.d.ts:231-408（LlmRuntime）
 *   attachments @deepseek-ai/dsh-attachment lib/types/index.d.ts:50（admitPromptContent）
 *   workspace  @deepseek-ai/dsh-workspace  lib/types/index.d.ts:54-139 + :116（archivedSessionIds 是 getter）
 *   sessions   @deepseek-ai/dsh-session    lib/types/index.d.ts:317-439（list/get/flush）
 *
 * ★ **故意不在白名单里的**（不是漏了）：
 *   · llm.stream        → 返回 AsyncIterable，跨不了进程
 *   · llm.prepareCall   → 返回带函数的 handle，同上
 *   · sessionController → create/rename 已各有专属动作用（session cap）；resolveAgent 返回**活对象**，
 *                          按契约 §2.4「返回活对象的只能走句柄通道」
 *   · agents            → 同上（它手里全是活 agent）
 * 调它们会得到 service/unknown-method（带 allowed 列表），不是一个模糊的失败。
 */
export const SERVICE_ALLOWLIST = Object.freeze({
  llm: { methods: ['listProviders', 'listModels', 'resolveModelInfo', 'resolveCallConfig'] },
  attachments: { methods: ['admitPromptContent'] },
  workspaceRegistry: {
    methods: ['list', 'create', 'get', 'resolveByPath', 'archiveSession'],
    properties: ['archivedSessionIds'],
    project: 'workspace',
  },
  sessions: { methods: ['list', 'get', 'flush'], project: 'session' },
})

/** Workspace 实体投影成纯数据（它是 class，getter 不会被 JSON.stringify 带出来）。 */
export function projectWorkspace (w) {
  if (!w || typeof w !== 'object') return null
  const read = (fn, d) => { try { return fn() } catch (e) { return d } }
  const ids = read(() => w.sessionIds, [])
  return {
    id: read(() => String(w.id), null),
    path: read(() => String(w.path), null),
    title: read(() => String(w.title), null),
    createdAt: read(() => (w.createdAt === undefined ? null : String(w.createdAt)), null),
    updatedAt: read(() => (w.updatedAt === undefined ? null : String(w.updatedAt)), null),
    sessionIds: Array.isArray(ids) ? ids.slice() : (ids ? [...ids] : []),
  }
}

/**
 * Session 投影成纯数据（同上：它是 class，还带私有 log / surfaceManager）。
 * ★ 只取**公开且稳定**的三样：id / seq / header。header 本身就是
 *   「detached, deep-frozen creation metadata」（dsh-session index.d.ts:110-117），天生是纯数据。
 */
export function projectSession (s) {
  if (!s || typeof s !== 'object') return null
  const read = (fn, d) => { try { return fn() } catch (e) { return d } }
  const h = read(() => s.header, null)
  return {
    id: read(() => String(s.id), null),
    seq: read(() => Number(s.seq), null),
    header: h ? {
      version: (h.version === undefined ? null : h.version),
      id: (h.id === undefined ? null : String(h.id)),
      createdAt: (h.createdAt === undefined ? null : h.createdAt),
      cwd: (h.cwd === undefined ? null : h.cwd),
      parentSession: (h.parentSession === undefined ? null : String(h.parentSession)),
      origin: (h.origin === undefined ? null : h.origin),
      agentPreset: (h.agentPreset === undefined ? null : h.agentPreset),
      delegationDepth: (h.delegationDepth === undefined ? null : h.delegationDepth),
      isSeeded: h.isSeeded === undefined ? null : !!h.isSeeded,
    } : null,
  }
}

export function makeServiceGateway (opts) {
  const o = opts || {}
  const getService = typeof o.getService === 'function' ? o.getService : () => null
  const log = typeof o.log === 'function' ? o.log : () => {}
  const warned = new Set()

  function live (name) {
    try {
      return getService(name) || null
    } catch (e) {
      if (!warned.has(name)) {
        warned.add(name)
        log('取服务 ' + name + ' 抛了：' + String((e && e.message) || e) + '（这次按「没有这个服务」处理，本条服务不再重复报）')
      }
      return null
    }
  }

  function allowedNames (name) {
    const spec = SERVICE_ALLOWLIST[name]
    return spec ? spec.methods.concat(spec.properties || []) : []
  }

  function describe () {
    const out = {}
    for (const name of Object.keys(SERVICE_ALLOWLIST)) {
      const spec = SERVICE_ALLOWLIST[name]
      const svc = live(name)
      const names = []
      if (svc) {
        for (const m of spec.methods) {
          try { if (typeof svc[m] === 'function') names.push(m) } catch (e) { /* getter 抛 = 此刻不可用，如实不列 */ }
        }
        for (const pr of (spec.properties || [])) {
          try { if (svc[pr] !== undefined) names.push(pr) } catch (e) { /* 同上 */ }
        }
      }
      out[name] = names
    }
    return out
  }

  /** 投影 + JSON 闸门：能跨进程才算「拿到真值」。跨不了就抛，绝不返回半个对象。 */
  function toWire (name, method, value) {
    let v = value
    if (name === 'workspaceRegistry') {
      v = Array.isArray(value) ? value.map(projectWorkspace) : projectWorkspace(value)
    } else if (name === 'sessions') {
      v = Array.isArray(value) ? value.map(projectSession) : projectSession(value)
    }
    if (v === undefined) return null
    let text
    try { text = JSON.stringify(v) } catch (e) {
      throw codeError('service/not-serializable', 'host-error',
        name + '/' + method + ' 的返回值不能跨进程：' + String((e && e.message) || e),
        { name, method, reason: String((e && e.message) || e) })
    }
    if (text === undefined) return null
    try { return JSON.parse(text) } catch (e) {
      throw codeError('service/not-serializable', 'host-error', name + '/' + method + ' 的返回值 JSON 化失败：' + String((e && e.message) || e), { name, method })
    }
  }

  async function call (args) {
    const a = (args && typeof args === 'object') ? args : {}
    const name = String(a.name || '').trim()
    const method = String(a.method || '').trim()
    const spec = SERVICE_ALLOWLIST[name]
    if (!spec) {
      throw codeError('service/unknown-service', 'bad-request',
        'service/call 不认识服务 ' + JSON.stringify(name) + '（白名单：' + Object.keys(SERVICE_ALLOWLIST).join(' / ') + '）',
        { name, allowed: Object.keys(SERVICE_ALLOWLIST) })
    }
    const allowed = allowedNames(name)
    if (!method || allowed.indexOf(method) < 0) {
      throw codeError('service/unknown-method', 'bad-request',
        'service/call 不认识方法 ' + JSON.stringify(name + '/' + method) + '（该服务可调：' + allowed.join(', ') + '）',
        { name, method, allowed })
    }
    const svc = live(name)
    if (!svc) {
      throw codeError('service/unavailable', 'unavailable',
        '宿主此刻没有 ' + name + ' 服务（注意：这与「方法不存在」是两件事 —— 服务本身没就绪）', { name, method })
    }
    const list = Array.isArray(a.args) ? a.args : ((a.args === undefined || a.args === null) ? [] : null)
    if (list === null) {
      throw codeError('service/bad-request', 'bad-request', 'service/call 的 args 必须是数组（拿到 ' + (typeof a.args) + '）', { name, method })
    }
    const isProp = (spec.properties || []).indexOf(method) >= 0

    let value
    try {
      if (isProp) {
        value = svc[method]
      } else if (name === 'sessions' && method === 'flush') {
        /* ★ 唯一一处签名适配（必须明说）：原生 flush(session) 收 **Session 对象**，
           而对象跨不了进程。所以这里按 [sessionId] 解析成活会话再调 —— 语义不变。 */
        const sid = String(list[0] || '').trim()
        if (!sid) throw codeError('service/bad-request', 'bad-request', 'sessions/flush 需要 [sessionId]（Session 对象跨不了进程，这里按 id 解析）', { name, method })
        const sess = (typeof svc.get === 'function') ? svc.get(sid) : null
        if (!sess) throw codeError('session/not-found', 'not-found', '没有这个活会话：' + sid + '（flush 只能刷活会话）', { sessionId: sid })
        value = svc.flush(sess)
      } else {
        const fn = svc[method]
        if (typeof fn !== 'function') {
          throw codeError('service/method-missing', 'unavailable', name + '/' + method + ' 此刻不是函数（服务在，方法不在）', { name, method })
        }
        value = fn.apply(svc, list)
      }
      if (value && typeof value.then === 'function') value = await value
    } catch (e) {
      if (e && typeof e.code === 'string' && e.code.indexOf('service/') === 0) throw e
      if (e && typeof e.code === 'string' && e.code === 'session/not-found') throw e
      throw codeError('service/threw', 'host-error',
        name + '/' + method + ' 自己抛了：' + String((e && e.message) || e),
        { name, method, cause: (e && e.stage) || null })
    }
    return toWire(name, method, value)
  }

  return { describe, call, allowlist: SERVICE_ALLOWLIST }
}
/* ───────────── 工具 output 声明：render 由 DSH 侧自己造 ───────────── */

/** 没有 schema 时的兜底：无约束 JSON（DSH 的 assertSupportedJsonSchema 明确接受这种注解式 schema）。 */
export const DEFAULT_OUTPUT_SCHEMA = Object.freeze({ type: 'object', additionalProperties: true, properties: {} })

/**
 * 把 v4 传来的 schema 归一成 **DSH 的方言**。
 *
 * ★ 为什么要归一（本机实测，不是猜）：
 *   DSH 的 assertSupportedJsonSchema（dsh-tools lib/types/json-schema.js:147-165、:259-263）
 *   要求 required 是**数组**、且**只能写在 object 节点上**：
 *     · {type:'string', required:true}  → 违规：required is not supported on type "string"
 *     · required: 'x' 或 required:[1]   → 违规：required must be an array of strings
 *     · required:['nope'] 点名不存在的属性 → 违规：names "nope" which is not in properties
 *   而 v4（aurabot tools.js:9）用的是标准写法 {type:'object', properties, required:[]}
 *   —— 两种都可能来。所以这里**两种都收**：把属性上的布尔 required 提升成父级的数组。
 *   ★ 不猜别的关键字；其余不合法留给 DSH 自己报（它的报错比我们能编的精确）。
 *
 * 返回 { schema, notes }：notes 是「改了什么」的逐条记录（随回执交给 v4，不许吞）。
 */
export function normalizeOutputSchema (schema) {
  const notes = []
  const walk = (node, pathStr) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      if (node !== undefined) notes.push(pathStr + ' 不是 schema 对象（已按无约束处理）')
      return { schema: {}, selfRequired: false }
    }
    const out = {}
    let selfRequired = false
    for (const k of Object.keys(node)) {
      const v = node[k]
      if (k === 'required' && typeof v === 'boolean') {
        /* ★ 方言 A：required 写在属性上。留着会被 DSH 判违规 —— 提升到父级 required[]。 */
        selfRequired = v === true
        notes.push(pathStr + '.required=' + String(v) + ' → 改成父级 required[]')
        continue
      }
      out[k] = v
    }
    if (out.properties && typeof out.properties === 'object' && !Array.isArray(out.properties)) {
      const props = {}
      const req = Array.isArray(out.required) ? out.required.filter((x) => typeof x === 'string') : []
      for (const name of Object.keys(out.properties)) {
        const r = walk(out.properties[name], pathStr + '.properties.' + name)
        props[name] = r.schema
        if (r.selfRequired && req.indexOf(name) < 0) req.push(name)
      }
      out.properties = props
      /* ★★ 这里原来写成「只有原本就有 required 数组才写回」——
         于是「属性上写 required:true、父级没数组」这种方言（正是任务书说的那种）
         提升出来了却**写不回去**，必填信息静默丢失。自测抓到（2026-11-14）。
         现在：无论有没有数组，都以 req 为准写回。 */
      const hadArray = Array.isArray(out.required)
      const kept = req.filter((n) => Object.prototype.hasOwnProperty.call(props, n))
      if (hadArray && kept.length !== out.required.length) {
        notes.push(pathStr + '.required 去掉了 ' + (out.required.length - kept.length) + ' 个不在 properties 里的名字')
      }
      if (kept.length) out.required = kept
      else delete out.required
    }
    if (out.items) {
      const ir = walk(out.items, pathStr + '.items')
      out.items = ir.schema
      /* ★ 数组元素的父级没有「属性名」可提升 —— 布尔 required 到这儿是真的没法表达，
         只能丢，并且**记下来**（沉默地丢字段比丢字段本身更坏）。 */
      if (ir.selfRequired) notes.push(pathStr + '.items 上有布尔 required（数组元素无法提升，已丢弃）')
    }
    if (Array.isArray(out.oneOf)) {
      out.oneOf = out.oneOf.map((c, i) => {
        const or = walk(c, pathStr + '.oneOf[' + i + ']')
        if (or.selfRequired) notes.push(pathStr + '.oneOf[' + i + '] 上有布尔 required（无法提升，已丢弃）')
        return or.schema
      })
    }
    /* ★★★ 这里必须把 selfRequired **往上带**：布尔 required 的语义是「我这个属性在父级里是必填的」，
       所以它属于**父级的 required[]**。原来这里写死 false，于是整条归一白做
       （2026-11-14 自测当场抓到：schema.properties.a.required 被删了，但父级没拿到 'a' —— 必填信息静默丢失）。 */
    return { schema: out, selfRequired }
  }
  const r = walk(schema, 'schema')
  // 根上没人能提升它 —— 如实记一笔，别让它无声消失
  if (r.selfRequired) notes.push('schema 根上的 required 是布尔（没有父级可提升，已丢弃）')
  return { schema: r.schema, notes }
}

/**
 * 从 exec 的 args 里造出 DSH 能吃的 output（契约 §3.4）。
 *
 * ★ 根因（一手证据，2026-11-14）：
 *   v4 的 /api/overview 里 lastError = tool "aurabot:report_to_lead" must declare
 *   output { schema, render, presentationMeta? }，抛出点在 dsh-tools lib/index.js:2776 ——
 *   它要求 output.render **是函数**。函数跨不了进程，v4 永远给不出来；
 *   而 v4 的 bridge-tools.mjs:55-65 **连 output 都没发**（只发 name/description/parameters/timeoutMs）。
 *   ⇒ 结论唯一：output 必须由**宿主自己造**。v4 给了 schema 就用它的，没给就用无约束兜底。
 *
 * ★ render 用契约 §3.4 给的那一行（字符串原样、其余 JSON）。**不自己加花活**：
 *   多一层「猜 value.message」的聪明，等于把 v4 的展示语义搬一份到宿主来漂。
 */
export function buildToolOutput (args) {
  const a = (args && typeof args === 'object') ? args : {}
  const raw = a.output
  const notes = []
  let schema = DEFAULT_OUTPUT_SCHEMA
  let source = 'default'
  if (raw && typeof raw === 'object' && raw.schema && typeof raw.schema === 'object') {
    const norm = normalizeOutputSchema(raw.schema)
    schema = norm.schema
    source = 'args.output.schema'
    for (const n of norm.notes) notes.push(n)
  } else if (raw && typeof raw === 'object') {
    notes.push('args.output 存在但没有 schema 对象（按无约束兜底）')
  }
  if (raw && typeof raw === 'object' && raw.render !== undefined) {
    /* ★ 显式记下来：函数跨不了进程，v4 就算发了也到不了这儿 —— 能到说明它是数据。 */
    notes.push('args.output.render 已被宿主忽略（render 必须是本进程里的函数，跨进程传不了）')
  }
  if (source === 'default' && a.schema && typeof a.schema === 'object') {
    const norm = normalizeOutputSchema(a.schema)
    schema = norm.schema
    source = 'args.schema'
    for (const n of norm.notes) notes.push(n)
  }
  return {
    output: {
      schema,
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    },
    source,
    notes,
  }
}

/* ───────────── followup/steer 的失败解释：r.error.code 必须带出来 ───────────── */

/**
 * 把 resolveAgent 的失败翻译成 why + code（契约 §3.5 的后半句）。
 *
 * ★ 缺陷：原来只有 String(e.message) 和一句「resolveAgent 也没恢复出来」——
 *   v4 那边把 {ok:false, error:{code,message}} 放进返回值时，**code 被整条吞掉**。
 *   于是「会话不存在」「宿主没这个服务」「内部抛错」在 why 里长得一样。
 *
 * ★ 这里认三种形状（都会遇到，不许只认一种）：
 *   ① 抛出的 Error（catch 分支）—— 读 e.code / e.error.code / e.message
 *   ② 返回值 {ok:false, error:{code,message}}
 *   ③ 返回值是一个没有 agent 的对象 —— 如实说它有哪些键，不猜
 */
export function explainResumeFailure (baseWhy, r) {
  const base = String(baseWhy || '找不到可以叫醒的 agent')
  const pick = (obj, key) => {
    try {
      const v = obj && obj[key]
      return (typeof v === 'string' && v.trim()) ? v.trim() : ''
    } catch (e) { return '' }
  }
  let code = ''
  let msg = ''
  let detail = null
  if (r && typeof r === 'object') {
    const inner = (r.error && typeof r.error === 'object') ? r.error : null
    code = pick(inner, 'code') || pick(r, 'code')
    msg = pick(inner, 'message') || pick(r, 'message') || pick(r, 'why')
    if (inner) detail = { resolveError: { code: pick(inner, 'code') || null, message: pick(inner, 'message') || null } }
  }
  if (!msg && r instanceof Error) msg = String(r.message || '')
  if (!msg && r !== undefined && r !== null && typeof r !== 'object') msg = String(r)
  if (!msg) {
    let keys = null
    try { keys = (r && typeof r === 'object') ? Object.keys(r) : null } catch (e) { keys = null }
    msg = (keys && keys.length)
      ? 'resolveAgent 返回了一个不带 agent 的对象（键：' + keys.join(', ') + '）'
      : 'resolveAgent 没有返回 agent'
    detail = detail || { resolveKeys: keys }
  }
  return { why: base + '；恢复失败：' + msg.slice(0, 200), code: code || 'session/resume-failed', detail }
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

/* ══ agent-soul 本体：路径解析 / 拉起 / 回执（2026-11-13）═══════════════
   ★ 这三件都做成纯的、可测的：不依赖 ctx，测试脚本里能直接调。
   ★ start 端点与守护（startAgentSoulKeeper）走同一条 spawn 路径 —— 只有一份实现，
     免得「面板点启动」和「守护自动拉」两处行为漂移。
   ─────────────────────────────────────────────────────────────────── */

/** 解析 exe 路径与存在性（不产生副作用）。 */
export function agentSoulPlan (cfg) {
  const raw = String((cfg && cfg.agentSoulRoot) || DEFAULTS.agentSoulRoot || '')
  const root = raw.replace(/\\/g, '/').replace(/\/+$/, '')
  /* ★ 2026-11-20：exe 位置**两种都认**。
     开发树里是 <root>/build/AgentSoul.exe；而生产安装（make-dist 出来的 portable/Setup）
     把壳放在 <root>/AgentSoul.exe，没有 build/ 目录 —— 只认前者的话，
     「面板点启动」在真实安装上恒回「找不到 …\\build\\AgentSoul.exe」。
     ★ 判据：先找 build/，没有再找根；两个都没有才算不存在（错误信息里报根路径）。 */
  const candidates = root ? [path.join(root, 'build', 'AgentSoul.exe'), path.join(root, 'AgentSoul.exe')] : [];
  let exe = candidates[0] || '';
  let exists = false;
  for (const c of candidates) {
    try { if (fs.existsSync(c)) { exe = c; exists = true; break; } } catch { /* 下一个 */ }
  }
  /* ★ stop 用镜像名杀进程：默认取 exe 的文件名（AgentSoul.exe），
     留 agentSoulImage 覆盖口 —— 将来改名/多实例时不必改代码。 */
  const image = String((cfg && cfg.agentSoulImage) || '').trim() || (exe ? path.basename(exe) : 'AgentSoul.exe')
  return { root, exe, exists, image }
}

/**
 * 拉起 agent-soul 本体（build/AgentSoul.exe）。
 * ★ detached + stdio:ignore + unref：它必须活过本回合、活过 DSH 重启。
 * ★ cwd = agent-soul 根目录，不是 build/ —— dataDir 跟着 cwd 走。
 */
export function spawnAgentSoul (cfg, options = {}) {
  const p = agentSoulPlan(cfg)
  if (!p.root) return { ok: false, error: 'agentSoulRoot 没配（DEFAULTS 应有 D:/AI/agent-soul）', root: p.root, exe: p.exe, exists: p.exists }
  if (!p.exists) return { ok: false, error: '找不到 ' + p.exe, root: p.root, exe: p.exe, exists: false }
  const spawnFn = typeof options.spawn === 'function' ? options.spawn : spawn
  let marker
  if (Object.hasOwn(options, 'marker')) {
    marker = options.marker
    if (typeof marker !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(marker)) {
      return { ok: false, error: 'spawn-failed', root: p.root, exe: p.exe, exists: true }
    }
  }
  try {
    if (marker === undefined) marker = createBridgeMarker()
    const child = spawnFn(p.exe, [], {
      cwd: p.root, detached: true, stdio: 'ignore', windowsHide: true,
      env: { ...process.env, AGENT_SOUL_MANAGER_MARKER: marker },
    })
    if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0 || typeof child.unref !== 'function') {
      return { ok: false, error: 'spawn-failed', root: p.root, exe: p.exe, exists: true }
    }
    child.unref()
    return { ok: true, pid: child.pid, root: p.root, exe: p.exe, exists: true }
  } catch {
    return { ok: false, error: 'spawn-failed', root: p.root, exe: p.exe, exists: true }
  }
}

export const MANAGEMENT_ROUTES = Object.freeze([
  Object.freeze({ path: '/agent-soul/status', method: 'GET', readOnly: true }),
  Object.freeze({ path: '/agent-soul/probe', method: 'GET', readOnly: true }),
  Object.freeze({ path: '/agent-soul/start', method: 'POST', readOnly: false }),
  Object.freeze({ path: '/agent-soul/stop', method: 'POST', readOnly: false }),
  Object.freeze({ path: '/agent-soul/restart', method: 'POST', readOnly: false }),
])
const MANAGEMENT_BODY_LIMIT = 16 * 1024
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/
function safeEqual(a, b) { const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || '')); return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y) }
export function isLoopbackAddress(a) { return /^(127\.0\.0\.1|::1|0:0:0:0:0:0:0:1|::ffff:127\.0\.0\.1)$/i.test(String(a || '').replace(/^\[|\]$/g, '')) }
function originOf(v) { try { const u = new URL(String(v || '')); if (!/^https?:$/.test(u.protocol) || u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return null; return u.origin } catch { return null } }
function refererOriginOf(v) { try { const u = new URL(String(v || '')); if (!/^https?:$/.test(u.protocol) || u.username || u.password) return null; return u.origin } catch { return null } }
export function makeManagementSecurity(o = {}) { const token = String(o.token || ''); const csrf = String(o.csrfNonce || crypto.randomBytes(32).toString('base64url')); const origin = originOf(o.origin); const used = new Set(); return { expectedOrigin: origin, csrfNonce: csrf, configured: !!(token && origin), tokenMatches: v => safeEqual(v, token), consumeCsrf(v) { const n = String(v || ''); if (!n || used.has(n) || !safeEqual(n, csrf)) return false; used.add(n); return true } } }
export function validateManagementRequest(req, expectedMethod, sec) { const method = String(req && req.method || '').toUpperCase(); if (method !== expectedMethod) return { ok:false, status:405, headers:{ Allow:expectedMethod }, code:'method-not-allowed' }; const remote = String(req && req.socket && req.socket.remoteAddress || req && req.connection && req.connection.remoteAddress || ''); if (!isLoopbackAddress(remote)) return { ok:false, status:403, code:'loopback-required' }; const origin = originOf(req && req.headers && req.headers.origin); if (!sec || !sec.configured || origin !== sec.expectedOrigin) return { ok:false, status:403, code:'origin-denied' }; const ref = req && req.headers && req.headers.referer; if (ref !== undefined && refererOriginOf(ref) !== sec.expectedOrigin) return { ok:false, status:403, code:'referer-denied' }; const m = /^Bearer[ \t]+(.+)$/.exec(String(req && req.headers && req.headers.authorization || '')); if (!m || !sec.tokenMatches(m[1])) return { ok:false, status:401, code:'local-admin-required' }; return { ok:true } }
export async function readManagementBody(req, limit = MANAGEMENT_BODY_LIMIT) { const h = req && req.headers || {}; if (String(h['content-type'] || '').split(';',1)[0].trim().toLowerCase() !== 'application/json') return { ok:false,status:400,code:'json-required' }; if (Number(h['content-length']) > limit) return { ok:false,status:413,code:'body-too-large' }; if (req && req.body !== undefined) { const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body); if (Buffer.byteLength(raw) > limit) return {ok:false,status:413,code:'body-too-large'}; try { const b=JSON.parse(raw); return b && typeof b === 'object' && !Array.isArray(b) ? {ok:true,body:b} : {ok:false,status:400,code:'object-required'} } catch { return {ok:false,status:400,code:'invalid-json'} } } if (!req || typeof req.on !== 'function') return {ok:false,status:400,code:'body-unavailable'}; return await new Promise(resolve => { let raw='', n=0, done=false; const end=v=>{if(!done){done=true;resolve(v)}}; req.on('data',c=>{if(done)return;n+=Buffer.byteLength(c);if(n>limit)end({ok:false,status:413,code:'body-too-large'});else raw+=c}); req.on('end',()=>{if(done)return;try{const b=JSON.parse(raw||'{}');end(b&&typeof b==='object'&&!Array.isArray(b)?{ok:true,body:b}:{ok:false,status:400,code:'object-required'})}catch{end({ok:false,status:400,code:'invalid-json'})}}); req.on('error',()=>end({ok:false,status:400,code:'body-read-failed'})) }) }
export function makeRequestLedger(o = {}) { const ttl=Number(o.ttlMs)>0?Number(o.ttlMs):600000; const max=Number(o.max)>0?Number(o.max):256; const rows=new Map(); const prune=()=>{const t=Date.now();for(const[k,v]of rows)if(v.at+ttl<t)rows.delete(k);while(rows.size>max)rows.delete(rows.keys().next().value)}; return { begin(route,id,semantic,work) { prune(); const k=String(id), hit=rows.get(k); if(hit){if(hit.route!==String(route) || hit.semantic!==semantic)return Promise.resolve({conflict:true});return hit.promise.then(r=>Object.assign({},r,{replayed:!!hit.done}))} const row={at:Date.now(),route:String(route),semantic,done:false}; row.promise=Promise.resolve().then(work).then(r=>{row.done=true;return r}); rows.set(k,row); return row.promise }, size:()=>rows.size, clear:()=>rows.clear() } }
function canonicalPath(v) { try { return fs.realpathSync.native ? fs.realpathSync.native(String(v || '')) : fs.realpathSync(String(v || '')) } catch { return path.resolve(String(v || '')) } }
function newManagementId() { return crypto.randomBytes(16).toString('hex') }
export function makeAgentSoulLifecycle(o = {}) { const plan=o.plan||{}; const now=o.now||Date.now; const health=o.health|| (async()=>({ok:false})); const spawnFn=o.spawn|| (async()=>({ok:false,error:'spawn unavailable'})); const inspect=o.inspect|| (async()=>({ok:false,reason:'identity-verification-unavailable'})); const terminate=o.terminate|| (async()=>({ok:false})); const waitUp=o.waitUp|| (async()=>({ok:false})); const waitDown=o.waitDown|| (async()=>({down:false})); const state={mutex:Promise.resolve(),instanceRecord:null,keeperSuppressedUntil:0,lastSpawn:0}; const lock=async fn=>{const p=state.mutex;let release;state.mutex=new Promise(r=>{release=r});await p;try{return await fn()}finally{release()}}; const check=async(r)=>{const x=await inspect(r.pid,r);return x&&x.ok!==false?x:null}; const start=()=>lock(async()=>{const h=await health();if(h&&h.ok){if(!state.instanceRecord)return{ok:false,phase:'capture-target',reason:'identity-verification-unavailable',started:false};const x=await check(state.instanceRecord);return x?{ok:true,already:true,started:false,instance:state.instanceRecord,health:h}:{ok:false,phase:'capture-target',reason:'identity-mismatch',started:false}} if (o.identityAvailable === false) return {ok:false,phase:'spawn',reason:'identity-verification-unavailable',started:false}; const marker=newManagementId(), realpath=canonicalPath(plan.exe);const sp=await spawnFn({marker,realpath});if(!sp||!sp.ok)return{ok:false,phase:'spawn',reason:sp&&sp.error||'spawn-failed',started:false};const rec={instanceId:newManagementId(),pid:Number(sp.pid),realpath,startedAt:null,marker};const x=await check(rec),up=await waitUp();const uh=up&&up.health||await health();if(!x||!up||!up.ok||!uh||Number(uh.pid)!==rec.pid||!Number.isFinite(Number(x.startedAt))||x.realpath!==realpath||x.marker!==marker)return{ok:false,phase:'confirm-new-instance',reason:'identity-mismatch',started:false,pid:rec.pid};rec.startedAt=Number(x.startedAt);state.instanceRecord=Object.freeze(rec);return{ok:true,started:true,instance:state.instanceRecord,health:uh}}); const stop=()=>lock(async()=>{const r=state.instanceRecord,h=await health();if(!r)return h&&h.ok?{ok:false,phase:'capture-target',reason:'identity-verification-unavailable',stopped:false}:{ok:true,already:true,stopped:false};const x=await check(r);if(!x)return{ok:false,phase:'identity-check',reason:'identity-verification-unavailable',stopped:false};if(x.realpath!==r.realpath||Number(x.startedAt)!==Number(r.startedAt)||x.marker!==r.marker||h&&h.ok&&Number(h.pid)!==r.pid)return{ok:false,phase:'identity-check',reason:'identity-mismatch',stopped:false};const k=await terminate(r.pid,r),d=await waitDown(r.pid,r),a=await health();if(!k||k.ok===false||!d||!d.down||a&&a.ok)return{ok:false,phase:'confirm-down',reason:'timeout-or-still-alive',stopped:false};state.instanceRecord=null;return{ok:true,stopped:true,down:true,pid:r.pid}}); const restart=()=>lock(async()=>{const s=await stopUnlocked();if(!s.ok||!s.stopped&&!s.already)return{ok:false,phase:s.phase||'stop',reason:s.reason||'stop-failed',started:false,restarted:false,stopped:s};const a=await startUnlocked();return Object.assign({ok:!!a.ok,restarted:!!a.ok,stopped:s,started:!!a.started},a)}); const startUnlocked=async()=>{const h=await health();if(h&&h.ok)return{ok:true,already:true,started:false,instance:state.instanceRecord};if (o.identityAvailable === false) return {ok:false,phase:'spawn',reason:'identity-verification-unavailable',started:false}; const marker=newManagementId(),realpath=canonicalPath(plan.exe),sp=await spawnFn({marker,realpath});if(!sp||!sp.ok)return{ok:false,phase:'spawn',reason:sp&&sp.error||'spawn-failed',started:false};const rec={instanceId:newManagementId(),pid:Number(sp.pid),realpath,startedAt:null,marker},x=await check(rec),up=await waitUp(),uh=up&&up.health||await health();if(!x||!up||!up.ok||!uh||Number(uh.pid)!==rec.pid||!Number.isFinite(Number(x.startedAt))||x.realpath!==realpath||x.marker!==marker)return{ok:false,phase:'confirm-new-instance',reason:'identity-mismatch',started:false,pid:rec.pid};rec.startedAt=Number(x.startedAt);state.instanceRecord=Object.freeze(rec);return{ok:true,started:true,instance:state.instanceRecord,health:uh}}; const stopUnlocked=async()=>{const r=state.instanceRecord,h=await health();if(!r)return h&&h.ok?{ok:false,phase:'capture-target',reason:'identity-verification-unavailable',stopped:false}:{ok:true,already:true,stopped:false};const x=await check(r);if(!x)return{ok:false,phase:'identity-check',reason:'identity-verification-unavailable',stopped:false};if(x.realpath!==r.realpath||Number(x.startedAt)!==Number(r.startedAt)||x.marker!==r.marker||h&&h.ok&&Number(h.pid)!==r.pid)return{ok:false,phase:'identity-check',reason:'identity-mismatch',stopped:false};const k=await terminate(r.pid,r),d=await waitDown(r.pid,r),a=await health();if(!k||k.ok===false||!d||!d.down||a&&a.ok)return{ok:false,phase:'confirm-down',reason:'timeout-or-still-alive',stopped:false};state.instanceRecord=null;return{ok:true,stopped:true,down:true,pid:r.pid}}; return {state,record:()=>state.instanceRecord,start,stop,restart,suppress:ms=>{state.keeperSuppressedUntil=now()+Math.max(0,Number(ms)||0);return state.keeperSuppressedUntil},keeperProbe:async(auto,gap)=>{const h=await health();if(h&&h.ok)return{alive:true,spawned:false};if(!auto||now()<state.keeperSuppressedUntil||now()-state.lastSpawn<Number(gap||90000))return{alive:false,spawned:false};return lock(async()=>{const again=await health();if(again&&again.ok)return{alive:true,spawned:false};const r=await startUnlocked();if(r.started)state.lastSpawn=now();return Object.assign({alive:false,spawned:!!r.started},r)})} } }

/** 把 apply 走到哪一步写进磁盘。写不出来也不许影响任何东西。 */
export function writeApplyReceipt (cfg, obj) {
  try {
    const dir = String((cfg && cfg.receiptDir) || DEFAULTS.receiptDir)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'apply.json'), JSON.stringify(obj, null, 2), 'utf8')
  } catch (e) { /* 回执是证据，不是功能 */ }
}

// ─────────────────────────── 插件本体 ───────────────────────────

export function apply (ctx, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) }
  // ★ 2026-11-13：DSH 起来之后，确保 agent-soul 也在 —— 连不上就把它拉起来。
  //   放在 enabled 判断之前：即使本插件被关掉，宿主也该活着（那是独立进程）。
  try { startAgentSoulKeeper(cfg) } catch (e) { console.warn(TAG + ' 守护启动失败: ' + (e && e.message)) }

  if (cfg.enabled === false) return

  let disposed = false
  /**
   * ★★★ 2026-11-13：webServer 的 origin 缓存。
   *   为什么必须缓存：`ctx.webServer` 在 apply 的**外层**作用域里会抛
   *   `cannot get property "webServer" without inject` —— 只有 `cx.inject(['webServer'], cb)`
   *   的回调里那个 scope 才看得见它。而 `sendHello` / `advertisedUrlOf` 都在外层。
   *   所以：在回调里抓到就存这里，外层只读这个变量。
   */
  let webServerOrigin = null

  /* ══ 管理端点：/agent-soul/status | start | stop | restart | probe ══════════
     为什么放在 host 而不是让浏览器直接 fetch 7310：
     · 启动/关闭/重启要**起进程、杀进程**，浏览器做不到；
     · 同源请求没有 CORS 问题。

     ★★ 2026-11-13 修 F1（真因，用真 cordis 复现过）：
       这段原来写作 if (ctx.webServer) { … }，而文件末尾的 export default { name, apply }
       会把模块级的 export const inject = ['webServer'] **整个盖掉** ——
       Loader.unwrapExports()（cordis-plugin-loader lib/index.js:746-751）取的是
       exports.default ?? exports。于是 Cordis 认为本插件没声明任何依赖，
       访问 ctx.webServer 直接抛：cannot get property "webServer" without inject。
       apply 崩 → Loader._start 的 catch → _dispose(fiber) → 已注册路由与 ws 一起回收
       → 「端点全 404 + control.connected=0」同时出现，一次都不例外。
       ⇒ 三条一起改：① default 里补 inject（文件末尾）② 用 ctx.inject 拿服务（本函数）
         ③ 每步写回执（stages），事后能查「走到哪一步、哪一步没做」。
     ─────────────────────────────────────────────────────────────────────── */
  function wireAdmin (cx, io) {
    if (typeof cx.inject !== 'function') { io.mark('no-ctx.inject'); return }
    /* ★ 用 ctx.inject 而不是直接读 ctx.webServer：它会**等到服务可用**才回调，
       而且这条 API 不依赖模块级 inject 是否被 default 盖掉。三种取法都试一遍。 */
    cx.inject(['webServer'], (scope) => {
      let wsv = null
      try { wsv = scope.webServer } catch (e) { io.mark('scope.webServer-threw') }
      if (!wsv) { try { wsv = scope.get('webServer') } catch (e) { io.mark('scope.get-threw') } }
      if (!wsv) { try { wsv = cx.get('webServer') } catch (e) { io.mark('cx.get-threw') } }
      // 管理 token 与 v4 X-Soul-Token 分离；先初始化，避免 origin 捕获同步回调时落入 TDZ。
      const adminToken = () => {
        const direct = String(cfg.localAdminToken || '')
        if (direct) return direct
        const file = String(cfg.localAdminTokenFile || '')
        if (!file) return ''
        try { return String(fs.readFileSync(file, 'utf8')).trim() } catch { return '' }
      }
      let adminSecurity = makeManagementSecurity({ token: adminToken(), origin: webServerOrigin || '', csrfNonce: cfg.localAdminCsrfNonce })
      // ★★★ 2026-11-13：`getOrigin()` 在**监听器还没绑端口**时会直接抛：
      //   `webserver: origin read before the listener bound a port`（dsh-host-webserver:314-317）。
      //   而 ctx.inject 的回调可能比 listen() 早 —— 于是原来那个 try/catch 把它吞成了永久 null。
      //   所以这里**重试**：每 250ms 一次、最多 20 次（5 秒）；成功就 cache 并补发 hello。
      let tries = 0
      const captureOrigin = () => {
        tries += 1
        try {
          if (wsv && typeof wsv.getOrigin === 'function') {
            const o0 = String(wsv.getOrigin() || '').trim()
            if (/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(o0)) {
              webServerOrigin = o0
              adminSecurity = makeManagementSecurity({ token: adminToken(), origin: o0, csrfNonce: cfg.localAdminCsrfNonce })
              io.mark('origin@' + o0)
              if (st && st.ws && st.ws.open) {
                try { sendHello(st.ws); log('补发 hello（dshBaseUrl=' + o0 + '）') } catch { /* 下一轮 onopen 还会发 */ }
              }
              return
            }
          }
        } catch { /* 还没 listen，下一轮再试 */ }
        if (tries < 20) setTimeout(captureOrigin, 250)
        else io.mark('origin-timeout')
      }
      captureOrigin()
      if (!wsv || typeof wsv.register !== 'function') {
        io.mark('no-webServer')
        io.warn('拿不到 webServer 服务，/agent-soul/* 不会挂（面板会 404）')
        return
      }

      const AS = 'http://127.0.0.1:7310'
      const jout = (res, code, obj) => {
        try {
          const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
          if (code === 405) headers.Allow = obj && obj.allow || ''
          res.writeHead(code, headers)
          res.end(JSON.stringify(obj))
        } catch (e) { /* 响应已经发过 / 对端断了：不许把异常带回宿主 */ }
      }

      /* ★ token 只用来发请求头：不打印、不回给浏览器、不写进回执。 */
      const tokenPath = String(cfg.agentSoulTokenFile || '').trim() ||
        path.join(plan.root || DEFAULTS.agentSoulRoot, 'data', 'token.txt')
      const readToken = () => {
        try { return String(fs.readFileSync(tokenPath, 'utf8')).trim() } catch (e) { return '' }
      }

      /* ★ 超时不能抠：/api/overview 实测要 4.5s（它要扫 1.1GB data）。
         把「慢」判成「死」会直接引出两个后果：面板显示未运行、守护去拉起重复实例。 */
      const getJson = async (p, ms, withToken) => {
        const ctl = new AbortController()
        const tm = setTimeout(() => ctl.abort(), ms || 2500)
        try {
          const headers = {}
          if (withToken) { const t = readToken(); if (t) headers['X-Soul-Token'] = t }
          const r = await fetch(AS + p, { signal: ctl.signal, headers })
          clearTimeout(tm)
          const b = await r.json().catch(() => null)
          return { ok: r.ok, status: r.status, body: b }
        } catch (e) { clearTimeout(tm); return { ok: false, error: String((e && e.message) || e) } }
      }

      /* ★★ 2026-11-13：/api/health 偶尔会慢（v4 要数 1169 个会话，实测有过 >5s）。
         "慢"不许被读成"没跑" —— 面板每 5 秒轮询一次，一次抖动就会红一下，那是假故障。
         口径：成功就刷新缓存；失败但 20 秒内有过成功读数 → 回上次的值并标 stale；
         超过 20 秒没有成功读数才判「没在跑」（真死了也必须 20 秒内看见）。 */
      let lastGood = null
      const healthCore = async () => {
        const h = await getJson('/api/health', 5000)
        const b = h.body
        return (h.ok && b && typeof b === 'object')
          ? {
              ok: true,
              pid: (b.pid === undefined ? null : b.pid),
              sessions: (b.sessions === undefined ? null : b.sessions),
              llmReady: !!b.llmReady,
              llmUsable: !!b.llmUsable,
              keySource: b.keySource || null,
              version: b.version || null,
            }
          : { ok: false, error: h.error || ('HTTP ' + h.status) }
      }
      const health = async () => {
        const h = await healthCore()
        if (h.ok) { lastGood = Object.assign({ at: Date.now() }, h); return h }
        if (lastGood && (Date.now() - lastGood.at) < 20000) {
          const age = Date.now() - lastGood.at
          return Object.assign({}, lastGood, { stale: true, staleMs: age, error: '本次采样失败（' + h.error + '），' + Math.round(age / 1000) + ' 秒前读到过它' })
        }
        return h
      }

      const control = async () => {
        const o = await getJson('/api/overview', 6000)
        const c = o.ok && o.body && o.body.control
        return c
          ? {
              ok: !!c.connected,
              connected: c.connected || 0,
              hosts: (c.hosts || []).map(h => ({ host: h.host, transport: h.transport, connectedAt: h.connectedAt, stubs: h.stubs })),
            }
          : { ok: false, connected: 0, hosts: [] }
      }

      const waitUp = async (maxMs) => {
        const t0 = Date.now()
        while (Date.now() - t0 < maxMs) {
          await new Promise(r => setTimeout(r, 700))
          const h = await healthCore()
          if (h.ok) return { ok: true, waitedMs: Date.now() - t0, health: h }
        }
        return { ok: false, waitedMs: Date.now() - t0, health: await health() }
      }

      const waitDown = async (maxMs) => {
        const t0 = Date.now()
        while (Date.now() - t0 < maxMs) {
          await new Promise(r => setTimeout(r, 400))
          const h = await healthCore()
          if (!h.ok) return { down: true, waitedMs: Date.now() - t0 }
        }
        return { down: false, waitedMs: Date.now() - t0 }
      }

      const ledger = makeRequestLedger()
      /* ★★ 2026-11-20：身份核验从「永远不可用」改成**真的去核**。
         三条半边都接上了：PowerShell 查进程本体、core.lock 的 manager 段 + /api/manager-proof
         查管理器证明、再用 sha256(marker) 把两边对齐。任何一条拿不到都会回明确的 reason，
         不会被当成「验过了」写进 instanceRecord。
         ★ 仍然 fail-closed：核不通就不许 start/stop/restart —— 那三个端点会原样把 reason 报出来。 */
      const runPowerShell = makeRunPowerShell({ powerShellPath: cfg.powerShellPath })
      const canonicalizePath = makeCanonicalizePath()
      const readProof = async ({ marker, shellPid, healthCorePid }) => readManagerProof({
        marker, shellPid, healthCorePid,
        token: readToken(),
        fetchImpl: fetch,
        baseUrl: AS,
      })
      /* ★★ 2026-11-20 实测结论（已写入 _verify，不要重复试）：
         ① **生产壳 AgentSoul.exe（133,632 B，2026-11-18）完全不认识 manager 协议**
            —— 二进制里连 "AGENT_SOUL_MANAGER_MARKER" 这串都没有（Unicode 扫描 False/False），
            带 marker 启动时它只做一个动作：把 core 之外的东西原样传下去，而 core 的
            src/util/core-identity.mjs 看到 "有 marker 但 shellPid 缺失" 就 fail-closed 退出。
            实测报错：`bridge 启动身份拒绝：manager-shell-pid-invalid`，core exit code 12。
            而开发树的 build/AgentSoul.exe（152,064 B，11-18 14:54）**源码 Shell.cs 里有这段**，
            但那份二进制里也扫不到这串 —— 也就是说它同样不是带 manager 协议的构建。
         ② 所以「bridge 拉起 core 并证明自己是它的管理器」这条链**当前无法在生产上跑通**，
            不是代码没写，是壳那半边缺一次带 manager 协议的重编。
         ③ 本模块（inspect）已经把核验三条半边全接上了：壳一旦重编，start/stop/restart 立刻可验；
            在那之前它只会回**明确的不可用原因**（进程本体可查、proof 401/409），
            绝不回乐观值。 */
      const inspect = makeInspect({ runPowerShell, canonicalizePath, readProof, health: healthCore })
      const lifecycle = makeAgentSoulLifecycle({
        plan,
        health: healthCore,
        spawn: async (meta) => { const sp = spawnAgentSoul(cfg, { marker: meta.marker }); io.mark(sp.ok ? ('spawn-pid:' + sp.pid) : ('spawn-failed:' + sp.error)); return sp },
        waitUp,
        waitDown,
        inspect,
        terminate: async (pid) => {
          try {
            const { execFileSync } = await import('node:child_process')
            execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' })
            return { ok: true }
          } catch { return { ok: false } }
        },
      })
      globalThis[AGENT_SOUL_LIFECYCLE] = lifecycle
      const fail = (s, x) => { const body = { ok: false, code: x.code || 'bad-request' }; if (x.headers && x.headers.Allow) body.allow = x.headers.Allow; jout(s, x.status || 400, body) }
      const gate = async (req, res, expected, write) => {
        const sec = adminSecurity
        const v = validateManagementRequest(req, expected, sec)
        if (!v.ok) { fail(res, v); return null }
        if (!write) return { body: null }
        const b = await readManagementBody(req)
        if (!b.ok) { fail(res, b); return null }
        const body = b.body || {}
        const id = String(body.requestId || '')
        if (!REQUEST_ID_RE.test(id)) { fail(res, { status: 400, code: 'invalid-request-id' }); return null }
        const csrf = req.headers && (req.headers['x-dsh-csrf'] || req.headers['X-DSH-CSRF']) || body.csrf
        return { body, requestId: id, csrf: String(csrf || '') }
      }

      const runWrite = (routeName, g, action) => ledger.begin(routeName, g.requestId, JSON.stringify(g.body), async () => {
        if (!adminSecurity.consumeCsrf(g.csrf)) return { ok: false, status: 403, code: 'csrf-denied' }
        return await action()
      })

      const route = (p, handler) => {
        try {
          scope.effect(() => wsv.register({ kind: 'exact', path: p, handler }), 'agent-soul: ' + p)
          io.routes.push(p)
          io.mark('route:' + p)
        } catch (e) {
          io.mark('route-failed:' + p)
          io.warn('注册 ' + p + ' 失败：' + String((e && e.message) || e))
        }
      }

      const keeperState = () => {
        const k = globalThis[AGENT_SOUL_KEEPER]
        return {
          enabled: !!(k && k.enabled),
          spawned: (k && k.state && k.state.spawned) || 0,
          lastError: (k && k.state && k.state.lastError) || null,
        }
      }

      route('/agent-soul/status', async (q, s) => {
        if (!await gate(q, s, 'GET', false)) return
        const h = await health()
        const c = h.ok ? await control() : { ok: false, connected: 0, hosts: [] }
        jout(s, 200, {
          at: Date.now(),
          version: VERSION,
          alive: !!h.ok,
          health: h,
          control: c,
          bridge: { connected: !!st.connected, attempts: st.attempts, hostId: st.hostId || '' },
          keeper: keeperState(),
          plan: { root: plan.root, exe: plan.exe, exeExists: plan.exists, image: plan.image, token: !!readToken() },
          cfg: { url: cfg.url },
          routes: io.routes.slice(),
        })
      })

      route('/agent-soul/start', async (q, s) => {
        const g = await gate(q, s, 'POST', true); if (!g) return
        const result = await runWrite('/agent-soul/start', g, () => lifecycle.start())
        if (result && result.conflict) return jout(s, 409, { ok: false, code: 'request-id-conflict', requestId: g.requestId })
        jout(s, result && result.ok === false ? 409 : 200, Object.assign({ requestId: g.requestId }, result))
      })

      route('/agent-soul/stop', async (q, s) => {
        const g = await gate(q, s, 'POST', true); if (!g) return
        const result = await runWrite('/agent-soul/stop', g, async () => {
          lifecycle.suppress(Number(cfg.agentSoulKeeperSuppressMs) || 30000)
          return await lifecycle.stop()
        })
        if (result && result.conflict) return jout(s, 409, { ok: false, code: 'request-id-conflict', requestId: g.requestId })
        jout(s, result && result.ok === false ? 409 : 200, Object.assign({ requestId: g.requestId }, result))
      })

      route('/agent-soul/restart', async (q, s) => {
        const g = await gate(q, s, 'POST', true); if (!g) return
        const result = await runWrite('/agent-soul/restart', g, () => lifecycle.restart())
        if (result && result.conflict) return jout(s, 409, { ok: false, code: 'request-id-conflict', requestId: g.requestId })
        jout(s, result && result.ok === false ? 409 : 200, Object.assign({ requestId: g.requestId }, result))
      })

      /* 通路检查：**两侧都测**。
         ① DSH → v4：HTTP 健康
         ② v4 侧：有没有看到宿主登记（control.connected）
         ③ DSH 侧：本插件的 ws 是否在线（st.connected）
         ④ v4 侧会话通道：/api/session 的 host / caps（内嵌 LLM 收消息那条路）
         ★ ④ 要 X-Soul-Token（v4 2026-11 加了鉴权，不带就回 missing-or-bad-token） */
      route('/agent-soul/probe', async (q, s) => {
        if (!await gate(q, s, 'GET', false)) return
        const steps = []

        const h = await health()
        steps.push({
          name: '① DSH → v4 · HTTP 健康',
          ok: !!h.ok,
          detail: h.ok
            ? ('pid ' + (h.pid === null ? '—' : h.pid) + ' · ' + (h.sessions === null ? '?' : h.sessions) + ' 会话 · llm ' + (h.llmUsable ? '可用' : (h.llmReady ? 'key 在但不可用' : '无 key'))
               + (h.stale ? '（本次采样失败，这是 ' + Math.round((h.staleMs || 0) / 1000) + ' 秒前的读数）' : ''))
            : (h.error || '没有应答'),
        })

        const c = h.ok ? await control() : { ok: false, connected: 0, hosts: [] }
        steps.push({
          name: '② v4 侧 · 宿主登记',
          ok: !!c.ok,
          detail: c.ok
            ? ('control.connected=' + c.connected + ' · ' + (c.hosts || []).map(x => x.host + '/' + x.transport).join(', '))
            : 'control.connected=0 —— v4 没看到任何宿主（本插件 ws 没连上，或 hello 没发出去）',
        })

        steps.push({
          name: '③ DSH 侧 · bridge ws',
          ok: !!st.connected,
          detail: st.connected
            ? ('在线 · hostId ' + (st.hostId || '—') + ' · 本轮重试 ' + st.attempts + ' 次')
            : ('不在线 · 已重试 ' + st.attempts + ' 次 · 断了 ' + fmtMs(st.downSince ? Date.now() - st.downSince : 0)),
        })

        const sess = h.ok ? await getJson('/api/session', 4000, true) : { ok: false }
        const sb = (sess.ok && sess.body) ? sess.body : {}
        const n = Number(sb.hostCount === undefined
          ? ((Array.isArray(sb.hosts) ? sb.hosts.length : 0))
          : sb.hostCount) || 0
        steps.push({
          name: '④ v4 侧 · 会话通道',
          ok: !!sess.ok && sb.ok !== false && n > 0,
          detail: !sess.ok
            ? ('读不到 /api/session（' + (sess.error || ('HTTP ' + sess.status)) + '）')
            : (sb.ok === false
                ? ('被拒：' + (sb.error || '?') + (sb.hint ? ' · ' + sb.hint : ''))
                : ('cap=' + (sb.cap || '—') + ' · 已登记宿主 ' + n + (n ? '' : ' —— 通道在，但还没有宿主能收消息'))),
        })

        jout(s, 200, { at: Date.now(), ok: steps.every(x => x.ok), steps })
      })

      io.mark('wired:' + io.routes.length)
      // inject 的回调是延迟执行的（服务就绪才跑），所以回执要在这里再写一次，
      // 否则落地的那份永远只有 plan-ok、看不到 route:*。
      try { io.snapshot && io.snapshot() } catch (e) { /* 回执不影响功能 */ }
    })
  }

  const log = (m) => { if (cfg.log !== false) console.log(TAG + ' ' + m) }
  const warn = (m) => { if (cfg.log !== false) console.warn(TAG + ' ' + m) }

  const st = {
    ws: null,
    connected: false,
    helloed: false,
    helloBaseUrl: null,
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

  /* ══════════ bridge 协议 v2 的装配（2026-11-14 · 契约 §3.1–§3.3）══════════
     ★ 三样状态：hub（订阅 / 环形缓冲 / 补帧）、handles（句柄表）、gateway（服务白名单）。
     ★ 它们都**不持有 ctx** —— 需要 ctx 的地方都是一个注入进去的小函数，
       这样测试脚本能拿假 ctx 直接跑（不必起 DSH、不必连 v4）。
     ─────────────────────────────────────────────────────────────────────── */

  /** push 的出口。断线 / 写失败一律 false —— hub 那边记 dropped，绝不抛（契约 §3.2）。 */
  const hub = makeEventHub({
    send: (frame) => {
      if (!st.connected || !st.ws || !st.ws.open) return false
      try { return st.ws.send(frame) !== false } catch (e) { return false }
    },
    log: (m) => log('events: ' + m),
  })

  /**
   * 会话/事件的标题缓存（**必须有 TTL**）。
   * ★ 为什么不能每条事件都读 projcache：readTitleFromProjCache 每次 statSync，
   *   而**每条 append 都会改 mtime+size** → 每个事件都触发一次 1.6MB JSON.parse。
   *   那会把「事件回流」变成「每写一条日志读一次盘」。所以这里 30 秒才刷一次；
   *   拿不到就是 null（契约里 title 本来就是可选的，不编）。
   */
  const __evTitle = new Map()
  const EV_TITLE_TTL_MS = 30000
  function titleOf (session) {
    const sid = String((session && session.id) || '')
    if (!sid) return null
    const nowMs = Date.now()
    const hit = __evTitle.get(sid)
    if (hit && (nowMs - hit.at) < EV_TITLE_TTL_MS) return hit.title
    let title = null
    try { const m = readTitleFromProjCache(session); title = m ? m.title : null } catch (e) { title = null }
    __evTitle.set(sid, { at: nowMs, title })
    if (__evTitle.size > 500) __evTitle.clear()   // 标题不是关键数据，封顶就整体清空
    return title
  }

  /** 句柄失效 → 推 handle/revoked（契约 §2.2 的 data 形状：handleId/sessionId/reason/code）。 */
  const handles = makeHandleTable({
    getLiveAgent: (sid) => {
      const agents = ctx.get('agents')
      if (!agents || typeof agents.get !== 'function') return null
      let a = null
      try { a = agents.get(String(sid)) } catch (e) { a = null }
      return (a && typeof a.followup === 'function') ? a : null
    },
    onRevoked: (info) => {
      const n = hub.publish('handle/revoked', {
        handleId: info.handleId,
        sessionId: info.sessionId,
        reason: info.reason,
        code: info.code,
      })
      log('句柄失效 ' + info.handleId + '（' + info.reason + '）→ 推 handle/revoked，命中 ' + n + ' 条订阅');
    },
  })

  const gateway = makeServiceGateway({
    getService: (name) => ctx.get(name),
    log: (m) => warn('service: ' + m),
  })

  /** host/state 的快照（契约 §2.2）：能力 + 桩 + 活会话。拿不到就空数组，绝不编。 */
  function hostStateSnapshot () {
    const out = { caps: cfg.caps.slice(), stubs: cfg.stubCaps.slice(), agents: [] }
    try {
      const agents = ctx.get('agents')
      const roots = (agents && typeof agents.roots === 'function') ? (agents.roots() || []) : []
      out.agents = roots.filter((a) => a && typeof a.followup === 'function').map((a) => ({
        sessionId: String(a.id || ''),
        title: titleOf(a.session),
      }))
    } catch (e) {
      warn('host/state 取活会话失败（这一条按空列表发，不编）：' + String((e && e.message) || e));
    }
    return out
  }

  let lastHostStateJson = ''
  /**
   * 发 host/state。force=false 时**只在快照真的变了**才发 ——
   * 否则 5 秒一次的复验会把 ring 灌满，v4 收到一堆一模一样的帧。
   */
  function publishHostState (force) {
    if (!hub.size()) return 0
    let snap; let json
    try {
      snap = hostStateSnapshot(); json = JSON.stringify(snap)
    } catch (e) {
      warn('host/state 快照 JSON 化失败（这一条不发）：' + String((e && e.message) || e));
      return 0
    }
    if (!force && json === lastHostStateJson) return 0
    lastHostStateJson = json
    return hub.publish('host/state', snap)
  }

  /** session/event → push。★ 整个函数包死：它跑在宿主总线上，绝不许把异常带进会话。 */
  function publishSessionEvent (session, event) {
    if (!hub.size()) return          // 没人订阅：连对象都不造（零成本）
    try {
      const sid = String((session && session.id) || '')
      if (!sid) return
      hub.publish('session/event', {
        session: { id: sid, title: titleOf(session) },
        event: {
          type: String((event && event.type) || ''),
          data: (event && event.data === undefined) ? null : event.data,
          // ★ 附加两项（契约没要求，但补帧对账时必须有它们才定位得到）：DSH 的 seq 与时间
          seq: (event && Number.isFinite(event.seq)) ? Number(event.seq) : null,
          time: (event && Number.isFinite(event.time)) ? Number(event.time) : null,
        },
      })
    } catch (e) {
      warn('session/event 推不出去（这一条丢了）：' + String((e && e.message) || e));
    }
  }

  const v2Offs = []
  let v2Timer = null

  /**
   * 挂事件源（契约 §3.2 / §3.3）。
   * ★ 三路都要：
   *   ① session/event   —— 主事件流（user/message、assistant/message、turn/end…）
   *   ② agent/disposed  —— 句柄生死**即时**信号（5s 复验是兜底，不是唯一）
   *   ③ session/disposed—— 会话被归档/移除时的即时信号
   * ★ 挂不上不许让 apply 崩：降级成「只有 5s 复验」，并**明说**哪一路没挂上。
   */
  function wireV2 () {
    if (typeof ctx.on !== 'function') {
      warn('v2 事件层：宿主 ctx 没有 on() —— session/event 与即时失效信号都不会来（只剩 5s 复验）');
      return
    }
    const hook = (name, fn) => {
      try {
        const off = ctx.on(name, fn)
        if (typeof off === 'function') v2Offs.push(off)
        return true
      } catch (e) {
        warn('v2 事件层：挂 ' + name + ' 失败（那一路不会来）：' + String((e && e.message) || e));
        return false
      }
    }
    hook('session/event', (session, event) => publishSessionEvent(session, event))
    hook('agent/disposed', (payload) => {
      try {
        const a = payload && payload.agent
        const sid = String((a && a.id) || (a && a.session && a.session.id) || '')
        if (sid) {
          for (const row of handles.list()) {
            if (row.sessionId === sid) handles.revoke(row.handleId, 'agent-disposed', 'handle/revoked')
          }
        }
        publishHostState(false)
      } catch (e) {
        warn('agent/disposed 处理失败（句柄可能晚 5 秒才失效）：' + String((e && e.message) || e));
      }
    })
    hook('session/disposed', (session) => {
      try {
        const sid = String((session && session.id) || '')
        if (sid) {
          for (const row of handles.list()) {
            if (row.sessionId === sid) handles.revoke(row.handleId, 'session-disposed', 'handle/revoked')
          }
        }
        publishHostState(false)
      } catch (e) {
        warn('session/disposed 处理失败（句柄可能晚 5 秒才失效）：' + String((e && e.message) || e));
      }
    })
    hook('agent/created', () => { publishHostState(false) })

    /* ★ 5s 复验（契约 §3.3 写死）：这是「即使事件全丢也能发现」的兜底。
       同时顺手发一次 host/state（只在真变了时才发）。 */
    if (v2Timer) clearInterval(v2Timer)
    v2Timer = setInterval(() => {
      try {
        const r = handles.verify()
        if (r.checked) { /* 有句柄才可能有动作，无事不记日志 */ }
      } catch (e) {
        warn('句柄 5s 复验失败（下一轮还会试）：' + String((e && e.message) || e));
      }
      try { publishHostState(false) } catch (e) {
        warn('host/state 周期性发布失败（下一轮还会试）：' + String((e && e.message) || e));
      }
    }, HANDLE_VERIFY_MS)
    if (v2Timer.unref) v2Timer.unref()
    log('v2 事件层已挂：session/event + agent/disposed + session/disposed + agent/created，5s 复验已起');
  }

  /** 拆掉 v2 的定时器与监听（stop() 调）。**幂等**：重复调用不许抛。 */
  function stopV2 () {
    if (v2Timer) { try { clearInterval(v2Timer) } catch (e) { /* 已清 */ } v2Timer = null }
    for (const off of v2Offs.splice(0)) { try { off() } catch (e) { /* 已失效 */ } }
  }
  // ── 先接控制通道，再挂管理端点（顺序也是 F1 的一部分）────────────
  // ★ 这段原来在 apply 末尾。它前面任何一处抛错，就永远跑不到 ——
  //   而 v4 那边看到的正是「没有宿主登记」。主功能不许被面板连坐：先接通道。
  const plan = agentSoulPlan(cfg)
  const adminStages = []
  const adminRoutes = []
  const mark = (m) => { adminStages.push(m + '@' + Date.now()) }
  try {
    if (typeof ctx.effect === 'function') ctx.effect(() => { boot(); return stop })
    else boot()
  } catch (e) {
    warn('装配失败（不影响宿主）：' + String((e && e.message) || e))
  }
  mark(plan.exists ? 'plan-ok' : ('plan-missing-exe:' + plan.exe))

  // ── v2 事件层（session/event 回流、句柄复验、host/state）───────────────
  // ★ 单独 try：它挂了只该退化成「没有事件」+「只有 5s 复验」，
  //   **不许把控制通道一起带走**（那是主功能 —— F1 的教训）。
  try {
    wireV2()
  } catch (e) {
    warn('v2 事件层装配失败（events cap 会空转，控制通道照常）：' + String((e && e.message) || e))
  }

  // ── 管理端点（/agent-soul/status|start|stop|restart|probe）──────────
  try {
    wireAdmin(ctx, { cfg, st, plan, mark, routes: adminRoutes, warn, log, snapshot })
  } catch (e) {
    mark('wire-threw:' + String((e && e.message) || e).slice(0, 120))
    warn('管理端点装配失败（/agent-soul/* 会 404）：' + String((e && e.message) || e))
  }



  // ── 水位：只认真水位 ─────────────────────────────────────────
  //
  // ★ 口径来自 AGENTS.md（2026-09-27 那次复盘）：**真水位 = inputTokens + cacheReadTokens**，
  //   投影缓存里它叫 pressureTokens；引擎的 resolveTokenCount 首选 projectedTokens（它的外推）。
  //   surfaceTokens 只是「可见消息面」，**不是同一把尺子** —— 2026-09-27 实测差 270K。
  // ★ 三条来源都 try/catch 包死：读水位这件事任何情况下都不许影响对话。
  /**
   * 从 projcache 里只取「标题 / 是不是子会话」—— 带 mtime+size 缓存。
   *
   * ★ 2026-11-13：为什么单独抽一个 —— readWatermark 有两条路，
   *   ① 投影服务拿得到水位但**拿不到标题**；② 文件两条都有。
   *   所以 ① 成功时也顺手问一句这里，避免为了一个标题再走一遍 ②。
   * ★ 判据与 status-data.parseProjcache 逐字同源（子会话真名在 subagent.identity.label）。
   */
  const __titleCache = new Map()
  function readTitleFromProjCache (session) {
    try {
      const sid = String((session && session.id) || '')
      if (!sid) return null
      const f = String(cfg.projCacheDir || '').replace(/\\/g, '/').replace(/\/+$/, '') + '/session-' + sid + '.json'
      const stat = fs.statSync(f)
      const key = sid + ':' + stat.mtimeMs + ':' + stat.size
      const hit = __titleCache.get(sid)
      if (hit && hit.key === key) return hit.value
      const j = JSON.parse(fs.readFileSync(f, 'utf8'))
      const rows = (j && j.record && j.record.rows) || j.rows || {}
      const sub = rows.subagent && rows.subagent.val
      const isSub = !!(sub && sub.identity)
      const title = isSub
        ? String((sub.identity.label || sub.identity.mode || '子会话')).slice(0, 60)
        : String((rows.title && rows.title.val) || '(无标题)').slice(0, 60)
      const value = { title, isSub }
      __titleCache.set(sid, { key, value })
      return value
    } catch { return null }
  }

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
          if (n > 0) {
            // ★★ 2026-11-13：这条路拿不到「标题 / 是不是子会话」（投影里没有），
            //   但它们只有 projcache 文件里有 —— 所以**顺手补一次**（带 mtime 缓存，不重复解析）。
            //   ★ 拿不到就是 null，不编造（状态台会显「—」而不是假标题）。
            const meta = readTitleFromProjCache(session)
            return {
              tokens: n, window: w > 0 ? w : null,
              source: 'sessionProjections.contextPressure',
              title: meta ? meta.title : null,
              isSub: meta ? meta.isSub : null,
            }
          }
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
          const rows = (j && j.record && j.record.rows) || j.rows || {}
          const v = rows.contextPressure && rows.contextPressure.val
          readWatermark._t = Number((v && (v.projectedTokens || v.pressureTokens)) || 0)
          readWatermark._w = Number((v && v.contextWindow) || 0)
          // ★★ 2026-11-13（第二批）：顺手把「标题 / 是不是子会话」也读出来。
          //   为什么要它：v4 状态台原来为了这两样去读 projcache 文件 —— 那是又一个 DSH 路径依赖。
          //   拿到这里之后，状态台只需要 state，不需要知道 projcache 在哪。
          //   ★ 判据与 status-data.parseProjcache 同口径：subagent.identity 存在 = 子会话，
          //     真名在 subagent.identity.label（子会话的 title.val 是 prompt 前 20 字，六条会变复读机）。
          const sub = rows.subagent && rows.subagent.val;
          const isSub = !!(sub && sub.identity);
          readWatermark._sub = isSub;
          readWatermark._title = isSub
            ? String((sub.identity.label || sub.identity.mode || '子会话')).slice(0, 60)
            : String((rows.title && rows.title.val) || '(无标题)').slice(0, 60);
          readWatermark._k = key
        }
        if (readWatermark._t > 0) {
          return {
            tokens: readWatermark._t,
            window: readWatermark._w > 0 ? readWatermark._w : null,
            source: 'projcache.contextPressure',
            title: readWatermark._title || null,
            isSub: readWatermark._sub === true,
          }
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
    if (!wantId) return { ...picked, code: 'session/no-target' }
    const c = useController()
    if (!c) {
      /* ★ 这一条必须与「会话不存在」分开：处置完全不同（一个是配置/版本问题，一个是业务分支）。 */
      return {
        ...picked,
        stage: 'unavailable',
        code: 'session/no-controller',
        why: (picked.why || '找不到') + '；宿主没有 sessionController，无法恢复会话',
      }
    }
    try {
      const r = await c.resolveAgent(String(wantId))
      if (r && r.agent && typeof r.agent.followup === 'function') {
        return { agent: r.agent, how: 'resolveAgent(sessionId)', why: null }
      }
      /* ★★★ 2026-11-14（契约 §3.5）：**r.error.code / r.error.message 必须带进 why 和 code**。
         原来这里只有一句「resolveAgent 也没恢复出来」—— 于是 v4 回的是
         {ok:false, error:{code:'session/not-found', message:'...'}} 时，那个 code 被整条吞掉，
         「会话不存在」「宿主没这个服务」「内部抛错」在 why 里长得一模一样。 */
      const ex = explainResumeFailure(picked.why || '找不到可以叫醒的 agent', r)
      return { ...picked, stage: 'no-target', code: ex.code, why: ex.why, detail: ex.detail }
    } catch (e) {
      const ex = explainResumeFailure(picked.why || '找不到可以叫醒的 agent', e)
      /* ★ 抛出路径也认 e.code（v4 的 resolveAgent 抛的是带 code 的错）——
         但 stage 按「是不是目标问题」分：not-found / no-target 之外一律 host-error。 */
      const stage = (e && (e.stage === 'not-found' || e.stage === 'no-target' || e.stage === 'unavailable'))
        ? e.stage
        : (ex.code === 'session/not-found' ? 'not-found' : 'no-target')
      return { ...picked, stage, code: ex.code, why: ex.why, detail: ex.detail }
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

  /**
   * 本宿主此刻对外宣告的地址（只认 http://127.0.0.1:<port>）。
   *
   * ★★★ 2026-11-13（爀曦定）：心跳要**直接读宿主地址**，不再靠 dsh-origin.txt / 启动日志猜。
   *   理由：DSH 的 webServer 端口每次重启都变（本机实测 65334 → 64445），
   *   而本插件就住在 DSH 进程里 —— 报的是自己，永不过期。
   * ★ 两个来源，先环境变量再服务：
   *   ① process.env.DSH_WEB_URL —— 路由层注入的发布地址（web-app 的 webRuntime.getAdvertisedUrl）
   *   ② ctx.get('webApp').getAdvertisedUrl() —— 同一个值的服务形态
   * ★ 拿不到就返回 null（**绝不编一个**）—— v4 那边 fail-closed，不会因此乱投。
   */
  function advertisedUrlOf () {
    const shapeOk = (u) => typeof u === 'string' && /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(u.trim())
    try {
      const env = process.env.DSH_WEB_URL
      if (shapeOk(env)) return env.trim()
    } catch { /* 读不到就往下走 */ }
    // ★★ 2026-11-13：**先走 webServer.getOrigin()** —— 本插件 inject 的就是 webServer，
    //   它必然拿得到；而 webApp 是另一个插件 provide 的服务，能不能看见取决于 realm。
    //   （web-app 自己的 appRootUrl 就是 `publicUrl ?? ctx.webServer.getOrigin()`，同一个口径。）
    // ★ 首选缓存（由 ctx.inject 回调抓到的那个，外层 ctx.webServer 会抛）
    if (shapeOk(webServerOrigin)) return webServerOrigin
    try {
      const ws = ctx.webServer
      if (ws && typeof ws.getOrigin === 'function') {
        const u = ws.getOrigin()
        if (shapeOk(u)) return String(u).trim()
      }
    } catch { /* webServer 还没就绪就往下走 */ }
    try {
      const app = ctx.get('webApp')
      if (app && typeof app.getAdvertisedUrl === 'function') {
        const u = app.getAdvertisedUrl()
        if (shapeOk(u)) return String(u).trim()
      }
    } catch { /* 没有 webApp 服务 = 拿不到 */ }
    return null
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
      // ★★ 2026-11-13（第二批）：状态台需要的「标题 / 是不是子会话」。
      //   有了它们，状态台不必再去读 projcache 文件（那是一条 DSH 路径依赖）。
      //   ★ null = 不知道（比如走 sessionProjections 那条路拿不到标题），不编造。
      sessionTitle: w.title === undefined ? null : w.title,
      isSub: w.isSub === undefined ? null : w.isSub,
      // ★ 2026-11-13：宿主自己的地址。v4 的 lead-target / autonomy 用它问心跳，
      //   不再依赖 dsh-origin.txt（那份 11-12 就停在 63158 没动过，自主因此一直 fail-closed）。
      dshBaseUrl: advertisedUrlOf(),
      // ★ 2026-11-13：把「它此刻看到了什么」一并报出去。
      //   为什么要这个：dshBaseUrl 为 null 时，光看结果分不清是「缓存没值」
      //   「env 没有」还是「shape 不合格」—— 而分不清就只能猜。
      //   meta 会整份进 v4 的 /api/overview（control.hosts[].meta），所以它能被看见。
      originDebug: {
        cached: webServerOrigin,
        hasEnv: (() => { try { return Boolean(process.env.DSH_WEB_URL) } catch { return null } })(),
        sentAt: Date.now(),
      },
    }
    if (w.tokens == null) meta.note = w.reason
    if (w.surface) meta.surfaceTokens = w.surface

    ws.send({ type: 'hello', host: cfg.hostName, caps: cfg.caps.slice(), meta })
    // ★ 2026-11-13：记下「这一份 hello 里 dshBaseUrl 到底是啥」。
    //   有了它，ping 定时器就能判断「还没带出去」并补发 —— 不再依赖 connect/注入的先后顺序。
    st.helloBaseUrl = meta.dshBaseUrl || null
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

  // ── sessions：把 DSH 的会话文件**读给 v4**，v4 不再自己开目录 ──────────
  /**
   * 会话根目录。★ 拿不到就抛，不许回空。
   */
  function hostSessionsRoot () {
    const home = String(process.env.DSH_HOME || '').trim()
    if (!home) throw execError('unavailable', 'DSH_HOME 未设置 —— 无法定位会话目录（不是「没有会话」）')
    return path.join(home, 'sessions')
  }

  /**
   * 列会话：workspace 目录 → session 目录 → session.v4.jsonl.zstd。
   * ★ 只 stat，不读内容 —— v4 拿它建列表/算增量，不需要正文。
   */
  function listHostSessions (args) {
    const root = hostSessionsRoot()
    const wantWs = args && typeof args.workspace === 'string' && args.workspace ? args.workspace : null
    let wsDirs
    try {
      wsDirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
    } catch (e) {
      throw execError('unavailable', '会话根目录读不到：' + root + '（' + String(e && e.message ? e.message : e) + '）')
    }
    const items = []
    let skippedDirs = 0
    for (const ws of wsDirs) {
      if (wantWs && ws.name !== wantWs) continue
      const wsPath = path.join(root, ws.name)
      let sessDirs
      try { sessDirs = fs.readdirSync(wsPath, { withFileTypes: true }).filter((d) => d.isDirectory()) } catch { skippedDirs += 1; continue }
      for (const sd of sessDirs) {
        const dir = path.join(wsPath, sd.name)
        const file = path.join(dir, 'session.v4.jsonl.zstd')
        let st = null
        try { st = fs.statSync(file) } catch { continue }
        items.push({
          id: sd.name,
          workspace: ws.name,
          sizeBytes: st.size,
          mtimeMs: st.mtimeMs,
          file: 'session.v4.jsonl.zstd',
        })
      }
    }
    // ★ 按 mtime 倒序（最新的在前）—— v4 的增量索引按这个顺序走最省事
    items.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0))
    return { ok: true, root, total: items.length, skippedDirs, items }
  }

  /**
   * 读一个会话的帧。多帧 zstd —— 逐帧解压后按行 JSON.parse。
   * ★ 分页：limit 默认 400 帧。返回 nextFromSeq 供续读；读完了 nextFromSeq = null。
   * ★ 一行坏掉只跳过那一行并计数，不整体失败（但要如实报 badLines）。
   */
  function readHostSession (args) {
    // ★★ 2026-11-13：把「这一次 read 收到什么、花了多久」写到磁盘。
    //   为什么：v4 那边只能看到「超时」，看不到 bridge 内部在干什么。
    //   今天已经因为「看不到中间状态」误判三次了 —— 这次直接落盘，不再靠猜。
    const __t0 = Date.now()
    const __log = (extra) => {
      try {
        const line = JSON.stringify({ at: new Date().toISOString(), ...extra })
        fs.appendFileSync('D:/AI/dsh/home/logs/bridge-sessions.log', line + '\n')
      } catch { /* 日志写不了不影响主路 */ }
    }
    const sid = String((args && args.sessionId) || '').trim()
    if (!sid) throw execError('bad-request', 'sessions/read 需要 sessionId')
    const root = hostSessionsRoot()
    // 在所有 workspace 里找这一层（session 目录名就是完整 id）
    let file = null
    let wsName = null
    let wsDirs = []
    try { wsDirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()) } catch (e) {
      throw execError('unavailable', '会话根目录读不到：' + root)
    }
    for (const ws of wsDirs) {
      const cand = path.join(root, ws.name, sid, 'session.v4.jsonl.zstd')
      try { if (fs.statSync(cand).isFile()) { file = cand; wsName = ws.name; break } } catch { /* 不在这个 workspace */ }
    }
    if (file === null) throw execError('not-found', '找不到会话 ' + sid + ' 的 session.v4.jsonl.zstd（在 ' + root + ' 下所有 workspace 里都没找到）')

    // ★★ 2026-11-13：**支持只读尾部**。原来 readFileSync 整个文件再解压所有帧 ——
    //   本机会话 2.7MB / 2300+ 帧，换气扫描一个会话要 30 秒；而它只关心最近几百轮。
    //   tailBytes 给了就只读尾部这一段，从**第一个能解开的帧**开始（切片可能切在帧中间）。
    const tailBytes = Number.isFinite(args && args.tailBytes) && args.tailBytes > 0
      ? Math.min(Number(args.tailBytes), 64 * 1024 * 1024) : 0
    let st
    try { st = fs.statSync(file) } catch (e) {
      throw execError('unavailable', 'stat 失败：' + file)
    }
    const startAt = tailBytes > 0 && st.size > tailBytes ? st.size - tailBytes : 0
    const truncated = startAt > 0
    let buf
    try {
      if (startAt === 0) {
        buf = fs.readFileSync(file)
      } else {
        const fd = fs.openSync(file, 'r')
        buf = Buffer.alloc(st.size - startAt)
        fs.readSync(fd, buf, 0, buf.length, startAt)
        fs.closeSync(fd)
      }
    } catch (e) {
      throw execError('unavailable', '读文件失败：' + file + '（' + String(e && e.message ? e.message : e) + '）')
    }

    // 多帧 zstd：先按魔数切，再逐帧解压
    const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
    const offsets = []
    let cursor = 0
    while (cursor < buf.length) {
      const at = buf.indexOf(MAGIC, cursor)
      if (at < 0) break
      offsets.push(at)
      cursor = at + 4
    }
    if (offsets.length === 0) throw execError('unavailable', '不是 zstd 文件（找不到帧魔数）：' + file)

    const fromSeq = Number.isFinite(args && args.fromSeq) ? Number(args.fromSeq) : 0
    const limit = Number.isFinite(args && args.limit) && args.limit > 0 ? Math.min(Number(args.limit), 2000) : 400
    // ★★★ 2026-11-13（第 13 代）：**从最后一帧往前解压**。
    //   为什么：切帧只要按魔数扫一遍（便宜），**解压才是贵的**。
    //   本机会话 2.3MB / 2300+ 帧，从头解到够 400 条要 30 秒；
    //   而调用方（换气扫描）只关心最近几百轮 —— 前面 2000 帧纯属白解。
    //   ★ tailBytes 不够用：它限制的是字节，而文件本身才 2.7MB < 4MB，等于没限。
    //   ★ tailFrames > 0 时走这条捷径，返回的仍是**正序**（与 fromSeq 版本同形）。
    const tailFrames = Number.isFinite(args && args.tailFrames) && args.tailFrames > 0
      ? Math.min(Number(args.tailFrames), 20000) : 0
    const frames = []
    let badLines = 0
    let total = 0
    let nextFromSeq = null
    let stopped = false

    // ── 捷径：从后往前解，够数就停 ──────────────────────────────
    if (tailFrames > 0) {
      const chunks = []
      let got = 0
      for (let i = offsets.length - 1; i >= 0 && got < tailFrames; i -= 1) {
        const a = offsets[i]
        const b = i + 1 < offsets.length ? offsets[i + 1] : buf.length
        let text = ''
        try { text = zstdDecompressSync(buf.subarray(a, b)).toString('utf8') } catch { badLines += 1; continue }
        const lines = text.split('\n').filter((x) => x.trim())
        if (!lines.length) continue
        chunks.push(lines)
        got += lines.length
      }
      chunks.reverse()
      const all = []
      for (const c of chunks) for (const line of c) all.push(line)
      total = all.length
      const use = all.slice(-tailFrames)
      for (const line of use) {
        let obj = null
        try { obj = JSON.parse(line) } catch { badLines += 1; continue }
        frames.push(obj)
      }
      __log({ sid, path: 'tailFrames', tailFrames, frames: frames.length, lines: total, ms: Date.now() - __t0 })
      return {
        ok: true, sessionId: sid, workspace: wsName, file,
        fromSeq: 0, count: frames.length, total, nextFromSeq: null, badLines,
        truncated, tailBytesUsed: tailBytes, tailFrames, fromEnd: true,
        ms: Date.now() - __t0,
        frames,
      }
    }

    // ── 原路：从头分页（保留给需要完整历史的调用方）─────────────
    for (let i = 0; i < offsets.length && !stopped; i += 1) {
      const a = offsets[i]
      const b = i + 1 < offsets.length ? offsets[i + 1] : buf.length
      let text = ''
      try { text = zstdDecompressSync(buf.subarray(a, b)).toString('utf8') } catch { badLines += 1; continue }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        let obj = null
        try { obj = JSON.parse(line) } catch { badLines += 1; continue }
        total += 1
        if (total <= fromSeq) continue
        if (frames.length >= limit) { nextFromSeq = total - 1; stopped = true; break }
        frames.push(obj)
      }
    }
    __log({ sid, path: 'fromSeq', fromSeq, limit, frames: frames.length, lines: total, ms: Date.now() - __t0 })
    return {
      ok: true, sessionId: sid, workspace: wsName, file,
      fromSeq, count: frames.length, total, nextFromSeq, badLines,
      truncated, tailBytesUsed: tailBytes, ms: Date.now() - __t0,
      frames,
    }
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
      // ★★ 2026-11-13（第二批）：把「标题 / 是不是子会话」也推给 v4 ——
      //   状态台就不必自己去读 projcache 文件了（那是最后一条 DSH 路径依赖）。
      //   null = 这一路拿不到（不编造）。
      sessionTitle: w.title === undefined ? null : w.title,
      isSub: w.isSub === undefined ? null : w.isSub,
      at: new Date(now).toISOString(),
    }
    if (w.tokens == null) msg.note = w.reason
    if (w.surface) msg.surfaceTokens = w.surface
    st.ws.send(msg)
  }

  // ── exec：必须回执 ──────────────────────────────────────────
  function sendResult (id, ok, payload) {
    if (!id) { warn('收到一条没有 id 的 exec，无法回执（协议要求必须有 id）'); return false }
    let frame
    if (ok) {
      frame = { type: 'result', id, ok: true, data: payload === undefined ? null : payload }
    } else {
      // ★ 失败帧必然带 [stage:<code>] 前缀 + 结构化 stage / code / message（见 execFailure 头注）
      const f = execFailure(payload)
      frame = { type: 'result', id, ok: false, error: f.error, stage: f.stage, code: f.code, message: f.message }
      if (f.detail !== undefined) frame.detail = f.detail
    }
    if (!st.connected || !st.ws) {
      /* ★★ 2026-11-14：这条失败**不许只活在内存里**。
         原实现在这里直接 return false —— 断线时回执发不出去、日志一个字都没有，
         v4 那边只看到「超时」，事后完全分辨不出「没回执」和「算到一半炸了」。
         现在：把 id / ok / code / message 全打进日志，再 return false。 */
      warn('回执发不出去（连接已断）：id=' + shortId(id) + ' ok=' + ok
        + (ok ? '' : (' code=' + frame.code + ' msg=' + String(frame.message || '').slice(0, 160))))
      return false
    }
    try {
      return st.ws.send(frame) !== false
    } catch (e) {
      warn('回执写入抛了：id=' + shortId(id) + '｜' + String((e && e.message) || e))
      return false
    }
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
        /* ★ 2026-11-14（契约 §2.5）：句柄形态优先。给了 handleId 就只认它 ——
           句柄失效会抛 code:'handle/revoked'，**绝不退回按 sessionId 再猜一个**：
           那会把「句柄已死」变成「悄悄投给了另一个 agent」，是最坏的一种成功。 */
        const text = String(args.text ?? args.content ?? '')
        const tgt = await resolveTarget(args, 'session/steer')
        if (typeof tgt.agent.steer !== 'function') {
          throw execError('unsupported', '这个会话的 agent 没有 steer（插话只在正在跑的那一轮有效）', 'session/steer-unsupported')
        }
        return Promise.resolve(tgt.agent.steer(text)).then(() => ({
          delivered: true,
          sessionId: tgt.sessionId,
          action: 'steer',
          how: tgt.how,
          handleId: tgt.handleId || undefined,
        }))
      }
      /* ★★★ 2026-11-14（契约 §2.5）：句柄通道的入口。 */
      if (action === 'attach') {
        const sid = String(args.sessionId || '').trim()
        if (!sid) throw execError('bad-request', 'session/attach 缺 args.sessionId', 'session/bad-request')
        /* ★ 用 pickOrResumeAgent 而不是 pickLiveAgent：句柄的意义正是「哪怕它此刻没在跑，
           我也能拿到一个可靠的目标」—— v4 的 resolveAgent 自愈路径靠的就是这个（契约 §4.5）。
           ★ 拉不起来就如实失败：ok:false + code，绝不返回一个假句柄。 */
        const picked = await pickOrResumeAgent(sid)
        if (!picked.agent) {
          throw execError(
            picked.stage || 'not-found',
            picked.why || ('会话 ' + shortId(sid) + ' 没有活 agent，也拉不起来'),
            picked.code || 'handle/no-agent',
            picked.detail)
        }
        const sess = picked.agent.session
        const row = handles.attach({ sessionId: sid, agent: picked.agent, session: { id: sid } })
        let title = null
        let agentPreset = null
        try { const m = readTitleFromProjCache(sess); title = m ? m.title : null } catch (e) { title = null }
        try {
          agentPreset = (sess && sess.header && sess.header.agentPreset !== undefined) ? sess.header.agentPreset : null
        } catch (e) { agentPreset = null }
        log('attach ' + shortId(sid) + ' → ' + row.handleId + '（how=' + String(picked.how || '?') + '）')
        return {
          handleId: row.handleId,
          alive: true,
          how: picked.how || null,
          session: { id: sid, title, agentPreset },
        }
      }
      if (action === 'detach') {
        const handleId = String(args.handleId || '').trim()
        if (!handleId) throw execError('bad-request', 'session/detach 缺 args.handleId', 'session/bad-request')
        const dr = handles.detach(handleId)
        log('detach ' + handleId + '（removed=' + dr.removed + '）')
        return dr
      }
      if (action === 'create') {
        // ★★★ 2026-11-13（第 14 代）：**上面那句原来是错的**。
        //   原文：「宿主侧没有「凭空造会话」的入口（agents 只暴露 get/roots）」。
        //   实测 listService：DSH 有 `sessionController`，契约里就是 `@Remote('create') create(request)`。
        //   agents 只是「拿活 agent」的口 —— 建会话本来就不归它。
        //   ★ 教训：写「宿主没有 X」之前先 listService 查一遍，别拿局部观察当全局结论。
        const ctrl = ctx.get('sessionController')
        if (!ctrl || typeof ctrl.create !== 'function') {
          throw execError('unavailable', '宿主没有 sessionController.create（这个 DSH 版本不带，或还没就绪）')
        }
        const req = {}
        if (args.workspaceId) req.workspaceId = String(args.workspaceId)
        if (args.agentPreset) req.agentPreset = String(args.agentPreset)
        if (args.cwd) req.cwd = String(args.cwd)
        const made = await ctrl.create(req)
        // ★ 回执形状不猜：sessionId 两种写法都认，其余原样不带出去
        return {
          sessionId: (made && (made.sessionId || (made.session && made.session.id))) || null,
          preset: (made && (made.preset || made.agentPreset)) || null,
          keys: made && typeof made === 'object' ? Object.keys(made) : null,
        }
      }
      if (action === 'rename') {
        const ctrl = ctx.get('sessionController')
        if (!ctrl || typeof ctrl.rename !== 'function') {
          throw execError('unavailable', '宿主没有 sessionController.rename')
        }
        const sid = String(args.sessionId || '').trim()
        const title = String(args.title || '').trim()
        if (!sid) throw execError('bad-request', 'session/rename 缺 args.sessionId')
        if (!title) throw execError('bad-request', 'session/rename 缺 args.title')
        const r = await ctrl.rename({ sessionId: sid, title })
        return { sessionId: sid, title, ok: !(r && r.ok === false) }
      }
      throw execError('bad-request', 'session 只认 action = resolve | followup | say | steer | attach | detach | create | rename（拿到 ' + JSON.stringify(action) + '）', 'session/bad-request', { action })
    }

    // ★★★ 2026-11-13：sessions —— 把会话文件**读给 v4**，v4 不再自己开 DSH 的目录。
    //   两个动作：list（列，只 stat）/ read（读帧，分页）。
    //   ★ 任何失败都带 stage 抛出去 —— 绝不用空数组冒充「没有会话」。
    if (cap === 'sessions') {
      if (action === 'list') return listHostSessions(args)
      if (action === 'read') return readHostSession(args)
      throw execError('bad-request', 'sessions 只认 action = list | read（拿到 ' + JSON.stringify(action) + '）')
    }

    // ★★★ 2026-11-13（第 14 代）：workspaces —— 把宿主的工作区注册表借给 v4 用。
    //
    //   为什么需要它：aurabot 现在跑在 v4 进程里，`dsh.workspaceRegistry` 与
    //   `dsh.get('workspaceRegistry')` 都是 undefined（v4 的适配 ctx 里没这个服务），
    //   而 hub.ensureWorkspace() 必须先有工作区才能把 QQ 消息落到一个 DSH 会话上。
    //   结果就是 11-12 14:00 起每条群消息都在这里断掉，日志里只有一行
    //   「转进 DSH 失败：宿主没有 workspaceRegistry」，看起来像配置问题，其实是通道缺口。
    //
    //   ★ 用 ctx.get() 而不是 ctx.workspaceRegistry：本插件的 inject 只有 webServer，
    //     把 workspaceRegistry 写成硬依赖会让整座桥在这个服务不可用时**整个不加载** ——
    //     那是拿一条能力换掉全部能力。契约里这就是 optional 访问，必须自己判空。
    //   ★ 三个动作：list（列）/ ensure（按规范化路径找，没有就建，幂等）/ get（按 id 取）。
    //   ★ 失败一律抛带 stage 的错，绝不回空数组冒充「没有工作区」。
    // ★★★ 2026-11-14（第 14 代）：agent —— 把 v4 那边的工具**挂到会话上**。
    //
    //   为什么不能直接挂：工具实现是 JS 函数，活在 v4 进程里；agent 活在 DSH 进程里。
    //   函数跨不了进程。所以这里挂的是**转发器**：调用时发 invoke 回 v4 执行。
    //   ★ 没有这条，她连 report_to_lead 都调不到 —— 事件层从 11-12 起就没通过电。
    if (cap === 'agent') {
      /* ★★★ 2026-11-14（契约 §2.5）：followup / steer 也接受 handleId。
         handleId 失效 → ok:false + code:'handle/revoked'（**不许假装成功**）。 */
      if (action === 'followup' || action === 'say') return doFollowup(args, m.id)
      if (action === 'steer') {
        const text = String(args.text ?? args.content ?? '')
        const tgt = await resolveTarget(args, 'agent/steer')
        if (typeof tgt.agent.steer !== 'function') {
          throw execError('unsupported', '这个会话的 agent 没有 steer（插话只在正在跑的那一轮有效）', 'agent/steer-unsupported')
        }
        return Promise.resolve(tgt.agent.steer(text)).then(() => ({
          delivered: true,
          sessionId: tgt.sessionId,
          action: 'steer',
          how: tgt.how,
          handleId: tgt.handleId || undefined,
        }))
      }
      if (action === 'tool-register') {
        const sid = String(args.sessionId || '').trim()
        const toolName = String(args.name || '').trim()
        if (!sid) throw execError('bad-request', 'agent/tool-register 缺 args.sessionId（工具是挂在某个会话上的）', 'tool/bad-request')
        if (!toolName) throw execError('bad-request', 'agent/tool-register 缺 args.name', 'tool/bad-request')
        /* ★ 从 pickLiveAgent 换成 pickOrResumeAgent：工具挂在会话上，而 v4 挂工具时那个会话
           未必正在跑（aurabot 是先 mount 再收消息）。只认「活着的」会漏掉一半挂载。 */
        const picked = await pickOrResumeAgent(sid)
        if (!picked.agent) {
          throw execError(picked.stage || 'not-found',
            picked.why || '找不到这个会话（会话要先建出来才能挂工具）',
            picked.code || 'tool/no-session', picked.detail)
        }
        const actx = picked.agent.ctx
        if (!actx || !actx.tools || typeof actx.tools.register !== 'function') {
          throw execError('unsupported', '这个 agent 没有 ctx.tools.register，挂不上工具', 'tool/no-registry')
        }
        const ms = Number(args.timeoutMs) > 0 ? Number(args.timeoutMs) : 30000
        /* ★★★ 2026-11-14：**这里就是头号阻塞的修复点**（契约 §3.4）。
           原来直接把 { name, description, parameters, execute } 交给 register —— 缺 output，
           于是 dsh-tools lib/index.js:2776 抛 must declare output { schema, render, presentationMeta? }，
           而那条错只进 stdout，v4 的 /api/overview 里就只剩一行 lastError。
           output.render 是函数、跨不了进程 ⇒ 必须由宿主造（buildToolOutput）。 */
        const built = buildToolOutput(args)
        // ★ 先撤旧的再挂新的：insert 对**同层重名**直接抛，
        //   原实现「先 register 再撤旧的」= 第二次挂同名工具必失败（failures 越涨越多的另一半）。
        //   ★ 键里带 sessionId：工具是**按 agent 作用域**注册的，两个会话可以同名，
        //     只按名字建表会让 A 会话的 unregister 撤掉 B 会话的挂载。
        st.toolDisposers = st.toolDisposers || new Map()
        const key = sid + '\u0000' + toolName
        const old = st.toolDisposers.get(key)
        if (typeof old === 'function') {
          try { old() } catch (e) { warn('撤旧工具 ' + toolName + ' 失败（继续挂新的）：' + String((e && e.message) || e)) }
        }
        st.toolDisposers.delete(key)
        let off
        try {
          off = actx.tools.register({
            name: toolName,
            description: String(args.description || ''),
            parameters: args.parameters || { type: 'object', properties: {} },
            output: built.output,
            execute: async (a) => invokeInV4(toolName, a, ms),
          })
        } catch (e) {
          const msg = String((e && e.message) || e)
          const isSchema = (e && e.name === 'JsonSchemaError') || /unsupported JSON schema|must declare output/i.test(msg)
          throw execError(
            isSchema ? 'tool-schema' : 'host-error',
            'agent/tool-register 挂 ' + toolName + ' 被 DSH 拒绝：' + msg,
            isSchema ? 'tool/schema' : 'tool/register-failed',
            { name: toolName, sessionId: sid, outputSource: built.source, notes: built.notes.length ? built.notes : undefined })
        }
        st.toolDisposers.set(key, typeof off === 'function' ? off : () => {})
        log('工具已挂：' + toolName + ' @ ' + shortId(sid) + '（output=' + built.source
          + (built.notes.length ? '，归一 ' + built.notes.length + ' 处' : '') + '）')
        return {
          ok: true,
          name: toolName,
          sessionId: sid,
          how: picked.how || null,
          output: { source: built.source, normalized: built.notes },
        }
      }
      if (action === 'tool-unregister') {
        const toolName = String(args.name || '').trim()
        if (!toolName) throw execError('bad-request', 'agent/tool-unregister 缺 args.name', 'tool/bad-request')
        const sid = String(args.sessionId || '').trim()
        st.toolDisposers = st.toolDisposers || new Map()
        const keys = sid
          ? [sid + '\u0000' + toolName]
          : [...st.toolDisposers.keys()].filter((k) => k.endsWith('\u0000' + toolName))
        let removed = 0
        for (const k of keys) {
          const off = st.toolDisposers.get(k)
          if (typeof off === 'function') {
            try { off(); removed += 1 } catch (e) { warn('撤工具 ' + toolName + ' 失败：' + String((e && e.message) || e)) }
          }
          st.toolDisposers.delete(k)
        }
        return { ok: true, name: toolName, sessionId: sid || null, removed: removed > 0, removedCount: removed }
      }
      throw execError('bad-request',
        'agent 只认 action = followup | steer | tool-register | tool-unregister（拿到 ' + JSON.stringify(action) + '）',
        'agent/bad-request', { action })
    }

    if (cap === 'workspaces') {
      const reg = ctx.get('workspaceRegistry')
      if (!reg || typeof reg.list !== 'function' || typeof reg.create !== 'function') {
        throw execError('unavailable',
          '宿主没有 workspaceRegistry 服务（本 DSH 启动时没就绪，或版本不带）—— 不退回任何猜测值')
      }
      // Workspace 的 sessionIds 是 getter（可能抛），投影时逐个兜住，别让一个坏实体拖垮整张表
      const project = (w) => {
        let ids = []
        try { const s = w && w.sessionIds; if (Array.isArray(s)) ids = s.slice() } catch (e) { ids = [] }
        return {
          id: (w && w.id) || null,
          path: (w && w.path) || '',
          title: (w && w.title) || '',
          createdAt: (w && w.createdAt) || null,
          sessionIds: ids,
        }
      }
      if (action === 'list') {
        const list = reg.list()
        if (!Array.isArray(list)) throw execError('shape', 'workspaceRegistry.list() 没回数组（协议不符）')
        return { action: 'list', count: list.length, items: list.map(project) }
      }
      if (action === 'ensure') {
        const dir = String(args.path || '').trim()
        if (!dir) throw execError('bad-request', 'workspaces/ensure 缺 args.path（要绝对路径）')
        // 与 aurabot 侧同一套归一（去尾斜杠 + 小写）—— 两边判据不一致时会出现「同目录两个工作区」
        const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase()
        const hit = reg.list().find((w) => norm(w.path) === norm(dir))
        if (hit) return { action: 'ensure', reused: true, workspace: project(hit) }
        const ws = await reg.create(dir, args.title ? String(args.title) : undefined)
        return { action: 'ensure', reused: false, workspace: project(ws) }
      }
      if (action === 'get') {
        const id = String(args.id || '').trim()
        if (!id) throw execError('bad-request', 'workspaces/get 缺 args.id')
        const w = reg.get(id)
        if (!w) throw execError('not-found', 'workspace 不存在：' + id)
        return { action: 'get', workspace: project(w) }
      }
      throw execError('bad-request', 'workspaces 只认 action = list | ensure | get（拿到 ' + JSON.stringify(action) + '）')
    }

    // ★★★ 2026-11-14（契约 §2.4）：events —— 订阅 / 退订 / 状态，外加补帧（backlog）。
    if (cap === 'events') {
      if (action === 'subscribe') {
        const res = hub.subscribe(args)
        /* ★ 刚订阅时补一条 host/state：v4 一连上就该知道「宿主现在有哪些能力 / 哪些活会话」，
           而不是等下一次变化。force=true 是因为「刚订阅」本身就需要一份当前快照（与去重无关）。 */
        const topics = Array.isArray(args && args.topics) ? args.topics.map(String) : []
        if (topics.indexOf('host/state') >= 0) publishHostState(true)
        log('events/subscribe → ' + res.subscriptionId + '（seq=' + res.seq + '，backlog=' + res.backlog.length
          + (res.resumed ? '，接上原订阅' : '，新建') + (res.gap ? '，⚠ gap' : '') + '）')
        return res
      }
      if (action === 'unsubscribe') {
        const ur = hub.unsubscribe(args && args.subscriptionId)
        log('events/unsubscribe → ' + String((args && args.subscriptionId) || '（空）') + '（removed=' + ur.removed + '）')
        return ur
      }
      if (action === 'status') return hub.status()
      throw execError('bad-request',
        'events 只认 action = subscribe | unsubscribe | status（拿到 ' + JSON.stringify(action) + '）',
        'events/bad-request', { action })
    }

    // ★★★ 2026-11-14（契约 §2.4）：service —— 把宿主服务里的**纯数据方法**借给 v4。
    //   ★ 白名单在 SERVICE_ALLOWLIST；返回**原生值原样**（不包 ok、不包装），
    //     只有「活对象」(Workspace/Session) 会投影成纯数据 —— 不投影它们根本跨不了进程。
    if (cap === 'service') {
      if (action === 'describe') return gateway.describe()
      if (action === 'call') return await gateway.call(args)
      throw execError('bad-request',
        'service 只认 action = describe | call（拿到 ' + JSON.stringify(action) + '）',
        'service/bad-request', { action })
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

  /**
   * 投递目标的解析（followup / steer 共用）。
   *
   * ★ 两种形态：handleId（契约 §2.5，**优先**）与 sessionId（历史形态，兼容）。
   * ★ 句柄失效时**必须抛 handle/revoked** —— 不许退回按 sessionId 再找一个：
   *   那会让「句柄已死」变成「悄悄投给了另一个 agent」，是最坏的一种成功。
   */
  async function resolveTarget (args, what) {
    const a = (args && typeof args === 'object') ? args : {}
    const handleId = String(a.handleId || '').trim()
    if (handleId) {
      const row = handles.mustGet(handleId)   // 失效即抛 code:'handle/revoked'
      return { agent: row.agent, sessionId: row.sessionId, how: 'handle(' + handleId + ')', handleId }
    }
    const want = String(a.sessionId || cfg.defaultSessionId || '').trim()
    const picked = await pickOrResumeAgent(want)
    if (!picked.agent) {
      throw execError(
        picked.stage || 'no-target',
        picked.why || ('找不到可以叫醒的 agent（' + what + '）'),
        picked.code || 'session/no-target',
        picked.detail)
    }
    return {
      agent: picked.agent,
      sessionId: String(picked.agent.id || want || ''),
      how: picked.how,
      live: picked.live,
    }
  }

  async function doFollowup (args, cmdId) {
    /* ★★★ 2026-11-14（第 14 代）：content 块数组优先于 text。
       原写法 `String(args.text ?? args.content ?? '')` 在 args.content 是**数组**时会得到
       "[object Object]"；而调用方（v4 的 bridge-session-controller）当时又只取
       payload.content[0].text —— 两层叠加的后果是：
       她的会话里只剩记忆召回提示，看不到真正那句话。
       一手证据：session-0c90de16 在 2026-11-14 01:03:03 的 user/message 只有 1 个块、
       352 字、内容是「（你记得这些事…）」，群聊正文不存在；她回了「[沉默]」。 */
    const blocks = (() => {
      if (Array.isArray(args.content) && args.content.length) {
        return args.content.filter((b) => b && typeof b === 'object' && typeof b.type === 'string')
      }
      const t = String(args.text ?? (typeof args.content === 'string' ? args.content : '') ?? '').trim()
      return t ? [{ type: 'text', text: t }] : []
    })()
    const text = blocks.filter((b) => b.type === 'text').map((b) => String(b.text || '')).join('\n').trim()
    if (!blocks.length) throw execError('bad-request', 'followup/say 缺内容（text 或 content 块数组）', 'followup/bad-request')

    /* ★ 2026-11-14：目标解析统一走 resolveTarget —— handleId 形态优先（契约 §2.5），
       没有才按 sessionId 兼容。失效句柄会抛 handle/revoked，不会静默改投。 */
    const tgt = await resolveTarget(args, 'followup')
    const picked = { agent: tgt.agent, how: tgt.how, live: tgt.live, why: null }
    const want = tgt.sessionId

    /* ★ content 原样透传 —— 一个块都不许丢（丢一块 = 她少看到一段话，而且没人会发现） */
    await picked.agent.followup({
      id: 'soul-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      role: 'user',
      content: blocks,
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
      handleId: tgt.handleId || undefined,
      candidates: live.length || 1,
      ambiguous: live.length > 1,
      candidateIds: live.length > 1 ? live.slice(0, 5).map((a) => String(a.id || '')) : undefined,
      chars: text.length,
      blocks: blocks.length,
      note: 'followup 已投递。「真的开了一轮」由 agent 的运行状态决定，本回执只证明投进去了',
    }
  }

  // ★★★ 2026-11-14（第 14 代）：反向调用（本宿主 → v4）的待答表。
  //   v4 的 ControlHub 那边登记了工具的真实现，这里发 invoke 去调它。
  const invokePending = new Map()
  let invokeSeq = 0
  /** 调 v4 那边登记的工具实现。★ 超时必须 reject —— 工具调用挂死比失败更坏。 */
  function invokeInV4 (tool, args, timeoutMs) {
    if (!st.connected || !st.ws) return Promise.reject(new Error('控制通道没连上，调不到 v4 的工具实现'))
    const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000
    const id = 'inv-' + (++invokeSeq) + '-' + Date.now().toString(36)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        invokePending.delete(id)
        reject(new Error('工具调用超时 ' + ms + 'ms：' + tool))
      }, ms)
      invokePending.set(id, { resolve, reject, timer })
      try {
        /* ★ 2026-11-14：send 返回 false = 连接其实已经断了（sendFrame 在 socket 销毁时回 false）。
           原来不看返回值 → Promise 挂满 30 秒才报「超时」，而真因是「根本没发出去」。
           现在立刻 reject 并给真因 —— 与「超时」是两件事。 */
        const sentOk = st.ws.send({ type: 'invoke', id, tool, args: args || {} })
        if (sentOk === false) {
          clearTimeout(timer)
          invokePending.delete(id)
          reject(new Error('invoke 发不出去（控制通道已断）：' + tool))
        }
      } catch (e) { clearTimeout(timer); invokePending.delete(id); reject(e) }
    })
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
    // ★★★ 2026-11-14（契约 §2.3）：v4 的批量确认。裁 ring，**不重发**。
    //   ★ ack 里订阅不存在不是致命错（可能是我方已 unsubscribe 后它才发）——
    //     但**不许静默**：日志里留一行，否则「ring 永远不缩」会被误读成内存泄漏。
    if (m.type === 'ack') {
      const a = hub.ack({ sub: m.sub, seq: m.seq })
      if (!a.ok) warn('收到 ack 但订阅不存在：sub=' + String(m.sub || '（空）') + ' seq=' + String(m.seq))
      return
    }
    // ★★★ 2026-11-14（第 14 代）：工具转发器的回执。
    //   ★ 找不到 pending 也不许崩 —— 可能是超时之后才到的迟到帧。
    if (m.type === 'invoke-result') {
      const p = invokePending.get(m.id)
      if (!p) return
      invokePending.delete(m.id)
      clearTimeout(p.timer)
      if (m.ok) p.resolve(m.data === undefined ? null : m.data)
      else p.reject(new Error(String(m.error || 'v4 报错')))
      return
    }
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
      // ★★★ 2026-11-13：**补发 hello 的最后一道保险**。
      //   为什么不能只靠 connect 那一刻：webServer 是异步就绪的（getOrigin 在 listen 前会抛），
      //   而 hello 只在 onOpen 发一次 —— 时机一旦错开，dshBaseUrl 就永远是 null。
      //   这里每 pingMs（25s）检查一次：抓到 origin 了、但发出去的 hello 里没有 => 重发。
      //   v4 的 hello 分支是整份覆盖 rec.meta，重发安全（重复 hello 只是刷新）。
      try {
        if (webServerOrigin && st.ws && st.ws.open && st.helloBaseUrl !== webServerOrigin) {
          sendHello(st.ws)
          log('补发 hello（dshBaseUrl=' + webServerOrigin + '，上次=' + String(st.helloBaseUrl) + '）')
        }
      } catch { /* 补发失败下一轮还会试 */ }
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
    // ★ 定时器与总线监听必须跟着插件一起拆 —— 否则热重载会累积出 N 个 5s 复验
    try { stopV2() } catch (e) { warn('拆 v2 失败（定时器可能残留一轮）：' + String((e && e.message) || e)) }
    if (st.retryTimer) { clearTimeout(st.retryTimer); st.retryTimer = null }
    try { if (st.ws) st.ws.close() } catch { /* 已经死了 */ }
    st.ws = null
    st.connected = false
    st.helloed = false
  }

  // ── 装配 ────────────────────────────────────────────────────
  // ★★ 2026-11-13：boot 的**调用**已经提前到 st 之后（见上面「先接控制通道」）。
  //  这里只留定义；函数声明会提升，所以前面调得到。stop 作为 disposer 在上面挂过。
  function boot () {
    log('启动（' + cfg.url + '）能力=[' + cfg.caps.join(',') + '] 桩=[' + cfg.stubCaps.join(',') + ']')
    connect()
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
  // ★ 只能用下划线开头的属性名：cordis 的 isSpecialProperty() 把下划线前缀当特殊属性、
  //   不走服务解析（cordis/lib/index.js:659-660），所以这种赋值不会抛。
  /* ★ 2026-11-14：v2 的三样状态也放进 diag —— probe/排障时能直接看到
     「现在有几条订阅、环里多少帧、手里握着哪些句柄」，而不是只能看日志猜。
     ★ 它们只读不改：动它们 = 动桥的内部状态（测试脚本正是靠这一点做无进程验证）。 */
  const diag = {
    cfg, st, readWatermark, pickLiveAgent, plan, routes: adminRoutes, stages: adminStages,
    hub, handles, gateway, publishSessionEvent, publishHostState, resolveTarget, hostStateSnapshot,
  }
  ctx.__agentSoulBridge = diag
  globalThis[Symbol.for('dsh.agentSoulBridge')] = diag

  // ★ 回执落盘：日志看不见的时候，这是唯一能证明「apply 走到哪一步」的东西。
  //   重启后先看这个文件：stages 里有 route:/agent-soul/status 就说明端点挂上了。
  // ★ 用**函数声明**而不是 const 箭头：它要作为回调提前传给 wireAdmin，
  //   而 wireAdmin 的调用点在上面的「先接控制通道」那段 —— const 在那里还在 TDZ。
  //   （这个坑两次踩到同一个形状，所以注释留在这儿：本文件里任何被提前引用的东西都得是声明。）
  function snapshot () {
    writeApplyReceipt(cfg, {
      at: Date.now(),
      version: VERSION,
      pid: process.pid,
      stages: adminStages.slice(),
      routes: adminRoutes.slice(),
      plan: { root: plan.root, exe: plan.exe, exeExists: plan.exists },
      bridge: { url: cfg.url, connected: !!st.connected },
    })
  }
  snapshot()
}

// ★★ 2026-11-13（真因）：inject 必须**同时**写在 default 上。
//   Loader.unwrapExports()（cordis-plugin-loader lib/index.js:746-751）取的是
//   exports.default ?? exports —— 只写模块级的 export const inject 会被这个 default
//   整个盖掉。Cordis 于是认为本插件没声明任何依赖，任何 ctx.webServer 访问都会抛：
//     cannot get property "webServer" without inject
//   apply 崩 → Loader._start 的 catch → _dispose(fiber) → 已注册路由与 ws 一起被回收。
//   症状：端点全 404 + control.connected=0 同时出现 —— 一次都不例外。
export default { name, inject, apply }

/* ══ 把 agent-soul 拉起来（2026-11-13 爀曦定）═══════════════════════════
   DSH 重启后 agent-soul 若没在跑，换气/心跳/调度整条链全哑 —— 而这片机器上
   唯一的常驻者是 bridge 自己。所以它连不上时不干等，去把对方叫醒：
   · 每 30 秒探一次 /api/health（1.5s 超时）
   · 不在线且距上次拉起 > agentSoulSpawnGapMs，就 detached spawn
   · 绝不重复 spawn：gap 兜底；detached + unref 让它活过本回合
   · cwd 必须是 agent-soul 根目录（dataDir 按 cwd 解析，指错会建假目录）
   ─────────────────────────────────────────────────────────────────── */
const AGENT_SOUL_KEEPER = Symbol.for('dsh.agentSoulKeeper')
const AGENT_SOUL_LIFECYCLE = Symbol.for('dsh.agentSoulLifecycle')

export function startAgentSoulKeeper (cfg) {
  if (globalThis[AGENT_SOUL_KEEPER]) return globalThis[AGENT_SOUL_KEEPER]
  const c = cfg || {}
  const root = String(c.agentSoulRoot || '').trim()
  if (!root) {
    const off = { enabled: false, probe: async () => {} }
    globalThis[AGENT_SOUL_KEEPER] = off
    return off
  }
  const plan = agentSoulPlan(c)
  const exe = plan.exe
  const auto = c.agentSoulAutoStart !== false
  const gap = Math.max(30000, Number(c.agentSoulSpawnGapMs) || 90000)
  const st = { alive: false, misses: 0, spawned: 0, lastSpawn: 0, lastError: null, lastProbeAt: 0 }

  const probe = async () => {
    st.lastProbeAt = Date.now()
    try {
      const ctl = new AbortController()
      const tm = setTimeout(() => ctl.abort(), 4000)
      const r = await fetch('http://127.0.0.1:7310/api/health', { signal: ctl.signal })
      clearTimeout(tm)
      st.alive = !!r.ok
    } catch (e) { st.alive = false }
    if (st.alive) { st.misses = 0; return st }
    /* ★★ 2026-11-13：**一次超时不算死**。
       原来 1.5s 判死就 spawn —— 而 /api/overview 实测要 4.5s，机器一忙就会
       「明明在跑却又拉起一个」，2026-11-13 13:36 的测试里当场复现过一次。
       现在：连续 2 次没应答、且距上次拉起 > gap，才动手。 */
    st.misses += 1
    if (st.misses < 2) return st
    if (!auto) return st
    const now = Date.now()
    if (now - st.lastSpawn < gap) return st
    st.lastSpawn = now
    const shared = globalThis[AGENT_SOUL_LIFECYCLE]
    if (shared && typeof shared.keeperProbe === 'function') {
      const r = await shared.keeperProbe(auto, gap)
      if (r && r.ok === false) st.lastError = r.reason || st.lastError
      if (r && r.spawned) { st.spawned += 1; st.misses = 0 }
      return st
    }
    const sp = globalThis[AGENT_SOUL_LIFECYCLE]
    if (!sp || typeof sp.keeperProbe !== 'function') {
      st.lastError = 'lifecycle-unavailable'
      return st
    }
    const r = await sp.keeperProbe(auto, gap)
    if (r && r.ok === false) st.lastError = r.reason || st.lastError
    if (r && r.spawned) { st.spawned += 1; st.misses = 0 }
    return st
  }

  probe()
  const timer = setInterval(probe, 30000)
  if (timer.unref) timer.unref()

  const api = { enabled: true, root, exe, probe, state: st }
  globalThis[AGENT_SOUL_KEEPER] = api
  console.log('[agent-soul] 守护已启用 · root=' + root)
  return api
}
