import assert from "node:assert/strict";
import test from "node:test";

import { deriveSegmentState, deriveSegmentStates, withSegmentState, type SegmentStateInputs, type SegmentStateInputsBySegment, type SegmentStateRuntime } from "./segment-state.js";

const HASH = "f".repeat(64);
const OTHER_HASH = "d".repeat(64);

function artifact(over: Record<string, unknown> = {}) {
    return {
        id: "h3-E01-SEG01",
        kind: "h3",
        targetId: "E01-SEG01",
        prompt: "subject_definitions:\r\n<Picture 1> is the approved storyboard entry frame.",
        sha256: "a".repeat(64),
        sourceHash: HASH,
        status: "ready",
        references: [],
        receipt: {
            sourceHash: HASH,
            promptHash: "b".repeat(64),
            engineRuntimeId: "runtime-1",
            validator: "h3_schema",
            diagnostics: { englishWords: 2700, detailPolicy: { profile: "strict" }, blockers: [], formatPass: "PASSED", accepted: true },
        },
        ...over,
    };
}

/** 形状照搬真实 episode_productions.draft_json：段只有 id/shot_ids/mode，真值在 director.artifacts。 */
function draft(over: Record<string, unknown> = {}) {
    return {
        director: {
            schemaVersion: 1,
            engine: { commit: "a".repeat(40), patchVersion: "p", runtimeId: "r", version: "4.3.9" },
            source: {
                version: 2,
                prompt_assembly: { version: 2 },
                segments: [
                    { id: "E01-SEG01", shot_ids: ["S1"], mode: "Ref2VA" },
                    { id: "E01-SEG02", shot_ids: ["S2"], mode: "T2VA" },
                ],
            },
            sourceHash: HASH,
            artifacts: [] as any[],
            assets: {} as Record<string, unknown>,
            modules: {},
            boundaries: [],
            executionAuthorized: false,
            unresolved: [],
            workflow: {},
            ...over,
        },
    };
}

const segmentOf = (d: any, id = "E01-SEG01") => d.director.source.segments.find((s: any) => s.id === id);

test("无 artifact / 无 prompt → none，references 为空数组（不编造参考图）", () => {
    const d = draft();
    const state = deriveSegmentState(segmentOf(d), d);
    assert.equal(state.promptStatus, "none");
    assert.deepEqual(state.references, []);
    assert.equal(state.promptError, undefined);
    assert.equal(state.waitReason, undefined);
    assert.equal(state.upstreamStage, undefined);
});

test("有 prompt 且 receipt.diagnostics.accepted → ready，reference 有 storageKey 即 sent", () => {
    const d = draft({ artifacts: [artifact({ references: [
        { label: "<Picture 1>", nodeId: "n1", storageKey: "image:abc", sha256: "c".repeat(64), role: "keyframe" },
    ] })] });
    const state = deriveSegmentState(segmentOf(d), d);
    assert.equal(state.promptStatus, "ready");
    assert.deepEqual(state.references, [{ label: "<Picture 1>", sent: true }]);
});

test("artifact.status=stale → stale（即便 sourceHash 相同）", () => {
    const d = draft({ artifacts: [artifact({ status: "stale" })] });
    assert.equal(deriveSegmentState(segmentOf(d), d).promptStatus, "stale");
});

test("artifact.sourceHash ≠ director.sourceHash → stale（双真值之一）", () => {
    const d = draft({ artifacts: [artifact({ sourceHash: OTHER_HASH })] });
    assert.equal(deriveSegmentState(segmentOf(d), d).promptStatus, "stale");
});

test("blockers 非空 → failed，promptError 取真实 blocker 文本", () => {
    const blocker = "h3_schema: Ref2VA detailed_description is 3027 words; exceeds maximum ceiling of 2900 words";
    const d = draft({ artifacts: [artifact({ status: "stale", receipt: { ...artifact().receipt, diagnostics: { ...(artifact().receipt.diagnostics as any), accepted: false, blockers: [blocker] } } })] });
    const state = deriveSegmentState(segmentOf(d), d);
    assert.equal(state.promptStatus, "failed");
    assert.equal(state.promptError, blocker);
});

test("artifact.status=failed → failed，promptError 取真实 error 字段", () => {
    const d = draft({ artifacts: [artifact({ status: "failed", error: "提示词 Agent 调用超时" })] });
    const state = deriveSegmentState(segmentOf(d), d);
    assert.equal(state.promptStatus, "failed");
    assert.equal(state.promptError, "提示词 Agent 调用超时");
});

