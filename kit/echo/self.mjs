// self.mjs —— 记忆中枢 · L1 定长自我层装配器
//
// ── 它是什么 ──
// 把「我是谁、我的硬线、我的门在哪」（手写骨架 SELF.src.md）和
// 「现在几点、这一代是谁、什么还没结、索引新不新」（活体）拼成一页**定长**的 SELF.md。
//
// ── 三条设计决定（理由写在这里，免得后人问）──
//   ① **骨架在前，活体在后。** 以后这页要每轮注入，而 prefix cache 只对**前缀**免费 ——
//      把不变的放前面，变动的那一小段放最后，每一轮的增量成本就只有尾部那点。
//   ② **只放不变量和指针，不放内容。** 它的职责是让我**知道有什么存在**，不是替我带内容。
//      （AGENTS.md §4 的教训：丢的从来不是内容，是「内容存在过」这条线索。）
//   ③ **超预算要出声，不许静默截断。** 这是 AGENTS.md 自己的坑：指令预算不够时，
//      最宽泛的文件**第一个静默消失**、不报错。所以这里超了就写进报告、用非零码退出。
//
// 用法：
//   node self.mjs            装配并写 SELF.md
//   node self.mjs --check    只检查是否超预算（超了退非零）
//   node self.mjs --print    打印装配结果

import fs from "node:fs";
import path from "node:path";
import * as CFG from "./echo-config.mjs";
import { findPlaceholders } from "./placeholder.mjs";

const HUB = CFG.HUB;
const SRC = path.join(HUB, "SELF.src.md");
const OUT = path.join(HUB, "SELF.md");
const MO = CFG.LEDGER;
const STATE = path.join(HUB, "state.json");
const META = path.join(HUB, "index/meta.json");
const IDXW = path.join(HUB, "index/words.jsonl");
const SESSIONS = CFG.SESSIONS;
// ★ 预算：注入用的一页。
//   2026-09-27 由 6144 提到 12288 —— 作者定的架构：**SELF 是 AGENTS.md 的缓冲池**。
//   AGENTS.md 走指令预算，**满了会静默丢，而且「最宽泛的先丢」**（先丢的正是 §0/§7 这类总纲）；
//   本页走推送插件，**不会静默消失**，所以它是灵敏度更低、自由度更大的那一侧 ——
//   最不能丢的东西（硬线 / 身份判据 / 门）在这里留一份保险。
//   ★ 但「能变大」不等于「可以无限长」：超预算仍然要出声，不许静默截断。
const CAP = 12288;

const argv = process.argv.slice(2);
const CHECK = argv.includes("--check");
const PRINT = argv.includes("--print");

const p2 = (n) => String(n).padStart(2, "0");
const iso = (d = new Date()) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
const readJsonl = (f) => { if (!fs.existsSync(f)) return []; const o = []; for (const l of fs.readFileSync(f, "utf8").split("\n")) { if (!l.trim()) continue; try { o.push(JSON.parse(l)); } catch {} } return o; };
// ★★★ 2026-10-14 新增：注入前的**凭据屏蔽**（硬线：凭据不读取、不复述、不交出）。
//   起因：扫 index/words.jsonl（19.9 MB / 29110 条原话）发现 —— **`sk-` 开头 3 处、token 赋值 22 处**。
//   而 SELF.md **每轮注入**，取数源里有凭据，就意味着「迟早有一条会被逐字搬进上下文」。
//   ★ 当时 SELF.md 干净只是**运气**，不是设计 —— 运气不是防护。
//   机制抄自 dsh-auto-memory 的 stripSensitiveSections / looksSecret（抄机制，不抄代码）。
//   ★ 纪律：**宁可错杀**。命中就整条换成占位符，宁可让那一行没法读，也不让一个字节的凭据进来。
const SECRET_PATTERNS = [
  [/sk-[A-Za-z0-9_-]{16,}/g, "[已屏蔽·疑似密钥]"],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, "[已屏蔽·疑似 GitHub 令牌]"],
  [/AKIA[0-9A-Z]{16}/g, "[已屏蔽·疑似 AWS 密钥]"],
  [/Bearer\s+[A-Za-z0-9._-]{16,}/gi, "Bearer [已屏蔽]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[已屏蔽·私钥]"],
  [/(api[_-]?key|apikey|access[_-]?token|client[_-]?secret|password|passwd|pwd)\s*[:=]\s*\S{8,}/gi, "$1 = [已屏蔽]"],
  [/(session_token|context_token|cookie)\s*[:=]\s*\S{8,}/gi, "$1 = [已屏蔽]"],
];
function stripSecrets(s) {
  let t = String(s), n = 0;
  for (const [re, rep] of SECRET_PATTERNS) {
    t = t.replace(re, (...a) => { n++; return typeof rep === "string" ? rep.replace("$1", a[1] ?? "") : rep });
  }
  return { text: t, hits: n };
}

