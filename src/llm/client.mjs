// LLM 客户端 —— 双协议：OpenAI Chat Completions 与 Anthropic Messages
//
// ★ 1.0.2 起支持两种协议（原来只有 OpenAI 兼容一种）：
//     protocol=openai      POST <base>/chat/completions      （老路径，行为一字不改）
//     protocol=anthropic   POST <base>/v1/messages           （x-api-key + anthropic-version）
//
// ★ 为什么必须把 tools 映射完整而不是「先跑起来」：
//   本项目的一轮对话**真的会调工具**（agent/loop.mjs: 拿到 toolCalls 就执行再回灌）。
//   如果 Anthropic 分支只解析文本、不解析 tool_use / tool_result，模型就永远调不动工具 ——
//   那不是「支持了一部分」，是把核心功能悄悄摘掉。所以这里三件事都实现：
//     · tools → { name, description, input_schema }
//     · assistant.tool_calls → content blocks [{type:'tool_use'}]
//     · role:'tool' → user 消息里的 [{type:'tool_result', tool_use_id}]
//   ★ 并且：**未知协议直接报错**，不做「猜一个继续跑」的降级。

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 官方默认地址：两个协议的默认值**不同**，Anthropic 必须带 /anthropic 后缀。 */
/**
 * 换气掐断信号（2026-11-13）。
 *
 * ★ 为什么要有专门的类型，而不是随便 throw 一个 Error：
 *   `chatRetry` 的错误处理是「能重试就重试」的 —— 而掐断是一种**主动决定不要这次结果**，
 *   重试等于把同一段被污染的上下文再喂一遍（v3 README：比循环本身更糟）。
 *   所以给它一个能被 `catch` 认出来的记号，让重试逻辑主动让路。
 *
 * ★ `partial` 是**掐断前已经累积的部分内容** —— 不丢，留给调用方决定要不要落盘：
 *   「切了但留下了什么痕迹」比「干净地切了」更有用。
 */
export class HuanqiBreak extends Error {
  constructor (info) {
    const i = info || {}
    super('换气掐断：' + (i.reason || '推理在收敛') + '（' + (i.chars || 0) + ' 字符）')
    this.name = 'HuanqiBreak'
    this.__huanqiBreak = true
    this.detail = i
  }
}

export const DEFAULT_BASE = {
  openai: 'https://api.deepseek.com',
  anthropic: 'https://api.deepseek.com/anthropic',
};

/** Anthropic Messages API 要求这个版本头，且是必填。 */
export const ANTHROPIC_VERSION = '2023-06-01';

