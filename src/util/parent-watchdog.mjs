// 父进程看门狗 —— 启动器死了，我自己退出。
//
// ★ 为什么需要这个东西（2026-11-07 实测，撞了两次）：
//   双击 exe → 启动器起 node → 关掉命令行窗口（或任务管理器结束任务）→
//   **node 还活着**，而且它把整个解压目录锁住。
//   再双击就报「解压失败：文件 runtime\node.exe 正由另一进程使用」，
//   而那个文件用户根本没碰过。
//
// ★ 先试过 Job Object（CreateJobObject + KILL_ON_JOB_CLOSE），**实测无效**：
//   AssignProcessToJobObject 返回 true，但启动器被 taskkill /F 之后子进程依然活着。
//   （真机读数：启动器 17536 死了，node 27692 活着，ParentProcessId 指着那个死掉的 PID。）
//   原因没查到底 —— 但**继续在 C# 侧找是错的方向**，这个项目的 90% 在 node 侧。
//
// ★★ 所以换了个更笨但更可靠的解法：**让 node 自己看父进程**。
//   启动器把自己的 PID 传进来（AGENT_SOUL_PARENT），这里每 2 秒看一眼它在不在。
//
//   为什么这个比 Job Object 可靠：
//   ① 不依赖内核机制的理解正确 —— 判据就是「那个 PID 还在不在」，一试就知道
//   ② 不依赖 C# 侧的 P/Invoke 细节
//   ③ 同一份逻辑在开发模式（node 直接起）下也跑得通
//
// ★ 一条必须说清的边界：**PID 会被复用。**
//   Windows 的 PID 不是永久的，父进程死后那个号可能分给别的进程。
//   所以这个看门狗在极端情况下会**误判父进程还活着**（发现的时候已经晚了）。
//   误判的方向是「该退没退」，不是「不该退却退了」—— **宁可不杀，不可错杀。**
//   这比反过来好：一个自己莫名其妙退掉的服务，比一个多活几秒的进程糟得多。

import fs from 'node:fs';

const INTERVAL = 2000;

/**
 * 父进程还在不在。
 *
 * ★ 判据是 try { process.kill(pid, 0) } —— signal 0 不真发信号，只做存在性检查。
 *   EPERM = 进程在但不归我管（也算在）；ESRCH = 真的没了。
 */
export function parentAlive(pid) {
  if (!pid || !Number.isFinite(pid) || pid <= 0) return true;  // 没配就永远认为活着
  try { process.kill(pid, 0); return true; }
  catch (e) { return e && e.code === 'EPERM'; }
}

/**
 * 装上看门狗。返回一个停止函数（测试要用）。
 *
 * ★ 只在 env 里有 AGENT_SOUL_PARENT 时才装 —— 开发模式下（node 直接起）没有它，
 *   这时**不该有看门狗**，否则终端一关服务就没了，那是另一种惊吓。
 */
export function installParentWatchdog(opts = {}) {
  const pid = Number(process.env.AGENT_SOUL_PARENT || 0);
  const onDie = opts.onDie || ((parent) => {
    // ★ 说一句再走。静默退出是这整件事里最坏的一种表现 ——
    //   用户看到的「服务没了」和「服务本来就没起」长得一样。
    console.error('[agent-soul] 父进程 ' + parent + ' 已退出，跟着退出（避免留下锁住目录的孤儿进程）');
    process.exit(0);
  });
  const interval = opts.interval || INTERVAL;

  if (!pid) return { active: false, pid: 0, stop() {} };

  // 先确认一次：如果传进来的 PID 一开始就不存在，说明调用方搞错了，不装，免得立刻就退。
  if (!parentAlive(pid)) {
    console.error('[agent-soul] AGENT_SOUL_PARENT=' + pid + ' 一开始就不存在，看门狗不装');
    return { active: false, pid, stop() {} };
  }

  const timer = setInterval(() => {
    if (!parentAlive(pid)) { clearInterval(timer); onDie(pid); }
  }, interval);
  // ★ unref：这个定时器**不该**成为进程不退出的理由。
  //   （本项目踩过一次 unref 的坑：加了它，定时器就不保活了。）
  if (timer.unref) timer.unref();

  return { active: true, pid, stop() { clearInterval(timer); } };
}
