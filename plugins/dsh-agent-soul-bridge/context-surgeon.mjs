// v4 换气的上下文手术刀（2026-11-13 · 做进 bridge，不依赖 DSH 的 pruner）
// ============================================================================
// ★★★ 为什么要做在这里（爀曦 2026-11-13）：
//   「我们**不要依赖改造 DSH 自己的东西**，不然 DSH 更新一次我们就爆炸一次。
//    所有要**降低对宿主的依赖**，最好的就是把功能尽可能**集成在一个地方**，
//    这样子才能降低维护难度，所以**把 bridge 拓展成 v4 的调度平台**是最好的路径。」
//
//   ★ 所以这个模块**不碰 dsh-yanqing-pruner**（那是 DSH 侧的插件，它自己也在变），
//     而是直接用 DSH 的 **Session API 公开原语**：
//       sess.eventAt(seq)  →  取事件
//       sess.append(type, data, { surfaceOp: { op:'replace', startSeq, endSeq } })  →  定向替换
//
//   ★ 这套用法不是我发明的 —— v3 的 `dsh-huanqi` 里 `purgeOne` 已经实测通过
//     （2026-10-31 12:54，见 30-状态/设计-换气定点清除.md）。这里是把那段搬进来。
//     它当时留下 4 条硬约束，一条都不能松：**类型 / 去重 / 只改 content / 不加额外字段**。
//
// ── 为什么只动 `tool/result` ───────────────────────────────────────────────
//   ① 它是「外部读进来的东西」（文件、命令输出）—— 最可能成为污染源，也最安全可替换；
//   ② 它的 `message.content` 结构简单（文本块），替换后语义完整；
//   ③ **动 reasoning / text 会改「我说过什么」** —— 那是伪造历史，不做。
//
// ── 占位文本的纪律 ─────────────────────────────────────────────────────────
//   替换出来的占位必须带 **可回取的门牌**：
//     log:<sessionId>#seq=<n>   +   memq open 的命令行
//   ★ 「丢掉的内容」和「丢掉了哪一段」是两件事 —— 后者必须留下。
// ============================================================================

/** 给某个 session 造一把手术刀。返回 { ok, purge, candidates, why } */
export function makeContextSurgeon (agent, sessionId) {
  const sess = agent && agent.session
  if (!sess || typeof sess.append !== 'function' || typeof sess.eventAt !== 'function') {
    return { ok: false, why: '这个会话的 session 没有 append/eventAt（不是活会话？）' }
  }
  const sid = String(sessionId || (sess.id || ''))

  /**
   * 替换一条 tool/result（对上下文动刀）。
   * ★ 四条硬约束来自 v3 实测：类型 / 去重 / 只改 content / 不加额外字段。
   */
  function purge (seq, note) {
    const n = Number(seq)
    if (!Number.isFinite(n)) return { ok: false, seq, error: 'seq 不是数字' }
    let ev
    try { ev = sess.eventAt(n) } catch (e) { return { ok: false, seq: n, error: 'eventAt 抛：' + String((e && e.message) || e) } }
    if (ev === undefined || ev === null) return { ok: false, seq: n, error: 'no event' }
    if (String(ev.type) !== 'tool/result') return { ok: false, seq: n, error: 'type=' + String(ev.type) + '（只动 tool/result）' }

    const od = ev.data || {}
    const omsg = od.message || {}
    const text = String(note || ('[换气] 定点清除 seq ' + n + '（原文可取回 log:' + sid + '#seq=' + n + '）'))
    // ★ 只改 content：其余字段原样保留（那是「不加额外字段」的反面保险）
    const nm = { ...omsg, content: [{ type: 'text', text }] }
    try {
      const r = sess.append('tool/result', { ...od, message: nm }, {
        surfaceOp: { op: 'replace', startSeq: n, endSeq: n },
        sourceEventSeqs: [n],
      })
      return { ok: true, seq: n, newSeq: (r && r.seq !== undefined) ? r.seq : null }
    } catch (e) {
      return { ok: false, seq: n, error: String((e && e.message) || e).slice(0, 200) }
    }
  }

  /** 列「可以清」的候选：最近 N 条 tool/result，按内容长度排序（沙袋优先） */
  function candidates (limit) {
    const max = Number(limit) > 0 ? Number(limit) : 12
    const out = []
    // ★ 从尾部往前找：先拿 seq 范围（sess 可能有 lastSeq / eventCount，拿不到就靠 eventAt 探）
    const hi = Number(typeof sess.lastSeq === 'number' ? sess.lastSeq : (sess.seq !== undefined ? sess.seq : NaN))
    let from = Number.isFinite(hi) ? hi : null
    if (from === null) {
      // 没有 lastSeq 就只能扫一个合理窗口（v3 也是这么做的）
      from = Number(sess.eventCount && typeof sess.eventCount === 'number' ? sess.eventCount : 400)
    }
    const step = 200
    for (let s = from; s > Math.max(0, from - step) && out.length < max * 3; s--) {
      let ev
      try { ev = sess.eventAt(s) } catch { continue }
      if (!ev) continue
      if (String(ev.type) !== 'tool/result') continue
      let len = 0
      try {
        const c = (ev.data && ev.data.message && ev.data.message.content) || []
        for (const b of c) { if (b && typeof b.text === 'string') len += b.text.length }
      } catch {}
      out.push({ seq: s, len })
    }
    out.sort((a, b) => b.len - a.len)
    return out.slice(0, max).sort((a, b) => a.seq - b.seq)
  }

  return { ok: true, sessionId: sid, purge, candidates }
}

/** 批量替换：逐条做，任何一条失败不影响其它条（v3 的做法，理由：一条坏不该拖垮全部） */
export function purgeMany (surgeon, items, sid) {
  const purged = []
  const failed = []
  for (const it of (items || [])) {
    const seq = Number(it && it.seq)
    const why = String((it && (it.reason || it.why)) || '多样性收敛').slice(0, 80)
    const note = '[换气] 定点清除 seq ' + seq + '（原因：' + why + '）\n'
      + '原文可取回：log:' + String(sid || '') + '#seq=' + seq + '\n'
      + '（这是清除留下的占位，不是压缩摘要。）'
    const r = surgeon.purge(seq, note)
    if (r.ok) purged.push(r)
    else failed.push(r)
  }
  return { ok: purged.length > 0, purged, failed }
}