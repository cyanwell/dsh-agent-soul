// echo-svc.mjs —— ECHO 常驻检索服务（2026-10-25）
//
// ★ 它解决什么：`memq <词>` 每次都要读 52 MB JSONL + parse 5 万条（1.7 s）。
//   这里**只 parse 一次**，之后每次检索都是「遍历内存数组 + includes」（10-20 ms）。
//
// ★ 它不解决什么（说清楚，免得以后照着错的原因优化）：
//   `memq <词>` **根本不碰会话日志**。日志只在 `open` / `build` 时解码。
//   所以「日志缓存」是第二阶段的事，不是这一版的核心。
//
// ★ 三条硬规矩：
//   ① 服务挂了不许影响任何功能 —— client 连不上就回退到 CLI 原路径
//   ② 每次请求前 stat 三个文件（约 1 ms），变了只重载那一个
//   ③ 空闲不做任何轮询（没有 setInterval），只在请求时检查
import fs from "node:fs";
import path from "node:path";
import net from "node:net";

import * as CFG from "./echo-config.mjs";
const HUB = process.env.ECHO_HUB || CFG.HUB;   // ★ 发布版：从 echo-config 读
const IDX = path.join(HUB, "index");
const PIPE = process.env.ECHO_PIPE || "\\\\.\\pipe\\echo-hub";
const PIDF = path.join(HUB, ".cache", "echo-svc.pid");

// ── 归一化：必须和 memq.mjs 里的 norm **逐字一致** ─────────────
// ★ 两处实现不能漂：漂了就会「服务给出 A、CLI 给出 B」，那是最难查的一类不一致。
const norm = (s) => String(s == null ? "" : s)
  .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  .replace(/\u3000/g, " ")
  .toLowerCase()
  .replace(/(\d),(?=\d{3}(?!\d))/g, "$1");

const statKey = (f) => {
  try { const st = fs.statSync(f); return `${st.mtimeMs}:${st.size}`; } catch { return ""; }
};

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
    } catch { /* 坏行跳过，和 memq 一致 */ }
  }
  return out;
};

// ── 缓存 ────────────────────────────────────────────────────
const C = { words: [], wKey: null, sums: [], sKey: null, syn: new Map(), yKey: null, hits: 0, reloads: 0 };

const loadSyn = () => {
  const m = new Map();
  try {
    const j = JSON.parse(fs.readFileSync(path.join(HUB, "synonyms.json"), "utf8"));
    for (const [k, arr] of Object.entries(j)) {
      if (k.startsWith("//") || !Array.isArray(arr)) continue;
      const group = [k, ...arr].map(norm).filter(Boolean);
      for (const w of group) {
        if (!m.has(w)) m.set(w, new Set());
        for (const x of group) if (x !== w) m.get(w).add(x);
      }
    }
  } catch { /* 没有表就只做 exact + norm */ }
  return m;
};

/** 热更新：只在文件变了时重载。★ 判据是「build 完立刻能查到」 */
const refresh = () => {
  const wf = path.join(IDX, "words.jsonl"), sf = path.join(IDX, "summaries.jsonl"), yf = path.join(HUB, "synonyms.json");
  const wk = statKey(wf);
  if (wk !== C.wKey) { C.words = parseJsonl(wf); C.wKey = wk; C.reloads++; }
  const sk = statKey(sf);
  if (sk !== C.sKey) { C.sums = parseJsonl(sf); C.sKey = sk; C.reloads++; }
  const yk = statKey(yf);
  if (yk !== C.yKey) { C.syn = loadSyn(); C.yKey = yk; C.reloads++; }
};

/**
 * 三档匹配，语义与 memq 的 hitKind 完全一致。
 *
 * ★★ 2026-10-25 实测优化：第一版**每条都无条件算一次 norm(raw)**，
 *    4.3 万条 × 平均 800 字 → 服务内 **298-444 ms**，而「帧偏移」只命中 16 条也一样慢 ——
 *    这证明慢的不是命中数，是「逐条 norm」。
 *    修法：**纯中文查询词不需要 norm**（全角→半角、小写、去千分位对中文无影响），
 *    只在词里含 ASCII 字母/数字/全角时才付这个成本。
 */
