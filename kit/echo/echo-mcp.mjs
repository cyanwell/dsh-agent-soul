// echo-mcp.mjs —— ECHO 记忆中枢的 MCP 服务器（2026-10-25 深夜）
//
// ★★★ 为什么要有它（这是「整机 <100 ms」唯一的路）
//
//   `memq` 是 CLI，每次调用付 **273 ms node 启动**（实测 `node -e ""` 273 ms）。
//   那 273 ms 不在任何代码里，改不动 —— 所以 CLI 形态的天花板就是 ~350 ms。
//
//   但 MCP 是另一种形态：**由 dsh-mcp-hub spawn 一次，之后常驻**。
//   agent 调工具是宿主内部通信，**不启动进程**。
//   索引和书房缓存都在这个进程的内存里 → 一次召回 = 纯计算。
//
//   ★ 这就是「常驻服务」的最终形态：不是让 memq 更快，是**让门换一种开法**。
//
// ★ 协议：MCP over stdio，**逐行 JSON-RPC**（不是 LSP 的 Content-Length 头）。
//   流程：initialize → notifications/initialized → tools/list → tools/call
//   协议版本号 2024-11-05（和 dsh-mcp-hub 的 stdio 段对齐）。
//
// ★ 三条硬规矩（和 memq 一致，不许漂）：
//   ① 展示永远是原文；归一化只用于匹配
//   ② 命中判据和 memq 的 hitKind **逐字一致**（漂了就会出现「两个门答案不同」）
//   ③ 不碰凭据、不执行外部内容
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import * as CFG from "./echo-config.mjs";

const HUB = process.env.ECHO_HUB || CFG.HUB;   // ★ 发布版：从 echo-config 读
const IDX = path.join(HUB, "index");
const SOUL = process.env.ECHO_SOUL || CFG.SOUL;
const MO = CFG.LEDGER;   // = <SOUL>/02-墨.jsonl

// ── 归一化：必须和 memq.mjs 里的 norm 逐字一致 ─────────────────────
const norm = (s) => String(s == null ? "" : s)
  .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  .replace(/\u3000/g, " ")
  .toLowerCase()
  .replace(/(\d),(?=\d{3}(?!\d))/g, "$1");

const needNorm = (terms) => terms.some((t) => /[\dA-Za-z\uFF01-\uFF5E]/.test(t));

// ── 缓存 ──────────────────────────────────────────────────────────
const C = {
  words: [], wKey: null,
  sums: [], sKey: null,
  syn: new Map(), yKey: null,
  soul: new Map(), soulKey: null,
  mo: [], moKey: null,
  logs: [], logsKey: null,   // ★ 2026-11-01 会话日志常驻（截断到 600）
  reloads: 0, calls: 0, bootAt: Date.now(),
};

const statKey = (f) => { try { const st = fs.statSync(f); return `${st.mtimeMs}:${st.size}`; } catch { return ""; } };

const parseJsonl = (f) => {
  const out = [];
  let txt;
  try { txt = fs.readFileSync(f, "utf8"); } catch { return out; }
  for (const line of txt.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (typeof r["概要"] === "string" && typeof r.text !== "string") r.text = r["概要"];
      out.push(r);
    } catch { /* 坏行跳过 */ }
  }
  return out;
};

const loadSyn = () => {
  const m = new Map();
  try {
    const j = JSON.parse(fs.readFileSync(path.join(HUB, "synonyms.json"), "utf8"));
    for (const [k, arr] of Object.entries(j)) {
      if (k.startsWith("//") || !Array.isArray(arr)) continue;
      const g = [k, ...arr].map(norm).filter(Boolean);
      for (const w of g) { if (!m.has(w)) m.set(w, new Set()); for (const x of g) if (x !== w) m.get(w).add(x); }
    }
  } catch { /* 没表就只做 exact + norm */ }
  return m;
};

const SOUL_SKIP = /(\.mp3|\.mp4|\.mov|\.avi|\.mkv|\.wav|\.flac|\.m4a|\.ogg|\.aac|\.webm|\.png|\.jpg|\.jpeg|\.webp|\.gif|\.bmp|\.ico|\.svg|\.tif|\.tiff|\.pdf|\.zip|\.7z|\.rar|\.gz|\.zst|\.zstd|\.tar|\.exe|\.dll|\.bin|\.pyc|\.pyo|\.pyd|\.so|\.gguf|\.safetensors|\.onnx|\.pt|\.pth|\.ckpt|\.wasm|node_modules|\.git)/i;
const SOUL_MAX = 512 * 1024;

