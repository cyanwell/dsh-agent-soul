#!/usr/bin/env node
// Explicit TEMP/imported ECHO SQLite vector build/search CLI; never resolves the production DB.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openMetaStore } from '../src/db/index.mjs';
import { createBgeEmbedder } from './echo-embed.mjs';

const fail = (message) => { throw new Error(message); };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MODEL_DIR = 'D:/AI/dsh-tools/dsh-agent-soul/kit/echo/models/bge-small-zh';
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (!['--mode','--db','--echo-source-id','--model-dir','--expected-fingerprint','--query','--limit'].includes(k)) fail('unknown option: ' + k);
    if (out[k] !== undefined) fail('duplicate option: ' + k);
    if (argv[i+1] === undefined || String(argv[i+1]).startsWith('--')) fail('missing value: ' + k);
    out[k] = String(argv[++i]);
  }
  for (const k of ['--mode','--db','--echo-source-id','--model-dir','--expected-fingerprint']) if (!out[k]) fail('required option missing: ' + k);
  if (!['build','search'].includes(out['--mode'])) fail('--mode must be build|search');
  if (out['--mode']==='search' && !out['--query']) fail('--query is required for search');
  if (out['--mode']==='build' && out['--query']) fail('--query is only valid for search');
  return out;
}
function tempDbPath(value) {
  if (!path.isAbsolute(value)) fail('--db must be an explicit absolute path');
  const p = path.resolve(value);
  const realTemp = fs.realpathSync(os.tmpdir());
  const parent = fs.realpathSync(path.dirname(p));
  const rel = path.relative(realTemp, parent);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) fail('--db parent must be under OS temporary directory');
  if (fs.existsSync(p) && !fs.realpathSync(p).startsWith(realTemp + path.sep)) fail('--db must resolve under OS temporary directory');
  return p;
}
function vectorSpec(f) {
  return {
    modelId:f.modelId,
    revision:f.modelRevision,
    modelSha256:f.modelSha256,
    tokenizerSpec:JSON.stringify({ sha256:f.tokenizerSha256, configSha256:f.configSha256 }),
    preprocessSpec:JSON.stringify({ queryPrefix:f.queryPrefix, documentPrefix:f.documentPrefix, maxInputChars:f.maxInputChars, truncation:f.truncation }),
    poolingSpec:JSON.stringify({ pooling:f.pooling, dtype:f.dtype }),
    normalize:f.normalized,
    dimension:f.dimension,
    maxSeqLength:f.maxInputChars,
  };
}
export async function runVectorCli(argv, dependencies = {}) {
  const args = parseArgs(argv);
  const dbPath = tempDbPath(args['--db']);
  const modelDir = path.resolve(args['--model-dir'] || DEFAULT_MODEL_DIR);
  const fingerprintPath = path.resolve(args['--expected-fingerprint']);
  const expected = JSON.parse(fs.readFileSync(fingerprintPath, 'utf8'));
  const echoSourceId = args['--echo-source-id'];
  const mode = args['--mode'];
  const limit = Math.max(1, Math.min(100, Number(args['--limit']) || 10));

  let readStore = null;
  let embedder;
  let source;
  let words;
  try {
    readStore = openMetaStore({ path:dbPath, mode:'readonly' });
    readStore.ensureReady();
    source = readStore.db.prepare("SELECT echo_source_id, state, words_count FROM echo_index_sources WHERE echo_source_id=? AND state='committed'").get(echoSourceId);
    if (!source) fail('ECHO_VECTOR_SOURCE_UNAVAILABLE: explicit source is missing or not committed');
    if (mode==='build') {
      words = readStore.db.prepare('SELECT word_ord,text,content_hash FROM echo_words WHERE echo_source_id=? ORDER BY word_ord').all(echoSourceId);
      if (words.length !== source.words_count) fail('ECHO_VECTOR_SOURCE_STALE: committed word count differs from echo_words');
      if (!words.length) fail('ECHO_VECTOR_SOURCE_EMPTY: source has no words');
    }
  } finally { if (readStore) readStore.close(); }

  embedder = dependencies.createEmbedder
    ? await dependencies.createEmbedder({ modelDir, expectedModelFingerprint:expected })
    : await createBgeEmbedder({ modelDir, expectedModelFingerprint:expected });
  const spec = vectorSpec(embedder.fingerprint);
  if (mode==='build') {
    const embedded = await embedder.embedDocuments(words.map((w)=>w.text));
    const rows = words.map((w,i)=>({ wordOrd:w.word_ord, contentHash:w.content_hash, vector:embedded[i].vector }));
    const writer = openMetaStore({ path:dbPath, mode:'readwrite' });
    try {
      writer.ensureReady();
      const receipt = writer.echoVectorPut(echoSourceId,spec,rows,{mode:'replace'});
      process.stdout.write(JSON.stringify({ok:true,mode:'build',echoSourceId:receipt.echoSourceId,modelKey:receipt.modelKey,rows:receipt.rows})+'\n');
      return 0;
    } finally { writer.close(); }
  }

  const queryResult = await embedder.embedQueries([args['--query']]);
  const reader = openMetaStore({ path:dbPath, mode:'readonly' });
  try {
    reader.ensureReady();
    const model = reader.db.prepare('SELECT model_key FROM echo_vector_models WHERE model_id=? AND model_revision=? AND model_sha256=? AND tokenizer_spec=? AND preprocess_spec=? AND pooling_spec=? AND normalize=? AND dimension=? AND max_seq_length=?').get(
      spec.modelId,spec.revision,spec.modelSha256,spec.tokenizerSpec,spec.preprocessSpec,spec.poolingSpec,spec.normalize?1:0,spec.dimension,spec.maxSeqLength);
    if (!model) fail('ECHO_VECTOR_MODEL_UNAVAILABLE: no vectors for the adapter fingerprint');
    const result = reader.echoVectorSearch(queryResult[0].vector,{modelKey:model.model_key,echoSourceId,limit});
    process.stdout.write(JSON.stringify({ok:true,mode:'search',results:result.results.map((x)=>({ptr:x.ptr,echoSourceId:x.echoSourceId,score:x.score}))})+'\n');
    return 0;
  } finally { reader.close(); }
}
if (process.argv[1] && path.resolve(process.argv[1])===path.resolve(fileURLToPath(import.meta.url))) {
  runVectorCli(process.argv.slice(2)).then((code)=>{process.exitCode=code;}).catch((error)=>{process.stderr.write(String(error&&error.stack||error)+'\n');process.exitCode=1;});
}
