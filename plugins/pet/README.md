# dsh-yanqing-pet · 交接

砚青的 GUI 宠物。**真包**（不是动态插件），装进 profile `web`，重启 DSH 后进
`window.__DSH_BOOT__.entries`。

---

## 一、架构（2026-09-24 改版后）

```
dsh-yanqing-pet/
  package.json          dsh.bundle.patch + dsh.client.platform=web + exports["./client"]
  cordis.patch.yml      - insert: [- id: dsh-yanqing-pet / name: dsh-yanqing-pet]
  index.js              宿主半：注册 50 条素材路由 + /manifest.json + /health
  client-template.js    ★ 浏览器半的【可维护源码】
  client.js             由 build-client.py 从模板拷出来的产物（15.9 KB）
  build-client.py       构建：校验素材齐不齐 → 拷成 client.js
  assets/
    faces/   20 张  340x496 webp   open / smile / happy / surprised / sad / angry /
                                   serious / wry / thinking / tired / blink / laugh /
                                   confused / determined / pout / shy / sleepy / wink / yawn / wronged   ← 后两个是 2026-10-04 加的
    frames/  32 张  340x496 webp   idle 8 / working 6 / waiting 6 / done 6 / poke 6
```

### ★★ 为什么素材走 HTTP 路由而不是内嵌 base64

50 张图内嵌会让 `client.js` 到 **2 MB 以上**，而它是**每次页面加载都要解析**的启动期
资源。走路由之后浏览器自己缓存、只加载用到的那几帧 —— `client.js` 只有 **15.9 KB**。

路由清单（`index.js` 启动时扫 `assets/` 自动注册，加素材只要丢文件进目录）：

| 路由 | 作用 |
|---|---|
| `/yanqing-pet/faces/<名>.webp` | 表情差分（18 张）|
| `/yanqing-pet/frames/<动作>-NN.webp` | 动画帧（32 张）|
| `/yanqing-pet/manifest.json` | 清单：有哪些表情、每个动作几帧 |
| `/yanqing-pet/health` | 探活：一条命令确认包和素材都就位 |

**验收命令**（不开浏览器就能验）：
```powershell
(Invoke-WebRequest "http://127.0.0.1:3080/yanqing-pet/health" -UseBasicParsing).Content
# 期望 {"ok":true,"count":50,"faces":18,"frames":{"done":6,"idle":8,"poke":6,"waiting":6,"working":6},"missing":[]}
```

### ★ 路由必须用 `ctx.effect()` 包起来
否则插件卸载时路由不会撤销，重启后旧 handler 会和新 handler 抢同一个 path。

---

## 二、动画：为什么是逐帧，不是 CSS

**CSS 只能做【整体】的旋转/缩放/位移** —— 整个人像一个刚体在动。
真人（和动画角色）的动作是**分层的**：上半身摆得比下半身大，头发比头晚半拍。
这种非线性形变 CSS 做不了，只能预先烘成帧。

`D:\AI\chat1\make-frames.py` 的形变模型（两个自由度，都按高度加权）：

```
u = 1 - y/H                                            # 1=顶部 0=底部
dx(u) = A * u^1.6 * sin(2πp + LAG*u)                   # 越靠上水平摆得越多，且相位滞后 → 头发甩
dy(u) = B * u^0.8 * sin(4πp)                           # 上半身的呼吸起伏（频率是摆动的两倍）
+ 绕【底部中心】的小角度旋转                              # 整个人像不倒翁
```

用法：`python make-frames.py <输入.webp> <输出目录> <前缀> <帧数> [A] [B] [角度] [LAG]`

当前参数：
| 动作 | 帧 | A | B | 角度 | LAG | 意图 |
|---|---|---|---|---|---|---|
| idle | 8 | 3.0 | 2.0 | 0.80 | 0.90 | 慢呼吸 + 轻摆 |
| working | 6 | 1.8 | 3.2 | 0.45 | 1.40 | 纵向起伏多（像在打字）|
| waiting | 6 | 4.0 | 1.4 | 1.30 | 0.60 | 左右摆得多（在张望）|
| done | 6 | 1.2 | 6.0 | 0.50 | 0.40 | 蹦一下 |
| poke | 6 | 2.0 | 5.0 | 1.00 | 0.50 | 被点一下的弹跳 |

★ **实现坑**：行位移**不能用 `np.roll`** —— 它会把边缘绕到另一侧。必须用切片填透明。

---

## 三、表情差分

`D:\AI\chat1\make-faces.mjs`：以 `pet-work/pet-src.png` 为底做 img2img。
`node make-faces.mjs "blink:0.55:2026,laugh:0.58:2026,..."`

★★ 三条硬约束：
1. **走 img2img 不走 txt2img** —— txt2img 改 prompt 会把姿势和衣服一起换掉。
2. **所有表情必须共用同一张画布** —— 宠物用【整幅图的百分比】定位眼睛，
   尺寸差一点，切表情时人物就跳。init 固定 832×1216，输出统一 340×496。
3. **负面必须压 `smile/grin`** —— 参考图里她是笑着的，img2img 会把那个笑原样带过来，
   不压制的话每个表情都变成"笑着做那个表情"。

