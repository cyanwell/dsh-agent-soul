// lifecycle-inspect.mjs —— 桥的**真实身份核验**（2026-11-20）
//
// 为什么单独一个文件：这件事有三条独立的半边，任何一条拿不到都必须**明确说拿不到**，
// 不能合成一个“看着像通过”的 true：
//   ① 进程本体：pid 真的存在、exe 路径与预期一致、启动时刻可读（PowerShell CIM）
//   ② 管理器证明：core 只在“被 bridge 用这个 marker 拉起”时才会在 core.lock 里写 manager 段，
//      并把 marker 的 sha256 放进 /api/manager-proof（要 X-Soul-Token，只认 loopback）
//   ③ 三者对齐：markerHash 必须等于 sha256(我们手里的 marker)，pid 必须等于 health 报的 core pid
//
// ★ 判据（写死在这里，改的时候要能对得上）：**没有 ①②③ 全部对齐，就不许返回 ok:true。**
//   宁可回 identity-verification-unavailable，也不许回一个乐观值 —— 那个乐观值会被上层
//   当作「已经验过」写进 instanceRecord，然后 stop/restart 就会对着错的进程下手。
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { inspectWindowsProcess } from './process-inspector.mjs'
import { readManagerProof } from './manager-proof-client.mjs'

const MARKER_RE = /^[A-Za-z0-9_-]{32,128}$/

/** 跑一次 PowerShell，返回 { exitCode, stdout, timedOut }；不抛。 */
export function makeRunPowerShell(o = {}) {
  const exe = String(o.powerShellPath || 'powershell.exe')
  const maxBuffer = Number(o.maxBuffer) > 0 ? Number(o.maxBuffer) : 1024 * 1024
  return (command, opts = {}) => new Promise((resolve) => {
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 5000
    try {
      execFile(exe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', String(command)],
        { timeout: timeoutMs, maxBuffer, windowsHide: true },
        (err, stdout) => {
          if (err) {
            const timedOut = !!(err.killed || err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT')
            resolve({ exitCode: typeof err.code === 'number' ? err.code : 1, stdout: String(stdout || ''), timedOut, error: String(err.message || err) })
            return
          }
          resolve({ exitCode: 0, stdout: String(stdout || ''), timedOut: false, error: null })
        })
    } catch (e) {
      resolve({ exitCode: 1, stdout: '', timedOut: false, error: String((e && e.message) || e) })
    }
  })
}

/** 路径归一：能 realpath 就 realpath，失败退回 resolve（不因为大小写/8.3 名判成不一致）。 */
export function makeCanonicalizePath(fsImpl = null) {
  return async (p) => {
    const raw = String(p || '')
    if (!raw) throw new Error('empty path')
    try {
      const fsMod = fsImpl || (await import('node:fs'))
      return fsMod.realpathSync.native ? fsMod.realpathSync.native(raw) : fsMod.realpathSync(raw)
    } catch {
      const pathMod = await import('node:path')
      return pathMod.resolve(raw)
    }
  }
}

function hashMarker(marker) { return createHash('sha256').update(String(marker), 'utf8').digest('hex') }

/**
 * 建一个 inspect(pid, rec) —— 供 makeAgentSoulLifecycle 用。
 * 返回形状与 lifecycle 的期望一致：{ ok, startedAt, realpath, marker } 或 { ok:false, reason/code }。
 *
 * @param {object} o
 * @param {function} o.runPowerShell   makeRunPowerShell() 的产物
 * @param {function} o.canonicalizePath
 * @param {function} o.readProof       ({marker,shellPid,healthCorePid,baseUrl}) -> readManagerProof 结果
 * @param {object}   o.health          读 /api/health（要 pid）
 * @param {function} [o.now]
 */
export function makeInspect(o = {}) {
  const now = typeof o.now === 'function' ? o.now : Date.now
  return async function inspect(pid, rec) {
    const id = Number(pid)
    if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, reason: 'process-invalid-pid', code: 'process-invalid-pid' }

    // ① 进程本体
    const proc = await inspectWindowsProcess(id, { runPowerShell: o.runPowerShell, canonicalizePath: o.canonicalizePath })
    if (!proc || proc.ok !== true) return { ok: false, reason: proc && proc.code || 'process-query-failed', code: proc && proc.code || 'process-query-failed' }

    const wantReal = rec && typeof rec.realpath === 'string' && rec.realpath ? rec.realpath : null
    if (wantReal && proc.executablePath !== wantReal) {
      return { ok: false, reason: 'process-path-mismatch', code: 'process-path-mismatch', expected: wantReal, actual: proc.executablePath }
    }

    // ② 管理器证明（marker 必须是本轮 spawn 的那个；没 marker 就没有可核的东西）
    const marker = rec && typeof rec.marker === 'string' ? rec.marker : ''
    if (!MARKER_RE.test(marker)) return { ok: false, reason: 'marker-absent', code: 'marker-absent' }

    const health = typeof o.health === 'function' ? await o.health() : { ok: false }
    if (!health || health.ok !== true || !Number.isSafeInteger(Number(health.pid))) {
      return { ok: false, reason: 'core-health-unavailable', code: 'core-health-unavailable' }
    }
    const corePid = Number(health.pid)

    let proof = null
    try {
      proof = await o.readProof({ marker, shellPid: id, healthCorePid: corePid })
    } catch (e) {
      return { ok: false, reason: 'proof-threw:' + String((e && e.message) || e).slice(0, 120), code: 'proof-unavailable' }
    }
    if (!proof || proof.ok !== true) return { ok: false, reason: proof && proof.code || 'proof-unavailable', code: proof && proof.code || 'proof-unavailable' }

    // ③ 三者对齐
    const expectedHash = hashMarker(marker)
    if (String(proof.identity.markerHash || '') !== expectedHash) {
      return { ok: false, reason: 'proof-marker-mismatch', code: 'proof-marker-mismatch' }
    }

    return {
      ok: true,
      startedAt: proc.creationDate,
      realpath: proc.executablePath,
      marker,
      corePid,
      markerHash: expectedHash,
      inspectedAt: new Date(now()).toISOString(),
    }
  }
}
