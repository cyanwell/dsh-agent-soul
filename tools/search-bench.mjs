import { SessionStore } from '../src/session/store.mjs';
const s = new SessionStore('D:/AI/agent-soul/data');
const t0 = Date.now();
s.buildIndex();
console.log('★ 建索引: ' + (Date.now() - t0) + 'ms，' + s.ix.size + ' 个会话，' + (process.memoryUsage().heapUsed / 1048576).toFixed(0) + 'MB 堆');

const qs = ['GSAS', '解耦', 'huanqi', '墨', 'MCP', '插件', '水位阈值'];
for (const q of qs) {
  const t = Date.now();
  const hits = s.searchAll(q, 5);
  const ms = Date.now() - t;
  console.log('「' + q.padEnd(8) + '」 ' + String(ms).padStart(4) + 'ms  ' + String(hits.length).padStart(2) + ' 条  ' + (hits[0] ? String(hits[0].text).slice(0, 40).replace(/\n/g, ' ') : ''));
}
console.log('末了堆: ' + (process.memoryUsage().heapUsed / 1048576).toFixed(0) + 'MB');
s.closeAll();