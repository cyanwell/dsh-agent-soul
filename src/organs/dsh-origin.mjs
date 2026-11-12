// 心跳地址自动发现 —— 「到哪问心跳」，**不是**「谁是 lead」。
//
// ★★ 这个文件只回答一个问题：GET /heartbeat/auto 该发到哪个 origin。
//   「谁是当前 lead」仍然只由心跳接口回答（organs/lead-target.mjs 解析它的响应）。
//   把两件事混在一起 = 第二套主脑规则；这里**一行 lead 判定都不写**。
//
// ★ 为什么要自动发现：DSH 的 webServer 端口每次重启都变
//   （本机实测 59174 → 57099 → 56207 → 49394）。「显式配一个端口」在重启那天必然失效，
//   而它失效的样子是**静默不动**（自主不投、清理解析不出目标）—— 不报错，最难查。
//   所以生产默认改成：显式配置优先；没配就从本机最新 DSH 启动记录里读出 origin。
//
// ★ 三级来源（严格按优先级，不猜）：
//   ① integrations.heartbeatUrl / dshBaseUrl —— 人显式配的，**最高优先**：配了就一次日志都不读；
//   ② 最新 DSH 启动日志（<DSH_HOME>/guard/logs/server-*.out.log，按 mtime 取最新那一个；
//      它是空文件 = 这次启动还没准备好，**不回头读旧的**）；
//   ③ 心跳插件自己写下的 dsh-origin.txt（dsh-yanqing-heartbeat/index.js 启动时写，内容是它自己的 origin）。
//   ★ ②③ 都是「同一种记录」：谁最后写谁代表最近一次启动，所以按 mtime 取最新**有效**记录。
//     ②是按验收要求的主路径；③是补充 —— 本机实测 DSH 未必由那个写日志的脚本启动
//     （当前实例就不写 server-*.out.log），只认②会让这个功能在这台机器上永远发现不到。
//
// ★ 只认 http://127.0.0.1:<port> 这一种形状：
//   · 只取 origin，**URL 后面的 ?query / #hash 当场丢弃** —— DSH 的启动行里就带着 launch token，
//     它不许进内存状态、日志、错误串、面板，更不许落盘（本文件没有一行写盘代码）；
//   · https / localhost / 0.0.0.0 / 别的 host 一律不认：本机回环之外不是「我们的 DSH」。
//
// ★ fail-closed 的三种情形（都回 ok:false，调用方按「不动」处理）：
//   ① 没有可读来源；② 有来源但解析不出 origin；③ 两个来源在新鲜窗内都写过、却互相矛盾。
//
// ★ 不缓存：每次调用都重新看一遍目录与文件的 mtime。
//   「端口变了」和「端口没变」在缓存里长得一样 —— 缓存旧端口正是要消灭的那个故障。

import fs from 'node:fs';
import path from 'node:path';
import { devPathOr, devFileOr, isDirPath, resolvePath } from '../config.mjs';
import { heartbeatUrlOf, joinUrl } from '../web/runtime-status.mjs';

/** 地址从哪来。★ 写进状态/日志，事后才分得清「人配的」还是「自己发现的」。 */
export const ENDPOINT_SOURCE = Object.freeze({
  CONFIGURED: 'configured',        // integrations.heartbeatUrl / dshBaseUrl
  LOG: 'dsh-log',                  // <DSH_HOME>/guard/logs/server-*.out.log
  ORIGIN_FILE: 'dsh-origin-file',  // dsh-yanqing-heartbeat/dsh-origin.txt
  NONE: 'none',                    // 发现不到（fail-closed）
});

