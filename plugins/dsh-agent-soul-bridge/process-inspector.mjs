const REQUIRED = ['ProcessId', 'ParentProcessId', 'ExecutablePath', 'CreationDate']

function validPid(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 0x7fffffff
}

/**
 * ★ 2026-11-20 实测：本机（PS 5.1 + CIM）**拿不到 DMTF 串** ——
 *   Get-CimInstance 的 CreationDate 经过 ConvertTo-Json 会变成 \"/Date(1795179938983)/\"，
 *   经过 [string] 强转则是区域格式 "11/20/2026 21:05:38"（随系统语言变，无法解析）。
 *   所以命令改成由 PowerShell 自己输出 ISO-8601 UTC（见下面的命令串），
 *   这里同时**保留 DMTF 解析**（别的机器/别的 PowerShell 版本仍可能给 DMTF）。
 * ★ 判据：接受两种已知格式 + 明确拒绝其它 —— 不要「猜一个日期」，抓取时刻是身份的一部分。
 */
function parseIsoDate(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?(Z|[+-]\d{2}:\d{2})$/.test(text)) return null;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function parseCreationDate(value) {
  const text = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) return parseIsoDate(text);
  return parseDmtfDate(text);
}

function parseDmtfDate(value) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/.exec(String(value || ''))
  if (!m) return null
  const [, y, mo, d, h, mi, s, micros, sign, offsetText] = m
  const parts = [Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s), Number(offsetText)]
  const [year, month, day, hour, minute, second, offset] = parts
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59 || offset > 840) return null
  const ms = Number(micros.slice(0, 3))
  const localDate = new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms))
  if (localDate.getUTCFullYear() !== year || localDate.getUTCMonth() !== month - 1 || localDate.getUTCDate() !== day) return null
  const utc = localDate.getTime() - (sign === '+' ? 1 : -1) * offset * 60000
  return new Date(utc).toISOString()
}

export async function inspectWindowsProcess(pid, { runPowerShell, canonicalizePath, timeoutMs = 25000 } = {}) {
  if (!validPid(pid)) return { ok: false, code: 'pid-invalid' }
  if (typeof runPowerShell !== 'function' || typeof canonicalizePath !== 'function') return { ok: false, code: 'inspector-unavailable' }
  /* ★ 2026-11-20：CreationDate 由 PowerShell 自己格式化成 ISO-8601 UTC。
     原命令 Select-Object 后 ConvertTo-Json 会输出 "/Date(…)/"，强转则是区域格式 —— 两者都解析不了。 */
  const command = `$ErrorActionPreference = "Stop"; $p = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = ${pid}"; if ($null -eq $p) { "__NOT_FOUND__" } else { $o = [ordered]@{ ProcessId=[int]$p.ProcessId; ParentProcessId=[int]$p.ParentProcessId; ExecutablePath=[string]$p.ExecutablePath; CreationDate=[string]$p.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }; $o | ConvertTo-Json -Compress }`
  let raw
  try { raw = await runPowerShell(command, { timeoutMs }) } catch { return { ok: false, code: 'process-query-failed' } }
  if (!raw || raw.timedOut || raw.exitCode !== 0 || typeof raw.stdout !== 'string') return { ok: false, code: raw && raw.timedOut ? 'process-query-timeout' : 'process-query-failed' }
  const text = raw.stdout.trim()
  if (!text || text === '__NOT_FOUND__') return { ok: false, code: 'process-not-found' }
  let value
  try { value = JSON.parse(text) } catch { return { ok: false, code: 'process-json-invalid' } }
  if (Array.isArray(value)) return { ok: false, code: 'process-result-ambiguous' }
  if (!value || typeof value !== 'object' || REQUIRED.some(key => !Object.hasOwn(value, key))) return { ok: false, code: 'process-metadata-incomplete' }
  const processId = Number(value.ProcessId)
  const parentProcessId = Number(value.ParentProcessId)
  const dmtfCreationDate = String(value.CreationDate || '')
  const creationDate = parseCreationDate(dmtfCreationDate)
  const executablePath = String(value.ExecutablePath || '')
  if (!validPid(processId) || processId !== pid || !validPid(parentProcessId) || !executablePath || !creationDate) return { ok: false, code: 'process-metadata-invalid' }
  let canonicalPath
  try { canonicalPath = await canonicalizePath(executablePath) } catch { return { ok: false, code: 'process-path-unresolved' } }
  if (typeof canonicalPath !== 'string' || !canonicalPath || canonicalPath.includes('\0')) return { ok: false, code: 'process-path-invalid' }
  return { ok: true, processId, parentProcessId, executablePath: canonicalPath, creationDate }
}

export function matchesShellCorePair({ shell, core, expectedShellPid, expectedCorePid, expectedShellPath, expectedCorePath } = {}) {
  if (!shell || !core || !validPid(expectedShellPid) || !validPid(expectedCorePid)) return { ok: false, code: 'process-pair-unavailable' }
  if (shell.processId !== expectedShellPid || core.processId !== expectedCorePid || core.parentProcessId !== shell.processId) return { ok: false, code: 'process-pair-pid-mismatch' }
  if (expectedShellPath && shell.executablePath.toLowerCase() !== String(expectedShellPath).toLowerCase()) return { ok: false, code: 'shell-path-mismatch' }
  if (expectedCorePath && core.executablePath.toLowerCase() !== String(expectedCorePath).toLowerCase()) return { ok: false, code: 'core-path-mismatch' }
  return { ok: true, shell: Object.freeze({ processId: shell.processId, executablePath: shell.executablePath, creationDate: shell.creationDate }), core: Object.freeze({ processId: core.processId, parentProcessId: core.parentProcessId, executablePath: core.executablePath, creationDate: core.creationDate }) }
}
