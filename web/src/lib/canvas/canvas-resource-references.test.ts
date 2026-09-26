import assert from "node:assert/strict";
import test from "node:test";
import { buildCanvasGraphIndex, createMentionReferenceSelector, getFixedReferenceNodes, getMentionResourceNodes, nodeResourceItems } from "./canvas-resource-references";
import { buildLoopSourceInputs, buildNodeGenerationContext, buildNodeGenerationInputs, recordLoopGenerationOutput, type CanvasLoopRuntimeContext } from "@/components/canvas/canvas-node-generation";
import { resolveLoopInputPlan } from "@/lib/canvas/canvas-loop-execution";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { sourceNodeReferenceImages } from "@/lib/canvas/canvas-generation-helpers";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

test("无关节点更新和裁剪变化保留引用数组，关联资源变化才失效", () => {
    const a: CanvasNodeData = { id: "a", type: CanvasNodeType.Text, title: "A", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: "a" } };
    const b = { ...a, id: "b", title: "B" };
    const select = createMentionReferenceSelector();
    let nodes = [a, b];
    const first = select(nodes, nodes, [], buildCanvasGraphIndex(nodes, []));
    nodes = [a, { ...b, metadata: { content: "edited" } }];
    const second = select(nodes, nodes, [], buildCanvasGraphIndex(nodes, []));
    assert.equal(first.get("a"), second.get("a"));
    assert.notEqual(first.get("b"), second.get("b"));
    assert.equal(select([a], nodes, [], buildCanvasGraphIndex(nodes, [])).get("a"), first.get("a"));
});

test("智能生成节点只把主图作为下游参考输入", () => {
    const source: CanvasNodeData = {
        id: "source",
        type: CanvasNodeType.Config,
        title: "源智能节点",
        position: { x: 0, y: 0 },
        width: 340,
        height: 240,
        metadata: {
            smart: true,
            generationMode: "image",
            content: "second.png",
            primaryImageId: "image-2",
            images: [
                { id: "image-1", status: "success", content: "first.png", storageKey: "media/first.png", naturalWidth: 100, naturalHeight: 100, bytes: 1, mimeType: "image/png" },
                { id: "image-2", status: "success", content: "second.png", storageKey: "media/second.png", naturalWidth: 100, naturalHeight: 100, bytes: 1, mimeType: "image/png" },
                { id: "image-3", status: "success", content: "third.png", storageKey: "media/third.png", naturalWidth: 100, naturalHeight: 100, bytes: 1, mimeType: "image/png" },
            ],
        },
    };
    const target: CanvasNodeData = { ...source, id: "target", title: "目标智能节点", metadata: { smart: true, generationMode: "image" } };
    const resources = nodeResourceItems(source);
    assert.deepEqual(resources.map((resource) => resource.storageKey), ["media/second.png"]);

    const inputs = buildNodeGenerationInputs("target", [source, target], [{ id: "connection", fromNodeId: "source", toNodeId: "target" }], buildCanvasGraphIndex([source, target], [{ id: "connection", fromNodeId: "source", toNodeId: "target" }]));
    assert.deepEqual(inputs.map((input) => input.type), ["image"]);
    assert.deepEqual(inputs.map((input) => input.type === "image" && input.image ? input.image.storageKey : undefined), ["media/second.png"]);
    assert.deepEqual(sourceNodeReferenceImages(source).map((image) => image.storageKey), ["media/second.png"]);
});

