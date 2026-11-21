import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openMetaStore } from '../src/db/index.mjs'
import { searchEcho } from '../src/db/echo.mjs'
import { buildSearchText } from '../src/db/search.mjs'
import { checksum } from '../src/db/schema.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-content-class-search-'))
const dbPath = path.join(root, 'synthetic-v13.sqlite')
let store
try {
  store = openMetaStore({path:dbPath, mode:'readwrite', migrateOnOpen:true})
  const db = store.db
  const sourceId = 'echo-b0-synthetic'
  const sourcePath = 'C:/synthetic/echo-feed.jsonl'
  const now = '2026-01-01T00:00:00.000Z'
  db.prepare('INSERT INTO echo_index_sources (echo_source_id,source_path,source_version,namespace,generation,state,cursor_seq,cursor_json,words_count,summaries_count,src_seq_count,source_sha256,source_bytes,built_at,imported_at,importer) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(sourceId,sourcePath,'echo-index/1','log',1,'committed',2,JSON.stringify({seq:2}),3,1,0,checksum('source'),1,now,now,'selftest')
  const words = [
    {text:'user ordinary needle', role:'user', cls:'dialogue'},
    {text:'Current runtime context synthetic injection needle 过滤词', role:'user', cls:'injection'},
    {text:'tool output needle', role:'tool', cls:'other'},
  ]
  const insWord = db.prepare('INSERT INTO echo_words (echo_source_id,word_ord,src_line,t,session,seq,role,kind,len,truncated,text,content_hash,content_class) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
  const insFts = db.prepare('INSERT INTO echo_words_fts (search_text,raw_text,echo_source_id,word_ord,session,seq) VALUES (?,?,?,?,?,?)')
  for (let i=0;i<words.length;i+=1) {
    const w=words[i], ord=i, session='synthetic'
    insWord.run(sourceId,ord,i+1,now,session,i,w.role,'message',w.text.length,0,w.text,checksum(w.text),w.cls)
    insFts.run(buildSearchText(w.text).searchText,w.text,sourceId,ord,session,i)
  }
  const summary='summary needle'
  db.prepare('INSERT INTO echo_summaries (echo_source_id,cmp_id,ord,src_line,t,session,shadowed_tokens,shadowed_chars,status,summary,full_json,src_seq_count,content_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(sourceId,'synthetic-cmp',0,1,now,'synthetic',1,1,'active',summary,'{}',0,checksum(summary))
  db.prepare('INSERT INTO echo_summaries_fts (search_text,raw_text,echo_source_id,cmp_id) VALUES (?,?,?,?)')
    .run(buildSearchText(summary).searchText,summary,sourceId,'synthetic-cmp')
  db.prepare('INSERT INTO echo_source_builds (echo_source_id,generation,source_sha256,source_bytes,words_count,summaries_count,src_seq_count,cursor_seq,cursor_json,built_at,imported_at,importer) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(sourceId,1,checksum('source'),1,3,1,0,2,JSON.stringify({seq:2}),now,now,'selftest')

  const defaultStore=store.echoSearch('needle',{surface:'all'})
  const includedStore=store.echoSearch('needle',{surface:'all',includeNonDialogue:true})
  assert.deepEqual(defaultStore.surfaces.words.results.map(x=>x.seq),[0])
  assert.equal(defaultStore.surfaces.summaries.results.length,1)
  assert.deepEqual(includedStore.surfaces.words.results.map(x=>x.seq),[0,1,2])
  assert.deepEqual(includedStore.surfaces.summaries.results.map(x=>x.cmpId),defaultStore.surfaces.summaries.results.map(x=>x.cmpId))

  const defaultDirect=searchEcho(db,{terms:['needle'],surface:'both'})
  const includedDirect=searchEcho(db,{terms:['needle'],surface:'both',includeNonDialogue:true})
  assert.deepEqual(defaultDirect.words.results.map(x=>x.seq),[0])
  assert.equal(defaultDirect.summaries.results.length,1)
  assert.deepEqual(includedDirect.words.results.map(x=>x.seq),[0,1,2])
  assert.deepEqual(includedDirect.summaries.results.map(x=>x.cmpId),defaultDirect.summaries.results.map(x=>x.cmpId))

  const opts={surface:'words',echoSourceId:sourceId,since:now,until:now}
  assert.equal(store.echoSearch('needle',opts).results.length,1)
  assert.deepEqual(store.echoSearch('needle',{...opts,includeNonDialogue:true}).results.map(x=>x.seq),[0,1,2])
  assert.equal(searchEcho(db,{terms:['needle'],...opts}).words.results.length,1)
  assert.deepEqual(searchEcho(db,{terms:['needle'],...opts,includeNonDialogue:true}).words.results.map(x=>x.seq),[0,1,2])
  assert.equal(store.echoSearch('过滤词',opts).results.length,0)
  assert.deepEqual(store.echoSearch('过滤词',{...opts,includeNonDialogue:true}).results.map(x=>x.seq),[1])
  assert.equal(searchEcho(db,{terms:['过滤词'],...opts}).words.results.length,0)
  assert.deepEqual(searchEcho(db,{terms:['过滤词'],...opts,includeNonDialogue:true}).words.results.map(x=>x.seq),[1])

  const stats=store.echoStats()
  assert.deepEqual(stats.wordContentClasses,{dialogue:1,injection:1,other:1})
  assert.equal(stats.words,stats.wordContentClasses.dialogue+stats.wordContentClasses.injection+stats.wordContentClasses.other)
  assert.equal(stats.aligned,true)
  console.log('echo-content-class-integration-selftest: both search APIs, summaries unchanged, stats passed')
} finally {
  if(store) store.close()
  fs.rmSync(root,{recursive:true,force:true})
}
