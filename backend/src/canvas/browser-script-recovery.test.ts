import assert from "node:assert/strict";
import test from "node:test";
import { BackendDatabase } from "../db.js";
import { BackendEventBus } from "../events.js";
import { createStores } from "../stores/index.js";
import { CanvasBrowserScriptDispatcher } from "./browser-script-dispatcher.js";
import { CanvasTextDispatcher } from "./text-dispatcher.js";

function fixture(t: import("node:test").TestContext, mode: "text" | "image" = "text", claim = true) {
    const db = new BackendDatabase(":memory:"); t.after(() => db.close());
    db.createCanvasProject({ id: "recovery-p", nodes: [{ id: "source", type: "config", title: "text", position: { x: 0, y: 0 }, width: 320, height: 200, metadata: {} }], connections: [] });
    const stores = createStores(db), events = new BackendEventBus();
    const text = new CanvasTextDispatcher({ url: "http://unused.local" } as never, stores, async () => { throw new Error("No provider call permitted"); });
    const dispatcher = new CanvasBrowserScriptDispatcher(stores, events, text);
    const input = { mode, projectId: "recovery-p", nodeId: "source", model: "c::custom-text", prompt: "mock", clientTaskId: "recovery-task" };
    const id = dispatcher.start(input, "return 'mock'").taskId;
    const token = claim ? dispatcher.claim(id, "worker").claimToken : "";
    const checkpoint = (phase: string, extra: Record<string, unknown> = {}) => dispatcher.checkpoint(id, "worker", token, { version: 1, phase, cacheOwner: "cache-worker", providerFingerprint: "a".repeat(64), ...extra });
    return { db, stores, events, text, dispatcher, id, token, checkpoint };
}
const externalTask = { id: "provider-job", provider: "openai", model: "mock-model", parameters: { seconds: "8" } };

test("checkpoint persistence must succeed before submission; failed checkpoint grants no permission", t => {
    const { stores, dispatcher, id, token, checkpoint } = fixture(t);
    const update = stores.tasks.update;
    stores.tasks.update = () => { throw new Error("mock database write failed"); };
    let paidCalls = 0;
    assert.throws(() => { checkpoint("submitting"); paidCalls++; }, /database write failed/);
    assert.equal(paidCalls, 0);
    stores.tasks.update = update;
    assert.equal(stores.tasks.get(id)!.result, null);
    checkpoint("submitting"); paidCalls++;
    checkpoint("submitting"); // retrying a lost acknowledgement under the same claim is idempotent
    assert.equal(paidCalls, 1);
    dispatcher.release(id, "worker", token);
    assert.equal(stores.tasks.get(id)!.status, "running");
    assert.throws(() => dispatcher.retry(stores.tasks.get(id)!), /不能重新提交/);
});

test("provider receipts survive release and restart, retry retains original id and rejects stale workers", t => {
    const { stores, dispatcher, id, token, checkpoint, events, text } = fixture(t);
    checkpoint("submitting"); checkpoint("external_task", { externalTask });
    dispatcher.release(id, "worker", token);
    const newToken = dispatcher.claim(id, "worker").claimToken;
    assert.notEqual(newToken, token);
    assert.throws(() => dispatcher.checkpoint(id, "worker", token, { version: 1, phase: "result_available", cacheOwner: "old" }), /认领已失效/);
    assert.throws(() => dispatcher.complete(id, "worker", { texts: ["late"] }, token), /认领已失效/);
    assert.throws(() => dispatcher.release(id, "worker", token), /认领已失效/);
    assert.equal(dispatcher.retry(stores.tasks.get(id)!).id, id);
    const restarted = new CanvasBrowserScriptDispatcher(stores, events, text);
    restarted.resume(stores.tasks.get(id)!);
    const claim = restarted.claim(id, "other-worker");
    assert.notEqual(claim.claimToken, newToken);
    assert.equal((claim.task.result!.browserRecovery as any).externalTask.id, "provider-job");
    assert.throws(() => restarted.checkpoint(id, "other-worker", claim.claimToken, { version: 1, phase: "submitting", cacheOwner: "cache-worker", providerFingerprint: "a".repeat(64) }), /退回|只能恢复/);
    assert.equal(restarted.retry(stores.tasks.get(id)!).id, id);
});

