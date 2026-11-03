// dsh-yanqing-triad —— 宿主半（三策 · 三合一工作台）
//
// 三块：
//   ① 项目 —— 读砚台的 projects.json（**只读，不复制**：两份数据必然分叉）
//   ② 任务看板 —— 自己的本地记录（建卡 / 移动 / 删卡），**没有执行器**
//   ③ 三策 —— 三个 agent preset 的真实信息（读 .agent-presets/<id>/preset.yml）
//
// 为什么数据在宿主半：浏览器半碰不到文件系统，而且 client.js 是每次加载都要解析的启动期资源。
//
// 浏览器半只画界面，通过 /yanqing-triad/api/* 跟这里说话。
//
// ★ 宿主半只在 DSH 进程启动时加载一次 —— 改完必须重启 DSH 才生效。
//
// ★★ 出错不静默：每一块都带 ok / error 字段，界面把错误原样显示出来。
//    「静默变空」比报错更难查 —— 砚台 index.js:27-29 记过同一条教训。

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-yanqing-triad'
export const inject = ['webServer']

const ENV = (k) => String(process.env[k] || '').trim()
const HERE = dirname(fileURLToPath(import.meta.url))

// ── 三个路径：环境变量优先，其次本机默认，读不到就报错（不猜） ──────────

// 书房：砚台的 projects.json 在这里；看板数据也存在这里
// 理由同砚台 index.js:492「插件是可以重装的，东西不能跟着陪葬」
const SOUL = ENV('YANQING_TRIAD_SOUL') || 'D:\\AI\\yanqing-soul'

// DSH home：preset 目录在这里
// 探测顺序：① DSH_HOME 环境变量（DSH 自己注入的）
//   ② 从插件自己所在位置往上四层（<home>/profiles/<name>/node_modules/<pkg> → <home>）
const DSH_HOME = ENV('DSH_HOME') || join(HERE, '..', '..', '..', '..')

const PROJECTS_FILE = join(SOUL, '30-状态', '砚台', 'projects.json')
const TRIAD_DIR = join(SOUL, '30-状态', '三策')
const BOARD_FILE = join(TRIAD_DIR, 'board.json')
const PRESETS_DIR = join(DSH_HOME, '.agent-presets')

// ── 三策卡的定义（id 与角色；名字和描述从 preset.yml 读，不写死） ────────
const AGENT_SPECS = [
  { id: 'yanqing-ptc', role: '执行主力 · 批量读 / 搜 / 筛（Code Mode）', accent: '#4c9be8' },
  { id: 'yanqing-cordis', role: '执行主力 · Cordis / 插件开发', accent: '#d08a2c' },
  { id: 'yanqing-distill', role: '决策启发 · 不执行（先想他怎么看）', accent: '#8b7bd8' },
]

// ── 看板的五列：定义照抄看板插件 src/core/tasks.ts 的 COLUMNS ───────────
const COLUMNS = [
  { status: 'backlog', label: '待规划' },
  { status: 'todo', label: '待办' },
  { status: 'running', label: '进行中' },
  { status: 'done', label: '已完成' },
  { status: 'failed', label: '已失败' },
]
const STATUSES = COLUMNS.map((c) => c.status)

// ── 小工具 ──────────────────────────────────────────────────────────────
function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch (e) {
    return fallback
  }
}

function writeJson(file, value) {
  if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
}

function mtimeOf(file) {
  try {
    return existsSync(file) ? statSync(file).mtimeMs : 0
  } catch (e) {
    return 0
  }
}