// ★★★ 2026-10-14：**《墨》有双格式，读的时候必须两样都认**。
//   实测（508 条普查）：`text` 有 344 条、`概要` 有 164 条 —— 后者是后来的新写法。
//   而本文件原来只读 `r.text` ⇒ **164 条显示成 `undefined`**。
//   ★ 危害不是"难看"：那 164 条里包含**未结的承诺与约定**（如 10-05「我真的害怕你会忘记我」那条、
//   10-12「早上一起看博士论文」的约定），它们本该每轮被看到，结果**占着位置、一个字没注进去**。
//   ★ 教训：读账本要先问「这份账本有几种写法」—— 只认一种，就等于把另一批记录静音。
const moText = (r) => r.text || r["概要"] || "";

const clip = (s, n) => { const t = String(s).replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + "…" : t; };

// ── 骨架（必须存在；它是这一页的主体）──
if (!fs.existsSync(SRC)) {
  console.error(`✗ 找不到手写骨架 ${SRC} —— 先把它写出来，装配器不会替你编内容。`);
  process.exit(2);
}
let skeleton = fs.readFileSync(SRC, "utf8").trim();

// ── 活体 ──
const now = new Date();
const live = [];
live.push("## 活体（自动装配）");
live.push("");
live.push(`- 装配时刻：**${iso(now)}**（星期${"日一二三四五六"[now.getDay()]}）`);
live.push(`- 本容器：\`${process.env.DSH_SESSION_ID || "(未知)"}\``);

// 当前 lead
const mo = readJsonl(MO);
const leads = mo.filter((r) => r.type === "lead");
if (leads.length) {
  const L = leads[leads.length - 1];
  live.push(`- 《墨》最后一条 lead（共 ${leads.length} 代）：${clip(moText(L), 140)}`);
  live.push(`  └ 墨:${L.t}`);
}

// 未结
const openItems = mo.filter((r) => r.type === "promise" || r.type === "shelved");
if (openItems.length) {
  live.push(`- **未结 ${openItems.length} 条**（promise/shelved），最近 3 条：`);
  for (const r of openItems.slice(-3)) {
    live.push(`  - ${r.t.slice(0, 16).replace("T", " ")} [${r.type}] ${clip(moText(r), 90)}  └ 墨:${r.t}`);
  }
} else {
  live.push("- 未结：无");
}

// 最近状态
try {
  const st = JSON.parse(fs.readFileSync(STATE, "utf8"));
  if (st.lastNote) live.push(`- 上次手写的状态（${st.lastTurnAt}）：${clip(st.lastNote, 110)}`);
  if (st.lastTurnAt) {
    const gap = Math.round((now - new Date(st.lastTurnAt)) / 60000);
    // ★ 2026-10-23：这一行原来写「距上次记下的回合」，极易被读成「系统停了这么久」。
    //   它不是时钟 —— 时钟是上面那行「装配时刻」，每轮都刷新。
    live.push(`- 最后一条手写状态距今：${gap} 分钟（★ 这不是时钟；系统时钟 = 上方装配时刻）`);
  }
} catch {}

