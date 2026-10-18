// kit-bridge.mjs —— 插件本体 → kit 脚本的那道桥
//
// 为什么要有这一层：
//   `kit/echo/` 里那十一个脚本是**独立可跑**的（用户能直接 node 它们）。
//   插件要调它们，但不能把逻辑抄一份进来 —— 抄一份就是第二份真相，
//   改了一边忘了另一边，两个说的还不一样。
//   所以只桥接：调过去、拿回来、原样给人看。
//
// ★ 三条约束（都是踩过的）：
//   1. **绝不用 spawnSync。** 体检 deep 模式要几百毫秒到几秒，
//      同步等会把整个 DSH 宿主卡住 —— 那不是慢，那是把别人也拖下来。
//   2. **超时要给。** 卡死的脚本不能把工具调用挂在那儿。
//   3. **失败要带 stderr 回来。** 只说「失败了」没有用，
//      用户要看的是脚本自己那句错话。

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const KIT = join(HERE, 'kit', 'echo')

/**
 * 跑一个 kit 脚本。
 *
 * @param {string} script  脚本文件名，例如 'plan.mjs'
 * @param {string[]} args  命令行参数
 * @param {object} env     额外环境变量（ECHO_SOUL / ECHO_MEMORY / ...）
 * @returns {Promise<{ok:boolean, code:number|string, stdout:string, stderr:string}>}
 */
export async function runKit(script, args = [], env = {}) {
  const p = join(KIT, script)
  if (!existsSync(p)) {
    return {
      ok: false,
      code: 'ENOENT',
      stdout: '',
      stderr:
        `kit 里没有 ${script}（找的是 ${p}）。\n` +
        `这说明包装得不完整 —— 把整个 kit/ 目录一起打包，不要只发 index.js。`,
    }
  }

  // ★ 只把非空的环境变量传下去：传一个空字符串会把 kit 的「没配」判断搞坏
  //   （echo-config 用 falsy 判断配没配，空串是 falsy，但那会让报错文案变成空白）。
  const cleanEnv = { ...process.env }
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && v !== null && String(v).trim() !== '') cleanEnv[k] = String(v)
  }

  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [p, ...args], {
      timeout: 180000,
      maxBuffer: 64 * 1024 * 1024,
      env: cleanEnv,
      encoding: 'utf8',
      windowsHide: true,
    })
    return { ok: true, code: 0, stdout: stdout || '', stderr: stderr || '' }
  } catch (e) {
    // execFile 失败时 e.code 是退出码（number）或 'ENOENT'（string）
    return {
      ok: false,
      code: e.code ?? -1,
      stdout: e.stdout || '',
      stderr: e.stderr || String((e && e.message) || e),
    }
  }
}

/** 把工具参数里的 soul/memory 变成 kit 认的环境变量。没传就不设，让 kit 自己推断。 */
export function envFromArgs(args = {}) {
  const env = {}
  if (args.soul) env.ECHO_SOUL = String(args.soul)
  if (args.memory) env.ECHO_MEMORY = String(args.memory)
  if (args.sessions) env.ECHO_SESSIONS = String(args.sessions)
  if (args.runtime) env.ECHO_RUNTIME = String(args.runtime)
  return env
}

/** 把一段 JSON 输出解析出来；解析不了就给 null，绝不抛。 */
export function tryJson(text) {
  if (!text) return null
  try { return JSON.parse(text) } catch { return null }
}
