/**
 * 段参考图绑定自动派生的纯函数单测：
 * 顺序/编号/去重、entity→asset 映射、缺 storageKey 跳过、9 张截断、id 稳定、
 * 中文参考图编号对齐与越界剔除。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { stableReferenceId } from "@basketikun/canvas-agent/reference-contract";
import { deriveSegmentReferenceBindings, alignPromptPictures } from "./segment-reference-bindings.js";

const SCENE_A = "ASSET_SCENE_A";
const SCENE_B = "ASSET_SCENE_B";
const CHAR_1 = "ASSET_CHAR_1";
const CHAR_2 = "ASSET_CHAR_2";
const PROP = "ASSET_PROP";

function fixture() {
    const source = {
        asset_plan: [
            { id: SCENE_A, kind: "scene", asset_name: "雪夜街道", entity_id: "ENV_A" },
            { id: SCENE_B, kind: "scene", asset_name: "山神庙", entity_id: "ENV_B" },
            { id: CHAR_1, kind: "character", asset_name: "崇良", entity_id: "CHAR_1" },
            { id: CHAR_2, kind: "character", asset_name: "蟒妻", entity_id: "CHAR_2" },
            { id: PROP, kind: "prop", asset_name: "油纸伞" },
        ],
        // 名字一律不能从 asset_cards.name 取（EP1 实测普遍为 None）。
        asset_cards: [
            { id: SCENE_A, name: null }, { id: SCENE_B, name: null },
            { id: CHAR_1, name: null }, { id: CHAR_2, name: null }, { id: PROP, name: null },
        ],
        character_registry: [{ id: "CHAR_1", name: "崇良" }, { id: "CHAR_2", name: "蟒妻" }],
        scene_registry: [{ id: "ENV_A", name: "雪夜街道" }, { id: "ENV_B", name: "山神庙" }],
        shots: [
            { id: "shot-1", scene_id: "ENV_A", characters: [{ id: "CHAR_1" }] },
            { id: "shot-2", scene_id: "ENV_B", characters: [{ id: "CHAR_2" }, "CHAR_1"] },
        ],
    };
    const director = {
        assets: {
            [SCENE_A]: { storageKey: "image:sceneA" },
            [SCENE_B]: { storageKey: "image:sceneB" },
            [CHAR_1]: { storageKey: "image:char1" },
            [CHAR_2]: { storageKey: "image:char2" },
            [PROP]: { storageKey: "image:prop" },
        },
        shotInputs: {
            "shot-1": { assetIds: [PROP] },
            "shot-2": { assetIds: [PROP] },
        },
    };
    return { source, director };
}

test("按 [场景,角色,道具] 顺序派生：sceneA,sceneB,char1,char2,prop，label/order 编号连续", () => {
    const { source, director } = fixture();
    const derived = deriveSegmentReferenceBindings(source, director, "seg-1", ["shot-1", "shot-2"], source.shots as any);
    assert.deepEqual(derived.bindings.map((b) => b.assetId), [SCENE_A, SCENE_B, CHAR_1, CHAR_2, PROP]);
    assert.deepEqual(derived.bindings.map((b) => b.label), ["<Picture 1>", "<Picture 2>", "<Picture 3>", "<Picture 4>", "<Picture 5>"]);
    assert.deepEqual(derived.bindings.map((b) => b.order), [0, 1, 2, 3, 4]);
    assert.deepEqual(derived.referenceOrder, derived.bindings.map((b) => b.id));
    assert.deepEqual(derived.warnings, []);
});

test("entity→asset 映射取 asset_plan.asset_name，role 按 kind 映射，不读 asset_cards.name", () => {
    const { source, director } = fixture();
    const derived = deriveSegmentReferenceBindings(source, director, "seg-1", ["shot-1", "shot-2"], source.shots as any);
    assert.deepEqual(derived.legend.map((entry) => entry.name), ["雪夜街道", "山神庙", "崇良", "蟒妻", "油纸伞"]);
    assert.deepEqual(derived.legend.map((entry) => entry.role), ["scene", "scene", "character_identity", "character_identity", "prop"]);
    assert.deepEqual(derived.bindings.map((b) => b.role), derived.legend.map((e) => e.role));
    assert.deepEqual(derived.bindings.map((b) => b.storageKey), ["image:sceneA", "image:sceneB", "image:char1", "image:char2", "image:prop"]);
    assert.deepEqual(derived.referencesByShot, { "shot-1": [1, 3, 5], "shot-2": [2, 3, 4, 5] });
});

test("去重：同一 asset 多次出现只绑定一次，编号不跳号", () => {
    const { source, director } = fixture();
    const derived = deriveSegmentReferenceBindings(source, director, "seg-1", ["shot-1", "shot-1", "shot-2"], source.shots as any);
    assert.equal(derived.bindings.length, 5);
    assert.equal(new Set(derived.referenceOrder).size, 5);
});

test("空 registry / 无 storageKey → [] 不抛，并给出跳过告警", () => {
    const empty = deriveSegmentReferenceBindings({}, {}, "seg-empty", ["shot-1"], [{ id: "shot-1", scene_id: "ENV_A" }]);
    assert.deepEqual(empty.bindings, []);
    assert.deepEqual(empty.referenceOrder, []);
    assert.deepEqual(empty.legend, []);

    const { source } = fixture();
    const noMedia = deriveSegmentReferenceBindings(source, { assets: {}, shotInputs: {} }, "seg-no-media", ["shot-1", "shot-2"], source.shots as any);
    assert.deepEqual(noMedia.bindings, []);
    assert.ok(noMedia.warnings.some((warning) => warning.includes("没有 storageKey")));
});

test("镜头级 sceneAssetId 覆盖章节占位 scene_id", () => {
    const { source, director } = fixture();
    const shots = [{ id: "shot-x", scene_id: "CHAPTER_TITLE" }];
    director.shotInputs["shot-x"] = { assetIds: [], sceneAssetId: "ENV_B" };
    const derived = deriveSegmentReferenceBindings(source, director, "seg-x", ["shot-x"], shots as any);
    assert.deepEqual(derived.bindings.map((binding) => binding.assetId), [SCENE_B]);
    assert.deepEqual(derived.warnings, []);
});

test("多场景时章节占位不再回退第一张场景图", () => {
    const { source, director } = fixture();
    const shots = [{ id: "shot-x", scene_id: "CHAPTER_TITLE" }];
    const derived = deriveSegmentReferenceBindings(source, director, "seg-x", ["shot-x"], shots as any);
    assert.deepEqual(derived.bindings, []);
    assert.ok(derived.warnings.some((warning) => warning.includes("已跳过场景参考")));
});

test("超过 9 张参考图截断到 9，编号 1..9 且有告警", () => {
    const ids = Array.from({ length: 11 }, (_, i) => `PROP_${i + 1}`);
    const source = { asset_plan: ids.map((id) => ({ id, kind: "prop", asset_name: `道具${id}` })), shots: [{ id: "shot-1" }] };
    const director = {
        assets: Object.fromEntries(ids.map((id) => [id, { storageKey: `image:${id}` }])),
        shotInputs: { "shot-1": { assetIds: ids } },
    };
    const derived = deriveSegmentReferenceBindings(source, director, "seg-many", ["shot-1"], source.shots as any);
    assert.equal(derived.bindings.length, 9);
    assert.deepEqual(derived.bindings.map((b) => b.order), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(derived.bindings.at(-1)!.label, "<Picture 9>");
    assert.ok(derived.warnings.some((warning) => warning.includes("超过 H3 上限 9 张")));
});

test("binding id 由 stableReferenceId 派生，重复调用完全一致", () => {
    const { source, director } = fixture();
    const first = deriveSegmentReferenceBindings(source, director, "seg-stable", ["shot-1", "shot-2"], source.shots as any);
    const second = deriveSegmentReferenceBindings(structuredClone(source), structuredClone(director), "seg-stable", ["shot-1", "shot-2"], structuredClone(source.shots) as any);
    assert.deepEqual(first.bindings, second.bindings);
    assert.equal(first.bindings[0].id, stableReferenceId("binding", "seg-stable:ASSET_SCENE_A", 0));
});

test("alignPromptPictures：中文参考图编号转 <Picture N>，越界编号剔除并返回告警", () => {
    const ok = alignPromptPictures("开场 参考图1，然后 参考图 2 收尾", 3);
    assert.equal(ok.text, "开场 <Picture 1>，然后 <Picture 2> 收尾");
    assert.deepEqual(ok.warnings, []);

    const bad = alignPromptPictures("参考图1、参考图12 与 @参考图 99", 3);
    assert.equal(bad.text, "<Picture 1>、 与 ");
    assert.equal(bad.warnings.length, 2);
    assert.ok(bad.warnings[0].includes("参考图12"));
    assert.ok(bad.warnings[1].includes("参考图99"));
});


test("去重：不同 asset 但同一 storageKey（场景图重复绑定）只保留一个，编号不重复", () => {
    const { source, director } = fixture();
    // 两个场景资产指向同一张归档图：实网 ep1 段1 的 <图1><图1> 重复，根因是按 assetId 去重漏掉这种情况。
    director.assets[SCENE_B] = { storageKey: "image:sceneA" };
    const derived = deriveSegmentReferenceBindings(source, director, "seg-dup", ["shot-1", "shot-2"], source.shots as any);
    const sceneBindings = derived.bindings.filter((b) => b.role === "scene");
    assert.equal(sceneBindings.length, 1, "同一张场景图只绑定一次");
    const keys = derived.bindings.map((b) => b.storageKey);
    assert.equal(new Set(keys).size, keys.length, "所有绑定的 storageKey 不重复");
    assert.deepEqual(derived.bindings.map((b) => b.label), derived.bindings.map((_, i) => `<Picture ${i + 1}>`), "编号连续不跳号/不重复");
});

test("storageOverride：绑定取共享画布节点真图，不读分集缓存的陈旧 storageKey", () => {
    const { source, director } = fixture();
    // 分集缓存里蟒妻是旧图 image:char2；共享画布节点真图是 image:char2-shared
    const override = new Map<string, string>([[CHAR_2, "image:char2-shared"]]);
    const derived = deriveSegmentReferenceBindings(source, director, "seg-vo", ["shot-2"], source.shots as any, override);
    const charBinding = derived.bindings.find((b) => b.assetId === CHAR_2);
    assert.ok(charBinding, "蟒妻绑定应存在");
    assert.equal(charBinding!.storageKey, "image:char2-shared", "绑定必须取共享节点真图而非缓存旧图");
});
