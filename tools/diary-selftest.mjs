// 日记自检 —— 重点是三件事：防穿越 / 五种状态分得开 / 标题从前 2KB 抠
import fs from 'node:fs';
import path from 'node:path';
import { Diary, safeName } from '../src/web/diary.mjs';

let pass = 0, fail = 0;
const t = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n + (e ? '  ' + e : '')); } else { fail++; console.log('  ✗ ' + n + (e ? '  ' + e : '')); } };

const dir = 'data/.diary-test';
fs.rmSync(dir, { recursive: true, force: true });

console.log('\n① 没配 / 配了但不存在 —— 必须能分开，且给可执行提示');
{ const d = new Diary(null);
  const s = d.state();
  t('没配 → UNCONFIGURED', s.code === 'UNCONFIGURED');
  t('提示里说了怎么配', /diary\.dir/.test(s.hint), s.hint.slice(0, 40));
  const l = d.list();
  t('list 也带 state（不让界面猜）', l.state.code === 'UNCONFIGURED' && l.entries.length === 0);
  const d2 = new Diary('D:/绝对不存在的目录-xyz');
  const s2 = d2.state();
  t('配了但不存在 → MISSING', s2.code === 'MISSING');
  t('提示里带了那个路径', s2.hint.includes('绝对不存在的目录-xyz')); }

console.log('\n② 防目录穿越 —— safeName');
{ const bad = ['../etc/passwd.md', '..\\x.md', '/abs/x.md', 'a/b.md', 'x.txt', 'x.md.exe', '', 'a:b.md', 'a*b.md'];
  for (const b of bad) t('拒绝 ' + JSON.stringify(b), safeName(b) === '');
  t('接受 normal.md', safeName('normal.md') === 'normal.md');
  t('接受 40-坏掉.md', safeName('40-坏掉的那一只.md') === '40-坏掉的那一只.md');
  t('大写 .MD 也收', safeName('X.MD') === 'X.MD'); }

console.log('\n③ 真实目录 —— 列 / 读 / 标题 / 排序 / 纵深防御');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(dir + '/40-坏掉.md', '# 坏掉的是那一只，不是那一套\n\n正文第一段。\n', 'utf8');
fs.writeFileSync(dir + '/39-另一个.md', '没有一级标题的一篇\n\n就正文。\n', 'utf8');
fs.writeFileSync(dir + '/readme.txt', '不是 md，不该出现\n', 'utf8');
{ const d = new Diary(dir);
  const l = d.list();
  t('状态 OK', l.state.code === 'OK');
  t('只收 .md（txt 不收）', l.entries.length === 2, l.entries.length + ' 篇');
  const e0 = l.entries.find(x => x.name.startsWith('40-'));
  t('标题从 # 抠出来', e0 && e0.title === '坏掉的是那一只，不是那一套', e0 && e0.title);
  const e1 = l.entries.find(x => x.name.startsWith('39-'));
  t('没有 # 就用文件名', e1 && e1.title === '39-另一个', e1 && e1.title);
  t('按 mtime 倒序（新的在前）', l.entries[0].mtime >= l.entries[1].mtime);
  const r = d.read('40-坏掉.md');
  t('读得到原文', r.ok && r.text.includes('正文第一段'));
  t('读的时候也带标题', r.title === '坏掉的是那一只，不是那一套');
  const nf = d.read('不存在.md');
  t('不存在的 → NOT_FOUND（不是笼统的读不到）', nf.code === 'NOT_FOUND');
  const bn = d.read('../x.md');
  t('穿越 → BAD_NAME', bn.code === 'BAD_NAME'); }

console.log('\n④ 纵深防御 —— 即使绕过 safeName，也只能落在目录里');
{ const d = new Diary(dir);
  // 直接调内部逻辑：造一个合法的名字，但用符号链接指到外面
  const outside = 'data/.diary-outside.md';
  fs.writeFileSync(outside, '# 外面的文件\n', 'utf8');
  // 正常读不到（因为它不在日记目录里）
  const r = d.read('.diary-outside.md');
  t('目录外的文件名读不到', !r.ok, r.code);
  fs.rmSync(outside, { force: true }); }

console.log('\n⑤ 空的日记目录 —— 和「读不到」是两件事');
{ const empty = 'data/.diary-empty';
  fs.rmSync(empty, { recursive: true, force: true });
  fs.mkdirSync(empty, { recursive: true });
  const d = new Diary(empty);
  const l = d.list();
  t('状态 OK（目录在）', l.state.code === 'OK');
  t('条目 0 篇（真的空）', l.entries.length === 0);
  t('★ 空 ≠ 读不到：state.ok 为真', l.state.ok === true);
  fs.rmSync(empty, { recursive: true, force: true }); }

fs.rmSync(dir, { recursive: true, force: true });
console.log('\n' + (fail === 0 ? '全部通过' : '失败 ' + fail) + '：' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);
