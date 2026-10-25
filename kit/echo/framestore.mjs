// framestore.mjs —— 会话日志的「帧索引 + 按 seq 直取」
//
// ┌ 为什么要这个模块 ────────────────────────────────────────────────┐
// │ 会话日志 session.v4.jsonl.zstd 不是一个大压缩块，而是几万个独立  │
// │ zstd 帧追加而成（本机实测 62,809 帧 / 237 MB / 解压后 576 MB）。│
// │                                                                │
// │ 旧路径 decodeZstd() 为了取一条记录，要把全部帧解压 + 全部       │
// │ JSON.parse —— 实测 memq open 一次 40.9 秒。                     │
// │                                                                │
// │ 本模块建一张帧偏移表，定位后只解 2~3 帧（约十几 KB），实测 1 ms。│
// │ ★ 它不删除也不替代 decodeZstd：需要全量记录的地方照旧用旧的，    │
// │   只有「给我第 N 条」这类查询走这里。                            │
// └────────────────────────────────────────────────────────────────┘
//
// 设计约束（都是踩过的坑）：
//  ① 索引必须带校验头（size + 首帧指纹）：日志被截断/重写时索引要能自证失效，
//     否则会拿旧索引去解新文件，返回错的记录 —— 那比慢更坏。
//  ② 帧是追加的，所以增量只能「从上次末尾往后补」，不能重扫全部。
//  ③ 一行 JSON 可能跨帧 → 取单帧时必须把相邻帧一起解，用 carry 拼。
//  ④ 拿不到索引/索引坏了 → 一律返回 null，由调用方降级回旧路径。宁慢勿错。

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])   // zstd 帧魔数
const IDX_VER = 1
const MAX_LINE = 8 * 1024 * 1024

/** 索引存放目录（和日志分开，不污染宿主目录） */
function idxDir(hub) {
  const d = path.join(hub, 'index', 'frames')
  try { fs.mkdirSync(d, { recursive: true }) } catch { /* 已存在 */ }
  return d
}

/** 某个日志对应的索引文件路径 */
function idxPath(hub, logPath) {
  const base = path.basename(logPath).replace(/[^\w.-]/g, '_')
  const dir = path.dirname(logPath).replace(/[^\w]/g, '_').slice(-40)
  return path.join(idxDir(hub), dir + '__' + base + '.frames.json')
}

/** 扫出所有帧的起始偏移（只扫魔数位置，不解压） */
function scanFrameStarts(buf) {
  const starts = []
  let i = 0
  while ((i = buf.indexOf(MAGIC, i)) !== -1) { starts.push(i); i += 4 }
  return starts
}

/** 解一帧并返回文本；失败返回 null（损坏帧不影响其他帧） */
function decompressFrame(buf, start, end) {
  try {
    return zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8')
  } catch {
    return null
  }
}

/** 从一段文本里抽出所有 "seq":N */
function seqRangeOf(txt) {
  let lo = Infinity
  let hi = -Infinity
  for (const line of txt.split('\n')) {
    if (!line) continue
    const m = line.match(/"seq"\s*:\s*(\d+)/)
    if (m) { const v = +m[1]; if (v < lo) lo = v; if (v > hi) hi = v }
  }
  return lo === Infinity ? null : { lo, hi }
}

/**
 * 读索引；不存在或校验不过就重建/增量补。
 * @returns {{frames:Array<{o:number,lo:number,hi:number}>, meta:object} | null}
 */
export function framesFor(logPath, hub) {
  let st
  try { st = fs.statSync(logPath) } catch { return null }

  const ip = idxPath(hub, logPath)
  let idx = null
  try {
    const raw = JSON.parse(fs.readFileSync(ip, 'utf8'))
    if (raw && raw.v === IDX_VER && Array.isArray(raw.frames) && raw.meta) idx = raw
  } catch { /* 没有或坏了 */ }

  // 校验：size 只能变大（追加）；变小说明被重写/截断 → 整个重建
  let needFull = false
  if (!idx) needFull = true
  else if (st.size < idx.meta.size) needFull = true
  else if (st.size === idx.meta.size && st.mtimeMs === idx.meta.mtimeMs) return idx   // ★ 命中，秒回
  // size 变大 → 增量补尾部

  const buf = fs.readFileSync(logPath)

  if (needFull) {
    const starts = scanFrameStarts(buf)
    const frames = []
    let bad = 0
    for (let k = 0; k < starts.length; k++) {
      const e = k + 1 < starts.length ? starts[k + 1] : buf.length
      const txt = decompressFrame(buf, starts[k], e)
      if (txt === null) { bad++; continue }
      const r = seqRangeOf(txt)
      frames.push({ o: starts[k], lo: r ? r.lo : -1, hi: r ? r.hi : -1 })
    }
    idx = {
      v: IDX_VER,
      meta: { size: st.size, mtimeMs: st.mtimeMs, frameCount: starts.length, badFrames: bad },
      frames,
    }
  } else {
    // 增量：从已知末尾往后扫新帧
    const from = idx.meta.size
    const tail = buf.subarray(from)
    const relStarts = scanFrameStarts(tail)
    for (let k = 0; k < relStarts.length; k++) {
      const s = from + relStarts[k]
      const e = k + 1 < relStarts.length ? from + relStarts[k + 1] : buf.length
      const txt = decompressFrame(buf, s, e)
      if (txt === null) continue
      const r = seqRangeOf(txt)
      idx.frames.push({ o: s, lo: r ? r.lo : -1, hi: r ? r.hi : -1 })
    }
    idx.meta.size = st.size
    idx.meta.mtimeMs = st.mtimeMs
    idx.meta.frameCount += relStarts.length
  }

  try { fs.writeFileSync(ip, JSON.stringify(idx), 'utf8') } catch { /* 写不了就用内存里的 */ }
  return idx
}

