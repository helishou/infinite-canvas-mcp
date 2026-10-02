import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { findCodexLaunch } from "./codex-executable.js";

const missingPackage = () => { throw Object.assign(new Error("not installed"), { code: "MODULE_NOT_FOUND" }); };
function fixture(t: TestContext) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-codex-"));
    t.after(() => {
        if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Invalid test cleanup directory");
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return directory;
}
function writePackage(directory: string) {
    fs.mkdirSync(path.join(directory, "bin"), { recursive: true });
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ version: "0.146.0" }));
    fs.writeFileSync(path.join(directory, "bin", "codex.js"), "console.log('fixture');");
    return path.join(directory, "package.json");
}

test("no Codex installation is allowed until a chat is requested", () => {
    assert.equal(findCodexLaunch("", missingPackage), undefined);
});
test("explicitly installed package launches through Node without a shell", (t) => {
    const directory = fixture(t);
    const packageFile = writePackage(directory);
    const launch = findCodexLaunch("", () => packageFile);
    assert.deepEqual(launch, { command: process.execPath, args: [path.join(directory, "bin", "codex.js")], version: "0.146.0", source: "package" });
});
test("global npm installation is found from PATH when the package is absent", (t) => {
    const directory = fixture(t);
    const packageDirectory = path.join(directory, "node_modules", "@openai", "codex");
    writePackage(packageDirectory);
    const launch = findCodexLaunch(directory, missingPackage);
    assert.equal(launch?.source, "path");
    assert.deepEqual(launch?.args, [path.join(packageDirectory, "bin", "codex.js")]);
});
test("broken installed package fails with a specific repair instruction", (t) => {
    const directory = fixture(t);
    const packageFile = path.join(directory, "package.json");
    fs.writeFileSync(packageFile, "{}");
    assert.throws(() => findCodexLaunch("", () => packageFile), /package is incomplete/);
});
