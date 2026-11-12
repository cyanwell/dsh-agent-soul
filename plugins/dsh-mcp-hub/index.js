/**
 * dsh-mcp-hub — 本机所有 MCP 服务器的唯一入口（宿主半）。
 *
 * 两段的边界：
 *   第一段（已验收）：清单读取 / MCP JSON-RPC（stdio 逐行 JSON）/ 工具注册与注销。
 *   第二段（本版）：增删改查 HTTP 路由、streamable-http 传输、动态连接管理。
 *
 * 硬约束：
 *   1. 清单 $DSH_HOME/mcp-hub/servers.json 是唯一真相源（写盘用 tmp+rename 原子替换）。
 *   2. 不 import @deepseek-ai/dsh-mcp-client —— 那是另一条通道，用了"唯一入口"就漏了。
 *   3. 工具名 `mcp__<serverName>__<rawName>`；tools/call 只发原始名。
 *   4. stdio 是**逐行 JSON**，不是 LSP 的 Content-Length 头。
 *
 * 导出这些构件是为了让 _probe.mjs / _verify-http.mjs / _routes.mjs 在不启动 DSH
 * 的情况下直接 import 验证。
 */

import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, appendFileSync } from 'node:fs'
import { join, dirname, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'

export const name = 'dsh-mcp-hub'

/** 需要宿主的工具注册表和 HTTP 路由。 */
export const inject = ['tools', 'webServer']

/* ── 清单 ─────────────────────────────────────────────────────── */

const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/
const MAX_PUBLIC_NAME_LENGTH = 64
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g
const TRANSPORTS = new Set(['stdio', 'streamable-http'])

export function dshHome() {
  return process.env.DSH_HOME || 'D:\\AI\\dsh\\home'
}

export function serversFilePath() {
  if (process.env.DSH_MCP_HUB_SERVERS) return process.env.DSH_MCP_HUB_SERVERS
  return join(dshHome(), 'mcp-hub', 'servers.json')
}

function toArgs(value) {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string') return value.split(/\s+/).map((s) => s.trim()).filter(Boolean)
  return []
}

function toHeaders(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined || v === null) continue
    out[String(k)] = String(v)
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * 把一条清单条目规范成内部配置。非法时抛中文错误（路由直接把它当 400 返回）。
 * 这是写盘和连接共用的唯一校验点。
 */
export function normalizeEntry(input, { partial = false, base = null } = {}) {
  const src = { ...(base ?? {}), ...(input ?? {}) }
  const serverName = String(src.serverName ?? '').trim()
  if (!SERVER_NAME_RE.test(serverName)) {
    throw new Error(`serverName 非法（要 [A-Za-z0-9_-]{1,32}）：${JSON.stringify(serverName)}`)
  }
  const transport = String(src.transport ?? 'stdio')
  if (!TRANSPORTS.has(transport)) {
    throw new Error(`transport 只支持 stdio / streamable-http，收到 ${JSON.stringify(transport)}`)
  }
  // 工具级禁用：清单里写「原始工具名」（如 PowerShell / Registry / FileSystem），
  // 连接时这些工具不注册进 ctx.tools。服务器级 enabled 管"连不连"，这里管"连上后放出哪些"。
  const disabledTools = Array.isArray(src.disabledTools)
    ? src.disabledTools.map((x) => String(x).trim()).filter(Boolean)
    : []
  const config = {
    serverName,
    transport,
    enabled: src.enabled !== false,
    toolCallTimeoutMs: Number(src.toolCallTimeoutMs) > 0 ? Number(src.toolCallTimeoutMs) : 60000,
  }
  if (disabledTools.length) config.disabledTools = disabledTools
  if (transport === 'stdio') {
    const command = String(src.command ?? '').trim()
    if (!command) throw new Error('stdio 服务器缺少 command')
    config.command = command
    config.args = toArgs(src.args)
    config.env = src.env && typeof src.env === 'object' && !Array.isArray(src.env) ? { ...src.env } : {}
    if (src.cwd) config.cwd = String(src.cwd)
    if (src.connectTimeoutMs) config.connectTimeoutMs = Number(src.connectTimeoutMs)
  } else {
    const url = String(src.url ?? '').trim()
    if (!url) throw new Error('streamable-http 服务器缺少 url')
    let parsed
    try { parsed = new URL(url) } catch { throw new Error(`url 不是合法 URL：${url}`) }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('url 只支持 http / https')
    config.url = url
    const headers = toHeaders(src.headers)
    if (headers) config.headers = headers
    if (src.connectTimeoutMs) config.connectTimeoutMs = Number(src.connectTimeoutMs)
  }
  // partial=false 时把非本传输的字段丢掉，保证清单干净（避免 stdio 条目残留 url）。
  if (partial) return { config, raw: src }
  return config
}

/** 读清单（只读，不改盘）。返回 { file, servers, problems, error? }。 */
export function loadServers(file = serversFilePath()) {
  if (!existsSync(file)) return { file, servers: [], error: `清单不存在：${file}` }
  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    return { file, servers: [], error: `清单不是合法 JSON：${String(e?.message || e)}` }
  }
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.servers) ? raw.servers : []
  const servers = []
  const problems = []
  for (const entry of list) {
    const serverName = String(entry?.serverName ?? entry?.name ?? '').trim()
    if (!SERVER_NAME_RE.test(serverName)) {
      problems.push(`serverName 非法（要 [A-Za-z0-9_-]{1,32}）：${JSON.stringify(serverName)}`)
      continue
    }
    const transport = entry?.transport ?? 'stdio'
    if (!TRANSPORTS.has(transport)) {
      problems.push(`${serverName}: transport 只支持 stdio / streamable-http，收到 ${JSON.stringify(transport)}`)
      continue
    }
    try {
      servers.push(normalizeEntry({ ...entry, serverName, transport }))
    } catch (e) {
      problems.push(`${serverName}: ${String(e?.message || e)}`)
    }
  }
  return { file, servers, problems }
}

