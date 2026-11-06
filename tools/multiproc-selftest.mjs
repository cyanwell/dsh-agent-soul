import fs from 'node:fs';
import path from 'node:path';
import { SessionStore } from '../src/session/store.mjs';
import { ROOT } from '../src/config.mjs';

const ok = []; const bad = [];
const push = (n, c, e) => (c ? ok : bad).push((c ? '✓ ' : '✗ ') + n + (e ? '  → ' + e : ''));

const dir = path.join(ROOT, 'data', 'mp-' + Date.now());
const A = new SessionStore(dir);   // 进程 A（模拟宿主）
const B = new SessionStore(dir);   // 进程 B（模拟 agent-soul）—— 同一目录，不同实例

const h = A.create(ROOT, null);
const sid = h.id;

push('A 建会话', Boolean(sid), sid);
push('B 能看到', B.load(sid) !== null, 'B 读到 ' + (B.load(sid) || {}).frames.length + ' 帧');

// ★ 核心：A 写一帧，B 立刻要能看见
A.append(sid, 'user', { text: '宿主写的一条' });
const b1 = B.load(sid);
push('★ A 写 → B 立刻看见', b1 && b1.frames.length === 2, 'B 现在 ' + (b1 ? b1.frames.length : '?') + ' 帧');

// B 也要能检索到（索引是文件，不是内存）
const hits = B.search(sid, '宿主写的一条');
push('★ A 写的 → B 能检索到', hits.length === 1, 'B 命中 ' + hits.length + ' 条');

// 反向
B.append(sid, 'assistant', { text: '灵魂层写的一条' });
const a1 = A.load(sid);
push('B 写 → A 立刻看见', a1 && a1.frames.length === 3, 'A 现在 ' + (a1 ? a1.frames.length : '?') + ' 帧');
push('A 也能检索到 B 写的', A.search(sid, '灵魂层写的').length === 1);

// 缓存不能丢：连读三次应该一致
const x1 = A.load(sid).frames.length;
const x2 = A.load(sid).frames.length;
const x3 = A.load(sid).frames.length;
push('重复读一致', x1 === x2 && x2 === x3 && x1 === 3, '三次都是 ' + x1);

// 两个实例交替写 10 帧，看会不会乱
for (let i = 0; i < 10; i++) {
  (i % 2 ? A : B).append(sid, 'user', { text: '交替 ' + i });
}
const fin = B.load(sid);
const seqs = fin.frames.map(f => f.seq);
const dup = seqs.length !== new Set(seqs).size;
push('交替写 10 帧后 seq 不重复', !dup, '共 ' + fin.frames.length + ' 帧，seq ' + seqs[0] + '..' + seqs[seqs.length - 1]);

try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}

console.log(''); console.log('=== 多进程共写自检 ==='); console.log('');
console.log(ok.join('\n'));
if (bad.length) { console.log(''); console.log(bad.join('\n')); }
console.log(''); console.log(ok.length + ' 通过 / ' + bad.length + ' 失败'); console.log('');
process.exit(bad.length ? 1 : 0);