import assert from "node:assert/strict";
import test from "node:test";

import { pluginMcp } from "./mcp.js";
import { mergeStoryboardInput } from "./storyboard-write.js";

function fixture() {
    const project: any = {
        id: "project-1",
        revision: 4,
        nodes: [
            {
                id: "h3-1",
                type: "minimax-h3",
                metadata: {
                    segments: [{ id: "s1", status: "idle", duration: 10, taskMode: "i2va", prompt: "", referenceBindings: [] }],
                },
            },
        ],
        connections: [],
        referenceCatalog: [],
    };
    const calls: any[] = [];
    const backend = {
        backendUrl: "http://backend.test",
        getCanvasProject: async (projectId: string) => projectId === project.id ? project : null,
        applyCanvasOperations: async (_projectId: string, operations: any[], _revision?: number) => {
            calls.push(operations);
            for (const operation of operations) {
                if (operation.type !== "update_h3_segment") continue;
                const node = project.nodes.find((item: any) => item.id === operation.nodeId);
                const segment = node.metadata.segments.find((item: any) => item.id === operation.segmentId);
                Object.assign(segment, operation.patch);
            }
            project.revision += 1;
            return { project, revision: project.revision, operationResults: [] };
        },
    };
    const context: any = {
        backend,
        getCanvasProject: async (projectId: string) => projectId === project.id ? project : null,
        getCanvasNode: async (id: string) => project.nodes.find((node: any) => node.id === id) || null,
        getCanvasNodes: async () => project.nodes,
    };
    return { project, calls, handlers: pluginMcp.createHandler(context) };
}

const fullWrite = {
    projectId: "project-1",
    nodeId: "h3-1",
    segmentId: "s1",
    openingDescription: "深夜卧房，油灯将熄。",
    shots: [
        { id: "shot-1", description: "沈砚推门而入，目光扫过倒地的药架。" },
        { id: "shot-2", description: "红绡从屏风后走出，抬手挡住灯影。" },
    ],
    overallSoundscape: "门轴轻响，远处更鼓。",
    nonDiegeticMusic: "低弦持续音。",
};

test("首次写入建立结构化基线，之后只改一镜不影响其余镜头", async () => {
    const { project, handlers } = fixture();
    const first: any = await handlers.h3_write_storyboard_prompt!(fullWrite);
    assert.equal(first.established, true);
    assert.deepEqual(first.shotIds, ["shot-1", "shot-2"]);
    const baseline = project.nodes[0].metadata.segments[0].storyboardInput;
    assert.equal(baseline.shots.length, 2);
    assert.equal(baseline.shots[0].description, "沈砚推门而入，目光扫过倒地的药架。");

    const second: any = await handlers.h3_write_storyboard_prompt!({
        projectId: "project-1",
        nodeId: "h3-1",
        segmentId: "s1",
        shots: [{ id: "shot-2", description: "红绡反手扣住灯盏，火苗斜倒。" }],
    });
    assert.equal(second.established, false);
    assert.deepEqual(second.changedShotIds, ["shot-2"]);
    const after = project.nodes[0].metadata.segments[0];
    assert.equal(after.storyboardInput.shots[0].description, "沈砚推门而入，目光扫过倒地的药架。");
    assert.equal(after.storyboardInput.shots[1].description, "红绡反手扣住灯盏，火苗斜倒。");
    // 省略的开场、声景与配乐沿用基线，不应被清空。
    assert.equal(after.storyboardInput.openingDescription, "深夜卧房，油灯将熄。");
    assert.equal(after.storyboardInput.overallSoundscape, "门轴轻响，远处更鼓。");
    assert.equal(after.storyboardInput.nonDiegeticMusic, "低弦持续音。");
    assert.match(after.prompt, /红绡反手扣住灯盏/);
});

test("只改开场描述时不传 shots，镜头列表保持原样", async () => {
    const { project, handlers } = fixture();
    await handlers.h3_write_storyboard_prompt!(fullWrite);
    const result: any = await handlers.h3_write_storyboard_prompt!({ projectId: "project-1", nodeId: "h3-1", segmentId: "s1", openingDescription: "黎明前的卧房，灯火已熄。" });
    assert.deepEqual(result.changedShotIds, []);
    const baseline = project.nodes[0].metadata.segments[0].storyboardInput;
    assert.equal(baseline.openingDescription, "黎明前的卧房，灯火已熄。");
    assert.equal(baseline.shots.length, 2);
    assert.equal(baseline.shots[1].description, "红绡从屏风后走出，抬手挡住灯影。");
});

test("未知镜头 id 与无基线首写都被拒绝，并指出可用的 id", async () => {
    const { handlers } = fixture();
    await assert.rejects(
        () => handlers.h3_write_storyboard_prompt!({ projectId: "project-1", nodeId: "h3-1", segmentId: "s1" }),
        /STORYBOARD_SHOTS_REQUIRED/,
    );
    await handlers.h3_write_storyboard_prompt!(fullWrite);
    await assert.rejects(
        () => handlers.h3_write_storyboard_prompt!({ projectId: "project-1", nodeId: "h3-1", segmentId: "s1", shots: [{ id: "shot-9", description: "新增一镜" }] }),
        /STORYBOARD_SHOT_UNKNOWN.*shot-1、shot-2/,
    );
});

