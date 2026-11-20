import assert from "node:assert/strict";
import test from "node:test";
import { characterReferenceUpdates, matchChapterLookIndex, resolveCharacterImageKeys, selectChapterLookIndex, syncH3CharacterGroupSource } from "./character-image-selection.js";

const image = (key: string) => ({ storageKey: key, url: `/media/${key}` });
const character = (keys = ["image:a", "image:b"], primary = 0) => ({ id: "character", type: "character", metadata: { characterImages: keys.map(image), characterPrimaryIndex: primary } });
const target = (imageKeys: string[]) => ({ id: "target", type: "config", metadata: { characterReferences: { character: { imageKeys, voiceEnabled: false }, other: { imageKeys: ["image:other"] } } } });

test("legacy dangling character selections use the current primary; explicit empty selections remain disabled", () => {
    const source = character();
    assert.deepEqual(resolveCharacterImageKeys(source.metadata, { imageKeys: ["image:deleted"] }), ["image:a"]);
    assert.deepEqual(resolveCharacterImageKeys(source.metadata, { imageKeys: ["image:deleted", "image:b"] }), ["image:a", "image:b"]);
    assert.deepEqual(resolveCharacterImageKeys(source.metadata, { imageKeys: [] }), []);
});

test("primary changes keep explicit character media keys and other characters unchanged", () => {
    const source = character();
    const next = character(undefined, 1);
    const primary = target(["image:a"]);
    const outfit = { ...target(["image:b"]), id: "outfit" };
    const disabled = { ...target([]), id: "disabled" };
    const updates = characterReferenceUpdates(source, next, [primary, outfit, disabled]);
    assert.deepEqual(updates, []);
    assert.deepEqual(primary.metadata.characterReferences.character.imageKeys, ["image:a"]);
    assert.deepEqual(outfit.metadata.characterReferences.character.imageKeys, ["image:b"]);
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

test("H3 selected costume follows an in-place image replacement while reordering keeps media identity", () => {
    const group = {
        id: "group", characterName: "苏青璃", characterNodeId: "character", outfitEnabled: true, voiceEnabled: true,
        voice: { url: "/voice.mp3", name: "声线" },
        outfits: [
            { id: "outfit-a", storageKey: "image:a", url: "/a.png", name: "形象", enabled: true },
            { id: "outfit-b", storageKey: "image:b", url: "/b.png", name: "常服", enabled: false },
            { id: "outfit-c", storageKey: "image:c", url: "/c.png", name: "斗篷", enabled: false },
        ],
    };
    const source = { characterName: "苏青璃", characterNodeId: "character", voice: group.voice, outfits: [
        { storageKey: "image:new", url: "/new.png", name: "新形象" },
        { storageKey: "image:b", url: "/b.png", name: "常服" },
        { storageKey: "image:c", url: "/c.png", name: "斗篷" },
    ] };
    const replaced = syncH3CharacterGroupSource(group, source)!;
    assert.deepEqual(replaced.outfits.map((outfit) => [outfit.id, outfit.storageKey, outfit.enabled]), [
        ["outfit-a", "image:new", true], ["outfit-b", "image:b", false], ["outfit-c", "image:c", false],
    ]);
    assert.equal(replaced.voiceEnabled, true);
    assert.equal(syncH3CharacterGroupSource(replaced, source), replaced);
    const reordered = syncH3CharacterGroupSource(replaced, { ...source, outfits: [source.outfits[2], source.outfits[0], source.outfits[1]] })!;
    assert.deepEqual(reordered.outfits.map((outfit) => [outfit.id, outfit.enabled]), [
        ["outfit-c", false], ["outfit-a", true], ["outfit-b", false],
    ]);
});

test("H3 added costumes stay off; deleting the only selected costume recovers the current primary", () => {
    const group = {
        characterName: "苏青璃", characterNodeId: "character", outfitEnabled: true, voiceEnabled: false,
        outfits: [{ id: "outfit-a", storageKey: "image:a", url: "/a.png", name: "旧形象", enabled: true }],
    };
    const added = syncH3CharacterGroupSource(group, { characterName: "苏青璃", characterNodeId: "character", outfits: [
        { storageKey: "image:a", url: "/a.png", name: "旧形象" },
        { storageKey: "image:b", url: "/b.png", name: "新服装" },
    ] })!;
    assert.deepEqual(added.outfits.map((outfit) => outfit.enabled), [true, false]);
    const deleted = syncH3CharacterGroupSource(added, { characterName: "苏青璃", characterNodeId: "character", characterPrimaryIndex: 0, outfits: [
        { storageKey: "image:b", url: "/b.png", name: "新服装" },
    ] })!;
    assert.deepEqual(deleted.outfits.map((outfit) => [outfit.storageKey, outfit.enabled]), [["image:b", true]]);
});

// 造型章节范围选图：与影策 production.DefaultLook 同口径（含其单测用例）。
test("chapter look picks the range containing the episode's first chapter; latest start and narrower range win", () => {
    const looks = [
        { name: "散修", fromChapter: 1, toChapter: 10 },
        { name: "外门", fromChapter: 11, toChapter: 20 },
        { name: "内门", fromChapter: 21, toChapter: 0 },
        { name: "伪装", fromChapter: 0, toChapter: 0 },
    ];
    assert.equal(selectChapterLookIndex(looks, [5, 6], 0), 0);
    assert.equal(selectChapterLookIndex(looks, [12], 0), 1);
    assert.equal(selectChapterLookIndex(looks, [30], 0), 2);
    assert.equal(selectChapterLookIndex(looks, [25, 21], 0), 2, "chapter order must not matter; the smallest chapter decides");
    assert.equal(selectChapterLookIndex(looks, [], 1), 1, "no chapters -> primaryIndex");
    assert.equal(selectChapterLookIndex(looks, [0, -3], 3), 3, "non-positive chapters -> primaryIndex");
    const overlap = [{ name: "宽", fromChapter: 1, toChapter: 50 }, { name: "窄", fromChapter: 1, toChapter: 5 }];
    assert.equal(selectChapterLookIndex(overlap, [3], 0), 1, "same start -> narrower range");
});

test("chapter look honours open ends and falls back to primary when nothing matches", () => {
    const looks = [
        { name: "前段", fromChapter: 0, toChapter: 10 },
        { name: "后段", fromChapter: 11, toChapter: 0 },
        { name: "无章节", fromChapter: 0, toChapter: 0 },
    ];
    assert.equal(selectChapterLookIndex(looks, [8], 2), 0, "To=10 limits the upper end");
    assert.equal(selectChapterLookIndex(looks, [40], 0), 1, "To=0 is open-ended");
    assert.equal(selectChapterLookIndex(looks, [1, 100], 2), 0, "smallest chapter decides across open ranges");
    const none = [{ name: "中段", fromChapter: 5, toChapter: 6 }];
    assert.equal(selectChapterLookIndex(none, [3], 0), 0, "no match -> primaryIndex");
    assert.equal(selectChapterLookIndex(none, [5], 9), 0, "primaryIndex is clamped to catalog length");
    assert.equal(matchChapterLookIndex(none, [3]), -1, "no match is reported as -1 so callers keep the compiled image");
    assert.equal(matchChapterLookIndex(looks, [30]), 1, "open-ended look matches the first chapter");
});