/**
 * 清单的可写版本。所有写盘都走这里（tmp + rename），
 * 保留条目里我们不认识的字段，免得手写清单被规则吃掉。
 */
export class ManifestStore {
  constructor(file = serversFilePath()) {
    this.file = file
  }

  #readDoc() {
    if (!existsSync(this.file)) return { version: 1, servers: [] }
    const raw = JSON.parse(readFileSync(this.file, 'utf8'))
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.servers) ? raw.servers : []
    return { version: Number(raw?.version) > 0 ? Number(raw.version) : 1, servers: list }
  }

  #writeDoc(doc) {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8')
    renameSync(tmp, this.file)
  }

  /** 原始条目（保留未知字段）+ 规范化后的配置。 */
  list() {
    return this.#readDoc().servers
  }

  get(serverName) {
    return this.#readDoc().servers.find((s) => String(s?.serverName ?? s?.name) === serverName) ?? null
  }

  add(input) {
    const config = normalizeEntry(input)
    const doc = this.#readDoc()
    if (doc.servers.some((s) => String(s?.serverName ?? s?.name) === config.serverName)) {
      throw new Error(`服务器已存在：${config.serverName}`)
    }
    const entry = { serverName: config.serverName }
    for (const [k, v] of Object.entries(config)) if (k !== 'serverName') entry[k] = v
    doc.servers.push(entry)
    this.#writeDoc(doc)
    return config
  }

  update(serverName, patch) {
    const doc = this.#readDoc()
    const idx = doc.servers.findIndex((s) => String(s?.serverName ?? s?.name) === serverName)
    if (idx < 0) throw new Error(`没有这台服务器：${serverName}`)
    if (patch?.serverName !== undefined && String(patch.serverName) !== serverName) {
      throw new Error('serverName 不能改（它是工具名的 namespace）；要改名请删了重建')
    }
    const merged = { ...doc.servers[idx], ...patch, serverName }
    const config = normalizeEntry(merged, { partial: false })
    const entry = { serverName }
    for (const [k, v] of Object.entries(config)) if (k !== 'serverName') entry[k] = v
    doc.servers[idx] = entry
    this.#writeDoc(doc)
    return config
  }

  remove(serverName) {
    const doc = this.#readDoc()
    const before = doc.servers.length
    doc.servers = doc.servers.filter((s) => String(s?.serverName ?? s?.name) !== serverName)
    if (doc.servers.length === before) throw new Error(`没有这台服务器：${serverName}`)
    this.#writeDoc(doc)
    return true
  }
}

/* ── 工具名 ───────────────────────────────────────────────────── */

/**
 * 公开工具名：`mcp__<serverName>__<rawName>`。
 * 超出 64 字符或含非法字符时，截断并追加 12 位 SHA-256 后缀，
 * 保证不同身份不会折叠成同一个名字（与 dsh-mcp-client 的算法一致）。
 */
