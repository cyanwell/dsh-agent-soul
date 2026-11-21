// DSH session synchronization CLI. Importing this module is inert.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createSyncRuntime } from '../src/sync/core.mjs';

export function help() {
  return '用法：node tools/soul-sync.mjs [--dry] [--src <path>] [--since <date>] [--watch]';
}
function isDirectMain(metaUrl = import.meta.url, argv = process.argv) {
  try { return !!argv[1] && path.resolve(argv[1]) === path.resolve(fileURLToPath(metaUrl)); } catch { return false; }
}
export const guards = Object.freeze({ isDirectMain });

export async function main(argv = [], deps = {}) {
  const flag = (n) => argv.includes('--' + n);
  const val = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const [configModule, storeModule, readerModule, fsModule] = await Promise.all([
    deps.config || deps.configModule ? Promise.resolve(deps.configModule || {}) : import('../src/config.mjs'),
    deps.store || deps.storeModule ? Promise.resolve(deps.storeModule || {}) : import('../src/session/store.mjs'),
    deps.reader ? Promise.resolve({}) : deps.readerModule ? Promise.resolve(deps.readerModule) : import('../src/migrate/dsh.mjs'),
    deps.fs ? Promise.resolve({ default: deps.fs }) : import('node:fs'),
  ]);
  const config = deps.config || configModule.loadConfig();
  const fs = deps.fs || fsModule.default;
  const store = deps.store || new storeModule.SessionStore(config.dataDir);
  const sourceRoot = val('src', 'D:/AI/dsh/home/sessions');
  const statePath = path.join(config.dataDir, 'sync-state.json');
  const runtime = createSyncRuntime({ store, sourceRoot, statePath, fs, path, reader: deps.reader || { read: readerModule.readDshSession, readAsync: readerModule.readDshSessionAsync, readTail: readerModule.readDshSessionTail, toFrames: readerModule.toFrames }, clock: deps.clock || { now: () => Date.now(), parse: (v) => Date.parse(v), create: (v) => v === undefined ? new Date() : new Date(v) }, logger: deps.logger || console, dryRun: flag('dry'), since: val('since', null), watch: flag('watch'), setTimeout: deps.setTimeout, clearTimeout: deps.clearTimeout });
  const logger = deps.logger || console;
  if (flag('watch')) {
    logger.log('同步器常驻：每 5 秒扫一次 ' + sourceRoot);
    logger.log('水位文件：' + statePath);
    runtime.round();
    const timer = (deps.setInterval || setInterval)(() => { try { runtime.round(); } catch (e) { logger.error('  出错：' + e.message); } }, 5000);
    return { runtime, timer, stop: () => (deps.clearInterval || clearInterval)(timer) };
  }
  runtime.round();
  if (flag('dry')) logger.log('（--dry：没有真的写）');
  logger.log('水位文件：' + statePath);
  return runtime;
}

if (isDirectMain()) { main(process.argv.slice(2)).catch((e) => { console.error('  出错：' + (e && e.message || e)); process.exitCode = 1; }); }
