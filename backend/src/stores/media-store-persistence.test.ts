import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

test("MediaStore records content digests for buffer and stream archives", async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "media-store-digest-"));
    const previous = process.env.INFINITE_CANVAS_DATA_DIR;
    process.env.INFINITE_CANVAS_DATA_DIR = root;
    let db: import("../db.js").BackendDatabase | undefined;
    t.after(async () => {
        db?.close();
        if (previous === undefined) delete process.env.INFINITE_CANVAS_DATA_DIR;
        else process.env.INFINITE_CANVAS_DATA_DIR = previous;
        await fs.rm(root, { recursive: true, force: true });
    });
    const [{ BackendDatabase }, { createMediaStore }] = await Promise.all([import("../db.js"), import("./media-store.js")]);
    db = new BackendDatabase(path.join(root, "runtime.sqlite"));
    const media = createMediaStore(db);
    const bytes = Buffer.from("archived image bytes");
    const stored = media.store(bytes, { name: "frame.png", mimeType: "image/png" });
    assert.equal(db.getMediaFile(stored.storageKey)?.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
    const streamedBytes = Buffer.from("streamed video bytes");
    const streamed = await media.storeStream(Readable.from([streamedBytes]), { name: "clip.mp4", mimeType: "video/mp4" });
    assert.equal(db.getMediaFile(streamed.storageKey)?.sha256, crypto.createHash("sha256").update(streamedBytes).digest("hex"));
    assert.equal(streamed.sha256, db.getMediaFile(streamed.storageKey)?.sha256);
});
