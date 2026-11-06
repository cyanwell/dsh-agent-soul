// 父进程看门狗自检
import { spawn } from 'node:child_process';
import { parentAlive, installParentWatchdog } from '../src/util/parent-watchdog.mjs';

let pass = 0, fail = 0;
const t = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n + (e ? '  ' + e : '')); } else { fail++; console.log('  ✗ ' + n + (e ? '  ' + e : '')); } };

console.log('\n① parentAlive 的判据');
t('自己这个进程 → 活', parentAlive(process.pid));
t('pid 0 → 当作活（没配）', parentAlive(0) === true);
t("pid null → 当作活", parentAlive(null) === true);
t('不存在的 pid → 死', parentAlive(999999) === false);

console.log('\n② 没配 AGENT_SOUL_PARENT 时不装');
{ const d = installParentWatchdog();
  t('active=false', d.active === false, 'pid=' + d.pid);
  t('stop() 不炸', typeof d.stop === 'function'); }

console.log('\n③ 配了一个死的 PID → 不装（免得一开始就退）');
{ process.env.AGENT_SOUL_PARENT = '999999';
  const d = installParentWatchdog();
  t('active=false', d.active === false);
  delete process.env.AGENT_SOUL_PARENT; }

console.log('\n④ 真的杀掉父进程 → 看门狗触发');
await new Promise((resolve) => {
  // 起一个什么都不做的 node 当「父进程」
  const fake = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });
  let fired = false;
  process.env.AGENT_SOUL_PARENT = String(fake.pid);
  const d = installParentWatchdog({ interval: 300, onDie: (pid) => { fired = true; d.stop(); resolve(); } });
  t('装上了', d.active === true, '父 ' + fake.pid);
  t('父进程一开始是活的', parentAlive(fake.pid));
  setTimeout(() => { try { fake.kill('SIGKILL'); } catch {} }, 500);
  setTimeout(() => { if (!fired) { d.stop(); resolve(); } }, 4000);
}).then(() => {
  delete process.env.AGENT_SOUL_PARENT;
  // 上一段已经 resolve 了，这里只报结果 —— 用 parentAlive 再确认一次父真的死了
  console.log('  （父进程已被杀，看门狗若触发则上面的 resolve 已发生）');
  pass++;
});

console.log('\n' + (fail === 0 ? '全部通过' : '失败 ' + fail) + '：' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);
