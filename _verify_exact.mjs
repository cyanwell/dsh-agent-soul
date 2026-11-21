
import { DatabaseSync } from 'node:sqlite';
import { isInjectedText, windowsOf } from 'file:///D:/AI/agent-soul/src/db/echo-windows.mjs';
const db = new DatabaseSync('D:/AI/agent-soul/data/meta.sqlite', { readOnly: true });
const sid = db.prepare('SELECT echo_source_id FROM echo_index_sources').get().echo_source_id;
for (const KEY of db.prepare('SELECT DISTINCT model_key FROM echo_word_windows WHERE echo_source_id=?').all(sid).map(r=>r.model_key)) {
  const total = db.prepare('SELECT COUNT(*) n FROM echo_word_windows WHERE echo_source_id=? AND model_key=?').get(sid, KEY).n;
  console.log('model=' + KEY.slice(0,12) + ' total=' + total);
}
// 逐行精确比对（当前 key）
const KEY='c7c0c12a8dba770c67904b2538a00c06cc8c35722ac4be71df4b63ac8ef33518';
const actual = new Set();
for (const r of db.prepare('SELECT word_ord, window_ord FROM echo_word_windows WHERE echo_source_id=? AND model_key=?').all(sid, KEY)) actual.add(r.word_ord + '#' + r.window_ord);
const expected = new Set();
for (const w of db.prepare('SELECT word_ord, text FROM echo_words WHERE echo_source_id=?').all(sid)) {
  if (isInjectedText(w.text)) continue;
  windowsOf(w.text).forEach(win => expected.add(w.word_ord + '#' + win.index));
}
const extra = [...actual].filter(k => !expected.has(k));
const missing = [...expected].filter(k => !actual.has(k));
console.log(JSON.stringify({ actualN: actual.size, expectedN: expected.size, extraCount: extra.length, missingCount: missing.length, extraSample: extra.slice(0,6), missingSample: missing.slice(0,6) }, null, 1));
