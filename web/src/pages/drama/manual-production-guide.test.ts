import test from "node:test";
import assert from "node:assert/strict";
import { canBindSubjectImage, manualTargetRecovery, manualWorkspaceProgress } from "./manual-production-guide";

test("saved manual content is not blocked by historical director receipt, approval or style notes", () => {
    const source = { script_scenes: [{ id: "scene", text: "已经手写的剧本" }], subject_registry: [{ id: "C" }], shots: [{ id: "shot" }], segments: [{ id: "clip" }], modules: { story: { unresolved: ["缺少 Backend story 验证回执"] }, assets: { unresolved: ["风格母图未批准"] } } };
    assert.equal(manualWorkspaceProgress("story", source, []).status, "saved");
    assert.equal(manualWorkspaceProgress("assets", source, []).summaryKey, "assetsSaved");
    assert.equal(manualWorkspaceProgress("shots", source, []).status, "saved");
    assert.equal(manualWorkspaceProgress("continuity", source, [], "stale").status, "optional");
});
test("current empty Clip prompt provides a direct Shot editor action rather than a director-only action", () => {
    const target = { kind: "segment" as const, targetId: "clip", status: "blocked", blockers: ["提示词为空"] };
    const source = { segments: [{ id: "clip", shot_ids: ["shot"] }] };
    assert.deepEqual(manualTargetRecovery(target, source), { workspace: "shots", kind: "shot", id: "shot", messageKey: "promptMissing", actionKey: "completeShot" });
    assert.equal(manualWorkspaceProgress("production", source, [target]).status, "blocked");
});
test("model, media and timing problems route to existing manual controls", () => {
    const target = { kind: "segment" as const, targetId: "clip", status: "blocked", blockers: [] as string[] };
    const source = { segments: [{ id: "clip", shot_ids: ["shot"] }] };
    const modelRecovery = manualTargetRecovery({ ...target, blockers: ["缺少 H3 模型"] }, source);
    assert.equal(modelRecovery.workspace, "series");
    assert.equal(modelRecovery.seriesView, "planning");
    assert.equal(modelRecovery.seriesTab, "settings");
    assert.equal(manualTargetRecovery({ ...target, kind: "asset", targetId: "character", blockers: ["缺少图片模型"] }, source).seriesTab, "settings");
    assert.equal(manualTargetRecovery({ ...target, blockers: ["参考图片尚未归档"] }, source).messageKey, "referenceMissing");
    assert.equal(manualTargetRecovery({ ...target, blockers: ["帧窗与秒数须一致"] }, source).id, "clip");
});
test("typed material nodes can be bound manually while wrong types, missing nodes and duplicate sources stay unavailable", () => {
    const nodes = ["character", "scene", "prop", "image"].map(type => ({ id: type, type }));
    for (const node of nodes) assert.equal(canBindSubjectImage({ projectId: "canvas", nodeId: node.id }, "canvas", nodes, []), true);
    assert.equal(canBindSubjectImage({ projectId: "canvas", nodeId: "missing" }, "canvas", nodes, []), false);
    assert.equal(canBindSubjectImage({ projectId: "canvas", nodeId: "video" }, "canvas", [{ id: "video", type: "video" }], []), false);
    assert.equal(canBindSubjectImage({ projectId: "canvas", nodeId: "character" }, "canvas", nodes, [{ sourceNode: { projectId: "canvas", nodeId: "character" } }]), false);
});

test("one character node can provide distinct stable media keys without binding the same image twice", () => {
    const node = { id: "character", type: "character", metadata: { characterPrimaryIndex: 0, characterImages: [
        { storageKey: "media:cover" }, { storageKey: "media:outfit" },
    ] } };
    const base = { sourceNode: { projectId: "canvas", nodeId: "character" } };
    const cover = { ...base, selection: { mode: "selected_result", resultId: "character:character-image:media:cover" } };
    assert.equal(canBindSubjectImage({ projectId: "canvas", nodeId: "character" }, "canvas", [node], [cover]), true);
    assert.equal(canBindSubjectImage({ projectId: "canvas", nodeId: "character" }, "canvas", [node], [cover, { ...base, selection: { mode: "selected_result", resultId: "media:outfit" } }]), false);
    assert.equal(canBindSubjectImage({ projectId: "canvas", nodeId: "character" }, "canvas", [node], [{ ...base, selection: { mode: "node_selection" } }]), true);
});
