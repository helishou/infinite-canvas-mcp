import { z } from "zod";

/**
 * 画布生成的跨进程协议。
 *
 * 前端按钮、MCP 和插件都只构造这条命令；执行器、任务持久化和画布回写
 * 由 Backend 统一处理。不要在调用方新增 provider/model 分支。
 */
export const canvasGenerationCommandSchema = z
  .object({
    mode: z.enum(["text", "image", "video", "audio"]),
    operation: z.enum(["generate", "h3-run"]).optional(),
    projectId: z.string().optional(),
    nodeId: z.string().optional(),
    /** 生成结果节点与参考配置节点分离时，指定本次生成的源节点。 */
    sourceNodeId: z.string().optional(),
    nodeIds: z.array(z.string()).optional(),
    segmentId: z.string().optional(),
    segmentIndex: z.number().optional(),
    runFromCurrent: z.boolean().optional(),
    skipCompleted: z.boolean().optional(),
    model: z.string().optional(),
    prompt: z.string().optional(),
    references: z.array(z.record(z.string(), z.unknown())).optional(),
    /** 标记画布蒙版局部编辑；工作流执行器需确保第二张输入图接入活动图像分支。 */
    maskEdit: z.boolean().optional(),
    videoReferences: z.array(z.record(z.string(), z.unknown())).optional(),
    size: z.string().optional(),
    seconds: z.string().optional(),
    resolution: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    quality: z.string().optional(),
    count: z.number().optional(),
    /** 将图片结果按顺序回写到目标节点的现有图片槽；单槽重试只传该槽。 */
    imageIds: z.array(z.string().min(1)).optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    input: z.record(z.string(), z.unknown()).optional(),
    preset: z.string().optional(),
    comfyUrl: z.string().optional(),
    resultPolicy: z.enum(["replace-active", "append"]).optional(),
    clientTaskId: z.string().optional(),
    idempotencyKey: z.string().optional(),
  })
  .passthrough();

export type CanvasGenerationMode = z.infer<
  typeof canvasGenerationCommandSchema
>["mode"];

export type CanvasGenerationCommand = z.infer<
  typeof canvasGenerationCommandSchema
>;

export type CanvasGenerationTaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

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
