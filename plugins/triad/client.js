// dsh-yanqing-triad —— 浏览器半（三策 · 三合一工作台）
//
// 一个工作台，三块：项目（砚台甘特）/ 任务看板（五列）/ 三策（三张 agent 卡）。
//
// ★★★ 呈现方式（2026-10-27 改版）：**常驻窄版 + 点击展开全屏**，不再是独立整页。
//
//   ① 常驻窄版 → 挂 root 的 **`shell.overlay`**（list，绝对定位覆盖层），
//      贴在 **center 列左缘**（`[class*="_centerCol"]` 的 left），宽 300px。
//      因为 DSH **没有「侧栏和聊天区之间」这个槽位** —— root 只有 6 个子槽位：
//          sidebar / main / rightbar / shell.bottom / shell.overlay / shell.leading
//      三列 grid 写死 `sidebar | center | rightbar`，没有第四列；
//      `shell.leading` 只在 macOS（红绿灯位）且侧栏折叠时挂载，Windows 永不渲染；
//      `shell.bottom` 是整宽底条。证据见 30-状态\设计-三策插件.md 第九节。
//   ② 展开 → 同一个组件内 `inset:0` 铺满工作区（不是第二个页面、不是第二条数据）。
//   ③ 侧栏「三策」入口 + `main` keyed 整页 **保留**（点入口仍可看大页），
//      数据走同一个模块级 store + inflight 去重 ⇒ 全进程只打一次 /state。
//
// ★ 硬约束（改槽位时别破坏）：
//   · `main.key` 与 `sidebar.panellist.id` **必须同一个字符串**（PANEL_ID），
//     否则 Host 报 running、侧栏计数照加，点开却是空白。
//   · `__ModuleLoader__.load({ id })` 的 id **必须等于 package.json 的 name**。
//   · `ctx.slots.register(spec, X)` 第二个参数**必须是组件本身**。
//   · `exports.inject` 只写 ["slots"]。多写一个桌面端不存在的服务名，cordis 会一直等它，
//     apply 永不执行 —— 整包静默失效（砚台 client.js:9-11 记着这条实测）。
//
// ★★★ exports.inject 只写 ["slots"]。多写一个桌面端不存在的服务名，cordis 会一直等它，
//     apply 永不执行 —— 整包静默失效（砚台 client.js:9-11 记着这条实测）。
//
// ★ main.key 与 panellist.id 必须**同一个字符串**，否则 Host 报 running、侧栏计数照加，
//   点开却是空白。
window.__ModuleLoader__.load({
  id: "dsh-yanqing-triad",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var h = react.createElement;

    const PANEL_ID = "dsh-yanqing-triad";
    const API = "/yanqing-triad/api";

    // 五列：定义照抄看板插件 src/core/tasks.ts 的 COLUMNS
    const COLUMNS = [
      { status: "backlog", label: "待规划" },
      { status: "todo", label: "待办" },
      { status: "running", label: "进行中" },
      { status: "done", label: "已完成" },
      { status: "failed", label: "已失败" },
    ];
    const STATUS_ORDER = COLUMNS.map((c) => c.status);
    // 状态点颜色：照看板 board.module.css 的 .statusDot[data-status=…]，
    // 但用具体色值（主题 token 在插件里拿不到）
    // 颜色克制（设计稿 §10 ⑤）：只用中性灰 + 状态点色（绿 = 完成 / 蓝 = 进行中）。
    // 橙、青、红全部收掉 —— 全面板不出现第二个彩色系。
    const NEUTRAL = "#8e8e93";
    const STATUS_COLOR = {
      backlog: NEUTRAL,
      todo: NEUTRAL,
      running: "#0a84ff",
      done: "#30d158",
      failed: NEUTRAL,
    };

    // ── 材质 / 节奏 / 动效（设计稿 §10 ①②③④⑥）─────────────────────
    // 苹果式：中性灰 + 一个状态点色；圆角 16/12/8；留白 20/24/12/14·16。
    const HAIR = "1px solid rgba(255,255,255,0.08)";
    const B1 = HAIR; // 兼容仍在引用 B1 的旧位置
    const SURF = "rgba(255,255,255,0.04)";
    const SURF_HI = "rgba(255,255,255,0.09)";
    const EASE = "all 180ms cubic-bezier(0.32, 0.72, 0, 1)";
    // ★★ 2026-10-27 16:20 液态玻璃（Liquid Glass）—— 苹果 iOS 26 / macOS 26 那套材质。
    //   它和普通「毛玻璃」的差别就三点，缺一个就退回旧样子：
    //   ① 折射感：背景必须是**多段渐变**，不是一层单一 rgba（光穿过不同厚度才有层次）
    //   ② 镜面边缘：inset 1px 白线，且上缘比下缘亮一倍（光从上打下来）
    //   ③ 描边用 box-shadow 画，不用 border —— border 会吃进布局，把玻璃边切成硬直角
    const LIQUID = {
      background:
        "linear-gradient(158deg, rgba(255,255,255,0.115) 0%, rgba(255,255,255,0.048) 34%, rgba(255,255,255,0.028) 63%, rgba(255,255,255,0.075) 100%)",
      backdropFilter: "blur(40px) saturate(190%) brightness(1.04)",
      WebkitBackdropFilter: "blur(40px) saturate(190%) brightness(1.04)",
      boxShadow: [
        "inset 0 1px 0 rgba(255,255,255,0.24)",
        "inset 0 -1px 0 rgba(255,255,255,0.055)",
        "inset 1px 0 0 rgba(255,255,255,0.075)",
        "inset -1px 0 0 rgba(255,255,255,0.075)",
        "inset 0 0 24px rgba(255,255,255,0.028)",
        "0 0 0 1px rgba(255,255,255,0.06)",
        "0 20px 56px rgba(0,0,0,0.46)",
        "0 3px 12px rgba(0,0,0,0.20)",
      ].join(", "),
    };
    // 悬停只提亮 background，不放大（设计稿 §10 ⑥）
    function hov(base, hi) {
      return {
        onMouseEnter: (e) => {
          e.currentTarget.style.background = hi;
        },
        onMouseLeave: (e) => {
          e.currentTarget.style.background = base;
        },
      };
    }

    const S = {
      wrap: {
        // ★★★ 下面这段是 2026-10-27 的判断，**已被 2026-10-31 推翻** —— 保留作沿革，别照它改。
        //   当时写：原来 height:100% → flex item 被内容撑高 → 改 flex:1 1 auto + minHeight:0。
        //   那个推理本身没错（flex item 确实有 min-height:auto 的问题），
        //   但它**建立在一个错误的前提上：以为父级是 flex 容器**。
        //   真父级是 grid item（CenterColumn），flex 属性根本不生效 —— 见下面 10-31 那段。
        padding: "28px 32px 96px",
        fontSize: "13px",
        color: "inherit",
        // ★★★ 2026-10-31 最终版：**照抄砚台（dsh-yantai）的写法**。
        //
        //   砚台 client.js:66-67 就是这么跑通的：
        //     wrap: { height: "100%", overflowY: "auto", boxSizing: "border-box" }
        //   而且它**没有 display:flex** —— 这一点很关键：
        //   加了 flex column，子项会被当成 flex item（min-height:auto 又会来捣乱）；
        //   同时 height:100% 在 flex 上下文里的解析也更容易被打断。
        //
        //   我前面绕了两圈（flex:1 1 0% → maxHeight:100vh）都是在自己推，
        //   而砚台是**同一个宿主里已经跑通了的实证**。实证优先于推理。
        //
        //   height:100% 说明父级（renderSlot 出来的那层）**确实有确定高度** ——
        //   这同时回答了我之前"renderSlot 中间有没有包装层"的疑问：不管有没有，高度都传下来了。
        height: "100%",
        // ★ 双保险：万一某个父级链上高度没传到底，100vh 还能兜住（视口高度永远有值）。
        maxHeight: "100vh",
        overflowY: "auto",
        overflowX: "auto",
        overscrollBehavior: "contain",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        gap: "28px",
        minHeight: 0,
      },
      top: {
        display: "flex",
        alignItems: "center",
        gap: "12px",
        flexWrap: "wrap",
        paddingBottom: "16px",
        borderBottom: "1px solid rgba(255,255,255,0.07)",
      },
      title: { fontSize: "15px", fontWeight: 600, letterSpacing: "0.01em" },
      sub: { fontSize: "11px", fontWeight: 400, opacity: 0.4 },
      grow: { flex: "1 1 auto" },
      btn: {
        background: "rgba(255,255,255,0.06)",
        color: "inherit",
        border: HAIR,
        borderRadius: "8px",
        padding: "6px 12px",
        fontSize: "12px",
        fontWeight: 500,
        cursor: "pointer",
        fontFamily: "inherit",
        transition: EASE,
      },
      btnMini: {
        background: "rgba(255,255,255,0.05)",
        color: "inherit",
        border: HAIR,
        borderRadius: "8px",
        padding: "3px 9px",
        fontSize: "11px",
        fontWeight: 400,
        opacity: 0.85,
        cursor: "pointer",
        fontFamily: "inherit",
        lineHeight: "1.5",
        transition: EASE,
      },
      btnDel: {
        background: "transparent",
        color: "rgba(255,255,255,0.45)",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: "8px",
        padding: "3px 8px",
        fontSize: "11px",
        cursor: "pointer",
        fontFamily: "inherit",
        lineHeight: "1.5",
        transition: EASE,
      },
      sec: {
        border: HAIR,
        borderRadius: "16px",
        overflow: "hidden",
        background: "rgba(255,255,255,0.03)",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.03)",
      },
      secHead: {
        display: "flex",
        alignItems: "center",
        gap: "10px",
        padding: "14px 16px",
        background: "transparent",
        borderBottom: "1px solid rgba(255,255,255,0.06)",
        cursor: "pointer",
        userSelect: "none",
        transition: EASE,
      },
      secTitle: { fontSize: "12px", fontWeight: 500, letterSpacing: "0.02em", opacity: 0.5 },
      secCount: { fontSize: "11px", fontWeight: 400, opacity: 0.4 },
      secBody: { padding: "16px", display: "flex", flexDirection: "column", gap: "12px" },
      hint: { fontSize: "11px", fontWeight: 400, opacity: 0.4, lineHeight: "1.7" },
      err: {
        color: "rgba(255,255,255,0.92)",
        fontSize: "11px",
        lineHeight: "1.7",
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
      },
      code: {
        fontFamily: "ui-monospace, Consolas, monospace",
        fontSize: "11px",
        fontWeight: 400,
        opacity: 0.4,
        wordBreak: "break-all",
      },
      row: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" },
      // 甘特：灰阶，不引入第二个彩色
      gRow: { display: "flex", gap: "10px", alignItems: "center", height: "26px" },
      gLab: {
        width: "150px",
        flex: "0 0 auto",
        fontSize: "13px",
        fontWeight: 400,
        opacity: 0.85,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        cursor: "pointer",
        transition: EASE,
      },
      gTrack: { position: "relative", flex: "1 1 auto", height: "26px", minWidth: "160px" },
      gGrid: { position: "absolute", top: 0, bottom: 0, width: "1px", background: "rgba(255,255,255,0.06)" },
      gToday: { position: "absolute", top: 0, bottom: 0, width: "1px", background: "rgba(255,255,255,0.45)" },
      gPlan: {
        position: "absolute",
        top: "7px",
        height: "12px",
        boxSizing: "border-box",
        background: "rgba(255,255,255,0.10)",
        border: "1px solid rgba(255,255,255,0.14)",
        borderRadius: "6px",
      },
      gProg: {
        position: "absolute",
        top: "7px",
        height: "12px",
        borderRadius: "6px",
        background: "rgba(255,255,255,0.30)",
      },
      gTick: {
        position: "absolute",
        top: 0,
        fontSize: "11px",
        fontWeight: 400,
        opacity: 0.4,
        transform: "translateX(-50%)",
        whiteSpace: "nowrap",
      },
      note: {
        padding: "14px 16px",
        borderRadius: "12px",
        background: SURF,
        border: HAIR,
        fontSize: "12px",
        lineHeight: "1.7",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        maxHeight: "220px",
        overflowY: "auto",
      },
      // 看板
      cols: {
        display: "grid",
        gridAutoFlow: "column",
        gridAutoColumns: "minmax(178px, 1fr)",
        gap: "12px",
        overflowX: "auto",
        paddingBottom: "4px",
      },
      col: {
        display: "flex",
        flexDirection: "column",
        minHeight: "90px",
        borderRadius: "12px",
        border: "1px solid rgba(255,255,255,0.06)",
        background: "rgba(255,255,255,0.02)",
        padding: "12px",
        gap: "10px",
      },
      colHead: { display: "flex", alignItems: "center", gap: "7px", paddingBottom: "2px" },
      dot: (c) => ({ width: "9px", height: "9px", borderRadius: "50%", background: c, flex: "0 0 auto" }),
      colName: { fontSize: "12px", fontWeight: 500, flex: "1 1 auto", opacity: 0.55 },
      colNum: { fontSize: "11px", fontWeight: 400, opacity: 0.4, fontVariantNumeric: "tabular-nums" },
      card: {
        borderRadius: "12px",
        border: HAIR,
        background: SURF,
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        cursor: "grab",
        transition: EASE,
      },
      cardTitle: { fontSize: "13px", fontWeight: 500, wordBreak: "break-word", lineHeight: "1.45" },
      cardDesc: {
        fontSize: "11px",
        fontWeight: 400,
        opacity: 0.4,
        lineHeight: "1.6",
        overflow: "hidden",
        display: "-webkit-box",
        WebkitLineClamp: 3,
        WebkitBoxOrient: "vertical",
        wordBreak: "break-word",
      },
      cardOps: { display: "flex", gap: "6px", alignItems: "center", marginTop: "2px" },
      inp: {
        background: "rgba(255,255,255,0.05)",
        color: "inherit",
        border: HAIR,
        borderRadius: "8px",
        padding: "6px 10px",
        fontSize: "13px",
        outline: "none",
        width: "100%",
        boxSizing: "border-box",
        fontFamily: "inherit",
        transition: EASE,
      },
      // 三策卡
      agents: { display: "grid", gap: "12px", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))" },
      agent: {
        border: HAIR,
        borderRadius: "12px",
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        background: SURF,
        transition: EASE,
      },
      agentTop: { display: "flex", alignItems: "center", gap: "8px" },
      agentName: { fontSize: "13px", fontWeight: 500, flex: "1 1 auto" },
      agentRole: { fontSize: "11px", fontWeight: 400, opacity: 0.4, lineHeight: "1.6" },
      agentDesc: {
        fontSize: "11px",
        fontWeight: 400,
        opacity: 0.4,
        lineHeight: "1.6",
        overflow: "hidden",
        display: "-webkit-box",
        WebkitLineClamp: 3,
        WebkitBoxOrient: "vertical",
        wordBreak: "break-word",
      },
      pill: () => ({
        fontSize: "11px",
        fontWeight: 400,
        opacity: 0.4,
        whiteSpace: "nowrap",
      }),
    };

    // ── 小工具 ────────────────────────────────────────────────────────
    async function api(path, opts) {
      const r = await fetch(API + path, Object.assign({ headers: { "content-type": "application/json" } }, opts));
      const text = await r.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        throw new Error("接口返回的不是 JSON（HTTP " + r.status + "）：" + text.slice(0, 200));
      }
      if (!r.ok || data.ok === false) throw new Error(data.error || "HTTP " + r.status);
      return data;
    }

    // 日期一律走本地时间 —— 砚台 client.js:297-298 记着：用 toISOString() 会整天差一天
    const GDAY = 86400000;
    function dayMs(s) {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ""));
      if (!m) return NaN;
      return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    }
    function md(ms) {
      const d = new Date(ms);
      return d.getMonth() + 1 + "/" + d.getDate();
    }
    function iso(ms) {
      const d = new Date(ms);
      const p2 = (n) => String(n).padStart(2, "0");
      return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate());
    }
    function ago(ms) {
      if (!ms) return "";
      const diff = Date.now() - ms;
      if (diff < 60000) return "刚刚";
      if (diff < 3600000) return Math.floor(diff / 60000) + " 分钟前";
      if (diff < 86400000) return Math.floor(diff / 3600000) + " 小时前";
      return Math.floor(diff / 86400000) + " 天前";
    }

    // ── 侧栏那一行的图标（外壳会套上 label「三策」） ────────────────
    function TriadIcon(props) {
      const size = (props && props.size) || 18;
      const active = !!(props && props.active);
      const stroke = active ? "currentColor" : "currentColor";
      const opacity = active ? 1 : 0.82;
      // 三条竖线 = 三策；下面一条横线 = 合在一处
      return h(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: stroke,
          strokeWidth: 1.8,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          style: { opacity, display: "block" },
          "aria-hidden": "true",
        },
        h("path", { key: "a", d: "M6 4v9" }),
        h("path", { key: "b", d: "M12 4v12" }),
        h("path", { key: "c", d: "M18 4v9" }),
        h("path", { key: "d", d: "M4 19h16" }),
        h("path", { key: "e", d: "M12 19v-3" }),
      );
    }

    // ── 块外壳（可折叠） ──────────────────────────────────────────────
    function Section(props) {
      const open = props.open;
      return h(
        "div",
        { style: S.sec },
        h(
          "div",
          {
            style: Object.assign({}, S.secHead, open ? null : { borderBottom: "none" }),
            onClick: props.onToggle,
            role: "button",
            tabIndex: 0,
            onKeyDown: (e) => {
              if (e.key === "Enter" || e.key === " ") props.onToggle();
            },
          },
          h("span", { key: "t", style: S.secTitle }, props.title),
          h("span", { key: "c", style: S.secCount }, props.count || ""),
          h("span", { key: "g", style: S.grow }),
          h("span", { key: "i", style: S.secCount }, open ? "收起 −" : "展开 +"),
        ),
        open ? h("div", { style: S.secBody }, props.children) : null,
      );
    }

    // ── ① 项目：甘特（搬砚台 client.js:293-402 的四要素与本地时间轴） ──
    function Gantt(props) {
      const list = props.items || [];
      const onPick = props.onPick;
      const picked = props.picked;

      let min = Infinity;
      let max = -Infinity;
      for (const p of list) {
        const a = dayMs(p.start);
        const b = dayMs(p.end);
        if (Number.isFinite(a)) min = Math.min(min, a);
        if (Number.isFinite(b)) max = Math.max(max, b);
      }
      if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
        return h("div", { style: S.hint }, "项目缺日期，画不出甘特。给每个项目一个 start 和 end。");
      }

      const pad = Math.max(GDAY, (max - min) * 0.05);
      const t0 = min - pad;
      const t1 = max + pad;
      const span = t1 - t0;
      const pct = (ms) => ((ms - t0) / span) * 100;

      const days = Math.max(1, Math.round((max - min) / GDAY));
      const stepDays = days <= 14 ? 1 : days <= 45 ? 7 : days <= 120 ? 14 : 30;

      const ticks = [];
      const first = new Date(t0);
      first.setHours(0, 0, 0, 0);
      let t = first.getTime();
      while (t < t0) t += GDAY;
      for (; t <= t1; t += stepDays * GDAY) ticks.push(t);

      const now = new Date();
      now.setHours(0, 0, 0, 0);
      const nowPct = pct(now.getTime());
      const hasToday = nowPct >= 0 && nowPct <= 100;

      const layer = () => {
        const out = ticks.map((tk, i) => h("div", { key: "g" + i, style: Object.assign({}, S.gGrid, { left: pct(tk) + "%" }) }));
        if (hasToday) out.push(h("div", { key: "now", style: Object.assign({}, S.gToday, { left: nowPct + "%" }) }));
        return out;
      };

      const head = h(
        "div",
        {
          key: "h",
          style: {
            display: "flex",
            gap: "8px",
            alignItems: "flex-end",
            paddingBottom: "3px",
            borderBottom: "1px solid rgba(128,128,128,0.30)",
          },
        },
        h("div", { style: { width: "150px", flex: "0 0 auto" } }),
        h(
          "div",
          { style: { position: "relative", flex: "1 1 auto", height: "13px", minWidth: "160px" } },
          ticks.map((tk, i) => h("div", { key: i, style: Object.assign({}, S.gTick, { left: pct(tk) + "%" }) }, md(tk))),
        ),
      );

      const rows = list.map((p, i) => {
        const a = dayMs(p.start);
        const b = dayMs(p.end);
        const okA = Number.isFinite(a);
        const okB = Number.isFinite(b) && b > a;
        const left = okA ? pct(a) : 0;
        const w = okA && okB ? Math.max(0.8, pct(b) - left) : 0.8;
        const prog = Math.max(0, Math.min(100, Number(p.progress) || 0));
        const tip = (p.start || "?") + " → " + (p.end || "?") + "　" + prog + "%" + (p.note ? "　（点名字看备注）" : "");
        return h(
          "div",
          { key: p.id || i, style: S.gRow },
          h(
            "div",
            {
              style: Object.assign({}, S.gLab, picked === p.id ? { opacity: 1, fontWeight: 600 } : null),
              title: p.name,
              onClick: () => onPick(p.id),
            },
            p.name,
          ),
          h(
            "div",
            { style: S.gTrack, title: tip },
            layer(),
            okA ? h("div", { style: Object.assign({}, S.gPlan, { left: left + "%", width: w + "%" }) }) : null,
            okA && prog > 0
              ? h("div", { style: Object.assign({}, S.gProg, { left: left + "%", width: (w * prog) / 100 + "%" }) })
              : null,
            h(
              "div",
              { style: { position: "absolute", right: 0, top: "6px", fontSize: "11px", fontWeight: 400, opacity: 0.4 } },
              prog + "%",
            ),
          ),
        );
      });

      const foot = h(
        "div",
        {
          key: "f",
          style: {
            display: "flex",
            gap: "8px",
            alignItems: "center",
            paddingTop: "3px",
            borderTop: "1px solid rgba(128,128,128,0.30)",
          },
        },
        h("div", { style: Object.assign({}, S.hint, { width: "150px", flex: "0 0 auto" }) }, "跨 " + days + " 天"),
        h(
          "div",
          { style: { position: "relative", flex: "1 1 auto", height: "14px", minWidth: "160px" } },
          h("span", { style: Object.assign({}, S.hint, { position: "absolute", left: 0 }) }, iso(min)),
          h("span", { style: Object.assign({}, S.hint, { position: "absolute", right: 0 }) }, iso(max)),
          hasToday
            ? h(
                "span",
                {
                  key: "n",
                  style: {
                    position: "absolute",
                    left: nowPct + "%",
                    transform: "translateX(-50%)",
                    fontSize: "11px",
                    fontWeight: 400,
                    color: "rgba(255,255,255,0.55)",
                    whiteSpace: "nowrap",
                  },
                },
                "今天",
              )
            : null,
        ),
      );

      return h("div", { style: { display: "flex", flexDirection: "column", gap: "2px", overflowX: "auto" } }, head, h("div", null, rows), foot);
    }

    // ── ② 看板：五列 ─────────────────────────────────────────────────
    function BoardColumn(props) {
      const col = props.col;
      const tasks = props.tasks;
      const onMove = props.onMove;
      const onDel = props.onDel;
      const onAdd = props.onAdd;
      const [adding, setAdding] = react.useState(false);
      const [text, setText] = react.useState("");

      const submit = () => {
        const v = text.trim();
        if (!v) {
          setAdding(false);
          return;
        }
        onAdd(col.status, v);
        setText("");
        setAdding(false);
      };

      const idx = STATUS_ORDER.indexOf(col.status);

      return h(
        "div",
        {
          style: S.col,
          onDragOver: (e) => {
            e.preventDefault();
          },
          onDrop: (e) => {
            e.preventDefault();
            const id = e.dataTransfer && e.dataTransfer.getData("text/plain");
            if (id) onMove(id, col.status);
          },
        },
        h(
          "div",
          { style: S.colHead },
          h("span", { key: "d", style: S.dot(STATUS_COLOR[col.status]) }),
          h("span", { key: "n", style: S.colName }, col.label),
          h("span", { key: "c", style: S.colNum }, String(tasks.length)),
        ),
        tasks.map((t) =>
          h(
            "div",
            Object.assign(
              {
                key: t.id,
                style: S.card,
                draggable: true,
                onDragStart: (e) => {
                  try {
                    e.dataTransfer.setData("text/plain", t.id);
                  } catch (err) {}
                },
              },
              hov(SURF, SURF_HI),
            ),
            h("div", { key: "t", style: S.cardTitle }, t.title),
            t.description ? h("div", { key: "d", style: S.cardDesc }, t.description) : null,
            h(
              "div",
              { key: "o", style: S.cardOps },
              h(
                "button",
                {
                  style: S.btnMini,
                  title: "移到上一列",
                  disabled: idx <= 0,
                  onClick: () => idx > 0 && onMove(t.id, STATUS_ORDER[idx - 1]),
                },
                "←",
              ),
              h(
                "button",
                {
                  style: S.btnMini,
                  title: "移到下一列",
                  disabled: idx >= STATUS_ORDER.length - 1,
                  onClick: () => idx < STATUS_ORDER.length - 1 && onMove(t.id, STATUS_ORDER[idx + 1]),
                },
                "→",
              ),
              h("span", { key: "g", style: S.grow }),
              h("button", { key: "x", style: S.btnDel, title: "删掉这张卡", onClick: () => onDel(t.id) }, "×"),
            ),
          ),
        ),
        adding
          ? h(
              "div",
              { style: { display: "flex", flexDirection: "column", gap: "4px" } },
              h("input", {
                autoFocus: true,
                style: S.inp,
                placeholder: "标题，回车建卡",
                value: text,
                onChange: (e) => setText(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === "Enter") submit();
                  if (e.key === "Escape") {
                    setText("");
                    setAdding(false);
                  }
                },
              }),
              h(
                "div",
                { style: S.row },
                h("button", { style: S.btnMini, onClick: submit }, "建卡"),
                h(
                  "button",
                  {
                    style: S.btnMini,
                    onClick: () => {
                      setText("");
                      setAdding(false);
                    },
                  },
                  "取消",
                ),
              ),
            )
          : h("button", { style: Object.assign({}, S.btnMini, { textAlign: "left" }), onClick: () => setAdding(true) }, "＋ 新建"),
      );
    }

    // ── ③ 三策卡 ─────────────────────────────────────────────────────
    function AgentCard(props) {
      const a = props.agent;
      const canOpen = props.canOpen;
      const onOpen = props.onOpen;
      const [hint, setHint] = react.useState("");
      return h(
        "div",
        Object.assign({ style: S.agent }, hov(SURF, SURF_HI)),
        h(
          "div",
          { key: "t", style: S.agentTop },
          h("span", { key: "d", style: S.dot(a.exists ? "#30d158" : "#8e8e93") }),
          h("span", { key: "n", style: S.agentName, title: a.id }, a.name),
          h("span", { key: "s", style: S.pill(a.exists) }, a.exists ? "就绪" : "缺失"),
        ),
        h("div", { key: "r", style: S.agentRole }, a.role),
        a.description ? h("div", { key: "d", style: S.agentDesc, title: a.description }, a.description) : null,
        h("div", { key: "i", style: S.code }, a.id),
        h(
          "div",
          { key: "o", style: S.row },
          h(
            "button",
            {
              style: S.btnMini,
              onClick: () => {
                const ok = onOpen();
                setHint(ok ? "已打开新会话 —— 在那一页选 preset：" + a.id : "这台机器拿不到会话入口，请从侧边栏「新建会话」里选 " + a.id);
              },
            },
            "新建会话",
          ),
          a.mtime ? h("span", { key: "m", style: S.secCount }, "配置 " + ago(a.mtime)) : null,
        ),
        hint ? h("div", { key: "h", style: S.hint }, hint) : null,
        canOpen === false
          ? h("div", { key: "w", style: S.hint }, "点卡不会在这里聊 —— 它只是把 preset id 递出去。")
          : null,
      );
    }

    // ══ 共享数据 store ════════════════════════════════════════════════
    // ★ 窄版（常驻）与全屏是同一个组件的两种渲染 ⇒ 天然只请求一次。
    //   再加这一层 store + inflight 去重，是为了让 main 页（点侧栏入口时）也复用同一份，
    //   全进程只打一次 /state。刷新按钮显式 force。
    const triadStore = {
      data: null,
      err: "",
      busy: false,
      inflight: null,
      listeners: new Set(),
      snapshot() {
        return { data: triadStore.data, err: triadStore.err, busy: triadStore.busy };
      },
      emit() {
        for (const fn of Array.from(triadStore.listeners)) {
          try {
            fn();
          } catch (e) {
            /* 单个订阅者抛错不许拖垮别人 */
          }
        }
      },
      subscribe(fn) {
        triadStore.listeners.add(fn);
        return () => {
          triadStore.listeners.delete(fn);
        };
      },
      load(force) {
        if (triadStore.inflight) return triadStore.inflight; // ★ 并发去重：两个组件同时挂也只发一次
        if (triadStore.data && !force) return Promise.resolve(triadStore.data);
        triadStore.busy = true;
        triadStore.err = "";
        triadStore.emit();
        const p = api("/state")
          .then((d) => {
            triadStore.data = d;
            return d;
          })
          .catch((e) => {
            triadStore.err = String((e && e.message) || e);
            throw e;
          })
          .finally(() => {
            triadStore.inflight = null;
            triadStore.busy = false;
            triadStore.emit();
          });
        triadStore.inflight = p;
        return p;
      },
    };

    /** 显式刷新（吞掉拒绝，错误已经进 store.err 显示在界面上）。 */
    function refreshTriad() {
      triadStore.load(true).catch(() => {});
    }

    /** 订阅共享数据；首次挂载时按需触发加载。 */
    function useTriad() {
      const [snap, setSnap] = react.useState(() => triadStore.snapshot());
      react.useEffect(() => {
        const off = triadStore.subscribe(() => setSnap(triadStore.snapshot()));
        if (!triadStore.data && !triadStore.inflight) refreshTriad();
        setSnap(triadStore.snapshot());
        return off;
      }, []);
      return snap;
    }

    // ══ 常驻窄版（挂在 shell.overlay 里）═══════════════════════════════
    // ★ 为什么不是别的槽位（2026-10-27 查 asar 源码的结论）：
    //   root 只有 6 个子槽位 —— sidebar / main / rightbar / shell.bottom /
    //   shell.overlay / shell.leading。三列 grid 写死
    //   `${sidebar}px minmax(...)1fr minmax(0px,rightbar)`，**没有第四列**。
    //   shell.leading 只在 darwin（macOS 红绿灯位）且侧栏折叠时挂载，Windows 永不渲染；
    //   shell.bottom 是整宽底条。所以「侧栏和聊天区之间」在 DSH 里不是一个位置，
    //   而是 center 列的左缘 —— 只能用 overlay 绝对定位贴上去。
    const DOCK_W = 276;
    // 让开会话标题行 + 视图 tabs（实测：tabs y=112..144，加 4px 间距）
    const DOCK_TOP = 148;
    const DOCK_ID = "dsh-yanqing-triad-dock";

    /**
     * 量 center 列左缘与底部状态栏高度。
     * 不写死 280/350：侧栏可拖宽、可折叠（56px rail）、窗口可缩放，都要跟。
     * center 列的 class 带构建哈希前缀，用后缀匹配；底部条有稳定 data 属性。
     */
    function measureDock() {
      try {
        const layer = document.querySelector("[data-shell-overlay]");
        const frame = layer && layer.parentElement;
        if (!frame) return null;
        const center = frame.querySelector('[class*="_centerCol"]');
        if (!center) return null;
        const bottom = frame.querySelector("[data-shell-bottom]");
        const fr = frame.getBoundingClientRect();
        const cr = center.getBoundingClientRect();
        const br = bottom ? bottom.getBoundingClientRect() : null;
        return {
          left: Math.max(0, Math.round(cr.left - fr.left)),
          bottom: br ? Math.max(0, Math.round(fr.bottom - br.top)) : 0,
        };
      } catch (e) {
        return null;
      }
    }

    /** 数据 → 窄版要用的几个数（读不到就是 null，界面显示 —，不编数）。 */
    function dockCounts(st) {
      const projects = st && st.projects ? st.projects : null;
      const board = st && st.board ? st.board : null;
      const agents = st && Array.isArray(st.agents) ? st.agents : [];
      return {
        agents: agents,
        projects: projects && projects.ok ? projects.total : null,
        tasks: board && board.ok ? board.total : null,
      };
    }

    /** 竖排小卡：名字 + 状态点（状态点用 preset 的 accent；就绪/缺失跟着 exists）。 */
    function AgentPill(props) {
      const a = props.agent;
      const ok = !!a.exists;
      return h(
        "div",
        Object.assign(
          {
            style: {
              display: "flex",
              alignItems: "center",
              gap: "10px",
              padding: "14px 16px",
              border: HAIR,
              borderRadius: "12px",
              background: SURF,
              transition: EASE,
            },
            title: (a.id || "") + (a.role ? " —— " + a.role : ""),
          },
          hov(SURF, SURF_HI),
        ),
        // 状态点：一个安静的点 —— 不发光、不脉冲（设计稿 §10「状态点怎么做」）
        h("span", {
          style: {
            flex: "none",
            width: "14px",
            height: "14px",
            borderRadius: "50%",
            background: ok ? "#30d158" : "#8e8e93",
            opacity: ok ? 1 : 0.5,
          },
        }),
        h(
          "span",
          { style: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "13px", fontWeight: 500 } },
          a.name || a.id || "（无名）",
        ),
        h("span", { style: { flex: "none", fontSize: "11px", fontWeight: 400, opacity: 0.4 } }, ok ? "就绪" : "缺失"),
      );
    }

    /** 大数字：标签小（12/500/0.5）、数字大（22/600/等宽）。读不到就 —，不编。 */
    function CountRow(props) {
      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: "4px" } },
        h("span", { style: { fontSize: "12px", fontWeight: 500, opacity: 0.5 } }, props.label),
        h(
          "span",
          {
            style: {
              fontSize: "22px",
              fontWeight: 600,
              lineHeight: "1.1",
              letterSpacing: "-0.01em",
              fontVariantNumeric: "tabular-nums",
            },
          },
          props.value === null ? "—" : String(props.value),
        ),
      );
    }

    function TriadDock(props) {
      const nav = (props && props.nav) || null;
      // 三态：badge（贴边小标，默认）/ dock（小窗）/ full（全屏）
      const [mode, setMode] = react.useState("badge");
      const [box, setBox] = react.useState(() => measureDock() || { left: 280, bottom: 0 });
      const snap = useTriad();
      const counts = dockCounts(snap.data);

      // ★★ 2026-10-27 16:34 爀曦：「有活动、或者有消息的时候，就自动展开。」
      //   用一个轻量签名判断「发生了什么」—— 看板张数 / 项目数 / 三策存在性 / 是否在刷新。
      //   注意首次挂载不弹（那时数据从 null 变成有值，属于加载、不是活动）。
      const sig = react.useMemo(() => {
        const d = snap.data;
        if (!d) return "boot";
        const b = d.board && d.board.ok ? d.board.total : -1;
        const p = d.projects && d.projects.ok ? d.projects.total : -1;
        const a = Array.isArray(d.agents) ? d.agents.map((x) => (x.exists ? "1" : "0")).join("") : "";
        return [b, p, a, snap.busy ? "busy" : "idle"].join("|");
      }, [snap.data, snap.busy]);
      const firstSig = react.useRef(null);
      react.useEffect(() => {
        if (firstSig.current === null) {
          firstSig.current = sig; // 首次只记录，不弹
          return;
        }
        if (sig === firstSig.current) return;
        firstSig.current = sig;
        setMode((m) => (m === "badge" ? "dock" : m));
      }, [sig]);

      // 侧栏拖宽 / 折叠 / 窗口缩放 —— 都让 center 左缘变化，跟着重量。
      react.useEffect(() => {
        let alive = true;
        const remeasure = () => {
          if (!alive) return;
          const next = measureDock();
          if (!next) return;
          setBox((prev) => (prev.left === next.left && prev.bottom === next.bottom ? prev : next));
        };
        remeasure();
        const layer = document.querySelector("[data-shell-overlay]");
        const frame = layer && layer.parentElement;
        let mo = null;
        if (frame && typeof MutationObserver !== "undefined") {
          // 侧栏宽度写进 frame 的 gridTemplateColumns（inline style），监听它最准。
          mo = new MutationObserver(remeasure);
          mo.observe(frame, { attributes: true, attributeFilter: ["style", "data-sidebar-collapsed"] });
        }
        window.addEventListener("resize", remeasure);
        const t = setInterval(remeasure, 1500); // 兜底：布局变了但没触发上面两条
        return () => {
          alive = false;
          window.removeEventListener("resize", remeasure);
          clearInterval(t);
          if (mo) mo.disconnect();
        };
      }, []);

      // ── 全屏态：同一个组件换一种渲染，数据不动、不重新请求 ──
      // ★ 2026-10-27 13:50 修 bug：原来 inset:0 让顶栏（含「⤡ 收起」）被 DSH 自己的
      //   标题栏 + tabs 行压住 —— 用户点展开后找不到收起按钮就是这个原因。
      //   实测 tabs 到 y=144，所以顶部让出 DOCK_TOP；再挂一个浮动收起做双保险。
      if (mode === "full") {
        return h(
          "div",
          {
            style: Object.assign({}, LIQUID, {
              position: "absolute",
              top: DOCK_TOP + "px",
              left: "16px",
              right: "16px",
              bottom: "16px",
              zIndex: 3,
              pointerEvents: "auto",   // overlay 层是 pointer-events:none，显式接管鼠标
              display: "flex",
              flexDirection: "column",
              borderRadius: "26px",    // 液态玻璃比普通卡片更圆
              // ★★ 2026-10-27 16:33 液态玻璃**不许有自己的颜色**。
              //   上一版在这里叠了两层 rgba(20,20,24,.9) 的黑底 —— 把小窗那种「透出主题蓝」的效果
              //   直接压成了近黑，于是「小窗更好看、展开态不像一套」。现在底色只留纯白光
              //   （LIQUID 自带），压暗交给 backdrop-filter 的 brightness(0.62)：
              //   糊掉后面的字，但保留主题色相 —— 换皮肤它自己会跟着变，不用写死任何一个颜色。
              backdropFilter: "blur(48px) saturate(185%) brightness(0.62) contrast(1.04)",
              WebkitBackdropFilter: "blur(48px) saturate(185%) brightness(0.62) contrast(1.04)",
              color: "inherit",
              overflow: "hidden",
            }),
          },
          // ★ 浮动「收起」：不依赖顶栏是否可见
          h(
            "button",
            {
              key: "float-collapse",
              "data-triad-collapse": true,
              onClick: () => setMode("dock"),
              title: "回到小窗",
              style: {
                position: "absolute",
                bottom: "18px",
                right: "18px",
                zIndex: 9,
                padding: "8px 15px",
                fontSize: "12px",
                fontWeight: 500,
                lineHeight: "1.2",
                cursor: "pointer",
                border: "1px solid rgba(255,255,255,0.14)",
                borderRadius: "10px",
                background: "rgba(255,255,255,0.10)",
                backdropFilter: "blur(24px) saturate(180%)",
                WebkitBackdropFilter: "blur(24px) saturate(180%)",
                color: "inherit",
                fontFamily: "inherit",
                boxShadow: "inset 0 1px 0 rgba(255,255,255,0.22), 0 6px 20px rgba(0,0,0,0.32)",
                transition: EASE,
              },
            },
            "⤡ 小窗",
          ),
          h(Panel, { nav: nav, onCollapse: () => setMode("dock") }),
        );
      }

      // ── 小标态（默认）：贴边一个小胶囊，平时不占地方 ──
      // ★ 2026-10-27 16:34 爀曦：「小窗平时默认贴边，变成一个小标，点击可以展开小窗，
      //   有活动或者有消息的时候，就自动展开。」—— 所以默认不是小窗，是这个小标。
      if (mode === "badge") {
        const total = counts.agents.length;
        const up = counts.agents.filter((a) => a.exists).length;
        const dotColor = total === 0 ? "#8e8e93" : up === total ? "#30d158" : "#ff9f0a";
        return h(
          "button",
          {
            type: "button",
            "data-triad-badge": true,
            title: "三策 · " + up + "/" + total + " 就绪 · 点击展开",
            "aria-label": "展开三策小窗",
            onClick: () => setMode("dock"),
            style: Object.assign({}, LIQUID, {
              position: "absolute",
              left: box.left + 8 + "px",
              top: "50%",
              transform: "translateY(-50%)",
              width: "44px",
              padding: "16px 0",
              zIndex: 2,
              pointerEvents: "auto",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "12px",
              borderRadius: "22px",
              color: "inherit",
              fontFamily: "inherit",
              cursor: "pointer",
              willChange: "transform",
              transition: EASE,
            }),
          },
          h("span", {
            key: "d",
            style: { width: "8px", height: "8px", borderRadius: "50%", background: dotColor, flex: "none", boxShadow: "0 0 8px " + dotColor + "66" },
          }),
          h(
            "span",
            {
              key: "t",
              style: {
                writingMode: "vertical-rl",
                letterSpacing: "0.16em",
                fontSize: "13px",
                fontWeight: 500,
                opacity: 0.82,
                lineHeight: "1",
              },
            },
            "三策",
          ),
        );
      }

      // ── 小窗态 ──
      // ★★ 2026-10-27 16:22 「界面变挤」的观感来源就在这里：原来它 top 到底一整条竖墙，
      //   视觉上等于凭空多出第四条栏。改成**随内容自动高度**的浮动卡片 ——
      //   内容少时它只占一个小方块，只在真的超长时才滚。
      return h(
        "div",
        {
          "data-triad-dock": true,
          style: Object.assign({}, LIQUID, {
            position: "absolute",
            left: box.left + 10 + "px",  // 离侧栏 10px —— 浮着，不是贴着
            top: DOCK_TOP + "px",
            width: DOCK_W + "px",
            maxHeight: "calc(100vh - " + (DOCK_TOP + 14) + "px)",
            zIndex: 1,
            pointerEvents: "auto",       // 同上：别指望从 overlay 层继承
            display: "flex",
            flexDirection: "column",
            gap: "18px",                 // 组与组之间 18px
            padding: "18px",             // 面板内边距 18px
            boxSizing: "border-box",
            overflowY: "auto",
            borderRadius: "20px",        // 液态玻璃更圆
            color: "inherit",
            fontSize: "13px",
          }),
        },
        // 顶栏：标题 + 收起成小标 + 展开
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "8px" } },
          h("span", { style: { fontSize: "15px", fontWeight: 600, letterSpacing: "0.01em" } }, "三策"),
          h("span", { style: { flex: "1 1 auto" } }),
          snap.busy ? h("span", { style: { fontSize: "11px", fontWeight: 400, opacity: 0.4 } }, "…") : null,
          h(
            "button",
            Object.assign(
              {
                type: "button",
                title: "收成小标",
                "aria-label": "收成小标",
                "data-triad-tobadge": true,
                onClick: () => setMode("badge"),
                style: {
                  background: "rgba(255,255,255,0.06)",
                  color: "inherit",
                  border: HAIR,
                  borderRadius: "8px",
                  width: "28px",
                  height: "28px",
                  fontSize: "13px",
                  lineHeight: "1",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  transition: EASE,
                },
              },
              hov("rgba(255,255,255,0.06)", "rgba(255,255,255,0.12)"),
            ),
            "−",
          ),
          h(
            "button",
            Object.assign(
              {
                type: "button",
                title: "展开到全屏",
                "aria-label": "展开三策",
                onClick: () => setMode("full"),
                style: {
                  background: "rgba(255,255,255,0.06)",
                  color: "inherit",
                  border: HAIR,
                  borderRadius: "8px",
                  width: "28px",
                  height: "28px",
                  fontSize: "13px",
                  lineHeight: "1",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  transition: EASE,
                },
              },
              hov("rgba(255,255,255,0.06)", "rgba(255,255,255,0.12)"),
            ),
            "⤢",
          ),
        ),

        snap.err ? h("div", { style: { color: "rgba(255,255,255,0.92)", fontSize: "11px", fontWeight: 400, lineHeight: "1.7", wordBreak: "break-all" } }, "接口出错：" + snap.err) : null,
        !snap.data && !snap.err ? h("div", { style: { fontSize: "11px", fontWeight: 400, opacity: 0.4 } }, "加载中…") : null,

        // 三张 agent 卡（竖排）
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "12px" } },
          counts.agents.length > 0
            ? counts.agents.map((a) => h(AgentPill, { key: a.id, agent: a }))
            : h("div", { style: { fontSize: "11px", opacity: 0.5 } }, snap.data ? "没读到 preset" : "…"),
        ),

        h("div", { style: { height: "1px", background: "rgba(255,255,255,0.06)" } }),

        // 两个计数：标签小、数字大，并排各占一半（设计稿 §10 ④）
        h(
          "div",
          { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" } },
          h(CountRow, { label: "项目", value: counts.projects }),
          h(CountRow, { label: "任务", value: counts.tasks }),
        ),
      );
    }

    // ── 主面板 ────────────────────────────────────────────────────────
    function Panel(props) {
      const nav = (props && props.nav) || null;
      const onCollapse = (props && props.onCollapse) || null;
      // ★ 数据来自共享 store —— 窄版已经在它挂载时拉过一次，这里不会二次请求。
      const snap = useTriad();
      const st = snap.data;
      const err = snap.err;
      const busy = snap.busy;
      const load = refreshTriad;
      // ★★ 2026-10-27 16:31 滚轮不再依赖浏览器原生滚动。
      //   实测结论：按钮点得动 ⇒ 事件能命中元素；overflowY:auto 也写了 ⇒ 只剩一种可能 ——
      //   宿主在更外层对 wheel 做了 preventDefault（它自己实现了滚动），原生滚动因此失效。
      //   对付法：把 wheel 直接绑在元素上（passive:false）并**自己搬 scrollTop**。
      //   JS 改 scrollTop 不受 preventDefault 影响 —— 这是唯一稳的路。
      const scrollRef = react.useRef(null);
      react.useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        const onWheel = (e) => {
          // 自己滚得动就滚自己；滚不动往上找 —— 即使父级是 overflow:hidden，
          // 用 JS 设 scrollTop 一样能推进内容（这条是给「外层把内容裁掉」那种情况兜底）。
          let box = el;
          for (let i = 0; i < 3 && box && box !== document.body; i++) {
            if (box.scrollHeight > box.clientHeight + 1) break;
            box = box.parentElement;
          }
          if (!box || box === document.body) return;
          let d = e.deltaY;
          if (e.deltaMode === 1) d *= 16;                    // 按行
          else if (e.deltaMode === 2) d *= box.clientHeight; // 按页
          const max = box.scrollHeight - box.clientHeight;
          const next = Math.max(0, Math.min(max, box.scrollTop + d));
          if (next !== box.scrollTop) box.scrollTop = next;
          e.preventDefault();
          e.stopPropagation();
        };
        el.addEventListener("wheel", onWheel, { passive: false });
        return () => el.removeEventListener("wheel", onWheel);
      }, []);

      // ★★★ 2026-10-31：左键拖拽滚动（爀曦：「鼠标左键拖动就可以滚动」）。
      //   注意几个必须避开的坑：
      //     ① 点在按钮 / 输入框 / 链接上时**不能**开始拖 —— 否则点击就失效了；
      //     ② 拖动期间要临时禁掉文字选择，否则整段文字会被刷蓝；
      //     ③ pointercapture 要拿住，否则鼠标移出面板就丢事件；
      //     ④ 拖的距离超过阈值才算「拖」，轻微抖动不算 —— 否则短按也会被吞。
      const dragRef = react.useRef({ active: false, moved: false, sx: 0, sy: 0, sl: 0, st: 0 });
      react.useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        const INTERACTIVE = "button,a,input,select,textarea,label,[contenteditable],[data-no-drag]";
        const onDown = (e) => {
          if (e.button !== 0) return;                       // 只认左键
          const t = e.target;
          if (t && t.closest && t.closest(INTERACTIVE)) return; // ①
          dragRef.current = {
            active: true,
            moved: false,
            sx: e.clientX,
            sy: e.clientY,
            sl: el.scrollLeft,
            st: el.scrollTop,
          };
        };
        const onMove = (e) => {
          const d = dragRef.current;
          if (!d.active) return;
          const dx = e.clientX - d.sx;
          const dy = e.clientY - d.sy;
          if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return; // ④
          d.moved = true;
          el.scrollLeft = d.sl - dx;
          el.scrollTop = d.st - dy;
          el.style.userSelect = "none"; // ②
          el.style.cursor = "grabbing";
          try { el.setPointerCapture(e.pointerId); } catch (_) {} // ③
          e.preventDefault();
        };
        const onUp = () => {
          const d = dragRef.current;
          if (!d.active) return;
          d.active = false;
          el.style.userSelect = "";
          el.style.cursor = "";
        };
        el.addEventListener("pointerdown", onDown);
        el.addEventListener("pointermove", onMove);
        el.addEventListener("pointerup", onUp);
        el.addEventListener("pointercancel", onUp);
        return () => {
          el.removeEventListener("pointerdown", onDown);
          el.removeEventListener("pointermove", onMove);
          el.removeEventListener("pointerup", onUp);
          el.removeEventListener("pointercancel", onUp);
        };
      }, []);
      const [open, setOpen] = react.useState({ projects: true, board: true, agents: true });
      const [picked, setPicked] = react.useState("");
      const [opErr, setOpErr] = react.useState("");

      const toggle = (k) => setOpen(Object.assign({}, open, { [k]: !open[k] }));

      const addTask = async (status, title) => {
        setOpErr("");
        try {
          await api("/tasks", { method: "POST", body: JSON.stringify({ title: title, status: status }) });
          await load();
        } catch (e) {
          setOpErr("建卡失败：" + String((e && e.message) || e));
        }
      };

      const moveTask = async (id, status) => {
        setOpErr("");
        try {
          await api("/tasks/" + encodeURIComponent(id), { method: "PATCH", body: JSON.stringify({ status: status }) });
          await load();
        } catch (e) {
          setOpErr("移动失败：" + String((e && e.message) || e));
        }
      };

      const delTask = async (id) => {
        setOpErr("");
        try {
          await api("/tasks/" + encodeURIComponent(id), { method: "DELETE" });
          await load();
        } catch (e) {
          setOpErr("删除失败：" + String((e && e.message) || e));
        }
      };

      const projects = st && st.projects ? st.projects : null;
      const board = st && st.board ? st.board : null;
      const agents = st && st.agents ? st.agents : [];
      const tasks = board && board.tasks ? board.tasks : [];
      const pickedProject = picked && projects && projects.items ? projects.items.filter((p) => p.id === picked)[0] : null;

      const startup = () => {
        if (!st) return "加载中…";
        const pc = projects && projects.ok ? projects.total : "—";
        const tc = board && board.ok ? board.total : "—";
        return "项目 " + pc + " · 任务 " + tc + " · preset " + agents.length;
      };

      return h(
        "div",
        { style: S.wrap, ref: scrollRef },
        // 顶栏
        h(
          "div",
          { key: "top", style: S.top },
          h("span", { key: "t", style: S.title }, "三策"),
          h("span", { key: "s", style: S.sub }, "项目 → 分解成任务 → 派给三策里的某一个"),
          h("span", { key: "g", style: S.grow }),
          h("span", { key: "c", style: S.sub }, startup()),
          h("button", { key: "r", style: S.btn, onClick: load, disabled: busy }, busy ? "刷新中…" : "刷新"),
          onCollapse
            ? h(
                "button",
                { key: "cl", style: S.btn, onClick: onCollapse, title: "回到小窗" },
                "⤡ 小窗",
              )
            : null,
        ),

        err ? h("div", { key: "e", style: S.err }, "接口出错：" + err) : null,
        opErr ? h("div", { key: "oe", style: S.err }, opErr) : null,

        // ① 项目
        h(
          Section,
          {
            key: "p",
            title: "项目",
            count: projects && projects.ok ? projects.total + " 个 · 砚台甘特（只读）" : "读不到",
            open: open.projects,
            onToggle: () => toggle("projects"),
          },
          projects && !projects.ok ? h("div", { style: S.err }, projects.error) : null,
          projects && projects.ok && projects.total === 0 ? h("div", { style: S.hint }, "projects.json 是空的。") : null,
          projects && projects.ok ? h(Gantt, { items: projects.items, onPick: (id) => setPicked(picked === id ? "" : id), picked: picked }) : null,
          pickedProject
            ? h(
                "div",
                { key: "n", style: S.note },
                h("div", { key: "h", style: { fontWeight: 700, marginBottom: "4px" } }, pickedProject.name + "　" + pickedProject.start + " → " + pickedProject.end + "　" + pickedProject.progress + "%"),
                pickedProject.note || "（这个项目没写备注）",
              )
            : h("div", { key: "hint", style: S.hint }, "点左边的项目名看它的备注。"),
          h("div", { key: "f", style: S.code }, (st && st.paths && st.paths.projectsFile) || ""),
        ),

        // ② 看板
        h(
          Section,
          {
            key: "b",
            title: "任务看板",
            count: board && board.ok ? board.total + " 张 · 五列 · 可拖也可点箭头" : "读不到",
            open: open.board,
            onToggle: () => toggle("board"),
          },
          board && !board.ok ? h("div", { style: S.err }, board.error) : null,
          board && board.ok
            ? h(
                "div",
                { key: "cols", style: S.cols },
                COLUMNS.map((col) =>
                  h(BoardColumn, {
                    key: col.status,
                    col: col,
                    tasks: tasks.filter((t) => t.status === col.status),
                    onMove: moveTask,
                    onDel: delTask,
                    onAdd: addTask,
                  }),
                ),
              )
            : null,
          h("div", { key: "n", style: S.hint }, "这是记录性质的看板：建卡 / 移动 / 删卡是真的，写进 board.json。没有执行按钮 —— 那台机器上原看板的执行是坏的，不复制那个 bug。"),
          h("div", { key: "f", style: S.code }, (st && st.paths && st.paths.boardFile) || ""),
        ),

        // ③ 三策
        h(
          Section,
          { key: "a", title: "三策", count: agents.length + " 个 preset · 点卡是开新会话，不在这里聊", open: open.agents, onToggle: () => toggle("agents") },
          h(
            "div",
            { key: "g", style: S.agents },
            agents.map((a) =>
              h(AgentCard, {
                key: a.id,
                agent: a,
                canOpen: !!(nav && nav.canStartSession),
                onOpen: () => (nav && nav.canStartSession ? nav.startSession() : false),
              }),
            ),
          ),
          h("div", { key: "f", style: S.code }, (st && st.paths && st.paths.presetsDir) || ""),
        ),

        h(
          "div",
          { key: "foot", style: S.hint },
          "数据：项目读砚台的 projects.json（不改它）；看板写 30-状态\\三策\\board.json；三策读 .agent-presets。",
        ),
      );
    }

    // ── 会话入口（能不能用要现场判，不能假设） ────────────────────────
    function buildNav(ctx) {
      const nav = {
        canStartSession: false,
        startSession: () => false,
      };
      try {
        const ws = typeof ctx.get === "function" ? ctx.get("uiWorkspace") : undefined;
        if (ws && typeof ws.startSession === "function") {
          nav.canStartSession = true;
          nav.startSession = (workspaceId) => {
            try {
              ws.startSession(workspaceId);
              return true;
            } catch (e) {
              return false;
            }
          };
        }
      } catch (e) {
        /* 服务不存在就用降级文案 */
      }
      return nav;
    }

    function apply(ctx) {
      const nav = buildNav(ctx);
      let mounted = 0;
      try {
        console.log("[dsh-yanqing-triad] apply: slots =", !!ctx.slots, "canStartSession =", nav.canStartSession);
      } catch (e) {}

      // ② 面板主体 ★★★ 2026-10-31 关键改动：从 `main`(keyed) 改注册到 `conversation.view`。
      //    砚台（dsh-yantai/client.js:812-819）就是这么写的，而它**滚得动**：
      //      ctx.slots.inject("conversation.view", () => ctx.slots.register(
      //        { name: "conversation.view", id: "yantai", order: 6, label: "砚台" }, View));
      //   两者不是同一个槽位，父容器不一样：
      //     · conversation.view → 顶栏那排标签里的一格，容器给高度，子层 height:100% + overflow:auto 成立
      //     · main(keyed)       → 另一个容器，高度不给，于是 overflow:auto 永不触发
      //   这一个差别，就是前面六版 CSS 怎么调都不滚的真正原因。
      ctx.slots.inject("conversation.view", () =>
        ctx.slots.register(
          {
            name: "conversation.view",
            id: PANEL_ID,
            order: 12,
            label: "三策",
            inject: () => ({ nav: nav }),
          },
          Panel,
        ),
      );

      // ① 侧栏入口：注册的是【图标组件本身】，外壳自己套成「图标 + 三策」一行
      ctx.slots.inject("sidebar.panellist", () =>
        ctx.slots.register(
          {
            name: "sidebar.panellist",
            id: PANEL_ID,
            order: 10,
            label: "三策",
          },
          TriadIcon,
        ),
      );

      // ③ ★ 常驻窄版 —— 挂在 root 的 shell.overlay：
      //    root 只有 6 个子槽位（sidebar / main / rightbar / shell.bottom /
      //    shell.overlay / shell.leading），三列 grid 没有第四列，
      //    「侧栏和聊天区之间」只能靠 overlay 绝对定位贴到 center 列左缘。
      //    详见 30-状态\设计-三策插件.md 第九节（含 asar 行号证据）。
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register(
          {
            name: "shell.overlay",
            id: DOCK_ID,
            order: 40,
            inject: () => ({ nav: nav }),
          },
          TriadDock,
        ),
      );

      try {
        console.log("[dsh-yanqing-triad] apply done", ++mounted);
      } catch (e) {}
    }

    exports.apply = apply;
    // ★★★ 只等 slots。多写一个不存在的服务名，整包会静默失效。
    exports.inject = ["slots"];
    return module.exports;
  },
});
