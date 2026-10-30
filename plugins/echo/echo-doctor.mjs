// echo-doctor.mjs —— 回声系统体检（回声 Echo · 自检器）v2
// ============================================================================
// 2026-10-08 04:22 要求：把回声做成独立面板，实时检测运行状态。
// 2026-10-08 04:42 追加：体检太慢，要仪表盘 + 四级轮询
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
// ★★ 2026-10-18 真机实测踩到：没配 ECHO_SOUL / ECHO_MEMORY 时 CFG.HUB 是 null，
//    而这几行在**模块加载阶段**就 path.join(null, ...) —— 直接 TypeError，
//    doctor 连一行 JSON 都吐不出来。面板只看到空输出，只能说「输出不是 JSON」。
//    ★ 而体检器的职责恰恰是「告诉人哪里没配好」—— 它必须先能开口。
//    所以：没有根目录就留 null，由下面的各项检查各自报「没配」，绝不在这里炸。
const safeJoin = (base, ...rest) => (base ? path.join(base, ...rest) : null);
const IDX = safeJoin(HUB, "index");
const MO = safeJoin(SOUL, "02-墨.jsonl");
const SELF_MD = safeJoin(HUB, "SELF.md");
const HEARTBEAT_DIR = safeJoin(HUB, "heartbeat");
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

/**
 * ★★★ 2026-10-23 修 C3 的下半截：**报错报了，但下一步给错了；而且这句话有两份。**
 *   上一轮已经把「MEM 传深一层」从静默降级改成明确报错（见 echo-config.mjs），
 *   可这里原来无论什么配置问题，结尾都写「先跑一次 agent_soul_scaffold」。
 *   于是用户在 `--memory .../memory/hub` 撞墙时，会照着这句话去重跑 scaffold ——
 *   而 scaffold 修不了「参数传错一层」，他修的是一个不存在的问题（实机报告 C3 的同一形状）。
 *   ★ 更要紧的是：**同一句话原来在 checkConfigState() 和 runDoctor() 的提前返回里各写一份**
 *     —— 改了一处、另一处还是旧的（本次实测就抓到了）。这正是这批 bug 的统一形状。
 *     所以收成一个函数：**下一步建议只有一份来源**。
 *   ★ 判据：配置问题的下一步分两类 ——
 *     ① 目录/文件真的没有 → scaffold 有用；② 参数形状不对 → 只能改参数，不能重跑。
 */
function configAdvice(problems) {
  const shape = problems.filter((p) => p.includes("传深了一层") || p.includes("下面没有 hub/"));
  return {
    pathShapeWrong: shape.length > 0,
    text: shape.length
      ? " —— 这不是「没装」，是**路径参数给错了**：按下面的提示改 --soul/--memory 或 echo.config.json，重跑 scaffold 不会修好它"
      : " —— 先跑一次 agent_soul_scaffold，它会把目录建出来",
  };
}

/** ★ 配置本身有没有到位 —— 这一项必须排在最前面。
 *  因为「装完了但还没配」是每个新人的第一步，那时候其余各项全是「读不到」，
 *  光看那些看不出根因。这一项直接说：先去跑 scaffold。 */
function checkConfigState() {
  const r = CFG.checkConfig({ allowMissingSessions: true })
  if (r.ok) {
    return {
      id: "config", label: "配置（三个根）", status: "ok",
      detail: `书房 ${CFG.SOUL} ｜ 中枢 ${CFG.MEM} ｜ 日志 ${CFG.SESSIONS || "（还没推出来）"}`,
      evidence: CFG.describe(),
    }
  }
  const advice = configAdvice(r.problems);
  return {
    id: "config", label: "配置（三个根）", status: "error",
    detail: "还没配好：" + r.problems.join("；") + advice.text,
    evidence: { problems: r.problems, hints: r.hints, pathShapeWrong: advice.pathShapeWrong },
  }
}

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

/**
 * ★ L0 时钟 —— 2026-10-23 合并进来的第 11 项。
 *
 * 为什么要有这一项：`state.json` 曾停更一个月，而原来的体检里**没有任何一项会报**
 * —— 一个「没人写」的状态文件看起来和「一切正常」一模一样。
 * 现在 `self.mjs` 每次装配写 `lastSelfAt` + `selfRuns` 递增，这一项读它：
 * **超过 26 小时没更新 = self.mjs 没在跑**。
 *
 * ★ 顺带纠正一个读法：`lastTurnAt` 的语义是「最后一条手写状态」，
 * **不是时钟**。它停在很久以前只能说明「很久没手写状态」，不能说明「系统停了」。
 */
function checkClock() {
  const STATE = path.join(HUB, "state.json");
  const raw = readText(STATE);
  if (!raw) return { id: "clock", label: "L0 时钟（state.json）", status: "warn", detail: "state.json 不存在 —— self.mjs 装配时会写它", evidence: {} };
  let st;
  try { st = JSON.parse(raw) } catch { return { id: "clock", label: "L0 时钟（state.json）", status: "error", detail: "state.json 解析失败", evidence: {} } }

  const selfAt = st.lastSelfAt ? new Date(String(st.lastSelfAt).replace(" ", "T")) : null;
  const selfAgeH = selfAt && !Number.isNaN(selfAt.getTime()) ? (Date.now() - selfAt.getTime()) / 3600000 : null;
  const noteAt = st.lastTurnAt ? new Date(st.lastTurnAt) : null;
  const noteAgeH = noteAt && !Number.isNaN(noteAt.getTime()) ? (Date.now() - noteAt.getTime()) / 3600000 : null;

  let status = "ok";
  const notes = [];
  if (selfAgeH === null) {
    // ★★★ 2026-10-23 修实机报告 R1 的观测面那一半：**「字段缺失」和「字段过期」要分开说。**
    //   这两种状态的下一步完全不同：
    //     · 缺字段  = 装配器这一层**还没启用 / 还没跑过**（新装、或推插件没装上）
    //     · 有过期  = 它**跑过，但停了**（这才是真异常）
    //   原来两句话都说「self.mjs 还没在修好的版本上跑过」，把「没启用」说成了「版本不对」，
    //   于是新用户会去查一段根本不存在的历史。★ 状态仍是 warn：没时钟确实要看一眼。
    status = "warn";
    notes.push("state.json 里没有 lastSelfAt —— 装配器（self.mjs）还没在这一层跑过：要么推送层没装，要么装上之后一次都没装配");
    notes.push("  （字段存在但很久没更新 = 真停更；字段整个没有 = 未启用。两者不是一个病）");
  } else if (selfAgeH > 26) {
    status = "warn";
    notes.push(`lastSelfAt 已 ${round1(selfAgeH)} 小时没更新 —— self.mjs 可能没在跑`);
  } else {
    notes.push(`self.mjs 最近一次装配 ${round1(selfAgeH)} 小时前`);
  }
  if (noteAgeH !== null) {
    const d = Math.round(noteAgeH / 24);
    notes.push(`最后一条手写状态 ${d} 天前（★ 这不是时钟，别当钟读）`);
  }

  return {
    id: "clock", label: "L0 时钟（state.json）", status,
    detail: notes.join("；"),
    evidence: {
      lastSelfAt: st.lastSelfAt || null, selfRuns: st.selfRuns || 0,
      lastTurnAt: st.lastTurnAt || null, lastNoteAt: st.lastNoteAt || null,
      selfAgeHours: selfAgeH === null ? null : round1(selfAgeH),
    },
  };
}

