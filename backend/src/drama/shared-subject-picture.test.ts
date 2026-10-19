import assert from "node:assert/strict";
import test from "node:test";
import { resetStaleSharedIdentityPictureSelections, sharedSubjectPictureMedia } from "./shared-subject-picture.js";
import { sharedAssetClipInputOperations } from "./clip-inputs.js";

test("shared character updates release only stale default identity image pins", () => {
    const source = { sourceProjectId: "shared-canvas", sourceNodeId: "shared-character" };
    const subjects = [{
        id: "SUBJECT",
        kind: "character",
        pictureBindings: [
            { id: "identity", sourceNode: { projectId: "episode-canvas", nodeId: "episode-character" }, selection: { mode: "selected_result", resultId: "image:old" }, defaultFor: ["identity"] },
            { id: "valid-identity", sourceNode: { projectId: "episode-canvas", nodeId: "episode-character" }, selection: { mode: "selected_result", resultId: "image:current" }, defaultFor: ["identity"] },
            { id: "morphology", sourceNode: { projectId: "episode-canvas", nodeId: "episode-character" }, selection: { mode: "selected_result", resultId: "image:old" }, defaultFor: [] },
        ],
    }];
    const project = { id: "episode-canvas", nodes: [{ id: "episode-character", type: "character", metadata: {
        sharedAssetReference: { ...source },
        characterImages: [{ id: "current", storageKey: "image:current", url: "/media/current.png" }],
        characterPrimaryIndex: 0,
    } }] };

    assert.equal(resetStaleSharedIdentityPictureSelections(source, "episode-canvas", subjects, project), true);
    assert.deepEqual(subjects[0].pictureBindings[0].selection, { mode: "node_selection" });
    assert.deepEqual(subjects[0].pictureBindings[1].selection, { mode: "selected_result", resultId: "image:current" });
    assert.deepEqual(subjects[0].pictureBindings[2].selection, { mode: "selected_result", resultId: "image:old" });
});

test("a default identity pin remains untouched when its source is unrelated", () => {
    const subjects = [{
        id: "SUBJECT",
        kind: "character",
        pictureBindings: [{ id: "identity", sourceNode: { projectId: "episode-canvas", nodeId: "episode-character" }, selection: { mode: "selected_result", resultId: "image:old" }, defaultFor: ["identity"] }],
    }];
    const project = { id: "episode-canvas", nodes: [{ id: "episode-character", type: "character", metadata: {
        sharedAssetReference: { sourceProjectId: "another-shared-canvas", sourceNodeId: "another-character" },
        characterImages: [{ id: "current", storageKey: "image:current" }],
    } }] };
    const source = { sourceProjectId: "shared-canvas", sourceNodeId: "shared-character" };

    assert.equal(resetStaleSharedIdentityPictureSelections(source, "episode-canvas", subjects, project), false);
    assert.deepEqual(subjects[0].pictureBindings[0].selection, { mode: "selected_result", resultId: "image:old" });
});

test("one-time shared rebinding forces current primary while later updates preserve a valid explicit choice", () => {
    const source = { sourceProjectId: "shared", sourceNodeId: "character" };
    const subjects = [{ id: "SUB", kind: "character", pictureBindings: [
        { id: "identity", assetId: "identity-asset", sourceNode: { projectId: "episode", nodeId: "episode-character" }, selection: { mode: "selected_result", resultId: "image:other" }, provides: ["identity"], defaultFor: ["identity"] },
        { id: "outfit", assetId: "outfit-asset", sourceNode: { projectId: "episode", nodeId: "episode-character" }, selection: { mode: "selected_result", resultId: "image:other" }, provides: ["clothing"], defaultFor: [] },
    ] }];
    const project = { id: "episode", nodes: [{ id: "episode-character", type: "character", title: "角色", metadata: {
        sharedAssetReference: source, characterPrimaryIndex: 0,
        characterImages: [
            { id: "primary", storageKey: "image:primary", url: "/media/primary.png" },
            { id: "other", storageKey: "image:other", url: "/media/other.png" },
        ],
    } }] };

    const forced = sharedSubjectPictureMedia(source, "episode", subjects, project, true);
    assert.deepEqual(subjects[0].pictureBindings.map((binding: any) => binding.selection), [{ mode: "node_selection" }, { mode: "node_selection" }]);
    assert.deepEqual(forced.map(item => item.storageKey), ["image:primary", "image:primary"]);
    subjects[0].pictureBindings[1].selection = { mode: "selected_result", resultId: "image:other" };
    const later = sharedSubjectPictureMedia(source, "episode", subjects, project);
    assert.deepEqual(later.map(item => item.storageKey), ["image:primary", "image:other"]);
});

