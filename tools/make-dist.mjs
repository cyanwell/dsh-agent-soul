#!/usr/bin/env node
// make-dist.mjs —— 产出可发布的两个东西（1.0.65 起）
//
//   dist/AgentSoul-<ver>-portable.zip   解压即用（壳 + runtime + app/<ver> + config + workspace）
//   dist/AgentSoul-Setup-<ver>.exe      安装器（装到 %LOCALAPPDATA%\Programs\AgentSoul，建快捷方式、写卸载项）
//
// ★★★ 为什么要有这个脚本（2026-11-18）
//   1.0.63 的那两个产物**生成脚本在仓库里不存在了** —— publish-release.ps1 和 README
//   都还在引用它们，但没有任何工具能产出。那次只能靠手工拼，而「手工拼四次就有四次漏」。
//   这个脚本把整条链路固化下来，并且**每一步都验**。
//
// ★ 载荷从哪来：**生产 app/<ver>**（release.mjs 已逐文件校验过 ALL PASS）。
//   ★ 不要抄 dist/AgentSoul/app/<旧版本> —— 那个目录是残缺的（实测只有几个文件）。
//
// ★ 与 1.0.63 的包的一个有意差别：**不再把 app/1.0.0 … app/1.0.63 全部 63 个版本目录塞进去**
//   （那个包 1657 条、43.9 MB，大半是历史版本，还带 index.mjs.bak-before-search 这种备份文件）。
//   现在只装当前版本：570 条、36 MB。
//
// 用法：
//   node tools/make-dist.mjs             # 构建并自检
//   node tools/make-dist.mjs --verify     # 构建后跑安装→运行→卸载的端到端验证
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const VER = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).version;
const DEV = process.cwd();
// ★★★ 2026-11-22：**这里我 1.0.74 改错过。**
//
//   1.0.74 我为了「消除 D 盘硬编码」把它写成 `process.cwd()` —— 那是错的：
//   `DEV`（源码在哪）和 `PROD`（**部署到哪**）不是同一个东西。
//   · DEV 可以是 cwd（源码就在你脚下）
//   · PROD 是**目标**，它天生就是一条具体路径 —— 把它也改成 cwd，
//     等于让打包器去 `<仓库>/app/<版本>` 找载荷，而那个目录**永远不存在**。
//
//   症状不是报错，是打包第一步就 die：
//   `✗ 生产载荷不存在，先跑 tools/release.mjs --to=1.0.78：D:\AI\agent-soul\app\1.0.78`
//   ★ 而这条错误看起来像「你忘了先 release」—— **实际是它自己指错了地方。**
//
//   ★ 判据：**「消除硬编码」只该针对「源码在哪里」，不该针对「产物要放到哪里」。**
//     后者的默认值本来就是一个部署约定，允许 env 覆盖就够了。
const PROD = process.env.AGENT_SOUL_PROD || 'C:/Users/pc/Desktop/deepseek harness/agent soul';
const SHELL = path.join(DEV, 'dist/AgentSoul');          // 壳 + WebView2 dll + runtime
const STAGE = path.join(DEV, 'dist/build', 'AgentSoul-' + VER);
const ZIP = path.join(DEV, 'dist', 'AgentSoul-' + VER + '-portable.zip');
const HTMLPATCH = path.join(DEV, 'dist', 'AgentSoul-' + VER + '-htmlpatch.zip');
const SETUP = path.join(DEV, 'dist', 'AgentSoul-Setup-' + VER + '.exe');
const STUB = path.join(DEV, 'build/setup-stub.exe');
const MAGIC = Buffer.from('AGENTSOULPKG01', 'ascii');

const log = (m) => console.log(m);
const die = (m) => { console.error('✗ ' + m); process.exit(1); };

function rmrf(p) { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); }
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  let n = 0;
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) n += copyDir(a, b);
    else { fs.copyFileSync(a, b); n += 1; }
  }
  return n;
}
function walk(d, base = '') {
  const out = [];
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const a = path.join(d, e.name);
    const r = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...walk(a, r));
    else out.push({ r, size: fs.statSync(a).size, abs: a });
  }
  return out;
}

