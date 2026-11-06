// LLM 客户端 —— OpenAI 兼容 /chat/completions，支持 SSE 流与工具调用
//
// ★ 这一层是全新的（DSH 里 agent-soul 从没自己调过模型），但形态固定：
//   发 POST → 收 SSE → 拼 delta → 拿到 text / tool_calls。

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export class LlmClient {
  constructor({ baseUrl, apiKey, model, maxTokens = 4096, temperature = 0.7 }) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.apiKey = apiKey || '';
    this.model = model || 'deepseek-chat';
    this.maxTokens = maxTokens;
    this.temperature = temperature;
  }

  ready() { return Boolean(this.baseUrl && this.apiKey); }

  /**
   * 一次调用。
   * @param messages  OpenAI 格式的消息数组
   * @param tools     工具 spec 数组（可为空）
   * @param onDelta   流式回调 (chunk) => void，chunk = { type:'text'|'reasoning', delta }
   * @returns { text, reasoning, toolCalls: [{id,name,args}] }
   */
  async chat(messages, tools, onDelta) {
    if (!this.ready()) throw new Error('LLM 未配置：缺 baseUrl 或 apiKey');

    const body = {
      model: this.model,
      messages,
      stream: true,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
    };
    if (tools && tools.length) { body.tools = tools; body.tool_choice = 'auto'; }

    const resp = await fetch(this.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + this.apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      throw new Error('LLM HTTP ' + resp.status + ': ' + t.slice(0, 500));
    }

    // —— SSE 解析 ——
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

  /** 带退避的重试包装 */
  async chatRetry(messages, tools, onDelta, tries = 3) {
    let lastErr;
    for (let i = 0; i < tries; i++) {
      try { return await this.chat(messages, tools, onDelta); }
      catch (e) {
        lastErr = e;
        const msg = String(e && e.message);
        // 4xx 不重试（除了 429）
        if (/HTTP 4\d\d/.test(msg) && !/HTTP 429/.test(msg)) break;
        await sleep(400 * Math.pow(2, i));
      }
    }
    throw lastErr;
  }
}
