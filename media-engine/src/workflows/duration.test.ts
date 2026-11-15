import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
    durationToFrames,
    inferDurationUnit,
    injectDurationTarget,
    parseWorkflowDurationTarget,
    readDurationSeconds,
    resolveDurationValue,
} from "./duration.js";

describe("workflows/duration 秒转帧", () => {
    it("吸附到 17n+5 网格 @24fps，与 MiniMax_H3.json 的 131 表达式一致", () => {
        assert.equal(durationToFrames(5), 124);
        assert.equal(durationToFrames(6.5), 158);
        assert.equal(durationToFrames(8), 192);
        assert.equal(durationToFrames(15), 362);
        for (const seconds of [4, 5, 6.5, 8, 10, 12, 15]) {
            assert.equal(durationToFrames(seconds) % 17, 5);
        }
    });

    it("秒槽保留小数，帧槽写整数", () => {
        assert.equal(resolveDurationValue(6.5, "seconds"), 6.5);
        assert.equal(resolveDurationValue(6.5, "frames"), 158);
        assert.equal(resolveDurationValue(6.583, "seconds"), 6.583);
    });

    it("按输入名推断单位", () => {
        assert.equal(inferDurationUnit("length"), "frames");
        assert.equal(inferDurationUnit("num_frames"), "frames");
        assert.equal(inferDurationUnit("value"), "seconds");
        assert.equal(inferDurationUnit("duration_seconds"), "seconds");
    });
});

describe("workflows/duration 配置解析", () => {
    it("合法配置原样返回，坏配置退化成未配置而不是抛错", () => {
        const target = { nodeId: "132", input: "value", unit: "seconds" };
        assert.deepEqual(parseWorkflowDurationTarget(target), target);
        assert.equal(parseWorkflowDurationTarget(null), null);
        assert.equal(parseWorkflowDurationTarget({ nodeId: "132", input: "value", unit: "minutes" }), null);
        assert.equal(parseWorkflowDurationTarget({ nodeId: "", input: "value", unit: "frames" }), null);
        assert.equal(parseWorkflowDurationTarget([target]), null);
    });

    it("制作台 seconds 优先，字符串与 0 / 非法值不参与注入", () => {
        assert.equal(readDurationSeconds({ duration: 8 }, { seconds: "6.5", params: { duration: 10 } }), 6.5);
        assert.equal(readDurationSeconds({ seconds: "8", duration: 12 }, {}), 8);
        assert.equal(readDurationSeconds({}, { seconds: "0" }), null);
        assert.equal(readDurationSeconds({}, { seconds: "abc" }), null);
        assert.equal(readDurationSeconds({}, {}), null);
    });
});

describe("workflows/duration 注入", () => {
    const workflow = {
        "132": { class_type: "PrimitiveFloat", inputs: { value: 8 } },
        "136": { class_type: "MiniMaxH3ReferenceToVideo", inputs: { length: ["131", 1], prompt: "keep" } },
    };

    it("只改目标节点输入，不改原图、不动其他节点", () => {
        const { workflow: next, injected } = injectDurationTarget(
            workflow,
            { nodeId: "136", input: "length", unit: "frames" },
            158,
        );
        assert.equal(injected, true);
        assert.equal((next["136"] as { inputs: Record<string, unknown> }).inputs.length, 158);
        assert.equal((next["136"] as { inputs: Record<string, unknown> }).inputs.prompt, "keep");
        assert.deepEqual(next["132"], workflow["132"]);
        assert.equal((workflow["136"] as { inputs: Record<string, unknown> }).inputs.length instanceof Array, true, "原图不能被改写");
    });

    it("目标节点不存在时跳过注入，调用方保留原工作流继续生成", () => {
        const { workflow: next, injected } = injectDurationTarget(
            workflow,
            { nodeId: "999", input: "value", unit: "seconds" },
            6.5,
        );
        assert.equal(injected, false);
        assert.equal(next, workflow);
    });
});

describe("workflows/duration 真实模板回归", () => {
    const flow = JSON.parse(readFileSync(new URL("../../workflows/MiniMax_H3.json", import.meta.url), "utf8")) as Record<string, { inputs: Record<string, unknown> }>;

    it("MiniMax_H3.json 的秒入口 132.value 与帧入口 136.length 都能按单位落值", () => {
        assert.equal(flow["132"].inputs.value, 8);
        assert.deepEqual(flow["136"].inputs.length, ["131", 1]);
        // 选秒入口：写 6.5 秒，131 表达式链保持原样，由模板自己换算成帧。
        const secondsFlow = injectDurationTarget(flow,
            { nodeId: "132", input: "value", unit: "seconds" },
            resolveDurationValue(6.5, "seconds")).workflow as typeof flow;
        assert.equal(secondsFlow["132"].inputs.value, 6.5, "小数秒不能被抹成 7");
        assert.deepEqual(secondsFlow["136"].inputs.length, ["131", 1]);
        // 选帧入口：直接写吸附后的 158 帧，跳过 131 表达式。
        const framesFlow = injectDurationTarget(flow,
            { nodeId: "136", input: "length", unit: "frames" },
            resolveDurationValue(6.5, "frames")).workflow as typeof flow;
        assert.equal(framesFlow["136"].inputs.length, 158);
        assert.equal(framesFlow["132"].inputs.value, 8, "其他节点不动");
    });
});
