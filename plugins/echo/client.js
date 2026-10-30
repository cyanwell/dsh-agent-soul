// dsh-agent-echo —— 浏览器半 v3（液态玻璃仪表盘）
//   ★ 历史名 dsh-yanqing-echo 已弃用；注释留着旧名会骗后来人（2026-10-25 改）
// ============================================================================
// 爀曦 2026-10-18 14:21：
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
  /* ★★ 这个 id 必须等于**包名**，而包名是 dsh-agent-echo。
   *   2026-10-26 00:39 我部署时把它写成了 dsh-agent-echo，
   *   而当时部署目录叫 dsh-yanqing-echo（本机专属命名）—— 两边对不上，
   *   client-modules 拿包名当 key 去对注册表，对不上就报
   *   "loaded without registering ... via __ModuleLoader__.load"，
   *   整个 web boot 批次随之不激活，界面直接弹「应用无法启动」。
   *   ★ 教训：改 client.js 或 package.json 的**任何一边**之前，
   *     先确认 `package.json.name === __ModuleLoader__.load({id})`，两边是一对。
   *   ★★ 2026-10-30：发布版统一回 dsh-agent-* 命名空间，本机部署目录
   *     dsh-yanqing-* 是安装时拷的副本 —— 仓库名与部署名可以不同，
   *     但**同一个包内** package.json.name 与 id 必须相等。 */
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
    const STYLE_ID = "yq-echo-style-v3";

    const CSS = `
.yq-root{
  --ok:#34d399; --warn:#fbbf24; --error:#f87171; --pending:#60a5fa;
  --ink:#e8eef6; --dim:#8b9bb0; --faint:#5b6b80;
  /* ★ 2026-10-18：玻璃配方改成和砚台同一套（去掉 backdrop-filter）。
     沿用砚台 client.js:28-45 那段的结论 —— 2026-10-02 实测「滚轮一动整个界面都在闪」，
     真凶就是 backdrop-filter：它让卡片成为 GPU 合成层，滚动时整卡连内容一起重绘。
     去掉之后视觉靠四样东西撑住：半透明底 / 有色散的内高光 / 厚度的上下边 / 大而散的外投影。 */
  --glass:linear-gradient(148deg,rgba(255,255,255,.075),rgba(255,255,255,.028));
  --edge:rgba(255,255,255,.15);
  --lift:inset 1.5px 0 0 rgba(255,122,122,.15),inset -1.5px 0 0 rgba(122,172,255,.17),
         inset 0 1px 0 rgba(255,255,255,.30),inset 0 -1px 0 rgba(0,0,0,.14),
         0 10px 34px rgba(0,0,0,.26),0 1px 2px rgba(0,0,0,.16);
  --accent:#60a5fa;
  position:relative; height:100%; overflow-y:auto; overflow-x:hidden;
  padding:14px 14px 20px; color:var(--ink); font-size:13px; line-height:20px;
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
  color:var(--ink); background:rgba(255,255,255,.055);
  border:1px solid rgba(255,255,255,.13);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.16);
  transition:background .18s ease,transform .12s ease,border-color .18s ease;
}
.yq-btn:hover:not(:disabled){ background:rgba(255,255,255,.10); border-color:rgba(255,255,255,.22) }
.yq-btn:active:not(:disabled){ transform:scale(.97) }
.yq-btn:disabled{ opacity:.45; cursor:default }
.yq-btn-primary{
  background:linear-gradient(140deg,rgba(96,165,250,.34),rgba(96,165,250,.14));
  border-color:rgba(96,165,250,.44);
}

/* ── 四个指标 ─────────────────────────────────────────────── */
.yq-metrics{ display:grid; grid-template-columns:repeat(4,1fr); gap:9px; margin-bottom:11px }
.yq-metric{
  padding:11px 8px 9px; text-align:center; overflow:hidden;
}
.yq-metric .n{
  font-size:27px; line-height:1.05; font-weight:680; letter-spacing:-.5px;
  font-variant-numeric:tabular-nums; color:var(--faint);
  animation:yq-pop .42s cubic-bezier(.34,1.56,.64,1) both;
}
@keyframes yq-pop{ from{transform:scale(.72);opacity:.35} to{transform:scale(1);opacity:1} }
.yq-metric .k{ font-size:10.5px; color:var(--faint); margin-top:2px; letter-spacing:.4px }
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
.yq-seg{ display:flex; gap:4px; padding:3px; border-radius:11px; background:rgba(0,0,0,.24); box-shadow:inset 0 1px 3px rgba(0,0,0,.4) }
.yq-seg button{
  padding:4px 11px; border-radius:8px; font-size:12px; cursor:pointer;
  background:transparent; border:0; color:var(--dim);
  transition:background .2s ease,color .2s ease;
}
.yq-seg button:hover{ color:var(--ink) }
.yq-seg button[data-on="1"]{
  background:linear-gradient(140deg,rgba(96,165,250,.36),rgba(96,165,250,.16));
  color:#fff; box-shadow:inset 0 1px 0 rgba(255,255,255,.24),0 2px 10px -4px var(--pending);
}
.yq-bar .sp{ flex:1 }
.yq-chip{
  padding:2px 8px; border-radius:999px; font-size:11px; color:var(--dim);
  background:rgba(255,255,255,.045); border:1px solid rgba(255,255,255,.08);
}
.yq-note{ margin:-4px 0 9px; font-size:11.5px; color:var(--dim) }

/* ── 趋势 ────────────────────────────────────────────────── */
.yq-trend{ padding:10px 12px 8px; margin-bottom:11px }
.yq-trend-h{ display:flex; align-items:baseline; gap:8px; font-size:11px; color:var(--dim); margin-bottom:6px }
.yq-trend-h b{ color:var(--ink); font-weight:600; font-size:11.5px }
.yq-bars{ display:flex; align-items:flex-end; gap:1.5px; height:32px }
.yq-bars i{
  flex:1; min-width:2px; border-radius:2px 2px 1px 1px; display:block;
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
.yq-sec-h::after{ content:""; flex:1; height:1px; background:linear-gradient(90deg,rgba(255,255,255,.13),transparent) }
.yq-check{
  padding:10px 13px; margin-bottom:7px; cursor:pointer;
  transition:transform .16s ease,box-shadow .2s ease;
}
.yq-check:hover{ transform:translateX(2px) }
.yq-check[data-s="error"]{ box-shadow:var(--lift),0 0 30px -12px var(--error) }
.yq-check[data-s="warn"] { box-shadow:var(--lift),0 0 30px -12px var(--warn) }
.yq-check-row{ display:flex; gap:9px; align-items:baseline }
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
.yq-check[data-s="warn"]  .yq-check-detail{ color:#cfd9e6; white-space:normal }
.yq-caret{ flex:0 0 auto; color:var(--faint); font-size:10px; transition:transform .2s ease }
.yq-caret[data-open="1"]{ transform:rotate(90deg) }
.yq-evidence{
  margin:9px 0 0 28px; padding:9px 11px; border-radius:10px;
  background:rgba(0,0,0,.30); border:1px solid rgba(255,255,255,.07);
  font-family:ui-monospace,Consolas,monospace; font-size:11px; line-height:16.5px;
  color:#9fb0c4; white-space:pre-wrap; word-break:break-word;
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

/* ── 降级：用户关掉动效 / 系统要求减弱 ─────────────────────── */
.yq-root[data-motion="0"] *,
.yq-root[data-motion="0"] *::before{ animation:none !important; transition:none !important }
@media (prefers-reduced-motion: reduce){
  .yq-root *,.yq-root *::before{ animation:none !important; transition:none !important }
}
`;

    function ensureStyle() {
      if (typeof document === "undefined") return;
      if (document.getElementById(STYLE_ID)) return;
      const el = document.createElement("style");
      el.id = STYLE_ID;
      el.textContent = CSS;
      document.head.appendChild(el);
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

    function CheckCard(props) {
      const c = props.item;
      return h("div", {
          className: "yq-glass yq-check",
          "data-s": c.status,
          onClick: props.onToggle,
        },
        h("div", { className: "yq-check-row" },
          h("span", { className: "yq-dot", "data-s": c.status }, ICON[c.status] || "·"),
          h("span", { className: "yq-check-name" }, c.label),
          h("span", { className: "yq-check-detail" }, c.detail),
          h("span", { className: "yq-caret", "data-open": props.open ? "1" : "0" }, "▶")
        ),
        props.open
          ? h("pre", { className: "yq-evidence" }, JSON.stringify(c.evidence, null, 2))
          : null
      );
    }

    function EchoPanel() {
      const [d, setD] = react.useState(null);
      const [open, setOpen] = react.useState({});
      const [showOk, setShowOk] = react.useState(false);
      const [note, setNote] = react.useState(null);
      const [busy, setBusy] = react.useState(false);
      const [motion, setMotion] = react.useState(readMotion);
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
        },

        // ── 顶部：状态球 + 结论 ──────────────────────────────
        h("div", { className: "yq-hero yq-glass" },
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
          }, motion ? "动效 开" : "动效 关")
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
                        ? (t.compact.kind === "region" ? "压缩·范围" : "压缩·全量") + (t.compact.ok ? " ✓" : " ✗")
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
        // ★ 2026-10-23：正常项的实测结果。点开哪个就展开哪个，可以同时展开多项。
        showOk && good.some((c) => open[c.id])
          ? h("div", null,
              good.filter((c) => open[c.id]).map((c) =>
                h("div", { key: "ev-" + c.id, className: "yq-glass yq-ok-body" },
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
          : null,

        // ── 页脚 ─────────────────────────────────────────────
        h("div", { className: "yq-foot yq-glass" },
          h("div", null, "体检逻辑：", h("code", null, "D:\\AI\\memory\\hub\\echo-doctor.mjs"),
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
