// dsh-agent-yantai —— 浏览器半（砚台）
//
// 它是【会话区整页视图】，注册在 keyed 槽位 conversation.view 上 ——
// 就是顶部那排 「对话 / agent / 轨迹 / 画廊」 里的一格。
// 写法照抄 别的插件/client.js:2070（「agent」那一格就是它）：
//   ctx.slots.inject("conversation.view", () => ctx.slots.register(
//     { name: "conversation.view", id, order, label }, Component))
//
// ★★★ exports.inject 只写 ["slots"]。
//   上一版我写成 ["slots", "sidebarRight", "layout"]，而桌面端没有这两个服务名 ——
//   cordis 会一直等它们，apply 永远不执行，整包就是「什么都不报、什么都不显示」的样子。
//
// ★ 改这个文件必须重启 DSH：客户端入口图是启动时一次性组合的。
window.__ModuleLoader__.load({
  id: "dsh-agent-yantai",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var h = react.createElement;

    const API = "/yantai/api";

    const B1 = "1px solid rgba(128,128,128,0.35)";
    const ACCENT = "rgba(80,150,235,0.9)";

    // ══ macOS Big Sur 厚玻璃（ 使用者选的风格）══════════════
    // ★ 灵魂是 saturate()：只模糊不提饱和度，玻璃是灰的；
    //   提了才有"背景透过来变得更浓"的通透感 —— 做玻璃最常见就败在这一步。
    // ★ 第二关键是顶部内高光 inset 0 1px 0 —— 玻璃"浮起来"靠它，不靠外投影。
    // ★★  agent：这里原来是 backdrop-filter: blur(Npx) saturate(M%)。
    //   **它就是「滚轮一动整个界面都在闪」的真凶。**
    //   链条：card 套了 GLASS(=blur 28px) → 速达页那张 card 里装着最多 300 个图标
    //   → backdrop-filter 让卡片成为 GPU 合成层，滚动时**整张卡片连里面 300 个图标
    //   一起重绘** → 主线程塞满 → 视觉上就是「整个程序界面在闪」。
    //   ★ 这和使用者凌晨给皮肤定的方向是同一个（skins/<皮肤名>/patches.css 第 93-110 行）：
    //     「全部去掉 backdrop-filter，只保留【半透明背景色】……没有它就没有 GPU 合成层，
    //      界面滚动的性能反而更好。」—— 那一次清的是皮肤层，漏了砚台内部这一处。
    //   ★ 保留的：半透明背景、边框、内高光与色散、外投影（层次感不靠模糊）。
    //     想恢复的话，把下面那两行注释掉的那句放回来即可，只改这一个地方。
    const glassBlur = (px, sat) => ({
      // backdropFilter: "blur(" + px + "px) saturate(" + sat + "%)",
      // WebkitBackdropFilter: "blur(" + px + "px) saturate(" + sat + "%)",
    });
    const GLASS = Object.assign({
      background: "rgba(255,255,255,0.07)",
      border: "1px solid rgba(255,255,255,0.15)",
      boxShadow:
        // ★ 色散：左暖右冷 —— 折射把白光拆开的那一点点彩（iOS 液态玻璃的命门）
        "inset 1.5px 0 0 rgba(255,122,122,0.15), " +
        "inset -1.5px 0 0 rgba(122,172,255,0.17), " +
        // 厚度：受光面 / 背光面
        "inset 0 1px 0 rgba(255,255,255,0.30), " +
        "inset 0 -1px 0 rgba(0,0,0,0.14), " +
        // 悬浮：大而散 + 小而紧
        "0 10px 34px rgba(0,0,0,0.26), 0 1px 2px rgba(0,0,0,0.16)",
    }, glassBlur(28, 190));
    const GLASS_SOFT = Object.assign({
      background: "rgba(255,255,255,0.05)",
      border: "1px solid rgba(255,255,255,0.10)",
      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.14), 0 4px 16px rgba(0,0,0,0.20)",
    }, glassBlur(16, 160));

    const S = {
      wrap: { padding: "14px", fontSize: "12.5px", color: "inherit", height: "100%",
              overflowY: "auto", boxSizing: "border-box" },
      grid: { display: "grid", gap: "10px",
              gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))" },
      wide: { gridColumn: "1 / -1" },
      half: { gridColumn: "span 1" },
      card: Object.assign({ borderRadius: "14px", overflow: "hidden" }, GLASS),
      head: { display: "flex", alignItems: "center", justifyContent: "space-between",
              gap: "8px", padding: "8px 12px",
              background: "rgba(255,255,255,0.06)",
              borderBottom: "1px solid rgba(255,255,255,0.10)",
              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.16)",
              fontSize: "11px", letterSpacing: "0.05em" },
      body: { padding: "10px", display: "flex", flexDirection: "column", gap: "8px" },
      row: { display: "flex", gap: "7px", alignItems: "center", flexWrap: "wrap" },
      band: { fontSize: "11px", opacity: 0.5, letterSpacing: "0.16em", margin: "6px 0 0" },
      dim: { opacity: 0.6 },
      hint: { opacity: 0.55, fontSize: "11px", lineHeight: "1.55" },
      err: { color: "#e5484d", fontSize: "11px", whiteSpace: "pre-wrap", wordBreak: "break-all" },
      bar: { position: "relative", height: "13px", borderRadius: "7px",
             background: "rgba(128,128,128,0.18)", overflow: "hidden", border: B1 },
      fill: { height: "100%", background: ACCENT, transition: "width 0.4s" },
      tick: { position: "absolute", top: 0, width: "1px", height: "100%",
              background: "rgba(128,128,128,0.6)" },
      btn: Object.assign({ color: "inherit", borderRadius: "10px",
             padding: "6px 12px", fontSize: "11.5px", cursor: "pointer" }, GLASS_SOFT),
      code: { fontFamily: "ui-monospace, Consolas, monospace", fontSize: "11px",
              opacity: 0.78, wordBreak: "break-all" },
      item: { paddingTop: "7px", marginTop: "7px",
              borderTop: "1px dashed rgba(128,128,128,0.25)" },
      tag: { fontSize: "10px", padding: "1px 6px", borderRadius: "4px",
             border: B1, opacity: 0.9, flex: "0 0 auto" },
      // 输入
      inp: Object.assign({ color: "inherit", borderRadius: "10px", padding: "6px 11px",
             fontSize: "12px", outline: "none", width: "100%", boxSizing: "border-box" }, GLASS_SOFT),
      area: Object.assign({ color: "inherit", borderRadius: "12px", padding: "9px 10px",
              fontSize: "12px", outline: "none", width: "100%", boxSizing: "border-box",
              minHeight: "88px", resize: "vertical", fontFamily: "inherit",
              lineHeight: "1.6" }, GLASS_SOFT),
      // 能力架
      shelf: { display: "grid", gap: "8px",
               gridTemplateColumns: "repeat(auto-fill, minmax(132px, 1fr))" },
      tile: Object.assign({ borderRadius: "12px", padding: "11px 8px", cursor: "pointer",
              display: "flex", flexDirection: "column", alignItems: "center", gap: "4px",
              textAlign: "center" }, GLASS_SOFT),
      ico: { fontSize: "23px", lineHeight: "1.1" },
      tname: { fontSize: "12px", fontWeight: 600 },
      twhat: { fontSize: "10.5px", opacity: 0.62, lineHeight: "1.45" },
      dot: (c) => ({ width: "6px", height: "6px", borderRadius: "50%", background: c,
                     display: "inline-block", flex: "0 0 auto" }),
      // 速达（排版照 x-hub：正方形卡片 + 左上角分类色点 + 胶囊页签）
      search: Object.assign({ color: "inherit", borderRadius: "20px", padding: "6px 13px",
                fontSize: "12px", outline: "none", width: "190px",
                boxSizing: "border-box" }, GLASS_SOFT),
      tabs: { display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" },
      tabOn: Object.assign({ color: "#20201c", borderRadius: "20px", padding: "4px 13px",
               fontSize: "11.5px", cursor: "pointer", fontWeight: 600,
               background: "rgba(229,168,75,0.88)",
               border: "1px solid rgba(255,210,150,0.55)",
               boxShadow: "inset 0 1px 0 rgba(255,255,255,0.45), 0 4px 14px rgba(180,120,30,0.30)" },
               glassBlur(14, 180)),
      tabOff: Object.assign({ color: "inherit", borderRadius: "20px", padding: "4px 13px",
                fontSize: "11.5px", cursor: "pointer" }, GLASS_SOFT),
      apps: { display: "flex", flexWrap: "wrap", gap: "8px" },
      app: Object.assign({ position: "relative", width: "86px", height: "86px",
             boxSizing: "border-box", borderRadius: "13px", padding: "10px 6px 7px",
             cursor: "pointer", display: "flex", flexDirection: "column",
             alignItems: "center", justifyContent: "center", gap: "6px",
             textAlign: "center" }, GLASS_SOFT),
      appDot: { position: "absolute", left: "7px", top: "7px", width: "7px", height: "7px",
                borderRadius: "2px", display: "block" },
      appIcon: { width: "34px", height: "34px", objectFit: "contain", display: "block" },
      appNoIcon: { width: "34px", height: "34px", borderRadius: "7px", lineHeight: "34px",
                   textAlign: "center", fontWeight: 700, fontSize: "16px", opacity: 0.75,
                   background: "rgba(128,128,128,0.22)" },
      appName: { fontSize: "10px", lineHeight: "1.2", opacity: 0.85, width: "100%",
                 overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      // 待办
      todo: { display: "flex", gap: "7px", alignItems: "flex-start", padding: "5px 0",
              borderTop: "1px dashed rgba(128,128,128,0.22)" },
      box: { width: "15px", height: "15px", borderRadius: "4px", border: B1,
             flex: "0 0 auto", cursor: "pointer", marginTop: "1px", textAlign: "center",
             lineHeight: "14px", fontSize: "10px" },
      // 甘特（标准式：刻度表头 + 网格竖线 + 今天线 + 计划/进度双层条）
      gRow: { display: "flex", gap: "8px", alignItems: "center" },
      gLab: { width: "132px", flex: "0 0 auto", fontSize: "11.5px", opacity: 0.92,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      gTrack: { position: "relative", flex: "1 1 auto" },
      gGrid: { position: "absolute", top: 0, bottom: 0, width: "1px",
               background: "rgba(128,128,128,0.20)" },
      gToday: { position: "absolute", top: 0, bottom: 0, width: "1px",
                background: "rgba(229,72,77,0.85)" },
      gPlan: { position: "absolute", top: "6px", height: "14px", boxSizing: "border-box",
               background: "rgba(128,128,128,0.26)", border: "1px solid rgba(128,128,128,0.34)",
               borderRadius: "4px" },
      gProg: { position: "absolute", top: "6px", height: "14px", background: ACCENT,
               borderRadius: "4px", transition: "width 0.4s" },
      gTick: { position: "absolute", transform: "translateX(-50%)", fontSize: "9.5px",
               opacity: 0.55, whiteSpace: "nowrap" },
      gEdge: { borderColor: "rgba(128,128,128,0.35)", borderStyle: "solid", borderWidth: "0" },
    };

    const TYPE_COLORS = { promise: "#e5a84b", shelved: "#9aa0a6", fact: "#3ec46d",
      gain: "#3ec46d", loss: "#e5484d", lead: "#57a6ff", self: "#b98cf0", container: "#9aa0a6" };
    const TYPE_LABELS = { promise: "承诺", shelved: "搁置", fact: "事实",
      gain: "得", loss: "失", lead: "主导", self: "人格", container: "容器" };
    const STATE = { live: { c: "#3ec46d", t: "活" }, need: { c: "#e5a84b", t: "待启" },
      todo: { c: "#9aa0a6", t: "未接" } };
    const PRIO = { 0: "rgba(128,128,128,0.55)", 1: "#e5a84b", 2: "#e5484d" };

    async function api(path) {
      const r = await fetch(API + path, { headers: { accept: "application/json" } });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    }

    async function post(path, body) {
      const r = await fetch(API + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    }

    function nf(n) { return typeof n === "number" ? n.toLocaleString("en-US") : "—"; }
    function k(n) {
      if (typeof n !== "number") return "—";
      return n >= 1000 ? (n / 1000).toFixed(0) + "K" : String(n);
    }
    function when(iso) {
      if (!iso) return "";
      const s = String(iso);
      return s.length >= 16 ? s.slice(5, 16).replace("T", " ") : s;
    }
    function dayMs(s) {
      if (!s) return NaN;
      const t = Date.parse(String(s) + "T00:00:00");
      return Number.isFinite(t) ? t : NaN;
    }

    function Card(title, right, children, extra) {
      return h("div", { style: extra ? Object.assign({}, S.card, extra) : S.card },
        h("div", { style: S.head },
          h("span", null, title),
          right ? h("span", { style: S.dim }, right) : null),
        h("div", { style: S.body }, children));
    }

    // ── 水位 ──────────────────────────────────────────────
    function WaterCard(w) {
      if (!w || !w.ok) {
        return Card("水位", null, h("div", { style: S.hint }, (w && w.message) || "读不到投影缓存"));
      }
      const pct = typeof w.pct === "number" ? w.pct : 0;
      const verdict = pct >= 0.88 ? "兜底线以上 · 引擎随时会自己压"
        : pct >= 0.80 ? "红灯 · 该已经卸完了"
        : pct >= 0.68 ? "过了纪律线 · 不是大活就卸载到一手层"
        : pct >= 0.60 ? "引擎在施压 · 可以开始考虑"
        : "健康 · 不用惦记";
      return Card("水位", "服务商口径", [
        h("div", { key: "bar", style: S.bar },
          h("div", { style: Object.assign({}, S.fill, { width: Math.min(100, pct * 100) + "%" }) }),
          (w.bands || []).map((b, i) =>
            h("div", { key: i, style: Object.assign({}, S.tick, { left: (b * 100) + "%" }) }))),
        h("div", { key: "num", style: S.row },
          h("span", { style: { fontWeight: 600, fontSize: "15px" } }, (pct * 100).toFixed(1) + "%"),
          h("span", { style: S.dim }, k(w.pressureTokens) + " / " + k(w.contextWindow))),
        h("div", { key: "v", style: S.hint }, verdict),
        h("div", { key: "raw", style: Object.assign({}, S.hint, S.code) },
          "pressure " + nf(w.pressureTokens) + " · surface " + nf(w.surfaceTokens)
          + " · 引擎外推 " + nf(w.projectedTokens)),
      ]);
    }

    // ── 便签 ──────────────────────────────────────────────
    function NoteCard(text, setText, onSave, extra) {
      return Card("便签", "离开输入框就存", [
        h("textarea", {
          key: "t", value: text || "", style: S.area,
          placeholder: "随手记点什么…（点别处就自动保存）",
          onChange: (e) => setText(e.target.value),
          onBlur: () => onSave(text || ""),
        }),
      ], extra);
    }

    // ── 待办 ──────────────────────────────────────────────
    function TodosCard(todos, draft, setDraft, onAdd, onToggle, onDel, onCycle, extra) {
      const list = (todos || []).slice().sort((a, b) => {
        if (!!a.done !== !!b.done) return a.done ? 1 : -1;
        return (b.prio || 0) - (a.prio || 0);
      });
      const left = list.filter((t) => !t.done).length;
      return Card("待办", left + " 条没做完 · 共 " + list.length, [
        h("input", {
          key: "i", value: draft || "", style: S.inp,
          placeholder: "写一条，回车加上去",
          onChange: (e) => setDraft(e.target.value),
          onKeyDown: (e) => { if (e.key === "Enter") onAdd(draft || ""); },
        }),
        list.length
          ? h("div", { key: "l" }, list.map((t, i) =>
              h("div", { key: t.id || i, style: i ? S.todo : Object.assign({}, S.todo, { borderTop: "none" }) },
                h("div", {
                  style: S.box, title: "勾一下",
                  onClick: () => onToggle(t),
                }, t.done ? "✓" : ""),
                h("div", { style: { flex: "1 1 auto", lineHeight: "1.45" } },
                  h("span", {
                    style: t.done ? { textDecoration: "line-through", opacity: 0.5 } : null,
                  }, t.text),
                  t.due ? h("span", { style: Object.assign({}, S.hint, { marginLeft: "6px" }) }, t.due) : null),
                h("span", {
                  style: S.dot(PRIO[t.prio || 0] || PRIO[0]),
                  title: "点一下换优先级",
                  onClick: () => onCycle(t),
                }),
                h("span", {
                  style: Object.assign({}, S.hint, { cursor: "pointer" }),
                  title: "删掉", onClick: () => onDel(t),
                }, "×"))))
          : h("div", { key: "e", style: S.hint }, "还没有待办"),
      ], extra);
    }

    // ── 项目甘特（标准式）───────────────────────────────────
    // 四个必备要素，缺一个就不叫甘特图：
    //   ① 刻度表头（日期，粒度按跨度自适应）  ② 网格竖线（对齐刻度）
    //   ③ 今天线（红线，一眼看出"现在在哪"）  ④ 计划条 + 进度条双层
    // ★ 日期一律走本地时间。上一版用了 toISOString()，那是 UTC ——
    //   中国的 09-10 零点在 UTC 是 09-09 16:00，轴上就显示成 09-09，整天差一天。
    const GDAY = 86400000;
    const GLAB = "132px";

    function GanttCard(projects, extra) {
      const list = projects || [];
      if (!list.length) {
        return Card("我们的项目", "", [
          h("div", { key: "e", style: S.hint }, "还没有项目。给我一个名字和时间段，我加进去。"),
        ], extra);
      }

      let min = Infinity, max = -Infinity;
      for (const p of list) {
        const a = dayMs(p.start), b = dayMs(p.end);
        if (Number.isFinite(a)) min = Math.min(min, a);
        if (Number.isFinite(b)) max = Math.max(max, b);
      }
      if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
        return Card("我们的项目", list.length + " 个", [
          h("div", { key: "e", style: S.hint }, "项目缺日期，画不出甘特。给每个项目一个 start 和 end。"),
        ], extra);
      }

      // 两端留一点余量，免得条贴着边
      const pad = Math.max(GDAY, (max - min) * 0.05);
      const t0 = min - pad, t1 = max + pad, span = t1 - t0;
      const pct = (ms) => ((ms - t0) / span) * 100;

      // 粒度自适应：跨度小就按天，大了按周/半月/月
      const days = Math.max(1, Math.round((max - min) / GDAY));
      const stepDays = days <= 14 ? 1 : days <= 45 ? 7 : days <= 120 ? 14 : 30;

      const ticks = [];
      const first = new Date(t0);
      first.setHours(0, 0, 0, 0);
      let t = first.getTime();
      while (t < t0) t += GDAY;
      for (; t <= t1; t += stepDays * GDAY) ticks.push(t);

      // ★ 本地日期
      const md = (ms) => { const d = new Date(ms); return (d.getMonth() + 1) + "/" + d.getDate(); };
      const iso = (ms) => {
        const d = new Date(ms);
        const p2 = (n) => String(n).padStart(2, "0");
        return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate());
      };

      const now = new Date();
      now.setHours(0, 0, 0, 0);
      const nowPct = pct(now.getTime());
      const hasToday = nowPct >= 0 && nowPct <= 100;

      // 每行各自画网格与今天线 —— 比跨行叠层简单，视觉上一样连贯
      const layer = () => {
        const out = ticks.map((tk, i) => h("div", { key: "g" + i,
          style: Object.assign({}, S.gGrid, { left: pct(tk) + "%" }) }));
        if (hasToday) out.push(h("div", { key: "now",
          style: Object.assign({}, S.gToday, { left: nowPct + "%" }) }));
        return out;
      };

      const head = h("div", { key: "h",
        style: { display: "flex", gap: "8px", alignItems: "flex-end",
                 paddingBottom: "3px", borderBottom: "1px solid rgba(128,128,128,0.35)" } },
        h("div", { style: { width: GLAB, flex: "0 0 auto" } }),
        h("div", { style: { position: "relative", flex: "1 1 auto", height: "13px" } },
          ticks.map((tk, i) => h("div", { key: i,
            style: Object.assign({}, S.gTick, { left: pct(tk) + "%" }) }, md(tk)))));

      const rows = list.map((p, i) => {
        const a = dayMs(p.start), b = dayMs(p.end);
        const okA = Number.isFinite(a), okB = Number.isFinite(b) && b > a;
        const left = okA ? pct(a) : 0;
        const w = okA && okB ? Math.max(0.8, pct(b) - left) : 0.8;
        const prog = Math.max(0, Math.min(100, Number(p.progress) || 0));
        const tip = (p.start || "?") + " → " + (p.end || "?") + "　" + prog + "%";
        return h("div", { key: p.id || i,
          style: { display: "flex", gap: "8px", alignItems: "center", height: "26px" } },
          h("div", { style: S.gLab, title: p.name }, p.name),
          h("div", { style: { position: "relative", flex: "1 1 auto", height: "26px" }, title: tip },
            layer(),
            okA ? h("div", { style: Object.assign({}, S.gPlan, { left: left + "%", width: w + "%" }) }) : null,
            okA ? h("div", { style: Object.assign({}, S.gProg,
              { left: left + "%", width: (w * prog / 100) + "%" }) }) : null,
            h("div", { style: { position: "absolute", right: 0, top: "6px", fontSize: "10.5px",
              opacity: 0.6 } }, prog + "%")));
      });

      const foot = h("div", { key: "f",
        style: { display: "flex", gap: "8px", alignItems: "center", paddingTop: "3px",
                 borderTop: "1px solid rgba(128,128,128,0.35)" } },
        h("div", { style: Object.assign({}, S.hint, { width: GLAB, flex: "0 0 auto" }) },
          "跨 " + days + " 天"),
        h("div", { style: { position: "relative", flex: "1 1 auto", height: "14px" } },
          h("span", { style: Object.assign({}, S.hint, { position: "absolute", left: 0 }) }, iso(min)),
          h("span", { style: Object.assign({}, S.hint, { position: "absolute", right: 0 }) }, iso(max)),
          hasToday ? h("span", { key: "n",
            style: { position: "absolute", left: nowPct + "%", transform: "translateX(-50%)",
                     fontSize: "10px", color: "rgba(229,72,77,0.95)", whiteSpace: "nowrap" } },
            "今天") : null));

      return Card("我们的项目", list.length + " 个 · 甘特" +
        (hasToday ? "" : " · 今天不在区间内"), [head, h("div", { key: "r" }, rows), foot], extra);
    }

    // ── 能力架 ────────────────────────────────────────────
    function ShelfCard(list, onCopy, extra) {
      const items = list || [];
      return Card("能力架", items.length + " 项 · 点一下复制用法", [
        h("div", { key: "g", style: S.shelf }, items.map((a, i) => {
          const st = STATE[a.state] || STATE.todo;
          return h("div", {
            key: i, style: S.tile, title: a.how || "",
            onClick: () => onCopy(a.how || a.name, a.name),
          },
            h("div", { style: S.ico }, a.emoji || "•"),
            h("div", { style: S.tname }, a.name),
            h("div", { style: S.twhat }, a.what || ""),
            h("div", { style: S.row },
              h("span", { style: S.dot(st.c) }),
              h("span", { style: Object.assign({}, S.hint, { fontSize: "10px" }) }, st.t)));
        })),
      ], extra);
    }

    // ── 速达 ──────────────────────────────────────────────
    // 排版照 x-hub：正方形卡片、图标占主视觉、名字单行截断、左上角分类色点。
    // 页签＝全部/常用/各分类；「常用」按点击次数排，点过的在「全部」里也靠前。
    function AppsCard(apps, onLaunch, q, setQ, tab, setTab, extra) {
      const items = (apps && apps.items) || [];
      const cats = (apps && apps.cats) || [];
      const ok = !!(apps && apps.ok);
      const kw = String(q || "").trim().toLowerCase();

      const catOf = (id) => {
        for (const c of cats) if (c.id === id) return c;
        return { label: "其他", color: "#9aa0a6" };
      };

      const tabs = [{ id: "all", label: "全部" }, { id: "fav", label: "常用" }]
        .concat(cats.filter((c) => c.id !== "other").map((c) => ({ id: c.id, label: c.label })));

      let shown = items.slice();
      if (tab === "fav") {
        shown = shown.filter((a) => (a.used || 0) > 0)
                     .sort((a, b) => (b.used || 0) - (a.used || 0));
      } else if (tab && tab !== "all") {
        shown = shown.filter((a) => a.cat === tab);
      } else {
        shown.sort((a, b) => (b.used || 0) - (a.used || 0));   // 点过的靠前
      }
      if (kw) shown = shown.filter((a) => String(a.name || "").toLowerCase().indexOf(kw) >= 0);

      const view = shown.slice(0, 300);
      const count = shown.length;
      const right = !ok ? "还没扫"
        : count + " 个 · 点一下启动；已在跑的会把窗口唤到前台";

      return Card("速达", right, [
        h("div", { key: "bar",
          style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" } },
          h("div", { key: "t", style: S.tabs }, tabs.map((t) =>
            h("button", {
              key: t.id, style: tab === t.id ? S.tabOn : S.tabOff,
              onClick: () => setTab(t.id),
            }, t.label))),
          h("input", {
            key: "q", value: q || "", placeholder: "找软件…",
            onChange: (e) => setQ(e.target.value), style: S.search,
          })),
        !ok
          ? h("div", { key: "e", style: S.hint }, (apps && apps.message) || "读不到清单")
          : h("div", { key: "g", style: S.apps }, view.map((a, i) => {
              const idx = items.indexOf(a);
              const c = catOf(a.cat);
              return h("div", {
                key: i, style: S.app,
                title: (a.target || "") + (a.used ? "　点过 " + a.used + " 次" : ""),
                onClick: () => onLaunch(idx, a.name),
              },
                h("span", { style: Object.assign({}, S.appDot, { background: c.color }),
                            title: c.label }),
                a.icon
                  ? h("img", { src: API + "/icon?f=" + encodeURIComponent(a.icon),
                               style: S.appIcon, alt: "",
                               // ★  agent：这一页最多 300 个图标，不懒加载就等于
                               //   一进页面同时发 300 个请求 + 300 次解码。加上这两个属性之后，
                               //   屏幕外的图标根本不加载 —— 和宿主半那边的永久缓存配合，
                               //   滚动时不再有几十个并发请求抢主线程。
                               loading: "lazy", decoding: "async" })
                  : h("div", { style: S.appNoIcon },
                      String(a.name || "?").slice(0, 1).toUpperCase()),
                h("div", { style: S.appName }, a.name));
            })),
        ok && !count
          ? h("div", { key: "n", style: S.hint },
              tab === "fav" ? "还没有点过的程序 —— 点几个就会出现在这里。"
                            : "这一类里没有程序。")
          : null,
      ], extra);
    }

    // ── 几扇门 ────────────────────────────────────────────
    function GatesCard(gates, onCopy) {
      return Card("几扇门", "点一下就复制", (gates || []).map((g) =>
        h("div", { key: g.id, style: S.item },
          h("div", { style: S.row },
            h("button", { style: S.btn, onClick: () => onCopy(g.cmd, g.label) }, g.label),
            h("span", { style: S.hint }, g.hint || "")),
          h("div", { style: Object.assign({}, S.code, { marginTop: "6px" }) }, g.cmd))));
    }

    // ── 未结的活 ──────────────────────────────────────────
    function OpenCard(open, extra) {
      const list = open || [];
      return Card("未结的活", list.length ? list.length + " 条 · 最近的在前" : "",
        list.length
          ? list.map((r, i) => h("div", { key: i, style: i ? S.item : null },
              h("div", { style: S.row },
                h("span", { style: Object.assign({}, S.tag,
                  { color: TYPE_COLORS[r.type] || "inherit" }) },
                  TYPE_LABELS[r.type] || r.type || "?"),
                h("span", { style: S.hint }, when(r.t))),
              h("div", { style: { marginTop: "4px", lineHeight: "1.5" } },
                String(r.text || "").slice(0, 240)),
              r.feel
                ? h("div", { style: { marginTop: "4px", lineHeight: "1.5", opacity: 0.7, fontStyle: "italic" } },
                    "♡ " + String(r.feel))
                : null))
          : h("div", { style: S.hint }, "没有未结的承诺或搁置"), extra);
    }

    // ── 最近的账本 ──────────────────────────────────────
    function LedgerCard(ledger, extra) {
      if (!ledger || !ledger.ok) {
        return Card("最近的账本", null,
          h("div", { style: S.hint }, (ledger && ledger.message) || "读不到账本"), extra);
      }
      const rows = ledger.rows || [];
      return Card("最近的账本", "共 " + (ledger.total || 0) + " 条",
        rows.map((r, i) => h("div", { key: i, style: i ? S.item : null },
          h("div", { style: S.row },
            h("span", { style: Object.assign({}, S.tag,
              { color: TYPE_COLORS[r.type] || "inherit" }) },
              TYPE_LABELS[r.type] || r.type || "?"),
            h("span", { style: S.hint }, when(r.t)),
            r.by ? h("span", { style: S.hint }, String(r.by).slice(0, 8)) : null),
          h("div", { style: { marginTop: "4px", lineHeight: "1.5", opacity: 0.9 } },
            String(r.text || "").slice(0, 200)),
          // ★ ：feel 是一手的那半 —— 不截断，截断它最可惜
          r.feel
            ? h("div", { style: { marginTop: "4px", lineHeight: "1.5", opacity: 0.7, fontStyle: "italic" } },
                "♡ " + String(r.feel))
            : null)), extra);
    }

    // ── 算力节点（手机）─────────────────────────────────────
    // 使用者  要的那一格：「做一个进程专门检查手机算力节点是否在线，
    // 做到砚台里面，可以看到它的状态，然后我可以通过这里手动唤醒它。」
    //
    // ★ 数据不是这里探的：宿主半每 15 s 打一次手机（纯 HTTP，**不花 token**），
    //   这里只读 /yantai/api/state 里的 node 字段。
    // ★ 为什么不让这里直接打手机：砚台 19387 → 手机 18766 是跨源，浏览器会拦。
    // ★ 口令只在「连接」那一下用：表单 → 宿主半 → 手机换 token → token 只存在宿主半内存里。
    //   这一侧一个字节都不留（不写 localStorage、不进 state）。
    function NodeCard(n, extra) {
      const [pw, setPw] = react.useState("");
      const [msg, setMsg] = react.useState("");

      const post = function (path, body) {
        setMsg("");
        return fetch(API + path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body || {}),
        }).then(function (r) { return r.json(); }).then(function (j) {
          if (j && j.ok === false) setMsg(j.message || "没成");
          else if (path.indexOf("/wake") >= 0) setMsg("已派活：" + ((j && j.task_id) || "?"));
          return j;
        }).catch(function (e) { setMsg(String((e && e.message) || e)); });
      };

      if (!n) return Card("算力节点", null, h("div", { style: S.hint }, "读不到（宿主半没返回 node）"), extra);

      const secs = n.lastPingAt ? Math.round((Date.now() - n.lastPingAt) / 1000) : null;
      const s = n.status || null;
      const st = n.link || null;
      const tail = secs === null ? "还没探过"
        : secs < 20 ? "刚刚探过（" + secs + "s 前）"
        : "上次探测 " + secs + "s 前";

      const rows = [];
      rows.push(h("div", { key: "st", style: S.row },
        h("span", { style: { fontWeight: 600, color: n.reachable ? ACCENT : "#e06060" } },
          n.reachable ? "● 在线" : "○ 连不上"),
        h("span", { style: S.dim },
          tail + (n.lastPingMs != null ? " · " + n.lastPingMs + " ms" : "") +
          (n.pings ? " · 共 " + n.pings + " 次" : ""))));

      if (!n.reachable && n.lastError) {
        rows.push(h("div", { key: "err", style: Object.assign({}, S.hint, { color: "#e06060" }) },
          n.lastError + " —— 检查手机服务在跑、以及 adb forward 18766"));
      }

      if (n.reachable && st) {
        rows.push(h("div", { key: "p", style: S.row },
          h("span", null, "桌面端 " + (st.pc_connected ? "已连接" : (st.last_pc_host ? "静默 " + st.silent_for_s + "s" : "从没连过"))),
          h("span", { style: S.dim }, st.last_pc_host || "—")));
      }

      if (s) {
        rows.push(h("div", { key: "m", style: S.row },
          h("span", null, s.cores + " 核 · " + (s.freq_khz ? Math.round(s.freq_khz / 1000) + " MHz" : "—")),
          h("span", { style: S.dim },
            s.mem_avail_kb != null
              ? "可用 " + (s.mem_avail_kb / 1e6).toFixed(1) + " / " + (s.mem_total_kb / 1e6).toFixed(1) + " GB"
              : "内存 —")));
        rows.push(h("div", { key: "t", style: S.row },
          h("span", {
            style: { color: s.max_c == null ? undefined : (s.max_c >= 70 ? "#e06060" : s.max_c >= 60 ? "#e0a040" : ACCENT) },
          }, "最高温度 " + (s.max_c == null ? "—" : s.max_c + " °C")),
          h("span", { style: S.dim },
            "剔掉 " + (s.zones_skipped || 0) + " 个不可信传感器 · 电池 " +
            (s.batt_temp_c == null ? "—" : s.batt_temp_c + "°C") + " " + (s.batt_status || ""))));
        rows.push(h("div", { key: "up", style: S.hint },
          "已在跑 " + (s.uptime_s != null ? Math.round(s.uptime_s / 60) + " 分钟" : "—") +
          "　服务 " + ((s.services || []).map(function (x) { return x.id + ":" + x.port + "=" + (x.alive ? "✓" : "✗"); }).join("  ") || "—")));
      } else if (n.reachable) {
        rows.push(h("div", { key: "need", style: S.hint },
          "连上了，但只看到「在不在」—— 温度/内存/唤醒要令牌，在下面连一下。"));
      }

      if (n.models && n.models.length) {
        rows.push(h("div", { key: "md", style: S.hint },
          "模型 " + n.models.map(function (m) { return m.id + "(" + m.state + ")"; }).join("　")));
        rows.push(h("div", { key: "wk", style: S.row },
          n.models.map(function (m) {
            return h("button", {
              key: m.id,
              onClick: function () { post("/node/wake", { id: m.id }); },
              style: { cursor: "pointer", marginRight: "6px", padding: "3px 10px", borderRadius: "6px",
                       border: "1px solid " + ACCENT, background: "transparent", color: ACCENT,
                       font: "inherit", fontSize: "12px" },
            }, "唤醒 " + m.id);
          })));
      }

      // 连接 / 断开
      if (!n.loggedIn) {
        rows.push(h("div", { key: "lg", style: S.row },
          h("input", {
            type: "password", value: pw, placeholder: "手机控制台口令",
            onChange: function (e) { setPw(e.target.value); },
            style: { flex: 1, minWidth: 0, padding: "4px 8px", borderRadius: "6px",
                     border: "1px solid #555", background: "transparent", color: "inherit", font: "inherit" },
          }),
          h("button", {
            onClick: function () { post("/node/login", { password: pw }).then(function () { setPw(""); }); },
            style: { cursor: "pointer", padding: "4px 12px", borderRadius: "6px",
                     border: "1px solid " + ACCENT, background: "transparent", color: ACCENT, font: "inherit" },
          }, "连接")));
        rows.push(h("div", { key: "lgh", style: S.hint },
          "口令只用于换一次令牌，令牌只存在宿主半内存里 —— DSH 重启就要重连一次。"));
      } else {
        rows.push(h("div", { key: "out", style: S.row },
          h("button", {
            onClick: function () { post("/node/logout", {}); },
            style: { cursor: "pointer", padding: "4px 12px", borderRadius: "6px",
                     border: "1px solid #666", background: "transparent", color: "inherit", font: "inherit" },
          }, "断开"),
          h("span", { style: S.dim }, "令牌在宿主半内存里，没落盘")));
      }

      rows.push(h("div", { key: "act", style: S.row },
        h("button", {
          onClick: function () { fetch(API + "/node/ping").catch(function () {}); },
          style: { cursor: "pointer", padding: "3px 10px", borderRadius: "6px",
                   border: "1px solid #666", background: "transparent", color: "inherit",
                   font: "inherit", fontSize: "12px" },
        }, "立刻探一次"),
        h("span", { style: S.dim }, n.origin || "")));

      if (msg) rows.push(h("div", { key: "msg", style: S.hint }, msg));

      return Card("算力节点", "手机 · adb forward", rows, extra);
    }

    function View() {
      const [st, setSt] = react.useState(null);
      const [err, setErr] = react.useState("");
      const [note, setNote] = react.useState("");
      const [q, setQ] = react.useState("");
      const [appTab, setAppTab] = react.useState("all");
      const [noteText, setNoteText] = react.useState(null);
      const [todoDraft, setTodoDraft] = react.useState("");

      const load = react.useCallback(async () => {
        try {
          const j = await api("/state");
          setSt(j);
          setErr("");
          // 便签草稿只初始化一次 —— 否则每 30 秒的轮询会把正在打的字冲掉
          const saved = j && j.desk && j.desk.notes && j.desk.notes[0];
          setNoteText((cur) => (cur === null ? String((saved && saved.text) || "") : cur));
        } catch (e) {
          setErr("读状态失败：" + String((e && e.message) || e));
        }
      }, []);

      react.useEffect(() => {
        load();
        const t = setInterval(load, 30000);
        return () => clearInterval(t);
      }, [load]);

      const flash = react.useCallback((msg) => {
        setNote(msg);
        setTimeout(() => setNote(""), 2600);
      }, []);

      const onCopy = react.useCallback((text, label) => {
        try {
          if (typeof navigator !== "undefined" && navigator.clipboard
              && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(
              () => flash(label + "：已复制"), () => flash(label + "：复制被拒"));
            return;
          }
        } catch (e) { /* 落到下面那句 */ }
        flash("这个环境不给剪贴板");
      }, [flash]);

      const onLaunch = react.useCallback((i, name) => {
        api("/launch?i=" + i).then((r) => {
          flash(r && r.ok ? ("启动了 " + (r.launched || name)) : ("启动失败：" + ((r && r.message) || "?")));
        }).catch((e) => flash("启动失败：" + String((e && e.message) || e)));
      }, [flash]);

      const onSaveNote = react.useCallback((text) => {
        post("/note", { id: "main", text }).then(() => flash("便签已存"))
          .catch((e) => flash("便签没存上：" + String((e && e.message) || e)));
      }, [flash]);

      const onAddTodo = react.useCallback((text) => {
        const t = String(text || "").trim();
        if (!t) return;
        post("/todo", { op: "add", text: t }).then(() => { setTodoDraft(""); load(); })
          .catch((e) => flash("加不上：" + String((e && e.message) || e)));
      }, [load, flash]);

      const onToggle = react.useCallback((t) => {
        post("/todo", { id: t.id, done: !t.done }).then(() => load())
          .catch((e) => flash("改不动：" + String((e && e.message) || e)));
      }, [load, flash]);

      const onCycle = react.useCallback((t) => {
        post("/todo", { id: t.id, prio: ((Number(t.prio) || 0) + 1) % 3 }).then(() => load())
          .catch((e) => flash("改不动：" + String((e && e.message) || e)));
      }, [load, flash]);

      const onDelTodo = react.useCallback((t) => {
        post("/todo", { op: "del", id: t.id }).then(() => load())
          .catch((e) => flash("删不掉：" + String((e && e.message) || e)));
      }, [load, flash]);

      const led = st && st.ledger;
      const desk = st && st.desk;
      const clock = new Date().toISOString().slice(0, 19).replace("T", " ");

      return h("div", { style: S.wrap },
        h("div", { style: Object.assign({}, S.row, { marginBottom: "10px" }) },
          h("span", { style: { fontWeight: 700, fontSize: "15px" } }, "砚台"),
          h("span", { style: S.hint }, clock),
          led && led.ok ? h("span", { style: S.hint }, "· 账本" + (led.total || 0) + " 条") : null,
          st && st.apps && st.apps.ok
            ? h("span", { style: S.hint }, "· 速达 " + st.apps.total + " 个") : null,
          note ? h("span", { style: Object.assign({}, S.hint, { color: ACCENT }) }, "· " + note) : null),

        err ? h("div", { style: S.err }, err) : null,

        h("div", { style: S.grid },
          WaterCard(st && st.water),
          NodeCard(st && st.node, S.half),
          GatesCard(st && st.gates, onCopy),

          NoteCard(noteText, setNoteText, onSaveNote, S.half),
          TodosCard(desk && desk.todos, todoDraft, setTodoDraft,
            onAddTodo, onToggle, onDelTodo, onCycle, S.half),

          GanttCard(desk && desk.projects, S.wide),
          AppsCard(st && st.apps, onLaunch, q, setQ, appTab, setAppTab, S.wide),
          ShelfCard(st && st.abilities, onCopy, S.wide),
          OpenCard(led && led.open, S.half),
          LedgerCard(led, S.half),

          Card("数据落在哪", null, [
            h("div", { key: "0", style: Object.assign({}, S.hint, S.code) },
              (desk && desk.dir) || ""),
            h("div", { key: "1", style: Object.assign({}, S.hint, S.code) },
              (st && st.paths && st.paths.ledger) || ""),
            h("div", { key: "2", style: Object.assign({}, S.hint, S.code) },
              (st && st.paths && st.paths.projcache) || ""),
            h("div", { key: "3", style: S.hint },
              "水位只有一种读法是准的：pressureTokens = input + cacheRead。"),
          ], S.wide),
        ),
      );
    }

    function apply(ctx) {
      // 那排标签里的一格 —— 写法照抄另一个插件的 conversation.view
      ctx.slots.inject("conversation.view", function () {
        ctx.slots.register(
          { name: "conversation.view", id: "yantai", order: 6, label: "砚台" },
          View
        );
      });
    }

    exports.apply = apply;
    // ★★★ 只等 slots。多写一个不存在的服务名，整包就会静默不加载。
    exports.inject = ["slots"];
    return module.exports;
  },
});
