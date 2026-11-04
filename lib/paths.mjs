// lib/paths.mjs -- 统一的路径解析（2026-11-04）
//
// 背景：原来三处把路径写死在作者机器上，后来改成 dirname(dirname(DSH_HOME))，
//      在作者机器（D:\AI\dsh\home -> D:\AI）碰巧对，标准安装（C:\Users\<名>\.dsh -> C:\Users）全错。
// 原则：不猜。四级解析，前三级都是用户说了算，第四级才试候选。
//
//   1. 环境变量      YQ_SOUL / YQ_HUB / YQ_HB_DIR
//   2. 自身配置      heartbeat.config.json 的 paths 段
//   3. 共享真值      echo.config.json 的 soul / memory
//   4. 候选列表      试几个常见布局，取第一个「像样」的
//
// ★ 关键：解析失败时把「试过哪些、各自为什么不算」打出来。
//   群友那句「零报错，只是全空」才是这个 bug 最坏的地方 —— 不是错，是不说。

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

export const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

// ★★ 2026-11-04 撤回「像样」判据（爀曦点出来的）：
//   原来用 '02-墨.jsonl' / 'hub/' 这种具体名字判断目录对不对 ——
//   但**仓库端和部署端的组件命名是两套，这是特地设计**，拿仓库名去判断部署端必然误判。
//   所以现在：只判「目录存在」，并把这个结果的**置信度**标出来。
//
//   confirmed —— 用户在配置里显式写明的（前三级），可以直接信
//   guessed   —— 候选列表里碰上的，需要人确认
const existed = (p) => {
  try { return statSync(p).isDirectory() } catch { return existsSync(p) }
}

/** 第 4 级：候选列表。顺序 = 常见程度。 */
export function candidates (kind) {
  // ★ 两个祖先层都要试：DSH_HOME 可能是 <root>/dsh/home（作者机器，根在两层之上）
  //   也可能是 <root>/.dsh（标准安装，根就在上一层）。不猜哪个，两个都给。
  const parent = dirname(DSH_HOME)
  const grandparent = dirname(parent)
  if (kind === 'soul') {
    return [
      join(DSH_HOME, 'dsh-soul', 'soul'),
      join(grandparent, 'yanqing-soul'),
      join(parent, 'yanqing-soul'),
      join(homedir(), 'yanqing-soul'),
    ]
  }
  if (kind === 'memory') {
    return [
      join(DSH_HOME, 'dsh-soul', 'memory'),
      join(grandparent, 'memory'),
      join(parent, 'memory'),
      join(homedir(), 'memory'),
    ]
  }
  if (kind === 'hbDir') {
    return [
      join(DSH_HOME, 'dsh-soul', 'dsh-tools', 'dsh-yanqing-heartbeat'),
      join(grandparent, 'dsh-tools', 'dsh-yanqing-heartbeat'),
      join(parent, 'dsh-tools', 'dsh-yanqing-heartbeat'),
      join(homedir(), 'dsh-tools', 'dsh-yanqing-heartbeat'),
    ]
  }
  return []
}

export function resolveOne (kind, opts = {}) {
  const tried = []
  const envVar = opts.envVar
  const configValue = opts.configValue || []

  const env = envVar ? process.env[envVar] : ''
  if (env) {
    const ok = existed(env)
    tried.push({ source: 'env ' + envVar, path: env, ok })
    if (ok) return { path: env, source: 'env', confidence: 'confirmed', tried }
  }

  for (const pair of configValue) {
    const label = pair[0]
    const val = pair[1]
    if (!val) continue
    const ok = existed(val)
    tried.push({ source: label, path: val, ok })
    if (ok) return { path: val, source: label, confidence: 'confirmed', tried }
  }

  for (const p of candidates(kind)) {
    const ok = existed(p)
    tried.push({ source: 'candidate', path: p, ok })
    if (ok) return { path: p, source: 'candidate', confidence: 'guessed', tried }
  }

  return { path: '', source: 'none', confidence: 'none', tried }
}

export function readJson (p) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}

export function resolveAll () {
  const memFirst = resolveOne('memory', { envVar: 'YQ_HUB' })
  const echoCfg = memFirst.path ? readJson(join(memFirst.path, 'hub', 'echo.config.json')) : null

  const hbFirst = resolveOne('hbDir', { envVar: 'YQ_HB_DIR' })
  const hbCfg = hbFirst.path ? readJson(join(hbFirst.path, 'heartbeat.config.json')) : null

  const hbPaths = hbCfg && hbCfg.paths ? hbCfg.paths : {}
  const soulCfg = []
  if (hbPaths.soul) soulCfg.push(['heartbeat.config.json', hbPaths.soul])
  if (echoCfg && echoCfg.soul) soulCfg.push(['echo.config.json', echoCfg.soul])

  const hbCfgList = []
  if (hbPaths.hbDir) hbCfgList.push(['heartbeat.config.json', hbPaths.hbDir])

  const soul = resolveOne('soul', { envVar: 'YQ_SOUL', configValue: soulCfg })
  const hbDir = resolveOne('hbDir', { envVar: 'YQ_HB_DIR', configValue: hbCfgList })

  return { soul, memory: memFirst, hbDir, echoCfg, hbCfg }
}

export function explain (label, r) {
  if (r.path) return label + ': ' + r.path + '  [来源: ' + r.source + ']'
  const lines = [label + ': 找不到。试过：']
  for (const t of r.tried) lines.push('  - ' + t.source + ': ' + t.path + '  [' + (t.ok ? '通过' : '不算') + ']')
  lines.push('  请设环境变量，或在 echo.config.json / heartbeat.config.json 里指明。')
  return lines.join('\n')
}
