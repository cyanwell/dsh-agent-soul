// voice · tts —— 文字转语音（只用 Windows 自带，不依赖 Python）
// ============================================================================
// 为什么是精简版：
//   aurabot 的 tts.js 有三档引擎 —— edge-tts（要在 C:\Aurabot\pyenv 装 Python 环境）、
//   本地服务（cosyvoice / gptsovits）、通用 HTTP。
//   ★ 2026-11-12 实测：**pyenv 根本不存在**（C:\Aurabot\pyenv 和 ~/Aurabot/pyenv 都没有），
//     所以 aurabot 现在用的就是第三档兜底 —— Windows 自带的 System.Speech。
//   既然它本来就跑在兜底上，v4 就只搬那一档：**零外部依赖，只需要 Windows**。
//
// ★ 保留的语义（与 aurabot 一致，不自己发明）：
//   · 优先选 zh-CN 的语音（没装中文语音就退到系统默认）
//   · 文字走 stdin 而不是命令行参数（避免引号 / 编码问题）
//   · 输出必须是真文件、大小 > 1000 字节，否则算失败（空 wav 会被 QQ 吞掉）
//
// ★ 没搬的部分，说清为什么：
//   · edge-tts：要多一个 Python 环境，而那个环境现在不存在。真要更好的音色，
//     那是「装一个新东西」的决定，不该塞进「搬能力」这件事里。
//   · cosyvoice / gptsovits：需要本地 GPU 服务，本机没跑。
//   · 变声（RVC）：只在翻唱上用，语音条不用。
// ============================================================================

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, statSync, unlinkSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const WIN = process.platform === 'win32'

function run (cmd, args, { timeoutMs = 60000, input } = {}) {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let child
    try {
      child = spawn(cmd, args, { windowsHide: true })
    } catch (error) {
      resolve({ code: -1, out, err: error.message })
      return
    }
    const t = setTimeout(() => { try { child.kill() } catch (e) {} err += '\n超时' }, timeoutMs)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => { err += e.message })
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }) })
    if (input != null) { try { child.stdin.end(input, 'utf8') } catch (e) {} }
  })
}

/**
 * createTts({ outDir, log }) → { speak(text), available(), view() }
 *
 * ★ 只做 Windows 那一档。非 Windows 上 available() 返回 false ——
 *   v4 跑在 Windows 上，但显式说清比假装能用好。
 */
export function createTts (opts = {}) {
  const outDir = String(opts.outDir || '').trim()
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const counters = { ok: 0, failed: 0, lastAt: null, lastError: null, lastEngine: null, lastChars: 0 }

  function ensureDir () {
    if (!outDir) throw new Error('没有配置语音输出目录')
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
    return outDir
  }

  /**
   * 清掉过期语音文件。
   *
   * ★★ 2026-11-12：这一条是**漏写的**，不是可选项。
   *   每次合成产出一个 wav（217KB 左右），而没有任何地方删它 ——
   *   一天说几十句就是十几 MB，一个月就是几百 MB，**永远不会自己变小**。
   *
   * ★ 照抄 aurabot 的口径（24 小时）：同一个仓库里已经有一个被生产验证过的数字，
   *   这里不另发明一个。
   * ★ 失败一律吞掉：清理失败不该让这次合成跟着失败。
   */
  function pruneOld (ttlMs) {
    const ttl = Number(ttlMs) > 0 ? Number(ttlMs) : 24 * 60 * 60 * 1000
    let removed = 0
    try {
      for (const name of readdirSync(outDir)) {
        if (!/\.(wav|mp3|txt)$/i.test(name)) continue
        const p = join(outDir, name)
        try {
          if (Date.now() - statSync(p).mtimeMs > ttl) { unlinkSync(p); removed += 1 }
        } catch { /* 单个文件失败不影响别的 */ }
      }
    } catch { /* 目录读不了就算了 */ }
    if (removed) { counters.pruned = (counters.pruned || 0) + removed; log('[tts] 清掉 ' + removed + ' 个过期语音') }
    return removed
  }

  async function windowsSynth (text) {
    ensureDir()
    const file = join(outDir, randomUUID() + '.wav')
    const script =
      'Add-Type -AssemblyName System.Speech;' +
      '$t=[Console]::In.ReadToEnd();' +
      '$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;' +
      "$zh=$s.GetInstalledVoices()|Where-Object{$_.VoiceInfo.Culture.Name -eq 'zh-CN'}|Select-Object -First 1;" +
      'if($zh){$s.SelectVoice($zh.VoiceInfo.Name)};' +
      "$s.SetOutputToWaveFile('" + file.replace(/'/g, "''") + "');$s.Speak($t);$s.Dispose()"
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "[Console]::InputEncoding=[Text.Encoding]::UTF8;" + script], { timeoutMs: 60000, input: text })
    if (!existsSync(file) || statSync(file).size < 1000) {
      try { unlinkSync(file) } catch (e) {}
      throw new Error('Windows 语音失败：' + String(r.err || '').replace(/\s+/g, ' ').slice(-200))
    }
    return file
  }

  /** 文字 → { ok, file, engine, chars } 或 { ok:false, code, error } */
  async function speak (text) {
    const clean = String(text == null ? '' : text).trim()
    if (!clean) return { ok: false, code: 'TTS_EMPTY', error: '没有要念的文字' }
    if (!WIN) return { ok: false, code: 'TTS_NO_ENGINE', error: '当前平台没有可用的 TTS（只做了 Windows）' }
    counters.lastAt = new Date().toISOString()
    counters.lastChars = clean.length
    try {
      // ★ 顺手清一次过期文件 —— 合成是低频动作，不值得为它单起一个定时器。
      pruneOld(opts.pruneTtlMs)
      const file = await windowsSynth(clean)
      counters.ok += 1
      counters.lastEngine = 'windows'
      counters.lastError = null
      return { ok: true, file, engine: 'windows', chars: clean.length }
    } catch (e) {
      counters.failed += 1
      counters.lastError = String((e && e.message) || e).slice(0, 200)
      log('[tts] 合成失败：' + counters.lastError)
      return { ok: false, code: 'TTS_FAILED', error: counters.lastError }
    }
  }

  return {
    speak,
    /** 这个平台有没有可用引擎（Windows = 有）。 */
    available () { return WIN },
    view () {
      return {
        platform: process.platform,
        available: WIN,
        outDir,
        engine: 'windows',
        ok: counters.ok,
        failed: counters.failed,
        pruned: counters.pruned || 0,
        lastAt: counters.lastAt,
        lastError: counters.lastError,
        lastChars: counters.lastChars,
      }
    },
  }
}
