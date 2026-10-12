import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowExecutor } from "./executor.js";
import { RunningHubBackend } from "../runtime/runninghub.js";
import { registerAgentRuntimeRoutes } from "../server/agent-runtime-routes.js";

function localHarness() {
 const records = new Map<string, any>(); let prepares = 0, executes = 0; let unblock: (() => void) | undefined;
 const tasks = { get: (id: string) => records.get(id) };
 const executor = new WorkflowExecutor({} as never, tasks as never, {} as never);
 const runtime = executor as unknown as { prepareRun: (...args: any[]) => Promise<any>; executeAndFinalize: (ctx: any) => Promise<any> };
 runtime.prepareRun = async (...args) => { prepares++; if (unblock !== undefined) await new Promise<void>(resolve => { unblock = resolve; }); const id = args[6]; const task = { id, kind: "workflow", status: "running" }; records.set(id, task); return { task }; };
 runtime.executeAndFinalize = async () => { executes++; return {}; };
 const run = (id: string) => executor.runBackground({}, { fields: [] } as never, {}, "client", undefined, "workflow-A", id);
 return { records, executor, run, tasks, counts: () => ({ prepares, executes }), delay: () => { unblock = () => {}; }, release: () => unblock?.() };
}

test("same local client ID joins a slow preparation and executes only once", async () => {
 const h = localHarness(); h.delay(); const first = h.run("same"); const second = h.run("same"); h.release();
 assert.deepEqual(await Promise.all([first, second]), [{ taskId: "same" }, { taskId: "same" }]); assert.deepEqual(h.counts(), { prepares: 1, executes: 1 });
});
test("local existing active, succeeded, and failed IDs return receipts without preparation", async () => {
 const h = localHarness(); for (const status of ["running", "succeeded", "failed", "cancelled"]) { h.records.set(status, { id: status, kind: "workflow", status }); assert.deepEqual(await h.run(status), { taskId: status }); }
 assert.deepEqual(h.counts(), { prepares: 0, executes: 0 }); await h.run("explicit-new-ID"); assert.deepEqual(h.counts(), { prepares: 1, executes: 1 });
});
test("a new executor reconnects to a persisted task instead of executing it again", async () => {
 const h = localHarness(); await h.run("persisted"); const restarted = new WorkflowExecutor({} as never, h.tasks as never, {} as never);
 assert.deepEqual(await restarted.runBackground({}, { fields: [] } as never, {}, "client", undefined, "workflow-A", "persisted"), { taskId: "persisted" });
 assert.deepEqual(h.counts(), { prepares: 1, executes: 1 });
});
test("RunningHub existing client ID is reused before config or enqueue", async () => {
 const old = { id: "rh-original", kind: "runninghub:workflow", status: "running" }; const tasks = { get: (id: string) => id === old.id ? old : undefined };
 const backend = new RunningHubBackend(tasks as never, {} as never, undefined, {} as never, {} as never);
 const runtime = backend as unknown as { startTask: (...args: any[]) => Promise<any> };
 assert.equal(await runtime.startTask("runninghub:workflow", {}, {}, old.id, false), old);
 const restarted = new RunningHubBackend(tasks as never, {} as never, undefined, {} as never, {} as never) as unknown as typeof runtime;
 assert.equal(await restarted.startTask("runninghub:workflow", {}, {}, old.id, false), old);
});
test("RunningHub HTTP route forwards the exact optional clientTaskId", async () => {
 let runHandler: any; const app = { get() {}, put() {}, delete() {}, post(path: string, handler: any) { if (path.endsWith("/workflows/:id/run")) runHandler = handler; } };
 let args: any[] = []; const runtime = { async runWorkflow(...input: any[]) { args = input; return { id: input[4], status: "queued" }; } };
 registerAgentRuntimeRoutes(app as never, {} as never, runtime as never, {} as never);
 let response: any; const res = { status() { return this; }, json(value: any) { response = value; } };
 await runHandler({ params: { id: "profile-A" }, body: { input: { prompt: "x" }, values: {}, params: {}, clientTaskId: "same-id" } }, res);
 assert.equal(args[4], "same-id"); assert.equal(response.task.id, "same-id"); assert.equal(args[0], "profile-A");
});


test("status advertises replay safety only on the updated Backend route", () => {
 let statusHandler:any; const app={get(path:string,handler:any){if(path==="/agent/runninghub/status")statusHandler=handler;},post(){},put(){},delete(){}};
 registerAgentRuntimeRoutes(app as never,{} as never,{status:()=>({hasApiKey:false})} as never,{} as never);
 let receipt:any; statusHandler({}, {json(value:any){receipt=value;}});
 assert.equal(receipt.workflowTaskReplaySafe,true); assert.equal(receipt.hasApiKey,false);
});
