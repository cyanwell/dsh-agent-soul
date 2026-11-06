// 检索基准 —— 先量，再决定要不要倒排
import path from 'node:path';
import fs from 'node:fs';
import { SessionStore } from '../src/session/store.mjs';
import { ROOT } from '../src/config.mjs';

const dir = path.join(ROOT, 'data', 'bench-' + Date.now());
const s = new SessionStore(dir);

const SESSIONS = Number(process.argv[2]) || 100;
const FRAMES = Number(process.argv[3]) || 100;

const WORDS = ['传输层','渲染','会话','索引','插件','人格','事件','记忆','模型','工具','拆分','耦合','解耦','协议','端口','配置','路径','构建','测试','部署'];
const rand = (n) => Math.floor(Math.random() * n);
const mkText = () => {
  const parts = [];
  for (let i = 0; i < 8; i++) parts.push(WORDS[rand(WORDS.length)]);
  return parts.join('') + ' sample' + rand(1000);
};

console.log('造数据: ' + SESSIONS + ' 会话 × ' + FRAMES + ' 帧 …');
const t0 = Date.now();
for (let i = 0; i < SESSIONS; i++) {
  const id = 'bench-' + i;
  s.create(ROOT, null, { id });
  for (let j = 0; j < FRAMES; j++) {
    s.append(id, j % 2 ? 'user' : 'assistant', { text: mkText() });
  }
}
const tBuild = Date.now() - t0;
const totalFrames = SESSIONS * (FRAMES + 1);
console.log('建完: ' + tBuild + 'ms，共 ' + totalFrames + ' 帧');

// 单会话检索
const ok = []; const bad = [];
const push = (n, c, e) => (c ? ok : bad).push((c ? '✓ ' : '✗ ') + n + (e ? '  → ' + e : ''));

const t1 = Date.now();
for (let k = 0; k < 20; k++) s.search('bench-' + rand(SESSIONS), WORDS[rand(WORDS.length)]);
const perSession = (Date.now() - t1) / 20;
push('单会话检索', true, perSession.toFixed(1) + 'ms/次（' + FRAMES + ' 帧）');

// 跨会话检索
const t2 = Date.now();
const hits = s.searchAll('传输层索引', 20);
const tAll = Date.now() - t2;
push('★ 跨会话检索', true, tAll + 'ms 扫 ' + SESSIONS + ' 会话 / ' + totalFrames + ' 帧，命中 ' + hits.length);

// 二次（文件系统缓存热）
const t3 = Date.now();
s.searchAll('传输层索引', 20);
const tAll2 = Date.now() - t3;
push('二次（缓存热）', true, tAll2 + 'ms');

// 推算：2188 个会话 / 5.5 万帧
const scale = 2188 / SESSIONS;
push('推算 2188 会话', true, '约 ' + Math.round(tAll2 * scale) + 'ms（按本机线性外推）');

console.log(''); console.log('=== 检索基准 ==='); console.log('');
console.log(ok.join('\n'));
if (bad.length) { console.log(''); console.log(bad.join('\n')); }
console.log('');

try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}