import assert from 'node:assert/strict'
import { zstdCompressSync } from 'node:zlib'
import { decodeSessionTailFrames } from './echo-source-build.mjs'

const t='2026-11-20T00:00:00.000Z'
const record=JSON.stringify({seq:2,type:'user',event_at:t,raw_path:'C:/synthetic',snippet:'synthetic second record',snippet_truncated:false})+'\n'
const cut=Math.floor(record.length/2)
const firstFrame=zstdCompressSync(Buffer.from(record.slice(0,cut),'utf8'))
const secondFrame=zstdCompressSync(Buffer.from(record.slice(cut),'utf8'))
const partial=decodeSessionTailFrames(firstFrame)
assert.deepEqual(partial.records,[])
assert.equal(partial.openTail,true)
assert.equal(partial.completeBytes,0)
const complete=decodeSessionTailFrames(Buffer.concat([firstFrame,secondFrame]))
assert.deepEqual(complete.records.map(row=>row.seq),[2])
assert.equal(complete.openTail,false)
assert.equal(complete.completeBytes,firstFrame.length+secondFrame.length)
console.log(JSON.stringify({ok:true,layer:'zstd-frame/json-record decoder only',partial:{recordCount:partial.records.length,openTail:partial.openTail,completeBytes:partial.completeBytes},complete:{recordCount:complete.records.length,seqs:complete.records.map(row=>row.seq),openTail:complete.openTail,completeBytes:complete.completeBytes},builderCursorTested:false,liveEOFReconciliationTested:false,realData:false},null,2))
