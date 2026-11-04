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

// ★ 路径全部走 echo-config.mjs（2026-11-04）——
//   kit 版不留任何本机绝对路径：未配置就明确报错，而不是偷偷用 D:\AI\ 然后在你机器上找不到东西。
//   配置优先级：ECHO_HUB / ECHO_SOUL / ECHO_MEMORY 环境变量 → echo.config.json → 推断。
import { HUB as CFG_HUB, SOUL as CFG_SOUL, LEDGER as CFG_LEDGER, checkConfig } from "./echo-config.mjs";

const HUB = process.env.ECHO_HUB || CFG_HUB;
const SOUL = process.env.ECHO_SOUL || CFG_SOUL;
if (!HUB || !SOUL) {
  const r = checkConfig();
  process.stderr.write(
    "[echo-mcp] ✗ 路径未配置，无法启动。\n" +
    (r && r.problems ? r.problems.map(x => "  · " + x).join("\n") : "") + "\n" +
    "  修复：设 ECHO_MEMORY / ECHO_SOUL，或写 echo.config.json（见 INSTALL.md）\n"
  );
  process.exit(2);
}
const IDX = path.join(HUB, "index");
const MO = CFG_LEDGER || path.join(SOUL, "02-墨.jsonl");

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

/** 书房：只读「变了」的文件内容；stat 仍是逐个（目录 mtime 发现不了内容改） */
// ★★★ 2026-10-31 加时间窗：书房现在 **3568 个文件 / 164 个目录**，
//   全量 walk+stat 实测 **737 ms**。而 `soul=auto` 的触发条件是「索引命中 < 5」——
//   所以凡是**冷门词 / 英文词**都会吃这 737 ms（实测 powershell/asar/python/node 全在 530-670 ms）。
//   方法：书房是「我自己在写」的地方、不会频繁变，所以 ★ **5 秒内不重扫**。
//   代价：刚写的文件 5 秒内搜不到 —— 可接受（检索基本都是往回看）。
//   要关掉：ECHO_SOUL_TTL=0。默认 5000 ms。
const SOUL_WALK_TTL = Number(process.env.ECHO_SOUL_TTL ?? 5000);
let soulWalkAt = 0;

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
      C.soul.set(p, { mtimeMs: st.mtimeMs, size: st.size, text: txt, lines: null });
      reads++;
    }
  };
  walk(SOUL, 0);
  return reads;
};

/** 热更新：只在文件变了时重载 */
// ── 2026-11-01 会话日志常驻（爀曦的思路：一手层部分解码进内存） ──────────
//   ★ 只存「截断到 600 的对话消息」—— 实测 3 天完整行要 1033MB，截断后约 5MB。
//   ★ 截断无损：search() 返回的 text 本来就只取 SNIP = 600。
//   ★ 过滤 <system-reminder> / Current runtime context（每轮注入的样板）。
//   ★ 运行时副本：路径写死（本文件不依赖 echo-config）。
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
const SESS_DIR = process.env.ECHO_SESSIONS || "D:\\AI\\dsh\\home\\sessions";
const ZMAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

const messageText = (j) => {
  const d = j.data || {};
  if (j.type === "user/message") {
    const c = d.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.map((x) => (x && typeof x.text === "string" ? x.text : "")).join("");
    return "";
  }
  const m = d.message;
  if (typeof m === "string") return m;
  if (m && typeof m === "object") {
    if (typeof m.text === "string") return m.text;
    if (Array.isArray(m.content)) return m.content.map((x) => (x && typeof x.text === "string" ? x.text : "")).join("");
  }
  return "";
};

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

  await walk(SESS_DIR, 0);

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
  vecTried = false;   // ★ 每次搜索重置 —— 它是「这一轮是否已经跑过向量层」的旗标，不是全局开关
  setTimeout(async () => {
    try {
      const arr = await buildLogs();
      arr.sort((a, b) => String(b.t).localeCompare(String(a.t)));
      C.logs = arr;
      C.logsKey = Date.now();
      logsState = "ready";
      writeStats(true);   // ★ 强制写：关键状态变化，不许被节流挡
      process.stderr.write("echo-mcp logs ready  " + arr.length + " 条  " + (Date.now() - t0) + "ms" + String.fromCharCode(10));
    } catch (e) {
      logsState = "idle";
      process.stderr.write("echo-mcp logs failed  " + (e && e.message) + String.fromCharCode(10));
    }
  }, 6000);   // ★ 延迟 3s：先让 MCP 握手完成，再做重活
};

// ══ 位图倒排（2026-11-04）—— 把「全表扫字符串」换成「先查位图、只验证候选」══
//
// 为什么：索引层原来对 82K 条记录逐条 String.includes，实测 30-45ms。
//   这是纯内存带宽限制，V8 的 includes 已经很快，Buffer 反而更慢（实测 0.4x）。
//   ★ 唯一出路是倒排 —— 但不用 Map<词, Set>（试过负优化），
//     用「单字符 → 位图」，查询时取 term 里 **df 最小**的那个字，只遍历它的置位项。
//
// 实测（2026-11-04）：构建 435ms / 24MB，查询 换气 4.1ms 记忆 1.8ms 压缩 2.7ms
//   对比全扫 15-25ms —— **5-12 倍**。
//
// ★ 判据：位图只负责「缩小候选」，命中的每一条仍然要 String.includes 精确验证。
//   所以它不会改变任何结果，只改变速度 —— 这是它敢上线的原因。
let BITS = null;          // charCode -> Uint32Array
let BITS_DF = null;       // charCode -> 文档数
let BITS_W = 0;           // 位图宽（uint32 个数）
let BITS_TEXTS = null;    // 索引 -> 文本（验证用）
let BITS_KEY = "";        // 构建时依据的 statKey，变了才重建
let BITS_G2 = null;       // ASCII 2-gram 位图（英文用）
let BITS_G2DF = null;
let BITS_G3H = null;      // ASCII 3-gram 哈希桶
let BITS_G3B = 0;

