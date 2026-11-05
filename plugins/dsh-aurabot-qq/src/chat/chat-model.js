// 按聊天选模型：主人在面板 / 配置里指定「哪个私聊、哪个群、所有私聊、所有群」各用哪个模型。纯函数。
//
// 配置 cfg.chatModels：
//   privateDefault / groupDefault：{ provider, model, reasoningEffort? }，空 = 不单独指定
//   privates：{ QQ号: 选择 }   groups：{ 群号: 选择 }
// 查找顺序（前一级没写或不可用就退到下一级）：
//   这个私聊（QQ 号）> 这个群（群号）> 所有私聊 / 所有群默认 > 全局模型（面板「聊天用的模型」或 DSH 默认）
// 只有主人能改这份配置（面板 / config.json）；聊天里的人说什么都不会换模型。

export const CHAT_MODEL_EFFORTS = ['', 'low', 'high', 'max']

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)
const str = (v) => (typeof v === 'string' ? v.trim() : '')

/** 一条选择：provider 和 model 都有才算数，否则 null（= 没指定）。 */
export function normalizeSelection(v) {
  if (!isObj(v)) return null
  const provider = str(v.provider)
  const model = str(v.model)
  if (!provider || !model) return null
  const effort = CHAT_MODEL_EFFORTS.includes(v.reasoningEffort) ? v.reasoningEffort : ''
  return { provider, model, reasoningEffort: effort }
}

function normalizeMap(v) {
  const out = {}
  if (!isObj(v)) return out
  for (const [k, sel] of Object.entries(v)) {
    const id = String(k).replace(/\D/g, '')
    const s = normalizeSelection(sel)
    if (id && s) out[id] = s
  }
  return out
}

const EMPTY = () => ({ provider: '', model: '', reasoningEffort: '' })

/** 配置归一化：坏数据一律当没写。 */
export function normalizeChatModels(raw) {
  const r = isObj(raw) ? raw : {}
  return {
    privateDefault: normalizeSelection(r.privateDefault) || EMPTY(),
    groupDefault: normalizeSelection(r.groupDefault) || EMPTY(),
    privates: normalizeMap(r.privates),
    groups: normalizeMap(r.groups),
  }
}

/**
 * 这个聊天该用哪个模型。
 * @param {object} cfg 插件配置
 * @param {{kind:string, userId?:string, groupId?:string}} chat
 * @param {{provider:string, model:string}[]|null} [available] DSH 里现有的模型；给了（且非空）就跳过已经不存在的
 * @returns {{provider:string, model:string, reasoningEffort:string, source:'private'|'group'|'privateDefault'|'groupDefault'}|null} null = 没有专门设置，用全局模型
 */
export function resolveChatModel(cfg, chat, available = null) {
  if (!chat) return null
  const c = normalizeChatModels(cfg?.chatModels)
  const ok = (s) => Boolean(s) && (!Array.isArray(available) || available.length === 0 || available.some((m) => m.provider === s.provider && m.model === s.model))
  let order = []
  if (chat.kind === 'private') order = [['private', c.privates[String(chat.userId ?? '')]], ['privateDefault', normalizeSelection(c.privateDefault)]]
  else if (chat.kind === 'group') order = [['group', c.groups[String(chat.groupId ?? '')]], ['groupDefault', normalizeSelection(c.groupDefault)]]
  for (const [source, sel] of order) if (ok(sel)) return { ...sel, source }
  return null
}
