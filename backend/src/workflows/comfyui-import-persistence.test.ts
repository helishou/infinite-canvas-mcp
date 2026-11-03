import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";

// Each node:test file has its own process. Set DATA_DIR before loading stores.
test("local ComfyUI import preserves the authoritative source and compiles it at run time", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-import-test-"));
  const previous = process.env.INFINITE_CANVAS_DATA_DIR;
  process.env.INFINITE_CANVAS_DATA_DIR = root;
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
  try {
    const { WorkflowStore } = await import("./store.js");
    const { registerWorkflowRoutes } = await import("./routes.js");
    const { WorkflowExecutor } = await import("./executor.js");
    const comfyRoot = path.join(root, "comfy");
    const workflowDir = path.join(comfyRoot, "user/default/workflows");
    await fs.mkdir(workflowDir, { recursive: true });
    await fs.writeFile(path.join(comfyRoot, "main.py"), "# isolated fixture\n");
    const inputPath = process.env.CANVAS_TEST_COMFY_WORKFLOW;
    const raw = inputPath ? await fs.readFile(inputPath, "utf8") : JSON.stringify({ nodes: [
      { id: 1, type: "Loader", inputs: [] },
      { id: 2, type: "SetNode", widgets_values: ["image"], inputs: [{ link: 1 }] },
      { id: 3, type: "GetNode", widgets_values_named: { Constant: "image" }, inputs: [] },
      { id: 4, type: "SaveImage", inputs: [{ name: "images", link: 2 }] },
    ], links: [[1, 1, 0, 2, 0], [2, 3, 0, 4, 0]] });
    await fs.writeFile(path.join(workflowDir, "source.json"), raw);
    await fs.writeFile(path.join(root, "comfyui-instances.json"), JSON.stringify({ instances: ["127.0.0.1:8188"], roots: { "127.0.0.1:8188": comfyRoot } }));
    const db = { getWorkflowConfig: () => null } as never;
    const store = new WorkflowStore(db);
    const prepareExecutor = new WorkflowExecutor({} as never, { create: () => ({ id: "test-task" }) } as never, {} as never);
    let received: unknown;
    let prepared: any;
    const executor = { runBackground: async (workflow: unknown, config: unknown, fields: unknown, client: unknown) => {
      received = workflow;
      // Stop at preparation: no ComfyUI connection, queue submission or GPU work.
      prepared = (await (prepareExecutor as any).prepareRun(workflow, config, fields, client, "http://localhost:8188")).prepared;
      return { taskId: "test-task" };
    } } as never;
    const app = express();
    app.use(express.json({ limit: "10mb" }));
    const autoModels: string[] = [];
    registerWorkflowRoutes(app, store, executor, undefined, async name => { autoModels.push(name); });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address() as { port: number };
    const base = `http://127.0.0.1:${address.port}`;
    const imported = await fetch(`${base}/api/workflows/import-comfyui`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instance: "127.0.0.1:8188", relativePath: "source.json" }) });
    const result = await imported.json() as { name: string };
    assert.equal(imported.status, 201, JSON.stringify(result));
    // New store instance and disk read prove there is no in-memory derived cache.
    const detail = await new WorkflowStore(db).get(result.name);
    const disk = JSON.parse(await fs.readFile(path.join(root, "workflows", result.name), "utf8"));
    assert.deepEqual(detail.workflow, disk);
    assert.ok(detail.source?.syncedSha256);
    assert.deepEqual(disk, JSON.parse(raw));
    const { convertComfyWorkflowToApi } = await import("./comfyui-workflow-conversion.js");
    const api = convertComfyWorkflowToApi(detail.workflow) as any;
    assert.ok(Object.values(api).every((node: any) => !["SetNode", "GetNode", "Reroute"].includes(node.class_type)));
    if (inputPath) {
      assert.deepEqual(api[237].inputs.images, ["203", 0]);
      const ui = JSON.parse(raw);
      for (const [getter, upstream] of [[740, "211"], [744, "201"], [730, "236"]] as const) {
        const outgoing = ui.links.filter((link: any[]) => Number(link[1]) === getter);
        assert.ok(outgoing.length > 0);
        for (const link of outgoing) {
          if (!api[String(link[3])]) continue;
          const target = ui.nodes.find((node: any) => String(node.id) === String(link[3]));
          const input = target.inputs[link[4]];
          assert.deepEqual(api[String(link[3])].inputs[input.name], [upstream, 0]);
        }
      }
    } else assert.deepEqual(api[4].inputs.images, ["1", 0]);
    const run = await fetch(`${base}/api/workflows/${encodeURIComponent(result.name)}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fields: {} }) });
    assert.equal(run.status, 200, await run.text());
    assert.deepEqual(received, disk);
    if (inputPath) assert.deepEqual(prepared[237].inputs.images, ["203", 0]);
    else assert.deepEqual(prepared[4].inputs.images, ["1", 0]);
    assert.equal(await fs.readFile(path.join(workflowDir, "source.json"), "utf8"), raw);
    if (inputPath) assert.equal(await fs.readFile(inputPath, "utf8"), raw);
    if (!inputPath) {
      const edited = JSON.parse(raw);
      edited.nodes.push({ id: 99, type: "Loader", pos: [20, 30], inputs: [] });
      edited.links[0][1] = 99;
      const saved = await fetch(`${base}/api/workflows/${encodeURIComponent(result.name)}/workflow`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(edited) });
      assert.equal(saved.status, 200);
      const editedRun = await fetch(`${base}/api/workflows/${encodeURIComponent(result.name)}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fields: {} }) });
      assert.equal(editedRun.status, 200);
      assert.deepEqual(prepared[4].inputs.images, ["99", 0]);
      assert.deepEqual((await new WorkflowStore(db).get(result.name)).workflow, edited);
    }
    const sync = await fetch(`${base}/api/workflows/${encodeURIComponent(result.name)}/sync-comfyui`, { method: "POST" });
    assert.equal(sync.status, 200, await sync.text());
    assert.deepEqual(autoModels, [], 'local import and sync must not register models');
    assert.deepEqual((await new WorkflowStore(db).get(result.name)).workflow, disk);
    // Conversion must fail before either an import or a sync can persist a broken graph.
    const broken = JSON.parse(raw);
    const getter = broken.nodes.find((node: any) => String(node.id) === (inputPath ? "740" : "3"));
    getter.widgets_values_named = { Constant: "__missing_test_setter__" };
    await fs.writeFile(path.join(workflowDir, "source.json"), JSON.stringify(broken));
    const rejectedSync = await fetch(`${base}/api/workflows/${encodeURIComponent(result.name)}/sync-comfyui`, { method: "POST" });
    assert.equal(rejectedSync.status, 400);
    assert.match(await rejectedSync.text(), /SetNode/);
    assert.deepEqual((await new WorkflowStore(db).get(result.name)).workflow, disk);
    const rejectedImport = await fetch(`${base}/api/workflows/import-comfyui`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instance: "127.0.0.1:8188", relativePath: "source.json" }) });
    assert.equal(rejectedImport.status, 400);
    assert.match(await rejectedImport.text(), /SetNode/);
    const customFiles = await fs.readdir(path.join(root, "workflows/custom"));
    assert.equal(customFiles.filter((name) => name === "source (2).json").length, 0);
    console.log(`import -> disk -> fresh store -> run preparation verified (${Object.keys(api).length} nodes, realGraph=${Boolean(inputPath)}); sync and rejected writes verified`);
  } finally {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    if (previous === undefined) delete process.env.INFINITE_CANVAS_DATA_DIR;
    else process.env.INFINITE_CANVAS_DATA_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});
