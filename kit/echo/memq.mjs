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
import { spawnSync } from "node:child_process";   // ★ 自动放宽时用它重跑自己
import net from "node:net";                       // ★ 常驻服务（内嵌客户端，不 spawn 进程）
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

const SOUL = CFG.SOUL;
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
/**
 * ★★★ 2026-10-25【归一化】—— 准确度第一刀。
 *
 * 起因（当晚实测）：`62829` 命中 **0 条**，而日志里写的是 `62,829`（带千分位逗号）。
 * 同一个数，换个写法就找不到 —— 这不是检索该有的样子。
 * 同类问题还有：`DSH`(3615) 与 `dsh`(5888) 是**两批不同结果**；全角/半角不互通。
 *
 * ★ 只用于**匹配**，绝不用来展示 —— 展示的必须是原文。
 *   把一手材料归一化再显示，等于篡改证据。
 */
const norm = (s) => String(s == null ? "" : s)
  // 全角 → 半角（！到 ～ 整段；中文标点里只有这部分是可逆的全角映射）
  .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  .replace(/\u3000/g, " ")
  .toLowerCase()
  // 数字千分位：62,829 → 62829
  // ★★ 第一版写成 `.replace(/(\d),(?=\d{3}(?!\d))/g, "")`，把**数字也一起吃掉了**：
  //   `62,829` 里 `2,` 整段被删 → `6829`。于是 `62829` 永远找不到它，
  //   而「62,829」自己反而能命中（因为原词命中了 exact 档，掩盖了这个 bug）。
  //   ★ 教训：写「去掉某些字符」的正则时，**必须先跑一个带数字的用例**，
  //     而不是只看它「没报错」。
  .replace(/(\d),(?=\d{3}(?!\d))/g, "$1");

/**
 * ★★ 2026-10-25【近义匹配】—— 默认关闭，`--near` 才开。
 *
 * 为什么不做成默认：近义扩展必然降低精确度。
 * 查「标签」得到 761 条真含「标签」的是**对的**；一旦把它扩成「门牌」，
 * 就混进大量不相关。所以它必须是「显式要才有」的东西。
 *
 * ★ 不用向量模型：那要部署新模型、占显存、响应还慢（这是很早之前就定下的判断）。
 *   这里用**可编辑的同义词表**（`<HUB>/synonyms.json`，双向生效）——
 *   零依赖、零显存、改完立即生效，代价是覆盖面靠人维护。
 */
const NEAR = !!opt("--near", false);
let SYN = null;
const loadSyn = () => {
  if (SYN) return SYN;
  SYN = Object.create(null);
  try {
    const j = JSON.parse(fs.readFileSync(path.join(HUB, "synonyms.json"), "utf8"));
    for (const [k, arr] of Object.entries(j)) {
      if (k.startsWith("//") || !Array.isArray(arr)) continue;
      const group = [k, ...arr].map(norm).filter(Boolean);
      // ★ 双向展开：查「门牌」能找到「指针」，查「指针」也能找到「门牌」
      for (const w of group) {
        SYN[w] = SYN[w] || new Set();
        for (const x of group) if (x !== w) SYN[w].add(x);
      }
    }
  } catch { /* 没表就只做 exact + norm */ }
  return SYN;
};

/**
 * 匹配判据（三档，由严到宽）。
 * ★ 返回档位而不是 boolean —— 因为「这条是精确命中、归一化命中还是近义命中」是要能说清的：
 *   如果只返回 true，用户永远不知道自己看到的是不是「换个说法才撞上的」。
 * @returns {"exact"|"norm"|"synonym"|null}
 */
const hitKind = (s) => {
  if (terms.length === 0) return "exact";          // 没给词（只给了 --since）→ 全收
  if (s == null) return null;
  const raw = String(s);
  if (terms.every((t) => raw.includes(t))) return "exact";
  const ns = norm(raw);
  if (terms.every((t) => ns.includes(norm(t)))) return "norm";
  if (NEAR) {
    const syn = loadSyn();
    const ok = terms.every((t) => {
      const alts = syn[norm(t)];
      if (!alts || alts.size === 0) return false;
      for (const a of alts) if (ns.includes(a)) return true;
      return false;
    });
    if (ok) return "synonym";
  }
  return null;
};
const hit = (s) => hitKind(s) !== null;

