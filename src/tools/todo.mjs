// src/tools/todo.mjs —— 待办（P1 的两只手之一）。
//
// ★ 为什么它排 P1：PRESET-COVERAGE 里 tool-todo 属于「必须补」那一档，理由是
//   **没有「列步骤」，v4 做完一步就不知道下一步该干什么**。
//   这不是抽象担忧：2026-11-11 实测它跑 glob 失败那次，连换三次路子 ——
//   它是在现场试错，而不是照着一条已知的步骤往下走。
//
// ★ 四条判据：
//   1. **整表替换**（与 DSH 的 todo_write 同语义）。不做增量 patch ——
//      增量会让「第几条」在两次调用之间漂移，而模型引用的是序号。
//   2. **按会话隔离**。同一台机器上不同会话的待办不能互相覆盖。
//   3. **落盘**（<dataDir>/todos.json），不只在内存：v4 是长驻服务，
//      但「重启后我刚才列到第几步」这件事本身就是有用的记忆。
//   4. **状态只有三种**：pending / in_progress / completed。别的值直接拒绝 ——
//      自由文本状态会让「还有几步没做」这个问题没有确定答案。
//
// ★ 只写这一个文件；读的时候只读它。不做「完成率统计」这类加工 —— 那是显示层的事。

import fs from 'node:fs';
import path from 'node:path';

const STATUSES = ['pending', 'in_progress', 'completed'];
const MAX_ITEMS = 100;
const CONTENT_MAX = 500;

export function createTodoStore({ file, log = () => {} } = {}) {
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
    } catch (e) { log('待办落盘失败：' + String((e && e.message) || e)); }
  }

  function read(sessionId) {
    const all = load();
    const list = all[String(sessionId || 'default')];
    return Array.isArray(list) ? list : [];
  }

  function write(sessionId, todos) {
    const list = [];
    for (const t of (Array.isArray(todos) ? todos : [])) {
      if (!t || typeof t !== 'object') continue;
      const content = String(t.content == null ? '' : t.content).trim().slice(0, CONTENT_MAX);
      if (!content) continue;
      const status = String(t.status || 'pending');
      if (STATUSES.indexOf(status) < 0) {
        throw new Error('status 只能是 ' + STATUSES.join(' / ') + '，收到：' + status);
      }
      list.push({ content, status });
      if (list.length >= MAX_ITEMS) break;
    }
    const all = load();
    all[String(sessionId || 'default')] = list;
    cache = all;
    save();
    return list;
  }

  function summary(list) {
    const counts = { pending: 0, in_progress: 0, completed: 0 };
    for (const t of list) counts[t.status] = (counts[t.status] || 0) + 1;
    return counts;
  }

  return { read, write, summary };
}

export function registerTodoTools(registry, { dataDir, log = () => {} } = {}) {
  const store = createTodoStore({ file: path.join(dataDir || '.', 'todos.json'), log });

  registry.register({
    name: 'todo_write',
    description: '写待办清单（**整表替换**，不是追加）。每项 {content, status}，status 只能是 pending / in_progress / completed。' +
      '★ 用它把「接下来要做哪几步」写下来 —— 没有它，做完一步就不知道下一步该干什么。',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: '完整清单（最多 100 条）；传空数组 = 清空',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: '这一步做什么（动宾）' },
              status: { type: 'string', enum: STATUSES },
            },
            required: ['content'],
          },
        },
      },
      required: ['todos'],
    },
    handler: ({ todos }, ctx) => {
      const sid = (ctx && ctx.sessionId) || 'default';
      const list = store.write(sid, todos);
      return { ok: true, sessionId: sid, count: list.length, counts: store.summary(list), todos: list };
    },
  });

  registry.register({
    name: 'todo_read',
    description: '读当前会话的待办清单与各状态计数。',
    parameters: { type: 'object', properties: {} },
    handler: (_a, ctx) => {
      const sid = (ctx && ctx.sessionId) || 'default';
      const list = store.read(sid);
      return { ok: true, sessionId: sid, count: list.length, counts: store.summary(list), todos: list };
    },
  });

  return store;
}
