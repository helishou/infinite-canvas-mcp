import assert from "node:assert/strict";
// 双 runner：vitest 验收与项目 node:test runner 共用同一份用例。
type TestFn = (name: string, fn: () => void | Promise<void>) => void;
let test: TestFn;
if ((process.env as Record<string, string | undefined>).VITEST) {
    // @ts-ignore vitest 由 npx 临时提供
    test = (await import("vitest")).test as unknown as TestFn;
} else {
    test = (await import("node:test")).default as unknown as TestFn;
}
import { DramaPipeline } from "./pipeline.js";
import { H3_PARAM_KEYS, resolveH3Runtime } from "../canvas/h3-params.js";
import { withH3ParameterEdits } from "@basketikun/canvas-agent/plugins/minimax-h3/runtime-params";

type Call = { method: string; path: string; body?: any };

/** 极简假 store + 假 HTTP：只满足 runVideo / applyVideoResolution 真正用到的能力，不造假出片结果。 */
function makePipeline() {
    const calls: Call[] = [];
    const store = {
        all: () => [],
        approvalTargets: () => [],
        log: () => {},
        markRunning: () => {},
    } as any;
    const pipeline = new DramaPipeline({ store, token: "test-token" });
    (pipeline as any).request = async (method: string, path: string, body?: any) => {
        calls.push({ method, path, body });
        if (method === "GET" && path.startsWith("/drama/episodes/")) {
            return {
                canvas: {
                    id: "canvas-1",
                    nodes: [{ id: "n1", type: "minimax-h3:video", metadata: { segments: [{ id: "s1" }, { id: "s2" }] } }],
                },
            };
        }
        if (method === "GET" && path.startsWith("/canvas/projects/")) return { project: { revision: 7, nodes: [] } };
        if (method === "POST" && path.endsWith("/ops")) return { ok: true };
        if (method === "POST" && path === "/canvas/generation") return { taskId: `task-${calls.length}` };
        if (method === "GET" && path.startsWith("/tasks/")) return { task: { status: "succeeded", result: {} } };
        return {};
    };
    return { pipeline, calls };
}

const h3Nodes = () => [{ id: "n1", metadata: { segments: [{ id: "s1" }, { id: "s2" }] } }];
const job = () => ({ id: "job-1", drama_id: "drama-1", episode_id: "ep-1", kind: "video", stage: "video", attempt: 0 }) as any;

test("剧目级 videoResolution 真实写进 H3 段保存值（aspectRatio+megapixels），不是假开关", async () => {
    const { pipeline, calls } = makePipeline();
    const applied = await (pipeline as any).applyVideoResolution("canvas-1", h3Nodes(), "720p", "9:16");
    assert.deepEqual(applied, { segments: 2, size: "736x1280", resolution: "736", megapixels: 0.9, aspectRatio: "9:16" });
    const opsCall = calls.find((call) => call.method === "POST" && call.path.endsWith("/ops"));
    assert.ok(opsCall, "必须真实调用 update_h3_segment 写保存值");
    assert.equal(opsCall!.body.operations.length, 2);
    assert.equal(opsCall!.body.operations[0].type, "update_h3_segment");
    assert.deepEqual(opsCall!.body.operations[0].patch, { aspectRatio: "9:16", megapixels: 0.9 });
    assert.equal(opsCall!.body.expectedRevision, 7);
});

test("runVideo：设 720p + 9:16 后生成请求 params.size 真被覆盖为竖屏 736x1280", async () => {
    const { pipeline, calls } = makePipeline();
    (pipeline as any).runOptions.set("drama-1", { videoResolution: "720p", videoAspectRatio: "9:16", videoModel: "model-x" });
    await (pipeline as any).runVideo("ep-1", job());
    const genCall = calls.find((call) => call.method === "POST" && call.path === "/canvas/generation");
    assert.ok(genCall, "必须真的发起 H3 生成请求");
    assert.equal(genCall!.body.operation, "h3-run");
    assert.equal(genCall!.body.params.size, "736x1280", "生成请求的 size 已被剧目级档位覆盖");
    assert.equal(genCall!.body.params.resolution, "736");
    assert.equal(genCall!.body.params.selectedVideoModel, "model-x", "原有视频模型下发不被破坏");
    const opsCall = calls.find((call) => call.method === "POST" && call.path.endsWith("/ops"));
    assert.deepEqual(opsCall!.body.operations[0].patch, { aspectRatio: "9:16", megapixels: 0.9 });
});

test("runVideo：未设档位时不写段、不带 size，回退模型默认（无假开关）", async () => {
    const { pipeline, calls } = makePipeline();
    (pipeline as any).runOptions.set("drama-1", {});
    await (pipeline as any).runVideo("ep-1", job());
    assert.equal(calls.some((call) => call.method === "POST" && call.path.endsWith("/ops")), false, "未选档位不应写段");
    const genCall = calls.find((call) => call.method === "POST" && call.path === "/canvas/generation");
    assert.equal(genCall!.body.params?.size, undefined);
    assert.equal(genCall!.body.params?.resolution, undefined);
});

test("size/resolution 非 H3_PARAM_KEYS：随请求 override 透传到 H3 有效参数，不触发保存值一致性守卫", () => {
    const saved = { aspectRatio: "9:16", megapixels: 0.9 };
    const override = { size: "736x1280", resolution: "736" };
    const effective = resolveH3Runtime(saved, override, {}, {}).params;
    assert.equal(effective.size, "736x1280", "size 必须透传到 H3 runner 的有效参数");
    assert.equal(effective.resolution, "736");
    const baseline = resolveH3Runtime(saved, {}, {}, {}).params;
    const changedH3Keys = Object.keys(effective).filter((key) =>
        (H3_PARAM_KEYS as readonly string[]).includes(key) && JSON.stringify(effective[key]) !== JSON.stringify(baseline[key]));
    assert.deepEqual(changedH3Keys, [], "size/resolution 不改变任何 H3_PARAM_KEY，不会被 H3_UI_PARAMETER_MISMATCH 挡下");
});

test("写进保存值后，即使 Clip 处于 defaults 策略也真生效（op handler 自动登记 h3ParameterOverrides）", () => {
    const clip = { aspectRatio: "16:9", megapixels: 0.4, h3ParameterPolicy: "defaults" };
    const patch = withH3ParameterEdits(clip, { aspectRatio: "9:16", megapixels: 0.9 });
    const saved = { ...clip, ...patch };
    const effective = resolveH3Runtime(saved, {}, {}, { aspectRatio: "16:9", megapixels: 0.4 }).params;
    assert.equal(effective.aspectRatio, "9:16");
    assert.equal(effective.megapixels, 0.9);
});

test("runVideo：横屏 1080p 下发 1920x1088 与 megapixels=2", async () => {
    const { pipeline, calls } = makePipeline();
    (pipeline as any).runOptions.set("drama-1", { videoResolution: "1080p", videoAspectRatio: "16:9" });
    await (pipeline as any).runVideo("ep-1", job());
    const opsCall = calls.find((call) => call.method === "POST" && call.path.endsWith("/ops"));
    assert.deepEqual(opsCall!.body.operations[0].patch, { aspectRatio: "16:9", megapixels: 2 });
    const genCall = calls.find((call) => call.method === "POST" && call.path === "/canvas/generation");
    assert.equal(genCall!.body.params.size, "1920x1088");
});
