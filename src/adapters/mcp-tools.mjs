// MCP 工具定义 —— stdio 与 HTTP 两条腿共用
// ★ 抽出来的理由：两条腿必须暴露同一套工具，重复定义迟早会漂。

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SessionStore } from '../session/store.mjs';
import { loadConfig } from '../config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
export const SERVER_INFO = { name: 'agent-soul', version: '0.1.0' };

let _store = null;
/** 书房索引按根目录缓存 —— 常驻，只重读变了的 */
const soulIdxCache = new Map();
function store() {
  if (!_store) {
    const cfg = loadConfig(path.join(ROOT, 'config.json'));
    _store = new SessionStore(cfg.dataDir);
    _store.__cfg = cfg;
  }
  return _store;
}

/** 关掉 store 的写句柄（进程退出前调） */
export function closeStore() {
  if (_store) { try { _store.saveIndexCache(); } catch {} try { _store.closeAll(); } catch {} }
}

export const TOOLS = [
  {
    name: 'soul_ledger',
    description: '账本（墨）：只追加的记录。读它知道「谁在什么时候承诺了什么」；' +
      '写它记下事实 / 搁置 / 得失。★ promise 只有主导会话能写 —— 不是约定，是代码闸门（写不进去）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['write', 'list', 'stats'], description: '默认 list' },
        type: { type: 'string', enum: ['lead', 'promise', 'fact', 'shelved', 'gain', 'loss', 'persona', 'container'], description: '写什么类型 / list 时过滤' },
        text: { type: 'string', description: '正文（write 必填）' },
        by: { type: 'string', description: '谁写的。不给就用当前会话 id' },
        ref: { type: 'string', description: '证据指针（文件路径 / log:...#seq= / 网址）' },
        feel: { type: 'string', description: '当时的感受 —— 一手，可缺省' },
        limit: { type: 'number', description: 'list 返回几条（默认 20）' },
      },
    },
  },
  {
    name: 'soul_context',
    description: '上下文器官：现在几点、距上次说话多久、这个会话的上下文用了多少（带三档水位）。' +
      '★ 水位是**安全网**，不是考核 —— 过线只该触发一个动作：落盘。',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: '算哪个会话的上下文（不给就只报时间和空闲）' },
        persona: { type: 'string', description: '人格文本的粗略长度（不给就不算它）' },
        windowTokens: { type: 'number', description: '窗口大小（默认 1048576）' },
      },
    },
  },
  {
    name: 'soul_file',
    description: '书房文件检索：搜 L3 一手层（宪章/日记/状态/产物索引…）的正文，' +
      '返回指针 file:<路径>:<行号> + 逐字片段。带 ptr 时直接读原文（自动给前后各 3 行）。' +
      '★ 只收「写的东西」（md/txt/json/mjs/ts/html…），不收二进制和超大文件。',
    inputSchema: {
      type: 'object',
      properties: {
        terms: { type: 'array', items: { type: 'string' }, description: '关键词（多个 = AND）' },
        ptr: { type: 'string', description: '要打开的指针。给了就只读，不搜' },
        limit: { type: 'number', description: '最多返回几条（默认 15）' },
        root: { type: 'string', description: '书房根目录（默认取 config.soul.root）' },
      },
    },
  },
  {
    name: 'soul_compact',
    description: '压一段会话：生成带门牌的压缩帧（第一行就是 log:<会话>#seq=<起>）。' +
      '不传 start/end 就压整个会话。门牌不依赖模型 —— 没 apiKey 也成立。',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: '会话 id' },
        start: { type: 'number', description: '起始 seq（不传 = 第一帧）' },
        end: { type: 'number', description: '结束 seq（不传 = 最后一帧）' },
      },
      required: ['session'],
    },
  },
  {
    name: 'soul_waker',
    description: '唤醒台账：看四视图 / 写判定 / 收一条事件。' +
      '★ 四视图 = 要你执行(act) / 你已执行(done) / 要审计但没审(audit) / 你自己决定做的(auto)。' +
      'charter 只有 pass/ask/block/unchecked，缺省一律 unchecked —— 没写不等于通过。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'state（默认，看台账）| decide（写判定）| ingest（收一条事件）' },
        key: { type: 'string', description: 'decide/ingest 时要操作的台账 key' },
        title: { type: 'string', description: 'ingest 时的标题' },
        from: { type: 'string', description: 'ingest 时的来源' },
        tier: { type: 'string', description: 'ingest 时的层级 act/watch/info' },
        decision: { type: 'string', description: 'decide：resume / hold / audit' },
        charter: { type: 'string', description: 'decide：pass / ask / block / unchecked（不填保留原值）' },
        note: { type: 'string', description: 'decide：附注' },
      },
    },
  },
  {
    name: 'soul_autonomy',
    description: '自主循环状态：现在该不该自己动、为什么、（可选）手动触发一次判定。' +
      '返回静默时长、阈值、今日已动次数、预算上限。',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: '自主回合落在哪个会话；默认是一个专属容器' },
        ignore: { type: 'string', description: '额外要排除的会话 id 片段（逗号分隔）' },
      },
    },
  },
  {
    name: 'soul_recall',
    description: '按关键词检索 agent-soul 的历史（跨会话、跨帧，原文级）。返回命中的帧与它的门牌。',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', description: '关键词' },
      limit: { type: 'integer', description: '最多几条，默认 20' },
      session: { type: 'string', description: '可选，限定某个会话 id' },
      context: { type: 'integer', description: '可选，每条命中前后各带几帧上下文（默认 0）' },
    }, required: ['query'] },
  },
  {
    name: 'soul_frame',
    description: '取某个会话某一帧的完整原文。门牌格式 <sessionId>#<seq>。',
    inputSchema: { type: 'object', properties: {
      session: { type: 'string' }, seq: { type: 'integer' },
    }, required: ['session', 'seq'] },
  },
  {
    name: 'soul_persona',
    description: '取当前人格层全文（分层 + 裁剪记录）。宿主可以把它拼进 system prompt。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'soul_index',
    description: '把宿主产生的帧写进 agent-soul 的索引。★ 挂载模式的关键：宿主写什么，索引就跟什么。支持单帧或整批。',
    inputSchema: { type: 'object', properties: {
      session: { type: 'string', description: '宿主的会话 id（自动建容器）' },
      type: { type: 'string', description: '单帧模式：user / assistant / tool_call / tool_result / system / error / event' },
      text: { type: 'string', description: '单帧模式：可检索的正文' },
      frames: {
        type: 'array',
        description: '批量模式：一次推多帧，每项 { type, text, meta? }。给了 frames 就忽略 type/text。',
        items: { type: 'object', properties: { type: { type: 'string' }, text: { type: 'string' }, meta: { type: 'object' } }, required: ['type', 'text'] },
      },
      meta: { type: 'object' },
    }, required: ['session'] },
  },
  {
    name: 'soul_sessions',
    description: '列出所有会话容器（id / 帧数 / 创建时间 / 路径）。',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } },
  },
  {
    name: 'soul_query',
    description: '一扇门：按关键词查记忆（账本 + 会话 + 可选书房），只回**指针 + 逐字片段**，不做转述。'
      + '指针三种：墨:<行号> / log:<会话>#seq=<n> / file:<路径>:<行号>。拿指针用 soul_query 的 open 取回原文。',
    inputSchema: {
      type: 'object',
      properties: {
        terms: { type: 'array', items: { type: 'string' }, description: '关键词，多个 = AND' },
        limit: { type: 'integer' },
        open: { type: 'string', description: '给一个指针，直接取回原文' },
      },
      required: ['terms'],
    },
  },
  {
    name: 'soul_self',
    description: 'SELF 装配体检：检查自我层有没有被静默丢掉（文件在不在 / 有没有外链到会消失的地方 / 超预算了吗 / 活体段标了「自动生成」吗）。',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'SELF.md 的路径；不给则用 config 里的' },
        budget: { type: 'integer' },
      },
    },
  },
  {
    name: 'soul_mnemon',
    description: '热记忆投影探针：磁盘上有几条 / 多少字节 / 占预算多少。★ 它测不到「实际注入了几条」——'
      + '那个数字只有模型自己能数。返回里的 injected 恒为 null，这是设计不是 bug。',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '热记忆目录；不给则用 config 的 mnemon.runtimeDir，再回落 ~/.mnemon/runtime' },
      },
    },
  },
  {
    name: 'soul_health',
    description: 'agent-soul 自己的状态：会话数 / 帧总数 / 人格层用量 / 数据目录。',
    inputSchema: { type: 'object', properties: {} },
  },
];

