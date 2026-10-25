// memq.mjs —— 记忆中枢 · 唯一的门（L0 时钟 + L5 检索 + 回一手层）
//
// ── 为什么要有它 ──
// 我的记忆零件本来就不少：《墨》、书房（宪章/日记/状态）、留底库、869 个会话日志。
// 但它们**各自一扇门、各自一套参数**，所以我每次都要先想起来「该翻哪一个、用什么命令」。
// 实测结论（设计提案 §2.1）：瓶颈**不是检索精度，是触发** —— 「取回」不是问题，「知道要取」才是问题。
// 所以这里只做两件事：**把门收成一扇**，以及**每条结果都给回一手层的指针**。
//
// ── 三条铁律 ──
//   ① 只回「指针 + 逐字片段」，**不做转述**（转述是二手污染的来源）。
//   ② 一手层（L3）与索引层（L4）**分开标**：看到 [索引] 就知道那是我的话，不是原文。
//   ③ 时间是一等公民：一切都能按 --since / --until 切片。
//
// ── 用法 ──
//   node memq.mjs now                                   时钟 + 距上轮 + 最近状态
//   node memq.mjs <词1> [词2...] [--since ISO] [--until ISO] [--limit N] [--src 墨,书房,索引,留底]
//   node memq.mjs timeline [--since ISO] [--until ISO] [--limit N]     时间线（一手优先）
//   node memq.mjs open <指针>                            把指针还原成原文（回一手层）
//   node memq.mjs sources                                各层现在有多少东西

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import * as CFG from "./echo-config.mjs";
// ★★★ 2026-10-08 修复（回声系统的一次真实故障）
//   本脚本原先在两处把日志文件名写死成 `session.v3.jsonl.zstd`（open 取文件 / sources 统计）。
//   宿主把日志升到 v4（约 09-30）之后，这条门**静默失效**：
//   v4 里明明有这条 seq，`open` 却报「该 seq 不在日志里」——
//   **看起来像「没有这条记录」，其实是「读错了文件」**。记录在 42051 的门牌因此打不开。
//   同一个坑还在 memindex.mjs / heartbeat.mjs / self.mjs 里各有一处（同日一并修）。
//   ⇒ 一律走 session-store.mjs 这层「版本无感」读取：
//     它只认 `/^session\.v\d+\.jsonl\.zstd$/`，同会话多版本时取 mtime 最新那份。
//     宿主将来升 v5、v6，这里一行都不用改。
import { findSessionFile, listSessionFiles } from "./session-store.mjs";
// ★★ 2026-10-25 提速：帧索引直取（见 framestore.mjs）。
//   原来 `open` 要走 decodeZstd 全量解码 —— 62,829 帧 / 解压后 576 MB / 实测 31 秒一次。
//   改成「先用帧索引定位、只解 2~3 帧」后实测 30 ms。
//   ★ framestore 不可用时会自动降级回 decodeZstd，所以这个 import 不是硬依赖。
import * as fstore from "./framestore.mjs";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * 取一个目录里**最新写入**的会话日志；没有就返回 null。
 * ★ 版本无感：认 `session.v<N>.jsonl.zstd`，不认死 v3 —— 宿主升版（v3→v4→…）都不用改这里。
 */
function newestLog(dir) {
  let best = null;
  try {
    for (const n of fs.readdirSync(dir)) {
      if (!/^session\.v\d+\.jsonl\.zstd$/.test(n)) continue;
      const p = path.join(dir, n);
      const m = fs.statSync(p).mtimeMs;
      if (!best || m > best.m) best = { p, m };
    }
  } catch { return null; }
  return best ? best.p : null;
}

const SOUL = CFG.SOUL;   // ★ 发布版：从 echo-config 读
const MO = path.join(SOUL, "02-墨.jsonl");
const MEM = CFG.MEM;
const HUB = path.join(MEM, "hub");
const IDX = path.join(HUB, "index");
const SESSIONS = CFG.SESSIONS;
const STATE = path.join(HUB, "state.json");

