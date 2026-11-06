// 压缩与裁剪器官 —— 「丢掉的东西，必须留得下门牌」
//
// ★ 这个器官存在的唯一理由，是老版 compaction 开头那段话：
//   「兜底压出来的 checkpoint 无法回溯。原因在它那段硬编码指令 ——
//     它要求保留 exact file paths / commands / error strings / numeric values /
//     function signatures，**但通篇没有一句要求标注『这话从哪来』**。
//     它写出来的东西每一条都对，每一条都无从核对。」
//
// ★★ 而我们的记忆架构只有一条硬规矩：**摘要只能是索引，不能是记忆本体**。
//   所以压缩不能停在「写得好」，它得**写得出门牌**。
//
// ★ 和老版的关系：老版是给 DSH 的 BasicCompactionEngine 打补丁（继承 + 覆盖 summarize）；
//   我们是自己的运行时，没有那个引擎，所以搬过来的是**门牌怎么渲染**和**话题怎么抽**，
//   那两段才是这件东西的价值。

import path from 'node:path';

/** 摘要框的行首标记 —— 醒目的一个词，让后来的我一眼认出这是压缩产物。 */
export const MARK = '> ⛬ 压缩索引（非原文）';

/**
 * 剥掉每轮自动注入的运行时上下文 —— 它不是「我们讲的话」，不能当话题。
 *
 * ★ 老版踩过的坑（2026-11-04 实测）：第一版直接从原文取首句，取到的是
 *   「Current runtime context. This snapshot s」—— 因为宿主每轮把 runtime context
 *   和人格装配页整块拼进消息，**真人说的话在注入块后面**，取首句必然取到注入。
 *   于是「这段讲的是什么」变成了「这段讲的是注入模板」，比没有更误导。
 */
