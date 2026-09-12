import { z } from "zod";

/**
 * 画布生成的跨进程协议。
 *
 * 前端按钮、MCP 和插件都只构造这条命令；执行器、任务持久化和画布回写
 * 由 Backend 统一处理。不要在调用方新增 provider/model 分支。
 */
export const canvasGenerationCommandSchema = z.object({
    mode: z.enum(["text", "image", "video", "audio"]),
    operation: z.enum(["generate", "h3-run"]).optional(),
    projectId: z.string().optional(),
    nodeId: z.string().optional(),
    nodeIds: z.array(z.string()).optional(),
    segmentId: z.string().optional(),
    segmentIndex: z.number().optional(),
    runFromCurrent: z.boolean().optional(),
    skipCompleted: z.boolean().optional(),
    model: z.string().optional(),
    prompt: z.string().optional(),
    references: z.array(z.record(z.string(), z.unknown())).optional(),
    size: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    quality: z.string().optional(),
    count: z.number().optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    input: z.record(z.string(), z.unknown()).optional(),
    preset: z.string().optional(),
    workflow: z.string().optional(),
    comfyUrl: z.string().optional(),
    resultPolicy: z.enum(["replace-active", "append"]).optional(),
    clientTaskId: z.string().optional(),
    idempotencyKey: z.string().optional(),
}).passthrough();

export type CanvasGenerationMode = z.infer<typeof canvasGenerationCommandSchema>["mode"];

export type CanvasGenerationCommand = z.infer<typeof canvasGenerationCommandSchema>;

export type CanvasGenerationTaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type CanvasGenerationTask = {
    id: string;
    kind: string;
    status: CanvasGenerationTaskStatus;
    progress: number;
    input: Record<string, unknown>;
    params: Record<string, unknown>;
    result?: Record<string, unknown> | null;
    preview?: Record<string, unknown> | null;
    error?: string | null;
    createdAt: string;
    updatedAt: string;
    parentTaskId?: string;
    projectId?: string;
    nodeId?: string;
    segmentId?: string;
    executor?: string;
    model?: string;
    outputs?: Array<Record<string, unknown>>;
};

export type CanvasGenerationStartResult = {
    taskId: string;
    task?: CanvasGenerationTask;
    executor: string;
};