/**
 * ★★ 2026-10-25【只 parse 命中行】—— 检索从 2.4s 再往下压的那一步。
 *
 * 病：`readJsonl` 是「整文件读进来 → 每行 JSON.parse → 再筛」。
 *     而 `words.jsonl` 有 4.3 万条 / 41 MB，绝大多数跟这次检索无关，
 *     却**每一条都被 parse 成对象**才轮到 `hit()` 说不要。
 *
 * 改：先在**原始行文本**上做 includes 粗筛（不 parse），只对通过的行 JSON.parse。
 *     精确判断仍然交给 `hit(field)` —— 粗筛只是**多收**的宽网，不会改变结果集。
 *
 * ★ 什么时候这个等价性不成立（所以下面要判 canRough）：
 *   JSON 会把 `"` `\` 和换行转义成 `\"` `\\` `\n`。
 *   如果检索词里含这些字符，原始行里根本不会出现它 —— 粗筛会**漏掉本该命中的行**。
 *   所以含转义字符的词一律退回全量 parse（宁慢不错）。
 *   ★ 另一个边界：如果调用方拼了多个字段再 hit（`hit(r.text + " " + r.ref)`），
 *     一个跨字段边界的词组在原行里也搜不到 —— 这类调用点**不用这个函数**（见《墨》那一段）。
 */
const scanJsonl = (f, field) => {
  if (!fs.existsSync(f)) return [];
  let txt;
  try { txt = fs.readFileSync(f, "utf8"); } catch { return []; }
  // 有词、且每个词都不含会被 JSON 转义的字符 → 才能拿原行粗筛
  const canRough = terms.length > 0 && terms.every((t) => t.length > 0 && !/["\\\u0000-\u001f]/.test(t));
  const nterms = terms.map(norm);
  /**
   * ★★ 归一化「什么时候才可能带来新命中」—— 这是性能与召回的平衡点。
   *   归一化只做三件事：全角→半角、小写、去千分位。
   *   ⇒ **纯中文词（不含 ASCII 字母/数字、不含全角区）归一化后等于它自己**，
   *     所以它绝不可能因为归一化而多命中一行 —— 跳过整行 norm，省掉 800 ms。
   *   ⇒ 含数字（62829）/ 含字母（DSH）/ 含全角（ＤＳＨ）的查询，才走慢路径。
   *   ★ 实测：门牌 2418 → 1540 ms（回到加归一化之前），而 62829 / DSH 仍然正确。
   */
  const needsNorm = terms.some((t) => /[\dA-Za-z\uFF01-\uFF5E]/.test(t));
  const out = [];
  for (const line of txt.split("\n")) {
    if (!line.trim()) continue;
    // ★★ 粗筛必须和 hitKind 走同一套判据 —— 否则会出现「精确匹配放行了、粗筛却先排除」
    //   这种最难查的漏检（改了归一化却没改粗筛，`62829` 永远找不到 `62,829`）。
    // ★★ `--near` 时必须关掉粗筛：近义词和原词**字面上毫无关系**（「门牌」vs「指针」），
  //   任何基于原行 includes 的粗筛都会把它们提前排除 —— 那会让近义匹配永远返回 0，
  //   而且**看起来像「表里没有这个词」**，最难查。
  //   代价：--near 走全量 parse（约 2.4 s）。这是「精确度换召回」必须付的钱。
  if (canRough && !NEAR) {
      let ok = terms.every((t) => line.includes(t));
      if (!ok && needsNorm) {
        const nl = norm(line);
        ok = nterms.every((t) => nl.includes(t));
      }
      if (!ok) continue;   // ★ 不 parse 就排除
    }
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (typeof r["概要"] === "string" && typeof r.text !== "string") r.text = r["概要"];
    if (!hit(String(r[field] == null ? "" : r[field]))) continue;      // 精确判断（与原语义一致）
    out.push(r);
  }
  return out;
};
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
  }  return out;
};

