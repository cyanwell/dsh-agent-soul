#!/usr/bin/env node
// scan-dev-literals.mjs —— 开发机路径字面量清单（R1 的「可复跑」那一半）
//
// 为什么要有它：实现报告说「17 处」，独立验收者数到「10 处 / 9 个文件」。
//   两个数字都对不上，因为**没人写出复跑方法**。一个说不出复跑方法的数字，不该进状态文档。
//   这个脚本把口径钉死在这里：模式表 + 计数单位 + 分类 + 判定。
//
// 计数单位（唯一口径）：**一个文件的一行 = 一次命中**；同一行命中多个模式只记 1 次（模式都列出来）。
//   → 所以「17」「10」的差异只能来自两件事：① 扫的根不同（src 全树 vs 分发负载）
//     ② 模式宽窄不同。脚本用 --preset 把两者都跑出来，数字就能对账。
//
// 用法：
//   node build\pack\scan-dev-literals.mjs                      # 扫 dist\AgentSoul\app 下**当前**版本
//   node build\pack\scan-dev-literals.mjs --root D:\AI\agent-soul\src
//   node build\pack\scan-dev-literals.mjs --preset strict|wide   # strict = 验收者口径
//   node build\pack\scan-dev-literals.mjs --json
//
// 退出码：存在「需改（needs-fix）」命中 → 1；否则 0。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const preset = (argv[argv.indexOf('--preset') + 1] && argv.includes('--preset')) ? argv[argv.indexOf('--preset') + 1] : 'wide';
const rootsArg = [];
for (let i = 0; i < argv.length; i++) if (argv[i] === '--root') rootsArg.push(argv[i + 1]);
const roots = rootsArg.length ? rootsArg : [path.join(REPO, 'dist', 'AgentSoul', 'app', readCurrent())];

function readCurrent() {
  try { return fs.readFileSync(path.join(REPO, 'dist', 'AgentSoul', 'app', 'current.txt'), 'utf8').trim(); }
  catch { return '1.0.1'; }
}

// ── 模式表 ────────────────────────────────────────────────────────────────
// strict = 独立验收者用的那三条（能复现「10 处」）
// wide   = 全 D:/AI/ 前缀（把 dsh / memory / dsh-tools / _backup 一起抓出来）
const PATTERNS = preset === 'strict'
  ? [
      { id: 'devroot-soul-or-as', re: /D:[\\/]AI[\\/](?:yanqing-soul|agent-soul)/g, what: '开发根 yanqing-soul / agent-soul' },
      { id: 'devroot-dsh', re: /D:[\\/]AI[\\/]dsh[\\/]/g, what: '开发机 DSH home' },
      { id: 'user-pc', re: /C:[\\/]Users[\\/]pc/gi, what: '开发机用户目录' },
    ]
  : [
      { id: 'devroot-soul', re: /D:[\\/]AI[\\/]yanqing-soul/g, what: '书房根' },
      { id: 'devroot-agent-soul', re: /D:[\\/]AI[\\/]agent-soul/g, what: '仓库根' },
      { id: 'devroot-dsh', re: /D:[\\/]AI[\\/]dsh(?:-tools)?[\\/]/g, what: 'DSH / dsh-tools' },
      { id: 'devroot-memory', re: /D:[\\/]AI[\\/]memory/g, what: '记忆库' },
      { id: 'devroot-backup', re: /D:[\\/]AI[\\/]_backup/g, what: '开发机备份目录' },
      { id: 'devroot-other', re: /D:[\\/]AI[\\/]/g, what: '其它 D:/AI/ 前缀' },
      { id: 'user-pc', re: /C:[\\/]Users[\\/]pc/gi, what: '开发机用户目录' },
    ];

const TEXT_EXT = new Set(['.mjs', '.js', '.cjs', '.html', '.css', '.json', '.md', '.txt', '.cs', '.ps1', '.yml', '.yaml']);