test("角色参考默认只用主图，存量服装选择保持原样", () => {
    const character: CanvasNodeData = {
        id: "character",
        type: CanvasNodeType.Character,
        title: "沈昭宁",
        position: { x: 0, y: 0 },
        width: 340,
        height: 480,
        metadata: {
            characterImages: [
                { url: "outfit-a.png", storageKey: "media/outfit-a.png", name: "outfit-a", outfit: "常服", outfitDescription: "", width: 100, height: 100, bytes: 1, mimeType: "image/png" },
                { url: "outfit-b.png", storageKey: "media/outfit-b.png", name: "outfit-b", outfit: "退婚雪服", outfitDescription: "", width: 100, height: 100, bytes: 1, mimeType: "image/png" },
            ],
            characterPrimaryIndex: 1,
        },
    };
    const baseTarget: CanvasNodeData = { id: "target", type: CanvasNodeType.Config, title: "目标", position: { x: 500, y: 0 }, width: 420, height: 540, metadata: { smart: true, generationMode: "image" } };
    const connection = { id: "character-target", fromNodeId: character.id, toNodeId: baseTarget.id, role: "reference" as const };
    const resolve = (metadata: CanvasNodeData["metadata"]) => {
        const target = { ...baseTarget, metadata };
        const nodes = [character, target];
        const connections = [connection];
        return buildNodeGenerationInputs(target.id, nodes, connections, buildCanvasGraphIndex(nodes, connections))
            .filter((input) => input.type === "image")
            .map((input) => input.type === "image" ? input.image?.storageKey : undefined);
    };

    assert.deepEqual(resolve(baseTarget.metadata), ["media/outfit-b.png"]);
    assert.deepEqual(resolve({ ...baseTarget.metadata, characterReferences: { character: { imageKeys: ["media/outfit-a.png"] } } }), ["media/outfit-a.png"]);
    assert.deepEqual(resolve({ ...baseTarget.metadata, characterReferences: { character: { imageKeys: [] } } }), []);
});

test("循环节点按轮次选择上游图片并渲染循环变量", () => {
    const imageA: CanvasNodeData = { id: "image-a", type: CanvasNodeType.Image, title: "A", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: "a.png", storageKey: "media/a.png" } };
    const imageB: CanvasNodeData = { id: "image-b", type: CanvasNodeType.Image, title: "B", position: { x: 0, y: 120 }, width: 100, height: 100, metadata: { content: "b.png", storageKey: "media/b.png" } };
    const loop: CanvasNodeData = {
        id: "loop",
        type: CanvasNodeType.Loop,
        title: "循环",
        position: { x: 160, y: 0 },
        width: 380,
        height: 320,
        metadata: { loopCount: 3, loopImageEnabled: true, loopPromptEnabled: true, loopPrompt: "第《计数》轮 / 共《总数》轮" },
    };
    const target: CanvasNodeData = { id: "target", type: CanvasNodeType.Config, title: "目标", position: { x: 600, y: 0 }, width: 420, height: 540, metadata: { smart: true, generationMode: "image" } };
    const nodes = [imageA, imageB, loop, target];
    const connections = [
        { id: "a-loop", fromNodeId: imageA.id, toNodeId: loop.id },
        { id: "b-loop", fromNodeId: imageB.id, toNodeId: loop.id },
        { id: "loop-target", fromNodeId: loop.id, toNodeId: target.id },
    ];
    const index = buildCanvasGraphIndex(nodes, connections);
    const first = buildNodeGenerationInputs(target.id, nodes, connections, index, { index: 0, total: 3 });
    const second = buildNodeGenerationInputs(target.id, nodes, connections, index, { index: 1, total: 3 });
    assert.deepEqual(first.map((input) => input.type), ["text", "image"]);
    assert.equal(first[0].type === "text" ? first[0].text : "", "第1轮 / 共3轮");
    assert.equal(first[1].type === "image" ? first[1].image?.storageKey : "", "media/a.png");
    assert.equal(second[1].type === "image" ? second[1].image?.storageKey : "", "media/b.png");
});

