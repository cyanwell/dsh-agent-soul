// 本地接口 · 语音识别：别人发来的语音条，用你电脑上的识别服务转成文字（在 QQ 自带转文字之前先试）。
// 约定见同目录的「README-本地接口.md」。改完保存就生效，不用重启 DSH。
//
// 输入：{ file, log }
//   file  语音条转好的 wav（16kHz、单声道）
// 输出：识别出来的文字（字符串），或 { text }。听不清就返回空字符串
// 出错就 throw，插件会接着试 QQ 自带转文字和 DSH 自带识别。

import { readFileSync } from 'node:fs'

// ↓↓↓ 示例：一个接收 wav、返回 {"text": "..."} 的本地 HTTP 服务（FunASR、faster-whisper 之类包一层就行）
const API = 'http://127.0.0.1:8000/asr'

export default async function asr({ file }) {
  const form = new FormData()
  form.append('file', new Blob([readFileSync(file)], { type: 'audio/wav' }), 'voice.wav')
  const r = await fetch(API, { method: 'POST', body: form, signal: AbortSignal.timeout(60000) })
  if (!r.ok) throw new Error(`识别服务返回 ${r.status}`)
  const j = await r.json()
  return String(j.text || '').trim()
}