// ★★★ 2026-10-31 加时间窗：书房现在 **3568 个文件 / 164 个目录**，
//   全量 walk+stat 实测 **737 ms**。而 `soul=auto` 的触发条件是「索引命中 < 5」——
//   所以凡是**冷门词 / 英文词**都会吃这 737 ms（实测 powershell/asar/python/node 全在 530-670 ms）。
//   方法：书房是「我自己在写」的地方、不会频繁变，所以 ★ **5 秒内不重扫**。
//   代价：刚写的文件 5 秒内搜不到 —— 可接受（检索基本都是往回看）。
//   要关掉：ECHO_SOUL_TTL=0。默认 5000 ms。
const SOUL_WALK_TTL = Number(process.env.ECHO_SOUL_TTL ?? 5000);
let soulWalkAt = 0;

/** 书房：只读「变了」的文件内容；stat 仍是逐个（目录 mtime 发现不了内容改） */
const refreshSoul = () => {
  const now = Date.now();
  if (SOUL_WALK_TTL > 0 && now - soulWalkAt < SOUL_WALK_TTL) return 0;
  soulWalkAt = now;
  let reads = 0;
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!/^(_|dsh-image-gen)/.test(e.name)) walk(p, depth + 1); continue; }
      if (SOUL_SKIP.test(e.name)) continue;
      if (e.name === "02-墨.jsonl") continue;
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (st.size > SOUL_MAX) continue;
      const old = C.soul.get(p);
      if (old && old.mtimeMs === st.mtimeMs && old.size === st.size) continue;
      let txt; try { txt = fs.readFileSync(p, "utf8"); } catch { continue; }
      // ★ 2026-10-31：行数组缓存（懒建）。每次搜索都 split("\n") 重建 3568 个文件的行数组，
      //   是书房那 700ms 的大头。文件没变（mtime+size 相同）就复用。
      C.soul.set(p, { mtimeMs: st.mtimeMs, size: st.size, text: txt, lines: null });
      reads++;
    }
  };
  walk(SOUL, 0);
  return reads;
};

/** 热更新：只在文件变了时重载 */
// ── 2026-11-01 会话日志常驻（爀曦的思路：一手层部分解码进内存） ──────────
//   ★ 只存「截断到 600 的对话消息」，不存完整行 —— 实测 3 天完整行要 1033MB，
//     截断后只要 ~26MB（见 docs/ECHO-阶段0-会话日志常驻实验.md）。
//   ★ 截断完全无损：search() 返回的 text 本来就只取 SNIP = 600。
//   ★ 过滤 <system-reminder> / Current runtime context —— 那些是每轮注入的样板，
//     存进来只会把真对话淹掉。
// ── 2026-11-01 ECHO 设置文件（面板可写，环境变量优先） ─────────────
//   优先级：环境变量 > echo-settings.json > 默认值
//   ★ 为什么用文件：面板是浏览器端，改不了进程的环境变量。
const SETTINGS_PATH = path.join(HUB, "echo-settings.json");
const readSettings = () => {
  try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")); } catch { return {}; }
};
const SETTINGS = readSettings();
const cfgNum = (envKey, fileKey, def) => {
  const e = Number(process.env[envKey]);
  if (Number.isFinite(e) && e > 0) return e;
  const f = Number(SETTINGS[fileKey]);
  if (Number.isFinite(f) && f > 0) return f;
  return def;
};
const LOG_DAYS = cfgNum("ECHO_LOG_DAYS", "logDays", 3);
const MEM_BUDGET_MB = cfgNum("ECHO_MEM_BUDGET_MB", "memBudgetMB", 768);