test("有序图片组逐张循环时保留固定提示词和两张参考图，得到七个独立输入", () => {
    const images: CanvasNodeData[] = Array.from({ length: 7 }, (_, index) => ({
        id: `group-image-${index + 1}`, type: CanvasNodeType.Image, title: `图 ${index + 1}`,
        position: { x: 0, y: 0 }, width: 100, height: 100,
        metadata: { groupId: "group", content: `group-${index + 1}.png`, storageKey: `media/group-${index + 1}.png` },
    }));
    const group: CanvasNodeData = { id: "group", type: CanvasNodeType.Group, title: "图片组", position: { x: 0, y: 0 }, width: 800, height: 600,
        metadata: { orderedGroup: true, groupSlots: images.map((image) => image.id) } };
    const loop: CanvasNodeData = { id: "loop", type: CanvasNodeType.Loop, title: "循环", position: { x: 900, y: 0 }, width: 380, height: 320,
        metadata: { loopCount: 1, loopCountMode: "auto", loopMediaMode: "auto" } };
    const refs: CanvasNodeData[] = [1, 2].map((index) => ({ id: `fixed-${index}`, type: CanvasNodeType.Image, title: `参考 ${index}`,
        position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: `fixed-${index}.png`, storageKey: `media/fixed-${index}.png` } }));
    const prompt = "每张图高清重绘 @[node:fixed-1] @[node:fixed-2]";
    const target: CanvasNodeData = { id: "target", type: CanvasNodeType.Config, title: "智能生成", position: { x: 1400, y: 0 }, width: 420, height: 540,
        metadata: { smart: true, generationMode: "image", composerContent: prompt } };
    const nodes = [images[4], refs[1], images[0], group, loop, images[6], target, ...images.filter((image) => ![images[0], images[4], images[6]].includes(image)), refs[0]];
    const connections = [{ id: "group-loop", fromNodeId: group.id, toNodeId: loop.id }, { id: "group-target", fromNodeId: group.id, toNodeId: target.id }, { id: "loop-target", fromNodeId: loop.id, toNodeId: target.id },
        ...refs.map((ref) => ({ id: `${ref.id}-target`, fromNodeId: ref.id, toNodeId: target.id }))];
    const graphIndex = buildCanvasGraphIndex(nodes, connections);
    assert.deepEqual(getFixedReferenceNodes(target.id, nodes, graphIndex).map((node) => node.id), ["fixed-1", "fixed-2"]);
    assert.deepEqual(getMentionResourceNodes(target.id, nodes, connections, graphIndex).filter((node) => node.type === CanvasNodeType.Image).map((node) => node.id), ["fixed-1", "fixed-2"]);
    const sources = buildLoopSourceInputs(loop.id, nodes, connections);
    assert.equal(sources.length, 7);
    const plan = resolveLoopInputPlan(loop.metadata || {}, sources.filter((input) => input.type === "image").length, 0);
    assert.equal(plan.rounds, 7);
    const rounds = Array.from({ length: plan.rounds }, (_, index) => buildNodeGenerationContext(target.id, nodes, connections, prompt, undefined, { index, total: plan.rounds, nodeId: loop.id }));
    assert.deepEqual(rounds.map((round) => round.referenceImages.map((image) => image.storageKey)),
        images.map(() => ["media/fixed-1.png", "media/fixed-2.png"]));
    assert.deepEqual(rounds.map((round) => round.loopInputImages.map((image) => image.storageKey)),
        images.map((image) => [image.metadata?.storageKey]));
    assert.equal(new Set(rounds.map((round) => round.prompt)).size, 1);
    assert.ok(rounds.every((round) => round.prompt.includes(imageReferenceLabel(1)) && round.prompt.includes(imageReferenceLabel(2))));
    assert.ok(rounds.every((round) => round.imageCount === 2));
    const plainTarget = { ...target, metadata: { ...target.metadata, composerContent: "每张图高清重绘" } };
    const plainRound = buildNodeGenerationContext(target.id, nodes.map((node) => node.id === target.id ? plainTarget : node), connections, "每张图高清重绘", undefined, { index: 3, total: 7, nodeId: loop.id });
    assert.equal(plainRound.prompt, "每张图高清重绘");
    assert.deepEqual(plainRound.referenceImages.map((image) => image.storageKey), ["media/fixed-1.png", "media/fixed-2.png"]);
    assert.deepEqual(plainRound.loopInputImages.map((image) => image.storageKey), ["media/group-4.png"]);
});