test("artifact.status=queued/running → 原样派生，并带上 job/run 真值的 stage 与 wait", () => {
    const d = draft({ artifacts: [artifact({ status: "queued", receipt: undefined })] });
    const runtime: SegmentStateRuntime = {
        jobs: [{
            id: "job-1", episodeId: "episode-e1", kind: "prompts", stage: "prompts", status: "blocked",
            error: "上游 assets 阶段未完成", label: "第1集 · prompts",
        }],
        runs: [{ status: "running", error: null }],
    };
    const state = deriveSegmentState(segmentOf(d), d, runtime, "episode-e1");
    assert.equal(state.promptStatus, "queued");
    assert.equal(state.upstreamStage, "prompts");
    assert.equal(state.waitReason, "上游 assets 阶段未完成");
    assert.equal(deriveSegmentState(segmentOf(d), d, { jobs: [{ episodeId: "other", stage: "video", status: "blocked", error: "别的集" }] }, "episode-e1").upstreamStage, undefined);
});

test("job 无真实 wait 文本 → waitReason undefined（不编造调度话术）", () => {
    const d = draft({ artifacts: [artifact({ status: "running", receipt: undefined })] });
    const state = deriveSegmentState(segmentOf(d), d, {
        jobs: [{ episodeId: "episode-e1", stage: "prompts", status: "running", error: null }],
    }, "episode-e1");
    assert.equal(state.promptStatus, "running");
    assert.equal(state.upstreamStage, "prompts");
    assert.equal(state.waitReason, undefined);
});

test("references：storageKey 缺失时按 T2VA 真实 mode 派生 missingReason；其余无真值则 undefined", () => {
    const d = draft({
        artifacts: [
            artifact({ references: [
                { label: "<Picture 1>", nodeId: "n1", storageKey: "image:abc", sha256: "c".repeat(64), role: "keyframe" },
                { label: "<Picture 2>", nodeId: "n2", storageKey: "", role: "keyframe" },
            ] }),
            artifact({ id: "h3-E01-SEG02", targetId: "E01-SEG02", references: [
                { label: "<Picture 1>", role: "keyframe" },
            ] }),
        ],
        assets: { ASSET_PLANNED: { status: "planned", version: "v1" }, ASSET_REJECTED: { status: "rejected", version: "v1" } },
    });
    const ref2 = deriveSegmentState(segmentOf(d), d).references;
    assert.equal(ref2[0].sent, true);
    assert.equal(ref2[0].missingReason, undefined);
    assert.equal(ref2[1].sent, false);
    assert.equal(ref2[1].missingReason, undefined);

    const t2 = deriveSegmentState(segmentOf(d, "E01-SEG02"), d).references;
    assert.equal(t2[0].sent, false);
    assert.match(t2[0].missingReason || "", /T2VA/);

    const planned = draft({ artifacts: [artifact({ references: [{ label: "<Picture 1>", assetId: "ASSET_PLANNED", role: "character" }] })], assets: { ASSET_PLANNED: { status: "planned" } } });
    assert.equal(deriveSegmentState(segmentOf(planned), planned).references[0].missingReason, "参考图未生成");
    const rejected = draft({ artifacts: [artifact({ references: [{ label: "<Picture 1>", assetId: "ASSET_REJECTED" }] })], assets: { ASSET_REJECTED: { status: "rejected" } } });
    assert.equal(deriveSegmentState(segmentOf(rejected), rejected).references[0].missingReason, "参考图未通过");
});

test("deriveSegmentStates 按段 id 返回，且只覆盖真实存在的段", () => {
    const d = draft({ artifacts: [artifact()] });
    const map = deriveSegmentStates(d, undefined, "episode-e1");
    assert.deepEqual([...map.keys()], ["E01-SEG01", "E01-SEG02"]);
    assert.equal(map.get("E01-SEG01")!.promptStatus, "ready");
    assert.equal(map.get("E01-SEG02")!.promptStatus, "none");
});

