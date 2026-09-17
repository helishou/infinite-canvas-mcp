/**
 * model-workflow 解析的单测。
 *
 * 用例全部取自真实配置（runtime_settings.ai.config 里的「本地 ComfyUI」渠道），
 * 保证后端解析结果与前端 resolveModelWorkflow 一致。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  WORKFLOW_ROUTE_UNSUPPORTED,
  builtinWorkflowName,
  decodeChannelModel,
  findChannelModel,
  modelOptionName,
  resolveWorkflowForModel,
  scenarioFromReferenceCount,
  usesWorkflowExecutor,
  workflowResolutionMessage,
} from "../canvas/model-workflow.js";

const CHANNEL_ID = "jHZtzUbFPgBUhrl5KtfIr";

const config = {
  channels: [
    {
      id: "default",
      name: "默认渠道",
      kind: "api",
      models: [
        { name: "gpt-5-6", capability: "text" },
        { name: "gpt-image-2", capability: "image" },
      ],
    },
    {
      id: CHANNEL_ID,
      name: "本地 ComfyUI",
      kind: "comfyui",
      models: [
        {
          name: "四视图",
          capability: "image",
          workflows: [
            "custom/图生四视图.json",
            "custom/krea2人物多角度图.json",
          ],
          workflowRouting: {
            text: "custom/krea2人物多角度图.json",
            single: "custom/图生四视图.json",
            multi: WORKFLOW_ROUTE_UNSUPPORTED,
          },
        },
        {
          name: "krea2",
          capability: "image",
          workflows: ["custom/krea2改图.json", "custom/krea2双图编辑.json"],
          workflowRouting: {
            text: WORKFLOW_ROUTE_UNSUPPORTED,
            single: "custom/krea2改图.json",
            multi: "custom/krea2双图编辑.json",
          },
          workflowParams: { multi: { f_demo: 16 } },
        },
        { name: "custom/seevr图像放大.json", capability: "image" },
      ],
    },
  ],
};

test("scenarioFromReferenceCount：0/1/≥2 → text/single/multi", () => {
  assert.equal(scenarioFromReferenceCount(0), "text");
  assert.equal(scenarioFromReferenceCount(1), "single");
  assert.equal(scenarioFromReferenceCount(2), "multi");
  assert.equal(scenarioFromReferenceCount(9), "multi");
});

test("decodeChannelModel / modelOptionName 拆渠道前缀", () => {
  assert.deepEqual(decodeChannelModel(`${CHANNEL_ID}::krea2`), {
    channelId: CHANNEL_ID,
    model: "krea2",
  });
  assert.equal(decodeChannelModel("krea2"), null);
  assert.equal(modelOptionName(`${CHANNEL_ID}::krea2`), "krea2");
  assert.equal(modelOptionName("krea2"), "krea2");
});

test("findChannelModel：既能按 channelId::model 也能按纯模型名定位", () => {
  assert.equal(
    findChannelModel(config, `${CHANNEL_ID}::krea2`)?.model.name,
    "krea2",
  );
  assert.equal(findChannelModel(config, "krea2")?.model.name, "krea2");
  assert.equal(findChannelModel(config, "不存在的模型"), null);
});

test("krea2 单图 → krea2改图；多图 → krea2双图编辑（这就是 MCP 传模型名要拿到的东西）", () => {
  const single = resolveWorkflowForModel(config, "krea2", 1);
  assert.equal(single.ok, true);
  assert.equal(single.ok && single.workflow, "custom/krea2改图.json");

  const multi = resolveWorkflowForModel(config, "krea2", 2);
  assert.equal(multi.ok, true);
  assert.equal(multi.ok && multi.workflow, "custom/krea2双图编辑.json");
  // 场景参数覆盖必须带出来
  assert.deepEqual(multi.ok && multi.params, { f_demo: 16 });
});

test("krea2 文生（0 张参考）被标记不支持 → 明确失败且不回退", () => {
  const r = resolveWorkflowForModel(config, "krea2", 0);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, "unsupported");
  assert.match(workflowResolutionMessage(r as never), /不支持文生图输入/);
});

test("带渠道前缀与不带前缀结果一致", () => {
  const a = resolveWorkflowForModel(config, "krea2", 2);
  const b = resolveWorkflowForModel(config, `${CHANNEL_ID}::krea2`, 2);
  assert.equal(a.ok && a.workflow, b.ok && b.workflow);
});

test("「四视图」多图被标记不支持 → 报错而不是回退到第一个工作流", () => {
  const r = resolveWorkflowForModel(config, "四视图", 3);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, "unsupported");
});

test("只配 workflows 没配 routing → 用列表第一个", () => {
  const cfg = {
    channels: [
      {
        id: "c",
        models: [{ name: "m", workflows: ["custom/a.json", "custom/b.json"] }],
      },
    ],
  };
  const r = resolveWorkflowForModel(cfg, "c::m", 2);
  assert.equal(r.ok && r.workflow, "custom/a.json");
});

test("工作流路径不能再作为模型名直接运行", () => {
  const r = resolveWorkflowForModel(config, "custom/krea2改图.json", 1);
  assert.equal(r.ok, false);
  assert.equal(builtinWorkflowName("custom/krea2改图.json"), "");
  assert.equal(builtinWorkflowName("Z-Image.json"), "");
  assert.equal(builtinWorkflowName("z-image"), "Z-Image.json");
});

test("ComfyUI 模型未绑定内部实现时明确失败", () => {
  const r = resolveWorkflowForModel(
    config,
    `${CHANNEL_ID}::custom/seevr图像放大.json`,
    1,
  );
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, "no-workflow");
});

test("未配置的模型名 → no-workflow（不回退到别的模型）", () => {
  const r = resolveWorkflowForModel(config, "某个没配的模型", 2);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, "no-workflow");
  assert.match(workflowResolutionMessage(r as never), /没有可用的本地实现/);
});

test("usesWorkflowExecutor：ComfyUI 渠道统一走工作流，API 渠道保持直连", () => {
  assert.equal(usesWorkflowExecutor(config, "krea2"), true);
  assert.equal(usesWorkflowExecutor(config, "四视图"), true);
  assert.equal(
    usesWorkflowExecutor(config, `${CHANNEL_ID}::custom/seevr图像放大.json`),
    true,
  );
  assert.equal(usesWorkflowExecutor(config, "gpt-image-2"), false);
  assert.equal(usesWorkflowExecutor(config, "gpt-5-6"), false);
});