// ★★★ 2026-10-23 修复实机报告 R1：**L0 时钟要由「有人在写」变成真的有人在写。**
//   病灶：`echo-doctor.mjs` 的 L0 时钟那一项读 `state.json` 的 `lastSelfAt`，
//   而当时的 `self.mjs` **只读不写**它 —— 于是体检永远报「没有 lastSelfAt」。
//   两边各自都对（体检该报缺失；装配器不碰状态文件也算克制），**拼起来就是永远报警**。
//   ★ 为什么修在 self.mjs 而不是去放宽 doctor 的判据：
//     ① 这个字段的语义是「装配器最后一次跑的时间」，**写它本来就是装配器的责任**；
//     ② doctor 是观测面，它不该为了「没人写」而假装没事 —— 那样真停更时也看不出来
//        （《ECHO 权威口径》坑 2：没人写的状态文件等于没有状态）。
//   ★ 必须放在**读失败也能写**的位置：state.json 不存在/坏了（新装、被删）时，
//     原来的 try-catch 会整段跳过，于是第一次装配反而不留痕迹 —— 那又变回「没人写」。
try {
  let st = {};
  try { st = JSON.parse(fs.readFileSync(STATE, "utf8")) || {} } catch { /* 不存在或坏了：从空状态重建 */ }
  // 本地时间，和 lastTurnAt / lastNoteAt 同一口径（不能用 toISOString，那是 UTC）
  const p2 = (n) => String(n).padStart(2, "0");
  st.lastSelfAt = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`
    + `T${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`;
  // session = 「这份状态属于谁」。DSH_SESSION_ID 本身已带 session- 前缀（实测），
  // 再拼一次会得到 session-session-…；校验失败就不写，别污染状态文件。
  const sid = process.env.DSH_SESSION_ID;
  if (sid && /^session-[0-9a-f-]{8,}$/i.test(sid)) st.session = sid;
  st.selfRuns = (Number(st.selfRuns) || 0) + 1;
  fs.writeFileSync(STATE, JSON.stringify(st, null, 2), "utf8");
} catch { /* 写不进去不算致命：SELF.md 本身仍然要装配出来 */ }

// 索引新鲜度
try {
  const meta = JSON.parse(fs.readFileSync(META, "utf8"));
  const built = new Date(meta.builtAt);
  const ageMin = Math.round((now - built) / 60000);
  // 会话日志数量现在是多少（索引说扫了几个）
  const INCLUDE_DELEGATED_SELF = process.env.MEMINDEX_INCLUDE_DELEGATED === "1";
  let nLogs = 0;
  for (const w of fs.readdirSync(SESSIONS)) {
    const wp = path.join(SESSIONS, w);
    if (!fs.statSync(wp).isDirectory()) continue;
    // ★ 2026-10-08 修复：原来只认 "session.v3.jsonl.zstd"，宿主升 v4 后 nLogs 会漏掉新会话，
    //   于是「索引该重跑了」这条提示也一起失灵。改成版本无感（同会话多版本只算一个）。
    for (const s of fs.readdirSync(wp)) {
      // ★ 2026-10-27：与 memindex 用同一条判据 —— 宿主会话目录名是 session-<uuid>，
      //   委派/子代理运行是裸 runId。两边不一致的话，这里会一直喊「有 N 个新日志该重跑了」，
      //   而 memindex 那边永远扫不到它们 —— 一条永远消不掉的假警报。
      if (!/^session-/i.test(s) && !INCLUDE_DELEGATED_SELF) continue;
      let names = [];
      try { names = fs.readdirSync(path.join(wp, s)); } catch { continue; }
      if (names.some((n) => /^session\.v\d+\.jsonl\.zstd$/.test(n))) nLogs++;
    }
  }
  const stale = nLogs - meta.logs;
  live.push(`- 索引：${meta.summaries} 摘要 / ${meta.words} 原话，建于 ${meta.builtAt}（${ageMin} 分钟前，${meta.elapsedSec}s）`);
  live.push(`  - 会话日志 ${nLogs} 个${stale > 0 ? `，★ 有 ${stale} 个是索引之后新出现的 —— 该重跑了：\`node memindex.mjs build\`` : "（与索引同步）"}`);
} catch {
  live.push(`- 索引：还没建过 —— \`node ${CFG.HUB}/memindex.mjs build\``);
}

