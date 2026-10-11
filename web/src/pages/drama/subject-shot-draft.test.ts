import assert from "node:assert/strict";
import test from "node:test";
import { readShotFormDraft, rebaseShotFormDraft, shotFormChanges, shotDraftChanged, shotDraftSourceChanged, subjectDisplayName, productionWorkbenchValue } from "./subject-shot-draft";

const shot = { id: "S1", title: "Observe", duration_frames: 48, visual: "Look outside.", camera: { framing: "CU", path: "static", lens: 50 }, subject_usages: [], keyframes: [] };

test("camera and duration edits do not resubmit untouched cross-Shot dialogue with an empty delivery", () => {
    const speaking = { ...shot, utterance_refs: [{ utteranceId: "U", role: "speaker", localStartFrame: 0, localEndFrame: 48, textStart: 0, textEnd: 2 }] };
    const source = { utterances: [{ id: "U", speakerSubjectId: "SUB", text: "回来先问蛋", start: { shotId: "S1", localFrame: 0 }, end: { shotId: "S2", localFrame: 48 } }] };
    const { draft } = readShotFormDraft(undefined, speaking, source);
    draft.value.camera.framing = "MCU";
    assert.equal(shotFormChanges(draft).utterances, undefined);
    draft.value.utterances!.push({ utteranceId: "", speakerSubjectId: "SUB", text: "", delivery: "", voiceover: false, localStartFrame: 0, localEndFrame: 12 });
    assert.equal(shotFormChanges(draft).utterances, undefined);
    draft.value.utterances![0].delivery = "轻声";
    assert.equal(shotFormChanges(draft).utterances![0].delivery, "轻声");
});
test("a Shot draft survives a source refresh and locates a conflicting update without dropping camera fields", () => {
    const { draft } = readShotFormDraft(undefined, shot);
    draft.value.visual = "Listen outside.";
    const restored = readShotFormDraft(JSON.stringify(draft), { ...shot, visual: "Someone enters." });
    assert.equal(restored.draft.value.visual, "Listen outside.");
    assert.equal(restored.draft.value.camera.lens, 50);
    assert.equal(shotDraftChanged(restored.draft), true);
    assert.equal(shotDraftSourceChanged(restored.draft, { ...shot, visual: "Someone enters." }), true);
    assert.equal(shotDraftSourceChanged(restored.draft, shot), false);
    assert.equal(readShotFormDraft(JSON.stringify(draft), { ...shot, id: "S2" }).invalid, true);
});
test("Subject names use the registered entity and workbenches consume the Backend wire projection", () => {
    const source = { subject_registry: [{ id: "stable-subject", entityRef: { kind: "character", id: "actor" } }], character_registry: [{ id: "actor", name: "栓子" }] };
    assert.equal(subjectDisplayName(source, "stable-subject"), "栓子");
    assert.deepEqual(productionWorkbenchValue({ workbench: { resolved: true } }, "shot"), { resolved: true });
});
test("malformed persisted fields do not crash the editor and incomplete frame input remains recoverable", () => {
    const { draft } = readShotFormDraft(undefined, shot);
    for (const patch of [{ camera: null }, { subject_usages: [null] }, { keyframes: [null] }, { title: 123 }, { camera: { attention_subject_ids: "actor" } }]) {
        const restored = readShotFormDraft(JSON.stringify({ ...draft, value: { ...draft.value, ...patch } }), shot);
        assert.equal(restored.invalid, true);
        assert.equal(restored.draft.value.visual, shot.visual);
    }
    const restored = readShotFormDraft(JSON.stringify({ ...draft, value: { ...draft.value, duration_frames: 0 } }), shot);
    assert.equal(restored.invalid, false);
    assert.equal(restored.draft.value.duration_frames, 0);
});
test("reviewed source changes retain remote fields and saving emits only the edited fields", () => {
    const { draft } = readShotFormDraft(undefined, shot);
    draft.value.camera.path = "push in";
    const remote = { ...shot, title: "Remote title", camera: { ...shot.camera, lens: 85 } };
    const rebased = rebaseShotFormDraft(draft, remote);
    assert.equal(rebased.value.camera.lens, 85);
    assert.equal(rebased.value.camera.path, "push in");
    assert.equal(rebased.value.title, "Remote title");
    assert.equal(shotDraftSourceChanged(rebased, remote), false);
    assert.deepEqual(shotFormChanges(rebased), { patch: { camera: { ...remote.camera, path: "push in" } } });
});

test("unrelated source updates merge automatically without making Shot editing a conflict", () => {
    const { draft } = readShotFormDraft(undefined, shot);
    draft.value.visual = "听窗内动静。";
    draft.value.camera.path = "缓推";
    const remote = { ...shot, title: "后台更新的名称", camera: { ...shot.camera, lens: 85 } };
    const restored = readShotFormDraft(JSON.stringify(draft), remote);
    assert.equal(shotDraftSourceChanged(restored.draft, remote), false);
    assert.equal(restored.draft.value.visual, "听窗内动静。");
    assert.equal(restored.draft.value.camera.lens, 85);
    assert.equal(restored.draft.value.title, remote.title);
    assert.deepEqual(shotFormChanges(restored.draft).patch, { visual: "听窗内动静。", camera: { ...remote.camera, path: "缓推" } });
});


test("machine Subject editing uses its original prompt_description without making a blank appearance copy", async () => {
    const { subjectDescriptionField } = await import("./subject-shot-draft");
    const row = { name: "铆钉", appearance: "", prompt_description: "钛灰与褪色橙装甲，右臂液压冲锤。" };
    const before = structuredClone(row);
    assert.equal(subjectDescriptionField("character", row), "prompt_description");
    assert.equal(subjectDescriptionField("environment", { prompt_description: "湿钢轨与闸门" }), "prompt_description");
    assert.deepEqual(row, before);
});
