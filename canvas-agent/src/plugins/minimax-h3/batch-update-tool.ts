import { H3_NARRATIVE_FIELDS, H3_TEXT_EDIT_FIELDS } from "./narrative-edits.js";

/** Shared MCP declarations: server and browser manifest advertise identical contracts. */
export const H3_UPDATE_CLIPS_TOOL = {
    id: "h3_update_clips",
    version: "1.3.0",
    name: "H3 批量更新片段配置",
    description: "一次原子事务更新同一 H3 节点的多个已有 Clip 保存稿。内联模式必填稳定 operationId 和 expectedRevision；响应未知时用相同 ID、基线和内容恢复回执，冲突不自动 rebase。已有修改稿文件继续用冻结 preparedId，不能覆盖其操作 ID。内联 updates 兼容完整 patch/精确 edits+expectedMatches；dryRun=true 不写入。只改保存稿，不生成或改运行历史。成功只返回目标 ID、变更字段和摘要。",
    inputJsonSchema: {
        type: "object",
        properties: {
            projectId: { type: "string", minLength: 1, description: "目标画布的精确 ID" },
            nodeId: { type: "string", minLength: 1, description: "目标 H3 节点的精确 ID" },
            operationId: { type: "string", minLength: 1, description: "内联提交必填的稳定 ID；preparedId 模式使用冻结方案内的 ID" },
            expectedRevision: { type: "integer", minimum: 0, description: "内联提交必填的读取 revision；与冻结方案内 revision 不符则拒绝" },
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
        allOf: [
            { if: { required: ["updates"] }, then: { required: ["operationId", "expectedRevision"] } },
            { if: { required: ["preparedId"] }, then: { not: { anyOf: [{ required: ["operationId"] }, { required: ["expectedRevision"] }] } } },
        ],
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
    id: "h3_get_clip", version: "1.5.0", name: "H3 读取片段总览",
    description: "按稳定 segmentId 和 revision 读取 H3 Clip 轻量状态。默认只读保存字段摘要，不编译提示词或参考；需要编译结果/引用校验时显式 include:prompt 或 include:references。fields 只读指定叙事字段；include 可合并读取提示词、参考、运行参数或结果。",
    inputJsonSchema: {
        type: "object",
        properties: {
            projectId: { type: "string" }, nodeId: { type: "string" }, segmentId: { type: "string" },
            include: { type: "array", items: { type: "string", enum: ["prompt", "references", "runtime", "result"] }, uniqueItems: true },
            taskId: { type: "string", minLength: 1, description: "include:result 时核对的精确历史/当前任务 ID；省略从 Clip 的结果记录解析" },
            storageKey: { type: "string", minLength: 1, description: "include:result 时核对的精确归档视频；必须属于此 Clip 和任务，不按目录最新文件猜测" },
            fields: { type: "array", minItems: 1, maxItems: H3_NARRATIVE_FIELDS.length, items: { type: "string", enum: H3_NARRATIVE_FIELDS }, uniqueItems: true },
        }, required: ["projectId", "nodeId", "segmentId"],
    },
    annotations: { title: "H3 读取片段总览", readOnlyHint: true },
} as const;


/** Jointly prepare the final candidate, avoiding transient broken prompt/reference numbering. */
export const H3_PREPARE_CLIP_TOOL = {
    id: "h3_prepare_clip", version: "1.0.0", name: "H3 原子准备片段",
    description: "一次准备同一 Clip 的正文配置、角色选择与参考绑定；只编译最终候选，全部通过才在现有 ops 事务保存，失败不留中间状态、不生成。dryRun=true 返回预览且零写入；expectedRevision 防过期基线，提交期间 revision 变化整笔拒绝、不自动 rebase。可明确 inheritFromSegmentId 沿用已完成片段参数；省略兼容现有最近已完成段继承行为，正文和时长只按 patch 指定值修改。characters 只接受当前 character 节点中真实服装 storageKey，普通图片不能充当服装。",
    inputJsonSchema: {
        type: "object",
        properties: {
            projectId: { type: "string", minLength: 1, description: "精确画布 ID" },
            nodeId: { type: "string", minLength: 1, description: "精确 H3 节点 ID" },
            segmentId: { type: "string", minLength: 1, description: "当前 Clip 稳定 ID" },
            expectedRevision: { type: "integer", minimum: 0, description: "读取基线；不符则不提交" },
            dryRun: { type: "boolean", description: "true 仅编译最终候选，零画布写入" },
            inheritFromSegmentId: { type: "string", minLength: 1, description: "显式已完成继承来源；不存在或未完成则拒绝" },
            patch: { type: "object", minProperties: 1, additionalProperties: true, description: "正文/配置增量；不能改 id、角色组、参考绑定或 Backend 运行字段" },
            referenceBindings: { type: "array", description: "完整非角色参考绑定；必须有稳定 id 和 assetId，角色绑定由角色组派生", items: { type: "object", additionalProperties: true } },
            characters: { type: "array", minItems: 1, description: "当前 Clip 的已有角色选图，不创建角色", items: {
                type: "object", properties: {
                    characterNodeId: { type: "string", minLength: 1 },
                    selectedOutfitStorageKeys: { type: "array", minItems: 1, items: { type: "string", minLength: 1 }, uniqueItems: true },
                    subjectId: { type: "string", minLength: 1 }, voiceEnabled: { type: "boolean" },
                }, required: ["characterNodeId", "selectedOutfitStorageKeys"], additionalProperties: false,
            } },
        }, required: ["projectId", "nodeId", "segmentId"],
        anyOf: [{ required: ["patch"] }, { required: ["characters"] }, { required: ["referenceBindings"] }, { required: ["inheritFromSegmentId"] }],
        additionalProperties: false,
    },
    annotations: { title: "H3 原子准备片段", readOnlyHint: false },
} as const;
