// QQ 空间的说说可见范围：权限位和空间自身一致，发说说时按它算 ugc_right / target_uins。
// 单独放一个文件是为了让配置归一化和 qzone 功能都能引，且不产生循环依赖。

/** QQ 空间说说权限位（ugc_right），和空间客户端里的选项一一对应。 */
export const AUDIENCE_RIGHTS = Object.freeze({ all: 1, friends: 4, selected: 16, self: 64, excluded: 128 })

export const AUDIENCE_LABELS = Object.freeze({
  all: '所有人可见',
  friends: '好友可见',
  selected: '部分好友可见',
  self: '仅自己可见',
  excluded: '部分好友不可见',
})

/** 配置里允许存的可见范围。 */
export const DIARY_AUDIENCES = Object.freeze(Object.keys(AUDIENCE_RIGHTS))

const QQ_RE = /^[1-9]\d{4,11}$/
const MAX_QQLIST = 200

/** 把面板里填的 QQ 名单（换行/逗号/分号分隔）解析成数字数组，填错就抛错，绝不悄悄降级。 */
export function parseAudienceQQs(value) {
  const values = (Array.isArray(value) ? value.map(String) : String(value ?? '').split(/[\s,，;；]+/)).map((s) => s.trim()).filter(Boolean)
  const list = [...new Set(values)]
  if (list.some((s) => !QQ_RE.test(s) || !Number.isSafeInteger(Number(s)))) throw new Error('好友名单只能填写合法 QQ 号，用换行或逗号分隔。')
  if (list.length > MAX_QQLIST) throw new Error(`好友名单最多填写 ${MAX_QQLIST} 个 QQ 号。`)
  return list.map(Number)
}

/**
 * 算出这次发布实际生效的可见范围。
 * - 固定范围以面板配置为准；单次请求只能收窄到「仅自己」，不能扩大。
 * - selected / excluded 必须带一份合法名单，名单为空时报错而不是退回公开。
 * 返回 { ugc_right, visibility, label, target_uins? }。
 */
export function resolveAudience(cfg, requested) {
  const fixed = cfg?.diary?.visibility || 'all'
  if (!Object.hasOwn(AUDIENCE_RIGHTS, fixed)) throw new Error('说说可见范围配置无效，已停止发布。')
  const mode = requested === 'self' ? 'self' : fixed
  if (!Object.hasOwn(AUDIENCE_RIGHTS, mode)) throw new Error('未知的说说可见范围，已停止发布。')
  const list = mode === 'selected' || mode === 'excluded' ? parseAudienceQQs(cfg?.diary?.audienceQQs) : []
  if ((mode === 'selected' || mode === 'excluded') && !list.length) {
    throw new Error('选择了部分好友范围，但 QQ 名单为空，已停止发布；不会改成公开。')
  }
  return {
    ugc_right: AUDIENCE_RIGHTS[mode],
    visibility: mode,
    label: AUDIENCE_LABELS[mode],
    ...(list.length ? { target_uins: list } : {}),
  }
}
