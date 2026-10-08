import { directorSubagentSchema, directorSubagentDescription } from "../agent/delegation.js";
import { productionToolNames, productionToolSchemas, productionToolDescriptions } from "../drama/production-tools.js";
import { nodePatchSchema } from "./edit-validation.js";
export { validateNodeUpdate, validateH3Edit, validateH3Metadata } from "./edit-validation.js";
import { z } from "zod";
import { productionWorkspaceSchemas, productionWorkspaceDescriptions, productionWorkspaceToolNames } from "../drama/production-workspace-contract.js";
import { productionEditSchema, productionOperationSchema, productionPreflightSchema, productionContractQuerySchema, productionCompileSchema, productionApplyCompilationSchema, productionReadSchema, type ProductionOperation } from "../drama/production-contract.js";
import {
  collaborationDescriptions,
  collaborationSchemas,
  collaborationToolNames,
} from "./collaboration-contract.js";
export {
  textTargetSchema,
  textSuggestionInputSchema,
  type CanvasTextSuggestion,
} from "./collaboration-contract.js";

const recordSchema = z
  .record(z.unknown())
  .describe(
    "任意键值对 JSON 对象，例如 params/metadata/patch。键名因工具而异：canvas_update_node.patch 是节点字段子集。",
  );
const canvasProjectSchema = z.object({
  projectId: z
    .string()
    .optional()
    .describe(
      "画布 ID，不传则作用于当前 activeProject。若当前无活动画布且不传此参数，工具会报错。",
    ),
});
const positionSchema = z.object({
  x: z.number().describe("画布世界坐标 X，正数向右"),
  y: z.number().describe("画布世界坐标 Y，正数向下"),
});
const nodeTypeSchema = z
  .string()
  .min(1)
  .describe(
    "节点类型枚举，常用值：text（文本节点）、image（图片节点）、config（生成配置节点）、video（视频节点）、audio（音频节点）。新类型可由插件自定义。",
  );
const generationModeSchema = z
  .enum(["text", "image", "video", "audio"])
  .describe(
    "生成模式：text=大模型生成文本，image=文生图/图生图，video=文生视频/图生视频，audio=语音/音频生成。",
  );

/** Canvas Agent 对外提供的工具名称。 */
export const toolNames = [
  ...collaborationToolNames,
  "site_navigate",
  "canvas_list_projects",
  "canvas_inspect",
  "canvas_get_state",
  "canvas_get_selection",
  "canvas_export_snapshot",
  "canvas_apply_ops",
  "canvas_create_node",
  "canvas_create_attachment_nodes",
  "canvas_create_text_node",
  "canvas_create_text_nodes",
  "canvas_create_config_node",
  "canvas_create_generation_flow",
  "canvas_generate_text",
  "canvas_generate_image",
  "canvas_generate_image_batch",
  "canvas_generate_video",
  "canvas_generate_audio",
  "canvas_set_generation_references",
  "canvas_update_node",
  "canvas_move_nodes",
  "canvas_resize_node",
  "canvas_delete_nodes",
  "canvas_connect_nodes",
  "canvas_select_nodes",
  "canvas_image_input_manifest",
  "canvas_run_generation",
  "canvas_task_status",
  "canvas_wait_tasks",
  "canvas_h3_confirmation",
  "generation_get_status",
  "mcp_observability_report",
  "mcp_get_command_receipt",
  "models_list",
  "h3_get_node_materials",
  "comfyui_status",
  "comfyui_get_task",
  "comfyui_cancel_task",
  "workbench_image_get_config",
  "workbench_image_generate",
  "workbench_video_get_config",
  "workbench_video_generate",
  "prompts_search",
  "assets_list",
  "assets_get",
  "assets_add",
  "assets_upsert_batch",
  "drama_list_episodes",
  "drama_get_episode",
  "drama_create_episode",
  "drama_update_episode",
  "drama_delete_episode",
  "production_get_contract",
  "production_get_continuity",
  "production_check_continuity",
  ...productionWorkspaceToolNames,
  ...productionToolNames,
  "director_subagent",
  "production_compile",
  "production_get_compilation",
  "production_apply_compilation",
  "production_diagnose_bindings",
  "production_diagnose_clips",
] as const;
export type ToolName = (typeof toolNames)[number];

