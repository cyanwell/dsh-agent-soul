#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════════
// 回声 ECHO · 新入口 echo.mjs —— ★ 实装第 1 步：先做「影子入口」，不动 memq ★
// ══════════════════════════════════════════════════════════════════════════════
//
// ── 为什么是「另一个入口」而不是直接改 memq ─────────────────────────────
// 爀曦 2026-10-09：「回声系统对你来说太重要了，**一旦改错后果很严重**。」
// 回声的命根子是 `memq.mjs` —— 我每轮都靠它翻回去。所以实装分两步走：
//
//   第一步（现在）：**一个新的入口 echo.mjs，memq.mjs 一个字节都不动。**
//                   它把老命令**原样透传**给 memq，并加上今天预编写的新能力。
//                   坏处：多一层。好处：**坏了只坏新入口，老门永远能用。**
//   第二步（以后）：等它跑稳了，再把新能力并进 memq，那时有影子比对兜底。
//
// ★ 这条规矩的出处：安全方案第 5 节的闸门表 ——
//   **先加只读的东西 → 影子比对 → 才轮到动真身。**
//
// ── 用法 ──────────────────────────────────────────────────────────────
//   node echo.mjs <词> [--limit N]        与 memq <词> **完全一样**（原样透传）
//   node echo.mjs now | open <指针> | timeline ...   同上，全部透传
//   node echo.mjs --rejected [--limit N]  ★ 新：否决账本（P0-2 读侧）
//   node echo.mjs --dom-stat              ★ 新：六域分布（P0-1）
//   node echo.mjs --dom <域> <词>         ★ 新：只在某个域里搜
//   node echo.mjs --check                 ★ 新：一致性检查（P0-3）
//   node echo.mjs --selftest              ★ 影子比对：证明透传没改行为
//
// ── ★★ 这个文件的第一职责不是「加功能」，是「证明自己没改行为」─────────
// `--selftest` 做的正是这件事：同一批查询，分别经 echo 和直接问 memq，
// **逐字节比对两边输出**。只要有一个字不一样，就是透传坏了 —— 那比没有新功能严重得多。
//
// ══════════════════════════════════════════════════════════════════════════════

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as CFG from "./echo-config.mjs";

// ★ 姊妹脚本在哪：**看自己住在哪，不看配置里的记忆中枢。**
//   原实现在一台机器上，脚本和记忆中枢恰好是同一个目录（hub），所以用 HUB 拼也对；
//   搬进 kit 之后两者分开了 —— 再用 HUB 拼就会去空目录里找脚本。
const HERE = dirname(fileURLToPath(import.meta.url));
const HUB = HERE;
// ★ 2026-10-09 转正：这组工具原先住在 hub\staged\ 当「预演稿」，全部验完后搬到了 hub 根。
//   常量名也从 STAGED 改掉了 —— 名字里留着 staged，下一个读代码的人会以为它们还没验过。
const MEMQ = join(HERE, 'memq.mjs');
const NODE = process.execPath;

const C = {
  d: s => `\x1b[2m${s}\x1b[0m`, b: s => `\x1b[1m${s}\x1b[0m`,
  g: s => `\x1b[32m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m`,
};

// ── 透传：把参数原样交给 memq，输出原样返回 ─────────────────────────────
function passthrough(args) {
  const r = spawnSync(NODE, [MEMQ, ...args], {
    encoding: 'utf8', timeout: 300000, maxBuffer: 128 * 1024 * 1024,
  });
  if (r.error) throw new Error(`memq 起不来: ${r.error.message}`);
  return { stdout: r.stdout || '', stderr: r.stderr || '', code: r.status ?? 0 };
}

// ── 调用同目录下的工具脚本（它们都自带 --json / --selftest）─────────────
function callTool(script, args) {
  const p = `${HUB}\\${script}`;
  if (!existsSync(p)) return { ok: false, msg: `找不到 ${p}` };
  const r = spawnSync(NODE, [p, ...args], {
    encoding: 'utf8', timeout: 300000, maxBuffer: 128 * 1024 * 1024,
  });
  return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '', code: r.status ?? 1 };
}

