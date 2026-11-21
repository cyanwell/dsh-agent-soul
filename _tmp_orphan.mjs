
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('D:/AI/agent-soul/data/meta.sqlite', { readOnly: true });
const ORPHAN='7367cfcca7dcb001f798e89ddfe493c0b5e5b7af5939fad3d2116bedecc76237';
const n = db.prepare('SELECT COUNT(*) n FROM echo_word_vectors WHERE model_key=?').get(ORPHAN).n;
const bytes = db.prepare('SELECT SUM(LENGTH(vector_blob)) b FROM echo_word_vectors WHERE model_key=?').get(ORPHAN).b;
const refs = db.prepare('SELECT COUNT(*) n FROM echo_word_vectors WHERE model_key=?').get('6537613a94d22026a60e9cc2dde43bb5c66c7b1c1b0d8dc7ae998de53ce50fed').n;
console.log(JSON.stringify({orphanVectors:n, orphanBytesMB:Number((bytes/1048576).toFixed(1)), newModelVectors:refs}));
