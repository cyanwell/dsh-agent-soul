// 手机通道 —— 手机当砚青的声带 + 手机上的轻量聊天页（src/web/phone.html）
// ============================================================================
// ★★ 为什么是**第二个监听**，而不是主 server 上加一条路由
//
//   老版（dsh-tools/dsh-agent-soul/plugins/chat/index.js）自己起 8898，两条理由都要保留：
//     ① 宿主 Web 只绑 127.0.0.1 —— 手机根本连不上；
//     ② 宿主 Web 要鉴权，而那个 token 属于**凭据**（硬线：不读、不复述、不交出）。
//   搬到这个独立软件以后，那两条没有消失，只是换了名字：
//     ① config.host 默认 127.0.0.1（src/config.mjs）—— 这是对的，GUI 本来就只该本机看；
//     ② 新软件没有鉴权层，这一版也**不打算造一个**。
//   所以：主 server 保持 127.0.0.1，手机通道单独绑 0.0.0.0。**两个监听，两种暴露等级。**
//
// ★★★ 0.0.0.0 的代价，必须写在代码里、页面上、README 里：
//     同一个局域网里任何设备都能打开这一页，**没有认证**。
//     能做的只有两件事：读最近的对话、发一条消息。
//     刻意不做（是「不做」，不是「还没做」）：文件访问 / 命令执行 / 上传 / TTS /
//     改配置 / 写别的会话 / 列会话目录。
//     要关：config.json 里 "chat": { "enabled": false }，或环境变量 AGENT_SOUL_CHAT=off，然后重启。
//
// ★ 为什么不加口令：固定口令只会给「它安全了」的错觉 —— 口令要落进 config.json，
//   转发一次配置截图就没了；真要安全是绑回 127.0.0.1，前面放反向代理去做 TLS。
//   所以这里选的是「把能力砍到最小」，而不是「给门挂一把假锁」。
//
// ★★ 老版的四类路由，这一版只搬了两类：
//     搬了：/（手机页）、/api/send（发一条）、最近的对话（老版没有，是这次新加的）；
//     没搬：/api/upload、/api/file、/api/received（文件双向）、/api/audio、/api/tts（声音）、
//           /api/probe、/api/dig（把 ctx 里所有服务的方法名挖出来）—— 后两个是插件期的探测工具，
//           在独立软件里既没有 ctx 也没有意义，搬过来只是多一个信息泄露面。
//   没搬的那些会回 410（不是 404）—— 「刻意关掉」和「没这个路由」必须能分开。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { FRAME } from '../session/frame.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PHONE_HTML = path.join(HERE, '..', 'web', 'phone.html');

/**
 * 默认值。
 * ★ 为什么不放进 src/config.mjs 的 DEFAULTS：这次的写域不含那个文件（它和 server.mjs 一起，
 *   是别人在改的两份）。放这里的效果一样 —— loadConfig() 是 deepMerge(DEFAULTS, config.json)，
 *   config.json 里写了 chat 组就一定会原样出现在 cfg.chat 上。
 *   ★ 但这意味着**参数页看不见这几项**（CFG_GROUPS 在 server.mjs 里），
 *   这一条要写进 README，不能装作它已经在设置面板里了。
 */
export const CHAT_DEFAULTS = {
  enabled: true,          // ★ 默认开：老版装上就活。关法见上面那行，三种都行
  host: '0.0.0.0',        // ★ 这个默认值就是整个模块的目的，不是随手写的
  port: 8898,
  session: null,          // null = 用「最近说过话的那个会话」
  recentLimit: 40,
  maxTextChars: 8000,     // 单条消息进页面的上限（不是发送上限，发送上限见 maxBodyBytes）
  maxBodyBytes: 64 * 1024,
  tailBytes: 512 * 1024,  // 只读 frames.jsonl 的尾部这么多字节，见 tailFrames 的注释
};

