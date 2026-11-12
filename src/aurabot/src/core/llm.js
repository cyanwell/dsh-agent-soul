// 直接问一次宿主模型（不进会话）：给表情起备注、心情判断、记忆提炼等后台小任务用。

import { randomUUID } from 'node:crypto'

export function defaultModel(dsh, cfg) {
  if (cfg?.model?.provider && cfg?.model?.model) return { provider: cfg.model.provider, model: cfg.model.model }
  try {
    const svc = dsh.get('agentDefaultModel')
    const sel = svc && typeof svc.currentSelection === 'function' ? svc.currentSelection() : null
    if (sel && sel.provider && sel.model) return { provider: sel.provider, model: sel.model }
  } catch (error) {}
  return null
}

// ---------- 视觉能力 ----------
//
// 模型能不能看图写在 DSH 的模型元数据里（inputModalities，DSH 自己的图片入口也靠它判断）。
// 三态：true = 明确声明支持；false = 明确声明不支持；null = 宿主没说清楚（按现状照发，别乱降级）。
// 明确不支持时还硬塞图片块，整轮请求会被模型拒掉 —— 她就一个字都回不了。

const VISION_TTL = 10 * 60_000
const visionCache = new Map() // `provider::model` → { at, value }

export function clearVisionCache () {
  visionCache.clear()
}

/** 这个模型能看图吗。null = 不知道。 */
export async function modelVision (dsh, provider, model) {
  const key = `${provider}::${model}`
  const hit = visionCache.get(key)
  if (hit && Date.now() - hit.at < VISION_TTL) return hit.value
  let value = null
  try {
    const llm = dsh.llm || dsh.get('llm')
    if (llm && typeof llm.resolveModelInfo === 'function') {
      const info = await llm.resolveModelInfo(provider, model)
      const mods = info && info.inputModalities
      if (Array.isArray(mods)) value = mods.includes('image')
    }
  } catch (error) {}
  visionCache.set(key, { at: Date.now(), value })
  return value
}

/** 当前设置里的模型能看图吗。面板上「视觉能力」可以手动声明，覆盖元数据。null = 不知道。 */
export async function canSeeImages (dsh, cfg) {
  const v = cfg && cfg.model && cfg.model.vision
  if (v === 'on') return true
  if (v === 'off') return false
  const t = defaultModel(dsh, cfg)
  if (!t) return null
  return modelVision(dsh, t.provider, t.model)
}

// ---------- 思考强度 ----------
//
// 不是所有模型都支持「思考强度」：DSH 里没有推理元数据的模型（本地 Ollama 的那几个、一些手写的
// provider）只要收到 reasoningEffort 就整轮报错 UNSUPPORTED_REASONING_EFFORT。所以传之前先问
// DSH 这个模型支持哪几档，不支持就干脆不传这个参数。

const REASONING_TTL = 10 * 60_000
const reasoningCache = new Map() // `provider::model` → { at, value }

export function clearReasoningCache () {
  reasoningCache.clear()
}

function cacheReasoning (provider, model, value) {
  reasoningCache.set(`${provider}::${model}`, { at: Date.now(), value })
}

/**
 * 这个模型支持哪些思考强度。
 * @returns {Promise<{efforts:string[], default?:string}|null>} 不支持（没有推理元数据）返回 null
 */
export async function modelReasoning (dsh, provider, model) {
  const key = `${provider}::${model}`
  const hit = reasoningCache.get(key)
  if (hit && Date.now() - hit.at < REASONING_TTL) return hit.value
  let value = null
  try {
    const llm = dsh.llm || dsh.get('llm')
    if (llm && typeof llm.resolveModelInfo === 'function') {
      const info = await llm.resolveModelInfo(provider, model)
      const r = info && info.reasoning
      if (r && Array.isArray(r.efforts) && r.efforts.length) {
        value = {
          efforts: r.efforts.map((e) => String(e && e.id ? e.id : e)).filter(Boolean),
          ...(r.defaultEffort ? { default: String(r.defaultEffort) } : {}),
        }
        if (!value.efforts.length) value = null
      }
    }
  } catch (error) {
    value = null // 查不到就当不支持：少传一个参数，总比整轮报错强
  }
  cacheReasoning(provider, model, value)
  return value
}

