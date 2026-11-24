/**
 * 桥上 `workspaceRegistry` 跨进程投影口径的守卫（agent-soul 侧 · 2026-11-24）
 *
 * 跑法：node --test test/bridge-archive-wire.test.mjs
 *
 * ★ 为什么这份测试在 agent-soul 仓库里、而不是只在桥的源码仓库里：
 *   它 import 的是**本仓库跟踪的那一份镜像** `plugins/dsh-agent-soul-bridge/index.js`，
 *   也就是随本仓库一起分发、v4 实际会加载的那一份。
 *   桥的权威源码在 dsh-tools，镜像靠同步维护 —— 镜像一旦落后，v4 看到的就是坏契约。
 *   2026-11-24 真的发生过：镜像还停在「workspaceRegistry 一律投影」的旧写法上。
 *   所以这条测试守的不是「桥能跑」，而是**仓库里这一份的口径没漂**。
 *
 * 覆盖的只有那个契约（不做别的）：
 *   ① archivedSessionIds（string[] 属性）原样跨线，元素仍是字符串
 *   ② list 仍把 Workspace 实体投影成纯数据（字段齐全、没有活对象）
 *   ③ get 单个实体仍投影；查不到仍是 null
 *   ④ archiveSession 的 void 仍是 null
 *   ⑤ 白名单的投影口径：只有吐实体的方法进 projectMethods
 *
 * 全部离线：假 svc，不连 7310、不启 DSH、不读真实工作区、不联网。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  makeServiceGateway,
  projectWorkspace,
  SERVICE_ALLOWLIST,
} from '../plugins/dsh-agent-soul-bridge/index.js';

/** 假 Workspace：照 dsh-workspace 的形状给 getter（真身也是 class + getter）。 */
class FakeWorkspace {
  constructor(id) {
    this._id = id;
    this._sessionIds = ['s1', 's2'];
  }

  get id() { return this._id; }
  get path() { return 'D:/fake/' + this._id; }
  get title() { return 'ws-' + this._id; }
  get createdAt() { return 1750000000000; }
  get updatedAt() { return 1750000001000; }
  get sessionIds() { return this._sessionIds; }
}

/** 假服务：只实现白名单里那几个方法 + 那个属性，别的一概没有。 */
function fakeRegistry() {
  const alpha = new FakeWorkspace('alpha');
  const beta = new FakeWorkspace('beta');
  const archived = ['session-a', 'session-b'];
  const calls = [];
  return {
    calls,
    get archivedSessionIds() { return archived; },
    list() { calls.push('list'); return [alpha, beta]; },
    create(spec) { calls.push('create'); return new FakeWorkspace('made-' + (spec && spec.id)); },
    get(id) { calls.push('get'); return id === 'alpha' ? alpha : null; },
    resolveByPath(p) { calls.push('resolveByPath'); return p ? alpha : null; },
    archiveSession(session) {
      calls.push('archiveSession');
      assert.equal(typeof session, 'string', 'archiveSession 收到的是 sessionId 字符串');
    },
  };
}

function gatewayWith(svc) {
  return makeServiceGateway({ getService: (name) => (name === 'workspaceRegistry' ? svc : null) });
}

test('archivedSessionIds 原样跨线：string[] 不被投影成对象数组', async () => {
  const gw = gatewayWith(fakeRegistry());
  const got = await gw.call({ name: 'workspaceRegistry', method: 'archivedSessionIds', args: [] });

  assert.deepEqual(
    got,
    ['session-a', 'session-b'],
    'archivedSessionIds 必须是原样字符串数组；出现对象说明它又被 projectWorkspace 投影了'
  );
  assert.deepEqual(got.map((x) => typeof x), ['string', 'string']);
  assert.equal(JSON.stringify(got), '["session-a","session-b"]', '过线之后每个元素都还是字符串');
  assert.equal(got.includes('session-a'), true, 'hub 自愈靠这个 includes 判「这个会话已归档」');
});

