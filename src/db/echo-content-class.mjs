const INJECTION_PREFIXES = Object.freeze([
  'Current runtime context',
  'This is an automatically generated checkpoint',
  '[EAC',
  '<system-reminder>',
])

export const ECHO_CONTENT_CLASSES = Object.freeze(['dialogue', 'injection', 'other'])
export const ECHO_INJECTION_PREFIXES = INJECTION_PREFIXES

export function classifyEchoWordContent({ text, role, truncated } = {}) {
  const body = typeof text === 'string' ? text : ''
  if (INJECTION_PREFIXES.some(prefix => body.startsWith(prefix))) return 'injection'
  if (truncated === true || truncated === 1) return 'other'
  return role === 'user' || role === 'assistant' ? 'dialogue' : 'other'
}
