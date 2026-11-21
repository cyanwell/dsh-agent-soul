// 验证 portable.zip：解压到临时目录 → 启动壳 → 等端口 → 打 HTTP → 清理
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const ZIP = 'D:/AI/agent-soul/dist/AgentSoul-1.0.65-portable.zip';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'as-portable-verify-'));

function unzip(zipPath, dest) {
  // 用 PowerShell 的 Expand-Archive（系统自带，能正确解 UTF-8 名）
  execFileSync('powershell', ['-NoProfile', '-Command',
    "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath '" + zipPath.replace(/'/g, "''") + "' -DestinationPath '" + dest.replace(/'/g, "''") + "' -Force"], { stdio: 'inherit' });
}

(async () => {
  console.log('临时目录 = ' + TMP);
  try {
    console.log('=== 解压 ===');
    const t0 = Date.now();
    unzip(ZIP, TMP);
    console.log('  解压耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒');

    const exe = path.join(TMP, 'AgentSoul.exe');
    const cur = fs.readFileSync(path.join(TMP, 'app/current.txt'), 'utf8').trim();
    console.log('  AgentSoul.exe 存在 = ' + fs.existsSync(exe) + '  (' + (fs.statSync(exe).size / 1024).toFixed(0) + ' KB)');
    console.log('  app/current.txt = ' + cur + '  （应为 1.0.65）');
    const loader = path.join(TMP, 'app', cur, 'src', 'db', 'echo-vector-cache.mjs');
    console.log('  新模块在载荷里 = ' + fs.existsSync(loader) + '  (' + (fs.existsSync(loader) ? fs.statSync(loader).size : 0) + ' B)');
    console.log('  runtime/node.exe = ' + fs.existsSync(path.join(TMP, 'runtime/node.exe')));

    console.log('');
    console.log('=== 启动壳（会起 node 进程跑 src/index.mjs）===');
    const cfg = JSON.parse(fs.readFileSync(path.join(TMP, 'config.json'), 'utf8'));
    const port = cfg.port || 7310;
    console.log('  期望端口 = ' + port);
    const child = spawn(exe, [], { cwd: TMP, detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    console.log('  已拉起 pid=' + child.pid);

    // 等端口
    const http = await import('node:http');
    const probe = () => new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/status', timeout: 3000 }, (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => resolve({ ok: true, code: res.statusCode, len: body.length, head: body.slice(0, 120) }));
      });
      req.on('error', (e) => resolve({ ok: false, err: e.code || e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, err: 'timeout' }); });
      req.end();
    });

    let got = null;
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 1500));
      got = await probe();
      if (got.ok) break;
      process.stdout.write('.');
    }
    console.log('');
    if (got && got.ok) {
      console.log('  ✓ HTTP ' + got.code + '  /api/status  ' + got.len + ' 字节');
      console.log('    ' + got.head.replace(/\s+/g, ' '));
    } else {
      console.log('  ✗ 没起来：' + JSON.stringify(got));
    }
  } finally {
    console.log('');
    console.log('=== 清理 ===');
    try { execFileSync('taskkill', ['/IM', 'AgentSoul.exe', '/F'], { stdio: 'ignore' }); } catch { /* 可能没在跑 */ }
    try { execFileSync('taskkill', ['/IM', 'node.exe', '/F', '/FI', 'WINDOWTITLE eq agent-soul*'], { stdio: 'ignore' }); } catch { /* 忽略 */ }
    await new Promise((r) => setTimeout(r, 1500));
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log('  临时目录已删 = ' + !fs.existsSync(TMP));
  }
})();
