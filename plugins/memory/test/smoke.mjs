// smoke.mjs —— 不等重启就验插件：用假 ctx 注册，再把 text() 直接调出来看。
// 验四件事：
//   ① 注册的 name / order 对不对；
//   ② 渲染出来的有没有【此刻】，且**每次调用时间在变**（证明是活函数不是快照）；
//   ③ SELF.md 全文进没进来；
//   ④ 分会话（假 parent）有没有被挡住；抛异常时会不会把回合搞炸。
import { apply, name, DEFAULTS } from '../lib/index.js';

let registered = null;
const fakeScope = {
  systemPrompt: {
    context(c) { registered = c; return () => {}; },
  },
};
const fakeCtx = {
  inject(services, cb) {
    if (!services.includes('systemPrompt')) throw new Error('注入的服务不对: ' + services);
    cb(fakeScope);
    return () => {};
  },
};

console.log(`插件名: ${name}`);
console.log(`默认值: ${JSON.stringify(DEFAULTS)}`);

apply(fakeCtx, {});

if (!registered) { console.error('✗ 没有注册任何 context'); process.exit(1); }
console.log(`✓ 注册成功: name=${registered.name}  order=${registered.order}  text 是函数? ${typeof registered.text === 'function'}`);

// ② 活时钟：调两次，间隔 1.1 秒，看秒数有没有变
const a = registered.text({});
await new Promise((r) => setTimeout(r, 1100));
const b = registered.text({});
const head = (s) => (s.split('\n')[0] || '');
console.log(`\n第一次: ${head(a)}`);
console.log(`第二次: ${head(b)}`);
const alive = head(a) !== head(b);
console.log(alive ? '✓ 时钟是活的（两次不同）' : '✗ 时钟是死的（两次一样）');

// ③ SELF 全文
const hasSelf = a.includes('SELF') || a.includes('我是谁');
console.log(`${hasSelf ? '✓' : '✗'} SELF.md 内容进来了（渲染 ${Buffer.byteLength(a, 'utf8')} B，${a.split('\n').length} 行）`);

// ④ 分会话应该被挡住
const child = registered.text({ agent: { parent: { id: 'x' } } });
console.log(`${child === '' ? '✓' : '✗'} 分会话被挡住（返回 ${JSON.stringify(child).slice(0, 30)}）`);

// ⑤ 极端：state.json 坏掉 / selfPath 不存在 —— 不许抛
const savedSelf = DEFAULTS.selfPath;
apply(fakeCtx, { selfPath: 'D:/definitely/not/here.md', statePath: 'D:/definitely/not/here.json' });
const c = registered.text({});
console.log(`\n路径全不存在时：\n  ${c.split('\n').slice(0, 3).join('\n  ')}`);
console.log('✓ 没有抛异常');

console.log(`\n—————— 真实渲染前 22 行 ——————`);
a.split('\n').slice(0, 22).forEach((l) => console.log('  ' + l));
process.exit(alive && hasSelf && child === '' ? 0 : 1);
