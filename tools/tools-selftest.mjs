// tools-selftest.mjs —— 三件小东西的自检（query / self / mnemon-probe）
//
// ★ 真跑，不 mock 关键件：账本是真文件，会话是真 SessionStore。
//   因为这三件的价值全在「读到的到底是不是原文 / 是不是那个文件」，
//   用假数据测等于把它们唯一会出错的地方跳过去。
//
// ★ 故意弄坏一项（任务要求）：self 那组里专门把 cfg.file 指到一个不存在的路径，
//   看它会不会正确报 MISSING —— 并且**不许**把三条判据报成通过。

import fs from 'node:fs';
import path from 'node:path';
import { SessionStore } from '../src/session/store.mjs';
import { Query } from '../src/tools/query.mjs';
import { checkSelf, splitLive } from '../src/tools/self.mjs';
import { MnemonProbe, countEntries, upsertProbeContext, DEFAULT_RUNTIME_DIR } from '../src/organs/mnemon-probe.mjs';

let pass = 0;
let fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
};

const ROOT = path.join('data', '.tools-selftest');
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

// ─────────────────────────────────────────────
console.log('\n=== ① Query —— 一扇门：指针 + 逐字片段 ===');

const LEDGER = path.join(ROOT, '墨.jsonl');
const rows = [
  { t: '2026-11-01T10:00:00+08:00', type: 'fact', by: 'test', text: '传输层拆分这件事，结论是先不动协议版本。' },
  { t: '2026-11-02T11:00:00+08:00', type: 'promise', by: 'test', text: '我承诺把换气阈值从 0.5 改到 3 次连击。', feel: '有点舍不得旧阈值。' },
  { t: '2026-11-03T12:00:00+08:00', type: 'shelved', by: 'test', text: '微信桥接先搁置：本地库加密，硬限制。' },
];
fs.writeFileSync(LEDGER, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

const sd = path.join(ROOT, 'storedata');
const store = new SessionStore(sd);
const s1 = store.create('D:/tmp', null).id;
store.append(s1, 'user', { text: '索引应该已经出现了：写入即索引。' });
store.append(s1, 'assistant', { text: '回应：检索命中的那条要带门牌。' });

const q = new Query(store, LEDGER);

{
  const r = q.search('换气');
  t('账本命中 1 条', r.ok && r.total === 1, 'total=' + r.total);
  t('指针是 墨:<行号>', r.hits[0] && r.hits[0].ptr === '墨:2', r.hits[0] && r.hits[0].ptr);
  t('片段里有那个词', r.hits[0] && r.hits[0].snippet.includes('换气'), r.hits[0] && r.hits[0].snippet);
  const bare = r.hits[0].snippet.replace(/^…/, '').replace(/…$/, '');
  t('★ 片段是原文的连续子串（不是转述）', rows[1].text.includes(bare));
  t('行级字段跟着回来（ref/feel）', r.hits[0].feel === '有点舍不得旧阈值。');
}

{
  const r = q.search(['微信', '硬限制']);
  t('多词 = AND，命中第 3 行', r.ok && r.total === 1 && r.hits[0].ptr === '墨:3', r.hits[0] && r.hits[0].ptr);
  const r2 = q.search(['微信', '传输层']);
  t('★ 两个词不在同一条 → 0 条（不是 OR）', r2.ok && r2.total === 0);
}

{
  const r = q.search('门牌');
  const hit = r.hits.find((h) => h.layer === 'log');
  t('会话层命中（真 SessionStore）', Boolean(hit), hit && hit.ptr);
  t('指针是 log:<会话>#seq=<n>', hit && hit.ptr === 'log:' + s1 + '#seq=2', hit && hit.ptr);
  const o = q.open(hit.ptr);
  t('open(指针) 回原文', o.ok && o.text.includes('门牌'), o.ok ? o.text.slice(0, 20) : o.code);
}

{
  const o = q.open('墨:2');
  t('open 账本指针 → 原文一字不差', o.ok && o.text === rows[1].text);
  t('open 带上 type / when', o.ok && o.type === 'promise' && o.when === rows[1].t);
}

{
  const r = q.search('绝对不存在的词-zzz');
  t('没命中：ok 仍为 true（是「没搜到」，不是错误）', r.ok === true && r.total === 0);
  t('没命中时给下一步', /connected/.test(r.hint), r.hint);
}

{
  const r = q.search('');
  t('空词 → NO_TERMS', r.ok === false && r.code === 'NO_TERMS');
  const noSrc = new Query(null, null).search('任何');
  t('一个源都没接 → NO_SOURCE', noSrc.ok === false && noSrc.code === 'NO_SOURCE');
  t('★ 且说清「不是没搜到」', noSrc.hint.includes('不是「没搜到」'));
}

{
  const bad = new Query(store, [1, 2, 3]).coverage();
  t('数组账本源被拒（没有稳定行号）', bad.ledger === false && /不接受数组/.test(bad.ledgerError), bad.ledgerError);
  const o = q.open('墨:99');
  t('open 不猜：不存在的行 → NO_SUCH_LINE', o.ok === false && o.code === 'NO_SUCH_LINE');
  const o2 = q.open('胡说八道');
  t('认不出的指针 → BAD_PTR', o2.ok === false && o2.code === 'BAD_PTR');
}

{
  const n = q.now();
  t('now() 有账本读数', n.ledger && n.ledger.total === 3 && n.ledger.open === 2, JSON.stringify(n.ledger && [n.ledger.total, n.ledger.open]));
  t('now() 里最近一条带指针', n.ledger.last && n.ledger.last.ptr === '墨:3', n.ledger.last && n.ledger.last.ptr);
}

{
  const cov = q.coverage();
  t('coverage 如实报书房没接（不假装搜过）', cov.soul === false && /盲区/.test(cov.soulNote));
}

// ─────────────────────────────────────────────
console.log('\n=== ② checkSelf —— 三条判据 + 读不到要报出来 ===');

const good = path.join(ROOT, 'SELF-good.md');
fs.writeFileSync(good, [
  '# SELF · 测试',
  '',
  '## 我是谁',
  '- 名字：砚青。',
  '- 判据：本会话是不是最后一条 lead 的署名者。',
  '',
  '## 活体（自动生成）',
  '',
  '- 装配时刻：2026-11-07T03:00:00+08:00',
  '- 未结：0 条',
  '',
].join('\n'), 'utf8');

{
  const r = checkSelf({ file: good, budget: 12288 });
  t('好文件 → 三条全过', r.ok === true && r.code === 'OK', 'bytes=' + r.bytes + ' pct=' + r.pct);
  t('checks 有 4 项（含「读到了」）', r.checks.length === 4, r.checks.map((c) => c.id).join(','));
  t('每项都说清为什么', r.checks.every((c) => c.why && c.why.length > 5));
}

{
  // ★ 任务点名的那一项：故意指向不存在的文件
  const r = checkSelf({ file: path.join(ROOT, '这一页不存在.md') });
  t('★ 文件不存在 → MISSING（不是「通过」）', r.ok === false && r.code === 'MISSING');
  t('★ 三条判据标成 skipped（没检查 ≠ 通过）', r.skipped.length === 3, r.skipped.join(','));
  t('hint 说清下一步', /先写一页/.test(r.hint), r.hint.slice(0, 24));
}

{
  const r = checkSelf({ file: path.join(ROOT, 'SELF-good.md'), budget: 50 });
  t('超预算 → budget 判据 fail', r.ok === false && r.failed.includes('budget'), r.pct + '%');
  t('超预算理由写清「截得无声」', r.checks.find((c) => c.id === 'budget').why.includes('无声'));
}

{
  const bad = path.join(ROOT, 'SELF-link.md');
  fs.writeFileSync(bad, '# SELF\n\n- 硬线详见 AGENTS.md。\n\n## 活体（自动生成）\n- x\n', 'utf8');
  const r = checkSelf({ file: bad });
  t('外链指向 → links fail', r.ok === false && r.failed.includes('links'));
  t('指出第几行', r.checks.find((c) => c.id === 'links').detail[0] === '3: - 硬线详见 AGENTS.md。',
    r.checks.find((c) => c.id === 'links').detail[0]);
}

{
  const noLive = path.join(ROOT, 'SELF-nolive.md');
  fs.writeFileSync(noLive, '# SELF\n\n- 没有活体段。\n', 'utf8');
  const r1 = checkSelf({ file: noLive });
  t('缺「## 活体」→ live fail', r1.ok === false && r1.failed.includes('live'));

  const fakeLive = path.join(ROOT, 'SELF-fakelive.md');
  // ★ 这一段故意**不含**「自动生成」四个字 —— 判据找的就是它
  fs.writeFileSync(fakeLive, '# SELF\n\n## 活体\n\n- 装配时刻：2026-11-07T03:00:00+08:00（手抄）\n', 'utf8');
  const r2 = checkSelf({ file: fakeLive });
  t('活体段没标「自动生成」→ live fail', r2.ok === false && r2.failed.includes('live'));
  t('理由说清「和事实不一致时你不会知道」', r2.checks.find((c) => c.id === 'live').why.includes('不会知道'));
}

{
  const sp = splitLive('# a\n\n## 活体\n\n- b\n');
  t('splitLive 切得开', sp.bone.includes('# a') && sp.live.startsWith('## 活体') && !sp.bone.includes('活体'));
}

// ─────────────────────────────────────────────
console.log('\n=== ③ MnemonProbe —— 没有文件 vs 有文件 ===');

const emptyDir = path.join(ROOT, 'mnemon-none');
{
  const p = new MnemonProbe(emptyDir);
  const m = p.measure();
  t('目录不存在 → ok:false / MISSING', m.ok === false && m.code === 'MISSING');
  t('★ 读不到不许报「快满了」：hot=false', m.hot === false);
  t('聚合读数全 0，但 budget 还在', m.entries === 0 && m.bytes === 0 && m.pct === 0 && m.budget === 14336,
    JSON.stringify({ entries: m.entries, bytes: m.bytes, pct: m.pct, budget: m.budget }));
  t('hint 说清「不是快满了」', m.hint.includes('不是「快满了」'), m.hint.slice(0, 30));
  t('dirSource 标出这是配置给的路径', m.dirSource === 'config', m.dirSource);
  t('★ 做不到的那一半：injected 是 null，不编数', m.injected === null && /拿不到/.test(m.injectedNote));
  const txt = p.render(m);
  t('render 里也说「读不到」', txt.includes('读不到'), txt.split('\n')[0]);
}

const dir2 = path.join(ROOT, 'mnemon-ok');
fs.mkdirSync(dir2, { recursive: true });
{
  const p0 = new MnemonProbe(dir2);
  const m0 = p0.measure();
  t('目录在但没有文件 → NO_FILES（不是 MISSING）', m0.ok === false && m0.code === 'NO_FILES', m0.code);
}

const MEM = ['条目一：身份', '§', '条目二：硬线', '§', '条目三：门'].join('\n');
const USER = ['画像一：爀曦', '§', '画像二：偏好'].join('\n');
fs.writeFileSync(path.join(dir2, 'MEMORY.md'), MEM, 'utf8');
fs.writeFileSync(path.join(dir2, 'USER.md'), USER, 'utf8');

{
  const p = new MnemonProbe(dir2);
  const m = p.measure();
  const bytes = Buffer.byteLength(MEM, 'utf8') + Buffer.byteLength(USER, 'utf8');
  t('有文件 → ok:true / code OK', m.ok === true && m.code === 'OK', m.code);
  t('条目数用 § 分隔数（3 + 2 = 5）', m.entries === 5, 'entries=' + m.entries);
  t('bytes = 两文件字节和', m.bytes === bytes, m.bytes + ' / ' + bytes);
  t('pct = bytes / 14336', m.pct === Math.round((bytes / 14336) * 100), m.pct + '%');
  t('任务要的 {entries, bytes, budget, pct} 四个都在', ['entries', 'bytes', 'budget', 'pct'].every((k) => typeof m[k] === 'number'));
  t('每个文件各有一列（看得出是谁满）', m.files['MEMORY.md'].entries === 3 && m.files['USER.md'].entries === 2);
  t('hot=false（字节还远）', m.hot === false);
  const txt = p.render(m);
  t('render 带上两个文件读数', txt.includes('MEMORY 3条') && txt.includes('USER 2条'), txt.split('\n')[0]);
  t('render 注明目录来源（路径找错要能看见）', txt.includes('来源 config'), txt.split('\n')[3]);
}

{
  const big = 'x'.repeat(8500);
  fs.writeFileSync(path.join(dir2, 'MEMORY.md'), big, 'utf8');
  const m = new MnemonProbe(dir2).measure();
  t('MEMORY 83% → hot=true', m.hot === true, m.files['MEMORY.md'].pct + '%');
  t('tag 是「⚠接近上限」', m.files['MEMORY.md'].tag === '⚠接近上限', m.files['MEMORY.md'].tag);
  t('提醒里指向 mem-doctor', m.hint.includes('mem-doctor.py'));

  fs.writeFileSync(path.join(dir2, 'MEMORY.md'), 'y'.repeat(9500), 'utf8');
  const m2 = new MnemonProbe(dir2).measure();
  t('MEMORY 93% → ★已到上限', m2.files['MEMORY.md'].tag === '★已到上限', m2.files['MEMORY.md'].pct + '%');
}

{
  const old = process.env.MNEMON_RUNTIME;
  delete process.env.MNEMON_RUNTIME;
  const a = new MnemonProbe(undefined);
  t('不传 dir → 默认 ~/.mnemon/runtime', a.dir === DEFAULT_RUNTIME_DIR && a.dirSource === 'default', a.dir);
  process.env.MNEMON_RUNTIME = dir2;
  const b = new MnemonProbe(undefined);
  t('环境变量 MNEMON_RUNTIME 兼容老版口径', b.dir === dir2 && b.dirSource === 'env', b.dirSource);
  if (old === undefined) delete process.env.MNEMON_RUNTIME; else process.env.MNEMON_RUNTIME = old;
}

{
  const one = upsertProbeContext([], '第一段');
  const two = upsertProbeContext(one, '第二段');
  const three = upsertProbeContext(two, '第三段');
  t('★ 幂等：连调三次只剩一份', three.length === 1, 'len=' + three.length);
  t('留下的是最新那段', three[0].text === '第三段' && three[0].name === 'mnemon-projection-probe');
  const withOther = upsertProbeContext([{ name: '别的', text: 'x' }], '探针');
  t('不误删别人的 context', withOther.length === 2 && withOther[0].name === '别的');
}

{
  t('countEntries 空 → 0', countEntries('') === 0 && countEntries('   ') === 0);
  t('countEntries 单条 → 1', countEntries('只有一条') === 1);
  t('countEntries 带空白行的 § 也切得开', countEntries('a\n  §  \nb\n§\nc') === 3);
}

fs.rmSync(ROOT, { recursive: true, force: true });
console.log('\n' + (fail === 0 ? '全部通过' : '失败 ' + fail) + '：' + pass + ' 通过 / ' + fail + ' 失败');
console.log('');
process.exit(fail ? 1 : 0);
