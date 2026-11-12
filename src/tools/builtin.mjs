// 内置工具 —— 最小集：读写文件 / 列目录 / 跑命令
//
// ★ 所有文件操作限制在 workspace 根内（守卫做，不靠自觉）。

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { decodeOutput } from '../util/decode.mjs';

// ★ 2026-11-10 第十轮：notify_lead 的**回执外壳**。
//
//   旧外壳是：`const r = await notify(...); return { ok: true, sent: true, result: r };`
//   于是 deliverPanelNotice 判 block（内层 ok:false / delivered:false）时，
//   工具结果仍然是 { ok:true, sent:true } —— 面板里的 LLM **只看 ok/sent**，
//   会以为话已经传到主导那里了；真相埋在 result 里，得翻开 JSON 才看得见。
//   这一条正是第九轮报告 §9.3 登记的剩余限制。
//
//   现在的口径（与 guard.deliverPanelNotice 的回执同构）：
//     · ok / sent / delivered 三者**只由业务投递**决定 —— 内层 delivered:true 才算；
//     · 传输层单独用 transportOk 表示，它不许被下游读成「已通知」；
//     · stage / reason 保留可读原因（block / no-host / timeout / target-mismatch …），
//       charter 保留宪章结论，便于事后诊断；
//     · 只回**白名单字段** + 已脱敏标题：原始 title / facts / summary 一律不出门。
function noticeReceipt(r) {
  const o = (r && typeof r === 'object') ? r : {};
  const delivered = o.delivered === true;
  const out = {
    ok: delivered,
    sent: delivered,
    delivered,
    transportOk: o.transportOk === true,
    stage: String(o.stage || (delivered ? 'delivered' : 'not-delivered')).slice(0, 40),
    reason: String(o.reason || o.why || (delivered ? 'host-confirmed' : '没有拿到投递确认')).slice(0, 200),
    charter: String(o.charter || 'unchecked').slice(0, 16),
  };
  if (o.blocked === true) out.blocked = true;
  if (o.hostId) out.hostId = String(o.hostId).slice(0, 64);
  if (o.target) out.target = String(o.target).slice(0, 80);
  if (o.ambiguous === true) out.ambiguous = true;
  if (typeof o.bytes === 'number') out.bytes = o.bytes;
  if (o.title) out.title = String(o.title).slice(0, 120);   // 已是脱敏标题；普通文本保持可读
  return out;
}

// ── 2026-11-11 · 通配符 → 正则（只支持 * ? **，够用且不引依赖）──────────
//   ★ 语义按「路径」来：* 不跨 /，** 跨任意层。所以不能用简单的 replace('*','.*')。
//   ★ 大小写不敏感：Windows 上 A.mjs 与 a.mjs 是同一个文件，匹配规则得跟文件系统一致。
export function globToRegex(pattern) {
  const p = String(pattern || '').split(path.sep).join('/');
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        i++;
        if (p[i + 1] === '/') i++;   // **/ 吃掉斜杠，才能匹配「零层目录」
        re += '.*';
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '.';
    } else if ('\\^$.|+()[]{}'.indexOf(c) >= 0) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$', 'i');
}