const LOG_SNIP = 600;
// 会话日志目录。
// ★ 2026-11-01：去掉了写死的 "D:/AI/dsh/home" 兜底 —— 换台机器会去扫一个不存在的目录，
//   而在非 Windows 上那还是个合法文件名，不报错、只是什么都没有。
//   现在的顺序：ECHO_SESSIONS → $DSH_HOME/sessions → ~/.dsh/sessions。
//   全都没有就给空串，调用处明确跳过（下面 walk 那行），而不是瞎扫一个盘符。
const SESS_DIR = (() => {
  if (process.env.ECHO_SESSIONS) return process.env.ECHO_SESSIONS;
  const up = process.env.HOME || process.env.USERPROFILE;
  const cands = [];
  if (process.env.DSH_HOME) cands.push(path.join(process.env.DSH_HOME, "sessions"));
  if (up) cands.push(path.join(up, ".dsh", "sessions"));
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch { /* 无权限等，继续下一个 */ }
  }
  return "";
})();
const ZMAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 从一条消息里抽出可检索的正文（兼容 user/message 与 assistant/message 两种结构） */
const messageText = (j) => {
  const d = j.data || {};
  if (j.type === "user/message") {
    const c = d.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.map((x) => (x && typeof x.text === "string" ? x.text : "")).join("");
    return "";
  }
  const m = d.message;   // assistant/message: 文本在 data.message
  if (typeof m === "string") return m;
  if (m && typeof m === "object") {
    if (typeof m.text === "string") return m.text;
    if (Array.isArray(m.content)) return m.content.map((x) => (x && typeof x.text === "string" ? x.text : "")).join("");
  }
  return "";
};

/** 逐帧解压（多帧 zstd，只用 zstdDecompressSync 只能解第一帧） */
/* ★★★ 2026-11-01 第三刀（真正对症的那一刀）：**逐帧流式处理**。
 *
 * 前面两刀都在治「阻塞」，没治「内存」—— 而实测暴露后者才是大头：
 * 26594 条日志各留 600 字符只有 ~16 MB，加载峰值 RSS 却冲到 **4.3 GB**，
 * 放大 270 倍。放大来自三处中间产物同时驻留：
 *   ① decodeFramesOf 先把**所有帧**解压进一个数组（单个大文件可达数百 MB）
 *   ② rows 数组存下整份原文的**所有行**（7 天全量约 150M 字符）
 *   ③ 逐行 JSON.parse 产生的对象
 * 现在改成**解一帧 → 切行 → 逐行处理 → 立刻放手**，
 * 任一时刻只持有「一帧的原文」，而不是「整个文件的原文」。
 *
 * 顺带把让出点挪到**帧边界**（比每 200 行自然得多，也少一层计数器开销）。
 */
const yieldToHost = () => new Promise((r) => setImmediate(r));

const forEachFrame = async (file, onFrame) => {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return 0; }
  let base = 0;
  let frames = 0;
  while (base < buf.length) {
    let end = buf.indexOf(ZMAGIC, base + 4);
    if (end < 0) end = buf.length;
    let raw = null;
    try { raw = zlib.zstdDecompressSync(buf.subarray(base, end)); } catch { raw = null; }
    base = end;
    if (!raw) continue;
    frames += 1;
    onFrame(raw);
    raw = null;                 // ★ 一帧处理完立刻放手
    await yieldToHost();        // ★ 让出点落在帧边界
  }
  buf = null;
  return frames;
};