test("现场连线：两张固定图和八镜组都接循环，八轮各取一镜", () => {
    const fixed = [1, 2].map((index): CanvasNodeData => ({ id: `fixed-${index}`, type: CanvasNodeType.Config, title: `固定参考 ${index}`,
        position: { x: 0, y: 0 }, width: 420, height: 540,
        metadata: { smart: true, generationMode: "image", content: `fixed-${index}.png`, storageKey: `media/fixed-${index}.png` } }));
    const frames = Array.from({ length: 8 }, (_, index): CanvasNodeData => ({ id: `frame-${index + 1}`, type: CanvasNodeType.Image, title: `镜 ${index + 1}`,
        position: { x: 0, y: 0 }, width: 100, height: 100,
        metadata: { groupId: "group", content: `frame-${index + 1}.png`, storageKey: `media/frame-${index + 1}.png` } }));
    const group: CanvasNodeData = { id: "group", type: CanvasNodeType.Group, title: "八镜首帧", position: { x: 0, y: 0 }, width: 800, height: 600,
        metadata: { orderedGroup: true, groupSlots: frames.map((frame) => frame.id) } };
    const loop: CanvasNodeData = { id: "loop", type: CanvasNodeType.Loop, title: "循环", position: { x: 0, y: 0 }, width: 380, height: 320,
        metadata: { loopCount: 3, loopCountMode: "auto", loopImageEnabled: false, loopStart: 1, loopImageBatchSize: 1 } };
    const target: CanvasNodeData = { id: "target", type: CanvasNodeType.Image, title: "每张图高清重绘", position: { x: 0, y: 0 }, width: 340, height: 240,
        metadata: { prompt: "每张图高清重绘", content: "old-result.png", storageKey: "media/old-result.png" } };
    const nodes = [frames[5], fixed[1], group, target, ...frames.filter((frame) => frame !== frames[5]), loop, fixed[0]];
    const connections = [...fixed.map((item) => ({ id: `${item.id}-loop`, fromNodeId: item.id, toNodeId: loop.id })),
        { id: "group-loop", fromNodeId: group.id, toNodeId: loop.id }, { id: "loop-target", fromNodeId: loop.id, toNodeId: target.id }];
    const graph = buildCanvasGraphIndex(nodes, connections);
    assert.deepEqual(getFixedReferenceNodes(target.id, nodes, graph).map((item) => item.id), ["fixed-1", "fixed-2"]);
    assert.deepEqual(getMentionResourceNodes(target.id, nodes, connections, graph).filter((item) => item.type === CanvasNodeType.Config).map((item) => item.id), ["fixed-1", "fixed-2"]);
    const sources = buildLoopSourceInputs(loop.id, nodes, connections, graph);
    assert.equal(sources.filter((input) => input.type === "image").length, 8);
    const plan = resolveLoopInputPlan(loop.metadata || {}, 8, 0);
    assert.equal(plan.rounds, 8);
    const rounds = Array.from({ length: plan.rounds }, (_, index) => buildNodeGenerationContext(target.id, nodes, connections, "每张图高清重绘", graph, { index, total: plan.rounds, nodeId: loop.id }));
    assert.ok(rounds.every((round) => round.prompt === "每张图高清重绘"));
    assert.deepEqual(rounds.map((round) => round.referenceImages.map((image) => image.storageKey)), frames.map(() => ["media/fixed-1.png", "media/fixed-2.png"]));
    assert.deepEqual(rounds.map((round) => round.loopInputImages.map((image) => image.storageKey)), frames.map((frame) => [frame.metadata?.storageKey]));
});

test("循环素材从指定序号按批量前进，耗尽后不会从头重复", () => {
    const images: CanvasNodeData[] = ["a", "b", "c", "d"].map((name, index) => ({
        id: name, type: CanvasNodeType.Image, title: name, position: { x: 0, y: index * 100 }, width: 100, height: 100,
        metadata: { content: `${name}.png`, storageKey: `media/${name}.png` },
    }));
    const prompt: CanvasNodeData = { id: "prompt", type: CanvasNodeType.Text, title: "提示词", position: { x: 0, y: 450 }, width: 100, height: 100, metadata: { content: "上游第《计数》张" } };
    const loop: CanvasNodeData = { id: "loop", type: CanvasNodeType.Loop, title: "循环", position: { x: 150, y: 0 }, width: 380, height: 320, metadata: { loopStart: 2, loopCount: 3, loopImageEnabled: true, loopImageBatchSize: 2, loopPromptEnabled: true, loopPrompt: "本地第《计数》张，共《总数》张" } };
    const target: CanvasNodeData = { id: "target", type: CanvasNodeType.Config, title: "目标", position: { x: 600, y: 0 }, width: 420, height: 540, metadata: { smart: true, generationMode: "image" } };
    const nodes = [...images, prompt, loop, target];
    const connections = [...images, prompt].map((source) => ({ id: `${source.id}-loop`, fromNodeId: source.id, toNodeId: loop.id })).concat([{ id: "loop-target", fromNodeId: loop.id, toNodeId: target.id }]);
    const rounds = [0, 1, 2].map((iteration) => buildNodeGenerationInputs(target.id, nodes, connections, undefined, { index: iteration, total: 6 }));
    const media = rounds.map((inputs) => inputs.flatMap((input) => input.type === "image" ? [input.image?.storageKey] : []));
    assert.deepEqual(media, [["media/b.png", "media/c.png"], ["media/d.png"], []]);
    assert.match(rounds[0][0].type === "text" ? rounds[0][0].text || "" : "", /上游第2张[\s\S]*本地第2张，共6张/);
    assert.match(rounds[1][0].type === "text" ? rounds[1][0].text || "" : "", /上游第4张[\s\S]*本地第4张，共6张/);
});

