/**
 * dsh-yanqing-voice —— 浏览器半（Client half）· v0.2
 *
 * 输入框工具行里两个按钮：
 *   🔊  单击 = 立刻播最新一条（不再让你在菜单里挑）；右键 = 展开列表选别的
 *   🔔  自动朗读开关。开着时：砚青每轮回复后生成的语音会被自动播出来；
 *       关掉则彻底安静。状态存 localStorage。
 *
 * 自动朗读靠轮询 /yanqing-voice/_list（3 秒一次）：列表按文件名倒序，
 * 所以"最新"就是 [0]。砚青那边把朗读音频命名成 9x- 前缀，于是它天然排在最前。
 *
 * ⚠️ 事故记忆（D:\AI\dsh-tools\dsh-yanqing\client.js:4）：
 *    所有客户端入口打成一个包加载，**一个入口坏，整个 GUI 起不来**。
 *    改完必须先 `node --check client.js`，再 Copy-Item 到 profile 的 node_modules
 *    （edit/write 是原子写入，会打断 add 建立的硬链接），最后刷新页面验证。
 *
 * ⚠️ exports.inject = ["slots"] 必须写：不写则 apply 里 ctx.slots 是 undefined，
 *    代码判空静默退出，而 Host 侧照样报 running —— 查都不好查。
 *
 * ★ 样式全走 inline style。v0.1 的教训：当时用 opacity .75 + 透明背景 + 13px，
 *   元素明明在 DOM 里、宽 26px，肉眼却几乎看不见，用户连说三次"看不到"。
 *   **宽度不等于可见。** 现在对齐同行的 + / @：满不透明度 + 淡底 + 28px 圆形。
 */
