// parse-cidian.mjs —— 把《词效词典》解析成结构化 JSON
//
// ★ 2026-10-06 改版：词典从「按批次」改成「按词条」，这里跟着改。
//   旧格式：批次 1..7，每批一段说明 + 一张表（词 / KB / 实看效果 / 判定）。
//   新格式：一条一个词，字段固定（类别 / 原词 / 效果 / 判定 / 量化 / 出处 / 图）。
//   为什么改（爀曦 2026-10-06 拍板）：按批次组织查不动 —— 同一个词会散在不同批次里，
//   而且表格里塞不下图。改成词条之后，前端能搜索、能按类别筛、能一条配一张图。
//
// 为什么放脚本而不是把数据烘进 client.js：
//   ★ 词典会继续长（每做完一批消融就追加）。烘进界面 = 每次更新都要改代码 + 重新部署。
//     现解析 = 改完 md 刷新页面就看到了。
//   ★ 而且 client.js 是启动期资源，塞十几 KB 数据进去不划算。
//
// 判读纪律（继承词典本身）：
//   ★ 这里只做【搬运】，不做解释、不做总结、不改一个字。
//     词典里没写的，这里也不会凭空出现。

import { readFileSync, existsSync } from 'node:fs'

export const CIDIAN_PATH = 'D:\\AI\\yanqing-soul\\70-形象\\形象工程\\05-文档\\词效词典.md'

// ★ 图片实例的目录。前端拿不到本地路径，所以宿主半要另开一个只读路由把它送出去
//   （index.js 的 /api/cidian-img）。这里只导出路径，不读文件 —— 读文件是路由的事。
export const CIDIAN_IMG_DIR = 'D:\\AI\\yanqing-soul\\70-形象\\形象工程\\03-实验产物\\stickers'

const FIELD = /^-\s*([^：:]+)[：:]\s*(.*)$/ // - 类别：光照
const HEAD = /^#{3}\s+(.+?)\s*$/ // ### 光照 · rim light

export function parseCidian(src = CIDIAN_PATH) {
  if (!existsSync(src)) {
    return { ok: false, message: '词典文件不在：' + src, source: src }
  }
  const text = readFileSync(src, 'utf8')
  const lines = text.split(/\r?\n/)

  const out = {
    ok: true,
    source: src,
    imgDir: CIDIAN_IMG_DIR,
    bytes: Buffer.byteLength(text, 'utf8'),
    lines: lines.length,
    title: '词效词典',
    intro: [], // 开头那段引用（任务、方法、量化代理、判读纪律、基线）
    laws: [], // ★★★ 贯穿性总规律（最重要，放最前）
    entries: [], // 词条
    categories: [], // 去重后的类别，保持词典里的出现顺序
    notes: [], // 结尾的方法论备注 + 各类的「本类结论」
  }

  let zone = 'intro' // intro | laws | entries | notes
  let cur = null // 正在填的那个对象

  const flush = () => {
    if (!cur) return
    if (cur.kind === 'law') out.laws.push(cur)
    else if (cur.kind === 'entry') out.entries.push(cur)
    else if (cur.kind === 'note') out.notes.push(cur)
    cur = null
  }

  for (const raw of lines) {
    const t = raw.trim()

    // 二级标题 = 换区
    if (/^##\s+/.test(t)) {
      flush()
      if (t.includes('总规律')) zone = 'laws'
      else if (t.includes('词条')) zone = 'entries'
      else if (t.includes('备注') || t.includes('边界') || t.includes('方法论')) zone = 'notes'
      continue
    }

    // 引言是 > 引用块 —— 逐行收，前端自己排版
    if (t.startsWith('>')) {
      out.intro.push(t.replace(/^>\s?/, ''))
      continue
    }

    if (!t) {
      continue
    }

    // 三级标题 = 新对象
    if (HEAD.test(t)) {
      const title = t.replace(/^#{3}\s+/, '').trim()
      flush()
      // 「光照 · 本类结论」这种归到 notes，并带上类别（便于前端按类别显示）
      if (/结论\s*$/.test(title)) {
        const cat = title.includes('·') ? title.split('·')[0].trim() : ''
        cur = { kind: 'note', title, category: cat, body: [] }
        continue
      }
      if (zone === 'laws') {
        cur = { kind: 'law', title, body: [] }
      } else if (zone === 'notes') {
        cur = { kind: 'note', title, body: [] }
      } else {
        const parts = title.split('·')
        const cat = parts.length > 1 ? parts[0].trim() : '未分类'
        const name = parts.length > 1 ? parts.slice(1).join('·').trim() : title
        cur = { kind: 'entry', category: cat, name, fields: {}, body: [] }
      }
      continue
    }

    // 词条字段：- 键：值
    const m = t.match(FIELD)
    if (m && cur && cur.kind === 'entry') {
      cur.fields[m[1].trim()] = m[2].trim()
      continue
    }

    if (cur) cur.body.push(t)
  }
  flush()

  // 类别清单（保持出现顺序，不给前端排序 —— 顺序本身是信息）
  const seen = new Set()
  for (const e of out.entries) {
    if (!seen.has(e.category)) {
      seen.add(e.category)
      out.categories.push(e.category)
    }
  }

  return out
}
