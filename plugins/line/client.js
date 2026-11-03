// dsh-yanqing-line —— 浏览器半
//
// 它是一个【右栏标签页】，和 dsh-image-gen 的画廊工作台并列。
// 注册方式照抄工作台自己的两段式：
//   ① 类型注册进 ctx.sidebarRightTabs
//   ② 主体注册进 keyed 槽位 sidebar.right.pane.tab，key = 同一个 tab id
// 这样不用改它的代码，它升级也不会冲掉我。
//
// ★ exports.inject 必须写 —— 少了它整包静默失效（Host 报 running，浏览器一行不跑）。
window.__ModuleLoader__.load({
  id: "dsh-yanqing-line",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var h = react.createElement;

    const TAB_ID = "dsh-yanqing-line/panel";
    const TAB_KIND = "dsh-yanqing-line";
    // ★ 2026-10-01：原来这里写死相对路径 /yanqing-line/api，结果在桌面端（Electron）
    //   一直停在「载入中…」——因为相对 fetch 的基准可能不是那个 http 端口。
    //   改成基于 location.origin 的绝对地址；拿不到 http origin 时退回本机端口，
    //   这样 web profile 和 desktop profile 两边都能用。
    const ORIGIN = (typeof location !== "undefined" && /^https?:/.test(location.origin || ""))
      ? location.origin
      : "";
    const API = ORIGIN + "/yanqing-line/api";

    // ══════════════════════════════════════════════════════════════
    // 丹房 · 和图库（dsh-image-gen）打通的那一层
    // ══════════════════════════════════════════════════════════════
    // ★ 2026-10-01 查清的事实（来源：dsh-image-gen\lib\client.js）：
    //   · 画廊的图存在 IndexedDB：库 dsh_image_gen_db v4，store gallery_history
    //     （keyPath "id" = attachmentId，索引名 "createdAt"）
    //   · IndexedDB 按「源」隔离、不按插件隔离 —— 所以丹房能直接读写同一个库：
    //     写进去，画廊那一格立刻看得见，完全不用改它的代码
    //   · 取图走 POST /plugins/dsh-image-gen/image，body { attachment }，回 blob
    //   · 删除走 POST /plugins/dsh-image-gen/delete
    const DF_DB = "dsh_image_gen_db";
    const DF_STORE = "gallery_history";
    const DF_IMG = "/plugins/dsh-image-gen/image";
    const DF_DEL = "/plugins/dsh-image-gen/delete";

    // ★ 2026-10-12 加：图库内容变化时广播的事件名。
    //   删除成功后 MetaBox 派发它，所有正在显示图库的地方自己监听并重载列表
    //   （见 GalleryPage 里的 effect）。这样删完列表和总数立刻更新，不用手动刷新页面。
    const GALLERY_CHANGED = "yanqing-line:gallery-changed";

    // 只 open、不建 store —— 库是画廊的，丹房只当访客。
    // ★ 故意不注册 onupgradeneeded：库里没有 store 时下面会自己判空，
    //   而乱建 store 反而可能和画廊的 schema 打架。
    function dfDB() {
      return new Promise((resolve, reject) => {
        if (typeof indexedDB === "undefined") { reject(new Error("这个环境没有 IndexedDB")); return; }
        const req = indexedDB.open(DF_DB, 4);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error("打不开图库数据库"));
      });
    }

    // 按 createdAt 倒序取全部记录（和画廊同一把尺子）
    function dfList() {
      return dfDB().then((db) => new Promise((resolve, reject) => {
        if (!db.objectStoreNames.contains(DF_STORE)) { resolve([]); return; }
        const req = db.transaction(DF_STORE, "readonly").objectStore(DF_STORE)
          .index("createdAt").openCursor(null, "prev");
        const out = [];
        req.onsuccess = (e) => {
          const c = e.target.result;
          if (c) { out.push(c.value); c.continue(); } else resolve(out);
        };
        req.onerror = () => reject(req.error);
      }));
    }

    // 写一条进画廊 —— 丹房出的图就是靠这个"保存进画廊"的
    function dfPut(item) {
      return dfDB().then((db) => new Promise((resolve, reject) => {
        if (!db.objectStoreNames.contains(DF_STORE)) { reject(new Error("图库里还没有 gallery_history")); return; }
        const r = db.transaction(DF_STORE, "readwrite").objectStore(DF_STORE).put(item);
        r.onsuccess = () => resolve(true);
        r.onerror = () => reject(r.error);
      }));
    }

    function dfDelete(id) {
      return new Promise((resolve) => {
        const db = null;
        dfDB().then((d) => {
          if (!d.objectStoreNames.contains(DF_STORE)) { resolve(false); return; }
          const r = d.transaction(DF_STORE, "readwrite").objectStore(DF_STORE).delete(id);
          r.onsuccess = () => resolve(true);
          r.onerror = () => resolve(false);
        }).catch(() => resolve(false));
      });
    }

    // 「attachmentId → objectURL」小缓存。★ 必须复用，否则长列表会把内存吃光。
    const dfUrlCache = new Map();

    function dfImageUrl(attachment) {
      const key = String((attachment && attachment.attachmentId) || "");
      if (!key) return Promise.reject(new Error("这条记录没有 attachmentId"));
      if (dfUrlCache.has(key)) return dfUrlCache.get(key);
      const p = fetch(DF_IMG, {
        method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ attachment }),
      }).then((r) => {
        if (!r.ok) throw new Error("取图失败 " + r.status);
        return r.blob();
      }).then((b) => URL.createObjectURL(b));
      dfUrlCache.set(key, p);
      return p;
    }

    // ── 2026-10-04 爀曦要的两个功能 ────────────────────────────────
    // ①「点击可以完整复制照片，这样就不用我自己翻文件夹了」
    // ②「再给一个打开对应文件夹的功能，这样我可以快速访问对应的目录」
    //
    // ★ 复制有两条路必须都过，少一条就失败：
    //   a) ClipboardItem **只接受 image/png** —— 原图是 webp/jpg 时直接 write 会抛
    //      NotAllowedError，所以必须先转 PNG（走一遍 canvas）。
    //   b) navigator.clipboard.write 需要【用户手势】+ 安全上下文
    //      （127.0.0.1 算安全上下文），所以只能在 onClick 里调，不能在 effect 里调。
    // ══════════════════════════════════════════════════════════════
    // 从图的 blob 里读元数据（2026-10-12 加，把原来的 readPngSeed 升级成全套）
    // ══════════════════════════════════════════════════════════════
    // ★ 由来：爀曦要「打开图片在靠近左上角位置显示提示词、seed 等信息」。
    // ★★ 为什么不走宿主半：ComfyUI 把整份参数写进了 PNG 自己的 tEXt 块
    //   （`prompt` 是一段 JSON，每个节点的 inputs 都在里面），**前端直接读 blob 就行**。
    //   好处是【一套代码通吃三处】—— 图库页、出图页、工作台拿到的都是 blob URL；
    //   而且对以前所有的图都有效，不用改数据库、不用重跑。
    // ★ 宿主半那条 /api/meta 保留着当兜底（比如将来图不在磁盘上、只有 blob 的时候）。
    //
    // ★ 两个实现细节别改坏：
    //   ① 用 latin1 解码 —— tEXt 是 latin1/ASCII，用 utf-8 解会在中文提示词处截断；
    //      反正只是用来正则匹配 JSON 里的字段，取出来的转义再自己还原。
    //   ② seed 不假设只出现一次 —— JSON 里可能有多个 KSampler，取第一个匹配的即可
    //      （与原来 readPngSeed 的行为一致，不改变已有语义）。
    // ★★★ 2026-10-12 13:57 修一个**致命 bug**（爀曦实测：「每一张都显示没有元数据」）——
    //   我第一版用了 Node 的 Buffer API，而这里是【浏览器】：
    //     buf.readUInt32BE(i)        ← Uint8Array 没有这个方法
    //     buf.toString('ascii', a, b) ← 也没有这个重载
    //   浏览器里第一行就抛 TypeError，被我自己的 try/catch 吞掉、返回空对象，
    //   于是每一张图都显示「没有元数据」。★ 判据：连 danfang 那批也一样 —— 那就不是图的问题。
    //   （磁盘上那些文件用 Python 独立验过，tEXt 块和 seed 都在。）
    // ★ 这一版改成纯 Uint8Array 操作：手写大端读取 + String.fromCharCode 拼 ASCII。
    // ★ 顺带改成「只挑 tEXt 里的 prompt 那一块」再正则 —— 比全文匹配更准，
    //   而且找不到时把原因写进 error，下次一看就知道是"图没有元数据"还是"我读错了"。
    // ★★★ 2026-10-12 14:11 换路子：**先问宿主半**（读产线原图），读 blob 降为备用。
    //   真因（14:08 用 Python 扫了 4222 个附件对象查明）：
    //     DSH 的附件系统在图片【入库时重新编码过】—— 1261 张 PNG 附件里，最近 12 张的
    //     tEXt 块全部为空。元数据在入库那一刻就丢了，所以读 blob 这条路【原理上走不通】，
    //     我前面修的那个 Buffer bug 是真 bug，但修好了也一样读不到东西。
    //   对照：comfyui\output\ 里的同一批原图【有】tEXt（node 直接跑 3/3 通过，seed/steps/cfg 全对）。
    //   ⇒ 唯一可行的路是问宿主半的 /api/meta?name=<磁盘文件名>，它读的是原图。
    //   ★ name 是可选参数：三处调用点里出图页和工作台能直接给出文件名；
    //     图库页拿不到时就不传，自动退回读 blob（那种情况会显示"取不回"而不是"没有元数据"）。
    const readPngMeta = async (url, name) => {
      const empty = { seed: '', positive: '', negative: '', steps: '', cfg: '', sampler: '', size: '', ckpt: '', hasMeta: false };
      // ── ① 先问宿主半：它读 comfyui\output\ 里的原图，那里才有 tEXt ──
      let hostErr = '';
      if (name) {
        try {
          const j = await (await fetch(API + '/meta?name=' + encodeURIComponent(name))).json();
          if (j && j.ok && j.hasMeta) return Object.assign({}, empty, j, { viaHost: true });
          if (j && j.message) hostErr = j.message;   // 例如「文件不在产线目录里：xxx」
        } catch (e) { hostErr = String((e && e.message) || e); }
      }
      // ── ② 退回读 blob（对附件有效，但附件已被转码、通常读不到）──
      try {
        const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
        // 4 字节大端（PNG 的 chunk 长度就是这么存的）—— 手写，不用 Buffer
        const u32 = (i) => ((buf[i] << 24) | (buf[i + 1] << 16) | (buf[i + 2] << 8) | buf[i + 3]) >>> 0;
        const ascii = (a, b) => { let s = ''; for (let k = a; k < b; k++) s += String.fromCharCode(buf[k]); return s; };
        let json = '';
        let i = 8;                       // 跳过 8 字节 PNG 签名
        while (i + 8 <= buf.length) {
          const len = u32(i);
          const typ = ascii(i + 4, i + 8);
          if (typ === 'tEXt') {
            const end = i + 8 + len;
            let z = -1;
            for (let k = i + 8; k < end; k++) { if (buf[k] === 0) { z = k; break } }
            if (z > i + 8 && ascii(i + 8, z) === 'prompt') {
              let val = '';
              for (let k = z + 1; k < end; k++) val += String.fromCharCode(buf[k]);
              json = val;
            }
          } else if (typ === 'IDAT' || typ === 'IEND') break;
          i += 12 + len;                 // 长度4 + 类型4 + 数据 + CRC4
        }
        if (!json) return Object.assign({}, empty, {
          error: hostErr
            ? ('原图读不到（' + hostErr + '），附件那份里也没有元数据 —— 元数据取不回')
            : '这张 PNG 里没有 tEXt/prompt 块',
        });
        const out = Object.assign({}, empty);
        const grab = (re) => { const m = json.match(re); return m ? m[1] : ''; };
        out.seed = grab(/"seed"\s*:\s*(\d+)/);
        out.steps = grab(/"steps"\s*:\s*(\d+)/);
        out.cfg = grab(/"cfg"\s*:\s*([\d.]+)/);
        out.sampler = grab(/"sampler_name"\s*:\s*"([^"]+)"/);
        out.ckpt = grab(/"ckpt_name"\s*:\s*"([^"]+)"/);
        const w = grab(/"width"\s*:\s*(\d+)/), h = grab(/"height"\s*:\s*(\d+)/);
        if (w && h) out.size = w + '×' + h;
        // 提示词：ComfyUI 的 tEXt 里 "text" 字段就是提示词原文。
        // ★ 值里的中文是 \uXXXX 转义的，解一下；顺手把 \" \\ \n 还原。
        const texts = []
        const reText = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g
        let mm
        while ((mm = reText.exec(json)) !== null) {
          let s = mm[1]
          try {
            s = s.replace(/\\u([0-9a-fA-F]{4})/g, (_, c) => String.fromCharCode(parseInt(c, 16)))
                 .replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
          } catch (e) {}
          if (s && s.trim()) texts.push(s)
        }
        out.positive = texts[0] || ''
        out.negative = texts[1] || ''
        out.hasMeta = !!(out.seed || out.positive)
        return out
      } catch (e) { return Object.assign({}, empty, { error: String(e && e.message || e) }) }
    }

    // ══════════════════════════════════════════════════════════════
    // 灯箱左上角的元数据浮层 + 删除按钮（三处灯箱共用一份）
    // ══════════════════════════════════════════════════════════════
    // ★ 爀曦 2026-10-12 的原话：「打开图片在靠近图片左上角位置显示图片的提示词、seed 等信息」，
    //   并且要和原有的「复制图片」「打开文件夹」并列加一个「删除」。
    // ★ 为什么不把元数据塞进底部那条操作栏：提示词可能几百字，横排会把操作栏撑爆；
    //   放左上角、自己滚，图还看得见，符合他的原话。
    // ★ 三个细节：
    //   ① 自己读、自己管状态 —— 打开就异步读一次，关掉用 cancelled 标记作废，不写回父组件；
    //   ② 读不到就直说「没有元数据」（有些图是别处来的、或者非 PNG 没有 tEXt 块）；
    //   ③ 删除按钮走宿主半 /api/delete，并且**要点两次**才真删（第一次变成"确认？"）。
    function MetaBox(props) {
      const url = props.url, name = props.name || '';
      const [meta, setMeta] = react.useState(null);
      const [open, setOpen] = react.useState(true);
      const [armed, setArmed] = react.useState(false);   // 删除是否已进入确认态
      // ★ 删除由组件自己管：三处灯箱各接一行 <MetaBox …/> 就够，不必各写一遍 state 和 fetch。
      //   删完通过 props.onDeleted(name) 通知外面（刷新列表／关掉灯箱），拿不到就算了。
      const [deleting, setDeleting] = react.useState(false);
      const [delMsg, setDelMsg] = react.useState("");
      const doDelete = async () => {
        setDeleting(true); setDelMsg("");
        const done = [];
        // ★★ 图库的图活在【两个地方】，要分两步删（2026-10-12 补）：
        //   ① 磁盘上的 PNG —— 只有「从产线导入」的图才有；DSH 自己生的图不在产线目录，
        //      所以这一步失败是正常的，不能因为它失败就停下。
        //   ② IndexedDB 里那条记录（gallery_history）—— 不删它，图会继续留在图库里，
        //      只是图裂了。所以这一步才是图库页真正需要的。
        //   ★ 判据：props.galleryId 有值 = 这是图库页，要清记录。
        if (name) {
          try {
            const j = await (await fetch(API + '/delete', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name }),
            })).json();
            if (j && j.ok) done.push("文件已移到 output\\_trash");
          } catch (e) { /* 磁盘这步失败不致命，下面还有一步 */ }
        }
        if (props.galleryId) {
          try {
            await dfDelete(props.galleryId);
            done.push("已从图库移除");
          } catch (e) {
            setDelMsg("图库记录删除失败：" + String(e && e.message || e));
            setDeleting(false); setArmed(false);
            return;
          }
        }
        if (done.length) {
          setDelMsg(done.join(" · "));
          // ★ 广播「图库变了」—— 所有正在显示图库/B 列表的地方自己监听重载（见 GalleryPage 里的 effect）。
          //   这样列表和总数会立刻更新，不用手动刷新页面。
          try { window.dispatchEvent(new CustomEvent(GALLERY_CHANGED)) } catch (e) {}
          if (props.onDeleted) props.onDeleted(name);
        } else {
          setDelMsg("没有可删的目标（既不在产线目录，也不是图库记录）");
          setArmed(false);
        }
        setDeleting(false);
      };
      react.useEffect(() => {
        let dead = false;
        setMeta(null); setArmed(false); setDelMsg("");
        if (!url) return () => { dead = true };
        // ★ 带上 name：readPngMeta 会【先问宿主半】读产线原图 —— 附件那份的 tEXt 在入库时就被转码丢了。
        readPngMeta(url, name).then((m) => { if (!dead) setMeta(m) });
        return () => { dead = true };
      }, [url, name]);
      // ★★ 关键：整块浮层必须挡住事件冒泡（2026-10-12 修 —— 这是个真 bug）。
      //   灯箱外层是 onClick: () => setBig(null)「点图外任意处关闭」。
      //   浮层如果不管冒泡，点「删除」时事件会一路传到外层：setArmed(true) 刚执行，
      //   灯箱就被关掉、MetaBox 卸载、状态全丢 —— 表现就是「点了删除没反应」，
      //   再打开还是「删除」而不是「确认删除？」。
      //   ★ 底部那条操作栏（dfBigBar）本来就写了 stopPropagation，我漏了浮层这一块。
      const stop = (e) => e.stopPropagation();
      if (!open) {
        return h("div", { style: S.dfMetaBox, onClick: stop },
          h("button", { style: Object.assign({}, S.btn, { padding: "2px 8px", fontSize: "11px" }),
                        onClick: () => setOpen(true) }, "显示参数"));
      }
      const row = (k, v) => (v ? h("div", null,
        h("span", { style: S.dfMetaKey }, k), h("span", { style: S.dfMetaMono }, v)) : null);
      const params = meta ? [meta.size, meta.steps ? meta.steps + ' 步' : '',
                             meta.cfg ? 'cfg ' + meta.cfg : '', meta.sampler,
                             meta.ckpt].filter(Boolean).join(' · ') : '';
      return h("div", { style: S.dfMetaBox, onClick: stop },
        h("div", { style: { display: "flex", alignItems: "center", marginBottom: "5px" } },
          h("span", { style: { fontWeight: 600, opacity: 0.9 } }, name || "参数"),
          h("span", { style: { flex: 1 } }),
          h("button", { style: Object.assign({}, S.btn, { padding: "1px 7px", fontSize: "10.5px" }),
                        onClick: () => setOpen(false) }, "收起")),
        !meta ? h("div", { style: { opacity: 0.65 } }, "读取中…")
        : !meta.hasMeta ? h("div", { style: { opacity: 0.65 } },
            // ★ 2026-10-12 改：把 readPngMeta 查到的【真正原因】显示出来。
            //   「我读错了」和「这东西本来就没了」不该混成同一句话 ——
            //     · 原图已不在产线目录 → error 里带着宿主半的原话（「文件不在产线目录里：xxx」）
            //     · 原图还在但这张 PNG 没写 tEXt → 「这张 PNG 里没有 tEXt/prompt 块」
            meta.error || "这张图里没有元数据（不是本产线出的 PNG，或者被重新编码过）")
        : h("div", null,
            row("seed", meta.seed),
            row("参数", params),
            meta.positive ? h("div", { style: { marginTop: "6px" } },
              h("div", { style: S.dfMetaKey }, "提示词"),
              h("div", { style: { marginTop: "2px" } }, meta.positive)) : null,
            // ★ 2026-10-12 交叉验证后的修正：这里原来写「负向提示词」，是错的。
            //   用 Python 独立解析四张真图（danfang_00105~00108）发现：tEXt 里只有一个
            //   prompt 块、里面只有一个 CLIPTextEncode —— 也就是说**没有负向**。
            //   本产线 cfg=1.0、负向走 ConditioningZeroOut，负向本来就不参与计算。
            //   而 readPngMeta 是「从原始文本里正则抓所有 "text": "..."」，遇到节点图里
            //   恰好有别的含 text 字段的节点时，会把那个抓进来 —— 标成"负向"就是误导。
            //   所以改成中性说法：只说这是第二条起的其他文本。
            meta.negative ? h("details", { style: { marginTop: "6px", opacity: 0.7 } },
              h("summary", { style: { cursor: "pointer", fontSize: "11px" } },
                "其他文本（第 2 条起 · 本产线 cfg=1.0，负向不参与）"),
              h("div", { style: { marginTop: "3px", fontSize: "11px" } }, meta.negative)) : null),
        // ── 删除（点两次）──────────────────────────────────────
        name ? h("div", { style: { marginTop: "8px", display: "flex", alignItems: "center" } },
          h("button", {
            style: Object.assign({}, S.btn, { padding: "2px 9px", fontSize: "11px",
                   borderColor: armed ? "rgba(255,120,120,0.75)" : undefined,
                   color: armed ? "#ffb4b4" : undefined }),
            disabled: deleting,
            onClick: () => {
              if (!armed) { setArmed(true); return }          // 第一次只是进确认态
              doDelete();
            },
          }, deleting ? "删除中…" : (armed ? "确认删除？" : "删除")),
          h("span", { style: Object.assign({}, S.dfMetaKey, { marginLeft: "8px", marginRight: 0 }) },
            delMsg || (armed ? "再点一次就删（会移到 output\\_trash）" : ""))) : null);
    }

    function blobToPngBlob(blob) {
      if (blob.type === "image/png") return Promise.resolve(blob);
      return new Promise((resolve, reject) => {
        const u = URL.createObjectURL(blob);
        const im = new Image();
        im.onload = () => {
          try {
            const cv = document.createElement("canvas");
            cv.width = im.naturalWidth;
            cv.height = im.naturalHeight;
            cv.getContext("2d").drawImage(im, 0, 0);
            cv.toBlob((b) => {
              URL.revokeObjectURL(u);
              b ? resolve(b) : reject(new Error("转 PNG 失败"));
            }, "image/png");
          } catch (e) { URL.revokeObjectURL(u); reject(e); }
        };
        im.onerror = () => { URL.revokeObjectURL(u); reject(new Error("图读不出来")); };
        im.src = u;
      });
    }

    // 取这张图的完整字节 → 转 PNG → 写剪贴板。返回一个能写进提示的尺寸说明。
    async function dfCopyImage(item) {
      const objUrl = await dfImageUrl(item.attachment);
      const blob = await (await fetch(objUrl)).blob();
      const png = await blobToPngBlob(blob);
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      return Math.round(png.size / 1024) + " KB";
    }

    // 打开这张图在磁盘上的位置（宿主半去调 explorer /select）
    // ★ 用 savedTo（= 产线里的源文件名）定位，它是这条记录里唯一稳定的文件名字段。
    //   取不到就退回 name —— 有些记录是直接存进图库的，没有 savedTo。
    async function dfRevealFile(item) {
      const nm = String((item && (item.savedTo || item.name)) || "");
      if (!nm) return { ok: false, message: "这条记录没有文件名，找不到它在磁盘上的位置" };
      const r = await fetch(API + "/reveal", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: nm }),
      });
      return await r.json();
    }

    // 中性灰描边 + inherit 文字色 —— 浅色深色主题都不用改
    const B1 = "1px solid rgba(128,128,128,0.35)";

    // ══ macOS Big Sur 厚玻璃（2026-10-01 爀曦选的风格）══════════════
    // ★ 灵魂是 saturate()：只模糊、不提饱和度，玻璃是灰的；
    //   提了才有"背景透过来变得更浓"的通透感 —— 做玻璃最常见就败在这一步。
    // ★ 第二关键是顶部那条内高光 inset 0 1px 0 —— 玻璃"浮起来"靠它，不靠外投影。
    // ★ 第三是双层投影：大而散的 0 8px 32px 给体积，小而紧的 0 1px 2px 给贴边。
    const glassBlur = (px, sat) => ({
      backdropFilter: "blur(" + px + "px) saturate(" + sat + "%)",
      WebkitBackdropFilter: "blur(" + px + "px) saturate(" + sat + "%)",
    });
    const GLASS = Object.assign({
      background: "rgba(255,255,255,0.07)",
      border: "1px solid rgba(255,255,255,0.15)",
      boxShadow:
        // ★ 色散：左暖右冷 —— 折射把白光拆开的那一点点彩（iOS 液态玻璃的命门）
        "inset 1.5px 0 0 rgba(255,122,122,0.15), " +
        "inset -1.5px 0 0 rgba(122,172,255,0.17), " +
        // 厚度：受光面 / 背光面
        "inset 0 1px 0 rgba(255,255,255,0.30), " +
        "inset 0 -1px 0 rgba(0,0,0,0.14), " +
        // 悬浮：大而散 + 小而紧
        "0 10px 34px rgba(0,0,0,0.26), 0 1px 2px rgba(0,0,0,0.16)",
    }, glassBlur(28, 190));
    const GLASS_SOFT = Object.assign({
      background: "rgba(255,255,255,0.05)",
      border: "1px solid rgba(255,255,255,0.10)",
      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.14), 0 4px 16px rgba(0,0,0,0.20)",
    }, glassBlur(16, 160));
    const GLASS_DEEP = Object.assign({
      background: "rgba(18,20,28,0.42)",
      border: "1px solid rgba(255,255,255,0.16)",
      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.24), inset 0 -1px 0 rgba(0,0,0,0.16), " +
                 "0 24px 64px rgba(0,0,0,0.45)",
    }, glassBlur(40, 180));

    const S = {
      wrap: { padding: "10px", fontSize: "12px", color: "inherit", display: "flex",
              flexDirection: "column", gap: "9px", height: "100%", overflowY: "auto",
              boxSizing: "border-box" },
      row: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" },
      lab: { opacity: 0.66, minWidth: "44px" },
      inp: Object.assign({ color: "inherit", borderRadius: "10px",
             padding: "6px 11px", fontSize: "12px", outline: "none",
             boxSizing: "border-box" }, GLASS_SOFT),
      ta:  Object.assign({ color: "inherit", borderRadius: "12px",
             padding: "8px 10px", fontSize: "12px", width: "100%",
             boxSizing: "border-box", resize: "vertical",
             fontFamily: "inherit", outline: "none" }, GLASS_SOFT),
      btn: Object.assign({ color: "inherit", borderRadius: "10px",
             padding: "6px 13px", fontSize: "12px", cursor: "pointer" }, GLASS_SOFT),
      btnP: Object.assign({ color: "#fff", borderRadius: "10px",
             padding: "7px 16px", fontSize: "12px", cursor: "pointer", fontWeight: 600,
             background: "rgba(80,150,235,0.62)",
             border: "1px solid rgba(140,190,255,0.45)",
             boxShadow: "inset 0 1px 0 rgba(255,255,255,0.35), 0 6px 20px rgba(40,100,200,0.35)" },
             glassBlur(18, 180)),
      sec: { borderTop: B1, paddingTop: "8px", display: "flex", flexDirection: "column", gap: "7px" },
      dot: (on) => ({ width: "9px", height: "9px", borderRadius: "50%", flex: "0 0 auto",
                      background: on ? "#3ec46d" : "#9aa0a6",
                      boxShadow: on ? "0 0 7px rgba(62,196,109,0.75)" : "none" }),
      hint: { opacity: 0.55, fontSize: "11px", lineHeight: "1.5" },
      err: { color: "#e5484d", fontSize: "11px", whiteSpace: "pre-wrap",
             wordBreak: "break-all", maxHeight: "110px", overflowY: "auto" },
      thumb: { maxWidth: "100%", borderRadius: "6px", border: B1, display: "block" },
      // ── 丹房三页（图库 / 工作台 / 提示词统计）─────────────
      dfTabs: Object.assign({ display: "flex", gap: "6px", alignItems: "center",
                flexWrap: "wrap", borderRadius: "14px", padding: "7px 9px" }, GLASS_SOFT),
      dfTabOn: Object.assign({ color: "#fff", borderRadius: "10px", padding: "5px 15px",
                 fontSize: "12px", cursor: "pointer", fontWeight: 600,
                 background: "rgba(80,150,235,0.60)",
                 border: "1px solid rgba(140,190,255,0.45)",
                 boxShadow: "inset 0 1px 0 rgba(255,255,255,0.35), 0 6px 20px rgba(40,100,200,0.32)" },
                 glassBlur(18, 180)),
      dfTabOff: Object.assign({ color: "inherit", borderRadius: "10px", padding: "5px 15px",
                  fontSize: "12px", cursor: "pointer" }, GLASS_SOFT),
      dfGrid: { display: "grid", gap: "12px",
                gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))" },
      dfCard: Object.assign({ borderRadius: "14px", overflow: "hidden", cursor: "pointer",
                display: "flex", flexDirection: "column" }, GLASS),
      dfPic: { width: "100%", aspectRatio: "3 / 4", objectFit: "cover", display: "block",
               background: "rgba(128,128,128,0.12)" },
      dfMeta: { padding: "7px 9px", fontSize: "10.5px", lineHeight: "1.45", opacity: 0.85 },
      dfEmpty: Object.assign({ display: "flex", flexDirection: "column", alignItems: "center",
                 justifyContent: "center", gap: "10px", padding: "48px 16px", textAlign: "center",
                 fontSize: "12px", lineHeight: "1.7", borderRadius: "16px" }, GLASS_SOFT),
      dfBig: Object.assign({ position: "fixed", inset: "0", zIndex: 9999,
               display: "flex", alignItems: "center", justifyContent: "center", padding: "24px",
               cursor: "zoom-out" }, GLASS_DEEP),
      dfBigImg: { maxWidth: "92%", maxHeight: "92%", borderRadius: "12px",
                  boxShadow: "0 24px 72px rgba(0,0,0,0.6)" },
      // ★ 2026-10-04：大图底部的操作条（复制 / 打开文件夹）
      //   ★ cursor 要改回 default —— 外面那层是 zoom-out，按钮上还是放大镜会很怪
      dfBigBar: Object.assign({ position: "fixed", bottom: "28px", left: "50%",
                  transform: "translateX(-50%)", display: "flex", gap: "10px",
                  padding: "10px 14px", borderRadius: "14px", cursor: "default",
                  alignItems: "center" }, GLASS_DEEP),
      dfBigTip: { fontSize: "11.5px", opacity: 0.8, marginRight: "4px" },
      // ★ 2026-10-12 加：灯箱左上角的元数据浮层（提示词 / seed / 参数）。
      //   位置照爀曦的要求 ——「靠近图片左上角」。用 absolute 挂在灯箱容器里，
      //   容器本身是 fixed inset:0，所以它就是屏幕左上角；再用 maxWidth/maxHeight
      //   收住，免得长提示词糊满整屏把图挡掉。
      //   pointerEvents:auto 是必须的 —— 外面那层 onClick 是「点图外关闭」，
      //   不显式打开的话这一块也会被当成"图外"，点一下就把灯箱关了。
      dfMetaBox: { position: "absolute", top: "14px", left: "14px",
                   maxWidth: "min(560px, 48vw)", maxHeight: "64vh", overflow: "auto",
                   textAlign: "left", background: "rgba(12,12,16,0.66)",
                   backdropFilter: "blur(6px)", border: "1px solid rgba(255,255,255,0.18)",
                   borderRadius: "10px", padding: "10px 12px", fontSize: "11.5px",
                   lineHeight: 1.55, color: "#f2f2f2", whiteSpace: "pre-wrap",
                   wordBreak: "break-word", pointerEvents: "auto", zIndex: 2 },
      dfMetaKey: { opacity: 0.6, marginRight: "5px" },
      dfMetaMono: { fontFamily: "monospace", letterSpacing: "0.2px" },
    };

    const NUM = [["width","宽"],["height","高"],["steps","步数"],["cfg","CFG"],
                 ["denoise","denoise"],["seed","seed"],["batch","批量"],
                 ["ipaWeight","IPA 权重"]];

    // ── 一张图（图库卡片）：自己去把 attachment 换成 objectURL ──────
    function DfCard(props) {
      const it = props.item;
      const [url, setUrl] = react.useState(null);
      const [bad, setBad] = react.useState(false);
      react.useEffect(() => {
        let alive = true;
        if (!it || !it.attachment) { setBad(true); return; }
        dfImageUrl(it.attachment).then((u) => { if (alive) setUrl(u); })
          .catch(() => { if (alive) setBad(true); });
        return () => { alive = false; };
      }, [it && it.id]);
      const when = it && it.createdAt ? new Date(it.createdAt).toLocaleString("zh-CN", { hour12: false }) : "";
      return h("div", {
        style: S.dfCard, title: (it && (it.prompt || it.name)) || "",
        onClick: () => { if (url) props.onOpen(url, it); },
      },
        url
          ? h("img", { src: url, style: S.dfPic, alt: "" })
          : h("div", { style: S.dfPic, title: bad ? "取不到图" : "读取中" }),
        h("div", { style: S.dfMeta },
          h("div", { style: { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } },
            (it && (it.name || it.prompt || it.id)) || "(无名)"),
          h("div", { style: { opacity: 0.6 } }, when),
          props.provider ? h("div", { style: { opacity: 0.6 } }, props.provider) : null));
    }

    // ── 页一 · 图库（和画廊共用同一个 IndexedDB）─────────────────────
    function GalleryPage() {
      const [items, setItems] = react.useState(null);   // null = 还没读完
      const [err, setErr] = react.useState("");
      const [big, setBig] = react.useState(null);
      const [q, setQ] = react.useState("");
      // ★ 2026-10-04：大图操作条的两个状态（复制 / 打开文件夹）
      const [acting, setActing] = react.useState("");   // "" | "copy" | "reveal"
      const [actMsg, setActMsg] = react.useState("");   // 操作结果，显示在操作条左边
      // ★ 2026-10-01：产线产物的导入。
      //   技术线的脚本是直接调 ComfyUI 出图的，图落在 ComfyUI 的 output 目录，
      //   不经过 DSH 的 attachment 系统 —— 所以它不会自己出现在图库里。
      //   这一步就是那座桥：宿主半把文件变成 attachment，这里再写进画廊那本账。
      const [pipe, setPipe] = react.useState(null);     // null = 面板没开
      const [busy, setBusy] = react.useState("");
      const [note, setNote] = react.useState("");

      const load = react.useCallback(() => {
        setErr("");
        dfList().then((list) => setItems(list))
          .catch((e) => { setErr(String((e && e.message) || e)); setItems([]); });
      }, []);

      // ★★★ 2026-10-12 加：删完自动刷新（爀曦：「图库要手动刷新才能消失，应该自动刷新，
      //   而且删除后图库的总数好像也没变」—— 两件是同一个根因：列表数据停在内存里）。
      // ★ 为什么用自定义事件而不是直接调 load：
      //   显示图库的地方不止这一处（还有 loadLib 那一版），MetaBox 是共用组件，
      //   它不该知道"现在是谁在显示列表"。所以删完只广播一句「图库变了」，
      //   谁在显示谁自己监听重载 —— 加一处监听就够，不用让 MetaBox 认识每个页面。
      react.useEffect(() => {
        const onChanged = () => load();
        window.addEventListener(GALLERY_CHANGED, onChanged);
        return () => window.removeEventListener(GALLERY_CHANGED, onChanged);
      }, [load]);

      // 打开面板：问宿主半要 ComfyUI output 目录里的文件清单
      const openPipeline = react.useCallback(() => {
        setNote("");
        setPipe({ loading: true, files: [] });
        api("/pipeline").then((r) => {
          if (!r || !r.ok) {
            setNote("读不到产线目录：" + ((r && r.message) || "未知"));
            setPipe({ loading: false, files: [] });
            return;
          }
          setPipe({ loading: false, files: r.files || [], dir: r.dir });
        }).catch((e) => {
          setNote("读不到产线目录：" + String((e && e.message) || e));
          setPipe({ loading: false, files: [] });
        });
      }, []);

      // 导入一张：宿主半把文件变成 attachment，这里再写进 gallery_history
      // ★ silent=true 时不显示逐张提示（自动同步用）—— 一次导十张会把提示刷屏
      const importOne = react.useCallback(async (nm, silent) => {
        if (!silent) { setBusy(nm); setNote(""); }
        try {
          const r = await api("/import", { method: "POST", body: JSON.stringify({ name: nm }) });
          if (!r || !r.ok) { if (!silent) setNote("导入失败：" + ((r && r.message) || "未知")); return false; }
          const a = r.attachment;
          if (!a || !a.attachmentId) { if (!silent) setNote("宿主半没返回 attachmentId"); return false; }
          await dfPut({
            id: String(a.attachmentId),
            attachment: a,
            name: a.name || nm,
            prompt: "",
            provider: "yanqing-line",
            createdAt: Date.now(),
            // ★ savedTo 存源文件名 —— 自动同步就是靠它判断「这张进过没有」
            savedTo: r.source || nm,
          });
          if (!silent) { setNote("已导入：" + nm); load(); }
          return true;
        } catch (e) {
          if (!silent) setNote("导入失败：" + String((e && e.message) || e));
          return false;
        } finally {
          if (!silent) setBusy("");
        }
      }, [load]);

      // ★ 自动同步（2026-10-01 爀曦要求「做成自动导入」）
      //   把产线目录里**还没进过画廊的**图自动导进来。
      //   判据是 gallery_history 里已有的 savedTo（= 源文件名），不靠时间去猜 ——
      //   时间判据会在「同名覆盖」和「时钟漂移」上出错，文件名是稳的。
      //   ★ 为什么不让 anchor.mjs 自己导：它是命令行脚本，碰不到浏览器的 IndexedDB。
      //     所以「自动」只能在这一侧做，而这里是唯一同时看得见文件清单和那本账的地方。
      //   ★ 时间过滤（2026-10-01 爀曦定）：只自动导入**最近 SYNC_DAYS 天**的。
      //     为什么必须加：output 目录里躺着整个九月攒下的三百多张中间试验品
      //     （yq-cloth-*、yq-face-*、yq-ipa-*、yq-anchor-z-*…），不过滤会把图库直接冲垮。
      //     判据用文件 mtime —— 宿主半的 /api/pipeline 已经把它返回了，不用另加接口。
      //     ★ 旧图不是不能进：点「看产线文件」单独挑，那条路不经过这里、也不过滤。
      const SYNC_DAYS = 3;
      const autoSync = react.useCallback(async (report, days) => {
        const span = days === undefined ? SYNC_DAYS : days;
        // span <= 0 表示不限时间（留给以后"全导"用）
        const since = span > 0 ? Date.now() - span * 24 * 3600 * 1000 : 0;
        try {
          const list = await api("/pipeline");
          if (!list || !list.ok) { if (report) setNote("读不到产线目录。"); return 0; }
          const mine = await dfList();
          const have = new Set(mine.map((x) => String((x && x.savedTo) || "")));
          const fresh = (list.files || []).filter((f) => f && f.name && !have.has(f.name));
          const todo = since > 0 ? fresh.filter((f) => (f.mtime || 0) >= since) : fresh;
          const skipped = fresh.length - todo.length;
          if (todo.length === 0) {
            if (report) {
              setNote(skipped > 0
                ? ("最近 " + span + " 天没有新图（另有 " + skipped + " 张更早的，点「看产线文件」单独挑）。")
                : "产线里没有新图。");
            }
            return 0;
          }
          // ★ 一次最多 20 张：再多会把界面卡住，剩下的下次进来继续
          const batch = todo.slice(0, 20);
          if (report) setNote("发现 " + todo.length + " 张新图（最近 " + span + " 天），正在导入…");
          let n = 0;
          for (const f of batch) { if (await importOne(f.name, true)) n++; }
          if (n > 0) load();
          if (report) {
            setNote("导入了 " + n + " 张"
              + (todo.length > batch.length ? "（还有 " + (todo.length - batch.length) + " 张，再点一次继续）" : "。")
              + (skipped > 0 ? "  另有 " + skipped + " 张更早的没动。" : ""));
          }
          return n;
        } catch (e) {
          if (report) setNote("自动同步失败：" + String((e && e.message) || e));
          return 0;
        }
      }, [importOne, load]);

      // ★ 2026-10-04：大图上的两个动作。
      //   ★ 复制必须在 onClick 的同步调用链里走完第一步（clipboard.write 要用户手势），
      //     但中间要 await 取图 —— 实测这样也可以，手势在点击那一刻已经记上了。
      const doCopy = react.useCallback(async () => {
        if (!big || !big.item) return;
        setActing("copy"); setActMsg("");
        try {
          const kb = await dfCopyImage(big.item);
          setActMsg("已复制到剪贴板（" + kb + "）");
        } catch (e) {
          const m = String((e && e.message) || e);
          setActMsg(m.indexOf("clipboard") >= 0 || m.indexOf("NotAllowed") >= 0
            ? "复制失败：浏览器不让写剪贴板（要在这个页面上点，且 127.0.0.1 才算安全上下文）"
            : "复制失败：" + m);
        } finally { setActing(""); }
      }, [big]);

      const doReveal = react.useCallback(async () => {
        if (!big || !big.item) return;
        setActing("reveal"); setActMsg("");
        try {
          const r = await dfRevealFile(big.item);
          setActMsg(r && r.ok ? ("已在资源管理器里定位：" + r.file) : ("打不开：" + ((r && r.message) || "未知")));
        } catch (e) {
          setActMsg("打不开：" + String((e && e.message) || e));
        } finally { setActing(""); }
      }, [big]);

      // 打开图库就静默同步一次，然后读账本
      react.useEffect(() => { load(); autoSync(false); }, [load, autoSync]);

      // ★ 分类（2026-10-01 爀曦要求：「按时间线、目标、项目阶段，把所有形象分类整理」）
      //
      //   判据用 savedTo（= 产线里的源文件名），因为它是**唯一稳定**的字段：
      //     · prompt 大多是空的（产线导入时没带提示词）
      //     · createdAt 只能排序、分不了类
      //     · savedTo 里带着脚本设的 prefix，而 prefix 是**当初按用途起的名字**
      //   所以分类不是我现在拍脑袋，而是**把磁盘上早就存在的目录习惯翻译到界面上**。
      //
      //   ★ 规则顺序有讲究：**先匹配具体、再匹配笼统** ——
      //     `yq-face-happy` 要落进「表情」而不是「脸」以外的任何地方；
      //     `yq-zimage-*` 要落进「技术线试验」而不是被 `yq-` 兜住。
      //   ★ 加新分类只要往这张表里加一行，**顺序 = 优先级**。
      const CATS = [
        { id: "all", name: "全部" },
        { id: "daily", name: "日常", re: /^(yq-life|daily)/i },
        { id: "trip", name: "出游", re: /^(yq-trip|yq-sunny|yq-summer|yq-outing|yq-walk)/i },
        { id: "pose", name: "立绘·姿势", re: /^(uni-|fb-|yq-pose|yq-stand|yq-fb|yq-sitread|yq-read|yq-lookup|yqlookup)/i },
        { id: "body", name: "立绘·全身", re: /^(yq-full|yq-hero|yq-body|yq-full3d|yq-hero3d|yq-hero2|yq-hero3|yq-hero4|yqfull|yqhero)/i },
        { id: "face", name: "表情·脸", re: /^(yq-face|yq-facecrop|yq-expr|yqexpr|yanqing-face|yanqing-chibi|yq-ts1|yq-ts2)/i },
        { id: "sticker", name: "贴纸", re: /^(yanqing-sticker|yq-sticker|yq-sti)/i },
        { id: "cloth", name: "衣柜·服装", re: /^(yq-cloth|yq-outfit|yq-wardrobe|yqof7|yqoutfit|yq-wardrobe7|yq-outfit-loose)/i },
        { id: "pet", name: "宠物", re: /^(yq-pet|pet-|pet_)/i },
        { id: "video", name: "视频", re: /\.(webm|mp4|gif)$/i },
        { id: "style", name: "画风样张", re: /^(yq-style|yq-sty|yq-anime|yq-soft|yq-realistic)/i },
        { id: "place", name: "壁纸·场景", re: /^(yanqing-wall|yq-desk|yqdsA|yq-room|yq-scene)/i },
        { id: "test", name: "技术线试验", re: /^(yq-|yanqing-|zimage-|dsh-gallery|comfyui-|curl-)/i },
      ];
      const catOf = (it) => {
        const s = String((it && (it.savedTo || it.name)) || "");
        for (const c of CATS) { if (c.id !== "all" && c.re.test(s)) return c.id; }
        return "other";
      };

      // ★ 阶段（2026-10-01 爀曦要求补上第三维：「按时间线、目标、项目阶段分」）
      //
      //   ★ 一个反直觉的事实（当天从时间戳读出来的）：
      //     **这些阶段的日期是重叠的，不是首尾相接的。**
      //     定锚、表情、衣柜、SDXL 几条线在同一段日子里并行跑 —— 所以「阶段」不能按时间切，
      //     只能按**用哪套技术做的**来认，而那就是脚本当初设的 prefix。
      //   ★ 和 CATS 的区别：CATS 答「这是什么」（日常/表情/贴纸），PHASES 答「哪条线做的」。
      //     两个维度可以叠加着筛。
      //   ★ 顺序 = 优先级，从最早的技术排到最新。
      const PHASES = [
        { id: "allp", name: "全部阶段" },
        { id: "p1", name: "① ComfyUI 直出", re: /^(yanqing|ComfyUI|curl-c|dsh-gallery|zimage-)/i },
        { id: "p2", name: "② IPAdapter", re: /^yq-ipa/i },
        { id: "p3", name: "③ 定锚·ControlNet", re: /^(yq-anchor|yq-cn|yq-cnbust|yq-cni2i|yq-takeover|yq-zcn|yq-zi2i|yq-zi2ifull|yq-lcm|yq-hires)/i },
        { id: "p4", name: "④ 表情与衣柜", re: /^(yq-face|yq-expr|yqexpr|yq-cloth|yq-outfit|yq-wardrobe|yqof7|yqoutfit)/i },
        { id: "p5", name: "⑤ 形象定稿", re: /^(yq-body|yq-full|yq-hero|yq-stand|yq-fb|yqfull|yqhero|yq-sty|yqflat|yqabl|yqang|yqcons|yqmod|yqneg|yqlit|yqcmp|yq-final|yq-finalx|yqfixhand|yq-handcrop|yq-handfix|yq-waistfix|yq-inpaint|yq-refine|yq-ref)/i },
        { id: "p6", name: "⑥ SDXL 线", re: /^(yq-sdxl|yqsdxl|yqtriple|yqup|yq-me|yqskin|yq-polish|yqpolish)/i },
        { id: "p7", name: "⑦ Z-Image 期", re: /^(yq-ear|yq-trip|yq-sunny|yq-summer|yq-outing|yq-style|yq-sty|yq-chara|yq-pose|yq-life|yq-desk|yqdsA|yq-sitread|yq-read|yq-lookup|yq-walk|yq-wave|yq-think|yq-free|yq-panel|yq-zimage)/i },
        { id: "p8", name: "⑧ 形象固定之后", re: /^(uni-|daily)/i },
      ];
      const phaseOf = (it) => {
        const s = String((it && (it.savedTo || it.name)) || "");
        for (const p of PHASES) { if (p.id !== "allp" && p.re.test(s)) return p.id; }
        return "pother";
      };

      const [cat, setCat] = react.useState("all");
      const [phase, setPhase] = react.useState("allp");
      const [desc, setDesc] = react.useState(true);   // ★ 默认最新在前（爀曦的原话）

      const kw = q.trim().toLowerCase();
      const counts = {};
      const pcounts = {};
      for (const it of (items || [])) {
        const c = catOf(it); counts[c] = (counts[c] || 0) + 1;
        const p = phaseOf(it); pcounts[p] = (pcounts[p] || 0) + 1;
      }
      counts.all = (items || []).length;
      counts.other = counts.other || 0;
      pcounts.allp = (items || []).length;
      pcounts.pother = pcounts.pother || 0;

      const shown = (items || [])
        .filter((it) => {
          if (cat !== "all" && catOf(it) !== cat) return false;
          if (phase !== "allp" && phaseOf(it) !== phase) return false;
          if (!kw) return true;
          const s = String((it && (it.prompt || it.name || it.negativePrompt || it.savedTo)) || "").toLowerCase();
          return s.indexOf(kw) >= 0;
        })
        // ★ 排序：默认 createdAt 倒序（最新在前）。拿不到 createdAt 的退到 0，沉底。
        .sort((a, b) => {
          const ta = (a && a.createdAt) || 0, tb = (b && b.createdAt) || 0;
          return desc ? tb - ta : ta - tb;
        });

      const right = items === null ? "读取中…"
        : (shown.length + " 张"
           + (cat !== "all" ? " · " + ((CATS.find((c) => c.id === cat) || {}).name || cat) : "")
           + (phase !== "allp" ? " · " + ((PHASES.find((p) => p.id === phase) || {}).name || phase) : "")
           + (kw ? " / 共 " + items.length : ""));

      // ★ 分类 chip 的样式：选中的实心、未选中的描边 —— 沿用这一页已有的玻璃风
      const chip = (c) => {
        const on = cat === c.id;
        const n = counts[c.id] || 0;
        return h("button", {
          key: c.id,
          style: Object.assign({}, S.btn, on ? { background: "rgba(120,170,255,0.34)", fontWeight: 600 } : {}),
          disabled: !on && n === 0,          // 空的分类点不动，免得点出一片空白
          title: c.id === "all" ? "不分类，看全部" : ("只看「" + c.name + "」 " + n + " 张"),
          onClick: () => setCat(c.id),
        }, c.name + (n ? " " + n : ""));
      };

      // ★ 阶段 chip：换个颜色（偏暖），一眼能和上面那排「分类」分开
      const pchip = (p) => {
        const on = phase === p.id;
        const n = pcounts[p.id] || 0;
        return h("button", {
          key: p.id,
          style: Object.assign({}, S.btn, on ? { background: "rgba(255,190,120,0.32)", fontWeight: 600 } : {}),
          disabled: !on && n === 0,
          title: p.id === "allp" ? "不限阶段" : ("只看「" + p.name + "」 " + n + " 张"),
          onClick: () => setPhase(p.id),
        }, p.name + (n ? " " + n : ""));
      };

      return h("div", { style: S.wrap },
        h("div", { key: "bar", style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" } },
          h("input", {
            value: q, placeholder: "在图里找提示词…", onChange: (e) => setQ(e.target.value),
            style: Object.assign({}, S.inp, { flex: "1 1 220px" }),
          }),
          h("button", { style: S.btn, onClick: load, title: "重新读一遍图库那本账" }, "刷新"),
          h("button", {
            style: S.btnP, onClick: () => autoSync(true),
            title: "立刻扫一遍产线目录，把还没进过画廊的图导进来",
          }, "同步产线"),
          h("button", {
            style: S.btn, onClick: () => { pipe ? setPipe(null) : openPipeline(); },
            title: "看产线目录里都有什么（可以挑着单独导入）",
          }, pipe ? "收起文件" : "看产线文件"),
          h("span", { style: S.hint }, right)),
        // ★ 分类栏（2026-10-01）。放在下面单独一行，因为它会随图库长大而变长，
        //   挤在 bar 里会把上面那几个按钮推散。
        h("div", { key: "cat", style: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" } },
          ...CATS.map(chip),
          h("button", {
            style: Object.assign({}, S.btn, counts.other && cat === "other" ? { background: "rgba(120,170,255,0.34)" } : {}),
            disabled: cat !== "other" && !counts.other,
            title: "没有归进任何一类（名字对不上现有规则）",
            onClick: () => setCat("other"),
          }, "其他" + (counts.other ? " " + counts.other : "")),
          h("button", {
            style: S.btn, title: desc ? "现在是「最新在前」，点一下反过来" : "现在是「最早在前」，点一下反过来",
            onClick: () => setDesc((v) => !v),
          }, desc ? "↓ 最新在前" : "↑ 最早在前")),
        // ★ 阶段栏（2026-10-01，第三维）。和分类不同的是它答「哪条线做的」，
        //   用的是同一套前缀判据 —— 因为各阶段的日期是重叠的，切不出干净的时间段。
        h("div", { key: "phase", style: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" } },
          h("span", { style: Object.assign({}, S.hint, { flex: "0 0 auto" }) }, "阶段"),
          ...PHASES.map(pchip),
          h("button", {
            style: Object.assign({}, S.btn, phase === "pother" ? { background: "rgba(255,190,120,0.32)" } : {}),
            disabled: phase !== "pother" && !pcounts.pother,
            title: "前缀对不上任何阶段（多半是早期的零散试验）",
            onClick: () => setPhase("pother"),
          }, "其他" + (pcounts.pother ? " " + pcounts.pother : ""))),
        note ? h("div", { key: "n", style: S.hint }, note) : null,
        pipe
          ? h("div", { key: "p", style: Object.assign({ padding: "9px 11px" },
              pipe.files && pipe.files.length ? GLASS : GLASS_SOFT) },
              h("div", { style: { display: "flex", gap: "8px", alignItems: "center", marginBottom: "7px" } },
                h("span", { style: { fontSize: "12px", fontWeight: 600 } }, "产线产物"),
                h("span", { style: S.hint }, pipe.loading ? "读取中…" : ((pipe.files || []).length + " 个文件")),
                h("span", { style: Object.assign({}, S.hint, { flex: "1 1 auto" }) }, pipe.dir || "")),
              pipe.loading ? null
                : (pipe.files || []).length === 0
                  ? h("div", { style: S.hint }, "这个目录里没有图。技术线出图后会落在 ComfyUI 的 output 目录。")
                  : h("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px", maxHeight: "190px", overflowY: "auto" } },
                      (pipe.files || []).map((f) =>
                        h("button", {
                          key: f.name, style: S.btn, disabled: busy === f.name,
                          title: (f.name + "  " + Math.round((f.size || 0) / 1024) + " KB"),
                          onClick: () => importOne(f.name),
                        }, busy === f.name ? "导入中…" : f.name))))
          : null,
        err ? h("div", { key: "e", style: S.err }, "读图库失败：" + err) : null,
        items !== null && shown.length === 0
          ? h("div", { key: "z", style: S.dfEmpty },
              h("div", null, kw ? "没有匹配的图。" : "图库还是空的。"),
              h("div", { style: S.hint },
                "这里读的就是画廊那本账（IndexedDB dsh_image_gen_db → gallery_history）。",
                h("br"),
                "在画廊里出图、或点上面的「从产线导入」，都会出现在这一页。"))
          : null,
        h("div", { key: "g", style: S.dfGrid }, shown.map((it, i) =>
          h(DfCard, {
            key: (it && it.id) || i, item: it, provider: it && it.provider,
            onOpen: (url, item) => setBig({ url, item }),
          }))),
        big ? h("div", { style: S.dfBig, onClick: () => setBig(null) },
          h("img", { src: big.url, style: S.dfBigImg, alt: "" }),
          // ★ 2026-10-12 加：左上角元数据浮层 + 删除（图库页）
          // ★★ 注意这一处 big 的形状是 { url, item }（见上面 onOpen），**没有 big.name** ——
          //   我第一版接成了 name: big.name，结果是 undefined，删除按钮根本不会出现。
          //   现在从 item 里取名字，并把 item.id（= attachmentId）当 galleryId 传下去，
          //   MetaBox 拿到 galleryId 才知道要额外清一次 IndexedDB 记录。
          h(MetaBox, {
            url: big.url,
            name: (big.item && (big.item.name || big.item.id)) || "",
            galleryId: big.item && big.item.id,
            onDeleted: () => setBig(null),
          }),
          // ★ 2026-10-04 爀曦要的两个动作。
          //   ★ 这一层必须 stopPropagation —— 外面那层 onClick 是「点任意处关闭」，
          //     不拦住的话点按钮会顺手把大图关掉。
          h("div", { style: S.dfBigBar, onClick: (e) => e.stopPropagation() },
            actMsg ? h("span", { style: S.dfBigTip }, actMsg) : null,
            h("button", {
              style: S.btnP, disabled: acting === "copy", onClick: doCopy,
              title: "把这张图的完整原图复制到剪贴板，直接就能粘到别处",
            }, acting === "copy" ? "复制中…" : "复制图片"),
            h("button", {
              style: S.btn, disabled: acting === "reveal", onClick: doReveal,
              title: "在资源管理器里打开它所在的目录并选中这个文件",
            }, acting === "reveal" ? "打开中…" : "打开文件夹"))) : null);
    }

    async function api(path, opts) {
      const r = await fetch(API + path, Object.assign({ headers: { "content-type": "application/json" } }, opts));
      return await r.json();
    }

    function Panel() {
      const [st, setSt] = react.useState(null);        // { running, stats, params, options, paths }
      const [p, setP] = react.useState(null);          // 本地编辑中的参数
      const [busy, setBusy] = react.useState("");
      const [msg, setMsg] = react.useState("");
      const [err, setErr] = react.useState("");
      const [seedUsed, setSeedUsed] = react.useState(null);
      const [jobId, setJobId] = react.useState(null);
      const [files, setFiles] = react.useState([]);
      const [recent, setRecent] = react.useState([]);

      const load = react.useCallback(async () => {
        try {
          const s = await api("/state");
          setSt(s);
          setP((cur) => cur || s.params);
        } catch (e) { setErr("读状态失败：" + String(e && e.message || e)); }
      }, []);

      react.useEffect(() => { load(); }, [load]);

      // 轮询任务；顺带每 5 秒刷一次运行状态
      react.useEffect(() => {
        const t = setInterval(async () => {
          if (jobId) {
            try {
              const j = await api("/job?id=" + encodeURIComponent(jobId));
              if (j.status === "done") {
                setJobId(null); setBusy(""); setMsg("出图完成");
                setFiles(j.files || []); refreshRecent();
              } else if (j.status === "error") {
                setJobId(null); setBusy(""); setErr(j.message || "执行出错");
              }
            } catch (e) { /* 一次失败不停轮询 */ }
          } else {
            try {
              const s = await api("/state");
              setSt((old) => (old ? Object.assign({}, old, {
                running: s.running, stats: s.stats, options: s.options }) : s));
            } catch (e) { /* 同上 */ }
          }
        }, 1500);
        return () => clearInterval(t);
      }, [jobId]);

      const refreshRecent = react.useCallback(async () => {
        try { const r = await api("/recent"); setRecent(r.files || []); } catch (e) {}
      }, []);
      react.useEffect(() => { refreshRecent(); }, [refreshRecent]);

      // ★ 2026-10-01：必须先显示错误 —— 原来只判 !p，fetch 一失败就被「载入中…」盖住，
      //   页面上看不到任何线索（这就是这个面板卡了一整晚的样子）。
      if (err) return h("div", { style: S.wrap },
        h("div", { style: S.err }, "读状态失败：" + err),
        h("div", { style: S.hint }, "接口地址：" + API + "/state"));
      if (!p) return h("div", { style: S.wrap }, "载入中…");

      const set = (k, v) => { const n = Object.assign({}, p); n[k] = v; setP(n); };

      const doStart = async () => {
        setBusy("start"); setErr(""); setMsg("正在拉起 ComfyUI…（首次约 20~25 秒）");
        const r = await api("/start", { method: "POST", body: "{}" });
        setBusy("");
        setMsg(r.ok ? (r.already ? "它本来就在跑" : "已就绪（" + r.seconds + " 秒）") : "");
        if (!r.ok) setErr(r.message || "启动失败");
        load();
      };
      const doStop = async () => {
        setBusy("stop"); setErr(""); setMsg("正在停止…");
        const r = await api("/stop", { method: "POST", body: "{}" });
        setBusy(""); setMsg(r.ok ? "已停止" : ""); if (!r.ok) setErr(r.message || ""); load();
      };
      const doSave = async () => {
        await api("/params", { method: "POST", body: JSON.stringify(p) });
        setMsg("参数已存盘"); load();
      };
      const doGen = async () => {
        setErr(""); setFiles([]); setMsg("排队中…"); setBusy("gen");
        const r = await api("/generate", { method: "POST", body: JSON.stringify(p) });
        if (!r.ok) { setBusy(""); setMsg(""); setErr((r.message || "失败") + (r.detail ? "\n" + r.detail : "")); return; }
        setSeedUsed(r.seed); setJobId(r.id); setMsg("已排队，seed=" + r.seed);
      };

      const opt = (st && st.options) || {};
      const sel = (k, list, width) => h("select", {
        style: Object.assign({}, S.inp, { width: width || "auto" }),
        value: p[k] || "", onChange: (e) => set(k, e.target.value),
      }, (list && list.length ? list : [p[k]]).map((v) => h("option", { key: v, value: v }, v)));

      return h("div", { style: S.wrap },

        // ── 状态条 ─────────────────────────────────────────
        h("div", { style: S.row },
          h("span", { style: S.dot(!!(st && st.running)) }),
          h("b", null, st && st.running ? "ComfyUI 在跑" : "ComfyUI 没在跑"),
          st && st.stats && st.stats.device
            ? h("span", { style: S.hint }, st.stats.device +
                (st.stats.vramTotal ? "  ·  显存 " + (st.stats.vramFree / 1073741824).toFixed(1) +
                 "/" + (st.stats.vramTotal / 1073741824).toFixed(1) + " GB" : ""))
            : null,
          h("span", { style: { flex: 1 } }),
          st && st.running
            ? h("button", { style: S.btn, disabled: busy === "stop", onClick: doStop }, busy === "stop" ? "停止中…" : "停止")
            : h("button", { style: S.btnP, disabled: busy === "start", onClick: doStart }, busy === "start" ? "启动中…" : "启动 ComfyUI"),
        ),

        // ── 提示词 ─────────────────────────────────────────
        h("div", { style: S.sec },
          h("div", { style: S.row }, h("span", { style: S.lab }, "正向"), h("span", { style: S.hint }, "画什么")),
          h("textarea", { style: Object.assign({}, S.ta, { minHeight: "76px" }),
                          value: p.prompt, onChange: (e) => set("prompt", e.target.value) }),
          h("div", { style: S.row }, h("span", { style: S.lab }, "负向"), h("span", { style: S.hint }, "不要什么")),
          h("textarea", { style: Object.assign({}, S.ta, { minHeight: "54px" }),
                          value: p.negative, onChange: (e) => set("negative", e.target.value) }),
        ),

        // ── 参数 ───────────────────────────────────────────
        h("div", { style: S.sec },
          h("div", { style: S.row }, h("span", { style: S.lab }, "模式"),
            h("select", { style: S.inp, value: p.mode, onChange: (e) => set("mode", e.target.value) },
              h("option", { value: "txt2img" }, "txt2img（纯文字）"),
              h("option", { value: "img2img" }, "img2img（以图起稿）"))),
          p.mode === "img2img"
            ? h("div", { style: S.row }, h("span", { style: S.lab }, "起稿图"),
                h("input", { style: Object.assign({}, S.inp, { flex: 1, minWidth: "150px" }),
                             placeholder: "绝对路径，如 D:\\AI\\chat1\\x.png",
                             value: p.initImage, onChange: (e) => set("initImage", e.target.value) }))
            : null,

          h("div", { style: S.row },
            NUM.map(([k, label]) => h("span", { key: k, style: S.row },
              h("span", { style: { opacity: 0.66 } }, label),
              h("input", { type: "number", step: (k === "cfg" || k === "denoise" || k === "ipaWeight") ? "0.05" : "1",
                           style: Object.assign({}, S.inp, { width: "70px" }),
                           value: p[k], onChange: (e) => set(k, Number(e.target.value)) })))),

          h("div", { style: S.row },
            h("span", { style: { opacity: 0.66 } }, "模型"), sel("ckpt", opt.ckpt, "190px")),
          h("div", { style: S.row },
            h("span", { style: { opacity: 0.66 } }, "采样器"), sel("sampler", opt.sampler, "128px"),
            h("span", { style: { opacity: 0.66 } }, "调度器"), sel("scheduler", opt.scheduler, "110px")),
        ),

        // ── IPAdapter ──────────────────────────────────────
        h("div", { style: S.sec },
          h("label", { style: S.row },
            h("input", { type: "checkbox", checked: !!p.ipaOn, onChange: (e) => set("ipaOn", e.target.checked) }),
            h("span", null, "IPAdapter 参考图"),
            h("span", { style: S.hint }, "出角色图靠它保脸；权重越高越像，但会把参考图的姿态一起带过来")),
          p.ipaOn
            ? h("input", { style: Object.assign({}, S.inp, { width: "100%", boxSizing: "border-box" }),
                           placeholder: "参考图绝对路径",
                           value: p.ipaRef, onChange: (e) => set("ipaRef", e.target.value) })
            : null,
        ),

        // ── 动作 ───────────────────────────────────────────
        h("div", { style: S.sec },
          h("div", { style: S.row },
            h("button", { style: Object.assign({}, S.btnP, { opacity: busy ? 0.55 : 1 }),
                          disabled: !!busy, onClick: doGen }, busy === "gen" ? "生成中…" : "生成"),
            h("button", { style: S.btn, onClick: doSave }, "存参数"),
            h("button", { style: S.btn, onClick: () => { setP(Object.assign({}, p, { seed: -1 })); setMsg("seed 已设为随机"); } }, "随机 seed"),
            seedUsed !== null ? h("span", { style: S.hint }, "seed " + seedUsed) : null),
          msg ? h("div", { style: S.hint }, msg) : null,
          err ? h("pre", { style: S.err }, err) : null,
        ),

        // ── 结果 ───────────────────────────────────────────
        (files.length || recent.length)
          ? h("div", { style: S.sec },
              h("div", { style: S.row }, h("span", { style: S.lab }, "结果"),
                h("span", { style: S.hint }, "点图放大 · 文件在 " + ((st && st.paths && st.paths.outDir) || ""))),
              (files.length ? files : recent.slice(0, 6)).map((f) =>
                h("img", { key: f, style: S.thumb, src: API + "/img?f=" + encodeURIComponent(f),
                           onClick: () => window.open(API + "/img?f=" + encodeURIComponent(f), "_blank") })),
            )
          : null,

        h("div", { style: S.hint },
          "宿主半跑在 DSH 进程里，启停的是本机那份 ComfyUI。参数落盘，改完不用重启 DSH。"),
      );
    }

    // 注册成【顶部标签栏】的一格 —— 照砚台（dsh-yantai）那条路。
    // ★★ 2026-10-01 实测：这个 fork 走右栏（sidebarRightTabs + sidebar.right.pane.tab）
    //    在桌面端挂不上，宿主半路由一直 404；而 conversation.view 是本机唯一验证成功过的槽位
    //    （砚台就挂在那儿）。所以这里改成和砚台同一种挂法。
    // ★ exports.inject 只写 ["slots"] —— 多写一个当前环境不存在的服务名，
    //    cordis 会一直等它，apply 永不执行，表现为完全静默（砚台踩过一次）。
    // ── 衣柜：砚青自己的衣服（2026-10-06 爀曦要的）──────────────────
    // ★ 为什么叫「衣柜」而不是「服装预设」：skin.json 里本来就写着
    //   「默认穿**我自己在衣柜里挑的**深藏青圆领长裙」—— 这个词是长在设定里的，不是新造的概念。
    // ★ 怎么用：点一下 chip，把那套的提示词**填进下面的服装输入框**（还能再手改）。
    //   走的是已有的 `--outfit` 那条路 —— 宿主半一个字都不用动，不用重启 DSH 也能生效。
    // ★ 每套的来处写在 d 里。衣服要有出处，不然就只是一堆形容词。
    // ★ 两份页面共用这一份数据（DrawPage 和 WorkbenchPage 都从这里取）——
    //   加一套只改这里一处，不会再出现「两个页面不一样」的问题。
    const WARDROBE = [
      { k: 'navy', t: '深藏青', d: '房间里的我 · 默认（skin.json 的原文）',
        p: '深藏青色的圆领长袖连衣裙，布料柔软垂坠，没有花纹、没有蕾丝、没有围裙、没有蝴蝶结，腰间不收腰，裙长到脚踝；脚穿深色软底平底鞋' },
      { k: 'lolita', t: '洛丽塔', d: '绣球花园那套 · 2026-10-06 定妆照',
        p: '白底浅蓝的洛丽塔连衣裙：泡泡短袖，领口与袖口一圈白色蕾丝，胸前一个小的浅蓝缎带蝴蝶结，腰间系一条宽浅蓝缎带打成大蝴蝶结、缎带垂到裙摆；裙摆三层，白色蕾丝与浅蓝缎面交替；双腿穿白色连裤袜，脚穿浅蓝色圆头玛丽珍鞋' },
      { k: 'summer', t: '浅色夏装', d: '出门晒太阳（skin.json 的授权：有太阳就穿浅色）',
        p: '浅蓝白色的无袖夏日连衣裙，棉麻质地，方领，裙长到膝盖，腰间一条细白棉绳；脚穿白色帆布鞋' },
      { k: 'coat', t: '青蓝内衬', d: 'Live2D 出身 · 深灰紫外套 + 亮青蓝内衬',
        p: '深灰紫色的长外套敞开，露出明亮的青蓝色内衬，里面穿白衬衫和深色V领马甲，下身米白色层叠裙，深色连裤袜，棕色短靴' },
      { k: 'home', t: '居家', d: '在家 · 软的、宽的、不勒的',
        p: '宽松的米白色针织毛衣，袖子长过手背，下身是柔软的深灰色长裙；脚穿浅色棉袜' },
      { k: 'study', t: '干活', d: '书房里 · 袖子挽到手肘',
        p: '白色宽松衬衫，袖子挽到手肘，深色直筒长裤，衬衫下摆束进裤腰；脚穿深色平底鞋' },
      // ★ 2026-10-07 00:28 爀曦看那张床上照之后要补的第七套：「补一套你的睡衣吧，嘻嘻」。
      //   词照那张图写 —— 浅蓝、细吊带、细白蕾丝、长度到膝盖上方。
      { k: 'sleep', t: '睡觉', d: '睡前 · 照 2026-10-07 那张床上照补的',
        p: '浅蓝色的细吊带睡裙，领口和裙摆一圈细白蕾丝，布料柔软轻薄，裙长到膝盖上方；赤脚' },
    ];

    // ── ★★★ 两个出图引擎的规格表（2026-10-11 加）─────────────────────────
    // 爀曦要的：「丹房的工作台也要同步接入 qwen image 啦，给两个模型接口供我选择」
    //   ＋「不同模型会有不同的支持规格，切换模型的时候也要同步切换到它支持的所有规格」。
    // ★★ 为什么这张表只能在【前端】：两个脚本（anchor.mjs / qwen-anchor.mjs）的 --size 都是
    //    【原样透传】——脚本层没有白名单，传什么给什么。所以「这个模型支持哪些规格」
    //    这件事没有别的地方可以定义（宿主半 index.js 也只是把它转发下去）。
    // ★★ 表里只许写【实测跑通】的规格，这是纪律：
    //    · Z-Image 那份 = 2026-10-11 当晚逐张真跑出来的（同一句场景、同一个 seed 各一张）
    //    · Qwen 那份   = 当天实测跑通的七档（见 05-文档\工作台接Qwen-设计-20261011.md §3.1）
    //    「历史产物里出现过」不等于「现在还能用」——没验过的不许写进来。
    // ★ s = 实测单张秒数：进度条拿它当 100% 的基准，界面上的「约几分钟」也从它算。
    // ★ 两个引擎共用同一套表单（场景 / 服装 / 年龄档 / 画风 / seed），这里只切三样东西：
    //    ① 发给宿主半的 stage（脚本注册表那一头）　② 尺寸下拉的整张表　③ 文案与进度基准
    const ENGINES = {
      zimage: {
        k: 'zimage', stage: 'anchor', t: 'Z-Image', short: 'Z-Image', tech: '9 节点纯 Z-Image',
        d: '当前默认 · 9 节点纯 Z-Image（跟着插件走的 anchor.mjs）',
        // 界面上列哪几档画风 = 脚本 STYLES 里真有的那几档（顺序就是显示顺序，第一项是默认）
        styles: ['soft', 'softcel', 'anime', 'realistic', 'none'],
        // anchor.mjs 的 CHARACTERS 里有两个人（砚青 / 大肥鱼）
        chars: ['砚青', '大肥鱼'],
        // ★★ 2026-10-11 当晚逐张实测（同一句场景、同一个 seed；除 1152x1728 外都在队列空时跑）——
        //   这几行不是从历史产物里抄的，是这一轮真跑出来的纯执行耗时（ComfyUI history 的
        //   execution_success − execution_start），产物像素也逐个读 PNG 头核过：
        //     832x1216  138.4s ｜ 1216x832 121.7s ｜ 1024x1024 116.8s
        //     640x960    63.3s ｜ 480x832   44.7s ｜ 512x512    28.2s
        //   ★ 1152x1728【不进这张表】：它真出了图（2292615 B，像素核对无误），但纯执行 820.9 秒
        //     （13.7 分钟），超过了 anchor.mjs 自己的 5 分钟轮询上限 —— 界面上选它必然显示失败。
        //     「能画出来」和「这条路能跑通」是两件事，这里只收后者。
        //   ★ 设计文档 §3.2 那张表里其余几项（704x1280 / 704x1248 / 576x1024 / 512x768）
        //     本轮没验，所以一个都没写进来。
        sizes: [
          { v: '832x1216',  n: '主力 · 竖构图', s: 138 },
          { v: '1216x832',  n: '横构图', s: 122 },
          { v: '1024x1024', n: '方图', s: 117 },
          { v: '640x960',   n: '中竖图', s: 63 },
          { v: '480x832',   n: '小竖图', s: 45 },
          { v: '512x512',   n: '小方图', s: 28 },
        ],
      },
      qwen: {
        k: 'qwen', stage: 'qwen', t: 'Qwen-Image', short: 'Qwen-Image', tech: 'Qwen-Image 2.1 Turbo',
        d: 'Qwen-Image 2.1 Turbo · 自然语言提示词（02-脚本\\qwen-anchor.mjs）',
        // ★★ 2026-10-12 补上 softcel，两边档位对齐。
        //   起因：爀曦说大肥鱼那张「跳脱出彩铅的风格了，更接近插画」，又说「这个画风也要保留，
        //   彩铅的也不错」—— 两版他都要。查下来 qwen 的 STYLES 原本就只有四档，
        //   而**彩铅那版一直只活在实验脚本的 --style-raw 里**（我发他的图全是那么跑的），
        //   所以工作台选 soft 出来的和那批图对不上。现在 softcel 进了 STYLES，对得上了。
        //   ★ soft = 纯插画感；softcel = soft + 两个调色指令（压低暖色、统一色相 ⇒ 彩铅的均匀色块）。
        //     代价与收益见 qwen-anchor.mjs 里那一档的注释。
        //   ★ 顺序照 z-image 那份，两个引擎读起来一致。
        styles: ['soft', 'softcel', 'anime', 'realistic', 'none'],
        // ★★ 2026-10-11 解禁：大肥鱼已经真的移植到 qwen 线了，不再是「静默回落成砚青」。
        //   做法是把那段设定抽成共享模块 scripts\fish-identity.mjs，两条线各自 import ——
        //   一份真源，两份不会再漂（当初反对复制粘贴的理由就是这个）。
        //   同 seed 832x1216 首张实测：鲸鳍耳（眼睛高度、朝外下方斜垂、内侧白褶边）、
        //   腰后鲸尾、围裙角的小鲸鱼、呆毛、深蓝紫发转淡 —— 身份特征逐项可辨。
        //   产物：03-实验产物\edge\yq-qw-H2-fish_00001_.png
        chars: ['砚青', '大肥鱼'],
        sizes: [
          { v: '832x1216',  n: '竖构图主力 · 最快', s: 137 },
          { v: '1216x832',  n: '横构图 · 环境照', s: 127 },
          { v: '1024x1024', n: '方图', s: 149 },
          { v: '1216x1216', n: '大图', s: 208 },
          { v: '1408x1408', n: '大图', s: 308 },
          { v: '1536x1536', n: '接近甜点上限', s: 350 },
          { v: '2048x2048', n: '极限 · 能跑但不划算', s: 764 },
        ],
      },
    };
    // 顺序 = 界面上的顺序（Z-Image 在前，它是现在的默认）
    const ENGINE_LIST = [ENGINES.zimage, ENGINES.qwen];

    // ── 页二 · 出图：生图线（2026-10-06 加）──────────────────────
    // ★★ 这是【当前生效的生图线】的界面 —— anchor.mjs 的 9 节点纯 Z-Image。
    //    依据 05-文档\00-当前生效流程-20261004.md：
    //    没有 IPAdapter、没有 ControlNet、没有白模、没有 LoRA、没有放大重绘。
    // ★ 提示词只写【场景与动作】：身份串 CHARA 和画风 soft 都冻在 anchor.mjs 里，
    //    在这里重复写身份词反而会挤掉场景（10-04 那份文档的原话：朴素的正向词 + 好底模最稳）。
    // ★ 一次四张（爀曦 2026-10-06 定）——宿主半顺序跑四个 seed（+137 递推），跑完一起贴出来挑。
    //   单张约 2.1 分钟，四张约 8-9 分钟。
    function DrawPage() {
      const AGES = [
        { k: 'young',   t: 'young',   d: '脸圆、眼大、头身比偏小' },
        { k: 'mid',     t: 'mid',     d: '中间' },
        { k: 'mature',  t: 'mature',  d: '脸型拉长、下巴清楚（默认）' },
        { k: 'classic', t: 'classic', d: '浅蓝连衣裙 + 缎带腰' },
      ];
      // ★★ 这个列表和 WorkbenchPage 里那份是**两份**（历史原因，见 page-2 注释）——
      //    加一档必须两处一起加，少改一处就会出现「这个页面有、那个页面没有」的怪象。
      const STYLES_ = [
        { k: 'soft', t: 'soft', d: '全局默认画风（爀曦 2026-10-01 拍板）' },
        { k: 'softcel', t: 'softcel', d: '柔边赛璐璐 —— 赛璐璐色阶分块 + 柔化边界（爀曦 2026-10-06 定名；照大肥鱼三视图拆的，样张见 03-实验产物\\style\\）' },
        { k: 'anime', t: 'anime', d: '更重的动漫味' },
        { k: 'realistic', t: 'realistic', d: '写实' },
        { k: 'none', t: 'none', d: '不给画风词（会自己往写实飘）' },
      ];
      // ★★★ 2026-10-06 爀曦实测：「我一离开工作台，切到别的界面，它就中断了，
      //   而且点回来，提示词也不能保留在输入窗口里。」
      //   根子是一件事：切走 = React 组件被卸载 = 它所有的 state 一起没了。
      //   而【任务本身没中断】—— 真正干活的是宿主半的子进程，跟前端没关系；
      //   丢的只是「看的那个窗口」。
      //   ⇒ 所以把输入和 jobId 存到 localStorage：组件卸载了它们还在，
      //     切回来时重新挂载 → 读回来 → 轮询接上 → 进度接着显示。
      const LSKEY = 'df.draw.v1';
      const saved = (() => { try { return JSON.parse(localStorage.getItem(LSKEY) || '{}') || {}; } catch (e) { return {}; } })();

      const [scene, setScene] = react.useState(typeof saved.scene === 'string' ? saved.scene : '');
      // ★ 2026-10-06 爀曦要的：服装也开一个输入窗口。
      //   留空 = 什么都不传，anchor.mjs 就用上面年龄档那套默认服装（行为跟以前一模一样）；
      //   填了 = 传 --outfit，它【优先于 --age】（那是 anchor.mjs 里写死的优先级）。
      const [outfit, setOutfit] = react.useState(typeof saved.outfit === 'string' ? saved.outfit : '');
      const [age, setAge] = react.useState(saved.age || 'mature');
      const [style, setStyle] = react.useState(saved.style || 'soft');
      // ★★★ 2026-10-11 加：出图引擎（Z-Image / Qwen-Image 二选一）。
      //   初始化要连尺寸一起算：saved.size 可能不在这个引擎的规格表里（以前只有一张表），
      //   那就落回该表的第一项 —— 否则 select 显示 A、state 里是 B，
      //   提交时会发一个这个模型根本没测过的尺寸。
      const [engine, setEngine] = react.useState(ENGINES[saved.engine] ? saved.engine : 'zimage');
      const [size, setSize] = react.useState(() => {
        const e = ENGINES[saved.engine] ? saved.engine : 'zimage';
        const list = ENGINES[e].sizes.map((x) => x.v);
        return list.indexOf(saved.size) >= 0 ? saved.size : list[0];
      });
      const [count, setCount] = react.useState(saved.count || 4);
      const [seed, setSeed] = react.useState(typeof saved.seed === 'string' ? saved.seed : '');
      const [jobId, setJobId] = react.useState(saved.jobId || null);
      const [job, setJob] = react.useState(null);
      const [err, setErr] = react.useState('');
      const [msg, setMsg] = react.useState('');
      const [shots, setShots] = react.useState([]);
      // ★ 2026-10-06 爀曦：「点击它不能放大」。原来我用的是 window.open(url,'_blank') ——
      //   在桌面端的 Electron 壳里这个 API 经常被静默拦掉，点了等于没点。
      //   ⇒ 改成页面内自己弹一层：不依赖浏览器开窗口，谁都拦不住。
      const [big, setBig] = react.useState(null);
      const [openChara, setOpenChara] = react.useState(false);

      // 每一次改动都写回去 —— 这样「切走再回来」等于什么都没发生
      react.useEffect(() => {
        try {
          localStorage.setItem(LSKEY, JSON.stringify({ scene, outfit, age, style, engine, size, count, seed, jobId }));
        } catch (e) { /* 存不进去也不该把界面搞挂 */ }
      }, [scene, outfit, age, style, engine, size, count, seed, jobId]);

      const running = !!(job && job.status === 'running');

      // ★★★ 2026-10-06 爀曦第二次问「它有没有在运行」—— 让界面自己会说话，才是真的解决。
      //   原来只有「点了按钮之后」才有反馈；现在【什么都不做也一直有反馈】：
      //   每 3 秒自己探一次后端，把「通不通、几毫秒、ComfyUI 在不在、队列忙不忙」
      //   摆在最上面。它同时是个诊断器 —— 连不上就把原因原文摊开给人看。
      const [probe, setProbe] = react.useState({ state: 'probing' });
      const [elapsed, setElapsed] = react.useState(0);
      react.useEffect(() => {
        let alive = true;
        const tick = async () => {
          const t0 = Date.now();
          try {
            const r = await (await fetch(API + '/stages')).json();
            let comfy = null;
            try { comfy = !!(await (await fetch(API + '/state')).json()).running; } catch (e) { comfy = null; }
            if (alive) setProbe({ state: 'ok', ms: Date.now() - t0, busy: !!r.busy,
                                  n: (r.stages || []).length, comfy });
          } catch (e) {
            if (alive) setProbe({ state: 'fail', ms: Date.now() - t0,
                                  err: String((e && e.message) || e), url: API });
          }
        };
        tick();
        const t = setInterval(tick, 3000);
        return () => { alive = false; clearInterval(t); };
      }, []);

      // 跑着的时候自己数秒 —— 盯着一个不动的数字看两分钟，人会开始怀疑人生
      react.useEffect(() => {
        if (!running) { setElapsed(0); return; }
        const t = setInterval(() => setElapsed((x) => x + 1), 1000);
        return () => clearInterval(t);
      }, [running]);

      // 跑完 → 把产物的磁盘路径换成能在页面上显示的图
      // 链路：/api/import 把文件变成 DSH attachment → dfImageUrl 换 objectURL
      const loadShots = react.useCallback(async (paths) => {
        const names = (paths || []).map((x) => String(x).split('\\').pop()).filter(Boolean);
        const out = [];
        for (const nm of names) {
          try {
            const r = await fetch(API + '/import', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name: nm }),
            });
            const j = await r.json();
            if (j && j.ok && j.attachment) {
              const url = await dfImageUrl(j.attachment);
              out.push({ name: nm, url, kb: Math.round((j.bytes || 0) / 1024), att: j.attachment });
            }
          } catch (e) { /* 单张失败不影响其他 */ }
        }
        setShots(out);
      }, []);

      react.useEffect(() => {
        if (!jobId) return;
        let stop = false;
        const tick = async () => {
          try {
            const j = await (await fetch(API + '/stage?id=' + encodeURIComponent(jobId))).json();
            if (stop || !j || !j.ok) return;
            setJob(j);
            if (j.status !== 'running') {
              setMsg(j.status === 'done'
                ? '出好了（' + j.seconds + ' 秒）—— 共 ' + ((j.outputs || []).length || 0) + ' 张'
                : '出错了（exit ' + j.code + '）看下面的日志');
              if (j.status === 'done') loadShots(j.outputs);
            }
          } catch (e) { /* 一次失败不停轮询 */ }
        };
        const t = setInterval(tick, 1500);
        tick();
        return () => { stop = true; clearInterval(t); };
      }, [jobId, loadShots]);

      // ★★★ 2026-10-11：当前引擎的那张规格表 —— 下拉、进度基准、文案全从它取。
      //   切换引擎 = 这几样一起换（爀曦的原话：「注意是所有规格哦」）。
      const curSizes = ENGINES[engine].sizes;
      const sizeSec = ((curSizes.filter((x) => x.v === size)[0]) || curSizes[0]).s;
      // ★ 画风档也要按引擎过滤 —— 这是【实测出来的差异】，不是猜的：
      //   qwen-anchor.mjs 的 STYLES 只有 soft / anime / realistic / none，
      //   没有 softcel（那是为 z-image 拆的档）。不过滤的话，在 Qwen 下选 softcel
      //   会让脚本 exit 2「未知画风：softcel」—— 界面列了一个它不认的档。
      const styleList = STYLES_.filter((s) => ENGINES[engine].styles.indexOf(s.k) >= 0);
      const pickEngine = (k) => {
        if (k === engine) return;
        setEngine(k);
        // 当前尺寸不在新表里 → 落到新表第一项，不让 state 和下拉对不上
        if (ENGINES[k].sizes.map((x) => x.v).indexOf(size) < 0) setSize(ENGINES[k].sizes[0].v);
        // 当前画风不在新引擎的档位里 → 回落到新引擎的第一档（两个引擎都是 soft）
        if (ENGINES[k].styles.indexOf(style) < 0) setStyle(ENGINES[k].styles[0]);
      };

      // ★ 2026-10-06：爀曦连点三次都没反应，而后端日志显示请求压根没发出来。
      //   代码逐行读过、h/react 都是对的、onChange 也能工作 —— 那就别再赌 onClick 一定会响。
      //   两个事件都绑（onMouseDown + onClick），用 800ms 窗口去重，避免同一次点击跑两遍。
      const fireGuard = react.useRef(0);
      const fire = () => {
        const now = Date.now();
        if (now - fireGuard.current < 800) return;
        fireGuard.current = now;
        run();
      };

      const run = async () => {
        // ★★★ 2026-10-06 最强探针：浏览器原生标题栏，不经过 React 重渲染。
        //   爀曦连点三次都不响，而代码我逐行看过、h/react/state 全对、onChange 也能工作。
        //   那就让「到底有没有被点到」这件事绕开整个 React，直接写进窗口标题：
        //     标题变了  = 事件响了，问题在渲染；
        //     标题没变  = 事件真的没到，问题在更外层（遮罩 / 表单 / 事件系统）。
        //   这一条不依赖任何前端框架，浏览器不会骗人。
        try { document.title = '① 按下了 ' + new Date().toLocaleTimeString(); } catch (e) {}

        setErr(''); setJob(null); setShots([]);
        if (!scene.trim()) {
          setMsg('');
          try { document.title = '① 但场景是空的'; } catch (e) {}
          setErr('还没写场景呢 —— 身份和画风不用你写，它们冻在代码里');
          return;
        }
        // ★★ 2026-10-06 爀曦实测反馈：「点了出图，没有反馈模型的工作状态，不知道它有没有执行」。
        //    根因是原来只在【fetch 成功之后】才 setMsg —— 在那之前界面一片死寂，
        //    而 fetch 万一没发出去，人也只会看到一行不起眼的小字。
        //    ⇒ 现在按下就立刻显示第一步，每一步都留下痕迹；失败时把 API 地址也打出来，
        //      因为「请求发不出去」最常见的死因就是那个地址算错了（electron 的 location.origin
        //      可能不是 http，那就该回退到 127.0.0.1:19387）。
        setMsg('① 按下了 —— 正在发给后端 ' + API + ' …');
        try {
          const r = await (await fetch(API + '/stage', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              // ★ 2026-10-11：用宿主半的哪一个脚本，由引擎决定（anchor=Z-Image / qwen=Qwen-Image）
              stage: ENGINES[engine].stage,
              params: {
                prompt: scene.trim(), age, style, size,
                // ★ 空串照传没关系：宿主半是 `if (q.outfit)` 判的 —— 空串 falsy，
                //   于是 --outfit 不发、--age 正常发（默认服装那条路一个字没变）。
                outfit: outfit.trim(),
                count: Number(count) || 4,
                seed: String(seed || '').trim(),
                prefix: 'danfang',
              },
            }),
          })).json();
          if (!r.ok) {
            setMsg('');
            try { document.title = '② 后端不肯收：' + (r.message || ''); } catch (e) {}
            setErr('② 后端不肯收：' + (r.message || '（它没给理由）'));
            return;
          }
          try { document.title = '② 后端收下了 ' + r.id + '（' + (r.total || 1) + ' 张）'; } catch (e) {}
          setMsg('② 后端收下了（任务 ' + r.id + '，共 ' + (r.total || 1) + ' 张）—— ' +
                 ENGINES[engine].short + ' 单张约 ' + (sizeSec / 60).toFixed(1) + ' 分钟（' + size + '），出完一起贴出来');
          setJobId(r.id);
        } catch (e) {
          setMsg('');
          try { document.title = '② 发不出去：' + String((e && e.message) || e); } catch (e2) {}
          setErr('② 请求没发出去：' + String((e && e.message) || e) +
                 '\n\n（要发给的地址是 ' + API + ' —— 如果它看起来不对，问题就在这儿）');
        }
      };

      const chip = (on, onClick, label, title) => h('button', {
        key: label, style: Object.assign({}, on ? S.btnP : S.btn,
          { padding: '3px 10px', fontSize: '12px' }),
        title: title || '', onClick,
      }, label);

      return h('div', { style: S.wrap },
        h('div', { style: S.row },
          h('span', { style: { fontSize: '13px', fontWeight: 600 } }, '出图'),
          h('span', { style: S.hint }, ENGINES[engine].tech + ' · 这个尺寸单张约 ' + (sizeSec / 60).toFixed(1) + ' 分钟'),
          h('span', { style: { flex: 1 } }),
          h('button', { style: Object.assign({}, S.btn, { padding: '2px 8px', fontSize: '11px' }),
                        onClick: () => setOpenChara(!openChara) },
            openChara ? '收起身份串' : '看身份串'),
        ),
        h('div', { style: S.hint },
          '★ 只写场景和动作 —— 身份（CHARA）和画风都冻在 anchor.mjs 里，这里写重了反而挤掉场景。'),
        openChara ? h('pre', { style: { fontSize: '11px', lineHeight: 1.5, whiteSpace: 'pre-wrap',
                                        background: 'rgba(128,128,128,0.08)', padding: '8px',
                                        borderRadius: '6px', margin: '2px 0 0' } },
          'CHARA（自动前置 · 身份层）\n' +
          '  Z-Image 线：anchor.mjs 的 CHARA_YANQING（英文四行）\n' +
          '  Qwen 线  ：qwen-anchor.mjs 的 CHARA_YANQING（中文长描述，约 380 字）\n' +
          '  ★ 2026-10-12 起两条线的身份串【不再相同】—— 爀曦的判断是\n' +
          '    qwen 的文字遵循能力强，身份串给得越详细、一致性越稳（大肥鱼那条就是六百字中文、首张通过）。\n' +
          '  ★ 这里【有意不复制全文】：复制就会漂，今晚已经栽过两次。\n' +
          '    要看当前生效的，直接读那两个常量 —— 脚本是唯一真源。\n\n' +
          '四段拼接顺序（是判据，不是风格）：\n' +
          'CHARA（身份）→ outfit（服装/年龄档）→ 你写的（场景/动作）→ echo → STYLES[' + style + ']（画风）') : null,

        // ── ★ 状态条：什么都不做也一直有反馈（爀曦 2026-10-06 要的）──────────
        h('div', { style: { fontSize: '11.5px', lineHeight: 1.9, padding: '7px 10px', marginTop: '6px',
                            borderRadius: '7px',
                            background: probe.state === 'fail' ? 'rgba(248,113,113,0.14)' : 'rgba(148,163,184,0.10)',
                            border: '1px solid ' + (probe.state === 'fail' ? 'rgba(248,113,113,0.45)' : 'rgba(148,163,184,0.28)') } },
          probe.state === 'probing'
            ? h('span', { style: S.hint }, '● 正在探后端…')
            : probe.state === 'fail'
              ? h('span', { style: { color: '#f87171' } },
                  '✗ 后端连不上（' + probe.ms + 'ms）：' + probe.err + '　地址 = ' + probe.url)
              : h('span', null,
                  '✓ 后端 ' + probe.url + '（' + probe.ms + 'ms，' + probe.n + ' 个阶段）　·　' +
                  (probe.comfy ? '✓ ComfyUI 在跑' : '· ComfyUI 没在跑') + '　·　' +
                  (probe.busy ? '● 队列在跑' : '· 队列空闲')),
        ),

        // ── ★ 进度条：跑的时候才出现 ─────────────────────────
        job && job.status === 'running'
          ? h('div', { style: { fontSize: '12px', padding: '8px 10px', marginTop: '6px',
                                borderRadius: '7px', background: 'rgba(96,165,250,0.14)',
                                border: '1px solid rgba(96,165,250,0.45)' } },
              h('div', null,
                '● 正在画第 ' + ((job.runIndex || 0) + 1) + ' / ' + (((job.runs || []).length) || 1) + ' 张' +
                '　已跑 ' + Math.floor(elapsed / 60) + ' 分 ' + (elapsed % 60) + ' 秒' +
                '　（这个尺寸约 ' + (sizeSec / 60).toFixed(1) + ' 分钟）'),
              h('div', { style: { marginTop: '5px', height: '4px', borderRadius: '2px',
                                  background: 'rgba(148,163,184,0.25)', overflow: 'hidden' } },
                h('div', { style: { height: '4px', borderRadius: '2px', background: '#60a5fa',
                                    width: Math.min(100, Math.round((elapsed / sizeSec) * 100)) + '%',
                                    transition: 'width 1s linear' } }),
              ),
            )
          : null,

        h('div', { style: Object.assign({}, S.sec, { marginTop: '6px' }) },
          // ── ★★★ 引擎二选一（2026-10-11 加）────────────────────────────
          //   放在参数区第一行：这是这一页最大的选择 —— 换引擎 = 换脚本 + 换整张尺寸表。
          h('div', { style: Object.assign({}, S.row, { flexWrap: 'wrap' }) },
            h('span', { style: { opacity: 0.66, minWidth: '52px' } }, '引擎'),
            ...ENGINE_LIST.map((e) => chip(engine === e.k, () => pickEngine(e.k), e.t, e.d)),
            h('span', { style: { flex: 1 } }),
            h('span', { style: S.hint }, curSizes.length + ' 档尺寸 · ' + styleList.length + ' 档画风'),
          ),
          h('div', { style: S.hint },
            '★ 两个引擎共用下面这一整套输入。切引擎时【尺寸下拉整个换掉】—— ' +
            '两边都只列真跑通过的规格；画风档也按各自脚本里真有的那几档列。'),
          h('div', { style: S.row },
            h('span', { style: { opacity: 0.66, minWidth: '52px' } }, '场景'),
            h('input', {
              style: Object.assign({}, S.inp, { flex: 1 }),
              placeholder: 'sitting on a windowsill at dusk, holding a warm cup, warm lamplight',
              value: scene,
              onChange: (e) => setScene(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter' && !running) run(); },
            }),
          ),
          h('div', { style: S.hint }, '英文更稳（Qwen-Image 文本编码器吃自然语言，不吃 danbooru 标签）。中文也能认，但英文更准。'),

          h('div', { style: Object.assign({}, S.row, { marginTop: '6px', flexWrap: 'wrap' }) },
            h('span', { style: { opacity: 0.66, minWidth: '52px' } }, '服装'),
            // ★ 填了自由输入时四个档位都不高亮 —— 一眼看出「档位被覆盖了」
            ...AGES.map((a) => chip(age === a.k && !outfit.trim(), () => setAge(a.k), a.t, a.d)),
          ),
          // ★★ 2026-10-06 爀曦要的：服装也给一个输入窗口。
          //    三层关系：身份(CHARА)+画风 永远固定；服装 可写可不写；场景 必写。
          h('div', { style: Object.assign({}, S.row, { marginTop: '4px', flexWrap: 'wrap' }) },
            h('span', { style: { opacity: 0.66, minWidth: '52px' } }, '衣柜'),
            ...WARDROBE.map((w) => chip(outfit.trim() === w.p,
              () => setOutfit(outfit.trim() === w.p ? '' : w.p), w.t, w.d)),
          ),
          h('div', { style: Object.assign({}, S.row, { marginTop: '4px' }) },
            h('span', { style: { opacity: 0.66, minWidth: '52px' } }, '　'),
            h('input', {
              style: Object.assign({}, S.inp, { flex: 1 }),
              placeholder: '或者自己写服装（留空就用上面那一档）—— 例：米白针织毛衣配深色长裤，棕色短靴',
              value: outfit,
              onChange: (e) => setOutfit(e.target.value),
            }),
            outfit.trim() ? h('button', {
              style: Object.assign({}, S.btn, { padding: '3px 7px', fontSize: '11px' }),
              onClick: () => setOutfit(''),
            }, '清空') : null,
          ),
          outfit.trim()
            ? h('div', { style: S.hint }, '★ 这次用你写的这套 —— 服装盖过年龄档（它在 anchor.mjs 里优先于 --age）。')
            : h('div', { style: S.hint }, '★ 留空 = 用上面那一档的默认服装。年龄的旋钮就在档位上 —— 10-04 实测服装不只改气质，它真的改脸型和身体比例。'),

          h('div', { style: Object.assign({}, S.row, { marginTop: '6px', flexWrap: 'wrap' }) },
            h('span', { style: { opacity: 0.66, minWidth: '52px' } }, '画风'),
            ...styleList.map((s) => chip(style === s.k, () => setStyle(s.k), s.t, s.d)),
          ),
          // ★ 少的那一档是脚本里真没有，不是界面忘了加 —— 说清楚免得被当成 bug
          ENGINES[engine].styles.length < STYLES_.length
            ? h('div', { style: S.hint }, '★ 这个引擎的脚本里没有 softcel 那一档（它本来是照 z-image 拆的），所以这里只列四档。')
            : null,

          h('div', { style: Object.assign({}, S.row, { marginTop: '8px', flexWrap: 'wrap', gap: '6px' }) },
            h('span', { style: { opacity: 0.66 } }, '尺寸'),
            h('select', { style: S.inp, value: size, onChange: (e) => setSize(e.target.value) },
              curSizes.map((x) => h('option', { key: x.v, value: x.v }, x.v + ' · ' + x.n))),
            h('span', { style: { opacity: 0.66, marginLeft: '6px' } }, '一次几张'),
            h('select', { style: S.inp, value: count, onChange: (e) => setCount(Number(e.target.value)) },
              [1, 2, 3, 4, 6, 8].map((v) => h('option', { key: v, value: v }, v + ' 张'))),
            h('span', { style: { opacity: 0.66, marginLeft: '6px' } }, 'seed'),
            h('input', { style: Object.assign({}, S.inp, { width: '110px' }), placeholder: '留空=随机',
                         value: seed, onChange: (e) => setSeed(e.target.value) }),
            h('span', { style: { flex: 1 } }),
            h('button', {
              style: Object.assign({}, S.btnP, { opacity: running ? 0.5 : 1, padding: '5px 18px' }),
              disabled: running, onClick: fire, onMouseDown: fire,
            }, running ? '出图着…' : '出 图'),
          ),
          h('div', { style: S.hint },
            '★ 填了 seed 就按 +137 递推四张（同一批有连贯性又能挑）；留空则每张各自随机。'),
        ),

        err ? h('pre', { style: S.err }, err) : null,
        // ★ 2026-10-06：这句话原来用 S.hint（灰小字），夹在参数和日志中间根本看不见 ——
        //   爀曦点了出图之后说「不知道它有没有执行」，一半原因就在这儿。
        //   现在它是有色块的一条：每一步都留下看得见的痕迹。
        msg ? h('div', { style: { fontSize: '12.5px', lineHeight: 1.6, padding: '7px 10px',
                                  borderRadius: '6px', margin: '2px 0',
                                  background: 'rgba(96,165,250,0.14)',
                                  border: '1px solid rgba(96,165,250,0.45)' } }, msg) : null,

        shots.length ? h('div', { style: S.sec },
          h('div', { style: S.row },
            h('span', { style: { fontWeight: 600 } }, '这一批'),
            h('span', { style: S.hint }, shots.length + ' 张 —— 点图看大图，右键可另存'),
            h('span', { style: { flex: 1 } }),
            h('button', { style: S.btn, onClick: () => loadShots((job && job.outputs) || []) }, '重新载入'),
          ),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '6px' } },
            ...shots.map((s) => h('div', { key: s.name, style: { width: '190px' } },
              h('img', {
                src: s.url, title: s.name,
                style: { width: '100%', borderRadius: '6px', cursor: 'zoom-in',
                         border: '1px solid rgba(128,128,128,0.25)' },
                onClick: () => setBig(s),
              }),
              h('div', { style: Object.assign({}, S.hint, { wordBreak: 'break-all' }) },
                s.name + ' · ' + s.kb + ' KB'),
            )),
          ),
        ) : null,

        // ★ 2026-10-06 爀曦：「点击它不能放大」。
        //   原来我在这儿写的是 window.open(url,'_blank') —— 桌面端的壳里那 API 常被静默拦掉，
        //   点了等于没点。而这个插件【本来就有】一个做好的灯箱（S.dfBig / dfBigImg / dfBigBar，
        //   图库页在用），我当初没复用它。现在照抄过来 —— 不依赖浏览器开窗口，谁也拦不住。
        big ? h('div', { style: S.dfBig, onClick: () => setBig(null) },
          h('img', { src: big.url, style: S.dfBigImg, alt: '' }),
          // ★ 2026-10-12 加：左上角元数据浮层 + 删除（与「打开文件夹」并列）
          h(MetaBox, { url: big.url, name: big.name, onDeleted: () => setBig(null) }),
          h('div', { style: S.dfBigBar, onClick: (e) => e.stopPropagation() },
            h('span', { style: S.dfBigTip },
              big.name + (big.kb ? '　' + big.kb + ' KB' : '') + '　点图外任意处关闭'),
            h('button', {
              style: S.btn,
              onClick: async () => {
                try {
                  await fetch(API + '/reveal', {
                    method: 'POST', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ name: big.name }),
                  });
                } catch (e) {}
              },
            }, '打开文件夹'))) : null,

        job ? h('div', { style: S.sec },
          h('div', { style: S.row },
            h('span', { style: { fontWeight: 600 } }, '运行日志'),
            h('span', { style: S.hint }, '出图 · ' + job.status +
              (job.seconds ? ' · ' + job.seconds + ' 秒' : '') +
              (job.runs ? ' · 第 ' + Math.min((job.runIndex || 0) + (job.status === 'running' ? 1 : 0), job.runs.length) + '/' + job.runs.length + ' 张' : '')),
            h('span', { style: { flex: 1 } }),
            h('button', { style: S.btn, onClick: () => { setJobId(null); setJob(null); } }, '收起'),
          ),
          h('pre', { style: { maxHeight: '240px', overflow: 'auto', fontSize: '11px',
                              lineHeight: 1.45, whiteSpace: 'pre-wrap',
                              background: 'rgba(128,128,128,0.08)', padding: '8px',
                              borderRadius: '6px', margin: '6px 0 0' } },
            String(job.tail || '（还没有输出…）').slice(-6000))) : null,
      );
    }

    // ══════════════════════════════════════════════════════════════════════════
    // 工作台 v2 · 三栏（2026-10-06 爀曦指定：照 dsh-image-gen 那个界面改）
    //   左：最近生成的缩略图带   中：画布（当前图）   右：生成面板
    //   ★ 为什么另起一个组件、不动老的 DrawPage：
    //     老的留着当退路 —— 新版哪里不对，把 WorkbenchShell 指回去就能用。
    //   ★ 左栏的图走 /api/img?f=<文件名> 直接出，不走 /api/import ——
    //     import 会往 DSH 的 attachment 库里塞一份，1200 张图全 import 是灾难。
    //     （点开大图时才 import，那是为「复制/进图库」准备的。）
    // ══════════════════════════════════════════════════════════════════════════
    // ★★★ 2026-10-06 一颗我埋的雷，已经炸过一次：
    //   /api/import 每调一次就往 DSH 的 attachment 库里塞一份完整拷贝（约 1.2 MB）。
    //   而 loadRecent 每次挂载都要拉一批缩略图 —— 刷一次页面一批、切走再回来又一批、
    //   出图完成还再来一批。攒下去就是把宿主拖垮。
    //   ⇒ 模块级缓存（跨组件挂载存活）：同一个文件名一辈子只 import 一次。
    //     ★ 放在组件外面，因为组件会被卸载重建 —— 放里面等于没缓存。
    const DF_THUMB_CACHE = new Map();

    function WorkbenchPage() {
      const LSKEY = 'df.wb.v2';
      const saved = (() => { try { return JSON.parse(localStorage.getItem(LSKEY) || '{}') || {}; } catch (e) { return {}; } })();

      const AGES = [
        { k: 'young',   t: 'young',   d: '脸圆、眼大、头身比偏小' },
        { k: 'mid',     t: 'mid',     d: '中间' },
        { k: 'mature',  t: 'mature',  d: '脸型拉长、下巴清楚（默认）' },
        { k: 'classic', t: 'classic', d: '浅蓝连衣裙 + 缎带腰' },
      ];
      // ★★ 和 DrawPage 里那份是两份列表 —— 加档必须两处一起加（2026-10-06 加 softcel 时发现）。
      const STYLES_ = [
        { k: 'soft', t: 'soft', d: '全局默认画风' },
        { k: 'softcel', t: 'softcel', d: '柔边赛璐璐 —— 赛璐璐色阶分块 + 柔化边界（爀曦 2026-10-06 定名；照大肥鱼三视图拆的，样张见 03-实验产物\\style\\）' },
        { k: 'anime', t: 'anime', d: '更重的动漫味' },
        { k: 'realistic', t: 'realistic', d: '写实' },
        { k: 'none', t: 'none', d: '不给画风词（会往写实飘）' },
      ];
      // ★ 2026-10-11：尺寸表不写在这里了 —— 它跟着引擎走（文件顶部那份 ENGINES）。
      //   原来这张表硬编码了五个尺寸，其中 768x1152 / 1152x768 从来没实测过；
      //   现在两边都只列真跑通过的规格，切引擎时整表切换。

      // ★★★ 2026-10-06 爀曦要的「角色选择」。
      //   身份串本身冻在 anchor.mjs 里（CHARACTERS 表），这里只负责选和传。
      //   ★ 怎么传给脚本：拼成 prompt 的前缀 `【角色:名字】`，脚本自己解析并剥掉。
      //     为什么不做成 --character 参数：宿主半的参数是逐字白名单拼的，加新参数要改它 + 重启 DSH；
      //     而 anchor.mjs 每次运行都重读 —— 走 prompt 前缀这条路，一个字都不用重启。
      const CHARS = [
        { k: '砚青', d: '本体 · 浅蓝紫长发 + 蝴蝶 + 紫瞳' },
        { k: '大肥鱼', d: 'DeepSeek 蓝色鲸鱼娘 · 女仆装 + 鲸尾' },
      ];
      const [char, setChar]     = react.useState(saved.char || '砚青');
      const [scene, setScene]   = react.useState(typeof saved.scene === 'string' ? saved.scene : '');
      const [outfit, setOutfit] = react.useState(typeof saved.outfit === 'string' ? saved.outfit : '');
      const [age, setAge]       = react.useState(saved.age || 'mature');
      const [style, setStyle]   = react.useState(saved.style || 'soft');
      // ★★★ 2026-10-11 加：出图引擎（与出图页共用文件顶部那份 ENGINES 表）。
      //   初始化连尺寸一起算：saved.size 可能不在这个引擎的表里，那就落到该表第一项。
      const [engine, setEngine] = react.useState(ENGINES[saved.engine] ? saved.engine : 'zimage');
      const [size, setSize]     = react.useState(() => {
        const e = ENGINES[saved.engine] ? saved.engine : 'zimage';
        const list = ENGINES[e].sizes.map((x) => x.v);
        return list.indexOf(saved.size) >= 0 ? saved.size : list[0];
      });
      const [count, setCount]   = react.useState(saved.count || 1);
      const [seed, setSeed]     = react.useState(typeof saved.seed === 'string' ? saved.seed : '');
      const [jobId, setJobId]   = react.useState(saved.jobId || null);
      const [job, setJob]       = react.useState(null);
      const [err, setErr]       = react.useState('');
      const [msg, setMsg]       = react.useState('');
      const [shots, setShots]   = react.useState([]);       // 这一批刚跑出来的
      const [recent, setRecent] = react.useState([]);       // 左栏：output 目录里的
      const [big, setBig]       = react.useState(null);     // 灯箱（只看大图，不参与中栏）
      const [probe, setProbe]   = react.useState({ state: 'probing' });
      const [elapsed, setElapsed] = react.useState(0);
      const [openLog, setOpenLog] = react.useState(false);

      // ★★★ 2026-10-06 加：显卡 TDR 那一格的状态（渲染在顶栏下面，见那一行的注释）。
      //   由来：爀曦说「顺带把 GPU 设置撤销键做到工作台里面，不然我们后面都忘了这回事」。
      //   读 = GET /gpu-tdr（reg query，不用提权）；写 = POST {action:'reset'}（会弹 UAC）。
      const [tdr, setTdr]         = react.useState(null);   // null = 还没读到
      const [tdrBusy, setTdrBusy] = react.useState(false);
      const [tdrNote, setTdrNote] = react.useState('');
      const loadTdr = () => {
        fetch(API + '/gpu-tdr').then((r) => r.json())
          .then((d) => { if (d && d.ok) setTdr(d); })
          .catch(() => {});
      };
      react.useEffect(() => { loadTdr(); }, []);
      const tdrReset = () => {
        if (tdrBusy) return;
        setTdrBusy(true); setTdrNote('已发起 —— 请在系统弹出的 UAC 窗口点「是」…');
        fetch(API + '/gpu-tdr', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'reset' }),
        }).then((r) => r.json())
          .then((d) => {
            setTdrNote((d && d.message) || '');
            // ★ 提权跑的是另一个进程，宿主拿不到它的返回值 —— 所以隔几秒自己重读一次真值，
            //   而不是"以为成功了"。读回来的才算数。
            setTimeout(() => {
              fetch(API + '/gpu-tdr').then((r) => r.json()).then((d2) => {
                if (d2 && d2.ok) setTdr(d2);
                setTdrBusy(false);
                setTdrNote(d2 && d2.isDefault ? '已恢复系统默认（重启机器后生效）'
                                              : '还没变 —— UAC 大概被取消了');
              }).catch(() => { setTdrBusy(false); setTdrNote('读不回来，刷新页面看看'); });
            }, 4000);
          })
          .catch((e) => { setTdrBusy(false); setTdrNote('失败：' + String((e && e.message) || e)); });
      };

      const running = !!(job && job.status === 'running');
      const imgUrl = (n) => API + '/img?f=' + encodeURIComponent(n);
      // ★★★ 2026-10-06 爀曦：「生图之前点任意图片能呈现，生图之后点照片就出不来。」
      //   根因是我把中栏写成了三选一：big || sel || shots[最后一张]。
      //   出图之后 shots 有值了，而 big（灯箱）排在最前面 —— 它一旦没被清干净，
      //   就永远压着后面两个，点谁都不换。
      //   ⇒ 现在【只有一个来源】：cur = sel。谁最后被点/被出，就把它写进 sel。
      //     灯箱 big 彻底独立出去，它只负责「全屏看大图」，不再参与中栏的显示。
      const [sel, setSel] = react.useState(null);     // 中栏显示谁 —— 唯一来源
      const cur = sel;                                  // ★ 中栏只认它，不再三选一
      // ★ 2026-10-06：产物要变成能显示的 url，只有一条正路 ——
      //   /api/import 把文件变成 attachment，再用 dfImageUrl 换成 objectURL。
      //   ⚠ 别用 /api/img?f= —— 它读的是 OUT_DIR（panel-out），跟产线的图不是一个目录，必然 404。
      // ★★★ 2026-10-06 爀曦：「打开图片之后要展示出它的 seed，遇到喜欢的图想多跑几张，
      //   我就可以把它的 seed 输进去。」
      //   ★ 取巧的地方：seed 不用问后端 —— ComfyUI 作图时把整份参数（含 seed）
      //     写进了 PNG 自己的元数据（tEXt 里那个 prompt 字段，是一段 JSON）。
      //     所以前端直接读那张图的 blob 就能挖出来：
      //       不改一行 host 代码、不用重启，而且【对以前所有的图都有效】。
      const readPngSeed = async (url) => {
        try {
          const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
          const txt = new TextDecoder('latin1').decode(buf);
          const m = txt.match(/"seed"\s*:\s*(\d+)/);
          return m ? m[1] : '';
        } catch (e) { return ''; }
      };

      const importOne = async (name) => {
        // ★ 缓存命中就直接给 —— 同一个文件不再往 attachment 库塞第二份
        if (DF_THUMB_CACHE.has(name)) return DF_THUMB_CACHE.get(name);
        try {
          const j = await (await fetch(API + '/import', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name }),
          })).json();
          if (j && j.ok && j.attachment) {
            const hit = { name, url: await dfImageUrl(j.attachment), kb: Math.round((j.bytes || 0) / 1024) };
            DF_THUMB_CACHE.set(name, hit);
            return hit;
          }
        } catch (e) { /* 单张失败不影响别的 */ }
        return null;
      };

      react.useEffect(() => {
        try { localStorage.setItem(LSKEY, JSON.stringify({ char, scene, outfit, age, style, engine, size, count, seed, jobId })); } catch (e) {}
      }, [char, scene, outfit, age, style, engine, size, count, seed, jobId]);

      // 左栏：最近生成。
      // ★★★ 2026-10-06 一个坑：/api/img?f= 读的是 OUT_DIR（panel-out，那个插件自己的旧目录），
      //   而产线的图在 COMFY_DIR\output —— 两个目录不一样，所以走那条路全是 404。
      //   /api/import 读的是正确目录，但它会往 DSH 的 attachment 库塞一份，
      //   1200 张全塞是灾难 ⇒ 只加载最近 40 张，而且并发做。
      const loadRecent = react.useCallback(async () => {
        try {
          const r = await (await fetch(API + '/pipeline')).json();
          const files = (r.files || []).filter((f) => /danfang_/i.test(f.name)).slice(0, 40);
          const got = await Promise.all(files.map((f) => importOne(f.name)));
          setRecent(got.filter(Boolean));
        } catch (e) { /* 扫不到就先空着 */ }
      }, []);
      react.useEffect(() => { loadRecent(); }, [loadRecent]);

      // 打开大图时，从那张 PNG 自己的元数据里把 seed 挖出来
      const [seedOf, setSeedOf] = react.useState('');
      react.useEffect(() => {
        if (!big) { setSeedOf(''); return; }
        let alive = true;
        setSeedOf('读取中…');
        readPngSeed(big.url).then((s) => { if (alive) setSeedOf(s || ''); });
        return () => { alive = false; };
      }, [big]);

      // 后端 / ComfyUI 自检：什么都不做也一直有反馈
      react.useEffect(() => {
        let alive = true;
        const tick = async () => {
          const t0 = Date.now();
          try {
            const r = await (await fetch(API + '/stages')).json();
            let comfy = null;
            try { comfy = !!(await (await fetch(API + '/state')).json()).running; } catch (e) {}
            if (alive) setProbe({ state: 'ok', ms: Date.now() - t0, busy: !!r.busy, comfy });
          } catch (e) {
            if (alive) setProbe({ state: 'fail', ms: Date.now() - t0, err: String((e && e.message) || e) });
          }
        };
        tick();
        const t = setInterval(tick, 3000);
        return () => { alive = false; clearInterval(t); };
      }, []);

      react.useEffect(() => {
        if (!running) { setElapsed(0); return; }
        const t = setInterval(() => setElapsed((x) => x + 1), 1000);
        return () => clearInterval(t);
      }, [running]);

      // 轮询任务：切走再回来能接上（jobId 存在 localStorage 里）
      react.useEffect(() => {
        if (!jobId) return;
        let stop = false;
        const tick = async () => {
          try {
            const j = await (await fetch(API + '/stage?id=' + encodeURIComponent(jobId))).json();
            if (stop || !j || !j.ok) return;
            setJob(j);
            if (j.status !== 'running') {
              setMsg(j.status === 'done'
                ? '出好了（' + j.seconds + ' 秒）—— 共 ' + ((j.outputs || []).length || 0) + ' 张'
                : '出错了（exit ' + j.code + '）—— 展开下面的日志看原因');
              if (j.status === 'done') {
                const names = (j.outputs || []).map((x) => String(x).split('\\').pop()).filter(Boolean);
                // ★ 产物也走 import 那条正路（/api/img 读的是 panel-out，必然 404）
                Promise.all(names.map((n) => importOne(n))).then((got) => {
                  const list = got.filter(Boolean);
                  setShots(list);
                  // ★ 出图完成 = 把最新那张写进 sel —— 中栏唯一来源，不是优先级争夺
                  if (list.length) setSel(list[list.length - 1]);
                  setTimeout(loadRecent, 800);
                });
              }
            }
          } catch (e) { /* 单次失败不停轮询 */ }
        };
        const t = setInterval(tick, 1500);
        tick();
        return () => { stop = true; clearInterval(t); };
      }, [jobId, loadRecent]);

      // ★★★ 2026-10-11：当前引擎的规格表 —— 与出图页同一套算法
      const curSizes = ENGINES[engine].sizes;
      const sizeSec = ((curSizes.filter((x) => x.v === size)[0]) || curSizes[0]).s;
      const styleList = STYLES_.filter((s) => ENGINES[engine].styles.indexOf(s.k) >= 0);
      // ★ 角色也按引擎过滤：qwen-anchor.mjs 的 CHARACTERS 里只有砚青（大肥鱼的设定词没抄过去，
      //   脚本注释写了理由）。在 Qwen 下选它会【静默回落成砚青】—— 所以干脆不给这个选项。
      const charList = CHARS.filter((c) => ENGINES[engine].chars.indexOf(c.k) >= 0);
      const pickEngine = (k) => {
        if (k === engine) return;
        setEngine(k);
        if (ENGINES[k].sizes.map((x) => x.v).indexOf(size) < 0) setSize(ENGINES[k].sizes[0].v);
        if (ENGINES[k].styles.indexOf(style) < 0) setStyle(ENGINES[k].styles[0]);
        if (ENGINES[k].chars.indexOf(char) < 0) setChar(ENGINES[k].chars[0]);
      };

      const guard = react.useRef(0);
      const run = async () => {
        try { document.title = '① 按下了 ' + new Date().toLocaleTimeString(); } catch (e) {}
        setErr(''); setJob(null); setShots([]); setSel(null);
        if (!scene.trim()) {
          setMsg(''); setErr('还没写场景呢 —— 身份和画风不用你写，它们冻在代码里'); return;
        }
        setMsg('① 发出去了，等后端接单…');
        try {
          const r = await (await fetch(API + '/stage', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ stage: ENGINES[engine].stage, params: {
              // ★ 角色名跟着 prompt 一起进去（anchor.mjs 自己解析并剥掉前缀）——
              //   宿主半的参数白名单里没有 character，加它要改宿主半 + 重启；走这条路一个字都不用重启。
              prompt: '【角色:' + char + '】' + scene.trim(), age, style, size,
              outfit: outfit.trim(),
              count: Number(count) || 1,
              seed: String(seed || '').trim(),
              prefix: 'danfang',
            } }),
          })).json();
          if (!r.ok) { setMsg(''); setErr('② 后端不肯收：' + (r.message || '（它没给理由）')); return; }
          setMsg('② 后端收下了（' + r.id + '，' + (r.total || 1) + ' 张）—— 跑起来就能在右边看到进度');
          setJobId(r.id);
        } catch (e) {
          setMsg('');
          setErr('② 请求没发出去：' + String((e && e.message) || e) + '\n\n（地址是 ' + API + '）');
        }
      };
      const fire = () => {
        const now = Date.now();
        if (now - guard.current < 800) return;
        guard.current = now; run();
      };

      const chip = (on, fn, label, title) => h('button', {
        key: label, title: title || '', onClick: fn,
        style: Object.assign({}, on ? S.btnP : S.btn, { padding: '3px 9px', fontSize: '11.5px' }),
      }, label);

      const lab = (t) => h('div', { style: { fontSize: '11px', opacity: 0.62, margin: '9px 0 3px' } }, t);
      const col = { display: 'flex', flexDirection: 'column', minHeight: 0 };
      const paneTop = { fontSize: '11px', opacity: 0.6, letterSpacing: '.5px', marginBottom: '6px' };

      return h('div', { style: Object.assign({}, S.wrap, { height: '100%', gap: '10px' }) },

        // ── 顶栏：一行状态，永远在 ───────────────────────────────
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
                            fontSize: '11.5px', padding: '6px 10px', borderRadius: '7px',
                            background: probe.state === 'fail' ? 'rgba(248,113,113,0.14)' : 'rgba(148,163,184,0.10)',
                            border: '1px solid ' + (probe.state === 'fail' ? 'rgba(248,113,113,0.45)' : 'rgba(148,163,184,0.28)') } },
          h('span', { style: { fontWeight: 600 } }, '出图'),
          h('span', { style: S.hint }, ENGINES[engine].tech + ' · 这个尺寸单张约 ' + (sizeSec / 60).toFixed(1) + ' 分钟'),
          h('span', { style: { flex: 1 } }),
          probe.state === 'probing' ? h('span', { style: S.hint }, '● 探测中…')
            : probe.state === 'fail' ? h('span', { style: { color: '#f87171' } }, '✗ 后端连不上：' + probe.err)
            : h('span', { style: S.hint },
                '✓ 后端 ' + probe.ms + 'ms　·　' + (probe.comfy ? '✓ ComfyUI 在跑' : '✗ ComfyUI 没在跑') +
                '　·　' + (probe.busy ? '● 队列在跑' : '队列空闲')),
        ),

        // ── 显卡 TDR 超时（2026-10-06 加）────────────────────────
        // ★ 爀曦原话：「顺带把 GPU 设置撤销键做到工作台里面，不然我们后面都忘了这回事。」
        //   由来：2026-10-06 三次出图中断，证据是 nvlddmkm 事件 153，原文
        //   "Reset TDR occurred on GPUID:100" —— 就是显卡被超时重置了。
        //   当天定了两条处置：① 一次只出一张图 ② 把 TdrDelay 从系统默认 2 秒改成 10 秒。
        //   ② 动的是注册表（HKLM\SYSTEM\CurrentControlSet\Control\GraphicsDrivers），
        //   最容易被忘掉 —— 这一行就是它的**可见把手**：一眼能看到现在是什么值，想退回去点一下。
        //   ★ 恢复默认必须提权（写 HKLM 要管理员），所以点完会弹 UAC —— 那个弹窗本身就是第二道确认。
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
                            fontSize: '11.5px', padding: '5px 10px', borderRadius: '7px',
                            background: 'rgba(148,163,184,0.06)',
                            border: '1px solid rgba(148,163,184,0.20)' } },
          h('span', { style: { opacity: 0.75 } }, '显卡 TDR 超时'),
          tdr === null
            ? h('span', { style: S.hint }, '（暂时读不到 · 这一格要等 DSH 重启后才接管）')
            : h('span', { style: { fontWeight: 600, color: tdr.isDefault ? '#94a3b8' : '#e0a458' } },
                tdr.isDefault ? '系统默认 2 秒' : (tdr.seconds + ' 秒（改过）')),
          (tdr && !tdr.isDefault)
            ? h('button', { style: Object.assign({}, S.btn, { padding: '2px 9px', fontSize: '11px' }),
                            disabled: tdrBusy, onClick: tdrReset },
                tdrBusy ? '等 UAC…' : '恢复默认')
            : null,
          h('span', { style: Object.assign({}, S.hint, { flex: 1 }) },
            tdrNote || ((tdr && tdr.isDefault)
              ? '没改过，不用管'
              : '改大是为了让「慢」不再被当成「死」；改完要重启机器才生效')),
        ),

        // ── 三栏主体 ───────────────────────────────────────────
        h('div', { style: { display: 'flex', gap: '10px', flex: 1, minHeight: 0 } },

          // ── 左栏：最近生成 ────────────────────────────────
          h('div', { style: Object.assign({}, col, { width: '154px', flex: '0 0 154px' }) },
            h('div', { style: paneTop }, '最近生成 ' + (recent.length ? '(' + recent.length + ')' : '')),
            h('div', { style: { flex: 1, overflowY: 'auto', display: 'grid',
                                gridTemplateColumns: '1fr 1fr', gap: '5px', alignContent: 'start' } },
              recent.map((f) => h('img', {
                key: f.name, src: f.url, alt: '', title: f.name,
                style: { width: '100%', aspectRatio: '3 / 4', objectFit: 'cover',
                         borderRadius: '5px', cursor: 'zoom-in', display: 'block',
                         border: cur && cur.name === f.name ? '2px solid #60a5fa' : '2px solid transparent' },
                onClick: () => { setSel({ name: f.name, url: f.url, kb: f.kb }); setBig(null); },
              })),
              recent.length ? null : h('div', { style: S.hint }, '（还没有图）'),
            ),
            h('button', { style: Object.assign({}, S.btn, { marginTop: '6px' }), onClick: loadRecent }, '刷新'),
          ),

          // ── 中栏：画布 ────────────────────────────────────
          h('div', { style: Object.assign({}, col, { flex: 1, alignItems: 'center', justifyContent: 'center',
                                                     background: 'rgba(0,0,0,0.16)', borderRadius: '9px', padding: '12px' }) },
            cur
              ? h('img', {
                  src: cur.url, alt: '', title: '点开看大图',
                  style: { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain',
                           borderRadius: '8px', cursor: 'zoom-in' },
                  onClick: () => setBig(cur),
                })
              : h('div', { style: { textAlign: 'center', opacity: 0.55, fontSize: '12.5px', lineHeight: 2 } },
                  h('div', null, '画布空着'),
                  h('div', null, '右边写好场景和服装，点「出 图」'),
                  h('div', null, '或者点左边任意一张看它')),
            cur ? h('div', { style: { marginTop: '8px', fontSize: '11px', opacity: 0.7 } },
              cur.name) : null,
          ),

          // ── 右栏：生成面板 ────────────────────────────────
          h('div', { style: Object.assign({}, col, { width: '288px', flex: '0 0 288px', overflowY: 'auto' }) },
            h('div', { style: paneTop }, '生成面板'),

            // ── ★★★ 引擎二选一（2026-10-11 加）────────────────────
            //   放生成面板最上面：它是这一页最大的选择 ——
            //   换引擎 = 换脚本 + 换整张尺寸表 + 换画风档 + 换角色档。
            lab('引擎'),
            h('div', { style: { display: 'flex', gap: '5px', flexWrap: 'wrap' } },
              ENGINE_LIST.map((e) => h('button', {
                key: e.k, title: e.d,
                onClick: () => pickEngine(e.k),
                style: Object.assign({}, engine === e.k ? S.btnP : S.btn,
                                     { padding: '5px 12px', fontSize: '12.5px' }),
              }, e.t))),
            h('div', { style: { fontSize: '10.5px', opacity: 0.55, marginTop: '3px' } },
              ENGINES[engine].d + '　·　' + curSizes.length + ' 档尺寸 / ' + styleList.length + ' 档画风'),

            // ── 角色选择（2026-10-06 爀曦要的）────────────────────
            //   ★ 2026-10-11：列表按引擎过滤 —— qwen-anchor.mjs 的 CHARACTERS 里只有砚青
            lab('角色'),
            h('div', { style: { display: 'flex', gap: '5px', flexWrap: 'wrap' } },
              charList.map((c) => h('button', {
                key: c.k, title: c.d,
                onClick: () => setChar(c.k),
                style: Object.assign({}, char === c.k ? S.btnP : S.btn,
                                     { padding: '5px 12px', fontSize: '12.5px' }),
              }, c.k))),
            h('div', { style: { fontSize: '10.5px', opacity: 0.55, marginTop: '3px' } },
              (charList.find((c) => c.k === char) || {}).d || ''),

            lab('场景 / 动作（必写）'),
            h('textarea', {
              style: Object.assign({}, S.ta, { minHeight: '72px' }),
              placeholder: '例：躺在床上，抱着枕头，周围光线柔和；满脸通红羞涩',
              value: scene, onChange: (e) => setScene(e.target.value),
            }),

            lab('服装 · 衣柜 / 年龄档 / 自己写'),
            h('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap', alignItems: 'center' } },
              h('span', { style: { opacity: 0.55, fontSize: '11px' } }, '衣柜'),
              WARDROBE.map((w) => chip(outfit.trim() === w.p,
                () => setOutfit(outfit.trim() === w.p ? '' : w.p), w.t, w.d))),
            h('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '4px', alignItems: 'center' } },
              h('span', { style: { opacity: 0.55, fontSize: '11px' } }, '年龄档'),
              AGES.map((a) => chip(age === a.k && !outfit.trim(), () => setAge(a.k), a.t, a.d))),
            h('input', {
              style: Object.assign({}, S.inp, { marginTop: '4px' }),
              placeholder: '例：穿着白色轻薄睡衣',
              value: outfit, onChange: (e) => setOutfit(e.target.value),
            }),

            lab('画风'),
            h('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } },
              styleList.map((s) => chip(style === s.k, () => setStyle(s.k), s.t, s.d))),
            ENGINES[engine].styles.length < STYLES_.length
              ? h('div', { style: { fontSize: '10.5px', opacity: 0.55, marginTop: '3px' } },
                  '★ 这个引擎的脚本里没有 softcel 那一档（它本来是照 z-image 拆的）')
              : null,

            h('div', { style: { display: 'flex', gap: '8px', marginTop: '9px' } },
              h('div', { style: { flex: 2 } }, lab('尺寸（' + curSizes.length + ' 档）'),
                h('select', { style: Object.assign({}, S.inp, { width: '100%' }),
                              value: size, onChange: (e) => setSize(e.target.value) },
                  curSizes.map((x) => h('option', { key: x.v, value: x.v }, x.v + ' · ' + x.n)))),
              h('div', { style: { flex: 1 } }, lab('张数'),
                h('select', { style: Object.assign({}, S.inp, { width: '100%' }),
                              value: String(count), onChange: (e) => setCount(Number(e.target.value)) },
                  [1, 2, 3, 4].map((n) => h('option', { key: n, value: String(n) }, n + ' 张')))),
            ),
            lab('seed（留空随机）'),
            h('input', { style: S.inp, placeholder: '留空 = 每张各自随机', value: seed,
                         onChange: (e) => setSeed(e.target.value) }),

            h('button', {
              style: Object.assign({}, S.btnP, { marginTop: '11px', padding: '8px', fontSize: '13px',
                                                 opacity: running ? 0.55 : 1 }),
              disabled: running, onClick: fire, onMouseDown: fire,
            }, running ? '出图中…' : '出　图'),

            err ? h('pre', { style: Object.assign({}, S.err, { marginTop: '8px' }) }, err) : null,
            msg ? h('div', { style: { fontSize: '12px', lineHeight: 1.6, padding: '6px 9px', marginTop: '7px',
                                      borderRadius: '6px', background: 'rgba(96,165,250,0.14)',
                                      border: '1px solid rgba(96,165,250,0.45)' } }, msg) : null,

            running ? h('div', { style: { fontSize: '12px', padding: '7px 9px', marginTop: '7px',
                                          borderRadius: '6px', background: 'rgba(96,165,250,0.14)',
                                          border: '1px solid rgba(96,165,250,0.45)' } },
              h('div', null, '● 第 ' + ((job.runIndex || 0) + 1) + ' / ' + (((job.runs || []).length) || 1) + ' 张' +
                '　已跑 ' + Math.floor(elapsed / 60) + ' 分 ' + (elapsed % 60) + ' 秒'),
              h('div', { style: { marginTop: '5px', height: '4px', borderRadius: '2px',
                                  background: 'rgba(148,163,184,0.25)', overflow: 'hidden' } },
                h('div', { style: { height: '4px', borderRadius: '2px', background: '#60a5fa',
                                    width: Math.min(100, Math.round((elapsed / sizeSec) * 100)) + '%',
                                    transition: 'width 1s linear' } })),
            ) : null,

            // 这一批的成品
            shots.length ? h('div', { style: { marginTop: '10px' } },
              h('div', { style: paneTop }, '这一批 · ' + shots.length + ' 张'),
              h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px' } },
                shots.map((s) => h('img', {
                  key: s.name, src: s.url, alt: '', title: s.name,
                  style: { width: '100%', borderRadius: '5px', cursor: 'zoom-in', display: 'block' },
                  onClick: () => { setSel(s); setBig(s); },
                })))) : null,

            // 运行日志：折叠着，出错时才需要
            job ? h('div', { style: { marginTop: '10px' } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
                h('span', { style: paneTop }, '运行日志'),
                h('span', { style: { flex: 1 } }),
                h('button', { style: Object.assign({}, S.btn, { padding: '2px 8px', fontSize: '11px' }),
                              onClick: () => setOpenLog(!openLog) }, openLog ? '收起' : '展开')),
              openLog ? h('pre', { style: { maxHeight: '200px', overflow: 'auto', fontSize: '10.5px',
                                            lineHeight: 1.4, whiteSpace: 'pre-wrap', margin: '5px 0 0',
                                            background: 'rgba(128,128,128,0.08)', padding: '7px',
                                            borderRadius: '6px' } },
                String(job.tail || '（还没有输出…）').slice(-6000)) : null,
            ) : null,
          ),
        ),

        // ── 灯箱 ─────────────────────────────────────────────
        big ? h('div', { style: S.dfBig, onClick: () => setBig(null) },
          h('img', { src: big.url, style: S.dfBigImg, alt: '' }),
          // ★ 2026-10-12 加：左上角元数据浮层 + 删除（工作台驾驶台）
          h(MetaBox, { url: big.url, name: big.name, onDeleted: () => setBig(null) }),
          h('div', { style: S.dfBigBar, onClick: (e) => e.stopPropagation() },
            h('span', { style: S.dfBigTip }, big.name + '　点图外任意处关闭'),
            // ★ seed：爀曦要的「遇到喜欢的图，把它 seed 输进去再跑几张」
            seedOf ? h('span', {
              style: Object.assign({}, S.dfBigTip, { fontFamily: 'monospace', fontSize: '12px',
                                                     opacity: 0.95, marginRight: '6px' }),
              title: '这张图的随机种子 —— 同样的提示词 + 同样的 seed = 同一张图',
            }, 'seed ' + seedOf) : null,
            seedOf && /^\d+$/.test(seedOf) ? h('button', {
              style: S.btn,
              title: '把它填进右边的 seed 框，再点出图就能复现这一张',
              onClick: () => { setSeed(seedOf); setBig(null); },
            }, '用这个 seed') : null,
            h('button', {
              style: S.btn,
              onClick: async () => {
                try {
                  await fetch(API + '/reveal', { method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ name: big.name }) });
                } catch (e) {}
              },
            }, '打开文件夹'))) : null,
      );
    }

    // ── 页二 · 工作台：技术线四层驾驶台（2026-10-02 加）──────────
    // ★ 为什么不做成参数面板：这四层是【四个独立 node 脚本】，不是 ComfyUI 的 workflow。
    //   所以这里要的是「一条流水线的驾驶台」——每层显示它对应的脚本、参数、实跑日志。
    // ★★ 默认值取《三模型综合技术线》的实测甜点，不是脚本默认值：
    //   handcrop 脚本默认 denoise 0.65 / blur 12，而实测甜点是 0.7 / 40。
    function PanelStages() {
      const DEF = {
        sdxl:     { variant: 'tag-hiten', seed: 927001 },
        takeover: { input: '', denoise: 0.65, seed: 20260929, steps: 9 },
        handcrop: { input: '', x: 184, y: 704, w: 240, h: 384,
                    denoise: 0.7, seed: 20260929, steps: 9, scale: 4, blur: 40 },
        upscale:  { input: '', scale: 3 },
      };
      const [P, setP] = react.useState(DEF);
      const [jobId, setJobId] = react.useState(null);
      const [job, setJob] = react.useState(null);
      const [err, setErr] = react.useState('');
      const [msg, setMsg] = react.useState('');
      const [lastOut, setLastOut] = react.useState('');

      react.useEffect(() => {
        if (!jobId) return;
        let stop = false;
        const tick = async () => {
          try {
            const j = await (await fetch(API + '/stage?id=' + encodeURIComponent(jobId))).json();
            if (stop || !j || !j.ok) return;
            setJob(j);
            if (j.status !== 'running') {
              setMsg(j.status === 'done' ? '跑完了（' + j.seconds + ' 秒）' : '出错了（exit ' + j.code + '）');
              const m = String(j.tail || '').match(/[A-Za-z]:\\[^\s"'<>]+\.(?:png|webp|jpg)/g);
              if (m && m.length) setLastOut(m[m.length - 1]);
            }
          } catch (e) { /* 一次失败不停轮询 */ }
        };
        const t = setInterval(tick, 1500);
        tick();
        return () => { stop = true; clearInterval(t); };
      }, [jobId]);

      const setF = (stage, k, v) => setP((o) => Object.assign({}, o, {
        [stage]: Object.assign({}, o[stage], { [k]: v }),
      }));

      const run = async (stage) => {
        setErr(''); setMsg(''); setJob(null); setLastOut('');
        try {
          const r = await (await fetch(API + '/stage', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ stage, params: P[stage] }),
          })).json();
          if (!r.ok) { setErr(r.message || '启动失败'); return; }
          setMsg('已启动 ' + String(r.script).split('\\').pop());
          setJobId(r.id);
        } catch (e) { setErr(String((e && e.message) || e)); }
      };

      const running = !!(job && job.status === 'running');
      const num = (stage, k, label, step, w) => h('span', { key: k, style: S.row },
        h('span', { style: { opacity: 0.66 } }, label),
        h('input', { type: 'number', step: step || '1',
                     style: Object.assign({}, S.inp, { width: w || '76px' }),
                     value: P[stage][k], onChange: (e) => setF(stage, k, Number(e.target.value)) }));
      const inp = (stage, k, label, ph) => h('div', { key: k,
        style: Object.assign({}, S.row, { marginBottom: '4px' }) },
        h('span', { style: { opacity: 0.66, minWidth: '52px' } }, label),
        h('input', { style: Object.assign({}, S.inp, { flex: 1, minWidth: '180px' }),
                     placeholder: ph || '', value: P[stage][k],
                     onChange: (e) => setF(stage, k, e.target.value) }),
        lastOut ? h('button', { style: Object.assign({}, S.btn, { padding: '3px 7px', fontSize: '11px' }),
                                onClick: () => setF(stage, k, lastOut) }, '用产物') : null);

      const card = (stage, title, script, body, note) => h('div', {
        style: Object.assign({}, S.sec, { opacity: running && job.stage !== stage ? 0.55 : 1 }),
      },
        h('div', { style: S.row },
          h('span', { style: { fontWeight: 600, fontSize: '12.5px' } }, title),
          h('span', { style: S.hint }, script),
          h('span', { style: { flex: 1 } }),
          h('button', { style: Object.assign({}, S.btnP, { opacity: running ? 0.5 : 1 }),
                        disabled: running, onClick: () => run(stage) },
            running && job.stage === stage ? '跑着…' : '跑这一步')),
        body,
        note ? h('div', { style: S.hint }, note) : null);

      return h('div', { style: S.wrap },
        h('div', { style: S.row },
          h('span', { style: { fontSize: '13px', fontWeight: 600 } }, '技术线四层'),
          h('span', { style: S.hint }, '定锚 → 结构 → 画风接管 → 修手 → 终稿'),
          h('span', { style: { flex: 1 } }),
          h('span', { style: S.hint }, '一次只跑一个')),
        h('div', { style: S.hint },
          '★ 这四层是四个独立脚本，不是 ComfyUI 参数。默认值取《三模型综合技术线》的实测甜点。'),

        err ? h('pre', { style: S.err }, err) : null,
        msg ? h('div', { style: S.hint }, msg) : null,
        lastOut ? h('div', { style: S.hint }, '最近产物：' + lastOut) : null,

        card('sdxl', '① 结构 · SDXL 三重约束', 'yq-sdxl-triple.mjs',
          h('div', null,
            h('div', { style: S.row },
              h('span', { style: { opacity: 0.66 } }, '变体'),
              h('select', { style: S.inp, value: P.sdxl.variant,
                            onChange: (e) => setF('sdxl', 'variant', e.target.value) },
                ['tag-hiten', 'tag', 'i2i', 'all'].map((v) => h('option', { key: v, value: v }, v))),
              num('sdxl', 'seed', 'seed', '1', '96px')),
            h('div', { style: S.hint }, '白模姿势必须和线稿同源，否则两个结构约束互相打架。')),
          'cn 0.7（union ControlNet · lineart）+ depth 0.35（白模 clay-v4-B-young1.png）'),

        card('takeover', '② 画风接管 · Z-Image', 'yq-zimage-takeover.mjs',
          h('div', null,
            inp('takeover', 'input', '底图', 'SDXL 那一步的输出，绝对路径'),
            h('div', { style: S.row },
              num('takeover', 'denoise', 'denoise', '0.05', '70px'),
              num('takeover', 'seed', 'seed', '1', '96px'),
              num('takeover', 'steps', 'steps', '1', '56px'))),
          'denoise 甜点 0.65：0.55 画风换不彻底，0.75 结构开始松。★ 顺序不能反——先整图接管，再局部修手'),

        card('handcrop', '③ 修手 · 裁手放大重绘', 'yq-zimage-handcrop.mjs',
          h('div', null,
            inp('handcrop', 'input', '图', '上一步的输出'),
            h('div', { style: S.row },
              num('handcrop', 'x', 'x', '8', '66px'), num('handcrop', 'y', 'y', '8', '66px'),
              num('handcrop', 'w', 'w', '8', '66px'), num('handcrop', 'h', 'h', '8', '66px')),
            h('div', { style: S.row },
              num('handcrop', 'denoise', 'denoise', '0.05', '70px'),
              num('handcrop', 'scale', 'scale', '1', '52px'),
              num('handcrop', 'blur', 'blur', '4', '56px'),
              num('handcrop', 'seed', 'seed', '1', '92px')),
            h('div', { style: S.hint }, '★ 两只手要跑两遍：第二遍的输入是第一遍的输出。')),
          '★ 框取 240×384（手在中央、四周留上下文）——接缝的根因不是羽化不够，是窗口太小。当前左手 184 704 240 384 / 右手 664 704 240 384'),

        card('upscale', '④ 终稿 · 纯插值超分', 'yq-upscale.mjs',
          h('div', null,
            inp('upscale', 'input', '图', '上一步的输出'),
            h('div', { style: S.row },
              num('upscale', 'scale', 'scale', '1', '56px'),
              h('span', { style: S.hint }, '--model none --denoise 0（锁死）'))),
          '★★ denoise 必须 0：>0 会让 Z-Image 在 3456×5184 上跑扩散，2026-09-29 实测把 ComfyUI 卡死。所以这一项不给调。'),

        job ? h('div', { style: S.sec },
          h('div', { style: S.row },
            h('span', { style: { fontWeight: 600 } }, '运行日志'),
            h('span', { style: S.hint }, job.stage + ' · ' + job.status +
              (job.seconds ? ' · ' + job.seconds + ' 秒' : '')),
            h('span', { style: { flex: 1 } }),
            h('button', { style: S.btn, onClick: () => { setJobId(null); setJob(null); } }, '收起')),
          h('pre', { style: { maxHeight: '260px', overflow: 'auto', fontSize: '11px',
                              lineHeight: 1.45, whiteSpace: 'pre-wrap',
                              background: 'rgba(128,128,128,0.08)', padding: '8px',
                              borderRadius: '6px', margin: '6px 0 0' } },
            String(job.tail || '（还没有输出…）').slice(-6000))) : null,
      );
    }

    // ── 工作台外壳：出图 / 四层 / 通用参数 三个子页 ──────────────
    // ★ 2026-10-06 改：默认落到【出图】—— 它才是当前生效的生图线。
    //   「技术线四层」保留但标了废弃：① 出事时能回退 ② 修手那一步将来要接回出图线。
    //   「通用参数」不删 —— 出任意图还得靠它，出图页只走固定流水线。
    // ── 队列页（2026-10-08 加）─────────────────────────────────
    // ★ 为什么要有它：出片线一条 13.7 分钟，排队三四条就是一小时。
    //   人要能「排完就走」，回来再看 —— 所以这一页只回答三件事：
    //   谁在跑、还有几条、每条跑完了没有。
    // ★★ 账本在【服务端】（<插件目录>/data/queue.jsonl，只追加）——
    //   这一页只是看客，刷新、关标签页都不影响队列。
    function QueuePage() {
      const [d, setD] = react.useState(null);
      const [err, setErr] = react.useState('');
      const [busy, setBusy] = react.useState('');
      // 出图页那份参数（提示词 / 张数 / seed）—— 队列要能直接接过来排队
      const [prompt, setPrompt] = react.useState('');
      const [count, setCount] = react.useState(4);

      const pull = () => {
        fetch(API + '/queue').then((r) => r.json())
          .then((j) => { setD(j); setErr(''); })
          .catch((e) => setErr(String((e && e.message) || e)));
      };
      react.useEffect(() => {
        pull();
        const t = setInterval(pull, 3000);   // ★ 同上：3 秒一探，不做推送
        return () => clearInterval(t);
      }, []);

      const enqueue = () => {
        if (!prompt.trim()) { setErr('提示词不能空'); return; }
        setBusy('排队中…');
        const qs = new URLSearchParams({ kind: 'anchor', prompt, count: String(count) });
        fetch(API + '/queue?' + qs.toString(), { method: 'POST' })
          .then((r) => r.json())
          .then((j) => {
            setBusy('');
            if (!j.ok) { setErr(j.message || '入队失败'); return; }
            setErr('');
            pull();
          })
          .catch((e) => { setBusy(''); setErr(String((e && e.message) || e)); });
      };
      const act = (id, what) => {
        setBusy(what + '…');
        fetch(API + '/queue?act=' + what + '&id=' + encodeURIComponent(id), { method: 'POST' })
          .then((r) => r.json()).then(() => { setBusy(''); pull(); })
          .catch((e) => { setBusy(''); setErr(String((e && e.message) || e)); });
      };

      const c = (d && d.counts) || {};
      const jobs = (d && d.jobs) || [];
      const badge = (st) => {
        const map = {
          running: ['● 在跑', '#0e7490', '#e0f2fe'],
          pending: ['… 排队', '#b45309', '#fffbeb'],
          done:    ['✓ 好了', '#047857', '#ecfdf5'],
          error:   ['✗ 失败', '#b91c1c', '#fef2f2'],
          cancelled: ['— 取消', '#64748b', '#f1f5f9'],
          cancelling: ['— 停…', '#64748b', '#f1f5f9'],
        }[st] || [st || '?', '#64748b', '#f1f5f9'];
        return h('span', { style: { fontSize: '11px', padding: '1px 7px', borderRadius: '9px',
                                    color: map[1], background: map[2], whiteSpace: 'nowrap' } }, map[0]);
      };

      if (err && !d) return h('div', { style: S.hint }, '队列读不到：' + err);

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '4px' } },
        // ① 概要
        h(PipelineBand, { step: 2, note: '队列：出图与出片共用一条流水' }),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
          h('span', { style: { fontWeight: 600 } }, '队列'),
          h('span', { style: S.hint },
            (d && d.running ? '● 有一条在跑' : '· 空闲') +
            '　排队 ' + (c.pending || 0) + '　好了 ' + (c.done || 0) +
            '　失败 ' + (c.error || 0)),
          h('button', { style: S.dfTabOff, onClick: pull }, '刷新')),
        err ? h('div', { style: { color: '#b91c1c', fontSize: '12px' } }, err) : null,

        // ② 排一条新的
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
          h('input', { style: { flex: '1 1 320px', minWidth: '220px' }, placeholder: '提示词（只写场景与动作）',
                       value: prompt, onChange: (e) => setPrompt(e.target.value) }),
          h('label', { style: S.hint }, '张数'),
          h('input', { style: { width: '56px' }, type: 'number', min: 1, max: 8,
                       value: count, onChange: (e) => setCount(Number(e.target.value) || 1) }),
          h('button', { style: S.dfTabOn, onClick: enqueue, disabled: !!busy },
            busy || '排进队列')),

        // ③ 列表
        jobs.length === 0
          ? h('div', { style: S.hint }, '队列是空的。排一条试试 —— 排完可以关掉这一页，服务端会继续跑。')
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
              jobs.map((j) => h('div', { key: j.id,
                style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '7px 9px',
                         border: '1px solid var(--line, #e2e8f0)', borderRadius: '7px', fontSize: '12px' } },
                badge(j.status),
                h('span', { style: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis',
                                     whiteSpace: 'nowrap' } },
                  ((j.params && j.params.prompt) || '(无提示词)') + '　·　' + (j.kind || '')),
                h('span', { style: S.hint },
                  (j.params && j.params.count ? j.params.count + ' 张' : '') +
                  (j.outputs && j.outputs.length ? '　出 ' + j.outputs.length + ' 张' : '') +
                  (j.seconds ? '　' + Math.round(j.seconds) + 's' : '')),
                (j.status === 'pending' || j.status === 'running')
                  ? h('button', { style: S.dfTabOff, onClick: () => act(j.id, 'cancel') }, '取消')
                  : null,
                (j.status === 'error' || j.status === 'cancelled')
                  ? h('button', { style: S.dfTabOff, onClick: () => act(j.id, 'retry') }, '重试')
                  : null,
                j.error ? h('span', { style: { color: '#b91c1c' }, title: j.error }, '看错误') : null))),

        h('div', { style: S.hint },
          '账本：' + ((d && d.ledger) || '(未知)') + '　★ 服务端权威，关掉浏览器也照跑'));
    }

    // ── 关系图窄带（2026-10-08 加）────────────────────────────
    // ★ 设计文档 §五：四个节点只有状态、没有拖拽；作用是「一秒可查：这东西从哪来、经过了什么」。
    // ★ 为什么是【窄带】不是大图：它是常驻的状态条，不是要去点的地方。
    //   step: 0=出图 1=关键帧 2=出片 3=成片
    function PipelineBand(props) {
      const step = props.step == null ? -1 : props.step;
      const NODES = [
        { name: '出图', cost: '2.1 min' },
        { name: '关键帧', cost: '' },
        { name: '出片', cost: '13.7 min' },
        { name: '成片', cost: '' },
      ];
      return h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px',
                                 padding: '7px 9px', borderRadius: '7px',
                                 background: 'var(--bg-soft, #f8fafc)',
                                 border: '1px solid var(--line, #e2e8f0)',
                                 fontSize: '12px', overflowX: 'auto' } },
        NODES.map((nd, i) => {
          const done = step > i, now = step === i;
          return h('span', { key: nd.name, style: { display: 'flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap' } },
            h('span', { style: { fontSize: '13px', color: done ? '#047857' : now ? '#0e7490' : '#94a3b8' } },
              done ? '✓' : now ? '●' : '○'),
            h('span', { style: { fontWeight: now ? 600 : 400, color: now ? '#0e7490' : done ? '#047857' : '#64748b' } }, nd.name),
            nd.cost ? h('span', { style: { fontSize: '10px', color: '#94a3b8' } }, nd.cost) : null,
            i < NODES.length - 1 ? h('span', { style: { color: '#cbd5e1', margin: '0 3px' } }, '──→') : null);
        }),
        h('span', { style: { marginLeft: 'auto', fontSize: '11px', color: '#94a3b8' } },
          props.note || ''));
    }

    // ── 出片页（2026-10-08 加）──────────────────────────────────
    // ★ 这一页背后是 WanGP（Python），不是出图线那条 node 脚本 ——
    //   所以它排进队列的 kind 是 'video'，宿主半会走 runVideo()：
    //   写 settings.json → python wgp.py --process <json> → 13.70 分钟。
    // ★ 三条界面纪律（设计文档 §四②）：秒数写在帧数旁、耗时写在按钮旁、措辞用「排进队列」。
    function VideoPage() {
      const [img0, setImg0] = react.useState('');       // 首帧路径
      const [useEnd, setUseEnd] = react.useState(false); // S 锚 / SE 锚
      const [img1, setImg1] = react.useState('');       // 末帧（只有 SE 用）
      const [prompt, setPrompt] = react.useState('');
      const [frames, setFrames] = react.useState(49);
      const [steps, setSteps] = react.useState(8);
      const [seed, setSeed] = react.useState(42);
      const [busy, setBusy] = react.useState('');
      const [msg, setMsg] = react.useState('');
      const [lib, setLib] = react.useState([]);         // 图库里可选的图
      const [libOpen, setLibOpen] = react.useState(true); // ★ 图库默认展开 —— 它是首帧选择器，是这一页的第一步
      const [libErr, setLibErr] = react.useState('');     // ★ 图库读不到时的原因（不许吞成空）
      const [libUrl, setLibUrl] = react.useState({});     // attachmentId → blob URL（和画廊同一套取图）
      // ★ 名字必须独一无二：前一次我叫它 zoomImg，而 StatsPage 里早就有一个同名 state，
      //   于是 includes('const [zoomImg') 的检查说「已存在」、跳过了这里的声明 ——
      //   VideoPage 一渲染就 zoomImg is not defined，整块被 React 卸载。第三次栽在同一件事上。
      const [zoomImg, setZoomImg] = react.useState(null); // 大图预览：{ url, name } 或 null

      // ★ 2026-10-08 爀曦要求「直接把这个图库的组件给做进选择器，生图之后图库和选择器自动同步」。
      //   所以这里不再自己读磁盘目录，而是【读画廊那本账】——和图库页完全同一个数据源：
      //     dfList()                     → IndexedDB dsh_image_gen_db → gallery_history
      //     dfImageUrl(rec.attachment)   → 换回 blob URL
      //   ★ 判据：同一个界面上显示同一批图，就必须走同一条读图路径。之前我另开了一条，于是两边对不上。
      const loadLib = react.useCallback(() => {
        dfList().then((list) => {
          setLib(list || []); setLibErr('');
          (list || []).slice(0, 80).forEach((rec) => {
            const key = String((rec && rec.attachment && rec.attachment.attachmentId) || (rec && rec.id) || '');
            if (!key) return;
            dfImageUrl(rec.attachment).then((u) => setLibUrl((m) => (m[key] ? m : Object.assign({}, m, { [key]: u })))).catch(() => {});
          });
        }).catch((e) => { setLib([]); setLibErr(String((e && e.message) || e)) });
      }, []);
      react.useEffect(() => { loadLib() }, [loadLib]);
      // Esc 关掉大图（和「点任意处关闭」两条路都给）
      react.useEffect(() => {
        if (!zoomImg) return;
        const onKey = (e) => { if (e.key === 'Escape') setZoomImg(null) };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [zoomImg]);

      // 首帧的预览图（img0 现在存的是 savedTo 文件名 → 找对应记录的 blob URL）
      const pickUrl0 = react.useMemo(() => {
        const hit = (lib || []).find((x) => String((x && x.savedTo) || (x && x.name) || '') === img0);
        const k = hit ? String((hit.attachment && hit.attachment.attachmentId) || hit.id || '') : '';
        return (k && libUrl[k]) || '';
      }, [lib, img0, libUrl]);

      // ★ 三档时长：秒数直接写在选项上（16 fps，2026-10-06 ffmpeg 实测定死）
      const FRAMES = [
        { n: 17, s: '1.06 s' },
        { n: 33, s: '2.06 s' },
        { n: 49, s: '3.06 s' },   // ★ 默认。65 帧不给 —— 实测 4/4 崩
      ];
      const MINUTES = { 17: '约 5 分钟', 33: '约 9.3 分钟', 49: '约 13.7 分钟' };

      const enqueue = () => {
        if (!img0.trim()) { setMsg('要先有首帧'); return; }
        if (!prompt.trim()) { setMsg('提示词不能空'); return; }
        if (useEnd && !img1.trim()) { setMsg('选了 SE 就要给末帧'); return; }
        setBusy('排队中…'); setMsg('');
        const qs = new URLSearchParams({
          kind: 'video', prompt, image: img0,
          frames: String(frames), steps: String(steps), seed: String(seed),
        });
        if (useEnd) qs.set('end', img1);
        fetch(API + '/queue?' + qs.toString(), { method: 'POST' })
          .then((r) => r.json())
          .then((j) => {
            setBusy('');
            setMsg(j.ok ? '✓ 排进去了。关掉这一页它也会继续跑 —— 队列在服务端。' : ('✗ ' + (j.message || '入队失败')));
          })
          .catch((e) => { setBusy(''); setMsg('✗ ' + String((e && e.message) || e)); });
      };

      const pick = (path, which) => { if (which === 0) setImg0(path); else setImg1(path); };

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '4px', maxWidth: '880px' } },

        // ★ 关系图窄带：一眼看出这一步在整条线的哪一段（设计文档 §五）
        h(PipelineBand, { step: 2, note: '出片线 · WanGP 14B · 一条 13.70 分钟' }),

        // ★ 大图预览层（爀曦 04:04：双击要能看到大图）。页面内自己画，不依赖 window.open。
        zoomImg ? h('div', {
          onClick: () => setZoomImg(null),
          style: { position: 'fixed', inset: '0', zIndex: 9999, background: 'rgba(0,0,0,0.82)',
                   display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                   gap: '10px', padding: '24px', cursor: 'zoomImg-out' } },
          h('img', { src: zoomImg.url, alt: zoomImg.name,
                     onClick: (e) => e.stopPropagation(),
                     style: { maxWidth: '92vw', maxHeight: '82vh', objectFit: 'contain',
                              borderRadius: '8px', boxShadow: '0 12px 60px rgba(0,0,0,0.6)' } }),
          h('div', { style: { color: '#e8e8ea', fontSize: '12px', opacity: 0.85 } },
            zoomImg.name + '　·　点任意处或按 Esc 关闭'),
          h('button', { style: { ...S.btn, color: '#fff', border: '1px solid rgba(255,255,255,0.4)' },
                        onClick: (e) => { e.stopPropagation(); setZoomImg(null) } }, '关闭（Esc）'),
        ) : null,

        // ★ 首帧 = 图库选择器（爀曦 2026-10-08 03:26 要求：
        //   「应该链接图库，变成图片首帧选择器，这样子更加方便我输入首帧」）
        //   理由本来就是对的 —— 出片线的首帧来自出图线的产物，让人手粘路径是把机器的活推给人。
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
          h('span', { style: { width: '48px', ...S.hint } }, '首帧'),
          img0
            ? h('img', { src: pickUrl0,
                         style: { height: '46px', borderRadius: '5px', border: '1px solid var(--line,#e2e8f0)' },
                         title: img0, onError: (e) => { e.target.style.display = 'none' } })
            : null,
          h('span', { style: { fontSize: '12px', ...(img0 ? {} : { opacity: 0.55 }) } },
            img0 ? img0.split(/[\\/]/).pop() : '还没选 —— 点下面的图，或直接粘文件名'),
          h('button', { style: S.dfTabOff, title: '取图库里最新的一张（出图线的产物）',
            onClick: () => {
              fetch(API + '/gallery').then((r) => r.json()).then((j) => {
                const it = (j && j.items && j.items[0]) || null;
                if (it) { setImg0(it.path); setMsg('✓ 拿了最新一张：' + it.name); }
                else setMsg('✗ ' + (j && j.message ? j.message : '图库里没有图'));
              }).catch((e) => setMsg('✗ ' + String(e && e.message || e)));
            } }, '拿最新一张'),
          h('button', { style: S.dfTabOff, onClick: () => { setLibOpen(!libOpen); },
                        title: '展开/收起图库' }, libOpen ? '收起图库 ▲' : '展开图库 ▼'),
          // 粘路径的退路留着 —— 但不再是唯一入口
          h('input', { style: { flex: '1 1 240px', minWidth: '150px' }, placeholder: '或直接粘文件名（savedTo）',
                       value: img0, onChange: (e) => setImg0(e.target.value) })),

        // 末帧：S / SE
        h('div', { style: { display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap' } },
          h('span', { style: { width: '48px', ...S.hint } }, '末帧'),
          h('label', { style: { display: 'flex', gap: '4px', alignItems: 'center', fontSize: '12px' } },
            h('input', { type: 'radio', checked: !useEnd, onChange: () => setUseEnd(false) }), '不用（S 锚）'),
          h('label', { style: { display: 'flex', gap: '4px', alignItems: 'center', fontSize: '12px' } },
            h('input', { type: 'radio', checked: useEnd, onChange: () => setUseEnd(true) }), '用（SE）'),
          useEnd ? h('input', { style: { flex: '1 1 320px' }, placeholder: '末帧路径',
                                value: img1, onChange: (e) => setImg1(e.target.value) }) : null),
        // ★ 这句话必须留着 —— 它是操作前要知道的机制，不是解释
        h('div', { style: S.hint }, useEnd
          ? '★ SE 是「拖拽」不是「引导」—— 73% 的位移会落在最后一帧上'
          : '★ 只锚首帧：身份保持最稳（实测 35.7 dB，零漂移）'),

        // 提示词
        h('textarea', { style: { minHeight: '64px', fontFamily: 'inherit' },
                        placeholder: '描述动作…（中英都可，短句更好）',
                        value: prompt, onChange: (e) => setPrompt(e.target.value) }),

        // 时长
        h('div', { style: { display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap' } },
          h('span', { style: { width: '48px', ...S.hint } }, '时长'),
          FRAMES.map((f) => h('label', { key: f.n, style: { display: 'flex', gap: '4px', alignItems: 'center', fontSize: '12px' } },
            h('input', { type: 'radio', checked: frames === f.n, onChange: () => setFrames(f.n) }),
            f.n + ' 帧 = ' + f.s)),
          h('span', { style: S.hint }, '（65 帧实测 4/4 崩，不给）')),

        // 步数 / seed
        h('div', { style: { display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap' } },
          h('span', { style: S.hint }, '步数'),
          h('input', { style: { width: '56px' }, type: 'number', min: 1, max: 30, value: steps,
                       onChange: (e) => setSteps(Number(e.target.value) || 8) }),
          h('span', { style: S.hint }, 'seed'),
          h('input', { style: { width: '100px' }, type: 'number', value: seed,
                       onChange: (e) => setSeed(Number(e.target.value) || 0) }),
          h('button', { style: S.dfTabOff, onClick: () => setSeed(Math.floor(Math.random() * 1e9)) }, '🎲'),
          h('span', { style: S.hint }, '档 5（固定；换档会改画面，不是纯提速）')),

        // ★ 按钮旁边永远写着「要多久」
        h('div', { style: { display: 'flex', gap: '11px', alignItems: 'center', marginTop: '4px' } },
          h('button', { style: S.dfTabOn, onClick: enqueue, disabled: !!busy }, busy || '排进队列'),
          h('span', { style: { fontSize: '13px' } }, '预计 ' + (MINUTES[frames] || '?')),
          msg ? h('span', { style: { fontSize: '12px', color: msg[0] === '✓' ? '#047857' : '#b91c1c' } }, msg) : null),

        // ★ 图库 = 首帧选择器（点一下就是首帧；Shift 点 → 末帧）
        libOpen
          ? (lib.length
              ? h('div', null,
                  h('div', { style: S.hint }, '图库 = 画廊那本账（点一下 → 首帧；Shift 点 → 末帧；双击看大图）· 共 ' + lib.length + ' 条，显示最近 60 条'),
                  h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '5px',
                                      maxHeight: '260px', overflow: 'auto', padding: '2px' } },
                    lib.slice(0, 60).map((it) => {
                      const key = String((it && it.attachment && it.attachment.attachmentId) || (it && it.id) || '');
                      // ★ 传给后端的「首帧」= savedTo（源文件名）；后端自己拼产线目录。
                      //   客户端不知道 COMFY_OUT_DIR，硬拼路径迟早又对不上。
                      const val = String((it && it.savedTo) || (it && it.name) || '');
                      const u = libUrl[key] || '';
                      return h('img', { key: key || val,
                        src: u, title: val,
                        onClick: (e) => pick(val, e.shiftKey ? 1 : 0),
                        // ★ 双击 = 页面内大图预览。原来用 window.open(blobURL)，在宿主里打不开（04:04 实测）。
                        onDoubleClick: (e) => { e.stopPropagation(); if (u) setZoomImg({ url: u, name: val }) },
                        style: { width: '64px', height: '64px', objectFit: 'cover', borderRadius: '5px',
                                 cursor: 'pointer', background: 'rgba(128,128,128,0.12)',
                                 border: (img0 === val) ? '2px solid #0e7490' : '1px solid var(--line, #e2e8f0)' } })
                    })))
              : h('div', { style: { ...S.hint, color: libErr ? '#b91c1c' : undefined } },
                  libErr ? ('✗ 图库读不到：' + libErr) : '画廊账本里还没有图 —— 去「出图」页出一张并保存进画廊，或直接粘文件名。'))
          : null);
    }

    function WorkbenchShell() {
      const [sub, setSub] = react.useState('draw');
      const subs = [
        { id: 'draw', label: '出图' },
        { id: 'stages', label: '技术线四层（已废弃）' },
        { id: 'video', label: '出片' },
        { id: 'queue', label: '队列' },
        { id: 'raw', label: '通用参数' },
      ];
      return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', gap: '8px' } },
        h('div', { style: S.dfTabs }, subs.map((s) =>
          h('button', { key: s.id, style: sub === s.id ? S.dfTabOn : S.dfTabOff,
                        onClick: () => setSub(s.id) }, s.label))),
        h('div', { style: { flex: '1 1 auto', minHeight: '0', overflow: 'auto' } },
          // ★ 2026-10-06：出图页换成三栏工作台（WorkbenchPage）。
          //   老的 DrawPage 还在文件里躺着 —— 要退回去，把 WorkbenchPage 换回 DrawPage 即可。
          sub === 'draw' ? h(WorkbenchPage)
            : sub === 'video' ? h(VideoPage)
            : sub === 'queue' ? h(QueuePage)
            : sub === 'stages' ? h(PanelStages) : h(Panel)));
    }

    // ── 页三 · 提示词效果统计（2026-10-02 做成）──────────────
    // ★ 数据源：宿主半的 /api/cidian → scripts\parse-cidian.mjs 现解析《词效词典》。
    //   ★ 更正一条老注释：词典【不在】D:\AI\chat1\，它在
    //     70-形象\形象工程\05-文档\词效词典.md —— 00-总览.md 第七节专门列过这个易错点。
    // ★★ 纪律：这一页只搬运、不解释。词典里没写的，这里不会出现。
    //   （原来那版写"宁可空着也不写错"是对的，现在数据真的读进来了，所以它不再空着。）
    function StatsPage() {
      const [d, setD] = react.useState(null);
      const [err, setErr] = react.useState("");
      // ★ 2026-10-06 改造：词典从「按批次」变成「按词条」，这一页跟着多了三个状态 ——
      //   搜索词、选中的类别、点开看的大图。folded（批次折叠）随之退役，留着不碍事。
      const [search, setSearch] = react.useState("");
      const [cat, setCat] = react.useState("");
      const [zoom, setZoom] = react.useState("");
      const [folded, setFolded] = react.useState({});

      react.useEffect(() => {
        let alive = true;
        (async () => {
          try {
            const r = await fetch(API + "/cidian");
            const j = await r.json();
            if (!alive) return;
            if (!j || !j.ok) { setErr((j && j.message) || "词典读不出来"); return; }
            setD(j);
          } catch (e) { if (alive) setErr(String((e && e.message) || e)); }
        })();
        return () => { alive = false; };
      }, []);

      // ★ 错误必须先显示 —— Panel 那一页就是被「载入中…」盖住，卡了一整晚。
      if (err) return h("div", { style: S.wrap },
        h("div", { style: S.err }, "读词典失败：" + err),
        h("div", { style: S.hint }, "接口：" + API + "/cidian"),
        h("div", { style: S.hint }, "解析器：dsh-yanqing-line\\scripts\\parse-cidian.mjs"));
      if (!d) return h("div", { style: S.wrap }, "载入中…");

      const TD = { padding: "5px 8px", verticalAlign: "top", fontSize: "12px", lineHeight: 1.55,
                   borderBottom: "1px solid rgba(128,128,128,0.20)" };
      const TH = Object.assign({}, TD, { fontWeight: 600, opacity: 0.72, whiteSpace: "nowrap",
                   borderBottom: "1px solid rgba(128,128,128,0.40)" });

      const tbl = (t) => t ? h("div", { style: { overflowX: "auto", marginTop: "7px" } },
        h("table", { style: { borderCollapse: "collapse", width: "100%" } },
          h("thead", null, h("tr", null,
            t.head.map((c, i) => h("th", { key: i, style: TH }, c)))),
          h("tbody", null, t.rows.map((r, i) => h("tr", { key: i },
            r.map((c, j) => h("td", { key: j, style: TD }, c))))))
      ) : null;

      const paras = (arr) => (arr || []).filter((l) => String(l).trim()).map((l, i) =>
        h("div", { key: i, style: Object.assign({}, S.hint, { marginBottom: "3px" }) }, l));

      const card = { marginTop: "8px", padding: "9px 11px",
                     border: "1px solid rgba(128,128,128,0.26)", borderRadius: "8px" };

      // ★ 搜索 + 类别筛选。都在前端做 —— 五十条词条，没必要往后端跑一趟。
      const kw = search.trim().toLowerCase();
      const shown = (d.entries || []).filter((e) => {
        if (cat && e.category !== cat) return false;
        if (!kw) return true;
        const f = e.fields || {};
        return [e.name, e.category, f["原词"], f["效果"], f["判定"], f["量化"], f["出处"]]
          .filter(Boolean).join(" ").toLowerCase().includes(kw);
      });

      // 词条里写的图是 stickers 目录下的文件名，得走宿主半的只读路由才拿得到
      const imgUrl = (f) => API + "/cidian-img?f=" + encodeURIComponent(String(f || "").replace(/`/g, "").trim());

      return h("div", { style: S.wrap },

        h("div", { style: S.row },
          h("span", { style: { fontSize: "13px", fontWeight: 600 } }, "词效词典"),
          h("span", { style: { flex: 1 } }),
          h("span", { style: S.hint }, (d.entries || []).length + " 条词条 · " +
            (d.categories || []).length + " 类 · " + d.lines + " 行")),
        h("div", { style: S.hint }, "源：" + d.source),

        // 搜索框
        h("div", { style: { display: "flex", gap: "7px", marginTop: "8px", flexWrap: "wrap", alignItems: "center" } },
          h("input", {
            value: search,
            placeholder: "搜词、效果、出处…",
            onChange: (ev) => setSearch(ev.target.value),
            style: { flex: "1 1 220px", minWidth: "170px", padding: "5px 9px", fontSize: "12px",
                     borderRadius: "6px", border: "1px solid rgba(128,128,128,0.35)",
                     background: "transparent", color: "inherit" },
          }),
          h("span", { style: S.hint }, shown.length + " / " + (d.entries || []).length)),

        // 类别按钮
        h("div", { style: { display: "flex", gap: "5px", marginTop: "7px", flexWrap: "wrap" } },
          [{ k: "", t: "全部" }].concat((d.categories || []).map((c) => ({ k: c, t: c }))).map((c) =>
            h("button", {
              key: c.k || "all",
              onClick: () => setCat(c.k),
              style: { padding: "3px 10px", fontSize: "11.5px", cursor: "pointer", borderRadius: "999px",
                       border: "1px solid rgba(128,128,128,0.35)",
                       background: cat === c.k ? "rgba(90,150,220,0.22)" : "transparent",
                       color: "inherit" },
            }, c.t))),

        // 词条卡片
        h("div", { style: { display: "grid", gap: "8px", marginTop: "10px" } },
          shown.map((e, i) => {
            const f = e.fields || {};
            const hasImg = f["图"] && !/待补/.test(f["图"]);
            return h("div", { key: i, style: Object.assign({}, card, { marginTop: 0, display: "flex", gap: "10px" }) },
              hasImg
                ? h("img", {
                    src: imgUrl(f["图"]),
                    onClick: () => setZoom(imgUrl(f["图"])),
                    style: { width: "74px", height: "108px", objectFit: "cover", borderRadius: "6px",
                             cursor: "zoom-in", flex: "0 0 auto", background: "rgba(128,128,128,0.15)" },
                  })
                : h("div", { style: { width: "74px", height: "108px", borderRadius: "6px", flex: "0 0 auto",
                                      background: "rgba(128,128,128,0.12)" } }),
              h("div", { style: { flex: 1, minWidth: 0 } },
                h("div", { style: { fontWeight: 600, fontSize: "12.5px" } }, e.name),
                h("div", { style: Object.assign({}, S.hint, { marginTop: "2px" }) },
                  e.category + (f["出处"] ? " · " + f["出处"] : "")),
                f["原词"] ? h("div", { style: { fontSize: "12px", marginTop: "3px", opacity: 0.92 } }, f["原词"]) : null,
                f["效果"] ? h("div", { style: { fontSize: "12px", marginTop: "4px", lineHeight: 1.5 } }, f["效果"]) : null,
                h("div", { style: { marginTop: "5px", display: "flex", gap: "9px", flexWrap: "wrap", alignItems: "baseline" } },
                  f["判定"] ? h("span", { style: { fontSize: "11.5px" } }, f["判定"]) : null,
                  f["量化"] ? h("span", { style: S.hint }, f["量化"]) : null)));
          })),

        // ★★★ 总规律放在词条之后 —— 它们是从这些词条里长出来的更高一层结论
        (d.laws || []).length ? h("div", { style: S.sec },
          h("div", { style: S.lab }, "★★★ 贯穿性总规律"),
          d.laws.map((l, i) => h("div", { key: i, style: card },
            h("div", { style: { fontWeight: 600, fontSize: "12.5px", marginBottom: "4px" } }, l.title),
            paras(l.body)))) : null,

        // 各类的「本类结论」+ 收尾的方法论备注
        (d.notes || []).length ? h("div", { style: S.sec },
          h("div", { style: S.lab }, "结论与备注"),
          d.notes.map((n, i) => h("div", { key: i, style: card },
            h("div", { style: { fontWeight: 600, fontSize: "12.5px", marginBottom: "4px" } },
              (n.category ? n.category + " · " : "") + n.title),
            paras(n.body)))) : null,

        // 看大图
        zoom ? h("div", {
          onClick: () => setZoom(""),
          style: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.74)", zIndex: 9999,
                   display: "flex", alignItems: "center", justifyContent: "center", cursor: "zoom-out" },
        }, h("img", { src: zoom, style: { maxWidth: "92vw", maxHeight: "92vh", borderRadius: "8px" } })) : null,

        h("div", { style: S.hint },
          "★ 这一页只搬运、不解释 —— 词典里没写的，这里不会出现。改完词典刷新即可看到。"));
    }

    // ── 丹房外壳：三个页签 ────────────────────────────────────
    function DanfangShell() {
      const [tab, setTab] = react.useState("gallery");
      const tabs = [
        { id: "gallery", label: "图库" },
        { id: "work", label: "工作台" },
        { id: "stats", label: "提示词统计" },
      ];
      return h("div", {
        style: { display: "flex", flexDirection: "column", height: "100%",
                 padding: "10px", boxSizing: "border-box", gap: "9px" },
      },
        h("div", { key: "t", style: S.dfTabs }, tabs.map((t) =>
          h("button", {
            key: t.id, style: tab === t.id ? S.dfTabOn : S.dfTabOff,
            onClick: () => setTab(t.id),
          }, t.label))),
        h("div", { key: "b", style: { flex: "1 1 auto", minHeight: "0", overflow: "auto" } },
          tab === "gallery" ? h(GalleryPage)
            : tab === "work" ? h(WorkbenchShell)
              : h(StatsPage)));
    }

    function apply(ctx) {
      ctx.slots.inject("conversation.view", () => ctx.slots.register(
        { name: "conversation.view", id: "danfang", order: 7, label: "丹房" },
        DanfangShell,
      ));
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});
