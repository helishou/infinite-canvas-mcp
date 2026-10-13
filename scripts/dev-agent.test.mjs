import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import childProcess from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

test("Agent launcher supports both platforms, sets only its port, and preserves host Node options", async () => {
    const originalSpawn = childProcess.spawn;
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    const originalOptions = process.env.NODE_OPTIONS;
    try {
        process.env.NODE_OPTIONS = "--require host-guard.cjs --max-old-space-size=4096";
        for (const platform of ["win32", "linux"]) {
            Object.defineProperty(process, "platform", { ...originalPlatform, value: platform });
            let launch;
            childProcess.spawn = (command, args, options) => {
                launch = { command, args, options };
                const child = new EventEmitter();
                queueMicrotask(() => child.emit("exit", 0));
                return child;
            };
            syncBuiltinESMExports();
            await import(`./dev-agent.mjs?test-platform=${platform}`);
            const agent = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "canvas-agent");
            const tsx = pathToFileURL(createRequire(path.join(agent, "package.json")).resolve("tsx")).href;
            assert.equal(launch.command, process.execPath);
            assert.deepEqual(launch.args, ["--import", tsx, "src/index.ts"]);
            assert.equal(launch.options.cwd, agent);
            assert.equal(launch.options.shell, undefined);
            assert.equal(launch.options.env.PORT, "17371");
            assert.equal(launch.options.env.NODE_OPTIONS, process.env.NODE_OPTIONS);
        }
    } finally {
        childProcess.spawn = originalSpawn;
        Object.defineProperty(process, "platform", originalPlatform);
        if (originalOptions === undefined) delete process.env.NODE_OPTIONS;
        else process.env.NODE_OPTIONS = originalOptions;
        syncBuiltinESMExports();
    }
});
