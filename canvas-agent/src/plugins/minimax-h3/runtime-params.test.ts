import assert from "node:assert/strict";
import test from "node:test";
import { h3StoryboardIssues, normalizeH3Params, resolveH3Runtime, withH3ParameterEdits, type H3ParameterSource } from "./runtime-params.js";

test("关闭自选模型时原生 H3 固定本地，忽略各层残留 RH 与自动分流设置", () => {
    for (const minimaxEngine of ["runninghub", "auto"]) {
        const clip = { selectedVideoModelEnabled: false, minimaxEngine };
        const native = resolveH3Runtime(clip, { minimaxEngine }, { minimaxEngine }, { minimaxEngine });
        assert.equal(native.params.minimaxEngine, "local");
        assert.equal(clip.minimaxEngine, minimaxEngine, "解析不改写保存稿");
        const custom = resolveH3Runtime({ ...clip, selectedVideoModelEnabled: true }, {}, {}, {});
        assert.equal(custom.params.minimaxEngine, minimaxEngine, "自选模型保留明确的运行位置");
    }
});

const seedLayers: Array<{ source: H3ParameterSource; args: (value: Record<string, unknown>) => Parameters<typeof resolveH3Runtime> }> = [
    { source: "request", args: (value) => [{}, value, {}, {}] },
    { source: "clip", args: (value) => [value, {}, {}, {}] },
    { source: "node", args: (value) => [{}, {}, value, {}] },
    { source: "nodeParams", args: (value) => [{}, {}, { comfyParams: value }, {}] },
    { source: "defaults", args: (value) => [{}, {}, {}, value] },
];

test("legacy nonzero seed aliases infer fixed mode without a built-in random override", () => {
    for (const { source, args } of seedLayers) {
        for (const key of ["seed", "noiseSeed"]) {
            const input = args({ [key]: 456 });
            const before = structuredClone(input);
            const resolved = resolveH3Runtime(...input);
            assert.equal(resolved.params.noiseSeedMode, "fixed", `${source}.${key}`);
            assert.equal(resolved.params.seed, 456);
            assert.equal(resolved.params.noiseSeed, 456);
            assert.equal(resolved.sources.noiseSeedMode, source);
            assert.deepEqual(input, before, "seed inference must not rewrite saved inputs");
        }
    }
});

test("missing and legacy zero seeds remain random, while explicit fixed zero stays fixed", () => {
    const fresh = resolveH3Runtime({}, {}, {}, {});
    assert.equal(fresh.params.noiseSeedMode, "random");
    assert.equal(fresh.sources.noiseSeedMode, "builtIn");
    for (const { source, args } of seedLayers) {
        for (const key of ["seed", "noiseSeed"]) {
            const legacy = resolveH3Runtime(...args({ [key]: 0 }));
            assert.equal(legacy.params.noiseSeedMode, "random");
            assert.equal(legacy.params.seed, 0);
            const fixed = resolveH3Runtime(...args({ [key]: 0, noiseSeedMode: "fixed" }));
            assert.equal(fixed.params.noiseSeedMode, "fixed");
            assert.equal(fixed.params.seed, 0);
            assert.equal(fixed.params.noiseSeed, 0);
            assert.equal(fixed.sources.noiseSeedMode, source);
        }
    }
});

test("explicit seed modes retain layer precedence including defaults policy", () => {
    for (const { source, args } of seedLayers) {
        for (const mode of ["random", "fixed"]) {
            const input = args({ noiseSeedMode: mode });
            input[0] = { ...input[0], seed: 456 };
            const before = structuredClone(input);
            const resolved = resolveH3Runtime(...input);
            assert.equal(resolved.params.noiseSeedMode, mode, `${source}.${mode}`);
            assert.equal(resolved.sources.noiseSeedMode, source);
            assert.deepEqual(input, before);
        }
    }
    const clip = { h3ParameterPolicy: "defaults", seed: 456 };
    assert.equal(resolveH3Runtime(clip, {}, {}, {}).params.noiseSeedMode, "fixed");
    assert.equal(resolveH3Runtime(clip, {}, {}, { noiseSeedMode: "random" }).params.noiseSeedMode, "random");
    const request = resolveH3Runtime({ ...clip, noiseSeedMode: "fixed" }, { noiseSeedMode: "random" }, { noiseSeedMode: "fixed" }, { noiseSeedMode: "fixed" });
    assert.equal(request.params.noiseSeedMode, "random");
    assert.equal(request.sources.noiseSeedMode, "request");
    const saved = resolveH3Runtime({ ...clip, noiseSeedMode: "fixed" }, {}, { noiseSeedMode: "random" }, { noiseSeedMode: "random" });
    assert.equal(saved.params.noiseSeedMode, "fixed");
    assert.equal(saved.sources.noiseSeedMode, "clip");
});

