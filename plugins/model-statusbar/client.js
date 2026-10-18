// dsh-agent-model-statusbar —— 浏览器半
//
// 一张常驻小卡片，贴在【左下角、侧边栏右边】（shell.overlay）：
//   折叠（默认）： ● 本地模型 运行中 9.63 GB        ← 一眼看到状态
//   展开：        本地模型 / ComfyUI :8188 接口通 / 显存 xx / [拉起][静息][关闭][刷新] / 底模清单
//
// ── 为什么不用 sidebar.footer.action（原本打算用的槽位）──────────
// 实测量过那个槽位：容器是 `hHd-Xa_footerActions`，只有 **256×36 px**，
// 而且里面已经放着一个 103×36 的「已有的一个按钮」按钮。一块信息卡塞进去只会被挤扁，
// 所以改挂 shell.overlay，自己定位置和尺寸。
//
// ── 为什么是左下角、left:292px ────────────────────────────────
//   · 右下角被桌宠占了（另一个插件：position:fixed; right:26px; bottom:20px;
//     width:170px; z-index:40），绝不能重叠 → 所以不用右下角。
//   · 实测侧边栏 root 宽 280px（hHd-Xa_root），左栏底部还压着「设置」按钮，
//     所以左下角让出侧边栏的宽度：left = 280 + 12 = 292px。
//   · z-index 45 —— 比桌宠（40）高一点，但不至于盖住任何弹窗。
//   · 默认折叠成一行（约 160×28），不去压会话输入框。
//
// ★ exports.inject 必须写 —— 少了它整包静默失效：
//   Host 照样报 client:{status:"running"}，浏览器里一行代码不跑，控制台一个错都没有。
//   这是这个插件体系最容易踩、且完全不报错的坑。
window.__ModuleLoader__.load({
  id: "dsh-agent-model-statusbar",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var h = react.createElement;

    var API = "/model-statusbar/api";

    // 中性灰描边 + inherit 文字色 —— 浅色/深色主题都不用改（照 comfyui-panel 的做法）
    var B1 = "1px solid rgba(128,128,128,0.35)";
    var SHADOW = "0 4px 16px rgba(0,0,0,0.22)";

    var S = {
      dock: {
        position: "fixed", left: "292px", bottom: "12px", zIndex: 45,
        color: "inherit", fontSize: "12px", lineHeight: "1.4",
        fontFamily: "inherit", boxSizing: "border-box",
      },
      card: {
        display: "flex", flexDirection: "column", gap: "6px",
        padding: "8px 10px", border: B1, borderRadius: "10px",
        background: "rgba(127,127,127,0.12)", backdropFilter: "blur(6px)",
        boxShadow: SHADOW, width: "238px", boxSizing: "border-box",
      },
      pill: {
        display: "flex", alignItems: "center", gap: "6px",
        padding: "4px 9px", border: B1, borderRadius: "999px",
        background: "rgba(127,127,127,0.12)", backdropFilter: "blur(6px)",
        boxShadow: SHADOW, cursor: "pointer", userSelect: "none",
        whiteSpace: "nowrap", width: "fit-content",
      },
      head: { display: "flex", alignItems: "center", gap: "6px", justifyContent: "space-between" },
      title: { fontWeight: 600, whiteSpace: "nowrap" },
      line: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" },
      dim: { opacity: 0.6 },
      row: { display: "flex", gap: "5px", flexWrap: "wrap" },
      btn: {
        background: "rgba(128,128,128,0.16)", color: "inherit", border: B1,
        borderRadius: "6px", padding: "3px 8px", fontSize: "11.5px",
        cursor: "pointer", lineHeight: "1.5", whiteSpace: "nowrap",
      },
      ghost: {
        background: "transparent", color: "inherit", border: "none",
        cursor: "pointer", opacity: 0.6, fontSize: "12px", padding: "0 2px",
        lineHeight: 1,
      },
      list: {
        margin: "2px 0 0", padding: 0, listStyle: "none",
        display: "flex", flexDirection: "column", gap: "3px",
        maxHeight: "132px", overflowY: "auto",
      },
      note: { opacity: 0.72, fontSize: "11px", lineHeight: "1.45", wordBreak: "break-word" },
      // 组合模型的「三件套」分项行 —— 比主行更小更淡，缩在名字下面
      bparts: {
        opacity: 0.5, fontSize: "10.5px", whiteSpace: "nowrap",
        overflow: "hidden", textOverflow: "ellipsis",
      },
    };

    var PHASE = {
      running: { text: "运行中", color: "#3ec46d" },
      idle: { text: "已静息", color: "#e0a83c" },
      stopped: { text: "已关闭", color: "rgba(128,128,128,0.55)" },
      loading: { text: "探测中", color: "rgba(128,128,128,0.55)" },
      unknown: { text: "探测失败", color: "#e06c5a" },
    };

    function dot(color, glow) {
      return h("span", {
        style: {
          width: "8px", height: "8px", borderRadius: "50%", background: color,
          boxShadow: glow ? "0 0 6px " + color : "none",
          display: "inline-block", flex: "0 0 auto",
        },
      });
    }

    function fmtMiB(m) {
      if (typeof m !== "number" || !isFinite(m)) return "—";
      return m >= 1024 ? (m / 1024).toFixed(2) + " GB" : Math.round(m) + " MiB";
    }

    // ★ 数组兜底。宿主半已经用 arr() 兜过一层（PowerShell 的 ConvertTo-Json 会把单元素数组
    //   退化成对象），这里再兜一层是防「旧宿主半 / 半截响应」—— 前端拿对象去 .map 会直接炸。
    function asArr(x) {
      if (Array.isArray(x)) return x;
      return x === null || x === undefined ? [] : [x];
    }

    function StatusBar() {
      var st = react.useState(null);     // 状态数据
      var er = react.useState(null);     // 取状态失败
      var bu = react.useState(null);     // 正在跑的动作
      var op = react.useState(false);    // 展开 / 折叠（默认折叠，只占一行）
      var li = react.useState(false);    // 底模清单是否展开
      var nt = react.useState(null);     // 上一次动作的结果
      // ★ 组合模型清单是否展开。加在【最后】—— 前面 6 个的顺序不能动：
      //   selftest.mjs 的 stub 按 useState 出现顺序预置初值（那边也写着同一句提醒）。
      var bd = react.useState(false);

      var data = st[0], setData = st[1];
      var error = er[0], setError = er[1];
      var working = bu[0], setWorking = bu[1];
      var opened = op[0], setOpened = op[1];
      var listOpen = li[0], setListOpen = li[1];
      var msg = nt[0], setMsg = nt[1];
      var bundleOpen = bd[0], setBundleOpen = bd[1];

      react.useEffect(function () {
        var dead = false;
        function pull() {
          fetch(API + "/state", { cache: "no-store" })
            .then(function (r) { return r.json(); })
            .then(function (j) { if (!dead) { setData(j); setError(null); } })
            .catch(function (e) { if (!dead) setError(String((e && e.message) || e)); });
        }
        pull();
        var t = setInterval(pull, 8000);
        return function () { dead = true; clearInterval(t); };
      }, []);

      function refresh() {
        return fetch(API + "/state", { cache: "no-store" })
          .then(function (r) { return r.json(); })
          .then(function (j) { setData(j); setError(null); })
          .catch(function (e) { setError(String((e && e.message) || e)); });
      }

      function run(action) {
        if (working) return;
        setWorking(action);
        setMsg(null);
        fetch(API + "/action", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: action }),
        })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            if (action !== "status") {
              setMsg((j && j.ok ? "✓ " : "✗ ") + ((j && j.message) || action));
            }
            return refresh();
          })
          .catch(function (e) { setMsg("✗ " + String((e && e.message) || e)); })
          .then(function () { setWorking(null); });
      }

      function btn(label, action, hint) {
        var on = working === action;
        return h("button", {
          key: action,
          type: "button",
          disabled: !!working,
          // hint 是可选的补充说明，挂在 title 上不占版面（目前只有「静息」用）
          title: label + "（" + action + "）" + (hint ? " · " + hint : ""),
          style: working ? Object.assign({}, S.btn, { opacity: 0.5, cursor: "default" }) : S.btn,
          onClick: function () { run(action); },
        }, on ? "…" : label);
      }

      var phase = data ? (data.phase || "unknown") : (error ? "unknown" : "loading");
      var meta = PHASE[phase] || PHASE.unknown;
      var gpu = (data && data.gpu) || null;
      // ★ 底模（单文件）与组合模型（三件套）是两组东西：分开拿、分开渲染，不混成一列
      var ck = asArr(data && data.checkpoints);
      var bundles = asArr(data && data.bundles);
      var autoIdle = (data && data.autoIdle) || null;
      var apiUp = !!(data && data.comfyui && data.comfyui.apiUp);
      var vram = gpu ? fmtMiB(gpu.usedMiB) : "—";

      // ── 折叠态：一行，只报状态 + 显存 ──────────────────────
      if (!opened) {
        return h("div", { style: S.dock, "data-dsh-agent-model-statusbar": "1" },
          h("div", {
            style: S.pill,
            title: "本地模型（ComfyUI :8188）—— 点一下展开控制按钮",
            onClick: function () { setOpened(true); },
          },
            dot(meta.color, phase === "running"),
            h("span", { style: { fontWeight: 600 } }, "本地模型"),
            h("span", { style: { color: meta.color } }, meta.text),
            h("span", { style: S.dim }, vram),
            h("span", { style: { opacity: 0.55 } }, "▴")));
      }

      // ── 展开态 ────────────────────────────────────────────
      return h("div", { style: S.dock, "data-dsh-agent-model-statusbar": "1" },
        h("div", { style: S.card },
          h("div", { style: S.head },
            h("span", { style: S.title }, "本地模型"),
            h("span", { style: { display: "flex", alignItems: "center", gap: "5px", flex: "0 0 auto" } },
              dot(meta.color, phase === "running"),
              h("span", { style: { color: meta.color } }, meta.text),
              h("button", {
                type: "button", style: S.ghost, title: "收起", "data-sb-collapse": "1",
                onClick: function () { setOpened(false); },
              }, "▾"))),

          h("div", { style: S.line },
            h("span", { style: S.dim }, "ComfyUI :8188"),
            data
              ? (apiUp
                ? h("span", { style: { color: "#3ec46d" } }, "接口通")
                : h("span", { style: S.dim }, "接口断"))
              : h("span", { style: S.dim }, "…")),

          h("div", { style: S.line },
            h("span", { style: S.dim }, "显存"),
            h("span", null,
              gpu ? fmtMiB(gpu.usedMiB) + " / " + fmtMiB(gpu.totalMiB) : "—",
              gpu ? "  " + Math.round(gpu.utilPct) + "%" : "")),

          h("div", { style: S.row },
            btn("拉起", "start"),
            btn("静息", "idle", autoIdle && autoIdle.enabled
              ? "空闲 " + autoIdle.thresholdMinutes + " 分钟也会自动静息" : null),
            btn("关闭", "stop"),
            btn("刷新", "status"),
            // ★ 两个清单按钮互斥：点开一个就把另一个收起 —— 「分两组显示」不在版面上混起来
            ck.length
              ? h("button", {
                  key: "ck",
                  type: "button",
                  style: S.btn,
                  "data-sb-cklist": "1",
                  onClick: function () { setListOpen(!listOpen); setBundleOpen(false); },
                }, "底模 " + ck.length + (listOpen ? " ▴" : " ▾"))
              : null,
            bundles.length
              ? h("button", {
                  key: "bd",
                  type: "button",
                  style: S.btn,
                  "data-sb-bundlelist": "1",
                  onClick: function () { setBundleOpen(!bundleOpen); setListOpen(false); },
                }, "组合 " + bundles.length + (bundleOpen ? " ▴" : " ▾"))
              : null),

          listOpen && ck.length
            ? h("ul", { style: S.list },
                ck.map(function (c, i) {
                  return h("li", {
                    key: i,
                    style: { display: "flex", justifyContent: "space-between", gap: "8px", minWidth: 0 },
                  },
                    h("span", {
                      style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: 0.85 },
                      title: c.name,
                    }, c.name),
                    h("span", {
                      style: { opacity: 0.6, flex: "0 0 auto" },
                    }, (typeof c.gb === "number" ? c.gb.toFixed(2) : "?") + " GB"));
                }))
            : null,

          // ★ 组合模型（三件套）单独一组，和上面的单文件底模不混在一列。
          //   第一行＝名字 + 总大小（和底模同一版式）；第二行＝分项，鼠标停上去看完整文件名。
          bundleOpen && bundles.length
            ? h("ul", { style: S.list },
                bundles.map(function (b, i) {
                  var parts = asArr(b.parts);
                  return h("li", {
                    key: i,
                    style: { display: "flex", flexDirection: "column", gap: "1px", minWidth: 0 },
                  },
                    h("div", { style: { display: "flex", justifyContent: "space-between", gap: "8px", minWidth: 0 } },
                      h("span", {
                        style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: 0.85 },
                        title: b.name,
                      }, b.name),
                      h("span", {
                        style: { opacity: 0.6, flex: "0 0 auto" },
                      }, (typeof b.gb === "number" ? b.gb.toFixed(2) : "?") + " GB")),
                    parts.length
                      ? h("div", {
                          style: S.bparts,
                          title: parts.map(function (p) { return (p.part || "?") + "：" + p.name; }).join("\n"),
                        }, parts.map(function (p) {
                          return (p.part || "?") + " " + (typeof p.gb === "number" ? p.gb.toFixed(2) : "?");
                        }).join(" + "))
                      : null);
                }))
            : null,

          msg ? h("div", { style: S.note }, msg) : null,
          error ? h("div", { style: Object.assign({}, S.note, { color: "#e06c5a" }) }, "取状态失败：" + error) : null));
    }

    function apply(ctx) {
      // 每次 inject 各自 effect 一个独立 controller，不按 key 去重 —— 同一槽位再挂一个是安全的
      ctx.slots.inject("shell.overlay", function () {
        return ctx.slots.register(
          { name: "shell.overlay", id: "dsh-agent-model-statusbar", order: 45, label: "本地模型" },
          function () { return h(StatusBar); },
        );
      });
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});
