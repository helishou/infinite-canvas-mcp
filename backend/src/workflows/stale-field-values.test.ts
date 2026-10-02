import assert from "node:assert/strict";
import test from "node:test";

import { migrateStaleFieldValues, applyWorkflowFieldDefaults } from "./executor.js";
import type { WorkflowField } from "../db.js";

/**
 * 回归场景：custom/2.1文生图.json 的 Aspect ratio 字段在 2026-09-29 12:53 被重新保存，
 * 字段 ID 从 f_1790654082341_tzf2 变成 f_1790686390394_nzk9（节点 11 / aspect_ratio 未变）。
 * 画布节点 comfyParams 里仍存旧 ID，导致 buildParams 的 `field.id in values` 落空、
 * 参数被静默丢弃，输出回落到默认值。
 */
const ASPECT_FIELDS: WorkflowField[] = [
    {
        id: "f_1790686390394_nzk9",
        node: "11",
        input: "aspect_ratio",
        name: "Aspect ratio",
        type: "dropdown",
        default: "9:16 (Portrait Widescreen)",
        options: ["1:1 (Square)", "16:9 (Widescreen)", "9:16 (Portrait Widescreen)"],
    },
    {
        id: "f_1790654084191_epoj",
        node: "11",
        input: "megapixels",
        name: "Megapixels",
        type: "number",
        default: 1.5,
    },
];

test("工作流重新保存后旧字段 ID 的值能迁回当前字段", () => {
    const migrated = migrateStaleFieldValues(ASPECT_FIELDS, {
        f_1790654082341_tzf2: "16:9 (Widescreen)",
        f_1790654084191_epoj: 1.5,
    });

    assert.equal(migrated.f_1790686390394_nzk9, "16:9 (Widescreen)");
    assert.equal("f_1790654082341_tzf2" in migrated, false, "旧 ID 应被移除");
    assert.equal(migrated.f_1790654084191_epoj, 1.5, "已知 ID 不受影响");
});

test("迁移必须发生在铺默认值之前，否则默认值会占位导致迁移被跳过", () => {
    const values = { f_1790654082341_tzf2: "16:9 (Widescreen)" };

    // 顺序错误：先铺默认值 → 目标 ID 已被 default 占位 → 迁移被跳过
    const wrong = applyWorkflowFieldDefaults(ASPECT_FIELDS, values);
    assert.equal(wrong.f_1790686390394_nzk9, "9:16 (Portrait Widescreen)", "默认值占位，参数丢失");

    // 正确顺序：先迁移 → 再铺默认值 → 显式值覆盖 default
    const right = applyWorkflowFieldDefaults(ASPECT_FIELDS, migrateStaleFieldValues(ASPECT_FIELDS, values));
    assert.equal(right.f_1790686390394_nzk9, "16:9 (Widescreen)", "显式值应覆盖默认值");
});

test("目标 ID 已有显式值时不覆盖", () => {
    const migrated = migrateStaleFieldValues(ASPECT_FIELDS, {
        f_1790654082341_tzf2: "16:9 (Widescreen)",
        f_1790686390394_nzk9: "1:1 (Square)",
    });

    assert.equal(migrated.f_1790686390394_nzk9, "1:1 (Square)", "用户改过的新字段优先");
    assert.equal("f_1790654082341_tzf2" in migrated, true, "无法安全迁移时保留原值而非丢弃");
});

test("值命中多个候选字段时不迁移（宁可漏迁不误迁）", () => {
    const ambiguous: WorkflowField[] = [
        { id: "a", node: "1", input: "strength", name: "A", type: "number", default: 0.65 },
        { id: "b", node: "2", input: "strength", name: "B", type: "number", default: 0.65 },
    ];
    const migrated = migrateStaleFieldValues(ambiguous, { stale: 0.65 });

    assert.deepEqual(migrated, { stale: 0.65 }, "两个候选 → 不动");
});

test("字段已被删除（值不命中任何字段）时保持孤儿不动", () => {
    const migrated = migrateStaleFieldValues(ASPECT_FIELDS, { f_1790670314692_4bt5: "图生图" });

    assert.deepEqual(migrated, { f_1790670314692_4bt5: "图生图" });
});

test("非工作流键（channelId/size 等）不会被误迁", () => {
    const migrated = migrateStaleFieldValues(ASPECT_FIELDS, {
        channelId: "1:1 (Square)",
        size: "864x1536",
    });

    assert.deepEqual(migrated, { channelId: "1:1 (Square)", size: "864x1536" });
});

test("渠道键即便值恰好命中 dropdown 选项也不迁（回归：曾把 channelId 搬成比例字段）", () => {
    const migrated = migrateStaleFieldValues(ASPECT_FIELDS, { channelId: "16:9 (Widescreen)" });

    assert.deepEqual(migrated, { channelId: "16:9 (Widescreen)" });
    assert.equal("f_1790686390394_nzk9" in migrated, false);
});

test("内置稳定 ID 形式的孤儿不参与迁移（它们不会因重新保存而失效）", () => {
    const fields: WorkflowField[] = [
        { id: "language", node: "30", input: "language", name: "语言", type: "dropdown", default: "ZH", options: ["ZH", "EN"] },
    ];
    const migrated = migrateStaleFieldValues(fields, { lang: "ZH" });

    assert.deepEqual(migrated, { lang: "ZH" });
});

test("没有孤儿键时原样返回同一引用", () => {
    const values = { f_1790686390394_nzk9: "16:9 (Widescreen)" };
    assert.equal(migrateStaleFieldValues(ASPECT_FIELDS, values), values);
});
