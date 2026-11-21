
import { DatabaseSync } from 'node:sqlite';
import { isInjectedText, windowsOf } from 'file:///D:/AI/agent-soul/src/db/echo-windows.mjs';
const db = new DatabaseSync('D:/AI/agent-soul/data/meta.sqlite', { readOnly: true });
const sid = db.prepare('SELECT echo_source_id FROM echo_index_sources').get().echo_source_id;
const KEY='c7c0c12a8dba770c67904b2538a00c06cc8c35722ac4be71df4b63ac8ef33518';
const dbWin = new Map();
for (const r of db.prepare('SELECT word_ord, COUNT(*) n FROM echo_word_windows WHERE echo_source_id=? AND model_key=? GROUP BY word_ord').all(sid, KEY)) dbWin.set(r.word_ord, r.n);
let mismatch = 0; const samples = [];
const words = db.prepare('SELECT word_ord, text FROM echo_words WHERE echo_source_id=? ORDER BY word_ord').all(sid);
for (const w of words) {
  const exp = isInjectedText(w.text) ? 0 : windowsOf(w.text).length;
  const got = dbWin.get(w.word_ord) || 0;
  if (exp !== got) { mismatch++; if (samples.length < 12) samples.push({ wordOrd: w.word_ord, exp, got, len: w.text.length, head: String(w.text).slice(0,60) }); }
}
console.log(JSON.stringify({ wordsTotal: words.length, mismatchedWords: mismatch, samples }, null, 1));