// ── ① 装载 ────────────────────────────────────────────────────────────
log('[' + VER + '] 1/5 构建便携目录');
rmrf(STAGE);
fs.mkdirSync(STAGE, { recursive: true });

// ★★★ 2026-11-21：`AgentSoul.exe.config` 必须跟着 exe 走。
//   它是壳的 DPI 与运行时配置（System.Windows.Forms.ApplicationConfigurationSection），
//   CLR 只按 `<exe 名>.config` 在旁边找 —— 不打进包，用户装的版本就回到「按 96 DPI 排版」，
//   在 125%/150% 缩放的机器上控件偏小、错位（用户实测报告 dpi-blur-report-20261114.md）。
//   ★ 判据：它和 exe 不是"可选附件"，是同一个运行单元的两半。
for (const f of ['AgentSoul.exe', 'AgentSoul.exe.config', 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll', 'THIRD-PARTY-NOTICES.txt']) {
  const s = path.join(SHELL, f);
  if (!fs.existsSync(s)) die('壳缺文件: ' + f);
  fs.copyFileSync(s, path.join(STAGE, f));
}
log('  壳 6 个文件（含 exe.config）');
log('  runtime ' + copyDir(path.join(SHELL, 'runtime'), path.join(STAGE, 'runtime')) + ' 个文件');

// ★★★ 向量模型必须随包走（2026-11-18 补）。
//
//   爀曦 2026-11-17 的原话：「向量层，包括向量模型也要嵌入程序，不然用户安装也是没有的」。
//   echo-embed.mjs 的默认目录就是 <程序根>/models/bge-small-zh，注释里写得很清楚。
//   **但打包器一直没带上它** —— 实测 1.0.63 的 portable.zip 里 models 0 条、.onnx 0 条，
//   也就是说那 160 个下载过 1.0.63 的用户，语义检索从一开始就是不可用的
//   （装着能跑，一问就 MODEL_UNAVAILABLE）。
//
//   为什么 122.7 MB 要整体带、不能只带 onnx：
//     echo-embed 用 createRequire(<modelDir>/package.json) 去 require('@huggingface/transformers')，
//     它再拉 onnxruntime-node 的 win32-x64 原生 .node。实测构成：
//       onnxruntime-node 64.0 MB / @img(sharp) 19.0 / @huggingface 10.3 / 其它 ~5 / 模型本体 22.9
//     少任何一块都是「装上但用不了」。
const MODEL_SRC = path.join(DEV, 'models');
if (!fs.existsSync(path.join(MODEL_SRC, 'bge-small-zh', 'onnx', 'model_quantized.onnx'))) {
  die('向量模型不在 ' + MODEL_SRC + ' —— 装出来的包会没有语义检索');
}
const modelN = copyDir(MODEL_SRC, path.join(STAGE, 'models'));
log('  models/ ' + modelN + ' 个文件（含 onnx 模型本体与 onnxruntime 原生库）');

const PROD_VER = path.join(PROD, 'app', VER);
if (!fs.existsSync(PROD_VER)) die('生产载荷不存在，先跑 tools/release.mjs --to=' + VER + '：' + PROD_VER);
log('  app/' + VER + ' ' + copyDir(PROD_VER, path.join(STAGE, 'app', VER)) + ' 个文件（来自生产载荷）');
fs.writeFileSync(path.join(STAGE, 'app', 'current.txt'), VER + '\n', 'utf8');

// config 必须是发布版（相对 dataDir）
const relCfgPath = path.join(DEV, 'config.release.json');
const cfg = JSON.parse(fs.readFileSync(relCfgPath, 'utf8'));
if (path.isAbsolute(String(cfg.dataDir || ''))) die('config.release.json 的 dataDir 是绝对路径 —— 发布版必须相对');
fs.copyFileSync(relCfgPath, path.join(STAGE, 'config.json'));
log('  config.json（相对 dataDir=' + cfg.dataDir + '）');

// ★ README 要放在**便携目录根**上：用户解压后第一眼要能看到怎么用。
//   注意它不在 app/<ver>/ 里 —— release.mjs 的 PARTS 只有 src/tools/sql，
//   app/<ver>/ 从来没有 README（1.0.63 也没有）。这是既有设计，不改它。
const readmeSrc = path.join(DEV, 'README.md');
if (fs.existsSync(readmeSrc)) {
  fs.copyFileSync(readmeSrc, path.join(STAGE, 'README.md'));
  log('  README.md（' + (fs.statSync(readmeSrc).size / 1024).toFixed(0) + ' KB）');
}

fs.mkdirSync(path.join(STAGE, 'workspace'), { recursive: true });
const wsr = path.join(SHELL, 'workspace/README.txt');
fs.writeFileSync(path.join(STAGE, 'workspace/README.txt'), fs.existsSync(wsr) ? fs.readFileSync(wsr) : '这里是工作区。\n', 'utf8');
log('  workspace/README.txt');

const files = walk(STAGE);
const total = files.reduce((a, f) => a + f.size, 0);
log('  合计 ' + files.length + ' 个文件 / ' + (total / 1048576).toFixed(1) + ' MB');

// ── ② 打 zip（用系统 Compress-Archive —— 自己写的 zip 被 .NET ZipArchive 判过不合法）──
log('[' + VER + '] 2/5 打 portable.zip');
rmrf(ZIP);
execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
  'Compress-Archive -Path ' + JSON.stringify(path.join(STAGE, '*')) + ' -DestinationPath ' + JSON.stringify(ZIP) + ' -CompressionLevel Optimal -Force'],
  { stdio: 'inherit', windowsHide: true });