// ── 参数 ──
const argv = process.argv.slice(2);
// ★ 首参只有是已知子命令时才当命令；否则它就是一个检索词（否则 `memq 翠云廊` 会被吃掉）
const KNOWN = ["now", "mark", "sources", "open", "timeline", "search"];
let cmd = "search";
if (argv[0] && KNOWN.includes(argv[0])) cmd = argv.shift();
const opt = (name, def) => {
  const i = argv.indexOf(name);
  if (i === -1) return def;
  const v = argv[i + 1];
  argv.splice(i, v !== undefined && !v.startsWith("--") ? 2 : 1);
  return v === undefined ? true : v;
};
const SINCE = opt("--since", null);
const UNTIL = opt("--until", null);
const LIMIT = Number(opt("--limit", 25));
const SRC = String(opt("--src", "墨,书房,索引,留底")).split(",").map((s) => s.trim());
const WANT = (k) => SRC.includes(k) || SRC.includes("all") || SRC.includes("全部");
const terms = argv.filter((a) => !a.startsWith("--"));

// ── 通用 ──
const p2 = (n) => String(n).padStart(2, "0");
const iso = (d = new Date()) =>
  `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
const inRange = (t) => {
  if (!t) return true;
  if (SINCE && SINCE !== true && t < String(SINCE)) return false;
  if (UNTIL && UNTIL !== true && t > String(UNTIL)) return false;
  return true;
};
const hit = (s) => terms.length === 0 || terms.every((t) => s && s.includes(t));
const clip = (s, n = 160) => {
  const one = String(s).replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n) + " …" : one;
};
const readJsonl = (f) => {
  if (!fs.existsSync(f)) return [];
  const out = [];
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      // ★★★ 2026-10-08 修复：字段归一化 —— 让「门」读得全账本。
      //   《墨》里有两种写法：老条目把正文放在 `text`（344 条），新条目放在 `概要`（85 条）。
      //   而本文件下面六处一律只读 `r.text` ⇒ 那 85 条**在门里全是 undefined**：
      //   列不出来、搜不到、`open 墨:<时刻>` 也是空的 —— 占全账本 20%，而且全是**最近的账**。
      //   这里统一补一个 `text`，六处调用点自动全部修好。
      //   ★ 只补不改：`text` 已存在就一字不动；其他 jsonl（索引层）没有 `概要` 字段，零副作用。
      if (typeof r["概要"] === "string" && typeof r.text !== "string") r.text = r["概要"];
      out.push(r);
    } catch {}
  }
  return out;
};

// ════════════════ now ════════════════
if (cmd === "now") {
  const d = new Date();
  const wd = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
  console.log(`现在是 ${iso(d)}（星期${wd}，Asia/Shanghai）`);
  let st = {};
  try { st = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch {}
  if (st.lastTurnAt) {
    const gap = Math.round((d - new Date(st.lastTurnAt)) / 60000);
    console.log(`距上一次记下的回合：${gap} 分钟（上次 ${st.lastTurnAt}）`);
  } else {
    console.log("★ 还没有回合状态记录 —— 跑 node memq.mjs mark 写一条");
  }
  console.log(`本容器：${process.env.DSH_SESSION_ID || "(未知 DSH_SESSION_ID)"}`);
  // 当前主导
  const mo = readJsonl(MO);
  const leads = mo.filter((r) => r.type === "lead");
  if (leads.length) {
    const L = leads[leads.length - 1];
    console.log(`《墨》最后一条 lead：${clip(L.text, 100)}`);
  }
  const open = mo.filter((r) => r.type === "promise" || r.type === "shelved");
  if (open.length) {
    console.log(`未结（promise/shelved）${open.length} 条，最近 3 条：`);
    open.slice(-3).forEach((r) => console.log(`  ${r.t.slice(0, 16).replace("T", " ")}  ${clip(r.text, 90)}`));
  }
  console.log(`\n★ 下一步：要回忆什么就跑 node memq.mjs <词> ｜ 看时间线 node memq.mjs timeline`);
  process.exit(0);
}

// ════════════════ mark（写回合状态）════════════════
if (cmd === "mark") {
  fs.mkdirSync(HUB, { recursive: true });
  let st = {};
  try { st = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch {}
  const note = argv.filter((a) => !a.startsWith("--")).join(" ").trim();
  st.lastTurnAt = iso();
  st.session = process.env.DSH_SESSION_ID || null;
  if (note) { st.lastNote = note; st.lastNoteAt = st.lastTurnAt; }
  st.turns = (st.turns || 0) + 1;
  fs.writeFileSync(STATE, JSON.stringify(st, null, 2), "utf8");
  console.log(`✓ 已记下回合 ${st.turns} @ ${st.lastTurnAt}${note ? " ｜ " + clip(note, 60) : ""}`);
  process.exit(0);
}

// ════════════════ sources ════════════════
if (cmd === "sources") {
  const mo = readJsonl(MO);
  const sums = readJsonl(path.join(IDX, "summaries.jsonl"));
  const words = readJsonl(path.join(IDX, "words.jsonl"));
  const files = (dir) => { let n = 0, b = 0; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { n++; b += fs.statSync(p).size; } } }; try { walk(dir); } catch {} return { n, b }; };
  const soul = files(SOUL), mem = files(MEM);
  const logs = fs.existsSync(SESSIONS) ? (() => { let n = 0, b = 0; for (const w of fs.readdirSync(SESSIONS)) { const wp = path.join(SESSIONS, w); if (!fs.statSync(wp).isDirectory()) continue; for (const s of fs.readdirSync(wp)) { const f = newestLog(path.join(wp, s)); if (f) { n++; b += fs.statSync(f).size; } } } return { n, b }; })() : { n: 0, b: 0 };
  console.log("记忆中枢 · 各层家底");
  console.log(`  L0 时钟      ${STATE}${fs.existsSync(STATE) ? "（有）" : "（还没建）"}`);
  console.log(`  L1 自我      ${path.join(HUB, "SELF.md")}${fs.existsSync(path.join(HUB, "SELF.md")) ? `（${fs.statSync(path.join(HUB, "SELF.md")).size} B）` : "（还没生成）"}`);
  console.log(`  L3 一手层    《墨》${mo.length} 条 ｜ 书房 ${soul.n} 文件/${(soul.b / 1024).toFixed(0)}KB ｜ 会话日志 ${logs.n} 个/${(logs.b / 1048576).toFixed(0)}MB`);
  console.log(`  L4 索引层    摘要 ${sums.length} 条 ｜ 原话 ${words.length} 条 ｜ 目录 ${IDX}`);
  console.log(`  L5 检索      本工具 memq.mjs`);
  console.log(`  留底库       ${mem.n} 文件/${(mem.b / 1024).toFixed(0)}KB`);
  process.exit(0);
}

// ════════════════ open（指针 → 原文）════════════════
if (cmd === "open") {
  // ★ 选项必须先解析掉，否则 `--span 1` 里的 `1` 会被拼进指针里
  const SPAN = Number(opt("--span", 3));
  const raw = argv.filter((a) => !a.startsWith("--")).join(" ").trim();
  // ★ 指针被复制粘贴时总会带上尾随备注（`… #seq=5762   --D-AI-yanqing-soul--`），
  //   所以这里一律**只取指针本身**，不吃后面的东西。file: 例外 —— 路径里可能有空格。
  const ptr = raw;
  if (!ptr) {
    console.log("用法: node memq.mjs open <指针> [--span N]");
    console.log("  指针形如  墨:2026-09-26T19:05:27 / file:D:\\…\\x.md:123 / log:<会话id>#seq=123 / idx:cmp-xxxxxxxx");
    process.exit(1);
  }

  if (ptr.startsWith("墨:")) {
    const m = ptr.match(/^墨:(\S+)/);
    const t = m ? m[1] : ptr.slice(2);
    const rows = readJsonl(MO).filter((r) => r.t.startsWith(t.slice(0, 19)));
    if (!rows.length) { console.log("✗ 《墨》里没有这个时刻的条目"); process.exit(1); }
    rows.forEach((r) => { console.log(`[${r.type}] ${r.t}\n${r.text}\n  └ ${r.ref || "(无 ref)"}`); });
    process.exit(0);
  }
  if (ptr.startsWith("file:")) {
    const m = ptr.match(/^file:(.+):(\d+)(?:\s|$)/);
    if (!m) { console.log("✗ file 指针形如 file:路径:行号"); process.exit(1); }
    const [, f, lnStr] = m; const ln = Number(lnStr);
    if (!fs.existsSync(f)) { console.log("✗ 文件不在: " + f); process.exit(1); }
    const lines = fs.readFileSync(f, "utf8").split("\n");
    const a = Math.max(1, ln - SPAN), b = Math.min(lines.length, ln + SPAN);
    console.log(`${f}  第 ${a}–${b} 行（原文，未改一字）`);
    for (let i = a; i <= b; i++) console.log(`${i === ln ? "▶" : " "} ${String(i).padStart(5)}  ${lines[i - 1]}`);
    process.exit(0);
  }
  if (ptr.startsWith("log:")) {
    const m = ptr.match(/^log:(\S+?)#seq=(\d+)/);
    if (!m) { console.log("✗ log 指针形如 log:<会话id>#seq=123"); process.exit(1); }
    const [, sid, sq] = m;
    let file = null;
    for (const w of fs.readdirSync(SESSIONS)) {
      const f = newestLog(path.join(SESSIONS, w, sid));
      if (f) { file = f; break; }
    }
    if (!file) { console.log("✗ 找不到会话日志: " + sid); process.exit(1); }
    // ★★ 2026-10-25：【先走帧索引直取，拿不到才降级】。
    //   旧行为 = 无条件 decodeZstd(file) 全量解码（62,829 帧 / 实测 31 s）。
    //   新行为 = 帧索引定位 + 只解 2~3 帧（实测 30 ms）；索引缺失/损坏/没这条时，
    //   原样走下面那句全量解码 —— ★ 降级路径保留全部旧逻辑，所以最坏情况只是「和以前一样慢」，
    //   不会打不开门牌。这个保底是故意留的：读慢可以忍，读不到不能忍。
    let r = null;
    try {
      const fast = fstore.readSeq(file, HUB, Number(sq));
      if (fast && String(fast.seq) === sq) r = fast;
    } catch { /* framestore 不可用：静默降级 */ }
    if (!r) {
      const recs = decodeZstd(file);
      r = recs.find((x) => String(x.seq) === sq);
      if (!r) { console.log(`✗ 该 seq 不在日志里（在 ${path.basename(file)} 里找的，该文件共 ${recs.length} 条事件；会话 ${sid}）`); process.exit(1); }
    }
    console.log(`[一手原文] ${file}\n  seq=${r.seq}  ${iso(new Date(r.time))}  type=${r.type}`);
    const d = r.data || {};
    // ★★ 正文与 reasoning 必须分开 —— 踩过：原来的写法把所有带 text 的块拼起来，
    //   而 reasoning 块排在前面，于是「顺着结论的指针回原文」读回来的是**思考过程**。
    //   那正是爀曦担心的误判（把过程当成结果）。所以：正文先给，reasoning 明确标注在后面。
    const content = Array.isArray(d.content) ? d.content
      : (d.message && Array.isArray(d.message.content)) ? d.message.content : [];
    const grab = (want) => content
      .filter((c) => c && c.type === want && typeof c.text === "string")
      .map((c) => c.text).join("");
    const body = grab("text"), think = grab("reasoning");
    if (body) console.log(body);
    else if (!think) console.log(JSON.stringify(d).slice(0, 4000));
    if (think) {
      console.log(`\n  ── 同一轮的 reasoning（★ 过程，不是结果；全文 ${think.length} 字，这里截前 800）──`);
      console.log(think.slice(0, 800) + (think.length > 800 ? " …" : ""));
    }
    if (!body && think) console.log("\n  （这条没有正文 —— 它只有思考，没有说出口的东西）");
    process.exit(0);
  }
  if (ptr.startsWith("idx:")) {
    const m = ptr.match(/^idx:(\S+)/);
    const id = m ? m[1] : ptr.slice(4);
    const s = readJsonl(path.join(IDX, "summaries.jsonl")).find((x) => x.id === id);
    if (!s) { console.log("✗ 索引里没有 " + id); process.exit(1); }
    console.log(`[索引条目 ${s.id}] ${s.t}  替换 ${s.shadowedTokens} tok → 摘要 ${s.chars} 字符`);
    console.log(`  回一手层的指针：log:${s.session}#seq=${(s.srcSeqs || [])[0] || "?"}`);

    // ★★ 先给清单，再给摘要 —— 顺序是刻意的。
    //   manifest 只点「那一段里有什么」（位置 + 名字 + 首行），**不做转述**，所以零失真。
    //   它的用处：你怀疑这条摘要时，先看清单点清东西还在不在，再决定要不要顺指针回原文。
    const mf = s.manifest;
    if (mf) {
      const T = Object.entries(mf.types || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join("  ");
      const TL = Object.entries(mf.tools || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join("  ");
      console.log(`\n  ── 被替换区间 [${mf.range[0]}..${mf.range[1]}] 里有什么（清单，不是转述）──`);
      console.log(`  记录 ${mf.n} 条：${T}`);
      if (TL) console.log(`  工具调用：${TL}`);
      if ((mf.files || []).length) {
        console.log(`  这个区间里出现过的文件地址（${mf.files.length} 个，取前 8）：`);
        for (const f of mf.files.slice(0, 8)) console.log(`    ${f}`);
      }
      if ((mf.marks || []).length) {
        console.log(`  地标（前 12 条，seq + 首行）：`);
        for (const k of mf.marks.slice(0, 12)) console.log(`    ${String(k.seq).padStart(5)}  ${k.type.padEnd(18)} ${k.head}`);
      }
      console.log(`  ⇒ 怀疑这条摘要时：node memq.mjs open log:${s.session}#seq=${mf.range[0]}`);
    } else {
      console.log(`  原文序列表（前 12 个）：${(s.srcSeqs || []).slice(0, 12).join(", ")}${(s.srcSeqs || []).length > 12 ? " …" : ""}`);
    }

    console.log(`\n  ── 摘要正文（★ 只是索引，不是记忆本体）──\n${s.summary}`);
    process.exit(0);
  }
  console.log("✗ 认不出的指针类型。支持 墨: / file: / log: / idx:");
  process.exit(1);
}

// ════════════════ timeline ════════════════
if (cmd === "timeline") {
  const rows = [];
  if (WANT("墨")) readJsonl(MO).forEach((r) => { if (inRange(r.t)) rows.push({ kind: "墨/" + r.type, t: r.t, text: r.text, ptr: "墨:" + r.t, layer: "L3" }); });
  if (WANT("索引")) {
    readJsonl(path.join(IDX, "words.jsonl")).forEach((w) => {
      if (!inRange(w.t)) return;
      const k = w.kind === "task" ? "程序提示" : w.kind === "结论" ? "结论" : "原话";
      rows.push({ kind: k, t: w.t, text: w.text, ptr: `log:${w.session}#seq=${w.seq}`, layer: k === "程序提示" ? "task" : "L3" });
    });
    readJsonl(path.join(IDX, "summaries.jsonl")).forEach((s) => { if (inRange(s.t)) rows.push({ kind: "摘要", t: s.t, text: s.summary, ptr: "idx:" + s.id, layer: "L4" }); });
  }
  rows.sort((a, b) => String(a.t).localeCompare(String(b.t)));
  const show = rows.slice(-LIMIT);
  console.log(`时间线（${SINCE || "最早"} → ${UNTIL || "现在"}），共 ${rows.length} 条，显示最后 ${show.length} 条：\n`);
  for (const r of show) {
    const mark = r.layer === "L3" ? "一手" : r.layer === "L4" ? "索引" : "程序";
    console.log(`  ${String(r.t).slice(0, 16).replace("T", " ")}  [${mark}] [${r.kind}]  ${clip(r.text, 110)}`);
    console.log(`      └ ${r.ptr}`);
  }
  process.exit(0);
}

// ════════════════ search ════════════════
if (terms.length === 0) {
  console.log("memq.mjs —— 记忆中枢 · 唯一的门");
  console.log("");
  console.log("  node memq.mjs now                                    时钟 + 距上轮 + 最近状态");
  console.log("  node memq.mjs mark [一句话]                           记下这一回合（写 L0 状态）");
  console.log("  node memq.mjs <词1> [词2...] [选项]                    检索（多个词 = 全都要含）");
  console.log("  node memq.mjs timeline [--since ISO] [--until ISO]     时间线");
  console.log("  node memq.mjs open <指针>                             指回原文");
  console.log("  node memq.mjs sources                                 各层家底");
  console.log("");
  console.log("  选项：--since ISO  --until ISO  --limit N  --src 墨,书房,索引,留底");
  console.log("");
  console.log("  ★ 只回「指针 + 逐字片段」，不做转述。看到 [索引] 就知道那是我写的，不是原文。");
  process.exit(0);
}

const hits = [];

// ① 《墨》—— 一手，结构化
if (WANT("墨")) {
  for (const r of readJsonl(MO)) {
    if (!inRange(r.t)) continue;
    if (!hit(r.text + " " + (r.ref || ""))) continue;
    hits.push({ layer: "L3", src: "墨", t: r.t, ptr: "墨:" + r.t, kind: r.type, text: r.text, extra: r.ref });
  }
}

// ② 书房 —— 一手文档
if (WANT("书房")) {
  // ★★ 2026-10-25【书房检索提速】—— 21 秒里最大的一段就是这里。
  //   原来只按扩展名排除（mp3/png/…），于是 **.mp4/.mov/.pdf/.gguf 这些全被当成文本读**，
  //   而且**没有大小上限** —— 实测 D:\AI\yanqing-soul 是 8.3 GB / 6,462 个文件，
  //   逐个 readFileSync 成 utf8 字符串再逐行匹配。
  //   ★ 判据：检索是「按行找回原文」，对超大文件/媒体文件没有意义 ——
  //     一个 200 MB 的视频里不可能有一行值得当证据的文本。
  //   两道闸：① 扩展名扩表（加媒体/模型/压缩包）② 单文件 512 KB 上限。
  const SKIP = /(\.mp3|\.mp4|\.mov|\.avi|\.mkv|\.wav|\.flac|\.m4a|\.ogg|\.aac|\.webm|\.png|\.jpg|\.jpeg|\.webp|\.gif|\.bmp|\.ico|\.svg|\.tif|\.tiff|\.pdf|\.zip|\.7z|\.rar|\.gz|\.zst|\.zstd|\.tar|\.exe|\.dll|\.bin|\.pyc|\.pyo|\.pyd|\.so|\.gguf|\.safetensors|\.onnx|\.pt|\.pth|\.ckpt|\.wasm|\.mp3|node_modules|\.git)/i;
  const MAX_TEXT = 512 * 1024;   // 512 KB：超过就不当「可检索的一手文本」
  const walk = (dir, depth = 0) => {
    if (depth > 4) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!/^(_|dsh-image-gen)/.test(e.name)) walk(p, depth + 1); continue; }
      if (SKIP.test(e.name)) continue;
      if (e.name === "02-墨.jsonl") continue;   // 《墨》有专门的一层，别在这里重复抓
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (st.size > MAX_TEXT) continue;         // ★ 大文件直接跳过：那是产物/归档，不是一手文本
      let txt; try { txt = fs.readFileSync(p, "utf8"); } catch { continue; }
      const lines = txt.split("\n");
      lines.forEach((ln, i) => {
        if (!hit(ln)) return;
        hits.push({ layer: "L3", src: "书房", t: null, ptr: `file:${p}:${i + 1}`, kind: path.extname(p).slice(1), text: ln.trim(), extra: path.relative(SOUL, p) });
      });
    }
  };
  walk(SOUL);
}

