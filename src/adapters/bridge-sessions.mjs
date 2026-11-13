// bridge-sessions.mjs —— 通过 agent-soul-bridge 读写 DSH 的会话数据
//
// ★★★ 2026-11-13（爀曦定，架构收敛）：
//   **v4 不再直接读 DSH 的会话文件。** 与 DSH 之间最后只留两个接口：
//     ① MCP hub （工具通道）
//     ② bridge  （调度 + 数据）
//   理由不是洁癖，是**维护成本**：文件直读看着简单，实际是「路径变了 / 目录结构变了」
//   就静默失效的另一种耦合 —— 它不报错，只是永远读不到，然后你花一下午去查端口。
//
// ★ 失败必须外显（爀曦原话）：
//   **「失败了不能静默，要会报错」**。
//   所以这里每一条失败都抛带 reason 的错，绝不 return [] 冒充「没有会话」——
//   空数组和「读不到」在调用方眼里长得一模一样，那正是今天所有坑的共同形状。
//
// ★ 什么时候用：config.integrations.useBridgeSessions === true 时启用。
//   默认关：bridge 的 sessions 能力要等下一次 DSH 重启才上线，先切过去会让换气诊断整条挂掉。

export const BRIDGE_SESSIONS_CAP = 'sessions'

/** 拿第一个声明了 sessions 能力的在线宿主；没有就抛（不退回文件）。 */
function pickHost (control, cap) {
  if (!control || typeof control.whoHas !== 'function') {
    throw new Error('没有控制通道（control hub 未就绪）—— 无法通过 bridge 读会话')
  }
  let peers = []
  try { peers = control.whoHas(cap) || [] } catch { peers = [] }
  if (!peers.length) {
    throw new Error('没有任何宿主声明 ' + cap + ' 能力（bridge 版本太旧，或没连上）—— 不退回文件直读')
  }
  return peers[0]
}

/**
 * 列会话。
 * @returns {Promise<{total:number, items:Array<{id,workspace,sizeBytes,mtimeMs,file}>}>}
 */
export async function listSessionsViaBridge (control, opts = {}, timeoutMs = 20000) {
  const peer = pickHost(control, BRIDGE_SESSIONS_CAP)
  let data = null
  try {
    data = await control.exec(peer.id, BRIDGE_SESSIONS_CAP, 'list', opts, timeoutMs)
  } catch (e) {
    throw new Error('sessions/list 失败（host=' + (peer.host || peer.id) + '）：' + String(e && e.message ? e.message : e))
  }
  if (!data || data.ok !== true) throw new Error('sessions/list 回执不 ok：' + JSON.stringify(data).slice(0, 200))
  if (!Array.isArray(data.items)) throw new Error('sessions/list 回执缺 items 数组（协议不符，不是「没有会话」）')
  return data
}

/**
 * 读一个会话的帧（分页）。
 * @returns {Promise<{sessionId,frames:Array,count,total,nextFromSeq,badLines}>}
 */
export async function readSessionViaBridge (control, sessionId, opts = {}, timeoutMs = 30000) {
  const sid = String(sessionId || '').trim()
  if (!sid) throw new Error('readSessionViaBridge 需要 sessionId')
  const peer = pickHost(control, BRIDGE_SESSIONS_CAP)
  let data = null
  try {
    data = await control.exec(peer.id, BRIDGE_SESSIONS_CAP, 'read', { sessionId: sid, ...opts }, timeoutMs)
  } catch (e) {
    throw new Error('sessions/read 失败（session ' + sid + '）：' + String(e && e.message ? e.message : e))
  }
  if (!data || data.ok !== true) throw new Error('sessions/read 回执不 ok：' + JSON.stringify(data).slice(0, 200))
  if (!Array.isArray(data.frames)) throw new Error('sessions/read 回执缺 frames 数组（协议不符）')
  return data
}

/**
 * 一次把某个会话的帧全部读完（自动翻页）。
 * ★ 上限保护：maxFrames 默认 5000 —— 超过就抛，让调用方知道「这个会话太大，要单独处理」，
 *   而不是悄悄截断（截断会让索引少一截，而少一截看起来和「本来就这些」一样）。
 */
export async function readAllSessionViaBridge (control, sessionId, opts = {}) {
  const maxFrames = Number.isFinite(opts.maxFrames) && opts.maxFrames > 0 ? opts.maxFrames : 5000
  const pageSize = Number.isFinite(opts.pageSize) && opts.pageSize > 0 ? Math.min(opts.pageSize, 2000) : 400
  // ★★ 2026-11-13：**只读尾部**，默认 4MB（与文件版的 tailBytes 同口径）。
  //   原来从头读全量：本机会话 2.7MB / 2300+ 帧，换气扫一个会话要 30 秒。
  //   而换气只关心最近几百轮 —— 读全量是白花的时间。
  //   ★ 0 = 读全量（保留给「我要完整历史」的调用方，比如将来的 migrate）。
  const tailBytes = Number.isFinite(opts.tailBytes) && opts.tailBytes >= 0 ? opts.tailBytes : 4 * 1024 * 1024
  // ★★★ 2026-11-13：**tailFrames 捷径** —— 只取最后 N 条，一次调用，不翻页。
  //   bridge 那边从最后一帧往前解压，够数就停（切帧便宜，解压贵）。
  //   ★ 为什么要它：tailBytes 限制的是字节，而本机会话 2.7MB < 4MB，等于没限；
  //     真正的开销解压 2300+ 帧，换气只关心最近几百轮。
  const tailFrames = Number.isFinite(opts.tailFrames) && opts.tailFrames > 0 ? opts.tailFrames : 0
  if (tailFrames > 0) {
    const one = await readSessionViaBridge(control, sessionId, { limit: tailFrames, tailFrames })
    return { sessionId, frames: one.frames, count: one.frames.length, badLines: one.badLines || 0, tailFrames, fromEnd: true }
  }

  const all = []
  let fromSeq = 0
  let rounds = 0
  let badLines = 0
  while (true) {
    rounds += 1
    if (rounds > 200) throw new Error('readAllSessionViaBridge 翻页超过 200 轮（异常会话？）session=' + sessionId)
    const page = await readSessionViaBridge(control, sessionId, { fromSeq, limit: pageSize, tailBytes })
    all.push(...page.frames)
    badLines += page.badLines || 0
    if (all.length > maxFrames) {
      throw new Error('会话帧数超过上限 ' + maxFrames + '（session=' + sessionId + '，已读 ' + all.length + '）—— 请单独处理，不做静默截断')
    }
    if (page.nextFromSeq === null || page.nextFromSeq === undefined) break
    fromSeq = page.nextFromSeq
  }
  return { sessionId, frames: all, count: all.length, badLines, tailBytes }
}
