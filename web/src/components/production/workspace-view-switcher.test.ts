import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { WORKSPACE_VIEW_MODES, shouldSwitchWorkspace } from "./workspace-view-switcher-model";

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

function localeBlock(relative: string): string {
    const source = read(relative);
    const start = source.indexOf("    workspaceViewSwitcher: {");
    const end = source.indexOf("    creativePad: {", start);
    assert.ok(start >= 0 && end > start, `${relative} must declare workspaceViewSwitcher before creativePad`);
    return source.slice(start, end);
}

test("clicking the current view is a no-op, switching views is not", () => {
    assert.equal(shouldSwitchWorkspace("canvas", "canvas"), false);
    assert.equal(shouldSwitchWorkspace("production", "production"), false);
    assert.equal(shouldSwitchWorkspace("canvas", "production"), true);
    assert.equal(shouldSwitchWorkspace("production", "canvas"), true);
    assert.deepEqual([...WORKSPACE_VIEW_MODES], ["production", "canvas"]);
});

test("the switcher is the single production/canvas entry point", () => {
    const production = read("../../pages/drama/production.tsx");
    assert.equal((production.match(/<WorkspaceViewSwitcher\b/g) || []).length, 1, "exactly one switcher on the production desk");
    assert.match(production, /onSelect=\{next => \{ if \(next === "canvas"\) void openWorkspaceCanvas\(\); else canvasHost\?\.collapse\?\.\(\); \}\}/);
    assert.ok(!production.includes("icon={<ExternalLink"), "old title-bar open-canvas button must be gone");
    assert.ok(!production.includes('"director.canvasOverlay.expand"'), "old expand label must be gone");

    const workbench = read("../../pages/drama/workbench-canvas.tsx");
    assert.ok(!workbench.includes("PanelBottomClose"), "old overlay close button must be gone");
    assert.ok(!workbench.includes('"director.canvasOverlay.collapse"'), "old collapse label must be gone");
    assert.match(workbench, /hasCanvas: Boolean\(target\), collapse \}\}/, "collapse must be exposed through the workbench context");
});

test("switcher stays above the canvas overlay and exposes accessible pressed state", () => {
    const host = read("../../lib/canvas/canvas-host.tsx");
    assert.match(host, /collapse\?: \(\) => void/, "context type must expose optional collapse");
    const component = read("./workspace-view-switcher.tsx");
    assert.match(component, /createPortal\(content, document\.body\)/);
    assert.match(component, /z-\[950\]/);
    assert.match(component, /aria-pressed=\{active\}/);
    assert.match(component, /placement="bottom"/);
    assert.match(component, /data-testid=\{`workspace-view-\$\{value\}`\}/);
    assert.match(component, /shouldSwitchWorkspace\(mode, value\)/);
});

test("zh-CN and en-US ship the same workspaceViewSwitcher keys", () => {
    const keys = (block: string) => [...block.matchAll(/^\s{8}([A-Za-z][A-Za-z0-9]*):/gm)].map(match => match[1]).sort();
    const zh = keys(localeBlock("../../i18n/locales/zh-CN.ts"));
    const en = keys(localeBlock("../../i18n/locales/en-US.ts"));
    assert.deepEqual(en, zh);
    for (const required of ["group", "canvas", "production", "switchToCanvas", "switchToProduction", "currentCanvas", "currentProduction"]) {
        assert.ok(zh.includes(required), `missing key ${required}`);
    }
});
