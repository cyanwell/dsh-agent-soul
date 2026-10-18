/**
 * dsh-agent-clock — 浏览器半。
 *
 * 往 `sidebar.footer.action`（侧栏底部席位）注册一个紧凑按钮，
 * 点一下在旁边弹出一个显示当前时间的面板；再点 / Esc / 点面板外收起。
 *
 * ── 两个实测约束（决定了这里的写法）────────────────────────────
 * ① `sidebar.footer.action` 的容器实测只有 **256×36 px**（`footerActions`），
 *    侧边栏底部已经压着几个按钮（各有自己的 order）和设置/更新触发器。
 *    ⇒ 按钮必须紧凑（36×36 圆形），面板**不能**塞进槽位，要挂在槽位外面自己定位。
 *    ⇒ 本插件按钮 order = 60，排在它们之后。
 * ② 面板用 `position: fixed` + 由按钮的 getBoundingClientRect 现算坐标，
 *    这样不依赖父容器的 overflow / 定位上下文，也不会被窄槽位裁掉。
 *
 * ★★ `exports.inject = ["slots"]` 必须写 —— 少了它整包静默失效：
 *    Host 照样报 client:{status:"running"}，侧栏计数照加，浏览器里一行代码不跑，
 *    控制台一个错都没有。这是这个插件体系最容易踩、且完全不报错的坑。
 *    （写 `ctx.get('slots')` 再判空 return 是被明确拒绝的写法：宁可让它抛，也别让它静默。）
 */
