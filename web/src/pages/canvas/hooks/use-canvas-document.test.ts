import assert from "node:assert/strict";
import test from "node:test";

import { createHistoryEntry, resolveHistoryOperations } from "./use-canvas-document";
import { collectImageStorageKeys } from "../../../services/image-storage";
import { applyBackendCanvasDelta, detectCanvasConflicts, diffCanvasProject, type CanvasProject } from "../../../stores/canvas/use-canvas-store";

function makeProject(nodes: Array<Record<string, unknown>>): CanvasProject {
    return {
        id: "p1", title: "撤销回归", revision: 7, createdAt: "2026-01-01", updatedAt: "2026-01-02",
        nodes: nodes as CanvasProject["nodes"], connections: [], chatSessions: [], activeChatId: null,
        backgroundMode: "lines", showImageInfo: false, globalPrompt: "", viewport: { x: 0, y: 0, k: 1 },
    } as CanvasProject;
}

const imageNode = () => ({
    id: "n-image", type: "image", title: "参考图",
    position: { x: 0, y: 0 }, width: 320, height: 240,
    metadata: {
        storageKey: "image:keep-me",
        content: "http://127.0.0.1:17370/media/image:keep-me",
        images: [{ id: "i1", storageKey: "image:keep-me" }],
    },
});

const h3Node = (prompt: string) => ({
    id: "n-h3", type: "minimax-h3", title: "分镜",
    position: { x: 400, y: 0 }, width: 420, height: 300,
    metadata: { segments: [{ id: "s1", prompt, status: "idle" }] },
});

test("删掉带图节点后，媒体清理仍判定该图在用且撤销能恢复", () => {
    const before = makeProject([imageNode(), h3Node("原稿")]);
    const after = makeProject([h3Node("原稿")]);
    const entry = createHistoryEntry(before, after, 1);

    assert.ok(entry.forwardOps.some((op) => op.type === "delete_node" && op.id === "n-image"));
    // cleanupCanvasFiles 把整个 history ref 当 extra 传给 collectImageStorageKeys；
    // 改成 ops 后，被删节点的图只能靠 inverseOps 的 add_node.metadata 或基线保住。
    const keys = collectImageStorageKeys({ projectId: "p1", past: [entry], future: [] });
    assert.ok(keys.has("image:keep-me"), "撤销可能恢复的图必须判为在用，否则清理后图片会裂");

    const restored = applyBackendCanvasDelta(after, entry.inverseOps, Number(after.revision || 0));
    const node = restored.nodes.find((item) => item.id === "n-image");
    assert.ok(node, "撤销必须把节点加回来");
    assert.equal((node!.metadata as Record<string, unknown> | undefined)?.storageKey, "image:keep-me");
});

test("正反 ops 等价于旧实现用两份完整快照现算的差分", () => {
    const before = makeProject([imageNode(), h3Node("原稿")]);
    const after = makeProject([{ ...imageNode(), title: "改过名" }, h3Node("新稿")]);
    const entry = createHistoryEntry(before, after, 1);

    assert.deepEqual(entry.forwardOps, diffCanvasProject(before, after));
    assert.deepEqual(entry.inverseOps, diffCanvasProject(after, before));

    // applyBackendCanvasDelta 会规范化 H3 段（补 start 等运行时字段），因此与旧实现的
    // 「现算 diff 再回放」结果比对，而不是直接和手工构造的 before / after 比。
    const undone = applyBackendCanvasDelta(after, entry.inverseOps, Number(after.revision || 0));
    const oldUndone = applyBackendCanvasDelta(after, diffCanvasProject(after, before), Number(after.revision || 0));
    assert.deepEqual(undone.nodes, oldUndone.nodes, "撤销回放结果必须与旧实现一致");
    assert.equal((undone.nodes.find((item) => item.id === "n-h3")?.metadata as { segments?: Array<{ prompt: string }> } | undefined)?.segments?.[0]?.prompt, "原稿");

    const redone = applyBackendCanvasDelta(before, entry.forwardOps, Number(before.revision || 0));
    const oldRedone = applyBackendCanvasDelta(before, diffCanvasProject(before, after), Number(before.revision || 0));
    assert.deepEqual(redone.nodes, oldRedone.nodes, "重做回放结果必须与旧实现一致");
    assert.equal((redone.nodes.find((item) => item.id === "n-h3")?.metadata as { segments?: Array<{ prompt: string }> } | undefined)?.segments?.[0]?.prompt, "新稿");
});

