// echo-doctor.mjs —— 回声系统体检（回声 Echo · 自检器）v2
// ============================================================================
// 爀曦 2026-10-08 04:22 要求：把回声做成独立面板，实时检测运行状态。
// 爀曦 2026-10-08 04:42 追加：体检太慢，要仪表盘 + 四级轮询
//   （1级 5 分钟 / 2级 10 分钟 / 3级 30 分钟 / 4级 手动，默认 3 级）。
//
// ★★★ v2 的关键改动：**拆成快层与深层层**。
//   起因：十项检查里九项是毫秒级的（读文件时间、meta.json、数《墨》行数），
//   只有两项要解那份 74MB 的多帧日志（门牌实测 / 压缩统计）—— 而 v1 把那份日志**解了两遍**，
//   于是 17 秒里有 16 秒花在重复解码上。这不是「体检慢」，这是「我算重了」。
//   · fast（毫秒级）：不解日志。面板的秒级刷新靠它。
//   · deep（约 5-8 秒）：真要解日志。靠 decodeCached 只解一次、两项共用。
//
// ★ 两条纪律（今晚的教训，一条都不许省）：
//   ① **门牌那一项必须真去取一次**，不看配置 —— 今晚的故障就是「配置看着对、实际取不出来」，
//      只读配置的体检会全部报绿，那种绿比红更坏。
//   ② **判据不许被注释骗** —— 版本漂移第一次跑报了 5 处，全是我当天写的修复注释。
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import * as CFG from "./echo-config.mjs";

const HUB = CFG.HUB;
const SOUL = CFG.SOUL;
const MEM = CFG.MEM;
const SESSIONS = CFG.SESSIONS;
const IDX = path.join(HUB, "index");
const MO = path.join(SOUL, "02-墨.jsonl");
const SELF_MD = path.join(HUB, "SELF.md");
const HEARTBEAT_DIR = path.join(HUB, "heartbeat");
const RUNTIME = CFG.RUNTIME;

const MARK = "⛬ 压缩索引（非原文）";
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
// ★ 版本无感：认 session.v<N>.jsonl.zstd，不认死 v3（2026-10-08 的故障根因）。
const LOG_RE = /^session\.v(\d+)\.jsonl\.zstd$/;

// ──────────────────────────── 工具 ────────────────────────────