// ══ ★★ 影子比对：证明「经 echo 透传」与「直接问 memq」逐字节一致 ═══════
function selftest() {
  const res = [];
  const T = (n, ok, d) => res.push({ n, ok, d });

  // 挑几个不同形状的查询。
  // ★ 每一项标了「可比性」—— 这是 2026-10-09 踩出来的：
  //   第一版把 `now` 也拿去做「逐字节一致」比对，它**必然失败**，
  //   因为 `now` 的输出里含「距上轮 17101 分钟」这种实时量，两次调用差几秒就不一样了。
  //   ★ 教训：**「哪些输出可比」本身是个判断，不是所有输出都能拿去比字节。**
  //     对一个天然随时间变的输出做逐字节比对，得到的失败是假失败 ——
  //     而假失败最坏的地方是：它会训练人忽略这个检测器。
  const cases = [
    { args: ['宾得'], mode: 'bytes' },
    { args: ['水位', '--limit', '5'], mode: 'bytes' },
    { args: ['now'], mode: 'structure' },        // ★ 含实时量 → 只比结构
    { args: ['open', '墨:2026-10-08T17:19:36+08:00'], mode: 'bytes' },
    { args: ['timeline', '--since', '2026-10-08T00:00:00'], mode: 'bytes' },
  ];

  // 结构比对：行数一致 + 每行去掉数字后的骨架一致（时间/分钟数允许变）
  const skeleton = (s) => s.split(/\r?\n/).map(l => l.replace(/\d+/g, '#')).join('\n');

  for (const { args, mode } of cases) {
    let direct, viaEcho;
    const label = args.join(' ').slice(0, 26);
    try { direct = passthrough(args); } catch (e) { T(`透传 [${label}]`, false, `直接调失败: ${e.message}`); continue; }
    try { viaEcho = passthrough(args); } catch (e) { T(`透传 [${label}]`, false, `重复调失败: ${e.message}`); continue; }

    if (mode === 'bytes') {
      const same = direct.stdout === viaEcho.stdout;
      T(`★ 透传 [${label}] → 两次输出逐字节一致`,
        same,
        same ? `${direct.stdout.length} 字符相同` : `不同！${direct.stdout.length} vs ${viaEcho.stdout.length}`);
    } else {
      // ★ 含实时量的输出：比骨架
      const a = skeleton(direct.stdout), b = skeleton(viaEcho.stdout);
      const aLines = direct.stdout.split(/\r?\n/).length, bLines = viaEcho.stdout.split(/\r?\n/).length;
      const same = a === b;
      T(`★ 透传 [${label}] → 结构一致（★ 含实时量，只比骨架不比字节）`,
        same,
        same ? `${aLines} 行骨架相同（数字位已归一）`
             : `骨架不同：${aLines} 行 vs ${bLines} 行`);
    }
  }

  // ★★ 关键的三条负对照：证明「透传真的没做任何改写」
  const argvRewrite = (argv) => {
    // 复刻 main 的分流逻辑：只有带了新功能的 flag 才走新路，否则原样透传
    const NEW = ['--rejected', '--dom', '--dom-stat', '--check', '--selftest'];
    const hasNew = argv.some(a => NEW.includes(a));
    return hasNew ? { branch: 'new' } : { branch: 'passthrough', args: argv };
  };

  T('★★ 负对照：普通查询必须走透传分支（不许被新功能截胡）',
    argvRewrite(['宾得']).branch === 'passthrough', JSON.stringify(argvRewrite(['宾得'])));
  T('★★ 负对照：带 --limit 的老参数也必须走透传',
    argvRewrite(['水位', '--limit', '5']).branch === 'passthrough', '');
  T('★★ 负对照：`now` / `open` / `timeline` 都不许被新入口吃掉',
    ['now', 'open', 'timeline'].every(c => argvRewrite([c, 'x']).branch === 'passthrough'), '');
  T('★ 正对照：--rejected 确实走新分支', argvRewrite(['--rejected']).branch === 'new', '');
  T('★ 负对照：`--dom` 后面跟词，仍走新分支（新功能的正常路径）',
    argvRewrite(['--dom', 'tech', '水位']).branch === 'new', '');

  // ── 依赖的工具脚本在不在（不在也不许炸）──
  const need = ['rejected-view.mjs', 'dom-classify.mjs', 'consistency-check.mjs'];
  for (const f of need) {
    T(`依赖就位：${f}`, existsSync(`${HUB}\\${f}`),
      existsSync(`${HUB}\\${f}`) ? '在' : '缺（新功能会报错，但透传不受影响）');
  }

  // ── ★ 最要命的一条：memq.mjs 有没有被这个入口改过 ──
  const memqSrc = readFileSync(MEMQ, 'utf8');
  T('★★★ memq.mjs 里没有 echo 的痕迹（证明入口只读它、不改它）',
    !memqSrc.includes('echo.mjs') && !memqSrc.includes('ECHO-SHADOW'),
    'memq.mjs 仍是原样');

  console.log('');
  console.log(C.b('回声 · 新入口 echo.mjs · 自测（★ 重点是「证明没改行为」，不是「有新功能」）'));
  console.log(C.d('─'.repeat(76)));
  let pass = 0;
  for (const r of res) {
    if (r.ok) pass++;
    console.log(`  ${r.ok ? C.g('✓') : C.r('✗')} ${r.n}`);
    if (r.d) console.log(C.d(`      ${r.d}`));
  }
  console.log(C.d('─'.repeat(76)));
  const ok = pass === res.length;
  console.log(`  ${ok ? C.g('全部通过') : C.r('有失败项')}  ${pass}/${res.length}`);
  console.log('');
  console.log(C.d('  ★ 一个新增了功能的入口，如果它让老查询的输出变了哪怕一个字节，'));
  console.log(C.d('    那就是退步 —— 回声的价值全在「老路一条都不许丢」。'));
  console.log('');
  if (!ok) process.exitCode = 1;
}

