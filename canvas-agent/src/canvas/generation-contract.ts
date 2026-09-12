/**
 * 画布生成的跨进程协议。
 *
 * 前端按钮、MCP 和插件都只构造这条命令；执行器、任务持久化和画布回写
 * 由 Backend 统一处理。不要在调用方新增 provider/model 分支。
 */
export type CanvasGenerationMode = "text" | "image" | "video" | "audio";

export type CanvasGenerationCommand = {
    mode: CanvasGenerationMode;
    /** 普通生成或 H3 节点编排；缺省为普通生成。 */
    operation?: "generate" | "h3-run";
    projectId?: string;
    nodeId?: string;
    nodeIds?: string[];
    segmentId?: string;
    segmentIndex?: number;
    runFromCurrent?: boolean;
    skipCompleted?: boolean;
    model?: string;
    prompt?: string;
    references?: Array<Record<string, unknown>>;
    size?: string;
    width?: number;
    height?: number;
    quality?: string;
    count?: number;
    params?: Record<string, unknown>;
    /** ComfyUI/H3 等本地执行器的标准化输入。 */
    input?: Record<string, unknown>;
    preset?: string;
    workflow?: string;
    comfyUrl?: string;
    provider?: { baseUrl?: string; apiKey?: string };
    resultPolicy?: "replace-active" | "append";
    clientTaskId?: string;
    idempotencyKey?: string;
    writeBackCanvas?: boolean;
};

export type CanvasGenerationStartResult = {
    taskId: string;
    task?: Record<string, unknown>;
    executor: string;
};
