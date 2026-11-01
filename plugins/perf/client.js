window.__ModuleLoader__.load({
  id: "dsh-agent-perf",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");

    const STYLE_ID = "yq-perf-style-v1";
    const DENSE = [
      '[class*="markdown"] > p',
      '[class*="markdown"] > :where(ul, ol)',
      '[class*="markdown"] > pre',
      // ★ 2026-11-01 补：标题与引用块也曾各自吃一个合成层。
      //   之前的测量没暴露它，是因为当时页面上恰好没有标题 ——
      //   也就是说「只剩 8 个」那次读数是「页面内容碰巧简单」的产物，不是护栏完整。
      '[class*="markdown"] > :where(h1, h2, h3, h4, h5, h6, blockquote)',
      '[class*="markdown"] > :where(div, section, table, hr)',
      '[class*="tableScroll"]',
      '[data-disclosure-row]',
      '[class*="md-code-block"]',
      '[data-slot="main.conversation"] [class*="callRow"]',
      '[data-slot="main.conversation"] [class*="bubble"]',
      '[data-slot="main.conversation"] [class*="title"]',
      '[data-slot="main.conversation"] [class*="anchor"]',
      '[data-slot="main.conversation"] [class*="overlayLayer"]',
      '[data-slot="main.conversation"] [class*="hE4tRW_root"]',
      '[data-slot="main.conversation"] [class*="BE0jCW_title"]'
    ].join(',');
    const CSS = `${DENSE}{backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}`;

    function ensureStyle(on) {
      let el = document.getElementById(STYLE_ID);
      if (!on) { if (el) el.remove(); return; }
      if (!el) { el = document.createElement('style'); el.id = STYLE_ID; document.head.appendChild(el); }
      if (el.textContent !== CSS) el.textContent = CSS;
    }

    function PerfPanel() {
      const [on, setOn] = react.useState(() => localStorage.getItem('yq-perf-enabled') !== '0');
      react.useEffect(() => { ensureStyle(on); localStorage.setItem('yq-perf-enabled', on ? '1' : '0'); }, [on]);
      return react.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', padding: '8px 12px', fontSize: 12 } },
        react.createElement('strong', null, '渲染护栏'),
        react.createElement('span', null, on ? '已移除密集 markdown 毛玻璃' : '原始样式'),
        react.createElement('button', { onClick: () => setOn(!on) }, on ? '关闭优化' : '开启优化'),
      );
    }

    function apply(ctx) {
      // ★★ 2026-11-01 修的实 bug：护栏原来只在 PerfPanel 的 useEffect 里注入，
      //   而面板是个 tab —— **用户不点开「性能」，useEffect 永远不跑，护栏就不存在**。
      //   实测：重启后 style 缺失、backdrop 189 个、空转层 182 个；点开面板才生效。
      //   护栏必须跟着插件加载走，不能指望用户去点一个他根本不知道要点的标签。
      const on = localStorage.getItem('yq-perf-enabled') !== '0';
      const boot = () => { try { ensureStyle(on); } catch (e) { /* 注入失败不能拖垮插件加载 */ } };
      boot();
      // apply 时 document.head 可能还没就绪，补一次
      if (!document.head) {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
      }

      ctx.slots.inject("conversation.view", () =>
        ctx.slots.register(
          { name: "conversation.view", id: "yanqing-perf", order: 9, label: "性能" },
          () => react.createElement(PerfPanel)
        )
      );
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});