test("增量改动 same-value 时不产生新的写入", async () => {
    const { project, calls, handlers } = fixture();
    await handlers.h3_write_storyboard_prompt!(fullWrite);
    const revisionAfterFirst = project.revision;
    const callCount = calls.length;
    const again: any = await handlers.h3_write_storyboard_prompt!({ projectId: "project-1", nodeId: "h3-1", segmentId: "s1", shots: [{ id: "shot-1", description: "沈砚推门而入，目光扫过倒地的药架。" }] });
    assert.equal(again.unchanged, true);
    assert.equal(project.revision, revisionAfterFirst);
    assert.equal(calls.length, callCount);
});

test("dryRun 返回将改动哪些镜头且不写库", async () => {
    const { project, calls, handlers } = fixture();
    await handlers.h3_write_storyboard_prompt!(fullWrite);
    const revision = project.revision;
    const preview: any = await handlers.h3_write_storyboard_prompt!({ ...fullWrite, dryRun: true, shots: [{ id: "shot-1", description: "沈砚在门口停步，没有进门。" }] });
    assert.equal(preview.applied, false);
    assert.deepEqual(preview.changedShotIds, ["shot-1"]);
    assert.match(preview.prompt, /在门口停步/);
    assert.equal(project.revision, revision);
});

test("view='storyboard' 读回基线供下一次改写", async () => {
    const { handlers } = fixture();
    const empty: any = await handlers.h3_get_clip_prompt!({ projectId: "project-1", nodeId: "h3-1", segmentId: "s1", view: "storyboard" });
    assert.equal(empty.storyboard.established, false);
    assert.deepEqual(Object.keys(empty.nextWrite.input).sort(), ["nodeId", "nonDiegeticMusic", "openingDescription", "overallSoundscape", "projectId", "segmentId", "shots"].sort());
    await handlers.h3_write_storyboard_prompt!(fullWrite);
    const filled: any = await handlers.h3_get_clip_prompt!({ projectId: "project-1", nodeId: "h3-1", segmentId: "s1", view: "storyboard" });
    assert.equal(filled.storyboard.established, true);
    assert.deepEqual(filled.storyboard.shots.map((shot: any) => shot.id), ["shot-1", "shot-2"]);
    assert.equal(filled.storyboard.shots[1].description, "红绡从屏风后走出，抬手挡住灯影。");
    assert.deepEqual(Object.keys(filled.nextWrite.input).sort(), ["nodeId", "projectId", "segmentId", "shots"].sort());
});

test("合并只接受已存在的镜头，位置式全量写法仍兼容", () => {
    const baseline = { openingDescription: "开场", shots: [{ id: "shot-1", description: "一", switchTime: "", transitionType: "cut" }, { id: "shot-2", description: "二", switchTime: "", transitionType: "cut" }], overallSoundscape: "声", nonDiegeticMusic: "乐" };
    const positional = mergeStoryboardInput(baseline, { shots: [{ description: "一改" }, { description: "二改" }] });
    assert.deepEqual(positional.changedShotIds, ["shot-1", "shot-2"]);
    assert.deepEqual(positional.input.shots.map((shot) => shot.description), ["一改", "二改"]);
    assert.throws(() => mergeStoryboardInput(baseline, { shots: [{ description: "只有一镜" }] }), /STORYBOARD_SHOT_ID_REQUIRED/);
    assert.throws(() => mergeStoryboardInput(undefined, { openingDescription: "只有开场" }), /STORYBOARD_SHOTS_REQUIRED/);
});

test("老 Clip 无基线时只给部分镜头会被拒绝，不静默压掉其余镜头", () => {
    assert.throws(
        () => mergeStoryboardInput(undefined, { shots: [{ id: "shot-2", description: "只改二镜" }] }, { existingShotCount: 3 }),
        /STORYBOARD_BASELINE_PARTIAL.*3 个镜头.*1 个/,
    );
    // 镜头数与现有轨一致时仍允许一次建立基线。
    const ok = mergeStoryboardInput(undefined, { shots: [{ description: "一" }, { description: "二" }, { description: "三" }] }, { existingShotCount: 3 });
    assert.equal(ok.established, true);
});

test("工具目录把增量写入标成可选参数", () => {
    const tool = pluginMcp.tools.find((item) => item.id === "h3_write_storyboard_prompt")!;
    const schema: any = tool.inputJsonSchema;
    assert.deepEqual(schema.required, ["projectId", "nodeId", "segmentId"]);
    assert.equal(schema.properties.shots.items.required, undefined);
    const readTool = pluginMcp.tools.find((item) => item.id === "h3_get_clip_prompt")!;
    assert.ok((readTool.inputJsonSchema as any).properties.view.enum.includes("storyboard"));
});
