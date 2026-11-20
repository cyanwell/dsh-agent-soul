# dsh-agent-soul-bridge 发布前审计

审计时间：2026-11-19
范围：package.json、cordis.patch.yml、index.js、client.js、README.md、_verify/selftest.mjs、_verify/e2e-harness.mjs、pruner/context adapter 测试、仓库状态。
约束：本轮未 push、未联网、未安装、未重启；仅读检查，新增本报告。

## 结论

**BLOCK：当前不具备安全推送条件。** 语法通过，但包契约、运行配置、README、测试基线互相矛盾；生产 pruner 与管理端点的副作用也没有完成真机验收。

## PASS

- Host 半：package.json 的 main/根 exports 指向 index.js；index.js 导出 name、inject=[webServer]，且 default 重复携带 inject，符合 Cordis loader 的实际读取方式。
- Cordis patch：包名/id/name 一致，patch 引用 ./cordis.patch.yml；agentSoulAutoStart=false，默认不会由 keeper 自动拉起 AgentSoul。
- WS/错误处理：语法检查通过；失败回执带 stage/code，错误文本做单行、限长和凭据键值脱敏；水位取不到时返回 null，不以 surfaceTokens 冒充。
- 管理端点注册与销毁路径有 ctx.inject([webServer])、effect、apply receipt；selftest/e2e-harness 明确不调用 stop/restart，测试设计避免主动杀 AgentSoul。
- pruner 适配层坚持显式 session/seq/opId、目标校验、失败不伪造 framesAffected，并有离线/线上/独立复核夹具。

## BLOCKER

1. **客户端半包契约不成立。** client.js 实际包含完整浏览器 UI，并导出 ./client；但 package.json 的 dsh.client.inject 是空数组。按 dsh-plugin-packaging，客户端拾取需同时满足 exports[./client] 与有效 dsh.client 注入声明；当前 UI 不应宣称可达。若产品定位纯 Host，应删除/排除 client.js 与 client export；若要 UI，应补正确的 client inject（通常至少 slots）并做启动后 __DSH_BOOT__.entries/DOM 尺寸验收。
2. **生产 patch 已改变能力语义，测试仍按旧默认。** cordis.patch.yml:38-48 宣布 10 个 caps、stubCaps=[huanqi]、prunerLive=true；但 index.js 默认值与 README/测试仍把 pruner 当桩、默认关闭。实际运行配置以 patch 覆盖默认值，可能让 v4 派发 pruner；真实 DSH 上“能拿到目标 pruner 实例”仍未验，失败会 no-pruner。这是生产行为阻断，不是文案问题。
3. **当前测试不是绿灯。** Node 22.22.2 四个 --check 全通过；但 pruner-stub + wire-refusal 为 16 pass / 2 fail：stubCaps 断言失败，线上桩测试收到 stage:no-agents 而非预期桩文案。pruner-sync/adapter 与 independent bridge 测试均因外部 @deepseek-ai/dsh-compaction-tool-result-pruner 缺失失败。不能以 README 的历史 PASS 数字发布。
4. **管理端点权限/副作用需发布前定案。** /agent-soul/start|stop|restart 是无额外鉴权的 GET；stop 使用 taskkill /IM AgentSoul.exe /F，可能杀掉同镜像的其他进程。当前未见用户/会话授权、CSRF 防护或 PID 精确绑定。至少应限制为受信本地管理面并记录接受的威胁模型，否则阻断。
5. **包清单与 README 不闭合。** README 要求运行 probe.mjs，但 package.json.files 未包含 probe.mjs；files 还重复列出 index.js。发布包中按 README 操作可能直接缺文件。
6. **版本公告不一致。** package.json.version=0.1.0，源码 VERSION=0.1.3-bridge-v2，README 仍混有旧 caps/pruner 默认口径；没有明确 release/changelog 记录本次 10-cap、patch 开关和管理端点权限变化。

## NEXT

- 先决定产品形态：纯 Host 或 Host+Web UI；按决定修 package contract，并做重启后客户端入口图与 DOM 尺寸核验。
- 统一 cordis.patch.yml、DEFAULTS、README、测试断言：若 pruner 尚未真机验收，恢复 stubCaps 含 pruner 且 prunerLive=false；若保留开启，必须用非生产真实会话验 ok:true、framesAffected、pointer、重放零 append，并确认目标实例解析。
- 修复/隔离当前 2 个 pruner 测试失败，补齐缺失依赖来源或把依赖声明为可复现的测试前置；新增 context-surgeon/purgeMany 独立测试，目前未发现对应测试文件。
- 明确管理端点权限与 taskkill 目标策略；至少验证跨来源不可触发、同源面板行为、异常/并发启停和误杀影响。
- 加 package scripts（至少 syntax/unit/packaging smoke）并让命令不依赖绝对本机路径；README 改为与当前 patch 一致，补版本公告。
- 推送前必须：读取并提交 git diff/status，确认只含预期文件；当前 git 不在 PATH，仓库状态未核验。还需核对 commit 内容、README 与包内文件、远端 origin/目标分支和远端最新提交；本轮未联网，均未核验。
- 生产影响：当前 patch 可能实际开放 sessions/workspaces/agent/events/service/context 与 pruner，并提供可启停 AgentSoul 的管理面；错误配置会扩大跨进程调用面、让 pruner 失败或误杀进程。故最终判定 **BLOCK，不能安全推送**。

证据文件：package.json、cordis.patch.yml、index.js、client.js、README.md、_verify/selftest.mjs、_verify/e2e-harness.mjs、pruner-adapter.mjs、context-surgeon.mjs 及对应 _verify 测试。
