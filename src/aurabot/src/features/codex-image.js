// 实验性订阅接法：使用非公开端点，账号 / 工作区是否可用由服务端决定。
import { randomUUID } from 'node:crypto'
import { fetchImage } from '../core/net.js'
import { pickShape } from './image-shape.js'

export function createCodexImage({ auth, fetchImpl, log }) {
  return async function generate(config, prompt, { shape } = {}) {
    const revision = auth.revision?.()
    const check = () => auth.assertCurrent?.(revision)
    check()
    const c = config.codex || {}
    const hint = { square: '方图构图（1:1）', portrait: '竖版构图（2:3）', landscape: '横版构图（3:2）', wide: '宽幅横版构图（16:9）' }[pickShape(shape, config)]
    const body = { prompt: [prompt, hint].filter(Boolean).join('，'), model: c.model || 'gpt-image-2', quality: c.quality || 'auto', size: 'auto', background: c.background || 'auto' }
    const once = async ({ access, accountId }) => {
      check()
      if (!accountId) throw new Error('登录信息里没有账号 ID，去生图页重新登录 ChatGPT')
      return fetchImpl('https://chatgpt.com/backend-api/codex/images/generations', {
        method: 'POST',
        headers: { authorization: `Bearer ${access}`, 'chatgpt-account-id': accountId, accept: 'application/json', 'content-type': 'application/json', originator: 'pi', 'x-codex-image-turn-id': randomUUID(), 'user-agent': 'aurabot-qq' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(180000),
      })
    }
    log.info(`订阅生图请求：${body.model} / ${body.quality}`)
    let r = await once(await auth.ensureAccess())
    check()
    if (r.status === 401) {
      await r.body?.cancel()
      let credential
      try { credential = await auth.ensureAccess({ force: true }) }
      catch (error) { throw new Error('订阅登录已过期，去生图页重新登录 ChatGPT') }
      r = await once(credential)
      check()
    }
    const j = await r.json().catch(() => null)
    check()
    if (!r.ok) {
      if (r.status === 401) throw new Error('订阅登录已失效，去生图页重新登录 ChatGPT')
      if (r.status === 403) throw new Error('这个订阅 / 工作区不能用生图（HTTP 403）')
      if (r.status === 429) throw new Error('订阅生图用得太频繁或额度用完了（HTTP 429）')
      throw new Error(`订阅生图失败（HTTP ${r.status}）`)
    }
    const item = j?.data?.[0]
    if (typeof item?.b64_json === 'string' && item.b64_json) return Buffer.from(item.b64_json, 'base64')
    if (typeof item?.url === 'string' && item.url) {
      const buf = await fetchImage(item.url, { maxBytes: 20 * 1024 * 1024, allowLocal: false, timeoutMs: 120000 })
      check()
      return buf
    }
    throw new Error('订阅生图没有返回图片')
  }
}