test("循环链路下游读取本轮任务结果，不读取源节点的旧图片", () => {
    const source: CanvasNodeData = { id: "source", type: CanvasNodeType.Image, title: "源", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: "old.png", storageKey: "media/old.png" } };
    const target: CanvasNodeData = { id: "target", type: CanvasNodeType.Config, title: "下游", position: { x: 200, y: 0 }, width: 420, height: 540, metadata: { smart: true, generationMode: "image" } };
    const context: CanvasLoopRuntimeContext = { index: 1, total: 3, roundOutputs: new Map() };
    recordLoopGenerationOutput(context, source, "image", { result: { media: [{ url: "/media/new.png", storageKey: "media/new.png", mimeType: "image/png" }] } });
    const inputs = buildNodeGenerationInputs(target.id, [source, target], [{ id: "source-target", fromNodeId: source.id, toNodeId: target.id }], undefined, context);
    assert.deepEqual(inputs.filter((input) => input.type === "image").map((input) => input.type === "image" ? input.image?.storageKey : ""), ["media/new.png"]);
});

test("并行轮次对同一下游节点保持各自的上游结果", () => {
    const source: CanvasNodeData = { id: "source", type: CanvasNodeType.Config, title: "上游生成", position: { x: 0, y: 0 }, width: 420, height: 540, metadata: { smart: true, generationMode: "image", content: "old.png" } };
    const target: CanvasNodeData = { id: "target", type: CanvasNodeType.Config, title: "下游生成", position: { x: 500, y: 0 }, width: 420, height: 540, metadata: { smart: true, generationMode: "image" } };
    const nodes = [source, target];
    const connections = [{ id: "source-target", fromNodeId: source.id, toNodeId: target.id }];
    const first: CanvasLoopRuntimeContext = { index: 0, total: 2, roundOutputs: new Map() };
    const second: CanvasLoopRuntimeContext = { index: 1, total: 2, roundOutputs: new Map() };
    recordLoopGenerationOutput(first, source, "image", { result: { media: [{ url: "/media/first", storageKey: "image:first" }] } });
    recordLoopGenerationOutput(second, source, "image", { result: { media: [{ url: "/media/second", storageKey: "image:second" }] } });
    const keys = [first, second].map((context) => buildNodeGenerationInputs(target.id, nodes, connections, undefined, context)
        .flatMap((input) => input.type === "image" ? [input.image?.storageKey] : []));
    assert.deepEqual(keys, [["image:first"], ["image:second"]]);
});

test("并行视频轮次传递本轮视频结果", () => {
    const source: CanvasNodeData = { id: "source-video", type: CanvasNodeType.Config, title: "上游视频", position: { x: 0, y: 0 }, width: 420, height: 540, metadata: { smart: true, generationMode: "video", content: "old.mp4" } };
    const target: CanvasNodeData = { id: "target-video", type: CanvasNodeType.Config, title: "下游视频", position: { x: 500, y: 0 }, width: 420, height: 540, metadata: { smart: true, generationMode: "video" } };
    const context: CanvasLoopRuntimeContext = { index: 1, total: 2, roundOutputs: new Map() };
    recordLoopGenerationOutput(context, source, "video", { result: { media: [{ url: "/media/new.mp4", storageKey: "video:new", mimeType: "video/mp4" }] } });
    const inputs = buildNodeGenerationInputs(target.id, [source, target], [{ id: "video-edge", fromNodeId: source.id, toNodeId: target.id }], undefined, context);
    assert.deepEqual(inputs.flatMap((input) => input.type === "video" ? [input.video?.storageKey] : []), ["video:new"]);
});