export function registerBuiltins(registry, { workspace, shellTimeoutMs = 30000, notify = null }) {
  const WS = path.resolve(workspace);

  /** 把用户给的相对路径解析成工作区内的绝对路径；越界直接抛 */
  function inside(p) {
    const abs = path.resolve(WS, String(p || '.'));
    const rel = path.relative(WS, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('路径越界: ' + p);
    return abs;
  }

  registry.register({
    name: 'read_file',
    description: '读一个文本文件（相对工作区）。可选 offset/limit 按行取。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区的路径' },
        offset: { type: 'integer', description: '起始行（1 基）' },
        limit: { type: 'integer', description: '最多读多少行' },
      },
      required: ['path'],
    },
    handler: ({ path: p, offset, limit }) => {
      const abs = inside(p);
      const text = fs.readFileSync(abs, 'utf8');
      if (offset == null && limit == null) return text;
      const lines = text.split('\n');
      const start = Math.max(0, (offset || 1) - 1);
      const end = limit ? start + limit : lines.length;
      return lines.slice(start, end).map((l, i) => String(start + i + 1).padStart(5) + ' | ' + l).join('\n');
    },
  });

  registry.register({
    name: 'write_file',
    description: '写一个文本文件（相对工作区）。目录会自动创建。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
    handler: ({ path: p, content }) => {
      const abs = inside(p);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, String(content ?? ''), 'utf8');
      return '已写入 ' + abs + '（' + Buffer.byteLength(String(content ?? '')) + ' 字节）';
    },
  });

  registry.register({
    name: 'list_dir',
    description: '列一个目录（相对工作区）。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '默认 .' } },
    },
    handler: ({ path: p }) => {
      const abs = inside(p || '.');
      const items = fs.readdirSync(abs, { withFileTypes: true }).map(e => {
        if (e.isDirectory()) return e.name + '/';
        try { return e.name + '  (' + fs.statSync(path.join(abs, e.name)).size + 'B)'; }
        catch { return e.name; }
      });
      return items.join('\n');
    },
  });

  // ── 2026-11-11 · 补 P0 的两只手：glob / grep ──────────────────────────
  //   ★ 为什么先补这两个：PRESET-COVERAGE 里排 P0 —— 缺了它们，v4 连「在大目录里找东西」
  //     都做不了，而那是一切其它活的地基。DSH 那边对应 tool-fs-search 一行。
  //   ★ 自己实现、不引依赖：只需要 * ? ** 三种通配 + 标准 JS 正则，
  //     引一个 glob 库换来的是一份要跟着升级的依赖。
  //   ★ 跳 node_modules / .git —— 否则一次 glob 就是几十万条。
  registry.register({
    name: 'glob',
    description: '按通配符找文件（相对工作区）。支持 * ? **。跳 node_modules/.git。最多返回 limit 条。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '例：**/*.mjs 或 src/*.js' },
        path: { type: 'string', description: '起始目录，默认 .' },
        limit: { type: 'integer', description: '默认 100，最多 500' },
      },
      required: ['pattern'],
    },
    handler: ({ pattern, path: p, limit }) => {
      const root = inside(p || '.');
      const max = Math.min(Number(limit) || 100, 500);
      const re = globToRegex(String(pattern || ''));
      const out = [];
      const stack = [root];
      let scanned = 0;
      while (stack.length && out.length < max && scanned < 20000) {
        const dir = stack.pop();
        let ents;
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of ents) {
          if (e.name === 'node_modules' || e.name === '.git') continue;
          const full = path.join(dir, e.name);
          scanned++;
          if (e.isDirectory()) { stack.push(full); continue; }
          const rel = path.relative(WS, full).split(path.sep).join('/');
          if (re.test(rel)) out.push(rel);
          if (out.length >= max) break;
        }
      }
      // ★★ 2026-11-11：**必须把总条数写出来**。起因是一次实测：子会话用 glob 拿到 82 行，
      //   然后数成 80 交给上层 —— 工具是对的，错在「让模型自己数一串行」。
      //   数长列表是模型最容易出错的动作之一，而且错了没人能看出来（它给的是一个像样的数字）。
      //   **能由工具算的，就不要让模型数。**
      return out.length
        ? out.join('\n') + '\n（共 ' + out.length + ' 条' + (out.length >= max ? '，已到上限 ' + max + '，可能还有更多' : '') + '）'
        : ('（没有匹配：' + pattern + ' · 扫了 ' + scanned + ' 项）');
    },
  });

  registry.register({
    name: 'grep',
    description: '按正则搜文件内容，返回 文件:行号: 内容。跳 node_modules/.git 与二进制；单文件上限 2MB。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '标准 JS 正则' },
        path: { type: 'string', description: '目录或文件，默认 .' },
        include: { type: 'string', description: '只搜匹配这个 glob 的文件，例：*.mjs' },
        limit: { type: 'integer', description: '默认 50，最多 300' },
      },
      required: ['pattern'],
    },
    handler: ({ pattern, path: p, include, limit }) => {
      const target = inside(p || '.');
      const max = Math.min(Number(limit) || 50, 300);
      let re;
      try { re = new RegExp(String(pattern || '')); } catch (e) { throw new Error('正则不合法：' + e.message); }
      const incRe = include ? globToRegex(String(include)) : null;
      const out = [];
      const scanFile = (full) => {
        const rel = path.relative(WS, full).split(path.sep).join('/');
        if (incRe && !incRe.test(rel)) return;
        let st; try { st = fs.statSync(full); } catch { return; }
        if (!st.isFile() || st.size > 2 * 1024 * 1024) return;
        let text; try { text = fs.readFileSync(full, 'utf8'); } catch { return; }
        if (text.includes('\u0000')) return;              // 二进制
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (!re.test(lines[i])) continue;
          out.push(rel + ':' + (i + 1) + ': ' + lines[i].trim().slice(0, 200));
          if (out.length >= max) return;
        }
      };
      const walk = (dir) => {
        if (out.length >= max) return;
        let ents;
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          if (out.length >= max) return;
          if (e.name === 'node_modules' || e.name === '.git') continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full); else scanFile(full);
        }
      };
      let st0; try { st0 = fs.statSync(target); } catch { throw new Error('路径不存在：' + (p || '.')); }
      if (st0.isFile()) scanFile(target); else walk(target);
      // ★ 同 glob：总条数由工具算，不让模型自己数（它会数错，而且错得看不出来）。
      return out.length
        ? out.join('\n') + '\n（共 ' + out.length + ' 条匹配' + (out.length >= max ? '，已到上限 ' + max : '') + '）'
        : ('（没有命中：' + pattern + '）');
    },
  });
  registry.register({
    name: 'edit_file',
    description: '在文件里精确替换一段文本。★ old_string 必须**唯一出现一次**（不唯一就报错，让你给更长的上下文）。' +
      '比 write_file 安全得多 —— 改一行不用重写整个文件。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径（相对工作区或绝对）' },
        old_string: { type: 'string', description: '要被替换的原文（要够长，确保唯一）' },
        new_string: { type: 'string', description: '替换成什么（空字符串 = 删除）' },
        replace_all: { type: 'boolean', description: '允许替换所有出现（默认 false）' },
      },
      required: ['path', 'old_string'],
    },
    handler: ({ path: p, old_string: oldStr, new_string: newStr, replace_all: all }) => {
      const abs = inside(String(p || ''));
      const before = fs.readFileSync(abs, 'utf8');
      const needle = String(oldStr == null ? '' : oldStr);
      const repl = String(newStr == null ? '' : newStr);
      if (!needle) throw new Error('old_string 是空的 —— 空串会匹配到每一处，不做');
      const count = before.split(needle).length - 1;
      if (count === 0) throw new Error('这段原文在 ' + p + ' 里找不到（一个字都没改）');
      if (count > 1 && all !== true) {
        throw new Error('这段原文在 ' + p + ' 里出现了 ' + count + ' 次 —— 不唯一，改不了。' +
          '给更长的上下文把它定位到一处，或者显式传 replace_all:true。');
      }
      const after = all === true ? before.split(needle).join(repl) : before.replace(needle, repl);
      fs.writeFileSync(abs, after, 'utf8');
      // ★ 只回改了哪几行，不回整篇 —— 回整篇会让上下文被一份文件副本吃掉。
      const lineNo = before.slice(0, before.indexOf(needle)).split('\n').length;
      return { ok: true, path: abs, replaced: all === true ? count : 1, atLine: lineNo, bytes: after.length };
    },
  });

  // ── run_shell ──
  registry.register({
    name: 'run_shell',
    description: '在工作区里跑一条命令（cmd /c）。有超时，输出会被截断。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeoutMs: { type: 'integer', description: '默认 30000' },
      },
      required: ['command'],
    },
    handler: ({ command, timeoutMs }) => new Promise((resolve, reject) => {
      execFile('cmd.exe', ['/c', String(command)], {
        cwd: WS,
        timeout: Math.min(Number(timeoutMs) || shellTimeoutMs, 300000),
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        // ★ 2026-11-11：拿 Buffer 自己解 —— encoding:'utf8' 会把中文 Windows 的 GBK 输出解成乱码，
        //   而模型看到乱码会以为命令失败。判据在 util/decode.mjs（先 UTF-8，坏了再 GBK）。
        encoding: 'buffer',
      }, (err, stdout, stderr) => {
        const out = decodeOutput(stdout);
        const errText = decodeOutput(stderr);
        if (err && err.killed) return reject(new Error('命令超时'));
        const body = (out + (errText ? '\n[stderr]\n' + errText : '')).slice(0, 20000);
        resolve(body + '\n[exit ' + (err ? (err.code ?? '?') : 0) + ']');
      });
    }),
  });

  // ★ 2026-11-07 新增：叫醒主导。
  //   之前这个 LLM 只有 4 个文件类工具（读/写/列/跑），**它不知道自己是砚青、
  //   也不知道主导在 DSH 那边** —— 于是在面板里说的话永远到不了主导那里。
  //   这条把「面板里的我」和「DSH 里的我」接通：v4 判断该让人知道，就叫一声。
  if (typeof notify === 'function') {
    registry.register({
      name: 'notify_lead',
      description:
        '叫醒主导会话（DSH 里那个正在跟爀曦说话的砚青）。' +
        '当你在面板里意识到「这件事该让主导知道 / 该让主导去做」，用它传话。' +
        '不是聊天，是转达：title 一句话说清是什么，facts 给背景和证据。' +
        '★ 回执：只有 ok=true 且 delivered=true 才是真投到主导；' +
        'transportOk=true 只说明宿主回了帧（传输到达），不代表投递成功 —— 别把它当「已通知」。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '一句话说清要主导做什么' },
          facts: { type: 'string', description: '背景、证据、已查过什么' },
        },
        required: ['title'],
      },
      handler: async (args) => {
        const title = String((args && args.title) || '').trim();
        if (!title) {
          return { ok: false, sent: false, delivered: false, transportOk: false, stage: 'input', reason: 'title 不能为空' };
        }
        let r;
        try {
          r = await notify({ title, facts: String((args && args.facts) || '') });
        } catch (e) {
          // ★ 内层若抛（不该发生：deliverPanelNotice 失败也回回执），这里也不许冒充成功。
          const msg = String((e && e.message) || e).slice(0, 200);
          return { ok: false, sent: false, delivered: false, transportOk: false, stage: 'host-error', reason: msg, error: msg };
        }
        return noticeReceipt(r);
      },
    });
  }
  return { workspace: WS };
}