/** 合并顺序：默认值 ← config.chat ← 环境变量。环境变量放最后，因为它是最不容易改错的那个。 */
export function chatSettings(config) {
  const c = (config && config.chat) || {};
  const envChat = String(process.env.AGENT_SOUL_CHAT || '').trim().toLowerCase();
  const envOff = envChat === 'off' || envChat === '0' || envChat === 'false' || envChat === 'no';
  const envPort = Number(process.env.AGENT_SOUL_CHAT_PORT || '');
  const envHost = process.env.AGENT_SOUL_CHAT_HOST || '';
  const num = (v, d) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    enabled: envOff ? false : (c.enabled === undefined ? CHAT_DEFAULTS.enabled : Boolean(c.enabled)),
    host: envHost || c.host || CHAT_DEFAULTS.host,
    port: num(envPort, num(c.port, CHAT_DEFAULTS.port)),
    session: c.session || null,
    recentLimit: num(c.recentLimit, CHAT_DEFAULTS.recentLimit),
    maxTextChars: num(c.maxTextChars, CHAT_DEFAULTS.maxTextChars),
    maxBodyBytes: num(c.maxBodyBytes, CHAT_DEFAULTS.maxBodyBytes),
    tailBytes: num(c.tailBytes, CHAT_DEFAULTS.tailBytes),
    /** 这些值是哪儿来的 —— status 里要能说清「你改的那行到底生效了没有」 */
    sources: {
      enabled: envOff ? 'env' : (c.enabled === undefined ? 'default' : 'config'),
      host: envHost ? 'env' : (c.host ? 'config' : 'default'),
      port: envPort ? 'env' : (c.port ? 'config' : 'default'),
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 读会话
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 从文件尾部读 frames，不读全量。
 *
 * ★★ 为什么不直接用 store.recent() / store.load()：它们把整个 frames.jsonl 读进内存，
 *    还塞进一个 64 条的 LRU。本机实测有一个 308MB 的会话文件 ——
 *    手机每 5 秒刷一次，那等于每 5 秒往堆里灌 308MB。
 *    （store.mjs 里 list() 的注释也在治同一个病：只读头部 4KB 而不是整个文件。）
 *    手机要的是「最近几十条」，读尾部 512KB 足够装下几百条普通消息。
 *
 * ★ 代价说清楚：如果最后一条消息本身就超过 tailBytes，它会读不全 ——
 *   给一个 badLine 计数让调用方知道「尾部第一行是断的，丢了」，不静默假装完整。
 * ★ utf8 从中间切会切出替换字符：因为丢掉的正是第一行，所以不影响后面那些完整行。
 */
export function tailFrames(file, maxBytes) {
  const st = fs.statSync(file);
  const from = Math.max(0, st.size - Math.max(4096, maxBytes | 0));
  const len = st.size - from;
  if (len <= 0) return { frames: [], truncatedHead: false, badLines: 0 };

  const buf = Buffer.allocUnsafe(len);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, len, from); } finally { fs.closeSync(fd); }

  let text = buf.toString('utf8');
  let truncatedHead = false;
  if (from > 0) {
    const nl = text.indexOf('\n');
    if (nl < 0) return { frames: [], truncatedHead: true, badLines: 0 };
    text = text.slice(nl + 1);       // 第一行是半截的，扔掉
    truncatedHead = true;
  }
  const frames = [];
  let badLines = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { frames.push(JSON.parse(line)); } catch { badLines++; }
  }
  return { frames, truncatedHead, badLines };
}

/**
 * 选一个会话。三级优先：?session= → config.chat.session → 最近 mtime 的那个。
 *
 * ★ 为什么最后一级是「最近 mtime」而不是「第一个」：store.list() 本来就按 mtime 倒序，
 *   而手机要看的正是「刚刚说过话的那条」。不用问用户，猜错了他也能用 ?session= 指定。
 * ★ 校验只用 stat，不 load —— 理由同上。
 */
