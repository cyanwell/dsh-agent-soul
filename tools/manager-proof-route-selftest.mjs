import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { handleManagerProofRequest } from '../src/web/manager-proof-route.mjs';

const temp = fs.realpathSync(os.tmpdir());
const root = fs.mkdtempSync(path.join(temp, 'manager-proof-route-'));
let passed = 0;
function call(req, { loopback = true } = {}) {
  const response = { status: null, headers: null, body: null, writeHead(code, headers) { this.status = code; this.headers = headers; }, end(body) { this.body = JSON.parse(String(body)); } };
  const handled = handleManagerProofRequest(req, response, {
    auth: { ok: (request) => request.headers?.['x-soul-token'] === 'test-token' },
    isLoopback: () => loopback,
    readLockRecord: () => JSON.parse(fs.readFileSync(path.join(root, 'core.lock'), 'utf8')),
  });
  return { handled, response };
}
const markerHash = 'a'.repeat(64);
const managed = { pid: 4202, parentPid: 4101, startedAt: '2026-11-19T00:00:00.000Z', manager: { corePid: 4202, shellPid: 4101, markerHash } };
try {
  fs.writeFileSync(path.join(root, 'core.lock'), JSON.stringify(managed), { flag: 'wx' });
  let result = call({ url: '/api/manager-proof', method: 'GET', headers: {} }); assert.equal(result.response.status, 401); passed++;
  result = call({ url: '/api/manager-proof?token=test-token', method: 'GET', headers: {} }); assert.equal(result.response.status, 401, 'query token alone is rejected'); passed++;
  result = call({ url: '/api/manager-proof', method: 'POST', headers: { 'x-soul-token': 'test-token' } }); assert.equal(result.response.status, 405); passed++;
  result = call({ url: '/api/manager-proof', method: 'GET', headers: { 'x-soul-token': 'test-token' } }, { loopback: false }); assert.equal(result.response.status, 403); passed++;
  result = call({ url: '/api/manager-proof', method: 'GET', headers: { 'x-soul-token': 'test-token' } });
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.response.body, { ok: true, identity: { corePid: 4202, shellPid: 4101, startedAt: managed.startedAt, markerHash } });
  assert.equal(JSON.stringify(result.response.body).includes('plaintext-marker'), false); passed++;
  fs.writeFileSync(path.join(root, 'core.lock'), JSON.stringify({ ...managed, parentPid: 4999 }), { flag: 'w' });
  result = call({ url: '/api/manager-proof', method: 'GET', headers: { 'x-soul-token': 'test-token' } }); assert.equal(result.response.status, 409); assert.equal(result.response.body.code, 'manager-lock-invalid'); passed++;
  fs.writeFileSync(path.join(root, 'core.lock'), JSON.stringify({ pid: 4202, startedAt: managed.startedAt }), { flag: 'w' });
  result = call({ url: '/api/manager-proof', method: 'GET', headers: { 'x-soul-token': 'test-token' } }); assert.equal(result.response.status, 409); assert.equal(result.response.body.code, 'manager-identity-unavailable'); passed++;
  const [serverText, coreText] = await Promise.all([readFile(new URL('../src/web/server.mjs', import.meta.url), 'utf8'), readFile(new URL('../src/core-entry.mjs', import.meta.url), 'utf8')]);
  const authAt = serverText.indexOf('if (needsAuth(p, req.method) && !auth.ok(req, url))');
  const readonlyAt = serverText.indexOf('if (readonlyEnabled()) {', authAt);
  const proofAt = serverText.indexOf("if (p === '/api/manager-proof' && managerProofHandler)", readonlyAt);
  assert(authAt >= 0 && readonlyAt > authAt && proofAt > readonlyAt, 'shared auth then readonly gate then proof route');
  assert(coreText.includes("if (p !== '/api/shutdown') return false;"), 'existing shutdown wrapper remains separate'); passed++;
  console.log('manager-proof-route-selftest: ' + passed + '/8 PASS (TEMP lock reader)');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
assert.equal(fs.existsSync(root), false, 'TEMP fixture removed');
