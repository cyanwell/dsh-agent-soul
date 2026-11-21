import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openMetaStore, migrate, MIGRATIONS, SCHEMA_VERSION, migrationDigest, readSchemaState } from '../src/db/index.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-content-class-migration-'))
const dbPath = path.join(root, 'v12.sqlite')
const v12 = MIGRATIONS.slice(0, 12)
const legacyDigests = v12.map(migrationDigest)
let store
try {
  store = openMetaStore({ path: dbPath, mode: 'readwrite' })
  migrate(store.db, { migrations: v12, targetVersion: 12, now: '2026-01-01T00:00:00.000Z' })
  assert.equal(readSchemaState(store.db).current, 12)
  store.db.exec("INSERT INTO echo_index_sources (echo_source_id,source_path,source_version,namespace,generation,state,cursor_seq,cursor_json,words_count,summaries_count,src_seq_count,source_sha256,source_bytes,built_at,imported_at,importer) VALUES ('s','C:/synthetic','v1','log',1,'committed',4,'{}',4,0,0,lower(hex(zeroblob(32))),0,'t','t','test')")
  const insert = store.db.prepare('INSERT INTO echo_words (echo_source_id,word_ord,src_line,t,session,seq,role,kind,len,truncated,text,content_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
  const rows = [
    ['Current runtime context injected', 'user', 0, 'injection'],
    ['This is an automatically generated checkpoint', 'assistant', 0, 'injection'],
    ['[EAC design template]', 'assistant', 0, 'injection'],
    ['<system-reminder>hidden', 'assistant', 0, 'injection'],
    ['ordinary', 'user', 0, 'dialogue'],
    ['truncated ordinary', 'assistant', 1, 'other'],
    ['tool output', 'tool', 0, 'other'],
  ]
  const targetRows = 46536
  while (rows.length < targetRows) {
    const i = rows.length
    rows.push(['synthetic bulk dialogue ' + i, 'user', 0, 'dialogue'])
  }
  store.db.prepare('UPDATE echo_index_sources SET cursor_seq=?,cursor_json=?,words_count=? WHERE echo_source_id=?').run(rows.length - 1, JSON.stringify({seq:rows.length - 1}), rows.length, 's')
  for (let i = 0; i < rows.length; i += 1) {
    const [text, role, truncated] = rows[i]
    insert.run('s', i, i + 1, '2026-01-01T00:00:00.000Z', 'synthetic', i, role, 'message', text.length, truncated, text, lowerHex(i))
  }
  const applied = migrate(store.db, { targetVersion: 13, now: '2026-01-02T00:00:00.000Z' })
  assert.deepEqual(applied.applied.map(x => x.version), [13])
  assert.equal(readSchemaState(store.db).current, 13)
  assert.deepEqual(MIGRATIONS.slice(0, 12).map(migrationDigest), legacyDigests)
  const got = store.db.prepare('SELECT word_ord,content_class FROM echo_words ORDER BY word_ord LIMIT 7').all().map(x => x.content_class)
  assert.deepEqual(got, rows.slice(0,7).map(x => x[3]))
  const counts = Object.fromEntries(store.db.prepare('SELECT content_class,COUNT(*) n FROM echo_words GROUP BY content_class').all().map(x => [x.content_class,Number(x.n)]))
  assert.deepEqual(counts,{dialogue:46530,injection:4,other:2})
  assert.equal(counts.dialogue+counts.injection+counts.other,targetRows)
  assert.equal(Number(store.db.prepare('SELECT COUNT(*) n FROM echo_words').get().n),46536)
  assert.deepEqual(store.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(x => Number(x.version)), Array.from({length:13}, (_, i) => i + 1))
  const failedPath = path.join(root, 'rollback.sqlite')
  const failed = openMetaStore({ path: failedPath, mode: 'readwrite' })
  try {
    const broken = MIGRATIONS.slice(0,12).concat([{version:13,name:'b0-rollback-probe',sql:'CREATE TABLE rollback_probe(x);',after(){throw new Error('probe failure')}}])
    migrate(failed.db, { migrations: broken, targetVersion:13, now:'2026-01-03T00:00:00.000Z' })
    assert.fail('expected rollback probe to fail')
  } catch (err) {
    assert.match(String(err.message), /post-step failed/)
    assert.equal(readSchemaState(failed.db).current, 0)
    assert.equal(failed.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='rollback_probe'").get().n, 0)
  } finally { failed.close() }
  console.log('echo-content-class-migration-selftest: v12->v13 backfill, checksums and rollback passed')
} finally {
  if (store) store.close()
  fs.rmSync(root, {recursive:true, force:true})
}

function lowerHex(n) { return n.toString(16).padStart(64,'0') }
