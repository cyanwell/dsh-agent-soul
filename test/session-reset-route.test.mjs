import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerSessionResetRoute } from '../src/aurabot/src/session-reset-route.mjs';

test('registerSessionResetRoute registers exact path and returns success counts', async () => {
  const registrations = [];
  let calls = 0;
  registerSessionResetRoute((path, handler) => registrations.push({ path, handler }), {
    async resetSessions() { calls++; return 3; },
  });

  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].path, '/sessions/reset');
  assert.deepEqual(await registrations[0].handler(), {
    ok: true,
    archived: 3,
    failed: 0,
    message: '归档了 3 个会话，下一条消息起她会重新开始',
  });
  assert.equal(calls, 1);
});

test('registerSessionResetRoute sanitizes failure without exposing message or session IDs', async () => {
  const registrations = [];
  let calls = 0;
  registerSessionResetRoute((path, handler) => registrations.push({ path, handler }), {
    async resetSessions() {
      calls++;
      throw Object.assign(new Error('secret session id session-should-not-leak'), {
        code: 'archive-partial-failure',
        stage: 'archive',
        archived: 2,
        failed: 1,
      });
    },
  });

  const response = await registrations[0].handler();
  assert.deepEqual(response, {
    ok: false,
    archived: 2,
    failed: 1,
    code: 'archive-partial-failure',
    stage: 'archive',
    message: '会话重置未完成',
  });
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(response).includes('secret session id'), false);
  assert.equal(JSON.stringify(response).includes('session-should-not-leak'), false);
});