/** 两个来源都这么新却互相矛盾 → 不替你选（毫秒）。 */
export const FRESH_WINDOW_MS = 5 * 60 * 1000;
/** 单次最多读多少字节（日志可能很大；origin 一定在开头附近或末尾）。 */
const MAX_READ_BYTES = 2 * 1024 * 1024;
const LOG_NAME_RE = /^server-.*\.out\.log$/i;
// ★ 这一条正则**只捕获 port**，查询串根本不进捕获组 —— 「立即丢弃」在这里是结构性的，不靠后续清洗。
const ORIGIN_RE = /http:\/\/127\.0\.0\.1:(\d{1,5})(?=[\/?#"'`\s<>]|$)/g;
const STRICT_ORIGIN_RE = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/;

function validPort(n) { return Number.isInteger(n) && n >= 1 && n <= 65535; }

/** 一段文本里出现的所有合法 origin（去重）。★ 返回的字符串里不可能有查询串。 */
export function parseOriginsOfText(text) {
  const s = typeof text === 'string' ? text : '';
  const set = new Set();
  let hits = 0;
  ORIGIN_RE.lastIndex = 0;
  let m;
  while ((m = ORIGIN_RE.exec(s)) !== null) {
    const port = Number(m[1]);
    if (!validPort(port)) continue;
    hits++;
    set.add('http://127.0.0.1:' + port);
  }
  return { origins: [...set], hits };
}

/** 一条 URL 的 origin（丢路径/查询/片段）。★ 只用于**我们自己拼出来的**地址，不用于回显用户输入。 */
export function originOfUrl(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin && u.origin !== 'null' ? u.origin : null;
  } catch { return null; }
}

function readTextBounded(file, size) {
  if (size <= MAX_READ_BYTES) return fs.readFileSync(file, 'utf8');
  const half = Math.floor(MAX_READ_BYTES / 2);
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(half);
    const hn = fs.readSync(fd, head, 0, half, 0);
    const tail = Buffer.alloc(half);
    const tn = fs.readSync(fd, tail, 0, half, Math.max(0, size - half));
    return head.subarray(0, hn).toString('utf8') + '\n' + tail.subarray(0, tn).toString('utf8');
  } finally { try { fs.closeSync(fd); } catch { /* 关不掉也不影响结论 */ } }
}

/** UTF-16 的日志（Tee-Object 的产物）在 utf8 下全是 NUL —— 认出来并说清楚，别假装「没有 origin」。 */
function looksBinary(text) {
  const n = Math.min(text.length, 4096);
  if (!n) return false;
  let nul = 0;
  for (let i = 0; i < n; i++) if (text.charCodeAt(i) === 0) nul++;
  return nul > n / 100;
}

/**
 * 读**最新一份** DSH 启动日志，返回一条记录。
 * ★ present=false 表示「这个来源根本不存在」（没有目录/没有日志）；
 *   present=true 而 ok=false 表示「有这个来源，但它说的不是有效 origin」——
 *   两者必须分开：前者可以去问下一个来源，后者说明「最近这次启动还没准备好」。
 */
export function readDshLogRecord(logDir) {
  const dir = String(logDir == null ? '' : logDir).trim();
  if (!dir) return { present: false, ok: false, file: null, atMs: null, origin: null, why: '没有 DSH 启动日志目录（integrations.dshLogDir 未配置，本机默认位置也不存在）' };
  let names;
  try { names = fs.readdirSync(dir); }
  catch { return { present: false, ok: false, file: null, atMs: null, origin: null, why: '读不到 DSH 启动日志目录：' + dir }; }

  const files = [];
  for (const n of names) {
    if (!LOG_NAME_RE.test(n)) continue;
    try {
      const st = fs.statSync(path.join(dir, n));
      if (st.isFile()) files.push({ name: n, file: path.join(dir, n), size: st.size, atMs: st.mtimeMs });
    } catch { /* 单个文件 stat 失败不影响别的 */ }
  }
  if (!files.length) return { present: false, ok: false, file: null, atMs: null, origin: null, why: '日志目录里没有 server-*.out.log：' + dir };
  files.sort((a, b) => b.atMs - a.atMs);
  // ★ 只看**最新那一个**文件：它空着（^C / 刚被创建）就算「这一次启动没准备好」，
  //   不许回头去读更老的那份 —— 那正是重启时把旧端口捞回来的路。
  const newest = files[0];
  if (!newest.size) {
    return { present: true, ok: false, file: newest.name, atMs: newest.atMs, origin: null,
      why: '最新的 server-*.out.log 是空文件（上次启动可能被 Ctrl+C 打断）—— 认不出 origin' };
  }

  let text = '';
  try { text = readTextBounded(newest.file, newest.size); }
  catch { return { present: true, ok: false, file: newest.name, atMs: newest.atMs, origin: null, why: '最新启动日志读不开：' + newest.name }; }
  if (looksBinary(text)) {
    return { present: true, ok: false, file: newest.name, atMs: newest.atMs, origin: null,
      why: '最新启动日志不是 UTF-8 文本（UTF-16 的日志读不出 origin）：' + newest.name };
  }

  const p = parseOriginsOfText(text);
  if (!p.origins.length) {
    return { present: true, ok: false, file: newest.name, atMs: newest.atMs, origin: null,
      why: '最新启动日志里还没有 http://127.0.0.1:<port> 形式的 origin（DSH 可能还在启动）：' + newest.name };
  }
  if (p.origins.length > 1) {
    return { present: true, ok: false, file: newest.name, atMs: newest.atMs, origin: null,
      why: '最新启动日志里有 ' + p.origins.length + ' 个不同的 origin（' + p.origins.join(' / ') + '）—— 多源不一致，fail-closed' };
  }
  return { present: true, ok: true, file: newest.name, atMs: newest.atMs, origin: p.origins[0], why: null };
}

