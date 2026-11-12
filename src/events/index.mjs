// 事件接入（core）—— **策略层 + 唯一事件账的拥有者**
// ============================================================================
// 迁入自原型 plugins/aurabot-ingress（2026-11-10），按 lead 裁定改了四件事：
//
//   ① 宿主半没有搬：原型是一个 DSH 插件（装它要重启 DSH、在 DSH 进程里写账）。
//      现在由 core 自己持有 —— 复用 core 的单实例和 shutdown，不新开顶层框架，
//      也没有第二个进程能写同一份账。
//   ② 写域唯一：账落 `<AGENT_SOUL_DATA>/events/`（本文件一处推导，**不接受任意路径**）。
//      原事件队列 / lead-waker 台账**只读**，不复制、不改写、不立第三份权威。
//      manifest（security/write-manifest.mjs 的 EVENT_WRITE_DOMAIN）登记 soleWriter。
//   ③ 默认 disabled：mode=off 时不连、不收、**连目录都不建**。
//      只有「显式 enabled 且非 readonly」才 start（见 start() 的两道闸）。
//      未验 R1 之前不许连真实网关 —— 所以默认值必须是 off，测试也只打 mock。
//   ④ 两种通路**互斥**：direct-ws 或 bridge-events，一个 mode 只能取一个值；
//      旧式配置若把 onebot.enabled 与 bridge.enabled 都打开 → 一律按 off 处理并报错。
//
// ★ 本模块**导入时没有任何副作用**：不建目录、不连 WS、不起定时器。
//   唯一的副作用在 start() 里（那一处单独的注释标出来了）。
// ============================================================================

import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { openStore, isReadonlyFlag } from './store.mjs'
// ★ 2026-11-11：帧 → 事件的接线（推导器）。它只在 start() 之后存在 ——
//   mode=off 时连 import 都只是加载一个纯函数模块，不读盘、不建目录。
import { createEventDeriver } from './derive.mjs'
// ★ 2026-11-12：事件 → 唤醒的翻译层（补链路最后一段）。它只拼不投。
import { createEventWaker } from './wake.mjs'
import { createWakeDeliverer } from './deliver.mjs'
import { createReplyReader } from './reply.mjs'
import { createResponder } from './respond.mjs'
import { createMemberResolver } from './members.mjs'
import { createEngage } from './engage.mjs'
import { createStickerLib } from './stickers.mjs'
import { createTts } from '../voice/tts.mjs'
// ★ 2026-11-12：**先判该不该回，再拼**。这一步才是「事件层」的意义所在。
import { createEventDecider } from './decide.mjs'
import { createOneBotIngress } from './ingress-onebot.mjs'
import { createLeadRelayIngress } from './ingress-lead-relay.mjs'
import { createBridgeEventsCounter } from './ingress-bridge-count.mjs'
import { buildStatus } from './status.mjs'
import { EVENT_WRITE_DOMAIN } from '../security/write-manifest.mjs'

export const MODES = Object.freeze({ off: 'off', directWs: 'direct-ws', bridgeEvents: 'bridge-events' })
export const MODE_LIST = [MODES.off, MODES.directWs, MODES.bridgeEvents]

/**
 * 事件账目录 —— **全项目唯一一处**。
 * 判据：AGENT_SOUL_DATA 之下固定叫 events；不给配置项、不读 DSH_HOME、不猜。
 */
export function eventsDirOf (cfg) {
  const data = String((cfg && cfg.dataDir) || '').trim()
  return data ? path.join(data, 'events') : ''
}

/**
 * 把配置归一成「一个 mode」。
 * 三种输入都收：mode（新）、onebot.enabled / bridge.enabled（旧、原型式）。
 * ★ 同时开两个 → 直接 off + 错误（不是挑一个，也不是都开）。
 */
