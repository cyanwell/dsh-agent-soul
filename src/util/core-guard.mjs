// core-guard.mjs —— core 的两件保命装置（B1 · 2026-11-17）
// ============================================================================
// 为什么要这两样：
//   ① 单实例锁：同一端口起第二个 core 时，后者 bind 失败 → EADDRINUSE 秒崩
//      （data/shutdown.log 里能查到 exit:1 / ms:1 / cacheRows:0 那三条）。
//      壳看到「core 在健康检查完成前就退出」就判「启动失败」。
//      锁先于 bind：已经有活着的实例就不去抢端口，直接说清谁在跑。
//   ② 阻塞探针：关不掉的真因是事件循环被同步工作占住（窗口标题那句
//      「还在写索引缓存，已等 87 秒」）。探针不修它，只负责**留证据**：
//      哪一段占了多少毫秒、当时在哪个阶段。下次出问题不用靠猜。
// ============================================================================
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import path from 'node:path';

const LOCK_NAME = 'core.lock';
const STALL_LOG = 'loop-stall.log';

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = 进程在、只是没权限发信号 —— 那也是活着
    return !!(e && e.code === 'EPERM');
  }
}

// 拿到锁 -> { ok:true, file, record }
// 别人活着 -> { ok:false, existing:{pid,startedAt,...} }（调用方自己决定怎么退出）
export function acquireSingleInstance(dataDir, extra) {
  const file = path.join(dataDir, LOCK_NAME);
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch { /* 建不了目录下面写锁会报 */ }

  // ★★★ 2026-11-17（阶段 0 · 单实例）：**改成原子创建，修一个真实的竞态。**
  //
  //   原来是「读锁 → 判断持有者死活 → 写锁」三步，**不是原子的**。
  //   两个 core 同时启动时，两个都会读到「没有锁」，于是都写锁、都认为自己拿到了。
  //   实测（07:34）两个进程并存：pid=34520 不监听端口却还活着，pid=12916 拿着锁在服务 ——
  //   而**两个都在跑**（都在写 data/）。这正是「多写者环境」的机器级来源。
  //
  //   现在用 O_EXCL（openSync 'wx'）原子抢占：
  //     · 抢到 → 写内容，ok:true
  //     · EEXIST → 读锁判死活；持有者死了就删掉锁再抢一次；还活着就如实说谁在跑
  //   ★ 注意：删锁再抢这一步仍然有极小的窗口，但它只在「上一个实例是异常退出的」时发生，
  //     而正常路径（锁在、人活着）走的是 return ok:false —— 那一段没有竞态。
  const record = Object.assign({ pid: process.pid, startedAt: new Date().toISOString() }, extra || {});
  const body = JSON.stringify(record);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');   // 'wx' = 创建且必须不存在（原子）
      try { fs.writeSync(fd, body); } finally { try { fs.closeSync(fd); } catch { /* ignore */ } }
      return { ok: true, file, record };
    } catch (e) {
      if (!e || e.code !== 'EEXIST') {
        // 写不了（权限 / 目录问题）—— 如实回报，不假装拿到
        return { ok: false, file, error: String((e && e.message) || e) };
      }
    }
    // 锁已存在：看看是谁的、还活着吗
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { prev = null; }
    if (prev && Number(prev.pid) !== process.pid && pidAlive(Number(prev.pid))) {
      return { ok: false, existing: prev, file };
    }
    // 持有者已死 / 锁内容坏了 → 删掉再来一次（只重试一次，避免活锁）
    try { fs.unlinkSync(file); } catch { /* 别人先删了也算 */ }
  }
  return { ok: false, file, error: '抢锁重试后仍失败（可能有并发实例）' };
}


// 只删「自己那把」：别人接手之后不许把别人的锁删掉
export function releaseSingleInstance(handle) {
  if (!handle || handle.ok !== true || !handle.file) return;
  try {
    const cur = JSON.parse(fs.readFileSync(handle.file, 'utf8'));
    if (Number(cur.pid) === process.pid) fs.unlinkSync(handle.file);
  } catch { /* 锁已经不在了 / 读不出来 —— 都不是错误 */ }
}

