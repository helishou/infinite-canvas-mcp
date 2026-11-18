import type { AgentModel } from "@/stores/use-agent-store";

export type AgentEngine = "hermes" | "codex";

/**
 * 模型的 runtime 归一到"渠道"。codex-cli 与原生 codex 都算 codex 渠道；
 * hermes 算 hermes 渠道；llm（旧目录行）或无 runtime 的返回空，不参与记忆。
 */
export function modelEngine(model: AgentModel | undefined): AgentEngine | "" {
    const runtime = model?.runtime;
    if (runtime === "hermes") return "hermes";
    if (runtime === "codex") return "codex";
    return "";
}

/**
 * 按选择的渠道 + 每渠道记住的模型，算出该渠道下应该选中的模型 id。
 * 记住的模型若已不在可用列表（换配置/删渠道）则回落 catalog 的 isDefault 或第一项。
 */
export function rememberedModelForEngine(
    models: readonly AgentModel[],
    engine: AgentEngine | "",
    byEngine: Partial<Record<AgentEngine, string>> | undefined,
    fallbackModel?: string,
): string {
    const inEngine = engine ? models.filter((model) => modelEngine(model) === engine) : models;
    if (!inEngine.length) return "";
    const remembered = engine ? byEngine?.[engine] : undefined;
    if (remembered && inEngine.some((model) => model.model === remembered)) return remembered;
    // 没有该渠道的记忆时，若全局上次模型本就属于该渠道则沿用它，避免跳到默认模型。
    if (fallbackModel && inEngine.some((model) => model.model === fallbackModel)) return fallbackModel;
    return inEngine.find((model) => model.isDefault)?.model || inEngine[0].model;
}

/** 把某模型记到它所属渠道；返回更新后的 map（不可变）。runtime 不认识时原样返回。 */
export function rememberModelByEngine(
    byEngine: Partial<Record<AgentEngine, string>> | undefined,
    model: AgentModel | undefined,
): Partial<Record<AgentEngine, string>> {
    const engine = modelEngine(model);
    if (!engine || !model) return byEngine || {};
    return { ...(byEngine || {}), [engine]: model.model };
}

/** 当前 thread 的 runtime 与新选渠道是否冲突（冲突需要新建对话）。 */
export function engineMismatch(currentThreadId: string, wantedEngine: AgentEngine | ""): boolean {
    if (!wantedEngine || !currentThreadId) return false;
    const current: AgentEngine = currentThreadId.startsWith("hermes-") ? "hermes" : "codex";
    return current !== wantedEngine;
}
