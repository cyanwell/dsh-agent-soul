#!/usr/bin/env node
// 假 ctx 调 agent_soul_install 的 scan，直接看结果 —— 不经过 DSH、不需要真实宿主。
//
// ★ 为什么留这个脚本（2026-10-22 全面验证报告 P1-1）：
//   scan 那个 bug 是「装了 14 个仍报 13/14」，而它**不报错、只少算一个**。
//   所以判据必须是「同一个 profile、改前改后的数字」：
//     改前 已装 1 / 14，【缺】里有 dsh-huanqi
//     改后 已装 2 / 14，dsh-huanqi  ✓ 已进 bundles
//   留着它，下次改 PKG/nameOf 相关逻辑可以立刻复验。
//
// 用法: node tools/scan-probe.mjs <profile 绝对路径>
const S = 'file:///D:/AI/dsh-tools/dsh-agent-soul/install.js'
const PROFILE = process.argv[2] || 'D:/AI/dsh/home/profiles/desktop'

const { registerInstallTool } = await import(S)
let tool = null
registerInstallTool({ tools: { register(t) { tool = t } } })

const r = await tool.execute({ action: 'scan', profile: PROFILE })
console.log('ok:', r?.ok)
if (!r?.ok) { console.log('error:', r?.error); process.exit(1) }

const text = r.text || ''
const lines = text.split('\n')

console.log('\n=== 汇总行 ===')
for (const l of lines) {
  if (/已装 \d+ \/ \d+/.test(l)) console.log('  ' + l.trim())
}

console.log('\n=== 【缺】那一段 ===')
let inMiss = false
for (const l of lines) {
  if (l.includes('【缺】')) { inMiss = true; console.log('  ' + l.trim()); continue }
  if (inMiss) {
    if (l.trim() === '' || l.includes('【')) break
    console.log('  ' + l.trim())
  }
}

console.log('\n=== huanqi 相关行 ===')
for (const l of lines) {
  if (/huanqi/.test(l)) console.log('  ' + l.trim())
}