test("legacy seed inference preserves valid seed precedence over the noiseSeed alias", () => {
    const resolved = resolveH3Runtime({ seed: 456 }, { noiseSeed: 789 }, {}, {});
    assert.equal(resolved.params.noiseSeedMode, "fixed");
    assert.equal(resolved.params.seed, 456);
    assert.equal(resolved.params.noiseSeed, 456);
    assert.equal(resolved.sources.noiseSeedMode, "clip");
    const fallback = resolveH3Runtime({ seed: -1 }, { noiseSeed: 789 }, {}, {});
    assert.equal(fallback.params.noiseSeedMode, "fixed");
    assert.equal(fallback.params.seed, 789);
    assert.equal(fallback.sources.noiseSeedMode, "request");
    assert.equal(resolveH3Runtime({ seed: -1 }, {}, {}, {}).params.noiseSeedMode, "random");
});

test("global defaults cannot enable continuation, while authored per-Clip choices remain effective", () => {
    const defaults = { motionContextEnabled: true, tailFrameContinuation: true };
    const fresh = resolveH3Runtime({}, {}, {}, defaults);
    assert.equal(fresh.params.motionContextEnabled, false);
    assert.equal(fresh.params.tailFrameContinuation, false);
    assert.equal(resolveH3Runtime({ motionContextEnabled: true }, {}, {}, defaults).params.motionContextEnabled, true);
});

test("conflicting saved switches stay visible and are diagnosed instead of hidden", () => {
    const clip = { tailFrameContinuation: true, motionContextEnabled: true };
    const { params, parameterIssues } = resolveH3Runtime(clip, {}, {}, {});
    assert.equal(params.tailFrameContinuation, true);
    assert.equal(params.motionContextEnabled, true);
    assert.ok(parameterIssues.some(issue => issue.includes('保存值同时开启')));
    assert.deepEqual(clip, { tailFrameContinuation: true, motionContextEnabled: true });
    assert.equal(normalizeH3Params(clip).motionContextEnabled, true);
});

test("自选视频模型不执行潜空间续写，保存的尾帧与续写开关不互相阻塞", () => {
    const resolved = resolveH3Runtime({ selectedVideoModelEnabled: true, selectedVideoModel: 'YZ', tailFrameContinuation: true, motionContextEnabled: true }, {}, {}, {});
    assert.deepEqual(resolved.parameterIssues, []);
    // 只影响诊断，不改写 Clip 的保存值。
    assert.equal(resolved.params.motionContextEnabled, true);
});

test("saved companion false prevents inherited defaults from reopening motion", () => {
    for (const defaults of [{ motionContextEnabled: true }, { motionContextEnabled: true, tailFrameContinuation: true }]) {
        const params = resolveH3Runtime(withH3ParameterEdits({}, { tailFrameContinuation: true }), {}, {}, defaults).params;
        assert.equal(params.tailFrameContinuation, true);
        assert.equal(params.motionContextEnabled, false);
    }
});

test("manual continuation edits persist the opposite false under default policy", () => {
    const clip = { h3ParameterPolicy: "defaults", tailFrameContinuation: true, motionContextEnabled: true };
    for (const key of ["motionContextEnabled", "tailFrameContinuation"]) {
        const other = key === "motionContextEnabled" ? "tailFrameContinuation" : "motionContextEnabled";
        const patch = withH3ParameterEdits(clip, { [key]: true });
        assert.equal(patch[other], false);
        assert.deepEqual(new Set(patch.h3ParameterOverrides as string[]), new Set([key, other]));
        const params = resolveH3Runtime({ ...clip, ...patch }, {}, {}, { [other]: true }).params;
        assert.equal(params[key], true);
        assert.equal(params[other], false);
    }
    assert.deepEqual(withH3ParameterEdits({}, { motionContextEnabled: false }), { motionContextEnabled: false, h3ParameterOverrides: ["motionContextEnabled"] });
});

test("storyboard tracks can omit image references while still validating explicit bindings", () => {
    assert.deepEqual(h3StoryboardIssues({ storyboardShots: [{ id: "shot-1", duration: 5 }] }), []);
    assert.ok(h3StoryboardIssues({ storyboardShots: [{ id: "shot-1", duration: 5, referenceBindingId: "missing" }] }).some(issue => issue.includes("缺少有效 storyboard 绑定")));
});
