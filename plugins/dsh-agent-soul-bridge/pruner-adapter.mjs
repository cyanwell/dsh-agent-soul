/**
 * pruner-adapter.mjs —— 「定点清理」在桥这一侧的**薄适配**（2026-11-11）
 * ==================================================================
 *
 * 它只做四件事，**不写任何 surface 逻辑**：
 *   ① 解析请求（复用 index.js 的 describePrunerRequest —— 纯函数，已经测过）
 *   ② 找到目标会话的活 Agent（agents.get(sessionId)，显式 id，不兜底）
 *   ③ 找到**真正干活的 pruner 实例**（三条通道，见 resolvePruner）
 *   ④ 调它的 applyDrops(...)，把回执翻译成 v4 认得的那几个字段
 *
 * ★ 三条通道为什么都要试：
 *   a) module-registry —— 桥 import 'dsh-yanqing-pruner'，同一份模块实例里有个活实例表。
 *      这是**最硬**的一条：不依赖任何 realm 语义。但它只在「桥解析到的绝对路径 =
 *      宿主加载的那一份」时成立；解析到另一份副本时表是空的（那就如实失败，不造假）。
 *   b) ctx.get('toolResultPruner') —— 桥挂在 profile 根层，pruner 注册在 preset 的
 *      agent ctx 上。根层 ctx **拿不到子 ctx 的服务**（Cordis 的可见性是向父不向子）。
 *      留着它是因为「万一」—— 命令结果为空就继续往下试，不报错。
 *   c) agent.ctx / agent.session.ctx —— 这两个是**子 ctx**，按 Cordis 语义看得见父层服务。
 *      这是 EVALUATION.md §四 里那个「未验」的前提；本文件把它变成**运行时尝试**，
 *      而不是靠猜。
 *
 * ★ 拿不到实例 → 抛错（stage='no-pruner'），**绝不**自己拼 compaction/prune +
 *   surfaceOp.replace 顶上（那是把 pruner 的策略抄一份到桥里：门牌、影子定价、
 *   replay 语义全要跟着漂）。
 */

export const PRUNER_CAP = 'pruner'
export const PRUNER_ACTION = 'targeted-cleanup'

let _mod = null
let _modTried = false

/** 默认的模块加载器：失败就记 null（不抛到 exec 链路上，让它变成一条可读的 stage）。 */
async function defaultLoadModule () {
  if (_modTried) return _mod
  _modTried = true
  try {
    _mod = await import('dsh-yanqing-pruner')
  } catch (e) {
    _mod = null
    defaultLoadModule.lastError = String((e && e.message) || e)
  }
  return _mod
}

function getService (ctx, name) {
  try {
    if (!ctx || typeof ctx.get !== 'function') return undefined
    return ctx.get(name)
  } catch { return undefined }
}

/**
 * 找 pruner 实例。返回 { pruner, how, tried }；找不到时 pruner 为 null 且 tried 里写着每条为什么。
 */
export async function resolvePruner (ctx, sessionId, deps = {}) {
  const load = typeof deps.loadPrunerModule === 'function' ? deps.loadPrunerModule : defaultLoadModule
  const tried = []

  // a) 模块级活实例表
  let mod = null
  try { mod = await load() } catch (e) { mod = null; tried.push({ how: 'module-registry', got: false, why: 'load threw: ' + String((e && e.message) || e) }) }
  if (mod && typeof mod.getLivePruner === 'function') {
    let p = null
    try { p = mod.getLivePruner(sessionId) } catch { p = null }
    const ok = !!(p && typeof p.applyDrops === 'function')
    tried.push({ how: 'module-registry', got: ok, live: typeof mod.livePrunerCount === 'function' ? mod.livePrunerCount() : null })
    if (ok) return { pruner: p, how: 'module-registry', tried }
  } else {
    tried.push({ how: 'module-registry', got: false, why: 'import 不到 dsh-yanqing-pruner（或那份副本没有 getLivePruner）' })
  }

  // b) 根 ctx（大概率是 undefined —— 留着是为了「万一」）
  const direct = getService(ctx, 'toolResultPruner')
  const directOk = !!(direct && typeof direct.applyDrops === 'function')
  tried.push({ how: 'ctx.toolResultPruner', got: directOk, present: direct !== undefined })
  if (directOk) return { pruner: direct, how: 'ctx.toolResultPruner', tried }

  // c) 活 Agent 的子 ctx（Cordis 语义上看得见父层服务）
  const agents = getService(ctx, 'agents')
  let agent = null
  if (agents && typeof agents.get === 'function') {
    try { agent = agents.get(sessionId) || null } catch { agent = null }
  }
  const cands = [
    ['agent.ctx', agent && agent.ctx],
    ['agent.session.ctx', agent && agent.session && agent.session.ctx],
  ]
  for (const [how, c] of cands) {
    const svc = getService(c, 'toolResultPruner')
    const ok = !!(svc && typeof svc.applyDrops === 'function')
    tried.push({ how, got: ok, present: svc !== undefined })
    if (ok) return { pruner: svc, how, tried }
  }
  return { pruner: null, how: null, tried }
}

