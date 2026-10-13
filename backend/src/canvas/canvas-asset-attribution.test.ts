import assert from "node:assert/strict";
import test from "node:test";
import { BackendDatabase, type Asset } from "../db.js";
import { attributableAssetsForCanvas, attributeCanvasAssetsToDrama } from "./canvas-asset-attribution.js";
import { sourceOf } from "./drama-asset-library.js";

// 现场：先建画布做素材、之后才建剧目并把画布绑成分集，资产写入时拿不到 dramaId。
function fixture() {
    const db = new BackendDatabase(":memory:");
    const now = new Date().toISOString();
    for (const [drama, canvas] of [["drama-a", "a"], ["drama-b", "b"]] as const) {
        db.upsertCanvasFolder({ id: drama, name: drama, isDrama: true, createdAt: now });
        db.createCanvasProject({
            id: canvas,
            nodes: [
                { id: "node", type: "audio", title: "音频", position: { x: 0, y: 0 }, width: 240, height: 120, metadata: { storageKey: canvas === "a" ? "audio:only-a" : "audio:shared" } },
                ...(canvas === "a" ? [{ id: "shared-node", type: "audio", title: "共用音频", position: { x: 0, y: 200 }, width: 240, height: 120, metadata: { storageKey: "audio:shared" } }] : []),
            ],
            connections: [],
        });
        db.upsertDramaEpisode({ id: `episode-${canvas}`, dramaId: drama, episodeNumber: 1, title: canvas, synopsis: "", fullPlot: "", canvasId: canvas, createdAt: now, updatedAt: now });
    }
    // 画布 b 同时引用 audio:shared，制造真实冲突。
    db.createCanvasProject({
        id: "b2",
        nodes: [{ id: "node", type: "audio", title: "音频", position: { x: 0, y: 0 }, width: 240, height: 120, metadata: { storageKey: "audio:shared" } }],
        connections: [],
    });
    db.upsertDramaEpisode({ id: "episode-b2", dramaId: "drama-b", episodeNumber: 2, title: "b2", synopsis: "", fullPlot: "", canvasId: "b2", createdAt: now, updatedAt: now });
    db.createCanvasProject({ id: "plain", nodes: [{ id: "node", type: "audio", title: "音频", position: { x: 0, y: 0 }, width: 240, height: 120, metadata: { storageKey: "audio:plain" } }], connections: [] });

    const audio = (id: string, storageKey: string, metadata: Record<string, unknown> = {}, dramaId: string | null = null): Asset => ({
        id, kind: "audio", title: id, coverUrl: "", tags: [], folderId: null, dramaId, note: null, source: "Canvas", metadata,
        data: { url: `/media/${storageKey}`, storageKey, bytes: 1, mimeType: "audio/wav", durationMs: 1000 }, createdAt: now, updatedAt: now,
    } as Asset);

    db.upsertAssetRecord(audio("saved-from-a", "audio:saved-from-a", { source: "canvas", projectId: "a", nodeId: "node" }));
    db.upsertAssetRecord(audio("used-on-a", "audio:only-a"));
    db.upsertAssetRecord(audio("shared-key", "audio:shared"));
    db.upsertAssetRecord(audio("plain-key", "audio:plain"));
    db.upsertAssetRecord(audio("no-signal", "audio:nothing"));
    db.upsertAssetRecord(audio("already-owned", "audio:owned", {}, "drama-b"));
    db.upsertAssetRecord(audio("shared-source", "audio:only-a", { sharedAssetSource: { dramaId: "drama-a", assetId: "shared-source", sourceProjectId: "a", sourceNodeId: "library" } }));
    return db;
}

test("先建画布后建剧目时，按画布与剧目的既有关系补齐唯一可判定的归属", () => {
    const db = fixture();
    try {
        const attributable = attributableAssetsForCanvas(db, "a", "drama-a").map((asset) => asset.id).sort();
        assert.deepEqual(attributable, ["saved-from-a", "used-on-a"]);
        const attributed = attributeCanvasAssetsToDrama(db, "a", "drama-a").map((asset) => asset.id).sort();
        assert.deepEqual(attributed, ["saved-from-a", "used-on-a"]);
        assert.equal(db.getAssetRecord("used-on-a")!.dramaId, "drama-a");
        assert.equal(db.listAssets({ dramaId: "drama-a" }).length, 2);
        // 归属走正式写入路径：资产被提升进该剧目的共享资产库（与「归属剧目」按钮同一语义）。
        assert.ok(sourceOf(db.getAssetRecord("used-on-a")!), "归属后应带上共享资产来源");
        assert.ok(sourceOf(db.getAssetRecord("saved-from-a")!), "归属后应带上共享资产来源");
        // 幂等：再绑一次不会重复改写。
        assert.deepEqual(attributeCanvasAssetsToDrama(db, "a", "drama-a"), []);
    } finally { db.close(); }
});

test("冲突与无信号一律不猜：跨剧目引用、已归属、共享来源、纯画布引用都保持未归属", () => {
    const db = fixture();
    try {
        attributeCanvasAssetsToDrama(db, "a", "drama-a");
        attributeCanvasAssetsToDrama(db, "b", "drama-b");
        assert.equal(db.getAssetRecord("shared-key")!.dramaId, null);
        assert.equal(db.getAssetRecord("no-signal")!.dramaId, null);
        assert.equal(db.getAssetRecord("plain-key")!.dramaId, null);
        assert.equal(db.getAssetRecord("shared-source")!.dramaId, null);
        assert.equal(db.getAssetRecord("already-owned")!.dramaId, "drama-b");
    } finally { db.close(); }
});

test("画布与剧目不匹配时不改写任何资产", () => {
    const db = fixture();
    try {
        assert.deepEqual(attributableAssetsForCanvas(db, "a", "drama-b"), []);
        assert.deepEqual(attributableAssetsForCanvas(db, "missing", "drama-a"), []);
        assert.deepEqual(attributeCanvasAssetsToDrama(db, "a", "drama-b"), []);
        assert.equal(db.getAssetRecord("saved-from-a")!.dramaId, null);
    } finally { db.close(); }
});