export const canvasOpSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("add_node"),
      nodeType: nodeTypeSchema.optional(),
      id: z.string().optional(),
      title: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      position: positionSchema.optional(),
      metadata: recordSchema.optional(),
    })
    .passthrough()
    .describe(
      "添加一个节点。可省略 id 由后端分配。例：{ type: 'add_node', nodeType: 'text', title: '沈昭宁小传', x: 200, y: 100 }",
    ),
  z
    .object({
      type: z.literal("update_node"),
      id: z.string().describe("目标节点 ID，必填"),
      patch: nodePatchSchema
        .optional()
        .describe("节点字段子集，如 { x: 300, y: 200, title: '新标题' }"),
      metadataDelete: z.array(z.string().min(1)).optional(),
      metadata: recordSchema
        .optional()
        .describe("按字段合并 metadata；节点基础字段放 patch，插件字段放 metadata"),
    })
    .strict(),
  z
    .object({
      type: z.literal("move_h3_segment"),
      nodeId: z.string().describe("目标 H3 节点 ID，必填"),
      segmentId: z.string().describe("要移动的 Clip 稳定 ID，必填"),
      beforeSegmentId: z.string().optional().describe("移动到此 Clip 前面；与 afterSegmentId 二选一"),
      afterSegmentId: z.string().optional().describe("移动到此 Clip 后面；与 beforeSegmentId 二选一"),
    })
    .passthrough()
    .describe("按稳定 ID 原子调整 H3 Clip 顺序；省略 beforeSegmentId/afterSegmentId 时移动到末尾。"),
  z
    .object({
      type: z.literal("delete_node"),
      id: z.string().optional().describe("单个节点 ID；与 ids 二选一"),
      ids: z
        .array(z.string())
        .optional()
        .describe("多个节点 ID 数组，与 id 二选一"),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("delete_connections"),
      id: z.string().optional(),
      ids: z.array(z.string()).optional(),
      all: z
        .boolean()
        .optional()
        .describe("是否删光画布全部连线；true 时省略 ids"),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("connect_nodes"),
      id: z.string().optional(),
      fromNodeId: z.string().describe("源节点 ID"),
      toNodeId: z.string().describe("目标节点 ID"),
      role: z
        .string()
        .optional()
        .describe(
          "连线角色，常见：reference（参考）/ prompt（提示词）/ control（控制）",
        ),
      order: z.number().optional().describe("当同一对节点多条连线时的顺序"),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("select_nodes"),
      ids: z
        .array(z.string())
        .describe("要选中的节点 ID 数组，传空数组会清空选区"),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("run_generation"),
      nodeId: z.string().describe("要触发生成的配置/媒体节点 ID"),
      mode: generationModeSchema.optional(),
      prompt: z
        .string()
        .optional()
        .describe("可选覆盖提示词；不传则用节点当前的 prompt 输入"),
      referenceNodeIds: z
        .array(z.string())
        .optional()
        .describe("参考节点 ID 列表；会替换节点当前的媒体参考连线"),
      params: recordSchema.optional(),
      idempotencyKey: z.string().optional(),
      resultPolicy: z
        .enum(["replace-active", "append"])
        .optional()
        .describe("replace-active=替换当前激活结果；append=追加新结果"),
    })
    .passthrough(),
]);

const textNodeSchema = z.object({
  text: z.string().describe("节点正文，必填"),
  title: z.string().optional().describe("节点标题，留空则默认 '文本节点'"),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
});

const generationOptionsSchema = z.object({
  model: z
    .string()
    .optional()
    .describe("模型 ID，例如 krea2/qwen-image/h3；不传用工作台当前默认"),
  size: z
    .string()
    .optional()
    .describe(
      "图像/视频尺寸或比例，例如 '1024x1024'、'16:9'；具体可选值先调 workbench_*_get_config",
    ),
  quality: z.string().optional().describe("质量档位，例如 'standard'、'high'"),
  count: z.number().optional().describe("生成张数，1-4"),
  seconds: z.string().optional().describe("视频时长，例如 '6'、'10'"),
  vquality: z.string().optional().describe("视频清晰度，例如 '720p'、'1080p'"),
  generateAudio: z
    .string()
    .optional()
    .describe("视频是否同时生成音轨，'true' / 'false' 字符串"),
  watermark: z
    .string()
    .optional()
    .describe("是否带水印，'true' / 'false' 字符串"),
  audioVoice: z
    .string()
    .optional()
    .describe("TTS 声线 ID，例如 zh-CN-XiaoxiaoNeural"),
  audioFormat: z.string().optional().describe("音频格式，例如 'mp3'、'wav'"),
  audioSpeed: z.string().optional().describe("语速倍率，'1.0' 为正常"),
  audioInstructions: z
    .string()
    .optional()
    .describe("TTS 情感/口吻提示，例如 '平静叙述'"),
  params: recordSchema.optional(),
  idempotencyKey: z.string().optional(),
  resultPolicy: z.enum(["replace-active", "append"]).optional(),
});

const generationFlowSchema = z.object({
  prompt: z.string().describe("生成提示词，必填"),
  title: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  referenceNodeIds: z
    .array(z.string())
    .optional()
    .describe("参考节点 ID 数组，按此顺序连线；空数组=无参考"),
});

const imageBatchItemSchema = generationFlowSchema
  .extend({
    key: z
      .string()
      .min(1)
      .describe("调用方业务键；用于把返回的 taskId/nodeId 对回原始条目"),
  })
  .merge(generationOptionsSchema);

const assetUpsertItemSchema = z.object({
  id: z.string().optional().describe("稳定资产 ID；传入后重复调用执行更新而不是新增"),
  kind: z.string().min(1).describe("资产类型，例如 character、scene、image、text"),
  title: z.string().min(1).describe("资产标题"),
  coverUrl: z.string().optional(),
  tags: z.array(z.string()).optional(),
  folderId: z.string().nullable().optional(),
  dramaId: z.string().nullable().optional(),
  data: recordSchema.describe("资产业务数据；可保存 images、outfit、colorCard 等结构化字段"),
  note: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  metadata: recordSchema.optional(),
});

