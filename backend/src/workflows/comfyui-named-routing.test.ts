import assert from "node:assert/strict";
import test from "node:test";
import { convertComfyWorkflowToApi } from "./comfyui-workflow-conversion.js";

function fixture() {
  return { nodes: [
    { id: 1, type: "Loader", inputs: [] },
    { id: 2, type: "SetNode", widgets_values: ["model"], inputs: [{ name: "value", link: 1 }] },
    { id: 3, type: "GetNode", widgets_values: ["wrong"], widgets_values_named: { Constant: "model" }, inputs: [] },
    { id: 4, type: "SaveImage", inputs: [{ name: "images", link: 2 }] },
  ] as Record<string, any>[], links: [[1, 1, 2, 2, 0], [2, 3, 0, 4, 0]] };
}

test("named Get resolves Set by Constant, preserves source slot and leaves source untouched", () => {
  const graph = fixture();
  const before = JSON.stringify(graph);
  const api = convertComfyWorkflowToApi(graph) as any;
  assert.deepEqual(api[4].inputs.images, ["1", 2]);
  assert.deepEqual(Object.keys(api), ["1", "4"]);
  assert.equal(JSON.stringify(graph), before);
});

test("array names and chained Get/Set/Reroute resolve recursively", () => {
  const graph = fixture();
  graph.nodes[2].widgets_values_named = undefined;
  graph.nodes[2].widgets_values = ["model"];
  graph.nodes.push({ id: 5, type: "Reroute", inputs: [{ link: 3 }] },
    { id: 6, type: "SetNode", widgets_values: ["alias"], inputs: [{ link: 4 }] },
    { id: 7, type: "GetNode", widgets_values: ["alias"], inputs: [] });
  graph.links.push([3, 3, 0, 5, 0], [4, 5, 0, 6, 0]);
  graph.links[1][1] = 7;
  assert.deepEqual((convertComfyWorkflowToApi(graph) as any)[4].inputs.images, ["1", 2]);
});

for (const scenario of ["missing", "duplicate", "cycle", "unconnected", "empty"] as const) {
  test(`named routing rejects ${scenario} explicitly`, () => {
    const graph = fixture();
    if (scenario === "missing") graph.nodes[1].widgets_values = ["other"];
    if (scenario === "duplicate") graph.nodes.push({ ...graph.nodes[1], id: 5 });
    if (scenario === "cycle") graph.links[0][1] = 3;
    if (scenario === "unconnected") { graph.nodes[1].inputs = []; graph.links.shift(); }
    if (scenario === "empty") graph.nodes[2].widgets_values_named.Constant = "";
    assert.throws(() => convertComfyWorkflowToApi(graph), /GetNode|SetNode|循环/);
  });
}

test("disabled and bypass targets remain omitted; bypass slot zero still forwards", () => {
  const graph = fixture();
  graph.nodes.push({ id: 5, type: "Operation", mode: 4, inputs: [{ name: "image", link: 3 }] },
    { id: 6, type: "Operation", mode: 2, inputs: [{ name: "image", link: 4 }] });
  graph.links.push([3, 1, 0, 5, 0], [4, 3, 0, 6, 0]);
  graph.links[1][1] = 5;
  const api = convertComfyWorkflowToApi(graph) as any;
  assert.deepEqual(api[4].inputs.images, ["1", 0]);
  assert.equal(api[5], undefined);
  assert.equal(api[6], undefined);
});

test("named Set metadata takes precedence and link table can supply its input", () => {
  const graph = fixture();
  graph.nodes[1].widgets_values = ["wrong"];
  graph.nodes[1].widgets_values_named = { Constant: "model" };
  graph.nodes[1].inputs = [];
  assert.deepEqual((convertComfyWorkflowToApi(graph) as any)[4].inputs.images, ["1", 2]);
});

test("reroute cycles fail explicitly", () => {
  const graph = fixture();
  graph.nodes[1].type = "Reroute";
  graph.nodes[2].type = "Reroute";
  graph.nodes[2].inputs = [{ link: 3 }];
  graph.links.push([3, 2, 0, 3, 0]);
  graph.links[0][1] = 3;
  assert.throws(() => convertComfyWorkflowToApi(graph), /循环/);
});

test("bypassed Set still forwards its first input", () => {
  const graph = fixture();
  graph.nodes[1].mode = 4;
  assert.deepEqual((convertComfyWorkflowToApi(graph) as any)[4].inputs.images, ["1", 2]);
});

test("disabled Set is not an active named source", () => {
  const graph = fixture();
  graph.nodes[1].mode = 2;
  assert.throws(() => convertComfyWorkflowToApi(graph), /SetNode/);
});
