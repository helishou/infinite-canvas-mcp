import { useAgentStore } from "@/stores/use-agent-store";
export { planningPrompt, type PlanningLaunchScope } from "./planning-director-prompt";

export type PlanningLaunchBlocked = "busy" | "offline" | "ok";

/** 起一条新的导演对话并把提示词送进去（复用现有 creativeLaunch 通道）。 */
export function launchPlanningDirector(text: string): PlanningLaunchBlocked {
    const agent = useAgentStore.getState();
    const ready = agent.enabled && agent.connected && ["ready", "warning"].includes(agent.conversation.status);
    agent.openPanel();
    if (!ready) {
        agent.setAgentState({ activeTab: "setup" });
        return "offline";
    }
    if (agent.sending || agent.waiting || agent.creativeLaunch) return "busy";
    agent.setAgentState({
        activeTab: "chat",
        creativeLaunch: { id: `planning-${Date.now()}`, mode: "drama", text, phase: "reset" },
    });
    return "ok";
}
