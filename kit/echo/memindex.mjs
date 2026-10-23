// memindex.mjs —— 记忆中枢 · L4 索引层构建器
//
// ── 它解决什么 ──
// 会话日志（865 个 / 156 MB）里躺着两样最值钱、却一直没有索引的东西：
//   1) 每次上下文压缩留下的摘要 —— 这些摘要**现在还活在我的上下文里**，但**没有回到原文的指针**；
//   2) 人（爀曦）说过的原话 —— 一手层的脊柱，但只能靠全文检索碰运气找。
// 本脚本把这两样抽出来，**每条都带上回到原文的指针**（日志路径 + seq 范围），写成 jsonl 索引。
//
// ── 设计原则（摘自设计提案 §4）──
//   ★ 摘要只能是索引，不能是记忆本体 ⇒ 每条摘要必须带 src（日志 + seqs）。
//   ★ 摘要可以被吊销而不被删 ⇒ status: active | void（吊销靠追加，不改旧行）。
//   ★ 时间是一等公民 ⇒ 每条带 t（本地 ISO）。
//   ★ 不做第五个库 ⇒ 数据仍在原处，这里只放指针和逐字片段。
//
// ── 用法 ──
//   node memindex.mjs build [--all] [--ws <子串>] [--since <ISO>] [--force]
//   node memindex.mjs stats
//   node memindex.mjs verify
//
// 增量：index/files.jsonl 记每个日志的 mtime+size，未变则跳过（--force 强制重扫）。

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import * as CFG from "./echo-config.mjs";
// ★★★ 2026-10-08 修复：索引层原先把日志名写死成 `session.v3.jsonl.zstd`（见下面 findLogs）。
//   宿主升到 v4 之后，**新会话一个都进不了索引**，表现是「索引停在 10-04 就再也不更新了」。
//   现在改成版本无感：认 /^session\.v\d+\.jsonl\.zstd$/（见下面 findLogs）。

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const SESSIONS = CFG.SESSIONS;
const HUB = CFG.HUB;
const IDX = path.join(HUB, "index");
const F_SUMMARY = path.join(IDX, "summaries.jsonl");
const F_WORDS = path.join(IDX, "words.jsonl");
const F_FILES = path.join(IDX, "files.jsonl");
const F_META = path.join(IDX, "meta.json");

// ── 参数 ──
const argv = process.argv.slice(2);
const cmd = argv.shift() || "stats";
const opt = (name, def) => {
  const i = argv.indexOf(name);
  if (i === -1) return def;
  const v = argv[i + 1];
  argv.splice(i, v !== undefined && !v.startsWith("--") ? 2 : 1);
  return v === undefined ? true : v;
};
const ALL = opt("--all", false);
const WS = opt("--ws", null);
const SINCE = opt("--since", null);
const FORCE = opt("--force", false);