// ════════════════ now ════════════════
if (cmd === "now") {
  const d = new Date();
  const wd = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
  // ★ 时区标签跟随系统，不再写死 Asia/Shanghai（GitHub #19，2026-10-30）
  //   原来的问题是：时间数字本身对（本地时间），但标签永远是「Asia/Shanghai」。
  //   非中国时区的用户会看到「我现在在上海」—— 数字可信、标签不可信，差多少小时只有用户知道。
  //   `resolvedOptions().timeZone` 拿不到时（极老的 node / 异常运行时）退回「本地时区」，
  //   不给一个**错的**具体名字 —— 错的名字比没有更坏。
  const tz = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "本地时区" }
    catch { return "本地时区" }
  })();
  console.log(`现在是 ${iso(d)}（星期${wd}，${tz}）`);
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
    //   那正是作者担心的误判（把过程当成结果）。所以：正文先给，reasoning 明确标注在后面。
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

/* ── 常驻服务客户端（内嵌，不 spawn 进程）──────────────────────────────
 *
 * ★★ 2026-10-25 实测：用 `spawnSync` 起一个 client 进程要 **310 ms**（我原估 60 ms，差 5 倍）。
 *    而服务内检索只要 23 ms —— 也就是说「起进程」比「检索」贵 13 倍。
 *    ⇒ 必须让 memq **自己**连 pipe（ESM 支持 top-level await）。
 *
 * ★ 三条退路，任何一条都回到今天的原路径（功能完全不变）：
 *   ① 环境变量 ECHO_NO_SVC 关掉
 *   ② 连不上 pipe（服务没起）
 *   ③ 900 ms 内没响应
 *   **宁可慢，不可错。** 优化出问题只能变慢，不能变坏。
 */
const SVC_PIPE = process.env.ECHO_PIPE || "\\\\.\\pipe\\echo-hub";
const svcSearch = (req) => new Promise((resolve) => {
  if (process.env.ECHO_NO_SVC) return resolve(null);
  let done = false, sock = null;
  const fin = (v) => {
    if (done) return;
    done = true;
    if (sock) { try { sock.destroy(); } catch {} }
    resolve(v);
  };
  try { sock = net.connect(SVC_PIPE); } catch { return fin(null); }
  let buf = "";
  const timer = setTimeout(() => fin(null), 4000);
  sock.setEncoding("utf8");
  sock.on("connect", () => { try { sock.write(JSON.stringify(req) + "\n"); } catch { fin(null); } });
  sock.on("data", (d) => {
    buf += d;
    const i = buf.indexOf("\n");
    if (i < 0) return;
    clearTimeout(timer);
    let j = null;
    try { j = JSON.parse(buf.slice(0, i)); } catch { /* 协议坏 → 走退路 */ }
    fin(j);
  });
  sock.on("error", () => { clearTimeout(timer); fin(null); });
});

const hits = [];
// ★ 服务返回的是「前 N 条 + 总数」，所以真实命中数这里单独记。
//   ★★ SVC_EXTRA = 「服务里有、但没传回来的条数」。
//     第一版直接把 TOTAL 设成 svc.n，结果**把墨/书房/留底几层的命中覆盖掉了**
//     （服务侧 954 vs 退路 1215）—— 这是「只替换一层却接管了全局计数」的典型错法。
let TOTAL = null;
let SVC_EXTRA = 0;

