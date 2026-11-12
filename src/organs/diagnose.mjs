// src/organs/diagnose.mjs —— 换气诊断（P3）
//
// ★ 它和 huanqi 的区别（很重要，别混）：
//   huanqi   = **当下**这一轮卡住了 → 打断它。实时、有副作用。
//   diagnose = **回看**历史，找出「哪几帧在污染上下文」→ 只出报告，不动任何东西。
//   一个是刹车，一个是黑匣子。**共用一个词「换气」会让人以为是一件事，不是。**
//
// ★★ 判据设计的一条硬教训（2026-11-07 实测得出）：
//   我一开始想用「同一参数重复 N 次」和「连续失败 N 次」两个判据。
//   在这个容器 5573 帧上跑了一遍：
//     参数重复 >=3 次的有 32 组、最高 23 次   ← 全是**正常的重复劳动**（反复跑同一个脚本）
//     连续失败 >=2 的段有 66 段                ← 全是**正常的试错**
//   **单看任何一个都是噪声。**
//   真正的污染是**两者叠加**：同一件事用同样方式反复失败 = 绕圈。
//   所以第 ① 条判据是「参数指纹 + 连续失败」，不是单独任何一个。
//
// ★ 另一条：所有结论必须能指回**具体帧**，而且指针要能被 memq open 打开。
//   本库的 frame 有两套 seq：容器自己的 `seq`、DSH 原 seq 在 `meta.seq`。
//   **门牌用的是后者** —— 拿不到就明说拿不到，不猜。

export const KIND = {
  SPIN: 'spin',            // 绕圈：同一件事用同样方式反复失败
  EMPTY: 'empty',          // 空转：连续几条几乎没有内容的输出
  REPEAT: 'repeat',        // 重复：同一大段文本反复出现
  DUP: 'dup',              // 重影：同一帧被写了多次（同步 bug 留下的）
};

