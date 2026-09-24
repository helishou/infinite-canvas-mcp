import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { h3PluginManifest } from "../../../../plugins/canvas/minimax-h3/src/manifest";

test("H3 宿主清单版本一致且完整暴露参考素材 MCP 工具", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../../../../plugins/canvas/minimax-h3/package.json", import.meta.url), "utf8")) as { version: string };
    const pluginManifest = JSON.parse(readFileSync(new URL("../../../../plugins/canvas/minimax-h3/plugin.manifest.json", import.meta.url), "utf8")) as { version: string };
    const ids = h3PluginManifest.mcp.tools.map((tool) => tool.id);

    assert.equal(h3PluginManifest.version, packageJson.version);
    assert.equal(h3PluginManifest.mcp.version, h3PluginManifest.version);
    assert.equal(packageJson.version, h3PluginManifest.version);
    assert.equal(pluginManifest.version, h3PluginManifest.version);
    assert.equal(ids.length, 19);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(ids.slice(-5), [
        "canvas_list_reference_assets",
        "canvas_update_reference_asset",
        "canvas_analyze_reference_asset",
        "h3_set_reference_bindings",
        "canvas_validate_generation",
    ]);
});
