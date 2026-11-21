import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('D:/AI/agent-soul/data/meta.sqlite', { readOnly: true });
const q = (s, ...a) => db.prepare(s).all(...a);
console.log(JSON.stringify({
  wordVectors: q("SELECT model_key, COUNT(*) n FROM echo_word_vectors GROUP BY model_key"),
  windows: q("SELECT model_key, COUNT(*) n FROM echo_word_windows GROUP BY model_key"),
  maxOrd: q("SELECT model_key, MAX(word_ord) m FROM echo_word_windows GROUP BY model_key"),
}, null, 1));