test("循环提示词逐条轮换，并合并上游与本地内容", () => {
    const prompt: CanvasNodeData = { id: "prompt", type: CanvasNodeType.Text, title: "上游", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: "上游 A\n上游 B" } };
    const loop: CanvasNodeData = { id: "loop", type: CanvasNodeType.Loop, title: "循环", position: { x: 200, y: 0 }, width: 380, height: 320, metadata: { loopStart: 2, loopCount: 2, loopPromptEnabled: true, loopPrompt: "本地 X\n本地 Y" } };
    const target: CanvasNodeData = { id: "target", type: CanvasNodeType.Config, title: "目标", position: { x: 650, y: 0 }, width: 420, height: 540, metadata: { smart: true, generationMode: "image" } };
    const nodes = [prompt, loop, target];
    const connections = [{ id: "prompt-loop", fromNodeId: prompt.id, toNodeId: loop.id }, { id: "loop-target", fromNodeId: loop.id, toNodeId: target.id }];
    const first = buildNodeGenerationInputs(target.id, nodes, connections, undefined, { index: 0, total: 3 });
    const second = buildNodeGenerationInputs(target.id, nodes, connections, undefined, { index: 1, total: 3 });
    assert.equal(first[0].type === "text" ? first[0].text : "", "上游 B\n\n本地 Y");
    assert.equal(second[0].type === "text" ? second[0].text : "", "上游 A\n\n本地 X");
});

test("智能循环默认提示词在有上游提示词时不重复追加", () => {
    const prompt: CanvasNodeData = { id: "prompt", type: CanvasNodeType.Text, title: "上游", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: "上游提示" } };
    const loop: CanvasNodeData = { id: "loop", type: CanvasNodeType.Loop, title: "循环", position: { x: 200, y: 0 }, width: 380, height: 320, metadata: { loopPromptEnabled: true, loopPrompt: "现在生成第《计数》张卖点图片" } };
    const target: CanvasNodeData = { id: "target", type: CanvasNodeType.Config, title: "目标", position: { x: 650, y: 0 }, width: 420, height: 540, metadata: { smart: true, generationMode: "image" } };
    const inputs = buildNodeGenerationInputs(target.id, [prompt, loop, target], [
        { id: "prompt-loop", fromNodeId: prompt.id, toNodeId: loop.id }, { id: "loop-target", fromNodeId: loop.id, toNodeId: target.id },
    ]);
    assert.equal(inputs[0].type === "text" ? inputs[0].text : "", "上游提示");
});

test("智能循环逐条提示词数组优先于旧文本字段，空数组不复活旧提示词", () => {
    const loop: CanvasNodeData = { id: "loop", type: CanvasNodeType.Loop, title: "循环", position: { x: 0, y: 0 }, width: 380, height: 320,
        metadata: { loopPromptEnabled: true, loopPrompt: "旧提示词", loopPrompts: ["新提示 A", "", "新提示 B"] } };
    const target: CanvasNodeData = { id: "target", type: CanvasNodeType.Config, title: "目标", position: { x: 500, y: 0 }, width: 420, height: 540, metadata: { smart: true, generationMode: "image" } };
    const connection = [{ id: "loop-target", fromNodeId: loop.id, toNodeId: target.id }];
    const first = buildNodeGenerationInputs(target.id, [loop, target], connection, undefined, { index: 0, total: 2 });
    const second = buildNodeGenerationInputs(target.id, [loop, target], connection, undefined, { index: 1, total: 2 });
    assert.equal(first[0].type === "text" ? first[0].text : "", "新提示 A");
    assert.equal(second[0].type === "text" ? second[0].text : "", "新提示 B");
    const empty = { ...loop, metadata: { ...loop.metadata, loopPrompts: [] } };
    assert.deepEqual(buildNodeGenerationInputs(target.id, [empty, target], connection), []);
});
