import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowTaskController, WorkflowSubmissionRejected, type TaskReceipt } from "./workflow-task-controller";
import type { BackendRuntimeTask } from "@/services/backend-api";
const task = (id: string, status: BackendRuntimeTask["status"] = "running"): BackendRuntimeTask => ({ id, status, progress: 0 });
const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test("slow submission rejects double clicks and never replaces another owner's receipt", async () => {
 const c = new WorkflowTaskController(), d = deferred<TaskReceipt>(); let calls = 0;
 const first = c.start("A", "a", () => { calls++; return d.promise; });
 await c.start("A", "duplicate", async () => { calls++; return { task: task("duplicate") }; });
 await c.start("B", "b", async () => ({ task: task("b") })); d.resolve({ task: task("a") }); await first;
 assert.equal(calls, 1); assert.equal(c.get("A")?.taskId, "a"); assert.equal(c.get("B")?.taskId, "b");
});
test("lost receipt blocks a fresh ID; safe retry reuses the captured submission", async () => {
 const c = new WorkflowTaskController(); let calls = 0;
 await c.start("A", "original", async () => { if (++calls === 1) throw Error("offline"); return { task: task("original") }; }, true);
 assert.equal(c.get("A")?.unknown, true);
 await c.start("A", "new", async () => { throw Error("must not run"); }); await c.retrySubmission("A");
 assert.equal(calls, 2); assert.equal(c.get("A")?.taskId, "original"); assert.equal(c.get("A")?.unknown, false);
});
test("confirmed server rejection unlocks input corrections", async () => {
 const c = new WorkflowTaskController(); await c.start("A", "a", async () => { throw new WorkflowSubmissionRejected("missing field"); });
 assert.equal(c.get("A")?.running, false); assert.equal(c.get("A")?.unknown, false);
 await c.start("A", "b", async () => ({ task: task("b") })); assert.equal(c.get("A")?.taskId, "b");
});
test("query failure retains the original task and recovers with GET, never another submission", async () => {
 const c = new WorkflowTaskController(); let submits = 0;
 await c.start("A", "a", async () => { submits++; return { task: task("a") }; });
 await c.poll("A", async () => { throw Error("offline"); }); assert.equal(c.get("A")?.running, true); assert.equal(c.get("A")?.result, null);
 await c.poll("A", async id => ({ task: task(id, "succeeded") })); assert.equal(submits, 1); assert.equal(c.get("A")?.result?.status.status_str, "success");
});
test("duplicate cancellation is suppressed and cancellation failure retains tracking", async () => {
 const c = new WorkflowTaskController(), d = deferred<unknown>(); let calls = 0; c.adopt("A", task("a"));
 const first = c.cancel("A", () => { calls++; return d.promise; }, async id => ({ task: task(id) }));
 await c.cancel("A", async () => { calls++; }, async id => ({ task: task(id) }));
 assert.equal(c.get("A")?.running, true); assert.equal(c.get("A")?.cancelling, true);
 d.reject(Error("offline")); await first; assert.equal(calls, 1); assert.equal(c.get("A")?.running, true); assert.equal(c.get("A")?.cancelling, false);
});
test("Backend cancellation without cloud events is only local", async () => {
 const c = new WorkflowTaskController(); c.adopt("A", task("a"));
 await c.cancel("A", async () => ({}), async id => ({ task: task(id, "cancelled") }));
 assert.equal(c.get("A")?.cancellation, "local"); assert.equal(c.get("A")?.running, false);
});
test("delayed cloud acknowledgement changes pending to confirmed, retaining the provider ID", () => {
 const c = new WorkflowTaskController(); c.adopt("A", task("a")); const submitted = { type: "submitted", payload: { taskId: "remote-a" } };
 c.receive("A", { task: task("a", "cancelled"), events: [submitted] }); assert.equal(c.get("A")?.cancellation, "pending"); assert.equal(c.get("A")?.running, false);
 c.receive("A", { task: task("a", "cancelled"), events: [submitted, { type: "remote_cancelled" }] }); assert.equal(c.get("A")?.cancellation, "confirmed"); assert.equal(c.get("A")?.remoteTaskId, "remote-a");
});
test("remote cancellation failure never becomes cloud cancellation success", () => {
 const c = new WorkflowTaskController(); c.adopt("A", task("a")); c.receive("A", { task: task("a", "cancelled"), events: [{ type: "submitted" }, { type: "remote_cancel_failed" }] });
 assert.equal(c.get("A")?.cancellation, "unconfirmed"); assert.equal(c.get("A")?.taskId, "a");
});
test("late running or cancellation receipts never erase successful results", () => {
 const c = new WorkflowTaskController(); c.adopt("A", task("a")); c.receive("A", { task: task("a", "succeeded") });
 c.receive("A", { task: task("a") }); c.receive("A", { task: task("a", "cancelled") }); assert.equal(c.get("A")?.result?.status.status_str, "success");
});
test("a stale old run cannot overwrite a new run for the same owner", async () => {
 const c = new WorkflowTaskController(); c.adopt("A", task("old", "succeeded")); await c.start("A", "new", async () => ({ task: task("new") }));
 c.receive("A", { task: task("old", "failed") }); assert.equal(c.get("A")?.taskId, "new"); assert.equal(c.get("A")?.result, null);
});
test("slow reads deduplicate and receipts survive unsubscribe/remount", async () => {
 const c = new WorkflowTaskController(), d = deferred<TaskReceipt>(); let reads = 0; c.adopt("A", task("a")); c.subscribe(() => {})(); c.subscribe(() => {});
 const first = c.poll("A", () => { reads++; return d.promise; }); await c.poll("A", async () => { reads++; return { task: task("a") }; });
 d.resolve({ task: task("a", "succeeded") }); await first; assert.equal(reads, 1); assert.equal(c.get("A")?.result?.taskId, "a");
});


