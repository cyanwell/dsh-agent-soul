// 回合驱动 —— 一次对话怎么走完
//
// ★ 这是解耦里唯一「没有参考实现」的部分。设计取最小闭环：
//   组装上下文 → 调模型 → 有工具就执行再调 → 没有就结束。
//   每一步都写帧（写入即索引）。

import fs from 'node:fs';
import path from 'node:path';
import { FRAME } from '../session/frame.mjs';
import { budgetFrames, estimateTokens } from './context-budget.mjs';
import { createProcessGuard } from './process-guard.mjs';
import { HuanqiBreak } from '../llm/client.mjs';
import { DeclWindow } from './decl-window.mjs';

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
    // ★ 换气的跨轮窗口：连续 3 轮推理多样性都收敛 → 判退化。
    //   它和流式守卫（process-guard）是两件事，不能互相替代：
    //     · 流式：这一轮里多样性已经极低 → **就地切**（止损）
    //     · 跨轮：连续 3 轮都低 → **判它是陷进去了**（定性）
    //   流式拿不到「连续几轮」，跨轮拿不到「流还没结束」。
    this.declWindow = new DeclWindow(this.config.huanqi && this.config.huanqi.declWindowOptions);
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
        // ★ 2026-11-11：折叠摘要进消息流。用 system 而不是 assistant ——
        //   它**不是模型说过的话**，是系统告诉它「前面那段被折起来了，门牌在此」。
        //   冒充 assistant 会让模型以为自己讲过一段总结，那是在替它编记忆。
        case 'summary':
          msgs.push({ role: 'system', content: String(f.text || '') });
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
          // ★★ 2026-11-11 修一个会误导模型的致命读数：
          //   原来 usedTokens 数的是「人格 + **全部帧**」，而实际喂给模型的是**预算折叠之后**的那部分。
          //   实测本会话：它报 252.6%，而真正发出去的只有 keptTokens 那么多 ——
          //   模型看到「★★★ 还剩 0」会自己开始省着说话，那是纯粹的坏信息。
          //   现在：跑过一轮就用 __lastBudget 的实测值；没跑过才退回全量估算。
          usedTokens: (() => {
            const b = this.__lastBudget;
            if (b && this.__budgetSession === sessionId) {
              return estimateTokens(p) + b.keptTokens + estimateTokens((b.frames && b.frames[0] && b.frames[0].type === 'summary') ? b.frames[0].text : '');
            }
            return usedTokens ? usedTokens(this.store, sessionId, p) : undefined;
          })(),
          windowTokens: (this.config && this.config.context && this.config.context.windowTokens) || 1048576,
          watermark: this.config && this.config.context && this.config.context.watermark,
        });
      }
    } catch { ctx = ''; }   // ★ 算不出来就不写这一段，绝不影响对话
    // ★★ 2026-11-11（ask_user 的第二半，也是它唯一算数的一半）：
    //   把「你问过的问题 / 人给的答案」放回上下文。
    //   没有这一段，ask_user 就是个假工具 —— 问了没人看，答案回来了没人读。
    //   ★ 只放最近 3 条已回答 + 所有还没答的：多了会挤占人格与此刻的预算。
    //   ★ 算不出来或没接上，就整段不写 —— 绝不影响对话（与上面 ctx 同一条纪律）。
    let qs = '';
    try {
      const st = globalThis.__questionStore;
      if (st && typeof st.digest === 'function') {
        const d = st.digest(sessionId);
        const rows = [];
        for (const q of d.answered || []) rows.push('·（已回答）问：' + q.question + '　→ 答：' + q.answer);
        for (const q of d.open || []) rows.push('·（还没答）问：' + q.question);
        if (rows.length) {
          qs = '\n\n===== 你问过的问题 =====\n' + rows.join('\n')
            + '\n（★ 答案是**人给的**，可以当事实用；还没答的不要自己替他答。）';
        }
      }
    } catch { qs = ''; }
    return base + toolLine + ctx + qs + (p ? '\n\n===== 人格 / 长期约定 =====' + p : '');
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

      // ★★ 2026-11-11：**按 token 取帧，不按条数**。
      //   原来 `recent(sessionId, 60)` 只取最近 60 条 —— 而一帧可以是 40 字节，也可以是 4 MB
      //   （实测最长会话 5,164 帧 / 11.3 MB / 约 515 万 token）。**按条数取帧 = 假装有预算。**
      //   budgetFrames 从尾部往前累加，超预算的老帧折叠成一条带门牌的摘要，尾部永远保留。
      const raw = this.store.recent(sessionId, this.config.context.maxFrames);
      const bud = budgetFrames(raw, {
        maxTokens: this.config.context.maxTokens,
        keepTail: this.config.context.keepTailFrames,
        sessionId,
      });
      this.__lastBudget = bud;   // 给 /api/vitals 与调试看
      this.__budgetSession = sessionId;   // ★ 水位读数要认会话：不同会话的预算不能混用
      const messages = [{ role: 'system', content: this.systemPrompt(sessionId) }, ...this.#framesToMessages(bud.frames)];
      const specs = this.tools.specs();

      // ★ 器官观察点：调用前
      const obs = { step: steps, sessionId, text: '', reasoning: '', hasOutput: false };
      for (const o of this.organs) { try { o.beforeCall && o.beforeCall(obs); } catch {} }

      // ★★★ 换气（过程判据）：**监视推理过程**，而不是等结果（爀曦 2026-11-13）。
      //
      //   「模型天然倾向最编辑的方向输出，而被污染的上下文会引导它把推理往重复的几个字上循环，
      //    因为**模型是猜字机**……后面模型也学会了挤一点点正文、一点点工具调用，
      //    就**绕开了换气的检测**……**换气不应该只检测结果，而是监视过程。**」
      //
      //   ★ 结果判据（这轮有没有正文/工具）太便宜 —— 挤一句话就过了。
      //   ★ 过程绕不开：**要产生任何输出，都必须先走过那段推理。**
      const guard = (this.config.huanqi && this.config.huanqi.processGuard !== false)
        ? createProcessGuard(this.config.huanqi && this.config.huanqi.processGuardOptions)
        : null;

      let result;
      try {
        result = await this.llm.chatRetry(messages, specs, (ch) => {
          if (ch.type === 'text') obs.text += ch.delta;
          if (ch.type === 'reasoning') obs.reasoning += ch.delta;
          emit({ kind: 'delta', ...ch });
          // ★ 过程守卫：每累积 N 字符推理看一次，命中就地切（不是等它写完）
          if (guard && ch.type === 'reasoning') {
            const v = guard.push(ch.delta);
            if (v && v.shouldBreak) {
              const err = new HuanqiBreak(v);
              err.partial = { text: obs.text, reasoning: obs.reasoning };
              throw err;
            }
          }
        });
        // ★★ 流结束补一刀：`push` 只在「距上次检查已满 checkEveryChars」时才判，
        //   **剩余不足那次间隔的尾部就永远判不到**（实测：310 字的推理最后一次检查停在 200 字）。
        //   所以流正常结束时，要显式再看一次。
        if (guard) {
          const vf = guard.final();
          if (vf && vf.shouldBreak) throw new HuanqiBreak(vf);
        }
      } catch (e) {
        // ★ 被换气掐断：**不是错误**，是一次主动的切断。
        //   chatRetry 已经选择不重试（client.mjs 的 __huanqiBreak 分支），
        //   这里也不落 ERROR 帧 —— 否则「它坏了」和「我切了」会混成一件事。
        if (e && e.__huanqiBreak) {
          const d = e.detail || {};
          // 掐断前已经产出的部分不丢
          if (obs.text || obs.reasoning) {
            this.store.append(sessionId, FRAME.ASSISTANT, {
              text: obs.text || '',
              ...(obs.reasoning ? { reasoning: obs.reasoning } : {}),
            });
          }
          // 留痕：让 /organs、日记、检索都能看见「这一轮被切过」
          this.store.append(sessionId, FRAME.EVENT, {
            kind: 'huanqi-break',
            step: steps,
            reason: d.reason || null,
            chars: d.chars || 0,
            tailSpan: d.tailSpan || 0,
            repeatRatio: d.repeatRatio || 0,
          });
          emit({ kind: 'huanqi-break', reason: d.reason || null, chars: d.chars || 0 });
          // ★ 掐断后**结束这一轮**，不继续 while：
          //   污染还在上下文里，接着跑只会再撞一次（而且下一轮的帧更脏）。
          //   治病（purge）是调用方的事 —— 这里只负责「切准、留痕、说清」。
          return { text: obs.text || lastText, steps, huanqiBreak: d };
        }
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

      // ★★★ 换气 · 跨轮判据（2026-11-13 标定完成）：
      //   爀曦：「模型会因为上下文的污染，而把推理**收敛到最后几个字的循环**。」
      //   三个大会话（294/85/73MB，24179 条推理）交叉验证：
      //     真退化 多样性 0.02~0.08 · 正常 p50 = 0.42~0.60
      //   **判据只有一条：多样性收敛。**
      const declHit = this.declWindow.push(sessionId, obs.reasoning);
      if (declHit && declHit.shouldReport) {
        // ★ 三档：观察 / 预警 / 干预。**只在升档或重新武装时落痕**，不每轮都喊。
        this.store.append(sessionId, FRAME.EVENT, {
          kind: 'huanqi-decl-' + declHit.level,
          step: steps,
          median: declHit.median,
          window: declHit.window,
          chars: declHit.chars,
          escalated: declHit.escalated,
          top: declHit.top,
        });
        emit({ kind: 'huanqi-decl-' + declHit.level, median: declHit.median, window: declHit.window });

        // ★★★ 干预：过红线就调内嵌 LLM 检测上下文 + 精准修复（爀曦 2026-11-13 定）。
        //   **不等熔断** —— 熔断意味着整轮预算已经烧掉了。
        //   ★ 异步跑，不阻塞主循环（诊断要调一次 LLM，可能几秒）。
        if (declHit.level === 'intervene' && this.huanqiIntervene && !this.__intervening) {
          this.__intervening = true
          const sid = sessionId
          const why = { median: declHit.median, window: declHit.window, chars: declHit.chars }
          Promise.resolve()
            .then(() => this.huanqiIntervene({ sessionId: sid }))
            .then((res) => {
              try {
                this.store.append(sid, FRAME.EVENT, {
                  kind: 'huanqi-intervene-result',
                  stage: res && res.stage,
                  ok: res && res.ok,
                  ranges: res && res.ranges ? res.ranges.length : 0,
                  reason: res && res.reason,
                  trigger: why,
                })
                emit({ kind: 'huanqi-intervene-result', stage: res && res.stage, ok: res && res.ok })
              } catch {}
            })
            .catch((e) => {
              try { this.store.append(sid, FRAME.ERROR, { message: '换气干预失败：' + String((e && e.message) || e).slice(0, 200) }) } catch {}
            })
            .finally(() => { this.__intervening = false })
        }
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
