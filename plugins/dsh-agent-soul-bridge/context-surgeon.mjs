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

  /**
   * 列「可以清」的候选。
   *
   * ★★★ 2026-11-21：**判据换成 surface.nodes，与 pruner 对齐。**
   *
   *   旧实现是「从 lastSeq 往前扫 200 个 eventAt，挑 type=tool/result 的」。
   *   线上实测的后果：`context/candidates` 列出来的 seq，拿去 `pruner/targeted-cleanup`
   *   **14 个全是 0 帧**，而回执里 pruner 自己的 `resolved.inRange` 又说 0 ——
   *   也就是说那些 seq **根本不在 surface 上**。事件还在库里（eventAt 读得到），
   *   但已不在模型可见的那条链上，pruner 永远不会剪它。
   *
   *   ★ 一句话：**两个能力用了两套判据**，candidates 在「事件库」里挑，
   *     pruner 在「surface」里剪 —— 中间隔着的一层没人说。
   *
   *   现在：候选只从 `sess.surface.nodes` 取（拿不到就明说 unsupported，不猜）。
   *   长度按真实形状算：`data.message.content[0].content[]`（**两层**，
   *   旧实现只读一层，于是 len 恒 0，排序等于没排）。
   */
  function candidates (limit) {
    const max = Number(limit) > 0 ? Number(limit) : 12
    let nodes
    try { nodes = [...sess.surface.nodes].map(Number) } catch {
      return { ok: false, why: 'sess.surface.nodes 读不出来 —— 不猜候选' }
    }
    const out = []
    for (const seq of nodes) {
      let ev
      try { ev = sess.eventAt(seq) } catch { continue }
      if (!ev) continue
      if (String(ev.type) !== 'tool/result') continue
      if (hasPruneMarkerLike(ev)) continue
      // ★★★ 2026-11-21（第五处）：**这里也踩了同一个两层假设。**
      //   上一版读 `data.message.content[0].content`（两层），真实帧是一层 →
      //   blocks 为 null → 落到 `d.content`（也 undefined）→ **len 恒 0**。
      //   症状：candidates 列得出 seq（onSurface 对），但每条 len 都是 0 ——
      //   "沙袋优先"排序等于没排，而且看不出哪里错。
      //   ★ 判据与 pruner 那边统一：**一层/两层都认，且只有这一处取块。**
      const len = textLengthOf(ev)
      out.push({ seq, len, onSurface: true })
    }
    out.sort((a, b) => b.len - a.len)
    return { ok: true, surfaceSize: nodes.length, items: out.slice(0, max).sort((a, b) => a.seq - b.seq) }
  }

  /**
   * 取一条 tool/result 的正文长度（Unicode 码点约等于 length，够用于排序）。
   * ★ 2026-11-21：与 pruner 的 contentBlocksOf 同一口径 —— 一层/两层都认。
   *   这里不 import pruner 的模块（桥不该依赖它的内部文件），但口径必须一致。
   */
  /**
   * 取一条 tool/result 的**块数组**。一层 / 两层都认。
   *
   * ★ 2026-11-21：本文件里**两处**都要用它（算长度 / 判门牌），
   *   而它们原来各写一份两层读法 —— 于是同一个错误犯两次。
   *   ★ 判据：**一个形状只准有一个读取入口。**
   */
  function blocksOf (ev) {
    try {
      const d = ev.data || {}
      const flat = d.message && Array.isArray(d.message.content) ? d.message.content : null
      if (Array.isArray(flat) && flat.length > 0) {
        const first = flat[0]
        if (first && first.type === 'tool-result' && Array.isArray(first.content)) return first.content
        if (flat.every((b) => b && typeof b === 'object' && typeof b.type === 'string')) return flat
      }
      if (Array.isArray(d.content)) return d.content
    } catch {}
    return []
  }

  function textLengthOf (ev) {
    let n = 0
    for (const b of blocksOf(ev)) if (b && typeof b.text === 'string') n += b.text.length
    return n
  }

  /** 该节点是否已带门牌（此前剪过）。判据只看文本里有没有 log:<sid>#seq= 形态。 */
  // ★ 2026-11-21（第六处）：原来这里也只读 content[0].content（两层）→
  //   一层帧时 blocks 落到 d.content（undefined）→ **恒返回 false** →
  //   已剪过的节点（正文里明明有门牌）会**被反复列为候选**，
  //   而真拿去剪时 pruner 会以 already-pruned 跳过。
  //   ★ 症状：候选列表里混着已经剪完的节点，看起来像"还能剪"，实际剪不动。
  //   修法与 textLengthOf 一致：统一走 blocksOf。
  function hasPruneMarkerLike (ev) {
    // ★★ 2026-11-21（第八处）：**原来只认自家门牌（log:<sid>#seq=<n>），不认官方 marker。**
    //   而 pruner 那边 hasPruneMarker 认**两种**（PRUNE_MARKER_NEEDLES = 官方 '[... tool result
    //   middle pruned ...]' + 我们的 '中间被裁'）。
    //   后果：**一条被官方 marker 剪过的帧，candidates 照旧列出来（能剪），
    //   而 pruner 一看就判 already-pruned（不剪）** —— 两个判据打架。
    //   2026-11-21 真机实测就是这个现场：seq 84649 长度正好 5159（= 4096+39+1024，官方裁剪长度），
    //   candidates 当成"还能剪"，pruner 回 already-pruned。
    //
    //   ★ 判据：**"是不是剪过了"只能有一个判据。** 两个模块各写一份正则，迟早打架。
    //   这里认的两种，与 pruner 的 PRUNE_MARKER_NEEDLES 逐字一致。
    try {
      for (const b of blocksOf(ev)) {
        if (b && typeof b.text === 'string') {
          if (/log:[^#\s]+#seq=\d+/.test(b.text)) return true          // 我们的门牌
          if (b.text.indexOf('[... tool result middle pruned ...]') >= 0) return true // 官方
          if (b.text.indexOf('中间被裁') >= 0) return true                // 官方中文 / 我们的
        }
      }
    } catch {}
    return false
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