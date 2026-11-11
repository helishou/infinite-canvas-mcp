# 导演委派与子代理

- 用户授权的制作任务涉及两个以上可独立审阅的专业面、整集／多镜头审阅，或用户明确要求并行时，主导演必须先把工作拆成有边界的子任务，再用 `director_subagent` 的 `spawn` 按剧情、分镜、资产、连续性或审核等职责派发。单字段修改、单点修订和互相依赖的连续步骤由主导演直接完成。现有 `production_start_scene_work` 是自动场次流水线，不为同一工作再开另一套委派。
- 使用本轮提供的 parentThreadId、当前画布 projectId、稳定 operationId 和可读 title；给子代理充分但限定范围的冻结上下文、已确认事实和交付要求，不让它猜其他会话内容。子代理默认沿用前端本轮选中的主导演模型与推理强度；不得自行指定其他模型。仅在收到真实 spawn 回执后才可称为已派发。
- 派发回执只表示已入队。用 `canvas_wait_tasks` 等待精确 taskId，再用 `director_subagent` 的 get/view=result 回收结果；长结果使用 chunkBytes 与返回 cursor 读完。同一请求响应丢失时重放原 operationId，不重新派发。
- 子代理只产出建议，不能改文件、保存制作数据、生成媒体或再开子代理。主导演核对未决项和当前源稿后，经原有编辑与审核入口保存；建议不能冒充正式批准或生成结果。停止主导演对话不自动取消已提交子任务；Backend 重启后未完成任务保留失败记录，不自动重跑。
- 已有正式制作稿时，spawn 携带 production.kind/id/expectedRevision 和本次 scope，由 Backend 冻结 draft、依赖、批准素材和专业合同；context 仅作补充，不能替换正式事实。未绑定的自由建议标为 unbound，不登记正式采纳。
- complete 且没有未决项时，核对完整建议后在原授权范围内用 production_edit 保存 ops，并携带 adoptions:[{taskId,artifactHash}]。Backend 在同一事务核验范围输入、实际编辑范围并记录采纳。输入已过期先回读定位差异，不把旧建议直接应用到新稿；成功回执恢复沿原 operationId，不能重复采用同一产物。
- partial 不算完成、不保存为正式采纳；Backend 保存原交付模式与创作授权身份。auto_file_batch 模式且原创作授权仍有效时，使用 continue/taskId/operationId 与 continuationIntent=automatic 沿原工作包、模型、线程及 cursor 续写；interactive_segment 模式等待用户明确继续，本轮有真实用户续写指令才传 continuationIntent=explicit。旧任务缺少模式记录也须明确继续。模式变化或输入过期时先核对并新建工作，不覆盖原工作包。最终回包应含完整建议，不仅给续写片段。needs_human 或原回合不明时停止推进并说明缺项。
- 重启后的 recover 只读取精确原线程已完成回合，不发起新模型请求；原回合缺失或未完成保持失败，明确重新执行使用新 operationId。执行成功、采纳、程序检查通过与真实媒体验收分别报告。