test("withSegmentState 给 draft/published 两段挂 state 且不 mutate 输入（不写库）", () => {
    const d = draft({ artifacts: [artifact()] });
    const production = { episodeId: "episode-e1", revision: 7, draft: d, published: structuredClone(d) };
    const before = structuredClone(production);
    const out = withSegmentState(production, undefined, "episode-e1");

    assert.equal(segmentOf(d).state, undefined, "输入 draft 段不得被写入");
    assert.equal(segmentOf(production.published).state, undefined, "输入 published 段不得被写入");
    assert.deepEqual(production, before, "输入 production 整体不得被 mutate");
    assert.notEqual(segmentOf(out.draft), segmentOf(production.draft), "返回副本必须是新段对象");
    assert.equal(segmentOf(out.draft).state.promptStatus, "ready");
    assert.equal(segmentOf(out.published).state.promptStatus, "ready");
    assert.equal(segmentOf(out.draft).id, "E01-SEG01", "原字段必须保留");
});

test("withSegmentState 对 unchanged/分块响应等非 draft 结构原样返回", () => {
    const unchanged = { unchanged: true, snapshot: "draft", view: "full" };
    assert.equal(withSegmentState(unchanged), unchanged);
    const chunked = { chunk: { text: "..." } };
    assert.equal(withSegmentState(chunked), chunked);
});

test("custom 门控：stale+custom=true 真值下发；false/无真值不伪装，前端据此显示过期", () => {
    const d = draft({ artifacts: [artifact({ status: "stale" })] });
    const segment = segmentOf(d);
    const before = structuredClone(segment);
    const runtime: SegmentStateRuntime = { customSegments: { "E01-SEG01": true, "E01-SEG02": false } };

    const withCustom = deriveSegmentState(segment, d, runtime);
    assert.equal(withCustom.promptStatus, "stale", "stale 真值不被 custom 覆盖");
    assert.equal(withCustom.custom, true, "手写提示词：前端不再显示「提示词已过期」");
    assert.equal(deriveSegmentState(segment, d, { customSegments: new Set(["E01-SEG01"]) }).custom, true, "Set 形式命中即 true");
    assert.equal(deriveSegmentState(segmentOf(d, "E01-SEG02"), d, runtime).custom, false, "LLM/自动改写为 false");
    assert.equal(deriveSegmentState(segment, d, undefined).custom, undefined, "无真值不下发");
    assert.equal(deriveSegmentState(segment, d, { customSegments: { "E01-SEG02": true } }).custom, undefined, "别的段真值不串段");
    assert.deepEqual(segment, before, "derive 不 mutate 输入段");
    assert.deepEqual(runtime.customSegments, { "E01-SEG01": true, "E01-SEG02": false }, "derive 不 mutate runtime");
});

test("videoReprocessable 按段真/假独立下发，与 custom 互不干扰", () => {
    const d = draft({ artifacts: [artifact()] });
    const runtime: SegmentStateRuntime = {
        customSegments: { "E01-SEG01": false },
        reprocessableSegments: { "E01-SEG01": true, "E01-SEG02": false },
    };
    const s1 = deriveSegmentState(segmentOf(d), d, runtime);
    assert.equal(s1.promptStatus, "ready");
    assert.equal(s1.videoReprocessable, true, "已生成但后处理失败：可只重跑后处理");
    assert.equal(s1.custom, false);
    const s2 = deriveSegmentState(segmentOf(d, "E01-SEG02"), d, runtime);
    assert.equal(s2.videoReprocessable, false, "已就绪/非后处理失败：不可重跑");
    assert.equal(s2.custom, undefined, "reprocessable 真值不冒充 custom 真值");
    assert.equal(deriveSegmentState(segmentOf(d), d, { reprocessableSegments: new Set(["E01-SEG01"]) }).videoReprocessable, true);
    assert.equal(deriveSegmentState(segmentOf(d), d).videoReprocessable, undefined, "无真值不下发");
});

test("withSegmentState 把 custom/videoReprocessable 下发到 state，且不 mutate 输入与 runtime", () => {
    const d = draft({ artifacts: [artifact()] });
    const production = { episodeId: "episode-e1", revision: 7, draft: d };
    const customSegments: Record<string, boolean> = { "E01-SEG01": true };
    const reprocessableSegments: Record<string, boolean> = { "E01-SEG01": false };
    const runtime: SegmentStateRuntime = { customSegments, reprocessableSegments };
    const before = structuredClone(production);

    const out = withSegmentState(production, runtime, "episode-e1");
    assert.equal(segmentOf(out.draft).state.custom, true);
    assert.equal(segmentOf(out.draft).state.videoReprocessable, false);
    assert.equal(segmentOf(d).state, undefined, "输入段不得被写入 state");
    assert.deepEqual(production, before, "输入 production 不得被 mutate");
    assert.deepEqual(customSegments, { "E01-SEG01": true }, "runtime 不得被 mutate");
    assert.deepEqual(reprocessableSegments, { "E01-SEG01": false }, "runtime 不得被 mutate");
});

