import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';

// Windows GUI Electron does not reliably expose stdin. Use a one-job authenticated
// loopback channel instead. Neither cookies nor page data are written to disk.
export function runBrowserJob({ exe, script, env, request, timeoutMs, spawnImpl, active, onProgress }) {
  return new Promise((resolve, reject) => {
    const token = randomBytes(32).toString('hex');
    let child;
    let authenticated = null;
    let settled = false;
    let exitTimer;
    const sockets = new Set();
    const finish = (error, data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(exitTimer);
      active.delete(cancel);
      for (const socket of sockets) socket.destroy();
      try { server.close(); child?.kill(); } catch {}
      if (error) reject(error); else resolve(data);
    };
    const cancel = () => finish(new Error('贴吧模块已停用，任务已取消。'));
    active.add(cancel);
    const server = createServer(socket => {
      sockets.add(socket);
      socket.setEncoding('utf8');
      let buffer = '';
      let verified = false;
      socket.on('error', () => { if (verified) finish(new Error('浏览器通信中断。')); });
      socket.on('close', () => sockets.delete(socket));
      socket.on('data', chunk => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > (verified ? 12 * 1024 * 1024 : 1024)) {
          if (verified) finish(new Error('浏览器返回内容过大。')); else socket.destroy();
          return;
        }
        let end;
        while ((end = buffer.indexOf('\n')) !== -1 && !settled) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (!verified) {
            if (line !== token || authenticated) { socket.destroy(); return; }
            verified = true; authenticated = socket;
            socket.write(JSON.stringify(request) + '\n');
          } else {
            if (!line.startsWith('AURABOT_TIEBA:')) return finish(new Error('浏览器返回了无效数据。'));
            try {
              const result = JSON.parse(line.slice('AURABOT_TIEBA:'.length));
              if (result.event === 'login-opened') { onProgress?.(result.event); continue; }
              finish(result.ok ? null : new Error(result.message || '浏览器读取失败。'), result.data);
            } catch { finish(new Error('浏览器返回了无效数据。')); }
          }
        }
      });
    });
    const timer = setTimeout(() => finish(new Error(request.kind === 'login' ? '登录窗口已超时关闭，请重新打开。' : '浏览器读取超时，请检查网络或登录验证。')), timeoutMs);
    server.on('error', () => finish(new Error('无法建立本机浏览器通信通道。')));
    server.listen(0, '127.0.0.1', () => {
      if (settled) return;
      try {
        child = spawnImpl(exe, [script], { env: { ...env, AURABOT_TIEBA_PORT: String(server.address().port), AURABOT_TIEBA_TOKEN: token }, windowsHide: request.kind !== 'login', stdio: 'ignore' });
        child.on('error', () => finish(new Error('浏览器组件启动失败，请检查路径和运行权限。')));
        child.on('exit', () => { exitTimer = setTimeout(() => finish(new Error('浏览器进程提前退出。')), 100); });
      } catch { finish(new Error('无法启动浏览器组件。')); }
    });
  });
}