function json(res, code, body) {
  const text = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  })
  res.end(text)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8')
      if (!s) return resolve({})
      try {
        resolve(JSON.parse(s))
      } catch (e) {
        reject(new Error('body 不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

// ── ① 项目：读砚台的数据（只读） ────────────────────────────────────
function readProjects() {
  try {
    if (!existsSync(PROJECTS_FILE)) {
      return {
        ok: false,
        error: '找不到 projects.json：' + PROJECTS_FILE,
        items: [],
        total: 0,
        file: PROJECTS_FILE,
        mtime: 0,
      }
    }
    const raw = readJson(PROJECTS_FILE, null)
    if (!Array.isArray(raw)) {
      return {
        ok: false,
        error: 'projects.json 不是数组（顶层是 ' + typeof raw + '）',
        items: [],
        total: 0,
        file: PROJECTS_FILE,
        mtime: mtimeOf(PROJECTS_FILE),
      }
    }
    const items = raw
      .filter((p) => p && typeof p === 'object')
      .map((p, i) => ({
        id: String(p.id || 'p-' + i),
        name: String(p.name || p.title || '(未命名)'),
        start: String(p.start || ''),
        end: String(p.end || ''),
        progress: Number.isFinite(Number(p.progress)) ? Math.max(0, Math.min(100, Number(p.progress))) : 0,
        note: String(p.note || ''),
      }))
    return {
      ok: true,
      items,
      total: items.length,
      file: PROJECTS_FILE,
      mtime: mtimeOf(PROJECTS_FILE),
    }
  } catch (e) {
    return {
      ok: false,
      error: String((e && e.message) || e),
      items: [],
      total: 0,
      file: PROJECTS_FILE,
      mtime: 0,
    }
  }
}

// ── ② 看板：本地记录 ─────────────────────────────────────────────────
function normalizeTask(t) {
  const now = Date.now()
  return {
    id: String(t.id),
    title: String(t.title || '(无标题)'),
    description: String(t.description || ''),
    status: STATUSES.includes(t.status) ? t.status : 'backlog',
    createdAt: Number(t.createdAt) || now,
    updatedAt: Number(t.updatedAt) || now,
  }
}

function readBoard() {
  try {
    if (!existsSync(BOARD_FILE)) {
      return { ok: true, tasks: [], total: 0, file: BOARD_FILE, mtime: 0, created: false }
    }
    const raw = readJson(BOARD_FILE, null)
    const arr = Array.isArray(raw) ? raw : raw && Array.isArray(raw.tasks) ? raw.tasks : []
    const tasks = arr.filter((t) => t && typeof t.id === 'string').map(normalizeTask)
    return { ok: true, tasks, total: tasks.length, file: BOARD_FILE, mtime: mtimeOf(BOARD_FILE), created: true }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), tasks: [], total: 0, file: BOARD_FILE, mtime: 0 }
  }
}

function saveBoard(tasks) {
  writeJson(BOARD_FILE, { version: 1, updatedAt: Date.now(), tasks })
  return { ok: true, total: tasks.length, file: BOARD_FILE, mtime: mtimeOf(BOARD_FILE) }
}

function newTaskId() {
  return 't-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)
}

// ── ③ 三策：读 preset（极简 YAML：只取顶层键 + 缩进续行） ──────────────
function parsePresetYml(text) {
  const out = {}
  let key = ''
  for (const rawLine of String(text).split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue
    const m = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(rawLine)
    if (m) {
      key = m[1]
      out[key] = m[2]
    } else if (key && /^\s+/.test(rawLine)) {
      out[key] = (out[key] ? out[key] + ' ' : '') + rawLine.trim()
    }
  }
  return out
}

function readAgents() {
  return AGENT_SPECS.map((spec) => {
    const dir = join(PRESETS_DIR, spec.id)
    const yml = join(dir, 'preset.yml')
    const exists = existsSync(dir)
    let display = ''
    let description = ''
    let order = 0
    if (exists && existsSync(yml)) {
      try {
        const meta = parsePresetYml(readFileSync(yml, 'utf8'))
        display = String(meta.name || '')
        description = String(meta.description || '')
        order = Number(meta.order) || 0
      } catch (e) {
        description = ''
      }
    }
    return {
      id: spec.id,
      role: spec.role,
      accent: spec.accent,
      name: display || spec.id,
      description,
      order,
      exists,
      dir,
      mtime: mtimeOf(yml),
    }
  })
}

// ── 插件主体 ────────────────────────────────────────────────────────────
export function apply(ctx) {
  const route = ctx.webServer.register({
    kind: 'prefix',
    path: '/yanqing-triad',
    handler: async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      const p = url.pathname.replace(/^\/yanqing-triad/, '') || '/'
      const method = String(req.method || 'GET').toUpperCase()
      try {
        // 一次给全 —— 界面开局只要一个请求
        if (p === '/api/state' && method === 'GET') {
          return json(res, 200, {
            ok: true,
            builtAt: new Date().toISOString(),
            projects: readProjects(),
            board: readBoard(),
            agents: readAgents(),
            columns: COLUMNS,
            paths: {
              soul: SOUL,
              dshHome: DSH_HOME,
              projectsFile: PROJECTS_FILE,
              boardFile: BOARD_FILE,
              presetsDir: PRESETS_DIR,
            },
          })
        }

        // 健康检查（curl 用；也用来区分「插件没跑到」和「路径不对」）
        if (p === '/api/health' && method === 'GET') {
          return json(res, 200, { ok: true, name: 'dsh-yanqing-triad' })
        }

        // 建卡
        if (p === '/api/tasks' && method === 'POST') {
          const body = await readBody(req)
          const title = String(body.title || '').trim()
          if (!title) return json(res, 400, { ok: false, error: '标题不能为空' })
          const status = STATUSES.includes(body.status) ? body.status : 'todo'
          const board = readBoard()
          if (!board.ok) return json(res, 500, { ok: false, error: board.error })
          const now = Date.now()
          const task = normalizeTask({
            id: newTaskId(),
            title,
            description: String(body.description || ''),
            status,
            createdAt: now,
            updatedAt: now,
          })
          const tasks = board.tasks.concat([task])
          saveBoard(tasks)
          return json(res, 200, { ok: true, task, total: tasks.length })
        }

        // 移动 / 改标题 / 改描述
        if (p.startsWith('/api/tasks/') && method === 'PATCH') {
          const id = decodeURIComponent(p.slice('/api/tasks/'.length))
          const body = await readBody(req)
          const board = readBoard()
          if (!board.ok) return json(res, 500, { ok: false, error: board.error })
          const idx = board.tasks.findIndex((t) => t.id === id)
          if (idx < 0) return json(res, 404, { ok: false, error: '没有这张卡：' + id })
          const prev = board.tasks[idx]
          const next = Object.assign({}, prev, { updatedAt: Date.now() })
          if (body.status !== undefined) {
            if (!STATUSES.includes(body.status)) {
              return json(res, 400, { ok: false, error: '非法状态：' + String(body.status) })
            }
            next.status = body.status
          }
          if (body.title !== undefined) {
            const t = String(body.title).trim()
            if (!t) return json(res, 400, { ok: false, error: '标题不能为空' })
            next.title = t
          }
          if (body.description !== undefined) next.description = String(body.description)
          const tasks = board.tasks.slice()
          tasks[idx] = next
          saveBoard(tasks)
          return json(res, 200, { ok: true, task: next, total: tasks.length })
        }

        // 删卡
        if (p.startsWith('/api/tasks/') && method === 'DELETE') {
          const id = decodeURIComponent(p.slice('/api/tasks/'.length))
          const board = readBoard()
          if (!board.ok) return json(res, 500, { ok: false, error: board.error })
          const tasks = board.tasks.filter((t) => t.id !== id)
          if (tasks.length === board.tasks.length) return json(res, 404, { ok: false, error: '没有这张卡：' + id })
          saveBoard(tasks)
          return json(res, 200, { ok: true, total: tasks.length })
        }

        return json(res, 404, { ok: false, error: '没有这个路径：' + method + ' ' + p })
      } catch (e) {
        return json(res, 500, { ok: false, error: String((e && e.message) || e) })
      }
    },
  })

  ctx.effect(() => route, 'dsh-yanqing-triad: routes')
}
