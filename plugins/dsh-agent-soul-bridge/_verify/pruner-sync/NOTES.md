# pruner-sync —— 桥侧薄适配的证据（2026-11-11）

跑法：

    cd D:\AI\dsh-tools\dsh-agent-soul-bridge
    node --import "file:///D:/AI/dsh-tools/dsh-yanqing-pruner/test/register.mjs" --test _verify/pruner-sync/adapter.test.mjs
    # → # tests 8 / # pass 8 / # fail 0

8 条覆盖：默认开关（桩态不变）、真 pruner 全链 + **v4 真判官认这条回执**、
`framesAffected=0` 仍合法、`no-pruner` 时零写入且不自己拼 surface 改写、
三条 stage 分明、applyDrops 失败原样带 code、`bytesAffected` 不给就不出现、桩文案同构。

完整判据、改动行号、帧级实据、上生产的四步：
`D:\AI\dsh-tools\dsh-yanqing-pruner\_verify\sync-apply-drops\FINDINGS.md`