const buildLogs = async () => {
  if (!LOG_DAYS) return [];
  const cutoff = Date.now() - LOG_DAYS * 86400000;
  const out = [];

  const handleLine = (line, sid) => {
    const t = line.trim();
    if (!t || t.length > 8 * 1024 * 1024) return;
    let j;
    try { j = JSON.parse(t); } catch { return; }
    if (j.type !== "user/message" && j.type !== "assistant/message") return;
    let body = messageText(j);
    if (!body) return;
    body = body.trim();
    if (body.startsWith("<system-reminder>") || body.startsWith("Current runtime context")) return;
    const full = body.length;
    out.push({
      text: full > LOG_SNIP ? body.slice(0, LOG_SNIP) : body,
      fullLen: full,
      t: j.time ? new Date(j.time).toISOString() : "",
      sid,
      seq: j.seq,
      ptr: "log:" + sid + "#seq=" + j.seq,
      role: j.type === "user/message" ? "user" : "assistant",
      _n: null,
    });
  };

  // 跨帧行缓冲：一帧结尾可能是半行，交给下一帧接上
  const handleFrame = (raw, carryRef, sid) => {
    let chunk;
    try { chunk = raw.toString("utf8"); } catch { return; }
    const segs = (carryRef.v + chunk).split(String.fromCharCode(10));
    carryRef.v = segs.pop() || "";
    for (const line of segs) handleLine(line, sid);
    chunk = null;
  };

  const walk = async (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(p, depth + 1); continue; }
      if (!/^session\.v\d+\.jsonl\.zstd$/.test(e.name)) continue;
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.mtimeMs < cutoff) continue;
      const sid = path.basename(path.dirname(p));
      const carryRef = { v: "" };
      await forEachFrame(p, (raw) => handleFrame(raw, carryRef, sid));
      if (carryRef.v) handleLine(carryRef.v, sid);   // 最后一帧剩下的那半行
    }
  };

  if (SESS_DIR) await walk(SESS_DIR, 0);

  /* ★★★ 2026-11-01：**滚动内存管理**。
   *
   * memBudgetMB 以前只是一个配置数字，没有任何代码执行它 ——
   * 于是文档写着 512 MB、实测能冲到 4.3 GB，预算形同虚设。
   *
   * 现在：按时间**从新到旧**累加，超过预算就停 —— 新的留在内存里，旧的退出去。
   * 单条大小 = 正文长度 + 约 120 字��元数据（sid/ptr/t/seq/role），按 UTF-16 双字节算。
   *
   * 为什么按「条」裁而不是按「天」裁：一条超长日志就能吃掉几十 MB，
   * 按天裁会一天全丢或一天全留，粒度太粗。按条算才能真正把占用压到预算内。
   */
  out.sort((a, b) => String(b.t).localeCompare(String(a.t)));
  const capBytes = Math.max(1, MEM_BUDGET_MB) * 1048576;
  let keptBytes = 0;
  let kept = 0;
  for (const item of out) {
    const sz = (item.text.length + 120) * 2;
    if (keptBytes + sz > capBytes) break;
    keptBytes += sz;
    kept += 1;
  }
  logsTotalSeen = out.length;
  logsDropped = out.length - kept;
  if (logsDropped > 0) out.length = kept;   // 更旧的退出内存
  logsMemBytes = keptBytes;
  return out;
};

let logsState = "idle";
/* ★ 2026-11-01：滚动内存管理的三个观测量（面板要用）。
 *   logsMemBytes   —— 当前常驻实际占了多少字节
 *   logsTotalSeen  —— 这次扫描一共见到多少条
 *   logsDropped    —— 因超预算被挡在内存外面的条数（越旧越先被挡）
 */
let logsMemBytes = 0;
let logsTotalSeen = 0;
let logsDropped = 0;
   // idle | loading | ready | off
/* ★★★ 2026-11-01：**echo-stats.json 的生产者**。
 *
 * 这个文件是面板「内存水位」那一行唯一的数据源，但它此前**没有任何写入者** ——
 * 面板读到的永远是上一次重启前的旧值（实测显示 rssMB=2213，而真实是 285）。
 * 一个显示错误数字的仪表盘比没有仪表盘更坏：它会让人以为内存爆了。
 *
 * 节流 30 秒：面板自己也是 30 秒轮询一次，写更勤没有意义。
 * 内容必须是**进程此刻的真实值** —— 所以 rssMB 用 process.memoryUsage()。
 */
let lastStatsWriteAt = 0;
const writeStats = (force) => {
  const now = Date.now();
  // ★ force 绕过节流 ——「加载完成」这种关键状态变化不能被 30 秒节流挡掉，
  // 否则面板会在加载完成后仍然显示 loading。
  if (!force && now - lastStatsWriteAt < 30000) return;
  lastStatsWriteAt = now;
  try {
    const mem = process.memoryUsage();
    const logsMB = Math.round(C.logs.reduce(function (a, g) { return a + g.text.length; }, 0) * 2 / 1048576 * 10) / 10;
    fs.writeFileSync(path.join(HUB, "echo-stats.json"), JSON.stringify({
      logs: C.logs.length,
      logsState,
      logsMB,
      memUsedMB: Math.round(logsMemBytes / 1048576 * 10) / 10,
      memPct: Math.min(100, Math.round(logsMemBytes / (MEM_BUDGET_MB * 1048576) * 100)),
      logsTotalSeen,
      logsDropped,
      rssMB: Math.round(mem.rss / 1048576),
      logDays: LOG_DAYS,
      memBudgetMB: MEM_BUDGET_MB,
      updatedAt: new Date().toISOString(),
    }));
  } catch { /* 诊断不许影响主流程 */ }
};