const needNorm = (terms) => terms.some((t) => /[\dA-Za-z\uFF01-\uFF5E]/.test(t));
const hitKind = (s, terms, near) => {
  if (terms.length === 0) return "exact";
  if (s == null) return null;
  const raw = String(s);
  if (terms.every((t) => raw.includes(t))) return "exact";
  const nn = needNorm(terms);
  let ns = null;
  if (nn) {
    ns = norm(raw);
    if (terms.every((t) => ns.includes(norm(t)))) return "norm";
  }
  if (near) {
    if (ns === null) ns = norm(raw);   // 近义必然要比归一化后的串
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

/** 只做「索引层」的检索（墨/书房/留底仍在 CLI 侧，它们不是瓶颈）
 *
 * ★ 2026-10-25 加 limit：第一次实测「门牌」命中 1213 条 → 整机 779 ms，
 *   而服务内只 17 ms —— 差的 760 ms 全花在「把 1213 条完整 JSON 传回来 + 对方 parse」。
 *   每条 text 最多 4000 字，1213 条就是几 MB。
 *   ⇒ 协议改成：**返回前 limit 条的完整内容 + 一个总数**。
 *     `memq` 只显示 25 条，传 1213 条纯属浪费。
 */
/**
 * ★ limit 之后还慢 —— 第二次实测「门牌」带 limit=30 仍是 735-849 ms。
 *   原因不是条数，是**每条 text 最多 4000 字**：30 条 = 120 KB，传输 + 对方解析都很贵。
 *   ⇒ 只回 `text` 前 400 字（显示本来就截断在更短的位置），并留 `fullLen` 供调用方知道原文多长。
 *   ★ 原文永远在原处（`02-墨.jsonl` / `words.jsonl`），要全文用 `open <指针>` —— 这里只是索引片段。
 */
const SNIP = 400;
const search = (req) => {
  const terms = Array.isArray(req.terms) ? req.terms : [];
  const near = !!req.near;
  const since = req.since || null, until = req.until || null;
  const cap = Number(req.limit) > 0 ? Number(req.limit) : 0;   // 0 = 不限
  const hits = [];
  let total = 0;
  const push = (h, text) => {
    const s = String(text == null ? "" : text);
    hits.push({ ...h, text: s.length > SNIP ? s.slice(0, SNIP) : s, fullLen: s.length });
  };
  for (const s of C.sums) {
    if (!inRange(s.t, since, until)) continue;
    const k = hitKind(s.summary, terms, near);
    if (!k) continue;
    total++;
    if (!cap || hits.length < cap) {
      push({ layer: "L4", src: "索引/摘要", t: s.t, ptr: "idx:" + s.id, kind: "摘要", extra: `替换 ${s.shadowedTokens} tok`, m: k }, s.summary);
    }
  }
  for (const w of C.words) {
    if (!inRange(w.t, since, until)) continue;
    const k = hitKind(w.text, terms, near);
    if (!k) continue;
    total++;
    if (!cap || hits.length < cap) {
      const kk = w.kind === "task" ? "程序提示" : w.kind === "结论" ? "结论" : "原话";
      push({ layer: "L3", src: "索引", t: w.t, ptr: `log:${w.session}#seq=${w.seq}`, kind: kk, extra: w.ws, m: k }, w.text);
    }
  }
  return { hits, total };
};

const handle = (req) => {
  const t0 = Date.now();
  refresh();
  switch (req.cmd) {
    case "ping":
      return { ok: true, pid: process.pid, cached: { words: C.words.length, sums: C.sums.length, re: C.reloads } };
    case "search": {
      const r = search(req);
      return { ok: true, hits: r.hits, n: r.total, shown: r.hits.length, ms: Date.now() - t0 };
    }
    case "stats":
      return {
        ok: true, pid: process.pid, uptime: Math.round(process.uptime()),
        words: C.words.length, sums: C.sums.length,
        rssMB: Math.round(process.memoryUsage().rss / 1048576),
        reloads: C.reloads, requests: C.hits,
      };
    default:
      return { ok: false, err: "unknown cmd: " + req.cmd };
  }
};

// ── 服务器 ──────────────────────────────────────────────────
const server = net.createServer((sock) => {
  sock.setEncoding("utf8");
  let buf = "";
  sock.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      C.hits++;
      let res;
      try { res = handle(JSON.parse(line)); }
      catch (e) { res = { ok: false, err: String((e && e.message) || e) }; }
      try { sock.write(JSON.stringify(res) + "\n"); } catch { /* 对端断了 */ }
    }
  });
  sock.on("error", () => { /* 客户端断开是常态，不刷日志 */ });
});

server.on("error", (e) => {
  // 端口被占 = 已经有一个服务在跑，这不是故障
  if (e && e.code === "EADDRINUSE") { process.exit(0); }
  console.error("svc error:", e && e.message);
  process.exit(1);
});

server.listen(PIPE, () => {
  try {
    fs.mkdirSync(path.dirname(PIDF), { recursive: true });
    fs.writeFileSync(PIDF, JSON.stringify({ pid: process.pid, pipe: PIPE, at: new Date().toISOString() }), "utf8");
  } catch { /* pid 文件写不了不影响服务 */ }
  // ★ 预热：先把索引 parse 进内存，别让第一个请求等
  const t0 = Date.now();
  refresh();
  console.error(`echo-svc ready  pid=${process.pid}  words=${C.words.length}  sums=${C.sums.length}  预热 ${Date.now() - t0}ms  rss=${Math.round(process.memoryUsage().rss / 1048576)}MB`);
});

// ★ 收到关闭信号时清掉 pid 文件（Ctrl+C / 任务管理器结束）
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => { try { fs.unlinkSync(PIDF); } catch {} process.exit(0); });
}
