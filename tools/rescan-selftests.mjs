// 重扫 selftest 日志：只按断言文本判红（不重跑）
//
// ★ 为什么要它：**runner 的 exit code 不可信**。
//   PowerShell 会把 node 的 ExperimentalWarning 当 stderr 判成 NativeCommandError，
//   于是 exit=1 而套件其实全绿（2026-11-18 实测：echo-vectors 9 条全 PASS 但 exit=1）。
//   判据只认断言文本 = 「通过 N 项 · 失败 M 项」里 M>0，或行首 ✗。
//   也别被「行里含中文『失败』」骗到 —— autonomy-selftest 有一行是
//   「✓ ★ 心跳不可用 → UNKNOWN，读心跳**失败**：ECONNREFUSED」，
//   那是测试**名称**，不是失败。所以判据要先排除 ✓/✔ 开头的行。
import fs from 'node:fs';
import path from 'node:path';

const OUT = 'D:/AI/agent-soul/_selftest_logs';
const files = fs.readdirSync(OUT).filter((f) => f.endsWith('.log'));

const num = [
  /失败\s*(\d+)\s*项/g,
  /(\d+)\s*passed\s*[,/]\s*(\d+)\s*failed/gi,
  /通过\s*(\d+)\s*项?\s*[/·]\s*失败\s*(\d+)/g,
  /(\d+)\s*通过\s*[/·]\s*(\d+)\s*失败/g,
  /FAILED\s*(\d+)/g,
];

// 真红行：整行去空白后以 ✗ / ✘ / FAIL / not ok / X 开头（不含 ✓ 前缀）
function isRedLine(line) {
  const t = line.trim();
  if (t.startsWith('✓') || t.startsWith('✔') || t.startsWith('√')) return false;
  return /^(✗|✘|×|FAIL\b|not ok\b|- FAIL)/.test(t);
}

const results = [];
for (const f of files) {
  const text = fs.readFileSync(path.join(OUT, f), 'utf8');
  const lines = text.split(/\r?\n/);
  const redLines = lines.filter(isRedLine);
  let failCount = null;
  let passCount = null;
  for (const rx of num) {
    rx.lastIndex = 0;
    let m;
    while ((m = rx.exec(text)) !== null) {
      const groups = m.slice(1).filter((x) => x !== undefined);
      if (groups.length === 2) { passCount = Number(groups[0]); failCount = Number(groups[1]); }
      else if (groups.length === 1) { failCount = Number(groups[0]); }
    }
  }
  const crashed = /^Uncaught|UnhandledPromiseRejection|^TypeError:|^SyntaxError:|^ReferenceError:/m.test(text);
  results.push({ name: f.replace(/\.log$/, ''), redLines, failCount, passCount, crashed, bytes: text.length });
}

const real = results.filter((r) => (r.failCount !== null && r.failCount > 0) || r.redLines.length > 0 || r.crashed);
real.sort((a, b) => (b.failCount || 0) - (a.failCount || 0));
console.log('日志总数=' + results.length + '  有红的=' + real.length);
console.log('');
for (const r of real) {
  console.log('■ ' + r.name + '  fail=' + r.failCount + ' pass=' + r.passCount + ' redLines=' + r.redLines.length + (r.crashed ? '  [CRASH]' : ''));
  for (const l of r.redLines.slice(0, 8)) console.log('     ' + l.trim().slice(0, 190));
}
console.log('');
console.log('=== 全绿（fail=0 且无红行）===');
const clean = results.filter((r) => !real.includes(r));
console.log(clean.map((r) => r.name).join('  '));