export async function callTool(name, args) {
  const s = store();
  const cfg = s.__cfg;
  const a = args || {};

  if (name === 'soul_recall') {
    const q = String(a.query || '');
    const lim = Math.min(Number(a.limit) || 20, 200);
    const hits = a.session ? s.search(String(a.session), q).map(r => ({ sessionId: String(a.session), ...r })) : s.searchAll(q, lim);
    if (!hits.length) return '没有命中「' + q + '」';

    const ctx = Math.max(0, Math.min(Number(a.context) || 0, 10));
    const lines = [];
    for (const h of hits.slice(0, lim)) {
      lines.push('[' + h.sessionId + '#' + h.seq + '] (' + h.type + ') ' + String(h.text || '').slice(0, 300));
      if (ctx > 0) {
        const st = s.load(h.sessionId);
        if (st) {
          for (const f of st.frames) {
            if (f.seq < h.seq - ctx || f.seq > h.seq + ctx || f.seq === h.seq) continue;
            const mark = f.seq < h.seq ? '  ↑' : '  ↓';
            lines.push(mark + ' #' + f.seq + ' (' + f.type + ') ' + String(f.content || f.text || f.name || f.message || '').slice(0, 160));
          }
        }
      }
    }
    return lines.join('\n');
  }

  if (name === 'soul_frame') {
    const st = s.load(String(a.session));
    if (!st) throw new Error('没有这个会话: ' + a.session);
    const f = st.frames.find(x => x.seq === Number(a.seq));
    if (!f) throw new Error('没有 seq=' + a.seq + ' 的帧（共 ' + st.frames.length + ' 帧）');
    return JSON.stringify(f, null, 2);
  }

  if (name === 'soul_persona') {
    const { PersonaLayer } = await import('../persona/layer.mjs');
    const p = new PersonaLayer({ budget: (cfg.persona && cfg.persona.budget) || 80000 });
    const r = p.load((cfg.persona && cfg.persona.files) || [], { root: ROOT });
    const out = p.render();
    return out.text
      + '\n\n---\n已装 ' + r.loaded + ' 个文件，' + out.used + 'B / 预算 ' + out.budget + 'B'
      + (out.dropped.length ? '，裁掉: ' + out.dropped.join(', ') : '');
  }

  if (name === 'soul_index') {
    const sid = String(a.session);
    // ★ 直接用宿主给的 id 建容器 —— 不复制、不改名，失败时不会留垃圾目录
    if (!s.load(sid)) s.create(cfg.dataDir, null, { id: sid });

    // 批量模式
    if (Array.isArray(a.frames)) {
      if (!a.frames.length) return '没给帧';
      const seqs = [];
      for (const f of a.frames) {
        if (!f || !f.type || f.text == null) continue;
        const got = s.append(sid, String(f.type), { text: String(f.text), ...(f.meta ? { meta: f.meta } : {}) });
        seqs.push(got.seq);
      }
      if (!seqs.length) return '没有合法帧（每帧都要有 type 和 text）';
      return '已索引 ' + sid + ' 共 ' + seqs.length + ' 帧，seq ' + seqs[0] + '..' + seqs[seqs.length - 1];
    }

    // 单帧模式
    if (!a.type || a.text == null) return '单帧模式要给 type 和 text；批量请用 frames 数组';
    const f = s.append(sid, String(a.type), { text: String(a.text), ...(a.meta ? { meta: a.meta } : {}) });
    return '已索引 ' + sid + '#' + f.seq;
  }

  if (name === 'soul_sessions') {
    const lim = Math.min(Number(a.limit) || 30, 200);
    const list = s.list().slice(0, lim);
    if (!list.length) return '还没有任何会话';
    return list.map(x => {
      const st = s.load(x.id);
      return x.id + '  ' + (st ? st.frames.length : 0) + ' 帧  ' + new Date(x.createdAt).toISOString().slice(0, 19) + '  ' + (x.cwd || '');
    }).join('\n');
  }

  if (name === 'soul_autonomy') {
    const { Autonomy, autonomousPrompt } = await import('../organs/autonomy.mjs');
    const s = store();
    const cfg = { ...((s.__cfg && s.__cfg.autonomy) || {}) };
    if (args.ignore) cfg.ignoreSessions = String(args.ignore).split(',').map(x => x.trim()).filter(Boolean);
    const a = new Autonomy(s, cfg, path.join(s.__cfg.dataDir, 'autonomy.json'));
    const c = a.check();
    const lines = [
      '阶段: ' + c.phase,
      '原因: ' + c.reason,
      '静默: ' + (c.idle && c.idle.ok ? c.idle.minutes + ' 分钟（扫了 ' + c.idle.scanned + ' 个会话，跳过 ' + c.idle.skipped + '）' : '拿不到'),
      '阈值: ' + a.config.idleThresholdMinutes + ' 分钟',
      '今日已动: ' + (a.state.runsToday || 0) + ' / ' + a.config.maxRunsPerDay,
      '总开关: ' + (a.config.enabled ? '开' : '关'),
    ];
    if (c.phase === 'autonomous') {
      lines.push('');
      lines.push('—— 进入自主时间时会写进会话的那段话 ——');
      lines.push(autonomousPrompt(c, { threshold: a.config.idleThresholdMinutes }));
    }
    return lines.join('\n');
  }

  if (name === 'soul_ledger') {
    const { LedgerBase, LABEL, TYPES, normId } = await import('../organs/ledger.mjs');
    const s = store();
    const lf = (s.__cfg.ledger && s.__cfg.ledger.file) || path.join(s.__cfg.dataDir, 'ledger.jsonl');
    const L = new LedgerBase(lf);
    const action = args.action || 'list';

    if (action === 'stats') {
      const st = L.stats();
      const lines = ['账本 ' + lf, '', '共 ' + st.total + ' 条'];
      for (const t of TYPES) if (st.byType[t]) lines.push('  ' + (LABEL[t] || t).padEnd(4) + ' ' + st.byType[t]);
      lines.push('');
      lines.push('当前主导：' + (st.lead || '（还没有人写过 lead）'));
      if (st.first) lines.push('最早 ' + st.first + ' · 最近 ' + st.last);
      return lines.join('\n');
    }

    if (action === 'write') {
      const r = L.write({
        type: args.type, text: args.text,
        by: args.by || ctx.sessionId || 'mcp',
        ref: args.ref, feel: args.feel,
      });
      if (!r.ok) {
        // ★ 拒绝就是拒绝 —— 说清哪条闸门拦的，不软化
        return '✗ 没写进去（' + r.code + '）：' + r.message;
      }
      return '✓ 已记入账本\n  ' + r.row.t + '  [' + (LABEL[r.row.type] || r.row.type) + ']  ' +
        r.row.text + (r.row.ref ? '\n  └ ' + r.row.ref : '');
    }

    const rows = L.list({ type: args.type || null, limit: args.limit || 20 });
    if (!rows.length) return '账本里没有符合条件的记录（' + lf + '）';
    return rows.map((r) =>
      r.t.slice(11, 16) + '  [' + (LABEL[r.type] || r.type) + ']  ' + r.text +
      (r.by ? '\n          └ by ' + normId(r.by) : '') +
      (r.ref ? '\n          └ ' + r.ref : '')
    ).join('\n');
  }

  if (name === 'soul_context') {
    const { renderContext, usedTokens, watermarkOf, idleText, nowText } = await import('../organs/context.mjs');
    const s = store();
    const win = Number(args.windowTokens) || (s.__cfg.context && s.__cfg.context.windowTokens) || 1048576;
    const persona = String(args.persona || '');

    let idleMs;
    let used;
    // ★ 2026-11-07 补：不传 session 时，挑「最近写过的那条」报水位。
    //   原来只有显式给 session 才报 —— 于是「随口问一句现在多少」拿到的是空。
    //   而「随口问」才是最常发生的那一次。
    let sid = args.session ? String(args.session) : '';
    if (!sid) {
      const all = s.list();
      if (all.length) {
        sid = all.slice().sort((a, b) => (b.mtime || b.t || 0) - (a.mtime || a.t || 0))[0].id;
      }
    }
    if (sid) {
      const sess = s.load(sid);
      if (sess && sess.frames.length) {
        const last = sess.frames[sess.frames.length - 1];
        idleMs = Date.now() - last.t;
      }
      used = usedTokens(s, sid, persona);
    }

    const lines = ['现在：' + nowText()];
    if (sid && !args.session) lines.push('（没指定会话，取最近写过的那条：' + sid + '）');
    if (idleMs != null) lines.push('该会话最后一次写入：' + idleText(idleMs));
    if (used != null) {
      const wm = watermarkOf(used, win);
      lines.push('上下文：' + used + ' tokens / ' + win + '（' + (used / win * 100).toFixed(1) + '%）');
      if (wm) lines.push(wm.text);
      else lines.push('（未到 45% 提示线，不打扰）');
      // ★ 一句必须说清的边界：这是**我这个容器里**的会话水位，不是宿主的。
      //   宿主用了多少上下文，是宿主的私事 —— 一个外部记忆层不该假装知道。
      lines.push('★ 这是本软件自己这个容器的水位，**不是你宿主 harness 的**。宿主的上下文我看不到。');
    }
    return lines.join('\n');
  }

  if (name === 'soul_file') {
    const { SoulIndex } = await import('../organs/soul-scan.mjs');
    const s = store();
    const root = String(args.root || (s.__cfg.soul && s.__cfg.soul.root) || 'D:/AI/yanqing-soul');
    let idx = soulIdxCache.get(root);
    if (!idx) { idx = new SoulIndex(root, { ttl: (s.__cfg.soul && s.__cfg.soul.ttl) || 5000 }); soulIdxCache.set(root, idx); }
    const r = idx.refresh();

    if (args.ptr) {
      const o = idx.open(String(args.ptr));
      if (!o) return '打不开：' + args.ptr;
      return (o.line ? '第 ' + o.from + '–' + o.to + ' 行（命中第 ' + o.line + ' 行）' : '全文') + '\n' + o.path + '\n\n' + o.text;
    }

    const q = idx.search(args.terms, { limit: args.limit || 15 });
    const st = idx.stats();
    const head = '书房 ' + st.files + ' 个文件 / ' + st.mb + 'MB' + (r ? '（本次读了 ' + r + ' 份）' : '（没变，没读盘）');
    if (!q.hits.length) return head + '\n搜不到「' + (args.terms || []).join(' ') + '」';
    const lines = [head, '命中 ' + q.hits.length + ' 条 / ' + q.ms + 'ms', ''];
    for (const h of q.hits) {
      lines.push(h.rel + ':' + h.line + '  →  ' + h.ptr);
      lines.push('  ' + h.snippet);
    }
    return lines.join('\n');
  }

  if (name === 'soul_compact') {
    const { compactRange } = await import('../organs/compaction.mjs');
    const sid = String(args.session || '');
    if (!sid) return '要给 session';
    const r = compactRange(store(), sid, { start: args.start, end: args.end });
    if (!r.ok) return '压缩失败：' + r.err;
    return '已压 seq ' + r.start + '–' + r.end + '\n\n' + r.pointer;
  }

  if (name === 'soul_waker') {
    const { Ledger } = await import('../organs/waker.mjs');
    const s = store();
    const l = new Ledger(path.join(s.__cfg.dataDir, 'ledger.json'));
    const action = String(args.action || 'state');

    if (action === 'ingest') {
      const key = String(args.key || (Date.now() + '|' + String(args.title || '').slice(0, 40)));
      const r = l.ingest({ key, t: new Date().toISOString(), title: args.title, from: args.from, tier: args.tier });
      return r.ok ? '已收进台账 ' + key : '没收：' + r.err;
    }

    if (action === 'decide') {
      const key = String(args.key || '');
      if (!key) return 'decide 要给 key';
      const r = l.decide(key, { decision: args.decision, charter: args.charter, note: args.note });
      if (!r.ok) return '判定失败：' + r.err;
      return '已判定 ' + key + '：' + r.event.decision + ' / 宪章 ' + r.event.charter + ' → ' + r.event.stage;
    }

    const v = l.views();
    const lines = [
      '未处理 ' + v.badge + ' 条',
      '  要你执行 ' + v.act.length + '　你已执行 ' + v.done.length + '　要审计没审 ' + v.audit.length + '　你自己决定做的 ' + v.auto.length,
    ];
    const dump = (name, arr) => {
      if (!arr.length) return;
      lines.push('');
      lines.push('【' + name + '】');
      for (const ev of arr.slice(0, 8)) {
        lines.push('  ' + ev.key.slice(0, 40) + '  ' + (ev.title || '').slice(0, 40) + '  [' + ev.stage + '/' + (ev.decision || '-') + '/' + ev.charter + ']');
      }
    };
    dump('要你执行', v.act);
    dump('要审计没审', v.audit);
    dump('你已执行', v.done.slice(0, 3));
    return lines.join('\n');
  }

  if (name === 'soul_query') {
    const { Query } = await import('../tools/query.mjs');
    // 账本是**文件路径**（Query 只认这个 —— 数组没有稳定行号，指针就只能编）。
    // ★ 三级优先，和砚台的 pickLedger 同一套：
    //   ① config.ledger.file（显式配的）
    //   ② soul.root/02-墨.jsonl（真正的《墨》—— 通常是这个）
    //   ③ dataDir/ledger.jsonl（本软件自己的空账本，最后兜底）
    //   2026-11-07 踩过：原来只走 ③，于是一查「账本」就报「读不到」——
    //   而**账本明明在**，只是我没去找它。那比「没有账本」更误导。
    const { pickLedger } = await import('../yantai/panel.mjs');
    const picked = pickLedger(cfg);
    const lf = picked && picked.file ? picked.file
      : ((cfg.ledger && cfg.ledger.file) || path.join(cfg.dataDir, 'ledger.jsonl'));
    // ★ 书房层：一个「适配器」把 soul_file 那个检索包成 Query 要的形状。
    //   为什么包一层而不是让 Query 直接读盘：Query 是通用库，它不该知道
    //   「书房长什么样、缓存在哪」。那一层知识留在 mcp-tools 里。
    const soulRoot = cfg.soul && cfg.soul.root;
    let soulAdapter = null;
    if (soulRoot) {
      const { SoulIndex } = await import('../organs/soul-scan.mjs');
      let idx = soulIdxCache.get(soulRoot);
      if (!idx) { idx = new SoulIndex(soulRoot, { ttl: (cfg.soul && cfg.soul.ttl) || 5000 }); soulIdxCache.set(soulRoot, idx); }
      soulAdapter = {
        search: (terms, opt) => {
          // ★ 必须先 refresh() —— SoulIndex 是懒加载的。
          //   只 new 不 refresh，search 会安静地返回 0 条。
          //   2026-11-07 踩过：同一个 idx，soul_file 里能搜到、这里搜不到，
          //   差别就在 soul_file 调了 refresh() 而这里没调。
          //   **「搜了、没有」和「根本没扫」长得一模一样** —— 所以这一行是必需的，不是优化。
          idx.refresh();
          const r = idx.search(terms, { limit: (opt && opt.limit) || 8 });
          return { hits: (r && r.hits) || [] };
        },
        open: (ptr) => idx.open(String(ptr)),
      };
    }
    const q = new Query(s, lf, { soul: soulAdapter });
    if (a.open) {
      const r = q.open(String(a.open));
      return r && r.ok ? (r.ptr + '\n' + r.text) : ('打不开 ' + a.open + '：' + (r && r.hint || '未知'));
    }
    const terms = Array.isArray(a.terms) ? a.terms : [String(a.terms || '')];
    const r = q.search(terms, { limit: Math.min(Number(a.limit) || 8, 50) });
    if (r.code && r.code !== 'OK') return '[' + r.code + '] ' + (r.hint || '') + (r.scope ? '\n范围：' + r.scope : '');
    if (!r.hits || !r.hits.length) return '没有命中「' + terms.join(' + ') + '」\n★ 这是「搜了、没有」，不是「搜不到」——' + (r.scope || '');
    // ★ 层名要标出来 —— 三条命中的形状对，但「这条是会话里的」和
    //   「这条是我写在书房里的」不一样：一个是过程，一个是写下来的东西。
    const LAYER = { ledger: '账本', log: '会话', soul: '书房' };
    const counts = {};
    for (const h of r.hits) counts[h.layer] = (counts[h.layer] || 0) + 1;
    const spread = Object.keys(counts).map(k => (LAYER[k] || k) + ' ' + counts[k]).join(' · ');
    const lines = [r.hits.length + ' 条（' + spread + (r.total > r.hits.length ? ' / 共 ' + r.total : '') + '）'];
    for (const h of r.hits) {
      lines.push('  ' + '[' + (LAYER[h.layer] || h.layer) + ']'.padEnd(2) + ' ' + h.ptr + '  ' + String(h.snippet || '').slice(0, 120));
    }
    // ★ 没接上哪层要说 —— 「搜了没有」和「那层没接」是两件事。
    const miss = [];
    if (!r.connected.ledger) miss.push('账本（' + (r.connected.ledgerError || '没接') + '）');
    if (!r.connected.soul) miss.push('书房（' + (r.connected.soulNote || '没配 soul.root') + '）');
    if (miss.length) lines.push('  ⚠ 这两层是盲区：' + miss.join(' · '));
    return lines.join('\n');
  }
  if (name === 'soul_self') {
    const { checkSelf } = await import('../tools/self.mjs');
    const file = a.file || (cfg.self && cfg.self.file) || null;
    const r = checkSelf({ file, budget: Number(a.budget) || undefined });
    const lines = [r.code + (r.file ? '  ' + r.file : ''), r.hint || ''].filter(Boolean);
    for (const c of r.checks || []) lines.push('  [' + (c.ok ? '✓' : '✗') + '] ' + c.title + (c.why ? '  ' + c.why : ''));
    if (r.skipped && r.skipped.length) lines.push('  跳过：' + r.skipped.join(',') + '  ← 没检查不等于通过');
    return lines.join('\n');
  }
  if (name === 'soul_mnemon') {
    const { MnemonProbe } = await import('../organs/mnemon-probe.mjs');
    const dir = a.dir || (cfg.mnemon && cfg.mnemon.runtimeDir) || undefined;
    const p = new MnemonProbe(dir);
    const m = p.measure();
    return (p.render ? p.render(m) : JSON.stringify(m, null, 2));
  }
  if (name === 'soul_health') {
    const list = s.list();
    let frames = 0;
    for (const x of list) { const st = s.load(x.id); if (st) frames += st.frames.length; }
    return JSON.stringify({ sessions: list.length, frames, dataDir: cfg.dataDir, ...SERVER_INFO }, null, 2);
  }

  const e = new Error('没有这个工具: ' + name);
  e.code = 'NO_TOOL';
  throw e;
}