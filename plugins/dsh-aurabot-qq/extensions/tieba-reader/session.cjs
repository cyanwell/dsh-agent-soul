const { createHash } = require('node:crypto');
const fs = require('node:fs');
const { join } = require('node:path');
const cookieNames = new Set(['BDUSS', 'BDUSS_BFESS', 'STOKEN', 'BAIDUID', 'BAIDUID_BFESS', 'TIEBAUID', 'USER_JUMP', 'PSTM']);
function validUrl(raw, kind) {
  const u = new URL(raw);
  if (u.origin !== 'https://tieba.baidu.com' || u.username || u.password) throw new Error('只允许读取百度贴吧。');
  if (!(/^\/p\/\d+$/.test(u.pathname) || ['/f', '/', '/f/search/res'].includes(u.pathname))) throw new Error('不支持这个贴吧页面。');
  if (kind === 'login' && u.pathname !== '/') throw new Error('登录入口无效。');
  return u.href;
}
function allowNavigation(raw, kind) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port &&
      (u.hostname === 'tieba.baidu.com' || kind === 'login' && ['passport.baidu.com', 'wappass.baidu.com'].includes(u.hostname));
  } catch { return false; }
}
async function configureCookies(ses, raw, profile) {
  if (/[\r\n]/.test(String(raw || ''))) throw new Error('Cookie 不能含换行。');
  const cookie = String(raw || '').split(';').map(p => p.trim()).filter(p => cookieNames.has(p.split('=')[0])).sort().join('; ');
  const hash = createHash('sha256').update(cookie).digest('hex');
  const marker = join(profile, 'configured-cookie.sha256');
  let previous = '';
  try { previous = fs.readFileSync(marker, 'utf8'); } catch {}
  const unchanged = previous === hash;
  if (!unchanged && (previous || cookie)) await ses.clearStorageData({ storages: ['cookies', 'localstorage'] });
  // Imported session cookies can disappear when Chromium exits. Restore only missing values;
  // never overwrite refreshed browser credentials while the configured input is unchanged.
  const current = unchanged && cookie ? await ses.cookies.get({ url: 'https://tieba.baidu.com/' }) : [];
  for (const part of cookie.split('; ').filter(Boolean)) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    if (unchanged && current.some(c => c.name === part.slice(0, i))) continue;
    await ses.cookies.set({ url: 'https://tieba.baidu.com', domain: '.baidu.com', path: '/', name: part.slice(0, i), value: part.slice(i + 1), secure: true });
  }
  await ses.cookies.flushStore();
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(marker, hash, { mode: 0o600 });
}
async function clearSession(ses, profile) {
  await ses.clearStorageData();
  await ses.cookies.flushStore();
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(join(profile, 'configured-cookie.sha256'), createHash('sha256').update('').digest('hex'), { mode: 0o600 });
}
module.exports = { validUrl, allowNavigation, configureCookies, clearSession };