if (!fs.existsSync(ZIP)) die('zip 没打出来');
log('  ' + (fs.statSync(ZIP).size / 1048576).toFixed(1) + ' MB');

// ── ②b htmlpatch：只换界面（老用户升级界面时用，几 MB）──
// ★ 1.0.63 那个 htmlpatch 是 21 条、129 KB，只含 app/<ver>/src/web 下的界面资源。
//   这里照同样的口径做，但**排除 .mjs 与 .bak-***：
//     - .mjs 是服务端代码，只换 html 却换掉服务端会版本错配；
//     - .bak-* 是开发时的备份，绝对不该发给用户（生产载荷里现在有 5 个）。
log('[' + VER + '] 2b/5 htmlpatch');
const WEB = path.join(STAGE, 'app', VER, 'src', 'web');
const patchStage = path.join(DEV, 'dist/build/_htmlpatch');
rmrf(patchStage);
const patchFiles = fs.readdirSync(WEB, { withFileTypes: true })
  .filter((e) => e.isFile() && /\.(html|css|js)$/i.test(e.name) && !e.name.includes('.bak-'));
let patchBytes = 0;
for (const e of patchFiles) {
  const dst = path.join(patchStage, 'app', VER, 'src', 'web');
  fs.mkdirSync(dst, { recursive: true });
  fs.copyFileSync(path.join(WEB, e.name), path.join(dst, e.name));
  patchBytes += fs.statSync(path.join(WEB, e.name)).size;
}
log('  ' + patchFiles.length + ' 个界面文件 / ' + (patchBytes / 1024).toFixed(0) + ' KB（排除 .mjs 与 .bak-*）');
rmrf(HTMLPATCH);
execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
  'Compress-Archive -Path ' + JSON.stringify(path.join(patchStage, '*')) + ' -DestinationPath ' + JSON.stringify(HTMLPATCH) + ' -CompressionLevel Optimal -Force'],
  { stdio: 'inherit', windowsHide: true });
if (!fs.existsSync(HTMLPATCH)) die('htmlpatch 没打出来');
log('  ' + (fs.statSync(HTMLPATCH).size / 1024).toFixed(0) + ' KB');
rmrf(patchStage);

// ── ③ 编安装器（如果 stub 比源码旧就重编）──
log('[' + VER + '] 3/5 安装器 stub');
const csPath = path.join(DEV, 'build/Setup.cs');
// ★★★ 2026-11-21：mtime 判据**不够**，补一条「版本变了也必须重编」。
//
//   实测事故：AgentSoul-Setup-1.0.70.exe 里 UTF-16 扫出来是 "1.0.65" ——
//   因为版本号原本硬编码在 Setup.cs（1.0.65），而 make-dist 只在
//   「Setup.cs 比 stub 新」时重编；版本号变化不改 Setup.cs 的 mtime，于是一直复用旧 stub。
//   现在版本改从**安装包自己的文件名**推（Setup.cs 的 AppVer()），
//   所以真正该盯的是「这次要打的版本」有没有变 → 上次打的是哪个版本（记在 .stub-ver 里）。
const stampFile = STUB + '.ver';
const wantVer = VER;
const lastVer = fs.existsSync(stampFile) ? fs.readFileSync(stampFile, 'utf8').trim() : '';
const needBuild = !fs.existsSync(STUB)
  || fs.statSync(csPath).mtimeMs > fs.statSync(STUB).mtimeMs
  || lastVer !== wantVer;
