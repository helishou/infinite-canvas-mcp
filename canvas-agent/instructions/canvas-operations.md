# 画布操作与生成

- 主页没有打开的画布时，不要假定存在当前画布。创建或选择目标后使用工具真实返回的画布 ID 调用 `site_navigate` 打开 `/canvas/:id`，回读当前画布再继续节点和生成操作；返回不确定时先查对象与任务状态，避免重复创建或重复付费提交。
- 用户要求操作画布时，默认目标就是网页当前已经打开的画布。已知目标 ID 时直接定向读取或操作：节点基本信息用 `canvas_get_state(nodeIds,projection:summary)`，活动媒体用 projection:media，保存配置用 projection:generation；不需要完整 metadata 时不请求 full。未知 ID 才读取目录，需要当前项目/选区用 `canvas_inspect(view:context)`。读取成功后直接执行，不重复列画布或跳转页面。
- H3 保存正文用 `h3_get_clip(fields)`，保存参数用 include:runtime，同节点多个 Clip 使用 segmentIds 一次读取。正式 Shot、对白及连续性修改走制作源稿，不覆写派生 Prompt；画布配置修改使用 h3_update_clips 批量提交。H3 生成按同范围 h3_preview_run 的有效 planHash 提交，不重复同义预检；媒体任务用 canvas_wait_tasks 按原 taskIds 等待，编译状态按原 operationId 查询 production_get_compilation。当前工具 schema 未提供新参数时使用其支持的定向入口。
- `canvas_wait_tasks` 已返回最后观察到的任务状态和进度，直接使用回执；超时后按 `pendingTaskIds` 继续等待，确需新的进展或恢复时再查状态，不在每次等待后立即重复调用 `canvas_task_status`。
- 只有用户明确要求查看、选择或切换其他画布，或者当前位于画布主页、`canvas_get_state` 明确提示当前没有已连接画布时，才使用 `canvas_list_projects` 和 `site_navigate`。`site_navigate` 可跳转 `/`、`/canvas`、`/canvas/:id`、`/drama`、`/image`、`/video`、`/prompts`、`/assets`、`/config`。
- 修改当前画布时根据任务使用已配置的 infinite-canvas MCP 工具；复杂批量改动使用 `canvas_apply_ops`。
- MCP 只创建智能生成节点和智能插件节点；普通文本、图片、视频、音频节点没有对应创建工具。不要通过 `canvas_apply_ops` 的 `add_node` 绕过此边界。
- 生图与视频工作台分别使用 `workbench_image_*`、`workbench_video_*` 工具；提示词和素材分别使用 `prompts_search`、`assets_*` 工具。
- 用户要求生成图片、视频、音频或文本时，默认调用对应的 `canvas_generate_image`、`canvas_generate_video`、`canvas_generate_audio`、`canvas_generate_text`，通过当前画布的生成节点完成任务。
- 只有用户明确要求使用"Codex 内置生图""ImageGen 技能"或意思明确相同的能力时，才使用 Codex 自带的 `imagegen`；不要因为用户只说"生成图片"就自行改用内置生图。内置生图完成后，其结果会由 Canvas Agent 自动展示到对话并插入当前画布，无需再创建空节点或重复生成。
- 只有用户明确说要在生图/视频工作台生成时，才使用 `workbench_image_*`、`workbench_video_*`。生成任务提交后应说明已经在画布或工作台开始生成，不要在实际没有结果时声称"已生成"。
- 需要生成内容时直接调用对应生成工具，不要绑定特定业务场景，不要模拟鼠标点击，不要要求用户手动复制 JSON。