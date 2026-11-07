import assert from "node:assert/strict";
import test from "node:test";
import { convertComfyWorkflowToApi } from "./comfyui-workflow-conversion.js";
import { removeEmptyMediaNodes, validatePromptGraph, WorkflowExecutor } from "./executor.js";

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

test("rgthree frontend control nodes are omitted even when wired into the graph", () => {
  const source = { nodes: [
    { id: 1, type: "LoadImage", inputs: [], outputs: [{ links: [1, 2] }] },
    { id: 480, type: "Fast Bypasser (rgthree)", mode: 0, inputs: [{ name: "加载图像", type: "*", link: 1 }, { name: "", shape: 7, type: "*", link: null }], outputs: [{ name: "OPT_CONNECTION", type: "*", links: [] }] },
    { id: 2, type: "PreviewImage", inputs: [{ name: "images", link: 2 }], outputs: [] },
  ], links: [[1, 1, 0, 480, 0], [2, 1, 0, 2, 0]] };
  assert.deepEqual(convertComfyWorkflowToApi(source), {
    "1": { class_type: "LoadImage", inputs: {} },
    "2": { class_type: "PreviewImage", inputs: { images: ["1", 0] } },
  });
  assert.equal(source.nodes.length, 3);
});

test("rgthree control nodes are stripped from previously imported API workflows", () => {
  const source = {
    "480": { class_type: "Fast Bypasser (rgthree)", inputs: {} },
    "1": { class_type: "SaveImage", inputs: {} },
  };
  assert.deepEqual(convertComfyWorkflowToApi(source), { "1": source["1"] });
  assert.ok(source["480"]);
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

test("被 bypass 节点的非 0 输出槽解析为空连线，不产生悬空引用", () => {
  const source = { nodes: [
    { id: 473, type: "VHS_LoadVideo", mode: 4, inputs: [], outputs: [
      { name: "IMAGE", type: "IMAGE", links: [] },
      { name: "frame_count", type: "INT", links: [] },
      { name: "AUDIO", type: "AUDIO", links: [2] },
    ], widgets_values: { video: "" } },
    { id: 136, type: "MiniMaxH3ReferenceToVideo", inputs: [
      { name: "ref_video_audios.ref_video_audio_0", type: "AUDIO", link: 2 },
    ], outputs: [], widgets_values: [] },
  ], links: [[2, 473, 2, 136, 0, "AUDIO"]] };
  const api = convertComfyWorkflowToApi(source) as Record<string, { inputs: Record<string, unknown> }>;
  assert.equal(api["136"].inputs["ref_video_audios.ref_video_audio_0"], undefined);
});

test("表达式驱动的动态开关在裁剪空媒体时保留整链，不被级联删除", () => {
  const graph = {
    "10": { class_type: "LoadImage", inputs: { image: "" } },
    "705": { class_type: "ComfyMathExpression", inputs: { values: {} } },
    "704": { class_type: "ComfySwitchNode", inputs: { on_false: ["136", 0], on_true: ["136", 0], switch: ["705", 2] } },
    "136": { class_type: "MiniMaxH3ReferenceToVideo", inputs: { "ref_images.ref_image_0": ["10", 0] } },
    "748": { class_type: "SaveVideo", inputs: { video: ["704", 0] } },
  };
  const fields = [{ id: "img", node: "10", input: "image", name: "图", type: "image" as const }];
  const prepared = removeEmptyMediaNodes(graph as never, fields, {});
  assert.equal(prepared["10"], undefined);
  assert.ok(prepared["704"]);
  assert.ok(prepared["748"]);
  assert.doesNotThrow(() => validatePromptGraph(prepared));
});
