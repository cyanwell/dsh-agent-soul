// 超时 —— 给「等一个不保证返回的东西」装上边。
//
// ★ 为什么要有它：registry.execute() 原来是 `await def.handler(...)`。
//   handler 不返回（死循环、卡在网络、等一个永远不来的锁），
//   整条回合就永远不返回 —— 而 MAX_STEPS 只在「拿到结果之后」才数步数，救不了。
//
// ★★ 必须说清这条边界的性质：**JS 没法杀掉一个同步死循环。**
//   Promise.race 只能让**等待者**不再等，跑着的 handler 还在跑（直到进程退出）。
//   所以这不是「中止」，是「放弃等待」—— 措辞和行为都要对得上，
//   否则以后有人会以为「超时了就一定干净了」。

/**
 * 给一个 Promise 加上时限。超时不杀它，只是不再等它。
 * @param p Promise
 * @param ms 毫秒；0 或负数 = 不设限
 * @param label 超时信息里用的名字
 */
export function withTimeout(p, ms, label = '操作') {
  if (!ms || ms <= 0) return p;
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(label + ' 超时（' + ms + 'ms）—— 已放弃等待，但它可能还在后台跑');
      e.code = 'TIMEOUT';
      e.timeoutMs = ms;
      reject(e);
    }, ms);
    // ★ 不能 unref。unref 的语义是「别为了我拖住进程退出」，
    //   而这里的语义正相反 —— **我就是要等这个超时兑现**。
    //   加了 unref 之后 Node 会认为「没有 pending 的活」，
    //   于是报 unsettled top-level await，race 永远不 settle。
  });
  return Promise.race([p, guard]).finally(() => clearTimeout(timer));
}
