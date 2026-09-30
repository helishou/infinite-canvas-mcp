import assert from "node:assert/strict";
import test from "node:test";
import { characterReferenceUpdates, resolveCharacterImageKeys } from "./character-image-selection.js";

const image = (key: string) => ({ storageKey: key, url: `/media/${key}` });
const character = (keys = ["image:a", "image:b"], primary = 0) => ({ id: "character", type: "character", metadata: { characterImages: keys.map(image), characterPrimaryIndex: primary } });
const target = (imageKeys: string[]) => ({ id: "target", type: "config", metadata: { characterReferences: { character: { imageKeys, voiceEnabled: false }, other: { imageKeys: ["image:other"] } } } });

test("legacy dangling character selections use the current primary; explicit empty selections remain disabled", () => {
    const source = character();
    assert.deepEqual(resolveCharacterImageKeys(source.metadata, { imageKeys: ["image:deleted"] }), ["image:a"]);
    assert.deepEqual(resolveCharacterImageKeys(source.metadata, { imageKeys: ["image:deleted", "image:b"] }), ["image:a", "image:b"]);
    assert.deepEqual(resolveCharacterImageKeys(source.metadata, { imageKeys: [] }), []);
});

test("primary changes refresh downstream primary selections, preserving valid outfit choices and other characters", () => {
    const source = character();
    const next = character(undefined, 1);
    const primary = target(["image:a"]);
    const outfit = { ...target(["image:b"]), id: "outfit" };
    const disabled = { ...target([]), id: "disabled" };
    const updates = characterReferenceUpdates(source, next, [primary, outfit, disabled]);
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0].metadata.characterReferences.character, { imageKeys: ["image:b"], voiceEnabled: false });
    assert.deepEqual(updates[0].metadata.characterReferences.other, primary.metadata.characterReferences.other);
    assert.deepEqual(primary.metadata.characterReferences.character.imageKeys, ["image:a"]);
});

test("same-length image replacements refresh lost media and remain stable when reapplied", () => {
    const before = character();
    const after = character(["image:new", "image:b"]);
    const original = target(["image:a", "image:deleted"]);
    const updates = characterReferenceUpdates(before, after, [original]);
    assert.deepEqual(updates[0].metadata.characterReferences.character.imageKeys, ["image:new"]);
    assert.deepEqual(characterReferenceUpdates(before, after, [{ ...original, metadata: updates[0].metadata }]), []);
    assert.deepEqual(characterReferenceUpdates(after, after, [original]), []);
});
