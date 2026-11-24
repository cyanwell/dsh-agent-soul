import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const quietLog = () => new Proxy({}, { get: () => () => {} });

test('resetSessions retains disk and live mappings when saveMap temp write fails', async () => {
  const previousDataDir = process.env.AURABOT_DATA_DIR;
  const dataDir = mkdtempSync(join(tmpdir(), 'aurabot-reset-save-failure-'));
  process.env.AURABOT_DATA_DIR = dataDir;
  let hub;

  try {
    const { createHub } = await import('../src/aurabot/src/chat/hub.js');
    const workspaceDir = join(dataDir, 'workspace');
    const chatId = 'private:10001';
    const sessionId = 'session-reset-save-failure';
    const sessionsFile = join(dataDir, 'sessions.json');
    const originalMap = { chats: { [chatId]: { sessionId, preset: 'fake-private', level: 'full' } } };
    writeFileSync(sessionsFile, JSON.stringify(originalMap), 'utf8');

    const tmpPath = `${sessionsFile}.tmp-${process.pid}`;
    mkdirSync(tmpPath);

    const agent = {
      session: { id: sessionId, append() {} },
      ctx: {
        tools: { register: () => () => {}, restrict: () => () => {} },
        systemPrompt: { context: () => () => {} },
      },
      followup: async () => {},
      steer: async () => {},
    };
    let archivedFresh = false;
    const archiveCalls = [];
    const registry = {
      archivedSessionIds: [],
      get archivedFresh() { return archivedFresh; },
      async refreshArchived() { archivedFresh = true; },
      async list() { return [{ id: 'fake-workspace', path: workspaceDir, sessionIds: [sessionId] }]; },
      async archiveSession(id) { archiveCalls.push(id); },
    };
    const controller = { resolveAgent: async () => ({ agent }) };
    const config = {
      ownerQQ: '10001',
      ownerLevel: 'full',
      presets: { private: 'fake-private', social: 'fake-social' },
      model: {},
      workspaceDir,
      merge: { enabled: false },
      voice: { enabled: false, asr: false },
      stickers: { enabled: false },
      group: {},
      allow: { groups: [], private: [] },
    };
    const dsh = {
      agents: { get: (id) => id === sessionId || id === `session-${sessionId}` ? agent : null },
      workspaceRegistry: registry,
      get: (name) => name === 'workspaceRegistry' ? registry : name === 'sessionController' ? controller : null,
    };
    hub = createHub({
      dsh,
      getConfig: () => config,
      log: quietLog(),
      onebot: { call: async () => ({}) },
      stickers: { match: () => null, segmentFor: () => null, pickForReply: () => null, markUsed() {}, collect: async () => ({ ok: false }) },
      tts: { speak: async () => '' },
      buildTools: () => [],
    });

    await hub.pushToSession({ chatId, kind: 'private', userId: '10001' }, [{ type: 'text', text: 'seed mapping' }], '10001');
    await assert.rejects(hub.resetSessions());

    assert.deepEqual(archiveCalls, [sessionId]);
    assert.deepEqual(JSON.parse(readFileSync(sessionsFile, 'utf8')), originalMap);

    rmSync(sessionsFile);
    assert.equal(hub.chatOfSession(sessionId), chatId);
  } finally {
    try { hub?.disposeRecentMedia(); } finally {
      if (previousDataDir === undefined) delete process.env.AURABOT_DATA_DIR;
      else process.env.AURABOT_DATA_DIR = previousDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  }
});