const INJECT_BLOCK = /Current runtime context\.[\s\S]*?Current DeepSeek Harness Web GUI URL:[^\n]*/g;
const INJECT_SR = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const INJECT_HEAD = /^(Current runtime context|Current DeepSeek Harness|Image-gen workbench canvas|【此刻】|# SELF ·|\[MNEMON|Instructions from:|⛬ 压缩索引)/;

export function stripInject(t) {
  let s = String(t || '');
  s = s.replace(INJECT_BLOCK, '\n').replace(INJECT_SR, '\n');
  return s;
}

/**
 * 从被压的那段里抽「讲的是什么」。
 *
 * ★ 为什么必须有这一行：门牌只说「seq 100–500 被压了」，**不告诉我那段讲的是什么**。
 *   于是看到一个 seq 号码，根本不知道该不该取回 —— 门牌有了，触发还是没有。
 *   爀曦原话：「意识到不对劲的时候，是否能想到要召回记忆」。
 *   **要「意识到不对劲」，得先知道刚才丢的是什么。**
 *
 * ★ 从**末尾往前**扫，不从前往后等距抽：
 *   压缩之后我最需要知道的是「刚才在干什么」，不是「三个小时前在干什么」。
 *   而且等距抽样会跳过有内容的位置 —— 老版实测 span=400 时只抽到 1 条。
 */
export function topicsOf(store, sid, start, end, max) {
  const limit = max || 4;
  let toolCalls = 0;
  const out = [];
  const s = store.load(sid);
  if (!s) return { topics: out, toolCalls: 0 };

  const bySeq = new Map();
  for (const f of s.frames) bySeq.set(f.seq, f);

  for (let sq = end; sq >= start && out.length < limit; sq--) {
    const f = bySeq.get(sq);
    if (!f) continue;
    if (f.type === 'tool_call') toolCalls++;
    const t = String(f.text || '');
    if (!t) continue;

    // 首句：到句号/换行/感叹/问号为止
    // ★ 剥完注入后文本常以换行开头 —— 不 trim 就取到空首句、整条丢掉。
    //   老版实测：不 trim 时「剥注入」反而让话题一条都取不到，比不剥更坏。
    const first = stripInject(t).trim().split(/[。\n！？]/)[0].replace(/\s+/g, ' ').trim();
    if (first.length < 8) continue;
    if (!/[\u4e00-\u9fa5A-Za-z]/.test(first)) continue;
    if (INJECT_HEAD.test(first)) continue;   // 兜底：注入块没剥干净，也绝不把它当话题
    out.unshift(first.slice(0, 40));
  }
  return { topics: out, toolCalls };
}

/**
 * 摘要正文里的状态词，按「截至」后处理。
 *
 * ★ 老版的原话（2026-11-04）：摘要正文里的「进行中 / 待办 / 下一步」是**生成那一刻**的状态，
 *   它不会更新 —— 而读它的我会当成现在。三十秒后推送做完了，摘要还写着「进行中」，
 *   于是下一轮我说「接下来我要去推送」。**声明意图，而不是去做。**
 */
const STALE = /(进行中|待办|待处理|待验证|下一步|接下来|打算|将于|准备去)/g;

export function staleFix(text, at) {
  const when = at || '压缩时';
  return String(text || '').replace(STALE, m => m + '（截至 ' + when + '）');
}

/**
 * 把 seq 范围渲染成一小段指针。
 *
 * ★ 第一行就带指针 —— 一律 `log:<sid>#seq=<起>`，可被门命令直接消费。
 * ★ 取不到会话号时退化成没有门牌的一句 —— **错的门牌比没有更坏**。
 */
export function pointerText(sid, start, end, topics, toolCalls, at) {
  const span = 'seq ' + start + '–' + end;
  if (!sid) {
    return [
      MARK + '　本段覆盖 ' + span + '。',
      '> 原文仍在一手层（append-only 会话日志）。会话号取不到，按 seq 找。',
    ].join('\n');
  }

  const lines = [MARK + ' · log:' + sid + '#seq=' + start + '（本段覆盖 ' + span + '）'];

  // ★ 关键的一行：不告诉我「丢了什么」，我就不会想到要取回
  if (Array.isArray(topics) && topics.length > 0) {
    lines.push('> 这段讲的是：' + topics.map(x => '「' + x + '」').join(' · '));
  }

  // ★ 给「本段是什么时候的」一个明确的时态边界。
  //   摘要写的是**生成那一刻**的状态；它不会更新。
  //   不写这一句，后来的我会把「进行中」当成「现在还没做」。
  lines.push('> 本段描述到 ' + (at || '压缩时') + ' 为止；**之后的状态以最新对话为准**');

  // ★ 把「做了」和「说了」分开。
  if (typeof toolCalls === 'number' && toolCalls > 0) {
    lines.push('> 本段实际执行过 ' + toolCalls + ' 次工具调用 —— 这些是**做过的**，不是打算做的');
  } else if (typeof toolCalls === 'number') {
    lines.push('> ★ 本段**没有任何工具调用** —— 其中所有「已做/完成」的说法都只是讨论，未执行');
  }

  lines.push('> 回取：`soul_open log:' + sid + '#seq=' + start + '`');
  return lines.join('\n');
}

/**
 * 压一段：算出话题和门牌，生成一条压缩帧。
 *
 * ★ 这一步**不需要模型** —— 门牌是确定性的。
 *   有模型时可以在门牌下面接摘要正文；没模型时门牌自己就成立。
 *   这个顺序是刻意的：**先保证不丢，再谈写得好**。
 */
export function compactRange(store, sid, opts) {
  const o = opts || {};
  const s = store.load(sid);
  if (!s) return { ok: false, err: '会话不存在: ' + sid };

  const frames = s.frames.filter(f => f.type !== 'session');
  if (!frames.length) return { ok: false, err: '没有可压的帧' };

  const start = Number.isFinite(o.start) ? o.start : frames[0].seq;
  const end = Number.isFinite(o.end) ? o.end : frames[frames.length - 1].seq;
  if (start > end) return { ok: false, err: 'start > end' };

  const at = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const { topics, toolCalls } = topicsOf(store, sid, start, end);
  const pointer = pointerText(sid, start, end, topics, toolCalls, at);

  // ★ 被压区间记在 meta 里 —— 事后能核对「哪些帧被换了」
  const frame = store.append(sid, 'event', {
    text: pointer,
    meta: { kind: 'compaction.summary', start, end, topics, toolCalls, at },
  });

  return { ok: true, frame, pointer, start, end, topics, toolCalls };
}

/**
 * 裁一条工具结果：留头尾，中间换一句标记 —— 但**留门牌**。
 *
 * ★ 老版对官方 pruner 的判断：「它其实已经做对了一半」——
 *   `pruneSession` 在替换时留了完整的回链（shadowedSeqs），
 *   只是渲染出来的那段标记里**没有门牌**，所以看见的人不知道能回取。
 *   我们这里在标记里直接带上 seq。
 */
export function pruneText(sid, seq, text, opts) {
  const o = opts || {};
  const head = Number.isFinite(o.head) ? o.head : 4096;
  const tail = Number.isFinite(o.tail) ? o.tail : 1024;
  const t = String(text || '');
  if (t.length <= head + tail) return { pruned: false, text: t };

  const marker = [
    '',
    '[... 中间 ' + (t.length - head - tail) + ' 字符被裁掉了 ...]',
    '> ⛬ log:' + sid + '#seq=' + seq + '（原文仍在一手层，可回取）',
    '',
  ].join('\n');

  return {
    pruned: true,
    text: t.slice(0, head) + marker + t.slice(t.length - tail),
    removed: t.length - head - tail,
  };
}