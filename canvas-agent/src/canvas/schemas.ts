import { z } from "zod";

const recordSchema = z.record(z.unknown()).describe(
    "任意键值对 JSON 对象，例如 params/metadata/patch。键名因工具而异：comfyui_run.params 对应 ComfyUI 节点输入；canvas_update_node.patch 是节点字段子集。"
);
const canvasProjectSchema = z.object({
    projectId: z.string().optional().describe(
        "画布 ID（folder id），不传则作用于当前 activeProject。若当前无活动画布且不传此参数，工具会报错。"
    ),
});
const positionSchema = z.object({
    x: z.number().describe("画布世界坐标 X，正数向右"),
    y: z.number().describe("画布世界坐标 Y，正数向下"),
});
const nodeTypeSchema = z.string().min(1).describe(
    "节点类型枚举，常用值：text（文本节点）、image（图片节点）、config（生成配置节点）、video（视频节点）、audio（音频节点）。新类型可由插件自定义。"
);
const generationModeSchema = z.enum(["text", "image", "video", "audio"]).describe(
    "生成模式：text=大模型生成文本，image=文生图/图生图，video=文生视频/图生视频，audio=语音/音频生成。"
);

/** Canvas Agent 对外提供的工具名称。 */
export const toolNames = [
    "site_navigate",
    "canvas_list_projects",
    "canvas_get_state",
    "canvas_get_selection",
    "canvas_export_snapshot",
    "canvas_apply_ops",
    "canvas_create_node",
    "canvas_create_attachment_nodes",
    "canvas_create_text_node",
    "canvas_create_text_nodes",
    "canvas_create_config_node",
    "canvas_create_image_prompt_flow",
    "canvas_create_generation_flow",
    "canvas_generate_text",
    "canvas_generate_image",
    "canvas_generate_video",
    "canvas_generate_audio",
    "canvas_set_generation_references",
    "canvas_update_node",
    "canvas_update_node_text",
    "canvas_move_nodes",
    "canvas_resize_node",
    "canvas_delete_nodes",
    "canvas_connect_nodes",
    "canvas_select_nodes",
    "canvas_run_generation",
    "generation_get_status",
    "h3_get_node_materials",
    "comfyui_status",
    "comfyui_list_presets",
    "comfyui_run",
    "comfyui_get_task",
    "comfyui_cancel_task",
    "workbench_image_get_config",
    "workbench_image_generate",
    "workbench_video_get_config",
    "workbench_video_generate",
    "prompts_search",
    "assets_list",
    "assets_add",
] as const;
export type ToolName = (typeof toolNames)[number];

