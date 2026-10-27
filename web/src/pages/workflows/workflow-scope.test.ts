import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
const source = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");
const tree = ts.createSourceFile("index.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(predicate: (node: ts.Node) => boolean): ts.Node { let result: ts.Node | undefined; const visit = (node: ts.Node) => { if (!result && predicate(node)) result = node; if (!result) ts.forEachChild(node, visit); }; visit(tree); assert.ok(result); return result; }
function compile(expression: string, scope: Record<string, any>) { const code = ts.transpileModule(`const callback = ${expression}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText; return new Function("scope", `with(scope) { ${code}; return callback; }`)(scope); }
function callback(name: string, scope: Record<string, any>) { const node = find(node => ts.isVariableDeclaration(node) && node.name.getText(tree) === name) as ts.VariableDeclaration; const value = node.initializer!; return compile(ts.isCallExpression(value) ? value.arguments[0].getText(tree) : value.getText(tree), scope); }
const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };

test("RH output picker updates only its profile's run selection and cannot write local config", () => {
 const picker = find(node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(tree) === "OutputNodePicker" && node.attributes.getText(tree).includes("workflowJson")) as ts.JsxSelfClosingElement;
 const attr = picker.attributes.properties.find(node => ts.isJsxAttribute(node) && node.name.getText(tree) === "onChange") as ts.JsxAttribute;
 let selections = { B: ["7"] } as Record<string,string[]>; let writes = 0;
 const run = compile((attr.initializer as ts.JsxExpression).expression!.getText(tree), { selectedProfile: { id: "A" }, setRhOutputSelections: (fn: any) => { selections = fn(selections); }, handleSaveConfig: () => writes++, request: () => writes++ });
 run(["99"]); assert.deepEqual(selections, { A: ["99"], B: ["7"] }); assert.equal(writes, 0);
});
test("local save is owner-bound, deduplicated, and late response never selects a different workflow", async () => {
 const pending = deferred<void>(); let current: any = { name: "B", config: { fields: [] } }; let requests = 0;
 const locked = new Set<string>(); const scope = { savingRef: { current: locked }, markSaving: (id:string,on:boolean) => on ? locked.add(id) : locked.delete(id), pendingFieldsRef: { current: {} as Record<string, any> }, request: async (_method:string,path:string) => { requests++; assert.match(path,/A/); return pending.promise; }, setSelected: (fn:any) => { current=fn(current); }, fetchWorkflows: () => {}, message: { error() {} }, t: (key:string) => key };
 const save = callback("handleSaveConfig", scope); const owner = { name: "A", config: { fields: [] } }; const first = save(owner, { fields: [], outputNodes: ["1"] }); assert.equal(await save(owner,{ fields: [] }), false);
 pending.resolve(); assert.equal(await first,true); assert.equal(requests,1); assert.equal(current.name,"B"); assert.equal(locked.size,0);
});
test("failed config save leaves displayed/saved config unchanged and can retry", async () => {
 let current: any = { name: "A", config: { outputNodes: ["old"] } }; let failures=0; const locked=new Set<string>();
 const save = callback("handleSaveConfig", { savingRef: { current: locked }, markSaving:(id:string,on:boolean)=>on?locked.add(id):locked.delete(id), request:async()=>{ throw Error("offline"); }, setSelected:(fn:any)=>{current=fn(current)},fetchWorkflows:()=>{},message:{error:()=>failures++},t:(s:string)=>s });
 assert.equal(await save(current,{outputNodes:["new"]}),false); assert.deepEqual(current.config.outputNodes,["old"]); assert.equal(locked.size,0); assert.equal(failures,1);
});
test("out-of-order detail responses preserve the latest selection intent", async () => {
 const a=deferred<any>(), b=deferred<any>(); let selected:any; const loaded:any[]=[];
 const load=callback("handleLoadDetail", {detailRequest:{current:0},setDetailLoading:(v:boolean)=>loaded.push(v),setDetailError:()=>{},request:(_m:string,path:string)=>path.endsWith("A")?a.promise:b.promise,normalizeOutputNodeSelection:(v:any)=>v,lastOutputNodeId:()=>"" ,setSelected:(v:any)=>{selected=v},setHistoryLogs:()=>{},setActiveTab:()=>{}});
 const first=load("A"),second=load("B"); b.resolve({name:"B",config:{fields:[]},workflow:{}});await second;a.resolve({name:"A",config:{fields:[]},workflow:{}});await first;assert.equal(selected.name,"B");assert.equal(loaded.at(-1),false);
});

test("POST receipt is returned before reads; missing legacy client IDs never prove rejection", async () => {
 class ApiError extends Error { constructor(message:string,readonly status:number){super(message);} }
 class Rejected extends Error {}
 const node=find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==="submitAndRead");
 const submit=compile(`(${node.getText(tree)})`,{BackendApiError:ApiError,WorkflowSubmissionRejected:Rejected});
 let reads=0;
 const receipt=await submit(async()=>({taskId:"actual-id"}),async()=>{reads++;throw new ApiError("404",404)},false);
 assert.deepEqual(receipt,{taskId:"actual-id"});assert.equal(reads,0);
 const serverError=new ApiError("500",500);
 await assert.rejects(submit(async()=>{throw serverError},async()=>{reads++;throw new ApiError("404",404)},false),(error:unknown)=>error===serverError);
 assert.equal(reads,0);
 await assert.rejects(submit(async()=>{throw serverError},async()=>{reads++;throw new ApiError("404",404)},true),Rejected);
 assert.equal(reads,1);
});

function deleteHarness() {
 const a = { name: "custom/A.json", builtin: false, config: { title: "Workflow A" } };
 const log = { id: "log-A", workflow: a.name, createdAt: "2026-10-12T00:00:00Z" };
 let selected: any = a; let logs = [log]; let requests = 0; let refreshes = 0; let errors = 0;
 const dialogs: any[] = []; const locked = new Set<string>();
 let remove: () => Promise<void> = async () => {};
 const scope: Record<string, any> = {
  selected: a, historyLogs: logs, library: "local", section: "workflows", deleteContext: "local:workflows:graph:A",
  currentDeleteContext: { current: "local:workflows:graph:A" }, deleteMounted: { current: true }, detailRequest: { current: 0 }, deleteDialog: { current: null },
  savingRef: { current: locked }, markSaving: (key: string, on: boolean) => on ? locked.add(key) : locked.delete(key),
  modal: { confirm: (options: any) => { const dialog = { ...options, destroy: () => options.afterClose() }; dialogs.push(dialog); return dialog; } },
  t: (key: string, values: any = {}) => `${key}:${JSON.stringify(values)}`,
  request: async (method: string, path: string) => { assert.equal(method, "DELETE"); assert.equal(path, "/api/workflows/custom%2FA.json"); requests++; await remove(); },
  deleteBackendGenerationLogs: async (options: any) => { assert.deepEqual(options, { id: "log-A" }); requests++; await remove(); },
  message: { success() {}, error() { errors++; } }, fetchWorkflows: () => { refreshes++; },
  setSelected: (fn: any) => { selected = fn(selected); }, setHistoryLogs: (fn: any) => { logs = fn(logs); },
 };
 scope.confirmLocalDelete = callback("confirmLocalDelete", scope);
 const deleteWorkflow = callback("handleDelete", scope); const deleteHistory = callback("handleDeleteHistory", scope);
 return { scope, dialogs, locked, deleteWorkflow: () => deleteWorkflow(a.name), deleteHistory: () => deleteHistory(log.id), setRemove: (fn: () => Promise<void>) => { remove = fn; }, switchOwner: () => { selected = { name: "B" }; scope.currentDeleteContext.current = "local:workflows:graph:B"; }, selected: () => selected, logs: () => logs, requests: () => requests, refreshes: () => refreshes, errors: () => errors };
}

test("local workflow delete requires explicit confirmation and cancellation sends no request", async () => {
 const h = deleteHarness(); h.deleteWorkflow(); h.deleteWorkflow();
 assert.equal(h.dialogs.length, 1); assert.equal(h.requests(), 0);
 assert.equal(h.dialogs[0].focusable.autoFocusButton, "cancel");
 assert.match(h.dialogs[0].title, /Workflow A/); assert.match(h.dialogs[0].content, /custom\/A.json/);
 h.dialogs[0].onCancel(); await h.dialogs[0].onOk();
 assert.equal(h.requests(), 0); assert.equal(h.selected().name, "custom/A.json");
});
test("local deletion ignores stale confirmations after selection intent, context switch, or unmount", async () => {
 for (const invalidate of [(h: any) => h.switchOwner(), (h: any) => h.scope.detailRequest.current++, (h: any) => { h.scope.deleteMounted.current = false; }]) {
  const h = deleteHarness(); h.deleteWorkflow(); invalidate(h); await h.dialogs[0].onOk(); assert.equal(h.requests(), 0);
 }
});
test("confirmed local workflow delete deduplicates, remains owner-bound and refreshes on success", async () => {
 const h = deleteHarness(); const pending = deferred<void>(); h.setRemove(() => pending.promise);
 h.deleteWorkflow(); const first = h.dialogs[0].onOk(); await h.dialogs[0].onOk(); h.deleteWorkflow();
 assert.equal(h.requests(), 1); assert.equal(h.locked.has("custom/A.json"), true);
 h.switchOwner(); pending.resolve(); await first;
 assert.equal(h.selected().name, "B"); assert.equal(h.refreshes(), 1); assert.equal(h.locked.size, 0);
});
test("failed local deletion keeps data and supports retry in the same confirmation", async () => {
 const h = deleteHarness(); h.setRemove(async () => { throw Error("offline"); }); h.deleteWorkflow();
 await assert.rejects(h.dialogs[0].onOk(), /offline/);
 assert.equal(h.selected().name, "custom/A.json"); assert.equal(h.errors(), 1); assert.equal(h.locked.size, 0); assert.equal(h.refreshes(), 0);
 h.setRemove(async () => {}); await h.dialogs[0].onOk(); assert.equal(h.requests(), 2); assert.equal(h.selected(), null);
});
test("history deletion identifies one record, waits for confirmation, deduplicates and retains data on failure", async () => {
 const h = deleteHarness(); h.deleteHistory();
 assert.equal(h.requests(), 0); assert.match(h.dialogs[0].content, /log-A/); assert.match(h.dialogs[0].content, /custom\/A.json/);
 h.setRemove(async () => { throw Error("offline"); }); await assert.rejects(h.dialogs[0].onOk(), /offline/);
 assert.equal(h.logs().length, 1); assert.equal(h.locked.size, 0);
 const pending = deferred<void>(); h.setRemove(() => pending.promise); const first = h.dialogs[0].onOk(); await h.dialogs[0].onOk();
 assert.equal(h.requests(), 2); assert.equal(h.locked.has("history:log-A"), true);
 pending.resolve(); await first; assert.equal(h.logs().length, 0); assert.equal(h.selected().name, "custom/A.json");
});
test("history cancellation or changing owner before confirmation never deletes a record", async () => {
 for (const cancel of [true, false]) {
  const h = deleteHarness(); h.deleteHistory(); if (cancel) h.dialogs[0].onCancel(); else h.switchOwner();
  await h.dialogs[0].onOk(); assert.equal(h.requests(), 0); assert.equal(h.logs().length, 1);
 }
});
