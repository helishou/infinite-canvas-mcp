/**
 * 模型绑定 RunningHub 工作流档案后的执行链路回归测试。
 *
 * 覆盖真实缺口：内部实现列表此前只有本地 ComfyUI 工作流，RunningHub 档案
 * 既无法被模型路由引用，也无法真正执行。这些用例用 fake RunningHub 后端
 * 验证分发路径，不发起任何真实云端请求。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { CanvasImageDispatcher, executionImageInputs } from "./image-dispatcher.js";
import { CanvasVideoDispatcher } from "./video-dispatcher.js";
import {
  resolveWorkflowBindingForModel,
  usesRunningHubBinding,
} from "./model-workflow.js";

const PROFILE_ID = "2efeb650-2c9f-494b-80af-1e5c661c4730";
const CHANNEL_ID = "local-comfyui";

function aiConfig(models: unknown[]) {
  return {
    channels: [
      {
        id: CHANNEL_ID,
        name: "本地 ComfyUI",
        kind: "comfyui",
        models,
      },
    ],
  };
}

const cloudModel = {
  name: "云端生视频",
  capability: "video",
  workflowBindings: {
    text: { provider: "runninghub", profileId: PROFILE_ID },
  },
};

const localModel = {
  name: "本地生视频",
  capability: "video",
  workflows: ["custom/h3-local-t2va.json"],
  workflowRouting: { text: "custom/h3-local-t2va.json" },
};

test("绑定的模型按参考数走对应实现：0 张走云端，1 张走本地", () => {
  const config = aiConfig([cloudModel, localModel]);
  assert.equal(usesRunningHubBinding(config, "云端生视频", 0), true);
  assert.equal(usesRunningHubBinding(config, "云端生视频", 1), false);
  const resolved = resolveWorkflowBindingForModel(config, "云端生视频", 0);
  assert.deepEqual(resolved.ok && resolved.binding, {
    provider: "runninghub",
    profileId: PROFILE_ID,
  });
});

test("executionImageInputs：循环图在前、固定参考图在后", () => {
  const loop = { storageKey: "loop" };
  const fixed = [{ storageKey: "a" }, { storageKey: "b" }];
  assert.deepEqual(executionImageInputs({ loopInputImages: [loop], references: fixed }), [
    loop,
    ...fixed,
  ]);
  assert.deepEqual(executionImageInputs({}), []);
});

test("图片任务：RunningHub 绑定走 runWorkflow，本地执行器不被调用", async () => {
  const calls: Array<{ profileId: string; input: unknown; values: unknown; overrides: unknown; clientTaskId?: string }> = [];
  const childId = "runninghub-child-canvas-1";
  const media = { url: "/media/a.png", storageKey: "image:a", mimeType: "image/png" };

  const tasks = new Map<string, Record<string, unknown>>();
  tasks.set(childId, {
    id: childId,
    kind: "runninghub:workflow",
    status: "succeeded",
    progress: 1,
    input: {},
    params: {},
    createdAt: "",
    updatedAt: "",
    result: { media: [media] },
  });
  // 父任务不预置：start() 必须真的创建并派发，否则会命中既有任务早退。
  const parent = "canvas-1";

  const taskStore = {
    get: (id: string) => tasks.get(id),
    list: () => [],
    create: (id: string, kind: string, input: unknown, params: unknown) => {
      const created = { id, kind, status: "queued", progress: 0, input, params, createdAt: "", updatedAt: "" };
      tasks.set(id, created);
      return created;
    },
    update: (id: string, patch: Record<string, unknown>) => {
      const current = tasks.get(id);
      if (!current) return undefined;
      const next = { ...current, ...patch };
      tasks.set(id, next);
      return next;
    },
    addEvent: () => {},
    cancel: (id: string) => {
      const current = tasks.get(id);
      if (!current) return undefined;
      const next = { ...current, status: "cancelled" };
      tasks.set(id, next);
      return next;
    },
    events: () => [],
  };

  const runningHub = {
    runWorkflow: async (profileId: string, input: unknown, values: unknown, overrides: unknown, clientTaskId?: string) => {
      calls.push({ profileId, input, values, overrides, clientTaskId });
      return tasks.get(childId);
    },
    cancel: () => {},
    resume: () => {},
  };

  const dispatcher = new CanvasImageDispatcher(
    { token: "t", url: "http://127.0.0.1:17370" } as never,
    {
      settings: { get: () => aiConfig([cloudModel]) },
      tasks: taskStore,
      media: { meta: (key: string) => (key === "image:seed" ? { storageKey: key, mimeType: "image/png" } : null), store: () => ({ storageKey: "x" }), url: () => "/media/x", read: () => Promise.resolve(Buffer.alloc(0)) },
      projects: { get: () => undefined, applyOperations: () => {} },
      logs: { create: () => ({}), update: () => {} },
    } as never,
    {} as never,
    { supports: () => false } as never,
    { get: () => Promise.reject(new Error("不应读取本地工作流")) } as never,
    { run: () => { throw new Error("不应进入本地 WorkflowExecutor"); }, cancel: () => {} } as never,
    undefined,
    runningHub as never,
  );

  // 文生场景（0 张参考）才是本模型绑定的云端场景。
  await dispatcher.start({
    model: "云端生视频",
    prompt: "日出",
    count: 1,
    params: { seed: 42 },
    clientTaskId: parent,
  });

  assert.equal(calls.length, 1, "应只提交一次 RunningHub 任务");
  assert.equal(calls[0].profileId, PROFILE_ID);
  assert.equal(calls[0].clientTaskId, childId);
  assert.deepEqual(calls[0].values, { seed: 42 });
  assert.equal((calls[0].overrides as Record<string, unknown>).parentTaskId, parent);
  assert.equal((calls[0].input as Record<string, unknown>).prompt, "日出");
});

test("图片任务：场景未绑定时不回落到云端，明确报没有可用实现", async () => {
  let submitted = 0;
  const dispatcher = new CanvasImageDispatcher(
    { token: "t", url: "http://127.0.0.1:17370" } as never,
    {
      settings: { get: () => aiConfig([cloudModel]) },
      tasks: { get: () => undefined, list: () => [], create: () => ({}), update: () => undefined, addEvent: () => {}, cancel: () => undefined, events: () => [] },
      media: { meta: (key: string) => (key === "image:seed" ? { storageKey: key, mimeType: "image/png" } : null) },
    } as never,
    {} as never,
    { supports: () => false } as never,
    {} as never,
    { run: () => { throw new Error("不应进入本地 WorkflowExecutor"); } } as never,
    undefined,
    { runWorkflow: async () => { submitted += 1; return { id: "x" }; } } as never,
  );

  assert.throws(
    () =>
      dispatcher.start({
        model: "云端生视频",
        prompt: "日出",
        references: [{ storageKey: "image:seed", mimeType: "image/png" }],
        count: 1,
        clientTaskId: "canvas-3",
      }),
    /没有可用的本地实现/,
  );
  assert.equal(submitted, 0, "未绑定场景不得提交云端任务");
});

test("图片任务：绑定 RunningHub 但未注入执行器时明确报错，不回落本地", () => {
  const dispatcher = new CanvasImageDispatcher(
    { token: "t", url: "http://127.0.0.1:17370" } as never,
    { settings: { get: () => aiConfig([cloudModel]) } } as never,
    {} as never,
    { supports: () => false } as never,
    {} as never,
    {} as never,
  );
  assert.throws(
    () => dispatcher.start({ model: "云端生视频", prompt: "日出", count: 1, clientTaskId: "canvas-2" }),
    /未初始化 RunningHub 执行器/,
  );
});

test("视频任务：RunningHub 绑定走 runWorkflow 并按视频媒体回写", async () => {
  const calls: Array<{ profileId: string; overrides: unknown; clientTaskId?: string }> = [];
  const parent = "canvas-video-1";
  const childId = `video-runninghub-child-${parent}`;
  const tasks = new Map<string, Record<string, unknown>>();
  tasks.set(childId, {
    id: childId,
    kind: "runninghub:workflow",
    status: "succeeded",
    progress: 1,
    input: {},
    params: {},
    createdAt: "",
    updatedAt: "",
    result: { media: [{ url: "/media/v.mp4", storageKey: "video:v", mimeType: "video/mp4" }] },
  });

  const taskStore = {
    get: (id: string) => tasks.get(id),
    list: () => [],
    create: (id: string, kind: string, input: unknown, params: unknown) => {
      const created = { id, kind, status: "queued", progress: 0, input, params, createdAt: "", updatedAt: "" };
      tasks.set(id, created);
      return created;
    },
    update: (id: string, patch: Record<string, unknown>) => {
      const current = tasks.get(id);
      if (!current) return undefined;
      const next = { ...current, ...patch };
      tasks.set(id, next);
      return next;
    },
    addEvent: () => {},
    cancel: (id: string) => {
      const current = tasks.get(id);
      if (!current) return undefined;
      const next = { ...current, status: "cancelled" };
      tasks.set(id, next);
      return next;
    },
    events: () => [],
  };

  const dispatcher = new CanvasVideoDispatcher(
    {
      settings: { get: () => aiConfig([cloudModel]) },
      tasks: taskStore,
      projects: { get: () => undefined, applyOperations: () => {}, writeBackCanvasVideoTask: () => true, markCanvasVideoTaskFailed: () => {} },
      media: { meta: () => null, store: () => ({ storageKey: "x" }), url: () => "/media/x", read: () => Promise.resolve(Buffer.alloc(0)) },
    } as never,
    {} as never,
    { get: () => Promise.reject(new Error("不应读取本地工作流")) } as never,
    { run: () => { throw new Error("不应进入本地 WorkflowExecutor"); }, cancel: () => {} } as never,
    { trim: () => Promise.resolve({ id: "x" }), run: () => Promise.resolve({ id: "x" }), cancel: () => {} } as never,
    undefined,
    {
      runWorkflow: async (profileId: string, _input: unknown, _values: unknown, overrides: unknown, clientTaskId?: string) => {
        calls.push({ profileId, overrides, clientTaskId });
        return tasks.get(childId);
      },
      cancel: () => {},
      resume: () => {},
    } as never,
  );

  const result = dispatcher.start({
    model: "云端生视频",
    prompt: "镜头推进",
    seconds: "6",
    clientTaskId: parent,
  });

  assert.equal(result.executor, "runninghub-workflow");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].profileId, PROFILE_ID);
  assert.equal(calls[0].clientTaskId, childId);
  assert.equal((calls[0].overrides as Record<string, unknown>).parentTaskId, parent);
});

test("视频任务：重复 clientTaskId 复用既有任务，不重复提交云端", async () => {
  let submissions = 0;
  const parent = "canvas-video-2";
  const tasks = new Map<string, Record<string, unknown>>();
  const taskStore = {
    get: (id: string) => tasks.get(id),
    list: () => [],
    create: (id: string, kind: string, input: unknown, params: unknown) => {
      const created = { id, kind, status: "queued", progress: 0, input, params, createdAt: "", updatedAt: "" };
      tasks.set(id, created);
      return created;
    },
    update: (id: string, patch: Record<string, unknown>) => {
      const current = tasks.get(id);
      if (!current) return undefined;
      const next = { ...current, ...patch };
      tasks.set(id, next);
      return next;
    },
    addEvent: () => {},
    cancel: () => undefined,
    events: () => [],
  };
  const dispatcher = new CanvasVideoDispatcher(
    {
      settings: { get: () => aiConfig([cloudModel]) },
      tasks: taskStore,
      logs: { create: () => ({ id: "log-1" }), list: () => [] },
      projects: { get: () => undefined, applyOperations: () => {}, writeBackCanvasVideoTask: () => true, markCanvasVideoTaskFailed: () => {} },
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    undefined,
    {
      runWorkflow: async () => {
        submissions += 1;
        return { id: "child" };
      },
      cancel: () => {},
      resume: () => {},
    } as never,
  );

  dispatcher.start({ model: "云端生视频", prompt: "a", clientTaskId: parent });
  dispatcher.start({ model: "云端生视频", prompt: "a", clientTaskId: parent });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(submissions, 1, "同一 clientTaskId 不得二次提交 RunningHub");
});