// 50ms 一跳；某跳迟到超过 thresholdMs 就记一行（含当时的阶段名）
export function installLoopStallProbe(opts) {
  const o = opts || {};
  const logFile = o.logFile ? String(o.logFile) : '';
  if (!logFile) throw new Error('installLoopStallProbe requires logFile');
  const thresholdMs = Number(o.thresholdMs) > 0 ? Number(o.thresholdMs) : 200;
  const sampleMs = Number(o.sampleMs) > 0 ? Number(o.sampleMs) : 50;
  const state = { phase: o.phase ? String(o.phase) : 'startup' };

  // ★★ 2026-11-17（阶段 1 · 定位 1,300~1,400ms 阻塞）：光记「卡了多久」不够 ——
  //   它不能回答**卡在谁身上**。而这一条恰恰是最关键的那一问：
  //   是同步代码（某个 readFileSync / SQL）还是**垃圾回收**（堆太大，Stop-The-World）？
  //   两者的修法完全相反，猜错就是白干一轮。
  //
  //   所以加两个证据：
  //     ① gc：用 PerformanceObserver 收 GC 条目 —— 每次 GC 的类型、时长、当时的堆大小。
  //        卡顿发生时若紧邻一条 major GC，且堆在卡顿前接近峰值、卡顿后掉下来 → 是 GC。
  //     ② heapMB：卡顿那一刻记下堆占用，事后能看出它是不是「堆快满了」。
  let gcEntries = [];
  try {
    const { PerformanceObserver, constants } = require('node:perf_hooks');
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        gcEntries.push({ at: new Date().toISOString(), kind: e.detail && e.detail.kind, durMs: Math.round(e.duration * 100) / 100, heapMB: null });
        if (gcEntries.length > 200) gcEntries.shift();
      }
    });
    obs.observe({ entryTypes: ['gc'] });
    state.gcObserver = obs;
  } catch { gcEntries = null; }

  let last = Date.now();
  const timer = setInterval(function () {
    const now = Date.now();
    const gap = now - last - sampleMs;
    last = now;
    if (gap <= thresholdMs) return;
    try {
      const mem = process.memoryUsage();
      // 最近 3 秒内有没有 GC，以及最长的一个 —— 这就是「卡顿是不是 GC 造成的」的直接判据
      let recentGc = null;
      if (gcEntries) {
        const since = Date.now() - 3000;
        let maxDur = 0, cnt = 0;
        for (const g of gcEntries) {
          const t = Date.parse(g.at);
          if (t >= since) { cnt++; if (g.durMs > maxDur) maxDur = g.durMs; }
        }
        recentGc = { count: cnt, maxDurMs: Math.round(maxDur * 100) / 100 };
      }
      // ★★★ 2026-11-17（同一天，自己踩的坑，留证）：
      //   我在这里加过一个 captureHotFrames()：探针发现停滞就 busy-wait 60ms 抓 CPU profile。
      //   结果它把探针本身变成了造卡顿的机器 —— 一次 100 秒的运行记出 **259 条「阻塞」**，
      //   而每一条的热帧都是 captureHotFrames 自己（87%~98%）。
      //   **观测者效应**：在同步段里抓同步采样，测到的必然是采样器。
      //   已撤。要定位「卡在谁身上」，正确做法是**打桩**（在已知同步大段前后量时间），
      //   不是在探针里采样。
      fs.appendFileSync(logFile, JSON.stringify({
        at: new Date().toISOString(), stallMs: gap, phase: state.phase, pid: process.pid,
        heapMB: Math.round(mem.heapUsed / 1048576), rssMB: Math.round(mem.rss / 1048576),
        gc: recentGc,
      }) + '\n', 'utf8');
    } catch { /* 探针写不进去不许影响服务 */ }
  }, sampleMs);
  if (timer.unref) timer.unref();
  return {
    timer,
    state,
    setPhase: function (name) { state.phase = String(name || 'unknown'); },
    logFile,
  };
}

export const CORE_GUARD_FILES = Object.freeze({ lock: LOCK_NAME, stallLog: STALL_LOG });
