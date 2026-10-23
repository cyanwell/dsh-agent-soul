// dsh-yanqing-huanqi-panel · 客户端半（设置面板里的「换气」那一页）
//
// ★ 挂载点的三件事（都踩过，别再改回去）：
//   1. `exports.inject = ["slots"]` **必须写** —— 少了它：Host 照报 running，浏览器里一行不跑、零报错。
//   2. 槽位名是 `settings.section`。
//   3. 侧栏标题字段是 **`label`，而且是函数**（写 `title` 会让那一项显示成空白，能点但没名字）。
//
// 数据从宿主半来：GET /yanqing-huanqi/api/state（配置 + 实时额度账本）
//                POST /yanqing-huanqi/api/config（写，走字节级 YAML 编辑）

window.__ModuleLoader__.load({
  id: "dsh-yanqing-huanqi-panel",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react = require("react");
    var h = react.createElement;
    var useState = react.useState;
    var useEffect = react.useEffect;

    // ★★★ 2026-10-23 实机报告 E8：**不要在浏览器半写死后端端口。**
    //   DSH 的 web 端口每次启动都可能变（实测 64895 → 65070 → 54041 → 57045 → 51971），
    //   写死任何一个数字，换台机器/重启一次就连不上 —— 而界面只会显示「载入中」，不报错。
    //   正确做法：用同源相对路径，让**页面自己的 origin** 决定后端地址。
    //   （本页是 DSH 设置面板，由后端同一个 webServer 提供，所以同源一定对。）
    //   如果以后真出现非同源的桌面壳，必须由宿主注入地址，不能由客户端猜。
    var API = "/yanqing-huanqi/api";

    var S = {
      wrap: { padding: "4px 2px 20px", fontSize: "13px", lineHeight: 1.65 },
      card: { border: "1px solid var(--dsh-border, rgba(128,128,128,.25))", borderRadius: "10px", padding: "14px 16px", marginBottom: "14px" },
      h: { fontSize: "13px", fontWeight: 600, margin: "0 0 10px" },
      row: { display: "flex", alignItems: "center", gap: "10px", marginBottom: "12px" },
      label: { flex: "0 0 150px", opacity: 0.85 },
      num: { width: "110px", padding: "4px 8px", borderRadius: "6px", border: "1px solid var(--dsh-border, rgba(128,128,128,.35))", background: "transparent", color: "inherit", fontSize: "13px" },
      path: { flex: "1", padding: "4px 8px", borderRadius: "6px", border: "1px solid var(--dsh-border, rgba(128,128,128,.35))", background: "transparent", color: "inherit", fontSize: "12px", fontFamily: "Consolas, monospace" },
      btn: { padding: "5px 12px", borderRadius: "7px", border: "1px solid var(--dsh-border, rgba(128,128,128,.35))", background: "transparent", color: "inherit", cursor: "pointer", fontSize: "12.5px" },
      btnMain: { padding: "6px 16px", borderRadius: "7px", border: "1px solid transparent", background: "var(--dsh-accent, #4a7dff)", color: "#fff", cursor: "pointer", fontSize: "13px", fontWeight: 500 },
      note: { fontSize: "11.5px", opacity: 0.62, marginTop: "-6px", marginBottom: "12px", paddingLeft: "160px" },
      ok: { color: "#3fa66a" }, bad: { color: "#d9534f" },
      gauge: { height: "8px", borderRadius: "5px", background: "rgba(128,128,128,.22)", overflow: "hidden", flex: "1", maxWidth: "260px" },
      gaugeFill: { height: "100%", borderRadius: "5px" },
      kv: { display: "flex", gap: "18px", flexWrap: "wrap", fontSize: "12.5px", opacity: 0.85 }
    };

    function Panel() {
      var [state, setState] = useState(null);
      var [form, setForm] = useState({});
      var [msg, setMsg] = useState(null);
      var [busy, setBusy] = useState(false);
      var [alsoWeb, setAlsoWeb] = useState(false);
      /** 「恢复额度」要恢复到几点。默认给满 —— 那是这个按钮最常被按的理由。 */
      var [giveTo, setGiveTo] = useState(6);

      function load() {
        setBusy(true); setMsg(null);
        fetch(API + "/state", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (d) {
          if (!d.ok) { setMsg({ bad: true, text: "读不到：" + (d.message || "未知") }); return; }
          setState(d);
          var vals = {};
          (d.fields || []).forEach(function (f) {
            var raw = d.profiles && d.profiles.desktop && d.profiles.desktop.values ? d.profiles.desktop.values[f.key] : undefined;
            // ★ enum 的 def 是字符串（如 'strict'），留空时也要显示默认档，
            //   不能像 str 那样显示空 —— 否则用户看不出现在是哪一档。
            vals[f.key] = raw === undefined || raw === ""
              ? (f.type === "int" ? Number(f.def) : String(f.def == null ? "" : f.def))
              : (f.type === "int" ? Number(raw) : String(raw));
          });
          setForm(vals);
        }).catch(function (e) {
          setMsg({ bad: true, text: "请求失败（宿主半没起来？）：" + e.message });
        }).then(function () { setBusy(false); });
      }
      useEffect(function () { load(); }, []);

      function save() {
        setBusy(true); setMsg(null);
        var profiles = alsoWeb ? ["desktop", "web"] : ["desktop"];
        fetch(API + "/config", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ profiles: profiles, values: form })
        }).then(function (r) { return r.json(); }).then(function (d) {
          if (d.ok) {
            var n = (d.results || []).reduce(function (a, x) { return a + ((x.changes || []).length); }, 0);
            setMsg({ text: n ? ("已写入 " + n + " 处改动 —— **重启 DSH 后生效**。改前的文件已自动备份。") : "值没变，没写盘。" });
            load();
          } else {
            setMsg({ bad: true, text: "写入失败：" + JSON.stringify((d.results || []).map(function (x) { return x.message; })) });
          }
        }).catch(function (e) { setMsg({ bad: true, text: "写入失败：" + e.message }); })
          .then(function () { setBusy(false); });
      }

      // ── 恢复额度：手动给换气加命（两条恢复机制里的第二条）──────────────────
      // ★ 写的是账本文件的 credit 字段 —— 那条"自然恢复"是攒够正常轮数 +1，
      //   这一条是人给的。宿主半写完会回读校验，因为换气可能在同一瞬间 save()
      //   把内存里的旧值覆盖回去（那个竞态是真的，只是窗口很小）。
      function giveCredit() {
        var want = Number(giveTo);
        if (!isFinite(want) || want < 0) { setMsg({ bad: true, text: "要恢复到的额度得是不小于 0 的数字。" }); return; }
        setBusy(true); setMsg(null);
        fetch(API + "/credit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ credit: want })
        }).then(function (r) { return r.json(); }).then(function (d) {
          if (!d.ok) { setMsg({ bad: true, text: "恢复失败：" + (d.message || "未知") }); return; }
          setMsg({
            text: "额度 " + d.before + " → " + d.credit + "（上限 " + d.creditMax + "）。"
              + (d.hot ? "已生效，不用重启。" : "★ 账本已写，但热重载补丁没装/没加载 —— 要重启 DSH 才生效。")
          });
          load();
        }).catch(function (e) { setMsg({ bad: true, text: "请求失败：" + e.message }); })
          .then(function () { setBusy(false); });
      }

      if (!state) return h("div", { style: S.wrap }, busy ? "正在读取换气配置…" : "（没有数据）");

      var led = state.ledger || {};
      var pct = led.ratio == null ? 0 : Math.max(0, Math.min(1, led.ratio)) * 100;
      var ledColor = pct > 60 ? "#3fa66a" : (pct > 25 ? "#d9a441" : "#d9534f");
      var dp = state.profiles && state.profiles.desktop ? state.profiles.desktop : {};
      // ★ E3/E4：宿主半会带回「路径是怎么定下来的 / 找不到时下一步做什么」。
      //   「这一项是空的」必须能解释成一句话，而不是让人对着空面板猜。
      var homeInfo = state.home || {};
      var hintText = homeInfo.hint || (state.profilesInfo && state.profilesInfo.hint) || "";

      return h("div", { style: S.wrap },

        msg ? h("div", { style: { marginBottom: "12px", color: msg.bad ? S.bad.color : S.ok.color } }, msg.text) : null,
        hintText ? h("div", { style: { marginBottom: "12px", color: S.bad.color, fontSize: "12px" } }, "⚠ " + hintText) : null,

        // ---------- 实时额度 ----------
        h("div", { style: S.card },
          h("div", { style: S.h }, "实时额度"),
          led.exists ? h("div", null,
            h("div", { style: S.row },
              h("span", { style: S.label }, "延续额度"),
              h("span", { style: { fontVariantNumeric: "tabular-nums", minWidth: "58px" } }, (led.credit == null ? "?" : led.credit) + " / " + (led.creditMax == null ? "?" : led.creditMax)),
              h("div", { style: S.gauge }, h("div", { style: Object.assign({}, S.gaugeFill, { width: pct + "%", background: ledColor }) })),
              h("span", { style: { opacity: 0.6, fontSize: "12px" } }, pct.toFixed(0) + "%")
            ),
            h("div", { style: S.kv },
              h("span", null, "累计延续 " + ((led.stats && led.stats.continuations) || 0) + " 次"),
              h("span", null, "熔断 " + ((led.stats && led.stats.circuitBreaks) || 0) + " 次"),
              h("span", null, "异常 " + ((led.stats && led.stats.anomalies) || 0) + " 次"),
              h("span", null, "正常轮 " + (led.normalTurns == null ? "?" : led.normalTurns) + " / " + (form.normalTurnThreshold || 20) + " 涨 1 点")
            ),
            // ★ 恢复额度的第二条路：人给的。上面那条"正常轮攒额度"是自然恢复。
            h("div", { style: Object.assign({}, S.row, { marginTop: "12px", paddingTop: "12px", borderTop: "1px solid var(--dsh-border, rgba(128,128,128,.18))" }) },
              h("span", { style: S.label }, "手动恢复额度"),
              h("input", {
                type: "number", min: 0, max: 99, style: S.num, value: giveTo,
                onChange: function (e) { setGiveTo(e.target.value); }
              }),
              h("button", { style: S.btnMain, disabled: busy, onClick: giveCredit }, busy ? "…" : "恢复额度"),
              h("span", { style: { opacity: 0.55, fontSize: "11.5px" } }, "写账本文件；装了热重载补丁就不必重启")
            ),
            h("div", { style: S.note }, "账本：" + led.path + "（换气每次出手都会重写它，所以这里是实时的）")
          ) : h("div", { style: S.note },
            "账本文件还不存在（" + (led.path || "?") + "）—— 换气还没出过手（正常），或者它在别处。"
            + (led.hint ? "　" + led.hint : "")
          )
        ),

        // ---------- 参数 ----------
        h("div", { style: S.card },
          h("div", { style: S.h }, "参数"),
          (state.fields || []).map(function (f) {
            return h("div", { key: f.key },
              h("div", { style: S.row },
                h("span", { style: S.label }, f.label),
                f.type === "int"
                  ? h("input", {
                      type: "number", style: S.num, min: f.min, max: f.max, value: form[f.key],
                      onChange: function (e) { var v = {}; v[f.key] = e.target.value; setForm(Object.assign({}, form, v)); }
                    })
                : f.type === "enum"
                  ? h("select", {
                      style: S.path, value: form[f.key] == null ? f.def : form[f.key],
                      onChange: function (e) { var v = {}; v[f.key] = e.target.value; setForm(Object.assign({}, form, v)); }
                    }, (f.options || []).map(function (o) {
                      return h("option", { key: o.value, value: o.value }, o.label);
                    }))
                  : h("input", {
                      style: S.path, value: form[f.key] == null ? "" : form[f.key], placeholder: "（留空 = 用默认）",
                      onChange: function (e) { var v = {}; v[f.key] = e.target.value; setForm(Object.assign({}, form, v)); }
                    }),
                h("span", { style: { opacity: 0.55, fontSize: "11.5px" } }, f.key)
              ),
              h("div", { style: S.note }, f.hint + (f.min != null ? "　范围 " + f.min + " ~ " + f.max : ""))
            );
          })
        ),

        // ---------- 保存 ----------
        h("div", { style: { display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" } },
          h("button", { style: S.btnMain, disabled: busy, onClick: save }, busy ? "正在保存…" : "保存"),
          h("button", { style: S.btn, disabled: busy, onClick: load }, "重新读取"),
          h("label", { style: { display: "flex", alignItems: "center", gap: "6px", cursor: "pointer", fontSize: "12.5px", opacity: 0.85 } },
            h("input", { type: "checkbox", checked: alsoWeb, onChange: function (e) { setAlsoWeb(e.target.checked); } }),
            "同时改 web 备用通道"
          )
        ),
        h("div", { style: { marginTop: "12px", fontSize: "12px", opacity: 0.7 } },
          "改的是 ", h("code", null, dp.path || "?"),
          " 里 ", h("code", null, "- id: huanqi"), " 那一段 —— **只替换该动的行，文件其余字节原样保留**（注释和 !!js 都在）。",
          h("br"),
          "★ 默认只改 desktop：web 那份是备用通道（12 你定的「不动它，它很稳定，免得桌面端崩了没得修」）。"
        )
      );
    }

    function apply(ctx) {
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          { name: "settings.section", id: "agent-huanqi", order: 64, label: () => "换气" },
          () => h(Panel)
        )
      );
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});
