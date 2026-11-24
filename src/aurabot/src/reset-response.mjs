const count = (value) => Number.isInteger(value) && value >= 0 ? value : null
const label = (value, fallback = null) => String(value || '').slice(0, 80) || fallback

export function resetSuccess(archived) {
  const n = count(archived) ?? 0
  return { ok: true, archived: n, failed: 0, message: n ? `归档了 ${n} 个会话，下一条消息起她会重新开始` : '本来就没有会话' }
}

export function resetFailure(error) {
  return {
    ok: false,
    archived: count(error && error.archived),
    failed: count(error && error.failed),
    code: label(error && error.code, 'reset-failed'),
    stage: label(error && error.stage),
    message: '会话重置未完成',
  }
}
