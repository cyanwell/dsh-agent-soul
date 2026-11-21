// src/db/echo-stats-probe.mjs —— ECHO 索引体检，跑在**子进程**里（阶段 2 · 2026-11-17）
//
// ★★ 为什么必须是子进程：
//   node:sqlite 的 API 是**同步**的。echoStats 里那几条 FTS5 全表 GROUP BY 与
//   UNINDEXED 列上的孤儿检查，实测单条 1.1~1.6 秒、整体十几秒到几十秒。
//   同步函数一旦开始就没法中断 —— 放在请求路径上，等于把 /api/status 与 /api/organs
//   一起钉死，接着 /api/health 超时、bridge keeper 判定 core 死了、再拉一个 core，
//   两个 core 抢同一个端口和同一份缓存。**那是一条已经发生过的级联。**
//   挪到子进程之后：它慢多久都与 core 无关，core 只读一个几百字节的 JSON。
//
// ★★ 为什么分阶段写盘（而不是一次算完再写）：
//   实测「算完再写」有一次 100 秒没写出任何东西 —— 于是父进程永远看到「没有读数」。
//   分阶段写，至少能看出**卡在哪一步**，而且第一步的结论（来源数 / 词数）先可用。
//
// ★★ 为什么默认跳过孤儿检查：
//   echoOrphanFts 的两条查询（NOT IN / LEFT JOIN on FTS5）各 1.4~1.6 秒，
//   而它们查的是「FTS 里有、来源表里没有」的行 —— 那是导入中途崩掉才可能出现的状态。
//   日常体检用不着每次都付这笔钱。要查就传 --deep。
//
// 用法：
//   node src/db/echo-stats-probe.mjs <out.json> <meta.sqlite> [--deep]
// 退出码：0 成功 / 3 出错（两种都写文件 —— 「这次没算出来」本身就是要被看见的信息）

import fs from 'node:fs';
import path from 'node:path';
import { openMetaStore } from './index.mjs';
import { echoIndexInfo, echoOrphanFts } from './echo-integrity.mjs';

const outPath = process.argv[2];
const dbPath = process.argv[3];
const deep = process.argv.includes('--deep');

if (!outPath || !dbPath) {
  process.stderr.write('usage: echo-stats-probe.mjs <out.json> <meta.sqlite> [--deep]\n');
  process.exit(2);
}

const startedAt = Date.now();
const steps = [];

function writeOut(obj) {
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(obj, null, 1), 'utf8');
    return true;
  } catch { return false; }
}

function step(name, ms) {
  steps.push({ name, ms });
  try { process.stderr.write('[probe] ' + name + ' ' + ms + 'ms\n'); } catch { /* ignore */ }
}

// 立刻写一个「已开始」的占位 —— 父进程据此知道有人在算，而不是「从没算过」
writeOut({ ok: false, at: new Date().toISOString(), stage: 'starting', db: dbPath, steps: [] });

let store = null;
try {
  let t = Date.now();
  store = openMetaStore({ path: dbPath, mode: 'readonly' });
  step('open', Date.now() - t);

  t = Date.now();
  const info = echoIndexInfo(store.db);
  step('echoIndexInfo', Date.now() - t);

  const partial = {
    ok: true,
    at: new Date().toISOString(),
    stage: deep ? 'info-done' : 'done',
    ms: Date.now() - startedAt,
    db: dbPath,
    steps,
    // ★ echoIndexInfo 跑通了就等于「v9 表齐、能读」；表不在时它会抛，走 catch 那条路
    available: true,
    sources: info.sources.length,
    words: info.words,
    summaries: info.summaries,
    aligned: info.aligned,
    searchable: info.aligned,
    orphanWords: null,
    orphanSummaries: null,
    problemKinds: info.aligned ? [] : ['misaligned'],
    problems: info.aligned ? 0 : 1,
  };
  if (!deep) { writeOut(partial); process.exit(0); }

  t = Date.now();
  let orphan = { words: null, summaries: null };
  try { orphan = echoOrphanFts(store.db); } catch { /* 查不了就不报数，不写 0 */ }
  step('echoOrphanFts', Date.now() - t);

  const orphanWords = Number.isFinite(orphan.words) ? orphan.words : null;
  const orphanSummaries = Number.isFinite(orphan.summaries) ? orphan.summaries : null;
  const kinds = [];
  if (!info.aligned) kinds.push('misaligned');
  if (orphanWords) kinds.push('orphan-words-fts');
  if (orphanSummaries) kinds.push('orphan-summaries-fts');

  writeOut(Object.assign({}, partial, {
    stage: 'done',
    ms: Date.now() - startedAt,
    steps,
    orphanWords,
    orphanSummaries,
    problemKinds: kinds,
    problems: kinds.length,
  }));
  process.exit(0);
} catch (e) {
  writeOut({
    ok: false,
    at: new Date().toISOString(),
    stage: 'error',
    ms: Date.now() - startedAt,
    db: dbPath,
    steps,
    available: false,
    error: String((e && e.message) || e).slice(0, 400),
  });
  process.exit(3);
} finally {
  try { if (store && typeof store.close === 'function') store.close(); } catch { /* ignore */ }
}
