import assert from "node:assert/strict";
import test from "node:test";
import localforage from "localforage";
import type { AgentQueuedPrompt } from "./use-agent-store.js";

const values = new Map<string, unknown>();
let failWrites = false;
localforage.createInstance = (() => ({
    getItem: async (key: string) => structuredClone(values.get(key) ?? null),
    setItem: async (key: string, value: unknown) => {
        if (failWrites) throw new Error("storage unavailable");
        values.set(key, structuredClone(value));
        return value;
    },
})) as unknown as typeof localforage.createInstance;
const { useAgentStore, hydrateAgentPromptQueue, flushAgentPromptQueue } = await import("./use-agent-store.js");
const item = (id: string, status: AgentQueuedPrompt["status"] = "queued"): AgentQueuedPrompt => ({
    id, threadId: "thread", conversationId: "conversation", status,
    payload: { text: id, messageText: id, attachments: [], canvasReferences: [], canvasProjectId: "canvas", model: "model", reasoningEffort: "low", permissionMode: "request", productionObject: null },
});

test("queue recovery retains payloads, ordering and pause state without importing another client or endpoint", async () => {
    await hydrateAgentPromptQueue("http://a/agent", "owner");
    const image = { id: "image", name: "image.png", type: "image/png", size: 1, width: 1, height: 1, url: "data:image/png;base64,AA==", dataUrl: "data:image/png;base64,AA==" };
    const first = item("first"); first.payload.attachments = [image];
    useAgentStore.getState().updatePromptQueue(() => [first, item("second")]);
    useAgentStore.getState().setPromptQueuePaused("thread", "conversation", true);
    await flushAgentPromptQueue();
    await hydrateAgentPromptQueue("http://a/agent", "duplicate");
    assert.deepEqual(useAgentStore.getState().queuedPrompts, []);
    await hydrateAgentPromptQueue("http://b/agent", "owner");
    assert.deepEqual(useAgentStore.getState().queuedPrompts, []);
    await hydrateAgentPromptQueue("http://a/agent/", "owner");
    assert.deepEqual(useAgentStore.getState().queuedPrompts, [first, item("second")]);
    assert.deepEqual(useAgentStore.getState().pausedPromptQueueScopes, [JSON.stringify(["thread", "conversation"])]);
    useAgentStore.getState().updatePromptQueue((queue) => queue.slice(1));
    useAgentStore.getState().updatePromptQueue(() => []);
    await flushAgentPromptQueue();
    await hydrateAgentPromptQueue("http://b/agent", "owner");
    await hydrateAgentPromptQueue("http://a/agent", "owner");
    assert.deepEqual(useAgentStore.getState().queuedPrompts, [], "serialized writes cannot resurrect removed items");
});

test("sending and interrupting recovery retains uncertain messages and pauses their scope", async () => {
    values.set(JSON.stringify(["http://a/agent", "uncertain"]), { version: 1, queuedPrompts: [item("sent?", "sending"), item("interrupt?", "interrupting"), item("next")], pausedPromptQueueScopes: [] });
    await hydrateAgentPromptQueue("http://a/agent", "uncertain");
    const state = useAgentStore.getState();
    assert.deepEqual(state.queuedPrompts.map(({ status }) => status), ["failed", "failed", "queued"]);
    assert.ok(state.queuedPrompts[0].error);
    assert.deepEqual(state.pausedPromptQueueScopes, [JSON.stringify(["thread", "conversation"])]);
});

test("failed saves are observable and do not clear the draft; unknown snapshots are protected", async () => {
    useAgentStore.setState({ prompt: "keep my draft" });
    failWrites = true;
    useAgentStore.getState().updatePromptQueue((queue) => [...queue, item("unsaved")]);
    await assert.rejects(flushAgentPromptQueue(), /storage unavailable/);
    assert.equal(useAgentStore.getState().prompt, "keep my draft");
    failWrites = false;
    useAgentStore.getState().updatePromptQueue((queue) => [...queue]);
    await flushAgentPromptQueue();
    const key = JSON.stringify(["http://a/agent", "future"]);
    const unknown = { version: 2, queuedPrompts: [item("protected")] };
    values.set(key, unknown);
    await assert.rejects(hydrateAgentPromptQueue("http://a/agent", "future"));
    assert.equal(useAgentStore.getState().promptQueueHydrated, false);
    assert.deepEqual(values.get(key), unknown);
});