/**
 * ★ 部署一致性 —— 2026-10-23 加的第 14 项。
 *
 * 为什么要有这一项：同一个体检器曾存在**三份副本**（HUB 里真正跑的 / 仓库 kit / 仓库 plugins），
 * 各缺一半 —— HUB 里有 L0 时钟检查而仓库没有，仓库里有新的 SELF 判据而 HUB 没有。
 * 而**十项里没有任何一项会报**：三份看起来都「是那套东西」。
 *
 * 现在 `install-kit.mjs` 装的时候会写下 `.kit-origin.json`（来源目录 + 版本 + 每个文件大小），
 * 这一项读它去比。判据分三种，别混：
 *   ① 有记录、源仓库在 → 逐文件比大小，不一致就是真的旧了
 *   ② 有记录、源仓库不在（换机器了/只装了包）→ 只能确认「记过的那几个文件都在」
 *   ③ 没有记录 → **不知道它从哪来**，只能报「我没法判断」，不能报错
 */
function checkDeploy() {
  const ORIGIN = path.join(HUB, ".kit-origin.json");
  const L = "部署一致性（脚本 vs 仓库）";
  let origin = null;
  try { origin = JSON.parse(fs.readFileSync(ORIGIN, "utf8")) } catch { /* 按「没有」处理 */ }
  if (!origin || typeof origin !== "object") {
    return {
      id: "deploy", label: L, status: "warn",
      detail: "HUB 里没有 .kit-origin.json —— 不知道这套脚本从哪来，也就没法判断它是不是旧了。用 kit/echo/install-kit.mjs 装一次就会记下",
      evidence: { origin: ORIGIN },
    };
  }

  const files = (origin.files && typeof origin.files === "object") ? origin.files : {};
  const names = Object.keys(files);
  const missing = [];
  const differ = [];
  for (const n of names) {
    let st = null;
    try { st = fs.statSync(path.join(HUB, n)) } catch { /* 缺 */ }
    if (!st) { missing.push(n); continue }
    if (st.size !== files[n]) differ.push(`${n}（HUB ${st.size} B / 记录 ${files[n]} B）`);
  }

  const kitDir = String(origin.kitDir || "");
  let kitThere = false;
  if (kitDir) { try { kitThere = fs.statSync(kitDir).isDirectory() } catch { /* 不在 */ } }
  const kitDrift = [];
  if (kitThere) {
    for (const n of names) {
      let src = null;
      try { src = fs.statSync(path.join(kitDir, n)) } catch { kitDrift.push(`${n}（源里已没有）`); continue }
      let hubSize = null;
      try { hubSize = fs.statSync(path.join(HUB, n)).size } catch { continue }
      if (hubSize !== src.size) kitDrift.push(`${n}（源 ${src.size} B / HUB ${hubSize} B）`);
    }
  }

  const ev = {
    kitDir: kitDir || null, version: origin.version || null, copiedAt: origin.copiedAt || null,
    recorded: names.length, missing, differ, kitDrift, sourcePresent: kitThere,
  };
  if (missing.length) {
    return {
      id: "deploy", label: L, status: "error",
      detail: `装的时候记了 ${names.length} 个脚本，HUB 里缺 ${missing.length} 个：${missing.slice(0, 4).join("、")} —— 这套是残的，重跑 install-kit.mjs`,
      evidence: ev,
    };
  }
  if (kitDrift.length) {
    return {
      id: "deploy", label: L, status: "warn",
      detail: `仓库那边的脚本已经变了 ${kitDrift.length} 个：${kitDrift.slice(0, 3).join("；")} —— HUB 里跑的还是旧的，重跑 install-kit.mjs`,
      evidence: ev,
    };
  }
  if (differ.length) {
    return {
      id: "deploy", label: L, status: "warn",
      detail: `HUB 里有 ${differ.length} 个文件和安装记录对不上（可能被手改过）：${differ.slice(0, 3).join("；")}`,
      evidence: ev,
    };
  }
  if (!kitThere) {
    return {
      id: "deploy", label: L, status: "ok",
      detail: `${names.length} 个脚本齐全（源仓库不在这台机器上，只核对了完整性）；${String(origin.copiedAt || "?").slice(0, 16)} 装的`,
      evidence: ev,
    };
  }
  return {
    id: "deploy", label: L, status: "ok",
    detail: `${names.length} 个脚本与源目录一致（仓库版本 ${origin.version || "未知"}，${String(origin.copiedAt || "?").slice(0, 16)} 装的）`,
    evidence: ev,
  };
}

/**
 * ★★★ 2026-10-25 修「只看一份日志」（GitHub #1 里 aslarn 的**补正三**）。
 *
 * 原来 checkDoorSign / checkCompaction 都写 `logs.find((l) => l.bytes > 0)` ——
 * logs 按 mtime 倒序，于是这两项**永远只看最新那一份**。后果不是噪音，是判错：
 *   · 「最新那份刚好还没压缩」被读成「压缩坏了」
 *   · 他做的全量扫描是 **167 份 / 330303 事件 / 10131 条 compaction** —— 一条都没被看过
 *
 * ★ 现在从最新往前扫，**一命中就停**：常见情况还是只解一份，开销几乎不变；
 *   只有最近几份都没有时才多解。返回命中那一份的 events，供原有判据继续用。
 * ★ 不整份全扫（167 份 / 几百 MB）—— 面板每 3 分钟跑一次，不能那样解。
 */