export function publicToolName(serverName, rawName) {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, 12)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - 12 - 1)}_${hash}`
}

/* ── JSON Schema 清洗 ─────────────────────────────────────────── */

const SCHEMA_KEYS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties',
  'items', 'enum', 'const', 'description', 'title', 'default', 'examples',
])

/**
 * 远端 inputSchema 可能带 harness 不认的关键字（$schema / format / minimum …）。
 * 这里只保留受支持的子集 —— 否则 register() 会抛 JsonSchemaError。
 */
export function sanitizeSchema(node, depth = 0) {
  if (node === null || typeof node !== 'object' || Array.isArray(node) || depth > 12) {
    return { type: 'string' }
  }
  const out = {}
  for (const [k, v] of Object.entries(node)) {
    if (!SCHEMA_KEYS.has(k)) continue
    if (k === 'additionalProperties') {
      if (typeof v === 'boolean') out[k] = v
      continue
    }
    if (k === 'required') {
      if (Array.isArray(v) && v.every((x) => typeof x === 'string')) out[k] = v
      continue
    }
    if (k === 'properties') {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const props = {}
        for (const [pk, pv] of Object.entries(v)) props[pk] = sanitizeSchema(pv, depth + 1)
        out[k] = props
      }
      continue
    }
    if (k === 'items') {
      out[k] = sanitizeSchema(v, depth + 1)
      continue
    }
    if (k === 'oneOf') {
      if (Array.isArray(v)) {
        const branches = v.map((b) => sanitizeSchema(b, depth + 1))
        if (branches.length) out[k] = branches
      }
      continue
    }
    out[k] = v
  }
  if (out.type === undefined && out.oneOf === undefined) {
    if (out.properties !== undefined || out.required !== undefined) out.type = 'object'
    else return { type: 'string' }
  }
  return out
}

/** 从 MCP content 数组里抽文本（只做文本投影）。 */
export function extractText(content, rawName = '') {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'image') parts.push(`[image ${block.mimeType ?? ''}]`.trim())
    else if (block.type === 'resource') parts.push(`[resource ${block.resource?.uri ?? ''}]`.trim())
    else parts.push(`[${block.type ?? 'unknown'} block]`)
  }
  return parts.join('\n') || (rawName ? `(${rawName}: 空结果)` : '(空结果)')
}

/** 统一的 tools/list 分页与去重（两种传输共用）。 */
async function listAllTools(request) {
  const tools = []
  const seen = new Set()
  let cursor
  do {
    const res = await request('tools/list', cursor === undefined ? {} : { cursor })
    if (!res || !Array.isArray(res.tools)) throw new Error('tools/list 返回里没有 tools 数组')
    for (const tool of res.tools) tools.push(tool)
    cursor = res.nextCursor
    if (cursor) {
      if (seen.has(cursor)) throw new Error('tools/list 重复了同一个 continuation cursor')
      seen.add(cursor)
    }
  } while (cursor)
  const names = new Set()
  for (const t of tools) {
    if (names.has(t.name)) throw new Error(`tools/list 里 "${t.name}" 出现了两次`)
    names.add(t.name)
  }
  return tools
}

/* ── MCP stdio 客户端（逐行 JSON-RPC） ────────────────────────── */

/** 子进程环境：洗掉密钥形状的变量与 DSH_*，再叠加清单里显式给的环境。 */
export function buildChildEnv(extra = {}) {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (/KEY|PASSWORD|SECRET|TOKEN/i.test(k)) continue
    if (k.startsWith('DSH_')) continue
    env[k] = v
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined || v === null) continue
    env[k] = String(v)
  }
  return env
}

export class McpStdioClient {
  constructor(config, { log = () => {} } = {}) {
    this.config = config
    this.log = log
    this.child = null
    this.nextId = 1
    this.pending = new Map()
    this.buffer = ''
    this.closed = false
    this.lastStderr = ''
  }

  /** 启动子进程 + initialize 握手。 */
  async connect({ timeoutMs = 120000 } = {}) {
    const { command, args = [], env = {}, cwd } = this.config
    if (!command) throw new Error('stdio 服务器缺少 command')
    const child = spawn(command, args, {
      cwd: cwd && isAbsolute(cwd) ? cwd : undefined,
      env: buildChildEnv(env),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child

    child.on('error', (err) => this.#failAll(new Error(`spawn 失败：${err?.message || err}`)))
    child.on('exit', (code, signal) => {
      this.closed = true
      this.#failAll(new Error(`子进程退出（code=${code} signal=${signal}）${this.lastStderr ? '：' + this.lastStderr.slice(-400) : ''}`))
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.#onData(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      this.lastStderr = (this.lastStderr + chunk).slice(-4000)
      this.log('stderr', chunk)
    })
    child.stdin.on('error', () => {})

    const init = await this.#request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'dsh-mcp-hub', version: '0.2.0' },
    }, timeoutMs)
    this.serverInfo = init?.serverInfo ?? null
    this.protocolVersion = init?.protocolVersion ?? null
    this.#notify('notifications/initialized', {})
    return init
  }

  async listTools({ timeoutMs = 60000 } = {}) {
    return listAllTools((method, params) => this.#request(method, params, timeoutMs))
  }

  /** tools/call —— 永远发原始工具名，绝不发公开名。 */
  async callTool(rawName, args, { timeoutMs = 60000, signal } = {}) {
    return this.#request('tools/call', { name: rawName, arguments: args ?? {} }, timeoutMs, signal)
  }

  /** 关闭：关 stdin（服务器的 EOF 退出路径），再兜底 kill。 */
  async close() {
    const child = this.child
    this.child = null
    this.closed = true
    this.#failAll(new Error('客户端已关闭'))
    if (!child) return
    try { child.stdin.end() } catch { /* ignore */ }
    await new Promise((resolve) => {
      let done = false
      const finish = () => { if (!done) { done = true; resolve() } }
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* ignore */ }
        finish()
      }, 1500)
      child.once('exit', () => { clearTimeout(timer); finish() })
      if (child.exitCode !== null) { clearTimeout(timer); finish() }
    })
  }

  #send(msg) {
    if (!this.child || this.closed || !this.child.stdin.writable) throw new Error('连接已断开，无法发送')
    this.child.stdin.write(JSON.stringify(msg) + '\n')
  }

  #notify(method, params) {
    this.#send({ jsonrpc: '2.0', method, params })
  }

  #request(method, params, timeoutMs, signal) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('连接已关闭'))
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} 超时（${timeoutMs}ms）`))
      }, timeoutMs)
      const onAbort = () => {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error(`${method} 被取消`))
      }
      if (signal) {
        if (signal.aborted) return onAbort()
        signal.addEventListener('abort', onAbort, { once: true })
      }
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); resolve(v) },
        reject: (e) => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); reject(e) },
      })
      try {
        this.#send({ jsonrpc: '2.0', id, method, params })
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(e)
      }
    })
  }

  /** 逐行 JSON：一行一条完整消息。 */
  #onData(chunk) {
    this.buffer += chunk
    let idx
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        this.log('skip', `非 JSON 行：${line.slice(0, 200)}`)
        continue
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const entry = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) entry.reject(new Error(`${msg.error.message ?? 'MCP 错误'}（code=${msg.error.code}）`))
        else entry.resolve(msg.result)
      } else if (msg.method) {
        this.log('notify', msg.method)
      }
    }
  }

  #failAll(err) {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id)
      entry.reject(err)
    }
  }
}

