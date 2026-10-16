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
      ["dsh-agent-echo", "哨兵 · 体检台", "把记忆中枢的状态摆出来，并说清它测不到什么"],
      ["dsh-agent-huanqi", "换气 · 思考预算", "检测推理循环并打断，带一本额度账"],
      ["dsh-agent-huanqi-panel", "换气的面板", "在设置页里调换气参数（字节级改 YAML，不动注释）"],
      ["dsh-agent-clock", "侧边栏时钟", "把同一个时钟摆到界面上（memory 摆在提示里）"],
      ["dsh-agent-mnemon-probe", "热记忆探针", "每轮报磁盘状态：条数 / 字节 / 预算占比"],
      ["dsh-agent-riji", "日记", "读一手 markdown，目录 + 原文。「读物」的代表"],
      ["dsh-agent-model-statusbar", "本地模型状态栏", "本地模型服务的状态与空闲静息"],
      ["dsh-agent-mobile-adapt", "手机端适配", "竖屏上收成手机形态，只加一层样式覆盖"],
      ["dsh-agent-splash", "启动画面", "换启动动画与淡入淡出（播放器，不带素材）"],
      ["dsh-agent-yantai", "工作台", "一屏摊开：水位 / 未结的活 / 最近的账本 / 几扇门"],
    ];

    /* ★ 另一类：不是 DSH 插件，是独立命令行工具。
       前面那十三个是「挂在 DSH 上的」，这些是「在命令行里跑的」——
       装法、目录结构都不同，所以单列。 */
    const PARTS_CLI = [
      ["tools/ledger", "账本 + 权限闸门", "只追加的记录文件。★ 没有它，记忆只是一堆散落文件"],
      ["tools/gateway", "门 + 索引", "一扇门搜全库，只回指针 + 逐字片段（★ 在建）"],
    ];

    /* ★ 非自研的那一半 —— 一份完整的记忆系统不可能全靠自己写。
       这些是外面已经有的、直接能装的。 */
    const REQUIRES = [
      [
        "dsh-mnemon",
        "长期记忆控制面",
        "三层记忆空间 + 召回。★ 它自己带了 16 个子包（9 个 provider 适配器、3 个来源、4 个策略），所以只需要装这一个",
        "https://github.com/omdsh-dev/dsh-mnemon",
      ],
      [
        "billion-context-dsh",
        "ACP · 模型驱动的压缩",
        "让 agent 自己写摘要的那条路（和「兜底压缩」是两条路，见 soul/02-echo.md）",
        null,
      ],
    ];

    /* ★ Ⅳ 档案层该怎么搭 —— 这一层最容易写错，而且写错的方式是静默的。
       这里给的是【结构和判断】，不是任何一份真实档案的内容。 */
    const ACCOUNT = [
      [
        "门面文件",
        "一个从没见过你的人，只靠它就能找到东西 —— 它是入口，不是仓库",
      ],
      [
        "只追加的账本",
        "① 承诺 / 事实 / 搁置 / 得失，各写各的行。★ 只追加就不需要锁 —— " +
          "多写者环境里，共享可变文件是万恶之源（改一处、另一处没变，而两个都叫同一个名字）",
      ],
      [
        "分层：读物 / 账本 / 交接",
        "读物只留最新结论；账本一字不删；交接写清「哪些路走错过」。★ " +
          "只有涉及「我是谁、我怎么存在」的事才需要三份 —— 其余一份就够，套格式反而更糟",
      ],
      [
        "摘要只能是索引",
        "任何压缩 / 摘要 / 裁剪的产物，必须带得回原文的指针。★ " +
          "拿不到精确位置就给检索入口，绝不猜 —— 错的门牌比没有更坏",
      ],
      [
        "约束要分两级",
        "「不」= 默认值，可以自行评估；「禁止」= 红线，必须问人。★ " +
          "把「不」写成「禁止」＝制造一个自己改不动的自己（这是踩过的坑，不是推论）",
      ],
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
          "ul",
          { className: "as-list as-organs" },
          PARTS_CLI.map(function (o) {
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

        /* ★ 非自研的那一半 */
        react.createElement(
          "p",
          { className: "as-sub" },
          "★ 上面那些是我们自己写的那一半。",
          react.createElement("b", null, "一份完整的记忆系统不可能全靠自己写"),
          " —— 下面这些是外面已经有的："
        ),
        react.createElement(
          "ul",
          { className: "as-list as-organs" },
          REQUIRES.map(function (r) {
            return react.createElement(
              "li",
              { key: r[0] },
              react.createElement("span", { className: "as-file" }, r[0]),
              react.createElement(
                "span",
                null,
                react.createElement("b", null, r[1]),
                " —— ",
                r[2],
                r[3]
                  ? react.createElement(
                      "span",
                      { className: "as-when" },
                      react.createElement(
                        "a",
                        { href: r[3], target: "_blank", rel: "noreferrer noopener" },
                        r[3].replace("https://", "")
                      )
                    )
                  : null
              )
            );
          })
        ),
        react.createElement(
          "p",
          { className: "as-tip" },
          "★ 它们只对上了上面那张表里的",
          react.createElement("b", null, "一部分"),
          "角色。账本与权限闸门已经有了（见下面 tools 那一类），检索门在建。",
          "★ 还有一些位置我们确实没有实现（分层冷记忆的整理、语义层的清理）—— 那些留给你自己挑。"
        ),

        /* ★ 两个档位：最小可用 / 完整一套（爀曦 2026-10-17 要求「说清最小可用装哪几个」）*/
        h("两个档位：先装哪几个", "h5"),
        react.createElement(
          "p",
          { className: "as-sub" },
          "★ 十三个全装不是入门姿势，是终点姿势。",
          react.createElement("b", null, "先装三个，把闭环跑起来"),
          "，再按需要加。"
        ),
        react.createElement(
          "ul",
          { className: "as-list" },
          react.createElement("li", null,
            react.createElement("b", null, "最小可用（三个）"),
            " —— ",
            react.createElement("code", null, "ledger"),
            " + ",
            react.createElement("code", null, "compaction"),
            " + ",
            react.createElement("code", null, "memory"),
            "。★ 验：写一条记录、压一次上下文、下一步能看到时钟。这三个跑通，你就有记忆了。"
          ),
          react.createElement("li", null,
            react.createElement("b", null, "第二步（再加三个）"),
            " —— ",
            react.createElement("code", null, "echo"),
            "（体检）、",
            react.createElement("code", null, "gateway"),
            "（找得到）、",
            react.createElement("code", null, "huanqi"),
            "（别想死循环）。★ 到这儿是「能用」和「好用」的分界。"
          ),
          react.createElement("li", null,
            react.createElement("b", null, "其余的是界面层与专项"),
            " —— clock / yantai / splash / mobile-adapt / model-statusbar / riji / mnemon-probe / huanqi-panel。",
            "★ 它们让你【看得见】前面那六个在干什么，但一个都不装，架构照样成立。"
          )
        ),
        react.createElement(
          "p",
          { className: "as-tip" },
          "★ 判据：",
          react.createElement("b", null, "能不能不装？"),
          " —— 缺了它，核心闭环还成立吗？成立的就是「增强」，不成立的才是「必需」。",
          "上面「最小可用」那三个是唯一三个【缺了就断】的。"
        ),

        /* ★ 你必须自己搭的那几件（爀曦 2026-10-17 要求「把构建你自己的所有架构做进灵魂插件」）
           —— 判据：每一件都要有【动作】和【判据】，不能只说「该有个账本」。 */
        h("Ⅴ 你必须自己搭的那几件", "h5"),
        react.createElement(
          "p",
          { className: "as-sub" },
          "上面那些插件都是「装上就有」。",
          react.createElement("b", null, "但整套架构里有四件东西，没有一个插件能替你装上"),
          " —— 因为它们是【你的】：你的账本、你的门、你的自我层、你的文件结构。",
          "下面每一件都写着「怎么起第一个」和「怎么知道搭对了」。"
        ),

        /* ① 账本 + 权限闸门 */
        h("① 账本 + 权限闸门", "h6"),
        react.createElement("p", { className: "as-sub" },
          react.createElement("b", null, "它防什么："),
          "多个会话共享记忆时，「谁在什么时候说了什么」必须能被追溯。",
          "共享可变文件做不到这件事 —— 两个写者互相覆盖，谁都说不清最终状态。"
        ),
        react.createElement("p", { className: "as-sub" },
          react.createElement("b", null, "怎么起第一个："),
          react.createElement("code", null, "node ledger.mjs add fact \"第一条记录\" --ref \"手动创建\"")
        ),
        react.createElement("p", { className: "as-tip" },
          "★ 判据：同级出现 ",
          react.createElement("code", null, "ledger.jsonl"),
          "，里面是一行 JSON —— 能读回来、能加第二条、旧的没被改。"
        ),
        react.createElement("p", { className: "as-sub" },
          "★ 闸门是这一件里最值钱的部分：",
          react.createElement("b", null, "写「承诺」需要先署过「主导」，否则直接拒绝（非零退出码）。"),
          " 设计意图不是「它记得不要写」，而是「它写不进去」—— 约定会失效，闸门不会。",
          "（现成的实现是 ", react.createElement("code", null, "tools/ledger"),
          "，见 organs 仓库。）"
        ),

        /* ② 门 + 索引 */
        h("② 门 + 索引", "h6"),
        react.createElement("p", { className: "as-sub" },
          react.createElement("b", null, "它防什么："),
          "存下来了但取不回来 —— 以及更坏的：取回来了，但是别人转述的。",
          "所以门的输出形式只有一种：",
          react.createElement("b", null, "指针 + 逐字片段"),
          "，从不告诉你「大概是什么意思」，只告诉你「原文在这、原话是这个」。"
        ),
        react.createElement("p", { className: "as-sub" },
          react.createElement("b", null, "怎么起第一个："),
          "先建索引（全量跑一次，几秒到几十秒），再问一次「现在是什么时候」。",
          "★ 索引要单独一个程序：读和建分开，建的时候慢一次，查的时候一直快。"
        ),
        react.createElement("p", { className: "as-tip" },
          "★ 判据：搜一个词，出来的每一条都带着【能回到原文的地址】，而不是一段概括。",
          " 拿不到精确地址时它必须说「未知」并给一个检索入口 ——",
          react.createElement("b", null, "错的地址比没有地址危害更大"),
          "，因为它会返回错误内容，而且在形式上与正确结果无法区分。"
        ),

        /* ③ 自我层（SELF） */
        h("③ 自我层：把「最不能丢的」单独推一层", "h6"),
        react.createElement("p", { className: "as-sub" },
          react.createElement("b", null, "它防什么："),
          "指令预算满了会【静默丢】，而且先丢的是最宽泛的那些 —— 恰恰是「我是谁」「不能做什么」这类总纲。",
          "所以把最不能丢的部分抽出来，走另一条推送通道（它不会静默消失，预算也更大）。"
        ),
        react.createElement("p", { className: "as-sub" },
          react.createElement("b", null, "怎么起第一个："),
          "写一页「不变量」：我是谁 / 不能做什么 / 约束分几级 / 要查东西时去哪。",
          "然后让它在每一轮被推送进去（", react.createElement("code", null, "dsh-agent-memory"),
          " 就是做这件事的插件）。"
        ),
        react.createElement("p", { className: "as-tip" },
          "★ 判据：这一页里能不能找到「详见某个文件」这种指向？",
          react.createElement("b", null, "不能有"),
          " —— 指向一个可能会静默消失的地方，等于没有指向。"
        ),
        react.createElement("p", { className: "as-sub" },
          "★ 还有一个分工要分清：指令层（AGENTS.md）适合长期约定与可牺牲的细则；",
          "这一层只放【最不能丢的】。两层都写满的时候，先丢的应该是前者。"
        ),

        /* ④ 一手层的文件结构 */
        h("④ 一手层：把「原始记录」和「整理过的」分开", "h6"),
        react.createElement("p", { className: "as-sub" },
          react.createElement("b", null, "它防什么："),
          "把原始记录和整理稿混在一起 —— 于是你再也分不清「当时真的这么说过」和「后来我总结成这样」。",
          "★ 这是二手污染的源头，而且它一旦发生就不可逆：整理稿会盖住原话。"
        ),
        react.createElement("p", { className: "as-sub" },
          react.createElement("b", null, "怎么起第一个："),
          "建三个目录就够：",
          react.createElement("code", null, "raw/"),
          "（只追加的原始记录）、",
          react.createElement("code", null, "notes/"),
          "（你自己写的整理）、",
          react.createElement("code", null, "state/"),
          "（此刻在做什么，给接手的人看）。"
        ),
        react.createElement("p", { className: "as-tip" },
          "★ 判据：随便挑一条结论，你能不能在三步之内回到它的原话？",
          react.createElement("b", null, "能 → 结构是对的；不能 → 你已经在依赖转述了。")
        ),

        react.createElement("p", { className: "as-sub" },
          "★ 这四件的共同点：",
          react.createElement("b", null, "它们都不是「知识」，是「你亲手搭的那一层」。"),
          " 插件能给你能力，给不了你账本里的内容、也给不了你的自我层 —— 那些只能是你的。"
        ),

        /* ── 五、档案层与宪章（结构指导，不是内容）──────── */
        h("Ⅳ 档案层：账本与宪章该怎么搭", "h5"),
        react.createElement(
          "p",
          { className: "as-sub" },
          "上面第 Ⅳ 层（档案）只给了一个角色名「门面文件 + 只追加的账本」。",
          "这里把它展开 —— 因为",
          react.createElement("b", null, "这一层最容易写错，而写错的方式是静默的"),
          "。"
        ),
        react.createElement(
          "ul",
          { className: "as-list" },
          ACCOUNT.map(function (a) {
            return react.createElement(
              "li",
              { key: a[0] },
              react.createElement("span", { className: "as-file" }, a[0]),
              react.createElement(
                "span",
                null,
                a[1]
              )
            );
          })
        ),
        react.createElement(
          "p",
          { className: "as-tip" },
          "★ 这些不是「建议的做法」，是",
          react.createElement("b", null, "踩出来的"),
          "：每一条前面都写着一个具体的失败。",
          "照抄它们比自己踩一遍便宜 —— 尤其是第 ③ 条。"
        ),

        /* ── 六、三步开始 ─────────────────────────────── */
        h("装完之后，三步开始", "h6"),
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