const RECENT_LOGS = 5;
function scanRecent(logs, n, matcher) {
  const targets = logs.filter((l) => l.bytes > 0).slice(0, n);
  const per = [];
  for (const t of targets) {
    const d = decodeCached(t.file);          // 与门牌/压缩共用同一份缓存
    const hits = d.events.filter(matcher);
    per.push({ sid: String(t.sid).slice(0, 12), events: d.events.length, hits: hits.length });
    if (hits.length) {
      return { events: d.events, frames: d.frames, failed: d.failed, hits, hit: hits[hits.length - 1], target: t, per, scanned: per.length };
    }
  }
  return { events: [], frames: 0, failed: 0, hits: [], hit: null, target: targets[targets.length - 1] || null, per, scanned: per.length };
}

/**
 * ★★★ 2026-10-25 加（GitHub #1，aslarn 报）：识别「压缩由外部策略在代理层托管」。
 *
 * 病：门牌回取 / 压缩机制两项都从日志里数 `compaction/*` 事件。而 billion-context
 * 自带一个 gate（`bili-compaction-gate`），在自身 active 时把 DSH 内置压缩**整行禁用** ——
 * 于是这两个零件压根不跑，日志里一条 `compaction/*` 都没有，两项恒定 warn。
 * doctor 没有能力区分两件事：**压缩坏了**（有 start、没 summary）与**压缩不归内置管**（一条都没有）。
 *
 * ★ 为什么这个误报不只是看着烦（报告作者的原话，我认同）—— 它是一条诱导链：
 *   用户看到「压缩没有门牌」→ 以为缺能力 → 去装 dsh-agent-compaction →
 *   内置的被 bili 禁了、槽位是空的，于是它**直接注册成功** →
 *   复活了 bili 有意关掉的兜底引擎，两套上下文管理并存、无法归因。
 *
 * 判据顺序（显式配置优先于自动探测）：
 *   ① ECHO_EXTERNAL_COMPACTION / echo.config.json 的 externalCompaction：
 *      off → 不认（走旧行为）；auto 或空 → 自动探测；其它字符串 → 直接当托管者名
 *   ② 自动探测：<DSH_HOME>/profiles/<p>/package.json 的 dsh.profile.bundles 含 billion-context，
 *      且 <p>/node_modules/billion-context/dist/agent/dsh-compaction-gate.js 真的在盘上
 *
 * ★ 为什么只能做「文件级启发式」：doctor 是**子进程**，读不到 cordis 的 ctx.reflect。
 *   bili 其实把答案挂出来了（ctx.reflect.provide("biliBasicCompactionPolicy", …)），
 *   但那要宿主侧的探针去读、再落进日志 —— 那一步留作后续（GitHub #1 的方案 B）。
 */
function detectExternalCompaction() {
  const raw = String(CFG.EXTERNAL_COMPACTION || "").trim();
  const low = raw.toLowerCase();
  if (low === "off") return null;                       // 显式关掉探测
  if (raw && low !== "auto") return { owner: raw, via: "config" };

  const home = CFG.dshHome();
  if (!home) return null;
  const profRoot = path.join(home, "profiles");
  let profs = [];
  try { profs = fs.readdirSync(profRoot) } catch { return null }
  for (const p of profs) {
    const dir = path.join(profRoot, p);
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) } catch { continue }
    const bundles = j && j.dsh && j.dsh.profile && j.dsh.profile.bundles;
    if (!Array.isArray(bundles) || !bundles.includes("billion-context")) continue;
    const gate = path.join(dir, "node_modules", "billion-context", "dist", "agent", "dsh-compaction-gate.js");
    // ★ 只列在 bundles 里、没落盘 → 不算。否则「装过又删了」会永久骗过判据。
    if (!fs.existsSync(gate)) continue;
    return { owner: "billion-context", via: "auto", profile: p, gate };
  }
  return null;
}

