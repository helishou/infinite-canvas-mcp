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
        { x: 10, y: 660 },
        { left: -290, top: 660, right: 310, bottom: 1160, width: 600, height: 500 },
        { left: 0, top: 0, right: 360, bottom: 700, width: 360, height: 700 },
    );

    assert.deepEqual(layout, { width: 336, maxHeight: 500, shiftX: 170, shiftY: -500 });
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