test("double claim, missing nonce, downgrade, identity replacement and secrets are guarded", t => {
    const { dispatcher, id, token, checkpoint } = fixture(t);
    assert.equal(dispatcher.claim(id, "worker").claimToken, token);
    assert.throws(() => dispatcher.claim(id, "worker-2"), /另一个浏览器/);
    assert.throws(() => dispatcher.checkpoint(id, "worker", "", { version: 1, phase: "submitting", cacheOwner: "cache" }), /认领已失效/);
    assert.throws(() => checkpoint("external_task", { externalTask }), /缺少提交前/);
    checkpoint("submitting");
    const stored = checkpoint("external_task", { externalTask: { ...externalTask, apiKey: "private", parameters: { seconds: "8", apiKey: "private" } }, config: { apiKey: "private" }, url: "https://private.invalid" });
    assert.doesNotMatch(JSON.stringify(stored.result), /private|apiKey|claimToken/);
    assert.throws(() => checkpoint("external_task", { externalTask: { ...externalTask, id: "different-job" } }), /身份不能替换/);
    assert.throws(() => checkpoint("submitting"), /退回/);
    assert.throws(() => checkpoint("result_available", { cacheOwner: "different-connection" }), /另一连接身份/);
    assert.throws(() => checkpoint("result_available", { providerFingerprint: "b".repeat(64) }), /渠道身份已改变/);
});

test("unknown failure/cancel/restart preserve running and legacy failures cannot incur a fresh generation", t => {
    const { stores, dispatcher, id, token, checkpoint } = fixture(t);
    checkpoint("submitting");
    const unknown = dispatcher.fail(id, "worker", "fetch failed with private-api-key", token);
    assert.equal(unknown.status, "running"); assert.doesNotMatch(unknown.error || "", /private-api-key/);
    assert.equal(dispatcher.cancel(id).status, "running");
    dispatcher.resume(stores.tasks.get(id)!);
    assert.throws(() => dispatcher.retry(stores.tasks.get(id)!), /不能重新提交/);
    stores.tasks.update(id, { status: "failed", result: null, error: "legacy network failure" });
    assert.throws(() => dispatcher.retry(stores.tasks.get(id)!), /不能重新提交/);
});

test("confirmed provider failure alone permits a new retry; completed result does not", t => {
    const { stores, dispatcher, id, token, checkpoint } = fixture(t);
    checkpoint("submitting"); checkpoint("external_task", { externalTask });
    const failed = dispatcher.fail(id, "worker", "provider failed", token, true);
    assert.equal((failed.result!.browserRecovery as any).terminalConfirmed, true);
    const retried = dispatcher.retry(failed); assert.notEqual(retried.id, id);
    const claim = dispatcher.claim(retried.id, "worker");
    const completed = dispatcher.complete(retried.id, "worker", { texts: ["mock result"] }, claim.claimToken);
    assert.equal(completed.status, "succeeded");
    assert.throws(() => dispatcher.retry(stores.tasks.get(retried.id)!), /已完成/);
});

test("archived text receipt is validated and restored under the same task", t => {
    const { stores, dispatcher, id, token, checkpoint } = fixture(t);
    checkpoint("submitting"); checkpoint("result_available");
    assert.throws(() => checkpoint("archived", { output: { texts: [{ config: "not-text" }] } }), /缺少文本/);
    checkpoint("archived", { output: { texts: ["saved result"], apiKey: "private" } });
    dispatcher.release(id, "worker", token);
    const retried = dispatcher.retry(stores.tasks.get(id)!);
    assert.equal(retried.id, id);
    assert.deepEqual((retried.result!.browserRecovery as any).output, { texts: ["saved result"] });
    assert.doesNotMatch(JSON.stringify(retried.result), /private/);
});

test("a saved result cannot be relabelled provider failure to permit another charge", t => {
    const { stores, dispatcher, id, token, checkpoint } = fixture(t);
    checkpoint("submitting"); checkpoint("result_available");
    const task = dispatcher.fail(id, "worker", "archive failure", token, true);
    assert.equal(task.status, "running");
    assert.notEqual((task.result!.browserRecovery as any).terminalConfirmed, true);
    assert.equal(dispatcher.retry(stores.tasks.get(id)!).id, id);
});

test("elapsed wall time is not permission to steal a live claim or submit again", t => {
    const { dispatcher, id, token, checkpoint } = fixture(t);
    checkpoint("submitting");
    t.mock.method(Date, "now", () => Number.MAX_SAFE_INTEGER);
    assert.equal(dispatcher.claim(id, "worker").claimToken, token);
    assert.throws(() => dispatcher.claim(id, "another-worker"), /另一个浏览器/);
});

test("restarted legacy running task stays unknown and invalidates all old claim nonces", t => {
    const { stores, dispatcher, id, token, events, text } = fixture(t);
    const restarted = new CanvasBrowserScriptDispatcher(stores, events, text);
    restarted.resume(stores.tasks.get(id)!);
    const task = stores.tasks.get(id)!;
    assert.equal(task.status, "running");
    assert.equal((task.result!.browserRecovery as any).legacyUnknown, true);
    const newClaim = restarted.claim(id, "worker"); assert.notEqual(newClaim.claimToken, token);
    assert.throws(() => restarted.complete(id, "worker", { texts: ["late"] }, token), /认领已失效/);
    assert.throws(() => restarted.retry(task), /不能重新提交/);
    assert.throws(() => restarted.checkpoint(id, "worker", newClaim.claimToken, { version: 1, phase: "submitting", cacheOwner: "cache-worker", providerFingerprint: "a".repeat(64) }), /只能恢复/);
});

