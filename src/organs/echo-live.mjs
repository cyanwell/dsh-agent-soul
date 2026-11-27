// src/organs/echo-live.mjs —— ECHO 实时增量（阶段 3）：把「会话日志 → v10 派生索引」挂进常驻进程
//
// ★★ 为什么是子进程，不是进程内直接调
//   node:sqlite 的 API 是**同步**的。importer 的一个事务要写数万行 words + 两张 FTS +
//   审计行；本机实测单次 1.1 秒起，全量首建更长。同步函数一旦开始就没法中断 ——
//   放进程内，它就变成阶段 1/2 花了两天压掉的那类阻塞（/api/status 被钉死、
//   bridge keeper 判 core 死了、再拉一个 core、两个 core 抢端口）。
//   所以：**写库这件事整个搬到子进程**。父进程只做三件轻活：起进程、读回执、记状态。
//   这与 echo-stats-probe.mjs 是同一条判据 —— 那条已经验证过。
//
// ★★ 为什么读回执而不是读库
//   父进程若自己去查 echo 索引「有多少词」，那又是一次同步 SQL。回执是子进程写的
//   一个小 JSON（几百字节），父进程读文件即可。**读数与写库分离**，两边各自可测。
//
// ★ 边界（写死在这里，别处不再各写一套）
//   · 原始会话日志：子进程只读，一个字节都不写
//   · 02-墨.jsonl：这条链**从不打开**（墨账本不入 SQLite）
//   · data/meta.sqlite：唯一的派生库，只经 importer 的事务写（自带库层护栏与回滚）
//   · 单飞：上一轮没回来，这一轮直接跳过 —— 不排队。
//
// ★ 关停：kill 子进程即可。游标在库里、不在内存里，所以「丢一轮」有界：
//   下一轮从上一代已提交的游标继续，不会重读全量。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

/** 回执文件：状态台 / 排障都读它。★ 只写这一个文件，不碰别的。 */
export function receiptFileOf(dataDir) {
  return path.join(dataDir, 'echo-live.json');
}

/**
 * 建一个 ECHO 实时增量器官。
 *
 * @param {object} o
 * @param {string} o.dataDir      回执落这里
 * @param {string} o.dbPath       v10 meta.sqlite（派生库）
 * @param {string} o.sourceRoot   DSH 会话日志根（只读）
 * @param {string} o.scriptPath   tools/echo-live-sync.mjs 的绝对路径
 * @param {string} [o.vectorizeScriptPath] tools/echo-vectorize-production.mjs 的绝对路径（可选）
 *   ★ 2026-11-20 加：实时链只进词层，不进向量层。不跟这一步，「最近说的话」能 FTS 召回、
 *     却进不了向量召回 —— 而向量检索会被覆盖率闸明确拒绝（ECHO_VECTOR_SOURCE_INCOMPLETE）。
 *     所以增量进词之后必须跟着补向量，否则向量层永远是「上次跑完那一刻」的快照。
 * @param {number} [o.intervalSec=120]
 * @param {string} [o.nodePath]   用哪个 node 起子进程（默认 process.execPath）
 * @param {function} [o.log]
 */
