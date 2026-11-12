// 工具的写法。具体的工具都在各个模块里（src/modules/*），按会话注册（agent.ctx.tools.register），只出现在 Aurabot 的会话里。
// 工具定义一旦确定尽量别改：改一次，DeepSeek 的前缀缓存就失效一次。

/**
 * 和 @deepseek-ai/dsh-tools 的 defineTool 产物同形：parameters / output.schema 是 JSON Schema。
 * render 可选：默认只回一行文字；工具要把图片之类的内容块放进结果时自己传（见 imagegen 的 qq_draw_image）。
 */
export function defineTool({ name, description, properties = {}, required = [], execute, render, slow }) {
  const parameters = { type: 'object', properties, required, additionalProperties: false }
  return {
    name,
    description,
    // 慢工具（生图、翻唱……）：卡住超过 1.5 秒就先往 QQ 发一条「正在做」的提示（issue #74），
    // 不让主人干等一整轮；具体提示语就写在这里。快工具不用标。
    ...(slow ? { slow } : {}),
    parameters,
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: render || ((_args, value) => [{ type: 'text', text: value && value.ok === false ? '✗ ' + (value.message || '没成功') : (value && value.message) || '✓' }]),
    },
    async execute(args, exec) {
      try {
        const r = await execute(args || {}, exec)
        return JSON.parse(JSON.stringify(r ?? { ok: true }))
      } catch (error) {
        return { ok: false, message: String(error && error.message ? error.message : error) }
      }
    },
  }
}

export const str = (description) => ({ type: 'string', description })
export const int = (description) => ({ type: 'integer', description })
export const bool = (description) => ({ type: 'boolean', description })
