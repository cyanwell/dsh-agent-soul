// src/db/engine.mjs —— node:sqlite 的唯一入口。
//
// ★ 全仓规矩：只有本文件 require('node:sqlite')。src/db 下任何其它文件都从
//   openDatabase()/engineInfo() 拿句柄与版本，不直接 import node:sqlite。
//   tools/meta-store-selftest.mjs 会用源码扫描验证这一点。
//
// 生产候选引擎固定为 DSH 自带 Node 24（mcp-hub/servers.json 里跑 agent-soul 的那条 node）。
// node:sqlite 在 Node 24 已无需 --experimental-sqlite，但仍标记为实验特性 ——
// 所以每次迁移都把 node 版本与 sqlite_version() 写进 schema_migrations，供事后核对。

import { createRequire } from 'node:module';
import { fail, CODES } from './errors.mjs';

const require = createRequire(import.meta.url);

export const ENGINE_NAME = 'node:sqlite';
export const MIN_NODE_MAJOR = 22;
export const MIN_SQLITE_VERSION = '3.35.0';

let cachedModule = null;

export function sqliteModule() {
  if (!cachedModule) cachedModule = require('node:sqlite');
  return cachedModule;
}

function parseVersion(text) {
  const parts = String(text).split('.').map(function (p) { return parseInt(p, 10) || 0; });
  return { major: parts[0] || 0, minor: parts[1] || 0, patch: parts[2] || 0, parts };
}

function cmpVersion(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa.parts[i] !== pb.parts[i]) return pa.parts[i] < pb.parts[i] ? -1 : 1;
  }
  return 0;
}

export function engineInfo() {
  const mod = sqliteModule();
  if (typeof mod.DatabaseSync !== 'function') {
    fail(CODES.ENGINE_UNSUPPORTED, 'node:sqlite does not expose DatabaseSync', { keys: Object.keys(mod) });
  }
  const probe = new mod.DatabaseSync(':memory:');
  let sqliteVersion = null;
  try {
    const row = probe.prepare('select sqlite_version() as v').get();
    sqliteVersion = row.v;
  } finally {
    probe.close();
  }
  return {
    engine: ENGINE_NAME,
    nodeVersion: process.version,
    nodeVersionSource: process.version,
    sqliteVersion,
    minNodeMajor: MIN_NODE_MAJOR,
    minSqliteVersion: MIN_SQLITE_VERSION,
  };
}

export function assertEngine() {
  const info = engineInfo();
  const node = parseVersion(info.nodeVersion.replace(/^v/, ''));
  if (node.major < MIN_NODE_MAJOR) {
    fail(CODES.ENGINE_UNSUPPORTED, 'node ' + info.nodeVersion + ' is below required major ' + MIN_NODE_MAJOR, info);
  }
  if (cmpVersion(info.sqliteVersion, MIN_SQLITE_VERSION) < 0) {
    fail(CODES.ENGINE_UNSUPPORTED, 'sqlite ' + info.sqliteVersion + ' is below required ' + MIN_SQLITE_VERSION, info);
  }
  return info;
}

export function openDatabase(filePath, options) {
  const o = options || {};
  if (typeof filePath !== 'string' || filePath.length === 0) {
    fail(CODES.INVALID_INPUT, 'openDatabase requires a file path or :memory:', { filePath });
  }
  const mod = sqliteModule();
  const db = new mod.DatabaseSync(filePath, { readOnly: o.readOnly === true });
  return db;
}

// 连接级 PRAGMA 集中在这里，避免每个调用点各设一套。
export function configureConnection(db, options) {
  const o = options || {};
  const timeoutMs = typeof o.timeoutMs === 'number' ? o.timeoutMs : 5000;
  const readOnly = o.readOnly === true;
  const isMemory = o.memory === true;

  db.exec('PRAGMA busy_timeout = ' + Math.max(0, Math.floor(timeoutMs)));
  // foreign_keys 是连接级开关，只读连接也要开：它影响的是约束检查，不是写库。
  db.exec('PRAGMA foreign_keys = ON');
  if (!readOnly) {
    db.exec('PRAGMA synchronous = NORMAL');
    if (!isMemory) {
      // WAL 是持久属性，只在可写连接上设；只读连接设它会报错。
      db.exec('PRAGMA journal_mode = WAL');
    }
  }
  return {
    busyTimeout: db.prepare('PRAGMA busy_timeout').get().timeout,
    foreignKeys: db.prepare('PRAGMA foreign_keys').get().foreign_keys,
    journalMode: db.prepare('PRAGMA journal_mode').get().journal_mode,
    readOnly,
  };
}
