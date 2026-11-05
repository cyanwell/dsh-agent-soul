import { runBrowserJob } from './transport.mjs';
import { openDefaultBrowser } from './external-browser.mjs';
import { cookieGuide } from './cookie-guide.mjs';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function resolveBrowser(api, platform = process.platform, existsImpl = existsSync) {
  const executable = platform === 'win32' ? 'electron.exe' : platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron';
  const candidates = [
    join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'electron', executable),
    join(api.dir, '.runtime', 'node_modules', 'electron', 'dist', executable),
    join(api.dir, 'node_modules', 'electron', 'dist', executable),
  ];
  const found = candidates.find(existsImpl);
  if (!found) throw new Error('未检测到可用的内置浏览器组件。');
  return found;
}

export function createBrowserReader(api, getCookie, { spawnImpl = spawn, resolveImpl = resolveBrowser, openExternalImpl = openDefaultBrowser, timeoutMs } = {}) {
  let queue = Promise.resolve();
  let disposed = false;
  let pending = 0;
  let loginPending = false;
  let lastLogin = '';
  let loginResult = null;
  let account = { loggedIn: null, message: '尚未检查登录', checkedAt: 0 };
  const active = new Set();
  const available = () => { try { return Boolean(resolveImpl(api)); } catch { return false; } };
  api.onDispose(() => {
    disposed = true;
    for (const cancel of active) cancel();
  });
  function run(url, kind) {
    if (disposed) return Promise.reject(new Error('贴吧模块已停用。'));
    const exe = resolveImpl(api);
    const env = { ...process.env, AURABOT_TIEBA_PROFILE: api.dataDir('browser-profile') };
    delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
    return runBrowserJob({ exe, script: join(api.dir, 'browser.cjs'), env,
      request: { url, kind, cookie: getCookie() }, timeoutMs: timeoutMs ?? (kind === 'login' ? 600000 : 48000), spawnImpl, active,
      onProgress: event => { if (event === 'login-opened') lastLogin = '登录窗口已打开；确认登录成功后会自动保存并关闭。'; } });
  }
  const reader = (url, kind) => {
    if (disposed) return Promise.reject(new Error('贴吧模块已停用。'));
    if (loginPending && kind !== 'login') return Promise.reject(new Error('登录窗口仍然打开，确认登录后会自动关闭；也可先用右上角 × 手动关闭，再检查登录或读帖。'));
    if (kind === 'logout' && !available()) {
      const profile = api.dataDir('browser-profile');
      mkdirSync(profile, { recursive: true });
      writeFileSync(join(profile, 'logout-requested'), '', { mode: 0o600 });
      account = { loggedIn: false, checkedAt: Date.now(), message: '扩展登录已清除；历史内置浏览器会话将在组件恢复时清理。系统浏览器账号需要自行退出。' };
      return Promise.resolve(account);
    }
    if (pending >= 8) return Promise.reject(new Error('贴吧读取任务较多，请稍后再试。'));
    pending++;
    const task = queue.then(() => run(url, kind)).then(data => {
      if (kind === 'account' || kind === 'logout') account = { ...data, checkedAt: Date.now() };
      return data;
    }).finally(() => { pending--; });
    queue = task.catch(() => {});
    return task;
  };
  reader.available = available;
  reader.recordAccount = result => { account = { ...result, checkedAt: Date.now() }; };
  reader.status = () => { const internal = available(); return { loginPending, lastLogin, pending, loginResult, account, available: internal, cookieGuide: internal ? null : cookieGuide }; };
  reader.openLogin = () => {
    if (disposed) return { ok: false, message: '贴吧模块已停用。' };
    if (loginPending) return { ok: true, message: '登录窗口正在打开或已打开；确认登录成功后会自动保存并关闭。' };
    if (!available()) {
      return Promise.resolve().then(() => openExternalImpl('https://tieba.baidu.com/')).then(() => {
        lastLogin = '已打开默认浏览器，请按面板中的 F12 指引复制 Cookie，填入后保存设置，再检查登录。扩展不会自动同步浏览器登录。';
        account = { loggedIn: null, checkedAt: 0, message: lastLogin };
        return { ok: true, mode: 'external', loggedIn: null, message: lastLogin, cookieGuide };
      });
    }
    loginPending = true;
    loginResult = null;
    lastLogin = '登录窗口准备中';
    reader('https://tieba.baidu.com/', 'login').then(result => {
      loginResult = result;
      account = { ...result, checkedAt: Date.now() };
      lastLogin = result?.loggedIn === true ? `已登录：${result.name}；窗口${result.autoClosed ? '已自动' : '已'}关闭，会话已保存。` : result?.message || '窗口已关闭，尚未确认登录。';
    }, error => { lastLogin = error.message; account = { loggedIn: null, message: error.message, checkedAt: Date.now() }; })
      .finally(() => { loginPending = false; });
    return { ok: true, message: '正在打开扩展专用浏览器；确认登录成功后会自动保存会话并关闭窗口。' };
  };
  return reader;
}