test('list 仍投影成纯数据实体（字段齐全、没有活对象）', async () => {
  const gw = gatewayWith(fakeRegistry());
  const got = await gw.call({ name: 'workspaceRegistry', method: 'list', args: [] });

  assert.equal(Array.isArray(got), true);
  assert.equal(got.length, 2);

  const [w] = got;
  assert.equal(w.id, 'alpha');
  assert.equal(w.path, 'D:/fake/alpha');
  assert.equal(w.title, 'ws-alpha');
  // ★ 投影把时间戳 String() 掉（index.js:798-799）—— 这里只钉「值跨过线没丢」，
  //   不钉它的 JS 类型（那是投影细节，不是本次契约）。
  assert.equal(String(w.createdAt), '1750000000000');
  assert.equal(String(w.updatedAt), '1750000001000');
  assert.deepEqual(w.sessionIds, ['s1', 's2']);

  assert.equal(typeof w.id, 'string');
  assert.equal(typeof w.path, 'string');
  assert.equal(typeof w.title, 'string');
  assert.equal(Array.isArray(w.sessionIds), true);

  // 纯数据，不是那个 class 的残骸
  assert.equal('get id' in w, false);
  assert.equal(w.constructor, Object);

  // 与 projectWorkspace 自己算出来的结果一致（口径没走第二条路）
  assert.deepEqual(
    w,
    projectWorkspace({
      id: 'alpha',
      path: 'D:/fake/alpha',
      title: 'ws-alpha',
      createdAt: 1750000000000,
      updatedAt: 1750000001000,
      sessionIds: ['s1', 's2'],
    })
  );
});

test('get 单个实体仍按实体投影；查不到仍是 null', async () => {
  const gw = gatewayWith(fakeRegistry());

  const got = await gw.call({ name: 'workspaceRegistry', method: 'get', args: ['alpha'] });
  assert.equal(got.id, 'alpha');
  assert.equal(got.path, 'D:/fake/alpha');
  assert.deepEqual(got.sessionIds, ['s1', 's2']);

  const miss = await gw.call({ name: 'workspaceRegistry', method: 'get', args: ['nope'] });
  assert.equal(miss, null, 'missing entity 仍是 null ——「不是对象 → null」这条没被改掉');
});

test('archiveSession 的 void 仍然是 null', async () => {
  const gw = gatewayWith(fakeRegistry());
  const got = await gw.call({ name: 'workspaceRegistry', method: 'archiveSession', args: ['session-a'] });
  assert.equal(got, null, 'void 方法返回 undefined → 过线是 null；它不该被投影成实体');
});

test('白名单的投影口径：只有吐实体的方法进 projectMethods', () => {
  const spec = SERVICE_ALLOWLIST.workspaceRegistry;
  assert.equal(Array.isArray(spec.projectMethods), true,
    '缺 projectMethods 说明这一份还是「workspaceRegistry 一律投影」的旧写法');

  for (const m of ['list', 'create', 'get', 'resolveByPath']) {
    assert.equal(spec.projectMethods.includes(m), true, 'projectMethods 必须含实体方法 ' + m);
  }

  // 这两个是本次修复的正面：它们可调，但**不投影**
  assert.equal(spec.methods.includes('archiveSession'), true, 'archiveSession 仍在可调方法里');
  assert.equal(spec.properties.includes('archivedSessionIds'), true, 'archivedSessionIds 仍在可调属性里');
  assert.equal(spec.projectMethods.includes('archiveSession'), false, 'void 方法不许进 projectMethods');
  assert.equal(spec.projectMethods.includes('archivedSessionIds'), false, 'string[] 属性不许进 projectMethods');
});

test('describe 把属性列进可调清单（v4 靠它知道能问哪些）', () => {
  const gw = gatewayWith(fakeRegistry());
  const d = gw.describe();
  assert.equal(d.workspaceRegistry.includes('archivedSessionIds'), true);
  assert.equal(d.workspaceRegistry.includes('archiveSession'), true);
});