test("shared character, scene and prop updates rebase only H3 shared inputs and preserve the prompt and output", () => {
    const sources = [
        { sourceProjectId: "shared", sourceNodeId: "shared-character" },
        { sourceProjectId: "shared", sourceNodeId: "shared-scene" },
        { sourceProjectId: "shared", sourceNodeId: "shared-prop" },
    ];
    const project = { id: "episode", nodes: [
        { id: "episode-character", type: "character", title: "新角色名", metadata: { sharedAssetReference: sources[0], characterImages: [{ id: "new-character", storageKey: "image:new-character", url: "/media/new-character.png" }], characterPrimaryIndex: 0 } },
        { id: "episode-scene", type: "scene", metadata: { sharedAssetReference: sources[1], sceneImage: { storageKey: "image:new-scene", url: "/media/new-scene.png", mimeType: "image/webp" } } },
        { id: "episode-prop", type: "prop", metadata: { sharedAssetReference: sources[2], propImage: { storageKey: "image:new-prop", url: "/media/new-prop.png", mimeType: "image/png" } } },
        { id: "h3", type: "minimax-h3:video", metadata: { segments: [{
            id: "clip", status: "running", runtimeTaskId: "task-active", prompt: "Use <Picture 1>, <Picture 2> and <Picture 3>.", duration: 6,
            referenceBindings: [
                { id: "char-ref", assetId: "char-asset", label: "<Picture 1>", role: "character_identity", mediaType: "image", enabled: true, usage: "reference", subjectId: "legacy-production-entity-id", sourceNodeId: "episode-character", storageKey: "image:old-character" },
                { id: "scene-ref", assetId: "scene-asset", label: "<Picture 2>", role: "scene", mediaType: "image", enabled: true, usage: "reference", subjectId: "SCENE", sourceNodeId: "episode-scene", storageKey: "image:old-scene" },
                { id: "prop-ref", assetId: "prop-asset", label: "<Picture 3>", role: "prop", mediaType: "image", enabled: true, usage: "reference", subjectId: "PROP", sourceNodeId: "episode-prop", storageKey: "image:old-prop" },
            ],
            h3CharacterGroups: { char: { id: "char", characterName: "旧角色名", characterNodeId: "episode-character", subjectId: "CHAR", outfits: [{ id: "outfit", name: "旧身份图", role: "character_identity", enabled: true, storageKey: "image:old-character", pictureBindingId: "PB_CHAR" }] } },
            storyboardShots: [{ id: "shot", duration: 6 }], resultStorageKey: "video:old", productionClipProjection: { fieldHashes: {} },
        }] } },
        { id: "episode-local-image", type: "image", metadata: { storageKey: "image:local" } },
    ] };
    const media = [
        { subjectId: "CHAR", bindingId: "PB_CHAR", assetId: "char-asset", nodeId: "episode-character", resultId: "image:new-character", storageKey: "image:new-character", url: "/media/new-character.png", name: "新角色名", mimeType: "image/png", provides: ["identity"], defaultFor: ["identity"] },
        { subjectId: "SCENE", bindingId: "PB_SCENE", assetId: "scene-asset", nodeId: "episode-scene", resultId: "image:new-scene", storageKey: "image:new-scene", url: "/media/new-scene.png", name: "新场景", mimeType: "image/webp", provides: ["environment"], defaultFor: ["environment"] },
        { subjectId: "PROP", bindingId: "PB_PROP", assetId: "prop-asset", nodeId: "episode-prop", resultId: "image:new-prop", storageKey: "image:new-prop", url: "/media/new-prop.png", name: "新道具", mimeType: "image/png", provides: ["identity"], defaultFor: ["identity"] },
    ];
    const initialSegment = (project.nodes[3].metadata.segments as Array<Record<string, any>>)[0];
    let patch: Record<string, any> = initialSegment;
    let updated = 0;
    for (const source of sources) {
        const operation = sharedAssetClipInputOperations(project, source, media)[0];
        if (!operation) continue;
        updated++;
        patch = (operation as any).patch;
        project.nodes[3].metadata.segments = [patch];
    }
    assert.equal(updated, 3);
    assert.deepEqual(patch.referenceBindings.map((binding: any) => binding.storageKey), ["image:new-character", "image:new-scene", "image:new-prop"]);
    assert.equal(patch.h3CharacterGroups.char.characterName, "新角色名");
    assert.equal(patch.h3CharacterGroups.char.outfits[0].storageKey, "image:new-character");
    assert.equal(patch.prompt, "Use <Picture 1>, <Picture 2> and <Picture 3>.");
    assert.deepEqual(patch.storyboardShots, [{ id: "shot", duration: 6 }]);
    assert.equal(patch.duration, 6);
    assert.equal(patch.status, "running");
    assert.equal(patch.runtimeTaskId, "task-active");
    assert.equal(patch.resultStorageKey, "video:old");
    assert.equal(patch.inputOutdated, true);
    assert.equal(project.nodes[4].metadata.storageKey, "image:local");
});

