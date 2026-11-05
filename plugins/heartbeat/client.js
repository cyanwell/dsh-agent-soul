/**
 * dsh-agent-heartbeat — browser half.
 *
 * 两处注册：
 *   ① sidebar.panellist（list）—— 侧边栏图标的画法
 *   ② main（keyed，key = 同一个 id）—— 点开后的面板内容
 *
 * 数据全走 Host 半的 /heartbeat/state；这里只负责显示。
 */
window.__ModuleLoader__.load({
  id: "dsh-agent-heartbeat",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var useState = react.useState;
    var useEffect = react.useEffect;

    var PANEL_ID = "yanqing-heartbeat";

    var CSS = [
      "/* ═══ 液态玻璃（YQ-SOFT-GLASS-V1）· 参数全部照抄回声哨兵 echo/client.js ═══ */\n",
      ".hb-wrap{\n",
      "  --ok:#34d399; --warn:#fbbf24; --error:#f87171; --pending:#60a5fa;\n",
      "  --ink:#16202c; --dim:#42536b; --faint:#5b6b80;\n",
      "  --glass:linear-gradient(148deg,rgba(255,255,255,.58),rgba(255,255,255,.30));\n",
      "  --edge:rgba(16,32,52,.09);\n",
      "  --lift:inset 0 1px 0 rgba(255,255,255,.90),inset 0 -1px 0 rgba(16,32,52,.035),0 12px 38px rgba(16,32,52,.10),0 1px 2px rgba(16,32,52,.055);\n",
      "  --code-bg:rgba(16,32,52,.06); --accent:#60a5fa;\n",
      "  --spring:cubic-bezier(.34,1.56,.64,1); --swift:cubic-bezier(.22,.61,.36,1);\n",
      "  position:relative; color:var(--ink); font-size:13px; line-height:1.65;\n",
      "  padding:16px 16px 24px; box-sizing:border-box; height:100%;\n",
      "  max-height:calc(100vh - 150px); overflow-y:auto; overflow-x:hidden;\n",
      "  min-height:0; scrollbar-width:thin;\n",
      "  background:\n",
      "    radial-gradient(1200px 480px at 10% -14%, rgba(56,132,255,.10), transparent 62%),\n",
      "    radial-gradient(900px 420px at 92% 4%, rgba(147,86,255,.08), transparent 58%),\n",
      "    radial-gradient(760px 360px at 60% 108%, rgba(52,211,153,.06), transparent 60%);\n",
      "}\n",
      ".hb-wrap[data-tone=\"dark\"]{\n",
      "  --ink:#e8eef6; --dim:#a7b6c8; --faint:#7d8da3;\n",
      "  --glass:linear-gradient(148deg,rgba(44,55,72,.52),rgba(26,33,45,.36));\n",
      "  --edge:rgba(255,255,255,.095);\n",
      "  --lift:inset 0 1px 0 rgba(255,255,255,.13),inset 0 -1px 0 rgba(0,0,0,.20),0 14px 44px rgba(0,0,0,.36),0 1px 2px rgba(0,0,0,.22);\n",
      "  --code-bg:rgba(0,0,0,.30);\n",
      "  background:\n",
      "    radial-gradient(1200px 480px at 10% -14%, rgba(56,132,255,.17), transparent 62%),\n",
      "    radial-gradient(900px 420px at 92% 4%, rgba(147,86,255,.13), transparent 58%),\n",
      "    radial-gradient(760px 360px at 60% 108%, rgba(52,211,153,.08), transparent 60%);\n",
      "}\n",
      ".hb-h{ display:flex; align-items:baseline; gap:10px; margin-bottom:10px; }\n",
      ".hb-t{ font-size:16px; font-weight:700; letter-spacing:.2px; color:var(--ink); }\n",
      ".hb-sub{ font-size:12px; color:var(--faint); }\n",
      ".hb-card{\n",
      "  position:relative; margin-top:12px; padding:13px 15px;\n",
      "  background:var(--glass); border:1px solid var(--edge); box-shadow:var(--lift);\n",
      "  border-radius:16px; overflow:hidden;\n",
      "  -webkit-backdrop-filter:blur(24px) saturate(185%); backdrop-filter:blur(24px) saturate(185%);\n",
      "  transition:transform .38s var(--spring), box-shadow .38s var(--spring);\n",
      "}\n",
      ".hb-card:hover{ transform:translateY(-1px); }\n",
      ".hb-card::after{\n",
      "  content:\"\"; position:absolute; inset:0; border-radius:inherit; pointer-events:none;\n",
      "  padding:1px;\n",
      "  background:conic-gradient(from var(--hb-a,0deg), transparent 0deg, rgba(255,255,255,.75) 26deg, rgba(160,205,255,.35) 52deg, transparent 96deg);\n",
      "  -webkit-mask:linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);\n",
      "  -webkit-mask-composite:xor;\n",
      "  mask:linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);\n",
      "  mask-composite:exclude;\n",
      "  opacity:.32; animation:hb-edge 11s linear infinite;\n",
      "}\n",
      ".hb-wrap[data-tone=\"dark\"] .hb-card::after{ opacity:.44; }\n",
      "@property --hb-a{ syntax:\"<angle>\"; initial-value:0deg; inherits:false }\n",
      "@keyframes hb-edge{ to{ --hb-a:360deg } }\n",
      ".hb-k{ font-size:11px; font-weight:700; letter-spacing:.7px; text-transform:uppercase; color:var(--faint); margin-bottom:6px; }\n",
      ".hb-v{ font-weight:600; word-break:break-word; color:var(--ink); }\n",
      ".hb-vs{ font-weight:400; font-size:12px; color:var(--faint); margin-top:3px; }\n",
      ".hb-err{ color:#b45309; font-weight:500; }\n",
      ".hb-dot{ display:inline-block; width:7px; height:7px; border-radius:50%; margin-right:6px; vertical-align:middle; }\n",
      ".hb-dot.on{ background:#16a34a; box-shadow:0 0 8px -2px #16a34a; }\n",
      ".hb-dot.off{ background:#9ca3af; }\n",
      ".hb-foot{ margin-top:14px; font-size:11px; color:var(--faint); }\n",
      ".hb-form{ margin-top:18px; border-top:1px solid var(--edge); padding-top:14px; }\n",
      ".hb-frow{ display:flex; align-items:center; gap:10px; padding:7px 0; border-bottom:1px solid var(--edge); }\n",
      ".hb-flabel{ flex:0 0 132px; font-size:12px; color:var(--dim); }\n",
      ".hb-fhint{ flex:1; font-size:11px; color:var(--faint); }\n",
      ".hb-autobar{\n",
      "  height:4px; margin-top:6px; border-radius:3px; overflow:hidden;\n",
      "  background:rgba(16,32,52,.10);\n",
      "}\n",
      ".hb-autobar-in{\n",
      "  height:100%; border-radius:3px;\n",
      "  background:linear-gradient(90deg,rgba(96,165,250,.85),rgba(52,211,153,.9));\n",
      "  transition:width .6s linear;\n",
      "}\n",
      "select.hb-fsel{\n",
      "  width:230px; padding:5px 8px; font-size:12px; border-radius:8px; color:var(--ink);\n",
      "  border:1px solid rgba(16,32,52,.20); background:rgba(255,255,255,.88); cursor:pointer;\n",
      "}\n",
      ".hb-fin{\n",
      "  width:92px; padding:5px 8px; font-size:12px; border-radius:8px; color:var(--ink);\n",
      "  border:1px solid rgba(16,32,52,.20); background:rgba(16,32,52,.075);\n",
      "  transition:box-shadow .2s var(--swift), border-color .2s var(--swift);\n",
      "}\n",
      ".hb-fin:focus{ outline:none; border-color:rgba(96,165,250,.92); box-shadow:0 0 0 3px rgba(96,165,250,.20); }\n",
      ".hb-fchk{ width:16px; height:16px; accent-color:#60a5fa; }\n",
      ".hb-btn{\n",
      "  padding:6px 14px; font-size:12px; border-radius:9px; cursor:pointer; color:var(--ink);\n",
      "  border:1px solid rgba(16,32,52,.20); background:rgba(16,32,52,.075);\n",
      "  transition:transform .22s var(--spring), box-shadow .22s var(--swift), background .18s var(--swift);\n",
      "}\n",
      ".hb-btn:hover:not(:disabled){ transform:translateY(-1px); background:rgba(16,32,52,.11); }\n",
      ".hb-btn:active:not(:disabled){ transform:translateY(0) scale(.955); }\n",
      ".hb-btn:disabled{ opacity:.45; cursor:default; }\n",
      ".hb-msg{ margin-top:10px; font-size:12px; }\n",
      ".hb-ok{ color:#15803d; }\n",
      ".hb-bad{ color:#b91c1c; }\n",
      ".hb-run{ margin-top:12px; }\n",
      ".hb-hist{ margin-top:12px; }\n",
      ".hb-hrow{ display:flex; align-items:center; gap:9px; padding:5px 0; font-size:12px; border-bottom:1px solid var(--edge); }\n",
      ".hb-ht{ flex:0 0 96px; color:var(--faint); font-variant-numeric:tabular-nums; }\n",
      ".hb-htag{ flex:0 0 auto; font-size:10px; padding:1px 6px; border-radius:5px; background:rgba(16,32,52,.045); border:1px solid rgba(16,32,52,.10); color:var(--dim); }\n",
      ".hb-hres{ flex:1; color:var(--dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }\n",
      ".hb-stats{ margin-top:10px; font-size:12px; color:var(--dim); }\n",
      ".hb-alarm{ margin-top:12px; border-radius:12px; padding:10px 13px; background:rgba(251,191,36,.13); border:1px solid rgba(251,191,36,.45); }\n",
      ".hb-alarm-h{ font-size:12px; font-weight:700; color:#92400e; margin-bottom:4px; }\n",
      ".hb-alarm-i{ font-size:11.5px; color:#78350f; }\n",
      "@media (prefers-reduced-motion: reduce){\n",
      "  .hb-card,.hb-card::after,.hb-btn{ animation:none !important; transition:none !important }\n",
      "}\n",
      "/* 兜底：宿主没给 data-tone 但系统是深色时，仍给一套可读的深色 */\n",
      "@media (prefers-color-scheme: dark){\n",
      "  .hb-wrap:not([data-tone=\"light\"]){\n",
      "    --ink:#e8eef6; --dim:#a7b6c8; --faint:#7d8da3;\n",
      "    --glass:linear-gradient(148deg,rgba(44,55,72,.52),rgba(26,33,45,.36));\n",
      "    --edge:rgba(255,255,255,.095);\n",
      "    --lift:inset 0 1px 0 rgba(255,255,255,.13),inset 0 -1px 0 rgba(0,0,0,.20),0 14px 44px rgba(0,0,0,.36),0 1px 2px rgba(0,0,0,.22);\n",
      "  }\n",
      "}\n",
      "\n",
    
      // ── 预算额度可视化（2026-11-03 爀曦要：自主一轮扣一点，要看得见）──
      ".hb-bud{display:flex;align-items:center;gap:14px;flex-wrap:nowrap}\n",
      ".hb-bud-l{flex:0 0 auto}\n",
      ".hb-bud-n{font-family:Consolas,monospace;font-size:26px;font-weight:700;line-height:1;color:#7fe0c8}\n",
      ".hb-bud-n.warn{color:#ffb45c}\n",
      ".hb-bud-n.empty{color:#ff8b8b}\n",
      ".hb-bud-k{font-size:9.5px;letter-spacing:.8px;color:#8899ad;margin-top:3px;text-transform:uppercase}\n",
      ".hb-dots{display:flex;gap:5px;align-items:center}\n",
      ".hb-dot{width:13px;height:13px;border-radius:4px;background:rgba(127,224,200,.85);box-shadow:0 0 8px rgba(127,224,200,.55),inset 0 1px 0 rgba(255,255,255,.5)}\n",
      ".hb-dot.used{background:rgba(255,255,255,.10);box-shadow:inset 0 1px 0 rgba(255,255,255,.12);position:relative}\n",
      ".hb-dot.used::after{content:'';position:absolute;inset:5px;border-radius:2px;background:rgba(255,139,139,.5)}\n",
      ".hb-bud-m{flex:1;min-width:0;font-size:11px;color:#9fb0c4;line-height:1.65}\n",
      ".hb-bud-m b{color:#dfe9f5;font-weight:600}\n",
      ".hb-bud-bar{height:4px;border-radius:3px;background:rgba(255,255,255,.08);overflow:hidden;margin-top:6px}\n",
      ".hb-bud-bar i{display:block;height:100%;border-radius:3px;background:linear-gradient(90deg,#7fe0c8,#5fbfa8);transition:width .5s ease}\n",

      // ── 设置表单分组（2026-11-03 爀曦：设置界面要美化）──
      ".hb-form{max-height:70vh;overflow-y:auto;padding-right:4px}\n",
      ".hb-form::-webkit-scrollbar{width:7px}\n",
      ".hb-form::-webkit-scrollbar-thumb{background:rgba(120,140,170,.28);border-radius:4px;border:2px solid transparent;background-clip:content-box}\n",
      ".hb-fgrp{margin:14px 0 4px}\n",
      ".hb-fgrp-h{display:flex;align-items:baseline;gap:9px;padding:0 0 7px;border-bottom:1px solid rgba(120,140,170,.18);margin-bottom:6px}\n",
      ".hb-fgrp-t{font-size:12px;font-weight:700;letter-spacing:.6px;color:#5f7fa6}\n",
      ".hb-fgrp-d{font-size:10px;color:#98a8bc;line-height:1.4}\n",
      ".hb-frow{align-items:center;gap:12px;padding:7px 8px;border-radius:9px;transition:background .18s ease}\n",
      ".hb-frow:hover{background:rgba(120,150,190,.07)}\n",
      ".hb-flabel{flex:0 0 92px;font-size:12px;color:#354a63;font-weight:600}\n",
      ".hb-fin{flex:1 1 auto;min-width:0;background:rgba(255,255,255,.72);border:1px solid rgba(120,145,180,.30);border-radius:8px;padding:6px 10px;font-size:12px;color:#22303f;outline:none;transition:border-color .18s ease,box-shadow .18s ease,background .18s ease}\n",
      ".hb-fin:focus{border-color:rgba(90,150,230,.75);box-shadow:0 0 0 3px rgba(90,150,230,.16);background:#fff}\n",
      ".hb-fsel{appearance:none;-webkit-appearance:none;background-image:linear-gradient(45deg,transparent 50%,#7b8ea6 50%),linear-gradient(135deg,#7b8ea6 50%,transparent 50%);background-position:calc(100% - 16px) 52%,calc(100% - 11px) 52%;background-size:5px 5px,5px 5px;background-repeat:no-repeat;padding-right:30px}\n",
      ".hb-fhint{flex:0 0 188px;font-size:10px;color:#8b9cb0;line-height:1.45}\n",
      ".hb-fchk{width:17px;height:17px;accent-color:#4a86d8;cursor:pointer}\n",

      // ── 状态机卡 + 留痕时间线 + 字色自适应（2026-11-03 22:00）──
      ".hb-sc{display:flex;align-items:center;gap:13px}\n",
      ".hb-sc-dot{flex:0 0 11px;width:11px;height:11px;border-radius:50%;box-shadow:0 0 10px currentColor}\n",
      ".hb-sc-t{font-size:13px;font-weight:700;letter-spacing:.3px}\n",
      ".hb-sc-sub{font-size:10.5px;color:inherit;opacity:.66;margin-top:2px}\n",
      ".hb-sc-cd{font-family:Consolas,monospace;font-size:22px;font-weight:700;line-height:1;margin-left:auto;text-align:right}\n",
      ".hb-sc-bar{height:5px;border-radius:3px;background:rgba(120,140,170,.22);overflow:hidden;margin-top:9px}\n",
      ".hb-sc-bar i{display:block;height:100%;border-radius:3px;transition:width .5s linear}\n",
      ".hb-tl{margin-top:4px}\n",
      ".hb-tl-row{display:flex;align-items:center;gap:8px;padding:6px 7px;border-radius:8px;font-size:11px;transition:background .15s ease}\n",
      ".hb-tl-row:hover{background:rgba(120,150,190,.09)}\n",
      ".hb-tl-t{font-family:Consolas,monospace;font-size:10.5px;color:inherit;opacity:.72;flex:0 0 84px}\n",
      ".hb-tl-tag{flex:0 0 auto;font-size:9.5px;padding:1px 6px;border-radius:4px;background:rgba(90,150,230,.18);color:inherit;opacity:.9}\n",
      ".hb-tl-steps{display:flex;gap:3px;flex:0 0 auto}\n",
      ".hb-tl-sq{width:11px;height:11px;border-radius:3px;background:rgba(98,217,158,.85)}\n",
      ".hb-tl-sq.bad{background:rgba(224,106,106,.9)}\n",
      ".hb-tl-sq.skip{background:rgba(140,155,175,.35)}\n",
      ".hb-tl-ms{margin-left:auto;font-family:Consolas,monospace;font-size:10px;opacity:.6}\n",
      // ★ 字色自适应：输入控件永远是浅底，所以框内文字必须恒为深色
      ".hb-fin,.hb-fsel,.hb-fchk{color:#1e2c3d!important}\n",
      ".hb-fsel option{color:#1e2c3d;background:#ffffff}\n",
      ".hb-fgrp-t{color:#2f4c6b!important}\n",
      ".hb-fgrp-d{color:inherit!important;opacity:.62}\n",
      ".hb-flabel{color:#2a3f58!important}\n",
      ".hb-fhint{color:inherit!important;opacity:.66}\n",
      ".hb-form .hb-k{color:#2a3f58!important}\n",

      // ── 手动恢复额度按钮（2026-11-03 22:06）──
      ".hb-grant{display:flex;align-items:center;gap:10px;margin-top:9px;padding-top:9px;border-top:1px solid rgba(255,255,255,.07)}\n",
      ".hb-grant-btn{background:linear-gradient(145deg,rgba(127,224,200,.20),rgba(127,224,200,.08));border:1px solid rgba(127,224,200,.42);border-radius:9px;padding:5px 13px;font-size:11.5px;font-weight:600;color:inherit;cursor:pointer;transition:background .18s ease,box-shadow .18s ease}\n",
      ".hb-grant-btn:hover{background:linear-gradient(145deg,rgba(127,224,200,.30),rgba(127,224,200,.14));box-shadow:0 0 0 3px rgba(127,224,200,.14)}\n",
      ".hb-grant-btn.hot{border-color:rgba(232,192,105,.6);background:linear-gradient(145deg,rgba(232,192,105,.24),rgba(232,192,105,.08));box-shadow:0 0 12px rgba(232,192,105,.22)}\n",
      ".hb-grant-btn:disabled{opacity:.5;cursor:default}\n",
      ".hb-grant-tip{font-size:10px;opacity:.62;line-height:1.5}\n",

      // ── 自主账本时间线（2026-11-03 22:10）──
      ".hb-tl2-wrap{position:relative;max-height:none;overflow-y:auto}\n",
      ".hb-tl2-wrap.open{max-height:340px}\n",
      ".hb-tl2-wrap::-webkit-scrollbar{width:7px}\n",
      ".hb-tl2-wrap::-webkit-scrollbar-thumb{background:rgba(120,140,170,.28);border-radius:4px;border:2px solid transparent;background-clip:content-box}\n",
      ".hb-tl2{position:relative;display:flex;gap:11px;padding:0 0 12px 0}\n",
      ".hb-tl2::before{content:'';position:absolute;left:4px;top:13px;bottom:0;width:1px;background:rgba(120,140,170,.25)}\n",
      ".hb-tl2:last-child::before{display:none}\n",
      ".hb-tl2:last-child{padding-bottom:2px}\n",
      ".hb-tl2-dot{position:absolute;left:0;top:5px;width:9px;height:9px;border-radius:50%;background:#62d99e;box-shadow:0 0 7px rgba(98,217,158,.6)}\n",
      ".hb-tl2-dot.bad{background:#e06a6a;box-shadow:0 0 7px rgba(224,106,106,.6)}\n",
      ".hb-tl2-body{flex:1;min-width:0;padding-left:3px}\n",
      ".hb-tl2-h{display:flex;align-items:baseline;gap:8px;font-family:'system-ui','Microsoft YaHei';font-size:11.5px;flex-wrap:nowrap}\n",
      ".hb-tl2-time{font-family:Consolas,monospace;font-size:10.5px;opacity:.68;flex:0 0 auto}\n",
      ".hb-tl2-tag{font-size:9.5px;padding:0 5px;border-radius:3px;background:rgba(90,150,230,.2);flex:0 0 auto}\n",
      ".hb-tl2-t{font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n",
      ".hb-tl2-ms{font-family:Consolas,monospace;font-size:10px;opacity:.6;flex:0 0 auto}\n",
      ".hb-tl2-steps{display:flex;align-items:center;gap:7px;margin-top:4px}\n",
      ".hb-tl2-did{font-family:'system-ui','Microsoft YaHei';font-size:10px;opacity:.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n",
      ".hb-tl2-more{margin-top:8px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:4px 12px;font-size:11px;color:inherit;cursor:pointer;opacity:.85;transition:background .15s ease}\n",
      ".hb-tl2-more:hover{background:rgba(255,255,255,.12)}\n",

      // ── 动效（2026-11-03 22:13 爀曦要）──
      "@keyframes hbPulse{0%,100%{opacity:1;box-shadow:0 0 8px currentColor}50%{opacity:.55;box-shadow:0 0 16px currentColor}}\n",
      "@keyframes hbFlow{0%{background-position:0% 50%}100%{background-position:200% 50%}}\n",
      "@keyframes hbIn{from{opacity:0}to{opacity:1}}\n",
      "@keyframes hbBlink{0%,100%{opacity:.35}50%{opacity:1}}\n",
      ".hb-sc-dot{animation:hbPulse 2.4s ease-in-out infinite}\n",
      ".hb-sc-cd{transition:color .3s ease;letter-spacing:.5px}\n",
      ".hb-sc-fill{background:linear-gradient(90deg,#62d99e,#4fb98a,#62d99e);background-size:200% 100%;animation:hbFlow 3s linear infinite;transition:width .9s linear}\n",
      ".hb-sc-fill.hot{background:linear-gradient(90deg,#e8c069,#f0d98a,#e8c069);background-size:200% 100%;animation:hbFlow 2s linear infinite}\n",
      ".hb-row,.hb-card,.hb-form,.hb-hist,.hb-tl2{animation:hbIn .35s ease-out both}\n",
      ".hb-tl2-dot{animation:hbPulse 3s ease-in-out infinite}\n",
      ".hb-dot{transition:box-shadow .3s ease,background .3s ease}\n",
      ".hb-dot.used{animation:none}\n",
      ".hb-bud-bar i{background:linear-gradient(90deg,#7fe0c8,#5fbfa8,#7fe0c8);background-size:200% 100%;animation:hbFlow 3.4s linear infinite}\n",
      ".hb-grant-btn{transition:background .2s ease,box-shadow .2s ease,transform .12s ease}\n",
      ".hb-grant-btn:not(:disabled):active{transform:scale(.97)}\n",
      ".hb-tl2-more{transition:background .18s ease,opacity .18s ease}\n",
      ".hb-run:not(:disabled){animation:hbBlink 3.2s ease-in-out infinite}\n",
      "@media (prefers-reduced-motion: reduce){.hb-sc-dot,.hb-sc-fill,.hb-tl2-dot,.hb-run,.hb-bud-bar i{animation:none!important}}\n",
].join("\n");

    function useStyle() {
      // 每个插件只注入一次样式
      if (typeof document === "undefined") return;
      if (document.getElementById("hb-style")) return;
      var s = document.createElement("style");
      s.id = "hb-style";
      s.textContent = CSS;
      document.head.appendChild(s);
    }

    // ① 侧边栏图标：只画图形，不画文字
    function Icon(props) {
      useStyle();
      var _es = useState(0);
      var _evtN = _es[0], _setEvtN = _es[1];
      useEffect(function () {
        var alive = true;
        function pull() {
          fetch("/lead-waker/state", { cache: "no-store" })
            .then(function (r) { return r.json(); })
            .then(function (j) { if (alive) _setEvtN((j.counts && j.counts.badge) || 0); })
            .catch(function () {});
        }
        pull(); var _t = setInterval(pull, 20000);
        return function () { alive = false; clearInterval(_t); };
      }, []);
      var size = (props && props.size) || 20;
      var active = !!(props && props.active);
      var color = active ? "currentColor" : "currentColor";
      var op = active ? 1 : 0.62;
      var _svgEl = react.createElement("svg", {
        width: size, height: size, viewBox: "0 0 24 24",
        fill: "none", stroke: color, strokeWidth: 1.9,
        strokeLinecap: "round", strokeLinejoin: "round",
        style: { opacity: op, display: "block" },
      },
        react.createElement("path", { d: "M2 12h4l2.5-6 3 12 2.5-6h8" }),
      );
      if (!_evtN) return _svgEl;
      return react.createElement("div", { style: { position: "relative", display: "block", lineHeight: 0 } },
        _svgEl,
        react.createElement("span", { style: { position: "absolute", top: "-1px", right: "-2px", width: "7px", height: "7px", borderRadius: "50%", background: "#e8833a", boxShadow: "0 0 0 2px rgba(232,131,58,.22)" } }),
      );
    }

    function Row(label, body, sub) {
      return react.createElement("div", { className: "hb-card" },
        react.createElement("div", { className: "hb-k" }, label),
        body,
        sub ? react.createElement("div", { className: "hb-vs" }, sub) : null,
      );
    }

    // ② 面板内容
    // ===== 事件层（合并自 lead-waker 的 UI，2026-11-05 爀曦定）=====
    // ★ 只读 /lead-waker/state；判定按钮走 POST /lead-waker/decide。
    //   lead-waker 仍是独立插件 —— 这里只是把它的状态画进心跳面板，
    //   两个 host 各活各的，任一个挂了另一个照常工作。
    // ===== 事件层面板（四类视图 + 宪章判定 + 操作按钮）=====
    // 爀曦的原话："什么要你执行，什么你执行了，什么要审计但是我没有审计的，
    // 什么你自己决定做的，通过宪章了吗" —— 这四问就是下面四个分类。
    var EV_TABS = [
      { id: "act",   label: "要你执行", hint: "叫醒了但还没判定" },
      { id: "done",  label: "已执行",   hint: "判定为执行、已做完" },
      { id: "audit", label: "要审计",   hint: "悬着等爀曦拍板" },
      { id: "auto",  label: "自决",     hint: "我自己拿的主意" },
    ];

    function evCharter(c) {
      if (c === "pass")  return { t: "宪章·通过",   c: "#2f8f5b" };
      if (c === "ask")   return { t: "宪章·待问",   c: "#b58900" };
      if (c === "block") return { t: "宪章·拦截",   c: "#c1453a" };
      return { t: "宪章·未判", c: "#7a828c" };
    }

    function EventsCard() {
      var s1 = useState("act"); var tab = s1[0], setTab = s1[1];
      var s2 = useState({ data: null, err: null, busy: "" }); var st = s2[0], setSt = s2[1];

      useEffect(function () {
        var alive = true;
        function pull() {
          fetch("/lead-waker/state", { cache: "no-store" })
            .then(function (r) { return r.json(); })
            .then(function (j) { if (alive) setSt(function (o) { return { data: j, err: null, busy: o.busy }; }); })
            .catch(function (e) { if (alive) setSt(function (o) { return { data: null, err: String(e && e.message || e), busy: o.busy }; }); });
        }
        pull(); var t = setInterval(pull, 15000);
        return function () { alive = false; clearInterval(t); };
      }, []);

      function decide(key, decision) {
        setSt(function (o) { return { data: o.data, err: o.err, busy: key }; });
        fetch("/lead-waker/decide", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key: key, decision: decision, charter: "unchecked", note: "" }),
        }).then(function (r) { return r.json(); })
          .then(function () {
            return fetch("/lead-waker/state", { cache: "no-store" }).then(function (r) { return r.json(); });
          })
          .then(function (j) { setSt({ data: j, err: null, busy: "" }); })
          .catch(function (e) { setSt({ data: null, err: String(e), busy: "" }); });
      }

      if (st.err) {
        return react.createElement("div", { className: "hb-card" },
          react.createElement("div", { className: "hb-k" }, "事件层 · 分会话请求"),
          react.createElement("div", { className: "hb-vs" }, "未连上 lead-waker（不影响心跳本身）"));
      }

      var j = st.data || {};
      var counts = j.counts || {};
      var views = j.views || {};

      // 分类标签
      var tabs = react.createElement("div", { style: { display: "flex", gap: "6px", marginTop: "8px", flexWrap: "nowrap" } },
        EV_TABS.map(function (t) {
          var on = t.id === tab;
          var n = counts[t.id] || 0;
          return react.createElement("button", {
            key: t.id, type: "button", title: t.hint,
            onClick: function () { setTab(t.id); },
            style: {
              flex: "0 0 auto", cursor: "pointer", font: "inherit", fontSize: "12px",
              padding: "4px 9px", borderRadius: "7px", border: "1px solid " + (on ? "rgba(232,131,58,.55)" : "rgba(128,140,155,.28)"),
              background: on ? "rgba(232,131,58,.14)" : "transparent",
              color: on ? "#d9813c" : "inherit", opacity: on ? 1 : 0.72,
            },
          }, t.label + (n ? " " + n : ""));
        }));

      // 当前分类的条目
      var list = views[tab] || [];
      var body;
      if (!list.length) {
        body = react.createElement("div", { className: "hb-vs", style: { marginTop: "8px" } },
          tab === "act" ? "没有等你处理的事" :
          tab === "done" ? "还没有执行完的记录" :
          tab === "audit" ? "没有悬着等拍板的事" : "没有我自决的事");
      } else {
        body = react.createElement("div", { style: { marginTop: "4px" } }, list.map(function (x, i) {
          var ch = evCharter(x.charter);
          var when = String(x.t || "").slice(11, 16);
          var showBtn = tab === "act";
          return react.createElement("div", {
            key: x.key || i,
            style: { padding: "9px 0", borderTop: i ? "1px solid rgba(128,140,155,.16)" : "none" },
          },
            react.createElement("div", { style: { fontSize: "13.5px", fontWeight: 600, lineHeight: 1.5, wordBreak: "break-word" } },
              String(x.title || "(无标题)").slice(0, 80)),
            react.createElement("div", {
              style: { display: "flex", gap: "8px", alignItems: "center", marginTop: "4px", fontSize: "11.5px", opacity: 0.72, flexWrap: "nowrap", overflow: "hidden" },
            },
              react.createElement("span", null, String(x.from || "?")),
              react.createElement("span", null, when ? when : ""),
              react.createElement("span", null, "tier=" + String(x.tier || "?")),
              react.createElement("span", { style: { color: ch.c, opacity: 1 } }, ch.t),
              x.wakeCount > 1 ? react.createElement("span", null, "叫了 " + x.wakeCount + " 次") : null,
            ),
            x.note ? react.createElement("div", { style: { fontSize: "12px", opacity: 0.66, marginTop: "3px", lineHeight: 1.55 } }, String(x.note).slice(0, 140)) : null,
            showBtn ? react.createElement("div", { style: { display: "flex", gap: "6px", marginTop: "7px", flexWrap: "nowrap" } },
              ["resume", "hold", "audit"].map(function (d) {
                var label = d === "resume" ? "执行" : d === "hold" ? "搁置" : "送审";
                return react.createElement("button", {
                  key: d, type: "button", className: "hb-btn",
                  disabled: st.busy === x.key,
                  onClick: function () { decide(x.key, d); },
                  style: { fontSize: "12px", padding: "4px 10px", cursor: "pointer" },
                }, st.busy === x.key ? "…" : label);
              })
            ) : null
          );
        }));
      }

      return react.createElement("div", { className: "hb-card" },
        react.createElement("div", { className: "hb-k" },
          "事件层 · 分会话请求" + (counts.badge ? "  (" + counts.badge + " 待处理)" : "")),
        tabs,
        body);
    }

    function PanelWithEvents() {
      return react.createElement("div", null,
        react.createElement(EventsCard, null),
        react.createElement(Panel, null));
    }

    function Panel() {
      useStyle();
      var s = useState({ loading: true, data: null, err: null });
      var st = s[0]; var setSt = s[1];

      useEffect(function () {
        var alive = true;
        function pull() {
          fetch("/heartbeat/state", { cache: "no-store" })
            .then(function (r) { return r.json(); })
            .then(function (j) { if (alive) setSt({ loading: false, data: j, err: null }); })
            .catch(function (e) { if (alive) setSt({ loading: false, data: null, err: String(e && e.message || e) }); });
        }
        pull();
        var t = setInterval(pull, 15000);
        return function () { alive = false; clearInterval(t); };
      }, []);

      var head = react.createElement("div", { className: "hb-h" },
        react.createElement("div", { className: "hb-t" }, "心跳"),
        react.createElement("div", { className: "hb-sub" }, "谁在驾驶 · 上次 · 下次 · 巡视"),
      );

      if (st.loading) {
        return react.createElement("div", { className: "hb-wrap" }, head,
          react.createElement("div", { className: "hb-card" }, "读取中…"));
      }
      if (st.err) {
        return react.createElement("div", { className: "hb-wrap" }, head,
          Row("连不上 Host 半", react.createElement("div", { className: "hb-err" }, st.err)));
      }

      var d = st.data || {};
      var driver = d.driver || {};
      var beat = d.beat || {};
      var runs = d.runs || {};
      var daily = d.daily || {};
      var phase = d.phase || {};
      var next = d.next || {};

      // ★ 命题 5 的三条显示：当前状态 / 最后一次 / 下一次。
      //   原来只有「最后一次」，缺的两条现在补上。
      var phaseBody = phase.ok
        ? react.createElement("div", null,
            react.createElement("div", { className: "hb-v" },
              react.createElement("span", { className: "hb-dot" + (phase.phase === "autonomous" ? " on" : "") }),
              phase.phase === "autonomous" ? "自主中（我可以在动）"
                : phase.phase === "idle" ? "静息中（人在，不自己动）"
                : (phase.phase || "未知")),
            react.createElement("div", { className: "hb-vs" },
              "今日已跑 " + (phase.runsToday ?? "-") + " 次 · 上次结果 " + (phase.lastRunResult || "-")))
        : react.createElement("div", { className: "hb-err" }, "读不到：" + (phase.why || "未知"));

      var nextBody = next.ok
        ? react.createElement("div", null,
            react.createElement("div", { className: "hb-v" }, next.at || "（算不出）"),
            react.createElement("div", { className: "hb-vs" },
              (next.inMin != null ? next.inMin + " 分钟后 · " : "") +
              (next.enabled ? "已启用 · " : "★ 已关闭 · ") + "cron " + next.cron))
        : react.createElement("div", { className: "hb-err" }, "读不到：" + (next.why || "未知"));

      var driverBody = driver.ok
        ? react.createElement("div", null,
            react.createElement("div", { className: "hb-v" }, driver.text || "（空）"),
            react.createElement("div", { className: "hb-vs" },
              (driver.at || "") + "  ·  " + (driver.by || "")))
        : react.createElement("div", { className: "hb-err" }, "读不到：" + (driver.why || "未知"));

      var beatBody = beat.ok
        ? react.createElement("div", null,
            react.createElement("div", { className: "hb-v" },
              react.createElement("span", { className: "hb-dot on" }), beat.line || "（空行）"),
            react.createElement("div", { className: "hb-vs" },
              "共 " + beat.totalLines + " 行 · " + beat.sizeKb + " KB · 改于 " + (beat.mtime || "")))
        : react.createElement("div", { className: "hb-err" }, "读不到：" + (beat.why || "未知"));


      return react.createElement("div", { className: "hb-wrap" }, head,
        react.createElement(AlarmBar, null),
        react.createElement(StatsBar, null),

        Row("● 运行状态", react.createElement(StatusCard, { phase: phase })),
        Row("◑ 自主预算", react.createElement(BudgetBar)),
        Row("① 谁在驾驶", driverBody),
        Row("② 上次心跳", beatBody),
        Row("③ 上次运行",
          runs.ok
            ? react.createElement("div", null,
                react.createElement("div", { className: "hb-v" }, runs.lastStart),
                react.createElement("div", { className: "hb-vs" }, "共 " + runs.runsTotal + " 次 · " + (runs.lastLine || "")))
            : react.createElement("div", { className: "hb-err" }, "读不到：" + (runs.why || "未知"))),
        Row("④ 最近巡视（记账）",
          daily.ok
            ? react.createElement("div", null,
                react.createElement("div", { className: "hb-v" }, daily.headline || daily.file),
                react.createElement("div", { className: "hb-vs" },
                  daily.file + "  ·  " + daily.sizeKb + " KB  ·  共 " + daily.total + " 份报告"))
            : react.createElement("div", { className: "hb-err" }, "读不到：" + (daily.why || "未知"))),
        Row("⑤ 下一次心跳", nextBody),
        react.createElement(RunBox, null),
        react.createElement(HistoryBox, null),
        react.createElement(SettingsForm, null),
        react.createElement("div", { className: "hb-foot" },
          "每 15 秒刷新 · Host 半读《墨》/ _auto.log / schtasks"),
      );
    }


    // ★ 2026-11-03 加：设置表单（命题 5 的 9 个参数）
    //   读取走 GET /heartbeat/config，保存走 POST /heartbeat/config。
    //   保存后 Host 会回读磁盘再返回，所以这里显示的是真实落盘值。
    var FIELD_ROWS = [
      { key: "enabled",             label: "总开关",       kind: "bool", group: "core", hint: "关了就完全不自主" },
      { key: "idleThresholdMinutes",label: "静息阈值",     kind: "int",  group: "core", hint: "分钟；用户多久没动算静默" },
      { key: "cron",                label: "巡视节律",     kind: "text", group: "beat", hint: "5 段 cron，会同步计划任务" },
      { key: "maxRunsPerDay",       label: "预算上限",     kind: "int",  group: "core", hint: "每天最多跑几次" },
      { key: "graceMinutes",        label: "在场缓冲",     kind: "int",  group: "core", hint: "你停止说话后多久才开始计时（0=立刻）" },
      { key: "quietHours",          label: "安静时段",     kind: "text", group: "beat", hint: "留空=不启用；格式 23-7" },
      { key: "catchUpMissed",       label: "错过补跑",     kind: "bool", group: "beat", hint: "开机时补跑今天漏掉的点" },
      { key: "logLevel",            label: "留痕级别",     kind: "select", group: "auto",
        choices: [{ v: "full", t: "full（全量记录）" }, { v: "errors", t: "errors（只记错误）" }],
        hint: "日志详细程度" },
      { key: "auditLevel",          label: "审计档位",     kind: "select", group: "auto",
        choices: [{ v: "strict", t: "strict（每件都要问你）" }, { v: "normal", t: "normal（常规自己干）" }, { v: "loose", t: "loose（只拦硬线）" }],
        hint: "自主行动的审批粒度" },
      { key: "toolsAllowlist",      label: "巡视步骤",     kind: "text", group: "auto", hint: "逗号分隔：memindex,self,daily,doctor" },
    ];

    function SettingsForm() {
      var st = useState(null);      // 远端配置
      var msg = useState(null);     // 保存结果
      var busy = useState(false);
      var cfg = st[0], setCfg = st[1];
      var m = msg[0], setMsg = msg[1];
      var b = busy[0], setBusy = busy[1];

      function load() {
        fetch("/heartbeat/config").then(function (r) { return r.json(); })
          .then(function (j) { if (j && j.ok) setCfg(j); })
          .catch(function () {});
      }
      useEffect(function () { load(); }, []);

      function save() {
        var patch = {};
        FIELD_ROWS.forEach(function (row) {
          var v = cfg.fields && cfg.fields[row.key] ? cfg.fields[row.key].value : undefined;
          if (v === undefined) return;
          var val = v;
          if (row.kind === "int") val = Number(v);
          if (row.kind === "bool") val = !!v;
          if (row.kind === "select") val = String(v).trim().toLowerCase();
          if (row.key === "quietHours") {
            if (v === "" || v === null) val = null;
            else {
              var parts = String(v).split("-");
              val = parts.length === 2 ? [Number(parts[0]), Number(parts[1])] : null;
            }
          }
          if (row.key === "toolsAllowlist") {
            val = String(v).split(",").map(function (s) { return s.trim(); }).filter(Boolean);
          }
          patch[row.key] = val;
        });
        setBusy(true); setMsg(null);
        fetch("/heartbeat/config", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        }).then(function (r) { return r.json(); }).then(function (j) {
          setBusy(false);
          if (j && j.ok) {
            var sync = j.taskSync ? (j.taskSync.ok ? ("，计划任务已同步 " + j.taskSync.triggers + " 个触发点") : ("，但计划任务同步失败：" + j.taskSync.why)) : "";
            setMsg({ ok: true, text: "已保存" + sync });
            if (j.reread) {
              setCfg(function (old) {
                var nf = {};
                Object.keys(old.fields).forEach(function (k) {
                  nf[k] = old.fields[k];
                  if (j.reread[k] !== undefined) nf[k] = Object.assign({}, old.fields[k], { value: j.reread[k] });
                });
                return Object.assign({}, old, { fields: nf });
              });
            }
          } else {
            setMsg({ ok: false, text: "没保存：" + ((j && j.err) || "未知错误") });
          }
        }).catch(function (e) {
          setBusy(false); setMsg({ ok: false, text: "请求失败：" + String(e).slice(0, 80) });
        });
      }

      function setVal(k, v) {
        setCfg(function (old) {
          if (!old) return old;
          var nf = {};
          Object.keys(old.fields).forEach(function (key) {
            nf[key] = key === k ? Object.assign({}, old.fields[key], { value: v }) : old.fields[key];
          });
          return Object.assign({}, old, { fields: nf });
        });
      }

      if (!cfg) return react.createElement("div", { className: "hb-form" },
        react.createElement("div", { className: "hb-k" }, "⚙ 心跳设置"),
        react.createElement("div", { className: "hb-vs" }, "读不到配置接口（插件旧版本？）"));

      var GROUPS = [
        { k: "core", t: "核心", d: "自主开不开、多久算静默、每天跑几次" },
        { k: "beat", t: "节律", d: "什么时候巡视、什么时段安静" },
        { k: "auto", t: "自主行为", d: "记多细、自己干到什么程度、跑哪几步" },
      ];
      var rows = FIELD_ROWS.map(function (row) {
        var f = cfg.fields[row.key];
        if (!f) return null;
        var v = f.value;
        var ctl;
        if (row.kind === "bool") {
          ctl = react.createElement("input", {
            className: "hb-fchk", type: "checkbox", checked: !!v,
            onChange: function (e) { setVal(row.key, e.target.checked); },
          });
        } else if (row.kind === "select") {
          var opts = row.choices.map(function (c) {
            return react.createElement("option", { value: c.v, key: c.v }, c.t);
          });
          ctl = react.createElement("select", {
            className: "hb-fin hb-fsel", value: String(v == null ? "" : v),
            onChange: function (e) { setVal(row.key, e.target.value); },
          }, opts);
        } else {
          var shown = v === null ? "" : (row.key === "toolsAllowlist" ? (v || []).join(",") : String(v));
          ctl = react.createElement("input", {
            className: "hb-fin", type: "text", value: shown,
            onChange: function (e) { setVal(row.key, e.target.value); },
          });
        }
        return react.createElement("div", { className: "hb-frow", key: row.key },
          react.createElement("div", { className: "hb-flabel" }, row.label),
          ctl,
          react.createElement("div", { className: "hb-fhint" }, row.hint));
      });

      var grouped = GROUPS.map(function (g) {
        var inner = FIELD_ROWS.map(function (row, idx) {
          return row.group === g.k ? rows[idx] : null;
        });
        return react.createElement("div", { className: "hb-fgrp", key: g.k },
          react.createElement("div", { className: "hb-fgrp-h" },
            react.createElement("span", { className: "hb-fgrp-t" }, g.t),
            react.createElement("span", { className: "hb-fgrp-d" }, g.d)),
          inner);
      });

      return react.createElement("div", { className: "hb-form" },
        react.createElement("div", { className: "hb-k" }, "⚙ 心跳设置"),
        grouped,
        react.createElement("button", {
          className: "hb-btn", disabled: b, onClick: save,
        }, b ? "保存中…" : "保存"),
        m ? react.createElement("div", { className: "hb-msg " + (m.ok ? "hb-ok" : "hb-bad") }, m.text) : null);
    }


    // ★ 2026-11-03 加：手动触发（命题 4 能力层）
    //   ★★ 一条约束：手动触发仍然看总开关。关掉自主之后，按钮不该成为后门。
    function RunBox() {
      var st = useState(null);
      var busy = useState(false);
      var msg = st[0], setMsg = st[1];
      var b = busy[0], setB = busy[1];

      function run() {
        setB(true); setMsg({ ok: true, text: "正在跑四步（约 80–110 秒）…" });
        fetch("/heartbeat/run", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            setB(false);
            if (!j.ok) {
              setMsg({ ok: false, text: j.rejected || j.err || "执行失败" });
              return;
            }
            setMsg({ ok: true, text: (j.executed || "已完成") + " · 历史已更新，往下翻能看到这一条" });
          })
          .catch(function (e) { setB(false); setMsg({ ok: false, text: "请求失败：" + String(e).slice(0, 80) }); });
      }

      return react.createElement("div", { className: "hb-hist" },   // ★ 2026-11-03 修：原来是 "hb-run"+"wrap" 拼成 hb-runwrap，那个类不存在
        react.createElement("button", { className: "hb-run", disabled: b, onClick: run },
          b ? "巡视中…" : "现在跑一次"),
        msg ? react.createElement("div", { className: "hb-msg " + (msg.ok ? "hb-ok" : "hb-bad") }, msg.text) : null);
    }

    // ★ 2026-11-03 加：巡视历史
    //   和手动触发是一对：能触发却看不见结果 = 白触发。
    // ★★ 2026-11-03 22:10 自主账本：时间线式，默认 3 条、展开 10 条、可滚动。
    //   ★ 诚实的边界：history 里每一步只有「名字/成功与否/耗时」，
    //     没有那一步具体产出了什么。所以这里能说清的是「做了哪几步、各花多久、成没成」，
    //     说不出「日报写了什么」。要后者得让 host 去抓每步 stdout —— 那是另一件事。
    var STEP_CN = {
      memindex: "重建记忆索引",
      self: "装配自我层",
      daily: "写今日日报",
      doctor: "记忆库体检",
    };
    var STEP_ORDER2 = ["memindex", "self", "daily", "doctor"];
    function fmtDur(ms) {
      var s = Math.round((ms || 0) / 1000);
      if (s < 60) return s + "秒";
      return Math.floor(s / 60) + "分" + (s % 60 ? (s % 60) + "秒" : "");
    }
    function HistoryBox() {
      var st = useState(null);
      var ex = useState(false);
      var h = st[0], setH = st[1];
      var expanded = ex[0], setExpanded = ex[1];
      useEffect(function () {
        fetch("/heartbeat/history?limit=10").then(function (r) { return r.json(); })
          .then(function (j) { if (j && j.ok) setH(j); }).catch(function () {});
      }, []);
      if (!h) return null;
      if (!h.runs || !h.runs.length) {
        return react.createElement("div", { className: "hb-hist" },
          react.createElement("div", { className: "hb-k" }, "自主账本"),
          react.createElement("div", { className: "hb-vs" }, "还没有记录"));
      }
      var shown = expanded ? 10 : 3;
      var list = h.runs.slice(0, shown);
      var items = list.map(function (r, i) {
        var skipped = r.skippedByAllowlist || [];
        var byStep = {};
        (r.steps || []).forEach(function (s) {
          var k = String(s.step || "").toLowerCase();
          STEP_ORDER2.forEach(function (id) { if (k.indexOf(id) >= 0) byStep[id] = s; });
        });
        // 这一步做了什么（中文）
        var did = STEP_ORDER2.map(function (id) {
          var s = byStep[id];
          if (!s) return skipped.indexOf(id) >= 0 ? null : null;
          return STEP_CN[id] + " " + fmtDur(s.ms);
        }).filter(Boolean);
        var trig = r.trigger === "manual" ? "手动" : (r.trigger === "force" ? "强制" : "定时");
        var head = r.ok === false ? "有一环失败" : (r.ok === null ? "没跑（" + (r.phase || "?") + "）" : (did.length === 1 ? did[0].split(" ")[0] : (did.length + " 个步骤跑完")));
        var steps = STEP_ORDER2.map(function (id) {
          var s = byStep[id];
          var cls = "hb-tl-sq";
          if (!s) cls += " skip";
          else if (s.ok === false) cls += " bad";
          return react.createElement("div", {
            className: cls, key: id,
            title: (STEP_CN[id] || id) + (s ? (" · " + (s.ok ? "成功" : "失败") + " · " + fmtDur(s.ms)) : " · 未跑"),
          });
        });
        return react.createElement("div", { className: "hb-tl2", key: i, title: (r.note || "") },
          react.createElement("div", { className: "hb-tl2-dot" + (r.ok === false ? " bad" : "") }),
          react.createElement("div", { className: "hb-tl2-body" },
            react.createElement("div", { className: "hb-tl2-h" },
              react.createElement("span", { className: "hb-tl2-time" }, (r.tLocal || r.t || "").slice(5, 16)),
              react.createElement("span", { className: "hb-tl2-tag" }, trig),
              react.createElement("span", { className: "hb-tl2-t" }, head),
              react.createElement("span", { className: "hb-tl2-ms" }, fmtDur(r.ms))),
            react.createElement("div", { className: "hb-tl2-steps" },
              steps,
              react.createElement("span", { className: "hb-tl2-did" },
                did.length ? did.join(" · ") : "四步都按白名单跳过"))));
      });
      var more = h.runs.length > 3
        ? react.createElement("button", {
            className: "hb-tl2-more", onClick: function () { setExpanded(!expanded); },
          }, expanded ? "收起" : ("展开最近 " + Math.min(10, h.runs.length) + " 次"))
        : null;
      return react.createElement("div", { className: "hb-hist" },
        react.createElement("div", { className: "hb-k" }, "自主账本 · 共 " + h.total + " 次记录"),
        react.createElement("div", { className: "hb-tl2-wrap" + (expanded ? " open" : "") }, items),
        more);
    }


    // ★ 2026-11-03 加：待处理报警条（⑤ 发现问题后的动作 · 可见部分）
    //   ★★ 诚实说明：脚本调不到 notify_wechat，所以这里的「通知」= 面板显示 + 队列，
    //      不是主动推微信。没报警时整条不渲染 —— 不让它变成背景噪音。

    // ★ 2026-11-03 加：注意力预算条（命题 7）
    //   ★★ 为什么要单独一行：这是「心跳到底占了你多少注意力」的唯一读数。
    //      没有它，心跳跑得再多也只是一句「它在跑」，说不上「值不值」。
    function StatsBar() {
      var st = useState(null);
      var a = st[0], setA = st[1];
      useEffect(function () {
        fetch("/heartbeat/stats").then(function (r) { return r.json(); })
          .then(function (j) { if (j && j.ok) setA(j); }).catch(function () {});
      }, []);
      if (!a || !a.summary) return null;
      var s = a.summary;
      // ★ 没有真跑过就整条不显示 —— 「今天还没跑」不值得占一行
      if (!s.runs) return null;
      return react.createElement("div", { className: "hb-stats" },
        "今天跑了 ", react.createElement("em", null, s.runs), " 次，",
        s.needYou === 0
          ? "一次都没麻烦你"
          : react.createElement("span", null, "其中 ", react.createElement("em", null, s.needYou), " 次需要你看"));
    }

    function AlarmBar() {
      var st = useState(null);
      var a = st[0], setA = st[1];
      function load() {
        fetch("/heartbeat/alarms").then(function (r) { return r.json(); })
          .then(function (j) { if (j && j.ok) setA(j); }).catch(function () {});
      }
      useEffect(function () { load(); }, []);
      if (!a || !a.pending) return null;
      var items = (a.items || []).slice(0, 3).map(function (it, i) {
        return react.createElement("div", { className: "hb-alarm-i", key: i },
          "· " + (it.step || "?") + " — " + String(it.why || "").split("\n")[0].slice(0, 90));
      });
      return react.createElement("div", { className: "hb-alarm" },
        react.createElement("div", { className: "hb-alarm-h" }, "⚠ " + a.pending + " 条待处理（共 " + a.total + " 条）"),
        items,
        a.pending > 3 ? react.createElement("div", { className: "hb-alarm-i" }, "…还有 " + (a.pending - 3) + " 条") : null);
    }

    // ★ 2026-11-03 21:40 预算额度可视化（爀曦要：自主一轮扣一点，得看得见）。
    //   同一个数据源 /heartbeat/auto；点阵 = 今天跑了几个 / 上限几个。
    function BudgetBar () {
      var st = useState(null);
      var gs = useState("");
      var bs = useState(false);
      var data = st[0], setData = st[1];
      var gmsg = gs[0], setGmsg = gs[1];
      var busy = bs, setBusy = bs[1];
      function grant () {
        setBusy(true); setGmsg("");
        fetch("/heartbeat/grant", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            setBusy(false);
            if (j && j.ok) {
              setGmsg("已恢复（原已跑 " + j.before + " 次）");
              setData(function (old) {
                return old ? Object.assign({}, old, { autoRunsToday: 0, autoGrantsToday: j.autoGrantsToday }) : old;
              });
            } else setGmsg("恢复失败：" + ((j && j.why) || "未知"));
          })
          .catch(function () { setBusy(false); setGmsg("请求失败"); });
      }
      useEffect(function () {
        var alive = true;
        function pull () {
          fetch("/heartbeat/auto").then(function (r) { return r.json(); })
            .then(function (j) { if (alive) setData(j); })
            .catch(function () { if (alive) setData({ ok: false }); });
        }
        pull();
        var p = setInterval(pull, 15000);
        return function () { alive = false; clearInterval(p); };
      }, []);
      if (!data) return react.createElement("div", { className: "hb-vs" }, "读取中…");
      if (!data.ok) return react.createElement("div", { className: "hb-vs" },
        "读不到 /heartbeat/auto（Host 半等重启）");
      var used = Math.max(0, data.autoRunsToday || 0);
      var max = Math.max(1, data.maxRunsPerDay || 1);
      var remain = Math.max(0, max - used);
      var dots = [];
      for (var i = 0; i < max; i++) {
        dots.push(react.createElement("div", {
          key: i,
          className: "hb-dot" + (i < used ? " used" : ""),
          title: i < used ? "已用" : "可用",
        }));
      }
      var cls = remain === 0 ? "hb-bud-n empty" : (remain <= 1 ? "hb-bud-n warn" : "hb-bud-n");
      var lastTxt = data.autoLastAt
        ? new Date(data.autoLastAt).toLocaleTimeString()
        : "还没跑过";
      var errTxt = data.autoLastError
        ? react.createElement("div", { style: { color: "#ff9a9a" } }, "上次出错：" + String(data.autoLastError).slice(0, 60))
        : null;
      var grants = data.autoGrantsToday || 0;
      var grantTxt = grants > 0 ? ("手动恢复 " + grants + " 次") : "";
      return react.createElement("div", null,
        react.createElement("div", { className: "hb-bud" },
          react.createElement("div", { className: "hb-bud-l" },
            react.createElement("div", { className: cls }, String(remain)),
            react.createElement("div", { className: "hb-bud-k" }, "今日剩余")),
          react.createElement("div", { className: "hb-dots" }, dots),
          react.createElement("div", { className: "hb-bud-m" },
            react.createElement("div", null, "今日已跑 ", react.createElement("b", null, String(used)), " / ", react.createElement("b", null, String(max)), " 轮"),
            react.createElement("div", null, "上次触发：", react.createElement("b", null, lastTxt)),
            react.createElement("div", { className: "hb-bud-bar" },
              react.createElement("i", { style: { width: Math.round(used / max * 100) + "%" } })),
            errTxt)),
        react.createElement("div", { className: "hb-grant" },
          react.createElement("button", {
            className: "hb-grant-btn" + (remain === 0 ? " hot" : ""),
            disabled: busy[0],
            onClick: grant,
            title: "把今日已跑次数清零，相当于换前面板的「延续额度」",
          }, busy[0] ? "恢复中…" : (remain === 0 ? "＋ 恢复今日额度" : "＋ 恢复额度")),
          react.createElement("span", { className: "hb-grant-tip" },
            gmsg ? gmsg : (grantTxt || (remain === 0 ? "额度已用完，按一下今天还能跑" : "手动恢复会清零已跑计数并留痕")))));
    }

    // ★★ 2026-11-03 22:00 状态机卡：状态 → 倒计时联动（爀曦定）
    //   在场 → 倒计时停；他 5 分钟没动 → 起表；到点触发 → 我活跃 → 停；我停 → 恢复。
    var SC = {
      present:   { c: "#62d99e", t: "你在，我待命" },
      counting:  { c: "#e8c069", t: "静默计时中" },
      running:   { c: "#6fa8e8", t: "我在自主中" },
      ready:     { c: "#e08a4a", t: "到点了，等下一拍" },
      exhausted: { c: "#e06a6a", t: "今日预算用完" },
    };
    function fmtCd(ms) {
      var s = Math.max(0, Math.floor(ms / 1000));
      return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
    }
    function StatusCard(props) {
      var st = useState(null);
      var tk = useState(0);
      var data = st[0], setData = st[1];
      var setTick = tk[1];
      useEffect(function () {
        var alive = true;
        function pull() {
          fetch("/heartbeat/auto").then(function (r) { return r.json(); })
            .then(function (j) {
              if (!alive) return;
              if (j && j.ok) { j._at = Date.now(); setData(j); }
              else setData({ ok: false });
            })
            .catch(function () { if (alive) setData({ ok: false }); });
        }
        pull();
        var p = setInterval(pull, 5000);
        var t = setInterval(function () { setTick(function (x) { return x + 1; }); }, 1000);
        return function () { alive = false; clearInterval(p); clearInterval(t); };
      }, []);
      if (!data) return react.createElement("div", { className: "hb-vs" }, "读取中…");
      if (!data.ok) return react.createElement("div", { className: "hb-vs" },
        "读不到 /heartbeat/auto —— Host 半要等下次 DSH 重启才生效");
      if (!data.enabled) return react.createElement("div", { className: "hb-vs" }, "自主循环已关（总开关没开）");
      // ★ 兜底要用归一化后的 st，不能用原始 data.state —— 否则旧 Host（不返回 state）会全部落进 else 分支
      // ★ 2026-11-03 22:13 倒计时始终可见（爀曦要）：present 时算「缓冲剩余 + 阈值」，
      //   counting 时算 remainMs，running 时冻结。
      var graceMsV = data.graceMs || 300000;
      var thMsV = data.thresholdMs || 900000;
      var totalAll = graceMsV + thMsV;
      var idleV = data.idleMs || 0;
      var remainAll = Math.max(0, totalAll - idleV);
      var st = data.state || "present";
      var s = SC[st] || SC.present;
      var elapsed = Date.now() - (data._at || Date.now());
      var remain = Math.max(0, (data.remainMs || 0) - elapsed);
      var total = data.totalMs || 1;
      var counting = st === "counting";
      var pct2 = Math.max(0, Math.min(100, Math.round((totalAll - remainAll) / totalAll * 100)));
      var pct = counting ? Math.min(100, Math.round((total - remain) / total * 100)) : pct2;
      var cdText, sub;
      if (counting) {
        cdText = fmtCd(remain);
        sub = "静默阈值 " + data.thresholdMin + " 分 · 触发后扣 1 点预算";
      } else if (st === "present") {
        cdText = fmtCd(remainAll);
        sub = "你安静 " + (data.graceMin || 5) + " 分钟后起表，再 " + Math.round(thMsV / 60000) + " 分钟触发";
      } else if (st === "running") {
        cdText = "暂停";
        sub = "我干完这轮、安静下来后自动恢复";
      } else if (st === "ready") {
        cdText = "待触发";
        sub = "next tick 会拉起自主";
      } else {
        cdText = "0";
        sub = "已跑 " + data.autoRunsToday + " / " + data.maxRunsPerDay + " 轮 · 明天恢复";
      }
      return react.createElement("div", null,
        react.createElement("div", { className: "hb-sc" },
          react.createElement("div", { className: "hb-sc-dot", style: { color: s.c, background: s.c } }),
          react.createElement("div", null,
            react.createElement("div", { className: "hb-sc-t", style: { color: s.c } }, s.t),
            react.createElement("div", { className: "hb-sc-sub" }, sub),
            (function () {
              var p = props && props.phase;
              if (!p || !p.ok) return null;
              return react.createElement("div", { className: "hb-sc-sub", style: { marginTop: "1px" } },
                "上次结果 ", react.createElement("b", { style: { fontWeight: 600 } }, String(p.lastRunResult || "-")),
                " · 今日已跑 ", String(p.runsToday != null ? p.runsToday : "-"), " 次");
            })()),
          react.createElement("div", { className: "hb-sc-cd", style: { color: counting ? s.c : "#8899ad" } }, cdText)),
        react.createElement("div", { className: "hb-sc-bar" },
          react.createElement("i", { className: "hb-sc-fill" + (counting ? " hot" : ""), style: { width: pct + "%" } })));
    }

    // ★ 2026-11-03 20:44 自主倒计时：距进入自主模式还有多久。
    //   数据 /heartbeat/auto（15 秒刷一次）+ 本地 1 秒跳秒。
    function AutoCountdown () {
      var st = useState(null);
      var tk = useState(0);
      var data = st[0], setData = st[1];
      var setTick = tk[1];
      useEffect(function () {
        var alive = true;
        function pull () {
          fetch("/heartbeat/auto").then(function (r) { return r.json(); })
            .then(function (j) { if (alive && j && j.ok) setData(j); })
            .catch(function () { if (alive) setData({ ok: false }); });
        }
        pull();
        var p = setInterval(pull, 15000);
        var t = setInterval(function () { setTick(function (x) { return x + 1; }); }, 1000);
        return function () { alive = false; clearInterval(p); clearInterval(t); };
      }, []);
      if (!data) return react.createElement("div", { className: "hb-vs" }, "读取中…");
      if (!data.ok) return react.createElement("div", { className: "hb-vs" },
        "读不到 /heartbeat/auto —— Host 半要等下次 DSH 重启才生效");
      if (!data.enabled) return react.createElement("div", { className: "hb-vs" },
        "自主循环已关（总开关没开）");
      if (data.autoRunsToday >= data.maxRunsPerDay) return react.createElement("div", { className: "hb-vs" },
        "今日自主预算已用完（" + data.autoRunsToday + "/" + data.maxRunsPerDay + "）· 明天恢复");
      var remainMs = data.thresholdMs - (Date.now() - data.lastActivityAt);
      var idleS = Math.floor((Date.now() - data.lastActivityAt) / 1000);
      var thrS = Math.round(data.thresholdMs / 1000);
      var pct = Math.min(100, Math.max(0, Math.round(idleS / thrS * 100)));
      var line;
      if (remainMs <= 0) {
        line = react.createElement("div", { className: "hb-v" },
          react.createElement("span", { className: "hb-dot on" }),
          " 已到点 · 下一个 60 秒 tick 内投递自主指令");
      } else {
        var s = Math.ceil(remainMs / 1000);
        var mm = Math.floor(s / 60), ss = s % 60;
        line = react.createElement("div", { className: "hb-v" },
          "距自主模式还有 " + mm + ":" + (ss < 10 ? "0" : "") + ss +
          "（静默 " + Math.floor(idleS / 60) + " / " + data.thresholdMin + " 分钟" +
          (data.primaryFound ? "" : " · ★ 找不到主导会话") + "）");
      }
      return react.createElement("div", null, line,
        react.createElement("div", { className: "hb-autobar" },
          react.createElement("div", { className: "hb-autobar-in",
            style: { width: pct + "%" } })));
    }

    function apply(ctx) {
      // 侧边栏图标
      ctx.slots.inject("sidebar.panellist", function () {
        return ctx.slots.register(
          { name: "sidebar.panellist", id: PANEL_ID, order: 70, label: "心跳" },
          function (props) { return react.createElement(Icon, props); },
        );
      });
      // 主区面板（keyed，key 与图标 id 一致）
      ctx.slots.inject("main", function () {
        return ctx.slots.register(
          { name: "main", key: PANEL_ID },
          function () { return react.createElement(PanelWithEvents); },
        );
      });
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});
