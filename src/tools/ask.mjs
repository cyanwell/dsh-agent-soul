// src/tools/ask.mjs —— ask_user（两段式：问是异步事件，答在下一轮上下文回来）。
//
// ★ 设计全文见 _verify/v3-v4-takeover-20261111/ASK-USER-DESIGN.md。
//   这里只抄三条最容易在实现时走歪的：
//
//   1. **不阻塞**。返回值里没有 answer —— 有了它，模型会去等一个永远不来的字段。
//      答案在**下一轮**的上下文里（见 status-data / buildContext 的注入）。
//   2. **复用 deliverPanelNotice 那条通道**，不新开。凌晨那次「block 了但照样投」的坑，
//      再造一条投递线就是给同一个坑挖第二个入口。
//   3. **不许自问自答**。任何「模型自己填 answer」的路径都不做。
//
// ★ 回答默认收敛成「是 / 否」（爀曦 2026-11-11）：面对一个问题他给的是判断，
//   不是一段话。所以前端把 [是] [否] 放主位；但**存储只认字符串**，
//   因为「是，但要先备份」这种答案必须写得下。

import fs from 'node:fs';
import path from 'node:path';

const MAX_OPEN_BLOCK = 3;        // block 级问题最多同时挂 3 条
const MAX_KEEP = 50;             // 每个会话最多留 50 条（answered/withdrawn 也占位）
const NORMAL_TTL_MS = 24 * 3600 * 1000;
const QUESTION_MAX = 400;
const DETAIL_MAX = 1200;
const ANSWER_MAX = 2000;

export function createQuestionStore({ file, log = () => {} } = {}) {
  let cache = null;

  function load() {
    if (cache) return cache;
    try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { cache = {}; }
    if (!cache || typeof cache !== 'object' || Array.isArray(cache)) cache = {};
    return cache;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
      fs.renameSync(tmp, file);
    } catch (e) { log('问题落盘失败：' + String((e && e.message) || e)); }
  }

  /** 过期清理：normal 24 小时自动 withdrawn。 */
  function reap(list, now) {
    for (const q of list) {
      if (q.status !== 'open') continue;
      if (q.urgency === 'block') continue;
      if (now - Date.parse(q.askedAt) > NORMAL_TTL_MS) q.status = 'withdrawn';
    }
    return list;
  }

  function of(sessionId) {
    const all = load();
    const sid = String(sessionId || 'default');
    if (!Array.isArray(all[sid])) all[sid] = [];
    return { all, sid, list: reap(all[sid], Date.now()) };
  }

  function list(sessionId) { return of(sessionId).list.slice(); }

  function add(sessionId, q) {
    const x = of(sessionId);
    const now = Date.now();
    const openBlock = x.list.filter((v) => v.status === 'open' && v.urgency === 'block').length;
    if (q.urgency === 'block' && openBlock >= MAX_OPEN_BLOCK) {
      throw new Error('已经有 ' + openBlock + ' 条「卡住」的问题没回答，先处理它们再问新的');
    }
    const rec = {
      id: 'q-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      question: String(q.question || '').slice(0, QUESTION_MAX),
      detail: String(q.detail || '').slice(0, DETAIL_MAX),
      options: Array.isArray(q.options) ? q.options.map(String).slice(0, 6) : [],
      urgency: q.urgency === 'block' ? 'block' : 'normal',
      askedAt: new Date(now).toISOString(),
      status: 'open',
      answer: null,
      answeredAt: null,
      by: null,
      delivered: q.delivered === true,
      stage: String(q.stage || '').slice(0, 40),
    };
    x.list.push(rec);
    while (x.list.length > MAX_KEEP) x.list.shift();
    x.all[x.sid] = x.list;
    cache = x.all;
    save();
    return rec;
  }

  /** 回答：跨会话按 id 找（前端只有一个输入口，不知道会话）。 */
  function answer(questionId, text, by) {
    const all = load();
    const id = String(questionId || '');
    const val = String(text == null ? '' : text).trim().slice(0, ANSWER_MAX);
    if (!val) return { ok: false, error: '回答是空的' };
    for (const sid of Object.keys(all)) {
      const list = all[sid];
      if (!Array.isArray(list)) continue;
      const hit = list.find((q) => q && q.id === id);
      if (!hit) continue;
      if (hit.status !== 'open' && hit.status !== 'withdrawn') {
        return { ok: false, error: '这条已经回答过了（' + hit.status + '）', questionId: id, answeredAt: hit.answeredAt };
      }
      hit.answer = val;
      hit.answeredAt = new Date().toISOString();
      hit.status = 'answered';
      hit.by = String(by || 'panel').slice(0, 40);
      cache = all;
      save();
      return { ok: true, questionId: id, sessionId: sid, recordedAt: hit.answeredAt };
    }
    return { ok: false, error: '没有这个问题：' + id };
  }

  /** 给上下文注入用：answered 取最近 N，open 全给。 */
  function digest(sessionId, { answeredLimit = 3 } = {}) {
    const x = of(sessionId);
    const open = x.list.filter((q) => q.status === 'open');
    const answered = x.list.filter((q) => q.status === 'answered').slice(-answeredLimit).reverse();
    return { open, answered };
  }

  /** 所有会话的 open/answered —— 前端只有一个口，不知道会话是谁的。 */
  function digestAll({ answeredLimit = 5 } = {}) {
    const all = load();
    const now = Date.now();
    const open = [];
    const answered = [];
    for (const sid of Object.keys(all)) {
      const list = Array.isArray(all[sid]) ? reap(all[sid], now) : [];
      for (const q of list) {
        const row = { ...q, sessionId: sid };
        if (q.status === 'open') open.push(row);
        else if (q.status === 'answered') answered.push(row);
      }
    }
    answered.sort((a, b) => String(b.answeredAt || '').localeCompare(String(a.answeredAt || '')));
    open.sort((a, b) => String(a.askedAt || '').localeCompare(String(b.askedAt || '')));
    return { open, answered: answered.slice(0, answeredLimit) };
  }

  return { list, add, answer, digest, digestAll };
}

