import { SessionStore } from '../src/session/store.mjs';
const s = new SessionStore('D:/AI/agent-soul/data');
const list = s.list();
console.log('会话 ' + list.length + ' 个');
let total = 0;
const t0 = Date.now();
for (const x of list) {
  const st = s.load(x.id);
  if (st) total += st.frames.length;
}
const ms = Date.now() - t0;
const mb = (process.memoryUsage().heapUsed / 1048576).toFixed(0);
console.log('扫全库 ' + list.length + ' 个会话，遍历 ' + total + ' 帧，用时 ' + ms + 'ms，堆 ' + mb + 'MB');

// 再搜几个词
for (const q of ['GSAS', '解耦', 'huanqi']) {
  const t1 = Date.now();
  const hits = s.searchAll(q, 5);
  console.log('  「' + q + '」→ ' + hits.length + ' 条，' + (Date.now() - t1) + 'ms');
}
console.log('扫完后堆 ' + (process.memoryUsage().heapUsed / 1048576).toFixed(0) + 'MB');
s.closeAll();