// ── 已知且已判定的「可运行回退」─────────────────────────────────────────────
// 判据：命中是**代码里的默认值**，且 ① 有显式配置 / 环境变量覆盖入口 ② 取不到时给出
//   可理解的降级（不静默写 0、不假装成功）。每条都必须写清"为什么不用改"。
const KNOWN = [
  {
    file: 'src/config.mjs',
    test: (text) => /^\s*(soulRoot|statusDir|dshHome|sessionRoot|backupDir|workspace|prunerContract):\s*'/.test(text),
    cat: 'runtime-fallback',
    why: 'ALL 开发机默认值的唯一声明点（DEV_PATHS）。任何使用点都必须经 devPathOr()/devFileOr()/statusDirOf()，那三个函数的第一条判据就是"目录/文件真的存在吗"——不存在就回落安装根。集中一处 + 存在性判据，正是 R1 的修法；不是散落硬编码。',
  },
  {
    file: 'src/organs/context.mjs',
    cat: 'runtime-fallback',
    why: 'dshHome 判据是 opts.dshHome || DSH_HOME || 默认值；只影响"读宿主上下文"这一项，读不到就按缺失处理。默认值本身不会被写进任何产物路径。',
  },
  {
    file: 'tools/soul-sync.mjs',
    cat: 'runtime-fallback',
    why: '同步工具的源目录：val("src", ...) 可由参数覆盖，只在宿主侧主动跑；分发版不自动执行它，也不在状态页显示这个路径。',
  },
];

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!/node_modules|^\.git$/.test(e.name)) walk(p, out); }
    else if (TEXT_EXT.has(path.extname(e.name).toLowerCase())) out.push(p);
  }
  return out;
}

function classifyLine(line, hitIndex, ext) {
  if (ext === '.md' || ext === '.txt') return 'doc-example';
  const before = line.slice(0, hitIndex);
  if (before.includes('//') || before.includes('/*')) return 'doc-example';
  const t = line.trim();
  if (t.startsWith('*') || t.startsWith('#') || t.startsWith('<!--') || t.startsWith('--')) return 'doc-example';
  return 'code';
}

const report = { preset, roots: [], totals: { files: 0, hits: 0, uniqueFiles: 0 } };
const allHits = [];

for (const root of roots) {
  const abs = path.resolve(root);
  if (!fs.existsSync(abs)) { report.roots.push({ root: abs, error: 'not-found' }); continue; }
  const files = walk(abs, []);
  const hits = [];
  for (const f of files) {
    const rel = path.relative(REPO, f).split(path.sep).join('/');
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const ext = path.extname(f).toLowerCase();
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const matched = [];
      let firstIdx = -1;
      for (const p of PATTERNS) {
        p.re.lastIndex = 0;
        const m = p.re.exec(line);
        if (m) { matched.push(p.id); if (firstIdx < 0 || m.index < firstIdx) firstIdx = m.index; }
      }
      if (!matched.length) continue;
      const cls = classifyLine(line, firstIdx, ext);
      const known = KNOWN.find((k) => rel.endsWith(k.file) && (!k.test || k.test(line)));
      const cat = cls === 'doc-example' ? 'doc-example' : (known ? known.cat : 'needs-fix');
      const rec = { root: abs, file: rel, line: i + 1, patterns: matched, cls, cat, text: line.trim().slice(0, 220),
        why: cat === 'runtime-fallback' ? known.why : null };
      hits.push(rec); allHits.push(rec);
    }
  }
  report.roots.push({ root: abs, files: files.length, hits: hits.length, uniqueFiles: new Set(hits.map((h) => h.file)).size, detail: hits });
  report.totals.files += files.length;
  report.totals.hits += hits.length;
}

const by = (key) => allHits.reduce((a, h) => { const v = key === 'patterns' ? h.patterns.join('+') : h[key]; a[v] = (a[v] || 0) + 1; return a; }, {});
report.totals.uniqueFiles = new Set(allHits.map((h) => h.file)).size;
report.byClass = by('cat');
report.byPattern = by('patterns');
const needsFix = allHits.filter((h) => h.cat === 'needs-fix');

if (JSON_OUT) {
  console.log(JSON.stringify({ ...report, needsFix: needsFix.length }, null, 2));
} else {
  console.log('# dev-literal scan  preset=' + preset);
  for (const r of report.roots) {
    if (r.error) { console.log('root: ' + r.root + '  [NOT FOUND]'); continue; }
    console.log('root: ' + r.root);
    console.log('  files-scanned=' + r.files + '  hits=' + r.hits + '  unique-files=' + r.uniqueFiles);
    for (const h of r.detail) {
      console.log('  ' + h.file + ':' + h.line + '  [' + h.cat + ']  (' + h.patterns.join(',') + ')');
      console.log('      ' + h.text);
      if (h.why) console.log('      why-ok: ' + h.why);
    }
  }
  console.log('---');
  console.log('totals: roots=' + report.roots.length + ' files=' + report.totals.files + ' hits=' + report.totals.hits + ' unique-files=' + report.totals.uniqueFiles);
  console.log('by-class: ' + JSON.stringify(report.byClass));
  console.log('by-pattern: ' + JSON.stringify(report.byPattern));
  console.log('needs-fix=' + needsFix.length);
}
process.exit(needsFix.length === 0 ? 0 : 1);
