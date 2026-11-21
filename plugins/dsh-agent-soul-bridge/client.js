/**
 * dsh-agent-soul-bridge — 浏览器半（2026-11-13 爀曦定）
 *
 * 侧栏底部一个圆钮，点开是 agent-soul 的控制面板：
 *   · 它在不在跑 / 连没连上宿主 / 会话数与 key 状态
 *   · 启动 · 停止 · 重启 · 检查通路
 * 「检查通路」是**两侧都测**：DSH→v4 的 HTTP 与控制通道登记，v4→DSH 的 ws 在线，
 * 以及 v4 侧 /api/session 的 caps（内嵌 LLM 收消息那条路）。
 *
 * ★ exports.inject = ["slots"] 必须写 —— 少了它整包静默失效（Host 报 running、
 *   浏览器一行不跑、控制台零报错）。这是本插件体系最容易踩的坑。
 */
window.__ModuleLoader__.load({
  id: "dsh-agent-soul-bridge",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var h = react.createElement;

    /* ★ 2026-11-13 爀曦：「太小了我看不见，界面放在顶栏吧」
       侧栏底部那一排图标只有 36px，◉ 挤在里面认不出来。
       顶栏右侧的 utilities 是给人看的（现有 open-in-app / schedule-catalog / session-log-download）。 */
    var SLOT = "conversation.session.header.utilities";
    var BTN_ID = "dsh-as-bridge-btn";
    var PANEL_W = 300;
    var GAP = 8;

    var CSS = [
      /* 顶栏按钮：和旁边那排工具同一套观感 —— 圆角 6px、32px 高、悬停淡底 */
      ".asb-trigger{height:28px;min-width:28px;flex:none;display:inline-flex;align-items:center;gap:5px;padding:0 8px;background:transparent;border:1px solid transparent;border-radius:7px;cursor:pointer;color:inherit;transition:background-color .12s,border-color .12s;font-size:11.5px;}",
      ".asb-trigger .asb-txt{color:#2bb673;font-weight:500;letter-spacing:.02em;}",
      ".asb-trigger{color:#2bb673;}",
      ".asb-trigger:hover{background:rgba(43,182,115,.16);}",
      ".asb-trigger[data-open='1']{background:rgba(127,140,160,.22);}",
      ".asb-panel{position:fixed;z-index:300;box-sizing:border-box;width:300px;padding:12px 14px;border-radius:12px;border:1px solid rgba(128,128,128,.28);background:var(--dsw-alias-bg-layer-2,#fff);color:inherit;box-shadow:0 8px 26px rgba(0,0,0,.24);font-size:12px;line-height:1.55;}",
      ".asb-h{display:flex;align-items:center;gap:7px;font-weight:600;margin-bottom:8px;}",
      ".asb-dot{width:8px;height:8px;border-radius:50%;flex:none;}",
      ".asb-kv{display:flex;justify-content:space-between;gap:10px;padding:2px 0;opacity:.92;}",
      ".asb-kv b{font-weight:500;opacity:.66;}",
      ".asb-sep{height:1px;background:rgba(128,128,128,.22);margin:8px 0;}",
      ".asb-btn{flex:1;min-width:0;padding:5px 8px;border-radius:7px;border:1px solid rgba(128,128,128,.32);background:transparent;color:inherit;cursor:pointer;font-size:11.5px;}",
      ".asb-btn:hover{background:rgba(127,140,160,.14);}",
      ".asb-btn:disabled{opacity:.45;cursor:default;}",
      ".asb-row{display:flex;gap:6px;margin-top:6px;}",
      ".asb-step{display:flex;gap:7px;align-items:flex-start;padding:3px 0;font-size:11.5px;}",
      ".asb-step i{font-style:normal;flex:none;width:12px;}",
      ".asb-ok{color:#1f9d63;}",
      ".asb-no{color:#d4563f;}",
      ".asb-mut{opacity:.6;}",
      ".asb-note{margin-top:6px;font-size:10.5px;opacity:.6;}"
    ].join("");

    function injectCss() {
      if (document.getElementById("dsh-asb-css")) return;
      var s = document.createElement("style");
      s.id = "dsh-asb-css";
      s.textContent = CSS;
      document.head.appendChild(s);
    }

    function fmtTime(t) {
      if (!t) return "—";
      var d = new Date(t);
      return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2) + ":" + ("0" + d.getSeconds()).slice(-2);
    }

    function useAgentSoul() {
      var st = react.useState(null); var state = st[0], setState = st[1];
      var b = react.useState(""); var busy = b[0], setBusy = b[1];
      var p = react.useState(null); var probe = p[0], setProbe = p[1];
      var er = react.useState(""); var lastErr = er[0], setErr = er[1];

      var load = function () {
        /* ★ 2026-11-13：失败必须**看得见**。
           404 最常见的含义是「host 半没加载」—— apply 崩了 / 没重启 / 端口不对。
           以前这里把任何失败都吞成 {offline:true}，看起来和「真的没启动」一模一样，
           于是排查只能靠猜。现在把原因留在 statusError 里，面板上直接显示。 */
        fetch("/agent-soul/status", { cache: "no-store" })
          .then(function (r) {
            if (!r.ok) { setState({ alive: false, offline: true, statusError: "HTTP " + r.status }); return null }
            return r.json().then(function (d) {
              if (d) { d.statusError = ""; if (d.csrf) csrf = String(d.csrf); }
              setState(d);
            });
          })
          .catch(function (e) { setState({ alive: false, offline: true, statusError: String((e && e.message) || e) }) });
      };
      react.useEffect(function () {
        load();
        var t = setInterval(load, 5000);
        return function () { clearInterval(t) };
      }, []);

      var act = function (name) {
        setBusy(name); setErr("");
        /* ★ 2026-11-13：**不要加 ?t= 查询串** —— DSH 的路由是 exact 匹配，
           带 query 的路径匹配不上，直接 404（刚才就是这么错的：status 不带参数能通，带 ?t= 的全 404）。
           防缓存靠 fetch 的 cache:"no-store"，不靠改 URL。 */
        call("/agent-soul/" + name, function () { load() }, true)
          .catch(function (e) { setBusy(""); setErr(String((e && e.message) || e)) })
          .then(function () { setBusy(""); });
      };
      var runProbe = function () {
        setBusy("probe"); setErr("");
        call("/agent-soul/probe", function (d) { setProbe(d) })
          .catch(function (e) { setBusy(""); setErr(String((e && e.message) || e)) })
          .then(function () { setBusy(""); });
      };
      return { state: state, busy: busy, probe: probe, act: act, runProbe: runProbe, load: load, lastErr: lastErr };
    }

    /* ★★★ 2026-11-21：**写操作必须是 POST**，而且要带 requestId + CSRF。
       上一版这里写的是「所有端点只接 GET」，于 start/stop/restart 走 GET → 恒 405。
       那条注释本身就是错的（它把「我当时测出来 405」当成了「端点只接 GET」）。
       现在的判据：MANAGEMENT_ROUTES 里 status/probe 是 GET，其余三个是 POST。 */
    var csrf = "";
    function call(path, onOk, isWrite) {
      var opt = { cache: "no-store" };
      if (isWrite) {
        var rid = "ui-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
        opt.method = "POST";
        opt.headers = { "Content-Type": "application/json", "X-DSH-CSRF": csrf };
        opt.body = JSON.stringify({ requestId: rid, csrf: csrf });
      }
      return fetch(path, opt)
        .then(function (r) {
          if (!r.ok) {
            return r.text().then(function (t) {
              var code = "";
              try { code = (JSON.parse(t) || {}).code || ""; } catch (e) { }
              throw new Error("HTTP " + r.status + (code ? " · " + code : ""));
            });
          }
          return r.json();
        })
        .then(function (d) { if (onOk) onOk(d); return d });
    }

    function Panel(props) {
      var as = useAgentSoul();
      var s = as.state;
      var alive = !!(s && s.alive);
      var conn = !!(s && s.control && s.control.ok);
      var dot = function (on) { return { width: 8, height: 8, borderRadius: "50%", flex: "none", background: on ? "#1f9d63" : "#d4563f" }; };
      var header = h("div", { className: "asb-h" },
        h("span", { style: dot(alive) }),
        h("span", null, "agent-soul"),
        h("span", { style: { marginLeft: "auto", fontSize: 10.5, opacity: .6 } },
          (s && s.version ? "v" + s.version + " · " : "") + (alive ? "运行中" : "未运行")));

      var rows = [];
      rows.push(h("div", { className: "asb-kv", key: "pid" }, h("b", null, "进程"), h("span", null, alive ? ("pid " + (s.health.pid || "—") + " · " + (s.health.sessions || 0) + " 会话") : "—")));
      rows.push(h("div", { className: "asb-kv", key: "llm" }, h("b", null, "内嵌 LLM"), h("span", null, alive ? (s.health.llmUsable ? "可用" : (s.health.llmReady ? "key 在但不可用" : "无 key")) : "—")));
      rows.push(h("div", { className: "asb-kv", key: "ctl" }, h("b", null, "宿主登记"), h("span", { className: conn ? "asb-ok" : "asb-no" }, conn ? ("已连 " + s.control.connected + " 台") : "未连")));
      rows.push(h("div", { className: "asb-kv", key: "ws" }, h("b", null, "bridge ws"), h("span", { className: (s && s.bridge && s.bridge.connected) ? "asb-ok" : "asb-no" }, (s && s.bridge && s.bridge.connected) ? "在线" : "断开")));
      rows.push(h("div", { className: "asb-kv", key: "sp" }, h("b", null, "守护拉起"), h("span", { className: "asb-mut" }, (s && s.keeper && s.keeper.enabled) ? ("已启用 · 拉起过 " + s.keeper.spawned + " 次") : "未启用")));
      /* ★ 2026-11-13：本体路径要看得见 —— 「启动」按钮拉的就是这个 exe，
         路径不对时点下去只会安静失败。悬停能看全路径。 */
      var plan = (s && s.plan) || null;
      rows.push(h("div", { className: "asb-kv", key: "exe" },
        h("b", null, "本体"),
        h("span", { className: plan ? (plan.exeExists ? "asb-ok" : "asb-no") : "asb-mut", title: plan ? plan.exe : "" },
          plan ? (plan.exeExists ? ("exe 在 · " + String(plan.root || "").replace(/^.*\//, "")) : "找不到 exe") : "—")));

      var btns = h("div", { className: "asb-row" },
        h("button", { className: "asb-btn", disabled: !!as.busy || alive, onClick: function () { as.act("start") } }, as.busy === "start" ? "启动中…" : "启动"),
        h("button", { className: "asb-btn", disabled: !!as.busy || !alive, onClick: function () { as.act("stop") } }, as.busy === "stop" ? "停止中…" : "停止"),
        h("button", { className: "asb-btn", disabled: !!as.busy, onClick: function () { as.act("restart") } }, as.busy === "restart" ? "重启中…" : "重启"));

      var probeBlock = null;
      if (as.probe && as.probe.steps) {
        probeBlock = h("div", { key: "probe" },
          h("div", { className: "asb-sep" }),
          h("div", { className: "asb-kv" }, h("b", null, "通路检查"), h("span", { className: as.probe.ok ? "asb-ok" : "asb-no" }, as.probe.ok ? "全通" : "有断点")),
          as.probe.steps.map(function (st, i) {
            return h("div", { className: "asb-step", key: i },
              h("i", { className: st.ok ? "asb-ok" : "asb-no" }, st.ok ? "✓" : "✗"),
              h("span", null, h("b", { style: { fontWeight: 500 } }, st.name), h("div", { className: "asb-mut", style: { fontSize: 10.5 } }, st.detail || "")));
          }));
      }

      return h("div", null,
        header,
        rows,
        btns,
        h("div", { className: "asb-row" },
          h("button", { className: "asb-btn", disabled: !!as.busy, onClick: as.runProbe }, as.busy === "probe" ? "检查中…" : "检查通路")),
        as.lastErr ? h("div", { className: "asb-step" }, h("i", { className: "asb-no" }, "!"), h("span", null, "失败：" + as.lastErr)) : null,
        (s && s.statusError) ? h("div", { className: "asb-step" }, h("i", { className: "asb-no" }, "!"),
          h("span", null, "状态读不到：" + s.statusError,
            h("div", { className: "asb-mut", style: { fontSize: 10.5 } }, "HTTP 404 = host 半没加载（apply 抛了 / 没重启 DSH）"))) : null,
        probeBlock,
        h("div", { className: "asb-note" }, "端点：/agent-soul/status·start·stop·restart·probe（同源，走 Host）"));
    }

    function Trigger() {
      var o = react.useState(false); var open = o[0], setOpen = o[1];
      var pos = react.useState(null); var xy = pos[0], setXY = pos[1];
      var ref = react.useRef(null);

      var place = function () {
        var el = document.getElementById(BTN_ID);
        if (!el) return;
        var r = el.getBoundingClientRect();
        var left = Math.max(8, Math.min(window.innerWidth - PANEL_W - 8, r.right - PANEL_W));
        /* 顶栏在上面 → 面板默认朝下弹；下方放不开才往上翻 */
        var top = r.bottom + GAP;
        if (top + 320 > window.innerHeight) top = Math.max(8, r.top - GAP - 300);
        setXY({ left: left, top: top });
      };
      react.useEffect(function () {
        if (!open) return;
        place();
        var onDoc = function (e) {
          var el = document.getElementById(BTN_ID);
          if (el && el.contains(e.target)) return;
          if (e.target && e.target.closest && e.target.closest(".asb-panel")) return;
          setOpen(false);
        };
        var onEsc = function (e) { if (e.key === "Escape") setOpen(false); };
        document.addEventListener("mousedown", onDoc, true);
        document.addEventListener("keydown", onEsc);
        window.addEventListener("resize", place);
        return function () {
          document.removeEventListener("mousedown", onDoc, true);
          document.removeEventListener("keydown", onEsc);
          window.removeEventListener("resize", place);
        };
      }, [open]);

      return h("div", { style: { position: "relative", display: "inline-flex" } },
        h("button", {
          id: BTN_ID,
          className: "asb-trigger",
          title: "agent-soul · 状态与通路",
          "data-open": open ? "1" : "0",
          onClick: function () { injectCss(); setOpen(!open); }
        }, h("svg", { width: 20, height: 20, viewBox: "0 0 20 20", "aria-hidden": "true" },
          h("circle", { cx: 10, cy: 10, r: 7.2, fill: "none", stroke: "currentColor", strokeWidth: 1.7, opacity: 0.9 }),
          h("circle", { cx: 10, cy: 10, r: 2.9, fill: "currentColor" }),
          h("circle", { cx: 10, cy: 2.6, r: 1.4, fill: "currentColor", opacity: 0.95 })
        ), h("span", { className: "asb-txt" }, "agent-soul")),
        open && xy ? h("div", { className: "asb-panel", style: { left: xy.left, top: xy.top } }, h(Panel)) : null);
    }

    function apply(ctx) {
      injectCss();
      ctx.slots.inject(SLOT, function () {
        return ctx.slots.register(
          { name: SLOT, id: "agent-soul-bridge", order: 55, label: "agent-soul" },
          function () { return h(Trigger) }
        );
      });
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  }
});
