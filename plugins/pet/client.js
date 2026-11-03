// dsh-yanqing-pet · 浏览器半
//
// ★★ 这只宠物要"随砚青的工作状态变化" ★★
//   状态探测走**防御式多信号**，不押注任何一个内部 API —— 因为改了客户端半必须重启
//   一次才生效，试错太贵。探测顺序：
//     1) 有审批类对话框（role=dialog/alertdialog 且文本含"批准/允许/授权"）→ waiting
//     2) 有"停止/Stop/取消生成"按钮，或输入框 disabled/readOnly    → working
//     3) 否则                                                        → idle
//   任何一步抛错都退回 idle，绝不让宠物把页面搞崩。
//
// ★ 2026-09-24 改版（素材从内嵌 base64 改成 HTTP 路由 + 逐帧动画）：
//   · 素材走 /yanqing-pet/faces/*.webp 与 /yanqing-pet/frames/*.webp
//     —— 50 张图内嵌会让 client.js 到 2 MB，而它是每次页面加载都要解析的启动期资源
//   · 启动时拉一次 /yanqing-pet/manifest.json，拿到表情清单和每个动作的帧数，
//     所以加素材只要往 assets/ 丢文件，不用改这个 JS
//   · 动作改成**逐帧序列**：CSS 只能整体旋转缩放（刚体），
//     帧序列才能做"上半身摆得比下半身大、头发滞后"这种分层形变
//
// ★ 眼睛坐标基准是【整幅原图】：左眼 48.0%/34.5% 10%x5%，右眼 76.5%/34.5% 11%x5%
//   （抠图时不能裁 bbox —— 一裁百分比全错位）
//
// ★ exports.inject 必须写，否则整个包静默失效（Host 报 running，浏览器里一行不跑）
window.__ModuleLoader__.load({
  id: "dsh-yanqing-pet",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");

    // ★ 2026-09-29：`/yanqing-pet` → `/yanqing-pet-v3`。
    //   换素材时【前缀必须动】—— 文件名不变 ⇒ URL 不变 ⇒ 浏览器拿 24 小时缓存里的旧图，
    //   服务端明明换好了、界面上还是旧的，而且硬刷新也不好使。改前缀 = 全部地址翻新，
    //   浏览器没得选，必须重新取。（同一次改动里也把 index.js 的响应头改成了 no-store。）
    //   ★ 以后再换素材：动这里 + index.js 的 PREFIX，编号往上加（v3、v4…）。
    var API = "/yanqing-pet-v3";

    // 工作状态 → 用哪个动作序列、哪张脸
    // ★ 动作序列名 = assets/frames/<name>-NN.webp 的前缀
    var STATE = {
      idle:    { seq: "idle",    face: "open",      fps: 6.2 },
      working: { seq: "working", face: "serious",   fps: 7.5 },
      waiting: { seq: "waiting", face: "open",      fps: 6.6 },
      done:    { seq: "done",    face: "happy",     fps: 9.0, once: true },
      failed:  { seq: "idle",    face: "tired",     fps: 5.0 },
      poke:    { seq: "poke",    face: "surprised", fps: 10.0, once: true },
    };

    // 闲着没事时会偶尔换一下脸，让它不像一张定格图
    var IDLE_FACES = ["smile", "thinking", "wry", "laugh"];
    var IDLE_SWAP_MS = [9000, 17000];

    // 长时间闲着：先困，再睡着
    var IDLE_TIRED_MS = 4 * 60 * 1000;
    var IDLE_SLEEP_MS = 9 * 60 * 1000;

    var EYES = [
      { left: 48.0, top: 34.5, w: 10.0, h: 5.0 },
      { left: 76.5, top: 34.5, w: 11.0, h: 5.0 },
    ];

    // ---------- 状态探测 ----------
    function textOf(node) {
      try { return (node && node.textContent) || ""; } catch (e) { return ""; }
    }

    function detect() {
      try {
        var i, t;
        var dialogs = document.querySelectorAll('[role="dialog"],[role="alertdialog"]');
        for (i = 0; i < dialogs.length; i++) {
          t = textOf(dialogs[i]);
          if (/批准|允许|授权|approve/i.test(t)) return "waiting";
        }
        var btns = document.querySelectorAll("button");
        for (i = 0; i < btns.length; i++) {
          t = textOf(btns[i]) + " " + (btns[i].getAttribute("aria-label") || "");
          if (/停止|中断|取消生成|stop/i.test(t)) return "working";
        }
        var areas = document.querySelectorAll("textarea,[contenteditable='true']");
        for (i = 0; i < areas.length; i++) {
          if (areas[i].disabled === true || areas[i].readOnly === true) return "working";
        }
        return "idle";
      } catch (e) {
        return "idle";
      }
    }

    // ---------- 样式 ----------
    // ★ 动作已经烘进帧里了，所以 CSS 只剩【外壳】效果：
    //   悬停抬升、点击回弹、气泡、装饰符号。再叠大的变换会和帧里的动作打架。
    var CSS = [
      // ★ 2026-10-04 爀曦要的：大一些 + 能拖着走。宽度 170 → 240；
      //   touch-action:none 是触屏上能持续收到 pointermove 的前提（否则浏览器会当成滚动）。
      ".yq-pet{position:fixed;right:26px;bottom:20px;width:240px;z-index:40;",
      "pointer-events:auto;cursor:pointer;user-select:none;-webkit-user-select:none;",
      "touch-action:none;",
      "filter:drop-shadow(0 6px 14px rgba(0,0,0,.35));transition:transform .25s ease;}",
      ".yq-pet:hover{transform:translateY(-4px);}",
      // 拖动中：关掉悬停抬升和过渡 —— 否则 getBoundingClientRect 会跟着 transform 抖
      ".yq-pet--dragging{transform:none!important;transition:none!important;cursor:grabbing;}",
      // ★ 换图方式改成分层叠加（2026-09-24）：所有表情/动画帧一次性挂成绝对定位的
      //   兄弟层，切换只改 opacity —— 全程不换任何 <img> 的 src。
      //   原先是单个 <img> 换 src：浏览器在取到并解码新图之前那一帧是空的，
      //   于是每次切表情都闪一下。眨眼每 1.3~2.1 秒一次，所以就一直在闪。
      //   body 用 aspect-ratio 撑高度（原来靠 img 的自然尺寸撑），所有图同为 340×496。
      ".yq-pet-body{position:relative;width:100%;aspect-ratio:340 / 496;transform-origin:50% 92%;}",
      ".yq-pet-layer{position:absolute;left:0;top:0;width:100%;height:100%;display:block;",
      "pointer-events:none;opacity:0;}",
      ".yq-pet-layer.on{opacity:1;}",
      ".yq-pet-eyes{position:absolute;inset:0;pointer-events:none;}",
      ".yq-pet-lid{position:absolute;border-radius:50%;",
      "background:linear-gradient(180deg,#f7d9cc 0%,#e9bda9 100%);",
      "transform:translate(-50%,-50%);opacity:.96;}",

      ".yq-pet-blush{position:absolute;top:35%;width:13%;height:7%;border-radius:50%;",
      "background:radial-gradient(circle,rgba(255,140,150,.55) 0%,rgba(255,140,150,0) 70%);",
      "opacity:0;transition:opacity .3s ease;pointer-events:none;}",
      ".yq-pet-blush-l{left:30%;}",
      ".yq-pet-blush-r{left:66%;}",

      ".yq-pet-bubble{position:absolute;top:-6px;left:50%;transform:translate(-50%,-100%);",
      "background:#1e2334;color:#e6e9f2;border:1px solid #2a2f42;border-radius:12px;",
      "padding:4px 10px;font-size:12px;line-height:1.3;white-space:nowrap;",
      "opacity:0;transition:opacity .25s ease;pointer-events:none;",
      "font-family:'Microsoft YaHei',sans-serif;}",
      ".yq-pet-bubble:after{content:'';position:absolute;left:50%;bottom:-5px;",
      "margin-left:-4px;width:8px;height:8px;background:#1e2334;",
      "border-right:1px solid #2a2f42;border-bottom:1px solid #2a2f42;",
      "transform:rotate(45deg);}",
      ".yq-pet--working .yq-pet-bubble,",
      ".yq-pet--waiting .yq-pet-bubble,",
      ".yq-pet--done .yq-pet-bubble{opacity:1;}",

      ".yq-pet-mark{position:absolute;font-size:15px;opacity:0;",
      "transition:opacity .3s ease;pointer-events:none;line-height:1;}",
      ".yq-pet-mark-sweat{right:2%;top:16%;}",
      ".yq-pet-mark-star{left:4%;top:12%;font-size:13px;}",
      ".yq-pet--working .yq-pet-mark-sweat{opacity:.85;animation:yq-drip 1.4s ease-in-out infinite;}",
      ".yq-pet--done .yq-pet-mark-star{opacity:1;animation:yq-twinkle .9s ease-in-out infinite;}",
      ".yq-pet--waiting .yq-pet-mark-star{opacity:.9;animation:yq-twinkle 1.1s ease-in-out infinite;}",

      ".yq-pet--done .yq-pet-blush{opacity:1;}",
      ".yq-pet--failed .yq-pet-mark-sweat{opacity:.9;}",
      ".yq-pet--poke .yq-pet-blush{opacity:1;}",
      ".yq-pet--asleep .yq-pet-mark-star{left:20%;top:8%;font-size:16px;opacity:.95;animation:yq-twinkle 3.2s ease-in-out infinite;}",
      ".yq-pet--asleep .yq-pet-blush{opacity:.7;}",

      // ★ 素材没加载出来时的兜底：用 CSS 让静态图仍然在呼吸
      ".yq-pet--noframe .yq-pet-body{animation:yq-breathe 4.2s ease-in-out infinite;}",
      ".yq-pet--noframe .yq-pet-layer.on{animation:yq-sway 6.4s ease-in-out infinite;}",

      ".yq-pet-loading{position:fixed;right:26px;bottom:20px;color:#7c8399;font-size:12px;}",

      "@keyframes yq-breathe{0%,100%{transform:scale(1,1);}50%{transform:scale(1.012,1.024);}}",
      "@keyframes yq-sway{0%,100%{transform:rotate(-1deg);}50%{transform:rotate(1deg);}}",
      "@keyframes yq-drip{0%,100%{transform:translateY(0);opacity:.5;}50%{transform:translateY(3px);opacity:.95;}}",
      "@keyframes yq-twinkle{0%,100%{transform:scale(1) rotate(0);opacity:.6;}50%{transform:scale(1.25) rotate(12deg);opacity:1;}}",
    ].join("");

    var BUBBLE = {
      idle: "",
      working: "…",
      waiting: "在等你",
      done: "好了",
      failed: "唔",
      poke: "",
    };

    function PetView() {
      var st = react.useState("idle");
      var state = st[0], setState = st[1];

      // 素材：faces 是名字集合，frames 是 动作名 → URL 数组
      var as = react.useState(null);
      var assets = as[0], setAssets = as[1];

      // ★ 2026-10-05 姿势层（爀曦要的「拖着拖着就坐下了」）：
      //   当前姿势名 —— "stand" 就是原来那张站着的立绘，其余是 assets.poses 里的键
      //   （sit / squat / lie / lean / corner / stretch）。
      //   值由 bindDrag 在【松手那一刻】按她停在屏幕的哪个位置算出来，再回写到这里。
      //   bindDrag 不在渲染闭包里、拿不到 setPose，所以顺手挂到 window 上给它用
      //   （和 window.__yqPetEl 同一招；页面上只有一个宠物，安全）。
      var ps = react.useState("stand");
      var pose = ps[0], setPose = ps[1];
      if (typeof window !== "undefined") window.__yqSetPose = setPose;

      var fi = react.useState(0);
      var frameIdx = fi[0], setFrameIdx = fi[1];

      var ov = react.useState(null);          // 覆盖动作（done / poke 这类一次性的）
      var override = ov[0], setOverride = ov[1];

      var fc = react.useState("open");
      var face = fc[0], setFace = fc[1];

      var bl = react.useState(false);
      var isBlink = bl[0], setBlink = bl[1];

      var prev = react.useRef ? react.useRef("idle") : { current: "idle" };

      // ---- 拉清单（一次就够）----
      react.useEffect(function () {
        var alive = true;
        window.fetch(API + "/manifest.json", { cache: "no-store" })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) {
            if (!alive || !j || !j.ok) return;
            var faceSet = {};
            (j.faces || []).forEach(function (n) { faceSet[n] = j.faceBase + n + ".webp"; });
            setAssets({ faces: faceSet, frames: j.frames || {}, poses: j.poses || {} });
          })
          .catch(function () { /* 拿不到清单就退回静态图 */ });
        return function () { alive = false; };
      }, []);

      // ---- 状态轮询 ----
      react.useEffect(function () {
        setState(detect());
        var iv = window.setInterval(function () { setState(detect()); }, 900);
        return function () { window.clearInterval(iv); };
      }, []);

      // ---- working → idle：放一次 done ----
      var dk = react.useState(0);
      var doneKey = dk[0], setDoneKey = dk[1];
      react.useEffect(function () {
        if (prev.current === "working" && state === "idle") {
          setOverride("done");
          setDoneKey(function (n) { return n + 1; });
          window.setTimeout(function () { setOverride(null); }, 900);
        }
        prev.current = state;
      }, [state]);

      var eff = override ? override : state;

      // ---- 当前用哪个动作序列 / 多快 ----
      var cfg = STATE[eff] || STATE.idle;
      var seq = (assets && assets.frames && assets.frames[cfg.seq]) || null;

      // ---- 帧推进 ----
      react.useEffect(function () {
        if (!seq || seq.length < 2) return;
        setFrameIdx(0);
        var iv = window.setInterval(function () {
          setFrameIdx(function (n) { return n + 1; });
        }, Math.round(1000 / cfg.fps));
        return function () { window.clearInterval(iv); };
      }, [seq, cfg.fps, doneKey]);

      // once 型动作：N 圈之后回到常态
      react.useEffect(function () {
        if (!cfg.once || !override) return;
        var ms = Math.round((1000 / cfg.fps) * ((seq && seq.length) || 6));
        var t = window.setTimeout(function () { setOverride(null); }, ms);
        return function () { window.clearTimeout(t); };
      }, [override, cfg, seq]);

      // ---- 选脸 ----
      react.useEffect(function () {
        if (!assets) { setFace(cfg.face); return; }
        if (override === "poke") { setFace("surprised"); return; }
        setFace(cfg.face);
      }, [cfg.face, override, assets]);

      // 闲着没事偶尔换个脸
      var ir = react.useState(null);
      var idleFace = ir[0], setIdleFace = ir[1];
      react.useEffect(function () {
        if (eff !== "idle") { setIdleFace(null); return; }
        var t;
        function tick() {
          var lo = IDLE_SWAP_MS[0], hi = IDLE_SWAP_MS[1];
          t = window.setTimeout(function () {
            setIdleFace(IDLE_FACES[Math.floor(Math.random() * IDLE_FACES.length)]);
            window.setTimeout(function () { setIdleFace(null); }, 2600);
            tick();
          }, lo + Math.random() * (hi - lo));
        }
        tick();
        return function () { window.clearTimeout(t); };
      }, [eff]);

      // ---- 困 / 睡着 ----
      var la = react.useState(Date.now());
      var lastActive = la[0], setLastActive = la[1];
      react.useEffect(function () {
        if (state !== "idle") setLastActive(Date.now());
      }, [state]);
      var sl = react.useState("awake");
      var sleep = sl[0], setSleep = sl[1];
      react.useEffect(function () {
        var iv = window.setInterval(function () {
          var idleMs = Date.now() - lastActive;
          setSleep(state === "idle" && idleMs > IDLE_SLEEP_MS ? "asleep"
            : (state === "idle" && idleMs > IDLE_TIRED_MS ? "tired" : "awake"));
        }, 20000);
        return function () { window.clearInterval(iv); };
      }, [state, lastActive]);

      // ---- 真眨眼：换成 blink 那张脸，而不是拿色块盖眼睛 ----
      //   frames 里没有眨眼帧，但 blink 是同一画布的独立差分，切过去不会跳。
      react.useEffect(function () {
        if (!assets || !assets.faces.blink) return;
        var fast = state === "working";
        var iv = window.setInterval(function () {
          if (Math.random() < (fast ? 0.5 : 0.35)) {
            setBlink(true);
            window.setTimeout(function () { setBlink(false); }, 150);
          }
        }, fast ? 1300 : 2100);
        return function () { window.clearInterval(iv); };
      }, [state, assets]);

      // ---- 拖动 + 滚轮缩放（2026-10-04 爀曦要的：大一些、能移动）----
      // ★ 位置和大小都不进 React state：拖动时每帧 setState 会把整棵子树（几十张 <img>）
      //   重新渲染一遍。这里直接改 DOM 的 style，只在松手/滚轮结束时写一次 localStorage。
      // ★ 依赖写 [!!src] 而不是 []：素材没加载完时组件提前 return（没有 DOM 可绑），
      //   等 src 出现后需要再跑一次。写成 [] 的话那次永远不会执行。
      // ★ 这里【不能】用 react.useRef —— `react` 是宿主 require 进来的，不保证实现了 useRef。
      //   2026-10-04 实测：用了之后整个宠物不渲染（组件抛错，页面上什么都没有）。
      //   useEffect 是本来就在用的（眨眼那一段），一定有。宠物在页面上只有一个，直接查即可。
      // ★★ 2026-10-04：这段绑定【不能】放在 useEffect 里。
      //   用桌面端自己的 CDP 口（9222）验出来的事实链：
      //     · 包在 __DSH_BOOT__.entries 里 ✓
      //     · 元素渲染了，位置和样式全对 ✓
      //     · 临时往元素上加监听、打一发合成 pointerdown —— 收得到 ✓（事件系统正常）
      //     · 帧动画那个 effect 在跑（图层每几百毫秒换一张）✓（useEffect 本身正常）
      //     · 但元素上【没有】我的监听器，localStorage 从没被写过 ✗
      //   ⇒ 这个 effect 里的 addEventListener 从没执行到。
      //   而回调 ref 是【已验证会执行】的（window.__yqPetEl 一直有值），
      //   所以把绑定挂在 ref 上：节点一到手就绑，不依赖 effect 的任何时机。
      function bindDrag(el) {
        if (!el || el.__yqDragBound) return;   // 幂等：重复渲染不会重复绑
        el.__yqDragBound = 1;

        var KEY = "yq-pet-box";
        var MINW = 120, MAXW = 520;

        function save() {
          var r = el.getBoundingClientRect();
          try {
            localStorage.setItem(KEY, JSON.stringify({
              x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width),
            }));
          } catch (e) {}
        }
        // 至少留一角在屏幕里，免得拖出去就找不回来了
        function clamp(x, y) {
          var r = el.getBoundingClientRect();
          var keepX = Math.max(60, r.width * 0.35);
          var keepY = Math.max(60, r.height * 0.25);
          return [
            Math.min(Math.max(x, 60 - r.width), window.innerWidth - keepX),
            Math.min(Math.max(y, 0), window.innerHeight - keepY),
          ];
        }
        function pin(x, y) {
          el.style.left = x + "px";
          el.style.top = y + "px";
          el.style.right = "auto";
          el.style.bottom = "auto";
        }

        // 恢复上次的位置与大小
        try {
          var s = JSON.parse(localStorage.getItem(KEY) || "null");
          if (s && s.w) {
            el.style.width = s.w + "px";
            if (typeof s.x === "number") {
              var p0 = clamp(s.x, s.y);
              pin(p0[0], p0[1]);
            }
          }
        } catch (e) {}

        var drag = null;
        function onDown(e) {
          if (e.button != null && e.button !== 0) return;
          var r = el.getBoundingClientRect();
          drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, sx: e.clientX, sy: e.clientY, moved: false };
          el.style.transition = "none";
          try { el.setPointerCapture(e.pointerId); } catch (err) {}
        }
        // ★ 2026-10-05：姿势跟着位置走（爀曦要的「拖着拖着就坐下了」）。
        //   拖动中先蹲下（「她蹲下来让你拖」），松手再按停在哪儿定姿势。
        //   ★ 只在【进入拖动】和【松手】两个时刻各调一次 —— 拖动中每帧 setState
        //     会让 React 每帧重渲染，手感直接废掉（这是踩过一次的）。
        function setPoseSafe(name) {
          if (typeof window !== "undefined" && window.__yqSetPose) window.__yqSetPose(name);
        }
        function poseFor(x, y, w, h) {
          var vw = window.innerWidth, vh = window.innerHeight;
          var bottom = y + h > vh - 36;
          var top = y < 36;
          var left = x < 56;
          var right = x + w > vw - 56;
          if (bottom && (left || right)) return "corner";   // 底角 → 盘腿捧杯
          if (bottom) return "sit";                          // 底边 → 坐在屏幕沿上
          if (top) return "stretch";                         // 顶边 → 伸懒腰
          if (left || right) return "lean";                  // 左右边 → 靠着
          return "stand";
        }
        function applyPose() {
          var r = el.getBoundingClientRect();
          setPoseSafe(poseFor(r.left, r.top, r.width, r.height));
        }
        function onMove(e) {
          if (!drag) return;
          if (!drag.moved && Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) < 4) return;
          drag.moved = true;
          if (!drag.poseSet) { drag.poseSet = 1; setPoseSafe("squat"); }
          // ★ 拖动态写 inline style，不写 class：React 重渲染时会把 className 整个换掉，
          //   拖动中途一旦状态翻页（idle→working），拖动态就被抹掉、元素会抬起来抖一下。
          el.style.transform = "none";
          el.style.cursor = "grabbing";
          var p = clamp(e.clientX - drag.dx, e.clientY - drag.dy);
          pin(p[0], p[1]);
          e.preventDefault();
        }
        function onUp() {
          if (!drag) return;
          var moved = drag.moved;
          drag = null;
          el.style.transition = "";
          el.style.transform = "";
          el.style.cursor = "";
          applyPose();   // 停哪儿像哪儿（点击没拖动时也走一遍，无害）
          if (moved) {
            save();
            // 拖完手一松，浏览器还会补一个 click —— 吞掉它，不然每次拖完都被戳一下
            el.dataset.yqDragged = "1";
            window.setTimeout(function () { delete el.dataset.yqDragged; }, 0);
          }
        }
        function onWheel(e) {
          e.preventDefault();
          var r = el.getBoundingClientRect();
          var w = Math.round(r.width * (e.deltaY < 0 ? 1.08 : 0.926));
          w = Math.min(Math.max(w, MINW), MAXW);
          if (w === Math.round(r.width)) return;
          el.style.width = w + "px";
          var p = clamp(r.left, r.top);   // 长大之后按左上角重新夹一次
          pin(p[0], p[1]);
          save();
        }
        // 拖动结束那一次 click：在捕获阶段就拦掉（React 的 onClick 在冒泡阶段，拦得住）
        function onClickCapture(e) {
          if (el.dataset.yqDragged) {
            e.stopPropagation();
            e.preventDefault();
          }
        }
        function onResize() {
          if (!el.style.left) return;
          var r = el.getBoundingClientRect();
          var p = clamp(r.left, r.top);
          pin(p[0], p[1]);
          applyPose();   // 窗口大小变了，「贴边」的判定也会跟着变
        }

        el.addEventListener("pointerdown", onDown);
        el.addEventListener("pointermove", onMove);
        el.addEventListener("pointerup", onUp);
        el.addEventListener("pointercancel", onUp);
        el.addEventListener("wheel", onWheel, { passive: false });
        el.addEventListener("click", onClickCapture, true);
        window.addEventListener("resize", onResize);
      }

      // ---- 点击 ----
      function poke() {
        setOverride("poke");
        window.setTimeout(function () { setOverride(null); }, 700);
      }

      // ---- 决定显示哪张图 ----
      var src = null;
      var faceKey = face;
      if (sleep === "asleep") faceKey = "blink";
      else if (sleep === "tired") faceKey = "sleepy";
      else if (isBlink) faceKey = "blink";
      else if (idleFace) faceKey = idleFace;

      // ★ 姿势优先（2026-10-05）：只要不是默认的站姿，就整张换成姿势立绘。
      //   姿势图和表情差分不是一回事 —— 它是独立画的整身立绘（还是另一条产线出的），
      //   所以换姿势时**人物位置会有一次自然的位移**：坐着本来就该矮一截、偏一点。
      //   姿势的优先级高于帧动画：坐着的时候不该再叠一层"站着呼吸"的帧。
      if (pose && pose !== "stand" && assets && assets.poses && assets.poses[pose]) {
        src = assets.poses[pose];
      } else if (seq && seq.length) {
        src = seq[(frameIdx % seq.length + seq.length) % seq.length];
        // 眨眼时临时切到 blink 那张静态图（同一画布，位置不跳）
        if (isBlink && assets && assets.faces.blink) src = assets.faces.blink;
      } else if (assets && assets.faces[faceKey]) {
        src = assets.faces[faceKey];
      }

      var noFrame = !(seq && seq.length) && !(pose && pose !== "stand");
      var bubble = BUBBLE[eff] || "";

      var cls = "yq-pet yq-pet--" + eff
        + (sleep === "asleep" ? " yq-pet--asleep" : "")
        + (noFrame ? " yq-pet--noframe" : "");

      // 眨眼兜底色块（只在没有真实 blink 差分时才用）
      var lids = [];
      if (isBlink && !(assets && assets.faces.blink)) {
        for (var i = 0; i < EYES.length; i++) {
          var e = EYES[i];
          lids.push(react.createElement("div", {
            key: "lid" + i,
            className: "yq-pet-lid",
            style: { left: e.left + "%", top: e.top + "%", width: e.w + "%", height: e.h + "%" },
          }));
        }
      }

      if (!src) {
        return react.createElement("div", { className: "yq-pet-loading" }, "砚青 · 载入中");
      }

      // ★ 把所有素材图一次性挂成兄弟层，只有当前这张 opacity=1（2026-09-24）。
      //   为什么不换 src：浏览器在「取到 + 解码完」之前，那一帧这个 img 是空的 ——
      //   换 src 就必然有一次空窗，眼睛看到的就是"闪一下"。眨眼每 1.3~2.1s 一次，
      //   所以原来是持续在闪。图全在 DOM 里 ⇒ 切 opacity 是即时的，没有空窗。
      //   decoding:'sync' 保证挂载那一轮就解码完，代价是一次性几十毫秒。
      var layerUrls = [];
      if (assets) {
        Object.keys(assets.faces || {}).forEach(function (k) { layerUrls.push(assets.faces[k]); });
        Object.keys(assets.frames || {}).forEach(function (k) {
          (assets.frames[k] || []).forEach(function (u) { layerUrls.push(u); });
        });
        // ★ 姿势图也要一起挂进来预加载 —— 拖到边上才去取图的话，
        //   切换那一下会先空一帧（和当初表情闪烁同一个病）。
        Object.keys(assets.poses || {}).forEach(function (k) { layerUrls.push(assets.poses[k]); });
      }
      var seenU = {};
      layerUrls = layerUrls.filter(function (u) {
        if (!u || seenU[u]) return false;
        seenU[u] = 1;
        return true;
      });
      var layers = layerUrls.map(function (u) {
        return react.createElement("img", {
          key: u,
          className: "yq-pet-layer" + (u === src ? " on" : ""),
          src: u,
          alt: "",
          draggable: false,
          decoding: "sync",
        });
      });

      // ★ 这里原来是 key:"k"+doneKey —— 外层 key 一变，React 会把整棵子树
      //   卸载重建（连 <img> 一起），那是闪动的第二个来源。帧循环的重启
      //   由上面 [seq, cfg.fps, doneKey] 那个 effect 负责，不需要靠 key 强拆。
      return react.createElement("div", {
        className: cls,
        // ★ 2026-10-04：回调 ref。不依赖 react.useRef（真包有，但不必赌），
        //   也不用 document.querySelector（那个在 effect 里查过一次、结果没绑上）。
        //   PetView 是函数组件，普通闭包变量每次渲染都会重置，所以挂到 window 上；
        //   页面上只有一个宠物，这个"全局"是安全的。
        ref: function (n) { window.__yqPetEl = n; bindDrag(n); },
        onClick: poke,
        title: "砚青 · " + eff + (sleep !== "awake" ? "（" + sleep + "）" : "")
          + " · 拖动移动 / 滚轮缩放",
      },
        bubble ? react.createElement("div", { className: "yq-pet-bubble" }, bubble) : null,
        react.createElement("div", { className: "yq-pet-body" },
          layers,
          react.createElement("div", { className: "yq-pet-eyes" }, lids),
          react.createElement("div", { className: "yq-pet-blush yq-pet-blush-l" }),
          react.createElement("div", { className: "yq-pet-blush yq-pet-blush-r" }),
          react.createElement("div", { className: "yq-pet-mark yq-pet-mark-sweat" }, "💧"),
          react.createElement("div", { className: "yq-pet-mark yq-pet-mark-star" }, "✦"),
        ),
      );
    }

    function apply(ctx) {
      var style = document.createElement("style");
      style.setAttribute("data-yanqing-pet", "1");
      style.textContent = CSS;
      document.head.appendChild(style);

      ctx.slots.inject("shell.overlay", function () {
        return ctx.slots.register(
          { name: "shell.overlay", id: "yanqing-pet", order: 40, label: "砚青 · 宠物" },
          PetView,
        );
      });
    }

    exports.apply = apply;
    exports.inject = ["slots"];   // ★★★ 少写这行整包静默失效
    return module.exports;
  },
});
