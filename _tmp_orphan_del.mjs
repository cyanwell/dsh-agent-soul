
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('D:/AI/agent-soul/data/meta.sqlite');
const ORPHAN='7367cfcca7dcb001f798e89ddfe493c0b5e5b7af5939fad3d2116bedecc76237';
const before = db.prepare('SELECT COUNT(*) n FROM echo_word_vectors WHERE model_key=?').get(ORPHAN).n;
db.exec('BEGIN IMMEDIATE');
db.prepare('DELETE FROM echo_word_vectors WHERE model_key=?').run(ORPHAN);
db.prepare('DELETE FROM echo_vector_models WHERE model_key=?').run(ORPHAN);
db.exec('COMMIT');
const after = db.prepare('SELECT COUNT(*) n FROM echo_word_vectors WHERE model_key=?').get(ORPHAN).n;
const remaining = db.prepare('SELECT model_key, COUNT(*) n FROM echo_word_vectors GROUP BY model_key').all();
const models = db.prepare('SELECT model_key FROM echo_vector_models').all().map(r=>r.model_key.slice(0,12));
const win = db.prepare('SELECT model_key, COUNT(*) n FROM echo_word_windows GROUP BY model_key').all();
console.log(JSON.stringify({ before, after, remaining, win, models }, null, 1));
