// 图片小工具：找 ffmpeg、把图缩小（生图的结果要回传给模型时用，太大的图不能直接塞进上下文）。

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mimeOf } from '../chat/inbound.js'

const EXE = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'

/** ffmpeg 在哪：配置里填的 > PATH 里的 > 几个常见安装位置。找不到返回 ''。 */
export function findFfmpeg(configured = '', { pathEnv = process.env.PATH || '', exists = existsSync } = {}) {
  const sep = process.platform === 'win32' ? ';' : ':'
  const cands = []
  const own = String(configured || '').trim()
  if (own) cands.push(own)
  for (const d of String(pathEnv).split(sep)) if (d && d.trim()) cands.push(join(d.trim(), EXE))
  if (process.platform === 'win32') cands.push('C:\\ffmpeg\\bin\\ffmpeg.exe', 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe')
  else cands.push('/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg')
  for (const c of cands) { try { if (exists(c)) return c } catch (error) {} }
  return ''
}

/**
 * 把图缩到 maxSide 以内，输出 JPEG（走 stdin/stdout，不落临时文件）。
 * 失败 / 没 ffmpeg 返回 null，不抛。
 */
/**
 * 找宿主自带的 sharp：先在插件自己能解析的地方找，再找 DSH（Electron）的 app.asar。
 * 找到了就用它缩图，用户不必另外装 ffmpeg。找不到返回 null。
 */
export async function findSharp({ resourcesPath = process.resourcesPath, importer = (u) => import(u) } = {}) {
  try {
    const m = await importer('sharp')
    if (m) return m.default || m
  } catch (error) {}
  const cands = resourcesPath ? [
    join(resourcesPath, 'app.asar', 'dsh', 'node_modules', 'sharp', 'dist', 'index.mjs'),
    join(resourcesPath, 'dsh', 'node_modules', 'sharp', 'dist', 'index.mjs'),
    join(resourcesPath, 'app', 'node_modules', 'sharp', 'dist', 'index.mjs'),
  ] : []
  for (const file of cands) {
    if (!existsSync(file)) continue
    try {
      const m = await importer(pathToFileURL(file).href)
      if (m) return m.default || m
    } catch (error) {}
  }
  return null
}

/** 用 sharp 缩图（输出 JPEG）；sharp 不可用或出错返回 null，不抛。 */
export async function shrinkWithSharp(sharp, buf, maxSide) {
  if (typeof sharp !== 'function') return null
  try {
    const out = await sharp(buf)
      .rotate()
      .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer()
    return Buffer.isBuffer(out) && out.length ? out : null
  } catch (error) {
    return null
  }
}

export function shrinkImage(buf, maxSide, ffmpeg, { timeoutMs = 30000 } = {}) {
  if (!ffmpeg) return Promise.resolve(null)
  return new Promise((resolve) => {
    let settled = false
    const finish = (v) => { if (!settled) { settled = true; resolve(v) } }
    let proc
    try {
      proc = spawn(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-i', 'pipe:0',
        '-vf', `scale='min(${maxSide},iw)':-2`,
        '-q:v', '4', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1',
      ], { windowsHide: true })
    } catch (error) {
      return finish(null)
    }
    const out = []
    const timer = setTimeout(() => { try { proc.kill() } catch (error) {} ; finish(null) }, timeoutMs)
    proc.stdout.on('data', (d) => out.push(d))
    proc.stderr.on('data', () => {}) // 占位，别让管道堵住
    // ffmpeg 可能在输入写完前退出（坏图、路径不对等）；stdin 的异步错误不能让宿主进程崩溃。
    proc.stdin.on('error', () => { clearTimeout(timer); try { proc.kill() } catch (error) {} ; finish(null) })
    proc.on('error', () => { clearTimeout(timer); finish(null) })
    proc.on('close', () => { clearTimeout(timer); const b = Buffer.concat(out); finish(b.length ? b : null) })
    try { proc.stdin.end(buf) } catch (error) { finish(null) }
  })
}

/**
 * 工具结果里要带的那张图：太大的先缩图，再交给 DSH 的附件服务登记成附件块。
 * ⚠ 必须走附件服务：模型适配层只认附件块，把 base64 直接塞进工具结果会让下一轮请求整轮失败
 * （实测 2MB 的 PNG 直接塞进去 → "DeepSeek Messages transport failed"，重试 5 次全挂）。
 * 缩图或登记失败都返回 null —— 只给文字，宁可少给也不要崩。
 */
export async function imageToolBlock (dsh, buf, { ffmpegPath = '', maxSide = 1024, maxBytes = 500 * 1024, log = null } = {}) {
  if (!dsh) return null
  let data = buf
  let mediaType = mimeOf(buf)
  if (buf.length > maxBytes) {
    const ffmpeg = findFfmpeg(ffmpegPath)
    let small = ffmpeg ? await shrinkImage(buf, maxSide, ffmpeg) : null
    // 没装 ffmpeg 时用 DSH 自带的 sharp（libvips），用户不必额外安装
    if (!small) small = await shrinkWithSharp(await findSharp(), buf, maxSide)
    if (!small || small.length > maxBytes) {
      log?.debug?.(`图片 ${Math.round(buf.length / 1024)}KB 太大又缩不了，工具结果里就不带图了`)
      return null
    }
    log?.debug?.(`工具结果里的图缩到 ${Math.round(small.length / 1024)}KB（原 ${Math.round(buf.length / 1024)}KB）`)
    data = small
    mediaType = 'image/jpeg'
  }
  const att = dsh.attachments || (typeof dsh.get === 'function' ? dsh.get('attachments') : null)
  if (!att || typeof att.admitPromptContent !== 'function') return null
  try {
    const [block] = await att.admitPromptContent([{ type: 'image', data: data.toString('base64'), mediaType }])
    if (block && block.type === 'image' && block.attachment) {
      const registered = { ...block }
      delete registered.data // 登记过的附件块不再携带原始 base64。
      return registered
    }
    log?.debug?.('宿主没把图登记成附件块，工具结果里不带图')
  } catch (error) {
    log?.debug?.('图片的图登记成附件失败：', error.message)
  }
  return null
}
