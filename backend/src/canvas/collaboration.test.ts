import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as Y from "yjs";
import { BackendDatabase } from "../db.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandFingerprint, concurrentCommandConflicts, type CanvasCommit } from "./collaboration.js";
import { compileReferenceSubmission } from "@basketikun/canvas-agent/reference-contract";

function fixture(t: TestContext) {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    db.createCanvasProject({ id: "canvas", title: "协作测试", revision: 0, nodes: [], connections: [], updatedAt: new Date().toISOString() });
    db.applyCanvasProjectOperations("canvas", undefined, [{ type: "add_node", id: "text", nodeType: "text", metadata: { content: "甲乙" } }]);
    return db;
}

test("角色主图变更原子更新下游引用，回执/广播/历史重放一致，失败不留下半次更新", (t) => {
    const db = fixture(t);
    db.applyCanvasProjectOperations("canvas", undefined, [
        { type: "add_node", id: "char", nodeType: "character", metadata: { characterPrimaryIndex: 0, characterImages: [{ storageKey: "image:a" }, { storageKey: "image:b" }] } },
        { type: "add_node", id: "target", nodeType: "config", metadata: { characterReferences: { char: { imageKeys: ["image:a"], voiceEnabled: false } }, images: [{ id: "old", generationSnapshot: { references: [{ storageKey: "image:a" }] } }] } },
        { type: "connect_nodes", fromNodeId: "char", toNodeId: "target" },
    ]);
    const before = db.getCanvasProject("canvas")!;
    const operations = [{ type: "update_node", id: "char", metadata: { characterPrimaryIndex: 1 } }];
    assert.throws(() => db.applyCanvasProjectOperations("canvas", undefined, [...operations, { type: "update_node", id: "missing" }]));
    assert.deepEqual(db.getCanvasProject("canvas"), before);
    let broadcast: CanvasCommit | undefined;
    db.onCanvasCommit((commit) => { broadcast = commit; });
    const changed = db.applyCanvasProjectOperations("canvas", undefined, operations, { operationId: "primary-change" });
    assert.deepEqual(changed.operations.map((op: { type: string; id?: unknown }) => [op.type, op.id]), [["update_node", "char"], ["update_node", "target"]]);
    const target = (changed.project.nodes as Array<Record<string, any>>).find((node) => node.id === "target")!;
    assert.deepEqual(target.metadata.characterReferences.char, { imageKeys: ["image:b"], voiceEnabled: false });
    assert.equal(target.metadata.images[0].generationSnapshot.references[0].storageKey, "image:a");
    assert.deepEqual(broadcast?.operations, changed.operations);
    const repeated = db.applyCanvasProjectOperations("canvas", undefined, operations, { operationId: "primary-change" });
    assert.equal(repeated.duplicated, true);
    assert.deepEqual(repeated.project, changed.project);
    assert.deepEqual(repeated.operations, changed.operations);
});

