import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";

test("an explicit Agent configuration directory isolates configuration and workspace initialization", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-agent-config-"));
    const require = createRequire(import.meta.url);
    try {
        const source = `import { CONFIG_DIR, CONFIG_FILE, loadConfig, ensureSiteWorkspace } from ${JSON.stringify(new URL("./config.ts", import.meta.url).href)};
            const config = loadConfig(true); const workspace = ensureSiteWorkspace(config);
            console.log(JSON.stringify({dir: CONFIG_DIR, file: CONFIG_FILE, workspace: workspace.workspacePath, active: workspace.activeThreadId || null}));`;
        const result = spawnSync(process.execPath, ["--import", pathToFileURL(require.resolve("tsx")).href, "--input-type=module", "-e", source], {
            env: { ...process.env, INFINITE_CANVAS_AGENT_CONFIG_DIR: directory }, encoding: "utf8", windowsHide: true,
        });
        assert.equal(result.status, 0, result.stderr);
        const actual = JSON.parse(result.stdout.trim());
        assert.equal(actual.dir, directory);
        assert.equal(actual.file, path.join(directory, "canvas-agent.json"));
        assert.ok(actual.workspace.startsWith(directory + path.sep));
        assert.equal(actual.active, null);
        assert.ok(fs.existsSync(actual.file));
    } finally {
        if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Invalid cleanup path");
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
