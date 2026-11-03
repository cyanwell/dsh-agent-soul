# 姿势素材怎么做（2026-10-05 摸出来的配方）

> 这一份是**产线配方**，不是过程记录。过程在
> `D:\AI\yanqing-soul\50-日记\16-她坐在屏幕的沿上.md`。
> 下次要给砚青加新姿势 / 重做旧姿势，照这里做，不要再从零试。

---

## 一、先说结论：姿势必须用 txt2img，不能用 img2img

★ **这一条是整晚最重要的判据。**

一开始走的是 img2img（拿站立立绘当底图改），三档 denoise 全部失败：

| denoise | 结果 |
|---|---|
| 0.68 | **姿势完全没变**，出来还是站着 |
| 0.76 + 身份复述 | 坐姿成了，但蹲 / 趴 / 靠 / 盘腿**还是站着** |
| 0.86 | 姿势对了，**人整个换了**（深蓝短发、橙眼、黑吊带裙） |

**为什么**：img2img 锁的不是画风，是**构图** —— 人在画面里占多高、在哪个位置。
而「坐下 / 蹲下 / 趴下」恰恰就是要改构图。**参数救不了方法错。**

★ 反过来看那条「为什么 sit 能成」：因为 sit 只是「坐上了一个台子」，人还是那么高，
构图没动。**所以它能成，是例外，不是规律。**

**⇒ 姿势一律走 txt2img。**

---

## 二、配方（照抄即可）

```
node "D:\AI\dsh-tools\dsh-yanqing-line\scripts\anchor.mjs" "<姿势描述>, full body, pure white background, blank white backdrop, studio white" --size 832x1216 --style soft --prefix yqpose-<名字> --outfit "cream white ruffled blouse with puff sleeves, dark plaid bow at the collar, black high-waisted long skirt with layered ruffles, white ankle socks, black loafers"
```

四个必须写死的东西：

1. **`--style soft`** —— ★ 默认就是 soft，**但要显式写**，免得哪天默认值改了。
   ★★ `anime` 档**不能用**：脚本自己的注释里写着「这一档脸偏幼，不适合当砚青本人定妆」。
   （我第一张就踩了这个，出来脸圆圆的很幼。）
2. **`--outfit "<宠物那身>"`** —— 不写就落到 `mature` 档（紫色露肩 + 黑皮质束腰），和宠物对不上。
3. **白底三连**：`pure white background, blank white backdrop, studio white`。
   ★ 只写一句 `plain white background` 会被画风词盖掉（第一张跑出来是纯黑底，抠图直接报废）。
4. **输出名带 `yqpose-` 前缀** —— 后面的抠图脚本按这个名字找。

**尺寸固定 832×1216**（和所有立绘同画布）。

---

## 三、六个姿势的提示词（已跑通，可直接复用）

| 名字 | 提示词主体 |
|---|---|
| sit | sitting on the edge of a ledge, legs dangling down, hands resting beside her hips, calm expression, facing the viewer |
| squat | crouching down low, hugging both knees, looking up at the viewer, small curious expression |
| lie | lying on her stomach, propped up on both elbows, chin resting on one hand, lower legs bent up behind her, relaxed |
| lean | sitting sideways leaning back against a wall, hugging her knees, eyes closed, dozing off peacefully |
| corner | sitting with knees drawn up, holding a warm mug with both hands, gentle content expression |
| stretch | stretching both arms high above her head, eyes closed, back arched, just woke up |

（每个后面都接 `, full body, pure white background, blank white backdrop, studio white`）

★ **身份串不用自己写** —— `anchor.mjs` 会自动前置 `CHARA`（浅蓝→紫渐变长发、齐刘海、蓝蝴蝶、紫眼睛）。
★★ **但也因为它是自动加的，所以千万不要在提示词里再写一遍身份** —— 会和 `--outfit` 抢权重。

---

## 四、出图之后：抠图 + 缩到 340×496

```
python "D:\AI\yanqing-soul\70-形象\形象工程\06-工具\make-pose-assets.py"
```

- 读 `D:\AI\comfyui\ComfyUI\output\yqpose-*.png`
- 抠图核心复用 `matte2.py`（`BG_LUM_MIN=235` / `BG_SAT_MAX=14` / `EDGE_ALPHA=225`）
- 输出 `D:\AI\dsh-tools\dsh-yanqing-pet\assets\poses\<名字>.webp`，**340×496，透明底**
- ★ **验收判据**：脚本会打「透明 xx%」——**低于 5% 就是抠失败**，脚本会以 exit 1 退出。

实测六张：透明 46–54%，每张 37–45 KB。

---

## 五、帧动画的幅度（2026-10-05 爀曦要求「像呼吸」）

工具：`D:\AI\chat1\make-frames.py`（参数：`A` 横向摆 / `B` 纵向起伏 / `ANG` 旋转 / `LAG` 相位滞后）

★ **旧的幅度是给「动作」设计的，当常驻状态太活泼**（他说「摇晃不用那么明显」）。

| 组 | 新参数 | 帧数 |
|---|---|---|
| idle | A=0.8 B=1.2 ang=0.18 lag=0.60 | 12 |
| working | A=0.5 B=1.6 ang=0.10 lag=0.90 | 10 |
| waiting | A=1.1 B=0.9 ang=0.28 lag=0.50 | 12 |
| done | A=0.4 B=2.4 ang=0.12 lag=0.40 | 10 |
| poke | A=0.6 B=1.8 ang=0.22 lag=0.50 | 10 |

（旧值：idle 8 帧 A=3.0 B=2.0 ang=0.80；幅度降到约三分之一。）

★★ **另一个让动画变慢的旋钮：帧数**。fps 不变的前提下，帧数从 8 提到 12，
一圈的时间就长了 50% —— **不用改任何代码**。

---

## 六、部署（这一步踩过坑，务必按顺序）

```
python build-client.py
copy index.js 到 profile          ← ★ 单独拷！别用 robocopy /E 一把梭
robocopy assets\poses  → profile\...\assets\poses /E
robocopy assets\frames → profile\...\assets\frames /MIR   ← 帧数变了要 /MIR 清旧的
```

★★★ **为什么不能一把梭**：`robocopy 源 目标 /E` 是**按顺序**走的，
它卡在第一个被锁的文件上（`client.js` 会被 DSH 进程读着）就**无限重试、永远不往后走** ——
于是 `index.js` 和 `assets\poses` 一个都没拷过去。
症状极具迷惑性：**客户端半是新的（新函数存在），宿主半是旧的（新路由 404）**。

**★ 部署后必须从外部验证**，不要只看时间戳：

```
curl.exe -s http://127.0.0.1:19387/yanqing-pet-v3/manifest.json     # poses 在不在
curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:19387/yanqing-pet-v3/poses/sit.webp
```

**改完客户端半 / 宿主半都要重启桌面端**（`Invoke-CimMethod ... restart-desktop.cmd`）。

---

## 七、改这两个文件之前先跑测试

```
python build-client.py && node test-client.mjs
```

★★ **注意顺序**：`test-client.mjs` 读的是**构建产物 `client.js`**，不是源码模板。
不 build 就测，测的是旧产物，会给你一个漂亮的假绿灯（2026-10-05 就这么被骗过一次）。

测试本身也在那天重写过一次（旧版是假绿：假 React 的 setState 是空壳、ref 从不被调用，
它检查的是一个「载入中」的空壳）。现在是：**真渲染 → 跑 effect → 二次渲染 → 遍历树调 ref → 查事件绑定**。