/* ── MCP streamable-http 客户端 ──────────────────────────────── */

/**
 * streamable-http（MCP 2025-03-26）：
 *   POST JSON-RPC 到 url，accept 同时声明 application/json 与 text/event-stream。
 *   - 响应 application/json：单条 JSON-RPC 响应。
 *   - 响应 text/event-stream：SSE，逐事件读 data，取 id 匹配的那一条后收流。
 *   - 通知（notifications/initialized）：服务器回 202/204/空 200，没有响应体。
 * 会话：initialize 响应头里的 `mcp-session-id` 要带到后续每个请求上。
 */
export class McpHttpClient {
  constructor(config, { log = () => {}, fetchImpl = globalThis.fetch } = {}) {
    this.config = config
    this.log = log
    this.fetchImpl = fetchImpl
    this.url = config.url
    this.extraHeaders = config.headers ?? {}
    this.nextId = 1
    this.sessionId = null
    this.protocolVersion = null
    this.closed = false
    this.serverInfo = null
  }

  async connect({ timeoutMs = 120000 } = {}) {
    if (!this.url) throw new Error('streamable-http 服务器缺少 url')
    const init = await this.#request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'dsh-mcp-hub', version: '0.2.0' },
    }, timeoutMs)
    this.serverInfo = init?.serverInfo ?? null
    this.protocolVersion = init?.protocolVersion ?? this.protocolVersion
    await this.#notify('notifications/initialized', {})
    return init
  }

  async listTools({ timeoutMs = 60000 } = {}) {
    return listAllTools((method, params) => this.#request(method, params, timeoutMs))
  }

  async callTool(rawName, args, { timeoutMs = 60000, signal } = {}) {
    return this.#request('tools/call', { name: rawName, arguments: args ?? {} }, timeoutMs, signal)
  }

  async close() {
    this.closed = true
    const sid = this.sessionId
    this.sessionId = null
    if (!sid) return
    // 规范允许客户端 DELETE 结束会话；服务器不支持就算了（不因此报错）。
    try {
      await this.#fetchRaw({ method: 'DELETE' }, 1500)
    } catch { /* ignore */ }
  }

  async #notify(method, params) {
    try {
      await this.#post({ jsonrpc: '2.0', method, params }, { timeoutMs: 15000 })
    } catch (e) {
      this.log('notify-failed', String(e?.message || e))
    }
  }

  async #request(method, params, timeoutMs, signal) {
    if (this.closed) throw new Error('连接已关闭')
    const id = this.nextId++
    const message = { jsonrpc: '2.0', id, method, params }
    const messages = await this.#post(message, { timeoutMs, signal })
    const reply = messages.find((m) => m && m.id === id) ?? messages.find((m) => m && m.result !== undefined || m.error !== undefined)
    if (!reply) throw new Error(`${method} 没有收到 JSON-RPC 响应`)
    if (reply.error) throw new Error(`${reply.error.message ?? 'MCP 错误'}（code=${reply.error.code}）`)
    return reply.result
  }

  /** 发一条消息，返回它带来的 JSON-RPC 消息数组（可能是空数组）。 */
  async #post(message, { timeoutMs = 60000, signal } = {}) {
    const body = JSON.stringify(message)
    const response = await this.#fetchRaw({
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body,
    }, timeoutMs, signal)

    if (!response) return []
    if (response.status === 202 || response.status === 204) return []
    if (!response.ok) {
      let detail = ''
      try { detail = (await response.text()).slice(0, 400) } catch { /* ignore */ }
      throw new Error(`HTTP ${response.status}${detail ? '：' + detail : ''}`)
    }

    const sid = response.headers.get('mcp-session-id')
    if (sid) this.sessionId = sid
    const proto = response.headers.get('mcp-protocol-version')
    if (proto) this.protocolVersion = proto

    const ctype = String(response.headers.get('content-type') ?? '').toLowerCase()
    if (ctype.includes('text/event-stream')) return this.#readSse(response, message.id)
    const text = await response.text()
    if (!text.trim()) return []
    // 有的服务器会给 application/json 但内容其实是单条消息。
    try {
      const one = JSON.parse(text)
      return Array.isArray(one) ? one : [one]
    } catch {
      throw new Error(`响应不是合法 JSON：${text.slice(0, 200)}`)
    }
  }

  async #fetchRaw(init, timeoutMs, outerSignal) {
    if (this.closed) throw new Error('连接已关闭')
    const headers = {
      accept: 'application/json, text/event-stream',
      ...this.extraHeaders,
      ...(init.headers ?? {}),
    }
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId
    if (this.protocolVersion && init.method !== 'DELETE') headers['mcp-protocol-version'] = this.protocolVersion

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`请求超时（${timeoutMs}ms）`)), timeoutMs)
    const onAbort = () => controller.abort(new Error('请求被取消'))
    if (outerSignal) {
      if (outerSignal.aborted) onAbort()
      else outerSignal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      return await this.fetchImpl(this.url, { ...init, headers, signal: controller.signal, redirect: 'follow' })
    } catch (e) {
      const cause = e?.cause?.message ? `（${e.cause.message}）` : ''
      throw new Error(`${init.method ?? 'GET'} ${this.url} 失败：${String(e?.message || e)}${cause}`)
    } finally {
      clearTimeout(timer)
      if (outerSignal) outerSignal.removeEventListener('abort', onAbort)
    }
  }

  /** 读 SSE：data 行拼成一条消息，空行表示一个事件结束。拿到匹配 id 就收流。 */
  async #readSse(response, wantId) {
    const out = []
    const decoder = new TextDecoder()
    let buffer = ''
    let data = []
    let done = false

    const dispatch = () => {
      if (!data.length) return
      const raw = data.join('\n')
      data = []
      let msg
      try { msg = JSON.parse(raw) } catch {
        this.log('skip', `SSE 里的非 JSON 事件：${raw.slice(0, 160)}`)
        return
      }
      if (Array.isArray(msg)) out.push(...msg)
      else out.push(msg)
      if (wantId !== undefined && (Array.isArray(msg) ? msg.some((m) => m?.id === wantId) : msg?.id === wantId)) done = true
    }

    const handleLines = (block) => {
      for (const line of block.split(/\r?\n/)) {
        if (line === '') continue
        if (line.startsWith(':')) continue
        if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      }
      // 一个 block 就是一个事件（空行是事件分隔符，已经被切掉了）——
      // 必须在这里 dispatch，不能等"遇到空行"：切分后 block 里没有空行。
      dispatch()
    }

    const reader = response.body?.getReader()
    if (!reader) {
      handleLines(await response.text())
      dispatch()
      return out
    }
    try {
      while (!done) {
        const { value, done: eof } = await reader.read()
        if (eof) break
        buffer += decoder.decode(value, { stream: true })
        buffer = buffer.replace(/\r\n/g, '\n')
        let cut
        while (!done && (cut = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, cut)
          buffer = buffer.slice(cut + 2)
          handleLines(block)
        }
      }
      if (!done && buffer.trim()) handleLines(buffer + '\n\n')
    } finally {
      try { await reader.cancel() } catch { /* ignore */ }
    }
    return out
  }
}