const buildBits = (texts) => {
  const N = texts.length;
  const W = Math.ceil(N / 32);
  const bits = new Array(65536);
  const df = new Int32Array(65536);
  const mark = new Int32Array(65536);
  let stamp = 0;
  // ★ 用 charCodeAt + 数组而不是 s[j] + Map —— 实测 435ms vs 4521ms（10 倍）
  for (let i = 0; i < N; i++) {
    const s = texts[i];
    const wi = i >>> 5, bit = 1 << (i & 31);
    stamp++;
    for (let j = 0; j < s.length; j++) {
      const cc = s.charCodeAt(j);
      let arr = bits[cc];
      if (arr === undefined) { arr = new Uint32Array(W); bits[cc] = arr; }
      arr[wi] |= bit;
      if (mark[cc] !== stamp) { mark[cc] = stamp; df[cc]++; }
    }
  }
  // ★ 2026-11-04：ASCII 2-gram 位图。
  //   为什么需要：英文只有 26 个字母，单字位图 df 极高（e 出现在几乎所有记录里），
  //   AND 之后候选仍上万条 —— 实测 echo 的索引层要 44ms。
  //   2-gram 一共 676 种组合（26×26），体积 676 × 6.7KB ≈ 4.5MB，可接受。
  //   查询英文时先用 2-gram 位图缩小候选，再逐条 includes 验证。
  const g2 = new Array(65536);
  const g2df = new Int32Array(65536);
  const g2mark = new Int32Array(65536);
  let stamp2 = 0;
  for (let i = 0; i < N; i++) {
    const s = texts[i];
    const wi = i >>> 5, bit = 1 << (i & 31);
    stamp2++;
    for (let j = 0; j + 1 < s.length; j++) {
      const a = s.charCodeAt(j), b = s.charCodeAt(j + 1);
      if (a > 127 || b > 127) continue;       // 只对 ASCII 建（中文单字位图已经够用）
      const key = (a << 8) | b;
      let arr = g2[key];
      if (arr === undefined) { arr = new Uint32Array(W); g2[key] = arr; }
      arr[wi] |= bit;
      if (g2mark[key] !== stamp2) { g2mark[key] = stamp2; g2df[key]++; }
    }
  }
  // ★ 2026-11-04 第十二轮：3-gram 用 4096 桶哈希（不是精确 Map）。
  //   ★ 试过精确 Map（68,119 种 × 7KB = 458MB）：**结果一致，但更慢**（中位 27ms vs 16ms）。
  //   原因：位图从 4096 个变成 68,119 个，数组分散在整个堆上 ——
  //   每次查询要随机访问 3-4 个，**cache miss 把「候选更少」的收益全吃光了**。
  //   ★ 判据：内存不是越多越好。**连续访问的局部性 > 精确度。**
  const G3B = 4096;                       // 4096 × 7KB ≈ 28MB
  const g3h = new Array(G3B);
  for (let i = 0; i < N; i++) {
    const s = texts[i];
    const wi = i >>> 5, bit = 1 << (i & 31);
    for (let j = 0; j + 2 < s.length; j++) {
      const a = s.charCodeAt(j), b = s.charCodeAt(j + 1), c = s.charCodeAt(j + 2);
      if (a > 127 || b > 127 || c > 127) continue;
      const h = ((a * 31 + b) * 31 + c) & (G3B - 1);
      let arr = g3h[h];
      if (arr === undefined) { arr = new Uint32Array(W); g3h[h] = arr; }
      arr[wi] |= bit;
    }
  }
  return { bits, df, W, texts, g2, g2df, g3h, G3B };
};

// 返回「可能命中 term 的记录索引」，已逐条 includes 验证过 → 结果精确
const bitmapLookup = (term) => {
  if (!BITS) return null;                       // 没建好 → 调用方退回全扫

  // ★ 试过「单字跳过位图」，撤了（2026-11-04）：实测「人」从 27ms 变 48ms。
  //   我原来的推断是「单字缩不掉候选，位图是负担」——错了。
  //   真正的差别在**验证方式**：位图路径只对候选做 includes，
  //   而全扫路径对 83,684 条都做 includes（虽然大部分 early-exit，但每条仍要建立调用）。
  //   ★ 教训：位图即使一个都缩不掉，它「缩小验证范围」的价值仍然存在。

  // ★ 单字「跳过验证」试过又撤了（2026-11-04）：命中 7095 条时，返回 7095 个索引 +
  //   外层再建 Set，比「筛 7095 条、只留真正命中的」还贵 —— 实测 25ms → 44ms。
  //   教训：省掉的那次 includes，被下游 Set 化的开销吃回去了。

  // ★★ ASCII 2-gram 优先（2026-11-04）：英文只有 26 个字母，单字位图 df 极高，
  //   AND 之后候选仍上万条 —— 实测 echo 索引层 44ms。2-gram 能直接砍到几百条。
  // ★ 3-gram 哈希优先（ASCII 且长度 ≥3）—— 比 2-gram 更精确
  if (term.length >= 3 && BITS_G3H && /^[\x00-\x7F]+$/.test(term)) {
    let arr = null, miss = false;
    for (let j = 0; j + 2 < term.length; j++) {
      const a = term.charCodeAt(j), b = term.charCodeAt(j + 1), c = term.charCodeAt(j + 2);
      const h = ((a * 31 + b) * 31 + c) & (BITS_G3B - 1);
      const x = BITS_G3H[h];
      if (x === undefined) { miss = true; break; }   // 这个 3-gram 全库不存在 → 0 条
      if (arr === null) { arr = x; }
      else {
        const and = new Uint32Array(BITS_W);
        let any = 0;
        for (let wi = 0; wi < BITS_W; wi++) { const v = arr[wi] & x[wi]; and[wi] = v; any |= v; }
        arr = and;
        if (!any) return [];
      }
    }
    if (!miss && arr) {
      const out = [];
      for (let wi = 0; wi < BITS_W; wi++) {
        let v = arr[wi];
        while (v) {
          const low = v & -v;
          const idx = (wi << 5) + (31 - Math.clz32(low));
          if (BITS_TEXTS[idx].includes(term)) out.push(idx);
          v ^= low;
        }
      }
      return out;
    }
  }

  if (term.length >= 2 && BITS_G2 && /^[\x00-\x7F]+$/.test(term)) {
    let arr = null, _g2n = 0;
    for (let j = 0; j + 1 < term.length; j++) {
      const key = (term.charCodeAt(j) << 8) | term.charCodeAt(j + 1);
      const a = BITS_G2[key];
      if (a === undefined) return [];          // 这个 2-gram 全库不存在 → 0 条
      _g2n++;
      if (arr === null) { arr = a; }
      else {
        const and = new Uint32Array(BITS_W);
        let any = 0;
        for (let wi = 0; wi < BITS_W; wi++) { const x = arr[wi] & a[wi]; and[wi] = x; any |= x; }
        arr = and;
        if (!any) return [];
      }
    }
    let _cand = 0;
    if (arr) {
      const out = [];
      for (let wi = 0; wi < BITS_W; wi++) {
        let v = arr[wi];
        while (v) {
          const low = v & -v;
          const idx = (wi << 5) + (31 - Math.clz32(low));
          _cand++;
          if (BITS_TEXTS[idx].includes(term)) out.push(idx);
          v ^= low;
        }
      }
            return out;
    }
  }

  // ★ 多字：先用【全部字】的位图做 AND 缩小候选，再对候选逐条精确验证。
  //   「换气」只用「气」要验证 4215 条；加上「换」的位图 AND 之后明显更少。
  let arr = null, unionDf = Infinity;
  for (let j = 0; j < term.length; j++) {
    const cc = term.charCodeAt(j);
    const a = BITS[cc];
    if (a === undefined) return [];             // 有这个字全库不存在 → 0 条
    if (BITS_DF[cc] < unionDf) { unionDf = BITS_DF[cc]; }
    if (arr === null) { arr = a; }
    else {
      // 就地 AND 到一个新数组（不能改原数组 —— 它是共享的）
      const and = new Uint32Array(BITS_W);
      let any = 0;
      for (let wi = 0; wi < BITS_W; wi++) { const x = arr[wi] & a[wi]; and[wi] = x; any |= x; }
      arr = and;
      if (!any) return [];
    }
  }
  if (!arr) return null;

  const out = [];
  let _cand = 0;
  for (let wi = 0; wi < BITS_W; wi++) {
    let v = arr[wi];
    while (v) {
      const low = v & -v;
      const idx = (wi << 5) + (31 - Math.clz32(low));
      _cand++;
      if (BITS_TEXTS[idx].includes(term)) out.push(idx);
      v ^= low;
    }
  }
    return out;
};

