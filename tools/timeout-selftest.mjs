// 超时自检 —— 「工具不返回」这一条以前会让整条回合永远不返回
import { ToolRegistry } from '../src/tools/registry.mjs';
import { withTimeout } from '../src/util/timeout.mjs';

let pass = 0, fail = 0;
const t = (n, c, extra) => { if (c) { pass++; console.log('  ✓ ' + n + (extra ? '  ' + extra : '')); } else { fail++; console.log('  ✗ ' + n + (extra ? '  ' + extra : '')); } };

const r = new ToolRegistry();
r.register({ name: 'fast', handler: async () => '好的' });
r.register({ name: 'never', handler: () => new Promise(() => {}) });
r.register({ name: 'own', handler: async () => '自己的时限', timeoutMs: 5000 });
r.register({ name: 'boom', handler: async () => { throw new Error('炸了'); } });

console.log('\n① 正常调用');
{ const x = await r.execute('fast', {}); t('ok', x.ok === true); t('内容', x.content === '好的'); t('timeout 标记是 false', x.timeout === false); }

console.log('\n② 永不返回的 handler（原来会挂死）');
r.defaultTimeoutMs = 120;
{ const tt = Date.now(); const x = await r.execute('never', {}); const ms = Date.now() - tt;
  t('不再挂死', ms < 2000, ms + 'ms');
  t('timeout=true', x.timeout === true);
  t('ok=false', x.ok === false);
  t('说清「还在后台跑」', String(x.error).includes('后台'));
  t('错误码 TIMEOUT 进日志', r.log[r.log.length-1].timeout === true); }

console.log('\n③ 工具自己定的时限优先');
{ const x = await r.execute('own', {}); t('自己的 5s 生效，不是 120ms', x.ok === true && x.content === '自己的时限'); }

console.log('\n④ 抛错照常，不被误判成超时');
{ const x = await r.execute('boom', {}); t('ok=false', x.ok === false); t('不是 timeout', x.timeout === false); t('错误原文', x.error === '炸了'); }

console.log('\n⑤ timeoutMs=0 表示不设限');
{ const v = await withTimeout(Promise.resolve(1), 0, 'x'); t('不设限', v === 1); }

console.log('\n⑥ 守卫仍然只否决、不放行');
{ r.guard((e) => e.name === 'fast' ? '不许' : undefined);
  const x = await r.execute('fast', {}); t('否决', x.denied === true); t('原话理由是「不许」', x.reason === '不许');
  const y = await r.execute('boom', {}); t('无关工具不受影响', y.ok === false && y.timeout === false); }

console.log('\n⑦ 超时后进程仍能做别的事（race 只放弃等待，不冻住）');
// ★ 用 own 而不是 fast —— fast 在第⑥段被守卫拦了，用它验不出「还能继续」
{ const x = await r.execute('never', {}); const y = await r.execute('own', {});
  t('超时之后还能继续', x.timeout === true && y.ok === true);
  t('继续的那个拿到正常结果', y.content === '自己的时限'); }

console.log('\n' + (fail === 0 ? '全部通过' : '失败 ' + fail) + '：' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);
