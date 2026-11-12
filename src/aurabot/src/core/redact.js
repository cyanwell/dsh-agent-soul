// 出站文本和日志脱敏：token、密码、Cookie 一律不能原样出现。

const PATTERNS = [
  // Authorization: Bearer xxx（先于下面的 key=value，免得只抹掉 "Bearer"）
  [/(Authorization["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[A-Za-z0-9._~+/=-]{8,}/gi, '$1***'],
  // key=value / key: value 形式
  [/((?:access[_-]?token|token|password|passwd|pwd|secret|api[_-]?key|cookie|MUSIC_U|p_skey|skey|clientkey|authorization)["']?\s*[:=]\s*["']?)([^\s"',;&]{4,})/gi, '$1***'],
  // Bearer xxx
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, '$1***'],
  // OpenAI / 常见 sk- 密钥
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, 'sk-***'],
  // URL 查询参数里的 token
  [/([?&](?:token|access_token|key)=)[^&\s]+/gi, '$1***'],
]

/** 已知的敏感值（比如当前 OneBot token），出现就整段替换。 */
const known = new Set()

export function registerSecret(value) {
  const v = String(value || '')
  if (v.length >= 6) known.add(v)
}

export function redact(text) {
  let s = String(text ?? '')
  for (const v of known) if (v && s.includes(v)) s = s.split(v).join('***')
  for (const [re, rep] of PATTERNS) s = s.replace(re, rep)
  return s
}
