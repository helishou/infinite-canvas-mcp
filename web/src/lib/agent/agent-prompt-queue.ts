export type AgentPromptQueueStatus = "queued" | "interrupting" | "sending" | "failed";

export type AgentPromptQueueItem<Payload = unknown> = {
    id: string;
    threadId: string;
    conversationId: string;
    payload: Payload;
    status: AgentPromptQueueStatus;
    error?: string;
};

function sameConversation<Payload>(item: AgentPromptQueueItem<Payload>, threadId: string, conversationId: string) {
    return item.threadId === threadId && item.conversationId === conversationId;
}

export function enqueueAgentPrompt<Payload>(queue: AgentPromptQueueItem<Payload>[], item: AgentPromptQueueItem<Payload>) {
    return [...queue, item];
}

/** Promote an item to the first slot belonging to its own conversation, preserving every other slot. */
export function moveAgentPromptToFront<Payload>(queue: AgentPromptQueueItem<Payload>[], id: string) {
    const target = queue.find((item) => item.id === id);
    if (!target || target.status !== "queued") return [...queue];

    const scopedIndices = queue.flatMap((item, index) => sameConversation(item, target.threadId, target.conversationId) ? [index] : []);
    const scopedItems = scopedIndices.map((index) => queue[index]);
    const targetIndex = scopedItems.findIndex((item) => item.id === id);
    if (targetIndex <= 0) return [...queue];

    const reordered = [...scopedItems];
    const [selected] = reordered.splice(targetIndex, 1);
    reordered.unshift(selected);
    const next = [...queue];
    scopedIndices.forEach((index, scopedIndex) => { next[index] = reordered[scopedIndex]; });
    return next;
}

export function removeAgentPrompt<Payload>(queue: AgentPromptQueueItem<Payload>[], id: string) {
    return queue.filter((item) => item.id !== id);
}

export function claimNextAgentPrompt<Payload>(queue: AgentPromptQueueItem<Payload>[], threadId: string, conversationId: string) {
    const inFlight = queue.some((item) => sameConversation(item, threadId, conversationId) && (item.status === "sending" || item.status === "interrupting"));
    if (inFlight) return { item: null, queue: [...queue] };

    const item = queue.find((candidate) => sameConversation(candidate, threadId, conversationId) && candidate.status === "queued");
    if (!item) return { item: null, queue: [...queue] };

    const claimed = { ...item, status: "sending" as const, error: undefined };
    return { item: claimed, queue: queue.map((candidate) => candidate.id === item.id ? claimed : candidate) };
}

export function updateAgentPrompt<Payload>(queue: AgentPromptQueueItem<Payload>[], id: string, status: AgentPromptQueueStatus, error?: string) {
    return queue.map((item) => item.id === id ? { ...item, status, error: status === "failed" ? error : undefined } : item);
}
