import assert from "node:assert/strict";
import test from "node:test";

import { useAgentStore, type AgentQueuedPrompt } from "./use-agent-store.js";

const queueItem = (id: string, threadId = "thread-1", conversationId = "conversation-1"): AgentQueuedPrompt => ({
    id,
    threadId,
    conversationId,
    payload: {
        text: `prompt ${id}`,
        messageText: `prompt ${id}`,
        attachments: [],
        canvasReferences: [],
        canvasProjectId: "canvas-1",
        model: "model-1",
        reasoningEffort: "low",
        permissionMode: "request",
        productionObject: null,
    },
    status: "queued",
});

test("AgentStore starts with an empty, unpaused prompt queue", () => {
    const state = useAgentStore.getState();
    assert.deepEqual(state.queuedPrompts, []);
    assert.deepEqual(state.pausedPromptQueueScopes, []);
});

test("updating the queue does not alter the composer draft or production draft object", () => {
    const sentinelObject = { targetKind: "asset", canvasId: "canvas-1", title: "sentinel" } as never;
    const sentinelAttachments = [{ id: "file-1" }] as never;
    const sentinelReferences = [{ nodeId: "node-1" }] as never;
    useAgentStore.setState({
        prompt: "keep this draft",
        attachments: sentinelAttachments,
        canvasReferences: sentinelReferences,
        productionDraftObject: sentinelObject,
        queuedPrompts: [],
        pausedPromptQueueScopes: [],
    });

    const queued = queueItem("queued-1");
    useAgentStore.getState().updatePromptQueue((items) => [...items, queued]);

    const state = useAgentStore.getState();
    assert.equal(state.prompt, "keep this draft");
    assert.strictEqual(state.attachments, sentinelAttachments);
    assert.strictEqual(state.canvasReferences, sentinelReferences);
    assert.strictEqual(state.productionDraftObject, sentinelObject);
    assert.deepEqual(state.queuedPrompts.map((item) => item.id), ["queued-1"]);
});

test("deleting a thread clears only that thread's queued prompts and pause scopes", () => {
    useAgentStore.setState({
        queuedPrompts: [queueItem("a", "thread-1", "conversation-1"), queueItem("b", "thread-2", "conversation-2")],
        pausedPromptQueueScopes: [JSON.stringify(["thread-1", "conversation-1"]), JSON.stringify(["thread-1", "old-conversation"]), JSON.stringify(["thread-2", "conversation-2"])],
    });

    useAgentStore.getState().clearPromptQueueForThread("thread-1");

    const state = useAgentStore.getState();
    assert.deepEqual(state.queuedPrompts.map((item) => item.id), ["b"]);
    assert.deepEqual(state.pausedPromptQueueScopes, [JSON.stringify(["thread-2", "conversation-2"])]);
});