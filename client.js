/**
 * dsh-agent-soul — 浏览器半
 *
 * 一个设置页区块（settings.section），告诉人「这个插件装上了、能做什么」。
 *
 * ★ 这一版【只放静态引导】，不渲染 soul/ 里的任何内容。
 *   理由：面板要显示五层/判据/清单的话，就得读 soul/ 目录 ——
 *   要么给宿主半加只读 HTTP 路由，要么在浏览器半里再写一份内容。
 *   ★ 后者就是「两处都写」，直接违反本插件自己标为最硬的判据②（唯一权威源）。
 *   所以：**内容永远只有一份，在 soul/ 里；这一版只放"去哪问"。**
 *
 * ★★ 末尾那句 `exports.inject = ["slots"]` 不能少。
 *   少了会怎样：Host 报 running、控制台零报错、侧边栏计数照加，
 *   而页面上什么都没有 —— 最安静的一种失败。
 */
window.__ModuleLoader__.load({
  id: "dsh-agent-soul",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");

    /* ── 样式（只用局部类名；颜色继承主题，不硬编码主题色）──────────── */
    const css = `
.as-wrap{ font-size:13px; line-height:1.6; color:inherit; max-width:620px; }
.as-lead{ opacity:.85; margin:0 0 12px; }
.as-tool{ border:1px solid rgba(148,160,178,.22); border-radius:10px;
          padding:10px 12px; margin-bottom:8px; background:rgba(127,140,160,.045); }
.as-name{ font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
          font-size:12px; font-weight:600; }
.as-ask{ opacity:.8; margin-top:3px; }
.as-foot{ opacity:.7; margin-top:12px; font-size:12px; }
.as-foot code{ font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
               font-size:11px; padding:1px 4px; border-radius:4px;
               background:rgba(127,140,160,.14); }
`;

    /* ★ 三个工具是【字面说明】，不是 soul/ 的内容 —— 这里没有知识，只有入口。 */
    const TOOLS = [
      {
        name: "agent_soul_layers",
        ask: "五层是什么 —— 每层管哪种稀缺资源、缺了会怎样",
      },
      {
        name: "agent_soul_manifest",
        ask: "该装哪些插件 —— 每类能力要满足什么、必需还是可选",
      },
      {
        name: "agent_soul_doctor",
        ask: "我这套装对了吗 —— 四条判据逐条问，加包内知识文件的核对",
      },
    ];

    function Panel() {
      var styleEl = react.useRef(null);
      react.useEffect(function () {
        // 样式只注入一次；组件卸载时收回
        if (styleEl.current) return;
        var el = document.createElement("style");
        el.textContent = css;
        document.head.appendChild(el);
        styleEl.current = el;
        return function () {
          if (el.parentNode) el.parentNode.removeChild(el);
          styleEl.current = null;
        };
      }, []);

      return react.createElement(
        "div",
        { className: "as-wrap" },
        react.createElement(
          "p",
          { className: "as-lead" },
          "这一层装的是「一个 agent 该怎么搭自己的灵魂」——",
          "交付的是问法、判据和自检，不是答案。"
        ),
        TOOLS.map(function (t) {
          return react.createElement(
            "div",
            { className: "as-tool", key: t.name },
            react.createElement("div", { className: "as-name" }, t.name),
            react.createElement("div", { className: "as-ask" }, t.ask)
          );
        }),
        react.createElement(
          "p",
          { className: "as-foot" },
          "跟你的 agent 说一句「用 ",
          react.createElement("code", null, "agent_soul_doctor"),
          " 给我做一次体检」就能开始。",
          "全部内容在插件包的 ",
          react.createElement("code", null, "soul/"),
          " 目录里，纯文本，可以读、可以改。"
        )
      );
    }

    function apply(ctx) {
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register(
          {
            name: "settings.section",
            id: "agent-soul",
            order: 40,
            label: "灵魂架构",
          },
          function () {
            return react.createElement(Panel);
          }
        );
      });
    }

    exports.apply = apply;
    exports.inject = ["slots"]; // ★★★ 少这一行 = 整包彻底静默
    return module.exports;
  },
});
