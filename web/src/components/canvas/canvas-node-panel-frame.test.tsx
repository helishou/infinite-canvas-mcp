import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { canvasNodePanelLayout, CanvasNodePanelFrame, shouldShowCanvasNodePanel, syncCanvasZoom } from "./canvas-node-panel-frame";

test("smart generation panel renders its controls below the node at screen size", () => {
    const markup = renderToStaticMarkup(
        createElement(
            CanvasNodePanelFrame,
            { isSmartGenerationNode: true, children: createElement("section", { "aria-label": "references-prompt-model-generate" }) },
        ),
    );

    assert.match(markup, /data-canvas-node-panel-kind="smart-generation"/);
    assert.match(markup, /absolute left-1\/2 top-full/);
    assert.match(markup, /margin-left:-180px/);
    assert.match(markup, /scale\(calc\(1 \/ var\(--canvas-zoom, 1\)\)\)/);
    assert.match(markup, /transform-origin:top center/);
    assert.match(markup, /aria-label="references-prompt-model-generate"/);
});

test("other node panels keep their existing canvas-scaled placement", () => {
    const markup = renderToStaticMarkup(
        createElement(CanvasNodePanelFrame, { isSmartGenerationNode: false, children: createElement("span", null, "panel") }),
    );

    assert.match(markup, /data-canvas-node-panel-kind="node"/);
    assert.match(markup, /-translate-x-1\/2/);
    assert.doesNotMatch(markup, /scale\(/);
});

test("viewport zoom updates the compensation value consumed by the panel frame", () => {
    const values: Array<[string, string]> = [];
    const element = { style: { setProperty: (name: string, value: string) => values.push([name, value]) } } as unknown as HTMLElement;

    syncCanvasZoom(element, 1);
    syncCanvasZoom(element, 0.2);

    assert.deepEqual(values, [["--canvas-zoom", "1"], ["--canvas-zoom", "0.2"]]);
});

test("smart panel stays below the node when possible and scrolls within viewport bounds", () => {
    const layout = canvasNodePanelLayout(
        { x: 400, y: 200 },
        { left: 100, top: 200, right: 700, bottom: 600, width: 600, height: 500 },
        { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 },
    );

    assert.deepEqual(layout, { width: 360, maxHeight: 388, shiftX: 0, shiftY: 0 });
});

test("smart panel clamps to narrow edges and moves above the node only when below space is insufficient", () => {
    const layout = canvasNodePanelLayout(
        { x: 10, y: 660, top: 560 },
        { left: -290, top: 660, right: 310, bottom: 1160, width: 600, height: 500 },
        { left: 0, top: 0, right: 360, bottom: 700, width: 360, height: 700 },
    );

    // 上方翻转载：面板底边贴节点顶边（560 - 8 间距），高度 min(500, 540) = 500，top = 52。
    assert.deepEqual(layout, { width: 336, maxHeight: 500, shiftX: 170, shiftY: -608 });
});

test("panel flipped above never covers the node body", () => {
    // 节点顶 400、底 590，视口 800x600：下方仅 0 可用，必须翻到节点上方且不与节点重叠。
    const anchor = { x: 400, y: 590, top: 400 };
    const layout = canvasNodePanelLayout(
        anchor,
        { left: 220, top: 590, right: 580, bottom: 990, width: 360, height: 400 },
        { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 },
    );
    const panelTop = anchor.y + layout.shiftY;
    const panelBottom = panelTop + layout.maxHeight;

    assert.ok(panelBottom <= anchor.top, `panel bottom ${panelBottom} must stay above node top ${anchor.top}`);
    assert.ok(layout.maxHeight > 0, "panel must remain visible");
});

test("only the active node keeps its panel across repeated selection and node switches", () => {
    const visible = (activeNodeId: string | null, nodeId: string) => shouldShowCanvasNodePanel({
        activeNodeId, nodeId, isNodeResizing: false, hasSelectionBox: false, hidden: false,
    });

    assert.deepEqual([
        visible("smart-a", "smart-a"),
        visible("smart-a", "smart-a"),
        visible("smart-b", "smart-a"),
        visible("smart-b", "smart-b"),
        visible(null, "smart-b"),
        visible("smart-a", "smart-a"),
    ], [true, true, false, true, false, true]);
});