test("uncertain cancellation requires explicit acknowledgement before a new task, never submits on acknowledgement", async () => {
 const c = new WorkflowTaskController(); c.adopt("A", task("old")); c.receive("A", { task: task("old", "cancelled"), events: [{ type: "remote_cancel_failed" }] }); let calls=0;
 await c.start("A", "new", async()=>{ calls++; return {task:task("new")}; }); assert.equal(calls,0);
 c.acknowledgeCancellation("A"); assert.equal(calls,0); assert.equal(c.get("A")?.cancellation,"unconfirmed");
 await c.start("A", "new", async()=>{ calls++; return {task:task("new")}; }); assert.equal(calls,1);
});


test("legacy server-assigned receipt IDs are tracked without offering unsafe client-ID replay", async () => {
 const c=new WorkflowTaskController(); await c.start("A","client-id",async()=>({task:task("server-id")}),true);
 assert.equal(c.get("A")?.taskId,"server-id"); assert.equal(c.get("A")?.retryable,false); assert.equal(c.get("A")?.unknown,false);
 let id=""; await c.poll("A",async value=>{id=value;return {task:task(value,"succeeded")};}); assert.equal(id,"server-id");
});


test("legacy or unknown replay capability never offers a resend after a lost receipt", async () => {
 const c=new WorkflowTaskController(); let requests=0; await c.start("old-backend","client",async()=>{requests++;throw Error("lost receipt")},false);
 await c.retrySubmission("old-backend"); assert.equal(requests,1); assert.equal(c.get("old-backend")?.unknown,true);
});


test("a taskId-only POST receipt survives a failed first GET on legacy servers", async () => {
 const c=new WorkflowTaskController(); await c.start("local","client-id",async()=>({taskId:"actual-server-id"}),false);
 await c.poll("local",async id=>{assert.equal(id,"actual-server-id");throw Error("HTTP 404 or disconnected query");});
 assert.equal(c.get("local")?.taskId,"actual-server-id");assert.equal(c.get("local")?.unknown,false);assert.equal(c.get("local")?.running,true);assert.equal(c.get("local")?.result,null);
});