/** 把想要的档位收敛成这个模型真正支持的；给 '' / 不支持时返回 undefined（= 不传）。 */
export async function pickReasoningEffort (dsh, provider, model, want) {
  const llm = dsh.llm || dsh.get('llm')
  const canProbe = Boolean(llm && typeof llm.resolveModelInfo === 'function')
  const r = await modelReasoning(dsh, provider, model)
  if (!r) {
    // 宿主根本没有查询接口时（老版本 DSH）维持老行为：照传，由下方的「被拒就重试」兜底。
    // 有接口且查到「不支持」，才真的不传。
    if (!canProbe) return String(want || '') || undefined
    return undefined
  }
  const w = String(want || '')
  if (w && r.efforts.includes(w)) return w
  return r.default && r.efforts.includes(r.default) ? r.default : undefined
}

const isUnsupportedEffort = (error) => {
  const msg = String((error && (error.message || error.code)) || '')
  return /UNSUPPORTED_REASONING_EFFORT|does not support reasoning effort|reasoning effort/i.test(msg)
}

async function runStream (llm, params) {
  let out = ''
  for await (const chunk of llm.stream(params)) {
    if (!chunk) continue
    if (chunk.type === 'text-delta') out += chunk.text
    if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
      const f = chunk.reason.failure || {}
      const error = new Error('模型报错：' + (f.message || f.code || '未知'))
      if (f.code) error.code = f.code
      throw error
    }
  }
  return out.trim()
}

/**
 * @param {object} dsh 宿主 ctx
 * @param {{system:string, text:string, images?:Array<{data:string, mediaType:string}>, maxTokens?:number, temperature?:number, reasoningEffort?:string, cfg?:object}} o
 * @returns {Promise<string>}
 */
export async function askModel (dsh, o) {
  const llm = dsh.llm || dsh.get('llm')
  if (!llm || typeof llm.stream !== 'function') throw new Error('宿主没有 llm 服务')
  const t = defaultModel(dsh, o.cfg)
  if (!t) throw new Error('拿不到默认模型')
  let content = [{ type: 'text', text: o.text }]
  for (const img of o.images || []) content.push({ type: 'image', data: img.data, mediaType: img.mediaType, name: 'aurabot-image' })
  // 图片要先交给 DSH 的附件服务登记成附件块，模型适配层只认附件
  if (content.length > 1) {
    const att = dsh.attachments || dsh.get('attachments')
    if (!att || typeof att.admitPromptContent !== 'function') throw new Error('宿主没有附件服务，看不了图')
    content = await att.admitPromptContent(content)
  }
  const messages = [{ role: 'user', id: randomUUID(), content, source: { kind: 'plugin', plugin: 'aurabot' } }]
  const base = {
    provider: t.provider,
    model: t.model,
    system: o.system || '',
    messages,
    maxTokens: o.maxTokens || 600,
    temperature: o.temperature ?? 0.3,
  }
  let effort = await pickReasoningEffort(dsh, t.provider, t.model, o.reasoningEffort === undefined ? 'low' : o.reasoningEffort)
  for (let attempt = 0; ; attempt++) {
    try {
      return await runStream(llm, effort ? { ...base, reasoningEffort: effort } : base)
    } catch (error) {
      // 能力探测没查到 / 模型临时不认：去掉思考强度再来一次
      if (attempt === 0 && effort && isUnsupportedEffort(error)) {
        cacheReasoning(t.provider, t.model, null)
        effort = undefined
        continue
      }
      throw error
    }
  }
}
