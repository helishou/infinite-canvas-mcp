import { H3_NARRATIVE_FIELDS, H3_TEXT_EDIT_FIELDS } from "./narrative-edits.js";

/** Shared MCP declarations: server and browser manifest advertise identical contracts. */
export const H3_UPDATE_CLIPS_TOOL = {
    id: "h3_update_clips",
    version: "1.2.0",
    name: "H3 批量更新片段配置",
    description: "一次原子事务更新同一 H3 节点的多个已有 Clip 保存稿。已有修改稿文件优先先 h3_prepare_clip_updates，再仅传 preparedId，不重新输出正文；preparedId 与内联 updates 互斥。内联 updates 兼容完整 patch/精确 edits+expectedMatches。整批失败或版本冲突不写入，dryRun=true 只预检。冻结方案不自动 rebase；同一句柄重复提交复用 operationId 取原回执（历史提交值，不代表之后没有新编辑），未知结果先按原句柄恢复并核对目标。只改保存稿不生成、不改角色组/运行字段/历史任务输入。返回实际短值和 JSON UTF-8 SHA-256，不返回整图。",
    inputJsonSchema: {
        type: "object",
        properties: {
            projectId: { type: "string", minLength: 1, description: "目标画布的精确 ID" },
            nodeId: { type: "string", minLength: 1, description: "目标 H3 节点的精确 ID" },
            expectedRevision: { type: "integer", minimum: 0, description: "可选：调用方读取的 revision；与当前画布不符则拒绝整批" },
            dryRun: { type: "boolean", description: "true 只预检和预览，不落盘；省略/false 才提交" },
            preparedId: { type: "string", description: "h3_prepare_clip_updates 返回的冻结句柄；与 updates 互斥。句柄固定目标/revision/操作，不重传正文；重复提交同一句柄复用 operationId 取原事务回执，不自动 rebase" },
            updates: {
                type: "array", minItems: 1, maxItems: 100,
                description: "每个已有 Clip 一项，不重复 segmentId；patch/edits 至少一项，不能同时修改同一根字段",
                items: {
                    type: "object",
                    properties: {
                        segmentId: { type: "string", minLength: 1, description: "h3_get_node 返回的当前稳定 Clip ID" },
                        patch: { type: "object", minProperties: 1, additionalProperties: true, description: "本段配置增量；禁止 id、角色组、运行状态及结果字段" },
                        edits: {
                            type: "array", minItems: 1, maxItems: 100,
                            description: "精确、区分大小写、非正则替换，按输入顺序执行；timeline 次数为所选字符串列的总命中数。不自动改未指定字段或台词",
                            items: {
                                type: "object",
                                properties: {
                                    field: { type: "string", enum: H3_TEXT_EDIT_FIELDS },
                                    find: { type: "string", minLength: 1, description: "需替换的精确原文字串" },
                                    replace: { type: "string", description: "精确新文；空串表示删除该字串" },
                                    expectedMatches: { type: "integer", minimum: 1, description: "预期命中次数（正的安全整数），不符则整批拒绝" },
                                },
                                required: ["field", "find", "replace", "expectedMatches"], additionalProperties: false,
                            },
                        },
                    },
                    required: ["segmentId"],
                    anyOf: [{ required: ["patch"] }, { required: ["edits"] }],
                    additionalProperties: false,
                },
            },
        },
        required: ["projectId", "nodeId"],
        oneOf: [{ required: ["updates"] }, { required: ["preparedId"] }],
        additionalProperties: false,
    },
    annotations: { title: "H3 批量更新片段配置", readOnlyHint: false },
} as const;

export const H3_PREPARE_CLIP_UPDATES_TOOL = {
    id: "h3_prepare_clip_updates", version: "1.0.0", name: "H3 载入修改稿文件",
    description: "通过 Backend 原生读取准备目录内的 JSON 修改稿，校验文件 SHA-256、目标、before 基线、revision 与整批引用。文件格式 {formatVersion:1,projectId,nodeId,expectedRevision,items:[{segmentId,before,update:{segmentId,patch或edits}}]}。按字段选择更小的精确 edits/patch，冻结原子操作后返回短 preparedId、有界差异和摘要；不写画布、不生成。主代理只审差异与问题，不重新抄写全文；用 h3_update_clips(preparedId) 预览/提交相同方案。默认准备目录为 Backend 用户的 Hermes cache/scratch，可用 INFINITE_CANVAS_PREPARED_UPDATES_ROOT 指定单一目录；不能读目录外文件。",
    inputJsonSchema: { type: "object", properties: {
        projectId: { type: "string", minLength: 1 }, nodeId: { type: "string", minLength: 1 },
        filePath: { type: "string", minLength: 1, description: "允许准备目录下 JSON 文件的绝对路径" },
        fileSha256: { type: "string", pattern: "^[a-f0-9]{64}$", description: "本地离线计算的原始文件字节 SHA-256；变动则拒绝" },
    }, required: ["projectId", "nodeId", "filePath", "fileSha256"], additionalProperties: false },
    annotations: { title: "H3 载入修改稿文件", readOnlyHint: false },
} as const;

export const H3_DISCARD_CLIP_UPDATES_TOOL = {
    id: "h3_discard_clip_updates", version: "1.0.0", name: "H3 清理冻结修改方案",
    description: "删除精确 preparedId 的 Backend 冻结文件；不删除原始修改稿、画布、媒体或事务回执。完成或明确放弃后清理，未知提交结果必须先按原句柄恢复回执并核对目标，不提前删除。",
    inputJsonSchema: { type: "object", properties: { projectId: { type: "string" }, nodeId: { type: "string" }, preparedId: { type: "string" } }, required: ["projectId", "nodeId", "preparedId"], additionalProperties: false },
    annotations: { title: "H3 清理冻结修改方案", readOnlyHint: false },
} as const;

export const H3_GET_CLIP_TOOL = {
    id: "h3_get_clip", version: "1.3.0", name: "H3 读取片段总览",
    description: "按稳定 segmentId 读取 H3 Clip 轻量状态。fields 只读指定叙事字段，缺失字段单列 missingFields，不伪造空值；避免全节点 metadata。include 可另外附带完整 semantic/compiled 提示词、参考或运行参数；只核对少数字段时用 fields，不额外带 include:prompt。",
    inputJsonSchema: {
        type: "object",
        properties: {
            projectId: { type: "string" }, nodeId: { type: "string" }, segmentId: { type: "string" },
            include: { type: "array", items: { type: "string", enum: ["prompt", "references", "runtime"] }, uniqueItems: true },
            fields: { type: "array", minItems: 1, maxItems: H3_NARRATIVE_FIELDS.length, items: { type: "string", enum: H3_NARRATIVE_FIELDS }, uniqueItems: true },
        }, required: ["projectId", "nodeId", "segmentId"],
    },
    annotations: { title: "H3 读取片段总览", readOnlyHint: true },
} as const;
