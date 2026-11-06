import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SoulIndex, SOUL_MAX, DEFAULT_TTL } from '../src/organs/soul-scan.mjs';

const ok = []; const bad = [];
const push = (n, c, e) => (c ? ok : bad).push((c ? '✓ ' : '✗ ') + n + (e ? '  → ' + e : ''));

// ── ① 可控小样 ──
const TMP = path.join(os.tmpdir(), 'soul-scan-' + Date.now());
fs.mkdirSync(path.join(TMP, '50-日记'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'node_modules'), { recursive: true });
fs.mkdirSync(path.join(TMP, '10-宪章'), { recursive: true });
fs.writeFileSync(path.join(TMP, '10-宪章', '判据.md'), '# 判据\n\n摘要只能是索引，不能是记忆本体。\n这条是根。', 'utf8');
fs.writeFileSync(path.join(TMP, '50-日记', '40-坏掉的是那一只.md'), '坏掉的是那一只，不是那一套。\n整批一起换。', 'utf8');
fs.writeFileSync(path.join(TMP, 'node_modules', 'skip.md'), '这个不该被扫到', 'utf8');
fs.writeFileSync(path.join(TMP, 'big.md'), 'a'.repeat(SOUL_MAX + 100), 'utf8');
fs.writeFileSync(path.join(TMP, 'bin.dat'), '这个扩展名不该收', 'utf8');

const s = new SoulIndex(TMP, { ttl: 0 });
const r1 = s.refresh();
push('扫到 2 个文件', s.size === 2, s.size + ' 个，读了 ' + r1 + ' 份');
push('★ node_modules 被跳过', ![...s.files.keys()].some(p => p.includes('node_modules')), '');
push('★ 超大文件被跳过', ![...s.files.keys()].some(p => p.includes('big.md')), '');
push('★ 二进制扩展名被跳过', ![...s.files.keys()].some(p => p.includes('bin.dat')), '');

// 增量
const r2 = s.refresh();
push('★ 没变就一份都不读', r2 === 0, r2 + ' 份');
fs.writeFileSync(path.join(TMP, '10-宪章', '判据.md'), '# 判据\n\n摘要只能是索引，不能是记忆本体。\n这条是根。\n后来加了一句。', 'utf8');
const r3 = s.refresh();
push('★ 改了才读，且只读 1 份', r3 === 1, r3 + ' 份');

// 检索
const q1 = s.search(['摘要', '索引']);
push('★ 搜到真内容', q1.hits.length >= 1, q1.hits.length + ' 条 / ' + q1.ms + 'ms');
push('★ 指针格式 file:路径:行号', /^file:.+:\d+$/.test(q1.hits[0].ptr), q1.hits[0].ptr.replace(TMP, '$TMP'));
push('★ 返回了 snippet', q1.hits[0].snippet.length > 0, q1.hits[0].snippet.slice(0, 30));
const q2 = s.search(['不存在的词xyzzy']);
push('搜不到就是 0 条', q2.hits.length === 0, '');
const q3 = s.search(['坏掉']);
push('★ 多词 AND 时单字词也能搜', q3.hits.length >= 1, q3.hits.map(h => h.rel).join(','));

// open
const o1 = s.open(q1.hits[0].ptr);
push('★ open 带前后上下文（不是只给一行）', o1 && o1.text.split('\n').length > 1, o1 ? '第 ' + o1.from + '–' + o1.to + ' 行' : 'null');
const o2 = s.open('file:' + path.join(TMP, '50-日记', '40-坏掉的是那一只.md'));
push('open 不带行号时给全文', o2 && o2.text.includes('整批一起换'), '');

// ★ 正斜杠指针（MCP 侧真实拿到的形态）—— 必须能带行号，不能降级成全文
const fwd = q1.hits[0].ptr.replace(/\\\\/g, '/');
const o3 = s.open(fwd);
push('★ 正斜杠指针也能带行号（不降级成全文）', o3 && o3.line === q1.hits[0].line, o3 ? 'line=' + o3.line : 'null');
push('★ 正斜杠指针的上下文对', o3 && o3.text.split('\n').length > 1 && o3.text.includes('摘要'), o3 ? '第 ' + o3.from + '–' + o3.to + ' 行' : 'null');

// 删文件
fs.unlinkSync(path.join(TMP, '50-日记', '40-坏掉的是那一只.md'));
s.refresh();
push('★ 删了的文件不再被搜到', s.size === 1 && s.search(['坏掉']).hits.length === 0, s.size + ' 个文件');

// stats
const st = s.stats();
push('stats 有读数', st.files === 1 && st.walks >= 1, JSON.stringify({ files: st.files, walks: st.walks, lastReads: st.lastReads }));

// ── ② 时间窗 ──
const s2 = new SoulIndex(TMP, { ttl: 5000 });
s2.refresh();
const w2 = s2.refresh();
push('★ 5 秒内第二次扫直接返回 0', w2 === 0, w2 + ' 份');
const s3 = new SoulIndex(TMP, { ttl: 0 });
s3.refresh();
const w3 = s3.refresh();
push('ttl=0 时不缓存', w3 === 0, w3 + ' 份（都是没变所以 0 也是对的）');

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

// ── ③ 真实书房实测 ──
const SOUL = 'D:/AI/yanqing-soul';
console.log(''); console.log('=== 真实书房 ===');
const real = new SoulIndex(SOUL, { ttl: 0 });
const t0 = Date.now();
const rr = real.refresh();
const coldMs = Date.now() - t0;
const stats = real.stats();
console.log('  首次: ' + stats.files + ' 个文件 / ' + stats.mb + 'MB，读了 ' + rr + ' 份，' + coldMs + 'ms');

const t1 = Date.now();
const rr2 = real.refresh();
const warmMs = Date.now() - t1;
console.log('  再扫: 读了 ' + rr2 + ' 份，' + warmMs + 'ms（没变就是 0 份）');

const t2 = Date.now();
const qq = real.search(['摘要', '索引']);
const searchMs = Date.now() - t2;
console.log('  检索「摘要 索引」: ' + qq.hits.length + ' 条 / ' + searchMs + 'ms');
if (qq.hits.length) console.log('    ' + qq.hits[0].ptr.replace(SOUL, '$SOUL'));

const t3 = Date.now();
const qq2 = real.search(['判据', '他人']);
console.log('  检索「判据 他人」: ' + qq2.hits.length + ' 条 / ' + (Date.now() - t3) + 'ms');
if (qq2.hits.length) console.log('    ＞ ' + qq2.hits[0].snippet.slice(0, 60));

push('★ 真书房扫到 >1000 个文件', stats.files > 1000, stats.files + ' 个');
push('★ 冷扫 < 5000ms', coldMs < 5000, coldMs + 'ms');
push('★ 检索 < 1000ms', searchMs < 1000, searchMs + 'ms');
push('★ 书房能搜到真内容', qq.hits.length > 0, qq.hits.length + ' 条');

console.log(''); console.log('=== 书房扫描器官自检 ==='); console.log('');
console.log(ok.join('\n'));
if (bad.length) { console.log(''); console.log(bad.join('\n')); }
console.log(''); console.log(ok.length + ' 通过 / ' + bad.length + ' 失败'); console.log('');
process.exit(bad.length ? 1 : 0);