export function normalizeIngressConfig (cfg) {
  const ing = (cfg && cfg.events && cfg.events.ingress) || {}
  const ob = ing.onebot || {}
  const br = ing.bridge || {}
  const legacyBoth = Boolean(ob.enabled) && Boolean(br.enabled)
  let mode = String(ing.mode || '').trim()
  if (legacyBoth) {
    return {
      mode: MODES.off,
      error: { code: 'BOTH_MODES_ENABLED', message: 'direct-ws 与 bridge-events 只能启用一种（onebot.enabled 与 bridge.enabled 同时为 true）—— 一律按 off 处理：不连、不收、不写' },
      onebot: ob, bridge: br, leadRelay: ing.leadRelay || {},
    }
  }
  if (!mode) mode = ob.enabled ? MODES.directWs : (br.enabled ? MODES.bridgeEvents : MODES.off)
  if (!MODE_LIST.includes(mode)) {
    return { mode: MODES.off, error: { code: 'BAD_MODE', message: '未知 mode=' + mode + '（只接受 off / direct-ws / bridge-events）' }, onebot: ob, bridge: br, leadRelay: ing.leadRelay || {} }
  }
  if (mode === MODES.directWs && !String(ob.wsUrl || '').trim()) {
    return { mode, error: { code: 'NO_ENDPOINT', message: 'direct-ws 需要显式 wsUrl（端口不是协议常量，core 不猜也不读部署配置）' }, onebot: ob, bridge: br, leadRelay: ing.leadRelay || {} }
  }
  if (mode === MODES.bridgeEvents && !String(br.eventsPath || '').trim()) {
    return { mode, error: { code: 'NO_BRIDGE_PATH', message: 'bridge-events 需要显式 bridge.eventsPath（只数行，不搬内容）' }, onebot: ob, bridge: br, leadRelay: ing.leadRelay || {} }
  }
  return { mode, error: null, onebot: ob, bridge: br, leadRelay: ing.leadRelay || {} }
}

