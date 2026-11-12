// WAV 小工具：把任意 PCM16 WAV 转成 DSH 语音识别要的 16kHz 单声道 PCM16 WAV。纯函数。

export function parseWav(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('不是 WAV')
  let off = 12
  let fmt = null
  let data = null
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    const start = off + 8
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(start), channels: buf.readUInt16LE(start + 2), rate: buf.readUInt32LE(start + 4), bits: buf.readUInt16LE(start + 14) }
    else if (id === 'data') data = buf.subarray(start, Math.min(buf.length, start + size))
    off = start + size + (size & 1)
  }
  if (!fmt || !data) throw new Error('WAV 缺 fmt 或 data')
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error('只支持 PCM16')
  return { ...fmt, data }
}

export function buildWav(samples, rate) {
  const out = Buffer.alloc(44 + samples.length * 2)
  out.write('RIFF', 0, 'ascii')
  out.writeUInt32LE(36 + samples.length * 2, 4)
  out.write('WAVE', 8, 'ascii')
  out.write('fmt ', 12, 'ascii')
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20)
  out.writeUInt16LE(1, 22)
  out.writeUInt32LE(rate, 24)
  out.writeUInt32LE(rate * 2, 28)
  out.writeUInt16LE(2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36, 'ascii')
  out.writeUInt32LE(samples.length * 2, 40)
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(samples[i], 44 + i * 2)
  return out
}

/** 混成单声道并线性重采样到 target Hz。 */
export function toMono16k(buf, target = 16000) {
  const { channels, rate, data } = parseWav(buf)
  const frames = Math.floor(data.length / (2 * channels))
  const mono = new Float64Array(frames)
  for (let i = 0; i < frames; i++) {
    let s = 0
    for (let c = 0; c < channels; c++) s += data.readInt16LE((i * channels + c) * 2)
    mono[i] = s / channels
  }
  const outLen = Math.max(1, Math.floor(frames * target / rate))
  const out = new Int16Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const pos = i * rate / target
    const a = Math.floor(pos)
    const b = Math.min(frames - 1, a + 1)
    const t = pos - a
    out[i] = Math.max(-32768, Math.min(32767, Math.round(mono[Math.min(a, frames - 1)] * (1 - t) + mono[b] * t)))
  }
  return buildWav(out, target)
}