window.__ModuleLoader__.load({
  id: "dsh-yanqing-voice",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react = require("react");
    var useState = react.useState;
    var useEffect = react.useEffect;
    var useRef = react.useRef;

    var WRAP = { position: "relative", display: "inline-flex", alignItems: "center", gap: "4px" };

    var BTN = {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: "28px",
      height: "28px",
      borderRadius: "50%",
      border: "none",
      background: "rgba(127,127,127,.16)",
      cursor: "pointer",
      fontSize: "14px",
      lineHeight: "1",
      padding: "0",
      color: "inherit",
      opacity: "1",
      transition: "background .15s",
      userSelect: "none",
    };

    var BTN_ON = { background: "rgba(90,150,255,.34)" };
    var BTN_ARMED = { background: "rgba(90,150,255,.55)" };

    var MENU = {
      position: "absolute",
      bottom: "calc(100% + 8px)",
      left: "0",
      zIndex: "80",
      minWidth: "184px",
      padding: "4px",
      borderRadius: "10px",
      background: "Canvas",
      color: "CanvasText",
      border: "1px solid rgba(127,127,127,.3)",
      boxShadow: "0 8px 26px rgba(0,0,0,.22)",
      display: "flex",
      flexDirection: "column",
      gap: "2px",
    };

    var ITEM = {
      textAlign: "left",
      padding: "6px 10px",
      borderRadius: "7px",
      border: "none",
      background: "transparent",
      cursor: "pointer",
      fontSize: "12px",
      color: "inherit",
      whiteSpace: "nowrap",
    };

    var HINT = { fontSize: "11px", opacity: "0.6", padding: "4px 10px 2px" };

    var AUTO_KEY = "yq-voice-autoread";

    function merge(a, b) {
      var o = {};
      var k;
      for (k in a) { if (Object.prototype.hasOwnProperty.call(a, k)) o[k] = a[k]; }
      for (k in b) { if (Object.prototype.hasOwnProperty.call(b, k)) o[k] = b[k]; }
      return o;
    }

    function fetchList() {
      return fetch("/yanqing-voice/_list", { cache: "no-store" })
        .then(function (r) { return r.json(); })
        .then(function (j) { return (j && j.items) || []; });
    }

    function VoiceButton() {
      var openS = useState(false);
      var itemsS = useState([]);
      var srcS = useState("");
      var onS = useState(false);
      var tipS = useState("点一下听最新的 · 右键选别的");
      var errS = useState("");
      var autoS = useState(false);

      var open = openS[0], setOpen = openS[1];
      var items = itemsS[0], setItems = itemsS[1];
      var src = srcS[0], setSrc = srcS[1];
      var on = onS[0], setOn = onS[1];
      var tip = tipS[0], setTip = tipS[1];
      var err = errS[0], setErr = errS[1];
      var auto = autoS[0], setAuto = autoS[1];

      // seenRef：已经见过的"最新文件"。只活在内存里 —— 不持久化，
      // 这样刷新页面不会把上一条又播一遍。
      var seenRef = useRef("");
      var primedRef = useRef(false);

      function play(name) {
        setErr("");
        setSrc("/yanqing-voice/" + encodeURIComponent(name) + "?t=" + new Date().getTime());
        setOn(true);
        setOpen(false);
      }

      // 挂载时取一次列表（点的时候零等待）＋ 读回开关状态
      useEffect(function () {
        var alive = true;
        fetchList()
          .then(function (list) { if (alive && list.length) { setItems(list); seenRef.current = list[0]; } })
          .catch(function () {});
        try { setAuto(String(window.localStorage.getItem(AUTO_KEY)) === "1"); } catch (e) { /* 无存储就当关 */ }
        return function () { alive = false; };
      }, []);

      // ★ 自动朗读：开关开着才轮询。发现比 seenRef 新的就播。
      //   首次一律只记录不播（primedRef），否则刷新页面会把最后一条重放一遍。
      useEffect(function () {
        if (!auto) return undefined;
        var timer = window.setInterval(function () {
          fetchList().then(function (list) {
            if (!list.length) return;
            var newest = list[0];
            setItems(list);
            if (!primedRef.current) { primedRef.current = true; seenRef.current = newest; return; }
            if (newest !== seenRef.current) {
              seenRef.current = newest;
              play(newest);
            }
          }).catch(function () { /* 网络抖动就跳过一次 */ });
        }, 3000);
        return function () { window.clearInterval(timer); };
      }, [auto]);

      function toggleAuto() {
        var next = !auto;
        setAuto(next);
        primedRef.current = false;      // 重新开启时，先记录现状再等新的
        try { window.localStorage.setItem(AUTO_KEY, next ? "1" : "0"); } catch (e) { /* 忽略 */ }
        setErr("");
        setTip(next ? "自动朗读：开 —— 我回答完会自动出声" : "点一下听最新的 · 右键选别的");
      }

      function clickPlay() {
        if (open) { setOpen(false); return; }
        if (items.length === 0) {
          setTip("取声音…");
          fetchList().then(function (list) {
            if (!list.length) { setTip("还没有声音"); setErr("60-声音 目录里没有 mp3"); return; }
            setItems(list);
            play(list[0]);
          }).catch(function () { setTip("取声音失败"); setErr("取不到语音列表"); });
          return;
        }
        play(items[0]);                  // ★ 一击出声
      }

      function openMenu(e) {
        if (e && e.preventDefault) e.preventDefault();
        if (items.length === 0) {
          fetchList().then(function (list) {
            if (!list.length) { setErr("60-声音 目录里没有 mp3"); return; }
            setItems(list);
            setOpen(true);
          }).catch(function () { setErr("取不到语音列表"); });
          return;
        }
        setOpen(true);
      }

      var kids = [
        react.createElement("button", {
          key: "play",
          type: "button",
          title: tip,
          onClick: clickPlay,
          onContextMenu: openMenu,
          style: on ? merge(BTN, BTN_ON) : BTN,
        }, on ? "🔊" : "🔈"),
        react.createElement("button", {
          key: "auto",
          type: "button",
          title: auto ? "自动朗读：开（回答完会自动出声）— 点一下关闭" : "自动朗读：关 — 点一下开启",
          onClick: toggleAuto,
          style: auto ? merge(BTN, BTN_ARMED) : BTN,
        }, auto ? "🔔" : "🔕"),
      ];

      if (open) {
        var rows = items.map(function (name) {
          return react.createElement("button", {
            key: name,
            type: "button",
            style: ITEM,
            onClick: function () { play(name); },
            onMouseEnter: function (e) { e.currentTarget.style.background = "rgba(127,127,127,.18)"; },
            onMouseLeave: function (e) { e.currentTarget.style.background = "transparent"; },
          }, name.replace(/\.(mp3|wav)$/i, ""));
        });
        kids.push(react.createElement("div", { key: "m", style: MENU },
          [react.createElement("div", { key: "h", style: HINT }, "点一个听听")].concat(rows)));
      }

      if (err) {
        kids.push(react.createElement("div", { key: "e", style: HINT }, err));
      }

      if (src) {
        kids.push(react.createElement("audio", {
          key: "a",
          src: src,
          autoPlay: true,
          style: { display: "none" },
          onEnded: function () { setOn(false); setSrc(""); },
          onError: function () { setOn(false); setSrc(""); setErr("这条播不出来"); },
        }));
      }

      return react.createElement("span", { style: WRAP }, kids);
    }

    function apply(ctx) {
      ctx.slots.inject("conversation.input.left", function () {
        ctx.slots.register(
          { name: "conversation.input.left", id: "yanqing-voice", order: 50, label: "砚青的声音" },
          function () { return react.createElement(VoiceButton); }
        );
      });
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});
