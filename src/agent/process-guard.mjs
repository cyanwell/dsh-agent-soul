// 判据 v3：门槛从「总量」改成「窗口」—— 退化可能很短就发生
// ★ v2 标定（2026-11-13）：
//   合成退化 5 例，抓到 2 例，**漏掉的 3 例全是因为 minReasoningChars(1500) 拦掉了**
//   （600 / 310 / 655 字）。而真实的「逐步坍缩」只有 310 字。
//   ★ v3 用 3 万字门槛 —— 难怪它只在极端情况触发。
//
// ★ v3 规则：
//   只要「窗口本身够长」（≥ 400 字符），就可以判；不看整段总长。
//   短文本要求更高的重复密度（≥0.85），长文本按 0.72。
// ══════════════════════════════════════════════════════════════════════════
// 「意图声明」的识别与统计（2026-11-13 · 爀曦给的判据方向）
//
//   ★ 他说：「要检测**连续 3 轮**内的思考链的**意图声明文本量和频率**，才能真正检测得到。」
//
//   ★ 为什么不能用 n-gram 重复率：
//     它抓的是「字面重复」，而退化时重复的往往不是字面，是**宣告** ——
//     「好。执行。」「写。」「Let me write.」「Go.」这些极短句，
//     它们各自不重复（每句都不一样），但**都在宣告同一件事**。
//
//   ★ 所以「意图声明」的定义是：**极短的、非代码的句子**。
//     不看它含不含动词（我第一版就是这么错的：正则找「我/要/写」，「好。执行。」一个都没抓到）。
// ══════════════════════════════════════════════════════════════════════════

/** 切句：按句号/叹号/问号/换行 */
export function sentences (text) {
  return String(text || '').split(/[。！？!?\n]+/).map((s) => s.trim()).filter(Boolean)
}

/**
 * 是不是一个「宣告句」。
 *
 * ★ 判据只有三条：够短 / 不是代码路径 / 不是纯数字标点。
 *   **不要求含动词** —— 我第一版要求了，结果 `好。执行。` 一个都没命中。
 */
export function isDecl (s, maxLen = 12) {
  if (!s || s.length > maxLen) return false
  if (/[`{}[\]<>='"/\\]/.test(s)) return false
  if (/^[\d\s.,:;%-]+$/.test(s)) return false
  return true
}

/**
 * 一段推理的宣告统计。
 *
 * ★ 两个指标一起看才有意义：
 *   · per1000  —— 每千字有多少宣告句（**频率**）
 *   · uniqRatio —— 宣告句里有多少是不同的（**单调性**）
 *   真退化是「又密又单调」；正常推理可能密，但不单调。
 */
export function declStats (text) {
  const s = String(text || '')
  const ss = sentences(s)
  if (!ss.length) return { n: 0, total: 0, ratio: 0, per1000: 0, uniq: 0, uniqRatio: 1, top: [] }
  const decls = ss.filter((x) => isDecl(x))
  const set = new Set(decls)
  return {
    n: decls.length,
    total: ss.length,
    ratio: decls.length / ss.length,
    per1000: s.length ? (decls.length / (s.length / 1000)) : 0,
    uniq: set.size,
    uniqRatio: decls.length ? set.size / decls.length : 1,
    top: [...set].slice(0, 6),
  }
}

export function createProcessGuard (opts) {
  const c = {
    checkEveryChars: 200,   // ★ 200 而不是 400：310 字的样本在 400 时**一次都没被检查过**（2026-11-13 标定发现）
    windowChars: 800,
    minWindowChars: 260,    // ★ 窗口够长就判，不看总量（260 是标定后的下限）
    gramSize: 12,
    windowRepeatWarn: 0.72, // 长窗口
    windowRepeatWarnShort: 0.85, // ★ 短窗口要更狠的密度
    ...(opts || {}),
  }
  let reasoning = ''
  let checkedAt = 0
  let fires = 0
  let streakNoNew = 0
  let lastVerdict = null
  let prevWin = ''
  return {
    push (delta) {
      if (typeof delta !== 'string' || !delta) return null
      reasoning += delta
      if (reasoning.length - checkedAt < c.checkEveryChars) return null
      checkedAt = reasoning.length
      if (reasoning.length < c.minWindowChars) return null

      const win = reasoning.slice(-c.windowChars)
      if (win.length < c.minWindowChars) return null
      const gs = []
      for (let i = 0; i + c.gramSize <= win.length; i++) gs.push(win.slice(i, i + c.gramSize))
      if (gs.length < 8) return null
      const seen = new Set()
      let dup = 0
      for (const g of gs) { if (seen.has(g)) dup++; else seen.add(g) }
      const rr = dup / gs.length

      // 新信息比例（和上一个窗口比）
      let newRatio = 1
      // ★★★ 2026-11-13 标定：**「连续窗口没有新 n-gram」这条判据删掉了。**
      //
      //   原因是它有个逻辑错误：两次窗口都是「尾部 800 字符」，
      //   而每次只移动 200 字符（checkEveryChars）—— **两次窗口有 75% 重叠**。
      //   重叠的部分当然不是「新」的，于是判据必然认为「在原地踏步」。
      //   实测：1814 条真实推理里它误杀 2 条（全是正常工程推理）。
      //
      //   ★ 留下的是「尾部窗口重复率」这一条 —— 它抓到了 5/6 合成退化，0 误杀。
      const th = win.length < c.windowChars ? c.windowRepeatWarnShort : c.windowRepeatWarn
      if (rr < th) { lastVerdict = null; return null }

      fires++
      lastVerdict = {
        shouldBreak: true,
        reason: '尾部 ' + win.length + ' 字符里重复 n-gram 占 ' + (rr * 100).toFixed(1) + '%（阈值 ' + (th * 100) + '%）',
        chars: reasoning.length,
        winChars: win.length,
        windowRepeat: Math.round(rr * 1000) / 1000,
        newRatio: Math.round(newRatio * 1000) / 1000,
        streakNoNew,
        fires,
      }
      return lastVerdict
    },
    /**
     * ★★ 流结束时调一次。
     *
     *   为什么必须单独有它：`push` 只在「距上次检查已满 checkEveryChars」时才判，
     *   而 310 字的推理最后一次检查停在 200 字，剩下 110 字不够触发 —— **永远判不到尾部**。
     *   实测：A3（310 字）和 A7（240 字）就是这么漏的。
     */
    final () {
      if (lastVerdict) return lastVerdict
      if (reasoning.length < c.minWindowChars) return null
      const win = reasoning.slice(-c.windowChars)
      if (win.length < c.minWindowChars) return null
      const gs = []
      for (let i = 0; i + c.gramSize <= win.length; i++) gs.push(win.slice(i, i + c.gramSize))
      if (gs.length < 8) return null
      const seen = new Set()
      let dup = 0
      for (const g of gs) { if (seen.has(g)) dup++; else seen.add(g) }
      const rr = dup / gs.length
      const th = win.length < c.windowChars ? c.windowRepeatWarnShort : c.windowRepeatWarn
      if (rr < th) return null
      fires++
      lastVerdict = {
        shouldBreak: true,
        reason: '尾部 ' + win.length + ' 字符里重复 n-gram 占 ' + (rr * 100).toFixed(1) + '%（阈值 ' + (th * 100) + '%）',
        chars: reasoning.length,
        winChars: win.length,
        windowRepeat: Math.round(rr * 1000) / 1000,
        fires,
        final: true,
      }
      return lastVerdict
    },

    text () { return reasoning },
    stats () { return { chars: reasoning.length, fires, last: lastVerdict } },
  }
}