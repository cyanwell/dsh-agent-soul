#!/usr/bin/env node
// TEMP-only status-layer coverage for ECHO v9 integrity. No shared doctor or production DB.
import strictAssert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readOpsLayer } from '../src/web/status-data.mjs';
import { openMetaStore, MIGRATIONS } from '../src/db/index.mjs';

// ★ 2026-11-15：断言条数必须是**数出来**的，不能手写。
//   旧版结束时打印「16 assertions passed」，而这条文件实测早就是 36 条 ——
//   写死的数字一定会骗人，而且骗的正是「到底测了多少」这件事。
//   这里用一个计数代理：调用点一个字都不用改，passed 只统计**没抛**的那些。
let passed = 0;
const assert = new Proxy(strictAssert, {
  get(target, key) {
    const v = target[key];
    if (typeof v !== 'function') return v;
    return (...args) => { const r = v.apply(target, args); passed += 1; return r; };
  },
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-status-integrity-'));
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const echoStats = (values) => () => ({
  available: true, aligned: values.aligned, ok: values.ok, searchable: values.searchable,
  words: values.words, summaries: values.summaries, problems: values.problems || []
});
const layer = (opts = {}, config = {}) => readOpsLayer({
  config: { dataDir: path.join(root, 'data'), ...config },
  core: { pid: 1, startedAtMs: Date.now() - 1000, configMtimeMs: null, uptimeSec: 1, node: process.version, rssMB: 1 },
  opts: { core: { pid: 1, startedAtMs: Date.now() - 1000, uptimeSec: 1, node: process.version, rssMB: 1 }, ...opts }
});
const item = (opts = {}, config = {}) => layer(opts, config).items.find((x) => x.label === 'ECHO v9 索引');
let closedInjected = 0;
try {
  const missing = item();
  assert.equal(missing.na, true);
  assert.match(missing.why, /UNKNOWN/);
  assert.equal(missing.value, null);

  const healthyStore = { echoStats: echoStats({ aligned: true, ok: true, searchable: true, words: 3, summaries: 1 }) };
  const before = fs.readdirSync(root).sort();
  const healthyLayer = layer({ echoStore: healthyStore });
  const healthy = healthyLayer.items.find((x) => x.label === 'ECHO v9 索引');
  assert.equal(healthyLayer.key, 'ops');
  assert.match(healthyLayer.provenance, /meta\.sqlite.*v4 ECHO integrity/);
  assert.equal(healthyLayer.items.some((x) => x.label === 'ECHO 源域体检（外部旧 doctor）'), true);
  assert.notEqual(healthyLayer.items.findIndex((x) => x.label === 'ECHO v9 索引'), healthyLayer.items.findIndex((x) => x.label === 'ECHO 源域体检（外部旧 doctor）'));
  assert.equal(healthy.bad, false);
  assert.equal(healthy.ok, true);
  // ★ 2026-11-15：健康的 ECHO v9（available / aligned / ok / searchable 全 true、problems 空）
  //   必须是 **ok**。旧式把这一行报成 warn，于是「好」和「不知道」在界面上同码。
  assert.equal(healthyLayer.level, 'ok');
  assert.match(healthyLayer.provenance, /meta\.sqlite.*v4 ECHO integrity/);
  assert.equal(healthy.value, 'OK');
  assert.equal(healthy.aligned, true);
  assert.equal(healthy.searchable, true);
  assert.deepEqual(healthy.counts, { words: 3, summaries: 1, problems: 0 });
  assert.equal(Object.prototype.hasOwnProperty.call(healthy, 'source'), false, 'status output must not expose the DB path');
  assert.deepEqual(fs.readdirSync(root).sort(), before, 'status layer must not create files');

  const staleStore = { echoStats: echoStats({ aligned: false, ok: false, searchable: false, words: 2, summaries: 1, problems: [{ kind: 'source-declared-counts' }, { kind: 'words-fts' }] }) };
  const staleLayer = layer({ echoStore: staleStore });
  const stale = staleLayer.items.find((x) => x.label === 'ECHO v9 索引');
  assert.equal(staleLayer.key, 'ops');
  assert.equal(stale.bad, true);
  assert.equal(staleLayer.level, 'error');
  assert.match(staleLayer.provenance, /meta\.sqlite.*v4 ECHO integrity/);
  assert.equal(stale.value, 'DEGRADED');
  assert.equal(stale.searchable, false);
  assert.deepEqual(stale.problemKinds, ['source-declared-counts', 'words-fts']);
  assert.doesNotMatch(JSON.stringify(stale), /log:|session-|secret|token/i);

  // ★ 2026-11-15：aligned 但 ok=false —— 元数据审计有账、搜索仍可用。这是**非致命**，warn 不是 error。
  //   （判据：结构没歪就还有用；只有结构歪了才配 error。这条区分就是本次修复的全部。）
  const metadataStore = { echoStats: echoStats({ aligned: true, ok: false, searchable: true, words: 4, summaries: 2, problems: [{ kind: 'summary-count-drift' }] }) };
  const metadataLayer = layer({ echoStore: metadataStore });
  const metadata = metadataLayer.items.find((x) => x.label === 'ECHO v9 索引');
  assert.equal(metadataLayer.key, 'ops');
  assert.equal(metadataLayer.level, 'warn');
  assert.equal(metadata.aligned, true);
  assert.equal(metadata.ok, false);
  assert.equal(metadata.searchable, true);
  assert.equal(metadata.value, 'DEGRADED');
  assert.equal(metadata.bad, true);
  assert.deepEqual(metadata.problemKinds, ['summary-count-drift']);

  // ★ 优先级：aligned=false 压过 ok=true —— 规则是「结构优先」，不是「谁坏听谁的」。
  const contradictoryLayer = layer({ echoStore: { echoStats: echoStats({ aligned: false, ok: true, searchable: false, problems: [{ kind: 'words-fts' }] }) } });
  assert.equal(contradictoryLayer.level, 'error', 'aligned=false 必须先判 error，不能被 ok=true 翻回 ok');

  // ★ 2026-11-15 补的边角：契约是「aligned===true **且** ok===true 才算健康」。
  //   aligned **缺失**（undefined）而 ok=true 时，旧判据落进 `ok===true → ok`，
  //   等于「没报过对齐」也能被算作健康 —— 缺一票就该退回 warn。
  //   也**不能是 error**：error 表示「结构歪了」，这里只是「没报对齐」，没证据说它歪。
  const unknownAlignedLayer = layer({ echoStore: { echoStats: echoStats({ aligned: undefined, ok: true, searchable: false, words: 5, summaries: 2 }) } });
  const unknownAligned = unknownAlignedLayer.items.find((x) => x.label === 'ECHO v9 索引');
  assert.equal(unknownAlignedLayer.level, 'warn', 'aligned 缺失 + ok=true 必须是 warn，不许被 ok=true 抬成 ok');
  assert.equal(unknownAligned.available, true);
  assert.equal(unknownAligned.aligned, undefined, '缺失的 aligned 不许被压成 false（那是替 Store 宣布结构歪了）');
  assert.equal(unknownAligned.ok, true);
  assert.equal(unknownAligned.searchable, false);
  assert.equal(unknownAligned.value, 'DEGRADED');
  assert.equal(unknownAligned.bad, true);
  assert.deepEqual(unknownAligned.counts, { words: 5, summaries: 2, problems: 0 });

  // 字段**整个没报**（键都不存在）走同一条：undefined 不是 false，也不是健康。
  const omittedAlignedLayer = layer({ echoStore: { echoStats: () => ({ available: true, ok: true, searchable: false, words: 7, summaries: 3, problems: [] }) } });
  const omittedAligned = omittedAlignedLayer.items.find((x) => x.label === 'ECHO v9 索引');
  assert.equal(omittedAlignedLayer.level, 'warn', 'echoStats 根本没报 aligned 时同样是 warn');
  assert.equal(omittedAligned.aligned, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(omittedAligned, 'aligned'), true, 'aligned 键仍在（值为 undefined），不是被删掉');

  // 反向边角：aligned 缺失但 ok 也不 true → 仍是 warn（不因缺对齐升 error）。
  const unknownBothLayer = layer({ echoStore: { echoStats: echoStats({ aligned: undefined, ok: false, searchable: false, words: 1, summaries: 0 }) } });
  assert.equal(unknownBothLayer.level, 'warn');

  const unavailableLayer = layer({ echoStore: { echoStats: () => ({ available: false, why: 'ECHO_INDEX_MISSING' }) } });
  const unavailable = unavailableLayer.items.find((x) => x.label === 'ECHO v9 索引');
  assert.equal(unavailable.na, true);
  assert.equal(unavailableLayer.level, 'warn');
  assert.equal(unavailableLayer.items.some((x) => x.label === 'ECHO 源域体检（外部旧 doctor）'), true);
  assert.match(unavailable.why, /ECHO_INDEX_MISSING/);

  // Real readonly open against an explicitly created TEMP v1 DB: no ECHO tables, no migrations.
  const dbPath = path.join(root, 'legacy-v1.sqlite');
  const setup = openMetaStore({ path: dbPath, mode: 'readwrite', migrations: MIGRATIONS.slice(0, 1) });
  setup.migrate();
  setup.close();
  const dbHashBefore = sha256(dbPath);
  const legacyDbItem = item({ echoDbPath: dbPath });
  assert.equal(legacyDbItem.na, true);
  assert.match(legacyDbItem.why, /readonly store is not migrated/);
  assert.equal(sha256(dbPath), dbHashBefore, 'readonly status probe must not migrate or modify SQLite');

  const thrown = item({ echoStore: { echoStats: () => { throw new Error('readonly probe failed'); } } });
  assert.equal(thrown.na, true);
  assert.match(thrown.why, /readonly probe failed/);

  const ownedMissingPath = path.join(root, 'not-created.sqlite');
  const absent = item({ echoDbPath: ownedMissingPath });
  assert.equal(absent.na, true);
  assert.equal(fs.existsSync(ownedMissingPath), false, 'missing DB must not be created');

  const closableStore = { echoStats: echoStats({ aligned: true, ok: true, searchable: true, words: 0, summaries: 0 }), close() { closedInjected++; } };
  item({ echoStore: closableStore });
  assert.equal(closedInjected, 0, 'injected Store ownership remains with caller');
  console.log('ECHO status TEMP self-test: ' + passed + ' assertions passed'
    + ' · levels healthy=ok stale=error metadata-warn=warn na=warn unknown-aligned=warn');
} catch (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  if (fs.existsSync(root)) { console.error('TEMP cleanup failed'); process.exitCode = 1; }
}