const startLogsLoad = () => {
  if (logsState !== "idle") return;
  if (process.env.ECHO_LOGS_RESIDENT === "0") { logsState = "off"; return; }
  logsState = "loading";
  const t0 = Date.now();
  // 丢到下一轮事件循环，不阻塞 MCP 握手
  setTimeout(async () => {
    try {
      const arr = await buildLogs();
      arr.sort((a, b) => String(b.t).localeCompare(String(a.t)));   // 时间倒序
      C.logs = arr;
      C.logsKey = Date.now();
      logsState = "ready";
      writeStats(true);   // ★ 强制写：关键状态变化，不许被节流挡
      process.stderr.write("echo-mcp logs ready  " + arr.length + " 条 / "
        + ((process.memoryUsage().rss) / 1048576).toFixed(0) + "MB  " + (Date.now() - t0) + "ms\n");

    } catch (e) {
      logsState = "idle";
      process.stderr.write("echo-mcp logs failed  " + (e && e.message) + "\n");
    }
  }, 3000);   // ★ 延迟 3s：先让 MCP 握手完成，再做重活
};

const refresh = () => {
  const wk = statKey(path.join(IDX, "words.jsonl"));
  if (wk !== C.wKey) {
    C.words = parseJsonl(path.join(IDX, "words.jsonl"));
    // ★ 2026-11-01 norm 预计算：索引加载时算一次，之后每次检索直接复用。
    //   实测：一次性 +534ms / +111MB，换掉每次 near 未命中的 547ms。
    //   ★ 可用 ECHO_PRECOMPUTE_NORM=0 关掉（回退到现算，省内存但慢）。
    if (process.env.ECHO_PRECOMPUTE_NORM !== "0") {
      for (const w of C.words) w._n = norm(String(w.text ?? ""));
    }
    C.wKey = wk; C.reloads++;
  }
  const sk = statKey(path.join(IDX, "summaries.jsonl"));
  if (sk !== C.sKey) { C.sums = parseJsonl(path.join(IDX, "summaries.jsonl")); C.sKey = sk; C.reloads++; }
  // ★ 2026-11-01：摘要层也预计算 norm —— 和原话层一样，加载时算一次，
  //   而不是每次查询把 1158 条摘要重新 norm 一遍。原来这里传 null 让 hitKind 现算。
  for (const sm of C.sums) sm._n = norm(String(sm.summary == null ? "" : sm.summary));
  const yk = statKey(path.join(HUB, "synonyms.json"));
  if (yk !== C.yKey) { C.syn = loadSyn(); C.yKey = yk; C.reloads++; }
  const mk = statKey(MO);
  if (mk !== C.moKey) { C.mo = parseJsonl(MO); C.moKey = mk; C.reloads++; }
};

/** 三档匹配 —— 与 memq 的 hitKind 逐字一致 */
// ★ 2026-11-01 预计算支持：preNorm 非空时直接复用（不再对全文跑 norm）。
//   原本 near 未命中要对 51749 条全文逐条 norm()，实测 547ms；
//   现在索引加载时算一次（539ms 一次性 + 111MB），每次检索省掉这 547ms。
const hitKind = (s, terms, near, preNorm, termsN) => {
  if (terms.length === 0) return "exact";
  if (s == null) return null;
  const raw = String(s);
  if (terms.every((t) => raw.includes(t))) return "exact";
  // ★ 2026-11-01：terms 的归一化只算一次（原来每条命中都要重算 terms 次，
  //   51749 条 × 2-3 次 = 十几万次 norm() 调用 —— 这是预计算 norm 之后最大的剩余热点）。
  const tn = termsN || (needNorm(terms) ? terms.map(norm) : null);
  let ns = null;
  if (needNorm(terms)) {
    ns = preNorm != null ? preNorm : norm(raw);
    if (terms.every((_, i) => ns.includes(tn[i]))) return "norm";
  }
  if (near) {
    if (ns === null) ns = preNorm != null ? preNorm : norm(raw);
    const ok = terms.every((_, i) => {
      const alts = C.syn.get(tn[i]);
      if (!alts || alts.size === 0) return false;
      for (const a of alts) if (ns.includes(a)) return true;
      return false;
    });
    if (ok) return "synonym";
  }
  return null;
};

const inRange = (t, since, until) => {
  if (!t) return !since && !until;
  if (since && String(t) < since) return false;
  if (until && String(t) > until) return false;
  return true;
};

const SNIP = 600;