test("videoStatus：画布 status 真值映射；inputOutdated 优先 stale；idle/空不下发", () => {
    const d = draft();
    const segment = segmentOf(d);
    const cases: Array<[string | undefined, string | undefined]> = [
        ["success", "ready"], ["succeeded", "ready"], ["ready", "ready"],
        ["error", "failed"], ["failed", "failed"],
        ["loading", "running"], ["running", "running"],
        ["queued", "queued"], ["cancelled", "cancelled"],
        ["idle", undefined], ["", undefined], [undefined, undefined],
    ];
    for (const [status, expected] of cases) {
        const state = deriveSegmentState(segment, d, undefined, undefined, { clipState: { status } });
        assert.equal(state.videoStatus, expected, `status=${String(status)}`);
    }
    assert.equal(deriveSegmentState(segment, d, undefined, undefined, { clipState: { status: "success", inputOutdated: true } }).videoStatus, "stale", "输入过期优先于 success");
    assert.equal(deriveSegmentState(segment, d, undefined, undefined, { clipState: { status: "error", inputOutdated: true } }).videoStatus, "stale", "输入过期优先于 error");
    assert.equal(deriveSegmentState(segment, d).videoStatus, undefined, "无 clip 真值不下发");
});

test("videoError：只取画布 errorDetails 的真实文本，空白/无 clip 不下发", () => {
    const d = draft();
    const segment = segmentOf(d);
    assert.equal(deriveSegmentState(segment, d, undefined, undefined, { clipState: { status: "error", errorDetails: "ComfyUI 不可达（ECONNREFUSED）" } }).videoError, "ComfyUI 不可达（ECONNREFUSED）");
    assert.equal(deriveSegmentState(segment, d, undefined, undefined, { clipState: { status: "error", errorDetails: "   " } }).videoError, undefined);
    assert.equal(deriveSegmentState(segment, d, undefined, undefined, { clipState: { status: "error", errorDetails: { code: "ECONNREFUSED" } } }).videoError, undefined, "结构化对象不是文本真值，不编造错误文案");
    assert.equal(deriveSegmentState(segment, d).videoError, undefined);
});

test("references：画布 bindings 优先于 artifact.references，storageKey/启用态决定 sent", () => {
    const d = draft({ artifacts: [artifact({ references: [{ label: "OLD", storageKey: "image:old" }] })] });
    const segment = segmentOf(d);
    const bindings = [
        { label: "<Picture 1>", ordinal: 1, storageKey: "image:new1" },
        { label: "<Picture 2>", ordinal: 2 },
        { label: "<Picture 3>", ordinal: 3, storageKey: "image:new3", enabled: false },
    ];
    const state = deriveSegmentState(segment, d, undefined, undefined, { bindings });
    assert.deepEqual(state.references, [
        { label: "<Picture 1>", sent: true },
        { label: "<Picture 2>", sent: false },
        { label: "<Picture 3>", sent: false, missingReason: "参考图已禁用" },
    ]);
    assert.equal(state.request?.referencesSent, 1);
    assert.equal(state.request?.referenceLimited, true, "有参考图未发出 → limited");
    assert.deepEqual(deriveSegmentState(segment, d).references, [{ label: "OLD", sent: true }], "无 bindings 才回退 artifact.references");
    const empty = deriveSegmentState(segment, d, undefined, undefined, { bindings: [] });
    assert.deepEqual(empty.references, [], "空 bindings 是「本段无参考图」真值，不再回退旧 artifact");
    assert.equal(empty.request?.referencesSent, 0);
    assert.equal(empty.request?.referenceLimited, false);
    const overLimit = deriveSegmentState(segment, d, undefined, undefined, {
        bindings: Array.from({ length: 10 }, (_unused, index) => ({ label: `<Picture ${index + 1}>`, ordinal: index + 1, storageKey: `image:${index}` })),
    });
    assert.equal(overLimit.request?.referencesSent, 9, "H3 9 张上限内收窄");
    assert.equal(overLimit.request?.referenceLimited, true);
});