test("canvas writeback acknowledged before a failed task commit is not applied twice on recovery", t => {
    const { stores, dispatcher, id, token, checkpoint } = fixture(t);
    checkpoint("submitting"); checkpoint("archived", { output: { texts: ["saved authoritative result"] } });
    const update = stores.tasks.update;
    stores.tasks.update = (taskId, patch) => { if (patch.status === "succeeded") throw new Error("mock status commit failed"); return update(taskId, patch); };
    assert.throws(() => dispatcher.complete(id, "worker", { texts: ["ignored client replacement"] }, token), /status commit failed/);
    const count = (stores.projects.get("recovery-p")!.nodes as unknown[]).length;
    stores.tasks.update = update;
    const completed = dispatcher.complete(id, "worker", { texts: ["different late payload"] }, token);
    assert.equal(completed.status, "succeeded");
    assert.equal((stores.projects.get("recovery-p")!.nodes as unknown[]).length, count);
    assert.equal((completed.result!.texts as any[])[0].content, "saved authoritative result");
});

test("explicit preflight failure permits corrected retry but a persisted submission cannot become unsubmitted", t => {
    const { dispatcher, id, token } = fixture(t);
    const failed = dispatcher.fail(id, "worker", "local configuration", token, false, true);
    assert.equal(failed.status, "failed");
    assert.equal((failed.result!.browserRecovery as any).notSubmitted, true);
    const retried = dispatcher.retry(failed); assert.notEqual(retried.id, id);
    const claim = dispatcher.claim(retried.id, "worker");
    dispatcher.checkpoint(retried.id, "worker", claim.claimToken, { version: 1, phase: "submitting", cacheOwner: "cache-worker", providerFingerprint: "a".repeat(64) });
    assert.throws(() => dispatcher.fail(retried.id, "worker", "late local error", claim.claimToken, false, true), /不能声明未提交/);
    assert.throws(() => dispatcher.fail(retried.id, "worker", "ambiguous", claim.claimToken, true, true), /不能同时/);
});

test("archived media only accepts stored handles and completes without a second provider request", t => {
    const { stores, dispatcher, id, token, checkpoint } = fixture(t, "image");
    checkpoint("submitting"); checkpoint("result_available");
    assert.throws(() => checkpoint("archived", { output: { media: [{ storageKey: "missing" }] } }), /媒体不存在/);
    const media = stores.media.store(Buffer.from("mock-image"), { name: "mock.png", mimeType: "image/png", category: "output" });
    checkpoint("archived", { output: { media: [{ storageKey: media.storageKey, apiKey: "private" }] } });
    dispatcher.release(id, "worker", token);
    const restored = dispatcher.claim(id, "other-worker");
    const complete = dispatcher.complete(id, "other-worker", {}, restored.claimToken);
    assert.equal(complete.status, "succeeded");
    assert.equal((complete.result!.media as any[])[0].storageKey, media.storageKey);
    assert.doesNotMatch(JSON.stringify(complete.result), /private/);
    assert.ok(!JSON.stringify(stores.tasks.events(id)).includes(restored.claimToken));
});

test("claim nonces cannot cross task boundaries even for the same worker", t => {
    const { stores, dispatcher, token } = fixture(t);
    stores.tasks.create("another-task", "canvas-browser-script", { mode: "text", prompt: "mock", model: "mock" }, {});
    dispatcher.claim("another-task", "worker");
    assert.throws(() => dispatcher.checkpoint("another-task", "worker", token, { version: 1, phase: "submitting", cacheOwner: "cache-worker", providerFingerprint: "a".repeat(64) }), /认领已失效/);
});

test("cancel wins before claim: an untouched queued task records notSubmitted and can be retried", t => {
    const { stores, dispatcher, id } = fixture(t, "text", false);
    const cancelled = dispatcher.cancel(id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal((cancelled.result!.browserRecovery as any).notSubmitted, true);
    assert.throws(() => dispatcher.claim(id, "worker"), /不可认领/);
    assert.notEqual(dispatcher.retry(cancelled).id, id);
    stores.tasks.create("legacy-cancelled", "canvas-browser-script", { mode: "text", prompt: "mock", model: "mock" }, {});
    stores.tasks.update("legacy-cancelled", { status: "cancelled" });
    assert.throws(() => dispatcher.retry(stores.tasks.get("legacy-cancelled")!), /不能重新提交/);
});

test("claim wins before cancel, including released legacy claims: cancellation cannot invent notSubmitted", t => {
    const { stores, dispatcher, id, token } = fixture(t);
    dispatcher.release(id, "worker", token);
    assert.equal(stores.tasks.get(id)!.status, "queued");
    const stopped = dispatcher.cancel(id);
    assert.equal(stopped.status, "running");
    assert.notEqual((stopped.result!.browserRecovery as any).notSubmitted, true);
    assert.throws(() => dispatcher.retry(stopped), /不能重新提交/);
});
