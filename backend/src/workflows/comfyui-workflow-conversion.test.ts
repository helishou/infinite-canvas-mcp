import assert from "node:assert/strict";
import test from "node:test";
import { convertComfyWorkflowToApi } from "./comfyui-workflow-conversion.js";
import { WorkflowExecutor } from "./executor.js";

test("UI workflow conversion omits unconnected notes but retains execution nodes", () => {
  const source = { nodes: [
    { id: 54, type: "MarkdownNote", inputs: [], outputs: [] },
    { id: 55, type: "Note", inputs: [], outputs: [] },
    { id: 56, type: "孤海注释", inputs: [], outputs: [] },
    { id: 1, type: "SaveImage", inputs: [] },
  ], links: [] };
  assert.deepEqual(convertComfyWorkflowToApi(source), { "1": { class_type: "SaveImage", inputs: {} } });
  assert.equal(source.nodes.length, 4);
});

test("connected UI notes fail conversion instead of silently breaking a link", () => {
  const source = { nodes: [
    { id: 54, type: "MarkdownNote", inputs: [], outputs: [] },
    { id: 1, type: "SaveImage", inputs: [{ name: "images", link: 1 }] },
  ], links: [[1, 54, 0, 1, 0]] };
  assert.throws(() => convertComfyWorkflowToApi(source), /54/);
});

test("Reroute nodes are bypassed, including consecutive reroutes", () => {
  const source = { nodes: [
    { id: 1, type: "LoadImage", inputs: [], outputs: [{ links: [1] }] },
    { id: 44, type: "Reroute", inputs: [{ name: "", link: 1 }], outputs: [{ links: [2] }] },
    { id: 45, type: "Reroute", inputs: [{ name: "", link: 2 }], outputs: [{ links: [3] }] },
    { id: 2, type: "PreviewImage", inputs: [{ name: "images", link: 3 }], outputs: [] },
  ], links: [[1, 1, 0, 44, 0], [2, 44, 0, 45, 0], [3, 45, 0, 2, 0]] };
  assert.deepEqual(convertComfyWorkflowToApi(source), {
    "1": { class_type: "LoadImage", inputs: {} },
    "2": { class_type: "PreviewImage", inputs: { images: ["1", 0] } },
  });
  assert.equal(source.nodes.length, 4);
});

test("孤海注释 is omitted from previously imported API workflows during run preparation", async () => {
  const source = {
    "56": { class_type: "孤海注释", inputs: {} },
    "1": { class_type: "SaveImage", inputs: {} },
  };
  const executor = new WorkflowExecutor({} as never, { create: () => ({ id: "task" }) } as never, {} as never);
  const prepare = executor as unknown as { prepareRun: (...args: unknown[]) => Promise<{ prepared: Record<string, unknown> }> };
  const result = await prepare.prepareRun(source, { title: "test", fields: [] }, {}, "client", "http://localhost:8188", undefined, undefined, undefined, undefined, undefined);
  assert.deepEqual(result.prepared, { "1": source["1"] });
  assert.ok(source["56"]);
});

test("seed controls do not shift sampler and llama inputs", () => {
  const widgets = (names: string[]) => names.map((name) => ({ name, widget: { name }, link: null }));
  const source = { nodes: [
    { id: 24, type: "SamplerCustom", inputs: widgets(["add_noise", "noise_seed", "cfg"]), widgets_values: [true, 42, "randomize", 1], widgets_values_named: { add_noise: true, noise_seed: 42, control_after_generate: "randomize", cfg: 1 } },
    { id: 57, type: "llama_cpp_instruct_adv", inputs: widgets(["seed", "force_offload", "save_states"]), widgets_values: [7, "randomize", false, false] },
  ], links: [] };
  const api = convertComfyWorkflowToApi(source) as Record<string, { inputs: Record<string, unknown> }>;
  assert.deepEqual(api["24"].inputs, { add_noise: true, noise_seed: 42, cfg: 1 });
  assert.deepEqual(api["57"].inputs, { seed: 7, force_offload: false, save_states: false });
});

test("previously imported API workflow removes notes during actual run preparation", async () => {
  const source = {
    "54": { class_type: "MarkdownNote", inputs: {} },
    "55": { class_type: "Note", inputs: {} },
    "1": { class_type: "SaveImage", inputs: {} },
  };
  assert.deepEqual(convertComfyWorkflowToApi(source), { "1": source["1"] });
  const executor = new WorkflowExecutor({} as never, { create: () => ({ id: "task" }) } as never, {} as never);
  const prepare = executor as unknown as { prepareRun: (...args: unknown[]) => Promise<{ prepared: Record<string, unknown> }> };
  const result = await prepare.prepareRun(source, { title: "test", fields: [] }, {}, "client", "http://localhost:8188", undefined, undefined, undefined, undefined, undefined);
  assert.deepEqual(result.prepared, { "1": source["1"] });
  assert.ok(source["54"]);
});
