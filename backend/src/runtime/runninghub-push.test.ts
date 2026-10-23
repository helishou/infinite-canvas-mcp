import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { RunningHubBackend } from "./runninghub.js";
import { localGraphOf } from "./runninghub.js";
import type { SettingStore, TaskStore } from "../stores/types.js";

/** 全部用例都不触网：替换全局 fetch，记录请求并把平台响应喂回去。 */
function fakeSettings(): SettingStore {
    const store = new Map<string, unknown>();
    return { get: (key) => store.get(key), set: (key, value) => void store.set(key, value), delete: (key) => void store.delete(key) };
}
function fakeTasks(): TaskStore {
    return { list: () => [], get: () => undefined, create: () => ({}), events: () => [], update: () => ({}), addEvent: () => {} } as unknown as TaskStore;
}
function configured(overrides: Record<string, unknown> = {}) {
    const settings = fakeSettings();
    settings.set("runninghub.config", { baseUrl: "https://www.runninghub.ai", apiKey: "rh-key", mode: "workflow", workflowId: "", appId: "", fields: [], useWallet: false, instanceType: "default", concurrency: 1, ...overrides });
    return settings;
}
/** 网页会话令牌：2030 年才过期，避开过期分支。站点各自一份，不通用。 */
function withSession(settings: SettingStore, site: "default" | "ai" | "cn" = "default") {
    const key = site === "default" ? "runninghub.session" : `runninghub.session.${site}`;
    settings.set(key, { accessToken: jwt(2000000000), refreshToken: jwt(2100000000), expiresAt: 2000000000, source: "browser", updatedAt: new Date().toISOString() });
    return settings;
}
function jwt(exp: number) {
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${part({ alg: "HS512" })}.${part({ sub: "1", exp })}.signature`;
}

const graph = {
    "49": { class_type: "LoadImage", inputs: { image: "input.png" } },
    "6": { class_type: "KSampler", inputs: { model: ["38", 0], seed: 42 } },
};

type Capture = { url: string; body: string | undefined; headers: Record<string, string> };
let calls: Capture[] = [];
let realFetch: typeof fetch | undefined;

async function readBody(body: unknown): Promise<string | undefined> {
    if (typeof body === "string") return body;
    if (body instanceof FormData) {
        const parts: string[] = [];
        for (const [key, value] of body.entries()) parts.push(`${key}=${typeof value === "string" ? value : await (value as Blob).text()}`);
        return parts.join("\n");
    }
    return undefined;
}

/** 按路径返回平台响应：默认成功，getJsonApiFormat 返回 380（云端草稿读不到）。 */
function stubFetch(handler: (url: string, body: string | undefined) => unknown) {
    realFetch ??= globalThis.fetch;
    calls = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        const body = await readBody(init?.body);
        calls.push({ url, body, headers: (init?.headers || {}) as Record<string, string> });
        const payload = handler(url, body);
        return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
}
afterEach(() => { if (realFetch) globalThis.fetch = realFetch; });

test("没有网页会话时拒绝上传，并说清 API Key 不能用", async () => {
    const backend = new RunningHubBackend(fakeTasks(), configured());
    await assert.rejects(() => backend.pushWorkflowGraph({ name: "x", graph }), /请先连接\s*RunningHub\s*的网页账号/);
});

test("会话过期时拒绝上传", async () => {
    const settings = configured();
    settings.set("runninghub.session", { accessToken: jwt(1), expiresAt: 1, source: "browser" });
    const backend = new RunningHubBackend(fakeTasks(), settings);
    await assert.rejects(() => backend.pushWorkflowGraph({ name: "x", graph }), /会话已过期/);
});

test("节点图没有 class_type 时直接拒绝，不浪费一次上传", async () => {
    const backend = new RunningHubBackend(fakeTasks(), withSession(configured()));
    await assert.rejects(() => backend.pushWorkflowGraph({ name: "x", graph: { "1": { inputs: {} } } }), /不是 ComfyUI API 格式/);
});

test("上传到 RunningHub 并返回云端工作流 ID", async () => {
    stubFetch((url) => url.endsWith("/api/workflow/upload") ? { code: 0, msg: "success", data: { id: "2113661223828258818" } } : { code: 500 });
    const backend = new RunningHubBackend(fakeTasks(), withSession(configured()));
    const result = await backend.pushWorkflowGraph({ name: "我的工作流", graph });

    assert.equal(result.workflowId, "2113661223828258818");
    const upload = calls.find((call) => call.url.endsWith("/api/workflow/upload"));
    assert.ok(upload, "应调用网页端上传接口");
    assert.equal(upload?.headers.Authorization, `Bearer ${"ey" + jwt(2000000000).slice(2)}`, "会话令牌走 Authorization 头");
    const raw = String(upload?.body || "");
    assert.ok(raw.includes("workflowName=我的工作流"), " multipart 必须带 workflowName");
    assert.ok(raw.includes("workflowFile=") && raw.includes("LoadImage"), "multipart 必须带 workflowFile 原图");
});

test("云端草稿读不回节点图时，用上传的这份图建档并标记 cloudRead=false", async () => {
    stubFetch((url) => url.endsWith("/api/workflow/upload")
        ? { code: 0, msg: "success", data: { id: "RH-DRAFT" } }
        : { code: 380, msg: "WORKFLOW_NOT_EXISTS", errorMessages: null, data: null });
    const backend = new RunningHubBackend(fakeTasks(), withSession(configured()));
    const result = await backend.publishLocalWorkflow({ name: "草稿流", graph });

    assert.equal(result.workflowId, "RH-DRAFT");
    assert.equal(result.cloudRead, false, "平台读不到图要如实标记");
    assert.equal(result.profile.workflowId, "RH-DRAFT");
    assert.deepEqual(result.profile.workflowJson, graph, "档案保留本地上传的那份图");
    assert.ok(result.profile.fields.some((field) => field.nodeId === "49" && field.fieldName === "image"), "字段从本地图发现");
    assert.ok(backend.listWorkflowProfiles().some((profile) => profile.id === result.profile.id), "上传后已经自动建档");
});

test("云端可读时用平台图建档", async () => {
    stubFetch((url) => url.endsWith("/api/workflow/upload")
        ? { code: 0, msg: "success", data: { id: "RH-LIVE" } }
        : { code: 0, msg: "success", data: { prompt: JSON.stringify(graph) } });
    const backend = new RunningHubBackend(fakeTasks(), withSession(configured()));
    const result = await backend.publishLocalWorkflow({ name: "云端流", graph });

    assert.equal(result.cloudRead, true);
    assert.deepEqual(result.profile.workflowJson, graph);
});

test("上传成功但平台没给 ID 时不建档", async () => {
    stubFetch(() => ({ code: 0, msg: "success", data: {} }));
    const backend = new RunningHubBackend(fakeTasks(), withSession(configured()));
    await assert.rejects(() => backend.publishLocalWorkflow({ name: "x", graph }), /没有返回工作流 ID/);
    assert.equal(backend.listWorkflowProfiles().length, 0);
});

test("站点 cn 上传到国内站，且用该站点自己的会话令牌", async () => {
    stubFetch((url) => url.endsWith("/api/workflow/upload") ? { code: 0, msg: "success", data: { id: "CN-1" } } : { code: 380, msg: "WORKFLOW_NOT_EXISTS" });
    const settings = withSession(configured(), "cn");
    settings.set("runninghub.session", { accessToken: jwt(1), expiresAt: 1, source: "browser" });
    const backend = new RunningHubBackend(fakeTasks(), settings);
    const result = await backend.pushWorkflowGraph({ name: "国内站流", graph, site: "cn" });

    assert.equal(result.workflowId, "CN-1");
    assert.equal(result.site, "cn");
    const upload = calls.find((call) => call.url.endsWith("/api/workflow/upload"));
    assert.ok(upload?.url.startsWith("https://www.runninghub.cn/"), "必须打国内站");
    assert.ok(!upload?.url.startsWith("https://www.runninghub.ai/"), "不能打到运行环境那条链路");
});

test("默认站点跟随运行环境地址", async () => {
    stubFetch((url) => url.endsWith("/api/workflow/upload") ? { code: 0, msg: "success", data: { id: "AI-1" } } : { code: 380 });
    const backend = new RunningHubBackend(fakeTasks(), withSession(configured({ baseUrl: "https://www.runninghub.ai" })));
    await backend.pushWorkflowGraph({ name: "默认链路", graph });
    const upload = calls.find((call) => call.url.endsWith("/api/workflow/upload"));
    assert.ok(upload?.url.startsWith("https://www.runninghub.ai/"), "default 走 config.baseUrl");
});

test("选了站点但没连那个站点的会话时，提示连哪个站", async () => {
    const backend = new RunningHubBackend(fakeTasks(), withSession(configured(), "ai"));
    await assert.rejects(() => backend.pushWorkflowGraph({ name: "x", graph, site: "cn" }), /runninghub\.cn（国内站）/);
});

test("站点与运行环境同域时共用运行环境那份会话，不要求重连", async () => {
    stubFetch((url) => url.endsWith("/api/workflow/upload") ? { code: 0, msg: "success", data: { id: "AI-2" } } : { code: 380 });
    const backend = new RunningHubBackend(fakeTasks(), withSession(configured({ baseUrl: "https://www.runninghub.ai" })));
    const result = await backend.pushWorkflowGraph({ name: "国际站", graph, site: "ai" });
    assert.equal(result.workflowId, "AI-2", "同域时不必再连一次");
    assert.equal(backend.sessionStatus("ai").connected, true, "状态也显示为已连接");
});

test("非默认站点没有自己的 API Key 时，同步前就拒绝并说要去哪拿", async () => {
    const backend = new RunningHubBackend(fakeTasks(), withSession(configured({ siteApiKeys: { ai: "", cn: "" } }), "cn"));
    await assert.rejects(() => backend.inspectWorkflow("CN-1", "cn"), /还没有配置 API Key/);
});

test("建档记住站点，重新同步打同一个站", async () => {
    stubFetch((url) => url.endsWith("/api/workflow/upload")
        ? { code: 0, msg: "success", data: { id: "CN-2" } }
        : url.includes("/api/openapi/getJsonApiFormat") ? { code: 0, msg: "success", data: { prompt: JSON.stringify(graph) } } : { code: 500 });
    const settings = withSession(configured({ siteApiKeys: { ai: "", cn: "cn-key" } }), "cn");
    const backend = new RunningHubBackend(fakeTasks(), settings);
    const result = await backend.publishLocalWorkflow({ name: "国内站流", graph, site: "cn" });

    assert.equal(result.profile.site, "cn", "档案要记住站点");
    assert.equal(result.cloudRead, true);
    const inspect = calls.find((call) => call.url.includes("/api/openapi/getJsonApiFormat"));
    assert.ok(inspect?.url.startsWith("https://www.runninghub.cn/"), "同步必须打国内站");
    calls = [];
    await backend.refreshProfileGraph(result.profile.id);
    assert.ok(calls.some((call) => call.url.startsWith("https://www.runninghub.cn/")), "重新同步也走档案所属站点");
});

test("任务参数里的本地图只有 API 格式才作兜底", () => {
    assert.deepEqual(localGraphOf({ runninghubGraph: graph }), graph);
    assert.equal(localGraphOf({ runninghubGraph: { "1": { inputs: {} } } }), null);
    assert.equal(localGraphOf({}), null);
});
