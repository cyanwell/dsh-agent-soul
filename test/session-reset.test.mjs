import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listAfterFreshArchiveState, listUnarchivedWorkspaceSessions, resetWorkspaceSessions } from '../src/aurabot/src/chat/session-reset.mjs';
import { resetFailure, resetSuccess } from '../src/aurabot/src/reset-response.mjs';

test('listAfterFreshArchiveState reads freshness after refresh before listing', async () => {
  const order = [];
  let archiveFresh = false;
  const fresh = await listAfterFreshArchiveState({
    refreshArchived: async () => { await Promise.resolve(); order.push('refresh'); archiveFresh = true; },
    archivedFresh: () => archiveFresh,
    listWorkspaces: async () => { order.push('list'); return [{ path: 'C:/qq', sessionIds: ['loose'] }]; },
    workspacePath: 'C:/qq',
    archivedSessionIds: async () => [],
  });
  assert.deepEqual(order, ['refresh', 'list']);
  assert.deepEqual(fresh, ['loose']);

  let lists = 0;
  await assert.rejects(listAfterFreshArchiveState({
    refreshArchived: async () => { throw new Error('bridge down'); },
    archivedFresh: false,
    listWorkspaces: async () => { lists++; return []; },
    workspacePath: 'C:/qq',
    archivedSessionIds: async () => [],
  }), (error) => error.code === 'archived-state-unavailable' && error.stage === 'preflight');
  assert.equal(lists, 0);

  await assert.rejects(listAfterFreshArchiveState({
    refreshArchived: async () => { order.push('stale refresh'); },
    archivedFresh: false,
    listWorkspaces: async () => { lists++; return []; },
  }), (error) => error.code === 'archived-state-unavailable');
  assert.equal(lists, 0);
});

test('listUnarchivedWorkspaceSessions awaits bridge list and excludes mapped/already-archived IDs', async () => {
  let resolved = false;
  const ids = await listUnarchivedWorkspaceSessions({
    listWorkspaces: async () => {
      await Promise.resolve();
      resolved = true;
      return [
        { path: 'C:/elsewhere', sessionIds: ['wrong'] },
        { path: 'C:/aurabot/qq-chats/', sessionIds: ['chat-1', 'loose-1', 'archived-1'] },
      ];
    },
    workspacePath: 'c:/aurabot/qq-chats',
    archivedSessionIds: async () => ['archived-1'],
    excludeSessionIds: ['chat-1'],
  });
  assert.equal(resolved, true);
  assert.deepEqual(ids, ['loose-1']);
});

test('listUnarchivedWorkspaceSessions does not turn bridge list failure into empty success', async () => {
  await assert.rejects(listUnarchivedWorkspaceSessions({
    listWorkspaces: async () => { throw new Error('bridge unavailable'); },
    workspacePath: 'C:/aurabot/qq-chats',
    archivedSessionIds: async () => [],
  }), /bridge unavailable/);
});

test('listUnarchivedWorkspaceSessions returns empty only when target workspace is absent', async () => {
  const ids = await listUnarchivedWorkspaceSessions({
    listWorkspaces: async () => [{ path: 'C:/another', sessionIds: ['x'] }],
    workspacePath: 'C:/aurabot/qq-chats',
    archivedSessionIds: async () => [],
  });
  assert.deepEqual(ids, []);
});

test('resetWorkspaceSessions deduplicates mapped/loose IDs and only retains failed mappings', async () => {
  const chats = { c1: { sessionId: 's1' }, c1b: { sessionId: 's1' }, c2: { sessionId: 's2' } };
  const calls = [];
  const result = await resetWorkspaceSessions({
    chats,
    looseSessionIds: ['s1', 's3'],
    archiveSession: async (id) => {
      calls.push(id);
      if (id === 's2') throw new Error('archive unavailable');
    },
  });
  assert.deepEqual(calls, ['s1', 's2', 's3']);
  assert.deepEqual(result.archivedIds, ['s1', 's3']);
  assert.deepEqual(result.failedIds, ['s2']);
  assert.equal(result.archived, 2);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.chats, { c2: { sessionId: 's2' } });
  assert.deepEqual(chats, { c1: { sessionId: 's1' }, c1b: { sessionId: 's1' }, c2: { sessionId: 's2' } });
});

test('resetSuccess reports exact zero and positive archive counts', () => {
  assert.deepEqual(resetSuccess(0), { ok: true, archived: 0, failed: 0, message: '本来就没有会话' });
  assert.deepEqual(resetSuccess(3), { ok: true, archived: 3, failed: 0, message: '归档了 3 个会话，下一条消息起她会重新开始' });
});

test('resetFailure preserves zero counts and separates unknown preflight counts', () => {
  assert.deepEqual(resetFailure(Object.assign(new Error('private sid detail'), { code: 'archive-partial-failure', stage: 'archive', archived: 2, failed: 0 })), { ok: false, archived: 2, failed: 0, code: 'archive-partial-failure', stage: 'archive', message: '会话重置未完成' });
  assert.deepEqual(resetFailure(Object.assign(new Error('private sid detail'), { code: 'workspace-list-failed', stage: 'list' })), { ok: false, archived: null, failed: null, code: 'workspace-list-failed', stage: 'list', message: '会话重置未完成' });
});