/* ── ToolDefinition ──────────────────────────────────────────── */

export function createToolDefinition({ client, serverName, tool, timeoutMs = 60000 }) {
  const rawName = tool.name
  const parameters = sanitizeSchema(tool.inputSchema ?? { type: 'object', properties: {} })
  return {
    name: publicToolName(serverName, rawName),
    description: tool.description || `MCP tool "${rawName}" provided by server "${serverName}"`,
    parameters,
    output: {
      schema: {
        type: 'object',
        properties: { content: { type: 'array', items: {} } },
        required: ['content'],
        additionalProperties: false,
      },
      render(_args, value) {
        return [{ type: 'text', text: extractText(value?.content, rawName) }]
      },
    },
    async execute(args, exec) {
      const result = await client.callTool(rawName, args ?? {}, {
        timeoutMs,
        signal: exec?.signal,
      })
      const content = Array.isArray(result?.content) ? result.content : []
      const text = extractText(content, rawName)
      if (result?.isError === true) throw new Error(text)
      return { content: content.length ? content : [{ type: 'text', text }] }
    },
  }
}

/* ── Hub：动态连接管理 ───────────────────────────────────────── */

export class McpHub {
  constructor({ servers = [], register, logger, state, store = null }) {
    this.register = register
    this.logger = logger
    this.state = state
    this.store = store
    this.rows = []
    this.byName = new Map()
    this.configs = new Map()
    this.connections = new Map() // serverName -> { client, dispose, catalog, transport }
    this.locks = new Map()
    for (const s of servers) this.installConfig(s)
  }

  /** 新增/覆盖一台的配置与行（不动已有连接）。 */
  installConfig(config) {
    const existing = this.configs.get(config.serverName)
    const row = {
      serverName: config.serverName,
      transport: config.transport,
      enabled: config.enabled !== false,
      status: config.enabled !== false ? 'idle' : 'disabled',
      toolCount: 0,
      tools: [],
      error: null,
      lastErrorAt: null,
      url: config.transport === 'streamable-http' ? config.url : undefined,
      command: config.transport === 'stdio' ? config.command : undefined,
      args: config.transport === 'stdio' ? [...(config.args ?? [])] : undefined,
    }
    if (existing) {
      const old = this.byName.get(config.serverName)
      if (old) Object.assign(old, row, { status: old.status })
    } else {
      this.rows.push(row)
      this.byName.set(config.serverName, row)
    }
    this.configs.set(config.serverName, config)
    return this.byName.get(config.serverName)
  }

  config(serverName) {
    return this.configs.get(serverName) ?? null
  }

