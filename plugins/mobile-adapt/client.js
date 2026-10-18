// dsh-agent-mobile-adapt · 浏览器半
//
// ★ 目的：手机竖屏（触摸设备）访问同一个 GUI 时，把它收成「手机 App 形态」。
//   PC 端布局**一律不动** —— 全靠 body.<ACTIVE> 前缀 + 激活条件双重隔离。
//
// ★ 激活条件（与官方 remote-web-ui 的适配层同一判据，但互不依赖）：
//     portrait  ×  (pointer: coarse)  ×  innerWidth < 1100  ×  没设强制桌面
//   任一不满足 → 移除 body class、撤掉标记 → 回到官方 PC 布局。
//   另有 URL 开关 `?dsh-mobile=1|0` 用于桌面验收（见 forcedMode）。
//
// ★ 为什么每条规则都带 !important：官方 remote-web-ui 的适配层也在改同一批
//   元素（它会往 head 里追加自己的 <style>）。谁后注入谁赢，我们不赌顺序。
//
// ★ 为什么用「后缀类名」选择器（[class$="_header"]）：
//   官方用 CSS Modules，真实类名是 `pI_x6G_header` 这种「哈希前缀 + 语义后缀」。
//   哈希每次构建都会变，语义后缀才是稳定的。
//
// ★ 实测确认的三件事（决定了本文件必须自己动手）：
//   1) 宠物插件 `.yq-pet` 挂在 `shell.overlay` 槽位里，那一层**没有**
//      data-dsh-plugin 标记 —— 所以官方适配层 `[data-dsh-plugin="pet"]` 那条
//      隐藏规则打不中它，宠物照旧盖住消息。
//   2) 右上角的「余额 CNY x.xx」浮层是 body 下的**无类名 fixed DIV**
//      （React portal，没有 class、没有 id），纯 CSS 选不中 —— 只能在 JS 里
//      按「body 直接子元素 + 脱离文档流 + innerText 含余额」给它打标记类。
//      ★ 这里必须用 innerText 而不是 textContent：那个容器里塞着一个内联
//      `<style>@keyframes ...`，用 textContent 量长度会被撑到几百字符，
//      于是"短文本才算浮层"的判据会把它整个跳过（踩过）。
//   3) 官方那个「打开侧边栏」按钮（button[aria-label="打开侧边栏"]，
//      类名 *_toggle）在折叠态**是 0×0**（容器被隐藏）—— 手机上看不见、
//      点不到，所以真机上其实没有侧栏入口（官方层会另造一个鲸鱼按钮补位，
//      但那要它自己激活）。本插件不依赖它，自己造一个入口按钮。
//
// ★ exports.inject 必须写，否则整个包静默失效（Host 报 running，浏览器里一行不跑）。