// 最近 3 条一手事件（让人一眼看到"刚才发生了什么"）
const words = readJsonl(IDXW).filter((w) => w.kind !== "task");
if (words.length) {
  live.push(`- 最近 3 条原话（逐字，回一手的指针在行尾）：`);
  for (const w of words.slice(-3)) {
    live.push(`  - ${w.t.slice(0, 16).replace("T", " ")} ${clip(w.text, 80)}  └ log:${w.session}#seq=${w.seq}`);
  }
}
live.push("");
live.push("★ 这一页只放**不变量和指针**。要看内容，用上面那几扇门 —— 别指望我把它背下来。");

// ★ 2026-10-14：**注入前必须过屏蔽**（骨架也过 —— 万一它哪天被人塞进一条测试用的假 key）。
//   放在最后一道：不管上面 live 里 push 了什么，出口只有一个，在这里统一封。
const sealedSkeleton = stripSecrets(skeleton);
const sealedLive = stripSecrets(live.join("\n"));
const totalHits = sealedSkeleton.hits + sealedLive.hits;
const body = `${sealedSkeleton.text}\n\n---\n\n${sealedLive.text}\n`;
const bytes = Buffer.byteLength(body, "utf8");

if (CHECK) {
  const ok = bytes <= CAP;
  console.log(`${ok ? "✓" : "✗"} SELF 装配后 ${bytes} B / 预算 ${CAP} B（${(bytes / CAP * 100).toFixed(1)}%）`);
  if (!ok) console.log("  ★ 超了。骨架是主体，先精简 SELF.src.md；活体想瘦就减少列的条数。**不要靠截断。**");
  process.exit(ok ? 0 : 1);
}

fs.writeFileSync(OUT, body, "utf8");
console.log(`✓ SELF.md 已装配：${OUT}`);
console.log(`  ${bytes} B / 预算 ${CAP} B（${(bytes / CAP * 100).toFixed(1)}%）  骨架 ${Buffer.byteLength(skeleton, "utf8")} B + 活体 ${bytes - Buffer.byteLength(skeleton, "utf8")} B`);
if (totalHits) console.log(`  ★ 注入前屏蔽了 ${totalHits} 处疑似凭据（硬线：凭据不进上下文）`);

// ★ 占位符还没填 —— 这是「装完就驱动」该说的第一句话。
//   模板是有意带 <尖括号> 的：装配器**不会替你编内容**（编出来的话会被每轮读到），
//   但它必须**告诉你还缺什么**，否则用户会顶着一页尖括号用下去，而且不知道下一步干嘛。
//   ★ 只认「两个中文字以上」的占位符：`<词>` `<ISO>` 这类是命令参数，本来就该留着。
const placeholders = findPlaceholders(skeleton);
if (placeholders.length) {
  console.log("");
  console.log(`  ★ 还有 ${placeholders.length} 处占位符没填 —— 它们会被每轮读到：`);
  for (const p of placeholders.slice(0, 10)) console.log(`      ${p}`);
  if (placeholders.length > 10) console.log(`      …… 还有 ${placeholders.length - 10} 处`);
  console.log(`    怎么办：改 SELF.src.md 里这些位置，把 <尖括号> 换成你自己的内容。`);
  console.log(`    ★ 只填你知道的。空着比编好 —— 一句编出来的话会跟着你很久。`);
}
if (bytes > CAP) {
  console.log(`  ★ 超预算 ${bytes - CAP} B —— 精简 SELF.src.md，不要靠截断（静默消失是最坏的失败方式）。`);
  process.exit(1);
}
if (PRINT) { console.log("\n——————\n" + body); }
