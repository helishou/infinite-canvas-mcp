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
  resolveWorkflowBindingForModel,
  resolveWorkflowForModel,
  scenarioFromReferenceCount,
  usesRunningHubBinding,
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
          workflows: [
            "custom/krea2改图.json",
            "custom/krea2双图编辑.json",
            "custom/Krea2文生图.json",
          ],
          workflowRouting: {
            text: "custom/Krea2文生图.json",
            single: "custom/krea2改图.json",
            multi: "custom/krea2双图编辑.json",
          },
          workflowParams: { text: { seed: -1 }, multi: { f_demo: 16 } },
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

test("krea2 文生（0 张参考）→ Krea2 文生图工作流", () => {
  const r = resolveWorkflowForModel(config, "krea2", 0);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.workflow, "custom/Krea2文生图.json");
  assert.deepEqual(r.ok && r.params, { seed: -1 });
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

const RH_CHANNEL_ID = "rh-channel";
const RH_PROFILE_ID = "2efeb650-2c9f-494b-80af-1e5c661c4730";

test("只挂 RunningHub 绑定的模型也算走工作流路由，不被当直连模型", () => {
  const onlyCloud = {
    channels: [
      {
        id: RH_CHANNEL_ID,
        name: "RunningHub",
        kind: "comfyui",
        models: [
          {
            name: "纯云端",
            capability: "image",
            workflowBindings: {
              text: { provider: "runninghub", profileId: RH_PROFILE_ID },
            },
          },
        ],
      },
    ],
  };
  assert.equal(usesWorkflowExecutor(onlyCloud, "纯云端"), true);
});

test("显式 comfyui 绑定与旧路由解析结果一致", () => {
  const resolved = resolveWorkflowBindingForModel(config, "krea2", 2);
  assert.equal(resolved.ok, true);
  assert.deepEqual(resolved.ok && resolved.binding, {
    provider: "comfyui",
    workflow: "custom/krea2双图编辑.json",
  });
  assert.equal(resolved.ok && resolved.scenario, "multi");
  assert.deepEqual(resolved.ok && resolved.params, { f_demo: 16 });
});

test("旧 routing 的不支持哨兵仍然优先于回落", () => {
  const resolved = resolveWorkflowBindingForModel(config, "四视图", 2);
  assert.equal(resolved.ok, false);
  assert.equal(!resolved.ok && resolved.reason, "unsupported");
});

test("RunningHub 绑定解析出 profileId，且不当作本地工作流", () => {
  const rhConfig = {
    channels: [
      {
        id: RH_CHANNEL_ID,
        name: "RunningHub",
        kind: "comfyui",
        models: [
          {
            name: "云端生视频",
            capability: "video",
            workflows: ["custom/h3-local-t2va.json"],
            workflowBindings: {
              text: { provider: "runninghub", profileId: RH_PROFILE_ID },
              single: { provider: "comfyui", workflow: "custom/h3-local-t2va.json" },
            },
            workflowParams: { text: { seed: 7 } },
          },
        ],
      },
    ],
  };
  const text = resolveWorkflowBindingForModel(rhConfig, "云端生视频", 0);
  assert.deepEqual(text.ok && text.binding, {
    provider: "runninghub",
    profileId: RH_PROFILE_ID,
  });
  assert.deepEqual(text.ok && text.params, { seed: 7 });

  const single = resolveWorkflowBindingForModel(rhConfig, "云端生视频", 1);
  assert.deepEqual(single.ok && single.binding, {
    provider: "comfyui",
    workflow: "custom/h3-local-t2va.json",
  });

  // 未显式绑定的 multi 场景回落到旧 workflows[0]，仍是 comfyui。
  const multi = resolveWorkflowBindingForModel(rhConfig, "云端生视频", 2);
  assert.deepEqual(multi.ok && multi.binding, {
    provider: "comfyui",
    workflow: "custom/h3-local-t2va.json",
  });

  assert.equal(usesRunningHubBinding(rhConfig, "云端生视频", 0), true);
  assert.equal(usesRunningHubBinding(rhConfig, "云端生视频", 1), false);
});

test("绑定的 provider 缺失或为空时忽略，不产生半成品绑定", () => {
  const broken = {
    channels: [
      {
        id: RH_CHANNEL_ID,
        name: "RunningHub",
        kind: "comfyui",
        models: [
          {
            name: "坏配置",
            capability: "video",
            workflows: ["custom/a.json"],
            workflowBindings: {
              text: { provider: "runninghub" },
              single: { provider: "unknown", workflow: "custom/a.json" },
              multi: "custom/a.json",
            },
          },
        ],
      },
    ],
  };
  const text = resolveWorkflowBindingForModel(broken, "坏配置", 0);
  assert.deepEqual(text.ok && text.binding, {
    provider: "comfyui",
    workflow: "custom/a.json",
  });
  const single = resolveWorkflowBindingForModel(broken, "坏配置", 1);
  assert.deepEqual(single.ok && single.binding, {
    provider: "comfyui",
    workflow: "custom/a.json",
  });
  const multi = resolveWorkflowBindingForModel(broken, "坏配置", 2);
  assert.deepEqual(multi.ok && multi.binding, {
    provider: "comfyui",
    workflow: "custom/a.json",
  });
});

test("没有实现时仍返回 no-workflow，不误判成 RunningHub", () => {
  const resolved = resolveWorkflowBindingForModel(config, "某个没配的模型", 0);
  assert.equal(resolved.ok, false);
  assert.equal(!resolved.ok && resolved.reason, "no-workflow");
  assert.equal(usesRunningHubBinding(config, "某个没配的模型", 0), false);
});