function stageError (stage, msg) {
  const e = new Error(msg)
  e.stage = stage
  return e
}

/**
 * 执行一次定点清理。成功返回 v4 回执（data 段），失败抛带 stage 的 Error。
 *
 * @param {object} o
 * @param {object} o.ctx            桥的 ctx
 * @param {object} [o.agents]       agents 服务（不给就从 ctx 取）
 * @param {object} o.args           v4 的 exec.args
 * @param {Function} o.describe     index.js 的 describePrunerRequest（纯函数）
 * @param {object} [o.deps]         { loadPrunerModule } —— 只给测试注入用
 * @returns {Promise<object>}       { targetSession, opId, startSeq, endSeq, framesAffected, at, ... }
 */
export async function runTargetedCleanup (o = {}) {
  const describe = o.describe
  if (typeof describe !== 'function') throw stageError('bad-request', 'adapter 需要 describePrunerRequest')
  const d = describe(o.args)
  if (!d.ok) throw stageError('bad-request', '请求不合法：' + d.problems.join('；'))
  const sid = d.echo.sessionId
  const startSeq = d.echo.startSeq
  const endSeq = d.echo.endSeq
  const opId = d.echo.opId
  const reason = String((o.args && o.args.reason) || '').slice(0, 200)

  const A = o.agents || getService(o.ctx, 'agents')
  if (!A || typeof A.get !== 'function') throw stageError('no-agents', '拿不到 agents 服务（ctx.get(\'agents\') 是空的）')
  let agent = null
  try { agent = A.get(sid) || null } catch { agent = null }
  if (!agent) throw stageError('no-target', '目标会话 ' + sid + ' 不在活的 agent 里（本桥不替你换一个）')
  const session = agent.session
  if (!session || typeof session.eventAt !== 'function') throw stageError('no-session', '目标 agent 没有可用的 session')
  if (String(session.id || '') !== String(sid)) {
    throw stageError('target-mismatch', 'agents.get(' + sid + ') 给出的 session.id 是 ' + String(session.id) + ' —— 不认')
  }

  const { pruner, how, tried } = await resolvePruner(o.ctx, sid, o.deps || {})
  if (!pruner) {
    throw stageError('no-pruner', '够不到真正干活的 pruner：' + JSON.stringify(tried)
      + ' —— 本桥不自己拼 surface 改写（那把 pruner 的策略抄了一份到桥里）')
  }

  const out = pruner.applyDrops({ session, targetSession: sid, startSeq, endSeq, opId, reason })
  if (!out || out.ok !== true) {
    const code = out && out.code ? String(out.code) : 'apply-failed'
    const why = out && out.reason ? String(out.reason) : 'applyDrops 没有返回 ok:true'
    throw stageError(code, '宿主侧 applyDrops 失败（' + code + '）：' + why)
  }

  // ★ 只翻译 v4 认得的字段，并且**原样**：targetSession / opId / startSeq / endSeq 不重算
  const data = {
    targetSession: out.targetSession,
    opId: out.opId,
    startSeq: out.startSeq,
    endSeq: out.endSeq,
    framesAffected: out.framesAffected,
    at: out.at,
    pointer: out.pointer,
    coverage: out.coverage,
    charsRemoved: out.charsRemoved,
    noMatch: out.noMatch === true,
    replayed: out.replayed === true,
    how,
  }
  // ★ 量不出就不给这个键 —— 不补 0（0 与「没量」在 v4 的界面上必须能分开）
  if (Number.isInteger(out.bytesAffected) && out.bytesAffected >= 0) data.bytesAffected = out.bytesAffected
  return data
}

