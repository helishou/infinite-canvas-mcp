import assert from "node:assert/strict";
import test from "node:test";
import { collectConfirmationReminders, taskConfirmationReminders, ConfirmationReminderController, type ConfirmationReminder } from "./confirmation-reminders";

const request = (id: string, path = "/canvas/original"): ConfirmationReminder => ({ id, kind: "approval", path });
function environment() {
    let background = false, allowed = true;
    const sent: Array<{ ids: string[]; click: () => void; fail: (error: unknown) => void; closed: boolean }> = [];
    const activated: ConfirmationReminder[] = [], saved: string[][] = [], failures: unknown[] = [];
    const controller = new ConfirmationReminderController({ background: () => background, allowed: () => allowed,
        show: (items, click, fail) => { const notification = { ids: items.map(item => item.id), click, fail, closed: false }; sent.push(notification); return { close: () => { notification.closed = true; } }; },
        activate: item => { activated.push(item); }, remember: ids => { saved.push(ids); }, failed: error => { failures.push(error); } });
    return { controller, sent, activated, saved, failures, background: (value: boolean) => { background = value; }, allowed: (value: boolean) => { allowed = value; } };
}

test("foreground pending confirmation is shown once when the user switches away", () => {
    const state = environment();
    state.controller.update([request("approval")], true); assert.equal(state.sent.length, 0);
    state.background(true); state.controller.update([request("approval")], true); assert.equal(state.sent.length, 1);
    state.controller.update([request("approval")], true); assert.equal(state.sent.length, 1);
    state.background(false); state.controller.update([request("approval")], true); assert.equal(state.sent[0].closed, true);
    state.background(true); state.controller.update([request("approval")], true); assert.equal(state.sent.length, 1);
    state.controller.update([request("approval"), request("new")], true); assert.equal(state.sent.length, 2);
});

test("disabled or denied notifications stay silent and resolved requests cannot navigate", () => {
    const state = environment(); state.background(true); state.allowed(false);
    state.controller.update([request("approval")], true); assert.equal(state.sent.length, 0);
    state.allowed(true); state.controller.update([request("approval")], false); assert.equal(state.sent.length, 0);
    state.controller.update([request("approval")], true); assert.equal(state.sent.length, 1);
    state.controller.update([], true); state.sent[0].click();
    assert.equal(state.activated.length, 0); assert.equal(state.sent[0].closed, true);
    state.controller.update([request("approval")], true); assert.equal(state.sent.length, 1, "reconnect must not repeat a notification for the same request");
});

test("notification click keeps the original canvas when the user navigates elsewhere", () => {
    const state = environment(); state.background(true);
    state.controller.update([request("approval", "/canvas/original")], true);
    state.controller.update([request("approval", "/canvas/another")], true);
    state.sent[0].click();
    assert.equal(state.activated[0].path, "/canvas/original");
    assert.deepEqual(state.saved, [["approval"]]);
});

test("a grouped reminder keeps the remaining confirmation when another item resolves", () => {
    const state = environment(); state.background(true);
    state.controller.update([request("first", "/canvas/first"), request("second", "/canvas/second")], true);
    state.controller.update([request("second", "/canvas/second")], true);
    assert.equal(state.sent.length, 1); assert.equal(state.sent[0].closed, false);
    state.sent[0].click(); assert.equal(state.activated[0].path, "/canvas/second");
});

test("failed notification can be retried explicitly without a business-state mutation", () => {
    const state = environment(); state.background(true);
    state.controller.update([request("approval")], true); state.sent[0].fail(new Error("unsupported delivery"));
    assert.equal(state.failures.length, 1); assert.equal(state.sent[0].closed, true);
    state.controller.update([request("approval")], true); assert.equal(state.sent.length, 1);
    state.controller.retry(); state.controller.update([request("approval")], true); assert.equal(state.sent.length, 2);
});

test("collector uses formal decisions and manual reviews, excluding automatic review and other threads", () => {
    const context = { role: "standalone", canvasId: "canvas", owner: { kind: "canvas", id: "canvas" } } as any;
    const production = { episodeId: "canvas", revision: 1, publishedVersion: 1, draft: { settings: { mode: "manual" }, keyframes: {},
        director: { workflow: { mediaProductionMode: "per_item", pendingDecisions: [{ id: "choice", workId: "work", sourceHash: "source", status: "pending" }] }, shotInputs: {}, assets: { STYLE: { nodeId: "style", storageKey: "image:style", sha256: "media" } } } } } as any;
    const readiness = { targets: [{ id: "asset:STYLE", targetId: "STYLE", kind: "asset", status: "needs_review", title: "Style" }] } as any;
    const input = { context, production, readiness, threadId: "current", route: "/canvas/canvas", pendingTool: null, approvals: [{ requestId: "other", method: "approval", threadId: "other" }] };
    const items = collectConfirmationReminders(input);
    assert.deepEqual(items.map(item => item.kind), ["decision", "review"]);
    assert.ok(items[0].path.includes("productionKind=canvas"), "notification must retain standalone production ownership");
    assert.ok(items[1].path.includes("target=asset%3ASTYLE"));
    production.revision++;
    assert.deepEqual(collectConfirmationReminders(input).map(item => item.id), items.map(item => item.id));
    production.draft.director.workflow.mediaProductionMode = "automatic";
    assert.deepEqual(collectConfirmationReminders(input).map(item => item.kind), ["decision"]);
    production.draft.director.workflow.pendingDecisions[0].status = "answered";
    assert.deepEqual(collectConfirmationReminders(input), []);
});

test("H3 confirmations use exact clip fingerprints and do not duplicate their children", () => {
    const parent = { id: "parent", projectId: "canvas", status: "awaiting_confirmation", result: { confirmation: { revision: 1, pending: [{ nodeId: "h3", segmentId: "clip", firstPassFingerprint: "original-frame" }] } } } as any;
    const child = { id: "child", parentTaskId: "parent", projectId: "canvas", nodeId: "h3", segmentId: "clip", status: "awaiting_confirmation" } as any;
    const tasks = taskConfirmationReminders([parent, child, { ...child, id: "foreign", projectId: "another" }], "canvas");
    assert.equal(tasks.length, 1); assert.equal(tasks[0].taskId, "parent");
    const reminders = collectConfirmationReminders({ threadId: "", route: "/canvas/canvas", pendingTool: null, approvals: [], context: null, production: null, readiness: null, taskConfirmations: tasks });
    assert.equal(reminders[0].kind, "task"); assert.equal(reminders[0].path, "/canvas/canvas?nodeId=h3&segmentId=clip");
    parent.result.confirmation.pending[0].firstPassFingerprint = "new-frame";
    assert.notEqual(taskConfirmationReminders([parent], "canvas")[0].id, tasks[0].id);
    parent.status = "succeeded";
    assert.deepEqual(taskConfirmationReminders([parent], "canvas"), []);
});
