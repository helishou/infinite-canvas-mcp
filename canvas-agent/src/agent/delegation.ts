import { z } from "zod";
import type { DirectorAdoption } from "./work-package.js";

// Scene-work tools advance a fixed formal production pipeline. Free-form advisory
// delegation cannot reuse that entry without changing its review/write semantics.
export const DIRECTOR_SUBAGENT_KIND = "director-subagent";
export const directorSubagentSchema = z.object({
    action: z.enum(["spawn", "list", "get", "continue", "recover"]).describe("spawn 派发；continue 续写 partial；recover 只读原已完成回合；list/get 查看任务与产物"),
    projectId: z.string().min(1).describe("当前制作画布 ID；不得使用其他画布的身份"),
    parentThreadId: z.string().min(1).describe("当前主导演线程 ID，使用本轮委派上下文提供的身份"),
    parentTurnId: z.string().min(1).optional().describe("主导演本轮真实 turn ID；未知则省略，不猜测"),
    operationId: z.string().min(1).optional().describe("spawn 必填；同一请求重放沿用原 operationId，不重新运行"),
    title: z.string().trim().min(1).optional().describe("spawn 必填；给用户看的简短子任务名"),
    role: z.enum(["story", "shots", "assets", "continuity", "review"]).optional().describe("spawn 必填；专业分工"),
    prompt: z.string().trim().min(1).optional().describe("spawn 必填；完整、独立的任务与交付要求"),
    context: z.string().optional().describe("冻结的源稿、事实、参考说明；子代理不读取其他会话，也不改业务数据"),
    production: z.object({ kind: z.enum(["episode", "canvas"]), id: z.string().min(1), expectedRevision: z.number().int().nonnegative(), scope: z.object({ sceneId: z.string().min(1).optional(), targetIds: z.array(z.string().min(1)).min(1).optional() }).strict().refine(scope => Boolean(scope.sceneId || scope.targetIds?.length), "范围不能为空").optional() }).strict().optional().describe("绑定正式 draft，由 Backend 冻结输入；省略时为 unbound 建议，不可登记正式采纳"),
    artifactHash: z.string().optional().describe("get 定向读取历史不可变产物"),
    contentDeliveryMode: z.enum(["auto_file_batch", "interactive_segment"]).optional().describe("仅 unbound spawn 可指定；正式稿使用已保存模式"),
    continuationIntent: z.enum(["automatic", "explicit"]).optional().describe("continue 默认 automatic；交互模式必须 explicit，表示本轮用户明确要求继续；不扩大原授权"),
    model: z.string().min(1).optional().describe("省略时沿用当前导演渠道；不随意更换模型"),
    effort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]).optional(),
    taskId: z.string().min(1).optional().describe("get 必填；spawn 回执中的 taskId"),
    view: z.enum(["summary", "result"]).default("summary"),
    limit: z.number().int().positive().optional(),
    offset: z.number().int().nonnegative().optional(),
    chunkBytes: z.number().int().positive().optional().describe("结果长时按 UTF-8 字节分块读取，配合返回 cursor 读完；不静默截断"),
    cursor: z.string().optional(),
}).strict();
export type DirectorSubagentInput = z.infer<typeof directorSubagentSchema>;
export type DirectorSubagentSummary = {
    taskId: string; projectId: string; parentThreadId: string; parentTurnId?: string;
    title: string; role: string; status: string; model?: string;
    sourceRevision: number; createdAt: string; updatedAt: string; error: string | null;
    outcome?: string; resultAvailable: boolean;
    binding?: "bound" | "unbound"; validity?: "current" | "stale"; artifactHash?: string;
    adoption?: DirectorAdoption;
    contentDeliveryMode?: "auto_file_batch" | "interactive_segment";
    recoverable?: boolean;
};
export type DirectorSubagentResult = { status: "complete" | "partial" | "needs_human"; summary: string; content: string; unresolved: string[]; cursor?: string };
export const directorSubagentDescription = "导演委派统一入口。spawn 给 operationId/title/role/prompt；已有正式稿带 production.kind/id/expectedRevision/scope，由 Backend 冻结 draft 和专业合同，context 仅补充。子代理只返回建议，不写业务数据、不生成。收到 taskId 用 canvas_wait_tasks 等待，get/view=result 按 artifactHash/chunkBytes/cursor 读取完整产物；complete 且无未决项经主导演核对后用 production_edit.ops+adoptions 原子采纳。partial 用 continue/taskId/operationId 沿原线程续写，遵循原交付模式与授权；recover 只读原已完成回合，不重跑。unbound/partial/stale 不登记正式采纳。默认摘要不包含正文。";
export function executeDirectorSubagentTool(backend: { post: (path: string, body: unknown) => Promise<unknown> }, raw: unknown) {
    return backend.post("/director/subagents", directorSubagentSchema.parse(raw));
}