// ── 工具 ──
const localIso = (ms) => {
  if (!ms) return null;
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

function decodeZstd(p) {
  const buf = fs.readFileSync(p);
  const frames = [];
  let s = buf.indexOf(MAGIC, 0);
  while (s >= 0) {
    let e = buf.indexOf(MAGIC, s + 4);
    if (e < 0) e = buf.length;
    frames.push(buf.subarray(s, e));
    s = buf.indexOf(MAGIC, e);
  }
  // ★★ 2026-10-23 修复：原来把全部帧 concat 成一个巨串再 toString。
  //   会话日志压缩后可以到 200+ MB，解压后超过 Node 的字符串上限（0x1fffffe8 ≈ 512 MB），
  //   抛 ERR_STRING_TOO_LONG。两个表现，都很像别的问题：
  //     建索引 → 报「解码失败 N 条」，看上去像个别坏帧；
  //     memq open → 直接崩，于是**门牌打不开**（门牌本身是对的，门后面堵着）。
  //   改成【逐帧解码 → 逐帧按行切 → carry 跨帧续行】，内存里永远不出现完整巨串。
  //   ★ carry 不能省：一行 JSON 可能跨帧，直接逐帧 split 会截断那一行、静默丢记录。
  //   ★ 索引和 open 是两份实现，**一处修了另一处没修**过（2026-10-23 当天踩到）。
  const recs = [];
  const MAX_LINE = 8 * 1024 * 1024;   // 单行上限 8 MB：超长行对检索没价值，丢掉
  let carry = "";
  const take = (line) => {
    if (line.length > MAX_LINE) return;
    const t = line.trim();
    if (!t) return;
    try { recs.push(JSON.parse(t)); } catch { /* 非 JSON 行 */ }
  };
  for (const f of frames) {
    let out;
    try { out = zlib.zstdDecompressSync(f); } catch { continue; }
    let str;
    try { str = out.toString("utf8"); } catch { continue; }
    const parts = (carry + str).split("\n");
    carry = parts.pop() || "";
    for (const line of parts) take(line);
    if (carry.length > MAX_LINE) carry = "";
  }
  if (carry) take(carry);
  return { recs, frames: frames.length };
}

// ★ 一条压缩记录「被替换掉的是哪一段」。优先 shadowedSeqs，但它可能是空数组
//   （实测 compactionId=92bab4ca…：shadowedSeqs=[] 而 shadowedRange={73,111}）
//   ⇒ 空的时候必须回落到 shadowedRange，否则一条真能还原的记录会被判成"找不到原文"。
const srcSeqsFor = (d) => (Array.isArray(d.shadowedSeqs) && d.shadowedSeqs.length)
  ? d.shadowedSeqs
  : (d.shadowedRange ? [d.shadowedRange.start, d.shadowedRange.end] : null);

const blockText = (content) => {  if (!Array.isArray(content)) return "";
  return content.map((c) => (c && typeof c.text === "string" ? c.text : "")).join("");
};

// ★ 注入段是**接在人话后面**的（system-reminder / MNEMON 快照 / checkpoint 摘要…），
//   所以不能整条判为「注入」扔掉 —— 要**从第一个标记处截断**，留下前面他真正说的那句。
const MARKERS = [
  "<system-reminder>",
  "MNEMON RUNTIME MEMORY SNAPSHOT",
  "[MNEMON 探针",
  "[Model-written summary",
  "This is an automatically generated checkpoint",
  "Current runtime context.",
  "Instructions from:",
  "This is an efficiency nudge",
  "MNEMON VIEW TOOLS",
];
// ★ 前缀黑名单：整条都不是人话的（分会话封存胶囊、空输出占位、自动摘要…）
const BLACKLIST = [
  "Bounded completed checkpoint",
  "[Model-written summary",
  "[no visible output",
  "This is an automatically generated checkpoint",
  "[MNEMON",
];
function humanPart(s) {
  let cut = s.length;
  for (const m of MARKERS) {
    const i = s.indexOf(m);
    if (i >= 0 && i < cut) cut = i;
  }
  const out = s.slice(0, cut).trim();
  for (const b of BLACKLIST) if (out.startsWith(b)) return "";
  return out;
}

// ★ 有些 user/message 是**别的通道的程序提示词**（QQ 小鲸鱼的群友角色卡、黑话学习器的抽取指令），
//   不是爀曦说的话。标成 task，检索时可以按 kind 分开，别让它们冒充「一手原话」。
const TASKISH = ["【当前时间】", "你是一个", "你是「", "# 角色卡", "请从下面", "以下是", "角色："];
function kindOf(text, ws) {
  if (/state-agents|slang-agent|qq-bridge/.test(ws)) return "task";
  for (const k of TASKISH) if (text.startsWith(k)) return "task";
  return "human";
}

// 从一条 assistant/message 里抽 reasoning/正文/工具数（给发作分析复用）
function contentCounts(m) {
  let reasoning = 0, text = 0, tools = 0;
  for (const c of (m.content || [])) {
    if (c.type === "reasoning") reasoning += (c.text || "").length;
    else if (c.type === "text") text += (c.text || "").length;
    else if (c.type === "tool-call") tools++;
  }
  return { reasoning, text, tools };
}

// ── 找会话日志 ──
function findLogs() {
  const out = [];
  if (!fs.existsSync(SESSIONS)) return out;
  for (const wsDir of fs.readdirSync(SESSIONS)) {
    const wsPath = path.join(SESSIONS, wsDir);
    if (!fs.statSync(wsPath).isDirectory()) continue;
    for (const sid of fs.readdirSync(wsPath)) {
      const sd = path.join(wsPath, sid);
      if (!fs.statSync(sd).isDirectory()) continue;
      // ★ 2026-10-08 修复：版本无感 —— 认任何 session.v<N>.jsonl.zstd。
      //   原来写死 v3，宿主升 v4 之后**新会话一个都进不了索引**（表现：索引停在 10-04 不再更新）。
      //   同一会话多版本各算一份：增量是按「文件路径」去重的，v3 那份不再变、会被跳过，v4 持续更新。
      for (const n of fs.readdirSync(sd)) {
        if (!/^session\.v\d+\.jsonl\.zstd$/.test(n)) continue;
        out.push({ file: path.join(sd, n), ws: wsDir, sid });
      }
    }
  }
  return out;
}

// ── build ──
if (cmd === "build") {
  fs.mkdirSync(IDX, { recursive: true });
  const prev = new Map();
  if (fs.existsSync(F_FILES) && !FORCE) {
    for (const line of fs.readFileSync(F_FILES, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); prev.set(r.file, r); } catch {}
    }
  }

  let logs = findLogs();
  if (WS && WS !== true) logs = logs.filter((l) => l.ws.includes(WS));
  logs.sort((a, b) => fs.statSync(b.file).mtimeMs - fs.statSync(a.file).mtimeMs);
  console.log(`找到 ${logs.length} 个会话日志${WS ? `（--ws ${WS}）` : ""}`);

  const sumLines = [], wordLines = [], fileLines = [];
  let nSum = 0, nWord = 0, skipped = 0, done = 0, failed = 0;
  const t0 = Date.now();

  for (const L of logs) {
    const st = fs.statSync(L.file);
    const key = `${st.mtimeMs}:${st.size}`;
    const p = prev.get(L.file);
    if (p && p.key === key && !FORCE) {
      // 未变 —— 沿用旧行
      skipped++;
      try {
        for (const line of fs.readFileSync(p.sumOut, "utf8").split("\n")) if (line.trim()) sumLines.push(line);
        for (const line of fs.readFileSync(p.wordOut, "utf8").split("\n")) if (line.trim()) wordLines.push(line);
      } catch { skipped--; }
      fileLines.push(JSON.stringify(p));
      continue;
    }

    let recs;
    try { recs = decodeZstd(L.file).recs; } catch { failed++; continue; }
    const sumOut = [], wordOut = [];

    for (const r of recs) {
      const t = localIso(r.time);
      if (SINCE && SINCE !== true && t && t < String(SINCE)) continue;

      if (r.type === "compaction/summary") {
        const d = r.data || {};
        const text = blockText(d.summary) || (typeof d.rawOutput === "string" ? d.rawOutput : "");
        if (!text) continue;
        sumOut.push(JSON.stringify({
          id: `cmp-${String(d.compactionId || "").slice(0, 8)}`,
          t, session: L.sid, ws: L.ws,
          log: L.file,
          // ★ 定位信息必须**能指回原文**（判据与回落逻辑见顶部 srcSeqsFor 的注释）
          srcSeqs: srcSeqsFor(d),
          shadowedTokens: d.shadowedTokenCount ?? null,
          chars: text.length,
          provider: d.provider || null, model: d.model || null,
          status: "active",
          summary: text,
          // ★★ manifest：给摘要配一张「被替换掉那一段里有什么」的清单。
          //   为什么需要它（爀曦 2026-09-26 定的规矩）：
          //   「数据一旦被压缩就失真」—— 但数据其实删不掉，它永远在磁盘上。
          //   真正的风险是**我以后不知道那段数据存在过**。
          //   所以这里**只点位置和名字，不做任何转述** —— 因此零失真。
          //   摘要负责讲大意，manifest 负责点清东西还在不在，指针负责回去拿。
          manifest: (() => {
            const sq = srcSeqsFor(d);
            if (!sq || !sq.length) return null;
            // ★★ 这里踩过一次坑：srcSeqs 是**整个 seq 列表**，不是 [首, 尾] 两元组。
            //   我第一版写成 lo[1] 当上界 —— 于是清单只扫了前两条记录，而它**看起来是对的**。
            //   上界必须取最后一个元素。
            const lo = sq[0], hi = sq[sq.length - 1];
            const inR = recs.filter((x) => x.seq >= lo && x.seq <= hi);
            const types = {}, tools = {}, files = new Set(), marks = [];
            for (const x of inR) {
              types[x.type] = (types[x.type] || 0) + 1;
              const js = JSON.stringify(x.data ?? {});
              if (x.type === "tool/call") {
                const nm = (js.match(/"name"\s*:\s*"([^"]{1,40})"/) || [])[1] || "?";
                tools[nm] = (tools[nm] || 0) + 1;
                // ★ 路径在 JSON 文本里是转义的（`D:\\AI\\…`），所以正则要认**两个反斜杠**；
                //   第一版只认单个，于是「文件的地址」这一栏永远是空的 —— 而它正是要保的三样之一。
                //   用 `[A-Z]:`（大写盘符）避开 `http://` 这类误匹配。
                for (const m of js.matchAll(/[A-Z]:[\\/]{1,2}[^"\\\n]{2,160}/g)) {
                  files.add(m[0].replace(/\\\\/g, "\\").replace(/\\\//g, "/").replace(/[',;:)\]}]+$/, ""));
                }
              }
              if (marks.length < 30) {
                const h = x.type === "user/message" ? humanPart(blockText((x.data && x.data.content) || ""))
                  : x.type === "assistant/message" ? blockText(x.data && x.data.message && x.data.message.content)
                    : js.slice(0, 160);
                marks.push({ seq: x.seq, type: x.type, head: String(h || "").replace(/\s+/g, " ").slice(0, 70) });
              }
            }
            return { range: [lo, hi], n: inR.length, types, tools, files: [...files].slice(0, 40), marks };
          })(),
        }));
        nSum++;
      }

      if (r.type === "user/message") {
        // ★ user/message 的内容在 data.content 上；assistant/message 才用 data.message.content。
        const d = r.data || {};
        const raw = (blockText(d.content) || blockText(d.message && d.message.content)).trim();
        const text = humanPart(raw);
        if (!text) continue;
        const CAP = 4000;
        wordOut.push(JSON.stringify({
          t, session: L.sid, ws: L.ws,
          seq: r.seq, turn: (r.data && r.data.turn) ?? null,
          log: L.file,
          kind: kindOf(text, L.ws),
          len: text.length, truncated: text.length > CAP,
          text: text.length > CAP ? text.slice(0, CAP) : text,
        }));
        nWord++;
      }

      // ★ 爀曦 2026-09-26 的规矩：「你的推理的结果，不允许被摘要，因为结果被摘要也会失真，
      //   变成二手的结果，会让你误判，一定要保留原文。」
      //   推理通道（reasoning）本身是**过程**；推理的**结果落在我写下的正文里** ——
      //   所以正文必须逐字留一份、带指针。
      //   ★★ 这里刻意**不做判断**：不去判"哪一句是结论" —— 判断本身就是失真。凡正文，全留。
      if (r.type === "assistant/message") {
        const m = r.data && r.data.message;
        // ★★ 只取 type==="text" 的块 —— **不能复用 blockText**，它把所有带 text 的块都拼起来，
        //   连 reasoning 一起算进正文。踩过：复用之后 words.jsonl 从 3.75 MB 涨到 42 MB、
        //   条目从 1652 涨到 15364，检索命中的全是思考过程（"Let me analyze this checkpoint…"）。
        //   要的是**推理的结果**（正文），不是推理的过程。
        const text = (Array.isArray(m && m.content) ? m.content : [])
          .filter((c) => c && c.type === "text" && typeof c.text === "string")
          .map((c) => c.text).join("").trim();
        if (!text) continue;
        const CAP = 4000;
        wordOut.push(JSON.stringify({
          t, session: L.sid, ws: L.ws, seq: r.seq,
          turn: (r.data && r.data.turn) ?? null,
          log: L.file, role: "assistant", kind: "结论",
          len: text.length, truncated: text.length > CAP,
          text: text.length > CAP ? text.slice(0, CAP) : text,
        }));
        nWord++;
      }
    }

    // 落每文件的小分片，供下次增量复用
    const shardDir = path.join(IDX, "shards");
    fs.mkdirSync(shardDir, { recursive: true });
    const base = L.sid.replace(/[^\w.-]/g, "_");
    const sumF = path.join(shardDir, `${base}.sum.jsonl`);
    const wordF = path.join(shardDir, `${base}.word.jsonl`);
    fs.writeFileSync(sumF, sumOut.join("\n"), "utf8");
    fs.writeFileSync(wordF, wordOut.join("\n"), "utf8");

    for (const l of sumOut) sumLines.push(l);
    for (const l of wordOut) wordLines.push(l);
    fileLines.push(JSON.stringify({ file: L.file, key, ws: L.ws, sid: L.sid, nSum: sumOut.length, nWord: wordOut.length, sumOut: sumF, wordOut: wordF }));

    if (++done % 50 === 0) console.log(`  已扫 ${done} 个（摘要 ${nSum} / 原话 ${nWord}），${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }

  // ★ 按时间排序落盘 —— 不排序的话「最后几条」就不是最新的
  sumLines.sort((a, b) => String(JSON.parse(a).t).localeCompare(String(JSON.parse(b).t)));
  wordLines.sort((a, b) => String(JSON.parse(a).t).localeCompare(String(JSON.parse(b).t)));

  fs.writeFileSync(F_SUMMARY, sumLines.join("\n"), "utf8");
  fs.writeFileSync(F_WORDS, wordLines.join("\n"), "utf8");
  fs.writeFileSync(F_FILES, fileLines.join("\n"), "utf8");
  fs.writeFileSync(F_META, JSON.stringify({
    builtAt: localIso(Date.now()), elapsedSec: +((Date.now() - t0) / 1000).toFixed(1),
    logs: logs.length, scanned: done, skippedUnchanged: skipped, failed,
    summaries: sumLines.length, words: wordLines.length,
  }, null, 2), "utf8");

  console.log(`\n完成：摘要 ${sumLines.length} 条，原话 ${wordLines.length} 条`);
  console.log(`  新扫 ${done}，跳过未变 ${skipped}，解码失败 ${failed}，用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  console.log(`  索引: ${IDX}`);
  process.exit(0);
}

// ── audit：定位信息完整性的闸门 ──
// ★ 爀曦 2026-09-26 定的规矩：摘要**只能作为索引**，怀疑它时能顺着它找到原文
//   ⇒ **摘要必须包含原文的完整定位信息**。这一步就是去查它到底有没有。
//
// ★★ 判据的更正（2026-09-26 晚，第一版判错了）：
//   第一版查「首尾 seq 能不能讲清跨度」，结果把 25 条判为不合格。
//   实际去看，那 25 条的 srcSeqs 只有一个元素（例 [5213]），而它**能拉到原文**
//   （shadowedTokens=14 与那条消息的长度正好对上）。
//   ⇒ 「一个 seq」不等于「定位不完整」—— 单条消息的定位本来就是一个 seq。
//   真判据只有一条：**列出的每一个 seq，都必须能在日志里找到。**
//   跨度大小只是备注，不是失败。
if (cmd === "audit") {
  const sums = readJsonl(F_SUMMARY);
  const cache = new Map();
  const seqsOf = (logPath) => {
    if (cache.has(logPath)) return cache.get(logPath);
    let s = null;
    try { if (fs.existsSync(logPath)) s = new Set(decodeZstd(logPath).recs.map((r) => r.seq)); } catch {}
    cache.set(logPath, s);
    return s;
  };
  let ok = 0, single = 0, checked = 0, missingSeqs = 0;
  const bad = [];
  const spans = [];
  for (const s of sums) {
    const seqs = s.srcSeqs;
    if (!Array.isArray(seqs) || seqs.length === 0) { bad.push([s.id, "没有 srcSeqs —— 找不到原文"]); continue; }
    if (!s.log || !fs.existsSync(s.log)) { bad.push([s.id, `日志文件不在: ${s.log}`]); continue; }
    const set = seqsOf(s.log);
    if (!set) { bad.push([s.id, "日志解不开"]); continue; }
    const miss = seqs.filter((n) => !set.has(n));
    checked++;
    if (miss.length) {
      missingSeqs += miss.length;
      bad.push([s.id, `${miss.length} 个 seq 在日志里找不到（例 ${miss.slice(0, 3).join(", ")}）`]);
      continue;
    }
    ok++;
    if (seqs.length === 1) single++;
    spans.push(seqs.length);
  }
  spans.sort((a, b) => a - b);
  console.log("摘要定位信息审计（★ 摘要只能是索引，索引必须能指回原文）");
  console.log(`  摘要总数            ${sums.length}`);
  console.log(`  ✓ 每一条 seq 都在    ${ok}`);
  console.log(`  ✗ 定位不完整        ${bad.length}`);
  console.log(`  深度检查了 ${checked} 条；缺失的 seq 共 ${missingSeqs} 个`);
  console.log(`  其中 srcSeqs 只有一个元素的（单条消息，不是缺陷）：${single} 条`);
  if (spans.length) {
    console.log(`  定位跨度（seq 条数）中位 ${spans[Math.floor(spans.length / 2)]}，最小 ${spans[0]}，最大 ${spans[spans.length - 1]}`);
  }
  if (bad.length) {
    console.log("\n  不完整的条目：");
    for (const [id, why] of bad.slice(0, 20)) console.log(`    ${id}  ${why}`);
    if (bad.length > 20) console.log(`    …还有 ${bad.length - 20} 条`);
  }
  const sample = sums.filter((s) => Array.isArray(s.srcSeqs) && s.srcSeqs.length).slice(-3);
  console.log("\n  定位信息样例（这就是「顺着摘要找到原文」用的东西）：");
  for (const s of sample) {
    console.log(`    ${s.id}  ${s.t}`);
    console.log(`      log: ${s.session}   seqs[${s.srcSeqs.length}]  跨度 ${s.srcSeqs[0]}..${s.srcSeqs[s.srcSeqs.length - 1]}`);
    console.log(`      还原：node memq.mjs open log:${s.session}#seq=${s.srcSeqs[0]}`);
  }
  console.log("\n  ★ 还没做到的：「成果」还不是一等公民 —— 索引现在抽的是摘要与人说的原话，"
    + "抽的是**过程**；爀曦要保护的是**成果**（技术参数 / 文件地址 / 数据 / 推理的结论），这一类还没抽。");
  process.exit(bad.length ? 1 : 0);
}

// ── stats / verify ──
function readJsonl(f) {
  if (!fs.existsSync(f)) return [];
  const out = [];
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

if (cmd === "stats") {
  const meta = fs.existsSync(F_META) ? JSON.parse(fs.readFileSync(F_META, "utf8")) : null;
  const sums = readJsonl(F_SUMMARY), words = readJsonl(F_WORDS);
  console.log("记忆中枢 · L4 索引层");
  console.log(`  索引目录: ${IDX}`);
  if (meta) console.log(`  上次构建: ${meta.builtAt}（${meta.elapsedSec}s，${meta.logs} 个日志，跳过未变 ${meta.skippedUnchanged}）`);
  else console.log("  ★ 还没构建过，先跑 node memindex.mjs build --all");
  console.log(`  摘要条目: ${sums.length}`);
  console.log(`  原话条目: ${words.length}`);
  if (sums.length) {
    const tk = sums.reduce((a, s) => a + (s.shadowedTokens || 0), 0);
    const ch = sums.reduce((a, s) => a + (s.chars || 0), 0);
    console.log(`    摘要合计 ${ch} 字符，替换掉 ${tk} token（≈${(tk / Math.max(1, ch)).toFixed(1)}:1）`);
    const byStatus = {}; sums.forEach((s) => byStatus[s.status] = (byStatus[s.status] || 0) + 1);
    console.log(`    状态: ${JSON.stringify(byStatus)}（★ void = 已吊销，不删）`);
    console.log(`    时间跨度: ${sums[0].t} → ${sums[sums.length - 1].t}`);
  }
  if (words.length) {
    const ws = {}; words.forEach((w) => ws[w.ws] = (ws[w.ws] || 0) + 1);
    console.log(`  原话按工作区: ${Object.entries(ws).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}:${v}`).join("  ")}`);
    console.log(`    时间跨度: ${words[0].t} → ${words[words.length - 1].t}`);
  }
  process.exit(0);
}

if (cmd === "verify") {
  // 抽查：每条摘要的指针是否真的能指回原文（日志在、seq 在范围内）
  const sums = readJsonl(F_SUMMARY);
  console.log(`抽查 ${Math.min(10, sums.length)} 条摘要的指针…`);
  let ok = 0, bad = 0;
  for (const s of sums.slice(-10)) {
    const exists = fs.existsSync(s.log);
    if (!exists) { console.log(`  ✗ ${s.id} 日志不在: ${s.log}`); bad++; continue; }
    const recs = decodeZstd(s.log).recs;
    const hit = recs.some((r) => r.type === "compaction/summary" && `cmp-${String((r.data || {}).compactionId || "").slice(0, 8)}` === s.id);
    const seqOk = !s.srcSeqs || (recs.some((r) => r.seq === s.srcSeqs[0]) && recs.some((r) => r.seq === s.srcSeqs[1]));
    if (hit && seqOk) { console.log(`  ✓ ${s.id}  ${s.t}  seqs ${JSON.stringify(s.srcSeqs)} 可回原文`); ok++; }
    else { console.log(`  ✗ ${s.id} hit=${hit} seqOk=${seqOk}`); bad++; }
  }
  console.log(`\n指针可回原文: ${ok} 通 / ${bad} 不通`);
  process.exit(bad ? 1 : 0);
}

console.log("memindex.mjs —— 记忆中枢 · L4 索引层");
console.log("");
console.log("  node memindex.mjs build [--all] [--ws <子串>] [--since <ISO>] [--force]");
console.log("  node memindex.mjs stats");
console.log("  node memindex.mjs verify");
console.log("");
console.log("  ★ 抽两样：每次压缩的摘要（带 srcSeqs 指针 + status 可吊销）、人说的原话（逐字）。");
console.log("  ★ 数据仍在原处 —— 这里只放指针与逐字片段，不搬家。");
