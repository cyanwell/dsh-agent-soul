/**
 * dsh-mcp-hub — 浏览器半（第二段：管理界面）。
 *
 * 侧边栏「MCP Hub」面板，四块：
 *   ① 服务器列表：名字 / 传输 / 状态 / 工具数 / 最后错误，行内五个按钮
 *   ② 工具搜索：跨服务器按工具名 + 描述过滤，显示 mcp__<server>__<tool>
 *   ③ 添加服务器表单：serverName / transport / command / args / env / url / headers
 *   ④ 每 2 秒轮询 GET /mcp-hub/servers（不用 WebSocket）
 *
 * 状态取值的显示口径：
 *   idle=未连接 / connecting=连接中（**不是**已连上）/ ready=已连 / error=出错 / disabled=已停用
 *
 * 这个文件不是 ESM：它由 web 侧的模块加载器执行，`require("react")` 由加载器注入。
 */
window.__ModuleLoader__.load({
  id: "dsh-mcp-hub",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var useState = react.useState;
    var useEffect = react.useEffect;

    var h = react.createElement;

    var css = [
      ".mhx-wrap{font-size:12px;line-height:1.5;color:inherit;padding:2px 0;display:flex;flex-direction:column;gap:8px;}",
      ".mhx-head{display:flex;align-items:center;gap:6px;font-weight:700;font-size:11px;letter-spacing:.6px;text-transform:uppercase;opacity:.72;}",
      ".mhx-badge{margin-left:auto;font-weight:600;opacity:.8;text-transform:none;letter-spacing:0;font-variant-numeric:tabular-nums;}",
      ".mhx-sec{display:flex;flex-direction:column;gap:4px;border-top:1px solid rgba(128,128,128,.22);padding-top:6px;}",
      ".mhx-sec-title{font-size:10px;letter-spacing:.5px;text-transform:uppercase;opacity:.55;}",
      ".mhx-row{display:flex;align-items:center;gap:5px;padding:2px 0;flex-wrap:wrap;}",
      ".mhx-dot{width:7px;height:7px;border-radius:50%;background:#b6bdc9;flex:none;}",
      ".mhx-dot.ready{background:#4ade80;}",
      ".mhx-dot.connecting{background:#fbbf24;animation:mhx-pulse 1.2s infinite;}",
      ".mhx-dot.error{background:#f87171;}",
      ".mhx-dot.disabled{background:#6b7280;opacity:.45;}",
      ".mhx-dot.idle{background:#94a3b8;}",
      "@keyframes mhx-pulse{0%{opacity:1}50%{opacity:.3}100%{opacity:1}}",
      ".mhx-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:120px;}",
      ".mhx-tag{font-size:10px;opacity:.6;border:1px solid rgba(128,128,128,.35);border-radius:3px;padding:0 3px;}",
      ".mhx-meta{opacity:.65;white-space:nowrap;font-variant-numeric:tabular-nums;}",
      ".mhx-err{color:#f87171;font-size:11px;word-break:break-all;padding-left:12px;}",
      ".mhx-empty{opacity:.6;}",
      ".mhx-btn{font:inherit;font-size:11px;color:inherit;background:rgba(128,128,128,.12);border:1px solid rgba(128,128,128,.35);border-radius:3px;padding:0 5px;cursor:pointer;line-height:18px;}",
      ".mhx-btn:hover{background:rgba(128,128,128,.24);}",
      ".mhx-btn:disabled{opacity:.4;cursor:default;}",
      ".mhx-btn.danger{color:#f87171;border-color:rgba(248,113,113,.5);}",
      ".mhx-input{font:inherit;font-size:11px;color:inherit;background:rgba(128,128,128,.10);border:1px solid rgba(128,128,128,.35);border-radius:3px;padding:2px 5px;width:100%;box-sizing:border-box;}",
      ".mhx-form{display:flex;flex-direction:column;gap:4px;}",
      ".mhx-field{display:flex;flex-direction:column;gap:1px;}",
      ".mhx-label{font-size:10px;opacity:.6;}",
      ".mhx-search-result{display:flex;flex-direction:column;gap:1px;padding:2px 0;}",
      ".mhx-toolname{font-family:ui-monospace,Consolas,monospace;font-size:11px;word-break:break-all;}",
      ".mhx-tool-desc{font-size:11px;opacity:.62;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      ".mhx-actions{display:flex;gap:3px;margin-left:auto;}",
      ".mhx-foot{font-size:10px;opacity:.42;word-break:break-all;}",
      ".mhx-notice{font-size:11px;color:#fbbf24;}",
    ].join("\n");

    var styleTag = document.createElement("style");
    styleTag.textContent = css;
    document.head.appendChild(styleTag);

    function api(path, opts) {
      opts = opts || {};
      var init = {
        method: opts.method || "GET",
        headers: { "content-type": "application/json", accept: "application/json" },
      };
      if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
      return fetch("/mcp-hub" + path, init).then(function (r) {
        return r
          .json()
          .catch(function () {
            return {};
          })
          .then(function (body) {
            if (!r.ok || body.ok === false) {
              throw new Error(body.error || "HTTP " + r.status);
            }
            return body;
          });
      });
    }

    var STATUS_TEXT = {
      idle: "未连接",
      connecting: "连接中",
      ready: "已连",
      error: "出错",
      disabled: "已停用",
    };

    function statusText(s) {
      return STATUS_TEXT[s] || s || "未知";
    }

    function Dot(props) {
      return h("span", { className: "mhx-dot " + (props.status || "idle"), title: statusText(props.status) });
    }

    /* ── 服务器行 ─────────────────────────────────────────── */

    function ServerRow(props) {
      var s = props.server;
      var busy = props.busy;
      var pendingDelete = props.pendingDelete;
      var act = props.onAction;

      var connected = s.status === "ready";
      var working = s.status === "connecting";
      var buttons = [];

      if (!connected && !working) {
        buttons.push(
          h(
            "button",
            {
              key: "c",
              className: "mhx-btn",
              disabled: busy,
              title: "连接这台服务器",
              onClick: function () {
                act(s.serverName, "connect");
              },
            },
            "连接"
          )
        );
      }
      if (connected || working) {
        buttons.push(
          h(
            "button",
            {
              key: "d",
              className: "mhx-btn",
              disabled: busy,
              title: "断开这台服务器（先注销工具，再关传输）",
              onClick: function () {
                act(s.serverName, "disconnect");
              },
            },
            "断开"
          )
        );
      }
      buttons.push(
        h(
          "button",
          {
            key: "e",
            className: "mhx-btn",
            disabled: busy,
            title: s.enabled ? "停用：不再自动连接" : "启用：下次启动自动连接",
            onClick: function () {
              act(s.serverName, s.enabled ? "disable" : "enable");
            },
          },
          s.enabled ? "停用" : "启用"
        )
      );
      buttons.push(
        h(
          "button",
          {
            key: "x",
            className: "mhx-btn danger",
            disabled: busy,
            title: "先断开、注销工具，再从清单删除",
            onClick: function () {
              act(s.serverName, "delete");
            },
          },
          pendingDelete ? "确认删除" : "删除"
        )
      );

      return h(
        "div",
        null,
        h(
          "div",
          { className: "mhx-row", title: s.error || s.serverName },
          h(Dot, { status: s.status }),
          h("span", { className: "mhx-name" }, s.serverName),
          h("span", { className: "mhx-tag" }, s.transport === "streamable-http" ? "http" : "stdio"),
          h(
            "span",
            { className: "mhx-meta" },
            statusText(s.status) + " · " + (s.toolCount || 0) + " tools"
          ),
          h("span", { className: "mhx-actions" }, buttons)
        ),
        s.error ? h("div", { className: "mhx-err" }, s.error) : null,
        !s.enabled ? h("div", { className: "mhx-err", style: { color: "inherit", opacity: 0.5 } }, "已停用，不会自动连接") : null
      );
    }

    /* ── 工具搜索 ─────────────────────────────────────────── */

    function ToolSearch(props) {
      var q = props.q;
      var results = props.results;
      var error = props.error;
      return h(
        "div",
        { className: "mhx-sec" },
        h("div", { className: "mhx-sec-title" }, "工具搜索"),
        h("input", {
          className: "mhx-input",
          type: "search",
          placeholder: "按工具名或描述过滤（跨所有已连接服务器）",
          value: q,
          onChange: function (e) {
            props.onChange(e.target.value);
          },
        }),
        error ? h("div", { className: "mhx-err" }, error) : null,
        q && !results.length && !error
          ? h("div", { className: "mhx-empty" }, "没有匹配的工具")
          : null,
        results.slice(0, 50).map(function (t) {
          return h(
            "div",
            { key: t.name, className: "mhx-search-result", title: t.description || t.name },
            h("span", { className: "mhx-toolname" }, t.name),
            h(
              "span",
              { className: "mhx-tool-desc" },
              (t.description || "（无描述）").replace(/\s+/g, " ").slice(0, 160)
            )
          );
        }),
        q && results.length > 50
          ? h("div", { className: "mhx-empty" }, "只显示前 50 条，共 " + results.length + " 条")
          : null
      );
    }

    /* ── 添加表单 ─────────────────────────────────────────── */

    var EMPTY_FORM = {
      serverName: "",
      transport: "stdio",
      command: "",
      args: "",
      env: "",
      url: "",
      headers: "",
    };

    function parseArgs(text) {
      var lines = String(text || "")
        .split(/\r?\n/)
        .map(function (s) {
          return s.trim();
        })
        .filter(Boolean);
      if (lines.length > 1) return lines;
      if (lines.length === 1) return lines[0].split(/\s+/).filter(Boolean);
      return [];
    }

    function parsePairs(text, separator) {
      var out = {};
      String(text || "")
        .split(/\r?\n/)
        .forEach(function (line) {
          var s = line.trim();
          if (!s || s.charAt(0) === "#") return;
          var idx = s.indexOf(separator);
          if (idx <= 0) return;
          var k = s.slice(0, idx).trim();
          var v = s.slice(idx + separator.length).trim();
          if (k) out[k] = v;
        });
      return out;
    }

    function Field(props) {
      return h(
        "label",
        { className: "mhx-field" },
        h("span", { className: "mhx-label" }, props.label),
        props.children
      );
    }

    function AddForm(props) {
      var form = props.form;
      var set = props.set;
      var submit = props.submit;
      var busy = props.busy;
      var error = props.error;

      var bind = function (key) {
        return {
          className: "mhx-input",
          value: form[key],
          onChange: function (e) {
            var patch = {};
            patch[key] = e.target.value;
            set(patch);
          },
        };
      };

      return h(
        "div",
        { className: "mhx-sec" },
        h("div", { className: "mhx-sec-title" }, "添加服务器"),
        h(
          "div",
          { className: "mhx-form" },
          h(Field, { label: "serverName（工具名 namespace，[A-Za-z0-9_-]{1,32}）" },
            h("input", Object.assign({ placeholder: "例如 filesystem" }, bind("serverName")))),
          h(Field, { label: "transport" },
            h(
              "select",
              {
                className: "mhx-input",
                value: form.transport,
                onChange: function (e) {
                  set({ transport: e.target.value });
                },
              },
              h("option", { value: "stdio" }, "stdio"),
              h("option", { value: "streamable-http" }, "streamable-http")
            )),
          form.transport === "stdio"
            ? h(Field, { label: "command" }, h("input", Object.assign({ placeholder: "可执行文件绝对路径" }, bind("command"))))
            : null,
          form.transport === "stdio"
            ? h(Field, { label: "args（每行一个；单行时按空格拆）" },
              h("textarea", Object.assign({ className: "mhx-input", rows: 3 }, bind("args"))))
            : null,
          form.transport === "stdio"
            ? h(Field, { label: "env（每行 KEY=VALUE）" },
              h("textarea", Object.assign({ className: "mhx-input", rows: 2 }, bind("env"))))
            : null,
          form.transport === "streamable-http"
            ? h(Field, { label: "url" }, h("input", Object.assign({ placeholder: "http://127.0.0.1:PORT/mcp" }, bind("url"))))
            : null,
          form.transport === "streamable-http"
            ? h(Field, { label: "headers（每行 Key: Value）" },
              h("textarea", Object.assign({ className: "mhx-input", rows: 2 }, bind("headers"))))
            : null,
          error ? h("div", { className: "mhx-err" }, error) : null,
          h(
            "div",
            { className: "mhx-row" },
            h(
              "button",
              { className: "mhx-btn", disabled: busy, onClick: submit },
              busy ? "提交中…" : "保存并连接"
            ),
            h(
              "button",
              {
                className: "mhx-btn",
                disabled: busy,
                onClick: function () {
                  props.cancel();
                },
              },
              "取消"
            ),
            h("span", { className: "mhx-meta" }, "提交后立刻写清单并尝试连接")
          )
        )
      );
    }

    /* ── 面板 ─────────────────────────────────────────────── */

    function Panel() {
      var state = useState({ servers: [], stats: null, file: null, error: null });
      var data = state[0];
      var setData = state[1];

      var qState = useState("");
      var q = qState[0];
      var setQ = qState[1];

      var toolState = useState({ results: [], error: null });
      var toolData = toolState[0];
      var setToolData = toolState[1];

      var busyState = useState({});
      var busy = busyState[0];
      var setBusy = busyState[1];

      var deleteState = useState("");
      var pendingDelete = deleteState[0];
      var setPendingDelete = deleteState[1];

      var formState = useState(null); // null = 收起；对象 = 展开
      var form = formState[0];
      var setForm = formState[1];

      var formBusyState = useState(false);
      var formBusy = formBusyState[0];
      var setFormBusy = formBusyState[1];

      var formErrState = useState(null);
      var formErr = formErrState[0];
      var setFormErr = formErrState[1];

      var numState = useState(0); // 给轮询一个"强制重取"的触发器
      var tickNo = numState[0];
      var setTickNo = numState[1];

      function load() {
        return api("/servers")
          .then(function (body) {
            setData({ servers: body.servers || [], stats: body.stats || null, file: body.file, error: null });
          })
          .catch(function (e) {
            setData(function (prev) {
              return {
                servers: prev.servers,
                stats: prev.stats,
                file: prev.file,
                error: String(e && e.message ? e.message : e),
              };
            });
          });
      }

      // 服务器列表：每 2 秒轮询（不用 WebSocket）
      useEffect(function () {
        var alive = true;
        load();
        var timer = setInterval(function () {
          if (alive) load();
        }, 2000);
        return function () {
          alive = false;
          clearInterval(timer);
        };
      }, []);

      // 工具搜索：输入 250ms 防抖 + 随轮询刷新
      useEffect(function () {
        var alive = true;
        var timer = setTimeout(function () {
          api("/tools?q=" + encodeURIComponent(q))
            .then(function (body) {
              if (!alive) return;
              setToolData({ results: body.tools || [], error: null });
            })
            .catch(function (e) {
              if (!alive) return;
              setToolData({ results: [], error: String(e && e.message ? e.message : e) });
            });
        }, 250);
        return function () {
          alive = false;
          clearTimeout(timer);
        };
      }, [q, tickNo]);

      function act(serverName, action) {
        var path;
        var method = "POST";
        var body;
        if (action === "connect") path = "/servers/" + encodeURIComponent(serverName) + "/connect";
        else if (action === "disconnect") path = "/servers/" + encodeURIComponent(serverName) + "/disconnect";
        else if (action === "enable") {
          path = "/servers/" + encodeURIComponent(serverName);
          method = "PATCH";
          body = { enabled: true };
        } else if (action === "disable") {
          path = "/servers/" + encodeURIComponent(serverName);
          method = "PATCH";
          body = { enabled: false };
        } else if (action === "delete") {
          if (pendingDelete !== serverName) {
            setPendingDelete(serverName);
            setTimeout(function () {
              setPendingDelete(function (cur) {
                return cur === serverName ? "" : cur;
              });
            }, 3000);
            return;
          }
          setPendingDelete("");
          path = "/servers/" + encodeURIComponent(serverName);
          method = "DELETE";
        }

        var patch = {};
        patch[serverName] = action;
        setBusy(function (prev) {
          var next = Object.assign({}, prev);
          next[serverName] = action;
          return next;
        });
        api(path, { method: method, body: body })
          .then(function () {
            return load();
          })
          .catch(function (e) {
            setData(function (prev) {
              return {
                servers: prev.servers,
                stats: prev.stats,
                file: prev.file,
                error: serverName + "：" + String(e && e.message ? e.message : e),
              };
            });
          })
          .then(function () {
            setBusy(function (prev) {
              var next = Object.assign({}, prev);
              delete next[serverName];
              return next;
            });
            setTickNo(function (n) {
              return n + 1;
            });
          });
      }

      function submitForm() {
        if (!form.serverName.trim()) {
          setFormErr("serverName 不能为空");
          return;
        }
        var body = {
          serverName: form.serverName.trim(),
          transport: form.transport,
          enabled: true,
        };
        if (form.transport === "stdio") {
          body.command = form.command.trim();
          body.args = parseArgs(form.args);
          body.env = parsePairs(form.env, "=");
        } else {
          body.url = form.url.trim();
          var headers = parsePairs(form.headers, ":");
          if (!Object.keys(headers).length) headers = parsePairs(form.headers, "=");
          body.headers = headers;
        }
        setFormBusy(true);
        setFormErr(null);
        api("/servers", { method: "POST", body: body })
          .then(function () {
            setForm(null);
            setForm(Object.assign({}, EMPTY_FORM));
            setFormBusy(false);
            return load();
          })
          .catch(function (e) {
            setFormBusy(false);
            setFormErr(String(e && e.message ? e.message : e));
          });
      }

      var servers = data.servers || [];
      var stats = data.stats || null;
      var totalTools = stats ? stats.tools : 0;

      var list = servers.map(function (s) {
        return h(ServerRow, {
          key: s.serverName,
          server: s,
          busy: Boolean(busy[s.serverName]),
          pendingDelete: pendingDelete === s.serverName,
          onAction: act,
        });
      });

      return h(
        "div",
        { className: "mhx-wrap" },
        h(
          "div",
          { className: "mhx-head" },
          "MCP Hub",
          h(
            "span",
            { className: "mhx-badge" },
            servers.length + " srv / " + totalTools + " tools" + (stats ? " · " + stats.connected + " 已连" : "")
          )
        ),
        data.error ? h("div", { className: "mhx-err" }, "读取失败：" + data.error) : null,

        h(
          "div",
          { className: "mhx-sec" },
          h("div", { className: "mhx-sec-title" }, "服务器"),
          servers.length ? null : h("div", { className: "mhx-empty" }, "清单为空，先在下面添加一台"),
          list
        ),

        h(ToolSearch, {
          q: q,
          results: toolData.results || [],
          error: toolData.error,
          onChange: setQ,
        }),

        form === null
          ? h(
              "div",
              { className: "mhx-sec" },
              h(
                "button",
                {
                  className: "mhx-btn",
                  onClick: function () {
                    setForm(Object.assign({}, EMPTY_FORM));
                    setFormErr(null);
                  },
                },
                "+ 添加服务器"
              )
            )
          : h(AddForm, {
              form: form,
              busy: formBusy,
              error: formErr,
              set: function (patch) {
                setForm(function (prev) {
                  return Object.assign({}, prev, patch);
                });
              },
              submit: submitForm,
              cancel: function () {
                setForm(null);
                setFormErr(null);
              },
            }),

        h("div", { className: "mhx-foot" }, "清单：" + (data.file || "(未知)") + " · 每 2s 刷新")
      );
    }

    function apply(ctx) {
      // 顶栏一格（和「日记」「回声」同一类）：conversation.view。
      // ★ 2026-10-21 改：原来是 sidebar.panellist —— 那块把侧边栏的会话列表整个挤没了，
      //   面板高度撑开会话列表，连点回对话都做不到。顶栏标签只占标题一行，点开才铺满。
      // ★★ 第二个参数必须是组件本身，不能是 function () { return h(Panel); }。
      //   槽位把第二个参数当组件来调，工厂函数返回的是 vnode，渲染时炸 —— 一个标签炸，整排顶栏一起消失。
      //   对照 dsh-riji：它传的是 View，一直正常。
      ctx.slots.inject("conversation.view", function () {
        return ctx.slots.register(
          { name: "conversation.view", id: "mcp-hub", order: 9, label: "MCP" },
          Panel
        );
      });
    }

    exports.apply = apply;
    exports.inject = ["slots"]; // ★ 少了这一行整包静默失效
    return module.exports;
  },
});
