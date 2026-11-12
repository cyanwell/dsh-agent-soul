// aurabot 面板的静态文件路由
// ============================================================================
// 为什么要单独一个：client.js 是 aurabot 自己的前端（255KB），它靠 <script src> 加载；
// React 也在本地 vendor 里。这些都不该塞进 v4 的页面表（PAGE_OF 只放 v4 自己的页）。
//
// ★ 只服务白名单里的路径 —— 不做「按 URL 拼磁盘路径」那种事，
//   那样一个 .. 就能读到任意文件。**每个路径对应一个确定的文件，写死。**
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'

const MIME = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

/**
 * 处理 aurabot 面板相关的静态资源。命中返回 true。
 * @param {object} req @param {object} res
 * @param {{webDir:string, aurabotDir:string}} o
 */
export function handleAurabotStatic (req, res, o) {
  if (req.method !== 'GET') return false
  let p = ''
  try { p = new URL(req.url, 'http://x').pathname } catch { return false }

  const webDir = (o && o.webDir) || ''
  const abDir = (o && o.aurabotDir) || ''

  // 白名单：路径 → 绝对文件
  let file = ''
  if (p === '/aurabot-client.js') {
    file = path.join(abDir, 'client', 'client.js')
  } else if (p === '/aurabot-panel' || p === '/aurabot-panel.html') {
    file = path.join(webDir, 'aurabot-panel.html')
  } else if (p.startsWith('/vendor/')) {
    const name = p.slice('/vendor/'.length)
    // ★ 只允许单层文件名，且不许 .. —— 白名单式，不是拼接式
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return false
    file = path.join(webDir, 'vendor', name)
  } else {
    return false
  }

  try {
    if (!fs.existsSync(file)) {
      const body = JSON.stringify({ ok: false, error: '文件不存在', file: path.basename(file) })
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
      res.end(body)
      return true
    }
    const buf = fs.readFileSync(file)
    const ext = path.extname(file).toLowerCase()
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
    })
    res.end(buf)
    return true
  } catch (e) {
    const body = JSON.stringify({ ok: false, error: String((e && e.message) || e).slice(0, 200) })
    try { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) }); res.end(body) } catch (e2) {}
    return true
  }
}