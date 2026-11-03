# -*- coding: utf-8 -*-
"""生成 dsh-yanqing-pet 的 client.js

★ 2026-09-24 改版：**不再内嵌 base64**。
  表情 18 张 + 动画帧 32 张，内嵌会让 client.js 到 2 MB 以上，
  而它是每次页面加载都要解析的启动期资源。
  现在素材走宿主半注册的 HTTP 路由（index.js 里的 /yanqing-pet/*），
  客户端启动时拉一次 /yanqing-pet/manifest.json 就知道有哪些素材。

  所以这个脚本现在只做两件事：**校验素材齐不齐** + **把模板拷成 client.js**。
  （保留它而不是直接手拷，是为了让"素材缺失"在构建期就报出来，
    而不是等到浏览器里宠物一片空白才发现。）

用法：python build-client.py
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, "assets")

# 客户端 client-template.js 里会引用的表情（STATE 表 + IDLE_FACES + 眨眼/困）
NEEDED_FACES = [
    "open", "smile", "happy", "surprised", "sad", "angry", "serious", "wry",
    "thinking", "tired", "blink", "laugh", "confused", "determined", "pout",
    "shy", "sleepy", "wink",
]
# 动作序列：名字 = assets/frames/<name>-NN.webp 的前缀
NEEDED_SEQS = ["idle", "working", "waiting", "done", "poke"]

faces = {}
d = os.path.join(ASSETS, "faces")
if os.path.isdir(d):
    for n in sorted(os.listdir(d)):
        # ★ 文件名就是键：assets/faces/open.webp -> "open"
        #   （早期叫 face-open.webp，会多出一个 face- 前缀，
        #     导致清单的键和 client-template.js 里的 STATE.face 对不上 —— 干跑抓到过）
        if n.endswith(".webp"):
            faces[n[:-5]] = os.path.getsize(os.path.join(d, n))

seqs = {}
d = os.path.join(ASSETS, "frames")
if os.path.isdir(d):
    for n in sorted(os.listdir(d)):
        if not n.endswith(".webp"):
            continue
        stem = n[:-5]
        if "-" not in stem:
            continue
        name = stem.rsplit("-", 1)[0]
        seqs.setdefault(name, []).append(os.path.join(d, n))

missing = [f for f in NEEDED_FACES if f not in faces]
empty = [s for s in NEEDED_SEQS if len(seqs.get(s, [])) < 2]

print("=== 素材检查 ===")
print("  表情 %d 张，合计 %.0f KB" % (len(faces), sum(faces.values()) / 1024))
for s in NEEDED_SEQS:
    fs = seqs.get(s, [])
    sz = sum(os.path.getsize(p) for p in fs)
    print("  动作 %-9s %2d 帧  %6.0f KB" % (s, len(fs), sz / 1024))

if missing:
    print("\n  [FAIL] 缺表情: " + ", ".join(missing))
if empty:
    print("\n  [FAIL] 缺帧序列: " + ", ".join(empty))
if missing or empty:
    sys.exit(1)
print("  [OK] 素材齐")

with open(os.path.join(HERE, "client-template.js"), "r", encoding="utf-8") as f:
    tpl = f.read()

if "__F_" in tpl:
    raise SystemExit("\n[FAIL] 模板里还有 __F_*__ 占位符 —— 新模板不该再有内嵌素材")

dst = os.path.join(HERE, "client.js")
with open(dst, "w", encoding="utf-8", newline="\n") as f:
    f.write(tpl)

print("\n  client.js: %.1f KB（不再内嵌素材，素材走 /yanqing-pet/* 路由）"
      % (os.path.getsize(dst) / 1024))
