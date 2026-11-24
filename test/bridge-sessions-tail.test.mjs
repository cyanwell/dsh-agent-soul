import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readAllSessionViaBridge, readSessionViaBridge } from '../src/adapters/bridge-sessions.mjs';
import { createBridgeWorkspaceRegistry } from '../src/aurabot/adapter/bridge-workspaces.mjs';
import { createBridgeServices } from '../src/aurabot/adapter/bridge-services.mjs';

test('readSessionViaBridge preserves host tail completeness metadata', async () => {
  let received;
  const control = {
    whoHas: (cap) => [{ id: 'dsh-1', host: 'dsh', caps: { has: (name) => name === cap } }],
    exec: async (hostId, cap, action, args) => {
      received = { hostId, cap, action, args };
      return { ok: true, sessionId: args.sessionId, frames: [], count: 0, total: 9000, nextFromSeq: null, badLines: 0, truncated: true, tailBytesUsed: 4 * 1024 * 1024, tailFrames: 8000, fromEnd: true };
    },
  };
  const receipt = await readSessionViaBridge(control, 'session-9', { limit: 8000, tailFrames: 8000 });
  assert.deepEqual(received, { hostId: 'dsh-1', cap: 'sessions', action: 'read', args: { sessionId: 'session-9', limit: 8000, tailFrames: 8000 } });
  assert.equal(receipt.fromEnd, true);
  assert.equal(receipt.truncated, true);
  assert.equal(receipt.total, 9000);
  assert.equal(receipt.tailBytesUsed, 4 * 1024 * 1024);
});

test('readAllSessionViaBridge validates the complete host tail receipt before normalization', async () => {
  const valid = { ok: true, sessionId: 'session-9', frames: [{ seq: 1 }], count: 1, total: 1, nextFromSeq: null, badLines: 0, truncated: false, tailBytesUsed: 0, tailFrames: 8000, fromEnd: true };
  const makeControl = (data) => ({
    whoHas: (cap) => [{ id: 'dsh-1', host: 'dsh', caps: { has: (name) => name === cap } }],
    exec: async () => data,
  });
  const receipt = await readAllSessionViaBridge(makeControl(valid), 'session-9', { tailFrames: 8000 });
  assert.equal(receipt.count, receipt.frames.length);
  assert.equal(receipt.total, 1);
  assert.equal(receipt.truncated, false);
  for (const [name, patch] of [
    ['count/frame mismatch', { count: 2 }],
    ['total below count', { total: 0 }],
    ['requested tail mismatch', { tailFrames: 7999 }],
    ['missing fromEnd proof', { fromEnd: undefined }],
    ['missing truncated flag', { truncated: undefined }],
  ]) {
    await assert.rejects(readAllSessionViaBridge(makeControl({ ...valid, ...patch }), 'session-9', { tailFrames: 8000 }), /尾读回执字段不一致或缺失/, name);
  }
});

test('workspace bridge registry routes archiveSession through the host service allowlist', async () => {
  const calls = [];
  const control = {
    whoHas: (cap) => [{ id: cap + '-host', host: 'dsh' }],
    exec: async (...args) => {
      calls.push(args);
      const [, cap, action, payload] = args;
      if (cap === 'workspaces' && ['list', 'ensure', 'get'].includes(action)) return { action, items: [] };
      if (cap === 'service' && action === 'call' && payload?.name === 'workspaceRegistry' && payload?.method === 'archiveSession' && payload?.args?.length === 1) {
        return payload.args[0] === 'failed-session' ? { ok: false, code: 'archive-failed' } : null;
      }
      throw Object.assign(new Error('bridge bad-request: operation not allowlisted'), { code: 'bad-request' });
    },
  };
  const registry = createBridgeWorkspaceRegistry(control);
  const receipt = await registry.archiveSession(' session-1 ');
  assert.equal(receipt, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'service-host');
  assert.equal(calls[0][1], 'service');
  assert.equal(calls[0][2], 'call');
  assert.deepEqual(calls[0][3], { name: 'workspaceRegistry', method: 'archiveSession', args: ['session-1'] });
  await assert.rejects(registry.archiveSession('failed-session'), /archive-failed/);
  await assert.rejects(registry.archiveSession('  '), /需要 sessionId/);
});

test('workspaceRegistry service bridge exposes the same allowlisted archive action', async () => {
  const calls = [];
  const control = {
    whoHas: () => [{ id: 'host-1', host: 'dsh' }],
    exec: async (...args) => { calls.push(args); return { archived: true }; },
  };
  const services = createBridgeServices(control);
  const receipt = await services.workspaceRegistry.archiveSession('session-2');
  assert.deepEqual(receipt, { archived: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], 'service');
  assert.equal(calls[0][2], 'call');
  assert.deepEqual(calls[0][3], { name: 'workspaceRegistry', method: 'archiveSession', args: ['session-2'] });
  await assert.rejects(services.workspaceRegistry.archiveSession(''), /需要 sessionId/);
});
