import test from "node:test";
import assert from "node:assert/strict";

import { readH3PromptSection } from "../../../../../canvas-agent/src/plugins/minimax-h3/prompt-sections";
import { storyboardShotLabelMarkers, storyboardShotMarkers } from "./h3-storyboard-markers";

test("复合分镜提示词只把 detailed_description 行首的十二个标签当作分镜", () => {
    const prompt = [
        "subject_definitions:",
        "Panel 1 corresponds to [Shot 1]; Panel 2 corresponds to [Shot 2].",
        "retention_analysis:",
        "<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved.",
        "detailed_description:",
        "The twelve shots share one composite storyboard image.",
        ...Array.from({ length: 12 }, (_, index) => `[Shot ${index + 1}]${index ? ` At 00:${String(index).padStart(2, "0")}.000,` : ""} Description ${index + 1}.${index < 8 ? ` In the composite storyboard image, this is Panel ${index + 1}, shared by [Shot ${index + 1}].` : ""}`),
        "overall_soundscape:",
        "A hard metallic ring in [Shot 2], then wind in [Shot 12].",
    ].join("\n");
    const description = readH3PromptSection(prompt, "detailed_description");
    const markers = storyboardShotMarkers(description);
    assert.deepEqual(markers.map((marker) => Number(marker[1])), Array.from({ length: 12 }, (_, index) => index + 1));
    assert.equal(storyboardShotLabelMarkers(description).length, 12);
    assert.equal(markers[1][2], "00:01.000");
    assert.match(description.slice(markers[0].index!, markers[1].index!), /shared by \[Shot 1\]/);
});

test("缩进的行首标签仍可识别，句中引用不新建分镜", () => {
    const markers = storyboardShotMarkers("  [Shot 1] Description shared by [Shot 1].\n\t[Shot 2] Next shot.");
    assert.deepEqual(markers.map((marker) => marker[1]), ["1", "2"]);
});