export function resolveSession(store, want, configured) {
  const has = (id) => {
    if (!id) return false;
    try { return fs.statSync(path.join(store.dir(String(id)), 'frames.jsonl')).isFile(); }
    catch { return false; }
  };
  if (want) {
    return has(want)
      ? { id: String(want), via: 'query' }
      : { id: null, via: 'query', reason: '会话不存在：' + want };
  }
  if (configured) {
    return has(configured)
      ? { id: String(configured), via: 'config' }
      : { id: null, via: 'config', reason: 'config.chat.session 指向的会话不存在：' + configured };
  }
  let metas = [];
  try { metas = store.list(); } catch { metas = []; }
  if (!metas.length) return { id: null, via: 'recent', reason: '还没有任何会话 —— 先在主界面里建一个，再回来' };
  return { id: metas[0].id, via: 'recent', mtime: metas[0].mtime };
}

/** 手机上值得看的帧。tool_call / tool_result 默认不发 —— 手机上那是一堆噪声，不是对话。 */
const PHONE_TYPES = new Set([FRAME.USER, FRAME.ASSISTANT, FRAME.ERROR]);

/** 一帧 → 手机能画的一条。★ 字段名故意用 type（而不是 role）：它就是帧类型，别在中间再发明一层名字。 */
function toItem(f, maxChars) {
  const raw = f.type === FRAME.ERROR ? (f.message || '') : (f.text || '');
  const text = String(raw);
  return {
    seq: f.seq,
    t: f.t,
    type: f.type,
    text: text.length > maxChars ? text.slice(0, maxChars) : text,
    truncated: text.length > maxChars,
    ...(f.type === FRAME.USER ? { mine: true } : {}),
  };
}

/**
 * 从尾部帧里挑出要发的一页。
 * @param after 只发 seq > after（增量轮询用）
 * @param before 只发 seq < before（往上翻历史用），取最后 limit 条
 */
function pickItems(frames, { limit, after, before, raw, maxChars }) {
  const pool = frames.filter((f) => (raw ? true : PHONE_TYPES.has(f.type)));
  let picked;
  if (after != null) picked = pool.filter((f) => f.seq > after);
  else if (before != null) picked = pool.filter((f) => f.seq < before).slice(-limit);
  else picked = pool.slice(-limit);
  return picked.map((f) => toItem(f, maxChars));
}

// ═══════════════════════════════════════════════════════════════════════════
// HTTP 小工具
// ═══════════════════════════════════════════════════════════════════════════

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

/**
 * 读 JSON 请求体，带上限。
 * ★ 为什么要有上限：这是**没有认证**的端口。一个不离手的 60MB 上传能把进程的堆按秒撑爆，
 *   而这条通道本来只需要装一条聊天消息。超了直接 413，不给「慢慢读完再判断」的机会。
 * ★ destroy 之后 'end' 不会再触发，所以用 settled 标记保证只 resolve 一次。
 */
function readJsonBody(req, maxBytes) {
  return new Promise((resolve) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    req.on('data', (c) => {
      if (settled) return;
      size += c.length;
      // ★ 不能 req.destroy()：那是在**写响应之前**把 socket 掐了，客户端只会看到「网络错误」，
      //   而它需要知道的恰恰是「太大了」。先停读（pause，靠背压让对端自己憋住），
      //   再回一个带 Connection: close 的 413 —— 这一条是自检实跑抓出来的。
      if (size > maxBytes) {
        done({ error: 'BODY_TOO_LARGE', bytes: size, limit: maxBytes });
        try { req.pause(); } catch {}
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return done({ error: 'EMPTY_BODY' });
      try { done({ value: JSON.parse(raw) }); } catch (e) { done({ error: 'BAD_JSON', message: String((e && e.message) || e) }); }
    });
    req.on('error', () => done({ error: 'READ_ERROR' }));
  });
}

