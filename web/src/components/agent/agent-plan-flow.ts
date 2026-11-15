/**
 * 「总流程」清单的纯数据层：不碰 store、不碰 i18n，方便 node:test 直接断言。
 *
 * 计划消息（detail.kind === "todo"）里的 tasks 是模型给的步骤；这里只做解析、编号与状态归类，
 * 渲染和文案都留在组件里。
 */
export type AgentPlanFlow = { steps: Array<{ step: string; status: string }>; explanation: string; status: string };

export type AgentPlanRow = {
    /** 面板上显示的序号，从 1 开始 */
    index: number;
    label: string;
    tone: "done" | "running" | "pending";
    /** i18n key：agent.message.completed / running / notStarted */
    statusKey: string;
};

type PlanMessageLike = { role?: string; detail?: unknown };

function recordOf(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function planFlowOf(message: PlanMessageLike | null | undefined): AgentPlanFlow | null {
    const detail = recordOf(message?.detail);
    if (!message || message.role !== "tool" || !detail || detail.kind !== "todo") return null;
    const tasks = Array.isArray(detail.tasks) ? detail.tasks : [];
    const steps = tasks.flatMap((item) => {
        const task = recordOf(item);
        const step = String(task?.step || "").trim();
        return step ? [{ step, status: String(task?.status || "pending") }] : [];
    });
    if (!steps.length) return null;
    return { steps, explanation: String(detail.explanation || "").trim(), status: String(detail.status || "inProgress") };
}

export function planFlowRows(flow: AgentPlanFlow | null): AgentPlanRow[] {
    if (!flow) return [];
    return flow.steps.map((step, order) => {
        const tone = step.status === "completed" ? "done" : step.status === "inProgress" ? "running" : "pending";
        return {
            index: order + 1,
            label: step.step,
            tone,
            statusKey: tone === "done" ? "agent.message.completed" : tone === "running" ? "agent.message.running" : "agent.message.notStarted",
        };
    });
}
