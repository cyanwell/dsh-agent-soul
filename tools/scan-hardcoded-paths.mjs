#!/usr/bin/env node
/**
 * scan-hardcoded-paths.mjs —— 找出所有「换台机器就坏」的本机路径
 * ================================================================
 *
 * ★ 为什么需要它（2026-11-03）
 * ---------------------------
 * tools/verify-packaging.mjs 里那条「代码里没有写死的本机路径」只认裸路径：
 *
 *     PATTERNS = [/\bD:[\\/]AI[\\/]/, /\bC:[\\/]Users[\\/]pc[\\/]/i]
 *
 * JS 字符串里的**转义反斜杠**（'D:\\\\AI\\\\...'）和 join('D:','AI') 拼接**全部漏检**。
 * 所以那条检查绿了，只说明「没有裸路径」，不等于「换台机器能跑」。
 *
 * 这个脚本把转义形式也一起找出来，并**分类**：
 *   真路径   会真的执行 → 换台机器会坏
 *   注释     不执行 → 只是文档，可留
 *   测试     故意的假数据 → 不该改
 *   UI文案   显示给人看的 → 可留
 *
 * 用法：
 *   node tools/scan-hardcoded-paths.mjs            # 全部列出，退出码 0
 *   node tools/scan-hardcoded-paths.mjs --strict   # 有「真路径」就退出码 1
 *
 * ★ 默认**不**挂进 verify-packaging —— 因为现在有 51 处真路径，
 *   一挂上去就会让闸门从全绿变全红。先逐包修，修完再挂。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ★★ 2026-11-03 踩过的坑：原来写的是
//     path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/\/([A-Za-z]:)/, '$1'))
//   Windows 上 pathname 得到 '/D:/AI/...'（**单个**前导斜杠），我的正则只处理了 '//D:'
//   → ROOT 变成 'D:AI...' → readdirSync 全部 catch 掉 → **扫到 0 处、报「✓ 扫描完成」**。
//   ★ 这是「写了但没生效」最坏的一种：**检查工具出错时默认全绿**。
//   ★ 判据：任何扫描器写完后，必须在一个「已知有问题」的目录上跑一次，看不到东西就是它坏了。
const HERE = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(HERE), '..');
const SCAN_DIRS = ['plugins', 'tools', 'kit', 'soul'];
const SKIP = new Set(['node_modules', '.git', 'archive']);

const hits = [];
function walk(dir) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!/\.(mjs|js|ts)$/.test(e.name) || e.name.includes('.bak')) continue;
    let lines;
    try { lines = fs.readFileSync(p, 'utf8').split('\n'); } catch { continue; }
    lines.forEach((l, i) => {
      const m = l.match(/['"]((?:D|C):[\\/]{1,2}(?:AI|Users|WanGP))/)
             || l.match(/join\(\s*['"](?:D|C)['"]\s*,/);
      if (!m) return;
      const rel = path.relative(ROOT, p).replace(/\\/g, '/');
      const t = l.trim();
      let kind;
      if (/^\/\/|^\*|^\/\*/.test(t)) kind = '注释';
      else if (/\.(spec|test)\.|\/test\//.test(rel)) kind = '测试';
      else if (/h\(/.test(t)) kind = 'UI文案';
      else kind = '真路径';
      hits.push({ f: rel, n: i + 1, kind, t: t.slice(0, 70) });
    });
  }
}
for (const d of SCAN_DIRS) walk(path.join(ROOT, d));

const byKind = {};
for (const h of hits) (byKind[h.kind] = byKind[h.kind] || []).push(h);

console.log('扫了 ' + SCAN_DIRS.join('/') + '，共 ' + hits.length + ' 处本机路径：');
for (const k of ['真路径', '注释', '测试', 'UI文案']) {
  console.log('  ' + k.padEnd(6) + (byKind[k] || []).length);
}

const real = byKind['真路径'] || [];
if (real.length) {
  console.log('\n════ 真路径（换台机器会坏）════');
  const per = {};
  for (const h of real) (per[h.f] = per[h.f] || []).push(h);
  for (const f of Object.keys(per).sort()) {
    console.log('\n' + f + '  (' + per[f].length + ')');
    for (const h of per[f]) console.log('  :' + h.n + '  ' + h.t);
  }
}

const strict = process.argv.includes('--strict');
if (strict && real.length) {
  console.log('\n✗ --strict：还有 ' + real.length + ' 处真路径未处理');
  process.exit(1);
}
console.log('\n✓ 扫描完成' + (real.length ? '（' + real.length + ' 处待改）' : ''));
