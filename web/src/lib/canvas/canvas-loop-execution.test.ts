import assert from "node:assert/strict";
import test from "node:test";

import { resolveLoopInputPlan, runLoopGenerationRounds, upstreamLoopForGeneration } from "./canvas-loop-execution";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

function node(id: string, type: CanvasNodeData["type"], metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData {
    return { id, type, title: id, position: { x: 0, y: 0 }, width: 100, height: 100, metadata };
}

test("轮数按输入槽位自动计算，旧手动次数不再覆盖结果", () => {
    assert.equal(resolveLoopInputPlan({ loopCount: 2, loopCountMode: "manual", loopMediaMode: "auto" }, 7, 0).rounds, 7);
    assert.equal(resolveLoopInputPlan({ loopStart: 2, loopImageBatchSize: 2 }, 7, 0).rounds, 3);
    assert.equal(resolveLoopInputPlan({ loopStart: 8 }, 7, 0).rounds, 0);
    assert.equal(resolveLoopInputPlan({}, 0, 0, 3).rounds, 3);
    assert.equal(resolveLoopInputPlan({}, 0, 0, 0, 4).rounds, 4);
    assert.equal(resolveLoopInputPlan({}, 0, 0, 0, 0).rounds, 1);
    assert.equal(resolveLoopInputPlan({}, 0, 0, 0, 0).rounds <= 100, true);
    assert.equal(resolveLoopInputPlan({ loopMediaMode: "off", loopImageBatchSize: 1 }, 2, 0).rounds, 2,
        "旧画布关闭图片开关时，有序组的两张可用图仍须逐张执行");
});

test("结果槽通过元数据定位所属循环，无需散连回循环节点", () => {
    const loop = node("loop", CanvasNodeType.Loop);
    const output = node("result-slot", CanvasNodeType.Config, { smart: true, loopOutputSlot: true, loopSourceId: loop.id });
    const nodes = [loop, output];
    const connections: CanvasConnection[] = [];
    assert.equal(upstreamLoopForGeneration(output.id, nodes, connections)?.id, loop.id);
    assert.equal(upstreamLoopForGeneration(loop.id, nodes, connections)?.id, loop.id);
});

test("串行或并行执行中的失败会停止领取后续轮次", async () => {
    const controller = new AbortController();
    const started: number[] = [];
    await assert.rejects(runLoopGenerationRounds(4, 2, controller, async (round) => {
        started.push(round);
        if (round === 0) throw new Error("generation failed");
        if (round === 1) await new Promise<void>((_, reject) => controller.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
    }), /generation failed/);
    assert.equal(controller.signal.aborted, true);
    assert.deepEqual(started, [0, 1]);
});

test("最后一轮运行期间停止不会误报整批完成", async () => {
    const controller = new AbortController();
    await assert.rejects(runLoopGenerationRounds(1, 1, controller, async () => {
        controller.abort();
    }), { name: "AbortError" });
});

test("并行轮次有上限，失败取消时已领取任务各自收尾", async () => {
    const controller = new AbortController();
    const started: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const running = runLoopGenerationRounds(3, 2, controller, async (round) => {
        started.push(round);
        if (round < 2) await gate;
    });
    assert.deepEqual(started, [0, 1]);
    release();
    await running;
    assert.deepEqual(started, [0, 1, 2]);
});