test("request.firstFramePending：承接尾帧 + 段序 + 上一段视频就绪度", () => {
    const d = draft();
    const second = segmentOf(d, "E01-SEG02");
    const inputs = (previousVideoReady?: boolean): SegmentStateInputs => ({
        clipState: { tailFrameContinuation: true, status: "queued" }, segmentIndex: 1, previousVideoReady,
    });
    assert.equal(deriveSegmentState(second, d, undefined, undefined, inputs(false)).request?.firstFramePending, true, "上一段未就绪 → 首帧待就绪");
    assert.equal(deriveSegmentState(second, d, undefined, undefined, inputs(true)).request?.firstFramePending, false, "上一段已成片 → 首帧就绪");
    assert.equal(deriveSegmentState(second, d, undefined, undefined, inputs()).request?.firstFramePending, undefined, "就绪度无真值不编造");
    assert.equal(deriveSegmentState(second, d, undefined, undefined, { clipState: { tailFrameContinuation: false } }).request?.firstFramePending, false, "不承接尾帧则无待就绪首帧");
    assert.equal(deriveSegmentState(segmentOf(d), d, undefined, undefined, { clipState: { tailFrameContinuation: true }, segmentIndex: 0, previousVideoReady: false }).request?.firstFramePending, undefined, "首段没有上一段尾帧");
});

test("request.operation：taskMode 映射与承接首帧覆盖", () => {
    const d = draft();
    const segment = segmentOf(d);
    const cases: Array<[string, string | undefined]> = [
        ["ref2va", "reference_to_video"], ["r2v", "reference_to_video"],
        ["t2v", "text_to_video"], ["t2va", "text_to_video"],
        ["unknown-mode", undefined],
    ];
    for (const [taskMode, expected] of cases) {
        assert.equal(deriveSegmentState(segment, d, undefined, undefined, { clipState: { taskMode } }).request?.operation, expected, `taskMode=${taskMode}`);
    }
    assert.equal(deriveSegmentState(segmentOf(d, "E01-SEG02"), d, undefined, undefined, {
        clipState: { taskMode: "ref2va", tailFrameContinuation: true }, segmentIndex: 1, previousVideoReady: false,
    }).request?.operation, "image_to_video", "有承接首帧时按图生视频提交");
    assert.equal(deriveSegmentState(segment, d).request, undefined, "无请求真值不下发 request");
});

test("promptError：非 failed 分支也读 artifact.promptError / diagnostics.error；failed 分支 blockers 优先", () => {
    const base = artifact();
    const explicit = draft({ artifacts: [artifact({ promptError: "提示词改写失败" })] });
    const state = deriveSegmentState(segmentOf(explicit), explicit);
    assert.equal(state.promptStatus, "ready", "显式错误不改变 artifact 真值派生的状态");
    assert.equal(state.promptError, "提示词改写失败");

    const diagnostic = draft({ artifacts: [artifact({ receipt: { ...base.receipt, diagnostics: { ...(base.receipt.diagnostics as any), error: "诊断错误" } } })] });
    assert.equal(deriveSegmentState(segmentOf(diagnostic), diagnostic).promptError, "诊断错误");

    const failed = draft({ artifacts: [artifact({ status: "failed", error: "E", promptError: "P", receipt: { ...base.receipt, diagnostics: { ...(base.receipt.diagnostics as any), accepted: false, error: "D", blockers: ["B"] } } })] });
    assert.equal(deriveSegmentState(segmentOf(failed), failed).promptError, "B", "blockers 仍优先");
});

test("waitReason/upstreamStage：jobs/runs 的 waitReason 字段经 firstText 优先消费", () => {
    const d = draft({ artifacts: [artifact({ status: "queued", receipt: undefined })] });
    const segment = segmentOf(d);
    const fromJob = deriveSegmentState(segment, d, {
        jobs: [{ episodeId: "episode-e1", stage: "prompts", status: "blocked", waitReason: "等待 A", reason: "等待 C", error: "出错" }],
    }, "episode-e1");
    assert.equal(fromJob.waitReason, "等待 A", "wait 缺省时读 waitReason 字段");
    assert.equal(fromJob.upstreamStage, "prompts");
    const legacyWait = deriveSegmentState(segment, d, {
        jobs: [{ episodeId: "episode-e1", stage: "prompts", status: "blocked", wait: "等待 B", waitReason: "等待 A" }],
    }, "episode-e1");
    assert.equal(legacyWait.waitReason, "等待 B", "firstText 按 wait→waitReason→reason 顺序取第一个真值");
    const fromRun = deriveSegmentState(segment, d, {
        runs: [{ episodeId: "episode-e1", stage: "video", status: "blocked", waitReason: "视频排队中", error: "E" }],
    }, "episode-e1");
    assert.equal(fromRun.waitReason, "视频排队中");
    assert.equal(fromRun.upstreamStage, "video");
});