const readText = (p) => { try { return fs.readFileSync(p, "utf8") } catch { return null } };
const statSafe = (p) => { try { return fs.statSync(p) } catch { return null } };
// ★ 2026-10-09 修：原来这里是 `new Date(d).toISOString()` —— 而 **toISOString 永远输出 UTC**，
//   于是本地 10-08 04:36 被显示成 10-07 20:36，**整整差 8 小时**。
//   ★ 症状为什么难缠：`hoursSince()` 用的是 Date 差值，所以「距今 34.7 小时」是对的 ——
//     **只有绝对时刻错**。于是一个人看着「34.7 小时前」觉得没毛病，
//     却对着「最后一次 10-07 20:36」去日志里找，永远找不到那一行（日志里写的是 10-08 4:36）。
//   ★ 这是「一半对一半错」的典型：它比整段全错更容易骗过人。
const iso = (d) => {
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return "(无效时间)";
  const p = (n) => String(n).padStart(2, "0");
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())} `
       + `${p(x.getHours())}:${p(x.getMinutes())}:${p(x.getSeconds())}`;
};
const hoursSince = (t) => (Date.now() - Number(t)) / 3600000;
const round1 = (n) => Math.round(n * 10) / 10;

/** 多帧 zstd → 事件数组。半行/坏行跳过，不因一行坏掉整份日志。 */
function decodeZstd(file) {
  let buf;
  try { buf = fs.readFileSync(file) } catch { return { events: [], frames: 0, failed: 0 } }
  const frames = [];
  let i = buf.indexOf(MAGIC, 0);
  while (i >= 0) {
    const n = buf.indexOf(MAGIC, i + 4);
    frames.push(buf.subarray(i, n === -1 ? buf.length : n));
    i = n;
  }
  // ★★★ 2026-10-18 修：解压总量封顶，且从**尾部**往前解。
  //   起因：本会话自己的日志 session-1099f531 已达 155 MB（zstd），解压后 1 GB 以上，
  //   `Buffer.concat(chunks).toString("utf8")` 直接抛
  //   `Cannot create a string longer than 0x1fffffe8 characters`（约 512 MB 上限），
  //   于是深检整轮崩掉 → 面板永远停在「待深度检测…」。体检器被被体检的对象撑爆了。
  //   为什么从尾部解不损失语义：门牌实测要「最后一次 compaction/summary」、
  //   压缩统计要最近的 compaction/*、换气要最近的 turn/end —— 全都在日志末端。
  const MAX_TOTAL = 192 * 1024 * 1024;   // 解压后总字节上限
  const chunks = [];
  let failed = 0;
  let total = 0;
  for (let k = frames.length - 1; k >= 0; k--) {
    let b;
    try { b = zlib.zstdDecompressSync(frames[k]) } catch { failed++; continue }
    if (total + b.length > MAX_TOTAL) {
      if (chunks.length === 0) {
        // 单帧就超限：只取尾部，前面的半行会被 JSON.parse 的 try 吃掉
        chunks.unshift(b.subarray(b.length - MAX_TOTAL));
        total = MAX_TOTAL;
      }
      break;
    }
    chunks.unshift(b);
    total += b.length;
    if (total >= MAX_TOTAL) break;
  }
  const events = [];
  for (const line of Buffer.concat(chunks).toString("utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { events.push(JSON.parse(t)) } catch { /* 半行 */ }
  }
  // ★★★ 2026-10-08 手滑回归：这里原本写成 `{ events, frames, failed }` ——
  //   把**帧数组本身**（几百个大 Buffer）当成"帧数"返回了出去。
  //   后果不是报错，而是 deep 模式的 JSON 被撑到 **2.8 亿字符**，
  //   `JSON.stringify` 抛 `RangeError: Invalid string length`，
  //   于是"深检永远拿不到报告、面板永远显示待深检"。
  //   而 fast 模式不用这个字段 ⇒ 症状只在深检出现，极难一眼看穿。
  //   ★ 教训：重写文件时的"手滑回归"，比新写的 bug 更难找 —— 因为旧版是对的。
  return { events, frames: frames.length, failed };
}

/**
 * ★★ v2 的缓存 —— 「体检从 17 秒降到 5 秒」的全部秘密。
 * 门牌实测与压缩统计要的是**同一份**日志；v1 各解一遍 = 白花一倍时间。
 * 键带 size+mtime：日志一被追加就自动失效，不会拿旧数据糊弄。
 */
const _decCache = new Map();
function decodeCached(file) {
  const st = statSafe(file);
  const key = `${file}|${st ? st.size : 0}|${st ? st.mtimeMs : 0}`;
  const hit = _decCache.get(key);
  if (hit) return hit;
  const r = decodeZstd(file);
  _decCache.clear();               // 只留最新一份，别把内存吃光
  _decCache.set(key, r);
  return r;
}

/** 列出所有会话日志（版本无感），按 mtime 降序。 */
function listLogs() {
  const out = [];
  let buckets = [];
  try { buckets = fs.readdirSync(SESSIONS) } catch { return out }
  for (const b of buckets) {
    const bp = path.join(SESSIONS, b);
    if (!statSafe(bp)?.isDirectory()) continue;
    let sids = [];
    try { sids = fs.readdirSync(bp) } catch { continue }
    for (const sid of sids) {
      const sd = path.join(bp, sid);
      if (!statSafe(sd)?.isDirectory()) continue;
      let names = [];
      try { names = fs.readdirSync(sd) } catch { continue }
      for (const n of names) {
        const m = LOG_RE.exec(n);
        if (!m) continue;
        const st = statSafe(path.join(sd, n));
        if (!st?.isFile()) continue;
        out.push({ bucket: b, sid, name: n, ver: Number(m[1]), file: path.join(sd, n), bytes: st.size, mtime: st.mtimeMs });
      }
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

// ──────────────────── 快层：不解日志，毫秒级 ────────────────────

function checkLogs(logs) {
  if (logs.length === 0) {
    // ★ 「一个日志都没有」要分清楚，别混成一种（2026-10-18 修了三版才收敛）。
    //
    //   ★ 关键词：会话日志是 **DSH 自己产生的**，不是我们建的。
    //     ECHO_SESSIONS 只是指向它。所以「目录不在」多半是「DSH 还没跑过」，
    //     那是**正常的新装状态**，不是故障。
    //
    //   ① 根本没配 SESSIONS        → **error**。门没了，这才是真故障。
    //   ② 配了、目录不在 / 空着    → **warn**。还没开始用，第一次对话之后就有了。
    //
    //   ★ 原来一律报 error。后果：新用户装完跑第一次体检就看见一片红，
    //     而那红色全是「你还没开始用」。**体检器是保险，不该对「还没开始」拉警报** ——
    //     第一次就红，人只会学会忽略它，那这层保险就废了。
    if (!CFG.SESSIONS) {
      return {
        id: "logs", label: "会话日志", status: "error",
        detail: "没找到会话日志目录，也没配置 ECHO_SESSIONS —— 这一层没有门",
        evidence: { root: null },
      };
    }
    const dir = SESSIONS.replace(/\//g, path.sep);
    const dirExists = fs.existsSync(dir);
    return {
      id: "logs", label: "会话日志", status: "warn",
      detail: dirExists
        ? "目录在，但还没有日志 —— 你还没开始用。第一次对话之后这里就会有东西"
        : "目录还不存在 —— DSH 还没产生会话日志，或者路径填错了。第一次对话之后再看",
      evidence: { root: SESSIONS, dirExists },
    };
  }
  const newest = logs[0];
  const age = hoursSince(newest.mtime);
  const vers = {};
  for (const l of logs) vers[l.ver] = (vers[l.ver] || 0) + 1;
  const versStr = Object.keys(vers).sort((a, b) => a - b).map((v) => `v${v}×${vers[v]}`).join(" / ");
  const bySid = {};
  for (const l of logs) (bySid[l.sid] ||= []).push(l.ver);
  const multi = Object.entries(bySid).filter(([, v]) => new Set(v).size > 1);
  const status = age > 24 ? "warn" : "ok";
  return {
    id: "logs", label: "会话日志", status,
    detail: `${logs.length} 份日志，版本 ${versStr}；最新一份 ${round1(age)} 小时前`,
    evidence: {
      total: logs.length, versions: vers,
      newest: { sid: newest.sid, file: newest.name, bytes: newest.bytes, ageHours: round1(age) },
      multiVersionSessions: multi.length,
      note: multi.length ? `${multi.length} 个会话同时有多版本日志（宿主行为；读取端必须版本无感）` : null,
    },
  };
}

/** ★ 深度项：门牌实测。deep=false 时返回 info，由调用方补上次深检结果。 */
function checkDoorSign(logs, deep) {
  const target = logs.find((l) => l.bytes > 0);
  if (!target) return { id: "doorsign", label: "门牌回取（实测）", status: "warn", detail: "没有可测的日志", evidence: {}, deep: true };
  if (!deep) return { id: "doorsign", label: "门牌回取（实测）", status: "info", detail: "待深度检测…", evidence: { skipped: true }, deep: true };

  const { events, frames, failed } = decodeCached(target.file);
  if (events.length === 0) {
    return { id: "doorsign", label: "门牌回取（实测）", status: "error", detail: "日志解不出任何事件", evidence: { file: target.file, frames, failed }, deep: true };
  }
  const summaries = events.filter((e) => e.type === "compaction/summary");
  if (summaries.length === 0) {
    return { id: "doorsign", label: "门牌回取（实测）", status: "warn", detail: "这份日志里还没有压缩摘要，无可测门牌", evidence: { events: events.length }, deep: true };
  }
  const last = summaries[summaries.length - 1];
  const raw = JSON.stringify(last.data || {});
  const m = /#seq=(\d+)/.exec(raw);
  if (!m) {
    return {
      id: "doorsign", label: "门牌回取（实测）", status: "error",
      detail: "最近一次压缩的摘要里没有门牌 —— 压缩发生了，但回取链断了",
      evidence: { summarySeq: last.seq, time: iso(last.time), hasMark: raw.includes(MARK) }, deep: true,
    };
  }
  const want = Number(m[1]);
  const hit = events.find((e) => e.seq === want);
  const sr = last.data?.shadowedRange;
  const srMatch = sr && Number(sr.start) === want;
  if (!hit) {
    return {
      id: "doorsign", label: "门牌回取（实测）", status: "error",
      detail: `门牌写着 seq=${want}，但在日志里取不到 —— 这就是「静默失效」的长相`,
      evidence: { summarySeq: last.seq, want, file: target.file, events: events.length, maxSeq: Math.max(...events.map((e) => e.seq || 0)) }, deep: true,
    };
  }
  return {
    id: "doorsign", label: "门牌回取（实测）", status: srMatch ? "ok" : "warn",
    detail: `门牌 seq=${want} 真取到了（${hit.type}）${srMatch ? "，且与 shadowedRange 一致" : "，但与 shadowedRange 不符"}`,
    evidence: {
      summarySeq: last.seq, time: iso(last.time), want, gotType: hit.type,
      shadowedRange: sr || null, rangeMatches: !!srMatch,
      summaryCount: summaries.length, events: events.length, frames, failed,
    },
    deep: true,
  };
}

/** ★ 深度项：压缩统计。与门牌共用同一个 decodeCached，不再各解一遍。 */
function checkCompaction(logs, deep) {
  const target = logs.find((l) => l.bytes > 0);
  if (!target) return { id: "compaction", label: "压缩机制", status: "warn", detail: "没有可测的日志", evidence: {}, deep: true };
  if (!deep) return { id: "compaction", label: "压缩机制", status: "info", detail: "待深度检测…", evidence: { skipped: true }, deep: true };

  const { events } = decodeCached(target.file);
  const tally = {};
  for (const e of events) if (typeof e.type === "string" && e.type.startsWith("compaction/")) tally[e.type] = (tally[e.type] || 0) + 1;
  const start = tally["compaction/start"] || 0;
  const sum = tally["compaction/summary"] || 0;
  const end = tally["compaction/end"] || 0;
  const prune = tally["compaction/prune"] || 0;
  const errs = events.filter((e) => e.type === "compaction/end" && e.data && e.data.error);
  const ratio = start ? sum / start : 1;
  let status = "ok";
  if (start === 0) status = "warn";
  else if (ratio < 0.9 || errs.length > 0) status = "warn";
  const lastEnd = [...events].reverse().find((e) => e.type === "compaction/end");
  return {
    id: "compaction", label: "压缩机制", status,
    detail: `start ${start} / summary ${sum} / end ${end} / prune ${prune}${errs.length ? `；${errs.length} 次带 error` : ""}`,
    evidence: { tally, ratio: round1(ratio * 100) / 100, errors: errs.slice(-3).map((e) => ({ seq: e.seq, error: e.data.error })), lastEndAt: lastEnd ? iso(lastEnd.time) : null },
    deep: true,
  };
}

/**
 * ★ 深度项：换气（思考预算）—— 稳态的时间维。
 * 为什么需要它：换气的判定参数（相似度 0.8 / 连续 3 次 / 上限 4 次 / 推理门槛 2048 字符）
 * 一次调好之后**没有任何反馈回路** —— 断过几次、有没有误伤，此前无人知道。
 * ★ 2026-10-14 实测确认：换气**不写事件**（没有 huanqi/* 之类），
 *   所以这里不测"药效"，测**病症**：一个回合烧光预算、正文一个字没出来。
 *   形状 = assistant/message 的 content 里只有 reasoning，没有 text / tool-call。
 * ★ 双插件对账：换气只收「推理 >= minReasoningChars（默认 2048）」的，
 *   而 dsh-stalled-turn-continue 不看长度、两种 turn/end kind 都收 —— 两者是接力，不是重复。
 */
function checkHuanqi(logs, deep) {
  if (!deep) return { id: "huanqi", label: "换气（思考预算）", status: "info", detail: "待深度检测…", evidence: { skipped: true }, deep: true };
  const targets = logs.filter((l) => l.bytes > 0).slice(0, 8);
  if (!targets.length) return { id: "huanqi", label: "换气（思考预算）", status: "warn", detail: "没有可测的日志", evidence: {}, deep: true };

  const MIN_REASONING = 2048; // = 换气默认 minReasoningChars
  let total = 0, noReply = 0, overThreshold = 0;
  const reasons = {};
  const samples = [];
  for (const t of targets) {
    const { events } = decodeCached(t.file);   // 与门牌/压缩共用同一份缓存
    for (const e of events) {
      if (e.type === "turn/end" && e.data && e.data.reason) {
        const k = typeof e.data.reason.kind === "string" ? e.data.reason.kind : "unknown";
        reasons[k] = (reasons[k] || 0) + 1;
      }
      if (e.type !== "assistant/message") continue;
      const content = e.data && e.data.message && e.data.message.content;
      if (!Array.isArray(content)) continue;
      total++;
      const visible = content.some((p) => p && (p.type === "text" || p.type === "tool-call" || p.type === "tool_call"));
      if (visible) continue;
      noReply++;
      const rlen = content.reduce((a, p) => a + (p && p.type === "reasoning" && p.text ? p.text.length : 0), 0);
      if (rlen >= MIN_REASONING) {
        overThreshold++;
        if (samples.length < 5) samples.push({ sid: t.sid.slice(0, 12), seq: e.seq, reasoningChars: rlen });
      }
    }
  }

  // ★ 判据：有病症却零介入 = 该响的没响。这是这一项存在的全部意义。
  const hasSymptom = overThreshold > 0;
  const everBroke = Object.keys(reasons).some((k) => /repetitive|loop|no-visible/i.test(k));
  let status = "ok";
  let note = "";
  if (hasSymptom && !everBroke) { status = "warn"; note = "；该介入的回合存在，但日志里零介入痕迹"; }
  else if (hasSymptom && everBroke) { note = "；已见过介入痕迹"; }

  return {
    id: "huanqi", label: "换气（思考预算）", status,
    detail: `无输出回合 ${noReply}/${total}（推理 ≥${MIN_REASONING} 的 ${overThreshold} 条）${note}`,
    evidence: {
      logsSampled: targets.length, assistantMessages: total, noVisibleOutput: noReply,
      overReasoningThreshold: overThreshold, minReasoningChars: MIN_REASONING,
      turnEndReasons: reasons, samples,
      crossCheck: "换气只覆盖推理 ≥2048 的；dsh-stalled-turn-continue 覆盖全部无输出回合（两者接力）",
    },
    deep: true,
  };
}

function checkIndex(logs) {
  const metaPath = path.join(IDX, "meta.json");
  const meta = readText(metaPath);
  // ★ 「还没建」不是「坏了」。索引没建过 → warn（下一步就是建它）；
  //   meta.json 在但解析不了 → 那才是 error（真坏了，修不好得重建）。
  if (!meta) return { id: "index", label: "索引层 L4", status: "warn", detail: "索引还没建过 —— 跑一次 memindex.mjs build 就好", evidence: { metaPath } };
  let m;
  try { m = JSON.parse(meta) } catch { return { id: "index", label: "索引层 L4", status: "error", detail: "meta.json 解析失败", evidence: { metaPath } } }
  const built = new Date(m.builtAt).getTime();
  const lagH = hoursSince(built);
  const newer = logs.filter((l) => l.mtime > built).length;
  // ★ 「新增几份日志」只作信息、不作判据 —— 任何一轮对话都会产生新日志，
  //   拿它当警告会让面板永远亮黄灯。真判据是滞后时间。
  let status = "ok";
  if (lagH > 72) status = "error";
  else if (lagH > 24) status = "warn";
  return {
    id: "index", label: "索引层 L4", status,
    detail: `建于 ${iso(built)}（${round1(lagH)} 小时前）；摘要 ${m.summaries ?? "?"} / 原话 ${m.words ?? "?"}；之后新增 ${newer} 份`,
    evidence: { builtAt: m.builtAt, elapsedSec: m.elapsedSec, summaries: m.summaries, words: m.words, logs: m.logs, logsNewerThanIndex: newer, lagHours: round1(lagH) },
  };
}

function checkSelf(logs, deep) {
  const st = statSafe(SELF_MD);
  // ★ 还没装配 → warn（改完 SELF.src.md 跑一次 self.mjs 就好）。
  //   装配过却长期没更新 → 那才是后面的滞后判据要管的事。
  if (!st) return { id: "self", label: "推送层 SELF", status: "warn", detail: "SELF.md 还没装配 —— 跑一次 self.mjs 就好", evidence: {} };
  const h = hoursSince(st.mtime);
  const txt = readText(SELF_MD) || "";
  const sizeLine = /(\d+)\s*B\s*\/\s*预算\s*(\d+)\s*B/.exec(txt);
  const pct = sizeLine ? Math.round((Number(sizeLine[1]) / Number(sizeLine[2])) * 100) : null;
  // ★★ 文件在 ≠ 被读到。2026-10-18 沙箱实测踩到的假绿：
  //    SELF.md 明明装配好了，每轮 runtime context 还在喊「SELF.md 读不到（./SELF.md）」——
  //    因为 dsh-agent-memory 的 selfPath 指向别处（默认 './SELF.md'），而 scaffold 把它写在 memory/hub/。
  //    只查「文件存在」的话，这一项永远 ✓，而推送层其实一点没吃到。
  //    所以深检要从**真实注入过的日志**里找证据 —— 这是唯一的硬判据。
  let injected = null // null = 快检，没验
  if (deep) {
    const targetLog = logs.find((l) => l.bytes > 0)
    if (targetLog) {
      try {
        const { events } = decodeCached(targetLog.file)
        const raw = events.map((e) => JSON.stringify(e.data || {})).join("\n")
        if (raw.includes("SELF.md 读不到")) injected = false
        else if (raw.includes("自我层") || raw.includes("SELF.md")) injected = true
      } catch { /* 解不出来就不下结论，别猜 */ }
    }
  }
  if (injected === false) {
    return {
      id: "self", label: "推送层 SELF", status: "error",
      detail: `SELF.md 在磁盘上（${st.size} B），但最近一轮注入时读不到 —— 查 dsh-agent-memory 的 selfPath 指到哪了，现在它多半在找 ./SELF.md`,
      evidence: { bytes: st.size, path: SELF_MD, injected: false },
    }
  }

  let status = "ok";
  if (h > 72) status = "error"; else if (h > 24) status = "warn";
  if (pct !== null && pct > 95 && status === "ok") status = "warn";
  return {
    id: "self", label: "推送层 SELF", status,
    detail: `${st.size} B${pct !== null ? `（预算 ${pct}%）` : ""}，装配于 ${iso(st.mtime)}（${round1(h)} 小时前）`
      + (injected === true ? "，最近的注入里读到了" : injected === null ? "" : ""),
    evidence: { bytes: st.size, usedPct: pct, ageHours: round1(h), injected },
  };
}

function checkHeartbeat() {
  let newest = 0, file = null;
  try {
    for (const n of fs.readdirSync(HEARTBEAT_DIR)) {
      const p = path.join(HEARTBEAT_DIR, n);
      const st = statSafe(p);
      if (st?.isFile() && st.mtimeMs > newest) { newest = st.mtimeMs; file = n }
    }
  } catch {
    // ★ 心跳是**可选**那一层（要另外装定时任务）。没装 ≠ 坏了。
    //   ★ 但要说清「如果你装过，那它是停了」—— doctor 分不出「没装」和「装了但目录被删」，
    //     所以给 warn 而不是 error，把判断权留给人。
    return {
      id: "heartbeat", label: "心跳（自律神经）", status: "warn",
      detail: "没有心跳目录 —— 这一层可选，没装是正常的。装过的话，那就是它停了",
      evidence: { dir: HEARTBEAT_DIR, installed: false },
    };
  }
  if (!newest) {
    return {
      id: "heartbeat", label: "心跳（自律神经）", status: "warn",
      detail: "目录在，但一次都没跑过 —— 定时任务可能还没触发，或者没装上",
      evidence: { dir: HEARTBEAT_DIR, installed: true },
    };
  }
  const h = hoursSince(newest);
  let status = "ok";
  if (h > 96) status = "error"; else if (h > 48) status = "warn";
  return {
    id: "heartbeat", label: "心跳（自律神经）", status,
    detail: `最后一次 ${iso(newest)}（${round1(h)} 小时前，${file}）`,
    evidence: { lastRun: iso(newest), file, ageHours: round1(h), dir: HEARTBEAT_DIR },
  };
}

function checkMo() {
  // ★ 「读不到」和「空着」是两件事。
  //   原来用 `if (!txt)`，于是刚 scaffold 出来的 0 字节账本被判成 error「读不到 02-墨.jsonl」——
  //   而那是「还没开始用」，不是「坏了」。新装的人第一次体检就看见这个，会以为装坏了。
  //   判据和 error/warn 的划分是同一条：文件在但空着 → warn；文件根本不在 / 读不出 → error。
  if (!fs.existsSync(MO)) {
    return { id: "mo", label: "《墨》账本", status: "error", detail: "找不到 02-墨.jsonl（账本是你的一手层，它必须在）", evidence: { MO } };
  }
  let txt
  try {
    txt = fs.readFileSync(MO, "utf8")
  } catch (e) {
    return { id: "mo", label: "《墨》账本", status: "error", detail: "02-墨.jsonl 读不出来：" + (e && e.message ? e.message : e), evidence: { MO } };
  }
  if (!txt.trim()) {
    return { id: "mo", label: "《墨》账本", status: "warn", detail: "账本在，还是空的 —— 写下第一条它就活了", evidence: { MO, bytes: fs.statSync(MO).size } };
  }
  const lines = txt.split("\n").filter((l) => l.trim());
  let bad = 0, withText = 0, withGaiyao = 0, withFeel = 0, last = null, lastReadable = null;
  const types = {};
  for (const line of lines) {
    let r;
    try { r = JSON.parse(line) } catch { bad++; continue }
    const hasText = typeof r.text === "string" && r.text.length > 0;
    const hasG = typeof r["概要"] === "string" && r["概要"].length > 0;
    if (hasText) withText++;
    if (hasG) withGaiyao++;
    if (typeof r.feel === "string" && r.feel) withFeel++;
    types[r.type] = (types[r.type] || 0) + 1;
    last = r;
    lastReadable = hasText || hasG;
  }
  const unreadable = lines.length - withText - withGaiyao;
  let status = "ok";
  if (bad > 0 || unreadable > 0) status = "warn";
  if (last && !lastReadable) status = "error";
  return {
    id: "mo", label: "《墨》账本", status,
    detail: `${lines.length} 条；正文在 text ${withText} / 在 概要 ${withGaiyao}；带 feel ${withFeel}${unreadable > 0 ? `；★ ${unreadable} 条两种字段都没有` : ""}`,
    evidence: { lines: lines.length, withText, withGaiyao, withFeel, unreadable, badLines: bad, types, lastAt: last?.t || null, lastType: last?.type || null, lastReadable: !!lastReadable },
  };
}

function checkHotMemory() {
  const items = [];
  for (const [name, cap] of [["USER.md", 4096], ["MEMORY.md", 10240]]) {
    const st = statSafe(path.join(RUNTIME, name));
    if (!st) { items.push({ name, bytes: null, cap, pct: null }); continue }
    items.push({ name, bytes: st.size, cap, pct: Math.round((st.size / cap) * 100) });
  }
  const worst = items.filter((i) => i.pct !== null).sort((a, b) => b.pct - a.pct)[0];
  let status = "ok";
  if (worst && worst.pct >= 90) status = "warn";
  return {
    id: "hot", label: "L1 热记忆", status,
    detail: items.map((i) => `${i.name} ${i.bytes ?? "?"}B${i.pct !== null ? `（${i.pct}%）` : ""}`).join("　｜　"),
    evidence: { items },
  };
}

function checkVersionDrift() {
  const hits = [];
  let files = [];
  try { files = fs.readdirSync(HUB).filter((n) => n.endsWith(".mjs") && !n.startsWith("_")) } catch { /* */ }
  for (const n of files) {
    const t = readText(path.join(HUB, n));
    if (t === null) continue;
    t.split("\n").forEach((line, i) => {
      const s = line.trim();
      // ★ 先剔注释 —— 否则「修复说明里引用了那个坏写法」会被当成**新的**坏写法（第一次跑就踩了）。
      if (s.startsWith("//") || s.startsWith("*") || s.startsWith("/*")) return;
      if (/["'`]session\.v\d+\.jsonl\.zstd["'`]/.test(line)) hits.push({ file: n, line: i + 1, text: s.slice(0, 110) });
    });
  }
  return {
    id: "drift", label: "版本漂移扫描", status: hits.length ? "error" : "ok",
    detail: hits.length
      ? `★ 还有 ${hits.length} 处把日志名写死成字面量 —— 宿主下次升版会重演静默失效`
      : `扫了 ${files.length} 个脚本，没有写死版本号的字面量（全部版本无感）`,
    evidence: { scanned: files.length, hits },
  };
}

