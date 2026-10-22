/**
 * 「还差哪些占位符没填」—— 唯一的判定处。
 *
 * ★★ 为什么单独一个模块（2026-10-22，外部验证报告 v3 的 R1 之后）
 *
 * plan.mjs 和 self.mjs 原来各写了一份正则，口径不一致：
 *   plan 认得长占位符，但把 HTML 注释也吃了；
 *   self 认得注释，但漏掉那个 30 多字的长占位符。
 * 两处都得对，而且**必须对得一样** —— 所以收拢到这里。
 *
 * ★★★ 真正的坑，以及它是怎么踩进去的
 *
 * 模板里三处「填法」注释长得和占位符一模一样：有 `<` 有 `>`，中间没有换行。
 *
 *     <!-- 填法：把 [hub] 换成你实际的记忆中枢路径。…… -->
 *
 * 我为了让那个 30 多字的长占位符能被认出来，把正则从 `{2,12}` 放宽到 `{2,80}`。
 * 结果这三段注释被当成三个**永远填不完**的占位符，plan 卡在第 3 步，
 * 第 4 到 6 步不可达。用户照 plan 走会原地打转。
 *
 * **修一个「漏数」的 bug，换来一个「永远过不去」的 bug —— 后者更坏。**
 * 漏数只是少提示一个；过不去是整条路断在那儿，而且看起来像「你还没填完」，
 * 用户会一直以为自己漏了什么。
 *
 * 所以这里的顺序是固定的：**先剔注释，再找尖括号**。反过来一定会再踩一次。
 */

/**
 * 剔掉 HTML 注释（含跨行）。
 * ★ 占位符判定必须发生在这之后。
 */
export function stripHtmlComments(text) {
  return String(text ?? '').replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * 列出还没填的占位符（去重）。
 *
 * 判据：`<尖括号>` 里 2–80 个字符、且不含尖括号和换行。
 * ★ 上限是 80 不是 12：那个身份判据占位符有 30 多字、还带逗号。
 * ★ 但放宽必须配上 stripHtmlComments —— 这两件事是一对，不能分开用。
 */
export function findPlaceholders(text) {
  const clean = stripHtmlComments(text);
  return [...new Set(clean.match(/<[^<>\n]{2,80}>/g) || [])];
}

/**
 * 自检：拿模板原文跑一遍，返回 { placeholders, fromComments }。
 * fromComments 是用来抓「注释被当成占位符」这个回归的 —— 它必须总是空数组。
 */
export function inspect(text) {
  const placeholders = findPlaceholders(text);
  const raw = String(text ?? '');
  const fromComments = placeholders.filter((p) => {
    // 这个占位符如果落在某段注释内部，就是回归
    let i = raw.indexOf(p);
    while (i !== -1) {
      const before = raw.lastIndexOf('<!--', i);
      const close = raw.lastIndexOf('-->', i);
      if (before !== -1 && close < before) return true;
      i = raw.indexOf(p, i + 1);
    }
    return false;
  });
  return { placeholders, fromComments };
}
