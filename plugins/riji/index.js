// dsh-agent-riji —— 宿主半
//
// 干什么：把一个目录里的 markdown 日记递给浏览器。
//
// ★ 为什么必须有宿主半：
//   浏览器半碰不到文件系统。顶栏那几格里凡是「显示磁盘上东西」的，
//   背后都有一个像这样的宿主半在供数 —— 砚台显示水位和未结的活也是这个道理。
//   浏览器半只负责画，不负责读。
//
// 路由（前缀 /riji）：
//   OPTIONS /api/*            → CORS 预检（桌面端 origin 是 file://，没这个头就是 Failed to fetch）
//   GET /api/list             → 日记目录：文件名 / 标题 / 字节 / 修改时间
//   GET /api/doc?name=x.md    → 某一篇的原文（markdown 原文，渲染交给浏览器半）

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'dsh-agent-riji'
export const inject = ['webServer']

const DIARY_DIR = process.env.RIJI_DIR || join(process.cwd(), 'diary')

function json(res, status, obj) {
  const body = JSON.stringify(obj)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

// 从 markdown 里抠第一个一级标题当标题；没有就用文件名
function titleOf(text, fallback) {
  const m = text.match(/^[ \t]*#[ \t]+(.+?)[ \t]*$/m)
  return m ? m[1].trim() : fallback
}

// ★ 文件名要塞进 URL 查询串，所以要防目录穿越。
//   只接受「纯文件名 + .md」，不许带路径分隔符、不许 ..，也不许绝对路径。
function safeName(raw) {
  const s = String(raw || '')
  if (!s) return ''
  if (s.includes('/') || s.includes('\\') || s.includes('..')) return ''
  if (!/\.md$/i.test(s)) return ''
  return s
}

function listDiary() {
  if (!existsSync(DIARY_DIR)) return []
  let names = []
  try {
    names = readdirSync(DIARY_DIR).filter((n) => /\.md$/i.test(n))
  } catch {
    return []   // 目录读不了就当空的，别把整条路由打挂
  }
  const out = []
  for (const n of names) {
    const full = join(DIARY_DIR, n)
    let size = 0
    let mtime = 0
    let title = n.replace(/\.md$/i, '')
    try {
      const st = statSync(full)
      size = st.size
      mtime = st.mtimeMs
      // 读前 2KB 足够找到标题，不必整篇读
      const head = readFileSync(full, 'utf8').slice(0, 2048)
      title = titleOf(head, title)
    } catch {
      // 单篇读不了就跳过它的标题，不让整次列目录失败
    }
    out.push({ name: n, title, size, mtime })
  }
  // ★ 按文件名排，不按时间 —— 日记的编号（01、02…10）本身就是阅读顺序，
  //   mtime 会因为「今天补了一句」把旧篇顶到最前面，那不是想要的次序。
  out.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  return out
}

export function apply(ctx) {
  const route = ctx.webServer.register({
    kind: 'prefix',
    path: '/riji',
    handler: async (req, res) => {
      // ★ 和丹房同一条教训：桌面端页面 origin 是 file:// 或 app://，
      //   从这种页面 fetch http://127.0.0.1:19387 属于跨域。缺这几个头就是
      //   `Failed to fetch`，而界面只会显示「载入中」—— 一个错都不吐。
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'content-type')
      if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end() }

      const url = new URL(req.url, 'http://127.0.0.1')
      const p = url.pathname.replace(/^\/riji/, '') || '/'

      try {
        if (p === '/api/list') {
          const docs = listDiary()
          return json(res, 200, { ok: true, dir: DIARY_DIR, count: docs.length, docs })
        }

        if (p === '/api/doc') {
          const nm = safeName(url.searchParams.get('name'))
          if (!nm) return json(res, 400, { ok: false, message: '文件名不合法' })
          const full = join(DIARY_DIR, nm)
          if (!existsSync(full)) return json(res, 404, { ok: false, message: '没有这一篇：' + nm })
          const text = readFileSync(full, 'utf8')
          return json(res, 200, { ok: true, name: nm, title: titleOf(text, nm), text, bytes: Buffer.byteLength(text, 'utf8') })
        }

        return json(res, 404, { ok: false, message: '没有这条路由：' + p })
      } catch (e) {
        return json(res, 500, { ok: false, message: String((e && e.message) || e) })
      }
    },
  })
  return route
}