window.__ModuleLoader__.load({
  id: "dsh-agent-clock",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");          // 真包有完整 React（useRef / useState / useEffect 都在）
    var h = react.createElement;

    var SLOT = "sidebar.footer.action";
    var BTN_ID = "dsh-agent-clock-btn";
    var PANEL_W = 232;
    var PANEL_H = 140;   // 估算值，只用于「往上弹还是往下弹」的判断
    var GAP = 8;

    var WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

    function pad2(n) { return n < 10 ? "0" + n : String(n); }

    function clockText(d) {
      return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
    }

    function dateText(d) {
      return d.getFullYear() + " 年 " + (d.getMonth() + 1) + " 月 " + d.getDate() + " 日 · 星期" + WEEKDAYS[d.getDay()];
    }

    /** 时区标签：UTC 偏移，例如 UTC+08:00 —— 由具体时区换算，不写死。 */
    function tzText(d) {
      var offMin = -d.getTimezoneOffset();
      var sign = offMin < 0 ? "-" : "+";
      var abs = Math.abs(offMin);
      return "UTC" + sign + pad2(Math.floor(abs / 60)) + ":" + pad2(abs % 60);
    }

    /* ── 样式：中性灰描边 + inherit 文字色，浅色 / 深色主题都不用改 ── */
    var CSS = [
      ".dsh-agent-clock-trigger{width:36px;height:36px;flex:none;display:inline-flex;align-items:center;justify-content:center;",
      "padding:0;background:transparent;border:none;border-radius:50%;cursor:pointer;color:inherit;",
      "transition:background-color .12s,color .12s;}",
      ".dsh-agent-clock-trigger:hover{background:rgba(127,140,160,.16);}",
      ".dsh-agent-clock-trigger[data-open='1']{background:rgba(127,140,160,.22);}",
      ".dsh-agent-clock-panel{position:fixed;z-index:300;box-sizing:border-box;width:232px;padding:12px 14px;",
      "border-radius:12px;border:1px solid rgba(128,128,128,.28);background:var(--dsw-alias-bg-layer-2,#fff);",
      "color:inherit;box-shadow:0 8px 26px rgba(0,0,0,.24);font-size:12px;line-height:1.5;}",
      ".dsh-agent-clock-time{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:26px;",
      "font-weight:600;letter-spacing:1px;font-variant-numeric:tabular-nums;line-height:1.2;}",
      ".dsh-agent-clock-date{margin-top:4px;font-size:12px;opacity:.8;}",
      ".dsh-agent-clock-foot{margin-top:9px;padding-top:8px;border-top:1px solid rgba(128,128,128,.2);",
      "display:flex;justify-content:space-between;gap:8px;font-size:11px;opacity:.62;}",
    ].join("");

    function ensureStyle() {
      if (document.getElementById("dsh-agent-clock-style")) return;
      var tag = document.createElement("style");
      tag.id = "dsh-agent-clock-style";
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    function ClockIcon() {
      return h("svg", {
        width: 18, height: 18, viewBox: "0 0 24 24", fill: "none",
        stroke: "currentColor", strokeWidth: 1.8,
        strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true",
      },
        h("circle", { cx: 12, cy: 12, r: 9 }),
        h("path", { d: "M12 7.5v4.8l3.2 2" }));
    }

    /** 面板本体：打开期间每秒刷新一次。 */
    function ClockPanel() {
      var [now, setNow] = react.useState(function () { return new Date(); });

      react.useEffect(function () {
        var tick = function () { setNow(new Date()); };
        tick();                                    // 打开即刻对齐，不等下一秒
        var id = setInterval(tick, 1000);
        return function () { clearInterval(id); };
      }, []);

      return h("div", { className: "dsh-agent-clock-panel", role: "dialog", "aria-label": "当前时间" },
        h("div", { className: "dsh-agent-clock-time" }, clockText(now)),
        h("div", { className: "dsh-agent-clock-date" }, dateText(now)),
        h("div", { className: "dsh-agent-clock-foot" },
          h("span", null, tzText(now)),
          h("span", null, "本地时间")));
    }

    /**
     * 触发器 + 面板。
     * @param props slot 给的 props —— 尽量拿它给的触发元素算坐标（尽量用，但不假设）。
     */
    function ClockEntry(props) {
      var [open, setOpen] = react.useState(false);
      var [pos, setPos] = react.useState(null);

      // 坐标：优先用 slot props 里给的触发元素，退化到按 id / 选择器自找。
      react.useEffect(function () {
        if (!open) return;

        var trigger =
          (props && (props.trigger || props.triggerRef || props.anchor)) ||
          document.getElementById(BTN_ID) ||
          document.querySelector("[data-slot='" + SLOT + "'] .dsh-agent-clock-trigger");

        if (!trigger || typeof trigger.getBoundingClientRect !== "function") return;

        var r = trigger.getBoundingClientRect();
        var left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - PANEL_W - 8));
        var top = r.top - GAP - PANEL_H;
        if (top < 12) top = Math.min(r.bottom + GAP, window.innerHeight - PANEL_H - 12);
        setPos({ left: Math.round(left), top: Math.round(Math.max(12, top)) });
      }, [open, props]);

      // 打开期间：Esc 收起、点面板外收起、窗口尺寸变化重算坐标。
      react.useEffect(function () {
        if (!open) return;

        var onKey = function (e) { if (e.key === "Escape") setOpen(false); };
        var onDown = function (e) {
          var t = e.target;
          if (!t || !t.closest) return;
          if (t.closest(".dsh-agent-clock-panel") || t.closest(".dsh-agent-clock-trigger")) return;
          setOpen(false);
        };
        var onResize = function () { setPos(null); };

        document.addEventListener("keydown", onKey, true);
        document.addEventListener("mousedown", onDown, true);
        window.addEventListener("resize", onResize);
        return function () {
          document.removeEventListener("keydown", onKey, true);
          document.removeEventListener("mousedown", onDown, true);
          window.removeEventListener("resize", onResize);
        };
      }, [open]);

      // setPos(null) 之后补算一次（窗口尺寸变了的情况）
      react.useEffect(function () {
        if (!open || pos !== null) return;
        var trigger = document.getElementById(BTN_ID);
        if (!trigger) return;
        var r = trigger.getBoundingClientRect();
        var left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - PANEL_W - 8));
        var top = r.top - GAP - PANEL_H;
        if (top < 12) top = Math.min(r.bottom + GAP, window.innerHeight - PANEL_H - 12);
        setPos({ left: Math.round(left), top: Math.round(Math.max(12, top)) });
      }, [open, pos]);

      var panelStyle = pos
        ? { left: pos.left + "px", top: pos.top + "px" }
        : { left: "-9999px", top: "-9999px" };   // 首帧先量再显示，避免闪一下

      return h(react.Fragment, null,
        h("button", {
          id: BTN_ID,
          type: "button",
          className: "dsh-agent-clock-trigger",
          "data-open": open ? "1" : "0",
          title: "当前时间",
          "aria-label": "当前时间",
          onClick: function () { setOpen(function (v) { return !v; }); },
        }, h(ClockIcon)),
        open ? h("div", { style: panelStyle }, h(ClockPanel)) : null);
    }

    function apply(ctx) {
      ensureStyle();
      ctx.slots.inject(SLOT, function () {
        ctx.slots.register(
          { name: SLOT, id: "clock", order: 60, label: "当前时间" },
          function (slotProps) { return h(ClockEntry, slotProps || {}); }
        );
      });
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});
