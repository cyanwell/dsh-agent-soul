// 本地接口 · 语音合成：用你电脑上的 TTS 服务念她要说的话（替换内置的 edge-tts / Windows 语音）。
// 约定见同目录的「README-本地接口.md」。改完保存就生效，不用重启 DSH；面板「本地接口」页可以点「试一下」。
//
// 输入：{ text, outDir, log }
//   text   要念的文字
//   outDir 可以放生成文件的文件夹
//   log    log.info(...) / log.warn(...) 会出现在面板「日志」里
// 输出：音频文件路径（wav / mp3 / silk），或 { file: 路径 }
// 出错就 throw，插件会自动退回内置语音。

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ↓↓↓ 示例：GPT-SoVITS 的 api_v2（在 GPT-SoVITS 目录里运行 python api_v2.py，默认 http://127.0.0.1:9880）
// 把参考音频路径、参考音频里说的话换成你自己的。
const API = 'http://127.0.0.1:9880/tts'
const REF_AUDIO = 'D:/voices/ref.wav'
const REF_TEXT = '参考音频里说的那句话'

export default async function tts({ text, outDir, log }) {
  const params = new URLSearchParams({
    text,
    text_lang: 'zh',
    ref_audio_path: REF_AUDIO,
    prompt_text: REF_TEXT,
    prompt_lang: 'zh',
    media_type: 'wav',
  })
  const r = await fetch(`${API}?${params}`, { signal: AbortSignal.timeout(60000) })
  if (!r.ok) throw new Error(`TTS 服务返回 ${r.status}：${(await r.text()).slice(0, 200)}`)
  const file = join(outDir, `tts-${Date.now()}.wav`)
  writeFileSync(file, Buffer.from(await r.arrayBuffer()))
  log.info(`本地 TTS 念好了：${text.slice(0, 20)}`)
  return file
}
