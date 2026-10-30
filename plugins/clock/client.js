/**
 * dsh-agent-clock — 浏览器半。
 *
 * 往 `sidebar.footer.action`（侧栏底部席位）注册一个紧凑按钮，
 * 点一下在旁边弹出当前时间面板；再点 / Esc / 点面板外收起。
 *
 * ── 三条实测约束（决定了这里的写法，都是踩过的坑）─────────────
 * ① `sidebar.footer.action` 的容器实测只有 **256×36 px**，塞不下 232 宽的面板，
 *    所以面板必须自己定位、挂在槽位之外。
 * ② ★ `position: fixed` 只在「祖先链上没有 transform / filter / backdrop-filter /
 *    contain / will-change」时才相对**视口**。侧栏那种毛玻璃容器极可能有
 *    backdrop-filter，于是 fixed 变成「相对那个 256×36 的小格子」——
 *    坐标算得再准也跑偏，面板直接跑到窗口外。
 *    所以面板**不渲染在 React 槽位子树里**，而是用原生 DOM 建好挂到 `document.body`：
 *    祖先链只剩 body，没有定位上下文能劫持它。这条不依赖 react-dom（宿主不一定给）。
 * ③ 尺寸不估算：面板先建成 visibility:hidden 挂上去，**量真实 offsetWidth/offsetHeight**
 *    再算位置，最后用 getBoundingClientRect 回读校准（这也顺手吃掉了任何残余偏移）。
 *    四边都夹在视口内 8px，CSS 再兜一层 max-width/max-height + overflow:auto。
 *
 * ★★ `exports.inject = ["slots"]` 必须写 —— 少了它整包静默失效：
 *    Host 照样报 client:{status:"running"}，侧栏计数照加，浏览器里一行代码不跑，
 *    控制台一个错都没有。这是这个插件体系最容易踩、且完全不报错的坑。
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
    var PANEL_ID = "dsh-agent-clock-panel";
    var REV = 5;          // ★ 版本戳：面板 DOM 上带 data-clock-rev="5"，用来确认浏览器跑的是哪一版
    var PANEL_W = 232;    // 与 CSS 的 width 同值；只在「往右还是往左展开」时作参考
    var GAP = 6;          // 按钮与面板的水平间距
    var MARGIN = 8;       // 面板与视口边缘的最小留白

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
      /* 挂 body 下的浮层：fixed 相对视口（body 无 transform 的前提下），四边留白由 JS 算 */
      ".dsh-agent-clock-panel{position:fixed;z-index:2147482000;box-sizing:border-box;",
      "width:232px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:auto;",
      "padding:12px 14px;border-radius:12px;border:1px solid rgba(128,128,128,.28);",
      "background:var(--dsw-alias-bg-layer-2,#fff);color:inherit;",
      "box-shadow:0 8px 26px rgba(0,0,0,.24);font-size:12px;line-height:1.5;}",
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

    /* ── 视口与定位 ─────────────────────────────────────────── */

    function viewport() {
      var de = document.documentElement;
      return {
        w: (de && de.clientWidth) || window.innerWidth || 0,
        h: (de && de.clientHeight) || window.innerHeight || 0,
      };
    }

    function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

    /**
     * 把面板摆到按钮旁边，并保证**整个面板**留在视口内。
     *
     * 方向：水平默认朝右展开（侧栏在左，往内容区走），放不下再朝左；
     *       垂直默认朝上展开（按钮压在底部），放不下再朝下。
     * 夹紧：四边各留 MARGIN，宽度/高度已由 CSS 的 max-* 限制，不会出现「夹不开」。
     * 校准：设完位置后回读真实矩形，按差值再修一次 —— 这样即使有残余的
     *       定位上下文偏移（body 被某个皮肤插件加了 transform 之类），结果依然正确。
     *
     * @returns {{left:number, top:number, width:number, height:number}|null}
     */
    function placeNear(trigger, panelEl) {
      if (!trigger || !panelEl || typeof trigger.getBoundingClientRect !== "function") return null;

      var vp = viewport();
      var r = trigger.getBoundingClientRect();
      var pw = panelEl.offsetWidth;
      var ph = panelEl.offsetHeight;
      if (!pw || !ph) return null;

      var left = r.right + GAP;                       // 朝右
      if (left + pw > vp.w - MARGIN) left = r.left - GAP - pw;   // 放不下 → 朝左

      /* 垂直：**底边与按钮底边对齐**。
         不写成「底边 = 按钮顶 - 间距」——那会把整块面板推到按钮上方浮着，
         按钮稍一离底，面板就看着「太偏上」。对齐底边 = 面板从按钮这一行往上长，
         和按钮是同一个视觉基线，贴着底栏。 */
      var top = r.bottom - ph;
      if (top < MARGIN) top = r.top - GAP - ph;       // 面板比上方空间还高 → 退到按钮上方
      if (top < MARGIN) top = MARGIN;                 // 仍然放不下 → 贴顶（CSS 有 max-height 兜滚动）

      left = clamp(left, MARGIN, Math.max(MARGIN, vp.w - pw - MARGIN));
      top = clamp(top, MARGIN, Math.max(MARGIN, vp.h - ph - MARGIN));

      /* 校准：left/top 是「目标视口坐标」，而 position 写进去的是「相对包含块」的值。
         两者只在 body 没有 transform 时才相等。这里按真实矩形反推该写的 style 值，
         迭代到收敛 —— 即使 body 被皮肤插件加了 transform，面板也照样贴合视口。 */
      var i, got, ex, ey;
      var sx = left, sy = top;
      for (i = 0; i < 3; i++) {
        panelEl.style.left = Math.round(sx) + "px";
        panelEl.style.top = Math.round(sy) + "px";
        got = panelEl.getBoundingClientRect();
        ex = left - got.left;          // 离目标的误差（屏幕坐标）
        ey = top - got.top;
        if (Math.abs(ex) < 0.5 && Math.abs(ey) < 0.5) break;
        sx += ex;
        sy += ey;
      }

      got = panelEl.getBoundingClientRect();          // 以真实矩形为准，再夹一次四边
      if (got.left < MARGIN) sx += MARGIN - got.left;
      if (got.top < MARGIN) sy += MARGIN - got.top;
      if (got.right > vp.w - MARGIN) sx -= got.right - (vp.w - MARGIN);
      if (got.bottom > vp.h - MARGIN) sy -= got.bottom - (vp.h - MARGIN);

      panelEl.style.left = Math.round(sx) + "px";
      panelEl.style.top = Math.round(sy) + "px";

      got = panelEl.getBoundingClientRect();
      return { left: Math.round(got.left), top: Math.round(got.top), width: gw(got), height: gh(got) };
    }

    function gw(rect) { return rect.width != null ? rect.width : (rect.right - rect.left); }
    function gh(rect) { return rect.height != null ? rect.height : (rect.bottom - rect.top); }

    /* ── 面板：原生 DOM，挂 document.body ───────────────────── */

    function buildPanel() {
      var el = document.createElement("div");
      el.className = "dsh-agent-clock-panel";
      el.id = PANEL_ID;
      el.setAttribute("role", "dialog");
      el.setAttribute("aria-label", "当前时间");
      el.setAttribute("data-clock-rev", String(REV));

      var timeEl = document.createElement("div");
      timeEl.className = "dsh-agent-clock-time";
      var dateEl = document.createElement("div");
      dateEl.className = "dsh-agent-clock-date";
      var footEl = document.createElement("div");
      footEl.className = "dsh-agent-clock-foot";
      var tzEl = document.createElement("span");
      var localEl = document.createElement("span");
      localEl.textContent = "本地时间";

      footEl.appendChild(tzEl);
      footEl.appendChild(localEl);
      el.appendChild(timeEl);
      el.appendChild(dateEl);
      el.appendChild(footEl);

      function paint(d) {
        timeEl.textContent = clockText(d);
        dateEl.textContent = dateText(d);
        tzEl.textContent = tzText(d);
      }
      paint(new Date());

      return { el: el, paint: paint };
    }

    function mountPanel(el) {
      var host = document.body || document.documentElement;
      host.appendChild(el);
      el.style.visibility = "hidden";   // 先量尺寸再显示，避免首帧闪一下
    }

    /* ── 组件：按钮留在槽位里，面板在 effect 里直接挂到 body ── */

    function ClockEntry() {
      var [open, setOpen] = react.useState(false);
      var btnRef = react.useRef(null);

      react.useEffect(function () {
        if (!open) return undefined;

        var trigger = btnRef.current || document.getElementById(BTN_ID);
        if (!trigger) { setOpen(false); return undefined; }

        var panel = buildPanel();
        mountPanel(panel.el);

        var rafId = 0;
        var last = { left: 0, top: 0, right: 0, bottom: 0, vw: 0, vh: 0, w: 0, h: 0 };

        function reposition() {
          if (!panel.el.parentNode) return;
          var t = btnRef.current || document.getElementById(BTN_ID);
          var vp = viewport();
          var r = t ? t.getBoundingClientRect() : null;
          if (r) {
            last.left = r.left; last.top = r.top; last.right = r.right; last.bottom = r.bottom;
          }
          last.vw = vp.w; last.vh = vp.h;
          last.w = panel.el.offsetWidth; last.h = panel.el.offsetHeight;
          placeNear(t, panel.el);
        }

        function schedule() {
          if (rafId) return;
          var raf = window.requestAnimationFrame || function (fn) { return setTimeout(fn, 16); };
          rafId = raf(function () { rafId = 0; reposition(); });
        }

        reposition();
        panel.el.style.visibility = "";

        /* 每秒走一格，同时做一次廉价的「漂移检测」：
           按钮动了 / 视口变了 / 面板自己的尺寸变了 → 重新贴边。
           这样侧栏折叠、窗口缩放、字体延迟加载都不会把面板留在错的位置。 */
        var timer = setInterval(function () {
          panel.paint(new Date());
          var t = btnRef.current || document.getElementById(BTN_ID);
          if (!t || !panel.el.parentNode) return;
          var r = t.getBoundingClientRect();
          var vp = viewport();
          var moved =
            Math.abs(r.left - last.left) > 0.5 ||
            Math.abs(r.top - last.top) > 0.5 ||
            Math.abs(r.right - last.right) > 0.5 ||
            Math.abs(r.bottom - last.bottom) > 0.5 ||
            vp.w !== last.vw ||
            vp.h !== last.vh ||
            Math.abs(panel.el.offsetWidth - last.w) > 0.5 ||
            Math.abs(panel.el.offsetHeight - last.h) > 0.5;
          if (moved) reposition();
        }, 1000);

        function onKey(e) {
          if (e.key === "Escape") setOpen(false);
        }
        function onDown(e) {
          var t = e.target;
          if (!t) return;
          if (panel.el === t || (panel.el.contains && panel.el.contains(t))) return;
          if (t.closest && (t.closest(".dsh-agent-clock-trigger") || t.closest("#" + BTN_ID))) return;
          setOpen(false);
        }

        document.addEventListener("keydown", onKey, true);
        document.addEventListener("mousedown", onDown, true);
        window.addEventListener("resize", schedule);
        document.addEventListener("scroll", schedule, true);

        return function () {
          clearInterval(timer);
          if (rafId) {
            var caf = window.cancelAnimationFrame || clearTimeout;
            caf(rafId);
            rafId = 0;
          }
          document.removeEventListener("keydown", onKey, true);
          document.removeEventListener("mousedown", onDown, true);
          window.removeEventListener("resize", schedule);
          document.removeEventListener("scroll", schedule, true);
          if (panel.el.parentNode) panel.el.parentNode.removeChild(panel.el);
        };
      }, [open]);

      return h("button", {
        ref: btnRef,
        id: BTN_ID,
        type: "button",
        className: "dsh-agent-clock-trigger",
        "data-open": open ? "1" : "0",
        "aria-expanded": open ? "true" : "false",
        title: "当前时间",
        "aria-label": "当前时间",
        onClick: function () { setOpen(function (v) { return !v; }); },
      }, h(ClockIcon));
    }

    function apply(ctx) {
      ensureStyle();
      ctx.slots.inject(SLOT, function () {
        ctx.slots.register(
          { name: SLOT, id: "clock", order: 60, label: "当前时间" },
          function () { return h(ClockEntry, null); }
        );
      });
    }

    exports.apply = apply;
    exports.inject = ["slots"];

    /* 测试钩子（不可枚举，宿主不会用到）：给 verify-position.mjs 直接验定位算法。 */
    Object.defineProperty(exports, "__test", {
      value: {
        placeNear: placeNear, viewport: viewport, clamp: clamp, buildPanel: buildPanel,
        PANEL_ID: PANEL_ID, REV: REV,
      },
      enumerable: false,
    });

    return module.exports;
  },
});
