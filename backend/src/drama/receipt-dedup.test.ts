import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
    dedupReceipt,
    resolveReceiptDedup,
    assertPublicReceipt,
    CorruptReceiptError,
    RECEIPT_DEDUP_MARKER,
} from "./receipt-dedup.js";
import { BackendDatabase } from "../db.js";
import { EpisodeProductionService, type ProductionRecord } from "./production.js";

// 构造一个 >10KB 的"大块"，保证超过阈值
function bigBlock(tag: string): Record<string, unknown> {
    return { id: tag, payload: "x".repeat(20 * 1024), meta: { n: 1 } };
}

function makeRecord(over: Partial<Record<string, unknown>> = {}): ProductionRecord {
    const base: Record<string, unknown> = {
        episodeId: "ep",
        revision: 1,
        publishedVersion: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
        draft: {
            scenes: [],
            shots: [bigBlock("shot")],
            keyframes: {},
            keyframeReviews: {},
            clipGroups: [],
            settings: {},
            legacyImports: [],
            director: bigBlock("director"),
        },
        published: {
            scenes: [],
            shots: [bigBlock("shot")],
            keyframes: {},
            keyframeReviews: {},
            clipGroups: [],
            settings: {},
            legacyImports: [],
            director: bigBlock("director"),
        },
    };
    return { ...base, ...over } as ProductionRecord;
}

test("dedupReceipt: director 和 shots 都相同时生成两条引用", () => {
    const original = makeRecord();
    const deduped = dedupReceipt(original);
    assert.ok(RECEIPT_DEDUP_MARKER in deduped);
    const marker = (deduped as Record<string, unknown>)[RECEIPT_DEDUP_MARKER] as Record<string, string>;
    assert.equal(marker["published.director"], "draft.director");
    assert.equal(marker["published.shots"], "draft.shots");
    assert.deepEqual((deduped.published as Record<string, unknown>).director, { $ref: "draft.director" });
    assert.deepEqual((deduped.published as Record<string, unknown>).shots, { $ref: "draft.shots" });
    // 入参未被污染（published.director 仍是完整对象，不是引用）
    assert.ok((original.published as Record<string, unknown>).director && typeof (original.published as Record<string, unknown>).director === "object");
    assert.notEqual((original.published as Record<string, unknown>).director, { $ref: "draft.director" });
    // draft 侧完整保留
    assert.ok((deduped.draft as Record<string, unknown>).director);
});

test("dedupReceipt: 仅 director 相同，shots 不同 → 只引用 director", () => {
    const original = makeRecord({
        published: {
            scenes: [], shots: [bigBlock("shot-different")], keyframes: {}, keyframeReviews: {},
            clipGroups: [], settings: {}, legacyImports: [], director: bigBlock("director"),
        },
    });
    const deduped = dedupReceipt(original);
    const marker = (deduped as Record<string, unknown>)[RECEIPT_DEDUP_MARKER] as Record<string, string>;
    assert.equal(marker["published.director"], "draft.director");
    assert.ok(!("published.shots" in marker));
    // shots 保持原值（不是引用）
    assert.notEqual((deduped.published as Record<string, unknown>).shots, { $ref: "draft.shots" });
});

test("dedupReceipt: published 为 null → 原样返回，无标记", () => {
    const original = makeRecord({ published: null });
    const deduped = dedupReceipt(original);
    assert.equal(deduped, original);
    assert.ok(!(RECEIPT_DEDUP_MARKER in deduped));
});

test("dedupReceipt: 都不同 → 原样返回", () => {
    const original = makeRecord({
        published: {
            scenes: [], shots: [bigBlock("shot-x")], keyframes: {}, keyframeReviews: {},
            clipGroups: [], settings: {}, legacyImports: [], director: bigBlock("director-x"),
        },
    });
    const deduped = dedupReceipt(original);
    assert.equal(deduped, original);
    assert.ok(!(RECEIPT_DEDUP_MARKER in deduped));
});

test("dedupReceipt: 小于阈值的相同字段不引用", () => {
    const small = { id: "s", payload: "tiny" };
    const original = makeRecord({
        draft: { scenes: [], shots: [], keyframes: {}, keyframeReviews: {}, clipGroups: [], settings: {}, legacyImports: [], director: small },
        published: { scenes: [], shots: [], keyframes: {}, keyframeReviews: {}, clipGroups: [], settings: {}, legacyImports: [], director: small },
    });
    const deduped = dedupReceipt(original);
    assert.equal(deduped, original);
    assert.ok(!(RECEIPT_DEDUP_MARKER in deduped));
});

