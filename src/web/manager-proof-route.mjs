import { managerIdentityView } from '../util/core-identity.mjs';

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' });
  res.end(text);
}

export function handleManagerProofRequest(req, res, { auth, isLoopback, readLockRecord }) {
  let pathname;
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { return false; }
  if (pathname !== '/api/manager-proof') return false;
  if (req.method !== 'GET') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return true; }
  if (!req.headers || !req.headers['x-soul-token'] || !auth || !auth.ok(req, new URL(req.url, 'http://localhost'))) { json(res, 401, { ok: false, error: 'missing-or-bad-token-header' }); return true; }
  if (typeof isLoopback !== 'function' || !isLoopback(req)) { json(res, 403, { ok: false, error: 'loopback-required' }); return true; }
  const record = typeof readLockRecord === 'function' ? readLockRecord() : null;
  const view = managerIdentityView(record);
  if (!view.ok) { json(res, 409, { ok: false, code: view.code, status: 'unavailable' }); return true; }
  json(res, 200, { ok: true, identity: view.identity });
  return true;
}
