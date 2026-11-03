/**
 * ClawBot — DSH plugin package, browser half.
 *
 * Registers a `settings.section` page (id `clawbot`) with the binding QR,
 * live 微信在线/微信连接断线 status, a send box, and the two auto-notify
 * toggles. All state flows through the same-origin /clawbot/* routes the
 * host half registers; the QR is rendered locally by an inlined encoder.
 */
window.__ModuleLoader__.load({
  id: "dsh-clawbot",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");
    const { useState, useEffect, useRef } = react;

    /* ── styles ─────────────────────────────────────────────── */
    const css = `
.wct-panel{ --wct-green:#07c160; --wct-green-hover:#06ad56; --wct-border:rgba(148,160,178,.22); --wct-muted:#9aa4b2; font-size:13px; line-height:1.55; color:inherit; max-width:560px; }
.wct-head{ display:flex; align-items:center; gap:12px; margin-bottom:14px; }
.wct-logo{ width:42px; height:42px; border-radius:12px; background:linear-gradient(135deg,#07c160,#05a551); color:#fff; font-size:20px; font-weight:700; display:flex; align-items:center; justify-content:center; box-shadow:0 6px 16px rgba(7,193,96,.32); flex:none; overflow:hidden; }
.wct-logo img{ width:100%; height:100%; object-fit:cover; display:block; }
.wct-title{ font-size:16px; font-weight:700; letter-spacing:.2px; }
.wct-sub{ font-size:12px; color:var(--wct-muted); margin-top:1px; }
.wct-card{ border:1px solid var(--wct-border); border-radius:12px; padding:12px 14px; margin-bottom:10px; background:rgba(127,140,160,.045); }
.wct-status-card{ display:flex; align-items:center; gap:9px; }
.wct-dot{ width:9px; height:9px; border-radius:50%; background:#b6bdc9; flex:none; }
.wct-dot.on{ background:var(--wct-green); animation:wct-pulse 2.2s infinite; }
.wct-dot.off{ background:#f87171; }
@keyframes wct-pulse{ 0%{ box-shadow:0 0 0 0 rgba(7,193,96,.45); } 70%{ box-shadow:0 0 0 7px rgba(7,193,96,0); } 100%{ box-shadow:0 0 0 0 rgba(7,193,96,0); } }
.wct-status-txt{ font-weight:600; }
.wct-id{ color:var(--wct-muted); margin-left:auto; }
.wct-sec-title{ font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.8px; color:var(--wct-muted); margin:0 0 6px; }
.wct-row{ display:flex; gap:8px; align-items:center; margin-top:8px; }
.wct-btn{ padding:7px 14px; border-radius:8px; border:1px solid var(--wct-border); background:transparent; color:inherit; cursor:pointer; font-size:13px; font-weight:500; transition:background .15s,transform .05s; }
.wct-btn:hover{ background:rgba(127,140,160,.1); }
.wct-btn:active{ transform:translateY(1px); }
.wct-btn:disabled{ opacity:.45; cursor:default; }
.wct-btn.primary{ background:var(--wct-green); border-color:var(--wct-green); color:#fff; box-shadow:0 3px 10px rgba(7,193,96,.26); }
.wct-btn.primary:hover{ background:var(--wct-green-hover); }
.wct-btn.ghost{ border-color:transparent; color:#f87171; }
.wct-btn.ghost:hover{ background:rgba(248,113,113,.1); }
.wct-input{ flex:1; width:100%; box-sizing:border-box; padding:8px 11px; border-radius:8px; border:1px solid var(--wct-border); background:rgba(127,140,160,.05); color:inherit; font-size:13px; }
.wct-input:focus{ outline:none; border-color:var(--wct-green); }
.wct-link{ color:var(--wct-green); text-decoration:none; cursor:pointer; font-size:12px; }
.wct-link:hover{ text-decoration:underline; }
.wct-qr-wrap{ text-align:center; padding:6px 0 2px; }
.wct-qr{ display:inline-block; background:#fff; padding:7px; border-radius:10px; image-rendering:pixelated; box-shadow:0 4px 14px rgba(0,0,0,.18); }
.wct-qr-hint{ color:var(--wct-muted); font-size:12px; margin-top:6px; }
.wct-toggle-row{ display:flex; align-items:center; justify-content:space-between; gap:12px; padding:6px 0; cursor:pointer; }
.wct-toggle-txt{ flex:1; }
.wct-switch{ position:relative; width:40px; height:23px; flex:none; }
.wct-switch input{ position:absolute; opacity:0; width:100%; height:100%; margin:0; cursor:pointer; z-index:1; }
.wct-slider{ position:absolute; inset:0; background:rgba(140,150,165,.4); border-radius:23px; transition:background .2s; }
.wct-slider:before{ content:''; position:absolute; height:17px; width:17px; left:3px; top:3px; background:#fff; border-radius:50%; transition:transform .2s; box-shadow:0 1px 3px rgba(0,0,0,.3); }
.wct-switch input:checked + .wct-slider{ background:var(--wct-green); }
.wct-switch input:checked + .wct-slider:before{ transform:translateX(17px); }
.wct-status{ color:var(--wct-muted); }
.wct-err{ color:#f87171; }
.wct-ok{ color:var(--wct-green); }
.wct-mono{ font-family:ui-monospace,Menlo,monospace; word-break:break-all; }
.wct-field-label{ font-size:11px; color:var(--wct-muted); margin:8px 0 2px; }
.wct-pre{ font-family:ui-monospace,Menlo,monospace; font-size:11px; line-height:1.5; background:rgba(127,140,160,.06); border:1px solid var(--wct-border); border-radius:8px; padding:8px 10px; overflow-x:auto; white-space:pre; margin:4px 0 0; }
.wct-foot{ margin-top:4px; }
`;
    const styleTag = document.createElement("style");
    styleTag.textContent = css;
    document.head.appendChild(styleTag);

    /* ── same-origin API ────────────────────────────────────── */
    function api(path) {
      return fetch("/clawbot" + path).then((r) => r.json());
    }

    /* ── QR encoder (byte mode, versions 1–10, mask M) ──────── */
    const DATA_CODEWORDS_M = [0, 16, 28, 44, 64, 86, 108, 124, 154, 182, 216];
    const ECC_LEN_M = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
    const RS_BLOCKS_M = [[], [[1, 16]], [[1, 28]], [[1, 44]], [[2, 32]], [[2, 43]], [[4, 27]], [[4, 31]], [[2, 38], [2, 39]], [[3, 36], [2, 37]], [[4, 43], [1, 44]]];
    const ALIGN = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
    const EXP = new Uint8Array(512);
    const LOG = new Uint8Array(256);
    (function () { let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; })();
    function gfMul(a, b) { return a && b ? EXP[LOG[a] + LOG[b]] : 0; }
    function polyMul(a, b) { const r = new Array(a.length + b.length - 1).fill(0); for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) r[i + j] ^= gfMul(a[i], b[j]); return r; }
    function rsGenPoly(n) { let p = [1]; for (let i = 0; i < n; i++) p = polyMul(p, [1, EXP[i]]); return p; }
    function rsEncode(data, eccLen) { const gen = rsGenPoly(eccLen); const msg = new Array(data.length + eccLen).fill(0); for (let i = 0; i < data.length; i++) msg[i] = data[i]; for (let i = 0; i < data.length; i++) { const coef = msg[i]; if (coef !== 0) for (let j = 0; j < gen.length; j++) msg[i + j] ^= gfMul(gen[j], coef); } return msg.slice(data.length); }
    function pickVersion(byteLen) { for (let v = 1; v <= 10; v++) { const hb = 4 + (v < 10 ? 8 : 16); if (hb + byteLen * 8 <= DATA_CODEWORDS_M[v] * 8) return v; } throw new Error("QR too long"); }
    function buildCodewords(data, version) { const bits = []; const push = (value, len) => { for (let i = len - 1; i >= 0; i--) bits.push((value >> i) & 1); }; push(4, 4); push(data.length, version < 10 ? 8 : 16); for (const b of data) push(b, 8); const capacity = DATA_CODEWORDS_M[version] * 8; for (let i = 0; i < 4 && bits.length < capacity; i++) bits.push(0); while (bits.length % 8 !== 0) bits.push(0); const codewords = []; for (let i = 0; i < bits.length; i += 8) { let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]; codewords.push(b); } const pads = [0xec, 0x11]; for (let i = 0; codewords.length < DATA_CODEWORDS_M[version]; i++) codewords.push(pads[i % 2]); return codewords; }
    function interleave(codewords, version) { const blocks = RS_BLOCKS_M[version]; const eccLen = ECC_LEN_M[version]; const dataBlocks = []; const eccBlocks = []; let offset = 0; for (const blk of blocks) { const count = blk[0], perBlock = blk[1]; for (let i = 0; i < count; i++) { const data = codewords.slice(offset, offset + perBlock); offset += perBlock; dataBlocks.push(data); eccBlocks.push(rsEncode(data, eccLen)); } } const out = []; let maxData = 0; for (const b of dataBlocks) if (b.length > maxData) maxData = b.length; for (let i = 0; i < maxData; i++) for (const b of dataBlocks) if (i < b.length) out.push(b[i]); for (let i = 0; i < eccLen; i++) for (const b of eccBlocks) out.push(b[i]); return out; }
    const MASK_FNS = [(r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (_r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0, (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0, (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0];
    function bch15(data5) { let v = data5 << 10; for (let i = 14; i >= 10; i--) if (v & (1 << i)) v ^= 0x537 << (i - 10); return ((data5 << 10) | v) ^ 0x5412; }
    function bch18(v6) { let v = v6 << 12; for (let i = 17; i >= 12; i--) if (v & (1 << i)) v ^= 0x1f25 << (i - 12); return (v6 << 12) | v; }
    class Matrix {
      constructor(version) { this.size = version * 4 + 17; this.m = new Int8Array(this.size * this.size).fill(-1); this.func = new Uint8Array(this.size * this.size); }
      idx(r, c) { return r * this.size + c; }
      set(r, c, v, isFunc) { this.m[this.idx(r, c)] = v; if (isFunc !== false) this.func[this.idx(r, c)] = 1; }
      setupPatterns(version) {
        const n = this.size;
        const finder = (r0, c0) => { for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) { const rr = r0 + r, cc = c0 + c; if (rr < 0 || rr >= n || cc < 0 || cc >= n) continue; const inRing = r >= 0 && r <= 6 && c >= 0 && c <= 6; const dark = inRing && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4)); this.set(rr, cc, dark ? 1 : 0); } };
        finder(0, 0); finder(n - 7, 0); finder(0, n - 7);
        for (let i = 8; i < n - 8; i++) { this.set(6, i, i % 2 === 0 ? 1 : 0); this.set(i, 6, i % 2 === 0 ? 1 : 0); }
        const pos = ALIGN[version];
        for (const r of pos) for (const c of pos) { if (this.func[this.idx(r, c)]) continue; for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) { const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1; this.set(r + dr, c + dc, dark ? 1 : 0); } }
        for (let i = 0; i < 9; i++) { if (this.m[this.idx(8, i)] === -1) this.set(8, i, 0); if (this.m[this.idx(i, 8)] === -1) this.set(i, 8, 0); }
        for (let i = 0; i < 8; i++) { this.set(8, n - 1 - i, 0); this.set(n - 1 - i, 8, 0); }
        this.set(n - 8, 8, 1);
        if (version >= 7) { for (let i = 0; i < 18; i++) { const r = Math.floor(i / 3), c = (i % 3) + n - 11; this.set(r, c, 0); this.set(c, r, 0); } }
      }
      placeData(bits) { const n = this.size; let bitIdx = 0, upward = true; for (let col = n - 1; col > 0; col -= 2) { if (col === 6) col--; for (let i = 0; i < n; i++) { const row = upward ? n - 1 - i : i; for (let k = 0; k < 2; k++) { const cc = col - k; const id = this.idx(row, cc); if (this.func[id]) continue; this.m[id] = bitIdx < bits.length ? bits[bitIdx] : 0; bitIdx++; } } upward = !upward; } }
      applyMask(mask) { const fn = MASK_FNS[mask]; for (let r = 0; r < this.size; r++) for (let c = 0; c < this.size; c++) { const id = this.idx(r, c); if (!this.func[id] && fn(r, c)) this.m[id] ^= 1; } }
      placeFormat(mask) { const n = this.size; const fmt = bch15((0 << 3) | mask); for (let i = 0; i < 15; i++) { const bit = (fmt >> i) & 1; if (i < 6) this.set(i, 8, bit); else if (i === 6) this.set(7, 8, bit); else if (i === 7) this.set(8, 8, bit); else if (i === 8) this.set(8, 7, bit); else this.set(8, 14 - i, bit); if (i < 8) this.set(8, n - 1 - i, bit); else this.set(n - 15 + i, 8, bit); } }
      placeVersion(version) { if (version < 7) return; const n = this.size; const v = bch18(version); for (let i = 0; i < 18; i++) { const bit = (v >> i) & 1; const r = Math.floor(i / 3), c = (i % 3) + n - 11; this.set(r, c, bit); this.set(c, r, bit); } }
      penalty() { const n = this.size; const at = (r, c) => this.m[this.idx(r, c)]; let score = 0; for (let r = 0; r < n; r++) { let run = 1; for (let c = 1; c <= n; c++) { if (c < n && at(r, c) === at(r, c - 1)) run++; else { if (run >= 5) score += 3 + (run - 5); run = 1; } } } for (let c = 0; c < n; c++) { let run = 1; for (let r = 1; r <= n; r++) { if (r < n && at(r, c) === at(r - 1, c)) run++; else { if (run >= 5) score += 3 + (run - 5); run = 1; } } } for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) { const v = at(r, c); if (at(r, c + 1) === v && at(r + 1, c) === v && at(r + 1, c + 1) === v) score += 3; } const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0]; const pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1]; const matchPat = (get, len) => { for (let i = 0; i + 11 <= len; i++) { let m1 = true, m2 = true; for (let j = 0; j < 11; j++) { const v = get(i + j); if (v !== pat1[j]) m1 = false; if (v !== pat2[j]) m2 = false; if (!m1 && !m2) break; } if (m1 || m2) score += 40; } }; for (let r = 0; r < n; r++) matchPat((i) => at(r, i), n); for (let c = 0; c < n; c++) matchPat((i) => at(i, c), n); let dark = 0; for (let i = 0; i < n * n; i++) if (this.m[i] === 1) dark++; const pct = (dark * 100) / (n * n); score += Math.floor(Math.abs(pct - 50) / 5) * 10; return score; }
      cloneFrom(other) { this.m.set(other.m); this.func.set(other.func); }
    }
    function encodeQr(text) { const data = new TextEncoder().encode(text); const version = pickVersion(data.length); const codewords = interleave(buildCodewords(data, version), version); const bits = []; for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1); const base = new Matrix(version); base.setupPatterns(version); base.placeData(bits); base.placeVersion(version); let bestMask = 0, bestScore = Infinity; const trial = new Matrix(version); for (let mask = 0; mask < 8; mask++) { trial.cloneFrom(base); trial.applyMask(mask); trial.placeFormat(mask); const s = trial.penalty(); if (s < bestScore) { bestScore = s; bestMask = mask; } } base.applyMask(bestMask); base.placeFormat(bestMask); const size = base.size; return { size, isDark: (r, c) => base.m[r * size + c] === 1 }; }

    function QrCanvas(props) {
      const text = props.text;
      const draw = function (canvas) {
        if (!canvas) return;
        try {
          const qr = encodeQr(text);
          const n = qr.size + 8;
          const cell = Math.max(3, Math.min(8, Math.floor(240 / n)));
          canvas.width = n * cell; canvas.height = n * cell;
          const c = canvas.getContext("2d");
          if (!c) return;
          c.fillStyle = "#ffffff"; c.fillRect(0, 0, canvas.width, canvas.height);
          c.fillStyle = "#000000";
          const quiet = 4;
          for (let r = 0; r < qr.size; r++) for (let col = 0; col < qr.size; col++) { if (qr.isDark(r, col)) c.fillRect((col + quiet) * cell, (r + quiet) * cell, cell, cell); }
        } catch (e) { /* ignore */ }
      };
      return react.createElement("canvas", { ref: draw, className: "wct-qr" });
    }

    function Toggle(props) {
      return react.createElement("label", { className: "wct-toggle-row" },
        react.createElement("span", { className: "wct-toggle-txt" }, props.label),
        react.createElement("span", { className: "wct-switch" },
          react.createElement("input", { type: "checkbox", checked: !!props.checked, onChange: function (e) { props.onChange(e.target.checked); } }),
          react.createElement("span", { className: "wct-slider" })));
    }

    function SavedInput(props) {
      const [val, setVal] = useState(props.value || "");
      const focused = useRef(false);
      useEffect(function () {
        if (!focused.current) setVal(props.value || "");
      }, [props.value]);
      return react.createElement("input", {
        className: "wct-input",
        value: val,
        placeholder: props.placeholder || "",
        onFocus: function () { focused.current = true; },
        onBlur: function () {
          focused.current = false;
          const v = String(val || "").trim();
          setVal(v);
          if (v !== String(props.value || "").trim()) props.onSave(v);
        },
        onChange: function (e) { setVal(e.target.value); },
      });
    }

    function Panel() {
      const [state, setState] = useState(null);
      const [icon, setIcon] = useState("");
      const [text, setText] = useState("测试通知");
      const [busy, setBusy] = useState(false);
      const [notice, setNotice] = useState("");

      const refresh = function () { api("/state").then(setState).catch(function () {}); };
      useEffect(function () {
        refresh();
        api("/icon").then(function (r) { if (r && r.dataUrl) setIcon(r.dataUrl); }).catch(function () {});
        const id = setInterval(refresh, 2000);
        return function () { clearInterval(id); };
      }, []);

      const startLogin = function () {
        setBusy(true); setNotice("");
        api("/bind").then(function (r) {
          setBusy(false);
          if (!r || r.ok !== true) setNotice("✗ " + String((r && r.error) || "获取二维码失败"));
          refresh();
        }).catch(function (e) { setBusy(false); setNotice("✗ " + String((e && e.message) || e)); });
      };
      const send = function () {
        const t = String(text || "").trim();
        if (!t || busy) return;
        setBusy(true); setNotice("");
        api("/send?text=" + encodeURIComponent(t)).then(function (r) {
          setBusy(false);
          if (r && r.ok === true) { setNotice("✔ 已发送"); setText("测试通知"); }
          else setNotice("✗ " + String((r && r.errmsg) || "发送失败"));
        }).catch(function (e) { setBusy(false); setNotice("✗ " + String((e && e.message) || e)); });
      };
      const logout = function () { api("/logout").then(refresh).catch(function () {}); };
      const toggle = function (key, value) { api("/set?key=" + key + "&value=" + (value ? "1" : "0")).then(refresh).catch(function () {}); };
      const saveText = function (key, value) { api("/set?key=" + key + "&value=" + encodeURIComponent(value)).then(refresh).catch(function () {}); };

      const bound = state && state.bound;
      const cs = state && state.connStatus ? state.connStatus : "unbound";
      const csLabel = cs === "online" ? "微信在线" : cs === "offline" ? "微信连接断线" : "未绑定";
      const dotCls = "wct-dot" + (cs === "online" ? " on" : "") + (cs === "offline" ? " off" : "");
      const noticeCls = notice.indexOf("✔") === 0 ? "wct-ok" : "wct-err";

      return react.createElement("div", { className: "wct-panel" },
        react.createElement("div", { className: "wct-head" },
          react.createElement("div", { className: "wct-logo" }, icon ? react.createElement("img", { src: icon, alt: "ClawBot" }) : "爪"),
          react.createElement("div", null,
            react.createElement("div", { className: "wct-title" }, "ClawBot"),
            react.createElement("div", { className: "wct-sub" }, "微信官方 ilink 机器人网关"))),
        react.createElement("div", { className: "wct-card wct-status-card" },
          react.createElement("span", { className: dotCls }),
          react.createElement("span", { className: "wct-status-txt" }, csLabel),
          bound ? react.createElement("span", { className: "wct-id wct-mono" }, "bot: " + (state.botId || "?")) : null),
        !bound
          ? react.createElement("div", { className: "wct-card" },
              react.createElement("p", { className: "wct-status" }, "扫描二维码，在手机上确认即可绑定"),
              state && state.login && state.login.qrUrl
                ? react.createElement("div", { className: "wct-qr-wrap" },
                    react.createElement(QrCanvas, { text: state.login.qrUrl }),
                    react.createElement("p", { className: "wct-qr-hint" }, "请用微信扫上面的二维码"))
                : null,
              react.createElement("div", { className: "wct-row" },
                react.createElement("button", { className: "wct-btn primary", onClick: startLogin, disabled: busy }, "绑定微信 / 刷新二维码")))
          : react.createElement("div", { className: "wct-card" },
              react.createElement("p", { className: "wct-mono wct-status" }, "user: " + (state.scannedUser || "?")),
              state.sessionDead
                ? react.createElement("p", { className: "wct-err" }, "会话已过期，请重新扫码绑定")
                : state.hasContextToken
                  ? react.createElement("p", { className: "wct-ok" }, "发送凭证已就绪")
                  : state.contextStale
                    ? react.createElement("p", { className: "wct-err" }, "发送凭证已过期：请在微信里给机器人再发一条消息")
                    : react.createElement("p", { className: "wct-status" }, "尚未获得发送凭证：请先在微信里给机器人发一条消息"),
              react.createElement("div", { className: "wct-row" },
                react.createElement("input", { className: "wct-input", value: text, placeholder: "通知内容（支持 markdown）…", onChange: function (e) { setText(e.target.value); } }),
                react.createElement("button", { className: "wct-btn primary", onClick: send, disabled: busy }, "发送")),
              react.createElement("div", { className: "wct-row" },
                react.createElement("button", { className: "wct-btn ghost", onClick: logout }, "解除绑定"))),
        react.createElement("div", { className: "wct-card" },
          react.createElement("div", { className: "wct-sec-title" }, "自动通知"),
          react.createElement(Toggle, { label: "任务完成后自动微信通知", checked: state ? !!state.notifyOnComplete : true, onChange: function (v) { toggle("notifyOnComplete", v); } }),
          react.createElement(Toggle, { label: "任务被阻断时自动微信通知", checked: state ? !!state.notifyOnBlock : true, onChange: function (v) { toggle("notifyOnBlock", v); } }),
          react.createElement(Toggle, { label: "等待批准/回答时微信提醒", checked: state ? !!state.notifyOnBlocking : true, onChange: function (v) { toggle("notifyOnBlocking", v); } })),
        react.createElement("div", { className: "wct-card" },
          react.createElement("div", { className: "wct-sec-title" }, "监听"),
          react.createElement(Toggle, { label: "监听微信消息并自动处理", checked: state ? !!state.listenEnabled : false, onChange: function (v) { toggle("listenEnabled", v); } }),
          react.createElement("p", { className: "wct-status" }, "单独创建一个会话处理微信消息，不影响当前会话；处理完成后自动微信通知「完成」")),
        react.createElement("div", { className: "wct-card" },
          react.createElement("div", { className: "wct-sec-title" }, "上报"),
          react.createElement("div", { className: "wct-field-label" }, "服务器地址"),
          react.createElement(SavedInput, { value: state && state.reportUrl, placeholder: "https://your-server.com/hook", onSave: function (v) { saveText("reportUrl", v); } }),
          react.createElement(Toggle, { label: "启用上报", checked: state ? !!state.reportEnabled : false, onChange: function (v) { toggle("reportEnabled", v); } }),
          react.createElement("div", { className: "wct-field-label" }, "唤醒词（消息完全等于该词时开启上报）"),
          react.createElement(SavedInput, { value: state && state.wakeWord, placeholder: "开启上报", onSave: function (v) { saveText("wakeWord", v); } }),
          react.createElement("div", { className: "wct-field-label" }, "关闭词（消息完全等于该词时关闭上报）"),
          react.createElement(SavedInput, { value: state && state.closeWord, placeholder: "关闭上报", onSave: function (v) { saveText("closeWord", v); } }),
          react.createElement("div", { className: "wct-field-label" }, "上报前缀词（上报关闭时，消息以该词开头则单次上报）"),
          react.createElement(SavedInput, { value: state && state.reportPrefix, placeholder: "转发", onSave: function (v) { saveText("reportPrefix", v); } }),
          react.createElement("div", { className: "wct-row" },
            react.createElement("a", { className: "wct-link", href: "/clawbot/report", target: "_blank", rel: "noopener" }, "点击查看详细文档 REPORT.md"))),
        notice ? react.createElement("p", { className: noticeCls }, notice) : null,
        react.createElement("div", { className: "wct-foot" },
          state && state.lastError ? react.createElement("p", { className: "wct-err wct-mono" }, state.lastError) : null)
      );
    }

    function apply(ctx) {
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "clawbot",
        order: 30,
        label: "ClawBot",
      }, () => react.createElement(Panel)));
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});
