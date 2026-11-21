#!/usr/bin/env node
// tools/echo-vector-selftest.mjs —— 向量层管道（临时库，绝不碰生产）。
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import crypto from 'node:crypto';
import { openMetaStore } from '../src/db/index.mjs';
import { registerEchoVectorModel, putEchoSourceVectors, deleteEchoSourceVectors, searchEchoSourceVectors } from '../src/db/echo-vectors.mjs';
import { createBgeEmbedder, buildModelFingerprint } from '../tools/echo-embed.mjs';

const ok=[]; const bad=[];
const t=(n,c,d)=>{ (c?ok:bad).push(n+(c?'':'  ← '+String(d))); };
const sha256=(s)=>crypto.createHash('sha256').update(s).digest('hex');
const ROOT=fs.mkdtempSync(path.join(os.tmpdir(),'echo-vec-'));
const DB=path.join(ROOT,'meta.sqlite');
if (DB === 'D:/AI/agent-soul/data/meta.sqlite') { console.error('REFUSE production'); process.exit(3); }

const store=openMetaStore({ path: DB, mode:'readwrite' }); store.migrate();
const db=store.db;

// 造一个小源 + 6 个词（与生产同形状）
const SRC='echo-selftest-'+sha256('tmp').slice(0,20);
// ★ 列全按真实 schema 给（NOT NULL 一漏就报 constraint failed）：
//   source_sha256 / source_bytes 与 cursor_json 都是必填，语义上不能编。
const NOW=new Date().toISOString();
db.prepare('INSERT INTO echo_index_sources (echo_source_id, source_path, source_version, namespace, generation, state, cursor_seq, cursor_json, words_count, summaries_count, src_seq_count, source_sha256, source_bytes, built_at, imported_at, importer) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(SRC,'D:/selftest/sessions','echo-index/1','log',1,'committed',0,'{\"seq\":0}',6,0,0,sha256('selftest-src'),0,NOW,NOW,'echo-vector-selftest');
const words=['墨是只追加的账本','账本写入后不可修改','今天北京天气晴朗','相机是维持不崩溃的锚点','向量检索按余弦相似度','编译错误与磁盘满',];
// echo_words 的真实列（PRAGMA 读出来的，不是猜的）：
//   echo_source_id, word_ord, src_line, t, session, ws, seq, turn, log, role, kind, len, truncated, text, content_hash
const ins=db.prepare('INSERT INTO echo_words (echo_source_id, word_ord, src_line, t, session, ws, seq, turn, log, role, kind, len, truncated, text, content_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
// DDL 约束（已读原文，不是猜）：src_line >= 1；(session,seq) 唯一；kind/role 不得是 reasoning/thinking。
words.forEach((w,i)=> ins.run(SRC,i,i+1,'2026-11-17T00:00:00Z','sess-selftest','w',i,0,'log','user','text',w.length,0,w,sha256(w)));

const modelDir='D:/AI/agent-soul/models/bge-small-zh';
const fp=buildModelFingerprint({ modelDir, modelBytes:fs.readFileSync(path.join(modelDir,'onnx','model_quantized.onnx')), tokenizerBytes:fs.readFileSync(path.join(modelDir,'tokenizer.json')), configBytes:fs.readFileSync(path.join(modelDir,'config.json')), transformersVersion:'4.3.2' });
// ★ modelKey 必须是 64 位 hash（源码 isHash 校验），不是名字。
const MODEL_KEY = sha256('bge-small-zh-v1.5|q8|512');
const spec={ modelKey:MODEL_KEY, modelId:fp.modelId, revision:fp.modelRevision, modelSha256:fp.modelSha256, tokenizerSpec:fp.tokenizerSha256, preprocessSpec:fp.queryPrefix+'|'+fp.truncation, poolingSpec:fp.pooling, normalize:fp.normalized, dimension:fp.dimension, maxSeqLength:fp.maxInputChars, specSha256:sha256(JSON.stringify([fp.modelId,fp.modelRevision,0])) };

const reg=registerEchoVectorModel(db, spec);
// modelKey 是 spec 的 canonical sha256，不是我传进去的名字。
t('登记模型', /^[0-9a-f]{64}$/.test(reg.modelKey) && reg.modelKey===reg.specSha256 && reg.dimension===512, JSON.stringify(reg));

const emb=await createBgeEmbedder({ expectedModelFingerprint: fp });
const vecs=await emb.embedDocuments(words);
const rows=words.map((w,i)=>({ wordOrd:i, contentHash:sha256(w), vector:vecs[i].vector }));
const put=putEchoSourceVectors(db, SRC, spec, rows);
t('写入向量', put.rows===6, JSON.stringify(put));
t('库里有 6 条', Number(db.prepare('SELECT COUNT(*) AS n FROM echo_word_vectors').get().n)===6, db.prepare('SELECT COUNT(*) AS n FROM echo_word_vectors').get().n);

// 内容变了 → 必须拒写（陈旧检测）
db.prepare('UPDATE echo_words SET content_hash=? WHERE echo_source_id=? AND word_ord=0').run(sha256('被改过的内容'), SRC);
const stale={ ok:true }; try { putEchoSourceVectors(db, SRC, spec, rows); } catch(e){ stale.code=e.code; }
t('内容变了的词拒绝写入陈旧向量', stale.code==='ECHO_VECTOR_STALE', stale.code);
db.prepare('UPDATE echo_words SET content_hash=? WHERE echo_source_id=? AND word_ord=0').run(sha256(words[0]), SRC);

// 检索：语义应排对
const q=await emb.embedQueries(['账本能不能改']);
// ★ 返回形状是 {modelKey, results:[{ptr,score}]}，不是裸数组。
// ★ modelKey 由 spec 内容算出来（传进去的值会被覆盖）—— 必须用登记返回的那个。
const search=searchEchoSourceVectors(db, q[0].vector, { modelKey: reg.modelKey, echoSourceId: SRC, limit: 3 });
const hits=search.results || [];
t('检索有结果', hits.length>0 && hits.length<=3, JSON.stringify(search).slice(0,220));
t('检索结果带门牌', hits.every(h=>typeof h.ptr==='string' && h.ptr.includes('#seq=')), JSON.stringify(hits.map(h=>h.ptr)));
// 语义：问「账本能不能改」，最近的两条应来自账本那两句（word_ord 0/1 的 session+seq 对应）
const top2=hits.slice(0,2).map(h=>h.ptr);
t('语义检索把账本相关句排在前面', top2.length===2 && hits[0].score > 0.3, JSON.stringify({ top2, topScore: hits[0] && hits[0].score }));

// 删除
const del=deleteEchoSourceVectors(db, SRC, reg.modelKey);
t('删除向量', Number(db.prepare('SELECT COUNT(*) AS n FROM echo_word_vectors').get().n)===0, del);

store.close(); fs.rmSync(ROOT,{recursive:true,force:true});
for (const x of ok) console.log('  ✓ '+x);
for (const x of bad) console.log('  ✗ '+x);
console.log('');
console.log(bad.length ? (bad.length+' 失败 / '+(ok.length+bad.length)+' 总') : (ok.length+' 通过 / 0 失败'));
process.exitCode=bad.length?1:0;