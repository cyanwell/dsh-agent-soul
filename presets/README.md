# presets —— 四个 agent preset 的源

> 这个目录里是**砚青四个 preset 的完整定义**：砚青（标准）、砚青创造、砚青 PTC、砚青蒸馏。
> 它们不是手写的，是**从一台跑通的机器上导出来的**，所以形状一定是能用的。

---

## 一句话

```
node tools/soul-preset.mjs verify          # 看现在缺什么
node tools/soul-preset.mjs build --write   # 缺的补上
# 然后完全退出 DSH 再打开
```

**没有第三步。** 重启是唯一必须手动做的事 —— profile 配置只在启动时读一次，host 不热加载。

### 怎么知道成了（30 秒，不用真开新会话）

重启之后：

1. 打开**新建会话的界面**，在 preset 选择器里切到要验的那个
2. 在输入框里敲 `/compact-region`
3. **它被识别成一个命令**（出现在命令补全里）→ 就成了

★ **不需要真的开这条会话，也不需要真的跑一次压缩。** 命令能被识别，就说明这个 preset 加载成功、`dsh-yanqing-compact-region` 注册上了。

★ 这比「开个新会话真跑一次」好：**更快，而且不消耗额度、不产生任何压缩副作用。**

（2026-10-28 爀曦实测：四个预设全部识别得到。这个方法是他给的 —— 我原来写的是「开新会话跑一次」，比这个笨。）

---

## 五条命令

| 命令 | 方向 | 什么时候用 |
|---|---|---|
| `verify` | 只读 | 不确定现在是什么状态时 |
| `export` | profile → 仓库 | 机器上改好了，想把它变成仓库里的源 |
| `build` | 仓库 → profile | 换机器 / 新装 / 补零件 |
| `split` | 拆共享段 | 开发时（下面第六节） |
| `register` | 新建 | 想加第五个 preset 时 |

★ `build` **默认只比对不写**。看到「一致」就说明不用动；看到「会插入」才加 `--write`。

---

## 文件长什么样

```
presets/
  _shared/
    compaction.yml          ← ★ 压缩段（34 行）唯一的源，四个 preset 共用
  preset-yanqing.yml        ← 标准
  preset-yanqing-cordis.yml ← 创造
  preset-yanqing-ptc.yml    ← PTC
  preset-yanqing-distill.yml← 蒸馏
  _manifest.json            ← 四个的 id / 显示名 / order / 三件套清单
```

**每个 preset 里那行 `# @include $DIR/_shared/compaction.yml` 不是注释，是展开标记。**
`build` 会按它所在位置的缩进，把 `_shared/compaction.yml` 补进去。

★ 所以：**别在这四个文件里改压缩段**，改 `_shared/compaction.yml`。

---

## 为什么这么设计

**因为「注册 preset」我们栽过太多次。** 最狠的一次是 2026-09-30：

> preset 的文件一个都没丢，**丢的是「桌面端认识它的方式」**。
> 文件完好、健康检查 24 行全绿 —— 只是没有任何人去读那个目录了，于是它们从 picker 里一起消失。

**八种栽倒方式**（每条都对应这里的一个设计）：

| # | 栽法 | 这里怎么挡 |
|---|---|---|
| F1 | 写进 `.agent-presets/`（0.2.0-rc.2 起不扫了） | 只认 profile 层，`verify` 会提示那个目录是死的 |
| F2 | 改了没重启 | 每条命令末尾都提醒 |
| F3 | 改错 profile | `--profile` 必填默认值，路径打在输出第一行 |
| F4 | 插件挂不上 | `verify` 会 `resolve` 每个 `dsh-*` |
| F5 | 坏 preset 当默认 | 脚本**从不碰** `default` / `selectedDefault` |
| F6 | 改配置时丢掉别的块 | 只插入、不替换；写前备份；写完复核 bundles 条数 |
| F7 | YAML 方言不兼容（`!!js process.platform`） | **不解析 YAML**，全程文本扫描 |
| F8 | 编码 | UTF-8 无 BOM，写完回读 |

★ **一句话：这五条命令的每一个动作，都在挡上面某一条。**

---

## 压缩段是三件套，不是一件

「能享受压缩机制」分三级，缺一级就是缺：

| 级 | 靠什么 | 说明 |
|---|---|---|
| L1 压缩本身 | `dsh-yanqing-compaction` | 摘要会带门牌 |
| L2 裁剪带门牌 | `dsh-yanqing-pruner` | 被裁的工具结果也能回取 |
| **L3 范围压缩** | `dsh-yanqing-compact-region` | **换气第二档治疗**，只压最近一段然后继续 |

★ 2026-10-28 之前，四个 preset 里**只有标准那一个**有 L3。另外三个压缩是有的、门牌是有的，**但换气救不回思考**。

`verify` 就是为这个写的 —— 它一跑就把这个差距打出来了。

---

## 开发时：改压缩段

```
# 1. 改 _shared/compaction.yml
# 2. 展开验证（不写盘）
node tools/soul-preset.mjs build
# 3. 如果显示「一致」→ 说明展开正确，可以提交
```

**如果改了压缩段之后 `build` 显示不一致，那是正常的** —— 因为 profile 里还是旧的。加 `--write` 才写进去。

### `split` 是干什么的

**一次性工具。** 把「四份复制」变成「一份源」。

前提：**几份必须逐字节相同**（它会先验，不同就拒绝）。

★ 现在这个仓库里已经拆过了，**正常开发不需要再跑 `split`**。

### `@include` 的坑（改展开逻辑时注意）

`split` 给共享文件加的说明注释（开头那几行 `#`），**不能**在展开时插进 preset —— 否则 hash 全变。

所以展开逻辑会**跳过共享文件开头连续的 `#` 行**，但**段内部**的 `#` 注释必须保留（`compaction.yml` 里有十几行是解释性的，那些要留着）。

★ 这个坑踩过一次：注释跑进产物里了，而它看起来像正常内容，**不会报错**。

---

## 换机器怎么用

```
git clone https://github.com/cyanwell/dsh-agent-soul
cd dsh-agent-soul
node tools/soul-preset.mjs verify --profile desktop   # 先看目标环境缺什么
node tools/soul-preset.mjs build --write              # 补上
# 退出 DSH，重新打开，去「设置 → Agent preset」看四个在不在、有没有红标
```

**要求**：四个 `dsh-yanqing-*` 零件已经装在目标 profile 的 `node_modules` 里。`verify` 会告诉你哪个 resolve 不到。

---

## 已知的没做的

- **`soul-version.json` 还没有** —— 所以「现在装的是哪一版」仍然读不出来。
- **`build --write` 会重写整份 patch**（虽然只插一处）。大文件上应该改成精确插入。
- **没测过 Windows 以外的环境。**