test("撤销与重做方向的最小基线，冲突判定与完整快照一致", () => {
    const before = makeProject([imageNode(), h3Node("原稿")]);
    const after = makeProject([h3Node("新稿")]);
    const entry = createHistoryEntry(before, after, 1);
    const remoteEdited = makeProject([
        { ...h3Node("新稿"), metadata: { segments: [{ id: "s1", prompt: "协作者改过", status: "idle" }] } },
    ]);

    for (const [name, remote] of [["组起点", before], ["组终点", after], ["被协作者改过", remoteEdited]] as const) {
        assert.deepEqual(
            detectCanvasConflicts(entry.inverseOps, remote, entry.undoBase),
            detectCanvasConflicts(entry.inverseOps, remote, after),
            `撤销方向「${name}」判定必须一致`,
        );
        assert.deepEqual(
            detectCanvasConflicts(entry.forwardOps, remote, entry.redoBase),
            detectCanvasConflicts(entry.forwardOps, remote, before),
            `重做方向「${name}」判定必须一致`,
        );
    }
});

test("撤销新增时若节点已被协作者改动则拒绝回放", () => {
    const before = makeProject([h3Node("原稿")]);
    const after = makeProject([h3Node("原稿"), imageNode()]);
    const entry = createHistoryEntry(before, after, 1);

    const clean = resolveHistoryOperations(after, entry, false);
    assert.equal(clean.error, undefined);
    assert.ok(clean.operations?.some((op) => op.type === "delete_node" && op.id === "n-image"), "未被改动时应允许撤销");

    const editedByPeer = makeProject([h3Node("原稿"), { ...imageNode(), title: "协作者改过" }]);
    const blocked = resolveHistoryOperations(editedByPeer, entry, false);
    assert.ok(blocked.error, "撤销新增不得删掉后来被他人编辑的实体");
    assert.equal(blocked.operations, undefined);
});

test("未被本次编辑触碰的大节点不进入历史条目", () => {
    const bigNode = {
        id: "n-big", type: "text", title: "长正文",
        position: { x: 900, y: 0 }, width: 320, height: 240,
        metadata: { content: "BIG_UNTOUCHED_NODE".repeat(1200) },
    };
    const before = makeProject([imageNode(), structuredClone(bigNode)]);
    const after = makeProject([{ ...imageNode(), title: "改过名" }, structuredClone(bigNode)]);
    const entry = createHistoryEntry(before, after, 1);

    assert.ok(!JSON.stringify(entry).includes("BIG_UNTOUCHED_NODE"), "作用域外节点不得被历史钉住");
    assert.ok(collectImageStorageKeys({ past: [entry] }).has("image:keep-me"), "作用域内的图仍要可收集");
});

