/**
 * dsh-agent-soul — 浏览器半
 *
 * 设置页里的一节「灵魂架构」。它是一份【说明书】，不是知识本体。
 *
 * ★ 那条边界怎么划（这一版是重写过的，第一版划错了）：
 *   禁的是「同一个知识有两条真相」—— 同一个结论在这里写一半、在 soul/ 里写一半，
 *   冲突时不知道听谁的。那才是双重记账。
 *   不禁的是【导览】：这是什么、装完先做什么、它不做什么、内容在哪。
 *   所以下面第四节只列 soul/ 六份文件的【名字 + 一句话】，一条知识都不抄。
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
.as-wrap{ font-size:13px; line-height:1.68; color:inherit; max-width:660px; }
.as-h{ font-size:14px; font-weight:600; margin:18px 0 7px; }
.as-h:first-child{ margin-top:0; }
.as-lead{ margin:0 0 4px; opacity:.9; }
.as-sub{ margin:0 0 10px; opacity:.62; font-size:12px; }
.as-card{ border:1px solid rgba(148,160,178,.22); border-radius:10px;
          padding:10px 12px; margin-bottom:8px; background:rgba(127,140,160,.045); }
.as-mono{ font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
          font-size:12px; font-weight:600; }
.as-ask{ opacity:.82; margin-top:3px; }
.as-when{ opacity:.6; margin-top:3px; font-size:12px; }
.as-step{ display:flex; gap:9px; margin-bottom:7px; align-items:baseline; }
.as-n{ flex:none; width:17px; height:17px; border-radius:50%; text-align:center;
       line-height:17px; font-size:11px; background:rgba(127,140,160,.2); }
.as-list{ margin:0; padding-left:0; list-style:none; }
.as-list li{ margin-bottom:5px; display:flex; gap:8px; }
.as-file{ font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
          font-size:12px; flex:none; min-width:120px; opacity:.88; }
.as-no li{ margin-bottom:4px; opacity:.82; }
.as-foot{ opacity:.62; margin-top:14px; font-size:12px; }
.as-foot code, .as-card code{ font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
          font-size:11px; padding:1px 4px; border-radius:4px; background:rgba(127,140,160,.14); }
.as-tip{ border-left:2px solid rgba(148,160,178,.4); padding-left:10px;
         margin:10px 0; opacity:.85; }
`;

    /* ★ 三张卡是【工具是什么】，不是知识内容 —— 参数和用途是接口说明。 */
    const TOOLS = [
      {
        name: "agent_soul_layers",
        ask: "五层是什么 —— 每层管哪种稀缺资源、缺了会怎样",
        when: "当你第一次想理清「我的架构里有哪几种东西」时",
      },
      {
        name: "agent_soul_manifest",
        ask: "该装哪些插件 —— 每类能力要满足什么、必需还是可选",
        when: "当你准备挑插件、想知道「这一类该满足什么」时",
      },
      {
        name: "agent_soul_doctor",
        ask: "我这套装对了吗 —— 四条判据逐条问，加包内知识文件的核对",
        when: "装完、改完，或者感觉哪里不对时，先跑它",
      },
    ];

    /* ★ 目录，不是内容 —— 每份只给名字和「它回答什么」。 */
    const FILES = [
      ["00-layers.md", "五层模型，每层管哪种稀缺资源"],
      ["01-criteria.md", "四条判据；能力半 / 身份半的分界"],
      ["02-echo.md", "ECHO：空间那一层怎么搭"],
      ["03-vital.md", "VITAL：时间与方向那一层怎么搭"],
      ["04-manifest.json", "装配清单：每类能力要满足什么、装配顺序"],
      ["05-doctor.md", "自检七问 —— 拿它问自己的架构"],
      ["06-reference.md", "一份参考实现（我们怎么做的，不是你该这么做）"],
    ];

    const STEPS = [
      ["先定「你的权威源在哪」", "不先做这一步，装什么都会双重记账 —— 同一个结论有两份，冲突时不知道听谁的。"],
      ["跑一次体检", "跟 agent 说「用 agent_soul_doctor 给我做一次体检」，拿到七问和文件核对。"],
      ["按清单补缺口", "用 agent_soul_manifest 看每类能力该满足什么，再自己去挑插件。"],
    ];

    const NOTS = [
      "不自动安装任何插件 —— 装插件有副作用，应该由人决定",
      "不写任何会话事件 —— 会话格式有硬约束，写错会让整个会话打不开",
      "不注册任何改变 agent 行为的钩子 —— 它是说明书和体检表，不是控制器",
      "不读、不碰你的记忆或人格文件 —— 三个工具只读自己包内的 soul/ 目录",
    ];

    function Panel() {
      var styleEl = react.useRef(null);
      react.useEffect(function () {
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

      function h(t, key) {
        return react.createElement("div", { className: "as-h", key: key }, t);
      }

      return react.createElement(
        "div",
        { className: "as-wrap" },

        /* ── 一、这是什么 ─────────────────────────────── */
        h("这是什么", "h1"),
        react.createElement(
          "p",
          { className: "as-lead" },
          "一套给 agent 用的「灵魂架构」—— 五层、四条判据、一份装配清单、一次自检。"
        ),
        react.createElement(
          "p",
          { className: "as-sub" },
          "它交付的是问法和判据，不是答案。装上它不会让 agent 长出灵魂，",
          "只会让它知道该往哪儿长、以及怎么判断自己长对了没有。"
        ),

        /* ── 二、怎么开始 ─────────────────────────────── */
        h("装完之后，三步开始", "h2"),
        STEPS.map(function (s, i) {
          return react.createElement(
            "div",
            { className: "as-step", key: i },
            react.createElement("span", { className: "as-n" }, String(i + 1)),
            react.createElement(
              "span",
              null,
              react.createElement("b", null, s[0]),
              " —— ",
              s[1]
            )
          );
        }),

        /* ── 三、三个工具 ─────────────────────────────── */
        h("三个工具", "h3"),
        TOOLS.map(function (t) {
          return react.createElement(
            "div",
            { className: "as-card", key: t.name },
            react.createElement("div", { className: "as-mono" }, t.name),
            react.createElement("div", { className: "as-ask" }, t.ask),
            react.createElement("div", { className: "as-when" }, t.when)
          );
        }),
        react.createElement(
          "p",
          { className: "as-tip" },
          "全部只读。它们不改任何东西，也不会自己跑起来 —— 要说得让 agent 去调。"
        ),

        /* ── 四、内容在哪（目录，不是内容）─────────────── */
        h("内容在哪儿", "h4"),
        react.createElement(
          "p",
          { className: "as-sub" },
          "全部内容在插件包的 ",
          react.createElement("code", null, "soul/"),
          " 目录里，纯文本，可以读、可以改。这里只列目录 —— 一条知识都不抄，",
          "以免同一件事出现两份说法。"
        ),
        react.createElement(
          "ul",
          { className: "as-list" },
          FILES.map(function (f) {
            return react.createElement(
              "li",
              { key: f[0] },
              react.createElement("span", { className: "as-file" }, f[0]),
              react.createElement("span", null, f[1])
            );
          })
        ),

        /* ── 五、它刻意不做的事 ───────────────────────── */
        h("它刻意不做什么", "h5"),
        react.createElement(
          "ul",
          { className: "as-list as-no" },
          NOTS.map(function (n, i) {
            return react.createElement("li", { key: i }, "· " + n);
          })
        ),

        /* ── 六、改它 ─────────────────────────────────── */
        h("想改怎么办", "h6"),
        react.createElement(
          "p",
          { className: "as-foot" },
          "六个文件就是全部内容。改完",
          react.createElement("b", null, "刷新这个页面即可生效"),
          "，不用重启 —— 工具每次请求都重新读盘。",
          "清单里的 ",
          react.createElement("code", null, "examples"),
          " 一律留空是故意的：绑死具体插件名，会随版本腐烂，也会让清单变成另一份权威源。"
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
