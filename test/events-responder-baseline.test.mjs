import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createResponder } from '../src/events/respond.mjs';
import { createWakeDeliverer } from '../src/events/deliver.mjs';

test('watch registers only after a proven completed-turn baseline', async () => {
  let scheduled = 0;
  const responder = createResponder({
    replyReader: { lastReply: async () => ({ ok: true, turn: 12, text: 'existing reply' }) },
    outbox: { send: async () => ({ ok: true }) },
    setTimer: () => { scheduled += 1; return { unref() {} } },
    clearTimer() {},
  });
  const result = await responder.watch('session-1', 'group:1');
  assert.equal(result.ok, true);
  assert.equal(result.turnBefore, 12);
  assert.equal(responder.view().watching, 1);
  assert.equal(scheduled, 1);
  responder.stop();
});

test('watch rejects an incomplete/truncated baseline without registering a watcher', async () => {
  let scheduled = 0;
  const responder = createResponder({
    replyReader: { lastReply: async () => ({ ok: false, code: 'REPLY_BRIDGE_TRUNCATED', error: 'tail truncated' }) },
    outbox: { send: async () => ({ ok: true }) },
    setTimer: () => { scheduled += 1; return { unref() {} } },
    clearTimer() {},
  });
  const result = await responder.watch('session-2', 'group:1');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'RESPOND_BASELINE_UNAVAILABLE');
  assert.equal(responder.view().watching, 0);
  assert.equal(scheduled, 0);
});

test('watch allows turn zero only for a proven fully-read empty session', async () => {
  let scheduled = 0;
  const responder = createResponder({
    replyReader: { lastReply: async () => ({ ok: false, code: 'REPLY_NO_TURN_END', baselineEmpty: true, sessionFrames: 3, tailFrames: 8000 }) },
    outbox: { send: async () => ({ ok: true }) },
    setTimer: () => { scheduled += 1; return { unref() {} } },
    clearTimer() {},
  });
  const result = await responder.watch('new-session', 'group:1');
  assert.equal(result.ok, true);
  assert.equal(result.turnBefore, 0);
  assert.equal(responder.view().watching, 1);
  assert.equal(scheduled, 1);
  responder.stop();
});

test('watch rejects no-turn baseline when tail does not prove complete history', async () => {
  let scheduled = 0;
  const responder = createResponder({
    replyReader: { lastReply: async () => ({ ok: false, code: 'REPLY_NO_TURN_END', baselineEmpty: false, sessionFrames: 8000, tailFrames: 8000 }) },
    outbox: { send: async () => ({ ok: true }) },
    setTimer: () => { scheduled += 1; return { unref() {} } },
    clearTimer() {},
  });
  const result = await responder.watch('old-session', 'group:1');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'RESPOND_BASELINE_UNAVAILABLE');
  assert.equal(responder.view().watching, 0);
  assert.equal(scheduled, 0);
});

test('deliver captures baseline before followup so an immediate completion is not swallowed', async () => {
  let currentTurn = 1;
  let sentSegments = null;
  const timers = [];
  const responder = createResponder({
    replyReader: { lastReply: async () => ({ ok: true, turn: currentTurn, text: currentTurn === 1 ? 'old reply' : 'immediate reply' }) },
    outbox: { send: async (_chatId, segments) => { sentSegments = segments; return { ok: true, messageId: 42 }; } },
    setTimer: (fn) => { timers.push(fn); return { unref() {} }; },
    clearTimer() {},
    pollMs: 1,
    timeoutMs: 100,
  });
  const deliverer = createWakeDeliverer({
    dispatch: {
      resolve: async () => ({ ok: true, sessionId: 'session-fast' }),
      followup: async () => { currentTurn = 2; return { ok: true, delivered: true, sessionId: 'session-fast' }; },
    },
    responder,
    enabled: true,
  });
  const result = await deliverer.deliver([{ chatId: 'group:123', text: 'trigger', eventId: 'event-fast' }]);
  assert.equal(result.delivered, 1, JSON.stringify({ result, delivery: deliverer.view(), responder: responder.view() }));
  assert.equal(timers.length, 1, JSON.stringify({ result, delivery: deliverer.view(), responder: responder.view() }));
  await timers.shift()();
  for (let i = 0; i < 8 && sentSegments === null; i += 1) await Promise.resolve();
  assert.equal(sentSegments && sentSegments[0]?.data?.text, 'immediate reply');
  responder.stop();
});
