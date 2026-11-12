// 回声哨兵 —— 把「回声健不健康」变成一次**真的探测**，而不是一句写死的「未运行」
//
// ★★ 它替掉的是 status-data 里那一行硬编码：
//     na('回声哨兵', '未运行：echo-doctor.mjs 是 CLI，没有路由 / MCP 工具 / 器官，也没落结果文件')
//   那句话在当时是诚实的（确实没地方读），但它把「不知道」写成了「没这个东西」。
//   现在的做法：**按需跑一次真实的只读体检，把结果落成结构化文件，状态台读那份文件。**
//
// ★ 复用的是真东西，不是另造一个「假在线」：
//   D:\AI\memory\hub\echo-doctor.mjs 的 runDoctor() —— 本机唯一的回声体检实现。
//   这里只以 `--fast --json` 调它：**永不深检**（深检要解 74MB 多帧日志，那是重 I/O 全库扫描）。
//
// ★ 三条纪律：
//   ① **只读**：doctor 全程只读文件（源码里没有 spawn / write），本模块只往 <dataDir> 落一份结果；
//      生产记忆（书房 / 《墨》 / 热记忆）一个字节都不写。
//   ② **失败也记**：spawn 失败 / 超时 / 输出不是 JSON / doctor 不存在 —— 一律落成 probe.ok:false +
//      error，**绝不当成成功**，也绝不把上次的成功结果继续当「现在」。
//   ③ **没有倒计时**：不注册定时器、不做第二条心跳。探测由三件事触发：
//      进程启动后一次、读接口发现结果过期、显式 refresh。
//
// ★ 为什么用**子进程**而不是 import：
//   · 体检器一旦卡住，import 会把整个 HTTP 事件循环一起卡住；子进程可以真的杀掉。
//   · 它是外部工具（另一个仓库），用 CLI 契约比用模块内部结构稳 —— 它改内部实现不会拖我们下水。
//   代价：每次多一次 node 启动（本机实测 ~0.4s）+ fast 层（~1.8s）。所以必须低频、必须缓存。

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const SENTINEL_FILE = 'echo-sentinel.json';
export const DEFAULT_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_TIMEOUT_MS = 15000;
export const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

export function sentinelFileOf(dataDir) {
  const d = String(dataDir == null ? '' : dataDir).trim();
  return d ? path.join(d, SENTINEL_FILE) : null;
}

/** 从可能夹着日志的 stdout 里取出那一个 JSON 对象。★ 取不出就返回 null，不猜。 */
export function parseDoctorJson(stdout) {
  const s = String(stdout == null ? '' : stdout);
  const tries = [s];
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) tries.push(s.slice(a, b + 1));
  for (const t of tries) {
    try {
      const v = JSON.parse(t);
      if (v && typeof v === 'object' && typeof v.overall === 'string') return v;
    } catch { /* 下一个 */ }
  }
  return null;
}

function summarize(rec) {
  if (!rec || typeof rec !== 'object') return null;
  return {
    at: rec.at || null,
    state: rec.state || 'unknown',
    probeOk: !!(rec.probe && rec.probe.ok),
    mode: (rec.probe && rec.probe.mode) || null,
    latencyMs: rec.probe && Number.isFinite(rec.probe.latencyMs) ? rec.probe.latencyMs : null,
    overall: rec.overall || null,
    counts: rec.counts || null,
    checks: Array.isArray(rec.checks) ? rec.checks : [],
    error: (rec.probe && rec.probe.error) || null,
    reason: rec.reason || null,
  };
}

/**
 * 读上一次的探测结果。**纯读，不触发探测** —— 状态台要的就是这个语义。
 *
 * @returns {{ ok, file, mtimeMs, at, ageMs, stale, state, record, why }}
 *   ★ ok=false 只表示「没有可信结果」（没跑过 / 读不出 / 过期得不像话），
 *     此时 state 一律 'unknown'，调用方**不许**把它画成「健康」或「故障」。
 */
