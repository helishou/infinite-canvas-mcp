import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { bundledSkillWarnings, installBundledProductionSkill, installPinnedAchengSkill, syncBundledProductionSkills } from "./bundled.js";

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

function achengFixture(context: { after: (fn: () => void) => void }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-acheng-skill-"));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspace = path.join(root, "workspace");
    const runtime = path.join(root, "runtime");
    fs.mkdirSync(workspace);
    fs.mkdirSync(path.join(runtime, "modules", "story"), { recursive: true });
    fs.mkdirSync(path.join(runtime, "output"), { recursive: true });
    fs.mkdirSync(path.join(runtime, ".git"), { recursive: true });
    fs.writeFileSync(path.join(runtime, "SKILL.md"), "version 1");
    fs.writeFileSync(path.join(runtime, "modules", "story", "SKILL.md"), "story module");
    fs.writeFileSync(path.join(runtime, "output", "production.json"), "private generated output");
    fs.writeFileSync(path.join(runtime, ".git", "config"), "git metadata");
    return { workspace, runtime, installed: path.join(workspace, ".agents", "skills", "acheng-director", "SKILL.md") };
}

test("pinned Acheng runtime installs as a project Skill without generated output or repository metadata", (context) => {
    const { workspace, runtime, installed } = achengFixture(context);
    assert.deepEqual(installPinnedAchengSkill(workspace, runtime), []);
    assert.equal(fs.readFileSync(installed, "utf8"), "version 1");
    assert.equal(fs.readFileSync(path.join(path.dirname(installed), "modules", "story", "SKILL.md"), "utf8"), "story module");
    assert.equal(fs.existsSync(path.join(path.dirname(installed), "output")), false);
    assert.equal(fs.existsSync(path.join(path.dirname(installed), ".git")), false);
});

test("pinned Acheng Skill follows an engine update but preserves local edits", (context) => {
    const { workspace, runtime, installed } = achengFixture(context);
    assert.deepEqual(installPinnedAchengSkill(workspace, runtime), []);
    fs.writeFileSync(path.join(runtime, "SKILL.md"), "version 2");
    assert.deepEqual(installPinnedAchengSkill(workspace, runtime), []);
    assert.equal(fs.readFileSync(installed, "utf8"), "version 2");
    fs.writeFileSync(installed, "user edit");
    fs.writeFileSync(path.join(runtime, "SKILL.md"), "version 3");
    assert.match(installPinnedAchengSkill(workspace, runtime).join(" "), /本地修改/);
    assert.equal(fs.readFileSync(installed, "utf8"), "user edit");
});

test("pinned Acheng Skill preserves an existing unmanaged project Skill", (context) => {
    const { workspace, runtime, installed } = achengFixture(context);
    fs.mkdirSync(path.dirname(installed), { recursive: true });
    fs.writeFileSync(installed, "user-owned project skill");
    assert.match(installPinnedAchengSkill(workspace, runtime).join(" "), /已有 Acheng Director/);
    assert.equal(fs.readFileSync(installed, "utf8"), "user-owned project skill");
});

test("site workspace receives both the project Acheng entry and Canvas adapter", (context) => {
    const adapter = fixture(context);
    const acheng = achengFixture(context);
    syncBundledProductionSkills(acheng.workspace, adapter.bundle, acheng.runtime);
    assert.equal(fs.readFileSync(acheng.installed, "utf8"), "version 1");
    assert.equal(fs.readFileSync(path.join(acheng.workspace, ".agents", "skills", "canvas-video-production-sop", "SKILL.md"), "utf8"), "version 1");
    assert.deepEqual(bundledSkillWarnings(acheng.workspace), []);
});
