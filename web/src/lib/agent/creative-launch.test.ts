import assert from "node:assert/strict";
import test from "node:test";
import { creativeLaunchPrompt, ACHENG_CANVAS_LANGUAGE_RULE } from "./creative-launch";
test("director launch preserves user text without reintroducing English-only source or bilingual copies", () => {
 const text = "钢铁断潮：24秒、16:9，先设计，不生成媒体。";
 const prompt = creativeLaunchPrompt({ id: "steel-tide-test", mode: "drama", text });
 assert.ok(prompt.endsWith(text));
 assert.equal(prompt.split(ACHENG_CANVAS_LANGUAGE_RULE).length, 2);
 assert.ok(ACHENG_CANVAS_LANGUAGE_RULE.includes("state_description"));
 assert.ok(ACHENG_CANVAS_LANGUAGE_RULE.includes("描述性原字段直接使用中文"));
 assert.ok(!prompt.includes("继续遵循对应 Skill/模型合同要求的英文"));
 assert.ok(!prompt.includes("同时填写中文展示字段"));
});