// ★ 2026-11-10（概览状态面板）：运行统计里要放「最近一次错误」，而错误文本的来路不可控
//   （供应商回体、网关回体、fetch 自己抛）。**统计不是日志**：它会被送到浏览器。
//   所以进 stat 之前先脱一层敏 —— 这里面没有一个字该是凭据。
const REDACT_RULES = [
  [/bearer\s+[A-Za-z0-9._\-]{6,}/gi, 'Bearer ***'],
  [/\b(?:sk|rk|pk)-[A-Za-z0-9._\-]{6,}/g, 'key-***'],
  [/\b(api[_-]?key|token|secret|password|passwd)\s*[=:]\s*[^\s,;'"}]+/gi, '$1=***'],
  [/https?:\/\/[^/\s@]+@/g, 'http://***@'],
];
function safeErrorText(e) {
  let s = String((e && e.message) || e || '未知错误');
  for (const [re, rep] of REDACT_RULES) s = s.replace(re, rep);
  return s.slice(0, 300);
}

/**
 * 协议名归一化。
 * ★ 不认识的写法**抛错**（不静默退回 openai）—— 配错协议却照样发出去，
 *   排障时看到的会是「401」而不是「你协议写错了」，那是更贵的一种错。
 */
export function normalizeProtocol(p) {
  const s = String(p == null ? '' : p).trim().toLowerCase();
  if (!s) return 'openai';
  if (s === 'openai' || s === 'openai-chat' || s === 'chat-completions' || s === 'openai-completions') return 'openai';
  if (s === 'anthropic' || s === 'anthropic-messages' || s === 'messages' || s === 'claude') return 'anthropic';
  throw new Error('未知协议：' + p + '（只支持 openai / anthropic）');
}

/**
 * 地址规范化：去尾斜杠、去掉「用户把端点整条粘进来」造成的重复。
 * ★ 用户常见的两种写法都要能吃下：
 *     https://api.deepseek.com/chat/completions   → https://api.deepseek.com
 *     https://api.deepseek.com/anthropic/v1/messages → https://api.deepseek.com/anthropic
 *   留空 = 用该协议的官方默认地址。
 */
export function normalizeBaseUrl(baseUrl, protocol) {
  const p = normalizeProtocol(protocol);
  let s = String(baseUrl == null ? '' : baseUrl).trim();
  if (!s) return DEFAULT_BASE[p];
  s = s.replace(/\/+$/, '');
  if (p === 'anthropic') {
    s = s.replace(/\/v1\/messages$/i, '');
    s = s.replace(/\/messages$/i, '');
    s = s.replace(/\/v1$/i, '');
  } else {
    s = s.replace(/\/chat\/completions$/i, '');
    s = s.replace(/\/v1\/chat\/completions$/i, '/v1');
  }
  return s.replace(/\/+$/, '');
}

/** 一次 SSE 读取：把 "event: x / data: {...}" 拆成 { event, data }。 */
async function* sseEvents(resp) {
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let ev = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      let line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') { ev = ''; continue; }
      if (line.startsWith('event:')) { ev = line.slice(6).trim(); continue; }
      if (line.startsWith('data:')) { yield { event: ev, data: line.slice(5).trim() }; continue; }
      // id: / retry: / 注释行 —— 与本项目无关，丢掉
    }
  }
}

/**
 * OpenAI 形状的 messages → Anthropic 的 { system, messages }。
 * ★ 两条硬规则（Anthropic 文档要求）：
 *   ① system 不是一条 message，是顶层字段；
 *   ② 相邻同角色消息必须合并（tool_result 尤其如此，否则 400）。
 */
export function toAnthropicMessages(messages) {
  const sysParts = [];
  const out = [];
  const push = (role, blocks) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) { last.content = last.content.concat(blocks); return; }
    out.push({ role, content: blocks });
  };

  for (const m of (messages || [])) {
    if (!m) continue;
    if (m.role === 'system') { if (m.content) sysParts.push(String(m.content)); continue; }

    if (m.role === 'assistant') {
      const blocks = [];
      const t = typeof m.content === 'string' ? m.content : '';
      if (t) blocks.push({ type: 'text', text: t });
      for (const c of (Array.isArray(m.tool_calls) ? m.tool_calls : [])) {
        const fn = (c && c.function) || {};
        let input = {};
        try { input = fn.arguments ? JSON.parse(fn.arguments) : {}; }
        catch { input = { __raw: String(fn.arguments || '') }; }
        blocks.push({
          type: 'tool_use',
          id: c.id || ('toolu_' + Math.random().toString(36).slice(2, 12)),
          name: fn.name || '',
          input,
        });
      }
      push('assistant', blocks);
      continue;
    }

    if (m.role === 'tool') {
      push('user', [{
        type: 'tool_result',
        tool_use_id: m.tool_call_id || '',
        content: String(m.content == null ? '' : m.content),
      }]);
      continue;
    }

    const t = typeof m.content === 'string' ? m.content : '';
    if (t) push('user', [{ type: 'text', text: t }]);
  }

  // Anthropic 要求第一条是 user
  if (out.length && out[0].role !== 'user') {
    out.unshift({ role: 'user', content: [{ type: 'text', text: '（会话开始）' }] });
  }
  return { system: sysParts.join('\n\n'), messages: out };
}

