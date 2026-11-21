import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('D:/AI/agent-soul/data/meta.sqlite', { readOnly: true });
console.log(db.prepare("SELECT sql FROM sqlite_master WHERE name='echo_words'").get().sql);
console.log(JSON.stringify(db.prepare("SELECT * FROM echo_words LIMIT 2").all().map(r=>({keys:Object.keys(r), len:(r.text||'').length}))));