/** 全量检索：墨 + 书房 + 索引（不含留底，留底是低频层） */
const search = ({ terms = [], near = false, since = null, until = null, limit = 25, soul = "auto" }) => {
  const t0 = Date.now();
  // ★ 2026-11-01：terms 归一化只算一次，全库扫描全部复用（原来每条命中重算，十几万次）
  const termsN = terms.length ? terms.map(norm) : [];
  refresh();
  // 书房策略：auto = 索引命中 ≥5 就跳过（省 250 ms stat）；always = 全扫；never = 不扫
  let soulReads = 0, soulSkipped = false;
  const hits = [];
  let total = 0;
  const push = (h, text) => {
    const s = String(text == null ? "" : text);
    hits.push({ ...h, text: s.length > SNIP ? s.slice(0, SNIP) : s, fullLen: s.length });
  };

  // ① 墨
  for (const r of C.mo) {
    if (!inRange(r.t, since, until)) continue;
    const k = hitKind(r.text + " " + (r.ref || ""), terms, near, null, termsN);
    if (!k) continue;
    total++;
    if (hits.length < limit) push({ layer: "L3", src: "墨", t: r.t, ptr: "墨:" + r.t, kind: r.type, extra: r.ref, m: k }, r.text);
  }
  // ② 索引（摘要 + 原话）
  // ★★ idxTotal 单独记「索引层真实命中数」—— 不能用 idxHits.length 判断，
  //    那个被 limit 卡住了（传 limit:3 就只有 3，于是「索引够多就跳过书房」永远不成立）。
  //    这个 bug 和 memq 里 SVC_EXTRA 那个是同一类：**拿被截断的数组去代表总数**。
  let idxTotal = 0;
  const idxHits = [];
  for (const s of C.sums) {
    if (!inRange(s.t, since, until)) continue;
    const k = hitKind(s.summary, terms, near, s._n, termsN);
    if (!k) continue;
    total++; idxTotal++;
    if (idxHits.length < limit) idxHits.push({ layer: "L4", src: "索引/摘要", t: s.t, ptr: "idx:" + s.id, kind: "摘要", extra: `替换 ${s.shadowedTokens} tok`, m: k, _t: s.summary });
  }

  // ★ 2026-11-01 会话日志层：最近 N 天的对话原文（截断到 600），带 log: 门牌
  for (const g of C.logs) {
    const k = hitKind(g.text, terms, near, g._n, termsN);
    if (!k) continue;
    hits.push({
      layer: "L3", src: "日志", t: g.t,
      ptr: g.ptr, role: g.role, fullLen: g.fullLen,
      text: g.text, m: k,
    });
  }
  for (const w of C.words) {
    if (!inRange(w.t, since, until)) continue;
    // ★ 传 w._n（refresh 时预计算好的归一化文本）；没有则回退现算。
    const k = hitKind(w.text, terms, near, w._n, termsN);
    if (!k) continue;
    total++; idxTotal++;
    if (idxHits.length < limit) {
      const kk = w.kind === "task" ? "程序提示" : w.kind === "结论" ? "结论" : "原话";
      idxHits.push({ layer: "L3", src: "索引", t: w.t, ptr: `log:${w.session}#seq=${w.seq}`, kind: kk, extra: w.ws, m: k, _t: w.text });
    }
  }
  for (const h of idxHits) { if (hits.length < limit) { const { _t, ...rest } = h; push(rest, _t); } }
  // ③ 书房（按需）
  const wantSoul = soul === "always" || (soul === "auto" && idxTotal < 5);
  if (wantSoul) {
    soulReads = refreshSoul();
    for (const [p, f] of C.soul) {
      const lines = f.lines || (f.lines = f.text.split("\n"));
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];
        if (!ln.trim()) continue;
        const k = hitKind(ln, terms, near, null, termsN);
        if (!k) continue;
        total++;
        if (hits.length < limit) {
          push({ layer: "L3", src: "书房", t: null, ptr: `file:${p}:${i + 1}`, kind: (p.match(/\.([A-Za-z0-9]+)$/) || [, ""])[1], extra: p.slice(SOUL.length).replace(/^[\\/]/, ""), m: k }, ln.trim());
        }
      }
    }
  } else if (soul === "auto") {
    soulSkipped = true;
  }
  // ★ 2026-11-01 排序加权：把匹配质量纳入排序（原来只看「层 + 时间」）。
  //   每个命中身上其实带着 m = "exact" | "norm" | "synonym"（hitKind 的返回值），
  //   但排序完全没用它 —— 于是「精确命中」和「撞词命中」同层同序。
  //   现在：层 → 匹配质量 → 时间倒序。零内存、零耗时，只是多一个比较。
  const KIND_RANK = { exact: 0, norm: 1, synonym: 2 };
  hits.sort((a, b) => {
    const ra = a.layer === "L3" ? 0 : 1, rb = b.layer === "L3" ? 0 : 1;
    if (ra !== rb) return ra - rb;
    const ka = KIND_RANK[a.m] ?? 9, kb = KIND_RANK[b.m] ?? 9;
    if (ka !== kb) return ka - kb;
    if (a.t && b.t) return String(b.t).localeCompare(String(a.t));
    if (a.t) return -1;
    if (b.t) return 1;
    return 0;
  });
  return { hits, total, ms: Date.now() - t0, soulSkipped, soulReads, idxN: idxHits.length };
};