export const canvasOpSchema = z.discriminatedUnion("type", [
    z.object({
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
    }).passthrough().describe("添加一个节点。可省略 id 由后端分配。例：{ type: 'add_node', nodeType: 'text', title: '沈昭宁小传', x: 200, y: 100 }"),
    z.object({
        type: z.literal("update_node"),
        id: z.string().describe("目标节点 ID，必填"),
        patch: recordSchema.optional().describe("节点字段子集，如 { x: 300, y: 200, title: '新标题' }"),
        metadata: recordSchema.optional().describe("整段覆盖节点 metadata；只想改部分字段请用 patch"),
    }).passthrough(),
    z.object({
        type: z.literal("delete_node"),
        id: z.string().optional().describe("单个节点 ID；与 ids 二选一"),
        ids: z.array(z.string()).optional().describe("多个节点 ID 数组，与 id 二选一"),
    }).passthrough(),
    z.object({
        type: z.literal("delete_connections"),
        id: z.string().optional(),
        ids: z.array(z.string()).optional(),
        all: z.boolean().optional().describe("是否删光画布全部连线；true 时省略 ids"),
    }).passthrough(),
    z.object({
        type: z.literal("connect_nodes"),
        id: z.string().optional(),
        fromNodeId: z.string().describe("源节点 ID"),
        toNodeId: z.string().describe("目标节点 ID"),
        role: z.string().optional().describe("连线角色，常见：reference（参考）/ prompt（提示词）/ control（控制）"),
        order: z.number().optional().describe("当同一对节点多条连线时的顺序"),
    }).passthrough(),
    z.object({
        type: z.literal("select_nodes"),
        ids: z.array(z.string()).describe("要选中的节点 ID 数组，传空数组会清空选区"),
    }).passthrough(),
    z.object({
        type: z.literal("run_generation"),
        nodeId: z.string().describe("要触发生成的配置/媒体节点 ID"),
        mode: generationModeSchema.optional(),
        prompt: z.string().optional().describe("可选覆盖提示词；不传则用节点当前的 prompt 输入"),
        referenceNodeIds: z.array(z.string()).optional().describe("参考节点 ID 列表；会替换节点当前的媒体参考连线"),
        params: recordSchema.optional(),
        idempotencyKey: z.string().optional(),
        resultPolicy: z.enum(["replace-active", "append"]).optional().describe("replace-active=替换当前激活结果；append=追加新结果"),
    }).passthrough(),
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
    model: z.string().optional().describe("模型 ID，例如 krea2/qwen-image/h3；不传用工作台当前默认"),
    size: z.string().optional().describe("图像/视频尺寸或比例，例如 '1024x1024'、'16:9'；具体可选值先调 workbench_*_get_config"),
    quality: z.string().optional().describe("质量档位，例如 'standard'、'high'"),
    count: z.number().optional().describe("生成张数，1-4"),
    seconds: z.string().optional().describe("视频时长，例如 '6'、'10'"),
    vquality: z.string().optional().describe("视频清晰度，例如 '720p'、'1080p'"),
    generateAudio: z.string().optional().describe("视频是否同时生成音轨，'true' / 'false' 字符串"),
    watermark: z.string().optional().describe("是否带水印，'true' / 'false' 字符串"),
    audioVoice: z.string().optional().describe("TTS 声线 ID，例如 zh-CN-XiaoxiaoNeural"),
    audioFormat: z.string().optional().describe("音频格式，例如 'mp3'、'wav'"),
    audioSpeed: z.string().optional().describe("语速倍率，'1.0' 为正常"),
    audioInstructions: z.string().optional().describe("TTS 情感/口吻提示，例如 '平静叙述'"),
    params: recordSchema.optional(),
    idempotencyKey: z.string().optional(),
    resultPolicy: z.enum(["replace-active", "append"]).optional(),
});

const generationFlowSchema = z.object({
    prompt: z.string().describe("生成提示词，必填"),
    title: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    referenceNodeIds: z.array(z.string()).optional().describe("参考节点 ID 数组，按此顺序连线；空数组=无参考"),
});

