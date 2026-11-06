// 账本自检 —— 重点是那道闸门：器官写 promise 必须写不进去
import fs from 'node:fs';
import path from 'node:path';
import { LedgerBase, TYPES, LABEL, normId, localIso, BRAIN_ONLY } from '../src/organs/ledger.mjs';

let pass = 0, fail = 0;
const t = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n + (e ? '  ' + e : '')); } else { fail++; console.log('  ✗ ' + n + (e ? '  ' + e : '')); } };

const dir = 'data/.ledger-test';
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, 'ledger.jsonl');
const L = new LedgerBase(file);

console.log('\n① 空账本');
{ const st = L.stats(); t('0 条', st.total === 0); t('没有主导', st.lead === null); t('八类都在（含 lead）', TYPES.length === 8, TYPES.join('/')); }

console.log('\n② 器官写事实 —— 允许');
{ const r = L.write({ type: 'fact', text: '换气器官接到新运行时上了', by: 'session-aaaa1111' });
  t('写入成功', r.ok === true);
  t('落盘了', fs.existsSync(file));
  const raw = fs.readFileSync(file, 'utf8').trim();
  const row = JSON.parse(raw);
  t('type 对', row.type === 'fact');
  t('by 原样保留', row.by === 'session-aaaa1111');
  t('t 是带时区的 ISO', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(row.t), row.t); }

console.log('\n③ ★ 器官写承诺 —— 必须被拒（这是整件事的重点）');
{ const r = L.write({ type: 'promise', text: '我保证三天内交付', by: 'session-aaaa1111' });
  t('被拒绝', r.ok === false);
  t('原因是 NOT_BRAIN', r.code === 'NOT_BRAIN');
  t('理由里说清谁才是主导', String(r.message).includes('主导'));
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').length;
  t('账本没多出行（拒绝 = 真的没写）', lines === 1, lines + ' 行'); }

console.log('\n④ 写一条 lead，它就变成主导');
{ const r = L.write({ type: 'lead', text: '第 1 代 · 接手于 2026-11-07', by: 'session-bbbb2222' });
  t('lead 写入成功', r.ok === true);
  t('currentLead = bbbb2222', normId(L.currentLead()) === 'bbbb2222', L.currentLead());
  t('它现在是脑', L.isBrain('session-bbbb2222') === true);
  t('aaaa1111 不是脑', L.isBrain('session-aaaa1111') === false); }

console.log('\n⑤ 脑写承诺 —— 允许');
{ const r = L.write({ type: 'promise', text: 'v4 发布前把配置路径改对', by: 'session-bbbb2222', ref: 'docs/UI.md' });
  t('写入成功', r.ok === true);
  t('ref 存下来了', r.row.ref === 'docs/UI.md'); }

console.log('\n⑥ 两种 id 格式都能认（老项目踩过的坑）');
{ L.write({ type: 'lead', text: '第 2 代', by: 'cccc3333-9999-8888-7777-6666' });
  t('无前缀 id 能当主导', L.isBrain('session-cccc3333') === true);
  t('带前缀 id 也认', L.isBrain('cccc3333-1111-2222') === true);
  t('归一化把两种写法变一样', normId('session-cccc3333-x') === normId('cccc3333-y')); }

console.log('\n⑦ 别的基本功');
{ t('空内容被拒', L.write({ type: 'fact', text: '   ', by: 'x' }).code === 'EMPTY');
  t('未知类型被拒', L.write({ type: 'nope', text: 'x', by: 'x' }).code === 'BAD_TYPE');
  t('没有署名被拒', L.write({ type: 'fact', text: 'x', by: '' }).code === 'NO_AUTHOR');
  t('feel 可选且能存', L.write({ type: 'fact', text: '有感觉的一条', by: 'x', feel: '有点舍不得' }).row.feel === '有点舍不得'); }

console.log('\n⑧ 读：list / stats');
{ const st = L.stats();
  t('总数对得上', st.total === 5, st.total + ' 条');
  t('按类型计数', st.byType.fact === 2 && st.byType.lead === 2 && st.byType.promise === 1);
  const leads = L.list({ type: 'lead' });
  t('过滤到 2 条 lead', leads.length === 2);
  t('倒序（最新的在前）', leads[0].text === '第 2 代', leads[0].text);
  t('limit 生效', L.list({ limit: 2 }).length === 2); }

console.log('\n⑨ 只追加：文件只变长，从不重写');
{ const before = fs.readFileSync(file, 'utf8');
  L.write({ type: 'gain', text: '多了点东西', by: 'x' });
  const after = fs.readFileSync(file, 'utf8');
  t('旧内容一字没动', after.startsWith(before));
  t('真的变长了', after.length > before.length); }

console.log('\n⑩ 坏行不该让整个账本读不出来');
{ fs.appendFileSync(file, 'this is not json\n', 'utf8');
  const rows = L.all();
  t('坏行被跳过，好行还在', rows.length === 6, rows.length + ' 行'); }

fs.rmSync(dir, { recursive: true, force: true });
console.log('\n' + (fail === 0 ? '全部通过' : '失败 ' + fail) + '：' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);
