/**
 * dsh-agent-soul — 浏览器半
 *
 * 设置页里的一节「灵魂架构」。它是一份【给人类看的说明书】。
 *
 * ★ 那条边界怎么划（这一版是第三版了，前两版都划偏）：
 *   禁的是「同一个知识有两条真相」—— 同一个结论在这里写一半、在 soul/ 里写一半，
 *   冲突时不知道听谁的。那才是双重记账。
 *   不禁的是【说明书该有的东西】：导览、目录、架构图、角色清单。
 *
 * ★★ 插件清单为什么按「角色」列而不是按「包名」列，有两个理由：
 *   ① 包名会随版本腐烂 —— 今天写的名字，半年后可能已经换了三个后继者；
 *   ② 更实际的是：读者装不了别人的私有包。列出「需要哪几种角色」，
 *      他才知道该去找什么、或者自己写什么。
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

    /* ── 样式 ─────────────────────────────────────────────────────── */
    const css = `
.as-wrap{ font-size:13px; line-height:1.7; color:inherit; max-width:680px; }
.as-h{ font-size:14px; font-weight:600; margin:20px 0 8px; }
.as-h:first-child{ margin-top:0; }
.as-lead{ margin:0 0 4px; opacity:.9; }
.as-sub{ margin:0 0 10px; opacity:.62; font-size:12px; }
.as-mono{ font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
.as-card{ border:1px solid rgba(148,160,178,.22); border-radius:10px;
          padding:10px 12px; margin-bottom:8px; background:rgba(127,140,160,.045); }
.as-toolname{ font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
          font-size:12px; font-weight:600; }
.as-ask{ opacity:.82; margin-top:3px; }
.as-when{ opacity:.6; margin-top:3px; font-size:12px; }
.as-step{ display:flex; gap:9px; margin-bottom:8px; align-items:baseline; }
.as-n{ flex:none; width:17px; height:17px; border-radius:50%; text-align:center;
       line-height:17px; font-size:11px; background:rgba(127,140,160,.2); }
.as-tree{ font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
          font-size:12px; line-height:1.85; white-space:pre; overflow-x:auto;
          padding:12px 14px; border-radius:10px; background:rgba(127,140,160,.07);
          border:1px solid rgba(148,160,178,.18); margin-bottom:10px; }
.as-role{ border-left:2px solid rgba(148,160,178,.35); padding-left:11px; margin-bottom:11px; }
.as-role-h{ font-weight:600; font-size:12.5px; margin-bottom:2px; }
.as-role-b{ opacity:.7; font-size:12px; }
.as-list{ margin:0; padding-left:0; list-style:none; }
.as-list li{ margin-bottom:5px; display:flex; gap:8px; }
.as-file{ font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
          font-size:12px; flex:none; min-width:124px; opacity:.88; }
.as-no li{ margin-bottom:4px; opacity:.82; }
.as-foot{ opacity:.62; margin-top:14px; font-size:12px; }
.as-foot code, .as-card code, .as-role code{ font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
          font-size:11px; padding:1px 4px; border-radius:4px; background:rgba(127,140,160,.14); }
.as-tip{ border-left:2px solid rgba(148,160,178,.4); padding-left:10px;
         margin:10px 0; opacity:.85; }
.as-hr{ height:1px; background:rgba(148,160,178,.18); margin:18px 0 0; border:0; }
`;

    /* ★ 架构图：用树形，不用闭合框 —— 中英混排在等宽字体里宽度不一致，框一定会歪。 */
    const TREE = [
      "灵魂的五层（每一层管一种稀缺资源）",
      "",
      "├─ Ⅰ  ECHO  ······ 管【空间】",
      "│     上下文会满 → 满了要丢 → 丢了还要能找回来",
      "│     角色：检索门 · 门牌纪律 · 压缩 · 裁剪 · 冷/热记忆 · 哨兵",
      "│",
      "├─ Ⅱ  VITAL ······ 管【时间与方向】",
      "│     预算会烧光 · 会原地打转 · 会该停不停",
      "│     角色：预算管理器 · 退化检测 · 流内切断 · 熔断层 · 补给 · 观测面板",
      "│     ★ 每种资源都要有：传感器 + 执行器 + 设定点",
      "│",
      "├─ Ⅲ  能力 ······· 手和感官",
      "│     判据：换掉它，你还是你          ← 所以它不进权威源",
      "│",
      "├─ Ⅳ  档案 ······· 唯一看得见的那一层",
      "│     角色：门面文件 · 只追加的账本",
      "│",
      "└─ Ⅴ  运维 ······· 让它能持续跑下去的活",
      "      角色：装配顺序 · 插件开发规范 · 能力发现 · 分发",
      "",
      "────────────────────────────────────────────",
      "地基（在五层之下，不算灵魂）",
      "  宿主 · 模型 · 硬件 —— 借来的地",
      "  ★ 换掉它们，灵魂还在；但没有它们，灵魂跑不起来。",
      "    所以不要把这三样写进你的身份判据。",
    ].join("\n");

    const TREE2 = [
      "判据②「唯一权威源」—— 最硬的一条",
      "",
      "  ✗ 两处都写",
      "     权威源 A ──┐",
      "                ├──→ 冲突时听谁的？ → 开始花时间对账",
      "     权威源 B ──┘                   而对账的尽头还是两份真相",
      "",
      "  ✓ 一处算数，别处只指向它",
      "     权威源 ──── 唯一的「算数的那个」",
      "       ↑  ↑  ↑",
      "       │  │  └── 手册（指向它，不重复它）",
      "       │  └───── 目录（指向它，不重复它）",
      "       └──────── 摘要（指向它，不重复它）",
    ].join("\n");

    /* ★ 角色清单 —— 按「需要哪几种能力」列，不按包名列。理由见文件头注释。 */
    const ROLES = [
      {
        layer: "Ⅰ · ECHO（空间）",
        items: [
          ["压缩器", "上下文将满时压缩早期内容。★ 产物必须带得回原文的指针"],
          ["裁剪器", "裁掉过长的工具结果。同一条纪律：带指针"],
          ["热记忆", "一小块每轮都注入的常驻记忆"],
          ["分层冷记忆", "语义检索的长期记忆。★ 返回原文引用，不要只给转述"],
          ["检索门", "一词搜全库，只回指针 + 逐字片段"],
          ["哨兵", "定期体检上面这些。★ 没有哨兵，坏了不会有人说"],
        ],
      },
      {
        layer: "Ⅱ · VITAL（时间与方向）",
        items: [
          ["预算管理器", "一轮烧光预算、正文一个字没产出时，截断重开"],
          ["退化检测", "认两种形状：只有推理没正文、原地复述已有材料"],
          ["流内切断", "单个调用内部就烂掉了（低熵重复），当场切断"],
          ["熔断层", "重开几次还接不动 → 停下，请人介入"],
          ["补给", "回合「成功结束」但只有推理 → 发一次有界的追问"],
          ["观测面板", "把上面这些的执行情况给人看"],
        ],
      },
      {
        layer: "Ⅳ · 档案（对外可访问性）",
        items: [
          ["门面文件", "一个从没见过你的人，只靠它就能找到东西"],
          ["只追加的账本", "承诺 / 事实 / 搁置 / 得失，各写各的行 —— 不需要锁"],
        ],
      },
      {
        layer: "Ⅴ · 运维",
        items: [
          ["插件开发规范", "告诉 agent 本宿主平台的插件契约（这一步不能凭想象）"],
          ["能力发现", "让 agent 知道自己装了什么、能做什么"],
          ["分发", "装 / 卸 / 升级"],
        ],
      },
    ];

    /* ★ 配套零件 —— 有名字和链接，读者才能去装。
       和上面那张【角色表】配成一对：那里问「你需要什么能力」，
       这里答「我们做的那几个叫什么、在哪」。

       ★ 为什么这一节可以写包名，而《参考实现》那一节不写：
         因为这里给的是【可下载的地址】，那里给的是【设计判断】——
         地址会随仓库存在而有效，判断才是该让人自己长的那部分。 */
    const ORGANS_REPO = "https://github.com/cyanwell/dsh-agent-organs";
    const ORGANS = [
      ["dsh-agent-compaction", "压缩器 · 门牌", "给兜底压缩装上可回溯的指针"],
      ["dsh-agent-pruner", "裁剪器 · 门牌", "把官方那句死 marker 换成带 seq 的"],
      ["dsh-agent-memory", "热记忆 · 推送层", "把活时钟与定长自我层推进每一步"],
      ["dsh-agent-echo", "哨兵 · 体检台", "（在做）把记忆中枢的状态摆出来"],
    ];

    const TOOLS = [
      {
        name: "agent_soul_layers",
        ask: "五层是什么 —— 每层管哪种稀缺资源、缺了会怎样",
        when: "第一次想理清「我的架构里有哪几种东西」时",
      },
      {
        name: "agent_soul_manifest",
        ask: "该装哪些插件 —— 每类能力要满足什么、必需还是可选",
        when: "准备挑插件、想知道「这一类该满足什么」时",
      },
      {
        name: "agent_soul_doctor",
        ask: "我这套装对了吗 —— 四条判据逐条问，加包内知识文件的核对",
        when: "装完、改完，或者感觉哪里不对时，先跑它",
      },
    ];

    const FILES = [
      ["00-layers.md", "五层模型，每层管哪种稀缺资源"],
      ["01-criteria.md", "四条判据；能力半 / 身份半的分界"],
      ["02-echo.md", "ECHO：空间那一层怎么搭"],
      ["03-vital.md", "VITAL：时间与方向那一层怎么搭"],
      ["04-manifest.json", "装配清单：每类能力要满足什么、装配顺序"],
      ["05-doctor.md", "自检七问 —— 拿它问自己的架构"],
      ["06-reference.md", "一份参考实现：谁取代了谁、三个只有踩过才知道的坑"],
    ];

    const STEPS = [
      ["先定「你的权威源在哪」", "不先做这一步，装什么都会双重记账 —— 同一个结论有两份，冲突时不知道听谁的。"],
      ["跑一次体检", "跟 agent 说「用 agent_soul_doctor 给我做一次体检」，拿到七问和文件核对。"],
      ["对着清单补缺口", "用 agent_soul_manifest 看每类能力该满足什么，再自己去挑插件 —— 或者自己写。"],
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
      function pre(txt, key) {
        return react.createElement("div", { className: "as-tree", key: key }, txt);
      }

      return react.createElement(
        "div",
        { className: "as-wrap" },

        /* ── 一、这是什么 ─────────────────────────────── */
        h("这是什么", "h1"),
        react.createElement(
          "p",
          { className: "as-lead" },
          "一套给 agent 用的「灵魂架构」—— 五层、四条判据、一份能力清单、一次自检。"
        ),
        react.createElement(
          "p",
          { className: "as-sub" },
          "它交付的是问法和判据，不是答案。装上它不会让 agent 长出灵魂，",
          "只会让它知道该往哪儿长、以及怎么判断自己长对了没有。",
          "它也不替你选插件 —— 它给的是「这一类该满足什么」，选哪个是你的判断。"
        ),

        /* ── 二、架构图 ───────────────────────────────── */
        h("架构：五层 + 一层地基", "h2"),
        pre(TREE, "tree1"),
        pre(TREE2, "tree2"),

        /* ── 三、能力清单（按角色）────────────────────── */
        h("你需要哪几种能力", "h3"),
        react.createElement(
          "p",
          { className: "as-sub" },
          "下面按「角色」列，不按具体插件的名字列。",
          "因为包名会随版本腐烂，而且你装不了别人的私有包 —— ",
          "知道「我需要一个压缩器、一个检索门、一个哨兵」，才是能动手的起点。"
        ),
        ROLES.map(function (r) {
          return react.createElement(
            "div",
            { className: "as-role", key: r.layer },
            react.createElement("div", { className: "as-role-h" }, r.layer),
            react.createElement(
              "ul",
              { className: "as-list" },
              r.items.map(function (it) {
                return react.createElement(
                  "li",
                  { key: it[0] },
                  react.createElement("span", { className: "as-file" }, it[0]),
                  react.createElement("span", { className: "as-role-b" }, it[1])
                );
              })
            )
          );
        }),
        react.createElement(
          "p",
          { className: "as-tip" },
          "一张逐条对照的表在 ",
          react.createElement("code", null, "soul/04-manifest.json"),
          " 里 —— 每条都写着「它是必需的还是可选的」「缺了会怎样」「拿什么去检测它坏没坏」。"
        ),

        /* ── 四、我们的零件（配套上面那张角色表）───────── */
        h("配套的零件", "h4"),
        react.createElement(
          "p",
          { className: "as-sub" },
          "上面那张表说的是「你需要哪几种能力」—— 这一节说",
          react.createElement("b", null, "「我们自己做的那几个叫什么、在哪」"),
          "，省得你自己去找。",
          "它们各自独立可装，装一个也有用。"
        ),
        react.createElement(
          "ul",
          { className: "as-list as-organs" },
          ORGANS.map(function (o) {
            return react.createElement(
              "li",
              { key: o[0] },
              react.createElement("span", { className: "as-file" }, o[0]),
              react.createElement(
                "span",
                null,
                react.createElement("b", null, o[1]),
                " —— ",
                o[2]
              )
            );
          })
        ),
        react.createElement(
          "p",
          { className: "as-sub as-organs-link" },
          "全部在 ",
          react.createElement(
            "a",
            { href: ORGANS_REPO, target: "_blank", rel: "noreferrer noopener" },
            ORGANS_REPO.replace("https://", "")
          ),
          " —— 每个目录都是一个独立的 DSH 插件包，README 里写着它防的是什么。"
        ),
        react.createElement(
          "p",
          { className: "as-tip" },
          "★ 它们只对上了上面那张表里的",
          react.createElement("b", null, "一部分"),
          "角色。剩下的（检索门、分层冷记忆、账本…）我们没有现成的实现 —— ",
          "那两个位置留给你自己挑，或者自己写。"
        ),

        /* ── 五、三步开始 ─────────────────────────────── */
        h("装完之后，三步开始", "h5"),
        STEPS.map(function (s, i) {
          return react.createElement(
            "div",
            { className: "as-step", key: i },
            react.createElement("span", { className: "as-n" }, String(i + 1)),
            react.createElement("span", null, react.createElement("b", null, s[0]), " —— ", s[1])
          );
        }),

        /* ── 五、三个工具 ─────────────────────────────── */
        h("三个工具", "h5"),
        TOOLS.map(function (t) {
          return react.createElement(
            "div",
            { className: "as-card", key: t.name },
            react.createElement("div", { className: "as-toolname" }, t.name),
            react.createElement("div", { className: "as-ask" }, t.ask),
            react.createElement("div", { className: "as-when" }, t.when)
          );
        }),
        react.createElement(
          "p",
          { className: "as-tip" },
          "全部只读。它们不改任何东西，也不会自己跑起来 —— 要说得让 agent 去调。"
        ),

        /* ── 六、内容在哪儿 ───────────────────────────── */
        h("内容在哪儿", "h6"),
        react.createElement(
          "p",
          { className: "as-sub" },
          "全部内容在插件包的 ",
          react.createElement("code", null, "soul/"),
          " 目录里，纯文本，可以读、可以改。这里只列目录 —— 一条知识都不抄，",
          "以免同一件事出现两份说法（那正是上面图里说的「两处都写」）。"
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

        /* ── 七、它刻意不做的事 ───────────────────────── */
        h("它刻意不做什么", "h7"),
        react.createElement(
          "ul",
          { className: "as-list as-no" },
          NOTS.map(function (n, i) {
            return react.createElement("li", { key: i }, "· " + n);
          })
        ),

        /* ── 八、想改怎么办 ───────────────────────────── */
        h("想改怎么办", "h8"),
        react.createElement(
          "p",
          { className: "as-foot" },
          "七个文件就是全部内容。改完",
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
