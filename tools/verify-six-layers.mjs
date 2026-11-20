// 六层逐层核对：装 → 跑 bootstrapDataRoot() → 看 L0-L5 各自建出了什么
// ★ 三条实测教训：①真函数名是 bootstrapDataRoot(dataRoot,opts)，同步、没有 .catch；
//   ②装好的 runtime/node.exe 跑子进程时 stdout 常拿不到(exit=0 但 out 空) → 探针写文件，外层读文件；
//   ③探针是写进临时文件再执行的，正则/转义会被模板字符串吃掉 → 探针里不用正则，用 String.fromCharCode(10) 拼。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SETUP = 'D:/AI/agent-soul/dist/AgentSoul-Setup-1.0.65.exe';
const TARGET = path.join(os.tmpdir(), 'as-sixlayer-' + Date.now());
const NL = String.fromCharCode(10);
const run = (exe, args, o) => spawnSync(exe, args, { encoding: 'utf8', timeout: (o && o.timeout) || 300000, stdio: ['ignore', 'pipe', 'pipe'], cwd: (o && o.cwd) });

console.log('安装到 ' + TARGET);
try {
  const inst = run(SETUP, ['/S', '/D=' + TARGET]);
  console.log('安装 exit=' + inst.status);
  const probe = path.join(TARGET, '_probe_six.mjs');
  fs.writeFileSync(probe, "import fs from 'node:fs';\nimport path from 'node:path';\nconst NL = String.fromCharCode(10);\nconst OUT = path.resolve('_six.out');\nconst out = [];\nconst say = (s) => out.push(String(s));\ntry {\n  const P = await import('./app/1.0.65/src/portable.mjs');\n  say('programRoot = ' + P.programRoot());\n  say('seedDir     = ' + P.seedDir());\n  say('seed 里有 = ' + (fs.existsSync(P.seedDir()) ? fs.readdirSync(P.seedDir()).join(',') : '(目录不存在)'));\n  const dr = P.resolveDataRoot();\n  say('resolveDataRoot = ' + JSON.stringify(dr));\n  const r = P.bootstrapDataRoot(dr.dir, { log: (m) => say('    [bootstrap] ' + m) });\n  say('bootstrap created=' + JSON.stringify(r.created) + ' skipped=' + JSON.stringify(r.skipped));\n  const root = r.dataRoot || dr.dir;\n  say('---- 落盘结果 ----');\n  const chk = (label, p) => say('  ' + (fs.existsSync(p) ? 'OK  ' : 'MISS') + ' ' + label + '  ' + p.slice(root.length));\n  chk('L0 hub/', path.join(root, 'hub'));\n  chk('L1 SELF.src.md', path.join(root, 'hub', 'SELF.src.md'));\n  chk('L1 USER.md', path.join(root, 'hub', 'USER.md'));\n  chk('L1 MEMORY.md', path.join(root, 'hub', 'MEMORY.md'));\n  chk('L4 hub/index/', path.join(root, 'hub', 'index'));\n  chk('L3 ledger/02-墨.jsonl', path.join(root, 'ledger', '02-墨.jsonl'));\n  chk('L0 hub/heartbeat/', path.join(root, 'hub', 'heartbeat'));\n  say('  L3 meta.sqlite 应尚未建（主服务首启才建）= ' + (!fs.existsSync(path.join(root, 'meta.sqlite'))));\n  say('  L1 SELF.md(成品)应不存在 = ' + (!fs.existsSync(path.join(root, 'hub', 'SELF.md'))));\n  const sp = path.join(root, 'hub', 'SELF.src.md');\n  if (fs.existsSync(sp)) {\n    const t = fs.readFileSync(sp, 'utf8');\n    say('  SELF.src.md 长度=' + t.length + '  首行=' + JSON.stringify(t.split(NL)[0].replace(String.fromCharCode(13), '')));\n  }\n} catch (e) {\n  say('!! 探针失败: ' + e.message);\n  say((e.stack || '').split(NL).slice(0, 6).join(NL));\n}\nfs.writeFileSync(OUT, out.join(NL), 'utf8');", 'utf8');
  const nodeExe = path.join(TARGET, 'runtime', 'node.exe');
  console.log('');
  console.log('=== 跑 bootstrapDataRoot()（用装好的 node）===');
  const pr = run(nodeExe, [probe], { cwd: TARGET, timeout: 300000 });
  console.log('探针 exit=' + pr.status);
  if (pr.stderr && pr.stderr.trim()) {
    console.log('[stderr]');
    for (const l of pr.stderr.trim().split(NL).slice(0, 10)) console.log('   ' + l);
  }
  const outFile = path.join(TARGET, '_six.out');
  if (fs.existsSync(outFile)) {
    for (const l of fs.readFileSync(outFile, 'utf8').split(NL)) if (l.trim()) console.log(l);
  } else { console.log('（探针没留下 _six.out）'); }
  fs.rmSync(probe, { force: true });
} finally {
  try { spawnSync('taskkill', ['/IM', 'AgentSoul.exe', '/F'], { stdio: 'ignore' }); } catch { }
  await new Promise((r) => setTimeout(r, 400));
  try { fs.rmSync(TARGET, { recursive: true, force: true }); } catch { }
  console.log('清理: ' + !fs.existsSync(TARGET));
}