// dsh-agent-echo —— 浏览器半 v3（液态玻璃仪表盘）
//   ★ 历史名 dsh-yanqing-echo 已弃用；注释留着旧名会骗后来人（2026-10-25 改）
// ============================================================================
// 2026-10-18 14:21：
//   「回声echo的哨兵面板可以美化了嘛，我想要好看的，我细化液态玻璃的效果，
//     当然如果有动态的最好了，但是感觉桌面端的帧率不会太高」
//
// ★★★ 这一版和 v2 的差别只有一件事：**渲染层从内联 style 换成注入的 CSS**。
//   为什么必须换 —— `backdrop-filter`（毛玻璃）、伪元素高光、`@keyframes`
//   这三样东西内联 style 表达不了，而液态玻璃全靠它们。
//   数据和请求逻辑一行没动。
//
// ★★★ 性能是这一版的第一约束，因为桌面端是 Electron + 软件合成风险：
//   【一】`backdrop-filter` 只出现在**两层**上（.yq-glass / .yq-hero）。
//        它是逐帧重采样的，叠三层以上在集显上会掉到 20fps。
//   【二】所有动画只用 `transform` 和 `opacity` —— 这两个属性走合成层，
//        不触发重排重绘。**绝不动 `filter` / `width` / `background-position`。**
//   【三】状态球的光环用 conic-gradient 旋转，尺寸只有 46px；
//        不加 `filter: blur()`（那个会让整层失去合成层资格）。
//   【四】`@media (prefers-reduced-motion: reduce)` 一律关动画。
//   【五】面板自己带一个「动效」开关（存 localStorage），卡就一键关 ——
//        不让人为了看个面板去翻设置。
//
// ★★★ 一条踩过的坑（别改回去）：`exports.inject = ["slots"]` 必须写。
//   少这一行：Host 照报 running、侧边栏计数照报，而**浏览器里一行都不执行、
//   控制台一个错都没有**。
//
// ★★★ 另一条（2026-10-18 修）：后端地址**必须用相对路径**。
//   0.2.1 起 webserver 的 port 是 0（随机），写死 19387 在桌面端必然 Failed to fetch。
//   桌面端页面是 dsh-app://app/，主进程 protocol.handle 会把非静态路径
//   forwardWebRequest 转发到真实服务器（lib/main.js:11542），所以相对路径两边都对。
// ============================================================================

