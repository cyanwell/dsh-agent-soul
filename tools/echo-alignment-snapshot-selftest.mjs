import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { openMetaStore } from '../src/db/index.mjs'
import { echoIndexInfo } from '../src/db/echo-integrity.mjs'
import { buildSearchText } from '../src/db/search.mjs'

const root=fs.mkdtempSync(path.join(os.tmpdir(),'echo-align-snapshot-'))
const dbPath=path.join(root,'snapshot.sqlite')
const hash=s=>createHash('sha256').update(s).digest('hex')
const t='2026-01-01T00:00:00.000Z'
let reader,writer
function find(db,term){return db.prepare('SELECT w.seq FROM echo_words_fts f JOIN echo_words w ON w.echo_source_id=f.echo_source_id AND w.word_ord=f.word_ord WHERE echo_words_fts MATCH ? ORDER BY w.word_ord').all(buildSearchText(term).searchText).map(r=>Number(r.seq))}
try{
  reader=openMetaStore({path:dbPath,mode:'readwrite',migrateOnOpen:true})
  writer=openMetaStore({path:dbPath,mode:'readwrite',migrateOnOpen:false})
  const db=reader.db,sid='snapshot-source',session='synthetic-snapshot'
  db.prepare('INSERT INTO echo_index_sources (echo_source_id,source_path,source_version,namespace,generation,state,cursor_seq,cursor_json,words_count,summaries_count,src_seq_count,source_sha256,source_bytes,built_at,imported_at,importer) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(sid,'C:/synthetic/snapshot','echo-index/1','log',1,'committed',0,'{}',1,0,0,hash('g1'),1,t,t,'snapshot-fixture')
  const oldText='synthetic oldmarker'
  db.prepare('INSERT INTO echo_words (echo_source_id,word_ord,src_line,t,session,seq,role,kind,len,truncated,text,content_hash,content_class) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(sid,0,1,t,session,0,'user','message',oldText.length,0,oldText,hash(oldText),'dialogue')
  db.prepare('INSERT INTO echo_words_fts (search_text,raw_text,echo_source_id,word_ord,session,seq) VALUES (?,?,?,?,?,?)')
    .run(buildSearchText(oldText).searchText,oldText,sid,0,session,0)
  db.prepare('INSERT INTO echo_source_builds (echo_source_id,generation,source_sha256,source_bytes,words_count,summaries_count,src_seq_count,cursor_seq,cursor_json,built_at,imported_at,importer) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(sid,1,hash('g1'),1,1,0,0,0,'{}',t,t,'snapshot-fixture')

  db.exec('BEGIN')
  assert.equal(echoIndexInfo(db).aligned,true)
  assert.deepEqual(find(db,'oldmarker'),[0])
  const w=writer.db
  w.exec('BEGIN IMMEDIATE')
  const newText='synthetic newmarker'
  w.prepare('DELETE FROM echo_words_fts WHERE echo_source_id=?').run(sid)
  w.prepare('UPDATE echo_words SET text=?,len=?,content_hash=? WHERE echo_source_id=? AND word_ord=0').run(newText,newText.length,hash(newText),sid)
  w.prepare('INSERT INTO echo_words_fts (search_text,raw_text,echo_source_id,word_ord,session,seq) VALUES (?,?,?,?,?,?)')
    .run(buildSearchText(newText).searchText,newText,sid,0,session,0)
  w.prepare('UPDATE echo_index_sources SET generation=2,source_sha256=? WHERE echo_source_id=?').run(hash('g2'),sid)
  w.prepare('INSERT INTO echo_source_builds (echo_source_id,generation,source_sha256,source_bytes,words_count,summaries_count,src_seq_count,cursor_seq,cursor_json,built_at,imported_at,importer) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(sid,2,hash('g2'),1,1,0,0,0,'{}',t,t,'snapshot-fixture')
  w.exec('COMMIT')

  assert.equal(echoIndexInfo(db).aligned,true)
  assert.deepEqual(find(db,'oldmarker'),[0])
  assert.deepEqual(find(db,'newmarker'),[])
  db.exec('COMMIT')
  assert.equal(echoIndexInfo(db).aligned,true)
  assert.deepEqual(find(db,'newmarker'),[0])
  assert.deepEqual(find(db,'oldmarker'),[])
  assert.equal(echoIndexInfo(w).aligned,true)
  assert.deepEqual(find(w,'newmarker'),[0])
  console.log(JSON.stringify({ok:true,readerHeldSnapshot:'old rows and gate stayed consistent through writer commit',afterReaderCommit:'new generation visible',freshWriterSnapshot:'new generation visible',fullCoreRuntime:'not run',productionData:'not touched'},null,2))
}finally{
  if(reader){try{reader.db.exec('ROLLBACK')}catch{} reader.close()}
  if(writer)writer.close()
  fs.rmSync(root,{recursive:true,force:true})
  assert.equal(fs.existsSync(root),false,'TEMP fixture root remains')
  console.log('TEMP cleanup: PASS')
}
