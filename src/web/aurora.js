/* aurora.js · 天空层（八页共用，<script src="/aurora.js" defer>）
   ─────────────────────────────────────────────────────────────────────────────
   2026-11-11 视觉层重做。注入顺序 = 从下往上：
     底 → 顶弧 → 帷幕×3 → 帘子×26 → 星尘×3 → 横掠 → 地平雾 → 暗角 → 细纹

   为什么帘子要 JS 生成，不写死在 CSS 里：
     极光像不像，取决于**每一道都不一样** —— 宽窄、高矮、相位、摆幅都得随机。
     用 repeating-linear-gradient 做出来是一把梳子（上一版截图里就是竖条纹），
     不是帷幕。26 个节点换来的是一张不重复的天。

   ★ 幂等：已有 #as-sky 就不再插（页面被脚本重挂载也安全）。
   ★ z-index:-1：永远在内容之下，不吃任何字的颜色。
   ★ 视差：只把指针位置写成 --mx/--my（-1..1），位移量写在 CSS 里；
     reduced-motion 时不绑。 */
(function () {
  var ID = 'as-sky';
  var sky = document.getElementById(ID);
  if (!sky) {
    sky = document.createElement('div');
    sky.className = 'as-sky';
    sky.id = ID;
    sky.setAttribute('aria-hidden', 'true');
    sky.innerHTML = build();
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', function () {
        if (!document.getElementById(ID)) document.body.insertBefore(sky, document.body.firstChild);
        bindParallax();
      }, { once: true });
      return;
    }
    document.body.insertBefore(sky, document.body.firstChild);
  }
  bindParallax();

  /* ── 造天 ─────────────────────────────────────────────────────────────── */
  function rnd(a, b) { return a + Math.random() * (b - a); }
  function pick(a) { return a[(Math.random() * a.length) | 0]; }

  // 帘子的三种色相：青绿主调 + 冰青 + 紫（紫只占少数，多了就俗）
  // ★ 必须写在 strands() 里面：注入发生在本 IIFE 的开头，那时函数外的 var 还没赋值，
  //   上一版就栽在这里（TINTS 是 undefined → 抛异常 → 天空整层没插进 DOM）。
  function strands() {
    var TINTS = [
      'radial-gradient(50% 50% at 50% 44%,rgba(74,244,190,var(--o)),rgba(40,190,170,calc(var(--o) * .42)) 44%,transparent 72%)',
      'radial-gradient(50% 50% at 50% 44%,rgba(96,214,255,var(--o)),rgba(70,150,220,calc(var(--o) * .40)) 44%,transparent 72%)',
      'radial-gradient(50% 50% at 50% 44%,rgba(176,132,250,var(--o)),rgba(96,120,225,calc(var(--o) * .36)) 44%,transparent 72%)'
    ];
    var out = '';
    for (var i = 0; i < 24; i++) {
      var w = rnd(70, 260);           // 太窄会读成柱子；宽 + 大模糊才像帘
      var h = rnd(520, 920);
      var x = rnd(-12, 104);           // 故意允许出屏，边缘才不是硬切
      /* 2026-11-11：帘子从「主角」退成「底噪」—— 0.18–0.44 → 0.06–0.17。
         爀曦的定性是「星云、星点」为主，极光只负责让暗部不死。 */
      var o = rnd(0.06, 0.17);
      var tint = i % 9 === 3 ? TINTS[2] : (i % 3 === 0 ? TINTS[1] : TINTS[0]);
      out += '<div class="as-s" style="' +
        'left:' + x.toFixed(2) + '%;width:' + w.toFixed(0) + 'px;height:' + h.toFixed(0) + 'px;' +
        'margin-left:' + (-w / 2).toFixed(0) + 'px;' +
        '--o:' + o.toFixed(3) + ';--bl:' + rnd(6, 18).toFixed(0) + 'px;' +
        '--d:' + rnd(21, 52).toFixed(1) + 's;--dl:' + (-rnd(0, 44)).toFixed(1) + 's;' +
        '--dx:' + rnd(6, 26).toFixed(0) + 'px;--rot:' + rnd(-1.8, 1.8).toFixed(2) + 'deg;' +
        'background:' + tint + '"></div>';
    }
    return out;
  }
  // 星尘：三层，每层一串 box-shadow 点阵（一个元素画几十颗星，最省）
  function stars(n, area) {
    var s = [];
    for (var i = 0; i < n; i++) {
      var x = (Math.random() * area[0]) | 0, y = (Math.random() * area[1] * 0.72) | 0;
      var r = Math.random() < 0.86 ? 1 : 2;
      var a = (0.28 + Math.random() * 0.6).toFixed(2);
      s.push(x + 'px ' + y + 'px 0 ' + (r > 1 ? 0.4 : 0) + 'px rgba(214,236,255,' + a + ')');
    }
    return s.join(',');
  }
  function build() {
    var AREA = [2000, 1200];
    return '' +
      '<div class="as-base"></div>' +
      '<div class="as-crown"></div>' +
      /* ★ 2026-11-11 21:15：星云层 —— 在三道帷幕之下（更远、更慢）。
         帷幕是「一团柔光」，星云是「有结构的云气」：四个错开的色团 + 一层噪声纹。 */
      '<div class="as-nebula"></div>' +
      '<div class="as-veil as-v1"></div><div class="as-veil as-v2"></div><div class="as-veil as-v3"></div>' +
      '<div class="as-strands">' + strands() + '</div>' +
      /* 横向极光条带：压在帘子之上，让整个天有一层「横向的经纬」 */
      '<div class="as-bands"></div>' +
      '<div class="as-stars" style="width:1px;height:1px;box-shadow:' + stars(46, AREA) + '"></div>' +
      '<div class="as-stars b" style="width:1px;height:1px;box-shadow:' + stars(34, AREA) + '"></div>' +
      '<div class="as-stars c" style="width:1px;height:1px;box-shadow:' + stars(26, AREA) + '"></div>' +
      '<div class="as-flow"></div>' +
      '<div class="as-horizon"></div><div class="as-haze"></div>' +
      '<div class="as-vig"></div><div class="as-grain"></div>';
  }

  /* ── 视差 ─────────────────────────────────────────────────────────────── */
  function bindParallax() {
    var mq = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
    if (mq && mq.matches) return;
    if (window.__asParallax) return;
    window.__asParallax = true;
    var raf = 0, mx = 0, my = 0;
    function paint() {
      raf = 0;
      var el = document.getElementById(ID);
      if (!el) return;
      el.style.setProperty('--mx', mx.toFixed(3));
      el.style.setProperty('--my', my.toFixed(3));
    }
    function set(x, y) { mx = x; my = y; if (!raf) raf = window.requestAnimationFrame(paint); }
    window.addEventListener('pointermove', function (e) {
      if (!e || typeof e.clientX !== 'number') return;
      var w = window.innerWidth || 1, h = window.innerHeight || 1;
      set((e.clientX / w - 0.5) * 2, (e.clientY / h - 0.5) * 2);
    }, { passive: true });
    window.addEventListener('blur', function () { set(0, 0); });
  }
})();