test("resolveReceiptDedup: 展开后 deepEqual 原始", () => {
    const original = makeRecord();
    const deduped = dedupReceipt(original);
    const resolved = resolveReceiptDedup(deduped);
    assert.ok(!(RECEIPT_DEDUP_MARKER in resolved));
    assert.deepEqual(resolved, original);
});

test("resolveReceiptDedup: 无标记 → no-op（原样返回）", () => {
    const original = makeRecord();
    assert.equal(resolveReceiptDedup(original), original);
});

test("resolveReceiptDedup: 幂等（已展开的再展开不变）", () => {
    const original = makeRecord();
    const once = resolveReceiptDedup(dedupReceipt(original));
    const twice = resolveReceiptDedup(once);
    assert.equal(twice, once);
    assert.deepEqual(twice, original);
});

test("resolveReceiptDedup: draft 侧路径缺失 → 抛 CorruptReceiptError", () => {
    // 手工构造一个损坏的 receipt：标记说引用 draft.director，但 draft 没有 director
    const broken: Record<string, unknown> = {
        episodeId: "ep", revision: 1, publishedVersion: 1, updatedAt: "u",
        draft: { scenes: [], shots: [], keyframes: {}, keyframeReviews: {}, clipGroups: [], settings: {}, legacyImports: [] },
        published: { scenes: [], shots: [], keyframes: {}, keyframeReviews: {}, clipGroups: [], settings: {}, legacyImports: [], director: { $ref: "draft.director" } },
        [RECEIPT_DEDUP_MARKER]: { "published.director": "draft.director" },
    };
    assert.throws(() => resolveReceiptDedup(broken as ProductionRecord), CorruptReceiptError);
});

test("assertPublicReceipt: 含标记 → 抛错；无标记 → 通过", () => {
    const deduped = dedupReceipt(makeRecord());
    assert.throws(() => assertPublicReceipt(deduped));
    assert.doesNotThrow(() => assertPublicReceipt(makeRecord()));
});

test("集成：commit 幂等重放 + operationReceipt 返回完整 ProductionRecord", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "receipt-dedup-int-"));
    const file = join(dir, "production.sqlite");
    const db = new BackendDatabase(file);
    db.upsertCanvasFolder({ id: "drama", name: "测试剧目", createdAt: new Date().toISOString(), isDrama: true });
    db.createCanvasProject({ id: "canvas", title: "第一集", revision: 0, nodes: [], connections: [] });
    db.upsertDramaEpisode({ id: "episode", dramaId: "drama", episodeNumber: 1, title: "首集", synopsis: "梗概", fullPlot: "原文", canvasId: "canvas" });
    const service = new EpisodeProductionService(db, undefined, dir);
    t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

    // 写入一个 >10KB 的 shot，然后 publish，使 draft 和 published 的 shots 相同
    const bigShot = { id: "shot-big", sceneId: "scene-a", title: "big", duration: 5, visual: "v", camera: "c", openingState: "a", endingState: "b", sound: "s", assetNodeIds: [], keyframePolicy: "new" as const };
    // 先建 scene
    service.edit("episode", { operationId: "op-scene", expectedRevision: 0, ops: [{ type: "upsert_scene", scene: { id: "scene-a", heading: "内景", location: "客厅", timeOfDay: "夜", blocks: [{ id: "act", kind: "action", text: "x" }] } }] });
    // 先 publish script（shots 发布依赖 script 已发布）
    service.publish("episode", { operationId: "op-pub-script", expectedRevision: 1, stage: "script" });
    const withShot = service.edit("episode", { operationId: "op-shot", expectedRevision: 2, ops: [{ type: "upsert_shot", shot: bigShot }] });
    assert.ok(withShot.draft.shots.length === 1);
    // publish shots：published.shots 将与 draft.shots 相同
    const published = service.publish("episode", { operationId: "op-pub", expectedRevision: 3, stage: "shots" });
    assert.equal(published.replayed, false);
    // 幂等重放：返回完整对象，published.shots 已展开
    const replayed = service.publish("episode", { operationId: "op-pub", expectedRevision: 3, stage: "shots" });
    assert.equal(replayed.replayed, true);
    assert.ok(Array.isArray(replayed.published?.shots), "重放后 published.shots 应是数组（已展开）");
    assert.equal(replayed.published?.shots?.length, 1);
    // operationReceipt 返回完整对象，无标记
    const receipt = service.operationReceipt("episode", "op-pub");
    assert.ok(receipt);
    assert.ok(!(RECEIPT_DEDUP_MARKER in (receipt as Record<string, unknown>)));
    assert.ok(Array.isArray(receipt.published?.shots));
});