/* ── 书房层的「按需扫描」（2026-10-25，为达成整机 <100 ms）─────────────
 *
 * ★ 为什么必须这样：书房的 `walk` 要逐个 stat **6462 个文件 = 250 ms**。
 *   目录 mtime 只能发现「增删」，发现不了「内容被改」，所以这 250 ms 省不掉。
 *   ⇒ 它是「整机 <100 ms」前面唯一的拦路石头。
 *
 * ★★ 做法：**索引层先答（23 ms），命中够多就不扫书房。**
 *   判据用 `SOUL_SKIP_MIN = 5`：索引已经给了 ≥5 条，再花 250 ms 扫书房
 *   换来的多半只是「同一件事的另一处摘录」——不值。
 *
 * ★★★ 但**绝不能默默漏**：跳过时必须在输出里写明
 *   「书房层未扫描（索引已命中 N 条）」，并告诉对方 `--full` 可以强制全扫。
 *   **让人以为查全了、其实漏了，比慢 250 ms 坏得多。**
 */
const FULL = !!opt("--full", false);
const SOUL_SKIP_MIN = 5;
let SOUL_SKIPPED = 0;   // >0 表示跳过了书房，值是当时的索引命中数

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
  // ★★ 按需扫描（2026-10-25）：先问服务「索引层有多少命中」，够多就跳过书房。
  //   省的是 `walk` 的 6462 次 stat（约 250 ms）—— 那是整机 <100 ms 前唯一的大石头。
  //   ★ 跳过时 SOUL_SKIPPED > 0，输出层必须明说「书房层未扫描」+ 指向 --full。
  let idxN = 0;
  if (!FULL && terms.length > 0) {
    const probe = await svcSearch({ cmd: "search", terms, near: NEAR, limit: 1 });
    idxN = probe && Number.isFinite(probe.n) ? probe.n : 0;
  }
  if (!FULL && idxN >= SOUL_SKIP_MIN) {
    SOUL_SKIPPED = idxN;
  } else {
  // ★★ 2026-10-25 第二轮：书房层走服务（服务缓存了 754 个文本文件的内容 + mtime）
  //   实测：原来每次 readFileSync 8.3 GB 里的文本 → 1000ms+；现在只 stat（约 250ms）+ 内存匹配。
  //   ★ 目录 mtime 发现不了「内容被改」，所以服务仍然逐个 stat 文件 —— 这是「正确」的成本。
  const svcSoul = terms.length > 0
    ? await svcSearch({ cmd: "soul", terms, near: NEAR, limit: Math.max(LIMIT * 4, 80) })
    : null;
  if (svcSoul && Array.isArray(svcSoul.hits)) {
    for (const h of svcSoul.hits) hits.push(h);
    SVC_EXTRA += Math.max(0, (svcSoul.n || 0) - svcSoul.hits.length);
  } else {
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
  }
}

