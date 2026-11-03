import assert from "node:assert/strict";
import test from "node:test";

import { attachGenerationParamsToNodes } from "./mcp.js";

/**
 * 前端设置面板只读节点 metadata.comfyParams；MCP 的运行参数挂在 op.params 上。
 * 两者不同步时，面板会一直显示工作流默认值（denoise 0.8），而实际跑的是 0.4。
 */
test("新建节点的运行参数同时写进 metadata.comfyParams", () => {
  const ops = attachGenerationParamsToNodes(
    [{
      type: "add_node",
      id: "config-1",
      nodeType: "config",
      metadata: { generationMode: "image", params: { f_denoise: 0.4 } },
    }, {
      type: "run_generation",
      nodeId: "config-1",
      mode: "image",
      params: { f_denoise: 0.4 },
    }],
    [],
  );
  assert.deepEqual(ops[0].metadata, {
    generationMode: "image",
    params: { f_denoise: 0.4 },
    comfyParams: { f_denoise: 0.4 },
  });
  // 同批新建的节点已经有 comfyParams，不需要再补 update_node。
  assert.equal(ops.filter((op) => op.type === "update_node").length, 0);
});

test("对已有节点运行参数时前置一条合并后的 update_node", () => {
  const ops = attachGenerationParamsToNodes(
    [{ type: "run_generation", nodeId: "node-1", mode: "image", params: { f_denoise: 0.4 } }],
    [{ id: "node-1", type: "config", metadata: { comfyParams: { f_denoise: 0.8, f_lora: 0.5 } } }],
  );
  assert.equal(ops.length, 2);
  assert.equal(ops[0].type, "update_node");
  assert.equal(ops[0].id, "node-1");
  // 保留面板里其它已调过的字段，只覆盖本次传入的键。
  assert.deepEqual(ops[0].metadata.comfyParams, { f_denoise: 0.4, f_lora: 0.5 });
  assert.equal(ops[1].type, "run_generation");
});

test("已经显式写了 comfyParams 时不重复插入", () => {
  const ops = attachGenerationParamsToNodes(
    [
      { type: "update_node", id: "node-1", metadata: { comfyParams: { f_denoise: 0.3 } } },
      { type: "run_generation", nodeId: "node-1", mode: "image", params: { f_denoise: 0.4 } },
    ],
    [{ id: "node-1", type: "config", metadata: {} }],
  );
  assert.equal(ops.length, 2);
  assert.deepEqual(ops[0].metadata.comfyParams, { f_denoise: 0.3 });
});

test("没有参数的运行不改动节点", () => {
  const ops = attachGenerationParamsToNodes(
    [{ type: "run_generation", nodeId: "node-1", mode: "image" }],
    [{ id: "node-1", type: "config", metadata: { comfyParams: { f_denoise: 0.8 } } }],
  );
  assert.equal(ops.length, 1);
  assert.equal(ops[0].type, "run_generation");
});