test("shared H3 character references keep each labeled outfit mapped to its own current source image", () => {
    const source = { sourceProjectId: "shared", sourceNodeId: "shared-character" };
    const pictureBindingId = "picture:SUB:episode:character";
    const project = { id: "episode", nodes: [
        { id: "episode-character", type: "character", title: "红绡", metadata: { sharedAssetReference: source, characterImages: [
            { name: "image.png", outfit: "白衣四试图", storageKey: "image:white", url: "/media/image%3Awhite", mimeType: "image/png" },
            { name: "红绡·第一阶段半蛇初醒", outfit: "裸四视图", storageKey: "image:snake", url: "/media/image%3Asnake", mimeType: "image/png" },
        ] } },
        { id: "h3", type: "minimax-h3:video", metadata: { segments: [{ id: "clip-2", prompt: "Keep both refs", referenceBindings: [
            { id: "white-ref", sourceNodeId: "episode-character", label: "红绡 · 白衣四试图", role: "character_turnaround", groupId: "red", outfitId: "white", storageKey: "image:white", url: "/media/image%3Awhite", pictureBindingId },
            { id: "snake-ref", sourceNodeId: "episode-character", label: "红绡 · 裸四视图", role: "character_identity", groupId: "red", outfitId: "snake", storageKey: "image:white", url: "/media/image%3Awhite", pictureBindingId },
        ], h3CharacterGroups: { red: { characterName: "红绡", characterNodeId: "episode-character", subjectId: "SUB", outfits: [
            { id: "white", name: "白衣四试图", role: "character_turnaround", storageKey: "image:white", pictureBindingId },
            { id: "snake", name: "白衣四试图", role: "character_identity", storageKey: "image:white", pictureBindingId },
        ] } } }, { id: "clip-with-group-only", prompt: "Keep group slots", referenceBindings: [], h3CharacterGroups: { red: { characterName: "红绡", characterNodeId: "episode-character", subjectId: "SUB", outfits: [
            { id: "white", name: "白衣四试图", role: "character_turnaround", storageKey: "image:white", pictureBindingId },
            { id: "snake", name: "白衣四试图", role: "character_identity", storageKey: "image:white", pictureBindingId },
        ] } } }] } },
    ] };
    const operations = sharedAssetClipInputOperations(project, source, [
        { subjectId: "SUB", bindingId: pictureBindingId, assetId: "asset", nodeId: "episode-character", resultId: "image:white", storageKey: "image:white", url: "/media/image%3Awhite", name: "白衣四试图", mimeType: "image/png", provides: ["identity"], defaultFor: ["identity"] },
    ]);
    const segment = (operations.find(operation => (operation as any).patch.id === "clip-2") as any).patch;
    assert.deepEqual(segment.referenceBindings.map((reference: any) => reference.storageKey), ["image:white", "image:snake"]);
    assert.deepEqual(segment.h3CharacterGroups.red.outfits.map((outfit: any) => [outfit.name, outfit.storageKey]), [
        ["白衣四试图", "image:white"], ["裸四视图", "image:snake"],
    ]);
    assert.equal(segment.prompt, "Keep both refs");
    const groupOnly = (operations.find(operation => (operation as any).patch.id === "clip-with-group-only") as any).patch;
    assert.deepEqual(groupOnly.h3CharacterGroups.red.outfits.map((outfit: any) => [outfit.name, outfit.storageKey]), [
        ["白衣四试图", "image:white"], ["裸四视图", "image:snake"],
    ]);
});
