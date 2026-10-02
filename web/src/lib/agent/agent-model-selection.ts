import type { AgentModel, AgentReasoningEffort } from "@/stores/use-agent-store";

/** Use the models reported by the connected Codex service, never a hardcoded catalog. */
export function selectAvailableAgentModel(models: AgentModel[], savedModel: string, savedEffort: AgentReasoningEffort | "") {
    const available = models.filter((item) => !item.hidden && Boolean(item.model) && Array.isArray(item.supportedReasoningEfforts));
    const selected = available.find((item) => item.model === savedModel) || available.find((item) => item.isDefault) || available[0];
    const efforts = selected?.supportedReasoningEfforts.map((item) => item.reasoningEffort) || [];
    return {
        models: available,
        model: selected?.model || "",
        reasoningEffort: efforts.includes(savedEffort as AgentReasoningEffort) ? savedEffort : efforts.includes(selected?.defaultReasoningEffort as AgentReasoningEffort) ? selected!.defaultReasoningEffort : efforts[0] || "",
    };
}