/** ★ 深度项：门牌实测。deep=false 时返回 info，由调用方补上次深检结果。 */
function checkDoorSign(logs, deep) {
  const target0 = logs.find((l) => l.bytes > 0);
  if (!target0) return { id: "doorsign", label: "门牌回取（实测）", status: "warn", detail: "没有可测的日志", evidence: {}, deep: true };
  if (!deep) return { id: "doorsign", label: "门牌回取（实测）", status: "info", detail: "待深度检测…", evidence: { skipped: true }, deep: true };

  // ★ 2026-10-25（补正三）：不再只看最新那一份 —— 往前扫最多 RECENT_LOGS 份，命中即停。
  const scan = scanRecent(logs, RECENT_LOGS, (e) => e.type === "compaction/summary");
  const target = scan.target || target0;
  const { events, frames, failed } = scan;
  if (scan.scanned > 0 && scan.per.every((p) => p.events === 0)) {
    return {
      id: "doorsign", label: "门牌回取（实测）", status: "error",
      detail: `最近 ${scan.scanned} 份日志都解不出任何事件`,
      evidence: { files: scan.per, frames, failed }, deep: true,
    };
  }
  const summaries = scan.hits;
  if (summaries.length === 0) {
    // ★ 2026-10-25（GitHub #1）：零摘要有两种完全不同的原因，必须分开说。
    const ext = detectExternalCompaction();
    if (ext) {
      return {
        id: "doorsign", label: "门牌回取（实测）", status: "ok",
        detail: `压缩由 ${ext.owner} 在代理层托管，不走内置兜底 —— 门牌这一项不适用于这条链`,
        evidence: {
          events: events.length, external: ext,
          hint: "内置 compaction/* 被外部策略禁用，零摘要属预期。★ 不要为此去装 dsh-agent-compaction —— 那会复活外部策略有意关掉的兜底引擎。",
        }, deep: true,
      };
    }
    return { id: "doorsign", label: "门牌回取（实测）", status: "warn", detail: "这份日志里还没有压缩摘要，无可测门牌", evidence: { events: events.length }, deep: true };
  }
  const last = summaries[summaries.length - 1];

  // ★★★ 2026-10-23 修假阳性（实机报告 C2）。
  //   原实现：`const raw = JSON.stringify(last.data); /#seq=(\d+)/.exec(raw)` ——
  //   把**摘要正文**也算进去了。于是只要正文里提到过门牌格式（比如这个会话本身就在排查门牌，
  //   正文写着「首行必须是 log:session-<id>#seq=<n>」），就会命中、被判成"有门牌"。
  //   实测后果：hasMark=true 而实际是 1 块无门牌 —— 一个会误导人的假绿。
  //   ★ 现在改成**结构判断**：看块数 + 第 0 块的开头与长度，不看"全文是否出现过"。
  const blocks = Array.isArray(last.data && last.data.summary) ? last.data.summary : [];
  const head = (blocks[0] && typeof blocks[0].text === "string") ? blocks[0].text : "";
  const headTrim = head.trim();
  // 门牌块的两种合法开头：完整式（⛬ 压缩索引…）与降级式（直接 log:session-…）
  const looksLikeAnchor = /^>?\s*⛬/.test(headTrim) || /^>?\s*log:session-[0-9a-f-]+#seq=\d+/i.test(headTrim);
  // ★ 判据（2026-10-23 回归修正）：
  //   充分条件 = **第 0 块本身以门牌标记开头，且它是短行**。
  //   blocks.length 只作辅助证据，不作必要条件 ——
  //   降级式门牌（拿不到范围，只写会话号 + 检索入口）可能只有 1 块。
  //   而小深那条 seq=4322 是「1 块 + 正文 5764 字 + 以 ## 开头」，
  //   looksLikeAnchor 为 false，照样判无 —— 假阳性不复现。
  const structural = looksLikeAnchor && headTrim.length < 500;
  const m = structural ? /#seq=(\d+)/.exec(headTrim) : null;

  if (!structural) {
    return {
      id: "doorsign", label: "门牌回取（实测）", status: "error",
      detail: `最近一次压缩的摘要里没有门牌 —— 压缩发生了，但回取链断了（${blocks.length} 块${blocks.length === 1 ? "，门牌应在前面单独一块" : ""}）`,
      evidence: {
        summarySeq: last.seq, time: iso(last.time),
        blocks: blocks.length,
        headPreview: headTrim.replace(/\s+/g, " ").slice(0, 120),
        // ★ 保留这个字段但改名意：现在它是「正文里提到过门牌字样」，
        //   仅作排查线索，**不再参与判定**。
        mentionsMarkInBody: JSON.stringify(last.data || {}).includes(MARK),
        hint: "判据看结构：data.summary 应为 2 块、第 0 块是短门牌行。正文提到门牌字样不算。",
      }, deep: true,
    };
  }
  if (!m) {
    // 结构性合格但没有精确 seq —— 属于「降级式门牌」（拿不到范围时只写会话号 + 检索入口）。
    // 这是设计内的行为，不该报错，但要说清它没有精确坐标。
    return {
      id: "doorsign", label: "门牌回取（实测）", status: "ok",
      detail: `有门牌（${blocks.length} 块结构正确），但这一条没带精确 seq —— 压缩时拿不到范围，退化成会话号级指针`,
      evidence: { summarySeq: last.seq, time: iso(last.time), blocks: blocks.length, headPreview: headTrim.replace(/\s+/g, " ").slice(0, 160) },
      deep: true,
    };
  }
  const want = Number(m[1]);
  const hit = events.find((e) => e.seq === want);
  const sr = last.data?.shadowedRange;
  // ★★ 2026-10-23（C2 的收尾）：**「没有可核对的东西」不等于「核对不上」。**
  //   原判据 `srMatch = sr && ...` 在 sr 为空时得到 falsy，于是走 warn，
  //   提示「但与 shadowedRange 不符」—— 摘要根本没带 shadowedRange 也叫「不符」，
  //   又是一条永远响的警报（C2 的假阳性换个位置）。现在分三档：
  //     没有 shadowedRange → ok（只说明无法交叉核对）；有且一致 → ok；有但不一致 → warn。
  const srState = !sr ? "absent" : (Number(sr.start) === want ? "match" : "mismatch");
  const srNote = srState === "match" ? "，且与 shadowedRange 一致"
    : srState === "mismatch" ? `，但与 shadowedRange（start=${sr.start}）不符`
    : "（摘要没带 shadowedRange，无法交叉核对 —— 这不是错）";
  if (!hit) {
    return {
      id: "doorsign", label: "门牌回取（实测）", status: "error",
      detail: `门牌写着 seq=${want}，但在日志里取不到 —— 这就是「静默失效」的长相`,
      evidence: { summarySeq: last.seq, want, file: target.file, events: events.length, maxSeq: Math.max(...events.map((e) => e.seq || 0)) }, deep: true,
    };
  }
  return {
    id: "doorsign", label: "门牌回取（实测）", status: srState === "mismatch" ? "warn" : "ok",
    detail: `门牌 seq=${want} 真取到了（${hit.type}）${srNote}`,
    evidence: {
      summarySeq: last.seq, time: iso(last.time), want, gotType: hit.type,
      shadowedRange: sr || null, rangeState: srState, rangeMatches: srState === "match",
      summaryCount: summaries.length, events: events.length, frames, failed,
    },
    deep: true,
  };
}

