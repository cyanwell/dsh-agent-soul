// 单个聊天「重新开始」的顺序约束（离线：临时 AURABOT_DATA_DIR + 假 registry/agent，绝不碰真网关）。
// 要证的四件事：
//   1. 归档没回来之前，命令不返回、映射一个都不动；归档成功后才敢说「重新开始」。
//   2. 归档拒绝时，磁盘映射和内存实时映射都还在，命令不说成功、也不漏会话 id / 报错原文。
//   3. 归档成功 + 写盘成功，才清掉 chats 映射与 sessionToChat / turnState。
//   4. 写盘失败时抛错、映射保留（归档可能已经成功，但不许假装这个聊天已经重开）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const quietLog = () => new Proxy({}, { get: () => () => {} });
const SUCCESS_TEXT = '好，我们重新开始';

function fakeAgent(sessionId) {
  return {
    session: { id: sessionId, append() {} },
    ctx: {
      tools: { register: () => () => {}, restrict: () => () => {} },
      systemPrompt: { context: () => () => {} },
    },
    followup: async () => {},
    steer: async () => {},
  };
}

/**
 * 建一个隔离的世界：临时数据目录 + 假 registry/agent + 已经在册的一个私聊映射。
 * archiveSession 由调用方给（可以是挂起的 Promise、可以是会拒绝的函数、也可以传 null 表示「registry 没这个方法」）。
 */
