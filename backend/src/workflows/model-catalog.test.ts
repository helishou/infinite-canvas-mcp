import assert from "node:assert/strict";
import test from "node:test";

import { WorkflowModelCatalog } from "./model-catalog.js";

function fixtures() {
  const values = new Map<string, unknown>([["ai.config", { channels: [] }]]);
  const details = [
    { name: "custom/生图.json", title: "生图", operation: "image", fields: [] },
    {
      name: "custom/配音.json",
      title: "配音",
      operation: "tts",
      fields: [
        { id: "audio", node: "1", input: "audio", name: "音频", type: "audio" },
      ],
    },
  ];
  const workflows = {
    list: async () =>
      details.map((item) => ({
        name: item.name,
        title: item.title,
        builtin: false,
        fieldCount: item.fields.length,
      })),
    get: async (name: string) => {
      const item = details.find((entry) => entry.name === name)!;
      return {
        name,
        workflow: {},
        builtin: false,
        config: {
          title: item.title,
          backend: "comfyui",
          operation: item.operation,
          description: "",
          fields: item.fields,
        },
      };
    },
  };
  const settings = {
    get: (key: string) => values.get(key),
    set: (key: string, value: unknown) =>
      void values.set(key, structuredClone(value)),
  };
  return {
    values,
    catalog: new WorkflowModelCatalog(workflows as never, settings),
  };
}

test("现有工作流一次性转换为本地模型并推断能力", async () => {
  const { values, catalog } = fixtures();
  const result = await catalog.syncStoredConfig();
  assert.deepEqual(result.added, ["生图", "配音"]);
  const config = values.get("ai.config") as {
    channels: Array<{
      kind: string;
      models: Array<{ name: string; capability: string; workflows: string[] }>;
    }>;
  };
  const models = config.channels.find(
    (channel) => channel.kind === "comfyui",
  )!.models;
  assert.deepEqual(
    models.map(({ name, capability, workflows }) => ({
      name,
      capability,
      workflows,
    })),
    [
      { name: "生图", capability: "image", workflows: ["custom/生图.json"] },
      { name: "配音", capability: "audio", workflows: ["custom/配音.json"] },
    ],
  );
});

test("已处理工作流不会在用户删除模型后被重新暴露", async () => {
  const { values, catalog } = fixtures();
  await catalog.syncStoredConfig();
  const config = structuredClone(values.get("ai.config")) as {
    channels: Array<{ models: unknown[] }>;
  };
  config.channels[0].models = [];
  values.set("ai.config", config);
  const result = await catalog.syncStoredConfig();
  assert.equal(result.changed, false);
  assert.deepEqual(
    (values.get("ai.config") as typeof config).channels[0].models,
    [],
  );
});

test("旧工作流路径模型会并入真实模型并修正默认选择", async () => {
  const { values, catalog } = fixtures();
  values.set("ai.config", {
    imageModel: "local::custom/生图.json",
    models: ["local::custom/生图.json"],
    channels: [
      {
        id: "local",
        name: "本地 ComfyUI",
        baseUrl: "http://127.0.0.1:8188",
        apiKey: "",
        apiFormat: "openai",
        kind: "comfyui",
        models: [
          { name: "custom/生图.json", capability: "image" },
          {
            name: "生图",
            capability: "image",
            workflows: ["custom/生图.json"],
          },
        ],
      },
    ],
  });
  const result = await catalog.syncStoredConfig();
  assert.equal(result.changed, true);
  const config = values.get("ai.config") as {
    imageModel: string;
    models: string[];
    channels: Array<{ models: Array<{ name: string }> }>;
  };
  assert.deepEqual(
    config.channels[0].models.map((model) => model.name),
    ["生图", "配音"],
  );
  assert.equal(config.imageModel, "local::生图");
  assert.deepEqual(config.models, ["local::生图"]);
});

test("乱码标题回退为文件名", async () => {
  const { values, catalog } = fixtures();
  values.set("workflow.model-catalog.v1", ["custom/生图.json"]);
  values.set("ai.config", {
    channels: [
      {
        id: "local",
        name: "本地 ComfyUI",
        baseUrl: "http://127.0.0.1:8188",
        apiKey: "",
        apiFormat: "openai",
        kind: "comfyui",
        models: [
          {
            name: "生图 \uFFFD\uFFFD\uFFFD\uFFFD",
            capability: "image",
            workflows: ["custom/生图.json"],
          },
        ],
      },
    ],
  });
  await catalog.syncStoredConfig();
  const config = values.get("ai.config") as {
    channels: Array<{ models: Array<{ name: string }> }>;
  };
  assert.equal(config.channels[0].models[0].name, "生图");
});