// ③ 索引 —— L4：摘要（我的话）+ 原话（人的话）
if (WANT("索引")) {
  for (const s of readJsonl(path.join(IDX, "summaries.jsonl"))) {
    if (!inRange(s.t)) continue;
    if (!hit(s.summary)) continue;
    hits.push({ layer: "L4", src: "索引/摘要", t: s.t, ptr: "idx:" + s.id, kind: "摘要", text: s.summary, extra: `替换 ${s.shadowedTokens} tok` });
  }
  for (const w of readJsonl(path.join(IDX, "words.jsonl"))) {
    if (!inRange(w.t)) continue;
    if (!hit(w.text)) continue;
    // ★ kind=task 的是别的通道的程序提示词；kind=结论 是**我写下的正文**（推理的结果）。
    //   两者都不能冒充「人说的原话」。
    const k = w.kind === "task" ? "程序提示" : w.kind === "结论" ? "结论" : "原话";
    hits.push({ layer: "L3", src: "索引", t: w.t, ptr: `log:${w.session}#seq=${w.seq}`, kind: k, text: w.text, extra: w.ws });
  }
}

// ④ 留底库（排除 hub 自己）
if (WANT("留底")) {
  const walk = (dir, depth = 0) => {
    if (depth > 4) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name === "hub" || e.name === "snapshots") continue; walk(p, depth + 1); continue; }
      if (!/\.(md|txt|json|jsonl|py|mjs)$/i.test(e.name)) continue;
      let txt; try { txt = fs.readFileSync(p, "utf8"); } catch { continue; }
      txt.split("\n").forEach((ln, i) => {
        if (!hit(ln)) return;
        hits.push({ layer: "L3", src: "留底", t: null, ptr: `file:${p}:${i + 1}`, kind: path.extname(p).slice(1), text: ln.trim(), extra: path.relative(MEM, p) });
      });
    }
  };
  walk(MEM);
}

