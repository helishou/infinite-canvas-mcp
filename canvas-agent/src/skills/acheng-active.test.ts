import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { achengEngineIdentity, auditAchengContinuity, compileAchengDirector, getProductionContract, preflightCompilationDirector, preflightDirector, resolveAchengEngine, validateAchengSource } from "./acheng.js";
import { canonicalProduction, type DirectorProduction } from "../drama/production-contract.js";

const hash = (bytes: string | Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
function fixture(t: test.TestContext) {
    const installed = resolveAchengEngine();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "acheng-active-"));
    const base = path.join(home, "skill-runtimes", "acheng-director");
    const previousHome = process.env.CODEX_HOME;
    t.after(() => {
        if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
        fs.rmSync(home, { recursive: true, force: true });
    });
    const make = (letter: string) => {
        const commit = letter.repeat(40), patchVersion = letter.repeat(16), runtimeId = `${commit}-${patchVersion}`;
        const directory = path.join(base, "versions", runtimeId);
        fs.cpSync(installed.path, directory, { recursive: true });
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, "canvas-engine.json"), "utf8"));
        // Distinct real subprocess output proves which runtime performed each check.
        for (const [script, payload] of [
            ["canvas_source_contract.py", { diagnostics: [{ code: `ACTIVE_${letter}`, path: "source", message: `validator ${letter}`, severity: "warning" }] }],
            ["continuity_v2.py", { status: "passed", marker: letter, diagnostics: [] }],
        ] as const) {
            const relative = `scripts/${script}`;
            const original = fs.readFileSync(path.join(directory, relative), "utf8");
            const text = original.replace(/if __name__ == ["']__main__["']:[\s\S]*$/, `if __name__ == "__main__":\n    print(${JSON.stringify(JSON.stringify(payload))})\n`);
            fs.writeFileSync(path.join(directory, relative), text);
            manifest.files[relative] = hash(text);
        }
        const identity = { commit, patchVersion, runtimeId, version: `test-${letter}` };
        fs.writeFileSync(path.join(directory, "canvas-engine.json"), JSON.stringify({ ...manifest, ...identity }));
        return { ...identity, path: directory };
    };
    const old = make("a"), next = make("b");
    const activate = (runtime: typeof old) => fs.writeFileSync(path.join(base, "active.json"), JSON.stringify({ active: runtime }));
    process.env.CODEX_HOME = home; activate(next);
    const source = JSON.parse(fs.readFileSync(path.join(installed.path, "templates", "style-anchor-stage.json"), "utf8"));
    const director: DirectorProduction = { schemaVersion: 1, engine: { commit: old.commit, patchVersion: old.patchVersion, runtimeId: old.runtimeId, version: old.version },
        source, sourceHash: hash(canonicalProduction(source)), modules: {}, artifacts: [], assets: {}, shotInputs: {}, boundaries: [], workflow: {}, unresolved: [], executionAuthorized: false };
    return { home, old, next, activate, director };
}

test("old production contracts, preflight, compilation and continuity follow the active runtime", t => {
    const f = fixture(t), before = structuredClone(f.director);
    const contract = getProductionContract(f.old.runtimeId);
    assert.equal(contract.engine.runtimeId, f.next.runtimeId);
    assert.match(contract.notice!, /deprecated/);
    assert.ok(validateAchengSource(f.director, "edit").some(item => item.code === "ACTIVE_b"));
    const preflight = preflightCompilationDirector(f.director);
    assert.equal(preflight.compileReady, true, JSON.stringify(preflight.diagnostics));
    assert.equal(preflight.engine?.runtimeId, f.next.runtimeId);
    const continuity = auditAchengContinuity(f.director);
    assert.equal(continuity.marker, "b");
    assert.equal(continuity.validatorRuntimeId, f.next.runtimeId);
    const result = compileAchengDirector(f.director, path.join(f.home, "output"));
    assert.equal(result.director.engine.runtimeId, f.next.runtimeId);
    assert.ok(result.director.artifacts.length);
    assert.ok(result.director.artifacts.every(artifact => artifact.receipt.engineRuntimeId === f.next.runtimeId));
    assert.deepEqual(f.director, before);

    // A captured request remains coherent after activation changes.
    f.activate(f.old);
    const captured = compileAchengDirector(f.director, path.join(f.home, "captured"), undefined, f.next.runtimeId);
    assert.equal(captured.director.engine.runtimeId, f.next.runtimeId);
    assert.equal(preflightCompilationDirector(f.director, undefined, f.next.runtimeId).engine?.runtimeId, f.next.runtimeId);
    assert.equal(getProductionContract(f.next.runtimeId).engine.runtimeId, f.old.runtimeId);
});

test("missing and modified active runtimes diagnose failure without using a production's old runtime", t => {
    const f = fixture(t);
    fs.appendFileSync(path.join(f.next.path, "scripts", "canvas_source_contract.py"), "# tampered\n");
    assert.ok(preflightDirector(f.director).diagnostics.some(item => item.code === "ENGINE_UNAVAILABLE"));
    assert.equal(preflightCompilationDirector(f.director).compileReady, false);
    assert.throws(() => getProductionContract(f.old.runtimeId), /已改变/);
    fs.unlinkSync(path.join(f.home, "skill-runtimes", "acheng-director", "active.json"));
    assert.ok(preflightDirector(f.director).diagnostics.some(item => item.code === "ENGINE_UNAVAILABLE"));
});

test("an incompatible active source contract blocks compilation and preserves the old production", t => {
    const f = fixture(t), before = structuredClone(f.director);
    const script = path.join(f.next.path, "scripts", "canvas_source_contract.py");
    const payload = { diagnostics: [{ code: "NEW_SOURCE_FIELD_REQUIRED", path: "director.source.new_field", message: "The active contract requires an authored field", severity: "error" }] };
    const text = fs.readFileSync(script, "utf8").replace(/if __name__ == ["']__main__["']:[\s\S]*$/, `if __name__ == "__main__":\n    print(${JSON.stringify(JSON.stringify(payload))})\n`);
    fs.writeFileSync(script, text);
    const manifestFile = path.join(f.next.path, "canvas-engine.json"), manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    manifest.files["scripts/canvas_source_contract.py"] = hash(text); fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    const result = preflightCompilationDirector(f.director);
    assert.equal(result.compileReady, false);
    assert.ok(result.diagnostics.some(issue => issue.code === "NEW_SOURCE_FIELD_REQUIRED"));
    assert.equal(result.engine?.runtimeId, f.next.runtimeId);
    assert.deepEqual(f.director, before);
});

test("offline export ignores a mapping's historical engine path and records the active compiler", t => {
    const f = fixture(t);
    const source = path.join(f.home, "source.json"), mapping = path.join(f.home, "mapping.json"), output = path.join(f.home, "export");
    fs.writeFileSync(source, JSON.stringify(f.director.source));
    fs.writeFileSync(mapping, JSON.stringify({ engine: { path: path.join(f.home, "missing-historical-runtime") } }));
    const script = fileURLToPath(new URL("../../../scripts/acheng/export-canvas.mjs", import.meta.url));
    execFileSync(process.execPath, [script, source, mapping, output], { windowsHide: true, stdio: "pipe" });
    const exported = JSON.parse(fs.readFileSync(path.join(output, "director.json"), "utf8"));
    assert.deepEqual(exported.engine, achengEngineIdentity(resolveAchengEngine()));
    assert.ok(exported.artifacts.every((artifact: any) => artifact.receipt.engineRuntimeId === f.next.runtimeId));
});