/** 失败的样子 —— 只看工具结果的**开头**，避免长文本里的偶然词命中 */
export function looksFailed(s) {
  const t = String(s || '').slice(0, 400);
  return /(^|\n)\s*(✗|Error|TypeError|SyntaxError|ReferenceError|RangeError)/.test(t) ||
         /\[exit code: [1-9]/.test(t) ||
         /(Cannot find|not found|ENOENT|EACCES|is not defined|is not a function)/.test(t) ||
         /(失败|错误)[:：]/.test(t);
}

/** 工具调用指纹 —— 参数取前 200 字符，够区分「同一件事」 */
export function callFingerprint(f) {
  const raw = typeof f.args === 'string' ? f.args : JSON.stringify(f.args || {});
  return String(f.name || '?') + '::' + String(raw || '').slice(0, 200);
}

/**
 * 文本指纹 —— 去掉空白后取前 200 字 **+ 总长度**。
 *
 * ★★ 2026-11-07 修（这条是实测抓出来的，不查就会误报）：
 *   原来只取前 120 字，结果本容器里 6 段 repeat 有 2 段是**误报** ——
 *   因为工具结果都长这样：`[结果] xxx`，前 120 字很容易撞车，而正文其实完全不同。
 *
 *   ★ 加长度这一位，是在说：**「开头一样」不等于「同一段」。**
 *     同一段话被写两次，长度必然一样；只是开头像的两段话，长度几乎不会一样。
 */
export function textFingerprint(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.slice(0, 200) + '#' + t.length;
}

/**
 * 主入口：吃一个会话的 frames，吐候选污染段。
 *
 * @param {Array} frames  按 seq 升序的帧
 * @param {object} opts   { spinMin, emptyLen, emptyRun, repeatMin, shortGate }
 * @returns {{ candidates: Array, stats: object }}
 */
export function diagnose(frames, opts = {}) {
  const o = {
    spinMin: 3,        // 同一指纹连续失败几次算绕圈
    emptyLen: 24,      // 一条 assistant 少于多少字算「几乎没有内容」
    emptyRun: 4,       // 连续几条空转才算一段
    repeatMin: 3,      // 同一段文本出现几次算重复
    shortGate: 0,      // 从第几帧开始看（跳过 early 帧对污染没意义，但可保留）
    ...opts,
  };
  // ★ 2026-11-07 修：原来只把局部变量 fs 兜住了，但下面 `for (const f of frames)`
  //   遍历的还是**原参数** —— 传 null 就炸。自检第 ⑦ 组当场抓出来的。
  //   ★ 教训：兜底要兜在**入口**，不能只兜在第一个用到它的地方。
  const all = Array.isArray(frames) ? frames : [];
  const fs = all.slice(o.shortGate);
  const candidates = [];

  // 为了方便对外输出，把「本会话 id」从帧里找出来（第 0 帧是 session）
  let sid = '';
  for (const f of all) { if (f && f.type === 'session' && f.id) { sid = f.id; break; } }
  const door = (f) => {
    const meta = f && f.meta;
    const n = meta && Number.isFinite(meta.seq) ? meta.seq : null;
    return n == null ? null : ('log:' + sid + '#seq=' + n);
  };

  // ── ① 绕圈：同一指纹，连续（在工具调用序列里相邻）失败 ──
  //    ★ 为什么要求「连续」而不只是「累计」：
  //      累计失败 3 次可能跨了几百帧，那说明「这条命令本来就难跑」，
  //      而连续失败 3 次说明「它卡在这一步了，没换办法」。
  {
    const calls = fs.filter((f) => f.type === 'tool_call');
    const results = fs.filter((f) => f.type === 'tool_result');
    // 按 callId 对上
    const byCall = new Map();
    for (const r of results) { if (r.callId) byCall.set(r.callId, r); }
    let run = [];
    let lastFp = null;
    const flush = () => {
      if (run.length >= o.spinMin) {
        const first = run[0], last = run[run.length - 1];
        candidates.push({
          kind: KIND.SPIN,
          from: first.frame.seq, to: last.frame.seq,
          door: [door(first.frame), door(last.frame)].filter(Boolean),
          count: run.length,
          why: '同一调用连续失败 ' + run.length + ' 次，中间没换办法',
          sample: String(first.fp).slice(0, 100),
        });
      }
      run = [];
    };
    for (const c of calls) {
      const r = c.callId ? byCall.get(c.callId) : null;
      const fp = callFingerprint(c);
      const failed = r ? looksFailed(r.content || r.text) : false;
      if (failed && fp === lastFp) { run.push({ frame: c, fp }); }
      else {
        flush();
        if (failed) { run = [{ frame: c, fp }]; lastFp = fp; }
        else { lastFp = null; }
      }
    }
    flush();
  }

  // ── ② 空转：连续几条 assistant 几乎没有内容 ──
  {
    let run = [];
    const flush = () => {
      if (run.length >= o.emptyRun) {
        candidates.push({
          kind: KIND.EMPTY,
          from: run[0].seq, to: run[run.length - 1].seq,
          door: [door(run[0]), door(run[run.length - 1])].filter(Boolean),
          count: run.length,
          why: '连续 ' + run.length + ' 条输出少于 ' + o.emptyLen + ' 字（在说话，但没在说事）',
        });
      }
      run = [];
    };
    for (const f of fs) {
      if (f.type !== 'assistant') continue;
      const n = String(f.text || '').replace(/\s+/g, '').length;
      if (n > 0 && n < o.emptyLen) run.push(f); else flush();
    }
    flush();
  }

  // ── ③ 重复：同一大段文本反复出现 ──  (只算够长的，短句重复是正常的)
  {
    // ★★ 2026-11-07 修：**先剔掉重影帧，再判重复**。
    //
    //   不剔的后果（实测）：同一帧被写了两次（同步器的疤），
    //   repeat 把它当成「同一段出现两次」→ **同一个病报两遍**，
    //   而且看起来像「模型在重复」，其实是「同步器写重了」。
    //   ★ 一个病只该报一次，报在**根因**那一档（dup）。
    const dupSeqs = new Set();
    {
      const cnt = new Map();
      // ★ 2026-11-07：这里原来写的又是 `frames`（原参数），不是 `all` ——
      //   **同一个错犯了两次**（上一次是 session id 那行）。
      //   教训升级：兜底兜在入口还不够，**每加一段用到它的代码，都要问一句「我用的是哪个变量」**。
      for (const f of all) {
        const n = f && f.meta && f.meta.seq;
        if (Number.isFinite(n)) cnt.set(n, (cnt.get(n) || 0) + 1);
      }
      for (const [n, c] of cnt) if (c > 1) dupSeqs.add(n);
    }
    const seen = new Map();
    for (const f of fs) {
      if (f.type !== 'assistant' && f.type !== 'tool_result') continue;
      // ★ 这一帧的 DSH seq 是重复的 → 跳过（它已经算在 dup 里了）
      const dn = f && f.meta && f.meta.seq;
      if (Number.isFinite(dn) && dupSeqs.has(dn)) continue;
      const raw = String(f.text || f.content || '');
      if (raw.length < 400) continue;                 // ★ 门槛：太短的不算
      const fp = textFingerprint(raw);
      if (!fp) continue;
      if (!seen.has(fp)) seen.set(fp, []);
      seen.get(fp).push(f);
    }
    for (const [fp, arr] of seen) {
      if (arr.length >= o.repeatMin) {
        candidates.push({
          kind: KIND.REPEAT,
          from: arr[0].seq, to: arr[arr.length - 1].seq,
          door: [door(arr[0]), door(arr[arr.length - 1])].filter(Boolean),
          count: arr.length,
          why: '同一段文字出现 ' + arr.length + ' 次（各 ' + String(arr[0].text || arr[0].content || '').length + ' 字）',
          sample: fp.slice(0, 90),
        });
      }
    }
  }

  // ── ④ 重影：同一帧被写了多次 ──
  //    ★ 这不是「模型在绕圈」，是**同步器 bug 留下的疤**。
  //      2026-11-07 修过一次（append 前查 meta.seq），但历史帧清不掉 —— 只追加。
  //      单列一档，是因为修法完全不同：这个该去查同步，不该去查模型。
  {
    const byDshSeq = new Map();
    for (const f of fs) {
      const n = f && f.meta && f.meta.seq;
      if (!Number.isFinite(n)) continue;
      if (!byDshSeq.has(n)) byDshSeq.set(n, []);
      byDshSeq.get(n).push(f);
    }
    let dupCount = 0;
    const dupSeqs = [];
    for (const [n, arr] of byDshSeq) { if (arr.length > 1) { dupCount += arr.length - 1; dupSeqs.push(n); } }
    if (dupCount > 0) {
      // ★★ 2026-11-07 加：**区分「历史疤」和「还在流血」**。
      //
      //   本容器实测：392 个重复全部挤在 03:40:42–03:41:27 这 45 秒里，
      //   而最近 500 个 seq 一个都没有 —— 说明同步器的去重修复生效了，
      //   剩下的是**清不掉的历史**（本库只追加）。
      //
      //   ★ 为什么必须分开：**报一个已经修好的问题，会让人白忙**。
      //     而「还在发生」是必须马上查的，「已经止血」只要知道就行 ——
      //     这两种的处置完全不同，混在一起报就是在制造噪音。
      //
      //   ★ 判据怎么来的：看**最大的重复 seq 离全局最大 seq 有多远**。
      //     近 = 还在发生；远 = 历史。这里用「后 20% 的 seq 区间内有没有重复」做分界 ——
      //     比例而不是绝对条数，因为长会话的尾巴可以很长。
      // ★★ 2026-11-07 修（**同一个判据我改了两遍，第一遍也是错的**）：
      //   第一版用「最大重复 seq 离全局最大 seq 多远」判断是否还在发生 —— **那是错的**。
      //   本容器实测：392 个重复挤在 03:40:42–03:41:27 这 45 秒里，
      //   但它们的 DSH seq 已经是 11332–12156，离全局最大 12893 并不远 ——
      //   seq 走得快不代表时间近。**seq 不等于时间。**
      //   第二版改用**时间**：最后一条重复帧 vs 最后一条帧，差多少分钟。
      //
      //   ★ 这条教训写进代码里：**判据的输入要先验它到底量的是什么**。
      //     我在热记忆里刚写过「判据本身会造假」，然后当场又造了一次。
      const allTs = fs.map((f) => f && f.t).filter(Number.isFinite);
      const lastT = allTs.length ? Math.max(...allTs) : 0;
      const dupFrames = dupSeqs.flatMap((n) => byDshSeq.get(n) || []);
      const dupLastT = dupFrames.map((f) => f && f.t).filter(Number.isFinite).reduce((a, b) => Math.max(a, b), 0);
      const gapMin = lastT && dupLastT ? Math.round((lastT - dupLastT) / 60000) : null;
      // 30 分钟内有新的重复 = 还在发生；否则算历史
      const alive = gapMin != null && gapMin <= 30;
      const dupMax = Math.max(...dupSeqs);
      const maxSeq = Math.max(...[...byDshSeq.keys()].filter(Number.isFinite));
      candidates.push({
        kind: KIND.DUP,
        from: Math.min(...dupSeqs), to: dupMax,
        door: ['log:' + sid + '#seq=' + Math.min(...dupSeqs)],
        count: dupCount,
        alive,
        why: alive
          ? dupCount + ' 帧被重复写入，且**最近 ' + gapMin + ' 分钟还有新的** —— 去查同步器'
          : dupCount + ' 帧被重复写入，但**已经止血**（最后一条重复在 ' + Math.round(gapMin / 60) + ' 小时前；最大重复 seq ' + dupMax + ' / 全局 ' + maxSeq + '）—— 历史，本库只追加，清不掉也不该清',
      });
    }
  }

  // 排序：先按影响大小（count），再按位置
  candidates.sort((a, b) => (b.count - a.count) || (a.from - b.from));

  return {
    sessionId: sid,
    frames: fs.length,
    candidates,
    stats: {
      total: candidates.length,
      byKind: candidates.reduce((m, c) => { m[c.kind] = (m[c.kind] || 0) + 1; return m; }, {}),
      scanned: fs.length,
    },
  };
}
