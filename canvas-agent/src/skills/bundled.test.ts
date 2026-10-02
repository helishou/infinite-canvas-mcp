import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installBundledProductionSkill } from "./bundled.js";

function fixture(context: { after: (fn: () => void) => void }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-sop-bundle-"));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspace = path.join(root, "workspace");
    const bundle = path.join(root, "bundle");
    fs.mkdirSync(workspace);
    fs.mkdirSync(bundle);
    fs.writeFileSync(path.join(bundle, "SKILL.md"), "version 1");
    return { workspace, bundle, installed: path.join(workspace, ".agents", "skills", "canvas-video-production-sop", "SKILL.md") };
}

test("bundled SOP installs and updates unchanged files", (context) => {
    const { workspace, bundle, installed } = fixture(context);
    assert.deepEqual(installBundledProductionSkill(workspace, bundle), []);
    assert.equal(fs.readFileSync(installed, "utf8"), "version 1");
    fs.writeFileSync(path.join(bundle, "SKILL.md"), "version 2");
    assert.deepEqual(installBundledProductionSkill(workspace, bundle), []);
    assert.equal(fs.readFileSync(installed, "utf8"), "version 2");
});

test("bundled SOP preserves local edits and reports the conflict", (context) => {
    const { workspace, bundle, installed } = fixture(context);
    installBundledProductionSkill(workspace, bundle);
    fs.writeFileSync(installed, "user edition");
    fs.writeFileSync(path.join(bundle, "SKILL.md"), "version 2");
    assert.match(installBundledProductionSkill(workspace, bundle).join(" "), /本地修改/);
    assert.equal(fs.readFileSync(installed, "utf8"), "user edition");
});

test("bundled SOP leaves an existing unmanaged skill alone", (context) => {
    const { workspace, bundle, installed } = fixture(context);
    fs.mkdirSync(path.dirname(installed), { recursive: true });
    fs.writeFileSync(installed, "existing skill");
    assert.match(installBundledProductionSkill(workspace, bundle).join(" "), /已有/);
    assert.equal(fs.readFileSync(installed, "utf8"), "existing skill");
});
