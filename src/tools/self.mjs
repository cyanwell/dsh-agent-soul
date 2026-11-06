// self.mjs —— 自我层（SELF）的体检
//
// ★ 从 dsh-agent-soul/plugins/tools/self/self.mjs 搬来。原版两个半：装配 + 体检。
//   这一版只搬**体检**（checkSelf）—— 装配在新软件里由 src/persona/layer.mjs 负责。
//   两处都装配会出现「谁说了算」的问题：同一个身份被拼两遍，改了一处另一处还是旧的。
//
// ★ 为什么体检才是值钱的那一半（原版注释原话）：
//   装配本身太简单（拼几段字符串）。这个工具值钱的地方是【体检】：
//   盯着那一页别退化成一本手册。三条判据一条没改 ——
//     ① 不许有「详见某个文件」这种指向 —— 指向一个可能会静默消失的地方，等于没有指向
//     ② 不许超预算 —— 超了会被截，而截了是无声的
//     ③ 活体段必须是【自动生成的】—— 时钟、未结这类每轮在变的东西不能手写
//
// ★ 形态变了（CLI → 库），随之变的一条判据：
//   原版文件不存在时 console.error + process.exit(1)。
//   新版返回 { ok:false, code:'MISSING', skipped:['links','budget','live'] } ——
//   **没检查 ≠ 通过**。读不到文件就当成干净，是这个工具最坏的一种失败方式。
//
// ★ 也不读环境变量了。原版 SELF_FILE / SELF_BUDGET / SOUL_HOME 三个环境变量，
//   而它自己在注释里写着「默认路径在仓库布局下不存在，于是建出 0 条」。
//   路径只能由调用方给 —— 猜一个默认路径，错了也不会有人告诉你。

import fs from 'node:fs';

export const SELF_LIVE_MARK = '## 活体';
export const DEFAULT_SELF_BUDGET = 12288;

/** 判据①的正则 —— 与老版一字不差（改一个字就是换判据，不是修 bug）。 */
const LINK_LIKE = /(详见|参见|见\s*`?[^`\s]+\.(md|json|txt)|参考\s*`?[^`\s]+\.(md|json))/;

const WHY = {
  exists: '读不到这一页，三条判据一条都验不了 —— 而「没验」和「没问题」看起来一模一样。',
  links: '指向一个可能会静默消失的地方，等于没有指向。',
  budget: '超了会被截，而截了是无声的 —— 你不会知道少了哪一段。',
  live: '时钟 / 未结这类每轮在变的东西必须自动生成；手写的那一段迟早会和事实不一致，而且不一致时你不会知道。',
};

/**
 * 骨架 / 活体切分。
 * ★ 只按第一个 LIVE_MARK 切：它之前是手写不变量，之后是每轮自动生成的。
 *   切出来的 live 不参与判据①（自动生成的内容里出现「详见」不算手写指向）。
 */
export function splitLive(text) {
  const src = String(text == null ? '' : text);
  const cut = src.indexOf(SELF_LIVE_MARK);
  if (cut < 0) return { bone: src, live: '', cut: -1 };
  return { bone: src.slice(0, cut), live: src.slice(cut), cut };
}

/**
 * 体检。返回每一项的检查结果：{ ok, 缺什么, 为什么 }。
 * @param {{ file?: string, budget?: number }} cfg
 * @returns {{
 *   ok: boolean, code: 'OK'|'UNCONFIGURED'|'MISSING'|'READ_FAIL'|'ISSUES',
 *   file: string|null, bytes: number|null, budget: number, pct: number|null,
 *   checks: Array<{id:string,title:string,ok:boolean,why:string,detail:string[]}>,
 *   failed: string[], skipped: string[], hint: string
 * }}
 */
export function checkSelf(cfg = {}) {
  const file = cfg.file ? String(cfg.file) : '';
  const budget = Number.isFinite(cfg.budget) && cfg.budget > 0 ? cfg.budget : DEFAULT_SELF_BUDGET;
  const checks = [];
  const skipped = ['links', 'budget', 'live'];

  const base = (extra) => ({
    ok: false, code: 'UNCONFIGURED', file: file || null, bytes: null, budget, pct: null,
    checks, failed: ['exists'], skipped, hint: '', ...extra,
  });

  if (!file) {
    checks.push({
      id: 'exists', title: '⓪ 这一页在哪', ok: false, why: WHY.exists,
      detail: ['没给 cfg.file'],
    });
    return base({
      hint: '传 cfg.file = "<SELF.md 的完整路径>"。原版靠 SELF_FILE 环境变量，新版不读环境变量 —— '
        + '路径只能由调用方给（老版踩过「默认路径在仓库布局下不存在」的坑）。',
    });
  }

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    const code = (e && e.code) === 'ENOENT' ? 'MISSING' : 'READ_FAIL';
    checks.push({
      id: 'exists', title: '⓪ 这一页在哪', ok: false, why: WHY.exists,
      detail: [code === 'MISSING' ? '文件不存在：' + file : '读不了：' + String((e && e.message) || e)],
    });
    return base({
      code,
      hint: code === 'MISSING'
        ? '先写一页「不变量」：我是谁 / 不能做什么 / 约束分几级 / 要查东西时去哪。'
          + '这个检查不会替你写它 —— 那一页只能是你的。'
        : '文件在，但读不了（权限 / 编码）。先修读取，再谈体检。',
    });
  }

  const bytes = Buffer.byteLength(text, 'utf8');
  const pct = Math.round((bytes / budget) * 100);
  const { bone, live, cut } = splitLive(text);

  // ⓪ 读到了
  checks.push({ id: 'exists', title: '⓪ 这一页在哪', ok: true, why: WHY.exists, detail: [file] });

  // ① 指向（只查骨架）
  const linkLike = [];
  const boneLines = bone.split('\n');
  for (let i = 0; i < boneLines.length; i++) {
    if (LINK_LIKE.test(boneLines[i])) linkLike.push((i + 1) + ': ' + boneLines[i].trim().slice(0, 76));
  }
  checks.push({
    id: 'links', title: '① 没有「详见某某」的指向', ok: linkLike.length === 0,
    why: WHY.links, detail: linkLike,
  });

  // ② 预算
  checks.push({
    id: 'budget', title: '② 没超预算', ok: bytes <= budget, why: WHY.budget,
    detail: [bytes + ' / ' + budget + ' 字节（' + pct + '%）'],
  });

  // ③ 活体段
  let liveDetail;
  if (cut < 0) liveDetail = ['没有「' + SELF_LIVE_MARK + '」段'];
  else {
    const lineNo = text.slice(0, cut).split('\n').length;
    liveDetail = /自动生成/.test(live)
      ? ['标记在，第 ' + lineNo + ' 行起']
      : ['「' + SELF_LIVE_MARK + '」段（第 ' + lineNo + ' 行起）没有标注「自动生成」'];
  }
  const liveOk = cut >= 0 && /自动生成/.test(live);
  checks.push({ id: 'live', title: '③ 活体段是自动生成的', ok: liveOk, why: WHY.live, detail: liveDetail });

  const failed = checks.filter((c) => !c.ok).map((c) => c.id);
  return {
    ok: failed.length === 0,
    code: failed.length ? 'ISSUES' : 'OK',
    file, bytes, budget, pct,
    checks, failed, skipped: [],
    hint: failed.length
      ? '逐条修：' + failed.join(' / ') + '。这三条不是风格要求：它们各自对应一种「无声的坏」。'
      : '三条全过。这一页守住了它该守的东西。',
  };
}
