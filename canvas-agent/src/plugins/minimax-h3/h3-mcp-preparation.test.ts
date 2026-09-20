import assert from "node:assert/strict";
import test from "node:test";

import { pluginMcp } from "./mcp.js";

function fixture() {
    const project: any = {
        id: "project-1",
        revision: 7,
        nodes: [
            {
                id: "h3-1",
                type: "minimax-h3",
                metadata: {
                    segments: [
                        { id: "s1", status: "success", result: "media:s1", modelName: "b25-49", megapixels: 0.2, sampler: "er_sde", scheduler: "simple", duration: 8.5, taskMode: "ref2va", prompt: "上一段" },
                        { id: "s2", status: "idle", modelName: "wrong-draft", megapixels: 1.5, sampler: "res_multistep", scheduler: "karras", duration: 10, taskMode: "ref2va", prompt: "旧草稿" },
                    ],
                },
            },
            {
                id: "character-1",
                type: "character",
                title: "沈昭宁",
                metadata: {
                    characterName: "沈昭宁",
                    characterAssetId: "asset-character-1",
                    characterImages: [
                        { url: "https://media.test/1.png", storageKey: "image:1", outfit: "三年前" },
                        { url: "https://media.test/2.png", storageKey: "image:2", outfit: "婚后" },
                        { url: "https://media.test/3.png", storageKey: "image:3", outfit: "夜行" },
                    ],
                },
            },
        ],
        connections: [],
    };
    const calls: any[] = [];
    const backend = {
        listCanvasProjects: async () => [project],
        applyCanvasOperations: async (_projectId: string, operations: any[], _expectedRevision?: number) => {
            calls.push(operations);
            for (const operation of operations) {
                if (operation.type === "update_h3_segment") {
                    const node = project.nodes.find((item: any) => item.id === operation.nodeId);
                    const segment = node.metadata.segments.find((item: any) => item.id === operation.segmentId);
                    Object.assign(segment, operation.patch);
                } else if (operation.type === "connect_nodes") {
                    project.connections.push({ fromNodeId: operation.fromNodeId, toNodeId: operation.toNodeId, role: operation.role, order: operation.order });
                }
            }
            project.revision += 1;
            return { project, revision: project.revision, operationResults: [] };
        },
    };
    const context: any = {
        backend,
        getCanvasNode: async (id: string) => project.nodes.find((node: any) => node.id === id) || null,
        getCanvasNodes: async () => project.nodes,
    };
    return { project, calls, handler: pluginMcp.createHandler(context).h3_prepare_clip! };
}

test("h3_prepare_clip 一次原子写入继承参数、角色组和已有节点连接", async () => {
    const { project, calls, handler } = fixture();
    const result: any = await handler({
        projectId: "project-1",
        nodeId: "h3-1",
        segmentId: "s2",
        patch: { sourceShotId: "S01-04~S01-06", title: "第二段", duration: 9, prompt: "{{subject:shen-zhao}}\n第二段动作" },
        characters: [{ characterNodeId: "character-1", subjectId: "shen-zhao", selectedOutfitStorageKeys: ["image:1"], voiceEnabled: false }],
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].some((operation: any) => operation.type === "add_node"), false);
    assert.equal(calls[0].filter((operation: any) => operation.type === "update_h3_segment").length, 1);
    assert.equal(calls[0].filter((operation: any) => operation.type === "connect_nodes").length, 1);
    const target = project.nodes[0].metadata.segments[1];
    assert.equal(target.modelName, "b25-49");
    assert.equal(target.megapixels, 0.2);
    assert.equal(target.sampler, "er_sde");
    assert.equal(target.duration, 9);
    const group = Object.values(target.h3CharacterGroups)[0] as any;
    assert.equal(group.characterNodeId, "character-1");
    assert.equal(group.outfits.length, 3);
    assert.deepEqual(group.outfits.filter((outfit: any) => outfit.enabled).map((outfit: any) => outfit.storageKey), ["image:1"]);
    assert.equal(result.snapshot.sourceSegmentId, "s1");
    assert.equal(result.snapshot.runtime.megapixels, 0.2);
    assert.equal(result.snapshot.characterGroups[0].catalogCount, 3);
    assert.equal(result.snapshot.characterGroups[0].enabledCount, 1);
    assert.equal(result.snapshot.references[0].subjectId, "shen-zhao");
});

test("h3_prepare_clip 预检失败时不写入部分状态", async () => {
    const { project, calls, handler } = fixture();
    delete project.nodes[1].metadata.characterAssetId;
    await assert.rejects(() => handler({
        projectId: "project-1",
        nodeId: "h3-1",
        segmentId: "s2",
        patch: { prompt: "{{subject:character-1}}" },
        characters: [{ characterNodeId: "character-1", selectedOutfitStorageKeys: ["image:1"] }],
    }), /characterAssetId/);
    assert.equal(calls.length, 0);
    assert.equal(project.nodes[0].metadata.segments[1].prompt, "旧草稿");
});
