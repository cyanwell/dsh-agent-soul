// src/agent/context-budget.mjs —— v4 自己的上下文预算（2026-11-11）。
//
// ★ 为什么必须有这一层：它是 DSH 那套 ACP / compaction / pruner 的**对应物**，
//   而 v4 之前一个都没有 —— 只有 `store.recent(sessionId, 60)`（按条数取 60 帧）。
//
//   实测它有多荒唐（2026-11-11 13:02 数的）：
//     · 最长会话 session-9457bd6b…：5,164 帧 / 11.3 MB / **约 515 万 token**
//     · 而每轮只取「最近 60 帧」——60 帧里只要混进一条大 tool_result，一轮就能上百万 token
//
//   **按条数取帧 = 假装有预算，其实没有。** 一帧可以是 40 字节，也可以是 4 MB。
//
// ★ 四条判据：
//   1. **按 token 算，不按条数**（估算：中文字符 / 2.2，保守偏高）。
//   2. **超预算的老帧不静默丢** —— 折叠成一条 summary 帧，写清折了几帧。
//   3. **折叠必须带门牌**：`log:<session>#seq=<from>-<to>`。摘要只是索引，
//      没有指针的摘要 = 把「内容存在过」这条线索也一起丢了。
//   4. **尾部永远保留**（keepTail）：最近的对话是它正在做的事，不能折。
//
// ★ 不做的事：不调 LLM 生成摘要（那要多一次调用、还可能编），
//   只用**原帧里的原话**拼 —— 少信息，但不失真。

/** 粗略 token 估算。中文约 1 字 = 0.45 token，英文约 1 字 = 0.25；取 1/2.2 折中且偏保守。 */
export function estimateTokens(text) {
  return Math.ceil(String(text == null ? '' : text).length / 2.2);
}

/** 一帧占多少 token —— 工具结果和参数都算进去。 */
export function frameTokens(f) {
  if (!f) return 0;
  let n = String(f.text || '').length;
  if (f.args) { try { n += JSON.stringify(f.args).length; } catch { /* 循环引用之类，忽略 */ } }
  if (f.content) n += String(f.content).length;
  if (f.message) n += String(f.message).length;
  return Math.ceil(n / 2.2);
}

/**
 * 折叠一组帧成一条 summary 帧。
 * ★ 只用原话：用户说了什么、助手说了什么、调过哪些工具 —— 不加工、不总结成判断。
 */
export function foldFrames(frames, sessionId) {
  const first = frames[0] || {};
  const last = frames[frames.length - 1] || {};
  const from = first.seq == null ? '?' : first.seq;
  const to = last.seq == null ? '?' : last.seq;
  const lines = [];
  let users = 0; let assts = 0; const tools = [];
  for (const f of frames) {
    const t = String(f.type || '');
    if (t === 'user') {
      users++;
      const s = String(f.text || '').replace(/\s+/g, ' ').slice(0, 120);
      if (s && lines.length < 8) lines.push('· 用户：' + s);
    } else if (t === 'assistant') {
      assts++;
      const s = String(f.text || '').replace(/\s+/g, ' ').slice(0, 120);
      if (s && lines.length < 16) lines.push('· 助手：' + s);
    } else if (t === 'tool_call' && f.name) {
      if (tools.indexOf(f.name) < 0) tools.push(f.name);
    }
  }
  const body = [
    '【折叠 ' + frames.length + ' 帧（' + users + ' 用户 / ' + assts + ' 助手）· 门牌 log:' + (sessionId || '?') + '#seq=' + from + '-' + to + '】',
    ...lines,
    tools.length ? '· 这段时间它调过：' + tools.join('、') : '',
    '★ 原文还在磁盘上：要看细节，按上面的门牌回取；不要凭这条摘要猜。',
  ].filter(Boolean).join('\n');
  return {
    seq: first.seq,
    type: 'summary',
    text: body,
    seqFrom: from,
    seqTo: to,
    folded: frames.length,
  };
}

/**
 * 预算化：从最近往前累加，超出 maxTokens 的部分折叠。
 * @returns {{ frames, kept, folded, keptTokens, foldedTokens, span }}
 */
export function budgetFrames(frames, { maxTokens = 200000, keepTail = 10, sessionId = '' } = {}) {
  const list = Array.isArray(frames) ? frames.slice() : [];
  if (!list.length) {
    return { frames: [], kept: 0, folded: 0, keptTokens: 0, foldedTokens: 0 };
  }
  const budget = Math.max(2000, Number(maxTokens) || 200000);
  const tail = Math.max(0, Number(keepTail) || 0);

  // 从尾部往前累加
  let used = 0;
  let cut = list.length;   // cut 之前的都要折叠
  for (let i = list.length - 1; i >= 0; i--) {
    const t = frameTokens(list[i]);
    const mustKeep = (list.length - 1 - i) < tail;   // 尾部强制保留
    if (!mustKeep && used + t > budget) { cut = i + 1; break; }
    used += t;
    cut = i;
  }

  if (cut <= 0) {
    return { frames: list, kept: list.length, folded: 0, keptTokens: used, foldedTokens: 0 };
  }

  const old = list.slice(0, cut);
  const keep = list.slice(cut);
  const foldedTokens = old.reduce((s, f) => s + frameTokens(f), 0);
  const summary = foldFrames(old, sessionId);
  const out = [summary, ...keep];
  return {
    frames: out,
    kept: keep.length,
    folded: old.length,
    keptTokens: used,
    foldedTokens,
    span: { from: summary.seqFrom, to: summary.seqTo },
  };
}