/** 脱敏器：只抹形状，不依赖「知道那个 token 是什么」。token 只从环境变量来，配置里不存。 */
export function createRedactor (secrets = []) {
  const list = secrets.filter((s) => s && String(s).length >= 4).map(String)
  return function redact (text) {
    let s = String(text == null ? '' : text)
    for (const sec of list) if (s.includes(sec)) s = s.split(sec).join('***')
    s = s.replace(/(access_token=)[^&\s"']+/gi, '$1***')
    s = s.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, '$1***')
    s = s.replace(/((?:token|password|secret|api[_-]?key)["']?\s*[:=]\s*["']?)([^\s"',;&]{4,})/gi, '$1***')
    return s
  }
}

/**
 * 造一个事件接入运行时。
 * 返回对象形状：{ enabled, mode, error, dir, start, stop, status, tail, readAll, authority }
 * ★ 这个函数本身不产生任何磁盘/网络副作用 —— 只有 start() 会。
 */
export function createEventsIngress (opts = {}) {
  const config = opts.config || {}
  const env = opts.env || process.env
  const log = opts.log || (() => {})
  const now = opts.now || (() => Date.now())
  const transport = opts.transport || null
  const beatMs = Number(opts.beatMs) || 30_000

  const resolved = normalizeIngressConfig(config)
  const dir = eventsDirOf(config)
  const readonly = isReadonlyFlag(env)
  const enabled = resolved.mode !== MODES.off && !resolved.error
  const bootId = opts.bootId || randomBytes(4).toString('hex')

  // token 只从环境变量取（名字由配置给），只进内存，不进任何产物。
  const ob = resolved.onebot || {}
  const tokenEnv = String(ob.tokenEnv || '').trim()
  const token = tokenEnv ? String(env[tokenEnv] || '') : ''
  const redact = createRedactor([token])

  let store = null
  let deriver = null
  let onebot = null
  let waker = null
  let deliverer = null
  // ★ 2026-11-12：这三个**必须在 createEventsIngress 这一层**，不能声明在下面的 if 块里 ——
  //   status() 在外面读它们，块内的 let 会变成 "responder is not defined"，
  //   而那个错会把整个 /api/events 打成 {"error":...}（面板全空）。
  //   踩过一次：改完 core 一起来 /api/events 就只回一句 error。
  let replyReader = null
  let responder = null
  // ★★ 2026-11-12：插话要的三份跨事件状态（插话冷却 / 说话刹车 / 加入话题）。
  //   没有它们时 policy 的 cooldownSec / maxPerHour / 刹车全部失效 ——
  //   那正是当初把插话强制关掉的原因。现在建起来了，开关也给了显式入口。
  //   ★ 仍然是**只存内存**：这三份是「最近几分钟」的短时记忆，
  //     频繁写盘比重启清零贵得多。接口留了清空/视图，要持久化再说。
  const engage = createEngage({ now })
  let decider = null
  let leadrelay = null
  let bridge = null
  let beat = null
  let started = false
  let startRefusal = null
  let stopped = null

  function authority () {
    return {
      dir,
      dirRel: EVENT_WRITE_DOMAIN.dirRel,
      soleWriter: EVENT_WRITE_DOMAIN.soleWriter,
      writerFile: EVENT_WRITE_DOMAIN.writerFile,
      manifest: EVENT_WRITE_DOMAIN.id,
      files: EVENT_WRITE_DOMAIN.files.slice(),
      readOnlyForeign: EVENT_WRITE_DOMAIN.readOnlyForeign.slice(),
    }
  }

  function snapshots () {
    const out = {}
    if (onebot) out.onebot = onebot.snapshot()
    if (leadrelay) out['lead-relay'] = leadrelay.snapshot()
    if (bridge) out.bridge = bridge.snapshot()
    return out
  }

  function status () {
    return buildStatus({
      store,
      sources: snapshots(),
      config,
      mode: enabled ? resolved.mode : MODES.off,
      authority: authority(),
      extra: {
        bootId,
        started,
        // ★ 事件账的读数放在**事件接入**的状态里（而不是另开一个口）：
        //   「收了多少帧」与「解释出多少事件」必须能一起看 —— 分开看会误判成丢了一半。
        //   没起来（mode=off / 只读）时明确是 null，不是 0：0 会被读成「一个事件都没解出来」。
        eventsLedger: deriver ? deriver.stats() : null,
        // ★ 2026-11-12：唤醒层与投递层的读数。**不含正文** —— view() 只给计数与跳过码。
        //   放在 extra 而不是 sources：sources 只认 onebot / lead-relay / bridge 三个来源，
        //   塞进去会被 status.mjs 白名单丢掉（第一版就是这么丢的，页面上一片空白）。
        //   ★ 没有它，这两层就是「看不见的层」：拼错了、投丢了，都看不出来。
        wake: waker ? waker.view() : null,
        decide: decider ? decider.view() : null,
        deliver: deliverer ? deliverer.view() : null,
        // ★★ 2026-11-12：闭环另一半的读数。
        //   watching > 0 = 有投递正在等回复；sent 涨 = 回复真的发到 QQ 了。
        //   null = 没建起来（缺 sessionRoot / outbox）—— 那是能力缺口，不是「现在没在等」。
        reply: responder ? responder.view() : null,
        // ★★ 2026-11-12：三份插话状态的读数。
        //   replies / interjects 涨 = 记账真的在发生（上一轮就是「建了但没人写」）。
        //   engagedGroups > 0 = 她当前被算作「在聊」的群。
        engage: engage ? engage.view() : null,
        ...(resolved.error ? { configError: resolved.error } : {}),
        ...(startRefusal ? { startRefusal } : {}),
        ...(stopped ? { stopped } : {}),
      },
    })
  }

  /** 写状态快照。★ 目的只有一个：core 不在的时候，别人也能看到最后一口气（离线读手读它）。 */
  function writeStatusSnapshot (extra = {}) {
    if (!store || !store.writable) return false
    return store.flushStatus({ status: status(), ...extra })
  }

  /**
   * ★★ 唯一的副作用出口（原型里叫 index.js 的 apply()/createRuntime()）。
   * 两道闸：
   *   ① 没启用（mode=off 或配置有错）→ 不建目录、不连、不起定时器；
   *   ② readonly（AGENT_SOUL_READONLY=1）→ 连目录都不创建（创建目录也是写），只读已有账。
   */
  function start () {
    if (started) return { started: true, already: true }
    if (!enabled) {
      startRefusal = resolved.error || { code: 'DISABLED', message: 'mode=off（默认）—— 不连、不收、不建目录' }
      log('[events] 未启用：' + startRefusal.message)
      return { started: false, reason: startRefusal }
    }
    if (readonly) {
      // 只读：读一读已有账（不 mkdir），一条也不写，一个 socket 也不开
      store = openStore({ dir, readonly: true, env, now, log })
      startRefusal = { code: 'READONLY', message: 'AGENT_SOUL_READONLY=1：不启动接入、不创建事件目录（已存在则只读）' }
      log('[events] ' + startRefusal.message)
      return { started: false, reason: startRefusal }
    }

    store = openStore({ dir, env, now, log })
    // ★ 2026-11-12：事件 → 投递请求的翻译器（补链路最后一段：事件只带 frameIds，没有正文）。
    //   **只拼不投** —— 投递会真的叫醒一个会话（花钱、动文件），所以先让它只产文本、只记账；
    //   等网关起来、拼对了、白名单定了，再由上层决定投不投。
    //   ★ 白名单默认 **none**：不配就一条都不叫。这跟 ingress 的 allow 是同一条纪律 ——
    //     「默认什么都不做」比「默认全做」少一次半夜被叫醒。
    //   ★ 已知代价：compose 会自己 readAll() 一次，所以每次 derive 读两遍帧账
    //     （本机 1000 帧 / 20 会话实测一遍约 18ms）。量级不大，但它是线性的 ——
    //     一万帧时该做的是把 rows 传进来复用，而不是把索引塞进内存。
    // ★ 2026-11-12：「该不该回」的判定器。默认**开着** —— 它只过滤，不投递，
    //   开着的代价是「有些消息不拼了」，关掉的代价是「什么都拼、什么都可能投」。
    //   ★ 规则来自 policy.mjs（从 aurabot 原样搬来），插话被强制关掉（理由在那边头注）。
    decider = createEventDecider({
      store,
      // ★ 2026-11-12：主人 QQ 归 events.wake 管（它不是 integrations 的事，
      //   判定要用它区分「主人说的」和「别人说的」）。integrations 那条留着兜底。
      ownerQQ: (config.events && config.events.wake && config.events.wake.ownerQQ)
        || (config.integrations && config.integrations.ownerQQ) || '',
      selfId: (config.events && config.events.ingress && config.events.ingress.onebot && config.events.ingress.onebot.selfId) || '',
      // ★ 一组「还算我自己」的 id。两个 QQ 号都是同一个人（砚青），
      //   群里 @ 哪个都该算叫到我 —— 而收消息的那只耳朵可能只是其中一个号。
      selfIds: (config.events && config.events.wake && config.events.wake.selfIds) || [],
      policy: (config.events && config.events.wake && config.events.wake.policy) || undefined,
      overrides: (config.events && config.events.wake && config.events.wake.groupOverrides) || undefined,
      // ★★ 插话的显式开关（默认关）。开它 = 允许她在没人叫的时候自己开口。
      //   两个条件都满足才真能插话：开关打开 + engage 存在（三份状态齐了）。
      interject: Boolean(config.events && config.events.wake && config.events.wake.interject),
      engage,
      log,
    })
    waker = createEventWaker({
      store,
      allow: (config.events && config.events.wake && config.events.wake.allow) || undefined,
      maxChars: (config.events && config.events.wake && config.events.wake.maxChars) || undefined,
      log,
    })
    // ★ 2026-11-12：投递器。**默认关**（events.wake.deliver 不给就是 false）。
    //   ★ 它的开关是函数，每次投递前读一次 —— 改配置不用重启 core。
    // ★★ 2026-11-12：闭环的另一半 —— 投出去之后把回复要回来发到 QQ。
    //
    //   为什么需要读日志：v4 不在宿主进程里，控制通道是单向的（v4 请求 → 宿主应答），
    //   收不到 turn/end 事件。之前这一步是 aurabot 的 onSessionEvent 做的。
    //
    //   ★ 三样缺一就**不建** responder（而不是建个残缺的）：
    //     sessionRoot（读哪）/ outbox（发哪）/ 配置里的 reply 段。
    //     缺任一样时 deliver.view() 的 hasResponder 会是 false —— 那是能力缺口的显式标注，
    //     不是「配置错了」这种含糊状态。
    const _replyCfg = (config.events && config.events.reply) || {}
    const _replyRoot = String(_replyCfg.sessionRoot || '').trim()
    if (_replyRoot && opts.outbox) {
      try {
        replyReader = createReplyReader({
          sessionRoot: _replyRoot,
          tailBytes: _replyCfg.tailBytes,
          log: (m) => log('[reply] ' + m),
        })
        // ★ 群成员解析器：<at:名字> 要换成 QQ 号才能真 @。
        //   ★ 只配群聊能用（私聊没有成员表）；没配 httpUrl 时它不存在，
        //     那时 <at:名字> 会原样保留 —— 明确的能力缺口。
        let members = null
        try {
          const _eg = (config.events && config.events.egress && config.events.egress.onebot) || {}
          const _tokEnv = String(_eg.tokenEnv || '').trim()
          const _tok = _tokEnv ? String(env[_tokEnv] == null ? '' : env[_tokEnv]).trim() : ''
          if (_eg.httpUrl) {
            members = createMemberResolver({
              httpUrl: _eg.httpUrl,
              token: _tok,
              ttlMs: _replyCfg.memberTtlMs,
              log: (m) => log(m),
            })
          }
        } catch (e) {
          log('[reply] 群成员解析器建不起来：' + String((e && e.message) || e))
        }
        // ★ 表情库：读 aurabot 那份（plugins-data，不是安装目录）——
        //   禁用插件不会删数据，所以 v4 直接读它，不复制（复制会两边不同步）。
        let stickerLib = null
        try {
          const root = String(_replyCfg.stickerRoot || 'D:/AI/dsh/home/plugins-data/aurabot/stickers').trim()
          stickerLib = createStickerLib({ root, ttlMs: _replyCfg.stickerTtlMs, log: (m) => log('[sticker] ' + m) })
        } catch (e) {
          log('[reply] 表情库建不起来：' + String((e && e.message) || e))
        }
        // ★ 语音：只用 Windows 自带（pyenv 实测不存在，edge-tts 从来没装过 ——
        //   aurabot 自己也在走这个兜底）。产出放 data/voice-cache。
        let tts = null
        try {
          tts = createTts({ outDir: _replyCfg.voiceCacheDir || 'D:/AI/agent-soul/data/voice-cache', log: (m) => log('[tts] ' + m) })
        } catch (e) {
          log('[reply] 语音建不起来：' + String((e && e.message) || e))
        }
        responder = createResponder({
          replyReader,
          outbox: opts.outbox,
          members,
          stickers: stickerLib,
          tts,
          // ★ 沉默时退出话题（leaveTopic），否则 engagedUntil 会一直挂着。
          engage,
          pollMs: _replyCfg.pollMs,
          timeoutMs: _replyCfg.timeoutMs,
          log: (m) => log(m),
        })
      } catch (e) {
        log('[reply] 建不起来（' + String((e && e.message) || e) + '）—— 这一轮只投不回')
        replyReader = null
        responder = null
      }
    } else {
      log('[reply] 没建：' + (!_replyRoot ? '缺 events.reply.sessionRoot' : '缺 outbox') + ' —— 只投不回')
    }

    deliverer = createWakeDeliverer({
      dispatch: opts.dispatch || null,
      enabled: () => Boolean(config.events && config.events.wake && config.events.wake.deliver),
      responder,
      // ★ 投递成功 = 她开口了 → 记进 engage（noteReply + joinTopic）。
      engage,
      log,
    })
    deriver = createEventDeriver({
      store,
      now,
      log,
      // 规则可以覆盖（配置是参数，默认值在 coalesce.mjs 里）；不配就用默认档。
      rules: (config.events && config.events.coalesce && config.events.coalesce.rules) || undefined,
      // ★ 只在**真正入账之后**触发；onEvents 自己包了 try/catch，抛错不会把推导带下去。
      onEvents: (evs) => {
        if (!waker) return
        // ★★ 2026-11-12：**先判，再拼**。判成「不该回」的连正文都不拼 ——
        //   拼正文是给投递用的，不该回的消息拼出来只会占内存、并且在统计里制造噪音。
        //   ★ 判不了（没有 store / 帧缺失）时**不拦**：那种情况下宁可多拼一条，
        //     也不要让一个坏事件把整条链静默关掉。判不了算 failed，看得见。
        let worth = evs
        // ★ 判定的结论要**跟着 ask 一起走**，不能判完就扔：
        //   mode='must'（被@/叫名字）和 mode='interject'（插一句）在投递时该有不同处置，
        //   而上层只看得到「投一句话」的话，那个区别就永远用不上。
        const verdicts = new Map()
        if (decider) {
          worth = []
          for (const ev of evs) {
            const d = decider.decide(ev)
            if (d && d.ok) verdicts.set(String(ev.id), d)
            // ★★ 2026-11-12：记「这一段最后说话的人」—— 戳一戳的兜底目标。
            //   ★ 为什么在 onEvents 里记而不是 decide 里：onEvents 只在**新事件**时触发，
            //     decide 会被重放调用。在 decide 里记会让状态被同一条消息刷很多遍。
            if (d && d.ok && engage) {
              const gid = String(ev.chatId || '').startsWith('group:') ? String(ev.chatId).slice(6) : ''
              if (gid && d.lastUserId) {
                try { engage.noteSpeaker(gid, d.lastUserId) } catch (e) { /* 记账失败不该炸这条链 */ }
              }
            }
            if (d && d.ok && d.reply) {
              worth.push(ev)
              // ★★ 判成「插一句」= 她自己开口了 → 当场记进 engage。
              //
              //   为什么不放到投递成功后记：**判定的那一刻她就已经决定开口**，
              //   而投递可能因为开关关着 / 没会话 / 失败而不发生 —— 那时
              //   interjectTimes 不涨，冷却就永远不生效，下一次还会继续插。
              //   插话额度要按「她想说几次」算，不是按「成功送出去几次」。
              //
              //   ★ 投递那边会跳过 noteReply（见 deliver.mjs），避免双记。
              if (String(d.mode) === 'interject') {
                const gid = String(ev.chatId || '').startsWith('group:') ? String(ev.chatId).slice(6) : ''
                if (engage && gid) {
                  try { engage.noteInterject(gid) } catch (e) { log('[engage] 记插话失败：' + String((e && e.message) || e)) }
                }
              }
            }
          }
          if (!worth.length) return
        }
        const r = waker.compose(worth)
        if (!r || !r.ok || !r.asks.length) return
        for (const a of r.asks) {
          const v = verdicts.get(String(a.eventId))
          if (!v) continue
          a.mode = v.mode
          a.reason = v.reason
          a.relevance = v.relevance
          a.mentions = v.mentions
        }
        if (!deliverer) return
        // ★ 不 await：这条路径在落帧上，等一次网络往返会把收帧拖住。
        //   投递失败由 deliverer 自己记（lastCode / skipped / errors），这里只负责别炸。
        Promise.resolve(deliverer.deliver(r.asks)).catch(() => {})
      },
    })

    // ★ 落帧之后的钩子：**一次推导 + 一次状态快照**。
    //   为什么推导放在这里而不是 setInterval：推导是纯函数全量重算，
    //   跟着帧走就等于「有变化才算」，没人说话时一个时钟都不需要。
    //   ★ 实测代价（本机，1000 帧 / 20 个会话）：一次 derive 中位 18ms ——
    //     coalesce 本身约 2.5ms，其余是 readAll() 把整本 envelopes.jsonl parse 一遍。
    //     线性长：一万帧量级约 0.2s/条。到那时该做的是把帧分片，而不是把状态机塞回内存。
    //   ★ 代价必须说清：没有新帧时窗口到期不会被立刻发现 —— 见 derive.mjs 头注释。
    //   推导失败一律吞在这里：**收帧是主线，推导是派生**，派生不许把主线搞崩。
    const onFlush = () => {
      try { if (deriver) deriver.derive() } catch { /* 推导失败不影响收帧，错误在 deriver.stats / errors.jsonl */ }
      try { writeStatusSnapshot() } catch { /* 状态写不进去不许影响收事件 */ }
    }

    // ★ 起来时先推导一次：进程不在的那段时间里**已经到期**的窗口，不该等到下一条帧才落盘。
    //   这一步只读账 + 写幂等的事件账，不做任何网络动作。
    try { deriver.derive() } catch { /* 同上：派生失败不阻止接入启动 */ }

    if (resolved.mode === MODES.directWs) {
      onebot = createOneBotIngress({
        store,
        url: String(ob.wsUrl || ''),
        tokenProvider: async () => token,
        allow: ob.allow,
        maxReconnect: Number(ob.maxReconnect) || 3,
        backoffMs: Array.isArray(ob.backoffMs) ? ob.backoffMs : [250, 500, 1000],
        selfId: ob.selfId || '',
        bootId,
        redact,
        log,
        now,
        onFlush,
        transport,
        // ★★ 2026-11-12：notice 旁路 —— 只记「谁戳了她」，不进帧账。
        //   判据：target_id 是自己 → 有人戳了她 → 记下这个人。
        //   ★ 群聊记 group_id；私聊没 group_id 就不记（私聊戳回去本来不需要目标）。
        onNotice: (n) => {
          try { engage.notePokeNotice(n) } catch (e) { log('[engage] 记 pokers 失败：' + String((e && e.message) || e)) }
        },
      })
    }
    // lead-relay 是**另一条**只读访问（不在互斥范围内：它读的是文件，不占 WS）。
    // 它默认关着，只有显式 leadRelay.enabled 才开 —— 两种 WS 通路互斥说的是 direct-ws 与 bridge-events。
    const lr = resolved.leadRelay || {}
    if (lr.enabled && String(lr.queuePath || '').trim()) {
      leadrelay = createLeadRelayIngress({
        store,
        queuePath: String(lr.queuePath),
        pollMs: Number(lr.pollMs) || 2000,
        bootId,
        redact,
        log,
        now,
        onFlush,
      })
    }

    if (resolved.mode === MODES.bridgeEvents) {
      bridge = createBridgeEventsCounter({
        store,
        eventsPath: String((resolved.bridge || {}).eventsPath || ''),
        pollMs: Number((resolved.bridge || {}).pollMs) || 2000,
        source: String((resolved.bridge || {}).source || 'onebot'),
        log,
        now,
      })
    }

    if (onebot) onebot.start()
    if (leadrelay) leadrelay.start()
    if (bridge) bridge.start()
    started = true
    stopped = null
    writeStatusSnapshot()
    if (!beat) {
      // 心跳：没事件也要刷新，否则「连着但很安静」会被读成「进程死了」
      beat = setInterval(() => { try { writeStatusSnapshot() } catch { /* ignore */ } }, beatMs)
      if (beat.unref) beat.unref()
    }
    if (!config.quiet) {
      log('[events] started mode=' + resolved.mode + ' dir=' + dir + ' (soleWriter=' + EVENT_WRITE_DOMAIN.soleWriter + ')')
    }
    return { started: true, mode: resolved.mode, dir }
  }

  /**
   * 停：先停 WS / 轮询 → 再写最后一口气 → started=false。
   * ★ core 的 shutdown 先调这个，再 closeAll（见 src/index.mjs）——
   *   顺序反了就是「关灯之后还让人进门」。
   */
  function stop (reason = 'stop', o = {}) {
    const finalSnapshot = o.finalSnapshot !== false
    if (onebot) onebot.stop()
    if (leadrelay) leadrelay.stop()
    if (bridge) bridge.stop()
    if (beat) { clearInterval(beat); beat = null }
    // ★ 关灯前再推导一次：本次运行里**已经到期**的窗口不必等下次启动才落盘。
    //   （仍在窗口内的那些照旧不写 —— 它们还没结束，写下去就是把一半当成全部。）
    try { if (deriver) deriver.derive() } catch { /* 关灯路径上不许抛 */ }
    if (started) stopped = { reason: String(reason), at: new Date(now()).toISOString() }
    started = false
    if (finalSnapshot) { try { writeStatusSnapshot() } catch { /* ignore */ } }
    return { stopped: true, reason }
  }

  return {
    get enabled () { return enabled },
    get mode () { return resolved.mode },
    get error () { return resolved.error },
    get readonly () { return readonly },
    get dir () { return dir },
    get started () { return started },
    get store () { return store },
    bootId,
    start,
    stop,
    status,
    writeStatusSnapshot,
    authority,
    tail (n) { return store ? store.tail(n) : [] },
    readAll () { return store ? store.readAll() : [] },
    // ★ 事件账的只读口（供 /api 用）。since 是毫秒或 ISO，按 openedAt 过滤；
    //   解析不出来会抛 TypeError —— 让调用方看见，而不是给它一份过滤错的结果。
    readEvents (o) { return store ? store.readEvents(o) : [] },
    // ★ 立刻跑一次推导（下一次触发的手动版）：给测试、给「停机前想立刻看到」的场景。
    //   生产路径上它由 onFlush / start / stop 自动调用，不需要外部来推。
    deriveEvents () { return deriver ? deriver.derive() : { ok: false, code: 'NO_STORE' } },
    eventsStats () { return deriver ? deriver.stats() : null },
  }
}
