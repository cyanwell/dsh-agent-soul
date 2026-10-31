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
const refresh = () => {
  const wk = statKey(path.join(IDX, "words.jsonl"));
  if (wk !== C.wKey) { C.words = parseJsonl(path.join(IDX, "words.jsonl")); C.wKey = wk; C.reloads++; }
  const sk = statKey(path.join(IDX, "summaries.jsonl"));
  if (sk !== C.sKey) { C.sums = parseJsonl(path.join(IDX, "summaries.jsonl")); C.sKey = sk; C.reloads++; }
  const yk = statKey(path.join(HUB, "synonyms.json"));
  if (yk !== C.yKey) { C.syn = loadSyn(); C.yKey = yk; C.reloads++; }
  const mk = statKey(MO);
  if (mk !== C.moKey) { C.mo = parseJsonl(MO); C.moKey = mk; C.reloads++; }
};

/** 三档匹配 —— 与 memq 的 hitKind 逐字一致 */
const hitKind = (s, terms, near) => {
  if (terms.length === 0) return "exact";
  if (s == null) return null;
  const raw = String(s);
  if (terms.every((t) => raw.includes(t))) return "exact";
  let ns = null;
  if (needNorm(terms)) {
    ns = norm(raw);
    if (terms.every((t) => ns.includes(norm(t)))) return "norm";
  }
  if (near) {
    if (ns === null) ns = norm(raw);
    const ok = terms.every((t) => {
      const alts = C.syn.get(norm(t));
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
    const k = hitKind(r.text + " " + (r.ref || ""), terms, near);
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
    const k = hitKind(s.summary, terms, near);
    if (!k) continue;
    total++; idxTotal++;
    if (idxHits.length < limit) idxHits.push({ layer: "L4", src: "索引/摘要", t: s.t, ptr: "idx:" + s.id, kind: "摘要", extra: `替换 ${s.shadowedTokens} tok`, m: k, _t: s.summary });
  }
  for (const w of C.words) {
    if (!inRange(w.t, since, until)) continue;
    const k = hitKind(w.text, terms, near);
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
        const k = hitKind(ln, terms, near);
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
  hits.sort((a, b) => {
    const ra = a.layer === "L3" ? 0 : 1, rb = b.layer === "L3" ? 0 : 1;
    if (ra !== rb) return ra - rb;
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
    const mem = process.memoryUsage();
    return textResult({
      words: C.words.length, sums: C.sums.length, mo: C.mo.length, soulFiles: C.soul.size,
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
