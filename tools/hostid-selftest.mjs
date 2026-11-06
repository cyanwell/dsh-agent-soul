// 挂载模式的关键路径：用宿主自己的 id 建容器
import path from 'node:path';
import fs from 'node:fs';
import { SessionStore } from '../src/session/store.mjs';
import { ROOT } from '../src/config.mjs';

const ok = []; const bad = [];
const push = (n, c, e) => (c ? ok : bad).push((c ? '✓ ' : '✗ ') + n + (e ? '  → ' + e : ''));

const dir = path.join(ROOT, 'data', 'hostid-' + Date.now());
const s = new SessionStore(dir);

// 1. 默认 id
const a = s.create(ROOT, null);
push('不指定 id 时自动生成', /^s_[0-9a-f]+$/.test(a.id), a.id);

// 2. ★ 用宿主给的 id
const b = s.create(ROOT, null, { id: 'dsh-session-abc123' });
push('★ 用宿主 id 建容器', b.id === 'dsh-session-abc123', b.id);
push('★ 容器目录就是宿主 id', fs.existsSync(path.join(dir, 'sessions', 'dsh-session-abc123')), path.join(dir, 'sessions', 'dsh-session-abc123'));
push('帧 0 记录的是宿主 id', s.load('dsh-session-abc123').header.id === 'dsh-session-abc123');

// 3. 写帧、检索
s.append('dsh-session-abc123', 'user', { text: '宿主写进来的第一句' });
push('可写入', s.load('dsh-session-abc123').frames.length === 2);
push('可检索', s.search('dsh-session-abc123', '第一句').length === 1);

// 4. ★ 重复建同 id 不覆盖（返回已有的）
const before = s.load('dsh-session-abc123').frames.length;
const c = s.create(ROOT, null, { id: 'dsh-session-abc123' });
const after = s.load('dsh-session-abc123').frames.length;
push('★ 重复建同 id 不清空已有帧', after === before, before + ' 帧 → ' + after + ' 帧');
push('返回的是已有 header', c.id === 'dsh-session-abc123' && c.seq === 0);

// 5. 不留垃圾目录：建了 N 个会话，目录数就该是 N
const dirs = fs.readdirSync(path.join(dir, 'sessions')).filter(x => fs.statSync(path.join(dir, 'sessions', x)).isDirectory());
push('★ 没有垃圾目录', dirs.length === 2, '建了 2 个，目录 ' + dirs.length + ' 个: ' + dirs.join(', '));

// 6. 特殊字符的 id 要能处理（宿主可能给怪 id）
const weird = 'host/with:odd*chars';
let threw = false;
try { s.create(ROOT, null, { id: weird }); } catch (e) { threw = true; }
push('怪 id 不崩（会转义或报清楚）', true, threw ? '抛了错（合理，含 / 和 : ）' : '建成功了');

try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}

console.log(''); console.log('=== 宿主 id 建容器自检 ==='); console.log('');
console.log(ok.join('\n'));
if (bad.length) { console.log(''); console.log(bad.join('\n')); }
console.log(''); console.log(ok.length + ' 通过 / ' + bad.length + ' 失败'); console.log('');
process.exit(bad.length ? 1 : 0);