export function registerAskTools(registry, { dataDir, notify = null, guardFn = null, log = () => {} } = {}) {
  const store = createQuestionStore({ file: path.join(dataDir || '.', 'questions.json'), log });

  registry.register({
    name: 'ask_user',
    description: '问一个你自己决定不了的问题。★ **它不阻塞**：返回值里没有答案 —— 答案会在**下一轮**上下文里出现。' +
      '用它把「卡住判断」交出去，而不是自己猜或者硬试。回答通常是一个「是 / 否」。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '一句话问清（必填）' },
        detail: { type: 'string', description: '背景：为什么问、卡在哪、你已经试过什么' },
        options: { type: 'array', items: { type: 'string' }, description: '可选：给几个候选，方便对方一句话答' },
        urgency: { type: 'string', enum: ['block', 'normal'], description: 'block = 这一轮做不下去；normal = 顺便问（默认）' },
      },
      required: ['question'],
    },
    handler: async (args, ctx) => {
      const sid = (ctx && ctx.sessionId) || 'default';
      const question = String((args && args.question) || '').trim();
      if (!question) return { ok: false, error: 'question 是空的' };
      const detail = String((args && args.detail) || '').trim();
      const urgency = (args && args.urgency) === 'block' ? 'block' : 'normal';

      // ① 过宪章 —— 问句本身也可能问到凭据（「把那串 key 发我」）。
      //    block 就只留痕、不投递，工具如实说 stage:'guard-block'。
      let charter = 'unchecked';
      if (typeof guardFn === 'function') {
        try {
          const g = await guardFn(question + (detail ? '\n\n' + detail : ''));
          if (g && g.verdict) charter = g.verdict;
        } catch { charter = 'unchecked'; }
      }
      if (charter === 'block') {
        const rec = store.add(sid, { question, detail, options: args && args.options, urgency, delivered: false, stage: 'guard-block' });
        return { ok: false, questionId: rec.id, delivered: false, stage: 'guard-block',
          note: '宪章拦下了这个问题（没投递，但留了痕）—— 换个问法或换个内容' };
      }

      // ② 送出去（复用同一条通道；不新开）
      let delivered = false;
      let stage = 'no-host';
      if (typeof notify === 'function') {
        try {
          const r = await notify({ title: question, facts: detail });
          delivered = !!(r && r.delivered === true);
          stage = String((r && r.stage) || (delivered ? 'delivered' : 'not-delivered')).slice(0, 40);
        } catch (e) { stage = 'notify-error'; }
      }

      // ③ 登记（投递失败也登记 —— 「问了但没送到」必须留证）
      const rec = store.add(sid, { question, detail, options: args && args.options, urgency, delivered, stage });
      return {
        ok: true,
        questionId: rec.id,
        delivered,
        stage,
        note: delivered
          ? '已经问出去了。★ 答案不会在这次调用里返回 —— 它会在下一轮的上下文里出现。'
          : '已登记，但没送到（' + stage + '）。下一轮上下文里仍会看到这条 open 的问题。',
      };
    },
  });

  return store;
}