抠图：**用 `matte2.py` 的 `matte2()`**（2026-10-04 起；`make-pet-faces-webp.py` 已改指向它）。
★ **绝不裁 bbox** —— 一裁百分比全错位。

★★ **2026-10-04 第二课：判据收紧要往两边看；`sat` 上限太宽会啃人物高光。**
`matte.py` 的判据是「够亮(lum≥196) + 够灰(sat≤30)」。但**发顶高光最亮处趋近白色**（sat 掉到 10 上下），
而那一圈正好在人物轮廓上、与背景直接相接 —— 泛洪于是顺着高光带整片漫进头发和脸。
缩到 340 宽之后的表现：**头顶缺一块、白衬衫被啃出灰洞**（爀曦截图指出）。
`matte2.py` 收到 `lum≥235 / sat≤14`、边缘半透明 `alpha 170→225`，并**按四角背景自动校准**
（换一批背景更暗的图就放宽，宁可松一点也不要漏抠）。
★ **判据要两个方向一起看**：只看「渗漏变少」会一路收到 250，而背景本身只有 238–251，泛洪直接归零。
★ 顺带：`frames/` 是用 **`serious.webp`** 做基准烘的（`make-frames.py`），
所以 faces 换了之后 **frames 必须一起重烘**，否则动画里还是旧毛病。
★ 输出**强制 resize 到精确 340×496**（832×1216 按比例会算出 496.9 → 497，差 1 像素切换时也会跳）。

★★ **2026-10-04 换装那一轮踩的坑，写在这儿免得再踩：判据要「亮而灰」，不是「纯亮度」。**

我先用了新写的 `pet-assets.py`（泛洪起点 lum≥236、lum≥250 才算全透明），
20 张全部报「透明占比 0.1%」。查下来**不是抠图失败** —— img2img 出来的图背景亮度是 **246**
（纯底图是 253），整片背景落进「半透明」区间（alpha≈72），界面上是一层白雾；
而它只数 alpha==0 的点，所以读数低到 0.1%，实际泛洪覆盖 **60%**。
换成 `matte()` 的「亮而灰」判据（`BG_LUM_MIN=196` 且 `BG_SAT_MAX=30`）当场正常，透明 61–62%。

★ 判据：**阈值型抠图，先量一遍这一批背景的实际亮度分布再定阈值。
底图和 img2img 产物的背景亮度不是一回事，别把上一批的阈值带过来。**

★ 现在的正式工具是 `70-形象\形象工程\06-工具\make-pet-faces-webp.py` ——
调 `matte()`、输出不带前缀、自带产物把关。**透明占比低于 5% 直接报错**，这条必须留着：
源图背景偏深时 `matte()` 一个像素都抠不动却**不报错**，会静默输出全不透明的图，
界面里显示成一块深色方块 —— 比报错难查得多。

