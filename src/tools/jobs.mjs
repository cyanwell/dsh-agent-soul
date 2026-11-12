// src/tools/jobs.mjs —— 后台任务（P0 的另一半）。
//
// ★ 为什么需要它：v4 的 run_shell 是**同步等**的，超时上限 300 秒。
//   而真实的活里有大量「跑起来就不管、过一会来看」的：构建、下载、批处理、长测试。
//   没有这一层，v4 只能一次做一件事，而且一件长活就把它堵死。
//
// ★ 四条判据：
//   1. **不阻塞**：job_start 立刻返回 id，输出在后台累积。
//   2. **输出有上限**：每流最多 256KB，超了从头丢并标 truncated —— 不静默截断，也不无限吃内存。
//   3. **要么自己退，要么被杀**：每个 job 有 timeoutMs（默认 10 分钟），到点强杀；
//      v4 退出时也会把活着的子进程一起收掉（见 killAll）。
//   4. **读是游标式的**：job_output 带 since 参数，只回新内容 ——
//      否则一次 10 万行的构建日志会把上下文撑爆，而它每次都重发一遍。
//
// ★ 不引依赖：node 的 spawn 就够。

import { spawn } from 'node:child_process';
import { decodeOutput } from '../util/decode.mjs';

const OUT_MAX = 256 * 1024;      // 每流上限
const DEFAULT_TIMEOUT = 10 * 60 * 1000;
const KEEP_FINISHED = 20;        // 只留最近 20 个已结束的，避免 Map 无限长