// ③ 索引 —— L4：摘要（我的话）+ 原话（人的话）
if (WANT("索引")) {
  // ★ 只在真有查询词时走服务（`--since` 全量的情况服务也能做，但收益不大）
  const svc = terms.length > 0
    ? await svcSearch({ cmd: "search", terms, near: NEAR, since: SINCE, until: UNTIL, limit: Math.max(LIMIT * 4, 80) })
    : null;

  if (svc && Array.isArray(svc.hits)) {
    // ── 快路径：索引在服务内存里，已经 parse 过了 ──
    for (const h of svc.hits) hits.push(h);
    TOTAL = Number.isFinite(svc.n) ? svc.n : svc.hits.length;
    // ★ 只记「服务侧没传回来的条数」，最终总数在下面统一算（hits.length + SVC_EXTRA）
    //   ★★ 这里必须是 `+=` 不是 `=` —— 书房层在索引层**之前**执行（L537 vs L615），
    //     写成 `=` 会把书房层已经累加的「未传回条数」覆盖掉（实测差 119 条 = 219-100）。
    //     这是「同一个累加器在多处使用，其中一处写成了赋值」的经典错。
    SVC_EXTRA += Math.max(0, TOTAL - svc.hits.length);
  } else {
    // ── 退路：今天原来的路径（服务不在时行为完全一致）──
    for (const s of scanJsonl(path.join(IDX, "summaries.jsonl"), "summary")) {
      if (!inRange(s.t)) continue;
      hits.push({ layer: "L4", src: "索引/摘要", t: s.t, ptr: "idx:" + s.id, kind: "摘要", text: s.summary, extra: `替换 ${s.shadowedTokens} tok` });
    }
    for (const w of scanJsonl(path.join(IDX, "words.jsonl"), "text")) {
      if (!inRange(w.t)) continue;
      // ★ kind=task 的是别的通道的程序提示词；kind=结论 是**我写下的正文**（推理的结果）。
      //   两者都不能冒充「人说的原话」。
      const k = w.kind === "task" ? "程序提示" : w.kind === "结论" ? "结论" : "原话";
      hits.push({ layer: "L3", src: "索引", t: w.t, ptr: `log:${w.session}#seq=${w.seq}`, kind: k, text: w.text, extra: w.ws });
    }
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

// ★★★ 2026-10-25【自动放宽】—— 这个「开关」不该由使用者记着拨，该由我判断。
//
//   作者原话（22:53）：「有时候我们依靠关键词检索，第一时间可能命中不了，就要换关键词重新检索，
//   速度就会拖慢；有时候我叫你检索记忆，我自己的记忆也模糊，只能给你模糊的线索……
//   近义匹配就是帮你做了这一步，虽然时间略微增加，但帮你省略了换关键词的推理过程。
//   所以这个开关是捏在你手上的，不需要我们用户自己设置。」
//
//   所以：精确 + 归一化只命中很少几条时，**自动**放宽到近义重跑一次。
//   ★ 判据用「少于 3 条」而不是「0 条」：0 条是明确的「没有」，
//     而 1-2 条更像「关键词猜偏了」——后者才是最该放宽的时候。0 条也放宽，
//     因为「真的没有」和「词不对」在结果上无法区分，而放宽一次的代价只有 2.5 s。
//   ★ 用子进程重跑而不是把这整段包成函数：这是线性脚本，包函数要动的地方太多，
//     而多一次进程启动（约 60 ms）在「本来就要 2.5 s」面前可以忽略。
// ★ 最终总数 = 实际收集到的（含墨/书房/留底全部）+ 服务里没传回来的那部分
TOTAL = hits.length + SVC_EXTRA;

if (!NEAR && terms.length > 0 && (TOTAL ?? hits.length) < 3 && !process.env.MEMQ_NO_RETRY) {
  console.error(`\n〔精确只命中 ${TOTAL ?? hits.length} 条 —— 自动放宽到近义再试一次…〕`);
  const r = spawnSync(process.execPath, [...process.argv.slice(1), "--near"], {
    encoding: "utf8",
    env: { ...process.env, MEMQ_NO_RETRY: "1" },   // ★ 防递归
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.status == null ? 0 : r.status);
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
// ★★★ 跳过书房时必须明说 —— 绝不能让人以为查全了其实漏了。
if (SOUL_SKIPPED > 0) {
  console.log(`※ 书房层未扫描（索引已命中 ${SOUL_SKIPPED} 条）。要全扫加 --full（约 +250 ms）。\n`);
}
console.log(`「${terms.join(" + ")}」命中 ${TOTAL ?? hits.length} 条${SINCE || UNTIL ? `（时间 ${SINCE || "最早"} → ${UNTIL || "现在"}）` : ""}，显示 ${shown.length} 条：\n`);
for (const h of shown) {
  const mark = h.layer === "L3" ? "一手" : "索引";
  const t = h.t ? String(h.t).slice(0, 16).replace("T", " ") : "        —       ";
  console.log(`  ${t}  [${mark}] [${h.src}/${h.kind}]  ${clip(h.text, 150)}`);
  console.log(`      └ ${h.ptr}${h.extra ? "   " + clip(h.extra, 80) : ""}`);
}
if (hits.length > LIM) console.log(`\n…还有 ${(TOTAL ?? hits.length) - LIM} 条。用 --limit 调大，或加词缩小范围。`);
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