export const toolInputSchemas = {
  ...collaborationSchemas,
  site_navigate: z.object({
    path: z.string().optional().describe("通用页面路径。进入制作对象时请优先使用 production 结构化目标。"),
    production: z.object({
      kind: z.enum(["canvas", "episode", "scene"]).describe("制作对象类型：独立画布项目、剧目分集或剧目制作场次。"),
      id: z.string().min(1).describe("Backend 返回的真实制作对象 ID。"),
      workId: z.string().min(1).describe("当前正式 currentWork 的稳定 workId，用于防止打开过期或错误阶段。"),
      runId: z.string().min(1).optional().describe("当前目标的生产 runId；用于并行运行时精确呈现所选批次。"),
    }).optional().describe("进入 Acheng 制作工作台/画布的结构化目标；网页会读取 Backend 正式展示状态并生成路由。"),
  }),
  canvas_list_projects: canvasProjectSchema.extend({
    keyword: z.string().optional().describe("按标题模糊搜索"),
    episodeId: z
      .string()
      .optional()
      .describe(
        "可选分集 ID 过滤；不传 = 全部。画布通过分集绑定，不再直接传剧目 ID",
      ),
    page: z.number().optional().describe("页码，从 1 开始；默认 1"),
    pageSize: z.number().optional().describe("每页数量，默认 20，最大 100"),
  }),
  canvas_inspect: canvasProjectSchema.extend({
    nodeLimit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe("最多返回多少个节点摘要，默认 100，最大 500"),
  }),
  canvas_get_state: canvasProjectSchema.passthrough().extend({
    view: z.enum(["index", "graph"]).optional().describe("默认 index：全部节点的 ID、类型、标题及生成模式；graph：节点布局摘要和连线"),
    ifRevision: z.number().int().min(0).optional().describe("只用于指定 projectId 的默认完整节点目录；revision 相同则返回 unchanged"),
    nodeIds: z
      .array(z.string())
      .optional()
      .describe(
        "只取这些节点的完整数据及其相关连线；超出输出上限时返回节点摘要并标记 metadataTruncated。传 nodeIds 时忽略分页参数",
      ),
    nodeOffset: z.number().int().min(0).optional().describe("目录/图关系分页起点；返回 nextNodeOffset 时用该值继续读取"),
    nodeLimit: z.number().int().min(1).optional().describe("可选的本次节点数上限；省略则尽量返回全部，超出 MCP 输出上限时自动分页"),
  }),
  canvas_get_selection: canvasProjectSchema.passthrough(),
  canvas_export_snapshot: canvasProjectSchema.passthrough(),
  canvas_apply_ops: canvasProjectSchema.extend({
    projectId: z.string().min(1).describe("必填目标画布 ID"),
    operationId: z.string().min(1).describe("本次编辑的稳定 UUID；响应未知时用同一 ID 和完全相同请求恢复回执"),
    expectedRevision: z.number().int().min(0).describe("读取编辑基线的项目 revision；冲突时整批拒绝，不自动 rebase"),
    ops: z
      .array(canvasOpSchema)
      .min(1)
      .describe(
        "操作数组，至少 1 个；type 决定其余字段。例：[{ type: 'add_node', nodeType: 'text', title: '剧名', x: 100, y: 100 }, { type: 'connect_nodes', fromNodeId: 'n1', toNodeId: 'n2' }]",
      ),
  }),
  canvas_create_node: canvasProjectSchema.extend({
    nodeType: nodeTypeSchema,
    title: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    metadata: recordSchema.optional(),
  }),
  canvas_create_attachment_nodes: canvasProjectSchema.extend({
    attachmentIds: z
      .array(z.string())
      .min(1)
      .describe("本轮对话附件 ID 数组，从用户上传消息中获取，至少 1 个"),
    x: z.number().optional(),
    y: z.number().optional(),
    gap: z.number().optional().describe("节点间距，默认 32"),
    direction: z
      .enum(["row", "column"])
      .optional()
      .describe("排列方向，row=水平、column=垂直；默认 column"),
  }),
  canvas_create_text_node: canvasProjectSchema.extend({
    text: z.string().optional().describe("节点正文；不传则创建空文本节点"),
    x: z.number().optional(),
    y: z.number().optional(),
    title: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
  }),
  canvas_create_text_nodes: canvasProjectSchema.extend({
    items: z
      .array(textNodeSchema)
      .min(1)
      .describe(
        "要批量创建的文本节点数组，每项含 text 必填，可选 title/x/y/width/height",
      ),
    x: z.number().optional().describe("起始坐标 X；items 自带 x 时优先 items"),
    y: z.number().optional().describe("起始坐标 Y"),
    gap: z.number().optional().describe("节点间距，默认 24"),
    direction: z
      .enum(["row", "column"])
      .optional()
      .describe("排列方向，默认 column"),
  }),
  canvas_create_config_node: canvasProjectSchema
    .extend({
      id: z
        .string()
        .optional()
        .describe("可选的智能节点 ID；批量流程用它保证创建与运行指向同一个节点"),
      prompt: z
        .string()
        .optional()
        .describe("生成提示词；直接写入智能节点元数据，不创建额外文字节点"),
      mode: generationModeSchema.optional(),
      title: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      autoRun: z
        .boolean()
        .optional()
        .describe("true=创建后立即触发一次生成；false=仅创建占位"),
    })
    .merge(generationOptionsSchema),
  canvas_create_generation_flow: canvasProjectSchema
    .extend({
      ...generationFlowSchema.shape,
      prompt: z
        .string()
        .optional()
        .describe("生成提示词；image 模式仅当前工作流要求提示词时必填"),
    })
    .extend({
      mode: generationModeSchema.optional(),
      autoRun: z.boolean().optional(),
    })
    .merge(generationOptionsSchema),
  canvas_generate_text: canvasProjectSchema
    .extend(generationFlowSchema.shape)
    .merge(generationOptionsSchema),
  canvas_generate_image: canvasProjectSchema
    .extend({
      ...generationFlowSchema.shape,
      prompt: z
        .string()
        .optional()
        .describe("生图提示词；仅当前工作流要求提示词时必填"),
    })
    .merge(generationOptionsSchema),
  canvas_generate_image_batch: canvasProjectSchema.extend({
    defaults: z
      .record(z.unknown())
      .optional()
      .describe("批量公共生成参数；条目字段优先"),
    items: z
      .array(imageBatchItemSchema)
      .min(1)
      .max(32)
      .describe("批量生图条目；同一画布内由 Backend 串行提交以避免 revision 冲突"),
    waitForCompletion: z
      .boolean()
      .optional()
      .describe("true=由 MCP 内部轮询到全部任务终态后返回；默认 false"),
    timeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(1800000)
      .optional()
      .describe("waitForCompletion=true 时的最长等待时间，默认 900000ms"),
    pollMs: z
      .number()
      .int()
      .min(250)
      .max(10000)
      .optional()
      .describe("waitForCompletion=true 时的轮询间隔，默认 2000ms"),
  }),
  canvas_generate_video: canvasProjectSchema
    .extend(generationFlowSchema.shape)
    .merge(generationOptionsSchema),
  canvas_generate_audio: canvasProjectSchema
    .extend(generationFlowSchema.shape)
    .merge(generationOptionsSchema),
  canvas_set_generation_references: canvasProjectSchema.extend({
    nodeId: z.string().describe("目标生成节点 ID，必填"),
    referenceNodeIds: z
      .array(z.string())
      .describe(
        "新的参考节点 ID 数组；会先清空节点现有的图片/视频/音频参考连线，再按本数组顺序重新连；传空数组可清空全部参考",
      ),
  }),
  canvas_update_node: canvasProjectSchema.extend({
    id: z.string().describe("目标节点 ID，必填"),
    patch: nodePatchSchema
      .optional()
      .describe("节点字段子集，如 { x: 300, y: 200, title: '新标题' }"),
    metadata: recordSchema
      .optional()
      .describe("按字段合并 metadata；节点基础字段放 patch，插件字段放 metadata"),
  }).strict(),
  canvas_move_nodes: canvasProjectSchema.extend({
    items: z
      .array(
        z.object({
          id: z.string().describe("节点 ID，必填"),
          x: z.number().optional().describe("绝对坐标 X；与 dx 二选一"),
          y: z.number().optional().describe("绝对坐标 Y；与 dy 二选一"),
          dx: z.number().optional().describe("相对偏移 X；与 x 二选一"),
          dy: z.number().optional().describe("相对偏移 Y；与 y 二选一"),
        }),
      )
      .min(1)
      .describe(
        "移动项数组；每项可单独选 绝对坐标(x/y) 或 相对偏移(dx/dy)，混用时以绝对坐标优先",
      ),
  }),
  canvas_resize_node: canvasProjectSchema.extend({
    id: z.string().describe("节点 ID"),
    width: z.number().describe("新宽度"),
    height: z.number().describe("新高度"),
    freeResize: z.boolean().optional().describe("true=不受最小尺寸约束"),
  }),
  canvas_delete_nodes: canvasProjectSchema.extend({
    ids: z
      .array(z.string())
      .min(1)
      .describe(
        "要删除的节点 ID 数组，至少 1 个；同时会删除这些节点的全部连线",
      ),
  }),
  canvas_connect_nodes: canvasProjectSchema.extend({
    connections: z
      .array(
        z.object({
          fromNodeId: z.string().describe("源节点 ID"),
          toNodeId: z.string().describe("目标节点 ID"),
          role: z
            .string()
            .optional()
            .describe("连线角色，例如 'reference' / 'prompt' / 'control'"),
          order: z.number().optional().describe("同对节点多条连线时的顺序"),
        }),
      )
      .min(1)
      .describe("连线数组，每项含 fromNodeId/toNodeId 必填"),
  }),
  canvas_select_nodes: canvasProjectSchema.extend({
    ids: z.array(z.string()).describe("要选中的节点 ID 数组；空数组=清空选区"),
  }),
  canvas_image_input_manifest: canvasProjectSchema.extend({
    nodeId: z.string().describe("待生成的图片节点 ID"),
    referenceNodeIds: z.array(z.string()).optional().describe("可选的新参考节点顺序；省略时按当前连线预检"),
    characterImageKeys: z.record(z.array(z.string())).optional().describe("按 character 节点 ID 明确选中的图片 storageKey 列表"),
  }),
  canvas_run_generation: canvasProjectSchema.extend({
    nodeId: z.string().describe("要触发生成的配置/媒体节点 ID，必填"),
    segmentId: z
      .string()
      .optional()
      .describe("仅对 H3 多分镜节点有效，指定要跑的 segment；不传则跑全部分镜"),
    mode: generationModeSchema.optional(),
    prompt: z
      .string()
      .optional()
      .describe("可选覆盖提示词；不传则用节点当前的 prompt 输入"),
    referenceNodeIds: z
      .array(z.string())
      .optional()
      .describe(
        "参考节点 ID 列表；会替换节点当前的媒体参考连线；想保留旧参考请用现有节点连线",
      ),
    characterImageKeys: z.record(z.array(z.string())).optional().describe("按 character 节点 ID 指定实际图片；角色有多张图片且未设置节点选择时必须提供"),
    expectedReferenceManifestHash: z.string().optional().describe("canvas_image_input_manifest 返回的参考清单指纹；提交时不一致则拒绝生成"),
    params: recordSchema
      .optional()
      .describe(
        "生成参数对象，因模型而异：例如 h3 模型可含 steps/cfg/sageAttention/seed；先查 H3 工作台当前默认值",
      ),
    idempotencyKey: z.string().optional(),
    resultPolicy: z
      .enum(["replace-active", "append"])
      .optional()
      .describe("replace-active=替换当前激活结果；append=追加新结果"),
  }),
  canvas_task_status: canvasProjectSchema.extend({
    taskId: z.string().optional().describe("精确查询任务 ID；传入后不再按画布过滤"),
    nodeId: z.string().optional().describe("只查询某个画布节点的生成任务"),
    limit: z.number().int().min(1).max(100).optional().describe("最多返回多少条，默认 10"),
  }),
  canvas_wait_tasks: z.object({
    taskIds: z
      .array(z.string().min(1))
      .min(1)
      .max(32)
      .describe("要等待的 Backend taskId 数组"),
    timeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(1800000)
      .optional()
      .describe("最长等待时间，默认 900000ms"),
    pollMs: z
      .number()
      .int()
      .min(250)
      .max(10000)
      .optional()
      .describe("轮询间隔，默认 2000ms"),
  }),
  canvas_h3_confirmation: z.object({
    taskId: z.string().min(1).describe("原始 H3 父任务 ID；不创建新父任务"),
    action: z.enum(["confirm", "keep_first_pass", "discard"]).describe("由用户明确选择：精修二采、保留一采或放弃整个未完成运行"),
    segmentId: z.string().min(1).describe("当前待确认的 Clip ID"),
    expectedRevision: z.number().int().min(0).describe("从任务 confirmation.revision 读取的决议版本；二采失败后需重新读取"),
    postpassParams: z.record(z.unknown()).optional().describe("仅 confirm 使用；当前二采专属参数，Backend 会按允许字段冻结"),
  }),
  generation_get_status: canvasProjectSchema.extend({
    scope: z
      .enum(["all", "canvas", "image", "video"])
      .optional()
      .describe("过滤来源；不传则返回全部"),
    taskId: z.string().optional().describe("精确查询某个工作台任务 ID"),
    nodeIds: z
      .array(z.string())
      .optional()
      .describe("查询画布上的节点生成状态"),
    segmentIds: z
      .array(z.string())
      .optional()
      .describe("仅对 H3 节点：按分镜 ID 过滤"),
    limit: z.number().optional().describe("每来源最多返回多少条，默认 5"),
  }),
  mcp_observability_report: z.object({
    traceId: z.string().optional().describe("读取单次脱敏事件链；不能与聚合筛选同时传入"),
    from: z.string().optional().describe("聚合起始日期 YYYY-MM-DD，按本地日历日包含边界"),
    to: z.string().optional().describe("聚合结束日期 YYYY-MM-DD，按本地日历日包含边界"),
    tool: z.string().optional().describe("只统计指定工具"),
    view: z.enum(["summary", "full"]).optional().describe("默认 summary；full 含逐日和工具转换明细"),
  }),
  mcp_get_command_receipt: z.object({ operationId: z.string().min(1).describe("查询本次写入使用的稳定 operationId") }),
  models_list: z.object({
    capability: z
      .enum(["image", "video", "text", "audio"])
      .optional()
      .describe("按模型能力过滤；不传返回全部"),
  }),
  h3_get_node_materials: canvasProjectSchema.extend({
    nodeId: z.string().describe("H3 视频节点 ID，必填"),
    segmentId: z
      .string()
      .optional()
      .describe("仅返回该分镜的历史；不传则返回节点全部历史"),
    limit: z.number().optional().describe("最多返回多少条历史，默认 50"),
  }),
  comfyui_status: z.object({}).passthrough(),
  comfyui_get_task: z.object({
    taskId: z.string().describe("ComfyUI 任务 ID"),
  }),
  comfyui_cancel_task: z.object({
    taskId: z.string().describe("ComfyUI 任务 ID"),
  }),
  workbench_image_get_config: z.object({}).passthrough(),
  workbench_image_generate: z.object({
    prompt: z
      .string()
      .optional()
      .describe("生图提示词；仅当前工作流要求提示词时必填"),
    model: z
      .string()
      .optional()
      .describe("模型 ID，例如 'krea2'、'qwen-image'；不传用工作台当前默认"),
    quality: z
      .string()
      .optional()
      .describe("质量档位，例如 'standard'、'high'"),
    size: z
      .string()
      .optional()
      .describe(
        "尺寸/比例，例如 '1024x1024'、'1:1'、'16:9'；具体可选值先调 workbench_image_get_config",
      ),
    count: z.number().optional().describe("生成张数，默认 1"),
    run: z
      .boolean()
      .optional()
      .describe("true=自动点击生成；false=仅填入表单不点；默认 true"),
  }),
  workbench_video_get_config: z.object({}).passthrough(),
  workbench_video_generate: z.object({
    prompt: z.string().describe("视频提示词，必填"),
    model: z.string().optional(),
    size: z.string().optional(),
    seconds: z.string().optional().describe("时长，例如 '6'、'10'"),
    resolution: z.string().optional().describe("分辨率，例如 '720p'、'1080p'"),
    generateAudio: z.boolean().optional().describe("是否同时生成音轨"),
    watermark: z.boolean().optional().describe("是否带水印"),
    run: z.boolean().optional().describe("true=自动点击生成；默认 true"),
  }),
  prompts_search: z.object({
    keyword: z.string().optional().describe("关键词模糊搜索标题与正文"),
    category: z.string().optional().describe("分类过滤"),
    tags: z
      .array(z.string())
      .optional()
      .describe("标签过滤数组，例如 ['古风','人物']"),
    page: z.number().optional(),
    pageSize: z.number().optional(),
  }),
  assets_list: z.object({
    kind: z
      .enum(["all", "text", "image", "video", "audio"])
      .optional()
      .describe("素材类型过滤；all=全部"),
    keyword: z.string().optional().describe("关键词模糊搜索"),
    page: z.number().int().min(1).optional(),
    pageSize: z.number().int().min(1).optional(),
  }),
  assets_get: z.object({ id: z.string().min(1).describe("assets_list 返回的精确素材 ID") }),
  assets_add: z.object({
    operationId: z.string().min(1).describe("本次素材新增的稳定 UUID；响应未知时用同一 ID 和完全相同请求恢复回执"),
    kind: z.enum(["text", "image"]).describe("text=纯文本素材；image=图片素材"),
    title: z.string().describe("素材标题，必填"),
    content: z.string().optional().describe("kind=text 时必填，文本内容"),
    imageUrl: z
      .string()
      .optional()
      .describe("kind=image 时必填，图片地址或 dataURL"),
    tags: z
      .array(z.string())
      .optional()
      .describe("标签数组，例如 ['角色','谢临渊']"),
    source: z.string().optional().describe("素材来源说明"),
    note: z.string().optional().describe("备注"),
  }),
  assets_upsert_batch: z.object({
    operationId: z.string().min(1).describe("本次完整批次的稳定 UUID；响应未知时用同一 ID 和相同批次恢复回执"),
    items: z
      .array(assetUpsertItemSchema)
      .min(1)
      .max(100)
      .describe("要幂等写入的完整资产数组；传稳定 id 可更新已有资产"),
  }),
  drama_list_episodes: z.object({
    dramaId: z
      .string()
      .min(1)
      .describe("剧目 ID；来自 drama_create_project 返回的 folder.id"),
  }),
  drama_get_episode: z.object({
    episodeId: z.string().min(1).describe("分集 ID"),
  }),
  drama_create_episode: z.object({
    dramaId: z
      .string()
      .min(1)
      .describe("剧目 ID；来自 drama_create_project 返回的 folder.id"),
    episodeNumber: z
      .number()
      .int()
      .min(1)
      .describe("分集编号，从 1 开始；同一剧目不可重复"),
    title: z.string().optional().describe("分集标题；不传时默认「第 N 集」"),
    synopsis: z
      .string()
      .optional()
      .describe("分集剧情/梗概，独立保存于分集实体"),
    fullPlot: z.string().optional().describe("旧剧情概述；正式分场剧本使用 production_edit(kind:episode,id)"),
    canvasId: z
      .string()
      .nullable()
      .optional()
      .describe("绑定的画布 ID；不传或 null 表示暂不绑定；一画布只能绑定一集"),
  }),
  drama_update_episode: z.object({
    episodeId: z.string().min(1).describe("分集 ID"),
    episodeNumber: z.number().int().min(1).optional().describe("新的分集编号"),
    title: z.string().optional().describe("新的分集标题"),
    synopsis: z.string().optional().describe("新的分集剧情/梗概"),
    fullPlot: z.string().optional().describe("旧剧情概述；正式分场剧本使用 production_edit(kind:episode,id)"),
    canvasId: z
      .string()
      .nullable()
      .optional()
      .describe("新的画布 ID；传 null 解除绑定"),
  }),
  drama_delete_episode: z.object({
    episodeId: z.string().min(1).describe("分集 ID；删除分集不会删除绑定画布"),
  }),
  production_get_contract: productionContractQuerySchema,
  ...productionWorkspaceSchemas,
  ...productionToolSchemas,
  director_subagent: directorSubagentSchema,
  production_compile: productionCompileSchema.extend({ kind: z.enum(["canvas", "episode", "scene"]), id: z.string().min(1), operationId: z.string().min(1) }),
  production_get_compilation: z.object({ kind: z.enum(["canvas", "episode", "scene"]), id: z.string().min(1), operationId: z.string().min(1), view: z.enum(["status", "targets", "diagnostics"]).default("status"), offset: z.number().int().nonnegative().default(0), pageSize: z.number().int().positive().optional() }).strict(),
  production_apply_compilation: productionApplyCompilationSchema.extend({ kind: z.enum(["canvas", "episode", "scene"]), id: z.string().min(1) }),
  production_diagnose_bindings: z.object({ kind: z.enum(["canvas", "episode", "scene"]), id: z.string().min(1) }),
  production_diagnose_clips: z.object({
    projectId: z.string().min(1),
    nodeId: z.string().min(1).optional(),
    nodeIds: z.array(z.string().min(1)).min(1).optional(),
    offset: z.number().int().nonnegative().default(0),
    pageSize: z.number().int().positive().max(1000).default(200),
  }),
} satisfies Record<ToolName, z.AnyZodObject>;

