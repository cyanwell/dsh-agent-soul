/**
 * dsh-agent-lead-waker —— 浏览器半（右上角徽章 + 浮层台账面板）
 *
 * ★ 为什么挂 shell.overlay 而不是侧栏或主区 tab（DESIGN §五）：
 *   「这个插件是要显式的，放在顶栏」。root 只有 6 个槽位
 *   （sidebar / main / rightbar / shell.bottom / shell.overlay / shell.leading），
 *   只有 overlay 是「绝对定位的全屏浮层」—— 不占侧栏、不占主区、天然能贴在顶栏右上角。
 *   位置是自己用 position 定的，不是槽位给的（桌宠、状态条都这么做，本机实测可行）。
 *
 * ★ 数据只走 Host 半的 /lead-waker/state 与 /lead-waker/decide；这里不读文件、不判定。
 *   「宪章过没过」由 lead 写，面板只负责把 unchecked 显示得像 unchecked。
 *
 * ★ 三条硬约束（踩过就别再踩）：
 *   · __ModuleLoader__.load({ id }) 的 id 必须等于 package.json 的 name
 *   · ctx.slots.register(spec, X) 第二个参数必须是组件本身（不是 () => 组件）
 *   · exports.inject 只写 ["slots"] —— 多写一个不存在的服务，apply 永不执行，整包静默失效
 */