/** 读心跳插件写的 dsh-origin.txt（内容必须**整行就是一个 origin**）。 */
export function readOriginFileRecord(file) {
  const f = String(file == null ? '' : file).trim();
  if (!f) return { present: false, ok: false, file: null, atMs: null, origin: null, why: '没有 dsh-origin.txt 的路径（integrations.dshOriginFile 未配置，本机默认位置也不存在）' };
  let st;
  try { st = fs.statSync(f); }
  catch { return { present: false, ok: false, file: null, atMs: null, origin: null, why: '没有 dsh-origin.txt（心跳插件还没写过一次）：' + f }; }
  let raw = '';
  try { raw = fs.readFileSync(f, 'utf8'); }
  catch { return { present: true, ok: false, file: path.basename(f), atMs: st.mtimeMs, origin: null, why: 'dsh-origin.txt 读不开' }; }

  const m = STRICT_ORIGIN_RE.exec(String(raw).trim());
  const port = m ? Number(m[1]) : NaN;
  if (!m || !validPort(port)) {
    // ★ 不回显内容：这一行如果真的被写成带 token 的 URL，回显就等于把 token 打进错误串。
    return { present: true, ok: false, file: path.basename(f), atMs: st.mtimeMs, origin: null,
      why: 'dsh-origin.txt 的内容不是 http://127.0.0.1:<port> 形式的 origin（内容不回显）' };
  }
  return { present: true, ok: true, file: path.basename(f), atMs: st.mtimeMs, origin: 'http://127.0.0.1:' + port, why: null };
}

/** 日志目录：显式配置 > 环境变量 DSH_HOME > 开发机默认（**目录存在才用**）。 */
export function dshLogDirOf(cfg) {
  const it = (cfg && cfg.integrations) || {};
  const own = String(it.dshLogDir == null ? '' : it.dshLogDir).trim();
  if (own) return resolvePath(own);
  const envHome = String(process.env.DSH_HOME || '').trim();
  if (envHome) {
    const d = path.join(envHome, 'guard', 'logs');
    if (isDirPath(d)) return d;
  }
  const devHome = devPathOr('dshHome', null);
  if (devHome) {
    const d = path.join(devHome, 'guard', 'logs');
    if (isDirPath(d)) return d;
  }
  return null;
}

/** 心跳插件的 origin 文件：显式配置 > 开发机默认（**文件存在才用**）。 */
export function dshOriginFileOf(cfg) {
  const it = (cfg && cfg.integrations) || {};
  const own = String(it.dshOriginFile == null ? '' : it.dshOriginFile).trim();
  if (own) return resolvePath(own);
  return devFileOr('dshOriginFile', null);
}

/**
 * 发现当前 DSH 的 origin。**没有网络**，只读元数据与文本。
 *
 * @param {{logDir?:string|null, originFile?:string|null, now?:number}} opts
 * @returns {{ok:boolean, source:string, origin:string|null, file:string|null, atMs:number|null,
 *            why:string|null, records:Array}}
 */
