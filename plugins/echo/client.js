// dsh-agent-echo —— 浏览器半 v2（仪表盘）
// ============================================================================
// 
//   「我想让它以仪表盘的形式去更新，并且给检测等级
//     （1级 5 分钟 / 2级 10 分钟 / 3级 30 分钟 / 4级 手动，默认 3 级）就像 windows 任务管理器这样」
//
// ★ 实时感从哪来：**客户端每 2 秒拉一次 /api/status，但那只是读宿主半的内存缓存**（微秒级）；
//   真正的体检由宿主半的后台节拍按等级跑。所以「秒级刷新」和「不浪费 CPU」同时成立 ——
//   这也是任务管理器的做法。
//
// ★★ exports.inject = ["slots"] 必须写 —— 少了它整包**静默失效**：
//    Host 报 running、浏览器一行不跑、控制台一个错都没有。
// ============================================================================

window.__ModuleLoader__.load({
  id: "dsh-agent-echo",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");

    // 桌面端（Electron）页面 origin 是 file:// 或 app://，相对路径打不到 19387 —— 必须绝对 URL。
    const ORIGIN =
      typeof window !== "undefined" && window.location && /^https?:/.test(window.location.protocol)
        ? window.location.origin
        : "http://127.0.0.1:19387";
    const API = ORIGIN + "/agent-echo/api";

    const C = { ok: "#3fb950", warn: "#d29922", error: "#f85149", info: "#8b949e" };
    const ICON = { ok: "✓", warn: "!", error: "✗", info: "·" };
    const LABEL = { ok: "健康", warn: "注意", error: "故障", info: "信息" };
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

    function BigNum(props) {
      return react.createElement(
        "div",
        { style: { flex: 1, minWidth: 58, padding: "6px 8px", background: "#0d1117", border: "1px solid #21262d", borderRadius: 8, textAlign: "center" } },
        react.createElement("div", { style: { fontSize: 26, lineHeight: "32px", fontWeight: 600, color: props.color || "#e6edf3" } }, String(props.value)),
        react.createElement("div", { style: { fontSize: 11, color: "#8b949e" } }, props.label)
      );
    }

    function EchoPanel() {
      const [d, setD] = react.useState(null);
      const [open, setOpen] = react.useState({});
      const [note, setNote] = react.useState(null);
      const [busy, setBusy] = react.useState(false);

      // 每 2 秒拉一次 —— 读的是宿主半的内存缓存，这一步永远微秒级
      react.useEffect(() => {
        let stop = false;
        const pull = () =>
          fetch(API + "/status")
            .then((r) => r.json())
            .then((j) => { if (!stop) setD(j) })
            .catch(() => { /* 宿主半没起来时静默；下面会看到 warming 状态 */ });
        pull();
        const t = setInterval(pull, 2000);
        return () => { stop = true; clearInterval(t) };
      }, []);

      const post = (path, msg) => {
        setBusy(true);
        setNote(msg);
        return fetch(API + path, { method: "POST" })
          .then((r) => r.json())
          .then((j) => fetch(API + "/status").then((r) => r.json()).then((s) => { setD(s); return j }))
          .then((j) => { setNote(null); return j })
          .catch((e) => { setNote("✗ " + String((e && e.message) || e)) })
          .then((j) => { setBusy(false); return j });
      };

      const checks = (d && d.checks) || [];
      const counts = (d && d.counts) || { error: 0, warn: 0, ok: 0, pending: 0 };
      const overall = d ? d.overall : "info";
      const hist = (d && d.history) || [];
      const warming = !d || d.warming;

      return react.createElement(
        "div",
        { style: { padding: "10px 12px", fontSize: 13, lineHeight: "20px", color: "#c9d1d9", overflowY: "auto", height: "100%" } },

        // ── 标题 ──
        react.createElement(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 6 } },
          react.createElement("span", { style: { fontSize: 16, fontWeight: 600, color: C[overall] } }, ICON[overall] + " 回声 Echo"),
          react.createElement("span", { style: { fontSize: 12, color: "#8b949e" } }, warming ? "首次体检中…" : (LABEL[overall] || overall)),
          react.createElement("span", { style: { flex: 1 } }),
          react.createElement("span", { style: { fontSize: 11, color: "#484f58" } },
            "快检 " + fmtAge(d && d.fastAgeMs) + "　深检 " + fmtAge(d && d.deepAgeMs) +
            (!warming && d ? "　下次 " + fmtIn(d.nextFastInMs) : "") +
            (busy ? "　⚙ 体检中" : ""))
        ),

        // ── 大数字 ──
        react.createElement(
          "div",
          { style: { display: "flex", gap: 8, marginBottom: 8 } },
          react.createElement(BigNum, { value: counts.error, label: "故障", color: counts.error ? C.error : "#484f58" }),
          react.createElement(BigNum, { value: counts.warn, label: "注意", color: counts.warn ? C.warn : "#484f58" }),
          react.createElement(BigNum, { value: counts.ok, label: "健康", color: C.ok }),
          react.createElement(BigNum, { value: counts.pending || 0, label: "待深检", color: "#484f58" })
        ),

        // ── 等级 + 动作 ──
        react.createElement(
          "div",
          { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 8 } },
          react.createElement("span", { style: { fontSize: 11, color: "#8b949e" } }, "等级"),
          LEVELS.map((lv) =>
            react.createElement(
              "button",
              {
                key: lv.n,
                onClick: () => post("/level?n=" + lv.n, "切到 " + lv.name + "（" + lv.every + "）…"),
                title: lv.name + "：" + lv.every + "轮询一次",
                style: {
                  padding: "2px 10px", borderRadius: 6, fontSize: 12, cursor: "pointer",
                  background: d && d.level === lv.n ? "#1f6feb" : "#21262d",
                  color: d && d.level === lv.n ? "#fff" : "#c9d1d9",
                  border: "1px solid " + (d && d.level === lv.n ? "#1f6feb" : "#30363d"),
                },
              },
              lv.name
            )
          ),
          react.createElement("span", { style: { flex: 1 } }),
          react.createElement(
            "button",
            {
              onClick: () => post("/scan", "手动体检中（快检 ~1s + 深检 ~10s）…"),
              disabled: busy,
              style: { padding: "2px 12px", borderRadius: 6, fontSize: 12, cursor: busy ? "default" : "pointer", background: "#21262d", color: "#c9d1d9", border: "1px solid #30363d" },
            },
            busy ? "体检中…" : "立即体检"
          ),
          react.createElement(
            "button",
            {
              onClick: () => post("/rebuild", "重建索引 + 装配 SELF（约 40 秒）…"),
              disabled: busy,
              title: "重建 L4 索引并重新装配 SELF（会写 index/ 与 SELF.md）",
              style: { padding: "2px 12px", borderRadius: 6, fontSize: 12, cursor: busy ? "default" : "pointer", background: "#21262d", color: "#c9d1d9", border: "1px solid #30363d" },
            },
            "重建索引"
          )
        ),

        note ? react.createElement("div", { style: { marginBottom: 6, fontSize: 12, color: "#8b949e" } }, note) : null,

        // ── 趋势条 ──
        react.createElement(
          "div",
          { style: { marginBottom: 8 } },
          react.createElement("div", { style: { fontSize: 11, color: "#8b949e", marginBottom: 3 } }, "趋势（最近 " + hist.length + " 次快检，柱高 = 问题数）"),
          react.createElement(
            "div",
            { style: { display: "flex", alignItems: "flex-end", gap: 1, height: 26, padding: "0 2px", background: "#0d1117", border: "1px solid #21262d", borderRadius: 6 } },
            hist.length === 0
              ? react.createElement("span", { style: { fontSize: 11, color: "#484f58", padding: 4 } }, "还没有数据")
              : hist.map((h, i) => {
                  const n = h.error + h.warn;
                  const hh = n === 0 ? 3 : Math.min(24, 4 + n * 5);
                  return react.createElement("div", {
                    key: i,
                    title: h.t + "　" + h.error + " 错 / " + h.warn + " 警 / " + h.ok + " 好　" + h.ms + "ms　(" + h.why + ")",
                    style: { flex: 1, minWidth: 2, height: hh, background: h.error ? C.error : h.warn ? C.warn : C.ok, borderRadius: 1, opacity: 0.8 },
                  });
                })
          )
        ),

        // ── 十项检查 ──
        checks.map((c) =>
          react.createElement(
            "div",
            { key: c.id, style: { borderTop: "1px solid #21262d", padding: "5px 0" } },
            react.createElement(
              "div",
              { onClick: () => setOpen(Object.assign({}, open, { [c.id]: !open[c.id] })), style: { display: "flex", gap: 8, cursor: "pointer", alignItems: "baseline" } },
              react.createElement("span", { style: { color: C[c.status], width: 14, flex: "0 0 14px" } }, ICON[c.status]),
              react.createElement("span", { style: { flex: "0 0 132px", color: "#e6edf3" } }, c.label),
              react.createElement("span", { style: { flex: 1, color: c.status === "ok" ? "#8b949e" : "#c9d1d9", fontSize: 12 } }, c.detail),
              react.createElement("span", { style: { color: "#484f58", fontSize: 11 } }, open[c.id] ? "▾" : "▸")
            ),
            open[c.id]
              ? react.createElement(
                  "pre",
                  { style: { margin: "4px 0 0 22px", padding: 8, background: "#0d1117", border: "1px solid #21262d", borderRadius: 6, fontSize: 11, lineHeight: "16px", color: "#8b949e", overflowX: "auto", whiteSpace: "pre-wrap" } },
                  JSON.stringify(c.evidence, null, 2)
                )
              : null
          )
        ),

        // ── 页脚 ──
        react.createElement(
          "div",
          { style: { marginTop: 10, paddingTop: 8, borderTop: "1px solid #21262d", fontSize: 11, color: "#484f58", lineHeight: "17px" } },
          "体检逻辑：<你的体检脚本>（命令行 node echo-doctor.mjs 跑的是同一份）",
          react.createElement("br"),
          "快检不看日志（约 0.9 秒）· 深检真去取一次门牌（约 9 秒）· 面板每 2 秒读一次缓存"
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
