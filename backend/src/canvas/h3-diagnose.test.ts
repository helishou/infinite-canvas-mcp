import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { BackendDatabase } from "../db.js";
import { createStores } from "../stores/index.js";
import { diagnoseH3Clips } from "./h3-diagnose.js";
import { h3PromptContent } from "./h3-params.js";

const hash = (prompt: string) => createHash("sha256").update(h3PromptContent(prompt)).digest("hex");

function fixture(t: test.TestContext, prompts: Record<string, string>) {
    const db = new BackendDatabase(":memory:");
    t.after(() => db.close());
    const stores = createStores(db);
    stores.projects.create({
        id: "p",
        nodes: [{
            id: "n", type: "minimax-h3",
            metadata: {
                segments: Object.entries(prompts).map(([id, prompt]) => ({ id, prompt, directorEngine: "acheng", directorSourceHash: "s1" })),
            },
        }],
        connections: [],
    });
    return { db, stores };
}

function requirements(clips: Array<{ segmentId: string; promptContentHash?: string; sourceHash?: string }>, version = 7, revision = 3) {
    return {
        ownerId: "ep", revision, version,
        clips: clips.map(clip => ({
            nodeId: "n", segmentId: clip.segmentId, sourceHash: clip.sourceHash ?? "s1", promptContentHash: clip.promptContentHash,
            storyboardRequired: false, shots: [], literalDialogues: [],
        })),
    };
}

test("identical text is a match, including after reference renumbering", t => {
    const { stores } = fixture(t, { a: "正文<Picture 1>与<Picture 2>。", b: "正文<Picture 1>与<Picture 2>。" });
    stores.projects.getH3ProductionRequirements = () => requirements([
        { segmentId: "a", promptContentHash: hash("正文<Picture 1>与<Picture 2>。") },
        { segmentId: "b", promptContentHash: hash("正文<Picture 3>与<Picture 9>。") },
    ]) as never;
    const result = diagnoseH3Clips(stores, { projectId: "p" });
    assert.equal(result.total, 2);
    assert.equal(result.counts.match, 2);
    assert.equal(result.counts.missingLive, 0);
    assert.equal(result.rows.every(row => row.code === "CLIP_MATCHES_PUBLISHED"), true);
});

test("edited text is informational difference, not an execution blocker", t => {
    const { stores } = fixture(t, { a: "现场手改的正文。" });
    stores.projects.getH3ProductionRequirements = () => requirements([{ segmentId: "a", promptContentHash: hash("发布稿的正文。") }]) as never;
    const row = diagnoseH3Clips(stores, { projectId: "p" }).rows[0];
    assert.equal(row.promptState, "different");
    assert.equal(row.code, "CLIP_TEXT_DIFFERS_FROM_PUBLISHED");
    assert.equal(row.severity, "info");
    assert.match(row.next, /重新编译发布/);
});

test("missing published artifact is unavailable with a reason, never a false mismatch", t => {
    const { stores } = fixture(t, { a: "现场正文。" });
    stores.projects.getH3ProductionRequirements = () => requirements([{ segmentId: "a" }]) as never;
    const row = diagnoseH3Clips(stores, { projectId: "p" }).rows[0];
    assert.equal(row.promptState, "unavailable");
    assert.equal(row.code, "CLIP_TEXT_NOT_COMPARABLE");
    assert.match(row.reason, /发布稿缺/);
});

test("published target missing from the canvas still appears and counts", t => {
    const { stores } = fixture(t, { a: "正文。" });
    stores.projects.getH3ProductionRequirements = () => requirements([
        { segmentId: "a", promptContentHash: hash("正文。") }, { segmentId: "gone", promptContentHash: "x".repeat(64) },
    ]) as never;
    const result = diagnoseH3Clips(stores, { projectId: "p" });
    assert.equal(result.total, 2);
    assert.equal(result.counts.missingLive, 1);
    assert.equal(result.rows.find(row => row.segmentId === "gone")?.code, "CLIP_MISSING_ON_CANVAS");
});

test("no production record reports unavailable instead of crashing", t => {
    const { stores } = fixture(t, { a: "正文。" });
    stores.projects.getH3ProductionRequirements = () => null as never;
    const result = diagnoseH3Clips(stores, { projectId: "p" });
    assert.equal(result.publishedVersion, null);
    assert.equal(result.ownerId, null);
    assert.equal(result.rows[0].promptState, "unavailable");
    assert.equal(result.rows[0].code, "CLIP_TEXT_NOT_COMPARABLE");
});

test("nodeIds filters and pagination separates total from the page", t => {
    const { stores } = fixture(t, { a: "A。", b: "B。" });
    stores.projects.getH3ProductionRequirements = () => requirements([{ segmentId: "a", promptContentHash: hash("A。") }]) as never;
    assert.equal(diagnoseH3Clips(stores, { projectId: "p", nodeIds: ["n"] }).total, 2);
    assert.equal(diagnoseH3Clips(stores, { projectId: "p", nodeIds: ["other"] }).total, 0);
    const paged = diagnoseH3Clips(stores, { projectId: "p", pageSize: 1 });
    assert.equal(paged.total, 2);
    assert.equal(paged.rows.length, 1);
    assert.equal(paged.rows[0].segmentId, "a");
    assert.equal(paged.truncated, true);
    assert.equal(paged.nextOffset, 1);
    const second = diagnoseH3Clips(stores, { projectId: "p", pageSize: 1, offset: 1 });
    assert.equal(second.rows[0].segmentId, "b");
    assert.equal(second.truncated, false);
    assert.equal(second.nextOffset, undefined);
});

test("diagnosis is read-only: project revision and task list are unchanged", t => {
    const { stores } = fixture(t, { a: "正文。" });
    stores.projects.getH3ProductionRequirements = () => requirements([{ segmentId: "a", promptContentHash: hash("正文。") }]) as never;
    const beforeProject = JSON.stringify(stores.projects.get("p"));
    const beforeTasks = JSON.stringify(stores.tasks.list());
    diagnoseH3Clips(stores, { projectId: "p" });
    assert.equal(JSON.stringify(stores.projects.get("p")), beforeProject);
    assert.equal(JSON.stringify(stores.tasks.list()), beforeTasks);
});

test("an unknown project fails loudly instead of returning an empty diagnosis", t => {
    const { stores } = fixture(t, { a: "正文。" });
    assert.throws(() => diagnoseH3Clips(stores, { projectId: "missing" }), /画布不存在/);
});