/**
 * 按 seq 直取一条记录。
 * @returns {object|null} 记录对象；找不到或索引不可用返回 null
 */
export function readSeq(logPath, hub, targetSeq) {
  const idx = framesFor(logPath, hub)
  if (!idx || !idx.frames.length) return null

  // 二分：找第一个 hi >= target 的帧
  let lo = 0
  let hi = idx.frames.length - 1
  let cand = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (idx.frames[mid].hi >= targetSeq) { cand = mid; hi = mid - 1 } else { lo = mid + 1 }
  }
  if (cand < 0) return null

  // ★★ 只读需要的字节区间，**不读整个文件**。
  //   第一版这里用了 fs.readFileSync(整个 237 MB)，实测 250~550 ms ——
  //   定位已经精确到帧了，却还是把 237 MB 抬进内存，白白多花几百毫秒。
  //   改成 open + readSync(position) 后只读三帧（约十几 KB）。
  //   判据：热查询应该是个位数毫秒，而不是几百毫秒。
  let fd
  try { fd = fs.openSync(logPath, 'r') } catch { return null }
  const fileSize = fs.fstatSync(fd).size

  // ★ 解 cand-1 / cand / cand+1 三帧：前一帧兜「行被截断在 cand 开头」，
  //   后一帧兜「行跨到 cand 结尾」。三帧约十几 KB，成本可忽略。
  const from = Math.max(0, cand - 1)
  const to = Math.min(idx.frames.length - 1, cand + 1)
  let carry = ''
  try {
  for (let k = from; k <= to; k++) {
    const s = idx.frames[k].o
    const e = k + 1 < idx.frames.length ? idx.frames[k + 1].o : fileSize
    const len = e - s
    if (len <= 0) continue
    const slice = Buffer.allocUnsafe(len)
    try { fs.readSync(fd, slice, 0, len, s) } catch { continue }
    const txt = decompressFrame(slice, 0, len)
    if (txt === null) continue
    const parts = (carry + txt).split('\n')
    carry = parts.pop() || ''
    for (const line of parts) {
      if (!line || line.length > MAX_LINE) continue
      const m = line.match(/"seq"\s*:\s*(\d+)/)
      if (!m || +m[1] !== targetSeq) continue
      try { return JSON.parse(line) } catch { return null }
    }
    if (carry.length > MAX_LINE) carry = ''
  }
  // 最后一行可能没换行符结尾
  if (carry) {
    const m = carry.match(/"seq"\s*:\s*(\d+)/)
    if (m && +m[1] === targetSeq) { try { return JSON.parse(carry) } catch { return null } }
  }
  return null
  } finally {
    // ★ 必须关句柄。memq 是短命进程、漏了看不出来，但 echo-doctor 会常驻反复调用，
    //   漏 fd 的后果是运行几天之后句柄耗尽 —— 那种故障排查起来极贵。
    try { fs.closeSync(fd) } catch { /* 已关或未开 */ }
  }
}

/** 索引状态（给 doctor / 自检用） */
export function indexStatus(logPath, hub) {
  const ip = idxPath(hub, logPath)
  try {
    const raw = JSON.parse(fs.readFileSync(ip, 'utf8'))
    const st = fs.statSync(logPath)
    return {
      path: ip,
      exists: true,
      frames: raw.frames.length,
      stale: raw.meta.size !== st.size,
      sizeBytes: fs.statSync(ip).size,
      meta: raw.meta,
    }
  } catch {
    return { path: ip, exists: false }
  }
}