export const toolDescriptions: Record<ToolName, string> = {
  ...collaborationDescriptions,
  site_navigate:
    "跳转网站页面。Acheng 制作使用 production={kind,id,workId,runId?}，网页会按当前 Backend 正式工作目标打开导演工作区或实际媒体节点/Clip；不要凭聊天文字或自行拼路由选择阶段。其他页面可继续使用 path，例如 /image、/video、/prompts、/assets、/config。对 Backend 的制作读写可直接使用原生工具，不需要为了调用工具先打开画布。",
  canvas_list_projects:
    "列出用户全部画布（仅标题、创建/更新时间、节点数、连线数，不含完整数据），支持 keyword 搜索和 page/pageSize 分页。制作时返回的 id 默认配合 site_navigate 的结构化 production 目标进入统一导演工作台；只有用户明确要求画布媒体操作时才打开 /canvas/:id。",
  canvas_inspect:
    "需要选择画布或检查已配置模型能力时使用。返回活动画布、选区、部分节点摘要、参考候选和生成目标；已知节点 ID 的操作可直接执行。",
  canvas_get_state:
    "读取当前画布。默认返回全部节点目录（id/type/title/generationMode），无需布局或连线时用此模式；view: graph 读取节点布局和连线。超限按 nextNodeOffset 分页。已知 nodeIds 时只取指定节点的完整数据和相关连线。完整目录可用 projectId + ifRevision 复查是否变化。H3 时间线用 h3_get_node 读取稳定 Clip ID。",
  canvas_get_selection: "读取当前网页画布选中的节点。",
  canvas_export_snapshot: "导出 Backend 权威画布固定快照，返回 SHA256、字节数与鉴权下载路径；布局查看使用 canvas_get_state。",
  canvas_apply_ops:
    "批量操作画布。projectId、operationId、expectedRevision 必填；响应未知时保留原请求，用 mcp_get_command_receipt 查询；版本冲突不自动 rebase。H3 Clip 内容请使用专用工具；运行状态与结果仍由 Backend 管理。",
  canvas_create_node:
    "创建任意类型节点：text、image、config、video、audio 或插件节点。创建 H3 视频节点须用 nodeType='minimax-h3:video'；canvas_create_config_node 只创建普通 config 节点。",
  canvas_create_attachment_nodes:
    "把当前对话中用户上传的图片附件创建成真实画布图片节点。attachmentIds 使用本轮附件清单中的 ID；返回的节点 ID 可传给 canvas_create_generation_flow.referenceNodeIds 作为生成参考图。",
  canvas_create_text_node:
    "创建单个文本节点：text 必填，可选 title/x/y/width/height。例：{ projectId: 'abc', text: '沈昭宁小传：侯府代笔...', title: '人物小传·沈昭宁', x: 200, y: 100 }",
  canvas_create_text_nodes:
    "批量创建文本节点。items 是数组，每项含 text 必填，可选 title/x/y/width/height。例：{ projectId: 'abc', items: [{ text: '第1集大纲' }, { text: '第2集大纲' }], gap: 32 }",
  canvas_create_config_node:
    "创建普通 config 生成配置节点：mode + prompt + 生成参数；可选 autoRun=true。此工具不能创建 H3 节点；H3 请用 canvas_create_node(nodeType='minimax-h3:video')。例：{ mode: 'image', prompt: '古风女主立绘', size: '1024x1024', autoRun: false }",
  canvas_create_generation_flow:
    "创建通用生成流程（提示词文本节点 + 生成配置节点 + 参考连线）。mode 不传则默认生图；生图提示词可省略，当前工作流声明必填时除外；autoRun=true 立即触发。",
  canvas_generate_text:
    "创建文本生成流程并立即触发（autoRun=true 强制）。例：{ prompt: '为《婚书未烬》写一段 30 秒短剧开场独白，120 字以内' }",
  canvas_generate_image:
    "创建图片生成流程并立即触发。提示词默认可省略，当前工作流声明必填提示词时仍需传入。",
  canvas_generate_image_batch:
    "批量创建并提交图片生成流程。Backend 在 MCP 内部串行处理画布 revision，并一次返回每项的业务键、节点 ID 和 taskId；可用 waitForCompletion=true 让 MCP 内部统一轮询，不再编写外部 JSON-RPC/轮询脚本。",
  canvas_generate_video:
    "创建视频生成流程并立即触发。例：{ prompt: '...', size: '16:9', seconds: '6', referenceNodeIds: [...] }",
  canvas_generate_audio:
    "创建音频生成流程并立即触发。可传 audioVoice/audioInstructions 控制声线与情感。",
  canvas_set_generation_references:
    "替换指定生成节点的参考资源。会删除该节点现有的图片、视频、音频等参考输入，保留文本提示词输入，再按 referenceNodeIds 的顺序重新连接；适合第二次生成或重做分镜时清理旧参考图。例：{ nodeId: 'n-h3-1', referenceNodeIds: ['n-char-1', 'n-outfit-2', 'n-scene-1'] }",
  canvas_update_node:
    "更新节点基础字段用 patch，插件字段用 metadata；metadata 按字段合并。例：{ id: 'n1', patch: { title: '沈昭宁小传', x: 300 } }",
  canvas_move_nodes:
    "移动一个或多个节点。每项支持 绝对坐标(x/y) 或 相对偏移(dx/dy)，二选一；不传则保持原位。例：{ items: [{ id: 'n1', x: 500, y: 300 }, { id: 'n2', dx: 50, dy: 0 }] }",
  canvas_resize_node: "调整节点尺寸。例：{ id: 'n1', width: 400, height: 300 }",
  canvas_delete_nodes: "删除指定节点及相关连线。例：{ ids: ['n1', 'n2'] }",
  canvas_connect_nodes:
    "批量追加连接节点。connections 是数组，每项含 fromNodeId/toNodeId 必填，可选 role（reference/prompt/control）和 order。需要替换生成节点参考图时使用 canvas_set_generation_references，不要直接追加到旧参考输入上。",
  canvas_select_nodes: "设置当前选中节点；空数组=清空选区。",
  canvas_image_input_manifest: "只读预检图片生成的实际输入顺序和 storageKey；角色有多张图时必须明确选图。返回指纹供 canvas_run_generation 锁定输入。",
  canvas_run_generation:
    "触发指定节点生成。图片模式提交前解析真实参考图；多图 character 节点须通过 characterImageKeys 或节点已有选择指定具体图片，可传 expectedReferenceManifestHash 锁定预检清单。referenceNodeIds 会替换现有媒体参考连线；H3 节点可用 segmentId 单跑某分镜。",
  canvas_task_status:
    "即时查询 MCP 发起的画布生成任务。优先传 taskId 精确查询；传入 taskId 后忽略 projectId/nodeId 等过滤条件。不传 taskId 时默认使用当前活动画布，可用 nodeId 缩小范围。运行中任务建议使用 canvas_wait_tasks 等待收口；本工具用于即时查看，不会提交或重试任务。",
  canvas_wait_tasks:
    "按原 taskId 有界等待 Backend 任务。timedOut=true 表示本轮等待结束，pendingTaskIds 和 next 给出原任务的继续查询入口；不要重新提交生成。awaiting_confirmation 表示等待人工确认，先查看一采再由用户选择操作。",
  canvas_h3_confirmation:
    "处理 H3 一采暂停任务：必须先查看一采并由用户明确选择确认二采、保留一采或放弃整个运行。沿用原父 taskId。",
  generation_get_status:
    "查询当前活动网页的生成任务状态。默认返回画布、生图工作台和视频工作台最近任务；可用 scope 过滤来源，用 taskId 查询工作台任务，用 nodeIds 查询画布节点。H3 节点可用 segmentIds 过滤分镜。要看 H3 历史输入快照（prompt/refs/params），用 scope='video' + nodeIds + segmentIds。",
  mcp_observability_report:
    "读取脱敏 MCP 诊断。默认返回聚合摘要，可用 from/to/tool 筛选，view=full 查看逐日和工具转换明细。传 traceId 只读取单次事件链，不能同时传聚合筛选。",
  mcp_get_command_receipt: "恢复 MCP 写入的确定结果。传原 operationId 查询已冻结、已提交或已拒绝回执。相同 ID 不可修改内容；已提交时返回短摘要和版本，必要时再读取最新对象。",
  models_list:
    "列出可用于生成的模型及其能力。工作流是模型内部实现，不直接对外暴露。",
  h3_get_node_materials:
    "读取 H3 视频节点的历史运行产物（视频 url/storageKey/segmentId/createdAt），按时间倒序去重。可选 segmentId 仅返回该片段的历史。替代老的 metadata.materials 与 segments[i].results[].params 字段——这两类从画布 schema 迁出（v4/v5）后不再随 canvas_get_state 返回，模型要看历史需要主动调用本工具。需要 prompt / refs / comfy params 等输入快照用 generation_get_status({scope: 'video', nodeIds, segmentIds})。",
  comfyui_status: "检查本地 ComfyUI 连接和系统状态。",
  comfyui_get_task: "读取本地 ComfyUI 任务状态、事件和结果。",
  comfyui_cancel_task: "取消本地 ComfyUI 任务。",
  workbench_image_get_config:
    "读取生图工作台的当前参数和可选项（可用模型、质量、尺寸/宽高比、张数范围），在调用 workbench_image_generate 前先了解可选值。",
  workbench_image_generate:
    "在生图工作台按需填入提示词并设置 model、quality、size（如 1:1 或 1024x1024）、count；提示词仅在当前工作流声明必填时必需。run 默认 true 会自动点击生成按钮。会自动跳转到生图工作台。生成为异步过程，提交后返回 taskId，可用 generation_get_status 查询状态。",
  workbench_video_get_config:
    "读取视频创作台的当前参数和可选项（可用模型、尺寸/比例、时长、清晰度/分辨率、是否生成声音与水印）。",
  workbench_video_generate:
    "在视频创作台填入提示词并按需设置 model、size、seconds、resolution、generateAudio、watermark，run 默认 true 会自动点击生成按钮。会自动跳转到视频创作台。生成为异步过程，提交后返回 taskId，可用 generation_get_status 查询状态。",
  prompts_search:
    "搜索提示词库（第三方提示词合集），支持 keyword、category、tags 过滤和 page/pageSize 分页，返回标题、提示词、分类、标签、封面等。tags 传 string 数组，例如 ['古风','人物']。",
  assets_list:
    "分页列出「我的素材」摘要，默认第 1 页、每页 20 条。支持 kind、keyword、page、pageSize；筛选与分页在 Backend 存储层完成，不返回内联媒体和完整文本。用 assets_get({id}) 精确读取单项详情。",
  assets_get: "按 assets_list 返回的精确 ID 读取一项素材完整详情。",
  assets_add:
    "向「我的素材」新增素材。必填 operationId；响应未知时用原 ID 和相同内容恢复回执。kind=text 用 content，kind=image 用 imageUrl。成功只返回 assetId 和哈希摘要；详情用 assets_get 按 ID 读取。",
  assets_upsert_batch:
    "使用稳定 operationId 原子写入一批素材，失败时整批回滚。重试必须使用相同 ID 和相同内容；成功只返回资产 ID、数量和哈希摘要，不重复返回素材正文。",
  drama_list_episodes:
    "列出一个剧目的全部分集，按 episodeNumber 升序返回；每项含标题、剧情和绑定画布 ID。",
  drama_get_episode:
    "读取单个分集的完整字段，并返回其绑定画布；未绑定画布时 canvas 为 null。",
  drama_create_episode:
    "创建剧目下的一集。synopsis 和 fullPlot 分别保存梗概与完整剧情；可选绑定一个已有画布。",
  drama_update_episode:
    "更新分集梗概、完整剧情或画布绑定。传 canvasId=null 可解除绑定，不会删除画布或分集剧情。",
  drama_delete_episode:
    "删除分集记录；不会删除其绑定的画布，画布会变成独立资产。",
  production_get_contract: "查询完整制作操作 schema、合法示例、前置条件和本机当前激活引擎的源稿模板；runtimeId 已弃用，保留参数兼容但不选择执行版本。",
  ...productionWorkspaceDescriptions,
  ...productionToolDescriptions,
  director_subagent: directorSubagentDescription,
  production_compile: "后台运行固定 Acheng 编译器；operationId 必填，立即返回持久短回执。通过 production_get_compilation 查询原 operationId，succeeded 后应用 preparedId。blocked 是终态，按 blockingDiagnostic 的 targetId/shotId/path 定位；PROMPT_EXTERNAL_CONTEXT 表示提示词依赖外部文字，不是缺少前段文件。来源为 compiler 时修编译器，不改创作稿。相同有效输入换 ID 会 reused 返回原阻塞回执，不重跑；输入或运行条件改变后再编译。超时沿原 ID 查询。不编辑、发布或生成媒体。",
  production_get_compilation: "按 owner 和原 operationId 查询后台编译状态及应用回执；默认返回短状态、首条 blockingDiagnostic 和 nextAction；诊断/目标列表需 view 和 pageSize。queued/running 沿原 ID 查询，blocked/failed 不继续轮询同一终态；reusedFromOperationId 保留原阻塞身份。只读，不重跑编译。",
  production_apply_compilation: "用精确 preparedId 原子接入 Backend 编译产物；沿用冻结的 expectedRevision/operationId，重复调用恢复原回执，源稿或绑定冲突拒绝覆盖。保存草稿，不发布或生成。",
  production_diagnose_bindings: "只读核对源资产版本、草稿绑定、发布版本绑定、节点活动媒体、归档字节哈希与消费者；明确指出新旧版本或活动媒体不一致，不修改数据。",
  production_diagnose_clips: "只读逐段对照 H3 Clip 现场正文与最新发布编译产物：状态（一致/不同/无法比较）、两侧归一哈希、导演源哈希、任务状态、生产版本与只读下一步。一次调用完成排障；不同为信息级提示，不表示生成不可用。nodeId 与 nodeIds 同时出现时以 nodeIds 为准。默认最多返回 200 行，超出时给出 nextOffset。",
};
