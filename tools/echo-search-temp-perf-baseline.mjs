import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { openMetaStore } from '../src/db/index.mjs'
import { buildSearchText } from '../src/db/search.mjs'

const root=fs.mkdtempSync(path.join(os.tmpdir(),'echo-search-perf-temp-'))
const sha=s=>createHash('sha256').update(s).digest('hex')
const now='2026-01-01T00:00:00.000Z'
const scales=[{sources:25,wordsPerSource:20},{sources:100,wordsPerSource:20},{sources:250,wordsPerSource:20}]
const pctl=(xs,p)=>xs.slice().sort((a,b)=>a-b)[Math.min(xs.length-1,Math.ceil(xs.length*p)-1)]
const results=[]
try {
  for(const scale of scales){
    const dbPath=path.join(root,'sources-'+scale.sources+'.sqlite')
    const store=openMetaStore({path:dbPath,mode:'readwrite',migrateOnOpen:true})
    try{
      const db=store.db
      const insertSource=db.prepare('INSERT INTO echo_index_sources (echo_source_id,source_path,source_version,namespace,generation,state,cursor_seq,cursor_json,words_count,summaries_count,src_seq_count,source_sha256,source_bytes,built_at,imported_at,importer) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      const insertWord=db.prepare('INSERT INTO echo_words (echo_source_id,word_ord,src_line,t,session,seq,role,kind,len,truncated,text,content_hash,content_class) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      const insertFts=db.prepare('INSERT INTO echo_words_fts (search_text,raw_text,echo_source_id,word_ord,session,seq) VALUES (?,?,?,?,?,?)')
      for(let s=0;s<scale.sources;s++){
        const id='perf-'+scale.sources+'-'+s, src='C:/synthetic/perf/'+scale.sources+'/'+s, session='synthetic-'+s
        insertSource.run(id,src,'echo-index/1','log',1,'committed',scale.wordsPerSource-1,JSON.stringify({seq:scale.wordsPerSource-1}),scale.wordsPerSource,0,0,sha(src),scale.wordsPerSource,now,now,'perf-selftest')
        for(let w=0;w<scale.wordsPerSource;w++){
          const text='synthetic needle source '+s+' word '+w
          const hash=sha(text)
          insertWord.run(id,w,w+1,now,session,w,'user','message',text.length,0,text,hash,'dialogue')
          insertFts.run(buildSearchText(text).searchText,text,id,w,session,w)
        }
      }
      const samples=[]
      for(let i=0;i<102;i++){
        const start=process.hrtime.bigint()
        const out=store.echoSearch('synthetic needle',{surface:'words',limit:1})
        const elapsed=Number(process.hrtime.bigint()-start)/1e6
        if(i>=2) samples.push(elapsed)
        if(i===2){ assert.equal(out.results.length,1); assert.equal(out.index.aligned,true) }
      }
      results.push({scale:{...scale,totalWords:scale.sources*scale.wordsPerSource},iterations:100,warmups:2,medianMs:Number(pctl(samples,0.5).toFixed(3)),p95Ms:Number(pctl(samples,0.95).toFixed(3)),maxMs:Number(Math.max(...samples).toFixed(3))})
    }finally{store.close()}
  }
  console.log(JSON.stringify({kind:'synthetic-temp-only-alignment-baseline',node:process.version,results,productionMeasured:false},null,2))
}finally{
  fs.rmSync(root,{recursive:true,force:true})
  assert.equal(fs.existsSync(root),false,'TEMP benchmark root not removed')
  console.log('TEMP cleanup: PASS')
}