export const toolInputSchemas = {
    site_navigate: z.object({
        path: z.string().describe("页面路径，例如 '/canvas'、'/canvas/abc123'、'/image'、'/video'、'/prompts'、'/assets'、'/config'。操作画布前若不在画布页，先用本工具跳转。"),
    }),
    canvas_list_projects: canvasProjectSchema.extend({
        keyword: z.string().optional().describe("按标题模糊搜索"),
        folderId: z.string().nullable().optional().describe("可选剧目文件夹 ID 过滤；不传 = 全部；显式传 null 或空字符串 = 只取未挂剧目的画布；传具体 ID = 只取该剧目下的画布"),
        page: z.number().optional().describe("页码，从 1 开始；默认 1"),
        pageSize: z.number().optional().describe("每页数量，默认 20，最大 100"),
    }),
    canvas_get_state: canvasProjectSchema.passthrough(),
    canvas_get_selection: canvasProjectSchema.passthrough(),
    canvas_export_snapshot: canvasProjectSchema.passthrough(),
    canvas_apply_ops: canvasProjectSchema.extend({
        ops: z.array(canvasOpSchema).min(1).describe("操作数组，至少 1 个；type 决定其余字段。例：[{ type: 'add_node', nodeType: 'text', title: '剧名', x: 100, y: 100 }, { type: 'connect_nodes', fromNodeId: 'n1', toNodeId: 'n2' }]"),
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
        attachmentIds: z.array(z.string()).min(1).describe("本轮对话附件 ID 数组，从用户上传消息中获取，至少 1 个"),
        x: z.number().optional(),
        y: z.number().optional(),
        gap: z.number().optional().describe("节点间距，默认 32"),
        direction: z.enum(["row", "column"]).optional().describe("排列方向，row=水平、column=垂直；默认 column"),
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
        items: z.array(textNodeSchema).min(1).describe("要批量创建的文本节点数组，每项含 text 必填，可选 title/x/y/width/height"),
        x: z.number().optional().describe("起始坐标 X；items 自带 x 时优先 items"),
        y: z.number().optional().describe("起始坐标 Y"),
        gap: z.number().optional().describe("节点间距，默认 24"),
        direction: z.enum(["row", "column"]).optional().describe("排列方向，默认 column"),
    }),
    canvas_create_config_node: canvasProjectSchema.extend({
        prompt: z.string().optional().describe("生成提示词；可后续用 canvas_update_node_text 覆盖"),
        mode: generationModeSchema.optional(),
        title: z.string().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        autoRun: z.boolean().optional().describe("true=创建后立即触发一次生成；false=仅创建占位"),
    }).merge(generationOptionsSchema),
    canvas_create_image_prompt_flow: canvasProjectSchema.extend({
        prompt: z.string().describe("生图提示词，必填"),
        x: z.number().optional(),
        y: z.number().optional(),
        autoRun: z.boolean().optional(),
    }).merge(generationOptionsSchema),
    canvas_create_generation_flow: canvasProjectSchema.extend(generationFlowSchema.shape).extend({
        mode: generationModeSchema.optional(),
        autoRun: z.boolean().optional(),
    }).merge(generationOptionsSchema),
    canvas_generate_text: canvasProjectSchema.extend(generationFlowSchema.shape).merge(generationOptionsSchema),
    canvas_generate_image: canvasProjectSchema.extend(generationFlowSchema.shape).merge(generationOptionsSchema),
    canvas_generate_video: canvasProjectSchema.extend(generationFlowSchema.shape).merge(generationOptionsSchema),
    canvas_generate_audio: canvasProjectSchema.extend(generationFlowSchema.shape).merge(generationOptionsSchema),
    canvas_set_generation_references: canvasProjectSchema.extend({
        nodeId: z.string().describe("目标生成节点 ID，必填"),
        referenceNodeIds: z.array(z.string()).describe("新的参考节点 ID 数组；会先清空节点现有的图片/视频/音频参考连线，再按本数组顺序重新连；传空数组可清空全部参考"),
    }),
    canvas_update_node: canvasProjectSchema.extend({
        id: z.string().describe("目标节点 ID，必填"),
        patch: recordSchema.optional().describe("节点字段子集，如 { x: 300, y: 200, title: '新标题' }"),
        metadata: recordSchema.optional().describe("整段覆盖节点 metadata；只想改部分字段请用 patch"),
    }),
    canvas_update_node_text: canvasProjectSchema.extend({
        id: z.string().describe("文本节点 ID，必填"),
        text: z.string().describe("新的文本内容，必填"),
        title: z.string().optional().describe("同时修改标题；不传则保留原标题"),
    }),
    canvas_move_nodes: canvasProjectSchema.extend({
        items: z.array(z.object({
            id: z.string().describe("节点 ID，必填"),
            x: z.number().optional().describe("绝对坐标 X；与 dx 二选一"),
            y: z.number().optional().describe("绝对坐标 Y；与 dy 二选一"),
            dx: z.number().optional().describe("相对偏移 X；与 x 二选一"),
            dy: z.number().optional().describe("相对偏移 Y；与 y 二选一"),
        })).min(1).describe("移动项数组；每项可单独选 绝对坐标(x/y) 或 相对偏移(dx/dy)，混用时以绝对坐标优先"),
    }),
    canvas_resize_node: canvasProjectSchema.extend({
        id: z.string().describe("节点 ID"),
        width: z.number().describe("新宽度"),
        height: z.number().describe("新高度"),
        freeResize: z.boolean().optional().describe("true=不受最小尺寸约束"),
    }),
    canvas_delete_nodes: canvasProjectSchema.extend({
        ids: z.array(z.string()).min(1).describe("要删除的节点 ID 数组，至少 1 个；同时会删除这些节点的全部连线"),
    }),
    canvas_connect_nodes: canvasProjectSchema.extend({
        connections: z.array(z.object({
            fromNodeId: z.string().describe("源节点 ID"),
            toNodeId: z.string().describe("目标节点 ID"),
            role: z.string().optional().describe("连线角色，例如 'reference' / 'prompt' / 'control'"),
            order: z.number().optional().describe("同对节点多条连线时的顺序"),
        })).min(1).describe("连线数组，每项含 fromNodeId/toNodeId 必填"),
    }),
    canvas_select_nodes: canvasProjectSchema.extend({
        ids: z.array(z.string()).describe("要选中的节点 ID 数组；空数组=清空选区"),
    }),
    canvas_run_generation: canvasProjectSchema.extend({
        nodeId: z.string().describe("要触发生成的配置/媒体节点 ID，必填"),
        segmentId: z.string().optional().describe("仅对 H3 多分镜节点有效，指定要跑的 segment；不传则跑全部分镜"),
        mode: generationModeSchema.optional(),
        prompt: z.string().optional().describe("可选覆盖提示词；不传则用节点当前的 prompt 输入"),
        referenceNodeIds: z.array(z.string()).optional().describe("参考节点 ID 列表；会替换节点当前的媒体参考连线；想保留旧参考请用现有节点连线"),
        params: recordSchema.optional().describe("生成参数对象，因模型而异：例如 h3 模型可含 steps/cfg/sageAttention/seed；先查 H3 工作台当前默认值"),
        idempotencyKey: z.string().optional(),
        resultPolicy: z.enum(["replace-active", "append"]).optional().describe("replace-active=替换当前激活结果；append=追加新结果"),
    }),
    generation_get_status: canvasProjectSchema.extend({
        scope: z.enum(["all", "canvas", "image", "video"]).optional().describe("过滤来源；不传则返回全部"),
        taskId: z.string().optional().describe("精确查询某个工作台任务 ID"),
        nodeIds: z.array(z.string()).optional().describe("查询画布上的节点生成状态"),
        segmentIds: z.array(z.string()).optional().describe("仅对 H3 节点：按分镜 ID 过滤"),
        limit: z.number().optional().describe("每来源最多返回多少条，默认 10"),
    }),
    h3_get_node_materials: canvasProjectSchema.extend({
        nodeId: z.string().describe("H3 视频节点 ID，必填"),
        segmentId: z.string().optional().describe("仅返回该分镜的历史；不传则返回节点全部历史"),
        limit: z.number().optional().describe("最多返回多少条历史，默认 50"),
    }),
    comfyui_status: z.object({}).passthrough(),
    comfyui_list_presets: z.object({}).passthrough(),
    comfyui_run: z.object({
        preset: z.string().describe("ComfyUI 内置预设名称，先调 comfyui_list_presets 查可用值"),
        input: recordSchema.optional().describe("预设输入字段，按该 preset 的 schema 填；可塞图片 dataURL 或路径"),
        params: recordSchema.optional().describe("运行时覆盖参数，例如 sampler/steps/cfg"),
    }),
    comfyui_get_task: z.object({
        taskId: z.string().describe("ComfyUI 任务 ID，从 comfyui_run 返回值里取"),
    }),
    comfyui_cancel_task: z.object({
        taskId: z.string().describe("ComfyUI 任务 ID"),
    }),
    workbench_image_get_config: z.object({}).passthrough(),
    workbench_image_generate: z.object({
        prompt: z.string().describe("生图提示词，必填"),
        model: z.string().optional().describe("模型 ID，例如 'krea2'、'qwen-image'；不传用工作台当前默认"),
        quality: z.string().optional().describe("质量档位，例如 'standard'、'high'"),
        size: z.string().optional().describe("尺寸/比例，例如 '1024x1024'、'1:1'、'16:9'；具体可选值先调 workbench_image_get_config"),
        count: z.number().optional().describe("生成张数，默认 1"),
        run: z.boolean().optional().describe("true=自动点击生成；false=仅填入表单不点；默认 true"),
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
        tags: z.array(z.string()).optional().describe("标签过滤数组，例如 ['古风','人物']"),
        page: z.number().optional(),
        pageSize: z.number().optional(),
    }),
    assets_list: z.object({
        kind: z.enum(["all", "text", "image", "video", "audio"]).optional().describe("素材类型过滤；all=全部"),
        keyword: z.string().optional().describe("关键词模糊搜索"),
        page: z.number().optional(),
        pageSize: z.number().optional(),
    }),
    assets_add: z.object({
        kind: z.enum(["text", "image"]).describe("text=纯文本素材；image=图片素材"),
        title: z.string().describe("素材标题，必填"),
        content: z.string().optional().describe("kind=text 时必填，文本内容"),
        imageUrl: z.string().optional().describe("kind=image 时必填，图片地址或 dataURL"),
        tags: z.array(z.string()).optional().describe("标签数组，例如 ['角色','谢临渊']"),
        source: z.string().optional().describe("素材来源说明"),
        note: z.string().optional().describe("备注"),
    }),
} satisfies Record<ToolName, z.AnyZodObject>;