/** ★ 深度项：压缩统计。与门牌共用同一个 decodeCached，不再各解一遍。 */
function checkCompaction(logs, deep) {
  const target0 = logs.find((l) => l.bytes > 0);
  if (!target0) return { id: "compaction", label: "压缩机制", status: "warn", detail: "没有可测的日志", evidence: {}, deep: true };
  if (!deep) return { id: "compaction", label: "压缩机制", status: "info", detail: "待深度检测…", evidence: { skipped: true }, deep: true };

  // ★ 2026-10-25（补正三）：从最新往前扫最多 RECENT_LOGS 份，用**含压缩事件的那一份**做统计。
  //   原来只看最新一份 ——「最新那份刚好还没压缩」会被读成「压缩坏了」。
  const scan = scanRecent(logs, RECENT_LOGS, (e) => typeof e.type === "string" && e.type.startsWith("compaction/"));
  const target = scan.target || target0;
  const { events } = scan;
  // ★ 他真正想问的是「最后一次压缩距今多久」—— 比「有没有」有信息量得多：
  //   「3 小时前刚压过」和「三天没压过」是两种完全不同的状态。
  const lastCompactionAt = scan.hit ? Number(scan.hit.time) : null;
  const compactionAgeH = lastCompactionAt ? round1(hoursSince(lastCompactionAt)) : null;
  const tally = {};
  for (const e of events) if (typeof e.type === "string" && e.type.startsWith("compaction/")) tally[e.type] = (tally[e.type] || 0) + 1;
  const start = tally["compaction/start"] || 0;
  const sum = tally["compaction/summary"] || 0;
  const end = tally["compaction/end"] || 0;
  const prune = tally["compaction/prune"] || 0;
  const errs = events.filter((e) => e.type === "compaction/end" && e.data && e.data.error);
  const ratio = start ? sum / start : 1;
  // ★ 2026-10-25（GitHub #1）：start === 0 有两种原因 —— 压缩坏了，还是压缩不归内置管。
  const ext = detectExternalCompaction();
  let status = "ok";
  let detail = `start ${start} / summary ${sum} / end ${end} / prune ${prune}${errs.length ? `；${errs.length} 次带 error` : ""}`;
  // ★ 「最后一次压缩距今多久」比「有没有」有信息量 —— 见上面那两行的注释。
  detail += compactionAgeH === null
    ? `；最近 ${scan.scanned} 份日志里没有压缩事件`
    : `；最后一次压缩 ${compactionAgeH} 小时前`;
  if (start === 0) {
    if (ext) {
      detail = `start 0 —— 压缩由 ${ext.owner} 在代理层托管，内置兜底未启用（预期）`;
    } else {
      status = "warn";
    }
  } else if (ratio < 0.9 || errs.length > 0) {
    status = "warn";
  }
  // ★ 反过来才是真问题：外部策略声明在管，内置却真的启动了 —— 两套并存。
  if (ext && start > 0) {
    status = "warn";
    detail += `；★ 外部策略（${ext.owner}）在跑，但内置也出现了 ${start} 次 start —— 两套压缩并存，值得看一眼`;
  }
  const lastEnd = [...events].reverse().find((e) => e.type === "compaction/end");
  return {
    id: "compaction", label: "压缩机制", status,
    detail,
    evidence: {
      tally, ratio: round1(ratio * 100) / 100,
      external: ext,
      // ★ 补正三：把「扫了几份、各自多少事件、最后一次多久」都摆出来，
      //   出问题时不用再猜它看的是哪一份。
      scannedLogs: scan.scanned, searchedRecent: scan.per,
      lastCompactionAt: lastCompactionAt ? iso(lastCompactionAt) : null,
      compactionAgeHours: compactionAgeH,
      errors: errs.slice(-3).map((e) => ({ seq: e.seq, error: e.data.error })),
      lastEndAt: lastEnd ? iso(lastEnd.time) : null,
    },
    deep: true,
  };
}

/**
 * ★ 深度项：门牌可回取 —— 摘要上那个指针，真的能打开吗。
 *
 * 起因（2026-10-23）：压缩在跑、摘要带门牌、seq 也对，但 `memq open` 崩在
 *   `Buffer.concat(chunks)` 上（解压后超过 Node 的字符串上限 0x1fffffe8）。
 *   **门牌是对的，门后面堵着。**
 *
 * ★ 判据不是「索引能建」也不是「摘要带门牌」—— 那两样当时都是好的，全都显示正常。
 *   判据是：**拿那个指针真的能打开**。
 *
 * ★ 为什么不在这项里真去 open 一次：本会话日志 217 MB，open 一次 30 秒，
 *   面板不能等。所以用**静态判据** —— 看解日志的那几个脚本有没有保护。
 *   两种形状是对的：
 *     ① 逐帧 + carry（memindex / memq）：全量解，内存里永远不出现巨串
 *     ② 尾部限定 + 总量封顶（本体检器自己的 decodeCached）：只要末端事件
 *   裸的 `Buffer.concat(全部).toString()` 什么都不防 → 日志一大必抛。
 *
 * ★ 本质上这是「同一个病有几份实现」的检测器：那天 memindex 修好了、memq 没修，
 *   而所有指标都显示正常 —— 因为**测的地方不是病灶出现的地方**。
 */
