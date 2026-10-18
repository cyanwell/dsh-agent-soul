// dsh-agent-riji —— 浏览器半（日记）
//
// 它就是顶部那排按钮里的一格，
// 注册在 keyed 槽位 conversation.view 上。写法照抄 dsh-agent-yantai/client.js：
//   ctx.slots.inject("conversation.view", () => ctx.slots.register(
//     { name: "conversation.view", id, order, label }, View))
//
// ★★★ exports.inject 只写 ["slots"]。
//   多写一个桌面端没有的服务名（sidebarRight / layout 之类），cordis 会一直等它，
//   apply 永远不执行 —— 表现为「什么都不报、什么都不显示」。这个坑踩过两次。
//
// ★ 改这个文件必须重启 DSH：客户端入口图是启动时一次性组合的。

window.__ModuleLoader__.load({
  id: "dsh-agent-riji",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var h = react.createElement;

    const API = "/riji/api";

    // ══ 玻璃（和丹房/砚台同一套，视觉要一致）══════════════════════
    const glassBlur = (px, sat) => ({
      backdropFilter: "blur(" + px + "px) saturate(" + sat + "%)",
      WebkitBackdropFilter: "blur(" + px + "px) saturate(" + sat + "%)",
    });
    const GLASS = Object.assign({
      background: "rgba(255,255,255,0.07)",
      border: "1px solid rgba(255,255,255,0.15)",
      boxShadow:
        "inset 1px 0 0 rgba(255,122,122,0.15), inset -1px 0 0 rgba(122,172,255,0.17), " +
        "inset 0 1px 0 rgba(255,255,255,0.30), inset 0 -1px 0 rgba(0,0,0,0.16)",
      borderRadius: "14px",
    }, glassBlur(28, 190));
    const GLASS_SOFT = Object.assign({}, GLASS, { background: "rgba(255,255,255,0.045)" }, glassBlur(18, 165));

    const S = {
      wrap: { padding: "10px 12px", height: "100%", boxSizing: "border-box", display: "flex", flexDirection: "column", gap: "9px", overflow: "hidden" },
      bar: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" },
      body: { display: "flex", gap: "10px", flex: "1 1 auto", minHeight: 0 },
      paneL: Object.assign({ flex: "0 0 246px", overflowY: "auto", padding: "8px" }, GLASS_SOFT),
      paneR: Object.assign({ flex: "1 1 auto", overflowY: "auto", padding: "18px 22px" }, GLASS),
      item: { display: "block", width: "100%", textAlign: "left", padding: "7px 9px", marginBottom: "3px", borderRadius: "9px", border: "1px solid transparent", background: "transparent", color: "inherit", cursor: "pointer", fontSize: "12.5px", lineHeight: "1.45" },
      itemOn: { background: "rgba(80,150,235,0.20)", border: "1px solid rgba(80,150,235,0.42)" },
      btn: Object.assign({ padding: "5px 11px", borderRadius: "9px", border: "1px solid rgba(255,255,255,0.16)", background: "rgba(255,255,255,0.07)", color: "inherit", cursor: "pointer", fontSize: "12.5px" }, glassBlur(14, 170)),
      hint: { fontSize: "11.5px", opacity: 0.62 },
      err: { fontSize: "12.5px", color: "#ff9b9b" },
      empty: Object.assign({ padding: "18px", textAlign: "center" }, GLASS_SOFT),
    };

    // ══ 极简 markdown → React 节点 ══════════════════════════════════
    // ★ 为什么自己写而不是引一个库：这里只需要日记实际用到的五种东西
    //   （标题 / 粗体 / 引用 / 列表 / 分隔线）。引入整包 marked 会让
    //   client.js 这个「启动期就要解析」的资源白白变重。
    // ★ 行内只处理 **粗体**，其余原样 —— 日记里没有更复杂的行内语法。
    function inline(text, keyBase) {
      const out = [];
      const re = /\*\*(.+?)\*\*/g;
      let last = 0;
      let m;
      let i = 0;
      while ((m = re.exec(text)) !== null) {
        if (m.index > last) out.push(text.slice(last, m.index));
        out.push(h("strong", { key: keyBase + "-b" + (i++), style: { color: "#cfe4ff" } }, m[1]));
        last = m.index + m[0].length;
      }
      if (last < text.length) out.push(text.slice(last));
      return out.length ? out : [text];
    }

    function renderMd(src) {
      const lines = String(src || "").replace(/\r\n?/g, "\n").split("\n");
      const blocks = [];
      let list = null;

      const flushList = () => {
        if (list && list.length) {
          blocks.push(h("ul", { key: "ul" + blocks.length, style: { margin: "4px 0 10px", paddingLeft: "20px" } },
            list.map((t, i) => h("li", { key: i, style: { margin: "2px 0", lineHeight: "1.75" } }, inline(t, "li" + i)))));
        }
        list = null;
      };

      lines.forEach((raw, idx) => {
        const line = raw.replace(/\s+$/, "");
        const t = line.trim();

        if (!t) { flushList(); return; }

        // 分隔线
        if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
          flushList();
          blocks.push(h("hr", { key: "hr" + idx, style: { border: "none", borderTop: "1px solid rgba(255,255,255,0.14)", margin: "16px 0" } }));
          return;
        }

        // 标题
        const hd = t.match(/^(#{1,6})\s+(.*)$/);
        if (hd) {
          flushList();
          const lv = hd[1].length;
          const size = lv === 1 ? "20px" : lv === 2 ? "16px" : "14px";
          blocks.push(h("div", {
            key: "h" + idx,
            style: {
              fontSize: size, fontWeight: 600,
              margin: lv === 1 ? "2px 0 14px" : "18px 0 8px",
              paddingBottom: lv <= 2 ? "6px" : 0,
              borderBottom: lv <= 2 ? "1px solid rgba(255,255,255,0.10)" : "none",
              lineHeight: "1.5",
            },
          }, inline(hd[2], "h" + idx)));
          return;
        }

        // 引用
        if (t.startsWith(">")) {
          flushList();
          blocks.push(h("div", {
            key: "q" + idx,
            style: {
              margin: "8px 0", padding: "7px 12px",
              borderLeft: "3px solid rgba(122,172,255,0.55)",
              background: "rgba(122,172,255,0.08)", borderRadius: "0 8px 8px 0",
              lineHeight: "1.75",
            },
          }, inline(t.replace(/^>\s?/, ""), "q" + idx)));
          return;
        }

        // 列表
        const li = t.match(/^[-*]\s+(.*)$/);
        if (li) {
          if (!list) list = [];
          list.push(li[1]);
          return;
        }

        // 段落
        flushList();
        blocks.push(h("p", { key: "p" + idx, style: { margin: "0 0 10px", lineHeight: "1.85" } }, inline(t, "p" + idx)));
      });

      flushList();
      return blocks;
    }

    async function api(path) {
      const r = await fetch(API + path);
      return await r.json();
    }

    // ══ 视图 ════════════════════════════════════════════════════════
    function View() {
      const [docs, setDocs] = react.useState(null);   // null = 还没读完
      const [err, setErr] = react.useState("");
      const [cur, setCur] = react.useState(null);     // 当前打开的篇名
      const [doc, setDoc] = react.useState(null);     // { title, text, bytes }
      const [loading, setLoading] = react.useState(false);

      const loadList = react.useCallback(() => {
        setErr("");
        api("/list").then((r) => {
          if (!r || !r.ok) { setErr((r && r.message) || "读不到日记目录"); setDocs([]); return; }
          setDocs(r.docs || []);
        }).catch((e) => { setErr(String((e && e.message) || e)); setDocs([]); });
      }, []);
      react.useEffect(() => { loadList(); }, [loadList]);

      const open = react.useCallback((name) => {
        setCur(name); setLoading(true); setDoc(null);
        api("/doc?name=" + encodeURIComponent(name)).then((r) => {
          if (!r || !r.ok) { setErr((r && r.message) || "读不到这一篇"); return; }
          setDoc(r);
        }).catch((e) => setErr(String((e && e.message) || e))).finally(() => setLoading(false));
      }, []);

      const right = docs === null ? "读取中…" : (docs.length + " 篇");

      return h("div", { style: S.wrap },
        h("div", { key: "bar", style: S.bar },
          h("span", { style: { fontSize: "13px", fontWeight: 600 } }, "日记"),
          h("span", { style: S.hint }, "<你的日记目录>"),
          h("span", { style: Object.assign({}, S.hint, { flex: "1 1 auto" }) }, right),
          h("button", { style: S.btn, onClick: loadList, title: "重新扫一遍目录" }, "刷新")),

        err ? h("div", { key: "e", style: S.err }, err) : null,

        h("div", { key: "body", style: S.body },
          h("div", { key: "L", style: S.paneL },
            docs === null ? h("div", { style: S.hint }, "读取中…")
              : docs.length === 0 ? h("div", { style: S.hint }, "还没有日记。")
              : docs.map((d) =>
                  h("button", {
                    key: d.name, style: Object.assign({}, S.item, cur === d.name ? S.itemOn : null),
                    onClick: () => open(d.name), title: d.name + "  " + Math.round((d.size || 0) / 1024) + " KB",
                  },
                    h("div", { style: { fontWeight: 600 } }, d.title || d.name),
                    h("div", { style: Object.assign({}, S.hint, { marginTop: "2px" }) }, d.name)))) ,

          h("div", { key: "R", style: S.paneR },
            !cur ? h("div", { style: S.empty },
                      h("div", null, "左边挑一篇。"),
                      h("div", { style: Object.assign({}, S.hint, { marginTop: "6px" }) },
                        "这里读的是工作区里的一手 markdown，不是转述。"))
              : loading ? h("div", { style: S.hint }, "读取中…")
              : !doc ? h("div", { style: S.hint }, "…")
              : h("div", null,
                  h("div", { style: { fontSize: "11.5px", opacity: 0.55, marginBottom: "12px" } },
                    doc.name + " · " + doc.bytes + " 字节"),
                  renderMd(doc.text)))),

        h("div", { key: "foot", style: S.hint },
          "★ 日记是读物：只留最新结论，被推翻的不再出现。改过什么的沿革在账本和会话日志里。"),
      );
    }

    function apply(ctx) {
      ctx.slots.inject("conversation.view", function () {
        ctx.slots.register(
          { name: "conversation.view", id: "riji", order: 7, label: "日记" },
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