test("角色形象图原位替换在同一 ops 事务刷新所有 H3 Clip 与生成输入", (t) => {
    const db = fixture(t);
    const characterImages = [
        { storageKey: "image:a", url: "https://media.test/a.png", outfit: "形象" },
        { storageKey: "image:b", url: "https://media.test/b.png", outfit: "常服" },
    ];
    const characterGroup = {
        id: "group-char", characterName: "苏青璃", characterNodeId: "char", characterAssetId: "asset-char",
        subjectId: "char", outfitEnabled: true, voiceEnabled: false,
        outfits: [
            { id: "outfit-a", storageKey: "image:a", url: "https://media.test/a.png", name: "形象", role: "character_turnaround", enabled: true },
            { id: "outfit-b", storageKey: "image:b", url: "https://media.test/b.png", name: "常服", role: "character_turnaround", enabled: false },
        ],
    };
    db.applyCanvasProjectOperations("canvas", undefined, [
        { type: "add_node", id: "char", nodeType: "character", title: "苏青璃", metadata: { characterAssetId: "asset-char", characterImages, characterPrimaryIndex: 0 } },
        { type: "add_node", id: "h3", nodeType: "minimax-h3:video", metadata: { segments: [
            { id: "clip-a", taskMode: "ref2va", h3CharacterGroups: { "group-char": characterGroup }, results: [{ url: "https://media.test/old-output.mp4" }] },
            { id: "clip-b", taskMode: "ref2va", h3CharacterGroups: { "group-char": characterGroup } },
        ] } },
    ]);
    const operations = [{ type: "update_node", id: "char", metadata: { characterImages: [
        { storageKey: "image:new", url: "https://media.test/new.png", outfit: "新形象" }, characterImages[1],
    ] } }];
    const before = db.getCanvasProject("canvas")!;
    assert.throws(() => db.applyCanvasProjectOperations("canvas", undefined, [...operations, { type: "update_node", id: "missing" }]));
    assert.deepEqual(db.getCanvasProject("canvas"), before);
    let broadcast: CanvasCommit | undefined;
    db.onCanvasCommit((commit) => { broadcast = commit; });
    const receipt = db.applyCanvasProjectOperations("canvas", undefined, operations, { operationId: "replace-character-image" });
    assert.deepEqual(receipt.operations.map((operation: { type: string; segmentId?: string }) => [operation.type, operation.segmentId || ""]), [
        ["update_node", ""], ["update_h3_segment", "clip-a"], ["update_h3_segment", "clip-b"],
    ]);
    const h3 = (receipt.project.nodes as Array<Record<string, any>>).find((node) => node.id === "h3")!;
    const segments = h3.metadata.segments as Array<Record<string, any>>;
    for (const segment of segments) {
        const outfits = segment.h3CharacterGroups["group-char"].outfits;
        assert.deepEqual(outfits.map((outfit: Record<string, unknown>) => [outfit.id, outfit.storageKey, outfit.enabled]), [
            ["outfit-a", "image:new", true], ["outfit-b", "image:b", false],
        ]);
        const compiled = compileReferenceSubmission(receipt.project, segment);
        assert.deepEqual(compiled.references.filter((ref) => ref.mediaType === "image").map((ref) => ref.storageKey), ["image:new"]);
    }
    assert.equal(segments[0].results[0].url, "https://media.test/old-output.mp4");
    assert.deepEqual(broadcast?.operations, receipt.operations);
    const replay = db.applyCanvasProjectOperations("canvas", undefined, operations, { operationId: "replace-character-image" });
    assert.equal(replay.duplicated, true);
    assert.deepEqual(replay.project, receipt.project);
});

test("持久候选不改原文，重复保存不重复；采用与状态确认是同一事务", (t) => {
    const db = fixture(t);
    const target = { nodeId: "text", field: "content" as const };
    const doc = db.getCanvasText("canvas", target);
    const save = [{ type: "save_text_suggestion", suggestion: { id: "candidate", target, documentId: doc.documentId, base: doc.text, text: "强化" } }];
    const first = db.applyCanvasProjectOperations("canvas", undefined, save, { operationId: "save" });
    assert.equal(db.getCanvasText("canvas", target).text, doc.text);
    assert.deepEqual(db.applyCanvasProjectOperations("canvas", undefined, save, { operationId: "save" }).project, first.project);
    assert.equal(db.listCanvasTextSuggestions("canvas", target).length, 1);
    // 候选日志不应导致无关字段冲突。
    db.applyCanvasProjectOperations("canvas", undefined, [{ type: "update_node", id: "text", patch: { title: "改名" } }], { baseRevision: 1 });
    const apply = { type: "resolve_text_suggestion", id: "candidate", action: "apply", documentId: doc.documentId, expectedText: doc.text };
    assert.throws(() => db.applyCanvasProjectOperations("canvas", undefined, [apply, { type: "update_node", id: "missing" }], { operationId: "adopt" }));
    assert.equal(db.getCanvasText("canvas", target).text, doc.text);
    assert.equal(db.listCanvasTextSuggestions("canvas")[0].status, "pending");
    const adopted = db.applyCanvasProjectOperations("canvas", undefined, [apply], { operationId: "adopt" });
    assert.equal(db.getCanvasText("canvas", target).text, "强化");
    assert.equal(db.listCanvasTextSuggestions("canvas")[0].status, "applied");
    db.applyCanvasProjectOperations("canvas", undefined, [{ type: "update_node", id: "text", metadata: { content: "后来编辑" } }]);
    assert.deepEqual(db.applyCanvasProjectOperations("canvas", undefined, [apply], { operationId: "adopt" }).project, adopted.project);
    assert.equal(db.getCanvasText("canvas", target).text, "后来编辑");
    assert.throws(() => db.applyCanvasProjectOperations("canvas", undefined, [{ type: "resolve_text_suggestion", id: "candidate", action: "dismiss" }]), { code: "TEXT_SUGGESTION_RESOLVED" });
});