  #touch() {
    try { this.state?.(this.snapshot()) } catch { /* ignore */ }
  }

  #lock(name) {
    const prev = this.locks.get(name) ?? Promise.resolve()
    let release
    const next = new Promise((r) => { release = r })
    this.locks.set(name, prev.then(() => next))
    return prev.then(() => () => {
      release()
      if (this.locks.get(name) === next) this.locks.delete(name)
    })
  }

  async #withLock(name, fn) {
    const release = await this.#lock(name)
    try { return await fn() } finally { release() }
  }

  /** 连所有启用的服务器；单台失败不影响其他台。 */
  async start() {
    const tasks = [...this.configs.values()].filter((s) => s.enabled).map((s) => this.connectServer(s.serverName))
    await Promise.all(tasks)
    return this.snapshot()
  }

  /**
   * 显式连接一台。**任何一次连接失败都不抛**：状态写进 row.error，
   * 因为触发它的可能是 HTTP 路由，不该把 500 抛给界面。
   * 返回最终的行快照（调用方一般用轮询看结果，不必等它）。
   */
  async connectServer(serverName) {
    const config = this.configs.get(serverName)
    const row = this.byName.get(serverName)
    if (!config || !row) return null
    return this.#withLock(serverName, async () => {
      if (this.connections.has(serverName)) return this.snapshotRow(serverName)
      row.status = 'connecting'
      row.error = null
      this.#touch()

      const client = config.transport === 'streamable-http'
        ? new McpHttpClient(config, {
          log: (kind, text) => this.logger?.debug?.(`[mcp-hub:${serverName}] ${kind} ${String(text).slice(0, 300)}`),
        })
        : new McpStdioClient(config, {
          log: (kind, text) => {
            if (this.logger && kind === 'stderr' && String(text).trim()) {
              this.logger.debug?.(`[mcp-hub:${serverName}] ${String(text).trim().slice(0, 400)}`)
            }
          },
        })

      try {
        await client.connect({ timeoutMs: config.connectTimeoutMs ?? 120000 })
        const allTools = await client.listTools()
        // 工具级禁用在这里生效：被禁的工具既不注册、也不算进 toolCount。
        const skipNames = new Set(config.disabledTools ?? [])
        const tools = allTools.filter((t) => !skipNames.has(t.name))
        if (skipNames.size) {
          this.logger?.info?.(`[mcp-hub] ${serverName}: 工具级禁用 ${allTools.length - tools.length} 个（${[...skipNames].join(', ')}）`)
        }
        const dispose = []
        try {
          for (const tool of tools) {
            const def = createToolDefinition({
              client,
              serverName,
              tool,
              timeoutMs: config.toolCallTimeoutMs,
            })
            dispose.push(this.register(def))
          }
        } catch (e) {
          for (const d of dispose) { try { d() } catch { /* ignore */ } }
          throw e
        }
        this.connections.set(serverName, {
          client,
          dispose,
          transport: config.transport,
          catalog: tools.map((t) => ({
            rawName: t.name,
            name: publicToolName(serverName, t.name),
            description: String(t.description ?? ''),
          })),
        })
        row.status = 'ready'
        row.toolCount = tools.length
        row.tools = tools.map((t) => publicToolName(serverName, t.name))
        row.error = null
        row.lastErrorAt = null
        this.logger?.info?.(`[mcp-hub] ${serverName}: 已连接（${config.transport}），注册 ${tools.length} 个工具`)
      } catch (e) {
        row.status = 'error'
        row.error = String(e?.message || e)
        row.lastErrorAt = new Date().toISOString()
        row.toolCount = 0
        row.tools = []
        this.logger?.error?.(`[mcp-hub] ${serverName}: ${row.error}`)
        try { await client.close() } catch { /* ignore */ }
      }
      this.#touch()
      return this.snapshotRow(serverName)
    })
  }

  /** 卸载一台：**先注销工具，再关传输**。顺序反了会留下调不通的工具。 */
  async disconnectServer(serverName) {
    return this.#withLock(serverName, async () => {
      const conn = this.connections.get(serverName)
      const row = this.byName.get(serverName)
      if (!conn) {
        if (row && row.status === 'error') { row.status = row.enabled ? 'idle' : 'disabled'; row.error = null }
        this.#touch()
        return false
      }
      for (const d of conn.dispose) { try { d() } catch { /* ignore */ } }
      conn.dispose = []
      try { await conn.client.close() } catch { /* ignore */ }
      this.connections.delete(serverName)
      if (row) {
        row.status = row.enabled ? 'idle' : 'disabled'
        row.toolCount = 0
        row.tools = []
      }
      this.#touch()
      return true
    })
  }

  /** 删除一台：断开（内含注销）→ 再动清单。调用方负责删清单，这里只管连接。 */
  async removeServer(serverName) {
    await this.disconnectServer(serverName)
    this.configs.delete(serverName)
    this.byName.delete(serverName)
    this.rows = this.rows.filter((r) => r.serverName !== serverName)
    this.#touch()
  }

  /** 改配置并落到 Hub；返回 {row, reconnect}，连接动作由调用方触发（不阻塞）。 */
  applyConfig(config) {
    const before = this.configs.get(config.serverName)
    const wasConnected = this.connections.has(config.serverName)
    const changed = !before || JSON.stringify(before) !== JSON.stringify(config)
    this.installConfig(config)
    const row = this.byName.get(config.serverName)
    if (!config.enabled) {
      void this.disconnectServer(config.serverName)
      return { row, reconnect: false }
    }
    const needsReconnect = wasConnected ? changed : false
    if (needsReconnect) void this.disconnectServer(config.serverName).then(() => this.connectServer(config.serverName))
    return { row, reconnect: needsReconnect }
  }

  async stop() {
    for (const serverName of [...this.connections.keys()]) await this.disconnectServer(serverName)
  }

  snapshot() {
    return this.rows.map((r) => this.snapshotRow(r.serverName))
  }

  snapshotRow(serverName) {
    const r = this.byName.get(serverName)
    if (!r) return null
    return { ...r, tools: [...(r.tools ?? [])] }
  }

  /** 跨服务器搜工具：按公开名 / 原始名 / 描述 / 服务器名过滤。 */
  searchTools(q = '') {
    const needle = String(q).trim().toLowerCase()
    const out = []
    for (const [serverName, conn] of this.connections) {
      const row = this.byName.get(serverName)
      for (const t of conn.catalog ?? []) {
        if (needle) {
          const hay = `${t.name}\n${t.rawName}\n${t.description}\n${serverName}`.toLowerCase()
          if (!hay.includes(needle)) continue
        }
        out.push({
          name: t.name,
          toolName: t.rawName,
          serverName,
          transport: conn.transport ?? row?.transport,
          description: t.description,
        })
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name))
    return out
  }

  stats() {
    let tools = 0
    for (const r of this.rows) tools += r.toolCount || 0
    return {
      servers: this.rows.length,
      connected: this.connections.size,
      tools,
    }
  }
}

