import fs from 'node:fs';
import path from 'node:path';
import { SessionStore } from '../src/session/store.mjs';
import { ROOT } from '../src/config.mjs';

const dir = path.join(ROOT, 'data', 'bench2-' + Date.now());
fs.mkdirSync(dir, { recursive: true });

// A. 裸 appendFileSync 1000 次
const f1 = path.join(dir, 'a.jsonl');
let t = Date.now();
for (let i = 0; i < 1000; i++) fs.appendFileSync(f1, JSON.stringify({ i, text: 'x'.repeat(80) }) + '\n');
const tAppend = Date.now() - t;
console.log('裸 appendFileSync × 1000: ' + tAppend + 'ms  (' + (tAppend / 1000).toFixed(3) + 'ms/次)');

// B. 保持句柄写 1000 次
const f2 = path.join(dir, 'b.jsonl');
const fd = fs.openSync(f2, 'a');
t = Date.now();
for (let i = 0; i < 1000; i++) fs.writeSync(fd, JSON.stringify({ i, text: 'x'.repeat(80) }) + '\n');
const tWrite = Date.now() - t;
fs.closeSync(fd);
console.log('保持句柄 writeSync × 1000: ' + tWrite + 'ms  (' + (tWrite / 1000).toFixed(3) + 'ms/次)');

// C. 拼成一个字符串一次写
const f3 = path.join(dir, 'c.jsonl');
let buf = '';
for (let i = 0; i < 1000; i++) buf += JSON.stringify({ i, text: 'x'.repeat(80) }) + '\n';
t = Date.now();
fs.appendFileSync(f3, buf);
const tBatch = Date.now() - t;
console.log('拼好一次写 × 1000: ' + tBatch + 'ms');

// D. store.append 1000 次（真实路径）
const s = new SessionStore(dir);
s.create(ROOT, null, { id: 'x' });
t = Date.now();
for (let i = 0; i < 1000; i++) s.append('x', 'user', { text: 'y'.repeat(80) });
const tStore = Date.now() - t;
console.log('store.append × 1000: ' + tStore + 'ms  (' + (tStore / 1000).toFixed(3) + 'ms/次)');
console.log('');
console.log('结论: appendFileSync 占 ' + tAppend + 'ms，writeSync 占 ' + tWrite + 'ms，一次写占 ' + tBatch + 'ms');
console.log('      store.append 的额外开销 = ' + (tStore - tAppend * 2) + 'ms（它每帧写两个文件）');

try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}