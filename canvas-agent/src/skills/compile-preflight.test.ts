import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import test from "node:test";
import { preflightCompilationDirector, resolveAchengEngine } from "./acheng.js";
import { canonicalProduction, type DirectorProduction } from "../drama/production-contract.js";

function director(source: Record<string, any>): DirectorProduction {
    const { commit, patchVersion, runtimeId, version } = resolveAchengEngine();
    return { schemaVersion: 1, engine: { commit, patchVersion, runtimeId, version }, source,
        sourceHash: crypto.createHash("sha256").update(canonicalProduction(source)).digest("hex"), modules: {}, artifacts: [], assets: {}, shotInputs: {}, boundaries: [], workflow: {}, unresolved: [], executionAuthorized: false };
}
const styleSource = () => JSON.parse(fs.readFileSync(path.join(resolveAchengEngine().path, "templates", "style-anchor-stage.json"), "utf8"));

test("scoped approval hydrates style lock from verified media without rewriting source", t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "style-approval-preflight-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, "style.png");
    fs.writeFileSync(file, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTuoAAAAASUVORK5CYII=", "base64"));
    const source = styleSource();
    source._canvas_compilation_scope = { targetIds: ["STYLE_MOTHER"] };
    const input = director(source);
    input.assets.STYLE_MOTHER = { status: "approved", version: source.style_lock.anchor_version,
        sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") };
    const before = structuredClone(input);
    const result = preflightCompilationDirector(input, (id, label) => id === "STYLE_MOTHER" && label === "asset" ? file : undefined);
    assert.equal(result.compileReady, true, JSON.stringify(result.diagnostics));
    assert.deepEqual(input, before);
    fs.writeFileSync(file, "changed");
    assert.throws(() => preflightCompilationDirector(input, () => file), /字节已变化/);
});

test("purpose and reference policy examples repair the same pinned source without changing it", () => {
    for (const field of ["purpose", "reference_policy"] as const) {
        const source = styleSource();
        if (field === "purpose") delete source.asset_plan[0].purpose;
        else delete source.asset_cards[0].reference_policy;
        const input = director(source), before = structuredClone(input);
        const result = preflightCompilationDirector(input);
        const issue = result.diagnostics.find(item => field === "purpose" ? item.path.endsWith(".purpose") : item.message.includes("reference_policy must explicitly")) as any;
        assert.ok(issue?.example, JSON.stringify(result.diagnostics));
        assert.deepEqual(input, before);
        const repaired = structuredClone(source);
        Object.assign(field === "purpose" ? repaired.asset_plan[0] : repaired.asset_cards[0], issue.example);
        assert.equal(preflightCompilationDirector(director(repaired)).compileReady, true);
    }
});

test("story-only source is diagnosed as not yet compilable without launching a compiler", () => {
    const result = preflightCompilationDirector(director({ brief: "A story still being written", script_scenes: [], asset_cards: [] }));
    assert.equal(result.compileReady, false);
    assert.ok(result.diagnostics.some(item => item.code === "COMPILE_STAGE_NOT_READY"));
});

test("reference description examples retain declared asset identity, version and upload order", () => {
    const source = styleSource();
    source.asset_plan.push({ id: "ROOM", kind: "scene", version: "v1.0", purpose: "Lock the documented room geometry.", status: "planned", depends_on: ["STYLE_MOTHER"] });
    source.asset_cards.push({ ...structuredClone(source.asset_cards[0]), id: "ROOM", asset_kind: "scene", recipe: "dark", reference_policy: "required",
        references: [{ image: 1, asset_id: "STYLE_MOTHER", asset_version: source.asset_plan[0].version, role: "style", subject: "approved rendering medium", preserve: "palette and material response", exclude: "identity and composition" }] });
    for (const field of ["subject", "preserve", "exclude"]) {
        const broken = structuredClone(source); delete broken.asset_cards[1].references[0][field];
        const input = director(broken), before = structuredClone(input), result = preflightCompilationDirector(input);
        const issue = result.diagnostics.find(item => item.message === "reference image 1: " + field + " description required") as any;
        assert.ok(issue?.example);
        assert.deepEqual(input, before);
        Object.assign(broken.asset_cards[1], issue.example);
        const ref = broken.asset_cards[1].references[0];
        assert.equal(ref.asset_id, "STYLE_MOTHER"); assert.equal(ref.asset_version, source.asset_plan[0].version); assert.equal(ref.image, 1);
        assert.equal(preflightCompilationDirector(director(broken)).compileReady, true);
    }
});

test("pinned asset validators collect plan fields and style binding defects together", () => {
    const source = styleSource();
    source.asset_plan.push({ id: "ROOM", kind: "scene", version: "v1.0", purpose: "The same rural room used across the film", status: "planned", depends_on: ["STYLE_MOTHER"] });
    source.asset_cards.push({ ...structuredClone(source.asset_cards[0]), id: "ROOM", asset_kind: "scene", references: [] });
    delete source.asset_plan[0].kind; delete source.asset_plan[0].version; delete source.asset_plan[0].purpose;
    const input = director(source), before = structuredClone(input);
    const result = preflightCompilationDirector(input);
    const paths = result.diagnostics.map(item => item.path);
    for (const field of ["kind", "version", "purpose"]) assert.ok(paths.includes(`director.source.asset_plan.0.${field}`), JSON.stringify(result.diagnostics));
    assert.ok(result.diagnostics.some(item => item.code === "STYLE_REFERENCE_MISSING" && item.targetId === "ROOM"));
    assert.equal(result.compileReady, false);
    assert.deepEqual(input, before);
});

test("planned style mother remains compilable without falsely requiring generated media", () => {
    const input = director(styleSource()), before = structuredClone(input);
    const result = preflightCompilationDirector(input);
    assert.equal(result.compileReady, true, JSON.stringify(result.diagnostics));
    assert.deepEqual(input, before);
});

test("compilation can rebuild stale receipts and retain an unfinished video draft", () => {
    const source = styleSource();
    const input = director(source);
    input.artifacts = [{ id: "old", kind: "image", targetId: "STYLE_MOTHER", prompt: "Old prompt to replace", sha256: "0".repeat(64), sourceHash: "1".repeat(64), status: "ready", references: [], receipt: { sourceHash: "1".repeat(64), promptHash: "0".repeat(64), engineRuntimeId: "old", validator: "old" } }];
    assert.equal(preflightCompilationDirector(input).compileReady, true, "previous output receipts must not block recompiling authored source");
    source.fps_num = 24; source.fps_den = 1;
    source.segments = [{ id: "SEG001", mode: "T2VA", mode_lock: "T2VA", mode_selection_reason: "This establishing scene has no image-reference requirement.", generation_clip_duration: 4, start_frame: 0, end_frame: 96, shot_ids: [], summary: "A planned establishing view of the rural house.", references: [] }];
    const draft = preflightCompilationDirector(director(source));
    assert.equal(draft.compileReady, true, JSON.stringify(draft.diagnostics));
    assert.ok(draft.diagnostics.some(item => item.code === "COMPILE_VIDEO_DRAFT" && item.severity === "warning"));
});
