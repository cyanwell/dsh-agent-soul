import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const root=fs.mkdtempSync(path.join(os.tmpdir(),'echo-epoch-trigger-probe-'))
const dbPath=path.join(root,'probe.sqlite')
let db
try {
  db=new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('CREATE TABLE epoch(id INTEGER PRIMARY KEY, value INTEGER NOT NULL); INSERT INTO epoch VALUES(1,0); CREATE TABLE regular(id INTEGER PRIMARY KEY, value TEXT); CREATE VIRTUAL TABLE words_fts USING fts5(text, sid UNINDEXED)')
  const results=[]
  const attempt=(label,sql,mutate)=>{
    try { db.exec(sql); mutate(); results.push({label,trigger:'supported',value:db.prepare('SELECT value FROM epoch WHERE id=1').get().value}) }
    catch(e) { results.push({label,trigger:'failed',code:e.code||null,message:String(e.message)}) }
  }
  attempt('regular AFTER INSERT',"CREATE TRIGGER regular_ai AFTER INSERT ON regular BEGIN UPDATE epoch SET value=value+1 WHERE id=1; END;",()=>db.prepare("INSERT INTO regular(value) VALUES('x')").run())
  attempt('FTS5 AFTER INSERT',"CREATE TRIGGER fts_ai AFTER INSERT ON words_fts BEGIN UPDATE epoch SET value=value+1 WHERE id=1; END;",()=>db.prepare("INSERT INTO words_fts(text,sid) VALUES('alpha',1)").run())
  attempt('FTS5 AFTER DELETE',"CREATE TRIGGER fts_ad AFTER DELETE ON words_fts BEGIN UPDATE epoch SET value=value+1 WHERE id=1; END;",()=>db.prepare('DELETE FROM words_fts').run())
  const before=Number(db.prepare('SELECT value FROM epoch WHERE id=1').get().value)
  db.exec('BEGIN IMMEDIATE')
  db.prepare("INSERT INTO regular(value) VALUES('rollback')").run()
  db.exec('ROLLBACK')
  const after=Number(db.prepare('SELECT value FROM epoch WHERE id=1').get().value)
  assert.equal(after,before,'trigger-maintained epoch did not roll back with source transaction')
  console.log(JSON.stringify({node:process.version,sqlite:db.prepare('SELECT sqlite_version() v').get().v,results,rollbackEpoch:{before,after,passed:before===after},productionData:false},null,2))
} finally {
  if(db) db.close()
  fs.rmSync(root,{recursive:true,force:true})
  assert.equal(fs.existsSync(root),false,'TEMP probe root remains')
  console.log('TEMP cleanup: PASS')
}
