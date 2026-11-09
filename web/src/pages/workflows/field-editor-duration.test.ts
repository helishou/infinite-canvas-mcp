import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { FieldEditor } from "./field-editor.js";
import type { WorkflowField } from "@/types/workflow";

type Props = Parameters<typeof FieldEditor>[0];
const field: WorkflowField = { id: "duration", node: "132", input: "value", name: "时长", type: "number" };

function render(patch: Partial<Props> = {}): string {
    const base: Props = {
        field, rawValue: 8, showRunningHub: false,
        onUpdate: () => {}, onRemove: () => {},
    };
    return renderToString(createElement(FieldEditor, { ...base, ...patch }));
}

test("节点字段浮窗里「作为时长」与「作为提示词」并列可见", () => {
    const html = render({ onDurationTargetChange: () => {} });
    assert.match(html, /作为时长/);
    assert.match(html, /type="checkbox"/);
    assert.ok(!html.includes('checked=""'), "未配置时不能默认勾上");
});

test("已设为时长目标时显示勾选态与单位切换", () => {
    const html = render({
        onDurationTargetChange: () => {},
        durationTarget: { nodeId: "132", input: "value", unit: "seconds" },
    });
    assert.match(html, /checked=""/);
    assert.match(html, /单位/);
    assert.match(html, /秒（直接写秒数）/);
    assert.match(html, /帧（17n\+5 @24fps）/);
});

test("RunningHub 字段与多节点字段不显示这个选项", () => {
    assert.doesNotMatch(render({ showRunningHub: true, onDurationTargetChange: () => {} }), /作为时长/);
    assert.doesNotMatch(render({ field: { ...field, node: "152,156" }, onDurationTargetChange: () => {} }), /作为时长/);
});

test("没接保存回调时不显示无效果的勾选框", () => {
    assert.doesNotMatch(render(), /作为时长/);
});