/** OpenAI 形状的 tools → Anthropic 的 { name, description, input_schema }。 */
export function toAnthropicTools(tools) {
  const out = [];
  for (const t of (tools || [])) {
    if (!t) continue;
    const fn = t.function || t;
    if (!fn.name) continue;
    out.push({
      name: fn.name,
      description: fn.description || '',
      input_schema: fn.parameters || fn.input_schema || { type: 'object', properties: {} },
    });
  }
  return out;
}

export class LlmClient {
  /**
   * @param protocol   'openai' | 'anthropic'（默认 openai）
   * @param authStyle  Anthropic 的鉴权头：'both'(默认) | 'x-api-key' | 'bearer'
   *                   ★ 两种都被 DeepSeek 的 /anthropic 接受；默认两条都发，
   *                     这样自建网关只认其中一种时也不用改配置。
   * @param stream     默认 true；false 时走非流式（验收里两条路都要能跑）
   */
  constructor(opts) {
    const o = opts || {};
    this.protocol = normalizeProtocol(o.protocol);
    this.baseUrl = normalizeBaseUrl(o.baseUrl, this.protocol);
    this.apiKey = o.apiKey || '';
    this.model = o.model || 'deepseek-chat';
    this.maxTokens = o.maxTokens == null ? 4096 : o.maxTokens;
    this.temperature = o.temperature == null ? 0.7 : o.temperature;
    this.authStyle = String(o.authStyle || 'both').toLowerCase();
    this.stream = o.stream !== false;

    // ★ 2026-11-10（概览状态面板）：进程内运行统计，**只读、不落盘、不含秘密**。
    //   为什么放客户端自己身上：调用次数/失败/耗时只有这里知道；从外面数必然少一环
    //   （chatRetry 会重试，重试也是一次真实调用）。
    //   ★ usage 只收协议**自己回**的那份：拿不到就 null，面板写 unavailable —— 不拿 0 顶。
    this.stat = {
      callSeq: 0,          // 本次调用序号（usage 分片要靠它认出「这是同一次调用」）
      calls: 0,
      failures: 0,
      lastCallAt: null,    // ISO
      lastOkAt: null,      // ISO
      lastLatencyMs: null,
      lastError: null,     // 已脱敏，≤300
      lastErrorAt: null,   // ISO
      usage: null,         // { protocol, promptTokens, completionTokens, cacheReadTokens, totalTokens, at }
      usageSeq: 0,
    };
  }

  ready() { return Boolean(this.baseUrl && this.apiKey); }

  /**
   * 只读运行统计 —— 面板 / 接口唯一的取数口。
   * ★ 里面没有 key、没有鉴权头、没有 baseUrl 的查询串：只有数量、时刻、耗时、脱敏错误与 usage。
   * ★ usage 拿不到时给 `status:'unavailable'`，**不是 0** —— 0 token 是另一件事。
   */
  stats() {
    const u = this.stat.usage;
    return {
      ready: this.ready(),
      protocol: this.protocol,
      model: this.model,
      calls: this.stat.calls,
      failures: this.stat.failures,
      lastCallAt: this.stat.lastCallAt,
      lastOkAt: this.stat.lastOkAt,
      lastLatencyMs: this.stat.lastLatencyMs,
      lastError: this.stat.lastError,
      lastErrorAt: this.stat.lastErrorAt,
      usage: u
        ? { status: 'ok', protocol: u.protocol, promptTokens: u.promptTokens, completionTokens: u.completionTokens,
            cacheReadTokens: u.cacheReadTokens, totalTokens: u.totalTokens, at: u.at }
        : { status: 'unavailable', reason: '还没有拿到过 usage（协议没回这个字段）' },
    };
  }