export const toolDescriptions: Record<ToolName, string> = {
    site_navigate: "跳转网站页面。path 可为 / (首页)、/canvas (我的画布)、/canvas/:id (指定画布)、/image (生图工作台)、/video (视频创作台)、/prompts (提示词库)、/assets (我的素材)、/config (配置)。操作画布前若不在画布页，先用本工具打开画布。",
    canvas_list_projects: "列出用户全部画布（仅标题、创建/更新时间、节点数、连线数，不含完整数据），支持 keyword 搜索和 page/pageSize 分页。返回的 id 可配合 site_navigate 跳转到 /canvas/:id 打开对应画布。",
    canvas_get_state: "读取当前画布的节点、连线和选区。浏览器视口中心与缩放属于页面本地状态，不通过 MCP 读取。",
    canvas_get_selection: "读取当前网页画布选中的节点。",
    canvas_export_snapshot: "导出当前画布快照，用于理解布局。",
    canvas_apply_ops: "批量操作当前网页画布。ops 支持 add_node、update_node、delete_node、delete_connections、connect_nodes、select_nodes、run_generation；需要替换生成节点参考图时使用 canvas_set_generation_references，避免旧媒体输入残留。",
    canvas_create_node: "创建任意类型节点：text、image、config、video、audio。适合创建占位图、媒体占位、配置节点或自定义 metadata 节点。",
    canvas_create_attachment_nodes: "把当前对话中用户上传的图片附件创建成真实画布图片节点。attachmentIds 使用本轮附件清单中的 ID；返回的节点 ID 可传给 canvas_create_generation_flow.referenceNodeIds 作为生成参考图。",
    canvas_create_text_node: "创建单个文本节点：text 必填，可选 title/x/y/width/height。例：{ projectId: 'abc', text: '沈昭宁小传：侯府代笔...', title: '人物小传·沈昭宁', x: 200, y: 100 }",
    canvas_create_text_nodes: "批量创建文本节点。items 是数组，每项含 text 必填，可选 title/x/y/width/height。例：{ projectId: 'abc', items: [{ text: '第1集大纲' }, { text: '第2集大纲' }], gap: 32 }",
    canvas_create_config_node: "创建生成配置节点：mode + prompt + 生成参数；可选 autoRun=true 创建后立即触发一次。例：{ mode: 'image', prompt: '古风女主立绘', size: '1024x1024', autoRun: false }",
    canvas_create_image_prompt_flow: "创建提示词文本节点和图片生成配置节点，并自动连线；可选 autoRun=true 立即触发生图。例：{ prompt: '古风女主立绘，白衣', size: '1024x1024', autoRun: true }",
    canvas_create_generation_flow: "创建通用生成流程（提示词文本节点 + 生成配置节点 + 参考连线）。mode 不传则用默认；autoRun=true 立即触发。",
    canvas_generate_text: "创建文本生成流程并立即触发（autoRun=true 强制）。例：{ prompt: '为《婚书未烬》写一段 30 秒短剧开场独白，120 字以内' }",
    canvas_generate_image: "创建图片生成流程并立即触发。例：{ prompt: '古风女主立绘，白衣', size: '1:1', referenceNodeIds: ['n-char-1', 'n-outfit-1'] }",
    canvas_generate_video: "创建视频生成流程并立即触发。例：{ prompt: '...', size: '16:9', seconds: '6', referenceNodeIds: [...] }",
    canvas_generate_audio: "创建音频生成流程并立即触发。可传 audioVoice/audioInstructions 控制声线与情感。",
    canvas_set_generation_references: "替换指定生成节点的参考资源。会删除该节点现有的图片、视频、音频等参考输入，保留文本提示词输入，再按 referenceNodeIds 的顺序重新连接；适合第二次生成或重做分镜时清理旧参考图。例：{ nodeId: 'n-h3-1', referenceNodeIds: ['n-char-1', 'n-outfit-2', 'n-scene-1'] }",
    canvas_update_node: "更新节点基础字段或 metadata；只想改部分字段用 patch，整段覆盖用 metadata。例：{ id: 'n1', patch: { title: '沈昭宁小传', x: 300 } }",
    canvas_update_node_text: "更新文本节点内容和标题。例：{ id: 'n-text-1', text: '新内容', title: '新标题（可选）' }",
    canvas_move_nodes: "移动一个或多个节点。每项支持 绝对坐标(x/y) 或 相对偏移(dx/dy)，二选一；不传则保持原位。例：{ items: [{ id: 'n1', x: 500, y: 300 }, { id: 'n2', dx: 50, dy: 0 }] }",
    canvas_resize_node: "调整节点尺寸。例：{ id: 'n1', width: 400, height: 300 }",
    canvas_delete_nodes: "删除指定节点及相关连线。例：{ ids: ['n1', 'n2'] }",
    canvas_connect_nodes: "批量追加连接节点。connections 是数组，每项含 fromNodeId/toNodeId 必填，可选 role（reference/prompt/control）和 order。需要替换生成节点参考图时使用 canvas_set_generation_references，不要直接追加到旧参考输入上。",
    canvas_select_nodes: "设置当前选中节点；空数组=清空选区。",
    canvas_run_generation: "触发指定节点生成，通常用于配置节点或文本/图片/视频/音频节点。若本次要换一套参考图，传 referenceNodeIds；它会先替换现有媒体参考连线，再提交生成，避免旧参考图残留。H3 节点可用 segmentId 单跑某分镜。",
    generation_get_status: "查询当前活动网页的生成任务状态。默认返回画布、生图工作台和视频工作台最近任务；可用 scope 过滤来源，用 taskId 查询工作台任务，用 nodeIds 查询画布节点。H3 节点可用 segmentIds 过滤分镜。要看 H3 历史输入快照（prompt/refs/params），用 scope='video' + nodeIds + segmentIds。",
    h3_get_node_materials: "读取 H3 视频节点的历史运行产物（视频 url/storageKey/segmentId/createdAt），按时间倒序去重。可选 segmentId 仅返回该片段的历史。替代老的 metadata.materials 与 segments[i].results[].params 字段——这两类从画布 schema 迁出（v4/v5）后不再随 canvas_get_state 返回，模型要看历史需要主动调用本工具。需要 prompt / refs / comfy params 等输入快照用 generation_get_status({scope: 'video', nodeIds, segmentIds})。",
    comfyui_status: "检查本地 ComfyUI 连接和系统状态。",
    comfyui_list_presets: "列出本地 ComfyUI 内置预设及输入参数。",
    comfyui_run: "运行本地 ComfyUI 内置预设；输入必须是 Agent 已知的本地媒体引用。先调 comfyui_list_presets 看 preset 名与输入 schema。",
    comfyui_get_task: "读取本地 ComfyUI 任务状态、事件和结果。",
    comfyui_cancel_task: "取消本地 ComfyUI 任务。",
    workbench_image_get_config: "读取生图工作台的当前参数和可选项（可用模型、质量、尺寸/宽高比、张数范围），在调用 workbench_image_generate 前先了解可选值。",
    workbench_image_generate: "在生图工作台填入提示词并按需设置 model、quality、size（如 1:1 或 1024x1024）、count，run 默认 true 会自动点击生成按钮。会自动跳转到生图工作台。生成为异步过程，提交后返回 taskId，可用 generation_get_status 查询状态。",
    workbench_video_get_config: "读取视频创作台的当前参数和可选项（可用模型、尺寸/比例、时长、清晰度/分辨率、是否生成声音与水印）。",
    workbench_video_generate: "在视频创作台填入提示词并按需设置 model、size、seconds、resolution、generateAudio、watermark，run 默认 true 会自动点击生成按钮。会自动跳转到视频创作台。生成为异步过程，提交后返回 taskId，可用 generation_get_status 查询状态。",
    prompts_search: "搜索提示词库（第三方提示词合集），支持 keyword、category、tags 过滤和 page/pageSize 分页，返回标题、提示词、分类、标签、封面等。tags 传 string 数组，例如 ['古风','人物']。",
    assets_list: "列出用户「我的素材」，支持 kind（text/image/video）过滤、keyword 搜索和 page/pageSize 分页。为控制体积不返回图片/视频原始 data，仅返回封面与元信息。",
    assets_add: "向「我的素材」新增素材。kind=text 时用 content 传文本内容；kind=image 时用 imageUrl 传图片地址或 dataURL。可附带 title、tags、source、note。例：{ kind: 'text', title: '婚书未烬·人物小传', content: '沈昭宁...', tags: ['角色','短剧'] }",
};
