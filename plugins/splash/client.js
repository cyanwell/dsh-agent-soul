// dsh-agent-splash · 客户端半（浏览器里那一页）
//
// 挂到 DSH 设置面板的 `settings.section` 槽位 —— 和「皮肤」「宠物」并列。
//
// ★★★ 一条致命且零报错的坑：`exports.inject = ["slots"]` 必须写。
//   少了它，Host 照报 running、侧边栏计数照报，而**浏览器里一行都不执行、控制台一个错都没有**。
//   （Cordis 靠这个数组知道"本插件在等 slots 服务"，等就绪后再注入。）
//
// 数据都从宿主半的 HTTP 路由来（见 index.js）：
//   GET  /agent-splash/api/config    读配置
//   POST /agent-splash/api/config    写配置
//   GET  /agent-splash/api/files     列候选动画
//   GET  /agent-splash/api/preview?p= 预览（代理本地文件，支持 Range）
//
// ★ 预览为什么不能直接 <video src="file:///...">：设置页是 http 页面，
//   浏览器不允许它读 file:// —— 所以走宿主半代理。这也是"改完就能看效果、不用重启"的关键。
//   ★ 那个 http 页面的端口由 DSH 每次启动决定（报告 E8），**这里不许写死**。

window.__ModuleLoader__.load({
  id: "dsh-agent-splash",
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
    //   preview 也走同一个 API 前缀 —— 视频地址不能另拼 origin。
    var API = "/agent-splash/api";

    function fmtBytes(n) {
      if (!n && n !== 0) return "";
      if (n < 1024) return n + " B";
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
      return (n / 1024 / 1024).toFixed(1) + " MB";
    }

    // ---------------- 样式（内联，不依赖外部 CSS） ----------------
    var S = {
      wrap: { padding: "4px 2px 20px", fontSize: "13px", lineHeight: 1.65 },
      card: { border: "1px solid var(--dsh-border, rgba(128,128,128,.25))", borderRadius: "10px", padding: "14px 16px", marginBottom: "14px" },
      h: { fontSize: "13px", fontWeight: 600, margin: "0 0 10px" },
      row: { display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px" },
      label: { flex: "0 0 118px", opacity: 0.85 },
      num: { width: "86px", padding: "4px 8px", borderRadius: "6px", border: "1px solid var(--dsh-border, rgba(128,128,128,.35))", background: "transparent", color: "inherit", fontSize: "13px" },
      range: { flex: "1", minWidth: "120px" },
      btn: { padding: "5px 12px", borderRadius: "7px", border: "1px solid var(--dsh-border, rgba(128,128,128,.35))", background: "transparent", color: "inherit", cursor: "pointer", fontSize: "12.5px" },
      btnMain: { padding: "6px 16px", borderRadius: "7px", border: "1px solid transparent", background: "var(--dsh-accent, #4a7dff)", color: "#fff", cursor: "pointer", fontSize: "13px", fontWeight: 500 },
      path: { flex: "1", padding: "4px 8px", borderRadius: "6px", border: "1px solid var(--dsh-border, rgba(128,128,128,.35))", background: "transparent", color: "inherit", fontSize: "12px", fontFamily: "Consolas, monospace" },
      list: { maxHeight: "190px", overflow: "auto", border: "1px solid var(--dsh-border, rgba(128,128,128,.25))", borderRadius: "8px" },
      item: { padding: "6px 10px", cursor: "pointer", display: "flex", justifyContent: "space-between", gap: "10px", fontSize: "12.5px" },
      note: { fontSize: "12px", opacity: 0.7, marginTop: "6px" },
      ok: { color: "#3fa66a" },
      bad: { color: "#d9534f" },
      pre: { width: "100%", maxHeight: "220px", background: "#0f1115", borderRadius: "8px", display: "block" },
      tag: { fontSize: "11px", opacity: 0.65, border: "1px solid var(--dsh-border, rgba(128,128,128,.3))", borderRadius: "5px", padding: "1px 6px" }
    };

    function Panel() {
      var [cfg, setCfg] = useState(null);
      var [cfgPath, setCfgPath] = useState("");
      var [files, setFiles] = useState([]);
      var [msg, setMsg] = useState(null);
      var [busy, setBusy] = useState(false);
      var [preview, setPreview] = useState(null);   // {path, kind}
      var [presets, setPresets] = useState([]);
      var [newName, setNewName] = useState("");

      function get(path) {
        return fetch(path, { cache: "no-store" }).then(function (r) { return r.json(); });
      }

      function load() {
        setBusy(true);
        return get(API + "/config").then(function (c) {
          if (!c.ok && c.message) setMsg({ bad: true, text: "读配置失败：" + c.message });
          else if (c.warning) setMsg({ bad: true, text: "⚠ " + c.warning });
          else if (c.bootstrapped) setMsg({ text: "首次打开：已按默认值创建配置文件（" + c.path + "），保存就写在这里。" });
          setCfgPath(c.path || "");
          setCfg(c.config);
          setPresets(Array.isArray(c.config && c.config._预设) ? c.config._预设 : []);
        }).catch(function (e) {
          setMsg({ bad: true, text: "读不到配置（后端路由没起来？）：" + e.message });
        }).then(function () {
          return get(API + "/files").then(function (f) { if (f.ok) setFiles(f.files); }).catch(function () {});
        }).then(function () { setBusy(false); });
      }
      useEffect(function () { load(); }, []);

      function save(next) {
        var body = Object.assign({}, cfg, next || {});
        setBusy(true);
        setMsg(null);
        fetch(API + "/config", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        }).then(function (r) { return r.json(); }).then(function (res) {
          if (res.ok) {
            setCfg(res.saved);
            setPresets(Array.isArray(res.saved._预设) ? res.saved._预设 : []);
            setMsg({ text: "已保存。**下次启动桌面端生效** —— 现在可以在上面预览。" });
          } else {
            setMsg({ bad: true, text: "保存失败：" + res.message });
          }
        }).catch(function (e) { setMsg({ bad: true, text: "保存失败：" + e.message }); })
          .then(function () { setBusy(false); });
      }

      function set(k, v) {
        var next = {}; next[k] = v;
        setCfg(Object.assign({}, cfg, next));
      }

      if (!cfg) return h("div", { style: S.wrap }, busy ? "正在读取启动动画配置…" : "（没有配置）");

      var previewUrl = preview ? (API + "/preview?p=" + encodeURIComponent(preview.path) + "&t=" + Date.now()) : null;

      // ---------- 多套动画（B） ----------
      function addPreset() {
        var nm = (newName || "").trim();
        if (!nm) { setMsg({ bad: true, text: "先给它起个名字" }); return; }
        var list = presets.slice();
        var i = -1;
        for (var k = 0; k < list.length; k++) if (list[k].name === nm) i = k;
        var entry = { name: nm, animation: cfg.animation, note: "" };
        if (i >= 0) list[i] = entry; else list.push(entry);
        setNewName("");
        save({ _预设: list });
      }
      function applyPreset(p) {
        set("animation", p.animation);
        setMsg({ text: "已选「" + p.name + "」—— 记得点保存。" });
      }
      function delPreset(p) {
        var list = presets.filter(function (x) { return x.name !== p.name; });
        save({ _预设: list });
      }

      return h("div", { style: S.wrap },

        // ============ 状态条 ============
        msg ? h("div", { style: { marginBottom: "12px", color: msg.bad ? S.bad.color : S.ok.color } }, msg.text) : null,

        // ============ ① 开关 ============
        h("div", { style: S.card },
          h("div", { style: S.h }, "启动动画"),
          h("div", { style: S.row },
            h("label", { style: { display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" } },
              h("input", {
                type: "checkbox", checked: cfg.enabled !== false,
                onChange: function (e) { save({ enabled: e.target.checked }); }
              }),
              "显示启动动画"
            )
          ),
          h("div", { style: S.note }, "关掉它，双击图标后会直接进主界面。（这一条永远留着 —— 万一动画出问题，关掉就行，不用修 asar）")
        ),

        // ============ ② 动画源 + 预览 ============
        h("div", { style: S.card },
          h("div", { style: S.h }, "动画"),
          h("div", { style: S.row },
            h("span", { style: S.label }, "当前"),
            h("input", { style: S.path, value: cfg.animation || "", onChange: function (e) { set("animation", e.target.value); } }),
            h("button", { style: S.btn, disabled: busy, onClick: function () { save(); } }, "保存")
          ),

          files.length ? h("div", { style: { marginTop: "6px" } },
            h("div", { style: { fontSize: "12px", opacity: 0.75, marginBottom: "5px" } }, "找到这些可以用（点一下预览，双击选中）："),
            h("div", { style: S.list },
              files.map(function (f, idx) {
                var on = f.path === cfg.animation;
                return h("div", {
                  key: idx,
                  style: Object.assign({}, S.item, on ? { background: "rgba(74,125,255,.14)" } : null),
                  onClick: function () { setPreview({ path: f.path, kind: f.kind }); },
                  onDoubleClick: function () { set("animation", f.path); setPreview({ path: f.path, kind: f.kind }); }
                },
                  h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, f.name),
                  h("span", { style: { display: "flex", gap: "8px", alignItems: "center", flex: "0 0 auto" } },
                    h("span", { style: S.tag }, f.kind),
                    h("span", { style: { opacity: 0.6 } }, fmtBytes(f.bytes)),
                    on ? h("span", { style: { color: S.ok.color } }, "✓ 当前") : null
                  )
                );
              })
            )
          ) : h("div", { style: S.note }, "（在允许的目录里没找到视频/图片。支持的格式：mp4 / webm / mov / png / jpg / gif / webp）"),

          preview ? h("div", { style: { marginTop: "12px" } },
            h("div", { style: { fontSize: "12px", opacity: 0.75, marginBottom: "6px" } },
              "预览：" + preview.path.split("/").pop(),
              h("button", { style: Object.assign({}, S.btn, { marginLeft: "10px" }), onClick: function () { setPreview(null); } }, "关掉")
            ),
            preview.kind === "video"
              ? h("video", { style: S.pre, src: previewUrl, controls: true, autoPlay: true, muted: true, loop: true })
              : h("img", { style: S.pre, src: previewUrl, alt: "预览" }),
            h("div", { style: S.note }, "这是真文件，播起来什么样，启动时就是什么样。")
          ) : null
        ),

        // ============ ③ 多套动画（B） ============
        h("div", { style: S.card },
          h("div", { style: S.h }, "多套动画"),
          presets.length ? h("div", { style: S.list },
            presets.map(function (p, idx) {
              var on = p.animation === cfg.animation;
              return h("div", { key: idx, style: Object.assign({}, S.item, on ? { background: "rgba(74,125,255,.14)" } : null) },
                h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, p.name),
                h("span", { style: { display: "flex", gap: "6px" } },
                  h("button", { style: S.btn, onClick: function () { applyPreset(p); } }, on ? "✓ 在用" : "用它"),
                  h("button", { style: S.btn, onClick: function () { delPreset(p); } }, "删")
                )
              );
            })
          ) : h("div", { style: S.note }, "还没存过。把上面「当前」那栏填好、预览满意，再起个名字存下来 —— 以后一键切。"),
          h("div", { style: S.row },
            h("input", {
              style: S.path, placeholder: "给这套动画起个名字（例如：她看向你）",
              value: newName, onChange: function (e) { setNewName(e.target.value); }
            }),
            h("button", { style: S.btn, disabled: busy, onClick: addPreset }, "存成一套")
          )
        ),

        // ============ ④ 时间 ============
        h("div", { style: S.card },
          h("div", { style: S.h }, "时间"),
          h("div", { style: S.row },
            h("span", { style: S.label }, "淡入"),
            h("input", { type: "range", min: 0, max: 3000, step: 100, style: S.range, value: cfg.fadeInMs || 0, onChange: function (e) { set("fadeInMs", +e.target.value); } }),
            h("input", { type: "number", style: S.num, value: cfg.fadeInMs || 0, onChange: function (e) { set("fadeInMs", +e.target.value); } }),
            h("span", { style: { opacity: 0.6 } }, "ms")
          ),
          h("div", { style: S.row },
            h("span", { style: S.label }, "淡出"),
            h("input", { type: "range", min: 0, max: 3000, step: 100, style: S.range, value: cfg.fadeOutMs || 0, onChange: function (e) { set("fadeOutMs", +e.target.value); } }),
            h("input", { type: "number", style: S.num, value: cfg.fadeOutMs || 0, onChange: function (e) { set("fadeOutMs", +e.target.value); } }),
            h("span", { style: { opacity: 0.6 } }, "ms")
          ),
          h("div", { style: S.row },
            h("span", { style: S.label }, "最少停留"),
            h("input", { type: "range", min: 0, max: 8000, step: 100, style: S.range, value: cfg.minVisibleMs || 0, onChange: function (e) { set("minVisibleMs", +e.target.value); } }),
            h("input", { type: "number", style: S.num, value: cfg.minVisibleMs || 0, onChange: function (e) { set("minVisibleMs", +e.target.value); } }),
            h("span", { style: { opacity: 0.6 } }, "ms")
          ),
          h("div", { style: S.note }, "「最少停留」不是让你等动画播完 —— 它是下限：主界面一出来就淡出，但至少露这么久。1.8 秒够淡入走完、也够看清开头。")
        ),

        // ============ ④·五 播放（加的个性化四项） ============
        h("div", { style: S.card },
          h("div", { style: S.h }, "播放"),
          // 播放区间
          h("div", { style: S.row },
            h("span", { style: S.label }, "播放区间"),
            h("input", { type: "number", step: "0.1", min: "0", style: S.num, value: cfg.startSec || 0, onChange: function (e) { set("startSec", +e.target.value); } }),
            h("span", { style: { opacity: 0.6 } }, "→"),
            h("input", { type: "number", step: "0.1", min: "0", style: S.num, value: cfg.endSec || 0, onChange: function (e) { set("endSec", +e.target.value); } }),
            h("span", { style: { opacity: 0.6 } }, "秒")
          ),
          // 速度
          h("div", { style: S.row },
            h("span", { style: S.label }, "播放速度"),
            h("input", { type: "range", min: 0.25, max: 3, step: 0.05, style: S.range, value: cfg.speed || 1, onChange: function (e) { set("speed", +e.target.value); } }),
            h("input", { type: "number", step: "0.05", style: S.num, value: cfg.speed || 1, onChange: function (e) { set("speed", +e.target.value); } }),
            h("span", { style: { opacity: 0.6 } }, "×")
          ),
          // 淡入淡出曲线
          h("div", { style: S.row },
            h("span", { style: S.label }, "曲线"),
            h("select", { style: S.num, value: cfg.easeIn || "ease-in-out", onChange: function (e) { set("easeIn", e.target.value); } },
              ["ease-in-out", "ease", "ease-in", "ease-out", "linear"].map(function (v) { return h("option", { key: v, value: v }, v); })
            ),
            h("span", { style: { opacity: 0.6 } }, "淡入"),
            h("select", { style: S.num, value: cfg.easeOut || "ease-in-out", onChange: function (e) { set("easeOut", e.target.value); } },
              ["ease-in-out", "ease", "ease-in", "ease-out", "linear"].map(function (v) { return h("option", { key: v, value: v }, v); })
            ),
            h("span", { style: { opacity: 0.6 } }, "淡出")
          ),
          // 底色
          h("div", { style: S.row },
            h("span", { style: S.label }, "底色"),
            h("input", { type: "color", style: { width: "46px", height: "26px", padding: "0", border: "none", background: "transparent", cursor: "pointer" }, value: cfg.bg || "#0f1115", onChange: function (e) { set("bg", e.target.value); } }),
            h("input", { style: S.path, value: cfg.bg || "#0f1115", onChange: function (e) { set("bg", e.target.value); } })
          ),
          h("div", { style: S.note }, "区间：起 0 = 从头；终 0 = 到结尾。**终点由视频自己的时长兜底**，所以填超了也不会卡住。速度 1 是原速，调小就慢放。")
        ),

        // ============ ⑤ 窗口与显示项 ============
        h("div", { style: S.card },
          h("div", { style: S.h }, "窗口与显示项"),
          h("div", { style: S.row },
            h("span", { style: S.label }, "宽 × 高"),
            h("input", { type: "number", style: S.num, value: cfg.width || 1280, onChange: function (e) { set("width", +e.target.value); } }),
            h("span", { style: { opacity: 0.6 } }, "×"),
            h("input", { type: "number", style: S.num, value: cfg.height || 720, onChange: function (e) { set("height", +e.target.value); } }),
            h("span", { style: { opacity: 0.6 } }, "px")
          ),
          h("div", { style: S.row },
            h("span", { style: S.label }, "填充方式"),
            h("select", {
              style: S.num, value: cfg.fit || "cover",
              onChange: function (e) { set("fit", e.target.value); }
            },
              h("option", { value: "cover" }, "铺满（裁边）"),
              h("option", { value: "contain" }, "完整（留黑边）")
            )
          ),
          h("div", { style: S.row },
            h("label", { style: { display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" } },
              h("input", { type: "checkbox", checked: cfg.showHud !== false, onChange: function (e) { set("showHud", e.target.checked); } }),
              "显示右下角加载项"
            )
          ),
          h("div", { style: S.row },
            h("label", { style: { display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" } },
              h("input", { type: "checkbox", checked: cfg.showProgress !== false, onChange: function (e) { set("showProgress", e.target.checked); } }),
              "显示进度条"
            )
          ),
          h("div", { style: S.row },
            h("span", { style: S.label }, "加载文案"),
            h("input", {
              style: S.path,
              value: (cfg.stages || []).join(" | "),
              onChange: function (e) { set("stages", e.target.value.split("|").map(function (s) { return s.trim(); }).filter(Boolean)); }
            })
          ),
          h("div", { style: S.note }, "文案用 | 分开，会随时间依次出现；最后后端起来了会变成「就绪」。")
        ),

        // ============ 保存 ============
        h("div", { style: { display: "flex", gap: "10px", alignItems: "center" } },
          h("button", { style: S.btnMain, disabled: busy, onClick: function () { save(); } }, busy ? "正在保存…" : "保存设置"),
          h("button", { style: S.btn, disabled: busy, onClick: load }, "重新读取"),
          h("span", { style: { fontSize: "12px", opacity: 0.65 } }, "改完保存，下次启动桌面端生效。")
        ),

        h("div", { style: { marginTop: "16px", fontSize: "11.5px", opacity: 0.55 } },
          "配置在 " + (cfgPath || "（路径由宿主半返回）") + " · 动画文件放在 "
          + (files.length ? "上面列出的允许目录" : "DSH 家目录或其同级 dsh-desktop 目录（找不到时设 SPLASH_DIR 指过去）")
          + " 里即可被这里找到"
        )
      );
    }

    function apply(ctx) {
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          // ★ 修：设置页那一栏的标题字段是 **`label`**（而且是个函数），
          //   不是 `title` —— 写成 title 的后果是：那一项**在侧栏里显示为空白**（能点、但没名字）。
          //   抄自 dsh-pet：`label: () => ctx.locale.bind("pet")("settings.title")`；
          //   我们不需要 i18n，直接返回字符串即可。
          { name: "settings.section", id: "agent-splash", order: 62, label: () => "启动动画" },
          () => h(Panel)
        )
      );
    }

    exports.apply = apply;
    exports.inject = ["slots"];   // ★★★ 少这一行：整包静默失效，控制台一个错都没有
    return module.exports;
  },
});