/** 局域网地址 —— 手机要手打这个，所以必须在启动日志和 status 里给出来，不能让他自己去 ipconfig 查。 */
export function lanUrls(port) {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a && a.family === 'IPv4' && !a.internal) out.push('http://' + a.address + ':' + port + '/');
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// 投递：把一条消息放进会话，再叫 agent 循环把它消化掉
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 每个会话一条串行队列。
 *
 * ★ 为什么必须串行：同一个会话同时跑两个 turn，两边各自读「最近 N 帧」再各自 append，
 *   帧序会交错（user, user, assistant, assistant），而 #framesToMessages 是按顺序喂给模型的 ——
 *   两个答案会互相看不见对方那半句上下文。手机连点两下就会踩到。
 * ★ 为什么排队而不是拒绝：手机上连发两条是常态（想到就发），拒一条他就得重打。
 *   队列满（默认 8）才拒，拒的时候明说「没存」—— 不能既没跑又让人以为跑了。
 */
function makeTurnQueue({ store, loop, onError }) {
  const running = new Map();   // sid -> Promise
  const pending = new Map();   // sid -> string[]
  const MAXPENDING = 8;

  const runOne = async (sid, text) => {
    try {
      await loop.turn(sid, () => {});
      return { ok: true };
    } catch (e) {
      const msg = String((e && e.message) || e);
      try { store.append(sid, FRAME.ERROR, { message: '手机通道投递失败：' + msg }); } catch {}
      onError && onError(msg);
      return { ok: false, error: msg };
    }
  };

  const drain = (sid) => {
    const q = pending.get(sid) || [];
    if (!q.length) { pending.delete(sid); running.delete(sid); return; }
    const next = q.shift();
    if (!q.length) pending.delete(sid);
    const p = runOne(sid, next).finally(() => drain(sid));
    running.set(sid, p);
  };

  return {
    /** @returns {{state:'started'|'queued'|'rejected', pending:number}} */
    push(sid, text) {
      if (running.has(sid)) {
        const q = pending.get(sid) || [];
        if (q.length >= MAXPENDING) return { state: 'rejected', pending: q.length, limit: MAXPENDING };
        q.push(text);
        pending.set(sid, q);
        return { state: 'queued', pending: q.length };
      }
      const p = runOne(sid, text).finally(() => drain(sid));
      running.set(sid, p);
      return { state: 'started', pending: 0 };
    },
    busy(sid) { return running.has(sid); },
    /** 自检要能等「投递真的跑完」—— 不给它一个钩子就只能 sleep，那是猜。 */
    async idle(sid) {
      for (let i = 0; i < 600; i++) {
        if (!running.has(sid)) return true;
        await new Promise((r) => setTimeout(r, 25));
      }
      return false;
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 服务
// ═══════════════════════════════════════════════════════════════════════════

/** 老版有、这一版刻意关掉的路由 —— 回 410 而不是 404，「不做」和「没有」要分得开。 */
const REMOVED = new Map([
  ['/api/upload', '上传（老版走 base64 写进 70-收到）'],
  ['/api/file', '取文件（电脑 → 手机）'],
  ['/api/received', '列 70-收到 目录'],
  ['/api/audio', '语音文件'],
  ['/api/tts', '语音合成'],
  ['/api/tts/health', '语音服务健康检查'],
  ['/api/inbox', '老版的内存收件箱（这一版直接读会话本身，不再另存一份）'],
  ['/api/probe', '服务方法探测（插件期工具）'],
  ['/api/dig', '对象结构探测（插件期工具）'],
]);

export function createMobileServer({ store, loop, config, log = () => {} }) {
  const S = chatSettings(config);
  const queue = loop && typeof loop.turn === 'function' ? makeTurnQueue({ store, loop, onError: (m) => log('turn 失败：' + m) }) : null;
  const state = {
    startedAt: new Date().toISOString(),
    sends: 0,
    turnsStarted: 0,
    turnErrors: 0,
    lastSendAt: null,
    lastSendSeq: null,
    lastError: null,
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://' + (req.headers.host || 'phone.local'));
    const p = url.pathname;

    try {
      // —— 手机页：每次请求重新读盘 ⇒ 改页面不用重启 ——
      // （老版这条经验保留：改 HTML 要重启一次服务，体验差得离谱。）
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        let html;
        try { html = fs.readFileSync(PHONE_HTML, 'utf8'); }
        catch (e) {
          return json(res, 500, {
            ok: false, error: 'MOBILE_PAGE_MISSING',
            path: 'src/web/phone.html', detail: String((e && e.message) || e),
            hint: '页面文件和 src/chat/mobile.mjs 是配套的，缺一个这个端口就只剩 JSON 接口。',
          });
        }
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(html),
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
        });
        return res.end(html);
      }

      // —— 最近的消息 ——
      if (p === '/api/recent' && req.method === 'GET') {
        const r = resolveSession(store, url.searchParams.get('session'), S.session);
        if (!r.id) {
          return json(res, 200, {
            ok: true, session: null, items: [], hasMore: false,
            hint: r.reason || '没有可读的会话',
            howToFix: '在主界面里发一句话就有会话了；或在 config.json 写 "chat": { "session": "<会话 id>" }',
          });
        }
        const file = path.join(store.dir(r.id), 'frames.jsonl');
        const tail = tailFrames(file, S.tailBytes);
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || S.recentLimit));
        const afterRaw = url.searchParams.get('after');
        const beforeRaw = url.searchParams.get('before');
        const after = afterRaw != null && afterRaw !== '' ? Number(afterRaw) : null;
        const before = beforeRaw != null && beforeRaw !== '' ? Number(beforeRaw) : null;
        const items = pickItems(tail.frames, {
          limit, after: Number.isFinite(after) ? after : null, before: Number.isFinite(before) ? before : null,
          raw: url.searchParams.get('raw') === '1', maxChars: S.maxTextChars,
        });
        const oldest = tail.frames.length ? tail.frames[0].seq : 0;
        return json(res, 200, {
          ok: true,
          session: r.id,
          via: r.via,
          items,
          count: items.length,
          // ★ 只要第一帧的 seq > 1，上面就一定还有（可能是被 tailBytes 截掉的，也可能是被 limit 挡住的）。
          //   不去区分这两者：「上面还有更早的」对页面是同一件事 —— 往上翻，翻到没有为止。
          hasMore: oldest > 1,
          tail: { truncatedHead: tail.truncatedHead, badLines: tail.badLines, bytes: S.tailBytes },
        });
      }

      // —— 发一条 ——
      if (p === '/api/send' && req.method === 'POST') {
        // ★ CSRF：别的网页可以让你的浏览器往这里 POST（form 提交不需要同源，只是读不到响应）。
        //   而这条路由是能叫醒 agent 的 —— 不是「读」，是「动」。
        //   所以这里挡一道：Origin 存在且不同源 → 403。
        //   它不是完整鉴权（curl 照样能发，本来就说明了没有认证），
        //   它挡的是「你随手打开一个网页，那个网页替我发了条消息」。
        const origin = req.headers.origin;
        if (origin) {
          const host = req.headers.host || '';
          if (origin !== 'http://' + host && origin !== 'https://' + host) {
            return json(res, 403, {
              ok: false, error: 'CROSS_ORIGIN',
              hint: '这个端口只接受本页面自己发来的 POST。要手动调用请用 curl（它不带 Origin）。',
            });
          }
        }

        const r0 = resolveSession(store, url.searchParams.get('session'), S.session);
        if (!r0.id) {
          return json(res, 409, { ok: false, error: 'NO_SESSION', hint: r0.reason || '没有可写的会话' });
        }

        const body = await readJsonBody(req, S.maxBodyBytes);
        if (body.error === 'BODY_TOO_LARGE') {
          res.setHeader('Connection', 'close');   // 体没读完，这条连接不能复用
          return json(res, 413, {
            ok: false, error: 'BODY_TOO_LARGE', bytes: body.bytes, limit: body.limit,
            hint: '这条通道只收聊天消息，上限 ' + body.limit + ' 字节。文件不走这里 —— 这个端口刻意不提供文件上传。',
          });
        }
        if (body.error) return json(res, 400, { ok: false, error: body.error, detail: body.message });

        const text = String((body.value && body.value.text) || '').trim();
        if (!text) return json(res, 400, { ok: false, error: 'EMPTY_TEXT', hint: 'text 不能为空' });

        let frame;
        try {
          frame = store.append(r0.id, FRAME.USER, { text });
        } catch (e) {
          return json(res, 500, { ok: false, error: 'APPEND_FAILED', detail: String((e && e.message) || e), hint: '消息没写进会话 —— 这次发送真的失败了，可以重试。' });
        }

        state.sends++;
        state.lastSendAt = new Date().toISOString();
        state.lastSendSeq = frame.seq;

        // ★ 没有 loop 时**不假装投进去了**。老版在这一步上栽过：一条非法消息被塞进运行中的会话，
        //   返回 undefined 被当成成功，真正的代价是目标会话那一轮直接失败。
        if (!queue) {
          return json(res, 200, {
            ok: true, stored: true, turned: false, seq: frame.seq, session: r0.id,
            hint: '消息已存进会话，但这里没有接 agent 循环（没注入 loop），所以不会有回复。',
          });
        }

        const q = queue.push(r0.id, text);
        if (q.state === 'rejected') {
          return json(res, 429, {
            ok: false, error: 'QUEUE_FULL', pending: q.pending, limit: q.limit,
            hint: '这个会话还有 ' + q.pending + ' 条没跑完。这条**没有存**，等一会儿再发。',
          });
        }
        state.turnsStarted++;
        return json(res, 200, {
          ok: true, stored: true, turned: true, turn: q.state, pending: q.pending,
          seq: frame.seq, session: r0.id,
          ...(q.state === 'queued' ? { hint: '上一轮还在跑，这条排在第 ' + q.pending + ' 个；它的内容已经进会话，前一轮结束后就会轮到自己。' } : {}),
        });
      }

      // —— 状态：这一页能看见自己的边界 ——
      if (p === '/api/status' && req.method === 'GET') {
        const addr = server.address() || {};
        return json(res, 200, {
          ok: true,
          service: 'agent-soul mobile chat',
          at: new Date().toISOString(),
          startedAt: state.startedAt,
          uptimeSec: Math.round(process.uptime()),
          bind: { host: addr.address || S.host, port: addr.port != null ? addr.port : S.port, sources: S.sources },
          urls: lanUrls(addr.port != null ? addr.port : S.port),
          auth: { enabled: false, note: '没有认证，也没有打算加。见 howToDisable 与 exposure。' },
          exposure: [
            '读最近的消息（当前会话）',
            '发一条消息（会叫醒 agent 循环，agent 有自己的工具）',
          ],
          notProvided: [
            '文件读写 / 上传 / 下载', '命令执行', '语音合成与音频',
            '改配置', '列会话目录', '写指定会话以外的任何会话',
          ],
          howToDisable: 'config.json 里写 "chat": { "enabled": false }，或设环境变量 AGENT_SOUL_CHAT=off，然后重启（这个键在设置面板里看不见，见 src/chat/README.md）',
          routes: ['GET /', 'GET /api/recent', 'POST /api/send', 'GET /api/status'],
          stats: {
            sends: state.sends, turnsStarted: state.turnsStarted, turnErrors: state.turnErrors,
            lastSendAt: state.lastSendAt, lastSendSeq: state.lastSendSeq, lastError: state.lastError,
            loopAttached: Boolean(queue),
          },
          settings: {
            session: S.session, recentLimit: S.recentLimit,
            maxTextChars: S.maxTextChars, maxBodyBytes: S.maxBodyBytes, tailBytes: S.tailBytes,
          },
        });
      }

      // —— 刻意关掉的老路由 ——
      if (REMOVED.has(p)) {
        return json(res, 410, {
          ok: false, error: 'GONE', route: p, was: REMOVED.get(p),
          hint: '这个能力在这一版是**刻意不做**，不是还没做。它会把「无认证的局域网端口」变成文件/执行入口。',
        });
      }

      return json(res, 404, {
        ok: false, error: 'NO_ROUTE', path: p,
        routes: ['GET /', 'GET /api/recent', 'POST /api/send', 'GET /api/status'],
      });
    } catch (e) {
      const msg = String((e && e.message) || e);
      try { log('handler 异常：' + msg); } catch {}
      if (!res.headersSent) return json(res, 500, { ok: false, error: 'INTERNAL', detail: msg });
      try { res.end(); } catch {}
    }
  });

  // 自检需要它；也给将来接进 index.mjs 用
  server.chatState = () => ({ ...state, settings: S });
  server.chatQueue = queue;
  server.chatSettings = S;
  return server;
}

