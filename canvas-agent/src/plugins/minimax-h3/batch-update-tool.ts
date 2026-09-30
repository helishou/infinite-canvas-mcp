/** Shared MCP declaration: server and browser manifest must advertise the same batch contract. */
export const H3_UPDATE_CLIPS_TOOL = {
    id: "h3_update_clips",
    version: "1.0.0",
    name: "H3 批量更新片段配置",
    description: "一次原子事务更新同一 H3 节点的多个已有 Clip，保持输入顺序；整批预检失败、活动任务或版本冲突时不写入。只改配置不生成，不允许角色组或后台运行字段。节点级参数投影按输入顺序逐字段最后写入生效。返回实际提交字段的短值/摘要，不返回整图；长文本和对象以 JSON 序列化值的 SHA-256 摘要核对。",
    inputJsonSchema: {
        type: "object",
        properties: {
            projectId: { type: "string", minLength: 1, description: "目标画布的精确 ID" },
            nodeId: { type: "string", minLength: 1, description: "目标 H3 节点的精确 ID" },
            expectedRevision: { type: "integer", minimum: 0, description: "可选：调用方读取的 revision；与当前画布不符则拒绝整批" },
            updates: {
                type: "array", minItems: 1, maxItems: 100,
                description: "每个 Clip 一项；不能有重复 segmentId，关联字段合进同一个 patch",
                items: {
                    type: "object",
                    properties: {
                        segmentId: { type: "string", minLength: 1, description: "h3_get_node 返回的当前稳定 Clip ID" },
                        patch: { type: "object", minProperties: 1, additionalProperties: true, description: "本段配置增量；禁止 id、角色组、运行状态及结果字段" },
                    },
                    required: ["segmentId", "patch"],
                    additionalProperties: false,
                },
            },
        },
        required: ["projectId", "nodeId", "updates"],
        additionalProperties: false,
    },
    annotations: { title: "H3 批量更新片段配置", readOnlyHint: false },
} as const;