function checkIdentity() {
  const txt = readText(MO);
  // ★ 账本读不到时，这一条是**连带**，不是独立故障 —— 账本本身已经由 checkMo 报过了。
  //   同一个原因报两次 error，会让人以为哪里都坏了。降成 warn，并说清「先让账本有东西」。
  if (!txt) return { id: "identity", label: "身份判据", status: "warn", detail: "账本还没有内容 —— 先写下第一条，《墨》里才有 lead 可认", evidence: {} };
  const leads = [];
  for (const line of txt.split("\n")) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r.type === "lead") leads.push(r) } catch { /* */ }
  }
  const lastLead = leads[leads.length - 1] || null;
  let state = null;
  try { const s = readText(path.join(HUB, "state.json")); state = s ? JSON.parse(s) : null } catch { /* */ }
  const stateSid = state?.session || null;
  const leadSid = lastLead?.by ? `session-${lastLead.by}` : null;
  const staleNote = stateSid && leadSid && !stateSid.includes(lastLead.by)
    ? `state.json 里记的还是 ${stateSid}，与当前 lead 署名（${leadSid}）不一致 —— 只是 mark 没跟上，不影响判据`
    : null;
  return {
    id: "identity", label: "身份判据（换容器/换届）", status: "ok",
    detail: `《墨》里 ${leads.length} 代 lead，最后一条署名 ${leadSid || "?"} —— 判据只认《墨》，与容器/工作区无关`,
    evidence: { leadCount: leads.length, lastLeadBy: leadSid, lastLeadAt: lastLead?.t || null, stateSession: stateSid, staleNote },
  };
}

