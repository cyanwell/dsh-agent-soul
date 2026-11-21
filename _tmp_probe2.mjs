import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('D:/AI/agent-soul/data/meta.sqlite', { readOnly: true });
const n = db.prepare("SELECT COUNT(*) n FROM echo_word_vectors WHERE model_key=?").get('6537613a94d22026a60e9cc2dde43bb5c66c7b1c1b0d8dc7ae998de53ce50fed').n;
console.log(JSON.stringify({ n, at: Date.now() }));
