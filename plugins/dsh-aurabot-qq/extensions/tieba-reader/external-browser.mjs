import { spawn } from 'node:child_process';

// Opening a login page does not grant access to the system browser's credentials.
export function openDefaultBrowser(url, { platform = process.platform, spawnImpl = spawn } = {}) {
  if (url !== 'https://tieba.baidu.com/') return Promise.reject(new Error('只允许打开贴吧登录首页。'));
  const command = platform === 'win32' ? 'explorer.exe' : platform === 'darwin' ? '/usr/bin/open' : 'xdg-open';
  return new Promise((resolve, reject) => {
    try {
      const child = spawnImpl(command, [url], { shell: false, windowsHide: false, stdio: 'ignore' });
      child.once('error', () => reject(new Error('无法打开系统默认浏览器，请手动访问 tieba.baidu.com 登录。')));
      child.once('spawn', () => { child.unref?.(); resolve(); });
    } catch { reject(new Error('无法打开系统默认浏览器，请手动访问 tieba.baidu.com 登录。')); }
  });
}
