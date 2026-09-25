# 返修与问题记录

项目 ID：
项目名：
制作目录：

## 记录口径

- 每个可区分的问题单独建条目，使用稳定的镜头 ID、Clip `segmentId` 或资产 ID；同一问题的后续返修追加到原条目，不另建重复记录。
- 分开记录生成任务终态与质量验收结论。任务成功不等于 `PASS`；QC 使用 `PASS / FAIL / UNCLEAR`，生产状态使用 `accepted / needs-redo / waiting-user / blocked-upstream`。
- H3 每次 `canvas-h3-run` 父任务计一次尝试；对应 ComfyUI 子任务记录为该次尝试的执行证据，不重复计数。图像、文本或其他任务按实际提交的父任务计数。
- 保存旧 taskId/storageKey 和新 taskId/storageKey，不删除或覆盖旧结果。没有证据的根因写“待核对”，不得推测。

## 问题与返修链

### RW-YYYY-MM-DD-NN｜segmentId / shotId｜简短问题

- 首次发现时间：
- 当前状态：`open / needs-redo / waiting-user / resolved / abandoned`
- 对应项目 / 节点 ID：
- `sourceShotId` / `segmentId`：
- 问题现象与验收标准：
- 证据原因：
- 当前输入版本（分镜/锚图/提示词/参考绑定）：
- 尝试次数：
- 用户决定或授权边界：

| 尝试 | 修改内容与原因 | taskId（父 / 子） | 结果 storageKey | 任务终态 | QC | 证据/备注 |
|---:|---|---|---|---|---|---|
| 1 |  |  |  |  |  |  |

- 当前结论：
- 下一动作：
