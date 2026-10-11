import assert from "node:assert/strict";
import crypto from "node:crypto";
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
        const codexHome = path.join(directory, "codex-home");
        const runtimeId = `${"a".repeat(40)}-${"b".repeat(16)}`;
        const commit = "a".repeat(40), patchVersion = "b".repeat(16), version = "4.3.9";
        const runtime = path.join(codexHome, "skill-runtimes", "acheng-director", "versions", runtimeId);
        const skillSource = "---\nname: acheng-director\ndescription: Test pinned Acheng skill\n---\nPinned fixture.\n";
        fs.mkdirSync(runtime, { recursive: true });
        fs.writeFileSync(path.join(runtime, "SKILL.md"), skillSource);
        fs.writeFileSync(path.join(runtime, "canvas-engine.json"), JSON.stringify({ runtimeId, commit, patchVersion, version, files: { "SKILL.md": crypto.createHash("sha256").update(skillSource).digest("hex") } }));
        fs.mkdirSync(path.dirname(path.join(codexHome, "skill-runtimes", "acheng-director", "active.json")), { recursive: true });
        fs.writeFileSync(path.join(codexHome, "skill-runtimes", "acheng-director", "active.json"), JSON.stringify({ active: { path: runtime, runtimeId, commit, patchVersion, version } }));
        const source = `import { CONFIG_DIR, CONFIG_FILE, loadConfig, ensureSiteWorkspace } from ${JSON.stringify(new URL("./config.ts", import.meta.url).href)};
            const config = loadConfig(true); const workspace = ensureSiteWorkspace(config);
            console.log(JSON.stringify({dir: CONFIG_DIR, file: CONFIG_FILE, workspace: workspace.workspacePath, active: workspace.activeThreadId || null}));`;
        const result = spawnSync(process.execPath, ["--import", pathToFileURL(require.resolve("tsx")).href, "--input-type=module", "-e", source], {
            env: { ...process.env, CODEX_HOME: codexHome, INFINITE_CANVAS_AGENT_CONFIG_DIR: directory }, encoding: "utf8", windowsHide: true,
        });
        assert.equal(result.status, 0, result.stderr);
        const actual = JSON.parse(result.stdout.trim());
        assert.equal(actual.dir, directory);
        assert.equal(actual.file, path.join(directory, "canvas-agent.json"));
        assert.ok(actual.workspace.startsWith(directory + path.sep));
        assert.equal(actual.active, null);
        assert.ok(fs.existsSync(actual.file));
        assert.equal(fs.readFileSync(path.join(actual.workspace, ".agents", "skills", "acheng-director", "SKILL.md"), "utf8"), skillSource);
        assert.ok(fs.existsSync(path.join(actual.workspace, ".agents", "skills", "canvas-video-production-sop", "SKILL.md")));
    } finally {
        if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Invalid cleanup path");
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
