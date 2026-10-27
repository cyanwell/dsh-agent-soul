/**
 * env-config.mjs —— 「环境变量优先，配置文件兜底」
 *
 * 为什么要有它
 * ------------
 * 这些插件全靠环境变量配置（YANTAI_NODE_ORIGIN 之类）。这在桌面端没问题：
 * 启动器是个 shell 脚本，`export X=...` 就进去了。
 *
 * 但在**被 App 拉起来的宿主**里（本机就是：Android 容器里的 dsh web），
 * 启动命令由 App 生成，`.bashrc` 管不到它，DSH 也没有 profile 级的环境变量注入。
 * 结果是：配置项**根本没有入口**，界面只能一直显示「未配置」——
 * 而这不是「没配」，是「配不进去」。
 *
 * 所以这里加一条退路：**进程 env > 配置文件**。
 *   · env 仍然优先 —— 桌面端/shell 里的老用法一行都不用改
 *   · 没有再读配置文件 —— App 拉起的宿主也能配
 *
 * 配置文件位置（按顺序找第一个存在的）：
 *   1. $YANTAI_CONFIG
 *   2. $DSH_HOME/yantai.json
 *   3. ~/.dsh/yantai.json
 *
 * 键名两种写法都认（用你顺手的那种）：
 *   { "YANTAI_NODE_ORIGIN": "http://127.0.0.1:8766" }
 *   { "nodeOrigin": "http://127.0.0.1:8766" }
 *
 * ★ 配置坏了必须说出来，不能当没看见 ——「读不到」和「没配」是两件事，
 *   前者要修文件，后者要填值，混在一起会让人去修不存在的问题。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

function candidates() {
  const out = []
  const explicit = String(process.env.YANTAI_CONFIG || '').trim()
  if (explicit) out.push(explicit)
  const home = String(process.env.DSH_HOME || '').trim()
  if (home) out.push(path.join(home, 'yantai.json'))
  out.push(path.join(os.homedir(), '.dsh', 'yantai.json'))
  return out
}

/** "YANTAI_NODE_ORIGIN" → "nodeOrigin" */
function camelOf(key) {
  return key.replace(/^YANTAI_/i, '').toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase())
}

let cached = null

/** 读一次，缓存。返回 { path, data, error } */
export function loadConfig() {
  if (cached) return cached
  for (const p of candidates()) {
    let raw
    try {
      raw = fs.readFileSync(p, 'utf8')
    } catch {
      continue // 这个位置没有，看下一个
    }
    try {
      const data = JSON.parse(raw.replace(/^\uFEFF/, ''))
      cached = { path: p, data: data && typeof data === 'object' ? data : {}, error: null }
      return cached
    } catch (e) {
      // 文件在但坏了：明确记下来，由调用方决定怎么报
      cached = { path: p, data: {}, error: `配置文件解析失败：${p}\n  ${e.message}` }
      return cached
    }
  }
  cached = { path: null, data: {}, error: null }
  return cached
}

/**
 * 取一个配置项。**进程 env 优先，配置文件兜底。**
 * @param {string} key 例如 'YANTAI_NODE_ORIGIN'
 * @returns {string} 没有就是空串（调用方自己决定「未配置」怎么显示）
 */
export function envOrConfig(key) {
  const fromEnv = String(process.env[key] || '').trim()
  if (fromEnv) return fromEnv
  const { data } = loadConfig()
  const camel = camelOf(key)
  for (const k of [key, camel, key.toLowerCase()]) {
    const v = data?.[k]
    if (v === undefined || v === null) continue
    const s = String(v).trim()
    if (s) return s
  }
  return ''
}

/** 给人看的配置来源一句话（用于「未配置」提示里带上「你还有哪些位置可以放」） */
export function configHint() {
  const c = loadConfig()
  if (c.error) return c.error
  if (c.path) return `配置文件：${c.path}`
  return `配置文件（可选）：${candidates().join(' 或 ')}`
}

/** 仅供测试：丢掉缓存 */
export function _resetCache() {
  cached = null
}
