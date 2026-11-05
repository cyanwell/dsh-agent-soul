#!/usr/bin/env node
/**
 * verify-installed.mjs —— 在「安装态」里逐个 import 每个包
 *
 * 为什么有这个文件（2026-11-05，外部干净机器验证报告）
 * ----------------------------------------------------
 * 那份报告的核心结论只有一句：
 *
 *   「所有验证工具都只在仓库目录里跑过，没有一次在 profile/node_modules/ 里跑过。」
 *
 * 于是出现最讽刺的一幕：verify-packaging 136 条全绿、soul-doctor 15 项、verify-runtime 6 条，
 * 一条都没抓到「22 个包里有 4 个加载即崩」。
 *
 * 而这个脚本能一次性抓到它们 —— 因为它做的事就是宿主启动时做的那件事：
 *   对每个 bundles 成员，import 它的入口模块。
 *
 * 用法
 * ----
 *   node tools/verify-installed.mjs [--profile full] [--json]
 *
 * 判据
 * ----
 * - 每个非 @deepseek-ai/ 的包都要能 import 成功
 * - 失败要打印「哪个包 + 原始错误」，不吞异常
 * - 有任何一个失败 → exit 1
 * - ★ 目录不存在 = FAIL，不是「跳过」（报告 P2-1：verify-runtime 把不存在的
 *   profile 逐条「不适用」，最后打印「全部通过」）
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

const argOf = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined }
const PROFILE = argOf('--profile') || 'desktop'
const JSON_OUT = process.argv.includes('--json')

const DSH_HOME = process.env.DSH_HOME || (process.platform === 'win32'
  ? join(process.env.APPDATA || '', 'dsh', 'home')
  : join(process.env.HOME || '', '.dsh'))

const profileDir = join(DSH_HOME, 'profiles', PROFILE)
const pkgPath = join(profileDir, 'package.json')

function die(msg) {
  if (JSON_OUT) console.log(JSON.stringify({ ok: false, error: msg }))
  else console.error(`✗ ${msg}`)
  process.exit(1)
}

if (!existsSync(profileDir)) die(`profile 目录不存在：${profileDir}\n  ★ 目录不存在就是 FAIL —— 不是「逐条不适用然后报全部通过」。`)
if (!existsSync(pkgPath)) die(`没有 package.json：${pkgPath}`)

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const bundles = pkg?.dsh?.profile?.bundles || []
if (!Array.isArray(bundles) || bundles.length === 0) die('bundles 为空 —— 这个 profile 没装任何插件')

const targets = bundles.filter((b) => typeof b === 'string' && !b.startsWith('@deepseek-ai/'))
const skipped = bundles.length - targets.length

const results = []
for (const name of targets) {
  const pkgDir = join(profileDir, 'node_modules', ...name.split('/'))
  const pj = join(pkgDir, 'package.json')
  if (!existsSync(pj)) { results.push({ name, ok: false, why: 'node_modules 里没有这个包（没装上）' }); continue }

  let entry = 'index.js'
  try {
    const j = JSON.parse(readFileSync(pj, 'utf8'))
    if (j.main) entry = j.main
    else if (j.exports?.['.']) entry = typeof j.exports['.'] === 'string' ? j.exports['.'] : (j.exports['.'].import || j.exports['.'].default || 'index.js')
  } catch (e) { results.push({ name, ok: false, why: 'package.json 读不出：' + e.message }); continue }

  const entryPath = join(pkgDir, entry)
  if (!existsSync(entryPath)) { results.push({ name, ok: false, why: `入口不存在：${entry}` }); continue }

  try {
    await import(pathToFileURL(entryPath).href)
    results.push({ name, ok: true })
  } catch (e) {
    // ★ 原样保留：模块求值期的 ReferenceError / 找不到模块，才是宿主看到的那一条
    results.push({ name, ok: false, why: (e && (e.message || String(e))).slice(0, 300) })
  }
}

const bad = results.filter((r) => !r.ok)
if (JSON_OUT) {
  console.log(JSON.stringify({ ok: bad.length === 0, profile: PROFILE, total: targets.length, failed: bad.length, skipped, results }, null, 2))
} else {
  console.log(`\nprofile = ${PROFILE}`)
  console.log(`  ${targets.length} 个包需要 import（另有 ${skipped} 个 @deepseek-ai/ 宿主包跳过）`)
  for (const r of results) {
    if (r.ok) console.log(`  ✅ ${r.name}`)
    else console.log(`  ❌ ${r.name}\n       ${r.why}`)
  }
  console.log(bad.length === 0
    ? `\n★ 全部 ${targets.length} 个包在安装态 import 成功。`
    : `\n✗ ${bad.length} / ${targets.length} 个包在安装态起不来 —— 这就是宿主启动时看到的「N entries did not activate」。`)
}
process.exit(bad.length === 0 ? 0 : 1)
