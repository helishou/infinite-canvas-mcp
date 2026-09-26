import assert from "node:assert/strict";
import test from "node:test";

import { buildNodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import { buildLoopGenerationStages, createLoopFallbackOutput, resolveLoopInputPlan, runLoopGenerationRounds, runLoopGenerationStages, singleLoopPanelTarget, upstreamLoopForGeneration } from "./canvas-loop-execution";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";

function node(id: string, type: CanvasNodeData["type"]): CanvasNodeData {
    return { id, type, title: id, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: {} };
}

function connection(fromNodeId: string, toNodeId: string): CanvasConnection {
    return { id: `${fromNodeId}-${toNodeId}`, fromNodeId, toNodeId };
}

test("七张上游图片自动产生七轮，手动次数和起始序号可限制轮次", () => {
    assert.deepEqual(resolveLoopInputPlan({ loopCount: 1, loopCountMode: "auto", loopMediaMode: "auto" }, 7, 0), {
        mediaKind: "image", rounds: 7, start: 1, batchSize: 1, sourceCount: 7, availableRounds: 7, countMode: "auto",
    });
    assert.equal(resolveLoopInputPlan({ loopCount: 2, loopCountMode: "manual" }, 7, 0).rounds, 2);
    assert.equal(resolveLoopInputPlan({ loopCountMode: "auto", loopStart: 2, loopImageBatchSize: 2 }, 7, 0).rounds, 3);
    assert.equal(resolveLoopInputPlan({ loopCountMode: "auto", loopStart: 8 }, 7, 0).rounds, 0);
});

test("连接到循环的图片生成节点从自身生成按钮进入循环", () => {
    const nodes = [node("loop", CanvasNodeType.Loop), node("image", CanvasNodeType.Image)];
    const connections = [connection("loop", "image")];
    assert.equal(upstreamLoopForGeneration("image", nodes, connections)?.id, "loop");
    assert.equal(upstreamLoopForGeneration("loop", nodes, connections)?.id, "loop");
    assert.equal(singleLoopPanelTarget("loop", nodes, connections, (item) => item.type === CanvasNodeType.Image)?.id, "image");
});

test("循环对下游分支和汇合按依赖分级", () => {
    const slot = node("round-slot", CanvasNodeType.Image);
    slot.metadata = { loopOutputSlot: true };
    const nodes = [node("loop", CanvasNodeType.Loop), node("a", CanvasNodeType.Config), node("b", CanvasNodeType.Config), node("bridge", CanvasNodeType.Group), node("c", CanvasNodeType.Config), slot];
    const connections = [connection("loop", "a"), connection("loop", "b"), connection("a", "bridge"), connection("bridge", "c"), connection("b", "c"), connection("c", "round-slot")];
    const stages = buildLoopGenerationStages("loop", nodes, connections, (item) => item.type === CanvasNodeType.Config);
    assert.deepEqual(stages.map((stage) => stage.map((item) => item.id)), [["a", "b"], ["c"]]);
});

test("循环拒绝下游环路", () => {
    const nodes = [node("loop", CanvasNodeType.Loop), node("a", CanvasNodeType.Config), node("b", CanvasNodeType.Config)];
    const connections = [connection("loop", "a"), connection("a", "b"), connection("b", "a")];
    assert.throws(() => buildLoopGenerationStages("loop", nodes, connections, (item) => item.type === CanvasNodeType.Config), /形成了环/);
});

test("并行轮次失败会取消同层任务并阻止后续轮次", async () => {
    const controller = new AbortController();
    const started: number[] = [];
    await assert.rejects(runLoopGenerationRounds(3, 2, controller, async (round) => {
        started.push(round);
        if (round === 0) throw new Error("生成失败");
        if (round === 1) await new Promise<void>((_, reject) => controller.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
    }), /生成失败/);
    assert.equal(controller.signal.aborted, true);
    assert.deepEqual(started, [0, 1]);
});

test("最后一个节点运行中停止也不能被当成完成", async () => {
    const controller = new AbortController();
    await assert.rejects(runLoopGenerationStages([["last"]], controller, async () => {
        controller.abort();
    }), { name: "AbortError" });
});

test("并行上限作用于轮次，链内节点保持顺序", async () => {
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

// 循环节点不再强制要求先手动连下游生成节点：没有下游时自动补一个智能生成节点。
// 三条硬要求：智能生成节点、有提示词、有真正接上线的参考。
function smartConfigNode(id: string, type: CanvasNodeData["type"], metadata: Record<string, unknown> = {}): CanvasNodeData {
    return { id, type, title: id, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { ...metadata } };
}

test("循环无下游时自动创建智能生成节点并连线", () => {
    const loop = { ...node("loop-1", CanvasNodeType.Loop), metadata: { loopMediaMode: "image" as const } };
    const created = createLoopFallbackOutput("loop-1", loop, (type, position, metadata) => smartConfigNode(`new-${type}`, type, metadata), { x: 460, y: 0 });

    assert.equal(created.node.type, CanvasNodeType.Config, "必须是 Config 智能生成节点，不是裸 Image/Video");
    assert.equal(created.node.metadata?.smart, true, "必须是智能生成节点");
    assert.equal(created.node.metadata?.generationMode, "image");
    assert.deepEqual(created.connection.fromNodeId, "loop-1");
    assert.deepEqual(created.connection.toNodeId, created.node.id);

    // 补出的节点必须立刻可被 runLoop 用作 stage，否则仍然等于没有下游。
    const stages = buildLoopGenerationStages("loop-1", [loop, created.node], [created.connection], (candidate) =>
        new Set<string>([CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Text, CanvasNodeType.Audio, CanvasNodeType.Config]).has(candidate.type));
    assert.equal(stages.length, 1);
    assert.deepEqual(stages[0].map((item) => item.id), [created.node.id]);
});

test("自动创建的输出节点带提示词，且提示词显式引用循环节点", () => {
    const loop = { ...node("loop-1", CanvasNodeType.Loop), metadata: { loopPrompt: "雪中回眸" } };
    const created = createLoopFallbackOutput("loop-1", loop, (type, position, metadata) => smartConfigNode(`new-${type}`, type, metadata), { x: 460, y: 0 });

    // buildNodeGenerationContext 对 smart 节点只在识别到 @[node:…] 时才接参考，token 不能少。
    assert.equal(created.node.metadata?.prompt, "@[node:loop-1]");
    assert.equal(created.node.metadata?.composerContent, "@[node:loop-1]");
    assert.deepEqual(created.node.metadata?.loopPrompts, ["雪中回眸"], "循环提示词应作为逐轮提示词传下去");
});

test("自动创建的输出节点真实拿到循环这轮选中的参考", () => {
    const loop = { ...node("loop-1", CanvasNodeType.Loop), metadata: { loopMediaMode: "image" as const, loopPrompt: "雪中回眸" } };
    const created = createLoopFallbackOutput("loop-1", loop, (type, position, metadata) => smartConfigNode(`new-${type}`, type, metadata), { x: 460, y: 0 });
    const prompt = created.node.metadata?.composerContent ?? "";

    // 上游挂一张图，走真实 buildNodeGenerationContext 验证参考确实被接进来。
    const source = { ...node("img-1", CanvasNodeType.Image), metadata: { content: "https://example.test/a.png", status: "success" as const } };
    const context = buildNodeGenerationContext(
        created.node.id,
        [loop, source, created.node],
        [connection("img-1", "loop-1"), created.connection],
        prompt,
        undefined,
        { index: 0, total: 1, nodeId: "loop-1" },
    );

    // 图片模式走 separateLoopImages：循环这轮选中的图进 loopInputImages（生成时实际下发的就是它，
    // 见 project.tsx 的 loopInputImages 传参），不是 referenceImages。
    assert.equal(context.loopInputImages.length, 1, "循环本轮选中的参考图必须真的接进生成上下文");
    assert.equal(context.loopInputImages[0].dataUrl, "https://example.test/a.png");
    assert.equal(context.referenceImages.length, 0, "图片模式不应把循环图重复算进固定参考图");

    // token 的作用是让 composer 分支把 "@[node:…]" 换成参考标签；
    // 没有 token 会掉到非 composer 分支，token 字面量会直接漏进最终提示词。
    assert.equal(context.prompt, imageReferenceLabel(0), "token 应被替换成参考标签，而不是原样发给模型");
});

test("循环开启视频时自动创建视频智能节点", () => {
    const loop = { ...node("loop-1", CanvasNodeType.Loop), metadata: { loopVideoEnabled: true } };
    const created = createLoopFallbackOutput("loop-1", loop, (type, position, metadata) => smartConfigNode(`new-${type}`, type, metadata), { x: 460, y: 0 });
    assert.equal(created.node.metadata?.generationMode, "video");
});

test("循环没有提示词时不写入空 loopPrompts，避免复活旧文本", () => {
    const loop = node("loop-1", CanvasNodeType.Loop);
    const created = createLoopFallbackOutput("loop-1", loop, (type, position, metadata) => smartConfigNode(`new-${type}`, type, metadata), { x: 460, y: 0 });
    assert.equal(created.node.metadata?.loopPrompts, undefined, "没有提示词时必须留空，不能是空数组");
});

test("循环已有下游时不触发自动补节点", () => {
    const loop = node("loop-1", CanvasNodeType.Loop);
    const downstream = node("image-1", CanvasNodeType.Image);
    const isTarget = (candidate: CanvasNodeData) => candidate.type === CanvasNodeType.Image;
    assert.equal(buildLoopGenerationStages("loop-1", [loop, downstream], [connection("loop-1", "image-1")], isTarget).length, 1);
});
