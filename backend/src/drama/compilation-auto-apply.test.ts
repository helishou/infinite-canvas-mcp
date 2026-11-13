import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { BackendDatabase } from "../db.js";
import { EpisodeProductionService } from "./production.js";
import { ProductionCompilationService } from "./compilation.js";
import { directorHash, promptHash } from "./director.js";
import type { DirectorProduction } from "@basketikun/canvas-agent/drama/production-contract";

const source = {
    version: 2, prompt_assembly: { version: 2 }, brief: "auto apply fixture", fps_num: 24, fps_den: 1,
    subject_registry: [], character_registry: [], scene_registry: [], shots: [], segments: [], utterances: [],
    asset_plan: [], asset_cards: [{ id: "STYLE", prompt: "The authored image prompt" }],
    ledger: { contract_version: 2, facts: [], timelines: [], initial: [], events: [], requirements: [], coverage: [] },
};

function fixture(t: test.TestContext, compile: (input: DirectorProduction, prompt: string) => any) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "compilation-auto-apply-"));
    const db = new BackendDatabase(path.join(root, "test.sqlite"));
    db.upsertCanvasFolder({ id: "drama", name: "Drama", isDrama: true, createdAt: new Date().toISOString() });
    db.createCanvasProject({ id: "canvas", title: "Canvas", nodes: [], connections: [] });
    db.upsertDramaEpisode({ id: "episode", dramaId: "drama", episodeNumber: 1, title: "Episode", synopsis: "", fullPlot: "", canvasId: "canvas" });
    const service = new EpisodeProductionService(db, undefined, root, false, () => {});
    const director: DirectorProduction = {
        schemaVersion: 1, engine: { commit: "a".repeat(40), patchVersion: "fixture", runtimeId: "fixture", version: "fixture" },
        source: source as any, sourceHash: directorHash(source), modules: {}, artifacts: [], assets: {},
        shotInputs: {}, boundaries: [], executionAuthorized: false, unresolved: [], workflow: {},
    };
    service.edit("episode", { operationId: "seed", expectedRevision: 0, ops: [{ type: "set_director_production", director }] });
    const prompt = "The authored image prompt";
    const jobs = new ProductionCompilationService(service, root, ((input: DirectorProduction) => compile(input, prompt)) as any);
    t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
    return { root, db, service, jobs, prompt };
}

const readyArtifact = (input: DirectorProduction, prompt: string, targetId = "STYLE") => ({
    id: `image-${targetId}`, targetId, kind: "image" as const, prompt,
    sha256: promptHash(prompt), sourceHash: input.sourceHash, status: "ready" as const, references: [],
    receipt: { sourceHash: input.sourceHash, promptHash: promptHash(prompt), engineRuntimeId: input.engine.runtimeId, validator: "fixture" },
});

async function settled(jobs: ProductionCompilationService, operationId: string) {
    for (let attempt = 0; attempt < 400; attempt++) {
        await new Promise<void>(resolve => setTimeout(resolve, 1));
        const status = jobs.getCompilation("episode", "episode", operationId) as any;
        if (!["queued", "running"].includes(status.status)) return status;
    }
    throw new Error(`compilation did not settle: ${operationId}`);
}

test("apply 默认关闭：回执不出现 applyStatus，行为与改动前一致", async t => {
    const { jobs, prompt } = fixture(t, (input, text) => ({
        director: { ...input, artifacts: [readyArtifact(input, text)] }, exitCode: 0, diagnostics: [], audit: {}, sourceAdjustments: [], acceptance: {},
    }));
    jobs.enqueue("episode", "episode", "no-apply", 1);
    const receipt = await settled(jobs, "no-apply");
    assert.equal(receipt.status, "succeeded");
    assert.ok(receipt.preparedId);
    assert.equal("applyStatus" in receipt, false, "未要求 apply 时不得出现 applyStatus");
    assert.equal(receipt.application, undefined);
    assert.equal(receipt.nextAction.tool, "production_apply_compilation");
});