/**
 * 绑完自问一句：「刚才那个 0.0.0.0 真的在收流量吗？」
 *
 * ★★★ 为什么必须有这一步（2026-11-07 实测踩到）：
 *   **Windows 允许 0.0.0.0:P 与 127.0.0.1:P 同时 bind**，而某个地址上更具体的那个监听
 *   会优先接走本机连接。于是会发生最难查的那种事：
 *   - 手机（走局域网 IP）连到**我**，一切正常；
 *   - 电脑上打开 127.0.0.1:P 看到的是**别人的页面**（实测 8899 被老版 TTS 服务占着，
 *     回的是 {"ok":false,"err":"not found"}）。
 *   本机看着坏了、手机看着好了 —— 或者反过来，谁都不会想到是"两个进程绑了同一个端口号"。
 *
 *   所以这里用 127.0.0.1 打自己一刀：应答里没有自己那个 service 标记 → 说出来。
 *   ★ 只警告、不阻断：手机那条路确实还能用，硬失败反而是把能用的东西一起关掉。
 */
async function verifyMyself(port) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(); } catch {} }, 900);
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/api/status', { signal: ctrl.signal });
    const j = await r.json().catch(() => null);
    const mine = Boolean(j && j.service === 'agent-soul mobile chat');
    return {
      ok: mine, ms: Date.now() - t0, status: r.status,
      answeredBy: mine ? 'self' : ((j && (j.service || j.err || j.error)) || 'unknown'),
      ...(mine ? {} : {
        hint: '127.0.0.1:' + port + ' 上没有我的应答。多半是另一个进程绑了 127.0.0.1:' + port +
          '（Windows 允许它和 0.0.0.0:' + port + ' 共存，且更具体的那个先接本机连接）。' +
          '换端口最省事：config.chat.port 或 AGENT_SOUL_CHAT_PORT。手机走局域网地址不受影响。',
      }),
    };
  } catch (e) {
    return {
      ok: false, ms: Date.now() - t0,
      error: String((e && e.message) || e),
      hint: '从 127.0.0.1 连不上自己。可能是本机防火墙拦了回环，也可能是端口被别人抢了。手机侧仍可能连得上。',
    };
  } finally { clearTimeout(timer); }
}

