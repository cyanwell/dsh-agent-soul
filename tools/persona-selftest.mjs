import { PersonaLayer, TIER } from '../src/persona/layer.mjs';
const ok = []; const bad = [];
const push = (n, c, e) => (c ? ok : bad).push((c ? '✓ ' : '✗ ') + n + (e ? '  → ' + e : ''));

const FILES = [
  { path: 'D:/AI/memory/hub/SELF.md', tier: TIER.CORE, name: 'SELF' },
  { path: 'D:/AI/dsh/home/AGENTS.md', tier: TIER.WORK, name: 'AGENTS全局' },
  { path: 'D:/AI/yanqing-soul/AGENTS.md', tier: TIER.WORK, name: 'AGENTS工作区' },
  { path: 'D:/不存在的文件.md', tier: TIER.CONTEXT, name: '缺失的' },
];

// —— 场景 A：默认预算（80000，足够装下真实人格） ——
const a = new PersonaLayer();
const ra = a.load(FILES);
push('装载', ra.loaded >= 2, '装载 ' + ra.loaded + '，缺 ' + ra.missing.length);
push('缺失文件不报错', ra.missing.length === 1);
const sa = a.stats();
push('分层统计', Boolean(sa.core), Object.keys(sa).map(k => k + ':' + sa[k].files + '个/' + sa[k].bytes + 'B').join('  '));
const oa = a.render();
push('默认预算装下全部', oa.dropped.length === 0, oa.used + 'B / ' + oa.budget + 'B');
push('不变量标签', oa.text.includes('永不裁剪'));
push('工作约定标签', oa.text.includes('可压缩'));

// —— 场景 B：小预算（3000，强制裁剪） ——
const b = new PersonaLayer({ budget: 3000 });
b.load(FILES);
const ob = b.render();
push('超预算 CORE 仍保留', ob.text.includes('SELF'), 'CORE 不被裁');
push('超预算 WORK 被裁', ob.dropped.includes('AGENTS全局'), '裁掉: ' + ob.dropped.join(', '));
push('★ 裁剪写进正文（不静默）', ob.text.includes('裁剪记录'));
push('★ 说明「不是不存在」', ob.text.includes('不是「它们不存在」'));

// —— 场景 C：只有 CORE，永远不裁 ——
const c = new PersonaLayer({ budget: 100 });
c.load([FILES[0]]);
const oc = c.render();
push('预算 100 时 CORE 也不裁', oc.text.includes('SELF'), '装进来 ' + oc.used + 'B（超预算 ' + (oc.used - 100) + 'B 仍然保留）');

console.log(''); console.log('=== 人格层自检 ==='); console.log('');
console.log(ok.join('\n'));
if (bad.length) { console.log(''); console.log(bad.join('\n')); }
console.log(''); console.log(ok.length + ' 通过 / ' + bad.length + ' 失败'); console.log('');
process.exit(bad.length ? 1 : 0);