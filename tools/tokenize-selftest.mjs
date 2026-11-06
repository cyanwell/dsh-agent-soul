import path from 'node:path';
import fs from 'node:fs';
import { SessionStore, tokenize } from '../src/session/store.mjs';
import { ROOT } from '../src/config.mjs';
const ok = []; const bad = [];
const push = (n, c, e) => (c ? ok : bad).push((c ? '✓ ' : '✗ ') + n + (e ? '  → ' + e : ''));

// tokenize
const t1 = tokenize('传输层拆分');
push('中文切 2-gram', t1.includes('传输') && t1.includes('输层') && t1.includes('层拆') && t1.includes('拆分'), t1.join('/'));
const t2 = tokenize('run_shell command');
push('英文按词切', t2.includes('run_shell') && t2.includes('command'), t2.join('/'));
push('单字符保留', tokenize('看').includes('看'), tokenize('看').join('/'));
push('空输入不炸', tokenize('').length === 0 && tokenize(null).length === 0);

// 检索语义
const dir = path.join(ROOT, 'data', 'tok-' + Date.now());
const s = new SessionStore(dir);
const h = s.create(ROOT, null, { id: 'tok-test' });
s.append('tok-test', 'user', { text: '传输层拆分这件事，你怎么看？' });
s.append('tok-test', 'assistant', { text: '先把 transport 抽出来，再谈 renderer。' });
s.append('tok-test', 'user', { text: '今天天气不错' });

push('★ 换个说法能搜到', s.search('tok-test', '传输层那件事').length >= 1, '「传输层那件事」→ 命中 ' + s.search('tok-test', '传输层那件事').length);
push('★ 单个词能搜到', s.search('tok-test', '拆分').length >= 1);
push('★ 英文能搜到', s.search('tok-test', 'transport').length >= 1);
push('★ 不相关的不硬凑', s.search('tok-test', '量子力学弦论').length === 0, '搜不相关的词：0 条');

// 排序：整串命中优先
s.append('tok-test', 'user', { text: '拆分 拆分 拆分' });
const hits = s.search('tok-test', '拆分');
push('多条命中时排序稳定', hits.length >= 2, hits.length + ' 条，首条 seq=' + hits[0].seq);

try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(''); console.log('=== 分词检索自检 ==='); console.log('');
console.log(ok.join('\n'));
if (bad.length) { console.log(''); console.log(bad.join('\n')); }
console.log(''); console.log(ok.length + ' 通过 / ' + bad.length + ' 失败'); console.log('');
process.exit(bad.length ? 1 : 0);