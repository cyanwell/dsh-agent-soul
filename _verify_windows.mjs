
import { DatabaseSync } from 'node:sqlite';
import { isInjectedText, windowsOf } from 'file:///D:/AI/agent-soul/src/db/echo-windows.mjs';
const db = new DatabaseSync('D:/AI/agent-soul/data/meta.sqlite', { readOnly: true });
const sid = db.prepare('SELECT echo_source_id FROM echo_index_sources').get().echo_source_id;
let expectedWindows = 0, wordsKept = 0, wordsInj = 0;
const rows = db.prepare("SELECT word_ord, text FROM echo_words WHERE echo_source_id=? ORDER BY word_ord").all(sid);
for (const r of rows) {
  if (isInjectedText(r.text)) { wordsInj++; continue; }
  wordsKept++;
  expectedWindows += windowsOf(r.text).length;
}
const got = db.prepare("SELECT model_key, COUNT(*) n FROM echo_word_windows WHERE echo_source_id=? GROUP BY model_key").all(sid);
const wordVec = db.prepare("SELECT model_key, COUNT(*) n FROM echo_word_vectors WHERE echo_source_id=? GROUP BY model_key").all(sid);
console.log(JSON.stringify({ wordsTotal: rows.length, wordsKept, wordsInj, expectedWindows, windowsInDb: got, wordVectorsInDb: wordVec }, null, 1));