test("历史条目数据量只跟本次变更走，不随画布节点数增长", () => {
    const unrelated = Array.from({ length: 300 }, (_, i) => ({
        id: `n-${i}`, type: "text", title: `文本 ${i}`,
        position: { x: i * 10, y: 0 }, width: 320, height: 240,
        metadata: { content: `节点正文 ${i} `.repeat(80) },
    }));
    const before = makeProject([imageNode(), ...unrelated]);
    const after = makeProject([{ ...imageNode(), title: "改过名" }, ...unrelated]);
    const entry = createHistoryEntry(before, after, 1);
    // 旧结构序列化会把两份完整项目都展开；JS 堆里未变节点是共享引用，所以这里比的是
    // 数据量级而不是精确堆占用，用来锁住历史不再随画布规模线性膨胀。
    const legacySerialized = JSON.stringify({ before, after, at: 1 }).length;
    const slimSerialized = JSON.stringify(entry).length;
    console.log(`# 单步序列化量级：双快照 ${legacySerialized} B / ops ${slimSerialized} B`);
    assert.ok(slimSerialized < legacySerialized / 10, `新结构应远小于双快照，实际 ${slimSerialized} vs ${legacySerialized}`);
});

test("撤销基线共享 store 节点引用，后续编辑不串改旧值", () => {
    const before = makeProject([imageNode(), h3Node("原稿")]);
    const after = makeProject([imageNode(), h3Node("新稿")]);
    const entry = createHistoryEntry(before, after, 1);

    const h3Index = after.nodes.findIndex((item) => item.id === "n-h3");
    assert.equal(entry.undoBase.nodes[0], after.nodes[h3Index], "基线应共享 store 节点引用，不深拷贝");
    assert.equal(entry.redoBase, entry.undoBase, "无删除时两个方向共用同一份基线");

    // 回放器只改新对象，不改写基线引用的旧节点。
    const next = applyBackendCanvasDelta(after, [
        { type: "update_h3_segment", nodeId: "n-h3", segmentId: "s1", patch: { prompt: "又改一稿" } },
    ], Number(after.revision || 0));
    assert.equal((entry.undoBase.nodes[0].metadata as { segments: Array<{ prompt: string }> }).segments[0].prompt, "新稿", "基线旧值不得被后续编辑串改");
    assert.equal((next.nodes[h3Index].metadata as { segments: Array<{ prompt: string }> }).segments[0].prompt, "又改一稿");
});

test("反复编辑大 H3 节点时两份基线共用一份，冲突判定不变", () => {
    const bigPrompt = "长稿".repeat(2000);
    const before = makeProject([h3Node(bigPrompt)]);
    const after = makeProject([h3Node(bigPrompt + "改")]);
    const entry = createHistoryEntry(before, after, 1);

    assert.ok(entry.inverseOps.some((op) => op.type === "update_h3_segment"));
    assert.equal(entry.undoBase, entry.redoBase, "无删除且作用域相同时应共用基线");
    assert.equal((entry.undoBase.nodes[0].metadata as { segments: Array<{ id: string }> } | undefined)?.segments?.[0]?.id, "s1");

    const remoteWithoutSegment = makeProject([{ ...h3Node(bigPrompt), metadata: { segments: [] } }]);
    for (const [name, remote] of [["组起点", before], ["组终点", after], ["远端删段", remoteWithoutSegment]] as const) {
        assert.deepEqual(
            detectCanvasConflicts(entry.inverseOps, remote, entry.undoBase),
            detectCanvasConflicts(entry.inverseOps, remote, after),
            `共用基线在「${name}」撤销方向判定必须等价于完整快照`,
        );
        assert.deepEqual(
            detectCanvasConflicts(entry.forwardOps, remote, entry.redoBase),
            detectCanvasConflicts(entry.forwardOps, remote, before),
            `共用基线在「${name}」重做方向判定必须等价于完整快照`,
        );
    }
});

test("删除类操作不共用基线，保留完整旧值供 unsafeDelete 比对", () => {
    const before = makeProject([imageNode(), h3Node("原稿")]);
    const after = makeProject([h3Node("原稿")]);
    const entry = createHistoryEntry(before, after, 1);
    assert.notEqual(entry.undoBase, entry.redoBase, "有删除时两个方向必须各自保留精确值");
    assert.equal((entry.redoBase.nodes[0].metadata as Record<string, unknown> | undefined)?.storageKey, "image:keep-me", "redo 基线必须保留被删节点的完整旧值");
});
