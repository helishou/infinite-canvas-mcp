import assert from "node:assert/strict";
import test from "node:test";
import { canvasSettingsPosition } from "./canvas-settings-position";

const anchor = (left: number, top: number) => ({ left, right: left + 120, top, bottom: top + 40, width: 120 });

test("inspectors fit a 390px phone at all four corners and remain vertically scrollable", () => {
    for (const placement of ["topLeft", "top", "topRight", "bottomLeft", "bottom", "bottomRight"] as const) {
        for (const position of [anchor(0, 0), anchor(270, 0), anchor(0, 804), anchor(270, 804)]) {
            const layout = canvasSettingsPosition(position, { width: 390, height: 844 }, placement);
            assert.ok(layout.left >= 12);
            assert.ok(layout.left + layout.width <= 378);
            assert.ok(layout.maxHeight > 0);
            if ("top" in layout) assert.ok(layout.top! + layout.maxHeight <= 832);
            if ("bottom" in layout) assert.ok(layout.bottom! + layout.maxHeight <= 832);
        }
    }
});

test("upper placement flips below a trigger near the top instead of creating an offscreen inspector", () => {
    const layout = canvasSettingsPosition(anchor(220, 70), { width: 390, height: 700 }, "topRight");
    assert.equal("top" in layout ? layout.top : undefined, 118);
    assert.equal(layout.maxHeight, 570);
    assert.equal(layout.left, 20);
});

test("preferred placement is retained when there is enough space", () => {
    const layout = canvasSettingsPosition(anchor(500, 520), { width: 1440, height: 900 }, "topLeft");
    assert.equal("bottom" in layout ? layout.bottom : undefined, 388);
    assert.equal(layout.maxHeight, 500);
    assert.equal(layout.left, 500);
});

test("small and short viewports reduce dimensions rather than imposing a minimum panel size", () => {
    const layout = canvasSettingsPosition(anchor(150, 150), { width: 280, height: 300 }, "top");
    assert.equal(layout.width, 256);
    assert.ok(layout.maxHeight < 260);
    assert.ok(layout.left + layout.width <= 268);
});

test("an offscreen canvas anchor still produces an onscreen inspector", () => {
    for (const position of [anchor(-200, -200), anchor(2000, 2000)]) {
        const layout = canvasSettingsPosition(position, { width: 390, height: 700 });
        assert.ok(layout.left >= 12 && layout.left + layout.width <= 378);
        assert.ok(layout.maxHeight > 0 && layout.maxHeight <= 676);
    }
});
