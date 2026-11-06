// 回合驱动 —— 一次对话怎么走完
//
// ★ 这是解耦里唯一「没有参考实现」的部分。设计取最小闭环：
//   组装上下文 → 调模型 → 有工具就执行再调 → 没有就结束。
//   每一步都写帧（写入即索引）。

import fs from 'node:fs';
import path from 'node:path';
import { FRAME } from '../session/frame.mjs';

const MAX_STEPS = 12;   // 一次回合内最多的「模型调用」次数，防死循环

export class AgentLoop {
  constructor({ store, llm, tools, config }) {
    this.store = store;
    this.llm = llm;
    this.tools = tools;
    this.config = config;
    this.personaCache = null;
    /** 器官钩子：每次模型调用前后会被通知。见 organs/ 目录。 */
    this.organs = [];
  }

  /** 人格层：把配置里列的文件读成一段文本（带 mtime 缓存） */
  personaText() {
    // 有 PersonaLayer 就用它（分层 + 可见裁剪）；否则退回旧的文件拼接
    if (this.personaLayer) {
      try { return this.personaLayer.render().text; } catch (e) { /* 退回 */ }
    }
    const files = (this.config.persona && this.config.persona.files) || [];
    if (!files.length) return '';
    const stamp = files.map(f => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }).join(',');
    if (this.personaCache && this.personaCache.stamp === stamp) return this.personaCache.text;
    const parts = [];
    for (const f of files) {
      try { parts.push('\n\n<!-- ' + path.basename(f) + ' -->\n' + fs.readFileSync(f, 'utf8')); }
      catch { /* 读不到就跳过 */ }
    }
    const text = parts.join('');
    this.personaCache = { stamp, text };
    return text;
  }

  /** 把帧转成 OpenAI 消息 */
  #framesToMessages(frames) {
    const msgs = [];
    for (const f of frames) {
      switch (f.type) {
        case FRAME.USER:
          msgs.push({ role: 'user', content: f.text || '' });
          break;
        case FRAME.ASSISTANT:
          msgs.push({ role: 'assistant', content: f.text || '' });
          break;
        case FRAME.TOOL_CALL:
          msgs.push({
            role: 'assistant',
            content: '',
            tool_calls: [{ id: f.callId, type: 'function', function: { name: f.name, arguments: JSON.stringify(f.args || {}) } }],
          });
          break;
        case FRAME.TOOL_RESULT:
          msgs.push({ role: 'tool', tool_call_id: f.callId, content: String(f.content ?? '') });
          break;
        default:
          break;
      }
    }
    return msgs;
  }

  /** 组装 system prompt */
  /**
   * 拼系统提示。
   * ★ 2026-11-07 加了一个参数：sessionId —— 因为要算「这个会话的上下文用了多少」。
   *   不传也能跑（退化到不写水位那一段），**绝不让算水位这件事影响对话本身**。
   */
  systemPrompt(sessionId) {
    const p = this.personaText();
    const base = '你是一个持续存在的 agent。你拥有长期会话记忆，每一步都会被记录。' +
      '需要调用工具时直接调用；不需要时直接用中文回答。';
    const toolLine = this.tools.tools.size
      ? '\n\n可用工具：' + [...this.tools.tools.keys()].join('、')
      : '\n\n当前没有注册任何工具。';
    let ctx = '';
    try {
      const { renderContext, usedTokens } = this.__ctxMod || {};
      if (renderContext) {
        ctx = '\n\n===== 此刻 =====\n' + renderContext({
          at: new Date(),
          idleMs: this.__idleMs,
          usedTokens: usedTokens ? usedTokens(this.store, sessionId, p) : undefined,
          windowTokens: (this.config && this.config.context && this.config.context.windowTokens) || 1048576,
          watermark: this.config && this.config.context && this.config.context.watermark,
        });
      }
    } catch { ctx = ''; }   // ★ 算不出来就不写这一段，绝不影响对话
    return base + toolLine + ctx + (p ? '\n\n===== 人格 / 长期约定 =====' + p : '');
  }

  /**
   * 跑一个回合。用户消息已经写进会话（调用方负责）。
   * @returns { text, steps }
   */
  async turn(sessionId, onEvent) {
    const emit = (e) => { try { onEvent && onEvent(e); } catch { /* 不让 UI 错误毁掉回合 */ } };
    let steps = 0;
    let lastText = '';

    while (steps < MAX_STEPS) {
      steps++;

      const recent = this.store.recent(sessionId, this.config.context.maxFrames);
      const messages = [{ role: 'system', content: this.systemPrompt(sessionId) }, ...this.#framesToMessages(recent)];
      const specs = this.tools.specs();

      // ★ 器官观察点：调用前
      const obs = { step: steps, sessionId, text: '', reasoning: '', hasOutput: false };
      for (const o of this.organs) { try { o.beforeCall && o.beforeCall(obs); } catch {} }

      let result;
      try {
        result = await this.llm.chatRetry(messages, specs, (ch) => {
          if (ch.type === 'text') obs.text += ch.delta;
          if (ch.type === 'reasoning') obs.reasoning += ch.delta;
          emit({ kind: 'delta', ...ch });
        });
      } catch (e) {
        const msg = String((e && e.message) || e);
        this.store.append(sessionId, FRAME.ERROR, { message: msg });
        emit({ kind: 'error', message: msg });
        return { text: lastText, steps, error: msg };
      }

      // 落 assistant 帧（有正文或有推理都记）
      if (result.text || result.reasoning) {
        this.store.append(sessionId, FRAME.ASSISTANT, {
          text: result.text,
          ...(result.reasoning ? { reasoning: result.reasoning } : {}),
        });
        if (result.text) { lastText = result.text; emit({ kind: 'text', text: result.text }); }
      }

      // ★ 器官观察点：调用后（huanqi 在这里判「这一步是不是白烧了」）
      obs.hasOutput = Boolean(result.text) || result.toolCalls.length > 0;
      for (const o of this.organs) {
        try {
          const v = o.afterCall && o.afterCall(obs);
          if (v && v.breakTurn) {
            const msg = '[换气] ' + (v.reason || '判定这一轮是废的') + '，已中断';
            this.store.append(sessionId, FRAME.ERROR, { message: msg });
            emit({ kind: 'error', message: msg });
            return { text: lastText, steps, error: msg };
          }
        } catch {}
      }

      // 有工具调用 → 执行 → 继续循环
      if (result.toolCalls.length) {
        for (const call of result.toolCalls) {
          this.store.append(sessionId, FRAME.TOOL_CALL, { callId: call.id, name: call.name, args: call.args });
          emit({ kind: 'tool', name: call.name, args: call.args });

          const r = await this.tools.execute(call.name, call.args, { sessionId });
          const content = r.ok ? r.content : ('[失败] ' + (r.reason || r.error || '未知'));

          this.store.append(sessionId, FRAME.TOOL_RESULT, { callId: call.id, name: call.name, content });
          emit({ kind: 'tool_result', name: call.name, ok: r.ok, content: content.slice(0, 400) });
        }
        continue;   // 再调一次模型
      }

      // ★ 器官闸门：没有工具调用不等于「做完了」。
      //   一个只吐推理、正文为空的调用，是废轮 —— 器官可以说「这一轮不算」。
      let voided = null;
      for (const o of this.organs) {
        try {
          const v = o.endTurn && o.endTurn(obs);
          if (v && v.voidTurn) { voided = v; break; }
        } catch {}
      }
      if (voided) {
        emit({ kind: 'void', reason: voided.reason || '废轮', step: steps });
        this.store.append(sessionId, FRAME.SYSTEM, { text: '[换气] 这一轮没有产出，重开（' + (voided.reason || '') + '）' });
        continue;   // 再调一次，不计入「回合结束」
      }

      // 没有工具调用、器官也没否决 → 这一回合真的结束了
      return { text: lastText, steps };
    }

    const msg = '回合步数超过上限 ' + MAX_STEPS + '，已中断';
    this.store.append(sessionId, FRAME.ERROR, { message: msg });
    emit({ kind: 'error', message: msg });
    return { text: lastText, steps, error: msg };
  }
}