window.__ModuleLoader__.load({
  /* ★★ id 必须等于**它在这个 profile 里的 entry 名** ——
   *   即 profile `package.json` 的 `dsh.profile.bundles` 里写的那一串，
   *   不是仓库名、也不是 package.json 的 name（本机这轮叫 dsh-yanqing-echo）。
   *   2026-10-26 00:39 与 2026-11-01 12:51 各踩过一次：把 id 写成 dsh-agent-echo，
   *   而 entry 是 dsh-yanqing-echo → client-modules 找不到注册 → web boot 整批不激活。
   *   2026-10-30 那条「统一回 dsh-agent-*」的判断是错的：
   *   想统一，必须 bundles / dependencies / package.json.name / node_modules 目录名**四处同时改**，
   *   只改 client.js 的 id 必崩。 */
  id: "dsh-agent-echo",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");

    const API = "/yanqing-echo/api";

    const C = { ok: "#34d399", warn: "#fbbf24", error: "#f87171", pending: "#60a5fa", info: "#8b9bb0" };
    const ICON = { ok: "✓", warn: "!", error: "✗", pending: "◎", info: "·" };
    const LABEL = { ok: "健康", warn: "注意", error: "故障", pending: "待深检", info: "信息" };
    const LEVELS = [
      { n: 1, name: "1 级", every: "5 分钟" },
      { n: 2, name: "2 级", every: "10 分钟" },
      { n: 3, name: "3 级", every: "30 分钟" },
      { n: 4, name: "4 级", every: "手动" },
    ];

    const fmtAge = (ms) => {
      if (ms === null || ms === undefined) return "—";
      if (ms < 1500) return "刚刚";
      const s = Math.round(ms / 1000);
      if (s < 60) return s + " 秒前";
      const m = Math.round(s / 60);
      if (m < 60) return m + " 分钟前";
      return (m / 60).toFixed(1) + " 小时前";
    };
    const fmtIn = (ms) => {
      if (ms === null || ms === undefined) return "—";
      const s = Math.round(ms / 1000);
      if (s < 60) return s + " 秒后";
      return Math.round(s / 60) + " 分钟后";
    };

    // ══════════════════════════════════════════════════════════════════════════
    // CSS —— 只注入一次，用 id 去重
    // ══════════════════════════════════════════════════════════════════════════
    const STYLE_ID = "yq-echo-style-v5";

    const CSS = `
.yq-root{
  --ok:#34d399; --warn:#fbbf24; --error:#f87171; --pending:#60a5fa;
  /* ★ 2026-10-25：配色不再写死深色主题。
     宿主主题变量是成对赋值的（浅色主题给深字、深色主题给浅字），所以直接读它就对；
     变量拿不到时退回**深色字** —— 至少浅色宿主可读（原来的写法是白字打白玻璃）。
     深色宿主由下面的 [data-tone="dark"] 整套接管（JS 探测到之后加上这个属性）。 */
  /* ★★ 2026-11-01：**不再读宿主变量**。
     原来写 --ink:var(--dsw-alias-label-primary,#16202c)，赌的是「宿主主题变量成对赋值」。
     但玻璃配方（--glass）默认是**白色**，而深色宿主给的是**浅色字** ——
     于是「白玻璃 + 浅色字」，整面板糊成一片（2026-11-01 截图实测）。
     [data-tone="dark"] 那套本是救场的，但 JS 探测没生效，等于没有。

     ★ 判据：**玻璃的亮度和文字的亮度必须成对绑定，不许各读各的。**
     玻璃默认白 → 文字就固定深色，不管宿主是深是浅。白玻璃在任何背景上都成立。 */
  --ink:#16202c;
  --dim:#42536b;
  --faint:#5b6b80;
  /* ★ 2026-10-18：玻璃配方改成和砚台同一套（去掉 backdrop-filter）。
     沿用砚台 client.js:28-45 那段的结论 —— 2026-10-02 实测「滚轮一动整个界面都在闪」，
     真凶就是 backdrop-filter：它让卡片成为 GPU 合成层，滚动时整卡连内容一起重绘。
     去掉之后视觉靠四样东西撑住：半透明底 / 有色散的内高光 / 厚度的上下边 / 大而散的外投影。 */
  --glass:linear-gradient(148deg,rgba(255,255,255,.86),rgba(255,255,255,.62));
  --edge:var(--dsw-alias-border-l2,rgba(16,32,52,.14));
  --lift:inset 0 1px 0 rgba(255,255,255,.70),0 8px 26px rgba(16,32,52,.12),0 1px 2px rgba(16,32,52,.08);
  --code-bg:rgba(16,32,52,.06);
  --accent:#60a5fa;
  position:relative; height:100%; overflow-y:auto; overflow-x:hidden;
  padding:14px 14px 20px; color:var(--ink); font-size:13px; line-height:20px;
  background:
    radial-gradient(1200px 480px at 10% -14%, rgba(56,132,255,.10), transparent 62%),
    radial-gradient(900px 420px at 92% 4%,  rgba(147,86,255,.08), transparent 58%),
    radial-gradient(760px 360px at 60% 108%,rgba(52,211,153,.06), transparent 60%);
}
/* ══ YQ-SOFT-GLASS-V1（2026-11-01）════════════════════════════════
 * 爀曦：「玻璃很硬，没有苹果那种感觉」。
 *
 * 硬的原因：--glass 是 rgba(30,38,50,.88) —— 不透明度 88%，几乎是实心色块。
 * 苹果的质感来自**模糊**，不是半透明实色。
 *
 * ★★ 这一版**只改 CSS，一行 JS 都不碰**。
 *    上一版同时改了 JS（state + 属性 + 按钮），面板整块空白 ——
 *    因为我没法在部署前验证 React 渲染，只能靠 node --check，而它只验语法。
 *    CSS 错了最多难看，JS 错了会崩。先把风险降到一个我能承受的量级。
 *
 * ★ 不做 [data-glass] 开关了 —— 无条件启用软玻璃。
 *   理由：开关需要 JS 改属性，而 JS 正是上次崩的原因。
 *   如果实测发现滚动卡，再单独加开关（那时会有明确的对比数据）。
 *
 * ★ blur 只加在两张卡面上（.yq-glass / .yq-hero），不给每个小元素加 ——
 *   合成层数量是「闪」的根源（这条来自 2026-10-02 的教训，但那次真因是重渲染）。
 */

/* 卡面：真模糊 —— 只在 data-glass="soft" 时启用（默认就是 soft） */
.yq-root[data-glass="soft"] .yq-glass,
.yq-root[data-glass="soft"] .yq-hero{
  -webkit-backdrop-filter: blur(24px) saturate(185%);
  backdrop-filter: blur(24px) saturate(185%);
}

/* 底色更透 —— 让模糊透上来。浅色主题 */
.yq-root{
  --glass:linear-gradient(148deg,rgba(255,255,255,.58),rgba(255,255,255,.30));
  --edge:rgba(16,32,52,.09);
  --lift:inset 0 1px 0 rgba(255,255,255,.90),
         inset 0 -1px 0 rgba(16,32,52,.035),
         0 12px 38px rgba(16,32,52,.10),
         0 1px 2px rgba(16,32,52,.055);
}

/* 深色主题 */
.yq-root[data-tone="dark"]{
  --glass:linear-gradient(148deg,rgba(44,55,72,.52),rgba(26,33,45,.36));
  --edge:rgba(255,255,255,.095);
  --lift:inset 0 1px 0 rgba(255,255,255,.13),
         inset 0 -1px 0 rgba(0,0,0,.20),
         0 14px 44px rgba(0,0,0,.36),
         0 1px 2px rgba(0,0,0,.22);
}

/* 软玻璃下按钮更轻，避免「贴纸感」 */
.yq-root[data-tone="dark"] .yq-btn{
  background:rgba(255,255,255,.05);
  border-color:rgba(255,255,255,.115);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.09);
}
.yq-root[data-tone="dark"] .yq-btn:hover:not(:disabled){
  background:rgba(255,255,255,.095);
  border-color:rgba(255,255,255,.19);
}
.yq-root[data-tone="dark"] .yq-chip{
  background:rgba(255,255,255,.042);
  border-color:rgba(255,255,255,.085);
}

/* 边缘流光在软玻璃上更淡，否则像描了一圈霓虹 */
.yq-glass::after{ opacity:.32 }
.yq-root[data-tone="dark"] .yq-glass::after{ opacity:.44 }

/* 深色宿主：整套回到原来的深色配方（2026-10-25 起由 JS 探测后设置 data-tone） */
.yq-root[data-tone="dark"]{
  /* 深色变体：玻璃变透明玻璃，字才跟着变浅 —— 成对切换，不是各改各的 */
  --ink:#e8eef6; --dim:#a7b6c8; --faint:#7d8da3;
  --glass:linear-gradient(148deg,rgba(30,38,50,.88),rgba(22,29,40,.72));
  --edge:rgba(255,255,255,.15);
  --lift:inset 1.5px 0 0 rgba(255,122,122,.15),inset -1.5px 0 0 rgba(122,172,255,.17),
         inset 0 1px 0 rgba(255,255,255,.30),inset 0 -1px 0 rgba(0,0,0,.14),
         0 10px 34px rgba(0,0,0,.26),0 1px 2px rgba(0,0,0,.16);
  --code-bg:rgba(0,0,0,.30);
  background:
    radial-gradient(1200px 480px at 10% -14%, rgba(56,132,255,.17), transparent 62%),
    radial-gradient(900px 420px at 92% 4%,  rgba(147,86,255,.13), transparent 58%),
    radial-gradient(760px 360px at 60% 108%,rgba(52,211,153,.08), transparent 60%);
}
.yq-root[data-accent="ok"]{--accent:var(--ok)}
.yq-root[data-accent="warn"]{--accent:var(--warn)}
.yq-root[data-accent="error"]{--accent:var(--error)}
.yq-root[data-accent="pending"]{--accent:var(--pending)}

/* ★★ 刻意不写 backdrop-filter —— 见上面 .yq-root 里的说明。想找回来别直接加，
   先在砚台的「速达」页（一卡 300 图标）上滚一遍，确认不闪。 */
.yq-glass{
  position:relative;
  background:var(--glass);
  border:1px solid var(--edge);
  box-shadow:var(--lift);
  border-radius:16px;
  overflow:hidden;
}

/* ── 顶部：状态球 + 一句话结论 ───────────────────────────────── */
.yq-hero{
  display:flex; align-items:center; gap:14px;
  padding:16px 18px; margin-bottom:12px; overflow:hidden;
}
/* 掠过的高光：只用 transform，走合成层 */
.yq-hero::before{
  content:""; position:absolute; top:-20%; bottom:-20%; left:-30%; width:26%;
  background:linear-gradient(90deg,transparent,rgba(255,255,255,.11),transparent);
  transform:skewX(-18deg); pointer-events:none;
  animation:yq-sheen 8s ease-in-out infinite;
}
@keyframes yq-sheen{
  0%,100%{transform:translateX(0) skewX(-18deg)}
  55%    {transform:translateX(760%) skewX(-18deg)}
}
.yq-orb{
  position:relative; width:48px; height:48px; flex:0 0 48px;
  display:grid; place-items:center; border-radius:50%;
  background:radial-gradient(circle at 34% 28%,rgba(255,255,255,.20),rgba(255,255,255,.02) 62%);
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.14),0 0 22px -6px var(--accent);
}
.yq-orb::before{
  content:""; position:absolute; inset:-3px; border-radius:50%;
  background:conic-gradient(from 0deg,transparent 0%,var(--accent) 22%,transparent 46%);
  animation:yq-spin 4.2s linear infinite; opacity:.9;
  -webkit-mask:radial-gradient(circle,transparent 58%,#000 60%);
  mask:radial-gradient(circle,transparent 58%,#000 60%);
}
@keyframes yq-spin{to{transform:rotate(360deg)}}
.yq-orb-core{ position:relative; font-size:21px; line-height:1; color:var(--accent); font-weight:700 }
.yq-hero-txt{ flex:1; min-width:0 }
.yq-hero-txt h2{
  margin:0 0 2px; font-size:17px; font-weight:650; letter-spacing:.2px;
  display:flex; align-items:baseline; gap:8px;
}
.yq-hero-txt h2 small{ font-size:11.5px; font-weight:400; color:var(--dim); letter-spacing:0 }
.yq-hero-sub{ margin:0; font-size:12px; color:var(--dim); white-space:nowrap; overflow:hidden; text-overflow:ellipsis }
.yq-hero-sub b{ color:var(--accent); font-weight:600 }

/* ── 按钮 ────────────────────────────────────────────────── */
.yq-btn{
  padding:6px 13px; border-radius:10px; font-size:12px; cursor:pointer;
  /* ★ 2026-11-01：原来是 rgba(255,255,255,.055) —— 那是「深色底上的白色薄雾」，
     在白色玻璃上等于什么都没画，按钮完全看不出边界。改成深色系。 */
  color:var(--ink); background:rgba(16,32,52,.075);
  border:1px solid rgba(16,32,52,.20);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.70), 0 1px 2px rgba(16,32,52,.06);
  transition:background .18s ease,transform .12s ease,border-color .18s ease;
}
.yq-btn:hover:not(:disabled){ background:rgba(16,32,52,.13); border-color:rgba(16,32,52,.32) }
.yq-btn:active:not(:disabled){ transform:scale(.97) }
.yq-btn:disabled{ opacity:.45; cursor:default }
.yq-btn-primary{
  background:linear-gradient(140deg,rgba(96,165,250,.42),rgba(96,165,250,.22));
  border-color:rgba(96,165,250,.55);
}

/* ── 四个指标 ─────────────────────────────────────────────── */
.yq-metrics{ display:grid; grid-template-columns:repeat(4,1fr); gap:9px; margin-bottom:11px }
.yq-metric{
  padding:11px 8px 9px; text-align:center; overflow:hidden;
}
.yq-metric .n{
  font-size:27px; line-height:1.05; font-weight:680; letter-spacing:-.5px;
  font-variant-numeric:tabular-nums; color:var(--ink);
  animation:yq-pop .42s cubic-bezier(.34,1.56,.64,1) both;
}
@keyframes yq-pop{ from{transform:scale(.72);opacity:.35} to{transform:scale(1);opacity:1} }
.yq-metric .k{ font-size:10.5px; color:var(--dim); margin-top:2px; letter-spacing:.4px }
.yq-metric.lit-error{ box-shadow:var(--lift),0 0 26px -10px var(--error) }
.yq-metric.lit-warn { box-shadow:var(--lift),0 0 26px -10px var(--warn) }
.yq-metric.lit-ok   { box-shadow:var(--lift),0 0 26px -10px var(--ok) }
.yq-metric.lit-error .n{ color:var(--error) }
.yq-metric.lit-warn  .n{ color:var(--warn) }
.yq-metric.lit-ok    .n{ color:var(--ok) }
.yq-metric.lit-error .k,.yq-metric.lit-warn .k,.yq-metric.lit-ok .k{ color:var(--dim) }

/* ── 工具条：等级 + 时间 ───────────────────────────────────── */
.yq-bar{
  display:flex; align-items:center; gap:7px; flex-wrap:wrap;
  padding:9px 12px; margin-bottom:11px; font-size:12px; color:var(--dim);
}
/* ★ 2026-11-01：原来是 rgba(0,0,0,.24) 的深黑槽 —— 白玻璃上是一块突兀的黑。
   改成「比玻璃再深一档的灰」，视觉上像玻璃上刻出的凹槽。 */
.yq-seg{
  display:flex; gap:3px; padding:3px; border-radius:11px;
  background:rgba(16,32,52,.055);
  box-shadow:inset 0 1px 2px rgba(16,32,52,.14), inset 0 0 0 1px rgba(16,32,52,.06);
}
.yq-seg button{
  padding:4px 11px; border-radius:8px; font-size:12px; cursor:pointer;
  /* 未选中态给一点底色 —— 纯透明时它在凹槽里像一段灰字，看不出可点 */
  background:rgba(16,32,52,.045); border:0; font-weight:500; color:var(--dim);
  transition:background .2s ease,color .2s ease;
}
.yq-seg button:hover{ color:var(--ink) }
.yq-seg button[data-on="1"]{
  background:linear-gradient(140deg,rgba(96,165,250,.92),rgba(59,130,246,.78));
  color:#fff; box-shadow:inset 0 1px 0 rgba(255,255,255,.34),0 2px 8px -3px rgba(37,99,235,.55);
}
.yq-bar .sp{ flex:1 }
.yq-chip{
  padding:2px 8px; border-radius:999px; font-size:11px; color:var(--dim);
  background:rgba(16,32,52,.045); border:1px solid rgba(16,32,52,.10);
}
.yq-note{ margin:-4px 0 9px; font-size:11.5px; color:var(--dim) }

/* ── 趋势 ────────────────────────────────────────────────── */
.yq-trend{ padding:10px 12px 8px; margin-bottom:11px }
.yq-trend-h{ display:flex; align-items:baseline; gap:8px; font-size:11px; color:var(--dim); margin-bottom:6px }
.yq-trend-h b{ color:var(--ink); font-weight:600; font-size:11.5px }
.yq-bars{
  display:flex; align-items:flex-end; justify-content:flex-start;
  gap:1.5px; height:32px; min-height:32px;
}
.yq-bars i{
  /* ★ 2026-11-01：原来只有 flex:1 —— 只有 1 条数据时它被拉成整行宽的黄条，
     看着像一条报错横幅。给个上限：多条目时仍按比例分，单条目时最多 18px。 */
  flex:1; max-width:18px; min-width:2px; border-radius:2px 2px 1px 1px; display:block;
  background:var(--ok); opacity:.72;
  animation:yq-grow .5s ease both; transform-origin:bottom;
}
@keyframes yq-grow{ from{transform:scaleY(.05)} to{transform:scaleY(1)} }
.yq-bars i[data-s="warn"]{ background:var(--warn); opacity:.95 }
.yq-bars i[data-s="error"]{ background:var(--error); opacity:1 }
.yq-empty{ font-size:11px; color:var(--faint); padding:8px 2px }

/* ── 检测项 ───────────────────────────────────────────────── */
.yq-sec-h{
  display:flex; align-items:center; gap:8px;
  font-size:11px; color:var(--dim); margin:0 2px 7px; letter-spacing:.3px;
}
.yq-sec-h::after{ content:""; flex:1; height:1px; background:linear-gradient(90deg,rgba(16,32,52,.16),transparent) }
.yq-check{
  padding:10px 13px; margin-bottom:7px; cursor:pointer;
  transition:transform .16s ease,box-shadow .2s ease;
}
.yq-check:hover{ transform:translateX(2px) }
.yq-check[data-s="error"]{ box-shadow:var(--lift),0 0 30px -12px var(--error) }
.yq-check[data-s="warn"] { box-shadow:var(--lift),0 0 30px -12px var(--warn) }
.yq-check-row{ display:flex; gap:9px; align-items:baseline; cursor:pointer; border-radius:8px }
.yq-check-row:focus-visible{ outline:2px solid var(--accent); outline-offset:3px }
.yq-dot{
  width:19px; height:19px; flex:0 0 19px; border-radius:50%;
  display:grid; place-items:center; font-size:11px; font-weight:700;
  transform:translateY(2px);
}
.yq-dot[data-s="ok"]     { color:var(--ok);     background:rgba(52,211,153,.14); box-shadow:inset 0 0 0 1px rgba(52,211,153,.32) }
.yq-dot[data-s="warn"]   { color:var(--warn);   background:rgba(251,191,36,.15); box-shadow:inset 0 0 0 1px rgba(251,191,36,.36); animation:yq-blink 2.4s ease-in-out infinite }
.yq-dot[data-s="error"]  { color:var(--error);  background:rgba(248,113,113,.16);box-shadow:inset 0 0 0 1px rgba(248,113,113,.42);animation:yq-blink 1.15s ease-in-out infinite }
.yq-dot[data-s="pending"]{ color:var(--pending);background:rgba(96,165,250,.14); box-shadow:inset 0 0 0 1px rgba(96,165,250,.32) }
@keyframes yq-blink{ 0%,100%{opacity:1} 50%{opacity:.42} }
.yq-check-name{ flex:0 0 118px; color:var(--ink); font-weight:560; font-size:12.5px }
.yq-check-detail{
  flex:1; min-width:0; font-size:12px; color:var(--dim);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
}
.yq-check[data-s="error"] .yq-check-detail,
.yq-check[data-s="warn"]  .yq-check-detail{ color:var(--ink); white-space:normal }
.yq-caret{ flex:0 0 auto; color:var(--faint); font-size:10px; transition:transform .2s ease }
.yq-caret[data-open="1"]{ transform:rotate(90deg) }
.yq-evidence{
  margin:9px 0 0 28px; padding:9px 11px; border-radius:10px;
  /* 2026-10-25：底色/描边/文字都改成主题变量，浅色宿主不再是一块黑洞 */
  background:var(--code-bg); border:1px solid var(--edge);
  font-family:ui-monospace,Consolas,monospace; font-size:11px; line-height:16.5px;
  color:var(--dim); white-space:pre-wrap; word-break:break-word;
  max-height:260px; overflow:auto;
}

/* ── 折叠的「其余正常」 ──────────────────────────────────── */
.yq-more{
  display:flex; align-items:center; gap:8px; padding:9px 13px; cursor:pointer;
  font-size:12px; color:var(--dim); margin-bottom:7px;
}
.yq-more:hover{ color:var(--ink) }
.yq-more .lane{ flex:1; height:1px; background:linear-gradient(90deg,rgba(255,255,255,.10),transparent) }
.yq-more-ok{ display:flex; flex-wrap:wrap; gap:6px; padding:2px 4px 8px 4px }
/* ★ 2026-10-23：原来这里是纯 <span>（只能悬停看 title），没有 onClick、没有 evidence。
   结果「N 项正常」点不开 —— **健康项反而最不可查**，那是假绿的温床。
   改成可点开的 chip：点一下展开这一项的 detail + evidence。 */
.yq-ok-chip{
  font-size:11px; color:var(--faint); padding:3px 9px; border-radius:999px;
  background:rgba(255,255,255,.035); border:1px solid rgba(255,255,255,.06);
  cursor:pointer; user-select:none; transition:all .15s ease;
}
.yq-ok-chip:hover{ color:var(--ink); border-color:rgba(255,255,255,.22); background:rgba(255,255,255,.07) }
.yq-ok-chip[data-on="1"]{ color:var(--ink); border-color:rgba(120,200,150,.45); background:rgba(120,200,150,.10) }
.yq-ok-body{ margin:2px 4px 8px 4px; padding:10px 12px }
.yq-ok-head{ display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; font-size:12px; line-height:18px }
.yq-ok-name{ font-weight:600 }
.yq-ok-detail{ color:var(--faint); font-size:11.5px; flex:1 1 auto }

/* ── 页脚 ────────────────────────────────────────────────── */
.yq-foot{
  margin-top:6px; padding:11px 13px; font-size:11px; line-height:17px; color:var(--faint);
}
.yq-foot code{ color:var(--dim); font-family:ui-monospace,Consolas,monospace; font-size:10.5px }

/* ══ YQ-MOTION-V1（2026-11-01）════════════════════════════════════
 * 爀曦：「顺带我们把整个界面的交互动画也设计一下吧」。
 *
 * 这一版只做两件事，都不改布局：
 *   ① 折叠展开从「硬切」变成有物理感的展开
 *   ② 把散落的 ease / linear 收拢成两条曲线（--swift 行进 / --spring 回弹）
 *
 * ★ 只碰 transform / opacity / grid-template-rows —— 这三个走合成层。
 *   绝不碰 width / height / top / left（那会触发重排，是「卡」的真正来源）。
 */

/* ① 折叠容器：0fr → 1fr 的网格过渡
   为什么不 max-height：要猜一个值，猜小了被截断、猜大了过渡变快；
   为什么不用 height:auto：不可动画。
   grid-template-rows 是唯一「内容自适应 + 可动画」的写法。 */
/* ══ YQ-FOLD-V3（2026-11-01 第三版）══════════════════════════════
 *
 * 走过两条弯路，把实测数据记在这里，免得再来一次：
 *
 *   headless Chromium 157 实测（_fold-test.html）：
 *     max-height 方案：展开高度 135.5px，上限 1400px
 *     grid 方案：    展开高度 88.4px，grid-template-rows=88.39px  ← 精确
 *   两个方案**都成立**，所以「不支持」不是原因。
 *
 *   ★ 真正的病是：**max-height 猜太大**。
 *     135.5 / 1400 ≈ 10% —— 动画在头 10% 的时间就走完视觉变化，
 *     剩下 90% 是空的。感知上就是「啪一下出来」，即硬切。
 *
 *   grid 的 1fr 是**内容真实高度**，不猜 —— 所以它才对。
 *
 * ★ 换回 grid，这次带齐两条必需：
 *     ① 子元素 min-height:0（否则 1fr 撑不住内容，会顶到自然高度）
 *     ② 子元素 overflow:hidden（否则收起时内容溢出可见）
 */
.yq-evidence-wrap{
  display:grid;
  grid-template-rows:0fr;
  opacity:0;
  transition:
    grid-template-rows .34s var(--spring),
    opacity .2s var(--swift),
    margin-top .34s var(--spring);
  margin-top:0;
}
/* ★ v4：正常项那套的折叠容器（和 .yq-evidence-wrap 同一套规则） */
/* ══ YQ-FOLD-V5（2026-11-01 第五版）════════════════════════════
 * ★ 一直漏掉的坑：**grid 折叠时，子元素的 margin 撑开 0fr**。
 *   .yq-evidence 原 margin:9px 0 0 28px
 *   .yq-ok-body   原 margin:2px 4px 8px 4px
 *   min-height:0 压不掉 margin —— 所以 grid-template-rows:0fr 实际不是 0。
 *   0fr→1fr 的动画从非零高度起步，头一段被 margin 吃掉，看起来就是「一下跳出来」。
 * ★ 修法：内层 margin 归零，间距交给 wrap 的 margin-top。
 */
.yq-ok-body-wrap{
  display:grid;
  grid-template-rows:0fr;
  opacity:0;
  transition:
    grid-template-rows .34s var(--spring),
    opacity .2s var(--swift),
    margin-top .34s var(--spring);
  margin-top:0;
}
.yq-ok-body-wrap[data-open="1"]{
  grid-template-rows:1fr;
  opacity:1;
  margin-top:6px;
}
/* 内层必须 min-height:0 + overflow:hidden，否则收起时撑不住 */
.yq-ok-body-wrap > .yq-ok-body{
  overflow:hidden;
  min-height:0;
  margin:0 !important;     /* ★ V5：margin 会撑开 0fr，必须归零 */
}

.yq-evidence-wrap[data-open="1"]{
  grid-template-rows:1fr;
  opacity:1;
  margin-top:8px;
}
/* ★ 内层必须同时有 min-height:0 和 overflow:hidden —— grid 收起的关键 */
.yq-evidence-wrap > .yq-evidence{
  overflow:hidden;
  min-height:0;
  margin:0 !important;     /* ★ V5：evidence 有 margin:9px 0 0 28px，会把 0fr 撑开 */
}

/* ② 曲线统一：把 ease 换成有方向的曲线
   --swift（.22,.61,.36,1）= 行进，快出慢收，适合「打开/进入」
   --spring（.34,1.56,.64,1）= 回弹，轻微过冲，适合「按下/弹起」 */
.yq-btn,
.yq-chip,
.yq-seg button,
.yq-check-row{
  transition-timing-function:var(--swift);
}
.yq-caret{
  transition:transform .26s var(--spring),color .2s var(--swift);
}
.yq-caret[data-open="1"]{
  transform:rotate(90deg);
}

/* ③ 卡片 hover 抬起 —— 只动 transform + 阴影，不动尺寸 */
.yq-check{
  transition:transform .22s var(--swift),box-shadow .22s var(--swift);
}
.yq-check:hover{
  transform:translateY(-1px);
}

/* ④ 展开时给内容一点「落下来」的感觉 */
@keyframes yq-settle{
  from{ transform:translateY(-3px); opacity:.6 }
  to  { transform:translateY(0);    opacity:1 }
}
.yq-evidence-wrap[data-open="1"] > .yq-evidence{
  animation:yq-settle .3s var(--swift) both;
}

/* ── 降级：用户关掉动效 / 系统要求减弱 ─────────────────────── */
.yq-root[data-motion="0"] *,
.yq-root[data-motion="0"] *,
.yq-root[data-motion="0"] *::before{ animation:none !important; transition:none !important }
/* 动效关掉时，折叠必须**立刻**显示，不能停在 0fr */
.yq-root[data-motion="0"] .yq-evidence-wrap,
.yq-root[data-motion="0"] .yq-ok-body-wrap{ grid-template-rows:1fr; opacity:1 }
.yq-root[data-motion="0"] .yq-evidence-wrap[data-open="0"]{ grid-template-rows:0fr; opacity:0 }
@media (prefers-reduced-motion: reduce){
  .yq-root *,.yq-root *::before{ animation:none !important; transition:none !important }
}

/* ══ 响应式（2026-11-01 加）════════════════════════════════════════
 * 原来 4 个指标卡是 grid-template-columns:repeat(4,1fr) 写死的，
 * 在窄容器（面板被拖窄 / 分屏）下每个卡只有 40px 宽，数字挤成一团。
 * 判据不是「屏幕多宽」，而是**这个面板自己剩多少地方** —— 所以用容器查询兜底，
 * 不支持时退回视口媒体查询。
 */
@media (max-width: 720px){
  .yq-metrics{ grid-template-columns:repeat(2,1fr) }
  .yq-bar{ row-gap:7px }
  .yq-hero{ flex-wrap:wrap }
  .yq-hero-txt{ flex-basis:100%; order:3 }
}
@media (max-width: 460px){
  .yq-metrics{ grid-template-columns:1fr 1fr; gap:7px }
  .yq-metric{ padding:9px 6px 7px }
  .yq-metric .n{ font-size:23px }
  .yq-check-name{ flex-basis:auto; width:100% }
  .yq-check-row{ flex-wrap:wrap }
}
/* 支持容器查询的宿主：按面板自身宽度收，比视口准 */
@container (max-width: 620px){
  .yq-metrics{ grid-template-columns:repeat(2,1fr) }
}

/* ══ 液态动效（2026-11-01）════════════════════════════════════════
 * 灵感来自苹果 Liquid Glass，但**刻意不用 backdrop-filter** ——
 * 本文件开头就记着：那玩意让滚轮一动整个界面在闪（2026-10-02 实测）。
 *
 * 四件事构成「液态感」，全程只碰 transform / opacity / 一圈渐变：
 *   ① 边缘流光   —— 玻璃的湿润感（沿着圆角转的一道光）
 *   ② 弹簧曲线   —— 所有过渡走 spring，不走 linear / ease
 *   ③ 抬起与回弹 —— hover 抬 2px，按下压 4%
 *   ④ 高光跟随   —— hero 卡上的镜面高光跟著指针走（JS 写 --mx/--my）
 *
 * ★ 一律受 [data-motion="0"] 与 prefers-reduced-motion 约束（文件末尾已有那两段）。
 */

/* 弹簧曲线：苹果那种「过冲一点点再回来」的手感，不是 ease-out */
.yq-root{
  --spring:cubic-bezier(.34,1.56,.64,1);
  --swift:cubic-bezier(.22,.61,.36,1);
  --yq-mx:50%; --yq-my:0%;
}

/* 让 CSS 变量可以被 @keyframes 平滑推进（不支持的浏览器退化成静态光圈） */
@property --yq-a{ syntax:"<angle>"; initial-value:0deg; inherits:false }

/* ── ① 边缘流光 ─────────────────────────────────────────────── */
.yq-glass::after{
  content:""; position:absolute; inset:0; border-radius:inherit;
  pointer-events:none; padding:1px;
  background:conic-gradient(from var(--yq-a,0deg),
    transparent 0deg,
    rgba(255,255,255,.75) 26deg,
    rgba(160,205,255,.35) 52deg,
    transparent 96deg);
  /* 只保留 1px 边框那一圈，中间镂空 */
  -webkit-mask:linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite:xor;
  mask:linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask-composite:exclude;
  opacity:.5;
  animation:yq-edge 11s linear infinite;
}
@keyframes yq-edge{ to{ --yq-a:360deg } }
/* 深色玻璃上流光要亮一些才看得出 */
.yq-root[data-tone="dark"] .yq-glass::after{ opacity:.75 }

/* ── ② 弹簧过渡 ─────────────────────────────────────────────── */
.yq-glass,
.yq-btn,
.yq-seg button,
.yq-check{
  transition-timing-function:var(--spring);
}

/* ── ③ 抬起与回弹 ───────────────────────────────────────────── */
.yq-metric{
  transition:transform .38s var(--spring), box-shadow .38s var(--spring);
  will-change:transform;
}
.yq-metric:hover{ transform:translateY(-2px) scale(1.012) }
.yq-metric:active{ transform:translateY(0) scale(.992) }

.yq-check{ transition:transform .3s var(--spring), box-shadow .3s var(--spring) }
.yq-check:hover{ transform:translateX(2px) }
.yq-check:active{ transform:translateX(1px) scale(.995) }

.yq-btn{ transition:background .2s var(--swift), transform .16s var(--spring), border-color .2s var(--swift), box-shadow .2s var(--swift) }
.yq-btn:hover:not(:disabled){ transform:translateY(-1px) }
.yq-btn:active:not(:disabled){ transform:translateY(0) scale(.955) }

.yq-seg button{ transition:background .24s var(--spring), color .2s var(--swift), transform .18s var(--spring) }
.yq-seg button:active{ transform:scale(.94) }

/* ── ④ hero 镜面高光跟随指针 ────────────────────────────────── */
.yq-hero{
  /* 一层跟着指针走的柔光，压在掠光动画下面 */
  background-image:
    radial-gradient(220px circle at var(--yq-mx) var(--yq-my),
      rgba(255,255,255,.42), transparent 68%),
    var(--glass);
  transition:background-image .3s var(--swift);
}
.yq-root[data-tone="dark"] .yq-hero{
  background-image:
    radial-gradient(240px circle at var(--yq-mx) var(--yq-my),
      rgba(150,200,255,.16), transparent 70%),
    var(--glass);
}

/* 数字变化时轻轻泛一下光 —— 比单纯 scale 更像「液态」 */
@keyframes yq-glow{
  0%   { text-shadow:0 0 0 transparent }
  35%  { text-shadow:0 0 18px currentColor }
  100% { text-shadow:0 0 0 transparent }
}
.yq-metric .n{ animation:yq-pop .42s var(--spring) both, yq-glow 1.1s var(--swift) .1s 1 }

/* 状态球的呼吸：慢到几乎感觉不到，但让面板「活着」 */
@keyframes yq-breathe{ 0%,100%{ transform:scale(1) } 50%{ transform:scale(1.045) } }
.yq-orb{ animation:yq-breathe 5.5s var(--swift) infinite }
`;

    /* ★★ 2026-11-01 血案：这个函数原来用 「id 已存在就 return」做幂等，
       而 DSH 是单页应用 —— <style> 插进 <head> 后**不会随组件卸载移除**。
       于是改了 CSS 却没改 STYLE_ID 时，旧样式永远霸占着，新 CSS 一条都不生效。
       表现就是：组件结构换了、语义对了，但**样式全是旧的** → 折叠看着像硬切。

       ★ 修法两条一起上：
         ① 每次调用都**比对内容**，不一致就原地替换（不是只在缺失时插入）
         ② 顺手清掉所有旧版本号的同类 style（yq-echo-style-*） */
    function ensureStyle() {
      if (typeof document === "undefined") return;
      // 清掉历史版本
      for (const old of document.querySelectorAll('style[id^="yq-echo-style-"]')) {
        if (old.id !== STYLE_ID) old.remove();
      }
      const el = document.getElementById(STYLE_ID);
      if (el) {
        // ★ 关键：内容变了就重写，不能因为 id 存在就跳过
        if (el.textContent !== CSS) el.textContent = CSS;
        return;
      }
      const fresh = document.createElement("style");
      fresh.id = STYLE_ID;
      fresh.textContent = CSS;
      document.head.appendChild(fresh);
    }

    // 动效开关（存 localStorage，卡了就关）
    const MOTION_KEY = "yq-echo-motion";
    function readMotion() {
      try { return localStorage.getItem(MOTION_KEY) !== "0"; } catch { return true; }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // 渲染
    // ══════════════════════════════════════════════════════════════════════════
    const h = react.createElement;

    function Metric(props) {
      const lit = props.value > 0 && props.tone ? " lit-" + props.tone : "";
      return h("div", { className: "yq-glass yq-metric" + lit },
        // key 变化 → React 重建节点 → CSS 动画重新播放（数字跳动）
        h("div", { className: "n", key: String(props.value) }, String(props.value)),
        h("div", { className: "k" }, props.label)
      );
    }

    /* ── 宿主主题探测（2026-10-25）─────────────────────────────────
       宿主主题变量是成对赋值的：浅色主题给深字、深色主题给浅字 ——
       所以读到正文色的亮度就能判断当前是哪种主题，不用去猜背景色。
       ★ 坑一：getPropertyValue() 返回的是**未解析的 token**（例如 var(--dsw-static-neutral-bluish-50)），
         它不会自动展开，必须递归解。
       ★ 坑二：不要只看 document.body / html 的背景色 —— 桌面端这两个都是透明，
         之前三次探测都栽在这里。 */

    function resolveCssVar(name, depth) {
      const d = depth || 0;
      if (d > 6) return "";
      let raw = "";
      try {
        raw = (window.getComputedStyle(document.documentElement).getPropertyValue(name) || "").trim();
      } catch (e) { return ""; }
      if (!raw) return "";
      const m = /^var\(\s*(--[a-z0-9_-]+)\s*(?:,\s*([\s\S]+))?\)$/i.exec(raw);
      if (!m) return raw;
      return resolveCssVar(m[1], d + 1) || (m[2] || "").trim();
    }

    function rgbOf(value) {
      const s = String(value || "").trim();
      let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
      if (m) {
        let h = m[1];
        if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
      }
      m = /^rgba?\(([^)]+)\)$/i.exec(s);
      if (m) {
        const p = m[1].split(/[,\s\/]+/).filter(Boolean).map(Number);
        if (p.length >= 3 && p.slice(0, 3).every((x) => !isNaN(x))) return [p[0], p[1], p[2]];
      }
      return null;
    }

    function luminance(rgb) {
      return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
    }

    /* ★★ 2026-11-01 重写：探测源顺序改了。
       旧的只看 --dsw-alias-label-primary（文字色），实测它可能取不到 ——
       取不到就一路落到 prefers-color-scheme，而**系统是浅色、DSH 是深色主题**，
       于是判成 light → 白玻璃在深色界面里像一块白板（爀曦原话「深色就显得突兀了」）。

       新的顺序：**背景基色优先**（它就是主题的底色，比文字色直接），
       文字色作为佐证，最后才信系统偏好。
       ★ 每一级都试多个宿主节点：变量未必挂在 documentElement 上。 */

    /** 在多个宿主节点上找变量值 */
    function readVarAnywhere(name) {
      const roots = [];
      try { roots.push(document.documentElement); } catch (e) {}
      try { if (document.body) roots.push(document.body); } catch (e) {}
      for (const r of roots) {
        if (!r) continue;
        try {
          const raw = String(getComputedStyle(r).getPropertyValue(name) || "").trim();
          if (raw) {
            // 已经在某个节点上拿到了原始 token，就地递归解（resolveCssVar 只认 documentElement）
            const m = /^var\(\s*(--[a-z0-9_-]+)\s*(?:,\s*([\s\S]+))?\)$/i.exec(raw);
            if (m) {
              const inner = String(getComputedStyle(r).getPropertyValue(m[1]) || "").trim();
              if (inner) return inner;
              return (m[2] || "").trim();
            }
            return raw;
          }
        } catch (e) { /* 试下一个 */ }
      }
      return resolveCssVar(name);
    }

    /** @returns {"dark"|"light"} */
    function detectTone() {
      // ① 背景基色 —— 主题的底色，最直接。浅底=light 主题，深底=dark 主题
      const bgNames = [
        "--dsw-alias-bg-base",
        "--dsw-alias-bg-module-platform",
        "--dsw-alias-markdown-code-block",
      ];
      for (const n of bgNames) {
        const c = rgbOf(readVarAnywhere(n));
        if (c) return luminance(c) > 0.5 ? "light" : "dark";
      }

      // ② 文字色佐证（成对赋值：深色主题给浅字）
      const ink = rgbOf(readVarAnywhere("--dsw-alias-label-primary"));
      if (ink) return luminance(ink) > 0.5 ? "dark" : "light";

      // ③ 退化：向上找第一个非透明背景
      try {
        let el = document.body;
        while (el) {
          const bg = String(window.getComputedStyle(el).backgroundColor || "").replace(/\s+/g, "");
          if (bg && bg !== "rgba(0,0,0,0)" && bg !== "transparent") {
            const c = rgbOf(bg);
            if (c) return luminance(c) > 0.5 ? "light" : "dark";
          }
          el = el.parentElement;
        }
      } catch (e) { /* 落到下一步 */ }

      // ④ 最后才信系统偏好
      try {
        if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
      } catch (e) { /* ignore */ }
      return "light";
    }

    /* 折叠只认 header，且「正在选字」时不折叠。
       click 是「按下 + 抬起」才派发 —— 拖选文字松手也会触发，
       所以整卡 onClick 会把「选中一段 evidence 复制」变成「卡片收起」。 */
    function selectionActive() {
      try {
        const sel = window.getSelection && window.getSelection();
        return !!(sel && String(sel).length > 0);
      } catch (e) { return false; }
    }

    function headClick(onToggle) {
      return function () {
        if (selectionActive()) return;   // 正在选字 → 不动
        onToggle();
      };
    }

    function CheckCard(props) {
      const c = props.item;
      const toggle = headClick(props.onToggle);
      return h("div", {
          className: "yq-glass yq-check",
          "data-s": c.status,
        },
        /* ★ 2026-10-25：onClick 从整张卡片移到 header 行。
           整卡可点 ⇒ 想选中 evidence 里的文字也会折叠；拖选后松手同样派发 click。 */
        h("div", {
            className: "yq-check-row",
            role: "button",
            tabIndex: 0,
            "aria-expanded": props.open ? "true" : "false",
            onClick: toggle,
            onKeyDown: (e) => {
              if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
            },
          },
          h("span", { className: "yq-dot", "data-s": c.status }, ICON[c.status] || "·"),
          h("span", { className: "yq-check-name" }, c.label),
          h("span", { className: "yq-check-detail" }, c.detail),
          h("span", { className: "yq-caret", "data-open": props.open ? "1" : "0" }, "▶")
        ),
        /* ★ 2026-11-01：原来是 `props.open ? h("pre") : null` —— 节点直接不存在，
           所以展开/收起是硬切，没有任何过渡。改成**始终渲染**，用 CSS 网格过渡
           （grid-template-rows: 0fr → 1fr），这个属性走合成层，不触发重排。 */
        h("div", { className: "yq-evidence-wrap", "data-open": props.open ? "1" : "0" },
          h("pre", { className: "yq-evidence" }, JSON.stringify(c.evidence, null, 2))
        )
      );
    }

    function EchoPanel() {
      const [d, setD] = react.useState(null);
      const [st, setSt] = react.useState(null);
      const [lv, setLv] = react.useState(null);
      react.useEffect(function () {
        var pull = function () {
          fetch(API + "/settings").then(function (r) { return r.json() }).then(function (j) {
            if (j && j.settings) setSt(j.settings);
            if (j && j.live) setLv(j.live);
          }).catch(function () {});
        };
        pull();
        var t = setInterval(pull, 30000);
        return function () { clearInterval(t) };
      }, []);
      const [open, setOpen] = react.useState({});
      const [showOk, setShowOk] = react.useState(false);
      const [note, setNote] = react.useState(null);
      const [busy, setBusy] = react.useState(false);
      const [motion, setMotion] = react.useState(readMotion);
      /* ★ 2026-11-01 第二次加（第一次把面板弄空了）：
         这回改完先跑 dsh-echo-smoke.mjs，过了才部署。
         soft = 真模糊（苹果感）；flat = 纯渐变（滚轮最省）。 */
      const [glass, setGlass] = react.useState(() => {
        try {
          const v = localStorage.getItem("yq-echo-glass");
          return v === "flat" ? "flat" : "soft";
        } catch (e) { return "soft"; }
      });
      // ★ 2026-10-25：宿主主题探测。首帧就用真实主题，避免白字打白玻璃；
      // 之后监听 html 的 class/style 变化（宿主切主题会动这些），节流 120ms 重算。
      const [tone, setTone] = react.useState(detectTone);
      react.useEffect(function () {
        setTone(detectTone());
        let t = 0;
        const recheck = function () {
          if (t) return;
          t = setTimeout(function () { t = 0; setTone(detectTone()); }, 120);
        };
        let mo = null;
        try {
          mo = new MutationObserver(recheck);
          mo.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["class", "style", "data-theme", "data-tone", "data-mode"],
          });
        } catch (e) { mo = null; }
        return function () {
          if (t) clearTimeout(t);
          if (mo) mo.disconnect();
        };
      }, []);
      // ★ 换气检测层（2026-10-19）：换气每一轮结束写一条判词，这里只负责显示。
      const [hq, setHq] = react.useState(null);
  const [showHq, setShowHq] = react.useState(false);

      react.useEffect(() => { ensureStyle(); }, []);

      // 每 2 秒拉一次 —— 读的是宿主半的内存缓存，微秒级
      react.useEffect(() => {
        let stop = false;
        const pull = () =>
          fetch(API + "/status")
            .then((r) => r.json())
            .then((j) => { if (!stop) setD(j); })
            .catch(() => { /* 宿主半没起来时静默 */ });
        pull();
        const t = setInterval(pull, 2000);
        return () => { stop = true; clearInterval(t); };
      }, []);

      // 换气：10 秒拉一次 —— 它不是每 2 秒变的东西，而 JSONL 最多 2000 行
      react.useEffect(() => {
        let stop = false;
        const pullHq = () =>
          fetch(API + "/huanqi?limit=60")
            .then((r) => r.json())
            .then((j) => { if (!stop) setHq(j); })
            .catch(() => { /* 宿主半没起来时静默 */ });
        pullHq();
        const t = setInterval(pullHq, 10000);
        return () => { stop = true; clearInterval(t); };
      }, []);

      const post = (path, msg) => {
        setBusy(true);
        setNote(msg);
        return fetch(API + path, { method: "POST" })
          .then((r) => r.json())
          .then((j) => fetch(API + "/status").then((r) => r.json()).then((s) => { setD(s); return j; }))
          .then((j) => { setNote(null); return j; })
          .catch((e) => { setNote("✗ " + String((e && e.message) || e)); })
          .then((j) => { setBusy(false); return j; });
      };

      const toggleMotion = () => {
        const next = !motion;
        setMotion(next);
        try { localStorage.setItem(MOTION_KEY, next ? "1" : "0"); } catch {}
      };
      const toggleGlass = () => {
        const next = glass === "soft" ? "flat" : "soft";
        setGlass(next);
        try { localStorage.setItem("yq-echo-glass", next); } catch (e) {}
      };

      const checks = (d && d.checks) || [];
      const counts = (d && d.counts) || { error: 0, warn: 0, ok: 0, pending: 0 };
      const overall = d ? d.overall : "pending";
      const hist = (d && d.history) || [];
      const warming = !d || d.warming;

      // 有问题的浮到上面，正常的收进折叠区
      const RANK = { error: 0, warn: 1, pending: 2, ok: 3, info: 4 };
      const hot = checks
        .filter((c) => c.status !== "ok")
        .sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9));
      const good = checks.filter((c) => c.status === "ok");

      const problems = counts.error + counts.warn;

      // 一句人话结论
      let headline;
      if (warming) headline = "首次体检中…";
      else if (counts.error > 0) headline = counts.error + " 项故障，要看看";
      else if (counts.warn > 0) headline = counts.warn + " 项需要注意";
      else headline = "全部正常";

      const subline = warming
        ? "正在等第一次体检结果"
        : counts.ok + " 项通过" +
          (counts.warn ? " · " + counts.warn + " 项注意" : "") +
          (counts.error ? " · " + counts.error + " 项故障" : "") +
          (counts.pending ? " · " + counts.pending + " 项待深检" : "");

      return h("div", {
          className: "yq-root",
          "data-accent": counts.error ? "error" : counts.warn ? "warn" : warming ? "pending" : "ok",
          "data-motion": motion ? "1" : "0",
          "data-glass": glass,
          "data-tone": tone || undefined,
        },

        // ── 顶部：状态球 + 结论 ──────────────────────────────
        h("div", {
          className: "yq-hero yq-glass",
          /* ★ 2026-11-01：镜面高光跟随指针。
             只挂在 hero 这一张大卡上 —— 每张卡都挂 mousemove 会把事件频率乘以卡数。
             rAF 节流：一帧最多写一次 CSS 变量，样式重算被压到 60fps 以内。 */
          onPointerMove: (e) => {
            if (!motion) return;
            const el = e.currentTarget;
            if (el._yqRaf) return;
            el._yqRaf = requestAnimationFrame(() => {
              el._yqRaf = 0;
              const r = el.getBoundingClientRect();
              el.style.setProperty("--yq-mx", ((e.clientX - r.left) / r.width * 100).toFixed(1) + "%");
              el.style.setProperty("--yq-my", ((e.clientY - r.top) / r.height * 100).toFixed(1) + "%");
            });
          },
          onPointerLeave: (e) => {
            e.currentTarget.style.setProperty("--yq-mx", "50%");
            e.currentTarget.style.setProperty("--yq-my", "0%");
          },
        },
          h("div", { className: "yq-orb" },
            h("span", { className: "yq-orb-core" }, ICON[overall] || "·")
          ),
          h("div", { className: "yq-hero-txt" },
            h("h2", null, "回声 Echo", h("small", null, LABEL[overall] || overall)),
            h("p", { className: "yq-hero-sub" }, headline, "　·　", subline)
          ),
          h("div", { style: { display: "flex", gap: 6, flex: "0 0 auto" } },
            h("button", {
              className: "yq-btn yq-btn-primary",
              onClick: () => post("/scan", "手动体检中（快检 ~1s + 深检 ~10s）…"),
              disabled: busy,
            }, busy ? "体检中…" : "立即体检"),
            h("button", {
              className: "yq-btn",
              onClick: () => post("/rebuild", "重建索引 + 装配 SELF（约 40 秒）…"),
              disabled: busy,
              title: "重建 L4 索引并重新装配 SELF（会写 index/ 与 SELF.md）",
            }, "重建索引")
          )
        ),

        // ── 四个指标 ─────────────────────────────────────────
        h("div", { className: "yq-metrics" },
          h(Metric, { value: counts.error, label: "故障", tone: "error" }),
          h(Metric, { value: counts.warn, label: "注意", tone: "warn" }),
          h(Metric, { value: counts.ok, label: "健康", tone: counts.ok ? "ok" : null }),
          h(Metric, { value: counts.pending || 0, label: "待深检" })
        ),

        // ── 工具条 ───────────────────────────────────────────
        h("div", { className: "yq-bar yq-glass" },
          h("span", { style: { fontSize: 11.5 } }, "等级"),
          h("div", { className: "yq-seg" },
            LEVELS.map((lv) =>
              h("button", {
                key: lv.n,
                "data-on": d && d.level === lv.n ? "1" : "0",
                onClick: () => post("/level?n=" + lv.n, "切到 " + lv.name + "（" + lv.every + "）…"),
                title: lv.name + "：" + lv.every + "轮询一次",
              }, lv.name)
            )
          ),
          h("span", { className: "sp" }),
          h("span", { className: "yq-chip" }, "快检 " + fmtAge(d && d.fastAgeMs)),
          h("span", { className: "yq-chip" }, "深检 " + fmtAge(d && d.deepAgeMs)),
          !warming && d && d.nextFastInMs != null
            ? h("span", { className: "yq-chip" }, "下次 " + fmtIn(d.nextFastInMs))
            : null,
          h("button", {
            className: "yq-btn",
            onClick: toggleMotion,
            title: "动效开关：觉得卡就关掉（只影响动画，不影响读数）",
            style: { padding: "3px 9px", fontSize: 11 },
          }, motion ? "动效 开" : "动效 关"),
          h("button", {
            className: "yq-btn",
            onClick: toggleGlass,
            title: "玻璃质感：柔光（真模糊，更像苹果）／平铺（纯渐变，滚轮最省）",
            style: { padding: "3px 9px", fontSize: 11, marginLeft: 4 },
          }, glass === "soft" ? "柔光" : "平铺")
        ),

        // ── 记忆常驻（2026-11-01）──────────────────────────
        //   常驻天数 / 内存预算；写 echo-settings.json，echo-mcp 启动时读。
        //   ★ post() 是 POST 无 body，参数只能走 query。
        //   ★ 当前值来自 /api/settings（含 echo-mcp 写的 live 状态）。
        h("div", { className: "yq-bar yq-glass", style: { marginTop: 8, flexWrap: "wrap" } },
          h("span", { style: { fontSize: 11.5, fontWeight: 600 } }, "记忆常驻"),
          h("span", { style: { fontSize: 11.5 } }, "天数"),
          h("div", { className: "yq-seg" },
            [1, 3, 7, 14, 30].map(function (n) {
              var on = st && Number(st.logDays) === n;
              return h("button", {
                key: n,
                "data-on": on ? "1" : "0",
                onClick: function () { post("/settings?logDays=" + n, "常驻天数 → " + n + " 天（重启 DSH 生效）…") },
                title: "常驻最近 " + n + " 天的会话日志（1-30）",
              }, String(n));
            })
          ),
          h("span", { className: "sp" }),
          h("span", { style: { fontSize: 11.5 } }, "预算"),
          h("div", { className: "yq-seg" },
            [256, 512, 768, 1024].map(function (m) {
              var on = st && Number(st.memBudgetMB) === m;
              return h("button", {
                key: m,
                "data-on": on ? "1" : "0",
                onClick: function () { post("/settings?memBudgetMB=" + m, "内存预算 → " + m + " MB（重启 DSH 生效）…") },
                title: "常驻部分允许占用的内存上限",
              }, String(m) + "M");
            })
          )
        ),
        // ── 内存水位（读 echo-mcp 写的 live 状态）─────────────
        h("div", { className: "yq-bar yq-glass", style: { marginTop: 6, flexWrap: "wrap" } },
          h("span", { style: { fontSize: 11.5, fontWeight: 600 } }, "内存水位"),
          // ★ 2026-11-01：加一条**水位进度条**。
          //   光看「常驻 23.1 MB」看不出离预算还有多远 —— 有刻度才知道该不该调。
          h("span", { className: "yq-chip" }, "日志 " + (lv && lv.logs != null ? lv.logs : "—") + " 条"),
          h("span", {
            title: (lv && lv.memUsedMB != null ? lv.memUsedMB : "—") + " / "
              + (lv && lv.memBudgetMB != null ? lv.memBudgetMB : "—") + " MB",
            style: {
              width: "110px", height: "10px", borderRadius: "5px", flex: "none",
              background: "rgba(255,255,255,.10)", overflow: "hidden",
              border: "1px solid rgba(255,255,255,.10)",
            },
          },
            h("div", {
              style: {
                width: Math.max(0, Math.min(100, Math.round(
                  ((lv && lv.memUsedMB) || 0) / ((lv && lv.memBudgetMB) || 512) * 100
                ))) + "%",
                height: "100%",
                background: ((lv && lv.memPct) || 0) >= 85 ? "#f2604c"
                  : ((lv && lv.memPct) || 0) >= 60 ? "#f2b544" : "#3ddad7",
              },
            })
          ),
          h("span", { className: "yq-chip" },
            "常驻 " + (lv && lv.memUsedMB != null ? lv.memUsedMB : (lv && lv.logsMB != null ? lv.logsMB : "—"))
            + " / " + (lv && lv.memBudgetMB != null ? lv.memBudgetMB : "—") + " MB"),
          h("span", { className: "yq-chip" }, "进程 " + (lv && lv.rssMB != null ? lv.rssMB : "—") + " MB"),
          lv && lv.logsDropped > 0
            ? h("span", { className: "yq-chip", style: { color: "#f2b544" } },
                "超预算裁掉 " + lv.logsDropped + " 条")
            : null,
          h("span", { className: "sp" }),
          h("span", { style: { fontSize: 11, color: "var(--muted)" } },
            lv ? ("更新于 " + new Date(lv.updatedAt).toLocaleTimeString()) : "等 echo-mcp 写第一次状态…")
        ),


        note ? h("div", { className: "yq-note" }, note) : null,

        // ── 趋势 ─────────────────────────────────────────────
        h("div", { className: "yq-trend yq-glass" },
          h("div", { className: "yq-trend-h" },
            h("b", null, "趋势"),
            h("span", null, "最近 " + hist.length + " 次快检 · 柱高 = 问题数")
          ),
          hist.length === 0
            ? h("div", { className: "yq-empty" }, "还没有数据 —— 跑几次体检就有了")
            : h("div", { className: "yq-bars" },
                hist.map((it, i) => {
                  const n = it.error + it.warn;
                  const hh = n === 0 ? 3 : Math.min(30, 5 + n * 5);
                  return h("i", {
                    key: i,
                    "data-s": it.error ? "error" : it.warn ? "warn" : "ok",
                    style: { height: hh + "px", animationDelay: (i * 12) + "ms" },
                    title: it.t + "　" + it.error + " 错 / " + it.warn + " 警 / " + it.ok + " 好　" + it.ms + "ms　(" + it.why + ")",
                  });
                })
              )
        ),

        // ── 换气 · 每轮判词（2026-10-19） ─────────────────────
        // 这一块解决的是「不可视」：换气到底有没有在看着这一轮、
        // 它拿到的 kind 是什么、最后一条消息是什么形状、做出了什么判断。
        // 数据来自宿主半 /api/huanqi，源头是 state/huanqi-turns.jsonl。
        h("div", { className: "yq-glass", style: { borderRadius: 14, padding: "12px 14px" } },
          h("div", { style: { display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 8 } },
            h("b", { style: { fontSize: 13 } }, "换气 · 每轮判词"),
            h("span", { style: { fontSize: 11.5, opacity: 0.65 } },
              !hq
                ? "正在读…"
                : !hq.exists
                  ? "还没有记录"
                  : "共 " + hq.total + " 轮 · 近一小时 " + hq.lastHour + " 轮"
            ),
            h("span", { style: { flex: 1 } }),
            hq && hq.ledger
              ? h("span", { className: "yq-chip", title: "换气额度账本：" + hq.ledgerPath },
                  "额度 " + hq.ledger.credit + "/" + hq.ledger.creditMax)
              : null,
            hq && hq.ledger && hq.ledger.stats
              ? h("span", { className: "yq-chip", title: "累计：续命 / 熔断 / 异常" },
                  "续 " + hq.ledger.stats.continuations + " · 断 " + hq.ledger.stats.circuitBreaks)
              : null
          ),
          !hq || !hq.exists
            ? h("div", { className: "yq-empty" },
                hq && hq.exists === false
                  ? "换气还没在真实回合里跑过。等新版加载后，每个回合结束这里会多一行 —— 那时「它有没有在看着」就不再靠猜。"
                  : "正在读换气账本…")
            : h("div", { style: { display: "flex", flexDirection: "column", gap: 3 } },
                h("div", {
                  style: { display: "flex", gap: 8, fontSize: 10.5, opacity: 0.5, paddingBottom: 2 },
                },
                  h("span", { style: { flex: "0 0 56px" } }, "时刻"),
                  h("span", { style: { flex: "0 0 104px" } }, "结束原因"),
                  h("span", { style: { flex: "0 0 132px" } }, "最后一条"),
                  h("span", { style: { flex: 1 } }, "判词")
                ),
                hq.turns
                  .filter(function (t, i) {
                    // ★ 这一块的取舍：面板要看的是「有没有出事」，不是流水账。
                    // 出事的（续命 / 熔断）永远全显；正常的（skip:*）折叠时只留最近 2 条，
                    // 否则攒满就会把下面整片挤下去 —— 而它恰恰是最不需要天天看的部分。
                    var hd = String(t.verdict || "").split(":")[0];
                    if (hd === "continue" || hd === "circuit-break") return i < 6;
                    var calmIdx = hq.turns.slice(0, i).filter(function (x) {
                      var hx = String(x.verdict || "").split(":")[0];
                      return hx !== "continue" && hx !== "circuit-break";
                    }).length;
                    return calmIdx < (showHq ? 60 : 2);
                  })
                  .map((t, i) => {
                  const head = String(t.verdict || "").split(":")[0];
                  const tone =
                    head === "continue" ? "#f0b429" :
                    head === "circuit-break" ? "#f05a5a" : null;
                  return h("div", {
                      key: String(t.t || "") + i,
                      style: {
                        display: "flex", gap: 8, fontSize: 11.5,
                        fontFamily: "ui-monospace, Consolas, monospace",
                        opacity: head === "skip" ? 0.55 : 1,
                        color: tone || undefined,
                      },
                    },
                    h("span", { style: { flex: "0 0 56px", opacity: 0.75 } },
                      /* ★ 2026-10-23 修：原来这里直接 `String(t.t).slice(11,19)` —— 那是**字符串切片**，
                       *   取的是 ISO 里的 UTC 小时数，**没有转本地时区**。于是晚上 20:06 会被显示成
                       *   「12:06:06」，看起来像「面板停在中午不动了」。
                       *   判据：JSONL 里的 t 形如 `2026-10-23T12:06:06.884Z`，末尾那个 Z 就是 UTC；
                       *   而 mtime 是本地时间 —— 两者差整 8 小时，人眼一看就以为坏了。
                       *   现在按本地时区格式化；解析失败才退回原来的切片（至少不会空）。 */
                      (function (iso) {
                        if (!iso) return "--:--:--";
                        var d = new Date(iso);
                        if (isNaN(d.getTime())) return String(iso).slice(11, 19) || "--:--:--";
                        var p = function (n) { return (n < 10 ? "0" : "") + n; };
                        return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
                      })(t.t)),
                    h("span", { style: { flex: "0 0 104px" }, title: "turn/end 的 reason.kind" },
                      String(t.kind || "?")),
                    h("span", { style: { flex: "0 0 132px" }, title: "最后一条 assistant 消息的形状" },
                      String(t.shape || "?")),
                    h("span", { style: { flex: 1 } }, String(t.verdict || "?")),
                    /* ★ 2026-10-26（砚青落）：压缩列 —— 「换气到底有没有动手」。
                     *   数据来自 huanqi-turns.jsonl 的 compact 字段（宿主半整行透传）。
                     *   ★ 注意它是「**上一次**压缩的结果」：判词在压缩之前写，顺序决定。
                     *   没有这一列，压缩发生与否就只能翻日志 —— 那等于不可视。 */
                    h("span", {
                        style: { flex: "0 0 76px", opacity: t.compact ? 1 : 0.35 },
                        title: t.compact
                          ? "最近一次压缩：" + String(t.compact.kind) +
                            (t.compact.ok ? " 成功" : " 失败") +
                            (t.compact.range ? " seq " + t.compact.range.start + "–" + t.compact.range.end : "（无 seq）") +
                            (t.compact.error ? " · " + String(t.compact.error) : "")
                          : "这一轮之前没有发生过压缩",
                      },
                      t.compact
                        ? (t.compact.kind === "purge"
                            ? "清除·" + (Array.isArray(t.compact.purged) ? t.compact.purged.length : 0) + "条"
                            : t.compact.kind === "region" ? "压缩·范围" : "压缩·全量")
                          + (t.compact.ok ? " ✓" : " ✗")
                        : "—")
                  );
                }),
                hq.turns.length > 3
                  ? h("div", {
                      onClick: function () { setShowHq(!showHq); },
                      style: {
                        marginTop: 7, fontSize: 11, opacity: 0.6, cursor: "pointer",
                        userSelect: "none", letterSpacing: 0.2,
                      },
                    },
                      showHq
                        ? "收起 —— 正常记录只留最近 2 轮"
                        : "展开全部 " + hq.turns.length + " 轮（续命 / 熔断永远全显）")
                  : null
              )
        ),

        // ── 有问题的项（浮上来） ─────────────────────────────
        hot.length > 0
          ? h("div", { className: "yq-sec-h" }, problems > 0 ? "要看这些" : "待深检")
          : null,
        hot.map((c) =>
          h(CheckCard, {
            key: c.id,
            item: c,
            open: !!open[c.id],
            onToggle: () => setOpen(Object.assign({}, open, { [c.id]: !open[c.id] })),
          })
        ),

        // ── 正常的项（折叠） ─────────────────────────────────
        good.length > 0
          ? h("div", {
              className: "yq-more yq-glass",
              onClick: () => setShowOk(!showOk),
            },
            h("span", { className: "yq-dot", "data-s": "ok", style: { width: 16, height: 16, flex: "0 0 16px", fontSize: 10 } }, "✓"),
            h("span", null, good.length + " 项正常" + (showOk ? "" : "（点开看）")),
            h("span", { className: "lane" }),
            h("span", { className: "yq-caret", "data-open": showOk ? "1" : "0" }, "▶")
          )
          : null,
        showOk && good.length > 0
          ? h("div", { className: "yq-more-ok" },
              good.map((c) =>
                h("span", {
                  key: c.id,
                  className: "yq-ok-chip",
                  "data-on": open[c.id] ? "1" : "0",
                  title: "点击看这一项的实测（detail + evidence）",
                  onClick: (e) => {
                    e.stopPropagation();
                    setOpen(Object.assign({}, open, { [c.id]: !open[c.id] }));
                  },
                }, (open[c.id] ? "▾ " : "▸ ") + c.label)
              )
            )
          : null,
        /* ★ 2026-11-01 v4：这一套（正常项）原来也是**条件渲染** ——
           `showOk && good.some(open) ? h("div", ...) : null`
           所以点开时节点凭空出现，无论 CSS 写多好都不可能过渡。
           面板里 12 个正常项 / 3 个异常项 —— 用户点开的多半是正常项，
           而这正是前三版没修到的那一半。

           改成：**每一项各自一个始终渲染的 wrap**，靠 data-open 驱动 grid 过渡。
           代价是 DOM 里多 12 个空的 wrap（都是 max 4 行 div，可忽略）。
           ★ 用 `display:contents` 让未展开的 wrap 不参与布局，避免出现空行。 */
        showOk && good.length > 0
          ? h("div", null,
              good.map((c) =>
                h("div", {
                    key: "ev-" + c.id,
                    className: "yq-ok-body-wrap",
                    "data-open": open[c.id] ? "1" : "0",
                  },
                  h("div", { className: "yq-glass yq-ok-body" },
                    h("div", { className: "yq-ok-head" },
                      h("span", { className: "yq-dot", "data-s": c.status,
                        style: { width: 16, height: 16, flex: "0 0 16px", fontSize: 10 } }, ICON[c.status] || "✓"),
                      h("span", { className: "yq-ok-name" }, c.label),
                      h("span", { className: "yq-ok-detail" }, c.detail)
                    ),
                    h("pre", { className: "yq-evidence" }, JSON.stringify(c.evidence, null, 2))
                  )
                )
              )
            )
          : null,

        // ── 页脚 ─────────────────────────────────────────────
        h("div", { className: "yq-foot yq-glass" },
          h("div", null, "体检逻辑：", h("code", null, "memory/hub/echo-doctor.mjs"),
            " —— 命令行跑的是同一份"),
          h("div", null, "快检不看日志（约 0.9 秒）· 深检真去取一次门牌（约 9 秒）· 面板每 2 秒读一次缓存")
        )
      );
    }

    function apply(ctx) {
      // 和丹房并排：同一个槽位 conversation.view，order 8。
      ctx.slots.inject("conversation.view", () =>
        ctx.slots.register(
          { name: "conversation.view", id: "echo", order: 8, label: "回声" },
          () => react.createElement(EchoPanel)
        )
      );
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});
