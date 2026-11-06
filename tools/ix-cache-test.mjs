import { SessionStore } from '../src/session/store.mjs';
const round = process.argv[2] || '1';
const t0 = Date.now();
const s = new SessionStore('D:/AI/agent-soul/data');
s.buildIndex();
console.log('第' + round + '次: 建索引 ' + (Date.now() - t0) + 'ms  会话 ' + s.ix.size + '  复用行 ' + (s.ixReused||0) + '  重读会话 ' + (s.ixReindexed||0));
const t1 = Date.now();
const hits = s.searchAll('解耦', 3);
console.log('        检索 ' + (Date.now() - t1) + 'ms  ' + hits.length + ' 条  ' + String(hits[0]?.text||'').slice(0,30));
if (round === '1') { const t2 = Date.now(); const n = s.saveIndexCache(); console.log('        存缓存 ' + (Date.now() - t2) + 'ms  ' + n + ' 行'); }
s.closeAll();