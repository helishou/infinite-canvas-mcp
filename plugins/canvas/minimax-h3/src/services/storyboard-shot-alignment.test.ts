import test from "node:test";
import assert from "node:assert/strict";
import type { H3Ref } from "../types";
import { alignStoryboardShotsToReferences } from "./storyboard-shot-alignment";

const pictures = (count: number): H3Ref[] => Array.from({ length: count }, (_, index) => ({
    bindingId: `picture-${index + 1}`, type: "image", role: "storyboard", name: `分镜图 ${index + 1}`, url: `/image-${index + 1}.png`,
}));
const shots = () => [{ id: "shot-1", description: "第一镜", pictureBindingId: undefined as string | undefined }, { id: "shot-2", description: "第二镜", pictureBindingId: undefined as string | undefined }];

test("两段提示词配四张分镜图时保留两镜且不自动绑定", () => {
    const result = alignStoryboardShotsToReferences(shots(), pictures(4));
    assert.deepEqual(result.shots.map((shot) => [shot.id, shot.pictureBindingId]), [["shot-1", undefined], ["shot-2", undefined]]);
    assert.equal(result.changed, false);
});

test("图数不匹配时保留提示词中明确指定的绑定，清除失效或重复绑定", () => {
    const input = [
        { id: "shot-1", pictureBindingId: "picture-2" },
        { id: "shot-2", pictureBindingId: "picture-2" },
    ];
    const result = alignStoryboardShotsToReferences(input, pictures(4));
    assert.deepEqual(result.shots.map((shot) => shot.pictureBindingId), ["picture-2", undefined]);
    assert.equal(result.changed, true);
});

test("镜头与分镜图等量时，空镜头才按引用顺序自动绑定且不改变镜头顺序", () => {
    const result = alignStoryboardShotsToReferences([
        { id: "shot-1", pictureBindingId: "picture-2" },
        { id: "shot-2", pictureBindingId: undefined },
    ], pictures(2));
    assert.deepEqual(result.shots.map((shot) => [shot.id, shot.pictureBindingId]), [["shot-1", "picture-2"], ["shot-2", "picture-1"]]);
});

test("已禁用的分镜图不参与自动绑定", () => {
    const refs = pictures(3);
    refs[2].enabled = false;
    const result = alignStoryboardShotsToReferences(shots(), refs);
    assert.deepEqual(result.shots.map((shot) => shot.pictureBindingId), ["picture-1", "picture-2"]);
});
