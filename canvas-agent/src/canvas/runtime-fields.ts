/** H3 字段归属的公共定义：前端过滤编辑命令，后台强制保护已存在实体的运行状态。 */
export const H3_RUNTIME_NODE_FIELDS = [
    "status", "runProgress", "runtimeTaskId", "runtimeRunId", "runRequestId", "runRequestConsumedId",
    "cancelRequested", "errorDetails", "content", "storageKey",
] as const;
export const H3_RUNTIME_SEGMENT_FIELDS = [
    "status", "progress", "runtimeTaskId", "result", "resultStorageKey", "results", "errorDetails",
    "firstPassReady", "firstPassResult", "firstPassStorageKey", "firstPassFingerprint", "cacheFingerprint",
] as const;
export const H3_LOCAL_VIEW_FIELDS = [
    "playhead", "selectedSegmentId", "h3PlaybackAll", "h3PlayRequest", "h3Scrubbing",
    "timelineScrollLeft", "minimaxOutputFilter", "minimaxPreviewH", "minimaxPreviewW",
    "minimaxPromptW", "minimaxTimelineH", "minimaxRefLaneH", "nanFengExpandedSections",
    "h3SigmaPresetName", "promptEnhancing", "promptEnhanceError",
] as const;

/** 普通生成节点在任务绑定期间由 Backend 独占的瞬态字段。媒体正文与结果槽仍允许细粒度用户操作。 */
export const CANVAS_ACTIVE_TASK_NODE_FIELDS = [
    "status", "runProgress", "runtimeTaskId", "errorDetails", "generationTaskId",
] as const;