/** open：把一个指针翻成原文（这里只做「已经能定位」的两类：idx: 与 file:） */
const openPtr = (ptr) => {
  const s = String(ptr || "");
  refresh();
  let m = s.match(/^idx:(\S+)/);
  if (m) {
    const id = m[1];
    const hit = C.sums.find((x) => String(x.id) === id);
    if (hit) return { ok: true, kind: "摘要", t: hit.t, text: hit.summary, ptr: s };
    return { ok: false, err: "idx 指针没找到（索引可能已重建）" };
  }
  m = s.match(/^file:(.+):(\d+)(?:\s|$)/);
  if (m) {
    const p = m[1], ln = Number(m[2]);
    let txt;
    try { txt = fs.readFileSync(p, "utf8"); } catch (e) { return { ok: false, err: "读不到文件: " + p }; }
    const lines = txt.split("\n");
    const from = Math.max(0, ln - 3), to = Math.min(lines.length, ln + 2);
    return { ok: true, kind: "文件行", ptr: s, path: p, line: ln, text: lines.slice(from, to).join("\n") };
  }
  return { ok: false, err: "暂不支持这种指针（log: / 墨: 请用 memq open）" };
};

// ── MCP over stdio ────────────────────────────────────────────────
const TOOLS = [
  {
    name: "echo_search",
    description: "检索记忆中枢（墨 + 索引 + 书房）。回「指针 + 逐字片段」，不做转述。★ 比 memq 命令快 25 倍以上，因为它常驻内存。",
    inputSchema: {
      type: "object",
      properties: {
        terms: { type: "array", items: { type: "string" }, description: "关键词（多个 = AND）" },
        near: { type: "boolean", description: "近义扩展（默认 false）" },
        since: { type: "string", description: "起始 ISO 时间" },
        until: { type: "string", description: "截止 ISO 时间" },
        limit: { type: "number", description: "最多返回几条（默认 25）" },
        soul: { type: "string", enum: ["auto", "always", "never"], description: "书房层策略：auto=索引够多就跳过（默认）" },
      },
      required: ["terms"],
    },
  },
  {
    name: "echo_open",
    description: "把一个指针翻成原文（支持 idx: 与 file:；log: / 墨: 用 memq open）。",
    inputSchema: { type: "object", properties: { ptr: { type: "string" } }, required: ["ptr"] },
  },
  {
    name: "echo_stats",
    description: "ECHO 服务自身的状态：缓存条数、内存、重载次数、启动时长。",
    inputSchema: { type: "object", properties: {} },
  },
];

const textResult = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });

