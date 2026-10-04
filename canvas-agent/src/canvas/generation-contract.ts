import { z } from "zod";

export type H3ExecutionPreview = {
    ready: boolean; revision: number; planHash: string;
    clips: Array<{ nodeId: string; segmentId: string; savedRuntime: Record<string, unknown>; effectiveRuntime: Record<string, unknown>; parameterSources: Record<string, string>; policy: string;
        expectedDimensions: { firstPass: { width: number; height: number } | null; final: { width: number; height: number } | null }; promptHash: string; referenceMap: Array<Record<string, unknown>> }>;
    diagnostics: Array<{ code: string; nodeId: string; segmentId: string; message: string }>;
};

export const h3ExecutionModeSchema = z.enum(["auto", "local", "runninghub"]);
export const runningHubFieldSchema = z.object({
  id: z.string().optional(), nodeId: z.string().min(1), fieldName: z.string().min(1),
  fieldValue: z.unknown().optional(), fieldType: z.string().optional(), label: z.string().optional(),
  enabled: z.boolean().optional(), required: z.boolean().optional(),
  source: z.enum(["constant", "prompt", "image", "video", "audio", "param"]).optional(),
  paramKey: z.string().optional(), index: z.number().int().positive().optional(),
});
export type RunningHubField = z.infer<typeof runningHubFieldSchema>;
export const runningHubConfigPatchSchema = z.object({
  baseUrl: z.string().optional(), apiKey: z.string().optional(), walletApiKey: z.string().optional(),
  mode: z.enum(["workflow", "app"]).optional(), workflowId: z.string().optional(), appId: z.string().optional(),
  fields: z.array(runningHubFieldSchema).optional(), workflowJson: z.unknown().optional(),
  useWallet: z.boolean().optional(), instanceType: z.enum(["default", "plus", "ultra"]).optional(),
  concurrency: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});
export type RunningHubConfig = z.infer<typeof runningHubConfigPatchSchema> & {
  baseUrl: string; apiKey: string; mode: "workflow" | "app"; concurrency: number;
  workflowId: string; appId: string; fields: RunningHubField[]; useWallet: boolean; instanceType: "default" | "plus" | "ultra";
};
/** RunningHub API 格式工作流：节点 ID → 节点定义，与本地 ComfyUI 工作流 JSON 同形。 */
export const runningHubWorkflowGraphSchema = z.record(z.string(), z.unknown());
export type RunningHubWorkflowGraph = z.infer<typeof runningHubWorkflowGraphSchema>;
export const runningHubWorkflowProfileSchema = z.object({
  id: z.string().min(1), name: z.string().min(1).max(120), workflowId: z.string().min(1),
  instanceType: z.enum(["default", "plus", "ultra"]).optional(), fields: z.array(runningHubFieldSchema),
  /** 读取节点图时的原始图快照；只读展示，运行以平台当前工作流为准。 */
  workflowJson: runningHubWorkflowGraphSchema.optional(),
  createdAt: z.string().optional(), updatedAt: z.string().optional(),
});
export type RunningHubWorkflowProfile = z.infer<typeof runningHubWorkflowProfileSchema>;

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
    endSegmentId: z.string().optional(),
    segmentIndex: z.number().optional(),
    runFromCurrent: z.boolean().optional(),
    skipCompleted: z.boolean().optional(),
    forceRegenerate: z.boolean().optional(),
    expectedPlanHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    model: z.string().optional(),
    prompt: z.string().optional(),
    references: z.array(z.record(z.string(), z.unknown())).optional(),
    /** Current loop round's image input; fixed reference images remain in references. */
    loopInputImages: z.array(z.record(z.string(), z.unknown())).optional(),
    /** 标记画布蒙版局部编辑；工作流执行器需确保第二张输入图接入活动图像分支。 */
    maskEdit: z.boolean().optional(),
    videoReferences: z.array(z.record(z.string(), z.unknown())).optional(),
    audioReferences: z.array(z.record(z.string(), z.unknown())).optional(),
    size: z.string().optional(),
    seconds: z.string().optional(),
    resolution: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    quality: z.string().optional(),
    count: z.number().optional(),
    /** 将图片结果按顺序回写到目标节点的现有图片槽；单槽重试只传该槽。 */
    imageIds: z.array(z.string().min(1)).optional(),
    /** 智能画布循环：任务写入 Backend 准备阶段分配的有序输出槽。 */
    loopOutput: z.object({
      loopNodeId: z.string().min(1),
      roundIndex: z.number().int().min(1),
      slotIndex: z.number().int().min(0).max(99),
      slotNodeId: z.string().min(1).optional(),
      outputGroupId: z.string().min(1).optional(),
      /** 本次运行的真实轮数；旧客户端省略时 Backend 保留历史槽位解析规则。 */
      totalRounds: z.number().int().min(1).max(100).optional(),
    }).optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    input: z.record(z.string(), z.unknown()).optional(),
    preset: z.string().optional(),
    comfyUrl: z.string().optional(),
    resultPolicy: z.enum(["replace-active", "append"]).optional(),
    clientTaskId: z.string().optional(),
    idempotencyKey: z.string().optional(),
  })
  .passthrough();

export const canvasLoopPrepareSchema = z.object({
  projectId: z.string().min(1),
  loopNodeId: z.string().min(1),
  runId: z.string().min(1),
  mode: z.enum(["text", "image", "video", "audio"]),
  totalRounds: z.number().int().min(1).max(100),
  roundInputNodeIds: z.array(z.array(z.string().min(1)).max(100)).min(1).max(100),
});

export type CanvasLoopPrepare = z.infer<typeof canvasLoopPrepareSchema>;

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