/**
 * 起这个监听。
 * ★ 为什么单独立一个函数而不是让调用方自己 listen：要在返回之前就知道
 *   「端口被占了」还是「起来了」。异步 listen 的错误不接住的话，会变成进程级的 uncaught。
 *   ★ 端口冲突在手机这个场景特别常见 —— 老插件可能还在跑同一个 8898。
 *   这里把 EADDRINUSE 翻成一句人话，让调用方能直接报给用户。
 */
export async function startMobileChat({ store, loop, config, log = () => {}, port, host } = {}) {
  const S = chatSettings(config);
  if (port) S.port = Number(port);
  if (host) S.host = host;
  if (!S.enabled) {
    return { started: false, reason: 'OFF_BY_CONFIG', settings: S, hint: 'config.chat.enabled=false 或 AGENT_SOUL_CHAT=off —— 手机通道没起。' };
  }
  if (!store) {
    return { started: false, reason: 'NO_STORE', settings: S, hint: '没有 SessionStore 就没法读会话，不起服务。' };
  }
  const server = createMobileServer({ store, loop, config, log });
  await new Promise((resolve, reject) => {
    const onErr = (e) => { server.off('listening', onOk); reject(e); };
    const onOk = () => { server.off('error', onErr); resolve(); };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(S.port, S.host);
  }).catch((e) => {
    const code = (e && e.code) || '';
    if (code === 'EADDRINUSE') {
      const err = new Error('端口 ' + S.port + ' 已被占用（可能是老版 chat 插件还在跑）。改 config.chat.port，或设 AGENT_SOUL_CHAT_PORT。');
      err.code = code;
      throw err;
    }
    if (code === 'EACCES') {
      const err = new Error('没有权限绑 ' + S.host + ':' + S.port + '（' + code + '）。换个端口，或检查防火墙/保留端口。');
      err.code = code;
      throw err;
    }
    throw e;
  });
  const addr = server.address();
  // ★ 绑定成功 ≠ 在收流量（见 verifyMyself 的注释）。这一步只花一次本地请求。
  const selfCheck = await verifyMyself(addr.port);
  return {
    started: true, server, settings: S, host: addr.address, port: addr.port,
    urls: lanUrls(addr.port), selfCheck,
    ...(selfCheck.ok ? {} : { warning: selfCheck.hint }),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 独立起法：node src/chat/mobile.mjs [--port 8898] [--host 0.0.0.0]
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 单独跑起来的入口。
 *
 * ★ 为什么不写成「必须由 index.mjs 起」：手机通道要能在主程序没开的时候单独调。
 *   ★ 但两个进程同时写同一个会话目录是有代价的（store 里那个 stamp 检测就是为这个留的）——
 *   所以这里会**打印一行警告**，告诉使用者「主程序如果在跑，两边一起写同一个会话会出现帧序交错」。
 *   ★ 接线到 index.mjs 只要一行：见 src/chat/README.md「怎么接进主进程」。
 */
async function main() {
  const argv = process.argv.slice(2);
  const arg = (name, dflt) => {
    const i = argv.indexOf('--' + name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
  };
  const { loadConfig } = await import('../config.mjs');
  const { SessionStore } = await import('../session/store.mjs');
  const { LlmClient } = await import('../llm/client.mjs');
  const { ToolRegistry } = await import('../tools/registry.mjs');
  const { AgentLoop } = await import('../agent/loop.mjs');

  const config = loadConfig();
  const store = new SessionStore(config.dataDir);
  const tools = new ToolRegistry();
  const llm = new LlmClient(config.llm);
  const loop = new AgentLoop({ store, llm, tools, config });

  const hasKey = Boolean(config.llm && config.llm.apiKey);
  const r = await startMobileChat({
    store, loop, config,
    port: arg('port'), host: arg('host'),
    log: (m) => console.log('[chat] ' + m),
  });
  if (!r.started) {
    console.log('[chat] 没起：' + r.reason + (r.hint ? ' —— ' + r.hint : ''));
    process.exit(0);
  }

  console.log('[chat] 手机通道已监听 ' + r.host + ':' + r.port + '  （0.0.0.0 才是重点：127.0.0.1 手机连不上）');
  console.log('[chat] 手机上打开：' + (r.urls[0] || 'http://<本机局域网IP>:' + r.port + '/'));
  console.log('[chat] ★ 无认证：局域网内任何设备都能读最近的对话、发消息');
  console.log('[chat] ★ 不给文件、不给执行；关掉：config.json 的 chat.enabled=false 或 AGENT_SOUL_CHAT=off');
  console.log('[chat] agent 循环：' + (hasKey ? '已接（轮次会真的调用模型）' : '已接但**没有 API key** —— 消息会存进会话，模型调用会失败并落一条 error 帧'));
  if (r.selfCheck && r.selfCheck.ok) console.log('[chat] 自证：127.0.0.1:' + r.port + ' 应答的是我自己（' + r.selfCheck.ms + 'ms）');
  else console.log('[chat] ★★ 警告：' + ((r.selfCheck && r.selfCheck.hint) || (r.warning || '本机自证失败')));

  const bye = () => { try { store.closeAll(); } catch {} process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

const isMain = (() => {
  try { return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
})();
if (isMain) {
  main().catch((e) => {
    console.error('[chat] 起不来：' + String((e && e.message) || e));
    process.exit(1);
  });
}
