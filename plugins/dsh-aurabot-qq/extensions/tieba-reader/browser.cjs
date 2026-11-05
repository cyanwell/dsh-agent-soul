// Dedicated browser session: only the login window accepts user interaction.
const { app, BrowserWindow, session } = require('electron');
const { validUrl, allowNavigation, configureCookies, clearSession } = require('./session.cjs');
const { createConnection } = require('node:net');
const { waitForLogin } = require('./login.cjs');
const fs = require('node:fs');
const { join } = require('node:path');
const profile = process.env.AURABOT_TIEBA_PROFILE;
if (!profile) process.exit(1);
app.setPath('userData', profile);
let win;
let closing = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function execute(req, progress) {
  const kind = req.kind;
  if (!['read', 'browse', 'home', 'search', 'account', 'login', 'logout'].includes(kind)) throw new Error('不支持的浏览器操作。');
  const url = validUrl(req.url, kind);
  const ses = session.fromPartition('persist:tieba-reader');
  const resetFile = join(profile, 'logout-requested');
  if (fs.existsSync(resetFile)) { await clearSession(ses, profile); fs.unlinkSync(resetFile); }
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (proxy) await ses.setProxy({ proxyRules: proxy, proxyBypassRules: '<local>' });
  if (kind === 'logout') {
    await clearSession(ses, profile);
    return { loggedIn: false, message: '扩展浏览器登录会话已清除。' };
  }
  await configureCookies(ses, req.cookie, profile);
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', event => event.preventDefault());
  win = new BrowserWindow({ show: kind === 'login', width: 1100, height: 800, title: '贴吧扩展：确认登录后自动关闭',
    webPreferences: { partition: 'persist:tieba-reader', nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const navigation = (event, dest) => {
    if (!allowNavigation(dest, kind)) event.preventDefault();
  };
  win.webContents.on('will-navigate', navigation);
  win.webContents.on('will-redirect', navigation);
  if (kind === 'login') {
    // Bind before load: closing a window while loading must also complete the job.
    const closed = new Promise(resolve => win.once('closed', resolve));
    const show = () => {
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show(); win.moveTop(); win.focus();
      app.focus({ steal: true });
    };
    show();
    win.once('ready-to-show', show);
    progress('login-opened');
    win.loadURL(url).catch(() => {});
    return waitForLogin({
      closed,
      save: () => ses.cookies.flushStore(),
      close: () => { if (win && !win.isDestroyed()) win.close(); },
      probe: async () => {
        if (!win || win.isDestroyed() || win.webContents.isLoadingMainFrame()) return null;
        if (new URL(win.webContents.getURL()).origin !== 'https://tieba.baidu.com') return null;
        return win.webContents.executeJavaScript(`(async () => {
          if (/安全验证|访问验证|验证码/.test(document.title) || document.querySelector('#captcha,#vcode,#wappassverify')) return { loggedIn: null };
          try {
            const response = await fetch('/f/user/json_userinfo', { credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(5000) });
            if (!response.ok) return { loggedIn: null };
            const j = await response.json(); const user = j?.data?.user || j?.data || j?.user || j;
            const name = user?.user_name || user?.name_show || user?.user_name_show;
            return name ? { loggedIn: true, name: String(name).slice(0,100) } : { loggedIn: false };
          } catch { return { loggedIn: null }; }
        })()`);
      },
    });
  }
  await win.loadURL(url);
  if (kind === 'account') {
    return win.webContents.executeJavaScript(`(async () => {
      try {
        const response = await fetch('/f/user/json_userinfo', { credentials: 'include' });
        if (!response.ok) return { ok: false, loggedIn: null, message: '登录检查被拦截，请打开扩展登录窗口完成验证。' };
        const j = await response.json(); const user = j?.data?.user || j?.data || j?.user || j;
        const name = user?.user_name || user?.name_show || user?.user_name_show;
        return name ? { ok: true, loggedIn: true, name: String(name).slice(0,100), message: '已登录：' + String(name).slice(0,100) }
          : { ok: true, loggedIn: false, message: '未确认登录，请打开扩展登录窗口。' };
      } catch { return { ok: false, loggedIn: null, message: '未能检查登录，请打开扩展登录窗口完成验证。' }; }
    })()`);
  }
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const status = await win.webContents.executeJavaScript(`(() => ({
      blocked: /安全验证|访问验证|验证码/.test(document.title),
      ready: Boolean(document.querySelector(${JSON.stringify(kind === 'read' ? '.pb-content-wrap,.d_post_content,.pb-content-item' : kind === 'search' ? '.s_post' : kind === 'home' ? 'a[href*="/p/"]' : '.thread-card,.j_thread_list,.threadlist_li')}))
    }))()`);
    if (status.blocked) throw new Error('贴吧要求安全验证，请打开扩展登录窗口完成验证。');
    if (status.ready) break;
    await delay(500);
  }
  const data = await win.webContents.executeJavaScript(`({html:document.documentElement.outerHTML,url:location.href})`);
  if (Buffer.byteLength(data.html, 'utf8') > 2500000) throw new Error('贴吧页面过大，已停止读取。');
  return data;
}
function shutdown() {
  if (closing) return;
  closing = true;
  if (win && !win.isDestroyed()) win.destroy();
  app.quit();
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, shutdown);
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const socket = createConnection({ host: '127.0.0.1', port: Number(process.env.AURABOT_TIEBA_PORT) });
  const token = process.env.AURABOT_TIEBA_TOKEN;
  delete process.env.AURABOT_TIEBA_TOKEN;
  delete process.env.AURABOT_TIEBA_PORT;
  socket.setEncoding('utf8');
  socket.on('error', shutdown);
  socket.on('close', shutdown);
  const req = await new Promise(resolve => {
    let buffer = '';
    socket.once('connect', () => socket.write(token + '\n'));
    socket.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 65536) { resolve(null); return; }
      const end = buffer.indexOf('\n');
      if (end !== -1) { try { resolve(JSON.parse(buffer.slice(0, end))); } catch { resolve(null); } }
    });
    socket.once('close', () => resolve(null));
  });
  if (!req) return shutdown();
  let result;
  try {
    result = { ok: true, data: await execute(req, event => socket.write('AURABOT_TIEBA:' + JSON.stringify({ event }) + '\n')) };
    await session.fromPartition('persist:tieba-reader').cookies.flushStore();
  }
  catch (error) { result = { ok: false, message: String(error.message || error).slice(0, 300) }; }
  socket.end('AURABOT_TIEBA:' + JSON.stringify(result) + '\n', shutdown);
});
