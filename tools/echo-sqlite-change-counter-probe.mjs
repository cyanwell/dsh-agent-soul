import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const root=fs.mkdtempSync(path.join(os.tmpdir(),'echo-sqlite-counters-'))
const file=path.join(root,'counters.sqlite')
let a,b
const snap=db=>({dataVersion:Number(db.prepare('PRAGMA data_version').get().data_version),totalChanges:Number(db.prepare('SELECT total_changes() n').get().n)})
try{
  a=new DatabaseSync(file); b=new DatabaseSync(file)
  a.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO t(value) VALUES('seed')")
  const result={sqlite:a.prepare('SELECT sqlite_version() v').get().v,initialA:snap(a),initialB:snap(b)}
  a.prepare('INSERT INTO t(value) VALUES(?)').run('same-conn')
  result.afterSameConnectionWrite={a:snap(a),b:snap(b)}
  a.exec('BEGIN IMMEDIATE'); a.prepare('INSERT INTO t(value) VALUES(?)').run('commit'); const beforeCommit=snap(a); a.exec('COMMIT')
  result.transactionCommit={beforeCommit,afterCommitA:snap(a),afterCommitB:snap(b)}
  a.exec('BEGIN IMMEDIATE'); a.prepare('INSERT INTO t(value) VALUES(?)').run('rollback'); const beforeRollback=snap(a); a.exec('ROLLBACK')
  result.transactionRollback={beforeRollback,afterRollbackA:snap(a),afterRollbackB:snap(b)}
  a.exec('BEGIN')
  const heldBefore={snapshot:snap(a),rows:Number(a.prepare('SELECT count(*) n FROM t').get().n)}
  b.prepare('INSERT INTO t(value) VALUES(?)').run('external-commit')
  const heldAfter={snapshot:snap(a),rows:Number(a.prepare('SELECT count(*) n FROM t').get().n)}
  a.exec('COMMIT')
  result.externalCommitDuringReader={heldBefore,heldAfter,freshA:{snapshot:snap(a),rows:Number(a.prepare('SELECT count(*) n FROM t').get().n)}}
  assert.equal(heldAfter.rows,heldBefore.rows,'held reader snapshot changed after external commit')
  assert.equal(result.externalCommitDuringReader.freshA.rows,heldBefore.rows+1)
  console.log(JSON.stringify({ok:true,result,productionData:false,interpretation:'observe actual SQLite counters only; no cache implementation'},null,2))
}finally{
  if(a)a.close();if(b)b.close()
  fs.rmSync(root,{recursive:true,force:true})
  assert.equal(fs.existsSync(root),false,'TEMP counter DB remains')
  console.log('TEMP cleanup: PASS')
}