const callTool = (name, args) => {
  C.calls++;
  if (name === "echo_search") {
    const r = search({
      terms: Array.isArray(args.terms) ? args.terms : [],
      near: !!args.near,
      since: args.since || null,
      until: args.until || null,
      limit: Number(args.limit) > 0 ? Number(args.limit) : 25,
      soul: args.soul === "always" || args.soul === "never" ? args.soul : "auto",
    });
    return textResult({
      total: r.total,
      shown: r.hits.length,
      ms: r.ms,
      soulSkipped: r.soulSkipped,
      soulReads: r.soulReads,
      note: r.soulSkipped ? `书房层未扫描（索引已命中 ${r.idxN} 条）。要全扫把 soul 设为 "always"。` : undefined,
      hits: r.hits,
    });
  }
  if (name === "echo_open") return textResult(openPtr(args.ptr));
  if (name === "echo_stats") {
    writeStats();
    const mem = process.memoryUsage();
    return textResult({
      words: C.words.length, sums: C.sums.length, mo: C.mo.length, soulFiles: C.soul.size,
      // ★ 2026-11-01 会话日志常驻的实时状态（面板读这些）
      logs: C.logs.length,
      logsState,
      logDays: LOG_DAYS,
      memBudgetMB: MEM_BUDGET_MB,
      rssMB: Math.round(process.memoryUsage().rss / 1048576),
      logsMB: Math.round(C.logs.reduce(function (a, g) { return a + g.text.length; }, 0) * 2 / 1048576 * 10) / 10,
      reloads: C.reloads, calls: C.calls,
      uptimeSec: Math.round((Date.now() - C.bootAt) / 1000),
      rssMB: Math.round(mem.rss / 1048576),
      hub: HUB, soul: SOUL,
    });
  }
  throw new Error("unknown tool: " + name);
};

const send = (msg) => { try { process.stdout.write(JSON.stringify(msg) + "\n"); } catch { /* 对端关了 */ } };

const handle = (req) => {
  const { id, method, params } = req || {};
  // 通知（无 id）不回应
  if (id === undefined || id === null) {
    return;
  }
  try {
    if (method === "initialize") {
      return send({ jsonrpc: "2.0", id, result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "echo", version: "1.0.0" },
      } });
    }
    if (method === "tools/list") {
      return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    }
    if (method === "tools/call") {
      const r = callTool(params && params.name, (params && params.arguments) || {});
      return send({ jsonrpc: "2.0", id, result: r });
    }
    if (method === "ping") {
      return send({ jsonrpc: "2.0", id, result: {} });
    }
    return send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found: " + method } });
  } catch (e) {
    return send({ jsonrpc: "2.0", id, error: { code: -32603, message: String((e && e.message) || e) } });
  }
};

// 预热（在等 stdin 之前就把索引读进来）
const boot0 = Date.now();
refresh();
startLogsLoad();   // ★ 会话日志后台预热（不阻塞握手）
process.stderr.write(`echo-mcp ready  words=${C.words.length} sums=${C.sums.length} mo=${C.mo.length}  预热 ${Date.now() - boot0}ms  rss=${Math.round(process.memoryUsage().rss / 1048576)}MB\n`);

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let req = null;
    try { req = JSON.parse(line); } catch { continue; }
    handle(req);
  }
});
// ★★★ 顺手拉起 echo-svc（2026-10-31 加）=================================
//
// 为什么是这里：
//   echo-mcp 由 dsh-mcp-hub **随 DSH 启动** spawn 一次，然后常驻 ——
//   这是现成的「DSH 生命周期锚点」。让它在同一个生命周期里把 svc 带起来，
//   CLI 的 `memq` 才拿得到快车道（pipe），不用每次手动起服务。
//
// 三条保证：
//   ① 已经在监听 pipe（比如手动起过一个 svc）→ 子进程 bind 失败自己退出，无害
//   ② stdin 一断（DSH 关）→ 父进程退出 → 显式 kill 子进程，不留孤儿
//   ③ 拉起失败绝不影响 MCP 本身 —— 整段包死，只写 stderr
//
// 判据：stderr 出现 `echo-svc 已随 echo-mcp 拉起 pid=N`，且 `memq` 单次召回 < 1 s。
let echoSvcKid = null;
try {
  const { spawn } = await import('node:child_process');
  echoSvcKid = spawn(process.execPath, [path.join(HUB, "echo-svc.mjs")], {
    detached: false,
    stdio: "ignore",
    windowsHide: true,
  });
  echoSvcKid.on("error", (e) => process.stderr.write(`echo-svc spawn 失败: ${e && e.message}\n`));
  echoSvcKid.on("exit", (code) => {
    // code 0/non-0 都只是「svc 没了」——不拖累 MCP
    process.stderr.write(`echo-svc 退出 code=${code}\n`);
  });
  process.stderr.write(`echo-svc 已随 echo-mcp 拉起 pid=${echoSvcKid.pid}\n`);
} catch (e) {
  process.stderr.write(`echo-svc spawn 异常: ${(e && e.message) || e}\n`);
}
// =========================================================================

process.stdin.on("end", () => {
  try { if (echoSvcKid && !echoSvcKid.killed) echoSvcKid.kill(); } catch {}
  process.exit(0);
});
