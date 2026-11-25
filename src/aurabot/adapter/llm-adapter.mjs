// llm-adapter.mjs —— 把 v4 的 LlmClient 包成 aurabot 期望的 llm 服务形状
// ============================================================================
// ★ 为什么需要（2026-11-14 第 14 代 · 自主时间查出来的真 bug）：
//
//   aurabot 的 core/llm.js:145 判据是 `typeof llm.stream === 'function'`，
//   runStream 用 `for await (const chunk of llm.stream(params))` —— 要**异步可迭代**。
//
//   而 v4 的 LlmClient（src/llm/client.mjs:198）：
//     · 有 `chat(messages, tools, onDelta)`，回调式收增量，一次返回 {text, reasoning, toolCalls}
//     · `stream` 是**布尔属性**（this.stream = o.stream !== false），不是方法
//
//   于是 `typeof llm.stream === 'function'` 恒 false →
//     index.mjs 退回 bridgeServices.llm 代理 → 而 service cap 没通 →
//     askModel 抛「宿主没有 llm 服务」→ 表情起名 / 心情判断 / 记忆提炼 全部静默降级。
//   实测症状：boot-out.log 里 `aurabot[stickers]: 看图起名失败： 宿主没有 llm 服务`。
//
// ★ 取舍（写清楚）：
//   适配器**忽略** params.provider / params.model —— 一律用 v4 自己配的模型。
//   理由：这些是「后台小任务」（起名、判心情、提炼记忆），要的是**能不能跑**，
//   不是「必须用 DSH 那个 provider」。跨过去反而会命中 DSH 的模型名、需要 DSH 的 key。
//   要改主对话模型的话，走的是 DSH 会话，根本不经过这里。
// ============================================================================

/**
 * @param {object} local v4 的 LlmClient（有 chat(messages, tools, onDelta)）
 * @returns {object|null} 形状像 aurabot 期望的 llm 服务；给不了就 null（调用方退回代理）
 */
export function createAurabotLlm (local) {
  if (!local || typeof local.chat !== 'function') return null

  return {
    /** @param {{system?:string, messages?:Array, maxTokens?:number, temperature?:number}} params */
    async * stream (params) {
      const p = params || {}
      const messages = []
      if (p.system) messages.push({ role: 'system', content: String(p.system) })
      for (const m of p.messages || []) {
        if (!m || !m.content) continue
        // aurabot 的 content 是 OpenAI 风格的块数组 [{type:'text',text}]，v4 的 chat 原样转给接口，不用改形。
        messages.push({ role: m.role || 'user', content: m.content })
      }
      if (!messages.length) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'empty-messages', message: '没有可发的内容' } } }
        return
      }
      try {
        const r = await local.chat(messages, undefined, undefined)
        const text = String((r && (r.text || '')) || '')
        // ★ 一次给整块而不是逐字：这些任务只要最终文本，少一层包装就少一处会坏的地方。
        if (text) yield { type: 'text-delta', text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } catch (e) {
        // 失败要如实回给 runStream —— 它会把 finish/error 转成 throw，调用方再降级。
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: { code: (e && e.code) || 'llm-error', message: String((e && e.message) || e) },
          },
        }
      }
    },

    /** 三态视觉能力探测（core/llm.js 用它决定要不要把图片降级成一句提示）。拿不到就 null = 不知道。 */
    async resolveModelInfo (provider, model) {
      if (typeof local.resolveModelInfo === 'function') return local.resolveModelInfo(provider, model)
      return null
    },

    ready () { try { return typeof local.ready === 'function' ? Boolean(local.ready()) : null } catch (error) { return false } },
    listProviders () { return typeof local.listProviders === 'function' ? local.listProviders() : [] },
    async listModels (p) { return typeof local.listModels === 'function' ? local.listModels(p) : [] },
  }
}
