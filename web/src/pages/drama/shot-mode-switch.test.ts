import assert from "node:assert/strict";
import test from "node:test";
import { readShotFormDraft, shotFormChanges } from "./subject-shot-draft";

const shot = {
    id: "S1", title: "对峙", duration_frames: 48,
    visual: "他从伏姿抬起上身，三步穿过人缝，到慕璃面前停住。",
    camera: { framing: "MS", path: "static", lens_mm: 65 }, subject_usages: [], keyframes: [],
};

test("文戏/武戏来回切换不碰画面正文", () => {
    const { draft } = readShotFormDraft(undefined, shot);
    // 切到武戏：只改 features.combat
    const toCombat = { ...draft, value: { ...draft.value, features: { ...(draft.value.features || {}), combat: true } } };
    const combatPatch = shotFormChanges(toCombat);
    // 回归点：切模式不得把画面正文写进 patch（之前会导致正文被清空）
    assert.equal("visual" in combatPatch, false);
    assert.equal(toCombat.value.visual, shot.visual);
    // 切回文戏：写回原 features，但仍不提交 visual
    const back = { ...toCombat, value: { ...toCombat.value, features: { ...(toCombat.value.features || {}), combat: false } } };
    assert.equal(shotFormChanges(back).visual, undefined);
    assert.equal(back.value.visual, shot.visual);
});

test("切回文戏不清空已写的武戏契约", () => {
    const { draft } = readShotFormDraft(undefined, { ...shot, keyframes: [], features: { combat: true }, combat: { contact: "剑刃压在鞭梢上" } });
    const back = { ...draft, value: { ...draft.value, features: { combat: false } } };
    assert.deepEqual(back.value.combat, { contact: "剑刃压在鞭梢上" });
    // base 里也有，所以 patch 不含 combat：切模式不会把载荷写成 null
    assert.equal(shotFormChanges(back).combat, undefined);
});