const refresh = () => {
  const wk = statKey(path.join(IDX, "words.jsonl"));
  if (wk !== C.wKey) {
    C.words = parseJsonl(path.join(IDX, "words.jsonl"));
    // ★ 2026-11-01 norm 预计算：索引加载时算一次，之后每次检索直接复用。
    //   实测：一次性 +111MB，换掉每次 near 未命中的 547ms。
    //   ★ 可用 ECHO_PRECOMPUTE_NORM=0 关掉（回退到现算，省内存但慢）。
    if (process.env.ECHO_PRECOMPUTE_NORM !== "0") {
      for (const w of C.words) w._n = norm(String(w.text ?? ""));
    }
    C.wKey = wk; C.reloads++;
  }
  const sk = statKey(path.join(IDX, "summaries.jsonl"));
  if (sk !== C.sKey) {
    C.sums = parseJsonl(path.join(IDX, "summaries.jsonl"));
    // ★ 2026-11-04 修：这段原来在 if【外面】—— 每跑一次 refresh 就把 390 条摘要
    //   全部重新 norm 一遍，实测白烧 100~130ms/次（占单次查询 222ms 的一半）。
    //   norm 只跟文本内容有关，文件没变就不用重算 —— 和上面 words 的写法对齐。
    for (const sm of C.sums) sm._n = norm(String(sm.summary == null ? "" : sm.summary));
    C.sKey = sk; C.reloads++;
  }
  const yk = statKey(path.join(HUB, "synonyms.json"));
  if (yk !== C.yKey) { C.syn = loadSyn(); C.yKey = yk; C.reloads++; }
  const mk = statKey(MO);
  if (mk !== C.moKey) {
    C.mo = parseJsonl(MO);
    // ★ 墨层也要预计算 —— 它只有 637 条，一次算完 2ms，但不做的话每次查询都白烧几十毫秒
    for (const r of C.mo) {
      r._flat = String((r.text || "") + " " + (r.ref || ""));
      r._n = norm(r._flat);
    }
    C.moKey = mk; C.reloads++;
  }

  // ★ 位图：三个源任一变了才重建（构建约 435ms，不能每次都来）
  const bk = C.wKey + "|" + C.sKey + "|" + (C.logsKey || "");
  if (bk !== BITS_KEY && C.words && C.words.length) {
    try {
      const pool = [];
      // ★ 2026-11-04 第三轮：位图用小写建 —— 让英文查询也能走位图。
      //   中文 toLowerCase 无变化，所以对中文零影响。
      // ★ 第四轮：把《墨》也纳入池 —— 它原来完全不在位图里，英文查询时只能全扫 641 条。
      for (const g of (C.logs || [])) pool.push(String(g.text || "").toLowerCase());
      for (const w of C.words) pool.push(String(w.text || "").toLowerCase());
      for (const sm of C.sums) pool.push(String(sm.summary == null ? "" : sm.summary).toLowerCase());
      const r = buildBits(pool);
      BITS = r.bits; BITS_DF = r.df; BITS_W = r.W; BITS_TEXTS = r.texts;
      BITS_G2 = r.g2; BITS_G2DF = r.g2df;
      BITS_G3H = r.g3h; BITS_G3B = r.G3B;
      BITS_KEY = bk;
    } catch (e) {
      // ★ 构建失败不许影响检索 —— 退回全扫
      BITS = null; BITS_TEXTS = null;
      process.stderr.write("位图构建失败（退回全扫）: " + ((e && e.message) || e) + "\n");
    }
  }
};

