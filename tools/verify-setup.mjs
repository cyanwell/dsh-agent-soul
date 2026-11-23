// 端到端验证安装包：静默安装 → 检查文件 → 启动 → HTTP → 卸载 → 检查清理
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync, spawnSync } from 'node:child_process';

// ★★★ 2026-11-21：版本号**不再硬编码**。
//
//   实测事故：这一行写着 1.0.65，而 make-dist 打的是 1.0.71 ——
//   于是 `make-dist --verify` **验的是一年前的包**，还把 1.0.65 的 current.txt 当成
//   本次产物报了 PASS。**假绿灯比红灯更坏**：红灯你会去查，绿灯你会信。
//
//   现在：版本唯一真相 = package.json，安装包名与 app 目录名都从它推。
// ★★ 2026-11-21：**版本唯一真相 = package.json，而且路径也得跟着仓库走。**
//   原来两处都写死 'D:/AI/agent-soul' —— 子会话第一次只把"文件名"改成动态的，
//   路径那一半原样留着，于是**换台机器照样跑不了**（报告 #2 说的就是这一条）。
//   ★ 判据：**"改成动态"要连路径一起想，只改一半等于没改。**
const PKG_ROOT = path.resolve(__dirname, '..')
const VER = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version;
const SETUP = path.join(PKG_ROOT, 'dist', 'AgentSoul-Setup-' + VER + '.exe');
if (!fs.existsSync(SETUP)) {
  console.error('✗ 找不到安装包：' + SETUP);
  console.error('  先跑 node tools/make-dist.mjs（当前 package.json 版本 = ' + VER + '）');
  process.exit(1);
}
const TARGET = path.join(os.tmpdir(), 'as-setup-verify-' + Date.now());
const UNINSTALL_KEY = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\AgentSoul`;
const START_MENU_LINK = path.join(process.env.APPDATA, 'Microsoft/Windows/Start Menu/Programs/AgentSoul/AgentSoul.lnk');
const START_MENU_DIR = path.dirname(START_MENU_LINK);
const DESKTOP_LINK = path.join(process.env.USERPROFILE, 'Desktop/AgentSoul.lnk');
const PRODUCTION_ROOT = 'C:\\Users\\pc\\Desktop\\deepseek harness\\agent soul';
const existingInstallResult = spawnSync('reg', ['query', UNINSTALL_KEY], { stdio: 'ignore' });
const coreCheck = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  "$root='C:\\Users\\pc\\Desktop\\deepseek harness\\agent soul'; Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { ($_.ExecutablePath -eq (Join-Path $root 'runtime\\node.exe') -or $_.ExecutablePath -eq (Join-Path $root 'AgentSoul.exe')) -and $_.CommandLine -like '*src\\index.mjs*' } | Select-Object -ExpandProperty ExecutablePath"], { encoding: 'utf8' });
const portCheck = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  "$c=New-Object System.Net.Sockets.TcpClient; try { $a=$c.BeginConnect('127.0.0.1',7310,$null,$null); if(-not $a.AsyncWaitHandle.WaitOne(1500)){exit 2}; $c.EndConnect($a); exit 0 } catch { exit 1 } finally { $c.Dispose() }"] , { encoding: 'utf8' });
const preflightFailed = existingInstallResult.error || coreCheck.error || coreCheck.status !== 0 || portCheck.error || portCheck.status === 2;
const existingInstall = existingInstallResult.status === 0;
const existingCorePaths = String(coreCheck.stdout || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
const portInUse = portCheck.status === 0;
if (preflightFailed || existingInstall || existingCorePaths.length > 0 || portInUse || fs.existsSync(START_MENU_LINK) || fs.existsSync(START_MENU_DIR) || fs.existsSync(DESKTOP_LINK)) {
  console.error('✗ 安全拒绝：发现现有 AgentSoul 注册项、快捷方式或进程；E2E 不覆盖现有安装。');
  process.exit(2);
}
let child = null;
function run(exe, args, opts) {
  const o = opts || {};
  const r = spawnSync(exe, args, { encoding: 'utf8', timeout: o.timeout || 180000, stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

const probe = (port) => new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port, path: '/api/status', timeout: 3000 }, (res) => {
    let b = '';
    res.on('data', (d) => { b += d; });
    res.on('end', () => resolve({ ok: true, code: res.statusCode, len: b.length }));
  });
  req.on('error', (e) => resolve({ ok: false, err: e.code || e.message }));
  req.on('timeout', () => { req.destroy(); resolve({ ok: false, err: 'timeout' }); });
  req.end();
});

(async () => {
  console.log('安装目标 = ' + TARGET);
  try {
    console.log('');
    console.log('=== 1. 静默安装 ===');
    const t0 = Date.now();
    const inst = run(SETUP, ['/S', '/D=' + TARGET], { timeout: 300000 });
    console.log('  exit=' + inst.code + '  耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒');
    for (const l of inst.out.split(/\r?\n/).filter(Boolean)) console.log('    ' + l);
    if (inst.err) inst.err.split(/\r?\n/).filter(Boolean).forEach((l) => console.log('    [err] ' + l));

    console.log('');
    console.log('=== 2. 安装结果核查 ===');
    const checks = [
      ['AgentSoul.exe', TARGET + '/AgentSoul.exe'],
      ['uninstall.exe', TARGET + '/uninstall.exe'],
      ['config.json', TARGET + '/config.json'],
      ['app/current.txt', TARGET + '/app/current.txt'],
      ['runtime/node.exe', TARGET + '/runtime/node.exe'],
      ['src/db/echo-vector-cache.mjs', TARGET + '/app/' + VER + '/src/db/echo-vector-cache.mjs'],
      ['src/db/echo-vector-snapshot.mjs', TARGET + '/app/' + VER + '/src/db/echo-vector-snapshot.mjs'],
      ['workspace/README.txt', TARGET + '/workspace/README.txt'],
      ['WebView2 三件套', TARGET + '/WebView2Loader.dll'],
      // ★ 2026-11-21：DPI 那一半必须是 exe 的邻居。缺它 = 150% 缩放下界面糊/错位。
      ['AgentSoul.exe.config', TARGET + '/AgentSoul.exe.config'],
    ];
    let allOk = true;
    for (const c of checks) {
      const ok = fs.existsSync(c[1]);
      if (!ok) allOk = false;
      console.log('  ' + (ok ? '✓' : '✗') + ' ' + c[0]);
    }
    if (fs.existsSync(TARGET + '/app/current.txt')) console.log('    current.txt = ' + fs.readFileSync(TARGET + '/app/current.txt', 'utf8').trim());

    console.log('');
    console.log('=== 3. 注册表卸载项 ===');
    const reg = run('reg', ['query', UNINSTALL_KEY]);
    console.log('  ' + (reg.code === 0 ? '✓ 存在' : '✗ 不存在'));
    for (const l of reg.out.split(/\r?\n/).filter((x) => /DisplayName|DisplayVersion|InstallLocation|UninstallString/i.test(x))) console.log('    ' + l.trim());

    console.log('');
    console.log('=== 4. 快捷方式 ===');
    const sm = START_MENU_LINK;
    const dt = DESKTOP_LINK;
    console.log('  开始菜单: ' + fs.existsSync(sm));
    console.log('  桌面    : ' + fs.existsSync(dt));

    console.log('');
    console.log('=== 5. 启动已安装的程序 ===');
    const cfg = JSON.parse(fs.readFileSync(TARGET + '/config.json', 'utf8'));
    const port = cfg.port || 7310;
    child = spawn(TARGET + '/AgentSoul.exe', [], { cwd: TARGET, stdio: 'ignore', windowsHide: true });
    let childExit = null;
    child.once('exit', (code, signal) => { childExit = { code, signal }; });
    let got = null;
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 1500));
      got = await probe(port);
      if (got.ok) break;
      if (childExit) break;
      process.stdout.write('.');
    }
    console.log('');
    if (!got?.ok && child && child.exitCode === null) {
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
      await new Promise((r) => setTimeout(r, 1000));
    }
    console.log('  ' + (got && got.ok ? '✓ HTTP ' + got.code + '  ' + got.len + ' 字节' : '✗ 没起来 ' + JSON.stringify(got)));

    console.log('');
    console.log('=== 6. 卸载 ===');
    if (child && child.pid && child.exitCode === null) {
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { }
    }
    await new Promise((r) => setTimeout(r, 1500));
    const un = run(TARGET + '/uninstall.exe', ['/uninstall'], { timeout: 120000 });
    console.log('  exit=' + un.code);
    for (const l of un.out.split(/\r?\n/).filter(Boolean)) console.log('    ' + l);

    console.log('');
    console.log('=== 7. 卸载后核查 ===');
    console.log('  安装目录还在: ' + fs.existsSync(TARGET));
    const reg2 = run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AgentSoul']);
    console.log('  注册表项还在: ' + (reg2.code === 0));
    console.log('  桌面快捷方式还在: ' + fs.existsSync(dt));
    console.log('  开始菜单还在: ' + fs.existsSync(path.dirname(sm)));

    console.log('');
    console.log('=== 判定 ===');
    // ★ 判据不能是「安装目录必须消失」：卸载**故意**保留用户的 config.json 与 data。
    //   第一版这么判过，于是把一个正确行为判成了 FAIL（实测撞到）。
    //   正确判据分三层：
    //     ① 程序文件必须删干净（AgentSoul.exe / uninstall.exe / app / runtime 都不在）
    //     ② 用户数据必须**还在**（config.json 与 data 留着）
    //     ③ 注册表项与两个快捷方式必须清掉
    const dirGone = !fs.existsSync(TARGET);
    const progGone = !fs.existsSync(TARGET + '/AgentSoul.exe')
      && !fs.existsSync(TARGET + '/uninstall.exe')
      && !fs.existsSync(TARGET + '/app')
      && !fs.existsSync(TARGET + '/runtime')
      && !fs.existsSync(TARGET + '/WebView2Loader.dll');
    const userKept = fs.existsSync(TARGET + '/config.json') || fs.existsSync(TARGET + '/data');
    console.log('  程序文件已清干净: ' + progGone + (dirGone ? '（目录也整个没了）' : ''));
    console.log('  用户数据留在原位: ' + userKept + (userKept ? '  ← 这是**有意**的，卸载不该删人的 key 和会话' : ''));
    console.log('  注册表项已清: ' + (reg2.code !== 0));
    console.log('  快捷方式已清: ' + (!fs.existsSync(dt) && !fs.existsSync(path.dirname(sm))));
    const pass = allOk && (got && got.ok) && progGone && userKept && reg2.code !== 0 && !fs.existsSync(dt) && !fs.existsSync(path.dirname(sm));
    console.log('');
    console.log('  ' + (pass ? 'PASS 安装 → 运行 → 卸载 全链路可用' : 'FAIL 见上面各项'));
  } finally {
    if (child && child.pid && child.exitCode === null) {
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { }
      await new Promise((r) => setTimeout(r, 1000));
    }
    try { fs.rmSync(TARGET, { recursive: true, force: true }); } catch { }
  }
})();
