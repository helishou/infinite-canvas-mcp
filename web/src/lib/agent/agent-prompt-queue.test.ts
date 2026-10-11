import assert from "node:assert/strict";
import test from "node:test";

import {
    claimNextAgentPrompt,
    enqueueAgentPrompt,
    moveAgentPromptToFront,
    removeAgentPrompt,
    updateAgentPrompt,
    type AgentPromptQueueItem,
} from "./agent-prompt-queue.js";

type Prompt = AgentPromptQueueItem<string>;

const prompt = (id: string, threadId = "t1", conversationId = "c1", status: Prompt["status"] = "queued"): Prompt => ({
    id, threadId, conversationId, payload: id, status,
});

test("enqueue appends without mutating the existing queue", () => {
    const queue = [prompt("a")];
    const next = enqueueAgentPrompt(queue, prompt("b"));
    assert.deepEqual(next.map((item) => item.id), ["a", "b"]);
    assert.deepEqual(queue.map((item) => item.id), ["a"]);
});

test("move-to-front only promotes inside the target item's conversation and keeps global order semantics", () => {
    const queue = [prompt("a"), prompt("other", "t2", "c2"), prompt("b")];
    const next = moveAgentPromptToFront(queue, "b");
    assert.deepEqual(next.map((item) => item.id), ["b", "other", "a"]);
    assert.deepEqual(queue.map((item) => item.id), ["a", "other", "b"]);
});

test("remove deletes only the requested queued item", () => {
    assert.deepEqual(removeAgentPrompt([prompt("a"), prompt("b")], "a").map((item) => item.id), ["b"]);
});

test("claim returns the first queued item for the requested conversation and marks it sending", () => {
    const queue = [prompt("other", "t2", "c2"), prompt("a"), prompt("b")];
    const result = claimNextAgentPrompt(queue, "t1", "c1");
    assert.equal(result.item?.id, "a");
    assert.equal(result.queue.find((item) => item.id === "a")?.status, "sending");
    assert.equal(queue[1].status, "queued");
});

test("claim refuses a second send while this conversation already has an in-flight item", () => {
    const queue = [prompt("sending", "t1", "c1", "sending"), prompt("next")];
    const result = claimNextAgentPrompt(queue, "t1", "c1");
    assert.equal(result.item, null);
    assert.deepEqual(result.queue, queue);
});

test("status update changes only the addressed queue item", () => {
    const queue = [prompt("a"), prompt("b")];
    const next = updateAgentPrompt(queue, "b", "failed", "interrupt rejected");
    assert.equal(next[0].status, "queued");
    assert.equal(next[1].status, "failed");
    assert.equal(next[1].error, "interrupt rejected");
});