// 排序：有时间的一手在前，其次按时间倒序；没时间的排最后
hits.sort((a, b) => {
  const ra = a.layer === "L3" ? 0 : 1, rb = b.layer === "L3" ? 0 : 1;
  if (ra !== rb) return ra - rb;
  if (a.t && b.t) return String(b.t).localeCompare(String(a.t));
  if (a.t) return -1;
  if (b.t) return 1;
  return 0;
});

const LIM = LIMIT;
const shown = hits.slice(0, LIM);
console.log(`「${terms.join(" + ")}」命中 ${hits.length} 条${SINCE || UNTIL ? `（时间 ${SINCE || "最早"} → ${UNTIL || "现在"}）` : ""}，显示 ${shown.length} 条：\n`);
for (const h of shown) {
  const mark = h.layer === "L3" ? "一手" : "索引";
  const t = h.t ? String(h.t).slice(0, 16).replace("T", " ") : "        —       ";
  console.log(`  ${t}  [${mark}] [${h.src}/${h.kind}]  ${clip(h.text, 150)}`);
  console.log(`      └ ${h.ptr}${h.extra ? "   " + clip(h.extra, 80) : ""}`);
}
if (hits.length > LIM) console.log(`\n…还有 ${hits.length - LIM} 条。用 --limit 调大，或加词缩小范围。`);
console.log(`\n★ 要看某条的原文：node memq.mjs open <上面那个 └ 后面的指针>`);

