// src/tools/delegate.mjs —— 委派（批二，2026-11-11）。
//
// ★ 为什么它排在批二第一位（爀曦 13:09 定了定位之后）：
//   v4 是**调度基体**，不是 harness。调度单元的正面职责就是**把活派出去** ——
//   而不是自己什么都能干。后者是 harness 的思路，前者是基体的思路。
//
// ★ 三条判据：
//   1. **独立上下文**：子会话有自己的 sessionId 和帧序列，主会话不被它的中间过程污染。
//      这正是只读浏览策略里「分离」的那个思想：让一件脏活在一段干净的上下文里跑完。
//   2. **结果可回取**：返回的不只是回答，还有门牌 `log:<sid>#seq=<from>-<to>`。
//      主会话要看细节就按门牌回取，而不是指望子会话把一切复述一遍。
//   3. **不许递归**：在委派出来的会话里再调 delegate 直接拒。
//      没有这条，一个「把这件事拆开做」的判断就能把整台机器拉爆。
//
// ★ 这一版是**阻塞**的（跑完返回）。异步版（派完就返回 jobId）留到有真实长活时再加 ——
//   现在加一个没人用的异步接口，等于给自己留一个没验证过的分支。

import { FRAME } from '../session/frame.mjs';

// 正在被当作「委派目标」跑的会话 —— 它们内部不许再委派。
const delegating = new Set();

const ANSWER_MAX = 4000;

export function registerDelegateTools(registry, { store, loop, config, log = () => {} } = {}) {
  registry.register({
    name: 'delegate',
    description: '把一件**自包含**的活派给一个独立会话去做，跑完把结果带回来。' +
      '★ 它跑在自己的上下文里：主会话不会看到它的中间步骤，只看得到最终回答 + 一个可回取的门牌。' +
      '★ 适合：会弄脏上下文的探索（翻很多文件、跑一堆命令）、可独立验收的子任务。' +
      '★ 不适合：需要跟我来回确认的事（它问不了你）、一句话就能做完的小事。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '要它做什么（动宾，说清成品长什么样）' },
        brief: { type: 'string', description: '背景 / 约束 / 已知的坑 / 不许做什么（它看不到我们这边的对话）' },
        maxSteps: { type: 'integer', description: '它最多走几步，默认 8' },
      },
      required: ['task'],
    },
    // ★ 子会话要跑多步 + 可能跑命令，300 秒默认不够用，但也不能无限等。
    timeoutMs: 240000,
    handler: async ({ task, brief, maxSteps }, ctx) => {
      const sid0 = (ctx && ctx.sessionId) || '';
      if (sid0 && delegating.has(sid0)) {
        throw new Error('不能在委派出来的会话里再委派 —— 会无限递归。自己把这件事做完，或者把结论带回去让上层再派。');
      }
      const body = String(task || '').trim();
      if (!body) throw new Error('task 是空的');
      const briefText = String(brief || '').trim();

      const cwd = (config && config.workspace) || process.cwd();
      const header = store.create(cwd, null);
      const sid = header && header.id;
      if (!sid) throw new Error('建子会话失败（store.create 没返回 id）');

      const userText = (briefText ? '【背景 / 约束】\n' + briefText + '\n\n【任务】\n' : '') + body;
      store.append(sid, FRAME.USER, { text: userText });

      const t0 = Date.now();
      delegating.add(sid);
      try {
        const r = await loop.turn(sid, () => {});
        const ms = Date.now() - t0;
        // 门牌：这个子会话从头到尾的帧范围。主会话要看细节就按它回取。
        let from = 1; let to = null;
        try {
          const frames = store.recent(sid, 10000) || [];
          if (frames.length) { from = frames[0].seq == null ? 1 : frames[0].seq; to = frames[frames.length - 1].seq; }
        } catch { /* 拿不到就不写 to，门牌退化成只有起点 */ }
        const text = String((r && r.text) || '');
        log('委派 ' + sid.slice(0, 16) + ' 完成 ' + ms + 'ms · ' + (r && r.steps) + ' 步');
        return {
          ok: true,
          sessionId: sid,
          steps: (r && r.steps) || 0,
          ms,
          pointer: 'log:' + sid + '#seq=' + from + (to == null ? '' : '-' + to),
          answer: text.length > ANSWER_MAX ? text.slice(0, ANSWER_MAX) + '\n…（回答更长，按门牌回取全文）' : text,
        };
      } finally {
        delegating.delete(sid);
      }
    },
  });
  log('delegate 已注册（阻塞 · 独立会话 · 禁递归 · 带门牌）');
}
