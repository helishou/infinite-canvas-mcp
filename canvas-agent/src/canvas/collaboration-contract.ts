import { z } from "zod";

export const textTargetSchema = z.object({
    nodeId: z.string().optional(), segmentId: z.string().optional(), textItemId: z.string().optional(),
    field: z.enum(["prompt", "content", "composerContent", "globalPrompt"]),
});
const targetInput = z.object({ projectId: z.string().min(1), target: textTargetSchema });
const textWriteInput = targetInput.extend({
    operationId: z.string().min(1).describe("一次逻辑请求的稳定 ID；重试必须原样复用，不能修改参数"),
    documentId: z.string().min(1).describe("canvas_read_text 返回的文档身份；删除重建后须重新读取"),
});
export const textSuggestionInputSchema = z.object({ id: z.string().min(1), target: textTargetSchema, documentId: z.string().min(1), base: z.string(), text: z.string().min(1) });
export type CanvasTextSuggestion = z.infer<typeof textSuggestionInputSchema> & { status: "pending" | "applied" | "dismissed"; revision: number };
export const collaborationToolNames = ["canvas_get_collaboration_state", "canvas_read_text", "canvas_apply_commands", "canvas_edit_text", "canvas_replace_text", "canvas_list_text_suggestions", "canvas_save_text_suggestion", "canvas_resolve_text_suggestion"] as const;
export type CollaborationToolName = typeof collaborationToolNames[number];
export const isCollaborationTool = (name: string): name is CollaborationToolName => (collaborationToolNames as readonly string[]).includes(name);
export const collaborationSchemas = {
    canvas_get_collaboration_state: z.object({ projectId: z.string().min(1) }),
    canvas_read_text: targetInput,
    canvas_apply_commands: z.object({ projectId: z.string().min(1), operationId: z.string().min(1), baseRevision: z.number().int().nonnegative(), operations: z.array(z.record(z.unknown())).nonempty() }),
    canvas_edit_text: textWriteInput.extend({
        baseState: z.string().min(1).describe("canvas_read_text 返回的 state，必须保持原样"),
        edits: z.array(z.object({ index: z.number().int().nonnegative(), deleteCount: z.number().int().nonnegative(), insert: z.string() })).nonempty(),
    }),
    canvas_replace_text: textWriteInput.extend({ expectedText: z.string(), text: z.string() }),
    canvas_list_text_suggestions: z.object({ projectId: z.string().min(1), target: textTargetSchema.optional() }),
    canvas_save_text_suggestion: z.object({ projectId: z.string().min(1), operationId: z.string().min(1), suggestion: textSuggestionInputSchema }),
    canvas_resolve_text_suggestion: z.object({ projectId: z.string().min(1), operationId: z.string().min(1), id: z.string().min(1), action: z.enum(["apply", "dismiss"]), documentId: z.string().min(1).optional(), expectedText: z.string().optional() }),
};
export const collaborationDescriptions: Record<CollaborationToolName, string> = {
    canvas_get_collaboration_state: "读取 revision、在线协作者和协议能力；不依赖网页或 Agent 面板在线。",
    canvas_read_text: "读取完整协作文本、documentId 和 Yjs state；支持项目、节点、Clip 和批量文本项。修改前须读取对应目标。",
    canvas_apply_commands: "统一命令事务，baseRevision 按字段检查并发。重试复用 operationId 和完整请求，不发送整图快照。",
    canvas_edit_text: "在读取的 baseState 上按 UTF-16 索引依次局部编辑，Yjs 增量合并协作者文字；必须传原 documentId。重试复用全部参数。",
    canvas_replace_text: "安全整段替换/采用 AI 改写：事务内检查 documentId 和 expectedText。原文变化则拒绝覆盖，应将结果保留为候选供用户确认。",
    canvas_list_text_suggestions: "读取 Backend 持久化的改写候选，包括已采用/已忽略记录；可按目标筛选，不依赖网页在线。",
    canvas_save_text_suggestion: "保存 AI 改写候选，不改变原文。绑定调用时的目标、documentId 和原文 base；重试保持 operationId/id 和内容不变。",
    canvas_resolve_text_suggestion: "忽略或采用持久候选。采用需当前 documentId 与 expectedText，事务内同时更新文本和候选状态；并发修改或目标重建时保留候选并拒绝覆盖。",
};
