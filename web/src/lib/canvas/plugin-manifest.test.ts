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
    assert.deepEqual(ids, [
        "h3_list_models",
        "h3_get_node",
        "h3_get_clip",
        "h3_get_clip_prompt",
        "h3_get_clip_references",
        "h3_get_clip_runtime",
        "h3_run_clip",
        "h3_get_task",
        "h3_cancel_task",
        "h3_update_clip",
        "h3_move_clip",
        "h3_delete_clip",
        "h3_bind_existing_character_groups",
        "h3_write_storyboard_prompt",
        "h3_run_all_clips",
        "canvas_list_reference_assets",
        "canvas_update_reference_asset",
        "canvas_analyze_reference_asset",
        "h3_set_reference_bindings",
        "h3_replace_storyboard_binding",
        "canvas_replace_storyboard_slots",
        "canvas_validate_generation",
    ]);
});
