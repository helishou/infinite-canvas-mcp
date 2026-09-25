---
name: canvas-h3-implementation
description: 修改或排查无限画布 H3 插件、Backend、MCP 与 ComfyUI 的工程调用链、UI、共享契约和服务加载。用于源码实现与运行故障；不用于短片剧情、资产、分镜或 Clip 内容制作。
---

# H3 工程实现

先按[根 AGENTS](../../../AGENTS.md)读取涉及目录的约定。本 Skill 提供定位和验证方法；跨端数据不变量归[画布契约](../../rules/canvas-contracts.md)，布局/视口要求归[交互约束](../../rules/canvas-ui.md)，不在这里另维护副本。

## 只加载当前问题所需参考

| 问题 | 参考 | 产出证据 |
|---|---|---|
| 改动不生效、产物、进程、重载 | [运行与验证](references/development-verification.md) | 确认修改被实际消费 |
| MCP schema、工具、Backend 路由 | [工具开发](references/mcp-tool-development.md) | HTTP MCP 的 schema 与调用行为一致 |
| H3 → ComfyUI 输入、结果、取消、恢复 | [执行链](references/comfyui-call-chain.md) | 任务、实际输入、媒体、活动绑定对应 |
| H3 布局、控件、状态、输出恢复 | [UI 排障](references/h3-ui-state.md) | 用户动作和目标区域行为正确 |
| 页面视觉、缩放与指针命中 | [页面验证](references/live-page-verification.md) | 独立测试页中的可观察结果 |
| 通用工作流导入、配置、模型路由 | [工作流](references/workflow-import.md) | 配置往返和实际执行路由正确 |

## 工作方法

1. 先定位故障所在层及其真实入口：UI 命令、Backend 父任务、子任务、Comfy promptId、归档、ops、页面订阅。只读取定位所需状态，不整图或整库反复 dump。
2. 写下可区分原因的最小验证，读取当前源码、schema 或日志后再修改。声明了字段/节点不等于输入已进入执行。
3. 在所属层修复，检查直接消费者；跨层改动同步契约，不让浏览器、MCP、Backend 各自补一套兼容。
4. 按根目录验证矩阵和实际加载路径验收；检查失败时区分新增回归、原有问题、环境缺失，不能只过滤掉非改动文件的报错。
5. 交付明确实际解决的行为、证据和仍需运行环境验证的部分；没有真实运行不声称已跑通。

## 范围边界

操作真实画布时使用既有画布 MCP/受支持命令，不直写数据库，不绕开画布提交 ComfyUI 再补造记录。修工程问题不自动获得付费生成、删除资产、重启无关服务或修改创作方案的授权。

任务属于制作内容时，转[生产 SOP](../canvas-video-production-sop/SKILL.md)的当前阶段，工程诊断结论不能替代视觉与剧情验收。