export function createEchoLive(o) {
  const opts = o || {};
  const dataDir = String(opts.dataDir || '');
  const dbPath = String(opts.dbPath || '');
  const sourceRoot = String(opts.sourceRoot || '');
  const scriptPath = String(opts.scriptPath || '');
  const vectorizeScriptPath = String(opts.vectorizeScriptPath || '');
  const windowVectorizeScriptPath = String(opts.windowVectorizeScriptPath || '');
  const intervalSec = Number(opts.intervalSec) > 0 ? Number(opts.intervalSec) : 120;
  const nodePath = String(opts.nodePath || process.execPath);
  // ★ 2026-11-17：把「正在跑 ECHO 子进程」这一段标进阻塞探针的 phase，
  //   否则它造成的同步阻塞在 loop-stall.log 里会被记成 running，归不了因。
  const setPhase = typeof opts.setPhase === 'function' ? opts.setPhase : () => {};
  const log = typeof opts.log === 'function' ? opts.log : (() => {});
  const receiptFile = dataDir ? receiptFileOf(dataDir) : '';

  let timer = null;
  let child = null;
  let running = false;
  let stopped = false;
  const stats = {
    rounds: 0, imported: 0, unchanged: 0, failed: 0,
    lastCode: null, lastAt: null, lastMs: null, lastError: null,
    lastWords: null, lastGeneration: null, consecutiveFailures: 0,
    vectorRuns: 0, vectorFailures: 0, lastVector: null,
    // 2026-11-27: second vector layer (sentence windows), independent counters.
    windowRuns: 0, windowFailures: 0, lastWindow: null,
    // 2026-11-27: second vector layer (sentence windows), its own counters.
    // Same rule as vectors: failures here never change the sync ok/code.
    windowRuns: 0, windowFailures: 0, lastWindow: null,
  };

  /**
   * 补向量：把这一轮新进的词写成 BGE 向量。
   * ★ 与同步严格分开计：向量失败**不改**同步的 ok/code，只记 lastVector。
   *   判据：两件事各有各的权威（词层覆盖 vs 向量层覆盖），混成一个数会互相掩盖。
   */
  function vectorize() {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const vChild = spawn(nodePath, [vectorizeScriptPath, '--yes-production', '--db=' + dbPath], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: Object.assign({}, process.env, { AGENT_SOUL_ECHO_LIVE: '1' }),
      });
      let vOut = '';
      vChild.stdout.on('data', (d) => { vOut = (vOut + d.toString('utf8')).slice(-262144); });
      vChild.stderr.on('data', () => {});
      vChild.on('error', (e) => resolve({ ok: false, code: 'VECTOR_CHILD_ERROR', error: String((e && e.message) || e) }));
      vChild.on('close', (code) => {
        const line = lastJsonLine(vOut);
        if (line) resolve(Object.assign({ ok: true, ms: Date.now() - t0 }, line));
        else resolve({ ok: false, code: 'VECTOR_EXIT_' + code, error: String(vOut).slice(-200) || 'no output', ms: Date.now() - t0 });
      });
    });
  }

  /** 上一轮回执。读不到就 null —— 不编一个空对象冒充「没变化」。 */
  /**
   * 2026-11-27: sentence-window vectors (the second vector layer).
   * Isolation rule is the same as long-text vectors: a failure here is recorded
   * in lastWindow only and never changes the sync verdict.
   * Uses --incremental: resumes from the covered MAX(word_ord), never clears
   * existing windows, and is bounded per call. This runs every 120s, so it
   * must never use full-rebuild arguments.
   */
  function windowize() {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const wChild = spawn(nodePath, [windowVectorizeScriptPath, '--yes-production', '--incremental', '--db', dbPath], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: Object.assign({}, process.env, { AGENT_SOUL_ECHO_LIVE: '1' }),
      });
      let wOut = '';
      wChild.stdout.on('data', (d) => { wOut = (wOut + d.toString('utf8')).slice(-262144); });
      wChild.stderr.on('data', () => {});
      wChild.on('error', (e) => resolve({ ok: false, code: 'WINDOW_CHILD_ERROR', error: String((e && e.message) || e) }));
      wChild.on('close', (code) => {
        const line = lastJsonLine(wOut);
        if (line) resolve(Object.assign({ ok: true, ms: Date.now() - t0 }, line));
        else resolve({ ok: false, code: 'WINDOW_EXIT_' + code, error: String(wOut).slice(-200) || 'no output', ms: Date.now() - t0 });
      });
    });
  }

  function lastReceipt() {
    if (!receiptFile) return null;
    try { return JSON.parse(fs.readFileSync(receiptFile, 'utf8')); } catch { return null; }
  }

  function writeReceipt(rec) {
    if (!receiptFile) return;
    try {
      fs.mkdirSync(path.dirname(receiptFile), { recursive: true });
      fs.writeFileSync(receiptFile, JSON.stringify(rec, null, 1), 'utf8');
    } catch { /* 回执写不进去不许影响主服务 */ }
  }

  /** 从一段输出里取最后一个 JSON 对象（子进程可能先打警告再打回执）。 */
  function lastJsonLine(text) {
    const s = String(text == null ? '' : text);
    const whole = s.trim();
    if (whole) { try { const j = JSON.parse(whole); if (j && typeof j === 'object') return j; } catch { /* 不是纯 JSON */ } }
    // ★★ 2026-11-17（真 bug）：**回执可能是多行格式化的 JSON**。
    //   原实现按「行」找，只认首字符是 '{' 的行 —— 于是 pretty 打印的回执
    //   最后一行是 '}'，一行都匹配不上，解析恒为 null，
    //   于是一次**成功**的同步被记成 EXIT_0 失败（生产实测：库从 gen4 推到 gen6，回执说失败）。
    //   ★ 判据：从最近的 '{' 一直解析到**结尾**，而不是只解析那一行。
    const starts = [];
    for (let i = 0; i < s.length; i += 1) {
      if (s[i] === '{' && (i === 0 || s[i - 1] === '\n')) starts.push(i);
    }
    for (let k = starts.length - 1; k >= 0; k -= 1) {
      try { const j = JSON.parse(s.slice(starts[k])); if (j && typeof j === 'object') return j; } catch { /* 继续往前一个 */ }
    }
    return null;
  }

  /**
   * 跑一轮。★ 单飞：running 为真时直接返回 { skipped: 'busy' }，不排队。
   */
  function runOnce(why) {
    if (stopped) return Promise.resolve({ skipped: 'stopped' });
    if (running) return Promise.resolve({ skipped: 'busy' });
    if (!dbPath || !sourceRoot || !scriptPath) return Promise.resolve({ skipped: 'unconfigured' });
    running = true;
    stats.rounds += 1;
    try { setPhase('echo-live'); } catch { /* ignore */ }
    const t0 = Date.now();

    return new Promise((resolve) => {
      let out = '', err = '', settled = false;
      // 每轮一个临时回执文件；读完即删，不留在 data 目录里污染。
      const receiptPath = path.join(os.tmpdir(), 'echo-live-receipt-' + process.pid + '-' + Date.now() + '.json');
      const finish = (r) => {
        if (settled) return;
        settled = true;
        running = false;
        // 回执文件读完即删（失败路径也删，避免 tmp 里堆一堆半截文件）。
        try { fs.rmSync(receiptPath, { force: true }); } catch { /* ignore */ }
        child = null;
        const ms = Date.now() - t0;
        stats.lastAt = new Date().toISOString();
        stats.lastMs = ms;
        const rec = {
          at: stats.lastAt, why: why || 'timer', ms,
          code: r.code || null, ok: r.ok !== false,
          generation: r.generation === undefined ? null : r.generation,
          // Keep attempt/commit authority visible to the parent organ; old fields remain below.
          attemptId: r.attemptId === undefined ? null : r.attemptId,
          attempt: r.attempt === undefined ? null : r.attempt,
          commitId: r.commitId === undefined ? null : r.commitId,
          commit: r.commit === undefined ? null : r.commit,
          authority: r.authority === undefined ? null : r.authority,
          words: r.counts ? r.counts.words : null,
          summaries: r.counts ? r.counts.summaries : null,
          bytesRead: r.tail ? r.tail.bytesRead : null,
          appended: r.tail ? r.tail.appended : null,
          skippedUnchanged: r.tail ? r.tail.skippedUnchanged : null,
          // ★★ 2026-11-22：**字段名不一致，把唯一能看懂的那句话吃掉了。**
          //   回执（tools/echo-live-sync.mjs 的失败分支）写的是 `message`，
          //   而这里读的是 `error` → 永远 null → 面板上只剩 `E_UNEXPECTED`。
          //   ★ 症状：一个**看得懂的**真 bug（sid 含 ~ 被拒），显示成「未知」。
          //   我因此先怀疑了配置、又怀疑了数据目录，绕了两圈才拿到原文。
          //   判据：**兜底包装可以，但兜底不许把原始信息丢掉。**
          error: r.error || r.message || null,
          stage: r.stage || null,
        };
        stats.lastCode = rec.code;
        stats.lastError = rec.error;
        if (rec.code) stats.lastGeneration = rec.generation;
        if (rec.words !== null) stats.lastWords = rec.words;
        if (rec.ok) {
          stats.consecutiveFailures = 0;
          if (rec.code === 'IMPORTED') stats.imported += 1; else stats.unchanged += 1;
        } else {
          stats.failed += 1;
          stats.consecutiveFailures += 1;
        }
        try { setPhase('running'); } catch { /* ignore */ }
        writeReceipt(rec);
        if (!rec.ok) log('[echo-live] ' + (rec.code || 'FAILED') + '（' + (rec.stage || '?') + '，' + ms + 'ms）：' + String(rec.error || '').slice(0, 200));
        else if (rec.code === 'IMPORTED') log('[echo-live] 第 ' + rec.generation + ' 代 · ' + rec.words + ' 词 · 读 ' + rec.bytesRead + 'B · ' + ms + 'ms');
        // ★ 2026-11-20：同步成功且**确实进了新词**才补向量。
        //   没配 vectorizeScriptPath 就跳过（不假装跑过）；UNCHANGED 也不用跑（没有新词）。
        if (rec.ok && rec.code === 'IMPORTED' && vectorizeScriptPath) {
          running = true; // 向量阶段仍算「在跑」：单飞判据必须覆盖整轮
          vectorize().then((v) => {
            stats.vectorRuns += 1;
            if (!v.ok) stats.vectorFailures += 1;
            stats.lastVector = {
              at: new Date().toISOString(), ok: v.ok === true, code: v.code || null,
              ms: v.ms === undefined ? null : v.ms,
              vectors: v.vectors === undefined ? null : v.vectors,
              expected: v.expected === undefined ? null : v.expected,
              complete: v.complete === undefined ? null : v.complete,
              error: v.error || null,
            };
            if (!v.ok) log('[echo-live] 向量补跑失败（' + (v.code || '?') + '）：' + String(v.error || '').slice(0, 160));
            try { setPhase('running'); } catch { /* ignore */ }
            running = false;
            // 回执照实带上向量这一步：同一份文件里，两件事各自有结论
            try { const cur = lastReceipt() || {}; cur.vector = stats.lastVector; writeReceipt(cur); } catch { /* ignore */ }
            const finish = () => {
              running = false;
              try { const cur = lastReceipt() || {}; cur.vector = stats.lastVector; cur.window = stats.lastWindow; writeReceipt(cur); } catch { /* ignore */ }
              resolve(Object.assign({}, rec, { vector: stats.lastVector, window: stats.lastWindow }));
            };
            // 2026-11-27: run the sentence-window layer after long-text vectors.
            // Separate counters, separate failure path; skip cleanly when unconfigured.
            if (!windowVectorizeScriptPath) { finish(); return; }
            windowize().then((w) => {
              stats.windowRuns += 1;
              if (!w.ok) stats.windowFailures += 1;
              stats.lastWindow = {
                at: new Date().toISOString(), ok: w.ok === true, code: w.code || null,
                ms: w.ms === undefined ? null : w.ms,
                windowsWritten: w.windowsWritten === undefined ? null : w.windowsWritten,
                skipped: w.skipped || null,
                error: w.error || null,
              };
              if (!w.ok) log('[echo-live] window vector failed (' + (w.code || '?') + '): ' + String(w.error || '').slice(0, 160));
              try { setPhase('running'); } catch { /* ignore */ }
              finish();
            });
          });
          return;
        }
        resolve(rec);
      };

      try {
        // ★★ 2026-11-17：**回执走文件，不走 stdout**。
        //   实测：回执随会话数增长（1,609 个文件的游标约 200KB+），走管道会与
        //   ExperimentalWarning 混在一起、还可能被截断，结果一次成功的同步被记成
        //   「EXIT_0 失败」（库事实是 gen4 → gen6 都推进了）。
        //   ★ 判据：**成功与否不该依赖解析一个可能被截断的文本流**。
        child = spawn(nodePath, [scriptPath, '--db', dbPath, '--source-root', sourceRoot, '--json', '--receipt-file', receiptPath], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: Object.assign({}, process.env, { AGENT_SOUL_ECHO_LIVE: '1' }),
        });
      } catch (e) {
        finish({ ok: false, code: 'SPAWN_FAILED', error: String((e && e.message) || e) });
        return;
      }

      // ★★ 2026-11-17（真 bug）：**回执比 64KB 大**。
      //   回执里的 cursor.files 是每个会话文件的 mtime:size 游标，本机 1,609 个会话
      //   约 200KB+ —— 而这里原来只留最后 64KB，于是 JSON 的**开头被切掉**，
      //   解析恒失败，一次成功的同步被记成 EXIT_0 失败（库其实已从 gen4 推到 gen6）。
      //   ★ 判据：捕获上限必须大于「最坏情况的回执」，不是「差不多够了」。
      child.stdout.on('data', (d) => { out = (out + d.toString('utf8')).slice(-1048576); });
      child.stderr.on('data', (d) => { err = (err + d.toString('utf8')).slice(-4096); });
      child.on('error', (e) => finish({ ok: false, code: 'CHILD_ERROR', error: String((e && e.message) || e) }));
      child.on('close', (code) => {
        // 先读回执文件（确定性），再退回解析 stdout（兜底）
        let parsed = null;
        try { if (receiptPath && fs.existsSync(receiptPath)) parsed = JSON.parse(fs.readFileSync(receiptPath, 'utf8')); } catch { parsed = null; }
        if (!parsed) parsed = lastJsonLine(out);
        if (parsed && parsed.ok === false) return finish(parsed);
        if (code !== 0 || !parsed) {
          // ★ 失败也要说清是哪一步：子进程 stderr 里那行 JSON 带 stage（它自己标的）
          const e = lastJsonLine(err);
          return finish({
            ok: false,
            code: (e && e.code) || ('EXIT_' + code),
            stage: e && e.stage,
            error: (e && e.message) || String(err).slice(-300) || 'no output',
          });
        }
        finish(parsed);
      });
    });
  }

  function start() {
    if (timer || stopped) return { started: false, reason: timer ? 'already' : 'stopped' };
    // 首次延后 30 秒：启动期（建索引 / 书房核对 / 同步首轮）已经够忙，别在这时候再起一个写库进程。
    const first = setTimeout(() => { runOnce('first'); }, 30_000);
    first.unref?.();
    timer = setInterval(() => { runOnce('timer'); }, intervalSec * 1000);
    timer.unref?.();
    return { started: true, intervalSec, dbPath, sourceRoot };
  }

  function stop(reason) {
    stopped = true;
    if (timer) { clearInterval(timer); timer = null; }
    if (child) { try { child.kill(); } catch { /* 杀不掉就算了，它会自己退 */ } child = null; }
    running = false;
    return { stopped: true, why: reason || 'stop' };
  }

  function view() {
    return {
      enabled: Boolean(timer), intervalSec,
      dbPath: dbPath || null, sourceRoot: sourceRoot || null,
      receiptFile: receiptFile || null,
      running,
      stats: Object.assign({}, stats),
      last: lastReceipt(),
    };
  }

  return { start, stop, runOnce, view, receiptFile };
}