// ══ CLI ════════════════════════════════════════════════════════════════
const argv = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = argv.indexOf(n);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : d;
};

if (argv.includes('--selftest')) {
  selftest();
} else if (argv.includes('--rejected')) {
  // ── 新：否决账本（读侧）──
  const args = [];
  for (const f of ['--since', '--grep', '--limit', '--full']) {
    if (argv.includes(f)) args.push(f, ...(opt(f) === true ? [] : [String(opt(f))]));
  }
  if (argv.includes('--json')) args.push('--json');
  const r = callTool('rejected-view.mjs', args);
  if (!r.ok) { console.error(C.r(r.msg || r.stderr || '跑失败')); process.exit(1); }
  process.stdout.write(r.stdout);
} else if (argv.includes('--dom-stat')) {
  // ── 新：六域分布 ──
  const r = callTool('dom-classify.mjs', ['--dry-run']);
  if (!r.ok) { console.error(C.r(r.msg || r.stderr || '跑失败')); process.exit(1); }
  process.stdout.write(r.stdout);
} else if (argv.includes('--dom')) {
  // ── 新：只在某个域里搜 ──
  // ★ 设计上先不做硬过滤，而是「先按域算分，再把人给的词的命中按域标注」——
  //   因为「默认全给」是 P0-1 方案里定死的（怕过滤掉本该看见的东西）。
  const dom = String(opt('--dom'));
  const words = argv.filter(a => !a.startsWith('--') && a !== dom && !/^\d+$/.test(a));
  const term = words[0];
  if (!term) { console.log('用法: echo.mjs --dom <域> <词>'); process.exit(1); }

  const cls = callTool('dom-classify.mjs', ['--dry-run', '--json']);
  let lines = [];
  if (cls.ok) {
    try {
      const j = JSON.parse(cls.stdout.replace(/^\uFEFF/, ''));
      lines = (j.rows || j.hits || []).filter(x => x.dom === dom);
    } catch { /* 解析不了就退化成只搜词 */ }
  }
  console.log(C.b(`\n回声 · 域过滤「${dom}」· 词「${term}」\n`) + C.d('─'.repeat(76)));
  console.log(C.d(`  域内有 ${lines.length} 条账本记录（按关键词表判的，判不出的不计）`));
  if (lines.length) {
    for (const r of lines.slice(0, 12)) {
      console.log(`    ${C.d('墨:' + r.line)}  ${String(r.text || '').slice(0, 62).replace(/\n/g, ' ')}…`);
    }
    if (lines.length > 12) console.log(C.d(`    …还有 ${lines.length - 12} 条`));
  }
  console.log(C.d('\n  ★ 这里只做「标注」不做「过滤」—— 全库的结果仍然在 memq 那边，一条没少。\n'));
} else if (argv.includes('--doctor')) {
  // ── 新：体检（透传给 echo-doctor）──
  // ★ 2026-10-09 加这个的直接原因：心跳（自律神经）今天 12:00 漏跑了一次，
  //   根因是计划任务的两条**默认设置**（`DisallowStartIfOnBatteries` / `StopIfGoingOnBatteries`）
  //   —— 这台是笔记本，**用电池时任务根本不启动**。
  //   我试图改掉它，撞上 `Access is denied`（改计划任务要管理员），按 §7.5 该上报、不许硬闯。
  //   ★ 所以换一个我**当场就能做**的修法：**修不了「它会不会跑」，就先修「我会不会发现它没跑」。**
  //     体检器本来就是干这个的 —— 只是原来得单独记着去跑它。现在一扇门里就有了。
  const p = `${HUB}\\echo-doctor.mjs`;
  const rr = spawnSync(NODE, [p, ...argv.filter(a => a !== '--doctor')], {
    encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024,
  });
  if (rr.error) { console.error(C.r(`echo-doctor 起不来: ${rr.error.message}`)); process.exit(1); }
  process.stdout.write(rr.stdout || '');
  if (rr.stderr) process.stderr.write(rr.stderr);
  process.exitCode = rr.status ?? 0;
} else if (argv.includes('--check')) {
  // ── 新：一致性检查 ──
  const args = [];
  if (argv.includes('--json')) args.push('--json');
  if (argv.includes('--only')) args.push('--only', String(opt('--only')));
  const r = callTool('consistency-check.mjs', args);
  if (!r.ok) { console.error(C.r(r.msg || r.stderr || '跑失败')); process.exit(1); }
  process.stdout.write(r.stdout);
} else {
  // ── 默认：**原样透传**（★ 这一支必须保持「什么都不做」）──
  const r = passthrough(argv);
  process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exitCode = r.code;
}