async function makeWorld({ prefix, archiveSession }) {
  const previousDataDir = process.env.AURABOT_DATA_DIR;
  const dataDir = mkdtempSync(join(tmpdir(), prefix));
  process.env.AURABOT_DATA_DIR = dataDir;
  const workspaceDir = join(dataDir, 'workspace');
  const chatId = 'private:10001';
  const sessionId = 'session-' + prefix.replace(/[^a-z0-9]/gi, '').slice(0, 32);
  const sessionsFile = join(dataDir, 'sessions.json');
  const originalMap = { chats: { [chatId]: { sessionId, preset: 'fake-private', level: 'full' } } };
  writeFileSync(sessionsFile, JSON.stringify(originalMap), 'utf8');

  const agent = fakeAgent(sessionId);
  const archiveCalls = [];
  const registry = {
    archivedSessionIds: [],
    get archivedFresh() { return true; },
    async refreshArchived() {},
    async list() { return [{ id: 'fake-workspace', path: workspaceDir, sessionIds: [sessionId] }]; },
  };
  if (typeof archiveSession === 'function') {
    registry.archiveSession = (sid) => { archiveCalls.push(sid); return archiveSession(sid); };
  }

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
  const controller = { resolveAgent: async () => ({ agent }) };
  const dsh = {
    agents: { get: (id) => (id === sessionId || id === 'session-' + sessionId ? agent : null) },
    workspaceRegistry: registry,
    get: (name) => (name === 'workspaceRegistry' ? registry : name === 'sessionController' ? controller : null),
  };

  const { createHub } = await import('../src/aurabot/src/chat/hub.js');
  const { runCommand } = await import('../src/aurabot/src/chat/commands.js');
  const hub = createHub({
    dsh,
    getConfig: () => config,
    log: quietLog(),
    onebot: { call: async () => ({}) },
    stickers: { match: () => null, segmentFor: () => null, pickForReply: () => null, markUsed() {}, collect: async () => ({ ok: false }) },
    tts: { speak: async () => '' },
    buildTools: () => [],
  });

  // 走真实的建映射路径：agentFor 会写 sessionToChat（内存实时映射），这样「实时映射有没有被清」才测得出来。
  await hub.pushToSession({ chatId, kind: 'private', userId: '10001' }, [{ type: 'text', text: 'seed mapping' }], '10001');

  const deps = {
    getConfig: () => config,
    setConfig: () => {},
    mutes: { set() {}, clear() {}, until() { return undefined; } },
    hub,
  };
  const resetCommand = () => runCommand({ name: 'reset', arg: '' }, { chatId, kind: 'private', userId: '10001' }, deps);
  const diskMap = () => JSON.parse(readFileSync(sessionsFile, 'utf8'));
  const cleanup = () => {
    try {
      hub.disposeRecentMedia();
    } finally {
      if (previousDataDir === undefined) delete process.env.AURABOT_DATA_DIR;
      else process.env.AURABOT_DATA_DIR = previousDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  };

  return { hub, resetCommand, config, chatId, sessionId, sessionsFile, originalMap, archiveCalls, diskMap, cleanup };
}

test('reset 命令在归档 Promise 结束前不返回，也不清任何映射', async () => {
  let resolveArchive;
  const gate = new Promise((resolve) => { resolveArchive = resolve; });
  const w = await makeWorld({ prefix: 'aurabot-reset-chat-pending-', archiveSession: () => gate });
  try {
    assert.equal(w.hub.chatOfSession(w.sessionId), w.chatId, '前置：实时映射已建立');

    let settled = false;
    const command = w.resetCommand().then(
      (value) => { settled = true; return value; },
      (error) => { settled = true; throw error; },
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(settled, false, '归档还没回来，命令不该有结果');
    assert.deepEqual(w.archiveCalls, [w.sessionId], '归档已经发起，但只发起、没完成');
    assert.equal(w.hub.chatOfSession(w.sessionId), w.chatId, '归档进行中，内存实时映射还在');
    assert.deepEqual(w.diskMap(), w.originalMap, '归档进行中，磁盘映射还没动');

    resolveArchive();
    assert.equal(await command, SUCCESS_TEXT, '归档成功后才说「重新开始」');
    assert.deepEqual(w.diskMap().chats, {}, '写盘成功后磁盘映射已清');
    assert.equal(w.hub.chatOfSession(w.sessionId), '', '实时映射已清');
    assert.deepEqual(w.hub.sessions(), {}, 'hub 看到的会话表已清');
  } finally {
    w.cleanup();
  }
});

test('归档被拒时映射原样保留，命令不说成功也不漏内部信息', async () => {
  const w = await makeWorld({
    prefix: 'aurabot-reset-chat-archive-fail-',
    archiveSession: async (sid) => { throw new Error('archive exploded for ' + sid); },
  });
  try {
    const text = await w.resetCommand();
    assert.equal(typeof text, 'string');
    assert.notEqual(text, SUCCESS_TEXT, '归档失败不能说「重新开始」了');
    assert.ok(!text.includes('session-'), '不能把会话 id 抖出去：' + text);
    assert.ok(!text.includes('exploded'), '不能把报错原文抖出去：' + text);
    assert.ok(text.includes('还留着'), '要说清原来的会话还在：' + text);

    assert.deepEqual(w.archiveCalls, [w.sessionId]);
    assert.deepEqual(w.diskMap(), w.originalMap, '磁盘映射没动');
    assert.equal(w.hub.chatOfSession(w.sessionId), w.chatId, '内存实时映射没动');
  } finally {
    w.cleanup();
  }
});

test('registry 缺 archiveSession 时直接失败，且不动任何映射', async () => {
  const w = await makeWorld({ prefix: 'aurabot-reset-chat-no-archive-', archiveSession: null });
  try {
    await assert.rejects(w.hub.resetChat(w.chatId), (error) => error.code === 'workspace-registry-unavailable' && error.stage === 'preflight');
    assert.deepEqual(w.diskMap(), w.originalMap);
    assert.equal(w.hub.chatOfSession(w.sessionId), w.chatId);

    const text = await w.resetCommand();
    assert.notEqual(text, SUCCESS_TEXT);
    assert.ok(!text.includes('session-'));
    assert.deepEqual(w.diskMap(), w.originalMap);
    assert.equal(w.hub.chatOfSession(w.sessionId), w.chatId);
  } finally {
    w.cleanup();
  }
});

test('归档成功且写盘成功：resetChat 返回 true 并清掉 chats 映射与实时映射', async () => {
  const w = await makeWorld({ prefix: 'aurabot-reset-chat-ok-', archiveSession: async () => {} });
  try {
    assert.equal(await w.hub.resetChat(w.chatId), true);
    assert.deepEqual(w.archiveCalls, [w.sessionId]);
    assert.deepEqual(w.diskMap().chats, {});
    assert.equal(w.hub.chatOfSession(w.sessionId), '');
    assert.deepEqual(w.hub.sessions(), {});
    // 再叫一次：没有映射了就纯 no-op，不重复归档
    assert.equal(await w.hub.resetChat(w.chatId), false);
    assert.deepEqual(w.archiveCalls, [w.sessionId], '没有映射就不该再归档一次');
  } finally {
    w.cleanup();
  }
});

test('写盘失败时抛错，磁盘与实时映射都保留', async () => {
  const w = await makeWorld({ prefix: 'aurabot-reset-chat-save-fail-', archiveSession: async () => {} });
  try {
    // writeJson 先写 `${file}.tmp-${pid}` 再改名：把那个临时路径做成目录，写盘必然失败。
    mkdirSync(`${w.sessionsFile}.tmp-${process.pid}`);

    await assert.rejects(w.hub.resetChat(w.chatId), (error) => error.code === 'map-save-failed' && error.stage === 'save');
    assert.deepEqual(w.archiveCalls, [w.sessionId], '归档确实成功了（这是允许的）');
    assert.deepEqual(w.diskMap(), w.originalMap, '磁盘映射没动');
    assert.equal(w.hub.chatOfSession(w.sessionId), w.chatId, '实时映射没动');

    const text = await w.resetCommand();
    assert.notEqual(text, SUCCESS_TEXT, '写盘失败不能声称已经重开');
    assert.ok(!text.includes('session-'));
    assert.ok(text.includes('归档已完成'), 'write failure message must not imply the archive itself failed');
    assert.ok(text.includes('映射没保存好'), 'message states local mapping persistence failed');
    assert.equal(w.hub.chatOfSession(w.sessionId), w.chatId);
  } finally {
    w.cleanup();
  }
});