function checkAnchor(logs, deep) {
  const files = [];
  let es;
  try { es = fs.readdirSync(HUB) } catch {
    return { id: "anchor", label: "门牌可回取", status: "info", detail: "读不到 HUB 目录", evidence: {}, deep: true };
  }
  for (const n of es) {
    if (!/\.mjs$/.test(n)) continue;
    if (/_probe|\.bak|^_/.test(n)) continue;   // 坏样本/探针是故意留的
    let s;
    try { s = fs.readFileSync(path.join(HUB, n), "utf8") } catch { continue }
    if (!/zstdDecompressSync/.test(s)) continue;
    // ★ 必须有 Buffer.concat( 才算危险形状。
    //   2026-10-23 第一版判据只认 zstdDecompressSync，立刻误报了 session-store.mjs ——
    //   它只是在**注释里**提到了这个函数名，真实现是逐帧返回 {lines, frames, failed}。
    //   判据要落在「会不会拼出巨串」上，不是「提没提过这个 API」。
    if (!/Buffer\.concat\(/.test(s)) continue;
    const guarded = /carry/.test(s) || /MAX_TOTAL|MAX_LINE/.test(s);
    files.push({ name: n, guarded });
  }
  if (!files.length) {
    return { id: "anchor", label: "门牌可回取", status: "info", detail: "没扫到解日志的脚本", evidence: {}, deep: true };
  }
  const bad = files.filter((f) => !f.guarded).map((f) => f.name);
  const okList = files.filter((f) => f.guarded).map((f) => f.name);
  if (bad.length) {
    return {
      id: "anchor", label: "门牌可回取", status: "warn",
      detail: `${bad.join(" / ")} 解大日志会抛 ERR_STRING_TOO_LONG —— 门牌指向的原文打不开`,
      evidence: { bad, ok: okList, how: "要么逐帧+carry，要么加总量封顶" },
      deep: true,
    };
  }
  let lastSeq = null;
  if (deep) {
    const target = logs.find((l) => l.bytes > 0);
    if (target) {
      try {
        const { events } = decodeCached(target.file);
        const sum = [...events].reverse().find((e) => e.type === "compaction/summary");
        if (sum && sum.seq !== undefined) lastSeq = String(sum.seq);
      } catch { /* 解不开就是别的项的问题 */ }
    }
  }
  return {
    id: "anchor", label: "门牌可回取", status: "ok",
    detail: `${files.length} 个解日志的脚本都有保护（${okList.join(" / ")}）${lastSeq ? `；最近门牌 seq=${lastSeq}` : ""}`,
    evidence: { ok: okList, lastSeq },
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
 *   ★ 2026-10-19：空回合这一条已经并进换气（judge ④），不再需要 dsh-stalled-turn-continue。
 *   那个独立插件会另记一套 maxConsecutive，两边都续就是一轮变两轮。
 */
function checkHuanqi(logs, deep) {
  if (!deep) return { id: "huanqi", label: "换气（思考预算）", status: "info", detail: "待深度检测…", evidence: { skipped: true }, deep: true };
  const targets = logs.filter((l) => l.bytes > 0).slice(0, 8);
  if (!targets.length) return { id: "huanqi", label: "换气（思考预算）", status: "warn", detail: "没有可测的日志", evidence: {}, deep: true };

  const MIN_REASONING = 2048; // = 换气默认 minReasoningChars

  // ★★★ 2026-10-25 修假 warn（GitHub #3，aslarn 报）：
  //   这一项原来去 `turn/end.data.reason.kind` 里找 /repetitive|loop|no-visible/ ——
  //   而**换气的介入从来不写在那里**。它改的是同一轮内部的流程
  //   （continue 续写 / circuitBreak 熔断），从不会给 turn/end 造一个新的 reason kind。
  //   实测这版 DSH 的 kind 只有 completed / aborted / error 三种，所以 everBroke **恒为 false** ——
  //   只要「有病症」就永久 warn。
  //   ★ 最坏的不是噪音：这一项存在的全部意义是发现「该响的没响」，
  //     而现在它无论响没响都报同一句 —— 等于这一项**没在检查它声称要检查的东西**。
  //   ★ 判据换成换气自己的账本：continuations / circuitBreaks / anomalies。
  //     （状态文件在 <DSH_HOME>/state/dsh-huanqi.json，由 SESSIONS 反推；
  //       没装换气或从没跑过 → 读不到 → hqFired 0 → 行为与旧版完全一致。）
  // ★ 找换气的账本。三个候选按可靠度排序，而且**逐个试读**——
  //   只看路径存不存在不够：路径在、文件坏了的情况会让后面的读取全部抛错。
  //   判据是「能解析出 stats」，不是「这个名字存在」。
  const HQ_STATE = (() => {
    const cands = [
      process.env.DSH_HOME ? path.join(process.env.DSH_HOME, "state", "dsh-huanqi.json") : null,
      SESSIONS ? path.join(path.dirname(SESSIONS), "state", "dsh-huanqi.json") : null,
      path.join(process.cwd(), "dsh-huanqi.json"),
    ].filter(Boolean)
    for (const f of cands) {
      try { if ((JSON.parse(fs.readFileSync(f, "utf8")) || {}).stats) return f } catch { /* 读不到就试下一个 */ }
    }
    return cands[0] || null
  })()
  /* ★★★ 2026-10-25 修假 warn（本机实测，接 GitHub #3 那条之后）：
   *
   * `dsh-huanqi.json` 是**额度账本**，只在出事的 5 个分支里 `save()` ——
   * 正常轮一个字节都不写。所以「账本不存在」不是「没跑」，是「还没出过事」。
   * 原判据是「账本读不到 ⇒ hqFired 0 ⇒ 有病症就 warn」，
   * 于是**装好了、在跑、一切正常**的机器会永久报黄，
   * 而且那句 note 还暗示是它没响 —— 又一条「只会报绿的体检」的反面：
   * 这次是**只会报黄**。
   *
   * 更坏的一层：`hasSymptom` 来自**历史日志**。本机实测那 3 条样本
   * （seq 6119 / 6128 / 6149）发生在换气装好**之前** ——
   * 等于拿它出生前的病历判它失职。
   *
   * ⇒ 加一条运行证据：`huanqi-turns.jsonl` 是它**每轮都写**的观察日志
   *   （`{"t","sid","kind","shape","hadOutput","credit","verdict","diag"}`）。
   *   文件新鲜 = 它真的在看回合（只有看见了才写）。
   *   **在跑且账本零介入 ⇒ 正常**。
   *   ★ 这条判据自洽：如果它「在跑但监听不到 agent」，观察日志就不会有新条目，
   *     fresh 变 false，自动退回旧判据去 warn。
   */
  let hqRuntime = null;
  if (HQ_STATE) {
    const turnsPath = path.join(path.dirname(HQ_STATE), "huanqi-turns.jsonl");
    const txt = readText(turnsPath);
    if (txt !== null) {
      let n = 0, lastMs = 0;
      const verdicts = {};
      for (const line of txt.split("\n")) {
        const s = line.trim();
        if (!s) continue;
        let r;
        try { r = JSON.parse(s) } catch { continue }
        n++;
        const ms = Date.parse(r.t);
        if (Number.isFinite(ms) && ms > lastMs) lastMs = ms;
        const k = String(r.verdict || "?").split(":")[0];
        verdicts[k] = (verdicts[k] || 0) + 1;
      }
      hqRuntime = {
        file: turnsPath, turns: n,
        lastAt: lastMs > 0 ? iso(lastMs) : null,
        verdicts,
        fresh: lastMs > 0 && Date.now() - lastMs < 24 * 3600 * 1000,
      };
    }
  }
  const hqRunning = !!(hqRuntime && hqRuntime.fresh);
  let hqStats = null;
  if (HQ_STATE) {
    try { hqStats = (JSON.parse(fs.readFileSync(HQ_STATE, "utf8")) || {}).stats || null; } catch {}
  }
  const hqFired = hqStats
    ? Number(hqStats.continuations || 0) + Number(hqStats.circuitBreaks || 0) + Number(hqStats.anomalies || 0)
    : 0;
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
  // ★ 保留 turn/end 的 kind 扫描（它仍是证据），但**不再单独当判据** ——
  //   见上面那段注释：这个值域里根本没有 repetitive/loop/no-visible。
  const everBroke = Object.keys(reasons).some((k) => /repetitive|loop|no-visible/i.test(k));
  const fired = everBroke || hqFired > 0;
  let status = "ok";
  let note = "";
  if (hqRunning) {
    // ★ 它在写观察日志 ⇒ 真的看见了回合。零介入只说明**没出过事**。
    const st = hqStats || {};
    note = (hqFired > 0 || everBroke)
      ? `；在跑，已见过介入痕迹（continuations ${st.continuations || 0} / circuitBreaks ${st.circuitBreaks || 0} / anomalies ${st.anomalies || 0}）`
      : `；在跑（已观察 ${hqRuntime.turns} 轮，最近 ${hqRuntime.lastAt}），零介入 —— 上面的病症样本多半发生在它装上之前`;
  } else if (hasSymptom && !fired) {
    status = "warn";
    note = hqStats
      ? "；该介入的回合存在，但日志里零介入痕迹"
      : "；该介入的回合存在，但换气既没有观察日志、也没有账本 —— 大概是没装，或者装上了没监听";
  } else if (hasSymptom && hqFired > 0) {
    note = `；已见过介入痕迹（continuations ${hqStats.continuations || 0} / circuitBreaks ${hqStats.circuitBreaks || 0} / anomalies ${hqStats.anomalies || 0}）`;
  } else if (hasSymptom && everBroke) {
    note = "；已见过介入痕迹";
  }

  return {
    id: "huanqi", label: "换气（思考预算）", status,
    detail: `无输出回合 ${noReply}/${total}（推理 ≥${MIN_REASONING} 的 ${overThreshold} 条）${note}`,
    evidence: {
      logsSampled: targets.length, assistantMessages: total, noVisibleOutput: noReply,
      overReasoningThreshold: overThreshold, minReasoningChars: MIN_REASONING,
      turnEndReasons: reasons, samples,
      // ★ 2026-10-25（GitHub #3）：判据来自换气自己的账本，不再从 turn/end 猜。
      huanqiStateFile: HQ_STATE,
      huanqiStats: hqStats,
      huanqiFired: hqFired,
      huanqiRuntime: hqRuntime,
      huanqiRunning: hqRunning,
      crossCheck: "换气自己覆盖四种退化（含空回合）；不再需要 dsh-stalled-turn-continue —— 两套账会让一轮被续成两轮",
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
  let injectInfo = null // 深检时记下「证据长什么样」，好让报错能指到具体位置
  if (deep) {
    const targetLog = logs.find((l) => l.bytes > 0)
    if (targetLog) {
      try {
        const { events } = decodeCached(targetLog.file)
        // ★ P1-7（外部验证报告，2026-10-22）：原来这里认的是字符串 "SELF.md"。
        //   可 agent_soul_scaffold 的工具描述里就写着 "SELF 模板"、"SELF.md" ——
        //   也就是说**只要插件装上了**，日志里就必然出现这个字符串，判据恒为真。
        //   一个永远通过的自检，比没有自检更坏：它会告诉你「装好了」。
        //   改成认 SELF.md **正文里才有的**词 —— 工具描述不会写「四条硬线」。
        //
        // ★★★ 2026-10-23 再修（实机报告 D1）：上面这版还有第二个假阳性 ——
        //   它把整个日志拼成一个大字符串再 includes，于是**早期那一次**
        //   「SELF.md 读不到」会永远压住后面成功的注入。
        //   实测：用户把路径修好之后 SELF 每轮都注入（GUI 里看得到），
        //   体检却一直报「读不到」—— 抓的是几小时前的旧错误。
        //   改成**按事件顺序扫、后出现者优先**：最后一次说什么就信什么。
        //
        // ★★★ 2026-10-23 三修（本轮实测，决定性证据）：上面那版**仍然是错的** ——
        //   「后出现者优先」找证据用的还是**内容字符串**，而日志里既记录系统事件、
        //   也记录**人对系统的讨论**。本机实测，同一状态、间隔 97 秒，
        //   中间只做了一件事：读 echo-doctor 源码 ——
        //     14:08:35  ✓「最近的注入里读到了」
        //     14:10:12  ✗「最近一轮注入时读不到」
        //   因为那段源码里同时含这两个字串，那次 tool/call 就被记成了 bad。
        //   更坏的是**自锁死**：这条检查一旦报错，错误文本本身就进了日志，
        //   下一轮读日志又看见它 → 永远报错，路径修好了也不会消失。
        //
        //   ★ 正确形状：**注入的证据只能从注入通道里取，不能从整个日志里取。**
        //   真实结构（本机 seq=115626 实测，推送插件注入的那条）：
        //     type=user/message
        //     data.source = { kind:"runtime-context", form:"snapshot",
        //                     sections:[ {name:"dsh-image-gen:canvas", …},
        //                                {name:"yanqing:self", text:"【此刻】…\n\n# SELF · 定长自我层…"},
        //                                {name:"yanqing:door-sign", …}, … ] }
        //   所以判据 = 最后一条 runtime-context 快照里，有没有一节真装着 SELF 正文。
        //   这一改同时也是**把「人说的话」彻底排除在证据之外** —— 它们根本不在 sections 里。
        const SELF_MARK = /#\s*SELF\s*[·・\-—]|##\s*我是谁|四条硬线/;
        let lastSnap = null;
        for (const e of events) {
          if (e?.type !== "user/message") continue;
          const src = e?.data?.source;
          if (src?.kind !== "runtime-context") continue;
          lastSnap = { seq: e.seq, time: e.time, sections: Array.isArray(src.sections) ? src.sections : [] };
        }
        if (lastSnap) {
          const strs = lastSnap.sections.filter((s) => s && typeof s.text === "string");
          // ① 先按节名认（推送插件注册的 context 名，本机是 yanqing:self）；
          // ② 认不到再按正文标记认 —— 节名可改，正文骨架不会改。
          const hit =
            strs.find((s) => /self/i.test(String(s.name || "")) && s.text.length > 200) ||
            strs.find((s) => SELF_MARK.test(s.text));
          if (hit) {
            injected = true;
            injectInfo = { seq: lastSnap.seq, section: hit.name || null, chars: hit.text.length, at: lastSnap.time };
          } else {
            injected = false;
            injectInfo = { seq: lastSnap.seq, sections: strs.map((s) => s.name || "(无名节)"), at: lastSnap.time };
          }
        }
        // 连 runtime-context 快照都没有 → injected 保持 null：没有证据就不下结论，别猜。
      } catch { /* 解不出来就不下结论，别猜 */ }
    }
  }
  if (injected === false) {
    // ★★★ 2026-10-23 四修：这里**不许报 error** —— 因为「日志里没有」不等于「没注入」。
    //
    //   两条推送通道，只有一条落日志：
    //     ① runtime-context 快照的 sections[]  —— 落日志（装了 dsh-agent-memory / dsh-yanqing-memory 时走这条）
    //     ② ctx.systemPrompt.context()          —— **不落日志**
    //        （agent-soul 自带的 plugins/memory 就是走这条：name: 'agent:self'）
    //   实测依据：本会话日志里 system/message 0 条、request/header 只有
    //   provider/model/tools、40 种事件类型里没有任何 systemPrompt 正文。
    //
    //   所以「没找到 SELF 节」有两种可能：真没注入，或走了 systemPrompt 通道。
    //   判据只能**证有不证无** —— 找到就是确定注入了；找不到只能说「看不到」。
    //   ★ 报 error 的代价是假红：会让人去修一个不存在的故障（就是小深那台 C1/C3 的形状）。
    const names = injectInfo?.sections?.length ? injectInfo.sections.join(" / ") : "（空）";
    return {
      id: "self", label: "推送层 SELF", status: "warn",
      detail: `SELF.md 在磁盘上（${st.size} B），但最近一轮 runtime context 快照（seq=${injectInfo?.seq ?? "?"}）里没有 SELF 正文 —— 那一轮注入了这些节：${names}。`
        + `★ 这不一定是故障：如果推送插件走的是 ctx.systemPrompt.context()（agent-soul 自带的 dsh-agent-memory 就是这样），它不进日志，体检看不到。`
        + `自己确认一条就够：GUI 里这一轮 agent 到底读不读得到 SELF。读得到 → 虚警；读不到 → 查推送插件的 selfPath / maxBytes。`,
      evidence: { bytes: st.size, path: SELF_MD, injected: false, snapshot: injectInfo },
    }
  }

  let status = "ok";
  if (h > 72) status = "error"; else if (h > 24) status = "warn";
  if (pct !== null && pct > 95 && status === "ok") status = "warn";
  return {
    id: "self", label: "推送层 SELF", status,
    detail: `${st.size} B${pct !== null ? `（预算 ${pct}%）` : ""}，装配于 ${iso(st.mtime)}（${round1(h)} 小时前）`
      + (injected === true
        ? `，最近的注入里读到了（节 ${injectInfo?.section ?? "?"}，${injectInfo?.chars ?? "?"} 字，快照 seq=${injectInfo?.seq ?? "?"}）`
        : ""),
    evidence: { bytes: st.size, usedPct: pct, ageHours: round1(h), injected, snapshot: injectInfo },
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
      detail: "没有心跳目录 —— 这一层可选，且**本仓库不提供**心跳零件（要自己建定时任务）。没装是正常的",
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
  // ★ 文件不存在（bytes === null）不是"健康"，是"还没建" —— 降 warn。
  //   以前这里直接跳过，于是两项都没建时 worst 是 undefined，status 停在 ok。
  if (items.some((i) => i.bytes === null)) status = "warn";
  else if (worst && worst.pct >= 90) status = "warn";
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
  // ★ 扫到 0 个脚本时报 ok 是空绿：那不是「没问题」，是「没检查」。
  //   2026-10-18 沙箱里就撞上了 —— HUB 指到打包目录，那里没有 .mjs，于是这项永远绿。
  const status = hits.length ? "error" : (files.length === 0 ? "warn" : "ok")
  const detail = hits.length
    ? `★ 还有 ${hits.length} 处把日志名写死成字面量 —— 宿主下次升版会重演静默失效`
    : files.length === 0
      ? `一个脚本都没扫到 —— HUB 指的地方没有 .mjs，这项等于没检查（不是「没问题」）`
      : `扫了 ${files.length} 个脚本，没有写死版本号的字面量（全部版本无感）`
  return {
    id: "drift", label: "版本漂移扫描", status, detail,
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
  // ★ 一条 lead 都没有 = 还没建立署名人，不是"判据通过"。降 warn。
  const identityStatus = leads.length === 0 ? "warn" : "ok";
  return {
    id: "identity", label: "身份判据（换容器/换届）", status: identityStatus,
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

  // ★★★ 没配好就只报这一项，不往下跑。
  //   2026-10-18 真机实测：新人装完之后第一个看到的就是这个状态 ——
  //   而旧代码在这里 path.join(null, ...) 直接 TypeError，doctor 一行 JSON 都吐不出来。
  //   面板只能说「输出不是 JSON」，于是真正的病因（「还没配」）被埋在三层之下。
  //   ★ 体检器必须是最后崩的那个 —— 它崩了，就没人能告诉人哪里坏了。
  const cfg = CFG.checkConfig({ allowMissingSessions: true });
  if (!cfg.ok) {
    // ★ 下一步建议走 configAdvice() —— 和 checkConfigState 同一份（C3；别在这里再抄一句）
    const advice = configAdvice(cfg.problems);
    return {
      at: iso(Date.now()), mode: deep ? "deep" : "fast", overall: "error",
      counts: { error: 1, warn: 0, ok: 0, pending: 0 }, ms: Date.now() - t0,
      checks: [{
        id: "config", label: "配置（三个根）", status: "error",
        detail: "还没配好：" + cfg.problems.join("；") + advice.text,
        evidence: { problems: cfg.problems, hints: cfg.hints, pathShapeWrong: advice.pathShapeWrong, describe: CFG.describe() },
      }],
    };
  }

  const logs = listLogs();
  const checks = [
    checkConfigState(),
    checkLogs(logs),
    checkClock(),
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
    checkDeploy(),
    checkAnchor(logs, deep),
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