test("原文变化保留候选；同 ID 文本重建后旧候选只读，忽略不改正文", (t) => {
    const db = fixture(t);
    const target = { nodeId: "text", field: "content" as const };
    const doc = db.getCanvasText("canvas", target);
    db.applyCanvasProjectOperations("canvas", undefined, [{ type: "save_text_suggestion", suggestion: { id: "old", target, documentId: doc.documentId, base: doc.text, text: "候选" } }]);
    db.applyCanvasProjectOperations("canvas", undefined, [{ type: "update_node", id: "text", metadata: { content: "协作者输入" } }]);
    assert.throws(() => db.applyCanvasProjectOperations("canvas", undefined, [{ type: "resolve_text_suggestion", id: "old", action: "apply", documentId: doc.documentId, expectedText: doc.text }]), { code: "TEXT_CONFLICT" });
    assert.equal(db.listCanvasTextSuggestions("canvas")[0].status, "pending");
    db.applyCanvasProjectOperations("canvas", undefined, [{ type: "delete_node", id: "text" }, { type: "add_node", id: "text", nodeType: "text", metadata: { content: "新目标" } }]);
    const next = db.getCanvasText("canvas", target);
    for (const documentId of [doc.documentId, next.documentId]) {
        assert.throws(() => db.applyCanvasProjectOperations("canvas", undefined, [{ type: "resolve_text_suggestion", id: "old", action: "apply", documentId, expectedText: "新目标" }]), { code: "TEXT_DOCUMENT_REPLACED" });
    }
    db.applyCanvasProjectOperations("canvas", undefined, [{ type: "resolve_text_suggestion", id: "old", action: "dismiss" }]);
    assert.equal(db.getCanvasText("canvas", target).text, "新目标");
    assert.equal(db.listCanvasTextSuggestions("canvas")[0].status, "dismissed");
    const forged = db.applyCanvasProjectOperations("canvas", undefined, [{ type: "update_node", id: "text", patch: { title: "合法改名" }, textSuggestion: { id: "fake" }, textUpdate: { update: "fake" }, textUpdates: [{ update: "fake" }] }]);
    assert.equal(forged.operations[0].textSuggestion, undefined);
    assert.equal(forged.operations[0].textUpdate, undefined);
    assert.equal(forged.operations[0].textUpdates, undefined);
});