export function readEchoSentinel(opts) {
  const o = opts || {};
  const file = sentinelFileOf(o.dataDir);
  const ttlMs = Number.isFinite(o.ttlMs) ? o.ttlMs : DEFAULT_TTL_MS;
  const now = Number.isFinite(o.nowMs) ? o.nowMs : Date.now();
  const base = { ok: false, file, mtimeMs: null, at: null, ageMs: null, stale: null, state: 'unknown', record: null, why: null };
  if (!file) return { ...base, why: '没有 dataDir —— 探测结果没地方落' };

  let st = null;
  try { st = fs.statSync(file); } catch { return { ...base, why: '还没有探测结果（哨兵从未跑过）' }; }

  let doc = null;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return { ...base, mtimeMs: st.mtimeMs, why: '结果文件读不出来：' + String((e && e.message) || e) }; }

  const atMs = Date.parse(String((doc && doc.at) || ''));
  if (!Number.isFinite(atMs)) {
    return { ...base, mtimeMs: st.mtimeMs, why: '结果文件里没有可解析的时间（at）—— 旧版本或在被手改过' };
  }
  const ageMs = Math.max(0, now - atMs);
  const stale = ageMs > ttlMs;
  return {
    ok: true, file, mtimeMs: st.mtimeMs, at: new Date(atMs).toISOString(), ageMs, stale,
    state: (doc && doc.state) || 'unknown',
    record: summarize(doc),
    why: stale ? '结果已过期（' + Math.round(ageMs / 1000) + ' 秒前），不是「现在」' : null,
  };
}

/**
 * 造一个哨兵。
 *
 * @param {object} o
 *   dataDir    —— 结果落盘目录（隔离实例 = 隔离根；**绝不写生产记忆**）
 *   doctorPath —— echo-doctor.mjs 的路径；空 = 未配置（探测会明确失败，不假装健康）
 *   nodePath   —— 用哪个 node 跑（默认 process.execPath，**不依赖 PATH**）
 *   timeoutMs / ttlMs / clock / log
 */
