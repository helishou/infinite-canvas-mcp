import assert from "node:assert/strict";
import test from "node:test";

import { BackendDatabase } from "../db.js";

test("旧 Ref2VA 日志按已登记媒体恢复尾帧预览，不改写原始记录", () => {
    const db = new BackendDatabase(":memory:");
    try {
        db.createCanvasProject({ id: "project", nodes: [], connections: [] });
        db.upsertMediaFile({
            storageKey: "image:tail", filePath: "C:\\runtime-media\\input\\tail.png", mimeType: "image/png",
            bytes: 32, width: null, height: null, durationMs: null, createdAt: new Date().toISOString(),
        });
        const tail = { id: "runtime-tail-S03", name: "Clip 2 尾帧", type: "image", usage: "first_frame", runtime: true, resolved: "C:\\runtime-media\\input\\tail.png" };
        const missing = { id: "runtime-tail-S04", name: "已丢失尾帧", type: "image", usage: "first_frame", runtime: true, resolved: "C:\\runtime-media\\input\\missing.png" };
        const log = db.createGenerationLog({
            projectId: "project", status: "success", platform: "comfyui", workflow: "MiniMax H3", taskMode: "ref2va",
            references: [tail, { id: "own", storageKey: "image:own" }, missing], inputCounts: { image: 3 },
            startedAt: new Date().toISOString(), durationMs: 1, outputs: [], params: {},
        });
        const read = db.listGenerationLogs({ projectId: "project" })[0];
        assert.equal(read.id, log.id);
        assert.equal(read.references[0].storageKey, "image:tail");
        assert.equal(read.references[0].mimeType, "image/png");
        assert.equal(read.references[1].storageKey, "image:own");
        assert.equal(read.references[2].storageKey, undefined);
        assert.equal(db.getGenerationLog(log.id)?.references[0].storageKey, undefined);
    } finally {
        db.close();
    }
});