/* ── HTTP 路由 ───────────────────────────────────────────────── */

function sendJson(res, code, body) {
  const text = JSON.stringify(body)
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('access-control-allow-origin', '*')
  res.end(text)
}

async function readJsonBody(req) {
  const limit = 1 << 20
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体超过 1 MB')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch (e) {
    throw new Error(`请求体不是合法 JSON：${String(e?.message || e)}`)
  }
}

function decodeName(segment) {
  try { return decodeURIComponent(segment) } catch { return segment }
}

/**
 * 生成路由表。kind/path/handler 的形状与 ctx.webServer.register 一致，
 * 所以同一份 handler 既能在 DSH 里跑，也能被 _routes.mjs 用 node:http 跑起来验。
 *
 * 路由（一条 prefix 覆盖整棵子树，避免 DSH 的 exact 表装不下 :name）：
 *   GET    /mcp-hub/servers
 *   POST   /mcp-hub/servers
 *   PATCH  /mcp-hub/servers/<name>
 *   DELETE /mcp-hub/servers/<name>
 *   POST   /mcp-hub/servers/<name>/connect
 *   POST   /mcp-hub/servers/<name>/disconnect
 *   GET    /mcp-hub/tools?q=
 */
export function createRouteTable({ hub, store, file }) {
  const listHandler = async (req, res, url) => {
    if (req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        file,
        servers: hub.snapshot(),
        stats: hub.stats(),
      })
    }
    if (req.method === 'POST') {
      const body = await readJsonBody(req)
      const config = store.add(body)          // 先写盘（唯一真相源），再进内存
      hub.installConfig(config)
      const row = hub.byName.get(config.serverName)
      // 立刻尝试连接，但不阻塞响应；界面通过 2s 轮询看到 connecting → ready/error
      if (config.enabled) {
        row.status = 'connecting'
        void hub.connectServer(config.serverName)
      }
      return sendJson(res, 201, { ok: true, server: hub.snapshotRow(config.serverName), file })
    }
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.setHeader('access-control-allow-origin', '*')
      res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS')
      res.setHeader('access-control-allow-headers', 'content-type')
      return res.end()
    }
    return sendJson(res, 405, { ok: false, error: `不支持 ${req.method}` })
  }

  const itemHandler = async (req, res, url, rest) => {
    const parts = rest.split('/').filter(Boolean)
    const serverName = decodeName(parts[0] ?? '')
    const action = parts[1] ?? ''

    if (req.method === 'PATCH' && !action) {
      const body = await readJsonBody(req)
      const config = store.update(serverName, body)  // 先写盘
      const { row, reconnect } = hub.applyConfig(config)
      if (!config.enabled) {
        await hub.disconnectServer(serverName)       // 等它真断开，响应里的状态才可信
      } else if (row && !hub.connections.has(serverName) && !reconnect) {
        row.status = 'connecting'
        void hub.connectServer(serverName)
      }
      return sendJson(res, 200, { ok: true, server: hub.snapshotRow(serverName), file })
    }

    if (req.method === 'DELETE' && !action) {
      // ★ 顺序不能反：先断开（注销工具 + 关传输），再删清单。
      // 反过来的话，清单里没了这台，工具却还挂在注册表上，只能重启才能收走。
      await hub.disconnectServer(serverName)
      const existed = hub.config(serverName) !== null
      if (existed) {
        store.remove(serverName)
        await hub.removeServer(serverName)
      } else {
        // 清单里有、内存里没有（例如刚启动还没装）也要删得掉
        try { store.remove(serverName) } catch { /* 已不存在 */ }
      }
      return sendJson(res, 200, { ok: true, deleted: serverName, file, servers: hub.snapshot() })
    }

    if (req.method === 'POST' && (action === 'connect' || action === 'disconnect')) {
      const config = hub.config(serverName)
      if (!config) return sendJson(res, 404, { ok: false, error: `没有这台服务器：${serverName}` })
      if (action === 'connect') {
        const row = hub.byName.get(serverName)
        if (hub.connections.has(serverName)) {
          // 已经连着了：不谎报"连接中"，直接回真实状态
          row.status = 'ready'
          return sendJson(res, 200, { ok: true, action: 'connect', alreadyConnected: true, server: hub.snapshotRow(serverName) })
        }
        row.status = 'connecting'
        void hub.connectServer(serverName)
        return sendJson(res, 202, { ok: true, action: 'connect', server: hub.snapshotRow(serverName), note: '连接在后台推进，请轮询 GET /mcp-hub/servers' })
      }
      await hub.disconnectServer(serverName)
      return sendJson(res, 200, { ok: true, action: 'disconnect', server: hub.snapshotRow(serverName) })
    }

    return sendJson(res, 404, { ok: false, error: `没有这条路由：${req.method} ${url.pathname}` })
  }

  const toolsHandler = async (req, res, url) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: `不支持 ${req.method}` })
    const q = url.searchParams.get('q') ?? ''
    const tools = hub.searchTools(q)
    return sendJson(res, 200, { ok: true, q, count: tools.length, stats: hub.stats(), tools })
  }

  const serversRoute = {
    kind: 'prefix',
    path: '/mcp-hub/servers',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const rest = url.pathname.slice('/mcp-hub/servers'.length).replace(/^\/+/, '')
      try {
        if (!rest) return await listHandler(req, res, url)
        return await itemHandler(req, res, url, rest)
      } catch (e) {
        const message = String(e?.message || e)
        const code = /已存在/.test(message) ? 409 : /没有这台|不存在/.test(message) ? 404 : 400
        return sendJson(res, code, { ok: false, error: message })
      }
    },
  }

  const toolsRoute = {
    kind: 'prefix',
    path: '/mcp-hub/tools',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      try {
        return await toolsHandler(req, res, url)
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: String(e?.message || e) })
      }
    },
  }

  return [serversRoute, toolsRoute]
}