window.__ModuleLoader__.load({
  id: "dsh-agent-lead-waker",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var h = react.createElement;
    var useState = react.useState;
    var useEffect = react.useEffect;

    var PANEL_ID = "yanqing-lead-waker";
    var API = "/lead-waker";

    // ── 文案 ────────────────────────────────────────────────────────────
    // ★ 颜色只表达「要不要人动手」，不用彩色堆气氛：
    //   act = 该我动手 / warn = 悬着等人 / ok = 已完成 / dim = 已收口。
    var CHARTER_LABEL = {
      pass: "宪章·过",
      ask: "宪章·要问",
      block: "宪章·阻断",
      unchecked: "宪章·未判",
    };
    var DECISION_LABEL = { resume: "已执行", hold: "已搁置", audit: "已送审" };

    var CSS = [
      ".lw-root{position:fixed;inset:0;pointer-events:none;z-index:48;",
      "font-family:inherit;color:inherit;font-size:12.5px;line-height:1.6;box-sizing:border-box}",
      ".lw-root *{box-sizing:border-box}",
      ".lw-badge{position:absolute;top:8px;right:14px;pointer-events:auto;display:flex;",
      "align-items:center;gap:6px;padding:3px 10px 3px 8px;border-radius:999px;",
      "border:1px solid rgba(128,128,128,.42);background:rgba(127,127,127,.14);",
      "backdrop-filter:blur(8px);box-shadow:0 2px 10px rgba(0,0,0,.16);cursor:pointer;",
      "color:inherit;font:inherit;font-size:12px;opacity:.2;transition:opacity .38s ease,transform .2s}",
      ".lw-badge:hover{opacity:.9}",
      ".lw-badge.on{opacity:1}",
      ".lw-badge.on .lw-dot{background:#e8833a;box-shadow:0 0 0 3px rgba(232,131,58,.18)}",
      ".lw-dot{width:7px;height:7px;border-radius:50%;background:rgba(128,128,128,.7);flex:0 0 auto}",
      ".lw-n{font-variant-numeric:tabular-nums;font-weight:700}",
      ".lw-cap{color:rgba(128,128,128,.95);font-size:11px;letter-spacing:.02em}",
      ".lw-mask{position:absolute;inset:0;pointer-events:auto;background:transparent}",
      ".lw-panel{position:absolute;top:40px;right:14px;pointer-events:auto;width:min(436px,calc(100vw - 24px));",
      "max-height:min(78vh,600px);display:flex;flex-direction:column;border-radius:14px;",
      "border:1px solid rgba(128,128,128,.4);background:rgba(127,127,127,.16);",
      "backdrop-filter:blur(20px) saturate(160%);box-shadow:0 16px 48px rgba(0,0,0,.26);overflow:hidden}",
      ".lw-head{display:flex;align-items:baseline;gap:8px;padding:11px 14px 9px;",
      "border-bottom:1px solid rgba(128,128,128,.24);flex:0 0 auto}",
      ".lw-h1{font-size:13.5px;font-weight:700;letter-spacing:.02em}",
      ".lw-sub{font-size:11px;color:rgba(128,128,128,.95)}",
      ".lw-x{margin-left:auto;border:0;background:transparent;color:inherit;cursor:pointer;",
      "font-size:15px;line-height:1;padding:2px 4px;border-radius:6px;opacity:.7}",
      ".lw-x:hover{opacity:1;background:rgba(128,128,128,.16)}",
      ".lw-body{overflow-y:auto;overflow-x:hidden;padding:8px 10px 12px;min-height:0}",
      ".lw-sec{margin-top:6px;border:1px solid rgba(128,128,128,.22);border-radius:10px;overflow:hidden;",
      "background:rgba(127,127,127,.06)}",
      ".lw-sech{display:flex;align-items:center;gap:7px;width:100%;padding:7px 10px;border:0;",
      "background:transparent;color:inherit;font:inherit;cursor:pointer;text-align:left}",
      ".lw-sech:hover{background:rgba(128,128,128,.12)}",
      ".lw-caret{width:10px;color:rgba(128,128,128,.9);font-size:10px;flex:0 0 auto}",
      ".lw-secn{font-weight:600}",
      ".lw-cnt{margin-left:auto;font-variant-numeric:tabular-nums;font-size:11px;",
      "padding:0 7px;border-radius:999px;background:rgba(128,128,128,.18);color:rgba(128,128,128,.95)}",
      ".lw-hint{font-size:10.5px;color:rgba(128,128,128,.85);padding:0 10px 7px}",
      ".lw-empty{font-size:11.5px;color:rgba(128,128,128,.9);padding:4px 12px 10px}",
      ".lw-item{margin:6px 10px;padding:8px 10px;border-radius:9px;border:1px solid rgba(128,128,128,.2);",
      "background:rgba(127,127,127,.08)}",
      ".lw-top{display:flex;align-items:flex-start;gap:6px}",
      ".lw-title{flex:1;min-width:0;font-size:12.5px;font-weight:600;line-height:1.45;",
      "display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}",
      ".lw-tag{flex:0 0 auto;font-size:10px;padding:1px 6px;border-radius:5px;letter-spacing:.02em;",
      "border:1px solid rgba(128,128,128,.35);color:rgba(128,128,128,.95);white-space:nowrap}",
      ".lw-tag.act{color:#e8833a;border-color:rgba(232,131,58,.5);background:rgba(232,131,58,.1)}",
      ".lw-tag.ok{color:#3f9e6e;border-color:rgba(63,158,110,.45)}",
      ".lw-tag.ask{color:#c9922e;border-color:rgba(201,146,46,.45);background:rgba(201,146,46,.1)}",
      ".lw-tag.block{color:#d0575a;border-color:rgba(208,87,90,.5);background:rgba(208,87,90,.1)}",
      ".lw-tag.un{color:rgba(128,128,128,.95);border-style:dashed}",
      ".lw-meta{margin-top:3px;font-size:10.5px;color:rgba(128,128,128,.95);",
      "white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".lw-note{margin-top:3px;font-size:10.5px;color:rgba(128,128,128,.9);font-style:italic}",
      ".lw-acts{margin-top:7px;display:flex;flex-direction:column;gap:5px}",
      ".lw-row{display:flex;gap:5px;align-items:center}",
      ".lw-sel,.lw-inp{flex:1 1 0;min-width:0;font:inherit;font-size:11px;padding:3px 6px;",
      "border-radius:6px;border:1px solid rgba(128,128,128,.38);background:rgba(127,127,127,.1);",
      "color:inherit;outline:none}",
      ".lw-sel{flex:0 0 96px}",
      ".lw-inp::placeholder{color:rgba(128,128,128,.8)}",
      ".lw-btn{flex:1 1 0;font:inherit;font-size:11.5px;padding:4px 0;border-radius:6px;cursor:pointer;",
      "border:1px solid rgba(128,128,128,.4);background:rgba(127,127,127,.12);color:inherit;",
      "transition:background .16s}",
      ".lw-btn:disabled{opacity:.5;cursor:default}",
      ".lw-btn:hover:not(:disabled){background:rgba(128,128,128,.24)}",
      ".lw-btn.go{border-color:rgba(63,158,110,.55);color:#3f9e6e}",
      ".lw-btn.go:hover:not(:disabled){background:rgba(63,158,110,.16)}",
      ".lw-btn.audit{border-color:rgba(201,146,46,.5);color:#c9922e}",
      ".lw-btn.audit:hover:not(:disabled){background:rgba(201,146,46,.14)}",
      ".lw-foot{flex:0 0 auto;border-top:1px solid rgba(128,128,128,.24);padding:7px 12px;",
      "font-size:10.5px;color:rgba(128,128,128,.95);display:flex;flex-wrap:wrap;gap:4px 10px}",
      ".lw-warn{color:#d0575a}",
    ].join("\n");

    // ── 纯函数 ──────────────────────────────────────────────────────────
    function fmtTime(iso) {
      if (!iso) return "时间未知";
      var d = new Date(iso);
      if (isNaN(d.getTime())) return String(iso).slice(0, 16);
      var p = function (n) { return (n < 10 ? "0" : "") + n; };
      return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
    }

    function fmtAgo(ts) {
      if (!ts) return "还没跑过";
      var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
      if (s < 60) return s + " 秒前";
      if (s < 3600) return Math.round(s / 60) + " 分钟前";
      return Math.round(s / 3600) + " 小时前";
    }

    // ── 小部件 ──────────────────────────────────────────────────────────
    function Tag(props) {
      var cls = props.tone ? " " + props.tone : "";
      return h("span", { className: "lw-tag" + cls }, props.text);
    }

    function Item(props) {
      var ev = props.ev;
      var draft = props.draft || {};
      var busy = props.busy;
      var charterTone = ev.charter === "pass" ? "ok"
        : ev.charter === "ask" ? "ask"
        : ev.charter === "block" ? "block" : "un";
      return h("div", { className: "lw-item" },
        h("div", { className: "lw-top" },
          h("span", { className: "lw-title", title: ev.title }, ev.title || "(无标题)"),
          ev.tier ? h(Tag, { tone: ev.tier === "act" ? "act" : "", text: ev.tier }) : null,
          h(Tag, { tone: charterTone, text: CHARTER_LABEL[ev.charter] || ev.charter })
        ),
        h("div", { className: "lw-meta", title: ev.key },
          (ev.from || "来源未知") + " · " + fmtTime(ev.t) +
          (ev.decision ? " · " + (DECISION_LABEL[ev.decision] || ev.decision) : " · 待判") +
          (ev.wakeCount ? " · 叫醒 " + ev.wakeCount + " 次" : "")
        ),
        ev.note ? h("div", { className: "lw-note" }, ev.note) : null,
        ev.charterNote ? h("div", { className: "lw-note" }, "宪章：" + ev.charterNote) : null,
        h("div", { className: "lw-acts" },
          h("div", { className: "lw-row" },
            // ★ 宪章必须显式选。默认空 = 「未判」，不是「通过」——
            //   DESIGN §六 明确禁止「没写就当通过」，所以这里不预置 pass。
            h("select", {
              className: "lw-sel",
              value: draft.charter || "",
              onChange: function (e) { props.onDraft(ev.key, { charter: e.target.value }); },
            },
              h("option", { value: "" }, "宪章未判"),
              h("option", { value: "pass" }, "过"),
              h("option", { value: "ask" }, "要问"),
              h("option", { value: "block" }, "阻断")
            ),
            h("input", {
              className: "lw-inp",
              placeholder: "宪章说明 / 附注（可空）",
              value: draft.note || "",
              onChange: function (e) { props.onDraft(ev.key, { note: e.target.value }); },
            })
          ),
          h("div", { className: "lw-row" },
            h("button", {
              className: "lw-btn go", disabled: busy === ev.key,
              onClick: function () { props.onDecide(ev.key, "resume"); },
            }, "执行"),
            h("button", {
              className: "lw-btn", disabled: busy === ev.key,
              onClick: function () { props.onDecide(ev.key, "hold"); },
            }, "搁置"),
            h("button", {
              className: "lw-btn audit", disabled: busy === ev.key,
              onClick: function () { props.onDecide(ev.key, "audit"); },
            }, "送审")
          )
        )
      );
    }

    function Section(props) {
      var list = props.list || [];
      return h("div", { className: "lw-sec" },
        h("button", { className: "lw-sech", onClick: props.onToggle },
          h("span", { className: "lw-caret" }, props.open ? "▾" : "▸"),
          h("span", { className: "lw-secn" }, props.title),
          h("span", { className: "lw-cnt" }, String(list.length))
        ),
        h("div", { className: "lw-hint" }, props.hint),
        props.open
          ? (list.length
            ? list.map(function (ev) {
              return h(Item, {
                key: ev.key, ev: ev, draft: props.drafts[ev.key],
                busy: props.busy, onDraft: props.onDraft, onDecide: props.onDecide,
              });
            })
            : h("div", { className: "lw-empty" }, props.empty || "（空）"))
          : null
      );
    }

    // ── 主体 ────────────────────────────────────────────────────────────
    function View() {
      var s0 = useState(null); var data = s0[0]; var setData = s0[1];
      var s1 = useState(false); var open = s1[0]; var setOpen = s1[1];
      var s2 = useState({}); var drafts = s2[0]; var setDrafts = s2[1];
      var s3 = useState(""); var busy = s3[0]; var setBusy = s3[1];
      var s4 = useState(""); var err = s4[0]; var setErr = s4[1];
      var s5 = useState({ act: true, done: false, audit: true, auto: false });
      var secOpen = s5[0]; var setSecOpen = s5[1];

      function pull() {
        fetch(API + "/state").then(function (r) { return r.json(); })
          .then(function (j) {
            if (j && j.ok) { setData(j); setErr(""); }
            else setErr((j && j.err) || "Host 返回了 ok:false");
          })
          .catch(function () { setErr("读不到 /lead-waker/state"); });
      }

      useEffect(function () {
        var alive = true;
        function safePull() { if (alive) pull(); }
        safePull();
        var t = setInterval(safePull, 10000);
        return function () { alive = false; clearInterval(t); };
      }, []);

      function onDraft(key, patch) {
        setDrafts(function (prev) {
          var next = Object.assign({}, prev);
          next[key] = Object.assign({}, next[key] || {}, patch);
          return next;
        });
      }

      function onDecide(key, decision) {
        var d = drafts[key] || {};
        setBusy(key); setErr("");
        fetch(API + "/decide", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            key: key,
            decision: decision,
            // ★ 没选宪章就不传 —— 服务端保留 unchecked，而不是当成 pass
            charter: d.charter || undefined,
            charterNote: d.note || undefined,
            note: d.note || undefined,
          }),
        }).then(function (r) { return r.json(); })
          .then(function (j) {
            if (!j || !j.ok) setErr((j && j.err) || "判定没写进去");
            pull();
          })
          .catch(function () { setErr("判定请求失败（Host 半没起来？）"); })
          .then(function () { setBusy(""); });
      }

      var views = (data && data.views) || { act: [], done: [], audit: [], auto: [] };
      var counts = (data && data.counts) || {};
      var n = counts.badge || 0;

      var badge = h("button", {
        className: "lw-badge" + (n > 0 ? " on" : ""),
        onClick: function () { setOpen(function (x) { return !x; }); },
        title: "事件层台账 · 未处理 " + n + " 条（点击展开）",
      },
        h("span", { className: "lw-dot" }),
        h("span", { className: "lw-n" }, String(n)),
        h("span", { className: "lw-cap" }, "待办")
      );

      if (!open) return h("div", { className: "lw-root" }, badge);

      var rt = (data && data.runtime) || {};
      var down = (data && data.down) || { fails: [] };
      var T = function (name) { return function () {
        setSecOpen(function (prev) { var nx = Object.assign({}, prev); nx[name] = !nx[name]; return nx; });
      }; };

      var panel = h("div", { className: "lw-panel" },
        h("div", { className: "lw-head" },
          h("span", { className: "lw-h1" }, "事件层台账"),
          h("span", { className: "lw-sub" },
            data ? "共 " + (counts.total || 0) + " 条 · " + (counts.stuck || 0) + " 条叫不醒" : "读取中…"),
          h("button", { className: "lw-x", onClick: function () { setOpen(false); }, title: "收起" }, "×")
        ),
        h("div", { className: "lw-body" },
          !data && err
            ? h("div", { className: "lw-empty" },
              err + " —— Host 半要等下次 DSH 重启才生效（本插件的 index.js 已改，进程里还是旧版）")
            : null,
          data && err ? h("div", { className: "lw-empty lw-warn" }, err) : null,
          // ★ 默认只展开「要你执行」：面板一打开就该是「现在要我做什么」，
          //   已完成/自主两类是回顾用的，展开它们会把最该看的那区挤下去。
          h(Section, {
            title: "要你执行", hint: "stage=woken 且还没有判定 —— 挂着没动的，最该先看",
            list: views.act, open: !!secOpen.act, onToggle: T("act"),
            drafts: drafts, busy: busy, onDraft: onDraft, onDecide: onDecide,
            empty: "没有要你动手的。",
          }),
          h(Section, {
            title: "要审计但没审", hint: "decision=audit / 宪章=要问 / 叫不醒 —— 悬着等你拍板的",
            list: views.audit, open: !!secOpen.audit, onToggle: T("audit"),
            drafts: drafts, busy: busy, onDraft: onDraft, onDecide: onDecide,
            empty: "没有悬着的事。",
          }),
          h(Section, {
            title: "你已执行", hint: "decision=resume —— 主导会话接了并做完的",
            list: views.done, open: !!secOpen.done, onToggle: T("done"),
            drafts: drafts, busy: busy, onDraft: onDraft, onDecide: onDecide,
            empty: "还没有已执行的。",
          }),
          h(Section, {
            title: "你自己决定做的", hint: "有判定 且 宪章=过 —— 自己拿的主意，得能跟送审的区分开",
            list: views.auto, open: !!secOpen.auto, onToggle: T("auto"),
            drafts: drafts, busy: busy, onDraft: onDraft, onDecide: onDecide,
            empty: "没有「自己拍板且宪章通过」的。",
          })
        ),
        h("div", { className: "lw-foot" },
          h("span", null, "lead " + (rt.leadPrefix || "未找到")),
          h("span", null, "上次轮询 " + fmtAgo(rt.lastPollAt)),
          h("span", null, "今日叫醒 " + (rt.dayCount || 0) + "/" + (rt.maxPerDay || 0)),
          down.fails && down.fails.length
            ? h("span", { className: "lw-warn" }, "下发失败 " + down.fails.length + " 条")
            : null
        )
      );

      return h("div", { className: "lw-root" },
        h("div", {
          className: "lw-mask",
          onClick: function () { setOpen(false); },
        }),
        panel
      );
    }

    function apply(ctx) {
      var style = document.createElement("style");
      style.setAttribute("data-yanqing-lead-waker", "1");
      style.textContent = CSS;
      document.head.appendChild(style);

      // ★ 与心跳同形：inject 后 register。第二个参数是组件本身，不是 () => 组件。
      ctx.slots.inject("shell.overlay", function () {
        return ctx.slots.register(
          { name: "shell.overlay", id: PANEL_ID, order: 55, label: "事件层 · 待办" },
          View
        );
      });
    }

    exports.apply = apply;
    exports.inject = ["slots"];   // ★★★ 少写这行整包静默失效
    return module.exports;
  },
});
