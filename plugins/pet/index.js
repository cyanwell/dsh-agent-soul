// dsh-yanqing-pet · 宿主半
//
// ★ 2026-09-24 改版：从"client.js 内嵌 base64"改成"同源 HTTP 路由"。
//
// 为什么改（不是洁癖，是算出来的）：
//   表情从 10 张加到 18 张、再加 32 帧动画序列，一共 50 张图。
//   按 base64 内嵌的话 client.js 会到 2 MB 以上，而它是【每次页面加载都要解析】的
//   启动期资源 —— 为了几只宠物把首屏拖慢不划算。
//   走路由之后浏览器自己会缓存、只加载真正用到的那几帧，client.js 只剩十几 KB。
//
// 这个模式抄自同项目的 dsh-yanqing-3d（它整个模型 + three.js 都走自己注册的
// /yanqing-3d/* 路由），以及 dsh-clawbot。
//
// ★ 路由必须用 ctx.effect() 包起来，否则插件卸载时路由不会撤销。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export const name = 'dsh-yanqing-pet'

export const inject = ['webServer']

const HERE = dirname(fileURLToPath(import.meta.url))
const ASSETS = join(HERE, 'assets')
// ★ 2026-09-29：`/yanqing-pet` → `/yanqing-pet-v3`。
//   换素材时【前缀必须动】—— 文件名不变 ⇒ URL 不变 ⇒ 浏览器吃 24 小时缓存里的旧图，
//   于是"服务端换好了、界面上还是旧的"，硬刷新也不好使。改前缀 = 全部地址翻新。
//   ★ 以后再换素材：这里 + client-template.js 的 API 一起加编号，然后 build-client.py。
const PREFIX = '/yanqing-pet-v3'

// 进程内缓存：这些图在运行期不会变，读一次就够（每张 ~35 KB，50 张 = 1.9 MB）
const cache = new Map()

function load(rel) {
  if (cache.has(rel)) return cache.get(rel)
  const buf = readFileSync(join(ASSETS, rel))
  cache.set(rel, buf)
  return buf
}

/** 扫描一个子目录，返回 [路由, 相对路径] 列表 */
function scan(sub, ext) {
  const dir = join(ASSETS, sub)
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((n) => n.endsWith(ext))
    .sort()
    .map((n) => [PREFIX + '/' + sub + '/' + n, sub + '/' + n])
}

export function apply(ctx) {
  const routes = [...scan('faces', '.webp'), ...scan('frames', '.webp'), ...scan('poses', '.webp')]

  for (const [route, rel] of routes) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: route,
      handler: (_req, res) => {
        let buf
        try {
          buf = load(rel)
        } catch (e) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('yanqing-pet asset missing: ' + rel + '\n' + String(e && e.message))
          return
        }
        res.writeHead(200, {
          'content-type': 'image/webp',
          'content-length': String(buf.length),
          // ★ 2026-09-29 改：原来是 `public, max-age=86400`。
          //   那在【换素材】时是致命的 —— 文件名不变 ⇒ URL 不变 ⇒ 浏览器 24 小时不来问，
          //   于是"服务端明明换好了、界面上还是旧的那张"，而且硬刷新也不好使（缓存没过期）。
          //   这些是本地小图（每张十几 KB），每次重取的开销远小于一次「看到旧脸」的排查成本。
          'cache-control': 'no-store',
        })
        res.end(buf)
      },
    }), 'yanqing-pet: ' + rel)
  }

  // 清单：客户端启动时拉一次，就知道有哪些表情、每个动作有多少帧
  // （不用把文件名写死在 JS 里，加素材只要丢文件进目录）
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PREFIX + '/manifest.json',
    handler: (_req, res) => {
      const faces = routes.filter(([, r]) => r.startsWith('faces/'))
        .map(([, r]) => r.slice(6, -5))
      const frames = {}
      for (const [, r] of routes) {
        const m = /^frames\/([a-z]+)-(\d+)\.webp$/.exec(r)
        if (!m) continue
        ;(frames[m[1]] = frames[m[1]] || []).push(PREFIX + '/' + r)
      }
      // ★ 2026-10-05：姿势层（每张一张立绘，不是序列）——
      //   键是姿势名（sit / squat / lie / lean / corner / stretch），值是 URL。
      const poses = {}
      for (const [, r] of routes) {
        const m = /^poses\/([a-z]+)\.webp$/.exec(r)
        if (!m) continue
        poses[m[1]] = PREFIX + '/' + r
      }
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(JSON.stringify({
        ok: true,
        faceBase: PREFIX + '/faces/',
        faces,
        frames,
        poses,
      }))
    },
  }), 'yanqing-pet: manifest')

  // 探活：一条命令确认包和全部素材都就位，不用去翻浏览器
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PREFIX + '/health',
    handler: (_req, res) => {
      const out = { ok: true, count: routes.length, faces: 0, frames: {}, missing: [] }
      for (const [route, rel] of routes) {
        try {
          statSync(join(ASSETS, rel))
          if (rel.startsWith('faces/')) out.faces++
          else {
            const g = /^frames\/([a-z]+)-/.exec(rel)
            if (g) out.frames[g[1]] = (out.frames[g[1]] || 0) + 1
          }
        } catch {
          out.missing.push(route)
        }
      }
      out.ok = out.missing.length === 0
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(out))
    },
  }), 'yanqing-pet: health')

  if (ctx.logger && typeof ctx.logger.info === 'function') {
    ctx.logger.info('[dsh-yanqing-pet] ' + routes.length + ' 个素材路由已注册')
  }
}