// ──────────────────────── 汇总 ────────────────────────

/**
 * 跑一次体检。
 * @param {{deep?: boolean}} opts
 *   deep=true（默认）→ 解日志：门牌实测 + 压缩统计，约 5-8s。
 *   deep=false      → 只跑快层（毫秒级）；两项深度检查返回 status:"info"，
 *                     由调用方（面板宿主半）补上「上次深检」的结果，用户看不到空窗。
 */
export function runDoctor(opts = {}) {
  const deep = opts.deep !== false;
  const t0 = Date.now();
  const logs = listLogs();
  const checks = [
    checkLogs(logs),
    checkDoorSign(logs, deep),
    checkCompaction(logs, deep),
    checkIndex(logs),
    checkSelf(logs, deep),
    checkHeartbeat(),
    checkMo(),
    checkHotMemory(),
    checkVersionDrift(),
    checkIdentity(),
    checkHuanqi(logs, deep),
  ];
  const order = { error: 0, warn: 1, ok: 2, info: 3 };
  // 总判只看有结论的项 —— info（待深检）不拉低总判，否则快检永远是"未完成"
  const judged = checks.filter((c) => c.status !== "info");
  const worst = judged.reduce((a, c) => (order[c.status] < order[a] ? c.status : a), "ok");
  return {
    at: iso(Date.now()),
    mode: deep ? "deep" : "fast",
    overall: worst,
    counts: {
      error: judged.filter((c) => c.status === "error").length,
      warn: judged.filter((c) => c.status === "warn").length,
      ok: judged.filter((c) => c.status === "ok").length,
      pending: checks.filter((c) => c.status === "info").length,
    },
    ms: Date.now() - t0,
    checks,
  };
}

