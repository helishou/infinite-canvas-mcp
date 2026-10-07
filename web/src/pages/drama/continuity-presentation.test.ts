import assert from "node:assert/strict";
import test from "node:test";
import { continuityPresentation } from "./continuity-presentation";

const input = {
    facts: [{ id: "F_GRIP", object_kind: "character", object_id: "C_CUI", display_name: "抓握状态", allowed_values: ["not holding", "holding the child's arm"], display_values: { "not holding": "尚未抓住手臂", "holding the child's arm": "抓住顺子的手臂" } }, { id: "F_DAY", object_kind: "scene", object_id: "ENV_YARD", allowed_values: ["first day", "second day"], display_values: ["第一天", "第二天"] }],
    characters: [{ id: "C_CUI", name: "翠子" }], locations: [{ id: "ENV_YARD", name: "院子" }],
    scenes: [{ id: "script-scene", scene_id: "SC02", scene_name: "第二场 · 修复顺序" }],
    assets: [], timelines: [{ id: "SC02_REPAIR", description: "第二场修复顺序时间线" }],
    shots: [{ id: "S01", title: "翠子伸手" }], segments: [{ id: "SEG01", shot_ids: ["S01"] }],
    sourceBlocks: [{ id: "B01", sceneId: "SC02", sourceBlock: { text: "翠子抓住顺子的手臂。" } }],
};
const display = continuityPresentation(input, (key, values) => `${key}${values?.count || ""}`);

test("Chinese display names and values resolve canonical identities without mutating the source", () => {
    const before = structuredClone(input);
    assert.equal(display.object("character", "C_CUI"), "翠子");
    assert.equal(display.object("scene", "ENV_YARD"), "院子");
    assert.equal(display.fact("F_GRIP"), "翠子 · 抓握状态");
    assert.equal(display.value("F_GRIP", "holding the child's arm"), "抓住顺子的手臂");
    assert.equal(display.value("F_DAY", "second day"), "第二天");
    assert.equal(display.timeline("SC02_REPAIR"), "第二场修复顺序时间线");
    assert.equal(display.target("SEG01"), "翠子伸手");
    assert.equal(display.source("B01"), "第二场 · 修复顺序 · 翠子抓住顺子的手臂。");
    assert.deepEqual(input, before);
});

test("missing labels retain original state text and explicit unknown states rather than inventing a translation", () => {
    assert.equal(display.value("F_GRIP", "new English state"), "new English state");
    assert.equal(display.value("F_GRIP", "unknown"), "stateUnknown");
    assert.equal(display.value("F_GRIP", undefined), "stateUnknown");
    assert.equal(display.fact("F_DAY"), "院子 · factNumber2");
    assert.equal(display.target("MISSING_SHOT"), "missingTarget");
    assert.equal(display.source("MISSING_BLOCK"), "missingSource");
});

test("diagnostic state maps and choices are readable without JSON serialization", () => {
    assert.equal(display.expected("", { F_GRIP: "not holding", F_DAY: "second day" }), "翠子 · 抓握状态：尚未抓住手臂；院子 · factNumber2：第二天");
    assert.equal(display.expected("F_GRIP", ["not holding", "holding the child's arm"]), "尚未抓住手臂；抓住顺子的手臂");
    assert.equal(display.expected("", { frame: 24 }), "24");
});

test("diagnostic identifiers resolve at token boundaries while the complete raw diagnostic stays available", () => {
    assert.equal(display.message("F_GRIP 在 S01 与 SEG01 之间不一致。"), "翠子 · 抓握状态 在 翠子伸手 与 翠子伸手 之间不一致。");
    assert.equal(display.message("F_GRIP_EXTRA S010"), "F_GRIP_EXTRA S010");
});
