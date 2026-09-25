import assert from "node:assert/strict";
import test from "node:test";

import { stripGeneratedPromptSections } from "./storyboard-prompt";

test("增强提示词前剥离上一轮生成的结构化段落，避免幻觉主体被当作用户事实回喂", () => {
    // 取自真实 Clip10（segment-05a682da…）：没有人物图，增强后 prompt 里却多了一个主体。
    const stored = `subject_definitions:
<Subject 1> is the slender woman in the snow courtyard, visible through her pale hands and her ice-blue-gray thick winter cloak with white fur trim and pale-blue patterned cuff, wearing a warm ivory-white crossed-collar inner skirt, a gray-blue narrow woven belt, and a plain silver hairpin. Her identity is anchored across the snow and study phases; she does not need to be visible in the study phase, only her hand and sleeve.
<Subject 2> is the right hand entering the study frame in <Picture 1>, wearing a red brocade sleeve with pale floral embroidery, serving as a visual reference for the final document reveal.

summary:
[keyframe completion + reference generation] A single continuous five-second video opens on the exterior snow composition of <Picture 2>, continues into the front-facing upright pose in <Picture 3>, then completes on the exact visual state of <Picture 1> with the booklet opened and the scene transitioned to an interior study. <Subject 1> anchors the identity across the snow and study phases, while <Subject 2> remains a visual reference only.

retention_analysis:
<Picture 1> ([Shot 1], [Shot 3]): fully_preserved - preserve the defined storyboard composition role and its target viewpoint, subject placement, and visual state.

detailed_description:
[Shot 1] A continuous five-second shot. <Subject 1> stands in the snow.

overall_soundscape:
Wind, distant.

non_diegetic_music:
None.`;

    const stripped = stripGeneratedPromptSections(stored);

    // 生成产物里的段落名和主体都不该再作为「用户原文」回喂给模型。
    assert.doesNotMatch(stripped, /subject_definitions:/);
    assert.doesNotMatch(stripped, /retention_analysis:/);
    assert.doesNotMatch(stripped, /overall_soundscape:/);
    assert.doesNotMatch(stripped, /non_diegetic_music:/);
    assert.doesNotMatch(stripped, /slender woman/);
    assert.doesNotMatch(stripped, /<Subject 1>/);
    assert.doesNotMatch(stripped, /<Subject 2>/);
});

test("剥离后保留用户自己写的自由文本", () => {
    const stored = `雪院里，沈昭宁握着退婚书的手在发抖。
她要烧掉它，又停住了。

subject_definitions:
<Subject 1> is a hallucinated subject from the previous run.

summary:
previous run summary.`;

    const stripped = stripGeneratedPromptSections(stored);

    assert.match(stripped, /雪院里，沈昭宁握着退婚书的手在发抖。/);
    assert.match(stripped, /她要烧掉它，又停住了。/);
    assert.doesNotMatch(stripped, /hallucinated subject/);
    assert.doesNotMatch(stripped, /previous run summary/);
});

test("第一个生成段落之后的内容全部丢弃：detailed_description 本身也是生成段落", () => {
    const stored = `subject_definitions:
<Subject 1> is x.

detailed_description:
用户的详细描述段落。

summary:
summary 段。`;

    // 契约：从**第一个**生成段落起整段都是模型产物，不保留任何内容。
    assert.equal(stripGeneratedPromptSections(stored), "");
});

test("纯自由文本（无任何生成段落）原样保留", () => {
    const plain = "一个雪夜，三个少年在火堆旁分饼。最小的那个一直没说话。";
    assert.equal(stripGeneratedPromptSections(plain), plain);
});

test("只有生成段落时剥离后为空串", () => {
    assert.equal(stripGeneratedPromptSections("summary:\nonly summary."), "");
});
