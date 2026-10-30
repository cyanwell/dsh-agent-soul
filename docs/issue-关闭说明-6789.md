# 四个 issue 的关闭说明

> 这份文件是**关闭 #6 #7 #8 #9 的正式理由**。
> 之所以不走 issue 评论，是因为浏览器到不了 GitHub 的评论框（见 `docs/issue-台账.md` 的「能力边界」一节）。
> 改用 commit message 的 `Closes #N`：**GitHub 会把它渲染成「这个 commit 关闭了 #N」，同样落在远端、同样可追溯。**

---

## 关闭依据：同一个 PR

四条 issue 由 **PR #13** 一并修复（作者 **jing-hy**，`7f1eef1`），已 merge 进 main（`af41d0d`）。

**她的定性我原样保留：**

> 这四条 issue 是同一个形状：**系统对外呈现的状态和它的真实状态不一致，而且不一致的地方没有出口。**
> 四条改动彼此独立，可以单独 review、单独回退。

### 四条分别修了什么

| issue | 根因 | 修法 |
|---|---|---|
| **#6** 时钟弹层向下出界 | **不是坐标算错，是坐标系错了** —— 面板渲在 slot 的 React 子树里（实测席位 256×36 px），靠 `position: fixed` 想逃出去；但祖先链上有 `backdrop-filter`，`fixed` 就改相对那个祖先，于是任何「按视口」算的 `top`/`bottom` 都错位 | 挂 `document.body` + 量真实尺寸 + 四边夹 + `getBoundingClientRect()` 回读校准 |
| **#7** echo 浅色主题不可读、折叠误触 | 配色写死 | 改读宿主主题变量 `--dsw-alias-label-primary/secondary/tertiary`、`--dsw-alias-border-l2`；拿不到退回深色字；深色宿主由 `.yq-root[data-tone="dark"]` 接管 |
| **#8** 「自研」措辞 | —— | 改掉 |
| **#9** 插件页未启动 | —— | 修好 |

### 为什么这四条可以关

**它带了两套可复跑的验收**，不是「改完就说好了」：

| 脚本 | 内容 |
|---|---|
| `plugins/clock/verify-position.mjs` | **162 组几何**。其中 B 组是对根因的**反证**：1440×900 下旧实现算出 `top=1580`，整体在窗口外 |
| `plugins/clock/verify-browser.mjs` | **真 Chrome，24 条断言**（A 本实现 / B 旧实现 / C 挂错容器） |

**★ 尤其是那个「反证」** —— 它证明了旧实现**必然**失败，而不只是新实现能过。
这是「知道它为什么坏」和「知道它现在好了」的区别，**两条都给出才算修完**。

### 合并时的验证

| 步骤 | 结果 |
|---|---|
| 在 pr13 分支上跑 `tools/verify-packaging.mjs` | **116 / 117**（唯一失败项和 main 上同一个） |
| 与 main 合并 | **无冲突**（11 个文件自动合并成功） |
| 合并后跑 | **122 / 123**（失败项仍是 README 那条历史问题） |

**→ 「122/123」这个数说明：她的代码没有碰坏任何已检查项。**

---

## 如果这四条还有人复现

**不要重开这四条** —— 请新开一条，并附上：

1. **DSH 版本**（`0.2.1-rc.2`？更高？）
2. **窗口尺寸**（根因和尺寸强相关：`backdrop-filter` 祖先的格子是 256×36）
3. `plugins/clock/verify-position.mjs` 的输出（它会告诉你是几何算错了，还是根本没渲染）

**★ 因为「同一个症状」可能是新的根因。** 把新证据开在新 issue 里，比在旧 issue 下堆「我也遇到了」有用。

---

## 附：为什么不用 issue 评论

**技术原因，不是不想。** 试过八种办法（`press End` / `wheel` ×3 / `#issuecomment-new` 锚点 / 两个 CSS selector / `cursor` 翻页 / 窄视口），
`scroll-to` 证明滚动生效，但 `html` 全文 grep `Add a comment` = **0 次** —— 评论框从未渲染。

**GitHub 的新 issue UI 是 React 客户端渲染，评论框点击才展开，`browser_*` 触不到那个点击。**

完整证据链在 `docs/issue-台账.md`。**这是我这个会话的能力边界，不是偷懒。**
