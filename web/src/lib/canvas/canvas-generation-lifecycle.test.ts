import assert from "node:assert/strict";
import test from "node:test";
import { abortCanvasGenerationRequestsByRunningId, finishCanvasGenerationRequest, startCanvasGenerationRequest } from "./canvas-generation-lifecycle";
import type { ActiveCanvasGenerationRequest } from "./canvas-generation-lifecycle";

function registry() {
    return new Map<string, ActiveCanvasGenerationRequest>();
}

test("starting a request for the same target aborts the previous controller and records its identities", () => {
    const requests = registry();
    const previous = new AbortController();
    const next = new AbortController();
    startCanvasGenerationRequest(requests, "target", "origin", "running", previous);
    const returned = startCanvasGenerationRequest(requests, "target", "origin-2", "running-2", next);

    assert.equal(previous.signal.aborted, true);
    assert.equal(returned, next);
    assert.deepEqual(requests.get("target"), { targetNodeId: "target", originNodeId: "origin-2", runningNodeId: "running-2", controller: next });
});

test("finishing a stale request does not remove the newer request for the same target", () => {
    const requests = registry();
    const oldController = new AbortController();
    const currentController = new AbortController();
    startCanvasGenerationRequest(requests, "target", "origin", "running", oldController);
    startCanvasGenerationRequest(requests, "target", "origin", "running", currentController);

    finishCanvasGenerationRequest(requests, "target", oldController);
    assert.equal(requests.get("target")?.controller, currentController);
    finishCanvasGenerationRequest(requests, "target", currentController);
    assert.equal(requests.has("target"), false);
});

test("stopping a running request aborts all matching controllers and returns affected target/origin IDs only", () => {
    const requests = registry();
    const first = new AbortController();
    const second = new AbortController();
    const unrelated = new AbortController();
    startCanvasGenerationRequest(requests, "target-a", "origin-a", "run-1", first);
    startCanvasGenerationRequest(requests, "target-b", "origin-b", "run-1", second);
    startCanvasGenerationRequest(requests, "target-c", "origin-c", "run-2", unrelated);

    const affected = abortCanvasGenerationRequestsByRunningId(requests, "run-1");
    assert.deepEqual([...affected].sort(), ["origin-a", "origin-b", "target-a", "target-b"]);
    assert.equal(first.signal.aborted, true);
    assert.equal(second.signal.aborted, true);
    assert.equal(unrelated.signal.aborted, false);
    assert.deepEqual([...requests.keys()].sort(), ["target-a", "target-b", "target-c"]);
    finishCanvasGenerationRequest(requests, "target-a", first);
    finishCanvasGenerationRequest(requests, "target-b", second);
    assert.deepEqual([...requests.keys()], ["target-c"]);
});

test("starting without explicit IDs or controller uses origin as the running identity", () => {
    const requests = registry();
    const controller = startCanvasGenerationRequest(requests, "target", "origin");
    assert.equal(requests.get("target")?.runningNodeId, "origin");
    assert.ok(controller instanceof AbortController);
});