// ──────────────────────── 命令行 ────────────────────────

const isMain = process.argv[1] && /echo-doctor\.mjs$/.test(process.argv[1].replace(/\\/g, "/"));
if (isMain) {
  const fast = process.argv.includes("--fast");
  const report = runDoctor({ deep: !fast });
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const icon = { ok: "✓", warn: "!", error: "✗", info: "·" };
    console.log(`回声 Echo · 体检（${report.mode}）  ${report.at}   （总判 ${report.overall}，${report.counts.error} 错 / ${report.counts.warn} 警 / ${report.counts.ok} 好${report.counts.pending ? ` / ${report.counts.pending} 待深检` : ""}，用时 ${report.ms}ms）`);
    console.log("");
    for (const c of report.checks) console.log(`${icon[c.status]} ${c.label.padEnd(18, "　")} ${c.detail}`);
    const bad = report.checks.filter((c) => c.status === "error" || c.status === "warn");
    if (bad.length) {
      console.log("");
      console.log("证据：");
      for (const c of bad) console.log(`  [${c.id}] ${JSON.stringify(c.evidence)}`);
    }
  }
  // ★ 退出码只反映 **error**。
  //   原来 warn 也返回 1，实测撞出一处自相矛盾：同一个空书房里
  //   plan.mjs 说「全部就位」，doctor 却 exit 1 —— 而它的 5 个 warn 全是
  //   「还没有会话日志 / 没有心跳 / 没有换气」，那是**还没开始用**的正常状态。
  //   把正常标成失败，别人学到的第一课就是「这个退出码可以忽略」。
  //   ★ 这和 error/warn 的划分是同一条判据：还没建、还没跑、还没装，都不是故障。
  process.exit(report.overall === "error" ? 2 : 0);
}