test("deriveSegmentStates/withSegmentState：新真值按段下发，运行时按上一段 clip 派生首帧，且不 mutate 输入", () => {
    const d = draft({ artifacts: [artifact()] });
    const production = { episodeId: "episode-e1", revision: 7, draft: d, published: structuredClone(d) };
    const before = structuredClone(production);
    const runtime: SegmentStateRuntime = {
        clipStates: {
            "E01-SEG01": { status: "loading", errorDetails: "", resultStorageKey: "video:old" },
            "E01-SEG02": { status: "queued" },
        },
        bindingsBySegment: { "E01-SEG01": [{ label: "<Picture 1>", ordinal: 1, storageKey: "image:live" }] },
    };
    const runtimeBefore = structuredClone(runtime);
    const out = withSegmentState(production, runtime, "episode-e1");
    const first = segmentOf(out.draft).state;
    assert.equal(first.videoStatus, "running");
    assert.equal(first.videoError, undefined);
    assert.deepEqual(first.references, [{ label: "<Picture 1>", sent: true }]);
    assert.equal(first.request?.referencesSent, 1);
    assert.equal(segmentOf(out.published).state.videoStatus, "running", "published 快照同样下发");
    assert.deepEqual(production, before, "输入不得被 mutate");
    assert.deepEqual(runtime, runtimeBefore, "runtime 不被 mutate");

    const bySegment: SegmentStateInputsBySegment = {
        "E01-SEG01": { clipState: { status: "success", taskMode: "t2v" }, bindings: [] },
    };
    const explicit = withSegmentState(production, undefined, "episode-e1", bySegment);
    const replaced = segmentOf(explicit.draft).state;
    assert.equal(replaced.videoStatus, "ready");
    assert.equal(replaced.request?.operation, "text_to_video");
    assert.deepEqual(replaced.references, []);
    assert.equal(bySegment["E01-SEG01"].clipState?.status, "success", "inputsBySegment 不被 mutate");

    const tailRuntime: SegmentStateRuntime = {
        clipStates: {
            "E01-SEG01": { status: "loading", tailFrameContinuation: true },
            "E01-SEG02": { status: "idle" },
        },
    };
    const map = deriveSegmentStates(d, tailRuntime, "episode-e1");
    assert.equal(map.get("E01-SEG02")!.request?.firstFramePending, true, "上一段仍在生成 → 本段首帧待就绪");
    assert.equal(map.get("E01-SEG02")!.request?.operation, "image_to_video");
});

test("route 形状：runtime.clipStates 自带 referenceBindings/segmentIndex/waitReason 时直接消费真值", () => {
    const d = draft({ artifacts: [artifact({ references: [] })] }); // 实测 artifact.references 常为空
    const runtime: SegmentStateRuntime = {
        jobs: [{ episodeId: "episode-e1", stage: "prompts", status: "blocked", error: "集级等待" }],
        clipStates: {
            "E01-SEG01": {
                status: "success", taskMode: "ref2va", segmentIndex: 0,
                referenceBindings: [{ label: "<Picture 1>", ordinal: 0, storageKey: "image:live" }],
                waitReason: "渠道排队中",
            },
        },
    };
    const state = deriveSegmentState(segmentOf(d), d, runtime, "episode-e1");
    assert.deepEqual(state.references, [{ label: "<Picture 1>", sent: true }], "画布绑定是真值源，不再因 artifact.references 空而丢失");
    assert.equal(state.videoStatus, "ready");
    assert.equal(state.request?.operation, "reference_to_video");
    assert.equal(state.request?.referencesSent, 1);
    assert.equal(state.waitReason, "渠道排队中", "段级 waitReason 优先于集级 job 等待");
    assert.equal(state.upstreamStage, "prompts", "upstreamStage 仍取 job/run 真值");
});