// ── 会话日志解码（open 用）──
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
  // ★★ 2026-10-23 修复 —— 和 memindex.mjs 是同一个病，那次只修了索引那一份。
  //   这里原来是把所有帧 Buffer.concat 成一个巨串再 toString。
  //   本会话日志压缩后 217 MB，解压后超过 Node 的字符串上限（0x1fffffe8 ≈ 512 MB），
  //   抛 ERR_STRING_TOO_LONG —— 表现是 **`memq open` 打不开任何门牌**。
  //
  //   ★ 这个 bug 的形状值得记住：索引修好之后，build 报「解码失败 0」，看着一切正常；
  //   而压缩插件照常在写门牌、摘要第一行也带着正确的 seq。
  //   **门牌是对的，门后面堵着** —— 直到真去 open 一次才发现。
  //   判据不是「索引能建」也不是「摘要带门牌」，而是「拿那个指针真的能打开」。
  //
  //   改成【逐帧解码 → 逐帧按行切 → carry 跨帧续行】，内存里永远不出现完整巨串。
  //   ★ carry 不能省：一行 JSON 可能跨帧，直接逐帧 split 会把那行截断、静默丢记录。
  const recs = [];
  const MAX_LINE = 8 * 1024 * 1024;
  let carry = "";
  const take = (line) => {
    if (line.length > MAX_LINE) return;   // 超长行对检索没价值，丢掉
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
  return recs;
}