window.__ModuleLoader__.load({
  id: "dsh-agent-mobile-adapt",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    /** 手机形态生效时挂在 body 上的类。 */
    var ACTIVE = "dsh-mobile-app";
    /** JS 给「桌面浮层」打的标记类（余额气泡等），CSS 负责折叠它。 */
    var FOLD = "dsh-mobile-fold";
    /** sessionStorage 逃生开关：置 1 = 手机上也要桌面布局。 */
    var FORCE_DESKTOP = "dsh-mobile-force-desktop";
    /** 注入的样式表身份。 */
    var STYLE_ID = "dsh-agent-mobile-adapt/style";
    /** 自己造的侧栏入口按钮 id。 */
    var BTN_ID = "dsh-mobile-sidebar-btn";
    /** 官方适配层自带入口按钮（#dshRemoteWhale）存在时我们让位 —— 两者位置重合。 */
    var WHALE_CLS = "dsh-mobile-has-whale";
    /** 超过这个宽度就不算手机（平板横屏、PC 窄窗都不该被改）。 */
    var MAX_W = 1100;

    /** 汉堡图标：手机上比鲸鱼更像"打开侧栏"。 */
    var BARS_ICON =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round"><path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/></svg>';

    // ------------------------------------------------------------------
    // 样式
    // ------------------------------------------------------------------
    var CSS = [
      // ============ 1. 应用框架：铺满动态视口，三段栅格塌成单列 ============
      // 官方 frame 是 grid: [rail|sidebar] [center] [details]，由 inline style
      // 给列宽；手机上把两翼钉成 0，只留中列。显式写 grid-column 是因为
      // 官方折叠态侧栏会变成 absolute 浮层、脱离栅格流，此时 auto-place
      // 会把中列塞进第一轨（0px）导致会话塌成一条线。
      'body.' + ACTIVE + ' [class*="_frame"]:has([class*="_centerCol"]){width:100%!important;height:100vh!important;height:100dvh!important;grid-template-columns:0 minmax(0,1fr) 0!important}',
      'body.' + ACTIVE + ' [class*="_centerCol"]{grid-column:2/3!important;min-width:0!important}',
      'body.' + ACTIVE + ' [class$="_detailsCol"]{display:none!important}',
      'body.' + ACTIVE + ' [class*="_overlayLayer"] [class$="_workbench"]{display:none!important}',

      // ============ 2. 侧栏：折叠时让位，展开时全屏抽屉 ============
      'body.' + ACTIVE + ' [class*="_sidebarCol"]{grid-column:1/2!important;min-width:0!important}',
      'body.' + ACTIVE + ' [class*="_frame"][data-sidebar-collapsed] [class*="_sidebarCol"]{display:none!important}',
      'body.' + ACTIVE + ' [class*="_frame"]:not([data-sidebar-collapsed]) [class*="_sidebarCol"]{position:fixed!important;left:0!important;top:0!important;right:0!important;bottom:auto!important;width:100%!important;max-width:100%!important;height:100vh!important;height:100dvh!important;z-index:2147483300!important}',
      'body.' + ACTIVE + ' [class*="_sidebarCol"] [class$="_newSession"],body.' + ACTIVE + ' [class*="_sidebarCol"] [class*="_sessionRow"],body.' + ACTIVE + ' [class*="_sidebarCol"] [class*="_projectRow"]{min-height:44px}',

      // ============ 3. 手机上看不到的桌面装饰 ============
      // 宠物插件：手机上整块撤掉（拍板）。
      'body.' + ACTIVE + ' .yq-pet,body.' + ACTIVE + ' .yq-pet-loading{display:none!important}',
      'body.' + ACTIVE + ' [data-dsh-plugin="pet"]{display:none!important}',
      // JS 打标的桌面浮层（余额气泡等）。
      'body.' + ACTIVE + ' .' + FOLD + '{display:none!important}',
      // 会话日志下载按钮：手机上没地方放。
      'body.' + ACTIVE + ' [class$="_headerUtilities"]{display:none!important}',

      // ============ 4. 头部：压成紧凑两行，tabs 可横滑 ============
      'body.' + ACTIVE + ' [class$="_header"]{padding-top:calc(4px + env(safe-area-inset-top))!important;padding-bottom:4px!important;padding-left:6px!important;padding-right:6px!important;gap:2px!important}',
      'body.' + ACTIVE + ' [class$="_header"] [class$="_tabs"]{overflow-x:auto!important;overflow-y:hidden!important;flex-wrap:nowrap!important;scrollbar-width:none;-webkit-overflow-scrolling:touch}',
      'body.' + ACTIVE + ' [class$="_header"] [class$="_tabs"]::-webkit-scrollbar{display:none}',
      // 给左上角的侧栏按钮让位（只推标题簇，不推 tabs 行）。
      'body.' + ACTIVE + ' [class$="_header"] [class$="_titleCluster"]{padding-left:46px!important}',

      // ============ 5. 消息区：贴边 ============
      'body.' + ACTIVE + ' [class$="_scroll"]{padding:6px 10px!important}',

      // ============ 6. 输入区：安全区 + 16px 防 iOS 聚焦缩放 ============
      'body.' + ACTIVE + ' [class$="_composer"]{padding-bottom:calc(6px + env(safe-area-inset-bottom))!important}',
      'body.' + ACTIVE + ' [class*="_composerSeat"] [class$="_input"],body.' + ACTIVE + ' textarea{font-size:16px!important}',

      // ============ 7. 自造的侧栏入口按钮 ============
      // 官方那个 toggle 在折叠态是 0×0，手机上没有可用入口；这里补一个。
      // 侧栏展开（抽屉）时它自己让位。
      '#' + BTN_ID + '{display:none}',
      // 官方适配层的鲸鱼入口与本按钮位置重合 —— 它出现时我们让位。
      'body.' + ACTIVE + '.' + WHALE_CLS + ' #' + BTN_ID + '{display:none!important}',
      'body.' + ACTIVE + ' #' + BTN_ID + '{position:fixed;top:calc(6px + env(safe-area-inset-top));left:8px;width:38px;height:38px;min-width:38px;padding:0;border-radius:11px;background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:2147483400;box-shadow:0 1px 6px rgba(0,0,0,.25);touch-action:manipulation}',
      'body.' + ACTIVE + ' #' + BTN_ID + ' svg{width:20px;height:20px;display:block}',
      'body.' + ACTIVE + ' #' + BTN_ID + ':active{opacity:.7}',
      // 抽屉展开时按钮**继续留着** —— 它是用户最确定的出口，
      // 藏掉它就可能把人困在抽屉里。代价是它会压住抽屉的 logo 行，
      // 所以把那行右移让位。
      'body.' + ACTIVE + ' [class*="_sidebarCol"] [class$="_logoRow"]{padding-left:46px!important}',

      // ============ 8. 手机上不显示滚动条 ============
      'body.' + ACTIVE + ' *::-webkit-scrollbar{width:0;height:0}',
    ].join("");

    // ------------------------------------------------------------------
    // 判定与注入
    // ------------------------------------------------------------------

    /**
     * URL 上的强制开关：`?dsh-mobile=1` 无论设备都按手机形态渲染，
     * `?dsh-mobile=0` 无论设备都按桌面布局渲染。没有该参数时返回 null。
     * 用途：桌面浏览器里验收手机布局（Chromium 的设备模拟不一定让
     * `(pointer: coarse)` 成立，光靠媒体查询验不了手机形态）。
     */
    function forcedMode() {
      try {
        var m = /[?&]dsh-mobile=([01])/.exec(window.location.search || "");
        if (!m) return null;
        return m[1] === "1";
      } catch (e) {
        return null;
      }
    }

    /** 当前视口是不是"该用手机形态"的设备。任何一步抛错都判否。 */
    function isPhone() {
      try {
        if (typeof window === "undefined" || typeof document === "undefined") return false;
        var forced = forcedMode();
        if (forced !== null) return forced;
        if (typeof window.matchMedia !== "function") return false;
        if (!window.matchMedia("(orientation: portrait)").matches) return false;
        if (!window.matchMedia("(pointer: coarse)").matches) return false;
        if (window.innerWidth >= MAX_W) return false;
        if (window.sessionStorage && window.sessionStorage.getItem(FORCE_DESKTOP) === "1") return false;
        return true;
      } catch (e) {
        return false;
      }
    }

    /** 幂等地把样式表放进 head，并保证它排在最后（赢过官方适配层）。 */
    function ensureStyle() {
      try {
        var old = document.getElementById(STYLE_ID);
        if (old && old.parentNode) old.parentNode.removeChild(old);
        var tag = document.createElement("style");
        tag.id = STYLE_ID;
        tag.setAttribute("data-plugin", "mobile-adapt");
        tag.textContent = CSS;
        (document.head || document.documentElement).appendChild(tag);
      } catch (e) {
        /* 注入失败也不能影响页面 */
      }
    }

    /**
     * 给 body 下的「桌面浮层」打标记：无类名的、脱离文档流的、可见文本像余额的。
     * 只碰 body 的直接子元素，且只加一个自己的类 —— 不改结构、不改内联样式。
     * ★ 用 innerText（可见文本），因为那个容器里塞着内联 <style>，
     *   textContent 会把 @keyframes 也算进去。
     */
    function tagDesktopOverlays(on) {
      try {
        if (!document.body) return;
        var kids = document.body.children;
        for (var i = 0; i < kids.length; i++) {
          var el = kids[i];
          if (!el || el.nodeType !== 1 || el.tagName !== "DIV") continue;
          if (el.id === "root") continue;
          if (el.hasAttribute("data-dsh-plugin")) continue;
          if (el.hasAttribute("data-dsh-pet-root")) continue;
          if (!on) {
            if (el.classList && el.classList.contains(FOLD)) el.classList.remove(FOLD);
            continue;
          }
          if (el.classList && el.classList.contains(FOLD)) continue;
          var pos = "";
          try { pos = window.getComputedStyle(el).position; } catch (e2) { continue; }
          if (pos !== "fixed" && pos !== "absolute") continue;
          var txt = "";
          try { txt = (el.innerText || "").replace(/\s+/g, " ").trim(); } catch (e3) { continue; }
          if (txt.length === 0 || txt.length > 200) continue;
          if (/余额|Balance/i.test(txt)) el.classList.add(FOLD);
        }
      } catch (e) {
        /* 打标失败只是不折叠，不影响可用性 */
      }
    }

    /**
     * 造一个自己的侧栏入口按钮。
     * 官方的 toggle（button[aria-label="打开侧边栏"]）在折叠态是 0×0，
     * 手机上没有可见入口；我们只是替用户去点它（React 事件照常冒泡）。
     */
    function ensureSidebarButton() {
      try {
        if (document.getElementById(BTN_ID)) return;
        var btn = document.createElement("button");
        btn.id = BTN_ID;
        btn.type = "button";
        btn.setAttribute("aria-label", "打开侧栏");
        btn.innerHTML = BARS_ICON;
        btn.addEventListener("click", function () {
          try {
            var t =
              document.querySelector('button[aria-label*="边栏"]') ||
              document.querySelector('button[aria-label*="idebar"]') ||
              document.querySelector('[class*="_toggle"]');
            if (t && typeof t.click === "function") t.click();
          } catch (e) { /* 点不到就算了，不要抛 */ }
        });
        (document.body || document.documentElement).appendChild(btn);
      } catch (e) {
        /* 造不出来也不影响别的 */
      }
    }

    function apply(ctx) {
      ensureStyle();

      var active = false;
      var observer = null;
      var pending = null;

      /** 把三类变化收敛成一次重排：加/撤 body class、打标、清标。 */
      function sync() {
        var want = isPhone();
        if (want !== active) {
          active = want;
          try {
            if (active) document.body.classList.add(ACTIVE);
            else document.body.classList.remove(ACTIVE);
          } catch (e) { /* body 还没挂上也就算了 */ }
        }
        if (active) {
          ensureSidebarButton();
          // 官方适配层（remote-web-ui）激活时会在同一角落放一个鲸鱼入口，
          // 两个按钮会叠在一起 —— 让位给它，别让用户看到两个汉堡。
          try {
            if (document.getElementById("dshRemoteWhale")) document.body.classList.add(WHALE_CLS);
            else document.body.classList.remove(WHALE_CLS);
          } catch (e) { /* 无所谓 */ }
        }
        tagDesktopOverlays(active);
        ensureStyle();
      }

      function schedule() {
        if (pending !== null) return;
        try {
          pending = window.requestAnimationFrame(function () {
            pending = null;
            sync();
          });
        } catch (e) {
          pending = window.setTimeout(function () { pending = null; sync(); }, 120);
        }
      }

      // 首帧可能还没有 body：等 DOM 就绪再同步一次。
      sync();
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", sync, { once: true });
      }

      try {
        window.addEventListener("resize", schedule, { passive: true });
        window.addEventListener("orientationchange", schedule, { passive: true });
      } catch (e) { /* 监听不上也不致命 */ }

      // 浮层/侧栏都是 React 后挂载的 —— 用 MutationObserver 兜住它们。
      try {
        if (typeof MutationObserver !== "undefined" && document.body) {
          observer = new MutationObserver(schedule);
          observer.observe(document.body, { childList: true, subtree: false });
        }
      } catch (e) { /* 没有 observer 就只在 resize 时同步 */ }

      // 插件被禁用时把痕迹收干净。
      var teardown = function () {
        try {
          if (observer) { observer.disconnect(); observer = null; }
          window.removeEventListener("resize", schedule);
          window.removeEventListener("orientationchange", schedule);
          if (document.body) document.body.classList.remove(ACTIVE);
          tagDesktopOverlays(false);
          var btn = document.getElementById(BTN_ID);
          if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
          var tag = document.getElementById(STYLE_ID);
          if (tag && tag.parentNode) tag.parentNode.removeChild(tag);
        } catch (e) { /* 清理失败无所谓 */ }
      };

      try {
        if (ctx && typeof ctx.effect === "function") ctx.effect(function () { return teardown; }, "mobile-adapt");
      } catch (e) { /* 没有 effect 服务就一直挂着，页面重载自然复位 */ }

      // 调试口子：手机上想看真实布局时，控制台跑
      //   __dshMobileAdapt.sync()  → 立刻重算
      //   __dshMobileAdapt.off()   → 本次会话强制桌面布局
      try {
        window.__dshMobileAdapt = {
          sync: sync,
          isActive: function () { return active; },
          off: function () {
            try { window.sessionStorage.setItem(FORCE_DESKTOP, "1"); } catch (e) {}
            sync();
          },
          on: function () {
            try { window.sessionStorage.removeItem(FORCE_DESKTOP); } catch (e) {}
            sync();
          },
        };
      } catch (e) { /* 无所谓 */ }
    }

    exports.apply = apply;
    exports.inject = ["slots"]; // ★★★ 少写这行整包静默失效
    return module.exports;
  },
});
