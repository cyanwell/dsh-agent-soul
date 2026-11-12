// huanqi-llm —— 换气的**语义判据**（v4 内嵌 LLM 判断上下文污染点）
// ============================================================================
// 爀曦 2026-11-12 问的是：「v4 的内嵌 LLM 是否能够做到分析宿主会话的上下文污染点，
// 并且通过 V4 调度接口去对上下文进行修复」
//
// 现状：huanqi.mjs 只有**统计判据**（repeatRatio / trailingCycle），
// 它自己的头注释就写着「repeatRatio 区分的是长和短，不是卡住和在干活」。
// 也就是说：**能看出「重复」，看不出「在绕圈」。** 后者要语义。
//
// ── 三条纪律 ────────────────────────────────────────────────
//  ① **只判断，不动手。** 输出「建议清理的 seq 区间」，执行走 cleanup.mjs
//     （那里有宿主回执四样核对）。判断和执行分开，出错时才查得清是哪一步错。
//  ② **没有 LLM 就明说做不到**，不退回统计判据冒充语义判断。
//  ③ **单段最长 60 帧**：超了取最近的那段 —— 污染最可能发生在刚过去的地方。
// ============================================================================

const MAX_FRAMES_PER_CALL = 60
const MAX_CHARS_PER_FRAME = 1200

/** 把帧压成 LLM 可读的文本（带 seq，方便它给出区间） */
export function framesToPromptText (frames) {
  const out = []
  for (const f of frames) {
    const seq = f.seq === undefined ? '?' : f.seq
    const type = f.type || 'unknown'
    let text = String(f.text || '')
    if (text.length > MAX_CHARS_PER_FRAME) {
      text = text.slice(0, MAX_CHARS_PER_FRAME) + '…（截断，原长 ' + String(f.text).length + '）'
    }
    out.push('[' + seq + '] (' + type + ') ' + text.replace(/\n{2,}/g, '\n'))
  }
  return out.join('\n\n')
}

const SYSTEM_PROMPT = [
  '你是一个上下文污染诊断器。你的唯一任务是找出**应该被清理掉**的对话片段。',
  '',
  '「污染」只有三种，别的都不算：',
  '1. **绕圈**：同一件事用几乎相同的方式反复尝试、反复失败，中间没有新信息。',
  '2. **重复**：同一段内容（或几乎一样的）出现了两次以上。',
  '3. **无关堆积**：大段工具输出 / 报错堆栈，与这一段的主题完全无关，而且已经被后续结论取代。',
  '',
  '**不算污染的**（很重要）：话题切换、正常的试错、长但有用的代码、情绪表达、结论性的总结。',
  '',
  '输出严格 JSON，不要 markdown 围栏：',
  '{',
  '  "polluted": true 或 false,',
  '  "ranges": [{ "start": <起始seq>, "end": <结束seq>, "kind": "loop" | "dup" | "noise", "reason": "20字以内" }],',
  '  "keep": [<必须保留的 seq，如关键结论>],',
  '  "confidence": 0.0 到 1.0',
  '}',
  '',
  '★ ranges 为空就返回 polluted:false。**宁可漏报，不要误报** —— 删错了比留着更坏。',
].join('\n')

/** 去掉可能存在的 markdown 围栏 */
function stripFence (s) {
  const t = String(s || '').trim()
  const m = /^[`]{3}[a-zA-Z]*\s*([\s\S]*?)[`]{3}$/.exec(t)
  return m ? m[1].trim() : t
}

/** 解析模型返回（容忍围栏和前后废话） */
export function parseVerdict (raw) {
  if (typeof raw !== 'string') return { ok: false, error: '模型没返回文本' }
  const s = stripFence(raw)
  const i = s.indexOf('{')
  const j = s.lastIndexOf('}')
  if (i < 0 || j <= i) return { ok: false, error: '没找到 JSON 对象' }
  let o = null
  try { o = JSON.parse(s.slice(i, j + 1)) } catch (e) { return { ok: false, error: 'JSON 解析失败：' + ((e && e.message) || e) } }
  if (!o || typeof o !== 'object') return { ok: false, error: '不是对象' }

  const ranges = Array.isArray(o.ranges) ? o.ranges : []
  const clean = []
  for (const r of ranges) {
    const a = Number(r && r.start)
    const b = Number(r && r.end)
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue
    if (b < a) continue
    const kind = ['loop', 'dup', 'noise'].includes(r.kind) ? r.kind : 'loop'
    clean.push({ start: a, end: b, kind, reason: String(r.reason || '').slice(0, 40) })
  }
  // ★ 区间合并（重叠的合成一个）—— 分开清两次不如一次清完
  clean.sort((x, y) => x.start - y.start)
  const merged = []
  for (const r of clean) {
    const last = merged[merged.length - 1]
    if (last && r.start <= last.end + 1) {
      last.end = Math.max(last.end, r.end)
      if (!last.kinds.includes(r.kind)) last.kinds.push(r.kind)
      if (last.reasons.length < 3) last.reasons.push(r.reason)
    } else {
      merged.push({ start: r.start, end: r.end, kinds: [r.kind], reasons: [r.reason].filter(Boolean) })
    }
  }
  return {
    ok: true,
    polluted: Boolean(o.polluted) && merged.length > 0,
    ranges: merged,
    keep: Array.isArray(o.keep) ? o.keep.map(Number).filter(Number.isFinite) : [],
    confidence: Number.isFinite(Number(o.confidence)) ? Math.max(0, Math.min(1, Number(o.confidence))) : 0,
  }
}

/**
 * 用内嵌 LLM 判断一段帧里哪些是污染。
 *
 * @param {object} o
 * @param {{chat:Function, ready?:Function}} o.llm   LlmClient 实例
 * @param {Array} o.frames                            帧数组（要有 seq / type / text）
 * @param {(m:string)=>void} [o.log]
 */
export async function analyzeContext (o) {
  const llm = o && o.llm
  const frames = Array.isArray(o && o.frames) ? o.frames : []
  const log = (o && o.log) || (() => {})
  if (!llm || typeof llm.chat !== 'function') {
    return { ok: false, error: '没有可用的内嵌 LLM（llm.chat 不存在）' }
  }
  if (typeof llm.ready === 'function' && !llm.ready()) {
    return { ok: false, error: '内嵌 LLM 没就绪（缺 apiKey 或引用没解出来）' }
  }
  if (!frames.length) return { ok: false, error: '没有帧可分析' }

  let use = frames
  let truncated = 0
  if (use.length > MAX_FRAMES_PER_CALL) {
    truncated = use.length - MAX_FRAMES_PER_CALL
    use = use.slice(-MAX_FRAMES_PER_CALL)
    log('[huanqi-llm] 帧太多，取最近 ' + MAX_FRAMES_PER_CALL + ' 帧（弃 ' + truncated + '）')
  }

  const body = framesToPromptText(use)
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: '下面是一段对话，每行前的 [数字] 是帧的 seq。\n\n' + body },
  ]
  let raw = ''
  try {
    const r = await llm.chat(messages, [], null)
    // ★ chat 可能返回字符串，也可能是 {content} / {text} —— 三种都认
    raw = typeof r === 'string' ? r : String((r && (r.content || r.text)) || '')
  } catch (e) {
    return { ok: false, error: '调用模型失败：' + String((e && e.message) || e).slice(0, 200) }
  }
  const v = parseVerdict(raw)
  if (!v.ok) return { ok: false, error: v.error, raw: String(raw).slice(0, 300) }
  return { ok: true, ...v, analyzed: use.length, dropped: truncated }
}