if (needBuild) {
  // ★ 2026-11-21：不再在这里手写 csc 参数 —— 走 build/build-aux.ps1。
  //   理由：csc 的参数清单（引用哪一个 dll、langversion、target）
  //   原来分散在 build.ps1 / make-dist.mjs / 手工命令三处，改一处另两处就漂。
  //   现在只有一处真源：build-aux.ps1。
  log('  版本变了或源码更新 —— 走 build-aux.ps1 重编译');
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(DEV, 'build/build-aux.ps1')],
    { stdio: 'inherit', windowsHide: true });
} else log('  stub 是最新的（跳过编译）');
if (!fs.existsSync(STUB)) die('stub 不存在');
// 记下这次编的是哪个版本（下次据此判断要不要重编）
try { fs.writeFileSync(stampFile, wantVer, 'utf8'); } catch { }

// ── ④ 组装 Setup = stub + MAGIC + u64 + zip ───────────────────────────
log('[' + VER + '] 4/5 组装 Setup');
const stub = fs.readFileSync(STUB);
const zip = fs.readFileSync(ZIP);
const sizeBuf = Buffer.alloc(8);
sizeBuf.writeBigUInt64LE(BigInt(zip.length), 0);
const exe = Buffer.concat([stub, MAGIC, sizeBuf, zip]);
rmrf(SETUP);
fs.writeFileSync(SETUP, exe);
log('  ' + (exe.length / 1048576).toFixed(1) + ' MB');

// ── ⑤ 自检 ────────────────────────────────────────────────────────────
log('[' + VER + '] 5/5 自检');
const idx = exe.lastIndexOf(MAGIC);
if (idx < 0) die('Setup 里找不到魔法尾标');
const back = Number(exe.readBigUInt64LE(idx + MAGIC.length));
if (idx + MAGIC.length + 8 + back !== exe.length) die('Setup 尾标自检失败');
log('  ✓ Setup 尾标一致（魔法@' + idx + '，zipLen=' + back + '）');
const zipEntries = (() => { let p = 0, n = 0; while (p < zip.length - 4 && zip.readUInt32LE(p) === 0x04034b50) { const nl = zip.readUInt16LE(p + 26); const el = zip.readUInt16LE(p + 28); const cs = zip.readUInt32LE(p + 18); n += 1; p += 30 + nl + el + cs; } return n; })();
log('  ✓ zip 条目 ' + zipEntries + ' 个');
const inZip = ['AgentSoul.exe', 'AgentSoul.exe.config', 'runtime/node.exe', 'app/current.txt', 'app/' + VER + '/src/db/echo-vector-cache.mjs'];
for (const f of inZip) if (!files.some((x) => x.r === f)) die('便携目录缺: ' + f);
log('  ✓ 关键文件都在');

log('');
log('完成：');
log('  ' + ZIP + '  ' + (fs.statSync(ZIP).size / 1048576).toFixed(1) + ' MB');
log('  ' + SETUP + '  ' + (fs.statSync(SETUP).size / 1048576).toFixed(1) + ' MB');
log('  ' + HTMLPATCH + '  ' + (fs.statSync(HTMLPATCH).size / 1024).toFixed(0) + ' KB');
if (process.argv.includes('--verify')) {
  log('');
  log('── 端到端验证 ──');
  // ★ 路径跟着改名走：_verify_setup.mjs 已转正为 verify-setup.mjs（2026-11-18）。
  //   改名时漏改这个调用方 → --verify 直接 ENOENT。
  //   教训：搜旧口径必须连**调用方**一起搜，只搜文件名不够。
  execFileSync(process.execPath, [path.join(DEV, 'tools/verify-setup.mjs')], { stdio: 'inherit', cwd: DEV });
}