export function createJobManager({ workspace, log = () => {} } = {}) {
  const jobs = new Map();
  let seq = 0;

  function pushStream(arr, chunk, state) {
    const buf = Buffer.from(chunk);
    state.total += buf.length;
    arr.push(buf);
    while (state.total > OUT_MAX && arr.length > 1) {
      const dropped = arr.shift();
      state.total -= dropped.length;
      state.truncated = true;
    }
  }

  function reap() {
    const done = [...jobs.values()].filter((j) => j.status !== 'running');
    if (done.length <= KEEP_FINISHED) return;
    done.sort((a, b) => a.endedAt - b.endedAt);
    for (const j of done.slice(0, done.length - KEEP_FINISHED)) jobs.delete(j.id);
  }

  function start({ command, timeoutMs, cwd } = {}) {
    const cmd = String(command || '').trim();
    if (!cmd) throw new Error('command 是空的');
    const id = 'job-' + (++seq);
    const tmo = Math.min(Math.max(Number(timeoutMs) || DEFAULT_TIMEOUT, 1000), 60 * 60 * 1000);
    const child = spawn('cmd.exe', ['/c', cmd], {
      cwd: cwd || workspace,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const job = {
      id, command: cmd, pid: child.pid, startedAt: Date.now(), endedAt: 0,
      status: 'running', exitCode: null, signal: null, truncated: false,
      out: [], err: [], outState: { total: 0, truncated: false }, errState: { total: 0, truncated: false },
      timer: null,
    };
    jobs.set(id, job);
    child.stdout.on('data', (c) => pushStream(job.out, c, job.outState));
    child.stderr.on('data', (c) => pushStream(job.err, c, job.errState));
    child.on('error', (e) => {
      pushStream(job.err, String((e && e.message) || e) + '\n', job.errState);
      job.status = 'error'; job.endedAt = Date.now();
    });
    child.on('exit', (code, signal) => {
      job.exitCode = code; job.signal = signal;
      if (job.status === 'running') job.status = 'done';
      if (job.timer) { clearTimeout(job.timer); job.timer = null; }
      job.endedAt = Date.now();
      if (job.endedAt - job.startedAt > 5000) log('后台任务结束 ' + id + ' exit=' + code + ' ' + (job.endedAt - job.startedAt) + 'ms');
      reap();
    });
    job.timer = setTimeout(() => {
      if (job.status !== 'running') return;
      job.status = 'timeout';
      try { child.kill('SIGKILL'); } catch { /* 已经没了 */ }
      pushStream(job.err, '\n[超时 ' + Math.round(tmo / 1000) + 's，已强杀]\n', job.errState);
    }, tmo);
    job.timer.unref?.();
    return { jobId: id, pid: child.pid, command: cmd, timeoutMs: tmo };
  }

  function snapshot(job, since) {
    const off = Math.max(0, Number(since) || 0);
    // ★ 2026-11-11：不能直接 toString('utf8') —— 中文 Windows 的命令输出是 GBK。
    //   判据在 util/decode.mjs；实测 ping 的输出曾整段变成替换字符。
    const outText = decodeOutput(Buffer.concat(job.out));
    const errText = decodeOutput(Buffer.concat(job.err));
    // ★ since 按「已读字符数」算，不是字节 —— 调用方拿的是文本长度。
    const cut = (s) => (off > 0 && off < s.length ? s.slice(off) : (off >= s.length ? '' : s));
    return {
      jobId: job.id, status: job.status, exitCode: job.exitCode, signal: job.signal,
      command: job.command, pid: job.pid,
      elapsedMs: (job.endedAt || Date.now()) - job.startedAt,
      stdout: cut(outText), stderr: cut(errText),
      stdoutChars: outText.length, stderrChars: errText.length,
      truncated: job.outState.truncated || job.errState.truncated,
    };
  }

  function output({ jobId, wait = false, timeoutMs = 5000, since = 0 } = {}) {
    const job = jobs.get(String(jobId || ''));
    if (!job) return { ok: false, error: '没有这个任务：' + String(jobId || '') };
    if (job.status !== 'running' || !wait) return { ok: true, ...snapshot(job, since) };
    const budget = Math.min(Math.max(Number(timeoutMs) || 5000, 200), 120000);
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        if (job.status !== 'running') { resolve({ ok: true, ...snapshot(job, since) }); return; }
        if (Date.now() - t0 >= budget) { resolve({ ok: true, waitedOut: true, ...snapshot(job, since) }); return; }
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  function kill({ jobId } = {}) {
    const job = jobs.get(String(jobId || ''));
    if (!job) return { ok: false, error: '没有这个任务：' + String(jobId || '') };
    if (job.status !== 'running') return { ok: true, already: true, ...snapshot(job, 0) };
    try { process.kill(job.pid); } catch { /* 已经不在了 */ }
    job.status = 'killed';
    return { ok: true, killed: true, jobId: job.id, pid: job.pid };
  }

  function list() {
    return [...jobs.values()].map((j) => ({
      jobId: j.id, command: j.command, status: j.status, pid: j.pid,
      elapsedMs: (j.endedAt || Date.now()) - j.startedAt, exitCode: j.exitCode,
    }));
  }

  /** v4 退出时把所有活着的子进程收掉 —— 否则会留下一串孤儿 cmd.exe。 */
  function killAll(reason = 'shutdown') {
    const alive = [...jobs.values()].filter((j) => j.status === 'running');
    for (const j of alive) {
      try { process.kill(j.pid); } catch { /* ignore */ }
      j.status = 'killed';
    }
    if (alive.length) log('退出时收了 ' + alive.length + ' 个后台任务（' + reason + '）');
    return alive.length;
  }

  return { start, output, kill, list, killAll };
}

export function registerJobTools(registry, { workspace, log = () => {} } = {}) {
  const mgr = createJobManager({ workspace, log });
  registry.register({
    name: 'job_start',
    description: '起一个后台命令，立刻返回 jobId（不阻塞）。之后用 job_output 取输出，job_kill 终止。默认 10 分钟超时。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要跑的 cmd 命令' },
        timeoutMs: { type: 'integer', description: '超时后强杀，默认 600000' },
        cwd: { type: 'string', description: '工作目录，默认工作区' },
      },
      required: ['command'],
    },
    handler: (a) => mgr.start(a),
  });
  registry.register({
    name: 'job_output',
    description: '取后台任务的输出。wait=true 时最多等 timeoutMs；since 传上次读到的字符数，只回新增内容。',
    parameters: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        wait: { type: 'boolean' },
        timeoutMs: { type: 'integer', description: 'wait 时的等待上限，默认 5000' },
        since: { type: 'integer', description: '已读字符数（默认 0 = 从头）' },
      },
      required: ['jobId'],
    },
    handler: (a) => mgr.output(a),
  });
  registry.register({
    name: 'job_kill',
    description: '终止一个后台任务。',
    parameters: {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId'],
    },
    handler: (a) => mgr.kill(a),
  });
  registry.register({
    name: 'job_list',
    description: '列出所有后台任务（含已结束的最近 20 个）。',
    parameters: { type: 'object', properties: {} },
    handler: () => ({ jobs: mgr.list() }),
  });
  return mgr;
}