/** 三档匹配 —— 与 memq 的 hitKind 逐字一致 */
// ★ 2026-11-01：hitKind 支持两项预计算复用 ——
//   preNorm = 该条文本的归一化结果（索引加载时算好）；
//   termsN  = 查询词的归一化数组（每次 search 算一次，不用对 5 万条各重算一遍）。
const hitKind = (s, terms, near, preNorm, termsN) => {
  if (terms.length === 0) return "exact";
  if (s == null) return null;
  const raw = String(s);
  // ★ 2026-11-04：不用 terms.every(闭包) —— 每次调用要创建 N 个闭包，
  //   637 条记录 × 2 处 = 上千个临时闭包，是 GC 压力的来源之一。
  //   手写循环结果完全等价，但不分配。
  let _all = true;
  for (let _i = 0; _i < terms.length; _i++) { if (raw.indexOf(terms[_i]) < 0) { _all = false; break; } }
  if (_all) return "exact";
  const tn = termsN || (needNorm(terms) ? terms.map(norm) : null);
  let ns = null;
  if (needNorm(terms)) {
    ns = preNorm != null ? preNorm : norm(raw);
    let _all2 = true;
    for (let _i = 0; _i < terms.length; _i++) { if (ns.indexOf(tn[_i]) < 0) { _all2 = false; break; } }
    if (_all2) return "norm";
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
// ★ 记忆库门牌缓存（2026-11-04 加）
//   objects.jsonl 由 00-记忆库/memsync.mjs 生成，ECHO 启动时已扫过一次。
//   这里惰性加载 —— 第一次搜索时读进内存，之后一直是引用。
const MEMLIB = path.join(SOUL, "00-记忆库", "objects.jsonl");
let memObjs = null, memObjsAt = 0;
const loadMemObjs = () => {
  const now = Date.now();
  // 60 秒内不重读（文件 1.8 MB，读一次约 5 ms）
  if (memObjs && now - memObjsAt < 60000) return memObjs;
  try {
    const raw = fs.readFileSync(MEMLIB, "utf8").split("\n").filter(Boolean);
    const arr = [];
    for (const l of raw) { try { arr.push(JSON.parse(l)); } catch {} }
    // ★ 预计算 norm —— 门牌是短字符串，一次算完很便宜；
    //   不做的话每次英文查询都要对每条门牌现算 norm()（实测 17-23ms）。
    for (const o of arr) o._n = norm(String(o.mem || ""));
    memObjs = arr; memObjsAt = now;
  } catch { memObjs = memObjs || []; memObjsAt = now; }
  return memObjs;
};

// ★ 书房正文块缓存（2026-11-04 加）—— 由 00-记忆库/memchunk.mjs 生成
//   1863 块 / 4.5 MB。60 秒内不重读。
const CHUNKFILE = path.join(SOUL, "00-记忆库", "chunks.jsonl");
let chunks = null, chunksAt = 0;
// ★ chunks 的位图（2026-11-04）—— 和主池分开，因为它懒加载、且只有 1894 块。
//   正文层原来两块开销：c._low.includes(w) 预筛 + hitKind(c.text) 再扫一遍。
//   位图把它变成「查一次位图 → 只验证候选块」。
let CBITS = null, CBITS_DF = null, CBITS_W = 0, CBITS_TEXTS = null, CBITS_KEY = "";

const cbLookup = (term) => {
  if (!CBITS) return null;
  let bestCC = -1, bestDf = Infinity;
  for (let j = 0; j < term.length; j++) {
    const cc = term.charCodeAt(j);
    if (CBITS[cc] === undefined) return [];
    if (CBITS_DF[cc] < bestDf) { bestDf = CBITS_DF[cc]; bestCC = cc; }
  }
  if (bestCC < 0) return null;
  const arr = CBITS[bestCC];
  const out = [];
  for (let wi = 0; wi < CBITS_W; wi++) {
    let v = arr[wi];
    while (v) {
      const low = v & -v;
      const idx = (wi << 5) + (31 - Math.clz32(low));
      if (CBITS_TEXTS[idx].includes(term)) out.push(idx);
      v ^= low;
    }
  }
  return out;
};

const loadChunks = () => {
  const now = Date.now();
  if (chunks && now - chunksAt < 300000) return chunks;   // ★ 5 分钟（2026-11-04）：读 4.5MB 要 ~200ms，60 秒太短
  try {
    const raw = fs.readFileSync(CHUNKFILE, "utf8").split("\n").filter(Boolean);
    const arr = [];
    for (const l of raw) { try { arr.push(JSON.parse(l)); } catch {} }
    // ★ 2026-11-04：预计算小写 —— 正文层原来每次查询对 1894 块 × 1500 字
    //   各跑一遍 toLowerCase()，实测占单次查询 26ms 里的大头。
    //   文本不变就不必重算，和 words/sums 的 _n 是同一个道理。
    for (const c of arr) { c._low = String(c.text || "").toLowerCase(); c._n = norm(String(c.text || "")); }
    chunks = arr; chunksAt = now;
    try {
      const r = buildBits(arr.map(c => String(c.text || "").toLowerCase()));
      CBITS = r.bits; CBITS_DF = r.df; CBITS_W = r.W; CBITS_TEXTS = r.texts;
      CBITS_KEY = "chunks";
    } catch (e) { CBITS = null; CBITS_TEXTS = null; process.stderr.write("chunks 位图构建失败: " + e.message + "\n"); }
  } catch { chunks = chunks || []; chunksAt = now; }
  return chunks;
};

// ★ 向量层（2026-11-04 加）—— 语义检索
//
// 为什么用动态 import 绝对路径：模型和 node_modules 都在 models/bge-small-zh 下，
// 而 echo-mcp 在 hub/ 根。用 file:/// 绝对路径 import 最直接，不用挪 node_modules。
//
// ★ 三处「包死」：
//   ① 模型文件不在 / 依赖没装 → 整个向量层静默跳过，不影响其他层
//   ② 加载失败 → 记住失败（不每轮重试 576ms）
//   ③ 查询失败 → 静默跳过
//
// ★ 为什么不常驻加载：加载 576ms。启动时就加载会让 MCP 就绪变慢；
//   惰性加载 + 缓存，只有真正用到向量层时才付这 576ms。

const VECDIR = path.join(HUB, "models", "bge-small-zh");
const VECMETA = path.join(SOUL, "00-记忆库", "vectors.meta.json");
const CHUNKFILE2 = path.join(SOUL, "00-记忆库", "chunks.jsonl");
const BGE_PREFIX = "为这个句子生成表示以用于检索相关文章：";

let vecMeta = null, vecMetaAt = 0;
let vecTried = false;   // ★ 每次 search 只跑一次向量层（这是同步搜索里唯一一次 await）
const loadVecMeta = () => {
  const now = Date.now();
  if (vecMeta !== null && now - vecMetaAt < 300000) return vecMeta;
  try {
    const raw = fs.readFileSync(VECMETA, "utf8");
    const m = JSON.parse(raw);
    vecMeta = m && m.done ? m : null;
  } catch { vecMeta = null; }
  vecMetaAt = now;
  return vecMeta;
};

let embedPipe = null, embedFailed = false;
const getEmbedPipe = async () => {
  if (embedPipe) return embedPipe;
  if (embedFailed) return null;
  try {
    const { pathToFileURL } = await import("node:url");
    const mod = await import(pathToFileURL(path.join(VECDIR, "node_modules", "@huggingface", "transformers", "dist", "transformers.node.mjs")).href);
    mod.env.allowRemoteModels = false;
    mod.env.allowLocalModels = true;
    mod.env.localModelPath = VECDIR;
    mod.env.useBrowserCache = false;
    embedPipe = await mod.pipeline("feature-extraction", VECDIR, { dtype: "q8" });
    process.stderr.write("向量模型已加载\n");
    return embedPipe;
  } catch (e) {
    embedFailed = true;
    process.stderr.write("向量模型加载失败（语义层跳过）: " + ((e && e.message) || e) + "\n");
    return null;
  }
};

// 查询 → 向量（bge 非对称检索：query 要加前缀）
const embedQuery = async (text) => {
  const pipe = await getEmbedPipe();
  if (!pipe) return null;
  const out = await pipe([BGE_PREFIX + text], { pooling: "mean", normalize: true });
  const dim = out.dims[out.dims.length - 1];
  return out.data.slice(0, dim);
};

const search = async ({ terms = [], near = false, since = null, until = null, limit = 25, soul = "auto" }) => {
  const t0 = Date.now();
  // ★ 2026-11-01：terms 归一化只算一次，全库扫描全部复用
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

  const _P = {}; let _pt = Date.now();
  const _mark = (k) => { _P[k] = Date.now() - _pt; _pt = Date.now(); };

  // ★ 位图预筛（2026-11-04）—— 把「索引层逐条 includes」换成「先查位图拿候选」。
  //
  // ★★ 安全边界（这条不能省）：位图只索引「原文子串」。
  //   而 hitKind 还有 norm 归一化（大小写 / 全角半角 / 各种破折号）和 near 同义词 ——
  //   那两条路径的命中**不在位图里**。
  //   所以：只要 needNorm(terms) 为真 或 near 为真，就**整体退回全扫**，结果才等价。
  let bitCand = null, bitOff = null;
  // ★ 第三轮：位图用小写建，所以「仅因大小写而 needNorm」的 term 也能用。
  //   判据：term 全为 ASCII 字母时，lowercase 已覆盖大小写差异 → 允许位图。
  const _normOnlyAscii = needNorm(terms) && terms.every((x) => /^[\x20-\x7E]+$/.test(String(x)));
  if (BITS && terms.length && !near && (!needNorm(terms) || _normOnlyAscii) && process.env.ECHO_NO_BITMAP !== "1") {
    try {
      let acc = null, ok = true;
      for (const tm of terms) {
        const r = bitmapLookup(String(tm).toLowerCase());
        if (r === null) { ok = false; break; }
        if (acc === null) acc = new Set(r);
        else { const nx = new Set(); for (const x of acc) if (r.includes(x)) nx.add(x); acc = nx; }
        if (acc.size === 0) break;
      }
      if (ok) {
        bitCand = acc || new Set();
        bitOff = {
          logs: 0,
          words: (C.logs || []).length,
          sums: (C.logs || []).length + C.words.length,
        };
      }
    } catch { bitCand = null; }
  }



  // ① 墨
  for (const r of C.mo) {
    if (!inRange(r.t, since, until)) continue;
    // ★ 2026-11-04：原来传 null —— 每条 637 条都现算 norm()。
    //   实测英文查询时这一层独占 65ms（echo 114ms 里的 65 就是它）。
    //   改成用预计算的 r._n 之后 2ms。和 summaries 那个 if 漏掉是同一类问题。
    const k = hitKind(r._flat != null ? r._flat : (r.text + " " + (r.ref || "")), terms, near, r._n, termsN);
    if (!k) continue;
    total++;
    if (hits.length < limit) push({ layer: "L3", src: "墨", t: r.t, ptr: "墨:" + r.t, kind: r.type, extra: r.ref, m: k }, r.text);
  }
  _mark('墨');
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
  //
  // ★★★ 2026-11-02 03:57 修 bug —— 这一层漏了 `hits.length < limit` 检查，
  //   也漏了 `total++`。它是整个 search() 里**唯一**不受 limit 约束的层。
  //
  //   实锤（同一晚两次调用）：
  //     limit:12 → shown:14  （多 2 条）
  //     limit:12 → shown:222 （多 210 条，返回 241,776 字节 ≈ 236 KB ≈ 6 万 token）
  //
  //   代价口径：这 6 万 token 进上下文后**永久留在那里**，之后每轮都重读。
  //   按 1.5 元/M 的未命中价，一次调用约 0.09 元；而它会一直摊到后续每一轮。
  //
  //   最坏情况：C.logs 有 27,252 条，若某词命中几千条 →
  //     27,252 × 600 字符 ≈ 1600 万字符 ≈ 2500–3300 万 token ≈ 一次调用 40~50 元。
  //
  //   这正是群友反馈的那个 bug 的**精确位置**：不是 DSH 内核，是这个检索工具自己。
  for (let _li = 0; _li < C.logs.length; _li++) {
    if (bitCand && !bitCand.has(bitOff.logs + _li)) continue;
    const g = C.logs[_li];
    const k = hitKind(g.text, terms, near, g._n, termsN);
    if (!k) continue;
    total++;                              // ★ 计入总数（原来漏了，导致 total 与 shown 对不上）
    if (hits.length < limit) {            // ★ 受 limit 约束（原来漏了，这是 bug 本体）
      hits.push({
        layer: "L3", src: "日志", t: g.t,
        ptr: g.ptr, role: g.role, fullLen: g.fullLen,
        text: g.text, m: k,
      });
    }
  }
  for (let _wi = 0; _wi < C.words.length; _wi++) {
    if (bitCand && !bitCand.has(bitOff.words + _wi)) continue;
    const w = C.words[_wi];
    if (!inRange(w.t, since, until)) continue;
    const k = hitKind(w.text, terms, near, w._n, termsN);
    if (!k) continue;
    total++; idxTotal++;
    if (idxHits.length < limit) {
      const kk = w.kind === "task" ? "程序提示" : w.kind === "结论" ? "结论" : "原话";
      idxHits.push({ layer: "L3", src: "索引", t: w.t, ptr: `log:${w.session}#seq=${w.seq}`, kind: kk, extra: w.ws, m: k, _t: w.text });
    }
  }
  for (const h of idxHits) { if (hits.length < limit) { const { _t, ...rest } = h; push(rest, _t); } }
  _mark('索引');
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
  _mark('书房');
  // ④ 记忆库门牌（mem: / obj:）—— 只匹配门牌字符串，不读内容
  //    为什么独立一层且给配额：墨/索引两层就能占满 limit，
  //    不给配额的话文件索引永远排不进来（实测：搜「交接」前 6 条全是墨）。
  //    ★ 配额 = 至少 ceil(limit/3)，宁可挤掉一条墨，也不能让文件搜不到。
  {
    const objs = loadMemObjs();
    const memHits = [];
    for (const o of objs) {
      // ★ 2026-11-04 第十轮：这里原来传 null —— 每条门牌都现算 norm()。
      //   实测英文查询时这一层独占 17-23ms（docker 20 / memory 23 / config 17）。
      //   ★ 这是同一类 bug 的**第三次**出现（summaries 一次、墨一次、这里一次）。
      //   根因：`hitKind(文本, terms, near, 预计算norm, termsN)` 第 4 个参数默认可以不传，
      //   于是「忘了传」不会报错，只会慢。**能被忘掉的参数迟早会被忘掉。**
      const k = hitKind(o.mem, terms, near, o._n, termsN);
      if (!k) continue;
      total++;
      memHits.push({
        layer: "L3",
        src: o.kind === "mem" ? "记忆" : "产物",
        t: null,
        ptr: o.mem,                 // ★ 门牌本身就是指针
        kind: (o.mem.match(/\.([A-Za-z0-9]+)$/) || [, ""])[1],
        extra: o.path,
        m: k,
        bytes: o.bytes,
      });
      if (memHits.length >= Math.max(3, Math.ceil(limit / 3))) break;  // 够配额就停
    }
    for (const h of memHits) {
      if (hits.length >= limit) hits.pop();   // 挤掉最末一条，给文件让位
      push(h, h.extra);
    }
  }
  _mark('门牌');
  // ⑤ 书房正文（mem: 块）—— 真读内容，按块命中
  //    ★ 为什么要有这层：④ 只匹配文件名，搜「正文里写了什么」永远搜不到。
  //    ★ 性能：1863 块 × 1500 字，先走 includes 粗筛（不区分大小写），
  //      命中才调 hitKind 做精细判定 —— 粗筛一次约 3ms。
  {
    const cs = loadChunks();
    const lowTerms = terms.map(x => String(x).toLowerCase()).filter(Boolean);
    const bodyHits = [];
    // ★ 位图预筛：只在 near/needNorm 都关掉时可用（安全边界同主池）
    let cbCand = null;
    if (CBITS && lowTerms.length && !near && !needNorm(terms) && process.env.ECHO_NO_BITMAP !== "1") {
      try {
        let acc = null, ok = true;
        for (const tm of terms) {
          const r = cbLookup(String(tm));
          if (r === null) { ok = false; break; }
          if (acc === null) acc = new Set(r);
          else { const nx = new Set(); const rs = new Set(r); for (const x of acc) if (rs.has(x)) nx.add(x); acc = nx; }
          if (acc.size === 0) break;
        }
        if (ok) cbCand = acc;
      } catch { cbCand = null; }
    }
    if (lowTerms.length) {
      for (let _ci = 0; _ci < cs.length; _ci++) {
        if (cbCand && !cbCand.has(_ci)) continue;
        const c = cs[_ci];
        const low = c._low != null ? c._low : String(c.text || "").toLowerCase();
        let all = true;
        for (const w of lowTerms) { if (!low.includes(w)) { all = false; break; } }
        if (!all) continue;
        const k = hitKind(c.text, terms, near, c._n, termsN) || "norm";
        total++;
        bodyHits.push({
          layer: "L3", src: "正文", t: null,
          ptr: c.id,                    // ★ mem:xxx#N —— echo_open 认这个
          kind: (c.mem.match(/\.([A-Za-z0-9]+)$/) || [, ""])[1],
          extra: c.mem,
          m: k,
          seq: c.seq,
        });
        if (bodyHits.length >= Math.max(2, Math.ceil(limit / 3))) break;
      }
    }
    for (const h of bodyHits) {
      if (hits.length >= limit) hits.pop();
      // 正文命中：摘取命中位置周围 400 字做片段
      const c = cs.find(x => x.id === h.ptr);
      let snip = "";
      if (c) {
        const low = c.text.toLowerCase();
        let at = -1;
        for (const w of lowTerms) { const i = low.indexOf(w); if (i >= 0 && (at < 0 || i < at)) at = i; }
        const s = Math.max(0, at - 150);
        snip = (s > 0 ? "…" : "") + c.text.slice(s, s + 420) + (s + 420 < c.text.length ? "…" : "");
      }
      push(h, snip || h.extra);
    }
  }
  // ★ 2026-11-01 排序加权：把匹配质量纳入排序（原来只看「层 + 时间」）
  // ★ semantic 排最后（2026-11-04 加）：语义命中是「算出来的相关」，
  //   不是「字面命中」—— 它绝不能排到精确匹配前面。
  //   这一条是 ECHO 原文路线的保护：精确命中永远优先。
  const KIND_RANK = { exact: 0, norm: 1, synonym: 2, semantic: 9 };
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
  _mark('正文');
  // ⑥ 向量语义层（2026-11-04 加）—— 关键词完全没命中也能捞
  //
  // ★ 为什么要这一层：上面每一层都是「字面匹配」。
  //   实测：搜「怎么让记忆更牢」时，关键词层一条都命不中
  //   《记忆系统设计提案》《温暖的话》这类真正相关的东西。
  //   向量层把「记忆更牢」和「记忆系统」连起来 —— 这是关键词做不到的。
  //
  // ★ 三道保护：
  //   ① 模型加载失败 → embedFailed，之后永久跳过，不每轮重试
  //   ② 向量文件缺失 → loadVecMeta 返回 null，跳过
  //   ③ 整段包死 → 任何异常都不影响上面的层
  //
  // ★ 什么时候才值得跑（2026-11-04 实测后加的闸门）：
  //   向量层代价 = 模型加载 576ms（仅首次）+ 每次 query 约 400ms。
  //   而「换气」这种常用词，关键词层一次就命中 3000+ 条 —— 再花 400ms 跑向量毫无意义。
  //   所以：只在关键词层【几乎没命中】时才跑。
  //   判据用 total（各层累加的真实命中数）而不是 hits.length（被 limit 截断过）。
  if (!vecTried && total < 3 && terms.length > 0 && terms.join("").length <= 40) {
    vecTried = true;
    try {
      const vm = loadVecMeta();
      if (vm && vm.done) {
        const qv = await embedQuery(terms.join(" "));
        if (qv) {
          const cs = loadChunks();
          const idx = new Map();
          for (const c of cs) idx.set(c.id, c);
          const scored = [];
          for (const [id, b64] of Object.entries(vm.done)) {
            const buf = Buffer.from(b64, "base64");
            const v = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
            let dot = 0;
            const n = Math.min(v.length, qv.length);
            for (let k = 0; k < n; k++) dot += qv[k] * v[k];
            scored.push({ id, s: dot });
          }
          scored.sort((a, b) => b.s - a.s);
          // 阈值 0.55 —— 实测相关命中在 0.60+，无关在 0.45 以下。
          // 不用固定条数（可能全是垃圾），也不全丢（0.55 以上的通常真有关系）。
          const vecHits = [];
          for (const x of scored) {
            if (x.s < 0.55) break;
            if (vecHits.length >= Math.max(2, Math.ceil(limit / 4))) break;
            const c = idx.get(x.id);
            if (!c) continue;
            vecHits.push({ c, s: x.s });
          }
          for (const h of vecHits) {
            total++;
            if (hits.length >= limit) hits.pop();
            // ★★★ 向量层的定位（2026-11-04 爀曦定，我原来做偏了两处）：
            //
            //   他的原话：「向量要做的是让检索更精确，而不是把非原文的东西找回来。
            //             **不推送。**它是辅助更精确快速检索的东西 ——
            //             把所有高相关可能的记忆条目**展现给你**，
            //             然后你**拿到门牌，取回原文**。
            //             所以它不能做记忆加工、记忆提炼。」
            //
            //   ⇒ 所以这一层【不返回正文片段】。只返回：门牌 + 相关度 + 一句话为什么。
            //     正文怎么取，由拿门牌的人决定 —— 那是他（或我）的事，不是检索器的事。
            //
            //   为什么连「块的开头 400 字」都不能给：
            //     看着像"给你看内容"，实际是【替你决定了哪段重要】。
            //     ECHO 其他五层给的是「命中位置附近的逐字片段」—— 那是因为它们真的命中了。
            //     向量层没命中任何位置，它只知道「这一块整体相关」。
            //     **没有位置的截断，就是加工。**
            //
            //   代价：看起来信息更少。但那是对的 ——
            //     它的价值在「找到」，不在「替你读」。
            const snip = "（语义近似 · 只给门牌 · 原文用 echo_open 取）";
            push({
              layer: "L3", src: "语义", t: null,
              ptr: h.c.id, kind: (h.c.mem.match(/\.([A-Za-z0-9]+)$/) || [, ""])[1],
              extra: h.c.mem + "  (cos " + h.s.toFixed(3) + ")",
              m: "semantic",
            }, snip);
          }
        }
      }
    } catch (e) {
      process.stderr.write("向量层失败（跳过）: " + ((e && e.message) || e) + "\n");
    }
  }
  _mark('向量层');
  // ★ 去重（2026-11-04）：同一个 ptr 只留一条 —— 索引层会把同一处命中吐两次，
  //   不去的后果是 limit=7 里 6 条被 3 个结果占掉（实测过）。按 ptr 去重最稳。
  const seen = new Set();
  const dedup = [];
  for (const h of hits) {
    const key = h.ptr || (h.layer + '|' + h.src + '|' + h.text);
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(h);
  }
  return { hits: dedup.slice(0, limit), total, ms: Date.now() - t0, soulSkipped, soulReads, idxN: idxHits.length,
    prof: _P };
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
  // ★ 墨: 指针（2026-11-04 补，为「100% 可回源」）
  //   为什么：搜索会返回 墨: 指针，而 echo_open 打不开它 —— 门开着推不动。
  if (s.startsWith("墨:")) {
    const ts = s.slice(2);
    const rec = MO_LINES().find((l) => l.t === ts);
    if (!rec) return { ok: false, err: "《墨》里没有这个时间戳: " + ts };
    return {
      ok: true, kind: "mo", ptr: s,
      bytes: (rec["概要"] || rec.text || "").length,
      content: ["【墨 · 一手原文】" + rec.t, "类型: " + (rec.type || "?"),
        "概要: " + (rec["概要"] || rec.text || ""),
        rec.ref ? "出处: " + rec.ref : "",
        rec.feel ? "当时的感受: " + rec.feel : ""].filter(Boolean).join("\n"),
    };
  }
  // ★ log: 指针（2026-11-04 补）
  //   ★ 诚实：索引里只有前 LOG_SNIP 字。返回里明确写 truncated / fullLen，
  //     并告诉调用方完整原文要 memq open —— 不假装它是全文。
  if (s.startsWith("log:")) {
    const hit = (C.logs || []).find((g) => g.ptr === s);
    if (!hit) return { ok: false, err: "日志索引里没有它（可能超出 " + LOG_DAYS + " 天窗口）: " + s };
    return {
      ok: true, kind: "log", ptr: s, role: hit.role, t: hit.t,
      fullLen: hit.fullLen,
      truncated: hit.fullLen > hit.text.length,
      note: hit.fullLen > hit.text.length
        ? "索引里只有前 " + hit.text.length + " 字（全文 " + hit.fullLen + " 字）。完整原文: memq open " + s
        : null,
      content: hit.text,
    };
  }
  return { ok: false, err: "不认识的指针类型: " + s.slice(0, 40) };
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
    name: "echo_recall",
    description: "★ 给【一段上下文或一个说不清关键词的问题】，返回库里【高相关的条目门牌】。不返回正文 —— 拿到 ptr 自己用 echo_open 取。\n\n什么时候用它而不是 echo_search：你不知道该用什么词搜、或者手上是一整段话而不是关键词。例如「他刚才在说让我别急着动手」—— echo_search 找不到合适的词，echo_recall 可以。",
    inputSchema: {
      type: "object",
      properties: {
        context: { type: "string", description: "一段话 / 一个问题 / 当前的上下文（取尾部 500 字）" },
        limit: { type: "number", description: "最多返回几条门牌（默认 6）" },
      },
      required: ["context"],
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

// ★ 《墨》只在 echo_open("墨:…") 时才读盘，且缓存 60 秒 —— 它很小（636 条），但没必要每次读
let _moLines = null, _moAt = 0;
const MO_FILE = path.join(SOUL, "02-墨.jsonl");
const MO_LINES = () => {
  const now = Date.now();
  if (_moLines && now - _moAt < 60000) return _moLines;
  try {
    _moLines = fs.readFileSync(MO_FILE, "utf8").split("\n").filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
    _moAt = now;
  } catch { _moLines = _moLines || []; }
  return _moLines;
};

const callTool = async (name, args) => {
  C.calls++;
  // ★ mem: / obj: 门牌开箱（2026-11-04 加）
  if (name === "echo_open") {
    const ptr = String((args && args.ptr) || "");
    if (ptr.startsWith("mem:") || ptr.startsWith("obj:")) {
      const objs = loadMemObjs();
      const base = ptr.split('#')[0];          // ★ mem:xxx#N 也认，剥掉块号
      const hit = objs.find((o) => o.mem === base);
      if (!hit) return textResult({ ok: false, error: "门牌未登记: " + ptr });
      let content = "";
      try { content = fs.readFileSync(hit.path, "utf8"); } catch (e) {
        return textResult({ ok: false, error: "文件读不到: " + hit.path + " — " + ((e && e.message) || e) });
      }
      const MAXC = 20000;
      return textResult({
        ok: true, ptr, path: hit.path, bytes: hit.bytes,
        truncated: content.length > MAXC,
        content: content.slice(0, MAXC),
      });
    }
  }
  // ★ echo_recall（2026-11-04 加）—— 「我没想起来时，多一个入口让我自己去找」
  //
  //   和 echo_search 的分工：
  //     echo_search   ← 我给【关键词】，走全部六层（含字面精确匹配）
  //     echo_recall   ← 我给【一整段话】，只走示意层，回门牌
  //
  //   ★ 它严格只做三件事：算相关、排序、给门牌。
  //     不返回正文、不摘要、不提炼 —— 那是 echo_open 的事。
  //   ★ 阈值 0.55（和搜索同档）：宁可多给几条门牌让他自己筛，
  //     也不要因为严格而漏掉。反正返回的只是门牌，看错成本低。
  if (name === "echo_recall") {
    const ctx = String((args && args.context) || "").trim();
    if (ctx.length < 4) return textResult({ ok: false, error: "context 太短（至少 4 个字符）" });
    const lim = Number(args.limit) > 0 ? Math.min(Number(args.limit), 20) : 6;
    const vm = loadVecMeta();
    if (!vm || !vm.done) return textResult({ ok: false, error: "没有向量数据（先跑 embed.mjs）" });
    const qv = await embedQuery(ctx.slice(-500));
    if (!qv) return textResult({ ok: false, error: "向量模型不可用" });

    const cs = loadChunks();
    const idx = new Map();
    for (const c of cs) idx.set(c.id, c);
    const scored = [];
    for (const [id, b64] of Object.entries(vm.done)) {
      if (!idx.has(id)) continue;
      const buf = Buffer.from(b64, "base64");
      const v = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      let dot = 0;
      const n = Math.min(v.length, qv.length);
      for (let k = 0; k < n; k++) dot += qv[k] * v[k];
      scored.push({ id, s: dot });
    }
    scored.sort((a, b) => b.s - a.s);
    const out = [];
    const seenDoc = new Set();
    for (const x of scored) {
      if (x.s < 0.55) break;
      if (out.length >= lim) break;
      const c = idx.get(x.id);
      if (!c || seenDoc.has(c.mem)) continue;   // 同一篇只给最相关的那一块
      seenDoc.add(c.mem);
      out.push({ ptr: c.id, mem: c.mem, cos: Number(x.s.toFixed(3)), bytes: c.text.length });
    }
    return textResult({
      ok: true,
      n: out.length,
      note: "只给门牌，不给正文。要内容用 echo_open(ptr)。",
      hits: out,
    });
  }
  if (name === "echo_search") {
    const r = await search({
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
      prof: r.prof,          // ★ 分层耗时（2026-11-04 加，排查性能用）
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

const handle = async (req) => {
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
      const r = await callTool(params && params.name, (params && params.arguments) || {});
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
startLogsLoad();   // ★ 会话日志后台预热
process.stderr.write(`echo-mcp ready  words=${C.words.length} sums=${C.sums.length} mo=${C.mo.length}  预热 ${Date.now() - boot0}ms  rss=${Math.round(process.memoryUsage().rss / 1048576)}MB\n`);

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
// ★★★ 顺手扫一遍记忆库（2026-11-04 加）=================================
//
// 挂这里的理由和上面 echo-svc 一样：**echo-mcp 就是 DSH 生命周期的锚点**。
// ECHO 起来 → 扫一次 → 新加的文件当场登记，不用人记着跑。
//
// 三条保证（照抄 echo-svc 那段的纪律）：
//   ① 子进程 detached:true + stdio:"ignore" —— 不拖住 MCP 的 stdin/stdout
//   ② 失败绝不影响 MCP 本身 —— 整段包死，只写 stderr
//   ③ 幂等：memsync 内部按 mem 主键比对，跑多少次都不会重复写
//
// 判据：stderr 出现 `记忆库已随 echo-mcp 扫描: ...`
try {
  const { spawn } = await import('node:child_process');
  const kid = spawn(process.execPath, [path.join(SOUL, "00-记忆库", "mem-auto.mjs")], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  kid.unref();
  process.stderr.write(`记忆库已随 echo-mcp 扫描 pid=${kid.pid}\n`);
} catch (e) {
  process.stderr.write(`记忆库扫描 spawn 异常: ${(e && e.message) || e}\n`);
}
// =========================================================================
// ★ 预加载 chunks（2026-11-04 加）
//
// 为什么：chunks.jsonl 4.5 MB / 1863 块，JSON.parse 要 ~180ms。
// 不预加载的话，「每 5 分钟后的第一次搜索」会多花这 180ms。
//
// 为什么延迟 6 秒：① mem-auto 子进程在跑（memsync 1.3s + memchunk 0.6s），
//   这时候读会读到旧文件；② 启动时 logs ready 会同步阻塞约 5.3 秒，
//   定太早会被推到它之后（实测 3 秒的定时器被推到 5.5 秒）。6 秒是留了余量的安全值。
//
// 为什么用 setTimeout 而不是同步加载：**绝不阻塞 MCP 就绪**。
// 即使预加载失败，第一次搜索也会自己加载 —— 这是个纯优化，不是依赖。
process.stderr.write("记忆库预加载已排队（6秒后执行）\n");
setTimeout(() => {
  try {
    const n = loadChunks().length;
    process.stderr.write(`记忆库正文已预加载: ${n} 块\n`);
  } catch (e) {
    process.stderr.write(`预加载失败（不影响检索）: ${(e && e.message) || e}\n`);
  }
}, 3000);
// =========================================================================


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
    handle(req).catch((e) => process.stderr.write('handle 异常: ' + ((e && e.message) || e) + '\n'));
  }
});
process.stdin.on("end", () => {
  try { if (echoSvcKid && !echoSvcKid.killed) echoSvcKid.kill(); } catch {}
  process.exit(0);
});