test("apply:true：编译成功后由作业直接应用，回执带 applyStatus=applied", async t => {
    const { jobs, service } = fixture(t, (input, text) => ({
        director: { ...input, artifacts: [readyArtifact(input, text)] }, exitCode: 0, diagnostics: [], audit: {}, sourceAdjustments: [], acceptance: {},
    }));
    const before = service.get("episode").revision;
    jobs.enqueue("episode", "episode", "auto-apply", 1, undefined, undefined, true);
    const receipt = await settled(jobs, "auto-apply");
    assert.equal(receipt.status, "succeeded");
    assert.equal(receipt.applyStatus, "applied");
    assert.ok(receipt.application, "应用回执必须随编译回执一起返回");
    assert.ok(service.get("episode").revision >= before, "应用会推进 revision");
    assert.equal(receipt.nextAction.action, "read_run");
});

test("apply:true 但编译 blocked：不进入应用，回执不出现 applyStatus", async t => {
    const { jobs } = fixture(t, (input) => ({
        director: input, exitCode: 2,
        diagnostics: [{ code: "PROMPT_EXTERNAL_CONTEXT", path: "x", targetId: "STYLE", origin: "source" as const,
            matchedText: "preceding segment", blocksCompilation: true, message: "external", severity: "error" as const }],
        audit: {}, sourceAdjustments: [], acceptance: {},
    }));
    jobs.enqueue("episode", "episode", "blocked-apply", 1, undefined, undefined, true);
    const receipt = await settled(jobs, "blocked-apply");
    assert.equal(receipt.status, "blocked");
    assert.equal("applyStatus" in receipt, false);
    assert.equal(receipt.application, undefined);
});

test("同一 operationId 重放：不重复应用，返回同一份应用回执", async t => {
    let applied = 0;
    const { jobs } = fixture(t, (input, text) => ({
        director: { ...input, artifacts: [readyArtifact(input, text)] }, exitCode: 0, diagnostics: [], audit: {}, sourceAdjustments: [], acceptance: {},
    }));
    const original = jobs.apply.bind(jobs);
    (jobs as any).apply = async (...args: any[]) => { applied++; return original(...(args as [string, string, string])); };
    jobs.enqueue("episode", "episode", "replay-apply", 1, undefined, undefined, true);
    const first = await settled(jobs, "replay-apply");
    assert.equal(first.applyStatus, "applied");
    const replay = jobs.enqueue("episode", "episode", "replay-apply", 1, undefined, undefined, true) as any;
    assert.equal(replay.replayed, true);
    assert.equal(replay.applyStatus, "applied");
    assert.equal(applied, 1, "重放不得再次应用同一个 preparedId");
});

test("应用抛错：编译状态保持 succeeded，applyStatus=failed 并带可读错误", async t => {
    const { jobs } = fixture(t, (input, text) => ({
        director: { ...input, artifacts: [readyArtifact(input, text)] }, exitCode: 0, diagnostics: [], audit: {}, sourceAdjustments: [], acceptance: {},
    }));
    (jobs as any).apply = async () => { throw Object.assign(new Error("projection mismatch"), { code: "PROJECTION_MISMATCH" }); };
    jobs.enqueue("episode", "episode", "apply-fails", 1, undefined, undefined, true);
    const receipt: any = await settled(jobs, "apply-fails");
    assert.equal(receipt.status, "succeeded", "应用失败不得回退编译结论");
    assert.equal(receipt.applyStatus, "failed");
    assert.equal(receipt.application.code, "PROJECTION_MISMATCH");
    assert.match(receipt.application.message, /projection mismatch/);
    assert.equal(receipt.nextAction.action, "correct_source");
});

test("apply:true 的可应用回执仍保留 preparedId，便于排障核对", async t => {
    const { jobs } = fixture(t, (input, text) => ({
        director: { ...input, artifacts: [readyArtifact(input, text)] }, exitCode: 0, diagnostics: [], audit: {}, sourceAdjustments: [], acceptance: {},
    }));
    jobs.enqueue("episode", "episode", "keep-prepared", 1, undefined, undefined, true);
    const receipt = await settled(jobs, "keep-prepared");
    assert.match(String(receipt.preparedId), /^[a-f0-9-]{36}$/i);
});
