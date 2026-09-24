import assert from "node:assert/strict";
import test from "node:test";

import { createH3NodeMetadata, isH3NodeType } from "./node-factory.js";

test("H3 节点别名都使用同一套节点工厂识别", () => {
    for (const type of ["minimax-h3:video", "minimax-h3", "minimax", "smart-minimax", "minimax_legacy"]) {
        assert.equal(isH3NodeType(type), true, type);
    }
    assert.equal(isH3NodeType("video"), false);
});

test("H3 节点工厂把保存的布局写入初始 Clip", () => {
    const metadata = createH3NodeMetadata({
        layout: {
            width: 2890.1,
            height: 2346.8,
            panes: { minimaxPreviewH: 1325, minimaxTimelineH: 555 },
        },
    });
    const segment = metadata.segments[0] as Record<string, unknown>;
    assert.equal(segment.minimaxPreviewH, 1325);
    assert.equal(segment.minimaxTimelineH, 555);
});