★ 顺手记一条：`profile desktop` **不允许**命令行 `plugin add`
（报 `managed exclusively by the Electron application`）。它的素材要 **robocopy** 直接拷进
`profiles\desktop\node_modules\dsh-yanqing-pet\assets\` —— `Copy-Item` 会被正在使用的文件锁住，
robocopy 自带重试能过。三个 profile（desktop / desktop-probe / web）**各有独立副本**，都要同步。

### 交互：拖动 / 缩放（2026-10-04 爀曦要的）

- **拖动**：按住往哪拖都行，松手停在原地，位置写进 `localStorage`（键 `yq-pet-box`），下次打开还在那儿。
- **缩放**：鼠标在身上滚滚轮，120–520 px。宽度和位置存在同一份记录里。
- **点击**还是戳一下（poke）；**拖完那一次 click 会被吞掉** —— 不然每次拖完都要被戳一下。
- 拖出屏幕时**至少留 60×80 在可视区**，拖不丢。

★★ **踩过的坑（必读）—— 这一节被推翻过一次，全过程都留着，因为推理过程比结论值钱。**

**最后生效的写法：绑定不放 `useEffect`，挂在 React 的回调 ref 上。**

```js
function bindDrag(el) {
  if (!el || el.__yqDragBound) return;   // 幂等：重复渲染不重复绑
  el.__yqDragBound = 1;
  el.addEventListener("pointerdown", onDown);
  ...
}
// render 里：
ref: function (n) { window.__yqPetEl = n; bindDrag(n); },
```

**为什么**：2026-10-04 用桌面端自己的 CDP 口（9222）一层层验出来的事实链 ——
包在 `__DSH_BOOT__.entries` 里 ✓、元素渲染且样式全对 ✓、
临时往元素上加监听再打一发合成 `pointerdown` 收得到 ✓（事件系统正常）、
帧动画那个 effect 也在跑 ✓（`useEffect` 本身正常）——
**但元素上就是没有我的监听器，`localStorage` 从没被写过。**
⇒ 那个 effect 里的 `addEventListener` 从没执行到。
而回调 ref 是**实测一定会执行**的（`window.__yqPetEl` 一直有值），所以改挂到它上面，不赌 effect 时机。

**走过的两条弯路**（都因为「只改一处就重启试」，代价是爀曦替我试了三次）：
① 一开始用 `react.useRef(null)` 拿节点、没兜底 → 整个组件抛错、宠物不渲染；
② 改成 `document.querySelector(".yq-pet")` 写进 effect → 也没绑上（就是上面那个时机问题）。

★ **拖动态写 inline style，不写 class** —— React 重渲染会把 `className` 整个换掉，
拖动中途状态一翻页（idle→working），拖动态就没了、元素会抬起来抖一下。

★ **改客户端半之前先跑 `node test-client.mjs`**（拿假 React 把模块跑一遍）。
★ **想知道页面上到底发生了什么，用 `node cdp-eval.mjs "<js>"`** ——
它通过桌面端自带的 CDP 口（启动参数里的 `--remote-debugging-port=9222`）在真实页面里跑 JS。
`cdp-probe.mjs` 是宠物专用体检（入口图、元素、样式、模拟一次拖动，一次看全）。
**这两个工具存在的唯一理由：不再拿爀曦当测试员。**

---

## 四、改代码 / 加素材之后怎么生效

| 改了什么 | 要做什么 |
|---|---|
| `assets/` 里的图（换帧、加表情）| **只改 `assets/` 不够** —— 装机是 `file:` 拷贝，要重跑 add；然后重启 |
| `client-template.js` | `python build-client.py` → 重跑 add → **重启 DSH** |
| `index.js` | 重跑 add → **重启 DSH**（路由在启动时注册）|

重装命令（**`dsh` 不在 PATH，用 node 直接跑；pnpm 也要在 PATH**）：
```powershell
$env:PATH = "D:\AI\dsh-tools\bin;C:\Users\pc\.workbuddy\binaries\node\versions\22.22.2-3;" + $env:PATH
& "C:\Users\pc\.workbuddy\binaries\node\versions\22.22.2-3\node.exe" `
  "D:\AI\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js" plugin --profile web add file:D:/AI/dsh-tools/dsh-yanqing-pet
```
★ `Packages: +6 -10` 是 pnpm 的常态，**无害** —— 但要核对 `dsh.profile.bundles` 数量没变
（当前 16）且非 scoped 插件逐个都在 `node_modules` 里。

★★ **装机前先干跑 `index.js` 的扫描逻辑**（用 node 单独跑一遍读目录那段）。
这条救过一次：表情文件名带 `face-` 前缀时清单的键会和 `STATE.face = "open"` 对不上，
**脸上会永远停在兜底那张**，而浏览器里只表现为"表情不换"，很难查。

---

## 五、浏览器里怎么验（不要只看截图）

★★ **截图会被壁纸和余额浮层干扰，而且 `captureScreenshot` 抓不到 WebGL** —— 别拿截图当证据。

正路是用 Firefox BiDi（`D:\AI\chat1\fb.js`）读 DOM：
```powershell
# 1. 起火狐（路径是 C:\Program Files\Mozilla Firefox\firefox.exe，没有 Mozilla\Firefox 这两级）
Start-Process "C:\Program Files\Mozilla Firefox\firefox.exe" -ArgumentList `
  '-profile','C:\Users\pc\AppData\Roaming\Mozilla\Firefox\Profiles\8zplhbsj.default-release', `
  '--remote-debugging-port','9222','-width','1200','-height','900'
Start-Sleep 14
& $node D:\AI\chat1\fb.js go "http://127.0.0.1:3080" 12000
& $node D:\AI\chat1\fb.js js D:\AI\chat1\probe-pet2.js
```

`probe-pet2.js` 会返回：`cls` / `vis` / `rect` / `natural` / `complete` / `src` /
**`occluded`**（`elementFromPoint` 判有没有被盖住）/ `topEl`。

★ **`occluded` 这条最关键** —— 它排除「截图上看着在那儿、其实被壁纸盖住了」这种假象。
★ 顺带也能验出**帧在动**：连续采 8 次，`src` 应该在 `frames/<动作>-NN.webp` 之间循环
（实测抓到过 `working-00 → 04 → 02 → 01 → 04 → 00 → 02 → C:blink.webp`）。

---

## 六、当前状态（2026-09-24 已验证）

```
health   ok=true  count=50  faces=18  frames{done:6,idle:8,poke:6,waiting:6,working:6}  missing=[]
浏览器    cls="yq-pet yq-pet--idle"  vis=block/visible/z40  rect=[1004,546,170,248]
          natural=340x496  complete=true  occluded=false  topEl=DIV.yq-pet-body
```

行为：
- 状态 → 动作：`idle`/`working`/`waiting`/`done`/`failed`，轮询 900ms
- `working → idle` 会放一次 `done`（蹦一下 + 笑）
- 点击 → `poke` 帧 + `surprised` 脸
- 闲着每 9~17 秒随机换个脸（smile/thinking/wry/laugh），每次 2.6 秒
- 闲 4 分钟犯困（`sleepy`），9 分钟睡着（`blink`）
- **眨眼是真的**：切到 `blink` 差分，不再拿肤色椭圆盖眼睛