test("候选在关闭数据库重开后仍在，旧保存回执可还原；篡改候选 ID 内容被拒绝", () => {
    const directory = mkdtempSync(join(tmpdir(), "canvas-suggestion-test-"));
    const file = join(directory, "test.sqlite");
    let db = new BackendDatabase(file);
    try {
        db.createCanvasProject({ id: "c", nodes: [], connections: [], globalPrompt: "原文", revision: 0 });
        const target = { field: "globalPrompt" as const };
        const doc = db.getCanvasText("c", target);
        const suggestion = { id: "persistent", target, documentId: doc.documentId, base: doc.text, text: "候选" };
        const save = [{ type: "save_text_suggestion", suggestion }];
        const receipt = db.applyCanvasProjectOperations("c", undefined, save, { operationId: "request" });
        db.close();
        db = new BackendDatabase(file);
        assert.equal(db.listCanvasTextSuggestions("c")[0].text, "候选");
        assert.deepEqual(db.applyCanvasProjectOperations("c", undefined, save, { operationId: "request" }).project, receipt.project);
        assert.throws(() => db.applyCanvasProjectOperations("c", undefined, [{ type: "save_text_suggestion", suggestion: { ...suggestion, text: "篡改" } }]), { code: "OPERATION_ID_REUSED" });
        assert.throws(() => db.applyCanvasProjectOperations("c", undefined, [{ type: "text_suggestion", textSuggestion: suggestion }]));
    } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("同一 operationId 重放返回原 revision 与原快照，而不是混入后续提交", (t) => {
    const db = fixture(t);
    const commits: CanvasCommit[] = [];
    db.onCanvasCommit((commit) => commits.push(commit));
    const operations = [{ type: "update_node", id: "text", patch: { title: "第一次" } }];
    const first = db.applyCanvasProjectOperations("canvas", undefined, operations, { operationId: "same", baseRevision: 1, source: { clientId: "before-reconnect" } });
    db.applyCanvasProjectOperations("canvas", undefined, [{ type: "update_node", id: "text", patch: { title: "第二次" } }]);
    const replay = db.applyCanvasProjectOperations("canvas", undefined, operations, { operationId: "same", baseRevision: 1, source: { clientId: "after-reconnect" } });
    assert.equal(replay.duplicated, true);
    assert.deepEqual(replay.project, first.project);
    assert.equal(replay.revision, 2);
    assert.equal(db.getCanvasProject("canvas")?.revision, 3);
    assert.equal(commits.length, 2);
    assert.throws(() => db.applyCanvasProjectOperations("canvas", undefined, [{ type: "delete_node", id: "text" }], { operationId: "same", baseRevision: 1 }), { code: "OPERATION_ID_REUSED" });
});

test("批处理失败同时回滚文档、Yjs 状态、journal 和回执，且不广播", (t) => {
    const db = fixture(t);
    const target = { nodeId: "text", field: "content" as const };
    const original = db.getCanvasText("canvas", target);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Buffer.from(original.state, "base64"));
    const vector = Y.encodeStateVector(doc);
    doc.getText("text").insert(1, "丙");
    const update = Buffer.from(Y.encodeStateAsUpdate(doc, vector)).toString("base64");
    doc.destroy();
    let notifications = 0;
    db.onCanvasCommit(() => notifications++);
    assert.throws(() => db.applyCanvasProjectOperations("canvas", undefined, [
        { type: "text_update", target, documentId: original.documentId, update },
        { type: "update_node", id: "missing", metadata: { content: "错误" } },
    ], { operationId: "rollback" }));
    assert.equal(db.getCanvasText("canvas", target).state, original.state);
    assert.equal(db.getCanvasProject("canvas")?.revision, 1);
    assert.equal(db.readCanvasChanges("canvas", 1).commits.length, 0);
    assert.equal(notifications, 0);
    assert.equal(db.applyCanvasProjectOperations("canvas", undefined, [{ type: "text_update", target, documentId: original.documentId, update }], { operationId: "rollback" }).revision, 2);
});

test("旧基线修改不同字段可合并，同字段拒绝；布局最后提交生效", (t) => {
    const db = fixture(t);
    db.applyCanvasProjectOperations("canvas", undefined, [{ type: "update_node", id: "text", metadata: { content: "远端正文" } }], { baseRevision: 1 });
    db.applyCanvasProjectOperations("canvas", undefined, [{ type: "update_node", id: "text", patch: { title: "本地标题" } }], { baseRevision: 1 });
    assert.throws(() => db.applyCanvasProjectOperations("canvas", undefined, [{ type: "update_node", id: "text", metadata: { content: "旧正文" } }], { baseRevision: 1 }), { code: "FIELD_CONFLICT" });
    const move = (x: number) => [{ type: "update_node", id: "text", patch: { position: { x, y: 0 } } }];
    db.applyCanvasProjectOperations("canvas", undefined, move(10), { baseRevision: 1 });
    db.applyCanvasProjectOperations("canvas", undefined, move(20), { baseRevision: 1 });
    assert.equal(db.getCanvasProject("canvas")?.revision, 5);
    const history = db.readCanvasChanges("canvas", 1);
    assert.equal(history.reset, false);
    assert.deepEqual(history.commits.map((item) => item.revision), [2, 3, 4, 5]);
    assert.equal(db.readCanvasChanges("canvas", 99).reset, true);
});

test("两名编辑者从相同基线插入中文，两个 Yjs 增量都保留", (t) => {
    const db = fixture(t);
    const target = { nodeId: "text", field: "content" as const };
    const initial = db.getCanvasText("canvas", target);
    const updates = ["丙", "丁"].map((value) => {
        const doc = new Y.Doc();
        Y.applyUpdate(doc, Buffer.from(initial.state, "base64"));
        const vector = Y.encodeStateVector(doc);
        doc.getText("text").insert(1, value);
        const update = Buffer.from(Y.encodeStateAsUpdate(doc, vector)).toString("base64");
        doc.destroy();
        return update;
    });
    updates.forEach((update, index) => db.applyCanvasProjectOperations("canvas", undefined, [{ type: "text_update", target, documentId: initial.documentId, update }], { operationId: `text-${index}`, baseRevision: 1 }));
    const text = db.getCanvasText("canvas", target).text;
    assert.equal(text.length, 4);
    for (const char of "甲乙丙丁") assert.ok(text.includes(char));
    assert.equal(db.readCanvasChanges("canvas", 1).commits.length, 2);
    assert.ok(db.readCanvasChanges("canvas", 1).commits.every((commit) => commit.operations[0].textUpdate));
});

test("指纹与属性枚举顺序无关；字段路径以稳定实体 ID 隔离", () => {
    assert.equal(commandFingerprint({ b: 2, a: 1 }), commandFingerprint({ a: 1, b: 2 }));
    assert.deepEqual(concurrentCommandConflicts(
        [{ type: "update_h3_segment", nodeId: "h3", segmentId: "s1", patch: { prompt: "甲" } }],
        [{ type: "update_h3_segment", nodeId: "h3", segmentId: "s2", patch: { prompt: "乙" } }],
    ), []);
    assert.notDeepEqual(concurrentCommandConflicts(
        [{ type: "update_h3_segment", nodeId: "h3", segmentId: "s1", patch: { prompt: "甲" } }],
        [{ type: "delete_node", id: "h3" }],
    ), []);
});

test("删除后同 ID 重建不能接收旧文档增量，即使删除和重建在同一批", (t) => {
    const db = fixture(t);
    const target = { nodeId: "text", field: "content" as const };
    const old = db.getCanvasText("canvas", target);
    db.applyCanvasProjectOperations("canvas", undefined, [
        { type: "delete_node", id: "text" },
        { type: "add_node", id: "text", nodeType: "text", metadata: { content: "新对象" } },
    ]);
    const current = db.getCanvasText("canvas", target);
    assert.notEqual(old.documentId, current.documentId);
    assert.throws(() => db.applyCanvasProjectOperations("canvas", undefined, [
        { type: "text_update", target, documentId: old.documentId, update: old.state },
    ]), { code: "TEXT_DOCUMENT_REPLACED" });
    assert.equal(db.getCanvasText("canvas", target).text, "新对象");
});

test("服务端条件替换原子检查原文，冲突不留下任何半提交", (t) => {
    const db = fixture(t);
    const target = { nodeId: "text", field: "content" as const };
    const original = db.getCanvasText("canvas", target);
    const replace = { type: "text_replace", target, documentId: original.documentId, expectedText: "甲乙", text: "强化文本" };
    db.applyCanvasProjectOperations("canvas", undefined, [replace], { operationId: "rewrite" });
    const accepted = db.getCanvasText("canvas", target);
    assert.equal(accepted.text, "强化文本");
    assert.equal(accepted.documentId, original.documentId);
    assert.throws(() => db.applyCanvasProjectOperations("canvas", undefined, [
        { type: "update_node", id: "text", patch: { title: "不得保存" } }, replace,
    ]), { code: "TEXT_CONFLICT" });
    assert.equal(db.getCanvasText("canvas", target).state, accepted.state);
    assert.equal(db.getCanvasProject("canvas")?.revision, accepted.revision);
    assert.equal(db.applyCanvasProjectOperations("canvas", undefined, [replace], { operationId: "rewrite" }).duplicated, true);
});

test("批量文本按文本项 ID 编辑，另一人切换主项不改变编辑目标", (t) => {
    const db = fixture(t);
    db.applyCanvasProjectOperations("canvas", undefined, [{ type: "update_node", id: "text", metadata: {
        texts: [{ id: "a", content: "甲" }, { id: "b", content: "乙" }], primaryTextId: "a", content: "甲",
    } }]);
    const target = { nodeId: "text", textItemId: "a", field: "content" as const };
    const initial = db.getCanvasText("canvas", target);
    db.applyCanvasProjectOperations("canvas", undefined, [{ type: "update_node", id: "text", metadata: { primaryTextId: "b", content: "乙" } }]);
    db.applyCanvasProjectOperations("canvas", undefined, [{ type: "text_replace", target, documentId: initial.documentId, expectedText: "甲", text: "甲改" }]);
    const node = (db.getCanvasProject("canvas")!.nodes as Array<{ metadata: Record<string, unknown> }>)[0];
    assert.equal(node.metadata.content, "乙");
    assert.equal(db.getCanvasText("canvas", target).text, "甲改");
    db.applyCanvasProjectOperations("canvas", undefined, [{ type: "update_node", id: "text", metadata: { texts: [{ id: "b", content: "乙" }] } }]);
    db.applyCanvasProjectOperations("canvas", undefined, [{ type: "update_node", id: "text", metadata: { texts: [{ id: "a", content: "重新添加" }, { id: "b", content: "乙" }] } }]);
    assert.notEqual(db.getCanvasText("canvas", target).documentId, initial.documentId);
});

test("智能文字配置节点可编辑生成结果，且不改输入提示词", (t) => {
    const db = fixture(t);
    db.applyCanvasProjectOperations("canvas", undefined, [{ type: "add_node", id: "smart-text", nodeType: "config", metadata: {
        smart: true, generationMode: "text", prompt: "输入提示词", composerContent: "输入提示词",
        content: "原生成结果", texts: [{ id: "result-1", content: "原生成结果", status: "success" }], primaryTextId: "result-1",
    } }]);
    const target = { nodeId: "smart-text", textItemId: "result-1", field: "content" as const };
    const initial = db.getCanvasText("canvas", target);
    db.applyCanvasProjectOperations("canvas", undefined, [{ type: "text_replace", target, documentId: initial.documentId, expectedText: initial.text, text: "人工改过的结果" }]);
    const node = (db.getCanvasProject("canvas")!.nodes as Array<{ id: string; metadata: Record<string, unknown> }>).find((item) => item.id === "smart-text")!;
    assert.equal(node.metadata.content, "人工改过的结果");
    assert.equal((node.metadata.texts as Array<{ content: string }>)[0].content, "人工改过的结果");
    assert.equal(node.metadata.prompt, "输入提示词");
    assert.equal(node.metadata.composerContent, "输入提示词");
    assert.equal(db.getCanvasText("canvas", target).text, "人工改过的结果");

    db.applyCanvasProjectOperations("canvas", undefined, [{ type: "add_node", id: "image-config", nodeType: "config", metadata: { smart: true, generationMode: "image", content: "非文字结果" } }]);
    assert.throws(() => db.getCanvasText("canvas", { nodeId: "image-config", field: "content" }), /不是可协作文本/);
});

test("SVG 扩展节点源码使用协作文本，图片节点仍拒绝正文编辑", (t) => {
    const db = fixture(t);
    const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>';
    db.applyCanvasProjectOperations("canvas", undefined, [{ type: "add_node", id: "vector", nodeType: "svg:vector", metadata: { content: source } }]);
    const target = { nodeId: "vector", field: "content" as const };
    const initial = db.getCanvasText("canvas", target);
    assert.equal(initial.text, source);
    const updated = source.replace("10 10", "20 20");
    db.applyCanvasProjectOperations("canvas", undefined, [{ type: "text_replace", target, documentId: initial.documentId, expectedText: source, text: updated }]);
    assert.equal(db.getCanvasText("canvas", target).text, updated);
    assert.equal((db.getCanvasProject("canvas")!.nodes as Array<{ id: string; metadata: { content: string } }>).find((node) => node.id === "vector")?.metadata.content, updated);
    db.applyCanvasProjectOperations("canvas", undefined, [{ type: "add_node", id: "bitmap", nodeType: "image", metadata: { content: "/media/image" } }]);
    assert.throws(() => db.getCanvasText("canvas", { nodeId: "bitmap", field: "content" }), /不是可协作文本/);
});