export function discoverDshOrigin(opts) {
  const o = opts || {};
  const nowMs = Number.isFinite(o.now) ? o.now : Date.now();

  const logRec = readDshLogRecord(o.logDir);
  const fileRec = readOriginFileRecord(o.originFile);
  const recs = [];
  if (logRec.present) recs.push({ ...logRec, source: ENDPOINT_SOURCE.LOG });
  if (fileRec.present) recs.push({ ...fileRec, source: ENDPOINT_SOURCE.ORIGIN_FILE });

  const records = recs.map((r) => ({ source: r.source, file: r.file, atMs: r.atMs, ok: r.ok, origin: r.origin || null }));
  const fail = (why, extra) => ({ ok: false, source: ENDPOINT_SOURCE.NONE, origin: null, file: null, atMs: null, why, records, ...(extra || {}) });

  if (!recs.length) {
    const why = [logRec.why, fileRec.why].filter(Boolean).join('；');
    return fail(why || '没有可读的 DSH 启动记录（启动日志目录与 dsh-origin.txt 都不存在）');
  }
  recs.sort((a, b) => (Number(b.atMs) || 0) - (Number(a.atMs) || 0));

  const newest = recs[0];
  const newestValid = newest.ok === true && !!newest.origin;
  const newestFresh = Number.isFinite(newest.atMs) && (nowMs - newest.atMs) <= FRESH_WINDOW_MS;

  if (!newestValid) {
    // 最新的记录自己没给出 origin：**它够新**就不许拿更老的记录顶（那正是重启时把旧端口捞回来的路）。
    const alt = recs.find((r) => r.ok === true && r.origin);
    if (newestFresh || !alt) {
      return fail(String(newest.why || '最新记录解析不出 origin'), { source: newest.source, file: newest.file || null, atMs: newest.atMs || null });
    }
    return { ok: true, source: alt.source, origin: alt.origin, file: alt.file || null, atMs: alt.atMs || null, why: null, records };
  }

  // 最新记录有效，但另一个来源在新鲜窗内也写了、且说法不同 → 真歧义，不替你选。
  for (const r of recs.slice(1)) {
    if (r.ok !== true || !r.origin) continue;
    const gap = Math.abs((Number(newest.atMs) || 0) - (Number(r.atMs) || 0));
    if (r.origin !== newest.origin && gap <= FRESH_WINDOW_MS) {
      return fail('两个来源都在 ' + Math.round(FRESH_WINDOW_MS / 60000) + ' 分钟内写过，但 origin 不一致（'
        + newest.origin + ' / ' + r.origin + '）—— 多源不一致，fail-closed');
    }
  }

  return { ok: true, source: newest.source, origin: newest.origin, file: newest.file || null, atMs: newest.atMs || null, why: null, records };
}

/**
 * 解析「这一次该向哪里问心跳」。
 *
 * ★ 顺序即语义：显式配置**永远**优先（配了就不读日志 —— 也让运维有一个确定的手刹）；
 *   没配才自动发现；发现不到就 ok:false，调用方按 fail-closed 处理。
 * ★ 返回的 url 是**拼出来的** <origin>/heartbeat/auto；错误串里只出现 origin 与文件名。
 *
 * @param {object} cfg 整份配置（只用 integrations.*）
 * @param {{logDir?:string|null, originFile?:string|null, now?:number, discover?:Function}} [opts]
 */
export function resolveHeartbeatEndpoint(cfg, opts) {
  const o = opts || {};
  const u = heartbeatUrlOf(cfg);
  if (u.configured) {
    if (u.error) {
      return { ok: false, source: ENDPOINT_SOURCE.CONFIGURED, url: null, origin: null, file: null, atMs: null,
        why: '心跳地址不合法：' + u.error };
    }
    return { ok: true, source: ENDPOINT_SOURCE.CONFIGURED, url: u.url, origin: originOfUrl(u.url), file: null, atMs: null, why: null };
  }

  const d = (typeof o.discover === 'function')
    ? o.discover({ cfg: cfg || {}, logDir: o.logDir, originFile: o.originFile })
    : discoverDshOrigin({
      logDir: o.logDir === undefined ? dshLogDirOf(cfg) : o.logDir,
      originFile: o.originFile === undefined ? dshOriginFileOf(cfg) : o.originFile,
      now: o.now,
    });

  if (!d || d.ok !== true || !d.origin) {
    return {
      ok: false, source: (d && d.source) || ENDPOINT_SOURCE.NONE, url: null, origin: null,
      file: (d && d.file) || null, atMs: (d && d.atMs) || null,
      why: '既没有配心跳地址（integrations.heartbeatUrl / dshBaseUrl），也发现不到 DSH 的 origin：'
        + String((d && d.why) || '未知原因'),
    };
  }
  return {
    ok: true, source: d.source, url: joinUrl(d.origin, '/heartbeat/auto'),
    origin: d.origin, file: d.file || null, atMs: d.atMs || null, why: null,
  };
}