/* ── 插件入口 ────────────────────────────────────────────────── */

/**
 * 激活期追踪：写进 $DSH_HOME/mcp-hub/_apply-trace.log。
 * 起因（2026-10-21）：插件装进 desktop profile 后，客户端半出现了、宿主半没有任何痕迹
 * （工具列表无 mcp__*、路由 404），而包里 import 本身是好的 —— 只能让它自己报路。
 * 排掉之后可以删掉这个函数，但它很便宜，留着更有用。
 */
function trace(step, extra) {
  try {
    const dir = join(dshHome(), 'mcp-hub')
    mkdirSync(dir, { recursive: true })
    const line = `${new Date().toISOString()} ${step}${extra === undefined ? '' : ' ' + JSON.stringify(extra)}\n`
    appendFileSync(join(dir, '_apply-trace.log'), line, 'utf8')
  } catch { /* 追踪本身绝不能影响激活 */ }
}

export async function apply(ctx) {
  trace('apply 进入', { hasTools: !!ctx?.tools, hasWebServer: !!ctx?.webServer, hasEffect: !!ctx?.effect })
  try {
    const file = serversFilePath()
    const manifest = loadServers(file)
    trace('loadServers', { file, servers: manifest.servers?.length ?? 0, error: manifest.error ?? null })
    const logger = ctx.logger
    if (manifest.error) logger?.warn?.(`[mcp-hub] ${manifest.error}`)
    for (const p of manifest.problems ?? []) logger?.warn?.(`[mcp-hub] 清单问题：${p}`)

    const store = new ManifestStore(file)
    const hub = new McpHub({
      servers: manifest.servers,
      register: (def) => ctx.tools.register(def),
      logger,
      state: () => {},
      store,
    })
    trace('McpHub 构造完成')

    const routes = createRouteTable({ hub, store, file })
    trace('路由表生成', { routes: routes.map((r) => `${r.kind} ${r.path}`) })

    ctx.effect(() => {
      const disposers = routes.map((route) => ctx.webServer.register(route))
      trace('路由已注册', { n: disposers.length })
      return () => { for (const d of disposers) { try { d() } catch { /* ignore */ } } }
    }, 'mcp-hub: routes')

    // 插件卸载时：注销工具 + 关传输
    ctx.effect(() => () => { hub.stop().catch(() => {}) }, 'mcp-hub: connections')
    trace('两个 effect 已挂')

    // ★ 激活期不 await：windows-mcp 首启 ~20s，await 会把整个 DSH 启动拖住。
    //   代价是启动后头几十秒工具不在列表里；界面显示 'connecting' 而不是假装已连上。
    hub.start().catch((e) => {
      trace('hub.start 失败', { error: String(e?.message || e) })
      logger?.error?.(`[mcp-hub] 启动失败：${String(e?.message || e)}`)
    })

    // hub.start() 之后的这一行原先是 `ctx.mcpHub = hub`，但它会抛
    //   cannot set property "mcpHub" without provide
    // cordis 的 ctx 属性必须先 provide 才能写；而这行只是「方便别的插件拿到 hub」的便利，
    // 没有它一切照常（工具注册、路由、effect 都在前面做完了）。所以直接删掉，不 provide。
    trace('apply 走完', { servers: manifest.servers?.length ?? 0 })
  } catch (e) {
    trace('apply 抛错', { error: String(e?.message || e), stack: String(e?.stack || '').slice(0, 800) })
    throw e
  }
}
