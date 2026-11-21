import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { openMetaStore } from '../src/db/index.mjs'
import { buildSource } from './echo-source-build.mjs'

const root=fs.mkdtempSync(path.join(os.tmpdir(),'echo-content-class-import-'))
const NODE=process.execPath
const HERE=path.dirname(fileURLToPath(import.meta.url))
const sha=b=>createHash('sha256').update(b).digest('hex')
let store
try {
  const input=path.join(root,'synthetic.jsonl')
  const rows=[
    {seq:0,t:'2026-01-01T00:00:00.000Z',session:'synthetic-b0',ws:'synthetic',role:'user',text:'Synthetic dialogue sentinel'},
    {seq:1,t:'2026-01-01T00:00:01.000Z',session:'synthetic-b0',ws:'synthetic',role:'user',text:'Current runtime context synthetic injection sentinel'},
    {seq:2,t:'2026-01-01T00:00:02.000Z',session:'synthetic-b0',ws:'synthetic',role:'assistant',text:'Synthetic ordinary reply'}
  ]
  fs.writeFileSync(input,rows.map(x=>JSON.stringify(x)).join('\n')+'\n')
  const build=buildSource({input,outDir:path.join(root,'build'),sourcePath:'D:/synthetic/echo-content-class/import',namespace:'log',generation:1,builtAt:'2026-01-01T00:01:00.000Z',cursorSeq:2})
  const dbPath=path.join(root,'meta.sqlite')
  store=openMetaStore({path:dbPath,mode:'readwrite'}); store.migrate(); store.close(); store=null
  const manifestBytes=fs.readFileSync(build.manifestPath)
  const result=spawnSync(NODE,[path.join(HERE,'echo-index-import.mjs'),'--manifest',build.manifestPath,'--sha256',sha(manifestBytes),'--generation','1','--db',dbPath,'--json'],{encoding:'utf8'})
  assert.equal(result.status,0,String(result.stderr||'')+' '+String(result.stdout||''))
  const receipt=JSON.parse(String(result.stdout).trim().split('\n').at(-1))
  assert.equal(receipt.code,'IMPORTED')
  store=openMetaStore({path:dbPath,mode:'readonly'})
  const labels=store.db.prepare('SELECT seq,content_class FROM echo_words ORDER BY seq').all().map(x=>[Number(x.seq),x.content_class])
  assert.deepEqual(labels,[[0,'dialogue'],[1,'injection'],[2,'dialogue']])
  const defaultHits=store.echoSearch('injection sentinel',{surface:'words'})
  const includedHits=store.echoSearch('injection sentinel',{surface:'words',includeNonDialogue:true})
  assert.equal(defaultHits.results.length,0)
  assert.deepEqual(includedHits.results.map(x=>x.seq),[1])
  assert.deepEqual(store.echoStats().wordContentClasses,{dialogue:2,injection:1,other:0})
  assert.equal(store.echoStats().aligned,true)
  console.log('echo-content-class-import-selftest: synthetic CLI import, stored labels, default/opt-in search passed')
} finally {
  if(store) store.close()
  fs.rmSync(root,{recursive:true,force:true})
}
