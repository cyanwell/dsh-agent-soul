import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from './soul-sync.mjs';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-sync-cli-'));
const sourceRoot = path.join(temp, 'src');
const sessionDir = path.join(sourceRoot, 'synthetic-session');
const dataDir = path.join(temp, 'data');
fs.mkdirSync(sessionDir, { recursive: true });
fs.writeFileSync(path.join(sessionDir, 'session.v4.jsonl.zstd'), 'fixture');
const outputs = [];
const records = [{ type: 'session', cwd: temp, agentPreset: null }, { type: 'user', seq: 1, text: 'fixture' }];
const readerModule = { readDshSession: () => ({ records }), readDshSessionAsync: async () => ({ records, endOffset: 7 }), readDshSessionTail: async () => null, toFrames: rs => ({ frames: rs.filter(r => r.type !== 'session').map(r => ({ ...r, meta: { seq: r.seq } })) }) };
const stored = [];
const store = { root: dataDir, load: () => null, create: (...x) => stored.push(['create', ...x]), append: (...x) => stored.push(['append', ...x]) };
const config = { dataDir };
const logger = { log: x => outputs.push(String(x)), error: x => outputs.push(String(x)) };
try {
  await main(['--src', sourceRoot, '--dry'], { config, store, fs, reader: { read: readerModule.readDshSession, readAsync: readerModule.readDshSessionAsync, readTail: readerModule.readDshSessionTail, toFrames: readerModule.toFrames }, logger, clock: { now: () => Date.now(), parse: v => Date.parse(v), create: v => v === undefined ? new Date() : new Date(v) } });
  assert.equal(stored.length, 0);
  assert(outputs.some(x => x.includes('写了 1 帧')));
  assert(outputs.some(x => x.includes('（--dry：没有真的写）')));
  assert(!fs.existsSync(path.join(dataDir, 'sync-state.json')));
  console.log('PASS synthetic CLI --src/--dry behavior');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