  /**
   * 记一次协议回传的 usage。
   * ★ 两种协议的形状不同，字段名也不同，所以**在同一处映射**：
   *     OpenAI     { prompt_tokens, completion_tokens, total_tokens, prompt_tokens_details.cached_tokens }
   *     Anthropic  { input_tokens, output_tokens, cache_read_input_tokens }（message_start 给 input，
   *                message_delta 给 output —— 所以必须**合并**，后到的不许把先到的冲成 null）
   * ★ 只有真拿到数才算「拿到了」：全空对象不覆盖上一次读数。
   */
  #recordUsage(protocol, raw) {
    if (!raw || typeof raw !== 'object') return;
    const pick = (...vals) => { for (const v of vals) if (Number.isFinite(v)) return v; return null; };
    const prompt = pick(raw.prompt_tokens, raw.input_tokens);
    const completion = pick(raw.completion_tokens, raw.output_tokens);
    const cacheRead = pick(
      raw.cache_read_input_tokens,
      raw.prompt_cache_hit_tokens,
      raw.prompt_tokens_details && raw.prompt_tokens_details.cached_tokens,
      raw.cache_creation_input_tokens,
    );
    const total = pick(raw.total_tokens);
    if (prompt == null && completion == null && total == null) return;

    const seq = this.stat.callSeq;
    const prev = (this.stat.usage && this.stat.usageSeq === seq) ? this.stat.usage : null;
    const p = prompt != null ? prompt : (prev ? prev.promptTokens : null);
    const c = completion != null ? completion : (prev ? prev.completionTokens : null);
    this.stat.usage = {
      protocol,
      promptTokens: p,
      completionTokens: c,
      cacheReadTokens: cacheRead != null ? cacheRead : (prev ? prev.cacheReadTokens : null),
      totalTokens: total != null ? total : ((p != null && c != null) ? p + c : (prev ? prev.totalTokens : null)),
      at: new Date().toISOString(),
    };
    this.stat.usageSeq = seq;
  }

  /** 本次会用到的端点（排障/验收里要能直接看到） */
  endpoint() {
    if (this.protocol === 'anthropic') {
      return this.baseUrl + (this.baseUrl.endsWith('/v1') ? '/messages' : '/v1/messages');
    }
    return this.baseUrl + '/chat/completions';
  }

  headers() {
    if (this.protocol === 'anthropic') {
      const h = {
        'content-type': 'application/json',
        'anthropic-version': ANTHROPIC_VERSION,
      };
      if (this.authStyle !== 'bearer') h['x-api-key'] = this.apiKey;
      if (this.authStyle !== 'x-api-key') h['authorization'] = 'Bearer ' + this.apiKey;
      return h;
    }
    // ★ OpenAI 分支的 header 与 1.0.1 逐字一致 —— 生产兼容优先
    return {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + this.apiKey,
    };
  }

  /**
   * 一次调用。
   * @param messages  OpenAI 格式的消息数组
   * @param tools     工具 spec 数组（可为空）
   * @param onDelta   流式回调 (chunk) => void，chunk = { type:'text'|'reasoning', delta }
   * @returns { text, reasoning, toolCalls: [{id,name,args}] }
   */
  async chat(messages, tools, onDelta) {
    // ★ 2026-11-10：统计只包在这一层 —— 协议分支（含流式解析）一个字都没改。
    //   ★ 失败也要计耗时与错误：**失败的调用同样是调用**，不记它，面板就会在「一直报错」时显示 0 次。
    const t0 = Date.now();
    this.stat.callSeq++;
    this.stat.calls++;
    this.stat.lastCallAt = new Date(t0).toISOString();
    try {
      if (!this.ready()) throw new Error('LLM 未配置：缺 baseUrl 或 apiKey');
      const r = this.protocol === 'anthropic'
        ? await this.#chatAnthropic(messages, tools, onDelta)
        : await this.#chatOpenAI(messages, tools, onDelta);
      this.stat.lastLatencyMs = Date.now() - t0;
      this.stat.lastOkAt = new Date().toISOString();
      return r;
    } catch (e) {
      this.stat.failures++;
      this.stat.lastLatencyMs = Date.now() - t0;
      this.stat.lastError = safeErrorText(e);
      this.stat.lastErrorAt = new Date().toISOString();
      throw e;
    }
  }

  // ── OpenAI 兼容（1.0.1 的老路径，逻辑不动） ──────────────────────────────
  async #chatOpenAI(messages, tools, onDelta) {
    const body = {
      model: this.model,
      messages,
      stream: true,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
    };
    if (tools && tools.length) { body.tools = tools; body.tool_choice = 'auto'; }

    const resp = await fetch(this.endpoint(), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      throw new Error('LLM HTTP ' + resp.status + ': ' + t.slice(0, 500));
    }

    let text = '';
    let reasoning = '';
    const calls = [];   // { id, name, args(string) }

    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });

      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line || !line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;

        let json;
        try { json = JSON.parse(data); } catch { continue; }
        // ★ 2026-11-10：usage 通常挂在最后一个「choices 为空」的块上，所以**先于 choices 判**。
        //   ★ 不改请求体（不加 stream_options.include_usage）：那是改生产行为，
        //     而这一格的职责是「有就读出来，没有就写 unavailable」。
        if (json.usage) this.#recordUsage('openai', json.usage);
        const ch = json.choices && json.choices[0];
        if (!ch) continue;
        const d = ch.delta || {};

        if (d.content) {
          text += d.content;
          if (onDelta) onDelta({ type: 'text', delta: d.content });
        }
        if (d.reasoning_content) {
          reasoning += d.reasoning_content;
          if (onDelta) onDelta({ type: 'reasoning', delta: d.reasoning_content });
        }
        if (Array.isArray(d.tool_calls)) {
          for (const tc of d.tool_calls) {
            const i = typeof tc.index === 'number' ? tc.index : calls.length;
            if (!calls[i]) calls[i] = { id: '', name: '', args: '' };
            if (tc.id) calls[i].id = tc.id;
            if (tc.function && tc.function.name) calls[i].name += tc.function.name;
            if (tc.function && tc.function.arguments) calls[i].args += tc.function.arguments;
          }
        }
      }
    }

    const toolCalls = calls.filter(Boolean).map(c => {
      let args = {};
      try { args = c.args ? JSON.parse(c.args) : {}; } catch { args = { __raw: c.args }; }
      return { id: c.id || ('call_' + Math.random().toString(36).slice(2, 10)), name: c.name, args };
    });

    return { text, reasoning, toolCalls };
  }

  // ── Anthropic Messages ──────────────────────────────────────────────────
  body(messages, tools) {
    const { system, messages: msgs } = toAnthropicMessages(messages);
    const b = {
      model: this.model,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      messages: msgs,
      stream: this.stream,
    };
    if (system) b.system = system;
    const ts = toAnthropicTools(tools);
    if (ts.length) { b.tools = ts; b.tool_choice = { type: 'auto' }; }
    return b;
  }

  async #chatAnthropic(messages, tools, onDelta) {
    const body = this.body(messages, tools);
    const resp = await fetch(this.endpoint(), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      throw new Error('LLM HTTP ' + resp.status + ': ' + t.slice(0, 500));
    }

    if (!this.stream) {
      const j = await resp.json();
      // ★ 2026-11-10：非流式也要收 usage —— 验收里两条路都要能跑。
      this.#recordUsage('anthropic', j && j.usage);
      return fromAnthropicMessage(j, onDelta);
    }

    let text = '';
    let reasoning = '';
    const blocks = new Map();   // index -> { type, id, name, json }

    for await (const frame of sseEvents(resp)) {
      const data = frame.data;
      if (!data || data === '[DONE]') continue;
      let j;
      try { j = JSON.parse(data); } catch { continue; }
      const t = frame.event || j.type || '';

      if (t === 'error') {
        const msg = (j.error && j.error.message) || data;
        throw new Error('LLM 流错误：' + String(msg).slice(0, 300));
      }
      // ★ 2026-11-10：Anthropic 的 usage 分两段到 —— message_start 带 input，
      //   message_delta 带最终 output。#recordUsage 按「同一次调用」合并，不会互相冲掉。
      if (t === 'message_start') {
        this.#recordUsage('anthropic', (j.message && j.message.usage) || j.usage);
        continue;
      }
      if (t === 'message_delta') {
        this.#recordUsage('anthropic', j.usage);
        continue;
      }
      if (t === 'content_block_start') {
        const b = j.content_block || {};
        blocks.set(j.index == null ? blocks.size : j.index, {
          type: b.type || '', id: b.id || '', name: b.name || '', json: '', text: b.text || '',
        });
        if (b.type === 'text' && b.text) {
          text += b.text;
          if (onDelta) onDelta({ type: 'text', delta: b.text });
        }
        continue;
      }
      if (t === 'content_block_delta') {
        const rec = blocks.get(j.index == null ? 0 : j.index);
        if (!rec) continue;
        const d = j.delta || {};
        if (d.type === 'text_delta') {
          const s = d.text || '';
          text += s; rec.text += s;
          if (s && onDelta) onDelta({ type: 'text', delta: s });
        } else if (d.type === 'input_json_delta') {
          rec.json += d.partial_json || '';
        } else if (d.type === 'thinking_delta') {
          const s = d.thinking || '';
          reasoning += s;
          if (s && onDelta) onDelta({ type: 'reasoning', delta: s });
        }
        continue;
      }
      // ★ 2026-11-10：message_start / message_delta 现在要收 usage（见上）。
      //   剩下的 content_block_stop / message_stop / ping 不需要额外动作。
    }

    const toolCalls = [];
    for (const rec of blocks.values()) {
      if (rec.type !== 'tool_use') continue;
      let args = {};
      try { args = rec.json ? JSON.parse(rec.json) : {}; }
      catch { args = { __raw: rec.json }; }
      toolCalls.push({ id: rec.id || ('toolu_' + Math.random().toString(36).slice(2, 10)), name: rec.name, args });
    }
    return { text, reasoning, toolCalls };
  }

  /** 带退避的重试包装 */
  async chatRetry(messages, tools, onDelta, tries = 3) {
    // ★★★ 2026-11-13：**换气掐断不许重试。**
    //   onDelta 里抛 HuanqiBreak 是为了「从流内部切一刀」——
    //   而重试会把同一个请求原样再发一遍（历史完全没变），
    //   v3 的 README 对这件事的判词是：**「把已经退化的模型再喂一遍，比循环本身更糟」**。
    //   所以这里要能在 catch 里认出它，直接结束，不进退避循环。
    let lastErr;
    for (let i = 0; i < tries; i++) {
      try { return await this.chat(messages, tools, onDelta); }
      catch (e) {
        lastErr = e;
        // ★ 换气掐断：**不重试、不等待、原样抛出去**。
        if (e && e.__huanqiBreak) break;
        const msg = String(e && e.message);
        // 4xx 不重试（除了 429）
        if (/HTTP 4\d\d/.test(msg) && !/HTTP 429/.test(msg)) break;
        await sleep(400 * Math.pow(2, i));
      }
    }
    throw lastErr;
  }
}

/** 非流式 Anthropic 响应 → 与流式同一个返回形状 */
export function fromAnthropicMessage(j, onDelta) {
  let text = '';
  let reasoning = '';
  const toolCalls = [];
  for (const b of ((j && j.content) || [])) {
    if (!b) continue;
    if (b.type === 'text') {
      text += b.text || '';
      if (b.text && onDelta) onDelta({ type: 'text', delta: b.text });
    } else if (b.type === 'thinking') {
      reasoning += b.thinking || '';
      if (b.thinking && onDelta) onDelta({ type: 'reasoning', delta: b.thinking });
    } else if (b.type === 'tool_use') {
      toolCalls.push({ id: b.id, name: b.name, args: b.input || {} });
    }
  }
  return { text, reasoning, toolCalls };
}