export function createEchoSentinel(o) {
  const opt = o || {};
  const dataDir = opt.dataDir || null;
  const doctorPath = String(opt.doctorPath == null ? '' : opt.doctorPath).trim();
  const nodePath = String(opt.nodePath || process.execPath);
  const timeoutMs = Number.isFinite(opt.timeoutMs) ? opt.timeoutMs : DEFAULT_TIMEOUT_MS;
  const ttlMs = Number.isFinite(opt.ttlMs) ? opt.ttlMs : DEFAULT_TTL_MS;
  const clock = typeof opt.clock === 'function' ? opt.clock : () => Date.now();
  const log = typeof opt.log === 'function' ? opt.log : () => {};
  const file = sentinelFileOf(dataDir);
  let inflight = null;

  function write(rec) {
    if (!file) return { persisted: false, error: '没有 dataDir' };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(rec, null, 2), 'utf8');
      fs.renameSync(tmp, file);
      return { persisted: true, error: null };
    } catch (e) {
      return { persisted: false, error: String((e && e.message) || e) };
    }
  }

  /** 跑一次真的探测。**永远 resolve**（失败也返回一条记录），由调用方看 probe.ok。 */
  function probe(reason) {
    const t0 = clock();
    const at0 = new Date(t0).toISOString();
    const failRec = (error, extra) => {
      const rec = {
        at: at0, reason: String(reason || 'on-demand'),
        state: 'unknown',
        overall: null, counts: null, checks: [],
        probe: {
          ok: false, mode: 'fast', latencyMs: clock() - t0,
          doctorPath: doctorPath || null, nodePath,
          error: String(error || '未知错误').slice(0, 300),
          ...(extra || {}),
        },
      };
      const w = write(rec);
      rec.persisted = w.persisted;
      if (w.error) rec.persistError = w.error;
      log('回声哨兵探测失败：' + rec.probe.error);
      return rec;
    };

    if (!doctorPath) return Promise.resolve(failRec('未配置 echo-doctor 路径（integrations.echoDoctorPath）—— 不探测，也不假装健康', { code: 'UNCONFIGURED' }));
    let st = null;
    try { st = fs.statSync(doctorPath); } catch { return Promise.resolve(failRec('echo-doctor 不存在：' + doctorPath, { code: 'NOT_FOUND' })); }
    if (!st.isFile()) return Promise.resolve(failRec('echo-doctor 路径不是文件：' + doctorPath, { code: 'NOT_FILE' }));

    return new Promise((resolve) => {
      const argv = [doctorPath, '--fast', '--json'];
      execFile(nodePath, argv, {
        timeout: timeoutMs,
        killSignal: 'SIGTERM',
        maxBuffer: DEFAULT_MAX_BUFFER,
        windowsHide: true,
        encoding: 'utf8',
      }, (err, stdout, stderr) => {
        const latencyMs = clock() - t0;
        const timedOut = !!(err && (err.killed || err.signal));
        const exitCode = err && Number.isFinite(err.code) ? err.code : (err ? null : 0);
        const stderrHead = String(stderr || '').slice(0, 200);
        const doctorMtime = new Date(st.mtimeMs).toISOString();

        if (timedOut) {
          return resolve(failRec('探测超时（' + timeoutMs + 'ms，已杀掉子进程）', {
            code: 'TIMEOUT', timedOut: true, latencyMs, exitCode: null, doctorMtime, stdoutBytes: String(stdout || '').length, stderrHead,
          }));
        }

        const report = parseDoctorJson(stdout);
        if (!report) {
          // ★ 非零退出码 + 没有 JSON = 真的跑不起来；有 JSON 时非零退出码是**体检结论**（doctor 用 2 表示有 error），
          //   不能把「体检结论是 error」误读成「体检器自己坏了」。
          const why = err
            ? '探测失败：' + String((err && err.message) || err).split('\n')[0].slice(0, 200)
            : '输出里没有可解析的体检 JSON';
          return resolve(failRec(why, {
            code: err ? 'SPAWN_FAILED' : 'BAD_JSON',
            exitCode, latencyMs, doctorMtime,
            stdoutBytes: String(stdout || '').length, stderrHead,
          }));
        }

        const checks = (Array.isArray(report.checks) ? report.checks : []).map((c) => ({
          id: String((c && c.id) || ''), label: String((c && c.label) || ''),
          status: String((c && c.status) || ''), detail: String((c && c.detail) || '').slice(0, 300),
        }));
        const overall = String(report.overall || 'unknown');
        const state = ['ok', 'warn', 'error'].includes(overall) ? overall : 'unknown';
        const rec = {
          at: at0,
          reason: String(reason || 'on-demand'),
          state,
          overall,
          counts: report.counts || null,
          reportAt: report.at || null,
          reportMs: Number.isFinite(report.ms) ? report.ms : null,
          checks,
          probe: {
            ok: true, mode: 'fast', latencyMs,
            doctorPath, doctorMtime, nodePath,
            exitCode, timedOut: false,
            stdoutBytes: String(stdout || '').length,
            stderrHead,
          },
          evidence: {
            // ★ 「证据」= 能被人拿去复核的那几样：哪份体检器、什么时候的、总判、哪几项不是 ok。
            doctorPath, doctorMtime,
            overall, counts: report.counts || null,
            notOk: checks.filter((c) => c.status && c.status !== 'ok' && c.status !== 'info').map((c) => c.id + ':' + c.status),
            note: 'fast 层（不解会话日志）；深检请自己跑 echo-doctor.mjs --json',
          },
        };
        const w = write(rec);
        rec.persisted = w.persisted;
        if (w.error) rec.persistError = w.error;
        log('回声哨兵：' + state + '（总判 ' + overall + ' · ' + latencyMs + 'ms）');
        return resolve(rec);
      });
    });
  }

  /** 后台跑一次；已有在飞的就不再开一条（避免页面连点变成连跑）。 */
  function probeInBackground(reason) {
    if (inflight) return inflight;
    inflight = probe(reason).finally(() => { inflight = null; });
    return inflight;
  }

  /**
   * 「需要就探一次」：结果新鲜就直接用，过期/没有就**开一条后台探测**并立刻返回**当前**读数。
   * ★ 刻意不 await：状态接口不该被一次 2 秒的体检拖住；调用方看到的是「正在探」而不是假答案。
   */
  function maybeProbe(reason) {
    const cur = readEchoSentinel({ dataDir, ttlMs, nowMs: clock() });
    if (cur.ok && !cur.stale) return { probing: false, current: cur };
    if (inflight) return { probing: true, current: cur };
    probeInBackground(reason || 'stale');
    return { probing: true, current: cur };
  }

  return { probe, probeInBackground, maybeProbe, file, ttlMs, doctorPath };
}
